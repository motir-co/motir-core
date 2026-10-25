import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import {
  toBase64,
  toLockedPageRow,
  toPageArchivedListItemDto,
  toPageDto,
  toPageLevelRow,
  toPageListItemDto,
  toPageMarkdownDto,
  toPageMoveResultDto,
  toPageTrailDto,
  toPageTreeFolderRowDto,
  toPageTreePageRowDto,
  toPageMarkdownAtVersionDto,
  toPageMentionCandidateDto,
  toPageRefSummaryDto,
  toPageSearchHitDto,
  toPageVersionDto,
  toPageVersionListItemDto,
  toPageVersionRow,
} from '@/lib/mappers/pageMappers';
import {
  PAGE_LEVEL_PAGE_SIZE,
  PAGE_LEVEL_PAGE_SIZE_MAX,
  PageFolderNotFoundError,
  PageLevelCursorInvalidError,
  PageNotFoundError,
  PageVersionNotFoundError,
  archivePage as archivePageProcedure,
  deriveFormats,
  extractLinks,
  createPage as createPageProcedure,
  deletePage as deletePageProcedure,
  movePage as movePageProcedure,
  pageStoreFor,
  parsePlacement,
  renamePage as renamePageProcedure,
  restorePage as restorePageProcedure,
  restorePageVersion as restorePageVersionProcedure,
  savePageMarkdown as savePageMarkdownProcedure,
  savePageUpdate as savePageUpdateProcedure,
  systemClock,
  type PagePlacement,
  type PageRow,
  type PageStore,
} from '@/lib/pages';
import type {
  ArchivePageResultDto,
  CreatePageFromMarkdownInput,
  CreatePageInput,
  DeletePageResultDto,
  ListArchivedPagesInput,
  PageArchiveActionInput,
  PageArchiveSetDto,
  PageArchivedListDto,
  RestorePageResultDto,
  GetPageInput,
  GetPageMarkdownInput,
  GetPageTrailInput,
  ListPageTreeLevelInput,
  GetPageVersionInput,
  ListPageVersionsInput,
  ListPagesInput,
  MovePageInput,
  PageDto,
  PageListItemDto,
  PageMarkdownDto,
  PageMoveResultDto,
  PageSummaryDto,
  PageTrailDto,
  PageTreeLevelDto,
  PageTreeRowDto,
  PageVersionDto,
  PageVersionListDto,
  RenamePageInput,
  RestorePageVersionInput,
  RestorePageVersionResultDto,
  SavePageMarkdownInput,
  SavePageResultDto,
  SavePageUpdateInput,
} from '@/lib/dto/pages';
import { PAGE_ARCHIVE_SET_TITLES } from '@/lib/dto/pages';
import type {
  PageLinkCandidatesDto,
  PageMentionCandidateDto,
  PageRefMap,
  PageSearchResultDto,
} from '@/lib/dto/pages';
import { authorizePageSearch } from '@/lib/pages/pageSearchAccess';
import { decodePageSearchCursor, encodePageSearchCursor } from '@/lib/pages/pageSearchCursor';
import {
  PAGE_SEARCH_QUERY_MAX_LENGTH,
  PageSearchQueryEmptyError,
  PageSearchQueryTooLongError,
} from '@/lib/pages/searchErrors';
import {
  decodePageTitleSearchCursor,
  encodePageTitleSearchCursor,
} from '@/lib/pages/pageTitleSearchCursor';
import { QUICK_SEARCH_MIN_QUERY_LENGTH } from '@/lib/workItems/quickSearch';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';
import type { Page, Prisma } from '@/generated/prisma/client';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// Page service (Story MOTIR-5752 · MOTIR-7277) — who may create, read, rename and
// save a project's pages, and the transaction each of those runs in. No route
// and no Server Action lives here (CLAUDE.md's 4-layer contract).
//
// ── THE CONTRACTS THIS FILE HOLDS ─────────────────────────────────────────
//
// 1. THE SERVICE DECIDES ACCESS; THE PACKAGE DECIDES CONTENT. Every method opens
//    ONE `withWorkspaceContext` transaction, asserts its key FIRST, then runs
//    `@motir/pages`' procedure over `pageStoreFor(tx)`. Every refusal the
//    package raises (`PageBodyTooLargeError`, `PageTitleTooLongError`,
//    `PageNotFoundError`) passes through unchanged for the routes to map.
//
// 2. A PAGE IN ANOTHER PROJECT IS AN UNKNOWN PAGE. The caller names the project
//    it was granted on; a page id from a different project raises the package's
//    own `PageNotFoundError`, so the two are indistinguishable — the gate on
//    project A must never confirm a page exists in project B.
//
// 3. BOTH WRITES THAT READ BEFORE THEY WRITE ARE SERIALISED IN THE PACKAGE. A
//    save merges onto the state it read under `lockPage` (`FOR UPDATE`), and a
//    create mints its position after `lockSiblings`. That is why two concurrent
//    saves both land and two concurrent creates take distinct positions —
//    `tests/services/pagesService.integration.test.ts` proves it with real
//    parallel transactions. A MOVE takes the same project structure lock first
//    (`movePage` in the package), so a move, a create and another move
//    serialise, and a refusal anywhere rolls the whole move back. A RESTORE
//    (MOTIR-5754) reads the version and the current state under the same
//    `lockPage`, so it serialises with a save —
//    `tests/services/pagesService.history.integration.test.ts`.
//
// 4. A TREE LEVEL IS READ ONE PARENT AT A TIME, NEVER AS A PROJECT WALK
//    (`listTreeLevel`, MOTIR-7370). At the root or in a folder the level is two
//    BANDS — its child folders, then its pages — each ordered by
//    `(position, id) COLLATE "C"`; under a page it is the page band alone. ONE
//    opaque keyset cursor spans both: it names the band and the last
//    `(position, id)` served, so a page boundary never shifts when a row is
//    created or moved between two reads, and walking the level visits each row
//    exactly once.
//
// 5. HISTORY IS READ UNDER `page:view` AND RESTORED UNDER `page:edit` (§5).
//
// 6. ARCHIVE AND RESTORE ARE `page:edit`; PERMANENT DELETE IS `page:delete`
//    (§7, MOTIR-7421). Each takes the FOLDER-structure lock, then the
//    PAGE-structure lock — `foldersService.deleteFolder`'s order — before the
//    package's procedure runs, so an archive, a restore or a delete serialises
//    with a move, a create and a folder delete in the project and cannot
//    deadlock one of them. The package re-reads the page under those locks, so
//    a move that loses the race to an archive is refused `PAGE_ARCHIVED`, never
//    applied to a stale live row. Every archived-page refusal (`PAGE_ARCHIVED`
//    on a save, rename, move, version restore; `PAGE_PARENT_ARCHIVED` on a
//    create) is the PACKAGE's, and passes through untouched — no check here
//    duplicates one.
// 7. AN AGENT READS AND WRITES MARKDOWN (§8.2, MOTIR-7409). `getPageMarkdown`
//    serves the derived `body_markdown` column and never the Yjs bytes; the
//    markdown writes run the package's `savePageMarkdown`, which decides
//    staleness under the page lock — the `PAGE_REVISION_CONFLICT` refusal passes
//    through this file untouched, like every other content refusal.

