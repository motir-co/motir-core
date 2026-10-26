import type { Page, PageVersion } from '@/generated/prisma/client';
import type {
  PageArchivedListItemDto,
  PageArchivedRootDto,
  PageDto,
  PageListItemDto,
  PageMarkdownDto,
  PageMoveResultDto,
  PageParentDto,
  PageTrailDto,
  PageTreeRowDto,
  PageMentionCandidateDto,
  PageSearchHitDto,
  PageRefSummaryDto,
  PageVersionDto,
  PageVersionListItemDto,
} from '@/lib/dto/pages';
import type { FolderTreeRow } from '@/lib/mappers/folderMappers';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { LockedPageRow, PageRow, PageVersionRow, PageVersionWithBody } from '@/lib/pages';

// Page rows ↔ `@motir/pages`' port rows (Story MOTIR-5752 · MOTIR-7276).
//
// The package speaks `Uint8Array` and plain rows; Prisma speaks its `Page`
// model and, for the raw `FOR UPDATE` read, the column names `$queryRaw`
// returns. These two functions are the whole translation, so the adapter only
// maps and the repository only queries.

/**
 * A page read without its body — every column the port's `PageRow` carries,
 * the archive columns (MOTIR-7417) included: every procedure that writes a page
 * refuses an archived one (MOTIR-7418), so every row read must carry them.
 */
export type PageRecord = Omit<Page, 'bodyState' | 'bodyJson' | 'bodyMarkdown' | 'bodyText'>;

/** The raw `SELECT … FOR UPDATE` row `pageRepository.lockById` returns. */
export interface PageLockedRecord extends PageRecord {
  bodyState: Uint8Array;
}

/**
 * The read model's row (`pageRepository.findWithBodyById`): the Yjs state the
 * editor mounts, plus the derived ProseMirror JSON the work-item chips are read
 * from (MOTIR-7572). The JSON is opaque here; `extractLinks` walks it.
 */
export interface PageReadRecord extends PageLockedRecord {
  bodyJson: unknown;
}

/** A page read with its derived markdown and no Yjs state (MOTIR-7409). */
export interface PageMarkdownRecord extends PageRecord {
  bodyMarkdown: string;
}

/**
 * The columns `findById` selects — everything but the body, which a plain read
 * never needs and which is up to 2 MiB.
 */
export const PAGE_RECORD_SELECT = {
  id: true,
  workspaceId: true,
  projectId: true,
  title: true,
  parentPageId: true,
  folderId: true,
  position: true,
  ancestorPageIds: true,
  revision: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  archiveRootId: true,
  archivedById: true,
} as const;

export function toPageRow(record: PageRecord): PageRow {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    title: record.title,
    parentPageId: record.parentPageId,
    folderId: record.folderId,
    position: record.position,
    ancestorPageIds: [...record.ancestorPageIds],
    revision: record.revision,
    createdById: record.createdById,
    updatedById: record.updatedById,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
    archiveRootId: record.archiveRootId,
    archivedById: record.archivedById,
  };
}

/** The locked row, its `bytea` body as a plain `Uint8Array` (pg hands back a `Buffer`). */
export function toLockedPageRow(record: PageLockedRecord): LockedPageRow {
  return { ...toPageRow(record), bodyState: toBytes(record.bodyState) };
}

