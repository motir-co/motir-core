import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { createTestUser } from '../../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { planReview, planReviewItem } from '../../helpers/planReview';

// TALK TO THE PLANNER WHILE IT PLANS — the motir-core half of the story, assembled
// through its HTTP doors over the real database (Story MOTIR-7990 · MOTIR-8003).
//
// Each predecessor proves its own piece against stubs of its neighbours; this gate
// proves the pieces JOIN. In particular that the pause door's answers land on the
// SAME mailbox the routing forwards into: the START OVER YES as the shipped
// `restart` turn, the NO as a decline `fold` turn, and the person's reply to the
// planner's question as an ordinary forwarded change — while the question itself
// appears in the thread through `runPause` and never through the shipped end-of-job
// question path (whose answer would open a second run).
//
// Driven through the ROUTE HANDLERS, not the services. Real Postgres for the
// session, the thread, the mailbox, the plan, its trail and the pause rows.
//
// Mocked, and only these:
//   * the motir-ai JOB SEAM (`submitJob` / `getJob` in `lib/ai/motirAiClient`) — the
//     result of every `ask_project` job is scripted here, and the run's own status
//     is whatever `setJob` says;
//   * the session / active-project seam the cookie-authenticated routes read;
//   * `planReviewService.getPlanReview`, the INPUT of the run snapshot (its own
//     assembly is covered by the plan-review suites).
//
// NOT here, on purpose (they would assert the stub): whether `ask_project`
// classifies a turn correctly, when a walk reads its mailbox, whether the walk
// pauses on a verdict and posts the pause, and whether a reply is judged again —
// the motir-ai story gate's. The job-token door is called DIRECTLY, in the
// planner's place. The browser flow is the E2E's.
//
// ⚠️ CASE 4 RAN IN THE NEXT-TURN FORM: the offer rides the assistant turn
// (`forwardOffer`), and the person's NEXT turn ("yes, forward it") carries it as
// `run.pendingOffer`. The decision chose that form; there is no one-click confirm
// door in core to drive.

const RUN_JOB = 'job-run-1';
const SERVICE_SECRET = 'core-callback-secret-test';
const BASE = 'http://localhost:3000';

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) => {
    const scripted = jobs.get(jobId);
    // A scripted Error is motir-ai being unreachable for that job; a scripted
    // function is something that happens while core is asking (a plan deleted
    // between two reads).
    if (scripted instanceof Error) throw scripted;
    if (typeof scripted === 'function') return scripted();
    return scripted ?? { jobId, status: 'running', result: null, error: null };
  },
  streamJob: vi.fn(),
}));

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const getPlanReviewMock = vi.fn();
vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: { getPlanReview: (...args: unknown[]) => getPlanReviewMock(...args) },
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planChangeMailboxService } = await import('@/lib/services/planChangeMailboxService');
const { PAUSE_DECLINE_INSTRUCTION } = await import('@/lib/services/planChangeRunPauseService');
const { pendingQuestion } = await import('@/lib/planning/planChangeThread');
const { mintJobToken } = await import('@/lib/ai/jobToken');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { POST: askRoute } = await import('@/app/api/ai/ask/route');
const { POST: settleRoute } = await import('@/app/api/ai/ask/settle/route');
const { POST: lateChanges } = await import('@/app/api/ai/plan-change/session/late-changes/route');
const { __resetSharedRateLimitStoreForTest } = await import('@/lib/rateLimit/store');
const { pinSharedRateLimitStoreDeadline } = await import('../../helpers/rateLimitStore');
const { ALIGNED_HEADROOM_MS, ALIGNED_WINDOW_MS, waitForWindowBoundary, waitForWindowHeadroom } =
  await import('../../helpers/rateLimitWindow');
const { POST: mailboxRoute } = await import('@/app/api/ai/plan-change/session/mailbox/route');
const { GET: readPauseRoute, POST: answerPauseRoute } =
  await import('@/app/api/ai/plan-change/session/run-pause/route');
const { POST: recordPauseDoor } = await import('@/app/api/internal/ai/plan-change-run-pause/route');

// The routes answer JSON of many shapes; a case asserts the fields it names.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let fx: WorkItemFixture;
let ctx: ProjectContext;
let sessionId: string;
let planId: string;
let askSeq = 0;
let keySeq = 0;

// ─── requests ────────────────────────────────────────────────────────────────

function req(path: string, method: 'GET' | 'POST', body?: unknown, headers: HeadersInit = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function readJson(res: Response): Promise<Json> {
  return res.json();
}

/** The planner's side: the job-token door, authenticated the way the sibling
 *  `plan-change-mailbox` door is (service bearer + job token). */
function doorReq(body: unknown, authed = true): Request {
  return new Request(`${BASE}/api/internal/ai/plan-change-run-pause`, {
    method: 'POST',
    headers: authed
      ? {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': mintJobToken({
            userId: fx.ownerId,
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
          }),
        }
      : {},
    body: JSON.stringify(body),
  });
}

// ─── the run ─────────────────────────────────────────────────────────────────

function setJob(status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled', id = RUN_JOB) {
  jobs.set(id, { jobId: id, status, result: null, error: null });
}

function reviewFor(projectId: string) {
  return planReview(
    [
      planReviewItem({
        planItemId: 'pi_1',
        nodeId: 'pi_1',
        title: 'Payments epic',
        kind: 'epic',
        descriptionMd: 'Take card payments.',
      }),
      planReviewItem({
        planItemId: 'pi_2',
        nodeId: 'pi_2',
        parentNodeId: 'pi_1',
        title: 'Checkout story',
        kind: 'story',
        descriptionMd: null,
      }),
    ],
    {
      id: planId,
      projectId,
      status: 'generating',
      progress: {
        startedAt: '2026-10-09T10:00:00.000Z',
        lastActivityAt: '2026-10-09T10:05:00.000Z',
        observedAt: '2026-10-09T10:06:00.000Z',
        authored: 1,
        proposed: 2,
        autoResume: null,
        steps: [
          {
            sessionKey: 's1',
            kind: 'author',
            phrase: 'authoring',
            targetRef: 'planItem:pi_2',
            targetNodeId: 'pi_2',
            targetTitle: 'Checkout story',
            startedAt: '2026-10-09T10:05:00.000Z',
            providerWait: null,
          },
        ],
      },
    },
  );
}

/**
 * A conversation ON a planning run: the session bound to `RUN_JOB`, a plan the run
 * authors into (bound to the job and the session), and the job `running` — or, with
 * `planned`, a closed plan on a `succeeded` job (the late-change setting).
 */
async function bootRun(opts: { planned?: boolean; plan?: boolean } = {}) {
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      lastJobId: RUN_JOB,
      lastSubmittedAt: new Date(),
    },
  });
  sessionId = row.id;
  // `plan: false` is a run that produced no plan this conversation can see.
  planId = 'plan-none';
  if (opts.plan !== false) {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'The run plan', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    planId = plan.id;
  }
  if (opts.planned) {
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'The proposal', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
  }
  if (opts.plan !== false) {
    await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: RUN_JOB, sessionId } });
  }
  setJob(opts.planned ? 'succeeded' : 'running');
  getPlanReviewMock.mockResolvedValue(reviewFor(fx.projectId));
  submitJobMock.mockReset();
  return row;
}

/** Post a composer turn typed during the run; the ask job the mock minted. */
async function askMidRun(text: string, over: Record<string, unknown> = {}) {
  const jobId = `job-ask-${++askSeq}`;
  submitJobMock.mockResolvedValueOnce({ jobId });
  const res = await askRoute(
    req('/api/ai/ask', 'POST', { body: text, sessionId, runJobId: RUN_JOB, planId, ...over }),
  );
  return { res, jobId, body: res.status === 200 ? await readJson(res) : null };
}

