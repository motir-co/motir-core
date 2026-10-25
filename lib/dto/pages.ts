// Page DTOs (Story MOTIR-5752 · MOTIR-7277) — what crosses the service boundary
// for a project's pages. `docs/decisions/pages.md` §3: the canonical body is the
// Yjs state, so the read model hands the editor THAT, and every other format is
// derived from it on the far side.

import type { WorkItemRefMap } from '@/lib/dto/workItems';

/** One page, as `pagesService.getPage` returns it. */
export interface PageDto {
  id: string;
  projectId: string;
  title: string;
  /** Advances by one on every save; the editor's staleness signal. */
  revision: number;
  /** The canonical Yjs state (`Y.encodeStateAsUpdate`), base64-encoded. */
  bodyState: string;
  /** ISO-8601. */
  updatedAt: string;
  /**
   * Whether the caller may write THIS page — `page:edit`, and the page is live.
   * An archived page is read-only whatever the role (MOTIR-7421), so the editor
   * host mounts read-only.
   */
  canEdit: boolean;
  /**
   * Whether the caller holds `page:delete` (MOTIR-7419) — Manager only — so the
   * page can hide Delete… without a second round trip.
   */
  canDelete: boolean;
  /**
   * ISO-8601 when the page is archived (MOTIR-7420), `null` while it is live. An
   * archived page still opens at its address, read-only (§7).
   */
  archivedAt: string | null;
  /**
   * The page whose archive took this one — itself for an archive root; `null`
   * while live. A sub-page's banner links to it: only the root restores or
   * deletes (MOTIR-7421).
   */
  archiveRoot: { id: string; title: string } | null;
  /** Who archived it; `null` while live, or once that user is deleted. */
  archivedBy: { id: string; name: string } | null;
  /**
   * Whether the caller may restore THIS page — `page:edit`, and it is an archive
   * root. Reported beside `canDelete` (the permission), so a sub-page shows
   * neither action and links to its root instead.
   */
  canRestore: boolean;
  /**
   * The LIVE chip data for every work item the body mentions (MOTIR-7572),
   * resolved under the reader's own access exactly as a comment's chips are:
   * keyed by work-item id (and, when accessible, its current key). An archived
   * item carries `archived: true`; one in a project the reader may not browse is
   * `{ accessible: false, id }` with no title or key; a deleted one is absent.
   * `{}` for a page that mentions nothing.
   */
  workItemRefs: WorkItemRefMap;
}

/**
 * One row of the Archived pages list (MOTIR-7420): an archive ROOT — a sub-page
 * that left with it is not a row of its own — with how many sub-pages left with
 * it and the placement it was archived from, so the list can say where it came
 * from.
 */
export interface PageArchivedRootDto {
  id: string;
  title: string;
  /** ISO-8601. */
  archivedAt: string;
  archivedBy: { id: string; name: string } | null;
  /** The pages that left with it, itself excluded. */
  subPageCount: number;
  /** The parent it was archived from. */
  parent: PageParentDto;
  /** Its stored ancestor chain, root-first — the came-from trail's pages. */
  ancestorPageIds: string[];
}

/**
 * One Archived pages row as the service returns it (MOTIR-7421): the root, and
 * where it came from — its stored ancestor pages by title (an ancestor deleted
 * since reads as an em dash; an archived one by its own title), under the folder
 * chain its topmost page was filed in.
 */
export interface PageArchivedListItemDto extends PageArchivedRootDto {
  cameFrom: PageTrailDto;
  /**
   * The came-from pages that are themselves archived (each archived separately,
   * so each is a row of its own) — the list marks them "(archived)" (MOTIR-7424).
   */
  archivedAncestorIds: string[];
}

/** A page of the Archived pages list, newest first. */
export interface PageArchivedListDto {
  items: PageArchivedListItemDto[];
  /** Pass back to read the next page; `null` after the last. */
  nextCursor: string | null;
}

export interface ListArchivedPagesInput {
  projectId: string;
  cursor?: string | null;
  limit?: number | null;
}

/** Archive, restore or permanently delete one page — always by its id in a project. */
export interface PageArchiveActionInput {
  projectId: string;
  pageId: string;
}

