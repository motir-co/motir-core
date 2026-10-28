import { z } from 'zod/v4';
import type { ZodType } from 'zod/v4';
import { defineOperation, type V1Operation } from '@/lib/api/v1/openapi/operation';
import {
  dispatchPromptSchema,
  implementationReportBodySchema,
  implementationReportSchema,
  integrationBodySchema,
  integrationResultSchema,
  planJobHandleSchema,
  planOutcomeSchema,
  planSchema,
  planSessionSchema,
  workItemPlanSchema,
  planSessionScopeBodySchema,
  planTurnBodySchema,
  workItemClaimSchema,
  workItemRepairClaimSchema,
  workItemContinueClaimSchema,
  scopeClaimBodySchema,
  scopeClaimSchema,
  ACTIVITY_VIEWS,
  activityEntrySchema,
  activityTotalsSchema,
  sessionCloseOutBodySchema,
  sessionCloseOutSchema,
  dispatchRunAppendBodySchema,
  dispatchRunAppendedSchema,
  dispatchRunCardSchema,
  dispatchRunCloseBodySchema,
  dispatchRunCloseOutPromptSchema,
  dispatchRunGitCredentialsSchema,
  currentTestInstructionsSchema,
  dispatchRunOpenBodySchema,
  dispatchRunOpenedSchema,
  dispatchRunSchema,
} from '@/lib/api/v1/workLoop/schema';
import {
  runDiscrepancyAcknowledgementSchema,
  runDiscrepancyBodySchema,
  runStopReportAcknowledgementSchema,
  runStopReportBodySchema,
} from '@/lib/api/v1/workLoop/runAgentReports';
import {
  unbuildableReportAcknowledgementSchema,
  unbuildableReportBodySchema,
} from '@/lib/api/v1/workLoop/unbuildableReport';
import {
  agentReviewBodySchema,
  agentReviewResultSchema,
  reviewPromptSchema,
} from '@/lib/api/v1/workLoop/agentReview';

// The WORK-LOOP operation declarations (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237). Paths, verbs and scopes come from ADR Amendment 6 Q1/Q2; the
// scope of each was read off the SHIPPED `lib/mcp/scopes.ts` entry its MCP
// counterpart carries, never re-derived from the HTTP verb.
//
// ⚠️ **A DECLARATION TRAVELS WITH ITS ROUTE.**
// `tests/api/v1/openapi-operations-coverage.test.ts` asserts both directions —
// every exported verb is documented, AND no operation names a route that does
// not exist. So this module grows one entry per endpoint card (11.7.4–11.7.7)
// rather than being written out in full here: an operation with no route would
// put a path in the published document that answers 404, which is worse for a
// client than a document that is still filling in.
//
// The schemas those cards return into are ALREADY declared, in
// `./schema.ts` — that is what makes them adapters rather than designers, and it
// is the half of "declare ahead" that has no such constraint.

