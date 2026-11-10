import type {
  DeletePageCommentResult,
  PageCommentDto,
  PageCommentOrder,
  PageCommentThreadDto,
  PageCommentThreadsPage,
  PageCommentThreadStatus,
} from '@/lib/pages';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// The page discussion's NETWORK HELPERS (Story MOTIR-10866 · MOTIR-10874): one
// typed call per comment route under `/api/pages/<id>/comments`. Directive-free
// and type-only on the server side — the DTOs are `import type` from the page
// package's app entry, so nothing server-side enters the client bundle.
//
// Every helper RESOLVES — it never throws. A 2xx answers `{ ok: true, data }`
// with the route's DTO; anything else answers the route's typed refusal
// `{ ok: false, status, code, message }` (the body's `code` and `error`), and a
// request that never reached the server is `status: 0`, `code: 'NETWORK'`. The
// panel decides what each refusal reads as; this file decides nothing.

/** What the caller may do on this page's discussion, as the list read answers it. */
export interface PageDiscussionCapabilities {
  readonly canComment: boolean;
  readonly canModerate: boolean;
}

/** `GET …/comments` — one page of threads, both counts and the caller's capabilities. */
export interface PageDiscussionList extends PageCommentThreadsPage {
  readonly capabilities: PageDiscussionCapabilities;
  /** The work items these threads link, so each `motir:` token draws as a card chip. */
  readonly workItemRefs: WorkItemRefMap;
}

export interface PageCommentRefusal {
  readonly ok: false;
  /** The HTTP status, or `0` when the request never reached the server. */
  readonly status: number;
  /** The refusal's `code` (`PAGE_ARCHIVED`, `PAGE_COMMENT_REPLY_DEPTH_EXCEEDED`, …), or `null`. */
  readonly code: string | null;
  readonly message: string;
}

export type PageCommentResult<T> = { readonly ok: true; readonly data: T } | PageCommentRefusal;

export interface ListPageCommentsQuery {
  status: PageCommentThreadStatus;
  order?: PageCommentOrder;
  cursor?: string | null;
}

function commentsPath(pageId: string, ...rest: string[]): string {
  const tail = rest.map((part) => `/${encodeURIComponent(part)}`).join('');
  return `/api/pages/${encodeURIComponent(pageId)}/comments${tail}`;
}

async function call<T>(url: string, init?: RequestInit): Promise<PageCommentResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK',
      message: err instanceof Error ? err.message : 'Network error',
    };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.ok) return { ok: true, data: body as T };
  const refusal = (body ?? {}) as { code?: unknown; error?: unknown };
  return {
    ok: false,
    status: res.status,
    code: typeof refusal.code === 'string' ? refusal.code : null,
    message: typeof refusal.error === 'string' ? refusal.error : `HTTP ${res.status}`,
  };
}

function sendJson(method: 'POST' | 'PATCH', payload: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

/** One page of the open or resolved threads; pass `cursor` back for the next. */
export function listPageComments(
  pageId: string,
  query: ListPageCommentsQuery,
): Promise<PageCommentResult<PageDiscussionList>> {
  const params = new URLSearchParams({ status: query.status });
  if (query.order) params.set('order', query.order);
  if (query.cursor) params.set('cursor', query.cursor);
  return call(`${commentsPath(pageId)}?${params}`);
}

/** Start a page-level thread — the new thread, open, with no replies. */
export function createPageComment(
  pageId: string,
  bodyMd: string,
): Promise<PageCommentResult<PageCommentThreadDto>> {
  return call(commentsPath(pageId), sendJson('POST', { bodyMd }));
}

/** Reply to a thread's root — the new reply. */
export function replyToPageComment(
  pageId: string,
  rootId: string,
  bodyMd: string,
): Promise<PageCommentResult<PageCommentDto>> {
  return call(commentsPath(pageId, rootId, 'replies'), sendJson('POST', { bodyMd }));
}

/** Replace a comment's body — the comment, `editedAt` set. */
export function editPageComment(
  pageId: string,
  commentId: string,
  bodyMd: string,
): Promise<PageCommentResult<PageCommentDto>> {
  return call(commentsPath(pageId, commentId), sendJson('PATCH', { bodyMd }));
}

/** Delete a comment — a root takes its replies with it. */
export function deletePageComment(
  pageId: string,
  commentId: string,
): Promise<PageCommentResult<DeletePageCommentResult>> {
  return call(commentsPath(pageId, commentId), { method: 'DELETE' });
}

/** Resolve a thread — the thread, `resolvedAt` and `resolvedBy` set. */
export function resolvePageCommentThread(
  pageId: string,
  rootId: string,
): Promise<PageCommentResult<PageCommentThreadDto>> {
  return call(commentsPath(pageId, rootId, 'resolution'), { method: 'POST' });
}

/** Reopen a resolved thread — the thread, open again. */
export function reopenPageCommentThread(
  pageId: string,
  rootId: string,
): Promise<PageCommentResult<PageCommentThreadDto>> {
  return call(commentsPath(pageId, rootId, 'resolution'), { method: 'DELETE' });
}
