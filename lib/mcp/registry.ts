import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContextResolver, McpGrantResolver } from './context';
import { permissionGatedServer } from './permissionGate';
import { rateLimitedServer } from './rateLimitGate';
import { strictInputServer } from './strictInput';
import { annotatedServer } from './toolAnnotations';
import { referencedServer } from './toolReference';
import { GET_WORK_ITEM_TOOL_NAME, registerGetWorkItem } from './tools/getWorkItem';
import { GET_DESIGN_TOOL_NAME, registerGetDesign } from './tools/getDesign';
import { LIST_DESIGNS_TOOL_NAME, registerListDesigns } from './tools/listDesigns';
import { GET_APPROVAL_GATE_TOOL_NAME, registerGetApprovalGate } from './tools/getApprovalGate';
import {
  GET_WORK_ITEM_ACTIVITY_TOOL_NAME,
  registerGetWorkItemActivity,
} from './tools/getWorkItemActivity';
import { LIST_READY_TOOL_NAME, registerListReady } from './tools/listReady';
import { NEXT_READY_TOOL_NAME, registerNextReady } from './tools/nextReady';
import { CLAIM_NEXT_READY_TOOL_NAME, registerClaimNextReady } from './tools/claimNextReady';
import { CLAIM_WORK_ITEM_TOOL_NAME, registerClaimWorkItem } from './tools/claimWorkItem';
import { DISPATCH_PROMPT_TOOL_NAME, registerDispatchPrompt } from './tools/dispatchPrompt';
import {
  EXPAND_ITEM_TOOL_NAME,
  GET_PLAN_STATUS_TOOL_NAME,
  registerExpandItem,
} from './tools/expandItem';
import { GET_PLAN_TOOL_NAME, registerGetPlan } from './tools/getPlan';
import {
  GET_APPROVED_SHAPE_VERDICT_TOOL_NAME,
  registerGetApprovedShapeVerdict,
} from './tools/getApprovedShapeVerdict';
import {
  REPORT_UNBUILDABLE_TARGET_TOOL_NAME,
  registerReportUnbuildableTarget,
} from './tools/reportUnbuildableTarget';
import {
  RECORD_RUN_DISCREPANCY_TOOL_NAME,
  registerRecordRunDiscrepancy,
} from './tools/recordRunDiscrepancy';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME,
  RECORD_PLAN_REVISION_REASON_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
  HOLD_PLAN_REVISION_TOOL_NAME,
  registerAuthorPlan,
} from './tools/authorPlan';
import {
  APPEND_PLAN_TURN_TOOL_NAME,
  OPEN_PLAN_SESSION_TOOL_NAME,
  SUBMIT_PLAN_SESSION_TOOL_NAME,
  registerPlanSession,
} from './tools/planSession';
import { CREATE_WORK_ITEM_TOOL_NAME, registerCreateWorkItem } from './tools/createWorkItem';
import { TRANSITION_STATUS_TOOL_NAME, registerTransitionStatus } from './tools/transitionStatus';
import { ADD_COMMENT_TOOL_NAME, registerAddComment } from './tools/addComment';
import { EDIT_COMMENT_TOOL_NAME, registerEditComment } from './tools/editComment';
import { DELETE_COMMENT_TOOL_NAME, registerDeleteComment } from './tools/deleteComment';
import {
  ADD_WORK_ITEM_TODO_TOOL_NAME,
  LIST_WORK_ITEM_TODOS_TOOL_NAME,
  SET_WORK_ITEM_TODO_DONE_TOOL_NAME,
  UPDATE_WORK_ITEM_TODO_TOOL_NAME,
  DELETE_WORK_ITEM_TODO_TOOL_NAME,
  MOVE_WORK_ITEM_TODO_TOOL_NAME,
  registerWorkItemTodos,
} from './tools/workItemTodos';
import {
  CLAIM_WORK_ITEM_REPAIR_TOOL_NAME,
  CLOSE_WORK_ITEM_REPAIR_TOOL_NAME,
  TOUCH_WORK_ITEM_REPAIR_TOOL_NAME,
  registerWorkItemRepair,
} from './tools/workItemRepair';
import {
  CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME,
  CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME,
  TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME,
  registerWorkItemContinue,
} from './tools/workItemContinue';
import { ADD_LESSON_TOOL_NAME, registerAddLesson } from './tools/addLesson';
import { SEARCH_LESSONS_TOOL_NAME, registerSearchLessons } from './tools/searchLessons';
import { REINFORCE_LESSON_TOOL_NAME, registerReinforceLesson } from './tools/reinforceLesson';
import { ATTACH_FILE_TOOL_NAME, registerAttachFile } from './tools/attachFile';
import { LINK_PULL_REQUEST_TOOL_NAME, registerLinkPullRequest } from './tools/linkPullRequest';
import {
  UNLINK_PULL_REQUEST_TOOL_NAME,
  registerUnlinkPullRequest,
} from './tools/unlinkPullRequest';
import {
  PUBLISH_DESIGN_RESULT_TOOL_NAME,
  CREATE_DESIGN_UPLOAD_TOOL_NAME,
  registerPublishDesignResult,
} from './tools/publishDesignResult';
import {
  CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME,
  PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME,
  registerPublishAcceptanceResult,
} from './tools/publishAcceptanceResult';
import {
  PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME,
  registerPublishTestInstructions,
} from './tools/publishTestInstructions';
import { SEARCH_WORK_ITEMS_TOOL_NAME, registerSearchWorkItems } from './tools/searchWorkItems';
import { WHOAMI_TOOL_NAME, registerWhoami } from './tools/whoami';
import { LIST_PROJECTS_TOOL_NAME, registerListProjects } from './tools/listProjects';
import { GET_PROJECT_STATE_TOOL_NAME, registerGetProjectState } from './tools/getProjectState';
import { GET_CODE_HEALTH_TOOL_NAME, registerGetCodeHealth } from './tools/getCodeHealth';
import {
  GET_CODING_CONVENTION_TOOL_NAME,
  registerGetCodingConvention,
} from './tools/getCodingConvention';
import { READ_FILE_TOOL_NAME, registerReadFile } from './tools/readFile';
import {
  CODE_EXPLORE_TOOL_NAME,
  CODE_SEARCH_TOOL_NAME,
  registerCodeGraphRead,
} from './tools/codeGraphRead';
import { SKELETON_TOOL_NAME, registerSkeleton } from './tools/skeleton';
import { LIST_FOLDERS_TOOL_NAME, registerListFolders } from './tools/listFolders';
import { GET_SECTION_SETS_TOOL_NAME, registerGetSectionSets } from './tools/getSectionSets';
import { CREATE_FOLDER_TOOL_NAME, registerCreateFolder } from './tools/createFolder';
import { UPDATE_FOLDER_TOOL_NAME, registerUpdateFolder } from './tools/updateFolder';
import { DELETE_FOLDER_TOOL_NAME, registerDeleteFolder } from './tools/deleteFolder';
import { GET_PAGE_TOOL_NAME, registerGetPage } from './tools/getPage';
import { CREATE_PAGE_TOOL_NAME, registerCreatePage } from './tools/createPage';
import { UPDATE_PAGE_TOOL_NAME, registerUpdatePage } from './tools/updatePage';
import { RENAME_PAGE_TOOL_NAME, registerRenamePage } from './tools/renamePage';
import { SEARCH_PAGES_TOOL_NAME, registerSearchPages } from './tools/searchPages';
import { MOVE_PAGE_TOOL_NAME, registerMovePage } from './tools/movePage';
import { ARCHIVE_PAGE_TOOL_NAME, registerArchivePage } from './tools/archivePage';
import { LINK_PAGE_TOOL_NAME, registerLinkPage } from './tools/linkPage';
import {
  PUBLISH_DECISION_PAGE_TOOL_NAME,
  registerPublishDecisionPage,
} from './tools/publishDecisionPage';
import {
  SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME,
  registerSearchWorkItemsSemantic,
} from './tools/searchWorkItemsSemantic';
import { LIST_SPRINTS_TOOL_NAME, registerListSprints } from './tools/listSprints';
import { VALIDATE_SPRINT_TOOL_NAME, registerValidateSprint } from './tools/validateSprint';
import { VALIDATE_WORK_ITEM_TOOL_NAME, registerValidateWorkItem } from './tools/validateWorkItem';
import { VALIDATE_PLAN_TOOL_NAME, registerValidatePlan } from './tools/validatePlan';
import {
  GET_PLAN_AUTHORING_STATE_TOOL_NAME,
  registerGetPlanAuthoringState,
} from './tools/getPlanAuthoringState';
import { CREATE_SPRINT_TOOL_NAME, registerCreateSprint } from './tools/createSprint';
import { UPDATE_SPRINT_TOOL_NAME, registerUpdateSprint } from './tools/updateSprint';
import { DELETE_SPRINT_TOOL_NAME, registerDeleteSprint } from './tools/deleteSprint';
import { MOVE_TO_SPRINT_TOOL_NAME, registerMoveToSprint } from './tools/moveToSprint';
import { MOVE_TO_BACKLOG_TOOL_NAME, registerMoveToBacklog } from './tools/moveToBacklog';
import { MOVE_TO_PARENT_TOOL_NAME, registerMoveToParent } from './tools/moveToParent';
import { START_SPRINT_TOOL_NAME, registerStartSprint } from './tools/startSprint';
import { COMPLETE_SPRINT_TOOL_NAME, registerCompleteSprint } from './tools/completeSprint';
import { MARK_INTEGRATED_TOOL_NAME, registerMarkIntegrated } from './tools/markIntegrated';
import { COMPLETE_SESSION_TOOL_NAME, registerCompleteSession } from './tools/completeSession';
import {
  LINK_WORK_ITEMS_TOOL_NAME,
  UNLINK_WORK_ITEMS_TOOL_NAME,
  registerLinkWorkItems,
} from './tools/linkWorkItems';
import { UPDATE_WORK_ITEM_TOOL_NAME, registerUpdateWorkItem } from './tools/updateWorkItem';
import {
  ARCHIVE_WORK_ITEM_TOOL_NAME,
  UNARCHIVE_WORK_ITEM_TOOL_NAME,
  registerArchiveWorkItem,
} from './tools/archiveWorkItem';
import { DELETE_WORK_ITEM_TOOL_NAME, registerDeleteWorkItem } from './tools/deleteWorkItem';
import { CHANGE_KIND_TOOL_NAME, registerChangeKind } from './tools/changeKind';
import {
  CLOSE_WORK_ITEM_RUN_TOOL_NAME,
  REPORT_ACTION_TOOL_NAME,
  START_WORK_ITEM_RUN_TOOL_NAME,
  registerWorkItemRun,
} from './tools/workItemRun';
import { heartbeatingServer } from './runHeartbeat';
import { tracedServer } from './toolTracing';

