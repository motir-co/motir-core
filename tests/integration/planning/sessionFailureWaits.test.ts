import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import { PLANNING_STATUS_KEY, PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { toHeldBy } from '@/lib/services/contextualPlanningService';
import type { PlanSessionOrigin, PlanStatus } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A FAILED HOSTED ATTEMPT KEEPS ITS SESSION (Story MOTIR-7905 · MOTIR-7912) —
// against a REAL Postgres. `agent-authored-plans.md` AMENDMENT 23's 2026-10-09
// sub-amendment: the relay and the abandoned-plan sweep RECORD a failure instead of
// ending the session; the plan stays `generating` with its proposals; the cards stay
// held; neither the idle close nor the lease sweep gives a waiting session back; and
// another member is refused with the reason it waits. Counterfactuals are in the
// same file: a canceled job, a `guide` session and a plan that is not `generating`
// still end exactly as before.

const T = { timeout: 60_000 };
const HOUR = 60 * 60 * 1000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const pctx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function seedCard(): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function openSession(
  card: { key: string },
  opts: { lastJobId?: string; origin?: PlanSessionOrigin; idleMs?: number } = {},
): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      scopeKey: card.key,
      targetKeys: [card.key],
      lastJobId: opts.lastJobId ?? null,
      origin: opts.origin ?? 'conversation',
    },
  });
  await planTargetLockService.acquireForScope(session.id, [card.key], pctx());
  if (opts.idleMs) {
    await adminDb.planChangeSession.update({
      where: { id: session.id },
      data: { lastActivityAt: new Date(Date.now() - opts.idleMs) },
    });
  }
  return session.id;
}

/** A plan in the session with `proposals` proposals, `ageHours` old — and silent for
 *  as long: its `lastActivityAt` is its `createdAt` (MOTIR-8132). */
async function planIn(
  sessionId: string,
  opts: { status?: PlanStatus; proposals?: number; ageHours?: number; sourceJobId?: string } = {},
) {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status: opts.status ?? 'generating',
      sourceJobId: opts.sourceJobId ?? null,
      createdAt: new Date(Date.now() - (opts.ageHours ?? 0) * HOUR),
      lastActivityAt: new Date(Date.now() - (opts.ageHours ?? 0) * HOUR),
    },
  });
  for (let i = 0; i < (opts.proposals ?? 0); i++) {
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: 'add',
        proposedFields: { title: `Proposed ${i}`, kind: 'subtask' },
        blockedByRefs: [],
      },
    });
  }
  return plan;
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const locksOf = (sessionId: string) => adminDb.planTargetLock.count({ where: { sessionId } });

const WALK_STOP = {
  phase: 'author' as const,
  target: 'planItem:abc',
  targetTitle: 'Export a report',
  depth: 1,
  planId: null,
  reasonCode: 'rate_limited',
  detail: 'slow down',
};
const readJobWith = (walkStop: typeof WALK_STOP | null, code?: string) => async () => ({
  error: code ? { code, message: `${code} happened` } : null,
  walkStop,
});

