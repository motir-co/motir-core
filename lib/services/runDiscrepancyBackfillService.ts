import {
  DISCREPANCY_COMMENT_HEADERS,
  parseDiscrepancyComment,
  type ParsedDiscrepancyComment,
} from '@/lib/dispatchRuns/discrepancyComment';
import { toEntryInputs } from '@/lib/dispatchRuns/discrepancyRecord';
import {
  commentRepository,
  type UnrecordedDiscrepancyComment,
} from '@/lib/repositories/commentRepository';
import {
  dispatchRunEventRepository,
  type DiscrepancyFindingForBackfill,
} from '@/lib/repositories/dispatchRunEventRepository';
import { runDiscrepancyRecordRepository } from '@/lib/repositories/runDiscrepancyRecordRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import type { Prisma } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

// BACKFILL THE RUN DISCREPANCY RECORDS WRITTEN BEFORE THEY WERE DATA (Task MOTIR-11361).
//
// Since MOTIR-11361 every `record_run_discrepancy` call writes a `run_discrepancy_record`
// beside its comment. The calls made before that left only the comment (and, on an open
// leg, a pointer-only `discrepancy_recorded` finding), so this sweep reads them back. Two
// populations, per workspace:
//
//   1. FINDINGS — every `discrepancy_recorded` event, first per leg. Its comment is parsed
//      with `parseDiscrepancyComment`, the composer's exact inverse. Parsed ⇒ a
//      `backfilled` record on that run and leg. Comment deleted, or edited out of the
//      record's shape ⇒ a `backfill_unreadable` record holding the counts the finding
//      carried and no entries, so the record is REPORTED in the data as well as here.
//   2. COMMENTS no finding points to — the no-open-leg arm wrote no event, so the comment
//      is found by the composer's header. Parsed ⇒ a `backfilled` record tied to the card
//      and project with no run. Not parsed ⇒ REPORTED only: with no finding there is no
//      evidence beyond the header that it was ever a record, and no counts to keep.
//
// Nothing is dropped silently: every candidate ends in the report as backfilled,
// unreadable, already recorded, skipped (with its reason) or failed.
//
// IDEMPOTENT: a recorded leg or comment reads `already recorded` next time, and the
// columns are unique, so a SECOND RUN WRITES 0. ONE TRANSACTION PER CANDIDATE, so one
// failure does not roll back the rest and an interrupt keeps its progress. The dry run
// decides through the same code and writes nothing.
//
// One workspace at a time, bound with `bindWorkspaceContext` inside a system transaction:
// the record tables have only the `_active_workspace` arm, so the workspace is bound
// before every read and write (`CLAUDE.md` § Tenancy).

/** Why a candidate was not backfilled and no record was written for it. */
export type RunDiscrepancyBackfillSkipReason =
  /** The finding's `data` is not the pointer the writer writes. */
  | 'malformed_finding'
  /** The leg's card was deleted, so there is no card to tie the record to. */
  | 'card_deleted';

/** Why a record could not be read back from its comment. */
export type RunDiscrepancyUnreadableReason = 'comment_deleted' | 'comment_unparseable';

export interface RunDiscrepancyBackfillUnreadable {
  /** `finding` ⇒ a `backfill_unreadable` record was (or, dry, would be) written. */
  from: 'finding' | 'comment';
  /** The finding's id, or the comment's. */
  id: string;
  workItemId: string;
  reason: RunDiscrepancyUnreadableReason;
}

export interface RunDiscrepancyBackfillReport {
  dryRun: boolean;
  /** Candidates the sweep set out to examine. */
  total: number;
  examined: number;
  /** Records parsed back and written (or, dry, that would be). */
  backfilled: number;
  unreadable: RunDiscrepancyBackfillUnreadable[];
  alreadyRecorded: number;
  skipped: Array<{ id: string; reason: RunDiscrepancyBackfillSkipReason }>;
  failed: Array<{ id: string; error: string }>;
  interrupted: boolean;
}

