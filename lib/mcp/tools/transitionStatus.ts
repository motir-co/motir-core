import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import {
  ApprovalGatePendingError,
  IllegalTransitionError,
  PlanTargetHeldError,
} from '@/lib/workItems/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { presentMcpWorkItem, workItemWritePayload } from '../payloads/workItems';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `transition_status` (Story 7.8 · Subtask 7.8.5) — move a work item to a target
// workflow status. THE tool that retires the status-flip seed PRs: an agent
// transitions a card in the live tenant directly. A thin adapter over
// `workItemsService.updateStatus` — the workflow legal-transition validation
// (`workflowsService.canTransition`) decides; no business logic here.
//
// Two ergonomic touches for the agent (no new logic, just resolution):
//  - the `status` argument accepts a status KEY *or* its display label
//    (case-insensitive), resolved against the project's workflow before the
//    call — so an agent can say "In progress" without knowing the key;
//  - on an ILLEGAL transition the tool enriches the service's typed error with
//    the LEGAL targets from the item's current status, so the agent
//    self-corrects from the error text instead of guessing.

export const TRANSITION_STATUS_TOOL_NAME = 'transition_status';

const inputSchema = {
  key: workItemKeyField,
  status: z
    .string()
    .min(1)
    .describe(
      'The target status — its key (e.g. "in_progress") or display name (e.g. "In progress").',
    ),
};

/** Resolve the target string to a status KEY by key OR label (case-insensitive). */
function resolveStatusKey(statuses: WorkflowStatusDto[], target: string): string | undefined {
  const needle = target.trim().toLowerCase();
  const byKey = statuses.find((s) => s.key.toLowerCase() === needle);
  if (byKey) return byKey.key;
  return statuses.find((s) => s.label.toLowerCase() === needle)?.key;
}

/** The legal target statuses reachable from `fromKey` under the workflow. */
function legalTargets(workflow: WorkflowDto, fromKey: string): WorkflowStatusDto[] {
  const from = workflow.statuses.find((s) => s.key === fromKey);
  // `open` policy: every other status is reachable. `restricted`: only the
  // statuses a transition row connects from the current one. (Mirrors
  // `workflowsService.canTransition` exactly — one source of truth for "legal".)
  if (workflow.policyMode === 'open') {
    return workflow.statuses.filter((s) => s.key !== fromKey);
  }
  if (!from) return [];
  const targetIds = new Set(
    workflow.transitions.filter((t) => t.fromStatusId === from.id).map((t) => t.toStatusId),
  );
  return workflow.statuses.filter((s) => targetIds.has(s.id));
}

/** Build the enriched ILLEGAL_TRANSITION tool error listing the legal targets. */
function illegalTransitionResult(
  err: IllegalTransitionError,
  workflow: WorkflowDto,
): CallToolResult {
  const targets = legalTargets(workflow, err.fromKey);
  const fromLabel = workflow.statuses.find((s) => s.key === err.fromKey)?.label ?? err.fromKey;
  const allowed =
    targets.length > 0
      ? `Allowed targets from "${fromLabel}": ${targets.map((s) => `${s.label} (${s.key})`).join(', ')}.`
      : `"${fromLabel}" is a terminal status with no outgoing transitions.`;
  return toolError(err.code, `${err.message} ${allowed}`);
}

/** Build the enriched APPROVAL_GATE_PENDING tool error naming who decides. */
function approvalPendingResult(
  err: ApprovalGatePendingError,
  gate: { canDecide: boolean; routedToLabel: string | null },
): CallToolResult {
  const who = gate.canDecide
    ? 'The account this call acts as may decide it, in Motir.'
    : gate.routedToLabel
      ? `It is waiting on ${gate.routedToLabel}.`
      : 'It is waiting on a person in Motir.';
  return toolError(err.code, `${err.message} ${who}`);
}

/** Build the enriched PLAN_TARGET_HELD tool error naming the plan and its state
 *  (MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21 §2). */
function planHeldResult(err: PlanTargetHeldError): CallToolResult {
  const state =
    err.planStatus === 'generating'
      ? 'is still being written'
      : err.planStatus === 'planned'
        ? 'is waiting for approval'
        : err.planStatus === 'approving'
          ? 'is being approved — its approval releases this card when it finishes'
          : 'is stale and needs attention before it can be approved';
  return toolError(err.code, `${err.message} Plan ${err.planId} ${state}.`);
}

/** The adapter: resolve project + item + target status, then transition. */
export async function runTransitionStatus(
  args: { key: string; status: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  let workflow: WorkflowDto | undefined;
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    workflow = await workflowsService.getWorkflow(project.id, ctx.workspaceId);
    // Accept a key OR a label; fall through to the raw string so an unknown
    // status surfaces the service's UnknownStatusError (not a silent mismatch).
    const toKey = resolveStatusKey(workflow.statuses, args.status) ?? args.status;
    const fromStatus = item.status;
    const dto: WorkItemDto = await workItemsService.updateStatus(item.id, toKey, ctx);
    const moved =
      fromStatus === dto.status
        ? `already in "${dto.status}" (no-op)`
        : `${fromStatus} → ${dto.status}`;
    return toolOk(
      `${dto.identifier}: ${moved}`,
      derived(workItemWritePayload, presentMcpWorkItem(dto)),
    );
  } catch (err) {
    // Enrich an illegal move with the legal targets so the agent self-corrects.
    if (err instanceof IllegalTransitionError && workflow) {
      return illegalTransitionResult(err, workflow);
    }
    // A pending approval owns the target (MOTIR-5526): enrich with WHOSE decision
    // it is, from the same payload every other door carries, so an agent can say
    // who has to act instead of reporting a bare refusal. Other moves stay open.
    if (err instanceof ApprovalGatePendingError) {
      return approvalPendingResult(
        err,
        await approvalGatesService.describePendingRefusal(err, ctx),
      );
    }
    // An undecided plan holds the card at Planning (MOTIR-6265): name the plan and
    // what it is doing, so an agent reports it rather than retrying.
    if (err instanceof PlanTargetHeldError) return planHeldResult(err);
    return toToolError(err);
  }
}

export function registerTransitionStatus(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    TRANSITION_STATUS_TOOL_NAME,
    {
      title: 'Transition status',
      description:
        'Move a work item (by identifier, e.g. "ACME-7") to a target workflow status, given as ' +
        'its key or display name. An illegal move returns the allowed targets. A MARKED item ' +
        '(`obsolescence` set) stays finished: a move to any status outside the done category is ' +
        'refused with MARKED_CARD_CANNOT_REOPEN until the mark is cleared with update_work_item; ' +
        '`done` ↔ `cancelled` stays open. Honors the ' +
        "project's workflow rules and the same access checks as the UI.",
      inputSchema,
    },
    async (args, extra) => runTransitionStatus(args, resolveContext(extra)),
  );
}
