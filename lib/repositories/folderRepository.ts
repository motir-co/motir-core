import { Prisma, type Folder } from '@/generated/prisma/client';
import {
  CrossProjectFolderError,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
} from '@/lib/folders/errors';
import type {
  FolderDirectCountRow,
  FolderTrailRow,
  FolderTreeRow,
  ProjectFolderRow,
} from '@/lib/mappers/folderMappers';

// Folder repository — single operations on the `folder` table (Epic MOTIR-5307
// · Story MOTIR-5308 · MOTIR-5313). The persistence leaf under `foldersService`,
// which owns the transactions, the `work_item:edit` gate, the name rule, the
// cycle rule, the fractional-index arithmetic and the DTO mapping.
//
// ⚠️ EVERY READ HERE TAKES A REQUIRED `tx`, not the usual "read-only paths may
// use the singleton" arm. `folder` carries the `work_item` policy pair and NO
// system or public arm, so an UNBOUND read returns nothing and raises nothing —
// a project's folders would render as a project with none. Making the binding a
// type error is what keeps that silent failure out (the
// `workItemTodoRepository` reasoning, for the same shape of table).
//
// Write errors translate here, at the edge, so the service never inspects a
// Postgres code (the 4-layer rule): the sibling-name unique index's `P2002`, the
// migration's `FOLDER_PARENT_CROSS_*` / `FOLDER_PARENT_CYCLE` trigger markers,
// and `P2025` for a row that vanished.

/** `Folder` scalars the service creates a row from. */
export type FolderCreateInput = Prisma.FolderUncheckedCreateInput;

function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

function translateFolderWriteError(
  err: unknown,
  ctx: { id?: string; name?: string | null },
): never {
  const text = errorText(err);
  if (
    text.includes('FOLDER_PARENT_CROSS_WORKSPACE') ||
    text.includes('FOLDER_PARENT_CROSS_PROJECT')
  ) {
    throw new CrossProjectFolderError(text);
  }
  if (text.includes('FOLDER_PARENT_CYCLE')) throw new FolderCycleError(text);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') throw new FolderNameTakenError(ctx.name ?? null);
    if (err.code === 'P2025') throw new FolderNotFoundError(ctx.id ?? '(unknown)');
  }
  throw err;
}

