import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  anchorDocument,
  resolveStoredAnchor,
  PAGE_COMMENT_THREADS_DEFAULT_LIMIT,
  PAGE_COMMENT_THREADS_MAX_LIMIT,
  type PageAnchorDocument,
  type PageCommentCounts,
  type PageCommentDto,
  type PageCommentPersonDto,
  type PageCommentThreadDto,
} from '@/lib/pages';
import { fromBase64 } from '@/lib/mappers/pageMappers';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import { pagesService } from '@/lib/services/pagesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';

// `get_page_comments` (Story MOTIR-10869 · MOTIR-10978) — a page's discussion as
// an agent reads it: BOTH of its lists, open and resolved, in one call, each with
// its own cursor, plus the counts. Every read goes through `pageCommentsService`,
// so the `page:view` gate, the archived-page rule and the reply depth stay the
// service's, and an agent sees exactly the panel's discussion.
//
// THE ONE COMPUTATION is the anchored verdict. A root that quoted a passage is
// resolved against the page's CURRENT stored `bodyState` (`docs/decisions/pages.md`
// §8.3): `true` while the passage is still in the page, `false` once it has gone
// (its quote kept, listed among the page-level threads, as the panel does), and
// `null` on a comment that never had a passage — so "never inline" and "was
// inline, now gone" stay apart. The page is read once, only when some answered
// root carries a passage, and nothing is written back.
//
// Every refusal (`PAGE_NOT_FOUND`, `PAGE_COMMENT_CURSOR_INVALID`, …) extends
// `PageError`, which `toToolError` already maps by its own code — no branch here.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): `/api/v1` publishes
// no page-comments resource.

export const GET_PAGE_COMMENTS_TOOL_NAME = 'get_page_comments';

