import { PAGE_DEPTH_LIMIT, PAGE_TITLE_MAX_LENGTH } from './constants';

// The typed refusals the pure tree rules raise. Each carries the stable `code`
// and HTTP `status` `docs/decisions/pages.md` §4 names, so the app's route layer
// maps them without a table of its own.

/** Base class, so a route can catch every tree refusal in one branch. */
export abstract class PageTreeError extends Error {
  abstract readonly code: string;
  readonly status = 422 as const;
}

/** A placement named something that is not a page, a folder or the root. */
export class PageParentNotAllowedError extends PageTreeError {
  readonly code = 'PAGE_PARENT_NOT_ALLOWED' as const;
  constructor(readonly parentKind: string) {
    super(
      parentKind === 'work_item'
        ? 'A page cannot be placed under a work item. Place it under a page, a folder or the project root.'
        : `A page cannot be placed under a "${parentKind}". Place it under a page, a folder or the project root.`,
    );
    this.name = 'PageParentNotAllowedError';
  }
}

/** A page placed under itself or one of its own descendants. */
export class PageCycleError extends PageTreeError {
  readonly code = 'PAGE_CYCLE' as const;
  constructor(
    readonly pageId: string,
    readonly parentPageId: string,
  ) {
    super('A page cannot be placed under itself or one of its own sub-pages.');
    this.name = 'PageCycleError';
  }
}

/** A placement that would put a page deeper than the depth limit. */
export class PageDepthExceededError extends PageTreeError {
  readonly code = 'PAGE_DEPTH_EXCEEDED' as const;
  readonly limit = PAGE_DEPTH_LIMIT;
  constructor(readonly attemptedLevel: number) {
    super(
      `Pages can be nested at most ${PAGE_DEPTH_LIMIT} levels deep; this would place one at level ${attemptedLevel}.`,
    );
    this.name = 'PageDepthExceededError';
  }
}

/** A placement whose parent page or folder belongs to another project. */
export class CrossProjectPageParentError extends PageTreeError {
  readonly code = 'CROSS_PROJECT_PAGE_PARENT' as const;
  constructor(
    readonly parentKind: 'page' | 'folder',
    readonly parentId: string,
  ) {
    super(`A page can only be placed under a ${parentKind} in its own project.`);
    this.name = 'CrossProjectPageParentError';
  }
}

/**
 * A move's `beforeId` / `afterId` that does not name a sibling at the target:
 * a page that is not a child of the target parent (`not_sibling`), the moving
 * page itself (`self`), or two neighbours named in the wrong order (`order`).
 */
export class PageNeighbourInvalidError extends PageTreeError {
  readonly code = 'PAGE_NEIGHBOUR_INVALID' as const;
  constructor(
    readonly side: 'before' | 'after',
    readonly neighbourId: string,
    readonly reason: 'not_sibling' | 'self' | 'order',
  ) {
    super(
      reason === 'order'
        ? 'The page to place after must come before the page to place before.'
        : reason === 'self'
          ? 'A page cannot be placed next to itself.'
          : `The ${side} neighbour is not a page at the destination.`,
    );
    this.name = 'PageNeighbourInvalidError';
  }
}

/** Base class for the save procedures' refusals, each carrying its HTTP status. */
export abstract class PageError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
}

/**
 * A body over a size limit (§3) — a save REQUEST over `PAGE_SAVE_MAX_BYTES`, or a
 * merged body over `PAGE_BODY_MAX_BYTES`. Either way nothing is written.
 */
export class PageBodyTooLargeError extends PageError {
  readonly code = 'PAGE_BODY_TOO_LARGE' as const;
  readonly status = 413 as const;
  constructor(
    readonly limit: number,
    readonly size: number,
  ) {
    super(`This page body is ${size} bytes; the limit is ${limit} bytes.`);
    this.name = 'PageBodyTooLargeError';
  }
}

/**
 * A whole-body write (the markdown save, §3 / §8.2) that stated a revision the
 * page has since moved past. A Yjs update merges and is never refused for
 * staleness; a whole-body replace would erase whatever landed in between, so it
 * is refused and nothing is written. Re-read the page and write again.
 */
