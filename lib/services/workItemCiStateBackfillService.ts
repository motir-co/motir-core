import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type { PrCiState } from '@/lib/github/prCiState';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { classifyDeliveries, recomputeWorkItemCiState } from './deliveryVerdict';
import { deliveryStateForCard, foldCardCiState } from '@/lib/workItems/deliverySet';

// BACKFILL `WorkItem.ciState` FOR THE CARDS THAT ALREADY EXIST (MOTIR-5472).
//
// ── Why a backfill is owed at all ───────────────────────────────────────────
// MOTIR-5470 makes every FUTURE event write the right answer. It does nothing for
// the rows already in the table, and those rows are wrong in ways that will never
// self-correct, because the correction would have to come from an event that is
// not coming:
//
//   * a card whose pull requests have all finished — the checks are done, so no
//     further check event will ever fire for it;
//   * a card delivered through a run's session branch, which the old writer never
//     wrote at all and which is therefore `null` however red its build;
//   * a card whose stale value is the verdict of whichever of its pull requests
//     reported last;
//   * a card whose LAST link was removed before the unlink doors recomputed
//     (MOTIR-5469, #2937): it kept the verdict of a pull request it no longer
//     has, and with no pull request left no event can ever reach it (MOTIR-10542).
//
// A badge and a filter read this column, so every one of those is a card a person
// will look for and not find, or find and not need.
//
// ── IT NEVER RE-IMPLEMENTS THE FOLD ─────────────────────────────────────────
// Each card is handed to `recomputeWorkItemCiState` — the SAME function the live
// path calls. A backfill that folded the set in SQL would be a second opinion
// about one card, and the two would drift on the first amendment to either. That
// is the one rule this file must not break, and it is why the service is thin.
//
// ── RESUMABLE RATHER THAN ALL-OR-NOTHING ────────────────────────────────────
// ONE TRANSACTION PER CARD, so a run killed partway keeps every card it already
// converged, and the re-run resumes from the rest. A card that FAILS is recorded
// with its error and the sweep moves on: one bad row does not cost the others
// their progress.
//
// ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────
// The recompute writes only when the value changed, so a second run over
// unchanged data reports `changed: 0` and performs zero writes. That is a
// property of the recompute rather than of a candidate query that shrinks, which
// is what lets `--dry-run` predict a real run exactly: both fold the same set,
// and only one of them writes.

/** One card whose verdict the sweep moved. */
export interface CiStateBackfillChange {
  workItemId: string;
  identifier: string;
  from: PrCiState;
  to: PrCiState;
}

export interface CiStateBackfillFailure {
  workItemId: string;
  error: string;
}

export interface CiStateBackfillReport {
  dryRun: boolean;
  /** Candidate cards examined — those with at least one delivery-set member, and
   *  every non-archived card still storing a verdict (MOTIR-10542). */
  scanned: number;
  changed: CiStateBackfillChange[];
  unchanged: number;
  /** Candidates skipped because the card is ARCHIVED. A human decided this card
   *  should not be worked; recomputing its badge is not the sweep's business. */
  skippedArchived: number;
  failed: CiStateBackfillFailure[];
  /** How many candidates the sweep set out to examine. */
  total: number;
  /** `true` when `signal` stopped the sweep before it reached every candidate —
   *  the counts above are then the PARTIAL sweep's, and the rest were never read. */
  interrupted: boolean;
}

/** A running tally, handed to `onProgress` as the sweep goes. `examined` counts
 *  every candidate the loop has reached (a card deleted underneath the sweep
 *  included), so `examined === total` is the last call. */
export interface CiStateBackfillProgress {
  examined: number;
  total: number;
  scanned: number;
  changed: number;
  unchanged: number;
  skippedArchived: number;
  failed: number;
}

/** The progress interval when the caller does not name one. */
export const CI_STATE_BACKFILL_PROGRESS_EVERY = 100;

export interface CiStateBackfillOptions {
  dryRun: boolean;
  workspaceId?: string;
  /** Called every `progressEvery` candidates and once more on the last one, so a
   *  long sweep is visibly alive (MOTIR-5765: ~1,957 production cards ran past a
   *  10-minute job timeout and printed nothing at all). */
  onProgress?: (progress: CiStateBackfillProgress) => void;
  progressEvery?: number;
  /** Checked BEFORE each candidate. Once aborted the sweep stops and RETURNS the
   *  partial report with `interrupted: true`, so a cancelled operator run still
   *  leaves its counts. The card in flight when the signal fires finishes first —
   *  each card is its own transaction, so stopping between cards loses nothing. */
  signal?: AbortSignal;
}

