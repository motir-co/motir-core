import type {
  RunDiscrepancySource,
  DispatchCardDisposition,
  DispatchCommand,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchSkipReason,
  DispatchStopReason,
} from '@/generated/prisma/client';
import { DispatchRunNotFoundError, RUN_DISCREPANCY_FIELD_MAX } from '@/lib/dispatchRuns/errors';
import type { DispatchRunLegCountsDto } from '@/lib/dto/dispatchRuns';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  composeDiscrepancyComment,
  type RunDecisionPoint,
  type RunDiscrepancyPoint,
} from '@/lib/dispatchRuns/discrepancyComment';
import { fromEntries } from '@/lib/dispatchRuns/discrepancyRecord';
import type { RunDiscrepancyFilter } from '@/lib/repositories/dispatchRunRepository';
import {
  runDiscrepancyRecordRepository,
  type RunDiscrepancyRecordWithEntries,
} from '@/lib/repositories/runDiscrepancyRecordRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES,
  DISPATCH_RUN_LIST_DEFAULT_TAKE,
  DISPATCH_RUN_LIST_MAX_TAKE,
  DISPATCH_RUN_LIVE_STATUSES,
  DISPATCH_RUN_PAST_STATUSES,
  dispatchRunService,
} from './dispatchRunService';
import { projectsService } from './projectsService';

// THE RUN-RECORD READ (MOTIR-10240) — what a planning session may ask about a run
// of ITS OWN project: which runs match a card, a scope or a status (SEARCH), and
// for one run how it ended and what it recorded as different (READ). The door
// `app/api/internal/ai/{search,get}-run-record` and the MCP `search_run_records` /
// `get_run_record` share.
//
// It COMPOSES the run reads that exist — `listRunsForProject`,
// `listRunsForWorkItemKey`, `getRunDetail` — and their access logic stays theirs.
// What it adds is the one rule they do not enforce on a plain service context:
//
// ⚠️ THE RUN MUST BELONG TO THE PROJECT ASKED ABOUT. `getRunDetail` pins a run to a
// project only for a visitor reader; for an ordinary service context it answers
// any run of the workspace the reader may see. So `readRun` re-checks
// `run.projectId === projectId`, and a run of another project answers
// `not_found` — the same bytes as an unknown id, an unreadable leg, or another
// workspace's run. Likewise a `workItemKey` of another project matches nothing.
//
// ⚠️ ABSENCE IS AN OUTCOME, NEVER A THROW: `found`, `nothing_matched`, `not_found`.
// The consumer is a model, and "no run did that" is an answer it reasons from.
//
// ⚠️ RUN TEXT IS AGENT-WRITTEN. The hosted end line and the discrepancy comment
// are returned verbatim in their own named fields, bounded, and never merged
// into a sentence of the door's own.
//
// Read-only: nothing here writes a run, a finding or a comment.

/** The longest hosted end-line detail a record carries — the discrepancy field bound. */
export const RUN_RECORD_END_DETAIL_MAX = RUN_DISCREPANCY_FIELD_MAX;
/** The longest discrepancy comment body a record carries — one event body's bound. */
export const RUN_RECORD_DISCREPANCY_BODY_MAX = DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES;

