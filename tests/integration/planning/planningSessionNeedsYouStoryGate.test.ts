import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { homeService } from '@/lib/services/homeService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { AWAITING_REPLY_AFTER_MS } from '@/lib/services/planningSessionGateService';
import { workbenchPlanningService } from '@/lib/services/workbenchPlanningService';
import { workItemsService } from '@/lib/services/workItemsService';
import { toHeldBy } from '@/lib/services/contextualPlanningService';
import { planTargetLockSweep } from '@/lib/jobs/definitions/planTargetLockSweep';
import { abandonedPlanSweep } from '@/lib/jobs/definitions/abandonedPlanSweep';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { JobTestEngine } from '../../helpers/jobs';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY GATE — A PLANNING SESSION THAT NEEDS YOU IS NEVER LOST (Story MOTIR-7905 ·
// MOTIR-7919), against a REAL Postgres. Each card proved its own step; this is the CHAIN across
// five writers (the relay's failed-frame settle, the abandoned-plan sweep, the idle close, the
// lease sweep, the resume bind) and three readers (Waiting on you, To resume, Planning): one
// session going failure → To resume → resume → success, or question → Waiting on you → answer,
// with every read, count and sweep seeing the same state at each step.
//
// Exactly two seams are replaced, both inside the vitest process: motir-ai (`submitJob` /
// `getJob`, scripted) and the clock — crossed by BACKDATING the rows a lease, a quiet period or
// an age is measured from, which is the same thing a later `now` reads without sleeping. Nothing
// about motir-ai's own behaviour is asserted: every assertion is on a row core wrote or a read
// core served, under the member's own workspace context. Every spare has an unmarked
// counterfactual in the same run; every owner-scoped read has a second member who sees none.

let jobSeq = 0;
const submitJobMock = vi.fn();
const getJobMock = vi.fn();

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  streamJob: vi.fn(),
  getJob: (...args: unknown[]) => getJobMock(...args),
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

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');

const T = { timeout: 180_000 };
// MEASURED: 20 rounds of truncate + fixture + two racing writers took ~120-170 s on a loaded shard.
const RACE_TEST_TIMEOUT_MS = 300_000;
const ITERATIONS = 20;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

let fx: WorkItemFixture;
let rivalId: string;

beforeEach(async () => {
  await truncateAuthTables();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
  getJobMock.mockReset();
  fx = await makeWorkItemFixture();
  rivalId = await secondMember();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function secondMember(): Promise<string> {
  const user = await createTestUser({ name: 'Rival' });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  return user.id;
}

const ownerPctx = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});
const rivalPctx = (): ProjectContext => ({ ...ownerPctx(), userId: rivalId });
/** A member's OWN workspace context — what every READ assertion runs under. */
const actor = (userId: string = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});
const sctx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function card(title = 'The card') {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

/** The owner's OPEN conversation on a target card, with its session lock and a `generating`
 *  plan of three proposals produced by `jobId` — built the real way, then keyed to the job. */
async function sessionWithPlan(jobId: string, opts: { title?: string } = {}) {
  const c = await card(opts.title);
  const s = await planChangeSessionsService.startWithFirstTurn(
    ownerPctx(),
    buildScope([c.key]),
    'Split it',
  );
  await adminDb.planChangeSession.update({ where: { id: s.id }, data: { lastJobId: jobId } });
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: s.id,
      status: 'generating',
      sourceJobId: jobId,
      createdById: fx.ownerId,
    },
  });
  for (let i = 0; i < 3; i++) {
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: 'add',
        proposedFields: { title: `P${i}`, kind: 'subtask' },
        blockedByRefs: [],
      },
    });
  }
  return { sessionId: s.id, planId: plan.id, card: c };
}

const WALK_STOP = (reasonCode = 'rate_limited') => ({
  phase: 'author' as const,
  target: 'planItem:abc',
  targetTitle: 'Export a report',
  depth: 1,
  planId: null,
  reasonCode,
  detail: 'x',
});
const readJobWith =
  (reasonCode = 'rate_limited') =>
  async () => ({
    error: null,
    walkStop: WALK_STOP(reasonCode),
  });
