import { z } from 'zod';
import { reviewCommitsLabel } from '@/lib/agentReview/verdictActivity';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { activityService } from '@/lib/services/activityService';
import { commentsService } from '@/lib/services/commentsService';
import type {
  ActivityAllPageDto,
  ActivityEntryDto,
  ActivityEntryPartDto,
  ActivityHistoryPageDto,
  ActivityValueDto,
} from '@/lib/dto/activity';
import type { CommentDTO, CommentThreadDTO, CommentsPageDTO } from '@/lib/dto/comments';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { activityPagePayload } from '../payloads/workLoop';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `get_work_item_activity` (MOTIR-1999) — read a work item's COMMENTS and its
// ACTIVITY trail. The write half of this pair (`add_comment`, 7.8.5) has
// shipped since the MCP surface existed; nothing on it ever read one back, so
// an agent could write a rationale onto a card and never see it again — most
// pointedly the REPLAN ACTION's own archive rationale, which is written over
// MCP and was then unreadable over MCP.
//
// One adapter over the THREE shipped service reads the product's own Activity
// tabs use (Story 5.5), selected by `view`:
//
//   view: 'all' (default) → activityService.listAll      → ActivityAllPageDto
//   view: 'comments'      → commentsService.listComments → CommentsPageDTO
//   view: 'history'       → activityService.listHistory  → ActivityHistoryPageDto
//
// The narrow two are the mirror-product shape (Jira's `/issue/{key}/comment` +
// `/issue/{key}/changelog`, Linear's `issue.comments` + `issue.history`); `all`
// is the merged stream neither has and Motir already built.
//
// NO new query, NO re-projection, NO new DTO: the same services the
// session-authenticated routes under `app/api/work-items/[id]/…` call, so the
// view gate, the 404-not-403 cross-tenant contract, the capability checks and
// the comment-visibility semantics all come along unchanged — exactly as
// `add_comment` inherits them from `commentsService.addComment`. The three
// shipped page shapes cross the tool boundary verbatim (MOTIR-1856 later
// re-derives them from the v1 response schemas; reusing them here is what makes
// that possible).
//
// PAGING is pass-through in both directions. `cursor` goes to the service
// untouched and its `nextCursor` comes back untouched — the `all` cursor is an
// OPAQUE composite carrying both sources' positions (`decodeAllCursor`), so
// this tool must never construct, parse or merge one, and never loops to drain
// the stream. A SHORT page with a non-null cursor is documented normal for
// `all` and `history` (the bounded noise scan), which is why the summary says
// "More available" rather than implying the page is the whole story.
//
// TRUNCATION: none. MOTIR-1709 was exactly this defect on `get_work_item` — a
// `descriptionMd` cut to 500 chars in the text block — and an agent reading a
// truncated rationale is worse off than one that knows it must page. The
// structured payload is the service's page verbatim, and the text block renders
// every comment body in FULL. The only thing the text form abbreviates is a
// history entry's body-field edit, and that is the DTO's own shape
// (`fieldEdited` deliberately carries no text), reported as "(body not shown)".

export const GET_WORK_ITEM_ACTIVITY_TOOL_NAME = 'get_work_item_activity';

/** The three views, mirroring the Activity section's three tabs. */
const VIEWS = ['all', 'comments', 'history'] as const;
type ActivityView = (typeof VIEWS)[number];

const inputSchema = {
  key: workItemKeyField,
  view: z
    .enum(VIEWS)
    .optional()
    .describe(
      'Which stream to read: "all" (default) — comments and history interleaved in ' +
        'timestamp order; "comments" — comment threads with their replies; "history" — ' +
        'the change trail only.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      "Opaque continuation token from a previous call's nextCursor. Echo it back " +
        'verbatim; never construct or parse one.',
    ),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe(
      'Page-walk direction. Omit for each view\'s shipped default ("desc" — newest ' +
        'first — for "all" and "history"; "asc" for "comments", the Jira default sort).',
    ),
};

export interface GetWorkItemActivityArgs {
  key: string;
  view?: ActivityView;
  cursor?: string;
  order?: 'asc' | 'desc';
}

