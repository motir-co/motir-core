import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanJobStateDto } from '@/lib/dto/plans';
import { buildScope } from '@/lib/planChange/scope';
import { AUTO_RESUMES_PER_SESSION } from '@/lib/planChange/sessionWaitingState';
import { MotirAiOutOfCreditsError, MotirAiUnavailableError } from '@/lib/ai/errors';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { homeService } from '@/lib/services/homeService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE AUTOMATIC RESUME OF A LOST MACHINE'S PLAN (Story MOTIR-8301 · MOTIR-8307), against a REAL
// Postgres, with motir-ai stubbed at `submitJob` exactly as the shipped `sessionResume.test.ts`
// does: a reaped walk with a saved proposal is resumed once, signed as its starter, through
// either door that records the failure; every other failure waits in To resume as recorded;
// and the two doors together still start ONE resume.

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

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  submitJobMock.mockReset();
  jobSeq = 0;
  submitJobMock.mockImplementation(async () => ({ jobId: `job-new-${++jobSeq}` }));
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

/** What `getJob` maps a reaped job's error to: the outage class. */
const REAPED = new MotirAiUnavailableError(
  'the worker holding this job stopped renewing its lease',
);
const lost = { readJob: async () => ({ error: REAPED, walkStop: null, lostMachine: true }) };
// A failure motir-ai JUDGED (`job_failed`). Not the provider: a `model_unavailable` stop is
// resumed once by itself since MOTIR-10968 (`providerAutoResume.test.ts`).
const JUDGED = { code: 'MOTIR_AI_JOB_FAILED', message: 'the planner model returned an error' };
const judged = { readJob: async () => ({ error: JUDGED, walkStop: null, lostMachine: false }) };

/**
 * An open `conversation` session whose current attempt is `job-1`, writing a `generating`
 * plan with `proposals` saved — the state a relay settles. `failed` pre-records the failure.
 */
async function walk(opts: { proposals?: number; failed?: boolean; silentMs?: number } = {}) {
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
  await adminDb.planChangeSession.update({
    where: { id: session.id },
    data: {
      lastJobId: 'job-1',
      ...(opts.failed
        ? { failedAt: new Date(), failedJobId: 'job-1', failureReason: 'model_unavailable' }
        : {}),
    },
  });
  const at = new Date(Date.now() - (opts.silentMs ?? 0));
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'generating',
      sourceJobId: 'job-1',
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
const settle = (
  jobId: string,
  deps: Parameters<typeof planSessionEndService.settleFailedJob>[3] = lost,
) => planSessionEndService.settleFailedJob(jobId, me(), { status: 'failed' }, deps);
const state = (status: PlanJobStateDto['status'], failure: PlanJobStateDto['failure'] = null) =>
  ({ jobId: 'job-1', status, reachable: true, failure }) as PlanJobStateDto;

describe('a lost machine with a saved proposal is resumed automatically', () => {
  it('through the relay: the same plan, signed as the starter, the bind stamped', T, async () => {
    const { sessionId, planId } = await walk();

    const out = await settle('job-1');

    expect(out?.autoResume).toEqual({ started: true, jobId: 'job-new-1', count: 1 });
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [, , , actor, extra] = submitJobMock.mock.calls[0]!;
    expect(actor).toEqual({ userId: fx.ownerId });
    expect(extra).toEqual({ resume: { planId, fromJobId: 'job-1' } });

    const plan = await planRow(planId);
    expect(plan.sourceJobId).toBe('job-new-1');
    expect(plan.status).toBe('generating');
    const s = await sessionRow(sessionId);
    expect(s.failedAt).toBeNull();
    expect(s.lastJobId).toBe('job-new-1');
    expect(s.autoResumeCount).toBe(1);
    expect(s.lastAutoResumedAt).not.toBeNull();
    expect(plan.lastActivityAt).toEqual(s.lastAutoResumedAt);
  });

  it('through the sweep, the same', T, async () => {
    const { sessionId, planId } = await walk({ silentMs: 60_000 });

    const out = await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async () =>
          state('failed', { code: 'MOTIR_AI_UNAVAILABLE', message: REAPED.message }),
        getFailedJobFacts: async () => ({ walkStop: null, lostMachine: true }),
      },
    });

    expect(out.outcomes).toEqual([
      {
        planId,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'job_terminal',
        lostMachine: true,
        autoResume: { started: true, jobId: 'job-new-1', count: 1 },
      },
    ]);
    const plan = await planRow(planId);
    expect(plan.sourceJobId).toBe('job-new-1');
    const s = await sessionRow(sessionId);
    expect(s.failedAt).toBeNull();
    expect(s.autoResumeCount).toBe(1);
    expect(plan.lastActivityAt).toEqual(s.lastAutoResumedAt);
  });
});