/** The relay sees the terminal `failed` frame of `jobId`. */
const relayFailure = (jobId: string, reasonCode = 'rate_limited') =>
  planSessionEndService.settleFailedJob(
    jobId,
    sctx(),
    { status: 'failed' },
    { readJob: readJobWith(reasonCode) },
  );

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const locksOf = (sessionId: string) => adminDb.planTargetLock.count({ where: { sessionId } });
const itemsOf = (planId: string) => adminDb.planItem.count({ where: { planId } });
const gatesOf = (sessionId: string) =>
  adminDb.approvalGate.findMany({
    where: { kind: 'planning_session', subjectId: sessionId },
    orderBy: { createdAt: 'asc' },
  });
const awaitingGates = async (sessionId: string) =>
  (await gatesOf(sessionId)).filter((g) => g.state === 'awaiting');
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

// ── the READS, each under a member's own context, each count checked against its list ─────────
async function toResumeOf(userId: string = fx.ownerId) {
  const page = await homeService.listToResume(actor(userId), { limit: 50 });
  expect((await homeService.tabCounts(actor(userId))).toResume).toBe(page.total);
  return page;
}
const inToResume = async (sessionId: string, userId?: string) =>
  (await toResumeOf(userId)).planningSessions?.find((e) => e.sessionId === sessionId);
async function planningOf(userId: string = fx.ownerId) {
  const page = await workbenchPlanningService.listMyPlansBeingWritten(actor(userId), {
    page: 1,
    limit: 50,
  });
  expect((await homeService.tabCounts(actor(userId))).planning).toBe(page.total);
  return page;
}
const inPlanning = async (planId: string, userId?: string) =>
  (await planningOf(userId)).items.some((r) => r.planId === planId);
async function waitingOnYou(userId: string = fx.ownerId) {
  const page = await approvalGatesService.listAwaitingMe(actor(userId));
  expect(await approvalGatesService.countAwaitingMe(actor(userId))).toBe(page.total);
  return page.items.filter((i) => i.kind === 'planning_session');
}
const inWaitingOnYou = async (sessionId: string, userId?: string) =>
  (await waitingOnYou(userId)).find(
    (i) => i.subject?.kind === 'planning_session' && i.subject.sessionId === sessionId,
  );

/** The planner speaks: job `jobId` settles with this utterance and the relay records it. */
async function plannerSpeaks(
  sessionId: string,
  jobId: string,
  message: string,
  question: string | null,
) {
  await adminDb.planChangeSession.update({ where: { id: sessionId }, data: { lastJobId: jobId } });
  getJobMock.mockResolvedValue({
    jobId,
    status: 'succeeded',
    error: null,
    result: { turn: { message, question } },
  });
  return planChangeSessionsService.recordPlannerTurn(jobId, ownerPctx(), { sessionId });
}

/** Cross every lease, quiet period and age the sweeps measure — the clock seam. */
async function ageEverything(sessionId: string, planId?: string, by = 72 * HOUR) {
  const past = new Date(Date.now() - by);
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: past },
  });
  await adminDb.planTargetLock.updateMany({ where: { sessionId }, data: { expiresAt: past } });
  if (planId) await adminDb.plan.update({ where: { id: planId }, data: { createdAt: past } });
}

/** A planner turn WITHOUT a question, written the way the record would, `idleMs` ago. */
async function plannerReplyQuietFor(sessionId: string, idleMs: number) {
  const s = await sessionRow(sessionId);
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId,
      seq: s.turnCount,
      role: 'assistant',
      body: 'Here is what I found.',
    },
  });
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { turnCount: s.turnCount + 1, lastActivityAt: new Date(Date.now() - idleMs) },
  });
}

