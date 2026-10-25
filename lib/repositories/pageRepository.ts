import { Prisma, type Page } from '@/generated/prisma/client';
import {
  PAGE_RECORD_SELECT,
  type PageArchivedRootRecord,
  type PageLevelRecord,
  type PageLockedRecord,
  type PageMarkdownRecord,
  type PageReadRecord,
  type PageRecord,
} from '@/lib/mappers/pageMappers';
import {
  archivedRootsLimit,
  decodeArchivedRootsCursor,
  encodeArchivedRootsCursor,
} from '@/lib/pages/archivedRootsCursor';

// Page repository — single operations on the `page` table (Story MOTIR-5752 ·
// MOTIR-7276). The persistence leaf under the `PageStore` adapter
// (`lib/pages/pageStoreAdapter.ts`); `@motir/pages`' procedures decide what is
// written and in what order, and the page service owns the transaction.
//
// ⚠️ EVERY METHOD TAKES A REQUIRED `tx`, reads included — the `folderRepository`
// reasoning: `page` carries the workspace policy pair and no system or public
// arm, so an UNBOUND read returns nothing and raises nothing, and a project's
// pages would render as a project with none.
//
// ⚠️ LIVE vs ARCHIVED (Story MOTIR-5755 · MOTIR-7420, `docs/decisions/pages.md`
// §7). An archived page has LEFT THE TREE: every read that draws the tree — a
// level, its `hasChildren`, a breadcrumb, the flat index, a level's positions,
// a folder's filed pages — carries {@link LIVE}, and the level reads take it
// through {@link levelPredicate}, so it is written once rather than per query.
// The reads that deliberately DO see archived pages say why on the method:
// `lockById`, `findById`, `findWithBodyById`, `findSubtree`, `findArchiveSet`,
// `listArchivedRoots` — and the write `moveFiledPages`.

/** What `insert` writes — the unchecked create shape, ids rather than relations. */
export type PageCreateInput = Prisma.PageUncheckedCreateInput;

/** What `updateBody` writes: the state, the three derived formats and the stamp. */
export interface PageBodyUpdate {
  bodyState: Uint8Array<ArrayBuffer>;
  bodyJson: Prisma.InputJsonValue;
  bodyMarkdown: string;
  bodyText: string;
  revision: number;
  updatedById: string;
  updatedAt: Date;
}

/**
 * One row of the `/pages` index (MOTIR-7300): the page's identity, title and its
 * last edit — no body columns, which are up to 2 MiB a row.
 */
/** The Link page picker's seek key: the last row served, in `[updatedAt desc, id desc]` order. */
export interface PageTitleSearchSeek {
  updatedAt: Date;
  id: string;
}

export type PageListRecord = Pick<Page, 'id' | 'title' | 'updatedAt' | 'updatedById'>;

/**
 * The parent a level read or a placement names — `@motir/pages`' `PagePlacement`,
 * restated here so the repository does not import the package (the import
 * direction `tests/packages/importDirection.test.ts` holds).
 */
export type PageParentRef =
  | { readonly kind: 'root' }
  | { readonly kind: 'folder'; readonly folderId: string }
  | { readonly kind: 'page'; readonly pageId: string };

/** The positions to mint between; `null` is the start (`before`) or end (`after`). */
export interface PageNeighbourPositions {
  before: string | null;
  after: string | null;
}

/** A folder as a placement under it reads it. */
export interface PageFolderRef {
  id: string;
  projectId: string;
}

/** One descendant of a moving page. */
export interface PageSubtreeRecord {
  id: string;
  ancestorPageIds: string[];
  archivedAt: Date | null;
  archiveRootId: string | null;
}

/** What `updatePlacement` writes. */
export interface PagePlacementUpdate {
  parentPageId: string | null;
  folderId: string | null;
  position: string;
  ancestorPageIds: readonly string[];
  updatedById: string;
}

/** One row of the Archived pages list (`listArchivedRoots`) and the cursor that follows it. */
export interface PageArchivedRootsPage {
  rows: PageArchivedRootRecord[];
  /** `null` when this was the last page. */
  nextCursor: string | null;
}

/** A page still in the tree — alias `p`. Never written out per query. */
const LIVE = Prisma.sql`p."archived_at" IS NULL`;

/**
 * The text-search configuration of page search (Story MOTIR-9489 · MOTIR-9550).
 * `simple` neither stems nor drops stop words, so a word is found as typed in
 * any of the eleven languages the product writes content in.
 */
export const PAGE_SEARCH_CONFIG = 'simple';

/**
 * How much of `body_text` is searchable. A `tsvector` is capped at 1 MiB and a
 * body may be 2 MiB, so an uncut body would make the page WRITE fail on the
 * index; words past this many characters are not found.
 */