/** A `bytea` column as a plain `Uint8Array` (pg hands back a `Buffer`). */
function toBytes(body: Uint8Array): Uint8Array {
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

// ── Versions (Story MOTIR-5754 · MOTIR-7384) ─────────────────────────────────

/** A version read without its snapshot — every column `PageVersionRow` carries. */
export type PageVersionRecord = Omit<
  PageVersion,
  'workspaceId' | 'projectId' | 'bodyState' | 'bodyMarkdown'
>;

/** A version read with its snapshot, as a restore reads it. */
export interface PageVersionBodyRecord extends PageVersionRecord {
  bodyState: Uint8Array;
  bodyMarkdown: string;
}

/** The columns a version read selects — everything but the 2 MiB snapshot. */
export const PAGE_VERSION_RECORD_SELECT = {
  id: true,
  pageId: true,
  number: true,
  authorId: true,
  startedAt: true,
  savedAt: true,
  restoredFromVersionId: true,
  restoredFromNumber: true,
  sealedAt: true,
  frozenAt: true,
  frozenByGateId: true,
} as const;

export function toPageVersionRow(record: PageVersionRecord): PageVersionRow {
  return {
    id: record.id,
    pageId: record.pageId,
    number: record.number,
    authorId: record.authorId,
    startedAt: record.startedAt,
    savedAt: record.savedAt,
    restoredFromVersionId: record.restoredFromVersionId,
    restoredFromNumber: record.restoredFromNumber,
    sealedAt: record.sealedAt,
    frozenAt: record.frozenAt,
  };
}

export function toPageVersionWithBody(record: PageVersionBodyRecord): PageVersionWithBody {
  return {
    ...toPageVersionRow(record),
    bodyState: toBytes(record.bodyState),
    bodyMarkdown: record.bodyMarkdown,
  };
}

/** A state as base64 — the wire shape every `bodyState` DTO field uses. */
export function toBase64(state: Uint8Array): string {
  return Buffer.from(state.buffer, state.byteOffset, state.byteLength).toString('base64');
}

/**
 * One history row (MOTIR-7385). `isCurrent` is the caller's: whether this is the
 * page's newest number. `restoredFromKept` reads the FK, which the cap's prune
 * sets to NULL while `restoredFromNumber` stays.
 */
export function toPageVersionListItemDto(
  row: PageVersionRow,
  authorName: string | undefined,
  isCurrent: boolean,
): PageVersionListItemDto {
  return {
    number: row.number,
    authorId: row.authorId,
    authorName: authorName ?? '',
    startedAt: row.startedAt.toISOString(),
    savedAt: row.savedAt.toISOString(),
    restoredFromNumber: row.restoredFromNumber,
    restoredFromKept: row.restoredFromVersionId !== null,
    isCurrent,
  };
}

/** One version with its snapshot (MOTIR-7385). */
export function toPageVersionDto(
  row: PageVersionWithBody,
  authorName: string | undefined,
  isCurrent: boolean,
  workItemRefs: WorkItemRefMap = {},
): PageVersionDto {
  return {
    ...toPageVersionListItemDto(row, authorName, isCurrent),
    bodyState: toBase64(row.bodyState),
    workItemRefs,
  };
}

/**
 * The raw row `pageRepository.findLevelAfter` returns (MOTIR-7369): one page of
 * a tree level, no body, with whether it holds any sub-page.
 */
export interface PageLevelRecord {
  id: string;
  title: string;
  position: string;
  updatedAt: Date;
  hasChildren: boolean;
}

/**
 * One page of a `/pages` tree level, as the page service composes the level
 * (MOTIR-7370): what the row renders, and the `(position, id)` the keyset cursor
 * pages on.
 */
export interface PageLevelRow {
  readonly id: string;
  readonly title: string;
  readonly position: string;
  readonly updatedAt: Date;
  readonly hasChildren: boolean;
}

export function toPageLevelRow(record: PageLevelRecord): PageLevelRow {
  return {
    id: record.id,
    title: record.title,
    position: record.position,
    updatedAt: record.updatedAt,
    hasChildren: Boolean(record.hasChildren),
  };
}

/**
 * The page as the read model returns it (MOTIR-7277): the canonical state as
 * base64 — the editor's seed, from which it derives everything else — and
 * whether THIS caller may write it. `caps` is the caller's ROLE: an archived
 * page is never editable and only its root restores, whatever the role
 * (MOTIR-7421), and this is where that is decided. Its archive state rides
 * along: `archivedBy` is `null` on a live page, and on an archived one whose
 * archiver was deleted (`archived_by_id` is `SET NULL`). `names` carries the
 * caller's resolved archiver name and archive root title, `''` when unresolved.
 */
export function toPageDto(
  row: LockedPageRow,
  caps: { canEdit: boolean; canDelete: boolean },
  names: { archiver?: string; archiveRootTitle?: string } = {},
  workItemRefs: WorkItemRefMap = {},
): PageDto {
  const archived = row.archivedAt !== null;
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    revision: row.revision,
    bodyState: toBase64(row.bodyState),
    updatedAt: row.updatedAt.toISOString(),
    canEdit: caps.canEdit && !archived,
    canDelete: caps.canDelete,
    canRestore: caps.canEdit && archived && row.archiveRootId === row.id,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archiveRoot:
      row.archiveRootId === null
        ? null
        : {
            id: row.archiveRootId,
            title: row.archiveRootId === row.id ? row.title : (names.archiveRootTitle ?? ''),
          },
    archivedBy:
      row.archivedById === null ? null : { id: row.archivedById, name: names.archiver ?? '' },
    workItemRefs,
  };
}