export const folderRepository = {
  /**
   * Serialize every STRUCTURAL change to one project's folder tree — a move or
   * a delete — for the length of the caller's transaction.
   *
   * ⚠️ WHY NOT ROW LOCKS. A cycle is a property of a CHAIN, not of a row. Two
   * moves that share no row can still close one: "A into C" (C under B) and
   * "B into E" (E under A) lock {A, C} and {B, E}, each reads the other's chain
   * before it commits, and both commit. Locking every ancestor instead works
   * only if the chain read before the locks is still the chain after them. A
   * transaction-scoped advisory lock keyed on the PROJECT closes it outright:
   * folder moves are rare, human-paced writes, and serializing them per project
   * costs nothing a person could notice.
   *
   * Taken BEFORE any folder row lock, on every path that takes both, so the
   * order is always the same and the two cannot deadlock.
   */
  async lockStructure(projectId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`folder-structure:${projectId}`}, 0))`;
  },

  /** Lock one folder row. `null` when it does not exist or is not visible. */
  async lockById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; projectId: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; projectId: string }>>`
      SELECT "id", "project_id" AS "projectId" FROM "folder" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async findById(id: string, tx: Prisma.TransactionClient): Promise<Folder | null> {
    return tx.folder.findUnique({ where: { id } });
  },

  /**
   * A project's ROOT folder with this name, ignoring case — the Bugs room's LABEL
   * match for "this project's Bugs folder" (Story MOTIR-4927 · MOTIR-4938). For
   * DISPLAY only: nothing resolves a bug destination by a folder's name
   * (`lib/projects/bugDestination.ts`). Root sibling names are unique ignoring
   * case, so there is at most one.
   */
  async findRootByName(
    projectId: string,
    workspaceId: string,
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<Folder | null> {
    return tx.folder.findFirst({
      where: {
        projectId,
        workspaceId,
        parentFolderId: null,
        name: { equals: name, mode: 'insensitive' },
      },
    });
  },

  async findByIds(ids: string[], tx: Prisma.TransactionClient): Promise<Folder[]> {
    if (ids.length === 0) return [];
    return tx.folder.findMany({ where: { id: { in: ids } } });
  },

  /**
   * The placement state of the folders a plan's `folder:<id>` refs name
   * (MOTIR-5414) — id, project and name, workspace-scoped explicitly so the
   * answer does not rest on the connection's RLS role. The caller lifts the
   * project narrowing, so a folder in another project comes back to be refused
   * for the right reason rather than read as missing.
   */
  async findPlacementStateByIds(
    ids: string[],
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; projectId: string; name: string }>> {
    if (ids.length === 0) return [];
    return tx.folder.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, projectId: true, name: true },
    });
  },

  /**
   * A sibling folder already holding `name`, case-insensitively — the same
   * predicate the `folder_sibling_name_key` expression index enforces, so the
   * friendly check and the race backstop can never disagree about what a
   * collision is. `excludeId` leaves a folder out of its own comparison (a
   * rename that only changes case).
   */
  async findSiblingNameConflict(
    args: {
      projectId: string;
      parentFolderId: string | null;
      name: string;
      excludeId?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "folder"
       WHERE "project_id" = ${args.projectId}
         AND COALESCE("parent_folder_id", '') = ${args.parentFolderId ?? ''}
         AND lower("name") = lower(${args.name})
         AND "id" <> ${args.excludeId ?? ''}
       LIMIT 1
    `;
    return rows[0]?.id ?? null;
  },

  /**
   * The project's ROOT-level folders whose lowercased name is one of `names`
   * (already lowercased by the caller), oldest first. The same `lower(name)`
   * predicate as `findSiblingNameConflict` and the `folder_sibling_name_key` index, so
   * a lookup and a refused create can never disagree about what a match is.
   */
  async findRootByNames(
    projectId: string,
    names: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; name: string }>> {
    if (names.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT "id", "name" FROM "folder"
       WHERE "project_id" = ${projectId}
         AND "parent_folder_id" IS NULL
         AND lower("name") IN (${Prisma.join(names)})
       ORDER BY "created_at" ASC, "id" ASC
    `;
  },

  /** The last position among a level's folders, or `null` when it has none. */
  async lastSiblingPosition(
    projectId: string,
    parentFolderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.folder.findFirst({
      where: { projectId, parentFolderId },
      orderBy: [{ position: 'desc' }, { id: 'desc' }],
      select: { position: true },
    });
    return row?.position ?? null;
  },

  /**
   * One LAZY tree level's FOLDERS (Story MOTIR-5308 · MOTIR-5314) — the
   * project's root folders, or one folder's child folders — by `position`, then
   * `name`, then `id`, so the order is total and paging never skips or repeats.
   * Folders ignore the tree's column sort: they are pinned above the level's
   * work items, as in every file manager.
   *
   * `hasChildren` is TRUE for a child folder or for a filed work item that is
   * neither archived nor in triage — the same exclusions the work-item level
   * applies (`notInTriageSql` in `workItemRepository`), so an archived item
   * alone never draws a chevron onto an empty folder.
   *
   * The explicit `workspace_id` + `project_id` gate is the tree reads' own
   * (RLS is inert under the dev/CI superuser).
   */
  async findLevel(
    projectId: string,
    workspaceId: string,
    parentFolderId: string | null,
    page: { take: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<FolderTreeRow[]> {
    const parentPred =
      parentFolderId === null
        ? Prisma.sql`f."parent_folder_id" IS NULL`
        : Prisma.sql`f."parent_folder_id" = ${parentFolderId}`;
    return tx.$queryRaw<FolderTreeRow[]>`
      SELECT f."id",
             f."parent_folder_id" AS "parentFolderId",
             f."name",
             f."position",
             (
               EXISTS (SELECT 1 FROM "folder" c WHERE c."parent_folder_id" = f."id")
               OR EXISTS (
                 SELECT 1 FROM "work_item" w
                  WHERE w."folderId" = f."id"
                    AND w."archivedAt" IS NULL
                    AND w."triagedAt" IS NULL
               )
             ) AS "hasChildren"
        FROM "folder" f
       WHERE f."project_id" = ${projectId}
         AND f."workspace_id" = ${workspaceId}
         AND ${parentPred}
       ORDER BY f."position" ASC, f."name" ASC, f."id" ASC
       LIMIT ${page.take} OFFSET ${page.offset}`;
  },

  /**
   * One KEYSET page of a level's folders (Story MOTIR-5310 · MOTIR-5408) — the
   * `/api/v1` folder list. Ordered by `(position, id)`, a TOTAL order, and seeks
   * strictly after `after`, so a folder created or moved between two pages never
   * shifts a page boundary the way `findLevel`'s offset would. Reads `take` rows;
   * the caller asks for one more than it serves to learn whether a page follows.
   *
   * The same explicit `workspace_id` + `project_id` gate as `findLevel`.
   */
  async findLevelAfter(
    projectId: string,
    workspaceId: string,
    parentFolderId: string | null,
    after: { position: string; id: string } | undefined,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<Folder[]> {
    const parentPred =
      parentFolderId === null
        ? Prisma.sql`"parent_folder_id" IS NULL`
        : Prisma.sql`"parent_folder_id" = ${parentFolderId}`;
    const seek = after
      ? Prisma.sql`AND ("position", "id") > (${after.position}, ${after.id})`
      : Prisma.empty;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "folder"
       WHERE "project_id" = ${projectId}
         AND "workspace_id" = ${workspaceId}
         AND ${parentPred}
         ${seek}
       ORDER BY "position" ASC, "id" ASC
       LIMIT ${take}`;
    if (rows.length === 0) return [];
    const byId = new Map(
      (await tx.folder.findMany({ where: { id: { in: rows.map((r) => r.id) } } })).map((f) => [
        f.id,
        f,
      ]),
    );
    return rows.flatMap((r) => {
      const folder = byId.get(r.id);
      return folder ? [folder] : [];
    });
  },

  /**
   * One KEYSET page of a level's folders for the `/pages` tree (Story MOTIR-5753
   * · MOTIR-7371) — the project's root folders, or one folder's child folders.
   * Ordered by `(position, id)` in `COLLATE "C"` (the order fractional keys are
   * minted in, and the page level's own order), seeking strictly after `after`;
   * reads `limit` rows, so the caller asks for one more than it serves.
   *
   * ⚠️ `hasChildren` here is a CHILD FOLDER or a LIVE PAGE FILED in the folder —
   * what the `/pages` tree can expand into; an archived page is in no level
   * (MOTIR-7420). Work items do not count: `/pages` shows
   * none. `findLevel` keeps the `/items` predicate (child folder or work item),
   * so a folder holding only pages shows no expander in `/items`, which shows no
   * pages (`docs/decisions/pages.md` AMENDMENT 1).
   *
   * Gated on `project_id` explicitly (RLS is inert under the dev/CI superuser).
   */
  async findLevelForPages(
    projectId: string,
    parentFolderId: string | null,
    after: { position: string; id: string } | null,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<FolderTreeRow[]> {
    const parentPred =
      parentFolderId === null
        ? Prisma.sql`f."parent_folder_id" IS NULL`
        : Prisma.sql`f."parent_folder_id" = ${parentFolderId}`;
    const seek = after
      ? Prisma.sql`AND (f."position" COLLATE "C", f."id" COLLATE "C") > (${after.position}, ${after.id})`
      : Prisma.empty;
    return tx.$queryRaw<FolderTreeRow[]>`
      SELECT f."id",
             f."parent_folder_id" AS "parentFolderId",
             f."name",
             f."position",
             (
               EXISTS (SELECT 1 FROM "folder" c WHERE c."parent_folder_id" = f."id")
               OR EXISTS (SELECT 1 FROM "page" p
                           WHERE p."folder_id" = f."id" AND p."archived_at" IS NULL)
             ) AS "hasChildren"
        FROM "folder" f
       WHERE f."project_id" = ${projectId}
         AND ${parentPred}
         ${seek}
       ORDER BY f."position" COLLATE "C" ASC, f."id" COLLATE "C" ASC
       LIMIT ${limit}`;
  },

  /** The FULL folder count of one lazy tree level — the predicate `findLevel` reads. */
  async countLevel(
    projectId: string,
    workspaceId: string,
    parentFolderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const parentPred =
      parentFolderId === null
        ? Prisma.sql`f."parent_folder_id" IS NULL`
        : Prisma.sql`f."parent_folder_id" = ${parentFolderId}`;
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
        FROM "folder" f
       WHERE f."project_id" = ${projectId}
         AND f."workspace_id" = ${workspaceId}
         AND ${parentPred}`;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * EVERY folder of a project, for the folder picker (Story MOTIR-5308 ·
   * MOTIR-5343), reading at most `limit + 1` rows so the caller can tell a
   * truncated list from a complete one.
   *
   * ⚠️ ORDERED BY DEPTH FIRST, then `position` / `name` / `id`. The picker shows
   * each folder by its PATH, so a folder whose ancestor was cut off by the limit
   * could not be named. Reading shallow levels before deep ones makes every
   * returned folder's ancestors part of the same page: a truncated list loses
   * whole leaves, never a link in a chain.
   */
  async findProjectFolders(
    projectId: string,
    workspaceId: string,
    page: { limit: number },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectFolderRow[]> {
    return tx.$queryRaw<ProjectFolderRow[]>`
      WITH RECURSIVE tree AS (
        SELECT f."id", f."parent_folder_id", f."name", f."position", 0 AS depth
          FROM "folder" f
         WHERE f."project_id" = ${projectId}
           AND f."workspace_id" = ${workspaceId}
           AND f."parent_folder_id" IS NULL
        UNION ALL
        SELECT f."id", f."parent_folder_id", f."name", f."position", t.depth + 1
          FROM "folder" f
          JOIN tree t ON f."parent_folder_id" = t."id"
         WHERE t.depth < 1000
      )
      SELECT "id", "parent_folder_id" AS "parentFolderId", "name", "position"
        FROM tree
       ORDER BY depth ASC, "position" ASC, "name" ASC, "id" ASC
       LIMIT ${page.limit + 1}`;
  },

  /**
   * The NAMES of `folderId` and every folder above it, ROOT FIRST — the path the
   * quick view shows a filed work item under ("Later ▸ 2025") (MOTIR-5352). One
   * recursive read, bounded like the cycle backstop.
   */
  async findPathNames(folderId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ name: string }>>`
      WITH RECURSIVE chain AS (
        SELECT f."id", f."parent_folder_id", f."name", 0 AS depth
          FROM "folder" f
         WHERE f."id" = ${folderId}
        UNION ALL
        SELECT f."id", f."parent_folder_id", f."name", c.depth + 1
          FROM "folder" f
          JOIN chain c ON f."id" = c."parent_folder_id"
         WHERE c.depth < 1000
      )
      SELECT "name" FROM chain ORDER BY depth DESC`;
    return rows.map((r) => r.name);
  },

  /**
   * The PATH of every folder in `ids`, ROOT FIRST, in ONE recursive read — the
   * batched twin of {@link findPathNames} for a read model that places many
   * rows at once (a plan's folder placements, MOTIR-5415). Workspace-scoped
   * explicitly; the project comes back so the caller can refuse a folder in
   * another project rather than name it. An id that no longer exists simply
   * does not come back.
   */
  async findPathsByIds(
    ids: string[],
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; projectId: string; path: string[] }>> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string; projectId: string; path: string[] }>>`
      WITH RECURSIVE chain AS (
        SELECT f."id" AS "leaf_id", f."project_id" AS "leaf_project_id",
               f."parent_folder_id", f."name", 0 AS depth
          FROM "folder" f
         WHERE f."id" = ANY(${ids}::text[])
           AND f."workspace_id" = ${workspaceId}
        UNION ALL
        SELECT c."leaf_id", c."leaf_project_id", f."parent_folder_id", f."name", c.depth + 1
          FROM "folder" f
          JOIN chain c ON f."id" = c."parent_folder_id"
         WHERE c.depth < 1000
      )
      SELECT "leaf_id" AS "id", "leaf_project_id" AS "projectId",
             array_agg("name" ORDER BY depth DESC) AS "path"
        FROM chain
       GROUP BY "leaf_id", "leaf_project_id"`;
  },

  /**
   * The TRAIL of every folder in `ids`, ROOT FIRST, each step carrying its id AS
   * WELL AS its name (Bug MOTIR-5782 · MOTIR-5798) — the id-carrying twin of
   * {@link findPathsByIds}, and the same one recursive read. A trail is what a
   * canvas needs to make each folder a LEVEL: a crumb that navigates is addressed
   * by id, and so is a `folder:<id>` level key for an ancestor folder. The path
   * of names is `trail.map((t) => t.name)`, so a caller reading both takes one
   * query, not two. An id that no longer exists simply does not come back.
   */
  async findTrailsByIds(
    ids: string[],
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FolderTrailRow[]> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<FolderTrailRow[]>`
      WITH RECURSIVE chain AS (
        SELECT f."id" AS "leaf_id", f."project_id" AS "leaf_project_id",
               f."id" AS "node_id", f."parent_folder_id", f."name", 0 AS depth
          FROM "folder" f
         WHERE f."id" = ANY(${ids}::text[])
           AND f."workspace_id" = ${workspaceId}
        UNION ALL
        SELECT c."leaf_id", c."leaf_project_id", f."id", f."parent_folder_id", f."name",
               c.depth + 1
          FROM "folder" f
          JOIN chain c ON f."id" = c."parent_folder_id"
         WHERE c.depth < 1000
      )
      SELECT "leaf_id" AS "id", "leaf_project_id" AS "projectId",
             json_agg(json_build_object('id', "node_id", 'name', "name") ORDER BY depth DESC)
               AS "trail"
        FROM chain
       GROUP BY "leaf_id", "leaf_project_id"`;
  },

  /**
   * The DIRECT contents of each folder in `folderIds` (Bug MOTIR-5710 ·
   * MOTIR-5738) — how many child folders it holds and how many work items are
   * filed straight into it — for the roadmap's folder card.
   *
   * ONE query for the whole level, however many folders it holds: the card's
   * count must never be computed by loading each folder's contents. The item
   * count applies the level's own exclusions (not archived, not in triage), the
   * same predicate `findLevel`'s `hasChildren` probe uses, so a folder holding
   * only archived work reads `Empty` rather than a number the reader cannot open.
   * Direct, never recursive: a filed epic counts once however many stories it
   * holds (`design/roadmap/design-notes.md` decision 3).
   *
   * `pageCount` (MOTIR-7371) is the LIVE pages filed straight into the folder —
   * its top-level pages; a sub-page carries no folder and follows its page, and
   * an archived page is in no level (MOTIR-7420), so a folder holding only
   * archived pages reads as empty. The
   * roadmap card reads only the first two counts: `/items` and the roadmap show
   * no pages.
   */
  async countDirectContents(
    folderIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<FolderDirectCountRow[]> {
    if (folderIds.length === 0) return [];
    return tx.$queryRaw<FolderDirectCountRow[]>`
      SELECT f."id",
             (SELECT COUNT(*)::int FROM "folder" c
               WHERE c."parent_folder_id" = f."id") AS "childFolderCount",
             (SELECT COUNT(*)::int FROM "work_item" w
               WHERE w."folderId" = f."id"
                 AND w."archivedAt" IS NULL
                 AND w."triagedAt" IS NULL) AS "itemCount",
             (SELECT COUNT(*)::int FROM "page" p
               WHERE p."folder_id" = f."id"
                 AND p."archived_at" IS NULL) AS "pageCount"
        FROM "folder" f
       WHERE f."id" IN (${Prisma.join([...folderIds])})`;
  },

  /** How many folders sit directly inside `folderId` — the set `deleteFolder` moves. */
  async countChildFolders(folderId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.folder.count({ where: { parentFolderId: folderId } });
  },

  /** A folder's direct child folders, in display order. */
  async findChildFolders(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Folder, 'id' | 'name' | 'position'>>> {
    return tx.folder.findMany({
      where: { parentFolderId: folderId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, position: true },
    });
  },

  /**
   * `folderId` and every folder above it, walking `parent_folder_id` to the
   * root. The cycle check asks whether a move's target is, or sits inside, the
   * folder being moved. Bounded like the database's own cycle backstop.
   */
  async findAncestorIds(folderId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE chain AS (
        SELECT f."id", f."parent_folder_id", 1 AS lvl
          FROM "folder" f
         WHERE f."id" = ${folderId}
        UNION ALL
        SELECT f."id", f."parent_folder_id", c.lvl + 1
          FROM "folder" f
          JOIN chain c ON f."id" = c."parent_folder_id"
         WHERE c.lvl < 1000
      )
      SELECT "id" FROM chain
    `;
    return rows.map((r) => r.id);
  },

  async create(data: FolderCreateInput, tx: Prisma.TransactionClient): Promise<Folder> {
    try {
      return await tx.folder.create({ data });
    } catch (err) {
      throw translateFolderWriteError(err, { name: data.name });
    }
  },

  async rename(id: string, name: string, tx: Prisma.TransactionClient): Promise<Folder> {
    try {
      return await tx.folder.update({ where: { id }, data: { name } });
    } catch (err) {
      throw translateFolderWriteError(err, { id, name });
    }
  },

  /** Set a folder's parent and position — a move, a reorder, or both. */
  async move(
    id: string,
    patch: { parentFolderId: string | null; position: string },
    tx: Prisma.TransactionClient,
  ): Promise<Folder> {
    try {
      return await tx.folder.update({ where: { id }, data: patch });
    } catch (err) {
      throw translateFolderWriteError(err, { id });
    }
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<Folder> {
    try {
      return await tx.folder.delete({ where: { id } });
    } catch (err) {
      throw translateFolderWriteError(err, { id });
    }
  },
};
