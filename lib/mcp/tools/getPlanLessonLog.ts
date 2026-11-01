import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  PlanLessonCallDto,
  PlanLessonLogPageDto,
  PlanNarrationSessionDto,
} from '@/lib/dto/plans';
import { PLAN_LESSON_CALL_PAGE_MAX } from '@/lib/plans/planLessonCall';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { requiredPlanIdField } from './planRef';

// `get_plan_lesson_log` (MOTIR-10191) — WHICH LESSONS EACH PLANNING SESSION SAW.
// The beside-read of `get_plan_code_reads`: every `search_lessons` a session made
// with its query, filters and the ids it got back in rank order, every
// `reinforce_lesson` / `add_lesson`, and the ids a hosted session was handed in
// code. A check of a plan reads it to tell a session that never searched from one
// whose search missed the lesson behind a slip and one that was SHOWN it and wrote
// against it anyway. A thin READ adapter over `plansService.listPlanLessonLog`,
// reader-gated like `get_plan`.

export const GET_PLAN_LESSON_LOG_TOOL_NAME = 'get_plan_lesson_log';

const inputSchema = {
  planId: requiredPlanIdField,
  sessionKey: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('OPTIONAL — only this session’s calls (the key `report_plan_step` carried).'),
  afterSeq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'OPTIONAL — the next page: pass the previous page’s `nextAfterSeq`. Omit for the first.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PLAN_LESSON_CALL_PAGE_MAX)
    .optional()
    .describe(`OPTIONAL — calls per page, at most ${PLAN_LESSON_CALL_PAGE_MAX} (the default).`),
};

/** A session's step words, as the head of its group. */
function stepWords(step: PlanNarrationSessionDto | null | undefined): string {
  if (!step) return '';
  const ref = step.targetRef ? ` ${step.targetRef}` : '';
  const title = step.targetTitle ? ` “${step.targetTitle}”` : '';
  return ` — ${step.stepKind}${ref}${title}`;
}

/** The axes a search narrowed by, in one phrase. */
function filtersOf(c: PlanLessonCallDto): string {
  const f = c.filters;
  const parts = [
    f.kinds?.length ? `kinds ${f.kinds.join('/')}` : null,
    f.types?.length ? `types ${f.types.join('/')}` : null,
    f.phases?.length ? `phases ${f.phases.join('/')}` : null,
    f.subject ? `subject ${f.subject}` : null,
    f.limit !== undefined ? `limit ${f.limit}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? ` [${parts.join(' · ')}]` : ' [no filters]';
}

/** One call, as a check cites it. */
export function lessonCallLine(c: PlanLessonCallDto): string {
  const detail = c.detail !== null ? ` — ${c.detail}` : '';
  if (c.kind === 'search') {
    const ids = c.lessonIds.length > 0 ? c.lessonIds.join(', ') : 'none';
    const query = c.query !== null ? ` ${JSON.stringify(c.query)}` : '';
    return `#${c.seq} search${query}${filtersOf(c)} → ${c.outcome}: ${ids}${detail}`;
  }
  if (c.kind === 'injected') {
    return `#${c.seq} injected in code → ${c.lessonIds.join(', ') || 'none'}${detail}`;
  }
  const counted = c.counted === null ? '' : c.counted ? ' (counted)' : ' (not counted)';
  const ref = c.occurrenceRef !== null ? ` for ${c.occurrenceRef}` : '';
  return `#${c.seq} ${c.kind} ${c.lessonId ?? '(no lesson)'}${ref} → ${c.outcome}${counted}${detail}`;
}

export function summarizePlanLessonLog(page: PlanLessonLogPageDto): string {
  const lines = [
    `Plan ${page.planId}: ${page.calls.length} lesson call(s) on this page, ` +
      `${page.sessions.length} session(s) recorded.`,
  ];
  const bySession = new Map<string, PlanLessonCallDto[]>();
  for (const c of page.calls)
    bySession.set(c.sessionKey, [...(bySession.get(c.sessionKey) ?? []), c]);
  for (const s of page.sessions) {
    const calls = bySession.get(s.sessionKey) ?? [];
    if (s.calls === 0) {
      lines.push(`Session ${s.sessionKey}${stepWords(s.step)}: no lesson call (recorded).`);
      continue;
    }
    if (calls.length === 0) continue;
    lines.push(`Session ${s.sessionKey}${stepWords(s.step)}: ${s.calls} call(s).`);
    for (const c of calls) lines.push(`  ${lessonCallLine(c)}`);
  }
  if (page.unrecordedSessions.length > 0) {
    lines.push(
      `Not recorded (no lesson log): ${page.unrecordedSessions
        .map((s) => `${s.sessionKey}${stepWords(s)}`)
        .join('; ')}.`,
    );
  }
  if (page.nextAfterSeq !== null) {
    lines.push(`More calls follow: call again with \`afterSeq: ${page.nextAfterSeq}\`.`);
  }
  return lines.join('\n');
}

export async function runGetPlanLessonLog(
  args: { planId: string; sessionKey?: string; afterSeq?: number; limit?: number },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const page = await plansService.listPlanLessonLog(
      args.planId,
      {
        ...(args.sessionKey !== undefined ? { sessionKey: args.sessionKey } : {}),
        ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      ctx,
    );
    return toolOk(
      summarizePlanLessonLog(page),
      exempt(GET_PLAN_LESSON_LOG_TOOL_NAME, page as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetPlanLessonLog(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_PLAN_LESSON_LOG_TOOL_NAME,
    {
      title: 'Read which lessons each planning session saw',
      description:
        'The LESSON LOG of a plan, in call order — which lessons each planner session searched ' +
        'for, was shown and reinforced; ids only, never a lesson’s text. Each call has a `kind`: ' +
        '`search` (its `query`, its `filters` — kinds, types, phases, subject, limit — and the ' +
        '`lessonIds` it returned in RANK order), `reinforce` / `add` (its `lessonId`, ' +
        '`occurrenceRef`, `outcome` and whether it `counted`), or `injected` (the ids the hosted ' +
        'planner composed into the session’s prompt in code, not searched). Returns `{ planId, ' +
        'calls, sessions, unrecordedSessions, nextAfterSeq }`: `sessions` is EVERY session whose ' +
        'log was recorded, with its call count and step words — `calls: 0` means it made no ' +
        'lesson call; `unrecordedSessions` are sessions that reported a step but whose lesson ' +
        'log was never recorded, which is NOT the same as an empty one. Page with `afterSeq: ' +
        'nextAfterSeq` until it is null; narrow with `sessionKey`. Use it when judging a plan, ' +
        'beside `get_plan_code_reads`: it tells a session that never searched from one whose ' +
        'search missed the lesson behind a slip and one that was shown it and wrote against it. ' +
        'Reader-gated like `get_plan`, on a plan in any status. Read-only: it creates, mutates ' +
        'and persists nothing.',
      inputSchema,
    },
    async (args, extra) => runGetPlanLessonLog(args, resolveContext(extra)),
  );
}
