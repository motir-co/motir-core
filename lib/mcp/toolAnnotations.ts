import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpToolName } from './registry';

// The MCP tool → ANNOTATIONS table (Story MOTIR-6974 · Subtask MOTIR-7001).
//
// ── What it is for ─────────────────────────────────────────────────────────
// An MCP client reads a tool's `annotations` to decide how carefully to treat a
// call. Claude runs a `readOnlyHint: true` tool without asking and asks before a
// destructive one, and its connector directory refuses a server whose tools
// carry no hints. A tool that says nothing is assumed to be a possible write, so
// before this table every Motir read — "show me MOTIR-12" — asked for approval.
//
// ── The classification RULE, stated once ───────────────────────────────────
// Each row is a judgement about what the tool's HANDLER does, read off the code
// and recorded in the row's comment (the service method(s) it calls, and the
// write if any). The row follows the code; a verdict that surprises is reported,
// never fixed by re-shaping the tool here.
//
//  - READ (`readOnlyHint: true`) — the handler performs NO write: no row
//    created, updated or deleted, no job enqueued, no status moved, no counter
//    or timestamp stamped. A read that writes anything is a write, however it is
//    named.
//  - WRITE, `destructiveHint: false` — ONLY when every write is ADDITIVE: it
//    creates a new row, appends, or links, and changes or removes no existing
//    value. This is the MCP spec's own line ("If false, the tool performs only
//    additive updates").
//  - WRITE, `destructiveHint: true` — anything that deletes, archives,
//    withdraws, revokes, cancels, unlinks, closes, moves a status, or overwrites
//    a stored value (every `update_*`, every `move_*`, `transition_status`, the
//    claim tools).
//  - `idempotentHint: true` — only where a second identical call has no further
//    effect (re-setting the same status, re-linking an existing edge), confirmed
//    from the handler or service, never assumed from the verb.
//  - `openWorldHint: true` — only where the handler reaches a system outside
//    Motir's own deployment (a third-party API). Motir's own services, its own
//    `motir-ai` backend and its own blob store are Motir's world.
//
// The MCP spec's DEFAULTS are the permissive ones (`destructiveHint` and
// `openWorldHint` default to `true`, `idempotentHint` to `false`), so this table
// relies on none of them: every field is explicit on every row, and the row
// type makes a write row without `destructiveHint` / `idempotentHint` a compile
// error.
//
// The rate-limit and permission wrappers (`rateLimitGate.ts`,
// `permissionGate.ts`) are not part of any handler and are not classified here:
// they run for every tool alike.
//
// ── Totality, and one place to declare a hint ───────────────────────────────
// Typed `Record<McpToolName, McpToolAnnotations>` like `TOOL_PERMISSIONS`, so a
// tool added to `MCP_TOOL_NAMES` without a row is a COMPILE error — never a
// silent read-only. {@link annotatedServer} injects the row at the registration
// seam and REFUSES a tool that declares its own `annotations`, so no tool module
// carries a hint and there is no second place one could drift.
//
// A LEAF module: every import is `import type` (erased at compile), so
// `lib/apiDocs/` could reach it without pulling the registry, the tools, the
// services or Prisma — the same property `toolPermissions.ts` holds.

/** A tool whose handler performs no write of any kind. */
export interface McpReadToolAnnotations {
  readonly readOnlyHint: true;
  readonly openWorldHint: boolean;
}

/** A tool whose handler writes. Both write hints are REQUIRED: the spec's
 * defaults are the permissive ones, and this table relies on no default. */
