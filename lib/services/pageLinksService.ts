import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { PageArchivedError, PageNotFoundError } from '@/lib/pages';
import { PageLinkAlreadyExistsError, PageLinkNotFoundError } from '@/lib/pages/linkErrors';
import { toPageWorkItemLinkRowDto, toWorkItemPageLinkRowDto } from '@/lib/mappers/pageLinkMappers';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import {
  decodePageWorkItemsCursor,
  encodePageWorkItemsCursor,
  pageWorkItemsLimit,
} from '@/lib/pages/pageWorkItemsCursor';
import {
  decodeWorkItemPagesCursor,
  encodeWorkItemPagesCursor,
  workItemPagesLimit,
} from '@/lib/pages/workItemPagesCursor';
import type {
  PageLinkPairDto,
  PageWorkItemsDto,
  WorkItemLinkedPagesDto,
  WorkItemPagesDto,
} from '@/lib/dto/pageLinks';
import type { WorkItemPagesSeek } from '@/lib/repositories/pageWorkItemLinkRepository';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { Prisma } from '@/generated/prisma/client';

type Tx = Prisma.TransactionClient;
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

// The work item's Pages read (Story MOTIR-7565 · MOTIR-7573) — "which pages link
// to this work item?", read from `page_work_item_link` (`docs/decisions/pages.md`
// §8.1) and rendered by the work item's Pages section.
//
// ⚠️ TWO GATES, AND ONE ANSWER FOR BOTH KINDS OF STRANGER. The work item is
// resolved under the reader's normal access, and its project's `page:view` is
// asserted. A reader who cannot see the work item — unknown id, another
// workspace, a project they may not browse — gets `WorkItemNotFoundError`, the
// answer the work item's own page gives. A browser without `page:view` gets the
// `'edit'` refusal (→ 403), naming no page.
//
// ⚠️ A VISITOR IS ANSWERED AS A STRANGER. No Visitor route serves pages, so no
// Visitor payload may name one (`docs/decisions/epic-privacy.md` §3): the read
// refuses a Visitor context with the same not-found, before any query.

export interface ListPagesForWorkItemInput {
  workItemId: string;
  cursor?: string | null;
  limit?: number | null;
}

export interface ListWorkItemsForPageInput {
  projectId: string;
  pageId: string;
  cursor?: string | null;
  limit?: number | null;
}

export interface LinkPageForWorkItemInput {
  workItemId: string;
  pageId: string;
}

// The hand link's write (Story MOTIR-7567 · MOTIR-9197) — a `manual` row of the
// pair, created and deleted from either surface through one route family. Both
// operations resolve the work item FIRST under the reader's normal access, then
// open ONE transaction bound to its project: `work_item:edit`, then `page:view`,
// then the page (a page of another project is the same not-found an unknown
// one is), then the row and the work item's revision on that same `tx`.
//
// ⚠️ THE ARCHIVE REFUSAL IS ON CREATION ONLY. Linking an archived page is
// `PAGE_ARCHIVED`; unlinking one asks no archive question at all, so a hand link
// whose page was archived since stays removable. A DELETE therefore never
// answers `PAGE_ARCHIVED` — a pair with no hand link is `PAGE_LINK_NOT_FOUND`.
//
// ⚠️ A DUPLICATE IS A WRITTEN COUNT, NOT A CAUGHT VIOLATION. `createManual`
// returns what `skipDuplicates` actually wrote; 0 is "already linked". A caught
// unique violation would abort the transaction and the revision with it.

/**
 * The resolved item and the transaction scope both write paths open. A
 * `'browse'` denial from EITHER assert is the same not-found the read gives a
 * stranger; an `'edit'` denial passes through (→ 403, naming no page).
 */
async function withHandLinkGates<T>(
  ctx: ServiceContext,
  workItemId: string,
  body: (item: { id: string; workspaceId: string; projectId: string }, tx: Tx) => Promise<T>,
): Promise<T> {
  const item = await readWorkItem(workItemId, ctx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);

  const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId };
  return withWorkspaceContext(scope, async (tx) => {
    try {
      await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
      await projectAccessService.assertCanViewPages(item.projectId, ctx, tx);
    } catch (err) {
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new WorkItemNotFoundError(workItemId);
      }
      throw err;
    }
    return body(item, tx);
  });
}

/** The page, refused as unknown unless it lives in the work item's project. */
async function findPageInProject(pageId: string, projectId: string, tx: Tx) {
  const page = await pageRepository.findById(pageId, tx);
  if (!page || page.projectId !== projectId) throw new PageNotFoundError(pageId);
  return page;
}

/**
 * One window of the pages linking to `workItemId`, in the Pages section's order,
 * with each place's folder chain resolved in ONE batched read. `hasMore` is the
 * look-ahead row; `last` is the seek key of the last row served.
 */