/** What an archive returns: the set that left, root first. */
export interface ArchivePageResultDto {
  archivedIds: string[];
  rootId: string;
  /** The sub-pages that left with it — the set minus the root. */
  subPageCount: number;
}

/**
 * Where a restored page landed — `original` (where it was), `ancestorPage` (the
 * nearest live ancestor), `folder` or `root` — with the parent's display name,
 * for the restored-elsewhere notice. `title` is `null` at the project root.
 */
export interface PageRestoreLandingDto {
  kind: 'original' | 'ancestorPage' | 'folder' | 'root';
  parentPageId: string | null;
  folderId: string | null;
  title: string | null;
}

export interface RestorePageResultDto {
  restoredIds: string[];
  landing: PageRestoreLandingDto;
}

export interface DeletePageResultDto {
  deletedIds: string[];
}

/**
 * The sub-pages an archive of a page TAKES (a live page: its live descendants)
 * or TOOK (an archive root: the rest of its set) — what the archive confirm,
 * the archived banner and the permanent-delete confirm count (MOTIR-7423).
 */
export interface PageArchiveSetDto {
  /** The sub-pages, the page itself excluded. */
  subPageCount: number;
  /** Up to {@link PAGE_ARCHIVE_SET_TITLES} of their titles, shallowest first. */
  subPageTitles: string[];
}

/** How many sub-page titles the archive confirm names before "and N more". */
export const PAGE_ARCHIVE_SET_TITLES = 5;

/** A page row without its body — what a create or a rename returns. */
export interface PageSummaryDto {
  id: string;
  projectId: string;
  title: string;
  position: string;
  revision: number;
  updatedAt: string;
}

/**
 * One row of the `/pages` index (MOTIR-7300) — `pagesService.listPages`. Its own
 * shape rather than a widened {@link PageSummaryDto}: a row needs who edited the
 * page last, which no write's reply needs, and no position or revision.
 */
export interface PageListItemDto {
  id: string;
  /** The page's own title — `''` for an untitled page; the UI supplies the copy. */
  title: string;
  /** ISO-8601 — the last edit. */
  updatedAt: string;
  /** Who made that edit. `id` lets the row say "by you" to its own author. */
  updatedBy: { id: string; name: string };
}

export interface ListPagesInput {
  projectId: string;
}

/** What a save returns: the revision the update produced. */
export interface SavePageResultDto {
  revision: number;
}

export interface CreatePageInput {
  projectId: string;
  title?: string;
  /** Where the page goes; the project root when omitted (MOTIR-7370). */
  parent?: PageParentInput;
}

// ── The page tree (Story MOTIR-5753 · MOTIR-7370) ──────────────────────────

/**
 * A parent as a request names it — `@motir/pages`' `parsePlacement` input:
 * `{ kind: 'root' }`, `{ kind: 'folder', id }` or `{ kind: 'page', id }`. Typed
 * loosely ON PURPOSE: any other kind (a `work_item`) reaches the package and is
 * refused there as `PAGE_PARENT_NOT_ALLOWED`, rather than being unrepresentable
 * here and refused nowhere a route can see.
 */
export interface PageParentInput {
  kind: string;
  id?: string | null;
}

/** A page's parent, as the service reports it — the same shape a request names. */
export type PageParentDto =
  | { kind: 'root' }
  | { kind: 'folder'; id: string }
  | { kind: 'page'; id: string };

export interface MovePageInput {
  projectId: string;
  pageId: string;
  parent: PageParentInput;
  /** The page at the destination the moved page lands right AFTER. */
  beforeId?: string | null;
  /** The page at the destination the moved page lands right BEFORE. */
  afterId?: string | null;
}

/** Where a move left the page. `moved` is false for a move to where it already was. */
export interface PageMoveResultDto {
  id: string;
  parent: PageParentDto;
  position: string;
  /** The page's ancestors, root-first, the page itself excluded. */
  ancestorPageIds: string[];
  moved: boolean;
}

export interface ListPageTreeLevelInput {
  projectId: string;
  parent: PageParentInput;
  /** The opaque `nextCursor` of the previous read; omitted for the first. */
  cursor?: string | null;
  /** Rows per read: `PAGE_LEVEL_PAGE_SIZE` by default, `PAGE_LEVEL_PAGE_SIZE_MAX` at most. */
  limit?: number;
}