/** Script an `ask_project` job's result and settle it through the route. */
async function settleAs(jobId: string, ask: Record<string, unknown>) {
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const res = await settleRoute(req('/api/ai/ask/settle', 'POST', { jobId, sessionId }));
  expect(res.status).toBe(200);
  return readJson(res);
}

/** A turn typed during the run that the answering session read as a change. */
async function forwardChange(text: string) {
  const asked = await askMidRun(text);
  expect(asked.res.status).toBe(200);
  const settled = await settleAs(asked.jobId, {
    intent: 'plan_change',
    answer: null,
    citations: [],
    forward: { text },
  });
  expect(settled.outcome).toBe('forwarded');
  const turn = settled.session.turns.find((t: Json) => t.id === asked.body.turnId);
  const entryId: string = turn.forwarded.mailboxEntryId;
  return { askJobId: asked.jobId, turnId: asked.body.turnId as string, entryId, settled };
}

async function thread() {
  return (await planChangeSessionsService.getById(ctx, sessionId)).turns;
}
async function entries() {
  return adminDb.planChangeMailboxEntry.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
}
async function pauseRows() {
  return adminDb.planChangeRunPause.findMany({ where: { sessionId } });
}
async function revisionStarts() {
  return adminDb.planRevision.findMany({ where: { planId, changeKind: 'revision_started' } });
}
function submittedKinds(): string[] {
  return submitJobMock.mock.calls.map((c) => c[0] as string);
}

// ─── pause helpers ───────────────────────────────────────────────────────────

async function recordPause(over: Record<string, unknown> = {}) {
  const res = await recordPauseDoor(
    doorReq({
      jobId: RUN_JOB,
      kind: 'replan',
      changeTurnIds: [],
      reason: 'This reshapes the whole tree.',
      idempotencyKey: `pk-${++keySeq}`,
      ...over,
    }),
  );
  return { res, body: await readJson(res) };
}

async function answerPause(over: Record<string, unknown>) {
  const res = await answerPauseRoute(
    req('/api/ai/plan-change/session/run-pause', 'POST', { sessionId, jobId: RUN_JOB, ...over }),
  );
  return { res, body: await readJson(res) };
}

async function readPause() {
  const res = await readPauseRoute(
    req(`/api/ai/plan-change/session/run-pause?sessionId=${sessionId}&jobId=${RUN_JOB}`, 'GET'),
  );
  expect(res.status).toBe(200);
  return readJson(res);
}

/** A second conversation with its own run and one mailbox entry on it. */
async function foreignRun() {
  const other = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      lastJobId: 'job-other',
      lastSubmittedAt: new Date(),
    },
  });
  const entry = await adminDb.planChangeMailboxEntry.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: other.id,
      jobId: 'job-other',
      seq: 0,
      kind: 'turn',
      body: 'elsewhere',
      disposition: 'fold',
      idempotencyKey: 'x',
    },
  });
  return { session: other, entry };
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

beforeEach(async () => {
  // The late-changes route is rate-limited; its refusals count through the shared
  // store, so pin the test-time deadline (MOTIR-3067).
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  askSeq = 0;
  keySeq = 0;
  jobs.clear();
  submitJobMock.mockReset();
  getPlanReviewMock.mockReset();
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = ctx;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ═══ ROUTING AND FORWARD ═════════════════════════════════════════════════════

describe('a turn typed during a run — the routing (cases 1–5)', () => {
  it('1. a question reaches no walk: answered, the planning job’s mailbox stays empty, lastJobId unchanged', async () => {
    await bootRun();

    const asked = await askMidRun('how far along is it?');

    expect(asked.res.status).toBe(200);
    const [kind, , context] = submitJobMock.mock.calls[0]!;
    expect(kind).toBe('ask_project');
    const run = (context as { run: Json }).run;
    expect(run).toMatchObject({ planId, readable: true, planStatus: 'generating' });
    expect(run).not.toHaveProperty('activity');
    expect(run.steps).toEqual([
      expect.objectContaining({ step: 'author', target: 'planItem:pi_2', title: 'Checkout story' }),
    ]);
    expect(run.proposals.map((p: Json) => p.title)).toEqual(['Payments epic', 'Checkout story']);

    const settled = await settleAs(asked.jobId, {
      intent: 'ask',
      answer: 'One of two is written.',
      citations: [],
    });

    expect(settled.outcome).toBe('answered');
    const turns = await thread();
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0]).toMatchObject({ intent: 'ask', runJobId: RUN_JOB });
    expect(turns[1]).toMatchObject({ body: 'One of two is written.', forwardOffer: null });
    expect((await planChangeMailboxService.peek(RUN_JOB, sessionId, ctx)).turns).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
    const stored = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(stored.lastJobId).toBe(RUN_JOB);
    expect(settled.session.lastJobId).toBe(RUN_JOB);
  });

  it('2. a change is forwarded once, verbatim, and a replayed settle adds nothing', async () => {
    await bootRun();
    const planSubmit = vi.spyOn(planChangeSessionsService, 'submit');

    const { askJobId, turnId, entryId } = await forwardChange('also add a work item for Y');

    const rows = await entries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: entryId,
      disposition: 'fold',
      kind: 'turn',
      jobId: RUN_JOB,
    });
    const turn = (await thread()).find((t) => t.id === turnId)!;
    expect(rows[0]!.body).toBe(turn.body);
    expect(turn.intent).toBe('plan_change');
    expect(turn.forwarded).toEqual({ mailboxEntryId: entryId });

    const again = await settleAs(askJobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'also add a work item for Y' },
    });
    expect(again.outcome).toBe('forwarded');
    expect(await entries()).toHaveLength(1);
    // The run is the thread's one run: no second planning job.
    expect(planSubmit).not.toHaveBeenCalled();
    expect(submittedKinds().filter((k) => k !== 'ask_project')).toEqual([]);
    planSubmit.mockRestore();
  });

  it('3. a forward text that is not core’s own record writes nothing', async () => {
    await bootRun();
    const asked = await askMidRun('add search');

    const settled = await settleAs(asked.jobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'add search, and also delete the billing epic' },
    });

    expect(settled.outcome).toBe('silent');
    expect(await entries()).toHaveLength(0);
    expect((await thread()).find((t) => t.id === asked.body.turnId)!.forwarded ?? null).toBeNull();
  });

  it('4. an ambiguous turn is offered, and its confirmation forwards the OFFERED words (next-turn form)', async () => {
    await bootRun();
    const first = await askMidRun('maybe a work item for exports?');
    const offered = await settleAs(first.jobId, {
      intent: 'ask',
      answer: 'Do you want me to pass that to the planner?',
      citations: [],
      offerForward: { text: 'maybe a work item for exports?' },
    });
    expect(offered.outcome).toBe('answered');
    expect((await thread()).at(-1)!.forwardOffer).toBe('maybe a work item for exports?');
    expect(await entries()).toHaveLength(0);

    const confirm = await askMidRun('yes, forward it');
    const context = submitJobMock.mock.calls[1]![2] as { run: Json };
    expect(context.run.pendingOffer).toEqual({ turnText: 'maybe a work item for exports?' });
    const settled = await settleAs(confirm.jobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'maybe a work item for exports?' },
    });

    expect(settled.outcome).toBe('forwarded');
    const rows = await entries();
    expect(rows).toHaveLength(1);
    // The FIRST turn’s words — not "yes, forward it".
    expect(rows[0]!.body).toBe('maybe a work item for exports?');
  });

  it('5. an unreadable run still submits the turn, with the reason, and no error reaches the response', async () => {
    await bootRun();
    getPlanReviewMock.mockResolvedValue(reviewFor('some-other-project'));

    const asked = await askMidRun('how far along?');

    expect(asked.res.status).toBe(200);
    expect(asked.body.jobId).toBe(asked.jobId);
    const context = submitJobMock.mock.calls[0]![2] as { run: Json };
    expect(context.run).toEqual({ planId, readable: false, reason: 'PLAN_NOT_FOUND' });
    expect(await thread()).toHaveLength(1);
  });
});

