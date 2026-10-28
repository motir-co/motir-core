import { isWorkspaceOrgClosing } from '@/lib/organizations/closingGuard';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { TREE_LEVEL_MAX_TAKE } from '@/lib/planning/levelCaps';
import {
  Prisma,
  type WorkItem,
  type WorkItemKind,
  type WorkItemLink,
  type WorkItemPriority,
  type ApprovalGateKind,
  type ProjectAccessMode,
} from '@/generated/prisma/client';
import {
  astHasEpic5Conditions,
  collectFilterReferentIds,
  resolveFilterAst,
  type CustomFieldFilterType,
  type ProjectFilterCustomField,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import type { FilterAst } from '@/lib/filters/ast';
import { customFieldOptionRepository } from '@/lib/repositories/customFieldOptionRepository';
import {
  assertValidParent,
  assertValidPlacement,
  allowedParentKinds,
  type IssueType,
} from '@/lib/issues/parentRules';
import { isTypeableKind, resolveExecutor } from '@/lib/issues/executorDefaults';
import {
  canCarryObsolescence,
  isReopenHeldByMark,
  isWorkItemObsolescence,
} from '@/lib/issues/obsolescence';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { promoteIfCiAlreadyGreen } from './ciPromotion';
import { repoSetCompletionService } from './repoSetCompletionService';
import {
  workItemRepository,
  type WorkItemCreateInput,
  type WorkItemUpdateInput,
} from '@/lib/repositories/workItemRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { labelRepository } from '@/lib/repositories/labelRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { componentRepository } from '@/lib/repositories/componentRepository';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { estimationService } from '@/lib/services/estimationService';
import { workItemComponentRepository } from '@/lib/repositories/workItemComponentRepository';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { countableReviewsAtHead, type CountableReview } from '@/lib/approvalGates/reviewVerdict';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import type { GithubPullRequestWithContext } from '@/lib/repositories/githubPullRequestRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { assessArtifactEvidence, requiresArtifactEvidence } from '@/lib/workItems/artifactEvidence';
import { isStatusTransitionRefusal } from '@/lib/workItems/statusTransitionRefusals';
import {
  CONTAINER_CLAIM_STATUS_KEYS,
  RUNG_RANK,
  childrenBelowClaimBar,
  rankOfStatus,
  withdrawsPendingQuestion,
} from '@/lib/workItems/statusLadder';
import {
  IN_REVIEW_STATUS_KEY,
  reconcileAcceptanceOwnerOf,
  reconcileGatesFor,
  withdrawMergeQuestionOffReview,
} from '@/lib/services/gateSetFor';
import { choiceBodyOf, choiceGateService } from '@/lib/services/choiceGateService';
import { decisionConfirmationGateService } from '@/lib/services/decisionConfirmationGateService';
import { manualWorkGateService } from '@/lib/services/manualWorkGateService';
import { asksTheConfirmQuestion } from '@/lib/approvalGates/decisionConfirmationHandler';
import { handlerFor, isRegisteredGateKind } from '@/lib/approvalGates/registry';
import { APPROVED_STATUS_KEY, heldMoves } from '@/lib/approvalGates/heldMoves';
import { withdrawQuestionsOnArchive } from '@/lib/approvalGates/withdrawOnArchive';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planTargetLockService, readPlanHoldWithin } from '@/lib/services/planTargetLockService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestApprovalMembersService } from '@/lib/services/pullRequestApprovalMembersService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { watchersService } from '@/lib/services/watchersService';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { parseMentionIds } from '@/lib/mentions/parse';
import { autoRelateWorkItemMentions, writeWorkItemLink } from '@/lib/workItems/autoRelateMentions';
import { embeddingDocumentChanged } from '@/lib/workItems/embeddingDocument';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { extractReferencedAttachmentIdsFromBodies } from '@/lib/blob/referencedUrls';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { automationFieldsFromDiffKeys } from '@/lib/automation/fields';
import { keyForAppend, keyBetween } from '@/lib/workItems/positioning';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { toFolderTreeRowDto, toRoadmapFolderDto } from '@/lib/mappers/folderMappers';
import type { TreeFolderLevel } from '@/lib/repositories/workItemRepository';
import {
  CrossProjectFolderError,
  FolderNotFoundError,
  PlacementConflictError,
} from '@/lib/folders/errors';
import type { FileWorkItemInput, FileWorkItemResultDto } from '@/lib/dto/folders';
import {
  QUICK_SEARCH_DEFAULT_LIMIT,
  QUICK_SEARCH_MAX_LIMIT,
  QUICK_SEARCH_MIN_QUERY_LENGTH,
} from '@/lib/workItems/quickSearch';
import { relationshipStorage, relationshipToLink } from '@/lib/workItems/linkRelationships';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { readMembership } from '@/lib/workspaces/membershipGate';
import { isMotirSystemUser } from '@/lib/ai/systemPrincipal';
import { readProject, readWorkItem } from '@/lib/workspaces/tenantRead';
import { personName } from '@/lib/people/personLabel';
import { visitorServiceContext, type VisitorReadContext } from '@/lib/visitor/context';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import {
  isVisitorContext,
  openVisitorRead,
  redactPageRefLabels,
  redactWithheldWorkItemRefs,
  stripPrivateEpicTells,
} from '@/lib/visitor/readScope';
import {
  CANCELLED_STATUS_KEY,
  MOTIR_SEED_BURST_END,
  addToProvenanceBucket,
  classifyProvenance,
  emptyProvenanceBucket,
  type ProvenanceBackfillReport,
} from '@/lib/workItems/provenanceBackfill';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  ContainerHasOpenChildrenError,
  ApprovalGatePendingError,
  PlanTargetHeldError,
  NoInitialStatusError,
  ReporterNotInWorkspaceError,
  NotEpicError,
  StaleWorkItemError,
  TypeNotAllowedOnKindError,
  DifficultyNotAllowedOnKindError,
  InvalidObsolescenceError,
  MarkedCardCannotReopenError,
  ObsolescenceRequiresFinishedError,
  UnknownStatusError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { WorkItemLinkNotFoundError } from '@/lib/workItems/linkErrors';
import { crossLevelEdgeFindings } from '@/lib/workItems/edgeLevel';
import {
  uncoveredCrossParentEdges,
  type CoverageNodeInfo,
} from '@/lib/workItems/crossParentCoverage';
import { edgeDisposition } from '@/lib/workItems/edgeDisposition';
import { ComponentNotFoundError, CrossProjectComponentError } from '@/lib/components/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';
import { validateStoryPoints } from '@/lib/estimation/validate';
import { readerTranslationContextService } from '@/lib/services/readerTranslationContextService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import {
  toWorkItemDto,
  toWorkItemMentionCandidateDto,
  toWorkItemRefAssigneeDto,
  toWorkItemSummaryDto,
  toWorkItemSubtreeDto,
  toWorkItemTreeNodeDto,
  toRoadmapNodeDto,
  toWorkItemListItemDto,
  toWorkItemTreeRowDto,
  toArchivedWorkItemDto,
  toWorkItemRepositoryDtos,
} from '@/lib/mappers/workItemMappers';
import { toWorkItemLinkDto } from '@/lib/mappers/workItemLinkMappers';
import { toQuickViewData } from '@/lib/mappers/quickViewMappers';
import { toFixDetailDto } from '@/lib/mappers/fixReasonMappers';
import { toLinkedPullRequestDto, toWorkItemDeliveryDto } from '@/lib/mappers/githubMappers';
import { standingMergeRefusals, standingQueueFailures } from './deliveryVerdict';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { amendRepoDeliveryWithSet } from '@/lib/workItems/deliverySet';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { Locale } from '@/lib/i18n/locales';
import { toLabelDto } from '@/lib/mappers/labelMappers';
import { toComponentDto } from '@/lib/mappers/componentMappers';
import { toCustomFieldWithValueDto } from '@/lib/mappers/customFieldValueMappers';
import { toWorkItemRevisionDto } from '@/lib/mappers/workItemRevisionMappers';
import type {
  WorkItemForestRow,
  WorkItemTreeRow,
  RepoIssueFilter,
  ReadyCandidateRow,
  ReadyContainerShapeRow,
  ReadyLayerRow,
} from '@/lib/repositories/workItemRepository';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
// The PUBLIC API's page ceiling (ADR §5), imported rather than re-declared so the
// number a client is promised and the number the service enforces cannot drift.
import { MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import type { IssueSort } from '@/lib/issues/issueListView';
import type {
  ExpansionNudge,
  ReadyContainerDto,
  ReadyItemDto,
  ReadyItemDispatchDto,
  ReadyLaneCountsDto,
} from '@/lib/dto/ready';
import type { ClaimActorDto, WorkItemClaimDto } from '@/lib/dto/claim';
import {
  IN_PROGRESS_STATUS_CATEGORY,
  IN_PROGRESS_STATUS_KEY,
  isClaimableState,
  refusedClaimOutcome,
} from '@/lib/workItems/claimOutcome';
import {
  toReadyContainerDto,
  toReadyItemDto,
  toReadyItemDispatchDto,
  type ReadyItemContext,
  type ReadyDispatchContext,
} from '@/lib/mappers/readyMappers';
import {
  type ReadyListFilter,
  type ReadyContainersFilter,
  type ReadyCursor,
  clampReadyLimit,
  decodeReadyCursor,
  encodeReadyCursor,
  InvalidReadyFilterError,
  SPRINT_ACTIVE,
  compareReadyPosition,
  decodeReadyLaneCursor,
  encodeReadyLaneCursor,
  groupByContainer,
  groupRank,
  isBugWork,
  isRunnableContainer,
  type ReadyGroupPosition,
  type ReadyLane,
  type ReadyLaneCursor,
} from '@/lib/workItems/readyFilter';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import type {
  CompleteSessionItemResultDto,
  CompleteSessionResultDto,
  CreateWorkItemInput,
  ExecutorDto,
  IssueDetailDto,
  ProjectTreeFilter,
  ReadinessVerdictDto,
  RelationshipLinkDto,
  RelationshipLinkGroups,
  UpdateWorkItemInput,
  WorkItemDeletePreviewDto,
  WorkItemDependencyEdgesDto,
  WorkItemDto,
  WorkItemEdgeSummaryDto,
  WorkItemKindDto,
  WorkItemLineageDto,
  PlanningAnchorLineageDto,
  WorkItemTypeDto,
  WorkItemDifficultyDto,
  WorkItemObsolescenceDto,
  PagedIssueListDto,
  WorkItemKeysetItemDto,
  PagedArchivedWorkItemsDto,
  WorkItemRevisionDto,
  WorkItemMentionCandidateDto,
  WorkItemSummaryDto,
  WorkItemRefMap,
  WorkItemSubtreeDto,
  WorkItemTreeNodeDto,
  TreeLevelDto,
  ProjectRoadmapDto,
  RoadmapEdgeDto,
  WorkItemValidityDto,
  WorkItemSoftBlockDto,
  WorkItemCoverageAdvisoryDto,
  WorkItemTitleCoverageAdvisoryDto,
  WorkItemProseAdvisoryDto,
  CrossLevelEdgeDto,
  InvalidEdgeDto,
  WorkItemImplementationProvenanceInput,
  WorkItemRepositoryDto,
  WorkItemPlacementDto,
  WorkItemTreeRowDto,
  WorkItemLanguageField,
} from '@/lib/dto/workItems';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import {
  assertWriteLanguage,
  hasText,
  resolveWriteLanguage,
  toOrgContentLanguage,
} from '@/lib/workItems/contentLanguage';
import type { PermissionKey } from '@/lib/permissions/catalog';
import {
  buildProseVsGraphAdvisories,
  type ProseAdvisorySubject,
} from '@/lib/services/proseGraphAdvisoryService';
import { buildPathReferenceAdvisories } from '@/lib/services/pathReferenceAdvisoryService';
import { containerCoverageFinding, unnamedTitleWords } from '@/lib/workItems/containerCoverage';
import { acceptanceCriteriaTexts } from '@/lib/workItems/proseVsGraph';
import { sectionFindingsFor } from '@/lib/workItems/sections/validity';
import {
  distinctAssigneeIds,
  resolveWorkItemRefSummaries,
} from '@/lib/workItems/resolveWorkItemRefs';
import { parseWorkItemRefs, type WorkItemRefs } from '@/lib/mentions/workItemRefs';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { syncBodyPageLinks } from '@/lib/workItems/bodyPageLinks';
import { parsePageTokenIds } from '@/lib/mentions/pageRefs';
import { pagesService } from '@/lib/services/pagesService';
import type { SprintBlockerDto, ValidityCondition } from '@/lib/dto/sprints';
import { DEFAULT_VALIDITY_CONDITION } from '@/lib/dto/sprints';
import { gatingItemSatisfied } from '@/lib/workItems/validity';
import type { StatusCategoryDto, WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  LinkWorkItemsInput,
  RelationshipKind,
  WorkItemLinkDto,
} from '@/lib/dto/workItemLinks';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  classifyBlockerReadiness,
  isOpenBlocker,
  type BlockerReadinessState,
} from '@/lib/workItems/blockerReadiness';
import {
  resolveAuthoredRepoPinsInProject,
  resolveAuthoredRepoRefsInProject,
  resolveAuthoredTargetRepoInProject,
  listDispatchRepoNames,
  resolveDispatchRepoForItem,
  resolveItemDispatchPin,
  type ResolvedRepoPins,
} from '@/lib/workItems/dispatchRepo';
import {
  assertSingleTargetRepoInput,
  primaryTargetRepo,
  resolveDispatchRepo,
  type ResolvedDispatchRepo,
} from '@/lib/workItems/targetRepo';
import { classifyRepoDelivery, type RepoDelivery } from '@/lib/workItems/repoDelivery';
import { resolveExpectedRepos } from '@/lib/workItems/expectedRepos';
import { ContainerRepoSetNotWritableError } from '@/lib/workItems/errors';
import { resolveSectionsInput } from '@/lib/plans/applySectionsInput';
import {
  InvalidSectionsError,
  SectionsWithDescriptionError,
} from '@/lib/workItems/sections/errors';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { runTokenScopeService } from '@/lib/services/runTokenScopeService';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';
import { writeDerivedRepoSet, writeRepoRefs } from '@/lib/workItems/repoSetWrites';
import { recomputeWorkItemFixReason } from './fixReasonService';
import { recomputeWorkItemResumeState } from './resumeStateService';
import { fixGroupPointersFor, fixHeadKeysFor } from './fixGroupService';

// ⚠️ `assertSingleTargetRepoInput` MOVED to `lib/workItems/targetRepo.ts`
// (MOTIR-4904) and is imported above. It was private here while this was the only
// door that could express a repository SET; the PROPOSAL door can now express one
// too, and one rule with two copies is how the two doors would come to disagree
// about what a contradiction is. The contract is unchanged.

/** A validated single pin, as the one-element set it means (`null` → `[]`). The
 *  bridge that lets every existing caller — which sends only the scalar — write a
 *  valid set without knowing the set exists. */
function toRepoSet(pin: string | null): string[] {
  return pin === null ? [] : [pin];
}

/**
 * Recompute the DERIVED repository set of every ANCESTOR of `itemId` (Story
 * MOTIR-2732 · MOTIR-2978, ADR "Amendment 2026-08-18" §A6).
 *
 * A container never authors its repositories — they are the union of its
 * non-archived leaf descendants' — so every write that can move a leaf's set, or
 * move a leaf, owes this call inside its own transaction.
 *
 * **Locked, and this is the part that is not optional.** A rollup is a
 * read-derive-write over a row several children can move at once: two children of
 * one story updated concurrently each derive the parent, and the later write can
 * be derived from a snapshot taken before the earlier one landed — a lost update
 * that leaves a repository off the parent silently. So each ancestor's row is
 * locked (`SELECT … FOR UPDATE`) BEFORE its descendants are read, and the
 * descendants are re-read under that lock rather than taken from the caller's
 * snapshot (`CLAUDE.md`'s lock-before-read-derived-update rule, named by §A6
 * because MOTIR-2978's AC 3 asserts the outcome without prescribing the means).
 *
 * Ancestors arrive ROOT→self from `findAncestors` and are locked in that order,
 * which is what stops two concurrent recomputes on overlapping chains from
 * deadlocking: every caller takes the same rows in the same direction.
 *
 * The walk is naturally short — the tree is depth-capped at 4 — so this is a
 * fixed-length parent walk, not an unbounded recursion.
 */
async function recomputeAncestorRepoSets(
  itemId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const ancestors = await workItemRepository.findAncestors(itemId, workspaceId, tx);
  for (const ancestor of ancestors) {
    await workItemRepository.lockById(ancestor.id, tx);
    const refs = await workItemRepoRepository.listDerivedRefsForContainer(
      ancestor.id,
      workspaceId,
      tx,
    );
    await writeDerivedRepoSet(ancestor.id, workspaceId, refs, tx);
  }
}

/**
 * Recompute a CONTAINER's own derived set and then its ancestors' — the shape
 * every MOVE needs (MOTIR-2978, §A6).
 *
 * A re-parent, an archive and a delete each change TWO chains: the one the item
 * joined and the one it left. `recomputeAncestorRepoSets` covers the chain from
 * an item upward; the chain it LEFT starts at the old parent, which is itself a
 * container whose set just changed — so that side needs the old parent included,
 * not merely walked past.
 *
 * A container that is now childless derives the EMPTY set, which is correct and
 * not a special case: an empty set and "this card does not say where it ships"
 * are one state (ADR §1).
 */
async function recomputeContainerAndAncestors(
  containerId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await workItemRepository.lockById(containerId, tx);
  const refs = await workItemRepoRepository.listDerivedRefsForContainer(
    containerId,
    workspaceId,
    tx,
  );
  await writeDerivedRepoSet(containerId, workspaceId, refs, tx);
  await recomputeAncestorRepoSets(containerId, workspaceId, tx);
}

/** Ordered list equality — a REORDER counts as a change, because element 0 is the
 *  primary dispatch routes to, so `[a, b]` and `[b, a]` are different decisions. */
function sameRepoSet(next: readonly string[], current: readonly string[]): boolean {
  return next.length === current.length && next.every((r, i) => r === current[i]);
}

// Work-items service — the business-logic surface Epic 2's route handlers
// call (Subtask 1.4.4). It owns every $transaction for the work-item +
// work-item-link domains, maps Prisma rows to DTOs, asserts membership /
// parent / workspace invariants with friendly typed errors AHEAD of the DB
// triggers (defense-in-depth: a friendlier error here, the trigger as the
// structural backstop), and records a revision call atomically with each
// write (the row's STORAGE lands in 1.4.6 — see workItemRevisionsService).
//
// Layer rules (CLAUDE.md): NO raw Prisma here — every DB touch goes through
// workItemRepository / workItemLinkRepository / projectRepository /
// workspaceMembershipRepository, with `tx` threaded into every write inside
// the enclosing transaction. The GUC the future work-item RLS policy (1.4.5)
// reads is bound by upstream middleware before any method runs; service
// methods trust the ServiceContext and never re-set it.

// The service-layer kind-parent pre-flight is `assertValidParent` from
// lib/issues/parentRules.ts — the single source of truth for the kind-parent
// matrix (Subtask 2.1.2). It throws a friendly IllegalParentTypeError ahead of
// the DB trigger (prisma/sql/work_item_triggers.sql · enforce_work_item_kind_parent),
// which remains the structural backstop. This service used to carry a private
// `ALLOWED_PARENT_KINDS` copy of the matrix; 2.1.2 removed it so the rule lives
// in exactly one place. `WorkItemKind` and `parentRules`' `IssueType` are the
// same string union, so the kinds read off rows pass straight through.
// Convention at the call sites: assertValidParent(parentKind, childKind) — a
// null parent is top-level placement.

/**
 * Membership gate — distinct typed error per role so routes map them apart.
 *
 * MOTIR-2527: both read through `readMembership`, which binds the GUCs the
 * `membership_visible_active_or_own` policy reads. `tx` is OPTIONAL and deliberately
 * NOT threaded from `updateWorkItem`'s transaction: that one is a bare
 * `db.$transaction` binding no GUCs, so handing it over would reproduce exactly the
 * false denial being fixed. Omitting it lets the gate open its own bound read.
 */
async function assertReporterMember(
  userId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const m = await readMembership(userId, workspaceId, tx);
  // The Motir system account reports into any workspace by identity, with no
  // membership row (MOTIR-9329). Called with the ACTOR only, so it never lets a
  // person attribute their write to Motir.
  if (!m && !(await isMotirSystemUser(userId, tx))) throw new ReporterNotInWorkspaceError();
}

async function assertAssigneeMember(
  userId: string,
  workspaceId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const m = await readMembership(userId, workspaceId, tx);
  if (!m) throw new AssigneeNotInWorkspaceError();
}

/**
 * Leaf-only enforcement for `type` / `executor` (Story 2.7 · the 2.7.2 ADR).
 * `type` is the nature of EXECUTABLE work, so only the leaf kinds
 * (task / subtask / bug — `isTypeableKind`) may carry a type or executor;
 * epics + stories are containers. A single nullable column can't express this,
 * so the service is the PRIMARY guard (no DB-trigger backstop). Throws
 * `TypeNotAllowedOnKindError` (→ 422) when a non-typeable kind would end up
 * with a non-null type or executor; clearing both to null is legal on any kind.
 * Called with the EFFECTIVE post-write values so it catches both "set a type on
 * a story" and "convert a typed leaf into a story without clearing its type".
 */
function assertTypeKindConsistent(
  kind: WorkItemKindDto,
  type: WorkItemTypeDto | null,
  executor: ExecutorDto | null,
): void {
  if ((type !== null || executor !== null) && !isTypeableKind(kind)) {
    throw new TypeNotAllowedOnKindError(kind);
  }
}

/**
 * Leaf-only enforcement for `difficulty` (Story MOTIR-6016 · MOTIR-6096) — the
 * SAME `isTypeableKind` predicate as {@link assertTypeKindConsistent}, so every
 * leaf field agrees on which rows may carry it, but its own error code. Called
 * with the EFFECTIVE post-write values, so a kind change onto a container that
 * keeps a difficulty is refused exactly as setting one on a story is; clearing
 * it to null is legal on any kind.
 */
function assertDifficultyKindConsistent(
  kind: WorkItemKindDto,
  difficulty: WorkItemDifficultyDto | null,
): void {
  if (difficulty !== null && !isTypeableKind(kind)) {
    throw new DifficultyNotAllowedOnKindError(kind);
  }
}

const LANGUAGE_COLUMN = {
  title: 'titleLanguage',
  description: 'descriptionLanguage',
  explanation: 'explanationLanguage',
} as const satisfies Record<WorkItemLanguageField, keyof WorkItem>;

/** Refuse a language outside the eleven locales before anything is written (MOTIR-8096). */
function assertWorkItemLanguages(input: {
  language?: unknown;
  languages?: Partial<Record<WorkItemLanguageField, unknown>>;
}): void {
  assertWriteLanguage(input.language);
  for (const field of Object.keys(LANGUAGE_COLUMN) as WorkItemLanguageField[]) {
    assertWriteLanguage(input.languages?.[field]);
  }
}

/**
 * The language columns an UPDATE re-records (Story MOTIR-7731 · MOTIR-8096). A
 * field is re-recorded when its value changed, or when the patch carries it with
 * an explicit language for it; a field left empty records NULL. Every other
 * column is left out, so its stored value — NULL included — is untouched. The
 * org's language is read only when some field needs it.
 */
async function recordEditedLanguages(
  patch: Pick<UpdateWorkItemInput, 'language' | 'languages' | 'languageRecording'>,
  fields: Record<WorkItemLanguageField, { changed: boolean; value: string | null } | null>,
  current: Pick<WorkItem, 'workspaceId'>,
  tx: Prisma.TransactionClient,
): Promise<Partial<Record<(typeof LANGUAGE_COLUMN)[WorkItemLanguageField], Locale | null>>> {
  const out: Partial<Record<(typeof LANGUAGE_COLUMN)[WorkItemLanguageField], Locale | null>> = {};
  let orgLanguage: Locale | null = null;
  for (const field of Object.keys(LANGUAGE_COLUMN) as WorkItemLanguageField[]) {
    const f = fields[field];
    if (f === null) continue;
    const explicit = patch.languages?.[field] ?? patch.language;
    if (!f.changed && explicit === undefined) continue;
    if (!hasText(f.value) || patch.languageRecording === 'unrecorded') {
      out[LANGUAGE_COLUMN[field]] = null;
      continue;
    }
    orgLanguage ??= toOrgContentLanguage(
      await organizationRepository.findContentLanguageByWorkspaceId(current.workspaceId, tx),
    );
    out[LANGUAGE_COLUMN[field]] = resolveWriteLanguage(explicit, orgLanguage);
  }
  return out;
}

/**
 * Validate an OBSOLESCENCE value reaching the service (Story MOTIR-6574 ·
 * MOTIR-6579) — the enum-membership check. Deliberately no kind predicate (the
 * one difference from {@link assertDifficultyKindConsistent}): every kind may
 * carry a mark. The STATUS rule is separate and runs where the card's status is
 * known — {@link assertObsolescenceOnFinished} (MOTIR-6672): both marks are a
 * FINISHED card's state. `null` (clear) is always legal. A value outside the
 * closed enum throws {@link InvalidObsolescenceError} before any write, so
 * nothing is persisted.
 */
function assertObsolescence(value: unknown): WorkItemObsolescenceDto | null {
  if (value === null) return null;
  if (!isWorkItemObsolescence(value)) throw new InvalidObsolescenceError(value);
  return value;
}

/**
 * A mark SET on a card whose status sits outside the `done` category is refused
 * (Story MOTIR-6575 · MOTIR-6672): both marks are a FINISHED card's state, so a
 * card nobody will finish is archived, not marked. Call it only when the write
 * SETS a non-null mark — clearing is always legal, and a patch that leaves the
 * mark untouched is never refused. `statusCategory` is the CATEGORY the project's
 * own workflow gives the status (`canCarryObsolescence`), never a key.
 */
function assertObsolescenceOnFinished(args: {
  key: string;
  statusKey: string;
  statusCategory: StatusCategoryDto | null;
}): void {
  if (!canCarryObsolescence(args.statusCategory)) {
    throw new ObsolescenceRequiresFinishedError(args);
  }
}

/**
 * New work under a MARKED card is refused (Story MOTIR-6575 · MOTIR-6672): a
 * child created or re-parented beneath it re-opens it through status
 * derivation, and a marked card stays finished. Reuses the reopen refusal — the
 * story fixes TWO typed errors, and a new child IS a reopen. Filing into a
 * folder never reaches this: a folder has no status.
 */
function assertNotMarkedParent(
  parent: Pick<WorkItem, 'identifier' | 'obsolescence'>,
  childKey: string | null,
): void {
  if (parent.obsolescence == null) return;
  throw new MarkedCardCannotReopenError({
    key: parent.identifier,
    obsolescence: parent.obsolescence,
    toStatusKey: null,
    childKey,
  });
}

/** Stable, deterministic ordering for summary lists resolved via findByIds. */
function byKeyAsc(a: WorkItem, b: WorkItem): number {
  return a.key - b.key;
}

// ── Bounds for the AI plan-tree graph-traversal reads (Story 7.5) ──────────
// The DEPTH reads a planner walks must never turn into a whole-tree / whole-graph
// dump (finding #57 — the scale check). Each read is bounded, and the bound is
// CLAMPED here (never trusted from the wire): a subtree read is limited to
// `MAX_SUBTREE_DEPTH` descendant levels; the transitive is_blocked_by walk is
// capped at `MAX_BLOCKING_NODES` distinct nodes AND `MAX_BLOCKING_DEPTH` levels;
// the history window is capped at `HISTORY_PAGE_SIZE` per page. Defaults apply
// when the caller omits a bound (so an unbounded request reads a safe slice, not
// the whole graph).
export const DEFAULT_SUBTREE_DEPTH = 2;
export const MAX_SUBTREE_DEPTH = 10;
export const DEFAULT_BLOCKING_NODES = 200;
export const MAX_BLOCKING_NODES = 1000;
export const DEFAULT_BLOCKING_DEPTH = 25;
export const MAX_BLOCKING_DEPTH = 50;
export const HISTORY_PAGE_SIZE = 50;

/** Clamp `n` into `[lo, hi]`, falling back to `fallback` when it is not a finite
 *  number (an absent / malformed wire bound). Integer-floored. */
function clampBound(n: number | undefined, lo: number, hi: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Pair each resolved linked item (key-ASC) with the `work_item_link.id` of the
 * edge that points at it, so the 2.4.9 inline remove can target the exact link.
 * `endpoint` is which end of the edge holds the linked item: `toId` for OUT
 * edges (blocked-by / relates-to / duplicates / clones / supersedes), `fromId`
 * for the reverse IN edges (blocks, superseded-by). The (item, endpoint, kind) triple is unique, so the
 * map is 1:1.
 */
function toRelationshipLinks(
  links: ReadonlyArray<{ id: string; fromId: string; toId: string; reason?: string | null }>,
  rows: WorkItem[],
  endpoint: 'fromId' | 'toId',
): RelationshipLinkDto[] {
  const linkByItem = new Map(links.map((l) => [l[endpoint], l]));
  return rows.sort(byKeyAsc).map((r) => {
    const link = linkByItem.get(r.id);
    return {
      linkId: link?.id ?? '',
      item: toWorkItemSummaryDto(r),
      // The edge's reason (MOTIR-9827), only where it has one.
      ...(link?.reason ? { reason: link.reason } : {}),
    };
  });
}

/** The seven link-row batches of one item, before their far ends are resolved. */
type RelationshipLinkRows = {
  blockedByLinks: WorkItemLink[];
  blocksLinks: WorkItemLink[];
  relatesLinks: WorkItemLink[];
  duplicatesLinks: WorkItemLink[];
  clonesLinks: WorkItemLink[];
  supersedesLinks: WorkItemLink[];
  supersededByLinks: WorkItemLink[];
};

/** The far-end rows of {@link RelationshipLinkRows}, batch by batch. */
type RelationshipTargetRows = {
  blockerRows: WorkItem[];
  blockingRows: WorkItem[];
  relatesRows: WorkItem[];
  duplicatesRows: WorkItem[];
  clonesRows: WorkItem[];
  supersedesRows: WorkItem[];
  supersededByRows: WorkItem[];
};

/**
 * Phase 1 of the seven-group assembly: ONE query per group, never one per link.
 * `blocks` is the IN edge of `is_blocked_by` and `supersededBy` the IN edge of
 * `supersedes` (MOTIR-6580: `from` is the NEWER item), which is why those two
 * are the batches read `findByToItem`; the other five are OUT edges.
 *
 * Takes an already-bound `tx` so a caller can fold it into its own transaction
 * (the one-transaction-per-service-method shape,
 * `docs/decisions/bound-read-transaction-shape.md`).
 */
async function readRelationshipLinkRows(
  itemId: string,
  tx: Prisma.TransactionClient,
): Promise<RelationshipLinkRows> {
  return {
    blockedByLinks: await workItemLinkRepository.findByFromItem(itemId, 'is_blocked_by', tx),
    blocksLinks: await workItemLinkRepository.findByToItem(itemId, 'is_blocked_by', tx),
    relatesLinks: await workItemLinkRepository.findByFromItem(itemId, 'relates_to', tx),
    duplicatesLinks: await workItemLinkRepository.findByFromItem(itemId, 'duplicates', tx),
    clonesLinks: await workItemLinkRepository.findByFromItem(itemId, 'clones', tx),
    supersedesLinks: await workItemLinkRepository.findByFromItem(itemId, 'supersedes', tx),
    supersededByLinks: await workItemLinkRepository.findByToItem(itemId, 'supersedes', tx),
  };
}

/** Phase 2: resolve each batch's far end — seven batched `findByIds`, never one
 *  round trip per link. */
async function resolveRelationshipTargetRows(
  links: RelationshipLinkRows,
  tx: Prisma.TransactionClient,
): Promise<RelationshipTargetRows> {
  return {
    blockerRows: await workItemRepository.findByIds(
      links.blockedByLinks.map((l) => l.toId),
      tx,
    ),
    blockingRows: await workItemRepository.findByIds(
      links.blocksLinks.map((l) => l.fromId),
      tx,
    ),
    relatesRows: await workItemRepository.findByIds(
      links.relatesLinks.map((l) => l.toId),
      tx,
    ),
    duplicatesRows: await workItemRepository.findByIds(
      links.duplicatesLinks.map((l) => l.toId),
      tx,
    ),
    clonesRows: await workItemRepository.findByIds(
      links.clonesLinks.map((l) => l.toId),
      tx,
    ),
    supersedesRows: await workItemRepository.findByIds(
      links.supersedesLinks.map((l) => l.toId),
      tx,
    ),
    supersededByRows: await workItemRepository.findByIds(
      links.supersededByLinks.map((l) => l.fromId),
      tx,
    ),
  };
}

/** Phase 3: pair every resolved row with the edge that points at it. */
function toRelationshipGroups(
  links: RelationshipLinkRows,
  rows: RelationshipTargetRows,
): RelationshipLinkGroups {
  return {
    blockedBy: toRelationshipLinks(links.blockedByLinks, rows.blockerRows, 'toId'),
    blocks: toRelationshipLinks(links.blocksLinks, rows.blockingRows, 'fromId'),
    relatesTo: toRelationshipLinks(links.relatesLinks, rows.relatesRows, 'toId'),
    duplicates: toRelationshipLinks(links.duplicatesLinks, rows.duplicatesRows, 'toId'),
    clones: toRelationshipLinks(links.clonesLinks, rows.clonesRows, 'toId'),
    supersedes: toRelationshipLinks(links.supersedesLinks, rows.supersedesRows, 'toId'),
    supersededBy: toRelationshipLinks(links.supersededByLinks, rows.supersededByRows, 'fromId'),
  };
}

/**
 * Drop every far end that lives OUTSIDE `projectId`, before it is mapped.
 *
 * A relationship edge is a legitimate CROSS-PROJECT link in the UI, where the
 * viewer's own access decides what they see. A caller scoped to ONE project —
 * the AI boundary's job token — has no such latitude: the link is the one path
 * by which a read pinned to project A could name a row in project B.
 * `WorkItemSummaryDto` carries no `projectId`, so this runs on the ROWS.
 */
function keepRelationshipTargetsInProject(
  rows: RelationshipTargetRows,
  projectId: string,
  // A Visitor's private-epic exclusion (MOTIR-6652): a far end in it is dropped
  // exactly like one in another project — the edge and its count go with it.
  hidden?: ReadonlySet<string>,
): RelationshipTargetRows {
  const keep = (batch: WorkItem[]): WorkItem[] =>
    batch.filter((r) => r.projectId === projectId && !hidden?.has(r.id));
  return {
    blockerRows: keep(rows.blockerRows),
    blockingRows: keep(rows.blockingRows),
    relatesRows: keep(rows.relatesRows),
    duplicatesRows: keep(rows.duplicatesRows),
    clonesRows: keep(rows.clonesRows),
    supersedesRows: keep(rows.supersedesRows),
    supersededByRows: keep(rows.supersededByRows),
  };
}

/** A revision-diff cell. */
type DiffCell = { from: unknown; to: unknown };

/**
 * The initial-state diff for a freshly-created work item: every NON-NULL
 * field of the new row recorded as `{ from: null, to: <value> }` (the row had
 * no prior state, so `from` is always null). Null/absent fields are omitted —
 * an un-set descriptionMd doesn't appear. This is the created-revision shape
 * Subtask 1.4.4 deliberately deferred to 1.4.6 (the create call site passed
 * `diff: {}` with a "1.4.6's to finalize" note); finalized here. `dueDate` is
 * serialized to ISO (matching the update path); enums/scalars pass through.
 */
function buildCreatedDiff(row: WorkItem): Record<string, DiffCell> {
  const diff: Record<string, DiffCell> = {};
  const set = (k: string, v: unknown): void => {
    if (v !== null && v !== undefined) diff[k] = { from: null, to: v };
  };
  set('projectId', row.projectId);
  set('parentId', row.parentId);
  set('kind', row.kind);
  set('key', row.key);
  set('identifier', row.identifier);
  set('title', row.title);
  set('descriptionMd', row.descriptionMd);
  set('explanationMd', row.explanationMd);
  set('explanationSource', row.explanationSource);
  set('status', row.status);
  set('priority', row.priority);
  set('assigneeId', row.assigneeId);
  set('reporterId', row.reporterId);
  set('dueDate', row.dueDate ? row.dueDate.toISOString() : null);
  set('estimateMinutes', row.estimateMinutes);
  // Story points (Story 4.3 · exposed on create in 7.8.21): the `set` helper
  // skips null (unestimated), so a plain create's diff is unchanged. Recorded
  // numeric, not as the raw Prisma Decimal — matching `estimationService`'s
  // own revision shape (`{ from, to }` as Numbers).
  set('storyPoints', row.storyPoints === null ? null : Number(row.storyPoints));
  // Type + executor (Story 2.7): the `set` helper skips nulls, so an untyped
  // leaf / a container leaves the diff unchanged from pre-2.7; a typed create
  // records the chosen type + (seeded or explicit) executor.
  set('type', row.type);
  set('executor', row.executor);
  // Difficulty (Story MOTIR-6016): skipped when unset, so a create without one
  // leaves the diff exactly as it was.
  set('difficulty', row.difficulty);
  // The OBSOLESCENCE mark + note (Story MOTIR-6574): skipped when unset, so a
  // create without them leaves the diff exactly as it was.
  set('obsolescence', row.obsolescence);
  set('obsolescenceNoteMd', row.obsolescenceNoteMd);
  // The repo pin (Story 7.9 · MOTIR-1804): the `set` helper skips null, so an
  // unpinned create's diff is unchanged; a pinned create records the repo the
  // planner chose, which is exactly the "one subtask = one repo" decision a
  // reader of the History wants to see.
  set('targetRepo', row.targetRepo);
  // sprintId is null for a backlog create (the `set` helper skips nulls, so the
  // diff is unchanged from pre-4.2.2 for the common case); it is captured only
  // when the issue is born directly in a sprint (Subtask 4.2.2 create-into-
  // sprint), so the created revision records that assignment.
  set('sprintId', row.sprintId);
  // The folder an item is born filed in (MOTIR-5407); skipped when unfiled.
  set('folderId', row.folderId);
  set('position', row.position);
  return diff;
}

/**
 * The FILING step shared by `fileWorkItem` and `updateWorkItem`'s `folderId`
 * (Story MOTIR-5310 · MOTIR-5407) — resolve a folder placement against the
 * LOCKED current row, inside the caller's transaction, into the write and the
 * revision cells it owes. Returns `null` when the item already sits there.
 *
 * Filing sets `folderId`, clears `parentId` and appends the item after the
 * folder's last filed item; `null` takes it out to the root. The folder is
 * locked so a concurrent delete cannot land between the check and the write. A
 * missing (or other-workspace, which RLS hides) folder is `FolderNotFoundError`,
 * another project's is `CrossProjectFolderError`, and leaving a folder is
 * refused for a `kind` that may not be a root. The caller writes the row, the
 * revision, and the rollups / child-set event for the parent the item left.
 */
async function planFolderFiling(
  current: WorkItem,
  kind: IssueType,
  target: string | null,
  tx: Prisma.TransactionClient,
): Promise<{
  update: { folderId: string | null; parentId: null; position: string };
  diff: Record<string, DiffCell>;
} | null> {
  if (target === null) {
    if (current.folderId === null) return null;
    // Filed items carry no work-item parent, so leaving the folder leaves the
    // item a root — which a subtask may not be.
    assertValidPlacement({ parentKind: null, filed: false }, kind);
  } else {
    const folder = await folderRepository.lockById(target, tx);
    if (!folder) throw new FolderNotFoundError(target);
    if (folder.projectId !== current.projectId) throw new CrossProjectFolderError();
    if (current.folderId === target && current.parentId === null) return null;
  }

  const position = keyForAppend(
    await workItemRepository.findLastPositionAtFolderLevel(current.projectId, target, tx),
  );
  const diff: Record<string, DiffCell> = {
    folderId: { from: current.folderId, to: target },
    position: { from: current.position, to: position },
  };
  if (current.parentId !== null) diff.parentId = { from: current.parentId, to: null };
  return { update: { folderId: target, parentId: null, position }, diff };
}

export interface MoveWorkItemInput {
  /** Target parent. Omit to keep the current parent; `null` moves to top-level. */
  newParentId?: string | null;
  /** The sibling the moved item should sort AFTER (null → move to start). */
  beforeId?: string | null;
  /** The sibling the moved item should sort BEFORE (null → move to end). */
  afterId?: string | null;
}

export interface ListWorkItemsFilter {
  kind?: WorkItemKindDto;
  status?: string;
  assigneeId?: string | null;
}

/**
 * Nest a flat `findProjectForest` projection into the `WorkItemTreeNodeDto`
 * forest the `/items` tree-table renders (Subtask 2.5.1). Roots (parentId
 * null) and every sibling set are ordered by `key` asc — the stable PROD-N
 * order. Every non-root row's parent is guaranteed present (the CTE walks DOWN
 * from roots), so there are no dangling parents to drop.
 *
 * When `prune` is true (a filter is active) the tree is reduced to the
 * context-preserving set: a node is kept iff it `matched` OR has a kept
 * descendant — so a deep match drags its ancestor chain along (those ancestors
 * carry `matched: false` → rendered muted), while an unmatched leaf with no
 * matched descendants is dropped. This is the standard tree-filter that keeps
 * the result navigable, NOT a flat filter that would orphan children. `prune`
 * is false when no filter is active (every row is `matched` then anyway).
 * `hasChildren` falls out of the PRUNED child set (via the mapper), so a
 * chevron only shows when there is something left to expand.
 */
/**
 * Translate the wire-level `ProjectTreeFilter` into the repository filter shape
 * shared by the tree (`getProjectTree`) and List (`getProjectIssuesList`) reads.
 * Forwards only the NON-EMPTY axes (an absent/empty facet means "don't filter
 * on this axis"); a blank `text` quick-filter is treated as absent so trailing
 * whitespace never hides the whole project. `includeUnassigned` is forwarded
 * verbatim — the "Unassigned" bucket, OR-ed with any `assigneeIds`.
 */
function buildRepoFilter(
  filter: ProjectTreeFilter,
  filterReferents?: ProjectFilterReferents,
): RepoIssueFilter {
  const repoFilter: RepoIssueFilter = {};
  if (filter.kinds && filter.kinds.length > 0) repoFilter.kinds = filter.kinds;
  if (filter.types && filter.types.length > 0) repoFilter.types = filter.types;
  if (filter.includeUntyped) repoFilter.includeUntyped = true;
  if (filter.statuses && filter.statuses.length > 0) repoFilter.statuses = filter.statuses;
  if (filter.assigneeIds && filter.assigneeIds.length > 0) {
    repoFilter.assigneeIds = filter.assigneeIds;
  }
  if (filter.includeUnassigned) repoFilter.includeUnassigned = true;
  const text = filter.text?.trim();
  if (text) repoFilter.text = text;
  // The advanced-builder axis (Story 6.1 · 6.1.1): resolve at the service
  // boundary — typed FilterValidationErrors (→ 422 at the HTTP layer) on an
  // unknown field/operator id or a bad value; the repo compiler re-resolves
  // (defence in depth). Epic-5 conditions (6.1.2) resolve against the
  // referents `loadFilterReferents` fetched — stale referents are NOT errors
  // (they compile to match-nothing). An empty row set constrains nothing and
  // is dropped so it never activates tree pruning.
  if (filter.ast) {
    resolveFilterAst(filter.ast, filterReferents);
    if (filter.ast.conditions.length > 0) {
      repoFilter.ast = filter.ast;
      repoFilter.filterReferents = filterReferents;
    }
  }
  return repoFilter;
}

/**
 * Load the per-project referent set an AST's Epic-5 conditions (labels /
 * components / `cf:<fieldId>` custom fields, Subtask 6.1.2) resolve against:
 * BOUNDED reads over only the ids the filter actually references (finding
 * #57 — never load-all; the one exception is the definition list, already
 * capped at 50 by 5.3.2's service rule). Every read is tenancy-gated
 * (project + workspace), so a cross-tenant id resolves to nothing — and
 * therefore reads as a stale referent, exactly like a deleted one: the
 * condition matches nothing and surfaces the unknown-value notice instead of
 * erroring (the rule Story 6.2 saved filters depend on). Returns undefined
 * when the AST carries no Epic-5 condition (no reads spent). Exported for
 * the 6.1.4/6.1.5 page wiring, which resolves the same referents to render
 * the per-row stale notices.
 */
export async function loadFilterReferents(
  projectId: string,
  workspaceId: string,
  ast: FilterAst,
): Promise<ProjectFilterReferents | undefined> {
  if (!astHasEpic5Conditions(ast)) return undefined;
  const ids = collectFilterReferentIds(ast);
  // Five reads of five policy-gated tables, resolved together to decorate ONE
  // filter — so they share one bound transaction rather than five.
  const { definitions, options, labels, components, folders } = await withWorkspaceServiceContext(
    workspaceId,
    async (tx) => ({
      definitions:
        ids.customFieldIds.length > 0
          ? await customFieldDefinitionRepository.listByProject(projectId, workspaceId, tx)
          : [],
      options: await customFieldOptionRepository.findByIds(
        ids.customFieldValueIds,
        projectId,
        workspaceId,
        tx,
      ),
      labels: await labelRepository.findByIds(ids.labelIds, projectId, tx),
      components: await componentRepository.findByIds(ids.componentIds, tx),
      // The Folder field's value ids (MOTIR-5376) — bounded by the ids the
      // filter names (empty input reads nothing).
      folders: await folderRepository.findByIds(ids.folderIds, tx),
    }),
  );

  const customFields = new Map<string, ProjectFilterCustomField>();
  for (const def of definitions) {
    if (!ids.customFieldIds.includes(def.id)) continue;
    customFields.set(def.id, {
      fieldType: def.fieldType as CustomFieldFilterType,
      optionIds: new Set(options.filter((o) => o.fieldId === def.id).map((o) => o.id)),
    });
  }
  return {
    customFields,
    labelIds: new Set(labels.map((l) => l.id)),
    componentIds: new Set(
      components
        .filter((c) => c.projectId === projectId && c.workspaceId === workspaceId)
        .map((c) => c.id),
    ),
    // A folder of another project — or a deleted one — is absent, so its
    // condition reads as a stale value and matches nothing.
    folderIds: new Set(
      folders
        .filter((f) => f.projectId === projectId && f.workspaceId === workspaceId)
        .map((f) => f.id),
    ),
  };
}

/**
 * Where a work item's EFFECTIVE folder comes from (Story MOTIR-5309 · MOTIR-5375):
 * its own `folderId`, else its ROOT ancestor's. Only a root can carry a folder —
 * the CHECK `work_item_parent_xor_folder` keeps `parentId` and `folderId` apart —
 * so at most one of the two is non-null and no deeper ancestor is consulted.
 * `ancestorRows` is `findAncestors`' ROOT→self chain (item excluded), whose
 * `SELECT w.*` already carries the root's `folderId`.
 */
function effectivePlacementSource(
  itemFolderId: string | null,
  ancestorRows: readonly WorkItem[],
): { folderId: string; via: WorkItem | null } | null {
  if (itemFolderId !== null) return { folderId: itemFolderId, via: null };
  const root = ancestorRows[0];
  return root?.folderId ? { folderId: root.folderId, via: root } : null;
}

/** The effective folder's name path, root first — no read at all when no folder applies. */
async function readPlacementPath(
  itemFolderId: string | null,
  ancestorRows: readonly WorkItem[],
  tx: Prisma.TransactionClient,
): Promise<string[] | null> {
  const source = effectivePlacementSource(itemFolderId, ancestorRows);
  return source === null ? null : folderRepository.findPathNames(source.folderId, tx);
}

/**
 * The ONE placement mapper `getIssueDetail` and `getWorkItemPlacement` share, so
 * the page's first render and its re-read after a move cannot disagree.
 */
function toWorkItemPlacementDto(
  itemFolderId: string | null,
  ancestorRows: readonly WorkItem[],
  placementPath: string[] | null,
): WorkItemPlacementDto {
  const ancestors = ancestorRows.map(toWorkItemSummaryDto);
  const source = effectivePlacementSource(itemFolderId, ancestorRows);
  return {
    folderId: itemFolderId,
    parent: ancestors.at(-1) ?? null,
    ancestors,
    placementFolder:
      source === null || placementPath === null
        ? null
        : {
            folderId: source.folderId,
            path: placementPath,
            via: source.via === null ? null : toWorkItemSummaryDto(source.via),
          },
  };
}

/**
 * Clamp a requested v1 page size to `[1, MAX_PAGE_LIMIT]` (Story 11.2 ·
 * Subtask 11.2.3).
 *
 * Deliberately SEPARATE from {@link clampIssuePageSize}: the List's 50-row cap is
 * a Cloud performance bound on the offset pager and stays where it is, while the
 * public API's ceiling is 100 and is documented as such (ADR §5). The constant is
 * IMPORTED from the v1 pagination module rather than re-declared, because two
 * numbers that must agree are two numbers that eventually will not — and the one
 * a client is promised is the one in `parsePageRequest`.
 */
function clampV1PageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return MAX_PAGE_LIMIT;
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT);
}

/**
 * Clamp a requested list page size to `[1, ISSUE_LIST_PAGE_SIZE]`, defaulting
 * a missing / non-finite value to the full `ISSUE_LIST_PAGE_SIZE` (the
 * `clampLastN` convention — bad input degrades to the sensible bound, the cap
 * itself is never exceeded; the 6.3.2 filter-results widget's ≤50/page rule).
 */
function clampIssuePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return ISSUE_LIST_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), ISSUE_LIST_PAGE_SIZE);
}

/** True when the repo filter constrains at least one axis (drives forest pruning). */
function repoFilterIsActive(f: RepoIssueFilter): boolean {
  return (
    f.kinds !== undefined ||
    f.types !== undefined ||
    f.includeUntyped === true ||
    f.statuses !== undefined ||
    f.assigneeIds !== undefined ||
    f.includeUnassigned === true ||
    f.text !== undefined ||
    f.ast !== undefined
  );
}

function assembleProjectForest(
  rows: WorkItemForestRow[],
  prune: boolean,
  // A Visitor's forest (MOTIR-6644): a private epic's node is marked and its
  // sizing nulled; its withheld children never reached `rows`.
  visitor = false,
  // The To fix HEAD each carried card's tag names (MOTIR-7589) — empty for a Visitor.
  fixHeads: ReadonlyMap<string, string> = new Map(),
): WorkItemTreeNodeDto[] {
  const childrenByParent = new Map<string, WorkItemForestRow[]>();
  const roots: WorkItemForestRow[] = [];
  for (const row of rows) {
    if (row.parentId === null) {
      roots.push(row);
    } else {
      const group = childrenByParent.get(row.parentId);
      if (group) group.push(row);
      else childrenByParent.set(row.parentId, [row]);
    }
  }
  const byKey = (a: WorkItemForestRow, b: WorkItemForestRow): number => a.key - b.key;
  roots.sort(byKey);
  for (const group of childrenByParent.values()) group.sort(byKey);

  const build = (row: WorkItemForestRow): WorkItemTreeNodeDto | null => {
    const children: WorkItemTreeNodeDto[] = [];
    for (const child of childrenByParent.get(row.id) ?? []) {
      const node = build(child);
      if (node) children.push(node);
    }
    // Ancestor retention: drop only an unmatched node with no surviving child.
    if (prune && !row.matched && children.length === 0) return null;
    const head = fixHeads.get(row.id);
    const node = head
      ? { ...toWorkItemTreeNodeDto(row, children), fixHeadKey: head }
      : toWorkItemTreeNodeDto(row, children);
    return visitor ? stripPrivateEpicTells(node, row.publicChildrenHidden) : node;
  };

  const forest: WorkItemTreeNodeDto[] = [];
  for (const root of roots) {
    const node = build(root);
    if (node) forest.push(node);
  }
  return forest;
}

/**
 * The default terminal `cancelled` status — a category-`done` status that is a
 * sealed "won't do / duplicate", EXCLUDED from a roadmap progress meter's done
 * AND total counts (so a container whose only remnants are cancelled is not
 * held permanently incomplete). It is a PROTECTED default key (can't be
 * renamed / recategorised — `lib/workflows/defaultWorkflow.ts`), so the literal
 * is stable; a project's CUSTOM `done` statuses still count as done by category
 * (no project-specific cancel detection is attempted). Mirrors the public
 * roadmap's `ROADMAP_EXCLUDED_DONE_KEY` (publicProjectsService) and the offline
 * classifier's `CANCELLED_STATUS_KEY` (lib/workItems/provenanceBackfill.ts).
 *
 * Read by TWO consumers here, for the same reason: the roadmap meter below, and
 * `applyStatusTransition`'s manual-implementation stamp (MOTIR-2221) — abandoned
 * is not implemented, so neither counts a cancelled card as finished work.
 */
const ROADMAP_CANCELLED_KEY = 'cancelled';
/** The status a `manual_work` question does not survive a move into (MOTIR-8670). */
const MANUAL_WORK_NOT_READY_KEY = 'blocked';
/** The status an item enters to be reviewed — the one whose entry re-asks its
 *  pending questions (ADR `approval-gates.md` §6d AMENDMENT, rule 7). */
const REVIEW_STATUS_KEY = 'in_review';

/** The status keys that count as DONE on a roadmap meter: every `done`-category
 *  status except `cancelled`. */
function roadmapDoneStatusKeys(statuses: WorkflowStatusDto[]): Set<string> {
  return new Set(
    statuses
      .filter((s) => s.category === 'done' && s.key !== ROADMAP_CANCELLED_KEY)
      .map((s) => s.key),
  );
}

/** Default + max children fetched per lazy tree level (Subtask 2.5.13). The
 * design pins 50 per node; the max caps a forged `?take`.
 *
 * ⚠️ `TREE_LEVEL_MAX_TAKE` MOVED to `lib/planning/levelCaps.ts` (MOTIR-4024) and
 * is re-exported here so every existing reader is unchanged. It gained a second
 * reader on the other side of the wire — the plan detail's derived default view,
 * which runs in the client island — and a second copy of a cap is a number that
 * drifts silently. */
const TREE_LEVEL_PAGE_SIZE = 50;
/** The ceiling a roadmap level's "Show all" raises {@link TREE_LEVEL_MAX_TAKE} to
 *  (MOTIR-3490). Reached only when the reader has already been told the level is
 *  truncated and asked for the rest, so it trades one heavier read for the
 *  epics that were being dropped silently — but it is still a CEILING: past it
 *  the truncation tile shows again rather than the read growing without bound. */
const ROADMAP_LEVEL_ALL_TAKE = 2000;

/** Clamp the caller's paging into the safe range (a forged ?take/?offset can't
 * blow the read up). */
function clampTreePage(params: { take?: number; offset?: number }): {
  take: number;
  offset: number;
} {
  const take = Math.min(
    Math.max(1, Math.trunc(params.take ?? TREE_LEVEL_PAGE_SIZE)),
    TREE_LEVEL_MAX_TAKE,
  );
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  return { take, offset };
}

/** Turn a `take + 1` fetch + the level's total into one level page: `hasMore`
 * iff the extra row came back, then map the first `take` rows to DTOs. */
/**
 * The gate of a COLLECTION read a Visitor can reach (Story MOTIR-6170 ·
 * MOTIR-6644). A member's context runs the read's existing gate unchanged — the
 * project must resolve in their workspace (`ProjectNotFoundError` otherwise, no
 * existence leak), then `key` — and yields NO `excludeIds`, so the repository
 * reads its "no clause" exactly as before (`epic-privacy.md` §5: members
 * bypass). A Visitor's context is gated by {@link openVisitorRead} and yields the
 * private-epic exclusion set (§3).
 */
async function openCollectionRead(
  projectId: string,
  ctx: ServiceContext | VisitorReadContext,
  key: PermissionKey = 'project:browse',
): Promise<{ workspaceId: string; excludeIds?: readonly string[]; visitor: boolean }> {
  if (isVisitorContext(ctx)) return { ...openVisitorRead(projectId, ctx, key), visitor: true };
  const project = await readProject(projectId, ctx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  if (key === 'project:browse') await projectAccessService.assertCanBrowse(projectId, ctx);
  else await projectAccessService.assertPermission(projectId, ctx, key);
  return { workspaceId: project.workspaceId, visitor: false };
}

/** An item's two Markdown bodies as a Visitor reads them — withheld chips redacted (MOTIR-6652). */
function redactVisitorItem<
  T extends { descriptionMd: string | null; explanationMd: string | null },
>(dto: T, hidden: ReadonlySet<string>): T {
  return {
    ...dto,
    // Page chips keep their id and lose their label (MOTIR-7697): a Visitor
    // route serves no page, so no page title may ride the body.
    descriptionMd: redactPageRefLabels(redactWithheldWorkItemRefs(dto.descriptionMd, hidden)),
    explanationMd: redactPageRefLabels(redactWithheldWorkItemRefs(dto.explanationMd, hidden)),
  };
}

/** A lazy-tree row as a Visitor sees it — a private epic's tells stripped (§4). */
function toVisitorTreeRowDto(row: WorkItemTreeRow): WorkItemTreeRowDto {
  return stripPrivateEpicTells(toWorkItemTreeRowDto(row), row.publicChildrenHidden);
}

function buildTreeLevel(
  rows: WorkItemTreeRow[],
  take: number,
  total: number,
  visitor = false,
): TreeLevelDto {
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return { rows: page.map(visitor ? toVisitorTreeRowDto : toWorkItemTreeRowDto), hasMore, total };
}

/** One BAND of a folder-holding level: its full count, and a reader for a page inside it. */
interface LevelBand {
  total: number;
  read: (page: { take: number; offset: number }) => Promise<TreeLevelDto['rows']>;
}

/**
 * Serve ONE `take` / `offset` across a level's bands, in order. A band's count
 * is consumed before the next band's offset begins, so a page that straddles a
 * boundary takes the end of one band and the start of the next, and walking the
 * level page by page visits every row exactly once.
 */
async function pageAcrossBands(
  bands: LevelBand[],
  take: number,
  offset: number,
): Promise<TreeLevelDto['rows']> {
  const rows: TreeLevelDto['rows'] = [];
  let bandStart = 0;
  for (const band of bands) {
    const remaining = take - rows.length;
    if (remaining <= 0) break;
    const bandOffset = Math.max(0, offset - bandStart);
    if (bandOffset < band.total) {
      const page = await band.read({ take: remaining, offset: bandOffset });
      rows.push(...page.slice(0, remaining));
    }
    bandStart += band.total;
  }
  return rows;
}

/**
 * One page of a level that can hold FOLDERS — the project root, or one folder
 * (Story MOTIR-5308 · MOTIR-5314), read in BANDS:
 *
 *   * **inside a folder** — its child folders, by position, then its work items,
 *     by the active sort;
 *   * **at the project root** — its EPICS, by the active sort, then its folders,
 *     by position, then its OTHER work items, by the active sort (MOTIR-5550,
 *     `design/work-items/design-notes.md` § `/items` first run › Root order). The
 *     epics stay the project's first-order structure; a sort reorders inside the
 *     epic band and the work-item band, never across them, and never the folders.
 *
 * ⚠️ ONE `take` / `offset` RUNS ACROSS EVERY BAND ({@link pageAcrossBands}). At
 * the root, offset `o` is epic `o` while `o < E`, folder `o − E` while
 * `o < E + F`, and work item `o − E − F` after. `total` is the sum of the bands'
 * counts, each taken under the SAME predicate as its read, and `hasMore` follows
 * from it. `workItemTotal` is that sum without the folders — the input to the
 * /items first-run rule (MOTIR-5541).
 */
async function readFolderLevel(
  projectId: string,
  workspaceId: string,
  folderId: string | null,
  params: { sort: IssueSort; take?: number; offset?: number },
  // A Visitor's private-epic exclusion (MOTIR-6644) — absent for a member.
  excludeIds?: readonly string[],
): Promise<TreeLevelDto> {
  const { take, offset } = clampTreePage(params);
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const folderBand = async (): Promise<LevelBand> => ({
      total: await folderRepository.countLevel(projectId, workspaceId, folderId, tx),
      read: async (page) =>
        (await folderRepository.findLevel(projectId, workspaceId, folderId, page, tx)).map(
          toFolderTreeRowDto,
        ),
    });
    const itemBand = async (folderLevel: TreeFolderLevel): Promise<LevelBand> => ({
      total: await workItemRepository.countProjectTreeLevel(
        projectId,
        workspaceId,
        null,
        null,
        tx,
        undefined,
        folderLevel,
        excludeIds,
      ),
      read: async (page) =>
        (
          await workItemRepository.findProjectTreeLevel(
            projectId,
            workspaceId,
            null,
            params.sort,
            { ...page, excludeIds },
            null,
            tx,
            folderLevel,
          )
        ).map(excludeIds ? toVisitorTreeRowDto : toWorkItemTreeRowDto),
    });
    const folders = folderBand();
    const bands = await Promise.all(
      folderId === null
        ? [
            itemBand({ kind: 'excludeFiled', band: 'epics' }),
            folders,
            itemBand({ kind: 'excludeFiled', band: 'others' }),
          ]
        : [folders, itemBand({ kind: 'folder', folderId })],
    );
    const rows = await pageAcrossBands(bands, take, offset);
    const total = bands.reduce((sum, band) => sum + band.total, 0);
    const workItemTotal = total - (await folders).total;
    return { rows, hasMore: offset + rows.length < total, total, workItemTotal };
  });
}

/**
 * One parent's children for a VISITOR's lazy tree (MOTIR-6644). The parent must
 * be a live row of the Visitor's project and must not itself be withheld — a
 * hidden parent is the same `WorkItemNotFoundError` a missing one is, so its
 * id confirms nothing. A private epic's own level is EMPTY (its children are all
 * in the hidden set), which is what `epic-privacy.md` §4 asks of the drill.
 */
async function listVisitorChildIssues(
  parentId: string,
  params: { sort: IssueSort; take?: number; offset?: number },
  ctx: VisitorReadContext,
): Promise<TreeLevelDto> {
  const { workspaceId, excludeIds } = openVisitorRead(ctx.project.id, ctx);
  const projectId = ctx.project.id;
  const parent = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepository.findById(parentId, tx),
  );
  if (
    !parent ||
    parent.projectId !== projectId ||
    parent.archivedAt !== null ||
    ctx.hiddenIds.has(parent.id)
  ) {
    throw new WorkItemNotFoundError(parentId);
  }
  const { take, offset } = clampTreePage(params);
  const [rows, total] = await withWorkspaceServiceContext(workspaceId, (tx) =>
    Promise.all([
      workItemRepository.findProjectTreeLevel(
        projectId,
        workspaceId,
        parentId,
        params.sort,
        { take, offset, excludeIds },
        null,
        tx,
      ),
      workItemRepository.countProjectTreeLevel(
        projectId,
        workspaceId,
        parentId,
        null,
        tx,
        undefined,
        undefined,
        excludeIds,
      ),
    ]),
  );
  return buildTreeLevel(rows, take, total, true);
}

/**
 * The user ids a DESCRIPTION may validly mention — the members who can VIEW
 * the issue, exactly the commentsService scoping (the 6.4
 * `assignableMembersService` read, reused not duplicated). Reference data:
 * resolved OUTSIDE the write transaction (the member service binds its own
 * workspace context). Description mentions are notification-only (Subtask
 * 5.1.6) — no stored mention rows; the validated ids ride the post-commit
 * `work-item/mentioned` event and that's the whole substrate (recorded scope
 * line: the queryable substrate stays comment-scoped until a use case earns
 * more).
 */
/**
 * Assert the actor may BROWSE the project, answering a refusal as
 * `ProjectNotFoundError` (MOTIR-6319) — the no-existence-leak posture
 * `projectsService.resolveByKey` already takes: a project the actor cannot see is
 * indistinguishable from one that does not exist.
 */
async function assertBrowseAsNotFound(projectId: string, ctx: ServiceContext): Promise<void> {
  try {
    await projectAccessService.assertCanBrowse(projectId, ctx);
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) throw new ProjectNotFoundError(projectId);
    throw err;
  }
}

async function resolveDescriptionMentionable(
  projectId: string,
  accessMode: ProjectAccessMode,
  ctx: ServiceContext,
): Promise<Set<string>> {
  // Exactly the people who can ENTER the project (Story MOTIR-6169 · MOTIR-6547):
  // a mention of anyone else is dropped silently, the Jira rule.
  const members = await assignableMembersService.list({ projectId, accessMode, ctx });
  return new Set(members.map((m) => m.userId));
}

// The default-workflow status keys the integration tools target (Subtask
// 7.8.11). `mark_integrated` moves an item to `implemented` (MOTIR-3004 — built,
// pushed, waiting on CI; it used to say `in_review`); `complete_session`
// moves each recorded item to `done`. Both are the canonical default keys
// (lib/workflows/defaultWorkflow.ts). A project whose CUSTOM workflow lacks the
// key surfaces `UnknownStatusError` from the transition (mark_integrated → a tool
// error; complete_session → a per-item `failed` result) — the honest outcome
// rather than a silent miss.
/** Where an INTEGRATED item lands (MOTIR-3004): built, pushed onto the session
 *  branch, and waiting on CI. `mark_integrated` used to write `in_review`, which
 *  claimed a human should look at work nothing had compiled yet — In Review is
 *  now written by the CI-feedback consumer alone, on a green run (MOTIR-3006). */
const IMPLEMENTED_STATUS_KEY = 'implemented';
const DONE_STATUS_KEY = 'done';

// The claim VOCABULARY — the two category literals, the target status and the
// refusal classifier — moved to `lib/workItems/claimOutcome.ts` when MOTIR-3049
// added the SCOPE claim as a second caller. One encoding, imported by both.

/** A narrowing filter that keeps `Array.filter`'s result type honest. */
function isPresentId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * THE CI-GREEN LATCH (MOTIR-3006) — a card that ARRIVES at `implemented` asks
 * whether its build already went green, and promotes itself if it did.
 *
 * The run pushes BEFORE it transitions (MOTIR-3004), so on a fast pipeline the
 * green verdict lands while the card is still In Progress and the CI-side edge
 * finds nothing to promote. The verdict is durable — the check rows are
 * persisted — so this RE-READS it rather than queueing anything.
 *
 * ⚠️ BEST-EFFORT, POST-COMMIT, and never able to fail the transition it follows
 * (`notes.html` #39: a side effect after a durable write may never propagate an
 * error that fails it). A card left at `implemented` because this threw is a card
 * the next CI delivery promotes anyway.
 *
 * ⚠️ THE IMPORT IS STATIC, AND IT USED NOT TO BE. `ciPromotion` moves cards
 * through this very service, so the two modules form a cycle — which is safe
 * here because neither reads the other at MODULE-EVAL time (this service's
 * object literal is built from hoisted declarations; `ciPromotion`'s top level
 * is constants), and every use is inside a function body.
 *
 * It was a `await import('./ciPromotion')` for exactly one release, to avoid
 * closing that cycle. The E2E lane found the cost: Playwright's runner
 * transforms STATIC imports and hands a runtime `import()` specifier to Node,
 * which then loads the raw `.ts` and throws "Cannot use import statement outside
 * a module". The latch was therefore a silent no-op in every spec that moves a
 * card through the service directly (`provenance.spec.ts`, MOTIR-3009) — caught
 * by this function's own catch, logged, and invisible. A test harness that
 * disagrees with production about whether a feature runs is worse than the cycle
 * it was avoiding.
 */
async function latchCiGreen(
  workItemId: string,
  toStatusKey: string,
  ctx: ServiceContext,
): Promise<void> {
  if (toStatusKey !== 'implemented') return;
  try {
    await promoteIfCiAlreadyGreen(workItemId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    console.error('[workItemsService] the CI-green latch failed; the card stays implemented', {
      workItemId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Re-run the repository-SET completion gate after an edit CHANGED an item's
 * repository set (MOTIR-9235).
 *
 * The merge comment `changeRequestStatusSync` posts on a held card tells the
 * person to remove a repository the work does not ship in — and until this
 * existed, doing so changed nothing: the gate runs on a DELIVERY, and an edit is
 * not one, so the card waited for an operator to run
 * `pnpm db:reevaluate:repo-set` against production. This asks the same question
 * at the moment the answer changed, through the module that owns it, so no rule
 * is restated here: an empty set, an open linked pull request and an undecided
 * plan hold all still keep the item where it is.
 *
 * Returns the item as it stands afterwards — re-read only when it moved, so the
 * caller's answer names the status the edit led to rather than the one it left.
 *
 * ⚠️ BEST-EFFORT, POST-COMMIT, and never able to fail the edit it follows — the
 * same contract as `latchCiGreen` above: the set is already written, and an
 * item this misses is one the operator re-check still reaches.
 */
async function reevaluateRepoSetCompletion(
  dto: WorkItemDto,
  ctx: ServiceContext,
): Promise<WorkItemDto> {
  try {
    const verdict = await repoSetCompletionService.reevaluateItem(dto.id);
    if (verdict.outcome !== 'transitioned') return dto;
    const moved = await readWorkItem(dto.id, ctx);
    return moved ? toWorkItemDto(moved) : dto;
  } catch (err) {
    console.error('[workItemsService] the repository-set re-check failed; the item stays put', {
      workItemId: dto.id,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return dto;
  }
}

/**
 * The work items a newly-filed bug POINTS AT, in the order Q3 gives them
 * (MOTIR-3981, `run-findings-protocol.md` Q3/Q5).
 *
 * A `relates_to` target first — Q3 calls that link "the discovery trace", and
 * it names the work item the agent was actually working. The parent second, for
 * Q3's other arm: where the in-flight work item has no parent, the bug is
 * parented under the in-flight work item ITSELF, and then the parent is the
 * anchor.
 */
function candidateFindingAnchors(input: CreateWorkItemInput): string[] {
  const related = (input.links ?? [])
    .filter((l) => l.relationship === 'relates_to')
    .map((l) => l.targetId);
  return [...related, ...(input.parentId != null ? [input.parentId] : [])];
}

/**
 * Record a filed bug on the first candidate anchor that has an OPEN LEG.
 *
 * Every arm returns quietly. No candidate, no open leg on any of them, or a
 * finding this run already holds — all of them are the ordinary case, which is
 * a bug that belongs to no run. Most bugs do not.
 */
async function recordBugFiledFinding(
  bug: WorkItemDto,
  anchorIds: readonly string[],
  ctx: ServiceContext,
): Promise<void> {
  for (const anchorWorkItemId of anchorIds) {
    const { recorded } = await dispatchRunService.recordFinding(
      {
        anchorWorkItemId,
        kind: 'bug_filed',
        findingId: bug.id,
        // The POINTER, plus the one label a surface needs for a row it has not
        // fetched or may no longer be able to fetch. Never the description — a
        // finding's copy is a live row that gets re-titled and triaged, and a
        // record that froze it would show a reader something no longer true
        // while claiming, by being a log, that it is.
        data: { key: bug.identifier, workItemId: bug.id, title: bug.title },
      },
      ctx,
    );
    if (recorded) return;
  }
}

/**
 * WHAT EACH PULL REQUEST'S GITHUB REVIEW SAYS, for a page of Development rows (Story
 * MOTIR-4910 · MOTIR-5602; ADR §8 FOURTH AMENDMENT, decision 2).
 *
 * ⚠️ ONE QUERY FOR THE WHOLE PAGE, however many rows it has. It was two until the row's
 * chip was drawn without a reviewer (Yue, design review 2026-09-17): the identity and
 * membership lookups existed only to name a person the row no longer names, so they went
 * with the field. A per-row read would make rendering one card N round trips.
 *
 * ⚠️ THE RULE IS THE EVALUATOR'S, NOT A SECOND ONE. `countableReviewsAtHead` is the same
 * pure function that DECIDES the gate, so a row and the gate can never disagree about what
 * counts — which is exactly the disagreement a reader would report as a bug.
 */
async function readGithubReviewsForRows(
  rows: readonly GithubPullRequestWithContext[],
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<Map<string, LinkedPullRequestDto['githubReview']>> {
  const out = new Map<string, LinkedPullRequestDto['githubReview']>();
  if (rows.length === 0) return out;

  const reviews = await githubPullRequestReviewRepository.listForPullRequests(
    rows.map((row) => row.id),
    tx,
  );
  if (reviews.length === 0) return out;

  const byPullRequest = new Map<string, typeof reviews>();
  for (const review of reviews) {
    const list = byPullRequest.get(review.githubPullRequestId) ?? [];
    list.push(review);
    byPullRequest.set(review.githubPullRequestId, list);
  }

  for (const row of rows) {
    const rowReviews = byPullRequest.get(row.id);
    if (!rowReviews || rowReviews.length === 0) continue;

    // The row's CURRENT head, read the way the gate's own version reads it.
    const head = pullRequestHead(row);

    const decided = head ? pickReview(countableReviewsAtHead(rowReviews, head)) : null;
    if (decided) {
      out.set(row.id, {
        state: decided.state === 'changes_requested' ? 'changes_requested' : 'approved',
        atCurrentHead: true,
      });
      continue;
    }

    // Nothing counts at the head. A review at an EARLIER commit is still drawn, said to be
    // stale — the alternative reads as Motir having lost it (design § 23, Panel G2).
    const stale = pickReview(
      [...new Set(rowReviews.map((review) => review.commitSha))]
        .filter((sha) => sha !== head)
        .flatMap((sha) => countableReviewsAtHead(rowReviews, sha)),
    );
    if (stale) {
      out.set(row.id, {
        state: stale.state === 'changes_requested' ? 'changes_requested' : 'approved',
        atCurrentHead: false,
      });
    }
  }
  return out;
}

/** The ONE review a row shows: a countable `changes_requested` outranks an approval, and the
 *  latest of whichever wins is the one named — the row's own echo of the set rule's order. */
function pickReview(countable: readonly CountableReview[]): CountableReview | null {
  const newestFirst = (a: CountableReview, b: CountableReview) =>
    b.submittedAt.getTime() - a.submittedAt.getTime() ||
    b.githubReviewId.localeCompare(a.githubReviewId);
  const changes = countable.filter((r) => r.state === 'changes_requested').sort(newestFirst);
  if (changes.length > 0) return changes[0]!;
  const approvals = countable.filter((r) => r.state === 'approved').sort(newestFirst);
  return approvals[0] ?? null;
}

/**
 * RECONCILE A CHOICE'S QUESTION and walk it to review when one is raised (Story
 * MOTIR-4914 · MOTIR-5891; `approval-gates.md` §1's MOTIR-5887 amendment, point 3).
 * `choiceGateService` decides — raise, supersede, the declared-edge walk — and this
 * applies the walk through the ONE status funnel, which is why the walk lives
 * here and not in that module (it would import this one). Returns the item as it
 * now stands. Inside the caller's transaction and under its locks.
 */
async function reconcileChoiceGate(
  item: WorkItem,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const result = await choiceGateService.reconcile(item, tx);
  if (result.hopsToReview.length === 0) return item;
  // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES to the write that raised the
  // gate: the hops walk toward `in_review`, outside the done category, and a card
  // marked under the rule is `done` and holds no open question. Only a LEGACY card
  // marked while open can meet it, and the person writing is told to clear it.
  for (const key of result.hopsToReview) {
    await workItemsService.applyStatusTransition(item.id, key, ctx, tx);
  }
  return (await workItemRepository.findById(item.id, tx)) ?? item;
}

/**
 * RECONCILE A DECISION'S CONFIRM QUESTION and walk it to review when one is raised
 * (Story MOTIR-5871 · MOTIR-5954; `approval-gates.md` §1's MOTIR-5952 amendment,
 * point 4) — `reconcileChoiceGate`'s twin, for the same reason it lives here.
 */
async function reconcileDecisionGate(
  item: WorkItem,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const result = await decisionConfirmationGateService.reconcile(item, tx);
  if (result.hopsToReview.length === 0) return item;
  // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES to the write that raised the
  // gate: the hops walk toward `in_review`, outside the done category, and a card
  // marked under the rule is `done` and holds no open question. Only a LEGACY card
  // marked while open can meet it, and the person writing is told to clear it.
  for (const key of result.hopsToReview) {
    await workItemsService.applyStatusTransition(item.id, key, ctx, tx);
  }
  return (await workItemRepository.findById(item.id, tx)) ?? item;
}

/** What a caller may add to {@link workItemsService.createWorkItem} beyond the item. */
export interface CreateWorkItemOptions {
  /**
   * A write of the CALLER's own that must commit with the new item or not at all
   * (MOTIR-8512). It runs inside the create's transaction, after the item, its
   * links and its gates are written and before the commit, so a throw rolls the
   * whole create back — no item, no event. The post-commit events still fire only
   * after it returns. The monitor reconciler is the caller: it points its
   * `monitor_issue` row at the bug here, so a bug never exists without its link.
   */
  inTransaction?: (created: WorkItemDto, tx: Prisma.TransactionClient) => Promise<void>;
}

/**
 * The ONE place the sections-write rules are applied on the work-item doors
 * (Story MOTIR-9023 · MOTIR-9031). Returns the `descriptionMd` to write, or
 * throws before anything is written:
 *   · `sections` beside `descriptionMd` → `SectionsWithDescriptionError`;
 *   · a missing / unknown / invalid section for the FINAL kind × type →
 *     `InvalidSectionsError`, naming each.
 * On an update `currentBody` is the stored body, parsed and merged sparsely under
 * the row lock the caller already holds; on a create it is null. The plan doors
 * run the same resolution (`applySectionsInput`), so one partial `sections`
 * behaves alike on both families. Nothing structured is stored: the rendered text
 * is the only thing that is.
 */
function resolveSectionsWrite(args: {
  kind: string;
  type: string | null;
  sections: unknown;
  descriptionMd: string | null | undefined;
  currentBody: string | null;
}): string {
  if (args.descriptionMd !== undefined) throw new SectionsWithDescriptionError();
  const outcome = resolveSectionsInput({ ...args, label: 'work item' });
  if (outcome.ok) return outcome.body;
  if (outcome.reason === 'conflict') throw new SectionsWithDescriptionError();
  const findings: string[] = [];
  if (outcome.reason === 'sections') {
    if (outcome.missing.length > 0) findings.push(`missing: ${outcome.missing.join(', ')}`);
    if (outcome.unknown.length > 0) findings.push(`unknown: ${outcome.unknown.join(', ')}`);
    if (outcome.invalid.length > 0) {
      findings.push(
        `invalid: ${outcome.invalid.map((i) => `${i.section} (${i.message})`).join(', ')}`,
      );
    }
  }
  throw new InvalidSectionsError(
    findings.length > 0
      ? `sections refused — ${findings.join('; ')}. Read the section set for this kind and type with get_section_sets.`
      : `sections refused — ${outcome.detail}`,
    outcome.missing,
    outcome.unknown,
    outcome.invalid,
  );
}

export const workItemsService = {
  /**
   * Create a work item: allocate the per-project key + insert the row + emit
   * the initial revision, all in ONE transaction (the key allocation and the
   * insert MUST be atomic, so concurrent creates against the same project get
   * non-overlapping keys). Pre-flight (outside the tx): reporter and assignee
   * are workspace members, the parent (if any) is same-project and a
   * kind-legal parent. The work item's workspaceId is the project's — the
   * authoritative tenant of the row.
   */
  async createWorkItem(
    input: CreateWorkItemInput,
    ctx: ServiceContext,
    options: CreateWorkItemOptions = {},
  ): Promise<WorkItemDto> {
    assertWorkItemLanguages(input);
    // MOTIR-2569: the OPENING read is context-bound (`readProject`), and the
    // cross-workspace 404 is made EXPLICIT here rather than left to
    // `assertCanEdit` three lines down. Two reasons, and the second is the one
    // that matters. (a) Under the non-bypass role the bound read already hides a
    // foreign project, so without the check the two roles would disagree about
    // WHICH error a cross-tenant id produces. (b) Without it the actor learns,
    // from `ReporterNotInWorkspaceError`, that a project they cannot see EXISTS
    // in a workspace they are not in — an existence leak the resolveInputs gate
    // closes only for callers that reach it. The gates below are unchanged and
    // still run; this just refuses a foreign tenant in the same breath as a
    // missing one (finding #26).
    const project = await readProject(input.projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(input.projectId);
    }
    const workspaceId = project.workspaceId;

    // Workspace gate first (the project gate sits BENEATH it): the reporter
    // (the actor) must be a workspace member at all.
    await assertReporterMember(ctx.userId, workspaceId);

    // Project access gate (6.4.3): the actor must be allowed to EDIT this
    // project (open → any workspace member; limited/private → a member/admin
    // project member; workspace owner/admin always pass). Runs before the
    // key-allocation transaction — a denied create never burns a work-item key.
    await projectAccessService.assertCanEdit(input.projectId, ctx);

    if (input.assigneeId != null) {
      await assertAssigneeMember(input.assigneeId, workspaceId);
    }

    // Parent pre-flight: same project + kind-legal parent. Every rule here is
    // ALSO backstopped in the database — kind/depth/cycle since 1.4.2, and
    // cross-project / cross-workspace parenting since MOTIR-2895
    // (`enforce_work_item_parent_tenancy`, which the repository translates back
    // to this same `CrossProjectParentError`). This check stays because it is the
    // friendlier error and it runs before a key is burned, not because it is the
    // only thing standing behind the rule.
    //
    // A FOLDER is the other placement (MOTIR-5407): naming both is refused
    // outright, and a filed item may be any kind — the placement rule mirrors
    // the kind-parent trigger, which lets a subtask be a root when it is filed.
    // The folder itself is locked and checked inside the transaction below.
    const folderId = input.folderId ?? null;
    if (input.parentId != null && folderId !== null) throw new PlacementConflictError();
    if (input.parentId != null) {
      const parent = await readWorkItem(input.parentId, ctx);
      if (!parent) throw new WorkItemNotFoundError(input.parentId);
      if (parent.projectId !== input.projectId) throw new CrossProjectParentError();
      assertValidParent(parent.kind, input.kind);
      // A MARKED parent takes no new work (Story MOTIR-6575 · MOTIR-6672): a new
      // child re-opens its parent through status derivation, and a marked card
      // stays finished. Before the key-allocation transaction, so a refused
      // create never burns a key.
      assertNotMarkedParent(parent, null);
    } else {
      assertValidPlacement({ parentKind: null, filed: folderId !== null }, input.kind);
    }

    // Sprint pre-flight (Subtask 4.2.2 — create-into-sprint): when the caller
    // targets a sprint, it must exist in this workspace and belong to the SAME
    // project as the new issue — the same-project guard
    // `backlogService.assignToSprint` enforces, pulled to create time so a
    // quick-create into a sprint container is atomic (the issue is born already
    // assigned, in the one create transaction, never created-then-orphaned by a
    // failed follow-up assign). A foreign/unknown sprint → 404; a cross-project
    // sprint → 422. Checked before the key-allocation transaction so a denied
    // create never burns a work-item key.
    if (input.sprintId != null) {
      const sprint = await withWorkspaceServiceContext(workspaceId, (tx) =>
        sprintRepository.findById(input.sprintId as string, workspaceId, tx),
      );
      if (!sprint) throw new SprintNotFoundError(input.sprintId);
      if (sprint.projectId !== input.projectId) {
        throw new CrossProjectSprintAssignmentError('new', input.sprintId);
      }
    }

    // Component pre-flight (Subtask 5.4.3 — the create modal's Components
    // picker): every id must resolve to a component of the SAME project — an
    // unknown / cross-workspace id reads as 404 (no existence leak), a
    // same-workspace component from another project is the typed 422.
    // Checked before the key-allocation transaction (the sprint rule); the
    // join rows are written inside it.
    const componentIds = [...new Set(input.componentIds ?? [])];
    if (componentIds.length > 0) {
      const components = await withWorkspaceServiceContext(workspaceId, (tx) =>
        componentRepository.findByIds(componentIds, tx),
      );
      const componentsById = new Map(components.map((c) => [c.id, c]));
      for (const id of componentIds) {
        const component = componentsById.get(id);
        if (!component || component.workspaceId !== workspaceId) {
          throw new ComponentNotFoundError(id);
        }
        if (component.projectId !== input.projectId) throw new CrossProjectComponentError(id);
      }
    }

    // Type + executor (Story 2.7): leaf-only — a type/executor on an epic/story
    // is rejected here (no DB-trigger backstop). Executor is seeded from the
    // type→executor default when a type is supplied without one (seed-if-absent;
    // a new row's current executor is null). Validated BEFORE the key-allocation
    // transaction so a denied create never burns a work-item key.
    const itemType = input.type ?? null;
    const itemExecutor = resolveExecutor(itemType, input.executor, null);
    assertTypeKindConsistent(input.kind, itemType, itemExecutor);
    // Sections (Story MOTIR-9023 · MOTIR-9031): an agent's typed `sections` are
    // checked against the registry for THIS kind × type and rendered into the body
    // BEFORE the key-allocation transaction, so a refused write burns no key. A
    // write with no `sections` stores `descriptionMd` exactly as sent.
    const writtenDescriptionMd =
      input.sections !== undefined
        ? resolveSectionsWrite({
            kind: input.kind,
            type: itemType,
            sections: input.sections,
            descriptionMd: input.descriptionMd,
            currentBody: null,
          })
        : input.descriptionMd;
    // Difficulty (Story MOTIR-6016): leaf-only by the same kind rule, checked
    // before the key-allocation transaction for the same reason.
    const itemDifficulty = input.difficulty ?? null;
    assertDifficultyKindConsistent(input.kind, itemDifficulty);
    // Obsolescence (Story MOTIR-6574 · MOTIR-6579): enum membership ONLY — any
    // kind may carry it, so no kind predicate. Checked before the key-allocation
    // transaction so a refused value never burns a work-item key.
    const itemObsolescence = assertObsolescence(input.obsolescence ?? null);
    const itemObsolescenceNoteMd = input.obsolescenceNoteMd ?? null;

    // Story points (Story 4.3 · exposed on create in 7.8.21): validated with the
    // SAME shared rule the UI estimation path uses (finite, non-negative,
    // ≤ 9999.99, ≤ 2 decimals). Validated BEFORE the key-allocation transaction
    // so a malformed value never burns a work-item key. Omitted/null → the
    // column default (unestimated). Throws `InvalidEstimateError` (422).
    const storyPoints = validateStoryPoints(input.storyPoints ?? null);

    // Target repo (Story 7.9 · MOTIR-1804; project-scoped in MOTIR-1783):
    // normalize the authored value (bare name or `owner/name`) and validate it
    // against THIS PROJECT's repository set — else, for a project with no set,
    // the workspace's connected repos. BEFORE the key-allocation transaction for
    // two reasons — an unknown repo never burns a work-item key, AND the
    // resolver opens its OWN workspace context (the `project_repository` /
    // `github_repo` RLS policies are workspace-keyed), so it must not run nested
    // inside our transaction. Throws `UnknownTargetRepoError` (422);
    // omitted/null/blank → unpinned.
    //
    // The SET (Story MOTIR-2725 · MOTIR-2727, ADR §1 / §3.4) rides the same
    // pre-transaction slot for the same three reasons. `targetRepo` is the set's
    // PRIMARY — `targetRepos[0] ?? null` — so exactly ONE of the two fields may be
    // supplied; both is `ConflictingTargetRepoInputError` (422), never a silent
    // precedence rule that drops a repository the caller believed they recorded.
    //
    // ⚠️ The REFERENCE model (Story MOTIR-2732 · MOTIR-3039, ADR "Amendment
    // 2026-08-18"): whichever of the three fields arrives, resolution produces
    // BOTH the `project_repository` row ids — the AUTHORED state, written to
    // `work_item_repository` inside the transaction below — and the NAMES, which
    // the legacy columns carry as a DERIVED projection until §A7's contract step
    // retires them. One resolution, so the two can never name different
    // repositories; and `targetRepositories` joins the mutual exclusion rather
    // than layering a precedence rule over it.
    assertSingleTargetRepoInput(input.targetRepo, input.targetRepos, input.targetRepositories);
    const repoPins: ResolvedRepoPins =
      input.targetRepositories !== undefined
        ? await resolveAuthoredRepoRefsInProject(input.targetRepositories, input.projectId, ctx)
        : input.targetRepos !== undefined
          ? await resolveAuthoredRepoPinsInProject(input.targetRepos, input.projectId, ctx)
          : await resolveAuthoredRepoPinsInProject(
              toRepoSet(
                await resolveAuthoredTargetRepoInProject(input.targetRepo, input.projectId, ctx),
              ),
              input.projectId,
              ctx,
            );
    const targetRepos = repoPins.names;
    const targetRepo = primaryTargetRepo(targetRepos);

    // Initial status (Subtask 2.2.4): a new item lands in the project's
    // workflow initial status — there's no "from" status to validate against
    // on a brand-new row, so this bypasses transition validation. The pre-2.2.4
    // schema `@default("open")` no longer governs the created status; the
    // default now comes from the workflow's initial-status row (2.2.2 seeds
    // exactly one per project). A corrupt/missing seed is a server invariant
    // violation → NoInitialStatusError (500).
    const statusKey = await workflowsService.getInitialStatusKey(input.projectId, workspaceId);
    if (statusKey == null) throw new NoInitialStatusError(input.projectId);

    // A mark is a FINISHED card's state (Story MOTIR-6575 · MOTIR-6672): a new
    // item lands at the workflow's initial status, so a mark on create is legal
    // only when that status sits in the `done` category (a custom workflow can
    // make it so). Read the CATEGORY, never a key list. Before the key-allocation
    // transaction, so a refused create never burns a key.
    if (itemObsolescence !== null) {
      const initialStatus = await workflowsService.getStatusByKey(
        input.projectId,
        statusKey,
        workspaceId,
      );
      assertObsolescenceOnFinished({
        key: `The new ${input.kind}`,
        statusKey,
        statusCategory: initialStatus?.category ?? null,
      });
    }

    // Description mentions (Subtask 5.1.6): parse + view-validate BEFORE the
    // transaction (reference data, the commentsService pattern); invalid /
    // non-viewable ids are silently dropped (the Jira rule). The validated set
    // rides the post-commit `work-item/mentioned` event.
    const descTokenIds = parseMentionIds(writtenDescriptionMd ?? '');
    let descMentionIds: string[] = [];
    if (descTokenIds.length > 0) {
      const mentionable = await resolveDescriptionMentionable(
        input.projectId,
        project.accessMode,
        ctx,
      );
      descMentionIds = descTokenIds.filter((id) => mentionable.has(id));
    }

    // MOTIR-2569: the key-allocation transaction BINDS the workspace context.
    // It was a bare `db.$transaction`, so under the non-bypass role its very
    // first statement — `allocateWorkItemNumber`'s
    // `UPDATE "project" … RETURNING` — matched zero rows and threw
    // `ProjectNotFoundError` from the repository, AFTER both membership gates
    // had already admitted the actor. Fixing only the opening read would have
    // moved the failure four gates later without removing it, and the gate probe
    // in `tests/permissions/membershipGate.test.ts` cannot tell the two apart
    // (it classifies any `ProjectNotFoundError` as `blocked-before-gate`), so an
    // unbound transaction here would read as an unreached gate. `app.project_id`
    // is deliberately left unbound (empty): the reads inside are already
    // project-scoped by argument, and narrowing `work_item` would hide the
    // sibling/backlog boundary rows this transaction needs.
    const createContext = { userId: ctx.userId, workspaceId };
    const { dto, revisionId } = await withWorkspaceContext(createContext, async (tx) => {
      // §4 work-item cap (8.1.11): block BEFORE burning a key when the org is at
      // its free-tier ceiling. Org resolved UP from the workspace; the assert
      // locks the org row FOR UPDATE so concurrent creates serialize (inert
      // off-cloud / for a scaled org). A null org id (workspace unresolvable
      // under RLS) skips the cap rather than blocking a legitimate create.
      const capOrgId = await workspaceRepository.findOrganizationId(workspaceId, tx);
      if (capOrgId) await entitlementsService.assertWithinWorkItemCap(capOrgId, tx);
      // The folder the item is born in (MOTIR-5407), LOCKED so a concurrent
      // delete cannot remove it between this check and the insert. Under the
      // bound workspace context a folder in another workspace reads as missing.
      if (folderId !== null) {
        const folder = await folderRepository.lockById(folderId, tx);
        if (!folder) throw new FolderNotFoundError(folderId);
        if (folder.projectId !== input.projectId) throw new CrossProjectFolderError();
      }
      const key = await projectRepository.allocateWorkItemNumber(input.projectId, tx);
      // Build the identifier prefix from a FRESH in-tx read, NOT the pre-tx
      // `project` snapshot: a project key change (Story 6.8 `changeKey`) racing
      // this creation could have committed a new prefix after `project` was read
      // above. `allocateWorkItemNumber` UPDATEs (and thus row-locks) the project
      // row, so this read — and a concurrent `changeKey`'s `SELECT … FOR UPDATE`
      // on the same row — serialize: whichever grabs the lock first commits, and
      // the loser observes the winner's identifier. Without re-reading here, an
      // issue could be minted with the stale prefix mid-rename (the row the bulk
      // rewrite already passed), so the re-read is what makes the FOR-UPDATE lock
      // actually prevent a stale-prefix identifier.
      const refreshed = await projectRepository.findById(input.projectId, tx);
      /* istanbul ignore next -- allocateWorkItemNumber above already UPDATEd (and
         threw ProjectNotFoundError if absent), so the project always resolves here;
         the ?? guards a type-level null only and is never taken at runtime */
      const prefix = refreshed?.identifier ?? project.identifier;
      const identifier = `${prefix}-${key}`;

      // Normalize bare work-item refs in the markdown bodies to canonical link
      // tokens (bug MOTIR-1440): a bare `MOTIR-N` becomes `[MOTIR-N](motir:<id>)`
      // so it BOTH auto-relates (the hook below) AND renders as a chip (5.8.6),
      // instead of staying plain text. Resolved against the in-tx prefix. The
      // TITLE is plain text (no chip / no markdown), so it is left untouched —
      // its bare key still auto-relates and resolves to a peek-header link.
      const [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
        {
          projectId: input.projectId,
          projectIdentifier: prefix,
          fields: [writtenDescriptionMd, input.explanationMd],
        },
        tx,
      );

      // Append after the last sibling. Siblings are project-scoped and
      // parent-scoped (top-level when parentId is null) so the position only
      // orders true peers. A FILED item's peers are the folder's level.
      let lastPosition: string | null;
      if (folderId !== null) {
        lastPosition = await workItemRepository.findLastPositionAtFolderLevel(
          input.projectId,
          folderId,
          tx,
        );
      } else {
        const siblings = await workItemRepository.findSiblings(
          input.projectId,
          input.parentId ?? null,
          tx,
        );
        lastPosition = siblings.length ? siblings[siblings.length - 1]!.position : null;
      }
      const position = keyForAppend(lastPosition);

      // Global backlog rank (Subtask 4.1.4): a new issue is appended after the
      // current last rank of its STARTING scope, so the 4.1.1 backfill stays
      // total going forward and a fresh issue is never rank-less when the 4.2
      // backlog binds to it. SEPARATE ordering from `position` (which orders the
      // issue TREE under its parent) — this is the one global "Rank" the backlog
      // and a sprint share. The scope is the target sprint when creating
      // into one (Subtask 4.2.2), else the backlog (`sprintId IS NULL`); either
      // way a bounded boundary read, never a full scan.
      const targetSprintId = input.sprintId ?? null;
      const lastBacklogRank = await workItemRepository.findBoundaryBacklogRank(
        input.projectId,
        workspaceId,
        targetSprintId,
        'max',
        tx,
      );
      const backlogRank = keyForAppend(lastBacklogRank);

      // The at-create default-assignee rule (Subtask 5.4.3, the verified
      // Jira behaviour): an issue created with components and NO assignee
      // takes the default assignee of its FIRST-ALPHABETICAL component (by
      // nameLower) that has one — resolved inside the create transaction,
      // create-time only (later component changes never touch the
      // assignee). The default was validated assignable when the component
      // was configured; a deleted user is SetNull'd away. The one residual
      // gap — a default whose user has since LEFT the workspace — is
      // skipped silently (the SetNull intent: a departure never blocks a
      // create), keeping the assignee-membership invariant intact.
      let assigneeId = input.assigneeId ?? null;
      if (assigneeId === null && componentIds.length > 0) {
        const defaulted = await componentRepository.findFirstDefaultAssignee(componentIds, tx);
        if (defaulted?.defaultAssigneeId != null) {
          const stillMember = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
            defaulted.defaultAssigneeId,
            workspaceId,
            tx,
          );
          if (stillMember) assigneeId = defaulted.defaultAssigneeId;
        }
      }

      // The language each text field is written in (Story MOTIR-7731 ·
      // MOTIR-8096): explicit per field, else the call's, else the org's — read
      // here so the record and the write share one snapshot. An empty body
      // records NULL.
      const orgLanguage = toOrgContentLanguage(
        await organizationRepository.findContentLanguageByWorkspaceId(workspaceId, tx),
      );
      const langFor = (field: WorkItemLanguageField) =>
        input.languageRecording === 'unrecorded'
          ? null
          : resolveWriteLanguage(input.languages?.[field] ?? input.language, orgLanguage);

      const data: WorkItemCreateInput = {
        workspaceId,
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        folderId,
        kind: input.kind,
        key,
        identifier,
        title: input.title,
        descriptionMd: normalizedDescriptionMd ?? null,
        explanationMd: normalizedExplanationMd ?? null,
        titleLanguage: langFor('title'),
        descriptionLanguage: hasText(normalizedDescriptionMd) ? langFor('description') : null,
        explanationLanguage: hasText(normalizedExplanationMd) ? langFor('explanation') : null,
        status: statusKey,
        ...(input.explanationSource ? { explanationSource: input.explanationSource } : {}),
        // Work-item provenance (Story MOTIR-1685) — stamp the planning and/or
        // implementation triple when the caller supplies it (the stamper subtasks
        // set a server-side `source`). Omitted → all six columns stay null (the
        // no-op default; no behaviour change for existing callers). Same
        // optional-spread idiom as `explanationSource` above. See
        // docs/decisions/work-item-provenance.md.
        ...(input.provenance?.planning
          ? {
              planningSource: input.provenance.planning.source,
              planningHarness: input.provenance.planning.harness ?? null,
              planningModel: input.provenance.planning.model ?? null,
            }
          : {}),
        ...(input.provenance?.implementation
          ? {
              implementationSource: input.provenance.implementation.source,
              implementationHarness: input.provenance.implementation.harness ?? null,
              implementationModel: input.provenance.implementation.model ?? null,
            }
          : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        assigneeId,
        reporterId: ctx.userId,
        // Triage intake (Story 6.11 · Subtask 6.11.4): when the caller marks
        // this a triage submission, the item is born in the inbox —
        // `triagedAt` stamped now (the read-exclusion marker, 6.11.3) and
        // `submittedByUserId` recording the real submitter (a member, or — via
        // 6.12 — a signed-in non-member; DISTINCT from the `reporterId` above,
        // which stays a member). Omitted → a normal create (`triagedAt` NULL).
        ...(input.triage
          ? { triagedAt: new Date(), submittedByUserId: input.triage.submittedByUserId }
          : {}),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        estimateMinutes: input.estimateMinutes ?? null,
        // Story points (Story 4.3 · exposed on create in 7.8.21): the validated
        // value (null when omitted). Prisma accepts a number for the
        // Decimal(6, 2) column.
        storyPoints,
        // Work-item type + executor (Story 2.7) — leaf-only validated + executor
        // seeded above; nulls for an untyped leaf or a container kind.
        type: itemType,
        executor: itemExecutor,
        difficulty: itemDifficulty,
        // The OBSOLESCENCE mark + note (MOTIR-6579) — validated above; null when
        // omitted (an unmarked card).
        obsolescence: itemObsolescence,
        obsolescenceNoteMd: itemObsolescenceNoteMd,
        // The repo pin (Story 7.9 · MOTIR-1804) — validated above; null when the
        // caller didn't pin one (the dispatch payload resolves the default).
        targetRepo,
        targetRepos,
        sprintId: targetSprintId,
        position,
        backlogRank,
      };

      const row = await workItemRepository.create(data, tx);

      // The repository REFERENCES (MOTIR-3039), in the SAME transaction as the
      // row: an item and where it ships commit or roll back together. Empty for
      // an unpinned item, and empty for a project with no repository set — that
      // project's pin lives in `targetRepo` alone (§A7's compatibility rung).
      await writeRepoRefs(row.id, workspaceId, repoPins.refs, tx);

      // The container ROLLUP (MOTIR-2978, §A6): a new leaf can add a repository
      // its ancestors did not have, so every ancestor's derived set is recomputed
      // in the SAME transaction — an item and where its parents ship commit or
      // roll back together.
      await recomputeAncestorRepoSets(row.id, workspaceId, tx);

      // Page tags (MOTIR-7696): a `motir-page:` token in either birth body
      // derives its `description` / `explanation` link row in the SAME
      // transaction, so a created item is never tagged without its row.
      await syncBodyPageLinks(
        { id: row.id, workspaceId, projectId: input.projectId },
        { descriptionMd: row.descriptionMd, explanationMd: row.explanationMd },
        ctx.userId,
        tx,
      );

      // Initial revision: the created-row state as a { from: null, to: value }
      // diff (1.4.6 finalized the shape 1.4.4 deferred — see buildCreatedDiff).
      // Its id is the idempotency scope of any description-mention event below.
      const revisionId = await workItemRevisionsService.recordRevision(
        {
          workItemId: row.id,
          changedById: ctx.userId,
          changeKind: 'created',
          diff: buildCreatedDiff(row),
        },
        tx,
      );

      // Link-on-write (Subtask 5.2.3): editor uploads referenced by the
      // birth bodies link to the new issue in the SAME transaction (they were
      // written unlinked — the upload happened before the issue existed; a
      // cancelled modal leaves them unlinked for the 5.2.7 GC). No separate
      // revision: like the create-modal links above, attachments arriving
      // with the issue are part of creation, not a later edit — the
      // 'created' anchor is the History record.
      // Components picked in the create modal (Subtask 5.4.3), written in
      // the SAME transaction as the item (pre-validated same-project above —
      // issue + components commit or roll back together, the links rule).
      // Like links and birth attachments, they're part of creation, not a
      // later edit — no separate `{ components }` revision; the 'created'
      // anchor is the History record, and the defaulted assignee (if any)
      // rides the created-row diff.
      if (componentIds.length > 0) {
        await workItemComponentRepository.createMany(
          componentIds.map((componentId) => ({ workItemId: row.id, componentId })),
          tx,
        );
      }

      const birthIds = extractReferencedAttachmentIdsFromBodies([
        row.descriptionMd,
        row.explanationMd,
      ]);
      if (birthIds.length > 0) {
        await attachmentsService.syncEditorLinks(
          { workItem: row, previousIds: [], nextIds: birthIds },
          tx,
        );
      }

      // Links collected in the create modal (Subtask 2.4.10), written in the
      // SAME transaction as the item — so the issue + its links commit or roll
      // back together (a bad link aborts the whole create; the item is never
      // born half-linked). Each pending entry is a (relationship, target) pair;
      // the new row's id now exists, so `relationshipToLink` resolves the
      // directed edge (the single source of the `blocks` from/to flip). The DB
      // trigger backstops cycle/self-link/workspace-consistency at insert (the
      // repo translates them to typed errors); a missing or cross-workspace
      // target is pre-checked here for a precise typed error rather than a raw
      // FK violation. `relates_to` gets its reciprocal row, mirroring
      // linkWorkItems (1.4.4). The links ride in the created-row state, so no
      // separate link revision is recorded — they're part of creation, not a
      // later edit.
      if (input.links?.length) {
        for (const pending of input.links) {
          const target = await workItemRepository.findById(pending.targetId, tx);
          if (!target) throw new WorkItemNotFoundError(pending.targetId);
          // Same contract as `linkWorkItems` below: a target in another
          // workspace is NOT FOUND, never a distinguishable cross-workspace
          // error (MOTIR-2919). The whole create still rolls back.
          if (target.workspaceId !== workspaceId) throw new WorkItemNotFoundError(pending.targetId);

          const directed = relationshipToLink(pending.relationship, row.id, pending.targetId);
          // A cross-level `blocked_by` is written here too (MOTIR-6509): the
          // level rule is a validity verdict, never a refusal at a link door.
          await workItemLinkRepository.create(
            {
              workspaceId,
              fromId: directed.fromId,
              toId: directed.toId,
              kind: directed.kind,
              createdById: ctx.userId,
            },
            tx,
          );
          // A new card filed as BLOCKING an existing manual card takes that card's
          // question away (MOTIR-8670): the new card is unfinished by birth.
          if (directed.kind === 'is_blocked_by' && directed.fromId !== row.id) {
            await manualWorkGateService.withdrawIfNewBlockerOpen(
              directed.fromId,
              directed.toId,
              tx,
            );
          }

          if (directed.kind === 'relates_to') {
            const existingReciprocal = await workItemLinkRepository.findReciprocal(
              directed.toId,
              directed.fromId,
              'relates_to',
              tx,
            );
            if (!existingReciprocal) {
              await workItemLinkRepository.create(
                {
                  workspaceId,
                  fromId: directed.toId,
                  toId: directed.fromId,
                  kind: 'relates_to',
                  createdById: ctx.userId,
                },
                tx,
              );
            }
          }
        }
      }

      // Auto-watch (Subtask 5.4.4, the verified create rule, constant-on):
      // the creator watches the issue they created, in this SAME transaction
      // — born watched, or not born at all. Idempotent by the watcher unique;
      // writes NO revision (watching is not a field change). Story 5.7's
      // opt-out preference will live inside the hook, not here.
      await watchersService.autoWatch(row.id, ctx.userId, tx);

      // Auto-relate-on-mention (Subtask 5.8.3): any work-item reference in the
      // birth title / description / explanation auto-creates a `relates_to`
      // link (source = mention) to each viewable, same-workspace target — in
      // THIS transaction (a DB write, correctly in-tx). ADD-only, idempotent,
      // never throws out: an unresolved / cross-workspace / unviewable / self
      // reference is dropped silently. The title is read as plain text and each
      // body as Markdown, so a key quoted in code relates nothing (MOTIR-9825).
      // `prefix` is the in-tx project identifier.
      await autoRelateWorkItemMentions(
        {
          source: {
            id: row.id,
            workspaceId,
            projectId: input.projectId,
            projectIdentifier: prefix,
          },
          title: row.title,
          bodies: [row.descriptionMd, row.explanationMd],
          ctx,
        },
        tx,
      );

      // THE CHOICE QUESTION (Story MOTIR-4914 · MOTIR-5891) — AFTER the links, so a
      // choice born `blocked_by` something open is not asked until that lands.
      const choiceBorn = row.type === 'choice' ? await reconcileChoiceGate(row, ctx, tx) : row;
      // THE CONFIRM QUESTION (Story MOTIR-5871 · MOTIR-5954) — likewise after the links.
      const born = asksTheConfirmQuestion(choiceBorn)
        ? await reconcileDecisionGate(choiceBorn, ctx, tx)
        : choiceBorn;

      const bornDto = toWorkItemDto(born);
      // The caller's own write, joined to THIS transaction (MOTIR-8512): it
      // commits with the item or rolls it back.
      if (options.inTransaction) await options.inTransaction(bornDto, tx);
      return { dto: bornDto, revisionId };
    });

    // Post-commit, never inside the tx — a rollback must not have notified
    // (the commentsService rule). Only fires when the description validly
    // mentioned someone; the mentionNotify job skips the author + re-validates
    // view access at send time.
    if (descMentionIds.length > 0) {
      await sendEvent('work-item/mentioned', {
        workspaceId,
        workItemId: dto.id,
        revisionId,
        authorId: ctx.userId,
        mentionedUserIds: descMentionIds,
      });
    }

    // Automation `created` trigger (Story 6.6 · Subtask 6.6.2): every commit
    // emits the channel-agnostic create event the rule engine consumes. Stamps
    // provenance so a rule whose own action created the item can't loop (no
    // create action ships in 6.6.2, but the field rides through for a future
    // one).
    await sendEvent('work-item/created', {
      workspaceId,
      projectId: input.projectId,
      workItemId: dto.id,
      actorId: ctx.userId,
      ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      ...(ctx.viaMonitorConnectionId ? { viaMonitorConnectionId: ctx.viaMonitorConnectionId } : {}),
    });

    // Plan-tree embedding, CREATE trigger (Story MOTIR-2694 · MOTIR-2696, ADR
    // §6.3.1). Post-commit like everything above it, and for a sharper reason
    // than the notification events: embedding is an external call across the
    // open-core boundary, so it must never sit inside the write transaction (ADR
    // §6.3.2 / the repo's side-effects-outside-tx rule). Unconditional here —
    // every new item is a fresh document — and the job carries only the id,
    // because it re-reads the current text at run time (§6.3.3).
    await sendEvent('work-item/embedding.requested', {
      workspaceId,
      workItemId: dto.id,
    });

    // WHAT THE RUN PRODUCED (MOTIR-3981, `run-findings-protocol.md` Q5). A bug
    // filed while a dispatched agent's leg is open is a FINDING of that run,
    // and this is the only place the connection can be made: the agent files
    // over MCP and the key comes back on stdout the loop never captures, so the
    // CLI cannot report it. The service that performs the write records it.
    //
    // ⚠️ THE ANCHOR IS WHAT THE BUG POINTS AT, NOT THE BUG. A bug is a
    // brand-new row that no run ever claimed, so it has no leg of its own. What
    // ties it to a run is Q3's own rule: it is parented under the in-flight
    // work item's PARENT and `relates_to` the in-flight work item — "the parent
    // says where the bug LIVES, the link says where it was FOUND". So the
    // discovery trace is the anchor, and the parent is the fallback for Q3's
    // other arm (a work item with no parent takes the bug itself).
    //
    // Post-commit and best-effort, like the two sends above and for one more
    // reason on top: filing a bug is deliberately ADDITIVE (Q3 — it blocks
    // nothing, moves no status and does not end the run), so an append that
    // fails must not be able to undo it. `recordFinding` swallows its own
    // failures and is idempotent, which is what lets `linkWorkItems` reach the
    // same finding later without writing it twice.
    if (dto.kind === 'bug') {
      await recordBugFiledFinding(dto, candidateFindingAnchors(input), ctx);
    }

    return dto;
  },

  /**
   * Patch a work item. An empty patch (no fields supplied) is a no-op that
   * returns the current DTO WITHOUT opening a transaction or writing a
   * revision. Otherwise: lock the row, compute the diff (fields that actually
   * change), apply the explanation-source state machine, validate a re-parent,
   * write, and record one 'updated' revision — all in one transaction. A diff
   * that turns out empty (every supplied field already equals current) still
   * skips the write.
   */
  async updateWorkItem(
    id: string,
    patch: UpdateWorkItemInput,
    ctx: ServiceContext,
    opts: { expectedUpdatedAt?: string } = {},
  ): Promise<WorkItemDto> {
    const PATCH_KEYS: readonly (keyof UpdateWorkItemInput)[] = [
      'parentId',
      'folderId',
      'kind',
      'title',
      'descriptionMd',
      'sections',
      'explanationMd',
      'explanationSource',
      'assigneeId',
      'priority',
      'dueDate',
      'estimateMinutes',
      'storyPoints',
      'type',
      'executor',
      'difficulty',
      'obsolescence',
      'obsolescenceNoteMd',
      'targetRepo',
      'targetRepos',
      'targetRepositories',
    ];
    assertWorkItemLanguages(patch);
    const anyFieldProvided = PATCH_KEYS.some((k) => patch[k] !== undefined);
    if (!anyFieldProvided) {
      const current = await readWorkItem(id, ctx);
      if (!current) throw new WorkItemNotFoundError(id);
      // Even the empty-patch no-op is an edit entry point — gate it (6.4.3) so a
      // read-only actor can't probe an item through a write route.
      await projectAccessService.assertCanEdit(current.projectId, ctx);
      return toWorkItemDto(current);
    }

    // The two placements are exclusive (MOTIR-5407): a patch naming both a
    // work-item parent and a folder is ambiguous, and refused before the lock.
    if (patch.parentId !== undefined && patch.folderId !== undefined) {
      throw new PlacementConflictError();
    }

    // Story points (Story 4.3 · exposed on this patch in 7.8.21): validate the
    // supplied value with the SAME shared rule the UI estimation path uses,
    // BEFORE the transaction so a malformed value fails fast without taking the
    // row lock. `undefined` → leave untouched; an explicit `null` clears.
    // Throws `InvalidEstimateError` (422).
    const nextStoryPoints =
      patch.storyPoints !== undefined ? validateStoryPoints(patch.storyPoints) : undefined;

    // Obsolescence (Story MOTIR-6574 · MOTIR-6579): enum membership validated
    // BEFORE the transaction, so an unknown value fails fast and writes nothing.
    // `undefined` → leave untouched; `null` clears.
    const nextObsolescence =
      patch.obsolescence !== undefined ? assertObsolescence(patch.obsolescence) : undefined;

    // Target repo (Story 7.9 · MOTIR-1804; project-scoped in MOTIR-1783):
    // normalize + validate the pin against THIS ITEM's project repo set BEFORE
    // the transaction — the same rule create uses (the patch surface is never
    // looser), and the resolver opens its OWN workspace context, so it must not
    // run nested inside the row lock's transaction. `undefined` → leave
    // untouched; `null` / a blank string clears. The project is read here (not
    // taken from the locked row) precisely BECAUSE the validation cannot run
    // inside the lock; a concurrent re-parent cannot move an item across
    // projects (`CrossProjectParentError`), so the project this validates
    // against is the project the write lands in.
    //
    // The SET patches through the SAME slot, and the two fields are mutually
    // exclusive here exactly as they are on create (ADR §3.4). Whichever arrives,
    // BOTH columns are written together — the scalar is the set's primary and is
    // never left describing a different repository than element 0.
    //
    // ⚠️ The REFERENCE model (MOTIR-3039) patches through the same slot, and
    // `targetRepositories` joins the mutual exclusion as a THIRD arm. One
    // resolution yields the row ids (the authored state) and the names (the
    // derived projection), so a patch can never move one without the other.
    assertSingleTargetRepoInput(patch.targetRepo, patch.targetRepos, patch.targetRepositories);
    let nextRepoPins: ResolvedRepoPins | undefined;
    if (
      patch.targetRepo !== undefined ||
      patch.targetRepos !== undefined ||
      patch.targetRepositories !== undefined
    ) {
      const pre = await readWorkItem(id, ctx);
      if (!pre) throw new WorkItemNotFoundError(id);
      // A CONTAINER's repositories are DERIVED (MOTIR-2978, §A6) — the union of
      // its non-archived leaf descendants' — so a value supplied for one is
      // erased by the next recompute. REFUSED rather than ignored, on the same
      // reasoning §3.4 refuses a silent precedence rule: the dropped value is a
      // decision the caller believed they had recorded. Checked here, ahead of
      // the transaction, so a container write never takes the row lock.
      const children = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findChildren(id, tx),
      );
      if (children.length > 0) throw new ContainerRepoSetNotWritableError();
      nextRepoPins =
        patch.targetRepositories !== undefined
          ? await resolveAuthoredRepoRefsInProject(patch.targetRepositories, pre.projectId, ctx)
          : patch.targetRepos !== undefined
            ? await resolveAuthoredRepoPinsInProject(patch.targetRepos, pre.projectId, ctx)
            : await resolveAuthoredRepoPinsInProject(
                toRepoSet(
                  await resolveAuthoredTargetRepoInProject(patch.targetRepo, pre.projectId, ctx),
                ),
                pre.projectId,
                ctx,
              );
    }
    const nextTargetRepos: string[] | undefined = nextRepoPins?.names;
    const nextTargetRepo: string | null | undefined =
      nextTargetRepos === undefined ? undefined : primaryTargetRepo(nextTargetRepos);

    // Description mentions (Subtask 5.1.6): when the patch carries a body with
    // mention tokens, resolve the viewable-member set BEFORE the transaction
    // (reference data, the commentsService pattern). The added-mention DIFF is
    // computed INSIDE the tx against the locked current row — only ids the
    // previous body didn't already mention notify (the Jira edit rule).
    const patchDescTokenIds =
      typeof patch.descriptionMd === 'string' ? parseMentionIds(patch.descriptionMd) : [];
    let descMentionable: Set<string> | null = null;
    if (patchDescTokenIds.length > 0) {
      const pre = await readWorkItem(id, ctx);
      if (pre) {
        const project = await readProject(pre.projectId, ctx);
        if (project) {
          descMentionable = await resolveDescriptionMentionable(
            project.id,
            project.accessMode,
            ctx,
          );
        }
      }
    }

    const result = await withWorkspaceContext(ctx, async (tx) => {
      // Set where the references are rewritten below; read by the post-commit
      // repository-set completion re-check (MOTIR-9235).
      let repoRefsChanged = false;
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current) throw new WorkItemNotFoundError(id);

      // Project access gate (6.4.3): the actor must be allowed to edit this
      // item's project. Inside the tx so the gate reads share the lock's
      // snapshot + the RLS workspace context.
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

      // Optimistic concurrency (2.3.6): the edit form submits the `updatedAt`
      // it read at render; if the row moved since (someone else edited), reject
      // with a 409 the UI turns into a "refresh and retry" banner. Checked
      // under the FOR UPDATE lock so the compare-then-write is race-free.
      if (
        opts.expectedUpdatedAt !== undefined &&
        current.updatedAt.toISOString() !== opts.expectedUpdatedAt
      ) {
        throw new StaleWorkItemError();
      }

      // Normalize bare work-item refs in any EDITED body to canonical link
      // tokens (bug MOTIR-1440) BEFORE diffing — so the stored body chips
      // (5.8.6) instead of staying plain text, AND a re-save of an
      // already-canonical body stays a no-op (the normalize is idempotent).
      // Runs only when a body field is supplied; a field absent from the patch
      // stays `undefined`, preserving the "was it supplied?" guards below.
      //
      // Sections (Story MOTIR-9023 · MOTIR-9031): a patch carrying `sections` is
      // rendered HERE, under the lock, against the stored body and the card's
      // FINAL kind × type (the patched one when this write changes it). The check
      // and the render both finish before any write, so a refused write changes
      // nothing. The rendered text then flows through the same normalize / diff
      // path as a typed body. No `sections` → `patch.descriptionMd` as sent.
      const writtenDescriptionMd: string | null | undefined =
        patch.sections !== undefined
          ? resolveSectionsWrite({
              kind: patch.kind !== undefined ? patch.kind : current.kind,
              type: patch.type !== undefined ? patch.type : current.type,
              sections: patch.sections,
              descriptionMd: patch.descriptionMd,
              currentBody: current.descriptionMd,
            })
          : patch.descriptionMd;
      let normalizedDescriptionMd: string | null | undefined = writtenDescriptionMd;
      let normalizedExplanationMd: string | null | undefined = patch.explanationMd;
      if (writtenDescriptionMd !== undefined || patch.explanationMd !== undefined) {
        const refProject = await projectRepository.findById(current.projectId, tx);
        /* istanbul ignore else -- the project always resolves (it was read to gate
           the edit above); the guard narrows the nullable type only */
        if (refProject) {
          [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
            {
              projectId: current.projectId,
              projectIdentifier: refProject.identifier,
              fields: [writtenDescriptionMd, patch.explanationMd],
            },
            tx,
          );
        }
      }

      const update: WorkItemUpdateInput = {};
      const diff: Record<string, DiffCell> = {};

      // Plain scalar fields (string / nullable-string / number / enum):
      // include only when supplied AND different from current.
      if (patch.title !== undefined && patch.title !== current.title) {
        update.title = patch.title;
        diff.title = { from: current.title, to: patch.title };
      }
      let addedDescMentionIds: string[] = [];
      if (
        normalizedDescriptionMd !== undefined &&
        normalizedDescriptionMd !== current.descriptionMd
      ) {
        update.descriptionMd = normalizedDescriptionMd;
        diff.descriptionMd = { from: current.descriptionMd, to: normalizedDescriptionMd };
        if (patchDescTokenIds.length > 0 && descMentionable !== null) {
          const mentionable = descMentionable;
          const prevIds = new Set(parseMentionIds(current.descriptionMd ?? ''));
          addedDescMentionIds = patchDescTokenIds.filter(
            (tokenId) => !prevIds.has(tokenId) && mentionable.has(tokenId),
          );
        }
      }
      if (
        normalizedExplanationMd !== undefined &&
        normalizedExplanationMd !== current.explanationMd
      ) {
        update.explanationMd = normalizedExplanationMd;
        diff.explanationMd = { from: current.explanationMd, to: normalizedExplanationMd };
      }
      // Re-record a field's language only when THAT field is edited (Story
      // MOTIR-7731 · MOTIR-8096): its value changed, or the patch carries the
      // field together with an explicit language for it. A form that resubmits
      // every field must not re-label the ones nobody touched. Not part of the
      // revision diff — the language is a property of the text, not an edit.
      const languageUpdate = await recordEditedLanguages(
        patch,
        {
          title:
            patch.title !== undefined ? { changed: 'title' in update, value: patch.title } : null,
          description:
            normalizedDescriptionMd !== undefined
              ? { changed: 'descriptionMd' in update, value: normalizedDescriptionMd }
              : null,
          explanation:
            normalizedExplanationMd !== undefined
              ? { changed: 'explanationMd' in update, value: normalizedExplanationMd }
              : null,
        },
        current,
        tx,
      );
      Object.assign(update, languageUpdate);
      if (patch.priority !== undefined && patch.priority !== current.priority) {
        update.priority = patch.priority;
        diff.priority = { from: current.priority, to: patch.priority };
      }
      if (
        patch.estimateMinutes !== undefined &&
        patch.estimateMinutes !== current.estimateMinutes
      ) {
        update.estimateMinutes = patch.estimateMinutes;
        diff.estimateMinutes = { from: current.estimateMinutes, to: patch.estimateMinutes };
      }

      // Story points (Story 4.3 · exposed on this patch in 7.8.21): compare
      // NUMERICALLY — `current.storyPoints` is a Prisma Decimal, so coerce both
      // sides to Number before the change check, mirroring how
      // `estimationService.setEstimate` records its revision. Validated above
      // (pre-tx); `null` clears. The cell shares this one 'updated' revision
      // with every other field in the patch (atomic, single History entry).
      if (nextStoryPoints !== undefined) {
        const fromPoints = current.storyPoints === null ? null : Number(current.storyPoints);
        if (fromPoints !== nextStoryPoints) {
          update.storyPoints = nextStoryPoints;
          diff.storyPoints = { from: fromPoints, to: nextStoryPoints };
        }
      }

      // Target repo (Story 7.9 · MOTIR-1804): the normalized + validated value
      // from above (`undefined` = not supplied). Compare against the stored pin
      // so a re-save of the same repo stays a no-op and writes no revision.
      //
      // The SET (MOTIR-2727) is compared as an ORDERED list — a reorder is a real
      // change, because element 0 is what dispatch routes to. The two columns move
      // TOGETHER, always: the scalar is the set's primary, so writing one without
      // the other is what would turn a derived field into a second fact.
      if (nextTargetRepos !== undefined && !sameRepoSet(nextTargetRepos, current.targetRepos)) {
        update.targetRepos = nextTargetRepos;
        diff.targetRepos = { from: current.targetRepos, to: nextTargetRepos };
      }
      if (nextTargetRepo !== undefined && nextTargetRepo !== current.targetRepo) {
        update.targetRepo = nextTargetRepo;
        diff.targetRepo = { from: current.targetRepo, to: nextTargetRepo };
      }

      // Assignee: validate workspace membership on a change to a non-null
      // member; un-assign (null) skips the check.
      if (patch.assigneeId !== undefined && patch.assigneeId !== current.assigneeId) {
        if (patch.assigneeId !== null) {
          await assertAssigneeMember(patch.assigneeId, current.workspaceId);
        }
        update.assigneeId = patch.assigneeId;
        diff.assigneeId = { from: current.assigneeId, to: patch.assigneeId };
      }

      // Due date: compare by instant (Date vs ISO string), record ISO in diff.
      if (patch.dueDate !== undefined) {
        const newDate = patch.dueDate === null ? null : new Date(patch.dueDate);
        const currentMs = current.dueDate ? current.dueDate.getTime() : null;
        const newMs = newDate ? newDate.getTime() : null;
        if (currentMs !== newMs) {
          update.dueDate = newDate;
          diff.dueDate = {
            from: current.dueDate ? current.dueDate.toISOString() : null,
            to: newDate ? newDate.toISOString() : null,
          };
        }
      }

      // ── Explanation-source state machine ──────────────────────────────
      // When the patch CHANGES explanationMd and the current source is an
      // un-reviewed ai_draft, editing the explanation transitions the source
      // to user_edited — UNLESS the caller set explanationSource explicitly
      // (explicit always wins). The transition is captured in the diff so the
      // activity feed surfaces "AI draft → user edited".
      //
      // Gate on an ACTUAL change (`update.explanationMd` is set only when the
      // value differs — line above), NOT merely on the field being present:
      // the edit form always submits explanationMd, so a save that touches only
      // another field (e.g. priority) must NOT silently flip an unchanged
      // ai_draft to user_edited and drop its badge (Subtask 8.8.12).
      let effectiveSource = patch.explanationSource;
      const explanationChanged = update.explanationMd !== undefined;
      if (
        explanationChanged &&
        current.explanationSource === 'ai_draft' &&
        patch.explanationSource === undefined
      ) {
        effectiveSource = 'user_edited';
      }
      if (effectiveSource !== undefined && effectiveSource !== current.explanationSource) {
        update.explanationSource = effectiveSource;
        diff.explanationSource = { from: current.explanationSource, to: effectiveSource };
      }

      // ── Kind / parent re-validation ───────────────────────────────────
      // `kind` is mutable (user directive). A kind OR parent change must keep
      // BOTH sides of the kind-parent matrix legal: (1) the effective
      // (parent, kind) pair, and (2) the new kind must legally parent every
      // existing child. (DB trigger backstops cycle/depth/kind on the write;
      // cross-project parenting has no trigger, so it's checked here.)
      //
      // FOLDERS (MOTIR-5407) are the other placement. A `folderId` patch files
      // or unfiles through the step `fileWorkItem` uses — which clears the
      // work-item parent, so it is a re-parent to the root when the item had
      // one. A `parentId` patch onto a work item clears the folder instead (the
      // `moveWorkItem` rule), or the `work_item_parent_xor_folder` CHECK would
      // refuse the write. Either way the effective placement is validated with
      // the folder-aware rule, so a filed item may be re-kinded to a subtask.
      const nextKind = patch.kind !== undefined ? patch.kind : current.kind;
      const kindChanged = patch.kind !== undefined && patch.kind !== current.kind;
      const filing =
        patch.folderId !== undefined
          ? await planFolderFiling(current, nextKind, patch.folderId, tx)
          : null;
      const nextParentId =
        filing !== null ? null : patch.parentId !== undefined ? patch.parentId : current.parentId;
      const parentChanged =
        filing !== null
          ? current.parentId !== null
          : patch.parentId !== undefined && patch.parentId !== current.parentId;
      const nextFolderId =
        filing !== null ? filing.update.folderId : nextParentId !== null ? null : current.folderId;

      if (kindChanged || parentChanged || filing !== null) {
        if (nextParentId === null) {
          assertValidPlacement({ parentKind: null, filed: nextFolderId !== null }, nextKind);
        } else {
          const parent = await workItemRepository.findById(nextParentId, tx);
          if (!parent) throw new WorkItemNotFoundError(nextParentId);
          if (parent.projectId !== current.projectId) throw new CrossProjectParentError();
          assertValidParent(parent.kind, nextKind);
          // Re-parenting UNDER a marked card is new work under it (MOTIR-6672).
          // Only a real move is refused: a kind change beneath the parent the
          // card already has adds no child.
          if (parentChanged) assertNotMarkedParent(parent, current.identifier);
        }
      }

      if (kindChanged) {
        const children = await workItemRepository.findChildren(id, tx);
        for (const child of children) {
          assertValidParent(nextKind, child.kind); // new kind must parent each child
        }
        update.kind = patch.kind;
        diff.kind = { from: current.kind, to: patch.kind };
      }

      if (filing !== null) {
        Object.assign(update, filing.update);
        Object.assign(diff, filing.diff);
      } else if (parentChanged) {
        update.parentId = patch.parentId;
        diff.parentId = { from: current.parentId, to: patch.parentId };
        if (nextFolderId !== current.folderId) {
          update.folderId = nextFolderId;
          diff.folderId = { from: current.folderId, to: nextFolderId };
        }
      }

      // ── Type / executor (Story 2.7) ───────────────────────────────────
      // Leaf-only with seed-if-absent for the executor (assertTypeKindConsistent
      // + resolveExecutor). Validated against the EFFECTIVE post-patch kind, so
      // converting a typed leaf into a container WITHOUT clearing its type is
      // rejected (TypeNotAllowedOnKindError → 422) just like setting a type on a
      // story. A bare `type` change seeds the executor only when the row had
      // none; an explicit executor always wins and is never clobbered.
      const nextType: WorkItemTypeDto | null = patch.type !== undefined ? patch.type : current.type;
      const nextExecutor = resolveExecutor(nextType, patch.executor, current.executor);
      assertTypeKindConsistent(nextKind, nextType, nextExecutor);

      if (patch.type !== undefined && patch.type !== current.type) {
        update.type = patch.type;
        diff.type = { from: current.type, to: patch.type };
      }
      if (nextExecutor !== current.executor) {
        update.executor = nextExecutor;
        diff.executor = { from: current.executor, to: nextExecutor };
      }

      // ── Difficulty (Story MOTIR-6016) ─────────────────────────────────
      // Same leaf-only rule, against the same EFFECTIVE post-patch kind: a
      // story may only END UP with null, so re-kinding a leaf that carries one
      // is refused unless this same patch clears it. Re-sending the current
      // value is a no-op and records nothing.
      const nextDifficulty: WorkItemDifficultyDto | null =
        patch.difficulty !== undefined ? patch.difficulty : current.difficulty;
      assertDifficultyKindConsistent(nextKind, nextDifficulty);
      if (nextDifficulty !== current.difficulty) {
        update.difficulty = nextDifficulty;
        diff.difficulty = { from: current.difficulty, to: nextDifficulty };
      }

      // ── Obsolescence (Story MOTIR-6574 · MOTIR-6579) ──────────────────
      // NO kind predicate, deliberately: marking a `done` epic or a `cancelled`
      // decision is exactly what the field is for. It touches nothing else — not
      // status, readiness, rollups, archive or the ready set. Re-sending the
      // current value is a no-op and records nothing.
      //
      // ONE status rule (Story MOTIR-6575 · MOTIR-6672): SETTING a mark needs a
      // card whose status sits in the `done` category — read under this row lock,
      // so a card reopened concurrently cannot be marked. Clearing (`null`) is
      // always legal, and a patch that omits the mark never reaches the check.
      if (nextObsolescence !== undefined && nextObsolescence !== current.obsolescence) {
        if (nextObsolescence !== null) {
          const status = await workflowsService.getStatusByKey(
            current.projectId,
            current.status,
            ctx.workspaceId,
          );
          assertObsolescenceOnFinished({
            key: current.identifier,
            statusKey: current.status,
            statusCategory: status?.category ?? null,
          });
        }
        update.obsolescence = nextObsolescence;
        diff.obsolescence = { from: current.obsolescence, to: nextObsolescence };
      }
      if (
        patch.obsolescenceNoteMd !== undefined &&
        patch.obsolescenceNoteMd !== current.obsolescenceNoteMd
      ) {
        update.obsolescenceNoteMd = patch.obsolescenceNoteMd;
        diff.obsolescenceNoteMd = {
          from: current.obsolescenceNoteMd,
          to: patch.obsolescenceNoteMd,
        };
      }

      // The repository REFERENCES (MOTIR-3039), written BEFORE the empty-diff
      // early return and compared on their OWN value rather than on the names.
      //
      // Both details are load-bearing. A card in a project that had NO repository
      // set holds only a name; once the set exists, re-sending that same name
      // resolves to a ROW for the first time — the names are identical, the
      // revision diff is legitimately empty, and the reference is nonetheless new.
      // Gating this on `diff` (or on `sameRepoSet`) would silently drop exactly the
      // write that migrates such a card onto the reference model.
      if (nextRepoPins !== undefined) {
        const currentRefs = (await workItemRepoRepository.listByWorkItem(id, tx)).map(
          (r) => r.projectRepoId,
        );
        if (!sameRepoSet(nextRepoPins.refs, currentRefs)) {
          await writeRepoRefs(id, ctx.workspaceId, nextRepoPins.refs, tx);
          await recomputeAncestorRepoSets(id, ctx.workspaceId, tx);
          repoRefsChanged = true;
        }
      }

      if (Object.keys(diff).length === 0) {
        // Only a language was re-stated (the text is unchanged): store it, and
        // record no revision — nothing a reader would call an edit happened.
        const row =
          Object.keys(languageUpdate).length > 0
            ? await workItemRepository.update(id, languageUpdate, tx)
            : current;
        return {
          dto: toWorkItemDto(row),
          revisionId: null,
          addedDescMentionIds: [],
          changedFieldIds: [] as string[],
          repoSetChanged: repoRefsChanged,
        };
      }

      const row = await workItemRepository.update(id, update, tx);

      // The container ROLLUP across a RE-PARENT (MOTIR-2978, §A6): a move changes
      // TWO chains — the one the item joined and the one it left — and only the
      // first is reachable by walking up from the item now that the row has moved.
      // So the OLD parent is recomputed by id, INCLUDING itself, before the new
      // chain is walked.
      if (parentChanged) {
        if (current.parentId !== null) {
          await recomputeContainerAndAncestors(current.parentId, ctx.workspaceId, tx);
        }
        await recomputeAncestorRepoSets(id, ctx.workspaceId, tx);
      }

      // Link-on-write (Subtask 5.2.3): a body edit re-resolves the
      // embeds-are-attachments linkage — newly-referenced editor uploads
      // link, de-referenced editor-sourced rows unlink (panel rows and rows
      // on other issues are never touched; a URL still referenced by the
      // other body or a comment stays linked). The diff rides the SAME
      // 'updated' revision as the body edit — one write, one History entry,
      // the uniform trail that fills Jira's documented editor-add changelog
      // gap. Runs against the POST-write row so the still-referenced guard
      // sees what this transaction commits. An unchanged body never reaches
      // here (the field-diff gate above), so a no-op re-save stays a no-op.
      const bodyChanged =
        diff['descriptionMd'] !== undefined || diff['explanationMd'] !== undefined;
      const attachmentsCell = bodyChanged
        ? await attachmentsService.syncEditorLinks(
            {
              workItem: row,
              previousIds: extractReferencedAttachmentIdsFromBodies([
                current.descriptionMd,
                current.explanationMd,
              ]),
              nextIds: extractReferencedAttachmentIdsFromBodies([
                row.descriptionMd,
                row.explanationMd,
              ]),
            },
            tx,
          )
        : null;
      const revisionDiff: Record<string, unknown> = diff;
      if (attachmentsCell) revisionDiff['attachments'] = attachmentsCell;

      // Page tags (MOTIR-7696): re-derive the `description` / `explanation`
      // link rows for each body this edit CHANGED, in the same transaction. A
      // body the patch left alone keeps its rows — an omitted field is not an
      // empty one. Derived rows write no History entry, as on the page side.
      if (bodyChanged) {
        await syncBodyPageLinks(
          { id: row.id, workspaceId: current.workspaceId, projectId: current.projectId },
          {
            ...(diff['descriptionMd'] !== undefined ? { descriptionMd: row.descriptionMd } : {}),
            ...(diff['explanationMd'] !== undefined ? { explanationMd: row.explanationMd } : {}),
          },
          ctx.userId,
          tx,
        );
      }

      const revisionId = await workItemRevisionsService.recordRevision(
        { workItemId: id, changedById: ctx.userId, changeKind: 'updated', diff: revisionDiff },
        tx,
      );

      // Auto-relate-on-mention (Subtask 5.8.3): when this edit CHANGED a text
      // field (title / description / explanation), parse the NEW bodies and
      // auto-create a `relates_to` link to each newly-referenced target, in THIS
      // transaction. ADD-only — a reference dropped by this edit never deletes
      // an existing link — and idempotent, so a reference kept from before
      // re-adds nothing (findAnyBetween skips it). Reads the project only when a
      // text field actually moved (the in-tx identifier prefix for bare keys).
      if (diff['title'] || diff['descriptionMd'] || diff['explanationMd']) {
        const project = await projectRepository.findById(current.projectId, tx);
        /* istanbul ignore else -- the item's project always resolves (it was read
           to gate the edit above); the guard narrows the nullable type only */
        if (project) {
          await autoRelateWorkItemMentions(
            {
              source: {
                id: row.id,
                workspaceId: current.workspaceId,
                projectId: current.projectId,
                projectIdentifier: project.identifier,
              },
              title: row.title,
              bodies: [row.descriptionMd, row.explanationMd],
              ctx,
            },
            tx,
          );
        }
      }
      // The automatable built-in fields that actually changed (Story 6.6 ·
      // Subtask 6.6.2) — translated from the diff keys; drives the
      // `field.changed` emit below. Computed off `diff` (the field cells), so
      // the synthetic `attachments` cell on `revisionDiff` is naturally ignored.
      // THE CHOICE QUESTION (Story MOTIR-4914 · MOTIR-5891) — an edit to a choice's body
      // re-asks it at the new stamp or withdraws it; a type change onto or off `choice`
      // raises or withdraws it. Anything else leaves it exactly as it is.
      const choiceTouched =
        (diff['descriptionMd'] !== undefined || diff['type'] !== undefined) &&
        (row.type === 'choice' || current.type === 'choice');
      const choiceSettled = choiceTouched ? await reconcileChoiceGate(row, ctx, tx) : row;
      // THE CONFIRM QUESTION (Story MOTIR-5871 · MOTIR-5954) — an edit to a `human`
      // decision's body re-asks it or withdraws it; a type OR EXECUTOR change onto or
      // off a `human` decision raises or withdraws it (point 4).
      const decisionTouched =
        (diff['descriptionMd'] !== undefined ||
          diff['type'] !== undefined ||
          diff['executor'] !== undefined) &&
        (asksTheConfirmQuestion(row) || asksTheConfirmQuestion(current));
      const settled = decisionTouched
        ? await reconcileDecisionGate(choiceSettled, ctx, tx)
        : choiceSettled;
      // THE MANUAL-WORK QUESTION (MOTIR-7474; `manual-work-gate.md` §6) — an executor or
      // type edit that leaves the card no longer manual withdraws it (`no_longer_manual`):
      // nobody owes a person's work on a card an agent now runs.
      if (diff['type'] !== undefined || diff['executor'] !== undefined) {
        await manualWorkGateService.withdrawIfNoLongerManual(settled, tx);
      }

      const changedFieldIds: string[] = automationFieldsFromDiffKeys(Object.keys(diff));
      // Did this edit move the EMBEDDED DOCUMENT (Story MOTIR-2694 · MOTIR-2696,
      // ADR §3)? Compared as composed DOCUMENTS rather than as `diff.title ||
      // diff.descriptionMd`, so the 8 000-character truncation is inside the
      // comparison: an edit that rewrites only the 9 000th character embeds
      // identically and is correctly judged a no-op. `explanationMd` is excluded
      // from the document, so an explanation-only edit is likewise silent.
      const embeddingChanged = embeddingDocumentChanged(current, row);
      return {
        dto: toWorkItemDto(settled),
        revisionId,
        addedDescMentionIds,
        changedFieldIds,
        embeddingChanged,
        // The re-parent ends, for the post-commit child-set emit (MOTIR-2902).
        // Null when the patch did not move the item — a `parentId` absent from
        // the patch, or present and equal, changes no child set.
        movedBetween: parentChanged
          ? { previousParentId: current.parentId, newParentId: nextParentId }
          : null,
        // Either half of the set moved — the names or the references the gate
        // resolves through (`resolveExpectedRepos`) — for the post-commit
        // completion re-check (MOTIR-9235).
        repoSetChanged: repoRefsChanged || diff.targetRepos !== undefined,
      };
    });

    // Post-commit description-mention event (5.1.6) — same shape and rules as
    // the create path: only newly-added, view-validated ids; never inside the
    // tx; the job skips the author + re-validates view access at send time.
    if (result.revisionId !== null && result.addedDescMentionIds.length > 0) {
      await sendEvent('work-item/mentioned', {
        workspaceId: ctx.workspaceId,
        workItemId: result.dto.id,
        revisionId: result.revisionId,
        authorId: ctx.userId,
        mentionedUserIds: result.addedDescMentionIds,
      });
    }

    // Automation `field_changed` trigger (Story 6.6 · Subtask 6.6.2): emit only
    // when an automatable built-in field (assignee / priority / dueDate /
    // estimate) actually changed — so the event is never a no-op for the
    // engine. Carries the changed field ids (the engine narrows by its rule's
    // configured field) + provenance (a `set_field` action's own edit is
    // skipped, so it can't loop). Status moves DON'T ride this — they ride
    // `work-item/transitioned` from the typed-workflow path.
    if (result.revisionId !== null && result.changedFieldIds.length > 0) {
      await sendEvent('work-item/field.changed', {
        workspaceId: ctx.workspaceId,
        projectId: result.dto.projectId,
        workItemId: result.dto.id,
        actorId: ctx.userId,
        changedFields: result.changedFieldIds,
        revisionId: result.revisionId,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
    }

    // Plan-tree embedding, UPDATE trigger (Story MOTIR-2694 · MOTIR-2696, ADR
    // §6.3.1) — emitted ONLY when the embedded document actually moved. This gate
    // is the whole answer to "an embedding goes stale on every edit": the trigger
    // is the CONTENT, not the row (§3), so a status flip, a re-parent, a sprint
    // move, an assignee change, a priority bump or a reorder — the overwhelming
    // majority of work-item writes — enqueue nothing and cost nothing.
    if (result.embeddingChanged) {
      await sendEvent('work-item/embedding.requested', {
        workspaceId: ctx.workspaceId,
        workItemId: result.dto.id,
      });
    }

    // ── Status derivation, child-set trigger (Bug MOTIR-2902) ──────────────
    //
    // `updateWorkItem` is the SECOND re-parent ingress, and it was missed.
    // MOTIR-2892 wired `moveWorkItem` — which had emitted nothing at all — and
    // the identical gap here went unnoticed because the two paths look unrelated
    // from the outside: one is `move_to_parent`, the other is a field patch that
    // happens to accept `parentId`.
    //
    // The CSV importer is the caller that makes it bite. It is a two-pass
    // design: pass 1 creates each row WITHOUT a parent (a child whose parent is
    // imported later cannot be parented yet) and pins its mapped status; pass 2
    // wires the parent through THIS function. So every derivation trigger an
    // import produced fired while the tree was still flat — the create-recompute
    // saw a childless root, and the moment the children were actually attached,
    // nothing fired at all. The parent kept whatever the CSV said, forever.
    //
    // Both ends are recomputed for the same reason `moveWorkItem` does it: one
    // move changes two child sets in opposite directions — the previous parent
    // may now be finished, the new one may need to come back. Either end may be
    // null (moved to or from the top level); a move with no parent on either
    // side cannot occur, since `parentChanged` means the two differ.
    if (result.movedBetween) {
      const parentIds = [
        result.movedBetween.previousParentId,
        result.movedBetween.newParentId,
      ].filter((parentId): parentId is string => parentId !== null);
      if (parentIds.length > 0) {
        await sendEvent('work-item/child-set.changed', {
          workspaceId: ctx.workspaceId,
          parentIds,
          workItemId: result.dto.id,
          reason: 'reparented',
          // The edit's own instant: a row LEAVING an aggregate leaves nothing
          // behind to date the change (MOTIR-2965).
          occurredAt: new Date().toISOString(),
        });
      }
    }

    // ── Repository-set completion, edit trigger (Bug MOTIR-9235) ───────────
    //
    // The completion gate runs on a delivery, so an item held for a repository
    // that never had work to ship stayed held after the person removed that
    // repository — the very step the merge comment tells them to take. After the
    // commit, so the gate reads the set this edit wrote.
    if (result.repoSetChanged) return reevaluateRepoSetCompletion(result.dto, ctx);

    return result.dto;
  },

  /**
   * Move a work item to a new status THROUGH the per-project workflow gate
   * (Subtask 2.2.4) — the typed-workflow entry point for `work_item.status`,
   * distinct from updateWorkItem's free-form status patch. Order matters:
   *   1. tenant gate (cross-workspace id → 404, BEFORE any status check — no
   *      existence leak, and the AC's "404 not UNKNOWN_STATUS" ordering);
   *   2. no-op (`toStatusKey === current`) → return WITHOUT a revision row,
   *      the same idempotency rule updateWorkItem follows;
   *   3. target must be a real status in this project's workflow → UnknownStatusError;
   *   4. the move must be legal under the workflow → IllegalTransitionError;
   *   5. status write + the 'updated' revision in ONE transaction (atomic — a
   *      revision-insert failure rolls back the status change).
   * The validation reads (getStatusByKey / canTransition) are workspace-scoped
   * via the explicit workspaceId the workflow service already enforces.
   */
  async updateStatus(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
    opts: {
      /**
       * Writes that must commit WITH the status write or not at all, run in its
       * transaction after the transition applied — the CI promotion's merge gates
       * (MOTIR-5515). Runs on a no-op move too, which is what makes a retried
       * promotion finish what a lost race started. The post-commit event below is
       * unchanged by it.
       */
      inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
      /** See `applyStatusTransition`'s `keepPendingQuestions` — the merge sync's
       *  lifecycle moves (MOTIR-5527 · MOTIR-4882). */
      keepPendingQuestions?: boolean;
    } = {},
  ): Promise<WorkItemDto> {
    // MOTIR-2846: `withWorkspaceContext`, not a bare `db.$transaction`. A bare
    // one binds no GUCs, so every gate read inside `applyStatusTransition` —
    // the item, its project, the workflow — comes back empty under `motir_app`
    // and the transition 404s an item that is on the screen.
    const { dto, transition } = await withWorkspaceContext(ctx, async (tx) => {
      const applied = await workItemsService.applyStatusTransition(
        workItemId,
        toStatusKey,
        ctx,
        tx,
        opts.keepPendingQuestions ? { keepPendingQuestions: true } : {},
      );
      if (opts.inTransaction) await opts.inTransaction(tx);
      return applied;
    });
    // Post-commit, never inside the tx — a rollback must not have notified
    // (the 5.1.2 rule). A no-op move carries no transition, so it emits
    // nothing. The 5.4.5 watcher job consumes this; 5.7's bell fans in later.
    if (transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: dto.id,
        actorId: ctx.userId,
        fromStatusKey: transition.fromStatusKey,
        toStatusKey: transition.toStatusKey,
        revisionId: transition.revisionId,
        // Provenance (Story 6.6 · Subtask 6.6.2): set when a rule's `transition`
        // action drove this move, so the engine skips the follow-on event and
        // can't loop. Absent on a user-driven transition.
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
      await latchCiGreen(dto.id, transition.toStatusKey, ctx);
    }
    return dto;
  },

  /**
   * Set a work item's workflow status under a SYSTEM/import context (Story 7.16
   * · MOTIR-941, the ADR §Consequences #1 "status on import" extension). Unlike
   * {@link updateStatus}, this reaches ANY valid project status DIRECTLY —
   * including a done-category one — without walking the interactive
   * `restricted`-policy legal edges, because an import is an authoritative bulk
   * operation that places each imported issue in its mapped status (a closed
   * source issue lands closed). It is NOT a write path around the authority:
   * it runs the SAME locked, tenant-gated, access-gated `applyStatusTransition`
   * core (with `system: true`), the target key is still validated against the
   * project's real statuses (`UnknownStatusError` on an unknown key), and the
   * status change is still recorded as a revision. A no-op move (already in the
   * target status — the common case when the mapped status IS the initial one)
   * returns without a revision. Deliberately emits NO `work-item/transitioned`
   * event: a bulk import would otherwise fan out one notification per imported
   * issue (a storm), and the item is freshly created/re-synced by the same run.
   */
  async setImportedStatus(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const { dto } = await withWorkspaceContext(ctx, (tx) =>
      workItemsService.applyStatusTransition(workItemId, toStatusKey, ctx, tx, { system: true }),
    );

    // ── The pin's OWN derivation trigger (Bug MOTIR-2902) ──────────────────
    //
    // Post-commit, like every other emit in this service. This does NOT reopen
    // the no-`work-item/transitioned` contract above: `work-item/derivation.requested`
    // has exactly ONE consumer, `status-derivation/requested`, and no
    // notification path subscribes to it — so the storm an import avoids stays
    // avoided while the parent still gets recomputed.
    //
    // WHY IT IS NEEDED. Before this, the only derivation trigger an import
    // produced was the `work-item/created` emitted by the create that PRECEDES
    // this call. That recompute could run before the pin, read the child as
    // `todo`, settle the parent at `todo` — and never re-fire, because the child
    // set never changes again. The wrong answer was terminal, not late, which is
    // why the ordering has to be guaranteed by an EVENT rather than by a
    // debounce window. The debounce that was tried first (#2114, removed) keyed
    // `work-item/created` on `event.data.parentId`, which is null for a root
    // item — and an unresolvable key does not skip the debounce, it MERGES every
    // event carrying it into one bucket. That is the measured mechanism; the
    // "the dev server discards runs" reading this comment used to give was
    // driven ~20 times by motir-core #2122 (MOTIR-2994) and never reproduced.
    // `lib/jobs/definitions/statusDerivation.ts` carries the full note;
    // `tests/jobs/debounce-burst.test.ts` and `docs/jobs.md` § Debounce carry
    // the evidence (`inngest-cli` 1.27.0 dev server; Cloud unmeasured,
    // MOTIR-2997).
    //
    // Skipped for a ROOT item: with no parent there is nothing to derive, so an
    // emit would be a guaranteed no-op run per imported top-level row.
    if (dto.parentId) {
      await sendEvent('work-item/derivation.requested', {
        workspaceId: ctx.workspaceId,
        parentId: dto.parentId,
        workItemId: dto.id,
        reason: 'imported-status-pinned',
      });
    }
    return dto;
  },

  /**
   * Set the CI / verification signal on a work item (Subtask 7.10.6 / MOTIR-894)
   * — the "ready/blocked" signal the CI feedback loop flips, DISTINCT from the
   * workflow `status`: `'passing'` ⇔ every pull request delivering the card is
   * green (the item is verified; the Story roll-up counts it), `'failing'` ⇔ one
   * of them has a terminal failure (the item is visibly not-ready), `'running'` ⇔
   * the card is waiting on a verdict, `null` ⇔ no checks at all. Idempotent
   * (setting the same value is a no-op write). Tenant-gated on `ctx.workspaceId`
   * exactly like `updateStatus` — a cross-workspace id is a 404, never a leak.
   * The write goes through the service + repository (no raw `work_item` update at
   * the integration layer); no revision row (this is a signal, not a tracked
   * field edit), and no event.
   *
   * ⚠️ `'running'` JOINED THE RANGE WITH MOTIR-5470, AND THE VALUES ARE NOW
   * `PrCiState`'s OWN WORDS. The column was terminal-only under the MOTIR-894
   * contract, which is why a card whose fix was already building kept reading
   * `failing` until the next terminal check. It is now recomputed as a FOLD over
   * the card's whole delivery set — `deliveryVerdict.recomputeWorkItemCiState`,
   * which is what every writer should reach for. This setter remains the write
   * door it always was; what changed is that nothing should be stamping a single
   * pull request's verdict through it.
   */
  async setCiState(
    workItemId: string,
    ciState: 'passing' | 'failing' | 'running' | null,
    ctx: ServiceContext,
  ): Promise<void> {
    await withWorkspaceContext(ctx, async (tx) => {
      const current = await workItemRepository.findById(workItemId, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(workItemId);
      }
      if (current.ciState === ciState) return; // idempotent no-op
      await workItemRepository.update(workItemId, { ciState }, tx);
    });
  },

  /**
   * The transactional CORE of updateStatus — the lock → tenant-gate → no-op →
   * unknown-status → legal-transition → write-status + revision sequence,
   * factored out of `updateStatus` so it can run INSIDE a caller-supplied
   * transaction. `updateStatus` wraps it in its own `db.$transaction`; the
   * board move path (Subtask 3.1.5, `boardsService.moveCard`) calls it within
   * ITS transaction so the cross-column status change and the board rank write
   * commit atomically — one transaction, never a nested `db.$transaction`
   * (which would open a second connection and deadlock against the row this
   * method `FOR UPDATE`-locks). Either caller runs the SAME validated path; the
   * transition validation is defined once here, never re-implemented at the
   * board layer. `tx` is REQUIRED — this method never opens a transaction.
   *
   * Returns the updated DTO plus the applied transition's metadata (from/to
   * keys + the revision row id) — `null` on the no-op move — so each caller
   * can emit `work-item/transitioned` AFTER its own transaction commits
   * (Subtask 5.4.5; the emit can never live HERE, inside the tx, because a
   * rollback must not have notified anyone).
   */
  async applyStatusTransition(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
    opts: {
      sessionBranch?: string;
      system?: boolean;
      /**
       * The approval gate whose OWN decision is making this move (ADR
       * `approval-gates.md` §6d AMENDMENT, rule 5). `approvalGatesService.decide`
       * runs the kind's effect BEFORE it writes the decision, so that gate is
       * still `awaiting` while its approval writes the status it owns. The
       * approval-gate guard skips THIS gate and no other.
       */
      decidingGateId?: string;
      /**
       * The move is the PRODUCT's own lifecycle, not a person pulling work back —
       * the merge sync moving a card out of review because one of its pull
       * requests closed (MOTIR-4882). Rule 6's withdraw (ADR §6d AMENDMENT) is for
       * a person abandoning the question; the sync withdraws exactly the gates
       * whose subject changed, BY SUBJECT (`mergeGates`), and a blanket withdraw
       * here would take the OTHER pull request's question with it. The guard still
       * applies — this exempts nothing it refuses.
       */
      keepPendingQuestions?: boolean;
    } = {},
  ): Promise<{
    dto: WorkItemDto;
    transition: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null;
  }> {
    // LOCK ORDER: the item's `awaiting` approval gates FIRST, then the item (ADR
    // `approval-gates.md` §6d AMENDMENT, rule 8 · MOTIR-5527). The decide door
    // locks its gate and then transitions the item through this method; a
    // transition that locked the item first and then reached for a gate — to
    // supersede it below, when the work is pulled back — would take the same two
    // locks in the opposite order and deadlock against an approval pressed at the
    // same moment. So EVERY transition, system writes included, takes them in the
    // door's order. Re-locking the door's own gate is a no-op.
    const awaitingGates = await approvalGateRepository.lockAwaitingByWorkItem(workItemId, tx);
    const locked = await workItemRepository.lockById(workItemId, tx);
    if (!locked) throw new WorkItemNotFoundError(workItemId);
    const current = await workItemRepository.findById(workItemId, tx);
    // Tenant gate FIRST: a cross-workspace id is indistinguishable from a
    // never-existed one (404), and must not leak via a status error.
    if (!current || current.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(workItemId);
    }

    // Project access gate (6.4.3): a status move is an edit. Gated here (not just
    // in updateStatus) so the board move path — boardsService.moveCard, which
    // calls this inside ITS transaction for a cross-column move — is covered by
    // the same check. `tx` is the caller's, so the gate shares the snapshot.
    await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

    const fromKey = current.status;
    // The `mark_integrated` session-branch directive (Subtask 7.8.11): set the
    // integration branch alongside the status move. A genuine write only when it
    // differs from the current value (re-marking the SAME branch is a no-op).
    const branchDirective = opts.sessionBranch;
    const wantsBranchWrite =
      branchDirective !== undefined && branchDirective !== current.sessionBranch;

    // No-op STATUS move: succeed without a revision (idempotent) and emit no
    // transition. But still honor a branch-only write — re-marking an item
    // ALREADY in `implemented` to a new session branch changes the field without a
    // status transition (no revision, since sessionBranch is dispatch bookkeeping
    // not a content edit on the activity feed).
    if (fromKey === toStatusKey) {
      if (!wantsBranchWrite) return { dto: toWorkItemDto(current), transition: null };
      const row = await workItemRepository.update(
        workItemId,
        { sessionBranch: branchDirective },
        tx,
      );
      return { dto: toWorkItemDto(row), transition: null };
    }

    const target = await workflowsService.getStatusByKey(
      current.projectId,
      toStatusKey,
      ctx.workspaceId,
    );
    if (!target) throw new UnknownStatusError(toStatusKey);

    // A MARKED card stays FINISHED (Story MOTIR-6575 · MOTIR-6672). A card
    // carrying `outdated` or `deprecated` may not move to a status outside the
    // `done` category until a person clears the mark — the rule is stated once in
    // the pure `isReopenHeldByMark`, which the status control and the board read
    // up front. Unlike the plan hold and the gate guard, `opts.system` is NOT
    // exempt: no rollup, webhook or importer reopens a marked card. The system
    // movers that report refusals (`isStatusTransitionRefusal`) record it rather
    // than throw. A move WITHIN the done category (`done ↔ cancelled`) and the
    // no-op move above are untouched. The mark is read from `current`, the row
    // read under the lock, so a mark set concurrently cannot slip past. Before the
    // legality check, so the refusal names the mark, not a missing edge.
    if (isReopenHeldByMark(current.obsolescence, target.category)) {
      throw new MarkedCardCannotReopenError({
        key: current.identifier,
        obsolescence: current.obsolescence as 'outdated' | 'deprecated',
        toStatusKey,
      });
    }

    // Legal-edge validation, EXCEPT under a system context (`opts.system`). An
    // AUTHORITATIVE bulk/system operation — the issue importer (MOTIR-941),
    // whose ADR (docs/decisions/issue-importer.md §Consequences #1) requires
    // reaching ANY project status directly, INCLUDING a done-category one (a
    // closed/resolved source issue is imported closed, never re-opened) — sets
    // the mapped status without walking the interactive `restricted`-policy
    // legal edges from `isInitial`. The target-status VALIDITY check above
    // (`getStatusByKey` → `UnknownStatusError`) still holds, so a system set can
    // only ever reach a REAL project status key; it never bypasses the tenant or
    // project-access gates. Ordinary user/board moves (no `system`) run the full
    // legal-transition check unchanged.
    if (!opts.system) {
      const legal = await workflowsService.canTransition(
        current.projectId,
        fromKey,
        toStatusKey,
        ctx.workspaceId,
      );
      if (!legal) throw new IllegalTransitionError(fromKey, toStatusKey);
    }

    // THE PLAN HOLD (Story MOTIR-6017 · MOTIR-6265; `docs/decisions/
    // agent-authored-plans.md` AMENDMENT 21). A card an UNDECIDED plan has parked
    // at `planning` is being rewritten by that plan, so no hand move out of
    // `planning` is the person's to make until the plan is decided — EVERY
    // target, not one (an approval gate owns one status; an open plan owns them
    // all). The rule is stated once, in the pure `planHoldFor`, which the status
    // control's up-front read (`planTargetLockService.readPlanHold`) shares.
    //
    //   • `opts.system` is EXEMPT: every exit is one of the plan's own system
    //     writes — approve's resting pass, the release on decline / an emptying
    //     withdraw / a discarded close (`releaseOne`, `restAdoptedTarget`) and the
    //     abandoned-plan sweep (§3). There is no manual escape hatch.
    //   • Moves INTO `planning` are untouched; only leaving is held.
    //   • Both reads (`readPlanHoldWithin`) are on `tx`, under the item row lock
    //     taken above. The plan's release locks the SAME row before it deletes the
    //     lock row (`releaseOne` → `workItemRepository.lockById`), so a hand move
    //     racing a decision either runs first and is refused, or runs after the
    //     release from the rested status as an ordinary move — never a moved card
    //     with a surviving lock row.
    //
    // Cost: paid only by a non-system move OUT of `planning` — one indexed read,
    // plus the plan read when a plan lock exists.
    if (!opts.system && fromKey === PLANNING_STATUS_KEY) {
      const hold = await readPlanHoldWithin(
        { id: workItemId, identifier: current.identifier, status: fromKey },
        tx,
        new Date(),
        ctx.userId,
      );
      if (hold) throw new PlanTargetHeldError({ statusKey: toStatusKey, ...hold });
    }

    // THE APPROVAL-GATE GUARD (Story MOTIR-4887 · MOTIR-5526; ADR
    // `docs/decisions/approval-gates.md` §6d AMENDMENT, rules 1–5). An `awaiting`
    // gate OWNS one status — the one approving it would write — and a move INTO
    // that status by hand would skip the decision the gate exists to record. So
    // exactly that move is refused; every other move the workflow allows stays
    // legal, because a pending decision must not make the card unusable.
    //
    //   • WHAT a gate owns is its kind's `statusIntent`, read from the REGISTRY
    //     and resolved against this project's own statuses — never a kind or a
    //     status literal here. A `null` intent, a kind this build does not
    //     register (it has no door to be decided through, so refusing its move
    //     would strand the card), and an intent the workflow cannot resolve all
    //     own NOTHING.
    //   • ONLY `awaiting` refuses (the query's own predicate). `approved`,
    //     `changes_requested` and `superseded` hold nothing, which is what keeps
    //     §6d's reopen path legal.
    //   • `opts.system` is EXEMPT, like both sibling gates below.
    //   • `opts.decidingGateId` is EXEMPT for that ONE gate: the decide door runs
    //     the effect before it writes the decision, so its own approval would
    //     otherwise be refused by the guard it exists to protect.
    //
    // ⚠️ THE STATUSES ARE READ ON `tx`, NEVER THROUGH `resolveStatusKey`, which
    // reads in a context of its own — a second pooled connection while this
    // transaction holds the item `FOR UPDATE`. The rule is shared through the pure
    // `resolveStatusIntent`, so the door and the guard cannot disagree about what
    // a gate owns. The common card pays one indexed read
    // (`approval_gate_work_item_id_idx`) and no status read.
    let statuses: WorkflowStatusDto[] | null = null;

    // THE HELD MOVES — rule 2b and rule 1, stated ONCE in `heldMoves`
    // (`lib/approvalGates/heldMoves.ts`), the same function the status control
    // reads to lock these moves before anyone tries them.
    //
    //   · RULE 2b — "it's about if there's a PR" (Yue, 2026-09-14). With an OPEN
    //     delivering pull request, `approved` is written only by the approval (a
    //     hand move there is refused unless it IS that approval's own write) and
    //     every done-category status but Cancelled only by the merge webhook. The
    //     merge itself passes: the sync commits its pull request as closed before
    //     it transitions the card.
    //   · RULE 1 — an `awaiting` gate holds the status its kind's intent resolves
    //     to, and the deciding gate never holds its own write.
    //
    // Cost: the delivery read is paid only by a move INTO one of the statuses rule
    // 2b can hold, and the status list only when there is something to resolve.
    if (!opts.system) {
      const candidateFor2b =
        toStatusKey === APPROVED_STATUS_KEY ||
        (target.category === 'done' && toStatusKey !== ROADMAP_CANCELLED_KEY);
      const hasOpenPullRequest =
        candidateFor2b &&
        (await workItemDeliveryRepository.countOpenByWorkItem(workItemId, tx)) > 0;
      if (hasOpenPullRequest || awaitingGates.length > 0) {
        statuses ??= await workflowsService.listStatusesByProject(
          current.projectId,
          ctx.workspaceId,
          tx,
        );
        const held = heldMoves({
          statuses,
          hasOpenPullRequest,
          awaitingGates,
          intentOf: (kind) =>
            isRegisteredGateKind(kind as ApprovalGateKind)
              ? handlerFor(kind as ApprovalGateKind).statusIntent
              : null,
          decidingGateId: opts.decidingGateId,
        }).find((move) => move.statusKey === toStatusKey);
        if (held) {
          throw new ApprovalGatePendingError({
            statusKey: toStatusKey,
            gateId: held.gateId,
            gateKind: held.gateKind,
            itemKey: current.identifier,
            workItemId,
            waitingOn: held.waitingOn,
          });
        }
      }
    }

    // PULLING THE WORK BACK WITHDRAWS THE QUESTION (ADR `approval-gates.md` §6d
    // AMENDMENT, rule 6 · MOTIR-5527). A hand move out of the review band — or to
    // Cancelled — means what somebody was asked to approve is being reworked or
    // abandoned, so every `awaiting` gate on the item is superseded in THIS
    // transaction, under the lock taken at the top. `→ blocked` keeps the question
    // (blocking pauses the work, it does not abandon it), and a system write
    // withdraws nothing. The supersede writes `state` and nothing else (§6b), so
    // the audit cannot read it as a decision; who pulled the work back is on this
    // transition's own revision row. Placed AFTER the guard, which can only ever
    // refuse a move INTO an owned status — never one of these.
    // Computed whether or not anything is awaiting, because the RE-ASK below has to
    // know it: a move this rule calls a pull-back must not be immediately undone by
    // a fresh raise (MOTIR-5670).
    const pullsTheWorkBack =
      !opts.system &&
      !opts.keepPendingQuestions &&
      withdrawsPendingQuestion({
        fromKey,
        toKey: toStatusKey,
        statuses: (statuses ??= await workflowsService.listStatusesByProject(
          current.projectId,
          ctx.workspaceId,
          tx,
        )),
        keys: {
          reviewKey: statuses.find((s) => s.key === 'in_review')?.key ?? null,
          implementedKey: statuses.find((s) => s.key === 'implemented')?.key ?? null,
          approvedKey: statuses.find((s) => s.key === 'approved')?.key ?? null,
        },
        system: false,
      });
    // ⚠️ AND A MOVE TO CANCELLED WITHDRAWS THE QUESTION ON EVERY ROUTE (MOTIR-7109).
    // Rule 6 above exempts a system write, which left a card CANCELLED by the parent
    // cascade, the importer or any other system mover holding an `awaiting` gate a
    // person could still approve — with whatever status and merge that approval
    // carries — for work nobody intends to finish. Cancelled abandons the work
    // whoever writes it, so it withdraws whoever writes it, every kind alike. The
    // decide door's OWN move to Cancelled (an overturn) keeps its deciding gate,
    // which is still `awaiting` until the door's final write; every OTHER question
    // on the card goes.
    const abandonsTheWork = toStatusKey === ROADMAP_CANCELLED_KEY;
    if (awaitingGates.length > 0 && (pullsTheWorkBack || abandonsTheWork)) {
      if (opts.decidingGateId) {
        await approvalGateRepository.supersedeOtherAwaitingByWorkItem(
          workItemId,
          opts.decidingGateId,
          'pulled_back',
          tx,
        );
      } else {
        await approvalGateRepository.supersedeAllAwaitingByWorkItem(
          workItemId,
          // The WORK moved backwards under the question — out of review, or to
          // Cancelled. Nothing about the design or the pull requests changed
          // (AMENDMENT 6 Q5).
          'pulled_back',
          tx,
        );
      }
    }

    // ⚠️ AND A MANUAL-WORK QUESTION NOBODY ANSWERED CLOSES WITH THE CARD (MOTIR-7474;
    // `manual-work-gate.md` §6). A `manual_work` gate owns Done, so a hand move there is
    // refused above and its own Mark done passes as `decidingGateId`. Every OTHER way into
    // the done category — the parent cascade, the rollup, any system write — finishes the
    // card without anybody deciding the gate, so it is withdrawn as
    // `closed_without_decision` rather than left asking for work that is closed, and
    // never recorded as `approved`. Cancelled is the pull-back above, already withdrawn.
    if (
      target.category === 'done' &&
      !abandonsTheWork &&
      awaitingGates.some((gate) => gate.kind === 'manual_work' && gate.id !== opts.decidingGateId)
    ) {
      await manualWorkGateService.withdrawOnUndecidedClose(workItemId, tx);
    }

    // ⚠️ AND A MANUAL-WORK QUESTION LEAVES A CARD NOBODY CAN START (MOTIR-8670;
    // `manual-work-gate.md` §6, amended). Waiting on you asks a person to do the work
    // now; a card moved to Blocked waits on something else first, and a card moved to
    // Planning — by hand, or parked by a plan's append — is being rewritten, so the
    // card the run reached is not the card that will come back. Every writer, system
    // included: the question is wrong whoever made the move. Rule 6 keeps every OTHER
    // kind's question through `blocked`; this is the one kind whose question is about
    // doing the work rather than judging it. Nothing re-raises it: the next run that
    // reaches the card, ready, does.
    if (
      (toStatusKey === MANUAL_WORK_NOT_READY_KEY || toStatusKey === PLANNING_STATUS_KEY) &&
      awaitingGates.some((gate) => gate.kind === 'manual_work')
    ) {
      if (toStatusKey === PLANNING_STATUS_KEY) {
        await manualWorkGateService.withdrawOnReplan(workItemId, tx);
      } else {
        await manualWorkGateService.withdrawWhenNotReady(workItemId, tx);
      }
    }

    // ⚠️ AND THE MERGE QUESTION LEAVES WITH THE CARD, WHEREVER IT GOES (MOTIR-6971;
    // ADR `approval-gates.md` §8's EIGHTH AMENDMENT). The approve-to-merge question
    // exists only while the card is `in_review`, so a move to ANY other open status
    // supersedes it — `blocked` included, which rule 6 above keeps every OTHER
    // question through, and a system write included, which rule 6 skips. Three moves
    // are not this rule's:
    //   · into the DONE category — the merge sync and Cancelled settle it (rule 6, and
    //     `withdrawPullRequestApprovalGatesOnClose` by subject);
    //   · the decide door's own write (`decidingGateId`) — `in_review → approved` is
    //     the approval itself, and its gate is still `awaiting` until the door records it;
    //   · the merge sync's lifecycle move (`keepPendingQuestions`), which withdraws by
    //     subject before it moves.
    // Under the locks taken at the top, in the door's order (rule 8).
    if (
      awaitingGates.some((gate) =>
        (['pull_request_approval', 'agent_review', 'acceptance_result'] as const).some(
          (kind) => gate.kind === kind,
        ),
      ) &&
      target.category !== 'done' &&
      toStatusKey !== IN_REVIEW_STATUS_KEY &&
      !opts.decidingGateId &&
      !opts.keepPendingQuestions
    ) {
      await withdrawMergeQuestionOffReview({ ...current, status: toStatusKey }, tx);
    }

    // ⚠️ THE CARD'S OWN STATUS CHANGE RE-ASKS THE PREDICATE (Story MOTIR-5652 ·
    // Subtask MOTIR-5670), and it is here because a MEASUREMENT said it was owed
    // rather than because a reading said so — see the note below for what the
    // measurement falsified.
    //
    // A card whose delivery set went green BEFORE it was eligible is asked
    // nothing by the CI side: `promoteDeliveredCardsOnGreen` filters to
    // `implemented` / `in_review` / `approved` before it asks anything, and the
    // verdict has already been delivered. The CI-GREEN LATCH (MOTIR-3006) covers
    // the ordinary path — a card ARRIVING at `implemented` re-reads its green
    // verdict and promotes itself — and that is the path a run takes.
    //
    // ⚠️ WHAT IT DOES NOT COVER, MEASURED: a card that reaches `in_review`
    // WITHOUT passing through `implemented`. The latch watches one rung, so the
    // card lands in review, green, with nothing to press — MOTIR-5652's own
    // shape, reached by a different road. This closes it for every rung at or
    // above `implemented`.
    //
    // ⚠️ IT ONLY RAISES, AND NOT ON A PULL-BACK. `reconcileGatesFor` never
    // supersedes (MOTIR-5663), and `pullsTheWorkBack` keeps it off the moves rule 6
    // has just withdrawn — `in_review → implemented` is one of them, and re-raising
    // there would defeat rule 6 one statement after it fired. It is idempotent by
    // construction: a gate that already exists is left exactly as it is, which is
    // what keeps a status change from churning `subjectVersion` or re-asking a
    // question somebody has answered.
    //
    // In the funnel's own transaction and under the locks it has already taken.
    if (target.category !== 'done' && !pullsTheWorkBack) {
      const known = (statuses ??= await workflowsService.listStatusesByProject(
        current.projectId,
        ctx.workspaceId,
        tx,
      ));
      const rank = rankOfStatus(toStatusKey, known, {
        reviewKey: 'in_review',
        implementedKey: 'implemented',
        approvedKey: 'approved',
      });
      if (rank >= RUNG_RANK.implemented) {
        const fresh = await workItemRepository.findById(workItemId, tx);
        // ⚠️ AS IT WILL STAND, not as it stood (MOTIR-6971). This runs BEFORE the row
        // write below, so the read still carries the OLD status — harmless while the
        // predicate never looked at it, and wrong now that the merge question is asked
        // only at `in_review`: a hand move `in_progress → in_review` would ask nothing.
        // The write lands in this same transaction, so the target IS the status the
        // gate will be raised against.
        if (fresh) await reconcileGatesFor({ ...fresh, status: toStatusKey }, tx);
      }
    }

    // THE CLOSE-OUT ARTIFACT-EVIDENCE GATE (MOTIR-2709). A `type: 'deploy'`
    // card's deliverable lives outside this repository, so "done" is a claim
    // rather than a diff — and it has been a false claim three times. The rule
    // and the reasoning are in `lib/workItems/artifactEvidence.ts`; the gate is
    // HERE because this is the one place every close-out passes through (the
    // detail page, the board drag, the v1 route and the MCP `transition_status`
    // all land on this method), and because the failure is specifically that
    // nobody looked AT THE MOMENT OF CLOSING.
    //
    // It BLOCKS rather than advises, deliberately. The `advisories` channel is
    // computed at authoring/dispatch time and is non-blocking, and a notice
    // delivered to somebody who has by construction just stopped checking is not
    // a safeguard — it is a record of the thing happening again.
    //
    // Scoped the same three ways the manual-provenance stamp below is:
    //   • `cancelled` is EXEMPT — a `done`-CATEGORY status meaning ABANDONED
    //     (MOTIR-2221). A release card that published nothing ON PURPOSE is
    //     exactly what cancelling says, so refusing it would be backwards.
    //   • `opts.system` is EXEMPT — the issue importer (MOTIR-941) brings closed
    //     source issues in as closed, and the downward cascade
    //     (`childStatusCascadeService`) completes children behind a status change
    //     the user already made successfully. Neither is a person deciding this
    //     release is finished, and a background job must not fail on a business
    //     rule. ⚠️ The cascade therefore remains a path by which an
    //     evidence-less `deploy` child can reach done; it is narrower than the
    //     gap this card closes (it needs a human to close the PARENT), and
    //     tightening it belongs with the derivation service, not here.
    //   • The firing set is the named predicate, not an inline `type ===`.
    if (
      target.category === 'done' &&
      toStatusKey !== ROADMAP_CANCELLED_KEY &&
      !opts.system &&
      requiresArtifactEvidence(current.type)
    ) {
      const bodies = await commentRepository.listBodiesByWorkItem(workItemId, tx);
      if (assessArtifactEvidence(bodies).outcome === 'missing') {
        throw new MissingArtifactEvidenceError(toStatusKey);
      }
    }

    // THE CONTAINER-COMPLETENESS GATE (Bug MOTIR-3229). A container may not
    // enter a status that CLAIMS its own work is built — `implemented` or
    // `in_review` — while a live child of its own has not reached `implemented`.
    //
    // WHY IT IS A GATE AND NOT A DERIVATION OUTCOME, which is the part that took
    // a production measurement to settle. MOTIR-1343 was set to `implemented`
    // with two `todo` children, and the derivation run that fired 15 s later
    // returned `rollup: { outcome: 'already_there' }` / `cascade: not_done` — both
    // directions doing exactly what they are specified to do, and NEITHER looking
    // down at the transitioning item's own children: the upward direction rolls up
    // the item's PARENT, and the downward cascade fires only on entry into a
    // done-category status. No trigger exists that would ever contradict such a
    // claim. Derivation was not failing; it was never asked the question. So the
    // question is asked HERE, at the one place every close-out passes through —
    // the detail page, the board drag, the v1 route, the MCP `transition_status`
    // and the CI-green promotion all land on this method.
    //
    // ⚠️ `done` IS DELIBERATELY NOT GUARDED. Completing a parent is a DECISION
    // that completes its children, and §4's downward cascade is the shipped
    // expression of it. A gate there would break the feature rather than the
    // defect — which is why the cascade instead grew an exemption for the one
    // child kind it must not sweep (`childStatusCascadeService`, same card).
    //
    // Scoped like the artifact-evidence gate above:
    //   • `opts.system` is EXEMPT — the importer, the downward cascade and the
    //     rollup's backward arm are background writes behind a change somebody
    //     already made successfully, and a business rule must not fail them. The
    //     forward rollup arm is NOT system, and needs no exemption: it only ever
    //     targets a rung its children actually match.
    //   • A LEAF never reaches the child read — the key test is a string compare,
    //     so the overwhelmingly common transition pays nothing.
    if (!opts.system && CONTAINER_CLAIM_STATUS_KEYS.has(toStatusKey)) {
      const children = await workItemRepository.findChildren(workItemId, tx);
      if (children.length > 0) {
        const statuses = await workflowsService.listStatusesByProject(
          current.projectId,
          ctx.workspaceId,
          tx,
        );
        const open = childrenBelowClaimBar(children, statuses, {
          reviewKey: statuses.find((s) => s.key === 'in_review')?.key ?? null,
          implementedKey: statuses.find((s) => s.key === 'implemented')?.key ?? null,
          // MOTIR-5140 — the third split-out rung. Without it an `approved`
          // child ranks as plain in-progress and this gate refuses a container
          // whose every child has been approved.
          approvedKey: statuses.find((s) => s.key === 'approved')?.key ?? null,
        });
        if (open.length > 0) {
          throw new ContainerHasOpenChildrenError(
            toStatusKey,
            open.map((child) => child.identifier),
          );
        }
      }
    }

    // Build the row write. Reaching a `done`-category status CLEARS the
    // integration branch (Subtask 7.8.11 invariant: done ⇒ sessionBranch null,
    // so a merged dep never leaves a stale lineage for dependents to inherit —
    // `complete_session` rides this, as does any board drag to done). Otherwise
    // apply the explicit branch directive (`mark_integrated`'s move to implemented
    // sets it). The revision diff stays status-only — `sessionBranch` is dispatch
    // bookkeeping, not a content edit, so it never lands in the activity feed (and
    // keeping it out avoids the activity totality guard).
    const update: WorkItemUpdateInput = { status: toStatusKey };
    if (target.category === 'done') {
      update.sessionBranch = null;
      // Manual implementation lane (MOTIR-1685, docs/decisions/work-item-provenance.md):
      // a human-executed / manual-type item reaching a done status with no
      // implementation provenance yet was implemented MANUALLY (no agent report) →
      // stamp `manual`. Guarded FOUR ways: never on `cancelled` (below), NEVER
      // overwrites an existing stamp (a BYOK agent's `mark_integrated` report at
      // in_review wins), NEVER under a `system` bulk set (the importer — those items
      // were implemented in the source tool, provenance stays null/unknown), and ONLY
      // for human/manual work (a coding_agent item dragged to done without a report
      // keeps null, not manual).
      //
      // `cancelled` is a `done`-CATEGORY status that means ABANDONED, not implemented
      // (MOTIR-2221) — so the category alone is the wrong discriminator here and the
      // stamp must be keyed on the status KEY. Nothing was implemented on a cancelled
      // card, so stamping it writes a false claim into a record whose entire value is
      // that it is true. This is the same exclusion `roadmapDoneStatusKeys` (above),
      // `publicProjectsService` (ROADMAP_EXCLUDED_DONE_KEY) and the offline classifier
      // in `lib/workItems/provenanceBackfill.ts` (CANCELLED_STATUS_KEY, whose doc
      // comment cites THIS lane as making it) already make against the terminal set.
      // Clearing `sessionBranch` above is NOT narrowed: an abandoned card should keep
      // no stale lineage either.
      if (
        toStatusKey !== ROADMAP_CANCELLED_KEY &&
        !opts.system &&
        current.implementationSource === null &&
        (current.executor === 'human' || current.type === 'manual')
      ) {
        update.implementationSource = 'manual';
      }
    } else if (branchDirective !== undefined) update.sessionBranch = branchDirective;

    // ── THE COMPLETION STAMP (Story MOTIR-4777 · MOTIR-4780) ──────────────────
    //
    // `work_item.completedAt` records WHEN a card finished, and this is the one
    // place it is ever written. It sits HERE, in the same `update` as the status
    // and therefore inside the same `$transaction` and under the same
    // `lockById`, because the stamp is a fact ABOUT the status write: split them
    // and two racing transitions can produce two stamps, or a stamp with no
    // transition behind it. It is a database write, not a side effect — the
    // post-commit rule above governs `sendEvent`, not this.
    //
    // ⚠️ CATEGORY, NEVER A STATUS KEY. `done` and `cancelled` are what the
    // DEFAULT workflow happens to call its terminal statuses; a project defines
    // its own (`workflow_status` rows, not an enum), so the set is resolved per
    // project through the same `getTerminalStatusKeysByProjects` that
    // `isReady` and `homeService` ask. A hardcoded `'done' | 'cancelled'` pair
    // would be exhaustive over the literal and silent about every status a
    // customer adds — the shape MOTIR-2758 was filed about on the read side.
    // The DESTINATION's category is already in hand (`target.category`); the
    // SOURCE's is not, and that is what the resolver is for.
    //
    // ⚠️ THE READ IS CONDITIONAL, and the condition is the whole cost story.
    // `todo → in_progress` — the overwhelmingly common transition — neither
    // enters nor leaves the done category and pays NOTHING: no query, no write.
    // The resolver runs only when this move can actually change the stamp.
    //
    // Two directions, and the asymmetry is deliberate:
    //
    //   * INTO a done-category status ⇒ stamp, but only when the row has no
    //     stamp yet OR the status it is leaving was not itself done-category.
    //     A `done → cancelled` hop is a move WITHIN the category — the card did
    //     not finish twice, so its completion moment must not move. (The
    //     `completedAt === null` arm is what still stamps a row that reached a
    //     done status before this column existed and was missed by the
    //     migration's backfill.)
    //   * OUT of one ⇒ clear it. A re-opened card has not finished, and leaving
    //     a stale stamp behind would put it in "Recently finished" while it sits
    //     In Progress.
    //
    // ⚠️ `opts.system` is NOT exempt, unlike the artifact-evidence and
    // container-completeness gates above, and unlike the `manual` provenance
    // stamp below — because those three ask *did a human decide this?* and this
    // one asks *when did the row enter a done status?*. The downward cascade
    // (`childStatusCascadeService`) runs `system` and closes children behind a
    // parent somebody completed: those children genuinely finished at that
    // moment, and they are precisely the rows the Workbench exists to show, so
    // exempting `system` would blank the stamp on the commonest completion path
    // in the product. The importer (MOTIR-941) also runs `system`, and a closed
    // source issue therefore lands stamped with the moment it entered a done
    // status IN MOTIR rather than in the source tool — which is what this column
    // is defined to mean, and is the honest answer available, since the import
    // carries no completion time to record instead.
    const entersDone = target.category === 'done';
    if (entersDone || current.completedAt !== null) {
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        [current.projectId],
        ctx.workspaceId,
        tx,
      );
      const doneKeys = terminalByProject.get(current.projectId) ?? new Set<string>();
      if (entersDone) {
        if (current.completedAt === null || !doneKeys.has(fromKey)) update.completedAt = new Date();
      } else if (current.completedAt !== null) {
        update.completedAt = null;
      }
    }

    const row = await workItemRepository.update(workItemId, update, tx);
    const revisionId = await workItemRevisionsService.recordRevision(
      {
        workItemId,
        changedById: ctx.userId,
        changeKind: 'updated',
        diff: { status: { from: fromKey, to: toStatusKey } },
      },
      tx,
    );

    // A CHILD FINISHING RE-ASKS ITS STORY (Bug MOTIR-5903; `approval-gates.md` §1, the
    // MOTIR-5903 amendment, point 3). A story whose receipt was recorded by a subtask is
    // asked for its acceptance only once nothing under it is open — so the write that
    // settles its subtree is the one that must ask. Here, before the commit, so the gate
    // is on the story before the upward rollup job tries to close it. SYSTEM writes
    // included: the cascade and the merge sync finish children too.
    if (entersDone) {
      await reconcileAcceptanceOwnerOf(row, tx);
    }

    // A BLOCKER FINISHING MAY ASK A CHOICE (Story MOTIR-4914 · MOTIR-5891). A choice
    // waiting on this item is asked once its last open blocker reaches `done`, in
    // this transaction — the reconcile re-checks every blocker, so a dependent still
    // waiting on something else is left alone.
    if (entersDone) {
      for (const dependent of await workItemLinkRepository.findDependentStates(workItemId, tx)) {
        const waiting = await workItemRepository.findById(dependent.id, tx);
        if (waiting?.type === 'choice') await reconcileChoiceGate(waiting, ctx, tx);
        else if (waiting && asksTheConfirmQuestion(waiting)) {
          await reconcileDecisionGate(waiting, ctx, tx);
        }
      }
    }

    // ENTERING REVIEW ASKS AGAIN (ADR `approval-gates.md` §6d AMENDMENT, rule 7 ·
    // MOTIR-5532). The mirror of the withdraw above: a card coming back into
    // review has its question raised again over its CURRENT subject, unless that
    // subject already has an awaiting or approved gate. Without it, pulling the
    // work back and returning it would leave a gate-less card the guard cannot
    // hold. SYSTEM moves are included — the CI-green promotion is the ordinary
    // return to review — and the gate locks were taken at the top of this method.
    if (toStatusKey === REVIEW_STATUS_KEY) {
      await approvalGatesService.raiseOnReviewEntry(row, ctx, tx);
    }

    // THE STATUS IS AN INPUT OF THE TO-FIX ANSWER (MOTIR-6602): only an `in_progress`-
    // category card can be waiting on a repair, and the repair predicate reads the
    // Implemented / In Review rung. So every move re-decides it — leaving the category
    // clears it, a promotion or a hold re-reads it — here, after the status write and
    // under the card lock this method already holds. SYSTEM moves included: the cascade,
    // the merge sync and the CI promotion all come through here.
    await recomputeWorkItemFixReason(workItemId, tx);
    // …and so is it of To resume's (MOTIR-7707): leaving the category takes the card off.
    await recomputeWorkItemResumeState(workItemId, tx);

    return {
      dto: toWorkItemDto(row),
      transition: { fromStatusKey: fromKey, toStatusKey, revisionId },
    };
  },

  /**
   * Integrate a work item onto a session branch (Story 7.8 · Subtask 7.8.11) —
   * the write the 7.9 CLI loop calls on agent success. ONE transaction:
   * transition the item to `in_review` (the same legal-transition validation
   * every status move runs — an item that can't legally reach `in_review` from
   * its current status throws `IllegalTransitionError` and the field is NEVER
   * touched, since the throw precedes the write) AND record `session_branch`.
   * From then on the item is integrated-awaiting-review: it unblocks dependents
   * (the field-keyed readiness rule) and the branch travels with it for prompt
   * generation. Re-marking an item already in `in_review` to a NEW branch updates
   * the field with no spurious revision (the no-op-status branch-write path).
   * Emits `work-item/transitioned` post-commit like `updateStatus`.
   */
  /**
   * Record IMPLEMENTATION provenance (Story MOTIR-1685) on an item — the single
   * reusable entry point that persists the `implementation{Source,Harness,Model}`
   * triple inside a caller-supplied transaction. Callable independently of the
   * session tools: the BYOK/manual session report-back rides it now
   * (`markIntegrated` / `completeSession`), and Epic 9's HOSTED runner will call
   * the SAME method with trusted, gateway-metered values — so the recording seam
   * lives here, not welded to the MCP tools. Assumes the caller has already gated
   * the item (the session flows lock + tenant/access-check it via
   * `applyStatusTransition` in the same `tx`). `harness`/`model` are recorded
   * as-is (self-reported; no verification implied for byok/manual). Required `tx`.
   *
   * ⚠️ A PARTIAL REPORT UPDATES ONLY WHAT IT REPORTS (MOTIR-2447). `harness` and
   * `model` distinguish three states, and all three are load-bearing:
   *
   *   • OMITTED (`undefined`) — the caller does not know. The stored value is
   *     left exactly as it is.
   *   • `null` — the caller knows there is none, and clears it.
   *   • a string — the caller's report, recorded verbatim.
   *
   * Collapsing the first two (`harness ?? null`) is what made the close-out
   * erase the run's own record: `motir auto` stamped the agent and its model at
   * integration, and `motir done --session` — which knows only that the work was
   * BYOK — overwrote both with what it happened to hold. Every caller here holds
   * a DIFFERENT subset (the loop: harness + model; the close-out: source alone;
   * a hosted runner: all three), so a report has to be able to say nothing about
   * a field without that meaning "there is nothing".
   */
  async recordImplementationProvenance(
    workItemId: string,
    provenance: WorkItemImplementationProvenanceInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    return workItemRepository.update(
      workItemId,
      {
        implementationSource: provenance.source,
        ...(provenance.harness === undefined ? {} : { implementationHarness: provenance.harness }),
        ...(provenance.model === undefined ? {} : { implementationModel: provenance.model }),
      },
      tx,
    );
  },

  /**
   * BACKFILL provenance across one project's pre-provenance rows (MOTIR-1758) —
   * the orchestration behind `pnpm db:backfill:provenance`.
   *
   * Story MOTIR-1685 stamps provenance at every write seam, but only for rows
   * written after it landed; this repairs the history that predates it, from
   * evidence already in the database. The rules live in
   * `lib/workItems/provenanceBackfill.ts` (a pure decision table); this method
   * owns the reads, the grouping and the transaction, and NEVER invents a value
   * — `planningHarness` / `planningModel` / `implementationHarness` /
   * `implementationModel` are never written, and `hosted` is unreachable.
   *
   * IDEMPOTENT BY CONSTRUCTION, no row lock needed: every write is a
   * null-guarded `updateMany`, so a row that gained provenance between the
   * sweep read and the write falls out of the update. A second consecutive run
   * reports zero writes, and a concurrent MCP create is never clobbered.
   *
   * `dryRun` runs the entire decision pass and returns the same report with
   * every `written` at 0 and no transaction opened — the rehearsal this needs
   * because its target is the live tenant.
   *
   * Operator-shaped, so it takes an `actorUserId` rather than a `ServiceContext`
   * (there is no session) and binds the workspace GUC via `withWorkspaceContext`
   * exactly as `boardsService.backfillDefaultBoard` does — the RLS-correct path
   * for a script's writes under the non-bypass `motir_app` role.
   */
  async backfillProvenanceForProject(
    projectId: string,
    actorUserId: string,
    opts: { dryRun?: boolean; seedBurstEnd?: Date } = {},
  ): Promise<ProvenanceBackfillReport> {
    // MOTIR-2569: the same operator-shaped resolution as
    // `boardsService.backfillDefaultBoard` / `workflowsService.backfillDefaultWorkflow`
    // — there is no session and the workspace this would bind is what the read
    // RESOLVES, so it runs under the `app.system_admin` arm the `project` policy
    // carries for operator tooling. Everything after it already binds
    // `withWorkspaceContext` with the workspace resolved here.
    const project = await withSystemContext((tx) => projectRepository.findById(projectId, tx));
    if (!project) throw new ProjectNotFoundError(projectId);

    const dryRun = opts.dryRun ?? false;
    const seedBurstEnd = opts.seedBurstEnd ?? MOTIR_SEED_BURST_END;

    // "Implemented" = the project's own done-category set MINUS `cancelled`
    // (which the default workflow files under `done` too, but which means
    // abandoned, not shipped). Per-project rather than a `'done'` literal, so a
    // custom workflow's terminal states are honoured.
    const terminalKeys = await workflowsService.getTerminalStatusKeys(
      projectId,
      project.workspaceId,
    );
    const implementedStatusKeys = new Set(
      [...terminalKeys].filter((key) => key !== CANCELLED_STATUS_KEY),
    );

    const rows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.findProvenanceBackfillCandidates(projectId, project.workspaceId, tx),
    );

    const report: ProvenanceBackfillReport = {
      projectIdentifier: project.identifier,
      dryRun,
      seedBurstEnd,
      implementedStatusKeys: [...implementedStatusKeys].sort(),
      candidates: rows.length,
      archivedCandidates: rows.filter((r) => r.archivedAt !== null).length,
      createdAtOrBeforeBoundary: 0,
      createdAfterBoundary: 0,
      planning: { manual: emptyProvenanceBucket(), mcp: emptyProvenanceBucket() },
      implementation: { byok: emptyProvenanceBucket(), manual: emptyProvenanceBucket() },
      implementationLeftNull: { alreadyStamped: 0, notImplementedYet: 0, doneWithoutEvidence: 0 },
    };

    const planningIds: Record<'manual' | 'mcp', string[]> = { manual: [], mcp: [] };
    const implementationIds: Record<'byok' | 'manual', string[]> = { byok: [], manual: [] };

    for (const row of rows) {
      const candidate = {
        id: row.id,
        identifier: row.identifier,
        createdAt: row.createdAt,
        status: row.status,
        type: row.type,
        executor: row.executor,
        planningSource: row.planningSource,
        implementationSource: row.implementationSource,
        hasLinkedPr: row.deliveries.length > 0,
        sessionBranch: row.sessionBranch,
      };
      if (candidate.createdAt.getTime() <= seedBurstEnd.getTime())
        report.createdAtOrBeforeBoundary += 1;
      else report.createdAfterBoundary += 1;

      const verdict = classifyProvenance(candidate, { seedBurstEnd, implementedStatusKeys });

      if (verdict.planningSource !== null) {
        addToProvenanceBucket(report.planning[verdict.planningSource], candidate.identifier);
        planningIds[verdict.planningSource].push(candidate.id);
      }

      if (verdict.implementationSource !== null) {
        addToProvenanceBucket(
          report.implementation[verdict.implementationSource],
          candidate.identifier,
        );
        implementationIds[verdict.implementationSource].push(candidate.id);
      } else if (candidate.implementationSource !== null) {
        report.implementationLeftNull.alreadyStamped += 1;
      } else if (!implementedStatusKeys.has(candidate.status)) {
        report.implementationLeftNull.notImplementedYet += 1;
      } else {
        report.implementationLeftNull.doneWithoutEvidence += 1;
      }
    }

    if (dryRun) return report;

    await withWorkspaceContext(
      { userId: actorUserId, workspaceId: project.workspaceId },
      async (tx) => {
        for (const source of ['manual', 'mcp'] as const) {
          report.planning[source].written = await workItemRepository.backfillPlanningSourceByIds(
            planningIds[source],
            source,
            tx,
          );
        }
        for (const source of ['byok', 'manual'] as const) {
          report.implementation[source].written =
            await workItemRepository.backfillImplementationSourceByIds(
              implementationIds[source],
              source,
              tx,
            );
        }
      },
    );

    return report;
  },

  /**
   * Record implementation provenance WITHOUT asserting integration (MOTIR-2421)
   * — what built a work item, said on its own.
   *
   * `markIntegrated` was the only path that wrote the triple, and its subject is
   * the session branch: the branch is a required positional there, and the v1
   * endpoint behind it requires it in the body. So provenance inherited a
   * precondition it has nothing to do with, and `motir batch` — which opens ONE
   * pull request per item off `main` and therefore has no branch — could not
   * record any. Every card it ever ran carries a null triple.
   *
   * ⚠️ THIS METHOD MUST NEVER TOUCH `session_branch`, AND THAT IS THE POINT. A
   * recorded branch is not an annotation: `isOpenBlocker` reads one as evidence
   * that a blocker is satisfied, which is how a run cascades through a
   * dependency chain with nothing merged. Inventing a branch here so the
   * existing call could be reused — the short road, and the one anybody reaches
   * for first — would make batch-run items stop blocking their dependents
   * without a merge, and would enrol them in a `motir done --session` close-out
   * they were never part of. A null column is a gap; that would be corruption
   * wearing a fix's clothes.
   *
   * It moves no status either. The caller has already put the item wherever it
   * belongs (`motir batch` transitions to In Review when the agent opens its own
   * pull request); this says only what built the work. "What built this" and
   * "where is it integrated" are independent facts that used to share one write.
   *
   * Gated exactly like the mutation routes: `getWorkItem` does the tenant check
   * + browse gate (so a cross-tenant key 404s before anything is written), and
   * `assertCanEdit` then gates the WRITE on `work_item:edit` — the same key
   * `markIntegrated` and `completeSession` reach through
   * `applyStatusTransition`. It was `getWorkItem` alone until MOTIR-2603, i.e. a
   * read permission gating a write: a browse-only actor could stamp
   * `implementationSource` / `harness` / `model` on any item they could see. The
   * edit assert runs INSIDE the transaction, threaded the same `tx` as the
   * write, so the gate reads the state the write commits against.
   */
  async reportImplementation(
    workItemId: string,
    ctx: ServiceContext,
    implementation: { source?: 'byok' | 'manual'; harness?: string | null; model?: string | null },
  ): Promise<WorkItemDto> {
    const item = await workItemsService.getWorkItem(workItemId, ctx);
    const row = await withWorkspaceContext(ctx, async (tx) => {
      await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
      return workItemsService.recordImplementationProvenance(
        workItemId,
        { source: implementation.source ?? 'byok', ...implementation },
        tx,
      );
    });
    return toWorkItemDto(row);
  },

  async markIntegrated(
    workItemId: string,
    sessionBranch: string,
    ctx: ServiceContext,
    implementation?: { source?: 'byok' | 'manual'; harness?: string | null; model?: string | null },
  ): Promise<WorkItemDto> {
    const { dto, transition } = await withWorkspaceContext(ctx, async (tx) => {
      // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES: `mark_integrated` is an
      // agent's door, typed by MOTIR-6673; only a LEGACY card marked while open can
      // meet it, since a card marked under the rule is `done`.
      const res = await workItemsService.applyStatusTransition(
        workItemId,
        IMPLEMENTED_STATUS_KEY,
        ctx,
        tx,
        { sessionBranch },
      );
      // BYOK/manual self-report (MOTIR-1685): the external agent reports the
      // harness + model it ran with AT integration time; `source` defaults to
      // `byok` (a self-reported machine — `hosted` is never accepted on this
      // self-reported seam). Omitted → the implementation triple is untouched.
      if (implementation) {
        const row = await workItemsService.recordImplementationProvenance(
          workItemId,
          {
            source: implementation.source ?? 'byok',
            harness: implementation.harness,
            model: implementation.model,
          },
          tx,
        );
        return { dto: toWorkItemDto(row), transition: res.transition };
      }
      return res;
    });
    if (transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: dto.id,
        actorId: ctx.userId,
        fromStatusKey: transition.fromStatusKey,
        toStatusKey: transition.toStatusKey,
        revisionId: transition.revisionId,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
      // The session-lineage arm arrives at `implemented` through THIS write, not
      // through `updateStatus`, so the latch is owed here too (MOTIR-3006).
      await latchCiGreen(dto.id, transition.toStatusKey, ctx);
    }
    return dto;
  },

  /**
   * Bulk close-out a session branch (Story 7.8 · Subtask 7.8.11) — run after a
   * human merges the session PR. Every work item recorded on `sessionBranch`
   * (workspace-scoped) is transitioned to `done` (which CLEARS the branch via the
   * `applyStatusTransition` done-invariant) in ONE transaction. The legal-
   * transition + status-lookup checks run BEFORE any write, so a per-item
   * rejection (an illegal path to done, an unknown `done` status in a custom
   * workflow, or an access denial) is caught and surfaced as a `failed` result
   * WITHOUT aborting the transaction — the items that CAN complete still commit.
   * An item already in `done` is an idempotent no-op (`already_done`), its branch
   * cleared defensively. Emits `work-item/transitioned` for each completed item
   * post-commit. An empty branch (no recorded items) returns an empty result.
   */
  async completeSession(
    sessionBranch: string,
    ctx: ServiceContext,
    implementation?: { source?: 'byok' | 'manual'; harness?: string | null; model?: string | null },
  ): Promise<CompleteSessionResultDto> {
    const items = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findBySessionBranch(sessionBranch, ctx.workspaceId, tx),
    );
    if (items.length === 0) return { sessionBranch, results: [] };
    // A run token completes only a session of its own run's cards (MOTIR-6557):
    // every card on the branch must be a leg or the run's scope.
    await runTokenScopeService.assertReachesWorkItems(
      items.map((item) => item.id),
      ctx,
    );

    const { results, transitions } = await withWorkspaceContext(ctx, async (tx) => {
      const results: CompleteSessionItemResultDto[] = [];
      const transitions: Array<{
        id: string;
        fromStatusKey: string;
        toStatusKey: string;
        revisionId: string;
      }> = [];
      for (const item of items) {
        try {
          // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): `done` is the done
          // category, and the mark refuses only a move out of it.
          const { dto, transition } = await workItemsService.applyStatusTransition(
            item.id,
            DONE_STATUS_KEY,
            ctx,
            tx,
          );
          if (transition) {
            transitions.push({ id: dto.id, ...transition });
            results.push({ key: item.identifier, outcome: 'completed' });
          } else {
            // Already in the done status — the move was a no-op. Clear any
            // lingering branch so a dependent never re-inherits it (normally a
            // done item's branch is already null; this is the invariant guard).
            if (dto.sessionBranch !== null) {
              await workItemRepository.update(item.id, { sessionBranch: null }, tx);
            }
            results.push({ key: item.identifier, outcome: 'already_done' });
          }
          // BYOK/manual self-report at merge (MOTIR-1685): when the close-out run
          // reports the harness + model it used, stamp implementation provenance
          // on every item it closes on the branch (completed AND already-done).
          // `source` defaults to `byok`; a failed item threw before here, so it is
          // never stamped. Omitted → the manual-lane stamp (for human/manual items)
          // and any prior `mark_integrated` report stand untouched.
          if (implementation) {
            await workItemsService.recordImplementationProvenance(
              item.id,
              {
                source: implementation.source ?? 'byok',
                harness: implementation.harness,
                model: implementation.model,
              },
              tx,
            );
          }
        } catch (err) {
          // A per-item REFUSAL is surfaced, not fatal — every member of the
          // refusal set throws BEFORE the write, so the transaction stays healthy
          // for the remaining items.
          //
          // ⚠️ THE PREDICATE, not a hand-written `instanceof` ladder (MOTIR-3364).
          // This was such a ladder, listing three of the six, and the omission was
          // invisible until it fired: one evidence-less `deploy` card on a session
          // branch rethrew from inside this `withWorkspaceContext` transaction, so
          // the throw did not merely fail that item — it ROLLED BACK every sibling
          // the loop had already closed, and `motir done --session` reported
          // nothing at all. One card blocked N. `isStatusTransitionRefusal` is
          // shared with the merge-driven sync so both consumers inherit the next
          // gate without an edit.
          if (isStatusTransitionRefusal(err)) {
            results.push({ key: item.identifier, outcome: 'failed', reason: err.message });
          } else {
            throw err;
          }
        }
      }
      return { results, transitions };
    });

    for (const t of transitions) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: t.id,
        actorId: ctx.userId,
        fromStatusKey: t.fromStatusKey,
        toStatusKey: t.toStatusKey,
        revisionId: t.revisionId,
        ...(ctx.viaAutomationRuleId ? { viaAutomationRuleId: ctx.viaAutomationRuleId } : {}),
      });
    }
    return { sessionBranch, results };
  },

  /**
   * Assign (or un-assign, with null) a work item. Thin specialization of
   * updateWorkItem for the common case — the membership check on a non-null
   * assignee happens inside updateWorkItem against the item's own workspace,
   * so this stays a one-field patch.
   */
  async assignWorkItem(
    id: string,
    assigneeId: string | null,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return workItemsService.updateWorkItem(id, { assigneeId }, ctx);
  },

  /**
   * Soft-delete (archive) a work item: stamp archivedAt + record the
   * revision, in one transaction. Children are deliberately LEFT INTACT (the
   * Linear shape): archiving a node hides only that node from active views;
   * its descendants stay live (and simply drop out of any subtree filtered to
   * non-archived ancestors). A destructive tree-delete is a separate,
   * explicit action — never a side effect of archive.
   *
   * ⚠️ GATED ON `work_item:archive`, NOT `work_item:delete` (MOTIR-3629). The
   * paragraph above is the reason: the key that governs this had been named after
   * an operation this one is not, on a rationale — R42's "cascades over a
   * subtree" — that the sentence "children are deliberately LEFT INTACT"
   * directly falsifies. A `work_item:delete` grant still reaches this method,
   * because holding the irreversible destroy confers the reversible hide at
   * resolution (`PERMISSION_IMPLICATIONS`); what changed is that a role or token
   * can now hold the hide WITHOUT the destroy, which is what a member holds.
   */
  async archiveWorkItem(id: string, ctx: ServiceContext): Promise<WorkItemDto> {
    const { dto, parentId } = await withWorkspaceContext(ctx, async (tx) => {
      // Resolve + tenant-gate first so the access gate (6.4.3) has the item's
      // project, and a cross-workspace id is a 404 (no existence leak) before
      // the archive write.
      const current = await workItemRepository.findById(id, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
      await projectAccessService.assertPermission(current.projectId, ctx, 'work_item:archive', tx);

      // Archiving abandons the work, so every question still waiting on it is
      // withdrawn — gates first, in the decide door's lock order (MOTIR-7109).
      await withdrawQuestionsOnArchive(id, tx);
      const row = await workItemRepository.archive(id, tx); // throws WorkItemNotFoundError if absent
      // An archived card is waiting on no repair (MOTIR-6602), nor on a gate (MOTIR-7707).
      await recomputeWorkItemFixReason(id, tx);
      await recomputeWorkItemResumeState(id, tx);

      // The container ROLLUP (MOTIR-2978, §A6): an ARCHIVED descendant contributes
      // nothing to its ancestors' union — a parent is not waiting on work archived
      // out of it — so archiving is a recompute trigger like any set change.
      await recomputeAncestorRepoSets(id, ctx.workspaceId, tx);
      await workItemRevisionsService.recordRevision(
        {
          workItemId: id,
          changedById: ctx.userId,
          changeKind: 'archived',
          diff: { archivedAt: { from: null, to: row.archivedAt?.toISOString() ?? null } },
        },
        tx,
      );
      return { dto: toWorkItemDto(row), parentId: current.parentId };
    });

    // Status derivation, child-set trigger (Story MOTIR-2888 · MOTIR-2892, ADR
    // §3a). An archived child LEAVES its parent's aggregate — every child read
    // excludes `archivedAt IS NOT NULL` — so archiving the last open child of a
    // parent completes it. Post-commit, and only when there is a parent to
    // recompute.
    if (parentId) {
      await sendEvent('work-item/child-set.changed', {
        workspaceId: ctx.workspaceId,
        parentIds: [parentId],
        workItemId: id,
        reason: 'archived',
        // The edit's own instant: this row is LEAVING the aggregate, so nothing
        // it can read dates the change (MOTIR-2965).
        occurredAt: new Date().toISOString(),
      });
    }
    return dto;
  },

  /**
   * Restore (unarchive) a soft-deleted work item — the inverse of
   * {@link archiveWorkItem}, the Jira "restore" action (Subtask 7.8.14). Clears
   * `archivedAt` and records an `'unarchived'` revision, so the item returns to
   * active views (`list_ready` / search) and the History feed shows the restore
   * the same way it shows the archive. Same tenant-gate + `work_item:archive`
   * gate as archive (MOTIR-3629) — restoring is the inverse of a reversible act,
   * so it can never be the tighter of the two. The `from` in the revision diff is the archived timestamp the row
   * carried before the restore (null if it was already live — a no-op restore).
   */
  async unarchiveWorkItem(id: string, ctx: ServiceContext): Promise<WorkItemDto> {
    const { dto, parentId } = await withWorkspaceContext(ctx, async (tx) => {
      const current = await workItemRepository.findById(id, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
      await projectAccessService.assertPermission(current.projectId, ctx, 'work_item:archive', tx);

      const wasArchivedAt = current.archivedAt?.toISOString() ?? null;
      const row = await workItemRepository.unarchive(id, tx); // throws WorkItemNotFoundError if absent
      // …and a restored one may be again (MOTIR-6602, MOTIR-7707).
      await recomputeWorkItemFixReason(id, tx);
      await recomputeWorkItemResumeState(id, tx);

      // …and unarchiving puts it back, which is the same trigger in reverse.
      await recomputeAncestorRepoSets(id, ctx.workspaceId, tx);
      await workItemRevisionsService.recordRevision(
        {
          workItemId: id,
          changedById: ctx.userId,
          changeKind: 'unarchived',
          diff: { archivedAt: { from: wasArchivedAt, to: null } },
        },
        tx,
      );
      return { dto: toWorkItemDto(row), parentId: current.parentId };
    });

    // The mirror of archive's trigger (MOTIR-2892, ADR §3a): a restored child
    // RE-ENTERS its parent's aggregate, so unarchiving an open child brings a
    // completed parent back.
    if (parentId) {
      await sendEvent('work-item/child-set.changed', {
        workspaceId: ctx.workspaceId,
        parentIds: [parentId],
        workItemId: id,
        reason: 'unarchived',
        // The edit's own instant: this row is LEAVING the aggregate, so nothing
        // it can read dates the change (MOTIR-2965).
        occurredAt: new Date().toISOString(),
      });
    }
    return dto;
  },

  /**
   * PERMANENT delete (Story 2.8 · Subtask 2.8.2) — the destructive, irreversible
   * counterpart of {@link archiveWorkItem}, Jira-parity ("Delete Issues"). Removes
   * the item AND its ENTIRE subtree (every descendant), plus their links / comments
   * / watchers / custom-field values / etc., in ONE transaction.
   *
   * Flow (lock → gate → resolve → audit → delete):
   *  1. FOR-UPDATE lock the root, then re-read + tenant-gate (a cross-workspace or
   *     already-deleted id is a 404 `WorkItemNotFoundError` — the "already-deleted"
   *     race, translated to a typed error). The lock serializes against a concurrent
   *     delete/move of the SAME root (lock-before-read-derived).
   *  2. Permission gate: delete is more privileged than edit — it is the project
   *     **manage** capability (Jira "Delete Issues" defaults to project admins;
   *     `assertCanManage` = project admin or workspace owner/admin, the 6.4 gate),
   *     NOT `assertCanEdit`.
   *  3. Resolve the full subtree id set via `findSubtree` (root + descendants).
   *  4. Write the audit record. The deleted rows — and their OWN revisions (FK
   *     `onDelete: Cascade`) — vanish, so the surviving trace is a `deleted`
   *     revision on the root's PARENT (the `comment_deleted` precedent: history
   *     records the deletion on a surviving neighbour). A TOP-LEVEL item has no
   *     surviving parent to anchor to, so its deletion leaves no per-item History
   *     entry — a project-scoped audit log is a separate capability (not in 2.8),
   *     noted for a follow-up.
   *  5. `deleteSubtree` removes the rows in one statement; every other inbound FK
   *     is `Cascade`/`SetNull` so no orphaned links or rows survive.
   *
   * Idempotent-safe: a missing id throws `WorkItemNotFoundError` (→ 404), never a
   * raw Prisma error. Returns nothing — the rows are gone, there is no DTO to map.
   */
  async deleteWorkItem(id: string, ctx: ServiceContext): Promise<void> {
    const parentId = await withWorkspaceContext(ctx, async (tx) => {
      // 1. Lock the root + tenant-gate (404 on cross-workspace / already-deleted).
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const root = await workItemRepository.findById(id, tx);
      if (!root || root.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);

      // 2. Permission gate — `work_item:delete` (MOTIR-2354). It was
      //    `assertCanManage`, i.e. `project:administer`, while the DRY RUN below
      //    (`getDeletePreview`) was mapped in the inventory to `work_item:delete`:
      //    a destroy and its own preview cannot be governed by different keys.
      //    Both now ask the same one, which admin holds and member does not.
      await projectAccessService.assertPermission(root.projectId, ctx, 'work_item:delete', tx);

      // 3. Resolve the full subtree (root + every descendant) in one round-trip.
      const subtree = await workItemRepository.findSubtree(id, tx);
      const ids = subtree.map((r) => r.id);
      const descendantCount = ids.length - 1;

      // 4. Audit on the surviving parent (the deleted rows' own revisions cascade
      //    away). A top-level item has no parent anchor — see the doc-comment.
      if (root.parentId) {
        const summary =
          descendantCount > 0
            ? `${root.identifier}: ${root.title} (+${descendantCount} descendant${descendantCount === 1 ? '' : 's'})`
            : `${root.identifier}: ${root.title}`;
        await workItemRevisionsService.recordRevision(
          {
            workItemId: root.parentId,
            changedById: ctx.userId,
            changeKind: 'deleted',
            diff: { deleted: { from: summary, to: null } },
          },
          tx,
        );
      }

      // 5. Delete the subtree; links / comments / etc. cascade at the DB layer.
      await workItemRepository.deleteSubtree(ids, tx);

      // 6. The container ROLLUP (MOTIR-2978, §A6). The deleted rows' references
      //    went with them (the join table cascades on `work_item`), so the union
      //    the ancestors derive has already shrunk — but nothing has RE-DERIVED it
      //    yet, and a stored derived set does not update itself. Recomputed from
      //    the surviving parent upward, INCLUDING it: the parent's own set just
      //    changed and there is no longer a child to walk up from.
      if (root.parentId !== null) {
        await recomputeContainerAndAncestors(root.parentId, ctx.workspaceId, tx);
      }
      return root.parentId;
    });

    // Status derivation, child-set trigger (MOTIR-2892, ADR §3a). The deleted
    // root's own parent SURVIVES and has one fewer child — deleting the last
    // open child of a parent completes it. Only the root's parent needs it:
    // every other parent in the subtree went with the subtree.
    if (parentId) {
      await sendEvent('work-item/child-set.changed', {
        workspaceId: ctx.workspaceId,
        parentIds: [parentId],
        workItemId: id,
        reason: 'deleted',
        // The edit's own instant: this row is LEAVING the aggregate, so nothing
        // it can read dates the change (MOTIR-2965).
        occurredAt: new Date().toISOString(),
      });
    }
  },

  /**
   * The cascade IMPACT of a permanent delete (Story 2.8 · Subtask 2.8.7) — the
   * READ counterpart of {@link deleteWorkItem} that the 2.8.4 confirm dialog
   * shows BEFORE the user commits, so the irreversible cascade is named in
   * words. Returns the subtree size (the "Delete N items" magnitude), the
   * descendant count, and the per-kind breakdown of the DESCENDANTS.
   *
   * It ALSO splits out the LIVE (non-archived) descendants (Story 2.9 · Subtask
   * 2.9.9): archiving is single-node (a parent's children stay live), so an
   * archived parent can still own non-archived descendants on the active
   * boards/lists that the cascade delete would ALSO destroy. `totalCount` /
   * `descendantCount` / `byKind` remain the FULL cascade count (live + archived);
   * `liveDescendantCount` / `liveByKind` are the live subset the archived-item
   * confirm modal (2.9.10) warns about.
   *
   * Gated on the SAME `assertCanManage` capability `deleteWorkItem` requires: a
   * viewer who could not perform the delete must not be able to probe the
   * subtree shape (no impact-preview leak). Tenant-gated identically — a missing
   * / cross-workspace id is a 404 `WorkItemNotFoundError`, no existence leak. A
   * pure read: no lock, no transaction (the gate + the reads are independent, and
   * a benign race just yields a slightly stale count the confirm tolerates; the
   * delete itself re-resolves the subtree under a FOR-UPDATE lock).
   */
  async getDeletePreview(id: string, ctx: ServiceContext): Promise<WorkItemDeletePreviewDto> {
    // Resolve + tenant-gate (404 on cross-workspace / missing) before the gate,
    // so the access check has the item's project and an unknown id never leaks.
    const root = await readWorkItem(id, ctx);
    if (!root || root.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
    await projectAccessService.assertPermission(root.projectId, ctx, 'work_item:delete');

    // One recursive-CTE round-trip: root + every descendant, each with its kind.
    // Both CTE reads share ONE bound transaction (MOTIR-2846) — they are this
    // method's own contiguous read run, and unbound they return zero rows and
    // the preview reports an empty subtree for an item that has children.
    const [subtree, liveCounts] = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      Promise.all([
        workItemRepository.findSubtree(id, tx),
        workItemRepository.countLiveDescendantsByKind(id, tx),
      ]),
    );
    const byKind: Partial<Record<WorkItemKindDto, number>> = {};
    for (const row of subtree) {
      if (row.id === id) continue; // the breakdown counts DESCENDANTS only
      const kind = row.kind as WorkItemKindDto;
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const totalCount = subtree.length;

    // The live (non-archived) descendant slice — counted by kind in SQL (root
    // excluded). A strict subset of `byKind`: archived descendants are in the
    // full breakdown but not here.
    const liveByKind: Partial<Record<WorkItemKindDto, number>> = {};
    let liveDescendantCount = 0;
    for (const { kind, count } of liveCounts) {
      liveByKind[kind as WorkItemKindDto] = count;
      liveDescendantCount += count;
    }

    return { totalCount, descendantCount: totalCount - 1, byKind, liveDescendantCount, liveByKind };
  },

  /**
   * Re-parent and/or reorder a work item atomically. Position is minted by
   * fractional indexing between the named neighbors, so a reorder is a single
   * O(1) write with no sibling cascade:
   *   - beforeId + afterId → keyBetween(before, after)
   *   - beforeId only (afterId null)  → append after beforeId
   *   - afterId only  (beforeId null) → prepend before afterId
   *   - neither → keep the current position (same parent) or take the first
   *     key (moved into an otherwise-empty new parent).
   * A move that changes nothing (same parent, same resulting position) is a
   * no-op: no write, no revision.
   */
  async moveWorkItem(
    id: string,
    input: MoveWorkItemInput,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const { dto, movedBetween } = await withWorkspaceContext(ctx, async (tx) => {
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current) throw new WorkItemNotFoundError(id);

      // Project access gate (6.4.3): re-parent / reorder is an edit.
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

      const targetParentId = input.newParentId !== undefined ? input.newParentId : current.parentId;
      const parentChanged = targetParentId !== current.parentId;

      if (parentChanged) {
        if (targetParentId === null) {
          assertValidParent(null, current.kind);
        } else {
          const parent = await workItemRepository.findById(targetParentId, tx);
          if (!parent) throw new WorkItemNotFoundError(targetParentId);
          if (parent.projectId !== current.projectId) throw new CrossProjectParentError();
          assertValidParent(parent.kind, current.kind);
          // New work under a MARKED card is refused (MOTIR-6672). A reorder
          // beneath the same parent is not new work and never reaches here.
          assertNotMarkedParent(parent, current.identifier);
        }
      }

      // Resolve neighbor positions to bracket the new slot.
      const beforePos = input.beforeId
        ? ((await workItemRepository.findById(input.beforeId, tx))?.position ?? null)
        : null;
      const afterPos = input.afterId
        ? ((await workItemRepository.findById(input.afterId, tx))?.position ?? null)
        : null;

      let newPosition: string;
      if (input.beforeId == null && input.afterId == null) {
        // No neighbors given: keep position when the parent is unchanged;
        // otherwise the item lands first in its new (assumed-empty) parent.
        newPosition = parentChanged ? keyForAppend(null) : current.position;
      } else {
        newPosition = keyBetween(beforePos, afterPos);
      }

      if (!parentChanged && newPosition === current.position) {
        return { dto: toWorkItemDto(current), movedBetween: null }; // true no-op
      }

      const update: WorkItemUpdateInput = {
        parentId: targetParentId,
        position: newPosition,
      };
      const diff: Record<string, DiffCell> = {};
      if (parentChanged) diff.parentId = { from: current.parentId, to: targetParentId };
      // The other half of the parent-XOR-folder rule (MOTIR-5313): an item given
      // a work-item parent leaves its folder in the same write, or the
      // `work_item_parent_xor_folder` CHECK would refuse it.
      if (parentChanged && targetParentId !== null && current.folderId !== null) {
        update.folderId = null;
        diff.folderId = { from: current.folderId, to: null };
      }
      if (newPosition !== current.position) {
        diff.position = { from: current.position, to: newPosition };
      }

      const row = await workItemRepository.update(id, update, tx);
      await workItemRevisionsService.recordRevision(
        { workItemId: id, changedById: ctx.userId, changeKind: 'updated', diff },
        tx,
      );
      // The container ROLLUP across a MOVE (MOTIR-2978, §A6) — both chains, the
      // one left and the one joined, for the same reason the patch path does it.
      // Gated on `parentChanged`: a pure REORDER moves no repository anywhere.
      if (parentChanged) {
        if (current.parentId !== null) {
          await recomputeContainerAndAncestors(current.parentId, ctx.workspaceId, tx);
        }
        await recomputeAncestorRepoSets(id, ctx.workspaceId, tx);
      }

      return {
        dto: toWorkItemDto(row),
        // A pure REORDER changes no parent's child SET, so it derives nothing.
        movedBetween: parentChanged
          ? { previousParentId: current.parentId, newParentId: targetParentId }
          : null,
      };
    });

    // Status derivation, child-set trigger (Story MOTIR-2888 · MOTIR-2892, ADR
    // §3a) — and, until now, this function emitted NOTHING AT ALL, so a
    // `move_to_parent` was invisible to every job in the system.
    //
    // BOTH parents are recomputed, because one move changes two child sets in
    // opposite directions: the previous parent may now be finished (its last
    // open child left) and the new one may need to come back (it just gained
    // one). Either end may be null — an item moved to or from the top level —
    // and a move with no parent on either side emits nothing.
    if (movedBetween) {
      // At least one end is non-null by construction: `parentChanged` means the
      // two differ, so they cannot both be null.
      const parentIds = [movedBetween.previousParentId, movedBetween.newParentId].filter(
        (p): p is string => p !== null,
      );
      await sendEvent('work-item/child-set.changed', {
        workspaceId: ctx.workspaceId,
        parentIds,
        workItemId: id,
        reason: 'reparented',
        // The edit's own instant: this row is LEAVING the aggregate, so nothing
        // it can read dates the change (MOTIR-2965).
        occurredAt: new Date().toISOString(),
      });
    }
    return dto;
  },

  /**
   * File a work item into a folder, or take it out of one (Epic MOTIR-5307 ·
   * Story MOTIR-5308 · MOTIR-5313). `foldersService.fileWorkItem` is the
   * folder-domain door onto this.
   *
   * Filing sets `folderId` and clears `parentId` in ONE write, and appends the
   * item after the folder's last filed item. The item's SUBTREE is untouched:
   * its children keep their own `parentId`, so they travel with it.
   *
   * ⚠️ WHY IT LIVES HERE AND NOT IN THE FOLDER SERVICE. Filing an item that has
   * a work-item parent is a re-parent to the root, so it owes exactly what
   * `moveWorkItem` owes the parent it leaves — the container repository rollup
   * and the `work-item/child-set.changed` event that re-derives that parent's
   * status — and those helpers belong to this file.
   *
   * Taking an item OUT of its folder (`folderId: null`) returns it to the root.
   * A SUBTASK cannot go there: its must-have-a-parent rule is satisfied by a
   * folder (the epic's decision), and without one it has neither, so the kind
   * rule refuses with the same typed error it raises everywhere else.
   */
  async fileWorkItem(
    workItemId: string,
    input: FileWorkItemInput,
    ctx: ServiceContext,
  ): Promise<FileWorkItemResultDto> {
    const { result, previousParentId } = await withWorkspaceContext(ctx, async (tx) => {
      const locked = await workItemRepository.lockById(workItemId, tx);
      if (!locked) throw new WorkItemNotFoundError(workItemId);
      const current = await workItemRepository.findById(workItemId, tx);
      /* istanbul ignore next -- defensive: the row was locked in this transaction */
      if (!current) throw new WorkItemNotFoundError(workItemId);
      await projectAccessService.assertCanEdit(current.projectId, ctx, tx);

      const filing = await planFolderFiling(current, current.kind, input.folderId, tx);
      if (filing === null) {
        return {
          result: {
            workItemId,
            folderId: current.folderId,
            parentId: current.parentId,
            position: current.position,
            updatedAt: current.updatedAt.toISOString(),
          },
          previousParentId: null,
        };
      }

      const row = await workItemRepository.update(workItemId, filing.update, tx);
      await workItemRevisionsService.recordRevision(
        { workItemId, changedById: ctx.userId, changeKind: 'updated', diff: filing.diff },
        tx,
      );
      if (current.parentId !== null) {
        await recomputeContainerAndAncestors(current.parentId, ctx.workspaceId, tx);
        await recomputeAncestorRepoSets(workItemId, ctx.workspaceId, tx);
      }
      return {
        result: {
          workItemId,
          folderId: row.folderId,
          parentId: row.parentId,
          position: row.position,
          updatedAt: row.updatedAt.toISOString(),
        },
        previousParentId: current.parentId,
      };
    });

    // The parent the item left lost a child, exactly as on a `moveWorkItem` to
    // the root — so its status is re-derived by the same event.
    if (previousParentId !== null) {
      await sendEvent('work-item/child-set.changed', {
        workspaceId: ctx.workspaceId,
        parentIds: [previousParentId],
        workItemId,
        reason: 'reparented',
        occurredAt: new Date().toISOString(),
      });
    }
    return result;
  },

  /**
   * Non-archived work items in a project, optionally filtered by
   * kind / status / assignee, as lighter summary DTOs (no Markdown blobs).
   * Read-only; `ctx` is reserved for the workspace-scoped RLS read landing in
   * 1.4.5.
   */
  async listWorkItems(
    projectId: string,
    filter: ListWorkItemsFilter,
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByProjectFiltered(
        projectId,
        {
          ...(filter.kind ? { kind: filter.kind } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.assigneeId !== undefined ? { assigneeId: filter.assigneeId } : {}),
        },
        tx,
      ),
    );
    return rows.map(toWorkItemSummaryDto);
  },

  /**
   * The full subtree rooted at `rootId` (one recursive-CTE round-trip),
   * mapped to subtree-row DTOs with depth metadata. Read-only; `ctx` reserved
   * for 1.4.5 RLS.
   */
  async getWorkItemSubtree(rootId: string, ctx: ServiceContext): Promise<WorkItemSubtreeDto[]> {
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findSubtree(rootId, tx),
    );
    return rows.map(toWorkItemSubtreeDto);
  },

  /**
   * A DEPTH-BOUNDED, LIVE, browse-gated slice of the subtree rooted at `rootId`
   * — the read backing the AI `get_subtree` tool (Subtask 7.5.1). Unlike
   * {@link getWorkItemSubtree} (whole live+archived subtree, `ctx` reserved),
   * this GATES as the caller (`findById` workspace check → `WorkItemNotFoundError`
   * / 404 for a cross-tenant root, then `assertCanBrowse` per 6.4) and bounds the
   * read to `depth` DESCENDANT levels — CLAMPED to `[0, MAX_SUBTREE_DEPTH]`, with
   * `DEFAULT_SUBTREE_DEPTH` when omitted — so an unbounded request never becomes
   * a whole-tree dump (finding #57). Returns the clamped `depth` alongside the
   * nodes so the boundary can report the bound it actually applied.
   */
  async getBoundedSubtree(
    rootId: string,
    ctx: ServiceContext,
    depth?: number,
  ): Promise<{ nodes: WorkItemSubtreeDto[]; depth: number }> {
    const row = await readWorkItem(rootId, ctx);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(rootId);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    const effectiveDepth = clampBound(depth, 0, MAX_SUBTREE_DEPTH, DEFAULT_SUBTREE_DEPTH);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findBoundedSubtree(rootId, row.workspaceId, effectiveDepth, tx),
    );
    return { nodes: rows.map(toWorkItemSubtreeDto), depth: effectiveDepth };
  },

  /**
   * The project's WHOLE non-archived issue forest, nested into the tree the
   * `/items` list view renders (Subtask 2.5.1) — one recursive-CTE round-trip
   * (no N+1), then in-memory nesting. Roots and siblings come back `key`-asc.
   *
   * Tenant gate (finding #26): the project must resolve AND belong to the active
   * workspace, else `ProjectNotFoundError` (→ 404, no existence leak — a
   * cross-tenant `projectId` is indistinguishable from a never-existed one). The
   * forest read ALSO carries an explicit `workspaceId` on its anchor + recursive
   * step, so a stray cross-workspace row can't enter even with RLS inert under
   * the dev/CI superuser.
   *
   * The optional `filter` (kind / status / assignee / text) is CONTEXT-
   * PRESERVING: matching nodes keep their ancestor chain (rendered muted) so the
   * tree stays navigable. `assigneeId: null` filters to UNASSIGNED; a blank
   * `text` is ignored. An empty project → `[]`; a no-filter call → the full
   * forest with every node `matched`.
   */
  async getProjectTree(
    projectId: string,
    filter: ProjectTreeFilter,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<WorkItemTreeNodeDto[]> {
    // A Visitor's forest drops every private-epic descendant from the recursion
    // (MOTIR-6644) and marks the epic's own node; a member's is unchanged.
    const { workspaceId, excludeIds, visitor } = await openCollectionRead(projectId, ctx);

    const referents = filter.ast
      ? await loadFilterReferents(projectId, workspaceId, filter.ast)
      : undefined;
    const repoFilter = buildRepoFilter(filter, referents);
    const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRepository.findProjectForest(
        projectId,
        workspaceId,
        excludeIds ? { ...repoFilter, excludeIds } : repoFilter,
        tx,
      ),
    );

    // The To fix tag's *· with {head}* (MOTIR-7589): read only for the rows showing a
    // reason, and never for a Visitor — a head key names another card.
    const fixHeads = visitor
      ? new Map<string, string>()
      : await withWorkspaceServiceContext(workspaceId, (tx) =>
          fixHeadKeysFor(
            workspaceId,
            rows.filter((r) => r.fixReason !== null).map((r) => r.id),
            tx,
          ),
        );
    return assembleProjectForest(rows, repoFilterIsActive(repoFilter), visitor, fixHeads);
  },

  /**
   * ONE LEVEL of the project ROADMAP (Subtask 7.20.4 re-plan, MOTIR-1010) — the
   * roots (`parentId = null`) OR one parent's direct children, each carrying a
   * lazy `hasChildren` drill flag + its own `isDone`, PLUS the `is_blocked_by`
   * EDGES from those nodes. The canvas (MOTIR-1194) shows one level at a time and
   * fetches the next on drill, so this is a PER-LEVEL read (reusing
   * {@link listChildIssues}' `findProjectTreeLevel`) — NEVER a whole-tree
   * round-trip that the consumer slices client-side (mistake #91, finding #57).
   *
   * Per-container progress METERS are deliberately NOT computed here: they need
   * the whole subtree (a level read avoids it), and the per-epic meters are
   * MOTIR-1013's work. Done-ness still resolves by workflow CATEGORY (every
   * `done`-category status except `cancelled`).
   *
   * Edges: the `is_blocked_by` links FROM this level's items. The canvas draws a
   * within-level one (both ends visible) as a sibling arrow; an edge to an
   * off-level blocker marks a cross-story dependency. (Capped at the tree-level
   * page size; a level larger than that paginates in a follow-up, like the
   * `/items` tree.)
   *
   * Tenant gate (finding #26): the project must resolve AND belong to the active
   * workspace, else `ProjectNotFoundError` (→ 404). Browse-gated. An empty level
   * → `{ nodes: [], edges: [] }`.
   */
  async getProjectRoadmap(
    projectId: string,
    parentId: string | null,
    ctx: ServiceContext | VisitorReadContext,
    opts: {
      scope?: 'project' | 'sprint';
      all?: boolean;
      ids?: readonly string[];
      /**
       * FOLDERS on the roadmap (Bug MOTIR-5710 · MOTIR-5738) — OPT-IN, and only
       * the `/roadmap` surface asks. With it, the project-scope root leaves out
       * every FILED work item and returns the project's root folders instead,
       * and `folderId` addresses one folder's level. Without it the read is
       * byte-for-byte what it always was — which is what the plan-change,
       * plan-review and onboarding canvases and the item page's Children panel
       * need, because they call this same read and have no folder card to show
       * a filed row in.
       */
      folders?: boolean;
      /** The FOLDER whose level to read — the other level address beside
       *  `parentId`, never together with it. Meaningful only with `folders`. */
      folderId?: string;
    } = {},
  ): Promise<ProjectRoadmapDto> {
    if (opts.folderId !== undefined && parentId !== null) {
      throw new PlacementConflictError(
        'A roadmap level is one parent’s children or one folder’s contents — name only one.',
      );
    }
    // `report:view` (MOTIR-2351) — the roadmap is a project-scoped analytics
    // read, so it asks the reports key rather than the generic browse predicate.
    // The two admit the same actors by decision (`report:view` is browse-wide),
    // so nobody's access moves; what changes is that the inventory row can name
    // the key this read actually asks for. A Visitor holds it (the Viewer set)
    // and reads the level with every private-epic descendant withheld
    // (MOTIR-6644); a member's read carries no exclusion.
    const opened = await openCollectionRead(projectId, ctx, 'report:view');
    const project = { workspaceId: opened.workspaceId };
    const { excludeIds } = opened;
    // Everything below binds the PROJECT's workspace and nothing about the actor.
    const readCtx = { workspaceId: opened.workspaceId };

    // Sprint scope (MOTIR-1381): when the caller asks for the active-sprint
    // slice, resolve the one active sprint (partial-unique `state = 'active'`).
    // NO active sprint → an EMPTY roadmap (the client renders the
    // no-active-sprint state); this is not an error. The whole-project path
    // (scope absent or `'project'`) leaves `sprintId` null and is byte-for-byte
    // the shipped read.
    // AN EXPLICIT ID SET (MOTIR-3895) — the dispatch RUN's members, which are not
    // one parent's children. An EMPTY set short-circuits: `IN ()` is not valid
    // SQL, and a run that took no work items is a real, drawn state rather than
    // a query.
    // Capped at the same ceiling `all=1` raises to — an id set is a level, and an
    // unbounded one is the whole-tree round-trip wearing a different name.
    const ids = opts.ids === undefined ? undefined : opts.ids.slice(0, ROADMAP_LEVEL_ALL_TAKE);
    if (ids !== undefined && ids.length === 0) {
      return { nodes: [], edges: [], offLevelBlockers: [], levelMemberBlockers: [], levelTotal: 0 };
    }

    let sprintId: string | null = null;
    if (opts.scope === 'sprint') {
      const activeSprint = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
        sprintRepository.findActiveByProject(projectId, project.workspaceId, tx),
      );
      if (!activeSprint) {
        return {
          nodes: [],
          edges: [],
          offLevelBlockers: [],
          levelMemberBlockers: [],
          levelTotal: 0,
        };
      }
      sprintId = activeSprint.id;
    }

    // THE FOLDER TREATMENT (Bug MOTIR-5710 · MOTIR-5738, `design/roadmap/design-notes.md`
    // decisions 1, 4, 6 and 8). Applied only when asked for, and never under sprint
    // scope (a committed row renders where it would unfiled — decision 6) or for an
    // explicit id set (a run's members are drawn as the run took them — decision 8).
    // The SAME `TreeFolderLevel` goes to the read AND the count below, so a level's
    // rows and its "Showing N of M" keep sharing one predicate, exactly as the
    // `/items` tree's banded read does (`readFolderLevel`).
    const foldersApply = opts.folders === true && sprintId === null && ids === undefined;
    if (opts.folderId !== undefined && !foldersApply) {
      // A folder level exists only where folders are drawn; anywhere else it is a
      // level with nothing on it, answered rather than queried.
      return { nodes: [], edges: [], offLevelBlockers: [], levelMemberBlockers: [], levelTotal: 0 };
    }
    const folderLevel: TreeFolderLevel | undefined = !foldersApply
      ? undefined
      : opts.folderId !== undefined
        ? { kind: 'folder', folderId: opts.folderId }
        : parentId === null
          ? { kind: 'excludeFiled' }
          : undefined;
    // A level's folders are the root's folders or one folder's child folders — a
    // WORK ITEM's children are never folders, so a parent level carries none.
    const folderParentId: string | null | undefined = !foldersApply
      ? undefined
      : opts.folderId !== undefined
        ? opts.folderId
        : parentId === null
          ? null
          : undefined;

    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // The tenant gate and `report:view` are both awaited above; neither the
    // tree-level read nor the status list refuses.
    // THE LEVEL CAP IS NOW REPORTED, NOT SILENT (MOTIR-3490). `take` stays
    // `TREE_LEVEL_MAX_TAKE` for the ordinary read; `opts.all` raises it to the
    // hard ceiling, which is what the canvas's "Show all" asks for once its
    // truncation tile has told the reader rows are missing. The ceiling is a
    // ceiling and not `undefined` on purpose — an unbounded level read is a
    // whole-tree round-trip wearing a different name (mistake #91), and at the
    // ceiling the tile simply shows again, which is honest.
    const take = opts.all === true ? ROADMAP_LEVEL_ALL_TAKE : TREE_LEVEL_MAX_TAKE;
    const [rowsPage, statuses, levelTotal] = await Promise.all([
      withWorkspaceServiceContext(project.workspaceId, (tx) =>
        workItemRepository.findProjectTreeLevel(
          projectId,
          project.workspaceId,
          parentId,
          DEFAULT_SORT,
          {
            take,
            offset: 0,
            ...(ids !== undefined ? { ids } : {}),
            excludeIds,
          },
          sprintId,
          tx,
          folderLevel,
        ),
      ),
      workflowsService.listStatusesByProject(projectId, project.workspaceId),
      // The level's TRUE size, under the same predicate + sprint arm as the read
      // above — this is the `M` in "Showing N of M", and a count taken under a
      // different predicate would report on a different level.
      withWorkspaceServiceContext(project.workspaceId, (tx) =>
        workItemRepository.countProjectTreeLevel(
          projectId,
          project.workspaceId,
          parentId,
          sprintId,
          tx,
          ids,
          folderLevel,
          excludeIds,
        ),
      ),
    ]);
    // `findProjectTreeLevel` deliberately returns `take + 1` rows — the has-more
    // PROBE the paged `/items` tree uses to decide whether to offer another page
    // (`buildTreeLevel` slices it off). This read never sliced, so a capped level
    // has always returned 201 nodes for a 200-row cap: harmless while nothing
    // compared the two, and wrong the moment `levelTotal` does. Slice it here, so
    // the level returns exactly as many rows as it claims and "Showing 200 of 210"
    // is a true sentence.
    const rows = rowsPage.slice(0, take);
    const doneKeys = roadmapDoneStatusKeys(statuses);
    // TERMINAL keys = the whole `done` CATEGORY, INCLUDING `cancelled` — the
    // dependency-satisfaction rule (distinct from `doneKeys`, which is the
    // progress-meter "completed" set that deliberately drops `cancelled`). A
    // `blocked_by` blocker in ANY terminal status can never gate, so the roadmap's
    // off-level blocker signal must treat `cancelled` as satisfied — matching
    // `validate_sprint` (`sprintsService` uses the done-category `terminalByProject`).
    // Using `doneKeys` here wrongly flagged a `cancelled` blocker "not in sprint"
    // (MOTIR-1561). Progress meters + per-node done styling keep `doneKeys`.
    const terminalKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));

    // Per-container PROGRESS meters (Subtask 7.20.6 / MOTIR-1013): one recursive
    // count over THIS level's CONTAINER nodes (leaves have no subtree, so they're
    // skipped) — done = descendants in a `done`-category status, total = every
    // descendant except the sealed `cancelled` key. A container with no live
    // descendants is absent from the result → `0 / 0`. Leaves carry `progress:
    // null`. Bounded by the level (≤ TREE_LEVEL_MAX_TAKE containers), not a
    // whole-tree load.
    // Progress is the FULL subtree rollup even in sprint scope: a shown root member
    // is the committed unit and drills to its whole subtree, so its meter reflects
    // that whole subtree (MOTIR-1381, revised) — sprint scope only re-roots the top
    // level, it does not prune progress.
    const containerIds = rows.filter((r) => r.hasChildren).map((r) => r.id);
    const progressRows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.countRoadmapProgress(
        containerIds,
        [...doneKeys],
        ROADMAP_CANCELLED_KEY,
        tx,
      ),
    );
    const progressById = new Map(
      progressRows.map((p) => [p.rootId, { done: p.done, total: p.total, verified: p.verified }]),
    );

    // READY-to-start (MOTIR-1417): a node is ready iff it is in a startable
    // (`todo`-category) status AND it is dispatch-ready — the SHIPPED readiness,
    // reused so the highlight never drifts from `list_ready`. That readiness is
    // CASCADED: a node is ready ⟺ its own blockers are done AND every ANCESTOR is
    // ready (`getReadiness` / `collectReadyLeaves`). This read loads one level at a
    // time, so the drilled node's ancestors are OFF-level; `getReadinessForItems`
    // resolves each row's ancestor chain and ANDs it in (one batched blocker read +
    // terminal read + ancestor read, no N+1). Using the own-blocker leg ALONE
    // (`computeOwnBlockerReadiness`) lit a child of a blocked parent as ready —
    // diverging from `list_ready` (MOTIR-1563). Per-item ancestor resolution keeps
    // it correct for sprint-scope root members whose story/epic ancestors are elided.
    // Done / in-progress nodes are never ready (the startable-status gate).
    const startableKeys = new Set(statuses.filter((s) => s.category === 'todo').map((s) => s.key));
    const readyById = await workItemsService.getReadinessForItems(
      rows.map((r) => r.id),
      readCtx,
    );
    // SPRINT-membership flag (MOTIR-1379 follow-up): in sprint scope the root
    // level shows only in-sprint members, but drilling into a committed root
    // reveals its WHOLE subtree — including children the sprint did not commit to.
    // A node is an active-sprint member iff its own `sprintId` is the resolved
    // active sprint; the canvas renders a drilled-in NON-member "not in sprint".
    // In project scope `sprintId` is null, so every node is `false` (the flag is
    // inert — the whole-project view ignores it).
    // The status's OWN IDENTITY on the wire (bug MOTIR-3170) — its label and its
    // lifecycle category, from the SAME `statuses` list this read already loaded
    // to compute `isDone` and `ready`, so it costs no extra query. Without it the
    // canvas had to name a status out of the `labels.defaultStatus` catalog and
    // could only draw the six keys it had hard-coded; everything else — a custom
    // workflow status, and `implemented` / `planning` once they were added to the
    // default one — collapsed to `todo` and rendered as "To Do".
    const statusByKey = new Map(statuses.map((s) => [s.key, s]));
    const nodes = rows.map((r) => {
      const node = toRoadmapNodeDto(
        r,
        doneKeys.has(r.status),
        r.hasChildren ? (progressById.get(r.id) ?? { done: 0, total: 0, verified: 0 }) : null,
        startableKeys.has(r.status) && (readyById.get(r.id) ?? true),
        sprintId != null && r.sprintId === sprintId,
        statusByKey.get(r.status) ?? null,
      );
      // A Visitor's private epic keeps its node, marked, with no drill (§4).
      return opened.visitor && r.kind === 'epic' && r.publicChildrenHidden
        ? { ...node, hasChildren: false, progress: null, childrenHidden: true as const }
        : node;
    });

    // The `is_blocked_by` edges FROM this level's items (the canvas draws the
    // within-level ones as arrows; an off-level blocker flags a cross-story dep).
    const allEdges = await withWorkspaceServiceContext(readCtx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockedByEdges(
        rows.map((r) => r.id),
        tx,
      ),
    );
    // A Visitor never sees an edge to a withheld blocker — its stub would name a
    // private epic's descendant (MOTIR-6644, `epic-privacy.md` §3).
    const hidden = excludeIds ? new Set(excludeIds) : null;
    const edges = hidden ? allEdges.filter((e) => !hidden.has(e.blockerId)) : allEdges;

    // A blocker NOT on this level needs a NAMING stub so the canvas can anchor the
    // signal to a chip (MOTIR-1331). The stub carries `isDone` + `inActiveSprint`
    // so the SPRINT-scoped view can tell a sprint-validity problem (a blocker that
    // is NOT done AND NOT in the active sprint) from a satisfied one — replacing the
    // project-scope "cross-story" framing (MOTIR-1379).
    const levelIds = new Set(rows.map((r) => r.id));
    const offLevelIds = [
      ...new Set(edges.map((e) => e.blockerId).filter((id) => !levelIds.has(id))),
    ];
    const offLevelStubs = await withWorkspaceServiceContext(readCtx.workspaceId, (tx) =>
      workItemRepository.findRoadmapBlockerStubs(offLevelIds, tx),
    );
    // WHERE a FILED off-level blocker lives (Bug MOTIR-5710 · MOTIR-5739, design
    // decision 7): its EFFECTIVE folder's path, root first, so the ghost anchor can
    // name the door that holds it instead of a parent it does not have. Two bounded
    // reads for the whole level — the effective folders, then their paths — and
    // none at all when no blocker is off the level. Carried whether or not the
    // caller asked for folders: it is a fact about the blocker, true on every canvas.
    const folderPathByStub = await withWorkspaceServiceContext(readCtx.workspaceId, async (tx) => {
      const effective = await workItemRepository.findEffectiveFolderIds(offLevelIds, tx);
      const folderIds = [
        ...new Set(effective.map((e) => e.folderId).filter((f): f is string => f !== null)),
      ];
      const paths = await folderRepository.findPathsByIds(folderIds, readCtx.workspaceId, tx);
      const pathByFolder = new Map(paths.map((p) => [p.id, p.path]));
      return new Map(
        effective.map((e) => [e.id, e.folderId ? (pathByFolder.get(e.folderId) ?? null) : null]),
      );
    });

    // ⚠️ A ROW THE CAP DROPPED IS STILL A MEMBER OF THIS LEVEL (bug MOTIR-5043).
    // `levelIds` above is the rows the read RETURNED, and `take` is 200 — so on a
    // level with more children than that, a blocker that is a plain SIBLING of the
    // row it blocks falls out of `levelIds` and lands in `offLevelIds`, where every
    // downstream reader treats it as the cross-story tangle: a red `cross` arrow, a
    // `blocked elsewhere` flag on the dependent, and a ghost anchor for a card that
    // shares its dependent's parent. The canvas's loudest verdict — its legend reads
    // *"the blocker sits elsewhere in the plan (a bad plan)"* — fired about a tree
    // that is correct, and the reader's likeliest repair is to MOVE a card.
    //
    // So the two questions are separated here, once, rather than in each arm that
    // asks one of them: `offLevelBlockers` keeps the blockers that are genuinely on
    // ANOTHER level, and `levelMemberBlockers` names the ones this level HAS and the
    // read could not carry. The canvas draws neither — a dropped row has no node —
    // but only the first deserves the verdict. This is the fourth exclusion in the
    // family (grouping MOTIR-3557, archived MOTIR-3927, a plan's arriving card
    // MOTIR-4952), and the first one answered from the LEVEL rather than from the
    // arm that happened to notice it.
    //
    // TWO GUARDS, both because the parent comparison only MEANS membership when the
    // level is the parent's children:
    //   * `ids` — a level named by its MEMBERS spans parents (MOTIR-3895) and carries
    //     `parentId: null` for the request; a blocker's parent being null would then
    //     match by accident. Membership there is the id set, which `levelIds` already
    //     answers exactly.
    //   * SPRINT scope — `findProjectTreeLevel` re-roots the level at the topmost
    //     IN-SPRINT rows, so a level's rows are not `parentId`'s children at all.
    //     That arm is also not where the defect is: it suppresses a done / in-sprint
    //     blocker and flags an out-of-sprint one "blocker not in sprint", which is
    //     TRUE of a cap-dropped sibling. Leaving it alone keeps it true.
    const isParentLevel = ids === undefined && opts.scope !== 'sprint';
    // ⚠️ WITH FOLDERS ON, A NULL PARENT IS NO LONGER A LEVEL (Bug MOTIR-5710): the
    // root holds only UNFILED parentless rows, and a folder's level holds the rows
    // filed in it. So membership compares the folder as well as the parent — else a
    // blocker filed in another folder would be read as a cap-dropped sibling and
    // lose its off-level anchor.
    const inThisFolder = (folderId: string | null): boolean =>
      folderLevel === undefined
        ? true
        : folderLevel.kind === 'folder'
          ? folderId === folderLevel.folderId
          : folderId === null;
    const levelMemberIds = new Set(
      isParentLevel
        ? offLevelStubs
            .filter((s) => s.parentId === parentId && inThisFolder(s.folderId))
            .map((s) => s.id)
        : [],
    );
    const offLevelBlockers = offLevelStubs
      .filter((s) => !levelMemberIds.has(s.id))
      .map((s) => ({
        id: s.id,
        identifier: s.identifier,
        title: s.title,
        parentTitle: s.parentTitle,
        folderPath: folderPathByStub.get(s.id) ?? null,
        // Terminal (incl. `cancelled`), NOT `doneKeys` — a cancelled blocker is
        // satisfied and must not be flagged "not in sprint" (MOTIR-1561).
        isDone: terminalKeys.has(s.status),
        inActiveSprint: sprintId != null && s.sprintId === sprintId,
      }));
    // `isDone` here is `status === 'done'`, NOT the terminal set the stub above
    // carries — it feeds the WITHIN-level arrow variant, and that arm's own
    // predicate is `status === 'done'` (the same reason `arrivingBlockers` is a map
    // of that predicate and not of the stub's `isDone`: a `cancelled` blocker would
    // otherwise draw `firm` here and `pending` once the row is fetched).
    const levelMemberBlockers = offLevelStubs
      .filter((s) => levelMemberIds.has(s.id))
      .map((s) => ({ id: s.id, isDone: s.status === 'done' }));

    // WHAT EACH OFF-LEVEL EDGE DRAWS (MOTIR-6359; design `design/roadmap/design-notes.md`
    // § "Covered cross-parent edges"). Today's single verdict — every off-level
    // blocker is the bad-plan tangle — is replaced by the validators' own: an edge the
    // parents CARRY is valid and is drawn one level up, so the canvas skips it; a
    // cross-level or uncovered edge is invalid and keeps the flag; an edge with no
    // parent to carry it keeps a neutral anchor. `edgeDisposition` asks the same two
    // predicates `validate_work_item` does, so the flag and the verdict cannot part.
    //
    // PROJECT scope only: the sprint arm asks sprint VALIDITY, a different question
    // that runs before this in the builder and is unchanged. BOUNDED: two batched
    // reads (the ancestor chains, then the parent pairs that carry an edge) however
    // many off-level edges the level has, and none when it has none.
    const edgesOut =
      sprintId === null
        ? await withRoadmapEdgeCoverage(
            edges,
            new Set(offLevelBlockers.map((b) => b.id)),
            rows,
            offLevelStubs,
            readCtx,
          )
        : edges;

    // The level's FOLDERS (decision 4): read WHOLE, never cut by the work-item cap —
    // the ceiling is a guard against a runaway read, not a page — and each carries
    // its DIRECT counts from ONE aggregate over the level (decision 3), never a read
    // per folder.
    if (folderParentId === undefined) {
      return { nodes, edges: edgesOut, offLevelBlockers, levelMemberBlockers, levelTotal };
    }
    const folders = await withWorkspaceServiceContext(project.workspaceId, async (tx) => {
      const rows = await folderRepository.findLevel(
        projectId,
        project.workspaceId,
        folderParentId,
        { take: ROADMAP_LEVEL_ALL_TAKE, offset: 0 },
        tx,
      );
      const counts = await folderRepository.countDirectContents(
        rows.map((r) => r.id),
        tx,
      );
      const countsById = new Map(counts.map((c) => [c.id, c]));
      return rows.map((r) => toRoadmapFolderDto(r, countsById.get(r.id)));
    });
    return {
      nodes,
      edges: edgesOut,
      offLevelBlockers,
      levelMemberBlockers,
      levelTotal,
      folders,
    };
  },

  /**
   * The flat, sorted issue list powering the List view (Subtask 2.5.8). Same
   * project + workspace gate as `getProjectTree` (a cross-workspace project id
   * is a not-found, not an empty list), the SAME filter axes (so the List
   * honours the 2.5.4 filter bar), but the rows come back UN-NESTED and ordered
   * by the active `sort` — the read does the `ORDER BY` (no JS re-nesting). An
   * empty project → `[]`. Returns wire-safe `WorkItemListItemDto`s; the route
   * shapes them into the same `IssueRowData` the tree row uses.
   *
   * `pageSize` (Story 6.3 · Subtask 6.3.2 — the filter-results widget rides
   * THIS read, no second query path) defaults to the List's
   * {@link ISSUE_LIST_PAGE_SIZE} and is clamped to `[1, ISSUE_LIST_PAGE_SIZE]`
   * server-side — the verified 50/page gadget cap (a deliberate Cloud
   * performance bound, not raisable by the caller).
   */
  async getProjectIssuesList(
    projectId: string,
    params: { sort: IssueSort; filter?: ProjectTreeFilter; page?: number; pageSize?: number },
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<PagedIssueListDto> {
    // A Visitor's list — and its FilterAST search, which is this same read —
    // never matches or counts a private-epic descendant (MOTIR-6644).
    const opened = await openCollectionRead(projectId, ctx);
    const project = { workspaceId: opened.workspaceId };

    const referents = params.filter?.ast
      ? await loadFilterReferents(projectId, project.workspaceId, params.filter.ast)
      : undefined;
    const built = buildRepoFilter(params.filter ?? {}, referents);
    const repoFilter = opened.excludeIds ? { ...built, excludeIds: opened.excludeIds } : built;
    const pageSize = clampIssuePageSize(params.pageSize);

    // Count the filtered set first so an out-of-range ?page CLAMPS to the last
    // page (the 2.5.10 edge spec) instead of fetching an empty offset window.
    // The count is the pager's denominator and tracks the active filter.
    const total = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.countProjectIssues(projectId, project.workspaceId, repoFilter, tx),
    );
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
    const offset = (page - 1) * pageSize;

    const rows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.findProjectIssuesFlat(
        projectId,
        project.workspaceId,
        params.sort,
        repoFilter,
        { limit: pageSize, offset },
        tx,
      ),
    );

    // The To fix tag's *· with {head}* (MOTIR-7589) — never for a Visitor.
    const fixHeads = opened.visitor
      ? new Map<string, string>()
      : await withWorkspaceServiceContext(project.workspaceId, (tx) =>
          fixHeadKeysFor(
            project.workspaceId,
            rows.filter((r) => r.fixReason !== null).map((r) => r.id),
            tx,
          ),
        );
    const items = rows.map((row) => {
      if (opened.visitor) {
        return stripPrivateEpicTells(toWorkItemListItemDto(row), row.publicChildrenHidden);
      }
      const head = fixHeads.get(row.id);
      return head
        ? { ...toWorkItemListItemDto(row), fixHeadKey: head }
        : toWorkItemListItemDto(row);
    });
    return { items, total, page, pageSize };
  },

  /**
   * The same project List set, KEYSET-paged (Story 11.2 · Subtask 11.2.3 —
   * MOTIR-2041) — what `GET /api/v1/projects/{projectKey}/work-items` reads.
   *
   * The GATES and the FILTER RESOLUTION are {@link getProjectIssuesList}'s,
   * unchanged and deliberately re-run here rather than assumed by the caller: a
   * cross-tenant `projectId` is a `ProjectNotFoundError` (no existence leak),
   * then `assertCanBrowse`. This method carries its own gates because a route is
   * a thin adapter — it must not be the thing that remembers to check.
   *
   * ⚠️ `limit` clamps to the v1 ceiling ({@link MAX_PAGE_LIMIT} = 100), NOT to
   * `ISSUE_LIST_PAGE_SIZE` (50). The List's 50-row cap is a Cloud performance
   * bound on the OFFSET pager and is left exactly where it is — this card raises
   * no existing cap and changes no existing method. The two ceilings are
   * independent because the two reads are.
   *
   * Cursor ENCODING stays in the v1 layer: a cursor is an HTTP concept, and a
   * service that learned one would be answering to a transport. This returns the
   * rows plus whether more remain; the route names the position.
   */
  async listProjectWorkItemsPage(
    projectId: string,
    params: { filter?: ProjectTreeFilter; after?: { createdAt: Date; id: string }; limit?: number },
    ctx: ServiceContext,
  ): Promise<{ items: WorkItemKeysetItemDto[]; hasMore: boolean }> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    // The SAME referent resolution + filter build the List does, so a label /
    // component / custom-field condition resolves identically — and a STALE
    // referent still compiles to match-nothing rather than erroring.
    const referents = params.filter?.ast
      ? await loadFilterReferents(projectId, project.workspaceId, params.filter.ast)
      : undefined;
    const repoFilter = buildRepoFilter(params.filter ?? {}, referents);

    const limit = clampV1PageLimit(params.limit);
    const rows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.findProjectIssuesKeyset(
        projectId,
        project.workspaceId,
        repoFilter,
        { ...(params.after ? { after: params.after } : {}), limit },
        tx,
      ),
    );

    // The repository fetched `limit + 1` — the extra row IS the "more remains"
    // answer, and it never reaches the caller.
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((row) => ({
        ...toWorkItemListItemDto(row),
        id: row.id,
        createdAt: row.createdAt,
      })),
      hasMore,
    };
  },

  /**
   * COUNT the work items {@link listProjectWorkItemsPage} would page (ADR
   * Amendment 14) — the read behind `GET …/work-items/count`.
   *
   * Deliberately a MIRROR of that method and not a variation on it: the same
   * project + workspace gate, the same `assertCanBrowse`, the same referent
   * resolution, and the same `buildRepoFilter`. A count that disagreed with the
   * page it claims to count would be worse than no count at all, and the only
   * way to keep them agreeing is for both to build their predicate the same way
   * from the same input. What it drops is the keyset position and the limit —
   * a count has neither.
   *
   * `countProjectIssues` carries one term the keyset scope does not, an
   * `excludeIds` exclusion; it is a no-op here because this path never sets one,
   * and a test pins the two reads as agreeing rather than leaving that resting
   * on inspection.
   */
  async countProjectWorkItems(
    projectId: string,
    params: { filter?: ProjectTreeFilter },
    ctx: ServiceContext,
  ): Promise<number> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const referents = params.filter?.ast
      ? await loadFilterReferents(projectId, project.workspaceId, params.filter.ast)
      : undefined;
    const repoFilter = buildRepoFilter(params.filter ?? {}, referents);

    return withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.countProjectIssues(projectId, project.workspaceId, repoFilter, tx),
    );
  },

  /**
   * The project's ARCHIVED items, paginated (Story 2.9 · Subtask 2.9.2) — the
   * read behind the archive-management surface. The inverse of every active
   * view's `archivedAt IS NULL` filter: a FLAT, `archivedAt DESC` page of the
   * soft-deleted items, each carrying its `archivedAt` stamp + the actor who
   * archived it (resolved from the latest `'archived'` revision in the same
   * read). Same project + workspace gate as {@link getProjectIssuesList} (a
   * cross-tenant `projectId` → `ProjectNotFoundError`, no existence leak), and
   * the **read gate is `canBrowse`** (the 2.9.1 view-access decision — viewing
   * the archive is a browse, the same right as the active views; restoring is
   * the separate edit-gated `unarchiveWorkItem`). `pageSize` reuses the List's
   * {@link ISSUE_LIST_PAGE_SIZE} clamp, and an out-of-range `page` clamps to the
   * last page (count-first, like the List). An empty archive → `total: 0`,
   * `page: 1`, `items: []`.
   */
  async listArchivedWorkItems(
    projectId: string,
    params: { page?: number; pageSize?: number },
    ctx: ServiceContext,
  ): Promise<PagedArchivedWorkItemsDto> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const pageSize = clampIssuePageSize(params.pageSize);
    const total = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.countArchivedByProject(projectId, project.workspaceId, tx),
    );
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
    const offset = (page - 1) * pageSize;

    const rows = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.findArchivedByProject(
        projectId,
        project.workspaceId,
        { limit: pageSize, offset },
        tx,
      ),
    );
    return { items: rows.map(toArchivedWorkItemDto), total, page, pageSize };
  },

  /**
   * The COUNT of the project's archived items (Story 2.9 · Subtask 2.9.3) — the
   * lightweight read behind the `/items` toolbar's `[Archived]` entry-point
   * badge (the design's count chip), so the navigator can show "there's
   * something there" without loading a page of rows. Same project + workspace
   * gate and `canBrowse` read gate as {@link listArchivedWorkItems} (a
   * cross-tenant `projectId` → `ProjectNotFoundError`, no existence leak); it
   * just returns the `archivedAt IS NOT NULL` count instead of a page.
   */
  async countArchivedWorkItems(projectId: string, ctx: ServiceContext): Promise<number> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);
    return withWorkspaceServiceContext(project.workspaceId, (tx) =>
      workItemRepository.countArchivedByProject(projectId, project.workspaceId, tx),
    );
  },

  /**
   * The project's ROOT issues for the LAZY tree (Subtask 2.5.13, finding #57) —
   * one sorted, paged level (`parentId IS NULL`), each row carrying
   * `hasChildren` so the client renders an expand chevron without loading the
   * subtree. Same project + workspace gate as `getProjectTree` (a cross-tenant
   * `projectId` → `ProjectNotFoundError`, no existence leak). `hasMore` is
   * derived from a `take + 1` fetch (no COUNT). This is the UNfiltered tree's
   * read; a filtered tree still uses `getProjectTree` (context-preserving over
   * the already-bounded result).
   */
  async listRootIssues(
    projectId: string,
    params: { sort: IssueSort; take?: number; offset?: number },
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<TreeLevelDto> {
    const { workspaceId, excludeIds } = await openCollectionRead(projectId, ctx);
    // The root holds the project's unfiled EPICS, then its root FOLDERS, then its
    // other unfiled work items (MOTIR-5550); an item filed in a folder is shown
    // inside that folder instead (MOTIR-5314). A Visitor's root keeps a private
    // epic's row and strips its tells (MOTIR-6644).
    return readFolderLevel(projectId, workspaceId, null, params, excludeIds);
  },

  /**
   * One parent's DIRECT children for the LAZY tree (Subtask 2.5.13) — a sorted,
   * paged level (`parentId = <id>`), each child carrying `hasChildren`. The
   * parent is gated by workspace (finding #26): a missing or cross-workspace
   * `parentId` → `WorkItemNotFoundError` (never a leak), NOT an empty list.
   */
  async listChildIssues(
    parentId: string,
    params: { sort: IssueSort; take?: number; offset?: number },
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<TreeLevelDto> {
    if (isVisitorContext(ctx)) return listVisitorChildIssues(parentId, params, ctx);
    const parent = await readWorkItem(parentId, ctx);
    if (!parent || parent.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(parentId);
    }
    await projectAccessService.assertCanBrowse(parent.projectId, ctx);
    const { take, offset } = clampTreePage(params);
    const [rows, total] = await withWorkspaceServiceContext(parent.workspaceId, (tx) =>
      Promise.all([
        workItemRepository.findProjectTreeLevel(
          parent.projectId,
          parent.workspaceId,
          parentId,
          params.sort,
          { take, offset },
          null,
          tx,
        ),
        workItemRepository.countProjectTreeLevel(
          parent.projectId,
          parent.workspaceId,
          parentId,
          null,
          tx,
        ),
      ]),
    );
    return buildTreeLevel(rows, take, total);
  },

  /**
   * One FOLDER's level for the LAZY tree (Story MOTIR-5308 · MOTIR-5314) — its
   * child folders, then the work items filed in it, paged exactly as a work
   * item's children are. A missing or cross-workspace folder is
   * `FolderNotFoundError` (never a leak), NOT an empty level.
   */
  async listFolderLevel(
    folderId: string,
    params: { sort: IssueSort; take?: number; offset?: number },
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<TreeLevelDto> {
    if (isVisitorContext(ctx)) {
      // A Visitor's folder must belong to their one public project (MOTIR-6644);
      // any other id is the same not-found a missing folder is.
      const { workspaceId, excludeIds } = openVisitorRead(ctx.project.id, ctx);
      const folder = await withWorkspaceServiceContext(workspaceId, (tx) =>
        folderRepository.findById(folderId, tx),
      );
      if (!folder || folder.projectId !== ctx.project.id) throw new FolderNotFoundError(folderId);
      return readFolderLevel(folder.projectId, workspaceId, folder.id, params, excludeIds);
    }
    const folder = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      folderRepository.findById(folderId, tx),
    );
    if (!folder || folder.workspaceId !== ctx.workspaceId) throw new FolderNotFoundError(folderId);
    await projectAccessService.assertCanBrowse(folder.projectId, ctx);
    return readFolderLevel(folder.projectId, folder.workspaceId, folder.id, params);
  },

  /**
   * Create a link "fromId <kind> toId". Asserts both items exist and share a
   * workspace — a far end in ANOTHER workspace is a `WorkItemNotFoundError`,
   * NOT a distinguishable cross-workspace error (see the decision recorded on
   * `CrossWorkspaceLinkError` in `lib/workItems/linkErrors.ts`); the trigger
   * still backstops the write itself. Writes the
   * row with the from-item's workspaceId, and for `relates_to` ALSO persists
   * the reciprocal toId→fromId row in the same transaction. The reciprocal is
   * idempotent: we check for an existing mirror first and skip when present —
   * a pre-existence check rather than catch-P2002, because a unique violation
   * would ABORT the enclosing Postgres transaction (the same reason
   * projectsService opens a fresh tx per retry), which would also lose the
   * revision write. One revision is recorded on the FROM item — the reciprocal
   * is bookkeeping, not a separate user action.
   */
  async linkWorkItems(input: LinkWorkItemsInput, ctx: ServiceContext): Promise<WorkItemLinkDto> {
    const result = await withWorkspaceContext(ctx, async (tx) => {
      const fromItem = await workItemRepository.findById(input.fromId, tx);
      if (!fromItem) throw new WorkItemNotFoundError(input.fromId);
      const toItem = await workItemRepository.findById(input.toId, tx);
      if (!toItem) throw new WorkItemNotFoundError(input.toId);
      // A far end in ANOTHER workspace is NOT FOUND, not "cross-workspace"
      // (MOTIR-2919, 2026-08-17). Naming the reason confirms the id resolves in
      // some other tenant — the existence oracle the 404-not-403 contract
      // forbids everywhere else. Under `motir_app` the read above already
      // answers this way, because RLS hides the row; this line is what makes a
      // BYPASSING role (the owner connection, a system context) answer
      // identically instead of leaking. Keep both — the pair is the invariant.
      if (fromItem.workspaceId !== toItem.workspaceId) throw new WorkItemNotFoundError(input.toId);

      // Project access gate (6.4.3): a link is an edit of the FROM item (the
      // side that owns the revision). The TO item can be cross-project; the
      // editor only needs edit rights on the item they're linking FROM.
      await projectAccessService.assertCanEdit(fromItem.projectId, ctx, tx);

      // A `blocked_by` between two LEVELS is WRITTEN, not refused (MOTIR-6509,
      // `edge-level-is-position.md` Amendment 2): a dependency is a fact about
      // the work, and refusing it leaves the blocked card ready and claimable.
      // `validate_work_item` reports it INVALID (`crossLevelEdges`) instead.

      // The forward edge + the `relates_to` reciprocal + the `links.added`
      // revision, via the shared write-core (extracted in 5.8.3 so the
      // auto-relate-on-mention path reuses the exact same logic). `idempotent:
      // false` keeps the manual-link contract: a duplicate throws
      // DuplicateLinkError → 409. The non-idempotent branch always returns the
      // inserted row.
      const link = await writeWorkItemLink(
        {
          workspaceId: fromItem.workspaceId,
          fromId: input.fromId,
          toId: input.toId,
          kind: input.kind,
          createdById: ctx.userId,
          idempotent: false,
        },
        tx,
      );

      /* istanbul ignore next -- the non-idempotent branch never returns null (the
         forward create throws on a duplicate rather than returning null) */
      if (!link) throw new WorkItemLinkNotFoundError(input.fromId);
      // An open prerequisite takes the manual-work question off the blocked card
      // (MOTIR-8670), in the link's own transaction.
      if (input.kind === 'is_blocked_by') {
        await manualWorkGateService.withdrawIfNewBlockerOpen(input.fromId, input.toId, tx);
      }
      return { dto: toWorkItemLinkDto(link), fromItem, toItem };
    });

    // WHAT THE RUN PRODUCED (MOTIR-3981) — the AFTER-THE-FACT half. An agent
    // that files its bug and then links it lands here rather than in
    // `createWorkItem`, and Q3's `relates_to` is exactly the edge that names
    // the work item it was found on. Either direction of the reciprocal pair
    // counts: the bug may be the FROM or the TO.
    //
    // Post-commit and best-effort like the create path, and idempotent with it
    // — a bug created WITH its link and then linked again records one finding,
    // not two.
    if (result.fromItem.kind === 'bug' && input.kind === 'relates_to') {
      await recordBugFiledFinding(toWorkItemDto(result.fromItem), [result.toItem.id], ctx);
    } else if (result.toItem.kind === 'bug' && input.kind === 'relates_to') {
      await recordBugFiledFinding(toWorkItemDto(result.toItem), [result.fromItem.id], ctx);
    }

    return result.dto;
  },

  /**
   * Remove a link by id (+ its reciprocal for `relates_to`) and record the
   * removal revision on the from item, in one transaction. A missing link is
   * a typed WorkItemLinkNotFoundError; a missing reciprocal is NOT an error
   * (forward-compat with legacy half-pairs).
   */
  async unlinkWorkItems(linkId: string, ctx: ServiceContext): Promise<void> {
    await withWorkspaceContext(ctx, async (tx) => {
      // The `tx` is load-bearing (MOTIR-2774): without it this read leaves the bound
      // transaction and the workspace policy hides the very link being removed.
      const link = await workItemLinkRepository.findById(linkId, tx);
      if (!link) throw new WorkItemLinkNotFoundError(linkId);

      // Project access gate (6.4.3): removing a link is an edit of the FROM item.
      const fromItem = await workItemRepository.findById(link.fromId, tx);
      if (!fromItem || fromItem.workspaceId !== ctx.workspaceId) {
        throw new WorkItemLinkNotFoundError(linkId);
      }
      await projectAccessService.assertCanEdit(fromItem.projectId, ctx, tx);

      await workItemLinkRepository.delete(linkId, tx);

      if (link.kind === 'relates_to') {
        const reciprocal = await workItemLinkRepository.findReciprocal(
          link.toId,
          link.fromId,
          'relates_to',
          tx,
        );
        if (reciprocal) {
          await workItemLinkRepository.delete(reciprocal.id, tx);
        }
      }

      await workItemRevisionsService.recordRevision(
        {
          workItemId: link.fromId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { links: { removed: [{ toId: link.toId, kind: link.kind }] } },
        },
        tx,
      );
    });
  },

  /**
   * Remove the directed link addressed by its ENDPOINTS (`fromId <kind> toId`)
   * rather than its opaque id — the shape the MCP `unlink_work_items` tool
   * (Subtask 7.8.13) needs, since an agent addresses a link by the two item
   * keys + relationship, not the link id it never sees. Resolves the unique
   * `(fromId, toId, kind)` row, then runs the SAME delete + reciprocal-drop +
   * revision logic as {@link unlinkWorkItems}. IDEMPOTENT: a link that's already
   * absent (or not visible to `ctx`) is a no-op returning `false` — no typed
   * error — so a retried unlink is safe (the tool's acceptance contract).
   * Returns whether a link was actually removed.
   */
  async unlinkWorkItemsByEndpoints(
    input: LinkWorkItemsInput,
    ctx: ServiceContext,
  ): Promise<boolean> {
    return withWorkspaceContext(ctx, async (tx) => {
      const link = await workItemLinkRepository.findReciprocal(
        input.fromId,
        input.toId,
        input.kind,
        tx,
      );
      if (!link) return false;

      // Project access gate (6.4.3): removing a link is an edit of the FROM
      // item. A cross-workspace / unreadable from-item resolves as already-gone
      // (the 404-not-403 contract — no existence leak), so we return false.
      const fromItem = await workItemRepository.findById(link.fromId, tx);
      if (!fromItem || fromItem.workspaceId !== ctx.workspaceId) return false;
      await projectAccessService.assertCanEdit(fromItem.projectId, ctx, tx);

      await workItemLinkRepository.delete(link.id, tx);

      if (link.kind === 'relates_to') {
        const reciprocal = await workItemLinkRepository.findReciprocal(
          link.toId,
          link.fromId,
          'relates_to',
          tx,
        );
        if (reciprocal) {
          await workItemLinkRepository.delete(reciprocal.id, tx);
        }
      }

      await workItemRevisionsService.recordRevision(
        {
          workItemId: link.fromId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { links: { removed: [{ toId: link.toId, kind: link.kind }] } },
        },
        tx,
      );
      return true;
    });
  },

  /**
   * The blockers of `workItemId`: the items it `is_blocked_by`. One link-table
   * query yields the toIds, one findByIds resolves them all (N+0 — no N+1).
   * Sorted by key for a stable order. Read-only; `ctx` binds the read (MOTIR-2807).
   */
  async getBlockers(workItemId: string, ctx: ServiceContext): Promise<WorkItemSummaryDto[]> {
    // The edge read and the batch it resolves are ONE contiguous run of this
    // method's own reads, so they share one transaction. Binding only the batch
    // would fix nothing: the edge read returns [] first and the item reports no
    // blockers — which does not render as "unknown", it renders as READY.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const links = await workItemLinkRepository.findByFromItem(workItemId, 'is_blocked_by', tx);
      return workItemRepository.findByIds(
        links.map((l) => l.toId),
        tx,
      );
    });
    return rows.sort(byKeyAsc).map(toWorkItemSummaryDto);
  },

  /**
   * The items `workItemId` is blocking: those that are `is_blocked_by` it. One
   * reverse link-table query (the @@index([toId, kind]) lookup) yields the
   * fromIds, one findByIds resolves them. Read-only; `ctx` binds the read (MOTIR-2807).
   */
  async getBlocking(workItemId: string, ctx: ServiceContext): Promise<WorkItemSummaryDto[]> {
    // Same contiguous run as `getBlockers`, mirrored onto the IN edges.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const links = await workItemLinkRepository.findByToItem(workItemId, 'is_blocked_by', tx);
      return workItemRepository.findByIds(
        links.map((l) => l.fromId),
        tx,
      );
    });
    return rows.sort(byKeyAsc).map(toWorkItemSummaryDto);
  },

  /**
   * The TRANSITIVE `is_blocked_by` closure of `rootId` — "everything that must
   * land before this" — the read backing the AI `walk_blocking` tool (Subtask
   * 7.5.1). A breadth-first walk of the DAG's OUT edges, returning the transitive
   * blocker NODES (excluding the root) plus the EDGES between them (as ids, keyed
   * to identifiers at the boundary). Three defenses make it safe on any graph:
   *   - **cycle-safe** — a `visited` set means a node is expanded at most once, so
   *     even a (core-forbidden but defended-against) cycle A→B→A terminates.
   *   - **node-capped** — the closure stops growing past `maxNodes` distinct
   *     blockers (clamped to `[1, MAX_BLOCKING_NODES]`, default
   *     `DEFAULT_BLOCKING_NODES`); a blocker skipped by the cap is dropped WITH its
   *     edge (its node would be unresolvable), and `truncated` is set.
   *   - **depth-capped** — at most `maxDepth` BFS levels (clamped to
   *     `[1, MAX_BLOCKING_DEPTH]`); levels left unwalked set `truncated`.
   * Browse-gated as the caller (`findById` workspace check → 404, then
   * `assertCanBrowse`). SCOPED to the root's project — a cross-project blocker
   * (a same-workspace link the token's user may not browse) is not traversed, so
   * the walk reads only the token's project (finding #26).
   */
  async getBlockingClosure(
    rootId: string,
    ctx: ServiceContext,
    opts: { maxDepth?: number; maxNodes?: number } = {},
  ): Promise<{
    nodes: WorkItemSummaryDto[];
    edges: Array<{ blockedId: string; blockerId: string }>;
    truncated: boolean;
  }> {
    const root = await readWorkItem(rootId, ctx);
    if (!root || root.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(rootId);
    await projectAccessService.assertCanBrowse(root.projectId, ctx);

    const maxNodes = clampBound(opts.maxNodes, 1, MAX_BLOCKING_NODES, DEFAULT_BLOCKING_NODES);
    const maxDepth = clampBound(opts.maxDepth, 1, MAX_BLOCKING_DEPTH, DEFAULT_BLOCKING_DEPTH);

    // `visited` seeds with the root so it is never re-added as a blocker of
    // itself (a cycle) and never re-expanded; `closureIds` is the returned
    // blocker set (root excluded).
    const visited = new Set<string>([rootId]);
    const closureIds = new Set<string>();
    const edges: Array<{ blockedId: string; blockerId: string }> = [];
    let frontier: string[] = [rootId];
    let truncated = false;
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
      const edgeRows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemLinkRepository.findBlockerEdgesForItems(frontier, undefined, tx),
      );
      const next: string[] = [];
      for (const e of edgeRows) {
        if (e.blockerProjectId !== root.projectId) continue; // out-of-project → out of scope
        if (!visited.has(e.blockerId)) {
          if (visited.size >= maxNodes) {
            truncated = true; // node cap reached — drop this blocker AND its edge
            continue;
          }
          visited.add(e.blockerId);
          closureIds.add(e.blockerId);
          next.push(e.blockerId);
        }
        edges.push({ blockedId: e.fromId, blockerId: e.blockerId });
      }
      frontier = next;
      depth++;
    }
    // Stopped at the depth cap with a non-empty frontier → more levels remain.
    if (frontier.length > 0) truncated = true;

    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIds([...closureIds], tx),
    );
    return { nodes: rows.sort(byKeyAsc).map(toWorkItemSummaryDto), edges, truncated };
  },

  /**
   * Whether `workItemId` is ready to start: every `is_blocked_by` blocker has
   * reached a TERMINAL status (Subtask 2.2.6, resolving finding #21). "Terminal"
   * is per-project — a status whose `category = done` in ITS OWN project's
   * workflow (so `done` AND `cancelled` count out of the box, and an admin who
   * recategorizes a status changes readiness live). Blockers can span projects,
   * so each is classified against its own project's terminal set.
   *
   * Two queries total, no N+1: one for the blocker `(status, projectId)` rows,
   * one batched `getTerminalStatusKeysByProjects` for every blocker-project's
   * terminal set. A blocker is OPEN unless its status is in its project's set.
   *
   * Thin boolean projection of {@link getReadiness} — the single source of the
   * per-project terminal logic. Callers that only need the yes/no (the Epic-7
   * ready-set engine — finding #42) use this; callers that must NAME the open
   * blockers (the 2.4.5 banner) use `getReadiness`.
   */
  async isReady(workItemId: string, ctx: ServiceContext): Promise<boolean> {
    return (await this.getReadiness(workItemId, ctx)).ready;
  },

  /**
   * The full readiness verdict: not just WHETHER the item is ready, but WHICH
   * `is_blocked_by` blockers are still open and WHICH session branch (if any) the
   * item's integrated deps live on. A blocker is SATISFIED iff it is TERMINAL
   * (its status is in ITS OWN project's `category = done` set — 2.2.6 /
   * finding #21, so `done`/`cancelled` count and a live recategorization
   * re-judges it) OR it is INTEGRATED-awaiting-review (a recorded `sessionBranch`
   * — Subtask 7.8.11's integrated-dep rule, keyed on the field, not the status).
   * Otherwise the blocker is OPEN. `openBlockerIds` (a Set, for an O(1) filter at
   * the call site) names exactly the still-open blockers so the relationships
   * banner can highlight them. `inheritedSessionBranch` is the single branch the
   * integrated deps share (what dispatch inherits); `conflictingSessionBranches`
   * is non-empty when those deps span MORE THAN ONE branch — conflicting lineages
   * that keep the item OUT of the ready set until a human merges one session PR.
   * An item with no blockers → ready, empty sets. Two queries total, no N+1.
   */
  async getReadiness(
    workItemId: string,
    // Only the workspace is read — a Visitor's detail passes its project's.
    ctx: Pick<ServiceContext, 'workspaceId'>,
  ): Promise<{
    ready: boolean;
    openBlockerIds: Set<string>;
    blockedByAncestorId: string | null;
    inheritedSessionBranch: string | null;
    conflictingSessionBranches: string[];
  }> {
    // The node's OWN-blocker verdict + the rich open-blocker / session-branch
    // detail. (`openBlockerIds` stays the node's OWN blockers — the relationships
    // banner highlights those; the cascade cause is surfaced separately as
    // `blockedByAncestorId`, the nearest own-blocked ancestor. Card 7.0.13's "may".)
    // THE assertion this whole story turns on: an empty edge set does not render
    // as "unknown", it renders as NOT BLOCKED — so unbound, every blocked item
    // reported itself READY and `claim_next_ready` would hand out work whose
    // prerequisites are unbuilt.
    const blockers = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockerStates(workItemId, tx),
    );
    let ownReady = true;
    let openBlockerIds = new Set<string>();
    let inheritedSessionBranch: string | null = null;
    let conflictingSessionBranches: string[] = [];
    if (blockers.length > 0) {
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        blockers.map((b) => b.projectId),
        ctx.workspaceId,
      );
      const cls = classifyBlockerReadiness(blockers, terminalByProject);
      ownReady = cls.ready;
      openBlockerIds = new Set(
        blockers.filter((b) => isOpenBlocker(b, terminalByProject)).map((b) => b.id),
      );
      inheritedSessionBranch = cls.inheritedSessionBranch;
      conflictingSessionBranches = cls.conflicting ? cls.sessionBranches : [];
    }
    // Cascade (Subtask 7.0.13): also gate on the ANCESTOR chain — ready only when
    // every ancestor is ready too. Checked even when the node has no own blocker,
    // because an unready ancestor still holds it out of the ready set.
    const ancestorsByItem = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findAncestorIdsForItems([workItemId], ctx.workspaceId, tx),
    );
    const ancestors = ancestorsByItem.get(workItemId) ?? [];
    let ancestorsReady = true;
    let blockedByAncestorId: string | null = null;
    if (ancestors.length > 0) {
      const ownReadyAnc = await computeOwnBlockerReadiness(ancestors, ctx);
      ancestorsReady = ancestors.every((a) => ownReadyAnc.get(a) !== false);
      // `ancestors` is nearest-first (parent, grandparent, …), so the FIRST
      // own-blocked ancestor is the nearest one — the cause the banner names.
      blockedByAncestorId = ancestors.find((a) => ownReadyAnc.get(a) === false) ?? null;
    }
    return {
      ready: ownReady && ancestorsReady,
      openBlockerIds,
      blockedByAncestorId,
      inheritedSessionBranch,
      conflictingSessionBranches,
    };
  },

  /**
   * {@link getReadiness}, RESOLVED into the 2.4.5 banner's own shape — the ids
   * turned into summaries. `getIssueDetail` builds this inline because it has
   * already loaded the link targets and the ancestor chain; the link Server
   * Actions have neither, and this is the read that lets them hand a FRESH
   * verdict straight back to the client panel.
   *
   * ⚠️ MOTIR-4496 — WHY A SECOND DOOR ONTO A VERDICT THE DETAIL READ ALREADY
   * COMPUTES. The relationships panel used to learn the banner's new state only
   * from `router.refresh()`, i.e. from a re-render of the WHOLE detail page (the
   * item, the children, the sprints, the to-dos, the roll-up, the pending
   * plans). Making the link ROWS optimistic without this would have handed that
   * whole-page wait to the banner instead of removing it — the panel's rows had
   * been absorbing it on the banner's behalf. One blocker read + one summary
   * read is what the banner actually depends on, so that is what the action
   * returns. Readiness stays SERVER-derived: nothing here re-derives a terminal
   * set in the browser.
   *
   * `openBlockers` is `key ASC` like every other relationship projection, so the
   * banner's blocker list does not re-order under the optimistic update.
   */
  async getReadinessVerdict(workItemId: string, ctx: ServiceContext): Promise<ReadinessVerdictDto> {
    const readiness = await this.getReadiness(workItemId, ctx);
    const ids = [...readiness.openBlockerIds];
    if (readiness.blockedByAncestorId !== null) ids.push(readiness.blockedByAncestorId);
    if (ids.length === 0) {
      return { ready: readiness.ready, openBlockers: [], blockedByAncestor: null };
    }
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdsInWorkspace(ids, ctx.workspaceId, tx),
    );
    return {
      ready: readiness.ready,
      openBlockers: rows
        .filter((r) => readiness.openBlockerIds.has(r.id))
        .sort(byKeyAsc)
        .map(toWorkItemSummaryDto),
      blockedByAncestor:
        readiness.blockedByAncestorId === null
          ? null
          : (rows
              .filter((r) => r.id === readiness.blockedByAncestorId)
              .map(toWorkItemSummaryDto)[0] ?? null),
    };
  },

  /**
   * Batch readiness (finding #21) for MANY items at once — the board projection
   * (3.1.4) needs a `ready` flag per card without a per-card N+1, and the ready
   * set (7.0) filters candidates by it. Returns a Map keyed by EVERY requested id
   * (an item with no blocker, or only satisfied blockers, is ready). Same rule as
   * `getReadiness` (terminal OR integrated satisfies; conflicting lineages →
   * not ready — Subtask 7.8.11), over ONE batched blocker read + ONE batched
   * terminal-set read.
   */
  async getReadinessForItems(
    itemIds: string[],
    // Only the workspace is read — a Visitor's roadmap passes its project's.
    ctx: Pick<ServiceContext, 'workspaceId'>,
  ): Promise<Map<string, boolean>> {
    const ready = new Map<string, boolean>(itemIds.map((id) => [id, true]));
    if (itemIds.length === 0) return ready;
    // Cascade (Subtask 7.0.13): a node is ready ⟺ its OWN sibling blockers are
    // done AND every ANCESTOR is ready. Resolve the ancestor chains, compute
    // OWN-blocker readiness over the union (items + ancestors) in ONE batch
    // (no N+1), then AND the chain in. The flat per-node blocker rule still
    // holds at each level; an unready ancestor (its own open blocker, or ITS
    // ancestor unready) holds the whole subtree out of the ready set — the
    // mirror of 7.0.10 (a parent-with-children is excluded; its children wait
    // until it is ready).
    const ancestorsByItem = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findAncestorIdsForItems(itemIds, ctx.workspaceId, tx),
    );
    const union = new Set<string>(itemIds);
    for (const chain of ancestorsByItem.values()) for (const a of chain) union.add(a);
    const ownReady = await computeOwnBlockerReadiness([...union], ctx);
    for (const id of itemIds) {
      const selfReady = ownReady.get(id) !== false;
      const chainReady = (ancestorsByItem.get(id) ?? []).every((a) => ownReady.get(a) !== false);
      ready.set(id, selfReady && chainReady);
    }
    return ready;
  },

  /**
   * Fetch ONE work item by id, scoped to the caller's active workspace. Returns
   * the full DTO, or throws WorkItemNotFoundError when the row is absent OR
   * belongs to a DIFFERENT workspace — the 404-not-403 no-existence-leak
   * contract (a cross-tenant id is indistinguishable from a never-existed one).
   *
   * This is the explicit application-layer tenancy gate that the work_item RLS
   * policy (1.4.5) backstops structurally. It exists because the other read
   * methods (listWorkItems / getWorkItemSubtree / getBlockers …) trust RLS for
   * tenant scoping, but RLS is INERT on the dev/CI connection (the `prodect`
   * superuser has BYPASSRLS) — so an explicit `workspaceId` check is the
   * PRIMARY gate there. Route handlers also reuse this as a pre-flight guard
   * before a mutation (PATCH/DELETE/link), so a cross-tenant write 404s before
   * the unguarded mutation method runs.
   */
  async getWorkItem(id: string, ctx: ServiceContext): Promise<WorkItemDto> {
    const row = await readWorkItem(id, ctx);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    return toWorkItemDto(row);
  },

  /**
   * Resolve a work item by its human identifier (e.g. "PROD-7") within a
   * project — the read backing the edit route (Subtask 2.3.6), whose URL is
   * keyed by identifier. Cross-workspace (or missing) → WorkItemNotFoundError so
   * the route renders 404 without leaking another tenant's existence.
   */
  /**
   * Resolve MANY `MOTIR-<n>` identifiers to their work-item ids, in ONE round
   * trip (Story 11.3 · Subtask 11.3.7 — MOTIR-2064).
   *
   * ⚠️ WHY THIS EXISTS rather than a loop over `getWorkItemByIdentifier`. The
   * `/api/v1` ADR's Amendment 3 (Q4) pins the bounded-call rule: a route may
   * make a CONSTANT number of service calls that resolve or project one
   * response, and never one per row. A batch membership move takes up to 100
   * keys, so resolving them one at a time would be exactly the N+1 that rule
   * forbids — and would do it in the route, where it is least visible.
   *
   * A batched re-presentation of the shipped `workItemRepository.findByIdentifiers`
   * (5.8.3's mention resolver already uses it): same predicate, same
   * project scope, no new field, no new gate, no filter axis — the carve-out
   * Amendment 3 (Q3) records.
   *
   * ⚠️ An UNRESOLVED key THROWS rather than being dropped. The repository read
   * silently omits a miss, which is right for mention-scanning and wrong here:
   * a caller moving five items must not have four of them move because the fifth
   * key was a typo. Raising `WorkItemNotFoundError` before any write is what
   * makes the batch atomic, and it names the FIRST offending key so the caller
   * can fix it.
   *
   * `projectId` must already be workspace-resolved by the caller (every v1 route
   * reaches it through `projectsService.getByKey`, which is workspace-gated), so
   * an identifier from another tenant simply does not exist in this project and
   * raises the same not-found error — no existence leak.
   *
   * Returns the ids in the SAME ORDER as `identifiers`, because the membership
   * move ranks items in request order and a reordered batch would silently
   * shuffle the sprint.
   */
  async resolveIdentifiersToIds(
    projectId: string,
    identifiers: string[],
    ctx: ServiceContext,
  ): Promise<string[]> {
    if (identifiers.length === 0) return [];
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifiers(projectId, identifiers, tx),
    );
    const idByIdentifier = new Map(rows.map((row) => [row.identifier, row.id]));
    return identifiers.map((identifier) => {
      const id = idByIdentifier.get(identifier);
      if (id === undefined) throw new WorkItemNotFoundError(identifier);
      return id;
    });
  },

  async getWorkItemByIdentifier(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(projectId, identifier, tx),
    );
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(identifier);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    // A hosted run's own credential reaches its run's cards and no other
    // (MOTIR-6557) — the one gate every keyed `/api/v1` operation it may call
    // opens with. A no-op for every other caller.
    await runTokenScopeService.assertReachesWorkItems([row.id], ctx);
    return toWorkItemDto(row);
  },

  /**
   * Resolve a work item within ONE project by EITHER of the two forms a planner
   * holds (MOTIR-8940): its `<KEY>-<n>` identifier, or its internal id.
   *
   * ⚠️ WHY BOTH. A plan names committed cards by id — `parentRef`,
   * `blockedByRefs`, `workItemId` — while this read took a key only, so a
   * planning session that followed the ref its own plan stores was refused and
   * had to search by title to find the card. The two forms cannot collide: a key
   * always carries a dash and a work-item id (a cuid) never does.
   *
   * The id arm keeps every gate the key arm has — workspace binding, browse,
   * the run-token scope — and holds the row to `projectId`, so an id from
   * another project is the same not-found an unknown key is.
   */
  async getWorkItemByRef(
    projectId: string,
    ref: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const trimmed = ref.trim();
    if (trimmed.includes('-')) {
      return workItemsService.getWorkItemByIdentifier(projectId, trimmed, ctx);
    }
    const row = await readWorkItem(trimmed, ctx);
    if (!row || row.workspaceId !== ctx.workspaceId || row.projectId !== projectId) {
      throw new WorkItemNotFoundError(trimmed);
    }
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    await runTokenScopeService.assertReachesWorkItems([row.id], ctx);
    return toWorkItemDto(row);
  },

  /**
   * ALL SEVEN relationship groups of one item (MOTIR-4063) — the SAME assembly
   * `getIssueDetail` renders, without the twelve other reads a detail page buys.
   *
   * The caller has already resolved and GATED the item (it is passing an id, so
   * it must have); this method adds no gate of its own beyond the workspace
   * binding every read here runs under. ONE transaction for the method, two
   * batched phases inside it — the links, then their far ends — so a link set
   * costs a constant number of queries whatever its size
   * (`docs/decisions/bound-read-transaction-shape.md`).
   *
   * `restrictToProjectId` drops every far end outside that project. It is what a
   * caller scoped to ONE project passes: a relationship edge may legitimately
   * cross projects, so without it a read pinned to project A can name a row in
   * project B. A caller with a real viewer (the item page, the MCP) omits it and
   * gets the whole graph, as it always has.
   */
  async getRelationshipLinks(
    itemId: string,
    ctx: ServiceContext,
    opts: { restrictToProjectId?: string } = {},
  ): Promise<RelationshipLinkGroups> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const links = await readRelationshipLinkRows(itemId, tx);
      const rows = await resolveRelationshipTargetRows(links, tx);
      return toRelationshipGroups(
        links,
        opts.restrictToProjectId === undefined
          ? rows
          : keepRelationshipTargetsInProject(rows, opts.restrictToProjectId),
      );
    });
  },

  /**
   * The LINEAGE read (MOTIR-2070) — `getWorkItemByIdentifier` plus the item's
   * ancestor chain, for a caller that needs where the item SITS in the tree.
   * The planning workspace's `?item=` anchor is the caller: to open its
   * drill-down canvas ON the anchor's own level it needs the level's parent AND
   * every ancestor's `identifier` + `title` for the breadcrumb — the bare
   * identifier read carries neither, and `getIssueDetail` buys thirteen parallel
   * reads to get them.
   *
   * Same gate as `getWorkItemByIdentifier` (tenant check then `assertCanBrowse`,
   * cross-workspace / unknown → `WorkItemNotFoundError`, no existence leak), plus
   * ONE workspace-scoped recursive CTE bounded by the 4-level tree cap. Ancestors
   * come back root→self, item EXCLUDED — a top-level item yields `[]`.
   */
  async getWorkItemWithAncestors(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemLineageDto> {
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifier(projectId, identifier, tx),
    );
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(identifier);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    const ancestorRows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findAncestors(row.id, ctx.workspaceId, tx),
    );
    return { item: toWorkItemDto(row), ancestors: ancestorRows.map(toWorkItemSummaryDto) };
  },

  /**
   * The planning surface's ANCHOR read (MOTIR-7621) — the lineage read plus
   * whether the anchor has children, so the arrival rule can open INSIDE a
   * target only when there is something inside it.
   *
   * The lineage half is `getWorkItemWithAncestors` verbatim — same tenant gate,
   * same `assertCanBrowse`, same no-existence-leak `WorkItemNotFoundError` — and
   * the count is the lazy tree's own level count for that parent, so the answer
   * agrees with the level the canvas would load.
   */
  async getPlanningAnchor(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<PlanningAnchorLineageDto> {
    const lineage = await this.getWorkItemWithAncestors(projectId, identifier, ctx);
    const childCount = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.countProjectTreeLevel(
        lineage.item.projectId,
        ctx.workspaceId,
        lineage.item.id,
        null,
        tx,
      ),
    );
    return { ...lineage, hasChildren: childCount > 0 };
  },

  /**
   * Resolve a work item by an EXACT title + kind within a project — a MARKER
   * lookup for a known, migration-created infra item (MOTIR-1466 / MOTIR-2201 —
   * the planner-bug home EPIC the auto-bug files under). Same tenant + browse
   * gate as `getWorkItemByIdentifier` (cross-workspace → treated as absent).
   * Returns `null` (not a throw) when nothing matches, so the caller can raise a
   * marker-specific error; the repo returns the lowest-`key` match, so the
   * result is deterministic even if a stray duplicate ever exists.
   */
  async getWorkItemByProjectKindAndTitle(
    projectId: string,
    kind: WorkItemKind,
    title: string,
    ctx: ServiceContext,
  ): Promise<WorkItemDto | null> {
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByProjectKindAndTitle(projectId, kind, title, tx),
    );
    if (!row || row.workspaceId !== ctx.workspaceId) return null;
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    return toWorkItemDto(row);
  },

  // (MOTIR-2201 removed `getFirstChildOfKind` — the planner-bug-home resolution
  // was its only caller, and reading "the first child of kind X" as if it were a
  // stable handle is the bug that card exists to remove. The home EPIC is now
  // the parent itself; see `lib/ai/plannerBugHome.ts` — since MOTIR-5822 the
  // marker resolves to a FOLDER and no work item is a parent at all.)

  /**
   * Is a work item FINISHABLE? (Subtask 7.8.23) — the single-item analogue of
   * `sprintsService.validateSprint`, with the target's SUBTREE playing the role
   * of the sprint. The target may be any non-leaf kind (epic / story / task /
   * bug — a `subtask` is the leaf). VALID ⟺ for EVERY not-`done` item in the
   * subtree (the target + every live descendant), every `blocked_by` dependency
   * is SATISFIED: it is itself IN the subtree (the target's own work — never
   * gates), or — under `condition: 'loose'` (the default) — already `done`.
   * Under `tight`, a `done` dependency OUTSIDE the subtree no longer satisfies
   * (the subtree must be self-contained). A not-done out-of-subtree dependency
   * gates under both. The parent→child completion cascade is automatic: a child
   * is always in the subtree, so it never gates — its own out-of-subtree
   * blockers surface when the child itself is checked.
   *
   * A pure READ gated like `get_work_item` (tenant gate + `assertCanBrowse` via
   * `getWorkItemByIdentifier`, throwing `WorkItemNotFoundError` for an unknown /
   * cross-workspace key). "Done" is the project's terminal set (`category =
   * 'done'`; finding #21), judged against each blocker's OWN project (blocks can
   * be cross-project). Archived/triage members and archived blockers are ignored.
   *
   * It also returns `softBlocks` (MOTIR-6354 / MOTIR-6368): the open blockers of
   * the target's ANCESTORS — blocks that reach the target only through the
   * readiness cascade (overridable with `--allow-soft-block`). NON-gating: they
   * never change `valid`, which stays "can this subtree finish".
   */
  async validateWorkItem(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    condition: ValidityCondition = DEFAULT_VALIDITY_CONDITION,
  ): Promise<WorkItemValidityDto> {
    const root = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    return computeWorkItemValidity(root, ctx, condition);
  },

  /**
   * The aggregate read backing the issue DETAIL page (Subtask 2.4.1, grown by
   * 2.4.5): one service call assembling the item + its immediate parent +
   * direct children + ALL of its relationship links (resolved to summaries,
   * grouped by kind) + a readiness verdict + the project's workflow. Tenant gate
   * FIRST (cross-workspace / missing identifier → WorkItemNotFoundError → 404,
   * no existence leak), then the rest fans out in parallel.
   *
   * Link groups: `blockedBy` = items this item `is_blocked_by` (its OUT edges of
   * that kind); `blocks` = items blocked by it (the IN edges); `relatesTo` /
   * `duplicates` / `clones` = its OUT edges of those kinds (`relates_to` persists
   * a reciprocal row, so its OUT set already covers both directions);
   * `supersedes` = the OLDER items this one replaces (OUT `supersedes` edges) and
   * `supersededBy` = the NEWER items that replace it (IN edges). Each group
   * is `key ASC`-ordered. `readiness` is the 2.4.5 ready/blocked verdict —
   * `getReadiness` classifies each blocker against ITS OWN project's terminal set
   * (2.2.6 / finding #21), and `openBlockers` re-projects the open ids back onto
   * the resolved `blockedBy` summaries so the banner can name them without a
   * second pass. Link targets can be cross-project; they're resolved by id and
   * rendered read-only here (link MANAGEMENT is a later surface — Epic 5).
   */
  async getIssueDetail(
    projectId: string,
    identifier: string,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<IssueDetailDto> {
    // A VISITOR (MOTIR-6652) reads one public project; any other project, and any
    // item in the private-epic hidden set, answers EXACTLY as an unknown key does
    // — the same `WorkItemNotFoundError`, never a refusal that confirms the key.
    const visitor = isVisitorContext(ctx) ? ctx : null;
    if (visitor && visitor.project.id !== projectId) throw new WorkItemNotFoundError(identifier);
    const workspaceId = visitor ? visitor.project.workspaceId : (ctx as ServiceContext).workspaceId;
    const item = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRepository.findByIdentifier(projectId, identifier, tx),
    );
    if (!item || item.workspaceId !== workspaceId) {
      throw new WorkItemNotFoundError(identifier);
    }
    if (visitor) {
      if (visitor.hiddenIds.has(item.id)) throw new WorkItemNotFoundError(identifier);
    } else {
      await projectAccessService.assertCanBrowse(item.projectId, ctx as ServiceContext);
      // A run token reads only its run's cards (MOTIR-6557).
      await runTokenScopeService.assertReachesWorkItems([item.id], ctx as ServiceContext);
    }
    const hidden = visitor ? visitor.hiddenIds : null;

    // The detail fan-out is ONE contiguous run of this method's own reads, so it
    // opens ONE bound transaction (docs/decisions/bound-read-transaction-shape.md).
    // `workflowsService.getWorkflow` is a SERVICE call and stays outside it.
    const workflow = await workflowsService.getWorkflow(projectId, workspaceId);
    const [
      ancestorRows,
      childRows,
      linkRows,
      labelRows,
      componentRows,
      customFieldRows,
      watcherCount,
      viewerIsWatching,
    ] = await withWorkspaceServiceContext(workspaceId, async (tx) => [
      // The breadcrumb chain (root→self, item excluded) — one CTE, workspace-
      // scoped. The immediate parent is `ancestors`' last element; we surface it
      // separately too so the 2.4.2 rail's Parent field need not re-derive it.
      await workItemRepository.findAncestors(item.id, workspaceId, tx),
      await workItemRepository.findChildren(item.id, tx),
      // The seven relationship batches, from the SHARED assembly the AI boundary
      // also reads (MOTIR-4063) — one query per group, riding this fan-out.
      await readRelationshipLinkRows(item.id, tx),
      // The issue's labels (5.4.2) — one bounded query riding the same
      // fan-out (no extra round-trip; capped per-issue by labelsService).
      await labelRepository.listByWorkItem(item.id, tx),
      // The issue's components (5.4.3) — the same bounded-slot shape as
      // labels: one query riding the fan-out, name-ordered, bounded by the
      // admin-curated taxonomy.
      await componentRepository.listByWorkItem(item.id, tx),
      // The project's custom-field definitions + THIS issue's values (5.3.3)
      // — ONE bounded query (≤50 defs by the project cap, ≤1 value row per
      // def by the pair unique), options + value relations resolved in the
      // same operation. No N+1, no second round-trip.
      await customFieldDefinitionRepository.listWithValuesForWorkItem(
        item.projectId,
        workspaceId,
        item.id,
        tx,
      ),
      // The header eye-count + the caller's own watch state (5.4.4) — two
      // point reads riding the same fan-out, so the watch control renders
      // from the detail read with no extra round-trip.
      await watcherRepository.countByWorkItem(item.id, tx),
      // A Visitor watches nothing (they cannot write a watcher row).
      visitor
        ? false
        : await watcherRepository.existsFor(item.id, (ctx as ServiceContext).userId, tx),
    ]);

    // The seven relationship batches are THIS method's own reads and share ONE
    // bound transaction (the 5-wide fan-out MOTIR-2799 measured); `getReadiness`
    // is a service call and opens its own, per the call-into-another-service
    // clause in the transaction-shape ADR.
    const { targetRows, archivedActor, placementPath } = await withWorkspaceServiceContext(
      workspaceId,
      async (tx) => ({
        // A Visitor's far ends are kept to their project and out of the hidden
        // set, so an edge to a private epic's descendant never reaches them.
        targetRows: visitor
          ? keepRelationshipTargetsInProject(
              await resolveRelationshipTargetRows(linkRows, tx),
              projectId,
              visitor.hiddenIds,
            )
          : await resolveRelationshipTargetRows(linkRows, tx),
        // Who archived it (2.9.6) — ONLY for an archived item; an active item
        // skips the read entirely (no extra round-trip on the common path). The
        // banner names the actor from this; the timestamp rides `item.archivedAt`.
        archivedActor: item.archivedAt
          ? await workItemRevisionRepository.findLatestArchivedActor(item.id, tx)
          : null,
        // The EFFECTIVE folder's name path (MOTIR-5375) — one bounded chain read
        // when a folder applies, none otherwise; the root ancestor's `folderId`
        // already rode `findAncestors`' `SELECT w.*`.
        placementPath: await readPlacementPath(item.folderId, ancestorRows, tx),
      }),
    );
    const readiness = await this.getReadiness(item.id, { workspaceId });

    const placement = toWorkItemPlacementDto(item.folderId, ancestorRows, placementPath);
    const ancestors = placement.ancestors;
    const linkGroups = toRelationshipGroups(linkRows, targetRows);
    const blockedBy = linkGroups.blockedBy;
    const openBlockers = blockedBy
      .filter((l) => readiness.openBlockerIds.has(l.item.id))
      .map((l) => l.item);
    // The cascade cause (7.0.13): resolve the nearest own-blocked ancestor id
    // back to its summary from the breadcrumb chain we already loaded (no extra
    // read). null when the item isn't held by a blocked ancestor.
    const blockedByAncestor =
      readiness.blockedByAncestorId === null
        ? null
        : (ancestors.find((a) => a.id === readiness.blockedByAncestorId) ?? null);

    const itemRepositories = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemRepoRepository.listByWorkItem(item.id, tx),
    );
    // The To fix ENTRY the card is one of (MOTIR-7589): read only for a stuck card whose
    // key can be shared, and never for a Visitor — the pointer names other cards.
    const fixPointer =
      visitor || item.fixReason === null
        ? null
        : ((
            await withWorkspaceServiceContext(workspaceId, (tx) =>
              fixGroupPointersFor(workspaceId, [item], tx),
            )
          ).get(item.id) ?? null);

    return {
      // The resolved repository REFERENCES (MOTIR-3041) ride the detail shape,
      // which is the read that can guarantee the join — the same place
      // `repoDelivery` already lives, and for the same reason.
      item: visitor
        ? redactVisitorItem(
            stripPrivateEpicTells(toWorkItemDto(item, itemRepositories), item.publicChildrenHidden),
            visitor.hiddenIds,
          )
        : toWorkItemDto(item, itemRepositories),
      folderId: placement.folderId,
      placementFolder: placement.placementFolder,
      fixReason: item.fixReason,
      fixDetail: toFixDetailDto(item.fixReason, item.fixDetail),
      fixGroup:
        fixPointer && fixPointer.kind !== 'card'
          ? {
              kind: fixPointer.kind,
              headKey: fixPointer.headKey,
              isHead: fixPointer.headId === item.id,
              carriedKeys: fixPointer.carriedKeys,
            }
          : null,
      ancestors,
      parent: placement.parent,
      // A Visitor's child panel names no hidden child; a private epic's is empty.
      children: (hidden ? childRows.filter((c) => !hidden.has(c.id)) : childRows).map(
        toWorkItemSummaryDto,
      ),
      ...(visitor && item.kind === 'epic' && item.publicChildrenHidden
        ? { childrenHidden: true as const }
        : {}),
      ...linkGroups,
      readiness: { ready: readiness.ready, openBlockers, blockedByAncestor },
      choiceBody: choiceBodyOf(item),
      workflow,
      labels: labelRows.map(toLabelDto),
      components: componentRows.map(toComponentDto),
      customFields: customFieldRows.map(toCustomFieldWithValueDto),
      watcherCount,
      viewerIsWatching,
      archivedBy: archivedActor,
    };
  },

  /**
   * A filed item's folder PATH, names root-first (MOTIR-5352) — one bounded chain
   * read, and none at all for an unfiled item. The ONE path read the quick view and
   * the `/api/v1` work-item detail (MOTIR-5412) share, so the two cannot disagree
   * about where an item sits. Pass `IssueDetailDto.folderId`: the detail read that
   * produced it already gated the caller, and a folder belongs to its item's
   * project, so this read opens no gate of its own.
   */
  async getFolderPath(folderId: string | null, ctx: ServiceContext): Promise<string[]> {
    if (folderId === null) return [];
    return withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      folderRepository.findPathNames(folderId, tx),
    );
  },

  /**
   * A work item's OWN folder placement (Story MOTIR-5310 · MOTIR-5413) — the
   * `folderId` on its row and that folder's path, names root-first; both `null`
   * for an unfiled item. The OWN placement, never the effective one a child of a
   * filed epic inherits on the item page: only a root is ever filed. The MCP
   * write tools read it back after a create or a move, so the placement they
   * report is the row's, not a value re-derived from their own arguments.
   */
  async getWorkItemOwnPlacement(
    id: string,
    ctx: ServiceContext,
  ): Promise<{ folderId: string | null; folderPath: string[] | null }> {
    const row = await readWorkItem(id, ctx);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(id);
    await projectAccessService.assertCanBrowse(row.projectId, ctx);
    if (row.folderId === null) return { folderId: null, folderPath: null };
    return { folderId: row.folderId, folderPath: await this.getFolderPath(row.folderId, ctx) };
  },

  /**
   * Where ONE work item sits right now (Story MOTIR-5309 · MOTIR-5375) — the
   * placement slice of {@link getIssueDetail}, computed by the SAME mapper, for a
   * page that has just moved the item (its Parent or Folder field) and must
   * re-ask without buying the detail aggregate's thirteen reads. Same workspace
   * binding, same not-found for a foreign / unknown / other-project id, same
   * browse gate.
   */
  async getWorkItemPlacement(
    projectId: string,
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemPlacementDto> {
    const item = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item || item.workspaceId !== ctx.workspaceId || item.projectId !== projectId) {
      throw new WorkItemNotFoundError(workItemId);
    }
    await projectAccessService.assertCanBrowse(item.projectId, ctx);
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const ancestorRows = await workItemRepository.findAncestors(item.id, ctx.workspaceId, tx);
      const placementPath = await readPlacementPath(item.folderId, ancestorRows, tx);
      return toWorkItemPlacementDto(item.folderId, ancestorRows, placementPath);
    });
  },

  /**
   * The condensed QUICK-VIEW (peek) payload for `?peek=<identifier>` (Subtask
   * 2.5.19; bug 8.8.2 made the peek a client-fetched island). Reuses the SAME
   * aggregate read the full detail page uses (`getIssueDetail` — inheriting its
   * workspace gate + `assertCanBrowse` + not-found path, so a stale / deleted /
   * cross-workspace / forbidden key throws `WorkItemNotFoundError` /
   * `ProjectAccessDeniedError`, which the route renders as the not-found panel —
   * never an existence leak), then resolves assignee/reporter names + status /
   * due / estimate labels server-side so the client panel stays presentational.
   * The full field set (8.8.8) rides the SAME detail read; the only extra read
   * is the committed sprint's NAME (`sprintId` is on the detail item but its
   * name is not), and only when the item is actually in a sprint.
   */
  async getQuickView(
    projectId: string,
    identifier: string,
    accessMode: ProjectAccessMode,
    ctx: ServiceContext,
    locale: Locale,
  ): Promise<QuickViewData> {
    // MOTIR-2562 — the peek's rail is a WRITE surface, so this read also carries
    // the editor inputs. WHAT EACH COSTS, so the next reader can see the price of
    // a payload that is on the hot path of every row click:
    //   • `id`, the raw field values and the WORKFLOW ride `detail` (the existing
    //     aggregate) — free.
    //   • `members` was already being read here for the name lookup — free.
    //   • `sprints` and `projectComponents` are the only NEW queries: two
    //     project-scoped list reads, added to this same Promise.all so they cost
    //     one round trip rather than lengthening the chain.
    // `componentRepository.listByProject` is the leaf, not
    // `componentsService.listComponents` — the service form takes the project
    // KEY (not known until `detail` resolves), re-resolves the project and
    // re-asserts `canBrowse`, all of which `getIssueDetail` has already done in
    // this same call. Reading the leaf and mapping it is the pattern
    // `getIssueDetail` itself uses for the item's own components.
    // Sprints come off the LEAF and are projected to the four fields
    // `SprintPicker` reads. `sprintsService.listByProject` would return the full
    // `SprintDto`, but it runs one `countSprintIssues` query PER SPRINT to fill
    // `issueCount` — 1+N on a `no-store` payload fetched on every row click, for
    // a field the picker never reads. (It also re-asserts `project:browse`,
    // which `getIssueDetail` has already done in this same call.)
    // ⚠️ `allSettledOrThrow`, NOT `Promise.all` (MOTIR-3066). Arm 0 is the ACCESS
    // GATE, and it rejects on the ordinary 404 path — a foreign, unknown or
    // deleted key. `Promise.all` would reject the moment it does and return,
    // leaving the four sibling arms running with nobody awaiting them; each is a
    // `withWorkspaceServiceContext` INTERACTIVE TRANSACTION, so each abandoned arm
    // holds locks past the point where the caller believes the peek is over. In
    // the test suite that is what the next test's `TRUNCATE … CASCADE` reset
    // deadlocked against (`40P01`, killing a `beforeEach` in an innocent file);
    // in production it is a pool connection and a row lock held after the 404 has
    // been sent, on a path that runs on every row click. Settling all five costs
    // nothing on the happy path and makes the refusal path bounded.
    const [detail, members, sprintRows, componentRows, estimationConfig] = await allSettledOrThrow([
      this.getIssueDetail(projectId, identifier, ctx),
      assignableMembersService.list({ projectId, accessMode, ctx }),
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        sprintRepository.listByProject(projectId, ctx.workspaceId, tx),
      ),
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        componentRepository.listByProject(projectId, tx),
      ),
      // MOTIR-2593 — the estimation config the composed `EstimateBadge` needs.
      // One primary-key project read, in the same round trip; without it the
      // badge falls back to a read-only default and is silently inert on every
      // peek surface.
      estimationService.getEstimationConfig(projectId, ctx),
    ]);
    const sprints = sprintRows.map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      sequence: s.sequence,
    }));
    const projectComponents = componentRows.map(toComponentDto);
    // Resolve the committed sprint's display name (8.8.8) — the one rail field
    // not carried by the detail aggregate. Epics span sprints, so the rail omits
    // the field for them (Jira-faithful, mirroring the detail rail); skip the
    // lookup for an epic or a backlog item.
    let sprintName: string | null = null;
    if (detail.item.sprintId && detail.item.kind !== 'epic') {
      const sprint = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        sprintRepository.findById(detail.item.sprintId as string, ctx.workspaceId, tx),
      );
      sprintName = sprint?.name ?? null;
    }
    // Work-item references (5.8.6) — `motir:` tokens in the description (live
    // body chips) + bare `MOTIR-N` in the title (the peek header's title link).
    // The project identifier prefix is `identifier` minus its `-<key>` suffix.
    const prefix = detail.item.identifier.slice(
      0,
      detail.item.identifier.length - String(detail.item.key).length - 1,
    );
    const workItemRefs = await resolveWorkItemRefSummaries(
      parseWorkItemRefs(
        [detail.item.title, detail.item.descriptionMd].filter(Boolean).join('\n'),
        prefix,
      ),
      projectId,
      ctx,
    );
    // Page chips (MOTIR-7697) — every `motir-page:` tag in the two bodies,
    // resolved under the reader's own `page:view` to its live title or the
    // unavailable state.
    const pageRefs = await pagesService.resolvePageRefSummaries(
      [
        ...parsePageTokenIds(detail.item.descriptionMd),
        ...parsePageTokenIds(detail.item.explanationMd),
      ],
      projectId,
      ctx,
    );
    // The Development section's linked PRs (MOTIR-1579). Tenancy rides the
    // detail read above: the PR link is keyed by the item's internal id, which
    // getIssueDetail already gated to the caller's workspace.
    const pullRequests = await this.listLinkedPullRequests(detail.item.id, ctx);
    // Per-repository DELIVERY (Story MOTIR-2725 · MOTIR-2416) — the SAME resolved
    // value the detail page reads, from the same service method calling the same
    // classifier. The peek showing a different delivery state from the detail
    // page is the drift this story exists to remove, so the two surfaces do not
    // each compute it.
    //
    // AMENDED by the delivery set since MOTIR-3660 — `getDeliveryView` returns
    // both halves so the peek and the detail page cannot combine them
    // differently.
    const deliveryView = await this.getDeliveryView(detail.item.id, detail.item.targetRepos, ctx);
    const repoDelivery = deliveryView.repos;
    // The Plan / Re-plan door's permission (MOTIR-910). Planning proposes plan
    // changes, so the peek shows the door only to an actor who could approve
    // them — the same `canEdit` the detail page gates it on. `getIssueDetail`
    // above has already asserted `canBrowse`, so this only widens to edit.
    const { canEdit } = await projectAccessService.getCapabilities(projectId, ctx);
    // The filed item's folder PATH (MOTIR-5352) — one bounded chain read, and
    // none at all for an unfiled item: this payload is fetched on every row click.
    const folderPath = await this.getFolderPath(detail.folderId, ctx);
    // The design result, for the Development block's slot (`design-result.md`
    // AMENDMENT 4 Q8) — read ONLY when a linked pull request is open, which is the
    // one case the peek draws it: without one the design is a section of the full
    // page, which the peek does not render. The same open-row test the block
    // applies (`hasOpenPullRequest`), over the same two lists.
    const hasOpenPr =
      pullRequests.some((pr) => pr.state === 'open') ||
      deliveryView.deliveries.some((d) => d.pullRequest.state === 'open');
    const designEvidence = hasOpenPr
      ? await designEvidenceService.getCurrentForWorkItem(detail.item.id, ctx)
      : null;
    // What a reload of the item page shows on each pull-request row after Approve and merge
    // (Bug MOTIR-5650) — *Queued to merge* / *Not merged yet*, from the same member facts the
    // Development frame reads. An approve-and-merge gate only ever covers a card's linked
    // pull requests, so a card with none skips the read: this payload is fetched on every row
    // click.
    const mergeMembers =
      pullRequests.length > 0 || deliveryView.deliveries.length > 0
        ? await pullRequestApprovalMembersService.listForLatestGate(
            { workItemId: detail.item.id },
            ctx,
          )
        : [];
    // The moves an approval HOLDS (Story MOTIR-4887 · MOTIR-5528) — the peek's
    // status field says so the way the detail page's does, from the same read.
    const heldTransitions = await approvalGatesService.listHeldTransitions(detail.item.id, ctx);
    // The undecided PLAN holding the card at Planning (Story MOTIR-6017 · MOTIR-6267)
    // — the peek's status field locks every move and says so with its Review plan
    // door, from the same read the item page makes.
    const planHold = await planTargetLockService.readPlanHold(detail.item.id, ctx);
    const view = toQuickViewData(
      detail,
      members,
      locale,
      sprintName,
      workItemRefs,
      prefix,
      pullRequests,
      canEdit,
      sprints,
      projectComponents,
      estimationConfig,
      repoDelivery,
      deliveryView.deliveries,
      folderPath,
      designEvidence,
    );
    // The reader's TRANSLATION offer (Story MOTIR-7735 · MOTIR-8122; design
    // MOTIR-8112, host difference 5): the quick view fetches its data here rather
    // than from the item page's server render, so the offer rides this read.
    // Built from the item's own fields — the peek shows no to-dos, and it offers
    // only for the title and description it draws (design D3). A failing read is
    // no offer, never a failed peek. A Visitor's peek carries none.
    // The project's auto-translate switch rides the same read (Story MOTIR-7738 ·
    // MOTIR-8832): the reader's context layers it, and the credit verdict, over the
    // offer, so the peek's host can start on mount. The switch is one primary-key
    // read; the entitlement is asked only when it is on and something differs.
    const translation = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepository.findAutoTranslateWorkContent(projectId, tx),
    )
      .then((project) =>
        readerTranslationContextService.resolveForItem({
          project: { autoTranslateWorkContent: project?.autoTranslateWorkContent ?? false },
          reader: ctx,
          readerLocale: locale,
          workItem: detail.item,
          todos: [],
        }),
      )
      .then((resolved) =>
        resolved
          ? {
              offer: resolved.offer,
              canAddCredits: resolved.canAddCredits,
              auto: resolved.context,
            }
          : null,
      )
      .catch(() => null);
    return { ...view, pageRefs, heldTransitions, planHold, mergeMembers, translation };
  },

  /**
   * The quick-view peek for a VISITOR (Story MOTIR-6170 · MOTIR-6647) — the same
   * `QuickViewData` a member's peek answers, composed only from reads that already
   * serve a Visitor: the redacted detail and chip map (MOTIR-6652, a hidden key is
   * `WorkItemNotFoundError`), names only for people (MOTIR-6646 — the member list
   * never leaves this method, only the name map `toQuickViewData` builds from it),
   * the project's sprint and component names, and its estimation config. The
   * Development surface is left EMPTY — no pull request, delivery, design result,
   * merge members, held transition or plan hold — because none of those reads
   * has a Visitor path; a Visitor edits nothing (`canEdit` false).
   */
  async getVisitorQuickView(
    identifier: string,
    ctx: VisitorReadContext,
    locale: Locale,
  ): Promise<QuickViewData> {
    const { workspaceId } = openVisitorRead(ctx.project.id, ctx);
    const projectId = ctx.project.id;
    const svc = visitorServiceContext(ctx);
    const [detail, people, sprintRows, componentRows, estimationConfig] = await allSettledOrThrow([
      this.getIssueDetail(projectId, identifier, ctx),
      assignableMembersService.listPersonLabels(ctx),
      withWorkspaceServiceContext(workspaceId, (tx) =>
        sprintRepository.listByProject(projectId, workspaceId, tx),
      ),
      withWorkspaceServiceContext(workspaceId, (tx) =>
        componentRepository.listByProject(projectId, tx),
      ),
      estimationService.getEstimationConfig(projectId, svc),
    ]);
    let sprintName: string | null = null;
    if (detail.item.sprintId && detail.item.kind !== 'epic') {
      const sprint = await withWorkspaceServiceContext(workspaceId, (tx) =>
        sprintRepository.findById(detail.item.sprintId as string, workspaceId, tx),
      );
      sprintName = sprint?.name ?? null;
    }
    const prefix = detail.item.identifier.slice(
      0,
      detail.item.identifier.length - String(detail.item.key).length - 1,
    );
    const workItemRefs = await this.resolveReferenceSummaries(
      parseWorkItemRefs(
        [detail.item.title, detail.item.descriptionMd].filter(Boolean).join('\n'),
        prefix,
      ),
      projectId,
      ctx,
    );
    const folderPath = await this.getFolderPath(detail.folderId, svc);
    const view = toQuickViewData(
      detail,
      // NAMES ONLY: `toQuickViewData` reads a member only to build its name map,
      // so an email-free row is all it is handed.
      people.map((p) => ({ userId: p.id, name: p.name, email: '' }) as WorkspaceMemberDTO),
      locale,
      sprintName,
      workItemRefs,
      prefix,
      [],
      false,
      sprintRows.map((row) => ({
        id: row.id,
        name: row.name,
        state: row.state,
        sequence: row.sequence,
      })),
      componentRows.map(toComponentDto),
      estimationConfig,
      [],
      [],
      folderPath,
      null,
    );
    // A Visitor reads no page: every chip resolves unavailable, and the bodies'
    // page labels were redacted by the detail read (MOTIR-7697).
    const pageRefs = await pagesService.resolvePageRefSummaries(
      [
        ...parsePageTokenIds(detail.item.descriptionMd),
        ...parsePageTokenIds(detail.item.explanationMd),
      ],
      projectId,
      ctx,
    );
    return { ...view, pageRefs, heldTransitions: [], planHold: null, mergeMembers: [] };
  },

  /**
   * A work item's linked PRs for the Development surface (Story 7.10 ·
   * MOTIR-1579) — display-ready (title fallback, merged collapse, per-PR CI,
   * link-out URL), newest-updated first. Shared by the quick-view peek payload
   * AND the detail page. Takes the item's INTERNAL id; callers pass an id an
   * access-gated read (getIssueDetail / getQuickView) already resolved — this
   * method adds no tenancy gate of its own.
   *
   * `ctx` is for the BINDING, not for a gate (MOTIR-2815): `github_pull_request`
   * is policy-gated, so the read needs the workspace GUC or it returns no PRs
   * for an item that has them. The parameter is required rather than optional
   * precisely so the next caller cannot forget it.
   */
  async listLinkedPullRequests(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<LinkedPullRequestDto[]> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const rows = await githubPullRequestRepository.listByWorkItemWithContext(workItemId, tx);
      const reviews = await readGithubReviewsForRows(rows, ctx.workspaceId, tx);
      return rows.map((row) => toLinkedPullRequestDto(row, reviews.get(row.id) ?? null));
    });
  },

  /**
   * A work item's DELIVERY SET (Story MOTIR-3655 · MOTIR-3697) — every pull request
   * that delivers this card, oldest link first, each with the CI verdict and the
   * two fields that say whether its merge reached the trunk.
   *
   * ── This is NOT `listLinkedPullRequests` under a new name ─────────────────
   * That method answered the same question off `github_pull_request.work_item_id`,
   * the SCALAR link, and so carried a structural ceiling of one card per pull
   * request: a `motir auto` pull request delivering twelve cards could be the link
   * target of at most one of them, and appeared on no other card's surface. Both
   * read `work_item_delivery` now (MOTIR-3756 moved the Development surface;
   * MOTIR-3757 dropped the column), so the two differ in their PROJECTION — that
   * one is display-ready for a rail, this one carries the completion facts a gate
   * decides on — rather than in what they can express.
   *
   * ⚠️ Empty is the ORDINARY answer. Nearly every card in the tree has no delivery
   * row, and every consumer — the gate, the rail, the CLI's watch loop — must read
   * an empty array as *nothing to say about this card*, never as *nothing has
   * landed*. That is why the shape is an array on every card and never `null`.
   *
   * `ctx` is for the BINDING, not for a gate (MOTIR-2815), exactly as
   * {@link listLinkedPullRequests}: `work_item_delivery` is policy-gated on
   * `app.workspace_id`, so an unbound read returns an EMPTY LIST for a card that
   * has deliveries — the failure that looks like an answer. Callers pass an id an
   * access-gated read has already resolved; this adds no tenancy gate of its own.
   */
  async listDeliverySet(workItemId: string, ctx: ServiceContext): Promise<WorkItemDeliveryDto[]> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      // READABLE members only (Bug MOTIR-8215): a member whose pull request or
      // repository this reader's organisation cannot see is absent, not a null
      // the mapper below would dereference.
      const rows = await workItemDeliveryRepository.listReadableByWorkItemWithChecks(
        workItemId,
        tx,
      );
      // Each member's STANDING queue failure (MOTIR-5720), over ONE read for the set
      // — the rule is `queueExitHoldsAtHead`, the same one the card's badge, the
      // promotion hold and the repair claim read.
      const byId = new Map(rows.map((row) => [row.githubPullRequestId, row.pullRequest]));
      const held = await standingQueueFailures(byId, tx);
      // …and its STANDING host merge refusal, with the host's own words (MOTIR-6735).
      const refused = await standingMergeRefusals(byId, tx);
      return rows.map((row) =>
        toWorkItemDeliveryDto(
          row,
          held.get(row.githubPullRequestId) ?? null,
          refused.get(row.githubPullRequestId) ?? null,
        ),
      );
    });
  },

  /**
   * Everything the two READ surfaces need to draw a card's delivery, in ONE call
   * (Story MOTIR-3655 · MOTIR-3660, design `design/work-items/delivery-set.mock.html`).
   *
   * ── Why this exists rather than two calls at each host ────────────────────
   * The rail's glyph and the Development section's rows are two views of one
   * question, and the detail page and the quick view must not answer it
   * differently. Handing each host two lists and a combining rule is exactly the
   * arrangement that let those two surfaces disagree before (MOTIR-3036), so the
   * combining happens HERE and a host makes no editorial decision at all.
   *
   * `repos` is the classified repository set AMENDED by the delivery set: a row
   * reads `delivered` only when neither completion gate holds on it. `deliveries`
   * is the set itself, which the caption needs because only the caption NAMES the
   * pull request that is outstanding.
   *
   * ⚠️ {@link listRepoDelivery} is deliberately LEFT ALONE and still returns the
   * unamended classification. Its other caller is `dispatchPromptService`, which
   * tells an agent what has landed before it starts work — a different audience
   * and a different question, and changing what a dispatch prompt says is not
   * this card's to do.
   */
  async getDeliveryView(
    workItemId: string,
    targetRepos: readonly string[],
    ctx: ServiceContext,
  ): Promise<{ repos: RepoDelivery[]; deliveries: WorkItemDeliveryDto[] }> {
    const [repos, deliveries] = await Promise.all([
      this.listRepoDelivery(workItemId, targetRepos, ctx),
      this.listDeliverySet(workItemId, ctx),
    ]);
    return { repos: amendRepoDeliveryWithSet(repos, deliveries), deliveries };
  },

  /**
   * PER-REPOSITORY DELIVERY for one item (Story MOTIR-2725 · MOTIR-2415) — every
   * repository the item CARRIES, in order, each with the state the completion
   * gate reads: `delivered` · `awaiting` · `unknown`.
   *
   * A RESOLVED value, so it is computed here, server-side, in the detail page's
   * existing data path — never a client round trip on a server-rendered page.
   *
   * ⚠️ It calls the SAME `classifyRepoDelivery` the completion gate calls
   * (`lib/workItems/repoDelivery.ts`). That is the point of the shared module: a
   * second implementation would let the panel say `delivered` while the gate
   * holds the card In Review, and a ledger that disagrees with the rule it
   * displays is worse than no ledger.
   *
   * Same workspace-context requirement as the linked-PR read above — the
   * `github_pull_request` policy is workspace-keyed, so an unbound read returns
   * no rows for an item that has them.
   */
  /**
   * The item's repositories as RESOLVED REFERENCES (Story MOTIR-2732 ·
   * MOTIR-3041) — the join rows, in set order, mapped to what they point at.
   *
   * A separate read rather than a join on every work-item query, for the reason
   * `listRepoDelivery` beside it is one: only the surfaces that PUBLISH the field
   * need it, and `toWorkItemDto` maps a bare row. Read inside a workspace context
   * because the join table is RLS-gated on a GUC bound only on a transaction — a
   * singleton read would return an empty list, which is indistinguishable from
   * "this card has no repositories" and is the worse of the two failures.
   */
  async listRepositories(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemRepositoryDto[]> {
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepoRepository.listByWorkItem(workItemId, tx),
    );
    return toWorkItemRepositoryDtos(rows);
  },

  /**
   * ⚠️ The expectation it classifies is the item's REFERENCES when it has any
   * (Story MOTIR-2732 · ADR §A5), not the name strings — because two of the five
   * delivery states are properties of the ROW, not of the pull requests: a
   * `proposed` row names a repository that does not exist yet, and a `skipped`
   * row names one that never will. Classified off names alone both read as
   * `awaiting`, which tells the reader to wait for a pull request against a
   * repository nothing will ever open one against.
   *
   * The name list stays the FALLBACK, and is not dead: it is what a project with
   * no `project_repository` set still pins with (ADR §5's compatibility rung).
   */
  async listRepoDelivery(
    workItemId: string,
    targetRepos: readonly string[],
    ctx: ServiceContext,
  ): Promise<RepoDelivery[]> {
    // An item with NO repositories at all — the common case on a card that pins
    // none — is answered without touching the database. `targetRepos` is the
    // read projection of the references (ADR §A4), so an empty projection means
    // an empty reference list; there is nothing for either query to find.
    if (targetRepos.length === 0) return [];
    // ⚠️ Through the SHARED resolver the completion gate uses, not a second copy
    // of the same rule. Two derivations of one fact is the defect this story
    // fixes one level up, and a panel that resolved names differently from the
    // gate would be the same bug wearing this story's own clothes.
    const { expected, facts } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
      expected: await resolveExpectedRepos(workItemId, targetRepos, tx),
      facts: await workItemDeliveryRepository.listCompletionFactsByWorkItem(workItemId, tx),
    }));
    return classifyRepoDelivery(expected, facts);
  },

  /**
   * Candidate PARENTS for a new/edited issue of `childType` in a project: every
   * non-archived work item whose kind may legally hold a `childType`, by the
   * inverted kind-parent matrix (`allowedParentKinds` — the single source of
   * truth from 2.1.2, derived not re-encoded). The parent picker (Subtask
   * 2.3.4) renders exactly this set, so an illegal (parent, child) pair is never
   * CONSTRUCTIBLE in the UI; `createWorkItem`/`updateWorkItem` + the DB trigger
   * stay the backstops for a forged payload. Returns [] for a childType with no
   * legal parent (`epic`) or an empty project. Explicit `workspaceId` gate per
   * finding #26 (the primary tenant filter — RLS is inert under the dev/CI
   * superuser).
   */
  async listCandidateParents(
    projectId: string,
    childType: IssueType,
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    // The caller's project is not trusted (MOTIR-6319): the actor must be able to
    // browse it, or the picker would list another project's titles. A refusal is
    // not-found, never forbidden — the no-existence-leak posture.
    await assertBrowseAsNotFound(projectId, ctx);
    const kinds = allowedParentKinds(childType);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByProjectAndKinds(projectId, kinds, ctx.workspaceId, tx),
    );
    return rows.map(toWorkItemSummaryDto);
  },

  /**
   * The revision history of one work item (newest-first), scoped to the
   * caller's active workspace: the work item must belong to the active
   * workspace, or we throw WorkItemNotFoundError — so a cross-tenant probe of
   * another workspace's revision feed yields 404, never the diffs. Maps each
   * row to a WorkItemRevisionDto at the read boundary.
   */
  async listRevisions(workItemId: string, ctx: ServiceContext): Promise<WorkItemRevisionDto[]> {
    const row = await readWorkItem(workItemId, ctx);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
    // Bound (MOTIR-2815). `work_item_revision` carries an RLS policy but no
    // `workspaceId` COLUMN (it is gated through its work item), so it sat
    // outside both scanners' scope until they learned to read the policies —
    // and unbound, an item's entire history came back empty.
    const revisions = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRevisionRepository.listByWorkItem(workItemId, {}, tx),
    );
    return revisions.map(toWorkItemRevisionDto);
  },

  /**
   * One CURSOR-PAGED window of a work item's revision history (newest-first) —
   * the read backing the AI `get_item?withHistory` depth signal (Subtask 7.5.1).
   * Same tenant gate as {@link listRevisions} (cross-workspace → 404, never the
   * diffs), but BOUNDED (finding #57): at most `HISTORY_PAGE_SIZE` rows per page,
   * with a take+1 probe yielding `nextCursor` (the last row's id, or null on the
   * final page) — the same paging shape `commentsService.listComments` uses, so
   * the planner walks comments and history identically.
   */
  async listRevisionsPage(
    workItemId: string,
    ctx: ServiceContext,
    options: { cursor?: string; take?: number } = {},
  ): Promise<{ revisions: WorkItemRevisionDto[]; nextCursor: string | null }> {
    const row = await readWorkItem(workItemId, ctx);
    if (!row || row.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
    const take = clampBound(options.take, 1, HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE);
    const window = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRevisionRepository.listByWorkItem(
        workItemId,
        { take: take + 1, cursor: options.cursor, order: 'desc' },
        tx,
      ),
    );
    const page = window.slice(0, take);
    const nextCursor = window.length > take ? (page[page.length - 1]?.id ?? null) : null;
    return { revisions: page.map(toWorkItemRevisionDto), nextCursor };
  },

  /**
   * Fetch ONE link by id, scoped to the caller's active workspace. Returns the
   * DTO, or throws WorkItemLinkNotFoundError when absent OR in a different
   * workspace (404 no-existence-leak). Routes use this as the cross-tenant
   * guard before unlinkWorkItems — a member of W1 can't delete a link in W2.
   */
  async getLink(linkId: string, ctx: ServiceContext): Promise<WorkItemLinkDto> {
    const link = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findById(linkId, tx),
    );
    if (!link || link.workspaceId !== ctx.workspaceId) throw new WorkItemLinkNotFoundError(linkId);
    return toWorkItemLinkDto(link);
  },

  /**
   * Candidate target issues for the CREATE-modal link picker (Subtask 2.4.10,
   * server-search since 6.9.2). Like {@link listLinkCandidates} but there is no
   * current item yet (the issue isn't created), so nothing is excluded
   * server-side beyond tenancy + permission — the modal drops already-pending
   * targets client-side (direction-aware, per chosen relationship). Delegates to
   * the 6.9.1 {@link quickSearch}: a `query`-driven, key + title, workspace +
   * 6.4-permission-scoped, bounded read over the `pg_trgm` index — NOT the old
   * newest-50 window (finding #98). An empty / short query returns `[]` (the
   * picker prompts "type to search"); the Combobox fetches per keystroke.
   */
  async listCreateLinkCandidates(
    query: string,
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    return this.quickSearch(query, ctx);
  },

  /**
   * Candidate targets for the link picker (Subtask 2.4.9; server-search since
   * 6.9.2 — closes finding #98). Tenant-gates the current item (cross-workspace /
   * missing → 404), computes the direction-aware exclusion set (the item itself +
   * any already linked to it by the chosen relationship, so the picker won't
   * offer a duplicate; the trigger still backstops a forged one), then delegates
   * to the 6.9.1 {@link quickSearch} with that exclusion set. The result is a
   * `query`-driven, key + title, workspace + 6.4-permission-scoped, bounded read
   * over the `pg_trgm` index — NOT a newest-50 window filtered client-side (which
   * left ~88% of a real tenant unreachable by search). An empty / short query
   * returns `[]`; the picker's Combobox fetches per keystroke and re-fetches when
   * the relationship changes (the exclusion set is direction-aware).
   */
  async listLinkCandidates(
    currentItemId: string,
    relationship: RelationshipKind,
    query: string,
    ctx: ServiceContext,
  ): Promise<WorkItemSummaryDto[]> {
    const item = await readWorkItem(currentItemId, ctx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(currentItemId);
    }

    // Which end of the directed storage edge the current item sits on — the
    // inverse relationships (`blocks`, `superseded_by`) read the IN edges.
    const storage = relationshipStorage(relationship);
    const linkedIds =
      storage.currentIs === 'to'
        ? (
            await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
              workItemLinkRepository.findByToItem(currentItemId, storage.kind, tx),
            )
          ).map((l) => l.fromId)
        : (
            await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
              workItemLinkRepository.findByFromItem(currentItemId, storage.kind, tx),
            )
          ).map((l) => l.toId);

    return this.quickSearch(query, ctx, { excludeIds: [currentItemId, ...linkedIds] });
  },

  /**
   * Reusable server-side issue quick-search (Subtask 6.9.1) — the shared read
   * the link pickers (6.9.2) and, later, the cmd-K palette consume. Trims and
   * guards the query (empty / whitespace / shorter than
   * {@link QUICK_SEARCH_MIN_QUERY_LENGTH} → `[]` with NO DB round-trip);
   * resolves the actor's BROWSABLE project set (the Story 6.4 gate — the SAME
   * `projectAccessService.filterBrowsable` the switcher / nav ride) so a user
   * only ever finds issues in projects they may read; then runs the bounded,
   * relevance-ordered key + title search scoped to that set, capped at
   * {@link QUICK_SEARCH_DEFAULT_LIMIT} (or a caller-supplied `limit`, itself
   * ceilinged at {@link QUICK_SEARCH_MAX_LIMIT}; finding #57 — never unbounded).
   * `opts.excludeIds` drops specific rows (6.9.2's link picker passes self +
   * already-linked). Returns the lighter {@link WorkItemSummaryDto}. No route is
   * wired by THIS subtask — 6.9.2 calls it behind the existing link action.
   */
  async quickSearch(
    query: string,
    ctx: ServiceContext,
    opts: { limit?: number; excludeIds?: string[]; projectId?: string } = {},
  ): Promise<WorkItemSummaryDto[]> {
    return (await this.quickSearchRows(query, ctx, opts)).map(toWorkItemSummaryDto);
  },

  /** {@link quickSearch}'s gated, scoped read, as the raw rows (for callers that join more). */
  async quickSearchRows(
    query: string,
    ctx: ServiceContext,
    opts: { limit?: number; excludeIds?: string[]; projectId?: string } = {},
  ): Promise<WorkItem[]> {
    const trimmed = query.trim();
    if (trimmed.length < QUICK_SEARCH_MIN_QUERY_LENGTH) return [];
    const limit = Math.min(
      QUICK_SEARCH_MAX_LIMIT,
      Math.max(1, opts.limit ?? QUICK_SEARCH_DEFAULT_LIMIT),
    );
    // The Story 6.4 gate, batched (one workspace-role + one membership query —
    // no N+1), so the search only ever spans projects the actor may browse.
    const projects = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      projectRepository.findByWorkspace(ctx.workspaceId, tx),
    );
    const browsable = await projectAccessService.filterBrowsable(projects, ctx);
    // `projectId` narrows the search to ONE project (MOTIR-7572) — the page
    // editor's picker, whose link rows are same-project only. It narrows WITHIN
    // the browsable set, so a project the actor may not browse (or one outside
    // the workspace) fails closed to `[]` rather than widening anything.
    const scoped =
      opts.projectId === undefined ? browsable : browsable.filter((p) => p.id === opts.projectId);
    if (scoped.length === 0) return [];
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.quickSearch(
        ctx.workspaceId,
        scoped.map((p) => p.id),
        trimmed,
        limit,
        opts.excludeIds ?? [],
        tx,
      ),
    );
    return rows;
  },

  /**
   * The picker's candidate read (`GET /api/work-items/mention-search`): the same
   * gated, scoped {@link quickSearch} rows, each with its type and its assignee's
   * display — resolved in ONE batched member read (none when nothing is
   * assigned), so a card inserted this session draws all five facts before the
   * page is read again. Its own DTO, not a widened summary (see
   * {@link WorkItemMentionCandidateDto}).
   */
  async searchMentionCandidates(
    query: string,
    ctx: ServiceContext,
    opts: { limit?: number; projectId?: string } = {},
  ): Promise<WorkItemMentionCandidateDto[]> {
    const rows = await this.quickSearchRows(query, ctx, opts);
    const assignees = await userRepository.findByIds(distinctAssigneeIds(rows));
    return rows.map((row) => {
      const member = assignees.find((u) => u.id === row.assigneeId);
      return toWorkItemMentionCandidateDto(row, member ? toWorkItemRefAssigneeDto(member) : null);
    });
  },

  /**
   * Resolve the work-item references parsed out of a body / title to the LIVE
   * summaries the internal-link chip + title-linkify render (Subtask 5.8.6) —
   * current key · title · status, with the archived / deleted / no-access state.
   * Thin service entry over the shared {@link resolveWorkItemRefSummaries}
   * helper (the read-side parallel of auto-relate, reusing the SAME
   * `filterBrowsable` view gate `quickSearch` rides). The caller parses the body
   * with `parseWorkItemRefs` and passes its active project; the map is keyed by
   * id (token) and current identifier (bare key / title).
   */
  async resolveReferenceSummaries(
    refs: WorkItemRefs,
    activeProjectId: string,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<WorkItemRefMap> {
    return resolveWorkItemRefSummaries(refs, activeProjectId, ctx);
  },

  /**
   * The READY SET of a project (Subtask 7.0.2 + 7.0.13) — the AI dispatch
   * surface's list read, cursor-paginated, returning the 7.0.3 `ReadyItemDto`s.
   *
   * A work item is in the ready set when it is a DISPATCHABLE LEAF that is READY:
   *   - **Leaf** — it has NO children. A childed story/epic is *planned* (broken
   *     down), so it is never listed; a childless story/epic IS listed ("ready to
   *     plan"), a childless subtask/task/bug "ready to do" (Subtask 7.0.10).
   *   - **`todo` status** — a ready item is one to START (`in_progress`/`done`
   *     excluded).
   *   - **Ready (cascade, 7.0.13)** — its own `is_blocked_by` blockers are all
   *     terminal in their own project AND every ANCESTOR is ready.
   *     `filter.allowSoftBlock` (MOTIR-6366) drops the ANCESTOR half only: a
   *     leaf held solely by an ancestor's block (a SOFT block) is listed, one
   *     with its own open blocker (a HARD block) never is.
   *
   * Computed TOP-DOWN, by layer (NOT a whole-table scan): start at the roots,
   * keep the ready ones, descend ONLY into ready containers, collect ready
   * childless `todo` leaves — so a not-ready or fully-planned-out branch is never
   * read (`collectReadyLeaves`). The full ready-leaf set is then sorted
   * `(type asc, priority desc, key asc)` and sliced by the cursor seek-after.
   * Tenant gate first (cross-workspace / missing → `ProjectNotFoundError` → 404).
   * A malformed cursor throws `InvalidReadyCursorError` (→ 400); a cursor past the
   * tail returns `[]`. The list is empty ONLY when the project has no ready work
   * — count and list can never disagree (the 7.0.13 empty-list-with-count fix).
   */
  async listReady(
    projectId: string,
    filter: ReadyListFilter,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
    let workspaceId: string;
    let hidden: ReadonlySet<string> | null = null;
    if (isVisitorContext(ctx)) {
      // A Visitor's Ready set never lists a private epic's descendant (MOTIR-6644,
      // `epic-privacy.md` §3); the cursor pages over what remains, so a page and
      // its successor never disagree about what is in the set.
      workspaceId = openVisitorRead(projectId, ctx).workspaceId;
      hidden = ctx.hiddenIds;
    } else {
      const project = await readProject(projectId, ctx);
      if (!project || project.workspaceId !== ctx.workspaceId) {
        throw new ProjectNotFoundError(projectId);
      }
      // The tenant gate above is the WORKSPACE's; the project's own gate is browse
      // (MOTIR-6319, measured: an outsider to a Members-only project was handed its
      // ready leaves). Refused as not-found, like the tenant gate.
      await assertBrowseAsNotFound(projectId, ctx);
      workspaceId = project.workspaceId;
    }
    const readCtx = { workspaceId };
    const limit = clampReadyLimit(filter.limit);
    const cursor = filter.cursor ? decodeReadyCursor(filter.cursor) : undefined;
    // `allowSoftBlock` (MOTIR-6366) is read HERE and only here: it is passed to
    // the walk as its own argument rather than riding the facet object, so the
    // three dispatch reads below cannot inherit it through a spread filter.
    const collected = await collectReadyLeaves(projectId, workspaceId, readCtx, filter, {
      allowSoftBlock: filter.allowSoftBlock === true,
    });
    const all = hidden ? collected.filter((r) => !hidden.has(r.id)) : collected;
    const start = cursor ? all.findIndex((r) => isAfterReadyCursor(r, cursor)) : 0;
    const begin = start === -1 ? all.length : start;
    const window = all.slice(begin, begin + limit);
    const more = begin + window.length < all.length;
    const last = window.at(-1);
    const nextCursor =
      more && last
        ? encodeReadyCursor({ kind: last.kind, priority: last.priority, key: last.key })
        : null;
    // The inherited lineage, for the WHOLE window in one query (MOTIR-2400).
    // `getReadiness` computes the same value per item; calling it here would be
    // one readiness computation per row of every page.
    const lineages = await workItemsService.getInheritedSessionBranches(
      window.map((r) => r.id),
      readCtx,
    );
    return {
      items: window.map((r) => {
        const context = rowReadyContext(r);
        // A Visitor's Ready rows name the assignee by display name only — never
        // the email or its local part (MOTIR-6646).
        const assignee =
          hidden && context.assignee
            ? { ...context.assignee, name: personName(r.assigneeName), email: '' }
            : context.assignee;
        return toReadyItemDto(r, {
          ...context,
          assignee,
          inheritedSessionBranch: lineages[r.id] ?? null,
        });
      }),
      nextCursor,
    };
  },

  /**
   * The INHERITED SESSION BRANCH for a page of items — for each id, the single
   * branch its blockers are integrated on, or `null` when it is ready from the
   * trunk (Story 11.5 · Subtask 11.5.24 — MOTIR-2400).
   *
   * ⚠️ A ready item can never span more than one branch — that is what makes a
   * single value the right answer, and it is the same collapse `getReadiness`
   * performs. An item whose blockers name TWO branches is therefore not ready,
   * and this returns `null` for it rather than picking one: reporting a lineage
   * for an item that has no single lineage would be a confident wrong answer,
   * where `null` is the same thing the row says for "ready from `main`" — and a
   * not-ready item never reaches a ready page anyway.
   *
   * ONE query for a page of any size. Empty input short-circuits.
   */
  async getInheritedSessionBranches(
    itemIds: string[],
    ctx: Pick<ServiceContext, 'workspaceId'>,
  ): Promise<Record<string, string | null>> {
    const byItem: Record<string, string | null> = {};
    for (const id of itemIds) byItem[id] = null;
    if (itemIds.length === 0) return byItem;

    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findBlockerSessionBranchesForItems(itemIds, ctx.workspaceId, tx),
    );
    const branches = new Map<string, Set<string>>();
    for (const row of rows) {
      const seen = branches.get(row.fromId) ?? new Set<string>();
      seen.add(row.sessionBranch);
      branches.set(row.fromId, seen);
    }
    for (const [itemId, seen] of branches) {
      if (seen.size === 1) byItem[itemId] = [...seen][0] ?? null;
    }
    return byItem;
  },

  /**
   * The per-row DEPENDENCY-EDGE projection for a PAGE of work items (Subtask
   * 7.9.0f / MOTIR-1842) — for each requested id, `{ blockedBy, blocks }` as
   * {@link WorkItemEdgeSummaryDto} lists (`{ key, title, status }`).
   *
   * TWO queries for the whole page, never one per row: the two batched link
   * reads, one per direction (`findBlockerEdgesForItems` /
   * `findBlockedEdgesForItems`), issued in parallel and grouped here. That is the
   * whole point of the method — a terminal rendering a 33-row sprint with edges
   * must not make 33 `get_work_item` round-trips.
   *
   * TOTAL: the result carries an entry for EVERY requested id, with empty arrays
   * where there are no edges — so a renderer never branches on presence. Empty
   * input short-circuits to `{}` without touching the DB.
   *
   * TENANCY: both reads are scoped to `ctx.workspaceId`, so a far end outside the
   * caller's tenant can never appear. Cross-PROJECT edges inside the workspace DO
   * resolve — `link_work_items` allows them, and the item detail read
   * (`getIssueDetail`) has always surfaced them; this list projection matches
   * that shipped behaviour rather than inventing a narrower rule. The caller
   * supplies ids it has already gated (`listReady` / `getProjectIssuesList` both
   * run the workspace check + `assertCanBrowse` first).
   */
  async getDependencyEdgesForItems(
    itemIds: string[],
    ctx: ServiceContext,
  ): Promise<Record<string, WorkItemDependencyEdgesDto>> {
    const edges: Record<string, WorkItemDependencyEdgesDto> = {};
    for (const id of itemIds) edges[id] = { blockedBy: [], blocks: [] };
    if (itemIds.length === 0) return edges;

    const { blockerRows, blockedRows } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => ({
        blockerRows: await workItemLinkRepository.findBlockerEdgesForItems(
          itemIds,
          ctx.workspaceId,
          tx,
        ),
        blockedRows: await workItemLinkRepository.findBlockedEdgesForItems(
          itemIds,
          ctx.workspaceId,
          tx,
        ),
      }),
    );

    for (const row of blockerRows) {
      edges[row.fromId]?.blockedBy.push({
        key: row.blockerKey,
        title: row.blockerTitle,
        status: row.blockerStatus,
      });
    }
    for (const row of blockedRows) {
      edges[row.toId]?.blocks.push({
        key: row.blockedKey,
        title: row.blockedTitle,
        status: row.blockedStatus,
      });
    }
    // Stable, key-ordered edges so two calls (and the two tools) render the same
    // list — the link reads have no inherent ordering.
    const byKey = (a: WorkItemEdgeSummaryDto, b: WorkItemEdgeSummaryDto) =>
      a.key.localeCompare(b.key, 'en', { numeric: true });
    for (const entry of Object.values(edges)) {
      entry.blockedBy.sort(byKey);
      entry.blocks.sort(byKey);
    }
    return edges;
  },

  /**
   * Dispatch ONE ready item (Subtask 7.0.2) — the BYOK `motir run` consumer of
   * `POST /api/ready/next`. The FIRST ready leaf under `(type asc, priority desc,
   * key asc)` not in `excludeIds`, as the full `ReadyItemDispatchDto`, or `null`
   * when the filtered ready set is exhausted. Same top-down ready set as
   * `listReady` (they can never disagree).
   */
  async getNextReady(
    projectId: string,
    filter: Omit<ReadyListFilter, 'limit' | 'cursor' | 'allowSoftBlock'> & {
      excludeIds?: string[];
    },
    ctx: ServiceContext,
  ): Promise<ReadyItemDispatchDto | null> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // The CI-credit gate (MOTIR-1901 · `ci-minutes-allowance.md` §6.2–6.3). It
    // sits HERE, in the service, rather than in the route, because there are
    // three dispatch entry points (`POST /api/ready/next`, the `next_ready` MCP
    // tool, and `claimNextReady` below) and a gate on one of them is a gate a
    // caller can walk around. Throws `CiCreditsExhaustedError` only at balance
    // ≤ 0 past the pool; every other state — including motir-ai being
    // unreachable — proceeds.
    await ciAllowanceService.assertDispatchAllowed(ctx);
    const exclude = new Set(filter.excludeIds ?? []);
    const all = await collectReadyLeaves(projectId, project.workspaceId, ctx, filter);
    const chosen = all.find((r) => !exclude.has(r.id));
    return chosen ? buildReadyDispatchDto(chosen, ctx) : null;
  },

  /**
   * `claim_next_ready` (MOTIR-1330) — the ATOMIC, race-safe dispatch claim.
   * Compute the project's ready leaves (the SAME source `listReady` /
   * `getNextReady` derive), scope them to the active `sprintId` when one is given
   * (or take the WHOLE project when `sprintId` is `null` — Motir used without
   * sprints), keep the dispatch rank, then — in ONE transaction — LOCK the best
   * still-claimable
   * candidate (`FOR UPDATE SKIP LOCKED`), ASSIGN it to the caller and flip it
   * `→ in_progress`. Two
   * concurrent callers therefore claim DIFFERENT items (or one gets the item and
   * the other `null`): there is no read-then-flip-later window for them to both
   * grab the same Subtask, which the old "compute ready set, then
   * `transition_status`" dispatch had. Returns the dispatch payload for the
   * claimed item (status now `in_progress`), or `null` when the active-sprint
   * ready set is empty OR every candidate was already locked — the caller RETRIES
   * on `null`. The flip records a revision and emits `work-item/transitioned`
   * AFTER commit, exactly like `updateStatus` (the 5.1.2 rule).
   *
   * ⚠️ THE ASSIGNMENT (MOTIR-4996) IS PART OF THE CLAIM, and it was missing here
   * for as long as this method has existed. `claimWorkItem` below writes it
   * inside the claim transaction and `scopeClaimService.claimScope` writes it
   * over a whole subtree; this door — the OLDEST of the three, written before
   * MOTIR-2958 made the requirement — wrote only the status, so every card it
   * handed out read In Progress with nobody on it. The tool's own summary tells
   * its caller the claim IS the flip and not to call `transition_status`
   * afterwards, which reads as "nothing further is owed", so a caller following
   * it exactly produced that state on every call. The assignee is the ONLY
   * ownership signal a second session can read — it cannot see a worktree, and
   * In Progress stopped meaning "an agent is on this right now" the moment a
   * scoped run began claiming whole subtrees up front.
   */
  async claimNextReady(
    projectId: string,
    sprintId: string | null,
    ctx: ServiceContext,
  ): Promise<ReadyItemDispatchDto | null> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // The CI-credit gate, checked BEFORE the claim (§6.3 — the refusal fails
    // before the user waits on a run). Deliberately ahead of the claim
    // transaction, not inside it: a refusal must not consume a candidate, and
    // flipping an item to `in_progress` and then refusing would strand it.
    await ciAllowanceService.assertDispatchAllowed(ctx);
    // A CLOSING organization dispatches nothing (MOTIR-6396; `organization-
    // deletion.md` §3): no card is claimed and nothing is locked. Read per claim,
    // so a cancel resumes dispatch on the next call with nothing to restart.
    if (await isWorkspaceOrgClosing(project.workspaceId)) {
      console.warn('[dispatch] no claim: the organization is scheduled for deletion', {
        projectId,
      });
      return null;
    }
    // The claim ASSIGNS (MOTIR-4996), and an assignee must be a workspace member
    // — the same pre-flight `claimWorkItem` runs, in the same place: ahead of the
    // transaction so a refusal never takes a lock, and ahead of the ready-set
    // computation so it never pays for one either. In practice the actor is the
    // token's own resolved user, so this passes; it is here because the write is
    // real either way.
    await assertAssigneeMember(ctx.userId, ctx.workspaceId);
    // The project's ready leaves in dispatch rank order (priority encodes the
    // in-sprint leverage `motir plan sprint` re-ranks to — so this rank IS
    // "most-unblocking first"). When an active `sprintId` is given, scope to it
    // (sprint discipline); when `null` — Motir used WITHOUT sprints (plain
    // Kanban) — claim across the WHOLE project, since a missing sprint is not an
    // error.
    const ready = await collectReadyLeaves(projectId, project.workspaceId, ctx, {});
    // A MARKED card is never claimed (MOTIR-6672 · MOTIR-6681): the flip to
    // `in_progress` below leaves the done category, which the mark refuses. A card
    // marked under the rule is `done` and never ready; a LEGACY card marked while
    // open still is, and left in the candidate list it would fail every claim that
    // ranked it first instead of the claim moving on to the next ready card.
    const claimable = ready.filter((r) => r.obsolescence == null);
    const candidates = sprintId ? claimable.filter((r) => r.sprintId === sprintId) : claimable;
    if (candidates.length === 0) return null;
    const orderedIds = candidates.map((r) => r.id);
    // ⚠️ THE DISPATCH REPOSITORY IS RESOLVED BEFORE THE CLAIM COMMITS (MOTIR-6243).
    // It used to be resolved only by `buildReadyDispatchDto`, after the claim
    // transaction had committed — and it THROWS `ArchivedTargetRepoError` when the
    // item resolves to an archived repository (MOTIR-1959). So a refused dispatch
    // left the card In Progress and assigned to a caller that received only the
    // error and never the key it now held. The project's dispatch domain is read
    // HERE, outside the transaction (the module's own rule); the item's pin is read
    // under the lock, and the pure resolution throws inside the transaction, so a
    // refusal rolls the claim back and has claimed nothing.
    const dispatchDomain = await listDispatchRepoNames(projectId, ctx);

    const claimed = await withWorkspaceContext(ctx, async (tx) => {
      const locked = await workItemRepository.claimNextReadyCandidate(orderedIds, tx);
      if (!locked) return null;
      const chosen = candidates.find((r) => r.id === locked.id)!;
      const dispatchRepo = resolveDispatchRepo(
        await resolveItemDispatchPin({ id: chosen.id, targetRepo: chosen.targetRepo }, tx),
        dispatchDomain,
      );
      // THE ASSIGNMENT (MOTIR-4996), inside the transaction the lock is held in
      // and before the flip — the shape `claimWorkItem` already uses, rather than
      // a second one invented here. The candidate row carries only its `id`, so
      // the current assignee is read under that lock with `findClaimStateById`,
      // the existing post-lock state read; a value read before the lock would be
      // a snapshot of the past.
      const state = await workItemRepository.findClaimStateById(locked.id, tx);
      // The NO-OP SKIP: a card already assigned to the caller is written again by
      // nobody. An update that changes nothing still bumps `updatedAt`, and
      // `updatedAt` is what a rollback test reads — the same reason
      // `claimWorkItem` and `assignManyTo` both skip.
      /* v8 ignore next -- the row is held by the candidate SELECT's lock, so it cannot vanish between the two statements */
      if (!state) throw new WorkItemNotFoundError(locked.id);
      if (state.assigneeId !== ctx.userId) {
        await workItemRepository.update(locked.id, { assigneeId: ctx.userId }, tx);
      }
      // `in_progress` is the dispatch state (lib/workflows/defaultWorkflow.ts);
      // `applyStatusTransition` validates the todo|blocked → in_progress edge,
      // records the revision, and re-locks the row under the same tx.
      const transitioned = await workItemsService.applyStatusTransition(
        locked.id,
        'in_progress',
        ctx,
        tx,
      );
      return { ...transitioned, chosen, dispatchRepo };
    });
    if (!claimed) return null;

    if (claimed.transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: claimed.dto.id,
        actorId: ctx.userId,
        fromStatusKey: claimed.transition.fromStatusKey,
        toStatusKey: claimed.transition.toStatusKey,
        revisionId: claimed.transition.revisionId,
      });
    }

    // Build the dispatch payload from the claimed candidate row, reflecting the
    // post-claim status (now in the `in_progress` category).
    //
    // ⚠️ AND THE POST-CLAIM ASSIGNEE (MOTIR-4996), for the same reason the status
    // is overridden one line down: `chosen` is the candidate row as it was read
    // BEFORE the claim, so its assignee columns hold the value the claim has just
    // overwritten — `null` on the ordinary card, the previous holder on a card
    // taken off somebody. Returning that would make the one response that proves
    // the claim assigned report that it did not. ONE read, by primary key, for
    // the caller's own display fields; the id is `ctx.userId` whatever it returns.
    const [claimer] = await userRepository.findByIds([ctx.userId]);
    const dispatch = await buildReadyDispatchDto(
      {
        ...claimed.chosen,
        assigneeId: ctx.userId,
        assigneeName: claimer?.name ?? null,
        assigneeEmail: claimer?.email ?? null,
        assigneeImage: claimer?.image ?? null,
      },
      ctx,
      // The repository the claim already resolved (MOTIR-6243). Resolving it a
      // second time here, after the commit, would re-open the window this fix
      // closes: an archive landing between the two reads would refuse a claim
      // that has already been written.
      claimed.dispatchRepo,
    );
    return { ...dispatch, status: { key: claimed.dto.status, category: 'in_progress' } };
  },

  /**
   * THE KEYED CLAIM (MOTIR-2961) — lock ONE named work item, re-assert the to-do
   * CATEGORY under that lock, and assign + flip it, all in ONE transaction.
   *
   * `claimNextReady` above made the path that asks "give me whatever is next"
   * race-safe. The path that is HANDED a card by name was written as a shortcut
   * past SELECTION, and skipping selection quietly skipped the only thing
   * serializing two sessions dispatched on the same card. What stood in for it
   * was `packages/cli`'s `ensureInProgress`: an unconditional assignment
   * followed by a separate `transitionStatus`, two unlocked writes whose own
   * comment calls the race ACCEPTED. An assignment answers "who is working on
   * this?" for a teammate reading the board; it was never built to serialize
   * claimants and it does not. Two sessions built MOTIR-2952 at once, and the
   * tell was a `git status` (MOTIR-2958).
   *
   * ⚠️ THE REFUSAL IS A RESULT, NOT AN ERROR, and it DISCRIMINATES. A rejection
   * that says only "not in `todo`" makes the loser read the card again to find
   * out which of three different situations it is in — and two of them are not
   * losses at all. So the outcome is one of four (`lib/dto/claim.ts`):
   *
   *   • `claimed`        — it was in the to-do category; it is now the caller's.
   *   • `mine`           — `in_progress` AND assigned to the caller. The
   *                        documented recovery: a run resuming a card its own
   *                        failed agent left behind. The caller proceeds.
   *   • `taken`          — `in_progress`, somebody else's. Named, so the loser
   *                        can say who.
   *   • `not_claimable`  — anything else. `implemented` / `in_review` /
   *                        `planning` / `done` / `cancelled` / an ARCHIVED row /
   *                        any custom status outside the to-do category.
   *
   * The last one closes a second, quieter hole. FIVE statuses have a legal edge
   * into `in_progress` — `todo`, `blocked`, `in_review`, `done`, `planning` — and
   * the CLI checks none of them, so `motir run <a-done-card>` reopens finished
   * work and points an agent at it. Re-asserting the CATEGORY under the lock ends
   * that, and it does so WITHOUT breaking `--force`, whose whole purpose is to
   * dispatch a `blocked` card (see `CLAIMABLE_STATUS_CATEGORY` in
   * `lib/workItems/claimOutcome.ts`).
   *
   * ⚠️ NOTE WHAT THIS CANNOT SEE. A session that dies mid-run leaves a working
   * tree behind and no status change at all. No server-side claim can observe
   * that, so the runbook's worktree pre-flight stays regardless — the lock and
   * the filesystem check answer different questions.
   */
  async claimWorkItem(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemClaimDto> {
    // The tenant + `assertCanBrowse` gate, and the 404-not-403 answer for a key
    // in another workspace, come from the SAME read every other keyed operation
    // opens with — so this surface cannot disagree with `get_work_item` about
    // what exists. The EDIT gate runs inside the transaction, in
    // `applyStatusTransition`, on the claim arm only: refusing a claim is a read.
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);

    // The CI-credit gate (MOTIR-1901 · `ci-minutes-allowance.md` §6.2–6.3). This
    // is the FOURTH dispatch entry point, and `getNextReady`'s comment states
    // the rule it exists under: a gate on some of them is a gate a caller can
    // walk around. Deliberately BEFORE the claim transaction — a refusal must
    // not consume a candidate, and flipping an item to `in_progress` and then
    // refusing would strand it.
    await ciAllowanceService.assertDispatchAllowed(ctx);

    // The claim ASSIGNS, and an assignee must be a workspace member — the same
    // pre-flight `createWorkItem` runs, ahead of the transaction so a refusal
    // never takes a lock. In practice the actor is the token's own resolved
    // user, so this passes; it is here because the write is real either way.
    await assertAssigneeMember(ctx.userId, ctx.workspaceId);

    const outcome = await withWorkspaceContext(ctx, async (tx) => {
      // ⚠️ `FOR UPDATE` and NOT `SKIP LOCKED`, which is the one place this
      // differs from `claimNextReady`'s lock rather than an oversight. There the
      // caller holds a RANKED LIST and a locked row simply means "take the next
      // best"; here it was handed ONE key and there is no next-best, so a
      // claimant that skipped would answer from the state BEFORE the write it is
      // racing. Blocking makes the loser wait for the winner's COMMIT and then
      // read what actually happened — which is what lets the refusal below name
      // who took it.
      //
      // ⚠️ AND THE LOCK FILTERS ON `id` ALONE. Under READ COMMITTED a waiting
      // `FOR UPDATE` re-evaluates its predicate against the new row version, so
      // a lock whose WHERE (or JOIN) reads `status` is invalidated by precisely
      // the write it was waiting for and returns ZERO rows — the item reads as
      // absent at the moment somebody is holding it. `id` is immutable, so the
      // re-check always passes; the mutable state is read AFTER, under the lock
      // (`findClaimStateById`, whose comment carries the full reasoning).
      await workItemRepository.lockById(item.id, tx);
      const state = await workItemRepository.findClaimStateById(item.id, tx);
      // ONE nullability check for both reads, because they answer the same
      // question — the row is gone — and `getWorkItemByIdentifier` above has
      // already resolved it, so neither can miss through this method. Checking
      // the lock's own return separately would add a branch nothing can reach.
      /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
      if (!state) throw new WorkItemNotFoundError(identifier);

      if (!isClaimableState(state)) {
        const held = await workItemRevisionRepository.findLatestStatusChange(item.id, tx);
        return {
          outcome: refusedClaimOutcome(state.status, state.assigneeId, ctx.userId),
          status: { key: state.status, category: state.statusCategory },
          assigneeId: state.assigneeId,
          held,
        };
      }

      // BOTH writes, inside the one transaction the lock is held in. The
      // assignment is skipped when it would be a no-op (a re-claim of a card
      // already assigned to the caller) so it writes no pointless revision.
      if (state.assigneeId !== ctx.userId) {
        await workItemRepository.update(item.id, { assigneeId: ctx.userId }, tx);
      }
      // `applyStatusTransition` validates the `todo|blocked → in_progress` edge
      // against the project's workflow, runs the project EDIT gate, records the
      // revision and re-locks the row under this same tx (a no-op re-lock — we
      // already hold it). Mirrors `claimNextReady` rather than inventing a
      // second flip.
      // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES: the KEYED claim names one
      // card, so the caller is told it cannot be claimed, typed on every door. A
      // marked card is `done` and refused `not_claimable` first; only a LEGACY card
      // marked while open reaches this flip.
      const moved = await workItemsService.applyStatusTransition(
        item.id,
        IN_PROGRESS_STATUS_KEY,
        ctx,
        tx,
      );
      // Read AFTER the transition, in the same transaction, so it names THIS
      // call: the revision just written is the newest status change on the row,
      // and nothing else can write to it while we hold the lock.
      const held = await workItemRevisionRepository.findLatestStatusChange(item.id, tx);
      return {
        outcome: 'claimed' as const,
        status: { key: moved.dto.status, category: IN_PROGRESS_STATUS_CATEGORY },
        assigneeId: ctx.userId,
        held,
        transition: moved.transition,
      };
    });

    // Post-commit, exactly like `claimNextReady` and `updateStatus` (the 5.1.2
    // rule): a side effect after a durable write never rides inside it.
    if ('transition' in outcome && outcome.transition) {
      await sendEvent('work-item/transitioned', {
        workspaceId: ctx.workspaceId,
        workItemId: item.id,
        actorId: ctx.userId,
        fromStatusKey: outcome.transition.fromStatusKey,
        toStatusKey: outcome.transition.toStatusKey,
        revisionId: outcome.transition.revisionId,
      });
    }

    // ONE bounded read for at most TWO ids — the assignee and the actor of the
    // transition — resolved together rather than one lookup each. An id that
    // resolves to no user (a deleted account the `Restrict` FK should prevent)
    // yields `null` rather than a cuid: §7 forbids naming a person by internal
    // id whatever the reason.
    const actorIds = [
      ...new Set([outcome.assigneeId, outcome.held?.changedById].filter(isPresentId)),
    ];
    const users = await userRepository.findByIds(actorIds);
    const actor = (id: string | null | undefined): ClaimActorDto | null => {
      if (!id) return null;
      const user = users.find((u) => u.id === id);
      return user ? { id: user.id, name: user.name } : null;
    };

    return {
      key: item.identifier,
      title: item.title,
      outcome: outcome.outcome,
      claimed: outcome.outcome === 'claimed',
      status: outcome.status,
      assignee: actor(outcome.assigneeId),
      transitionedBy: actor(outcome.held?.changedById),
      transitionedAt: outcome.held?.changedAt.toISOString() ?? null,
    };
  },

  /**
   * The READY COUNT (Subtask 7.0.6) — how many work items are ready to start in
   * the project, under the SAME top-down predicate `listReady` uses, so the count
   * can never disagree with the list (the bug the 7.0.13 rework fixed). Resolved
   * only when the /ready page loads — the every-authed-route sidebar badge was
   * removed (the count was a computed scan on every navigation). Exact (the
   * layered traversal is bounded by tree depth), so `hasMore` is always false.
   */
  async countReady(
    projectId: string,
    filter: Omit<ReadyListFilter, 'limit' | 'cursor' | 'allowSoftBlock'>,
    ctx: ServiceContext,
  ): Promise<{ count: number; hasMore: boolean }> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const all = await collectReadyLeaves(projectId, project.workspaceId, ctx, filter);
    return { count: all.length, hasMore: false };
  },

  /**
   * The LEAVES lane (Story MOTIR-6829 · MOTIR-6830) — the ready set minus BUG
   * WORK, grouped by RUNNABLE CONTAINER, each row naming its `container` (or
   * `null` for a leaf standing alone). The lane `motir next` runs from.
   *
   * It PARTITIONS the same walk `listReady` reads — same cascade, same facets,
   * same `allowSoftBlock`, same Visitor scoping — so a row is in this lane only
   * if it was already ready, and `listReadyLeaves ∪ listReadyBugs` is exactly
   * `listReady`'s id set. Only the ORDER differs: groups rank by their best
   * member ({@link groupRank}), members keep the flat comparator inside a
   * group. A cursor from another lane, or a flat-set cursor, throws
   * `InvalidReadyCursorError`.
   */
  async listReadyLeaves(
    projectId: string,
    filter: ReadyListFilter,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
    return listReadyLaneRows(projectId, 'leaf', filter, ctx);
  },

  /**
   * The BUGS lane (MOTIR-6830) — the ready BUG WORK: a ready `bug` leaf (its own
   * group, `container: null`), and the ready subtasks of a bug (grouped under
   * that bug, `container` = the bug). Same walk, facets, order and cursor rules
   * as {@link workItemsService.listReadyLeaves}.
   */
  async listReadyBugs(
    projectId: string,
    filter: ReadyListFilter,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
    return listReadyLaneRows(projectId, 'bug', filter, ctx);
  },

  /**
   * The CONTAINERS lane (MOTIR-6830) — one row per non-bug RUNNABLE CONTAINER
   * holding at least one leaves-lane row, in the leaves lane's group order: the
   * unit `motir run <KEY>` runs as a parent run.
   *
   * `readyLeafCount` is counted over the UNFACETED leaves lane, so a container's
   * count never depends on which facet the caller used. The facets here apply
   * to the CONTAINER itself — its priority, its assignee, its own sprint —
   * because a container is what this lane hands out.
   */
  async listReadyContainers(
    projectId: string,
    filter: ReadyContainersFilter,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<{ items: ReadyContainerDto[]; nextCursor: string | null }> {
    const { workspaceId, hidden } = await openReadyRead(projectId, ctx);
    const limit = clampReadyLimit(filter.limit);
    const cursor = filter.cursor ? decodeReadyLaneCursor(filter.cursor, 'container') : undefined;
    const groups = await readyContainerGroups(projectId, workspaceId, hidden, filter);
    const start = cursor ? groups.findIndex((g) => groupRank(g.position, cursor.group) > 0) : 0;
    const begin = start === -1 ? groups.length : start;
    const window = groups.slice(begin, begin + limit);
    const last = window.at(-1);
    const nextCursor =
      begin + window.length < groups.length && last
        ? encodeReadyLaneCursor({ lane: 'container', group: last.position, member: null })
        : null;
    return {
      items: window.map((g) => presentContainerGroup(g, hidden)),
      nextCursor,
    };
  },

  /**
   * How many rows each ready LANE holds (MOTIR-6830) — the `/ready` header's
   * chips. One walk, partitioned once, so the three numbers can never disagree
   * with the lanes they count.
   */
  async countReadyLanes(
    projectId: string,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<ReadyLaneCountsDto> {
    const { workspaceId, hidden } = await openReadyRead(projectId, ctx);
    const { leaves, bugs } = await partitionReadyLanes(projectId, workspaceId, hidden, {}, false);
    const containers = new Set(leaves.flatMap((r) => (r.container ? [r.container.id] : [])));
    return {
      leaves: leaves.length,
      containers: containers.size,
      bugs: bugs.length,
      hasMore: false,
    };
  },

  /**
   * DISPATCH one row of a LANE (MOTIR-6833) — the first `leaf`- or `bug`-lane
   * row, in lane order, not in `excludeIds`, as the full dispatch payload
   * `getNextReady` returns (plus its `container`), or `null` when the lane is
   * exhausted. The lane-aware twin of {@link workItemsService.getNextReady},
   * behind the same CI-credit gate; `next_ready` routes its `lane` here so an
   * agent and `/ready` never disagree about what comes next.
   */
  async getNextReadyInLane(
    projectId: string,
    lane: 'leaf' | 'bug',
    filter: Omit<ReadyListFilter, 'limit' | 'cursor' | 'allowSoftBlock'> & {
      excludeIds?: string[];
    },
    ctx: ServiceContext,
  ): Promise<ReadyItemDispatchDto | null> {
    const { workspaceId } = await openReadyRead(projectId, ctx);
    await ciAllowanceService.assertDispatchAllowed(ctx);
    const { excludeIds, ...facets } = filter;
    const exclude = new Set(excludeIds ?? []);
    const partition = await partitionReadyLanes(projectId, workspaceId, null, facets, false);
    const groups = groupLaneRows(lane === 'leaf' ? partition.leaves : partition.bugs);
    const group = groups.find((g) => g.members.some((r) => !exclude.has(r.row.id)));
    const chosen = group?.members.find((r) => !exclude.has(r.row.id));
    if (!group || !chosen) return null;
    return {
      ...(await buildReadyDispatchDto(chosen.row, ctx)),
      container: group.container ? presentContainerGroup(group, null) : null,
    };
  },

  /**
   * The next runnable CONTAINER (MOTIR-6833) — the first containers-lane row not
   * in `excludeIds`, or `null`. What `next_ready { lane: 'container' }` and
   * `motir next --parent` hand out: the unit a parent run takes.
   */
  async getNextReadyContainer(
    projectId: string,
    filter: Omit<ReadyContainersFilter, 'limit' | 'cursor'> & { excludeIds?: string[] },
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<ReadyContainerDto | null> {
    const { workspaceId, hidden } = await openReadyRead(projectId, ctx);
    const { excludeIds, ...facets } = filter;
    const exclude = new Set(excludeIds ?? []);
    const groups = await readyContainerGroups(projectId, workspaceId, hidden, facets);
    const chosen = groups.find((g) => !exclude.has(g.container!.id));
    return chosen ? presentContainerGroup(chosen, hidden) : null;
  },

  /**
   * Expansion-nudge detection (Subtask 7.11.7 / MOTIR-904) — productises
   * Principle #17 ("the plan should keep itself runnable"). When the ready
   * set is below the documented {@link EXPANSION_NUDGE_THRESHOLD} AND an
   * expandable stub exists, returns the nominated stub so the /ready page
   * can surface a dismissible banner. Returns `null` when suppressed (ready
   * set is healthy or no stub exists — no false nag).
   *
   * Read-only: reuses the shipped {@link countReady} (no re-derivation) and
   * {@link workItemRepository.findExpandableStubs}. Nominates the FIRST stub
   * (sorted priority desc, key asc) as the best candidate to expand.
   */
  async computeExpansionNudge(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ExpansionNudge | null> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // `project:browse` (MOTIR-2366) — the nudge answers "is this project running
    // out of ready work", which is a project-scoped read. It was session-only:
    // the check above asked whether the project was in the actor's workspace and
    // nothing about whether they may see it.
    await projectAccessService.assertPermission(projectId, ctx, 'project:browse');
    const { count } = await this.countReady(projectId, {}, ctx);
    if (count >= EXPANSION_NUDGE_THRESHOLD) return null;

    const stubs = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findExpandableStubs(projectId, ctx.workspaceId, tx),
    );
    if (stubs.length === 0) return null;

    const nominated = stubs[0]!;
    return {
      readyCount: count,
      nominatedKey: nominated.identifier,
      nominatedTitle: nominated.title,
      threshold: EXPANSION_NUDGE_THRESHOLD,
    };
  },

  /**
   * Set or unset an epic's `publicChildrenHidden` privacy flag (Story 6.14 ·
   * Subtask 6.14.7 — the admin-gated write path that turns epic privacy on/off).
   * Per the epic-privacy ADR (§1, §5):
   *
   *   - **Epic-only** — the flag is meaningful ONLY on an epic-kind item; a
   *     non-epic target is REJECTED with `NotEpicError` (422), not silently
   *     coerced to a no-op, so a caller bug surfaces.
   *   - **Project-admin only** — set/unset is gated to the project admin,
   *     reusing the SAME 6.4 gate as `customFieldsService` /
   *     `projectMembersService` (workspace owner/admin always pass, else a
   *     project membership with role `admin`); everyone else → 403
   *     (`NotProjectAdminError`). No new permission is introduced.
   *
   * The write is the single `publicChildrenHidden` column. It records NO
   * activity revision — an admin visibility setting is not a content edit on the
   * issue's history feed (and keeping it out of the revision diff keeps the
   * activity totality-guard registry untouched). The 6.14.4 server-side
   * exclusion is what gives the flag its effect on public reads; this method
   * only owns the authoritative write + the gates.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace item),
   * `NotProjectAdminError` (403 — non-admin), `NotEpicError` (422 — non-epic).
   */
  async setEpicPrivacy(
    id: string,
    publicChildrenHidden: boolean,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      // Lock + re-read under the lock (mirrors updateWorkItem): two concurrent
      // toggles serialize on the FOR UPDATE lock, and the explicit workspace
      // check is the finding-#26 tenant gate (a cross-workspace item is an
      // indistinguishable 404, primary even under the dev/CI BYPASSRLS role).
      const locked = await workItemRepository.lockById(id, tx);
      if (!locked) throw new WorkItemNotFoundError(id);
      const current = await workItemRepository.findById(id, tx);
      if (!current || current.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(id);
      }

      // Project-admin gate (ADR §5) — the SAME 6.4 check the members / custom
      // fields admin writes use. Inside the tx so it shares the lock's snapshot.
      await assertCanManageProject(ctx.userId, ctx.workspaceId, current.projectId, tx);

      // Epic-only (ADR §1) — reject a non-epic target rather than no-op'ing it.
      if (current.kind !== 'epic') throw new NotEpicError(current.kind);

      // No-op when unchanged — skip the write (and the `updatedAt` bump) so a
      // re-set of the same value is idempotent.
      if (current.publicChildrenHidden === publicChildrenHidden) {
        return toWorkItemDto(current);
      }

      const row = await workItemRepository.update(id, { publicChildrenHidden }, tx);
      return toWorkItemDto(row);
    });
  },
};

/**
 * The project-management gate (Story 6.4) — workspace owner/admin always pass
 * (`isWorkspaceManager`), otherwise the actor needs a project membership with
 * role `admin`; everyone else → `NotProjectAdminError` (403). This is the SAME
 * decision `projectMembersService.assertCanManage` /
 * `customFieldsService.assertCanManage` enforce — replicated here (not imported)
 * to keep the small gate a leaf the work-items domain owns, the established
 * per-service pattern. Reuses no new permission.
 */
async function assertCanManageProject(
  actorUserId: string,
  workspaceId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  // The SIXTH module-private copy of the two-tier admin check, found by
  // MOTIR-2302's no-second-policy-implementation guard and folded into the shared
  // gate here rather than exempted. It asked the UMBRELLA question — workspace
  // manager, else project-role `admin` — which is exactly
  // `project:administer`, so this is behaviour-neutral: same actors, same
  // `NotProjectAdminError` (the compatibility branch `assertPermission` keeps for
  // that one key), same 404-before-403 ordering. It reuses no new permission,
  // exactly as the note above says; it just stops deriving the answer itself.
  await projectAccessService.assertCanManage(projectId, { userId: actorUserId, workspaceId }, tx);
}

// Quick-search bounds (Subtask 6.9.1) live in the pure `lib/workItems/quickSearch`
// module so the client link pickers (6.9.2) can import them too; re-exported here
// (the bindings are imported at the top) for existing importers + tests that
// source them from the service.
export { QUICK_SEARCH_DEFAULT_LIMIT, QUICK_SEARCH_MAX_LIMIT, QUICK_SEARCH_MIN_QUERY_LENGTH };

/** Max layers `collectReadyLeaves` descends (Subtask 7.0.13). The kind-parent
 *  matrix caps real tree depth at 5 (epic→story→task→bug→subtask); the generous
 *  bound is a backstop against a malformed cycle, never reached normally. */
const READY_MAX_TREE_DEPTH = 8;

/**
 * The documented "low" threshold for the expansion-nudge detector (Subtask
 * 7.11.7 / MOTIR-904, Principle #17). When the ready set drops below this
 * count AND an expandable stub exists, the /ready page surfaces the nudge.
 * A documented constant, not magic — the card requires it to be named and
 * visible so it can be tuned without a code search.
 */
const EXPANSION_NUDGE_THRESHOLD = 3;

/**
 * The project's dispatchable ready leaves, computed TOP-DOWN by layer (Subtask
 * 7.0.13) — the single source `listReady` / `getNextReady` / `countReady` derive
 * from (so they can never disagree). Start at the ROOTS; each layer, keep the
 * OWN-ready nodes (their own blockers done — `computeOwnBlockerReadiness`),
 * DESCEND into the ready CONTAINERS (fetch their children = the next layer) and
 * COLLECT the ready, childless, `todo` leaves. Because we only ever fetch the
 * children of nodes already known ready, a not-ready or fully-planned-out branch
 * is NEVER read (the cost win over the old whole-table candidate scan), and a
 * leaf is reached only via an all-ready ancestor chain — the cascade, equivalent
 * to the bottom-up `getReadinessForItems` the board/detail use per-item. The
 * faceted axes (kind / assignee / priority) narrow the COLLECTED leaves only —
 * the traversal ignores them so a matching leaf under a non-matching ancestor is
 * still reachable. Returned sorted `(type asc, priority desc, key asc)`.
 *
 * `options.allowSoftBlock` (MOTIR-6366, `listReady` only) keeps the OWN-ready
 * requirement on every collected leaf but stops the prune: a container whose
 * own blockers are open is still descended into, so the leaves it holds are
 * collected when THEIR own blockers are satisfied. That container then counts
 * toward its children only as an ancestor — a SOFT block — and is never itself
 * collected (it has children). A not-own-ready leaf stays excluded either way.
 * Readiness is the same `computeOwnBlockerReadiness` predicate in both modes.
 */
async function collectReadyLeaves(
  projectId: string,
  workspaceId: string,
  ctx: Pick<ServiceContext, 'workspaceId'>,
  facets: {
    kinds?: WorkItemKind[];
    assigneeId?: string | null;
    priority?: WorkItemPriority[];
    ancestorKeys?: string[];
    sprintRef?: string;
  },
  options: { allowSoftBlock?: boolean } = {},
): Promise<ReadyLayerRow[]> {
  const allowSoftBlock = options.allowSoftBlock === true;
  // Resolve the two REFERENCE facets BEFORE the walk, so a mistyped key costs
  // one round-trip instead of a full traversal, and so an unresolvable one can
  // never be mistaken for "matched nothing" (`InvalidReadyFilterError`).
  const ancestorIds = await resolveAncestorFacet(projectId, workspaceId, facets.ancestorKeys);
  const sprintId = await resolveSprintFacet(projectId, workspaceId, facets.sprintRef);

  const leaves: ReadyLayerRow[] = [];
  // The ids of ready CONTAINERS whose children are inside the ancestor scope:
  // a container is in scope when it IS a named ancestor, or when its own parent
  // already was. Filled DURING the walk purely as an annotation — nothing below
  // reads it to decide where to go next, which is what keeps the traversal, and
  // therefore the cascade, identical with the facet and without it.
  const scopedContainers = new Set<string>();
  const scopedLeafIds = new Set<string>();

  let frontier = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepository.findReadyLayer(projectId, workspaceId, null, tx),
  );
  for (let depth = 0; depth < READY_MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const ownReady = await computeOwnBlockerReadiness(
      frontier.map((r) => r.id),
      ctx,
    );
    const descend: string[] = [];
    for (const row of frontier) {
      const isOwnReady = ownReady.get(row.id) !== false;
      // Not ready → prune the subtree. Under `allowSoftBlock` only a LEAF is
      // dropped for its own blockers; a not-ready CONTAINER is still descended,
      // so its block reaches its children as an ancestor's (soft) block.
      if (!isOwnReady && !(allowSoftBlock && row.hasChildren)) continue;
      // STRICTLY beneath: a row is in scope because of an ANCESTOR of it, never
      // because of itself — which is what excludes the named container from its
      // own result, and what makes a childless one answer with an empty page.
      const inScope = row.parentId !== null && scopedContainers.has(row.parentId);
      if (row.hasChildren) {
        descend.push(row.id); // container (ready, or soft-blocking) → descend
        if (inScope || (ancestorIds !== null && ancestorIds.has(row.id))) {
          scopedContainers.add(row.id);
        }
      } else if (row.statusCategory === 'todo') {
        leaves.push(row); // ready, childless, to-start
        if (inScope) scopedLeafIds.add(row.id);
      }
    }
    frontier = descend.length
      ? await withWorkspaceServiceContext(workspaceId, (tx) =>
          workItemRepository.findReadyLayer(projectId, workspaceId, descend, tx),
        )
      : [];
  }
  let out = leaves;
  if (facets.kinds && facets.kinds.length > 0) {
    const set = new Set<string>(facets.kinds);
    out = out.filter((r) => set.has(r.kind));
  }
  if (facets.priority && facets.priority.length > 0) {
    const set = new Set<string>(facets.priority);
    out = out.filter((r) => set.has(r.priority));
  }
  if (facets.assigneeId === null) out = out.filter((r) => r.assigneeId === null);
  else if (facets.assigneeId !== undefined) {
    out = out.filter((r) => r.assigneeId === facets.assigneeId);
  }
  // ⚠️ THE ANCESTOR FACET NARROWS THE COLLECTED SET AND NEVER RE-SEEDS THE WALK.
  // Seeding the frontier at the named container is the cheap-looking
  // implementation and it silently DROPS THE CASCADE: it would report leaves as
  // ready under a container whose own ancestors are not ready, which is exactly
  // the wrong answer for a caller about to claim and dispatch them. Filtering
  // here means the answer is a SUBSET of the unfaceted one by construction —
  // there is no code path by which this facet can widen it.
  if (ancestorIds !== null) out = out.filter((r) => scopedLeafIds.has(r.id));
  // DIRECT membership, never inherited — the same predicate `claimNextReady`
  // has applied internally since it shipped.
  if (sprintId !== null) out = out.filter((r) => r.sprintId === sprintId);
  out.sort(compareReadyRows);
  return out;
}

/**
 * The tenant + browse gate every ready read opens with, and the Visitor's hidden
 * set — the same gate `listReady` applies, factored for the lane reads
 * (MOTIR-6830). Cross-workspace, missing and un-browsable projects are all
 * `ProjectNotFoundError`.
 */
async function openReadyRead(
  projectId: string,
  ctx: ServiceContext | VisitorReadContext,
): Promise<{ workspaceId: string; hidden: ReadonlySet<string> | null }> {
  if (isVisitorContext(ctx)) {
    return { workspaceId: openVisitorRead(projectId, ctx).workspaceId, hidden: ctx.hiddenIds };
  }
  const project = await readProject(projectId, ctx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  await assertBrowseAsNotFound(projectId, ctx);
  return { workspaceId: project.workspaceId, hidden: null };
}

/** One ready leaf, placed in its lane: the runnable container it groups under. */
interface ReadyLaneRow {
  row: ReadyLayerRow;
  container: ReadyContainerShapeRow | null;
}

/**
 * PARTITION the walk's result into the leaves and bugs lanes (MOTIR-6830).
 *
 * The walk is `collectReadyLeaves`, called exactly as `listReady` calls it, so
 * the lanes inherit its cascade, facets and `allowSoftBlock` rather than
 * re-deriving any of them. The only new read is `findContainerShapes` over the
 * DISTINCT parents of the collected rows — one query, whatever the page size.
 *
 * The lanes come back UNORDERED; {@link groupLaneRows} gives them their order.
 */
async function partitionReadyLanes(
  projectId: string,
  workspaceId: string,
  hidden: ReadonlySet<string> | null,
  facets: Omit<ReadyListFilter, 'cursor' | 'limit' | 'allowSoftBlock'>,
  allowSoftBlock: boolean,
): Promise<{ leaves: ReadyLaneRow[]; bugs: ReadyLaneRow[] }> {
  const collected = await collectReadyLeaves(projectId, workspaceId, { workspaceId }, facets, {
    allowSoftBlock,
  });
  const visible = hidden ? collected.filter((r) => !hidden.has(r.id)) : collected;
  const parentIds = [...new Set(visible.flatMap((r) => (r.parentId === null ? [] : [r.parentId])))];
  const shapes = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepository.findContainerShapes(parentIds, workspaceId, tx),
  );
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const leaves: ReadyLaneRow[] = [];
  const bugs: ReadyLaneRow[] = [];
  for (const row of visible) {
    const parent = row.parentId === null ? null : (byId.get(row.parentId) ?? null);
    const container = parent && isRunnableContainer(parent) ? parent : null;
    if (isBugWork(row, parent)) {
      // A bug leaf standing under a story is its OWN group in the bugs lane;
      // only a bug's subtasks group under it.
      bugs.push({ row, container: container?.kind === 'bug' ? container : null });
    } else {
      leaves.push({ row, container });
    }
  }
  return { leaves, bugs };
}

/** A lane group: its head (the container, or `null` for a standalone row), its
 *  members in the flat comparator's order, and its position for the cursor. */
interface ReadyLaneGroup {
  container: ReadyContainerShapeRow | null;
  members: ReadyLaneRow[];
  position: ReadyGroupPosition;
}

/**
 * GROUP a lane's rows by `container ?? self` and put the groups in
 * {@link groupRank} order, members in {@link compareReadyRows} order. The
 * input's order does not matter; the output's is the lane's contract.
 */
function groupLaneRows(rows: ReadyLaneRow[]): ReadyLaneGroup[] {
  // The grouping itself is `groupByContainer`'s, shared with the Workbench's grouped
  // tabs (MOTIR-8015), so the two surfaces order groups and members identically.
  return groupByContainer(
    rows,
    (entry) => entry.container ?? entry.row,
    (entry) => entry.row,
  ).map((group) => ({
    container: group.members[0]!.container,
    members: group.members,
    position: group.position,
  }));
}

/**
 * The CONTAINERS lane's groups, in order and faceted (MOTIR-6830): the leaves
 * lane read UNFACETED — so a container's `readyLeafCount` never depends on the
 * caller's facet — grouped, standalone groups dropped, then narrowed by the
 * facets on the CONTAINER itself.
 */
async function readyContainerGroups(
  projectId: string,
  workspaceId: string,
  hidden: ReadonlySet<string> | null,
  filter: Omit<ReadyContainersFilter, 'cursor' | 'limit'>,
): Promise<ReadyLaneGroup[]> {
  const sprintId = await resolveSprintFacet(projectId, workspaceId, filter.sprintRef);
  const { leaves } = await partitionReadyLanes(projectId, workspaceId, hidden, {}, false);
  let groups = groupLaneRows(leaves).filter((g) => g.container !== null);
  if (filter.priority && filter.priority.length > 0) {
    const set = new Set<string>(filter.priority);
    groups = groups.filter((g) => set.has(g.container!.priority));
  }
  if (filter.assigneeId === null) groups = groups.filter((g) => g.container!.assigneeId === null);
  else if (filter.assigneeId !== undefined) {
    groups = groups.filter((g) => g.container!.assigneeId === filter.assigneeId);
  }
  if (sprintId !== null) groups = groups.filter((g) => g.container!.sprintId === sprintId);
  return groups;
}

/** One container group as its lane row, the Visitor's display-name rule applied. */
function presentContainerGroup(
  g: ReadyLaneGroup,
  hidden: ReadonlySet<string> | null,
): ReadyContainerDto {
  const shape = g.container!;
  const assignee = shape.assigneeId
    ? {
        id: shape.assigneeId,
        name: hidden ? personName(shape.assigneeName) : (shape.assigneeName ?? ''),
        email: hidden ? '' : (shape.assigneeEmail ?? ''),
        image: storedAssetUrl(shape.assigneeImage),
      }
    : null;
  return toReadyContainerDto(shape, { assignee, readyLeafCount: g.members.length });
}

/** A lane row's full position: its group's, then its own. */
function laneRowPosition(
  row: ReadyLaneRow,
  group: ReadyGroupPosition,
): { group: ReadyGroupPosition; member: ReadyCursor } {
  return { group, member: { kind: row.row.kind, priority: row.row.priority, key: row.row.key } };
}

/** Strictly after the cursor under (group order, then member order). */
function isAfterLaneCursor(
  position: { group: ReadyGroupPosition; member: ReadyCursor },
  cursor: ReadyLaneCursor,
): boolean {
  const d = groupRank(position.group, cursor.group);
  if (d !== 0) return d > 0;
  return compareReadyPosition(position.member, cursor.member!) > 0;
}

/**
 * The shared body of the two ROW lanes — `leaf` and `bug`: gate, walk,
 * partition, seek past the lane cursor, slice, and present each row as a
 * `ReadyItemDto` carrying its `container`. The presentation is `listReady`'s
 * (lineage in one batched read, the Visitor's display-name rule).
 */
async function listReadyLaneRows(
  projectId: string,
  lane: Exclude<ReadyLane, 'container'>,
  filter: ReadyListFilter,
  ctx: ServiceContext | VisitorReadContext,
): Promise<{ items: ReadyItemDto[]; nextCursor: string | null }> {
  const { workspaceId, hidden } = await openReadyRead(projectId, ctx);
  const readCtx = { workspaceId };
  const limit = clampReadyLimit(filter.limit);
  const cursor = filter.cursor ? decodeReadyLaneCursor(filter.cursor, lane) : undefined;
  const { cursor: _c, limit: _l, allowSoftBlock, ...facets } = filter;
  const partition = await partitionReadyLanes(
    projectId,
    workspaceId,
    hidden,
    facets,
    allowSoftBlock === true,
  );
  const groups = groupLaneRows(lane === 'leaf' ? partition.leaves : partition.bugs);
  const containerOf = new Map(
    groups.flatMap((g) =>
      g.container ? [[g.container.id, presentContainerGroup(g, hidden)]] : [],
    ),
  );
  const positioned = groups.flatMap((g) =>
    g.members.map((m) => ({ entry: m, position: laneRowPosition(m, g.position) })),
  );
  const start = cursor ? positioned.findIndex((p) => isAfterLaneCursor(p.position, cursor)) : 0;
  const begin = start === -1 ? positioned.length : start;
  const window = positioned.slice(begin, begin + limit);
  const last = window.at(-1);
  const nextCursor =
    begin + window.length < positioned.length && last
      ? encodeReadyLaneCursor({ lane, ...last.position })
      : null;
  const lineages = await workItemsService.getInheritedSessionBranches(
    window.map((p) => p.entry.row.id),
    readCtx,
  );
  return {
    items: window.map(({ entry }) => {
      const r = entry.row;
      const context = rowReadyContext(r);
      const assignee =
        hidden && context.assignee
          ? { ...context.assignee, name: personName(r.assigneeName), email: '' }
          : context.assignee;
      return {
        ...toReadyItemDto(r, {
          ...context,
          assignee,
          inheritedSessionBranch: lineages[r.id] ?? null,
        }),
        container: entry.container ? (containerOf.get(entry.container.id) ?? null) : null,
      };
    }),
    nextCursor,
  };
}

/**
 * Resolve `?ancestor=` keys to work-item ids within THIS project, or `null`
 * when the facet is absent.
 *
 * ONE round-trip for any number of keys (`findByIdentifiers` is the batched
 * form), and project-scoped — so a key naming an item in another project or
 * another workspace is simply absent from the result and refused with the same
 * message as one that never existed. The existence-oracle rule is a property of
 * the query here, not an assertion layered on top of it.
 */
async function resolveAncestorFacet(
  projectId: string,
  workspaceId: string,
  keys: string[] | undefined,
): Promise<Set<string> | null> {
  if (!keys || keys.length === 0) return null;
  // ⚠️ BOUND, like every other read on this path. `work_item` is under RLS, so
  // the `db` singleton a repository read defaults to sees nothing at all — a
  // key that exists comes back missing and is refused as unknown. The walk
  // below already binds each layer; the resolver has to bind too.
  const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepository.findByIdentifiers(projectId, keys, tx),
  );
  const byIdentifier = new Map(rows.map((r) => [r.identifier, r.id]));
  const missing = keys.filter((k) => !byIdentifier.has(k));
  if (missing.length > 0) {
    throw new InvalidReadyFilterError(`Unknown \`ancestor\`: ${missing.join(', ')}.`);
  }
  return new Set(byIdentifier.values());
}

/**
 * Resolve `?sprintId=` to a sprint id, or `null` when the facet is absent.
 *
 * The reserved literal `active` resolves to the project's active sprint; a
 * project between sprints is a REFUSAL rather than an empty page, because the
 * two are different answers and only one of them is about the caller's request.
 * Any other value is treated as an id and must belong to this project.
 */
async function resolveSprintFacet(
  projectId: string,
  workspaceId: string,
  ref: string | undefined,
): Promise<string | null> {
  if (ref === undefined) return null;
  if (ref === SPRINT_ACTIVE) {
    const active = await withWorkspaceServiceContext(workspaceId, (tx) =>
      sprintRepository.findActiveByProject(projectId, workspaceId, tx),
    );
    if (!active) {
      throw new InvalidReadyFilterError(
        'No sprint is active in this project, so `sprintId=active` resolves to nothing.',
      );
    }
    return active.id;
  }
  const sprint = await withWorkspaceServiceContext(workspaceId, (tx) =>
    sprintRepository.findById(ref, workspaceId, tx),
  );
  if (!sprint || sprint.projectId !== projectId) {
    throw new InvalidReadyFilterError(`Unknown \`sprintId\`: ${ref}.`);
  }
  return sprint.id;
}

/** Order two ready leaves under the dispatch sort `(type asc, priority desc, key
 *  asc)`: `READY_KIND_RANK` (subtask first … epic last) is primary, priority
 *  (highest first) breaks the type tie, `key` breaks the rest. The ONE comparator
 *  the list slice and the cursor seek-after share, so they can't drift. */
export function compareReadyRows(
  a: { kind: WorkItemKind; priority: WorkItemPriority; key: number },
  b: { kind: WorkItemKind; priority: WorkItemPriority; key: number },
): number {
  return compareReadyPosition(a, b);
}

/** True when `row` sorts STRICTLY AFTER `cursor` under {@link compareReadyRows} —
 *  the seek-after that resumes the next page just past the cursor's
 *  (kind, priority, key). */
function isAfterReadyCursor(
  row: { kind: WorkItemKind; priority: WorkItemPriority; key: number },
  cursor: ReadyCursor,
): boolean {
  return compareReadyRows(row, cursor) > 0;
}

/**
 * The resolved status-category + assignee bits the 7.0.3 mapper needs beyond
 * the `WorkItem` row — both already carried on the candidate row (joined in the
 * single read), so this is a pure projection, no DB call.
 *
 * `inheritedSessionBranch` is deliberately NOT part of it and is why the return
 * type is an `Omit`: it is a fact about the item's DEPENDENCIES, not a column on
 * the row, so a pure row projection cannot supply it. Each caller adds it from
 * wherever it can afford to — the list read in batch for a whole page, a
 * dispatch from the `getReadiness` it already paid for.
 */
function rowReadyContext(row: ReadyCandidateRow): Omit<ReadyItemContext, 'inheritedSessionBranch'> {
  return {
    statusCategory: row.statusCategory,
    assignee: row.assigneeId
      ? {
          id: row.assigneeId,
          name: row.assigneeName ?? '',
          email: row.assigneeEmail ?? '',
          image: storedAssetUrl(row.assigneeImage),
        }
      : null,
  };
}

/**
 * Decorate a ready candidate row with the dispatch-only payload (Subtask 7.0.2):
 * the parent key, the resolved blocker keys, the `contextRefs` parsed from the
 * body's `## Context refs` section (finding #62 — Motir stores refs in
 * `descriptionMd`, not a column; this supplies REAL paths into the 7.0.3
 * mapper's `contextRefs` input instead of the `[]` placeholder), and the
 * INHERITED `sessionBranch` (Subtask 7.8.11 — the single branch this item's
 * integrated-awaiting-review deps live on, so 7.6's GIT-WORKFLOW prompt variant
 * tells the agent to branch from / integrate into it). For a READY item the
 * blockers are all SATISFIED — terminal OR integrated on that one branch — the
 * dependency story the agent's prompt tells. `getReadiness` is the single source
 * of the inherited branch (it ignores a terminal blocker's stale branch and
 * collapses the one integrated lineage); a ready item can never span >1 branch.
 * The candidate row carries the full `WorkItem` body, so no re-read for it.
 */
async function buildReadyDispatchDto(
  row: ReadyCandidateRow,
  ctx: ServiceContext,
  /** The dispatch repository a CLAIM already resolved inside its own transaction
   *  (MOTIR-6243) — `undefined` to resolve it here, as the read-only surfaces do. */
  resolvedDispatchRepo?: ResolvedDispatchRepo | null,
): Promise<ReadyItemDispatchDto> {
  // ⚠️ `allSettledOrThrow`, NOT `Promise.all` (MOTIR-6235). MOTIR-3077 left this
  // fan-out on `Promise.all` believing no arm refuses — but the repo arm
  // (`resolveDispatchRepoForItem`) THROWS `ArchivedTargetRepoError` when the item
  // resolves to an archived repository (MOTIR-1959, which predates that sweep).
  // `Promise.all` rejects on it and returns while the other arms'
  // `withWorkspaceServiceContext` transactions are still open, so a refused
  // `next_ready` / `claim_next_ready` held locks after its refusal was sent — in
  // the suite, what the next test's `TRUNCATE` reset deadlocked against (`40P01`).
  const [parentRow, blockerLinks, readiness, dispatchRepo] = await allSettledOrThrow([
    row.parentId
      ? withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
          workItemRepository.findById(row.parentId as string, tx),
        )
      : Promise.resolve(null),
    withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemLinkRepository.findByFromItem(row.id, 'is_blocked_by', tx),
    ),
    workItemsService.getReadiness(row.id, ctx),
    // WHICH repo to run this in, resolved against the item's PROJECT repo set —
    // else, for a project with no set, the workspace's connected repos (Story
    // MOTIR-1775 · MOTIR-1783, narrowing MOTIR-1804's workspace-only scope).
    // Read here, alongside the other dispatch decorations, because it is only
    // needed for the ONE item being dispatched (never for the list read).
    resolvedDispatchRepo !== undefined
      ? Promise.resolve(resolvedDispatchRepo)
      : resolveDispatchRepoForItem(
          { id: row.id, targetRepo: row.targetRepo, projectId: row.projectId },
          ctx,
        ),
  ]);
  const blockerRows = (
    await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIds(
        blockerLinks.map((l) => l.toId),
        tx,
      ),
    )
  )
    .slice()
    .sort(byKeyAsc);

  const dispatchCtx: ReadyDispatchContext = {
    ...rowReadyContext(row),
    parent: parentRow ? { identifier: parentRow.identifier } : null,
    contextRefs: extractContextRefs(row.descriptionMd),
    sessionBranch: readiness.inheritedSessionBranch,
    // The SAME value the list read resolves in batch (MOTIR-2400). Taken from
    // `getReadiness` here because a dispatch decorates ONE item and has already
    // paid for it; `sessionBranch` above is this fact addressed as an
    // instruction, and both names are kept so neither surface has to explain
    // itself in terms of the other.
    inheritedSessionBranch: readiness.inheritedSessionBranch,
    // WHICH repo to run this in (Story 7.9 · MOTIR-1804 · MOTIR-1783): the
    // item's explicit pin, else the project's SINGLE repo, else null — never a
    // guess across an ambiguous set. The CLI maps this name to a checkout path;
    // the clone URL + default branch are what an agent WITHOUT that checkout
    // needs, and are null (present, never omitted) whenever Motir cannot say.
    targetRepo: dispatchRepo?.name ?? null,
    targetRepoCloneUrl: dispatchRepo?.cloneUrl ?? null,
    targetRepoDefaultBranch: dispatchRepo?.defaultBranch ?? null,
  };
  return toReadyItemDispatchDto(row, blockerRows, dispatchCtx);
}

// `classifyBlockerReadiness` / `isOpenBlocker` / `BlockerReadinessState` MOVED to
// `lib/workItems/blockerReadiness.ts` (MOTIR-3050) — `plansService.materialize`
// is a third caller (an approved plan's `add` is born `blocked` when its edges
// say so), and a rule with three callers belongs in a leaf module rather than
// inside this service. NO re-export shim is left behind on purpose
// (`notes.html` #283): a shim would let a stale `from '@/lib/services/workItemsService'`
// import keep resolving, which is how a moved symbol grows two apparent homes.
// The two readiness reads below import it from the new module, like everyone else.

/**
 * OWN-blocker readiness for a set of items (Subtask 7.0.13) — `id → ready` where
 * ready means "this node's own `is_blocked_by` blockers are all satisfied"
 * (terminal or integrated-awaiting-review), with NO ancestor cascade. This is
 * the per-node leg the readiness verdict is built from: `getReadinessForItems`
 * (batch) and `getReadiness` (single) call it over the item ∪ ancestor set, then
 * AND each node with its ancestor chain to get the cascaded verdict. Extracted
 * so the two entry points share ONE blocker classification (no drift). One
 * blocker query + one terminal-set query regardless of item count (no N+1); an
 * item with no blockers stays `true`.
 */
async function computeOwnBlockerReadiness(
  itemIds: string[],
  ctx: Pick<ServiceContext, 'workspaceId'>,
): Promise<Map<string, boolean>> {
  const ready = new Map<string, boolean>(itemIds.map((id) => [id, true]));
  if (itemIds.length === 0) return ready;
  // The batched form of the readiness read — same consequence, one query for a
  // whole list, so unbound an ENTIRE backlog reports itself ready.
  const blockers = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemLinkRepository.findBlockerStatesForItems(itemIds, tx),
  );
  if (blockers.length === 0) return ready;
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    blockers.map((b) => b.projectId),
    ctx.workspaceId,
  );
  // Group each item's blockers, then classify per item (an item is ready iff it
  // has no open blocker AND its integrated deps don't span >1 branch).
  const byItem = new Map<string, BlockerReadinessState[]>();
  for (const b of blockers) {
    const arr = byItem.get(b.fromId);
    if (arr) arr.push(b);
    else byItem.set(b.fromId, [b]);
  }
  for (const [fromId, itemBlockers] of byItem) {
    ready.set(fromId, classifyBlockerReadiness(itemBlockers, terminalByProject).ready);
  }
  return ready;
}

/**
 * Compute a work item's finishability (Subtask 7.8.23) — the engine behind
 * `validateWorkItem`, given an already-resolved root. See the method's doc for
 * the rule. The "containing set" is the root's SUBTREE (root + live
 * descendants); the structure mirrors `computeSprintValidity` with that set
 * standing in for the sprint, but is SIMPLER: a subtree is closed under
 * descendants, so a member's children are always in-set (the parent→child
 * cascade is auto-satisfied) and only `blocked_by` edges can gate. We probe the
 * not-done members' direct blockers (no ancestor walk — finishing the target's
 * subtree does not depend on work ABOVE it), and report each unsatisfied
 * out-of-subtree blocker at the in-subtree member it gates. Work above it is
 * REPORTED, not gated: `softBlocks` lists the ancestors' open blockers
 * (`computeSoftBlocks`, MOTIR-6368).
 *
 * It ALSO returns the PROSE-vs-GRAPH advisories (MOTIR-1969) for the same
 * not-done members — a SEPARATE, never-blocking channel, computed by
 * `buildProseVsGraphAdvisories`. `valid` and `blockers` are byte-identical
 * whether or not advisories are emitted; nothing below reads `advisories`.
 * The container-COVERAGE (MOTIR-5362) and PATH-REFERENCE (MOTIR-5424) families
 * ride the same channel, and are validate-only.
 */
async function computeWorkItemValidity(
  root: WorkItemDto,
  ctx: ServiceContext,
  condition: ValidityCondition,
): Promise<WorkItemValidityDto> {
  // The containing set S: the root + every non-archived descendant.
  const members = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findSubtreeMembersForValidity(root.id, ctx.workspaceId, tx),
  );
  const memberIds = new Set(members.map((m) => m.id));
  const membersById = new Map(members.map((m) => [m.id, m]));

  // Only NOT-done members need a finishability check. Parent↔child is
  // same-project, so the root's terminal set classifies every member.
  const terminalForProject = await workflowsService.getTerminalStatusKeys(
    root.projectId,
    ctx.workspaceId,
  );
  const notDone = members.filter((m) => !terminalForProject.has(m.status));
  // The NON-gating soft blocks (MOTIR-6368) — read whatever the verdict.
  const softBlocks = await computeSoftBlocks(root, ctx);
  if (notDone.length === 0) {
    return {
      key: root.identifier,
      valid: true,
      blockers: [],
      invalidEdges: [],
      crossLevelEdges: [],
      advisories: [],
      softBlocks,
      sectionFindings: [],
    };
  }

  const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemLinkRepository.findBlockerEdgesForItems(
      notDone.map((m) => m.id),
      undefined,
      tx,
    ),
  );
  // Per-project terminal sets — a block can be cross-project, so each blocker's
  // done-ness is judged against its OWN project (finding #21).
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    edges.map((e) => e.blockerProjectId),
    ctx.workspaceId,
  );

  const blockers: SprintBlockerDto[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const inSubtree = memberIds.has(edge.blockerId);
    const isDone = terminalByProject.get(edge.blockerProjectId)?.has(edge.blockerStatus) ?? false;
    if (gatingItemSatisfied(inSubtree, isDone, condition)) continue;
    const member = membersById.get(edge.fromId);
    if (!member) continue;
    const key = `${member.identifier} ${edge.blockerKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blockers.push({
      item: member.identifier,
      blockedBy: edge.blockerKey,
      blockerStatus: edge.blockerStatus,
      blockerSprintId: edge.blockerSprintId,
    });
  }
  // Deterministic order (by gated item, then blocker) for a stable wire shape.
  blockers.sort((a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy));

  const { advisories: prose, subjects } = await computeSubtreeProseAdvisories(
    root,
    notDone,
    membersById,
    edges,
    ctx,
  );
  const chains = await subtreeChains(root.id, membersById, edges, ctx);
  const crossLevelEdges = computeCrossLevelEdges(edges, membersById, chains);
  const invalidEdges = await computeInvalidEdges(edges, membersById, chains, ctx);
  const coverage = await computeSubtreeCoverageAdvisories(notDone, members, ctx);
  const titleCoverage = await computeSubtreeTitleCoverageAdvisories(notDone, members, ctx);
  // The PATH-REFERENCE family (MOTIR-5424), off the SAME scanned bodies the prose
  // family read — `subjects` is `notDone` mapped in order, so the two zip.
  const pathReferences = await buildPathReferenceAdvisories(
    notDone.map((member, i) => ({
      id: member.id,
      identifier: member.identifier,
      descriptionMd: subjects[i]?.descriptionMd ?? null,
      targetRepos: subjects[i]?.targetRepos ?? [],
    })),
    root.projectId,
    terminalForProject,
    ctx,
  );
  return {
    key: root.identifier,
    // Finishable AND every cross-parent edge covered (MOTIR-6370) AND no edge
    // crossing levels (MOTIR-6509). A gate that asks only "can this be
    // finished?" reads `blockers` (the scope claim does).
    valid: blockers.length === 0 && invalidEdges.length === 0 && crossLevelEdges.length === 0,
    blockers,
    invalidEdges,
    crossLevelEdges,
    advisories: [...prose, ...coverage, ...titleCoverage, ...pathReferences],
    softBlocks,
    // MOTIR-9032 — the SAME scanned bodies, parsed against the section registry.
    // Advisory: `valid` above is computed without it.
    sectionFindings: sectionFindingsFor(
      subjects.map((subject) => ({
        item: subject.item,
        kind: subject.kind ?? 'task',
        type: subject.type,
        descriptionMd: subject.descriptionMd,
      })),
    ),
  };
}

/**
 * The roadmap's off-level edges, each carrying its `EdgeDisposition`
 * (MOTIR-6359). `offLevelIds` names the blockers genuinely on ANOTHER level — the
 * cap-dropped members are already set apart — so only those edges are judged; every
 * other edge passes through unchanged. An end the reads cannot place (a blocker in
 * another project) gets no disposition, and the canvas keeps its old treatment.
 */
async function withRoadmapEdgeCoverage(
  edges: ReadonlyArray<{ blockedId: string; blockerId: string }>,
  offLevelIds: ReadonlySet<string>,
  rows: ReadonlyArray<{ id: string; parentId: string | null; kind: string }>,
  stubs: ReadonlyArray<{ id: string; parentId: string | null; kind: string }>,
  ctx: Pick<ServiceContext, 'workspaceId'>,
): Promise<RoadmapEdgeDto[]> {
  const offEdges = edges.filter((e) => offLevelIds.has(e.blockerId));
  if (offEdges.length === 0) return [...edges];
  const ends = new Map<string, { parentId: string | null; kind: string }>();
  for (const r of rows) ends.set(r.id, { parentId: r.parentId, kind: r.kind });
  for (const s of stubs) ends.set(s.id, { parentId: s.parentId, kind: s.kind });
  const endIds = [...new Set(offEdges.flatMap((e) => [e.blockedId, e.blockerId]))].filter((id) =>
    ends.has(id),
  );
  const parentPairs = offEdges.flatMap((e) => {
    const from = ends.get(e.blockedId)?.parentId;
    const to = ends.get(e.blockerId)?.parentId;
    return from && to && from !== to ? [[from, to] as const] : [];
  });
  const [chains, carriedLinks] = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    Promise.all([
      workItemRepository.findAncestorIdsForItems(endIds, ctx.workspaceId, tx),
      workItemLinkRepository.findBlockedByAmong(
        [...new Set(parentPairs.map(([from]) => from))],
        [...new Set(parentPairs.map(([, to]) => to))],
        ctx.workspaceId,
        tx,
      ),
    ]),
  );
  const carried = new Set(carriedLinks.map((l) => `${l.fromId}\u0000${l.toId}`));
  const info = (id: string): CoverageNodeInfo | undefined => {
    const end = ends.get(id);
    return end
      ? { parentId: end.parentId, kind: end.kind, ancestors: chains.get(id) ?? [] }
      : undefined;
  };
  return edges.map((e) => {
    if (!offLevelIds.has(e.blockerId)) return e;
    const coverage = edgeDisposition(e, info, (from, to) => carried.has(`${from}\u0000${to}`));
    return coverage === undefined ? e : { ...e, coverage };
  });
}

/**
 * The UNCOVERED CROSS-PARENT edges of a validated subtree (Story MOTIR-6015 ·
 * MOTIR-6370) — every same-level `blocked_by` FROM a not-done member whose two
 * ends sit under different parents that carry no matching edge. The rule is
 * `lib/workItems/crossParentCoverage.ts`; this gathers its rows.
 *
 * Two reads at most, and none for a subtree whose edges all stay under one
 * parent: the parent-pair edges (ONE batched `findBlockedByAmong`), then the
 * identifiers of the parents a finding names that the subtree walk did not
 * already carry. An edge whose parent row is not readable here (an out-of-subtree
 * blocker whose parent is in another project the caller cannot see) still has
 * its parent id from the edge read, so it is judged; only its NAME falls back to
 * the id.
 */
async function computeInvalidEdges(
  edges: ReadonlyArray<{
    fromId: string;
    blockerId: string;
    blockerKey: string;
    blockerKind: string;
    blockerParentId: string | null;
  }>,
  membersById: ReadonlyMap<
    string,
    { id: string; identifier: string; kind: string; parentId: string | null }
  >,
  chains: ReadonlyMap<string, readonly string[]>,
  ctx: ServiceContext,
): Promise<InvalidEdgeDto[]> {
  const info = new Map<string, CoverageNodeInfo>();
  for (const m of membersById.values()) {
    info.set(m.id, { parentId: m.parentId, ancestors: chains.get(m.id) ?? [], kind: m.kind });
  }
  for (const e of edges) {
    if (!info.has(e.blockerId)) {
      info.set(e.blockerId, {
        parentId: e.blockerParentId,
        ancestors: chains.get(e.blockerId) ?? [],
        kind: e.blockerKind,
      });
    }
  }
  const coverage = edges.map((e) => ({ blockedId: e.fromId, blockerId: e.blockerId }));
  // The parent pairs a cross-parent edge could need — read once, then answered.
  const pairs = coverage.flatMap((e) => {
    const from = info.get(e.blockedId)?.parentId;
    const to = info.get(e.blockerId)?.parentId;
    return from && to && from !== to ? [[from, to] as const] : [];
  });
  if (pairs.length === 0) return [];
  const carried = new Set(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemLinkRepository.findBlockedByAmong(
          [...new Set(pairs.map(([from]) => from))],
          [...new Set(pairs.map(([, to]) => to))],
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((l) => `${l.fromId}\u0000${l.toId}`),
  );
  const uncovered = uncoveredCrossParentEdges(
    coverage,
    (id) => info.get(id),
    (from, to) => carried.has(`${from}\u0000${to}`),
  );
  if (uncovered.length === 0) return [];

  // Name every parent a finding cites: from the subtree walk where it can, one
  // read for the rest.
  const keyOf = new Map<string, string>();
  for (const m of membersById.values()) keyOf.set(m.id, m.identifier);
  for (const e of edges) keyOf.set(e.blockerId, e.blockerKey);
  const unnamed = [
    ...new Set(
      uncovered.flatMap((e) => [
        info.get(e.blockedId)!.parentId!,
        info.get(e.blockerId)!.parentId!,
      ]),
    ),
  ].filter((id) => !keyOf.has(id));
  if (unnamed.length > 0) {
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdsInWorkspace(unnamed, ctx.workspaceId, tx),
    );
    for (const r of rows) keyOf.set(r.id, r.identifier);
  }
  const name = (id: string): string => keyOf.get(id) ?? id;
  return uncovered
    .map((e) => ({
      item: name(e.blockedId),
      blockedBy: name(e.blockerId),
      itemParent: name(info.get(e.blockedId)!.parentId!),
      blockerParent: name(info.get(e.blockerId)!.parentId!),
    }))
    .sort((a, b) => a.item.localeCompare(b.item) || a.blockedBy.localeCompare(b.blockedBy));
}

/**
 * The ANCESTOR CHAIN (nearest first) of every subtree member and every blocker
 * its edges reach — the POSITIONS the same-level rule reads (MOTIR-6411,
 * `docs/decisions/edge-level-is-position.md`). A member's chain is walked up the
 * subtree read already in hand and finished with the root's own chain; ONE
 * batched read covers the root and every out-of-subtree blocker.
 */
async function subtreeChains(
  rootId: string,
  membersById: ReadonlyMap<string, { id: string; parentId: string | null }>,
  edges: ReadonlyArray<{ blockerId: string }>,
  ctx: ServiceContext,
): Promise<Map<string, readonly string[]>> {
  const outside = [...new Set(edges.map((e) => e.blockerId))].filter((id) => !membersById.has(id));
  const read = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findAncestorIdsForItems([rootId, ...outside], ctx.workspaceId, tx),
  );
  const rootChain = read.get(rootId) ?? [];
  const chains = new Map<string, readonly string[]>();
  for (const id of outside) chains.set(id, read.get(id) ?? []);
  for (const m of membersById.values()) {
    const up: string[] = [];
    let cur = m.id === rootId ? null : m.parentId;
    while (cur !== null && membersById.has(cur)) {
      up.push(cur);
      cur = cur === rootId ? null : (membersById.get(cur)!.parentId ?? null);
    }
    chains.set(m.id, [...up, ...rootChain]);
  }
  return chains;
}

/**
 * The CROSS-LEVEL edges of a validated subtree (Story MOTIR-6015 · MOTIR-6509,
 * `edge-level-is-position.md` Amendment 2): every `blocked_by` a not-done member
 * carries to an item on another level — a different depth below their nearest
 * common ancestor, or an epic paired with a non-epic (Amendment 1). The link
 * doors write such an edge; this is where it becomes a finding, and it makes the
 * verdict INVALID ("blocked elsewhere"). Pure over the chains `subtreeChains` read.
 */
function computeCrossLevelEdges(
  edges: ReadonlyArray<{
    fromId: string;
    blockerId: string;
    blockerKey: string;
    blockerKind: string;
  }>,
  membersById: ReadonlyMap<string, { identifier: string; kind: string }>,
  chains: ReadonlyMap<string, readonly string[]>,
): CrossLevelEdgeDto[] {
  const blockerById = new Map(edges.map((e) => [e.blockerId, e]));
  return crossLevelEdgeFindings(
    edges.map((e) => ({ blockedId: e.fromId, blockerId: e.blockerId })),
    (id) => {
      const ancestors = chains.get(id);
      if (!ancestors) return undefined;
      const member = membersById.get(id);
      if (member) return { label: member.identifier, kind: member.kind, ancestors };
      const edge = blockerById.get(id);
      return edge ? { label: edge.blockerKey, kind: edge.blockerKind, ancestors } : undefined;
    },
  );
}

/**
 * The target's SOFT blocks (MOTIR-6354 / MOTIR-6368) — every open `blocked_by`
 * edge owned by an ANCESTOR of `root`. Such a block reaches the target only
 * through the readiness cascade and is overridable at run time with
 * `--allow-soft-block`, so it is REPORTED, never gating: `valid` / `blockers`
 * never read it. The ancestor chain comes from the same batched ancestor read
 * `getReadinessForItems` does (`findAncestorIdsForItems`); "open" is the
 * validity notion of not-done — the blocker's status is not in ITS project's
 * terminal set (a block can be cross-project; finding #21). Archived blockers
 * are excluded by the edge read, as everywhere. Three reads at most, none past
 * the first for a root with no parent.
 */
async function computeSoftBlocks(
  root: WorkItemDto,
  ctx: ServiceContext,
): Promise<WorkItemSoftBlockDto[]> {
  const ancestorIds =
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findAncestorIdsForItems([root.id], ctx.workspaceId, tx),
      )
    ).get(root.id) ?? [];
  if (ancestorIds.length === 0) return [];
  const { ancestors, edges } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
    ancestors: await workItemRepository.findTitlesByIds(ancestorIds, ctx.workspaceId, tx),
    edges: await workItemLinkRepository.findBlockerEdgesForItems(ancestorIds, ctx.workspaceId, tx),
  }));
  if (edges.length === 0) return [];
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    edges.map((e) => e.blockerProjectId),
    ctx.workspaceId,
  );
  const ancestorById = new Map(ancestors.map((a) => [a.id, a]));
  const softBlocks: WorkItemSoftBlockDto[] = [];
  for (const edge of edges) {
    if (terminalByProject.get(edge.blockerProjectId)?.has(edge.blockerStatus)) continue;
    const via = ancestorById.get(edge.fromId)!;
    softBlocks.push({
      via: { key: via.identifier, title: via.title },
      blockedBy: { key: edge.blockerKey, title: edge.blockerTitle },
      blockerStatus: edge.blockerStatus,
    });
  }
  softBlocks.sort(
    (a, b) => a.via.key.localeCompare(b.via.key) || a.blockedBy.key.localeCompare(b.blockedBy.key),
  );
  return softBlocks;
}

/**
 * The CONTAINER-COVERAGE advisories for a validated subtree (MOTIR-5362) — for
 * every NOT-done member that holds children, does each of its acceptance
 * criteria have a child that owns it? The pure decision is
 * `containerCoverageFinding`; this gathers its rows.
 *
 * Two reads at most, and none for the common subtree: the containers' bodies
 * first (a container with no acceptance-criteria heading can never fire, so its
 * children are never read), then ONE titles read over the children of the
 * containers that remain. A child is any live member whose `parentId` is the
 * container — `done` children included, because a finished child can own a
 * criterion as well as an open one.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — appended after the prose family, and the `valid`
 * / `blockers` verdict above is computed without it.
 */
async function computeSubtreeCoverageAdvisories(
  notDone: Array<{ id: string; identifier: string }>,
  members: Array<{ id: string; parentId: string | null }>,
  ctx: ServiceContext,
): Promise<WorkItemCoverageAdvisoryDto[]> {
  const childIdsByParent = new Map<string, string[]>();
  for (const m of members) {
    if (m.parentId === null) continue;
    const ids = childIdsByParent.get(m.parentId);
    if (ids) ids.push(m.id);
    else childIdsByParent.set(m.parentId, [m.id]);
  }
  const containers = notDone.filter((m) => childIdsByParent.has(m.id));
  if (containers.length === 0) return [];

  const containerRows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findDescriptionsByIds(
      containers.map((c) => c.id),
      ctx.workspaceId,
      tx,
    ),
  );
  const eligible = containerRows.filter(
    (row) => acceptanceCriteriaTexts(row.descriptionMd).length > 0,
  );
  if (eligible.length === 0) return [];

  const childRows = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTitlesByIds(
          eligible.flatMap((row) => childIdsByParent.get(row.id) ?? []),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((row) => [row.id, row]),
  );
  const identifierById = new Map(containers.map((c) => [c.id, c.identifier]));

  const advisories: WorkItemCoverageAdvisoryDto[] = [];
  for (const container of eligible) {
    const children = (childIdsByParent.get(container.id) ?? []).flatMap((id) => {
      const row = childRows.get(id);
      return row
        ? [{ identifier: row.identifier, title: row.title, createdAt: row.createdAt }]
        : [];
    });
    const finding = containerCoverageFinding(container, children);
    if (!finding) continue;
    for (const criterionIndex of finding.unownedCriterionIndices) {
      advisories.push({
        kind: 'coverage',
        item: identifierById.get(container.id) ?? container.id,
        severity: 'likely-unowned-criterion',
        criterionIndex,
        adoptedChildren: finding.adoptedChildren,
      });
    }
  }
  // Deterministic wire order: by container, then by criterion.
  advisories.sort((a, b) => a.item.localeCompare(b.item) || a.criterionIndex - b.criterionIndex);
  return advisories;
}

/**
 * The TITLE-COVERAGE advisories for a validated subtree (MOTIR-8647) — for every
 * NOT-done member that holds children, does its body mention each distinguishing
 * word its title carries? The pure decision is `unnamedTitleWords`; this gathers
 * the containers' titles and bodies in two reads.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — appended beside the coverage family, and the
 * `valid` / `blockers` verdict is computed without it.
 */
async function computeSubtreeTitleCoverageAdvisories(
  notDone: Array<{ id: string; identifier: string }>,
  members: Array<{ id: string; parentId: string | null }>,
  ctx: ServiceContext,
): Promise<WorkItemTitleCoverageAdvisoryDto[]> {
  const parentIds = new Set(members.flatMap((m) => (m.parentId === null ? [] : [m.parentId])));
  const containers = notDone.filter((m) => parentIds.has(m.id));
  if (containers.length === 0) return [];
  const ids = containers.map((c) => c.id);
  const bodies = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findDescriptionsByIds(ids, ctx.workspaceId, tx),
  );
  const titles = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTitlesByIds(ids, ctx.workspaceId, tx),
      )
    ).map((row) => [row.id, row.title]),
  );
  const advisories: WorkItemTitleCoverageAdvisoryDto[] = [];
  for (const container of containers) {
    const body = bodies.find((row) => row.id === container.id);
    const title = titles.get(container.id);
    if (!body || title === undefined) continue;
    const words = unnamedTitleWords(title, body.descriptionMd);
    if (words.length === 0) continue;
    advisories.push({
      kind: 'title-coverage',
      item: container.identifier,
      severity: 'likely-unnamed-title-part',
      words,
    });
  }
  advisories.sort((a, b) => a.item.localeCompare(b.item));
  return advisories;
}

/**
 * The PROSE-vs-GRAPH advisories for a validated subtree (MOTIR-1969) — the same
 * NOT-DONE members the blocker walk probes, each scanned for `motir:` references
 * its body names but the graph has no `blocked_by` edge to. A `done` member is
 * skipped for the same reason it is skipped above: its prose is history, not an
 * unmet dependency.
 *
 * Exempt per member: itself, its ANCESTORS (a card naming its own parent Story /
 * Epic is not a missing dependency — the chain walks up through the subtree and
 * on through the root's own ancestors), and everything already in its
 * `blocked_by` set. Bodies come from ONE batched read; the reference resolution
 * + browse gate + done-ness live in `buildProseVsGraphAdvisories`.
 *
 * ⚠️ ADVISORY, NEVER A BLOCKER — the caller adds this to a separate field and
 * the `valid` / `blockers` verdict above is computed without it.
 */
async function computeSubtreeProseAdvisories(
  root: WorkItemDto,
  notDone: Array<{ id: string; identifier: string; parentId: string | null }>,
  membersById: Map<
    string,
    { id: string; identifier: string; parentId: string | null; kind: string }
  >,
  edges: Array<{ fromId: string; blockerId: string }>,
  ctx: ServiceContext,
): Promise<{ advisories: WorkItemProseAdvisoryDto[]; subjects: ProseAdvisorySubject[] }> {
  // The root's OWN ancestors (above the subtree) — a member naming the epic its
  // story hangs under is naming an ancestor too, and the subtree walk alone
  // cannot see those.
  const aboveRoot = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workItemRepository.findAncestors(root.id, ctx.workspaceId, tx),
  );
  const rootAncestorIds = aboveRoot.map((a) => a.id);

  const blockedByMember = new Map<string, Set<string>>();
  for (const e of edges) {
    const set = blockedByMember.get(e.fromId);
    if (set) set.add(e.blockerId);
    else blockedByMember.set(e.fromId, new Set([e.blockerId]));
  }

  const bodies = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findDescriptionsByIds(
          notDone.map((m) => m.id),
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((r) => [r.id, r]),
  );

  // The SELF-BLOCKING-DESIGN check's edge half (MOTIR-3625): the TYPES behind
  // every `blocked_by` edge in this subtree, so a member that has already lifted
  // its design into a sibling is not reported for still naming it.
  //
  // A separate, LEANER read than the bodies above rather than a widening of it:
  // the blockers are a DIFFERENT set (an edge routinely points OUT of the
  // subtree, which is the whole point of the finishability walk) and this
  // question needs one nullable column per row, not a body. It short-circuits to
  // `[]` on a subtree with no edges at all.
  const blockerTypes = new Map(
    (
      await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findTypesByIds(
          [...new Set(edges.map((e) => e.blockerId))],
          ctx.workspaceId,
          tx,
        ),
      )
    ).map((r) => [r.id, r.type]),
  );

  const subjects = notDone.map((member) => {
    const exemptIds = new Set<string>([member.id, ...rootAncestorIds]);
    // Up the in-subtree chain. `membersById` is finite and acyclic (a tree), and
    // the loop stops at the root, whose ancestors are already seeded above.
    let parentId = member.parentId;
    while (parentId !== null && !exemptIds.has(parentId)) {
      exemptIds.add(parentId);
      parentId = membersById.get(parentId)?.parentId ?? null;
    }
    for (const blockerId of blockedByMember.get(member.id) ?? []) exemptIds.add(blockerId);
    const row = bodies.get(member.id);
    return {
      item: member.identifier,
      descriptionMd: row?.descriptionMd ?? null,
      kind: membersById.get(member.id)?.kind,
      exemptIds,
      // The ORDERING exemption's inputs (MOTIR-2175) and the REPO-STRADDLE
      // check's repository SET (MOTIR-2177, widened in MOTIR-2728), from the same
      // batched read.
      type: row?.type ?? null,
      executor: row?.executor ?? null,
      targetRepos: row?.targetRepos ?? [],
      // The SUBSUMPTION check's two inputs (MOTIR-2903), from the same batched
      // read: the id excludes the card's OWN pull requests from the covering
      // set, and `createdAt` is its `since`.
      id: member.id,
      createdAt: row?.createdAt ?? null,
      // The ESTIMATION-GATE check's three inputs (MOTIR-3110), from the same
      // batched read again — including the LIVE child count, so a member is
      // judged a leaf by POSITION rather than by kind. A member whose row is
      // missing (deleted between the two reads) reads as unestimated and
      // childless, which emits nothing: the check never invents a finding out of
      // an absent row.
      storyPoints: row?.storyPoints ?? null,
      estimateMinutes: row?.estimateMinutes ?? null,
      hasChildren: row?.hasChildren ?? false,
      // The SELF-BLOCKING-DESIGN check's edge half (MOTIR-3625), off the SAME
      // edge set the exempt walk above consumes — an edge whose target row is
      // missing (deleted between the two reads) reads as untyped, which is the
      // value that emits, not one that silently suppresses.
      hasDesignBlocker: [...(blockedByMember.get(member.id) ?? [])].some(
        (blockerId) => blockerTypes.get(blockerId) === 'design',
      ),
      blockerCount: blockedByMember.get(member.id)?.size ?? 0,
      // The POST-MERGE-CHILD check's input (MOTIR-8863): the parent, when it is
      // inside the subtree (the root's own parent is above it and not a container
      // of THIS validation, but a member's parent always is).
      parent: (() => {
        const p = member.parentId ? membersById.get(member.parentId) : undefined;
        return p ? { identifier: p.identifier, kind: p.kind } : null;
      })(),
    };
  });

  return { advisories: await buildProseVsGraphAdvisories(subjects, ctx), subjects };
}