export interface McpWriteToolAnnotations {
  readonly readOnlyHint: false;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** One row of {@link TOOL_ANNOTATIONS} — the `annotations` object `tools/list`
 * serves for that tool, exactly. */
export type McpToolAnnotations = McpReadToolAnnotations | McpWriteToolAnnotations;

/** The longest `title` the seam accepts — Claude's connector review criteria
 * show a tool by its title and cap it here. */
export const MAX_TOOL_TITLE_LENGTH = 64;

// Every row is read off its handler; the comment is the evidence (`tool module →
// service method(s)`, and the write when there is one). `R` = no write found.
export const TOOL_ANNOTATIONS: Record<McpToolName, McpToolAnnotations> = {
  // ── Reads + dispatch ──────────────────────────────────────────────────────
  // R: getWorkItem.ts → workItemsService.getIssueDetail / getReadiness / listDeliverySet, approvalGatesService.latestRefusalFor
  get_work_item: { readOnlyHint: true, openWorldHint: false },
  // R: getDesign.ts → designAccessService.getApprovedDesign + downloadLinks (a local presign of Motir's own bucket, stores nothing)
  get_design: { readOnlyHint: true, openWorldHint: false },
  // R: listDesigns.ts → designAccessService.designsForWorkItem / listApprovedDesigns
  list_designs: { readOnlyHint: true, openWorldHint: false },
  // R: getApprovalGate.ts → approvalGateAccessService.getGateRecord → approvalGatesService.getForWorkItem
  get_approval_gate: { readOnlyHint: true, openWorldHint: false },
  // R: getWorkItemActivity.ts → commentsService.listComments / activityService.listHistory / listAll
  get_work_item_activity: { readOnlyHint: true, openWorldHint: false },
  // R: listReady.ts → workItemsService.listReadyLeaves / listReadyBugs / listReadyContainers
  list_ready: { readOnlyHint: true, openWorldHint: false },
  // R: nextReady.ts → workItemsService.getNextReadyInLane (ciAllowanceService reads the ledger + motir-ai GET /v1/usage) — nothing reserved
  next_ready: { readOnlyHint: true, openWorldHint: false },
  // W: claimNextReady.ts → workItemsService.claimNextReady — overwrites assigneeId, moves status to in_progress; each call claims another card
  claim_next_ready: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // `action: "unlink"` is an unlinking verb, so a destructive write by this table's rule
  // (as `link_work_items` / `unlink_work_items` share one door). Not idempotent: a link
  // repeated answers `changed: false`, but an unlink repeated is refused PAGE_LINK_NOT_FOUND.
  // W: linkPage.ts → pageLinksService.linkPageForWorkItem / unlinkPageForWorkItem — writes or deletes the manual row and the work item's revision
  link_page: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: claimWorkItem.ts → workItemsService.claimWorkItem — overwrites assigneeId, moves status; a repeat answers `mine` and writes nothing
  claim_work_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemRepair.ts → workItemRepairService.claimRepair — opens a dispatch run, overwrites work_item.fix_reason, re-stamps the heartbeat on every call
  claim_work_item_repair: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemRepair.ts → workItemRepairService.touchRepair → dispatchRunRepository.touchHeartbeat — overwrites last_heartbeat_at every call
  touch_work_item_repair: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemRepair.ts → workItemRepairService.closeRepair → dispatchRunService.close — closes the run; an already-closed run writes nothing
  close_work_item_repair: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemContinue.ts → workItemContinueService.claimContinue — opens a dispatch run, overwrites assigneeId, closes a lapsed run; a repeat answers `mine` and re-stamps the heartbeat
  claim_work_item_continue: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemContinue.ts → workItemContinueService.touchContinue → dispatchRunRepository.touchHeartbeat — overwrites last_heartbeat_at every call
  touch_work_item_continue: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemContinue.ts → workItemContinueService.closeContinue → dispatchRunService.close — closes the run; an already-closed run writes nothing
  close_work_item_continue: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemRun.ts → dispatchRunService.openAgentRun — opens a dispatch run and its `run_opened` event; a repeat answers `mine` and writes nothing. Additive: it records, it never overwrites the card
  start_work_item_run: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemRun.ts → dispatchRunService.reportAction — appends run events and stamps the heartbeat; every call adds a step
  report_action: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemRun.ts → dispatchRunService.closeAgentRun — closes the run for good and overwrites the cards' implementation provenance; an already-closed run writes nothing
  close_work_item_run: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // R: dispatchPrompt.ts → dispatchPromptService.getDispatchPrompt — assembled per call, never stored
  dispatch_prompt: { readOnlyHint: true, openWorldHint: false },
  // W: expandItem.ts → aiPlanEditsService.submitExpand — a motir-ai job + a new plan; may coalesce onto a pending code-graph job (overwrite)
  expand_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // R: expandItem.ts → aiPlanEditsService.getOutcome (plan reads + motir-ai GET /v1/jobs/:id)
  get_plan_status: { readOnlyHint: true, openWorldHint: false },
  // R: getPlan.ts → plansService.getPlanForReader, planReviewService.getPlanReview
  get_plan: { readOnlyHint: true, openWorldHint: false },
  // R: getApprovedShapeVerdict.ts → plansService.listPlanHistoryForWorkItem / resolveApprovedShapeVerdict
  get_approved_shape_verdict: { readOnlyHint: true, openWorldHint: false },
  // W: reportUnbuildableTarget.ts → runFoundReportService.reportUnbuildableTarget — ledger row + markOutcome, files a bug; may append a finding per call
  report_unbuildable_target: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: recordRunDiscrepancy.ts → runDiscrepancyService.recordDiscrepancy — one comment on the card and one finding on its open leg; additive, refused (not repeated) on a second call
  record_run_discrepancy: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },

