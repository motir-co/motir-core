import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Task MOTIR-1101 · Subtask MOTIR-8181 — the Sharpen door's TRANSPORT: auth,
// the body guards, and each typed refusal's status. The service's own rules are
// `aiSharpenService.test.ts`'s. Real Postgres; the session, the active project
// and the motir-ai boundary client are the stubs every conversation-door suite uses.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const jobs = vi.hoisted(() => ({ next: 0, contexts: [] as unknown[] }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (_kind: string, _tenant: unknown, context: unknown) => {
    jobs.contexts.push(context);
    jobs.next += 1;
    return { jobId: `job-${jobs.next}` };
  }),
  getJob: vi.fn(async (jobId: string) => ({
    jobId,
    status: 'succeeded',
    result: {
      sharpenTurn: {
        kind: 'question',
        question: {
          id: 'q1',
          text: 'Who exports?',
          topic: 'workflow',
          because: null,
          quote: null,
          readings: [
            { id: 'a', label: 'Admins', detail: '', recommended: true },
            { id: 'b', label: 'Anyone', detail: '', recommended: false },
          ],
        },
        settled: [],
        assumptions: [],
        writeBack: null,
      },
    },
    error: null,
  })),
  streamJob: vi.fn(),
}));

const { POST, GET } = await import('@/app/api/ai/sharpen/route');
const { GET: getOne } = await import('@/app/api/ai/sharpen/[sessionId]/route');
const { POST: settle } = await import('@/app/api/ai/sharpen/settle/route');
const { plansService } = await import('@/lib/services/plansService');

const BASE = 'http://localhost:3000';
const post = (path: string, raw: string) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });

let fx: WorkItemFixture;

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  jobs.next = 0;
  jobs.contexts = [];
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  signIn(fx);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signIn(f: WorkItemFixture): void {
  session.current = { user: { id: f.ownerId, email: f.owner.email, name: f.owner.name } };
  activeCtx.current = {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

async function plannedPlan(): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Sharpen', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A card', kind: 'task', difficulty: 'low' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function openSettled(): Promise<{ sessionId: string; planId: string }> {
  const planId = await plannedPlan();
  const res = await POST(post('/api/ai/sharpen', JSON.stringify({ planId })));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const body = (await res.json()) as { jobId: string; session: { id: string } };
  const s = await settle(
    post(
      '/api/ai/sharpen/settle',
      JSON.stringify({ sessionId: body.session.id, jobId: body.jobId }),
    ),
  );
  expect(s.status).toBe(200);
  expect(((await s.json()) as { outcome: string }).outcome).toBe('settled');
  return { sessionId: body.session.id, planId };
}

describe('POST /api/ai/sharpen', () => {
  it('401 with no session', async () => {
    session.current = null;
    expect((await POST(post('/api/ai/sharpen', '{}'))).status).toBe(401);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['no planId, conversationId or sessionId', '{}'],
    ['the retired itemKey (MOTIR-9314)', JSON.stringify({ itemKey: 'PROD-1' })],
    ['a turnId without a sessionId', JSON.stringify({ turnId: 't' })],
    ['an unknown action', JSON.stringify({ sessionId: 's', action: 'shout' })],
    ['both planId and conversationId', JSON.stringify({ planId: 'p', conversationId: 'c' })],
  ])('400 for %s', async (_label, raw) => {
    expect((await POST(post('/api/ai/sharpen', raw))).status).toBe(400);
  });

  it('400 for a reading not on the question and for empty own words; 409 while in flight', async () => {
    const { sessionId } = await openSettled();
    const bad = await POST(
      post('/api/ai/sharpen', JSON.stringify({ sessionId, action: 'answer', readingId: 'z' })),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('SHARPEN_ACTION_INVALID');
    const empty = await POST(
      post('/api/ai/sharpen', JSON.stringify({ sessionId, action: 'own_words', text: ' ' })),
    );
    expect(empty.status).toBe(400);

    // A client-sent settled set is ignored: the job carries the stored one.
    const ok = await POST(
      post(
        '/api/ai/sharpen',
        JSON.stringify({ sessionId, action: 'answer', readingId: 'b', settled: [{ x: 1 }] }),
      ),
    );
    expect(ok.status).toBe(200);
    expect((jobs.contexts.at(-1) as { sharpen: { settled: unknown[] } }).sharpen.settled).toEqual(
      [],
    );

    const inFlight = await POST(
      post('/api/ai/sharpen', JSON.stringify({ sessionId, action: 'skip' })),
    );
    expect(inFlight.status).toBe(409);
    expect(((await inFlight.json()) as { code: string }).code).toBe('SHARPEN_TURN_IN_FLIGHT');
  });

  it('409 SHARPEN_TARGET_CLOSED for an ended conversation; 404 for an unknown one', async () => {
    const ended = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        endedAt: new Date(),
        endReason: 'idle',
      },
    });
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: ended.id,
        seq: 0,
        role: 'user',
        body: 'Export',
      },
    });
    const closed = await POST(
      post('/api/ai/sharpen', JSON.stringify({ conversationId: ended.id })),
    );
    expect(closed.status).toBe(409);
    expect(((await closed.json()) as { code: string }).code).toBe('SHARPEN_TARGET_CLOSED');
    const missing = await POST(post('/api/ai/sharpen', JSON.stringify({ conversationId: 'nope' })));
    expect(missing.status).toBe(404);
  });
});

