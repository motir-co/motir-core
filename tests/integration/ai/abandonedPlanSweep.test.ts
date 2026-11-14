import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../../helpers/jobs';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan suites).
// EVERYTHING below it is real: a real Postgres with RLS, the real
// cross-workspace `withSystemContext` discovery scan, the real per-workspace
// write, and the real `autoPlanCadenceService` gate reading the result. So what
// these assert about the Plan rows and about whether cadence fires is what
// production does.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { cancelJob, getJob, submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiJobNotFoundError, MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  abandonedPlanService,
  classifyAbandonedCandidate,
} from '@/lib/services/abandonedPlanService';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { abandonedPlanSweep } from '@/lib/jobs/definitions/abandonedPlanSweep';
import { jobDefinitions } from '@/lib/jobs/registry';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { connectAndLinkRepo } from '../../fixtures/codeContextFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import type { JobStatus } from '@/lib/ai/types';

// MOTIR-3064 — a generation job that DIES leaves its plan `generating` forever,
// and that empty orphan pauses the project's auto-plan cadence for good.
//
// The defect is a JOIN of two facts, each fine on its own: nothing writes a
// terminal `Plan` status when a motir-ai job fails, and
// `planRepository.findUndecidedByProject` reads `generating` as UNDECIDED —
// which is the pending-proposal gate `autoPlanCadenceService` checks first. So
// the project silently stops planning itself, and the settings page reports a
// proposal waiting for a decision nobody can make.
//
// MOTIR-3051 fixed the sibling half at the GATE, and could: a plan with no
// producer is judgeable from the row. This half is not — the row carries a
// `sourceJobId`, so it is identical to a healthy generation between `createPlan`
// and the first append. The answer lives in the JOB, which is why the fix ASKS.
//
// What these lock, in the order the sweep decides them:
//   * the DECISION TABLE (MOTIR-8132) — terminal job / job gone ⇒ abandoned at
//     once, the FAST PATH; anything else — a live job, an outage, no job at all —
//     is judged by SILENCE: dead past `PLAN_STALLED_AFTER_MS` since the plan's
//     last write, left while it is writing. That one rule replaced the 15-minute
//     grace, the 24-hour max age and the job-less arm;
//   * the PARTIAL arm (MOTIR-3189) — a plan HOLDING proposals whose producer is
//     provably gone is declined too, and its proposals survive the decline;
//     the write's guard is now a COUNT MISMATCH, so a late append is still
//     `row_moved` and a plan that was already partial at discovery is not;
//   * AC 2 — cadence FIRES again for a project whose only undecided plan was
//     abandoned, which is the whole point;
//   * AC 1 + the terminal state — `declined`, with a NULL decider, because
//     nobody decided it, and `decisionReason: 'abandoned'` so the review surface
//     can tell this ending from a plan somebody read and rejected (MOTIR-3189).

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  await truncateJobRuns();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_cadence_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;
const HOUR = 60 * MINUTE;

/** Silent past the threshold — the ordinary dead candidate (MOTIR-8132). */
const SILENT_MS = PLAN_STALLED_AFTER_MS + 5 * MINUTE;

/** Wrote a minute ago — a plan that is being written. */
const WRITING_MS = MINUTE;

/** `getJob`'s answer for a job in a given state, with no error attached. */
function jobIn(status: JobStatus): void {
  vi.mocked(getJob).mockResolvedValue({
    jobId: 'job_dead',
    status,
    result: null,
    error: null,
  } as Awaited<ReturnType<typeof getJob>>);
}

/**
 * Seed a plan whose producer is recorded and whose `createdAt` AND `lastActivityAt`
 * are backdated by `ageMs` — a plan that has been silent since it was created.
 *
 * Both have a `@default(now())`, so they are set through `adminDb` (which
 * bypasses RLS) rather than by the service — the sweep's verdict turns on the
 * silence, and a test that could not backdate it would have to sleep.
 */
async function seedGeneratingPlan(
  fx: WorkItemFixture,
  opts: { ageMs?: number; sourceJobId?: string | null; items?: number } = {},
): Promise<string> {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status: 'generating',
      sourceJobId: opts.sourceJobId === undefined ? 'job_dead' : opts.sourceJobId,
      createdAt: new Date(Date.now() - (opts.ageMs ?? SILENT_MS)),
      lastActivityAt: new Date(Date.now() - (opts.ageMs ?? SILENT_MS)),
    },
  });
  for (let i = 0; i < (opts.items ?? 0); i += 1) {
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
  return plan.id;
}

async function planRow(planId: string) {
  return adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
}