  // ── Plan authoring ────────────────────────────────────────────────────────
  // W: authorPlan.ts → plansService.createPlan — a new session, plan and revision row; additive
  create_plan: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.addProposals / markPlanned — parks targets (status move), overwrites a repeated `modify`
  add_plan_items: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.deepenProposal — overwrites proposedFields, appends a revision every call
  update_plan_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.correctProposal — overwrites a proposal, appends a revision every call
  update_plan_proposal: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.withdrawProposal — deletes the proposal; the last one declines the plan
  withdraw_plan_proposal: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.correctPlanBrief — overwrites title / summary, appends a revision every call
  update_plan: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.recordRevisionClassification — appends one revision row per call
  record_plan_revision_reason: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // plansService.recordPlanNarration APPENDS a session's sentences (a repeat appends them again),
  // so the tool as a whole is not idempotent (MOTIR-8062).
  // W: authorPlan.ts → plansService.recordPlanStep / endPlanStep / recordPlanNarration — a step upserts one row per session (a repeat replaces it; `end` on no row is a no-op)
  report_plan_step: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: authorPlan.ts → plansService.acquireRevisionLease / renewRevisionLease / closeRevision — appends one trail row per call (start and end also move the plan's status: a revision re-opens a `planned` plan and its end closes it, MOTIR-8208) (`end` on no hold, and `renew` on a lapsed one, write nothing)
  hold_plan_revision: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: planSession.ts → planChangeSessionsService.openPublic — may create a session; re-acquires target locks (parks cards, extends the lease)
  open_plan_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: planSession.ts → planChangeSessionsService.appendPublic — a turn row per call; locks / parks targets
  append_plan_turn: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: planSession.ts → planChangeSessionsService.submitPublic — a metered motir-ai job + a new plan; overwrites lastJobId
  submit_plan_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },

