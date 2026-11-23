import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import {
  REPAIR_CLOSE_OUTCOMES,
  type RepairCloseOutcome,
  type WorkItemRepairClaimDto,
  type WorkItemRepairRunDto,
} from '@/lib/dto/workItemRepair';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived, exempt } from '../payloads/define';
import { claimWorkItemRepairPayload, presentMcpWorkItemRepairClaim } from '../payloads/workLoop';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// The REPAIR tools (Story MOTIR-6804 · MOTIR-6807) — the MCP door onto the
// REPAIR CLAIM `motir fix <key>` makes over `/api/v1` (MOTIR-5460), so an agent
// working from a Motir skill can take the lock on a red card, keep it, and hand
// it back with how the repair ended.
//
// ⚠️ A DOOR, NEVER A SECOND ANSWER. Every rule is the service's, unchanged:
// the refusal order, the lock, the CI-credit gate and the edit gate are
// `workItemRepairService.claimRepair`'s; the liveness is
// `dispatchRunService.heartbeat`'s under the lock it shares with the reap; the
// close is `dispatchRunService.close`'s. The claim answers through v1's own
// presenter, so the two doors cannot drift. The only thing the MCP door adds is
// the ownership read touch and close need — `workItemRepairService` owns it.
//
// ⚠️ A REFUSAL IS AN ANSWER. `taken` and `not_repairable` are ordinary results
// (the REST route answers them with a 200), and a closed run is `open: false`
// on touch and an idempotent answer on close — never an MCP error, because each
// is something the agent acts on rather than something it should retry.
//
// ⚠️ NO RUN EVENTS. The CLI appends `ci_watch_*` / `card_settled`; an agent
// holding a repair needs the lock, its liveness and its outcome, and nothing
// reads the rest from an MCP caller (the story's boundary). Adding events is a
// new tool, not a change to these.
//
// `touch` and `close` are EXEMPT from payload derivation
// (`payloads/exemptions.ts`): they answer the repair run's liveness, which is not
// the v1 `DispatchRun` resource and must not become it
// (`MCP_UNREACHABLE_RESOURCES.DispatchRun`).

export const CLAIM_WORK_ITEM_REPAIR_TOOL_NAME = 'claim_work_item_repair';
export const TOUCH_WORK_ITEM_REPAIR_TOOL_NAME = 'touch_work_item_repair';
export const CLOSE_WORK_ITEM_REPAIR_TOOL_NAME = 'close_work_item_repair';

const runIdField = z
  .string()
  .min(1)
  .describe(
    'The repair run’s id — the `runId` `claim_work_item_repair` answered. Only your own run on ' +
      'this work item is accepted.',
  );

const claimInputSchema = {
  key: workItemKeyField,
};

const touchInputSchema = {
  key: workItemKeyField,
  runId: runIdField,
};

const closeInputSchema = {
  key: workItemKeyField,
  runId: runIdField,
  outcome: z
    .enum(REPAIR_CLOSE_OUTCOMES)
    .describe(
      'How the repair ended: "green" (the checks pass), "gave_up" (you spent your attempts), ' +
        '"halted" (you stopped on something you could not get past) or "interrupted" (the ' +
        'person stopped you).',
    ),
};

/** A member handed over for its BASE rather than its checks (Bug MOTIR-12095) — its checks
 *  are green, so this clause is the only thing on its line that says what to do. */
function baseState(pr: WorkItemRepairClaimDto['pullRequests'][number]): string {
  const base = pr.baseRef ? `\`${pr.baseRef}\`` : 'its base';
  if (pr.conflicted) return ` — conflicts with ${base}: merge it, resolve the conflicts, and push`;
  if (pr.outOfDate) return ` — out of date with ${base}: merge it and push`;
  return '';
}