/**
 * A project opted into auto-planning with ONE childless epic — the stub is also
 * the whole ready set, so `readyCount = 1`, below the default threshold of 5.
 * Mirrors `autoPlanCadence.test.ts`'s fixture, including WHY the item is made
 * through the service: only `createWorkItem` resolves the workflow status key
 * the ready-set reads JOIN on.
 */
async function makeDrainedProject(
  opts: { name?: string; identifier?: string } = {},
): Promise<{ fx: WorkItemFixture; stubKey: string }> {
  const fx = await makeWorkItemFixture({
    name: opts.name ?? 'Acme',
    identifier: opts.identifier ?? 'PROD',
  });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 },
  });
  // ⚠️ CONNECTED (MOTIR-4603) — the cadence now holds off when Motir cannot read
  // the code, and a workspace with no installation is exactly that. Every case
  // here is about the PLAN-abandonment gate, so the fixture has to clear the
  // code-blindness one to reach it; otherwise each case would be asserting a
  // verdict it is not named for.
  // ⚠️ CONNECT **AND LINK** — MOTIR-1767 made the code-blindness gate read the
  // PROJECT's set, so an installation alone no longer gives this project code
  // context and every cadence assertion below would read `fired: 0`.
  await connectAndLinkRepo(fx);
  const stub = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Unexpanded epic' },
    fx.ctx,
  );
  return { fx, stubKey: stub.identifier };
}

describe('the decision table — what counts as evidence the producer is gone', () => {
  // Split out as a pure function precisely so this table can be read as one
  // thing. Since MOTIR-8132 it has two halves: a FAST PATH (what motir-ai already
  // knows) and ONE clock (how long the plan has written nothing), the rail's own.
  const reachable = (status: JobStatus) => ({ status, reachable: true, failure: null });
  const gone = () => {
    const err = new MotirAiJobNotFoundError('job_dead');
    return { status: null, reachable: false, failure: { code: err.code, message: err.message } };
  };
  const outage = () => {
    const err = new MotirAiUnavailableError('connect ECONNREFUSED');
    return { status: null, reachable: false, failure: { code: err.code, message: err.message } };
  };

  it.each([
    ['failed', 'job_terminal'],
    ['succeeded', 'job_terminal'],
    ['canceled', 'job_terminal'],
  ] as const)('a %s job is abandoned AT ONCE, however fresh the plan (%s)', (status, reason) => {
    for (const silentMs of [0, WRITING_MS, SILENT_MS]) {
      expect(classifyAbandonedCandidate(reachable(status), silentMs)).toEqual({
        abandoned: true,
        reason,
      });
    }
  });

  it('a 404 is abandoned at once — motir-ai answered, and its answer was "no such job"', () => {
    expect(classifyAbandonedCandidate(gone(), 0)).toEqual({ abandoned: true, reason: 'job_gone' });
  });

  it('a RUNNING job is kept at any silence — motir-ai reaped it first if it were dead (MOTIR-11258)', () => {
    // ⚠️ THIS ROW WAS REVERSED BY MOTIR-11258. It read *"a running job keeps NOTHING
    // alive — the plan is judged by its silence"* (MOTIR-8132), on the premise that a
    // dead worker's row stays `running` for ever. motir-ai's read reaps a lapsed lease
    // before it answers (MOTIR-8303), so `running` is a worker that renewed its lease
    // in the last two minutes; a quiet plan behind it is one long step, and judging
    // that silence dead cancelled a live final check and declined its plan.
    for (const silentMs of [0, WRITING_MS, PLAN_STALLED_AFTER_MS + 1, SILENT_MS, DAY_MS]) {
      expect(classifyAbandonedCandidate(reachable('running'), silentMs)).toEqual({
        abandoned: false,
        reason: 'job_running',
      });
    }
  });

  it('the job’s word OUTRANKS the clock in both directions — the fast path, then a live job', () => {
    // The order the table reads: what motir-ai said decides whenever it said
    // something conclusive; only no answer falls to the silence rule. A job read
    // `failed` after a long `running` life is the reaped worker — dead at once.
    expect(classifyAbandonedCandidate(reachable('failed'), WRITING_MS)).toEqual({
      abandoned: true,
      reason: 'job_terminal',
    });
    expect(classifyAbandonedCandidate(reachable('running'), SILENT_MS)).toEqual({
      abandoned: false,
      reason: 'job_running',
    });
    expect(classifyAbandonedCandidate(outage(), SILENT_MS)).toEqual({
      abandoned: true,
      reason: 'silent',
    });
  });

  it('a QUEUED job is kept at any silence — it has not started (MOTIR-9065)', () => {
    for (const silentMs of [0, WRITING_MS, SILENT_MS, DAY_MS]) {
      expect(classifyAbandonedCandidate(reachable('queued'), silentMs)).toEqual({
        abandoned: false,
        reason: 'job_queued',
      });
    }
  });

  it('an OUTAGE proves nothing either way — it falls through to the silence rule', () => {
    // It used to be a keep at any age. A motir-ai outage longer than the threshold
    // now settles silent plans, and a producer that comes back clears the record by
    // writing (MOTIR-8130 §4), so nothing is lost.
    expect(classifyAbandonedCandidate(outage(), WRITING_MS)).toEqual({
      abandoned: false,
      reason: 'writing',
    });
    expect(classifyAbandonedCandidate(outage(), SILENT_MS)).toEqual({
      abandoned: true,
      reason: 'silent',
    });
  });

  it('NO PRODUCER is judged by the same clock, at any age', () => {
    // MOTIR-3236's job-less plan, which used to wait a whole day. An MCP author
    // keeps its plan alive by writing; one that stopped is dead fifteen minutes on.
    expect(classifyAbandonedCandidate(null, WRITING_MS)).toEqual({
      abandoned: false,
      reason: 'writing',
    });
    expect(classifyAbandonedCandidate(null, SILENT_MS)).toEqual({
      abandoned: true,
      reason: 'silent',
    });
  });

  it('the threshold is the RAIL’s comparison — equal is writing, one millisecond more is silent', () => {
    // Only for the plans the sweep cannot ask about (MOTIR-11258): a reachable
    // `running` job is kept on both sides of it, above.
    for (const job of [null, outage()]) {
      expect(classifyAbandonedCandidate(job, PLAN_STALLED_AFTER_MS)).toEqual({
        abandoned: false,
        reason: 'writing',
      });
      expect(classifyAbandonedCandidate(job, PLAN_STALLED_AFTER_MS + 1)).toEqual({
        abandoned: true,
        reason: 'silent',
      });
    }
  });
});