/** One page of any of the three views — the union the tool returns. */
export type ActivityToolPage = ActivityAllPageDto | CommentsPageDTO | ActivityHistoryPageDto;

// ─────────────────────────── the text rendering ───────────────────────────

/** One side of a change, in its display form (the resolved label, never a bare
 *  id when the referent still exists). Total over `ActivityValueDto`. */
function valueText(value: ActivityValueDto): string {
  switch (value.type) {
    case 'none':
      return '—';
    case 'text':
      return value.text;
    case 'status':
      return value.label ?? value.key;
    case 'user':
      return value.name ?? value.userId;
    case 'date':
      return value.date;
    case 'sprint':
      return value.name ?? value.sprintId;
    case 'issue':
      return value.identifier ?? value.workItemId;
  }
}

/** One renderable piece of a history entry as a sentence fragment. Total over
 *  `ActivityEntryPartDto` — an unknown diff key already arrives as `generic`
 *  (the registry's mistake-#29 fallback), so there is no default branch. */
function partText(part: ActivityEntryPartDto): string {
  switch (part.kind) {
    case 'created':
      return 'created the item';
    case 'archived':
      return 'archived the item';
    case 'unarchived':
      return 'restored the item';
    case 'field':
      return `changed ${part.field}: ${valueText(part.from)} → ${valueText(part.to)}`;
    // The trail records THAT a body field changed, never its text (the 5.5.1
    // DTO carries none) — said plainly so this never reads as a truncation.
    case 'fieldEdited':
      return `edited ${part.field} (body not shown — the history trail records no text)`;
    case 'link':
      return `${part.op} ${part.linkKind} link → ${valueText(part.target)}`;
    case 'collection':
      return `${part.op} ${part.field}: ${part.items.join(', ')}`;
    case 'commentDeleted':
      return `deleted a comment by ${valueText(part.author)} (${part.replyCount} replies)`;
    case 'generic':
      return `${part.key}: ${part.from ?? '—'} → ${part.to ?? '—'}`;
    // An agent's verdict (MOTIR-10338): what it said, whether it decided anything, which
    // commits it read, and who ran it — the findings in full for an agent reading the card.
    case 'agentVerdict': {
      const agent = part.hosted ? 'Motir agent' : `${part.harness} (${part.model})`;
      const said = part.verdict === 'pass' ? 'passed the review' : 'asked for changes';
      const decided =
        part.outcome === 'late'
          ? ' — late: it decided nothing'
          : part.outcome === 'second'
            ? ' — a second review: it decided nothing'
            : '';
      const findings = part.findingsExcerpt
        ? `\n    findings:\n    ${part.findingsExcerpt.split('\n').join('\n    ')}`
        : '';
      return `agent verdict: ${agent} ${said} at ${reviewCommitsLabel(part.subjectVersion)}${decided}${findings}`;
    }
    // A person dismissed the agent's send-back (MOTIR-10434): at which commits, and why.
    case 'reviewDismissed':
      return `dismissed the agent's review at ${reviewCommitsLabel(part.subjectVersion)}\n    reason: ${part.reasonMd.split('\n').join('\n    ')}`;
  }
}

/** A history entry as one line: who, when, and every part. */
function historyText(entry: ActivityEntryDto): string {
  const who = entry.actor.name ?? entry.actor.userId;
  return `[change] ${entry.changedAt} · ${who} ${entry.parts.map(partText).join('; ')}`;
}

/** A comment in FULL — body verbatim, never excerpted (the MOTIR-1709 rule).
 *  The body is indented under its header so a multi-line Markdown comment stays
 *  visually attached to its author without a single character being dropped. */
function commentBlock(comment: CommentDTO, prefix: string): string {
  const edited = comment.editedAt === null ? '' : ' (edited)';
  const indent = ' '.repeat(prefix.length);
  const header = `${prefix}${comment.createdAt} · ${comment.author.name}${edited}:`;
  const body = comment.bodyMd
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
  return `${header}\n${body}`;
}

