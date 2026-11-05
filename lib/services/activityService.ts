// =================================================================
// Activity read service (Story 5.5 · Subtask 5.5.1) — the READ-ONLY mapping
// layer over the append-only `work_item_revision` trail (1.4.6): one issue's
// History feed, paged and human-renderable. This service owns NO writes and
// no transaction — the trail is append-only for everyone (the verified Jira
// rule: history has no edit/delete surface, admins included), so no mutation
// method exists here, in the repository extensions, or in any route.
//
// Shape of a read (finding #57 — bounded, never load-all):
//   1. View-gate: the work item must exist in the caller's workspace, else
//      WorkItemNotFoundError → 404 (no cross-workspace existence leak,
//      finding #44).
//   2. Page the trail via the EXISTING 1.4.6 cursor read (both orders walk
//      the same (workItemId, changedAt) index), filtering out the revisions
//      the registry's noise policy suppresses (pure position/backlogRank
//      reorders, denormalised key/identifier writes). The scan is bounded:
//      at most MAX_SCANNED_ROWS rows per call — a noise-heavy stretch may
//      return a short page with a non-null cursor, and "Show more" continues.
//   3. Resolve every referenced display value in ONE batched lookup set per
//      page (users, the project's status labels, sprint names, linked-issue
//      identifiers) — no per-entry queries. Deleted referents degrade to a
//      stored-id fallback value, never a crash.
//   4. Map rows → ActivityEntryDto via the TOTAL renderer registry
//      (lib/activity/renderers.ts): every audited diff key has an explicit
//      disposition, unknown keys render the generic entry (mistake #29).

import type {
  Sprint,
  User,
  WorkItem,
  WorkflowStatus,
  WorkItemRevision,
} from '@/generated/prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { reviewChecklistRowsOf } from '@/lib/agentReview/checklist';
import { userRepository } from '@/lib/repositories/userRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { toActivityEntryDto } from '@/lib/mappers/activityMappers';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  collectDiffRefs,
  emptyDiffRefs,
  isDisplayableRevision,
  SUPPRESSED_DIFF_KEYS,
  type ActivityUserValue,
  type DisplayResolvers,
} from '@/lib/activity/renderers';
import type {
  ActivityAllEntryDto,
  ActivityAllPageDto,
  ActivityEntryDto,
  ActivityHistoryPageDto,
  ActivityListOptions,
  ActivityValueDto,
} from '@/lib/dto/activity';
import type { CommentThreadDTO } from '@/lib/dto/comments';
import { commentsService } from '@/lib/services/commentsService';
import { InvalidActivityCursorError } from '@/lib/activity/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';
import type { Prisma } from '@/generated/prisma/client';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';
import { readWorkItem } from '@/lib/workspaces/tenantRead';

/** Displayable entries per page — the History tab's "Show more" stride. */
export const ACTIVITY_PAGE_SIZE = 20;
/** Rows fetched per repository read while skipping suppressed noise. */
const SCAN_BATCH_SIZE = 20;
/** Hard per-call bound on scanned rows (finding #57) — 5 batches. */
const MAX_SCANNED_ROWS = 100;

interface ScanResult {
  rows: WorkItemRevision[];
  nextCursor: string | null;
}

/**
 * Walk the trail from `cursor` collecting up to ACTIVITY_PAGE_SIZE displayable
 * revisions, reading at most MAX_SCANNED_ROWS rows in SCAN_BATCH_SIZE chunks.
 * `nextCursor` is the last row CONSUMED (displayable or not) whenever more
 * rows may remain — so a follow-up call never re-reads a skipped stretch.
 */
