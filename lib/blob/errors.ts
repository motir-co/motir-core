// Typed errors for the attachment domain (Subtask 2.3.7 upload trio; Subtask
// 5.2.2 adds the management-surface set). The route maps each `code` to an
// HTTP status via the AttachmentError base, matching the `readonly code`
// convention the other domains use.

export abstract class AttachmentError extends Error {
  abstract readonly code: string;
  /** HTTP status the route should return. */
  abstract readonly status: number;
}

/** Upload exceeded the size cap. → 413. */
export class FileTooLargeError extends AttachmentError {
  readonly code = 'FILE_TOO_LARGE' as const;
  readonly status = 413;
  constructor(maxBytes: number) {
    super(`File is too large — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    this.name = 'FileTooLargeError';
  }
}

/** MIME type not in the allowlist. → 415. */
export class UnsupportedFileTypeError extends AttachmentError {
  readonly code = 'UNSUPPORTED_FILE_TYPE' as const;
  readonly status = 415;
  constructor(mime: string) {
    super(`File type "${mime || 'unknown'}" isn't supported.`);
    this.name = 'UnsupportedFileTypeError';
  }
}

/** Per-user upload rate limit exceeded. → 429. */
export class RateLimitError extends AttachmentError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429;
  constructor() {
    super('Too many uploads — please wait a moment and try again.');
    this.name = 'RateLimitError';
  }
}

/**
 * The attachment doesn't resolve for the caller (Subtask 5.2.2): missing id,
 * a row in ANOTHER workspace, or a row not linked to any issue (an unlinked
 * row is on no panel — it belongs to the 5.2.7 GC, not the management API).
 * All three read identically as 404 — finding #44: "you can't see it" must be
 * indistinguishable from "it doesn't exist".
 */
export class AttachmentNotFoundError extends AttachmentError {
  readonly code = 'ATTACHMENT_NOT_FOUND' as const;
  readonly status = 404;
  constructor(id: string) {
    super(`Attachment "${id}" was not found.`);
    this.name = 'AttachmentNotFoundError';
  }
}

/**
 * The caller's role doesn't allow the attachment action (Subtask 5.2.2) —
 * Jira's permission split mapped onto the 6.4 roles: `create` needs a
 * non-viewer role on the issue's project; `delete` needs to be the uploader
 * (own) or a moderator (project admin / workspace owner-admin — all). → 403.
 */
export class AttachmentForbiddenError extends AttachmentError {
  readonly code = 'ATTACHMENT_FORBIDDEN' as const;
  readonly status = 403;
  constructor(action: 'create' | 'delete') {
    super(`You don't have permission to ${action} attachments on this issue.`);
    this.name = 'AttachmentForbiddenError';
  }
}

/**
 * The row entered through the description/comment editor, and editor-sourced
 * files can't be panel-deleted (Subtask 5.2.2 — the Jira rule, and what
 * prevents the broken-embed hole: deleting a file out from under a live embed).
 * The fix is to remove the embed at its source; the panel points there. → 409.
 */
export class AttachmentEditorSourcedError extends AttachmentError {
  readonly code = 'ATTACHMENT_EDITOR_SOURCED' as const;
  readonly status = 409;
  constructor() {
    super('This file was added in the description or a comment — remove it there instead.');
    this.name = 'AttachmentEditorSourcedError';
  }
}

/**
 * An attachment id that is not a panel attachment ON the named work item
 * (Story MOTIR-7471 · MOTIR-7484): missing, in another workspace, on another
 * card, unlinked, or lifecycle-owned. A guide turn may carry only files that are
 * on the GUIDED card (`docs/decisions/guide-turn-files.md` A3.2). One reading
 * for every case — which one would answer a question about somebody else's
 * file. → 400 at the guide door (the turn is malformed, not the card missing).
 */
export class AttachmentNotOnWorkItemError extends AttachmentError {
  readonly code = 'ATTACHMENT_NOT_ON_WORK_ITEM' as const;
  readonly status = 400;
  constructor(readonly attachmentId: string) {
    super(`Attachment "${attachmentId}" is not on this work item.`);
    this.name = 'AttachmentNotOnWorkItemError';
  }
}

/**
 * The cutover's stored-reference rewrite (MOTIR-10075) refused to finish. Thrown
 * INSIDE its one transaction, so the throw is what rolls every row back: the
 * rewrite is all or nothing, and an operator re-runs it after reading `message`.
 * Not an `AttachmentError` — no route serves it; the operator script prints it
 * and exits non-zero.
 */
export class StoredAssetRewriteError extends Error {
  readonly code:
    | 'STORED_ASSET_BAD_BASE'
    | 'STORED_ASSET_NOT_REDUCIBLE'
    | 'STORED_ASSET_CHANGED'
    | 'STORED_ASSET_REWRITE_INCOMPLETE';
  /** The table and row the refusal names, when it names one. */
  readonly table: 'user' | 'project' | null;
  readonly rowId: string | null;
  constructor(
    code: StoredAssetRewriteError['code'],
    message: string,
    where: { table: 'user' | 'project'; rowId: string } | null = null,
  ) {
    super(message);
    this.name = 'StoredAssetRewriteError';
    this.code = code;
    this.table = where?.table ?? null;
    this.rowId = where?.rowId ?? null;
  }
}
