import type { Prisma } from '@/generated/prisma/client';
import {
  createPageComment,
  deletePageComment,
  editPageComment,
  listPageAnchoredRoots,
  listPageCommentThreads,
  pageStoreFor,
  readPageCommentThread,
  reopenPageCommentThread,
  replyToPageComment,
  resolvePageCommentThread,
  systemClock,
  type DeletePageCommentResult,
  type PageCommentActor,
  type PageCommentAnchorInput,
  type PageCommentDto,
  type PageCommentOrder,
  type PageCommentThreadDto,
  type PageCommentThreadStatus,
  type PageCommentThreadsPage,
  type PageStore,
} from '@/lib/pages';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { parseMentionIds } from '@/lib/mentions/parse';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { resolveMarkdownBodiesWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// PAGE COMMENTS — the service (Story MOTIR-10866 · MOTIR-10873), shaped exactly
// like `pagesService`: THE SERVICE DECIDES ACCESS; THE PACKAGE DECIDES CONTENT.
//
// Each method opens ONE `withWorkspaceContext` transaction bound to the page's
// project (the page tables carry the project-narrowing policy), asserts access
// FIRST, then runs one `@motir/pages` procedure over `pageStoreFor(tx)`. Every
// package refusal passes through unchanged.
//
// ⚠️ THE GATE ORDER decides which of 404, 403 and 409 a caller sees:
//   1. `assertCanViewPages` — a non-browser is `ProjectAccessDeniedError('browse')`
//      (404, the same bytes as an unknown page), a browser without `page:view`
//      is `'edit'` (403);
//   2. a WRITE then needs `comment:add` — `PermissionDeniedError` (403) — so a
//      viewer is refused 403 on an archived page too;
//   3. the package: a page outside the project (404), an archived page (409),
//      author-or-`comment:moderate` on edit and delete (403), and the rest.
//
// ⚠️ THREE WRITES NOTIFY (Story MOTIR-10868 · MOTIR-10923): starting a thread,
// replying, and an edit that adds a mention each emit ONE `page/comment.created`
// AFTER their transaction commits — never inside it, so a rolled-back write has
// notified nobody. The mention ids are the body's tokens kept to the people who
// can enter the project, read as REFERENCE data before the transaction (the
// member read binds its own context) and only when the body names someone.
// Delete, resolve and reopen emit nothing, as their work-item twins do.

export interface PageCommentCapabilities {
  /** May post, reply, resolve and reopen — `comment:add`, and the page is live. */
  readonly canComment: boolean;
  /** Holds `comment:moderate` — may edit and delete another person's comment. */
  readonly canModerate: boolean;
}

/** The list's answer: the package's page of threads, and what the caller may do. */
export interface PageCommentThreadsResponse extends PageCommentThreadsPage {
  readonly capabilities: PageCommentCapabilities;
  /**
   * The live summaries of the work items this page of threads links with a
   * `motir:` token, keyed by id, so `MarkdownView` draws each as a card chip rather
   * than as a deleted item (bug MOTIR-10023's rule). It is `{}` when no body links one.
   */
  readonly workItemRefs: WorkItemRefMap;
}

/**
 * A write's answer: the written row, and the live summaries of the work items ITS
 * body links (MOTIR-10866 review). The panel merges them, so a card linked in a new
 * or edited comment draws as a chip at once, with no re-read of a list.
 */
export type WithWorkItemRefs<T> = T & { readonly workItemRefs: WorkItemRefMap };

async function withRefs<T extends { readonly bodyMd: string }>(
  row: T,
  ctx: ServiceContext,
): Promise<WithWorkItemRefs<T>> {
  return { ...row, workItemRefs: await resolveMarkdownBodiesWorkItemRefs([row.bodyMd], ctx) };
}

interface PageScope {
  projectId: string;
  pageId: string;
}

export interface ListPageThreadsInput extends PageScope {
  status: PageCommentThreadStatus;
  order?: PageCommentOrder;
  cursor?: string | null;
  limit?: number;
}

export interface PostPageCommentInput extends PageScope {
  bodyMd: string;
  anchor?: PageCommentAnchorInput;
}

export interface PostPageReplyInput extends PageScope {
  parentCommentId: string;
  bodyMd: string;
}

export interface PageCommentTargetInput extends PageScope {
  commentId: string;
}

export interface EditPageCommentBodyInput extends PageCommentTargetInput {
  bodyMd: string;
}

function scopeTo(ctx: ServiceContext, projectId: string) {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId };
}

/**
 * The write gate: `page:view`, then `comment:add`, read in the write's own
 * transaction; answers the actor the package decides author-or-moderator with.
 */