describe('1 · a failure keeps everything', () => {
  it(
    'records the failure and leaves the session open, the plan generating, every lock held',
    T,
    async () => {
      const f = await sessionWithPlan('job-1');
      expect(await locksOf(f.sessionId)).toBeGreaterThan(0);
      const locksBefore = await locksOf(f.sessionId);

      const out = await relayFailure('job-1');

      expect(out).toEqual({
        settled: 'recorded',
        sessionId: f.sessionId,
        arm: 'session',
        lostMachine: false,
        autoResume: null,
      });
      const s = await sessionRow(f.sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.failureReason).toBe('rate_limited');
      expect(s.failureStopPhase).toBe('author');
      expect(s.failureStopTitle).toBe('Export a report');
      const plan = await planRow(f.planId);
      expect(plan.status).toBe('generating');
      expect(await itemsOf(f.planId)).toBe(3);
      expect(await locksOf(f.sessionId)).toBe(locksBefore);
    },
  );
});

describe('2 · neither sweep ends it', () => {
  it(
    'spares a failed-waiting session past every window — and ends/releases an unmarked one',
    T,
    async () => {
      const failed = await sessionWithPlan('job-1', { title: 'Failed' });
      await relayFailure('job-1');
      const plain = await sessionWithPlan('job-2', { title: 'Plain' });
      // The plain one's plan is DECLINED so the abandoned sweep has nothing to say about it.
      await adminDb.plan.update({ where: { id: plain.planId }, data: { status: 'declined' } });
      for (const s of [failed, plain]) await ageEverything(s.sessionId, s.planId);
      // The abandoned sweep asks motir-ai about job-1: it is terminal-failed.
      getJobMock.mockResolvedValue({
        jobId: 'job-1',
        status: 'failed',
        error: { code: 'MOTIR_AI_UNAVAILABLE' },
      });

      await new JobTestEngine({ function: planTargetLockSweep }).execute();
      await new JobTestEngine({ function: abandonedPlanSweep }).execute();

      // SPARED
      const s = await sessionRow(failed.sessionId);
      expect(s.endedAt).toBeNull();
      expect(sessionWaitingState(s)).toBe('failed');
      expect((await planRow(failed.planId)).status).toBe('generating');
      expect(await locksOf(failed.sessionId)).toBeGreaterThan(0);
      expect(await itemsOf(failed.planId)).toBe(3);
      // COUNTERFACTUAL — the unmarked idle session IS ended, and its expired lease IS released.
      expect((await sessionRow(plain.sessionId)).endedAt).not.toBeNull();
      expect(await locksOf(plain.sessionId)).toBe(0);
    },
  );
});

describe('3 · an unwatched failure is recorded, not discarded', () => {
  it(
    'a failure no relay saw is recorded by the abandoned sweep; the session-less plan still declines',
    T,
    async () => {
      const f = await sessionWithPlan('job-9');
      await ageEverything(f.sessionId, f.planId, 3 * HOUR);
      // Counterfactual: a plan with no session and no proposals, as old.
      const orphan = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          status: 'generating',
          sourceJobId: 'job-orphan',
          createdById: fx.ownerId,
          createdAt: new Date(Date.now() - 72 * HOUR),
        },
      });
      // A JUDGED failure: a `model_unavailable` one is resumed by itself since MOTIR-10968.
      getJobMock.mockImplementation(async (jobId: string) => ({
        jobId,
        status: 'failed',
        error: { code: 'MOTIR_AI_JOB_FAILED', message: 'the planner model returned an error' },
      }));

      await new JobTestEngine({ function: abandonedPlanSweep }).execute();

      const s = await sessionRow(f.sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.failedAt).not.toBeNull();
      expect((await planRow(f.planId)).status).toBe('generating');
      expect(await itemsOf(f.planId)).toBe(3);
      expect((await planRow(orphan.id)).status).toBe('declined');
    },
  );
});

describe('4 · the other member is refused', () => {
  it('names the owner, says the session waits, and does not reclaim the lock', T, async () => {
    const f = await sessionWithPlan('job-1');
    await relayFailure('job-1');
    await ageEverything(f.sessionId); // the lease is long gone: only the waiting spares the hold

    const held = await planTargetLockService.readForeignHoldForScope([f.card.key], rivalPctx());
    expect(held).toBeInstanceOf(PlanTargetLockedError);
    expect(held!.sessionWaiting).toBe(true);
    expect(held!.holderSessionId).toBe(f.sessionId);
    expect(toHeldBy(held!)).toMatchObject({
      sessionWaiting: true,
      waitingCause: 'failed',
      freesBy: null,
    });
    expect(await locksOf(f.sessionId)).toBeGreaterThan(0);
  });
});