/** A root comment plus its single-level replies, all bodies in full. */
function threadText(thread: CommentThreadDTO): string {
  return [
    commentBlock(thread, '[comment] '),
    ...thread.replies.map((reply) => commentBlock(reply, '    ↳ reply ')),
  ].join('\n');
}

/** The lines of the page's body, one block per entry, in the page's order. */
function pageLines(view: ActivityView, page: ActivityToolPage): string[] {
  if (view === 'comments') {
    return (page as CommentsPageDTO).threads.map(threadText);
  }
  if (view === 'history') {
    return (page as ActivityHistoryPageDto).entries.map(historyText);
  }
  return (page as ActivityAllPageDto).entries.map((entry) =>
    entry.type === 'comment' ? threadText(entry.thread) : historyText(entry.entry),
  );
}

/** The header's totals — each view reports the counts its own DTO carries. */
function totalsText(view: ActivityView, page: ActivityToolPage): string {
  if (view === 'all') {
    const p = page as ActivityAllPageDto;
    return `${p.totalComments} comments · ${p.totalChanges} changes in total`;
  }
  const p = page as CommentsPageDTO | ActivityHistoryPageDto;
  const noun = view === 'comments' ? 'comments' : 'changes';
  return `${p.totalCount} ${noun} in total`;
}

/**
 * The human-readable block. States the page's size against the totals, and —
 * when a cursor remains — says so EXPLICITLY, because a short page with more to
 * come is normal for `all` and `history` and must never read as "that is
 * everything". Comment bodies are verbatim; nothing here is silently cut.
 */
export function summarizeActivity(
  identifier: string,
  view: ActivityView,
  page: ActivityToolPage,
): string {
  const lines = pageLines(view, page);
  const head = `${identifier} activity (${view}) — ${lines.length} on this page · ${totalsText(view, page)}`;
  const more =
    page.nextCursor === null
      ? 'End of the stream — no further pages.'
      : `MORE REMAINS — this page may be short; call again with cursor="${page.nextCursor}".`;
  const body = lines.length === 0 ? ['(nothing recorded yet)'] : lines;
  return [head, more, '', ...body].join('\n');
}

// ────────────────────────────── the adapter ──────────────────────────────

/** Read the requested view's page through the SAME service the UI route calls. */
async function readPage(
  view: ActivityView,
  workItemId: string,
  options: { cursor?: string; order?: 'asc' | 'desc' },
  ctx: ServiceContext,
): Promise<ActivityToolPage> {
  if (view === 'comments') return commentsService.listComments(workItemId, options, ctx);
  if (view === 'history') return activityService.listHistory(workItemId, options, ctx);
  return activityService.listAll(workItemId, options, ctx);
}

/** The adapter: resolve the key, read ONE bounded page, hand it back verbatim. */
export async function runGetWorkItemActivity(
  args: GetWorkItemActivityArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const view = args.view ?? 'all';
  const item = await resolveWorkItemByKey(args.key, ctx);
  // `cursor` / `order` go through UNCHANGED — an omitted `order` leaves each
  // service on its own shipped default rather than this tool inventing one.
  const page = await readPage(view, item.id, { cursor: args.cursor, order: args.order }, ctx);
  return toolOk(
    summarizeActivity(item.identifier, view, page),
    derived(activityPagePayload, page as unknown as { nextCursor: string | null }),
  );
}

export function registerGetWorkItemActivity(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_WORK_ITEM_ACTIVITY_TOOL_NAME,
    {
      title: 'Get work item activity',
      description:
        "Read one page of a work item's discussion and change trail (by identifier, e.g. " +
        '"ACME-7"): `view: "all"` (default) interleaves comment threads and history in ' +
        'timestamp order, `"comments"` returns threads with their replies, `"history"` the ' +
        'change trail. Cursor-paged — echo `nextCursor` back verbatim to continue; a SHORT ' +
        'page with a non-null cursor is normal, so keep paging until it is null. Comment ' +
        'bodies are returned in full, never truncated. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetWorkItemActivity(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