/** The workspace each candidate card is bound under, keyed on the card. */
type CandidateMap = Map<string, string>;

/**
 * The candidate set: every card with at least one member `collectDeliveries`
 * would return, plus every non-archived card that still STORES a verdict, each
 * paired with the workspace to bind for it.
 *
 * THREE ARMS, because a card that needs recomputing is reachable from three
 * different directions (see each repository method's own header):
 *   * a `work_item_delivery` row — read straight off the delivery table, which is
 *     armed for the system flag;
 *   * a `session_branch` equal to some pull request's head ref — read from the
 *     PULL REQUEST side, because `work_item` has no `system_admin` arm and a
 *     cross-tenant scan of it would be silently empty rather than refused;
 *   * a stored, non-null `ciState` with NO member left at all (MOTIR-10542) — a
 *     card whose last link was removed before the unlink doors recomputed. The
 *     first two arms can never reach it, because it has nothing left for them to
 *     start from, and it is exactly the card whose badge is wrong for ever. Read
 *     per workspace, bound, for the same no-system-arm reason.
 *
 * Deduplicated on the card: a card reached by more than one arm is one
 * candidate, since the recompute folds its whole set either way. The third arm
 * adds candidates only; the verdict is still `recomputeWorkItemCiState`'s, which
 * folds an empty set to `null`.
 */
async function collectCandidates(
  opts: CiStateBackfillOptions,
): Promise<Array<{ workItemId: string; workspaceId: string }>> {
  const byId: CandidateMap = new Map();
  const scope = opts.workspaceId ? { workspaceId: opts.workspaceId } : {};

  await addDeliveredCandidates(byId, scope);
  await addSessionBranchCandidates(byId, scope);
  await addStoredVerdictCandidates(byId, scope);

  return [...byId.entries()]
    .map(([workItemId, workspaceId]) => ({ workItemId, workspaceId }))
    .sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1));
}

/** Arm one: every card a `work_item_delivery` row names. */
async function addDeliveredCandidates(
  byId: CandidateMap,
  scope: { workspaceId?: string },
): Promise<void> {
  const delivered = await withSystemContext((tx) =>
    workItemDeliveryRepository.listDeliveredWorkItemRefs(tx, scope),
  );
  for (const row of delivered) byId.set(row.workItemId, row.workspaceId);
}

/** Arm two: every non-archived card sitting on some pull request's head ref. */
async function addSessionBranchCandidates(
  byId: CandidateMap,
  scope: { workspaceId?: string },
): Promise<void> {
  const headRefs = await withSystemContext((tx) =>
    githubPullRequestRepository.listHeadRefsWithWorkspace(tx, scope),
  );
  // Grouped so each workspace is bound ONCE rather than per ref.
  const refsByWorkspace = new Map<string, string[]>();
  for (const { workspaceId, headRef } of headRefs) {
    const bucket = refsByWorkspace.get(workspaceId);
    if (bucket) bucket.push(headRef);
    else refsByWorkspace.set(workspaceId, [headRef]);
  }
  for (const [workspaceId, refs] of refsByWorkspace) {
    const ids = await withSystemContext(async (tx) => {
      // ⚠️ BIND BEFORE THE FIRST `work_item` STATEMENT — it has no `system_admin`
      // arm, so an unbound read here returns ZERO ROWS and raises nothing, which
      // would present as "no session-branch cards" for a tenant full of them.
      await bindWorkspaceContext(tx, workspaceId);
      return workItemRepository.listIdsBySessionBranches(refs, workspaceId, tx);
    });
    for (const id of ids) if (!byId.has(id)) byId.set(id, workspaceId);
  }
}

/**
 * Arm three (MOTIR-10542): every non-archived card that still stores a verdict,
 * walked workspace by workspace. The workspace ids come off the `workspace` table
 * under system context, so each tenant is bound from data, never from input.
 */
async function addStoredVerdictCandidates(
  byId: CandidateMap,
  scope: { workspaceId?: string },
): Promise<void> {
  const workspaceIds = await withSystemContext((tx) => workspaceRepository.listIds(tx, scope));
  for (const workspaceId of workspaceIds) {
    const ids = await withSystemContext(async (tx) => {
      // ⚠️ Bound first, for the same reason as the session-branch arm.
      await bindWorkspaceContext(tx, workspaceId);
      return workItemRepository.listIdsWithStoredCiState(workspaceId, tx);
    });
    for (const id of ids) if (!byId.has(id)) byId.set(id, workspaceId);
  }
}

