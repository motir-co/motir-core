import { expect, vi, type Mock } from 'vitest';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { mintJobToken } from '@/lib/ai/jobToken';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';

// THE PROVIDER-LIMIT STORY GATE'S SHARED DRIVER (Story MOTIR-9540 · MOTIR-9624). Both gate files —
// `providerLimitStoryGate.test.ts` (sections A and B, node) and `providerLimitStoryGate.host.test.tsx`
// (section C, happy-dom) — drive ONE planning session through the same real doors:
//
//   · the hosted planner's step report → `POST /api/internal/ai/plan-step`, with the service
//     bearer and a minted job token (motir-ai is not running; its reports are played in-process);
//   · the overlay's poll → `GET /api/plans/[id]`, and its session read → `GET
//     /api/ai/plan-change/session?id=…`, as the session's owner;
//   · a hosted walk's failed end → `planSessionEndService.settleFailedJob`, the call the stream
//     relays make on a terminal `failed` frame, reading the job from the stubbed motir-ai client;
//   · the owner's Resume → `POST /api/ai/plan-change/session/resume`, with motir-ai's `submitJob`
//     stubbed to accept;
//   · the Workbench To resume read → `homeService.listToResume`, the read the tab's page makes.
//
// The request boundary is the only thing mocked, in each gate file: `getSession` and the two
// cookie readers a test has none for (`getWorkspaceContext`, `getActiveProject`), and the motir-ai
// HTTP client. `requireCompliantSession` and the AI ceiling run for real over the mocked session.
// Every service, repository and row is the real one. The mocks read their answers from {@link gate}.

export const SERVICE_SECRET = 'core-callback-secret-test';

export interface Gate {
  user: { id: string; email: string; name: string } | null;
  workspaceId: string | null;
  project: ProjectContext | null;
  /** The job motir-ai's `getJob` reports, keyed by job id. */
  jobs: Map<string, unknown>;
  submitJob: Mock<(...args: unknown[]) => Promise<{ jobId: string }>>;
}

/**
 * What the mocked request boundary answers, set by {@link signInAs}. It lives on `globalThis` so
 * a gate file's `vi.mock` factories read it at CALL time without importing this module — an
 * import from a factory would run while the mocked module itself is still loading.
 */
const holder = globalThis as unknown as { __providerLimitGate?: Gate };
export const gate: Gate = (holder.__providerLimitGate ??= {
  user: null,
  workspaceId: null,
  project: null,
  jobs: new Map(),
  submitJob: vi.fn<(...args: unknown[]) => Promise<{ jobId: string }>>(),
});

export function resetGate(): void {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  gate.user = null;
  gate.workspaceId = null;
  gate.project = null;
  gate.jobs.clear();
  gate.submitJob.mockReset();
  let seq = 1;
  gate.submitJob.mockImplementation(async () => ({ jobId: `job-${++seq}` }));
}

/** The job view motir-ai answers for a walk that every provider retry was refused on. */
export function rateLimitedJob(planId: string) {
  return {
    status: 'failed',
    error: { code: 'rate_limited', message: 'The model provider refused every retry.' },
    walkStop: {
      phase: 'author',
      target: null,
      targetTitle: 'Export a report',
      depth: 1,
      planId,
      reasonCode: 'rate_limited',
    },
    lostMachine: false,
    resumable: true,
  };
}

export function signInAs(fx: WorkItemFixture): void {
  gate.user = { id: fx.ownerId, email: `${fx.ownerId}@example.com`, name: 'Owner' };
  gate.workspaceId = fx.workspaceId;
  gate.project = projectCtx(fx);
}

export const projectCtx = (fx: WorkItemFixture): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

export interface Routes {
  stepPOST: (req: Request) => Promise<Response>;
  planGET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  sessionGET: (req: Request) => Promise<Response>;
  resumePOST: (req: Request) => Promise<Response>;
}

export interface Walk {
  fx: WorkItemFixture;
  sessionId: string;
  planId: string;
  jobId: string;
}

