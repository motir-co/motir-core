import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { DebugLandingDto } from '@/lib/dto/planChange';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { seedLegacyRestartConfirm } from '../helpers/legacyRestartConfirm';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';

// EVERY TURN IS READ — motir-core's half of AMENDMENT 5 (Story MOTIR-9216 ·
// MOTIR-9231), route-level against a REAL Postgres. Only `getSession` /
// `getActiveProject` and the motir-ai client (the HTTP boundary) are mocked, exactly
// as `askRoutes.test.ts` does; the service → repository → database chain runs for
// real under the app role.
//
// What this file holds:
//   * nothing in core submits a `debug_bug` job: a result still carrying a stale
//     `debug` or `new_session` outcome settles `silent` and writes nothing;
//   * an answered turn still lands with its citations and the outage flag;
//   * a retry of a stored `debug` or `new_session` turn re-runs it as an ASK, a
//     `plan_change` retry keeps the shipped submit, and an ask still cannot flip;
//   * turns stored under the retired intents, landings and confirms, still load;
//   * the ask door's optional `anchorKey`, resolved and gated on the way in.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-ask-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const askReq = (body: unknown) => post('/api/ai/ask', body);
const settleReq = (body: unknown) => post('/api/ai/ask/settle', body);

/** A settled `ask_project` result carrying a RETIRED outcome — what a job that
 *  finished across the deploy could still return. */
const staleVerdict = (intent: 'debug' | 'new_session') => ({
  status: 'succeeded',
  result: { ask: { intent, answer: null, citations: [] } },
});
const answered = (answer: string, citations: string[] = [], extra: object = {}) => ({
  status: 'succeeded',
  result: { ask: { intent: 'ask', answer, citations }, ...extra },
});

/** The job kinds submitted so far, in order. */
const submittedKinds = () => submitJobMock.mock.calls.map((c) => c[0]);
/** The context bag of the n-th submit. */
const contextOf = (n: number) => submitJobMock.mock.calls[n]![2] as Record<string, unknown>;

/** Submit jobs with distinct ids per kind and attempt. */
function distinctJobIds() {
  let n = 0;
  submitJobMock.mockImplementation(async (...args: unknown[]) => ({
    jobId: `job-${String(args[0])}-${++n}`,
  }));
}

/** The one `user` turn on the thread. */
async function userTurn() {
  const thread = await openTestSession(activeCtx.current!);
  const turns = thread.turns.filter((t) => t.role === 'user');
  expect(turns).toHaveLength(1);
  return turns[0]!;
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  distinctJobIds();
  getJobMock.mockReset();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Send one turn and settle it with `view`; answers the settle's JSON. */
async function sendAndSettle(text: string, view: unknown) {
  const submitted = (await (await ask(askReq({ body: text }))).json()) as {
    jobId: string;
    turnId: string;
    session: { id: string };
  };
  getJobMock.mockResolvedValue(view);
  const res = await settle(settleReq({ jobId: submitted.jobId }));
  expect(res.status).toBe(200);
  return { submitted, body: (await res.json()) as { outcome: string } };
}

/** Record the thread's one user turn under a RETIRED intent, as it was stored. */
async function storeAs(intent: 'debug' | 'new_session' | 'plan_change') {
  const turn = await userTurn();
  const thread = await openTestSession(activeCtx.current!);
  await planChangeSessionsService.recordTurnIntent(
    turn.id,
    intent,
    activeCtx.current!,
    { jobId: `job-stored-${intent}` },
    { sessionId: thread.id },
  );
  return turn;
}

describe('a defect report or "plan something else" is answered, never dispatched', () => {
  it.each(['debug', 'new_session'] as const)(
    'a stale `%s` outcome with no answer settles silent and writes nothing',
    async (intent) => {
      const items = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });
      const before = await items();
      const { body } = await sendAndSettle(
        'Saving a comment drops the mention',
        staleVerdict(intent),
      );
      expect(body.outcome).toBe('silent');
      expect(submittedKinds()).toEqual(['ask_project']);
      const turn = await userTurn();
      expect(turn.intent).toBe('ask');
      const thread = await openTestSession(activeCtx.current!);
      expect(thread.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
      expect(await items()).toBe(before);
    },
  );

  it('an answered turn appends the assistant turn with its citations and the outage flag', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const { body } = await sendAndSettle(
      'Saving a comment drops the mention',
      answered(`See ${bug.identifier}.`, [bug.identifier], {
        codeUnreadable: {
          halt: 'code_unreadable',
          repoRef: 'o/r',
          repoRefs: ['o/r'],
          reason: 'hydrate_failed',
        },
      }),
    );
    expect(body.outcome).toBe('answered');
    const thread = await openTestSession(activeCtx.current!);
    const reply = thread.turns.find((t) => t.role === 'assistant')!;
    expect(reply.body).toBe(`See ${bug.identifier}.`);
    expect(reply.citations).toEqual([bug.identifier]);
    expect(reply.codeUnreadable).toBe('answered');
    expect(submittedKinds()).toEqual(['ask_project']);
  });
});