/** The one work-loop endpoint that has shipped so far. */
export const WORK_LOOP_OPERATIONS: readonly V1Operation[] = [
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/dispatch-prompt',
    operationId: 'getWorkItemDispatchPrompt',
    summary: 'Read the canonical coding-agent prompt for a work item',
    description:
      'Return the server-assembled prompt for one work item — the CONTEXT / WHAT TO DO / ' +
      'ACCEPTANCE CRITERIA / GIT WORKFLOW sections built from the item, its parent, its ' +
      'dependencies and its repo — plus the repo to run it in and which git workflow it ' +
      'carries. A PURE READ: it does not claim the item, move its status, or change its ' +
      'recorded session branch, so fetching a prompt to look at it is always safe. The text ' +
      'is deliberately identical for every agent harness; do not rewrite it. `advisories` is ' +
      'never a gate — it changes what you are told, never what you may do.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
      {
        name: 'sessionBranch',
        in: 'query',
        required: false,
        description:
          'A session branch to FALL BACK to when this item carries no lineage of its own — ' +
          'the unattended-run seed. It never overrides: an item whose dependencies are ' +
          'already integrated, or that is itself integrated, keeps its own branch, so a ' +
          'caller cannot redirect a live lineage.',
        schema: z.string(),
      },
      {
        name: 'autoApproveReplan',
        in: 'query',
        required: false,
        description:
          '`1` when THIS run’s loop is willing to approve a submitted re-plan itself and carry ' +
          'on (`motir auto --auto-approve-replan`). It adds a section telling the agent that ' +
          'a correction kept to its own card and that card’s siblings may be approved ' +
          'unattended, while anything wider — anchored at a container, or at nothing — goes to ' +
          'a person and stops the run, and that BOTH are legitimate. ⚠️ It changes the TEXT ' +
          'only: the agent’s tools, anchor and single submit are identical either way, and the ' +
          'bound on what may be approved is the LOOP’s, enforced over the plan that comes ' +
          'back. Absent means no, and it is ignored when `findingsPolicy` disables `replan` — ' +
          'approving a plan the agent was told not to submit is not a lane.',
        schema: z.string(),
      },
      {
        name: 'agentReport',
        in: 'query',
        required: false,
        description:
          '`1` when the CLIENT that will launch the agent posts what the agent writes into ' +
          '`$MOTIR_AGENT_REPORT` as `unbuildable`, `discrepancy` and `stop` (MOTIR-8810). With ' +
          'it, the STOP branch tells the agent to put its unbuildable reason in that file, and ' +
          'an agent with no Motir tools to put its discrepancy and its stop there too. Absent ' +
          'means no: the report goes through the `report_unbuildable_target` tool and neither ' +
          'file route is named, because a client that does not post them would drop them. ' +
          '⚠️ It changes the TEXT only.',
        schema: z.string(),
      },
      {
        name: 'agentReportDecisions',
        in: 'query',
        required: false,
        description:
          '`1` when the CLIENT that will launch the agent also posts the `decisions` the agent ' +
          'writes into `$MOTIR_AGENT_REPORT` (MOTIR-10000). With it, and with `agentReport`, the ' +
          'prompt tells an agent with no Motir tools to record its decisions in that file. ' +
          'Absent means no: the decisions are recorded through `record_run_discrepancy` and ' +
          'listed in the pull request, and the file route is not named, because a client that ' +
          'does not post them would drop them. ⚠️ It changes the TEXT only.',
        schema: z.string(),
      },
      {
        name: 'continueFrom',
        in: 'query',
        required: false,
        description:
          'The id of a DEAD run of this item to CONTINUE (MOTIR-6531, `motir continue`). The ' +
          'prompt then carries a CONTINUE block — how that run ended, when it was last heard ' +
          'from, who ran it, its branch and its open pull request — and a git workflow that ' +
          'CHECKS THAT BRANCH OUT instead of cutting one. The branch is the item\u2019s open ' +
          'pull request\u2019s head, else the one the run recorded on `checkout_ready`. A run ' +
          'that is still open, that succeeded, that holds no leg for this item or that belongs ' +
          'to another workspace is `CONTINUE_FROM_INVALID` (422).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchPromptSchema },
      description: 'The assembled prompt and the facts a client routes on.',
    },
    // 404 covers both "no such item" and "outside your workspace" (§4); 422 is a
    // malformed key or an unsafe `sessionBranch`.
    errorStatuses: [404, 422],
  }),

  // ── The keyed CLAIM (MOTIR-2961) ────────────────────────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/claim',
    operationId: 'claimWorkItem',
    summary: 'Atomically claim one work item by key',
    description:
      'CLAIM one work item, named by key, so that concurrent dispatchers cannot both start it. ' +
      'In ONE transaction the row is locked, its status is re-checked against the TO-DO ' +
      'category, and — if it holds — the item is assigned to the caller AND moved to ' +
      '\u201cIn progress\u201d. The to-do category is `todo` AND `blocked`, so a deliberately ' +
      'forced dispatch of an item whose dependencies are unmet still works. ' +
      '\u26a0\ufe0f A refusal is a 200 with an `outcome`, not an error, because three of the ' +
      'four outcomes are ordinary: `claimed` (it is yours), `mine` (already yours \u2014 resume ' +
      'your own interrupted run), `taken` (somebody else holds it, and they are named), ' +
      '`not_claimable` (finished, under review, or otherwise outside the to-do category). ' +
      'Claiming is IDEMPOTENT for the holder and never re-opens finished work. ' +
      'The claim IS the dispatch status flip \u2014 do not also POST a transition afterwards.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item\u2019s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemClaimSchema },
      description: 'What the claim resolved to, and who holds the item.',
    },
    // 404 for an unknown or cross-workspace key (no existence leak); 422 for a
    // malformed key. A LOST claim is not an error status \u2014 see `outcome`.
    errorStatuses: [404, 422],
  }),

  // ── The CONTINUE claim (Story MOTIR-6526 · MOTIR-6532) ──────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/continue',
    operationId: 'claimWorkItemContinue',
    summary: 'Claim the continue of a work item whose last run died',
    description:
      'Take over a work item whose last run DIED (`motir continue <key>`), for any member who ' +
      'may edit the project, and hand back what the continuing agent needs: the dead run, the ' +
      'branch its work is on, and its open pull request. In ONE transaction the item\u2019s row ' +
      'is locked and, in order: an open dispatch run with command `continue` already holding ' +
      'the item answers `mine` (yours \u2014 same `runId`, the branch again) or `taken` (named, ' +
      'with its start); a run that is still ALIVE (a local run that heartbeat within 5 minutes, ' +
      'an open hosted run) is `not_continuable` (`run_alive`, naming its dispatcher); an item at ' +
      'Implemented / In Review / Approved is `use_fix` (its pull request is open \u2014 CI or ' +
      '`motir fix` owns it); any other status but In Progress is `not_in_progress`; a leg of a ' +
      'dead PARENT run is `continue_the_parent` (naming `parentKey`); no run that ended without ' +
      'success is `no_dead_run`; a run that STOPPED AT A GATE (closed `gated`) whose gates all ' +
      'still wait is `gate_awaiting`, and one whose gates were sent back and none approved is ' +
      '`gate_sent_back` (both naming `gates`); a dead run that left no branch is `no_branch`. ' +
      'A gated run with an APPROVED gate is taken over like a dead one, as a resume ' +
      '(`resumesGated`, the approved `gates`). Otherwise a ' +
      'LAPSED run still reading `running` is closed `abandoned`, the item is RE-ASSIGNED to the ' +
      'caller, and a `continue` run is opened: `claimed`. \u26a0\ufe0f A refusal is a 200 with an ' +
      '`outcome`, not an error. \u26a0\ufe0f The item\u2019s STATUS is never written. Heartbeat the ' +
      'run (`heartbeatDispatchRun`) and CLOSE it (`closeDispatchRun`) when the continue ends.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item\u2019s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemContinueClaimSchema },
      description:
        'What the continue claim resolved to, the `continue` run, the dead run and the branch.',
    },
    // 404 for an unknown or cross-workspace key (no existence leak); 422 for a
    // malformed key. A refused continue is not an error status — see `outcome`.
    errorStatuses: [404, 422],
  }),

  // ── The REPAIR claim (Story MOTIR-5460 · MOTIR-5464) ────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/repair',
    operationId: 'claimWorkItemRepair',
    summary: 'Claim the repair of a work item\u2019s failing or ejected pull requests',
    description:
      'Hand a work item\u2019s RED pull requests to ONE fixing agent, after the run that opened ' +
      'them has ended (`motir fix <key>`): an `implemented` item, or an `in_review` one the merge ' +
      'queue threw out for a reason a CODE CHANGE could answer. In ONE transaction the ' +
      'item\u2019s row is locked and, in ' +
      'order: an archived item, or one at neither the Implemented nor the In Review status, is ' +
      '`not_repairable` (`not_implemented`); an In Review item with no merge-queue outcome ' +
      'standing at a pull request\u2019s current head is `not_failing`; an In Review item whose ' +
      'standing outcome is one no code change fixes \u2014 a repository setting, or a hand ' +
      'removal from the queue \u2014 is `repair_not_code`; an item whose pull requests belong to a run ' +
      'launched against another item is `not_repairable` (`repair_on_run_target`, naming ' +
      '`runTargetKey`); an item with no pull requests is `no_pull_requests`; an item with no ' +
      'failing OPEN pull request is `ci_running` when one is running, else `not_failing`. ' +
      'A pull request the merge queue threw out for a failure that still stands at its ' +
      'current head counts as FAILING whatever its own checks say, and carries `queueExit` ' +
      '(the reason and the queue\u2019s failing check). ' +
      'Otherwise an open dispatch run with command `fix` already holding the item answers ' +
      '`mine` (yours \u2014 a resumed repair, same `runId`) or `taken` (somebody else\u2019s, ' +
      'named with its start), and if there is none a `fix` run is opened: `claimed`. ' +
      '\u26a0\ufe0f A refusal is a 200 with an `outcome`, not an error. \u26a0\ufe0f The item\u2019s ' +
      'status and assignee are NEVER written: the open run is the lock, and the build moves ' +
      'the item when it goes green. CLOSE the run (`closeDispatchRun`) when the repair ends.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item\u2019s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemRepairClaimSchema },
      description:
        'What the repair claim resolved to, the `fix` run, and the failing pull requests.',
    },
    // 404 for an unknown or cross-workspace key (no existence leak); 422 for a
    // malformed key. A refused repair is not an error status — see `outcome`.
    errorStatuses: [404, 422],
  }),

  // ── The SCOPE claim (MOTIR-3049) ────────────────────────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/scope-claims',
    operationId: 'claimScope',
    summary: 'Atomically claim a whole story or sprint, all or nothing',
    description:
      'CLAIM an entire SCOPE — a container work item and its children, or a project’s ACTIVE ' +
      'sprint — so a scoped run owns the whole set before its first agent starts. In ONE ' +
      'transaction the scope is validated, every row is locked in a deterministic order, every ' +
      'row’s status is re-checked against the TO-DO category, and — if all of them hold ' +
      '— every row is assigned to the caller AND moved to “In progress”. ' +
      '⚠️ ALL OR NOTHING: if ANY member is un-claimable the whole claim rolls back and ' +
      'NOTHING is written, because a partially-claimed scope is the one outcome with no good ' +
      'handling — you can neither finish it nor cleanly abandon it. ' +
      '⚠️ EVERY WORK ITEM IN A CLAIMED SCOPE READS “In progress” FOR THE WHOLE ' +
      'RUN, while only one of them is being worked at a time. That is deliberate and it changes ' +
      'what the status MEANS: from “an agent is on this right now” to “this run ' +
      'owns it”. The board therefore shows the run’s FOOTPRINT rather than its cursor ' +
      '— the price of exclusive ownership, which is what lets a scoped run promise to ' +
      'finish what it started. ' +
      'A refusal is a 200 with an `outcome`: `claimed`, `mine` (already yours — resume), ' +
      '`taken` (a member is held by somebody else, and they are named), `not_claimable` (a ' +
      'member is finished or under review), `wrong_shape` (a work-item scope whose child is ' +
      'itself a container — re-plan it, do not retry), `not_finishable` (work OUTSIDE the ' +
      'scope gates work inside it). ' +
      'A STORY scope is ONE LAYER and that is checked; a SPRINT scope may span many layers and ' +
      'no shape check applies, because `validate_sprint` has already guaranteed its membership ' +
      'is closed. A sprint’s scope is exactly the items whose OWN `sprintId` matches — ' +
      'an item under an in-sprint parent but not itself in the sprint is NOT claimed. ' +
      'The claim IS the dispatch status flip — do not also POST a transition afterwards.',
    permission: 'work_item:edit',
    parameters: [],
    requestBody: {
      schema: scopeClaimBodySchema,
      description:
        'The scope to claim: `{ "kind": "work_item", "key": "MOTIR-42" }` for a container and ' +
        'its children, or `{ "kind": "sprint", "projectKey": "MOTIR" }` for that project’s ' +
        'active sprint.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: scopeClaimSchema },
      description: 'What the claim resolved to, and — on a refusal — why.',
    },
    // 404 for an unknown or cross-workspace key/project (no existence leak); 409
    // when the named project has no ACTIVE sprint; 422 for a malformed key or
    // body. A LOST or REFUSED claim is not an error status — see `outcome`.
    errorStatuses: [404, 409, 422],
  }),

  // ── Session close-out (Subtask 11.7.4 — MOTIR-2238) ─────────────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/integration',
    operationId: 'recordWorkItemIntegration',
    summary: 'Record a work item as integrated on a session branch',
    description:
      'Record that a work item’s work has been integrated onto a session branch: it moves to ' +
      '“In review” and records the branch, in ONE transaction, which unblocks its dependents ' +
      'while the session pull request awaits a human merge. Optionally self-report the ' +
      'implementation harness and model (`implementationSource` defaults to `byok`); omit all ' +
      'three to leave the item’s recorded provenance untouched. Honors the project’s workflow ' +
      'rules — an item with no legal path to “In review” is refused and its branch is left ' +
      'unchanged.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: integrationBodySchema,
      description: 'The session branch the work was integrated onto, and optional provenance.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: integrationResultSchema },
      description: 'The item’s new status, its recorded branch and its provenance.',
    },
    // 422 covers a malformed key, a failed body validation, and the workflow's
    // own refusal (`ILLEGAL_TRANSITION`).
    errorStatuses: [404, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/implementation',
    operationId: 'reportWorkItemImplementation',
    summary: 'Record what BUILT a work item',
    description:
      'Record implementation provenance — the harness and model an agent ran as, and whether ' +
      'the run was `byok` or `manual` — WITHOUT asserting anything about where the work is ' +
      'integrated. Use this on the per-item pull-request path, where there is no session ' +
      'branch to report; use `POST …/integration` when there is one. It moves NO status and ' +
      'leaves the item’s session branch untouched, both of which are echoed back so a client ' +
      'can see it. A field you omit is left exactly as it is — omitting all of them changes ' +
      'nothing.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: implementationReportBodySchema,
      description:
        'The provenance to record. `sessionBranch` is NOT accepted here — send it to ' +
        '`POST …/integration`, which is the operation that asserts integration.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: implementationReportSchema },
      description: 'The item’s recorded provenance, with its unchanged status and branch.',
    },
    errorStatuses: [404, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/sessions/complete',
    operationId: 'completeSession',
    summary: 'Close out a merged session branch',
    description:
      'Close out a session branch after its pull request is merged: every work item recorded ' +
      'on the branch moves to “Done” and its recorded branch is cleared. Returns a PER-ITEM ' +
      'outcome (`completed` / `already_done` / `failed`) — a partial close-out is a real ' +
      'result, not an error: the items that could close DID, and the ones that could not are ' +
      'named with a reason. Read the results; do not infer an outcome from their count. A ' +
      'branch nothing is recorded on returns an empty list, not a 404. The branch travels in ' +
      'the BODY because a git ref routinely contains `/`.',
    permission: 'work_item:edit',
    parameters: [],
    requestBody: {
      schema: sessionCloseOutBodySchema,
      description: 'The merged session branch, and optional provenance for every item closed.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: sessionCloseOutSchema },
      description: 'The branch and one outcome per item that was recorded on it.',
    },
    errorStatuses: [422],
  }),

  // ── Expansion + the two plan reads (Subtask 11.7.5 — MOTIR-2239) ────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/expansions',
    operationId: 'submitWorkItemExpansion',
    summary: 'Submit an AI expansion of a container work item',
    description:
      'Submit an AI expansion of one CONTAINER work item (epic / story / task / bug): the ' +
      'planner drafts the children it should have. Returns `202` with `{ jobId, planId, ' +
      'statusUrl }` the moment the job is ACCEPTED — it does not wait for the planner, and ' +
      'the body carries no result because there is none yet. ' +
      '⚠️ IMPORTANT: this does NOT create work items. The job produces a PLAN of proposals, ' +
      'and approving that plan in Motir is the only thing that turns a proposal into a work ' +
      'item. Do not report expanded children as created. ' +
      '⚠️ A submit SPENDS the token owner’s AI credits, so wrapping this call in a blind ' +
      'retry-on-timeout costs real money — poll `statusUrl` instead of resubmitting. A leaf ' +
      '(subtask) cannot be expanded.',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The container work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 202,
      body: { kind: 'object', schema: planJobHandleSchema },
      description:
        'The job was accepted. Nothing has been planned yet — poll `statusUrl` for the outcome.',
    },
    // 422: a malformed key, or a target that is not a container. 402: the
    // owner's AI credits are exhausted. 503: motir-ai could not be reached.
    errorStatuses: [402, 404, 422, 503],
  }),

  defineOperation({
    method: 'GET',
    path: '/api/v1/plans/{planId}/status',
    operationId: 'getPlanStatus',
    summary: 'Read what became of a submitted planning job',
    description:
      'Read a plan’s status (`generating` / `planned` / `approved` / `declined`), how many ' +
      'PROPOSALS it bundles, and — while it is still generating — whether the producing job ' +
      'is alive or already FAILED. That last distinction is the point of this endpoint: a ' +
      'failed job writes no terminal plan state of its own — a background reconciler declines ' +
      'an empty one within the hour, so the plan status alone cannot tell you to stop polling ' +
      'NOW. `job.reachable: false` means motir-ai could not be asked, not ' +
      'that the job died. A pure read; the proposal count is NOT a count of created work items.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'planId',
        in: 'path',
        required: true,
        description: 'The plan id an expansion or plan-session submit returned.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: planOutcomeSchema },
      description: 'The plan’s status, its proposal count, and the job’s liveness.',
    },
    errorStatuses: [404],
  }),

  defineOperation({
    method: 'GET',
    path: '/api/v1/plans/{planId}',
    operationId: 'getPlan',
    summary: 'Read a plan with the proposals it bundles',
    description:
      'Read a plan WITH its proposals — what a planning pass actually proposed, not just how ' +
      'many. Each proposal carries its `op` (`add` / `modify` / `remove`), the ' +
      '`proposedFields` of an `add`, the `patch` of a `modify`, and the `parentRef` / ' +
      '`blockedByRefs` that let you rebuild the proposed tree and its dependency edges. ' +
      '⚠️ These are PROPOSALS, not work items: an `add`’s `workItemKey` is `null` and stays ' +
      'null until the plan is approved in Motir, which is the only path from a proposal to a ' +
      'work item. A plan still generating returns the proposals that have arrived so far.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'planId',
        in: 'path',
        required: true,
        description: 'The plan id.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: planSchema },
      description: 'The plan and its proposals.',
    },
    errorStatuses: [404],
  }),

  // ── Automatic plan approval (MOTIR-3021 / MOTIR-3023) ───────────────────
  //
  // The READ comes first because it is what a caller does first: an unattended
  // loop looks at the plan, decides whether it is inside the lane it may approve
  // on its own, and only then POSTs.
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/plan-approval',
    operationId: 'getWorkItemPlan',
    summary: 'Read the plan this work item produced, without deciding it',
    description:
      'READ the plan a work item’s own re-plan produced — the proposals, BEFORE anybody ' +
      'decides on them. Resolved by exactly the walk `approveWorkItemPlan` uses (the planning ' +
      'conversation ANCHORED at this key → its last submitted job → that job’s plan), so what ' +
      'this returns is the plan that POST would approve, and there is no way to name a plan ' +
      'the item did not produce. ⚠️ It DECIDES NOTHING: no status moves, no proposal ' +
      'materializes, and the plan is left exactly where it was — a plan still `generating` ' +
      'comes back with the proposals that have arrived so far. It exists for an unattended ' +
      'loop that must BOUND what it is about to approve: `motir auto --auto-approve-replan` ' +
      'reads the proposals, checks that every one of them falls inside the card’s own lane, ' +
      'and declines to approve one that does not. ⚠️ `plan` IS `null` WHEN NOTHING IS ANCHORED ' +
      'HERE, which is the ordinary state of almost every card and is an ANSWER rather than an ' +
      'error — it is how a caller learns that a re-plan was anchored somewhere else, at a ' +
      'container or at nothing. ⚠️ READING IS `project:browse`, and only DECIDING is ' +
      '`ai:decide_plan`: the plan inside the wrapper is exactly the document ' +
      '`GET /api/v1/plans/{planId}` already returns to the same audience, addressed by the card ' +
      'instead of by an id its caller has no way to learn. The bound worth having is on the ' +
      'decision, and that one is untouched.',
    // `project:browse` — the key its service asserts (`plansService.getPlan` →
    // `assertCanBrowse`), and the answer this API's own operation→permission
    // table gives for EVERY GET. It is also what the plan read beside it
    // (`getPlan`) declares, which matters more than the symmetry: two doors onto
    // one document must not disagree about who may open it.
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item whose plan is read (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: workItemPlanSchema },
      description:
        '`plan` carries the plan and its proposals, in the same shape ' +
        '`GET /api/v1/plans/{planId}` returns — or `null` when no plan is anchored at this card.',
    },
    // 404: no such work item, or one in another tenant. NOT 422 for a card with
    // no plan: that is `plan: null` at 200, because the question was answerable.
    errorStatuses: [404],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/plan-approval',
    operationId: 'approveWorkItemPlan',
    summary: 'Approve the plan this work item produced',
    description:
      'APPROVE the plan a work item’s own re-plan produced, without a browser session — the ' +
      'entrance `motir auto --auto-approve-replan` drives. Its proposals become work items: an ' +
      '`add` creates, a `modify` applies to the same item, a `remove` archives. ⚠️ IT IS ' +
      'ADDRESSED BY THE WORK ITEM, and that is the bound: the server resolves the plan from the ' +
      'planning conversation ANCHORED at this key, so there is no way to name a plan the item ' +
      'did not produce. Every other plan — a cadence plan, an onboarding generation, one ' +
      'submitted from the project-wide panel — is refused here and keeps the human decision it ' +
      'was written under. It calls the same service the in-app approve does, so the ' +
      'confirmation gate, the re-validation and the one-shot concurrency guard are identical; a ' +
      'plan that has already been approved or declined answers 409, exactly as it does in the app.',
    // `ai:decide_plan` since MOTIR-3188 — the key `approvePlan` asserts. It was
    // `ai:view_plan` when this operation shipped; that key gated no view and held
    // AUTHOR and DECIDE together, and the decisions moved to the new one. The
    // operation's shape, statuses and error codes are untouched, and both keys
    // resolve to exactly the same actors under every built-in role.
    permission: 'ai:decide_plan',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item whose plan is approved (case-insensitive).',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: planSchema },
      description:
        'The approved plan and its proposals, each now carrying the `workItemKey` it ' +
        'materialized into. The plan’s own id is on the body, which is how a caller that never ' +
        'knew it can report what was approved.',
    },
    // 404: no such work item, or one in another tenant. 422: no plan anchored to
    // the card, or a proposal the confirmation gate rejected before any write —
    // including the malformed-set refusals the browser route answers 400 for,
    // which take 422 here because this API's status vocabulary is closed and has
    // no 400 (`lib/api/v1/errors.ts` says why on the row). 409: already decided,
    // or a target that moved under the proposal.
    errorStatuses: [404, 409, 422],
  }),

  // ── The planning conversation (Subtask 11.7.6 — MOTIR-2240) ─────────────
  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/plan-session',
    operationId: 'openPlanSession',
    summary: 'Open or resume the planning conversation for a scope',
    description:
      'Open — or RESUME — the planning conversation for a project, and read its thread. ' +
      'Changing a plan in Motir is a multi-turn CONVERSATION: add turns, then send the ' +
      'accumulated intent. There is ONE thread per project per anchor set, so calling this ' +
      'again returns the SAME conversation, with every turn already on it — including the one ' +
      'the Motir web app shows. Pass `targetKeys` to anchor the conversation at specific work ' +
      'items ("re-plan these two"); omit it for the project-wide thread. The anchor set is ' +
      'the thread’s identity: order and duplicates do not matter. ' +
      'Opening submits nothing and costs nothing — which is why it is `read`-scoped despite ' +
      'being a POST (a GET that creates a row would not be safe).',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'projectKey',
        in: 'path',
        required: true,
        description: 'The project key, e.g. `MOTIR`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: planSessionScopeBodySchema,
      description: 'The optional anchor set. Omit for the project-wide thread.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: planSessionSchema },
      description: 'The thread, with every turn on it.',
    },
    errorStatuses: [404, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/plan-session/turns',
    operationId: 'appendPlanTurn',
    summary: 'Add one turn to the planning conversation',
    description:
      'Add ONE turn — what you want changed about the plan. ' +
      '⚠️ IMPORTANT: appending does NOT submit. The turn is persisted immediately, but no ' +
      'job starts, no credits are spent and no work item changes; turns ACCUMULATE until you ' +
      'post a submission, which is what sends them to the planner. That separation is the ' +
      'point — a later turn REFINES the earlier ones rather than replacing them, so "add auth ' +
      'to the billing epic" then "keep them under 3 points" go out as ONE coherent change. ' +
      'Addresses the thread by scope, so it always extends the same conversation.',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'projectKey',
        in: 'path',
        required: true,
        description: 'The project key, e.g. `MOTIR`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: planTurnBodySchema,
      description: 'What to say in this turn, and the optional anchor set it belongs to.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: planSessionSchema },
      description: 'The thread, with the new turn appended.',
    },
    errorStatuses: [404, 409, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/projects/{projectKey}/plan-session/submissions',
    operationId: 'submitPlanSession',
    summary: 'Send the thread’s accumulated intent to the planner',
    description:
      'Send this conversation’s accumulated intent to the planner: every turn on the thread, ' +
      'in order, as ONE change. Returns `202` with `{ jobId, planId, statusUrl }` the moment ' +
      'the job is accepted — it does not wait, and the body carries no result because there ' +
      'is none yet. The thread stays INTACT and can be refined with another turn. ' +
      '⚠️ This is the act that SPENDS the token owner’s AI credits, and it produces a PLAN of ' +
      'proposals: approving that plan in Motir is the only thing that turns a proposal into a ' +
      'work item. Submitting a thread with no turns is refused.',
    permission: 'ai:plan',
    parameters: [
      {
        name: 'projectKey',
        in: 'path',
        required: true,
        description: 'The project key, e.g. `MOTIR`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: planSessionScopeBodySchema,
      description: 'The optional anchor set naming which thread to submit.',
    },
    response: {
      status: 202,
      body: { kind: 'object', schema: planJobHandleSchema },
      description:
        'The job was accepted. Nothing has been planned yet — poll `statusUrl` for the outcome.',
    },
    errorStatuses: [402, 404, 422, 503],
  }),

  // ── The activity read (Subtask 11.7.7 — MOTIR-2241) ─────────────────────
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/activity',
    operationId: 'getWorkItemActivity',
    summary: 'Read a work item’s activity — changes, comments, or both',
    description:
      'Read a work item’s activity in one of three views: `all` (default — comments and the ' +
      'change trail interleaved in timestamp order), `comments` (the discussion), or ' +
      '`history` (the change trail only). Every entry carries a `type` so one renderer serves ' +
      'all three. ' +
      'The `cursor` is OPAQUE and SCOPED TO ITS VIEW: echo it back verbatim, never construct ' +
      'or parse one, and never hand a cursor from one view to another — that is a 422, not a ' +
      'silent restart. A page may be SHORTER than you expect while more remains (the change ' +
      'scan is noise-filtered and a comment page drags whole reply threads along), so walk ' +
      'until `nextCursor` is `null`, never until a page looks short. ' +
      '`GET /api/v1/work-items/{key}/comments` still exists and is unchanged — this view is ' +
      'the same data through the same read, offered so one code path can walk all three.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item’s `MOTIR-<n>` key (case-insensitive).',
        schema: z.string(),
      },
      {
        name: 'view',
        in: 'query',
        required: false,
        description: 'Which stream to read. Defaults to `all`.',
        schema: z.enum(ACTIVITY_VIEWS),
      },
      {
        name: 'order',
        in: 'query',
        required: false,
        description:
          'Page-walk direction. Omit for each view’s shipped default — `desc` (newest first) ' +
          'for `all` and `history`, `asc` for `comments`.',
        schema: z.enum(['asc', 'desc']),
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description:
          'An opaque page cursor from a previous response’s `nextCursor`. Omit for the first ' +
          'page. Scoped to its own VIEW — one issued elsewhere is a 422, never a silent reset.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'rankedPage', item: activityEntrySchema, extend: activityTotalsSchema },
      description:
        'One page of activity entries. `totalCount` is the number of entries in this view; ' +
        '`totalComments` / `totalChanges` break that down for the merged `all` view, and each ' +
        'is null on a view that did not count that source.',
    },
    errorStatuses: [404, 422],
  }),
  // ── The DISPATCH RUN ingest (Story MOTIR-1789 · MOTIR-1792) ─────────────
  //
  // Three operations, PAT-authenticated like every other work-loop endpoint,
  // because the reporter is a headless process on the operator's own machine.
  // Shaped for a TRANSPORT rather than for the CLI: 9.1.7's hosted orchestrator
  // becomes a second caller with `origin: "hosted"` and nothing else changes.
  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs',
    operationId: 'openDispatchRun',
    summary: 'Open a dispatch run, with the SET of cards it owns',
    description:
      'OPEN one run of a Motir CLI command and record THE SET it owns: every card, in the ' +
      'run’s own order, including the ones it has already decided to SKIP, each with its ' +
      'reason. ' +
      '⚠️ THE SET IS SETTLED HERE BECAUSE THIS IS THE ONE MOMENT IT EXISTS — a scope claim ' +
      'has just returned its members, or a batch snapshot has just been frozen. Rebuilt ' +
      'afterwards from per-card events it becomes a list of what the run got round to, and ' +
      'the skipped cards vanish entirely. A single-card `motir next` is the degenerate case: ' +
      'one card in the set. ' +
      'IDEMPOTENT on `idempotencyKey`: a repeat returns the EXISTING run with ' +
      '`created: false` rather than forking history, so a retry after a timeout is safe. ' +
      'It records the run and NOTHING ELSE: it moves no work-item status, writes no pull ' +
      'request and holds no cost.',
    permission: 'work_item:edit',
    parameters: [],
    requestBody: {
      schema: dispatchRunOpenBodySchema,
      description:
        'The command, its origin, the agent and model, an optional scope, an optional ' +
        'idempotency key, and the ordered SET of cards.',
    },
    response: {
      status: 201,
      body: { kind: 'object', schema: dispatchRunOpenedSchema },
      description: 'The run with its set and its resume cursor, and whether this call created it.',
    },
    // 404 for an unknown or cross-workspace project (no existence leak); 409 when
    // two opens raced on one idempotency key; 422 for a malformed body or a card
    // key this project does not have.
    errorStatuses: [404, 409, 422],
  }),

  defineOperation({
    method: 'GET',
    path: '/api/v1/dispatch-runs/{id}',
    operationId: 'getDispatchRun',
    summary: 'Get a dispatch run, with the SET of cards it owns',
    description:
      'READ one run and its set: every card in the run’s own order with its current ' +
      'disposition, and the stream’s cursor. ' +
      'It is how a CLI that did not open a run — a hosted run the SERVER opened, which the ' +
      '`motir` CLI in its container then adopts (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md` ' +
      '§3) — learns the cards it owns and their order, instead of claiming a second set. ' +
      'A hosted run’s own credential may read its own run and no other. ' +
      'A read: it writes nothing and moves no status.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run’s id.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchRunSchema },
      description: 'The run with its set and its resume cursor.',
    },
    // 403 for a run credential naming another run; 404 for an unknown or
    // cross-workspace run (no existence leak).
    errorStatuses: [403, 404],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/events',
    operationId: 'appendDispatchRunEvents',
    summary: 'Append a batch of events to a dispatch run',
    description:
      'APPEND events to a run’s ordered stream. Each is RUN-scoped, or CARD-scoped by naming a ' +
      '`workItemKey` the run already owns — an event never ADDS a card to a run’s set, because ' +
      'the set is the plan the run published. ' +
      'The server assigns each event its `seq` inside ONE transaction, so a batch’s order ' +
      'survives and the response’s `seq` is the cursor for the next append. Batch them: a ' +
      'chatty agent must not cost one request per line. ' +
      'An event may also carry the leg’s new `disposition` (plus `sessionBranch` / `exitCode`), ' +
      'applied to that card in the SAME transaction — so a viewer sees a card go `implemented` ' +
      'at the moment it happens rather than at close. ' +
      '`body` is the OPT-IN log payload: send it only when the operator asked for it. It is ' +
      'REFUSED above 16 KiB rather than truncated, and it is cleared 30 days after the event. ' +
      'Appending to a run that has already closed is a conflict, not a silent no-op.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run’s id, as `openDispatchRun` returned it.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: dispatchRunAppendBodySchema,
      description: 'Up to 200 events, in the order they happened.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchRunAppendedSchema },
      description: 'How many events were written, the new cursor, and every leg this batch moved.',
    },
    // 404 for an unknown or cross-workspace run; 409 when the run is already
    // closed; 413 for an over-sized log body; 422 for a malformed body, an
    // unknown card key, or a run at its event ceiling.
    errorStatuses: [404, 409, 413, 422],
  }),

  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/close',
    operationId: 'closeDispatchRun',
    summary: 'Close a dispatch run with its stop reason',
    description:
      'CLOSE the run: its terminal status, its `stopReason`, and every leg still unsettled — a ' +
      '`queued` card becomes `not_reached` (the run never got to it) and a `running` one ' +
      'becomes `failed` (the run ended while an agent was on it and nothing reported an ' +
      'outcome). ' +
      'Omit `status` and it is DERIVED from the stop reason, which is the mapping every caller ' +
      'would otherwise re-implement differently: `halted` is the only failure, `interrupted` ' +
      'is `cancelled`, and `replanned` is a SUCCESS — an agent that refused a card and ' +
      'submitted a plan exited 0. ' +
      'Guarded by a row lock and a re-read, so a close racing the server’s own abandoned-run ' +
      'reap cannot overwrite an already-terminal answer; the loser is a conflict. ' +
      'It writes NO work-item status — the CLI owns every transition.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run’s id.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: dispatchRunCloseBodySchema,
      description: 'The stop reason, and optionally an explicit terminal status.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchRunSchema },
      description: 'The closed run with its settled set.',
    },
    // 404 for an unknown or cross-workspace run; 409 when it is already closed;
    // 422 for a malformed body.
    errorStatuses: [404, 409, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/git-credential',
    operationId: 'issueDispatchRunGitCredentials',
    summary: 'Get a running hosted run’s git credentials',
    description:
      'A running HOSTED run trades its own run credential for fresh git credentials: one entry ' +
      'per repository of the run, each an installation token of the Motir GitHub App that writes ' +
      'that repository, narrowed to the run’s repositories and to contents + pull-request ' +
      'write. Repositories in one installation share a token. Each lives one hour, so the run ' +
      'asks again whenever it needs one — this is also its FIRST git credential. Every token ' +
      'handed out is recorded against the run and revoked when the run ends. ' +
      'The author is the App’s bot, never a person; `dispatchedBy` names the dispatcher for ' +
      'pull-request bodies. ' +
      'Only the run’s own credential is answered — any other token, a person’s included, is ' +
      'refused before the run is read.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The hosted run’s id — the run its credential is bound to.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchRunGitCredentialsSchema },
      description: 'One credential per repository of the run, and who dispatched it.',
    },
    // 403 for any credential not bound to this run; 404 for a run outside the
    // caller's workspace; 409 when the run has ended or a repository can no
    // longer be written; 503 when GitHub or an App is unavailable.
    errorStatuses: [403, 404, 409, 503],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/heartbeat',
    operationId: 'heartbeatDispatchRun',
    summary: 'Report that a local dispatch run is still alive',
    description:
      'A LOCAL run says it is still working. The CLI sends one every 60 seconds while a run is ' +
      'open; a local run silent for 5 minutes is DEAD — its card shows the run died and ' +
      '`motir continue` may take the work over — and the server closes it `abandoned`. ' +
      'The server stamps the time itself; the request carries no body. ' +
      'Only the operator who opened the run may beat for it. A run that is already closed — ' +
      'usually by that lapse — is a conflict, and the answer is to stop beating, not to retry. ' +
      'It writes NO work-item status and no event.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run’s id, as `openDispatchRun` returned it.',
        schema: z.string(),
      },
    ],
    response: {
      status: 204,
      body: { kind: 'empty' },
      description: 'The heartbeat was recorded.',
    },
    // 404 for an unknown, cross-workspace or another operator's run; 409 when the
    // run is already closed.
    errorStatuses: [404, 409],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/unbuildable',
    operationId: 'reportDispatchRunUnbuildable',
    summary: 'Report that a run stopped on an unbuildable card',
    description:
      'The RUN reports that its agent stopped because `targetKey`, a card the run holds, ' +
      'cannot be built as written — the same report as the `report_unbuildable_target` MCP ' +
      'tool, sent by the CLI with the run\u2019s own credential after the agent exits, so it ' +
      'reaches the server whether or not the agent had a Motir MCP. The server records it on ' +
      'the card\u2019s leg of THIS run and, when the card is exactly what an approved plan ' +
      'shaped, files ONE planning bug into Motir\u2019s own planner-bug home — never into the ' +
      'caller\u2019s project. ONE report per leg: a retry answers the same acknowledgement and ' +
      'does nothing more. The answer says only whether the card had an open leg on the run; ' +
      'it never carries the verdict, the plan, the outcome or a bug key. ' +
      'Only the operator who opened the run may report for it.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run\u2019s id, as `openDispatchRun` returned it.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: unbuildableReportBodySchema,
      description: 'The stopped card\u2019s key and the agent\u2019s reason.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: unbuildableReportAcknowledgementSchema },
      description: 'The acknowledgement: whether the card had an open leg on this run.',
    },
    // 403 for a run token naming another run, or a caller who may not edit the card;
    // 404 for an unknown, cross-workspace or another operator's run, or an unknown card;
    // 409 when the run is already closed; 422 for a malformed body.
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/discrepancy',
    operationId: 'recordDispatchRunDiscrepancy',
    summary: 'Record that a run built through a card whose plan was wrong about the HOW',
    description:
      'The RUN records that its agent BUILT THROUGH `key`, a card the run holds, whose plan was ' +
      'wrong only about the route — the same record as the `record_run_discrepancy` MCP tool, ' +
      'sent by the CLI with the run\u2019s own credential after the agent exits, from the points ' +
      'the agent wrote into its self-report. It writes ONE comment on the card listing every ' +
      'point (what the plan asked · what was built · why) — and every DECISION the agent made ' +
      'where the plan was silent (what it said · what was chosen · why), in their own section ' +
      '(MOTIR-10000) — and ONE finding on the card\u2019s leg of THIS run. At least one point or ' +
      'one decision. ONE record per leg: a second is refused `DISCREPANCY_ALREADY_RECORDED` and ' +
      'writes nothing. A card that is not an open leg of the run is refused ' +
      '`UNKNOWN_DISPATCH_RUN_CARD`. Only the operator who opened the run may record for it.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run\u2019s id, as `openDispatchRun` returned it.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: runDiscrepancyBodySchema,
      description:
        'The card that was built through, every discrepancy in one list, and every decision in ' +
        'another.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: runDiscrepancyAcknowledgementSchema },
      description: 'The acknowledgement: the comment written, and whether the run recorded it.',
    },
    // 403 for a run token naming another run, or a caller who may not edit the card;
    // 404 for an unknown, cross-workspace or another operator's run, or an unknown card;
    // 409 when the run is closed or the leg already has a record; 422 for a malformed body
    // or a card that is not an open leg of the run.
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/stop',
    operationId: 'reportDispatchRunStop',
    summary: 'Record that a run stopped on a card',
    description:
      'The RUN records that its agent STOPPED on `key`, a card the run holds, because the card ' +
      'itself is wrong — sent by the CLI with the run\u2019s own credential after the agent exits, ' +
      'from what the agent wrote into its self-report. It writes ONE comment on the card with ' +
      'the agent\u2019s finding and, with `toPlanning`, moves the card to Planning in the same ' +
      'transaction and keeps the agent\u2019s re-plan brief (`requirement`) in that comment. It ' +
      'does NOT submit the re-plan: a run\u2019s credential holds no planning permission, and the ' +
      'comment says a person submits it. A refused move writes nothing. A card that is not an ' +
      'open leg of the run is refused `UNKNOWN_DISPATCH_RUN_CARD`. Only the operator who ' +
      'opened the run may report for it.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run\u2019s id, as `openDispatchRun` returned it.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: runStopReportBodySchema,
      description: 'The stopped card, the finding, whether to re-plan, and the brief.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: runStopReportAcknowledgementSchema },
      description: 'The acknowledgement: the comment written, and whether the card is at Planning.',
    },
    // 403 for a run token naming another run, or a caller who may not edit the card;
    // 404 for an unknown, cross-workspace or another operator's run, or an unknown card;
    // 409 when the run is closed; 422 for a malformed body, a card that is not an open leg
    // of the run, or a workflow with no move to Planning.
    errorStatuses: [403, 404, 409, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/dispatch-runs/{id}/close-out-prompt',
    operationId: 'getDispatchRunCloseOutPrompt',
    summary: 'Get the prompt that writes a run’s How to test onto its run target',
    description:
      'The CLOSE-OUT prompt for a run launched against a work item (a scoped run): the text ' +
      'a CLI hands ONE agent after the run’s last card lands and BEFORE it marks the run’s ' +
      'pull requests ready, so HOW TO TEST is written once onto the run target by an agent ' +
      'that sees every card the run landed. ' +
      'The target and the landed cards are read from the run’s own record — the caller names ' +
      'only the run. A run with no scope (an unscoped batch, whose every card was its own ' +
      'target) is refused with `NO_RUN_TARGET` rather than answered with a defaulted target. ' +
      'A read: it writes nothing and moves no status.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'The dispatch run’s id, as `openDispatchRun` returned it.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: dispatchRunCloseOutPromptSchema },
      description: 'The run target, the landed cards, and the prompt text.',
    },
    // 404 for an unknown or cross-workspace run; 422 for a run with no run target.
    errorStatuses: [404, 422],
  }),
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/how-to-test',
    operationId: 'getWorkItemHowToTest',
    summary: 'Get a run target’s current How to test',
    description:
      'The CURRENT How-to-test record on a work item — the one the newest run published onto ' +
      'its run target: its rich-text Markdown body (sections, commands in fenced code blocks), ' +
      'the preview path, and a section per repository with its commit. `repos` may be EMPTY: ' +
      'a person writing from the item page names no repository, because Motir derives them from ' +
      'the linked pull requests. `record` is ' +
      '`null` when no run has written one. A CLI renders it into the `## How to test` section ' +
      'of each session pull request body, so the body and the item page show one record. ' +
      'A read.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item key, e.g. `ACME-7`.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: currentTestInstructionsSchema },
      description: 'The current record, or `record: null`.',
    },
    // 404 for an unknown or unreachable item; 422 for a malformed key.
    errorStatuses: [404, 422],
  }),

  // ── The REVIEW RUN (Story MOTIR-1626 · MOTIR-6821; `hosted-agent-run.md` §8) ──────────
  defineOperation({
    method: 'GET',
    path: '/api/v1/work-items/{key}/review-prompt',
    operationId: 'getWorkItemReviewPrompt',
    summary: 'Get the review prompt a hosted review run is handed',
    description:
      'The server-assembled REVIEW prompt for a work item whose delivered code a hosted ' +
      'review run is judging: the card’s description and explanation, its acceptance ' +
      'criteria, its published How to test, and every pull request of its delivery set at ' +
      'the REVIEWED head — the version its `agent_review` gate names, never a later commit — ' +
      'with the instruction to push nothing, post nothing to GitHub, and submit ONE verdict. ' +
      'Answers ONLY the credential of a `review` dispatch run, for that run’s own card ' +
      '(`REVIEW_RUN_TOKEN_REQUIRED` / `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403). A read.',
    permission: 'project:browse',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item key, e.g. `ACME-7`.',
        schema: z.string(),
      },
    ],
    response: {
      status: 200,
      body: { kind: 'object', schema: reviewPromptSchema },
      description: 'The gate, the version under review, its pull requests and the prompt.',
    },
    // 403 for a caller that is not this card's review run; 404 for an unknown item or a
    // card with no review; 422 for a malformed key.
    errorStatuses: [403, 404, 422],
  }),
  defineOperation({
    method: 'POST',
    path: '/api/v1/work-items/{key}/agent-review',
    operationId: 'submitWorkItemAgentReview',
    summary: 'Submit a hosted review run’s ONE verdict',
    description:
      'Decide a work item’s `agent_review` gate as the REVIEW AGENT: `pass` approves it, ' +
      'which raises the approve-and-merge gate for the same version; `changes_requested` ' +
      'records `findingsMd` (required, non-empty) as the gate’s note and moves nothing — the ' +
      'card is To fix. `subjectVersion` must be the version the review prompt named. ONE ' +
      'verdict per run (`REVIEW_VERDICT_ALREADY_SUBMITTED`, 409). A verdict for a version ' +
      'the gate no longer asks about, or a gate already superseded or decided, is RECORDED ' +
      'on the run and decides nothing (`REVIEW_STALE`, 409). Accepts ONLY the credential of ' +
      'a `review` dispatch run, for that run’s own card.',
    permission: 'work_item:edit',
    parameters: [
      {
        name: 'key',
        in: 'path',
        required: true,
        description: 'The work item key, e.g. `ACME-7`.',
        schema: z.string(),
      },
    ],
    requestBody: {
      schema: agentReviewBodySchema,
      description: 'The reviewed version, the verdict, a short summary and the findings.',
    },
    response: {
      status: 200,
      body: { kind: 'object', schema: agentReviewResultSchema },
      description: 'The gate the verdict decided and its new state.',
    },
    // 403 for a caller that is not this card's review run; 404 for an unknown item or a
    // card with no review; 409 for a second or late verdict; 422 for a malformed body.
    errorStatuses: [403, 404, 409, 422],
  }),
];

