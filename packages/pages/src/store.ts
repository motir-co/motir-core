import type { JSONContent } from '@tiptap/core';
import type { PagePlacement } from './types';

// The PORTS the save procedures write through (Story MOTIR-5752 · MOTIR-7274),
// `docs/decisions/pages.md` §2. The package decides what a create, a rename and
// a save write; the app persists it, through a `PageStore` it builds per
// transaction (`pageStoreFor(tx)` in `lib/pages/index.ts`).
//
// Only the methods the shipped procedures call are here. Later stories add
// their own with the procedures that call them: the version methods
// (MOTIR-5754 · §6) and the comment methods (MOTIR-10866 · MOTIR-10872). The
// placement methods (`findFolder`, `findSubtree`,
// `siblingNeighbours`, `updatePlacement`, `rebaseDescendants`) are the page
// tree's (MOTIR-5753 · MOTIR-7368); `setArchived`, `findArchiveSet`,
// `deletePages` and `positionTaken` are archive's (MOTIR-5755 · MOTIR-7418, §7).
//
// ⚠️ LIVE vs ARCHIVED (§7). The LEVEL reads — `lastSiblingPosition`,
// `siblingNeighbours`, `positionTaken` — see LIVE pages only: an archived page
// has left the tree, and its kept `position` must not shape a level it is not
// in. The ROW reads — `lockPage`, `findPage`, `findSubtree`, `findArchiveSet` —
// return archived pages too, and the procedures decide what an archived page
// may do.

/** A page row, without its body state. */
export interface PageRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly parentPageId: string | null;
  readonly folderId: string | null;
  readonly position: string;
  readonly ancestorPageIds: readonly string[];
  readonly revision: number;
  readonly createdById: string;
  readonly updatedById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When the page was archived (§7); `null` while it is live. */
  readonly archivedAt: Date | null;
  /**
   * The page whose archive took this one — itself for the page a member
   * archived, that page for every sub-page that left with it. `null` while live.
   */
  readonly archiveRootId: string | null;
  /** Who archived it; `null` while live, or once that user is deleted. */
  readonly archivedById: string | null;
}

/** A page row read under its lock, with the canonical body state. */
export interface LockedPageRow extends PageRow {
  readonly bodyState: Uint8Array;
}

/** A body write: the canonical state and the three formats derived from it, together. */
export interface PageBodyWrite {
  readonly state: Uint8Array;
  readonly json: JSONContent;
  readonly markdown: string;
  readonly text: string;
  readonly revision: number;
  readonly updatedById: string;
  readonly updatedAt: Date;
}

/** A new page, as `insertPage` writes it. */
export interface PageInsert {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly parentPageId: string | null;
  readonly folderId: string | null;
  readonly position: string;
  readonly ancestorPageIds: readonly string[];
  readonly body: PageBodyWrite;
  readonly createdById: string;
  readonly createdAt: Date;
}

/**
 * The sources a page body DERIVES a link from (§8.1): a work item mentioned in
 * the text, or embedded as a card. `manual` is the third source the link table
 * stores, and it is never derived — a body write leaves it alone.
 */
export type DerivedPageLinkSource = 'mention' | 'embed';

/** A link a page body names (§8.1), as `extractLinks` derives it. */
export interface DerivedPageLink {
  readonly workItemId: string;
  readonly source: DerivedPageLinkSource;
}

/** A folder, as a placement under it needs it: its identity and its project. */
export interface FolderRef {
  readonly id: string;
  readonly projectId: string;
}

/**
 * One page of a subtree or an archive set: the facts the depth check and the
 * rewrite read, and whether — and by which archive — it is archived.
 */
export interface SubtreePage {
  readonly id: string;
  readonly ancestorPageIds: readonly string[];
  readonly archivedAt: Date | null;
  readonly archiveRootId: string | null;
}

/**
 * The positions a move mints between, at its target level. `null` is the start
 * (`before`) or the end (`after`) of the level.
 */
export interface NeighbourPositions {
  readonly before: string | null;
  readonly after: string | null;
}