// ── The archive (Story MOTIR-5755 · MOTIR-7420) ────────────────────────────

/**
 * The raw row `pageRepository.listArchivedRoots` returns: one archive ROOT, its
 * sub-page count (its set minus itself) and the placement it was archived from.
 */
export interface PageArchivedRootRecord {
  id: string;
  title: string;
  archivedAt: Date;
  archivedById: string | null;
  subPageCount: number;
  parentPageId: string | null;
  folderId: string | null;
  ancestorPageIds: string[];
}

/** One Archived pages row; `archiverName` is the caller's resolved display name. */
export function toPageArchivedRootDto(
  record: PageArchivedRootRecord,
  archiverName: string | undefined,
): PageArchivedRootDto {
  return {
    id: record.id,
    title: record.title,
    archivedAt: record.archivedAt.toISOString(),
    archivedBy:
      record.archivedById === null ? null : { id: record.archivedById, name: archiverName ?? '' },
    subPageCount: Number(record.subPageCount),
    parent: toPageParentDto(record),
    ancestorPageIds: [...record.ancestorPageIds],
  };
}

/**
 * One `/pages` index row (MOTIR-7300): the page and the display name of whoever
 * edited it last, resolved by the service from `updatedById`. `updated_by_id`
 * is a `Restrict` foreign key, so the editor always exists; `''` only covers a
 * user row the batch read did not return.
 */
export function toPageListItemDto(
  record: Pick<Page, 'id' | 'title' | 'updatedAt' | 'updatedById'>,
  editorName: string | undefined,
): PageListItemDto {
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt.toISOString(),
    updatedBy: { id: record.updatedById, name: editorName ?? '' },
  };
}

// ── The page tree (Story MOTIR-5753 · MOTIR-7370) ──────────────────────────

/** A folder of a `/pages` tree level (`folderRepository.findLevelForPages`) → wire row. */
export function toPageTreeFolderRowDto(row: FolderTreeRow): PageTreeRowDto {
  return { kind: 'folder', id: row.id, name: row.name, hasChildren: Boolean(row.hasChildren) };
}

/** A page of a `/pages` tree level → wire row. */
export function toPageTreePageRowDto(row: PageLevelRow): PageTreeRowDto {
  return { kind: 'page', id: row.id, title: row.title, hasChildren: row.hasChildren };
}

/** A page's parent from its two placement columns (`page_parent_xor_folder`: at most one is set). */
export function toPageParentDto(row: Pick<PageRow, 'parentPageId' | 'folderId'>): PageParentDto {
  if (row.parentPageId !== null) return { kind: 'page', id: row.parentPageId };
  if (row.folderId !== null) return { kind: 'folder', id: row.folderId };
  return { kind: 'root' };
}

/** Where a move left the page. */
export function toPageMoveResultDto(row: PageRow, moved: boolean): PageMoveResultDto {
  return {
    id: row.id,
    parent: toPageParentDto(row),
    position: row.position,
    ancestorPageIds: [...row.ancestorPageIds],
    moved,
  };
}