// The MCP tool registry (Story 7.8 · Subtask 7.8.4, extended by 7.8.5 / 7.8.6 /
// 7.8.10 / 7.8.11 / 7.8.13 / 7.8.14 / 2.8.5) — the single place that assembles
// the server's tool surface.
// This is the SEAM each later subtask extends: add the tool module under
// `tools/`, import its `register*`, and add one line to `registerMcpTools` —
// without touching the transport (`app/api/mcp/route.ts`) or the auth gate
// (`lib/mcp/auth.ts`). Every tool resolves its acting `ServiceContext` through
// the injected `resolveContext`, so auth lives in exactly one place and the
// tools stay testable with a fixed-context resolver.
//
// What every registered tool is guaranteed, whatever wrappers a caller opts
// into: its input schema is STRICT (`strictInput.ts`, MOTIR-3342), and it
// carries a title and the `annotations` row `TOOL_ANNOTATIONS` declares for it
// (`toolAnnotations.ts`, MOTIR-6974) — a tool with neither cannot register —
// and its description ends with a link to its own entry in the published tool
// reference (`toolReference.ts`, MOTIR-7391).

/** Identifying info the MCP `initialize` handshake reports to clients. */
export const MCP_SERVER_INFO = { name: 'motir', version: '0.1.0' } as const;