// ═══ LATE REVISION AND REFUSAL ═══════════════════════════════════════════════

describe('a change forwarded after the walk ended — the late revision (cases 6–9)', () => {
  it('6. refused-then-revised: ONE revision of the run plan, a revision_started row, no mailbox entry', async () => {
    await bootRun({ planned: true });
    const asked = await askMidRun('add a reporting epic');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });
    const plansBefore = await adminDb.plan.count({ where: { projectId: fx.projectId } });

    const settled = await settleAs(asked.jobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'add a reporting epic' },
    });

    expect(settled).toMatchObject({
      outcome: 'revised_late',
      planId,
      revisionJobId: 'job-rev-1',
      text: 'add a reporting epic',
    });
    const revisions = submitJobMock.mock.calls.filter((c) => c[0] === 'plan');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]![2]).toMatchObject({ planId });
    expect((revisions[0]![2] as { prompt: string }).prompt).toContain('add a reporting epic');
    const starts = await revisionStarts();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.diff).toMatchObject({ revision: true, jobId: 'job-rev-1' });
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(plansBefore);
    expect(await entries()).toHaveLength(0);
    expect((await thread()).find((t) => t.id === asked.body.turnId)).toMatchObject({
      intent: 'plan_change',
      revisedLate: { revisionJobId: 'job-rev-1' },
    });
  });

  it('7. stranded: two folds attached while running, job then finished — ONE revision in seq order, then none', async () => {
    await bootRun({ planned: true });
    setJob('running');
    for (const [i, body] of ['first change', 'second change'].entries()) {
      const res = await mailboxRoute(
        req('/api/ai/plan-change/session/mailbox', 'POST', {
          sessionId,
          jobId: RUN_JOB,
          body,
          idempotencyKey: `k${i}`,
        }),
      );
      expect(res.status).toBe(200);
    }
    setJob('succeeded');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });

    const res = await lateChanges(
      req('/api/ai/plan-change/session/late-changes', 'POST', { sessionId, runJobId: RUN_JOB }),
    );

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({
      outcome: 'revised',
      planId,
      revisionJobId: 'job-rev-1',
      texts: ['first change', 'second change'],
    });
    const revisions = submitJobMock.mock.calls.filter((c) => c[0] === 'plan');
    expect(revisions).toHaveLength(1);
    const prompt = (revisions[0]![2] as { prompt: string }).prompt;
    expect(prompt.indexOf('first change')).toBeGreaterThan(-1);
    expect(prompt.indexOf('second change')).toBeGreaterThan(prompt.indexOf('first change'));
    const rows = await entries();
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.consumedAt !== null)).toBe(true);
    expect(await revisionStarts()).toHaveLength(1);

    submitJobMock.mockClear();
    const second = await lateChanges(
      req('/api/ai/plan-change/session/late-changes', 'POST', { sessionId, runJobId: RUN_JOB }),
    );
    expect(await readJson(second)).toEqual({ outcome: 'none' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  // Case 8: every refusal keeps the words and creates NEITHER an entry NOR a revision.
  const refusals: Array<[string, string, () => Promise<void>]> = [
    [
      'a plan the person already approved',
      'PLAN_CHANGE_PLAN_DECIDED',
      async () => {
        await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });
        setJob('succeeded');
      },
    ],
    [
      'a run the person stopped',
      'PLAN_CHANGE_RUN_STOPPED',
      async () => {
        await planChangeMailboxService.raiseStop(RUN_JOB, 'stop-1', ctx, sessionId);
        setJob('canceled');
      },
    ],
    [
      'a run that failed',
      'PLAN_CHANGE_RUN_FAILED',
      async () => {
        setJob('failed');
      },
    ],
    [
      'a revision lease another revision holds',
      'PLAN_REVISION_IN_FLIGHT',
      async () => {
        setJob('succeeded');
        submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-held' });
        await aiPlanEditsService.submitRevise(planId, 'someone elses revision', ctx);
      },
    ],
  ];

  it.each(refusals)(
    '8. %s: the refusal carries the code and the full text; no entry, no revision, the turn stays',
    async (_name, code, arrange) => {
      await bootRun({ planned: true });
      setJob('running');
      const asked = await askMidRun('late idea, kept verbatim');
      await arrange();
      const startsBefore = (await revisionStarts()).length;
      submitJobMock.mockClear();

      const settled = await settleAs(asked.jobId, {
        intent: 'plan_change',
        answer: null,
        citations: [],
        forward: { text: 'late idea, kept verbatim' },
      });

      expect(settled).toMatchObject({
        outcome: 'forward_refused',
        code,
        text: 'late idea, kept verbatim',
      });
      // Never both and never neither: the words came back, so nothing was written.
      expect(
        await adminDb.planChangeMailboxEntry.count({ where: { sessionId, kind: 'turn' } }),
      ).toBe(0);
      expect(submittedKinds().filter((k) => k === 'plan')).toEqual([]);
      expect((await revisionStarts()).length).toBe(startsBefore);
      const turn = (await thread()).find((t) => t.id === asked.body.turnId)!;
      expect(turn).toMatchObject({ role: 'user', body: 'late idea, kept verbatim', intent: 'ask' });
      expect(turn.forwarded ?? null).toBeNull();
      expect(turn.revisedLate ?? null).toBeNull();
    },
  );

  it('9. a runJobId that is not the session’s run is a 404 on both doors, nothing written or submitted', async () => {
    await bootRun();
    // One stranded-able entry, so "nothing claimed" is observable.
    await planChangeMailboxService.attachTurn(
      { jobId: RUN_JOB, sessionId, body: 'one', idempotencyKey: 'k1' },
      ctx,
    );
    setJob('succeeded');

    const ask = await askMidRun('hello', { runJobId: 'job-someone-elses' });
    const late = await lateChanges(
      req('/api/ai/plan-change/session/late-changes', 'POST', {
        sessionId,
        runJobId: 'job-someone-elses',
      }),
    );

    expect(ask.res.status).toBe(404);
    expect(late.status).toBe(404);
    expect(await thread()).toHaveLength(0);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(
      await adminDb.planChangeMailboxEntry.count({ where: { sessionId, consumedAt: null } }),
    ).toBe(1);
  });
});

// ═══ THE NO-RUN PATH ═════════════════════════════════════════════════════════

describe('with NO run in progress — today’s submit path is untouched (case 10)', () => {
  it('10. an ordinary turn stores and answers the way submitTurn does, and a plan_change still submits a new planning run', async () => {
    // No session on a run here: the project’s own conversation starts on the first turn.
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-ask-a' });
    const viaRoute = await readJson(
      await askRoute(req('/api/ai/ask', 'POST', { body: 'which stories are blocked?' })),
    );
    expect(Object.keys(viaRoute).sort()).toEqual(['jobId', 'session', 'turnId']);
    const sid: string = viaRoute.session.id;

    // The same turn through the service the route fronts: identical shape.
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-ask-b' });
    const viaService = await aiAskService.submitTurn('and which are done?', ctx, {
      sessionId: sid,
    });
    expect(Object.keys(viaService).sort()).toEqual(Object.keys(viaRoute).sort());

    const turns = (await planChangeSessionsService.getById(ctx, sid)).turns;
    const [a, b] = turns.filter((t) => t.role === 'user');
    expect(Object.keys(a!).sort()).toEqual(Object.keys(b!).sort());
    for (const t of [a!, b!]) {
      expect(t.intent).toBe('ask');
      expect(t.runJobId ?? null).toBeNull();
      expect(t.forwardOffer ?? null).toBeNull();
      expect(t.forwarded ?? null).toBeNull();
    }
    // Its answer settles as an ordinary answer.
    jobs.set('job-ask-a', {
      jobId: 'job-ask-a',
      status: 'succeeded',
      result: { ask: { intent: 'ask', answer: 'Two are.', citations: [] } },
      error: null,
    });
    const answered = await readJson(
      await settleRoute(req('/api/ai/ask/settle', 'POST', { jobId: 'job-ask-a', sessionId: sid })),
    );
    expect(answered.outcome).toBe('answered');
    const answer = (await planChangeSessionsService.getById(ctx, sid)).turns.at(-1)!;
    expect(answer).toMatchObject({ role: 'assistant', body: 'Two are.' });
    expect(answer.forwardOffer ?? null).toBeNull();

    // A plan_change with no run in progress submits the planning run, as today.
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-ask-c' });
    const third = await readJson(
      await askRoute(req('/api/ai/ask', 'POST', { body: 'add a payments epic', sessionId: sid })),
    );
    jobs.set('job-ask-c', {
      jobId: 'job-ask-c',
      status: 'succeeded',
      result: { ask: { intent: 'plan_change', answer: null, citations: [] } },
      error: null,
    });
    const planSubmit = vi.spyOn(planChangeSessionsService, 'submit');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-plan-new' });
    const redirected = await readJson(
      await settleRoute(req('/api/ai/ask/settle', 'POST', { jobId: third.jobId, sessionId: sid })),
    );

    expect(redirected.outcome).toBe('redirected');
    expect(redirected.jobId).toBe('job-plan-new');
    expect(planSubmit).toHaveBeenCalledTimes(1);
    expect(submittedKinds().at(-1)).not.toBe('ask_project');
    planSubmit.mockRestore();
  });
});

