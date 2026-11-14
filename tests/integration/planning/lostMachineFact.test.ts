import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import type { PlanJobStateDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CORE CAN TELL A LOST MACHINE FROM EVERY OTHER FAILURE (MOTIR-8304) — against a
// REAL Postgres. motir-ai fails a job whose machine stopped renewing its lease with
// `ai_job_abandoned`, which core maps to the same `MOTIR_AI_UNAVAILABLE` an outage
// gets. Both places that RECORD a failed hosted attempt — the relays'
// `settleFailedJob` and the sweep's session arm — now hand the lost-machine fact
// back to their caller, and neither changes what is stored.

const T = { timeout: 60_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const pctx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function openSessionWithPlan(opts: { lastJobId?: string; silentMs?: number } = {}) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      scopeKey: dto.identifier,
      targetKeys: [dto.identifier],
      lastJobId: opts.lastJobId ?? null,
      origin: 'conversation',
    },
  });
  await planTargetLockService.acquireForScope(session.id, [dto.identifier], pctx());
  const at = new Date(Date.now() - (opts.silentMs ?? 0));
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId: session.id,
      status: 'generating',
      sourceJobId: opts.lastJobId ?? 'job-sweep',
      createdAt: at,
      lastActivityAt: at,
    },
  });
  await adminDb.planItem.create({
    data: {
      workspaceId: fx.workspaceId,
      planId: plan.id,
      op: 'add',
      proposedFields: { title: 'Saved part', kind: 'subtask' },
      blockedByRefs: [],
    },
  });
  return { sessionId: session.id, planId: plan.id };
}

/** What `getJob` maps a reaped job's error to: the outage class, same code. */
const REAPED_ERROR = new MotirAiUnavailableError(
  'the worker holding this job stopped renewing its lease',
);
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });

describe('settleFailedJob hands the lost-machine fact back (the relay path)', () => {
  it('a failed walk whose job read says lost machine is recorded, and says so', T, async () => {
    const { sessionId } = await openSessionWithPlan({ lastJobId: 'job-1' });

    const out = await planSessionEndService.settleFailedJob(
      'job-1',
      pctx(),
      { status: 'failed' },
      { readJob: async () => ({ error: REAPED_ERROR, walkStop: null, lostMachine: true }) },
    );

    expect(out).toEqual({
      settled: 'recorded',
      sessionId,
      arm: 'session',
      lostMachine: true,
      // The automatic resume is attempted (MOTIR-8307); with no motir-ai behind this test its
      // submit is refused, so the recorded failure below stands.
      autoResume: { started: false, reason: 'submit_refused' },
    });
    // What a person reads is unchanged: the outage reason.
    const s = await sessionRow(sessionId);
    expect(s.failureReason).toBe('model_unavailable');
    expect(s.failedJobId).toBe('job-1');
    expect(s.endedAt).toBeNull();
  });

  it('a read that carries no lost-machine field reports false', T, async () => {
    const { sessionId } = await openSessionWithPlan({ lastJobId: 'job-1' });

    const out = await planSessionEndService.settleFailedJob(
      'job-1',
      pctx(),
      { status: 'failed' },
      { readJob: async () => ({ error: REAPED_ERROR, walkStop: null }) },
    );

    // Not lost — but the outage error records `model_unavailable`, which is resumed ONCE by
    // itself since MOTIR-10968, so the resume is attempted (and refused here, as above).
    expect(out).toEqual({
      settled: 'recorded',
      sessionId,
      arm: 'session',
      lostMachine: false,
      autoResume: { started: false, reason: 'submit_refused' },
    });
  });

  it('a canceled job reports false and is never read', T, async () => {
    const { sessionId } = await openSessionWithPlan({ lastJobId: 'job-1' });
    const readJob = vi.fn(async () => ({ error: REAPED_ERROR, walkStop: null, lostMachine: true }));

    const out = await planSessionEndService.settleFailedJob(
      'job-1',
      pctx(),
      { status: 'canceled' },
      { readJob },
    );

    expect(out).toEqual({
      settled: 'ended',
      sessionId,
      arm: 'session',
      lostMachine: false,
      autoResume: null,
    });
    expect(readJob).not.toHaveBeenCalled();
  });

  it('a job read that throws reports false — unknown is not lost', T, async () => {
    const { sessionId } = await openSessionWithPlan({ lastJobId: 'job-1' });

    const out = await planSessionEndService.settleFailedJob(
      'job-1',
      pctx(),
      { status: 'failed' },
      {
        readJob: async () => {
          throw new Error('motir-ai unreachable');
        },
      },
    );

    expect(out).toEqual({
      settled: 'recorded',
      sessionId,
      arm: 'session',
      lostMachine: false,
      autoResume: null,
    });
  });
});

describe('reconcileAbandoned hands the lost-machine fact back (the sweep path)', () => {
  const state = (status: PlanJobStateDto['status'], failure: PlanJobStateDto['failure'] = null) =>
    ({ jobId: 'job-sweep', status, reachable: true, failure }) as PlanJobStateDto;

  it(
    'a failed job whose read says lost machine is awaiting_resume with lostMachine',
    T,
    async () => {
      const { planId, sessionId } = await openSessionWithPlan({ silentMs: 60_000 });

      const out = await abandonedPlanService.reconcileAbandoned({
        deps: {
          resolveJobState: async () =>
            state('failed', { code: 'MOTIR_AI_UNAVAILABLE', message: REAPED_ERROR.message }),
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
          autoResume: { started: false, reason: 'submit_refused' },
        },
      ]);
      expect((await sessionRow(sessionId)).failureReason).toBe('model_unavailable');
    },
  );

  it('a plan recorded for SILENCE alone, its job still running, reads false', T, async () => {
    const { planId } = await openSessionWithPlan({ silentMs: PLAN_STALLED_AFTER_MS + 60_000 });
    // The sweep's ask could not reach motir-ai, so the plan is judged by its silence —
    // a reachable `running` answer would keep it (MOTIR-11258). The facts read that
    // follows is the shipped one, against a motir-ai that reports the job running.
    process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ jobId: 'job-sweep', status: 'running', result: null, error: null }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        ),
    );

    const out = await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async () =>
          ({
            jobId: 'job-sweep',
            status: null,
            reachable: false,
            failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'connect ECONNREFUSED' },
          }) as PlanJobStateDto,
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
        // Given up on by silence, so the sweep cancels it (MOTIR-9065).
        jobCancel: { cancelled: true },
      },
    ]);
  });
});