async function writeActor(
  ctx: ServiceContext,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<PageCommentActor> {
  await projectAccessService.assertCanViewPages(projectId, ctx, tx);
  const caps = await projectAccessService.getCommentCapabilities(projectId, ctx, tx);
  if (!caps.canComment) throw new PermissionDeniedError(projectId, 'comment:add');
  return { userId: ctx.userId, canModerate: caps.canModerate };
}

/**
 * The people a page comment may mention: those who can ENTER the project (the
 * work-item comments' rule, `assignableMembersService`), scoped by its access
 * mode. A reference read, run before the write's transaction and outside it —
 * the member read binds its own workspace context.
 */
async function resolvePageMentionableIds(
  projectId: string,
  ctx: ServiceContext,
): Promise<Set<string>> {
  const { accessMode } = await projectAccessService.getCommentCapabilities(projectId, ctx);
  const members = await assignableMembersService.list({ projectId, accessMode, ctx });
  return new Set(members.map((m) => m.userId));
}

/** The body's mention ids, and who among them may be mentioned — no read without a token. */
async function mentionCandidates(
  bodyMd: string,
  projectId: string,
  ctx: ServiceContext,
): Promise<{ tokenIds: string[]; mentionable: Set<string> }> {
  const tokenIds = parseMentionIds(bodyMd);
  const mentionable =
    tokenIds.length > 0 ? await resolvePageMentionableIds(projectId, ctx) : new Set<string>();
  return { tokenIds, mentionable };
}

/** Emit the page-comment event, post-commit. */
function emitPageCommentCreated(
  ctx: ServiceContext,
  input: { projectId: string; pageId: string; commentId: string; threadRootCommentId: string },
  mentionedUserIds: string[],
  isReply: boolean,
): Promise<void> {
  return sendEvent('page/comment.created', {
    workspaceId: ctx.workspaceId,
    projectId: input.projectId,
    pageId: input.pageId,
    commentId: input.commentId,
    threadRootCommentId: input.threadRootCommentId,
    authorId: ctx.userId,
    mentionedUserIds,
    isReply,
  });
}

/** One gated write: the transaction, the gate, then the procedure. */
function gatedWrite<T>(
  ctx: ServiceContext,
  input: PageScope,
  run: (store: PageStore, scope: PageScope & { actor: PageCommentActor }) => Promise<T>,
): Promise<T> {
  return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
    const actor = await writeActor(ctx, input.projectId, tx);
    return run(pageStoreFor(tx), { projectId: input.projectId, pageId: input.pageId, actor });
  });
}

