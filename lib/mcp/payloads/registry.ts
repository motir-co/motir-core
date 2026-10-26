import type { McpToolName } from '../registry';
import type { PayloadDefinition } from './define';
import { isExemptTool } from './exemptions';
import {
  MCP_UNREACHABLE_RESOURCES,
  SHARED_RESOURCE_NAMES,
  type SharedResourceName,
} from './sharedResources';
import {
  addCommentPayload,
  attachFilePayload,
  claimNextReadyPayload,
  claimWorkItemPayload,
  getWorkItemPayload,
  listReadyPayload,
  nextReadyPayload,
  searchWorkItemsPayload,
  skeletonPayload,
  workItemPlacementWritePayload,
  workItemWritePayload,
} from './workItems';
import { getDesignPayload, listDesignsPayload } from './designs';
import { getApprovalGatePayload } from './approvalGates';
import {
  listProjectsPayload,
  listSprintsPayload,
  membershipMovePayload,
  sprintWritePayload,
  whoamiPayload,
} from './planning';
import {
  activityPagePayload,
  claimWorkItemContinuePayload,
  claimWorkItemRepairPayload,
  dispatchPromptPayload,
  markIntegratedPayload,
  planJobHandlePayload,
  planOutcomePayload,
  planAppendPayload,
  planPayload,
  planSessionPayload,
  planSubmitPayload,
  sessionCloseOutPayload,
} from './workLoop';
import { folderDeletionPayload, folderWritePayload, listFoldersPayload } from './folders';
import { sectionSetsPayload } from './sectionSets';
import { archivePagePayload, linkPagePayload, movePagePayload, searchPagesPayload } from './pages';

// The TOOL → PAYLOAD map (Story 11.6 · Subtask 11.6.6 — MOTIR-2232).
//
// `derived()` is called at each tool, and until now no VALUE recorded which
// tools call it — so "every tool derives" was checkable only by reading
// thirty-odd files. This map is that missing value, and it is what lets the
// drift guard walk `lib/mcp/registry.ts` and report coverage instead of
// asserting over a set nobody defined.
//
// ⚠️ WHAT IS FROZEN AND WHAT IS FREE — read this before reading a red check.
// The guard covers the DATA SHAPE and NOTHING else. Tool NAMES, `tools/list`
// DESCRIPTIONS, ARGUMENT names and SCOPES are MCP's own and SHOULD churn:
// rewording a description is how an agent's behaviour gets tuned, and the whole
// architecture rests on that staying free, because only agents read them. If a
// red check here ever seems to forbid rewording a description, it is being
// misread — nothing in this file or its guard looks at prose. A contributor who
// concludes otherwise will route around the guard, which is a worse outcome than
// the drift it prevents (ADR Amendment 7; Story 11.6 criterion 3).

/**
 * Every tool that DERIVES, and the payload definition it derives through.
 *
 * `Partial` on purpose: the complement is `EXEMPT_TOOLS`, and
 * {@link unresolvedTools} asserts the two PARTITION the registry — so a tool
 * missing here is a failing run rather than a silent gap.
 */