// ═══ THE PLANNER'S MID-RUN PAUSE DOOR ════════════════════════════════════════

describe('a re-plan pause — the START OVER offer (cases 11–14)', () => {
  it('11. is recorded against the forwarded turns, idempotently, and read back by both doors', async () => {
    await bootRun();
    const { entryId } = await forwardChange('also add a work item for Y');

    const first = await recordPause({ changeTurnIds: [entryId], idempotencyKey: 'pk-a' });

    expect(first.res.status).toBe(200);
    expect(first.body.outcome).toBe('recorded');
    expect(first.body.pause).toMatchObject({
      kind: 'replan',
      jobId: RUN_JOB,
      changeTurnIds: [entryId],
      answer: null,
      delivery: 'pending',
    });
    const again = await recordPause({ changeTurnIds: [entryId], idempotencyKey: 'pk-a' });
    expect(again.body).toMatchObject({ outcome: 'recorded', pause: { id: first.body.pause.id } });
    const other = await recordPause({ changeTurnIds: [entryId], idempotencyKey: 'pk-b' });
    expect(other.body).toMatchObject({
      outcome: 'already_open',
      pause: { id: first.body.pause.id },
    });
    expect(await pauseRows()).toHaveLength(1);

    const viaGet = await readPause();
    expect(viaGet).toMatchObject({ id: first.body.pause.id, answer: null, delivery: 'pending' });
    const viaDto = (await planChangeSessionsService.getById(ctx, sessionId)).runPause;
    expect(viaDto).toMatchObject({ id: first.body.pause.id, answer: null, delivery: 'pending' });
    expect(viaDto).toEqual(viaGet);
  });

  it('11. a request without a valid job token is refused and writes no row', async () => {
    await bootRun();
    const { entryId } = await forwardChange('also add a work item for Y');

    const res = await recordPauseDoor(
      doorReq(
        {
          jobId: RUN_JOB,
          kind: 'replan',
          changeTurnIds: [entryId],
          reason: 'because',
          idempotencyKey: 'pk-x',
        },
        false,
      ),
    );

    expect(res.status).toBe(401);
    expect(await pauseRows()).toHaveLength(0);
  });

  it('12. YES is the shipped START OVER turn: one restart entry, the same delivery shape as a typed one, no new run', async () => {
    await bootRun();
    const { entryId, turnId } = await forwardChange('also add a work item for Y');
    const { body: recorded } = await recordPause({
      changeTurnIds: [entryId],
      reason: 'REASON-SENTINEL-123',
    });
    const before = (await entries()).length;
    const planSubmit = vi.spyOn(planChangeSessionsService, 'submit');
    const restart = vi.spyOn(planChangeSessionsService, 'restart');
    submitJobMock.mockClear();

    const { res, body } = await answerPause({ pauseId: recorded.pause.id, choice: 'start_over' });

    expect(res.status).toBe(200);
    expect(body.outcome).toBe('answered');
    const written = (await entries()).slice(before);
    expect(written).toHaveLength(1);
    const forwardedBody = (await thread()).find((t) => t.id === turnId)!.body;
    expect(written[0]).toMatchObject({
      kind: 'turn',
      disposition: 'restart',
      restartTarget: null,
      body: forwardedBody,
      declinesPauseId: null,
      answersPauseId: null,
    });
    expect(body.pause).toMatchObject({ answer: 'start_over', delivery: 'delivered' });
    const row = await adminDb.planChangeRunPause.findUniqueOrThrow({
      where: { id: recorded.pause.id },
    });
    expect(row).toMatchObject({
      answer: 'start_over',
      mailboxEntryId: written[0]!.id,
    });

    // The person-typed START OVER through the shipped mailbox route, beside it.
    const typed = await mailboxRoute(
      req('/api/ai/plan-change/session/mailbox', 'POST', {
        sessionId,
        jobId: RUN_JOB,
        body: 'start over please',
        idempotencyKey: 'typed-restart',
        disposition: 'restart',
      }),
    );
    expect(typed.status).toBe(200);
    const typedEntry = (await entries()).find((e) => e.idempotencyKey === 'typed-restart')!;

    const delivery = await planChangeMailboxService.readForBoundary(RUN_JOB, ctx);
    const viaPause = delivery.turns.find((t) => t.id === written[0]!.id)!;
    const viaTyped = delivery.turns.find((t) => t.id === typedEntry.id)!;
    expect(viaPause.disposition).toBe('restart');
    expect(Object.keys(viaPause).sort()).toEqual(Object.keys(viaTyped).sort());
    expect(Object.keys(viaPause)).not.toContain('declinesPause');
    expect(Object.keys(viaPause)).not.toContain('answersQuestion');

    // The planner's reason is shown to the person and never sent back.
    for (const e of await entries()) expect(e.body ?? '').not.toContain('REASON-SENTINEL');
    expect(planSubmit).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
    planSubmit.mockRestore();
    restart.mockRestore();
  });

  it('13. NO is a decline fold turn through attachTurn: the fixed instruction then the change verbatim', async () => {
    await bootRun();
    const { entryId, turnId } = await forwardChange('also add a work item for Y');
    const { body: recorded } = await recordPause({
      changeTurnIds: [entryId],
      reason: 'REASON-SENTINEL-456',
    });
    const before = (await entries()).length;
    submitJobMock.mockClear();

    const { res, body } = await answerPause({ pauseId: recorded.pause.id, choice: 'apply' });

    expect(res.status).toBe(200);
    expect(body.pause).toMatchObject({ answer: 'apply', delivery: 'delivered' });
    const written = (await entries()).slice(before);
    expect(written).toHaveLength(1);
    const forwardedBody = (await thread()).find((t) => t.id === turnId)!.body;
    expect(written[0]).toMatchObject({
      disposition: 'fold',
      declinesPauseId: recorded.pause.id,
      answersPauseId: null,
      body: `${PAUSE_DECLINE_INSTRUCTION}\n\n${forwardedBody}`,
    });
    const delivery = await planChangeMailboxService.readForBoundary(RUN_JOB, ctx);
    const decline = delivery.turns.find((t) => t.id === written[0]!.id)!;
    expect(decline).toMatchObject({ declinesPause: recorded.pause.id });
    expect(Object.keys(decline)).not.toContain('answersQuestion');
    // A plain forwarded turn (case 2’s shape) still delivers with NEITHER key.
    const plain = delivery.turns.find((t) => t.id === entryId)!;
    expect(Object.keys(plain)).not.toContain('declinesPause');
    expect(Object.keys(plain)).not.toContain('answersQuestion');
    for (const e of await entries()) expect(e.body ?? '').not.toContain('REASON-SENTINEL');
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  describe('14. refusals keep the person’s choice', () => {
    async function openPause() {
      await bootRun();
      const { entryId } = await forwardChange('also add a work item for Y');
      const { body } = await recordPause({ changeTurnIds: [entryId] });
      return { entryId, pauseId: body.pause.id as string };
    }

    it('an answer after the run ended is recorded, writes no entry, and returns the typed refusal', async () => {
      const { pauseId } = await openPause();
      setJob('succeeded');
      const before = (await entries()).length;

      const { res, body } = await answerPause({ pauseId, choice: 'apply' });

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        outcome: 'refused',
        code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
        jobStatus: 'succeeded',
        choice: 'apply',
      });
      expect((await entries()).length).toBe(before);
      expect(await pauseRows()).toHaveLength(1);
      expect(await readPause()).toMatchObject({
        answer: 'apply',
        delivery: 'refused',
        refusedCode: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      });
    });

    it('a replay writes no second entry; the opposite choice is a 409 carrying the stored answer', async () => {
      const { pauseId } = await openPause();
      const first = await answerPause({ pauseId, choice: 'apply' });
      expect(first.res.status).toBe(200);
      const count = (await entries()).length;

      const replay = await answerPause({ pauseId, choice: 'apply' });
      expect(replay.res.status).toBe(200);
      expect(replay.body).toMatchObject({ outcome: 'answered', pause: { id: pauseId } });
      expect((await entries()).length).toBe(count);

      const opposite = await answerPause({ pauseId, choice: 'start_over' });
      expect(opposite.res.status).toBe(409);
      expect(opposite.body).toMatchObject({
        code: 'PLAN_CHANGE_RUN_PAUSE_ANSWERED',
        answer: 'apply',
      });
      expect((await entries()).length).toBe(count);
    });

    it('two concurrent opposite answers produce one mailbox entry and one recorded answer', async () => {
      const { pauseId } = await openPause();
      const before = (await entries()).length;

      const [a, b] = await Promise.all([
        answerPause({ pauseId, choice: 'start_over' }),
        answerPause({ pauseId, choice: 'apply' }),
      ]);

      expect([a.res.status, b.res.status].sort()).toEqual([200, 409]);
      const winner = a.res.status === 200 ? 'start_over' : 'apply';
      expect((await entries()).length - before).toBe(1);
      const row = await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pauseId } });
      expect(row.answer).toBe(winner);
      expect(await pauseRows()).toHaveLength(1);
    });

    it('recording into an ended run, a decided plan or another session’s turn is a 409 and writes no row', async () => {
      await bootRun();
      const { entryId } = await forwardChange('also add a work item for Y');

      setJob('succeeded');
      const ended = await recordPause({ changeTurnIds: [entryId] });
      expect(ended.res.status).toBe(409);
      expect(ended.body.code).toBe('PLAN_CHANGE_JOB_NOT_RUNNING');

      setJob('running');
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });
      const decided = await recordPause({ changeTurnIds: [entryId] });
      expect(decided.res.status).toBe(409);
      expect(decided.body.code).toBe('PLAN_CHANGE_RUN_PAUSE_PLAN_DECIDED');

      await adminDb.plan.update({ where: { id: planId }, data: { status: 'generating' } });
      const { entry: foreign } = await foreignRun();
      const mismatch = await recordPause({ changeTurnIds: [foreign.id] });
      expect(mismatch.res.status).toBe(409);
      expect(mismatch.body.code).toBe('PLAN_CHANGE_RUN_PAUSE_TURN_MISMATCH');

      expect(await pauseRows()).toHaveLength(0);
    });

    it('a pause of another session, or a session that is not the job’s thread, is a 404 before any write', async () => {
      const { pauseId } = await openPause();
      const { session: other } = await foreignRun();
      const before = (await entries()).length;

      const wrongPause = await answerPauseRoute(
        req('/api/ai/plan-change/session/run-pause', 'POST', {
          sessionId: other.id,
          jobId: 'job-other',
          pauseId,
          choice: 'apply',
        }),
      );
      const wrongThread = await answerPauseRoute(
        req('/api/ai/plan-change/session/run-pause', 'POST', {
          sessionId: other.id,
          jobId: RUN_JOB,
          pauseId,
          choice: 'apply',
        }),
      );

      expect(wrongPause.status).toBe(404);
      expect(wrongThread.status).toBe(404);
      expect((await entries()).length).toBe(before);
      expect(
        (await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pauseId } })).answer,
      ).toBeNull();
    });
  });
});