describe('the relay — a failed attempt is RECORDED, not ended', () => {
  it('keeps the session open, records the failure and leaves plan and cards alone', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card, { lastJobId: 'job-1' });
    const plan = await planIn(sessionId, { proposals: 3, sourceJobId: 'job-1' });

    const out = await planSessionEndService.settleFailedJob(
      'job-1',
      pctx(),
      { status: 'failed' },
      { readJob: readJobWith(WALK_STOP) },
    );

    expect(out).toEqual({
      settled: 'recorded',
      sessionId,
      arm: 'session',
      lostMachine: false,
      autoResume: null,
    });
    const s = await sessionRow(sessionId);
    expect(s.endedAt).toBeNull();
    expect(s.failedAt).not.toBeNull();
    expect(s.failedJobId).toBe('job-1');
    expect(s.failureReason).toBe('rate_limited');
    expect(s.failureStopPhase).toBe('author');
    expect(s.failureStopRef).toBe('planItem:abc');
    expect(s.failureStopTitle).toBe('Export a report');
    expect((await planRow(plan.id)).status).toBe('generating');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(3);
    expect(await locksOf(sessionId)).toBe(1);
    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
  });

  it(
    'takes the stop point from the last relayed position when the problem has none',
    T,
    async () => {
      const sessionId = await openSession(await seedCard(), { lastJobId: 'job-1' });
      await planIn(sessionId);

      await planSessionEndService.settleFailedJob(
        'job-1',
        pctx(),
        { status: 'failed', lastPosition: { phase: 'lay', target: 'planItem:p', depth: 0 } },
        { readJob: readJobWith(null, 'MOTIR_AI_OUT_OF_CREDITS') },
      );

      const s = await sessionRow(sessionId);
      expect(s.failureReason).toBe('out_of_credits');
      expect(s.failureStopPhase).toBe('lay');
      expect(s.failureStopRef).toBe('planItem:p');
    },
  );

  it(
    'records internal with a null stop when neither exists, even if the read throws',
    T,
    async () => {
      const sessionId = await openSession(await seedCard(), { lastJobId: 'job-1' });
      await planIn(sessionId);

      await planSessionEndService.settleFailedJob(
        'job-1',
        pctx(),
        { status: 'failed' },
        {
          readJob: async () => {
            throw new Error('motir-ai unreachable');
          },
        },
      );

      const s = await sessionRow(sessionId);
      expect(s.failureReason).toBe('internal');
      expect(s.failureStopPhase).toBeNull();
    },
  );

  it('a second failure overwrites the record — one record, still open', T, async () => {
    const sessionId = await openSession(await seedCard(), { lastJobId: 'job-1' });
    await planIn(sessionId);
    await planSessionEndService.settleFailedJob(
      'job-1',
      pctx(),
      { status: 'failed' },
      {
        readJob: readJobWith(WALK_STOP),
      },
    );
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastJobId: 'job-2' },
    });

    await planSessionEndService.settleFailedJob(
      'job-2',
      pctx(),
      { status: 'failed' },
      {
        readJob: readJobWith({ ...WALK_STOP, reasonCode: 'out_of_credits' }),
      },
    );

    const s = await sessionRow(sessionId);
    expect(s.failedJobId).toBe('job-2');
    expect(s.failureReason).toBe('out_of_credits');
    expect(s.endedAt).toBeNull();
  });

  describe('still ends — the counterfactuals', () => {
    it('a CANCELED job ends the session as before', T, async () => {
      const card = await seedCard();
      const sessionId = await openSession(card, { lastJobId: 'job-1' });
      const plan = await planIn(sessionId);

      await planSessionEndService.settleFailedJob('job-1', pctx(), { status: 'canceled' });

      const s = await sessionRow(sessionId);
      expect(s.endReason).toBe('failed');
      expect(s.failedAt).toBeNull();
      expect((await planRow(plan.id)).status).toBe('declined');
      expect(await statusOf(card.id)).toBe('in_progress');
    });

    it('a `guide` session ends as before', T, async () => {
      const sessionId = await openSession(await seedCard(), {
        lastJobId: 'job-1',
        origin: 'guide',
      });

      await planSessionEndService.settleFailedJob(
        'job-1',
        pctx(),
        { status: 'failed' },
        {
          readJob: readJobWith(WALK_STOP),
        },
      );

      expect((await sessionRow(sessionId)).endReason).toBe('failed');
    });

    it.each(['planned', 'stale'] as const)(
      'a session whose latest plan is %s keeps it: the failure is recorded, nothing ends (MOTIR-7936)',
      T,
      async (status) => {
        const sessionId = await openSession(await seedCard(), { lastJobId: 'job-1' });
        const plan = await planIn(sessionId, { status });

        await planSessionEndService.settleFailedJob(
          'job-1',
          pctx(),
          { status: 'failed' },
          {
            readJob: readJobWith(WALK_STOP),
          },
        );

        const s = await sessionRow(sessionId);
        expect(s.endedAt).toBeNull();
        expect(s.failedAt).not.toBeNull();
        expect((await planRow(plan.id)).status).toBe(status);
      },
    );

    it('a terminal frame for an OLDER job settles nothing', T, async () => {
      const sessionId = await openSession(await seedCard(), { lastJobId: 'job-2' });
      await planIn(sessionId);

      const out = await planSessionEndService.settleFailedJob('job-1', pctx(), {
        status: 'failed',
      });

      expect(out).toBeNull();
      const s = await sessionRow(sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.failedAt).toBeNull();
    });
  });
});

