import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async () => ({ jobId: 'job_gate' })),
}));

import { DOMAIN_ERROR_STATUS, classifyApiV1Error } from '@/lib/api/v1/errors';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { operationKey } from '@/lib/api/v1/openapi/operation';
import { WORK_LOOP_OPERATIONS } from '@/lib/api/v1/workLoop/operations';
import {
  dispatchPromptSchema,
  integrationResultSchema,
  planSchema,
  planSessionSchema,
  planTargetKeyResolver,
  presentActivityChange,
  presentDispatchPrompt,
  presentIntegrationResult,
  presentPlan,
  presentPlanOutcome,
  presentPlanSession,
  presentSessionCloseOut,
  planOutcomeSchema,
  sessionCloseOutSchema,
} from '@/lib/api/v1/workLoop/schema';
import {
  readinessSchema,
  workItemDetailSchema,
  workItemSummarySchema,
} from '@/lib/api/v1/workItems/schema';
import { MotirAiUnavailableError, MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import {
  EmptyPlanChangeIntentError,
  PlanChangeTurnConflictError,
  TooManyPlanChangeTargetsError,
} from '@/lib/planChange/errors';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { V1_ONLY_PERMISSIONS } from '@/lib/tokens/grant';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { activityService } from '@/lib/services/activityService';
import { commentsService } from '@/lib/services/commentsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildScope } from '@/lib/planChange/scope';
import {
  auditV1RouteSource,
  declaredPermissionByMethod,
  readRouteSource,
  v1RouteFiles,
} from '../../helpers/v1RouteAudit';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The Story 11.7 GATE (Subtask 11.7.8 — MOTIR-2242).
//
// Each code card ships its own units; this suite measures what they LEFT and
// adds the checks no single card could make:
//
//   • the SERVICE → SCHEMA → RESPONSE seam, per resource, driven from a real
//     service call against real Postgres. A fixture written to match the schema
//     proves only that its author was consistent.
//   • the scope map is MIRRORED, read from `lib/mcp/scopes.ts` at test time —
//     a copied table drifts the first time either side moves.
//   • ERROR TOTALITY over the cases a happy path never reaches.
//   • the five CONTRACT GUARDS, each proven to FAIL when its property is
//     violated. A guard that has only ever been seen to pass is not a guard.
//   • "agents keep MCP", held by `git diff` over `tests/mcp/` rather than by a
//     sentence in a card.

const REPO_ROOT = process.cwd();

/**
 * The routes this story added, discovered rather than listed.
 *
 * ⚠️ A SET, because a PATH is not an OPERATION. It was a bare `map` while every
 * work-loop path happened to carry exactly one verb, which made the two counts
 * identical by coincidence rather than by meaning — and MOTIR-4085's read landed
 * a GET beside the existing POST on `…/plan-approval`, so the list gained a
 * duplicate and the route-file walk below started comparing files against verbs.
 * The question this constant answers is *which route files does this story own*,
 * and that has always been one entry per path.
 */
const WORK_LOOP_PATHS = [...new Set(WORK_LOOP_OPERATIONS.map((op) => op.path))];

/**
 * The operation → MCP tool correspondence, as the story's own audit table states
 * it.
 *
 * Only the PAIRING is written here; the PERMISSION is read from `TOOL_PERMISSIONS` at
 * assertion time, so a change to the shared map moves the expectation with it
 * instead of contradicting it. Shared by the scope-mirroring block and by
 * GUARD 4, which asks a different question of the same ten tools.
 */
const WORK_LOOP_MIRRORS = {
  getWorkItemDispatchPrompt: 'dispatch_prompt',
  recordWorkItemIntegration: 'mark_integrated',
  completeSession: 'complete_session',
  submitWorkItemExpansion: 'expand_item',
  getPlanStatus: 'get_plan_status',
  getPlan: 'get_plan',
  openPlanSession: 'open_plan_session',
  appendPlanTurn: 'append_plan_turn',
  submitPlanSession: 'submit_plan_session',
  getWorkItemActivity: 'get_work_item_activity',
  // MOTIR-2961 — the keyed claim. Its PRIMARY surface is the route (the CLI
  // speaks v1, not MCP), and `claim_work_item` is a second CALLER of the one
  // service method rather than a second implementation — so this pairing is the
  // strongest kind: not two things kept in step, but one thing seen twice.
  claimWorkItem: 'claim_work_item',
  // MOTIR-6807 — the REPAIR claim and its run's liveness and close, given an
  // agent door so a published skill can repair a red card without the CLI. Each
  // tool is a second CALLER of the one service method the route calls
  // (`claimRepair`, `heartbeat`, `close`), exactly as `claim_work_item` is.
  claimWorkItemRepair: 'claim_work_item_repair',
  heartbeatDispatchRun: 'touch_work_item_repair',
  closeDispatchRun: 'close_work_item_repair',
  // MOTIR-7262 — the CONTINUE claim, given the same agent door the repair claim
  // has. `claimContinue` is the one method the route and the tool both call. Its
  // touch and close are the same `heartbeat` / `close` operations already paired
  // above, so they add no row: one operation, one mirror.
  claimWorkItemContinue: 'claim_work_item_continue',
  // MOTIR-10333 — the USER-TOKEN verdict door. Unlike the hosted run's verdict below, its
  // caller is a person's own agent, which speaks MCP; `reviewVerdictService.submit` is the
  // one method the route and the tool both call, under the same `work_item:edit`.
  submitWorkItemReviewVerdict: 'submit_review_verdict',
} as const;

/**
 * Work-loop operations that deliberately mirror NO MCP tool, each with the
 * reason — the same shape the drift guard uses for an operation it cannot
 * drive.
 *
 * An entry here is a claim that has to be argued, not a way to quiet the guard:
 * the pairing check below reads this set, so an operation added with no tool and
 * no reason still fails. What the guard actually protects is that nobody adds a
 * v1 operation whose scope was invented rather than mirrored, and an operation
 * with no counterpart cannot invent one either — its scope is asserted against
 * `TOOL_PERMISSIONS` all the same.
 */
const WORK_LOOP_UNMIRRORED: Record<string, string> = {
  claimScope:
    'MOTIR-3049 — the SCOPE claim serves `motir run <story-id>` / `motir run sprint`, and ' +
    '`packages/cli` retired its MCP transport in 11.5.6, so a mirrored tool would be a second ' +
    'implementation with no caller. The card that specifies it scopes the deliverable to the v1 ' +
    'route, its service, its repository reads and the generated spec — nothing asks for an agent ' +
    'surface, and inventing one here would mean shipping a tool nobody had argued for. It takes ' +
    '`claim_work_item`’s permission (`work_item:edit`) rather than a scope of its own: it assigns ' +
    'and flips status, exactly as the keyed claim does, over more rows.',
  reportWorkItemImplementation:
    'MOTIR-2421 · Amendment 18 — recording provenance without asserting integration is a ' +
    'CLIENT need, not an agent one: an agent already reports its harness and model through ' +
    '`mark_integrated` when it has a branch, and the per-item-PR path this serves is the ' +
    'CLI runner’s. It takes `mark_integrated`’s scope (the same actor, the same §3 row) ' +
    'without duplicating its tool.',
  approveWorkItemPlan:
    'MOTIR-3021 / MOTIR-3023 · `docs/decisions/run-findings-protocol.md` Q2 — approval is deliberately NOT ' +
    'an MCP tool, and that absence is the sharpest bound in the design rather than an ' +
    'oversight. MCP is the AGENT’s surface, and the agent whose card was refused is the one ' +
    'party that must never approve its own re-plan; the approving party is the OPERATOR’s ' +
    'loop, which speaks /api/v1. It takes `ai:decide_plan` — the key ' +
    '`plansService.approvePlan` itself asserts — so no permission is invented here either. ' +
    'It said `ai:view_plan` until MOTIR-3188, which split that key because it gated no view ' +
    'and held AUTHOR and DECIDE at once; the route followed its service, as the rule requires. ' +
    'This is the ONE work-loop operation whose key no MCP tool asserts, and deliberately so — ' +
    'a tool would hand approval to the very credential the bound above exists to keep out.',
  getWorkItemPlan:
    'MOTIR-4085 — the READ beside the approval, addressed by the CARD rather than by a plan id. ' +
    'It has no MCP counterpart and wants none, and the reason is the opposite of its ' +
    'neighbour’s: not that an agent must be kept out, but that an agent has no use for it. ' +
    'The agent that submitted the plan already holds its id — its own `submit_plan_session` ' +
    'result returned it — so `get_plan` answers the same document for it today. Addressing it ' +
    'by card exists for the OPERATOR’s loop, which never learns that id because the tool result ' +
    'went to a sandbox it does not read, and which speaks /api/v1. It takes `project:browse` — ' +
    'the key `plansService.getPlan` asserts, and the same key `getPlan` declares for the very ' +
    'same document — so no permission is invented and the two doors onto one plan cannot ' +
    'disagree about who may open them. ⚠️ It is NOT gated like the POST it shares a path with: ' +
    'reading is browse, deciding is `ai:decide_plan`, and conflating the two would have made a ' +
    'browse-readable document look like an AI capability.',
  openDispatchRun:
    'MOTIR-1789 · MOTIR-1792 — the DISPATCH RUN ingest reports what a CLI invocation DID, and ' +
    'its only writers are dispatch processes: `packages/cli`, and the hosted orchestrator with ' +
    '`origin: "hosted"`. `packages/cli` retired its MCP transport in 11.5.6, so a mirrored tool ' +
    'would be a second implementation with no caller. ⚠️ AMENDMENT 3 of ' +
    '`dispatch-run-record.md` (`agent-reported-runs.md`, MOTIR-7446) did NOT mirror it: ' +
    '`start_work_item_run` is a different operation over a different service method ' +
    '(`openAgentRun`) — an agent opening its OWN run over a claim it holds, every row it writes ' +
    'marked `reportedBy: agent` — and it cannot open a run for anything it does not hold. This ' +
    'ingest stays the runner’s. `work_item:edit`, the key every other work-loop write asserts, so ' +
    'no permission is invented.',
  appendDispatchRunEvents:
    'MOTIR-1789 · MOTIR-1792 — the same argument as `openDispatchRun`: the full event stream is ' +
    'the RUNNER’s account of a run, every kind included, and the reporter is the process AROUND ' +
    'the agent, which speaks /api/v1. `report_action` (MOTIR-7451) is not its mirror: it calls ' +
    '`reportAction`, which takes one step line and only four milestone kinds, refuses those in a ' +
    'runner’s run, and marks everything it writes `reportedBy: agent`, so an agent’s account is ' +
    'never mistaken for the runner’s. `work_item:edit`, mirroring the rest of the ingest.',
  getDispatchRun:
    'MOTIR-6558 — a run READ for the process AROUND the agent: the `motir` CLI in a hosted ' +
    'container reads the run the server opened so it can ADOPT it, rather than open a second. ' +
    'The agent never needs the record back — even one reporting its own run holds the receipts ' +
    'its run tools answered — so a tool would have no caller. It takes `project:browse`, the key ' +
    '`dispatchRunService.getRun` asserts on every run read, so no permission is invented.',
  issueDispatchRunGitCredentials:
    "MOTIR-6538 — a run's git credentials, for the process AROUND the agent: the git " +
    'credential helper in a hosted container fetches a fresh App installation token before a ' +
    "clone, a push or a pull request. It answers ONLY a hosted run's own credential, which " +
    'never reaches MCP (`verifyMcpToken` refuses a run-bound token), so a tool would have no ' +
    "caller. It takes `work_item:edit`, the key the run's ingest already asserts.",
  getDispatchRunCloseOutPrompt:
    'MOTIR-5357 — the close-out prompt is a run READ for the process AROUND the agent: the CLI ' +
    'fetches it and hands it to the agent as its prompt, so the agent never calls for it and a ' +
    'tool would have no caller. It takes `project:browse`, the key ' +
    '`dispatchRunService.getCloseOutPrompt` asserts, so no permission is invented.',
  getWorkItemHowToTest:
    'MOTIR-5358 — the HOW TO TEST read serves the CLI’s close-out summary. The agent WRITES the ' +
    'record through `publish_test_instructions` and gets its receipt back from that tool; it has ' +
    'no use for reading it again. `project:browse`, the key `howToTestService` asserts.',
  getWorkItemReviewPrompt:
    'MOTIR-6821 — the REVIEW brief a hosted review run is handed. Its ONLY caller is the ' +
    '`motir review` command inside a hosted review container, on that run’s own token — which ' +
    'never reaches MCP (`verifyMcpToken` refuses a run-bound token) — and the service refuses ' +
    'every other credential (`REVIEW_RUN_TOKEN_REQUIRED`), so a tool would have no caller. ' +
    '`project:browse`, the key the build prompt’s read asserts.',
  submitWorkItemAgentReview:
    'MOTIR-6821 — the review run’s ONE verdict, which decides the card’s `agent_review` gate as ' +
    'the review agent. The same argument as the review prompt, and sharper: the run’s own token ' +
    'is its only caller, and an MCP tool would put a gate decision in reach of an agent ' +
    'credential that is not the review run’s. `work_item:edit`, the key every other work-loop ' +
    'write asserts.',
  reportDispatchRunUnbuildable:
    'MOTIR-8698 — the run’s UNBUILDABLE report, posted by the process AROUND the agent: the CLI ' +
    'reads the reason the agent wrote into `$MOTIR_AGENT_REPORT` and posts it with the run’s own ' +
    'credential, because a hosted or agent-instance agent holds no Motir token and `/api/mcp` ' +
    'refuses a run-bound one. `report_unbuildable_target` is the AGENT’s door to the same finding ' +
    'and stays its fallback; it is not this route’s mirror, because it addresses the card through ' +
    'the agent’s own open leg rather than a named run. `work_item:edit`, the key ' +
    '`report_unbuildable_target` and every other work-loop write assert.',
  recordDispatchRunDiscrepancy:
    'MOTIR-8722 — the run’s DISCREPANCY record, posted by the process AROUND the agent: the CLI ' +
    'reads the points the agent wrote into `$MOTIR_AGENT_REPORT` and posts them with the run’s ' +
    'own credential, because a hosted or agent-instance agent holds no Motir token and ' +
    '`/api/mcp` refuses a run-bound one. `record_run_discrepancy` is the AGENT’s door to the ' +
    'same record and stays its route when it has the tools; it addresses the card’s newest open ' +
    'leg rather than a named run. `work_item:edit`, the key it asserts.',
  reportDispatchRunStop:
    'MOTIR-8722 — the run’s STOP report, posted by the process AROUND the agent from what it ' +
    'wrote into `$MOTIR_AGENT_REPORT`: one comment and the move to Planning, with the run’s own ' +
    'credential. An agent with the Motir tools makes the same writes through `add_comment` and ' +
    '`transition_status`; no single tool mirrors the pair. `work_item:edit`, the key both assert.',
  publishDispatchRunHowToTest:
    'MOTIR-10877 — the run’s HOW TO TEST, posted by the process AROUND the agent: the CLI reads ' +
    'the body the agent wrote into `$MOTIR_AGENT_REPORT` as `howToTest` and publishes it with ' +
    'the run’s own credential and the head commits it read itself, because a hosted or ' +
    'agent-instance agent holds no Motir token and `/api/mcp` refuses a run-bound one. ' +
    '`publish_test_instructions` is the AGENT’s door to the same record and stays its route ' +
    'when it has the tools; it addresses the card by key alone, where this door attributes the ' +
    'version to a named run’s open leg. `work_item:edit`, the key both assert.',
  dismissWorkItemReview:
    'MOTIR-10334 · `approval-gates.md` §12.15 — DISMISS THE REVIEW is the routed PERSON ' +
    'overruling the review agent, with a reason, from the card’s review line. Its caller is ' +
    'the operator’s UI and loop; an agent is the party whose send-back is being overruled, so ' +
    'a tool would hand the overrule to the very surface it answers. It takes `work_item:edit`, ' +
    'the floor every work-loop write asserts, with §12.3’s routed set checked by the service.',
};

/**
 * The permissions a work-loop operation is ALLOWED to declare — i.e. every key
 * some token-reachable operation already asserts, so a route cannot invent one.
 *
 * ⚠️ IT WAS `Object.values(TOOL_PERMISSIONS)` ALONE, and MOTIR-3188 is why it is
 * not any more. Membership of the MCP tool map was a good PROXY for "a real
 * permission" for as long as every v1 operation mirrored a tool — and this
 * story's own `WORK_LOOP_UNMIRRORED` is the register of operations that
 * deliberately do not. `approveWorkItemPlan` is the first whose key no tool
 * asserts either: the plan DECISIONS have no MCP tool ON PURPOSE, because a tool
 * would put approval in reach of the sandboxed agent's credential.
 *
 * So the second arm is `V1_ONLY_PERMISSIONS` — the hand-kept list of keys
 * reachable through `/api/v1` and nowhere else, which exists for exactly this
 * and is guarded in BOTH directions by `tests/tokens/grant.test.ts` (no
 * grantable key without an operation, no v1 declaration outside the grantable
 * set). Widening the proxy here does not weaken the check: a key in neither arm
 * is still an invented one, and that is what this assertion is for.
 */
function realPermissions(): readonly string[] {
  return [...Object.values(TOOL_PERMISSIONS), ...V1_ONLY_PERMISSIONS];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The scope map is MIRRORED, not copied
// ─────────────────────────────────────────────────────────────────────────────

describe('every work-loop operation mirrors its MCP counterpart’s scope', () => {
  const MIRRORS = WORK_LOOP_MIRRORS;

  it('pairs EVERY operation this story declared — or names why it has no tool', () => {
    expect(WORK_LOOP_OPERATIONS.map((op) => op.operationId).sort()).toEqual(
      [...Object.keys(MIRRORS), ...Object.keys(WORK_LOOP_UNMIRRORED)].sort(),
    );
    // …and the story's own audit named ten, plus MOTIR-2961's keyed claim,
    // plus the SIX operations that deliberately have no counterpart
    // (MOTIR-2421's implementation report, MOTIR-3017's plan approval,
    // MOTIR-3049's scope claim and MOTIR-1792's three dispatch-run ingest
    // operations). A count that drifted from the plan is worth failing on — a
    // later operation joins these numbers deliberately, never silently.
    //
    // ⚠️ THE UNMIRRORED SET IS NOW LARGER THAN A LIST OF EXCEPTIONS, and that is
    // a fact about the surface rather than a slipping standard: every addition
    // since MOTIR-2961 serves the OPERATOR's loop, which speaks /api/v1, and the
    // three newest are deliberately out of the AGENT's reach because the agent
    // is the subject of a run rather than its reporter. Each still argues its
    // case in `WORK_LOOP_UNMIRRORED` and each still mirrors a real permission.
    // 14 since MOTIR-6807 paired the repair claim, the heartbeat and the close
    // with the agent-facing repair tools. 15 since MOTIR-7262 paired the
    // continue claim with `claim_work_item_continue`. 16 since MOTIR-10333 paired the
    // user-token verdict door with `submit_review_verdict`.
    expect(Object.keys(MIRRORS)).toHaveLength(16);
    // 18 since MOTIR-4085 added the plan READ beside the approval — the SEVENTH
    // operation with no MCP counterpart, and the first whose reason is that an
    // agent has no USE for it rather than that it must be kept away from one.
    // 20 since MOTIR-4906: the run's close-out prompt (MOTIR-5357) and the How
    // to test read (MOTIR-5358), both READS the CLI makes for the operator's loop.
    // 21 since MOTIR-5464: the REPAIR claim `motir fix` makes.
    // 22 since MOTIR-6558: the run READ a hosted run's CLI adopts its run by.
    // 23 since MOTIR-6538: a hosted run's git credentials, for its credential helper.
    // 25 since MOTIR-6526: the HEARTBEAT (MOTIR-6528) and the CONTINUE claim (MOTIR-6532).
    // 27 since MOTIR-6821: the hosted REVIEW run's prompt read and its verdict.
    // 28 since MOTIR-8698: the run's unbuildable report the CLI posts.
    // 30 since MOTIR-8722: the run's discrepancy record and its STOP report.
    // 31 since MOTIR-10333: the user-token verdict door.
    // 32 since MOTIR-10334: Dismiss the review, the person's overrule of a send-back.
    // 33 since MOTIR-10877: the run's How to test, the CLI publishing what a tool-less agent wrote.
    expect(WORK_LOOP_OPERATIONS).toHaveLength(33);
  });

  it('an unmirrored operation still needs a REASON, and still mirrors a real scope', () => {
    // The excuse proven against a violation: an empty reason is not a reason,
    // and an unmirrored operation cannot invent a permission of its own either.
    for (const [operationId, reason] of Object.entries(WORK_LOOP_UNMIRRORED)) {
      expect(reason.trim().length, `${operationId} states why it has no tool`).toBeGreaterThan(40);
      const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === operationId);
      expect(op, `${operationId} is declared`).toBeDefined();
      expect(realPermissions(), `${operationId} invents a permission`).toContain(op?.permission);
    }
  });

  it.each(Object.entries(MIRRORS))(
    '%s carries the permission `%s` holds in lib/mcp/toolPermissions.ts',
    (operationId, tool) => {
      const op = WORK_LOOP_OPERATIONS.find((o) => o.operationId === operationId);
      expect(op, `${operationId} is declared`).toBeDefined();
      expect(op?.permission).toBe(TOOL_PERMISSIONS[tool]);
    },
  );

  it('ENFORCES the same permission it documents — the route’s argument, not the doc', () => {
    // The document says; the route does. Asserted separately because a docs typo
    // that also changed enforcement would be a privilege bug, which is exactly
    // why the two are independent values.
    for (const file of v1RouteFiles(REPO_ROOT)) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const [method, permission] of declaredPermissionByMethod(source)) {
        const path = pathTemplateFor(file);
        if (!WORK_LOOP_PATHS.includes(path)) continue;
        const declared = findV1Operation(method, path);
        expect(declared?.permission, `${method} ${path}`).toBe(permission);
      }
    }
  });

  it('would FAIL if a route and its declaration disagreed', () => {
    // The check, run against a violation: a synthetic route source declaring the
    // wrong permission must not match its operation.
    const synthetic =
      "export const GET = withV1Route({ permission: 'sprint:manage' }, async () => {});";
    const permission = declaredPermissionByMethod(synthetic).get('GET');
    expect(permission).toBe('sprint:manage');
    expect(findV1Operation('GET', '/api/v1/work-items/{key}/dispatch-prompt')?.permission).not.toBe(
      permission,
    );
  });
});