async function readPagesWindow(
  workItemId: string,
  workspaceId: string,
  after: WorkItemPagesSeek | null,
  limit: number,
  tx: Tx,
) {
  const window = await pageWorkItemLinkRepository.listPagesForWorkItem(
    workItemId,
    after,
    limit + 1,
    tx,
  );
  const served = window.slice(0, limit);
  const folderIds = [
    ...new Set(served.flatMap((r) => (r.placeFolderId === null ? [] : [r.placeFolderId]))),
  ];
  const trails = await folderRepository.findTrailsByIds(folderIds, workspaceId, tx);
  const pathByFolder = new Map(trails.map((t) => [t.id, t.trail.map((step) => step.name)]));
  const rows = served.map((r) =>
    toWorkItemPageLinkRowDto(
      r,
      r.placeFolderId === null ? [] : (pathByFolder.get(r.placeFolderId) ?? []),
    ),
  );
  const lastServed = served[served.length - 1];
  const last: WorkItemPagesSeek | null =
    window.length > limit && lastServed
      ? { updatedAt: lastServed.updatedAt, id: lastServed.pageId }
      : null;
  return { rows, hasMore: window.length > limit, last };
}

/**
 * Write the HAND link of a pair on the caller's transaction, and the work item's
 * revision when it was new (MOTIR-9197, and the decision publish of MOTIR-10315).
 * Answers whether a row was written: `false` is "already linked by hand", which
 * `skipDuplicates` turns into a count rather than an aborting unique violation.
 */
export async function writeHandLink(
  input: {
    workspaceId: string;
    projectId: string;
    workItemId: string;
    page: { id: string; title: string };
    userId: string;
  },
  tx: Tx,
): Promise<boolean> {
  const written = await pageWorkItemLinkRepository.createManual(
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      pageId: input.page.id,
      workItemId: input.workItemId,
      createdById: input.userId,
    },
    tx,
  );
  if (written === 0) return false;
  await workItemRevisionsService.recordRevision(
    {
      workItemId: input.workItemId,
      changedById: input.userId,
      changeKind: 'updated',
      diff: { pageLinks: { added: [{ pageId: input.page.id, title: input.page.title }] } },
    },
    tx,
  );
  return true;
}

/** How many linked pages `get_work_item` serves: the Pages section's page size. */
export const AGENT_LINKED_PAGES_LIMIT = 50;