describe('5 · To resume and Planning, read and counted', () => {
  it('lists the failure for its owner only, and takes its plan out of Planning', T, async () => {
    const f = await sessionWithPlan('job-1');
    // A healthy generating plan of the owner's, which Planning must keep listing.
    const healthy = await sessionWithPlan('job-h', { title: 'Healthy' });
    expect(await inPlanning(f.planId)).toBe(true);

    await relayFailure('job-1');

    const entry = await inToResume(f.sessionId);
    expect(entry).toMatchObject({
      sessionId: f.sessionId,
      form: 'failed_walk',
      planId: f.planId,
      failure: { reason: 'rate_limited', stopPhase: 'author', stopTitle: 'Export a report' },
    });
    expect(await inPlanning(f.planId)).toBe(false);
    expect(await inPlanning(healthy.planId)).toBe(true);
    // The SECOND member sees none of it, and their count does not include it.
    expect(await inToResume(f.sessionId, rivalId)).toBeUndefined();
    expect((await toResumeOf(rivalId)).total).toBe(0);
    expect((await toResumeOf()).total).toBe(1);
  });
});

describe('6 · resume on the same plan, and 7 · a second failure returns it', () => {
  it(
    're-binds the same plan, drops the entry, then returns it with the NEW reason',
    T,
    async () => {
      const f = await sessionWithPlan('job-1');
      await relayFailure('job-1');
      const lockBefore = await adminDb.planTargetLock.findFirstOrThrow({
        where: { sessionId: f.sessionId },
      });

      const out = await planSessionResumeService.resume(ownerPctx(), f.sessionId);

      expect(out).toMatchObject({ jobId: 'job-new-1', planId: f.planId });
      const plan = await planRow(f.planId);
      expect(plan.sourceJobId).toBe('job-new-1');
      expect(await itemsOf(f.planId)).toBe(3);
      const s = await sessionRow(f.sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.lastJobId).toBe('job-new-1');
      expect([s.failedAt, s.failedJobId, s.failureReason].every((v) => v === null)).toBe(true);
      const lockAfter = await adminDb.planTargetLock.findFirstOrThrow({
        where: { sessionId: f.sessionId },
      });
      expect(lockAfter.expiresAt.getTime()).toBeGreaterThanOrEqual(lockBefore.expiresAt.getTime());
      // …and every read agrees: out of To resume, back in Planning.
      expect(await inToResume(f.sessionId)).toBeUndefined();
      expect(await inPlanning(f.planId)).toBe(true);

      // 7 · it fails again, for a NEW reason
      await relayFailure('job-new-1', 'out_of_credits');
      expect((await inToResume(f.sessionId))?.failure?.reason).toBe('out_of_credits');
      expect(await inPlanning(f.planId)).toBe(false);
      // …and a late failed frame for the OLD job writes nothing.
      expect(
        await planSessionEndService.settleFailedJob('job-1', sctx(), { status: 'failed' }),
      ).toBeNull();
      expect((await sessionRow(f.sessionId)).failedJobId).toBe('job-new-1');
    },
  );

  it('a resumed attempt that succeeds leaves it in neither tab', T, async () => {
    const f = await sessionWithPlan('job-1');
    await relayFailure('job-1');
    await planSessionResumeService.resume(ownerPctx(), f.sessionId);
    // The new job succeeds and the plan reaches `planned`.
    await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'planned' } });
    expect(await inToResume(f.sessionId)).toBeUndefined();
    expect(await inPlanning(f.planId)).toBe(false);
  });
});