export class PageRevisionConflictError extends PageError {
  readonly code = 'PAGE_REVISION_CONFLICT' as const;
  readonly status = 409 as const;
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `This page is at revision ${actual}, not the revision ${expected} the write was based on. Re-read the page and write again.`,
    );
    this.name = 'PageRevisionConflictError';
  }
}

/** A page that does not exist, or is outside the caller's scope. */
export class PageNotFoundError extends PageError {
  readonly code = 'PAGE_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(readonly pageId: string) {
    super('Page not found.');
    this.name = 'PageNotFoundError';
  }
}

/** A title longer than `PAGE_TITLE_MAX_LENGTH` characters. */
export class PageTitleTooLongError extends PageError {
  readonly code = 'PAGE_TITLE_TOO_LONG' as const;
  readonly status = 422 as const;
  readonly limit = PAGE_TITLE_MAX_LENGTH;
  constructor(readonly length: number) {
    super(
      `A page title can be at most ${PAGE_TITLE_MAX_LENGTH} characters; this one is ${length}.`,
    );
    this.name = 'PageTitleTooLongError';
  }
}

/**
 * A save whose update is not a Yjs update this document can apply — empty, or
 * bytes the decoder refuses. Our own editor never sends one, so it is a client
 * defect or a hand-made request; it is refused before anything is written.
 */
export class PageUpdateMalformedError extends PageError {
  readonly code = 'PAGE_UPDATE_MALFORMED' as const;
  readonly status = 400 as const;
  constructor(readonly reason: 'empty' | 'undecodable') {
    super(
      reason === 'empty'
        ? 'The page update is empty.'
        : 'The page update could not be decoded as a Yjs update.',
    );
    this.name = 'PageUpdateMalformedError';
  }
}

/**
 * A folder placement naming a folder that does not exist or is outside the
 * caller's scope. The wire code is the folder domain's own `FOLDER_NOT_FOUND`
 * (404), so a client reads one refusal for a missing folder whichever door it
 * came through.
 */
export class PageFolderNotFoundError extends PageError {
  readonly code = 'FOLDER_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(readonly folderId: string) {
    super('Folder not found.');
    this.name = 'PageFolderNotFoundError';
  }
}

/**
 * A tree-level read's cursor that is not one this service issued — not decodable,
 * or naming a band the level does not have. Cursors are opaque: a client passes
 * back the `nextCursor` it was handed, verbatim.
 */
export class PageLevelCursorInvalidError extends PageError {
  readonly code = 'PAGE_CURSOR_INVALID' as const;
  readonly status = 400 as const;
  constructor() {
    super('The tree-level cursor is not valid. Pass back the nextCursor you were given.');
    this.name = 'PageLevelCursorInvalidError';
  }
}

/** A version a page does not have — never existed, pruned, or another page's (§6). */
export class PageVersionNotFoundError extends PageError {
  readonly code = 'PAGE_VERSION_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(
    readonly pageId: string,
    readonly number: number,
  ) {
    super(`This page has no version ${number}.`);
    this.name = 'PageVersionNotFoundError';
  }
}

// ── Archive, restore and delete (Story MOTIR-5755 · MOTIR-7418, §7) ──────────

/**
 * A write to a page that is ARCHIVED — a save, a rename, a move, a version
 * restore, or a second archive. An archived page is read-only until it is
 * restored (§7).
 */
export class PageArchivedError extends PageError {
  readonly code = 'PAGE_ARCHIVED' as const;
  readonly status = 409 as const;
  constructor(readonly pageId: string) {
    super('This page is archived. Restore it before changing it.');
    this.name = 'PageArchivedError';
  }
}

/** A restore or a delete of a page that is not archived — "archive it first" on a delete. */
export class PageNotArchivedError extends PageError {
  readonly code = 'PAGE_NOT_ARCHIVED' as const;
  readonly status = 409 as const;
  constructor(readonly pageId: string) {
    super('This page is not archived. Archive it first.');
    this.name = 'PageNotArchivedError';
  }
}

/**
 * A restore or a delete of an archived page that is not its archive's ROOT —
 * a sub-page that left with its parent comes back, or goes, with that parent.
 * Carries the root so a client can offer it instead.
 */
