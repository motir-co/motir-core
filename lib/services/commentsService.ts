import type { Comment, Prisma, WorkItem } from '@/generated/prisma/client';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentMentionRepository } from '@/lib/repositories/commentMentionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { watchersService } from '@/lib/services/watchersService';
import { parseMentionIds } from '@/lib/mentions/parse';
import { parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
// The PUBLIC API's page ceiling (ADR §5) — imported, never re-declared, so the
// number a client is promised and the number enforced here cannot drift.
import { MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import {
  extractReferencedAttachmentIds,
  extractReferencedAttachmentIdsFromBodies,
} from '@/lib/blob/referencedUrls';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { toCommentDto, toCommentThreadDto } from '@/lib/mappers/commentMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import type { CommentDTO, CommentsPageDTO, DeletedCommentDTO } from '@/lib/dto/comments';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext, redactWithheldWorkItemRefs } from '@/lib/visitor/readScope';
import { readProject, readWorkItem } from '@/lib/workspaces/tenantRead';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Comments service (Story 5.1 · Subtask 5.1.2) — the business-logic core over
// the 5.1.1 repositories. Owns validation, the permission matrix, the
// single-level-threading rule, server-side mention parsing, transactions, DTO
// mapping, and the post-commit job event. Routes are HTTP-only (CLAUDE.md).
//
// Permission matrix (the Jira comment permissions mapped onto the shipped 6.4
// role model — see lib/projects/access.ts canComment/canModerateComments):
//   * add           — canComment (viewer is read-only → CommentForbiddenError)
//   * edit/delete   — the author themselves, OR canModerate (project admin /
//                     workspace owner-admin)
//   * everything    — view-gated: an issue the caller can't browse reads as
//                     WorkItemNotFoundError (→ 404, finding #44 — a hidden or
//                     cross-workspace id is indistinguishable from a
//                     never-existed one)
//
// Mentions: the service is the AUTHORITY. Every write parses
// `[@Name](mention:<userId>)` tokens (lib/mentions/parse.ts), validates each
// id against the members who can VIEW the issue — exactly the 6.4
// `assignableMembersService` scoping (private → project members; open/limited
// → workspace members), reused not duplicated — and silently DROPS the rest
// (the Jira rule: no view permission → no mention, never an error). The
// member-set read is reference data resolved BEFORE the transaction
// (assignableMembersService binds its own RLS context); the rows persist
// inside it.
//
// Events fire AFTER commit, never inside the tx — a rollback must not have
// notified anyone.

/** Jira-faithful page size — the newest window the Activity section renders. */
export const COMMENT_PAGE_SIZE = 20;

/**
 * Clamp a requested comment page size to `[1, MAX_PAGE_LIMIT]`, defaulting to
 * the shipped {@link COMMENT_PAGE_SIZE} (Subtask 11.2.8).
 *
 * The ceiling is the PUBLIC API's, imported rather than re-declared so the
 * number a client is promised and the number enforced here cannot drift. An
 * omitted / non-finite / non-positive value falls back to the shipped default,
 * which is what keeps every pre-existing caller byte-for-byte unchanged.
 */
function clampCommentPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return COMMENT_PAGE_SIZE;
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

export interface ListCommentsOptions {
  /** Resume strictly after this root-comment id (the previous page's last). */
  cursor?: string;
  /** Page-walk direction. Default oldest-first (the Jira default sort). */
  order?: 'asc' | 'desc';
  /**
   * How many ROOT comments to return. Defaults to {@link COMMENT_PAGE_SIZE} —
   * the shipped, Jira-faithful page size — so every existing caller is
   * unaffected by its addition.
   *
   * ⚠️ Added by Story 11.2 · Subtask 11.2.8 (MOTIR-2049) under the ADR's
   * Amendment 1 read-addressing carve-out: a page-SIZE parameter over an
   * UNCHANGED predicate. It adds no filter axis, no gate and no field. The
   * public API documents a `limit` a client may set, and a `?limit=` that
   * silently did nothing would be worse than not offering one at all.
   */
  limit?: number;
}

/** How a caller narrows the edit / delete doors. */
export interface CommentWriteOptions {
  /** Refuse every caller but the comment's author — see `editComment`. */
  ownOnly?: boolean;
}

/**
 * The edit-own / edit-all decision, in one place for both doors: the author
 * always may; anyone else needs the moderation tier, unless the caller asked
 * for the author alone.
 */
function mayWrite(
  authorId: string,
  gate: CommentGate,
  ctx: ServiceContext,
  options: CommentWriteOptions,
): boolean {
  if (authorId === ctx.userId) return true;
  return !options.ownOnly && gate.caps.canModerate;
}

interface CommentGate {
  item: WorkItem;
  caps: {
    canBrowse: boolean;
    canComment: boolean;
    canModerate: boolean;
    accessMode: 'workspace' | 'members' | 'public';
  };
}

/**
 * Resolve a work item AND the caller's comment capabilities on its project,
 * enforcing the two hide-gates: a missing / cross-workspace item AND a
 * non-browsable project both read as WorkItemNotFoundError (404 — finding
 * #44; "you can't see it" must be indistinguishable from "it doesn't exist").
 */
async function resolveGatedWorkItem(
  workItemId: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<CommentGate> {
  const item = await readWorkItem(workItemId, ctx, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  const caps = await projectAccessService.getCommentCapabilities(item.projectId, ctx, tx);
  if (!caps.canBrowse) throw new WorkItemNotFoundError(workItemId);
  return { item, caps };
}

/**
 * A Visitor's comment gate (MOTIR-6652): the item must be a live, VISIBLE row of
 * their one public project. Anything else — another project, a private epic's
 * descendant, an unknown id — is the same `WorkItemNotFoundError`.
 */
async function resolveVisitorGatedWorkItem(
  workItemId: string,
  ctx: VisitorReadContext,
): Promise<{ item: WorkItem }> {
  const item = await withWorkspaceServiceContext(ctx.project.workspaceId, (tx) =>
    workItemRepository.findById(workItemId, tx),
  );
  if (!item || item.projectId !== ctx.project.id || ctx.hiddenIds.has(item.id)) {
    throw new WorkItemNotFoundError(workItemId);
  }
  return { item };
}

/** A comment thread as a Visitor reads it — withheld chips redacted from every body. */
function redactThread<T extends { bodyMd: string; replies: Array<{ bodyMd: string }> }>(
  thread: T,
  hidden: ReadonlySet<string>,
): T {
  return {
    ...thread,
    bodyMd: redactWithheldWorkItemRefs(thread.bodyMd, hidden),
    replies: thread.replies.map((r) => ({
      ...r,
      bodyMd: redactWithheldWorkItemRefs(r.bodyMd, hidden),
    })),
  };
}

/**
 * Resolve a comment by id under the same hide-gates: missing or
 * cross-workspace → CommentNotFoundError (404, no existence leak).
 */
async function resolveComment(
  commentId: string,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
) {
  // Bound when the caller holds no transaction (MOTIR-2846) — the same gate
  // shape as `componentsService.resolveComponent`, and the same 404-for-a-row-
  // that-exists when the fallback reaches the singleton.
  const row = tx
    ? await commentRepository.findById(commentId, tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, (t) =>
        commentRepository.findById(commentId, t),
      );
  if (!row || row.workspaceId !== ctx.workspaceId) throw new CommentNotFoundError(commentId);
  return row;
}

/**
 * The user ids the body may validly mention — the members who can ENTER the
 * project, via `assignableMembersService` (the entry rule, reused, not
 * duplicated — Story MOTIR-6169 · MOTIR-6547). Reference-data read; runs OUTSIDE the write transaction (the
 * member service binds its own workspace context).
 */
async function resolveMentionableIds(gate: CommentGate, ctx: ServiceContext): Promise<Set<string>> {
  const members = await assignableMembersService.list({
    projectId: gate.item.projectId,
    accessMode: gate.caps.accessMode,
    ctx,
  });
  return new Set(members.map((m) => m.userId));
}

/** Validate + normalize an incoming body, throwing on blank. */
function requireBody(bodyMd: string): string {
  if (bodyMd.trim().length === 0) throw new EmptyCommentBodyError();
  return bodyMd;
}

/**
 * Link-on-write for a comment-body write (Subtask 5.2.3): an upload embedded
 * in a comment is an attachment of the COMMENT's issue, so add/edit/delete
 * re-resolve the linkage inside the write transaction — AFTER the comment row
 * itself is written/deleted, so the still-referenced-elsewhere guard probes
 * the body state this transaction commits. When anything links or unlinks, a
 * dedicated 'updated' revision records the `attachments` diff (the uniform
 * History trail — the deliberate fill of Jira's documented editor-add
 * changelog gap; see Story 5.2).
 */
async function syncCommentAttachmentLinks(
  workItem: WorkItem,
  previousIds: readonly string[],
  nextIds: readonly string[],
  actorId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (previousIds.length === 0 && nextIds.length === 0) return;
  const cell = await attachmentsService.syncEditorLinks({ workItem, previousIds, nextIds }, tx);
  if (!cell) return;
  await workItemRevisionsService.recordRevision(
    {
      workItemId: workItem.id,
      changedById: actorId,
      changeKind: 'updated',
      diff: { attachments: cell },
    },
    tx,
  );
}

/**
 * Auto-relate-on-mention for a comment body (Subtask 5.8.3): parse the
 * work-item references in `bodyMd` and auto-create a `relates_to` link from the
 * comment's work item to each viewable, same-workspace target — inside the
 * comment write transaction. The project read supplies the identifier prefix
 * bare keys (`KEY-N`) match against. Delegates the resolve / view-scope /
 * idempotent-create rules to the shared module; ADD-only and never throws out.
 */
async function autoRelateForBody(
  item: WorkItem,
  bodyMd: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const project = await readProject(item.projectId, ctx, tx);
  /* istanbul ignore if -- the item's project always resolves (the comment gate
     read it); the guard narrows the nullable type only */
  if (!project) return;
  await autoRelateWorkItemMentions(
    {
      source: {
        id: item.id,
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        projectIdentifier: project.identifier,
      },
      bodies: [bodyMd],
      ctx,
    },
    tx,
  );
}

/** Map one freshly-written comment row to its DTO (single-row side reads). */
async function toSingleCommentDto(row: Comment, mentionedUserIds: string[]): Promise<CommentDTO> {
  const authors = await userRepository.findByIds([row.authorId]);
  return toCommentDto(
    row,
    new Map(authors.map((u) => [u.id, u])),
    new Map([[row.id, mentionedUserIds]]),
  );
}

export const commentsService = {
  /**
   * Add a comment (or a single-level reply) to a work item. View-gated +
   * permission-gated; `parentCommentId` must point at a ROOT comment on the
   * SAME issue (depth > 1 → ReplyDepthExceededError — the UI attaches a
   * reply-to-a-reply to the root, 5.1.5). In ONE transaction: the comment row
   * + its validated mention rows. After commit: the
   * `work-item/comment.created` event.
   */
  async addComment(
    workItemId: string,
    input: { bodyMd: string; parentCommentId?: string | null },
    ctx: ServiceContext,
  ): Promise<CommentDTO> {
    const bodyMd = requireBody(input.bodyMd);
    const tokenIds = parseMentionIds(bodyMd);

    // Reference-data read (mention candidates) ahead of the tx — only when
    // the body actually mentions someone. The pre-gate also fails fast on a
    // hidden issue before any member read happens.
    let mentionable = new Set<string>();
    if (tokenIds.length > 0) {
      mentionable = await resolveMentionableIds(await resolveGatedWorkItem(workItemId, ctx), ctx);
    }

    const { row, storedMentionIds } = await withWorkspaceContext(ctx, async (tx) => {
      const gate = await resolveGatedWorkItem(workItemId, ctx, tx);
      if (!gate.caps.canComment) throw new CommentForbiddenError('add');

      if (input.parentCommentId) {
        const parent = await resolveComment(input.parentCommentId, ctx, tx);
        if (parent.workItemId !== gate.item.id) {
          throw new InvalidParentCommentError(input.parentCommentId);
        }
        if (parent.parentCommentId !== null) {
          throw new ReplyDepthExceededError(input.parentCommentId);
        }
      }

      const created = await commentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: gate.item.id,
          authorId: ctx.userId,
          parentCommentId: input.parentCommentId ?? null,
          bodyMd,
        },
        tx,
      );
      const stored = tokenIds.filter((id) => mentionable.has(id));
      await commentMentionRepository.createMany(
        stored.map((mentionedUserId) => ({ commentId: created.id, mentionedUserId })),
        tx,
      );

      // Link-on-write (5.2.3): uploads the new body references attach to the
      // comment's issue, in this same transaction.
      await syncCommentAttachmentLinks(
        gate.item,
        [],
        extractReferencedAttachmentIds(bodyMd),
        ctx.userId,
        tx,
      );

      // Auto-relate-on-mention (Subtask 5.8.3): a work-item reference in the
      // comment body auto-creates a `relates_to` link FROM the comment's work
      // item TO each viewable, same-workspace target, in THIS transaction.
      // ADD-only, idempotent, silent on a bad reference.
      await autoRelateForBody(gate.item, bodyMd, ctx, tx);

      // Auto-watch (Subtask 5.4.4, the verified comment rule, constant-on):
      // commenting watches the issue, in this SAME transaction. Idempotent by
      // the watcher unique; no revision (watching is not a field change).
      // Story 5.7's opt-out preference will live inside the hook, not here.
      await watchersService.autoWatch(gate.item.id, ctx.userId, tx);

      // Triage snooze-return (Story 6.11 · Subtask 6.11.5, ADR §5): new activity
      // returns a SNOOZED triage item to the active queue ("a comment / edit
      // clears `snoozedUntil`"). Only fires when the item is actually snoozed —
      // a no-op for every ordinary comment.
      if (gate.item.snoozedUntil) {
        await workItemRepository.update(gate.item.id, { snoozedUntil: null }, tx);
      }

      return { row: created, storedMentionIds: stored };
    });

    // Post-commit, never inside the tx — a rollback must not have notified.
    // Automation provenance (6.6.3): a comment WRITTEN by an `add_comment`
    // action carries the rule id, so the `commented`-trigger consumer skips it
    // (loop prevention) while mention/watcher emails still fan out.
    await sendEvent('work-item/comment.created', {
      workspaceId: ctx.workspaceId,
      workItemId,
      commentId: row.id,
      authorId: ctx.userId,
      mentionedUserIds: storedMentionIds,
      ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
    });

    return toSingleCommentDto(row, storedMentionIds);
  },

  /**
   * Edit a comment's body. Author edits their own; project admin / workspace
   * owner-admin edit all (the Jira "Edit own / Edit all" split). Sets
   * `editedAt` (the "Edited" tag) — except on a no-op edit (identical body),
   * which returns unchanged without writing or notifying. Mentions re-parse
   * and diff in the same tx; newly-added mentions re-fire the
   * `work-item/comment.created` event carrying ONLY the new ids.
   *
   * `options.ownOnly` narrows the door to the AUTHOR alone (MOTIR-5295): the
   * moderation tier is not consulted, so a non-author is refused even when
   * their role could moderate. The MCP adapter passes it because a token's
   * grant is checked against ONE key per tool and `comment:moderate` is not a
   * key any token can hold — without it, a token granted only `comment:add`
   * would inherit its owner's moderation reach. Checked on the row read INSIDE
   * the transaction, so it cannot race the write.
   */
  async editComment(
    commentId: string,
    input: { bodyMd: string },
    ctx: ServiceContext,
    options: CommentWriteOptions = {},
  ): Promise<CommentDTO> {
    const bodyMd = requireBody(input.bodyMd);
    const tokenIds = parseMentionIds(bodyMd);

    // Pre-tx: resolve the comment → its issue (both hide-gated) for the
    // reference-data mention read.
    const preGate = await resolveGatedWorkItem(
      (await resolveComment(commentId, ctx)).workItemId,
      ctx,
    );
    const mentionable =
      tokenIds.length > 0 ? await resolveMentionableIds(preGate, ctx) : new Set<string>();

    const { row, storedMentionIds, addedMentionIds, changed } = await withWorkspaceContext(
      ctx,
      async (tx) => {
        const current = await resolveComment(commentId, ctx, tx);
        const gate = await resolveGatedWorkItem(current.workItemId, ctx, tx);
        if (!mayWrite(current.authorId, gate, ctx, options)) {
          throw new CommentForbiddenError('edit');
        }

        const prevRows = await commentMentionRepository.findByCommentIds([commentId], tx);
        const prevIds = prevRows.map((m) => m.mentionedUserId);

        if (current.bodyMd === bodyMd) {
          // No-op edit: no write, no "Edited" tag, no event.
          return { row: current, storedMentionIds: prevIds, addedMentionIds: [], changed: false };
        }

        const stored = tokenIds.filter((id) => mentionable.has(id));
        const prevSet = new Set(prevIds);
        const added = stored.filter((id) => !prevSet.has(id));

        const updated = await commentRepository.update(
          commentId,
          { bodyMd, editedAt: new Date() },
          tx,
        );
        // Clear-and-rewrite keeps the row set exactly the re-parse result
        // (drops removed mentions, keeps kept ones, adds new ones).
        await commentMentionRepository.deleteByCommentId(commentId, tx);
        await commentMentionRepository.createMany(
          stored.map((mentionedUserId) => ({ commentId, mentionedUserId })),
          tx,
        );

        // Link-on-write (5.2.3): diff the old body's referenced uploads
        // against the new body's — runs AFTER the row update so a URL this
        // edit removed no longer counts as "still referenced" by this
        // comment, and a URL kept elsewhere on the issue stays linked.
        await syncCommentAttachmentLinks(
          gate.item,
          extractReferencedAttachmentIds(current.bodyMd),
          extractReferencedAttachmentIds(bodyMd),
          ctx.userId,
          tx,
        );

        // Auto-relate-on-mention (5.8.3): an edit can ADD a new work-item
        // reference → a new `relates_to` link. ADD-only (a removed reference
        // never deletes the link) and idempotent (a kept reference re-adds
        // nothing). Parses the NEW body.
        await autoRelateForBody(gate.item, bodyMd, ctx, tx);

        return { row: updated, storedMentionIds: stored, addedMentionIds: added, changed: true };
      },
    );

    if (changed && addedMentionIds.length > 0) {
      await sendEvent('work-item/comment.created', {
        workspaceId: ctx.workspaceId,
        workItemId: row.workItemId,
        commentId: row.id,
        authorId: ctx.userId,
        mentionedUserIds: addedMentionIds,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
    }

    return toSingleCommentDto(row, storedMentionIds);
  },

  /**
   * HARD-delete a comment (the Jira-faithful semantics — no tombstone).
   * Author deletes their own; project admin / workspace owner-admin delete
   * all. For a ROOT, the DB cascade takes its replies + mention rows; in the
   * SAME transaction a `work_item_revision` row (changeKind
   * `comment_deleted`) records that a comment by X was deleted by Y, reply
   * count included — the surviving History trace Story 5.5 renders.
   *
   * Returns what was removed, so a caller that cannot see the thread (the MCP
   * `delete_comment` adapter) can report it. `options.ownOnly` is the same
   * author-only narrowing {@link editComment} documents.
   */
  async deleteComment(
    commentId: string,
    ctx: ServiceContext,
    options: CommentWriteOptions = {},
  ): Promise<DeletedCommentDTO> {
    return withWorkspaceContext(ctx, async (tx) => {
      const current = await resolveComment(commentId, ctx, tx);
      const gate = await resolveGatedWorkItem(current.workItemId, ctx, tx);
      if (!mayWrite(current.authorId, gate, ctx, options)) {
        throw new CommentForbiddenError('delete');
      }

      // A root's replies, read BEFORE the cascade takes them: their count
      // feeds the deletion trace, their bodies feed the link-on-write unlink
      // below (the thread's embeds vanish with it — Subtask 5.2.3).
      const replies =
        current.parentCommentId === null ? await commentRepository.listReplies(current.id, tx) : [];
      const replyCount = replies.length;

      await workItemRevisionsService.recordRevision(
        {
          workItemId: current.workItemId,
          changedById: ctx.userId,
          changeKind: 'comment_deleted',
          diff: {
            comment: {
              from: { commentId: current.id, authorId: current.authorId, replyCount },
              to: null,
            },
          },
        },
        tx,
      );
      await commentRepository.delete(current.id, tx);

      // Link-on-write (5.2.3): uploads only this thread's bodies referenced
      // unlink (GC-eligible, 5.2.7) — the Jira analogue: deleting the comment
      // removes the attachment from the issue. Runs AFTER the delete so the
      // still-referenced probe sees the post-cascade comment set; a URL the
      // description or a surviving comment still references stays linked.
      await syncCommentAttachmentLinks(
        gate.item,
        extractReferencedAttachmentIdsFromBodies([
          current.bodyMd,
          ...replies.map((reply) => reply.bodyMd),
        ]),
        [],
        ctx.userId,
        tx,
      );

      return {
        commentId: current.id,
        workItemId: current.workItemId,
        parentCommentId: current.parentCommentId,
        replyCount,
      };
    });
  },

  /**
   * One cursor-paged window of a work item's comment THREADS (finding #57 —
   * never a load-all): up to {@link COMMENT_PAGE_SIZE} roots, each carrying
   * its whole single-level thread (replies are bounded by the threading
   * decision). `totalCount` counts every comment, replies included (the
   * Activity header + "Show more comments (N older)" denominator). View-gated
   * like every read. Default order oldest-first (the Jira default); `desc`
   * walks newest-first.
   */
  async listComments(
    workItemId: string,
    options: ListCommentsOptions,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<CommentsPageDTO> {
    // A VISITOR (MOTIR-6652) reads the comments of a VISIBLE item of their one
    // public project; a hidden or foreign item is the same not-found an unknown
    // one is, and every chip naming a withheld item is redacted from the bodies.
    const visitor = isVisitorContext(ctx) ? ctx : null;
    const gate = visitor
      ? await resolveVisitorGatedWorkItem(workItemId, visitor)
      : await resolveGatedWorkItem(workItemId, ctx as ServiceContext);
    const workspaceId = gate.item.workspaceId;
    const order = options.order ?? 'asc';
    const pageSize = clampCommentPageSize(options.limit);

    // take+1 probes for a next page without a second count read.
    const window = await withWorkspaceServiceContext(workspaceId, (tx) =>
      commentRepository.listThreadsByWorkItem(
        workItemId,
        { take: pageSize + 1, cursor: options.cursor, order },
        tx,
      ),
    );
    const roots = window.slice(0, pageSize);
    const hasMore = window.length > pageSize;

    const pageComments = roots.flatMap((root) => [root, ...root.replies]);
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // The view gate (`resolveGatedWorkItem`) is awaited above, so the refusal
    // path is already spent; these three are peer reads of a page whose
    // visibility is settled.
    const [mentionRows, authors, totalCount] = await Promise.all([
      withWorkspaceServiceContext(workspaceId, (tx) =>
        commentMentionRepository.findByCommentIds(
          pageComments.map((c) => c.id),
          tx,
        ),
      ),
      userRepository.findByIds([...new Set(pageComments.map((c) => c.authorId))]),
      withWorkspaceServiceContext(workspaceId, (tx) =>
        commentRepository.countByWorkItem(workItemId, tx),
      ),
    ]);

    const mentionsByCommentId = new Map<string, string[]>();
    for (const m of mentionRows) {
      const bucket = mentionsByCommentId.get(m.commentId);
      if (bucket) bucket.push(m.mentionedUserId);
      else mentionsByCommentId.set(m.commentId, [m.mentionedUserId]);
    }
    const authorsById = new Map(authors.map((u) => [u.id, u]));

    // Resolve the `motir:` token references in this page's comment bodies to
    // live summaries (Subtask 5.8.6), so MarkdownView renders the internal-link
    // chip. Token ids only — a bare `KEY-N` inside a comment body is the
    // deferred body-bare-key linkify (it needs the editor's 5.8.5 token anyway).
    const tokenIds = [...new Set(pageComments.flatMap((c) => parseWorkItemTokenIds(c.bodyMd)))];
    const workItemRefs = await resolveWorkItemRefSummaries(
      { ids: tokenIds, keys: [] },
      gate.item.projectId,
      ctx,
    );

    const threads = roots.map((root) => toCommentThreadDto(root, authorsById, mentionsByCommentId));
    return {
      threads: visitor ? threads.map((t) => redactThread(t, visitor.hiddenIds)) : threads,
      totalCount,
      nextCursor: hasMore ? (roots[roots.length - 1]?.id ?? null) : null,
      order,
      workItemRefs,
    };
  },

  /**
   * The per-row COMMENT-COUNT projection for a PAGE of work items (MOTIR-2001) —
   * for each requested id, how many comments it holds, replies INCLUDED. The
   * same number {@link listComments} reports as `totalCount` and the Activity
   * header renders, so the badge on a list row and the thread behind it can
   * never disagree.
   *
   * Shaped exactly like `workItemsService.getDependencyEdgesForItems`, its
   * sibling projection:
   *
   * - ONE query for the whole page, never one read per row — the batched
   *   `countByWorkItemIds` leaf. Empty input short-circuits to `{}` without
   *   touching the DB.
   * - TOTAL: the result carries an entry for EVERY requested id, pre-seeded to
   *   `0`, so a row the `GROUP BY` returned no bucket for still gets a number
   *   and a renderer never branches on presence.
   * - TENANCY: scoped to `ctx.workspaceId`, so a comment in another tenant can
   *   never be counted — even if a caller handed over a foreign id.
   *
   * NOT view-gated per id, for the same reason its sibling is not: the caller
   * supplies ids from a page it has ALREADY gated (`getIssueDetail` /
   * `listReady` / `getProjectIssuesList` each run the workspace check +
   * `assertCanBrowse` first). An item the caller cannot see is never a row here,
   * so it never gets a count.
   */
  async getCommentCountsForItems(
    workItemIds: string[],
    ctx: ServiceContext,
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const id of workItemIds) counts[id] = 0;
    if (workItemIds.length === 0) return counts;

    // Every returned bucket is one of `workItemIds` — that is the `where` — so
    // the assignment overwrites a seeded zero and never invents a key.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      commentRepository.countByWorkItemIds(workItemIds, ctx.workspaceId, tx),
    );
    for (const row of rows) counts[row.workItemId] = row.count;
    return counts;
  },
};