describe('every other failure waits in To resume, as recorded', () => {
  it('nothing saved: no_proposal, no submit', T, async () => {
    const { sessionId } = await walk({ proposals: 0 });

    const out = await settle('job-1');

    expect(out?.autoResume).toEqual({ started: false, reason: 'no_proposal' });
    expect(submitJobMock).not.toHaveBeenCalled();
    const s = await sessionRow(sessionId);
    expect(s.failedJobId).toBe('job-1');
    expect(s.failureReason).toBe('model_unavailable');
  });

  it('the bound spent: bound_spent, no submit, the session waits failed', T, async () => {
    const { sessionId } = await walk();
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { autoResumeCount: AUTO_RESUMES_PER_SESSION },
    });

    const out = await settle('job-1');

    expect(out?.autoResume).toEqual({ started: false, reason: 'bound_spent' });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-1');
  });

  it('a third lost machine after two automatic resumes waits in To resume', T, async () => {
    const { sessionId, planId } = await walk();

    expect((await settle('job-1'))?.autoResume).toMatchObject({ started: true, count: 1 });
    expect((await settle('job-new-1'))?.autoResume).toMatchObject({ started: true, count: 2 });
    expect((await settle('job-new-2'))?.autoResume).toEqual({
      started: false,
      reason: 'bound_spent',
    });

    expect(submitJobMock).toHaveBeenCalledTimes(2);
    const s = await sessionRow(sessionId);
    expect(s.failedJobId).toBe('job-new-2');
    expect(s.autoResumeCount).toBe(2);
    expect((await planRow(planId)).sourceJobId).toBe('job-new-2');
    const page = await homeService.listToResume({ ...fx.ctx, projectId: fx.projectId });
    expect(page.planningSessions?.map((row) => row.sessionId)).toEqual([sessionId]);
  });

  it('a judged failure, a cancel and a revision attempt nothing', T, async () => {
    const judgedWalk = await walk();
    expect((await settle('job-1', judged))?.autoResume).toBeNull();
    expect((await sessionRow(judgedWalk.sessionId)).failedJobId).toBe('job-1');

    const canceled = await walk();
    await adminDb.planChangeSession.update({
      where: { id: canceled.sessionId },
      data: { lastJobId: 'job-c' },
    });
    await adminDb.plan.update({ where: { id: canceled.planId }, data: { sourceJobId: 'job-c' } });
    const c = await planSessionEndService.settleFailedJob(
      'job-c',
      me(),
      { status: 'canceled' },
      lost,
    );
    expect(c).toMatchObject({ settled: 'ended', autoResume: null });

    const revision = await walk();
    await adminDb.plan.update({
      where: { id: revision.planId },
      data: { status: 'planned', sourceJobId: 'job-r' },
    });
    const r = await planSessionEndService.settleFailedJob(
      'job-r',
      me(),
      { status: 'failed' },
      lost,
    );
    expect(r).toMatchObject({ arm: 'revision', autoResume: null });

    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('silence alone attempts nothing', T, async () => {
    const { planId, sessionId } = await walk({ silentMs: PLAN_STALLED_AFTER_MS + 60_000 });

    // An unreachable ask, so the plan is judged by its silence alone — a reachable
    // `running` answer would keep it (MOTIR-11258).
    const out = await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async () =>
          ({
            jobId: 'job-1',
            status: null,
            reachable: false,
            failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'connect ECONNREFUSED' },
          }) as PlanJobStateDto,
        getFailedJobFacts: async () => ({ walkStop: null, lostMachine: false }),
        cancelJob: async (jobId) => ({ jobId, status: 'canceled' }),
      },
    });

    expect(out.outcomes).toEqual([
      {
        planId,
        projectId: fx.projectId,
        outcome: 'awaiting_resume',
        reason: 'silent',
        lostMachine: false,
        autoResume: null,
        jobCancel: { cancelled: true },
      },
    ]);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).failedAt).not.toBeNull();
  });

  it('a refused submit: submit_refused, and nothing moves', T, async () => {
    const { sessionId, planId } = await walk();
    submitJobMock.mockRejectedValue(new MotirAiOutOfCreditsError('no credits'));

    const out = await settle('job-1');

    expect(out?.autoResume).toEqual({ started: false, reason: 'submit_refused' });
    const s = await sessionRow(sessionId);
    expect(s.failedJobId).toBe('job-1');
    expect(s.failureReason).toBe('model_unavailable');
    expect(s.autoResumeCount).toBe(0);
    expect((await planRow(planId)).sourceJobId).toBe('job-1');
  });

  it('a starter who cannot plan: starter_cannot_plan, no submit', T, async () => {
    const { sessionId } = await walk();
    const stranger = await createTestUser({ name: 'Gone' });
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { createdById: stranger.id },
    });

    const out = await settle('job-1');

    expect(out?.autoResume).toEqual({ started: false, reason: 'starter_cannot_plan' });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-1');
  });
});