const cursorField = (list: 'open' | 'resolved') =>
  z
    .string()
    .min(1)
    .optional()
    .describe(
      `The \`${list}.nextCursor\` a previous call returned — pages the ${list.toUpperCase()} list only. ` +
        'A cursor issued for the other list is refused `PAGE_COMMENT_CURSOR_INVALID`.',
    );

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Threads per list (default ${PAGE_COMMENT_THREADS_DEFAULT_LIMIT}, at most ` +
        `${PAGE_COMMENT_THREADS_MAX_LIMIT}; a larger number is clamped).`,
    ),
  openCursor: cursorField('open'),
  resolvedCursor: cursorField('resolved'),
};

// ── The view ────────────────────────────────────────────────────────────────

/** One comment, root or reply, as this tool (and `add_page_comment`) returns it. */
export interface PageCommentView {
  readonly id: string;
  /** The thread's root; `null` on a root. */
  readonly parentCommentId: string | null;
  readonly author: PageCommentPersonDto;
  /** Markdown, mention tokens exactly as written. */
  readonly bodyMd: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  /** On a resolved root: when; `null` while open and on every reply. */
  readonly resolvedAt: string | null;
  /** On a resolved root: who; `null` while open, on every reply, and once that user is deleted. */
  readonly resolvedBy: PageCommentPersonDto | null;
  /** On an inline root: the text it quoted when the thread was started; else `null`. */
  readonly quote: string | null;
  /**
   * On an inline root: whether the passage is still in the page — `true` while it
   * resolves, `false` once it is gone. `null` on a comment that never had one.
   */
  readonly anchored: boolean | null;
}

export interface PageCommentThreadView extends PageCommentView {
  readonly replies: readonly PageCommentView[];
}

export interface PageCommentListView {
  readonly threads: readonly PageCommentThreadView[];
  /** Pass back as this list's cursor for its next page; `null` on the last one. */
  readonly nextCursor: string | null;
}

export interface PageCommentsView {
  readonly pageId: string;
  readonly counts: PageCommentCounts;
  readonly open: PageCommentListView;
  readonly resolved: PageCommentListView;
}

/**
 * A comment as the tools return it. `anchored` is the caller's: the verdict the
 * read computed for a root with a passage, `null` for one without and for a
 * reply. The raw anchor bytes are not published — the quote and the verdict are
 * what an agent can use.
 */
export function toPageCommentView(
  comment: PageCommentDto,
  anchored: boolean | null,
): PageCommentView {
  return {
    id: comment.id,
    parentCommentId: comment.parentCommentId,
    author: { id: comment.author.id, name: comment.author.name, image: comment.author.image },
    bodyMd: comment.bodyMd,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    resolvedAt: comment.resolvedAt,
    resolvedBy: comment.resolvedBy,
    quote: comment.anchor?.quote ?? null,
    anchored: comment.anchor ? anchored : null,
  };
}

/**
 * The verdict for one root against the ONE document the read decoded: `null`
 * without a passage, otherwise whether its stored pair still covers text.
 * Unreadable bytes, or no document to read them against, answer `false` — one
 * bad row renders as a page-level thread, it never fails the read.
 */
export function anchoredVerdict(
  comment: PageCommentDto,
  document: PageAnchorDocument | null,
): boolean | null {
  if (comment.anchor === null) return null;
  if (document === null) return false;
  const range = resolveStoredAnchor(
    fromBase64(comment.anchor.bytes),
    document,
    comment.anchor.quote,
  );
  return range !== null;
}

/** A thread as the tool returns it: the root with its verdict, replies one level deep. */
export function toPageCommentThreadView(
  thread: PageCommentThreadDto,
  document: PageAnchorDocument | null,
): PageCommentThreadView {
  return {
    ...toPageCommentView(thread, anchoredVerdict(thread, document)),
    replies: thread.replies.map((reply) => toPageCommentView(reply, null)),
  };
}

// ── The text render ─────────────────────────────────────────────────────────

const personName = (person: PageCommentPersonDto) => person.name || person.id;

/** Indent every line of a block by `pad`. */
const indent = (text: string, pad: string) =>
  text
    .split('\n')
    .map((line) => (line.length ? `${pad}${line}` : line))
    .join('\n');

/**
 * One comment as text: a heading line carrying its comment id (what
 * a reply to the thread names), author and times, the quote when it had
 * one, then its markdown body verbatim.
 */
export function renderPageCommentText(view: PageCommentView): string {
  const head = [
    `[comment ${view.id}]`,
    `${personName(view.author)} (${view.author.id})`,
    view.createdAt,
    view.editedAt ? `edited ${view.editedAt}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [head];
  if (view.resolvedAt) {
    lines.push(
      `resolved ${view.resolvedAt}` +
        (view.resolvedBy ? ` by ${personName(view.resolvedBy)} (${view.resolvedBy.id})` : ''),
    );
  }
  if (view.quote !== null) {
    lines.push(
      view.anchored
        ? `on the passage: > ${view.quote}`
        : `its passage is no longer in the page; it quoted: > ${view.quote}`,
    );
  }
  lines.push(indent(view.bodyMd, '  '));
  return lines.join('\n');
}

function renderThread(thread: PageCommentThreadView): string {
  const replies = thread.replies.map(
    (reply) => `  ↳ reply ${indent(renderPageCommentText(reply), '    ').trimStart()}`,
  );
  return [`- ${renderPageCommentText(thread)}`, ...replies].join('\n');
}

function renderList(
  label: 'Open' | 'Resolved',
  cursorArg: 'openCursor' | 'resolvedCursor',
  total: number,
  list: PageCommentListView,
): string {
  const lines = [`## ${label} — showing ${list.threads.length} of ${total}`];
  if (list.threads.length === 0) lines.push('', 'No threads.');
  const inline = list.threads.filter((t) => t.anchored === true);
  const pageLevel = list.threads.filter((t) => t.anchored !== true);
  if (inline.length) lines.push('', '### On a passage', '', ...inline.map(renderThread));
  if (pageLevel.length) lines.push('', '### Page-level', '', ...pageLevel.map(renderThread));
  if (list.nextCursor !== null) {
    lines.push('', `More ${label.toLowerCase()} threads: pass ${cursorArg} "${list.nextCursor}".`);
  }
  return lines.join('\n');
}

