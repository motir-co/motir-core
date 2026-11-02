import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { PLAN_STATUS_DTO_VALUES } from '@/lib/dto/plans';
import {
  PAST_PLANS_DEFAULT_LIMIT,
  PAST_PLANS_QUERY_MAX,
  parsePastPlanQuery,
  type PastPlanRow,
  type PastPlanSearchResult,
} from '@/lib/plans/pastPlans';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { projectsService } from '@/lib/services/projectsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `search_past_plans` (MOTIR-10241) — search a project's plans in EVERY status,
// declined and abandoned included, each row with its `decisionReason`: how
// similar work was shaped before, and why a plan ended. A thin adapter over
// `aiBoundaryService.searchPastPlans`, the SAME service the hosted planner reads
// through `GET /api/internal/ai/past-plans`, with the same input rules
// (`parsePastPlanQuery`), so both transports return the same rows for the same
// project. Reading ONE plan with its proposals is `get_plan`; no second read tool.
//
// A search that matched nothing is a NON-error result naming itself
// (`structuredContent.outcome: 'nothing-matched'`). A plan's summary is
// agent-written: it is returned in its own field and quoted below a marker, never
// folded into this tool's sentences.

export const SEARCH_PAST_PLANS_TOOL_NAME = 'search_past_plans';

const inputSchema = {
  projectKey: projectKeyField,
  q: z
    .string()
    .optional()
    .describe(
      `OPTIONAL. Words to find in a plan's title or summary (case-insensitive substring, at most ${PAST_PLANS_QUERY_MAX} characters). Omit to list every plan.`,
    ),
  status: z
    .array(z.enum(PLAN_STATUS_DTO_VALUES))
    .optional()
    .describe(
      'OPTIONAL. Only plans in these statuses. A declined plan carries its `decisionReason` ' +
        '(`reviewed`, `discarded` or `abandoned`).',
    ),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The `nextCursor` a previous `search_past_plans` call returned, to read the next page.',
    ),
};

interface SearchPastPlansArgs {
  projectKey: string;
  q?: string;
  status?: string[];
  cursor?: string;
}

function rowLine(row: PastPlanRow): string {
  const status =
    row.status === 'declined'
      ? `declined (${row.decisionReason ?? 'reason not recorded'})`
      : row.status;
  const decided = row.decidedAt ? ` · decided ${row.decidedAt}` : '';
  const head =
    `- ${row.title ?? 'Untitled plan'} (${row.id}) · ${status}${decided} · ` +
    `${row.itemCount} proposal${row.itemCount === 1 ? '' : 's'} · created ${row.createdAt}`;
  if (row.summaryExcerpt === null) return head;
  return `${head}\n  summary (agent-written)${row.summaryTruncated ? ', truncated' : ''}: ${row.summaryExcerpt}`;
}

/** The rendered text: the rows newest first (or the honest empty line), then the cursor. */
export function renderPastPlans(projectKey: string, result: PastPlanSearchResult): string {
  const more =
    result.nextCursor === null
      ? 'No more plans.'
      : `More plans: call search_past_plans again with cursor "${result.nextCursor}".`;
  if (result.outcome === 'nothing-matched') return `No plan of ${projectKey} matched.`;
  const n = result.plans.length;
  return [
    `${n} plan${n === 1 ? '' : 's'} of ${projectKey}, newest first (read one with get_plan):`,
    ...result.plans.map(rowLine),
    more,
  ].join('\n');
}

/** The adapter: validate, resolve the project by key, then search through the service. */
export async function runSearchPastPlans(
  args: SearchPastPlansArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const parsed = parsePastPlanQuery({
    q: args.q,
    status: args.status,
    cursor: args.cursor,
    limit: PAST_PLANS_DEFAULT_LIMIT,
  });
  if (!parsed.ok) return toolError('PAST_PLANS_QUERY_INVALID', parsed.error);
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const result = await aiBoundaryService.searchPastPlans(project.id, parsed.filters, ctx);
    return toolOk(
      renderPastPlans(project.identifier, result),
      exempt(SEARCH_PAST_PLANS_TOOL_NAME, { ...result }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerSearchPastPlans(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    SEARCH_PAST_PLANS_TOOL_NAME,
    {
      title: 'Search past plans',
      description:
        "Search one project's plans in every status — generating, planned, stale, approved and " +
        'declined, abandoned ones included — newest first, 20 at a time: pass the returned ' +
        '`nextCursor` as `cursor` for the next ones. `q` matches a plan’s title or summary ' +
        '(case-insensitive substring); `status` narrows to a set. Each row is the plan’s id, ' +
        'title, status, `decisionReason` (why a declined plan ended: `reviewed`, `discarded` or ' +
        '`abandoned`; null when not recorded), a bounded summary excerpt, its proposal count and ' +
        'its created, planned and decided times — not its proposals; read one plan with ' +
        '`get_plan`. A search that matches nothing answers `outcome: nothing-matched`, not an ' +
        'error. A bad status or a query over 200 characters is refused PAST_PLANS_QUERY_INVALID. ' +
        'Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runSearchPastPlans(args, resolveContext(extra)),
  );
}
