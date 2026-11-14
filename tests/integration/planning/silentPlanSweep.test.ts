import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { abandonedPlanService, type AbandonedPlanDeps } from '@/lib/services/abandonedPlanService';
import { homeService } from '@/lib/services/homeService';
import { plansService } from '@/lib/services/plansService';
import type { PlanJobStateDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A SILENT PLAN IS RECORDED, AND A RETURNING PRODUCER PICKS IT UP (Story MOTIR-8128 ·
// MOTIR-8134), against a REAL Postgres and through the real services. MOTIR-8130 decided
// the rule and MOTIR-8132 built it: a `generating` plan is dead when it has written
// nothing for `PLAN_STALLED_AFTER_MS`, whoever produces it; a job motir-ai already
// reports dead is a fast path; dead is RECORDED on the plan's `conversation` / `mcp`
// session (never declined), so the plan, its proposals and its held cards wait in To
// resume; and the producer's next write clears the record. Every claim the story makes
// is asserted below on rows, not on the sweep's own summary alone.

const T = { timeout: 60_000 };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const SILENT_MS = PLAN_STALLED_AFTER_MS + 5 * MINUTE;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = () => ({ ...fx.ctx, projectId: fx.projectId });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });

/**
 * A plan written over the MCP, the way `create_plan` + `add_plan_items` write one: its
 * own session of origin `mcp`, no generation job, and `proposals` proposals.
 */
async function mcpPlan(proposals = 1): Promise<{ planId: string; sessionId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    // Exactly what `create_plan` sends: the token owner asked, the server sets the
    // source, and the plan opens its own `mcp` session (`lib/mcp/tools/authorPlan.ts`).
    {
      title: 'Agent-authored',
      createdById: fx.ctx.userId,
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      session: { origin: 'mcp' },
    },
    fx.ctx,
  );
  if (proposals > 0) {
    await plansService.addProposals(
      plan.id,
      Array.from({ length: proposals }, (_, i) => ({
        op: 'add' as const,
        proposedFields: { title: `Proposed ${i}`, kind: 'story' as const },
      })),
      fx.ctx,
    );
  }
  const row = await planRow(plan.id);
  expect(row.sessionId).not.toBeNull();
  expect((await sessionRow(row.sessionId!)).origin).toBe('mcp');
  return { planId: plan.id, sessionId: row.sessionId! };
}

/** Backdate the plan's last write — and, when given, its creation. */
async function silence(planId: string, silentMs: number, ageMs?: number): Promise<Date> {
  const lastActivityAt = new Date(Date.now() - silentMs);
  await adminDb.plan.update({
    where: { id: planId },
    data: {
      lastActivityAt,
      ...(ageMs !== undefined ? { createdAt: new Date(Date.now() - ageMs) } : {}),
    },
  });
  return lastActivityAt;
}

/** Give the plan a hosted job, as a generation would have. */
async function withJob(planId: string, jobId: string): Promise<void> {
  await adminDb.plan.update({ where: { id: planId }, data: { sourceJobId: jobId } });
}

const job = (status: PlanJobStateDto['status']): PlanJobStateDto =>
  ({ jobId: 'job', status, reachable: true, failure: null }) as PlanJobStateDto;

/** The cancels the sweep sent to the stubbed motir-ai, as `[jobId, coreProjectId]`. */
let cancels: [string, string][] = [];
beforeEach(() => {
  cancels = [];
});

const deps = (
  state: PlanJobStateDto,
  onAsk?: () => Promise<void>,
  cancel?: AbandonedPlanDeps['cancelJob'],
): AbandonedPlanDeps => ({
  resolveJobState: async () => {
    await onAsk?.();
    return state;
  },
  getFailedJobFacts: async () => ({ walkStop: null, lostMachine: false }),
  cancelJob:
    cancel ??
    (async (jobId, coreProjectId) => {
      cancels.push([jobId, coreProjectId]);
      return { jobId, status: 'canceled' };
    }),
});

async function toResumeSessionIds(): Promise<string[]> {
  const page = await homeService.listToResume(hctx());
  return (page.planningSessions ?? []).map((entry) => entry.sessionId);
}