/** Stable tool names — exported so consumers/tests reference them by constant. */
export const MCP_TOOL_NAMES = [
  GET_WORK_ITEM_TOOL_NAME,
  GET_DESIGN_TOOL_NAME,
  LIST_DESIGNS_TOOL_NAME,
  GET_APPROVAL_GATE_TOOL_NAME,
  GET_WORK_ITEM_ACTIVITY_TOOL_NAME,
  LIST_READY_TOOL_NAME,
  NEXT_READY_TOOL_NAME,
  CLAIM_NEXT_READY_TOOL_NAME,
  CLAIM_WORK_ITEM_TOOL_NAME,
  CLAIM_WORK_ITEM_REPAIR_TOOL_NAME,
  TOUCH_WORK_ITEM_REPAIR_TOOL_NAME,
  CLOSE_WORK_ITEM_REPAIR_TOOL_NAME,
  CLAIM_WORK_ITEM_CONTINUE_TOOL_NAME,
  TOUCH_WORK_ITEM_CONTINUE_TOOL_NAME,
  CLOSE_WORK_ITEM_CONTINUE_TOOL_NAME,
  START_WORK_ITEM_RUN_TOOL_NAME,
  REPORT_ACTION_TOOL_NAME,
  CLOSE_WORK_ITEM_RUN_TOOL_NAME,
  DISPATCH_PROMPT_TOOL_NAME,
  EXPAND_ITEM_TOOL_NAME,
  GET_PLAN_STATUS_TOOL_NAME,
  GET_PLAN_TOOL_NAME,
  GET_APPROVED_SHAPE_VERDICT_TOOL_NAME,
  REPORT_UNBUILDABLE_TARGET_TOOL_NAME,
  RECORD_RUN_DISCREPANCY_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  ADD_PLAN_ITEMS_TOOL_NAME,
  UPDATE_PLAN_ITEM_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME,
  RECORD_PLAN_REVISION_REASON_TOOL_NAME,
  REPORT_PLAN_STEP_TOOL_NAME,
  HOLD_PLAN_REVISION_TOOL_NAME,
  OPEN_PLAN_SESSION_TOOL_NAME,
  APPEND_PLAN_TURN_TOOL_NAME,
  SUBMIT_PLAN_SESSION_TOOL_NAME,
  CREATE_WORK_ITEM_TOOL_NAME,
  TRANSITION_STATUS_TOOL_NAME,
  ADD_COMMENT_TOOL_NAME,
  EDIT_COMMENT_TOOL_NAME,
  DELETE_COMMENT_TOOL_NAME,
  LIST_WORK_ITEM_TODOS_TOOL_NAME,
  ADD_WORK_ITEM_TODO_TOOL_NAME,
  SET_WORK_ITEM_TODO_DONE_TOOL_NAME,
  UPDATE_WORK_ITEM_TODO_TOOL_NAME,
  DELETE_WORK_ITEM_TODO_TOOL_NAME,
  MOVE_WORK_ITEM_TODO_TOOL_NAME,
  ADD_LESSON_TOOL_NAME,
  SEARCH_LESSONS_TOOL_NAME,
  REINFORCE_LESSON_TOOL_NAME,
  ATTACH_FILE_TOOL_NAME,
  PUBLISH_DESIGN_RESULT_TOOL_NAME,
  CREATE_DESIGN_UPLOAD_TOOL_NAME,
  CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME,
  PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME,
  PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME,
  LINK_PULL_REQUEST_TOOL_NAME,
  UNLINK_PULL_REQUEST_TOOL_NAME,
  SEARCH_WORK_ITEMS_TOOL_NAME,
  SEARCH_WORK_ITEMS_SEMANTIC_TOOL_NAME,
  WHOAMI_TOOL_NAME,
  LIST_PROJECTS_TOOL_NAME,
  GET_PROJECT_STATE_TOOL_NAME,
  GET_CODE_HEALTH_TOOL_NAME,
  GET_CODING_CONVENTION_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  CODE_EXPLORE_TOOL_NAME,
  CODE_SEARCH_TOOL_NAME,
  SKELETON_TOOL_NAME,
  LIST_FOLDERS_TOOL_NAME,
  GET_SECTION_SETS_TOOL_NAME,
  CREATE_FOLDER_TOOL_NAME,
  UPDATE_FOLDER_TOOL_NAME,
  DELETE_FOLDER_TOOL_NAME,
  GET_PAGE_TOOL_NAME,
  CREATE_PAGE_TOOL_NAME,
  UPDATE_PAGE_TOOL_NAME,
  RENAME_PAGE_TOOL_NAME,
  SEARCH_PAGES_TOOL_NAME,
  MOVE_PAGE_TOOL_NAME,
  ARCHIVE_PAGE_TOOL_NAME,
  LINK_PAGE_TOOL_NAME,
  PUBLISH_DECISION_PAGE_TOOL_NAME,
  LIST_SPRINTS_TOOL_NAME,
  VALIDATE_SPRINT_TOOL_NAME,
  VALIDATE_WORK_ITEM_TOOL_NAME,
  VALIDATE_PLAN_TOOL_NAME,
  GET_PLAN_AUTHORING_STATE_TOOL_NAME,
  CREATE_SPRINT_TOOL_NAME,
  UPDATE_SPRINT_TOOL_NAME,
  DELETE_SPRINT_TOOL_NAME,
  MOVE_TO_SPRINT_TOOL_NAME,
  MOVE_TO_BACKLOG_TOOL_NAME,
  MOVE_TO_PARENT_TOOL_NAME,
  START_SPRINT_TOOL_NAME,
  COMPLETE_SPRINT_TOOL_NAME,
  MARK_INTEGRATED_TOOL_NAME,
  COMPLETE_SESSION_TOOL_NAME,
  LINK_WORK_ITEMS_TOOL_NAME,
  UNLINK_WORK_ITEMS_TOOL_NAME,
  UPDATE_WORK_ITEM_TOOL_NAME,
  CHANGE_KIND_TOOL_NAME,
  ARCHIVE_WORK_ITEM_TOOL_NAME,
  UNARCHIVE_WORK_ITEM_TOOL_NAME,
  DELETE_WORK_ITEM_TOOL_NAME,
] as const;

