import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import { dispatchSystemEvent } from '../sendEvent';
import { transactionTimeoutHalf } from '@/lib/monitoring/transactionStall';
import { ciRunnerBootEvent } from '@/lib/ciFleet/bootDispatch';
import type { ReconcileOutcome } from '@/lib/services/ciRunnerReconcileService';

// The runner FLEET's background jobs (Story MOTIR-1916 · MOTIR-1921) — the
// trigger, the boot, and the backstop.
//
// Two functions:
//
//   * `system.ci-runner-provision-sweep` — finds pending intents and fans out one
//     boot event each. THE RECOVERY TRIGGER (see below).
//   * `system.ci-runner-boot` — one intent, one runner, supervised to its end.
//
// The third, `system.ci-runner-reap`, was replaced by the attribution
// reconciler (`./fleetAttribution.ts`, MOTIR-6925), which destroys any machine
// no live record owns.
//
// ⚠️ THE SWEEP IS NO LONGER THE PRIMARY TRIGGER, AND NEVER COULD BE.
// `docs/decisions/ci-runner-fleet.md` §6 budgets p50 ≤ 30s from the
// `workflow_job.queued` webhook to the job starting, and a minute-granularity
// cron cannot meet that — it adds up to 60s before the admission gate is even
// consulted. MOTIR-1996 moved the fast path where it belongs: the webhook
// dispatches `system.ci-runner-boot` itself, in the same request that records the
// intent (`lib/ciFleet/bootDispatch.ts`).
//
// THE SWEEP STAYS, load-bearing, as the RECOVERY path — for an intent whose
// dispatch was dropped (a transport blip a sender swallows rather than 500s on).
// The triggers race by design; `claimPending`'s compare-and-set means one of them
// wins and the other gets `already_claimed`.
//
// ⚠️ AND IT IS NO LONGER "the retry loop every gate DEFERRAL depends on" — that
// clause stood here until MOTIR-2852 and is what made a minute cadence look
// mandatory. A deferred intent is now dispatched by the admission WAKE the moment
// the slot it was waiting for is released
// (`ciRunnerBootService.dispatchNextPendingForProject`, called from the one
// funnel every terminal transition goes through). A slot freeing is an event this
// service already observes; rediscovering it on a timer was the poll.
//
// MOTIR-1922's ADMISSION GATE sits inside `runIntent` either way — so a sweep
// that fans out 25 boots does not fan out 25 containers, and a faster trigger
// cannot outrun a cap.
//
// System-scoped, like every `system.*` job: the fleet spans tenants because
// Motir's infrastructure bill does.

/**
 * Every 5 minutes — the one sub-hourly cadence (`SUB_HOURLY_CADENCE`,
 * `lib/jobs/schedules.ts`).
 *
 * ⚠️ WHO OWNS ADMISSION LATENCY, AS OF MOTIR-2852: NOT THIS. A queued job is
 * dispatched by the `workflow_job` webhook (MOTIR-1996) and a DEFERRED one by the
 * admission WAKE the moment its project's slot is released
 * (`ciRunnerBootService.dispatchNextPendingForProject`). Both are events the
 * service already observes, so neither waits on a cron minute. **This cadence is
 * purely a BACKSTOP** — the cover for a dispatch that was dropped in transit — so
 * five minutes is how long an intent whose boot dispatch was lost can wait before
 * it is picked up again. The module header above is the older framing, corrected
 * in place.
 */
export const CI_RUNNER_PROVISION_SWEEP_CRON = '*/5 * * * *';

// The reaper's schedule (`system.ci-runner-reap`) is gone: the attribution
// reconciler replaced it (MOTIR-6925, `fleet-per-org-pool.md` §5–§6) — see
// `./fleetAttribution.ts`, which also runs the stale-claim sweep it carried.

/** How many pending intents one sweep will fan out. A ceiling rather than
 *  "everything", so a backlog drains at a predictable rate instead of firing
 *  hundreds of concurrent boots at GitHub's registration limit — and it is
 *  LOGGED when it binds (never a silent truncation). */
const SWEEP_BATCH = 25;

