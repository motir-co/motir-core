import { defineJob } from '../defineJob';

// Planning-target lease sweep (Story MOTIR-2786 · MOTIR-2787) — the RECOVERY
// half of the `planning` status lock, scheduled on the 1.6 cron primitive like
// `rateLimitSweep`.
//
// WHY IT IS THE PRIMARY RECOVERY PATH AND NOT A BACKSTOP. Every other release is
// driven by a product event: a plan is approved, a plan is declined. None of
// those fire for the failures that actually strand a lock — a planner that
// crashes, a machine that vanishes mid-job (MOTIR-2783 shows a `running` job row
// whose machine is gone is never re-claimed), a redeploy, a user who closes the
// tab and never comes back. `PlanStatus` has no `failed` member, so a plan whose
// job died sits at `generating` until something goes and asks — which
// MOTIR-3064's abandoned-plan sweep now does, hourly, and only for a plan with no
// proposals in it. That does not make this one a backstop: it reconciles the
// PLAN, on a cadence set by the pause it lifts, while a stranded lease holds an
// item NOBODY can plan and has to come back in minutes whatever the plan row
// says. The only signal left HERE is still the passage of time, which is what
// this reads.
//
// And the failure it recovers is the one the story calls worse than the race the
// lock prevents: a race produces a confusing tree a person can repair; a lock
// that is never released produces an item NOBODY can plan again, with no
// user-facing remedy — discovered by a customer rather than by us.
//
// System-scoped: expired leases span workspaces, so the discovery read runs under
// `withSystemContext` (the table carries a `FOR SELECT` `app.system_admin` arm
// for exactly this) and each release then re-binds to that row's own workspace,
// so no write is ever untenanted.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction — a
// released lease stops matching `expires_at <= now`, and a pass that finds
// nothing stops. Bounded per run (`PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE`), so a
// backlog drains over several passes rather than holding locks across a large
// slice of the table in one.

/**
 * Every 5 minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`,
 * `lib/jobs/schedules.ts`).
 *
 * FAR more often than the daily housekeeping sweeps beside it, and deliberately:
 * those reclaim space, and this one unblocks a person who is trying to work. The
 * cost of the cadence is one indexed read of `(expires_at)` that returns nothing
 * almost every time; the cost of running it daily would be telling someone their
 * epic is unplannable until tomorrow.
 *
 *   worst-case wait for a stranded lease  =  the 30-minute LEASE + the sweep gap
 *                                         =  30 + 5  =  35 min
 *
 * The lease dominates the total wait; this cadence only decides how much is added
 * to it.
 */
export const PLAN_TARGET_LOCK_SWEEP_CRON = '*/5 * * * *';

export const planTargetLockSweep = defineJob(
  {
    id: 'system.plan-target-lock-sweep',
    cron: PLAN_TARGET_LOCK_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // THE REPLY-WAIT PASS before everything else (MOTIR-7913): a conversation the planner
    // replied to and the person left is marked and gated here, so the idle close below
    // never reaches a session this pass is about to mark.
    await ctx.step.run('raise-awaiting-reply-planning-sessions', () =>
      services.planningSessionGate.raiseAwaitingReplies(),
    );
    // The IDLE CLOSE next (AMENDMENT 23 §2; MOTIR-7638): ending an idle session
    // gives back everything it held, so the lease release below then finds only
    // the leases of sessions that are NOT idle — a session whose plan waits for a
    // decision, which keeps its plan-held locks for its reviewer.
    const idle = await ctx.step.run('close-idle-planning-sessions', () =>
      services.planSessionEnd.closeIdleSessions(),
    );
    // A revision whose lease LAPSED gives the plan it re-opened back to `planned`
    // (Bug MOTIR-8208), so a revision that stopped writing never leaves its plan
    // `generating` with nobody writing it for longer than one interval.
    await ctx.step.run('release-lapsed-plan-revisions', () =>
      services.planSessionEnd.releaseLapsedRevisions(),
    );
    // An approval whose approver died between its claim and its commit gives its plan
    // back to `planned` (Bug MOTIR-9006), so a plan never reads *Approving…* for longer
    // than the stalled-approval bound plus one interval.
    await ctx.step.run('release-stalled-plan-approvals', () =>
      services.stalledPlanApproval.releaseStalledApprovals(),
    );
    const released = await ctx.step.run('release-expired-planning-locks', () =>
      services.planTargetLock.releaseExpired(),
    );
    // The lease release's own shape, unchanged, with the idle close beside it.
    return { ...released, idle };
  },
);
