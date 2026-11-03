import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { parseRunRecordQuery } from '@/lib/runs/runRecordQuery';
import { DISPATCH_RUN_LIST_MAX_TAKE } from '@/lib/services/dispatchRunService';
import { projectsService } from '@/lib/services/projectsService';
import {
  RUN_RECORD_STATUSES,
  runRecordReadService,
  type RunRecord,
  type RunRecordRow,
} from '@/lib/services/runRecordReadService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `search_run_records` and `get_run_record` (MOTIR-10240) — what a run of a
// project did: which runs match a card, a scope or a status, and for one run how
// it ended and what it recorded as different. Thin adapters over
// `runRecordReadService`, the service `app/api/internal/ai/{search,get}-run-record`
// call for the hosted planner: the key resolves inside the token's workspace
// (another tenant's key is the plain not-found), and a run of another project is
// `not_found`, never read.
//
// Every absence is a NON-error result naming itself in `structuredContent.outcome`
// (`nothing_matched`, `not_found`). Run text — the hosted end line, a leg's
// discrepancy comment — is agent-written: it is returned in its own named fields
// and quoted below a marker, never folded into this tool's sentences.

export const SEARCH_RUN_RECORDS_TOOL_NAME = 'search_run_records';
export const GET_RUN_RECORD_TOOL_NAME = 'get_run_record';

const searchInputSchema = {
  projectKey: projectKeyField,
  workItemKey: z
    .string()
    .min(1)
    .optional()
    .describe('OPTIONAL. Runs that carried a LEG for this card (e.g. "ACME-7").'),
  scopeWorkItemKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL. Runs whose SCOPE is this container (a parent or story run). Give this or ' +
        '`workItemKey`, not both.',
    ),
  statuses: z
    .array(z.enum(RUN_RECORD_STATUSES as [string, ...string[]]))
    .optional()
    .describe('OPTIONAL. Only runs in these statuses.'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The `nextCursor` a previous call returned, to read the next page.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(DISPATCH_RUN_LIST_MAX_TAKE)
    .optional()
    .describe(`OPTIONAL. Runs per page, 1 to ${DISPATCH_RUN_LIST_MAX_TAKE}; default 25.`),
};

const getInputSchema = {
  projectKey: projectKeyField,
  runId: z.string().min(1).describe('The run id — a `search_run_records` row’s `id`.'),
};

function rowLine(run: RunRecordRow): string {
  const legs = Object.entries(run.legs)
    .filter(([, n]) => n > 0)
    .map(([d, n]) => `${n} ${d}`)
    .join(', ');
  return (
    `- ${run.id} · ${run.command} (${run.origin}) · ${run.status}` +
    `${run.stopReason ? ` / ${run.stopReason}` : ''} · started ${run.startedAt}` +
    `${run.endedAt ? `, ended ${run.endedAt}` : ''} · ${run.cardCount} card${run.cardCount === 1 ? '' : 's'}` +
    `${legs ? ` (${legs})` : ''}`
  );
}

/** The text of one run's record. Agent-written text is quoted, never paraphrased. */
export function renderRunRecord(projectKey: string, run: RunRecord): string {
  const lines = [
    `Run ${run.id} in ${projectKey}: ${run.command} (${run.origin}), ${run.status}` +
      `${run.stopReason ? ` / ${run.stopReason}` : ''}, started ${run.startedAt}` +
      `${run.endedAt ? `, ended ${run.endedAt}` : ', not ended'}.`,
  ];
  if (run.hostedEnd) {
    lines.push(
      `End: outcome ${run.hostedEnd.outcome ?? 'not recorded'}, exit code ${run.hostedEnd.exitCode ?? 'none'}.`,
    );
    if (run.hostedEnd.detail !== null) {
      lines.push(
        `End line (recorded by the run, verbatim${run.hostedEnd.detailTruncated ? ', cut' : ''}):`,
        run.hostedEnd.detail,
      );
    }
  }
  lines.push(`Legs (${run.legs.length}):`);
  for (const leg of run.legs) {
    lines.push(
      `- ${leg.key ?? '(deleted card)'} · ${leg.disposition}` +
        `${leg.skipReason ? ` (${leg.skipReason})` : ''} · exit ${leg.exitCode ?? 'none'}` +
        ` · ${leg.discrepancy ? `recorded ${leg.discrepancy.pointCount} difference${leg.discrepancy.pointCount === 1 ? '' : 's'} (${leg.discrepancy.decisionCount} decision${leg.discrepancy.decisionCount === 1 ? '' : 's'})` : 'no discrepancy record'}`,
    );
    if (leg.discrepancy) {
      lines.push(
        leg.discrepancy.bodyMd === null
          ? '  The record’s comment no longer exists.'
          : `  Record (recorded by the run, verbatim${leg.discrepancy.bodyTruncated ? ', cut' : ''}):\n${leg.discrepancy.bodyMd}`,
      );
    }
  }
  return lines.join('\n');
}