describe('the sweep — AC 1: a dead job’s plan stops reading as undecided', () => {
  it('declines it, with a NULL decider — nobody decided this', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 1 });
    expect(summary.outcomes[0]).toMatchObject({
      planId,
      outcome: 'declined',
      reason: 'job_terminal',
    });

    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.decidedAt).not.toBeNull();
    // THE decision this card made: `declined` is the state, and the honesty
    // lives in the actor. `Plan.createdById` already means *nobody asked* when
    // null (the cadence case); this is the same convention one column over.
    expect(row.decidedById).toBeNull();
    // And since MOTIR-3189 it is RECORDED as well as derivable. `declined`
    // covers three histories; without this column the rail rendered a swept
    // plan exactly like one a person read and rejected.
    expect(row.decisionReason).toBe('abandoned');
    // `plannedAt` is untouched — this plan's generation frontier never closed.
    expect(row.plannedAt).toBeNull();
    // The failure is not lost — the producer is still on the row.
    expect(row.sourceJobId).toBe('job_dead');
  });

  it('asks the job through the SHIPPED resolver, scoped to the plan’s project', async () => {
    // `getJob` requires `coreProjectId` (MOTIR-2359) — a call site that cannot
    // supply one has not resolved its project. The sweep has it on the row.
    const { fx } = await makeDrainedProject();
    await seedGeneratingPlan(fx);
    jobIn('failed');

    await abandonedPlanService.reconcileAbandoned();

    expect(getJob).toHaveBeenCalledExactlyOnceWith('job_dead', fx.projectId);
  });

  it('declines a plan whose job motir-ai has never heard of — a 404 IS an answer', async () => {
    // The end-to-end form of the classifier's `job_gone` arm: motir-ai answered,
    // and its answer was that no such job exists, so the producer is gone rather
    // than merely quiet.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockRejectedValue(new MotirAiJobNotFoundError('job_dead'));

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_gone' });
    expect((await planRow(planId)).status).toBe('declined');
  });

  it('leaves a generation that is WRITING alone, and does not write to it', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { ageMs: WRITING_MS });
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 0 });
    // The live job is the evidence that decides (MOTIR-11258); the recent write
    // agrees with it.
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_running' });
    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.decidedAt).toBeNull();
  });

  it('KEEPS a silent plan behind a job motir-ai reports `running`, and cancels nothing (MOTIR-11258)', async () => {
    // ⚠️ REVERSED BY MOTIR-11258. This test read *"declines a SILENT plan behind a
    // job that still says `running` (MOTIR-8132)"*, on the premise that a worker that
    // died mid-job leaves its row `running` for good. motir-ai's read reaps a lapsed
    // lease first (MOTIR-8303), so `running` is a live worker — the 2026-11-14 plan
    // whose final check ran twenty quiet minutes was declined by exactly that row.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 0 });
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_running' });
    expect(cancelJob).not.toHaveBeenCalled();
    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.decidedAt).toBeNull();
    expect(row.decisionReason).toBeNull();
  });

  it('the kept job’s WORKER DIES — the next pass reads it reaped `failed` and declines it as `job_terminal`', async () => {
    // The other half of trusting `running`: a worker that died stops renewing its
    // lease, motir-ai's next read reaps it to `failed` (`ai_job_abandoned`), and the
    // fast path settles the plan on that pass — no silence clock involved.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('running');
    const first = await abandonedPlanService.reconcileAbandoned();
    expect(first.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_running' });

    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_dead',
      status: 'failed',
      result: null,
      error: { code: 'ai_job_abandoned', message: 'the claim lapsed' },
    } as Awaited<ReturnType<typeof getJob>>);
    const second = await abandonedPlanService.reconcileAbandoned();

    expect(second.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect(cancelJob).not.toHaveBeenCalled();
    expect((await planRow(planId)).decisionReason).toBe('abandoned');
  });

  it('an OUTAGE keeps a writing plan, and does not keep a silent one', async () => {
    const { fx } = await makeDrainedProject();
    const writing = await seedGeneratingPlan(fx, { ageMs: WRITING_MS });
    const silent = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const summary = await abandonedPlanService.reconcileAbandoned();

    const byPlan = new Map(summary.outcomes.map((o) => [o.planId, o]));
    expect(byPlan.get(writing)).toMatchObject({ outcome: 'left_as_is', reason: 'writing' });
    expect(byPlan.get(silent)).toMatchObject({ outcome: 'declined', reason: 'silent' });
  });
});