/** The named component schemas this resource contributes to the document. */
export const WORK_LOOP_COMPONENTS: Readonly<Record<string, ZodType>> = {
  DispatchPrompt: dispatchPromptSchema,
  WorkItemClaim: workItemClaimSchema,
  WorkItemRepairClaim: workItemRepairClaimSchema,
  WorkItemContinueClaim: workItemContinueClaimSchema,
  ScopeClaim: scopeClaimSchema,
  IntegrationResult: integrationResultSchema,
  SessionCloseOut: sessionCloseOutSchema,
  PlanJobHandle: planJobHandleSchema,
  PlanOutcome: planOutcomeSchema,
  Plan: planSchema,
  PlanSession: planSessionSchema,
  UnbuildableReportAcknowledgement: unbuildableReportAcknowledgementSchema,
  RunDiscrepancyAcknowledgement: runDiscrepancyAcknowledgementSchema,
  RunStopReportAcknowledgement: runStopReportAcknowledgementSchema,
  ActivityEntry: activityEntrySchema,
  DispatchRun: dispatchRunSchema,
  DispatchRunCard: dispatchRunCardSchema,
  DispatchRunOpened: dispatchRunOpenedSchema,
  DispatchRunAppended: dispatchRunAppendedSchema,
  DispatchRunCloseOutPrompt: dispatchRunCloseOutPromptSchema,
  CurrentTestInstructions: currentTestInstructionsSchema,
  ReviewPrompt: reviewPromptSchema,
  AgentReviewResult: agentReviewResultSchema,
};