async function scanDisplayable(
  workItemId: string,
  cursor: string | undefined,
  order: 'asc' | 'desc',
  tx?: Prisma.TransactionClient,
): Promise<ScanResult> {
  const rows: WorkItemRevision[] = [];
  let scanned = 0;
  let lastConsumedId: string | null = null;
  let batchCursor = cursor;
  let moreMayRemain = true;

  while (moreMayRemain && rows.length < ACTIVITY_PAGE_SIZE && scanned < MAX_SCANNED_ROWS) {
    const batch = await workItemRevisionRepository.listByWorkItem(
      workItemId,
      { take: SCAN_BATCH_SIZE, cursor: batchCursor, order },
      tx,
    );
    if (batch.length === 0) {
      moreMayRemain = false;
      break;
    }

    for (let i = 0; i < batch.length; i++) {
      const row = batch[i] as WorkItemRevision;
      scanned += 1;
      lastConsumedId = row.id;
      if (isDisplayableRevision(row.changeKind, row.diff)) rows.push(row);
      if (rows.length === ACTIVITY_PAGE_SIZE || scanned === MAX_SCANNED_ROWS) {
        // Stopped mid-stream: rows may remain after the one just consumed —
        // later in this batch, or beyond a full batch. Hand back the
        // consumption point; an exactly-at-the-end cursor just yields one
        // empty final page.
        moreMayRemain = i < batch.length - 1 || batch.length === SCAN_BATCH_SIZE;
        break;
      }
    }
    if (rows.length === ACTIVITY_PAGE_SIZE || scanned === MAX_SCANNED_ROWS) break;

    if (batch.length < SCAN_BATCH_SIZE) {
      moreMayRemain = false;
      break;
    }
    batchCursor = (batch[batch.length - 1] as WorkItemRevision).id;
  }

  return { rows, nextCursor: moreMayRemain ? lastConsumedId : null };
}

/**
 * The id a Visitor's history carries for a withheld work item (MOTIR-6652) — a
 * fixed token, never the item's own id, so the entry cannot be followed or
 * correlated. It renders as the not-found fallback (no identifier).
 */
export const WITHHELD_ISSUE_ID = 'withheld';

/**
 * Resolve the item an activity read is about, for either reader. A member's
 * gate is the workspace check plus `project:browse`; a Visitor's (MOTIR-6652)
 * is a live, VISIBLE row of their one public project. Every refusal is the same
 * `WorkItemNotFoundError` an unknown id gets.
 */
async function resolveActivityItem(
  workItemId: string,
  ctx: ServiceContext | VisitorReadContext,
): Promise<{ item: WorkItem; workspaceId: string; hidden?: ReadonlySet<string> }> {
  if (isVisitorContext(ctx)) {
    const workspaceId = ctx.project.workspaceId;
    const item = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item || item.projectId !== ctx.project.id || ctx.hiddenIds.has(item.id)) {
      throw new WorkItemNotFoundError(workItemId);
    }
    return { item, workspaceId, hidden: ctx.hiddenIds };
  }
  const item = await readWorkItem(workItemId, ctx);
  if (!item || item.workspaceId !== ctx.workspaceId) {
    throw new WorkItemNotFoundError(workItemId);
  }
  return { item, workspaceId: ctx.workspaceId };
}

/**
 * Build the page's DisplayResolvers from ONE batched lookup set: gather every
 * id the page references (actors + diff refs), then at most one read per
 * source. Missing referents resolve to the stored-id fallback form.
 */