describe('8 · the question cause', () => {
  it(
    'raises one gate for the owner only, spares it from the idle close, and clears on the answer',
    T,
    async () => {
      const f = await sessionWithPlan('job-q0');
      await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });

      await plannerSpeaks(f.sessionId, 'job-q', 'Before I split it —', 'Which team owns this?');

      expect(await awaitingGates(f.sessionId)).toHaveLength(1);
      const row = await inWaitingOnYou(f.sessionId);
      expect(row?.subject).toMatchObject({ cause: 'question', question: 'Which team owns this?' });
      expect(await inWaitingOnYou(f.sessionId, rivalId)).toBeUndefined();
      // The idle close does not end it, even long idle (counterfactual: a plain idle one is).
      const plain = await sessionWithPlan('job-p', { title: 'Plain' });
      await adminDb.plan.update({ where: { id: plain.planId }, data: { status: 'declined' } });
      await ageEverything(f.sessionId);
      await ageEverything(plain.sessionId);
      await new JobTestEngine({ function: planTargetLockSweep }).execute();
      expect((await sessionRow(f.sessionId)).endedAt).toBeNull();
      expect((await sessionRow(plain.sessionId)).endedAt).not.toBeNull();

      await planChangeSessionsService.appendTurn('The platform team.', ownerPctx(), {
        sessionId: f.sessionId,
      });

      const s = await sessionRow(f.sessionId);
      expect(s.awaitingPersonSince).toBeNull();
      expect((await gatesOf(f.sessionId)).map((g) => [g.state, g.supersededCause])).toEqual([
        ['superseded', 'answered'],
      ]);
      expect(await inWaitingOnYou(f.sessionId)).toBeUndefined();
    },
  );
});

describe('9 · the reply cause', () => {
  it(
    'is raised by the lock sweep, NOT ended in that same sweep, and a turn clears it',
    T,
    async () => {
      const f = await sessionWithPlan('job-r0');
      await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });
      await plannerReplyQuietFor(f.sessionId, AWAITING_REPLY_AFTER_MS + 30 * MIN);
      await adminDb.planTargetLock.updateMany({
        where: { sessionId: f.sessionId },
        data: { expiresAt: new Date(Date.now() - HOUR) },
      });

      await new JobTestEngine({ function: planTargetLockSweep }).execute();

      const s = await sessionRow(f.sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.awaitingPersonCause).toBe('reply');
      expect((await inWaitingOnYou(f.sessionId))?.subject).toMatchObject({ cause: 'reply' });
      expect(await inWaitingOnYou(f.sessionId, rivalId)).toBeUndefined();

      await planChangeSessionsService.appendTurn('Thanks, go on.', ownerPctx(), {
        sessionId: f.sessionId,
      });
      expect(await inWaitingOnYou(f.sessionId)).toBeUndefined();
      expect((await sessionRow(f.sessionId)).awaitingPersonCause).toBeNull();
    },
  );
});

describe('10 · a person’s end clears either row', () => {
  it.each(['question', 'failed'] as const)(
    'ending a %s-waiting session as restarted',
    T,
    async (cause) => {
      const f = await sessionWithPlan('job-1');
      if (cause === 'question') {
        await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });
        await plannerSpeaks(f.sessionId, 'job-q', 'Hmm —', 'Which?');
        expect(await inWaitingOnYou(f.sessionId)).toBeTruthy();
      } else {
        await relayFailure('job-1');
        expect(await inToResume(f.sessionId)).toBeTruthy();
      }

      await planSessionEndService.endSession(f.sessionId, 'restarted', {
        workspaceId: fx.workspaceId,
        endedById: fx.ownerId,
      });

      expect((await gatesOf(f.sessionId)).filter((g) => g.state === 'awaiting')).toHaveLength(0);
      expect(await inWaitingOnYou(f.sessionId)).toBeUndefined();
      expect(await inToResume(f.sessionId)).toBeUndefined();
      expect(await locksOf(f.sessionId)).toBe(0);
      expect(await statusOf(f.card.id)).toBe('in_progress');
    },
  );
});

