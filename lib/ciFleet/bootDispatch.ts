import { dispatchSystemEvent } from '@/lib/jobs/sendEvent';
import { isCiFleetConfigured } from '@/lib/orchestrator';
import type { CiRunnerBootData } from '@/lib/jobs/types';

// THE `system.ci-runner-boot` DISPATCH (Story MOTIR-1916 · MOTIR-1996) — the one
// place that says what a boot event looks like, and the hot-path send that gets
// one out of the webhook the instant an intent exists.
//
// `docs/decisions/ci-runner-fleet.md` §6 budgets **p50 ≤ 30 s** from the
// `workflow_job.queued` delivery to the job starting, and the minute-granularity
// `system.ci-runner-provision-sweep` cannot meet it: a cron adds up to 60 s
// before the admission gate is even consulted. So the webhook dispatches
// directly, and the sweep stays where it is as the RECOVERY path for an intent
// this call dropped.
//
// THREE SENDERS, ONE PAYLOAD (MOTIR-2852 added the third). Every caller builds
// the event through `ciRunnerBootEvent`, so the shape cannot drift between the
// paths — they race by design and must be the same event. Their ERROR semantics
// differ deliberately, which is why only two of them get the swallowing wrapper
// below:
//
//   * the SWEEP sends inside a `step.run` under the `idempotent` retry policy —
//     a transport failure there should propagate, because the engine retrying the
//     step is a free, correct fix;
//   * the WEBHOOK has no retry that could help. GitHub retries a 500 delivery,
//     and a redelivery cannot re-send an event that failed to send; it would
//     only re-run the whole handler for an intent that already exists. So the
//     failure is logged and swallowed, the delivery is acked, and the sweep
//     picks the intent up within the minute.
//   * the ADMISSION WAKE (`ciRunnerBootService.dispatchNextPendingForProject`,
//     MOTIR-2852) hangs off a TEARDOWN, and a teardown must complete whatever
//     the transport is doing — a throw there would abandon the very bookkeeping
//     that just freed the slot. Same swallow, same backstop.
//
// ⚠️ AND THE WAKE IS WHY THE SWEEP IS NO LONGER "the retry loop every gate
// deferral depends on" — that sentence, which this header used to carry, was the
// justification for the minute cadence. Admission latency now belongs to the
// wake; see the comment at `CI_RUNNER_PROVISION_SWEEP_CRON`.

/** The canonical `system.ci-runner-boot` event for one provisioning intent.
 *
 *  ⚠️ THE PAYLOAD IS THE INTENT ID AND NOTHING ELSE (see `CiRunnerBootData`):
 *  every attribution the boot needs is on the intent row, and a second copy in
 *  the event is a second copy that can disagree.
 *
 *  `workspaceId` is `null` — SYSTEM-SCOPED, the same untenanted shape
 *  `system.ci-runner-reap` lands on the ledger. It was `''` until MOTIR-1998,
 *  and that empty string was not a cosmetic wart: it is not nullish, so
 *  `defineJob` passed it through to `job_run.workspace_id`, where it tripped the
 *  workspace FK and the row was silently dropped — every fleet boot ran with no
 *  ledger record at all. `CiRunnerBootData.workspaceId` is typed `null` so this
 *  line cannot regress to a string without failing the build. */
export function ciRunnerBootEvent(intentId: string): {
  name: 'system.ci-runner-boot';
  data: CiRunnerBootData;
} {
  return { name: 'system.ci-runner-boot', data: { intentId, workspaceId: null } };
}

/** What the hot-path dispatch did — returned rather than logged-only so the
 *  seam is assertable without reading stdout. The webhook does not act on it:
 *  the delivery's outcome is what `recordQueuedJob` decided, and a boot that
 *  could not be dispatched is still an intent that was recorded. */
export type CiRunnerBootDispatchOutcome = 'dispatched' | 'not_configured' | 'send_failed';

/**
 * WHO asked for the boot. Carried only into the failure log — the event itself is
 * byte-identical whichever path sent it, which is the property `ciRunnerBootEvent`
 * exists to hold. It matters in the log because the callers have different
 * recoveries, and an operator reading a `send_failed` line wants to know which
 * one is now covering it.
 */
export type CiRunnerBootDispatchSource = 'hot-path' | 'admission-wake';

const RECOVERY_BY_SOURCE: Record<CiRunnerBootDispatchSource, string> = {
  'hot-path': 'the delivery is still acked and the provision sweep will pick the intent up',
  'admission-wake': 'the slot is still free and the provision sweep will pick the intent up',
};

/**
 * Dispatch the boot for a recorded intent — from the webhook in the same request,
 * or from the admission WAKE the moment a slot frees (MOTIR-2852).
 * NEVER THROWS — see the module header.
 *
 * Gated on `isCiFleetConfigured()`, which is the SAME condition
 * `ciRunnerBootService.listRunnableIntentIds` applies before the sweep fans
 * anything out — and which follows the CI runner's Fly↔AWS switch, so on its
 * pool it reads the AWS values a pool boot needs, never the Fly fleet's
 * (MOTIR-10625): a deployment that cannot boot a CI runner (a self-hosted
 * `motir-core`, or a cloud deploy whose fleet env vars are not set yet) should
 * not emit an event whose only possible outcome is `not_configured`. The intent
 * is still recorded, so nothing is lost — the moment the deployment IS
 * configured, the sweep drains what accumulated.
 */
export async function dispatchCiRunnerBoot(
  intentId: string,
  source: CiRunnerBootDispatchSource = 'hot-path',
): Promise<CiRunnerBootDispatchOutcome> {
  if (!(await isCiFleetConfigured())) return 'not_configured';
  try {
    // `dispatchSystemEvent`, the STRICT door (MOTIR-3456): this function REPORTS
    // its outcome rather than only logging it, so it has to see the failure. The
    // best-effort door would swallow it and every dispatch would read
    // 'dispatched'.
    const event = ciRunnerBootEvent(intentId);
    await dispatchSystemEvent(event.name, event.data);
    return 'dispatched';
  } catch (err) {
    console.error(
      `[ciRunnerBoot] the ${source} boot dispatch for intent ${intentId} failed to enqueue; ` +
        `${RECOVERY_BY_SOURCE[source]} within the minute:`,
      err,
    );
    return 'send_failed';
  }
}