/**
 * One hosted planning session with its `generating` plan, bound to job `job-1` and holding a
 * proposal, over a card it holds — the state a hosted walk is in when its provider says 429.
 * Built the way the resume suite builds it: the session through its service, the plan row bound.
 */
export async function openWalk(
  services: {
    startWithFirstTurn: (
      pctx: ProjectContext,
      scope: ReturnType<typeof buildScope>,
      body: string,
    ) => Promise<{ id: string }>;
    createCard: (fx: WorkItemFixture) => Promise<{ id: string; identifier: string }>;
  },
  identifier = 'PLG',
): Promise<Walk> {
  const fx = await makeWorkItemFixture({ identifier });
  const card = await services.createCard(fx);
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });
  const session = await services.startWithFirstTurn(
    projectCtx(fx),
    buildScope([card.identifier]),
    'Split the export story so CSV ships first.',
  );
  const jobId = 'job-1';
  await adminDb.planChangeSession.update({
    where: { id: session.id },
    data: { lastJobId: jobId },
  });
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'generating',
      sourceJobId: jobId,
      title: 'Split the export story',
      createdById: fx.ownerId,
    },
  });
  await adminDb.planItem.create({
    data: {
      workspaceId: fx.workspaceId,
      planId: plan.id,
      op: 'add',
      proposedFields: { title: 'CSV export', kind: 'subtask' },
      blockedByRefs: [],
    },
  });
  return { fx, sessionId: session.id, planId: plan.id, jobId };
}

/** The hosted planner's step report — the internal route with its two credentials. */
export function hostedStep(
  routes: Routes,
  walk: Walk,
  body: Record<string, unknown>,
  jobId = walk.jobId,
): Promise<Response> {
  const token = mintJobToken({
    userId: walk.fx.ctx.userId,
    workspaceId: walk.fx.ctx.workspaceId,
    projectId: walk.fx.projectId,
  });
  return routes.stepPOST(
    new Request('http://core/api/internal/ai/plan-step', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_SECRET}`,
        'x-motir-job-token': token,
      },
      body: JSON.stringify({ jobId, ...body }),
    }),
  );
}

/** A report that must be accepted. */
export async function accepted(res: Promise<Response>): Promise<unknown> {
  const r = await res;
  const body = (await r.json()) as unknown;
  expect(r.status, JSON.stringify(body)).toBe(200);
  return body;
}

export const waiting = (attempt: number, maxAttempts: number, retryAt: Date) => ({
  providerRetry: { state: 'waiting', attempt, maxAttempts, retryAt: retryAt.toISOString() },
});
export const cleared = { providerRetry: { state: 'cleared' } };

/** `GET /api/plans/[id]` — the overlay's one poll — as the session's owner. */
export async function reviewRead(routes: Routes, walk: Walk): Promise<PlanReviewDto> {
  signInAs(walk.fx);
  const res = await routes.planGET(new Request(`http://localhost/api/plans/${walk.planId}`), {
    params: Promise.resolve({ id: walk.planId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PlanReviewDto;
}

/** `GET /api/ai/plan-change/session?id=…` — the overlay's session read — as the owner. */
export async function sessionRead(routes: Routes, walk: Walk): Promise<PlanChangeSessionDto> {
  signInAs(walk.fx);
  const res = await routes.sessionGET(
    new Request(`http://localhost/api/ai/plan-change/session?id=${walk.sessionId}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PlanChangeSessionDto;
}

/** The owner's Resume. */
export async function resumeAsOwner(routes: Routes, walk: Walk): Promise<Response> {
  signInAs(walk.fx);
  return routes.resumePOST(
    new Request('http://localhost/api/ai/plan-change/session/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: walk.sessionId }),
    }),
  );
}

/** The reader's To resume planning-session entries. */
export async function toResumeEntries(
  listToResume: (ctx: WorkItemFixture['ctx'] & { projectId: string }) => Promise<{
    planningSessions?: ToResumePlanningSessionDto[];
  }>,
  walk: Walk,
): Promise<ToResumePlanningSessionDto[]> {
  const page = await listToResume({ ...walk.fx.ctx, projectId: walk.fx.projectId });
  return page.planningSessions ?? [];
}