describe('an unclear pause — the planner’s question and the reply (cases 15–17)', () => {
  async function unclearPause(question = 'Which part should change?') {
    await bootRun();
    const forwarded = await forwardChange('make it better');
    const { res, body } = await recordPause({
      kind: 'unclear',
      reason: undefined,
      question,
      changeTurnIds: [forwarded.entryId],
    });
    expect(res.status).toBe(200);
    return { ...forwarded, pauseId: body.pause.id as string };
  }

  it('15. the question appears in the thread through runPause, and never as the end-of-job question', async () => {
    const { entryId, pauseId } = await unclearPause();
    submitJobMock.mockClear();

    const viaGet = await readPause();
    const viaDto = (await planChangeSessionsService.getById(ctx, sessionId)).runPause;
    for (const read of [viaGet, viaDto]) {
      expect(read).toMatchObject({
        id: pauseId,
        kind: 'unclear',
        question: 'Which part should change?',
        reason: null,
        answer: null,
        delivery: 'pending',
        changeTurnIds: [entryId],
      });
    }

    // NOT the shipped end-of-job question: no turn carries one, so the answer bar
    // (whose send would open a second run) never has a question to answer.
    const turns = await thread();
    expect(turns.filter((t) => t.question)).toEqual([]);
    expect(pendingQuestion(turns)).toBeNull();
    expect(submitJobMock).not.toHaveBeenCalled();

    // While it is open, a re-plan record with a different key sees THIS pause.
    const other = await recordPause({ changeTurnIds: [entryId] });
    expect(other.body).toMatchObject({ outcome: 'already_open', pause: { id: pauseId } });
    expect(other.body.pause.kind).toBe('unclear');

    // Shape refusals write no row.
    const rows = (await pauseRows()).length;
    const noQuestion = await recordPause({
      kind: 'unclear',
      reason: undefined,
      question: undefined,
      changeTurnIds: [entryId],
    });
    const reasonInstead = await recordPause({
      kind: 'unclear',
      reason: 'a reason, not a question',
      question: undefined,
      changeTurnIds: [entryId],
    });
    expect(noQuestion.res.status).toBe(400);
    expect(reasonInstead.res.status).toBe(400);
    expect((await pauseRows()).length).toBe(rows);
  });

  it('16. the reply is forwarded to the RUNNING planner as the change — no second run', async () => {
    const { entryId, pauseId } = await unclearPause('QUESTION-SENTINEL which part?');
    const before = (await entries()).length;
    const planSubmit = vi.spyOn(planChangeSessionsService, 'submit');
    submitJobMock.mockClear();

    const { res, body } = await answerPause({
      pauseId,
      choice: 'reply',
      text: 'split the settings work item into profile and billing',
    });

    expect(res.status).toBe(200);
    expect(body.outcome).toBe('answered');
    const written = (await entries()).slice(before);
    expect(written).toHaveLength(1);
    const reply = written[0]!;
    expect(reply).toMatchObject({
      jobId: RUN_JOB,
      disposition: 'fold',
      answersPauseId: pauseId,
      declinesPauseId: null,
      body: 'split the settings work item into profile and billing',
    });
    expect(reply.body).not.toContain('QUESTION-SENTINEL');

    const row = await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pauseId } });
    expect(row).toMatchObject({
      answer: 'replied',
      replyText: 'split the settings work item into profile and billing',
      mailboxEntryId: reply.id,
    });
    expect(body.pause).toMatchObject({ answer: 'replied', delivery: 'delivered' });
    // The rail follows forwarded → queued → read from this one entry id.
    const peeked = await planChangeMailboxService.peek(RUN_JOB, sessionId, ctx);
    expect(peeked.turns.map((t) => t.id)).toContain(row.mailboxEntryId);

    const delivery = await planChangeMailboxService.readForBoundary(RUN_JOB, ctx);
    const delivered = delivery.turns.find((t) => t.id === reply.id)!;
    const plain = delivery.turns.find((t) => t.id === entryId)!;
    expect(delivered).toMatchObject({ answersQuestion: pauseId });
    expect(Object.keys(delivered)).not.toContain('declinesPause');
    expect(
      Object.keys(delivered)
        .filter((k) => k !== 'answersQuestion')
        .sort(),
    ).toEqual(Object.keys(plain).sort());

    // No second run, and the thread is still on the planning job.
    expect(planSubmit).not.toHaveBeenCalled();
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).lastJobId,
    ).toBe(RUN_JOB);
    for (const e of await entries()) expect(e.body ?? '').not.toContain('QUESTION-SENTINEL');

    // The answer can be questioned again: a new unclear pause on the REPLY’s entry.
    const next = await recordPause({
      kind: 'unclear',
      reason: undefined,
      question: 'Profile and billing under which epic?',
      changeTurnIds: [reply.id],
    });
    expect(next.res.status).toBe(200);
    expect(next.body.outcome).toBe('recorded');
    expect(next.body.pause.id).not.toBe(pauseId);
    planSubmit.mockRestore();
  });

  describe('17. reply refusals keep the text', () => {
    it('a reply after the run ended is recorded, writes no entry, and comes back with its text', async () => {
      const { pauseId } = await unclearPause();
      setJob('succeeded');
      const before = (await entries()).length;

      const { res, body } = await answerPause({ pauseId, choice: 'reply', text: 'The new one.' });

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        outcome: 'refused',
        code: 'PLAN_CHANGE_JOB_NOT_RUNNING',
        jobStatus: 'succeeded',
        choice: 'reply',
        text: 'The new one.',
      });
      expect((await entries()).length).toBe(before);
      expect(await readPause()).toMatchObject({
        answer: 'replied',
        replyText: 'The new one.',
        delivery: 'refused',
        refusedCode: 'PLAN_CHANGE_JOB_NOT_RUNNING',
      });
    });

    it('the wrong choice for the kind, or a blank text, is a 400 and writes nothing', async () => {
      const { pauseId, entryId } = await unclearPause();
      const before = (await entries()).length;

      for (const choice of ['start_over', 'apply'] as const) {
        expect((await answerPause({ pauseId, choice })).res.status).toBe(400);
      }
      for (const text of ['   ', undefined]) {
        expect((await answerPause({ pauseId, choice: 'reply', text })).res.status).toBe(400);
      }
      expect((await entries()).length).toBe(before);
      expect((await readPause()).answer).toBeNull();

      // …and `reply` on a re-plan pause.
      await adminDb.planChangeRunPause.deleteMany({ where: { sessionId } });
      const replan = await recordPause({ changeTurnIds: [entryId] });
      const wrong = await answerPause({
        pauseId: replan.body.pause.id,
        choice: 'reply',
        text: 'hello',
      });
      expect(wrong.res.status).toBe(400);
      expect((await entries()).length).toBe(before);
    });

    it('the same reply replayed writes no second entry; a different text is a 409 with the stored answer', async () => {
      const { pauseId } = await unclearPause();
      const first = await answerPause({ pauseId, choice: 'reply', text: 'The new one.' });
      expect(first.res.status).toBe(200);
      const count = (await entries()).length;

      const replay = await answerPause({ pauseId, choice: 'reply', text: 'The new one.' });
      expect(replay.res.status).toBe(200);
      expect(replay.body).toMatchObject({ outcome: 'answered', pause: { id: pauseId } });
      expect((await entries()).length).toBe(count);

      const different = await answerPause({
        pauseId,
        choice: 'reply',
        text: 'Actually the old one.',
      });
      expect(different.res.status).toBe(409);
      expect(different.body).toMatchObject({
        code: 'PLAN_CHANGE_RUN_PAUSE_ANSWERED',
        answer: 'replied',
      });
      expect((await entries()).length).toBe(count);
    });

    it('a reply to another session’s pause is a 404 before any write', async () => {
      const { pauseId } = await unclearPause();
      const { session: other } = await foreignRun();
      const before = (await entries()).length;

      for (const jobId of ['job-other', RUN_JOB]) {
        const res = await answerPauseRoute(
          req('/api/ai/plan-change/session/run-pause', 'POST', {
            sessionId: other.id,
            jobId,
            pauseId,
            choice: 'reply',
            text: 'not yours',
          }),
        );
        expect(res.status).toBe(404);
      }
      expect((await entries()).length).toBe(before);
      expect(
        (await adminDb.planChangeRunPause.findUniqueOrThrow({ where: { id: pauseId } })).answer,
      ).toBeNull();
    });
  });
});