/** The page's discussion as text: both lists, each split into inline and page-level threads. */
export function renderPageCommentsText(view: PageCommentsView): string {
  return [
    `# Discussion on page ${view.pageId} — ${view.counts.open} open, ${view.counts.resolved} resolved`,
    'To reply to a thread, name its root’s comment id.',
    '',
    renderList('Open', 'openCursor', view.counts.open, view.open),
    '',
    renderList('Resolved', 'resolvedCursor', view.counts.resolved, view.resolved),
  ].join('\n');
}

// ── The adapter ─────────────────────────────────────────────────────────────

/**
 * Resolve the project by key, read both lists (in parallel — each opens its own
 * read-only transaction), read the page's stored body only when a root carries a
 * passage, and compute each root's verdict against that one document.
 */
export async function runGetPageComments(
  args: {
    projectKey: string;
    pageId: string;
    limit?: number;
    openCursor?: string;
    resolvedCursor?: string;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    const scope = { projectId: project.id, pageId: args.pageId, limit: args.limit };
    const [open, resolved] = await Promise.all([
      pageCommentsService.listPageThreads(ctx, {
        ...scope,
        status: 'open',
        cursor: args.openCursor ?? null,
      }),
      pageCommentsService.listPageThreads(ctx, {
        ...scope,
        status: 'resolved',
        cursor: args.resolvedCursor ?? null,
      }),
    ]);
    const anyAnchor = [...open.threads, ...resolved.threads].some((t) => t.anchor !== null);
    const document = anyAnchor
      ? anchorDocument(
          fromBase64(
            (await pagesService.getPage(ctx, { projectId: project.id, pageId: args.pageId }))
              .bodyState,
          ),
        )
      : null;
    const view: PageCommentsView = {
      pageId: args.pageId,
      // One answer's counts, so the two lists can never disagree about the totals.
      counts: { open: open.counts.open, resolved: open.counts.resolved },
      open: {
        threads: open.threads.map((t) => toPageCommentThreadView(t, document)),
        nextCursor: open.nextCursor,
      },
      resolved: {
        threads: resolved.threads.map((t) => toPageCommentThreadView(t, document)),
        nextCursor: resolved.nextCursor,
      },
    };
    return toolOk(renderPageCommentsText(view), exempt(GET_PAGE_COMMENTS_TOOL_NAME, { ...view }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetPageComments(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_PAGE_COMMENTS_TOOL_NAME,
    {
      title: 'Get page comments',
      description:
        'Read the discussion on one page of a project — BOTH of its lists in one call: `open` ' +
        'and `resolved`, each `{ threads, nextCursor }`, plus `counts` ({ open, resolved }). A ' +
        'thread is its root comment and its replies one level deep; every comment carries its ' +
        '`id`, `author` (id, name, image), `createdAt`, `editedAt` and `bodyMd` (markdown, ' +
        'mention tokens as written), and a root carries `resolvedAt` / `resolvedBy`. A root ' +
        'started on a passage carries its `quote` and `anchored`: true while the passage is ' +
        'still in the page, false once it has been deleted (the thread is then page-level); a ' +
        'page-level comment has no quote and `anchored: null`. Address the page as `get_page` ' +
        'does. Each list pages on its OWN cursor: pass `openCursor` / `resolvedCursor` from ' +
        'that list’s `nextCursor`; `limit` is per list (default 20, at most 50). A root’s ' +
        'comment `id` is what a reply to its thread names. Refusals: ' +
        '`PAGE_NOT_FOUND` (an unknown page, or one in another project), ' +
        '`PAGE_COMMENT_CURSOR_INVALID`. Read-only. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runGetPageComments(args, resolveContext(extra)),
  );
}