describe('the retry of a stored turn', () => {
  it.each(['debug', 'new_session'] as const)(
    'a stored `%s` turn re-runs as an ASK — never the retired debug job, no second user turn',
    async (intent) => {
      await ask(askReq({ body: 'Saving a comment drops the mention' }));
      const turn = await storeAs(intent);

      submitJobMock.mockResolvedValueOnce({ jobId: 'job-retry' });
      const res = await ask(askReq({ turnId: turn.id }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ jobId: 'job-retry', turnId: turn.id });
      expect(submittedKinds()).toEqual(['ask_project', 'ask_project']);
      const after = await userTurn();
      expect(after.intent).toBe('ask');
      expect(after.jobId).toBe('job-retry');
    },
  );

  it('an ask turn still cannot flip', async () => {
    await ask(askReq({ body: 'Why is it blocked?' }));
    const turn = await userTurn();
    const res = await ask(askReq({ turnId: turn.id, flip: true }));
    expect(res.status).toBe(422);
    expect(submittedKinds()).toEqual(['ask_project']);
  });

  it('a stored `plan_change` turn still retries through the shipped plan-change submit', async () => {
    await ask(askReq({ body: 'Split the export epic' }));
    const turn = await storeAs('plan_change');
    const spy = vi
      .spyOn(planChangeSessionsService, 'submit')
      .mockResolvedValueOnce({ jobId: 'job-plan', planId: 'plan-1', session: {} } as never);
    try {
      const res = await ask(askReq({ turnId: turn.id }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ outcome: 'redirected', jobId: 'job-plan' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('turns stored under the retired intents stay readable', () => {
  it('a debug turn with its landing and a new_session turn with its confirm reload unchanged', async () => {
    const ctx = activeCtx.current!;
    const first = (await (await ask(askReq({ body: 'Saving drops the mention' }))).json()) as {
      turnId: string;
      session: { id: string };
    };
    const address = { sessionId: first.session.id };
    await planChangeSessionsService.recordTurnIntent(
      first.turnId,
      'debug',
      ctx,
      { jobId: 'job-old-debug' },
      address,
    );
    const landing: DebugLandingDto = {
      outcome: 'ungrounded',
      workItemKey: null,
      title: null,
      createdInTriage: false,
    };
    await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: 'job-old-debug',
        body: 'Nothing was written.',
        citations: [],
        debugLanding: landing,
      },
      ctx,
      address,
    );
    const second = (await (
      await ask(askReq({ body: 'Plan the mobile app instead', sessionId: first.session.id }))
    ).json()) as { turnId: string };
    await planChangeSessionsService.recordTurnIntent(
      second.turnId,
      'new_session',
      ctx,
      {},
      address,
    );
    // A legacy confirm turn — nothing writes one since MOTIR-11261.
    await seedLegacyRestartConfirm(ctx, address.sessionId);

    const loaded = await planChangeSessionsService.getById(ctx, first.session.id);
    const byId = (id: string) => loaded!.turns.find((t) => t.id === id)!;
    expect(byId(first.turnId).intent).toBe('debug');
    expect(byId(second.turnId).intent).toBe('new_session');
    const reply = loaded!.turns.find((t) => t.jobId === 'job-old-debug' && t.role === 'assistant')!;
    expect(reply.debugLanding).toEqual(landing);
    expect(loaded!.turns.filter((t) => t.confirm === 'new_session')).toHaveLength(1);
    // A reload is a read: the same thread comes back.
    expect(await planChangeSessionsService.getById(ctx, first.session.id)).toEqual(loaded);
  });
});

describe('the anchor — `anchorKey` on the ask door', () => {
  it('is resolved and forwarded to `ask_project` — the only job a turn opens', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const submitted = (await (
      await ask(askReq({ body: 'This drops the mention', anchorKey: bug.identifier }))
    ).json()) as { jobId: string };
    expect(contextOf(0)).toEqual({ prompt: 'This drops the mention', anchorKey: bug.identifier });

    getJobMock.mockResolvedValue(answered('It is the sanitizer.', [bug.identifier]));
    await settle(settleReq({ jobId: submitted.jobId }));
    expect(submittedKinds()).toEqual(['ask_project']);
  });

  it('the turn still lands on the PROJECT-WIDE thread', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const res = (await (await ask(askReq({ body: 'why?', anchorKey: bug.identifier }))).json()) as {
      session: { id: string; targetKeys: string[] };
    };
    // The anchor is DATA the job reads, not a thread: the project conversation,
    // with no anchor set of its own.
    expect(res.session.targetKeys).toEqual([]);
    expect((await openTestSession(activeCtx.current!)).id).toBe(res.session.id);
  });

  it('an unknown or FOREIGN key is the no-existence-leak 404 — no turn, no job', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await createTestWorkItem(other, { kind: 'bug', title: 'Not yours' });

    for (const anchorKey of ['PROD-9999', foreign.identifier, 'not a key']) {
      const res = await ask(askReq({ body: 'why?', anchorKey }));
      expect(res.status, anchorKey).toBe(404);
      await expect(res.json()).resolves.toEqual({
        code: 'NOT_FOUND',
        error: 'Work item not available.',
      });
    }
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await adminDb.planChangeTurn.count()).toBe(0);
  });

  it('a non-string `anchorKey` is a 400', async () => {
    const res = await ask(askReq({ body: 'why?', anchorKey: 42 }));
    expect(res.status).toBe(400);
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});
