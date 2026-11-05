import { withSystemContext } from '@/lib/workspaces/context';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import {
  INDETERMINATE_STREAK_BLIND_SPOT,
  PROBE_INDETERMINATE_STREAK_CODE,
  type IndeterminateStreakEntryDTO,
  type IndeterminateStreakVerdictDTO,
} from '@/lib/dto/indeterminateStreak';

// THE INDETERMINATE-STREAK READ (MOTIR-10429) — the escalation for every probe
// of `system.daily-health-check` that has an `indeterminate` arm.
//
// Each such probe throws only on its DEFINITE fault arm, and records
// `indeterminate` — "this read did not answer" — on the run's `job_run.output`
// without failing it. One indeterminate is quiet on purpose (MOTIR-3606). What
// nothing did was READ them, so a read that failed every morning — an expired
// token, a revoked App installation, anonymous GitHub reads rate-limited on a
// shared egress IP — hid the fault its probe exists to find, indefinitely.
//
// This walks the job's own recent succeeded rows, the way
// `indexRebuildStreakService` walks the code-graph runs, ONCE and generically:
// it knows nothing about any probe. The handler names the probes
// (`DAILY_HEALTH_CHECK_PROBES` in `lib/jobs/definitions/dailyHealthCheck.ts`),
// and a probe added later is covered by being in that table — the type and
// `tests/jobs/daily-health-check-indeterminate-streak.test.ts` both refuse one
// that is not.

/**
 * How many consecutive `indeterminate` runs a probe may record before the check
 * fails.
 *
 * Three, and the reasoning is the gap between the two failure shapes. A blip —
 * a registry 5xx, a GitHub secondary rate limit, a deploy restarting the app
 * mid-probe — clears within a run or two; every incident this job was built
 * around (MOTIR-1980's unbootable fleet, MOTIR-4518's unreachable address,
 * MOTIR-5831's missing secret) lasted a week or more. At one run a day, three
 * is the smallest streak two independent blips in a row cannot reach, and it
 * reports a persistent fault on its third morning rather than its seventh.
 */
export const INDETERMINATE_STREAK_THRESHOLD = 3;

/**
 * How many earlier settled runs are read. The threshold needs only
 * `threshold - 1`; reading further lets the error state how long the read has
 * really been failing, which tells an operator whether it began with a deploy.
 * Thirty is the ledger's terminal-row retention in days (`JOB_RUN_RETENTION_MS`), so a longer reading would have nothing to read.
 */
export const INDETERMINATE_STREAK_HISTORY = 30;

/** The job whose rows are read. Named here rather than imported from the job
 *  definition, which imports this service through `jobServices`. */
export const DAILY_HEALTH_CHECK_FUNCTION_ID = 'system.daily-health-check';

/** One probe as the handler reports it on THIS run. */
export interface IndeterminateProbeReading {
  /** The probe's field on the job's result. */
  probe: string;
  /** Its `step.run` id. */
  step: string;
  /** `null` when this run's verdict is definite; otherwise the read that failed. */
  indeterminate: { phase: string; detail: string } | null;
}

/**
 * True when the stored result holds an `indeterminate` judgement at `probe` — a
 * top-level field (`fleet`) whose `verdict` is `indeterminate`, or a nested path
 * (`runnerImageFreshness.ami`) whose `state` is.
 */
function isIndeterminate(output: Record<string, unknown>, probe: string): boolean {
  let value: unknown = output;
  for (const part of probe.split('.')) {
    if (typeof value !== 'object' || value === null) return false;
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value !== 'object' || value === null) return false;
  const judged = value as { verdict?: unknown; state?: unknown };
  return judged.verdict === 'indeterminate' || judged.state === 'indeterminate';
}

/**
 * What one earlier run says about one probe.
 *
 * - A SUCCEEDED run: its `output` verdict — `indeterminate`, or anything else,
 *   which answered (a run from before the probe existed answers too: the streak
 *   cannot reach past it).
 * - A run failed BY THIS STREAK: its `failure.data` lists every probe that was
 *   `indeterminate` on it, so a probe in the list extends the streak and one
 *   missing from it had answered. Without this read, the alarm's own failed runs
 *   were skipped, the count stuck at the threshold, and once the 30-day
 *   retention pruned the succeeded rows that seeded it the check went green for
 *   two runs while the read was still broken.
 * - Any other failed run: unknown, skipped.
 */
function whatTheRowSays(
  row: { status: 'succeeded' | 'failed'; output: unknown; failure: unknown },
  probe: string,
): 'indeterminate' | 'answered' | 'unknown' {
  if (row.status === 'succeeded') {
    const output = row.output as Record<string, unknown> | null;
    return output && isIndeterminate(output, probe) ? 'indeterminate' : 'answered';
  }
  const failure = row.failure as {
    code?: unknown;
    data?: { indeterminateProbes?: unknown };
  } | null;
  if (failure?.code !== PROBE_INDETERMINATE_STREAK_CODE) return 'unknown';
  const probes = failure.data?.indeterminateProbes;
  if (!Array.isArray(probes)) return 'unknown';
  return probes.includes(probe) ? 'indeterminate' : 'answered';
}

export const indeterminateStreakService = {
  /**
   * How long has each probe that is `indeterminate` on this run been so?
   *
   * Never throws an alarm itself — every arm is an answer, and the CALLER
   * decides which is loud, the contract every probe service of the daily check
   * keeps.
   *
   * A streak ends at the first earlier run whose verdict for that probe is
   * anything but `indeterminate` — a pass, a fault or `not_applicable` all
   * answered the question — and at the first run that carries no verdict for it
   * at all, which is a run from before the probe existed. A run this streak
   * failed is read from its `failure.data`; any other failed run is skipped
   * (see `whatTheRowSays`).
   */
  async check(
    readings: IndeterminateProbeReading[],
    now: Date = new Date(),
  ): Promise<IndeterminateStreakVerdictDTO> {
    const checkedAt = now.toISOString();
    const rows = await withSystemContext((tx) =>
      jobRunRepository.listRecentSettledRuns(
        DAILY_HEALTH_CHECK_FUNCTION_ID,
        INDETERMINATE_STREAK_HISTORY,
        tx,
      ),
    );

    const streaks: IndeterminateStreakEntryDTO[] = [];
    for (const reading of readings) {
      if (!reading.indeterminate) continue;
      let consecutive = 1;
      let since = checkedAt;
      for (const row of rows) {
        const said = whatTheRowSays(row, reading.probe);
        if (said === 'unknown') continue;
        if (said === 'answered') break;
        consecutive += 1;
        since = row.startedAt.toISOString();
      }
      streaks.push({
        probe: reading.probe,
        step: reading.step,
        consecutive,
        since,
        phase: reading.indeterminate.phase,
        detail: reading.indeterminate.detail,
      });
    }
    streaks.sort((a, b) => b.consecutive - a.consecutive);

    const base = {
      threshold: INDETERMINATE_STREAK_THRESHOLD,
      runsRead: rows.length,
      streaks,
      checkedAt,
      blindSpot: INDETERMINATE_STREAK_BLIND_SPOT,
    };
    const offenders = streaks.filter((s) => s.consecutive >= INDETERMINATE_STREAK_THRESHOLD);
    return offenders.length > 0
      ? { ...base, verdict: 'persistent', offenders }
      : { ...base, verdict: 'ok' };
  },
};
