import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanJobStateDto } from '@/lib/dto/plans';
import type { JobWalkStop } from '@/lib/planChange/failureRecord';
import { buildScope } from '@/lib/planChange/scope';
import {
  AUTO_RESUMES_PER_SESSION,
  autoResumeCauseOf,
  PLAN_SESSION_FAILURE_REASONS,
} from '@/lib/planChange/sessionWaitingState';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { homeService } from '@/lib/services/homeService';
import { planProgressService } from '@/lib/services/planProgressService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// AN UNAVAILABLE PROVIDER RESUMES ITSELF ONCE (MOTIR-10968), against a REAL Postgres, with
// motir-ai stubbed at `submitJob` exactly as `sessionAutoResume.test.ts` does. A conversation's
// walk recorded failed with `failure_reason = model_unavailable` is resumed by Motir — the same
// plan, the same session, signed as the starter — through EITHER door that records a failure
// (the relay's settle, the abandoned sweep), at most ONCE per session for that cause and only
// while the shared `AUTO_RESUMES_PER_SESSION` bound holds. Every other reason, and an
// unresumable one, waits in To resume as before.

const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  streamJob: vi.fn(),
  getJob: vi.fn(),
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

const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const T = { timeout: 120_000 };
let fx: WorkItemFixture;
let jobSeq = 0;
let info: MockInstance<typeof console.info>;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  submitJobMock.mockReset();
  jobSeq = 0;
  submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

/** Where motir-ai says the walk stopped, and why — the provider cause unless told otherwise. */
const stopFor = (reasonCode: string): JobWalkStop => ({
  phase: 'author',
  target: 'planItem:abc',
  targetTitle: 'Export a report',
  depth: 1,
  reasonCode,
  detail: 'upstream connection reset',
});

/** The job read a relay settle or the sweep makes: NOT a lost machine. */
const facts = (reasonCode = 'model_unavailable', resumable: boolean | null = null) => ({
  error: null,
  walkStop: stopFor(reasonCode),
  lostMachine: false,
  resumable,
});
const lostFacts = () => ({ ...facts(), lostMachine: true });

/** An open `conversation` session whose current attempt is `jobId`, writing a `generating`
 *  plan with `proposals` saved — the state a failure is recorded on. */