export const PAGE_SEARCH_BODY_LIMIT = 200000;

/**
 * The searchable document of a page, alias `p` — the EXACT expression
 * `page_search_gin_idx` was built on (`20261025090000_page_search_index`). The
 * only place application code spells it: a query that writes it any other way
 * does not match the index and scans the table. The constants are inlined as
 * SQL text, not bound, because a bound parameter is not the index's constant.
 */
export const PAGE_SEARCH_DOCUMENT = Prisma.sql`to_tsvector(${Prisma.raw(
  `'${PAGE_SEARCH_CONFIG}'`,
)}, p."title" || ' ' || left(p."body_text", ${Prisma.raw(String(PAGE_SEARCH_BODY_LIMIT))}))`;

/**
 * The rows page search may ever return, alias `p`: the LIVE pages of ONE project
 * (MOTIR-9551). Spelled once so the by-meaning read can interpolate the same
 * predicate instead of writing a second one; the caller has already passed
 * `authorizePageSearch` (`lib/pages/pageSearchAccess.ts`).
 */
export function PAGE_SEARCH_LIVE_IN_PROJECT(projectId: string): Prisma.Sql {
  return Prisma.sql`p."project_id" = ${projectId} AND ${LIVE}`;
}

/** The full-text keyset seek: the last hit served, in `[rank desc, id desc]` order. */
export interface PageSearchSeek {
  rank: number;
  id: string;
}

/** One full-text hit as the repository reads it — what the service needs, no body. */
export interface PageSearchRow {
  id: string;
  title: string;
  ancestorPageIds: string[];
  folderId: string | null;
  rank: number;
  snippet: string;
}

/**
 * The LIVE rows of ONE level, alias `p`: at the root neither column is set; in a
 * folder the folder is (a sub-page never carries one — `page_parent_xor_folder`);
 * under a page the parent is. An archived page is in no level (§7), so its kept
 * `position` never shapes one.
 */
function levelPredicate(parent: PageParentRef): Prisma.Sql {
  switch (parent.kind) {
    case 'root':
      return Prisma.sql`p."parent_page_id" IS NULL AND p."folder_id" IS NULL AND ${LIVE}`;
    case 'folder':
      return Prisma.sql`p."folder_id" = ${parent.folderId} AND ${LIVE}`;
    case 'page':
      return Prisma.sql`p."parent_page_id" = ${parent.pageId} AND ${LIVE}`;
  }
}