/** One of the server's stable tool names — the union over {@link MCP_TOOL_NAMES}.
 * The token-scope map (`lib/mcp/scopes.ts`) is keyed by this, so the map stays
 * total over the registry by construction (a tool added without a scope is a
 * compile error). */
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Register every MCP tool, wiring each to `resolveContext`.
 *
 * When `resolveGrant` is supplied (production passes `grantFromExtra`), the
 * server is wrapped in the per-token SCOPE GATE (Subtask 7.7.17): every tool
 * call is rejected with a typed scope-denied error unless the token's granted
 * scopes include the tool's scope — an ADDITIONAL gate in front of the
 * unchanged 6.4 role checks. Omitting it (the tool round-trip tests) applies no
 * scope narrowing, preserving the pre-7.7.17 behaviour.
 *
 * When `meterBillableTools` is set (production, from `app/api/mcp/route.ts`),
 * the job-SUBMITTING tools additionally spend the `ai:generate` budget before
 * they run (MOTIR-2610 · `rateLimitGate.ts`). Off for the in-process tool tests,
 * which have no request — and no rate-limit store — behind them.
 *
 * ⚠️ ORDER: the rate-limit wrapper goes OUTSIDE the scope gate, which makes its
 * check run SECOND at dispatch. Each wrapper registers the callback the next one
 * wraps, so the outermost wrapper's check ends up innermost — and what we want
 * is scope-denied FIRST, so a token that may not call `expand_item` cannot drain
 * its owner's generation budget by calling it anyway.
 */