/** The page, refused as unknown unless it lives in `projectId`. */
async function findInProject(store: PageStore, projectId: string, pageId: string) {
  const row = await store.findPage(pageId);
  if (!row || row.projectId !== projectId) throw new PageNotFoundError(pageId);
  return row;
}

/**
 * The transaction's context, bound to the project the call names. `page` carries
 * a project-narrowing policy (`page_project_narrow`), so a context still bound to
 * a DIFFERENT active project would make an insert there a raw RLS violation
 * rather than a decision this service made. The gate still reads the caller's
 * own `ctx` — a token's project binding is enforced there, not bypassed here.
 */
/** The `@` picker's Pages section shows a short, fixed list (MOTIR-7697). */
export const PAGE_MENTION_SEARCH_LIMIT = 10;

/** One page of full-text page search hits (MOTIR-9551). */
export const PAGE_SEARCH_LIMIT = 20;

/**
 * Page title-search rows with their PLACE: the parent page's title and the folder
 * its topmost page is filed in — one batched read for each, however many rows.
 */
async function candidatesWithPlace(
  rows: Array<Pick<Page, 'id' | 'title' | 'ancestorPageIds' | 'folderId'>>,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<PageMentionCandidateDto[]> {
  const parentIds = rows.flatMap((r) => r.ancestorPageIds.slice(-1));
  const topIds = rows.flatMap((r) => r.ancestorPageIds.slice(0, 1));
  const related = await pageRepository.findTitlesByIds([...new Set([...parentIds, ...topIds])], tx);
  const relatedById = new Map(related.map((r) => [r.id, r]));
  const folderOf = (r: (typeof rows)[number]): string | null => {
    const topId = r.ancestorPageIds[0];
    return topId === undefined ? r.folderId : (relatedById.get(topId)?.folderId ?? null);
  };
  const folderIds = [...new Set(rows.map(folderOf).filter((id): id is string => id !== null))];
  const trails = await folderRepository.findTrailsByIds(folderIds, workspaceId, tx);
  const pathByFolder = new Map(trails.map((t) => [t.id, t.trail.map((step) => step.name)]));
  return rows.map((r) => {
    const folderId = folderOf(r);
    const parentId = r.ancestorPageIds[r.ancestorPageIds.length - 1];
    return toPageMentionCandidateDto(
      r,
      folderId === null ? [] : (pathByFolder.get(folderId) ?? []),
      parentId === undefined ? null : (relatedById.get(parentId)?.title ?? null),
    );
  });
}

function scopeTo(ctx: ServiceContext, projectId: string) {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId };
}

/** The level-read cursor's decoded form: which band, and the last row served in it. */
interface LevelCursor {
  band: 'folder' | 'page';
  position: string;
  id: string;
}

/** Encode a level cursor — opaque base64url of the band and the `(position, id)` seek key. */
function encodeLevelCursor(cursor: LevelCursor): string {
  return Buffer.from(JSON.stringify([cursor.band, cursor.position, cursor.id])).toString(
    'base64url',
  );
}

/** Decode a level cursor, refusing anything this service did not issue. */
function decodeLevelCursor(raw: string): LevelCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageLevelCursorInvalidError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    (parsed[0] !== 'folder' && parsed[0] !== 'page') ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    parsed[1] === '' ||
    parsed[2] === ''
  ) {
    throw new PageLevelCursorInvalidError();
  }
  return { band: parsed[0], position: parsed[1], id: parsed[2] };
}

/** Rows per level read: the default when unset, held to `[1, PAGE_LEVEL_PAGE_SIZE_MAX]`. */
function clampLevelLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAGE_LEVEL_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), PAGE_LEVEL_PAGE_SIZE_MAX);
}

/**
 * Refuse a level parent that is not in `projectId` — a folder as the package's
 * `PageFolderNotFoundError`, a page as `PageNotFoundError` — so reading a level
 * cannot confirm that a folder or page exists in another project.
 */