describe('the abandoned-plan sweep — an unwatched failure', () => {
  const failedState = {
    status: 'failed',
    reachable: true,
    failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'gateway 503' },
  } as const;
  const deps = (state: Parameters<typeof asState>[0]) => ({
    resolveJobState: async () => asState(state),
    // A reason that WAITS: `model_unavailable` is resumed once by itself since MOTIR-10968
    // (`providerAutoResume.test.ts`), and this describe is about the record.
    getFailedJobFacts: async () => ({
      walkStop: { ...WALK_STOP, reasonCode: 'out_of_credits' },
      lostMachine: false,
    }),
  });
  function asState(s: {
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | null;
    reachable: boolean;
    failure: { code: string; message: string } | null;
  }) {
    return s;
  }

  it('records a FAILED job on the open session and declines nothing', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, { ageHours: 2, proposals: 2, sourceJobId: 'job-9' });

    const out = await abandonedPlanService.reconcileAbandoned({ deps: deps(failedState) });

    expect(out.outcomes).toEqual([
      {
        planId: plan.id,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'job_terminal',
        lostMachine: false,
        autoResume: null,
      },
    ]);
    const s = await sessionRow(sessionId);
    expect(s.endedAt).toBeNull();
    expect(s.failedJobId).toBe('job-9');
    expect(s.failureReason).toBe('out_of_credits');
    expect(s.failureStopRef).toBe('planItem:abc');
    expect((await planRow(plan.id)).status).toBe('generating');
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(2);
    expect(await locksOf(sessionId)).toBe(1);
  });

  it('records for job_gone and for a SILENT plan behind a running job too', T, async () => {
    const goneSession = await openSession(await seedCard());
    await planIn(goneSession, { ageHours: 2, sourceJobId: 'job-gone' });
    const agedSession = await openSession(await seedCard());
    await planIn(agedSession, { ageHours: 30, sourceJobId: 'job-aged' });

    await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async (jobId) =>
          jobId === 'job-gone'
            ? {
                status: null,
                reachable: false,
                failure: { code: 'MOTIR_AI_JOB_NOT_FOUND', message: 'gone' },
              }
            : { status: 'running', reachable: true, failure: null },
        getFailedJobFacts: async () => ({ walkStop: null, lostMachine: false }),
      },
    });

    expect((await sessionRow(goneSession)).failedAt).not.toBeNull();
    expect((await sessionRow(agedSession)).failedAt).not.toBeNull();
    expect((await sessionRow(goneSession)).endedAt).toBeNull();
    expect((await sessionRow(agedSession)).endedAt).toBeNull();
  });

  it(
    'SPARES a failed-waiting session and an awaiting-person one — nothing is written',
    T,
    async () => {
      const failed = await openSession(await seedCard());
      const failedPlan = await planIn(failed, { ageHours: 2, sourceJobId: 'job-a' });
      await adminDb.planChangeSession.update({
        where: { id: failed },
        data: { failedAt: new Date(), failedJobId: 'job-a', failureReason: 'internal' },
      });
      const awaiting = await openSession(await seedCard());
      const awaitingPlan = await planIn(awaiting, { ageHours: 2, sourceJobId: 'job-b' });
      await adminDb.planChangeSession.update({
        where: { id: awaiting },
        data: { awaitingPersonSince: new Date(), awaitingPersonCause: 'question' },
      });
      const before = [await sessionRow(failed), await sessionRow(awaiting)];

      const out = await abandonedPlanService.reconcileAbandoned({ deps: deps(failedState) });

      expect(out.outcomes).toEqual(
        expect.arrayContaining([
          {
            planId: failedPlan.id,
            projectId: fx.projectId,
            outcome: 'left_as_is',
            reason: 'session_waiting',
          },
          {
            planId: awaitingPlan.id,
            projectId: fx.projectId,
            outcome: 'left_as_is',
            reason: 'session_waiting',
          },
        ]),
      );
      expect([await sessionRow(failed), await sessionRow(awaiting)]).toEqual(before);
      expect((await planRow(failedPlan.id)).status).toBe('generating');
      expect((await planRow(awaitingPlan.id)).status).toBe('generating');
    },
  );

  it(
    'records EVERY dead verdict — a succeeded-but-unplanned or canceled job too (MOTIR-8132)',
    T,
    async () => {
      // These two used to be the decline counterfactuals. Dead is recorded, never
      // declined, on a session To resume lists: the plan and its cards wait for the
      // producer to come back by writing.
      const succeeded = await openSession(await seedCard());
      const succeededPlan = await planIn(succeeded, { ageHours: 2, sourceJobId: 'job-s' });
      const canceled = await openSession(await seedCard());
      const canceledPlan = await planIn(canceled, { ageHours: 2, sourceJobId: 'job-c' });

      await abandonedPlanService.reconcileAbandoned({
        deps: {
          resolveJobState: async (jobId) => ({
            status: jobId === 'job-s' ? 'succeeded' : 'canceled',
            reachable: true,
            failure: null,
          }),
          getFailedJobFacts: async () => ({ walkStop: null, lostMachine: false }),
        },
      });

      for (const [sessionId, planId] of [
        [succeeded, succeededPlan.id],
        [canceled, canceledPlan.id],
      ] as const) {
        expect((await planRow(planId)).status).toBe('generating');
        const s = await sessionRow(sessionId);
        expect(s.endedAt).toBeNull();
        expect(s.failedAt).not.toBeNull();
      }
    },
  );

  it('records a SILENT plan with NO producer — no job, `stalled`, no stop point', T, async () => {
    const sessionId = await openSession(await seedCard());
    const plan = await planIn(sessionId, { ageHours: 1, proposals: 1 });

    const out = await abandonedPlanService.reconcileAbandoned({ deps: deps(failedState) });

    expect(out.outcomes).toEqual([
      {
        planId: plan.id,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'silent',
        lostMachine: false,
        autoResume: null,
      },
    ]);
    const s = await sessionRow(sessionId);
    expect(s.endedAt).toBeNull();
    expect(s.failedJobId).toBeNull();
    expect(s.failureReason).toBe('stalled');
    expect(s.failureStopRef).toBeNull();
    expect((await planRow(plan.id)).status).toBe('generating');
    expect(await locksOf(sessionId)).toBe(1);
  });

  it(
    'records NOTHING when the plan wrote after it was judged silent — the compare-and-set (MOTIR-8132)',
    T,
    async () => {
      const sessionId = await openSession(await seedCard());
      const plan = await planIn(sessionId, { ageHours: 2, sourceJobId: 'job-late' });

      const out = await abandonedPlanService.reconcileAbandoned({
        deps: {
          resolveJobState: async () => asState(failedState),
          // The last read before the record: a producer write lands here and moves
          // the stamp the sweep judged by.
          getFailedJobFacts: async () => {
            await adminDb.plan.update({
              where: { id: plan.id },
              data: { lastActivityAt: new Date() },
            });
            return { walkStop: null, lostMachine: false };
          },
        },
      });

      expect(out.outcomes).toEqual([
        { planId: plan.id, projectId: fx.projectId, outcome: 'left_as_is', reason: 'row_moved' },
      ]);
      const s = await sessionRow(sessionId);
      expect(s.failedAt).toBeNull();
      expect(s.endedAt).toBeNull();
      expect((await planRow(plan.id)).status).toBe('generating');
    },
  );

  describe('still declines — the counterfactuals', () => {
    it('a session-less plan and a `guide` session', T, async () => {
      const orphan = await planIn(await openSession(await seedCard()), {
        ageHours: 2,
        sourceJobId: 'job-o',
      });
      await adminDb.plan.update({ where: { id: orphan.id }, data: { sessionId: null } });
      const guideSession = await openSession(await seedCard(), { origin: 'guide' });
      const guidePlan = await planIn(guideSession, { ageHours: 2, sourceJobId: 'job-g' });

      await abandonedPlanService.reconcileAbandoned({ deps: deps(failedState) });

      expect((await planRow(orphan.id)).status).toBe('declined');
      expect((await planRow(guidePlan.id)).status).toBe('declined');
      expect((await sessionRow(guideSession)).failedAt).toBeNull();
    });

    it.each(['generation', 'expand', 'cadence'] as const)(
      'a silent plan of a `%s` session — no To resume entry, so it is declined',
      async (origin) => {
        const sessionId = await openSession(await seedCard(), { origin });
        const plan = await planIn(sessionId, { ageHours: 1 });

        await abandonedPlanService.reconcileAbandoned({ deps: deps(failedState) });

        expect((await planRow(plan.id)).status).toBe('declined');
        expect((await sessionRow(sessionId)).failedAt).toBeNull();
      },
      60_000,
    );
  });
});