/** One row of a `/pages` tree level: a folder (at the root or in a folder) or a page. */
export type PageTreeRowDto =
  | { kind: 'folder'; id: string; name: string; hasChildren: boolean }
  | { kind: 'page'; id: string; title: string; hasChildren: boolean };

/**
 * One read of a tree level: folders first, then pages. `nextCursor` is `null`
 * when the level is exhausted; otherwise it is passed back verbatim.
 */
export interface PageTreeLevelDto {
  rows: PageTreeRowDto[];
  nextCursor: string | null;
}

export interface GetPageTrailInput {
  projectId: string;
  pageId: string;
}

/**
 * A page's breadcrumb, root-first and EXCLUDING the page itself: the folder
 * chain its topmost page is filed in, then its ancestor pages. Either may be
 * empty.
 */
export interface PageTrailDto {
  folders: Array<{ id: string; name: string }>;
  pages: Array<{ id: string; title: string }>;
}

export interface GetPageInput {
  projectId: string;
  pageId: string;
}

export interface RenamePageInput {
  projectId: string;
  pageId: string;
  title: string;
}

export interface SavePageUpdateInput {
  projectId: string;
  pageId: string;
  /** A Yjs update produced against the page's state. */
  update: Uint8Array;
}

// ── History (Story MOTIR-5754 · MOTIR-7385) — `docs/decisions/pages.md` §6 ──

/** One row of a page's history — `pagesService.listPageVersions`. */
export interface PageVersionListItemDto {
  /** Per page, from 1, never reused. */
  number: number;
  authorId: string;
  /** The author's display name; `''` only if the batch read did not return them. */
  authorName: string;
  /** ISO-8601 — when this version's first save landed. */
  startedAt: string;
  /** ISO-8601 — its last save. */
  savedAt: string;
  /** The version a restore copied; `null` unless this row is a restore. */
  restoredFromNumber: number | null;
  /** Whether that source is still kept (the cap may have pruned it). `false` unless a restore. */
  restoredFromKept: boolean;
  /** Whether this is the page's newest version — its current content. */
  isCurrent: boolean;
  /**
   * The version's DECISION TAG (MOTIR-7436): `frozen` — an approval froze it; `published`
   * — an awaiting decision asks about it. The card's key either way; null for every other
   * version, including one whose decision was sent back.
   */
  decisionTag?: { kind: 'frozen' | 'published'; key: string } | null;
}

/** One page of a page's history, newest first. */
export interface PageVersionListDto {
  items: PageVersionListItemDto[];
  /** Pass as `before` for the next page; `null` on the last one. */
  nextBefore: number | null;
}

/** One version with its snapshot — `pagesService.getPageVersion`. */
export interface PageVersionDto extends PageVersionListItemDto {
  /** The version's Yjs state, base64-encoded — the shape `PageDto.bodyState` uses. */
  bodyState: string;
  /** The live chip data of every work item the version's body mentions — `PageDto.workItemRefs`'s shape. */
  workItemRefs: WorkItemRefMap;
}

/** What a restore returns: the new current state, so an open editor re-seeds without a read. */
export interface RestorePageVersionResultDto {
  revision: number;
  /** The version the restore recorded — now the current one. */
  version: PageVersionListItemDto;
  /** The page's new canonical state, base64-encoded. */
  bodyState: string;
}

export interface ListPageVersionsInput {
  projectId: string;
  pageId: string;
  /** Continue below this version number (the previous page's `nextBefore`). */
  before?: number;
  /** Page size; defaults to `PAGE_LEVEL_PAGE_SIZE`, capped at `PAGE_LEVEL_PAGE_SIZE_MAX`. */
  limit?: number;
}

export interface GetPageVersionInput {
  projectId: string;
  pageId: string;
  number: number;
}

export interface RestorePageVersionInput {
  projectId: string;
  pageId: string;
  number: number;
}

// ── The markdown doors (Story MOTIR-5760 · MOTIR-7409) — `docs/decisions/pages.md` §8.2 ──

