/**
 * The `/api/v1` operation table, as `@motir/cli` sees it.
 *
 * ⚠️ GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with `pnpm generate:cli-api` from the repository root (or
 * `pnpm --filter @motir/cli generate:api`, which delegates to it). CI
 * regenerates and fails on any diff, so a hand edit cannot survive a PR.
 *
 * Source: `emitOpenApiDocument()` in `lib/api/v1/openapi/emit.ts` — the same
 * value `/api/openapi/v1.json` serves. See `docs/decisions/cli-v1-client.md`.
 */

/** One declared operation: how to call it, and what it answers with. */
export interface V1OperationRow {
  /** The HTTP verb. */
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** The path template, dynamic segments as `{name}`. */
  readonly path: string;
  /**
   * The PERMISSION this operation requires.
   *
   * Read off the document's `x-motir-permission` extension, which the server
   * emits from `lib/mcp/toolPermissions.ts` + the v1 declarations. This is where
   * the CLI's 403 message gets the permission name — never by parsing the
   * server's English sentence.
   */
  readonly permission: string;
  /** The 2xx status the happy path returns. */
  readonly successStatus: number;
  /**
   * The component the success body IS, when it is a plain resource.
   * `undefined` for a paged response, whose body is an envelope composition
   * rather than one named component.
   */
  readonly responseComponent: string | undefined;
}

/**
 * The API MAJOR this client was generated against — the path version.
 *
 * A server serving a different major serves a different document at a
 * different URL (ADR Amendment 4 Q6), so a mismatch here is not a degraded
 * mode, it is a different API.
 */
export const API_MAJOR = 1;

/**
 * The contract version this client was generated against — `info.version`'s
 * `MAJOR.MINOR.PATCH`, NOT the deployment's release number.
 *
 * The version-skew gate compares a server's number against THIS. Within a
 * major, ADR §8 promises additive-only, so a server at or above this is
 * compatible by construction and only a server BELOW it can be missing
 * something this client was generated to expect.
 */
export const GENERATED_AGAINST = "1.76.0";