async function buildResolvers(
  rows: WorkItemRevision[],
  item: WorkItem,
  ctx: Pick<ServiceContext, 'workspaceId'>,
  // A Visitor's private-epic exclusion (MOTIR-6652): a withheld item — or one in
  // another project — renders as an UNAVAILABLE item, naming neither its id nor
  // its key, so a re-parent or a link to it tells a Visitor nothing.
  hidden?: ReadonlySet<string>,
): Promise<DisplayResolvers> {
  const refs = emptyDiffRefs();
  for (const row of rows) {
    refs.users.add(row.changedById);
    collectDiffRefs(row.changeKind, row.diff, refs);
  }

  // The three tenant reads share ONE bound transaction; `user` carries no policy
  // (checked against `pg_policies`), so it stays on the singleton.
  const users =
    refs.users.size > 0 ? await userRepository.findByIds([...refs.users]) : ([] as User[]);
  const { statuses, sprints, issues, folders, reviewRecords } = await withWorkspaceServiceContext(
    ctx.workspaceId,
    async (tx) => ({
      statuses:
        refs.statuses.size > 0
          ? await workflowsRepository.findStatuses(item.projectId, ctx.workspaceId, tx)
          : ([] as WorkflowStatus[]),
      sprints:
        refs.sprints.size > 0
          ? await sprintRepository.findByIds([...refs.sprints], ctx.workspaceId, tx)
          : ([] as Sprint[]),
      issues:
        refs.issues.size > 0
          ? await workItemRepository.findByIds([...refs.issues], tx)
          : ([] as WorkItem[]),
      folders: refs.folders.size > 0 ? await folderRepository.findByIds([...refs.folders], tx) : [],
      // The checklist rows an agent-verdict entry draws (MOTIR-10460), read from the
      // RECORDS — held to this card, so a snapshot naming another card's record shows none.
      reviewRecords:
        refs.reviewRecords.size > 0
          ? await reviewVerdictRecordRepository.findChecklistsForWorkItem(
              item.id,
              [...refs.reviewRecords],
              tx,
            )
          : [],
    }),
  );

  const userById = new Map(users.map((u) => [u.id, u]));
  const checklistByRecord = new Map(
    reviewRecords.map((r) => [r.id, reviewChecklistRowsOf(r.checklist)]),
  );
  const statusByKey = new Map(statuses.map((s) => [s.key, s]));
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  // Identifiers stay workspace-gated even through old diffs (finding #44):
  // a foreign-workspace id — impossible today, but cheap to refuse — renders
  // as the not-found fallback rather than leaking its identifier.
  const folderById = new Map(
    folders.filter((f) => f.workspaceId === ctx.workspaceId).map((f) => [f.id, f]),
  );
  const issueById = new Map(
    issues
      .filter((w) => w.workspaceId === ctx.workspaceId)
      .filter((w) => !hidden || (w.projectId === item.projectId && !hidden.has(w.id)))
      .map((w) => [w.id, w]),
  );

  return {
    user(id: string): ActivityUserValue {
      const u = userById.get(id);
      return { type: 'user', userId: id, name: u?.name ?? null, image: storedAssetUrl(u?.image) };
    },
    status(key: string): ActivityValueDto {
      return { type: 'status', key, label: statusByKey.get(key)?.label ?? null };
    },
    sprint(id: string): ActivityValueDto {
      return { type: 'sprint', sprintId: id, name: sprintById.get(id)?.name ?? null };
    },
    issue(id: string): ActivityValueDto {
      if (hidden && !issueById.has(id)) {
        return { type: 'issue', workItemId: WITHHELD_ISSUE_ID, identifier: null };
      }
      return { type: 'issue', workItemId: id, identifier: issueById.get(id)?.identifier ?? null };
    },
    // A folder renders by its CURRENT name; one deleted since the entry was
    // written has none to show, and says so rather than printing an id.
    folder(id: string): ActivityValueDto {
      const name = folderById.get(id)?.name;
      return name === undefined ? { type: 'none' } : { type: 'text', text: name };
    },
    reviewChecklist(recordId: string) {
      return checklistByRecord.get(recordId) ?? [];
    },
  };
}

/**
 * The decoded composite cursor of the All stream (Subtask 5.5.2): one
 * independent position per source. `null` means "from the start" — a source
 * whose entries all sorted after the emitted page keeps its prior position,
 * and an exhausted source just re-reads empty (one cheap bounded read). The
 * wire form is opaque base64url JSON; clients never construct it.
 */
interface AllCursorState {
  /** The last EMITTED comment-thread root id, or null (from the start). */
  c: string | null;
  /** The last consumed revision position, or null (from the start). */
  h: string | null;
}