export const pageLinksService = {
  async listPagesForWorkItem(
    ctx: ServiceContext | VisitorReadContext,
    input: ListPagesForWorkItemInput,
  ): Promise<WorkItemPagesDto> {
    if (isVisitorContext(ctx)) throw new WorkItemNotFoundError(input.workItemId);
    const after = input.cursor ? decodeWorkItemPagesCursor(input.cursor) : null;
    const limit = workItemPagesLimit(input.limit);

    const item = await readWorkItem(input.workItemId, ctx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(input.workItemId);
    }

    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId };
    return withWorkspaceContext(scope, async (tx) => {
      try {
        await projectAccessService.assertCanViewPages(item.projectId, ctx, tx);
      } catch (err) {
        if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
          throw new WorkItemNotFoundError(input.workItemId);
        }
        throw err;
      }

      const read = await readPagesWindow(item.id, ctx.workspaceId, after, limit, tx);
      return {
        rows: read.rows,
        nextCursor: read.last ? encodeWorkItemPagesCursor(read.last) : null,
      };
    });
  },

  /**
   * The work item's linked pages for `get_work_item` (MOTIR-10315): the Pages
   * section's set, first window only, each row marked with the card's LATEST
   * decision publication when it names that page. `null` — no page data at all —
   * for a reader without `page:view` on the project, so the rest of the read is
   * unaffected. The caller has already resolved the work item under the reader's
   * access (the detail aggregate's browse gate).
   */
  async listLinkedPagesForAgent(
    ctx: ServiceContext,
    input: { workItemId: string; projectId: string },
  ): Promise<WorkItemLinkedPagesDto | null> {
    // A BEARER TOKEN must hold `page:view` in its own GRANT too. `get_work_item` is
    // keyed `project:browse` at the dispatch door, and `assertCanViewPages` reads the
    // owner's ROLE only, so without this a token minted without the page keys
    // (`CLI_TOKEN_GRANT`: no read-forward for them) would read page titles here
    // that `get_page` and `search_pages` refuse it.
    if (ctx.tokenGrant !== undefined && !ctx.tokenGrant.includes('page:view')) return null;
    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: input.projectId };
    return withWorkspaceContext(scope, async (tx) => {
      try {
        await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      } catch (err) {
        if (err instanceof ProjectAccessDeniedError) return null;
        /* v8 ignore next -- the access read throws only the denial; anything else is a fault */
        throw err;
      }
      const read = await readPagesWindow(
        input.workItemId,
        ctx.workspaceId,
        null,
        AGENT_LINKED_PAGES_LIMIT,
        tx,
      );
      const [latest] = await decisionPagePublicationRepository.latestForWorkItems(
        [input.workItemId],
        tx,
      );
      const decisionPage = latest
        ? {
            pageId: latest.pageId,
            title: latest.pageTitle,
            versionNumber: latest.versionNumber,
            publishedAt: latest.publishedAt.toISOString(),
            state: latest.pageArchivedAt === null ? ('live' as const) : ('unavailable' as const),
          }
        : null;
      return {
        rows: read.rows.map((row) => ({
          ...row,
          decision:
            decisionPage && row.pageId === decisionPage.pageId
              ? { versionNumber: decisionPage.versionNumber, publishedAt: decisionPage.publishedAt }
              : null,
        })),
        hasMore: read.hasMore,
        decisionPage,
      };
    });
  },

  /**
   * A page's hand-linked work items (Story MOTIR-7567 · MOTIR-9198), newest link
   * first, each with its live chip summary. Reads `manual` rows only and never
   * joins `work_item`, so a row whose item cannot be summarised is kept with
   * `summary: null`. An archived page answers an empty page (after the
   * `page:view` gate) — its hand links are hidden on both sides until restored.
   * `canLink` is `work_item:edit`, an affordance and never the write's authority.
   */
  async listWorkItemsForPage(
    ctx: ServiceContext,
    input: ListWorkItemsForPageInput,
  ): Promise<PageWorkItemsDto> {
    const after = input.cursor ? decodePageWorkItemsCursor(input.cursor) : null;
    const limit = pageWorkItemsLimit(input.limit);

    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: input.projectId };
    const read = await withWorkspaceContext(scope, async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const page = await findPageInProject(input.pageId, input.projectId, tx);
      if (page.archivedAt !== null) return null;

      const { canEdit } = await projectAccessService.getCapabilities(input.projectId, ctx, tx);
      const window = await pageWorkItemLinkRepository.listManualByPage(
        page.id,
        after,
        limit + 1,
        tx,
      );
      return { canEdit, window };
    });
    if (read === null) return { rows: [], nextCursor: null, canLink: false };

    const served = read.window.slice(0, limit);
    // The chips resolve AFTER the transaction closes: a pure read with no `tx`.
    const summaries = await resolveWorkItemRefSummaries(
      { ids: [...new Set(served.map((r) => r.workItemId))], keys: [] },
      input.projectId,
      ctx,
    );
    const last = served[served.length - 1];
    return {
      rows: served.map((r) => toPageWorkItemLinkRowDto(r, summaries[r.workItemId] ?? null)),
      nextCursor:
        read.window.length > limit && last
          ? encodePageWorkItemsCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      canLink: read.canEdit,
    };
  },

  /** Link a page to a work item by hand; see the header above. */
  async linkPageForWorkItem(
    ctx: ServiceContext,
    input: LinkPageForWorkItemInput,
  ): Promise<PageLinkPairDto> {
    return withHandLinkGates(ctx, input.workItemId, async (item, tx) => {
      const page = await findPageInProject(input.pageId, item.projectId, tx);
      // Creation only — the row would land in a page no surface lists.
      if (page.archivedAt !== null) throw new PageArchivedError(page.id);

      const written = await writeHandLink(
        {
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          workItemId: item.id,
          page,
          userId: ctx.userId,
        },
        tx,
      );
      if (!written) throw new PageLinkAlreadyExistsError(page.id, item.id);
      return { pageId: page.id, workItemId: item.id, source: 'manual' as const };
    });
  },

  /** Remove the hand link of a pair; see the header above. */
  async unlinkPageForWorkItem(
    ctx: ServiceContext,
    input: LinkPageForWorkItemInput,
  ): Promise<PageLinkPairDto> {
    return withHandLinkGates(ctx, input.workItemId, async (item, tx) => {
      // No archive question: a link whose page was archived since stays removable.
      const page = await findPageInProject(input.pageId, item.projectId, tx);

      const removed = await pageWorkItemLinkRepository.deleteManual(page.id, item.id, tx);
      if (removed === 0) throw new PageLinkNotFoundError(page.id, item.id);

      await workItemRevisionsService.recordRevision(
        {
          workItemId: item.id,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { pageLinks: { removed: [{ pageId: page.id, title: page.title }] } },
        },
        tx,
      );
      return { pageId: page.id, workItemId: item.id, source: 'manual' as const };
    });
  },
};