/** What the agent reads first — the claim's outcome, said as an instruction. */
function summarizeClaim(claim: WorkItemRepairClaimDto): string {
  const holder = claim.holder?.name ?? 'someone else';
  const prs = claim.pullRequests
    .map((pr) => {
      const checks =
        pr.failingChecks.length > 0 ? ` — failing: ${pr.failingChecks.join(', ')}` : '';
      const exit = pr.queueExit ? ` — merge queue exit: ${pr.queueExit.rawReason}` : '';
      return `  · ${pr.repo}#${pr.number} on branch ${pr.headRef}${checks}${exit}${baseState(pr)}`;
    })
    .join('\n');
  const rerun =
    claim.repairClass === 'acceptance_rerun' && claim.acceptanceRefusal
      ? `\nThe acceptance video was sent back for a re-run` +
        (claim.acceptanceRefusal.reasonMd ? `: ${claim.acceptanceRefusal.reasonMd}` : '.')
      : claim.repairClass === 'review' && claim.reviewRefusal
        ? // A card a REVIEW sent back (MOTIR-6822): the findings IN FULL are the brief —
          // address every one on these branches and push; the push withdraws the review.
          `\n${claim.reviewRefusal.reviewerName ?? 'The reviewer'} sent it back ` +
          `(${claim.reviewRefusal.gate}) on ${claim.reviewRefusal.decidedAt}. Address EVERY ` +
          'finding on these branches and push; open no pull request, decide no approval, ' +
          'move no status. The findings:\n' +
          (claim.reviewRefusal.findingsMd?.trim() || '(no findings were recorded)')
        : '';
  const keepAlive =
    `Keep it alive with touch_work_item_repair (runId ${claim.runId}) at least every two ` +
    'minutes — a run silent for five minutes is closed — and end it with ' +
    'close_work_item_repair.';
  switch (claim.outcome) {
    case 'claimed':
      return (
        `Claimed the repair of ${claim.key} — ${claim.title} (run ${claim.runId}, class ` +
        `${claim.repairClass}). Fix these pull requests on their OWN branches:\n${prs}${rerun}\n` +
        keepAlive
      );
    case 'mine':
      return (
        `Already yours: you hold the repair of ${claim.key} (run ${claim.runId}). This is a ` +
        `RESUME, not a lost race. The pull requests:\n${prs}${rerun}\n${keepAlive}`
      );
    case 'taken':
      return (
        `NOT claimed: ${claim.key} is already being fixed by ${holder}` +
        (claim.startedAt ? ` (since ${claim.startedAt})` : '') +
        '. Do NOT push to its branches — pick different work.'
      );
    case 'not_repairable':
      if (claim.reason === 'repair_on_run_target') {
        return (
          `NOT claimed: ${claim.key}'s pull requests belong to a run launched against ` +
          `${claim.runTargetKey}. Claim the repair of ${claim.runTargetKey} instead.`
        );
      }
      return `NOT claimed: ${claim.key} is not waiting on a repair (${claim.reason}). Nothing changed.`;
  }
}

/** The touch / close answer, said as what to do next. */
function summarizeRun(run: WorkItemRepairRunDto, verb: 'touch' | 'close'): string {
  if (run.open) {
    return (
      `Repair run ${run.runId} on ${run.key} is still open — keep working and touch again within ` +
      `two minutes.`
    );
  }
  const how = `${run.status}${run.stopReason ? `, ${run.stopReason}` : ''}`;
  return verb === 'close'
    ? `Repair run ${run.runId} on ${run.key} is closed (${how}). A new claim may now be made.`
    : `Repair run ${run.runId} on ${run.key} is CLOSED (${how}). STOP pushing: the lock is gone ` +
        'and somebody else may be fixing the card. Claim again if you still need to work on it.';
}