export const TOOL_PAYLOADS: Partial<Record<McpToolName, PayloadDefinition<never>>> = {
  // 11.6.2 — the proving tool
  get_work_item: getWorkItemPayload as unknown as PayloadDefinition<never>,
  // MOTIR-5561 — the design reads, deriving from MOTIR-5560's v1 components
  get_design: getDesignPayload as unknown as PayloadDefinition<never>,
  list_designs: listDesignsPayload as unknown as PayloadDefinition<never>,
  // MOTIR-6191 — the gate read, deriving from the `ApprovalGateDecision` component
  // its v1 twin returns, so an agent's ability to read a reviewer's note does not
  // depend on which surface it reaches for.
  get_approval_gate: getApprovalGatePayload as unknown as PayloadDefinition<never>,
  // 11.6.3 — the work-item family
  search_work_items: searchWorkItemsPayload as unknown as PayloadDefinition<never>,
  list_ready: listReadyPayload as unknown as PayloadDefinition<never>,
  next_ready: nextReadyPayload as unknown as PayloadDefinition<never>,
  claim_next_ready: claimNextReadyPayload as unknown as PayloadDefinition<never>,
  // MOTIR-2961 — the KEYED claim. Its payload IS v1's `WorkItemClaim`, so it
  // probes that resource whole rather than a part of it.
  claim_work_item: claimWorkItemPayload as unknown as PayloadDefinition<never>,
  // MOTIR-6807 — the repair claim, deriving WHOLE from `WorkItemRepairClaim`: the
  // REST route and the tool answer through one presenter.
  claim_work_item_repair: claimWorkItemRepairPayload as unknown as PayloadDefinition<never>,
  // MOTIR-7262 — the continue claim, deriving WHOLE from `WorkItemContinueClaim`
  // the same way: the REST route and the tool answer through one presenter.
  claim_work_item_continue: claimWorkItemContinuePayload as unknown as PayloadDefinition<never>,
  // MOTIR-5413 — the two PLACING writes report where the item now sits.
  create_work_item: workItemPlacementWritePayload as unknown as PayloadDefinition<never>,
  update_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  transition_status: workItemWritePayload as unknown as PayloadDefinition<never>,
  archive_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  unarchive_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  change_kind: workItemWritePayload as unknown as PayloadDefinition<never>,
  move_to_parent: workItemPlacementWritePayload as unknown as PayloadDefinition<never>,
  add_comment: addCommentPayload as unknown as PayloadDefinition<never>,
  // MOTIR-5295 — an edit returns the comment it changed, the same shape the
  // add returns, so it derives through the same definition.
  edit_comment: addCommentPayload as unknown as PayloadDefinition<never>,
  // MOTIR-3100 — the plan-tree breadth projection. Its row is a declared
  // NARROWING of `WorkItemRef`, so it derives (and carries no probe) for the
  // same reason the search row does.
  skeleton: skeletonPayload as unknown as PayloadDefinition<never>,
  // MOTIR-5409 — the folder tools. The two writes return v1's `Folder` /
  // `FolderDeletion` resources whole and PROBE them; the tree read is a declared
  // narrowing of `Folder` and carries no probe, like the search row.
  list_folders: listFoldersPayload as unknown as PayloadDefinition<never>,
  // MOTIR-9029 — the section registry read: v1's `SectionSets` whole, and it PROBES it.
  get_section_sets: sectionSetsPayload as unknown as PayloadDefinition<never>,
  create_folder: folderWritePayload as unknown as PayloadDefinition<never>,
  // MOTIR-9553 — the page search: v1's search page, and each hit PROBES `PageSearchHit`.
  search_pages: searchPagesPayload as unknown as PayloadDefinition<never>,
  // MOTIR-9556 — the page move: v1's `PagePlacement` whole, and it PROBES it.
  move_page: movePagePayload as unknown as PayloadDefinition<never>,
  // MOTIR-9604 — archive / restore: the union of v1's `PageArchive` and
  // `PageRestore`, each branch PROBING its own resource.
  archive_page: archivePagePayload as unknown as PayloadDefinition<never>,
  // MOTIR-9604 — the hand link: v1's `PageLinkPair` plus `action` and `changed`,
  // and it PROBES the pair.
  link_page: linkPagePayload as unknown as PayloadDefinition<never>,
  update_folder: folderWritePayload as unknown as PayloadDefinition<never>,
  delete_folder: folderDeletionPayload as unknown as PayloadDefinition<never>,
  attach_file: attachFilePayload as unknown as PayloadDefinition<never>,
  // 11.6.4 — project / sprint / backlog / identity
  list_projects: listProjectsPayload as unknown as PayloadDefinition<never>,
  whoami: whoamiPayload as unknown as PayloadDefinition<never>,
  list_sprints: listSprintsPayload as unknown as PayloadDefinition<never>,
  create_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  update_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  start_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  complete_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  move_to_sprint: membershipMovePayload as unknown as PayloadDefinition<never>,
  move_to_backlog: membershipMovePayload as unknown as PayloadDefinition<never>,
  // 11.6.5 — the work-loop family
  dispatch_prompt: dispatchPromptPayload as unknown as PayloadDefinition<never>,
  mark_integrated: markIntegratedPayload as unknown as PayloadDefinition<never>,
  complete_session: sessionCloseOutPayload as unknown as PayloadDefinition<never>,
  expand_item: planJobHandlePayload as unknown as PayloadDefinition<never>,
  get_plan_status: planOutcomePayload as unknown as PayloadDefinition<never>,
  get_plan: planPayload as unknown as PayloadDefinition<never>,
  // The plan-AUTHORING door (MOTIR-2988). `create_plan` returns the plan itself,
  // so it derives through the very same definition `get_plan` does; the append
  // adds ONE transport field (`planItemIds`) to that shape, which is why it is a
  // `.extend` of it rather than a second description of a plan.
  create_plan: planPayload as unknown as PayloadDefinition<never>,
  add_plan_items: planAppendPayload as unknown as PayloadDefinition<never>,
  // The DEEPEN turn (MOTIR-3090) returns the whole plan, exactly as `get_plan`
  // and `create_plan` do — `deepenProposal` hands back a `PlanWithItemsDto` so a
  // caller sees the patched proposal in place without a second read. So it
  // derives through the very same definition rather than describing a plan a
  // third time. No `planItemIds`: this call creates no proposal.
  update_plan_item: planPayload as unknown as PayloadDefinition<never>,
  // The CORRECTION door (MOTIR-3541). Both return the whole plan for the same
  // reason the deepen does — the caller sees the corrected (or shortened)
  // proposal set in place without a second read — so both derive through the
  // one plan definition rather than describing a plan a fourth and fifth time.
  // No `planItemIds` on either: a correction creates no proposal, and a
  // withdraw removes one.
  update_plan_proposal: planPayload as unknown as PayloadDefinition<never>,
  withdraw_plan_proposal: planPayload as unknown as PayloadDefinition<never>,
  // The plan's OWN title / summary (MOTIR-4637) — the same plan definition again,
  // for the same reason: `correctPlanBrief` hands back the whole
  // `PlanWithItemsDto` so a caller sees the corrected heading AND its untouched
  // proposal set without a second read. No `planItemIds`: it creates no proposal
  // and touches none.
  update_plan: planPayload as unknown as PayloadDefinition<never>,
  open_plan_session: planSessionPayload as unknown as PayloadDefinition<never>,
  append_plan_turn: planSessionPayload as unknown as PayloadDefinition<never>,
  submit_plan_session: planSubmitPayload as unknown as PayloadDefinition<never>,
  get_work_item_activity: activityPagePayload as unknown as PayloadDefinition<never>,
};

