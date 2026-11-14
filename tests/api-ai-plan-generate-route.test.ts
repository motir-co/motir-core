import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';
import { planRepository } from '@/lib/repositories/planRepository';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { makeWorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Route-level transport tests for the generation API (Subtask 7.4.4 · MOTIR-846):
//   - POST /api/ai/plan/generate              — opens a Plan + submits generate_tree,
//   - GET  /api/ai/plan/generate/:jobId/stream — relays the job SSE to the browser.
//
// The COMPANION integration test (`tests/integration/ai/generationProposals.test.ts`)
// proves the internal append seam end-to-end. This file proves what the ROUTES own:
// the session/active-project gates, the {jobId, planId} success shape + the opened
// `generating` Plan (read back from a REAL Postgres), out-of-credits as a DISTINCT
// 402 (7.2 metering), the generic-failure 502, and the SSE wire framing/priming.
//
// Per the motir-core convention we mock ONLY the boundary client + the two context
// resolvers the test env can't supply with no cookies (getSession, getActiveProject)
// — the same exception api-ai-chat-route.test.ts takes. Everything else runs for
// real: createPlan persists to Postgres, resolveTenantOrg reads the seeded org.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

// MOTIR-3653 / MOTIR-3648 — every route and route group now resolves the 2FA
// hold first. This suite is about this route's own gates, so the policy answers
// "nobody is asking", which is the state each case below was written in.
vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('./helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const streamJobMock = vi.fn<(jobId: string) => AsyncGenerator<JobStreamEvent>>();
const submitJobMock = vi.fn();
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  streamJob: (jobId: string) => streamJobMock(jobId),
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (jobId: string) => getJobMock(jobId),
}));
// …and the project gate (MOTIR-2358). These cases drive a SYNTHETIC ProjectContext
// with no rows behind it, so the real assert would 404 on the project id and
// prove nothing about the boundary contract they are here for. The gate is
// covered against real Postgres in `tests/integration/ai/planPermissionGate.test.ts`.
vi.mock('@/lib/services/projectAccessService', () => ({
  // `assertCanBrowse` joined the mock with Story MOTIR-2732 · MOTIR-3044: this
  // route now resolves the PROJECT's repository set into the job envelope
  // (`context.repositories`), and that read is browse-gated like every other
  // project read. A mock that stubs only the two methods the route USED to reach
  // does not fail as "unauthorized" — it fails as `assertCanBrowse is not a
  // function`, which reads as a broken route rather than an incomplete double.
  projectAccessService: {
    assertPermission: vi.fn(),
    assertCanBrowse: vi.fn(),
    assertCanEdit: vi.fn(),
  },
}));

const { GET } = await import('@/app/api/ai/plan/generate/[jobId]/stream/route');
const { POST } = await import('@/app/api/ai/plan/generate/route');
const { MotirAiOutOfCreditsError, MotirAiUnavailableError, MotirAiJobNotFoundError } =
  await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';

