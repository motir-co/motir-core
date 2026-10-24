/**
 * Types for the precompiled Ajv validators.
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

/** One error Ajv reports. `instancePath` is the field the CLI names. */
export interface ValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message?: string;
  readonly params: Record<string, unknown>;
}

/** A precompiled validator: a type guard carrying its own errors. */
export interface ValidateFunction {
  (data: unknown): boolean;
  errors?: ValidationError[] | null;
}

/** Validators for each operation's 2xx response body, keyed by operationId. */
export declare const operation_appendDispatchRunEvents: ValidateFunction;
export declare const operation_appendPlanTurn: ValidateFunction;
export declare const operation_approveWorkItemPlan: ValidateFunction;
export declare const operation_archiveWorkItem: ValidateFunction;
export declare const operation_claimScope: ValidateFunction;
export declare const operation_claimWorkItem: ValidateFunction;
export declare const operation_claimWorkItemContinue: ValidateFunction;
export declare const operation_claimWorkItemRepair: ValidateFunction;
export declare const operation_closeDispatchRun: ValidateFunction;
export declare const operation_completeSession: ValidateFunction;
export declare const operation_completeSprint: ValidateFunction;
export declare const operation_countProjectWorkItems: ValidateFunction;
export declare const operation_createFolder: ValidateFunction;
export declare const operation_createPage: ValidateFunction;
export declare const operation_createSprint: ValidateFunction;
export declare const operation_createWorkItem: ValidateFunction;
export declare const operation_createWorkItemComment: ValidateFunction;
export declare const operation_createWorkItemLink: ValidateFunction;
export declare const operation_deleteFolder: ValidateFunction;
export declare const operation_getDispatchRun: ValidateFunction;
export declare const operation_getDispatchRunCloseOutPrompt: ValidateFunction;
export declare const operation_getFolder: ValidateFunction;
export declare const operation_getMe: ValidateFunction;
export declare const operation_getPage: ValidateFunction;
export declare const operation_getPlan: ValidateFunction;
export declare const operation_getPlanStatus: ValidateFunction;
export declare const operation_getProject: ValidateFunction;
export declare const operation_getProjectBacklog: ValidateFunction;
export declare const operation_getProjectReadyBugs: ValidateFunction;
export declare const operation_getProjectReadyContainers: ValidateFunction;
export declare const operation_getProjectReadyLeaves: ValidateFunction;
export declare const operation_getSectionSets: ValidateFunction;
export declare const operation_getSprint: ValidateFunction;
export declare const operation_getWorkItem: ValidateFunction;
export declare const operation_getWorkItemActivity: ValidateFunction;
export declare const operation_getWorkItemApprovalGate: ValidateFunction;
export declare const operation_getWorkItemDesign: ValidateFunction;
export declare const operation_getWorkItemDispatchPrompt: ValidateFunction;
export declare const operation_getWorkItemHowToTest: ValidateFunction;
export declare const operation_getWorkItemPlan: ValidateFunction;
export declare const operation_getWorkItemReviewPrompt: ValidateFunction;
export declare const operation_issueDispatchRunGitCredentials: ValidateFunction;
export declare const operation_linkWorkItemPullRequest: ValidateFunction;
export declare const operation_listFolders: ValidateFunction;
export declare const operation_listProjectDesigns: ValidateFunction;
export declare const operation_listProjectRepositories: ValidateFunction;
export declare const operation_listProjectSprints: ValidateFunction;
export declare const operation_listProjectWorkItems: ValidateFunction;
export declare const operation_listProjects: ValidateFunction;
export declare const operation_listSprintWorkItems: ValidateFunction;
export declare const operation_listWorkItemComments: ValidateFunction;
export declare const operation_listWorkItemDesigns: ValidateFunction;
export declare const operation_listWorkItemLinks: ValidateFunction;
export declare const operation_listWorkItemTransitions: ValidateFunction;
export declare const operation_listWorkspaces: ValidateFunction;
export declare const operation_movePage: ValidateFunction;
export declare const operation_moveWorkItemsToBacklog: ValidateFunction;
export declare const operation_moveWorkItemsToSprint: ValidateFunction;
export declare const operation_openDispatchRun: ValidateFunction;
export declare const operation_openPlanSession: ValidateFunction;
export declare const operation_recordDispatchRunDiscrepancy: ValidateFunction;
export declare const operation_recordWorkItemIntegration: ValidateFunction;
export declare const operation_reportDispatchRunStop: ValidateFunction;
export declare const operation_reportDispatchRunUnbuildable: ValidateFunction;
export declare const operation_reportWorkItemImplementation: ValidateFunction;
export declare const operation_restoreWorkItem: ValidateFunction;
export declare const operation_startSprint: ValidateFunction;
export declare const operation_submitPlanSession: ValidateFunction;
export declare const operation_submitWorkItemAgentReview: ValidateFunction;
export declare const operation_submitWorkItemExpansion: ValidateFunction;
export declare const operation_transitionWorkItem: ValidateFunction;
export declare const operation_updateFolder: ValidateFunction;
export declare const operation_updatePage: ValidateFunction;
export declare const operation_updateSprint: ValidateFunction;
export declare const operation_updateWorkItem: ValidateFunction;
export declare const operation_uploadWorkItemAttachment: ValidateFunction;
