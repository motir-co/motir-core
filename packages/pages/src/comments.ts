import {
  PageArchivedError,
  PageCommentAnchorInvalidError,
  PageCommentBodyEmptyError,
  PageCommentCursorInvalidError,
  PageCommentForbiddenError,
  PageCommentNotFoundError,
  PageCommentNotRootError,
  PageCommentReplyDepthError,
  PageNotFoundError,
} from './errors';
import type {
  Clock,
  PageCommentAnchorInput,
  PageCommentCounts,
  PageCommentOrder,
  PageCommentPerson,
  PageCommentRootKey,
  PageCommentRow,
  PageCommentThreadStatus,
  PageRow,
  PageStore,
} from './store';

// PAGE COMMENTS (Story MOTIR-10866 · MOTIR-10872). Pure procedures over the
// `PageStore`, in the shape `archive.ts` has. The service owns the transaction
// and every PERMISSION it can read from a session: `page:view` to read,
// `comment:add` to write, and `comment:moderate`, which it hands in as
// `actor.canModerate`. These own what is decided from the inputs alone: the page
// is in the caller's project and live for a write, a reply's parent is a root,
// edit and delete are the author's or a moderator's, resolve and reopen are a
// root's, a body is not blank, an anchor is whole.
//
// ⚠️ LOCK ORDER. Every write takes the PAGE's row lock (`lockPage`) first, then
// the comment's (`lockPageComment`) where it changes an existing row. None takes
// `lockSiblings`, so none can deadlock with archive (`lockSiblings` then
// `lockPage`), and an archive that commits first is seen here as an archived
// page, refused.

/** Threads a list returns by default, and at most. */
export const PAGE_COMMENT_THREADS_DEFAULT_LIMIT = 20;
export const PAGE_COMMENT_THREADS_MAX_LIMIT = 50;

/** Who is acting, as the service resolved them. */
export interface PageCommentActor {
  readonly userId: string;
  /** Holds `comment:moderate` — may edit and delete another person's comment. */
  readonly canModerate: boolean;
}

/** What every comment procedure is handed. */
export interface PageCommentScope {
  readonly pageId: string;
  /** The project the caller acts in; a page from another reads as missing. */
  readonly projectId: string;
  readonly actor: PageCommentActor;
}

// ── DTOs ────────────────────────────────────────────────────────────────────

/** A person as the panel shows them — the work-item comment author's shape. */
export type PageCommentPersonDto = PageCommentPerson;

/** One comment, root or reply. Dates are ISO strings. */
export interface PageCommentDto {
  readonly id: string;
  readonly pageId: string;
  /** The thread's root; `null` on a root. */
  readonly parentCommentId: string | null;
  readonly author: PageCommentPersonDto;
  /** Markdown, mention tokens included. */
  readonly bodyMd: string;
  readonly editedAt: string | null;
  readonly createdAt: string;
  /** On a root: when the thread was resolved, `null` while open. Always `null` on a reply. */
  readonly resolvedAt: string | null;
  /** On a resolved root: who resolved it, `null` once that user is deleted. */
  readonly resolvedBy: PageCommentPersonDto | null;
  /**
   * On an inline root: the text it quotes. The anchor's position bytes are not
   * sent — the inline story adds what its highlight reads.
   */
  readonly anchor: { readonly quote: string } | null;
}

/** A thread: its root and every reply, oldest first. */
export interface PageCommentThreadDto extends PageCommentDto {
  readonly replies: readonly PageCommentDto[];
}

export interface PageCommentThreadsPage {
  readonly threads: readonly PageCommentThreadDto[];
  /** Pass back verbatim for the next page; `null` on the last one. */
  readonly nextCursor: string | null;
  readonly counts: PageCommentCounts;
}

