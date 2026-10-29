import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { deriveFixReason, recomputeWorkItemFixReason } from './fixReasonService';

// BACKFILL `WorkItem.fixReason` FOR THE CARDS THAT ALREADY EXIST (Story MOTIR-6588 ·
// MOTIR-6603). The `ciState` backfill (MOTIR-5472, `workItemCiStateBackfillService`)
// is the precedent, and this file keeps its shape on purpose.
//
// ── Why a backfill is owed at all ───────────────────────────────────────────
// The wiring (MOTIR-6602) makes every FUTURE event recompute the answer. A card that
// was already stuck when it deployed — failed in the queue last week, sent back by a
// reviewer a month ago — has no next event coming, so it would read `null` for ever
// and never appear on the To fix tab. Those long-forgotten cards are exactly the ones
// the tab exists to surface.
//
// ── IT NEVER RE-IMPLEMENTS THE RULE ─────────────────────────────────────────
// Each card is handed to `recomputeWorkItemFixReason` — the SAME function the live
// path calls, which reads `motir fix`'s own predicate. A backfill that decided the
// reason in SQL would be a second opinion, and it would drift on the first amendment
// to either.
//
// ── RESUMABLE, IDEMPOTENT, and a dry run that predicts exactly ──────────────
// One transaction per card, so an interrupted run keeps its progress; a failing card
// is recorded and the sweep moves on. The recompute writes only when the value moved,
// so a second run reports `changed: 0`. The dry run calls `deriveFixReason` — the
// recompute's own derivation, without the lock or the write — so it cannot disagree
// with the run it rehearses.

export type FixReasonValueLabel = WorkItemFixReasonDto | null;

/** One card whose reason the sweep moved. */
export interface FixReasonBackfillChange {
  workItemId: string;
  identifier: string;
  from: FixReasonValueLabel;
  to: FixReasonValueLabel;
}

export interface FixReasonBackfillFailure {
  workItemId: string;
  error: string;
}

export interface FixReasonBackfillReport {
  dryRun: boolean;
  /** Candidate cards examined. */
  scanned: number;
  changed: FixReasonBackfillChange[];
  unchanged: number;
  /** Candidates skipped because the card is ARCHIVED — a human decided it should
   *  not be worked, so it is not listed as needing a repair either. */
  skippedArchived: number;
  failed: FixReasonBackfillFailure[];
  /** How many examined cards read each reason AFTER the sweep (`none` for null) —
   *  the To fix tab's population, by reason, as the sweep left it. */
  byReason: Record<WorkItemFixReasonDto | 'none', number>;
  /** How many candidates the sweep set out to examine. */
  total: number;
  /** `true` when `signal` stopped the sweep before it reached every candidate. */
  interrupted: boolean;
}

export interface FixReasonBackfillProgress {
  examined: number;
  total: number;
  scanned: number;
  changed: number;
  unchanged: number;
  skippedArchived: number;
  failed: number;
}

/** The progress interval when the caller does not name one. */
export const FIX_REASON_BACKFILL_PROGRESS_EVERY = 100;

export interface FixReasonBackfillOptions {
  dryRun: boolean;
  workspaceId?: string;
  onProgress?: (progress: FixReasonBackfillProgress) => void;
  progressEvery?: number;
  /** Checked BEFORE each candidate; once aborted the sweep returns the partial report
   *  with `interrupted: true`. */
  signal?: AbortSignal;
}

/**
 * The candidate set, paired with the workspace to bind for each: every card in an
 * `in_progress`-category status (archived included, to be counted as skipped), plus
 * any card still carrying a reason — see the repository read.
 *
 * A card whose run DIED before `run_died` existed (MOTIR-6880) needs no wider read:
 * `run_died` holds only at In Progress, which is in the category, so every such card
 * is already a candidate, and the recompute is what decides it. One workspace at a
 * time, because `work_item` has no system arm and an unbound read of it would come
 * back EMPTY rather than refused.
 */
async function collectCandidates(
  opts: FixReasonBackfillOptions,
): Promise<Array<{ workItemId: string; workspaceId: string }>> {
  const workspaceIds = await withSystemContext((tx) =>
    workspaceRepository.listIds(tx, opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
  );
  const out: Array<{ workItemId: string; workspaceId: string }> = [];
  for (const workspaceId of workspaceIds) {
    const ids = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      return workItemRepository.listFixReasonBackfillCandidateIds(workspaceId, tx);
    });
    for (const workItemId of ids) out.push({ workItemId, workspaceId });
  }
  return out;
}

function emptyByReason(): FixReasonBackfillReport['byReason'] {
  return {
    run_died: 0,
    queue_failed: 0,
    conflicted: 0,
    out_of_date: 0,
    ci_failed: 0,
    changes_requested: 0,
    none: 0,
  };
}

export const workItemFixReasonBackfillService = {
  /** Recompute `WorkItem.fixReason` for every live card that could carry one. */
  async backfillFixReason(opts: FixReasonBackfillOptions): Promise<FixReasonBackfillReport> {
    const candidates = await collectCandidates(opts);

    const report: FixReasonBackfillReport = {
      dryRun: opts.dryRun,
      scanned: 0,
      changed: [],
      unchanged: 0,
      skippedArchived: 0,
      failed: [],
      byReason: emptyByReason(),
      total: candidates.length,
      interrupted: false,
    };
    const every = Math.max(1, opts.progressEvery ?? FIX_REASON_BACKFILL_PROGRESS_EVERY);

    for (const [index, { workItemId, workspaceId }] of candidates.entries()) {
      if (opts.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      try {
        const outcome = await withSystemContext(async (tx) => {
          await bindWorkspaceContext(tx, workspaceId);
          const item = await workItemRepository.findById(workItemId, tx);
          /* v8 ignore next -- a RACE arm: a card deleted between the candidate read and
             this one, which a test cannot time (the ciState backfill records the same). */
          if (!item) return { kind: 'gone' as const };
          if (item.archivedAt) return { kind: 'archived' as const };

          const from = (item.fixReason ?? null) as FixReasonValueLabel;
          // The dry run derives without the lock: nothing is written, so there is
          // nothing to serialise against, and a row lock per card on a rehearsal would
          // block live traffic for the length of the sweep.
          const to = opts.dryRun
            ? (await deriveFixReason(item, tx)).fixReason
            : (await recomputeWorkItemFixReason(workItemId, tx)).fixReason;
          return { kind: 'decided' as const, identifier: item.identifier, from, to };
        });

        /* v8 ignore next -- the other half of the race arm above. */
        if (outcome.kind === 'gone') continue;
        report.scanned += 1;
        if (outcome.kind === 'archived') {
          report.skippedArchived += 1;
          continue;
        }
        report.byReason[outcome.to ?? 'none'] += 1;
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
          /* v8 ignore next -- the non-`Error` throw; `catch` binds `unknown`. */
          error: err instanceof Error ? err.message : 'unknown error',
        });
      } finally {
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