describe('the idle close', () => {
  it(
    'does not end a session marked AFTER discovery — the end re-checks under the lock',
    T,
    async () => {
      const sessionId = await openSession(await seedCard());
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: {
          lastActivityAt: new Date(Date.now() - PLAN_TARGET_LOCK_LEASE_MS - HOUR),
          failedAt: new Date(),
          failedJobId: 'job-x',
          failureReason: 'internal',
        },
      });

      const out = await planSessionEndService.endSession(sessionId, 'idle', {
        workspaceId: fx.workspaceId,
        onlyIfIdleBefore: new Date(Date.now() - PLAN_TARGET_LOCK_LEASE_MS),
      });

      expect(out.ended).toBe(false);
      expect((await sessionRow(sessionId)).endedAt).toBeNull();
    },
  );

  it('closeIdleSessions spares waiting sessions and still closes a plain idle one', T, async () => {
    const idle = await openSession(await seedCard(), { idleMs: 2 * HOUR });
    const failed = await openSession(await seedCard(), { idleMs: 2 * HOUR });
    await adminDb.planChangeSession.update({
      where: { id: failed },
      data: { failedAt: new Date(), failedJobId: 'j', failureReason: 'internal' },
    });
    const awaiting = await openSession(await seedCard(), { idleMs: 2 * HOUR });
    // It REACHED PLANNING (a decided plan): since MOTIR-9299 a mark on a session holding no
    // plan does not protect it, so the wait this case spares is a planned session's.
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId: awaiting,
        status: 'declined',
      },
    });
    await adminDb.planChangeSession.update({
      where: { id: awaiting },
      data: { awaitingPersonSince: new Date(), awaitingPersonCause: 'reply' },
    });

    const out = await planSessionEndService.closeIdleSessions();

    expect(out.sessionIds).toEqual([idle]);
    expect((await sessionRow(failed)).endedAt).toBeNull();
    expect((await sessionRow(awaiting)).endedAt).toBeNull();
  });
});