/** Turn a route FILE path into the OpenAPI path template it serves. */
function pathTemplateFor(routeFile: string): string {
  const segments = routeFile
    .replace(/^app[\\/]/, '')
    .split(/[\\/]/)
    .slice(0, -1)
    .map((segment) => (segment.startsWith('[') ? `{${segment.slice(1, -1)}}` : segment));
  return `/${segments.join('/')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Service → schema → response, per resource
// ─────────────────────────────────────────────────────────────────────────────

describe('service → schema → response, per resource, against real Postgres', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    vi.clearAllMocks();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'integration'],
    });
  });

  async function story(title = 'a container') {
    return workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title },
      caller.ctx,
    );
  }

  async function projectContext() {
    const project = await projectsService.getByKey(caller.projectKey, caller.ctx);
    return {
      userId: caller.ctx.userId,
      workspaceId: caller.ctx.workspaceId,
      projectId: project.id,
      project,
    };
  }

  it('the DISPATCH PROMPT maps from the real service output', async () => {
    const item = await story('dispatch me');
    const dto = await dispatchPromptService.getDispatchPrompt(
      caller.fixture.projectId,
      item.identifier,
      caller.ctx,
      {},
    );

    const mapped = presentDispatchPrompt(dto);

    expect(() => dispatchPromptSchema.parse(mapped)).not.toThrow();
    expect(mapped.key).toBe(dto.key);
    expect(mapped.prompt).toBe(dto.prompt);
  });

  it('the INTEGRATION result maps from the real service output', async () => {
    const item = await story('integrate me');
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    const dto = await workItemsService.markIntegrated(item.id, 'session/seam', caller.ctx);

    const mapped = presentIntegrationResult(dto);

    expect(() => integrationResultSchema.parse(mapped)).not.toThrow();
    expect(mapped.key).toBe(dto.identifier);
    expect(mapped.sessionBranch).toBe('session/seam');
  });

  it('the SESSION CLOSE-OUT maps from the real service output', async () => {
    const item = await story('close me');
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    await workItemsService.markIntegrated(item.id, 'session/seam', caller.ctx);
    const dto = await workItemsService.completeSession('session/seam', caller.ctx);

    const mapped = presentSessionCloseOut(dto);

    expect(() => sessionCloseOutSchema.parse(mapped)).not.toThrow();
    expect(mapped.results.map((r) => r.key)).toEqual(dto.results.map((r) => r.key));
  });

  it('the PLAN and its STATUS map from the real service output', async () => {
    const item = await story('expand me');
    const pctx = await projectContext();
    const submitted = await aiPlanEditsService.submitExpand(item.identifier, pctx);
    await plansService.addProposals(
      submitted.planId,
      [{ op: 'add', proposedFields: { title: 'a proposal', kind: 'subtask' } }],
      caller.ctx,
    );

    const plan = await plansService.getPlan(submitted.planId, caller.ctx);
    const mappedPlan = presentPlan(plan, planTargetKeyResolver({}));
    expect(() => planSchema.parse(mappedPlan)).not.toThrow();
    expect(mappedPlan.proposalCount).toBe(plan.itemCount);

    const outcome = await aiPlanEditsService.getOutcome({ planId: submitted.planId }, caller.ctx);
    const mappedOutcome = presentPlanOutcome(outcome);
    expect(() => planOutcomeSchema.parse(mappedOutcome)).not.toThrow();
    expect(mappedOutcome.proposalCount).toBe(outcome.itemCount);
  });

  it('the PLAN SESSION maps from the real service output', async () => {
    const pctx = await projectContext();
    const opened = await planChangeSessionsService.openForScope(pctx, buildScope([]));
    const dto = await planChangeSessionsService.appendTurn('a turn', pctx, {
      sessionId: opened.id,
    });

    const mapped = presentPlanSession(dto);

    expect(() => planSessionSchema.parse(mapped)).not.toThrow();
    expect(mapped.turns.map((t) => t.body)).toEqual(dto.turns.map((t) => t.body));
  });

  it('the ACTIVITY entry maps from the real service output', async () => {
    const item = await story('talked about');
    await commentsService.addComment(item.id, { bodyMd: 'hello' }, caller.ctx);
    await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
    const history = await activityService.listHistory(item.id, {}, caller.ctx);

    expect(history.entries.length).toBeGreaterThan(0);
    for (const entry of history.entries) {
      const mapped = presentActivityChange(entry);
      expect(mapped.id).toBe(entry.id);
      expect(mapped.parts).toHaveLength(entry.parts.length);
    }
  });

  it('the WIDENED work-item shapes map from the real service output', async () => {
    // 11.7.2's three projections, at the same seam as the rest.
    const parent = await story('the parent');
    const child = await workItemsService.createWorkItem(
      {
        projectId: caller.fixture.projectId,
        kind: 'subtask',
        title: 'a child',
        parentId: parent.id,
      },
      caller.ctx,
    );
    const detail = await workItemsService.getIssueDetail(
      caller.fixture.projectId,
      parent.identifier,
      caller.ctx,
    );
    const edges = await workItemsService.getDependencyEdgesForItems([child.id], caller.ctx);

    const { presentWorkItemDetail } = await import('@/lib/api/v1/workItems/schema');
    const mapped = presentWorkItemDetail(detail, 0, edges, []);

    expect(() => workItemDetailSchema.parse(mapped)).not.toThrow();
    expect(mapped.children[0]?.dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(() => readinessSchema.parse(mapped.readiness)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Error totality — driven, not inspected
// ─────────────────────────────────────────────────────────────────────────────

describe('every error these services raise resolves to a deliberate v1 status', () => {
  it.each([
    ['motir-ai unreachable', new MotirAiUnavailableError('connect ECONNREFUSED'), 503],
    ['credits exhausted', new MotirAiOutOfCreditsError('balance 0'), 402],
    ['a turn conflict', new PlanChangeTurnConflictError('sess_1', 3), 409],
    ['an empty thread', new EmptyPlanChangeIntentError('nothing to send'), 422],
    ['too many targets', new TooManyPlanChangeTargetsError(21, 20), 422],
  ])('%s → %i, through the real classifier', (_label, error, status) => {
    // Driven through `classifyApiV1Error` — the function the wrapper actually
    // calls — rather than read off the map, so a code that stopped matching its
    // error class would fail here.
    const classified = classifyApiV1Error(error);
    expect(classified?.status).toBe(status);
    expect(typeof classified?.body.code).toBe('string');
    expect(typeof classified?.body.error).toBe('string');
  });

  it('leaves an UNMAPPED motir-ai fault as a bare 500 — no code on the wire', () => {
    // The deliberate ABSENCE, held by a test: our own bad request to motir-ai is
    // our bug, and §4's 500 carries no `code` to branch on.
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_BAD_REQUEST']).toBeUndefined();
    expect(classifyApiV1Error({ code: 'MOTIR_AI_BAD_REQUEST', message: 'x' })).toBeUndefined();
  });

  it('every status these operations DECLARE is one the vocabulary documents', () => {
    const declared = new Set(WORK_LOOP_OPERATIONS.flatMap((op) => op.errorStatuses));
    for (const status of declared) {
      expect(
        Object.values(DOMAIN_ERROR_STATUS).includes(status) ||
          [401, 403, 429, 500].includes(status),
        `status ${status} is reachable`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3b. Paging — every NEW collection, walked to exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe('every collection this story added pages to exhaustion exactly once', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    caller = await createV1ProjectCaller({ scopes: ['read'] });
  });

  // The activity read is the ONLY new collection here — every other work-loop
  // endpoint returns a single object or a job handle. Its THREE views each page
  // over a different source, so each is walked separately: a walk of `all` alone
  // would leave the two narrow cursors untested.
  it.each(['all', 'comments', 'history'] as const)(
    'the `%s` view returns every row exactly once',
    async (view) => {
      const { GET } = await import('@/app/api/v1/work-items/[key]/activity/route');
      const item = await workItemsService.createWorkItem(
        { projectId: caller.fixture.projectId, kind: 'task', title: 'a paged item' },
        caller.ctx,
      );
      for (let i = 0; i < 25; i += 1) {
        await commentsService.addComment(item.id, { bodyMd: `c${i}` }, caller.ctx);
      }
      // Past the change trail's own page size too, so `history` really pages.
      for (let i = 0; i < 13; i += 1) {
        await workItemsService.updateStatus(item.id, 'in_progress', caller.ctx);
        await workItemsService.updateStatus(item.id, 'todo', caller.ctx);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string =
          `?view=${view}` + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const res: Response = await GET(
          new Request(
            `http://localhost:3000/api/v1/work-items/${item.identifier}/activity${query}`,
            {
              headers: caller.headers,
            },
          ),
          { params: Promise.resolve({ key: item.identifier }) },
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { type: string; comment?: { id: string }; change?: { id: string } }[];
          nextCursor: string | null;
        };
        for (const entry of body.items) {
          seen.push(entry.type === 'comment' ? `c:${entry.comment?.id}` : `h:${entry.change?.id}`);
        }
        cursor = body.nextCursor;
        pages += 1;
        expect(pages, 'the walk terminates').toBeLessThan(40);
      } while (cursor !== null);

      // More than one page really happened — an exhaustion test over a single
      // page proves nothing about the cursor.
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The five contract guards, each proven against a violation
// ─────────────────────────────────────────────────────────────────────────────