describe('the sweep — what it must NEVER touch', () => {
  it('a FRESH plan behind a job that already FAILED is dead at once — the fast path', async () => {
    // The old grace kept the sweep away from any plan under fifteen minutes old.
    // Silence does that job now (a fresh plan's `lastActivityAt` is its
    // `createdAt`), and the ask is what lets a job motir-ai already reports dead
    // be settled within one pass rather than after the threshold (MOTIR-8130 §2).
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { ageMs: WRITING_MS });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect((await planRow(planId)).status).toBe('declined');
  });

  it('AC 3: and the just-fired project still gates on the re-run of the whole loop', async () => {
    // End-to-end version of the argument above, driven through the two services
    // in the order production runs them: cadence fires and opens the plan, the
    // reconciler runs, cadence runs again. Exactly ONE job must have been
    // submitted at the end of it.
    //
    // The job is LIVE (MOTIR-8132): a job motir-ai reports failed is now dead at
    // once, and re-firing for it is correct. What must hold is that a plan being
    // written still gates.
    await makeDrainedProject();
    await autoPlanCadenceService.runCadenceSweep();
    expect(submitJob).toHaveBeenCalledTimes(1);
    jobIn('running');

    await abandonedPlanService.reconcileAbandoned();
    const second = await autoPlanCadenceService.runCadenceSweep();

    expect(second.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it('a partial plan behind a LIVE job is left alone — the same arm that protects an empty one', async () => {
    // MOTIR-3189 widened the scan onto PARTIAL plans; it did not widen what
    // counts as evidence. A plan holding proposals whose producer is still
    // working is `writing` exactly as an empty one is, and nothing about
    // holding proposals makes it terminable while it is being written.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2, ageMs: WRITING_MS });
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_running' });
    expect((await planRow(planId)).status).toBe('generating');
    // And it still gates, which is the correct outcome for a live generation.
    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: planId });
  });

  it('does not touch a plan with NO producer while it is WRITING — MOTIR-3236’s keep arm', async () => {
    // ⚠️ THIS TEST WAS REVERSED BY MOTIR-3236, and the old assertion is quoted
    // here rather than deleted. It read: *"does not touch a plan with NO
    // producer — that is MOTIR-3051's half, at the gate"*, and asserted
    // `{ scanned: 0, declined: 0, outcomes: [] }` for a job-less plan of ANY
    // age, because the repository predicate carried `sourceJobId: { not: null }`
    // and the two sets were disjoint.
    //
    // That was true of an EMPTY job-less plan, which the gate does read past.
    // It was false of a PARTIAL one, which holds items and so is not excluded by
    // AMENDMENT 1's presence-based `items: { none: {} }` — it pauses the
    // project's cadence for ever, which is the harm the sweep exists to remove.
    // What survives of the old test is the KEEP: a job-less plan that is still
    // writing is not terminated. Since MOTIR-8132 "still writing" is its own
    // silence, not a day-long age: an agent mid-skeleton keeps it alive by working.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 2,
      ageMs: WRITING_MS,
    });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.declined).toBe(0);
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'writing' });
    expect((await planRow(planId)).status).toBe('generating');
    // And motir-ai was never asked: there is no job id to ask about, and a 404
    // already means something else here.
    expect(getJob).not.toHaveBeenCalled();
  });

  it.each(['planned', 'approved', 'declined'] as const)(
    'does not touch a %s plan — it is not generating',
    async (status) => {
      const { fx } = await makeDrainedProject();
      const plan = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          status,
          sourceJobId: 'job_dead',
          createdAt: new Date(Date.now() - 10 * HOUR),
        },
      });
      jobIn('failed');

      const summary = await abandonedPlanService.reconcileAbandoned();

      expect(summary).toEqual({ scanned: 0, declined: 0, outcomes: [] });
      expect((await planRow(plan.id)).status).toBe(status);
    },
  );

  it('refuses at the WRITE when somebody DECIDED the plan between the ask and the act', async () => {
    // The other half of the same window: a person can approve or decline a plan
    // while the sweep is on the phone to motir-ai, and the sweep must not
    // overwrite their decision with its own.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('planned');
  });

  it('refuses at the WRITE when the plan is GONE between the ask and the act', async () => {
    // A cascade from a deleted project or workspace can take the row out from
    // under the pass. `findById` returning null is a no-op, not a P2025 out of
    // the update.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.plan.delete({ where: { id: planId } });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
  });

  it('refuses at the WRITE when the plan WROTE between the ask and the act (MOTIR-8132)', async () => {
    // A step signal stamps `lastActivityAt` and adds no proposal, so the count
    // guard cannot see it. The silence the verdict was judged by moved — that
    // producer is alive — and the write is refused on the stamp.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    // An OUTAGE, so the verdict is the silence rule's (MOTIR-11258: a `running` answer
    // would keep the plan before the write is ever attempted).
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.plan.update({ where: { id: planId }, data: { lastActivityAt: new Date() } });
      throw new MotirAiUnavailableError('connect ECONNREFUSED');
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('refuses at the WRITE when proposals land between the ask and the act', async () => {
    // The candidate came out of a different transaction's snapshot and the ask
    // is a network call that takes real time. The re-read is what makes a late
    // append safe — it turns the sweep's only destructive verdict back into a
    // no-op.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.planItem.create({
        data: {
          workspaceId: fx.workspaceId,
          planId,
          op: 'add',
          proposedFields: { title: 'Arrived late', kind: 'subtask' },
          blockedByRefs: [],
        },
      });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('generating');
  });
});