// ═══ THE EDGES THE NUMBERED CASES SIT ON ═════════════════════════════════════
//
// Not a case of their own in the card, but each is a branch of a file the story
// ADDED, and the lane holds those files at the story's floor: how the snapshot names
// a committed card, every way a refusal reaches the person, and every way a door says
// no before it does any work.

describe('the run snapshot names what the plan references', () => {
  it('writes a committed parent, blocker and stub as the keys the answering session reads', async () => {
    await bootRun();
    getPlanReviewMock.mockResolvedValue(
      planReview(
        [
          planReviewItem({
            planItemId: 'pi_1',
            nodeId: 'pi_1',
            title: 'A new story',
            kind: 'story',
            // Under a card that already exists, blocked by one that does, one that
            // is only a stub, and one the review cannot name at all.
            parentNodeId: 'wi_parent',
            blockedByNodeIds: ['wi_blocker', 'wi_stub', 'wi_unknown'],
            blockerStubs: [
              { nodeId: 'wi_stub', identifier: 'PROD-7', title: 'A stub', kind: 'task' },
              { nodeId: 'wi_nokey', identifier: null, title: 'No key yet', kind: 'task' },
            ] as never,
          }),
          planReviewItem({
            planItemId: 'pi_2',
            op: 'modify',
            nodeId: 'wi_blocker',
            identifier: 'PROD-3',
            title: 'Rename checkout',
            kind: 'story',
          }),
        ],
        // No progress yet: the walk has not started a step.
        { id: planId, projectId: fx.projectId, status: 'generating', progress: null },
      ),
    );

    await askMidRun('what is the plan so far?');

    const run = (submitJobMock.mock.calls[0]![2] as { run: Json }).run;
    expect(run.steps).toEqual([]);
    expect(run.proposals[0]).toMatchObject({
      ref: 'planItem:pi_1',
      parentRef: 'wi_parent',
      blockedByRefs: ['PROD-3', 'PROD-7', 'wi_unknown'],
      authored: false,
    });
    expect(run.proposals[1]).toMatchObject({ ref: 'planItem:pi_2', op: 'modify', authored: false });
  });

  it('5. names why a plan could not be read, whatever was thrown', async () => {
    await bootRun();
    const reasons: Array<[unknown, string]> = [
      [Object.assign(new Error('gone'), { code: 'PLAN_NOT_FOUND' }), 'PLAN_NOT_FOUND'],
      [new Error('boom'), 'Error'],
      ['not an error at all', 'UNREADABLE'],
    ];
    for (const [thrown, reason] of reasons) {
      getPlanReviewMock.mockRejectedValueOnce(thrown);
      submitJobMock.mockClear();
      const asked = await askMidRun('how far along?');
      expect(asked.res.status).toBe(200);
      const context = submitJobMock.mock.calls[0]![2] as { run: Json };
      expect(context.run).toEqual({ planId, readable: false, reason });
    }
  });
});