describe('11 · a wait that turns into a failure moves tabs', () => {
  it('leaves Waiting on you and appears in To resume, with no stale gate row', T, async () => {
    const f = await sessionWithPlan('job-1');
    await plannerSpeaks(f.sessionId, 'job-1', 'Hmm —', 'Which?');
    await adminDb.planChangeSession.update({
      where: { id: f.sessionId },
      data: { lastJobId: 'job-1' },
    });
    expect(await inWaitingOnYou(f.sessionId)).toBeTruthy();

    await relayFailure('job-1');

    expect(await inWaitingOnYou(f.sessionId)).toBeUndefined();
    expect(await inToResume(f.sessionId)).toBeTruthy();
    expect(await awaitingGates(f.sessionId)).toHaveLength(0);
  });
});

describe('12 · never in either tab', () => {
  it(
    'a guide session, an MCP plan, decided plans and a person-ended session appear in neither',
    T,
    async () => {
      const guide = await sessionWithPlan('job-g', { title: 'Guide' });
      await adminDb.planChangeSession.update({
        where: { id: guide.sessionId },
        data: { origin: 'guide' },
      });
      await relayFailure('job-g').catch(() => null);
      const mcp = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          status: 'generating',
          createdById: fx.ownerId,
          authorSource: 'mcp',
        },
      });
      const done = await sessionWithPlan('job-d', { title: 'Approved' });
      await adminDb.plan.update({ where: { id: done.planId }, data: { status: 'approved' } });
      await relayFailure('job-d').catch(() => null);
      const ended = await sessionWithPlan('job-e', { title: 'Ended' });
      await planSessionEndService.endSession(ended.sessionId, 'restarted', {
        workspaceId: fx.workspaceId,
        endedById: fx.ownerId,
      });

      for (const userId of [fx.ownerId, rivalId]) {
        const resume = await toResumeOf(userId);
        const planning = (await waitingOnYou(userId)).map((r) => r.subject);
        for (const id of [guide.sessionId, done.sessionId, ended.sessionId]) {
          expect(resume.planningSessions?.some((e) => e.sessionId === id) ?? false).toBe(false);
          expect(planning.some((s) => s?.kind === 'planning_session' && s.sessionId === id)).toBe(
            false,
          );
        }
        expect(resume.planningSessions?.some((e) => e.planId === mcp.id) ?? false).toBe(false);
      }
    },
  );
});

describe('13 · concurrency across the chain', () => {
  it(
    `the relay's settle against the abandoned sweep, ${ITERATIONS} times: one failure record`,
    { timeout: RACE_TEST_TIMEOUT_MS },
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const f = await sessionWithPlan('job-r');
        await ageEverything(f.sessionId, f.planId, 3 * HOUR);
        // A JUDGED failure, so neither recorder resumes it (MOTIR-10968 resumes a
        // `model_unavailable` one): the race is about the one record.
        getJobMock.mockResolvedValue({
          jobId: 'job-r',
          status: 'failed',
          error: { code: 'MOTIR_AI_JOB_FAILED' },
        });

        const results = await Promise.allSettled([
          relayFailure('job-r'),
          new JobTestEngine({ function: abandonedPlanSweep }).execute(),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const s = await sessionRow(f.sessionId);
        expect(s.endedAt).toBeNull();
        expect(s.failedJobId).toBe('job-r');
        expect((await planRow(f.planId)).status).toBe('generating');
        expect(await locksOf(f.sessionId)).toBeGreaterThan(0);
      }
    },
  );

  it(
    `Resume against a person's end, ${ITERATIONS} times: ended with no failure, or open and bound — never both`,
    { timeout: RACE_TEST_TIMEOUT_MS },
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
        const f = await sessionWithPlan('job-r');
        await relayFailure('job-r');

        const results = await Promise.allSettled([
          planSessionResumeService.resume(ownerPctx(), f.sessionId),
          planSessionEndService.endSession(f.sessionId, 'restarted', {
            workspaceId: fx.workspaceId,
            endedById: fx.ownerId,
          }),
        ]);

        // A refusal (the session ended first) is a legal outcome of the loser; nothing else is.
        for (const r of results) {
          if (r.status === 'rejected') {
            expect((r.reason as Error).constructor.name).toMatch(
              /SessionEnded|NotFailed|NotResumable|AlreadyStarted/,
            );
          }
        }
        const s = await sessionRow(f.sessionId);
        if (s.endedAt) {
          expect(s.failedAt).toBeNull();
          expect(await locksOf(f.sessionId)).toBe(0);
        } else {
          expect(s.failedAt).toBeNull();
          expect(s.lastJobId).toMatch(/^job-new-/);
          expect(await locksOf(f.sessionId)).toBeGreaterThan(0);
        }
      }
    },
  );

  it(
    `the owner's turn against the awaiting-reply sweep, ${ITERATIONS} times: one gate or none`,
    { timeout: RACE_TEST_TIMEOUT_MS },
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const f = await sessionWithPlan('job-r');
        await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });
        await plannerReplyQuietFor(f.sessionId, AWAITING_REPLY_AFTER_MS + 30 * MIN);

        const results = await Promise.allSettled([
          planChangeSessionsService.appendTurn('Go on.', ownerPctx(), { sessionId: f.sessionId }),
          new JobTestEngine({ function: planTargetLockSweep }).execute(),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const s = await sessionRow(f.sessionId);
        const awaiting = await awaitingGates(f.sessionId);
        if (s.awaitingPersonSince) expect(awaiting).toHaveLength(1);
        else expect(awaiting).toHaveLength(0);
      }
    },
  );
});