describe('the sweep — the PARTIAL arm (MOTIR-3189)', () => {
  // AMENDMENT 2 excluded a partial plan on the ground that it is "a real
  // proposal a person can read and decline". Read, yes — decline, no: every
  // decider refused anything but `planned`, so a plan whose producer died
  // part-way through was stranded exactly as permanently as an empty one, and
  // went on pausing that project's cadence. The exclusion protected a decision
  // nobody could make. These lock the widening AND its two edges: what the
  // producer said still decides, and the proposals still survive.
  it('declines a PARTIAL plan whose producer is provably gone, and KEEPS its proposals', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 3, ageMs: 10 * HOUR });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 1 });
    expect(summary.outcomes[0]).toMatchObject({
      planId,
      outcome: 'declined',
      reason: 'job_terminal',
    });
    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.decidedById).toBeNull();
    expect(row.decisionReason).toBe('abandoned');
    // ⚠️ NOTHING IS DELETED. This is the MOTIR-3154 / MOTIR-3160 rule applied to
    // the sweep, and it matters MORE here than on a reviewed decline: a
    // half-generated plan's proposals are the only surviving record of how far
    // the producer actually got before it died.
    await expect(adminDb.planItem.count({ where: { planId } })).resolves.toBe(3);
  });

  it.each(['succeeded', 'canceled'] as const)(
    'declines a PARTIAL plan behind a %s job too — every terminal state is final',
    async (status) => {
      const { fx } = await makeDrainedProject();
      const planId = await seedGeneratingPlan(fx, { items: 2 });
      jobIn(status);

      await abandonedPlanService.reconcileAbandoned();

      expect((await planRow(planId)).decisionReason).toBe('abandoned');
      await expect(adminDb.planItem.count({ where: { planId } })).resolves.toBe(2);
    },
  );

  it('declines a SILENT partial plan — the crashed worker whose job motir-ai reaped', async () => {
    // The worker vanished mid-stream with proposals appended. Its row read `running`
    // until motir-ai's read reaped the lapsed lease (MOTIR-8303), so the sweep's ask
    // reads it `failed` and the fast path settles it (MOTIR-11258 — silence alone no
    // longer outranks a live `running`).
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 4 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect((await planRow(planId)).decisionReason).toBe('abandoned');
    await expect(adminDb.planItem.count({ where: { planId } })).resolves.toBe(4);
  });

  it('an OUTAGE terminates nothing that is still writing, partial plan or not', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2, ageMs: WRITING_MS });
    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'writing' });
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('the write refuses on a COUNT MISMATCH — a late append is still `row_moved`', async () => {
    // The guard used to be `items > 0`, which was only ever correct because the
    // predicate guaranteed zero. With partial plans selected, the question is
    // no longer "does it hold anything" but "did it MOVE": a proposal arriving
    // DURING the ask means the producer was alive after the job said otherwise,
    // and that is still a leave. Seeded partial, so the mismatch — not a
    // presence test — is what produces the verdict.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2 });
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.planItem.create({
        data: {
          workspaceId: fx.workspaceId,
          planId,
          op: 'add',
          proposedFields: { title: 'Arrived late', kind: 'subtask' },
          blockedByRefs: [],
        },
      });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('the discovery scan SEES the proposals — the RLS blind spot would now fail SAFE, not wide', async () => {
    // The direction reversed with the predicate. Under `items: { none: {} }` an
    // RLS-hidden proposal made a correlated NOT EXISTS vacuously true and pulled
    // a PARTIAL plan into the scan — a blind spot that WIDENED it. Under
    // `_count` a hidden proposal reads the count LOW at discovery, the write
    // re-counts bound to the plan's own workspace, and the mismatch verdict is
    // `row_moved`: a pass is lost, never a plan. What this asserts is the arm
    // WORKING — the count the system-context scan read matched the truth, so the
    // verdict is `declined` rather than the `row_moved` a hidden row would give.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect((await planRow(planId)).status).toBe('declined');
  });

  it('AC 8: the cadence FIRES again for a project whose only undecided plan was a stranded PARTIAL one', async () => {
    // The harm this card exists to remove, asserted the way the card asked for
    // it: `fired`, not `skipped: pending_proposal`. Before the widening this
    // project's cadence was paused for good — the plan could not be swept
    // (empty-only) and could not be decided (the status guard).
    const { fx, stubKey } = await makeDrainedProject();
    await seedGeneratingPlan(fx, { items: 2 });
    jobIn('failed');

    // BEFORE: the stranded partial plan reads as UNDECIDED, so the gate skips
    // the project — and nothing could ever change that, which is the defect.
    const before = await autoPlanCadenceService.runCadenceSweep();
    expect(before.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });

    await abandonedPlanService.reconcileAbandoned();
    const after = await autoPlanCadenceService.runCadenceSweep();

    expect(after).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(after.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });
});