describe('both triggers together start ONE resume', () => {
  it('a relay settle and a direct automatic resume, raced', T, async () => {
    for (let i = 0; i < 10; i++) {
      const { sessionId, planId } = await walk({ failed: true });
      const input = { sessionId, workspaceId: fx.workspaceId, projectId: fx.projectId };

      const [settled, direct] = await Promise.all([
        settle('job-1'),
        planSessionResumeService.resumeAutomatically(input),
      ]);

      const outcomes = [settled?.autoResume ?? null, direct].filter((o) => o !== null);
      const started = outcomes.filter((o) => o.started);
      expect(started, `iteration ${i}: ${JSON.stringify(outcomes)}`).toHaveLength(1);
      const s = await sessionRow(sessionId);
      expect(s.autoResumeCount).toBe(1);
      expect(s.failedAt).toBeNull();
      expect((await planRow(planId)).sourceJobId).toBe(started[0]!.started && started[0]!.jobId);
    }
  });
});

describe('the silence sweep leaves a resumed plan alone', () => {
  it('measures from the resume, so a waiting job is not swept', T, async () => {
    const { sessionId, planId } = await walk({ silentMs: 20 * 60_000 });
    expect((await settle('job-1'))?.autoResume).toMatchObject({ started: true });
    const resumedAt = (await sessionRow(sessionId)).lastAutoResumedAt!;

    const out = await abandonedPlanService.reconcileAbandoned({
      now: new Date(resumedAt.getTime() + 60_000),
      deps: { resolveJobState: async () => state('queued') },
    });

    expect(out.outcomes).toEqual([expect.objectContaining({ planId, outcome: 'left_as_is' })]);
    expect((await sessionRow(sessionId)).failedAt).toBeNull();
  });
});

describe('the failure-recording paths stay safe around the resume', () => {
  it('a relay settling a job the session has moved past records nothing', T, async () => {
    const { sessionId } = await walk();
    // The sweep binds a newer attempt WHILE the relay reads the job (after it found the session
    // by `job-1`): the old job's failure must not land over the running attempt.
    const movesOn = {
      readJob: async () => {
        await adminDb.planChangeSession.update({
          where: { id: sessionId },
          data: { lastJobId: 'job-2' },
        });
        return { error: REAPED, walkStop: null, lostMachine: true };
      },
    };

    expect(await settle('job-1', movesOn)).toBeNull();
    expect((await sessionRow(sessionId)).failedAt).toBeNull();
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('a resume that throws is a submit_refused skip, never an exception', T, async () => {
    const { sessionId } = await walk({ failed: true });
    const { resumeAutomaticallySafely } = await import('@/lib/services/planSessionEndService');
    const spy = vi
      .spyOn(planSessionResumeService, 'resumeAutomatically')
      .mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await resumeAutomaticallySafely({
      sessionId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      cause: 'lost_machine',
    });

    expect(out).toEqual({ started: false, reason: 'submit_refused' });
    expect((await sessionRow(sessionId)).failedAt).not.toBeNull();
    spy.mockRestore();
    warn.mockRestore();
  });
});