describe('a silent plan is RECORDED, not declined', () => {
  it(
    'an MCP plan silent past the threshold waits in To resume, with everything it held',
    T,
    async () => {
      const { planId, sessionId } = await mcpPlan(2);
      await silence(planId, SILENT_MS);
      expect(await toResumeSessionIds()).toEqual([]);

      const summary = await abandonedPlanService.reconcileAbandoned();

      expect(summary.outcomes).toEqual([
        {
          planId,
          projectId: fx.projectId,
          outcome: 'awaiting_resume',
          reason: 'silent',
          lostMachine: false,
          autoResume: null,
        },
      ]);
      expect(summary.declined).toBe(0);
      const plan = await planRow(planId);
      expect(plan.status).toBe('generating');
      expect(plan.decidedAt).toBeNull();
      expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
      const session = await sessionRow(sessionId);
      expect(session.endedAt).toBeNull();
      expect(session.failedAt).not.toBeNull();
      // No job to resume from: To resume lists it, and there is no `fromJobId` to offer.
      expect(session.failedJobId).toBeNull();
      // The sweep's own verdict, not a reason borrowed from a job it never had (MOTIR-9065).
      expect(session.failureReason).toBe('stalled');
      expect(session.failureDetail).toMatch(/^The plan wrote nothing for \d+ minutes\.$/);
      expect(session.failureStopRef).toBeNull();
      expect(await toResumeSessionIds()).toEqual([sessionId]);
    },
  );

  it(
    'a RUNNING job keeps a silent plan alive — nothing is recorded or cancelled (MOTIR-11258)',
    T,
    async () => {
      // ⚠️ REVERSED BY MOTIR-11258. This test read *"a RUNNING job behind a silent plan
      // keeps nothing alive — it is recorded"*, and asserted the job was cancelled.
      // motir-ai's read reaps a lapsed lease before it answers (MOTIR-8303), so a
      // `running` answer is a live worker; recording and cancelling it threw away a
      // final check that was still running.
      const { planId, sessionId } = await mcpPlan();
      await withJob(planId, 'job-running');
      const stamp = await silence(planId, SILENT_MS);

      const summary = await abandonedPlanService.reconcileAbandoned({
        deps: deps(job('running')),
      });

      expect(summary.outcomes).toEqual([
        { planId, projectId: fx.projectId, outcome: 'left_as_is', reason: 'job_running' },
      ]);
      const plan = await planRow(planId);
      expect(plan.status).toBe('generating');
      expect(plan.lastActivityAt.getTime()).toBe(stamp.getTime());
      const session = await sessionRow(sessionId);
      expect(session.failedAt).toBeNull();
      expect(session.endedAt).toBeNull();
      expect(cancels).toEqual([]);
      expect(await toResumeSessionIds()).toEqual([]);
    },
  );

  it(
    'the kept job FINISHES — a later `succeeded` read while still generating is settled as before',
    T,
    async () => {
      // A job that finishes normally closes its plan itself (`planned`), so the sweep
      // never sees it again. One that ended WITHOUT closing it is read on the next pass
      // through the fast path, exactly as it would have been without the keep:
      // recorded `job_terminal`, nothing cancelled (an ended job has nothing to cancel).
      const { planId, sessionId } = await mcpPlan();
      await withJob(planId, 'job-finishing');
      await silence(planId, SILENT_MS);
      const kept = await abandonedPlanService.reconcileAbandoned({ deps: deps(job('running')) });
      expect(kept.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_running' });

      const ended = await abandonedPlanService.reconcileAbandoned({
        deps: deps(job('succeeded')),
      });

      expect(ended.outcomes[0]).toMatchObject({
        outcome: 'awaiting_resume',
        reason: 'job_terminal',
      });
      expect(ended.outcomes[0]).not.toHaveProperty('jobCancel');
      expect((await sessionRow(sessionId)).failedJobId).toBe('job-finishing');
      expect(cancels).toEqual([]);
    },
  );

  it(
    'a QUEUED job is never recorded by silence alone — it has not started (MOTIR-9065)',
    T,
    async () => {
      const { planId, sessionId } = await mcpPlan();
      await withJob(planId, 'job-queued');
      const stamp = await silence(planId, SILENT_MS);

      const summary = await abandonedPlanService.reconcileAbandoned({ deps: deps(job('queued')) });

      expect(summary.outcomes).toEqual([
        { planId, projectId: fx.projectId, outcome: 'left_as_is', reason: 'job_queued' },
      ]);
      const plan = await planRow(planId);
      expect(plan.status).toBe('generating');
      expect(plan.lastActivityAt.getTime()).toBe(stamp.getTime());
      expect((await sessionRow(sessionId)).failedAt).toBeNull();
      expect(cancels).toEqual([]);
      expect(await toResumeSessionIds()).toEqual([]);
    },
  );

  it(
    'an UNREACHABLE job read is recorded as stalled, never model_unavailable (MOTIR-9065)',
    T,
    async () => {
      const { planId, sessionId } = await mcpPlan();
      await withJob(planId, 'job-unread');
      await silence(planId, SILENT_MS);
      const unreachable = {
        jobId: 'job-unread',
        status: null,
        reachable: false,
        failure: {
          code: 'MOTIR_AI_UNAVAILABLE',
          message: 'motir-ai did not respond within 30000ms',
        },
      } as unknown as PlanJobStateDto;

      const summary = await abandonedPlanService.reconcileAbandoned({ deps: deps(unreachable) });

      expect(summary.outcomes[0]).toMatchObject({
        outcome: 'awaiting_resume',
        reason: 'silent',
        jobCancel: { cancelled: true },
      });
      const session = await sessionRow(sessionId);
      expect(session.failureReason).toBe('stalled');
      expect(session.failureReason).not.toBe('model_unavailable');
      expect(session.failureDetail).toMatch(
        /its job could not be read: motir-ai did not respond within 30000ms\.$/,
      );
      expect(cancels).toEqual([['job-unread', fx.projectId]]);
    },
  );

  it(
    'a cancel motir-ai refuses is REPORTED with why, and the record stands (MOTIR-9065)',
    T,
    async () => {
      const { planId, sessionId } = await mcpPlan();
      await withJob(planId, 'job-refused');
      await silence(planId, SILENT_MS);
      // An unreachable read: since MOTIR-11258 the only verdict that gives up on a job
      // judged by silence (a `running` answer keeps it).
      const unreachable = {
        jobId: 'job-refused',
        status: null,
        reachable: false,
        failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'connect ECONNREFUSED' },
      } as unknown as PlanJobStateDto;

      const summary = await abandonedPlanService.reconcileAbandoned({
        deps: deps(unreachable, undefined, async () => {
          throw new Error('Not Found');
        }),
      });

      expect(summary.outcomes[0]).toMatchObject({
        outcome: 'awaiting_resume',
        reason: 'silent',
        jobCancel: { cancelled: false, why: 'Not Found' },
      });
      expect((await sessionRow(sessionId)).failureReason).toBe('stalled');
    },
  );

  it('a FAILED job is recorded INSIDE the threshold — the fast path', T, async () => {
    const { planId, sessionId } = await mcpPlan();
    await withJob(planId, 'job-failed');
    await silence(planId, MINUTE);

    const summary = await abandonedPlanService.reconcileAbandoned({ deps: deps(job('failed')) });

    expect(summary.outcomes[0]).toMatchObject({
      outcome: 'awaiting_resume',
      reason: 'job_terminal',
    });
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-failed');
    expect((await planRow(planId)).status).toBe('generating');
    // A job that already ended has nothing left to cancel.
    expect(summary.outcomes[0]).not.toHaveProperty('jobCancel');
    expect(cancels).toEqual([]);
  });

  it('a plan WRITING for more than a day is untouched — age is not the clock', T, async () => {
    // Created thirty hours ago, last wrote a minute ago, behind a live job. The old
    // 24-hour max age would have declined it.
    const { planId, sessionId } = await mcpPlan();
    await withJob(planId, 'job-long');
    const stamp = await silence(planId, MINUTE, 30 * HOUR);

    const summary = await abandonedPlanService.reconcileAbandoned({
      deps: deps(job('running')),
    });

    // The live job decides it (MOTIR-11258); the minute-old write agrees.
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_running' });
    const plan = await planRow(planId);
    expect(plan.status).toBe('generating');
    expect(plan.lastActivityAt.getTime()).toBe(stamp.getTime());
    expect((await sessionRow(sessionId)).failedAt).toBeNull();
  });
});