export const pageRepository = {
  /**
   * Every page of one project, most recently edited first — the `/pages` index
   * (MOTIR-7300). Flat: the tree is MOTIR-5753's. `id` breaks a tie on
   * `updatedAt`, so two pages saved in one millisecond keep a stable order.
   */
  async listByProject(projectId: string, tx: Prisma.TransactionClient): Promise<PageListRecord[]> {
    return tx.page.findMany({
      where: { projectId, archivedAt: null },
      select: { id: true, title: true, updatedAt: true, updatedById: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * Read one page `FOR UPDATE`, body included. `null` when it does not exist or
   * is invisible under RLS. Archived pages included: the procedures lock a page
   * to decide what it may do, and an archived one is refused there (§7).
   *
   * ⚠️ THIS LOCK IS A SAVE'S WHOLE CONCURRENCY GUARANTEE: two saves of one page
   * in two transactions serialise here, and the second merges onto the state
   * the first committed. So it is raw SQL with the lock clause in plain sight.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<PageLockedRecord | null> {
    const rows = await tx.$queryRaw<PageLockedRecord[]>`
      SELECT "id",
             "workspace_id" AS "workspaceId",
             "project_id" AS "projectId",
             "title",
             "parent_page_id" AS "parentPageId",
             "folder_id" AS "folderId",
             "position",
             "ancestor_page_ids" AS "ancestorPageIds",
             "body_state" AS "bodyState",
             "revision",
             "created_by_id" AS "createdById",
             "updated_by_id" AS "updatedById",
             "created_at" AS "createdAt",
             "updated_at" AS "updatedAt",
             "archived_at" AS "archivedAt",
             "archive_root_id" AS "archiveRootId",
             "archived_by_id" AS "archivedById"
        FROM "page"
       WHERE "id" = ${id}
         FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Read one page WITH its body state and no lock — the read model's door
   * (`pagesService.getPage`). A reader never blocks a save, and a save never
   * waits on a reader. `null` when absent or invisible. Archived pages included:
   * an archived page opens read-only at its own address (§7). The derived JSON
   * rides along so the read can resolve the work items the body mentions
   * (MOTIR-7572) without decoding the Yjs state.
   */
  async findWithBodyById(id: string, tx: Prisma.TransactionClient): Promise<PageReadRecord | null> {
    return tx.page.findUnique({
      where: { id },
      select: { ...PAGE_RECORD_SELECT, bodyState: true, bodyJson: true },
    });
  },

  /**
   * Read what a page's MEANING VECTOR is derived from, and whether it is live
   * (Story MOTIR-9490 · MOTIR-9571) — `pageEmbeddingsService.embedPage`'s re-read.
   * `null` when absent or invisible. Archived pages included: the service decides
   * that an archived page's row goes.
   */
  async findEmbeddingSourceById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<Pick<
    Page,
    'id' | 'workspaceId' | 'projectId' | 'title' | 'bodyText' | 'archivedAt'
  > | null> {
    return tx.page.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        title: true,
        bodyText: true,
        archivedAt: true,
      },
    });
  },

  /**
   * Read one page with its derived MARKDOWN and no lock — the agent's read door
   * (`pagesService.getPageMarkdown`, MOTIR-7409). The Yjs state is not selected:
   * serving markdown never needs the canonical bytes. `null` when absent or invisible.
   */
  async findWithMarkdownById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageMarkdownRecord | null> {
    return tx.page.findUnique({
      where: { id },
      select: { ...PAGE_RECORD_SELECT, bodyMarkdown: true },
    });
  },

  /**
   * Read one page without its body. `null` when absent or invisible. Archived
   * pages included — the row read every procedure decides on (§7).
   */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<PageRecord | null> {
    return tx.page.findUnique({ where: { id }, select: PAGE_RECORD_SELECT });
  },

  /**
   * The id, title and folder of each page in `ids` — a page's breadcrumb
   * (`pagesService.getPageTrail`, MOTIR-7370), read in ONE query whatever the
   * depth. Unordered: the caller orders by the chain it already holds. An id
   * that does not exist, is invisible under RLS, or is ARCHIVED simply does not
   * come back — an archived ancestor is no longer a place in the tree.
   */
  async findTrailByIds(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Page, 'id' | 'title' | 'folderId'>>> {
    if (ids.length === 0) return [];
    return tx.page.findMany({
      where: { id: { in: [...ids] }, archivedAt: null },
      select: { id: true, title: true, folderId: true },
    });
  },

  /**
   * The id, title and folder of each page in `ids`, ARCHIVED ONES INCLUDED, in ONE query —
   * the Archived pages list's came-from trail (MOTIR-7421), which names where an
   * archived page used to sit, its archived ancestors among it. Unordered; an id
   * that is gone simply does not come back. Unlike {@link findTrailByIds}, which
   * draws a live page's breadcrumb and so reads live pages only. `archivedAt`
   * says which of them is archived — the list marks those (MOTIR-7424).
   */
  async findTitlesByIds(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Page, 'id' | 'title' | 'folderId' | 'archivedAt'>>> {
    if (ids.length === 0) return [];
    return tx.page.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true, folderId: true, archivedAt: true },
    });
  },

  /**
   * Which of `ids` are pages of `projectId` — ARCHIVED ONES INCLUDED — in ONE
   * query (MOTIR-7696). The work-item save keeps a `motir-page:` tag's link row
   * only for a page this returns, so a pasted token naming another project's
   * page, or an id that never existed, is skipped rather than aborting the save
   * on the same-project trigger. Archived pages count: their row is kept so a
   * restore brings the link back, and the Pages read already hides them.
   */
  async findIdsInProject(
    ids: readonly string[],
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.page.findMany({
      where: { id: { in: [...ids] }, projectId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * The LIVE pages of one project whose title contains `q` (case-insensitive),
   * most recently edited first, at most `take` — the `@` picker's Pages section
   * (MOTIR-7697). Prisma's `contains` escapes `%` and `_`, so a query is matched
   * literally. Carries what the row's PLACE needs: the ancestor chain (its last
   * entry is the parent page) and the folder.
   *
   * `after` is the Link page picker's keyset seek (MOTIR-9204): rows strictly
   * after `(updatedAt, id)` in the same `[updatedAt desc, id desc]` order. Called
   * without it the `where` and order are exactly the `@` popup's.
   */
  async searchLiveByTitle(
    projectId: string,
    q: string,
    take: number,
    tx: Prisma.TransactionClient,
    after?: PageTitleSearchSeek | null,
  ): Promise<Array<Pick<Page, 'id' | 'title' | 'ancestorPageIds' | 'folderId' | 'updatedAt'>>> {
    return tx.page.findMany({
      where: {
        projectId,
        archivedAt: null,
        title: { contains: escapeLikePattern(q), mode: 'insensitive' },
        ...(after
          ? {
              OR: [
                { updatedAt: { lt: after.updatedAt } },
                { updatedAt: after.updatedAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, title: true, ancestorPageIds: true, folderId: true, updatedAt: true },
    });
  },

  /**
   * The LIVE pages of one project whose title or body matches `q` as words
   * (Story MOTIR-9489 · MOTIR-9551), best match first, at most `take`. The match
   * is {@link PAGE_SEARCH_DOCUMENT} verbatim, so `page_search_gin_idx` serves it.
   * `q` is BOUND, and `plainto_tsquery` reads it as plain words — quotes, `%`
   * and tsquery operators are text, never syntax — so no input raises. A query
   * with no words left matches nothing.
   *
   * `rank` is `ts_rank` as `float8`, so a cursor carrying it compares exactly;
   * `id` breaks a tie, making the order total. `after` seeks strictly past the
   * last hit served. The snippet is computed only for the `take` rows returned,
   * from the same searchable slice of the body; a title-only hit gets the body's
   * leading words, an empty body `''`.
   */
  async searchLiveFullText(
    projectId: string,
    q: string,
    take: number,
    tx: Prisma.TransactionClient,
    after?: PageSearchSeek | null,
  ): Promise<PageSearchRow[]> {
    const config = Prisma.raw(`'${PAGE_SEARCH_CONFIG}'`);
    const query = Prisma.sql`plainto_tsquery(${config}, ${q})`;
    const seek = after
      ? Prisma.sql`WHERE m."rank" < ${after.rank}::float8 OR (m."rank" = ${after.rank}::float8 AND m."id" < ${after.id})`
      : Prisma.empty;
    return tx.$queryRaw<PageSearchRow[]>`
      SELECT h."id", h."title", h."ancestorPageIds", h."folderId", h."rank",
             ts_headline(${config}, left(h."body_text", ${Prisma.raw(String(PAGE_SEARCH_BODY_LIMIT))}),
               ${query}, 'MaxFragments=1, MinWords=8, MaxWords=24, StartSel="", StopSel=""') AS "snippet"
      FROM (
        SELECT m.* FROM (
          SELECT p."id", p."title", p."ancestor_page_ids" AS "ancestorPageIds",
                 p."folder_id" AS "folderId", p."body_text",
                 ts_rank(${PAGE_SEARCH_DOCUMENT}, ${query})::float8 AS "rank"
          FROM "page" p
          WHERE ${PAGE_SEARCH_LIVE_IN_PROJECT(projectId)} AND ${PAGE_SEARCH_DOCUMENT} @@ ${query}
        ) m
        ${seek}
        ORDER BY m."rank" DESC, m."id" DESC
        LIMIT ${take}
      ) h
      ORDER BY h."rank" DESC, h."id" DESC`;
  },

  /**
   * The next `take` LIVE page ids of a scope after `afterId`, in id order — the
   * page embedding backfill's keyset scan (MOTIR-9573). A seek on `id`, never an
   * OFFSET, so an interrupted run resumes by simply running again.
   */
  async listLiveIdsAfter(
    afterId: string | null,
    take: number,
    scope: { workspaceId?: string; projectId?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    return tx.page.findMany({
      where: {
        archivedAt: null,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, workspaceId: true },
      orderBy: { id: 'asc' },
      take,
    });
  },

  /**
   * The ids of the LIVE pages of one project whose title or body matches `q` as
   * words, best match first, at most `take` (Story MOTIR-9490 · MOTIR-9572) —
   * the full-text half of the fused page search. The same match and order as
   * {@link searchLiveFullText} (`ts_rank` desc, id desc), under the same
   * {@link PAGE_SEARCH_LIVE_IN_PROJECT}, with no snippet: only the served rows
   * are read for one, by {@link findSearchRowsByIds}.
   */
  async searchLiveFullTextIds(
    projectId: string,
    q: string,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const config = Prisma.raw(`'${PAGE_SEARCH_CONFIG}'`);
    const query = Prisma.sql`plainto_tsquery(${config}, ${q})`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT m."id" FROM (
        SELECT p."id", ts_rank(${PAGE_SEARCH_DOCUMENT}, ${query})::float8 AS "rank"
        FROM "page" p
        WHERE ${PAGE_SEARCH_LIVE_IN_PROJECT(projectId)} AND ${PAGE_SEARCH_DOCUMENT} @@ ${query}
      ) m
      ORDER BY m."rank" DESC, m."id" DESC
      LIMIT ${take}`;
    return rows.map((r) => r.id);
  },

  /**
   * The hit rows of exactly `ids` — id, title, ancestor ids, folder id and a
   * `ts_headline` snippet for `q` — in ONE query, under
   * {@link PAGE_SEARCH_LIVE_IN_PROJECT} (MOTIR-9572). A page with no word match
   * (a by-meaning hit) gets the body's leading words, an empty body `''`. Rows
   * come back in no particular order; an id that is not a live page of the
   * project is absent. `rank` is 0 — the caller owns the fused score.
   */
  async findSearchRowsByIds(
    projectId: string,
    ids: readonly string[],
    q: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageSearchRow[]> {
    if (ids.length === 0) return [];
    const config = Prisma.raw(`'${PAGE_SEARCH_CONFIG}'`);
    const query = Prisma.sql`plainto_tsquery(${config}, ${q})`;
    return tx.$queryRaw<PageSearchRow[]>`
      SELECT p."id", p."title", p."ancestor_page_ids" AS "ancestorPageIds",
             p."folder_id" AS "folderId", 0::float8 AS "rank",
             ts_headline(${config}, left(p."body_text", ${Prisma.raw(String(PAGE_SEARCH_BODY_LIMIT))}),
               ${query}, 'MaxFragments=1, MinWords=8, MaxWords=24, StartSel="", StopSel=""') AS "snippet"
      FROM "page" p
      WHERE ${PAGE_SEARCH_LIVE_IN_PROJECT(projectId)} AND p."id" IN (${Prisma.join([...ids])})`;
  },

  /**
   * The current title and archive state of each of `ids` that is a page of
   * `projectId`, in ONE query — the live page chip's summaries (MOTIR-7697).
   * Archived pages come back (the caller marks them unavailable); an id of
   * another project, or one that is gone, does not.
   */
  async findSummariesByIds(
    ids: readonly string[],
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Page, 'id' | 'title' | 'archivedAt'>>> {
    if (ids.length === 0) return [];
    return tx.page.findMany({
      where: { id: { in: [...ids] }, projectId },
      select: { id: true, title: true, archivedAt: true },
    });
  },

  /**
   * Serialise every PLACEMENT write in one project — a create, a move, a subtree
   * rewrite — for the length of the caller's transaction (MOTIR-7369).
   *
   * ⚠️ ONE LOCK PER PROJECT, NOT PER PARENT. A move changes two sibling sets and
   * a whole subtree, and a cycle is a property of a CHAIN: two moves that share
   * no row ("A under B", "B under A") each pass the cycle check against a tree
   * the other is changing unless they serialise. An advisory lock rather than
   * row locks because an empty level has no row to lock —
   * `folderRepository.lockStructure`'s reasoning.
   *
   * ⚠️ LOCK ORDER: folder-structure, THEN page-structure, wherever both are
   * taken (`foldersService.deleteFolder`), so the two cannot deadlock.
   */
  async lockStructure(projectId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`page-structure:${projectId}`}, 0))`;
  },

  /**
   * The greatest position among one parent's LIVE pages — the root, a folder or
   * a page — or `null` for an empty level. Compared in `COLLATE "C"` — code-unit
   * order, the order fractional keys are minted in — whatever the database's
   * default collation.
   */
  async lastPosition(
    projectId: string,
    parent: PageParentRef,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ position: string }>>`
      SELECT p."position" FROM "page" p
       WHERE p."project_id" = ${projectId}
         AND ${levelPredicate(parent)}
       ORDER BY p."position" COLLATE "C" DESC, p."id" COLLATE "C" DESC
       LIMIT 1
    `;
    return rows[0]?.position ?? null;
  },

  /**
   * The positions a placement mints between at one parent's level — the port's
   * `siblingNeighbours`. Named ids are children of `parent` (the caller checked).
   * An UNNAMED side is read from the level in `(position, id) COLLATE "C"`
   * order: with only `beforeId`, `after` is the page right after it; with only
   * `afterId`, `before` is the page right before it; with neither, `before` is
   * the level's last page and `after` is `null`. A named id that is not there
   * reads as `null` on its side.
   */
  async neighbourPositions(
    projectId: string,
    parent: PageParentRef,
    beforeId: string | null,
    afterId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<PageNeighbourPositions> {
    let rows: PageNeighbourPositions[];
    if (beforeId !== null && afterId !== null) {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT (SELECT "position" FROM "page" WHERE "id" = ${beforeId}) AS "before",
               (SELECT "position" FROM "page" WHERE "id" = ${afterId}) AS "after"
      `;
    } else if (beforeId !== null) {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT b."position" AS "before",
               (SELECT p."position" FROM "page" p
                 WHERE p."project_id" = ${projectId}
                   AND ${levelPredicate(parent)}
                   AND (p."position" COLLATE "C", p."id" COLLATE "C") > (b."position", b."id")
                 ORDER BY p."position" COLLATE "C" ASC, p."id" COLLATE "C" ASC
                 LIMIT 1) AS "after"
          FROM "page" b
         WHERE b."id" = ${beforeId}
      `;
    } else if (afterId !== null) {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT (SELECT p."position" FROM "page" p
                 WHERE p."project_id" = ${projectId}
                   AND ${levelPredicate(parent)}
                   AND (p."position" COLLATE "C", p."id" COLLATE "C") < (a."position", a."id")
                 ORDER BY p."position" COLLATE "C" DESC, p."id" COLLATE "C" DESC
                 LIMIT 1) AS "before",
               a."position" AS "after"
          FROM "page" a
         WHERE a."id" = ${afterId}
      `;
    } else {
      rows = await tx.$queryRaw<PageNeighbourPositions[]>`
        SELECT p."position" AS "before", NULL::text AS "after" FROM "page" p
         WHERE p."project_id" = ${projectId}
           AND ${levelPredicate(parent)}
         ORDER BY p."position" COLLATE "C" DESC, p."id" COLLATE "C" DESC
         LIMIT 1
      `;
    }
    return rows[0] ?? { before: null, after: null };
  },

  /**
   * Read the folder a page is being placed in, `FOR SHARE` — so a concurrent
   * folder delete (which updates the pages it holds and then deletes the row)
   * either commits first and this reads nothing, or waits for this transaction
   * and then sees the page it placed. `null` when the folder does not exist or
   * is invisible under RLS: `folder_project_narrow` hides another project's
   * folder when the context names a project, `folder_active_workspace` another
   * workspace's.
   */
  async findFolderForPlacement(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageFolderRef | null> {
    const rows = await tx.$queryRaw<PageFolderRef[]>`
      SELECT "id", "project_id" AS "projectId" FROM "folder" WHERE "id" = ${folderId} FOR SHARE
    `;
    return rows[0] ?? null;
  },

  /**
   * Every DESCENDANT of a page, at any depth (the page itself excluded): the rows
   * whose ancestor chain contains it. Archived descendants INCLUDED, unfiltered on
   * purpose: a move rebases them with their ancestor, and restore and delete read
   * a subtree's archived pages — the package filters what it needs (§7).
   * Shallowest first, so a set built from it lists a parent before its children
   * whatever order the heap holds the rows in.
   */
  async findSubtree(pageId: string, tx: Prisma.TransactionClient): Promise<PageSubtreeRecord[]> {
    return tx.$queryRaw<PageSubtreeRecord[]>`
      SELECT "id",
             "ancestor_page_ids" AS "ancestorPageIds",
             "archived_at" AS "archivedAt",
             "archive_root_id" AS "archiveRootId"
        FROM "page"
       WHERE "ancestor_page_ids" @> ARRAY[${pageId}]::text[]
       ORDER BY cardinality("ancestor_page_ids"), "id"
    `;
  },

  /** Move one page: its parent, folder, position and ancestors, in ONE `UPDATE`. */
  async updatePlacement(
    id: string,
    write: PagePlacementUpdate,
    tx: Prisma.TransactionClient,
  ): Promise<PageRecord> {
    return tx.page.update({
      where: { id },
      data: {
        parentPageId: write.parentPageId,
        folderId: write.folderId,
        position: write.position,
        ancestorPageIds: [...write.ancestorPageIds],
        updatedById: write.updatedById,
      },
      select: PAGE_RECORD_SELECT,
    });
  },

  /**
   * Rewrite the `ancestor_page_ids` of EVERY descendant of `pageId` in ONE
   * statement: the part of each chain above `pageId` becomes `newPrefix`, and
   * `pageId` and everything below it are kept (`chain[array_position(chain,
   * pageId):]`). One statement, so the depth CHECK and the readers see the whole
   * subtree move at once. Returns the number of rows rewritten.
   */
  async rebaseDescendants(
    pageId: string,
    newPrefix: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "page"
         SET "ancestor_page_ids" = ${[...newPrefix]}::text[]
               || "ancestor_page_ids"[array_position("ancestor_page_ids", ${pageId}::text):]
       WHERE "ancestor_page_ids" @> ARRAY[${pageId}]::text[]
    `;
  },

  /**
   * One KEYSET page of one parent's pages — the root, a folder or a page — for
   * the `/pages` tree level. Ordered by `(position, id)` in `COLLATE "C"`, a
   * TOTAL order, and seeks strictly after `after`, so a page created or moved
   * between two reads never shifts a page boundary. Reads `limit` rows; the
   * caller asks for one more than it serves to learn whether a page follows.
   * `hasChildren` is whether the page holds any LIVE sub-page: a page whose only
   * children are archived shows no expander.
   */
  async findLevelAfter(
    projectId: string,
    parent: PageParentRef,
    after: { position: string; id: string } | null,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PageLevelRecord[]> {
    const seek = after
      ? Prisma.sql`AND (p."position" COLLATE "C", p."id" COLLATE "C") > (${after.position}, ${after.id})`
      : Prisma.empty;
    return tx.$queryRaw<PageLevelRecord[]>`
      SELECT p."id",
             p."title",
             p."position",
             p."updated_at" AS "updatedAt",
             EXISTS (SELECT 1 FROM "page" c
                      WHERE c."parent_page_id" = p."id" AND c."archived_at" IS NULL) AS "hasChildren"
        FROM "page" p
       WHERE p."project_id" = ${projectId}
         AND ${levelPredicate(parent)}
         ${seek}
       ORDER BY p."position" COLLATE "C" ASC, p."id" COLLATE "C" ASC
       LIMIT ${limit}
    `;
  },

  /**
   * The LIVE pages FILED in one folder — its top-level pages, the set a folder
   * delete mints new positions for (MOTIR-7371) — in level order,
   * `(position, id) COLLATE "C"`. Archived filed pages are not here; the delete
   * still carries them up, in `moveFiledPages`. A
   * sub-page carries no `folder_id` (`page_parent_xor_folder`), so it is never
   * here: it follows its parent wherever the parent goes.
   */
  async findFiledInFolder(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; position: string }>> {
    return tx.$queryRaw<Array<{ id: string; position: string }>>`
      SELECT p."id", p."position" FROM "page" p
       WHERE p."folder_id" = ${folderId}
         AND ${LIVE}
       ORDER BY p."position" COLLATE "C" ASC, p."id" COLLATE "C" ASC
    `;
  },

  /**
   * How many LIVE pages are filed directly in `folderId` — the set
   * `findFiledInFolder` reads, and the folder delete dialog's page count.
   */
  async countFiledInFolder(folderId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.page.count({ where: { folderId, archivedAt: null } });
  },

  /**
   * Re-file pages from one folder to another folder, or to the project root
   * (`toFolderId` null), each at the position the caller minted for it, in ONE
   * `UPDATE` (MOTIR-7371 — a folder delete's move-up). Only rows still filed in
   * `fromFolderId` are touched. Their sub-pages are not rows of this write: a
   * sub-page carries no folder, and its ancestor chain names pages only.
   *
   * ⚠️ EVERY ARCHIVED PAGE FILED IN `fromFolderId` MOVES TOO, whether or not
   * `positions` names it, and keeps its own position (an archived page is in no
   * level, so its position orders nothing until a restore re-checks it). Not
   * moving it would leave a row pointing at the folder, and `page.folder_id` is
   * `NO ACTION`: the folder delete would fail. §7 also relies on it — "a folder
   * deleted meanwhile has already moved the page up". Returns the number of
   * pages moved, archived ones included.
   */
  async moveFiledPages(
    fromFolderId: string,
    toFolderId: string | null,
    positions: ReadonlyArray<{ id: string; position: string }>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const ids = positions.map((p) => p.id);
    return tx.$executeRaw`
      UPDATE "page" p
         SET "folder_id" = ${toFolderId}::text,
             "position" = COALESCE(
               (SELECT v."position"
                  FROM unnest(${ids}::text[], ${positions.map((p) => p.position)}::text[])
                       AS v("id", "position")
                 WHERE v."id" = p."id"),
               p."position")
       WHERE p."folder_id" = ${fromFolderId}
         AND (p."id" = ANY(${ids}::text[]) OR p."archived_at" IS NOT NULL)
    `;
  },

  // ── Archive (Story MOTIR-5755 · MOTIR-7420) ─────────────────────────────────

  /**
   * Write one archive state onto every page in `ids` in ONE `UPDATE` — archive
   * (`archivedAt` + the root's id + who) or restore (all three `null`). One
   * statement, so `page_archive_pairing` and every reader see the whole set
   * leave or come back at once.
   */
  async setArchived(
    ids: readonly string[],
    archivedAt: Date | null,
    archiveRootId: string | null,
    archivedById: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    return tx.$executeRaw`
      UPDATE "page"
         SET "archived_at" = ${archivedAt}::timestamptz,
             "archive_root_id" = ${archiveRootId}::text,
             "archived_by_id" = ${archivedById}::text
       WHERE "id" = ANY(${[...ids]}::text[])
    `;
  },

  /**
   * One ARCHIVE SET — every page whose `archive_root_id` is `rootId`, the root
   * itself included (`page_archive_root_idx`). Archived pages by definition.
   */
  async findArchiveSet(rootId: string, tx: Prisma.TransactionClient): Promise<PageSubtreeRecord[]> {
    return tx.$queryRaw<PageSubtreeRecord[]>`
      SELECT "id",
             "ancestor_page_ids" AS "ancestorPageIds",
             "archived_at" AS "archivedAt",
             "archive_root_id" AS "archiveRootId"
        FROM "page"
       WHERE "archive_root_id" = ${rootId}
    `;
  },

  /**
   * Permanently delete every page in `ids` in ONE `DELETE`. One statement, so
   * `page_parent_page_id_fkey` (`NO ACTION`) is checked once, at its end: a set
   * whose pages point at each other deletes, and a survivor still pointing into
   * the set fails the whole statement and deletes nothing. `page_version` rows
   * cascade; `attachment.page_id` is set null, and the orphan sweep
   * (`attachmentRepository.listOrphans`) reclaims the blob. Returns the count.
   */
  async deletePages(ids: readonly string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    return tx.$executeRaw`DELETE FROM "page" WHERE "id" = ANY(${[...ids]}::text[])`;
  },

  /** Whether a LIVE page at one parent's level already holds `position` — a restore's check. */
  async positionTaken(
    projectId: string,
    parent: PageParentRef,
    position: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ taken: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM "page" p
         WHERE p."project_id" = ${projectId}
           AND ${levelPredicate(parent)}
           AND p."position" = ${position}
      ) AS "taken"
    `;
    return Boolean(rows[0]?.taken);
  },

  /**
   * One KEYSET page of a project's ARCHIVE ROOTS — the Archived pages list —
   * newest first, `(archived_at DESC, id DESC)`, over `page_archived_roots_idx`
   * (`WHERE archive_root_id = id`, so a sub-page that left with its root is never
   * a row). The default page size and its cap are the tree level's (50 / 100); a
   * cursor this read did not issue is `PAGE_CURSOR_INVALID`. Each row carries its
   * sub-page count — its set minus itself, from ONE grouped subquery over the
   * page's roots, never a count per row — and its stored placement, so the list
   * can say where it came from. Archived pages by definition.
   */
  async listArchivedRoots(
    projectId: string,
    page: { cursor?: string | null; limit?: number | null },
    tx: Prisma.TransactionClient,
  ): Promise<PageArchivedRootsPage> {
    const limit = archivedRootsLimit(page.limit);
    const after = page.cursor ? decodeArchivedRootsCursor(page.cursor) : null;
    const seek = after
      ? Prisma.sql`AND (p."archived_at", p."id") < (${after.archivedAt}::timestamptz, ${after.id})`
      : Prisma.empty;
    const rows = await tx.$queryRaw<PageArchivedRootRecord[]>`
      WITH roots AS (
        SELECT p."id", p."title", p."archived_at", p."archived_by_id",
               p."parent_page_id", p."folder_id", p."ancestor_page_ids"
          FROM "page" p
         WHERE p."project_id" = ${projectId}
           AND p."archive_root_id" = p."id"
           ${seek}
         ORDER BY p."archived_at" DESC, p."id" DESC
         LIMIT ${limit + 1}
      )
      SELECT r."id",
             r."title",
             r."archived_at" AS "archivedAt",
             r."archived_by_id" AS "archivedById",
             COALESCE(s."count", 0)::int AS "subPageCount",
             r."parent_page_id" AS "parentPageId",
             r."folder_id" AS "folderId",
             r."ancestor_page_ids" AS "ancestorPageIds"
        FROM roots r
        LEFT JOIN (
          SELECT m."archive_root_id", COUNT(*) - 1 AS "count"
            FROM "page" m
           WHERE m."archive_root_id" IN (SELECT "id" FROM roots)
           GROUP BY m."archive_root_id"
        ) s ON s."archive_root_id" = r."id"
       ORDER BY r."archived_at" DESC, r."id" DESC
    `;
    const served = rows.slice(0, limit);
    const last = served[served.length - 1];
    return {
      rows: served,
      nextCursor:
        rows.length > limit && last
          ? encodeArchivedRootsCursor({ archivedAt: last.archivedAt, id: last.id })
          : null,
    };
  },

  async insert(data: PageCreateInput, tx: Prisma.TransactionClient): Promise<PageRecord> {
    return tx.page.create({ data, select: PAGE_RECORD_SELECT });
  },

  /** Write the state, the three formats, the revision and the stamp in ONE `UPDATE`. */
  async updateBody(id: string, write: PageBodyUpdate, tx: Prisma.TransactionClient): Promise<void> {
    await tx.page.update({ where: { id }, data: write, select: { id: true } });
  },

  /** Rename. `null` when the page is absent or invisible (Prisma's `P2025`). */
  async updateTitle(
    id: string,
    title: string,
    actorId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageRecord | null> {
    try {
      return await tx.page.update({
        where: { id },
        data: { title, updatedById: actorId },
        select: PAGE_RECORD_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return null;
      throw err;
    }
  },
};

/**
 * Escape LIKE metacharacters so a title search matches `%` and `_` LITERALLY —
 * Prisma's `contains` passes the value into the pattern unescaped. Backslash is
 * Postgres's default LIKE escape (the `workItemRepository` helper's rule).
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