describe('a late change that cannot be revised in still hands the words back', () => {
  it('8. a run that produced no plan is refused PLAN_CHANGE_NO_PLAN with the text', async () => {
    await bootRun({ plan: false });
    const asked = await askMidRun('late idea, kept verbatim');
    setJob('succeeded');

    const settled = await settleAs(asked.jobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'late idea, kept verbatim' },
    });

    expect(settled).toMatchObject({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_NO_PLAN',
      text: 'late idea, kept verbatim',
    });
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(0);
    expect(submittedKinds().filter((k) => k === 'plan')).toEqual([]);
  });

  it('8. motir-ai refusing the revision keeps the text under its own code, and leaves no revision', async () => {
    await bootRun({ planned: true });
    setJob('running');
    const asked = await askMidRun('late idea, kept verbatim');
    setJob('succeeded');
    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('down'));

    const settled = await settleAs(asked.jobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'late idea, kept verbatim' },
    });

    expect(settled).toMatchObject({
      outcome: 'forward_refused',
      code: 'MOTIR_AI_UNAVAILABLE',
      text: 'late idea, kept verbatim',
    });
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(0);
    expect(await revisionStarts()).toHaveLength(0);
  });

  it('7. turns stranded while the run is STILL going come back whole, not revised', async () => {
    await bootRun({ planned: true });
    setJob('running');
    await planChangeMailboxService.attachTurn(
      { jobId: RUN_JOB, sessionId, body: 'one', idempotencyKey: 'k1' },
      ctx,
    );

    const res = await lateChanges(
      req('/api/ai/plan-change/session/late-changes', 'POST', { sessionId, runJobId: RUN_JOB }),
    );

    expect(await readJson(res)).toMatchObject({
      outcome: 'refused',
      code: 'PLAN_CHANGE_RUN_STILL_RUNNING',
      texts: ['one'],
    });
    expect(submittedKinds().filter((k) => k === 'plan')).toEqual([]);
    expect(await revisionStarts()).toHaveLength(0);
  });

  it('7. the ai:generate ceiling is spent BEFORE the claim: a 429 leaves the stranded turn unclaimed', async () => {
    await bootRun({ planned: true });
    setJob('running');
    await planChangeMailboxService.attachTurn(
      { jobId: RUN_JOB, sessionId, body: 'one', idempotencyKey: 'k1' },
      ctx,
    );
    setJob('succeeded');
    const prior = process.env['MOTIR_AI_GENERATE_RATE_LIMIT'];
    const priorWindow = process.env['MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'];
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';
    process.env['MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    try {
      // The refusal depends on the call before it, so both must land in one
      // epoch-aligned window (MOTIR-2648 / MOTIR-3016).
      await waitForWindowBoundary(ALIGNED_WINDOW_MS);
      await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);
      // The one call the ceiling allows is spent on a different, harmless request.
      const spend = await lateChanges(
        req('/api/ai/plan-change/session/late-changes', 'POST', { sessionId }),
      );
      expect(spend.status).toBe(400);

      const limited = await lateChanges(
        req('/api/ai/plan-change/session/late-changes', 'POST', { sessionId, runJobId: RUN_JOB }),
      );

      expect(limited.status).toBe(429);
      expect(
        await adminDb.planChangeMailboxEntry.count({ where: { sessionId, consumedAt: null } }),
      ).toBe(1);
    } finally {
      if (prior === undefined) delete process.env['MOTIR_AI_GENERATE_RATE_LIMIT'];
      else process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = prior;
      if (priorWindow === undefined) delete process.env['MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'];
      else process.env['MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'] = priorWindow;
    }
  });
});

describe('the pause doors refuse before they work', () => {
  const lateReq = (body?: unknown) => req('/api/ai/plan-change/session/late-changes', 'POST', body);
  const pauseGet = (qs: string) => req(`/api/ai/plan-change/session/run-pause${qs}`, 'GET');
  const pausePost = (body?: unknown) => req('/api/ai/plan-change/session/run-pause', 'POST', body);

  it('answers 401 to a caller with no session, on every session door', async () => {
    await bootRun();
    session.current = null;

    for (const res of [
      await lateChanges(lateReq({ sessionId, runJobId: RUN_JOB })),
      await readPauseRoute(pauseGet(`?sessionId=${sessionId}&jobId=${RUN_JOB}`)),
      await answerPauseRoute(
        pausePost({ sessionId, jobId: RUN_JOB, pauseId: 'p', choice: 'apply' }),
      ),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it('answers 404 NO_ACTIVE_PROJECT when the caller has no project, on every session door', async () => {
    await bootRun();
    activeCtx.current = null;

    for (const res of [
      await lateChanges(lateReq({ sessionId, runJobId: RUN_JOB })),
      await readPauseRoute(pauseGet(`?sessionId=${sessionId}&jobId=${RUN_JOB}`)),
      await answerPauseRoute(
        pausePost({ sessionId, jobId: RUN_JOB, pauseId: 'p', choice: 'apply' }),
      ),
    ]) {
      expect(res.status).toBe(404);
      expect(await readJson(res)).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
    }
  });

  it('answers 400 to a body it cannot read, or one that names no session, run or pause', async () => {
    await bootRun();
    const notJson = (path: string) =>
      new Request(`${BASE}${path}`, { method: 'POST', body: 'not json' });

    expect((await lateChanges(notJson('/api/ai/plan-change/session/late-changes'))).status).toBe(
      400,
    );
    expect((await answerPauseRoute(notJson('/api/ai/plan-change/session/run-pause'))).status).toBe(
      400,
    );
    expect((await readPauseRoute(pauseGet(`?jobId=${RUN_JOB}`))).status).toBe(400);
    expect((await readPauseRoute(pauseGet(`?sessionId=${sessionId}`))).status).toBe(400);
    expect((await answerPauseRoute(pausePost({ jobId: RUN_JOB, pauseId: 'p' }))).status).toBe(400);
    expect((await answerPauseRoute(pausePost({ sessionId, pauseId: 'p' }))).status).toBe(400);
    expect((await answerPauseRoute(pausePost({ sessionId, jobId: RUN_JOB }))).status).toBe(400);
    expect(
      (
        await answerPauseRoute(
          pausePost({ sessionId, jobId: RUN_JOB, pauseId: 'p', choice: 'maybe' }),
        )
      ).status,
    ).toBe(400);
  });

  it('maps a caller who may not plan on this project to a refusal, never a 500', async () => {
    await bootRun();
    // A real person with an account and no seat in this workspace.
    const stranger = await createTestUser();
    activeCtx.current = { ...ctx, userId: stranger.id };
    session.current = { user: { id: stranger.id, email: stranger.email, name: 'Stranger' } };

    const read = await readPauseRoute(pauseGet(`?sessionId=${sessionId}&jobId=${RUN_JOB}`));
    const late = await lateChanges(lateReq({ sessionId, runJobId: RUN_JOB }));

    for (const res of [read, late]) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  it('reads null for a run that has not paused yet', async () => {
    await bootRun();
    expect(await readPause()).toBeNull();
  });

  it('reads null for a conversation with no run, and for another run’s pause', async () => {
    await bootRun();
    const idle = await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, createdById: fx.ownerId },
    });

    const noRun = await readPauseRoute(pauseGet(`?sessionId=${idle.id}&jobId=${RUN_JOB}`));
    expect(await readJson(noRun)).toBeNull();

    const { entryId } = await forwardChange('also add a work item for Y');
    await recordPause({ changeTurnIds: [entryId] });
    const elsewhere = await readPauseRoute(pauseGet(`?sessionId=${sessionId}&jobId=job-other`));
    expect(await readJson(elsewhere)).toBeNull();
  });
});

describe('the job-token door refuses a malformed record and says when motir-ai is down', () => {
  it('400s a body it cannot read or that names no job, kind, turn list or key — and writes no row', async () => {
    await bootRun();
    const { entryId } = await forwardChange('also add a work item for Y');
    const good = {
      jobId: RUN_JOB,
      kind: 'replan',
      changeTurnIds: [entryId],
      reason: 'because',
      idempotencyKey: 'pk-x',
    };

    const notJson = await recordPauseDoor(
      new Request(`${BASE}/api/internal/ai/plan-change-run-pause`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': mintJobToken({
            userId: fx.ownerId,
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
          }),
        },
        body: 'not json',
      }),
    );
    expect(notJson.status).toBe(400);
    for (const bad of [
      { ...good, jobId: '' },
      { ...good, kind: 'other' },
      { ...good, changeTurnIds: 'e1' },
      { ...good, idempotencyKey: '' },
    ]) {
      expect((await recordPauseDoor(doorReq(bad))).status).toBe(400);
    }
    expect(await pauseRows()).toHaveLength(0);
  });

  it('refuses every shape of pause the planner could get wrong, writing no row', async () => {
    await bootRun();
    const { entryId } = await forwardChange('also add a work item for Y');
    const shapes: Array<Record<string, unknown>> = [
      { kind: 'replan', reason: undefined },
      { kind: 'replan', reason: 'x'.repeat(501) },
      { kind: 'replan', reason: 'because', question: 'both?' },
      { kind: 'replan', reason: 'because', changeTurnIds: [] },
      { kind: 'unclear', reason: undefined, question: 'x'.repeat(601) },
      { kind: 'unclear', reason: 'both', question: 'a question' },
    ];

    for (const shape of shapes) {
      const { res, body } = await recordPause({ changeTurnIds: [entryId], ...shape });
      expect(res.status).toBe(400);
      expect(body.code).toBe('PLAN_CHANGE_RUN_PAUSE_SHAPE');
    }
    expect(await pauseRows()).toHaveLength(0);
  });

  it('502s when motir-ai cannot say whether the run is still going, writing no row', async () => {
    await bootRun();
    const { entryId } = await forwardChange('also add a work item for Y');
    jobs.set(RUN_JOB, new MotirAiUnavailableError('down'));

    const { res, body } = await recordPause({ changeTurnIds: [entryId] });

    expect(res.status).toBe(502);
    expect(body.code).toBe('MOTIR_AI_UNAVAILABLE');
    expect(await pauseRows()).toHaveLength(0);
  });

  it('refuses a reply over the length cap, writing no entry', async () => {
    await bootRun();
    const forwarded = await forwardChange('make it better');
    const { body } = await recordPause({
      kind: 'unclear',
      reason: undefined,
      question: 'Which part?',
      changeTurnIds: [forwarded.entryId],
    });
    const before = (await entries()).length;

    const { res } = await answerPause({
      pauseId: body.pause.id,
      choice: 'reply',
      text: 'x'.repeat(20_001),
    });

    expect(res.status).toBe(400);
    expect((await entries()).length).toBe(before);
  });
});