describe('a returning producer RESUMES by writing', () => {
  it('an append after the record clears it, and the plan keeps everything', T, async () => {
    const { planId, sessionId } = await mcpPlan(1);
    await silence(planId, SILENT_MS);
    await abandonedPlanService.reconcileAbandoned();
    expect((await sessionRow(sessionId)).failedAt).not.toBeNull();

    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Back again', kind: 'story' } }],
      fx.ctx,
    );

    const session = await sessionRow(sessionId);
    expect(session.failedAt).toBeNull();
    expect(session.failedJobId).toBeNull();
    expect(session.failureReason).toBeNull();
    expect(session.endedAt).toBeNull();
    const plan = await planRow(planId);
    expect(plan.status).toBe('generating');
    expect(Date.now() - plan.lastActivityAt.getTime()).toBeLessThan(MINUTE);
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
    expect(await toResumeSessionIds()).toEqual([]);
  });

  it('a step signal after the record clears it too', T, async () => {
    const { planId, sessionId } = await mcpPlan(1);
    await silence(planId, SILENT_MS);
    await abandonedPlanService.reconcileAbandoned();
    expect((await sessionRow(sessionId)).failedAt).not.toBeNull();

    await plansService.reportPlanStep(
      planId,
      { sessionKey: 'planner-1', step: 'settle', targetRef: null },
      fx.ctx,
    );

    expect((await sessionRow(sessionId)).failedAt).toBeNull();
    // And the next pass sees a plan that is writing again.
    const next = await abandonedPlanService.reconcileAbandoned();
    expect(next.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'writing' });
  });

  it('a write to a plan that is NOT the session’s latest clears nothing', T, async () => {
    // The clear is for the plan the failure is about. A session that moved on to a
    // newer plan keeps its record when an older one is written to.
    const { planId, sessionId } = await mcpPlan(1);
    await silence(planId, SILENT_MS);
    await abandonedPlanService.reconcileAbandoned();
    const newer = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId,
        status: 'generating',
        createdAt: new Date(Date.now() + MINUTE),
      },
    });

    await plansService.reportPlanStep(
      planId,
      { sessionKey: 'planner-1', step: 'settle', targetRef: null },
      fx.ctx,
    );

    expect((await sessionRow(sessionId)).failedAt).not.toBeNull();
    expect(newer.id).not.toBe(planId);
  });
});