/** A bounded text field, and whether it was cut. */
function bound(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

/** The statuses a run can carry — the live and past partitions together. */
export const RUN_RECORD_STATUSES: readonly DispatchRunStatus[] = [
  ...DISPATCH_RUN_LIVE_STATUSES,
  ...DISPATCH_RUN_PAST_STATUSES,
];

/** What a search narrows by. `workItemKey` and `scopeWorkItemKey` are two questions; ask one. */
export interface RunRecordSearchFilters {
  /** Runs that carried a LEG for this card. */
  workItemKey?: string | undefined;
  /** Runs whose SCOPE is this container. */
  scopeWorkItemKey?: string | undefined;
  statuses?: DispatchRunStatus[] | undefined;
  /**
   * Only runs with at least one discrepancy record (MOTIR-11361): one holding a point
   * (`points`), a decision (`decisions`), or either (`any`).
   */
  discrepancy?: RunDiscrepancyFilter | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** What a run's legs recorded as different, as counts — a search row's (MOTIR-11361). */
export interface RunRecordRowDiscrepancies {
  /** Legs holding a record. */
  records: number;
  points: number;
  decisions: number;
}

/** One run as a search row: the header and its set as COUNTS, never as legs. */
export interface RunRecordRow {
  id: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  status: DispatchRunStatus;
  stopReason: DispatchStopReason | null;
  startedAt: string;
  endedAt: string | null;
  cardCount: number;
  legs: DispatchRunLegCountsDto;
  discrepancies: RunRecordRowDiscrepancies;
}

export type RunRecordSearchResult =
  | { outcome: 'found'; runs: RunRecordRow[]; nextCursor: string | null }
  /** A page that matched nothing is the end of the list: there is never a cursor to follow. */
  | { outcome: 'nothing_matched'; runs: []; nextCursor: null };

/**
 * What a run recorded as different on one leg — read from the STRUCTURED record
 * (MOTIR-11361), never from the comment, which may have been edited or deleted.
 */
export interface RunRecordDiscrepancy {
  recordId: string;
  /** `recorded` by the door, `backfilled` from an old comment, or `backfill_unreadable`. */
  source: RunDiscrepancySource;
  /** The comment written beside the record — its link; null once it was deleted. */
  commentId: string | null;
  /** Every entry, points and decisions together (the finding's `pointCount`, as before). */
  pointCount: number;
  decisionCount: number;
  /** The build-through points, field by field as the run sent them. */
  points: RunDiscrepancyPoint[];
  /** The decisions, field by field as the run sent them. */
  decisions: RunDecisionPoint[];
  /**
   * The record rendered as the comment renders it — composed from `points` and
   * `decisions`, so it no longer depends on the comment existing. Bounded; null for a
   * `backfill_unreadable` record, which has no entries to render.
   */
  bodyMd: string | null;
  bodyTruncated: boolean;
}

export interface RunRecordLeg {
  key: string | null;
  disposition: DispatchCardDisposition;
  skipReason: DispatchSkipReason | null;
  exitCode: number | null;
  discrepancy: RunRecordDiscrepancy | null;
}

export interface RunRecord {
  id: string;
  command: DispatchCommand;
  origin: DispatchRunOrigin;
  status: DispatchRunStatus;
  stopReason: DispatchStopReason | null;
  startedAt: string;
  endedAt: string | null;
  /** A hosted (or in-agent) run's closing line; null for a run that has none. */
  hostedEnd: {
    outcome: string | null;
    detail: string | null;
    detailTruncated: boolean;
    exitCode: number | null;
  } | null;
  legs: RunRecordLeg[];
}

export type RunRecordReadResult = { outcome: 'found'; run: RunRecord } | { outcome: 'not_found' };

/** The legs as counts, all zero — the starting tally. */
function zeroLegs(): DispatchRunLegCountsDto {
  return {
    queued: 0,
    running: 0,
    integrated: 0,
    implemented: 0,
    failed: 0,
    replanned: 0,
    skipped: 0,
    not_reached: 0,
  };
}

function legCounts(dispositions: DispatchCardDisposition[]): DispatchRunLegCountsDto {
  const counts = zeroLegs();
  for (const d of dispositions) counts[d] += 1;
  return counts;
}

/** One stored record as the leg's discrepancy. */
function discrepancyOf(record: RunDiscrepancyRecordWithEntries): RunRecordDiscrepancy {
  const { points, decisions } = fromEntries(record.entries);
  const readable = points.length + decisions.length > 0;
  const body = readable
    ? bound(composeDiscrepancyComment(points, decisions), RUN_RECORD_DISCREPANCY_BODY_MAX)
    : null;
  return {
    recordId: record.id,
    source: record.source,
    commentId: record.commentId,
    pointCount: record.pointCount + record.decisionCount,
    decisionCount: record.decisionCount,
    points,
    decisions,
    bodyMd: body?.text ?? null,
    bodyTruncated: body?.truncated ?? false,
  };
}

/** A project-access or not-found refusal — every one of them reads as an absence here. */
function isAbsence(err: unknown): boolean {
  return (
    err instanceof DispatchRunNotFoundError ||
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof ProjectAccessDeniedError
  );
}

export const runRecordReadService = {
  /**
   * The runs of `projectId` matching `filters`, newest first, at most
   * {@link DISPATCH_RUN_LIST_MAX_TAKE} per page. A card or scope that is unknown,
   * of another project, or not visible to the reader matches nothing.
   *
   * The project itself is RESOLVED and BROWSE-GATED by the composed reads: a
   * reader who cannot browse it gets their `ProjectNotFoundError`, which the
   * caller maps (it is a fact about the credential, not about runs).
   */
  async searchRuns(
    projectId: string,
    filters: RunRecordSearchFilters,
    ctx: ServiceContext,
  ): Promise<RunRecordSearchResult> {
    const project = await projectsService.assertProjectInWorkspace(projectId, ctx.workspaceId);
    const take = Math.min(
      Math.max(filters.limit ?? DISPATCH_RUN_LIST_DEFAULT_TAKE, 1),
      DISPATCH_RUN_LIST_MAX_TAKE,
    );
    const statuses = filters.statuses && filters.statuses.length > 0 ? filters.statuses : null;

    let rows: Omit<RunRecordRow, 'discrepancies'>[];
    let nextCursor: string | null;
    if (filters.workItemKey) {
      const key = filters.workItemKey.trim().toUpperCase();
      const dash = key.lastIndexOf('-');
      // A card of ANOTHER project is not this project's history.
      const owner =
        dash > 0
          ? await projectsService.getByKey(key.slice(0, dash), ctx).catch((err: unknown) => {
              if (isAbsence(err)) return null;
              throw err;
            })
          : null;
      if (owner?.id !== projectId)
        return { outcome: 'nothing_matched', runs: [], nextCursor: null };
      let runs;
      try {
        runs = await dispatchRunService.listRunsForWorkItemKey(
          key,
          {
            take,
            ...(filters.cursor ? { cursor: filters.cursor } : {}),
            ...(statuses ? { statuses } : {}),
            ...(filters.discrepancy ? { discrepancy: filters.discrepancy } : {}),
          },
          ctx,
        );
      } catch (err) {
        if (err instanceof WorkItemNotFoundError) {
          return { outcome: 'nothing_matched', runs: [], nextCursor: null };
        }
        throw err;
      }
      // The status narrows the QUERY, as on the project and scope paths, so a page
      // is never shortened after the read and an empty page is the end (MOTIR-10286).
      nextCursor = runs.length === take ? (runs[runs.length - 1]?.id ?? null) : null;
      rows = runs.map((run) => ({
        id: run.id,
        command: run.command,
        origin: run.origin,
        status: run.status,
        stopReason: run.stopReason,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        cardCount: run.cards.length,
        legs: legCounts(run.cards.map((c) => c.disposition)),
      }));
    } else {
      let page;
      try {
        page = await dispatchRunService.listRunsForProject(
          project.identifier,
          {
            take,
            ...(filters.cursor ? { cursor: filters.cursor } : {}),
            ...(statuses ? { statuses } : {}),
            ...(filters.scopeWorkItemKey ? { scopeWorkItemKey: filters.scopeWorkItemKey } : {}),
            ...(filters.discrepancy ? { discrepancy: filters.discrepancy } : {}),
          },
          ctx,
        );
      } catch (err) {
        if (err instanceof WorkItemNotFoundError) {
          return { outcome: 'nothing_matched', runs: [], nextCursor: null };
        }
        throw err;
      }
      nextCursor = page.runs.length === take ? (page.runs[page.runs.length - 1]?.id ?? null) : null;
      rows = page.runs.map((run) => ({
        id: run.id,
        command: run.command,
        origin: run.origin,
        status: run.status,
        stopReason: run.stopReason,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        cardCount: run.cardCount,
        legs: run.legs,
      }));
    }
    // Every narrowing is applied by the query, so an empty page is short and has no cursor.
    if (rows.length === 0) return { outcome: 'nothing_matched', runs: [], nextCursor: null };
    const counts = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      (tx) =>
        runDiscrepancyRecordRepository.countsByRuns(
          rows.map((r) => r.id),
          tx,
        ),
    );
    const byRun = new Map(counts.map((c) => [c.dispatchRunId, c]));
    return {
      outcome: 'found',
      runs: rows.map((row) => {
        const c = byRun.get(row.id);
        return {
          ...row,
          discrepancies: {
            records: c?.records ?? 0,
            points: c?.points ?? 0,
            decisions: c?.decisions ?? 0,
          },
        };
      }),
      nextCursor,
    };
  },

  /**
   * One run of `projectId`: how it ended, and per leg what it recorded as
   * different. A run that is unknown, of another project or workspace, or that
   * the reader may not see is `not_found` — one answer for all of them.
   */
  async readRun(
    projectId: string,
    runId: string,
    ctx: ServiceContext,
  ): Promise<RunRecordReadResult> {
    let detail;
    try {
      detail = await dispatchRunService.getRunDetail(runId, ctx);
    } catch (err) {
      if (isAbsence(err)) return { outcome: 'not_found' };
      throw err;
    }
    if (detail.projectId !== projectId) return { outcome: 'not_found' };

    const discrepancies = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const records = await runDiscrepancyRecordRepository.listByRun(runId, tx);
        const byLeg = new Map<string, RunRecordDiscrepancy>();
        // One record per leg (the column is unique); a record no leg holds any more is
        // the card's, not this run's.
        for (const record of records) {
          if (record.dispatchRunCardId) {
            byLeg.set(record.dispatchRunCardId, discrepancyOf(record));
          }
        }
        return byLeg;
      },
    );

    const end = detail.hostedEnd;
    const detailText = end?.detail == null ? null : bound(end.detail, RUN_RECORD_END_DETAIL_MAX);
    return {
      outcome: 'found',
      run: {
        id: detail.id,
        command: detail.command,
        origin: detail.origin,
        status: detail.status,
        stopReason: detail.stopReason,
        startedAt: detail.startedAt,
        endedAt: detail.endedAt,
        hostedEnd: end
          ? {
              outcome: end.outcome,
              detail: detailText?.text ?? null,
              detailTruncated: detailText?.truncated ?? false,
              exitCode: end.exitCode,
            }
          : null,
        legs: detail.cards.map((card) => ({
          key: card.key,
          disposition: card.disposition,
          skipReason: card.skipReason,
          exitCode: card.exitCode,
          discrepancy: discrepancies.get(card.id) ?? null,
        })),
      },
    };
  },
};
