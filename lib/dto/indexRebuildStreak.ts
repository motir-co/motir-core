// DTO for the INDEX REBUILD-STREAK check (MOTIR-5027) — the shape
// `system.daily-health-check` resolves to for its fifth probe, and therefore
// what lands on its `job_run.output`. Dates cross the boundary as ISO strings,
// matching `lib/dto/jobs.ts` and `lib/dto/jobSchedules.ts`.
//
// ⚠️ WHAT THIS PROBE CAN AND CANNOT SEE — read this before writing anything
// that consumes the verdict, because the boundary is the whole design.
//
// motir-core's recorded index mode is derived from ITS OWN GRANT:
// the container dispatch (`codeGraphIndexDispatchService`, deleted with
// MOTIR-12036) wrote `syncGranted: Boolean(credential.previousSnapshotUrl)` into
// the `index-boot:<projectId>` memo and read it back as `'sync' | 'rebuild'`. So the fact in this ledger is
// ***was a snapshot OFFERED to the container***.
//
// It is NOT what the container DID with it. motir-ai's `runIndex.ts` returns
// `mode: 'build'` WITH a `fallbackReason` when a snapshot was offered and the
// incremental sync then threw — an ordinary failure, or the engine refusing a
// restored index as stale. motir-core writes that run down as `sync`.
//
// **So this probe detects *a snapshot was never offered* and is BLIND to *a
// snapshot was offered and the container rebuilt anyway*.** Both incidents this
// check was written for (MOTIR-4415, MOTIR-5009) are of the first shape — the
// pointer was withheld on every run for weeks — which is why the probe is worth
// shipping against the offer alone. MOTIR-5058 is the card that carries the
// container's own verdict across the boundary and closes the blind arm.
//
// The boundary is stated in the verdict itself (`BLIND_SPOT`, below) rather
// than only here, because a monitor whose blind spot is written down can be
// trusted within its stated range, while one that implies total coverage
// teaches every reader to take a green verdict as a guarantee it was never able
// to make — which is precisely the failure this check exists to end.

/**
 * The coverage boundary, in the words the verdict carries.
 *
 * ⚠️ IT RIDES ON THE VERDICT AND IN THE ERROR MESSAGE, and a test asserts it is
 * present in both. It is a constant so the two cannot drift apart, and so that
 * deleting it from either surface is a diff somebody has to write on purpose.
 */
export const INDEX_REBUILD_STREAK_BLIND_SPOT =
  'This check reads whether motir-core OFFERED the container a snapshot, not what the container did with one. ' +
  'A run that was offered a snapshot and rebuilt anyway is recorded here as `sync` and is INVISIBLE to this check (MOTIR-5058 closes that arm).';

/**
 * The two systems a persistent denial implicates, named in the verdict so the
 * next reader starts from a fork rather than from a guess.
 *
 * Both of the recorded incidents were one of these two, and neither was found
 * by a signal — MOTIR-4415 was found while measuring an unrelated window and
 * MOTIR-5009 by reading logs for a different card.
 */
export const INDEX_REBUILD_STREAK_CANDIDATES = [
  'the configured indexer image — `MOTIR_INDEXER_IMAGE` on motir-core may name an engine older than the one the control plane compares against (MOTIR-5009)',
  "the coordination row's engine version — motir-ai withholds the snapshot pointer whenever `CodeRepo.codegraphVersion` differs from what it expects, and a rebuild re-stamps the old value (MOTIR-4415)",
] as const;

/** What one repository's recent index runs say. */
export interface IndexRebuildStreakEntryDTO {
  /** The repository, as `job_run.output.repoRef` records it. */
  repoRef: string;
  /**
   * How many of the most recent SUCCEEDED mode-carrying runs were `rebuild`,
   * counted back from the newest until a `sync` is met.
   *
   * ⚠️ IT COUNTS RUNS, NOT DAYS, and the two come apart hard across
   * repositories: an actively-pushed repo refreshes tens of times a day while a
   * quiet one may go a week between runs. So the same threshold is hours of
   * latency on one repository and weeks on another. That is a known property
   * rather than a defect — the alternative, a time window, cannot tell a
   * repository that is rebuilding from one that is simply idle.
   */
  consecutiveRebuilds: number;
  /** How many recent runs carried a mode at all — the streak's denominator. */
  modeRuns: number;
  /** Succeeded runs seen for this repository, mode-carrying or not. */
  succeededRuns: number;
  /**
   * What this reading MEANS, and the reason the arm exists at all:
   *
   *  - `syncing`  — mode-carrying runs exist and the streak is under the
   *                 threshold. The nearest thing to healthy this check can say.
   *  - `rebuilding` — the streak has reached the threshold. LOUD.
   *  - `unknown`  — the repository has succeeded runs but NONE of them recorded
   *                 a mode, so nothing here has been measured. **It must never
   *                 read as healthy**: on the day this shipped, 844 of 899
   *                 succeeded runs carried no mode (the field landed
   *                 2026-09-09), so `unknown` is the DOMINANT state and folding
   *                 it into a pass would make the check report green across the
   *                 whole estate while measuring nothing.
   */
  state: 'syncing' | 'rebuilding' | 'unknown';
}

/**
 * The whole check.
 *
 * `not_applicable` follows the discipline every other probe in
 * `system.daily-health-check` observes: a deployment that has never run an
 * index job is not unhealthy, it simply has nothing to say here.
 *
 * Only `rebuilding` is LOUD. `unknown` entries are reported on the `ok` arm and
 * never throw — the same reason `indeterminate` is not loud for the two image
 * preflights: a check that dead-letters daily over a state nobody can act on is
 * a check somebody silences, and then the estate is where it started with a
 * dashboard that once worked.
 */
export type IndexRebuildStreakVerdictDTO =
  | {
      verdict: 'not_applicable';
      detail: string;
      checkedAt: string;
      blindSpot: string;
    }
  | {
      verdict: 'ok';
      /** Every repository read, in both states — so the report proves coverage. */
      entries: IndexRebuildStreakEntryDTO[];
      /** The repositories whose runs recorded no mode at all. Named separately
       *  so an absent reading is visible on the wire and not only in prose. */
      unknownRepoRefs: string[];
      threshold: number;
      checkedAt: string;
      blindSpot: string;
    }
  | {
      verdict: 'rebuilding';
      /** The repositories at or over the threshold — the actionable part. */
      offenders: IndexRebuildStreakEntryDTO[];
      entries: IndexRebuildStreakEntryDTO[];
      unknownRepoRefs: string[];
      threshold: number;
      /** The two systems to fork on, from {@link INDEX_REBUILD_STREAK_CANDIDATES}. */
      candidates: string[];
      checkedAt: string;
      blindSpot: string;
    };