export interface DeletePageCommentResult {
  readonly commentId: string;
  readonly parentCommentId: string | null;
  /** Replies removed with it — `0` for a reply. */
  readonly replyCount: number;
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** A stored comment as the panel reads it. */
export function toPageCommentDto(row: PageCommentRow): PageCommentDto {
  return {
    id: row.id,
    pageId: row.pageId,
    parentCommentId: row.parentCommentId,
    author: { id: row.author.id, name: row.author.name, image: row.author.image },
    bodyMd: row.bodyMd,
    editedAt: iso(row.editedAt),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    resolvedBy: row.resolvedBy
      ? { id: row.resolvedBy.id, name: row.resolvedBy.name, image: row.resolvedBy.image }
      : null,
    anchor: row.anchorQuote === null ? null : { quote: row.anchorQuote },
  };
}

/** A root and its replies as one thread. */
export function toPageCommentThreadDto(
  root: PageCommentRow,
  replies: readonly PageCommentRow[],
): PageCommentThreadDto {
  return { ...toPageCommentDto(root), replies: replies.map(toPageCommentDto) };
}

// ── The cursor codec (pure) ─────────────────────────────────────────────────

/** What a cursor carries: the list it was issued for, and the last root it served. */
export interface PageCommentCursor {
  readonly status: PageCommentThreadStatus;
  readonly order: PageCommentOrder;
  readonly key: PageCommentRootKey;
}

const toBase64Url = (text: string): string =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromBase64Url = (text: string): string => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
};

/** An opaque, URL-safe cursor. Its payload is ASCII only (an ISO time and a cuid). */
export function encodePageCommentCursor(cursor: PageCommentCursor): string {
  return toBase64Url(
    JSON.stringify({
      s: cursor.status,
      o: cursor.order,
      t: cursor.key.at.toISOString(),
      i: cursor.key.id,
    }),
  );
}

/** The cursor `encodePageCommentCursor` issued; anything else is `PageCommentCursorInvalidError`. */
export function decodePageCommentCursor(raw: string): PageCommentCursor {
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(raw));
  } catch {
    throw new PageCommentCursorInvalidError();
  }
  if (typeof payload !== 'object' || payload === null) throw new PageCommentCursorInvalidError();
  const { s, o, t, i } = payload as Record<string, unknown>;
  if (s !== 'open' && s !== 'resolved') throw new PageCommentCursorInvalidError();
  if (o !== 'asc' && o !== 'desc') throw new PageCommentCursorInvalidError();
  if (typeof t !== 'string' || typeof i !== 'string' || i.length === 0) {
    throw new PageCommentCursorInvalidError();
  }
  const at = new Date(t);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== t) {
    throw new PageCommentCursorInvalidError();
  }
  return { status: s, order: o, key: { at, id: i } };
}

/** The key a root is listed by in a list of `status`. */
function rootKey(row: PageCommentRow, status: PageCommentThreadStatus): PageCommentRootKey {
  return { at: status === 'open' ? row.createdAt : (row.resolvedAt ?? row.createdAt), id: row.id };
}

// ── Shared checks ───────────────────────────────────────────────────────────

/** Validate a body: a blank one (whitespace only) is refused; the text is kept as written. */
function requireBody(bodyMd: string): string {
  if (bodyMd.trim().length === 0) throw new PageCommentBodyEmptyError();
  return bodyMd;
}

function requireAnchor(anchor: PageCommentAnchorInput | undefined): PageCommentAnchorInput | null {
  if (anchor === undefined) return null;
  if (anchor.bytes.length === 0) throw new PageCommentAnchorInvalidError('empty_bytes');
  if (anchor.quote.trim().length === 0) throw new PageCommentAnchorInvalidError('blank_quote');
  return anchor;
}

/** A read: the page, archived or not, in the caller's project. */
async function readablePage(store: PageStore, scope: PageCommentScope): Promise<PageRow> {
  const page = await store.findPage(scope.pageId);
  if (!page || page.projectId !== scope.projectId) throw new PageNotFoundError(scope.pageId);
  return page;
}

/** A write: the page under its row lock, in the caller's project, and live. */
async function writablePage(store: PageStore, scope: PageCommentScope): Promise<PageRow> {
  const page = await store.lockPage(scope.pageId);
  if (!page || page.projectId !== scope.projectId) throw new PageNotFoundError(scope.pageId);
  if (page.archivedAt !== null) throw new PageArchivedError(page.id);
  return page;
}