/** Where a page sits after a move — `updatePlacement`'s write. */
export interface PagePlacementWrite {
  readonly parentPageId: string | null;
  readonly folderId: string | null;
  readonly position: string;
  readonly ancestorPageIds: readonly string[];
}

/** One version of a page (§6), without its snapshot. */
export interface PageVersionRow {
  readonly id: string;
  readonly pageId: string;
  /** Per page, from 1, never reused — the next is always `max + 1`. */
  readonly number: number;
  readonly authorId: string;
  readonly startedAt: Date;
  readonly savedAt: Date;
  /** The source of a restore; `null` once that source is pruned. */
  readonly restoredFromVersionId: string | null;
  /** The source's number, kept when the source is pruned; `null` unless a restore. */
  readonly restoredFromNumber: number | null;
  /**
   * When a decision publish SEALED it (`pages.md` AMENDMENT 3): no save extends
   * a sealed version and the cap never prunes it. `null` while unsealed.
   */
  readonly sealedAt: Date | null;
  /** When an approval FROZE it — always after `sealedAt`. `null` while unfrozen. */
  readonly frozenAt: Date | null;
}

/** A version with its snapshot, as a restore reads it. */
export interface PageVersionWithBody extends PageVersionRow {
  readonly bodyState: Uint8Array;
  readonly bodyMarkdown: string;
}

/** A new version, as `insertVersion` writes it — its page's tenancy stamped on it. */
export interface PageVersionInsert {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly number: number;
  readonly authorId: string;
  readonly bodyState: Uint8Array;
  readonly bodyMarkdown: string;
  readonly startedAt: Date;
  readonly savedAt: Date;
  readonly restoredFromVersionId: string | null;
  readonly restoredFromNumber: number | null;
}

/** An extension of the latest version: its snapshot and `savedAt` move forward. */
export interface PageVersionUpdate {
  readonly bodyState: Uint8Array;
  readonly bodyMarkdown: string;
  readonly savedAt: Date;
}

// ── Comments (Story MOTIR-10866 · MOTIR-10872) — `page_comment` ─────────────

/** A person a comment names — its author or its resolver — as the panel shows them. */
export interface PageCommentPerson {
  readonly id: string;
  readonly name: string;
  readonly image: string | null;
}

/** One page comment, root or reply, with its author and resolver joined. */
export interface PageCommentRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly pageId: string;
  /** The thread's root; `null` on a root. Replies are one level deep. */
  readonly parentCommentId: string | null;
  readonly authorId: string;
  readonly author: PageCommentPerson;
  readonly bodyMd: string;
  /** Set by an edit that changed the body; `null` while never edited. */
  readonly editedAt: Date | null;
  readonly createdAt: Date;
  /** When the thread was resolved — on a root only; `null` while open. */
  readonly resolvedAt: Date | null;
  /** Who resolved it; `null` while open, or once that user is deleted. */
  readonly resolvedById: string | null;
  readonly resolvedBy: PageCommentPerson | null;
  /** The inline anchor's encoded positions (the inline story's codec); `null` on a page-level comment. */
  readonly anchor: Uint8Array | null;
  /** The text the anchor quoted; set exactly when `anchor` is. */
  readonly anchorQuote: string | null;
}

/**
 * An inline anchor as a create carries it — one object, so it is both or
 * neither by type (`page_comment_anchor_pairing`). `bytes` is opaque here.
 */
export interface PageCommentAnchorInput {
  readonly bytes: Uint8Array;
  readonly quote: string;
}

/** A new comment, as `insertPageComment` writes it — its page's tenancy stamped on it. */
export interface PageCommentInsert {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly authorId: string;
  readonly parentCommentId: string | null;
  readonly bodyMd: string;
  readonly createdAt: Date;
  /** A root's anchor; always `null` on a reply. */
  readonly anchor: PageCommentAnchorInput | null;
}

/** Which of a page's threads a list reads. */
export type PageCommentThreadStatus = 'open' | 'resolved';