describe('the cards stay held, and another member is refused with why', () => {
  const FAR = () => new Date(Date.now() + 72 * HOUR);

  async function secondMember(name: string) {
    const user = await createTestUser({ name });
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    return { userId: user.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
  }

  const WAITS = [
    ['failed', { failedAt: new Date(), failedJobId: 'j', failureReason: 'internal' as const }],
    ['question', { awaitingPersonSince: new Date(), awaitingPersonCause: 'question' as const }],
    ['reply', { awaitingPersonSince: new Date(), awaitingPersonCause: 'reply' as const }],
  ] as const;

  it.each(WAITS)('releaseExpired spares a %s session’s session-held lease', T, async (_c, data) => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    await adminDb.planChangeSession.update({ where: { id: sessionId }, data });

    const out = await planTargetLockService.releaseExpired(FAR());

    expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'session_waiting' }]);
    expect(out.released).toBe(0);
    expect(await locksOf(sessionId)).toBe(1);
    expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
  });

  it('releaseExpired spares the PLAN-held lease of a waiting session', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);
    const plan = await planIn(sessionId, { proposals: 1 });
    await adminDb.planTargetLock.update({
      where: { workItemId: card.id },
      data: { sessionId: null, planId: plan.id },
    });
    await adminDb.planChangeSession.update({ where: { id: sessionId }, data: WAITS[0][1] });

    const out = await planTargetLockService.releaseExpired(FAR());

    expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'session_waiting' }]);
    expect(await adminDb.planTargetLock.count({ where: { planId: plan.id } })).toBe(1);
  });

  it('releaseExpired still releases a NON-waiting session’s expired lease', T, async () => {
    const card = await seedCard();
    const sessionId = await openSession(card);

    const out = await planTargetLockService.releaseExpired(FAR());

    expect(out.released).toBe(1);
    expect(await locksOf(sessionId)).toBe(0);
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it.each(WAITS)(
    'a second member is REFUSED on a %s hold, past both windows',
    T,
    async (cause, data) => {
      const card = await seedCard();
      const sessionId = await openSession(card);
      await adminDb.planChangeSession.update({ where: { id: sessionId }, data });
      const rival = await secondMember('Rival');
      const rivalSession = (
        await adminDb.planChangeSession.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            createdById: rival.userId,
            scopeKey: card.key,
            targetKeys: [card.key],
          },
        })
      ).id;

      const refused = await planTargetLockService
        .acquireForScope(rivalSession, [card.key], rival, FAR())
        .catch((e: unknown) => e);
      const preflight = await planTargetLockService.readForeignHoldForScope(
        [card.key],
        rival,
        FAR(),
      );

      for (const err of [refused, preflight]) {
        expect(err).toBeInstanceOf(PlanTargetLockedError);
        const e = err as PlanTargetLockedError;
        expect(e.sessionWaiting).toBe(true);
        expect(e.waitingCause).toBe(cause);
        expect(e.freesBy).toBeNull();
        expect(e.holderSessionId).toBe(sessionId);
        expect(toHeldBy(e)).toMatchObject({
          sessionWaiting: true,
          waitingCause: cause,
          freesBy: null,
        });
      }
      expect(await locksOf(sessionId)).toBe(1);
    },
  );

  it(
    'an expired NON-waiting lease is still reclaimable, with sessionWaiting false on a live refusal',
    T,
    async () => {
      const card = await seedCard();
      const sessionId = await openSession(card);
      const rival = await secondMember('Rival');

      const live = await planTargetLockService.readForeignHoldForScope([card.key], rival);
      expect(live).toBeInstanceOf(PlanTargetLockedError);
      expect(live!.sessionWaiting).toBe(false);
      expect(live!.waitingCause).toBeNull();
      expect(live!.holderSessionId).toBe(sessionId);

      expect(
        await planTargetLockService.readForeignHoldForScope([card.key], rival, FAR()),
      ).toBeNull();
    },
  );
});

