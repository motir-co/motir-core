import { defineJob } from '../defineJob';

// ABANDONED-PLAN sweep (MOTIR-3064) — the reconciler that gives a dead
// generation job's plan a terminal status, so it stops reading as a proposal
// somebody owes a decision on.
//
// WHY A CRON AND NOT AN EVENT. Every other plan transition is driven by a product
// event: a producer appends, a person approves, a person declines. None of them
// fire for the failure this recovers. motir-ai's inbound seams into core are the
// success path, so a job that fails writes nothing here; and a motir-ai worker
// that dies mid-job writes nothing ANYWHERE — its row reads `running` until a read
// reaps its lapsed lease and turns it `failed` (motir-ai MOTIR-8303). The only
// thing left is to go and ask, which is what this does — and the answer is what
// decides: a job motir-ai reports `running` or `queued` keeps its plan however
// quiet the plan is, and only a plan whose job cannot be asked (motir-ai
// unreachable, or no job) is judged by its silence (MOTIR-11258).
//
// The harm it undoes is quiet and permanent: `planRepository.findUndecidedByProject`
// reads `generating` as UNDECIDED, that read is the pending-proposal gate
// `autoPlanCadenceService` checks first, so one abandoned plan pauses that
// project's auto-planning for good — and the settings page reports it as a
// proposal waiting for a decision nobody can make.
//
// System-scoped (cross-workspace): the discovery read runs under
// `withSystemContext` against the plan policy's `FOR SELECT` `app.system_admin`
// arm; each write re-binds to that plan's own workspace, so nothing untenanted is
// ever written. The ledger row is untenanted, like every `system.*` job.
//
// `retryPolicy: 'idempotent'`: the pass is a pure recompute from live state — a
// reconciled plan is no longer `generating` so it stops matching, an in-flight
// one is re-asked and left alone again, a recorded one is spared as waiting, and
// a pass that finds nothing stops.
// Bounded per run (`ABANDONED_PLAN_SWEEP_BATCH_SIZE`).

/**
 * Every five minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`,
 * `lib/jobs/schedules.ts`) every sub-hourly `system.*` job shares (MOTIR-8132;
 * MOTIR-8130 §5).
 *
 * The sweep judges a plan it cannot ask about by its SILENCE against
 * `PLAN_STALLED_AFTER_MS`, so its period is part of how late such a dead plan is
 * noticed: 15 minutes of silence plus one period, ≤ 20 minutes here against 75
 * hourly. A job motir-ai already reports failed, canceled or gone — a worker that
 * died included, once its 120 s lease lapses and the read reaps it — is caught
 * within one period, and a job it reports `running` is never judged by silence
 * (MOTIR-11258). `*\/5` IS the conforming cadence, so it needs no
 * `SUB_HOURLY_CADENCE_EXCEPTIONS` entry.
 *
 * The old ordering argument still holds: the cadence tick (`30 * * * *`) is this
 * sweep's consumer, and a pass always runs in the half hour before it, so a plan
 * freed this hour unpauses its project's planning in the same hour's tick. The cost
 * of a pass is one indexed read of the `generating` set (≤ 50 rows) plus one
 * motir-ai ask per selected plan that has a job.
 */
export const ABANDONED_PLAN_SWEEP_CRON = '*/5 * * * *';

export const abandonedPlanSweep = defineJob(
  {
    id: 'system.abandoned-plan-sweep',
    cron: ABANDONED_PLAN_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('reconcile-abandoned-plans-v3', () =>
      services.abandonedPlan.reconcileAbandoned(),
    );
  },
);
