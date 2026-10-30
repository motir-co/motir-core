import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PlanCodeReadDto, PlanCodeReadPageDto } from '@/lib/dto/plans';
import { PLAN_CODE_READ_PAGE_MAX } from '@/lib/plans/planCodeRead';
import { plansService } from '@/lib/services/plansService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { requiredPlanIdField } from './planRef';

// `get_plan_code_reads` (MOTIR-10122) — WHAT EACH PLANNING SESSION ACTUALLY READ.
// A session's narration says it read the code; this is the record of which files,
// ranges and queries it did read, at which commit, and how much came back. A
// check of a plan reads it to tell a session that read the file holding a fact
// and wrote against it from one that read another file, or nothing. A thin READ
// adapter over `plansService.listPlanCodeReads`, reader-gated like `get_plan`.

export const GET_PLAN_CODE_READS_TOOL_NAME = 'get_plan_code_reads';

const inputSchema = {
  planId: requiredPlanIdField,
  sessionKey: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('OPTIONAL — only this session’s reads (the key `report_plan_step` carried).'),
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
    .max(PLAN_CODE_READ_PAGE_MAX)
    .optional()
    .describe(`OPTIONAL — reads per page, at most ${PLAN_CODE_READ_PAGE_MAX} (the default).`),
};

/** What a read asked for, in one phrase. */
function asked(r: PlanCodeReadDto): string {
  const range =
    r.startLine !== null ? `:${r.startLine}${r.endLine !== null ? `-${r.endLine}` : '-'}` : '';
  const target = [r.repo, r.path ? `${r.path}${range}` : null].filter(Boolean).join(' ');
  const query = r.query !== null ? ` ${JSON.stringify(r.query)}` : '';
  return `${r.tool}${target ? ` ${target}` : ''}${query}`;
}

/** Where a read was made: every commit, full sha, a dirty checkout marked. */
function at(r: PlanCodeReadDto): string {
  if (r.commits.length === 0) return 'no commit resolved';
  return r.commits
    .map((c) => `${c.repo ? `${c.repo}@` : ''}${c.sha}${c.dirty ? ' (dirty)' : ''}`)
    .join(', ');
}

/** What came back. */
function came(r: PlanCodeReadDto): string {
  const counts = [
    r.lines !== null ? `${r.lines} lines` : null,
    r.hits !== null ? `${r.hits} hits` : null,
  ].filter(Boolean);
  const detail = r.detail !== null ? ` — ${r.detail}` : '';
  return `${r.outcome}${counts.length ? ` (${counts.join(', ')})` : ''}${detail}`;
}

export function summarizePlanCodeReads(page: PlanCodeReadPageDto): string {
  if (page.reads.length === 0) {
    return `Plan ${page.planId}: no code reads recorded${page.nextAfterSeq === null ? '' : ' on this page'}.`;
  }
  const steps = new Map(page.sessions.map((s) => [s.sessionKey, s]));
  const lines = [`Plan ${page.planId}: ${page.reads.length} code read(s), in call order.`];
  let session: string | null = null;
  for (const r of page.reads) {
    if (r.sessionKey !== session) {
      session = r.sessionKey;
      const step = steps.get(session);
      const head = step
        ? ` — ${step.stepKind}${step.targetRef ? ` ${step.targetRef}` : ''}${step.targetTitle ? ` “${step.targetTitle}”` : ''}`
        : '';
      lines.push(`Session ${session}${head}:`);
    }
    lines.push(`  #${r.seq} ${asked(r)} · at ${at(r)} · ${came(r)}`);
  }
  if (page.nextAfterSeq !== null) {
    lines.push(`More reads follow: call again with \`afterSeq: ${page.nextAfterSeq}\`.`);
  }
  return lines.join('\n');
}

export async function runGetPlanCodeReads(
  args: { planId: string; sessionKey?: string; afterSeq?: number; limit?: number },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const page = await plansService.listPlanCodeReads(
      args.planId,
      {
        ...(args.sessionKey !== undefined ? { sessionKey: args.sessionKey } : {}),
        ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      ctx,
    );
    return toolOk(
      summarizePlanCodeReads(page),
      exempt(GET_PLAN_CODE_READS_TOOL_NAME, page as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetPlanCodeReads(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_PLAN_CODE_READS_TOOL_NAME,
    {
      title: 'Read what each planning session read',
      description:
        'The CODE READS each planner session of a plan made, in call order — what it asked and ' +
        'what came back, never the code: the tool (`read_file`, `code_explore`, `code_search`, ' +
        '`code_grep`, and a local planner’s `Read`, `Grep`, `Glob`, `git show`, `git grep`, ' +
        '`git log`), its repo, path and line range or its query and scope, the COMMITS it was ' +
        'read at (`commits: [{ repo?, sha, dirty? }]` — a resolved commit id, never a branch ' +
        'name; `dirty` marks a local checkout with uncommitted changes; empty only when nothing ' +
        'resolved), and the outcome (`found`, `not_found`, `too_large`, …) with the lines or hits ' +
        'returned. Returns `{ planId, reads, sessions, nextAfterSeq }`: `sessions` carries the ' +
        'step words (kind, target ref and title) of every session on the page, so you can tell ' +
        'which card a session was writing; page with `afterSeq: nextAfterSeq` until it is ' +
        'null. Narrow to one session with `sessionKey`. Use it when judging a plan: it tells a ' +
        'session that read the file holding a fact and wrote against it from one that read ' +
        'another file, or nothing. Reader-gated like `get_plan`, on a plan in any status. ' +
        'Read-only: it creates, mutates and persists nothing.',
      inputSchema,
    },
    async (args, extra) => runGetPlanCodeReads(args, resolveContext(extra)),
  );
}