/** A comment of THIS page under its row lock. */
async function lockedComment(
  store: PageStore,
  page: PageRow,
  commentId: string,
): Promise<PageCommentRow> {
  const comment = await store.lockPageComment(commentId);
  if (!comment || comment.pageId !== page.id) throw new PageCommentNotFoundError(commentId);
  return comment;
}

function assertMayChange(
  comment: PageCommentRow,
  actor: PageCommentActor,
  action: 'edit' | 'delete',
): void {
  if (comment.authorId !== actor.userId && !actor.canModerate) {
    throw new PageCommentForbiddenError(action);
  }
}

function assertRoot(comment: PageCommentRow): void {
  if (comment.parentCommentId !== null) throw new PageCommentNotRootError(comment.id);
}

async function threadOf(store: PageStore, root: PageCommentRow): Promise<PageCommentThreadDto> {
  return toPageCommentThreadDto(root, await store.findPageCommentReplies([root.id]));
}

// ── List ────────────────────────────────────────────────────────────────────

export interface ListPageCommentThreadsInput extends PageCommentScope {
  readonly status: PageCommentThreadStatus;
  /**
   * The direction along the list's key. Open threads default to oldest first
   * (`asc` on `createdAt`), resolved threads to most recently resolved first
   * (`desc` on `resolvedAt`). Both directions scan the same partial index.
   */
  readonly order?: PageCommentOrder;
  /** A `nextCursor` this list returned. */
  readonly cursor?: string | null;
  /** Defaults to 20; clamped to 1–50. */
  readonly limit?: number;
}

