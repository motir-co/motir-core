import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pageCommentsService } from '@/lib/services/pageCommentsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { pageIdField, pageProjectKeyField, resolvePageProject } from './pageRef';
import { renderPageCommentText, toPageCommentView } from './getPageComments';

// `add_page_comment` (Story MOTIR-10869 · MOTIR-10979) — an agent takes part in a
// page's discussion: a new page-level thread, or a reply under an existing one.
// A thin adapter over `pageCommentsService` — `postPageComment` without a root
// id, `postPageReply` with one — so the `page:view`-then-`comment:add` gate, the
// archived-page rule, the one-level reply rule, mention notifications and the
// transaction that leaves no row on a refusal are all the service's, exactly as
// from the page's discussion panel. No business logic here.
//
// The body passes through UNTOUCHED: a `[@Name](mention:<userId>)` token is not
// parsed, rewritten or escaped here — what a mention means is the service's.
//
// The answer goes through the read tool's own `toPageCommentView` with a `null`
// anchored verdict (this tool takes no anchor, so what it posts is always
// page-level or a reply), so a comment an agent posts and one `get_page_comments`
// reads are ONE shape.
//
// Every refusal (`PAGE_NOT_FOUND`, `PAGE_ARCHIVED`, `PAGE_COMMENT_*`) extends
// `PageError`, and `PermissionDeniedError` has its own arm — `toToolError`
// already maps each by its code, so there is no branch here or there.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): `/api/v1` publishes
// no page-comments resource.

export const ADD_PAGE_COMMENT_TOOL_NAME = 'add_page_comment';

const inputSchema = {
  projectKey: pageProjectKeyField,
  pageId: pageIdField,
  body: z
    .string()
    .min(1)
    .describe(
      'The comment body (Markdown), stored exactly as sent. Mention a member with ' +
        '[@Name](mention:<userId>); the mentioned member is notified.',
    ),
  rootCommentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The `id` of a thread’s ROOT comment on the same page to REPLY to — a thread ' +
        'is one level deep, so a reply’s id is refused. Omit it to start a new page-level thread.',
    ),
};

/** The adapter: resolve the project by key, then post the comment or the reply. */
export async function runAddPageComment(
  args: { projectKey: string; pageId: string; body: string; rootCommentId?: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await resolvePageProject(args.projectKey, ctx);
    // ⚠️ `pageCommentsService` takes the CONTEXT FIRST — `(ctx, input)` — unlike
    // `commentsService.addComment(itemId, input, ctx)`, whose shape `add_comment` uses.
    const scope = { projectId: project.id, pageId: args.pageId };
    const comment = args.rootCommentId
      ? await pageCommentsService.postPageReply(ctx, {
          ...scope,
          parentCommentId: args.rootCommentId,
          bodyMd: args.body,
        })
      : await pageCommentsService.postPageComment(ctx, { ...scope, bodyMd: args.body });
    // Both answers extend `PageCommentDto`; the thread's empty `replies` and the
    // panel's work-item chip map are not part of the comment shape.
    const view = toPageCommentView(comment, null);
    const head = view.parentCommentId
      ? `Replied on page ${args.pageId} in thread ${view.parentCommentId} · comment id: ${view.id}`
      : `Commented on page ${args.pageId} · comment id: ${view.id}`;
    return toolOk(
      `${head}\n${renderPageCommentText(view)}`,
      exempt(ADD_PAGE_COMMENT_TOOL_NAME, { ...view }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerAddPageComment(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    ADD_PAGE_COMMENT_TOOL_NAME,
    {
      title: 'Add page comment',
      description:
        'Post a Markdown comment on one page of a project as the token owner, through the same ' +
        'service the page’s discussion panel uses. Address the page as `get_page` does ' +
        '(`projectKey` + `pageId`). Without `rootCommentId` it starts a new page-level thread; ' +
        'with a thread’s root comment `id` (as `get_page_comments` lists it) it REPLIES under ' +
        'that thread, one level deep. The `body` is stored exactly as sent — a ' +
        '[@Name](mention:<userId>) token is passed through and notifies that member. Returns ' +
        'the written comment in the shape `get_page_comments` reads one: `id`, ' +
        '`parentCommentId`, `author`, `bodyMd`, `createdAt`, `editedAt`, with the resolve and ' +
        'passage fields null. A repeat posts a second comment. Refusals, each writing ' +
        'nothing: `PAGE_NOT_FOUND` (an unknown page, or one in another project), ' +
        '`PAGE_ARCHIVED`, `PAGE_COMMENT_NOT_FOUND` (an unknown thread, or one on another ' +
        'page), `PAGE_COMMENT_REPLY_DEPTH_EXCEEDED` (a reply to a reply), ' +
        '`PAGE_COMMENT_BODY_EMPTY` (a blank body), and `PERMISSION_DENIED` without ' +
        '`comment:add`. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runAddPageComment(args, resolveContext(extra)),
  );
}
