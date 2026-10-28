import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  planAuthoringStateService,
  type PlanAuthoringStateDto,
} from '@/lib/services/planAuthoringStateService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { requiredPlanIdField } from './planRef';

// `get_plan_authoring_state` (MOTIR-9821) — the LIVE answer to "has this sibling's
// author session started?", which an author session must have before it wires
// "that sibling `blocked_by` me" to make a Scope BOUNDARY hand-off legal. The level
// view a session opens on is a snapshot; this is the authority. A thin READ adapter
// over `planAuthoringStateService` — the states and the rule are
// `lib/plans/authoringState.ts`'s.

export const GET_PLAN_AUTHORING_STATE_TOOL_NAME = 'get_plan_authoring_state';

const inputSchema = { planId: requiredPlanIdField };

function summarize(result: PlanAuthoringStateDto): string {
  const lines = [
    `Plan ${result.planId} (${result.status}) — ${result.proposals.length} proposal(s) by authoring state:`,
    ...result.proposals.map((p) => `  ${p.ref} · ${p.state} · ${p.title ?? `(${p.op})`}`),
    'Only a `not_started` card may be given an edge onto you (`that card blocked_by this one`): its ' +
      'author session has not opened, so it will read your Scope BOUNDARY. A card `authoring` or ' +
      '`authored` never reads it — carry the work, add a card `blocked_by` yours, or raise a gap.',
  ];
  return lines.join('\n');
}

export async function runGetPlanAuthoringState(
  args: { planId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await planAuthoringStateService.getAuthoringState(args.planId, ctx);
    return toolOk(
      summarize(result),
      exempt(GET_PLAN_AUTHORING_STATE_TOOL_NAME, result as unknown as Record<string, unknown>),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetPlanAuthoringState(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_PLAN_AUTHORING_STATE_TOOL_NAME,
    {
      title: 'Read which proposals are authored',
      description:
        'Which of a plan’s proposals are being WRITTEN right now, which are WRITTEN, and which ' +
        'no author session has STARTED — read LIVE, for an author session about to wire an edge ' +
        'onto a sibling. Returns `{ planId, status, proposals: [{ ref, op, title, state }] }`, one ' +
        'row per `add` (`ref` = `planItem:<id>`) and per `modify` (`ref` = the work item’s id), with ' +
        '`state` one of: `authoring` — an `author` step reported through `report_plan_step` targets ' +
        'it and has not ended; `authored` — an author session that targeted it has ended, or it ' +
        'was appended COMPLETE and never needed one (a `modify` always is); `not_started` — no ' +
        'author session, live or ended, and the card is still incomplete (a missing body or ' +
        'explanation, a `validate_plan` section finding, or — on a childless leaf — a missing ' +
        'type, executor, size or difficulty). The rule it serves: a `## Scope BOUNDARY` may hand ' +
        'not-done work only to a card `blocked_by` the card, and an author session may wire that ' +
        'edge onto a sibling ONLY while the sibling is `not_started` — a card being written or ' +
        'already written never reads the boundary. The level view a session opened on is a ' +
        'snapshot taken at its start; this read is the authority. Read-only: it creates, ' +
        'mutates and persists nothing.',
      inputSchema,
    },
    async (args, extra) => runGetPlanAuthoringState(args, resolveContext(extra)),
  );
}