export class PageArchiveRootRequiredError extends PageError {
  readonly code = 'PAGE_ARCHIVE_ROOT_REQUIRED' as const;
  readonly status = 409 as const;
  constructor(
    readonly pageId: string,
    readonly rootId: string,
  ) {
    super('This page was archived with a parent page. Restore or delete that page instead.');
    this.name = 'PageArchiveRootRequiredError';
  }
}

/** A create or a move naming an ARCHIVED page as the parent. */
export class PageParentArchivedError extends PageTreeError {
  readonly code = 'PAGE_PARENT_ARCHIVED' as const;
  constructor(readonly parentPageId: string) {
    super('A page cannot be placed under an archived page.');
    this.name = 'PageParentArchivedError';
  }
}

/**
 * A delete that would take a FROZEN version with it — the exact text a person
 * approved for a decision (`pages.md` AMENDMENT 3). 409: the page can be
 * archived, never deleted. `pageId` names the page in the set that holds it.
 */
export class PageHoldsFrozenVersionError extends PageError {
  readonly code = 'PAGE_HOLDS_FROZEN_VERSION' as const;
  readonly status = 409 as const;
  constructor(readonly pageId: string) {
    super(
      'This page holds a version a person approved for a decision, so it cannot be deleted. ' +
        'Archive it instead.',
    );
    this.name = 'PageHoldsFrozenVersionError';
  }
}

// ── Comments (Story MOTIR-10866 · MOTIR-10872) ─────────────────────────────

/** A comment that does not exist, or belongs to another page. */
export class PageCommentNotFoundError extends PageError {
  readonly code = 'PAGE_COMMENT_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(readonly commentId: string) {
    super('Comment not found.');
    this.name = 'PageCommentNotFoundError';
  }
}

/** A reply to a reply. A page's threads are one level deep. */
export class PageCommentReplyDepthError extends PageError {
  readonly code = 'PAGE_COMMENT_REPLY_DEPTH_EXCEEDED' as const;
  readonly status = 422 as const;
  constructor(readonly parentCommentId: string) {
    super('You can only reply to the first comment of a thread.');
    this.name = 'PageCommentReplyDepthError';
  }
}

/** An edit or a delete by someone who neither wrote the comment nor moderates comments. */
export class PageCommentForbiddenError extends PageError {
  readonly code = 'PAGE_COMMENT_FORBIDDEN' as const;
  readonly status = 403 as const;
  constructor(readonly action: 'edit' | 'delete') {
    super(
      action === 'edit'
        ? 'Only the author or a comment moderator can edit this comment.'
        : 'Only the author or a comment moderator can delete this comment.',
    );
    this.name = 'PageCommentForbiddenError';
  }
}

/** A resolve or a reopen of a reply. Resolution belongs to the thread, held on its root. */
export class PageCommentNotRootError extends PageError {
  readonly code = 'PAGE_COMMENT_NOT_ROOT' as const;
  readonly status = 422 as const;
  constructor(readonly commentId: string) {
    super('Only a thread can be resolved or reopened, not a reply in it.');
    this.name = 'PageCommentNotRootError';
  }
}

/** A comment body that is empty or whitespace only. */
export class PageCommentBodyEmptyError extends PageError {
  readonly code = 'PAGE_COMMENT_BODY_EMPTY' as const;
  readonly status = 422 as const;
  constructor() {
    super('A comment cannot be empty.');
    this.name = 'PageCommentBodyEmptyError';
  }
}

/** An inline anchor with no position bytes, or a blank quote. */
export class PageCommentAnchorInvalidError extends PageError {
  readonly code = 'PAGE_COMMENT_ANCHOR_INVALID' as const;
  readonly status = 400 as const;
  constructor(readonly reason: 'empty_bytes' | 'blank_quote') {
    super(
      reason === 'empty_bytes'
        ? 'The comment anchor has no position.'
        : 'The comment anchor quotes no text.',
    );
    this.name = 'PageCommentAnchorInvalidError';
  }
}

/** A thread-list cursor this package did not issue, or one issued for another list. */
export class PageCommentCursorInvalidError extends PageError {
  readonly code = 'PAGE_COMMENT_CURSOR_INVALID' as const;
  readonly status = 400 as const;
  constructor() {
    super('The comment cursor is not valid. Pass back the nextCursor you were given.');
    this.name = 'PageCommentCursorInvalidError';
  }
}