export async function runSearchRunRecords(
  args: Record<string, unknown> & { projectKey: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const parsed = parseRunRecordQuery(args);
  if (!parsed.ok) return toolError('RUN_RECORD_QUERY_INVALID', parsed.error);
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const result = await runRecordReadService.searchRuns(project.id, parsed.filters, ctx);
    const more =
      result.nextCursor === null
        ? 'No more runs.'
        : `More runs: call search_run_records again with cursor "${result.nextCursor}".`;
    const text =
      result.outcome === 'nothing_matched'
        ? `No run of ${project.identifier} matched.`
        : [
            `${result.runs.length} run${result.runs.length === 1 ? '' : 's'} of ${project.identifier}, newest first:`,
            ...result.runs.map(rowLine),
            more,
          ].join('\n');
    return toolOk(text, exempt(SEARCH_RUN_RECORDS_TOOL_NAME, { ...result }));
  } catch (err) {
    return toToolError(err);
  }
}

export async function runGetRunRecord(
  args: { projectKey: string; runId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const result = await runRecordReadService.readRun(project.id, args.runId.trim(), ctx);
    if (result.outcome === 'not_found') {
      return toolOk(
        `No run "${args.runId}" in ${project.identifier} that you can read. It may not exist, or belong to another project.`,
        exempt(GET_RUN_RECORD_TOOL_NAME, { outcome: 'not_found' }),
      );
    }
    return toolOk(
      renderRunRecord(project.identifier, result.run),
      exempt(GET_RUN_RECORD_TOOL_NAME, { ...result }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerRunRecords(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    SEARCH_RUN_RECORDS_TOOL_NAME,
    {
      title: 'Search run records',
      description:
        'The runs of a project, newest first: one row per run — `id`, `command`, `origin`, ' +
        '`status`, `stopReason`, `startedAt`, `endedAt`, `cardCount` and its legs as counts by ' +
        'disposition. Narrow by `workItemKey` (runs that carried a leg for that card) OR ' +
        '`scopeWorkItemKey` (runs scoped to that container), and by `statuses`; page with ' +
        '`cursor`. A search that matches no run answers `outcome: nothing_matched`, not an ' +
        'error. Read one run with `get_run_record`. Read-only. The project key resolves inside ' +
        'the token’s own workspace.',
      inputSchema: searchInputSchema,
    },
    async (args, extra) => runSearchRunRecords(args, resolveContext(extra)),
  );
  server.registerTool(
    GET_RUN_RECORD_TOOL_NAME,
    {
      title: 'Get run record',
      description:
        'One run of a project: how it ended — `status`, `stopReason`, `endedAt`, and for a ' +
        'hosted run its end line (`hostedEnd`) — and per leg the card `key`, `disposition`, ' +
        '`skipReason`, `exitCode` and what the run recorded as different (`discrepancy`: ' +
        '`commentId`, `pointCount`, `decisionCount` and the comment `bodyMd`, or null). Text ' +
        'the run recorded is returned verbatim in its own fields. A run that is unknown or of ' +
        'another project answers `outcome: not_found`, not an error. No event stream, cost or ' +
        'logs. Read-only. The project key resolves inside the token’s own workspace.',
      inputSchema: getInputSchema,
    },
    async (args, extra) => runGetRunRecord(args, resolveContext(extra)),
  );
}