async function walk(opts: { proposals?: number; silentMs?: number; jobId?: string } = {}) {
  const jobId = opts.jobId ?? 'job-1';
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Card ${Math.random()}` },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  const session = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([dto.identifier]),
    'Split it',
  );
  await adminDb.planChangeSession.update({ where: { id: session.id }, data: { lastJobId: jobId } });
  const at = new Date(Date.now() - (opts.silentMs ?? 0));
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'generating',
      sourceJobId: jobId,
      createdById: fx.ownerId,
      createdAt: at,
      lastActivityAt: at,
    },
  });
  for (let i = 0; i < (opts.proposals ?? 1); i++) {
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
  return { sessionId: session.id, planId: plan.id };
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
/** The relay sees `jobId`'s terminal `failed` frame, and motir-ai's read of it is `read`. */
type Facts = ReturnType<typeof facts>;
const relay = (jobId: string, read: () => Facts = () => facts()) =>
  planSessionEndService.settleFailedJob(
    jobId,
    me(),
    { status: 'failed' },
    { readJob: async () => read() },
  );
const failedState = (jobId: string) =>
  ({
    jobId,
    status: 'failed',
    reachable: true,
    failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'gateway 503' },
  }) as PlanJobStateDto;
/** The abandoned sweep finds the plan's job terminal-failed, and reads it as `read`. */
const sweep = (read: () => Facts = () => facts()) =>
  abandonedPlanService.reconcileAbandoned({
    deps: {
      resolveJobState: async (jobId: string) => failedState(jobId),
      getFailedJobFacts: async () => read(),
    },
  });
const toResumeIds = async () =>
  (
    (await homeService.listToResume({ ...fx.ctx, projectId: fx.projectId })).planningSessions ?? []
  ).map((row) => row.sessionId);

/** The resume landed: the same plan re-pointed at the new job, the session bound and stamped. */
async function expectResumed(sessionId: string, planId: string, jobId: string, count: number) {
  const plan = await planRow(planId);
  expect(plan.sourceJobId).toBe(jobId);
  expect(plan.status).toBe('generating');
  const s = await sessionRow(sessionId);
  expect(s.failedAt).toBeNull();
  expect(s.lastJobId).toBe(jobId);
  expect(s.autoResumeCount).toBe(count);
  expect(s.providerResumedAt).not.toBeNull();
  expect(plan.lastActivityAt).toEqual(s.lastAutoResumedAt);
}

describe('the cause a recorded failure is resumed for', () => {
  it('a lost machine wins, model_unavailable is the only other, unresumable waits', () => {
    for (const failureReason of PLAN_SESSION_FAILURE_REASONS) {
      expect(autoResumeCauseOf({ lostMachine: true, failureReason, failureResumable: null })).toBe(
        'lost_machine',
      );
      expect(autoResumeCauseOf({ lostMachine: false, failureReason, failureResumable: true })).toBe(
        failureReason === 'model_unavailable' ? 'model_unavailable' : null,
      );
      expect(
        autoResumeCauseOf({ lostMachine: true, failureReason, failureResumable: false }),
      ).toBeNull();
    }
  });
});

describe('1 · a model_unavailable stop with a saved proposal is resumed automatically', () => {
  it('through the relay: the same plan, signed as the starter, the cause stamped', T, async () => {
    const { sessionId, planId } = await walk();

    const out = await relay('job-1');

    expect(out).toEqual({
      settled: 'recorded',
      sessionId,
      arm: 'session',
      lostMachine: false,
      autoResume: { started: true, jobId: 'job-new-1', count: 1 },
    });
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [, , , actor, extra] = submitJobMock.mock.calls[0]!;
    expect(actor).toEqual({ userId: fx.ownerId });
    expect(extra).toEqual({ resume: { planId, fromJobId: 'job-1' } });
    await expectResumed(sessionId, planId, 'job-new-1', 1);
    const s = await sessionRow(sessionId);
    expect(s.providerResumedAt).toEqual(s.lastAutoResumedAt);
    expect(await toResumeIds()).toEqual([]);
  });

  it('through the sweep (a job that ended), the same', T, async () => {
    const { sessionId, planId } = await walk({ silentMs: 60_000 });

    const out = await sweep();

    expect(out.outcomes).toEqual([
      {
        planId,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'job_terminal',
        lostMachine: false,
        autoResume: { started: true, jobId: 'job-new-1', count: 1 },
      },
    ]);
    await expectResumed(sessionId, planId, 'job-new-1', 1);
  });

  it('the one-line [auto-resume] trace names the cause', T, async () => {
    const { sessionId, planId } = await walk();

    await relay('job-1');

    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(
      `[auto-resume] session ${sessionId} plan ${planId} (model_unavailable) → started job job-new-1 (1/${AUTO_RESUMES_PER_SESSION})`,
    );
  });

  it('the plan reads `resuming` with its PlanAutoResume, as a lost machine does', T, async () => {
    const { sessionId, planId } = await walk();
    await relay('job-1');
    const plan = await planRow(planId);
    const s = await sessionRow(sessionId);

    const snapshot = (
      await planProgressService.snapshotsForPlans(
        [
          {
            id: plan.id,
            status: plan.status,
            createdAt: plan.createdAt,
            lastActivityAt: plan.lastActivityAt,
            sessionId: plan.sessionId,
          },
        ],
        fx.ctx,
      )
    ).get(planId)!;

    expect(snapshot.autoResume).toEqual({ at: s.lastAutoResumedAt!.toISOString(), count: 1 });
  });
});

describe('2 · a second model_unavailable stop waits for the person', () => {
  it('relay, then relay: the resumed walk stops again and stays in To resume', T, async () => {
    const { sessionId, planId } = await walk();
    expect((await relay('job-1'))?.autoResume).toMatchObject({ started: true, count: 1 });

    const second = await relay('job-new-1');

    expect(second?.autoResume).toEqual({ started: false, reason: 'bound_spent' });
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const s = await sessionRow(sessionId);
    expect(s.failedJobId).toBe('job-new-1');
    expect(s.failureReason).toBe('model_unavailable');
    expect(s.autoResumeCount).toBe(1);
    expect((await planRow(planId)).sourceJobId).toBe('job-new-1');
    expect(await toResumeIds()).toEqual([sessionId]);
  });

  it('relay, then the sweep: the second recorder starts nothing either', T, async () => {
    const { sessionId, planId } = await walk();
    expect((await relay('job-1'))?.autoResume).toMatchObject({ started: true });

    const out = await sweep();

    expect(out.outcomes).toEqual([
      expect.objectContaining({
        planId,
        outcome: 'awaiting_resume',
        autoResume: { started: false, reason: 'bound_spent' },
      }),
    ]);
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-new-1');
  });

  it('a lost-machine resume before does not spend the provider resume', T, async () => {
    await walk();
    expect((await relay('job-1', lostFacts))?.autoResume).toMatchObject({ count: 1 });
    expect((await relay('job-new-1'))?.autoResume).toMatchObject({ started: true, count: 2 });

    // The shared bound is now spent too; the provider's once would refuse a third either way.
    expect((await relay('job-new-2'))?.autoResume).toEqual({
      started: false,
      reason: 'bound_spent',
    });
    expect(submitJobMock).toHaveBeenCalledTimes(2);
  });

  it(
    'a manual Resume after the second stop continues it, and no auto-resume follows',
    T,
    async () => {
      const { sessionId } = await walk();
      await relay('job-1');
      await relay('job-new-1');

      const resumed = await planSessionResumeService.resume(me(), sessionId);
      expect(resumed.jobId).toBe('job-new-2');

      expect((await relay('job-new-2'))?.autoResume).toEqual({
        started: false,
        reason: 'bound_spent',
      });
      expect((await sessionRow(sessionId)).failedJobId).toBe('job-new-2');
    },
  );

  it('the relay and the sweep racing one stop start ONE resume, ≥ 10 times', T, async () => {
    for (let i = 0; i < 10; i++) {
      const { sessionId, planId } = await walk({ jobId: `job-race-${i}`, silentMs: 60_000 });

      const [settled, swept] = await Promise.all([relay(`job-race-${i}`), sweep()]);

      const outcomes = [
        settled?.autoResume ?? null,
        ...swept.outcomes
          .filter((o) => o.planId === planId)
          .map((o) => ('autoResume' in o ? o.autoResume : null)),
      ].filter((o) => o !== null);
      expect(
        outcomes.filter((o) => o.started),
        `iteration ${i}: ${JSON.stringify(outcomes)}`,
      ).toHaveLength(1);
      const s = await sessionRow(sessionId);
      expect(s.autoResumeCount).toBe(1);
      expect(s.failedAt).toBeNull();
    }
  });
});

describe('3 · the lost-machine resume is unchanged, and its spent bound holds', () => {
  it('a lost machine after the provider resume still resumes, up to the bound', T, async () => {
    const { sessionId, planId } = await walk();
    expect((await relay('job-1'))?.autoResume).toMatchObject({ started: true, count: 1 });

    expect((await relay('job-new-1', lostFacts))?.autoResume).toMatchObject({
      started: true,
      count: 2,
    });
    expect((await relay('job-new-2', lostFacts))?.autoResume).toEqual({
      started: false,
      reason: 'bound_spent',
    });

    const s = await sessionRow(sessionId);
    expect(s.autoResumeCount).toBe(AUTO_RESUMES_PER_SESSION);
    expect((await planRow(planId)).sourceJobId).toBe('job-new-2');
  });

  it('a lost-machine resume stamps no provider resume', T, async () => {
    const { sessionId } = await walk();

    expect((await relay('job-1', lostFacts))?.autoResume).toMatchObject({ started: true });

    const s = await sessionRow(sessionId);
    expect(s.autoResumeCount).toBe(1);
    expect(s.providerResumedAt).toBeNull();
  });

  it(
    'a bound spent on lost machines resumes no model_unavailable stop, at either door',
    T,
    async () => {
      const viaRelay = await walk();
      const viaSweep = await walk({ jobId: 'job-s' });
      for (const { sessionId } of [viaRelay, viaSweep]) {
        await adminDb.planChangeSession.update({
          where: { id: sessionId },
          data: { autoResumeCount: AUTO_RESUMES_PER_SESSION },
        });
      }

      expect((await relay('job-1'))?.autoResume).toEqual({ started: false, reason: 'bound_spent' });
      const out = await sweep();

      expect(out.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            planId: viaSweep.planId,
            autoResume: { started: false, reason: 'bound_spent' },
          }),
        ]),
      );
      expect(submitJobMock).not.toHaveBeenCalled();
      for (const { sessionId } of [viaRelay, viaSweep]) {
        const s = await sessionRow(sessionId);
        expect(s.failedAt).not.toBeNull();
        expect(s.providerResumedAt).toBeNull();
      }
    },
  );
});

describe('4 · every other failure waits in To resume, as recorded', () => {
  const others = PLAN_SESSION_FAILURE_REASONS.filter(
    (r) => r !== 'model_unavailable' && r !== 'stalled',
  );

  it.each(others)('a %s stop starts nothing, through the relay', T, async (reason) => {
    const { sessionId } = await walk();

    const out = await relay('job-1', () => facts(reason));

    expect(out?.autoResume).toBeNull();
    expect(submitJobMock).not.toHaveBeenCalled();
    const s = await sessionRow(sessionId);
    expect(s.failureReason).toBe(reason);
    expect(s.failedJobId).toBe('job-1');
  });

  it.each(others)('a %s stop starts nothing, through the sweep', T, async (reason) => {
    const { sessionId, planId } = await walk();

    const out = await sweep(() => facts(reason));

    expect(out.outcomes).toEqual([
      expect.objectContaining({ planId, outcome: 'awaiting_resume', autoResume: null }),
    ]);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).failureReason).toBe(reason);
  });

  it('a silent plan is recorded `stalled` and starts nothing', T, async () => {
    const { sessionId, planId } = await walk({ silentMs: PLAN_STALLED_AFTER_MS + 60_000 });

    const out = await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async (jobId: string) =>
          ({ jobId, status: 'running', reachable: true, failure: null }) as PlanJobStateDto,
        getFailedJobFacts: async () => facts(),
        cancelJob: async (jobId: string) => ({ jobId, status: 'canceled' }),
      },
    });

    expect(out.outcomes).toEqual([
      expect.objectContaining({ planId, reason: 'silent', autoResume: null }),
    ]);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).failureReason).toBe('stalled');
  });

  it(
    'a model_unavailable stop recorded unresumable starts nothing, at either door',
    T,
    async () => {
      const viaRelay = await walk();
      const viaSweep = await walk({ jobId: 'job-s' });

      expect(
        (await relay('job-1', () => facts('model_unavailable', false)))?.autoResume,
      ).toBeNull();
      const out = await sweep(() => facts('model_unavailable', false));

      expect(out.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ planId: viaSweep.planId, autoResume: null }),
        ]),
      );
      expect(submitJobMock).not.toHaveBeenCalled();
      for (const { sessionId } of [viaRelay, viaSweep]) {
        const s = await sessionRow(sessionId);
        expect(s.failureReason).toBe('model_unavailable');
        expect(s.failureResumable).toBe(false);
        expect(s.autoResumeCount).toBe(0);
      }
    },
  );

  it('nothing saved: a model_unavailable stop with no proposal waits', T, async () => {
    const { sessionId } = await walk({ proposals: 0 });

    expect((await relay('job-1'))?.autoResume).toEqual({ started: false, reason: 'no_proposal' });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).providerResumedAt).toBeNull();
  });
});

describe('the guards the provider cause passes through', () => {
  it('the precheck reads the cause back from the row, not the caller', T, async () => {
    const { sessionId } = await walk();
    await relay('job-1', () => facts('rate_limited'));

    const out = await planSessionResumeService.resumeAutomatically({
      sessionId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      cause: 'model_unavailable',
    });

    expect(out).toEqual({ started: false, reason: 'not_failed' });
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it(
    'recordAutoResume admits ONE provider resume per session, in its own statement',
    T,
    async () => {
      const { sessionId } = await walk();
      const record = (once: boolean) =>
        withWorkspaceServiceContext(fx.workspaceId, (tx) =>
          planChangeSessionRepository.recordAutoResume(
            sessionId,
            { at: new Date(), max: AUTO_RESUMES_PER_SESSION, once },
            tx,
          ),
        );

      const raced = await Promise.all([record(true), record(true)]);

      expect(raced.filter((n) => n !== null)).toEqual([1]);
      const s = await sessionRow(sessionId);
      expect(s.autoResumeCount).toBe(1);
      expect(s.providerResumedAt).toEqual(s.lastAutoResumedAt);
      // A lost-machine resume is not refused by the provider's once, and does not move it.
      expect(await record(false)).toBe(2);
      expect((await sessionRow(sessionId)).providerResumedAt).toEqual(s.providerResumedAt);
    },
  );
});
