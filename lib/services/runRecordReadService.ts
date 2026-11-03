import type {
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
import { commentRepository } from '@/lib/repositories/commentRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
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
  cursor?: string | undefined;
  limit?: number | undefined;
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
}

export type RunRecordSearchResult =
  | { outcome: 'found'; runs: RunRecordRow[]; nextCursor: string | null }
  /** A page that matched nothing is the end of the list: there is never a cursor to follow. */
  | { outcome: 'nothing_matched'; runs: []; nextCursor: null };

/** What a run recorded as different on one leg — the comment the finding points to. */
export interface RunRecordDiscrepancy {
  commentId: string;
  pointCount: number;
  decisionCount: number;
  /** The comment body verbatim, bounded; null when the comment no longer exists. */
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

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The finding's POINTER, read defensively: `data` is JSON the writer shaped. */
function pointerOf(
  data: unknown,
): { commentId: string; pointCount: number; decisionCount: number } | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d['commentId'] !== 'string') return null;
  return {
    commentId: d['commentId'],
    pointCount: isNumber(d['pointCount']) ? d['pointCount'] : 0,
    decisionCount: isNumber(d['decisionCount']) ? d['decisionCount'] : 0,
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

    let rows: RunRecordRow[];
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
    return { outcome: 'found', runs: rows, nextCursor };
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
        const findings = await dispatchRunEventRepository.listDiscrepancyFindings(runId, tx);
        const pointers = new Map<string, NonNullable<ReturnType<typeof pointerOf>>>();
        for (const finding of findings) {
          const pointer = pointerOf(finding.data);
          // One record per leg; the first stands, as the writer refuses a second.
          if (finding.dispatchRunCardId && pointer && !pointers.has(finding.dispatchRunCardId)) {
            pointers.set(finding.dispatchRunCardId, pointer);
          }
        }
        const comments = await commentRepository.findManyByIds(
          [...pointers.values()].map((p) => p.commentId),
          tx,
        );
        const bodies = new Map(comments.map((c) => [c.id, c.bodyMd]));
        const byLeg = new Map<string, RunRecordDiscrepancy>();
        for (const [legId, pointer] of pointers) {
          const body = bodies.get(pointer.commentId);
          const bounded = body === undefined ? null : bound(body, RUN_RECORD_DISCREPANCY_BODY_MAX);
          byLeg.set(legId, {
            ...pointer,
            bodyMd: bounded?.text ?? null,
            bodyTruncated: bounded?.truncated ?? false,
          });
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