function encodeAllCursor(state: AllCursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeAllCursor(raw: string | undefined): AllCursorState {
  if (raw === undefined) return { c: null, h: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidActivityCursorError();
  }
  if (parsed === null || typeof parsed !== 'object' || !('c' in parsed) || !('h' in parsed)) {
    throw new InvalidActivityCursorError();
  }
  const { c, h } = parsed as { c: unknown; h: unknown };
  if (c !== null && typeof c !== 'string') throw new InvalidActivityCursorError();
  if (h !== null && typeof h !== 'string') throw new InvalidActivityCursorError();
  return { c, h };
}

/**
 * The All stream's total order, as a comparable key: `(timestamp, type, id)`.
 * Timestamps are the mappers' `Date.toISOString()` output — fixed-width UTC,
 * so lexicographic comparison IS chronological comparison. The type rank
 * breaks exact-timestamp ties deterministically (comments before history in
 * ascending order); the id never actually decides a head-to-head comparison
 * (same-type order is the source's own `(timestamp, id)` order, preserved by
 * the two-pointer walk) but completes the documented total order.
 */
type MergeKey = readonly [timestamp: string, typeRank: 0 | 1, id: string];

function commentKey(thread: CommentThreadDTO): MergeKey {
  return [thread.createdAt, 0, thread.id];
}

function historyKey(entry: ActivityEntryDto): MergeKey {
  return [entry.changedAt, 1, entry.id];
}

function compareKeysAsc(a: MergeKey, b: MergeKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

export const activityService = {
  /**
   * One page of an issue's History feed: displayable revisions in
   * `(changedAt, id)` order (newest-first by default; `asc` for the
   * section's oldest-first toggle), each rendered to typed parts, plus the
   * displayable `totalCount` and the continuation cursor. View-gated; 404 on
   * unknown / cross-workspace ids.
   */
  async listHistory(
    workItemId: string,
    options: ActivityListOptions,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<ActivityHistoryPageDto> {
    const order = options.order ?? 'desc';
    const { item, workspaceId, hidden } = await resolveActivityItem(workItemId, ctx);
    // `project:browse` (Story MOTIR-2291 · Subtask MOTIR-2365). The inventory
    // called this row `existing`; the same row's `Gate today` said "workspace
    // only", and the code agreed — the workspace check above was the whole of it,
    // so any workspace member could read the full revision history of any work
    // item in any project. That contradiction inside one line of a `done`
    // document is what the CLAIMED_BUT_UNVERIFIED bucket exists to surface. The
    // project comes from the ITEM, never from the actor's active project.
    // A Visitor's gate was the visible-row check above; they hold `project:browse`.
    if (!isVisitorContext(ctx)) {
      await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');
    }

    // The count and the page it heads share ONE bound transaction: unbound the
    // count read 0, so the "show more" affordance vanished from an item with a
    // long history — a missing door rather than a visible error.
    const { totalCount, scan } = await withWorkspaceServiceContext(workspaceId, async (tx) => ({
      totalCount: await workItemRevisionRepository.countDisplayableByWorkItem(
        workItemId,
        [...SUPPRESSED_DIFF_KEYS],
        tx,
      ),
      scan: await scanDisplayable(workItemId, options.cursor, order, tx),
    }));

    const resolvers = await buildResolvers(scan.rows, item, { workspaceId }, hidden);
    return {
      entries: scan.rows.map((row) => toActivityEntryDto(row, resolvers)),
      nextCursor: scan.nextCursor,
      totalCount,
    };
  },

  /**
   * One page of the **All** merged stream (Subtask 5.5.2): the 5.1.2 comment
   * threads and the 5.5.1 history entries interleaved in true timestamp
   * order. Bounded two-source merge (finding #57): ONE paged read per source
   * from its own position in the composite cursor, a two-pointer merge over
   * the two pre-sorted buffers, the first page-worth emitted, and a composite
   * `nextCursor` carrying each source's new position — never
   * fetch-all-then-sort, never a restart from the top.
   *
   * The merge stops early (a SHORT page with a non-null cursor) when one
   * source's buffer drains while more of it may remain server-side — emitting
   * past that frontier could mis-order against the source's next page. The
   * cursor still advances, so "Show more" always progresses.
   *
   * View-gated like every read; 404 on unknown / cross-workspace ids;
   * malformed composite cursors throw {@link InvalidActivityCursorError}
   * (→ 400). Read-only — the section's sort toggle picks `order`, applied to
   * both sources identically.
   */
  async listAll(
    workItemId: string,
    options: ActivityListOptions,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<ActivityAllPageDto> {
    const order = options.order ?? 'desc';
    const cursor = decodeAllCursor(options.cursor);

    const { item, workspaceId, hidden } = await resolveActivityItem(workItemId, ctx);

    // One bounded read per source (each from its own cursor) + the History
    // total. listComments re-checks the gate it owns (capability-aware) —
    // an acceptable double-read; its threads arrive mapped to the native
    // 5.1 DTO, which is exactly what an All comment entry is.
    // `listComments` is a SERVICE call and opens its own context (the
    // call-into-another-service clause in the transaction-shape ADR); this
    // method's own two reads share one.
    const commentsPage = await commentsService.listComments(
      workItemId,
      { cursor: cursor.c ?? undefined, order },
      ctx,
    );
    const { scan, totalChanges } = await withWorkspaceServiceContext(workspaceId, async (tx) => ({
      scan: await scanDisplayable(workItemId, cursor.h ?? undefined, order, tx),
      totalChanges: await workItemRevisionRepository.countDisplayableByWorkItem(
        workItemId,
        [...SUPPRESSED_DIFF_KEYS],
        tx,
      ),
    }));

    const resolvers = await buildResolvers(scan.rows, item, { workspaceId }, hidden);
    const history = scan.rows.map((row) => toActivityEntryDto(row, resolvers));
    const comments = commentsPage.threads;

    // Two-pointer merge: pick the head that comes first in the active order.
    // `compareKeysAsc` never returns 0 across sources (the type rank splits
    // exact-timestamp ties), and descending order is its exact reverse — the
    // total order stays consistent with each source's own walk direction.
    const entries: ActivityAllEntryDto[] = [];
    let ci = 0;
    let hi = 0;
    let lastCommentId = cursor.c;
    let lastHistoryId = cursor.h;
    while (entries.length < ACTIVITY_PAGE_SIZE) {
      const cHead = ci < comments.length ? comments[ci] : undefined;
      const hHead = hi < history.length ? history[hi] : undefined;
      if (!cHead && !hHead) break;
      // A drained buffer whose source may hold more rows is a hard frontier:
      // the other source must not emit past it (its next page could sort
      // earlier). Stop; the composite cursor resumes both sides.
      /* istanbul ignore next -- defensive: unreachable while COMMENT_PAGE_SIZE === ACTIVITY_PAGE_SIZE (each emitted thread fills a page slot, so the comment buffer can only drain when the page is already full or the source is exhausted); kept so a future page-size divergence cannot mis-order */
      if (!cHead && commentsPage.nextCursor !== null) break;
      // The history buffer CAN drain mid-page: the bounded noise scan may
      // return fewer than a page of displayable rows with more remaining.
      if (!hHead && scan.nextCursor !== null) break;

      let pickComment: boolean;
      if (!cHead) pickComment = false;
      else if (!hHead) pickComment = true;
      else {
        const cmp = compareKeysAsc(commentKey(cHead), historyKey(hHead));
        pickComment = order === 'asc' ? cmp < 0 : cmp > 0;
      }

      if (pickComment) {
        const thread = cHead as CommentThreadDTO;
        entries.push({ type: 'comment', thread });
        lastCommentId = thread.id;
        ci += 1;
      } else {
        const entry = hHead as ActivityEntryDto;
        entries.push({ type: 'history', entry });
        lastHistoryId = entry.id;
        hi += 1;
      }
    }

    const commentsRemain = ci < comments.length || commentsPage.nextCursor !== null;
    const historyRemain = hi < history.length || scan.nextCursor !== null;
    // A fully-drained history buffer resumes at the SCAN's cursor (it may sit
    // past a trailing suppressed-noise stretch the scan already consumed);
    // a partially-emitted buffer resumes after the last emitted entry.
    const nextHistoryId =
      hi === history.length && scan.nextCursor !== null ? scan.nextCursor : lastHistoryId;

    return {
      entries,
      nextCursor:
        commentsRemain || historyRemain
          ? encodeAllCursor({ c: lastCommentId, h: nextHistoryId })
          : null,
      totalComments: commentsPage.totalCount,
      totalChanges,
      // The comment refs the nested listComments already resolved (5.8.6) — the
      // All view threads them to its CommentRows so chips render live, not as a
      // struck-through bare key.
      workItemRefs: commentsPage.workItemRefs ?? {},
    };
  },
};
