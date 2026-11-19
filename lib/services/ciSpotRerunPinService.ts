import type { CiSpotRerunPin } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  CI_SPOT_RERUN_PIN_MAX_AGE_MS,
  ciSpotRerunPinRepository as pins,
  pinTargetOrg,
  type CiSpotRerunPinCloseReason,
} from '@/lib/repositories/ciSpotRerunPinRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';

// THE ON-DEMAND PIN HOLD OF A JOB'S SECOND SPOT RE-RUN (MOTIR-11732).
//
// A job Spot interrupted twice is re-run once more, and that re-run must run on
// on-demand capacity. Booting the re-run's own intent on-demand is not enough: a
// fleet runner is not bound to its intent's job — GitHub hands a runner the
// OLDEST queued job its labels match — so any idle Spot runner of the org could
// take the re-run first. A HOLD per runner target (the org) closes that gap:
//
//   1 · the hold is written, BEFORE the re-run is requested
//       (`ciSpotRerunService.requestSpotRerun`);
//   2 · every jobless registered Spot runner of the org is withdrawn from GitHub;
//   3 · only then is the re-run requested.
//
// While the hold is open every boot in the org reads it and comes up on-demand
// (`ciRunnerBootService`), and the reconcile counts the pinned job as on-demand
// demand (`ciRunnerReconcileService`). This module is the hold's reads and its
// closes; it never calls GitHub.
//
// It closes when a runner takes the re-run (the `workflow_job` `in_progress`
// delivery, in `ciRunnerProvisioningService.recordJobProgress`, and
// `closeSettledPins` on the reconcile pass in case that delivery is lost), when
// the re-run is refused or expires (`closePinForRerun`), or 24 hours after it
// opened — after which boots read the Spot setting again.

export { CI_SPOT_RERUN_PIN_MAX_AGE_MS, pinTargetOrg };

/** A queued job, as the pin decides whether it is the one pinned. */
export interface PinnableJob {
  repoOwner: string;
  repoName: string;
  runId: string;
  runAttempt: number;
  jobName: string | null;
}

/** Whether `job` is the re-run one of `open` pins holds on-demand capacity for:
 *  the same repository (case-insensitively), run and job name, at an attempt
 *  after the interrupted one. */
export function isPinnedJob(job: PinnableJob, open: readonly CiSpotRerunPin[]): boolean {
  if (!job.jobName) return false;
  const owner = job.repoOwner.trim().toLowerCase();
  const name = job.repoName.trim().toLowerCase();
  return open.some(
    (pin) =>
      pin.repoOwner.trim().toLowerCase() === owner &&
      pin.repoName.trim().toLowerCase() === name &&
      pin.runId === job.runId &&
      pin.jobName === job.jobName &&
      job.runAttempt > pin.runAttempt,
  );
}

export interface SpotRerunPinCloseOutcome {
  pickedUp: number;
  agedOut: number;
}

export const ciSpotRerunPinService = {
  /**
   * Whether an on-demand pin is OPEN in the runner target of this repository
   * owner at `now`. THROWS when the hold cannot be read: the boot asks for
   * on-demand then, the direction that never breaks a pin.
   */
  async isTargetPinned(repoOwner: string, now: Date): Promise<boolean> {
    const open = await withSystemContext((tx) =>
      pins.listOpenForTarget(pinTargetOrg(repoOwner), now, tx),
    );
    return open.length > 0;
  },

  /** The holds open in one org at `now`, for the reconcile. Throws on a failed read. */
  async listOpenForOrg(org: string, now: Date): Promise<CiSpotRerunPin[]> {
    return withSystemContext((tx) => pins.listOpenForTarget(pinTargetOrg(org), now, tx));
  },

  /**
   * Close the hold an interrupted runner's intent opened, because its re-run was
   * refused for good or gave up after 24 hours. NEVER THROWS: a hold left open by
   * a failed write still closes at 24 hours.
   */
  async closePinForRerun(
    sourceIntentId: string,
    reason: Extract<CiSpotRerunPinCloseReason, 'rerun_refused' | 'rerun_expired'>,
    now: Date,
  ): Promise<void> {
    try {
      const closed = await withSystemContext((tx) =>
        pins.closeBySource(sourceIntentId, reason, now, tx),
      );
      if (closed) {
        console.warn('[ciSpotRerunPin] closed an on-demand pin', { sourceIntentId, reason });
      }
    } catch (err) {
      console.error('[ciSpotRerunPin] could not close an on-demand pin', {
        sourceIntentId,
        reason,
        detail: detailOf(err),
      });
    }
  },

  /**
   * The reconcile pass's close of every hold whose time is up: `aged_out` once 24
   * hours old, `picked_up` once a runner is recorded as having taken a later
   * attempt of its job (the in-progress delivery closes it first; this covers a
   * delivery that never arrived). NEVER THROWS.
   */
  async closeSettledPins(now: Date): Promise<SpotRerunPinCloseOutcome> {
    const outcome: SpotRerunPinCloseOutcome = { pickedUp: 0, agedOut: 0 };
    let unclosed: CiSpotRerunPin[];
    try {
      unclosed = await withSystemContext((tx) => pins.listUnclosed(tx));
    } catch (err) {
      console.error('[ciSpotRerunPin] could not read the open pins', { detail: detailOf(err) });
      return outcome;
    }
    for (const pin of unclosed) {
      try {
        const reason = await withSystemContext(async (tx) => {
          const aged = now.getTime() - pin.openedAt.getTime() >= CI_SPOT_RERUN_PIN_MAX_AGE_MS;
          const why: CiSpotRerunPinCloseReason | null = aged
            ? 'aged_out'
            : (await intents.hasTakenLaterAttempt(pin, pin.runAttempt, tx))
              ? 'picked_up'
              : null;
          if (why === null) return null;
          return (await pins.close(pin.id, why, now, tx)) ? why : null;
        });
        if (reason === 'aged_out') outcome.agedOut += 1;
        if (reason === 'picked_up') outcome.pickedUp += 1;
        if (reason !== null) {
          console.warn('[ciSpotRerunPin] closed an on-demand pin', {
            pinId: pin.id,
            reason,
            ...jobLabel(pin),
          });
        }
      } catch (err) {
        console.error('[ciSpotRerunPin] could not close an on-demand pin', {
          pinId: pin.id,
          detail: detailOf(err),
        });
      }
    }
    return outcome;
  },
};

/** The pinned job, named for a log line. */
function jobLabel(pin: CiSpotRerunPin) {
  return {
    repo: `${pin.repoOwner}/${pin.repoName}`,
    runId: pin.runId,
    runAttempt: pin.runAttempt,
    jobName: pin.jobName,
  };
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