describe('the rest of the late-change and pause paths, down to what they do on the unexpected', () => {
  it('7. a turn with no recorded disposition is a fold, and an empty one carries no text', async () => {
    await bootRun({ planned: true });
    // Legacy rows predate the disposition column: no value reads as `fold`.
    for (const [seq, body] of [
      [0, 'a change from before dispositions'],
      [1, null],
    ] as const) {
      await adminDb.planChangeMailboxEntry.create({
        data: {
          workspaceId: fx.workspaceId,
          sessionId,
          jobId: RUN_JOB,
          seq,
          kind: 'turn',
          body,
          disposition: null,
          idempotencyKey: `legacy-${seq}`,
        },
      });
    }
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-rev-1' });

    const res = await lateChanges(
      req('/api/ai/plan-change/session/late-changes', 'POST', { sessionId, runJobId: RUN_JOB }),
    );

    expect(await readJson(res)).toMatchObject({
      outcome: 'revised',
      texts: ['a change from before dispositions'],
    });
    expect(
      await adminDb.planChangeMailboxEntry.count({ where: { sessionId, consumedAt: null } }),
    ).toBe(0);
  });

  it('8. a plan deleted while the late change is being decided is refused as no plan, the text kept', async () => {
    await bootRun({ planned: true });
    setJob('running');
    const asked = await askMidRun('late idea, kept verbatim');
    // The run has ended when the forward is attempted; by the time the revision is
    // about to be submitted — the NEXT time motir-ai is asked — the plan is gone.
    let asks = 0;
    jobs.set(RUN_JOB, async () => {
      asks += 1;
      if (asks > 1) {
        await adminDb.planItem.deleteMany({ where: { planId } });
        await adminDb.plan.delete({ where: { id: planId } });
      }
      return { jobId: RUN_JOB, status: 'succeeded', result: null, error: null };
    });

    const settled = await settleAs(asked.jobId, {
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: { text: 'late idea, kept verbatim' },
    });

    expect(asks).toBeGreaterThan(1);
    expect(settled).toMatchObject({
      outcome: 'forward_refused',
      code: 'PLAN_CHANGE_NO_PLAN',
      text: 'late idea, kept verbatim',
    });
    expect(submittedKinds().filter((k) => k === 'plan')).toEqual([]);
  });

  it('8. a failure nobody anticipated is raised, not worded as a refusal — and nothing is written', async () => {
    await bootRun({ planned: true });
    setJob('running');
    const asked = await askMidRun('late idea, kept verbatim');
    setJob('succeeded');
    jobs.set(asked.jobId, {
      jobId: asked.jobId,
      status: 'succeeded',
      result: {
        ask: { intent: 'plan_change', forward: { text: 'late idea, kept verbatim' } },
      },
      error: null,
    });
    submitJobMock.mockRejectedValueOnce(new Error('an unanticipated failure'));

    await expect(
      settleRoute(req('/api/ai/ask/settle', 'POST', { jobId: asked.jobId, sessionId })),
    ).rejects.toThrow('an unanticipated failure');
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId, kind: 'turn' } })).toBe(
      0,
    );
  });

  it('the late-changes door reads a body of JSON null as one that names nothing', async () => {
    await bootRun();
    const res = await lateChanges(
      new Request(`${BASE}/api/ai/plan-change/session/late-changes`, {
        method: 'POST',
        body: 'null',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('the job-token door reads a body of JSON null as one that names nothing', async () => {
    await bootRun();
    const res = await recordPauseDoor(
      new Request(`${BASE}/api/internal/ai/plan-change-run-pause`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SERVICE_SECRET}`,
          'x-motir-job-token': mintJobToken({
            userId: fx.ownerId,
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
          }),
        },
        body: 'null',
      }),
    );
    expect(res.status).toBe(400);
    expect(await pauseRows()).toHaveLength(0);
  });

  it('14. an answer whose delivery fails unexpectedly is retried, not lost or doubled', async () => {
    await bootRun();
    const { entryId } = await forwardChange('also add a work item for Y');
    const { body: recorded } = await recordPause({ changeTurnIds: [entryId] });
    const before = (await entries()).length;
    // motir-ai cannot be asked whether the run is going while the answer is delivered.
    jobs.set(RUN_JOB, new MotirAiUnavailableError('down'));

    const failed = await answerPause({ pauseId: recorded.pause.id, choice: 'apply' });

    expect(failed.res.status).toBe(502);
    expect((await entries()).length).toBe(before);

    // The same choice again, once motir-ai is back, delivers it exactly once.
    setJob('running');
    const retried = await answerPause({ pauseId: recorded.pause.id, choice: 'apply' });
    expect(retried.res.status).toBe(200);
    expect(retried.body.pause).toMatchObject({ answer: 'apply', delivery: 'delivered' });
    expect((await entries()).length).toBe(before + 1);
    const again = await answerPause({ pauseId: recorded.pause.id, choice: 'apply' });
    expect(again.res.status).toBe(200);
    expect((await entries()).length).toBe(before + 1);
  });
});