describe('concurrency — one failure, one record', () => {
  it(
    'settleFailedJob racing the abandoned sweep, 20 times: one record, plan generating, locks held',
    { timeout: 180_000 },
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const card = await seedCard();
        const sessionId = await openSession(card, { lastJobId: 'job-r' });
        const plan = await planIn(sessionId, { ageHours: 2, proposals: 1, sourceJobId: 'job-r' });

        const results = await Promise.allSettled([
          planSessionEndService.settleFailedJob(
            'job-r',
            pctx(),
            { status: 'failed' },
            {
              readJob: readJobWith(WALK_STOP),
            },
          ),
          abandonedPlanService.reconcileAbandoned({
            deps: {
              resolveJobState: async () => ({
                status: 'failed',
                reachable: true,
                failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'x' },
              }),
              getFailedJobFacts: async () => ({ walkStop: WALK_STOP, lostMachine: false }),
            },
          }),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const s = await sessionRow(sessionId);
        expect(s.endedAt).toBeNull();
        expect(s.failedJobId).toBe('job-r');
        expect((await planRow(plan.id)).status).toBe('generating');
        expect(await locksOf(sessionId)).toBe(1);
      }
    },
  );

  it(
    'settleFailedJob racing a person’s restart, 20 times: ended with no failure, or open and failed — never both',
    { timeout: 180_000 },
    async () => {
      for (let i = 0; i < 20; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const sessionId = await openSession(await seedCard(), { lastJobId: 'job-r' });
        await planIn(sessionId, { proposals: 1 });

        const results = await Promise.allSettled([
          planSessionEndService.settleFailedJob(
            'job-r',
            pctx(),
            { status: 'failed' },
            {
              readJob: readJobWith(WALK_STOP),
            },
          ),
          planSessionEndService.endSession(sessionId, 'restarted', {
            workspaceId: fx.workspaceId,
            endedById: fx.ctx.userId,
            actorId: fx.ctx.userId,
          }),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const s = await sessionRow(sessionId);
        if (s.endedAt) expect(s.failedAt).toBeNull();
        else expect(s.failedAt).not.toBeNull();
      }
    },
  );
});