  // ── Work items, comments, todos, lessons, evidence ───────────────────────
  // W: createWorkItem.ts → workItemsService.createWorkItem — new row, but bumps the project counter and rewrites ancestor repo sets
  create_work_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: transitionStatus.ts → workItemsService.updateStatus — moves status (same status is a no-op); `implemented` may read GitHub check runs
  transition_status: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // W: addComment.ts → commentsService.addComment — new comment rows; clears snoozedUntil on a snoozed item
  add_comment: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: editComment.ts → commentsService.editComment — overwrites bodyMd; an identical body writes nothing
  edit_comment: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: deleteComment.ts → commentsService.deleteComment — deletes; a repeat finds nothing
  delete_comment: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // R: workItemTodos.ts → workItemTodosService.listTodos
  list_work_item_todos: { readOnlyHint: true, openWorldHint: false },
  // R: getPage.ts → pagesService.getPageMarkdown — no lock, no write
  get_page: { readOnlyHint: true, openWorldHint: false },
  // W: createPage.ts → pagesService.createPageFromMarkdown — inserts a page; additive
  create_page: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // ⚠️ `update_page` REPLACES the body and is still `destructiveHint: false`, on
  // purpose (MOTIR-7411): the replaced body stays a restorable version in the
  // page's history, so the write is reversible, and MCP clients read this hint to
  // decide whether to stop and ask a person first — a prompt a reversible page
  // edit does not warrant. A replay at the same revision is refused
  // PAGE_REVISION_CONFLICT, so it is not idempotent.
  // W: updatePage.ts → pagesService.savePageMarkdown — replaces the body; the old one stays a version
  update_page: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // `rename_page` OVERWRITES the title, and unlike a body replace there is no history row to
  // restore it from — so it is a destructive write, as `update_folder`'s rename is. The same
  // title twice is the same state, so it is idempotent.
  // W: renamePage.ts → pagesService.renamePage — sets the title
  rename_page: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // R: searchPages.ts → pagesService.searchPages — a ranked read, no lock, no write
  search_pages: { readOnlyHint: true, openWorldHint: false },
  // A move overwrites where the page and its whole subtree sit — every moving verb is a
  // destructive write here, as `move_to_parent` is; the same destination twice answers
  // `moved: false` and writes nothing, so it is idempotent.
  // W: movePage.ts → pagesService.movePage — re-parents/reorders the page and rewrites its subtree's ancestors
  move_page: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Archiving is an archiving verb, so a destructive write by this table's rule, even though
  // `action: "restore"` undoes it and nothing is deleted. NOT idempotent: a second archive is
  // refused PAGE_ARCHIVED (a second restore PAGE_NOT_ARCHIVED) rather than answering the same.
  // W: archivePage.ts → pagesService.archivePage / restorePage — archives or restores the page and its subtree
  archive_page: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // A replay of the same version writes nothing, so it is idempotent; not destructive
  // (nothing is removed).
  // W: publishDecisionPage.ts → decisionPageService.publish — seals a version, records the publication, supersedes + raises the decision gate
  publish_decision_page: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemTodos.ts → workItemTodosService.addTodo — appends a step + revision; additive
  add_work_item_todo: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemTodos.ts → workItemTodosService.setTodoDone — overwrites doneAt; the requested state already held writes nothing
  set_work_item_todo_done: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemTodos.ts → workItemTodosService.updateTodo — overwrites the step's fields; every non-empty patch records a revision
  update_work_item_todo: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: workItemTodos.ts → workItemTodosService.deleteTodo — deletes; a repeat finds nothing
  delete_work_item_todo: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: workItemTodos.ts → workItemTodosService.moveTodo — overwrites the step's position (a `move_` verb, so destructive like `move_to_parent`); the same index again lands it where it already is
  move_work_item_todo: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: addLesson.ts → projectLessonsService.addLesson → motir-ai POST /v1/lessons — additive; a near-duplicate is refused
  add_lesson: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: searchLessons.ts → enforceAiRateLimit (increments a Postgres rate-limit counter in the handler), then motir-ai search
  search_lessons: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: reinforceLesson.ts → motir-ai recordOccurrence — bumps recurrenceCount; a repeated occurrenceRef counts nothing
  reinforce_lesson: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: attachFile.ts → attachmentsService.attachToWorkItem — a new blob, attachment row and link; additive
  attach_file: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: publishDesignResult.ts → designEvidenceService.recordFromPathnames / recordFromBytes — supersedes the prior evidence + gate
  publish_design_result: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // R: publishDesignResult.ts → designEvidenceService.createUploadTokens — reads + a local presign; no grant row
  create_design_upload: { readOnlyHint: true, openWorldHint: false },
  // R: publishAcceptanceResult.ts → acceptanceEvidenceService.createUploadTokens — reads + a local presign; no grant row
  create_acceptance_upload: { readOnlyHint: true, openWorldHint: false },
  // W: publishAcceptanceResult.ts → acceptanceEvidenceService.recordFromPathnames — supersedes the prior receipt + gate
  publish_acceptance_result: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: publishTestInstructions.ts → testInstructionsService.publish — flips the previous record's isCurrent; same run + body is a no-op
  publish_test_instructions: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: linkPullRequest.ts → githubPullRequestService.linkPullRequestByCoordinates — upserts the delivery, may withdraw a gate; writes a GitHub check run
  link_pull_request: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  // W: unlinkPullRequest.ts → githubPullRequestService.unlinkPullRequestByCoordinates — removes the delivery; refreshes the GitHub check run
  unlink_pull_request: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // R: searchWorkItems.ts → workItemsService.getProjectIssuesList, commentsService.getCommentCountsForItems
  search_work_items: { readOnlyHint: true, openWorldHint: false },
  // W: searchWorkItemsSemantic.ts → enforceAiRateLimit (rateLimitCounterRepository.increment), then aiBoundaryService.searchSimilarWorkItemsByText
  search_work_items_semantic: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },

  // ── Workspace, project, folders ──────────────────────────────────────────
  // R: whoami.ts → usersService.getProfile, workspacesService.getWorkspaceSummary (token stamping is the transport's, not this handler's)
  whoami: { readOnlyHint: true, openWorldHint: false },
  // R: listProjects.ts → projectsService.listProjects
  list_projects: { readOnlyHint: true, openWorldHint: false },
  // R: getProjectState.ts → projectStateService.getProjectState (the GitHub installation mirror in Motir's DB, no API call)
  get_project_state: { readOnlyHint: true, openWorldHint: false },
  // R: getCodeHealth.ts → aiConventionService.getPlanningCodeHealth (Motir's own index columns + motir-ai's audit/convention stores over the private boundary — no third-party call)
  get_code_health: { readOnlyHint: true, openWorldHint: false },
  // R: getCodingConvention.ts → aiConventionService.getPlanningConvention (motir-ai's convention store over the boundary + one user-name read).
  get_coding_convention: { readOnlyHint: true, openWorldHint: false },
  // R: readFile.ts → repoFileReadService.readProjectFile → GitProvider.readFileAtRef (the THIRD-PARTY git host — open world, unlike get_code_health)
  read_file: { readOnlyHint: true, openWorldHint: true },
  // R: codeGraphRead.ts → codeGraphReadService.read → motir-ai POST /v1/code-graph/read (Motir's own hosted graph over the private boundary — no third-party call)
  code_explore: { readOnlyHint: true, openWorldHint: false },
  // R: codeGraphRead.ts → codeGraphReadService.read → motir-ai POST /v1/code-graph/read (as code_explore)
  code_search: { readOnlyHint: true, openWorldHint: false },
  // R: skeleton.ts → aiBoundaryService.readPlanTree
  skeleton: { readOnlyHint: true, openWorldHint: false },
  // R: listFolders.ts → foldersService.listProjectFolders
  list_folders: { readOnlyHint: true, openWorldHint: false },
  // R: getSectionSets.ts → sectionSchemaService.describe (an in-memory registry read)
  get_section_sets: { readOnlyHint: true, openWorldHint: false },
  // W: createFolder.ts → foldersService.createFolder → folderRepository.create; additive
  create_folder: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: updateFolder.ts → foldersService.updateFolder — rename / move; unchanged is an early return
  update_folder: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: deleteFolder.ts → foldersService.deleteFolder — re-files items, deletes; a repeat finds nothing
  delete_folder: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  // ── Sprints, validity, backlog ───────────────────────────────────────────
  // R: listSprints.ts → sprintsService.listByProject
  list_sprints: { readOnlyHint: true, openWorldHint: false },
  // R: validateSprint.ts → sprintsService.validateSprint / planValidityService.validateProjectedSprint
  validate_sprint: { readOnlyHint: true, openWorldHint: false },
  // R: validateWorkItem.ts → workItemsService.validateWorkItem / planValidityService.validateProjectedWorkItem
  validate_work_item: { readOnlyHint: true, openWorldHint: false },
  // R: validatePlan.ts → planValidityService.validateProjectedPlan
  validate_plan: { readOnlyHint: true, openWorldHint: false },
  // W: createSprint.ts → sprintsService.createSprint → sprintRepository.create; additive
  create_sprint: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: updateSprint.ts → sprintsService.updateSprint → sprintRepository.update (overwrite)
  update_sprint: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: deleteSprint.ts → sprintsService.deleteSprint → sprintRepository.delete
  delete_sprint: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: moveToSprint.ts → backlogService.bulkAssignToSprint — sets the sprint and a fresh rank + revision every call
  move_to_sprint: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: moveToBacklog.ts → backlogService.bulkMoveToBacklog — clears the sprint; already in the backlog is skipped
  move_to_backlog: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: moveToParent.ts → workItemsService.moveWorkItem / fileWorkItem — re-parents; unchanged is a no-op
  move_to_parent: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: startSprint.ts → sprintsService.startSprint — sprint state to active; a repeat is refused
  start_sprint: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: completeSprint.ts → sprintsService.completeSprint — closes the sprint, carries work over; a repeat is refused
  complete_sprint: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: markIntegrated.ts → workItemsService.markIntegrated — moves to implemented; the CI latch may read GitHub check runs
  mark_integrated: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // W: completeSession.ts → workItemsService.completeSession — moves the branch's items to done; a repeat finds none
  complete_session: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  // ── Links, edits, archive, delete ────────────────────────────────────────
  // W: linkWorkItems.ts → workItemsService.linkWorkItems → workItemLinkRepository.create; an existing edge is a no-op; additive
  link_work_items: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: linkWorkItems.ts → workItemsService.unlinkWorkItemsByEndpoints → workItemLinkRepository.delete; absent is a no-op
  unlink_work_items: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: updateWorkItem.ts → workItemsService.updateWorkItem — overwrites fields; an empty diff writes nothing
  update_work_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: changeKind.ts → workItemsService.updateWorkItem (kind) — the same kind is an empty diff
  change_kind: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // W: archiveWorkItem.ts → workItemsService.archiveWorkItem — re-stamps archivedAt + a revision every call
  archive_work_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: archiveWorkItem.ts → workItemsService.unarchiveWorkItem — clears archivedAt + a revision every call
  unarchive_work_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // W: deleteWorkItem.ts → workItemsService.deleteWorkItem → workItemRepository.deleteSubtree; a repeat finds nothing
  delete_work_item: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** The seam's refusal: a tool whose registration would publish no honest hint
 * or no usable title. Thrown at REGISTRATION, so a bad tool stops the server
 * from building rather than reaching a client. */