export function registerMcpTools(
  server: McpServer,
  resolveContext: McpContextResolver,
  resolveGrant?: McpGrantResolver,
  meterBillableTools = false,
): void {
  // The UNKNOWN-ARGUMENT gate (bug MOTIR-3342) — unconditional, and INNERMOST
  // so it is the last thing between a tool's declared shape and the SDK. It
  // touches the schema, not the callback, so it composes with the two policy
  // wrappers below without ordering against them. It is not optional the way
  // they are: a tool that publishes `additionalProperties: false` and then
  // silently strips is wrong on every deployment, tests included.
  //
  // The HINT seam (Story MOTIR-6974) sits beside it, innermost for the same
  // reason: it rewrites the config (`annotations` from `TOOL_ANNOTATIONS`), not
  // the callback. It refuses, at registration, a tool with no row, no title or a
  // title over 64 characters, and a tool that declares its own `annotations` —
  // so every tool `tools/list` serves carries a title and an explicit
  // read-only / destructive / idempotent / open-world verdict.
  //
  // The REFERENCE seam (MOTIR-7391) is a third config rewrite beside them: it
  // ends every tool's description with a link to that tool's entry in the
  // published reference (`toolReference.ts`).
  const strict = strictInputServer(annotatedServer(referencedServer(server)));
  // The RUN HEARTBEAT (MOTIR-7451) wraps every callback the gates let through, so
  // each handled call refreshes the caller's open agent-reported runs AFTER it
  // answers — and never fails it (`runHeartbeat.ts`).
  //
  // The TOOL TRACE (MOTIR-8551) goes between them: every call runs inside a span
  // named `tools/call <tool>` and the request's root is renamed for the tool. It
  // is the INNERMOST callback wrapper, which makes it the OUTERMOST at call time
  // (each wrapper registers the callback the next one wraps, so the one nearest
  // the real server runs first) — the span therefore covers the scope gate, the
  // rate-limit gate, the tool body and the run heartbeat, whose `SELECT` shows
  // as the call's last transaction (`toolTracing.ts`).
  const traced = tracedServer(strict);
  const beating = heartbeatingServer(traced, resolveContext);
  // Two wrappers, and the ORDER is the policy: the permission gate runs first,
  // so a call the token was never granted is refused BEFORE it can consume any
  // of the request budget MOTIR-2610 added. Metering a refused call would let an
  // unauthorised caller exhaust the owner's allowance.
  const granted = resolveGrant ? permissionGatedServer(beating, resolveGrant) : beating;
  const target = meterBillableTools ? rateLimitedServer(granted, resolveContext) : granted;
  // Read + dispatch tools (7.8.4).
  registerGetWorkItem(target, resolveContext);
  registerGetDesign(target, resolveContext);
  registerListDesigns(target, resolveContext);
  // The GATE read (Bug MOTIR-6191) — the decision a person made on one approval
  // gate, including the note they wrote when they sent the work back. Every other
  // door onto that note is session-authed, so the agent that raised the question
  // could not read its answer. It DECIDES nothing: there is no such tool, on
  // purpose (`approval-gates.md` §1).
  registerGetApprovalGate(target, resolveContext);
  // The DISCUSSION read (MOTIR-1999) — a card's comments + change trail, the
  // read half `add_comment` never had. Deliberately NOT folded into
  // get_work_item: that aggregate is one round-trip and must stay one, so the
  // paged stream is its own call.
  registerGetWorkItemActivity(target, resolveContext);
  registerListReady(target, resolveContext);
  registerNextReady(target, resolveContext);
  // Atomic, race-safe dispatch claim (MOTIR-1330) — the write-side counterpart
  // of next_ready: lock + flip to in_progress so concurrent claims never collide.
  registerClaimNextReady(target, resolveContext);
  // The KEYED claim (MOTIR-2961) — the same lock for the caller that was HANDED
  // a card rather than asking for the next one. A SECOND CALLER of
  // `workItemsService.claimWorkItem`, whose primary surface is the v1 route the
  // CLI speaks; never a second implementation.
  registerClaimWorkItem(target, resolveContext);
  // The canonical dispatch PROMPT (MOTIR-1802) — the server-generated agent
  // instruction the CLI prints verbatim, so no client assembles its own grammar.
  registerDispatchPrompt(target, resolveContext);
  // AI plan EXPANSION + its outcome read (MOTIR-1825) — the async planning
  // trigger an unattended CLI run needs, and the come-back-later status read
  // that replaces the browser's job stream. Both honour the Plan approval gate:
  // an expansion proposes, it never writes the tree.
  registerExpandItem(target, resolveContext);
  // The plan CONTENT read (MOTIR-1837) — the items behind get_plan_status's
  // count, so a headless client can SHOW what a planning pass proposed instead
  // of sending its user to a browser to look. Same proposal gate: it reads
  // proposals, it does not create work items.
  registerGetPlan(target, resolveContext);
  // The APPROVED-SHAPE verdict (MOTIR-6227) — the runbook's door: is this card
  // still what the last approved plan approved? A pure read over the card's plan
  // history; it files nothing, and what to do with the verdict is the caller's.
  registerGetApprovedShapeVerdict(target, resolveContext);
  // The RUN-FOUND REPORT (MOTIR-6286) — the dispatched runner's one call when it
  // stops on a card it cannot build. The server decides everything (the verdict,
  // the approving plan's author, whether a planning bug is filed) and answers an
  // acknowledgement only; `docs/decisions/run-found-trigger-dispatched-path.md`.
  registerReportUnbuildableTarget(target, resolveContext);
  // The RUN DISCREPANCY record (MOTIR-8657) — the runner's one call after it builds a card
  // through a plan that was wrong only about the HOW. A comment on the card and, on an open
  // leg, a server-written finding on the run; decision page MOTIR-8654.
  registerRecordRunDiscrepancy(target, resolveContext);
  // The plan AUTHORING door (MOTIR-2988) — `create_plan` + `add_plan_items`, so
  // an agent can PROPOSE a tree the user reviews instead of writing work items
  // straight into it. The third door beside `create_work_item` (writes now, no
  // review) and the plan-session tools (hand a PROMPT to motir-ai and let it do
  // the planning): here the agent says what the tree should be, and Motir
  // reviews it exactly like any other plan. Same proposal gate — nothing becomes
  // a work item until somebody approves it in Motir.
  registerAuthorPlan(target, resolveContext);
  // The plan-change CONVERSATION (MOTIR-1832) — open/resume a thread, append a
  // turn, submit the accumulated intent. The substrate `motir plan` talks
  // through, and the same thread the web app's planning rail shows: accumulation
  // and submission are separate acts, and a submit proposes rather than writes.
  registerPlanSession(target, resolveContext);
  // Write tools (7.8.5).
  registerCreateWorkItem(target, resolveContext);
  registerTransitionStatus(target, resolveContext);
  registerAddComment(target, resolveContext);
  // The author's correction doors for a comment (MOTIR-5295).
  registerEditComment(target, resolveContext);
  registerDeleteComment(target, resolveContext);
  // A committed card's TO-DO LIST (MOTIR-6725) — read it, append a step, tick
  // or untick one, over the shipped `workItemTodosService`. Edit, reorder and
  // delete stay the UI's: the guide that consumes these needs none of them.
  registerWorkItemTodos(target, resolveContext);
  // The REPAIR claim's door (MOTIR-6807) — claim a red card's repair, keep it
  // alive, close it with its outcome, over the shipped `workItemRepairService`
  // and dispatch-run heartbeat/close. The same lock `motir fix` takes over v1.
  registerWorkItemRepair(target, resolveContext);
  // The CONTINUE claim's door (MOTIR-7262) — take over a card whose run died, keep
  // it alive, close it with how it ended, over the shipped
  // `workItemContinueService` and dispatch-run heartbeat/close. The same lock
  // `motir continue` takes over v1.
  registerWorkItemContinue(target, resolveContext);
  // The RUN tools (MOTIR-7451) — any agent reports its own run of a card.
  registerWorkItemRun(target, resolveContext);
  registerAddLesson(target, resolveContext);
  registerSearchLessons(target, resolveContext);
  registerReinforceLesson(target, resolveContext);
  // The general attachment door (MOTIR-3058) — the agent-facing half of
  // MOTIR-3057's `/api/v1` route, over the same service path.
  registerAttachFile(target, resolveContext);
  registerPublishDesignResult(target, resolveContext);
  // The ACCEPTANCE publish door (bug MOTIR-4704) — the receipt half of the pair
  // whose design half is the line above. MOTIR-4096 retired the CI uploader on
  // the premise that the agent would publish over MCP, and this is the surface
  // that premise named; until it existed, three documents described a door that
  // was not here. TWO tools rather than one because a recording cannot travel as
  // a tool argument: mint a presigned PUT, upload the bytes straight to the
  // store, register the pathname.
  registerPublishAcceptanceResult(target, resolveContext);
  // HOW TO TEST, written by the agent onto the work item (MOTIR-5331).
  registerPublishTestInstructions(target, resolveContext);
  // The pull-request LINK door (Story MOTIR-3525 · MOTIR-3526) — an executing
  // agent declares which card its pull request delivers, at the one moment it
  // knows with certainty. The branch/title parse stays as the fallback for a
  // pull request opened outside a run.
  registerLinkPullRequest(target, resolveContext);
  // The pull-request UNLINK door (MOTIR-3756) — the correction the link tool has
  // never had. Registered beside it rather than folded into it because a delivery
  // is a ROW now: a re-link ADDS and the mistaken row stays, so removal is its own
  // operation and not a side effect of the fix.
  registerUnlinkPullRequest(target, resolveContext);
  // Query tool (7.8.6).
  registerSearchWorkItems(target, resolveContext);
  // The SEMANTIC query (MOTIR-3101) — a second tool BESIDE the substring search,
  // never over it. `search_work_items` is a `contains` predicate, so it cannot
  // see a card that says the same thing in different words; that is the failure
  // MOTIR-3079 recorded, and this is the read that answers the question the
  // substring match only appears to. Its shape is `plan-tree-embeddings.md`
  // Amendment 2's: text in, Motir embeds it, keys and scores out.
  registerSearchWorkItemsSemantic(target, resolveContext);
  // Identity (added by 7.9.1, consumed by the CLI's auth commands).
  registerWhoami(target, resolveContext);
  // Project enumeration (MOTIR-1879) — the token's reachable projects, so a
  // client can RESOLVE a project instead of demanding its key. whoami's
  // companion: whoami answers "who + which workspace", this answers "which
  // projects in it".
  registerListProjects(target, resolveContext);
  // Project CONFIGURATION (MOTIR-1968) — the planning preconditions a planning
  // agent must be able to VERIFY: established?, code connected + indexed?, the
  // project's repo set, where onboarding stopped. list_projects answers "which
  // projects"; this answers "what state is one in". Read-only by design.
  registerGetProjectState(target, resolveContext);
  // Project CODE HEALTH (MOTIR-7793) — each repository's index state, latest
  // audit summary and derived convention: what the hosted planner reads for
  // every session, for an agent planning over the MCP. Gated on `ai:plan`.
  registerGetCodeHealth(target, resolveContext);
  // MOTIR-9083 — ONE repository's coding convention in full, so a run prompt can
  // point the agent at the stored convention instead of a file in the checkout.
  // Gated on `ai:plan`; the repo resolves against the PROJECT's set.
  registerGetCodingConvention(target, resolveContext);
  // MOTIR-7861 — one file's TEXT from one of the project's repositories at a
  // ref: the read the hosted planner's `read_file` makes, for an agent planning
  // over the MCP. Gated on `ai:plan`; the repo resolves against the PROJECT's set.
  registerReadFile(target, resolveContext);
  // MOTIR-7862 — the hosted code graph, through motir-ai's graph-read route: the
  // planner executor's own text for `code_explore` / `code_search`. `ai:plan`.
  registerCodeGraphRead(target, resolveContext);
  // The ORIENTING read (MOTIR-3100) — the whole project's tree shape in one
  // call, over the same `aiBoundaryService.readPlanTree` the internal
  // `plan-tree` / `skeleton` routes serve. A third consumer, not a refactor.
  // It answers "what is already here?", which is the question an agent must
  // settle before it proposes anything; `search_work_items` answers it only as
  // a paging loop over flat rows the caller then re-parents itself.
  registerSkeleton(target, resolveContext);
  // Folder tools (MOTIR-5409) — see and tidy a project's folders over the shipped
  // folder service (MOTIR-5313). Placing a WORK ITEM in a folder is the work-item
  // tools' job (MOTIR-5413), not these.
  registerListFolders(target, resolveContext);
  // Story MOTIR-9023's section registry read (MOTIR-9029) — project-less.
  registerGetSectionSets(target, resolveContext);
  registerCreateFolder(target, resolveContext);
  registerUpdateFolder(target, resolveContext);
  registerDeleteFolder(target, resolveContext);
  // Page tools (MOTIR-5760) — an agent reads and writes a page as markdown by id
  // (`docs/decisions/pages.md` §8.2), over the same page service the editor uses.
  registerGetPage(target, resolveContext);
  registerCreatePage(target, resolveContext);
  registerUpdatePage(target, resolveContext);
  registerRenamePage(target, resolveContext);
  // Full-text page search (MOTIR-9553) — the same door as `GET /api/v1/…/pages/search`.
  registerSearchPages(target, resolveContext);
  // Re-file a page (MOTIR-9556) — the same door as `PATCH /api/v1/pages/{pageId}/placement`.
  registerMovePage(target, resolveContext);
  registerArchivePage(target, resolveContext);
  registerLinkPage(target, resolveContext);
  // A page as a decision card's decision (MOTIR-7434; approval-gates.md §8 NINTH AMENDMENT).
  registerPublishDecisionPage(target, resolveContext);
  // Sprint tools (7.8.10) — the Scrum cadence over the shipped Epic-4 services.
  registerListSprints(target, resolveContext);
  // Sprint finishability check (7.8.15) — productizes the re-validate-the-active-
  // sprint rule (plan-rules.md #94): a read over sprintsService.validateSprint.
  registerValidateSprint(target, resolveContext);
  // Work-item finishability check (7.8.23) — the single-item analogue of
  // validate_sprint, validating a target's whole subtree (any non-leaf kind).
  registerValidateWorkItem(target, resolveContext);
  // PLAN finishability (MOTIR-3095) — the FOREST verdict over a plan being
  // authored, the pre-commit check `motir-ai`'s generator already runs and a PAT
  // could not reach. Its own tool rather than a `planId` on validate_work_item
  // because it takes NO target: an edge between two sibling roots is valid in
  // the forest and a false positive per-root, so it is not a loop.
  registerValidatePlan(target, resolveContext);
  // Which proposals are authored, being authored, or not started (MOTIR-9821) —
  // the live read an author session makes before it wires an edge onto a sibling.
  registerGetPlanAuthoringState(target, resolveContext);
  registerCreateSprint(target, resolveContext);
  registerUpdateSprint(target, resolveContext);
  registerDeleteSprint(target, resolveContext);
  registerMoveToSprint(target, resolveContext);
  registerMoveToBacklog(target, resolveContext);
  // Re-parent (bug MOTIR-1017) — the structural move create/update can't do:
  // move a work item under a new parent or promote it to a top-level root.
  registerMoveToParent(target, resolveContext);
  registerStartSprint(target, resolveContext);
  registerCompleteSprint(target, resolveContext);
  // Integration-state tools (7.8.11) — the 7.9 CLI session loop's write surface.
  registerMarkIntegrated(target, resolveContext);
  registerCompleteSession(target, resolveContext);
  // Link tools (7.8.13) — the dependency-edge primitive over the Epic-2 link service.
  registerLinkWorkItems(target, resolveContext);
  // Edit + soft-remove tools (7.8.14) — patch fields create can't set, and the
  // archive/restore pair over the shipped work-item services.
  registerUpdateWorkItem(target, resolveContext);
  // Reclassify (MOTIR-1020) — change a work item's KIND, the structural change
  // update_work_item leaves out (sibling of move_to_parent's parent change).
  registerChangeKind(target, resolveContext);
  registerArchiveWorkItem(target, resolveContext);
  // Permanent delete (2.8.5) — the irreversible subtree-cascade counterpart of
  // archive, over the shipped 2.8.2 deleteWorkItem service.
  registerDeleteWorkItem(target, resolveContext);
}

/**
 * Build a fully-registered {@link McpServer}. The transport creates one per
 * request (stateless streamable HTTP); tests build one and connect it to an
 * in-memory client. `resolveContext` supplies each tool's actor — production
 * passes `contextFromExtra` (reads the bearer-resolved `AuthInfo`); tests pass a
 * fixed-context resolver. `resolveGrant`, when given, enables the per-token
 * permission gate — production passes `grantFromExtra`; a test
 * passes a fixed-scope resolver to exercise scope narrowing, and omits it to run
 * a tool unnarrowed. `meterBillableTools` enables the `ai:generate` gate on the
 * job-submitting tools (MOTIR-2610) — on in production, off for the in-process
 * tool tests, which have no rate-limit store behind them.
 */
export function buildMcpServer(
  resolveContext: McpContextResolver,
  resolveGrant?: McpGrantResolver,
  meterBillableTools = false,
): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);
  registerMcpTools(server, resolveContext, resolveGrant, meterBillableTools);
  return server;
}