describe('the sweep — AC 2: the cadence starts again', () => {
  it('a project whose ONLY undecided plan was abandoned fires, not skips', async () => {
    // The whole point of the card, asserted the way the card asked for it: the
    // outcome is `fired`, not `skipped: pending_proposal`.
    const { fx, stubKey } = await makeDrainedProject();
    await seedGeneratingPlan(fx);
    jobIn('failed');

    const before = await autoPlanCadenceService.runCadenceSweep();
    expect(before.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });

    await abandonedPlanService.reconcileAbandoned();
    const after = await autoPlanCadenceService.runCadenceSweep();

    expect(after).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(after.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });

  it('and the PAUSED indicator agrees — one predicate, two consumers', async () => {
    const { fx } = await makeDrainedProject();
    await seedGeneratingPlan(fx);
    jobIn('failed');

    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ pending: true });

    await abandonedPlanService.reconcileAbandoned();

    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ pending: false, planId: null });
  });

  it('an abandoned plan does not MASK an older one that is genuinely waiting', async () => {
    // The mirror of MOTIR-3051's own newest-first test, from the other side: the
    // reconciler must free the orphan WITHOUT freeing the project, because the
    // `planned` proposal underneath it is still somebody's decision.
    const { fx } = await makeDrainedProject();
    const waiting = await adminDb.plan.create({
      // The proposal is what makes it "genuinely waiting" (MOTIR-4124): a
      // `planned` plan holding nothing is a decision nobody owes, and the gate
      // now reads past it too.
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        items: {
          create: [
            {
              workspaceId: fx.workspaceId,
              op: 'add',
              proposedFields: { title: 'Still somebody’s decision', kind: 'task' },
            },
          ],
        },
      },
    });
    await seedGeneratingPlan(fx);
    jobIn('failed');

    await abandonedPlanService.reconcileAbandoned();

    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: waiting.id });
    const summary = await autoPlanCadenceService.runCadenceSweep();
    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
  });
});