export class ToolAnnotationError extends Error {
  constructor(
    readonly toolName: string,
    reason: string,
  ) {
    super(`MCP tool "${toolName}": ${reason}`);
    this.name = 'ToolAnnotationError';
  }
}

/**
 * Wrap `server` so every `registerTool(name, config, cb)` call's `config` gains
 * `annotations: { title: config.title, ...TOOL_ANNOTATIONS[name] }` — the title
 * repeated there because Claude's connector directory reads it from
 * `annotations.title` (MOTIR-7189). It THROWS, naming the tool, when the
 * name has no row, when `config.title` is absent, blank or longer than
 * {@link MAX_TOOL_TITLE_LENGTH}, and when `config` already carries
 * `annotations` — the table is the one place a hint is declared.
 *
 * Like `strictInputServer`, it touches the config and never the callback, so it
 * composes with the policy wrappers without ordering against them.
 */
export function annotatedServer(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'registerTool' || typeof value !== 'function') return value;
      const register = value as (...registerArgs: unknown[]) => unknown;
      return (...registerArgs: unknown[]) => {
        const name = String(registerArgs[0]);
        const config = (registerArgs[1] ?? {}) as { title?: unknown; annotations?: unknown };
        if (!Object.hasOwn(TOOL_ANNOTATIONS, name)) {
          throw new ToolAnnotationError(name, 'has no row in TOOL_ANNOTATIONS');
        }
        const title = config.title;
        if (typeof title !== 'string' || title.trim() === '') {
          throw new ToolAnnotationError(name, 'declares no title');
        }
        if (title.length > MAX_TOOL_TITLE_LENGTH) {
          throw new ToolAnnotationError(
            name,
            `title is ${title.length} characters, over the ${MAX_TOOL_TITLE_LENGTH} allowed`,
          );
        }
        if (config.annotations !== undefined) {
          throw new ToolAnnotationError(
            name,
            'declares its own annotations — hints are declared only in TOOL_ANNOTATIONS',
          );
        }
        // The title is served twice from the one declaration: as the tool's own
        // `title` and as `annotations.title`, which is where Claude's connector
        // directory reads the name it lists (bug MOTIR-7189). The table holds
        // only hints; the title stays declared by the tool itself.
        const next = [...registerArgs];
        next[1] = {
          ...config,
          annotations: { title, ...TOOL_ANNOTATIONS[name as McpToolName] },
        };
        return register.apply(target, next);
      };
    },
  });
}
