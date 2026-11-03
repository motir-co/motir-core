import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CommentDTO } from '@/lib/dto/comments';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { addCommentPayload, presentMcpComment } from '../payloads/workItems';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `add_comment` (Story 7.8 · Subtask 7.8.5) — post a Markdown comment on a work
// item as the token's owning user. A thin adapter over `commentsService.
// addComment` (5.1.2): server-side mention parsing, `comment_mention` rows, the
// auto-watch, and the `work-item/comment.created` job event all fire EXACTLY as
// from the UI — a mention in an agent's comment emails the mentioned user
// (5.1.6) with zero MCP-specific wiring. No business logic here.
//
// `parentCommentId` (MOTIR-10233) makes it a REPLY — the service's single-level
// thread rule (a root on the same item) is the only check, exactly as in the UI.

export const ADD_COMMENT_TOOL_NAME = 'add_comment';

const inputSchema = {
  key: workItemKeyField,
  body: z
    .string()
    .min(1)
    .describe('The comment body (Markdown). Mention a member with @[name](userId).'),
  parentCommentId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. The `id` of a comment on the SAME work item to REPLY to — a top-level ' +
        'comment, since a thread is one level deep. Omit it for a new top-level comment. ' +
        'A comment on another work item, or a reply, is refused.',
    ),
};

/** Compact human-readable summary of a newly-created comment. */
function summarize(identifier: string, comment: CommentDTO): string {
  const excerpt = comment.bodyMd.length > 280 ? comment.bodyMd.slice(0, 280) + '…' : comment.bodyMd;
  const mentions =
    comment.mentionedUserIds.length > 0 ? ` · mentioned ${comment.mentionedUserIds.length}` : '';
  return [`Commented on ${identifier} as ${comment.author.name}${mentions}`, excerpt].join('\n');
}

/** The adapter: resolve project + item by key, then add the comment. */
export async function runAddComment(
  args: { key: string; body: string; parentCommentId?: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    // A REPLY (MOTIR-10233): the service checks the parent sits on THIS item and is a
    // root, the same rules the item page's reply box meets.
    const comment = await commentsService.addComment(
      item.id,
      {
        bodyMd: args.body,
        ...(args.parentCommentId ? { parentCommentId: args.parentCommentId } : {}),
      },
      ctx,
    );
    return toolOk(
      summarize(item.identifier, comment),
      derived(addCommentPayload, presentMcpComment(comment)),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerAddComment(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    ADD_COMMENT_TOOL_NAME,
    {
      title: 'Add comment',
      description:
        'Post a Markdown comment on a work item (by identifier, e.g. "ACME-7") as the token ' +
        'owner. Mentions notify the mentioned member. Pass `parentCommentId` to REPLY to a ' +
        'top-level comment on the same item. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runAddComment(args, resolveContext(extra)),
  );
}