export const pageCommentsService = {
  /** One page of a page's open or resolved threads, with the caller's capabilities. */
  async listPageThreads(
    ctx: ServiceContext,
    input: ListPageThreadsInput,
  ): Promise<PageCommentThreadsResponse> {
    const answer = await withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const caps = await projectAccessService.getCommentCapabilities(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      const page = await listPageCommentThreads(store, {
        projectId: input.projectId,
        pageId: input.pageId,
        actor: { userId: ctx.userId, canModerate: caps.canModerate },
        status: input.status,
        order: input.order,
        cursor: input.cursor,
        limit: input.limit,
      });
      // The package answered, so the page is in this project; its archive state
      // decides whether anyone may write here now.
      const row = await store.findPage(input.pageId);
      const live = row !== null && row.archivedAt === null;
      return {
        ...page,
        capabilities: { canComment: caps.canComment && live, canModerate: caps.canModerate },
      };
    });
    // Resolved after the read, in its own reads: the summaries are the reader's
    // view of the WORK ITEMS, which the page's transaction does not need to hold.
    const bodies = answer.threads.flatMap((thread) => [
      thread.bodyMd,
      ...thread.replies.map((reply) => reply.bodyMd),
    ]);
    return { ...answer, workItemRefs: await resolveMarkdownBodiesWorkItemRefs(bodies, ctx) };
  },

  /**
   * The page's open ANCHORED roots, without replies, and its open count — what a
   * page load hands the live editor to wash (MOTIR-10899) and the Discussion
   * chip. The list's gate and context; no capabilities and no work-item
   * summaries, which only the panel's own reads need.
   */
  async listAnchoredRoots(
    ctx: ServiceContext,
    input: PageScope,
  ): Promise<{ roots: PageCommentDto[]; openCount: number }> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const read = await listPageAnchoredRoots(pageStoreFor(tx), input);
      return { roots: read.roots, openCount: read.counts.open };
    });
  },

  /**
   * One thread by a comment's id, wherever it sits in either list — the read a
   * thread link resolves against. The list's gate and context, line for line:
   * a viewer reads it, and a page outside the caller's project answers the same
   * refusal the list does. No capabilities and no counts: the panel reads those
   * from its lists. The live summaries of every work item the root and its
   * replies link ride beside it, since a thread outside the loaded list has no
   * chip data anywhere else.
   */
  async readPageThread(
    ctx: ServiceContext,
    input: PageCommentTargetInput,
  ): Promise<WithWorkItemRefs<PageCommentThreadDto>> {
    const thread = await withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      return readPageCommentThread(pageStoreFor(tx), {
        projectId: input.projectId,
        pageId: input.pageId,
        commentId: input.commentId,
      });
    });
    const bodies = [thread.bodyMd, ...thread.replies.map((reply) => reply.bodyMd)];
    return { ...thread, workItemRefs: await resolveMarkdownBodiesWorkItemRefs(bodies, ctx) };
  },

  /** Start a thread; an `anchor` makes it inline (the epic's inline story). */
  async postPageComment(
    ctx: ServiceContext,
    input: PostPageCommentInput,
  ): Promise<WithWorkItemRefs<PageCommentThreadDto>> {
    const { tokenIds, mentionable } = await mentionCandidates(input.bodyMd, input.projectId, ctx);
    const { row: thread, mentionedUserIds } = await gatedWrite(
      ctx,
      input,
      async (store, scope) => ({
        row: await createPageComment(store, systemClock, {
          ...scope,
          bodyMd: input.bodyMd,
          anchor: input.anchor,
        }),
        mentionedUserIds: tokenIds.filter((id) => mentionable.has(id)),
      }),
    );
    // Post-commit, never inside the tx — a rollback must not have notified.
    await emitPageCommentCreated(
      ctx,
      {
        projectId: input.projectId,
        pageId: thread.pageId,
        commentId: thread.id,
        threadRootCommentId: thread.id,
      },
      mentionedUserIds,
      false,
    );
    return withRefs(thread, ctx);
  },

  /** Reply to a thread. It always emits, mention or not: a reply reaches the thread's people. */
  async postPageReply(
    ctx: ServiceContext,
    input: PostPageReplyInput,
  ): Promise<WithWorkItemRefs<PageCommentDto>> {
    const { tokenIds, mentionable } = await mentionCandidates(input.bodyMd, input.projectId, ctx);
    const { row: reply, mentionedUserIds } = await gatedWrite(ctx, input, async (store, scope) => ({
      row: await replyToPageComment(store, systemClock, {
        ...scope,
        parentCommentId: input.parentCommentId,
        bodyMd: input.bodyMd,
      }),
      mentionedUserIds: tokenIds.filter((id) => mentionable.has(id)),
    }));
    // Post-commit, never inside the tx — a rollback must not have notified.
    await emitPageCommentCreated(
      ctx,
      {
        projectId: input.projectId,
        pageId: reply.pageId,
        commentId: reply.id,
        // The package refuses a reply to a reply, so the parent IS the root.
        threadRootCommentId: reply.parentCommentId ?? input.parentCommentId,
      },
      mentionedUserIds,
      true,
    );
    return withRefs(reply, ctx);
  },

  /**
   * Edit a comment's body. It emits only when the edit ADDED someone, and then
   * names only them: the new body's mentionable ids minus every id the previous
   * body parsed to — both sides parsed, so a token in code counts on neither.
   */
  async editPageCommentBody(
    ctx: ServiceContext,
    input: EditPageCommentBodyInput,
  ): Promise<WithWorkItemRefs<PageCommentDto>> {
    const { tokenIds, mentionable } = await mentionCandidates(input.bodyMd, input.projectId, ctx);
    const { comment, previousBodyMd } = await gatedWrite(ctx, input, (store, scope) =>
      editPageComment(store, systemClock, {
        ...scope,
        commentId: input.commentId,
        bodyMd: input.bodyMd,
      }),
    );
    const before = new Set(parseMentionIds(previousBodyMd));
    const added = tokenIds.filter((id) => mentionable.has(id) && !before.has(id));
    if (added.length > 0) {
      // Post-commit, never inside the tx — a rollback must not have notified.
      await emitPageCommentCreated(
        ctx,
        {
          projectId: input.projectId,
          pageId: comment.pageId,
          commentId: comment.id,
          threadRootCommentId: comment.parentCommentId ?? comment.id,
        },
        added,
        comment.parentCommentId !== null,
      );
    }
    return withRefs(comment, ctx);
  },

  async removePageComment(
    ctx: ServiceContext,
    input: PageCommentTargetInput,
  ): Promise<DeletePageCommentResult> {
    return gatedWrite(ctx, input, (store, scope) =>
      deletePageComment(store, { ...scope, commentId: input.commentId }),
    );
  },

  async resolvePageThread(
    ctx: ServiceContext,
    input: PageCommentTargetInput,
  ): Promise<PageCommentThreadDto> {
    return gatedWrite(ctx, input, (store, scope) =>
      resolvePageCommentThread(store, systemClock, { ...scope, commentId: input.commentId }),
    );
  },

  async reopenPageThread(
    ctx: ServiceContext,
    input: PageCommentTargetInput,
  ): Promise<PageCommentThreadDto> {
    return gatedWrite(ctx, input, (store, scope) =>
      reopenPageCommentThread(store, { ...scope, commentId: input.commentId }),
    );
  },
};