/** `claim_work_item_repair` — take the repair lock on one card. */
export async function runClaimWorkItemRepair(
  args: { key: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const claim = await workItemRepairService.claimRepairAsAgent(project.id, identifier, ctx);
    return toolOk(
      summarizeClaim(claim),
      derived(claimWorkItemRepairPayload, presentMcpWorkItemRepairClaim(claim)),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** `touch_work_item_repair` — keep the caller's repair run alive. */
export async function runTouchWorkItemRepair(
  args: { key: string; runId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const run = await workItemRepairService.touchRepair(project.id, identifier, args.runId, ctx);
    return toolOk(summarizeRun(run, 'touch'), exempt(TOUCH_WORK_ITEM_REPAIR_TOOL_NAME, { ...run }));
  } catch (err) {
    return toToolError(err);
  }
}

/** `close_work_item_repair` — end the caller's repair run with its outcome. */
export async function runCloseWorkItemRepair(
  args: { key: string; runId: string; outcome: RepairCloseOutcome },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const identifier = normalizeIdentifier(args.key);
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const run = await workItemRepairService.closeRepair(
      project.id,
      identifier,
      args.runId,
      args.outcome,
      ctx,
    );
    return toolOk(summarizeRun(run, 'close'), exempt(CLOSE_WORK_ITEM_REPAIR_TOOL_NAME, { ...run }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerWorkItemRepair(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CLAIM_WORK_ITEM_REPAIR_TOOL_NAME,
    {
      title: 'Claim a red work item’s repair',
      description:
        'Take the REPAIR LOCK on a work item whose pull requests are failing after its run ended ' +
        '(by identifier, e.g. "ACME-7") — the same claim `motir fix` makes, and the same lock: ' +
        'only one fixer at a time, across MCP and the CLI. The card’s status and assignee are ' +
        'not changed; it reads *being fixed* by you. Answers `claimed` (yours: the `runId`, the ' +
        'repair class, and each pull request to fix with its branch, failing checks, any ' +
        'merge-queue exit, and whether it is `conflicted` with or `outOfDate` against its base — ' +
        'either one means merge the base into the branch and push, even when its checks are ' +
        'green), `mine` (you already hold it — resume), `taken` (someone else is ' +
        'fixing it; they are named) or `not_repairable` with the reason (`not_implemented`, ' +
        '`repair_on_run_target` naming the card to repair instead, `no_pull_requests`, ' +
        '`ci_running`, `not_failing`, `repair_not_code`). A refusal is a RESULT, not an error, ' +
        'and changes nothing. After claiming, call `touch_work_item_repair` at least every two ' +
        'minutes and finish with `close_work_item_repair`. Needs permission to edit the work ' +
        'item.',
      inputSchema: claimInputSchema,
    },
    async (args, extra) => runClaimWorkItemRepair(args, resolveContext(extra)),
  );
  server.registerTool(
    TOUCH_WORK_ITEM_REPAIR_TOOL_NAME,
    {
      title: 'Keep a repair alive',
      description:
        'Keep your repair of a work item alive while you work on it: call it at least every two ' +
        'minutes with the `runId` `claim_work_item_repair` answered. A repair silent for five ' +
        'minutes is closed by the server and the card stops reading *being fixed*. Answers ' +
        '`open: true` while your repair is open, and `open: false` with its `stopReason` once it ' +
        'has been closed — by you, by the server or by anyone else — which means STOP pushing: ' +
        'the lock is gone. Only your own repair run of that work item is accepted. Writes no ' +
        'status and no event. Needs permission to edit the work item.',
      inputSchema: touchInputSchema,
    },
    async (args, extra) => runTouchWorkItemRepair(args, resolveContext(extra)),
  );
  server.registerTool(
    CLOSE_WORK_ITEM_REPAIR_TOOL_NAME,
    {
      title: 'Close a repair',
      description:
        'End your repair of a work item with how it went — `outcome` "green", "gave_up", ' +
        '"halted" or "interrupted" — so the work item page shows how the repair ended and the ' +
        'next repair claim is admitted. Pass the `runId` `claim_work_item_repair` answered; ' +
        'only your own repair run of that work item is accepted. Idempotent: closing a repair ' +
        'that is already closed returns it unchanged. Does not change the work item’s status — ' +
        'green checks move it on their own. Needs permission to edit the work item.',
      inputSchema: closeInputSchema,
    },
    async (args, extra) => runCloseWorkItemRepair(args, resolveContext(extra)),
  );
}