/** A page's breadcrumb: its folder chain and its ancestor pages, each root-first. */
export function toPageTrailDto(
  folders: ReadonlyArray<{ id: string; name: string }>,
  pages: ReadonlyArray<{ id: string; title: string }>,
): PageTrailDto {
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    pages: pages.map((p) => ({ id: p.id, title: p.title })),
  };
}

/**
 * One Archived pages row with its came-from trail (MOTIR-7421). `ancestorTitles`
 * names the stored ancestor pages that still exist, archived ones included; an
 * ancestor deleted since is kept in place as an em dash, so the trail keeps its
 * shape. `folders` is the chain the topmost page was filed in, root-first.
 * `archivedAncestors` names the ancestors that are archived themselves.
 */
export function toPageArchivedListItemDto(
  record: PageArchivedRootRecord,
  archiverName: string | undefined,
  ancestorTitles: ReadonlyMap<string, string>,
  folders: ReadonlyArray<{ id: string; name: string }>,
  archivedAncestors: ReadonlySet<string> = new Set(),
): PageArchivedListItemDto {
  return {
    ...toPageArchivedRootDto(record, archiverName),
    cameFrom: toPageTrailDto(
      folders,
      record.ancestorPageIds.map((id) => ({ id, title: ancestorTitles.get(id) ?? '\u2014' })),
    ),
    archivedAncestorIds: record.ancestorPageIds.filter((id) => archivedAncestors.has(id)),
  };
}

// ── The markdown doors (Story MOTIR-5760 · MOTIR-7409) ───────────────────────

/**
 * A page as an agent reads it: the markdown column, where it is filed, the
 * revision to write against and its newest version with the author's name the
 * service resolved in one batch.
 */
/**
 * The page as an agent reads it AT one version (MOTIR-7429): the page's own
 * fields from `page`, the body from that version, and the version's marks.
 */
export function toPageMarkdownAtVersionDto(
  page: PageMarkdownDto,
  version: PageVersionBodyRecord,
  authorName: string | undefined,
): PageMarkdownDto {
  return {
    ...page,
    markdown: version.bodyMarkdown,
    version: {
      number: version.number,
      authorId: version.authorId,
      authorName: authorName ?? '',
      savedAt: version.savedAt.toISOString(),
      sealed: version.sealedAt !== null,
      frozen: version.frozenAt !== null,
    },
  };
}

export function toPageMarkdownDto(
  record: PageMarkdownRecord,
  latest: PageVersionRecord | null,
  authorName: string | undefined,
): PageMarkdownDto {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    placement: { parentPageId: record.parentPageId, folderId: record.folderId },
    revision: record.revision,
    latestVersion: latest
      ? {
          number: latest.number,
          authorId: latest.authorId,
          authorName: authorName ?? '',
          savedAt: latest.savedAt.toISOString(),
        }
      : null,
    markdown: record.bodyMarkdown,
    updatedAt: record.updatedAt.toISOString(),
    archivedAt: record.archivedAt?.toISOString() ?? null,
  };
}

/** A live page as the `@` picker's Pages section lists it (MOTIR-7697). */
export function toPageMentionCandidateDto(
  row: { id: string; title: string },
  folderPath: string[],
  parentPageTitle: string | null,
): PageMentionCandidateDto {
  return { id: row.id, title: row.title, place: { folderPath, parentPageTitle } };
}

/** A full-text search hit (MOTIR-9551): the candidate with its place, plus snippet and rank. */
export function toPageSearchHitDto(
  candidate: PageMentionCandidateDto,
  row: { snippet: string; rank: number },
): PageSearchHitDto {
  return { ...candidate, snippet: row.snippet, rank: row.rank };
}

/**
 * A page chip's summary (MOTIR-7697). Only a LIVE page is `available`; the
 * unavailable shape is built without the title, never by deleting it.
 */
export function toPageRefSummaryDto(
  id: string,
  row: { title: string; archivedAt: Date | null } | undefined,
): PageRefSummaryDto {
  if (!row || row.archivedAt !== null) return { state: 'unavailable', id };
  return { state: 'available', id, title: row.title };
}