async function assertLevelParent(
  projectId: string,
  parent: PagePlacement,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (parent.kind === 'folder') {
    const folder = await folderRepository.findById(parent.folderId, tx);
    if (!folder || folder.projectId !== projectId) {
      throw new PageFolderNotFoundError(parent.folderId);
    }
  } else if (parent.kind === 'page') {
    const page = await pageRepository.findById(parent.pageId, tx);
    if (!page || page.projectId !== projectId) throw new PageNotFoundError(parent.pageId);
  }
}

/**
 * Both structure locks, in `foldersService.deleteFolder`'s order (contract 6).
 * The package takes the page lock again inside the procedure; an advisory
 * transaction lock is re-entrant, so that costs nothing.
 */
async function lockArchiveStructure(projectId: string, tx: Prisma.TransactionClient) {
  await folderRepository.lockStructure(projectId, tx);
  await pageRepository.lockStructure(projectId, tx);
}

/**
 * The folder chain each folder in `topFolderIds` sits in, root-first — the
 * came-from trail's folders. One ancestor walk per DISTINCT folder, then ONE
 * name read for every folder any chain names.
 */
async function folderChains(
  topFolderIds: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const distinct = [...new Set(topFolderIds)];
  const walks = new Map<string, string[]>();
  for (const id of distinct) walks.set(id, await folderRepository.findAncestorIds(id, tx));
  const all = [...new Set([...walks.values()].flat())];
  const byId = new Map((await folderRepository.findByIds(all, tx)).map((f) => [f.id, f]));
  const chains = new Map<string, Array<{ id: string; name: string }>>();
  for (const id of distinct) {
    const chain: Array<{ id: string; name: string }> = [];
    let at: string | null = id;
    while (at !== null && chain.length <= all.length) {
      const row = byId.get(at);
      if (!row) break;
      chain.push({ id: row.id, name: row.name });
      at = row.parentFolderId;
    }
    chains.set(id, chain.reverse());
  }
  return chains;
}

/**
 * The page as an agent reads it, inside the caller's transaction: the markdown
 * row, its newest version, and that version's author named in ONE batch read.
 * `null` when the page is absent, invisible or in another project.
 */
async function readPageMarkdown(
  projectId: string,
  pageId: string,
  tx: Prisma.TransactionClient,
): Promise<PageMarkdownDto | null> {
  const record = await pageRepository.findWithMarkdownById(pageId, tx);
  if (!record || record.projectId !== projectId) return null;
  const latest = await pageVersionRepository.findLatest(pageId, tx);
  const authors = latest ? await userRepository.findByIds([latest.authorId], tx) : [];
  return toPageMarkdownDto(record, latest, authors[0]?.name);
}