export interface RunDiscrepancyBackfillOptions {
  dryRun: boolean;
  workspaceId?: string;
  /** Checked BEFORE each candidate; once aborted the partial report is returned. */
  signal?: AbortSignal;
}

type Candidate =
  | { from: 'finding'; workspaceId: string; finding: DiscrepancyFindingForBackfill }
  | { from: 'comment'; workspaceId: string; comment: UnrecordedDiscrepancyComment };

type Outcome =
  | { kind: 'backfilled' }
  | { kind: 'already' }
  | { kind: 'skipped'; reason: RunDiscrepancyBackfillSkipReason }
  | { kind: 'unreadable'; workItemId: string; reason: RunDiscrepancyUnreadableReason };

interface Pointer {
  commentId: string;
  /** Every entry, points and decisions together — the writer's `pointCount`. */
  entryCount: number;
  decisionCount: number;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** The finding's pointer, read defensively: `data` is JSON. Null when it is not one. */
export function pointerOf(data: unknown): Pointer | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d['commentId'] !== 'string') return null;
  return {
    commentId: d['commentId'],
    entryCount: count(d['pointCount']),
    decisionCount: count(d['decisionCount']),
  };
}

/** One workspace's candidates: the findings (first per leg), then the comments none names. */
async function collectWorkspace(workspaceId: string): Promise<Candidate[]> {
  return withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    const findings = await dispatchRunEventRepository.listDiscrepancyFindingsForBackfill(
      workspaceId,
      tx,
    );
    const comments = await commentRepository.listUnrecordedDiscrepancyComments(
      workspaceId,
      DISCREPANCY_COMMENT_HEADERS,
      tx,
    );
    const out: Candidate[] = [];
    const legs = new Set<string>();
    const named = new Set<string>();
    for (const finding of findings) {
      // The writer refuses a second record per leg; the first finding stands.
      if (finding.dispatchRunCardId) {
        if (legs.has(finding.dispatchRunCardId)) continue;
        legs.add(finding.dispatchRunCardId);
      }
      const pointer = pointerOf(finding.data);
      if (pointer) named.add(pointer.commentId);
      out.push({ from: 'finding', workspaceId, finding });
    }
    for (const comment of comments) {
      if (!named.has(comment.id)) out.push({ from: 'comment', workspaceId, comment });
    }
    return out;
  });
}

function countsOf(parsed: ParsedDiscrepancyComment) {
  return { pointCount: parsed.points.length, decisionCount: parsed.decisions.length };
}

/** Decide (and, unless dry, write) one finding's record. */
async function backfillFinding(
  workspaceId: string,
  finding: DiscrepancyFindingForBackfill,
  dryRun: boolean,
  tx: Prisma.TransactionClient,
): Promise<Outcome> {
  const pointer = pointerOf(finding.data);
  const legId = finding.dispatchRunCardId;
  if (!pointer || !legId) return { kind: 'skipped', reason: 'malformed_finding' };
  if (await runDiscrepancyRecordRepository.findByLeg(legId, tx)) return { kind: 'already' };
  const workItemId = finding.card?.workItemId ?? null;
  if (!workItemId) return { kind: 'skipped', reason: 'card_deleted' };

  const found = await commentRepository.findById(pointer.commentId, tx);
  const comment = found && found.workItemId === workItemId ? found : null;
  const parsed = comment ? parseDiscrepancyComment(comment.bodyMd) : null;
  const base = {
    workspaceId,
    projectId: finding.dispatchRun.projectId,
    workItemId,
    dispatchRunId: finding.dispatchRunId,
    dispatchRunCardId: legId,
    commentId: comment?.id ?? null,
    recordedById: comment?.authorId ?? null,
  };
  if (parsed) {
    if (!dryRun) {
      await runDiscrepancyRecordRepository.create(
        {
          ...base,
          source: 'backfilled',
          ...countsOf(parsed),
          recordedAt: comment!.createdAt,
          entries: toEntryInputs(parsed.points, parsed.decisions),
        },
        tx,
      );
    }
    return { kind: 'backfilled' };
  }
  if (!dryRun) {
    await runDiscrepancyRecordRepository.create(
      {
        ...base,
        source: 'backfill_unreadable',
        pointCount: Math.max(pointer.entryCount - pointer.decisionCount, 0),
        decisionCount: pointer.decisionCount,
        recordedAt: finding.createdAt,
        entries: [],
      },
      tx,
    );
  }
  return {
    kind: 'unreadable',
    workItemId,
    reason: comment ? 'comment_unparseable' : 'comment_deleted',
  };
}