/** Every declared operation, keyed by `operationId`. */
export const V1_OPERATIONS = {
  "appendDispatchRunEvents": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/events",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "DispatchRunAppended",
  },
  "appendPlanTurn": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session/turns",
    permission: "ai:plan",
    successStatus: 200,
    responseComponent: "PlanSession",
  },
  "approveWorkItemPlan": {
    method: "POST",
    path: "/api/v1/work-items/{key}/plan-approval",
    permission: "ai:decide_plan",
    successStatus: 200,
    responseComponent: "Plan",
  },
  "archivePage": {
    method: "POST",
    path: "/api/v1/pages/{pageId}/archive",
    permission: "page:edit",
    successStatus: 200,
    responseComponent: "PageArchive",
  },
  "archiveWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/archive",
    permission: "work_item:archive",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "claimScope": {
    method: "POST",
    path: "/api/v1/scope-claims",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "ScopeClaim",
  },
  "claimWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/claim",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemClaim",
  },
  "claimWorkItemContinue": {
    method: "POST",
    path: "/api/v1/work-items/{key}/continue",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemContinueClaim",
  },
  "claimWorkItemRepair": {
    method: "POST",
    path: "/api/v1/work-items/{key}/repair",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemRepairClaim",
  },
  "closeDispatchRun": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/close",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "DispatchRun",
  },
  "completeSession": {
    method: "POST",
    path: "/api/v1/sessions/complete",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "SessionCloseOut",
  },
  "completeSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/complete",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "countProjectWorkItems": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/work-items/count",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "WorkItemCount",
  },
  "createFolder": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/folders",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: "Folder",
  },
  "createPage": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/pages",
    permission: "page:edit",
    successStatus: 201,
    responseComponent: "Page",
  },
  "createSprint": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/sprints",
    permission: "sprint:manage",
    successStatus: 201,
    responseComponent: "Sprint",
  },
  "createWorkItem": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/work-items",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: "WorkItemDetail",
  },
  "createWorkItemComment": {
    method: "POST",
    path: "/api/v1/work-items/{key}/comments",
    permission: "comment:add",
    successStatus: 201,
    responseComponent: undefined,
  },
  "createWorkItemLink": {
    method: "POST",
    path: "/api/v1/work-items/{key}/links",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: undefined,
  },
  "deleteFolder": {
    method: "DELETE",
    path: "/api/v1/folders/{folderId}",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "FolderDeletion",
  },
  "deleteWorkItemLink": {
    method: "DELETE",
    path: "/api/v1/work-items/{key}/links",
    permission: "work_item:edit",
    successStatus: 204,
    responseComponent: undefined,
  },
  "getDispatchRun": {
    method: "GET",
    path: "/api/v1/dispatch-runs/{id}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "DispatchRun",
  },
  "getDispatchRunCloseOutPrompt": {
    method: "GET",
    path: "/api/v1/dispatch-runs/{id}/close-out-prompt",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "DispatchRunCloseOutPrompt",
  },
  "getFolder": {
    method: "GET",
    path: "/api/v1/folders/{folderId}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Folder",
  },
  "getMe": {
    method: "GET",
    path: "/api/v1/me",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Me",
  },
  "getPage": {
    method: "GET",
    path: "/api/v1/pages/{pageId}",
    permission: "page:view",
    successStatus: 200,
    responseComponent: "Page",
  },
  "getPlan": {
    method: "GET",
    path: "/api/v1/plans/{planId}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Plan",
  },
  "getPlanStatus": {
    method: "GET",
    path: "/api/v1/plans/{planId}/status",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "PlanOutcome",
  },
  "getProject": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Project",
  },
  "getProjectBacklog": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/backlog",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getProjectReadyBugs": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/ready/bugs",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getProjectReadyContainers": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/ready/containers",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getProjectReadyLeaves": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/ready/leaves",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getSectionSets": {
    method: "GET",
    path: "/api/v1/section-sets",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "SectionSets",
  },
  "getSprint": {
    method: "GET",
    path: "/api/v1/sprints/{sprintId}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "getWorkItem": {
    method: "GET",
    path: "/api/v1/work-items/{key}",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "getWorkItemActivity": {
    method: "GET",
    path: "/api/v1/work-items/{key}/activity",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getWorkItemApprovalGate": {
    method: "GET",
    path: "/api/v1/work-items/{key}/approval-gate",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getWorkItemDesign": {
    method: "GET",
    path: "/api/v1/work-items/{key}/design",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "DesignVerdict",
  },
  "getWorkItemDispatchPrompt": {
    method: "GET",
    path: "/api/v1/work-items/{key}/dispatch-prompt",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "DispatchPrompt",
  },
  "getWorkItemHowToTest": {
    method: "GET",
    path: "/api/v1/work-items/{key}/how-to-test",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "CurrentTestInstructions",
  },
  "getWorkItemPlan": {
    method: "GET",
    path: "/api/v1/work-items/{key}/plan-approval",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "getWorkItemReviewPrompt": {
    method: "GET",
    path: "/api/v1/work-items/{key}/review-prompt",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "ReviewPrompt",
  },
  "heartbeatDispatchRun": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/heartbeat",
    permission: "work_item:edit",
    successStatus: 204,
    responseComponent: undefined,
  },
  "issueDispatchRunGitCredentials": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/git-credential",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: undefined,
  },
  "linkPageWorkItem": {
    method: "POST",
    path: "/api/v1/pages/{pageId}/work-items",
    permission: "page:edit",
    successStatus: 200,
    responseComponent: "PageLinkPair",
  },
  "linkWorkItemPullRequest": {
    method: "POST",
    path: "/api/v1/work-items/{key}/pull-requests",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listFolders": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/folders",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectDesigns": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/designs",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectRepositories": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/repositories",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjects": {
    method: "GET",
    path: "/api/v1/projects",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectSprints": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/sprints",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listProjectWorkItems": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/work-items",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listSprintWorkItems": {
    method: "GET",
    path: "/api/v1/sprints/{sprintId}/work-items",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemComments": {
    method: "GET",
    path: "/api/v1/work-items/{key}/comments",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemDesigns": {
    method: "GET",
    path: "/api/v1/work-items/{key}/designs",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "listWorkItemLinks": {
    method: "GET",
    path: "/api/v1/work-items/{key}/links",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "WorkItemLinkGroups",
  },
  "listWorkItemTransitions": {
    method: "GET",
    path: "/api/v1/work-items/{key}/transitions",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: "TransitionList",
  },
  "listWorkspaces": {
    method: "GET",
    path: "/api/v1/workspaces",
    permission: "project:browse",
    successStatus: 200,
    responseComponent: undefined,
  },
  "movePage": {
    method: "PATCH",
    path: "/api/v1/pages/{pageId}/placement",
    permission: "page:edit",
    successStatus: 200,
    responseComponent: "PagePlacement",
  },
  "moveWorkItemsToBacklog": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/backlog/work-items",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "MembershipMoveResult",
  },
  "moveWorkItemsToSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/work-items",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "MembershipMoveResult",
  },
  "openDispatchRun": {
    method: "POST",
    path: "/api/v1/dispatch-runs",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: "DispatchRunOpened",
  },
  "openPlanSession": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session",
    permission: "ai:plan",
    successStatus: 200,
    responseComponent: "PlanSession",
  },
  "recordDispatchRunDiscrepancy": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/discrepancy",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "RunDiscrepancyAcknowledgement",
  },
  "recordWorkItemIntegration": {
    method: "POST",
    path: "/api/v1/work-items/{key}/integration",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "IntegrationResult",
  },
  "reportDispatchRunStop": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/stop",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "RunStopReportAcknowledgement",
  },
  "reportDispatchRunUnbuildable": {
    method: "POST",
    path: "/api/v1/dispatch-runs/{id}/unbuildable",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "UnbuildableReportAcknowledgement",
  },
  "reportWorkItemImplementation": {
    method: "POST",
    path: "/api/v1/work-items/{key}/implementation",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: undefined,
  },
  "restorePage": {
    method: "POST",
    path: "/api/v1/pages/{pageId}/restore",
    permission: "page:edit",
    successStatus: 200,
    responseComponent: "PageRestore",
  },
  "restoreWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/restore",
    permission: "work_item:archive",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "searchPages": {
    method: "GET",
    path: "/api/v1/projects/{projectKey}/pages/search",
    permission: "page:view",
    successStatus: 200,
    responseComponent: undefined,
  },
  "startSprint": {
    method: "POST",
    path: "/api/v1/sprints/{sprintId}/start",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "submitPlanSession": {
    method: "POST",
    path: "/api/v1/projects/{projectKey}/plan-session/submissions",
    permission: "ai:plan",
    successStatus: 202,
    responseComponent: "PlanJobHandle",
  },
  "submitWorkItemAgentReview": {
    method: "POST",
    path: "/api/v1/work-items/{key}/agent-review",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "AgentReviewResult",
  },
  "submitWorkItemExpansion": {
    method: "POST",
    path: "/api/v1/work-items/{key}/expansions",
    permission: "ai:plan",
    successStatus: 202,
    responseComponent: "PlanJobHandle",
  },
  "transitionWorkItem": {
    method: "POST",
    path: "/api/v1/work-items/{key}/transitions",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "unlinkPageWorkItem": {
    method: "DELETE",
    path: "/api/v1/pages/{pageId}/work-items/{workItemId}",
    permission: "page:edit",
    successStatus: 200,
    responseComponent: "PageLinkPair",
  },
  "updateFolder": {
    method: "PATCH",
    path: "/api/v1/folders/{folderId}",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "Folder",
  },
  "updatePage": {
    method: "PATCH",
    path: "/api/v1/pages/{pageId}",
    permission: "page:edit",
    successStatus: 200,
    responseComponent: "Page",
  },
  "updateSprint": {
    method: "PATCH",
    path: "/api/v1/sprints/{sprintId}",
    permission: "sprint:manage",
    successStatus: 200,
    responseComponent: "Sprint",
  },
  "updateWorkItem": {
    method: "PATCH",
    path: "/api/v1/work-items/{key}",
    permission: "work_item:edit",
    successStatus: 200,
    responseComponent: "WorkItemDetail",
  },
  "uploadWorkItemAttachment": {
    method: "POST",
    path: "/api/v1/work-items/{key}/attachments",
    permission: "work_item:edit",
    successStatus: 201,
    responseComponent: "Attachment",
  },
} as const satisfies Record<string, V1OperationRow>;

/** The `operationId`s, as a union. */
export type V1OperationId = keyof typeof V1_OPERATIONS;