/**
 * One page as an AGENT reads it: its body as markdown, never the Yjs bytes, and
 * the `revision` a later `savePageMarkdown` must state.
 */
export interface PageMarkdownDto {
  id: string;
  projectId: string;
  title: string;
  /** Where the page is filed — at most one is set; both `null` at the project root. */
  placement: { parentPageId: string | null; folderId: string | null };
  /** Advances by one on every save; pass it back to write. */
  revision: number;
  /** The newest version (§6). `null` only for a page whose history predates versions. */
  latestVersion: {
    number: number;
    authorId: string;
    /** The author's display name; `''` only if the batch read did not return them. */
    authorName: string;
    /** ISO-8601. */
    savedAt: string;
  } | null;
  markdown: string;
  /** ISO-8601. */
  updatedAt: string;
  /**
   * Present ONLY on a read of one version (`get_page { version }`, MOTIR-7429):
   * the version whose body `markdown` then carries, with its decision marks
   * (`pages.md` AMENDMENT 3). Absent on a read of the current body, so that
   * read stays exactly what it was.
   */
  version?: PageMarkdownVersionDto;
}

/** The version a `get_page { version }` read returned. */
export interface PageMarkdownVersionDto {
  number: number;
  authorId: string;
  /** The author's display name; `''` only if the batch read did not return them. */
  authorName: string;
  /** ISO-8601. */
  savedAt: string;
  /** A decision publish sealed it: no save extends it and the cap never prunes it. */
  sealed: boolean;
  /** An approval froze it: it is the text a person approved. */
  frozen: boolean;
}

export interface GetPageMarkdownInput {
  projectId: string;
  pageId: string;
  /** A version NUMBER: read that version's body instead of the current one. */
  version?: number;
}

export interface SavePageMarkdownInput {
  projectId: string;
  pageId: string;
  /** The WHOLE body, as markdown. */
  markdown: string;
  /** The `revision` the caller read; a stale one is refused `PAGE_REVISION_CONFLICT`. */
  expectedRevision: number;
}

export interface CreatePageFromMarkdownInput {
  projectId: string;
  title?: string;
  /** Where the page goes; the project root when omitted. */
  parent?: PageParentInput;
  /** The initial body; an empty or omitted one leaves the page empty, as New page does. */
  markdown?: string;
}

// ── Page tags in a work item's text (Story MOTIR-7694 · MOTIR-7697) ─────────

/** One row of the `@` picker's Pages section: a live page and where it sits. */
export interface PageMentionCandidateDto {
  id: string;
  title: string;
  place: {
    /** The folder chain its topmost page is filed in, root first; `[]` at the root. */
    folderPath: string[];
    /** Its direct parent page's title; `null` for a top-level page. */
    parentPageTitle: string | null;
  };
}

/** One page of the Link page picker's title search (MOTIR-9204). */
export interface PageLinkCandidatesDto {
  items: PageMentionCandidateDto[];
  /** Opaque; non-null exactly when a further match exists. */
  nextCursor: string | null;
}

/**
 * One full-text page search hit (Story MOTIR-9489 · MOTIR-9551) — and nothing
 * else: no body, no markdown, no count. `place` is the picker's own place, so
 * every search door shows where a page lives the same way.
 */
export interface PageSearchHitDto {
  id: string;
  title: string;
  place: PageMentionCandidateDto['place'];
  /** A short excerpt of the searchable body around the match; `''` for an empty body. */
  snippet: string;
  /** `ts_rank`; higher is a better match. Comparable only within one search. */
  rank: number;
}

/** One page of a full-text page search. */
export interface PageSearchResultDto {
  items: PageSearchHitDto[];
  /** Opaque; non-null exactly when a further hit exists. */
  nextCursor: string | null;
}

/**
 * The live data a page chip renders. `unavailable` carries NO title by
 * construction: it is the one answer for a reader without `page:view`, a
 * Visitor, an archived page, a deleted page and an id of another project, so
 * the chip never says which.
 */
export type PageRefSummaryDto =
  | { state: 'available'; id: string; title: string }
  | { state: 'unavailable'; id: string };

/** Page-chip summaries keyed by page id — `{}` for a body that tags no page. */
export type PageRefMap = Record<string, PageRefSummaryDto>;