export const ciRunnerProvisionSweep = defineJob(
  {
    id: 'system.ci-runner-provision-sweep',
    cron: CI_RUNNER_PROVISION_SWEEP_CRON,
    // ⚠️ WAS `skip`, AND THE CADENCE IS WHAT JUSTIFIED IT (MOTIR-3314). The
    // argument was "at `* * * * *` the next fire is under a minute away, so
    // replaying a missed one saves less than the claim loop's own poll interval
    // — while after a six-hour outage it would enqueue 360 rows fanning out
    // against the batch ceiling below." Both halves were properties of the
    // minute cadence, and both are false at `*/5 * * * *`: the next fire is up
    // to 5 minutes away, and a six-hour outage owes 72 fires, not 360.
    //
    // So §11.3's discriminator now lands on the other side. The sweep is
    // convergent — `listRunnableIntentIds` reads the CURRENT pending set, so one
    // pass answers for every fire it missed — and minutes of a stranded
    // intent is a real cost paid by whoever is waiting on a CI runner. That is
    // exactly the `latest` case, and it is the same argument its sibling
    // `system.ci-runner-reap` has always made.
    catchUp: 'latest',
    // `idempotent`: the sweep only READS pending intents and fans out events;
    // the claim that follows is a compare-and-set, so a duplicate event costs one
    // losing claim and nothing else.
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const intentIds = await ctx.step.run('list-pending-intents', async () =>
      services.ciRunnerBoot.listRunnableIntentIds(SWEEP_BATCH),
    );

    // THE RECONCILE (MOTIR-8976) runs on every tick, whether or not there were
    // pending intents to fan out: a lost runner leaves a job queued on GitHub with
    // NO pending intent in our DB at all, which is exactly the case this finds.
    // A step of its own so an outage on the GitHub side cannot fail the fan-out.
    //
    // The step returns the WHOLE outcome, and the sweep returns it too, so it lands
    // on the `job_run` row (MOTIR-10790): a reconcile that fails every tick was
    // visible only in the worker logs while the sweep recorded `{ dispatched }`.
    // `-v2` because the memo's shape changed; re-executing it on a resumed run is
    // safe, since the reconcile counts coverage before it mints anything.
    const reconcile = await ctx.step.run(
      'reconcile-github-queue-v2',
      async (): Promise<ReconcileOutcome> => {
        try {
          return await services.ciRunnerReconcile.reconcile();
        } catch (err) {
          console.error('[ciRunnerProvisionSweep] the GitHub-queue reconcile failed', err);
          return { orgs: [], added: 0, error: err instanceof Error ? err.message : 'unknown' };
        }
      },
    );

    if (intentIds.length === 0) return { dispatched: 0, reconcile };

    if (intentIds.length === SWEEP_BATCH) {
      // The batch ceiling bound. Say so — a sweep that silently drops the tail
      // reads exactly like one that had nothing left to do.
      console.warn('[ciRunnerProvisionSweep] the batch ceiling bound; more intents remain', {
        batch: SWEEP_BATCH,
      });
    }

    await ctx.step.run('dispatch-boots', async () => {
      for (const intentId of intentIds) {
        // `dispatchSystemEvent`, not `sendEvent`: this is a `system.*` event and
        // carries no acting workspace of its own. The handler re-reads the
        // intent for everything, so the payload is deliberately just the id —
        // built by the SHARED `ciRunnerBootEvent` so the recovery path and the
        // webhook's hot path cannot emit two different events for one intent.
        //
        // Sent BARE, not through `dispatchCiRunnerBoot`: a failure here belongs
        // to the step, and letting it propagate buys a free engine retry. The
        // webhook has no such retry, which is why only it swallows. That is why
        // this is the STRICT door and not `sendSystemEvent` — the throw IS the
        // retry (MOTIR-3456).
        const bootEvent = ciRunnerBootEvent(intentId);
        await dispatchSystemEvent(bootEvent.name, bootEvent.data);
      }
      return { dispatched: intentIds.length };
    });

    return { dispatched: intentIds.length, reconcile };
  },
);

/**
 * How long a boot pass that could not start a transaction waits before it is
 * re-entered (Bug MOTIR-7074) — `HOSTED_RUN_SUPERVISE_TRANSACTION_RETRY_MS`'s
 * value and reason.
 */
export const CI_RUNNER_BOOT_TRANSACTION_RETRY_MS = 5_000;