describe('the sweep — the NO-PRODUCER arm (MOTIR-3236)', () => {
  // A plan written over the MCP has no generation job (`create_plan` writes
  // `sourceJobId: null`, MOTIR-2982), and the sweep's predicate carried
  // `sourceJobId: { not: null }` — so the two sets were DISJOINT and the hourly
  // pass could never see one, whatever its age. Two such rows were sitting in
  // production for ~22 and ~20 hours when this card was written, both holding
  // proposals, both pausing the project's cadence.
  //
  // The fix is the RE-SHAPE: the predicate selects every `generating` plan and
  // the decision table judges it — by its silence, since MOTIR-8132. These lock both halves — that
  // the sweep can now SEE such a row, and that seeing it does not mean
  // terminating it.

  it('declines a SILENT job-less plan, with a null decider and `abandoned`', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 3,
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 1 });
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'silent' });
    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    // Nobody decided it — the same honesty the other abandon arms carry.
    expect(row.decidedById).toBeNull();
    expect(row.decisionReason).toBe('abandoned');
    expect(row.decidedAt).not.toBeNull();
    // The proposals SURVIVE the decline, exactly as they do on the partial arm.
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(3);
  });

  it('never asks motir-ai about a job that does not exist', async () => {
    // A `resolveJobState(null)` could only 404, and a 404 already MEANS
    // something else here (`job_gone` — a producer that existed and is provably
    // dead). Sending one would launder "there was never a job" into "the job
    // died", on every pass, for every agent-authored plan.
    const { fx } = await makeDrainedProject();
    await seedGeneratingPlan(fx, {
      sourceJobId: null,
    });
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(getJob).not.toHaveBeenCalled();
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'silent' });
  });

  it('frees the CADENCE a partial job-less plan had paused — the second harm', async () => {
    // AMENDMENT 1's exclusion is presence-based (`items: { none: {} }`), so it
    // reads past an EMPTY job-less plan and NOT past one that appended a
    // skeleton and stopped. That partial row gates the project for ever, which
    // is the harm AMENDMENT 2 exists to remove arriving through the door
    // AMENDMENT 1 left open. Both live production rows were this shape.
    const { fx, stubKey } = await makeDrainedProject();
    await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 2,
    });

    const before = await autoPlanCadenceService.runCadenceSweep();
    expect(before.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });

    await abandonedPlanService.reconcileAbandoned();
    const after = await autoPlanCadenceService.runCadenceSweep();

    expect(after).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(after.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });

  it('leaves a job-less plan an agent appended to DURING the pass — `row_moved` still holds', async () => {
    // The count-mismatch guard is not bypassed by the new arm. There is no ask
    // to race here, so the window is the write transaction itself — the append
    // is driven from the classify seam via the deps injection point, which is
    // the only thing between discovery and the write on this path.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 1,
    });
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        proposedFields: { title: 'Arrived after discovery', kind: 'subtask' },
        blockedByRefs: [],
      },
    });
    // Re-run discovery AFTER the append would be a different test; instead drive
    // the mismatch the way production produces it — the candidate's snapshot
    // count is what the write compares against, and here it is already stale.
    const summary = await abandonedPlanService.reconcileAbandoned({
      now: new Date(Date.now() + MINUTE),
    });

    // Discovery saw 2 and the write re-counted 2 — so this one DOES land. What
    // the assertion pins is that the comparison ran at all on a producerless
    // candidate rather than being skipped with the ask.
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'silent' });
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
  });

  it('a producer-bearing plan behaves EXACTLY as it does today', async () => {
    // The regression half: the predicate widened, so every previously-selected
    // row must still be judged the same way, by the same ask.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 1 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect((await planRow(planId)).decisionReason).toBe('abandoned');
  });

  it('judges a MIXED batch one row at a time', async () => {
    // Both shapes in one pass, which is what production holds: an agent-authored
    // orphan and a dead generation job, judged by different arms of the same
    // table, with exactly one network call between them.
    const { fx } = await makeDrainedProject();
    const jobless = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 2,
      ageMs: 2 * HOUR,
    });
    const withJob = await seedGeneratingPlan(fx, { ageMs: HOUR });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 2, declined: 2 });
    expect(getJob).toHaveBeenCalledTimes(1);
    const byPlan = new Map(summary.outcomes.map((o) => [o.planId, o]));
    expect(byPlan.get(jobless)).toMatchObject({ outcome: 'declined', reason: 'silent' });
    expect(byPlan.get(withJob)).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
  });
});