function sse(frames: JobStreamEvent[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

function scriptedStream(
  steps: Array<{ type: 'yield'; value: JobStreamEvent } | { type: 'throw'; error: Error }>,
) {
  let i = 0;
  const returnSpy = vi.fn(
    async (): Promise<IteratorResult<JobStreamEvent>> => ({ done: true, value: undefined }),
  );
  const nextSpy = vi.fn(async (): Promise<IteratorResult<JobStreamEvent>> => {
    const step = steps[i++];
    if (!step) return { done: true, value: undefined };
    if (step.type === 'throw') throw step.error;
    return { done: false, value: step.value };
  });
  const iterator = {
    next: nextSpy,
    return: returnSpy,
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { generator: iterator as unknown as AsyncGenerator<JobStreamEvent>, returnSpy };
}

function postReq(body: unknown, opts: { raw?: string } = {}) {
  return POST(
    new Request(`${BASE}/api/ai/plan/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
    }),
  );
}

function streamReq(jobId: string) {
  return GET(new Request(`${BASE}/api/ai/plan/generate/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
}

async function seedActiveProject() {
  await truncateAuthTables();
  const fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'pm@moooon.net', name: 'PM' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  return fx;
}

beforeEach(() => {
  session.current = null;
  activeCtx.current = null;
  streamJobMock.mockReset();
  submitJobMock.mockReset();
  getJobMock.mockReset();
});
afterEach(() => vi.clearAllMocks());
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/ai/plan/generate', () => {
  it('401s an unauthenticated request before touching the service', async () => {
    const res = await postReq({});
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ code: 'UNAUTHENTICATED' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project (no-existence-leak, #26)', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    const res = await postReq({});
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project.',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('opens a generating Plan bound to the job and returns { jobId, planId }', async () => {
    const fx = await seedActiveProject();
    submitJobMock.mockResolvedValue({ jobId: 'job_gen_1' });

    const res = await postReq({ prompt: 'build me a tracker' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.jobId).toBe('job_gen_1');
    expect(typeof body.planId).toBe('string');

    // generate_tree job submitted with the resolved tenant + prompt + actor.
    const [jobKind, tenant, context, actor] = submitJobMock.mock.calls[0]!;
    expect(jobKind).toBe('plan');
    expect(tenant).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
    // The envelope carries the prompt + the project's AI-explanations opt-in
    // (Story 7.4 · MOTIR-850) — OFF by default for a fresh project — and the
    // planning-mistake CONSENT flag (MOTIR-3350 · MOTIR-4343), which is ON for a
    // project that has never touched the setting. Kept as an EXACT shape rather
    // than loosened to `objectContaining`: an absent flag is read on the far
    // side as ON, so what this assertion is for is that the key is THERE.
    expect(context).toEqual({
      prompt: 'build me a tracker',
      generateExplanations: false,
      recordPlanningMistakes: true,
      finalCheck: true,
      // The onboarding marker (MOTIR-4736) — `true` here because this fixture's
      // project has never had a plan approved (`onboardingRanAt` is null).
      onboarding: true,
      // The starter library (MOTIR-11041) — sent on every planning submit.
      starterLibrary: await seedRegistryService.listActiveEntries(),
    });
    expect(actor).toEqual({ userId: fx.ownerId });

    // The Plan really exists, is `generating`, and is bound to the job (sourceJobId).
    const plan = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.findById(body.planId, fx.workspaceId, tx),
    );
    expect(plan).not.toBeNull();
    expect(plan!.status).toBe('generating');
    expect(plan!.sourceJobId).toBe('job_gen_1');
    expect(plan!.projectId).toBe(fx.projectId);
    // …and it RECORDS who wrote it (MOTIR-2996). Motir's own generator authored
    // this tree, so the row says so instead of leaving the Plans surface to infer
    // it from `sourceJobId != null` — which answers WHICH JOB and stands in for
    // WHO only while a motir-ai job is the sole non-MCP writer of a `Plan`.
    // Server-set at this seam, exactly as `create_plan` fixes `mcp`.
    expect(plan!.authorSource).toBe('native');
    expect(plan!.authorHarness).toBe('Motir');
    // Null MODEL: the planning LLM is motir-ai's (`PlanningRun.model`), and the
    // read boundary strips a native model anyway (provenance Decision 6).
    expect(plan!.authorModel).toBeNull();
  });

  it('threads the project aiGenerateExplanations opt-in into the generate_tree envelope (MOTIR-850)', async () => {
    const fx = await seedActiveProject();
    // Opt the active project INTO AI-drafted explanations — the flag rides the
    // envelope context so motir-ai's generate_tree handler drafts explanations.
    activeCtx.current!.project = { ...fx.project, aiGenerateExplanations: true };
    submitJobMock.mockResolvedValue({ jobId: 'job_gen_expl' });

    const res = await postReq({ prompt: 'with explanations' });
    expect(res.status).toBe(200);

    const [jobKind, , context] = submitJobMock.mock.calls[0]!;
    expect(jobKind).toBe('plan');
    expect(context).toEqual({
      prompt: 'with explanations',
      generateExplanations: true,
      recordPlanningMistakes: true,
      finalCheck: true,
      // The onboarding marker (MOTIR-4736) — `true` here because this fixture's
      // project has never had a plan approved (`onboardingRanAt` is null).
      onboarding: true,
      // The starter library (MOTIR-11041) — sent on every planning submit.
      starterLibrary: await seedRegistryService.listActiveEntries(),
    });
  });

  it('surfaces out-of-credits as a DISTINCT 402, leaving NO orphan Plan', async () => {
    const fx = await seedActiveProject();
    submitJobMock.mockRejectedValue(new MotirAiOutOfCreditsError('balance 0'));

    const res = await postReq({});

    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_OUT_OF_CREDITS' });
    // Submit-first means a refused submit never opened a Plan.
    const count = await adminDb.plan.count({ where: { projectId: fx.projectId } });
    expect(count).toBe(0);
  });

  it('maps a generic motir-ai failure to 502', async () => {
    await seedActiveProject();
    submitJobMock.mockRejectedValue(new MotirAiUnavailableError('ECONNREFUSED'));

    const res = await postReq({});
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_UNAVAILABLE' });
  });
});

describe('GET /api/ai/plan/generate/:jobId/stream', () => {
  it('401s an unauthenticated request before opening the stream', async () => {
    const res = await streamReq('job_1');
    expect(res.status).toBe(401);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('404s when there is no active project', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    const res = await streamReq('job_1');
    expect(res.status).toBe(404);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('relays live PlanItem frames as well-formed SSE, then closes', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'planItem', data: { op: 'add', title: 'Epic: Auth' } },
      { event: 'status', data: { status: 'succeeded' } },
    ];
    const { generator, returnSpy } = scriptedStream(
      frames.map((value) => ({ type: 'yield' as const, value })),
    );
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_42');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(streamJobMock).toHaveBeenCalledWith('job_42');
    expect(await res.text()).toBe(sse(frames));
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('appends the out-of-credits REASON as an SSE error frame after a terminal `failed` status', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const frames: JobStreamEvent[] = [
      { event: 'status', data: { status: 'running' } },
      { event: 'status', data: { status: 'failed' } },
    ];
    const { generator } = scriptedStream(
      frames.map((value) => ({ type: 'yield' as const, value })),
    );
    streamJobMock.mockReturnValue(generator);
    getJobMock.mockResolvedValue({
      jobId: 'job_oc',
      status: 'failed',
      result: null,
      error: new MotirAiOutOfCreditsError('out of credits'),
    });

    const res = await streamReq('job_oc');
    const body = await res.text();
    expect(body).toContain('event: error');
    expect(body).toContain('MOTIR_AI_OUT_OF_CREDITS');
  });

  it('priming surfaces an unknown job as a real 404, not an SSE error frame', async () => {
    session.current = { user: { id: 'user_1', email: 'pm@moooon.net', name: 'PM' } };
    activeCtx.current = {
      userId: 'user_1',
      workspaceId: 'ws_1',
      projectId: 'pj_1',
    } as ProjectContext;

    const { generator, returnSpy } = scriptedStream([
      { type: 'throw', error: new MotirAiJobNotFoundError('job_unknown') },
    ]);
    streamJobMock.mockReturnValue(generator);

    const res = await streamReq('job_unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_JOB_NOT_FOUND' });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});