/** Decide (and, unless dry, write) one comment's record — the no-open-leg arm. */
async function backfillComment(
  workspaceId: string,
  comment: UnrecordedDiscrepancyComment,
  dryRun: boolean,
  tx: Prisma.TransactionClient,
): Promise<Outcome> {
  if (await runDiscrepancyRecordRepository.findByCommentId(comment.id, tx)) {
    return { kind: 'already' };
  }
  const parsed = parseDiscrepancyComment(comment.bodyMd);
  if (!parsed) {
    return { kind: 'unreadable', workItemId: comment.workItemId, reason: 'comment_unparseable' };
  }
  if (!dryRun) {
    await runDiscrepancyRecordRepository.create(
      {
        workspaceId,
        projectId: comment.workItem.projectId,
        workItemId: comment.workItemId,
        dispatchRunId: null,
        dispatchRunCardId: null,
        commentId: comment.id,
        recordedById: comment.authorId,
        source: 'backfilled',
        ...countsOf(parsed),
        recordedAt: comment.createdAt,
        entries: toEntryInputs(parsed.points, parsed.decisions),
      },
      tx,
    );
  }
  return { kind: 'backfilled' };
}

function tally(report: RunDiscrepancyBackfillReport, candidate: Candidate, outcome: Outcome) {
  const id = candidate.from === 'finding' ? candidate.finding.id : candidate.comment.id;
  if (outcome.kind === 'backfilled') report.backfilled += 1;
  else if (outcome.kind === 'already') report.alreadyRecorded += 1;
  else if (outcome.kind === 'skipped') report.skipped.push({ id, reason: outcome.reason });
  else {
    report.unreadable.push({
      from: candidate.from,
      id,
      workItemId: outcome.workItemId,
      reason: outcome.reason,
    });
  }
}

export const runDiscrepancyBackfillService = {
  /** Write a record for every discrepancy the run record and the comments still hold. */
  async backfill(opts: RunDiscrepancyBackfillOptions): Promise<RunDiscrepancyBackfillReport> {
    const workspaceIds = await withSystemContext((tx) =>
      workspaceRepository.listIds(tx, opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    );
    const candidates: Candidate[] = [];
    for (const workspaceId of workspaceIds)
      candidates.push(...(await collectWorkspace(workspaceId)));

    const report: RunDiscrepancyBackfillReport = {
      dryRun: opts.dryRun,
      total: candidates.length,
      examined: 0,
      backfilled: 0,
      unreadable: [],
      alreadyRecorded: 0,
      skipped: [],
      failed: [],
      interrupted: false,
    };
    for (const candidate of candidates) {
      if (opts.signal?.aborted) {
        report.interrupted = true;
        break;
      }
      report.examined += 1;
      try {
        const outcome = await withSystemContext(async (tx) => {
          await bindWorkspaceContext(tx, candidate.workspaceId);
          return candidate.from === 'finding'
            ? backfillFinding(candidate.workspaceId, candidate.finding, opts.dryRun, tx)
            : backfillComment(candidate.workspaceId, candidate.comment, opts.dryRun, tx);
        });
        tally(report, candidate, outcome);
      } catch (err) {
        report.failed.push({
          id: candidate.from === 'finding' ? candidate.finding.id : candidate.comment.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return report;
  },
};
