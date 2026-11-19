import type { CiRunnerProvisioningIntent, Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  type CiRunnerSettleRecord,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { actionsRunsClient, ActionsRunsError } from '@/lib/github/actionsRuns';
import { fleetRunnerTargetFor } from '@/lib/ciFleet/runnerTarget';

// THE RE-RUN OF A JOB A SPOT RECLAIM CUT OFF (MOTIR-11728).
//
// A CI runner EC2 reclaimed for Spot capacity settles `spot_interrupted`. When
// the runner had TAKEN a job, that job is re-run on GitHub — once at any
// capacity, a second time with the re-run's intent booted on-demand, and never
// a third time. The count crosses the re-run by repository + run id + job NAME,
// because a re-run is a new run attempt with new job ids.
//
//   1 · {@link planSpotRerun}, read BEFORE the supervisor's settle, decides the
//       taken job's count and the re-run's starting state. The settle writes it
//       in the same statement, so it lands only when that settle WINS — an org
//       stop or the reaper that settled first never leads to a re-run, and a
//       replayed step (whose settle loses) asks GitHub nothing.
//   2 · {@link requestSpotRerun} asks GitHub once, right after the winning
//       settle, and records the answer.
//   3 · {@link retryPendingSpotReruns}, on the reconcile pass, asks again for a
//       re-run GitHub refused for a reason that may clear (the run not finished
//       yet), until it accepts, refuses for good, or 24 hours pass.
//
// Nothing here throws into supervision or the reconcile, and nothing logged or
// stored carries GitHub's response body — only its status.

/** The most re-runs one job gets: a third interruption is recorded, not re-run. */
export const MAX_SPOT_RERUNS = 2;

/** The carried count at which the re-run's intent boots on-demand. */
export const ON_DEMAND_AT_SPOT_INTERRUPTIONS = 2;

/** How long a refused re-run is retried, measured from the interruption. */
export const SPOT_RERUN_RETRY_WINDOW_MS = 24 * 60 * 60_000;

/** The least gap between two asks for one re-run — also what keeps the reconcile
 *  pass off a re-run the settling supervisor is asking for at that moment. */
export const SPOT_RERUN_RETRY_GAP_MS = 2 * 60_000;

/** Re-runs one reconcile pass asks for at most. */
const RERUNS_PER_PASS = 50;

type RerunIntent = Pick<
  CiRunnerProvisioningIntent,
  | 'id'
  | 'repoOwner'
  | 'repoName'
  | 'installationId'
  | 'takenRunId'
  | 'takenRunAttempt'
  | 'takenJobId'
  | 'takenJobName'
  | 'takenJobSpotInterruptions'
>;

/** What one ask of GitHub came to. */
export type SpotRerunAsk = 'requested' | 'refused' | 'pending';

/**
 * The re-run bookkeeping a `spot_interrupted` settle writes, or `undefined` when
 * the runner took no job (the job it was booted for is still queued, and the
 * reconcile covers it like any lost runner) or the job it took had already
 * finished its work (`success` / `skipped`). A job GitHub reported `failure` or
 * `cancelled` is the one the reclaim cut off, and is re-run. A third interruption is written `capped` and warned about.
 */
export async function planSpotRerun(
  intentId: string,
  settledAt: Date,
  tx: Prisma.TransactionClient,
): Promise<CiRunnerSettleRecord['spotRerun']> {
  const intent = await intents.findById(intentId, tx);
  if (!intent?.takenJobId || !intent.takenRunId || intent.takenRunAttempt === null) {
    return undefined;
  }
  const taken = {
    runId: intent.takenRunId,
    runAttempt: intent.takenRunAttempt,
    jobId: intent.takenJobId,
  };
  if (await intents.isJobFinishedWork(taken, tx)) {
    console.warn('[ciSpotRerun] the reclaimed runner’s job had already passed — no re-run', {
      intentId,
      ...jobLabel(intent),
    });
    return undefined;
  }
  if (!intent.takenJobName) {
    console.warn('[ciSpotRerun] the interrupted job has no name — its count cannot be carried', {
      intentId,
      ...jobLabel(intent),
    });
  }
  const prior = await intents.findCarriedSpotInterruptions(
    {
      repoOwner: intent.repoOwner,
      repoName: intent.repoName,
      runId: intent.takenRunId,
      jobName: intent.takenJobName,
      runAttempt: intent.takenRunAttempt,
    },
    tx,
  );
  const count = prior + 1;
  if (count > MAX_SPOT_RERUNS) {
    console.warn('[ciSpotRerun] a job was interrupted by Spot a third time — not re-run', {
      intentId,
      interruptions: count,
      ...jobLabel(intent),
    });
    return { takenJobSpotInterruptions: count, rerunState: 'capped', rerunAttemptedAt: null };
  }
  return { takenJobSpotInterruptions: count, rerunState: 'pending', rerunAttemptedAt: settledAt };
}

/**
 * Ask GitHub to re-run the job a reclaimed runner took, ONCE, and record the
 * answer: `requested` on 201; `refused` for good; `pending` (to be retried by the
 * reconcile pass) on a refusal that may clear or on a call that failed. NEVER
 * THROWS.
 */
export async function requestSpotRerun(intent: RerunIntent): Promise<SpotRerunAsk> {
  if (!intent.takenJobId || !intent.takenRunId) return 'refused';
  let answer: Awaited<ReturnType<typeof actionsRunsClient.rerunJob>>;
  try {
    answer = await actionsRunsClient.rerunJob(
      {
        owner: intent.repoOwner,
        repo: intent.repoName,
        target: fleetRunnerTargetFor(intent),
      },
      intent.takenJobId,
      intent.takenRunId,
    );
  } catch (err) {
    console.warn('[ciSpotRerun] the re-run could not be asked for — left pending', {
      intentId: intent.id,
      status: err instanceof ActionsRunsError ? err.status : null,
      ...jobLabel(intent),
    });
    return 'pending';
  }
  if (answer === true) {
    await recordOutcome(intent.id, 'requested');
    console.warn('[ciSpotRerun] a Spot-interrupted job was re-run', {
      intentId: intent.id,
      interruptions: intent.takenJobSpotInterruptions,
      ...jobLabel(intent),
    });
    return 'requested';
  }
  if (answer.mayClear) {
    console.warn('[ciSpotRerun] GitHub refused the re-run for now — left pending', {
      intentId: intent.id,
      status: answer.status,
      ...jobLabel(intent),
    });
    return 'pending';
  }
  await recordOutcome(intent.id, 'refused');
  console.warn('[ciSpotRerun] GitHub refused the re-run — not retried', {
    intentId: intent.id,
    status: answer.status,
    ...jobLabel(intent),
  });
  return 'refused';
}

export interface SpotRerunRetryOutcome {
  requested: number;
  refused: number;
  expired: number;
  pending: number;
}

/**
 * The reconcile pass's retry of every PENDING re-run not asked for in the last
 * {@link SPOT_RERUN_RETRY_GAP_MS}: `expired` once 24 hours have passed since the
 * interruption, otherwise asked again — each claimed first, so two passes never
 * ask for the same re-run at once. NEVER THROWS.
 */
export async function retryPendingSpotReruns(now: Date): Promise<SpotRerunRetryOutcome> {
  const outcome: SpotRerunRetryOutcome = { requested: 0, refused: 0, expired: 0, pending: 0 };
  let due: CiRunnerProvisioningIntent[];
  try {
    due = await withSystemContext((tx) =>
      intents.listPendingReruns(
        new Date(now.getTime() - SPOT_RERUN_RETRY_GAP_MS),
        RERUNS_PER_PASS,
        tx,
      ),
    );
  } catch (err) {
    console.error('[ciSpotRerun] could not read the pending re-runs', {
      detail: detailOf(err),
    });
    return outcome;
  }
  for (const intent of due) {
    // A pending re-run is only ever written by a settle, so it has a settle instant.
    const interruptedAt = intent.settledAt ?? now;
    if (now.getTime() - interruptedAt.getTime() >= SPOT_RERUN_RETRY_WINDOW_MS) {
      if (await recordOutcome(intent.id, 'expired')) {
        outcome.expired += 1;
        console.warn('[ciSpotRerun] a re-run was still refused 24 hours on — given up', {
          intentId: intent.id,
          ...jobLabel(intent),
        });
      }
      continue;
    }
    let claimed = false;
    try {
      claimed = await withSystemContext((tx) =>
        intents.claimRerunAttempt(intent.id, intent.rerunAttemptedAt, now, tx),
      );
    } catch (err) {
      console.error('[ciSpotRerun] could not claim a re-run', {
        intentId: intent.id,
        detail: detailOf(err),
      });
    }
    if (!claimed) continue;
    outcome[await requestSpotRerun(intent)] += 1;
  }
  return outcome;
}

async function recordOutcome(
  intentId: string,
  state: 'requested' | 'refused' | 'expired',
): Promise<boolean> {
  try {
    return await withSystemContext((tx) => intents.recordRerunOutcome(intentId, state, tx));
  } catch (err) {
    console.error('[ciSpotRerun] could not record a re-run outcome', {
      intentId,
      state,
      detail: detailOf(err),
    });
    return false;
  }
}

/** The job, named for a log line — ids and the name, never a body. */
function jobLabel(intent: RerunIntent) {
  return {
    repo: `${intent.repoOwner}/${intent.repoName}`,
    runId: intent.takenRunId,
    runAttempt: intent.takenRunAttempt,
    jobId: intent.takenJobId,
    jobName: intent.takenJobName,
  };
}

/** An error's own message — never a response body, which no error here carries. */
function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}