/** Whether a tool derives its payload from a declared shared schema. */
export function isDerivedTool(name: McpToolName): boolean {
  return name in TOOL_PAYLOADS;
}

/**
 * Registered tools that are NEITHER derived NOR exempt.
 *
 * Empty is the invariant. A non-empty result is the defect this whole mechanism
 * exists to make visible: a tool nobody thought about and a tool deliberately
 * left out look identical from every other angle, including a passing suite.
 */
export function unresolvedTools(toolNames: readonly McpToolName[]): McpToolName[] {
  return toolNames.filter((name) => !isDerivedTool(name) && !isExemptTool(name));
}

/** Tools claimed by BOTH columns — a contradiction, and also empty. */
export function doublyResolvedTools(toolNames: readonly McpToolName[]): McpToolName[] {
  return toolNames.filter((name) => isDerivedTool(name) && isExemptTool(name));
}

/** Every shared resource some tool's payload PROBES. */
export function probedResources(): Set<SharedResourceName> {
  const probed = new Set<SharedResourceName>();
  for (const definition of Object.values(TOOL_PAYLOADS)) {
    for (const probe of definition.probes) probed.add(probe.resource);
  }
  return probed;
}

/**
 * Shared resources with NO MCP check and NO written reason.
 *
 * The coverage half of the guard. A resource that no tool probes is legitimate —
 * some resources genuinely have no MCP payload — but the legitimacy has to be
 * WRITTEN in {@link MCP_UNREACHABLE_RESOURCES}, because otherwise "not checked"
 * and "not noticed" are the same thing to every reader.
 */
export function unexplainedResources(): SharedResourceName[] {
  const probed = probedResources();
  return SHARED_RESOURCE_NAMES.filter(
    (name) => !probed.has(name) && !(name in MCP_UNREACHABLE_RESOURCES),
  );
}