/** The direction a root list runs along its key. */
export type PageCommentOrder = 'asc' | 'desc';

/**
 * The keyset a root list pages on: `(createdAt, id)` for open roots,
 * `(resolvedAt, id)` for resolved ones — the two partial indexes' keys.
 */
export interface PageCommentRootKey {
  readonly at: Date;
  readonly id: string;
}

/** One page of a page's roots. */
export interface PageCommentRootsQuery {
  readonly pageId: string;
  readonly status: PageCommentThreadStatus;
  readonly order: PageCommentOrder;
  /** The last root already served; `null` for the first page. Strictly after it, in `order`. */
  readonly after: PageCommentRootKey | null;
  readonly limit: number;
}

/** How many roots a page has in each list. */
export interface PageCommentCounts {
  readonly open: number;
  readonly resolved: number;
}

/** The page persistence port — one instance per transaction. */
export interface PageStore {
  /** Reads one page `FOR UPDATE`, body state included; `null` if absent or out of scope. */
  lockPage(pageId: string): Promise<LockedPageRow | null>;
  /** Reads one page without its body; `null` if absent or out of scope. */
  findPage(pageId: string): Promise<PageRow | null>;
  /**
   * Serialises every PLACEMENT write in the project — a create, a move, a
   * subtree rewrite — for the caller's transaction, so two inserts mint distinct
   * positions and two moves cannot each pass the cycle check against a tree the
   * other is changing. `parent` names the level the caller writes into; an
   * adapter may lock more than that level, and the page tree's does: the whole
   * project.
   */
  lockSiblings(projectId: string, parent: PagePlacement): Promise<void>;
  /** The greatest position among one parent's pages; `null` for an empty level. */
  lastSiblingPosition(projectId: string, parent: PagePlacement): Promise<string | null>;
  /** Reads one folder; `null` if absent or out of scope. */
  findFolder(folderId: string): Promise<FolderRef | null>;
  /**
   * Every DESCENDANT of a page (the page itself excluded), at any depth —
   * archived descendants INCLUDED, because a move carries them (they are still
   * its sub-pages) and archive, restore and delete must see them.
   */
  findSubtree(pageId: string): Promise<SubtreePage[]>;
  /**
   * The positions to mint between at one parent's level. `beforeId` names the
   * page the new position follows and `afterId` the page it precedes, each a
   * child of `parent` (the caller has checked). A side the caller did not name
   * is read from the level: with only `beforeId`, `after` is the page right
   * after it; with only `afterId`, `before` is the page right before it; with
   * neither, `before` is the level's last page and `after` is `null` — an
   * append.
   */
  siblingNeighbours(
    projectId: string,
    parent: PagePlacement,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<NeighbourPositions>;
  /** Creates a page. */
  insertPage(row: PageInsert): Promise<PageRow>;
  /** Writes the state and the three derived formats together. */
  updateBody(pageId: string, body: PageBodyWrite): Promise<void>;
  /** Renames a page; `null` if absent or out of scope. */
  updateTitle(pageId: string, title: string, updatedById: string): Promise<PageRow | null>;
  /** Moves one page: its parent, folder, position and ancestors, in one write. */
  updatePlacement(
    pageId: string,
    placement: PagePlacementWrite,
    updatedById: string,
  ): Promise<PageRow>;
  /**
   * Rewrites the `ancestor_page_ids` of every descendant of a moved page in ONE
   * write: the part of each chain above `pageId` is replaced by
   * `newAncestorPageIds` (`rebaseAncestorIds`, applied to the whole subtree).
   */
  rebaseDescendants(pageId: string, newAncestorPageIds: readonly string[]): Promise<void>;
  /** The newest version of a page; `null` when it has none. */
  latestVersion(pageId: string): Promise<PageVersionRow | null>;
  /** Writes a new version. */
  insertVersion(row: PageVersionInsert): Promise<PageVersionRow>;
  /** Extends a version: replaces its snapshot and moves its `savedAt`. */
  updateVersion(versionId: string, row: PageVersionUpdate): Promise<void>;
  /** Version `number` of THIS page, with its snapshot; `null` when it has no such version. */
  findVersion(pageId: string, number: number): Promise<PageVersionWithBody | null>;
  /** How many versions a page keeps. */
  countVersions(pageId: string): Promise<number>;
  /**
   * Deletes a page's oldest UNMARKED versions (neither sealed nor frozen) until
   * `keep` remain or only marked ones and the NEWEST are left — the newest is
   * the version a save just wrote, never a candidate — so a page may keep more than
   * `keep` when more than `keep` are marked (`pages.md` AMENDMENT 3).
   */
  deleteOldestUnmarkedVersions(pageId: string, keep: number): Promise<void>;
  /**
   * The first of `pageIds` holding a FROZEN version (an approved decision,
   * `pages.md` AMENDMENT 3); `null` when none does.
   */
  findPageWithFrozenVersion(pageIds: readonly string[]): Promise<string | null>;
  /**
   * Rewrites a page's DERIVED link rows (§8.1) to exactly `links`: rows of the
   * derived sources the body no longer names go, new ones are written with
   * `actorId` as their creator, and a `manual` row is never touched.
   */
  replaceDerivedLinks(
    pageId: string,
    links: readonly DerivedPageLink[],
    actorId: string,
  ): Promise<void>;
  /**
   * Stamps (or, with three `null`s, clears) the archive columns of every page in
   * `ids`, in ONE write (§7). Nothing else on the rows changes.
   */
  setArchived(
    ids: readonly string[],
    archivedAt: Date | null,
    archiveRootId: string | null,
    archivedById: string | null,
  ): Promise<void>;
  /** Every page whose `archiveRootId` is `rootId` — one archive set, its root included. */
  findArchiveSet(rootId: string): Promise<SubtreePage[]>;
  /**
   * Permanently deletes every page in `ids` in ONE statement, so the
   * `parent_page_id` foreign key is checked once, at its end; their versions go
   * with them (`page_version` cascades).
   */
  deletePages(ids: readonly string[]): Promise<void>;
  /** Whether a LIVE page at one parent's level already holds `position`. */
  positionTaken(projectId: string, parent: PagePlacement, position: string): Promise<boolean>;

  // ── Comments (MOTIR-10872). Rows come back with author and resolver joined. ──

  /** One page of a page's ROOTS (replies never), in the query's list, order and window. */
  findPageCommentRoots(query: PageCommentRootsQuery): Promise<PageCommentRow[]>;
  /** Every reply of the given roots, oldest first by `(createdAt, id)`. */
  findPageCommentReplies(rootIds: readonly string[]): Promise<PageCommentRow[]>;
  /** How many open and resolved roots a page has. */
  countPageCommentRoots(pageId: string): Promise<PageCommentCounts>;
  /** Reads one comment `FOR UPDATE`; `null` if absent or out of scope. */
  lockPageComment(commentId: string): Promise<PageCommentRow | null>;
  /**
   * Reads one comment WITHOUT a row lock — the read path's by-id read, so a
   * reader of a discussion never waits behind a writer of it. `null` if absent
   * or out of scope.
   */
  findPageComment(commentId: string): Promise<PageCommentRow | null>;
  /** Creates a comment, root or reply. */
  insertPageComment(row: PageCommentInsert): Promise<PageCommentRow>;
  /** Replaces a comment's body and stamps `editedAt`. */
  updatePageCommentBody(commentId: string, bodyMd: string, editedAt: Date): Promise<PageCommentRow>;
  /** Deletes one comment; a root's replies go with it (`parent_comment_id` cascades). */
  deletePageCommentRow(commentId: string): Promise<void>;
  /** Stamps (or, with two `null`s, clears) a root's resolved state. */
  setPageCommentResolved(
    commentId: string,
    resolvedAt: Date | null,
    resolvedById: string | null,
  ): Promise<PageCommentRow>;
}

/** The time source, injected so time-dependent rules are testable without fake timers. */
export interface Clock {
  now(): Date;
}