export const ciRunnerBoot = defineJob(
  {
    id: 'system.ci-runner-boot',
    // ⚠️ `none` — ONE ATTEMPT, and this is the one retry policy in the fleet that
    // is a correctness decision rather than a cost one. A retry would re-enter
    // the handler from the top, and the failures worth retrying (an exhausted
    // registration ceiling, an unconfigured deployment) release the claim and
    // come back through the next sweep instead — a retry that costs nothing.
    // `bootIntent` returns typed outcomes rather than throwing for exactly that
    // reason.
    //
    // ⚠️ IT IS NOT WHAT STOPS A SECOND CONTAINER. That is `admit`'s atomic
    // `pending → provisioning` claim, and — since MOTIR-2007 — the fact that the
    // boot sits inside a MEMOIZED step, so a replay pass never re-runs it. The
    // collapse (MOTIR-3485) keeps both: the claim is untouched and inside
    // `bootIntent`, and `boot-runner` is still a step.
    //
    // ⚠️ AND A WORKER RESTART DOES NOT SPEND THIS BUDGET — VERIFIED against the
    // worker rather than assumed, because with a budget of exactly ONE the
    // difference between a reclaim and a failure is the difference between
    // resuming and dead-lettering a CI job that was fine.
    // `jobQueueRepository.reclaimExpiredLeases` and `releaseClaims` both write
    // `"attempts" = GREATEST("attempts" - 1, 0)`, so a dead worker and a graceful
    // drain each REFUND the attempt `claimDueRuns` spent at the claim
    // (`lib/jobs/engine/worker.ts`: *"a reclaim and a drain both refund the
    // attempt"*). A genuine handler failure is counted on the failure path, where
    // there is something to record. `tests/jobs/ci-runner-fleet.test.ts` asserts
    // it against the real reclaim rather than citing this comment.
    //
    // ⚠️ EXCEPT A PASS THAT COULD NOT START A TRANSACTION AT ALL (Bug MOTIR-7074,
    // `hosted-run/supervise`'s MOTIR-7071 twin). That is P2028's `maxWait` half: no
    // pooled connection came free, so the statement never ran. With a budget of
    // ONE it dead-lettered the whole CI supervision, leaving the intent and its
    // machine to the abandoned-supervision sweep (15 minutes of grace plus its
    // 5-minute tick). Such a pass is DEFERRED instead — the same re-entry a lease
    // reclaim performs, over the same step memo, so a finished boot is replayed and
    // never re-run. The `timeout` half (a transaction that expired mid-body) and
    // every other failure keep the single attempt.
    retryPolicy: 'none',
  },
  async (ctx, services) => {
    const { intentId } = ctx.event.data as { intentId: string };

    // ⚠️ THE DURABLE POLL LOOP IS GONE, AND MOTIR-2007'S FINDING IS NOT REVERSED
    // — only its remedy (MOTIR-3485). This block used to read: *"Supervising a
    // container takes up to an hour; ONE INVOCATION of
    // the serve route got `maxDuration = 300` (MOTIR-1974; both went with
    // MOTIR-3418 — a long-lived worker has no invocation ceiling). Doing it
    // synchronously … meant every CI job over ~5 minutes had its supervisor
    // killed with `FUNCTION_INVOCATION_TIMEOUT`: no teardown, no usage row, a
    // dead-lettered run for a job that had actually passed, and an intent left
    // holding a fleet slot against the fail-closed ceiling until the reaper aged
    // it out 70 minutes later."*
    //
    // Every word of that incident is still true, and the constraint that caused
    // it has gone: `Dockerfile` ends `CMD ["node", "server.js"]` and motir-core
    // has run as a long-lived Fly process since MOTIR-2384, so there is no
    // invocation to be killed. The supervision is an ordinary loop again, and it
    // lives in `ciRunnerBootService.runIntent` — which already carried it, marked
    // "not the production path" for exactly this reason.
    //
    // ⚠️ WHAT THE STEPS ARE FOR NOW. Not an invocation ceiling: a WORKER RESTART.
    // `docs/decisions/job-queue-foundation.md` §13 keeps a step around the
    // operations that PROVISION, CLAIM or TEAR DOWN — `bootIntent` admits, claims
    // the intent, mints a JIT runner registration and provisions a machine, and
    // `settleSupervision` destroys it, de-registers the runner, meters it and
    // settles the intent. The waiting and the polling are ordinary calls, because
    // forgetting them costs nothing.
    //
    // ⚠️ AND IT STILL RETIRES MOTIR-2002's MEMO, for the same reason it always
    // did: the boot executes on the first pass and replays from `job_step` on
    // every later one, so `supervision_key` / `supervision_outcome` stay dropped.
    // That property is a property of the STEP, and the step is still here.
    // ⚠️ ONE PASS PER RUN (MOTIR-3829). `advanceIntent` boots from its memoized
    // step and advances the supervision by exactly one poll, then DEFERS this
    // run — so the worker's slot is free between polls
    // (`docs/decisions/job-queue-foundation.md` §16). `runIntent` survives as the
    // in-process run-to-completion wrapper, for a caller with no queue row.
    try {
      return await services.ciRunnerBoot.advanceIntent(ctx.runId, intentId, {
        steps: {
          run: <T>(id: string, fn: () => T | Promise<T>): Promise<T> =>
            // ONE cast, at the boundary — the same shape and reason as
            // `lib/jobs/engine/runner.ts`'s single cast. Inngest types a step's
            // result as `Jsonify<T>`, and every value crossing this seam
            // (`SupervisionSession`, `RunIntentOutcome`) is declared
            // JSON-serializable by contract and says so at its definition.
            ctx.step.run(id, fn as () => Promise<T>) as unknown as Promise<T>,
        },
      });
    } catch (err) {
      if (transactionTimeoutHalf(err) !== 'maxWait') throw err;
      deferRun(
        new Date(Date.now() + CI_RUNNER_BOOT_TRANSACTION_RETRY_MS),
        `ci-runner boot ${intentId}: no database connection came free in time`,
      );
    }
  },
);