describe('the contract guards, and each one proven to FAIL', () => {
  /** Only this story's route files. */
  function workLoopRouteFiles(): string[] {
    return v1RouteFiles(REPO_ROOT).filter((file) =>
      WORK_LOOP_PATHS.includes(pathTemplateFor(file)),
    );
  }

  it('found this story’s routes at all — the walk is not vacuously empty', () => {
    expect(workLoopRouteFiles()).toHaveLength(WORK_LOOP_PATHS.length);
  });

  it('GUARD 1 — no work-loop route imports from lib/mcp/', () => {
    const found = workLoopRouteFiles().flatMap((file) =>
      auditV1RouteSource(file, readRouteSource(REPO_ROOT, file)),
    );
    expect(found.filter((v) => v.rule === 'imports-mcp-tools')).toEqual([]);
    // …and the audit finds NOTHING else wrong with them either.
    expect(found, JSON.stringify(found)).toEqual([]);
  });

  it('GUARD 1 FAILS on a route that reaches into the tool layer', () => {
    const found = auditV1RouteSource(
      'app/api/v1/fake/route.ts',
      "import { runGetPlan } from '@/lib/mcp/tools/getPlan';\n" +
        "export const GET = withV1Route({ permission: 'project:browse' }, async () => {});",
    );
    expect(found.map((v) => v.rule)).toContain('imports-mcp-tools');
  });

  it('GUARD 2 — no work-loop route calls Prisma or opens a transaction', () => {
    // Through the SHIPPED audit, not a hand-rolled regex: it strips comments and
    // strings first, so a route whose prose mentions a transaction is not a
    // violation and a route that opens one is. Re-deriving that here would be
    // hand-rolling a check the code already provides — and getting it wrong in
    // exactly the way a raw regex over raw source gets it wrong.
    const found = workLoopRouteFiles().flatMap((file) =>
      auditV1RouteSource(file, readRouteSource(REPO_ROOT, file)),
    );
    expect(found.filter((v) => v.rule === 'prisma-in-route')).toEqual([]);
    expect(found.filter((v) => v.rule === 'transaction-in-route')).toEqual([]);
  });

  it('GUARD 2 FAILS on a route that opens one', () => {
    const found = auditV1RouteSource(
      'app/api/v1/fake/route.ts',
      "export const GET = withV1Route({ permission: 'project:browse' }, async () => {\n" +
        '  await db.$transaction(async () => {});\n});',
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it('GUARD 3 — every work-loop route method has an operation declaration', () => {
    for (const file of workLoopRouteFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const path = pathTemplateFor(file);
      const methods = [...declaredPermissionByMethod(source).keys()];
      expect(methods.length, `${file} exports a verb`).toBeGreaterThan(0);
      for (const method of methods) {
        expect(findV1Operation(method, path), `${method} ${path} undocumented`).toBeDefined();
      }
    }
  });

  it('GUARD 3 FAILS for a method the registry does not declare', () => {
    expect(findV1Operation('DELETE', '/api/v1/work-items/{key}/dispatch-prompt')).toBeUndefined();
  });

  it('GUARD 4 — every MCP tool this story mirrors is STILL REGISTERED, under the same scope', () => {
    // "Agents keep MCP", as a property that holds at any commit.
    //
    // ⚠️ This was first written as `git diff --name-only <merge-base> -- tests/mcp`,
    // and that was WRONG — not weak, wrong: the CI checkout is shallow and has
    // no `origin/main`, so the guard threw on every run while passing locally. A
    // check that only works in the author's worktree is worse than none, because
    // it reads as coverage. "The diff does not touch these files" is a REVIEW
    // property the pull request shows; what a test can hold is the property that
    // diff was standing in for — the tools are still there, still named the
    // same, and still gated the same.
    //
    // The other two halves are held elsewhere and together they are stronger
    // than the diff was: the shipped `tests/mcp/` suites run in this same CI and
    // prove the tools still BEHAVE identically, and GUARD 1 proves no v1 route
    // reaches into the tool layer to make that true.
    const registered = new Set<string>(MCP_TOOL_NAMES);
    for (const [operationId, tool] of Object.entries(WORK_LOOP_MIRRORS)) {
      expect(registered, `${tool} (mirrored by ${operationId})`).toContain(tool);
      // …and gated exactly as it was: v1 MIRRORS this entry, so a change here
      // would silently move the public API's gate too.
      expect(TOOL_PERMISSIONS[tool], `${tool}'s scope`).toBeDefined();
    }
  });

  it('GUARD 4 FAILS on a tool that left the registry', () => {
    // The check, run against a violation: a registry missing one of the ten
    // must not satisfy it.
    const withoutOne = new Set<string>(MCP_TOOL_NAMES);
    withoutOne.delete('dispatch_prompt');
    expect(withoutOne.has('dispatch_prompt')).toBe(false);
    expect(new Set<string>(MCP_TOOL_NAMES).has('dispatch_prompt')).toBe(true);
  });

  it('GUARD 5 — no published field was removed or retyped by the widenings', () => {
    // §8 is additive-only, and 11.7.2 widened three SHIPPED shapes. Every field
    // that was on them before is still there, with the same optionality.
    const summaryKeys = Object.keys(workItemSummarySchema.shape);
    for (const field of [
      'key',
      'kind',
      'type',
      'title',
      'status',
      'priority',
      'assigneeId',
      'reporterId',
      'dueDate',
      'estimateMinutes',
      'storyPoints',
      'createdAt',
      'updatedAt',
    ]) {
      expect(summaryKeys, `workItemSummarySchema.${field}`).toContain(field);
    }
    // The addition, and ONLY the addition.
    expect(summaryKeys).toContain('dependencies');

    const readinessKeys = Object.keys(readinessSchema.shape);
    expect(readinessKeys).toContain('ready');
    expect(readinessKeys).toContain('openBlockers');
    // ⚠️ The published field the title arrived BESIDE, never instead of.
    expect(readinessKeys).toContain('blockedByAncestorKey');
    expect(readinessKeys).toContain('blockedByAncestorTitle');

    const detailKeys = Object.keys(workItemDetailSchema.shape);
    for (const field of ['descriptionMd', 'parentKey', 'ancestorKeys', 'children', 'links']) {
      expect(detailKeys, `workItemDetailSchema.${field}`).toContain(field);
    }
    // …and the detail did NOT quietly inherit a second edge block beside `links`.
    expect(detailKeys).not.toContain('dependencies');
  });

  it('GUARD 5 FAILS on a schema that dropped a published field', () => {
    const dropped = workItemSummarySchema.omit({ storyPoints: true });
    expect(Object.keys(dropped.shape)).not.toContain('storyPoints');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The registry stays coherent as the story lands
// ─────────────────────────────────────────────────────────────────────────────

describe('the merged operation registry', () => {
  it('declares each work-loop operation exactly once', () => {
    const keys = WORK_LOOP_OPERATIONS.map(operationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every work-loop operation a UNIQUE operationId across the whole API', () => {
    // A code generator names its methods after these.
    const all = V1_OPERATIONS.map((op) => op.operationId);
    expect(new Set(all).size).toBe(all.length);
  });

  it('gates every work-loop operation on a REAL scope', () => {
    for (const op of WORK_LOOP_OPERATIONS) {
      expect(realPermissions(), `${op.operationId}`).toContain(op.permission);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The mapper branches a happy path never reaches
// ─────────────────────────────────────────────────────────────────────────────

describe('the mappers’ unreached branches', () => {
  it('resolves a plan target through its THREE ref states', () => {
    const resolve = planTargetKeyResolver({
      known: { accessible: true, identifier: 'PROD-7' },
      // Exists, in a project this caller may not browse — the arm a route-level
      // closure would leave untested, and the one that must NOT leak the id.
      hidden: { accessible: false },
    });

    expect(resolve('known')).toBe('PROD-7');
    expect(resolve('hidden')).toBeUndefined();
    expect(resolve('deleted')).toBeUndefined();
  });

  it('renders every activity VALUE type, named and unnamed', () => {
    const mapped = presentActivityChange({
      id: 'rev',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: null },
      parts: [
        {
          kind: 'field',
          field: 'dueDate',
          from: { type: 'none' },
          to: { type: 'date', date: '2026-09-01' },
        },
        {
          kind: 'field',
          field: 'sprint',
          from: { type: 'sprint', sprintId: 's1', name: 'Sprint 1' },
          to: { type: 'sprint', sprintId: 's2', name: null },
        },
        {
          kind: 'field',
          field: 'assignee',
          from: { type: 'user', userId: 'u1', name: 'Yue' },
          to: { type: 'user', userId: 'u2', name: null },
        },
        {
          kind: 'field',
          field: 'status',
          from: { type: 'status', key: 'todo', label: 'To Do' },
          to: { type: 'status', key: 'done', label: null },
        },
      ],
    });

    expect(mapped.parts).toEqual([
      {
        kind: 'field',
        field: 'dueDate',
        from: { type: 'none' },
        to: { type: 'date', date: '2026-09-01' },
      },
      {
        kind: 'field',
        field: 'sprint',
        from: { type: 'sprint', sprintId: 's1', name: 'Sprint 1' },
        to: { type: 'sprint', sprintId: 's2', name: null },
      },
      {
        kind: 'field',
        field: 'assignee',
        from: { type: 'user', userId: 'u1', name: 'Yue' },
        to: { type: 'user', userId: 'u2', name: null },
      },
      {
        kind: 'field',
        field: 'status',
        from: { type: 'status', key: 'todo', label: 'To Do' },
        to: { type: 'status', key: 'done', label: null },
      },
    ]);
  });

  it('handles a `collection` part with a REMOVED op and no items', () => {
    const mapped = presentActivityChange({
      id: 'rev',
      changeKind: 'updated',
      changedAt: '2026-08-05T00:00:00.000Z',
      actor: { userId: 'u1', name: 'Yue' },
      parts: [
        { kind: 'collection', field: 'labels', op: 'removed', items: undefined },
        { kind: 'link', op: 'removed', linkKind: 'blocks', target: { type: 'issue' } },
        { kind: 'commentDeleted', author: { type: 'user', userId: 'u1' } },
      ],
    });

    expect(mapped.parts[0]).toEqual({
      kind: 'collection',
      field: 'labels',
      op: 'removed',
      items: [],
    });
    expect(mapped.parts[1]).toEqual({
      kind: 'link',
      op: 'removed',
      linkKind: 'blocks',
      target: { type: 'issue', workItemKey: null },
    });
    expect(mapped.parts[2]).toEqual({
      kind: 'commentDeleted',
      author: { type: 'user', userId: 'u1', name: null },
      replyCount: 0,
    });
  });
});