describe('the reads', () => {
  it('GET ?planId= answers null, then the open session; GET /[sessionId] answers it, 404 for another project', async () => {
    const planId = await plannedPlan();
    const none = await GET(new Request(`${BASE}/api/ai/sharpen?planId=${planId}`));
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();

    const opened = (await (
      await POST(post('/api/ai/sharpen', JSON.stringify({ planId })))
    ).json()) as { session: { id: string } };
    const open = await GET(new Request(`${BASE}/api/ai/sharpen?planId=${planId}`));
    expect(((await open.json()) as { id: string }).id).toBe(opened.session.id);

    const params = { params: Promise.resolve({ sessionId: opened.session.id }) };
    const one = await getOne(new Request(`${BASE}/api/ai/sharpen/x`), params);
    expect(one.status).toBe(200);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    signIn(other);
    const foreign = await getOne(new Request(`${BASE}/api/ai/sharpen/x`), params);
    expect(foreign.status).toBe(404);
  });

  it('GET without exactly one target is a 400', async () => {
    expect((await GET(new Request(`${BASE}/api/ai/sharpen`))).status).toBe(400);
  });

  it('GET ?conversationId=&latest=1 answers the latest session there; `latest` needs a conversation (MOTIR-9316)', async () => {
    const conversation = await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, createdById: fx.ownerId },
    });
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: conversation.id,
        seq: 0,
        role: 'user',
        body: 'Add a CSV export',
      },
    });
    const latestUrl = `${BASE}/api/ai/sharpen?conversationId=${conversation.id}&latest=1`;
    const none = await GET(new Request(latestUrl));
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();

    const opened = (await (
      await POST(post('/api/ai/sharpen', JSON.stringify({ conversationId: conversation.id })))
    ).json()) as { session: { id: string } };
    const open = (await (await GET(new Request(latestUrl))).json()) as {
      id: string;
      status: string;
      scope: { kind: string };
    };
    expect(open.id).toBe(opened.session.id);
    expect(open.status).toBe('open');
    expect(open.scope.kind).toBe('conversation');

    const planId = await plannedPlan();
    const onPlan = await GET(new Request(`${BASE}/api/ai/sharpen?planId=${planId}&latest=1`));
    expect(onPlan.status).toBe(400);
  });
});

describe('POST /api/ai/sharpen/settle', () => {
  it('400 without jobId and sessionId', async () => {
    expect((await settle(post('/api/ai/sharpen/settle', '{}'))).status).toBe(400);
  });

  it('404 for a session that is not the caller’s', async () => {
    const res = await settle(
      post('/api/ai/sharpen/settle', JSON.stringify({ sessionId: 'nope', jobId: 'job-1' })),
    );
    expect(res.status).toBe(404);
  });
});