export const workItemCiStateBackfillService = {
  /**
   * Recompute `WorkItem.ciState` for every card that has pull requests, and for
   * every card that still stores a verdict with none left (MOTIR-10542).
   *
   * `dryRun` folds exactly what a real run would fold and reports the same
   * `from → to` pairs, writing nothing — it re-reads the card inside its own
   * transaction and computes the verdict without the write, rather than
   * predicting one. Both paths call into `deliveryVerdict`, so a dry run cannot
   * disagree with the run it is rehearsing.
   */
  async backfillCiState(opts: CiStateBackfillOptions): Promise<CiStateBackfillReport> {
    const candidates = await collectCandidates(opts);

    const report: CiStateBackfillReport = {
      dryRun: opts.dryRun,
      scanned: 0,
      changed: [],
      unchanged: 0,
      skippedArchived: 0,
      failed: [],
      total: candidates.length,
      interrupted: false,
    };
    const every = Math.max(1, opts.progressEvery ?? CI_STATE_BACKFILL_PROGRESS_EVERY);

    for (const [index, { workItemId, workspaceId }] of candidates.entries()) {
      if (opts.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      try {
        const outcome = await withSystemContext(async (tx) => {
          await bindWorkspaceContext(tx, workspaceId);
          const item = await workItemRepository.findById(workItemId, tx);
          // A card the bound tenant cannot see, or one that was deleted between
          // the candidate read and now, is not a failure — it is simply not a
          // candidate any more.
          /* v8 ignore next -- REACHABLE IN PRODUCTION, NOT FROM A TEST, and the
             distinction is the point: this is not dead code, it is a RACE arm.
             `collectCandidates` runs to completion first and the sweep can then
             take minutes, so a card really can be deleted underneath it — that is
             the whole reason the arm exists. Driving it needs a delete timed
             between the collection and this read, inside a sweep a test cannot
             pause, and the only other route (a delivery row naming a workspace its
             work item does not live in) is hand-written corruption, which would
             assert the fixture rather than the sweep. `tests/github/ciStateBackfill.test.ts`
             pins the neighbouring dispositions — archived is SKIPPED and counted,
             a card with no pull requests is not a candidate at all — so the
             classification either side of this line is covered. */
          if (!item) return { kind: 'gone' as const };
          if (item.archivedAt) return { kind: 'archived' as const };

          const from = (item.ciState ?? null) as PrCiState;

          if (opts.dryRun) {
            // The same classification the recompute folds, without the lock or
            // the write: there is nothing to serialize against when nothing is
            // written, and taking a row lock per card on a rehearsal would block
            // live traffic for the length of the sweep.
            const members = await classifyDeliveries(
              { id: item.id, sessionBranch: item.sessionBranch },
              tx,
            );
            const to = foldCardCiState(
              members.map((m) => deliveryStateForCard(m.state, m.cannotReport, m.queueFailure)),
            );
            return { kind: 'decided' as const, identifier: item.identifier, from, to };
          }

          const to = await recomputeWorkItemCiState(workItemId, tx);
          return { kind: 'decided' as const, identifier: item.identifier, from, to };
        });

        /* v8 ignore next -- the other half of the race arm above; same reason. */
        if (outcome.kind === 'gone') continue;
        report.scanned += 1;
        if (outcome.kind === 'archived') {
          report.skippedArchived += 1;
          continue;
        }
        if (outcome.from === outcome.to) report.unchanged += 1;
        else
          report.changed.push({
            workItemId,
            identifier: outcome.identifier,
            from: outcome.from,
            to: outcome.to,
          });
      } catch (err) {
        report.scanned += 1;
        report.failed.push({
          workItemId,
          /* v8 ignore next -- the non-`Error` throw. Reaching it means injecting a
             fault into the shipped recompute, which asserts the mock and not this
             sweep; what the arm BUYS is asserted instead — `tests/github/ciStateStoryGate.test.ts`
             §3 pins `report.failed` EMPTY across three card shapes, so a sweep that
             started throwing per card would fail there rather than reporting a
             silent partial. The ternary stays because `catch` binds `unknown`. */
          error: err instanceof Error ? err.message : 'unknown error',
        });
      } finally {
        // In `finally` so every exit from the body — the `gone` / `archived`
        // `continue`s and the `catch` — still counts toward the interval.
        const examined = index + 1;
        if (opts.onProgress && (examined % every === 0 || examined === candidates.length)) {
          opts.onProgress({
            examined,
            total: candidates.length,
            scanned: report.scanned,
            changed: report.changed.length,
            unchanged: report.unchanged,
            skippedArchived: report.skippedArchived,
            failed: report.failed.length,
          });
        }
      }
    }

    return report;
  },
};