export function pageCommentThreadsLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAGE_COMMENT_THREADS_DEFAULT_LIMIT;
  return Math.min(PAGE_COMMENT_THREADS_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** One page of a page's open or resolved threads, each with all its replies, and both counts. */
export async function listPageCommentThreads(
  store: PageStore,
  input: ListPageCommentThreadsInput,
): Promise<PageCommentThreadsPage> {
  const order = input.order ?? (input.status === 'open' ? 'asc' : 'desc');
  const cursor =
    input.cursor === undefined || input.cursor === null
      ? null
      : decodePageCommentCursor(input.cursor);
  if (cursor && (cursor.status !== input.status || cursor.order !== order)) {
    throw new PageCommentCursorInvalidError();
  }
  const limit = pageCommentThreadsLimit(input.limit);
  const page = await readablePage(store, input);

  const rows = await store.findPageCommentRoots({
    pageId: page.id,
    status: input.status,
    order,
    after: cursor?.key ?? null,
    limit: limit + 1,
  });
  const roots = rows.slice(0, limit);
  const replies =
    roots.length > 0 ? await store.findPageCommentReplies(roots.map((r) => r.id)) : [];
  const byRoot = new Map<string, PageCommentRow[]>();
  for (const reply of replies) {
    const list = byRoot.get(reply.parentCommentId!) ?? [];
    list.push(reply);
    byRoot.set(reply.parentCommentId!, list);
  }
  const last = roots.at(-1);
  return {
    threads: roots.map((root) => toPageCommentThreadDto(root, byRoot.get(root.id) ?? [])),
    nextCursor:
      rows.length > limit && last
        ? encodePageCommentCursor({ status: input.status, order, key: rootKey(last, input.status) })
        : null,
    counts: await store.countPageCommentRoots(page.id),
  };
}

// ── Create and reply ────────────────────────────────────────────────────────

export interface CreatePageCommentInput extends PageCommentScope {
  readonly bodyMd: string;
  /** An inline thread's anchor; absent for a page-level comment. */
  readonly anchor?: PageCommentAnchorInput;
}

/** Start a thread on a page. */
export async function createPageComment(
  store: PageStore,
  clock: Clock,
  input: CreatePageCommentInput,
): Promise<PageCommentThreadDto> {
  const bodyMd = requireBody(input.bodyMd);
  const anchor = requireAnchor(input.anchor);
  const page = await writablePage(store, input);
  const row = await store.insertPageComment({
    workspaceId: page.workspaceId,
    projectId: page.projectId,
    pageId: page.id,
    authorId: input.actor.userId,
    parentCommentId: null,
    bodyMd,
    createdAt: clock.now(),
    anchor,
  });
  return toPageCommentThreadDto(row, []);
}

/** A reply carries no anchor: it sits where its thread does. */
export interface ReplyToPageCommentInput extends PageCommentScope {
  readonly parentCommentId: string;
  readonly bodyMd: string;
}

/** Reply to a thread. The parent must be a root of the same page. */
export async function replyToPageComment(
  store: PageStore,
  clock: Clock,
  input: ReplyToPageCommentInput,
): Promise<PageCommentDto> {
  const bodyMd = requireBody(input.bodyMd);
  const page = await writablePage(store, input);
  const parent = await lockedComment(store, page, input.parentCommentId);
  if (parent.parentCommentId !== null) throw new PageCommentReplyDepthError(parent.id);
  const row = await store.insertPageComment({
    workspaceId: page.workspaceId,
    projectId: page.projectId,
    pageId: page.id,
    authorId: input.actor.userId,
    parentCommentId: parent.id,
    bodyMd,
    createdAt: clock.now(),
    anchor: null,
  });
  return toPageCommentDto(row);
}

// ── Edit and delete ─────────────────────────────────────────────────────────

export interface EditPageCommentInput extends PageCommentScope {
  readonly commentId: string;
  readonly bodyMd: string;
}

/** Edit a comment's body. The identical body writes nothing and leaves `editedAt` alone. */
export async function editPageComment(
  store: PageStore,
  clock: Clock,
  input: EditPageCommentInput,
): Promise<PageCommentDto> {
  const bodyMd = requireBody(input.bodyMd);
  const page = await writablePage(store, input);
  const comment = await lockedComment(store, page, input.commentId);
  assertMayChange(comment, input.actor, 'edit');
  if (comment.bodyMd === bodyMd) return toPageCommentDto(comment);
  return toPageCommentDto(await store.updatePageCommentBody(comment.id, bodyMd, clock.now()));
}

export interface DeletePageCommentInput extends PageCommentScope {
  readonly commentId: string;
}

/** Delete a comment; a root takes every reply with it. */
export async function deletePageComment(
  store: PageStore,
  input: DeletePageCommentInput,
): Promise<DeletePageCommentResult> {
  const page = await writablePage(store, input);
  const comment = await lockedComment(store, page, input.commentId);
  assertMayChange(comment, input.actor, 'delete');
  const replyCount =
    comment.parentCommentId === null
      ? (await store.findPageCommentReplies([comment.id])).length
      : 0;
  await store.deletePageCommentRow(comment.id);
  return { commentId: comment.id, parentCommentId: comment.parentCommentId, replyCount };
}

// ── Resolve and reopen ──────────────────────────────────────────────────────

export interface PageCommentThreadInput extends PageCommentScope {
  readonly commentId: string;
}

/**
 * Resolve a thread, recording who and when. A thread already resolved is
 * returned as it is — its first resolver and time kept — so a double click is
 * harmless.
 */
export async function resolvePageCommentThread(
  store: PageStore,
  clock: Clock,
  input: PageCommentThreadInput,
): Promise<PageCommentThreadDto> {
  const page = await writablePage(store, input);
  const root = await lockedComment(store, page, input.commentId);
  assertRoot(root);
  if (root.resolvedAt !== null) return threadOf(store, root);
  return threadOf(
    store,
    await store.setPageCommentResolved(root.id, clock.now(), input.actor.userId),
  );
}

/** Reopen a resolved thread. An open thread is returned as it is. */
export async function reopenPageCommentThread(
  store: PageStore,
  input: PageCommentThreadInput,
): Promise<PageCommentThreadDto> {
  const page = await writablePage(store, input);
  const root = await lockedComment(store, page, input.commentId);
  assertRoot(root);
  if (root.resolvedAt === null) return threadOf(store, root);
  return threadOf(store, await store.setPageCommentResolved(root.id, null, null));
}