function toSummary(row: PageRow): PageSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    position: row.position,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const pagesService = {
  /**
   * Create an empty page, LAST under its parent — the project root (the
   * default), a folder or a page. `page:edit`. The parent is parsed by the
   * package (`parsePlacement`), so a work item or any other kind is refused as
   * `PAGE_PARENT_NOT_ALLOWED`; a parent missing, in another project or too deep
   * is refused by the package's create before anything is written.
   */
  async createPage(ctx: ServiceContext, input: CreatePageInput): Promise<PageSummaryDto> {
    const parent = parsePlacement(input.parent ?? { kind: 'root' });
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const row = await createPageProcedure(pageStoreFor(tx), systemClock, {
        workspaceId: ctx.workspaceId,
        projectId: input.projectId,
        actorId: ctx.userId,
        title: input.title,
        parent,
      });
      return toSummary(row);
    });
  },

  /**
   * Move a page — re-parent it, reorder it among its siblings, or both — with
   * its whole subtree, in ONE transaction. `page:edit`. The package's `movePage`
   * takes the project's structure lock, checks the cycle, depth, cross-project
   * and neighbour rules, writes the page and rewrites every descendant's
   * ancestors; any refusal rolls all of it back. Returns where the page now sits.
   */
  async movePage(ctx: ServiceContext, input: MovePageInput): Promise<PageMoveResultDto> {
    const parent = parsePlacement(input.parent);
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const { page, moved } = await movePageProcedure(pageStoreFor(tx), {
        pageId: input.pageId,
        projectId: input.projectId,
        parent,
        beforeId: input.beforeId ?? null,
        afterId: input.afterId ?? null,
        actorId: ctx.userId,
      });
      return toPageMoveResultDto(page, moved);
    });
  },

  /**
   * One read of a `/pages` tree level. `page:view`. At the root or in a folder:
   * the level's child FOLDERS, then its PAGES; under a page: its sub-pages only.
   * Keyset-paged across both bands by one opaque cursor (contract 4 above);
   * `limit` defaults to `PAGE_LEVEL_PAGE_SIZE` and is capped at
   * `PAGE_LEVEL_PAGE_SIZE_MAX`. A folder or page parent outside the project is
   * refused as not found.
   */
  async listTreeLevel(
    ctx: ServiceContext,
    input: ListPageTreeLevelInput,
  ): Promise<PageTreeLevelDto> {
    const parent = parsePlacement(input.parent);
    const limit = clampLevelLimit(input.limit);
    const cursor = input.cursor ? decodeLevelCursor(input.cursor) : null;
    const hasFolderBand = parent.kind !== 'page';
    if (cursor?.band === 'folder' && !hasFolderBand) throw new PageLevelCursorInvalidError();

    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      await assertLevelParent(input.projectId, parent, tx);

      const rows: PageTreeRowDto[] = [];
      let lastFolder: LevelCursor | null = null;

      // Band 1 — the folders. Skipped under a page, and once the cursor is past it.
      if (hasFolderBand && (cursor === null || cursor.band === 'folder')) {
        const folders = await folderRepository.findLevelForPages(
          input.projectId,
          parent.kind === 'folder' ? parent.folderId : null,
          cursor,
          limit + 1,
          tx,
        );
        const served = folders.slice(0, limit);
        rows.push(...served.map(toPageTreeFolderRowDto));
        const last = served[served.length - 1];
        if (last) lastFolder = { band: 'folder', position: last.position, id: last.id };
        if (folders.length > limit) {
          return { rows, nextCursor: encodeLevelCursor(lastFolder!) };
        }
      }

      // Band 2 — the pages, from the start or after the cursor's page. Read one
      // more than the room left, to learn whether anything follows.
      const room = limit - rows.length;
      const pages = (
        await pageRepository.findLevelAfter(
          input.projectId,
          parent,
          cursor?.band === 'page' ? cursor : null,
          room + 1,
          tx,
        )
      ).map(toPageLevelRow);
      const served = pages.slice(0, room);
      rows.push(...served.map(toPageTreePageRowDto));
      if (pages.length <= room) return { rows, nextCursor: null };
      const last = served[served.length - 1];
      // A full folder band with pages still to come: the next read resumes after
      // the last folder, finds the folder band spent, and starts the pages.
      const next: LevelCursor = last
        ? { band: 'page', position: last.position, id: last.id }
        : lastFolder!;
      return { rows, nextCursor: encodeLevelCursor(next) };
    });
  },

  /**
   * A page's breadcrumb trail, root-first, the page itself excluded. `page:view`.
   * The folders are the chain its TOPMOST page is filed in (a sub-page carries no
   * folder — it follows its top page), read as `foldersService.getFolderTrail`
   * reads it; the pages are its `ancestorPageIds`, named in one batch read.
   */
  async getPageTrail(ctx: ServiceContext, input: GetPageTrailInput): Promise<PageTrailDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const page = await pageRepository.findById(input.pageId, tx);
      if (!page || page.projectId !== input.projectId) throw new PageNotFoundError(input.pageId);

      const ancestorIds = page.ancestorPageIds;
      // An ARCHIVED page's trail is the place it was archived from — where a
      // restore puts it back — so it names its stored ancestors, archived ones
      // included (MOTIR-7423). A live page's names live pages only.
      const named =
        page.archivedAt === null
          ? await pageRepository.findTrailByIds(ancestorIds, tx)
          : await pageRepository.findTitlesByIds(ancestorIds, tx);
      const byId = new Map(named.map((p) => [p.id, p]));
      const pages = ancestorIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [{ id: row.id, title: row.title }] : [];
      });

      const topFolderId =
        ancestorIds.length === 0 ? page.folderId : (byId.get(ancestorIds[0]!)?.folderId ?? null);
      const folders: Array<{ id: string; name: string }> = [];
      if (topFolderId !== null) {
        const ids = await folderRepository.findAncestorIds(topFolderId, tx);
        const folderById = new Map(
          (await folderRepository.findByIds(ids, tx)).map((f) => [f.id, f]),
        );
        let at: string | null = topFolderId;
        while (at !== null && folders.length <= ids.length) {
          const row = folderById.get(at);
          if (!row) break;
          folders.push({ id: row.id, name: row.name });
          at = row.parentFolderId;
        }
        folders.reverse();
      }
      return toPageTrailDto(folders, pages);
    });
  },

  /**
   * Read one page with its canonical state, and whether the caller may write it.
   * `page:view`. The read takes no row lock, so it never waits on a save. An
   * ARCHIVED page still opens here (§7), read-only whatever the role, with who
   * archived it and its archive root — a sub-page's banner links to the root,
   * the only page of the set that restores or deletes (MOTIR-7421). It carries
   * the live chip data for every work item the body mentions (MOTIR-7572),
   * resolved after the page read by the same resolver a comment's chips use, so
   * a chip shows the item's current key, title and status without a page save.
   */
  async getPage(ctx: ServiceContext, input: GetPageInput): Promise<PageDto> {
    const { page, mentionedIds } = await withWorkspaceContext(
      scopeTo(ctx, input.projectId),
      async (tx) => {
        await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
        const record = await pageRepository.findWithBodyById(input.pageId, tx);
        if (!record || record.projectId !== input.projectId) {
          throw new PageNotFoundError(input.pageId);
        }
        const { canEditPages, canDeletePages } = await projectAccessService.getPageCapabilities(
          input.projectId,
          ctx,
          tx,
        );
        const names: { archiver?: string; archiveRootTitle?: string } = {};
        if (record.archivedById !== null) {
          const [archiver] = await userRepository.findByIds([record.archivedById], tx);
          names.archiver = archiver?.name;
        }
        if (record.archiveRootId !== null && record.archiveRootId !== record.id) {
          names.archiveRootTitle = (await pageRepository.findById(record.archiveRootId, tx))?.title;
        }
        const links = extractLinks(record.bodyJson as Parameters<typeof extractLinks>[0]);
        return {
          page: {
            row: toLockedPageRow(record),
            caps: { canEdit: canEditPages, canDelete: canDeletePages },
            names,
          },
          mentionedIds: links.map((l) => l.workItemId),
        };
      },
    );
    // `{}` with no query for a page that mentions nothing (the resolver's own
    // short-circuit).
    const workItemRefs = await resolveWorkItemRefSummaries(
      { ids: mentionedIds, keys: [] },
      input.projectId,
      ctx,
    );
    return toPageDto(page.row, page.caps, page.names, workItemRefs);
  },

  /**
   * The sub-pages an archive of this page TAKES or TOOK, counted and the first
   * {@link PAGE_ARCHIVE_SET_TITLES} named, shallowest first — `page:view`
   * (MOTIR-7423). For a LIVE page it is its live descendants (§7: an archive
   * takes every live sub-page; one archived earlier keeps its own archive). For
   * an ARCHIVED page it is the rest of its archive's set — the pages a restore
   * brings back and a delete removes with it. Two reads, no lock: it describes,
   * and the write that follows re-reads under its own locks.
   */
  async describeArchiveSet(
    ctx: ServiceContext,
    input: PageArchiveActionInput,
  ): Promise<PageArchiveSetDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const page = await pageRepository.findById(input.pageId, tx);
      if (!page || page.projectId !== input.projectId) throw new PageNotFoundError(input.pageId);
      const members =
        page.archivedAt === null || page.archiveRootId === null
          ? (await pageRepository.findSubtree(page.id, tx)).filter((p) => p.archivedAt === null)
          : (await pageRepository.findArchiveSet(page.archiveRootId, tx)).filter(
              (p) => p.id !== page.archiveRootId,
            );
      const shallowest = [...members]
        .sort((a, b) => a.ancestorPageIds.length - b.ancestorPageIds.length)
        .slice(0, PAGE_ARCHIVE_SET_TITLES)
        .map((p) => p.id);
      const titled = await pageRepository.findTitlesByIds(shallowest, tx);
      const titleById = new Map(titled.map((p) => [p.id, p.title]));
      return {
        subPageCount: members.length,
        subPageTitles: shallowest.flatMap((id) => {
          const title = titleById.get(id);
          return title === undefined ? [] : [title];
        }),
      };
    });
  },

  /**
   * Archive a page with every LIVE sub-page under it, as one set (§7) — `page:edit`.
   * The package refuses a page already archived (`PAGE_ARCHIVED`). Contract 6.
   */
  async archivePage(
    ctx: ServiceContext,
    input: PageArchiveActionInput,
  ): Promise<ArchivePageResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      await lockArchiveStructure(input.projectId, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const result = await archivePageProcedure(store, systemClock, {
        pageId: input.pageId,
        projectId: input.projectId,
        actorId: ctx.userId,
      });
      return {
        archivedIds: [...result.archivedIds],
        rootId: result.rootId,
        subPageCount: result.archivedIds.length - 1,
      };
    });
  },

  /**
   * Restore an archive ROOT and exactly its set, to the first rung of §7's
   * landing ladder that still holds — `page:edit`. Returns where it landed with
   * the parent's display name, for the restored-elsewhere notice. The package
   * refuses a live page (`PAGE_NOT_ARCHIVED`) and a sub-page
   * (`PAGE_ARCHIVE_ROOT_REQUIRED`). Contract 6.
   */
  async restorePage(
    ctx: ServiceContext,
    input: PageArchiveActionInput,
  ): Promise<RestorePageResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      await lockArchiveStructure(input.projectId, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const { restoredIds, landing } = await restorePageProcedure(store, {
        pageId: input.pageId,
        projectId: input.projectId,
        actorId: ctx.userId,
      });
      let title: string | null = null;
      if (landing.parentPageId !== null) {
        title = (await pageRepository.findById(landing.parentPageId, tx))?.title ?? null;
      } else if (landing.folderId !== null) {
        title = (await folderRepository.findById(landing.folderId, tx))?.name ?? null;
      }
      return {
        restoredIds: [...restoredIds],
        landing: {
          kind: landing.kind,
          parentPageId: landing.parentPageId,
          folderId: landing.folderId,
          title,
        },
      };
    });
  },

  /**
   * PERMANENTLY delete an archive ROOT and its set, versions included — the one
   * `page:delete` door (Manager only, MOTIR-7419). Only from the archive: the
   * package refuses a live page (`PAGE_NOT_ARCHIVED`) and a sub-page
   * (`PAGE_ARCHIVE_ROOT_REQUIRED`). Contract 6.
   */
  async deletePage(
    ctx: ServiceContext,
    input: PageArchiveActionInput,
  ): Promise<DeletePageResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanDeletePages(input.projectId, ctx, tx);
      await lockArchiveStructure(input.projectId, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const { deletedIds } = await deletePageProcedure(store, {
        pageId: input.pageId,
        projectId: input.projectId,
        actorId: ctx.userId,
      });
      return { deletedIds: [...deletedIds] };
    });
  },

  /**
   * The project's Archived pages, newest first — `page:view`, so a Viewer reads
   * it. Archive ROOTS only (a sub-page that left with its root is not a row),
   * keyset-paged by the repository (50 by default, 100 at most;
   * `PAGE_CURSOR_INVALID` for a cursor it did not issue). Each row carries its
   * came-from trail: its stored ancestors' titles in ONE read (archived ones
   * included, a deleted one as an em dash), the folder chain its topmost page
   * was filed in, and its archiver's name — every lookup batched over the page,
   * never one per row.
   */
  async listArchivedPages(
    ctx: ServiceContext,
    input: ListArchivedPagesInput,
  ): Promise<PageArchivedListDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const { rows, nextCursor } = await pageRepository.listArchivedRoots(
        input.projectId,
        { cursor: input.cursor ?? null, limit: input.limit ?? null },
        tx,
      );

      const ancestorIds = [...new Set(rows.flatMap((r) => r.ancestorPageIds))];
      const ancestors = await pageRepository.findTitlesByIds(ancestorIds, tx);
      const ancestorById = new Map(ancestors.map((p) => [p.id, p.title]));
      const folderOfAncestor = new Map(ancestors.map((p) => [p.id, p.folderId]));
      const archivedAncestors = new Set(
        ancestors.filter((p) => p.archivedAt !== null).map((p) => p.id),
      );

      // A root's folder is its topmost page's: its own without ancestors, else
      // the top ancestor's — read in the same batch as the titles. A deleted top
      // ancestor leaves no folder to name.
      const topFolderOf = new Map<string, string | null>();
      for (const row of rows) {
        const top = row.ancestorPageIds[0];
        topFolderOf.set(
          row.id,
          top === undefined ? row.folderId : (folderOfAncestor.get(top) ?? null),
        );
      }
      const chains = await folderChains(
        [...topFolderOf.values()].filter((id): id is string => id !== null),
        tx,
      );

      const archiverIds = [
        ...new Set(rows.map((r) => r.archivedById).filter((id): id is string => id !== null)),
      ];
      const archivers = await userRepository.findByIds(archiverIds, tx);
      const nameById = new Map(archivers.map((u) => [u.id, u.name]));

      return {
        items: rows.map((row) => {
          const folderId = topFolderOf.get(row.id) ?? null;
          return toPageArchivedListItemDto(
            row,
            row.archivedById === null ? undefined : nameById.get(row.archivedById),
            ancestorById,
            folderId === null ? [] : (chains.get(folderId) ?? []),
            archivedAncestors,
          );
        }),
        nextCursor,
      };
    });
  },

  /**
   * The project's pages, most recently edited first, each with its last editor's
   * display name — the `/pages` index (MOTIR-7300). `page:view`. Flat, and KEPT
   * beside {@link listTreeLevel} for its callers (the `/pages` index page) until
   * the tree replaces it there. Two reads in the one transaction: the pages (no body
   * columns), then the editors' names in one batch, never one per row.
   */
  async listPages(ctx: ServiceContext, input: ListPagesInput): Promise<PageListItemDto[]> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const records = await pageRepository.listByProject(input.projectId, tx);
      const editorIds = [...new Set(records.map((r) => r.updatedById))];
      const editors = await userRepository.findByIds(editorIds, tx);
      const nameById = new Map(editors.map((u) => [u.id, u.name]));
      return records.map((r) => toPageListItemDto(r, nameById.get(r.updatedById)));
    });
  },

  /**
   * The project a page lives in, from its id ALONE — the `/api/v1` page doors
   * (MOTIR-9493), which have no active project to scope by. `page:view` on that
   * project. A page that does not exist, one in another workspace, and one in a
   * project the caller cannot browse (or a token bound elsewhere cannot reach)
   * are the SAME `PageNotFoundError`, so an id is no existence oracle and no
   * title escapes. A browser without `page:view` is still refused as `edit`.
   */
  async getPageProjectId(ctx: ServiceContext, pageId: string): Promise<string> {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const page = await pageRepository.findById(pageId, tx);
        if (!page) throw new PageNotFoundError(pageId);
        try {
          await projectAccessService.assertCanViewPages(page.projectId, ctx, tx);
        } catch (err) {
          if (
            err instanceof ProjectNotFoundError ||
            (err instanceof ProjectAccessDeniedError && err.kind === 'browse')
          ) {
            throw new PageNotFoundError(pageId);
          }
          throw err;
        }
        return page.projectId;
      },
    );
  },

  /**
   * A page as an AGENT reads it — title, placement, revision, newest version and
   * body as markdown (§8.2). `page:view`. No row lock, so it never waits on a save.
   */
  async getPageMarkdown(
    ctx: ServiceContext,
    input: GetPageMarkdownInput,
  ): Promise<PageMarkdownDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const page = await readPageMarkdown(input.projectId, input.pageId, tx);
      if (!page) throw new PageNotFoundError(input.pageId);
      if (input.version === undefined) return page;
      // One version's body (MOTIR-7429) — never the current body as a fallback.
      const version = await pageVersionRepository.findByPageAndNumber(
        input.pageId,
        input.version,
        tx,
      );
      if (!version) throw new PageVersionNotFoundError(input.pageId, input.version);
      const [author] = await userRepository.findByIds([version.authorId], tx);
      return toPageMarkdownAtVersionDto(page, version, author?.name);
    });
  },

  /**
   * Replace a page's body with markdown, stating the revision the caller read —
   * `page:edit`. The package refuses a stale revision with
   * `PageRevisionConflictError` (409) and writes nothing; otherwise the page is
   * read back in the same transaction.
   */
  async savePageMarkdown(
    ctx: ServiceContext,
    input: SavePageMarkdownInput,
  ): Promise<PageMarkdownDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      await savePageMarkdownProcedure(store, systemClock, {
        pageId: input.pageId,
        actorId: ctx.userId,
        markdown: input.markdown,
        expectedRevision: input.expectedRevision,
      });
      return (await readPageMarkdown(input.projectId, input.pageId, tx))!;
    });
  },

  /**
   * Create a page under a parent and, when `markdown` is given, write its body —
   * in ONE transaction, so the page never exists without the body it was created
   * with. `page:edit`. The body save states the new row's revision, and being the
   * same author inside the coalescing window it extends version 1 rather than
   * starting version 2 (§6). A refused parent or body rolls the page back.
   */
  async createPageFromMarkdown(
    ctx: ServiceContext,
    input: CreatePageFromMarkdownInput,
  ): Promise<PageMarkdownDto> {
    const parent = parsePlacement(input.parent ?? { kind: 'root' });
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      const row = await createPageProcedure(store, systemClock, {
        workspaceId: ctx.workspaceId,
        projectId: input.projectId,
        actorId: ctx.userId,
        title: input.title,
        parent,
      });
      if (input.markdown) {
        await savePageMarkdownProcedure(store, systemClock, {
          pageId: row.id,
          actorId: ctx.userId,
          markdown: input.markdown,
          expectedRevision: row.revision,
        });
      }
      return (await readPageMarkdown(input.projectId, row.id, tx))!;
    });
  },

  /** Rename a page. `page:edit`. */
  async renamePage(ctx: ServiceContext, input: RenamePageInput): Promise<PageSummaryDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const row = await renamePageProcedure(store, {
        pageId: input.pageId,
        actorId: ctx.userId,
        title: input.title,
      });
      return toSummary(row);
    });
  },

  /** Merge one Yjs update into a page's state. `page:edit`. Returns the new revision. */
  async savePageUpdate(
    ctx: ServiceContext,
    input: SavePageUpdateInput,
  ): Promise<SavePageResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const revision = await savePageUpdateProcedure(store, systemClock, {
        pageId: input.pageId,
        actorId: ctx.userId,
        update: input.update,
      });
      return { revision };
    });
  },

  /**
   * One page of a page's history, newest first, each with its author's display
   * name — `page:view`. Keyset-paged on the version number (`before`), 50 by
   * default and 100 at most. Three reads in one transaction: the newest number
   * (for `isCurrent`), the rows (no snapshots), then the authors in ONE batch.
   */
  async listPageVersions(
    ctx: ServiceContext,
    input: ListPageVersionsInput,
  ): Promise<PageVersionListDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      await findInProject(pageStoreFor(tx), input.projectId, input.pageId);
      const limit = Math.min(
        Math.max(1, Math.trunc(input.limit ?? PAGE_LEVEL_PAGE_SIZE)),
        PAGE_LEVEL_PAGE_SIZE_MAX,
      );
      const latest = await pageVersionRepository.findLatest(input.pageId, tx);
      // One extra row says whether another page follows, without a count.
      const records = await pageVersionRepository.listByPage(
        input.pageId,
        { beforeNumber: input.before, limit: limit + 1 },
        tx,
      );
      const rows = records.slice(0, limit).map(toPageVersionRow);
      // Only a sealed version can carry a decision tag (MOTIR-7436), so most pages ask nothing.
      const marked = rows.filter((r) => r.sealedAt !== null).map((r) => r.id);
      const authors = await userRepository.findByIds([...new Set(rows.map((r) => r.authorId))], tx);
      const tags = await decisionPagePublicationRepository.decisionTagsForVersions(marked, tx);
      const nameById = new Map(authors.map((u) => [u.id, u.name]));
      const tagById = new Map(tags.map((tag) => [tag.versionId, tag]));
      return {
        items: rows.map((r) => {
          const tag = tagById.get(r.id);
          return {
            ...toPageVersionListItemDto(r, nameById.get(r.authorId), r.number === latest?.number),
            // Frozen wins over published (delta 5).
            decisionTag: tag?.frozenKey
              ? { kind: 'frozen' as const, key: tag.frozenKey }
              : tag?.publishedKey
                ? { kind: 'published' as const, key: tag.publishedKey }
                : null,
          };
        }),
        nextBefore: records.length > limit ? rows.at(-1)!.number : null,
      };
    });
  },

  /** One version with its snapshot — `page:view`. An unknown number is `PageVersionNotFoundError`. */
  async getPageVersion(ctx: ServiceContext, input: GetPageVersionInput): Promise<PageVersionDto> {
    const { version, authorName, isCurrent, mentionedIds } = await withWorkspaceContext(
      scopeTo(ctx, input.projectId),
      async (tx) => {
        await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
        const store = pageStoreFor(tx);
        await findInProject(store, input.projectId, input.pageId);
        const version = await store.findVersion(input.pageId, input.number);
        if (!version) throw new PageVersionNotFoundError(input.pageId, input.number);
        const latest = await store.latestVersion(input.pageId);
        const [author] = await userRepository.findByIds([version.authorId], tx);
        // The version's own snapshot names the work items its chips draw, so the
        // ids come from its stored state, not the live body.
        const links = extractLinks(deriveFormats(version.bodyState).json);
        return {
          version,
          authorName: author?.name,
          isCurrent: version.number === latest?.number,
          mentionedIds: links.map((l) => l.workItemId),
        };
      },
    );
    // `{}` with no query for a version that mentions nothing, and the reader's
    // own access decides each summary — the same resolver the page read uses.
    const workItemRefs = await resolveWorkItemRefSummaries(
      { ids: mentionedIds, keys: [] },
      input.projectId,
      ctx,
    );
    return toPageVersionDto(version, authorName, isCurrent, workItemRefs);
  },

  /**
   * Make version `number` the page's current content as a NEW version —
   * `page:edit`. Runs the package's procedure under the page's lock, and returns
   * the new state so an open editor re-seeds from it without a second read.
   */
  async restorePageVersion(
    ctx: ServiceContext,
    input: RestorePageVersionInput,
  ): Promise<RestorePageVersionResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const result = await restorePageVersionProcedure(store, systemClock, {
        pageId: input.pageId,
        number: input.number,
        actorId: ctx.userId,
      });
      const page = await store.lockPage(input.pageId);
      const [author] = await userRepository.findByIds([ctx.userId], tx);
      return {
        revision: result.revision,
        version: toPageVersionListItemDto(result.version, author?.name, true),
        bodyState: toBase64(page!.bodyState),
      };
    });
  },
  /**
   * The `@` picker's Pages section (Story MOTIR-7694 · MOTIR-7697): the live
   * pages of one project whose title contains `q`, newest edit first, at most
   * {@link PAGE_MENTION_SEARCH_LIMIT}, each with its place. `page:view` — a
   * browser without it is refused `'edit'` (→ 403), a non-browser `'browse'`
   * (→ 404). A query shorter than `QUICK_SEARCH_MIN_QUERY_LENGTH` answers `[]`
   * with no read; the route refuses it before it gets here.
   */
  async searchPagesForMention(
    ctx: ServiceContext,
    input: { projectId: string; q: string },
  ): Promise<PageMentionCandidateDto[]> {
    const q = input.q.trim();
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      if (q.length < QUICK_SEARCH_MIN_QUERY_LENGTH) return [];
      const rows = await pageRepository.searchLiveByTitle(
        input.projectId,
        q,
        PAGE_MENTION_SEARCH_LIMIT,
        tx,
      );
      return candidatesWithPlace(rows, ctx.workspaceId, tx);
    });
  },

  /**
   * The Link page picker's paged title search (Story MOTIR-7567 · MOTIR-9204):
   * {@link searchPagesForMention}'s match, gate and order, one
   * {@link PAGE_MENTION_SEARCH_LIMIT}-row page at a time. A one-row look-ahead
   * decides `nextCursor`, encoded from the last row served, so a page that ends
   * exactly at the last match never offers an empty next page. A cursor this
   * service did not issue is `PAGE_CURSOR_INVALID`.
   */
  async searchPagesForLink(
    ctx: ServiceContext,
    input: { projectId: string; q: string; cursor?: string | null },
  ): Promise<PageLinkCandidatesDto> {
    const q = input.q.trim();
    const after = input.cursor ? decodePageTitleSearchCursor(input.cursor) : null;
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      if (q.length < QUICK_SEARCH_MIN_QUERY_LENGTH) return { items: [], nextCursor: null };
      const window = await pageRepository.searchLiveByTitle(
        input.projectId,
        q,
        PAGE_MENTION_SEARCH_LIMIT + 1,
        tx,
        after,
      );
      const served = window.slice(0, PAGE_MENTION_SEARCH_LIMIT);
      const last = served[served.length - 1];
      return {
        items: await candidatesWithPlace(served, ctx.workspaceId, tx),
        nextCursor:
          window.length > PAGE_MENTION_SEARCH_LIMIT && last
            ? encodePageTitleSearchCursor({ updatedAt: last.updatedAt, id: last.id })
            : null,
      };
    });
  },

  /**
   * Full-text page search (Story MOTIR-9489 · MOTIR-9551): the LIVE pages of one
   * project whose title or body holds the words of `q`, best match first,
   * {@link PAGE_SEARCH_LIMIT} at a time, each as id, title, place, snippet and
   * rank only.
   *
   * ⚠️ THE ORDER IS THE CONTRACT. Access first, through `authorizePageSearch` —
   * the one filter — so a caller without `page:view` is refused by name whatever
   * the query or cursor, before any page is read. Then the query: trimmed-empty
   * is `PageSearchQueryEmptyError` (never every page), over
   * {@link PAGE_SEARCH_QUERY_MAX_LENGTH} is `PageSearchQueryTooLongError`. Then
   * the cursor (`PAGE_CURSOR_INVALID` for one this service did not issue). A
   * one-row look-ahead decides `nextCursor`. No total is returned anywhere.
   */
  async searchPages(
    ctx: ServiceContext,
    input: { projectId: string; q: string; cursor?: string | null },
  ): Promise<PageSearchResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      const scope = await authorizePageSearch(ctx, input.projectId, tx);
      const q = input.q.trim();
      if (q.length === 0) throw new PageSearchQueryEmptyError();
      if (q.length > PAGE_SEARCH_QUERY_MAX_LENGTH) throw new PageSearchQueryTooLongError();
      const after = input.cursor ? decodePageSearchCursor(input.cursor) : null;
      const window = await pageRepository.searchLiveFullText(
        scope.projectId,
        q,
        PAGE_SEARCH_LIMIT + 1,
        tx,
        after,
      );
      const served = window.slice(0, PAGE_SEARCH_LIMIT);
      const candidates = await candidatesWithPlace(served, ctx.workspaceId, tx);
      const last = served[served.length - 1];
      return {
        items: served.map((row, i) => toPageSearchHitDto(candidates[i]!, row)),
        nextCursor:
          window.length > PAGE_SEARCH_LIMIT && last
            ? encodePageSearchCursor({ rank: last.rank, id: last.id })
            : null,
      };
    });
  },

  /**
   * The live page chips of a work item's bodies (Story MOTIR-7694 ·
   * MOTIR-7697): one summary per tagged id, keyed by id. A live page of
   * `projectId` is `available` with its CURRENT title; every other id —
   * archived, deleted, another project's, unknown — is `unavailable`. A Visitor,
   * and a reader without `page:view`, get `unavailable` for EVERY id before any
   * page is read, so the four causes collapse to one answer and none is told.
   */
  async resolvePageRefSummaries(
    ids: readonly string[],
    projectId: string,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<PageRefMap> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return {};
    const allUnavailable = (): PageRefMap =>
      Object.fromEntries(unique.map((id) => [id, toPageRefSummaryDto(id, undefined)]));
    if (isVisitorContext(ctx)) return allUnavailable();
    return withWorkspaceContext(scopeTo(ctx, projectId), async (tx) => {
      const { canViewPages } = await projectAccessService.getPageCapabilities(projectId, ctx, tx);
      if (!canViewPages) return allUnavailable();
      const rows = await pageRepository.findSummariesByIds(unique, projectId, tx);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return Object.fromEntries(unique.map((id) => [id, toPageRefSummaryDto(id, byId.get(id))]));
    });
  },
};