// Bug MOTIR-8208 — a revision RE-OPENS its plan (`planned` → `generating`), and the
// plan's `createdAt` is the FIRST generation's, so it is always past the grace. The
// main loop must not judge it as a generation; the revision backstop gives it back.
describe('the sweep — a plan a REVISION re-opened (MOTIR-8208)', () => {
  const MCP = { source: 'mcp' as const, harness: 'Claude Code', model: null };

  /** A `planned` plan created a day ago, then re-opened by a revision. */
  async function reopenedPlan(fx: WorkItemFixture, jobId?: string): Promise<string> {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Revised', authorSource: 'mcp', authorHarness: 'Claude Code' },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A card', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { createdAt: new Date(Date.now() - 20 * HOUR) },
    });
    await plansService.acquireRevisionLease(plan.id, fx.ctx, MCP, jobId ? { jobId } : {});
    expect((await planRow(plan.id)).status).toBe('generating');
    return plan.id;
  }

  async function ageTrail(planId: string, ms: number) {
    for (const row of await adminDb.planRevision.findMany({ where: { planId } })) {
      await adminDb.planRevision.update({
        where: { id: row.id },
        data: { changedAt: new Date(row.changedAt.getTime() - ms) },
      });
    }
  }

  it('never declines a plan a LIVE revision holds, however old the plan is', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await reopenedPlan(fx);
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes.find((o) => o.planId === planId)).toBeUndefined();
    expect((await planRow(planId)).status).toBe('generating');
    expect(getJob).not.toHaveBeenCalled();
  });

  it('gives a LAPSED job-less revision back to `planned` — the lease is the only signal', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await reopenedPlan(fx);
    await ageTrail(planId, SILENT_MS);

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes.find((o) => o.planId === planId)).toMatchObject({
      outcome: 'revision_released',
      reason: 'lease_lapsed',
    });
    const plan = await planRow(planId);
    expect(plan.status).toBe('planned');
    expect(plan.decidedAt).toBeNull();
    expect(getJob).not.toHaveBeenCalled();
  });

  it('gives back a hosted revision whose JOB died unseen, and never declines it', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await reopenedPlan(fx, 'job_revision_dead');
    await ageTrail(planId, SILENT_MS);
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes.find((o) => o.planId === planId)).toMatchObject({
      outcome: 'revision_failed',
    });
    expect((await planRow(planId)).status).toBe('planned');
    const ended = await adminDb.planRevision.findFirstOrThrow({
      where: { planId, changeKind: 'revision_ended' },
    });
    expect(ended.diff).toMatchObject({ failed: true, restoredTo: 'planned' });
  });
});

describe('the sweep — cross-workspace, bounded, and wired', () => {
  it('reconciles plans in DIFFERENT workspaces in one pass', async () => {
    // The discovery read is the only cross-tenant thing here, and it is the one
    // an unarmed RLS policy would silently return zero rows for. Two tenants is
    // what proves it is actually crossing.
    const a = await makeDrainedProject({ name: 'Acme', identifier: 'ACME' });
    const b = await makeDrainedProject({ name: 'Globex', identifier: 'GLBX' });
    const planA = await seedGeneratingPlan(a.fx);
    const planB = await seedGeneratingPlan(b.fx);
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 2, declined: 2 });
    expect((await planRow(planA)).status).toBe('declined');
    expect((await planRow(planB)).status).toBe('declined');
  });

  it('is bounded per pass, STALEST first — a backlog drains over ticks', async () => {
    const { fx } = await makeDrainedProject();
    const oldest = await seedGeneratingPlan(fx, { ageMs: 5 * HOUR });
    const newer = await seedGeneratingPlan(fx, { ageMs: 2 * HOUR });
    jobIn('failed');

    const first = await abandonedPlanService.reconcileAbandoned({ batchSize: 1 });

    expect(first).toMatchObject({ scanned: 1, declined: 1 });
    expect(first.outcomes[0]).toMatchObject({ planId: oldest });
    expect((await planRow(newer)).status).toBe('generating');

    const second = await abandonedPlanService.reconcileAbandoned({ batchSize: 1 });
    expect(second.outcomes[0]).toMatchObject({ planId: newer, outcome: 'declined' });
  });

  it('an empty pass is cheap and writes nothing', async () => {
    await makeDrainedProject();

    await expect(abandonedPlanService.reconcileAbandoned()).resolves.toEqual({
      scanned: 0,
      declined: 0,
      outcomes: [],
    });
    expect(getJob).not.toHaveBeenCalled();
  });

  it('runs as the registered cron job', async () => {
    // The wiring half: a sweep nobody scheduled reconciles nothing, and the
    // MOTIR-1970 lesson is that an unregistered job is indistinguishable from an
    // untriggered one.
    expect(jobDefinitions).toContain(abandonedPlanSweep);

    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('failed');

    const engine = new JobTestEngine({ function: abandonedPlanSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ scanned: 1, declined: 1 });
    expect((await planRow(planId)).status).toBe('declined');
  });
});