describe('14 · a mark that loses the race raises nothing', () => {
  it(
    'a question whose mark is refused (the session just failed) leaves no gate behind',
    T,
    async () => {
      const { planChangeSessionRepository } =
        await import('@/lib/repositories/planChangeSessionRepository');
      const f = await sessionWithPlan('job-q');
      await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });
      const spy = vi
        .spyOn(planChangeSessionRepository, 'markAwaitingPerson')
        .mockResolvedValueOnce(false);

      await plannerSpeaks(f.sessionId, 'job-q', 'Hmm —', 'Which?');

      spy.mockRestore();
      expect(await gatesOf(f.sessionId)).toHaveLength(0);
      expect((await sessionRow(f.sessionId)).awaitingPersonSince).toBeNull();
    },
  );
});

describe('15 · a wait that changes cause, and a sweep that loses the lock', () => {
  it(
    'a question on a conversation already waiting for a reply keeps the original `since` and one gate',
    T,
    async () => {
      const f = await sessionWithPlan('job-0');
      await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });
      await plannerReplyQuietFor(f.sessionId, AWAITING_REPLY_AFTER_MS + 30 * MIN);
      await new JobTestEngine({ function: planTargetLockSweep }).execute();
      const before = await sessionRow(f.sessionId);
      expect(before.awaitingPersonCause).toBe('reply');

      await plannerSpeaks(f.sessionId, 'job-q', 'Actually —', 'Which team?');

      const after = await sessionRow(f.sessionId);
      expect(after.awaitingPersonCause).toBe('question');
      expect(after.awaitingPersonSince).toEqual(before.awaitingPersonSince);
      expect(await awaitingGates(f.sessionId)).toHaveLength(1);
    },
  );

  it('the reply pass skips a session whose lock it cannot take', T, async () => {
    const { planChangeSessionRepository } =
      await import('@/lib/repositories/planChangeSessionRepository');
    const f = await sessionWithPlan('job-0');
    await adminDb.plan.update({ where: { id: f.planId }, data: { status: 'declined' } });
    await plannerReplyQuietFor(f.sessionId, AWAITING_REPLY_AFTER_MS + 30 * MIN);
    const spy = vi
      .spyOn(planChangeSessionRepository, 'lockById')
      .mockResolvedValueOnce(false as never);

    const { planningSessionGateService } =
      await import('@/lib/services/planningSessionGateService');
    const out = await planningSessionGateService.raiseAwaitingReplies();

    spy.mockRestore();
    expect(out.raised).toBe(0);
    expect(await gatesOf(f.sessionId)).toHaveLength(0);
  });
});