describe('a write RACING the sweep wins', () => {
  it(
    'a write between the read and the record moves the stamp, and nothing is recorded',
    T,
    async () => {
      const { planId, sessionId } = await mcpPlan(1);
      await withJob(planId, 'job-racing');
      await silence(planId, SILENT_MS);

      // Unreachable, so the verdict is the silence rule's and the write path runs
      // (MOTIR-11258: a `running` answer would keep the plan before it).
      const unreachable = {
        jobId: 'job-racing',
        status: null,
        reachable: false,
        failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'connect ECONNREFUSED' },
      } as unknown as PlanJobStateDto;
      const summary = await abandonedPlanService.reconcileAbandoned({
        deps: deps(unreachable, async () => {
          // The producer comes back WHILE the sweep is asking motir-ai about it.
          await plansService.reportPlanStep(
            planId,
            { sessionKey: 'planner-1', step: 'settle', targetRef: null },
            fx.ctx,
          );
        }),
      });

      expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
      const session = await sessionRow(sessionId);
      expect(session.failedAt).toBeNull();
      expect(session.endedAt).toBeNull();
      expect((await planRow(planId)).status).toBe('generating');
    },
  );

  it(
    'run concurrently, 10 times: whichever lands first, the session never ends up failed',
    { timeout: 180_000 },
    async () => {
      // Every interleaving resolves the same way. A write before discovery leaves a
      // plan that is writing; a write between discovery and the record fails the
      // compare-and-set; a write after the record clears it.
      for (let i = 0; i < 10; i += 1) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const { planId, sessionId } = await mcpPlan(1);
        await silence(planId, SILENT_MS);

        const results = await Promise.allSettled([
          abandonedPlanService.reconcileAbandoned(),
          plansService.reportPlanStep(
            planId,
            { sessionKey: `planner-${i}`, step: 'settle', targetRef: null },
            fx.ctx,
          ),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const session = await sessionRow(sessionId);
        expect(session.failedAt).toBeNull();
        expect(session.endedAt).toBeNull();
        expect((await planRow(planId)).status).toBe('generating');
      }
    },
  );
});
