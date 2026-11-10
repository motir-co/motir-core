import type { Prisma } from '@/generated/prisma/client';
import {
  createPageComment,
  deletePageComment,
  editPageComment,
  listPageCommentThreads,
  pageStoreFor,
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
import { PermissionDeniedError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
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

export interface PageCommentCapabilities {
  /** May post, reply, resolve and reopen — `comment:add`, and the page is live. */
  readonly canComment: boolean;
  /** Holds `comment:moderate` — may edit and delete another person's comment. */
  readonly canModerate: boolean;
}

/** The list's answer: the package's page of threads, and what the caller may do. */
export interface PageCommentThreadsResponse extends PageCommentThreadsPage {
  readonly capabilities: PageCommentCapabilities;
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
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
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
  },

  /** Start a thread; an `anchor` makes it inline (the epic's inline story). */
  async postPageComment(
    ctx: ServiceContext,
    input: PostPageCommentInput,
  ): Promise<PageCommentThreadDto> {
    return gatedWrite(ctx, input, (store, scope) =>
      createPageComment(store, systemClock, {
        ...scope,
        bodyMd: input.bodyMd,
        anchor: input.anchor,
      }),
    );
  },

  async postPageReply(ctx: ServiceContext, input: PostPageReplyInput): Promise<PageCommentDto> {
    return gatedWrite(ctx, input, (store, scope) =>
      replyToPageComment(store, systemClock, {
        ...scope,
        parentCommentId: input.parentCommentId,
        bodyMd: input.bodyMd,
      }),
    );
  },

  async editPageCommentBody(
    ctx: ServiceContext,
    input: EditPageCommentBodyInput,
  ): Promise<PageCommentDto> {
    return gatedWrite(ctx, input, (store, scope) =>
      editPageComment(store, systemClock, {
        ...scope,
        commentId: input.commentId,
        bodyMd: input.bodyMd,
      }),
    );
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
