import {
  Prisma,
  type Plan,
  type PlanItem,
  type PlanTargetLock,
  type WorkItem,
  type WorkItemKind,
} from '@/generated/prisma/client';

import { keyForAppend } from '@/lib/workItems/positioning';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { resolveExecutor } from '@/lib/issues/executorDefaults';
import {
  classifyBlockerReadiness,
  type BlockerReadinessState,
} from '@/lib/workItems/blockerReadiness';
import {
  withProjectNarrowingSuspended,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import {
  planRevisionsService,
  type PlanRevisionAgentActor,
} from '@/lib/services/planRevisionsService';
import {
  REASON_CLASSIFIED_KIND,
  REVISION_REASON_BRANCHES,
  REVISION_REASON_EVIDENCE_MAX,
  isRevisionReasonBranch,
  isRuleRevisionReasonBranch,
  type RevisionReasonBranch,
} from '@/lib/plans/revisionReason';

import { planRepository, type PlanUpdateInput } from '@/lib/repositories/planRepository';
import {
  planItemRepository,
  type PlanItemCreateInput,
  type PlanItemUpdateInput,
} from '@/lib/repositories/planItemRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { planNarrationRepository } from '@/lib/repositories/planNarrationRepository';
import { PLAN_NARRATION_BATCH_MAX, cleanNarrationSentence } from '@/lib/plans/planNarration';
import { PLAN_STALLED_AFTER_MS } from '@/lib/plans/planProgress';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  workItemRepository,
  type WorkItemCreateInput,
  type WorkItemUpdateInput,
} from '@/lib/repositories/workItemRepository';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { manualWorkGateService } from '@/lib/services/manualWorkGateService';
import {
  workItemRevisionRepository,
  WORK_ITEM_REVISIONS_AFTER_MAX,
} from '@/lib/repositories/workItemRevisionRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { describeSubjectShape, isWellFormedSubject } from '@/lib/plans/subjectShape';
import { normalizeBodyRefs } from '@/lib/workItems/normalizeBodyRefs';
import { autoRelateWorkItemMentions } from '@/lib/workItems/autoRelateMentions';
import { rewriteIntraPlanRefs } from '@/lib/mentions/workItemRefs';
import { sendEvent } from '@/lib/jobs/sendEvent';

import { holdsRecordView, projectAccessService } from '@/lib/services/projectAccessService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';

import { ProjectNotFoundError } from '@/lib/projects/errors';
import { NoInitialStatusError } from '@/lib/workItems/errors';
import { foldAppend } from '@/lib/plans/mergeModifyPatch';
import {
  assertEdgeReasonsKeyed,
  foldEdgeReasons,
  normalizeCorrectionEdges,
  normalizeProposalEdges,
  pickEdgeReasons,
  proposalEdgeRefs,
  readEdgeReasons,
} from '@/lib/plans/edgeReasons';
import { assertKnownPatchKeys } from '@/lib/plans/validatePatchKeys';
import {
  FOLDER_REF_PREFIX,
  TEMP_REF_PREFIX,
  assertTempRefsResolvable,
  folderRefId,
  isFolderRef,
  isTempRef,
  SUPERSEDES_PATCH_SITES,
  tempRefsOf,
  type ProposalRefCarrier,
} from '@/lib/plans/refs';
import {
  assertAddKindPlacementLegal,
  assertBlockedByGraphAcyclic,
  assertBlockedByLevels,
  assertFolderPlacementsLegal,
  assertKindChangesLegal,
  assertProposalSetSelfConsistent,
  assertReparentLegal,
  assertSupersedesGraphAcyclic,
  collectReferencedFolderIds,
  collectReferencedWorkItemIds,
  DEFAULT_PROPOSED_KIND,
  projectedKindOverrides,
  proposedParentAnchorIds,
  validatePlanProposals,
  withProjectedKinds,
  type KindChangeContext,
  type LiveFolderState,
  type LiveWorkItemState,
  type ProposalNode,
  type SupersedesEdge,
} from '@/lib/plans/validateProposals';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { validateProposedTodos } from '@/lib/plans/validateProposedTodos';
import { validateProposedDifficulty } from '@/lib/plans/validateProposedDifficulty';
import { applySectionsInput, hasSectionsInput } from '@/lib/plans/applySectionsInput';
import {
  languageFor,
  mergeProposalLanguages,
  validateProposedLanguages,
} from '@/lib/plans/validateProposedLanguages';
import {
  assertReKindedAddKeepsNoLeafFields,
  isContainerKind,
  validateProposedKindChange,
} from '@/lib/plans/validateProposedKind';
import {
  assertMarkTargetIsFinished,
  patchSetsObsolescence,
  validateProposedObsolescence,
} from '@/lib/plans/validateProposedObsolescence';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { isMarkOnlyPatch } from '@/lib/plans/markOnlyPatch';
import {
  assertBodyRefsResolve,
  findUnresolvedIntraPlanRefIds,
} from '@/lib/plans/validateProposedBodyRefs';
import { proposalLinkWarningsService } from '@/lib/services/proposalLinkWarningsService';
import { proposalRescopeWarningsService } from '@/lib/services/proposalRescopeWarningsService';
import { patchRescopes } from '@/lib/plans/rescopeReset';
import { committedPlanTargets } from '@/lib/plans/planTargets';
import { restingStatusFor } from '@/lib/plans/restingStatus';
import { modifyTargetStatusFor, priorStatusOf } from '@/lib/plans/rescopeStatus';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { hasText, toOrgContentLanguage } from '@/lib/workItems/contentLanguage';
import type { Locale } from '@/lib/i18n/locales';
import { normalizeCommand, normalizeNotes, requireText } from '@/lib/workItemTodos/normalize';
import { validateStoryPoints, validateEstimateMinutes } from '@/lib/estimation/validate';
import { PLANNING_SOURCES } from '@/lib/api/v1/workItems/schema';
import {
  InvalidProposalError,
  PlanGrammarError,
  PlanItemNotFoundError,
  PlanItemTargetMissingError,
  PlanItemUnknownTargetRepoError,
  PlanNotEditableError,
  PlanProposalReferencedError,
  PlanProposalRepoPinMovedError,
  PlanItemUnknownTargetRepoRoleError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  NoPlanForWorkItemError,
  PlanApproveTimedOutError,
  PlanHasNoProposalsError,
  PlanItemFieldRejectedError,
  PlanNotInExpectedStatusError,
  PlanPersistenceError,
  PlanGateAwaitingError,
  PlanRevisionInFlightError,
  PlanRefGraphError,
  PlanTargetImmutableError,
  UnresolvedPlanRefError,
  InvalidPlanHistoryCursorError,
  PlanRevisionClassificationInvalidError,
  ApprovedShapeVerdictTooManyIdsError,
  InvalidPlanStepError,
} from '@/lib/plans/errors';
import { classifyRevision } from '@/lib/plans/approvedShapeChange';
import {
  PLAN_REVISION_LEASE_MS,
  REVISION_RENEWED_KIND,
  revisionLeaseJobId,
  revisionLeaseOf,
  REVISION_STARTED_KIND,
  REVISION_ENDED_KIND,
  REVISION_REOPENED_FROM_KEY,
  revisionReopenedFrom,
} from '@/lib/planChange/revisionLease';
import {
  resolveAuthoredRepoPinsInProject,
  resolveAuthoredRepoRefsInProject,
  resolveAuthoredTargetRepoInProject,
  // ⚠️ ALIASED: this file already owns a `ResolvedRepoPins` — the map of each
  // proposal's SINGULAR pin — and the imported one is the direct write path's
  // `{ refs, names, scope }` for ONE item. Two different things, one good name.
  type ResolvedRepoPins as ResolvedRepoSet,
} from '@/lib/workItems/dispatchRepo';
import {
  UnknownProjectRepoRefError,
  UnknownTargetRepoError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { assertSingleTargetRepoInput, primaryTargetRepo } from '@/lib/workItems/targetRepo';
import { writeDerivedRepoSet } from '@/lib/workItems/repoSetWrites';
import { PROJECT_REPO_ROLES, isProjectRepoRole } from '@/lib/projectRepos/vocabulary';

import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type {
  CreatePlanInput,
  PlanAuthorSourceDto,
  PlanOriginDto,
  ListPlansOptions,
  PlanDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanListPageDto,
  PlanApprovabilityRejectionDto,
  PlanStatusCountsDto,
  PlanWithItemsDto,
  PlanWithItemsAndWarningsDto,
  ProposalLinkWarningDto,
  ProposalRescopeWarningDto,
  ProposalInput,
  UpdateProposalInput,
  CorrectProposalInput,
  CorrectPlanBriefInput,
  CorrectPlanBriefKey,
  PlanItemOpDto,
  PlanHistoryListOptions,
  WorkItemPendingPlanStatusDto,
  WorkItemPendingProposalDto,
  WorkItemPlanHistoryEntryDto,
  WorkItemPlanHistoryPageDto,
  ApprovedShapeChildSetDto,
  ApprovedShapeDivergingRevisionDto,
  WorkItemApprovedShapeVerdictDto,
  WorkItemApprovedShapeVerdictPageDto,
  PlanNarrationDto,
  PlanStepDto,
  PlanStepKindDto,
  PlanStepProviderWaitDto,
} from '@/lib/dto/plans';
import {
  PLAN_ITEM_REASON_MAX,
  PLAN_STATUS_DTO_VALUES,
  PLANNER_RECORD_MAX_BYTES,
  WORK_ITEM_PENDING_PLAN_STATUSES,
} from '@/lib/dto/plans';
import {
  toPlanDto,
  toPlanItemDto,
  toPlanNarrationDto,
  toPlanStepDto,
  toPlanWithItemsDto,
  toWorkItemPlanHistoryEntryDto,
} from '@/lib/mappers/planMappers';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { buildScope } from '@/lib/planChange/scope';
import { PlanSessionNotFoundError } from '@/lib/planChange/errors';
import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import { planGateService } from '@/lib/services/planGateService';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { withdrawQuestionsOnArchive } from '@/lib/approvalGates/withdrawOnArchive';
import {
  asPlanStatusRefusal,
  decideThroughDoor,
  planAndGate,
  refuseUngated,
  type DecidePlanInput,
} from '@/lib/services/planGateDoor';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { endSessionWithin } from '@/lib/services/planSessionEndService';

// The AI-planning Plan substrate (Story 7.21 · MOTIR-1336) — the foundation
// every planner produces into. A `Plan` bundles proposed `PlanItem` operations
// the user reviews and approves/declines as ONE unit. A PlanItem is a PROPOSAL,
// never a row in the work-item tree: an `add` lives only as a PlanItem (no
// WorkItem until approve), and `modify`/`remove` leave their targets untouched
// until approve. On approve the items MATERIALIZE; on decline they drop with
// the tree untouched.
//
// 4-layer (CLAUDE.md): this service owns the transactions + the materialize
// orchestration; every DB op goes through a repository. NOTE — the materialize
// composes the work-item LEAF repositories (`workItemRepository`,
// `workItemLinkRepository`, `workItemRevisionsService`,
// `projectRepository.allocateWorkItemNumber`) directly INSIDE the approve
// transaction rather than calling `workItemsService.createWorkItem` /
// `updateWorkItem`, because those service methods own their OWN
// `db.$transaction` and Prisma cannot nest interactive transactions — calling
// them here would break the "approve applies in ONE transaction" guarantee.
// Composing the tx-aware leaves is the architecturally correct way to materialize
// atomically (the card's `workItemsService.create(proposedFields)` intent, at the
// layer transactional composition actually allows).

// The workflow status a materialized `add` is born at when its edges say it
// cannot start (MOTIR-3050). It is the KEY, not a category: `blocked` sits in
// the `todo` category alongside `todo` itself, so there is nothing structural to
// match on — `lib/workflows/defaultWorkflow.ts` seeds this key into every
// project, and a workflow customized to drop it simply keeps the initial status
// (the resolve-then-check in `materialize` handles that).
const BLOCKED_STATUS_KEY = 'blocked';

// Ten rows a page (MOTIR-3235, down from 20). The Plans list streams — a first
// page, then a bottom sentinel that loads the next — and ten is the number the
// tabbed surface is drawn to. `listPlans` has exactly two callers, both on that
// surface, so the CONSTANT moves rather than each caller passing a literal.
// `MAX_PAGE_LIMIT` is untouched: a caller may still ask for more.
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;

/**
 * STAMP A PLAN'S ACTIVITY, AND LET A RETURNING PRODUCER RESUME (MOTIR-8132) — the one
 * door every content write and step signal stamps `lastActivityAt` through, in the
 * write's own transaction.
 *
 * The abandoned-plan sweep RECORDS a failure on the session of a `generating` plan that
 * went silent past `PLAN_STALLED_AFTER_MS`, and leaves the plan, its proposals and its
 * held cards exactly where they were. So a producer that comes back — a hosted job
 * that was only slow, an MCP author resuming a skeleton — must be able to pick the
 * plan up by WRITING: when the plan is `generating` and the latest of its session, and
 * that session is failed-waiting, the record is cleared here, beside the stamp. The
 * plan then reads `working` / `writing` again with everything it held.
 *
 * Lock order is the sweep's (`recordFailureWithin`): the write already holds the plan
 * row, and the clear takes the session row after it. A write the sweep raced either
 * moved the stamp before the sweep's compare-and-set (nothing recorded) or lands after
 * the record and clears it here.
 */
async function stampPlanActivity(
  plan: { id: string; sessionId: string | null; status: string; workspaceId: string },
  at: Date,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await planRepository.touchActivity(plan.id, at, tx);
  if (plan.status !== 'generating' || !plan.sessionId) return;
  const session = await planChangeSessionRepository.findWaitingState(
    plan.sessionId,
    plan.workspaceId,
    tx,
  );
  if (!session || sessionWaitingState(session) !== 'failed') return;
  if ((await planRepository.findLatestIdBySession(plan.sessionId, tx)) !== plan.id) return;
  await planChangeSessionRepository.clearFailure(plan.sessionId, tx);
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
}

// The item page's PLAN HISTORY pages (Story MOTIR-5542 · MOTIR-5546). Its own
// pair rather than the Plans list's: that surface streams ten newest-first rows,
// this one lists a single card's plans oldest-first and a card rarely has more
// than a handful. The cap keeps "show all" a bounded read.
const PLAN_HISTORY_DEFAULT_LIMIT = 20;
const PLAN_HISTORY_MAX_LIMIT = 50;

function clampPlanHistoryLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return PLAN_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(PLAN_HISTORY_MAX_LIMIT, Math.floor(limit)));
}

/** The plan-history cursor: the last plan's `(createdAt, id)`, base64url. */
function encodePlanHistoryCursor(plan: { createdAt: Date; id: string }): string {
  return Buffer.from(`${plan.createdAt.toISOString()}|${plan.id}`, 'utf8').toString('base64url');
}

function decodePlanHistoryCursor(
  cursor: string | null | undefined,
): { createdAt: Date; id: string } | null {
  if (cursor == null || cursor === '') return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (bar <= 0 || !id || Number.isNaN(createdAt.getTime())) {
    throw new InvalidPlanHistoryCursorError();
  }
  return { createdAt, id };
}

// The intra-plan temp-ref prefix: a `parentRef` / `blockedByRef` of the form
// `planItem:<planItemId>` points at another `add` in the SAME plan (resolved to
// the created work-item id at materialize). It now LIVES in `lib/plans/refs.ts`
// (so the persist gate can share it without importing this service — that would
// be a cycle) and is RE-EXPORTED here unchanged, so the pre-commit projection
// engine (7.28.1 / planValidityService) keeps resolving refs through the EXACT
// same contract materialize uses — no second source of truth.
export { TEMP_REF_PREFIX };

// ── The approved-shape verdict (Story MOTIR-5544 · MOTIR-6225) ──────────────────

/** The most work items one {@link plansService.resolveApprovedShapeVerdict} answers. */
export const APPROVED_SHAPE_VERDICT_MAX_IDS = 50;

/** The approving plan's history entry, narrowed to what the verdict needs. */
type ApprovingPlanEntry = WorkItemPlanHistoryEntryDto & { decidedAt: string };

/**
 * The LATEST `approved` plan in a card's history, or null. Pages the history
 * read to its end (it is oldest first), so this is the one "which plans touched
 * this card" query there is — no second one.
 *
 * ⚠️ ASSERTS NOTHING (MOTIR-6284): it pages {@link readPlanHistoryPage}, the
 * computation beneath {@link plansService.listPlanHistoryForWorkItem}'s
 * `ai:view_plan` assertion. Both of its callers own the gate question — the
 * gated verdict asserts the key before it gets here, and the server-internal
 * {@link plansService.resolveApprovedShapeForReport} deliberately does not.
 */
async function latestApprovedPlanEntry(
  projectId: string,
  workItemId: string,
  ctx: ServiceContext,
): Promise<ApprovingPlanEntry | null> {
  let latest: ApprovingPlanEntry | null = null;
  let cursor: string | null = null;
  do {
    const page: WorkItemPlanHistoryPageDto = await readPlanHistoryPage(
      projectId,
      workItemId,
      { cursor, limit: PLAN_HISTORY_MAX_LIMIT },
      ctx,
    );
    for (const entry of page.items) {
      if (entry.planStatus === 'approved' && entry.decidedAt !== null) {
        latest = entry as ApprovingPlanEntry;
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return latest;
}

/**
 * ONE PAGE of a card's plan history — the COMPUTATION beneath
 * {@link plansService.listPlanHistoryForWorkItem}'s `ai:view_plan` assertion
 * (MOTIR-6284), unexported. That method's header documents the page, the fold
 * and the query count; this is its body, moved and unchanged, so the gated door
 * answers byte-for-byte as it did.
 *
 * ⚠️ ASSERTS NOTHING. Every caller owns the gate question: the gated door asserts
 * the key first; {@link latestApprovedPlanEntry} is reached only from a caller
 * that already decided it.
 */
async function readPlanHistoryPage(
  projectId: string,
  workItemId: string,
  options: PlanHistoryListOptions,
  ctx: ServiceContext,
): Promise<WorkItemPlanHistoryPageDto> {
  const limit = clampPlanHistoryLimit(options.limit);
  const after = decodePlanHistoryCursor(options.cursor);

  const { page, hasMore, rows } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const plans = await planRepository.findPageRelatedToWorkItem(
      workItemId,
      ctx.workspaceId,
      projectId,
      limit + 1,
      after,
      tx,
    );
    const page = plans.slice(0, limit);
    if (page.length === 0) return { page, hasMore: false, rows: [] };
    const rows = await planItemRepository.findHistoryByWorkItemId(
      workItemId,
      ctx.workspaceId,
      projectId,
      page.map((plan) => plan.id),
      tx,
    );
    return { page, hasMore: plans.length > limit, rows };
  });

  const byPlan = new Map<string, WorkItemPlanHistoryEntryDto>();
  for (const row of rows) {
    let entry = byPlan.get(row.plan.id);
    if (!entry) {
      entry = toWorkItemPlanHistoryEntryDto(row.plan);
      byPlan.set(row.plan.id, entry);
    }
    // An `add` reaches this read through ONE of two columns, and which one is
    // the whole difference: its `workItemId` is this card (materialize wrote
    // the created id back — the plan CREATED it) or its `parentRef` is (a
    // CHILD under it). A `modify` / `remove` only ever targets.
    if (row.op === 'add' && row.workItemId !== workItemId) {
      entry.relation.childCount += 1;
      entry.proposalIds.children.push(row.id);
    } else {
      entry.relation.op = row.op;
      entry.proposalIds.self = row.id;
    }
  }

  // Emitted in the PAGE's order. A plan on the page with no folded row lost
  // its last related proposal between the two reads (a withdraw); it is
  // omitted rather than rendered claiming nothing, and the cursor still
  // advances past it.
  const items = page.flatMap((plan) => {
    const entry = byPlan.get(plan.id);
    return entry ? [entry] : [];
  });
  return {
    items,
    nextCursor: hasMore ? encodePlanHistoryCursor(page[page.length - 1]!) : null,
  };
}

/**
 * The verdicts for an already-deduplicated, already-bounded id set — the
 * COMPUTATION beneath {@link plansService.resolveApprovedShapeVerdict}'s
 * `ai:view_plan` assertion (MOTIR-6284), unexported and unchanged. Answers in the
 * order `workItemIds` was supplied.
 *
 * ⚠️ ASSERTS NOTHING — its one caller asserted the key and bounded `ids` first.
 */
async function computeApprovedShapeVerdicts(
  projectId: string,
  workItemIds: readonly string[],
  ids: readonly string[],
  ctx: ServiceContext,
): Promise<WorkItemApprovedShapeVerdictPageDto> {
  const verdicts = new Map<string, WorkItemApprovedShapeVerdictDto>();
  for (const workItemId of ids) {
    const approving = await latestApprovedPlanEntry(projectId, workItemId, ctx);
    if (!approving) {
      verdicts.set(workItemId, noPlanVerdict(workItemId));
      continue;
    }
    verdicts.set(workItemId, await verdictAgainst(workItemId, approving, ctx));
  }
  return { items: workItemIds.map((id) => verdicts.get(id)!) };
}

function noPlanVerdict(workItemId: string): WorkItemApprovedShapeVerdictDto {
  return {
    workItemId,
    verdict: 'no_plan',
    planId: null,
    planTitle: null,
    decidedAt: null,
    proposalId: null,
    divergingRevision: null,
    childSet: null,
  };
}

/** Sorted `a − b`. */
function idsMissingFrom(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((id) => !b.has(id)).sort();
}

/**
 * One card against its approving plan: the first shape-changing revision after
 * `decidedAt`, and — for a container — the child set. All reads in ONE bound
 * workspace context (RLS is live under the app role).
 */
async function verdictAgainst(
  workItemId: string,
  approving: ApprovingPlanEntry,
  ctx: ServiceContext,
): Promise<WorkItemApprovedShapeVerdictDto> {
  const decidedAt = new Date(approving.decidedAt);
  const selfProposalId = approving.proposalIds.self;
  const selfOp = approving.relation.op;

  const { diverging, proposals, children } = await withWorkspaceServiceContext(
    ctx.workspaceId,
    async (tx) => {
      let diverging: ApprovedShapeDivergingRevisionDto | null = null;
      let cursor: { changedAt: Date; id: string } | null = null;
      for (;;) {
        const revisions = await workItemRevisionRepository.findChangedAfter(
          workItemId,
          decidedAt,
          cursor,
          WORK_ITEM_REVISIONS_AFTER_MAX,
          tx,
        );
        const hit = revisions.find(
          (r) => classifyRevision(r.diff, { approvedArchived: selfOp === 'remove' }) === 'shape',
        );
        if (hit) {
          diverging = {
            id: hit.id,
            changedAt: hit.changedAt.toISOString(),
            changedById: hit.changedById,
            changeKind: hit.changeKind,
            changedKeys: Object.keys(hit.diff as Record<string, unknown>),
          };
          break;
        }
        if (revisions.length < WORK_ITEM_REVISIONS_AFTER_MAX) break;
        const last = revisions[revisions.length - 1]!;
        cursor = { changedAt: last.changedAt, id: last.id };
      }
      const proposals = await planItemRepository.findByPlanForWorkItem(
        approving.planId,
        workItemId,
        selfOp === 'add' && selfProposalId ? `${TEMP_REF_PREFIX}${selfProposalId}` : null,
        ctx.workspaceId,
        tx,
      );
      const children = await workItemRepository.findChildren(workItemId, tx);
      return { diverging, proposals, children };
    },
  );

  // The children the approving plan put under the card: its child `add`s, by the
  // card each one became. The target's own proposal is not one of them.
  const planned = new Set(
    proposals
      .filter((p) => p.op === 'add' && p.id !== selfProposalId && p.workItemId !== null)
      .map((p) => p.workItemId!),
  );
  const current = new Set(children.map((c) => c.id));
  let childSet: ApprovedShapeChildSetDto | null = null;
  if (planned.size > 0 || current.size > 0) {
    // A plan that CREATED the container approved exactly its child adds; one that
    // only amended it, or only added children, also approved the children it
    // already had (see the method's header).
    const approved = new Set(planned);
    if (selfOp !== 'add') {
      for (const child of children) {
        if (child.createdAt.getTime() <= decidedAt.getTime()) approved.add(child.id);
      }
    }
    const added = idsMissingFrom(current, approved);
    const removed = idsMissingFrom(approved, current);
    childSet = {
      verdict: added.length > 0 || removed.length > 0 ? 'changed' : 'unchanged',
      approvedChildIds: [...approved].sort(),
      currentChildIds: [...current].sort(),
      added,
      removed,
    };
  }

  return {
    workItemId,
    verdict: diverging !== null || childSet?.verdict === 'changed' ? 'changed' : 'unchanged',
    planId: approving.planId,
    planTitle: approving.planTitle,
    decidedAt: approving.decidedAt,
    proposalId: selfProposalId,
    divergingRevision: diverging,
    childSet,
  };
}

/**
 * Validate the leaf SIZING of an `add`'s proposed fields (MOTIR-1433) — the
 * SAME rules the create path applies: a Fibonacci-range story-point value
 * (`validateStoryPoints`) and a non-negative integer-minute time estimate
 * (`validateEstimateMinutes`). Both `undefined`/`null` pass (an unsized or
 * non-leaf `add`). Throws `InvalidEstimateError` on a malformed value, so a bad
 * size is rejected at the proposal boundary rather than silently reaching the
 * `estimateMinutes` / `storyPoints` columns at materialize (which bypasses the
 * MCP/route Zod boundary the human-create path validates behind).
 */
function validateProposedSizing(pf: PlanItemProposedFields): void {
  validateStoryPoints(pf.storyPoints ?? null);
  validateEstimateMinutes(pf.estimateMinutes ?? null);
}

/** A stored JSON value that is an object — the only shape a planner record takes (MOTIR-9978). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The column value for a planner record (MOTIR-9978): `null` clears it, an object
 * is stored whole. Refused, naming the field, when it is not an object or its JSON
 * is over {@link PLANNER_RECORD_MAX_BYTES} — the record is a planner's bookkeeping,
 * not a store for anything a plan's size should be paying for.
 */
function plannerRecordValue(
  record: Record<string, unknown> | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (record === null) return Prisma.DbNull;
  if (!isJsonObject(record)) {
    throw new InvalidProposalError('`plannerRecord` must be a JSON object, or null to clear it.');
  }
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  if (bytes > PLANNER_RECORD_MAX_BYTES) {
    throw new InvalidProposalError(
      `\`plannerRecord\` is ${bytes} bytes of JSON; the most a plan stores is ${PLANNER_RECORD_MAX_BYTES}.`,
    );
  }
  return record as Prisma.InputJsonValue;
}

/**
 * A SELF-REPORTED free-text provenance value (MOTIR-2986) — the authoring
 * agent's harness or model. Stored as-supplied per
 * `docs/decisions/work-item-provenance.md` Decision 2 ("no server-side
 * validation against a fixed list"), with the one normalization that decision
 * itself names: trimmed, empty → null. An all-whitespace value is not an
 * attribution, and letting one through would render as a blank the reader cannot
 * distinguish from a real harness name.
 */
function normalizeSelfReported(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The planning SOURCE materialize will stamp from an `add` proposal
 * (MOTIR-2990) — validated as a member of the closed `WorkItemPlanningSource`
 * set, or rejected.
 *
 * This is the narrow guard that lets `docs/decisions/work-item-provenance.md`
 * Decision 5's PIN be lifted without weakening the property it protected. The
 * pin held "a proposal cannot CLAIM a source" by never reading the value; the
 * property is now held by the WRITE SEAMS (every one of which sets the source
 * server-side — ADR Q4), and this is the backstop that keeps the COLUMN total:
 * an unrecognised value fails at the proposal boundary rather than reaching a
 * column whose display switch is closed over four members.
 *
 * Absent / null passes — that is the default case, and by far the common one.
 */
function assertKnownPlanningSource(pf: PlanItemProposedFields, label: string): void {
  const source = pf.planningProvenance?.source;
  if (source == null) return;
  if (!(PLANNING_SOURCES as readonly string[]).includes(source)) {
    throw new InvalidProposalError(
      `${label}: unknown planning source \`${source}\` — expected one of ${PLANNING_SOURCES.join(', ')}.`,
    );
  }
}

/**
 * A `folder:` ref with nothing after the prefix names no folder and never could
 * (MOTIR-5414). Refused in the pure per-proposal pass, where a blank
 * `patch.parentRef` is refused, rather than read as an unknown id later.
 */
function assertFolderRefNotBlank(
  ref: string | null | undefined,
  site: string,
  label: string,
): void {
  if (typeof ref === 'string' && isFolderRef(ref) && folderRefId(ref).trim().length === 0) {
    throw new InvalidProposalError(
      `${label}: \`${site}\` is "${ref}", which names no folder. Send \`${FOLDER_REF_PREFIX}<folderId>\`.`,
    );
  }
}

/**
 * A `remove`'s REASON (AMENDMENT 18 §3, MOTIR-6052): optional, `remove`-only,
 * and 1–{@link PLAN_ITEM_REASON_MAX} characters after trimming. `null` and an
 * absent key both mean "no reason", on any op.
 */
function assertReasonLegal(p: ProposalInput): void {
  if (p.reason === undefined || p.reason === null) return;
  const label = proposalLabel({
    op: p.op,
    workItemId: p.workItemId,
    title: p.proposedFields?.title,
  });
  if (p.op !== 'remove') {
    throw new InvalidProposalError(
      `${label}: \`reason\` belongs to a \`remove\` proposal — it says why a card is being removed. ` +
        `Put what an \`${p.op}\` means in its own fields instead.`,
    );
  }
  const reason = p.reason.trim();
  if (reason.length === 0) {
    throw new InvalidProposalError(
      `${label}: \`reason\` is blank. Say why the card is being removed, or omit the key.`,
    );
  }
  if (reason.length > PLAN_ITEM_REASON_MAX) {
    throw new InvalidProposalError(
      `${label}: \`reason\` is ${reason.length} characters; it may be at most ${PLAN_ITEM_REASON_MAX}.`,
    );
  }
}

function validateProposal(p: ProposalInput): void {
  assertReasonLegal(p);
  // `supersedesRefs` is an `add`'s column (MOTIR-6630); a `modify` spells its
  // edges on the patch (`supersedesAdd` / `supersededByAdd` / the removes), and a
  // `remove` has none. Refused by name rather than stored and never applied.
  if (p.op !== 'add' && (p.supersedesRefs?.length ?? 0) > 0) {
    throw new InvalidProposalError(
      `${proposalLabel({ op: p.op, workItemId: p.workItemId })}: \`supersedesRefs\` is an \`add\`'s field. ` +
        'A `modify` carries its supersedes edges on the patch — `supersedesAdd` / `supersedesRemove` ' +
        '(the target replaces each ref) and `supersededByAdd` / `supersededByRemove` (each ref replaces the target).',
    );
  }
  if (p.op !== 'add' && p.languages !== undefined) {
    throw new InvalidProposalError(
      `${proposalLabel({ op: p.op, workItemId: p.workItemId })}: \`languages\` beside the fields is an \`add\`'s. ` +
        'A `modify` names the language of each text field it sets in `patch.languages`.',
    );
  }
  assertFolderRefNotBlank(
    p.parentRef,
    'parentRef',
    proposalLabel({ op: p.op, workItemId: p.workItemId, title: p.proposedFields?.title }),
  );
  if (p.op === 'modify') {
    assertFolderRefNotBlank(
      p.patch?.parentRef,
      'patch.parentRef',
      proposalLabel({ op: p.op, workItemId: p.workItemId }),
    );
  }
  if (p.op === 'add') {
    if (!p.proposedFields || !p.proposedFields.title?.trim()) {
      throw new InvalidProposalError('An `add` proposal requires proposedFields.title.');
    }
    validateProposedSizing(p.proposedFields);
    // The card's proposed STEPS (MOTIR-4616 · AMENDMENT 14 D4) — the store's own
    // caps, imported never re-declared, plus the container gate. Read the kind
    // the way `materialize` reads it (`DEFAULT_PROPOSED_KIND` when the `add`
    // proposes none), so the gate here and the insert there agree about what
    // this proposal IS.
    validateProposedTodos(
      p.proposedFields.todos,
      p.proposedFields.kind ?? DEFAULT_PROPOSED_KIND,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
    // The leaf's DIFFICULTY (MOTIR-6133 · AMENDMENT 19) — membership plus the
    // container refusal, on the kind `materialize` will create, through the ONE
    // validator every proposal door shares.
    validateProposedDifficulty(
      p.proposedFields.difficulty,
      p.proposedFields.kind ?? DEFAULT_PROPOSED_KIND,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
    // The language each text field was written in (MOTIR-8743) — beside the
    // fields on the wire, or (an older producer's spelling) inside them.
    validateProposedLanguages(
      p.languages ?? p.proposedFields.languages,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
    assertKnownPlanningSource(
      p.proposedFields,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
    // The bodies' INTRA-PLAN item links are NOT refused here (MOTIR-10104): a
    // broken one is kept and WARNED on the response (`addProposals`), and approve
    // refuses the plan while it remains.
    // The repo ROLE (MOTIR-1912) — checked HERE, at the append, because the check
    // is pure (a closed vocabulary, no repository need exist) and the producer is
    // a machine: telling motir-ai its role is unknown while it is still writing
    // the plan is worth far more than discovering it at approve, when a human is
    // waiting. Approve re-checks anyway, for the proposals that predate this.
    assertKnownRepoRole(
      p.proposedFields.targetRepoRole,
      null,
      proposalLabel({ op: p.op, title: p.proposedFields.title }),
    );
    // The repository AXIS may be described ONCE (bug MOTIR-4904) — through the
    // direct door's OWN guard, imported rather than re-implemented, so the two
    // doors cannot come to disagree about what a contradiction is. Checked at the
    // append for the same reason the role is: the answer needs no read, and an
    // author writing a plan is the right person to hear it.
    assertSingleTargetRepoInput(
      p.proposedFields.targetRepo,
      p.proposedFields.targetRepos,
      p.proposedFields.targetRepositories,
      p.proposedFields.targetRepositoryRef,
    );
  } else if (p.op === 'modify') {
    if (!p.workItemId) throw new InvalidProposalError('A `modify` proposal requires workItemId.');
    if (!p.patch) throw new InvalidProposalError('A `modify` proposal requires a patch.');
    // A key the patch cannot apply is REFUSED, by name, rather than accepted and
    // dropped at the merge (bug MOTIR-6259) — first, so every check below reads a
    // patch whose every key means something.
    assertKnownPatchKeys(p.patch, proposalLabel({ op: p.op, workItemId: p.workItemId }));
    // A `modify` may RE-SCOPE the target's sizing (MOTIR-1532) — validate the
    // patched-in points/estimate at the boundary, the SAME rules the `add` path
    // applies (`validateProposedSizing`), so a malformed re-scope is rejected here
    // (422) rather than reaching the `storyPoints`/`estimateMinutes` columns at
    // materialize. Absent (`undefined`/`null`) passes — a modify that leaves
    // sizing alone, or an explicit `null` that clears it.
    validateStoryPoints(p.patch.storyPoints ?? null);
    validateEstimateMinutes(p.patch.estimateMinutes ?? null);
    // A `modify` may RE-KIND the target (bug MOTIR-8192 · AMENDMENT 25).
    // MEMBERSHIP only here — `epic` refused by name; the parent, the children
    // and the leaf fields need the tree, and run in `addProposals`' transaction
    // (`assertKindChangesLegalAtAppend`) and again at approve.
    validateProposedKindChange(p.patch.kind, proposalLabel({ op: p.op, workItemId: p.workItemId }));
    // A `modify` may RE-JUDGE the target's difficulty (MOTIR-6133). MEMBERSHIP
    // only here — this pass is pure and the target's KIND needs a read, so the
    // container half runs inside `addProposals`' transaction
    // (`assertModifyLeafFieldsLegalAtAppend`), through the same validator.
    validateProposedDifficulty(
      p.patch.difficulty,
      null,
      proposalLabel({ op: p.op, workItemId: p.workItemId }),
    );
    // The language of each text field the patch sets (MOTIR-8743).
    validateProposedLanguages(
      p.patch.languages,
      proposalLabel({ op: p.op, workItemId: p.workItemId }),
    );
    // A `modify` may REPLACE the target's steps (MOTIR-8668 · AMENDMENT 27). The
    // rows against the store's caps here; the container half needs the target's
    // kind, so it runs in `addProposals`' transaction beside the difficulty's
    // (`assertModifyLeafFieldsLegalAtAppend`).
    validateProposedTodos(
      p.patch.todos,
      null,
      proposalLabel({ op: p.op, workItemId: p.workItemId }),
    );
    // A `modify` may MARK the target (MOTIR-6629) — membership of the mark and a
    // string-or-null note, and nothing else: the mark is kind- and status-agnostic.
    validateProposedObsolescence(p.patch, proposalLabel({ op: p.op, workItemId: p.workItemId }));
    // A `modify`'s rewritten bodies are rewritten at approve too (MOTIR-3804), so
    // their links are WARNED like an `add`'s (bugs MOTIR-6494 · MOTIR-10104).
    // A `modify` may RE-PIN the role (MOTIR-1912) — same vocabulary check as the
    // `add` path, so the two cannot disagree about what a role is.
    assertKnownRepoRole(
      p.patch.targetRepoRole,
      null,
      proposalLabel({ op: p.op, workItemId: p.workItemId }),
    );
    // A `modify` may RE-PIN the whole SET (bug MOTIR-4904) — and, exactly as on
    // the `add` path above, may describe the axis only once.
    assertSingleTargetRepoInput(
      p.patch.targetRepo,
      p.patch.targetRepos,
      p.patch.targetRepositories,
      p.patch.targetRepositoryRef,
    );
    // A `modify` may RE-PARENT the target (MOTIR-3859) — onto a live row, a
    // folder, or (AMENDMENT 18 §1, MOTIR-6050) a proposed `add` on this plan.
    // Only a BLANK ref is refused here, in the pure per-proposal pass; the five
    // checks that need the tree — against the projection for a proposed parent
    // — run in `assertReparentLegal`, which the append and the approve share.
    if (typeof p.patch.parentRef === 'string') {
      const ref = p.patch.parentRef.trim();
      if (ref.length === 0) {
        throw new InvalidProposalError(
          `${proposalLabel({ op: p.op, workItemId: p.workItemId })}: \`patch.parentRef\` is blank. ` +
            'Send a work-item key / id to re-parent under it, an explicit `null` to move it to the ' +
            'project root, or omit the key to leave the parent alone.',
        );
      }
    }
  } else {
    // remove
    if (!p.workItemId) throw new InvalidProposalError('A `remove` proposal requires workItemId.');
  }
}

/**
 * Convert a PRISMA failure escaping a plan boundary into a typed
 * {@link PlanPersistenceError} (MOTIR-3194); pass everything else through
 * untouched.
 *
 * ⚠️ THE POINT IS THE `else` BRANCH, not the mapping. `toToolError` RE-THROWS
 * what it does not recognise, and the MCP SDK renders a re-thrown error's
 * `message` into a JSON-RPC internal error — so any Prisma error reaching an MCP
 * boundary IS the caller's error text. Before this, the duplicate-target
 * constraint arrived as ``Invalid `prisma.planItem.create()` invocation: Unique
 * constraint failed on the (not available)``: the ORM's method name, no subject,
 * and a constraint field rendering as nothing.
 *
 * Catching only the one known constraint would have left every other ORM failure
 * on the same path escaping the same way, so this catches the WHOLE Prisma error
 * family by class. It must therefore be conservative in the other direction: the
 * service's own typed errors (`PlanNotFoundError`, `PlanNotGeneratingError`,
 * `DuplicatePlanTargetError`, …) are thrown from INSIDE the same transaction and
 * are returned unchanged — a wrapper that swallowed them would trade one opaque
 * failure for another.
 *
 * The five classes are the complete set the client can throw
 * (`generated/prisma/internal/prismaNamespace.ts`), enumerated rather than matched
 * on a name prefix so a hand-thrown `Error` named like one cannot be mistaken for
 * an ORM failure.
 */
function containPrismaFailure(err: unknown, operation: string): unknown {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    const ormCode = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null;
    return new PlanPersistenceError(operation, ormCode);
  }
  return err;
}

/**
 * Apply an `UpdateProposalInput` over an `add`'s existing `proposedFields`
 * (7.21.6 · MOTIR-1370). SPARSE: only the keys PRESENT in the input change; an
 * absent key (`undefined`) is left as-is, an explicit `null` on a nullable field
 * clears it. The result is re-validated by the caller (title must stay non-empty).
 *
 * ⚠️ `executor` JOINED the editable set on 2026-08-19 (`agent-authored-plans.md`
 * AMENDMENT 4 D3a · MOTIR-3089). This comment used to read "`executor` is never
 * touched (not in the editable set)", which was true and is now the opposite of
 * true. The reason it moved: `type` was always deepenable, `executor` is DERIVED
 * from `type` by `defaultExecutorForType`, and `materialize` writes
 * `pf.executor ?? null` (below) without ever consulting that map — so a
 * titles-first proposal that gained its type on a deepen turn materialized with a
 * null executor and nothing on the way there said so. The ADR rejects the
 * alternative repair (seeding the default inside `materialize`) on the record.
 *
 * ⚠️ STILL NOT in the set, and deliberately: `targetRepo` / `targetRepos` /
 * `targetRepositories` / `targetRepoRole` (the repo pin is part of a leaf's
 * identity and is settled at append; widening here
 * would give an agent a re-pin the human review surface does not have) and the
 * ref graph `parentRef` / `blockedByRefs` (which live on the PlanItem row, not in
 * `proposedFields`, and whose mutability would let a cycle be built inside a
 * `generating` plan that nothing catches until approve).
 */
function mergeProposedFields(
  current: PlanItemProposedFields,
  input: UpdateProposalInput,
): PlanItemProposedFields {
  const next: PlanItemProposedFields = { ...current };
  if (input.title !== undefined) next.title = input.title;
  if (input.kind !== undefined) next.kind = input.kind;
  if (input.descriptionMd !== undefined) next.descriptionMd = input.descriptionMd;
  if (input.type !== undefined) next.type = input.type;
  if (input.priority !== undefined) next.priority = input.priority;
  if (input.storyPoints !== undefined) next.storyPoints = input.storyPoints;
  if (input.estimateMinutes !== undefined) next.estimateMinutes = input.estimateMinutes;
  // A leaf's DIFFICULTY (MOTIR-6133) — sparse like the sizing above it; an
  // explicit `null` clears it.
  if (input.difficulty !== undefined) next.difficulty = input.difficulty;
  if (input.explanationMd !== undefined) next.explanationMd = input.explanationMd;
  // AMENDMENT 4 D3a (MOTIR-3089) — the deepen turn's one widening. Sparse like
  // every key above it: absent leaves the proposal's executor alone, an explicit
  // `null` clears it back to unassigned.
  if (input.executor !== undefined) next.executor = input.executor;
  // The card's proposed STEPS (MOTIR-4616 · AMENDMENT 14 D3). Sparse at the KEY
  // like every line above it — absent leaves the list alone, an explicit `[]` or
  // `null` clears it — but the VALUE replaces the set whole rather than merging
  // per row: a list has no meaningful partial edit, the same reason a
  // correction's `blockedByRefs` replaces rather than merges.
  if (input.todos !== undefined) next.todos = input.todos;
  // The LANGUAGES (MOTIR-8743) — per key, and a field this input rewrites
  // without naming its language drops that field's key, so a person's edit (the
  // public route sends none) never inherits the planner's claim about text it
  // replaced. Approve then records that field in the organisation's language.
  const languages = mergeProposalLanguages(current.languages, input, input.languages);
  if (languages) next.languages = languages;
  else delete next.languages;
  // The card's SECTIONS INPUT (Story MOTIR-9023 · MOTIR-9030) — after the scalar
  // merge above, so it is judged on the MERGED kind × type, the same pattern
  // `todos` and `difficulty` follow. Rendered into `descriptionMd` and never
  // copied into `next`: nothing structured is stored. Sparse at the section key
  // over the stored body, which `applySectionsInput` parses first. A write that
  // sends no `sections` never reaches it and stores `descriptionMd` as sent.
  if (hasSectionsInput(input)) {
    next.descriptionMd = applySectionsInput({
      sections: input.sections,
      descriptionMd: input.descriptionMd,
      currentBody: current.descriptionMd,
      kind: next.kind ?? DEFAULT_PROPOSED_KIND,
      type: next.type,
      label: proposalLabel({ op: 'add', title: next.title }),
    });
  }
  return next;
}

/**
 * Refuse an `add` edit whose bodies link a `planItem:` id the plan does not hold
 * (bug MOTIR-9175), judged on the bodies the edit WRITES (bug MOTIR-9836). A
 * write carrying `sections` sends no `descriptionMd` of its own — the body it
 * stores is the one `mergeProposedFields` rendered into `next` — so judging
 * `input.descriptionMd` skipped the check on the path both planners author
 * through. Sections are sparse over the stored body, so a link the stored body
 * already carried is inherited, not written: it stays repairable by a write that
 * does not touch it, as an unrelated edit already is on the plain path.
 */
function assertEditBodyRefsResolve(
  current: PlanItemProposedFields,
  input: UpdateProposalInput,
  next: PlanItemProposedFields,
  addIds: ReadonlySet<string>,
  label: string,
): void {
  if (!hasSectionsInput(input)) {
    assertBodyRefsResolve(
      { descriptionMd: input.descriptionMd, explanationMd: input.explanationMd },
      addIds,
      label,
    );
    return;
  }
  const inherited = findUnresolvedIntraPlanRefIds(current.descriptionMd ?? '', addIds);
  assertBodyRefsResolve(
    { descriptionMd: next.descriptionMd, explanationMd: input.explanationMd },
    new Set([...addIds, ...inherited]),
    label,
  );
}

/**
 * Resolve every `add`'s sections INPUT into the `descriptionMd` it renders to,
 * and strip the key (Story MOTIR-9023 · MOTIR-9030). Pure, run FIRST on the
 * append so every later gate judges the proposal as it will be stored. A `modify`
 * or `remove` carrying `sections` is refused by name: sections on a committed
 * card belong to the work-item doors, not to a plan patch.
 */
function resolveProposalSections(p: ProposalInput): ProposalInput {
  if (p.op !== 'add') {
    const carried =
      (p as { sections?: unknown }).sections !== undefined ||
      (p.patch as { sections?: unknown } | null | undefined)?.sections !== undefined;
    if (carried) {
      throw new InvalidProposalError(
        `${proposalLabel({ op: p.op, workItemId: p.workItemId })}: \`sections\` belongs to an \`add\` — ` +
          'sections on a committed card are written through `update_work_item`, not a plan proposal.',
      );
    }
    return p;
  }
  const fields = p.proposedFields;
  if (!fields || !hasSectionsInput(fields)) return p;
  const { sections, ...rest } = fields;
  const descriptionMd = applySectionsInput({
    sections,
    descriptionMd: rest.descriptionMd,
    currentBody: undefined,
    kind: rest.kind ?? DEFAULT_PROPOSED_KIND,
    type: rest.type,
    label: proposalLabel({ op: 'add', title: rest.title }),
  });
  return { ...p, proposedFields: { ...rest, descriptionMd } };
}

/**
 * An `add`'s fields as STORED (MOTIR-8743): the language statement that arrives
 * beside them is copied inside, the one place a proposal's fields live, so it
 * survives every later edit to the row. A statement already inside is kept when
 * none arrives beside it.
 */
function withProposalLanguages(
  fields: PlanItemProposedFields,
  languages: ProposalInput['languages'],
): PlanItemProposedFields {
  return languages === undefined ? fields : { ...fields, languages };
}

/** One to-do row a materialized `add` wrote, as the revision diff names it. */
interface MaterializedTodo {
  id: string;
  text: string;
}

/**
 * One cell of a created-row revision diff. Every SCALAR key is a `{ from: null,
 * to }` pair; `todos` is a COLLECTION key carrying `{ added }` directly, for the
 * reason stated where it is written below — `lib/activity/renderers.ts` is keyed
 * by field NAME, so the shape is the field's, not this function's.
 */
type AddDiffCell = { from: null; to: unknown } | { added: readonly MaterializedTodo[] };

/** A created-row revision diff for a materialized add. */
function buildAddDiff(
  row: WorkItem,
  todos: readonly MaterializedTodo[] = [],
): Record<string, AddDiffCell> {
  const diff: Record<string, AddDiffCell> = {
    title: { from: null, to: row.title },
    kind: { from: null, to: row.kind },
    status: { from: null, to: row.status },
  };
  // The folder a plan filed the item into (MOTIR-5423) — `folderId` has a
  // `resolvedField` disposition in lib/activity/renderers.ts, the same cell the
  // service's created revision records. Omitted when unfiled.
  if (row.folderId != null) diff.folderId = { from: null, to: row.folderId };
  if (row.descriptionMd != null) diff.descriptionMd = { from: null, to: row.descriptionMd };
  // AI-drafted explanation (MOTIR-850) — record it when set (null = none is
  // omitted). `explanationMd` has an `editedField()` disposition in
  // lib/activity/renderers.ts, so the created-revision feed renders it; the
  // `explanationSource` metadata column is deliberately NOT diffed (no renderer
  // disposition — the same rule the `modify` path follows for undispositioned keys).
  if (row.explanationMd != null) diff.explanationMd = { from: null, to: row.explanationMd };
  if (row.type != null) diff.type = { from: null, to: row.type };
  if (row.executor != null) diff.executor = { from: null, to: row.executor };
  // Leaf sizing (MOTIR-1433) — mirror `buildCreatedDiff`: record the estimate
  // when set (null = unestimated is omitted). `storyPoints` is a Prisma Decimal,
  // so record it numeric (the same `Number(...)` shape estimationService logs).
  if (row.estimateMinutes != null) diff.estimateMinutes = { from: null, to: row.estimateMinutes };
  if (row.storyPoints != null) diff.storyPoints = { from: null, to: Number(row.storyPoints) };
  // A leaf's DIFFICULTY (MOTIR-6133) — `difficulty` has a `textField()`
  // disposition in lib/activity/renderers.ts (MOTIR-6096). Omitted when unset.
  if (row.difficulty != null) diff.difficulty = { from: null, to: row.difficulty };
  // The repo pin (MOTIR-1884) — recorded when the proposal carried one (null =
  // unpinned is omitted, like every other optional field here). `targetRepo` has a
  // `textField()` disposition in lib/activity/renderers.ts, so the created-revision
  // feed renders it.
  if (row.targetRepo != null) diff.targetRepo = { from: null, to: row.targetRepo };
  // The card's STEPS (MOTIR-4618 · AMENDMENT 14 D5) — BYTE-IDENTICAL to what
  // `workItemTodosService.recordTodoRevision` writes for a hand-added row, so the
  // item's history reads the same whichever door the rows came through.
  //
  // ⚠️ AND THAT IS WHY IT IS NOT A `{ from, to }` CELL like its neighbours here.
  // `lib/activity/renderers.ts` is keyed by FIELD NAME, not by revision kind, so
  // `todos` has exactly one shape across every writer, and the shipped hand-add
  // fixed it first: `collectionField()` reads `added` / `removed` off the value
  // itself. Wrapping it would not render as a different collection — it would
  // miss the collection renderer entirely and fall through to the generic part.
  //
  // Omitted when the `add` carried none, like every other optional field here:
  // an empty key would render as "a list was created" for a card with no list.
  if (todos.length > 0) {
    diff.todos = { added: todos.map((t) => ({ id: t.id, text: t.text })) };
  }
  return diff;
}

/**
 * Topologically order `add` PlanItems so a child (whose `parentRef` is an
 * intra-plan temp-ref `planItem:<id>`) is created AFTER its parent — the parent
 * work item must exist when the child is inserted (a subtask cannot be
 * transiently parent-less under the kind-parent DB trigger). Refs to real ids /
 * null impose no ordering. Throws on a missing intra-plan parent or a cycle.
 */
function topoOrderAdds(adds: PlanItem[]): PlanItem[] {
  const byId = new Map(adds.map((a) => [a.id, a]));
  const ordered: PlanItem[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (a: PlanItem): void => {
    if (visited.has(a.id)) return;
    if (visiting.has(a.id)) throw new UnresolvedPlanRefError(`${TEMP_REF_PREFIX}${a.id}`);
    visiting.add(a.id);
    if (a.parentRef && a.parentRef.startsWith(TEMP_REF_PREFIX)) {
      const parentId = a.parentRef.slice(TEMP_REF_PREFIX.length);
      const parent = byId.get(parentId);
      if (!parent) throw new UnresolvedPlanRefError(a.parentRef);
      visit(parent);
    }
    visiting.delete(a.id);
    visited.add(a.id);
    ordered.push(a);
  };

  for (const a of adds) visit(a);
  return ordered;
}

// ── The confirmation gate at PERSIST (Subtask 7.12.5 · MOTIR-911) ─────────────
//
// `approvePlan` is the ONLY path from a proposal to a row, and it re-validates
// the proposal set INDEPENDENTLY before it writes anything — the grammar
// (`lib/issues/parentRules.ts`) and done-work immutability. The verdict itself
// lives in the pure `lib/plans/validateProposals` module; these three helpers
// are its I/O shell: project the Prisma rows onto its shape, resolve the live
// state it needs, and (inside the transaction) take the row locks first.
//
// It runs TWICE, deliberately:
//   • BEFORE the transaction opens — the cheap typed rejection, with the tree
//     and the plan status provably untouched (nothing has been read FOR UPDATE,
//     nothing written).
//   • INSIDE the transaction, after the plan lock and under the TARGETS' row
//     locks — because a pre-transaction snapshot goes STALE under a concurrent
//     transition or `updateProposal` (`notes.html` #35). This is the verdict
//     that actually gates the write.
// Both calls run the same pure function, so there is no second code path and no
// way to reach `materialize` around it.

/**
 * The synthetic id an INCOMING proposal wears inside the append-time gate
 * (MOTIR-3573). A proposal has no id until `planItemRepository.create` writes
 * one (`PlanItem.id` is `@default(cuid())` and `ProposalInput` carries no id
 * field), so a rejection can only identify it by its POSITION in the batch —
 * which is what the caller sent and can therefore act on.
 */
const INCOMING_PROPOSAL_ID_PREFIX = 'incoming#';

/** Project an unsaved `ProposalInput` onto the gate's shape, by batch position.
 *  Mirrors the `PlanItemUncheckedCreateInput` built below field for field, so
 *  the gate judges exactly what the insert would write. */
function toIncomingProposalNode(p: ProposalInput, index: number): ProposalNode {
  return {
    id: `${INCOMING_PROPOSAL_ID_PREFIX}${index}`,
    op: p.op,
    workItemId: p.op === 'add' ? null : (p.workItemId ?? null),
    parentRef: p.parentRef ?? null,
    blockedByRefs: p.blockedByRefs ?? [],
    supersedesRefs: p.supersedesRefs ?? [],
    proposedFields: (p.proposedFields ?? null) as ProposalNode['proposedFields'],
    patch: (p.patch ?? null) as ProposalNode['patch'],
  };
}

/** Project a Prisma `PlanItem` row onto the gate's minimal proposal shape. */
function toProposalNode(item: PlanItem): ProposalNode {
  return {
    id: item.id,
    op: item.op,
    workItemId: item.workItemId,
    parentRef: item.parentRef,
    blockedByRefs: item.blockedByRefs,
    supersedesRefs: item.supersedesRefs ?? [],
    proposedFields: (item.proposedFields ?? null) as ProposalNode['proposedFields'],
    patch: (item.patch ?? null) as ProposalNode['patch'],
  };
}

/**
 * Run the gate over a proposal set: resolve every REAL work item the plan
 * references in ONE batched, workspace-scoped read, then ask the pure
 * validator. Throws a typed rejection; writes nothing.
 */
async function runPersistGate(
  items: PlanItem[],
  ctx: ServiceContext,
  terminalStatusKeys: ReadonlySet<string>,
  planProjectId: string,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const nodes = items.map(toProposalNode);
  // Bound when the caller holds no transaction (MOTIR-2846) — pass 1 runs before
  // the approve transaction opens. Unbound, every referenced work item read as
  // absent and the gate rejected the plan with `PlanRefGraphError` for parents
  // that exist.
  //
  // ⚠️ WHEN A `tx` IS GIVEN IT MUST HAVE THE PROJECT NARROWING LIFTED, and the
  // caller that passes one does that (`assertProposalsPersistable`). This read
  // asks a WORKSPACE question — "does this id name a work item in this
  // workspace?" — and `withWorkspaceContext` binds `app.project_id`, which
  // `work_item_project_narrow` reads. See MOTIR-3581 and the suspension's own
  // comment; without it the two passes of this one gate disagree about what
  // exists, and the stricter one decides.
  const referenced = collectReferencedWorkItemIds(nodes);
  const rows = tx
    ? await workItemRepository.findByIdsInWorkspace(referenced, ctx.workspaceId, tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, (t) =>
        workItemRepository.findByIdsInWorkspace(referenced, ctx.workspaceId, t),
      );
  const liveById = new Map<string, LiveWorkItemState>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        // The identity a REFUSAL names (MOTIR-3936). Already on the row this read
        // returns, so naming the card costs nothing beyond carrying two columns.
        key: r.identifier,
        title: r.title,
        kind: r.kind,
        status: r.status,
        projectId: r.projectId,
      },
    ]),
  );
  // The ANCESTOR CHAINS the re-parent gate needs (MOTIR-3859) — one batched
  // recursive read, and only when some `modify` actually proposes a new parent,
  // so a plan that re-parents nothing costs exactly what it cost before. Bound
  // the same way the row read above is, for the same reason.
  const ancestorIdsById = await resolveReparentAncestors(nodes, ctx, tx);
  // The COMMITTED `is_blocked_by` edges the plan's own edges join onto
  // (MOTIR-3936) — skipped entirely when the plan writes no edge, so a plan that
  // wires nothing costs exactly what it cost before.
  const existingBlockedByEdges = await resolveBlockedByClosure(nodes, ctx, tx);
  // The COMMITTED `supersedes` links the plan's supersedes edges join onto
  // (MOTIR-6630) — skipped entirely when the plan draws none.
  const existingSupersedesEdges = await resolveSupersedesClosure(nodes, ctx, tx);
  // The FOLDERS its `folder:` placements name (MOTIR-5414) — skipped entirely
  // when the plan files nothing. Bound the same way the row read above is.
  const folderById = await resolveFolderById(nodes, ctx, tx);
  // The COMMITTED ancestor chains the same-level check places live ends with
  // (MOTIR-6411) — one batched read, skipped when the plan writes no edge.
  const edgeAncestorsById = await resolveEdgeAncestors(nodes, ctx, tx);
  // The live status CATEGORY of every target a `modify` MARKS (MOTIR-6663), in
  // the target's own project's workflow — skipped entirely when no proposal sets
  // a mark, so a plan that marks nothing costs exactly what it cost before.
  const markTargetIds = new Set(
    nodes
      .filter((n) => n.op === 'modify' && n.workItemId && patchSetsObsolescence(n.patch))
      .map((n) => n.workItemId!),
  );
  const markTargetStatusCategoryById = await resolveStatusCategories(
    rows.filter((r) => markTargetIds.has(r.id)),
    ctx,
    tx,
  );
  // The committed tree around every target a `modify` RE-KINDS (bug MOTIR-8192)
  // — skipped entirely when no proposal re-kinds, so a plan that changes no kind
  // costs exactly what it cost before.
  const kindChangeContextById = await resolveKindChangeContexts(nodes, rows, ctx, tx);
  validatePlanProposals({
    items: nodes,
    liveById,
    terminalStatusKeys,
    planProjectId,
    ancestorIdsById,
    existingBlockedByEdges,
    existingSupersedesEdges,
    markTargetStatusCategoryById,
    folderById,
    edgeAncestorsById,
    kindChangeContextById,
  });
}

/**
 * The committed tree around every target a `modify` in `nodes` RE-KINDS (bug
 * MOTIR-8192 · AMENDMENT 25) — its parent's kind, its folder filing, its leaf
 * fields and its live children — in at most two batched reads, both skipped
 * when no proposal carries `patch.kind`. `rows` are the live rows the caller
 * already read for the plan's referenced ids; a target missing from them is left
 * to `materialize`, as every other live-row question is.
 *
 * With a `tx`, the reads run on it (the caller holds the workspace GUC and has
 * lifted the project narrowing); without one they open their own workspace
 * context, as `runPersistGate`'s pre-transaction pass does.
 */
async function resolveKindChangeContexts(
  nodes: readonly ProposalNode[],
  rows: readonly WorkItem[],
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<Map<string, KindChangeContext>> {
  const out = new Map<string, KindChangeContext>();
  const targetIds = new Set(
    nodes
      .filter((n) => n.op === 'modify' && n.workItemId && n.patch?.kind !== undefined)
      .map((n) => n.workItemId!),
  );
  if (targetIds.size === 0) return out;
  const targets = rows.filter((r) => targetIds.has(r.id));
  if (targets.length === 0) return out;
  const parentIds = [
    ...new Set(targets.map((t) => t.parentId).filter((id): id is string => id !== null)),
  ];
  const read = async (t: Prisma.TransactionClient) => ({
    parents: await workItemRepository.findByIdsInWorkspace(parentIds, ctx.workspaceId, t),
    children: await workItemRepository.findChildKindsForItems(
      targets.map((r) => r.id),
      ctx.workspaceId,
      t,
    ),
  });
  const { parents, children } = tx
    ? await read(tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, read);
  const parentKindById = new Map(parents.map((p) => [p.id, p.kind as string]));
  for (const target of targets) {
    out.set(target.id, {
      parentId: target.parentId,
      parentKind: target.parentId ? (parentKindById.get(target.parentId) ?? null) : null,
      filed: target.folderId !== null,
      type: target.type,
      difficulty: target.difficulty,
      children: children
        .filter((c) => c.parentId === target.id)
        .map((c) => ({ id: c.id, key: c.identifier, title: c.title, kind: c.kind })),
    });
  }
  return out;
}

/**
 * Run the RE-KIND gate over a proposal set at the APPEND (bug MOTIR-8192 ·
 * AMENDMENT 25) — the same `assertKindChangesLegal` the approve path runs, given
 * the same context, so a re-kind admitted here cannot be refused there for a
 * reason the author could have been told while the plan was still theirs.
 *
 * The whole batch is judged, INCLUDING the proposals already on the plan, for
 * the reason `assertReparentsLegalAtAppend` gives: a re-kind is a question about
 * the projected tree, and the plan's other proposals are part of it. Skipped
 * with no read when nothing in `nodes` re-kinds. The project narrowing is lifted
 * for the reason that function lifts it.
 */
async function assertKindChangesLegalAtAppend(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!nodes.some((n) => n.op === 'modify' && n.patch?.kind !== undefined)) return;
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const rows = await workItemRepository.findByIdsInWorkspace(
      collectReferencedWorkItemIds(nodes),
      ctx.workspaceId,
      tx,
    );
    const liveById = new Map<string, LiveWorkItemState>(rows.map((r) => [r.id, toLiveState(r)]));
    const contexts = await resolveKindChangeContexts(nodes, rows, ctx, tx);
    assertKindChangesLegal(nodes, liveById, contexts);
  });
}

/**
 * Hold an `add` whose KIND an edit just changed to the rules a new kind owes
 * (bug MOTIR-8192 · AMENDMENT 25 §4) — at the correction and at every
 * `editAddProposal` mode, the doors that can re-kind a proposed card:
 *
 *   - a CONTAINER keeps no `type` / `executor` — refused by name, the same
 *     refusal-not-clear rule a `modify` follows (`assertReKindedAddKeepsNoLeafFields`;
 *     `todos` and `difficulty` were already refused on the merged kind);
 *   - its PARENT admits the new kind, and the new kind admits every proposal
 *     the plan hangs under it (`assertAddKindPlacementLegal`).
 *
 * Run UNCONDITIONALLY when the edit supplies a kind — not left to the close's
 * before/after verdict, which admits a write to a plan that was already
 * unapprovable — because an illegal kind is a mistake this write introduces.
 * `nodes` is the plan's proposal set WITH the edited `add` already merged.
 */
async function assertReKindedAddLegal(
  addId: string,
  merged: PlanItemProposedFields,
  nodes: readonly ProposalNode[],
  label: string,
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  assertReKindedAddKeepsNoLeafFields(merged.kind ?? DEFAULT_PROPOSED_KIND, merged, label);
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const rows = await workItemRepository.findByIdsInWorkspace(
      collectReferencedWorkItemIds(nodes),
      ctx.workspaceId,
      tx,
    );
    assertAddKindPlacementLegal(addId, nodes, new Map(rows.map((r) => [r.id, toLiveState(r)])));
  });
}

/** A live row in the shape the plan gate reads. */
function toLiveState(r: WorkItem): LiveWorkItemState {
  return {
    id: r.id,
    key: r.identifier,
    title: r.title,
    kind: r.kind,
    status: r.status,
    projectId: r.projectId,
  };
}

/**
 * The workflow-status CATEGORY of each row's status, by row id, read against the
 * row's OWN project's workflow (MOTIR-6663) — the question the finished-target
 * rule asks, answered per project because every project defines its own
 * statuses. One batched read over the rows' projects; none when `rows` is empty.
 * A row whose status key its workflow does not define is absent from the map,
 * which the rule reads as not finished.
 *
 * With a `tx`, the read runs on it (the caller holds the workspace GUC, and
 * lifts the project narrowing where the targets may sit in another project);
 * without one it opens its own workspace context, as `runPersistGate`'s
 * pre-transaction pass does.
 */
async function resolveStatusCategories(
  rows: ReadonlyArray<{ id: string; projectId: string; status: string }>,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<Map<string, StatusCategoryDto>> {
  const out = new Map<string, StatusCategoryDto>();
  if (rows.length === 0) return out;
  const byProject = await workflowsService.getStatusKeysByCategoryByProjects(
    rows.map((r) => r.projectId),
    ctx.workspaceId,
    tx,
  );
  for (const r of rows) {
    const groups = byProject.get(r.projectId);
    if (!groups) continue;
    for (const category of Object.keys(groups) as StatusCategoryDto[]) {
      if (groups[category].includes(r.status)) {
        out.set(r.id, category);
        break;
      }
    }
  }
  return out;
}

/**
 * The committed ancestor chain of every live work item a plan's edges or
 * placements name — the positions the same-level check reads (MOTIR-6411,
 * `docs/decisions/edge-level-is-position.md`). One batched recursive read, and
 * none for a plan that writes no `blocked_by`.
 *
 * ⚠️ A `tx`, when given, must already have the project narrowing lifted, for
 * the reason the row read in `runPersistGate` states: an edge may cross projects.
 */
async function resolveEdgeAncestors(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const writesEdge = nodes.some(
    (n) =>
      (n.op === 'add' && n.blockedByRefs.length > 0) ||
      (n.op === 'modify' && (n.patch?.blockedByAdd?.length ?? 0) > 0),
  );
  if (!writesEdge) return new Map();
  const ids = [
    ...new Set([
      ...collectReferencedWorkItemIds(nodes),
      ...nodes.filter((n) => n.op === 'modify' && n.workItemId).map((n) => n.workItemId!),
    ]),
  ];
  if (ids.length === 0) return new Map();
  return tx
    ? await workItemRepository.findAncestorIdsForItems(ids, ctx.workspaceId, tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, (t) =>
        workItemRepository.findAncestorIdsForItems(ids, ctx.workspaceId, t),
      );
}

/**
 * The live state of every folder a plan's `folder:<id>` placements name
 * (MOTIR-5414), in one workspace-scoped read. An empty map, with no read, when
 * the plan files nothing.
 *
 * ⚠️ A `tx` MUST ALREADY HAVE THE PROJECT NARROWING LIFTED, for the reason the
 * work-item read beside it does: `folder_project_narrow` is a RESTRICTIVE select
 * policy, and a narrowed read reports another project's folder as MISSING — a
 * refusal whose stated reason the caller can observe to be false.
 */
async function resolveFolderById(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<Map<string, LiveFolderState>> {
  const ids = collectReferencedFolderIds(nodes);
  if (ids.length === 0) return new Map();
  const rows = tx
    ? await folderRepository.findPlacementStateByIds(ids, ctx.workspaceId, tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, (t) =>
        folderRepository.findPlacementStateByIds(ids, ctx.workspaceId, t),
      );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The transitive `is_blocked_by` closure DOWNSTREAM of every endpoint the plan's
 * own edges touch (MOTIR-3936) — the committed half of the graph
 * `assertBlockedByGraphAcyclic` walks.
 *
 * ⚠️ THE SAME WALK `enforce_work_item_link_no_cycle` DOES, taken breadth-first
 * in one query per level instead of one recursive CTE. The trigger follows
 * `is_blocked_by` forward from a new edge's far end and rejects when the chain
 * returns to its near end; this collects exactly the edges that walk can reach,
 * so the close and the trigger cannot disagree about what a cycle is. Seeded
 * from BOTH ends of every proposed edge, because the plan may add several edges
 * at once and the ring can run through any of them.
 *
 * Bounded at {@link BLOCKED_BY_CLOSURE_MAX_LEVELS} levels, well inside the
 * trigger's own `lvl < 1000` cap: a dependency chain that deep is not a shape
 * this product produces, and an unbounded walk on a pathological graph would
 * hold the close open. Stopping early can only MISS a cycle — never invent one —
 * and the trigger stays the backstop for the case it misses.
 */
const BLOCKED_BY_CLOSURE_MAX_LEVELS = 32;

async function resolveBlockedByClosure(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<Array<{ blockedId: string; blockerId: string }>> {
  const seeds = new Set<string>();
  const addSeed = (ref: string | null | undefined): void => {
    if (ref && !isTempRef(ref)) seeds.add(ref);
  };
  for (const node of nodes) {
    if (node.op === 'add') {
      for (const ref of node.blockedByRefs) addSeed(ref);
      continue;
    }
    if (node.op !== 'modify' || !node.workItemId) continue;
    const edges = [...(node.patch?.blockedByAdd ?? []), ...(node.patch?.blockedByRemove ?? [])];
    if (edges.length === 0) continue;
    addSeed(node.workItemId);
    for (const ref of edges) addSeed(ref);
  }
  if (seeds.size === 0) return [];

  const read = (ids: string[]): Promise<Array<{ blockedId: string; blockerId: string }>> =>
    tx
      ? workItemLinkRepository.findBlockedByEdges(ids, tx)
      : withWorkspaceServiceContext(ctx.workspaceId, (t) =>
          workItemLinkRepository.findBlockedByEdges(ids, t),
        );

  const collected: Array<{ blockedId: string; blockerId: string }> = [];
  const walked = new Set<string>();
  let frontier = [...seeds];
  for (let level = 0; level < BLOCKED_BY_CLOSURE_MAX_LEVELS && frontier.length > 0; level += 1) {
    for (const id of frontier) walked.add(id);
    const edges = await read(frontier);
    collected.push(...edges);
    frontier = [...new Set(edges.map((e) => e.blockerId))].filter((id) => !walked.has(id));
  }
  return collected;
}

/**
 * The transitive `supersedes` closure DOWNSTREAM (newer → older) of every
 * endpoint the plan's supersedes edges touch (Story MOTIR-6577 · MOTIR-6630) —
 * what `assertSupersedesGraphAcyclic` walks the plan's own edges over. The
 * twin of {@link resolveBlockedByClosure}, one batched read per level and the
 * same level bound; no read at all for a plan that draws no supersedes edge.
 *
 * ⚠️ A `tx`, when given, must already have the project narrowing lifted, for the
 * reason the row read in `runPersistGate` states: an edge may cross projects.
 */
async function resolveSupersedesClosure(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<SupersedesEdge[]> {
  const seeds = new Set<string>();
  const addSeed = (ref: string | null | undefined): void => {
    if (ref && !isTempRef(ref)) seeds.add(ref);
  };
  for (const node of nodes) {
    if (node.op === 'add') {
      for (const ref of node.supersedesRefs ?? []) addSeed(ref);
      continue;
    }
    if (node.op !== 'modify' || !node.workItemId) continue;
    const edges = SUPERSEDES_PATCH_SITES.flatMap((key) => node.patch?.[key] ?? []);
    if (edges.length === 0) continue;
    addSeed(node.workItemId);
    for (const ref of edges) addSeed(ref);
  }
  if (seeds.size === 0) return [];

  const read = (ids: string[]): Promise<SupersedesEdge[]> =>
    tx
      ? workItemLinkRepository.findSupersedesEdges(ids, tx)
      : withWorkspaceServiceContext(ctx.workspaceId, (t) =>
          workItemLinkRepository.findSupersedesEdges(ids, t),
        );

  const collected: SupersedesEdge[] = [];
  const walked = new Set<string>();
  let frontier = [...seeds];
  for (let level = 0; level < BLOCKED_BY_CLOSURE_MAX_LEVELS && frontier.length > 0; level += 1) {
    for (const id of frontier) walked.add(id);
    const edges = await read(frontier);
    collected.push(...edges);
    frontier = [...new Set(edges.map((e) => e.toId))].filter((id) => !walked.has(id));
  }
  return collected;
}

/**
 * Refuse a `supersedes` CYCLE at the APPEND (MOTIR-6630), where the edge is
 * written — the database never will, and nothing a later call does can make a
 * ring legal. One closure read, skipped when the batch draws no supersedes edge;
 * judged over the plan's whole effective node set, because a ring can be closed
 * by the proposal being added against one appended earlier.
 *
 * Suspended project narrowing, for the reason `resolveSupersedesClosure` states.
 */
async function assertSupersedesAcyclicAtAppend(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const drawsEdge = nodes.some(
    (n) =>
      (n.op === 'add' && (n.supersedesRefs?.length ?? 0) > 0) ||
      (n.op === 'modify' &&
        ((n.patch?.supersedesAdd?.length ?? 0) > 0 || (n.patch?.supersededByAdd?.length ?? 0) > 0)),
  );
  if (!drawsEdge) return;
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const existing = await resolveSupersedesClosure(nodes, ctx, tx);
    const ids = collectReferencedWorkItemIds(nodes);
    const rows =
      ids.length === 0
        ? []
        : await workItemRepository.findByIdsInWorkspace(ids, ctx.workspaceId, tx);
    const liveById = new Map<string, LiveWorkItemState>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          key: r.identifier,
          title: r.title,
          kind: r.kind,
          status: r.status,
          projectId: r.projectId,
        },
      ]),
    );
    assertSupersedesGraphAcyclic(nodes, liveById, existing);
  });
}

/**
 * Refuse a `blocked_by` CYCLE where the edge is WRITTEN, on a `generating` plan
 * (MOTIR-9267) — the close's own walk (`assertBlockedByGraphAcyclic`), so the
 * error and the ring it names are the ones `markPlanned` returns.
 *
 * Here rather than left to the close because a planner schedules its author
 * sessions by these edges WHILE the plan is still generating: a ring that waits
 * for the close is one the scheduler can only break by authoring a card as if
 * one of its edges were absent. Refused at the write, the session that drew the
 * edge is the one told, and it chooses the order. A ring can never become legal
 * later, so nothing is lost by refusing it early. Runs only when one of
 * `subjectIds` — the proposals this write changes — draws a `blocked_by` edge;
 * one closure read then, none otherwise.
 */
async function assertBlockedByAcyclicAtAppend(
  nodes: readonly ProposalNode[],
  subjectIds: ReadonlySet<string>,
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const drawsEdge = nodes.some(
    (n) =>
      subjectIds.has(n.id) &&
      ((n.op === 'add' && n.blockedByRefs.length > 0) ||
        (n.op === 'modify' && (n.patch?.blockedByAdd?.length ?? 0) > 0)),
  );
  if (!drawsEdge) return;
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const existing = await resolveBlockedByClosure(nodes, ctx, tx);
    const ids = collectReferencedWorkItemIds(nodes);
    const rows =
      ids.length === 0
        ? []
        : await workItemRepository.findByIdsInWorkspace(ids, ctx.workspaceId, tx);
    const liveById = new Map<string, LiveWorkItemState>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          key: r.identifier,
          title: r.title,
          kind: r.kind,
          status: r.status,
          projectId: r.projectId,
        },
      ]),
    );
    assertBlockedByGraphAcyclic(nodes, liveById, existing);
  });
}

// ── THE CORRECTION DOORS MAY NOT BREAK A PLAN (MOTIR-3936) ───────────────────
//
// `markPlanned` gates the CLOSE, which is what makes `planned` mean approvable.
// AMENDMENT 8 then opened two doors onto a `planned` plan — `correctProposal`
// and `withdrawProposal` — and neither re-asks the question the close answered.
// So the invariant the close establishes survives exactly until the first
// correction, which is how a plan reached a reviewer carrying a
// `patch.blockedByRemove` naming no work item: the plan closed clean and the ref
// was written afterwards.
//
// ⚠️ IT IS A "DO NOT MAKE IT WORSE" CHECK, NOT A "MUST BE PERFECT" ONE, and the
// difference is the whole design. A plan that is ALREADY unapprovable — one
// closed before this gate existed, or invalidated by the tree moving — is
// precisely the plan somebody is reaching for a correction to REPAIR. Refusing
// the repair because the plan is still broken mid-repair would lock the author
// out of the only tool that fixes it, and a multi-edge correction is repaired
// one call at a time by construction. So the gate compares BEFORE with AFTER and
// refuses only a write that turns a passing plan into a failing one.

/** Run the persist gate over a set and report the rejection, rather than throw. */
async function persistGateVerdict(
  items: PlanItem[],
  ctx: ServiceContext,
  terminalStatusKeys: ReadonlySet<string>,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<unknown | null> {
  try {
    await runPersistGate(items, ctx, terminalStatusKeys, planProjectId, tx);
    return null;
  } catch (err) {
    if (
      err instanceof PlanRefGraphError ||
      err instanceof PlanGrammarError ||
      err instanceof PlanTargetImmutableError ||
      // The gate's mark-on-an-unfinished-target refusal (MOTIR-6663) — a verdict
      // about the plan, like the three above, never a fault.
      err instanceof InvalidProposalError
    ) {
      return err;
    }
    // Anything else is a real failure — a lost connection, a bug — and a gate
    // that swallowed it would report "unchanged" for a plan it never checked.
    throw err;
  }
}

/**
 * Assert a correction did not turn an approvable plan into one approve will
 * refuse. Called INSIDE the correction's own transaction, after the write, so a
 * refusal rolls the write back and the proposal is left exactly as it was.
 *
 * Both passes run with the project narrowing SUSPENDED, for the reason
 * `assertProposalsPersistable` documents: the gate asks a WORKSPACE question,
 * and a cross-project `blocked_by` is legal.
 */
async function assertCorrectionKeepsPlanApprovable(
  before: PlanItem[],
  after: PlanItem[],
  ctx: ServiceContext,
  terminalStatusKeys: ReadonlySet<string>,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const afterRejection = await persistGateVerdict(
      after,
      ctx,
      terminalStatusKeys,
      planProjectId,
      tx,
    );
    if (!afterRejection) return;
    const beforeRejection = await persistGateVerdict(
      before,
      ctx,
      terminalStatusKeys,
      planProjectId,
      tx,
    );
    // The plan was already unapprovable — this write is (or is part of) the
    // repair, and refusing it would leave nobody able to make one.
    if (beforeRejection) return;
    throw afterRejection;
  });
}

/**
 * Every real work-item id whose ancestor chain the re-parent gate reads: each
 * live row a `modify` proposes as a NEW parent, and — for a `modify` moving
 * under a proposed `add` (AMENDMENT 18 §1, MOTIR-6050) — the committed ANCHOR
 * that `add`'s chain is created under.
 */
function proposedParentIds(nodes: readonly ProposalNode[]): string[] {
  return [
    ...new Set([
      ...nodes
        .filter((n) => n.op === 'modify')
        .map((n) => n.patch?.parentRef)
        .filter(
          (ref): ref is string => typeof ref === 'string' && !isTempRef(ref) && !isFolderRef(ref),
        ),
      ...proposedParentAnchorIds(nodes),
    ]),
  ];
}

/** True when some `modify` in `nodes` carries a `patch.parentRef` the gate must judge. */
function anyReparent(nodes: readonly ProposalNode[]): boolean {
  return nodes.some((n) => n.op === 'modify' && typeof n.patch?.parentRef === 'string');
}

/**
 * The `parentId → … → root` chain of every proposed new parent (MOTIR-3859), as
 * `assertReparentLegal` reads it. Empty map when nothing re-parents — the read is
 * skipped entirely, which is what keeps the re-parent gate free on the plans that
 * do not use it.
 */
async function resolveReparentAncestors(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const parentIds = proposedParentIds(nodes);
  if (parentIds.length === 0) return new Map();
  return tx
    ? await workItemRepository.findAncestorIdsForItems(parentIds, ctx.workspaceId, tx)
    : await withWorkspaceServiceContext(ctx.workspaceId, (t) =>
        workItemRepository.findAncestorIdsForItems(parentIds, ctx.workspaceId, t),
      );
}

/**
 * The in-transaction half of the gate: LOCK every `modify`/`remove` target
 * (`SELECT … FOR UPDATE`) before re-reading it, so the immutability verdict is
 * taken against state a concurrent transition can no longer move (`notes.html`
 * #35 — a count/status read before the transaction is not a guarantee). Locks
 * are taken in a stable id order so two approves touching the same items queue
 * instead of deadlocking. Runs BEFORE `materialize` writes anything, so a
 * rejection leaves the tree byte-identical.
 *
 * ⚠️ THE LOCKS AND THE READ RUN WITH THE PROJECT NARROWING SUSPENDED (MOTIR-3581),
 * and the two must move together. `withWorkspaceContext` binds `app.project_id`
 * and `work_item_project_narrow` is a RESTRICTIVE FOR SELECT policy, so a
 * cross-project row is invisible to BOTH the `SELECT … FOR UPDATE` and the
 * resolution read — the lock returns no row and RAISES NOTHING, and the ref then
 * resolves to nothing. Approve therefore refused every plan carrying a legal
 * cross-project `blocked_by` with `dangling`, saying the ref "names no work item
 * in this workspace" while the item sat one project over.
 *
 * ⚠️ AND THE FIX IS DELIBERATELY *NOT* "carry pass 1's resolved map in here".
 * That reads as the smaller change and it is the wrong one: `liveById` is what
 * step 4 takes the DONE-WORK IMMUTABILITY verdict from, and that verdict is the
 * entire reason this pass exists under the row locks (`notes.html` #35). Reusing
 * a pre-transaction snapshot would move it back outside them — re-opening the
 * race `PlanTargetImmutableError` was added to close — to fix a visibility bug
 * that has nothing to do with staleness. The narrowing is what was wrong, so the
 * narrowing is what is lifted: this pass still reads FRESH state, under the
 * locks, and now simply sees the same workspace pass 1 does.
 */
async function assertProposalsPersistable(
  items: PlanItem[],
  ctx: ServiceContext,
  terminalStatusKeys: ReadonlySet<string>,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const targetIds = [
    ...new Set(
      items.filter((i) => i.op !== 'add' && i.workItemId != null).map((i) => i.workItemId!),
    ),
  ].sort();
  // The FOLDERS the plan files into (MOTIR-5423) are locked too, so the gate's
  // "does this folder still exist, in this project?" verdict holds until
  // materialize writes: `foldersService.deleteFolder` locks the same row, and a
  // delete racing the approve now queues behind it instead of landing between
  // the check and the insert. Sorted, like the work-item locks, so two approves
  // filing into the same folders cannot deadlock.
  const folderIds = [...collectReferencedFolderIds(items.map(toProposalNode))].sort();
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    for (const id of targetIds) await workItemRepository.lockById(id, tx);
    for (const id of folderIds) await folderRepository.lockById(id, tx);
    await runPersistGate(items, ctx, terminalStatusKeys, planProjectId, tx);
  });
}

/**
 * Resolve a proposal's `folder:<id>` placement at materialize (Story MOTIR-5310 ·
 * MOTIR-5423): lock the folder row and return its id.
 *
 * The approve gate has already refused a folder that was deleted or moved to
 * another project since the append, under the lock `assertProposalsPersistable`
 * takes — so a miss here is the defensive backstop, and it raises the SAME typed
 * refusal the gate does (`INVALID_PLAN_REF_GRAPH` / `dangling`, naming the ref
 * and the proposal), never a raw foreign-key error mid-approve.
 */
async function lockPlacementFolder(
  item: PlanItem,
  ref: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const id = folderRefId(ref);
  const locked = await folderRepository.lockById(id, tx);
  if (!locked) {
    throw new PlanRefGraphError(
      'dangling',
      item.id,
      `${proposalLabel({ op: item.op, workItemId: item.workItemId, title: (item.proposedFields as PlanItemProposedFields | null)?.title })}: ` +
        `"${ref}" names no folder in this workspace — the folder was deleted after the plan was written.`,
    );
  }
  return locked.id;
}

// ── The proposed REPO PIN, resolved before the transaction (MOTIR-1884) ───────
//
// A project's repository SET is sized by its architecture (MOTIR-1780), so
// `resolveDispatchRepo`'s "the single repo" default stops answering the moment a
// project has two: an item with no pin resolves to `null` and no agent is told
// where to build. The planner therefore pins each proposed item (motir-ai,
// MOTIR-1885) and the pin rides `proposedFields` / `patch` to here.
//
// It is resolved OUTSIDE the approve transaction, for the reason
// `lib/workItems/targetRepo.ts` documents and the direct-write path already
// obeys: the domain read opens its OWN workspace context (the
// `project_repository` / `github_repo` RLS policies are workspace-keyed) and
// Prisma cannot nest interactive transactions. Resolving first also means an
// unknown repo is rejected while the tree is still byte-identical — the same
// property the confirmation gate's pre-transaction pass has.

/** Each PlanItem's RESOLVED pin, keyed by plan-item id. A key is present only
 *  when that proposal actually carried a `targetRepo`, so an `add` with no pin
 *  and a `modify` that doesn't touch the pin are indistinguishable from the
 *  pre-MOTIR-1884 behaviour (absent ≠ explicit null). */
type ResolvedRepoPins = ReadonlyMap<string, string | null>;

/**
 * The project's repository rows, keyed the two ways a PROPOSAL can name one
 * (Story MOTIR-2732 · MOTIR-3033).
 *
 * A proposal pins either a settled NAME (`project-repository-set.md` §5.4) or a
 * portable ROLE (§5.2). Both have to become the same thing — a reference to the
 * `project_repository` row — so both lookups are built once, before the
 * transaction, from one read.
 *
 * The ROLE map holds ONLY roles carried by exactly ONE row. §5.3 is explicit that
 * a repeated role resolves to nothing rather than to an arbitrary pick, counted
 * over rows in ANY state so the verdict is a property of the SET and not of which
 * row was established first. A role with two rows is therefore simply absent here,
 * and the item lands unrouted — the honest answer, and the one the reference model
 * makes rarer rather than more common (MOTIR-3045 lets a planner pin the ROW).
 */
interface ProposalRepoRefs {
  byName: ReadonlyMap<string, string>;
  byRole: ReadonlyMap<string, string>;
  // Every `project_repository` id this project has (Story MOTIR-2732 · MOTIR-3045,
  // surfaced by MOTIR-4924). The singular row-ref pin IS already the id, so
  // resolving it is a MEMBERSHIP check against this set rather than a lookup — the
  // validation `proposalRepoRef` owes a `targetRepositoryRef` ("the row belongs to
  // this project"), read off the same fresh row set `byName`/`byRole` read.
  byId: ReadonlySet<string>;
}

async function resolveProposalRepoRefs(
  projectId: string,
  ctx: ServiceContext,
): Promise<ProposalRepoRefs> {
  const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');
  const rows = await projectRepoSetService.listByProject(projectId, ctx);
  const byName = new Map<string, string>();
  const roleCounts = new Map<string, number>();
  const byId = new Set<string>();
  for (const row of rows) {
    // The RESOLVED name, same rule as everywhere else (§A4): the realized
    // repository's own once it is realized, else the row's authored intent.
    const name = (row.realizedRepo?.name ?? row.name).trim().toLowerCase();
    if (name.length > 0 && !byName.has(name)) byName.set(name, row.id);
    roleCounts.set(row.role, (roleCounts.get(row.role) ?? 0) + 1);
    byId.add(row.id);
  }
  const byRole = new Map<string, string>();
  for (const row of rows) {
    if (roleCounts.get(row.role) === 1) byRole.set(row.role, row.id);
  }
  return { byName, byRole, byId };
}

/** The reference a single proposal resolves to, or `null` when it names nothing
 *  this project has — a NAME first (it is the settled, unambiguous pin), then a
 *  ROW REFERENCE (the most specific singular pin — it IS the `project_repository`
 *  id, so it needs only validation that the row belongs to this project), then the
 *  ROLE, which is what a plan written before the repositories existed carries. */
function proposalRepoRef(
  pinnedName: string | null,
  repoRef: string | null,
  role: string | null,
  refs: ProposalRepoRefs,
): string | null {
  if (pinnedName !== null) {
    const byName = refs.byName.get(pinnedName.trim().toLowerCase());
    if (byName !== undefined) return byName;
  }
  // A ROW REFERENCE resolves AHEAD of the role (Story MOTIR-2732 · MOTIR-3045,
  // surfaced by MOTIR-4924): a role resolves to NOTHING on a project where two
  // rows share it, and the ref is the one spelling that lifts that ceiling. It is
  // already the id, so this is a membership check against `byId` — the validation
  // that the row belongs to this project — and a ref outside the set lands unrouted
  // and honest, never a guess.
  if (repoRef !== null) return refs.byId.has(repoRef) ? repoRef : null;
  if (role !== null) return refs.byRole.get(role) ?? null;
  return null;
}

/** The authored `targetRepo` a proposal carries, or `undefined` when it carries
 *  none (an `add` without the field, a `modify` whose patch omits it). */
function authoredTargetRepo(item: PlanItem): string | null | undefined {
  if (item.op === 'add') {
    return ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.targetRepo;
  }
  if (item.op === 'modify') {
    return ((item.patch ?? null) as PlanItemPatch | null)?.targetRepo;
  }
  return undefined;
}

// ── The proposed REPOSITORY SET (bug MOTIR-4904) ──────────────────────────────
//
// The pin above is the axis's SINGULAR spelling and is left exactly as it was. A
// proposal may now describe the same axis as an ordered SET, by NAME
// (`targetRepos`) or by `project_repository` ROW ID (`targetRepositories`) — the
// two forms `create_work_item` has accepted since Story MOTIR-2725 and that no
// plan-authoring door carried, so a card that legitimately ships in two
// repositories could not be PROPOSED at all.
//
// The three spellings are MUTUALLY EXCLUSIVE at the append, which is what makes
// this a second, disjoint branch rather than a precedence rule: for any one
// proposal at most one of the three resolvers below runs.
//
// Resolved OUTSIDE the approve transaction, for the same three reasons the
// singular pin is (the domain read opens its own workspace context, Prisma cannot
// nest interactive transactions, and an unknown repository is better refused while
// the tree is still byte-identical) — and through the DIRECT PATH'S OWN
// resolvers, so a set proposed here and a set written by `create_work_item` are
// validated by the same code against the same domain.

/** The SET spelling a proposal authors, or `undefined` when it authors none. */
type AuthoredRepoSet =
  | { form: 'targetRepos'; value: readonly string[] }
  | { form: 'targetRepositories'; value: readonly string[] };

function authoredRepoSet(item: PlanItem): AuthoredRepoSet | undefined {
  const fields =
    item.op === 'add'
      ? ((item.proposedFields ?? null) as PlanItemProposedFields | null)
      : item.op === 'modify'
        ? ((item.patch ?? null) as PlanItemPatch | null)
        : null;
  if (fields === null) return undefined;
  if (fields.targetRepositories !== undefined) {
    return { form: 'targetRepositories', value: fields.targetRepositories };
  }
  if (fields.targetRepos !== undefined) return { form: 'targetRepos', value: fields.targetRepos };
  return undefined;
}

/** Each proposal's RESOLVED repository set — the `{ refs, names }` pair the
 *  direct write path produces — keyed by plan-item id, and present ONLY for a
 *  proposal that authored one of the two SET forms. */
type ResolvedRepoSets = ReadonlyMap<string, ResolvedRepoSet>;

/**
 * Normalize + VALIDATE every proposed repository SET against the PROJECT's
 * repository domain, BEFORE the approve transaction opens — the SET twin of
 * {@link resolveProposedTargetRepos}.
 *
 * Both resolvers are the direct path's (`resolveAuthoredRepoPinsInProject` for
 * names, `resolveAuthoredRepoRefsInProject` for row ids), so the `owner/name`
 * form, the case-insensitive match, the stored casing, the duplicate collapse,
 * the all-or-nothing refusal and the project-vs-workspace scope ladder behave
 * identically however the set arrived. An unknown member becomes a
 * `PlanItemUnknownTargetRepoError` naming the offending PROPOSAL — a reviewer of
 * a hundred-item plan needs to know which one.
 *
 * NOT memoized, unlike the singular resolver: a set is a list, two proposals
 * rarely author the same one, and the key would be the whole list.
 */
async function resolveProposedRepoSets(
  items: PlanItem[],
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedRepoSets> {
  const resolved = new Map<string, ResolvedRepoSet>();
  for (const item of items) {
    const authored = authoredRepoSet(item);
    if (authored === undefined) continue;
    try {
      resolved.set(
        item.id,
        authored.form === 'targetRepositories'
          ? await resolveAuthoredRepoRefsInProject(authored.value, projectId, ctx)
          : await resolveAuthoredRepoPinsInProject(authored.value, projectId, ctx),
      );
    } catch (err) {
      if (err instanceof UnknownTargetRepoError || err instanceof UnknownProjectRepoRefError) {
        throw new PlanItemUnknownTargetRepoError(
          item.id,
          authored.value.join(', '),
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  }
  return resolved;
}

/**
 * Normalize + VALIDATE every proposed pin against the PROJECT's repository set,
 * BEFORE the approve transaction opens. Returns the value each proposal
 * materializes (`null` = explicitly unpinned).
 *
 * Validation is `resolveAuthoredTargetRepoInProject` — the SAME resolver the
 * direct work-item write path calls, so the `owner/name` and bare-name forms, the
 * case-insensitive match, the stored casing, and the project-vs-workspace scope
 * ladder behave identically however the pin arrived. That also means a pin to a
 * set row that is still `proposed` is ACCEPTED (the pin domain is every row, not
 * just the established ones): the plan names repositories before it creates them,
 * so recording that intent is ordinary. What is still caught is the typo and the
 * SIBLING project's repo.
 *
 * An unknown name becomes a `PlanItemUnknownTargetRepoError` naming the offending
 * PROPOSAL — the reviewer of a hundred-item plan needs to know which one, and the
 * underlying message (which lists the project's repositories) rides along.
 *
 * Resolutions are memoized per authored spelling: a plan pins many items to the
 * same few repos, and the domain read is per-call. A plan carrying NO pins does
 * no reads at all.
 */
async function resolveProposedTargetRepos(
  items: PlanItem[],
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedRepoPins> {
  const resolved = new Map<string, string | null>();
  const memo = new Map<string, string | null>();

  for (const item of items) {
    const authored = authoredTargetRepo(item);
    if (authored === undefined) continue;
    const cacheKey = authored ?? '';
    if (!memo.has(cacheKey)) {
      try {
        memo.set(cacheKey, await resolveAuthoredTargetRepoInProject(authored, projectId, ctx));
      } catch (err) {
        if (err instanceof UnknownTargetRepoError) {
          throw new PlanItemUnknownTargetRepoError(item.id, authored ?? '', err.message);
        }
        throw err;
      }
    }
    resolved.set(item.id, memo.get(cacheKey)!);
  }
  return resolved;
}

/**
 * The `targetRepo` spelling each proposal AUTHORS, keyed by proposal id — the
 * PURE half of {@link resolveProposedTargetRepos}, which is what makes the
 * in-transaction re-check affordable (MOTIR-3604).
 *
 * A proposal carrying NO pin is ABSENT from the map rather than present as
 * `null`: the two mean different things on a `modify` (leave the column alone vs
 * clear it), and collapsing them here would make an approve refuse a `modify`
 * whose patch never mentioned the repo at all.
 */
function collectAuthoredTargetRepos(items: PlanItem[]): Map<string, string | null> {
  const authored = new Map<string, string | null>();
  for (const item of items) {
    const value = authoredTargetRepo(item);
    if (value !== undefined) authored.set(item.id, value);
  }
  return authored;
}

/** A single resolved reference as the one-element list it means — `null` (the
 *  proposal named nothing this project has) is the EMPTY set, not a member. */
function refsOf(ref: string | null): string[] {
  return ref === null ? [] : [ref];
}

/** Two ordered repository-name sets, compared as the ORDERED things they are —
 *  element 0 is the primary, so a re-order is a change and not a no-op. The same
 *  predicate `workItemsService` applies to the same column. */
function sameRepoNameSet(next: readonly string[], current: readonly string[]): boolean {
  return next.length === current.length && next.every((r, i) => r === current[i]);
}

/**
 * The SET spelling each proposal AUTHORS, as one comparable string (bug
 * MOTIR-4904) — the twin of {@link collectAuthoredTargetRepos}, and it exists for
 * exactly the same reason.
 *
 * MOTIR-3604's guard makes the pre-transaction resolution safe by re-comparing
 * the AUTHORED value under the plan lock. A set resolved before the transaction
 * and never re-compared would re-open that hole one field over: a correction
 * landing in the window would materialize the repositories the approve READ
 * rather than the ones the plan now says. So the set joins the same check.
 *
 * Canonicalised the way its resolver matches — names trimmed and lower-cased,
 * row ids trimmed — so whitespace and casing are not read as a move, while the
 * FORM is part of the signature: switching a proposal from names to row ids is a
 * change to what the plan says, whatever the two happen to resolve to.
 */
function collectAuthoredRepoSets(items: PlanItem[]): Map<string, string> {
  const authored = new Map<string, string>();
  for (const item of items) {
    const set = authoredRepoSet(item);
    if (set === undefined) continue;
    const members =
      set.form === 'targetRepositories'
        ? set.value.map((v) => v.trim())
        : set.value.map((v) => v.trim().toLowerCase());
    authored.set(item.id, `${set.form}:${members.join(',')}`);
  }
  return authored;
}

/** Compare two authored spellings the way the resolvers match them, so trailing
 *  whitespace and casing are not read as a move. `undefined` (no pin at all)
 *  stays distinct from `null` (an explicit unpin). */
function sameAuthoredPin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * REFUSE the approve when a pin the transaction is about to materialize is not
 * the pin the pre-transaction snapshot resolved (MOTIR-3604, AMENDMENT 9 D4).
 *
 * ⚠️ CALLED INSIDE THE TRANSACTION, on the FRESH proposal set, under the plan
 * lock — the same placement and the same reason as {@link assertNoRevisionInFlight}
 * directly above it. Read before the lock this would be a TOCTOU check; read
 * under it, it is the property that makes the pre-transaction resolution safe.
 *
 * PURE, and that is the point: it compares two maps over rows both callers have
 * already read. The resolution itself cannot move inside the transaction — the
 * domain read opens its own workspace context — so the check has to be one that
 * needs no read, and a comparison of AUTHORED spellings is exactly that.
 *
 * It walks the FRESH set, not the snapshot: a proposal WITHDRAWN in the window is
 * not materialized and is not a hazard, while one whose pin arrived, moved or was
 * cleared in the window is. A spelling change that names the same repository by
 * another of its accepted forms (`owner/name` for the bare name) refuses too —
 * deciding those two are the same needs the domain read this check may not make,
 * and a refusal costs a retry where a guess costs a wrong pin.
 */
function assertRepoPinsUnmoved(
  snapshot: ReadonlyMap<string, string | null>,
  fresh: PlanItem[],
  // REQUIRED, deliberately, with no `= new Map()` default: a default would let a
  // future caller skip the SET half of the check by omission, silently, which is
  // exactly the hole MOTIR-3604 closed for the singular pin.
  setSnapshot: ReadonlyMap<string, string>,
): void {
  // The SET half (bug MOTIR-4904), checked first and by the same rule: a
  // signature that arrived, moved or was cleared in the window is a plan that no
  // longer says what the approve resolved.
  for (const item of fresh) {
    const before = setSnapshot.get(item.id);
    const after = collectAuthoredRepoSets([item]).get(item.id);
    if (before === after) continue;
    const label = proposalLabel({
      op: item.op,
      workItemId: item.workItemId,
      title: ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.title,
    });
    const printed = (v: string | undefined) => (v === undefined ? 'no repository set' : `\`${v}\``);
    throw new PlanProposalRepoPinMovedError(
      item.id,
      label,
      before ?? null,
      after ?? null,
      `Proposal ${label} changed its repository set while this plan was being approved: ` +
        `${printed(before)} when the approve read it, ${printed(after)} now. Nothing was ` +
        `materialized — re-read the plan and approve it again to apply the current set.`,
    );
  }
  for (const item of fresh) {
    const before = snapshot.has(item.id) ? snapshot.get(item.id) : undefined;
    const after = authoredTargetRepo(item);
    if (sameAuthoredPin(before, after)) continue;
    const label = proposalLabel({
      op: item.op,
      workItemId: item.workItemId,
      title: ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.title,
    });
    const printed = (v: string | null | undefined) =>
      v === undefined ? 'no pin' : v === null ? 'explicitly unpinned' : `\`${v}\``;
    throw new PlanProposalRepoPinMovedError(
      item.id,
      label,
      before,
      after,
      `Proposal ${label} changed its repository pin while this plan was being approved: ` +
        `${printed(before)} when the approve read it, ${printed(after)} now. Nothing was ` +
        `materialized — re-read the plan and approve it again to apply the current pin.`,
    );
  }
}

// ── The proposed REPO ROLE — the PORTABLE pin (MOTIR-1912) ────────────────────
//
// The pin above names a REPOSITORY; this one names a ROLE of the project's set,
// and ADR §5.2 calls the difference load-bearing: at generation the repositories
// DO NOT EXIST — the set is derived from the tree (§0.1) and the user may rename
// any row before it is created — so a name pinned then is stale the moment a row
// is edited and meaningless before the row exists at all. A role is stable across
// both, which is what lets the ONBOARDING path pin anything at all.
//
// Two things follow, and they are why this sits beside the name resolver rather
// than inside it:
//
//   * VALIDATION is against the closed vocabulary (`PROJECT_REPO_ROLES`), NOT the
//     project's set — which is precisely what makes a role emittable before the
//     set exists. So it is PURE: no DB read, no memo, and nothing to await.
//   * The distinct roles ARE §0.1.1's derivation signal, the primary rung of the
//     ladder `deriveRepoSetProposal` walks. Collecting them is therefore not a
//     side errand of validation but the point: a `web` + `api` plan is what makes
//     the proposer emit TWO rows, and without this the ladder always falls through
//     to `preplan-platform` / `default-web` and a two-repo project can never be
//     proposed.

/** The `targetRepoRole` a proposal carries, as UNKNOWN — the value rides in
 *  producer-written JSON persisted verbatim, so `'backend'` and a number are as
 *  possible as a role, and only {@link assertKnownRepoRole} may narrow it. */
function authoredTargetRepoRole(item: PlanItem): unknown {
  if (item.op === 'add') {
    return ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.targetRepoRole;
  }
  if (item.op === 'modify') {
    return ((item.patch ?? null) as PlanItemPatch | null)?.targetRepoRole;
  }
  return undefined;
}

/** Name a proposal the way its author can recognise it: an `add` by the title it
 *  proposes, a `modify` by the item it targets. */
function proposalLabel(p: { op: string; workItemId?: string | null; title?: string }): string {
  if (p.op === 'add') return p.title?.trim() ? `“${p.title.trim()}”` : 'an untitled `add`';
  return `the \`${p.op}\` of work item ${p.workItemId ?? '(unknown)'}`;
}

/** A persisted proposal, named as {@link proposalLabel} names one at a door. */
function planItemLabel(item: PlanItem): string {
  const title = (item.proposedFields as { title?: unknown } | null)?.title;
  return proposalLabel({
    op: item.op,
    workItemId: item.workItemId,
    title: typeof title === 'string' ? title : undefined,
  });
}

/**
 * Attach the WARNINGS of the proposals a write touched — present only when there
 * is one, so a clean write answers exactly as before: the item links it kept that
 * would ship dead (MOTIR-10104), and the `modify`s approve will send back from
 * built work (MOTIR-10106).
 */
async function withLinkWarnings<T extends { projectId: string }>(
  answer: T,
  items: readonly PlanItem[],
  writtenIds: readonly string[],
  ctx: ServiceContext,
): Promise<
  T & { warnings?: ProposalLinkWarningDto[]; rescopeWarnings?: ProposalRescopeWarningDto[] }
> {
  const warnings = await proposalLinkWarningsService.forWrittenProposals(
    items,
    writtenIds,
    planItemLabel,
    ctx,
  );
  const rescopeWarnings = await proposalRescopeWarningsService.forProposals(
    items,
    writtenIds,
    planItemLabel,
    answer.projectId,
    ctx,
  );
  return {
    ...answer,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(rescopeWarnings.length > 0 ? { rescopeWarnings } : {}),
  };
}

/**
 * REJECT a repo role outside ADR §1.1's vocabulary, naming the offending
 * proposal. `undefined` (the proposal carries no role) and `null` (an explicit
 * "unpinned") both PASS — absent is not an error, and the `null` case is what
 * lets a `modify` clear a pin, exactly as the name path's does.
 */
/**
 * A `ProposalInput` in the shape the append-time temp-ref check reads
 * (MOTIR-3539) — the four ref carriers plus the label a refusal names it by.
 * `patch` rides along because an intra-plan edge on a `modify` travels there and
 * nowhere else, which is the carrier the live artifact used.
 */
function refCarrier(p: ProposalInput): ProposalRefCarrier {
  return {
    label: proposalLabel({ op: p.op, workItemId: p.workItemId, title: p.proposedFields?.title }),
    parentRef: p.parentRef,
    blockedByRefs: p.blockedByRefs,
    supersedesRefs: p.supersedesRefs,
    patch: p.patch ?? null,
  };
}

/**
 * A persisted `PlanItem` ROW in the ref-carrier shape (MOTIR-3540) — the twin of
 * `refCarrier` above, which reads an inbound `ProposalInput`. The withdraw path
 * needs the stored side: which proposals ALREADY on the plan point at the one
 * being taken off it.
 */
function refCarrierOfRow(item: PlanItem): ProposalRefCarrier {
  return {
    label: item.id,
    parentRef: item.parentRef,
    blockedByRefs: item.blockedByRefs,
    supersedesRefs: item.supersedesRefs ?? [],
    patch: item.patch as ProposalRefCarrier['patch'],
  };
}

/**
 * The FROZEN-status gate shared by `correctProposal` and `withdrawProposal`
 * (MOTIR-3540). `generating` and `planned` are editable; anything else is not.
 *
 * Written as a DENY of the terminal states rather than an allow of the two, so a
 * future status is refused by default — the safe direction for a gate whose job
 * is to keep two editable records of one thing from existing.
 */
/**
 * REFUSE a DECISION while a REVISION holds the plan (Story MOTIR-3595 · Subtask
 * MOTIR-3598; `agent-authored-plans.md` AMENDMENT 10 D2).
 *
 * ⚠️ CALLED INSIDE THE TRANSACTION, AFTER `planRepository.lockById`. That is the
 * whole guarantee: read before the lock this is a TOCTOU check, read under it it
 * is an exclusion, and the exclusion is what makes the two outcomes total —
 * either the decision is refused and the tree is untouched, or it materializes a
 * proposal set nothing is midway through rewriting.
 *
 * It reads the plan's own content trail, which is where the lease LIVES: a
 * `revision_started` with no `revision_ended` after it, inside the window. No
 * second table, and the reviewer learns a revision is running by reading the
 * timeline they were already reading.
 */
async function assertNoRevisionInFlight(
  planId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const lease = revisionLeaseOf(await planRevisionRepository.listByPlan(planId, tx), new Date());
  if (lease) throw new PlanRevisionInFlightError(planId, lease.heldBy, lease.expiresAt);
}

/**
 * A PLAN THAT PROPOSES NOTHING CANNOT BE APPROVED (MOTIR-4146).
 *
 * One line, given a name because `approvePlan` asks the question TWICE — once
 * before the transaction opens and once on the fresh set under the plan lock —
 * and because a check written inline twice is a check that will be corrected
 * once.
 */
function assertPlanHasProposals(planId: string, proposals: readonly unknown[]): void {
  if (proposals.length === 0) throw new PlanHasNoProposalsError(planId);
}

function assertPlanProposalsEditable(plan: Pick<Plan, 'id' | 'status'>): void {
  if (plan.status !== 'generating' && plan.status !== 'planned') {
    throw new PlanNotEditableError(plan.id, plan.status);
  }
}

/**
 * GIVE A RE-OPENED PLAN ITS STATUS BACK (Bug MOTIR-8208): `generating` → `planned`,
 * with the plan's question asked again in the same transaction.
 *
 * The caller holds the plan's row lock and has just written the `revision_ended`
 * row that records the end, so the status change is on the trail. `raise` is
 * idempotent: the gate the plan held when the revision re-opened it is still
 * `awaiting`, so in the ordinary case it writes nothing, and a plan whose
 * revision withdrew every proposal is asked nothing, exactly as `raise` decides.
 */
async function restoreReopenedPlanWithin(
  planId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const restored = await planRepository.update(planId, { status: 'planned' }, tx);
  await planGateService.raise(restored, tx);
}

/**
 * GIVE BACK A RE-OPENED PLAN WHOSE REVISION LAPSED (Bug MOTIR-8208), in the caller's
 * transaction and under its plan lock: the lease's window ran out with no
 * `revision_ended`, so nobody is writing the plan, and it goes back to `planned` as
 * it stands — one `revision_ended` signed by Motir, then the restore.
 *
 * The lease is the authority here exactly as it was before a revision re-opened
 * anything: a lapsed lease made the plan decidable then, and it makes it `planned`
 * now. Called by the decision paths first (so a person who presses Approve the
 * moment a revision lapses is not refused for a status nobody holds) and by the
 * planning-lock sweep's lapsed-revision pass. Returns whether it restored.
 */
async function settleLapsedRevisionWithin(
  planId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
  now: Date = new Date(),
): Promise<boolean> {
  const fresh = await planRepository.findById(planId, workspaceId, tx);
  if (!fresh || fresh.status !== 'generating') return false;
  const rows = await planRevisionRepository.listByPlan(planId, tx);
  if (!revisionReopenedFrom(rows) || revisionLeaseOf(rows, now)) return false;
  await planRevisionsService.recordRevision(
    {
      planId,
      changeKind: REVISION_ENDED_KIND,
      changedById: null,
      actor: { source: 'native', harness: 'Motir', model: null },
      diff: { revision: true, lapsed: true, restoredTo: 'planned' },
    },
    tx,
  );
  await restoreReopenedPlanWithin(planId, tx);
  return true;
}

function assertKnownRepoRole(role: unknown, planItemId: string | null, label: string): void {
  if (role === undefined || role === null || isProjectRepoRole(role)) return;
  const printed = typeof role === 'string' ? role : String(JSON.stringify(role) ?? role);
  throw new PlanItemUnknownTargetRepoRoleError(
    planItemId,
    label,
    printed,
    `Proposal ${label} pins the unknown repository role \`${printed}\`. A role must be one of: ${PROJECT_REPO_ROLES.join(', ')}.`,
  );
}

/**
 * The CORRECTION door's `subject` check (Story MOTIR-5062 · MOTIR-5065) — the
 * same two questions `validateProposals`' `assertProposedSubjectValid` asks at the
 * append, asked again here because a correction is a second write boundary and a
 * proposal corrected past a gate the append enforced would reach approve
 * malformed.
 *
 * ⚠️ SHAPE ONLY (MOTIR-5607 retired the KIND half — a subject is legal on every
 * kind, and `TYPEABLE_KINDS` is deliberately no longer consulted here; it still
 * gates `type` / `executor`). Membership is not checked in this repository at all —
 * the subject vocabulary IS the rule-pack file set, so a well-formed but
 * unrecognised member is accepted here and refused by the planner's own resolver.
 * That is the story's decision, not a gap: a closed list here would put a
 * migration and a platform deploy in front of every new rule pack.
 */
function assertCorrectedSubjectValid(subject: string, planItemId: string): void {
  if (!isWellFormedSubject(subject)) {
    throw new InvalidProposalError(
      `Proposal ${planItemId} sets subject \`${subject}\`, which is not a well-formed subject. ${describeSubjectShape()}`,
    );
  }
}

/**
 * Validate EVERY proposal's role and return the DISTINCT roles the plan's `add`
 * proposals pin, deduped and ordered by FIRST APPEARANCE in the plan — ADR
 * §0.1.1's signal, handed to `proposeRepositorySet` as `itemRoles`.
 *
 * Ordered by first appearance rather than sorted because the plan's own order is
 * the only ordering that carries meaning here (the tree is generated
 * primary-surface-first), and because the derivation re-orders anyway: §1.3 puts
 * the platform's primary role first and the rest in §1.1 vocabulary order. Two
 * layers, one deciding what the signals ARE and one deciding how a SET is
 * ordered — this is the first.
 *
 * Adds ONLY: a `modify` re-pins an item that already exists, which is not
 * evidence about the set's cardinality (the set was derived when the tree was
 * generated). Its role is still validated — an unknown one must materialize
 * nothing — it simply does not vote.
 */
function resolveProposedRepoRoles(items: PlanItem[]): ProjectRepoRoleDto[] {
  const ordered: ProjectRepoRoleDto[] = [];
  const seen = new Set<ProjectRepoRoleDto>();

  for (const item of items) {
    const role = authoredTargetRepoRole(item);
    assertKnownRepoRole(
      role,
      item.id,
      proposalLabel({
        op: item.op,
        workItemId: item.workItemId,
        title: ((item.proposedFields ?? null) as PlanItemProposedFields | null)?.title,
      }),
    );
    if (item.op !== 'add' || role == null) continue;
    const known = role as ProjectRepoRoleDto;
    if (!seen.has(known)) {
      seen.add(known);
      ordered.push(known);
    }
  }
  return ordered;
}

/**
 * Apply every PlanItem of a (locked, `planned`, GATED) plan inside the caller's
 * approve transaction. `add` → MATERIALIZE a WorkItem (intra-plan refs
 * resolved); `modify` → update the target (same id, ONE revision logged);
 * `remove` → archive the target. Runs entirely on `tx`.
 *
 * PRECONDITION: `assertProposalsPersistable` has already passed on `items`
 * under this same transaction — this function does not re-check the grammar or
 * done-work immutability, it applies an already-confirmed proposal set. The repo
 * pins in `repoPins` are likewise ALREADY resolved + validated
 * (`resolveProposedTargetRepos`, outside this transaction) AND re-checked against
 * the fresh rows under the lock (`assertRepoPinsUnmoved`, MOTIR-3604) — this
 * function only writes them.
 *
 * RETURNS the ids of the work items it created or modified — the MATERIALIZE
 * trigger of the plan-tree embedding write path (Story MOTIR-2694 · MOTIR-2696,
 * `docs/decisions/plan-tree-embeddings.md` §6.3.1). It returns them rather than
 * enqueueing here because the enqueue must happen AFTER this transaction commits
 * (§6.3.2): a rolled-back approve must not leave a job embedding rows that do
 * not exist. `remove` targets are excluded — archiving keeps the embedding row
 * (§5), so un-archiving restores candidacy with no re-embed.
 *
 * A modify whose text did NOT move is included too, and that is deliberate: the
 * job recomputes the content hash and skips, which costs one local read and no
 * provider call. Filtering precisely here would mean a second definition of "did
 * the document change", and two of those is how they drift apart.
 */
async function materialize(
  items: PlanItem[],
  plan: Plan,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  repoPins: ResolvedRepoPins,
  repoRefs: ProposalRepoRefs,
  repoSets: ResolvedRepoSets,
): Promise<MaterializeResult> {
  const project = await projectRepository.findById(plan.projectId, tx);
  if (!project) throw new ProjectNotFoundError(plan.projectId);
  const statusKey = await workflowsService.getInitialStatusKey(plan.projectId, ctx.workspaceId);
  if (statusKey == null) throw new NoInitialStatusError(plan.projectId);

  const adds = items.filter((i) => i.op === 'add');
  // The language an approved add's text is recorded in when its proposal names
  // none (Story MOTIR-7731 · MOTIR-8097; MOTIR-8743): the organisation's content
  // language. A proposal that names one records THAT, whatever the setting has
  // become since it was generated. Read ONCE, in this transaction, before the per-item
  // loop — approve's round-trip budget (MOTIR-3396) gains one query, not N.
  const orgLanguage = toOrgContentLanguage(
    await organizationRepository.findContentLanguageByWorkspaceId(ctx.workspaceId, tx),
  );
  // The provenance guard, RE-RUN here (MOTIR-2990). `addProposals` already
  // rejects an unknown `planningProvenance.source` at the append, and this is the
  // same check at the persist boundary — the "core re-checks, defense in depth"
  // doctrine `lib/plans/validateProposals.ts` states for the whole approve path,
  // applied to the one field materialize now READS rather than pins. It is what
  // makes "never written through to the column" a property of the write rather
  // than a property of every writer having behaved, and it fails the approve
  // ATOMICALLY: before the first row is created, so a rejection leaves the tree
  // byte-identical.
  for (const item of adds) {
    const pf = (item.proposedFields as PlanItemProposedFields | null) ?? null;
    if (pf) assertKnownPlanningSource(pf, proposalLabel({ op: 'add', title: pf.title }));
  }
  const planItemToWorkItem = new Map<string, string>();
  // The created adds, collected for the post-creation body pass (Pass 3) — the
  // intra-plan item-link tokens in a body can reference a sibling created LATER
  // (a forward ref), so resolving them must wait until every add's id exists.
  const createdAdds: Array<{ created: WorkItem; prefix: string; todos: MaterializedTodo[] }> = [];

  const resolveRef = (ref: string): string => {
    if (ref.startsWith(TEMP_REF_PREFIX)) {
      const target = planItemToWorkItem.get(ref.slice(TEMP_REF_PREFIX.length));
      if (!target) throw new UnresolvedPlanRefError(ref);
      return target;
    }
    return ref;
  };

  // Pass 1 — create each add's WorkItem (parent resolved at insert, in topo order).
  for (const item of topoOrderAdds(adds)) {
    const pf = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
    const kind = (pf.kind as WorkItemKind | undefined) ?? 'task';
    // A `folder:<id>` placement (Story MOTIR-5310 · MOTIR-5423) is a FOLDER, not a
    // parent — branched on explicitly, so `resolveRef` keeps returning work-item
    // ids only and the insert is never handed a prefixed string as a `parentId`.
    const folderId =
      item.parentRef && isFolderRef(item.parentRef)
        ? await lockPlacementFolder(item, item.parentRef, tx)
        : null;
    const parentId = item.parentRef && folderId === null ? resolveRef(item.parentRef) : null;

    const number = await projectRepository.allocateWorkItemNumber(plan.projectId, tx);
    // Re-read the identifier prefix under the lock allocateWorkItemNumber took
    // (a racing `changeKey` could have committed a new prefix — the same re-read
    // workItemsService.createWorkItem does).
    const refreshed = await projectRepository.findById(plan.projectId, tx);
    const prefix = refreshed?.identifier ?? project.identifier;
    const identifier = `${prefix}-${number}`;

    // Normalize bare REAL work-item refs in the generated description AND the
    // AI-drafted explanation (MOTIR-850) to canonical link tokens (bug MOTIR-1440)
    // so a materialized body chips (5.8.6) rather than staying plain text — the
    // same write-path rule the service create/update applies (it normalizes both
    // `descriptionMd` and `explanationMd`), here on the inlined materialize insert.
    // (Intra-plan temp refs are a separate concern, resolved at materialize by
    // the temp-ref → motir:<id> pass; this only resolves EXISTING bare keys.)
    const [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
      {
        projectId: plan.projectId,
        projectIdentifier: prefix,
        fields: [pf.descriptionMd, pf.explanationMd],
      },
      tx,
    );

    // A filed add is appended at its FOLDER's level (the `createWorkItem` rule);
    // everything else after its work-item siblings, as before.
    const position =
      folderId !== null
        ? keyForAppend(
            await workItemRepository.findLastPositionAtFolderLevel(plan.projectId, folderId, tx),
          )
        : keyForAppend(
            (await workItemRepository.findSiblings(plan.projectId, parentId, tx)).at(-1)
              ?.position ?? null,
          );
    const lastRank = await workItemRepository.findBoundaryBacklogRank(
      plan.projectId,
      ctx.workspaceId,
      null,
      'max',
      tx,
    );
    const backlogRank = keyForAppend(lastRank);

    const data: WorkItemCreateInput = {
      workspaceId: ctx.workspaceId,
      projectId: plan.projectId,
      parentId,
      folderId,
      kind,
      key: number,
      identifier,
      title: pf.title,
      descriptionMd: normalizedDescriptionMd ?? null,
      // AI-drafted explanation (MOTIR-850): flow `explanationMd` + its source onto
      // the created item. `explanationSource` is set ONLY when an explanation is
      // present — respect an explicit source the proposal carried, else default to
      // `ai_draft` (the generator drafted it); with no explanation the column stays
      // at its schema default (`user_authored`). Intra-plan temp-ref tokens in the
      // explanation are rewritten in Pass 3, like the description.
      explanationMd: normalizedExplanationMd ?? null,
      // The recorded language of each written field (MOTIR-8097); an empty body
      // records NULL. Pass 3's temp-ref rewrite is not an edit and leaves these.
      // The language is the PROPOSAL's where it names one (MOTIR-8743) — fixed at
      // generation — and the organisation's setting only where it does not.
      titleLanguage: languageFor(pf.languages, 'title', orgLanguage),
      descriptionLanguage: hasText(normalizedDescriptionMd)
        ? languageFor(pf.languages, 'description', orgLanguage)
        : null,
      explanationLanguage: hasText(normalizedExplanationMd)
        ? languageFor(pf.languages, 'explanation', orgLanguage)
        : null,
      ...(typeof normalizedExplanationMd === 'string' && normalizedExplanationMd.trim() !== ''
        ? {
            explanationSource:
              (pf.explanationSource as WorkItemCreateInput['explanationSource']) ?? 'ai_draft',
          }
        : {}),
      status: statusKey,
      ...(pf.priority ? { priority: pf.priority as WorkItemCreateInput['priority'] } : {}),
      reporterId: ctx.userId,
      // PLANNING provenance (Story MOTIR-1685; the PIN LIFTED by MOTIR-2990,
      // docs/decisions/work-item-provenance.md Decision 5 as amended 2026-08-18
      // and argued in docs/decisions/agent-authored-plans.md Q4).
      //
      // This block used to read: "`source: native` (PINNED — never read from the
      // proposal), `harness: Motir`", on the premise that "every item materialized
      // from an approved plan was planned NATIVELY by Motir". That premise was
      // true while motir-ai's generator was the only writer of a `Plan`, and
      // MOTIR-2982 falsifies it: an agent authors a plan over the MCP, a person
      // approves it, and these rows are what it creates. Left pinned, every one of
      // them would claim Motir planned it — a false statement written into the
      // exact record this ADR exists to keep honest.
      //
      // Reading the field does NOT weaken what the pin was protecting — that a
      // proposal cannot CLAIM to have been planned natively — because no caller
      // can reach it on any of the three write paths: `add_plan_items` stamps it
      // server-side and does not accept it as an argument (the discipline
      // `create_work_item` applies to `source: 'mcp'`); the internal
      // `/api/internal/ai/plan-proposals` route is a §4 job-token seam a PAT
      // cannot reach; and the proposal-EDIT path cannot touch it at all
      // (`UpdateProposalInput` has no such member and `mergeProposedFields` is an
      // explicit key-by-key merge). `assertKnownPlanningSource` at the append is
      // the backstop that keeps the column total.
      //
      // The DEFAULT is what keeps every shipped native path byte-identical: an
      // older proposal carries no provenance and takes `native`/`Motir`; MOTIR-1690's
      // producer sends exactly that pair. `planningModel` is unchanged — RECORDED
      // for internal analysis, and STRIPPED for `native` by `toWorkItemDto`, so
      // Motir still never exposes its own model. An `mcp` item is not stripped and
      // therefore shows the model the agent self-reported, which is what Decision 5
      // already prescribed ("MCP/BYOK keep + expose their model").
      planningSource: (pf.planningProvenance?.source ??
        'native') as WorkItemCreateInput['planningSource'],
      planningHarness: pf.planningProvenance?.harness ?? 'Motir',
      planningModel: pf.planningProvenance?.model ?? null,
      // WHICH SUBJECT MATTER the pass composed this card's rule packs from
      // (Story MOTIR-5062 · MOTIR-5065) — the fourth selector coordinate,
      // written beside the three planning columns above because it is the same
      // kind of fact. SHAPE-validated at the append and again in
      // `validateProposals` (`malformed_subject`);
      // MEMBERSHIP is deliberately not checked in this repository, so an
      // unrecognised but well-formed member persists here and is refused by
      // motir-ai's rule-pack resolver, the system that owns the vocabulary.
      // Absent = the proposal carried none, which stores `null` exactly as it
      // did before the field existed — the axis is purely additive.
      subject: pf.subject ?? null,
      type: (pf.type as WorkItemCreateInput['type']) ?? null,
      executor: (pf.executor as WorkItemCreateInput['executor']) ?? null,
      // Leaf sizing (MOTIR-1433): flow the validated point + minute estimates
      // onto the created item so the estimation gate satisfied on the proposal
      // survives materialize (Prisma accepts a number for the Decimal(6,2)
      // storyPoints column). Null when the `add` carried no estimate.
      estimateMinutes: pf.estimateMinutes ?? null,
      storyPoints: pf.storyPoints ?? null,
      // A leaf's DIFFICULTY (MOTIR-6133) — validated at every proposal door
      // (membership + container refusal) and re-checked for the container half
      // by the approve gate (`difficulty_on_container`). This write bypasses
      // `workItemsService`, which is exactly why the plan path owns that check.
      difficulty: pf.difficulty ?? null,
      // WHICH REPO this item ships in (MOTIR-1884) — already normalized to the
      // bare name and validated against the project's set before the transaction
      // opened. Absent from the map = the proposal carried no pin, which stores
      // `null` exactly as it did before the field existed (the shipped resolver's
      // single-repo fallback still serves those projects unchanged).
      // ⚠️ AND THE SET SPELLING WINS WHERE IT IS PRESENT (bug MOTIR-4904). The
      // three spellings are mutually exclusive at the append, so `repoSets` and
      // `repoPins` can never both hold this proposal — the `??` chain is a
      // disjoint choice, not a precedence rule.
      targetRepo: repoSets.has(item.id)
        ? primaryTargetRepo(repoSets.get(item.id)!.names)
        : (repoPins.get(item.id) ?? null),
      // …and the NAMES ARRAY beside it. ⚠️ `materialize` never wrote this column
      // at all before MOTIR-4904 — it wrote the scalar and the reference and left
      // `work_item.targetRepos` at its `[]` default — which is a hole one level
      // deeper than the bug this card is about: `resolveExpectedRepos` returns
      // EARLY on an empty `targetRepos`, so the completion gate had nothing to
      // hold a plan-materialized card open on, however many repositories it
      // shipped in. The direct path has always written the pair together
      // (`{ targetRepos: names, targetRepo: primaryTargetRepo(names) }`), and the
      // singular arm writes the one-element set it means, so both doors now agree
      // about what a pinned card looks like.
      targetRepos: repoSets.has(item.id)
        ? repoSets.get(item.id)!.names
        : repoPins.get(item.id)
          ? [repoPins.get(item.id)!]
          : [],
      // ⚠️ `targetRepoRole` IS GONE FROM `work_item` (Story MOTIR-2732 ·
      // MOTIR-3040, ADR "Amendment 2026-08-18" §A3's RETIRE branch). The role was
      // the PORTABLE stand-in a plan recorded because a NAME is meaningless before
      // the repository exists — and a row REFERENCE is not, so the proposal's role
      // is resolved to a reference above (`proposalRepoRef`) and nothing is stored
      // on the item. `PlanItemProposedFields.targetRepoRole` still exists and is
      // still how a plan pins before any row exists; it simply no longer survives
      // onto the work item as a second way to say where a card ships.
      position,
      backlogRank,
    };

    const created = await workItemRepository
      .create(data, tx)
      .catch((err: unknown) => translateFieldRejection(err, item.id));

    // THE REPOSITORY REFERENCE (Story MOTIR-2732 · MOTIR-3033). This path builds
    // its create-input by hand and calls the repository directly, bypassing
    // `workItemsService` — which is exactly why the reference had to be written
    // here explicitly and why the column it replaces was never written at all: two
    // writers existed for one fact and only one of them was exercised by the
    // work-item tests.
    //
    // Resolved from the row set proposed BEFORE this transaction (§A3), so a card
    // planned before its repositories existed points at one from birth. A proposal
    // naming nothing this project has resolves to `null` and the item lands with
    // no reference — unrouted and honest, never a guess.
    //
    // ⚠️ A PROPOSED SET writes N references, in the order it authored them (bug
    // MOTIR-4904). Element 0 is the primary every dispatch surface routes on, so
    // `position` is the authored index and not an arbitrary ordinal. A set whose
    // members matched by NAME but have no `project_repository` row lands with
    // names and no references — §A7's compatibility rung, the same all-or-nothing
    // answer `resolveAuthoredRepoPinsInProject` gives the direct door.
    const createdRefs = repoSets.has(item.id)
      ? repoSets.get(item.id)!.refs
      : refsOf(
          proposalRepoRef(
            repoPins.get(item.id) ?? null,
            pf.targetRepositoryRef ?? null,
            pf.targetRepoRole ?? null,
            repoRefs,
          ),
        );
    if (createdRefs.length > 0) {
      await workItemRepoRepository.createMany(
        createdRefs.map((projectRepoId, position) => ({
          workspaceId: ctx.workspaceId,
          workItemId: created.id,
          projectRepoId,
          position,
        })),
        tx,
      );
    }
    // THE CARD'S STEPS (Story MOTIR-3810 · MOTIR-4618, `agent-authored-plans.md`
    // AMENDMENT 14 D5). A `manual` card's operations were proposed WITH it, the
    // reviewer read them in the peek, and approve is where they become rows a
    // person can tick.
    //
    // ⚠️ THROUGH THE REPOSITORY, NOT `workItemTodosService.addTodo`, and for the
    // reason this file's own header gives for bypassing
    // `workItemsService.createWorkItem` (`:137-149`): `addTodo` owns its own
    // `withWorkspaceContext` and Prisma cannot nest interactive transactions, so
    // calling it here would break the "approve applies in ONE transaction"
    // guarantee. Its `lockTodoList` buys nothing either — it serialises two
    // people appending to one card's list, and this list belongs to a card that
    // did not exist two statements ago and that nobody else can reach until this
    // transaction commits.
    //
    // What the service DOES own and is therefore reached for rather than
    // re-implemented: the three normalizers (`lib/workItemTodos/normalize.ts`,
    // lifted out for exactly this second writer) and the executor SEED rule,
    // `todo.executor ?? pf.executor ?? 'human'` — the store's §2 rule, with the
    // PROPOSAL's executor standing in for the card's, because at this point the
    // card's own column was written from that same value one statement ago.
    //
    // ORDER is the array's (D1) — there is no `position` on a proposed row, so
    // each key is minted from the row before it with `keyForAppend`, `null` for
    // the first. A throw on any row rolls the whole approve back: a card with
    // half its steps is worse than no card, because nothing on it says which half.
    const createdTodos: MaterializedTodo[] = [];
    let lastTodoPosition: string | null = null;
    for (const todo of pf.todos ?? []) {
      const notesMd = normalizeNotes(todo.notesMd);
      const row = await workItemTodoRepository.create(
        {
          workspaceId: ctx.workspaceId,
          workItemId: created.id,
          text: requireText(todo.text),
          notesMd,
          textLanguage: languageFor(pf.languages, 'todos', orgLanguage),
          notesLanguage: hasText(notesMd) ? languageFor(pf.languages, 'todos', orgLanguage) : null,
          commandText: normalizeCommand(todo.commandText),
          executor: (todo.executor ?? pf.executor ?? 'human') as WorkItemCreateInput['executor'],
          position: keyForAppend(lastTodoPosition),
        },
        tx,
      );
      lastTodoPosition = row.position;
      createdTodos.push({ id: row.id, text: row.text });
    }

    planItemToWorkItem.set(item.id, created.id);
    await planItemRepository.setWorkItemId(item.id, created.id, tx);
    // The `created` revision is recorded in Pass 3, after the body's intra-plan
    // item-link tokens are resolved — so the revision (and the live row) carry the
    // FINAL chip body, never the temp-ref form.
    createdAdds.push({ created, prefix, todos: createdTodos });
  }

  // Pass 2 — blocked-by edges for the adds (all add targets now exist).
  //
  // ⚠️ ONE STATEMENT FOR THE WHOLE GRAPH, NOT ONE PER EDGE (MOTIR-3396). This
  // pass used to `await workItemLinkRepository.create(...)` inside a nested
  // loop, so a plan's edge count was its round-trip count: 27 edges meant 27
  // sequential Fly→Neon waits, at the END of an interactive transaction that had
  // already spent itself creating 15 work items. That is what exhausted Prisma's
  // default 5 000 ms budget and made approve return P2028 — and the raised
  // budget this path now passes is the SECOND fix, deliberately: the first is
  // simply not doing the work.
  //
  // `resolveRef` still runs in the collection loop, so an unresolvable temp-ref
  // is still an `UnresolvedPlanRefError` raised before any edge is written. The
  // per-row structural triggers are unaffected by batching (see
  // `createManyIfAbsent`), and `skipDuplicates` makes a plan that proposes the
  // same edge twice idempotent instead of aborting the approve.
  //
  // Each edge carries the REASON its proposal gave it (MOTIR-9827) onto the link,
  // so the card shows why it waits once the plan is gone.
  const blockedByRows = adds.flatMap((item) => {
    const fromId = planItemToWorkItem.get(item.id)!;
    const reasons = readEdgeReasons(item.edgeReasons);
    return item.blockedByRefs.map((ref) => ({
      workspaceId: ctx.workspaceId,
      fromId,
      toId: resolveRef(ref),
      kind: 'is_blocked_by' as const,
      reason: reasons[ref] ?? null,
      createdById: ctx.userId,
    }));
  });

  // Pass 2-bis — each `add`'s `supersedes` edges (Story MOTIR-6577 · MOTIR-6630):
  // one row per ref, from = the created card (the NEWER one), to = the ref.
  //
  // ⚠️ THEY RIDE THE SAME ONE STATEMENT AS THE BLOCKERS, not a second batch.
  // MOTIR-3396's budget is one round trip for the add pass's WHOLE link graph,
  // whatever the kinds (`approveTransactionBudget.test.ts` pins the call count),
  // so a plan's supersedes carriers add rows, never a round trip. The per-row
  // triggers and `skipDuplicates` treat each row alone, so mixing kinds changes
  // nothing — and the created card superseding a card a `modify` ALSO marks
  // `supersededByAdd` it (the same row, spelled from the other end) still lands
  // once, whichever writes first.
  const supersedesRows = adds.flatMap((item) => {
    const fromId = planItemToWorkItem.get(item.id)!;
    return (item.supersedesRefs ?? []).map((ref) => ({
      workspaceId: ctx.workspaceId,
      fromId,
      toId: resolveRef(ref),
      kind: 'supersedes' as const,
      createdById: ctx.userId,
    }));
  });
  await workItemLinkRepository.createManyIfAbsent([...blockedByRows, ...supersedesRows], tx);

  // Pass 2b — DERIVE THE BIRTH STATUS from the edges Pass 2 just wired
  // (MOTIR-3050). Pass 1 gives every created row the workflow's INITIAL status,
  // which for the default workflow is `todo` — "the only thing between this card
  // and the ready set is who picks it up". A card proposed with a
  // `blockedByRefs` naming unfinished work is not that, and a person reading the
  // approved tree was being shown a `todo` column full of cards nobody could
  // start.
  //
  // ⚠️ WHY AT BIRTH, AND ONLY AT BIRTH. `blocked` is deliberately NOT a
  // projection of the edges in this product: `lib/workflows/defaultWorkflow.ts`
  // documents it as the human annotation for "can't proceed, full stop",
  // INCLUDING blockers that have no edge at all (an external dependency), and
  // MOTIR-2425 records that readiness is computed from the edges and never from
  // the status. A recompute that owned the column would therefore CLEAR a
  // human's externally-motivated block the moment no edge remained, and would
  // fight `run.md`'s own guards, which move a card to `blocked` for reasons the
  // graph cannot see. A newly created row has no such annotation to clobber —
  // choosing its FIRST status from its edges strictly adds information and
  // overwrites nothing. That is the whole scope of this pass, and it is what
  // makes the two authoring doors agree (the direct path's planner types this
  // status by hand right after `create_work_item`).
  //
  // The verdict comes from `classifyBlockerReadiness`, the SAME predicate the
  // ready set uses (`lib/workItems/blockerReadiness.ts`) — so `blocked` here can
  // never mean something different from "not ready" there. It is a snapshot of
  // that predicate at creation, not a second source of truth for it: readiness
  // stays computed, and it is what dispatch reads.
  if (createdAdds.length > 0) {
    const createdIds = createdAdds.map(({ created }) => created.id);
    const blockerRows = await workItemLinkRepository.findBlockerStatesForItems(createdIds, tx);
    if (blockerRows.length > 0) {
      // A blocker may live in ANOTHER project (a cross-project edge), so
      // "terminal" is resolved per blocker-project — the same batched read
      // `getReadinessForItems` makes.
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        blockerRows.map((b) => b.projectId),
        ctx.workspaceId,
        tx,
      );
      const byItem = new Map<string, BlockerReadinessState[]>();
      for (const row of blockerRows) {
        const bucket = byItem.get(row.fromId);
        if (bucket) bucket.push(row);
        else byItem.set(row.fromId, [row]);
      }
      const unready = createdIds.filter(
        (id) => !classifyBlockerReadiness(byItem.get(id) ?? [], terminalByProject).ready,
      );
      if (unready.length > 0) {
        // Resolve the project's own blocked status rather than assuming one: a
        // project whose workflow was customized may not have it, and under the
        // `restricted` policy the initial → blocked move must be a declared
        // transition. Either check failing leaves the initial status in place —
        // a status the workflow does not offer is never written, and a workflow
        // that has been reshaped to forbid the hop is not overridden here.
        const blockedStatus = await workflowsRepository.findStatusByKey(
          plan.projectId,
          BLOCKED_STATUS_KEY,
          ctx.workspaceId,
          tx,
        );
        const initialStatus = await workflowsRepository.findStatusByKey(
          plan.projectId,
          statusKey,
          ctx.workspaceId,
          tx,
        );
        const legal =
          blockedStatus != null &&
          initialStatus != null &&
          (project.workflowPolicyMode === 'open' ||
            (await workflowsRepository.findTransition(
              plan.projectId,
              initialStatus.id,
              blockedStatus.id,
              ctx.workspaceId,
              tx,
            )) !== null);
        if (legal) {
          for (const id of unready) {
            const updated = await workItemRepository.update(id, { status: blockedStatus.key }, tx);
            // Feed the refreshed row back to Pass 3, which records the `created`
            // revision from it — so the item's history shows ONE create, at the
            // status it was actually born at, and not a create plus a phantom
            // status change nobody made.
            const entry = createdAdds.find((c) => c.created.id === id);
            if (entry) entry.created = updated;
          }
        }
      }
    }
  }

  // Pass 3 — resolve intra-plan item-link tokens in each add's body, then
  // auto-relate + record the create revision (MOTIR-1418). Every add's WorkItem
  // id now exists, so a `[label](motir-ref:planItem:<id>)` token (the form the
  // 7.4 generator emits for a sibling it was still proposing) rewrites to a real
  // `[label](motir:<workItemId>)` — even a forward ref to a later sibling. After
  // the rewrite the body carries only real `motir:<id>` tokens, so the SAME
  // auto-relate-on-mention pass workItemsService runs at create (5.8.3) wires the
  // `relates_to` edges here too — materialize composes the leaf repos directly
  // (it cannot nest `workItemsService.createWorkItem`'s own transaction), so this
  // is where that hook belongs. ADD-only + idempotent, so it never duplicates or
  // downgrades the structural `is_blocked_by` edges from Pass 2.
  for (const { created, prefix, todos } of createdAdds) {
    let finalRow = created;
    const { body: rewrittenDescription, unresolved } = rewriteIntraPlanRefs(
      created.descriptionMd ?? '',
      planItemToWorkItem,
    );
    // The AI-drafted explanation (MOTIR-850) follows the SAME item-link convention
    // as the description (rendered through the same markdown pipeline), so resolve
    // its intra-plan `motir-ref:planItem:<id>` tokens into real `motir:<id>` links
    // here too — even a forward ref to a sibling created later in this pass.
    const { body: rewrittenExplanation, unresolved: unresolvedExplanation } = rewriteIntraPlanRefs(
      created.explanationMd ?? '',
      planItemToWorkItem,
    );
    for (const ref of [...unresolved, ...unresolvedExplanation]) {
      // A dangling intra-plan ref is left inert (never dropped/crashed); surface
      // it — it means the generator referenced a sibling that wasn't proposed.
      console.warn(
        `[plansService.materialize] plan ${plan.id}: intra-plan ref planItem:${ref} in ${created.identifier} resolved to no item — left inert`,
      );
    }
    const bodyUpdate: WorkItemUpdateInput = {};
    if (rewrittenDescription !== (created.descriptionMd ?? '')) {
      bodyUpdate.descriptionMd = rewrittenDescription;
    }
    if (rewrittenExplanation !== (created.explanationMd ?? '')) {
      bodyUpdate.explanationMd = rewrittenExplanation;
    }
    if (Object.keys(bodyUpdate).length > 0) {
      finalRow = await workItemRepository.update(created.id, bodyUpdate, tx);
    }
    // Auto-relate mentions in BOTH the description AND the explanation (5.8.3) —
    // ADD-only + idempotent, so wiring `relates_to` from either body never
    // duplicates or downgrades the structural `is_blocked_by` edges from Pass 2.
    await autoRelateWorkItemMentions(
      {
        source: {
          id: finalRow.id,
          workspaceId: ctx.workspaceId,
          projectId: plan.projectId,
          projectIdentifier: prefix,
        },
        bodies: [finalRow.descriptionMd, finalRow.explanationMd],
        ctx,
      },
      tx,
    );
    await workItemRevisionsService.recordRevision(
      {
        workItemId: finalRow.id,
        changedById: ctx.userId,
        changeKind: 'created',
        diff: buildAddDiff(finalRow, todos),
      },
      tx,
    );
  }

  // Every item this pass created — the embedding trigger's first half. Collected
  // from `createdAdds` rather than re-derived, so a create that Pass 3 rewrote
  // is named exactly once.
  const touchedWorkItemIds: string[] = createdAdds.map(({ created }) => created.id);
  /** The re-parents this pass performed (MOTIR-3859) — see {@link ReparentMove}. */
  const reparented: ReparentMove[] = [];
  /** Every `modify` target and what its patch did — the re-scope move's input
   *  (MOTIR-10102), recorded BEFORE the patch lands, since `patchRescopes`
   *  compares the patch with the row it replaces. */
  const modifyTargets = new Map<string, ModifyTargetFacts>();

  // modify + remove against existing targets (locked + re-read inside the tx).
  //
  // ⚠️ `autoRelateWorkItemMentions` does NOT run over a modified body, and that is
  // a DECISION rather than an omission (MOTIR-3804 AC 5). The `add` path runs it
  // because a card created here has no edge set yet, so wiring `relates_to` from
  // its own mentions strictly adds information. A `modify` targets a card that
  // ALREADY has one — curated by earlier passes and by people — and an amendment
  // saying "this part moved to the card over there" is not a claim that the two
  // are related in the tracker's sense. The plan grammar also gives `modify` an
  // EXPLICIT edge channel (`blockedByAdd` / `blockedByRemove`), so edges on a
  // modify are expressible and are expressed deliberately; deriving more of them
  // from prose would let an amendment rewire a card the plan only meant to amend.
  // The body's tokens still CHIP — that is what the rewrite above and
  // `normalizeBodyRefs` are for; only the edge write is withheld.
  for (const item of items) {
    if (item.op === 'modify') {
      const { reparent: moved, rescoped } = await applyModify(
        item,
        ctx,
        resolveRef,
        tx,
        repoPins,
        repoRefs,
        repoSets,
        planItemToWorkItem,
        plan.id,
      );
      if (moved) reparented.push(moved);
      modifyTargets.set(resolveRef(item.workItemId!), {
        rescopes: rescoped,
        markOnly: isMarkOnlyPatch((item.patch ?? {}) as object),
      });
      // `applyModify` has already thrown `PlanItemTargetMissingError` on an unset
      // target, so this is non-null by the time we get here — asserted rather
      // than re-guarded, which would add a branch nothing can take.
      touchedWorkItemIds.push(resolveRef(item.workItemId!));
    } else if (item.op === 'remove') {
      if (!item.workItemId) throw new PlanItemTargetMissingError('(unset)');
      // A removed card is archived, and archiving withdraws every question still
      // waiting on it — gates locked BEFORE the card, the decide door's order (MOTIR-7109).
      await withdrawQuestionsOnArchive(item.workItemId, tx);
      const locked = await workItemRepository.lockById(item.workItemId, tx);
      if (!locked) throw new PlanItemTargetMissingError(item.workItemId);
      await workItemRepository.archive(item.workItemId, tx);
      await workItemRevisionsService.recordRevision(
        {
          workItemId: item.workItemId,
          changedById: ctx.userId,
          changeKind: 'archived',
          // WHY it was archived rides on its history (AMENDMENT 18 §3, MOTIR-6052);
          // a remove with no reason keeps the empty diff it always wrote.
          diff: item.reason ? { reason: item.reason } : {},
        },
        tx,
      );
    }
  }

  // THE CONTAINER ROLLUP, ONCE PER CONTAINER (Story MOTIR-2732 · MOTIR-3033, ADR
  // §A6). A plan creates a whole tree in one transaction and a parent is created
  // BEFORE its children, so recomputing per insert would be both quadratic and
  // wrong-order: every container would derive its set from the children that
  // happened to exist at the moment it was written.
  //
  // So it runs here, after every add and every modify has landed, over the
  // DISTINCT ancestors of everything this pass touched — each container derived
  // exactly once no matter how many of its descendants moved. Inside the same
  // transaction, so a plan and the repository sets it implies commit together.
  //
  // ⚠️ AND A RE-PARENT VACATES A CONTAINER THE TOUCHED SET NO LONGER REACHES
  // (MOTIR-3859). The walk above starts from the moved row, so after the write it
  // climbs the NEW chain and never visits the parent the row LEFT — whose derived
  // repository set is now wrong in the other direction. `moveWorkItem` recomputes
  // both chains for exactly this reason; the vacated ids are passed in as
  // containers in their own right so this pass does too.
  await recomputeContainersForTouched(
    touchedWorkItemIds,
    reparented.map((r) => r.previousParentId).filter((id): id is string => id !== null),
    ctx.workspaceId,
    tx,
  );

  // ⚠️ THE RESTING STATUS — the half the product owner asked for (bug
  // MOTIR-5640 · MOTIR-5646; AMENDMENT 16 D6/D7). Every target THIS PLAN parked
  // and still holds goes back to `blocked` when a live `blocked_by` of it is
  // open and to `todo` otherwise, and its lock row is deleted.
  //
  // LAST, after the container rollup, deliberately: the blocker read has to see
  // the edges this very plan wired (a `blockedByAdd` is what makes its target
  // rest at `blocked`), and the rollup must not then recompute over a status
  // this pass is about to change.
  //
  // INSIDE the transaction, unlike the release the decline path makes
  // post-commit. The asymmetry is the point: a decline restores the status the
  // sweep would also restore, so losing that write is recoverable, while the
  // resting status is an answer ONLY the approve knows — a post-commit failure
  // would leave the sweep to restore `in_progress` on a card whose body just
  // changed, which is the state MOTIR-5359 was filed about.
  //
  // ⚠️ AND A `modify` TARGET THAT CLAIMS BUILT WORK IS DECIDED BY THE RE-SCOPE
  // MOVE, parked or not (bug MOTIR-10102): the plan-held ones here, and every
  // other one — a conversation plan parks nothing, and its session holds only its
  // anchors — in `settleUnparkedModifyTargets` straight after.
  for (const parentRef of adds.map((a) => a.parentRef)) {
    if (!parentRef || isTempRef(parentRef) || isFolderRef(parentRef)) continue;
    const facts = modifyTargets.get(parentRef);
    if (facts) facts.gainsChildren = true;
  }
  const restingMoves = await restPlanTargets(plan, ctx, tx, modifyTargets);
  restingMoves.push(...(await settleUnparkedModifyTargets(plan, ctx, tx, modifyTargets)));

  return { touchedWorkItemIds, reparented, restingMoves };
}

/**
 * Give every target this plan PARKED its resting status, and drop the lock
 * (MOTIR-5646; AMENDMENT 16 D6–D8). Runs inside `approvePlan`'s transaction, as
 * materialize's last pass.
 *
 * ⚠️ IT WRITES THE STATUS ITSELF rather than going through
 * `workItemsService.applyStatusTransition`, for the reason
 * `resolveRescopeReset` recorded before it: that funnel asserts
 * `work_item:edit`, and the approve is gated by `ai:decide_plan` ALONE — every
 * other write a plan makes to a card rides that one key. Routing only this
 * through the edit gate would refuse the whole approve for a custom role holding
 * `ai:decide_plan` without `work_item:edit`. What the funnel guarantees is kept
 * by hand: the row lock, a real project status as the target, the legality read,
 * and the status on a revision.
 */
async function restPlanTargets(
  plan: Plan,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  modifyTargets: ReadonlyMap<string, ModifyTargetFacts>,
): Promise<RestingMove[]> {
  // ⚠️ AND THE CONVERSATION'S HAND-PARKED TARGETS (MOTIR-9527 / MOTIR-9531). A plan a
  // conversation produces parks nothing, so a target that was ALREADY at `planning`
  // when the session took it has only the SESSION's lock (`priorStatus: 'planning'`,
  // nothing held). Its resting status used to be written by the post-commit session
  // release (bug MOTIR-8356) — best-effort, so when that release did not run the
  // lease expired and the sweep, which cannot know the plan was approved, deleted the
  // lock and left the card at Planning for good. It is an answer only the approve
  // knows, so it is written here, in the approve's transaction, like the plan's own.
  // Merged into the one work-item-id order every target path takes.
  const locks = [
    ...(await planTargetLockRepository.listByPlanId(plan.id, tx)),
    ...(await sessionHandParkedLocks(plan, tx)),
  ].sort((a, b) => (a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0));
  if (locks.length === 0) return [];

  const moves: RestingMove[] = [];
  // The project's own statuses, read ONCE: every decision below is about the
  // same project, and a per-target read would be one round trip per card.
  const statuses = await workflowsRepository.findStatuses(plan.projectId, ctx.workspaceId, tx);
  const project = await projectRepository.findById(plan.projectId, tx);
  const openPolicy = project?.workflowPolicyMode === 'open';

  for (const lock of locks) {
    // Locks arrive in work-item-id order (the repository's own `orderBy`), which
    // is the one fixed lock order every path in `planTargetLockService` takes.
    await workItemRepository.lockById(lock.workItemId, tx);
    const item = await workItemRepository.findById(lock.workItemId, tx);
    if (!item) {
      // Deleted outright while the plan was open. Nothing to rest; the row goes
      // with it (the FK would cascade anyway).
      await planTargetLockRepository.deleteById(lock.id, tx);
      continue;
    }

    // The SAME predicate the ready set and Pass 2b use, so `blocked` here can
    // never mean something different from "not ready" there — read through the
    // one helper a plan's RELEASE also rests an adopted target with (MOTIR-6066),
    // so approve and decline cannot disagree about what "open blocker" means.
    const hasOpenBlocker = await planTargetLockService.hasOpenBlockerWithin(
      item.id,
      ctx.workspaceId,
      tx,
    );

    // A `modify` target that claims BUILT work is decided by the re-scope move
    // instead (bug MOTIR-10102): it leaves for `blocked` / `in_progress` / `todo`
    // when its body changed, and gets back the status it was parked from when it
    // did not. Written AUTHORITATIVELY, like `releaseOne`'s restore: the approved
    // plan is the decision, and `planning → implemented` is not an edge the
    // default graph declares.
    const facts = modifyTargets.get(item.id);
    if (facts) {
      facts.settled = true;
      const toKey = await decideModifyTargetStatus(item, lock, facts, hasOpenBlocker, statuses, tx);
      if (toKey !== null) {
        await planTargetLockRepository.deleteById(lock.id, tx);
        const move = await writePlanDecidedStatus(item, toKey, statuses, ctx, tx);
        if (move) moves.push(move);
        continue;
      }
    }

    const decision = restingStatusFor({
      archived: item.archivedAt !== null,
      currentStatus: item.status,
      hasOpenBlocker,
    });
    if (!decision.write) {
      await planTargetLockRepository.deleteById(lock.id, tx);
      continue;
    }

    const from = statuses.find((s) => s.key === item.status);
    const to = statuses.find((s) => s.key === decision.toKey);
    // A project whose workflow has no such status, or whose `restricted` graph
    // does not declare the hop, keeps the card where it is — the same
    // conservative arm Pass 2b takes, and for the same reason: a status the
    // workflow does not offer is never written, and a graph somebody reshaped is
    // not overridden here. MOTIR-5643 declares `planning → todo` and
    // `planning → blocked` for every default project, so this is the custom case.
    const legal =
      from != null &&
      to != null &&
      from.key !== to.key &&
      (openPolicy ||
        (await workflowsRepository.findTransition(
          plan.projectId,
          from.id,
          to.id,
          ctx.workspaceId,
          tx,
        )) !== null);
    if (!legal) {
      await planTargetLockRepository.deleteById(lock.id, tx);
      continue;
    }

    await workItemRepository.update(item.id, { status: to.key }, tx);
    const revisionId = await workItemRevisionsService.recordRevision(
      {
        workItemId: item.id,
        changedById: ctx.userId,
        changeKind: 'updated',
        diff: { status: { from: from.key, to: to.key } },
      },
      tx,
    );
    await planTargetLockRepository.deleteById(lock.id, tx);
    moves.push({
      workItemId: item.id,
      fromStatusKey: from.key,
      toStatusKey: to.key,
      revisionId,
    });
  }
  return moves;
}

/**
 * The locks this plan's CONVERSATION holds on cards that were hand-parked at
 * `planning` before it took them — only when this plan is the session's latest,
 * the rule the post-commit release applies, so approving an earlier plan of a
 * conversation that has moved on gives back nothing it still holds.
 */
async function sessionHandParkedLocks(
  plan: Plan,
  tx: Prisma.TransactionClient,
): Promise<PlanTargetLock[]> {
  if (!plan.sessionId) return [];
  if ((await planRepository.findLatestIdBySession(plan.sessionId, tx)) !== plan.id) return [];
  const locks = await planTargetLockRepository.listBySessionId(plan.sessionId, tx);
  return locks.filter(planTargetLockService.isHandParkedSessionLock);
}

/** What an approved `modify` did to its target, as the re-scope move reads it
 *  (bug MOTIR-10102). `settled` is set once a pass has decided the target, so the
 *  pass after it does not decide it twice. */
interface ModifyTargetFacts {
  rescopes: boolean;
  markOnly: boolean;
  gainsChildren?: boolean;
  settled?: boolean;
}

/**
 * The status the re-scope move gives one `modify` target, or `null` when the
 * move is not its business (`modifyTargetStatusFor` answers `not_ours`). Reads
 * the target's prior status through its lock, its category from the project's
 * workflow, and a live run only when the answer can depend on one.
 */
async function decideModifyTargetStatus(
  item: { id: string; status: string; archivedAt: Date | null; obsolescence: string | null },
  lock: { priorStatus: string; statusHeld: boolean } | null,
  facts: ModifyTargetFacts,
  hasOpenBlocker: boolean,
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  // An archived row is claimed by nothing, and a marked card stays finished —
  // the two cases `restAdoptedTarget` leaves where they are, for the same reasons.
  if (item.archivedAt !== null || item.obsolescence != null) return null;
  const priorStatus = priorStatusOf(item.status, lock);
  const priorCategory = statuses.find((s) => s.key === priorStatus)?.category ?? null;
  const decision = modifyTargetStatusFor({
    priorStatus,
    priorCategory,
    rescopes: facts.rescopes,
    markOnly: facts.markOnly,
    gainsChildren: facts.gainsChildren === true,
    hasOpenBlocker,
    hasLiveRun:
      facts.rescopes && !hasOpenBlocker
        ? await dispatchRunCardRepository.hasWorkingLegForWorkItem(item.id, tx)
        : false,
  });
  return decision.kind === 'not_ours' ? null : decision.toKey;
}

/**
 * Write a status an approved plan decided, past the project's transition graph,
 * with the revision that carries it — the write `restPlanTargets` makes, minus
 * its legality read. Answers the move for the post-commit `transitioned` event,
 * or `null` when there is nothing to write: the status is the card's already, the
 * workflow has no such status, or it is a done-category one (never written here).
 */
async function writePlanDecidedStatus(
  item: { id: string; status: string },
  toKey: string,
  statuses: ReadonlyArray<{ key: string; category: StatusCategoryDto }>,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<RestingMove | null> {
  // Never into the done category: the decision only names a card's own built
  // status or `todo` / `blocked` / `in_progress`, and asserting it here is what
  // lets this write skip `applyStatusTransition`'s `completedAt` stamp.
  const to = statuses.find((s) => s.key === toKey);
  if (item.status === toKey || !to || to.category === 'done') return null;
  await workItemRepository.update(item.id, { status: toKey }, tx);
  const revisionId = await workItemRevisionsService.recordRevision(
    {
      workItemId: item.id,
      changedById: ctx.userId,
      changeKind: 'updated',
      diff: { status: { from: item.status, to: toKey } },
    },
    tx,
  );
  return { workItemId: item.id, fromStatusKey: item.status, toStatusKey: toKey, revisionId };
}

/**
 * THE RE-SCOPE MOVE FOR EVERY `modify` TARGET THIS PLAN DID NOT PARK (bug
 * MOTIR-10102) — materialize's pass after `restPlanTargets`.
 *
 * ⚠️ THIS IS THE REPORTED BUG. A plan a planning CONVERSATION produces parks
 * nothing (`addProposals`, `sessionHoldingThisPlan`), and its session holds only
 * its anchors, so a `modify` of any other card was never parked, never rested and
 * never moved: an `implemented` card whose body the plan rewrote went on claiming
 * the old body was built. The same holds for a card no plan could park (a
 * workflow with no edge into `planning`).
 *
 * TWO SHAPES, by whether something HOLDS the card at `planning` right now:
 *
 * - held (a session's lock, or another plan's, that moved it there) — the status
 *   belongs to that hold, so the decision is written onto the lock as the status
 *   to give back. The session's release after this approve, or the hold's own
 *   decision later, restores it there — and the review read it from the lock too;
 * - not held — the decision is written onto the card, authoritatively, as
 *   `restPlanTargets` writes its own.
 *
 * Locks each card in work-item-id order, the one lock order every target path takes.
 */
async function settleUnparkedModifyTargets(
  plan: Plan,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  modifyTargets: ReadonlyMap<string, ModifyTargetFacts>,
): Promise<RestingMove[]> {
  const pending = [...modifyTargets.entries()]
    .filter(([, facts]) => !facts.settled)
    .map(([id]) => id)
    .sort();
  if (pending.length === 0) return [];
  const statuses = await workflowsRepository.findStatuses(plan.projectId, ctx.workspaceId, tx);
  const moves: RestingMove[] = [];
  for (const workItemId of pending) {
    const facts = modifyTargets.get(workItemId)!;
    facts.settled = true;
    await workItemRepository.lockById(workItemId, tx);
    const item = await workItemRepository.findById(workItemId, tx);
    if (!item) continue;
    const lock = await planTargetLockRepository.findByWorkItemId(workItemId, tx);
    const hasOpenBlocker = await planTargetLockService.hasOpenBlockerWithin(
      item.id,
      ctx.workspaceId,
      tx,
    );
    const toKey = await decideModifyTargetStatus(item, lock, facts, hasOpenBlocker, statuses, tx);
    if (toKey === null) continue;
    if (lock && item.status === PLANNING_STATUS_KEY && lock.statusHeld) {
      if (lock.priorStatus !== toKey) {
        await planTargetLockRepository.update(lock.id, { priorStatus: toKey }, tx);
      }
      continue;
    }
    const move = await writePlanDecidedStatus(item, toKey, statuses, ctx, tx);
    if (move) moves.push(move);
  }
  return moves;
}

/** What one `materialize` pass did to the tree — the ids it touched (the
 *  embedding trigger's input), the re-parents it performed (MOTIR-3859) and the
 *  re-scope resets it wrote (MOTIR-5359). */
interface MaterializeResult {
  touchedWorkItemIds: string[];
  reparented: ReparentMove[];
  /** The resting statuses this pass wrote over its plan's parked targets
   *  (MOTIR-5646) — see {@link RestingMove}. */
  restingMoves: RestingMove[];
}

/** One resting status an approve wrote over a target its plan had parked
 *  (MOTIR-5646) — the payload its post-commit `work-item/transitioned` carries,
 *  the shape MOTIR-5359's retired `RescopeResetMove` had, and for the same
 *  reason: a status change announces itself after the transaction commits. */
interface RestingMove {
  workItemId: string;
  fromStatusKey: string;
  toStatusKey: string;
  revisionId: string;
}

/**
 * Recompute the derived repository set of every CONTAINER above `touchedIds`,
 * each one ONCE (MOTIR-3033).
 *
 * The ancestor chains are collected first and de-duplicated, then walked deepest
 * -first so a parent derives from children that have already been derived — an
 * epic's set is the union of its stories', and a story's is only correct once its
 * own subtasks have been rolled up.
 *
 * Locked per container, exactly as the service-path rollup is: a plan approve is
 * one transaction, but it is not the only writer, and a rollup is a
 * read-derive-write either way.
 */
async function recomputeContainersForTouched(
  touchedIds: readonly string[],
  vacatedContainerIds: readonly string[],
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (touchedIds.length === 0 && vacatedContainerIds.length === 0) return;
  // depth → the containers at that depth, so the walk can go deepest-first.
  const byDepth = new Map<string, number>();
  const register = (id: string, depth: number): void => {
    const seen = byDepth.get(id);
    if (seen === undefined || depth < seen) byDepth.set(id, depth);
  };
  for (const id of touchedIds) {
    const ancestors = await workItemRepository.findAncestors(id, workspaceId, tx);
    // `findAncestors` returns ROOT→self, so the LAST entry is the immediate
    // parent: index from the end to get a depth that compares across chains.
    ancestors.forEach((a, i) => register(a.id, ancestors.length - 1 - i));
  }
  // A VACATED parent (MOTIR-3859) is a container in its OWN right, not an
  // ancestor of anything that moved — the row that made it one has just left. It
  // enters at depth 0, the same slot a touched item's immediate parent takes, so
  // it is still derived before its own ancestors are.
  for (const id of vacatedContainerIds) {
    register(id, 0);
    const ancestors = await workItemRepository.findAncestors(id, workspaceId, tx);
    ancestors.forEach((a, i) => register(a.id, ancestors.length - i));
  }
  const ordered = [...byDepth.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  for (const containerId of ordered) {
    await workItemRepository.lockById(containerId, tx);
    const refs = await workItemRepoRepository.listDerivedRefsForContainer(
      containerId,
      workspaceId,
      tx,
    );
    // BOTH halves — the references AND the stored name projection
    // (`targetRepos` / `targetRepo`) — through the one writer the service-path
    // rollup uses. Writing the references alone here (bug MOTIR-6751) left every
    // container an approve re-derived reading back the names it had before: the
    // empty set a planned story is created with, or the repositories a re-plan
    // had just moved its work out of.
    await writeDerivedRepoSet(containerId, workspaceId, refs, tx);
  }
}

/** A single `modify` materialize: patch the target (same id), one revision. */
// Resolve a `modify` patch body's intra-plan temp-refs, preserving the PRESENCE
// shape the sparse patch depends on: `undefined` means "the patch did not carry
// this key" and must stay `undefined`; an explicit `null` clears the field and has
// no tokens to rewrite. An unresolvable ref is left inert and reported through the
// SAME `console.warn` path an `add`'s dangling ref uses, so the two ops fail
// identically (MOTIR-3804).
function rewritePatchBody(
  value: string | null | undefined,
  planItemToWorkItem: ReadonlyMap<string, string>,
  planId: string,
  identifier: string,
): string | null | undefined {
  if (value == null) return value;
  const { body, unresolved } = rewriteIntraPlanRefs(value, planItemToWorkItem);
  for (const ref of unresolved) {
    console.warn(
      `[plansService.materialize] plan ${planId}: intra-plan ref planItem:${ref} in ${identifier} resolved to no item — left inert`,
    );
  }
  return body;
}

async function applyModify(
  item: PlanItem,
  ctx: ServiceContext,
  resolveRef: (ref: string) => string,
  tx: Prisma.TransactionClient,
  repoPins: ResolvedRepoPins,
  repoRefs: ProposalRepoRefs,
  repoSets: ResolvedRepoSets,
  // The SAME temp-ref → work-item map Pass 3 rewrites the `add` bodies with
  // (MOTIR-3804). The modify loop runs AFTER Pass 3, so every `add` on this plan
  // already has its row and the map is complete by the time we are called.
  planItemToWorkItem: ReadonlyMap<string, string>,
  planId: string,
): Promise<{ reparent: ReparentMove | null; rescoped: boolean }> {
  if (!item.workItemId) throw new PlanItemTargetMissingError('(unset)');
  const locked = await workItemRepository.lockById(item.workItemId, tx);
  if (!locked) throw new PlanItemTargetMissingError(item.workItemId);
  const current = await workItemRepository.findById(item.workItemId, tx);
  if (!current) throw new PlanItemTargetMissingError(item.workItemId);

  const patch = (item.patch ?? {}) as unknown as PlanItemPatch;
  const update: WorkItemUpdateInput = {};
  // Holds per-field { from, to } cells AND the `links` edge-change cell
  // ({ added, removed }) — the work-item revision diff is a heterogeneous map.
  const diff: Record<string, unknown> = {};

  if (patch.title !== undefined && patch.title !== current.title) {
    update.title = patch.title;
    diff.title = { from: current.title, to: patch.title };
  }
  // Normalize bare REAL work-item refs in a modified description to canonical
  // link tokens (bug MOTIR-1440) so the patched body chips. The prefix is the
  // target's own identifier minus its `-<key>` suffix (same derivation the
  // quick-view read uses); a key that doesn't resolve is left plain.
  //
  // BOTH bodies travel through ONE resolve (MOTIR-3111) — the same `fields:
  // [descriptionMd, explanationMd]` pair the `add`-path materialize passes, not a
  // second call. The explanation is a chip-rendering surface too, and one resolve
  // is what keeps a patch that mentions the same key in both bodies from costing
  // two lookups. `normalizeBodyRefs` preserves the presence shape, so `undefined`
  // still means "the patch did not carry this key" on the way out.
  const prefix = current.identifier.slice(
    0,
    current.identifier.length - String(current.key).length - 1,
  );
  // FIRST resolve the intra-plan temp-refs (MOTIR-3804), because a `modify` body
  // may name a card THIS SAME PLAN proposes — which is what a re-plan writes every
  // time it amends the survivor to point at the card that took over part of its
  // scope. Pass 3 does this for the `add`s and iterated `createdAdds` only, so a
  // `[label](motir-ref:planItem:<id>)` token in a patch used to materialize
  // VERBATIM: a literal href pointing at nothing, with not even the dangling-ref
  // warning an `add` gets, because the rewrite never ran on it.
  //
  // Order matters and is the cheap way round: this turns temp-refs into canonical
  // `motir:<id>` tokens, and `normalizeBodyRefs` below then normalizes any BARE
  // real key in the same body. Neither touches the other's output — a rewritten
  // token is already canonical, and a bare key carries no `motir-ref:` prefix.
  const patchedDescriptionMd = rewritePatchBody(
    patch.descriptionMd,
    planItemToWorkItem,
    planId,
    current.identifier,
  );
  const patchedExplanationMd = rewritePatchBody(
    patch.explanationMd,
    planItemToWorkItem,
    planId,
    current.identifier,
  );
  const [normalizedDescriptionMd, normalizedExplanationMd] = await normalizeBodyRefs(
    {
      projectId: current.projectId,
      projectIdentifier: prefix,
      fields: [patchedDescriptionMd, patchedExplanationMd],
    },
    tx,
  );
  if (normalizedDescriptionMd !== undefined && normalizedDescriptionMd !== current.descriptionMd) {
    update.descriptionMd = normalizedDescriptionMd;
    diff.descriptionMd = { from: current.descriptionMd, to: normalizedDescriptionMd };
  }
  // REWRITE the WHY (MOTIR-3111) — the `modify` mirror of the `add` path's
  // explanation, so THE REPLAN ACTION's "patch BOTH bodies" has a door. Sparse
  // exactly like the description above: absent leaves it alone, an explicit
  // `null` clears it. `explanationMd` already has an `editedField()` disposition
  // in lib/activity/renderers.ts (`buildAddDiff` emits the same key), so this
  // revision renders with no new registry entry.
  //
  // ⚠️ `explanationSource` is NOT written here, deliberately: it is not the
  // caller's to set (`user_authored` default, `ai_draft` → `user_edited` on the
  // service edit path), and a patch that could write it would let a plan forge
  // provenance. Its column is also undispositioned in the renderer registry — the
  // same rule the `add` path's `buildAddDiff` follows when it omits it.
  if (normalizedExplanationMd !== undefined && normalizedExplanationMd !== current.explanationMd) {
    update.explanationMd = normalizedExplanationMd;
    diff.explanationMd = { from: current.explanationMd, to: normalizedExplanationMd };
  }
  // Re-record the language of each text field this modify CHANGED (Story
  // MOTIR-7731 · MOTIR-8097) — the app-service rule: an untouched field keeps
  // its recorded language (NULL included), an emptied one records NULL. The
  // org's language is read only when a changed field needs it. Not part of the
  // revision diff — the language is a property of the text, not an edit.
  const changedText = [
    ['titleLanguage', 'title', 'title' in update ? update.title : undefined],
    [
      'descriptionLanguage',
      'description',
      'descriptionMd' in update ? update.descriptionMd : undefined,
    ],
    [
      'explanationLanguage',
      'explanation',
      'explanationMd' in update ? update.explanationMd : undefined,
    ],
  ] as const;
  let modifyLanguage: Locale | null = null;
  for (const [column, key, value] of changedText) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !hasText(value)) {
      update[column] = null;
      continue;
    }
    // The patch's own statement first (MOTIR-8743); the setting only without one.
    const stated = patch.languages?.[key];
    if (stated) {
      update[column] = stated;
      continue;
    }
    modifyLanguage ??= toOrgContentLanguage(
      await organizationRepository.findContentLanguageByWorkspaceId(ctx.workspaceId, tx),
    );
    update[column] = modifyLanguage;
  }
  if (patch.priority !== undefined && patch.priority !== current.priority) {
    update.priority = patch.priority as WorkItemUpdateInput['priority'];
    diff.priority = { from: current.priority, to: patch.priority };
  }
  if (patch.type !== undefined && patch.type !== current.type) {
    update.type = patch.type as WorkItemUpdateInput['type'];
    diff.type = { from: current.type, to: patch.type };
  }
  // A RE-TYPE SEEDS THE EXECUTOR when the target has none (bug MOTIR-6259) —
  // through the direct door's own seed-if-absent rule, so the two doors cannot
  // disagree about what re-typing a card writes. The patch still has no
  // `executor` key (AMENDMENT 4 D3a: on every op but `add` it is the TARGET's),
  // and this does not reopen that: an executor the target already carries is
  // never touched. What it closes is the case D3a predates — a re-plan that
  // re-types an UNTYPED card, where the target's executor is null and stays null,
  // so a card re-typed `decision` raised no decision gate at all.
  // `planReviewService.buildChanges` shows the approver this same cell.
  if (patch.type !== undefined) {
    const nextExecutor = resolveExecutor(
      (patch.type ?? null) as WorkItemTypeDto | null,
      undefined,
      current.executor as ExecutorDto | null,
    );
    if (nextExecutor !== current.executor) {
      update.executor = nextExecutor as WorkItemUpdateInput['executor'];
      diff.executor = { from: current.executor, to: nextExecutor };
    }
  }
  // RE-KIND the target (bug MOTIR-8192 · AMENDMENT 25) — the same `kind` diff
  // cell `workItemsService.updateWorkItem` records, so the activity feed renders
  // it through the disposition already registered.
  //
  // ⚠️ EVERY GUARD HAS ALREADY RUN, as for the re-parent below: the parent, the
  // children it keeps and the leaf fields were judged at the append and again by
  // `validatePlanProposals` (`assertKindChangesLegal`). A container's `type` and
  // `difficulty` therefore arrive cleared by this same patch or not at all.
  //
  // The EXECUTOR is the one leaf field no patch key reaches (AMENDMENT 4 D3a), so
  // a re-kind to a container DERIVES it to `null` here — the end state
  // `updateWorkItem` insists on, where a person clears it by hand — and the
  // review shows that row before the button (`planReviewService.buildChanges`).
  if (patch.kind !== undefined && patch.kind !== current.kind) {
    update.kind = patch.kind as WorkItemUpdateInput['kind'];
    diff.kind = { from: current.kind, to: patch.kind };
    if (isContainerKind(patch.kind) && current.executor !== null) {
      update.executor = null;
      diff.executor = { from: current.executor, to: null };
    }
  }
  // Leaf sizing re-scope (MOTIR-1532) — the SAME point/estimate columns the `add`
  // path materializes, applied here as an in-place modify. `storyPoints` is a
  // Prisma Decimal, so compare + record the diff NUMERICALLY (the `Number(...)`
  // shape estimationService.setEstimate logs); `estimateMinutes` is a plain
  // nullable int. Both diff keys already have a `lib/activity/renderers.ts`
  // disposition (buildAddDiff / estimationService emit them), so the modify
  // revision renders with no new registry entry.
  if (patch.storyPoints !== undefined) {
    const from = current.storyPoints === null ? null : Number(current.storyPoints);
    if (patch.storyPoints !== from) {
      update.storyPoints = patch.storyPoints;
      diff.storyPoints = { from, to: patch.storyPoints };
    }
  }
  if (patch.estimateMinutes !== undefined && patch.estimateMinutes !== current.estimateMinutes) {
    update.estimateMinutes = patch.estimateMinutes;
    diff.estimateMinutes = { from: current.estimateMinutes, to: patch.estimateMinutes };
  }
  // Re-judge the DIFFICULTY (MOTIR-6133) — the same column the `add` path
  // materializes. Sparse: absent leaves it, `null` clears. The container half
  // was refused before this transaction wrote anything (the approve gate's
  // `difficulty_on_container`). `difficulty` has a `textField()` renderer
  // disposition (MOTIR-6096), the same cell `workItemsService` records.
  if (patch.difficulty !== undefined && patch.difficulty !== current.difficulty) {
    update.difficulty = patch.difficulty;
    diff.difficulty = { from: current.difficulty, to: patch.difficulty };
  }
  // The OBSOLESCENCE mark and its note (MOTIR-6629) — the columns MOTIR-6574
  // shipped, written with the SAME `obsolescence` / `obsolescenceNoteMd` diff
  // cells `workItemsService` records, so the activity feed renders them through
  // the dispositions already registered. Sparse: absent leaves, `null` clears.
  // Membership was refused at the append / correction; no kind or status check,
  // by design — marking finished work is what the mark is for.
  if (patch.obsolescence !== undefined && patch.obsolescence !== current.obsolescence) {
    update.obsolescence = patch.obsolescence;
    diff.obsolescence = { from: current.obsolescence, to: patch.obsolescence };
  }
  if (
    patch.obsolescenceNoteMd !== undefined &&
    patch.obsolescenceNoteMd !== current.obsolescenceNoteMd
  ) {
    update.obsolescenceNoteMd = patch.obsolescenceNoteMd;
    diff.obsolescenceNoteMd = { from: current.obsolescenceNoteMd, to: patch.obsolescenceNoteMd };
  }
  // RE-PIN the repo (MOTIR-1884) — present in `repoPins` ONLY when the patch
  // carried a `targetRepo` key, which is what keeps "leave it alone" distinct
  // from "unpin it" (an explicit null resolves to null and clears the column).
  // The value is already normalized + validated against the project's set; the
  // `targetRepo` diff key has a `textField()` disposition in
  // lib/activity/renderers.ts, so this revision renders with no new registry entry.
  if (repoPins.has(item.id)) {
    const nextTargetRepo = repoPins.get(item.id)!;
    if (nextTargetRepo !== current.targetRepo) {
      update.targetRepo = nextTargetRepo;
      diff.targetRepo = { from: current.targetRepo, to: nextTargetRepo };
    }
    // The NAMES ARRAY moves with the scalar (bug MOTIR-4904) — see the `add`
    // path's note: the pair was written together on the direct door and only the
    // scalar here, so a re-pinned card kept whatever `targetRepos` it was created
    // with, or none at all.
    const nextSet = nextTargetRepo === null ? [] : [nextTargetRepo];
    if (!sameRepoNameSet(nextSet, current.targetRepos)) {
      update.targetRepos = nextSet;
      diff.targetRepos = { from: current.targetRepos, to: nextSet };
    }
  }
  // …and the SET spellings of the same axis (bug MOTIR-4904). Disjoint from the
  // block above — the three spellings are mutually exclusive at the append — so a
  // `modify` re-pins through exactly one of them.
  if (repoSets.has(item.id)) {
    const resolved = repoSets.get(item.id)!;
    const nextTargetRepo = primaryTargetRepo(resolved.names);
    if (nextTargetRepo !== current.targetRepo) {
      update.targetRepo = nextTargetRepo;
      diff.targetRepo = { from: current.targetRepo, to: nextTargetRepo };
    }
    if (!sameRepoNameSet(resolved.names, current.targetRepos)) {
      update.targetRepos = resolved.names;
      diff.targetRepos = { from: current.targetRepos, to: resolved.names };
    }
  }

  // …and the REFERENCE moves with it (MOTIR-3033). A `modify` that re-pins an
  // existing leaf changes where that card ships, so it changes its ancestors'
  // unions too — the recompute is not run here but ONCE at the end of the pass,
  // over every touched item's chain, which is what keeps a plan that re-pins six
  // subtasks of one story from deriving that story six times.
  //
  // Written whenever the pin key is PRESENT, including when the NAME did not
  // change: a card whose project only just gained its repository rows resolves to
  // a reference for the first time here, with `targetRepo` identical on both
  // sides — the same case the service path's update handles ahead of its own
  // empty-diff return.
  if (
    repoSets.has(item.id) ||
    repoPins.has(item.id) ||
    (item.patch as PlanItemPatch | null)?.targetRepoRole !== undefined ||
    (item.patch as PlanItemPatch | null)?.targetRepositoryRef !== undefined
  ) {
    const patched = (item.patch as PlanItemPatch | null) ?? null;
    // A proposed SET replaces the references WHOLE, in its authored order — the
    // same delete-then-insert `workItemsService.writeRepoRefs` performs, and for
    // the same reason: element 0 is the primary, so `[a, b]` → `[b, a]` is a
    // different decision rather than two no-ops.
    const nextRefs = repoSets.has(item.id)
      ? repoSets.get(item.id)!.refs
      : refsOf(
          proposalRepoRef(
            repoPins.get(item.id) ?? null,
            patched?.targetRepositoryRef ?? null,
            patched?.targetRepoRole ?? null,
            repoRefs,
          ),
        );
    await workItemRepoRepository.deleteByWorkItem(current.id, tx);
    if (nextRefs.length > 0) {
      await workItemRepoRepository.createMany(
        nextRefs.map((projectRepoId, position) => ({
          workspaceId: ctx.workspaceId,
          workItemId: current.id,
          projectRepoId,
          position,
        })),
        tx,
      );
    }
  }
  // RE-PIN / UNPIN the repo ROLE (MOTIR-1912) — the same sparse contract as the
  // name above. ⚠️ The ROLE no longer lands on the work item at all (MOTIR-3040,
  // §A3's RETIRE branch): a `modify` carrying `targetRepoRole` re-pins the card by
  // resolving that role to a REFERENCE — done above, beside the name — and there
  // is no column left for it to also be recorded in. The plan keeps the field;
  // the work item does not.
  // RE-PARENT the target (MOTIR-3859) — the SITS half of D3's pair, the mirror
  // of the `add` path's `parentRef` and the twin of the repo re-pin directly
  // above. Present in the patch ONLY when the proposal actually carried the key,
  // which is what keeps "leave the parent alone" distinct from "move it to the
  // root" (an explicit `null`).
  //
  // ⚠️ EVERY GUARD HAS ALREADY RUN — twice. `assertReparentLegal` judged this
  // move at the APPEND and again in `validatePlanProposals`, the second time
  // under the row locks `assertProposalsPersistable` takes. So no check is
  // repeated here, deliberately: a third copy would be a third thing to keep in
  // lockstep, and the `work_item` triggers (kind / cotenancy / cycle / depth) are
  // the structural backstop under the write either way.
  //
  // `parentId` already has a diff-cell disposition in lib/activity/renderers.ts —
  // `moveWorkItem` and the patch path both emit it — so the modify revision
  // renders with no new registry entry.
  //
  // ⚠️ AND A PLACEMENT IS TWO COLUMNS, NOT ONE (Story MOTIR-5310 · MOTIR-5423).
  // `work_item_parent_xor_folder` admits a parent OR a folder, so every arm
  // writes both, mirroring the service's `planFolderFiling` / `moveWorkItem`:
  //   `folder:<id>`  → set `folderId`, clear `parentId`, append at that folder's level
  //   a work item    → set `parentId`, clear `folderId` (the write that used to trip the CHECK)
  //   `null` (root)  → clear both; a filed item is appended at the root level
  let reparent: ReparentMove | null = null;
  const patchedParentRef = patch.parentRef;
  if (patchedParentRef !== undefined) {
    const nextFolderId =
      patchedParentRef !== null && isFolderRef(patchedParentRef)
        ? await lockPlacementFolder(item, patchedParentRef, tx)
        : null;
    const nextParentId =
      patchedParentRef === null || nextFolderId !== null ? null : resolveRef(patchedParentRef);
    if (nextParentId !== current.parentId) {
      update.parentId = nextParentId;
      diff.parentId = { from: current.parentId, to: nextParentId };
      reparent = {
        workItemId: item.workItemId,
        previousParentId: current.parentId,
        newParentId: nextParentId,
      };
    }
    if (nextFolderId !== current.folderId) {
      update.folderId = nextFolderId;
      diff.folderId = { from: current.folderId, to: nextFolderId };
      // Filed into a folder, or taken out of one to the root: the item joins a
      // new FOLDER LEVEL, so it is appended there. A move under a work item keeps
      // the position it had, as the work-item re-parent always has.
      if (nextParentId === null) {
        const position = keyForAppend(
          await workItemRepository.findLastPositionAtFolderLevel(
            current.projectId,
            nextFolderId,
            tx,
          ),
        );
        update.position = position;
        diff.position = { from: current.position, to: position };
      }
    }
  }

  // ⚠️ THE STATUS IS NOT WRITTEN HERE. A re-scope's status move runs after
  // every op has landed, as materialize's last pass: `restPlanTargets` for a
  // target this plan parked and `settleUnparkedModifyTargets` for every other
  // one (bug MOTIR-10102), both through `modifyTargetStatusFor`. It cannot run
  // here, because it reads the card's open blockers, and the edges this very
  // `modify` wires are written further down.
  //
  // ⚠️ THE BRANCH IS CLEARED HERE, with the patch, and that is not about the status: a card
  // whose body just changed must not go on unblocking its dependents on the OLD
  // body's branch. Readiness treats a blocker carrying a `sessionBranch` as
  // satisfied (`isOpenBlocker`), so the branch is cleared with the re-scope
  // exactly as `applyStatusTransition` clears it on a `done` write. Bookkeeping
  // rather than a content edit, so it stays out of the diff — the same
  // convention as before.
  //
  // ⚠️ A MARK-ONLY `modify` never clears it (MOTIR-6629). That is the only
  // `modify` step 4 lets reach a `done` / `cancelled` target, and marking a
  // finished card changes its standing, not the work its branch delivered — so
  // the branch, like the status (never parked, so `restPlanTargets` never rests
  // it), is left exactly as it was. Asked through the SAME predicate the gate
  // admitted it by, so the two cannot disagree.
  const rescoped = !isMarkOnlyPatch(patch) && patchRescopes(patch, current);
  if (rescoped) {
    update.sessionBranch = null;
  }

  if (Object.keys(update).length > 0) {
    await workItemRepository.update(item.workItemId, update, tx);
  }

  // ⚠️ A RE-SCOPE TAKES THE MANUAL-WORK QUESTION OFF THE CARD (MOTIR-8670;
  // `manual-work-gate.md` §6, amended). A run raised it about the card it reached;
  // this approve has just changed what the card asks for — its title, its body (the
  // stamp's `criteria`) or where it ships — so Waiting on you would ask the person to
  // mark done work nobody has described to them. Usually the append's park already
  // withdrew it; this catches a target the append could not park (no edge into
  // Planning, or one already sitting there). The next run to reach the card re-asks.
  if (rescoped) {
    await manualWorkGateService.withdrawOnReplan(item.workItemId, tx);
  }

  // Edge changes: add/remove `is_blocked_by` links (the target is the `from`).
  // Recorded under the EXISTING `links` revision-diff key + shape that
  // workItemsService uses ({ added/removed: [{ toId, kind }] }) — so the activity
  // feed renders them through the already-registered `links` disposition
  // (lib/activity/renderers.ts) rather than a new, undispositioned key.
  //
  // ⚠️ TWO STATUS RULES, and they do not contradict each other.
  //
  // (1) FOR AN EDGE, A `modify` NEVER MOVES THE STATUS ON ITS OWN ACCOUNT —
  // deliberately (MOTIR-3050 AC 3). The `add` path above derives a materialized
  // card's FIRST status from its edges, and the obvious symmetry would be to move
  // an existing card to `blocked` when a `blockedByAdd` newly gates it. It is not
  // symmetric, for one reason: an `add` has no prior status to overwrite, and a
  // `modify` target has one that somebody RECORDED. That card may be `in_progress`
  // with a live worktree — the exact state `run.md`'s guards produce — or
  // `in_review` with an open PR, or `done`, from which `blocked` is not even a
  // legal move. An approve cannot see any of that, so writing the column here
  // would silently walk back a fact in order to display a dependency the edge
  // already carries and readiness already computes. The mover stays explicit:
  // whoever finds the missing prerequisite calls `transition_status` themselves.
  //
  // (2) THE RE-SCOPE MOVE IS THAT EXPLICIT MOVER (bug MOTIR-10102, restoring
  // what MOTIR-5359 meant). A patch that changes WHAT the card asks for — its
  // title, its description, the repository it ships in (`patchRescopes`) — on a
  // card that claims its work is built (`implemented`, `in_review`, `approved`)
  // moves it to `blocked`, `in_progress` or `todo` once materialize has wired
  // every edge (`lib/plans/rescopeStatus.ts`). Rule (1)'s objection does not
  // reach it: the fact being walked back is *"work matching this body is built"*,
  // and approving a new body is what made that fact false. A person approved the
  // re-scope, and the review diff showed them the move before they pressed the
  // button (`planReviewService.buildChanges`, through the same predicate). Left
  // alone, an `implemented` card goes on claiming the OLD body is on the remote,
  // and readiness, the board, the parent rollup and dispatch all read that claim.
  const linkAdded: Array<{ toId: string; kind: string }> = [];
  const edgeReasons = readEdgeReasons(item.edgeReasons);
  for (const ref of patch.blockedByAdd ?? []) {
    const toId = resolveRef(ref);
    // `createIfAbsent`, not `create` (MOTIR-8147): naming an edge the card already
    // has is a statement of the wanted end state, and the unique
    // `(fromId, toId, kind)` would otherwise abort the WHOLE approve with a
    // `DuplicateLinkError` nothing catches. Same no-op the `add` path's edges and
    // the `supersedes` edges below already give a repeat. Only an edge actually
    // inserted is recorded in the revision diff.
    const created = await workItemLinkRepository.createIfAbsent(
      {
        workspaceId: ctx.workspaceId,
        fromId: item.workItemId,
        toId,
        kind: 'is_blocked_by',
        reason: edgeReasons[ref] ?? null,
        createdById: ctx.userId,
      },
      tx,
    );
    if (created) {
      linkAdded.push({ toId, kind: 'is_blocked_by' });
      // An open prerequisite takes the manual-work question off the card too
      // (MOTIR-8670): the status rule above leaves the column alone, but nobody can
      // start the work while it waits.
      await manualWorkGateService.withdrawIfNewBlockerOpen(item.workItemId, toId, tx);
    }
  }
  const linkRemoved: Array<{ toId: string; kind: string }> = [];
  for (const ref of patch.blockedByRemove ?? []) {
    const toId = resolveRef(ref);
    const link = await workItemLinkRepository.findReciprocal(
      item.workItemId,
      toId,
      'is_blocked_by',
      tx,
    );
    if (link) {
      await workItemLinkRepository.delete(link.id, tx);
      linkRemoved.push({ toId, kind: 'is_blocked_by' });
    }
  }
  // The `supersedes` edges (Story MOTIR-6577 · MOTIR-6630). ONE storage row per
  // edge, directed NEWER → OLDER, so the two spellings write in opposite
  // directions: `supersedesAdd` puts the target at `from`, `supersededByAdd` at
  // `to`. `createIfAbsent` makes a row that already exists — wired by hand, or
  // by this plan's own `add` carrying `supersedesRefs` — a no-op rather than a
  // 409, and a remove of a row that does not exist is a no-op too. Recorded in
  // the same `links` cell, as the relationship READ FROM THE TARGET
  // (`supersedes` / `superseded_by`) with `toId` the other end, so the feed
  // names the card on the far side either way.
  const supersedesEdges: Array<{
    refs: readonly string[];
    relationship: 'supersedes' | 'superseded_by';
    add: boolean;
  }> = [
    { refs: patch.supersedesAdd ?? [], relationship: 'supersedes', add: true },
    { refs: patch.supersededByAdd ?? [], relationship: 'superseded_by', add: true },
    { refs: patch.supersedesRemove ?? [], relationship: 'supersedes', add: false },
    { refs: patch.supersededByRemove ?? [], relationship: 'superseded_by', add: false },
  ];
  for (const { refs, relationship, add } of supersedesEdges) {
    for (const ref of refs) {
      const other = resolveRef(ref);
      const [fromId, toId] =
        relationship === 'supersedes' ? [item.workItemId, other] : [other, item.workItemId];
      if (add) {
        const created = await workItemLinkRepository.createIfAbsent(
          {
            workspaceId: ctx.workspaceId,
            fromId,
            toId,
            kind: 'supersedes',
            createdById: ctx.userId,
          },
          tx,
        );
        if (created) linkAdded.push({ toId: other, kind: relationship });
      } else {
        const link = await workItemLinkRepository.findReciprocal(fromId, toId, 'supersedes', tx);
        if (link) {
          await workItemLinkRepository.delete(link.id, tx);
          linkRemoved.push({ toId: other, kind: relationship });
        }
      }
    }
  }
  if (linkAdded.length > 0 || linkRemoved.length > 0) {
    diff.links = {
      ...(linkAdded.length > 0 ? { added: linkAdded } : {}),
      ...(linkRemoved.length > 0 ? { removed: linkRemoved } : {}),
    };
  }

  // REPLACE THE STEPS (MOTIR-8668 · `agent-authored-plans.md` AMENDMENT 27,
  // overturning AMENDMENT 14 D2). Absent leaves the list alone; an array — `[]`
  // included — or `null` makes the list exactly that array, in order, none
  // ticked. A replacement and never a merge: every prior row goes, ticked ones
  // with it, which is the cost D2 refused and AMENDMENT 27 accepts because the
  // review row and `get_plan` both state it before anyone presses Approve.
  //
  // Through the REPOSITORY, for the reason the `add` path gives at its own todo
  // insert: `workItemTodosService` opens its own transaction and approve applies
  // in ONE. The normalizers and the executor seed are the same ones that insert
  // reaches for, with the card's executor AS THIS PATCH LEAVES IT standing in
  // for the proposal's. Recorded in the revision under the `todos` cell the
  // service writes (`{ added, removed }`), so the activity feed renders it
  // through the disposition it already has.
  if (patch.todos !== undefined) {
    const before = await workItemTodoRepository.listByWorkItem(item.workItemId, tx);
    const incoming = patch.todos ?? [];
    if (before.length > 0 || incoming.length > 0) {
      await workItemTodoRepository.deleteByWorkItem(item.workItemId, tx);
      const cardExecutor =
        update.executor === undefined
          ? current.executor
          : typeof update.executor === 'string'
            ? update.executor
            : null;
      const added: MaterializedTodo[] = [];
      let lastPosition: string | null = null;
      for (const todo of incoming) {
        const notesMd = normalizeNotes(todo.notesMd);
        // The patch's statement for the steps (MOTIR-8743), else the setting.
        const stepLanguage =
          patch.languages?.todos ??
          (modifyLanguage ??= toOrgContentLanguage(
            await organizationRepository.findContentLanguageByWorkspaceId(ctx.workspaceId, tx),
          ));
        const row = await workItemTodoRepository.create(
          {
            workspaceId: ctx.workspaceId,
            workItemId: item.workItemId,
            text: requireText(todo.text),
            notesMd,
            textLanguage: stepLanguage,
            notesLanguage: hasText(notesMd) ? stepLanguage : null,
            commandText: normalizeCommand(todo.commandText),
            executor: (todo.executor ?? cardExecutor ?? 'human') as WorkItemCreateInput['executor'],
            position: keyForAppend(lastPosition),
          },
          tx,
        );
        lastPosition = row.position;
        added.push({ id: row.id, text: row.text });
      }
      diff.todos = {
        ...(added.length > 0 ? { added } : {}),
        ...(before.length > 0 ? { removed: before.map((t) => ({ id: t.id, text: t.text })) } : {}),
      };
    }
  }

  // ONE revision for the whole modify (same id — lands as a single entry in the
  // existing work-item revision/activity log; identity is never re-minted).
  //
  // Its id is no longer RETURNED: the only caller that wanted it was MOTIR-5359's
  // re-scope reset, which rode this revision's `status` cell to its post-commit
  // `work-item/transitioned`. The resting status records its own revision and
  // reports its own id (MOTIR-5646), so there is nothing left here to announce.
  await workItemRevisionsService.recordRevision(
    { workItemId: item.workItemId, changedById: ctx.userId, changeKind: 'updated', diff },
    tx,
  );

  // Handed back rather than acted on here: a move's consequences are whole-pass
  // facts. The repo-set recompute has to run once per container after every op
  // has landed (the rollup below), and the `child-set.changed` event has to be
  // emitted AFTER the approve transaction commits, like every `work-item/*`
  // event on this path.
  //
  // The STATUS is no longer one of them: `restPlanTargets` writes the resting
  // status for every parked target as materialize's last pass and returns its
  // own moves, so this function has no status change left to report
  // (MOTIR-5646). It reports whether the patch RE-SCOPED the card, which the
  // re-scope move decides from (MOTIR-10102).
  return { reparent, rescoped };
}

/**
 * One re-parent an approved `modify` performed (MOTIR-3859) — the two parent ids
 * whose DIRECT child set changed, plus the row that moved between them. Exactly
 * the shape `moveWorkItem` emits `work-item/child-set.changed` from, because it
 * is the same edit through a different door.
 */
interface ReparentMove {
  workItemId: string;
  previousParentId: string | null;
  newParentId: string | null;
}

/**
 * Resolve every `modify` / `remove` proposal's `baseRevision` to the anchor the
 * staleness rule compares against, and REFUSE one that cannot be an anchor
 * (MOTIR-9603). Returns the resolved value per incoming proposal index; a
 * proposal with no `baseRevision` has no entry.
 *
 * ⚠️ WHY A VALUE THAT NAMES NO REVISION IS REFUSED RATHER THAN STORED. The field
 * is client-supplied free text, and `base_revision_drift` compares it to the
 * target's latest revision ID by equality. A value that is not one of that
 * target's revision ids can never equal it, so the proposal reads "may be out of
 * date" from the moment it is written, however untouched the card is — the
 * reviewer learns to click through the warning, and it means nothing on the day
 * a real concurrent edit happens. Plan `cmvoazqd0004ihnqweisfq5b8` is the
 * fixture: its two flagged `modify`s carried the target's `updatedAt`
 * (`2026-10-19T12:49:07.705Z`) as `baseRevision`, and its four unflagged ones
 * carried none. The target lock's park was not the cause — a pure status move is
 * already outside the anchor (MOTIR-5646).
 *
 * ⚠️ AND WHY A REAL REVISION IS RESOLVED RATHER THAN STORED AS SENT. The anchor
 * skips a pure status move, so an author who took the id of the card's newest
 * revision from its history — where that revision is a status move — would hold
 * an id the anchor never answers, and trip the same false flag. Resolving it to
 * the newest non-status revision at or before it gives the id `skeleton` would
 * have served at that moment, so a genuine edit made after the author's read
 * still moves the anchor and still flags `edited`.
 */
async function resolveBaseRevisionsAtAppend(
  proposals: readonly ProposalInput[],
  tx: Prisma.TransactionClient,
): Promise<Map<number, string>> {
  const sent = proposals.flatMap((p, index) =>
    p.op !== 'add' && p.workItemId && p.baseRevision != null
      ? [{ index, workItemId: p.workItemId, baseRevision: p.baseRevision }]
      : [],
  );
  const resolved = new Map<number, string>();
  if (sent.length === 0) return resolved;
  const anchors = await workItemRevisionRepository.resolveAnchors(
    [...new Set(sent.map((s) => s.baseRevision))],
    tx,
  );
  for (const s of sent) {
    const anchor = anchors.get(s.baseRevision);
    if (!anchor || anchor.workItemId !== s.workItemId) {
      throw new InvalidProposalError(
        `${proposalLabel({ op: proposals[s.index]!.op, workItemId: s.workItemId })}: ` +
          `baseRevision "${s.baseRevision}" is not a revision of its target. Send the ` +
          'target’s `revision` as `skeleton` returns it — a revision id, never a timestamp ' +
          'or a work-item id — or omit baseRevision.',
      );
    }
    resolved.set(s.index, anchor.anchorId ?? s.baseRevision);
  }
  return resolved;
}

/**
 * Shared body of the two proposal-edit paths: lock the plan, assert it is in
 * `expectedStatus`, sparse-merge the `UpdateProposalInput` over the `add`'s
 * `proposedFields`, re-validate (non-empty title + leaf sizing), and persist —
 * NO WorkItem. The plan row is locked + its status re-read inside the tx, so an
 * edit racing the next lifecycle hop is rejected once the plan leaves
 * `expectedStatus`. Only an `add` is editable. The two callers differ ONLY in
 * which status the edit is legal from:
 *   • `updateProposal` — the user review edit, `planned`        (7.21.6 · MOTIR-1370)
 *   • `deepenProposal` — the generation-time deepen, `generating` (7.4.4a · MOTIR-1441)
 */
/**
 * Run the RE-PARENT gate over a proposal set at the APPEND (MOTIR-3859).
 *
 * The same `assertReparentLegal` the approve path runs, given the same three
 * inputs — so a move admitted here cannot be refused there for a reason the
 * author could have been told while the plan was still theirs to fix.
 *
 * ⚠️ THE PROJECT NARROWING IS SUSPENDED, for exactly the reason
 * `assertProposalsPersistable` suspends it (MOTIR-3581): `withWorkspaceContext`
 * binds `app.project_id` and `work_item_project_narrow` is a RESTRICTIVE policy,
 * so a cross-project parent would be invisible to the read and the refusal would
 * say "names no work item" about a row that plainly exists — the failure mode of
 * a refusal whose stated reason the caller can observe to be false. Suspended, the
 * tenancy check reports the real reason.
 *
 * The whole batch is judged, INCLUDING the proposals already on the plan: an
 * append re-runs the gate over the plan's whole ref graph for the same reason
 * `assertProposalSetSelfConsistent` does (MOTIR-3573).
 */
async function assertReparentsLegalAtAppend(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const terminalStatusKeys = await workflowsService.getTerminalStatusKeys(
    planProjectId,
    ctx.workspaceId,
  );
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const referenced = collectReferencedWorkItemIds(nodes);
    const rows = await workItemRepository.findByIdsInWorkspace(referenced, ctx.workspaceId, tx);
    // At their PROJECTED kinds (bug MOTIR-8192) — a move of, or under, a card
    // this plan re-kinds is judged against the kind it will have, as the approve
    // gate judges it.
    const liveById = withProjectedKinds(
      new Map<string, LiveWorkItemState>(rows.map((r) => [r.id, toLiveState(r)])),
      projectedKindOverrides(nodes),
    );
    const ancestorIdsById = await resolveReparentAncestors(nodes, ctx, tx);
    const folderById = await resolveFolderById(nodes, ctx, tx);
    const addsById = new Map(nodes.filter((n) => n.op === 'add').map((n) => [n.id, n]));
    for (const node of nodes) {
      // The ref must RESOLVE before the gate can judge it — the same
      // precondition `validatePlanProposals` gives `assertReparentLegal` through
      // its step 2, restated here because this path runs the one check rather
      // than the whole ordered gate.
      const ref = node.op === 'modify' ? node.patch?.parentRef : undefined;
      if (typeof ref === 'string' && !isTempRef(ref) && !isFolderRef(ref) && !liveById.has(ref)) {
        throw new PlanRefGraphError(
          'dangling',
          node.id,
          `Proposal ${node.id}'s patch.parentRef "${ref}" names no work item in this workspace.`,
        );
      }
      assertReparentLegal(
        node,
        liveById,
        ancestorIdsById,
        terminalStatusKeys,
        planProjectId,
        folderById,
        addsById,
      );
    }
  });
}

/**
 * The container refusal for a `modify`'s LEAF-ONLY fields, at the APPEND —
 * `patch.difficulty` (MOTIR-6133 · AMENDMENT 19) and `patch.todos` (MOTIR-8668 ·
 * AMENDMENT 27) — the half `validateProposal` defers because it needs the
 * TARGET's kind. Judged through the same shared validators the `add` path, the
 * deepen and the correction call.
 *
 * Only the INCOMING batch is judged: rows already on the plan were judged when
 * they were appended, and a target re-kinded since is the approve gate's case
 * (`difficulty_on_container` / `todos_on_container`). A target that resolves to
 * nothing is left to the close, as every other live-row question on this path
 * is. Skipped with no read when no incoming `modify` sets a non-null difficulty
 * or a non-empty step list.
 */
async function assertModifyLeafFieldsLegalAtAppend(
  proposals: readonly ProposalInput[],
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const judged = proposals.filter(
    (p) =>
      p.op === 'modify' &&
      p.workItemId &&
      ((p.patch?.difficulty !== undefined && p.patch?.difficulty !== null) ||
        (Array.isArray(p.patch?.todos) && p.patch.todos.length > 0)),
  );
  if (judged.length === 0) return;
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const rows = await workItemRepository.findByIdsInWorkspace(
      [...new Set(judged.map((p) => p.workItemId!))],
      ctx.workspaceId,
      tx,
    );
    const kindById = new Map(rows.map((r) => [r.id, r.kind as string]));
    for (const p of judged) {
      // The PROJECTED kind (bug MOTIR-8192): a patch that re-kinds its target
      // is judged against the kind it will have.
      const kind = p.patch!.kind ?? kindById.get(p.workItemId!);
      if (kind === undefined) continue;
      const label = proposalLabel({ op: p.op, workItemId: p.workItemId });
      validateProposedDifficulty(p.patch!.difficulty, kind, label);
      validateProposedTodos(p.patch!.todos, kind, label);
    }
  });
}

/**
 * The FINISHED-TARGET rule for a `modify` that sets an obsolescence mark, at the
 * APPEND (MOTIR-6663) — the half `validateProposal` cannot judge, because it
 * needs the target's live status CATEGORY. Either mark lands only on a card in
 * the `done` category; an unfinished card nobody will build is removed instead.
 *
 * Only the INCOMING batch is judged: rows already on the plan were judged when
 * they were appended, and a target reopened since is the approve gate's case. A
 * target that resolves to nothing is left to the close. Skipped with no read
 * when no incoming `modify` sets a mark.
 */
async function assertMarkTargetsFinishedAtAppend(
  proposals: readonly ProposalInput[],
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const judged = proposals.filter(
    (p) => p.op === 'modify' && p.workItemId && patchSetsObsolescence(p.patch),
  );
  if (judged.length === 0) return;
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const rows = await workItemRepository.findByIdsInWorkspace(
      [...new Set(judged.map((p) => p.workItemId!))],
      ctx.workspaceId,
      tx,
    );
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const categoryById = await resolveStatusCategories(rows, ctx, tx);
    for (const p of judged) {
      const row = rowById.get(p.workItemId!);
      if (!row) continue;
      assertMarkTargetIsFinished(
        p.patch,
        {
          key: row.identifier,
          status: row.status,
          statusCategory: categoryById.get(row.id) ?? null,
        },
        proposalLabel({ op: p.op, workItemId: p.workItemId }),
      );
    }
  });
}

/**
 * Judge the LEVEL of every `blocked_by` the batch writes, at the APPEND (Story
 * MOTIR-6015 · MOTIR-6367) — the same `assertBlockedByLevels` the persist gate
 * runs at the close, correction, `validate_plan` and approve, asked here so the
 * author hears it where the edge is written.
 *
 * Only the batch's own proposals are judged (`subjectIds`): the incoming
 * inserts and the existing rows an incoming `modify` merged into. A plan closed
 * before this rule shipped is not refused an unrelated append — its edge is
 * reported by `validate_plan` and refused at approve instead. The committed
 * kinds cost one batched read, and only when the batch writes an edge.
 *
 * Suspended project narrowing, for the reason `runPersistGate` states: a
 * cross-project `blocked_by` is legal, and a narrowed read would not see it.
 */
async function assertBlockedByLevelsAtAppend(
  nodes: readonly ProposalNode[],
  subjectIds: ReadonlySet<string>,
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const subjects = nodes.filter((n) => subjectIds.has(n.id));
  const writesEdge = subjects.some(
    (n) =>
      (n.op === 'add' && n.blockedByRefs.length > 0) ||
      (n.op === 'modify' && (n.patch?.blockedByAdd?.length ?? 0) > 0),
  );
  if (!writesEdge) return;
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const ids = [
      ...new Set([
        ...collectReferencedWorkItemIds(nodes),
        ...nodes.filter((n) => n.op === 'modify' && n.workItemId).map((n) => n.workItemId!),
      ]),
    ];
    const [rows, ancestors] = await Promise.all([
      ids.length === 0 ? [] : workItemRepository.findByIdsInWorkspace(ids, ctx.workspaceId, tx),
      workItemRepository.findAncestorIdsForItems(ids, ctx.workspaceId, tx),
    ]);
    const liveById = new Map<string, LiveWorkItemState>(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          key: r.identifier,
          title: r.title,
          kind: r.kind,
          status: r.status,
          projectId: r.projectId,
        },
      ]),
    );
    // Only rows that exist are placed; an unknown id is the close's `dangling`.
    const placed = new Map([...ancestors].filter(([id]) => liveById.has(id)));
    assertBlockedByLevels(nodes, liveById, placed, subjectIds);
  });
}

/**
 * Judge every `folder:` placement at the APPEND (MOTIR-5414): the folder exists
 * and belongs to the plan's project.
 *
 * Here rather than left to the close, by `assertTempRefsResolvable`'s own
 * argument: nothing a later call does can make an unknown folder known, and the
 * author writing the plan is the right person to hear it. Unlike a work-item
 * parent — which a plan may legitimately name before it is created — a folder is
 * never created by a plan, so there is no "created between the append and the
 * close" to wait for.
 *
 * Suspended project narrowing, for the reason `resolveFolderById` states.
 */
async function assertFolderPlacementsLegalAtAppend(
  nodes: readonly ProposalNode[],
  ctx: ServiceContext,
  planProjectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await withProjectNarrowingSuspended(tx, planProjectId, async () => {
    const folderById = await resolveFolderById(nodes, ctx, tx);
    assertFolderPlacementsLegal(nodes, folderById, planProjectId);
  });
}

/**
 * WHICH of the three edits `editAddProposal` is performing — the legal status
 * and who the trail names both follow from it, so they cannot be chosen apart:
 *
 *   • `deepen` — the author filling in a plan it is still writing (`generating`);
 *     the generation actor.
 *   • `review` — a PERSON's inline edit on the review surface (`planned`); that
 *     person and no agent.
 *   • `revise` — an AGENT revising a plan already in front of a reviewer
 *     (`update_plan_item { revision: true }`, AMENDMENT 24). Legal on
 *     `generating` and `planned` — AMENDMENT 8's editable pair, the gate
 *     `correctProposal` and a revision append use — and recorded under the
 *     agent, because the reviewer must see WHICH harness and model rewrote a card
 *     under them, exactly as `correctProposal` records its own agent edits.
 */
type AddProposalEditMode = 'deepen' | 'review' | 'revise';

async function editAddProposal(
  planId: string,
  planItemId: string,
  input: UpdateProposalInput,
  ctx: ServiceContext,
  mode: AddProposalEditMode,
): Promise<PlanWithItemsAndWarningsDto> {
  const expectedStatus = mode === 'deepen' ? 'generating' : 'planned';
  const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan) throw new PlanNotFoundError(planId);
  // `ai:view_plan` (Story MOTIR-2291 · Subtask MOTIR-2363; SPLIT by MOTIR-3188).
  //
  // ⚠️ THE KEY GATES THE AUTHOR WRITES, AND IT GATES NO VIEW. Reading a plan is
  // `canBrowse` and always was — `planReviewService.getPlanReview` says so in its
  // own doc comment, and the v1 plan routes and the `get_plan` / `get_plan_status`
  // MCP rows all declare `project:browse`. What this key governs is WRITING to a
  // plan row without deciding it: `addProposals`, `markPlanned`, and this
  // function's two callers. The two DECISIONS — `approvePlan`, which materializes
  // the proposed subtree into work items, and `declinePlan` — assert
  // `ai:decide_plan` instead.
  //
  // ⚠️ WHAT THIS COMMENT USED TO ARGUE, AND WHY IT NO LONGER DOES. It read: "this
  // key governs reading a generated plan AND acting on it, because they are the
  // same surface and a reviewer who may not act has nothing to review for" — a
  // write key wearing a read's name. That was sound under three built-in roles
  // (`member` held it, `viewer` did not, so nobody could see a plan without being
  // able to approve one). MOTIR-2257's CUSTOM roles grant exactly what an admin
  // ticks off a grid, which turned the misleading name into a privilege
  // escalation; and MOTIR-2984/-2988 gave the surface a machine author, which is
  // the reviewer-who-may-not-act the old sentence said could not exist. The name
  // is still wrong — `ai:author_plan` is the honest one — and renaming it is a
  // migration over a persisted `role_definition.permissions` value, deliberately
  // left to its own card (`docs/decisions/agent-authored-plans.md` AMENDMENT 5).
  //
  // The project comes from the PLAN row, never from the actor's active project.
  await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

  const { row, items } = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
    async (tx) => {
      const locked = await planRepository.lockById(planId, tx);
      if (!locked) throw new PlanNotFoundError(planId);
      const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
      if (!fresh) throw new PlanNotFoundError(planId);
      const legal =
        mode === 'revise'
          ? fresh.status === 'generating' || fresh.status === 'planned'
          : fresh.status === expectedStatus;
      if (!legal) {
        throw new PlanNotInExpectedStatusError(planId, fresh.status, expectedStatus);
      }
      await applyAddProposalEdit(fresh, planItemId, input, ctx, mode, tx);
      const allItems = await planItemRepository.findByPlan(planId, tx);
      return { row: fresh, items: allItems };
    },
  );
  return withLinkWarnings(toPlanWithItemsDto(row, items), items, [planItemId], ctx);
}

/**
 * The IN-TRANSACTION half of an `add` proposal edit — the item checks, the
 * merge, its re-validation, the write and the trail row — split out of
 * {@link editAddProposal} (Task MOTIR-1101 · Subtask MOTIR-8175) so a caller that
 * already holds the plan's row lock can apply several edits atomically. The
 * caller has locked the plan, re-read it as `fresh` and judged its status.
 *
 * `sharpen` is a Sharpen write-back placing the answers a PERSON settled into a
 * proposal's body: recorded under that person, like a `review` edit.
 */
async function applyAddProposalEdit(
  fresh: Plan,
  planItemId: string,
  input: UpdateProposalInput,
  ctx: ServiceContext,
  mode: AddProposalEditMode | 'sharpen',
  tx: Prisma.TransactionClient,
): Promise<void> {
  const item = await planItemRepository.findById(planItemId, tx);
  if (!item || item.planId !== fresh.id) throw new PlanItemNotFoundError(planItemId);
  if (item.op !== 'add') {
    throw new InvalidProposalError(
      'Only an `add` proposal can be edited; modify/remove target existing items.',
    );
  }
  const current = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
  // The language statement (MOTIR-8743), refused where it is written.
  validateProposedLanguages(
    input.languages,
    proposalLabel({ op: item.op, workItemId: item.workItemId, title: current.title }),
  );
  const next = mergeProposedFields(current, input);
  if (!next.title?.trim()) {
    throw new InvalidProposalError('An `add` proposal requires a non-empty title.');
  }
  // Re-validate sizing on the MERGED result (MOTIR-1433) so a patched-in bad
  // point/minute value is rejected here, the same as at create.
  validateProposedSizing(next);
  // And the STEPS on the MERGED result (MOTIR-4616 · AMENDMENT 14 D3-D4).
  // MERGED is load-bearing on both axes: a deepen that patches only `kind`
  // must still be judged against the list the proposal already carries, and
  // a deepen that patches only `todos` must still be judged against the kind
  // it already has. Validating the PATCH alone would let a proposal become a
  // `story` with a checklist in two calls that are each individually legal.
  validateProposedTodos(
    next.todos,
    next.kind ?? DEFAULT_PROPOSED_KIND,
    proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
  );
  // And the DIFFICULTY on the MERGED result (MOTIR-6133), for the same
  // reason: a deepen that patches only `kind` to `story` must still be judged
  // against the difficulty the proposal already carries.
  validateProposedDifficulty(
    next.difficulty,
    next.kind ?? DEFAULT_PROPOSED_KIND,
    proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
  );
  // The bodies' malformed item links are WARNED on the edit's response, not
  // refused (bugs MOTIR-6494 · MOTIR-10104) — `editAddProposal`.
  // The links THIS edit writes must name a proposal on the plan (bug
  // MOTIR-9175), the rendered body when it carries `sections` (bug MOTIR-9836).
  // Only the bodies the edit writes are judged, so a proposal that inherited a
  // dangling link can still be repaired by an unrelated edit.
  assertEditBodyRefsResolve(
    current,
    input,
    next,
    new Set(
      (await planItemRepository.findByPlan(fresh.id, tx))
        .filter((i) => i.op === 'add')
        .map((i) => i.id),
    ),
    proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
  );
  // And a RE-KIND, held to what the new kind owes (bug MOTIR-8192 ·
  // AMENDMENT 25 §4) — the deepen and both review edits can change `kind`,
  // and none of them re-ran the kind-parent grammar before.
  if (input.kind !== undefined) {
    await assertReKindedAddLegal(
      item.id,
      next,
      (await planItemRepository.findByPlan(fresh.id, tx)).map((i) =>
        i.id === item.id
          ? { ...toProposalNode(i), proposedFields: next as ProposalNode['proposedFields'] }
          : toProposalNode(i),
      ),
      proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
      ctx,
      fresh.projectId,
      tx,
    );
  }
  await planItemRepository.update(
    planItemId,
    { proposedFields: next as unknown as Prisma.InputJsonValue },
    tx,
  );
  // The edit, on the plan's content trail (MOTIR-3535), in the same
  // transaction as the merge it records — and the row this whole story
  // exists for: `editAddProposal` merges into `proposedFields` IN PLACE, so
  // without it a proposal deepened five times is byte-indistinguishable from
  // one written once.
  //
  // ⚠️ WHO acted is decided by `mode`, never by the plan's status: a `planned`
  // plan is edited both by a person reviewing it (`review`) and by an agent
  // revising it (`revise`), so the status alone cannot tell them apart.
  // `deepen` and `revise` take the generation actor (null on a cadence plan,
  // the agent triple beside it); `review` records that person and NO agent.
  // Reading the plan's `authorSource` for a review would file a reviewer's
  // edit under the agent that wrote what they were reviewing.
  //
  // The diff records the fields the edit SUPPLIED, not a value diff: the old
  // side of a proposal is already gone by the time it is written, and the
  // timeline shows a count rather than values in any case
  // (`design/ai-planning/design-notes.md` Part X §5).
  await planRevisionsService.recordRevision(
    {
      planId: fresh.id,
      planItemId,
      changeKind: 'edited',
      ...(mode === 'review' || mode === 'sharpen'
        ? { changedById: ctx.userId, actor: null }
        : generationActor(fresh, ctx)),
      diff: {
        fields: Object.keys(input),
        proposalCount: 1,
        ...(mode === 'revise' ? { revision: true } : {}),
        ...(mode === 'sharpen' ? { sharpened: true } : {}),
      },
    },
    tx,
  );
  // The plan's activity stamp (MOTIR-7822), beside the trail row it mirrors.
  await stampPlanActivity(fresh, new Date(), tx);
}

/**
 * Give the plan's planning conversation its TARGETS back (Story MOTIR-2786 ·
 * MOTIR-2787) — the release half of the target lock, run when a plan is decided.
 *
 * A decision is exactly the moment the story's hand-off table describes as "that
 * level's output exists": approve materializes the epic's stories, decline says
 * they never will. Either way the conversation has finished with the items it was
 * holding, and holding them any longer blocks a colleague for nothing.
 *
 * Resolved through `Plan.sessionId` (AMENDMENT 17 §5; MOTIR-6022), and only
 * when this plan is its session's LATEST — the conversation's current output.
 * That is the question the retired `sourceJobId == session.lastJobId` lookup
 * answered (it matched the latest submit only); deciding an earlier plan of a
 * conversation that has since produced a newer one must not hand the newer one's
 * targets back. A session that holds no leases (every non-conversation origin)
 * releases nothing.
 *
 * BEST-EFFORT and AFTER the commit, like the two triggers beside it: a lock that
 * fails to release is recoverable (the lease expires and the sweep clears it),
 * while a plan approval that fails after materializing the tree is not. So the
 * ordering of harms is unambiguous, and it is the reason this cannot be inside the
 * transaction — the alternative is rolling back a materialized tree because a
 * status write lost a race.
 */
async function releasePlanTargetLocks(
  plan: { id: string; projectId: string; sessionId: string | null },
  ctx: ServiceContext,
  opts: { approved?: boolean } = {},
): Promise<void> {
  // ⚠️ THE PLAN'S OWN LOCKS FIRST, AND UNCONDITIONALLY (MOTIR-5646). This
  // function used to open with `if (!plan.sourceJobId) return;` — and
  // `sourceJobId` is null for EVERY MCP-authored plan, which is every runbook
  // planning pass, so the one line above this comment is where the reported bug
  // actually lived: a plan written through `create_plan` released nothing at
  // all, for ever, and no sweep reached it either because a hand-parked card had
  // no lock row to expire.
  //
  // A plan-held lock is now released by the plan's own id. On a DECLINE, a
  // withdraw that empties the plan or a discarded close, this RESTORES each
  // target's prior status (D8). On an APPROVE there is nothing here to find:
  // `restPlanTargets` gave each target its resting status and deleted the lock
  // inside the approve transaction (D6), so this call is a no-op — which is what
  // makes it safe on every decision path.
  try {
    await planTargetLockService.releaseForPlan(plan.id, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: plan.projectId,
    });
  } catch (err) {
    console.warn(
      `[plansService] releasing PLAN-held target locks for plan ${plan.id} failed; the lease will expire and the sweep will clear it`,
      err,
    );
  }

  // The SESSION half: a plan produced by a planning conversation also hands that
  // conversation's own leases back when it is decided. On an APPROVE a target the
  // session held while it was hand-parked at `planning` has already been RESTED
  // inside the approve's transaction (`restPlanTargets`, MOTIR-9527); `opts.approved`
  // still rests one here for a lock that pass did not see (bug MOTIR-8356).
  if (!plan.sessionId) return;
  const sessionId = plan.sessionId;
  try {
    const latest = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findLatestIdBySession(sessionId, tx),
    );
    if (latest !== plan.id) return;
    await planTargetLockService.releaseForSession(
      sessionId,
      {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        projectId: plan.projectId,
      },
      opts,
    );
  } catch (err) {
    console.warn(
      `[plansService] releasing planning-target locks for plan ${plan.id} failed; the lease will expire and the sweep will clear it`,
      err,
    );
  }
}

/**
 * The raised transaction budget for `approvePlan` (MOTIR-3396) — the ONE plan
 * path that gets one, and {@link TransactionBudget} asks for the argument here
 * rather than a number, so here it is.
 *
 * **Why it needs one at all.** Approve is the only path from a proposal to a
 * row, and it is a whole SUBTREE per click: for each add, allocate the project's
 * next number, insert the row, derive its birth status, rewrite its body's
 * intra-plan refs, auto-relate its mentions and record a revision — then the
 * edges, then every modify and remove. The work is proportional to the plan, and
 * a plan worth reviewing is not small. It must all be ONE transaction: a partial
 * materialize would leave a half-built tree that the plan can no longer be
 * re-approved to finish.
 *
 * **Why the numbers.** 30 s / 10 s, matching `projectRunnerGroupService`'s
 * `SYNC_TX_BUDGET` — deliberately the same shape, because the useful property is
 * "bounded well past the worst realistic case", not a tuned figure. The failing
 * fixture was 15 adds + 27 edges at ~5.03 s against Neon from Fly `iad`; with
 * the edge pass batched (one statement, not 27) the same plan's statement count
 * falls by ~26, so 30 s leaves room for a plan several times larger before
 * anybody has to think about this again. `maxWait` at 10 s covers a pool under
 * load rather than a slow body — the first of the four observed failures was
 * `maxWait` (2 000 ms), never reaching the body at all.
 *
 * **What raising it does NOT buy, and why the ordering matters.** A bigger
 * budget makes a slow transaction legal, not fast; it holds a Neon pool slot and
 * the plan's row lock for as long as it runs. So the round trips were removed
 * FIRST (`workItemLinkRepository.createManyIfAbsent`) and this is the margin
 * around the result. If a plan ever exhausts 30 s, the answer is again to do
 * less work in the transaction — not to raise this.
 */
export const APPROVE_TX_BUDGET = { timeoutMs: 30_000, maxWaitMs: 10_000 } as const;

/**
 * The field name Prisma's validation message points its `~~~~` marker at, or
 * null (MOTIR-3654).
 *
 * `PrismaClientValidationError` renders the offending argument as an indented
 * `field: value` line with a squiggle underneath it and then states
 * `Invalid value for argument \`type\``. The trailing sentence is the reliable
 * half — it is one fixed phrase with the column in backticks — so that is what
 * is read, and everything else about the rendering is ignored.
 *
 * ⚠️ PARSED, NEVER ASSERTED. This is a human-readable message with no stability
 * contract, so a miss returns null and the caller still raises a typed 422
 * naming the PROPOSAL. Do not grow this into anything a failed match can break.
 */
function fieldFromPrismaValidationMessage(message: string): string | null {
  return /Invalid value for argument `([A-Za-z_][A-Za-z0-9_]*)`/.exec(message)?.[1] ?? null;
}

/**
 * Translate a `PrismaClientValidationError` raised by one proposal's insert into
 * {@link PlanItemFieldRejectedError}, naming the proposal (MOTIR-3654).
 *
 * The bug this closes: a proposal carrying `type: "migration"` — a value no
 * schema check refused, because the plan door's `type` was a bare `z.string()`
 * while every enum beside it was a `z.enum` — reached `prisma.workItem.create()`
 * and threw from inside the transaction. That escaped the route's error map to a
 * bare 500 with an empty body, so the only move available was pressing Approve
 * again. The two doors in front of this (the tool schemas, and
 * `validatePlanProposals`' `unknown_type` arm) are where a bad value SHOULD be
 * caught; this is the containment for anything that still gets through.
 *
 * Only the validation class is translated. A `PrismaClientKnownRequestError`
 * still reaches {@link translateApproveTimeout} and the service's own typed
 * errors pass through untouched, exactly as `containPrismaFailure` is careful to
 * do one layer up.
 */
function translateFieldRejection(err: unknown, planItemId: string): never {
  if (err instanceof Prisma.PrismaClientValidationError) {
    throw new PlanItemFieldRejectedError(
      planItemId,
      fieldFromPrismaValidationMessage(err.message),
      err.message,
    );
  }
  throw err;
}

/**
 * Translate Prisma's P2028 into {@link PlanApproveTimedOutError} (MOTIR-3396).
 * Both halves of the interactive-transaction budget raise P2028 — `maxWait`
 * ("Unable to start a transaction in the given time") and `timeout` ("A query
 * cannot be executed on an expired transaction") — and both mean the same thing
 * to a caller: nothing was written, the plan still awaits a decision, retrying
 * is legitimate. Anything else is rethrown untouched, so a typed plan error
 * still reaches the route's own map.
 */
function translateApproveTimeout(err: unknown, planId: string, itemCount: number): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028') {
    throw new PlanApproveTimedOutError(planId, itemCount);
  }
  throw err;
}

/**
 * WHO to record on a plan's content trail (Story MOTIR-3532 · MOTIR-3535), for
 * the four GENERATION-TIME writes — the open, an append, a deepen, the close.
 *
 * Two facts, and they are orthogonal:
 *
 *  1. **The acting USER, or null.** The null is the `cadence` case, and it is the
 *     same abstention `Plan.createdById` documents for itself: the auto-plan
 *     watcher runs under the PROJECT OWNER's credential so the job has one, and
 *     `ctx.userId` on that path names somebody who did nothing. Recording them
 *     would put a person's name on a machine's act, on the one plan whose whole
 *     point is that nobody asked.
 *  2. **WHICH AGENT acted**, copied onto the row rather than read off the plan at
 *     render time. The plan's `authorSource` answers who WROTE the plan; on a
 *     generation-time write that is also who performed it, which is exactly why
 *     these four sites may use it — and why the review edit and both decisions
 *     below may NOT: a person editing or deciding an agent-written plan is a
 *     different actor from its author, and a row that stores its own cannot come
 *     to disagree with itself.
 */
function generationActor(
  plan: Pick<Plan, 'origin' | 'authorSource' | 'authorHarness' | 'authorModel'>,
  ctx: ServiceContext,
): { changedById: string | null; actor: PlanRevisionAgentActor } {
  return {
    changedById: plan.origin === 'cadence' ? null : ctx.userId,
    actor: {
      source: plan.authorSource,
      harness: plan.authorHarness,
      model: plan.authorModel,
    },
  };
}

/**
 * Record a SUBMITTED plan on the run whose agent produced it, when there is one
 * (MOTIR-3981, `run-findings-protocol.md` Q5).
 *
 * ⚠️ EVERY ARM RETURNS QUIETLY. No source job, no session, a project-wide or
 * multi-anchor scope, an anchor that no longer resolves, no leg open when the plan
 * was created — every one of them is an ordinary plan that belongs to no run,
 * which is most plans. The absence of a finding is the correct record, not a
 * miss to log.
 */
async function recordSubmittedPlanFinding(
  row: { id: string; projectId: string; sessionId: string | null; createdAt: Date },
  proposalCount: number,
  ctx: ServiceContext,
): Promise<void> {
  if (!row.sessionId) return;
  const sessionId = row.sessionId;
  try {
    const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.findByIdInProject(sessionId, row.projectId, ctx.workspaceId, tx),
    );
    // A RUN's re-plan arrives through a planning CONVERSATION (the plan-session
    // doors). A session a door opened for a plan with no conversation — an
    // expand, a generation, `create_plan` — was never a run's submission, which
    // is exactly the population the retired `lastJobId` lookup could not reach
    // either (AMENDMENT 17 §5, MOTIR-6022).
    if (!session || session.origin !== 'conversation') return;

    // `scopeKey` is `buildScope`'s output — the deduped, sorted anchor keys
    // joined by a comma — so it reads straight back with no second source of
    // truth. Exactly one anchor, or this plan names no single leg.
    const keys = session.scopeKey.split(',').filter(Boolean);
    if (keys.length !== 1) return;

    const [anchor] = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdentifiers(row.projectId, [keys[0]!], tx),
    );
    if (!anchor) return;

    await dispatchRunService.recordFinding(
      {
        anchorWorkItemId: anchor.id,
        kind: 'plan_submitted',
        findingId: row.id,
        // ⚠️ THE LEG OPEN WHEN THE PLAN WAS CREATED, not the one open now
        // (MOTIR-6279). This runs when the plan reaches `planned`, and on a real
        // refusal that is after the agent exited, the CLI settled the leg
        // `replanned` and very often closed the run — so "open now" finds
        // nothing. It also keeps a PERSON's plan, opened before a run picked the
        // card up, off that run's leg when it happens to close mid-leg.
        at: row.createdAt,
        // The POINTER and the one number the row renders: what the reader is
        // being asked to approve. Never the proposals themselves — the plan is
        // a live row that can be revised, and a frozen copy would go stale
        // while sitting in a log that claims to be current.
        data: { planId: row.id, proposalCount },
      },
      ctx,
    );
  } catch {
    // Best-effort, exactly like `recordFinding` itself: the plan is `planned`
    // and nothing here may change that.
  }
}

/**
 * The plan a conversation's submit already opened for `sourceJobId`, if any
 * (MOTIR-9258). A planning submit is keyed, and motir-ai answers every repeat of
 * a key with the job the first one created, so two submits of one session (a
 * double press, a second tab, a Try again after a lost answer) can come back
 * with the SAME job. `Plan.sourceJobId` is not unique, and the proposal callbacks
 * resolve the plan by job, so the second must reuse the first plan rather than
 * open another. Read under the SESSION's row lock, so of two racing opens the
 * second waits for the first to commit and then sees its plan.
 *
 * Only a conversation's open (`{ sessionId }` with a job) is deduplicated: every
 * other door opens a session of its own, so it cannot meet a sibling's plan.
 */
async function planOpenedForJobWithin(
  input: CreatePlanInput,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<Plan | null> {
  const ref = input.session;
  if (!input.sourceJobId || !ref || !('sessionId' in ref)) return null;
  await planChangeSessionRepository.lockById(ref.sessionId, tx);
  const existing = await planRepository.findBySourceJobId(input.sourceJobId, ctx.workspaceId, tx);
  return existing && existing.sessionId === ref.sessionId ? existing : null;
}

/**
 * Resolve the session a NEW plan belongs to, inside the plan's own transaction
 * (AMENDMENT 17 §4–§5; MOTIR-6022). An explicit `{ sessionId }` — a
 * conversation's submit — must name a session of THIS project. Otherwise a new
 * session of the door's origin is opened: owned by the plan's requester (null
 * for cadence, where nobody asked), with no turn, anchored at `targetKeys`.
 */
async function attachPlanSessionWithin(
  projectId: string,
  input: CreatePlanInput,
  resolved: { origin: PlanOriginDto; authorSource: PlanAuthorSourceDto | null },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const ref = input.session;
  if (ref && 'sessionId' in ref) {
    const existing = await planChangeSessionRepository.findByIdInProject(
      ref.sessionId,
      projectId,
      ctx.workspaceId,
      tx,
    );
    if (!existing) throw new PlanSessionNotFoundError(ref.sessionId);
    return existing.id;
  }
  const origin: PlanSessionOriginDto =
    ref?.origin ??
    (resolved.authorSource === 'mcp'
      ? 'mcp'
      : resolved.origin === 'cadence'
        ? 'cadence'
        : 'generation');
  const scope = buildScope(ref?.targetKeys ?? []);
  const created = await planChangeSessionRepository.create(
    {
      workspaceId: ctx.workspaceId,
      projectId,
      createdById: input.createdById ?? null,
      scopeKey: scope.scopeKey,
      targetKeys: scope.targetKeys,
      origin,
      lastActivityAt: new Date(),
    },
    tx,
  );
  return created.id;
}

/**
 * The record-level admit `getPlanForReader` applies (MOTIR-6330) — the SAME
 * `mine` rule the session list filters on (`planChangeSessionRepository`'s
 * `mineFilter`), read for one plan. A plan that belongs to a session is admitted
 * exactly when that session is in the reader's Mine view, so the list and a
 * pasted link cannot disagree.
 */
async function readerMaySeePlan(
  plan: {
    id: string;
    projectId: string;
    sessionId: string | null;
    createdById: string | null;
    decidedById: string | null;
  },
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const held = await projectAccessService.getPermissions(plan.projectId, ctx, tx);
  if (holdsRecordView(held, ctx, 'plan:view_any')) return true;
  const routedPlanIds = await approvalGateRepository.findAwaitingRoutedPlanIds(
    // The plan kind alone is selected, so no planning-session set is owed.
    { projectIds: [plan.projectId], userId: ctx.userId, awaitingSessionIds: [] },
    tx,
  );
  if (plan.sessionId !== null) {
    const rows = await planChangeSessionRepository.listPageByProject(
      {
        projectId: plan.projectId,
        workspaceId: ctx.workspaceId,
        limit: 1,
        after: null,
        state: null,
        sessionId: plan.sessionId,
        mine: { userId: ctx.userId, routedPlanIds },
      },
      tx,
    );
    return rows.length > 0;
  }
  return (
    plan.createdById === ctx.userId ||
    plan.decidedById === ctx.userId ||
    routedPlanIds.includes(plan.id)
  );
}

/** The longest `sessionKey` a planner may send (MOTIR-7822). */
export const PLAN_STEP_SESSION_KEY_MAX = 128;

/** A planner step as a door hands it to the service (Story MOTIR-7820 ·
 *  MOTIR-7822). `targetRef` null on `lay` / `author` is the UNTARGETED form. */
export interface RecordPlanStepInput {
  sessionKey: string;
  kind: PlanStepKindDto;
  targetRef: string | null;
}

const PLAN_STEP_KINDS: readonly PlanStepKindDto[] = ['settle', 'lay', 'author'];

function assertSessionKey(sessionKey: unknown): string {
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    throw new InvalidPlanStepError('A step needs a non-empty `sessionKey`.');
  }
  if (sessionKey.length > PLAN_STEP_SESSION_KEY_MAX) {
    throw new InvalidPlanStepError(
      `A step's \`sessionKey\` is at most ${PLAN_STEP_SESSION_KEY_MAX} characters.`,
    );
  }
  return sessionKey;
}

/**
 * Validate a step's target against THIS plan, inside the step's transaction
 * (MOTIR-7822). `settle` never names one; `lay` / `author` name a proposal
 * (`planItem:<id>`, which must be an `add` on this plan) or a committed work item
 * in the plan's project — or nothing, which is the untargeted form and legal.
 * Any other shape (a `folder:` ref, a key, an empty string) is refused.
 */
async function assertStepTarget(
  plan: { id: string; projectId: string },
  kind: PlanStepKindDto,
  targetRef: string | null,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!PLAN_STEP_KINDS.includes(kind)) {
    throw new InvalidPlanStepError(`Unknown step kind \`${String(kind)}\`.`);
  }
  if (targetRef === null) return;
  if (kind === 'settle') {
    throw new InvalidPlanStepError('A `settle` step names no target.');
  }
  if (typeof targetRef !== 'string' || targetRef.trim().length === 0) {
    throw new InvalidPlanStepError(
      'A step target is a `planItem:<id>` ref or a work-item id; omit it for an untargeted step.',
    );
  }
  if (targetRef.startsWith(TEMP_REF_PREFIX)) {
    const item = await planItemRepository.findById(targetRef.slice(TEMP_REF_PREFIX.length), tx);
    if (!item || item.planId !== plan.id || item.op !== 'add') {
      throw new InvalidPlanStepError(`\`${targetRef}\` names no \`add\` proposal on this plan.`);
    }
    return;
  }
  if (isFolderRef(targetRef) || targetRef.includes(':') || /\s/.test(targetRef)) {
    throw new InvalidPlanStepError(
      `\`${targetRef}\` is not a step target: send a \`planItem:<id>\` ref or a work-item id.`,
    );
  }
  const rows = await withProjectNarrowingSuspended(tx, plan.projectId, () =>
    workItemRepository.findByIdsInWorkspace([targetRef], ctx.workspaceId, tx),
  );
  if (rows.length === 0 || rows[0]!.projectId !== plan.projectId) {
    throw new InvalidPlanStepError(
      `\`${targetRef}\` is not a work item in this plan's project (a key is not an id).`,
    );
  }
}

/**
 * The TITLE a step's target reads as right now (Story MOTIR-8060 · MOTIR-8062),
 * resolved inside the step's own transaction so the session's stored step words
 * name what the step named: a proposal's `proposedFields.title`, or a committed
 * work item's title. `null` for no target or one that resolves to nothing — an
 * unresolvable title never refuses the step (the step's own target rule already
 * ran in {@link assertStepTarget}).
 */
async function resolveStepTargetTitle(
  plan: { id: string; projectId: string },
  targetRef: string | null,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (targetRef === null) return null;
  if (targetRef.startsWith(TEMP_REF_PREFIX)) {
    const item = await planItemRepository.findById(targetRef.slice(TEMP_REF_PREFIX.length), tx);
    const fields = item?.proposedFields as Record<string, unknown> | null | undefined;
    const title = fields?.['title'];
    return typeof title === 'string' ? cleanNarrationSentence(title) : null;
  }
  const rows = await withProjectNarrowingSuspended(tx, plan.projectId, () =>
    workItemRepository.findTitlesByIds([targetRef], ctx.workspaceId, tx),
  );
  return rows[0] ? cleanNarrationSentence(rows[0].title) : null;
}

/** What one `reportPlanStep` call wrote — each door reports which (MOTIR-8062). */
export type ReportPlanStepResult =
  | { kind: 'step'; step: PlanStepDto }
  | { kind: 'end' }
  | { kind: 'narration'; narration: PlanNarrationDto[] }
  | { kind: 'providerRetry'; providerWait: PlanStepProviderWaitDto | null };

/** The most retries one provider wait may name (MOTIR-9619) — `attempt` and
 *  `maxAttempts` are integers in `1..PLAN_PROVIDER_RETRY_ATTEMPTS_MAX`. */
export const PLAN_PROVIDER_RETRY_ATTEMPTS_MAX = 20;

/**
 * A session's provider-retry report (Story MOTIR-9540 · MOTIR-9619): `waiting`
 * names the retry about to be made, of how many, and when it goes out; `cleared`
 * says the wait is over, however it ended.
 */
export type PlanProviderRetryInput =
  | { state: 'waiting'; attempt: number; maxAttempts: number; retryAt: string }
  | { state: 'cleared' };

function isRetryAttempt(v: unknown): v is number {
  return (
    Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PLAN_PROVIDER_RETRY_ATTEMPTS_MAX
  );
}

/**
 * The one transaction both step writes share (MOTIR-7822): find the plan, assert
 * `ai:view_plan` on the PLAN's project, then lock, re-read, refuse anything but
 * `generating`, run `write`, and stamp the activity — all under the plan row's
 * `FOR UPDATE`, which is also what serialises a report against `markPlanned`.
 */
async function withGeneratingPlanStep<T>(
  planId: string,
  ctx: ServiceContext,
  write: (plan: Plan, tx: Prisma.TransactionClient, now: Date) => Promise<T>,
): Promise<T> {
  const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan) throw new PlanNotFoundError(planId);
  await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');
  return withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
    async (tx) => {
      const locked = await planRepository.lockById(planId, tx);
      if (!locked) throw new PlanNotFoundError(planId);
      const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
      if (!fresh) throw new PlanNotFoundError(planId);
      if (fresh.status !== 'generating') {
        throw new PlanNotGeneratingError(
          planId,
          fresh.status,
          `Plan ${planId} is ${fresh.status}, not generating — a step is only recorded while ` +
            'the plan is being written. Nothing was changed.',
        );
      }
      const now = new Date();
      const out = await write(fresh, tx, now);
      await stampPlanActivity(fresh, now, tx);
      return out;
    },
  );
}

export const plansService = {
  /**
   * Open a `generating` Plan — the producer (7.4 generation / 7.11 re-planning)
   * calls this before emitting proposals. No WorkItem is created.
   */
  async createPlan(
    projectId: string,
    input: CreatePlanInput,
    ctx: ServiceContext,
  ): Promise<PlanDto> {
    await projectAccessService.assertCanEdit(projectId, ctx);
    // The trail's own values, resolved ONCE so the row and its revision cannot
    // disagree about who wrote the plan (MOTIR-3535).
    const origin = input.origin ?? 'user';
    const authorSource = input.authorSource ?? null;
    const authorHarness = normalizeSelfReported(input.authorHarness);
    const authorModel = normalizeSelfReported(input.authorModel);
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        // A re-sent keyed submit answered with a job that already has its plan
        // (MOTIR-9258) gets THAT plan back, and nothing is written.
        const opened = await planOpenedForJobWithin(input, ctx, tx);
        if (opened) return opened;
        // The plan's SESSION, in the SAME transaction as the plan (AMENDMENT 17
        // §5): no plan is ever observable without one.
        const sessionId = await attachPlanSessionWithin(
          projectId,
          input,
          { origin, authorSource },
          ctx,
          tx,
        );
        const created = await planRepository.create(
          {
            workspaceId: ctx.workspaceId,
            projectId,
            sessionId,
            status: 'generating',
            title: input.title ?? null,
            summary: input.summary ?? null,
            sourceJobId: input.sourceJobId ?? null,
            // WHY the plan was started (MOTIR-916). Defaults to `user`, so every
            // request-path producer keeps recording a human-initiated plan
            // without passing anything; only the cadence watcher passes
            // `cadence`.
            origin,
            // WHO ASKED for it (MOTIR-2986). EXPLICIT — deliberately NOT
            // `ctx.userId`, which is always present and is the project OWNER's on
            // the cadence path (`autoPlanCadenceService` substitutes it so the
            // job has a credential). Defaulting from the context would attribute
            // a request to somebody who never made one, on the single plan whose
            // whole point is that no person asked. Absent ⇒ null ⇒ `origin`
            // answers who set it going.
            createdById: input.createdById ?? null,
            // WHO authored it (MOTIR-2986) — the orthogonal fact, written in the
            // SAME insert rather than by an update-after-insert, because these
            // are write-once values on a row nobody else holds yet. No lock and
            // no concurrency guard: not a read-then-write, not a counter, not a
            // status guard.
            //
            // Every shipped producer omits all three, so this spread stores
            // nulls and the row is identical to one written before the columns
            // existed. The harness/model are self-reported free text
            // (`work-item-provenance.md` Decision 2) — trimmed here, empty → null,
            // so a caller sending `""` cannot make the surface render a blank
            // attribution that reads as a value.
            authorSource,
            authorHarness,
            authorModel,
          },
          tx,
        );
        // The trail's first row, in the SAME transaction as the insert it
        // records (MOTIR-3535). The plan-level acts carry no `planItemId` —
        // there is no proposal yet, and there never is one for the open.
        await planRevisionsService.recordRevision(
          {
            planId: created.id,
            changeKind: 'created',
            ...generationActor({ origin, authorSource, authorHarness, authorModel }, ctx),
            diff: { title: created.title, summary: created.summary, origin },
          },
          tx,
        );
        return created;
      },
    );
    return toPlanDto(row, 0);
  },

  /**
   * Append proposed `add`/`modify`/`remove` PlanItems to a `generating` plan
   * (the producer calls this per node / per batch). NO WorkItem is created here.
   * The plan row is locked + its status re-read so an append racing a
   * `markPlanned` is rejected once the plan leaves `generating`.
   *
   * ⚠️ ONE PROPOSAL PER EXISTING TARGET (MOTIR-3194), and a second `modify`
   * MERGES into it (AMENDMENT 18 §2, MOTIR-6051). `PlanItem @@unique([planId,
   * workItemId])` still admits one row per target; `foldAppend` decides, under the
   * plan lock and before any gate, which proposals become rows and which fold into
   * one, and every pairing with a `remove` is refused in words by
   * `DuplicatePlanTargetError`. The result carries `appendedItemIds` — one id
   * per proposal, in input order — because a merge adds no row to slice off.
   */
  /**
   * ⚠️ `opts.revision` is AMENDMENT 10 D1's relaxation, and it is opt-in PER CALL.
   *
   * Absent, the gate is `generating` and this method is byte-identical to what it
   * has always been. Present, the gate becomes `assertPlanProposalsEditable`: the
   * same two-status gate `correctProposal` uses, so a REVISION may grow a
   * `planned` plan's proposal set.
   *
   * **TWO callers pass it now** (AMENDMENT 12, MOTIR-4153): the job seam
   * (`aiGenerationService.appendProposals`, which this shipped for) and the MCP
   * door (`add_plan_items { revision: true }`). The second is why the option is a
   * per-call DECLARATION rather than a status the method could read for itself —
   * D1's condition is that the append declares itself a revision, and the MCP
   * caller is the one that has to type it.
   *
   * ⚠️ AND A REVISION RUNS ONE GATE AN ORDINARY APPEND DOES NOT — see the block
   * in the body. It is the CLOSE's gate, owed because a revision is the only
   * append with no close still coming.
   *
   * **The condition is VISIBILITY, not status.** The `generating` assertion was
   * never about generation — it is the guarantee that a plan under review does
   * not change under its reviewer without their knowing, which was correct for as
   * long as every write door was invisible. A revision's append writes its
   * `appended` row on MOTIR-3532's trail with the harness and model that made it,
   * exactly as the correction door does, so the property the assertion protects
   * still holds. The relaxation is bound to the trail write, not to the caller's
   * identity — which is why there is nothing here to check about who is asking.
   *
   * `markPlanned` is NOT relaxed: a revision does not re-open a plan, and the
   * plan is `planned` before, during and after one.
   */
  async addProposals(
    planId: string,
    incoming: ProposalInput[],
    ctx: ServiceContext,
    opts: { revision?: boolean } = {},
  ): Promise<PlanWithItemsAndWarningsDto & { appendedItemIds: string[] }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');
    if (opts.revision) assertPlanProposalsEditable(plan);
    else if (plan.status !== 'generating') throw new PlanNotGeneratingError(planId, plan.status);
    // The sections INPUT is rendered into each `add`'s `descriptionMd` and stripped
    // BEFORE any gate below reads a proposal (MOTIR-9030), so every gate judges the
    // proposal as it will be stored and `proposals` never carries a `sections` key.
    //
    // The edge lists are split first (MOTIR-9827): a `{ ref, reason }` entry in an
    // `add`'s `blockedByRefs` or a `modify`'s `patch.blockedByAdd` becomes a bare
    // ref plus an `edgeReasons` entry, so every gate below reads the `string[]` it
    // always has.
    const proposals = incoming.map(normalizeProposalEdges).map(resolveProposalSections);
    proposals.forEach(validateProposal);
    proposals.forEach((p) =>
      assertEdgeReasonsKeyed(p, proposalLabel({ op: p.op, workItemId: p.workItemId })),
    );

    // ⚠️ THE CLOSE'S OWN GATE, FOR THE ONE APPEND THAT HAS NO CLOSE LEFT
    // (MOTIR-4153). Read the append's own gate comment below: it deliberately
    // omits the arm that needs `liveById` — a real work-item id resolving to
    // nothing — "because the read is not free and a plan may legitimately
    // reference an item created between the two". The two are the append and
    // `markPlanned`, and that argument holds for exactly as long as a close is
    // still coming. A REVISION appends to a plan that already closed, so the
    // omitted arm would never run again and a `modify` naming a deleted work item
    // would be met by whoever pressed Approve.
    //
    // This is MOTIR-3936's finding one door over, and it takes MOTIR-3936's own
    // remedy rather than a second one: the same `assertCorrectionKeepsPlanApprovable`
    // the correction doors run, on the same BEFORE/AFTER basis, so a plan that was
    // ALREADY unapprovable can still be repaired by the append that repairs it.
    //
    // Resolved OUT HERE, and ONLY for a revision: `getTerminalStatusKeys` opens
    // its own workspace context and Prisma cannot nest interactive transactions
    // (the reason `markPlanned`, `approvePlan` and `correctProposal` all resolve
    // it before their transactions open), and an ordinary append must pay nothing
    // for a door it does not use.
    const revisionTerminalStatusKeys = opts.revision
      ? await workflowsService.getTerminalStatusKeys(plan.projectId, ctx.workspaceId)
      : null;

    // ⚠️ WHO HOLDS THIS PLAN'S TARGETS — the SESSION, or the PLAN (MOTIR-5645,
    // amended by MOTIR-5648's E2E evidence).
    //
    // A plan produced by a planning CONVERSATION is already held: the session
    // acquires its anchors when it opens and gives them back when the plan is
    // decided (MOTIR-2786). Such a plan parks NOTHING — the session is the
    // holder, and a second lock for one actor is what broke the shipped
    // "describe, refine, approve" loop.
    //
    // ⚠️ AND THE CASE THAT PROVED IT IS THE REFINE. One conversation produces
    // SUCCESSIVE plans over the same targets — that is what refining IS — so
    // treating each plan as its own holder made a conversation collide with
    // itself: `PlanTargetLockedError` on the second submit, in the browser, on
    // the user's own anchor. Five at-scale E2E cases caught it
    // (`cloud-plan-change-conversation.spec.ts`,
    // `cloud-contextual-plan-confirm.spec.ts`). The two plans are ONE actor and
    // the session is the thing that says so.
    //
    // A plan with NO session parks its own targets, and that is the whole of the
    // reported bug: `create_plan` / `add_plan_items` through the MCP, which is
    // every runbook planning pass.
    //
    // ⚠️ SINCE AMENDMENT 17 §5 EVERY PLAN HAS A SESSION, so "resolves to NO
    // session" now reads "resolves to no CONVERSATION" (MOTIR-6022). The
    // session a door opens for `create_plan`, an expand, a generation or a
    // cadence plan holds no target leases — nothing acquires for it — so it is
    // not a holder, and its plan parks its own targets exactly as before.
    // Testing the column alone would silently turn every MCP plan back into the
    // park-nothing bug AMENDMENT 16 fixed.
    const planSession = plan.sessionId
      ? await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
          planChangeSessionRepository.findByIdInProject(
            plan.sessionId!,
            plan.projectId,
            ctx.workspaceId,
            tx,
          ),
        )
      : null;
    const sessionHoldingThisPlan = planSession?.origin === 'conversation' ? planSession : null;
    const planTargets = sessionHoldingThisPlan ? [] : committedPlanTargets(proposals);

    // The park's TERMINAL SET, resolved OUT HERE for the reason the block above
    // gives: `getTerminalStatusKeys` opens its own workspace context and Prisma
    // cannot nest interactive transactions.
    //
    // The park needs it because a terminal target is NEVER parked (AMENDMENT 16
    // D2) and nothing before the park refuses one: `validatePlanProposals`'s
    // `PlanTargetImmutableError` needs `liveById` and so runs at the CLOSE, not
    // at the append. MOTIR-5645's card asserted otherwise; it was falsified by
    // `tests/planning/planTargetParkDoor.test.ts`, which is why that test exists.
    const parkTerminalStatusKeys =
      planTargets.length > 0 && !revisionTerminalStatusKeys
        ? await workflowsService.getTerminalStatusKeys(plan.projectId, ctx.workspaceId)
        : (revisionTerminalStatusKeys ?? new Set<string>());

    let result: { row: Plan; items: PlanItem[]; appendedItemIds: string[] };
    try {
      result = await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
        async (tx) => {
          const locked = await planRepository.lockById(planId, tx);
          if (!locked) throw new PlanNotFoundError(planId);
          const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
          if (!fresh) throw new PlanNotFoundError(planId);
          // The SAME split as the pre-transaction gate above, re-run under the
          // lock — a plan that left `generating` while this call was in flight
          // must still be refused on the ordinary path.
          if (opts.revision) assertPlanProposalsEditable(fresh);
          else if (fresh.status !== 'generating')
            throw new PlanNotGeneratingError(planId, fresh.status);

          // The plan's already-appended proposals, read under the row lock the
          // append holds — so a second call cannot observe a stale set.
          //
          // ⚠️ READ UNCONDITIONALLY (MOTIR-3573). It used to be skipped when the
          // batch neither targeted anything existing nor carried a temp-ref —
          // right while its only readers were the duplicate-target check and
          // MOTIR-3539's temp-ref resolution, both of which are no-ops for such
          // a batch. The self-consistency gate below is not: it judges the
          // plan's WHOLE ref graph, and a duplicate edge or a `parentRef` cycle
          // can be CLOSED by the proposal being added, which a batch-only view
          // cannot see. So the read is now owed on every append, and the two
          // conditions it used to be gated on are gone.
          const existing = await planItemRepository.findByPlan(planId, tx);
          const carriesTempRef = proposals.some((p) => tempRefsOf(refCarrier(p)).length > 0);

          // ⚠️ ONE PROPOSAL PER EXISTING TARGET — and a second `modify` of one
          // card now MERGES into it (AMENDMENT 18 §2, MOTIR-6051). Decided HERE,
          // before any gate, so every gate below judges the MERGED patch rather
          // than either half alone: a `parentRef` from one call and a
          // `blockedByAdd` from another can close a cycle neither closes on its
          // own. Every other pairing on one target still throws
          // `DuplicatePlanTargetError`, before the first insert.
          const fold = foldAppend(existing, proposals);
          const effectiveNodes: ProposalNode[] = [
            ...existing.map((row) => {
              const merged = fold.mergedExisting.get(row.id);
              const node = toProposalNode(row);
              return merged ? { ...node, patch: merged as ProposalNode['patch'] } : node;
            }),
            ...proposals.flatMap((p, index) => {
              if (fold.dispositions[index]!.kind !== 'insert') return [];
              const node = toIncomingProposalNode(p, index);
              const merged = fold.mergedIncoming.get(index);
              return [merged ? { ...node, patch: merged as ProposalNode['patch'] } : node];
            }),
          ];

          // THE PURE REF-GRAPH GATE, AT THE APPEND (MOTIR-3573). Everything
          // knowable about a proposal set WITHOUT a workspace read runs here,
          // before the first insert, so the author is told while the plan is
          // still theirs to fix. The same function runs again inside
          // `approvePlan`'s gate, which is what stops the two from disagreeing.
          //
          // What deliberately does NOT run here is the arm that needs
          // `liveById`: a real work-item id that resolves to nothing is left to
          // `markPlanned` (the close), because the read is not free and a plan
          // may legitimately reference an item created between the two.
          //
          // A rejection escapes as itself — `containPrismaFailure` re-throws
          // anything that is not a Prisma error — so the caller is told its
          // proposals ARE at fault, which `PlanPersistenceError` would deny.
          assertProposalSetSelfConsistent(effectiveNodes);

          // The LEVEL of every edge this batch writes (Story MOTIR-6015 ·
          // MOTIR-6367) — refused here, where the edge is written, rather than
          // left for the reviewer to meet at approve. Judged over the batch's own
          // inserts and the existing rows it merged into.
          await assertBlockedByLevelsAtAppend(
            effectiveNodes,
            new Set([
              ...fold.mergedExisting.keys(),
              ...proposals.flatMap((_, index) =>
                fold.dispositions[index]!.kind === 'insert'
                  ? [`${INCOMING_PROPOSAL_ID_PREFIX}${index}`]
                  : [],
              ),
            ]),
            ctx,
            fresh.projectId,
            tx,
          );

          // A `blocked_by` CYCLE on a GENERATING plan (MOTIR-9267) — refused here,
          // where the edge is written, with the close's own error. A revision
          // append already runs the close's whole gate below.
          if (fresh.status === 'generating') {
            await assertBlockedByAcyclicAtAppend(
              effectiveNodes,
              new Set([
                ...fold.mergedExisting.keys(),
                ...proposals.flatMap((_, index) =>
                  fold.dispositions[index]!.kind === 'insert'
                    ? [`${INCOMING_PROPOSAL_ID_PREFIX}${index}`]
                    : [],
                ),
              ]),
              ctx,
              fresh.projectId,
              tx,
            );
          }

          // A `supersedes` CYCLE (MOTIR-6630) — refused here, where the edge is
          // written: the database never refuses one, and a ring cannot become
          // legal later. One closure read, only when the plan draws such an edge.
          await assertSupersedesAcyclicAtAppend(effectiveNodes, ctx, fresh.projectId, tx);

          // The container half of a `modify`'s DIFFICULTY (MOTIR-6133) and STEPS
          // (MOTIR-8668), which `validateProposal` could not judge without the
          // target's kind. Costs one batched read, and only when the batch sets one.
          await assertModifyLeafFieldsLegalAtAppend(proposals, ctx, fresh.projectId, tx);

          // The FINISHED-TARGET rule for a `modify` that sets a mark (MOTIR-6663),
          // which `validateProposal` could not judge without the target's live
          // status category. One batched read, only when the batch sets a mark.
          await assertMarkTargetsFinishedAtAppend(proposals, ctx, fresh.projectId, tx);

          // ⚠️ REFUSE AN UNRESOLVABLE `planItem:` REF HERE, WHERE IT IS WRITTEN
          // (MOTIR-3539) — before the first row of the batch is inserted, so a
          // refusal leaves the plan byte-identical rather than half-appended.
          // `add_plan_items` returns its ids POSITIONALLY, so a partial append
          // would desynchronise the caller's own id map, which is a worse
          // artifact than the one being refused.
          //
          // The resolvable set is the plan's ALREADY-PERSISTED `add`s: a ref to a
          // proposal in the SAME batch is refused, because its id does not exist
          // until this call returns. That is precisely the mistake this card was
          // written from.
          //
          // `resolveRef` at materialize is UNCHANGED and stays the backstop for
          // every plan appended before this shipped.
          if (carriesTempRef) {
            const resolvable = new Set(existing.filter((i) => i.op === 'add').map((i) => i.id));
            assertTempRefsResolvable(
              proposals.map(refCarrier),
              resolvable,
              (ref, proposal) => new UnresolvedPlanRefError(ref, proposal),
            );
          }

          // The bodies' `motir-ref:planItem:<id>` LINKS, resolved the same way
          // (bug MOTIR-9175): a well-formed link to an id the plan does not hold
          // is refused here rather than shipped as dead text at approve. Same
          // resolvable set as the structural refs above, so the two cannot
          // disagree about what "on the plan" means.
          const resolvableBodyRefIds = new Set(
            existing.filter((i) => i.op === 'add').map((i) => i.id),
          );
          for (const p of proposals) {
            const bodies = p.op === 'add' ? p.proposedFields : p.op === 'modify' ? p.patch : null;
            if (!bodies) continue;
            assertBodyRefsResolve(
              bodies,
              resolvableBodyRefIds,
              proposalLabel({ op: p.op, workItemId: p.workItemId, title: p.proposedFields?.title }),
            );
          }

          // ⚠️ THE RE-PARENT GATE, AT THE APPEND (MOTIR-3859) — and it is the one
          // check on this path that COSTS A WORKSPACE READ, so it is worth saying
          // why it is here rather than left to the close.
          //
          // The header on the pure gate above says what deliberately does NOT run
          // at the append: the arm that needs `liveById`, because the read is not
          // free and a plan may legitimately reference an item created between
          // the append and the close. A re-parent is the case that argument does
          // NOT cover. Its five questions are about a live row that has to exist
          // ALREADY — a proposal is refused as a parent outright — so nothing a
          // later call does can turn an illegal move into a legal one, which is
          // exactly `assertTempRefsResolvable`'s own argument for refusing where
          // the ref is written. And the alternative is the worst version: the DB
          // triggers catch a cycle or an over-deep move mid-`materialize`, as a
          // raw SQLSTATE inside `PlanPersistenceError`, at the approve button,
          // where the plan is immutable and the only repair is to author a new one.
          //
          // It is skipped entirely — no read, no terminal-status lookup — when no
          // proposal in the batch carries `patch.parentRef`, which is every plan
          // that does not use the key.
          const withIncoming = effectiveNodes;
          if (anyReparent(withIncoming)) {
            await assertReparentsLegalAtAppend(withIncoming, ctx, fresh.projectId, tx);
          }

          // ⚠️ THE RE-KIND GATE, AT THE APPEND (bug MOTIR-8192 · AMENDMENT 25) —
          // for the re-parent gate's own reason: a re-kind is judged against
          // committed rows that exist already, so the author hears about an
          // illegal one while the plan is still theirs. Skipped, with no read,
          // when no proposal on the plan carries `patch.kind`.
          await assertKindChangesLegalAtAppend(withIncoming, ctx, fresh.projectId, tx);

          // ⚠️ THE FOLDER GATE, AT THE APPEND (MOTIR-5414) — the second check on
          // this path that costs a read, and skipped entirely unless some
          // proposal on the plan files into a folder.
          if (collectReferencedFolderIds(withIncoming).length > 0) {
            await assertFolderPlacementsLegalAtAppend(withIncoming, ctx, fresh.projectId, tx);
          }

          // ⚠️ THE BASE-REVISION GATE, AT THE APPEND (MOTIR-9603) — a value that
          // is not a revision of its target is refused, and a real one is
          // resolved to the anchor the staleness rule compares against. Before
          // the park, which writes nothing this resolution reads.
          const baseRevisions = await resolveBaseRevisionsAtAppend(proposals, tx);

          // ⚠️ PARK THE PLAN'S COMMITTED TARGETS — BEFORE THE FIRST INSERT
          // (MOTIR-5645; `docs/decisions/agent-authored-plans.md` AMENDMENT 16
          // D1). This is the ONE park door: every authoring path reaches the
          // tree through this method — the MCP's `create_plan` /
          // `add_plan_items` via `authorPlan`, and generation, `expand_item` and
          // every motir-ai job via `aiGenerationService.appendProposals` — so
          // parking here covers the doors that exist and the ones added later,
          // with no per-caller rule to keep in step.
          //
          // BEFORE the inserts, so a refusal leaves the plan byte-identical, the
          // same property `assertTempRefsResolvable` above is placed for. And
          // INSIDE this transaction, so the park and the proposals it guards
          // commit or roll back together: a plan that parked a card and then
          // failed to append would hold it for a day.
          //
          // A target held by ANOTHER plan or session raises
          // `PlanTargetLockedError` from here, naming the holder — the same
          // refusal two planning conversations have always given each other, now
          // reaching the doors that never took the lock.
          await planTargetLockService.acquireForPlanWithin(
            planId,
            planTargets,
            parkTerminalStatusKeys,
            { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: fresh.projectId },
            new Date(),
            tx,
          );

          // The id each incoming proposal ended as, in input order — a merged
          // one reports the SURVIVING row, so a caller mapping ids by position
          // still gets a real id (AMENDMENT 18 §2).
          const appendedItemIds: string[] = [];
          const inserted: ProposalInput[] = [];
          const reasons = foldEdgeReasons(existing, proposals, fold);
          for (const [index, p] of proposals.entries()) {
            const disposition = fold.dispositions[index]!;
            if (disposition.kind === 'mergeExisting') {
              appendedItemIds.push(disposition.rowId);
              continue;
            }
            if (disposition.kind === 'mergeBatch') {
              appendedItemIds.push(appendedItemIds[disposition.index]!);
              continue;
            }
            const patch = p.op === 'modify' ? (fold.mergedIncoming.get(index) ?? p.patch) : p.patch;
            const data: PlanItemCreateInput = {
              workspaceId: ctx.workspaceId,
              planId,
              op: p.op,
              workItemId: p.op === 'add' ? null : (p.workItemId ?? null),
              parentRef: p.parentRef ?? null,
              blockedByRefs: p.blockedByRefs ?? [],
              edgeReasons: pickEdgeReasons(
                reasons.forInsert.get(index),
                proposalEdgeRefs({ op: p.op, blockedByRefs: p.blockedByRefs, patch }),
              ),
              supersedesRefs: p.op === 'add' ? (p.supersedesRefs ?? []) : [],
              baseRevision: baseRevisions.get(index) ?? p.baseRevision ?? null,
              reason: p.op === 'remove' && p.reason ? p.reason.trim() : null,
              ...(p.op === 'add' && p.proposedFields
                ? {
                    proposedFields: withProposalLanguages(
                      p.proposedFields,
                      p.languages,
                    ) as unknown as Prisma.InputJsonValue,
                  }
                : {}),
              ...(p.op === 'modify' && patch
                ? { patch: patch as unknown as Prisma.InputJsonValue }
                : {}),
            };
            appendedItemIds.push((await planItemRepository.create(data, tx)).id);
            inserted.push(p);
          }

          // The merges INTO rows the plan already held: one write per row, with
          // the fully-merged patch. The row's `baseRevision` is left alone — the
          // EARLIER anchor is kept, so drift is measured from the revision the
          // plan first read the card at.
          for (const [rowId, merged] of fold.mergedExisting) {
            await planItemRepository.update(
              rowId,
              {
                patch: merged as unknown as Prisma.InputJsonValue,
                edgeReasons: pickEdgeReasons(
                  reasons.forExisting.get(rowId),
                  merged.blockedByAdd ?? [],
                ),
              },
              tx,
            );
          }

          // The gate the header above argues for — after the inserts, so it
          // judges the plan the reviewer would meet, and inside the transaction,
          // so a throw rolls every one of them back and the plan is left byte-
          // identical.
          if (revisionTerminalStatusKeys) {
            await assertCorrectionKeepsPlanApprovable(
              existing,
              await planItemRepository.findByPlan(planId, tx),
              ctx,
              revisionTerminalStatusKeys,
              fresh.projectId,
              tx,
            );
          }

          // ONE row for the whole batch, in the same transaction (MOTIR-3535).
          // An append is ONE ACT however many proposals it carries — the reader's
          // question is "what arrived, and who sent it", not "how many INSERTs
          // ran" — so the count lives in the diff rather than in the row count.
          //
          // ⚠️ EXCEPT AN EMPTY BATCH, WHICH IS NOT A CONTENT MUTATION AT ALL
          // (MOTIR-3538). The MCP's CLOSE is `add_plan_items { final: true }` with
          // NO proposals: it goes through here, inserts nothing, and hands off to
          // `markPlanned` — which writes its own `planned` row. Recording this one
          // too would put *"0 proposals appended"* on the timeline of every plan
          // authored through that door, immediately above the close it belongs to.
          // The trail records what CHANGED; nothing did.
          if (inserted.length > 0) {
            await planRevisionsService.recordRevision(
              {
                planId,
                changeKind: 'appended',
                ...generationActor(fresh, ctx),
                diff: {
                  proposalCount: inserted.length,
                  ops: {
                    add: inserted.filter((p) => p.op === 'add').length,
                    modify: inserted.filter((p) => p.op === 'modify').length,
                    remove: inserted.filter((p) => p.op === 'remove').length,
                  },
                },
              },
              tx,
            );
          }
          // A merge WIDENS a proposal already on the plan, so it lands on the
          // timeline as an EDIT of that proposal — the same verb the correction
          // doors write — not as an append a reviewer would read as a new card.
          for (const rowId of fold.mergedExisting.keys()) {
            await planRevisionsService.recordRevision(
              {
                planId,
                planItemId: rowId,
                changeKind: 'edited',
                ...generationActor(fresh, ctx),
                diff: { fields: ['patch'], proposalCount: 1, merged: true },
              },
              tx,
            );
          }
          // The plan's activity stamp (MOTIR-7822) — EVERY append, an empty one
          // included: an append is a planner alive and writing.
          await stampPlanActivity(fresh, new Date(), tx);
          const allItems = await planItemRepository.findByPlan(planId, tx);
          return { row: fresh, items: allItems, appendedItemIds };
        },
      );
    } catch (err) {
      // THE BOUNDARY, not the one path (MOTIR-3194). The check above is what
      // actually refuses a duplicate target, in words; this is what stops ANY
      // other ORM failure inside the transaction — a foreign key, a lost
      // connection, a malformed write — from reaching an agent as Prisma's own
      // prose. Everything that is not a Prisma error passes through unchanged,
      // including the typed refusals thrown a few lines up.
      throw containPrismaFailure(err, 'plan proposal append');
    }
    return withLinkWarnings(
      {
        ...toPlanWithItemsDto(result.row, result.items),
        appendedItemIds: result.appendedItemIds,
      },
      result.items,
      result.appendedItemIds,
      ctx,
    );
  },

  /**
   * WOULD THE APPROVE BUTTON ACCEPT THIS PLAN? A pure READ of the same gate
   * `approvePlan` runs, for a caller that wants the verdict without taking it
   * (MOTIR-3575).
   *
   * Returns the rejections rather than throwing, because its caller is a
   * VALIDATOR: `validate_plan` exists to be asked, and an exception is the wrong
   * shape for an answer somebody requested. Empty ⇒ the plan is approvable as it
   * stands.
   *
   * ⚠️ AT MOST ONE ENTRY. `validatePlanProposals` is fail-fast — it runs ahead of
   * a write and stops at the first violation — so this reports the first reason,
   * not every reason. Deliberately NOT changed: making the gate collect would
   * change what `approvePlan` does to satisfy a read.
   *
   * ⚠️ IT TAKES NO LOCKS AND OPENS NO TRANSACTION, which is what makes it a read
   * at all. `assertProposalsPersistable` is the locking twin and belongs only to
   * approve; the verdict here is the one `approvePlan`'s PRE-transaction pass
   * takes, and it can go stale the moment it is returned — a plan approvable now
   * can drift before anybody presses the button, which is the whole reason approve
   * re-takes it under the row locks.
   */
  async checkApprovability(
    planId: string,
    ctx: ServiceContext,
  ): Promise<PlanApprovabilityRejectionDto[]> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);

    const [items, terminalStatusKeys] = await Promise.all([
      withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        planItemRepository.findByPlan(planId, tx),
      ),
      workflowsService.getTerminalStatusKeys(plan.projectId, ctx.workspaceId),
    ]);

    try {
      await runPersistGate(items, ctx, terminalStatusKeys, plan.projectId);
      // The bodies' item links (MOTIR-10104) — approve's own second question, asked
      // the same way here so the validator and the button cannot disagree.
      const linkBlocker = await proposalLinkWarningsService.firstShippingBlocker(
        items,
        planItemLabel,
        ctx,
      );
      if (linkBlocker) throw linkBlocker;
      return [];
    } catch (err) {
      if (
        err instanceof PlanRefGraphError ||
        err instanceof PlanGrammarError ||
        err instanceof PlanTargetImmutableError
      ) {
        return [
          {
            code: err.code,
            reason: err instanceof PlanTargetImmutableError ? null : err.reason,
            item: `${TEMP_REF_PREFIX}${err.planItemId}`,
            message: err.message,
          },
        ];
      }
      // A mark on a target that is no longer finished (MOTIR-6663) — the gate
      // names the persisted proposal on the error, so it is reported like the
      // three above rather than surfacing as a fault.
      if (err instanceof InvalidProposalError && err.planItemId) {
        return [
          {
            code: err.code,
            reason: null,
            item: `${TEMP_REF_PREFIX}${err.planItemId}`,
            message: err.message,
          },
        ];
      }
      // Anything else is a real failure — a lost connection, a bug — and a
      // validator that swallowed it would answer "approvable" for a plan it never
      // managed to check.
      throw err;
    }
  },

  /**
   * Mark the generation frontier complete: `generating` → `planned`.
   *
   * ⚠️ TWO OUTCOMES, not one (MOTIR-4124). A plan holding at least one proposal
   * closes into the review queue as `planned`. A plan holding NONE is
   * DISCARDED instead — `declined` with `decisionReason: 'discarded'`, decided
   * by nobody — because `planned` means *a person is being asked to decide
   * this*, and there is nothing there to decide. Read `status` on the returned
   * DTO rather than assuming the first.
   */
  async markPlanned(
    planId: string,
    ctx: ServiceContext,
    opts: {
      productName?: string | null;
      summary?: string | null;
      revision?: boolean;
      /** The job's resolved planning model (Bug MOTIR-8420); see the write below. */
      authorModel?: string | null;
    } = {},
  ): Promise<PlanDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    // The AI-suggested project name (MOTIR-1554/1551) rides the final append and
    // ONLY the onboarding generation. Persist it when present; a non-onboarding
    // (reconciliation) run sends none, so the column stays null and no rename
    // ever fires at approve. Trim + collapse to a clean value, else leave unset.
    const productName =
      typeof opts.productName === 'string' && opts.productName.trim().length > 0
        ? opts.productName.trim()
        : null;

    // The planner's BRIEFING (Story MOTIR-8149 · Subtask MOTIR-8157), written as
    // the plan's `summary` in the SAME write as the status change below — so the
    // briefing is on the plan the moment it enters the review queue, and a
    // rejected write rolls the close back with it rather than leaving a plan
    // half-closed. The rule is `correctPlanBrief`'s (`normalizeSelfReported`): a
    // trimmed, non-empty string, else NOTHING — absent or blank leaves the plan's
    // existing summary untouched, which is what keeps an older caller
    // byte-identical. NOT `correctPlanBrief` itself: that door writes a
    // `brief_edited` row, and this is the planner's own first write, recorded by
    // the close.
    const summary = normalizeSelfReported(opts.summary);

    // THE PLANNING MODEL (Bug MOTIR-8420). motir-ai resolves it per job AFTER
    // core created this plan, so the close is the first write that can carry
    // it. Recorded only on a NATIVE plan whose column is still empty, decided
    // under the plan lock below: an `mcp` plan's self-reported model is never
    // overwritten from this seam, and the first model to close a plan wins.
    // Recorded is not exposed — `redactNativeActor` nulls it on every tenant
    // read (`work-item-provenance.md` Decision 6).
    const authorModel = normalizeSelfReported(opts.authorModel);

    // The project's TERMINAL statuses, for the close-time gate below. Resolved
    // OUT HERE because `getTerminalStatusKeys` opens its OWN workspace context
    // and Prisma cannot nest interactive transactions — the same reason
    // `approvePlan` resolves it before its transaction opens. Workflow statuses
    // are project CONFIG, not a row a concurrent write moves.
    const terminalStatusKeys = await workflowsService.getTerminalStatusKeys(
      plan.projectId,
      ctx.workspaceId,
    );

    // ⚠️ THE CONFIRMATION GATE, AT THE CLOSE (MOTIR-3573) — run BEFORE the
    // transaction opens, with NO `tx`, which is exactly `approvePlan`'s
    // pre-transaction pass (`:2124`).
    //
    // `planned` is the status that puts a plan in front of a person and hands
    // them a button, so it must not be reachable by a plan that cannot survive
    // being approved. Everything approve would reject for is KNOWABLE now — a
    // dangling ref and the kind-parent grammar cost one batched
    // workspace-scoped read — and this is the last moment the plan is still
    // editable, so a rejection is repairable rather than terminal.
    //
    // ⚠️ IT MUST NOT BE BOUND TO THE CLOSE'S OWN TRANSACTION, and that is a
    // correctness constraint rather than a convenience. `withWorkspaceContext`
    // binds `app.project_id`, and `work_item`'s project-narrowing policy reads
    // it — so a gate bound to that transaction cannot see a work item in
    // ANOTHER PROJECT of the same workspace, and a cross-project `blocked_by`
    // is legal (`link_work_items`: "targets may be in another project in the
    // same workspace") and is a first-class case for
    // `planValidityService.validateProjectedPlan`. Bound to the transaction,
    // the close would refuse plans that approve's own pre-transaction pass
    // accepts — a close STRICTER than the approve it is predicting, which is
    // the opposite of the promise this card is making. Unbound, the gate opens
    // its own workspace-scoped context and the two verdicts agree exactly.
    const preItems = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(planId, tx),
    );
    await runPersistGate(preItems, ctx, terminalStatusKeys, plan.projectId);

    const { row, count } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        if (fresh.status !== 'generating') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'generating');
        }

        // The PURE half again, under the plan lock, over the set as it stands
        // NOW. It needs no read, so unlike the gate above it can run bound to
        // this transaction — which closes the window between the
        // pre-transaction verdict and the lock for everything a proposal set
        // can say about itself. The arms that need a workspace read stay
        // outside, and `approvePlan` re-runs all of them under the row locks
        // anyway, which is the check no close-time pass can replace: whether
        // the world moved WHILE the plan waited.
        const proposals = await planItemRepository.findByPlan(planId, tx);
        assertProposalSetSelfConsistent(proposals.map(toProposalNode));

        const modelWrite =
          authorModel != null && fresh.authorSource === 'native' && fresh.authorModel == null
            ? { authorModel }
            : {};

        // ⚠️ A CLOSE OVER *NOTHING* IS A DECISION, NOT A REVIEW REQUEST
        // (MOTIR-4124). `planned` is the status that puts a plan in front of a
        // person and hands them a button (MOTIR-3560), and a plan proposing
        // zero items asks for a decision there is nothing to make — so it must
        // not wear it. Everything above this line is a gate over a proposal
        // SET; over the empty set every one of them passes vacuously, which is
        // exactly why the count has to be read here rather than trusted to
        // them.
        //
        // WHY `declined` + `discarded` rather than a refusal: refusing the
        // close would leave the plan `generating`, which is the state
        // MOTIR-3193 relaxed the empty final batch to escape — a pass that has
        // finished writing and cannot say so. And `discarded` is already the
        // recorded meaning of *a plan that ended without proposals ever being
        // written* (`lib/dto/plans.ts`; `declinePlan` stamps it for exactly the
        // `generating` origin). So the ending is expressible with the
        // vocabulary MOTIR-3189 shipped, and needs no sixth status.
        //
        // `decidedById` is NULL and `plannedAt` is left unstamped, both
        // deliberately: nobody decided this — the producer finished with
        // nothing — and the frontier never became something a person was asked
        // to read, which is the fact `plannedAt` records.
        //
        // ⚠️ IT STAYS ON THE AUTHOR KEY (`ai:view_plan`), not `ai:decide_plan`.
        // That split is *who decides someone's proposals* versus *who writes to
        // a plan* — and there are no proposals here to decide. This is the
        // producer recording how its own pass ended, which is the same act the
        // `planned` branch performs.
        if (proposals.length === 0) {
          const discarded = await planRepository.update(
            planId,
            {
              status: 'declined',
              decidedAt: new Date(),
              decidedById: null,
              decisionReason: 'discarded',
              ...(productName != null ? { productName } : {}),
              ...(summary != null ? { summary } : {}),
              ...modelWrite,
            },
            tx,
          );
          await planRevisionsService.recordRevision(
            {
              planId,
              changeKind: 'declined',
              ...generationActor(fresh, ctx),
              diff: {
                itemCount: 0,
                decisionReason: 'discarded',
                ...(productName != null ? { productName } : {}),
              },
            },
            tx,
          );
          return { row: discarded, count: 0 };
        }

        const updated = await planRepository.update(
          planId,
          {
            status: 'planned',
            plannedAt: new Date(),
            ...(productName != null ? { productName } : {}),
            ...(summary != null ? { summary } : {}),
            ...modelWrite,
          },
          tx,
        );
        const n = await planItemRepository.countByPlan(planId, tx);
        // THE QUESTION IS ASKED WITH THE STATUS (MOTIR-6036; ADR approval-gates.md
        // §11.7): the plan's `awaiting` gate, in this transaction and under the
        // plan lock taken above, so a plan is never `planned` without it.
        await planGateService.raise(updated, tx);
        // The close, on the trail (MOTIR-3535) — the moment the plan stopped
        // moving and became something a person is asked to read. The count is
        // what that person is being asked to approve.
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: 'planned',
            ...generationActor(fresh, ctx),
            diff: { itemCount: n, ...(productName != null ? { productName } : {}) },
          },
          tx,
        );
        return { row: updated, count: n };
      },
    );

    // WHAT THE RUN PRODUCED (MOTIR-3981, `run-findings-protocol.md` Q5). A plan
    // CREATED while a dispatched agent's leg was open is that run's finding —
    // whenever it reaches `planned`, which is usually after the leg settled
    // (MOTIR-6279) — the ASK the record could describe but never name, which is
    // why `batchPlan.ts`'s skip label promises "a re-plan is waiting for you in
    // Motir" and cannot say which one.
    //
    // ⚠️ ANCHORED, NOT GUESSED, and every hop is the one
    // `approvePlanForWorkItem` already walks — in reverse. The plan's source job
    // identifies the plan-change session; the session's `scopeKey` IS its anchor
    // set (`buildScope` joins the sorted keys, so it reads straight back). A
    // dispatched agent's `submit_plan_session` thread (`targetKeys: [<KEY>]`,
    // MOTIR-4083) is anchored at exactly one key, and that is the only shape
    // recorded: the project-wide scope is empty and a
    // multi-anchor thread names no single leg, so both are skipped rather than
    // attributed to whichever member happened to sort first.
    //
    // Post-commit and best-effort: the plan is `planned` and stays `planned`
    // whatever happens here. `recordFinding` swallows its own failures.
    //
    // ⚠️ THE EMPTY CLOSE RECORDS NO FINDING (MOTIR-4124). This finding is the
    // ASK — *a plan is waiting for you in Motir* — and there is nothing waiting:
    // the plan is decided before this line runs. Recording one would put a
    // pointer to a discarded plan on a run's leg.
    //
    // ⚠️ NOR DOES THE CLOSE OF A REVISION (Bug MOTIR-8208): the plan was the run's
    // finding when it first closed, and a revision re-opening and closing it again
    // is the same plan, not a second one waiting.
    if (row.status === 'planned') {
      if (!opts.revision) await recordSubmittedPlanFinding(row, count, ctx);
    } else {
      // A discarded close is as terminal as a decline, so it releases the
      // planning-target locks the same way `declinePlan` does. A plan with zero
      // proposals usually holds none — but a `modify` that was appended and
      // then WITHDRAWN leaves the plan empty with its target still leased, and
      // that lease would otherwise sit out its expiry blocking a colleague.
      await releasePlanTargetLocks(row, ctx);
    }

    return toPlanDto(row, count);
  },

  /**
   * A project's plans, newest first, cursor-paginated (the list view).
   *
   * `opts.status` narrows the page to ONE lifecycle status — the tabbed list's
   * read (MOTIR-3235) — or to a SET of them (MOTIR-4106), which is what a
   * lifecycle QUESTION needs rather than a tab. Omitted, the page is the whole
   * project exactly as it was before the option existed; the predicate is
   * applied in the repository's `where` in both forms, so a narrowed page is a
   * full page rather than a filtered remnant of one.
   */
  async listPlans(
    projectId: string,
    ctx: ServiceContext,
    opts: ListPlansOptions = {},
  ): Promise<PlanListPageDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const limit = clampLimit(opts.limit);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.listByProject(
        projectId,
        ctx.workspaceId,
        limit + 1,
        opts.cursor ?? null,
        tx,
        opts.status ?? null,
      ),
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const counts = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.countByPlanIds(
        page.map((p) => p.id),
        tx,
      ),
    );
    return {
      plans: page.map((p) => toPlanDto(p, counts.get(p.id) ?? 0)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  },

  /**
   * How many plans this project holds in EACH lifecycle status (MOTIR-3235) —
   * the numbers the tab strip renders beside its four labels.
   *
   * ONE `groupBy` for the whole strip, zero-filled here so the result is TOTAL
   * over `PlanStatusDto`: a status the project has no rows in reads `0`, never
   * an absent key. A caller rendering `{counts[tab]}` can therefore never print
   * `undefined`, and a status added to the vocabulary later appears as a zero
   * rather than as a hole, because the fill iterates `PLAN_STATUS_DTO_VALUES`
   * (which the type is derived from).
   *
   * Read-only, gated on `canBrowse` and run in the workspace context like every
   * other plan read.
   */
  async countPlansByStatus(projectId: string, ctx: ServiceContext): Promise<PlanStatusCountsDto> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.countByStatus(projectId, ctx.workspaceId, tx),
    );
    const counts = Object.fromEntries(
      PLAN_STATUS_DTO_VALUES.map((status) => [status, 0]),
    ) as PlanStatusCountsDto;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  },

  /**
   * The still-UNDECIDED plan a job produced, by id — or `null` (MOTIR-1745).
   *
   * The RESUME half of the `{ jobId, planId }` pair a submit returns: a caller
   * that comes back to a thread holds only the job it last submitted, and needs
   * the Plan awaiting confirmation to address it. Resolves through the plan's
   * `sourceJobId` binding (the same one the proposal callbacks resolve on).
   *
   * `null` — never an error — in all three "nothing to confirm" cases: no plan
   * for that job, a plan belonging to another project in the workspace (a job id
   * never addresses across projects), or one already `approved` / `declined`. A
   * decided plan is history, so surfacing it as pending would invite a confirm
   * of something already settled. `generating` and `planned` both count as
   * pending: the rail legitimately re-attaches to a run still in flight.
   *
   * Read-only, gated on `canBrowse` like every other plan read.
   */
  async findPendingPlanIdForJob(
    projectId: string,
    jobId: string,
    ctx: ServiceContext,
  ): Promise<string | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) return null;
    if (plan.status === 'approved' || plan.status === 'declined') return null;
    return plan.id;
  },

  /**
   * A SESSION's still-undecided plan (MOTIR-6023; AMENDMENT 17 §5) — the
   * by-session sibling of {@link findPendingPlanIdForJob}, reading the COLUMN:
   * the session's latest plan, when it is not yet decided. Browse-gated; a
   * session of another project answers `null`.
   */
  async findPendingPlanIdForSession(
    projectId: string,
    sessionId: string,
    ctx: ServiceContext,
  ): Promise<string | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findLatestBySession(sessionId, tx),
    );
    if (!plan || plan.projectId !== projectId) return null;
    if (plan.status === 'approved' || plan.status === 'declined') return null;
    return plan.id;
  },

  /**
   * A SESSION's latest plan id, REGARDLESS of decision state (MOTIR-7997) — the
   * outcome-read sibling of {@link plansService.findPendingPlanIdForSession}, which
   * hides a decided plan because its caller offers a confirm. A late change asks
   * "which plan did this conversation produce, and what became of it?", and a
   * decided plan is a perfectly good answer. Browse-gated; a session of another
   * project answers `null`.
   */
  async findLatestPlanIdForSession(
    projectId: string,
    sessionId: string,
    ctx: ServiceContext,
  ): Promise<string | null> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findLatestBySession(sessionId, tx),
    );
    if (!plan || plan.projectId !== projectId) return null;
    return plan.id;
  },

  /**
   * The plan a job produced, by job id — REGARDLESS of decision state
   * (MOTIR-1825). The OUTCOME-read sibling of
   * {@link plansService.findPendingPlanIdForJob}, which deliberately hides an
   * already-decided plan because its caller is offering a CONFIRM. This caller
   * is asking a different question — "what became of the job I fired?" — and an
   * approved or declined plan is a perfectly good, in fact final, answer. Hiding
   * it would report a settled job as missing.
   *
   * Takes no `projectId`: a job id addresses one plan, and the read is already
   * workspace-scoped by the repository plus `canBrowse`-gated on the plan's own
   * project — so a job from another tenant is an indistinguishable `null`, the
   * same no-existence-leak contract the pending sibling keeps.
   */
  async findPlanIdForJob(jobId: string, ctx: ServiceContext): Promise<string | null> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx),
    );
    if (!plan) return null;
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    return plan.id;
  },

  /** A plan + its bundled proposal items (the detail view). The lifecycle
   *  timestamps + decider on the returned plan ARE the history surface. */
  async getPlan(planId: string, ctx: ServiceContext): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    const items = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(planId, tx),
    );
    return toPlanWithItemsDto(plan, items);
  },

  /**
   * ONE plan, for a READER — `getPlan` plus the Plans room's record-level admit
   * (Story MOTIR-6179 · MOTIR-6330).
   *
   * Browse is the floor, as in `getPlan`. On top of it the plan is admitted when
   * the reader holds `plan:view_any` (on a bearer token: in its grant too —
   * `holdsRecordView`), or when it is in the reader's `mine` set — its session is
   * one the room's Mine view lists (`planSessionsService`), or, for a plan with no
   * session, the reader asked for it, decided it, or has it routed to them.
   * Otherwise it throws the SAME `PlanNotFoundError` an unknown id throws, so the
   * answer confirms nothing about a plan the reader may not see.
   *
   * ⚠️ ACTOR-FACING CALLERS ONLY — a page, a route, an MCP read. `getPlan` stays
   * browse-only for the SYSTEM callers (the return of an approve / decline /
   * generation / edit that already passed its own door), which must not start
   * 404ing a plan the actor just acted on. The caller list is in MOTIR-6330's PR.
   */
  async getPlanForReader(planId: string, ctx: ServiceContext): Promise<PlanWithItemsDto> {
    const plan = await plansService.admitPlanReader(planId, ctx);
    return plansService.loadAdmittedPlanWithItems(plan, ctx);
  },

  /**
   * The ITEM half of {@link getPlanForReader} (MOTIR-8127): the plan with every proposal, for a
   * plan row {@link admitPlanReader} has ALREADY admitted. Split out so the review read can take
   * its version token between the admit and the item read; calling it on a row nobody admitted
   * is a side door past the reader gate.
   */
  async loadAdmittedPlanWithItems(
    plan: NonNullable<Awaited<ReturnType<typeof planRepository.findById>>>,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const items = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(plan.id, tx),
    );
    return toPlanWithItemsDto(plan, items);
  },

  /**
   * The ADMIT half of {@link getPlanForReader}, without the item read (MOTIR-8127): the browse
   * floor and the Plans room's record-level admit, returning the plan ROW. The review's
   * conditional read needs the same refusal an unknown id gets BEFORE it may answer
   * "unchanged", and answering it must not cost the whole item set — that is the cost the
   * conditional read exists to skip. Every refusal is {@link PlanNotFoundError} (or the browse
   * denial), exactly as `getPlanForReader` throws them.
   */
  async admitPlanReader(planId: string, ctx: ServiceContext) {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    const admitted = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      readerMaySeePlan(plan, ctx, tx),
    );
    if (!admitted) throw new PlanNotFoundError(planId);
    return plan;
  },

  /**
   * Edit a proposed `add` of a `planned` plan IN PLACE (7.21.6 · MOTIR-1370) —
   * the review surface's inline edit. Patches the `add`'s `proposedFields`
   * (title/kind/priority/type/description); NO WorkItem is created (an `add`
   * stays a proposal until approve materializes it). The plan row is locked + its
   * status re-read, so an edit racing an `approve`/`decline` is rejected once the
   * plan leaves `planned` (`PlanNotInExpectedStatusError`, the same one-shot guard
   * approve uses). Only an `add` is editable — `modify`/`remove` target existing
   * items, so editing one is an `InvalidProposalError`. Returns the full
   * `PlanWithItemsDto` so the caller reflects the change without a second read.
   */
  async updateProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsAndWarningsDto> {
    return editAddProposal(planId, planItemId, input, ctx, 'review');
  },

  /**
   * Deepen a proposed `add` while the plan is still `generating` (7.4.4a ·
   * MOTIR-1441) — the generation-time twin of `updateProposal`. The 7.4 issue-
   * tree generation handler (MOTIR-844) runs the titles-first strategy
   * (MOTIR-845): Phase 1 appends title-only `add`s via `addProposals`, then
   * Phase 2 PATCHES each one's `descriptionMd` (and finalises
   * type/priority/storyPoints/estimateMinutes) ONE AT A TIME — all BEFORE
   * `markPlanned` closes the frontier, so the plan is `generating`, not
   * `planned`. Identical to `updateProposal` (sparse merge, non-empty title +
   * sizing re-validation, add-only, row-locked one-shot) EXCEPT the legal status
   * is `generating`. NO WorkItem is created. The user-facing `updateProposal`
   * (`planned`) is unchanged.
   *
   * TWO callers now, and neither is the other's fallback:
   *   • `aiGenerationService.patchProposal` — the §4 job-token seam, which
   *     resolves the plan by `sourceJobId`.
   *   • `update_plan_item` (`lib/mcp/tools/authorPlan.ts`, MOTIR-3090) — the
   *     PAT-authed door, which resolves by `planId` because an MCP-authored plan
   *     has NO generation job and `findBySourceJobId` would throw
   *     `NoPlanForJobError` for every one of them.
   */
  async deepenProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsAndWarningsDto> {
    return editAddProposal(planId, planItemId, input, ctx, 'deepen');
  },

  /**
   * REVISE a proposed `add` in place on a plan an AGENT already closed
   * (AMENDMENT 24) — `update_plan_item { revision: true }`. The same sparse
   * merge and re-validation as {@link updateProposal} and `deepenProposal`,
   * legal on `generating` AND `planned`, and recorded on the trail under the
   * AGENT (`generationActor`), never as the reviewer's own edit. The plan does
   * not re-open: it stays `planned` before, during and after, as a revision
   * append leaves it (AMENDMENT 12).
   *
   * It exists so a correction to a card's WORDS on a landed plan is an edit of
   * that card — same id, same edges, same history — rather than a withdraw and a
   * re-append, which loses all three (the runbook's archive-and-re-propose rule).
   */
  async reviseProposal(
    planId: string,
    planItemId: string,
    input: UpdateProposalInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsAndWarningsDto> {
    return editAddProposal(planId, planItemId, input, ctx, 'revise');
  },

  /**
   * Write a Sharpen write-back's managed blocks into one `add` proposal's body
   * (Task MOTIR-1101 · Subtask MOTIR-8175) — INSIDE the caller's transaction, so
   * a plan-scope write-back lands its requirement and every proposal edit
   * atomically. The same item checks, merge, re-validation and trail row as
   * every other `add` edit ({@link applyAddProposalEdit}); the caller has
   * locked the plan row, re-read it as `plan`, judged its status and gated the
   * actor, and recorded the edit is the person's (no agent triple).
   */
  async sharpenProposalBodyInTx(
    plan: Plan,
    planItemId: string,
    descriptionMd: string,
    ctx: ServiceContext,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await applyAddProposalEdit(plan, planItemId, { descriptionMd }, ctx, 'sharpen', tx);
  },

  /**
   * CORRECT THE PLAN'S OWN BRIEF — its `title` and `summary` (MOTIR-4637).
   *
   * ⚠️ THE PLAN, NOT A PROPOSAL. `correctProposal` below repairs one card ON a
   * plan; this repairs the two lines a reviewer reads ABOVE the tree, before any
   * card. They were the last write-once thing about a plan under review: every
   * other part of it had a correction door — a proposal's fields
   * (`correctProposal`), its ops, its membership (`withdrawProposal`), even its
   * SET (an append carrying `revision`) — while the two fields read FIRST could
   * only be repaired by withdrawing every proposal, which ENDS a `planned` plan
   * as `declined` / `discarded`, and re-authoring the whole thing under a new id.
   * The cheaper mistake had the more expensive remedy.
   *
   * THREE things it deliberately does NOT touch, and the tests assert each
   * directly: the plan's PROPOSALS, its STATUS, and its `plannedAt` (with the
   * staleness flags derived from it). A brief edit is a correction to what the
   * plan SAYS about itself, not a change to what it proposes — so it may not
   * re-open a closed plan, re-date it, or make a reviewer's read of the tree
   * stale.
   *
   * SPARSE, like every sibling: an omitted field is left alone and an explicit
   * `null` clears it. Sending neither is `InvalidProposalError`, the same refusal
   * `correctProposal` gives an empty correction — a call that changes nothing is
   * a caller mistake, not a no-op worth a trail row.
   *
   * ⚠️ IT IS ON THE TRAIL, and that is a DECISION rather than a convenience. A
   * `planned` plan is a thing a person is deciding about; rewriting the sentence
   * they are reading with no trace would trade one honesty problem for another.
   * The row is `brief_edited` — a verb of its own, because `edited` means *a
   * proposal changed* and the timeline renders it as a proposal count.
   *
   * Legal on `generating` AND `planned` — the same boundary AMENDMENT 8 drew for
   * the correction doors, because it is the same question: a plan being written
   * or awaiting a decision is editable, a DECIDED plan is a record.
   * `approved` / `declined` are FROZEN and the refusal names the status
   * (`PlanNotEditableError`).
   */
  async correctPlanBrief(
    planId: string,
    input: CorrectPlanBriefInput,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    // The same key the rest of the author writes assert (`addProposals` /
    // `markPlanned` / `editAddProposal` / `correctProposal`). NOT
    // `ai:decide_plan`: correcting what a plan says about itself is authoring,
    // not deciding.
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    // Built BEFORE the transaction — it reads nothing and can refuse an empty
    // call without taking the plan's row lock.
    const data: PlanUpdateInput = {};
    const touched: CorrectPlanBriefKey[] = [];
    if (input.title !== undefined) {
      data.title = normalizeSelfReported(input.title);
      touched.push('title');
    }
    if (input.summary !== undefined) {
      data.summary = normalizeSelfReported(input.summary);
      touched.push('summary');
    }
    if (input.plannerRecord !== undefined) {
      data.plannerRecord = plannerRecordValue(input.plannerRecord);
      touched.push('plannerRecord');
    }
    if (touched.length === 0) {
      throw new InvalidProposalError('A correction must change something.');
    }
    // The planner's record is not part of the heading a reviewer reads, so a
    // write of it alone is not a `brief_edited` on the timeline (MOTIR-9978).
    const briefFields = touched.filter((key) => key !== 'plannerRecord');

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        // Lock, then RE-READ under the lock — the same one-shot discipline every
        // other status-gated write on this row uses. Read before the lock the
        // gate is a TOCTOU check; read under it, a plan approved between the two
        // reads is refused rather than edited after the fact.
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);

        const updated = await planRepository.update(planId, data, tx);

        // The edit, on the plan's content trail (MOTIR-3535), in the same
        // transaction as the write it records.
        //
        // THE AGENT ACTOR, not the person — `correctProposal`'s reasoning
        // verbatim: this method exists precisely so an AGENT can reach a
        // `planned` plan, and a reviewer must be able to see WHICH harness and
        // model rewrote the sentence they were reading.
        if (briefFields.length > 0) {
          await planRevisionsService.recordRevision(
            {
              planId,
              changeKind: 'brief_edited',
              ...generationActor(fresh, ctx),
              diff: { fields: briefFields, correction: true },
            },
            tx,
          );
        }
        // The plan's activity stamp (MOTIR-7822).
        await stampPlanActivity(fresh, new Date(), tx);
        return { row: updated, items: await planItemRepository.findByPlan(planId, tx) };
      },
    );
    return toPlanWithItemsDto(row, items);
  },

  /**
   * The PLANNER's own record on a plan (MOTIR-9978) — what `get_plan` hands the
   * authoring agent beside the plan, and the only read of it: no `PlanDto`
   * carries it, so the review surface never receives it. Admits the reader
   * exactly as {@link getPlanForReader} does; `null` when the plan carries none.
   */
  async getPlannerRecord(
    planId: string,
    ctx: ServiceContext,
  ): Promise<Record<string, unknown> | null> {
    const plan = await plansService.admitPlanReader(planId, ctx);
    return isJsonObject(plan.plannerRecord) ? plan.plannerRecord : null;
  },

  /**
   * CORRECT a proposal on a `generating` or `planned` plan (Story MOTIR-3533 ·
   * Subtask MOTIR-3540) — the repair an agent that mistyped one field has never
   * had.
   *
   * ⚠️ HOW THIS DIFFERS FROM `deepenProposal` / `updateProposal`, and why it is a
   * THIRD method rather than a widening of either. Those two are one act — a
   * deepen — split by the status it is legal in, and
   * `agent-authored-plans.md` AMENDMENT 3 D3 fixed their editable set with a rule
   * that is still right: *a deepen may change what a card SAYS and who ACTS on
   * it, never where it SITS or SHIPS.* A CORRECTION is a different act. Its
   * trigger is the author discovering its own structural mistake, and its only
   * alternative today is authoring a whole second plan and asking a person to
   * decline the first. AMENDMENT 7 records the amendment; widening
   * `UpdateProposalInput` instead would have re-opened structure on the deepen
   * path too, which is the thing D3 was protecting.
   *
   * ⚠️ AND IT RE-RUNS THE APPEND'S REF CHECK (MOTIR-3539). A correction is the
   * one path that could re-introduce the defect the sibling card just closed —
   * the cure re-opening the hole the prevention shut, on a path nobody would
   * think to re-test. The resolvable set EXCLUDES the proposal being corrected,
   * so a self-reference is refused rather than accepted as a one-node cycle.
   *
   * Legal on `generating` AND `planned`; `approved` / `declined` are FROZEN and
   * the refusal names the status (`PlanNotEditableError`).
   *
   * `opts.byReviewer` (MOTIR-6631) is the HUMAN proposal-edit route
   * (`PATCH /api/plans/[id]/items/[itemId]`) reaching this method for the one
   * structural key it carries, an `add`'s `supersedesRefs`. That route edits a
   * `planned` plan on a person's behalf, so the flag narrows the legal status to
   * `planned` (the same `PlanNotInExpectedStatusError` `updateProposal` answers)
   * and records the PERSON on the trail with no agent triple — `editAddProposal`'s
   * `planned` attribution — instead of the plan's generation actor.
   */
  async correctProposal(
    planId: string,
    planItemId: string,
    input: CorrectProposalInput,
    ctx: ServiceContext,
    opts: { byReviewer?: boolean } = {},
  ): Promise<PlanWithItemsAndWarningsDto> {
    input = normalizeCorrectionEdges(input);
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    // The same key the rest of the author writes assert (`addProposals` /
    // `markPlanned` / `editAddProposal`). NOT `ai:decide_plan`: correcting a
    // proposal is authoring, not deciding.
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    // Resolved BEFORE the transaction, because it reads the project's repository
    // domain and that is a read the write lock has no business holding.
    //
    // ⚠️ AND THE AXIS MAY BE DESCRIBED ONCE (bug MOTIR-4904), through the direct
    // door's own guard — before either resolver runs, so a contradictory
    // correction is refused rather than half-resolved. The singular ROW-ID pin
    // (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924) joins the same
    // exclusivity set as the name and the SET forms.
    assertSingleTargetRepoInput(
      input.targetRepo,
      input.targetRepos,
      input.targetRepositories,
      input.targetRepositoryRef,
    );
    let resolvedTargetRepo: string | null | undefined;
    if (input.targetRepo !== undefined) {
      try {
        resolvedTargetRepo = await resolveAuthoredTargetRepoInProject(
          input.targetRepo,
          plan.projectId,
          ctx,
        );
      } catch (err) {
        if (err instanceof UnknownTargetRepoError) {
          throw new PlanItemUnknownTargetRepoError(planItemId, input.targetRepo ?? '', err.message);
        }
        throw err;
      }
    }
    // The SET forms, validated the same way and in the same slot (bug
    // MOTIR-4904). The RESOLVED names are what the proposal stores — approve
    // re-resolves them against the project domain either way, and storing the
    // resolved spelling is what makes a corrected set read back the way the
    // reviewer will see it, exactly as the singular pin above does.
    let resolvedRepoSet: ResolvedRepoSet | undefined;
    if (input.targetRepos !== undefined || input.targetRepositories !== undefined) {
      try {
        resolvedRepoSet =
          input.targetRepositories !== undefined
            ? await resolveAuthoredRepoRefsInProject(input.targetRepositories, plan.projectId, ctx)
            : await resolveAuthoredRepoPinsInProject(input.targetRepos!, plan.projectId, ctx);
      } catch (err) {
        if (err instanceof UnknownTargetRepoError || err instanceof UnknownProjectRepoRefError) {
          throw new PlanItemUnknownTargetRepoError(
            planItemId,
            (input.targetRepositories ?? input.targetRepos ?? []).join(', '),
            err instanceof Error ? err.message : String(err),
          );
        }
        throw err;
      }
    }

    // The project's TERMINAL statuses, for the post-correction gate below.
    // Resolved OUT HERE because `getTerminalStatusKeys` opens its own workspace
    // context and Prisma cannot nest interactive transactions — the same reason
    // `markPlanned` and `approvePlan` resolve it before their transactions open.
    const correctionTerminalStatusKeys = await workflowsService.getTerminalStatusKeys(
      plan.projectId,
      ctx.workspaceId,
    );

    const { row, items } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);
        if (opts.byReviewer && fresh.status !== 'planned') {
          throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
        }

        const all = await planItemRepository.findByPlan(planId, tx);
        const item = all.find((i) => i.id === planItemId);
        if (!item || item.planId !== planId) throw new PlanItemNotFoundError(planItemId);

        const data: PlanItemUpdateInput = {};
        const touched: string[] = [];

        if (item.op === 'add') {
          if (input.patch !== undefined) {
            throw new InvalidProposalError(
              'A `patch` belongs to a `modify` proposal; this proposal is an `add`.',
            );
          }
          const current = (item.proposedFields ?? {}) as unknown as PlanItemProposedFields;
          // The language statement (MOTIR-8743), the deepen's check.
          validateProposedLanguages(
            input.languages,
            proposalLabel({ op: item.op, workItemId: item.workItemId, title: current.title }),
          );
          const next = mergeProposedFields(current, input);
          // ⚠️ THE REPOSITORY AXIS IS REPLACED, NOT MERGED (bug MOTIR-4904). Every
          // other key here is sparse per KEY; these FOUR spellings are one field in
          // one axis, so correcting one CLEARS the others. Merging instead would
          // store the exact contradiction `assertSingleTargetRepoInput` refuses at
          // the append — a stale `targetRepo` beside a new `targetRepos` — and
          // approve would then have to invent a precedence rule over a state
          // nobody authored.
          if (
            resolvedTargetRepo !== undefined ||
            resolvedRepoSet !== undefined ||
            input.targetRepo !== undefined ||
            input.targetRepositoryRef !== undefined
          ) {
            delete next.targetRepo;
            delete next.targetRepos;
            delete next.targetRepositories;
            delete next.targetRepositoryRef;
          }
          if (resolvedTargetRepo !== undefined) next.targetRepo = resolvedTargetRepo;
          if (resolvedRepoSet !== undefined) {
            // Stored under the spelling the correction used, so a later reader of
            // the proposal sees which form its author chose — and, for the row-id
            // form, so the ids the author pinned survive rather than being
            // silently rewritten to the names they happen to resolve to today.
            if (input.targetRepositories !== undefined) {
              next.targetRepositories = input.targetRepositories;
            } else {
              next.targetRepos = resolvedRepoSet.names;
            }
          }
          // The singular ROW-ID half of the pin (Story MOTIR-2732 · MOTIR-3045,
          // surfaced by MOTIR-4924), stored under its own spelling for the same
          // reason the SET row-id form is: the id the author pinned survives
          // rather than being rewritten to the name it happens to resolve to
          // today. Membership of the project's row set is re-validated at approve
          // (`proposalRepoRef`'s byId check), exactly as it is on the append path.
          if (input.targetRepositoryRef !== undefined) {
            next.targetRepositoryRef = input.targetRepositoryRef;
          }
          // The ROLE half of the pin (MOTIR-3865), applied HERE rather than in
          // `mergeProposedFields` for the same reason its NAME twin is: that
          // helper is the DEEPEN turn's merge and the repo pin is deliberately
          // outside the deepen's editable set. A correction is the different act
          // AMENDMENT 7 opened, and it reaches both halves of the pin or it
          // cannot correct an ONBOARDING plan at all — such a plan pins a role
          // and no name, because its repositories do not exist yet.
          //
          // Validated against the closed VOCABULARY, exactly as the append and a
          // `modify`'s patch are, and before the write: an unrecognised role is
          // `PlanItemUnknownTargetRepoRoleError` (a typed 422 at the transport),
          // never a string smuggled into `proposedFields`. `undefined` leaves the
          // pin alone and an explicit `null` unpins — `assertKnownRepoRole` passes
          // both, which is what makes the sparse semantics expressible.
          if (input.targetRepoRole !== undefined) {
            assertKnownRepoRole(
              input.targetRepoRole,
              item.id,
              proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
            );
            next.targetRepoRole = input.targetRepoRole;
          }
          // The SUBJECT coordinate (Story MOTIR-5062 · MOTIR-5065), applied HERE
          // and NOT in `mergeProposedFields` for exactly the reason the repo pin
          // is: that helper is the DEEPEN turn's merge, and a subject is settled
          // at the `lay` beside `type` and the pin — it says which RULES an
          // authoring pass reads, which is where the card sits in the corpus
          // rather than what it says. So a deepen may not touch it and a
          // correction may, which is AMENDMENT 3 D3's rule applied rather than an
          // exception to it.
          //
          // Re-validated by the SAME shape check the append runs, so a correction
          // cannot introduce a subject the append would have refused. The KIND half
          // of both doors retired with MOTIR-5607. `undefined` leaves it alone and an explicit `null` unpins.
          // MEMBERSHIP is not checked here, in either door — the vocabulary is
          // the rule-pack file set, and this repository deliberately does not
          // hold it.
          if (input.subject !== undefined) {
            if (input.subject === null) {
              delete next.subject;
            } else {
              assertCorrectedSubjectValid(input.subject, item.id);
              next.subject = input.subject;
            }
          }
          if (!next.title?.trim()) {
            throw new InvalidProposalError('An `add` proposal requires a non-empty title.');
          }
          validateProposedSizing(next);
          // The STEPS, on the MERGED result — the same rule the deepen turn
          // applies, on the same basis (MOTIR-4616 · AMENDMENT 14 D3-D4).
          validateProposedTodos(
            next.todos,
            next.kind ?? DEFAULT_PROPOSED_KIND,
            proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
          );
          // The DIFFICULTY, on the MERGED result — the deepen's rule (MOTIR-6133).
          validateProposedDifficulty(
            next.difficulty,
            next.kind ?? DEFAULT_PROPOSED_KIND,
            proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
          );
          // A malformed item link is WARNED on the response (MOTIR-10104), and
          // the links the correction writes must name a proposal on the plan
          // (bug MOTIR-9175), judged on the bodies it writes (bug MOTIR-9836).
          assertEditBodyRefsResolve(
            current,
            input,
            next,
            new Set(all.filter((i) => i.op === 'add').map((i) => i.id)),
            proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
          );
          // A RE-KIND, held to what the new kind owes (bug MOTIR-8192 ·
          // AMENDMENT 25 §4): no leaf field on a container, and a placement the
          // plan's own tree admits — judged with this correction's parentRef.
          if (input.kind !== undefined) {
            await assertReKindedAddLegal(
              item.id,
              next,
              all.map((i) =>
                i.id === item.id
                  ? {
                      ...toProposalNode(i),
                      parentRef: input.parentRef !== undefined ? input.parentRef : i.parentRef,
                      proposedFields: next as ProposalNode['proposedFields'],
                    }
                  : toProposalNode(i),
              ),
              proposalLabel({ op: item.op, workItemId: item.workItemId, title: next.title }),
              ctx,
              plan.projectId,
              tx,
            );
          }
          data.proposedFields = next as unknown as Prisma.InputJsonValue;
          touched.push(
            ...Object.keys(input).filter(
              (k) =>
                k !== 'parentRef' &&
                k !== 'blockedByRefs' &&
                k !== 'edgeReasons' &&
                k !== 'supersedesRefs',
            ),
          );
        } else {
          // A `modify` / `remove` targets an EXISTING work item, so it carries no
          // proposed body and no pin of its own — the content keys and
          // `targetRepo` are meaningless on it rather than merely unsupported.
          const contentKeys = Object.keys(input).filter(
            (k) =>
              k !== 'patch' &&
              k !== 'blockedByRefs' &&
              k !== 'edgeReasons' &&
              k !== 'parentRef' &&
              k !== 'supersedesRefs',
          );
          if (contentKeys.length > 0) {
            throw new InvalidProposalError(
              `A \`${item.op}\` proposal has no proposed body to correct; ${contentKeys.join(', ')} apply to an \`add\`. Correct its \`patch\` instead.`,
            );
          }
          if (input.patch !== undefined) {
            if (item.op !== 'modify') {
              throw new InvalidProposalError('Only a `modify` proposal carries a `patch`.');
            }
            // The correction REPLACES the patch, so it is held to the append's
            // own key check (bug MOTIR-6259) — a correction door looser than the
            // append would be the way round it.
            assertKnownPatchKeys(
              input.patch,
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            validateStoryPoints(input.patch?.storyPoints ?? null);
            validateEstimateMinutes(input.patch?.estimateMinutes ?? null);
            // The replacement patch's language statement (MOTIR-8743).
            validateProposedLanguages(
              input.patch?.languages,
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            // The replacement patch's RE-KIND (bug MOTIR-8192), held to the
            // append's membership check here and to its tree check below.
            validateProposedKindChange(
              input.patch?.kind,
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            // The replacement patch's MARK (MOTIR-6629), held to the append's check.
            validateProposedObsolescence(
              input.patch,
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            // ...and to the append's FINISHED-TARGET rule (MOTIR-6663), against
            // the target's live status category. Asked HERE rather than left to
            // the before/after gate below, which admits a correction to a plan
            // that was already unapprovable — and a mark on an unfinished card is
            // a mistake this write introduces, not a repair of one it inherits.
            if (item.workItemId && patchSetsObsolescence(input.patch)) {
              const targetId = item.workItemId;
              await withProjectNarrowingSuspended(tx, plan.projectId, async () => {
                const [target] = await workItemRepository.findByIdsInWorkspace(
                  [targetId],
                  ctx.workspaceId,
                  tx,
                );
                if (!target) return;
                const categoryById = await resolveStatusCategories([target], ctx, tx);
                assertMarkTargetIsFinished(
                  input.patch,
                  {
                    key: target.identifier,
                    status: target.status,
                    statusCategory: categoryById.get(target.id) ?? null,
                  },
                  proposalLabel({ op: item.op, workItemId: item.workItemId }),
                );
              });
            }
            // The replacement patch's malformed links are WARNED on the response
            // (MOTIR-10104); a canonical link to no proposal is refused (MOTIR-9175).
            assertBodyRefsResolve(
              input.patch ?? {},
              new Set(all.filter((i) => i.op === 'add').map((i) => i.id)),
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            // The replacement patch's DIFFICULTY (MOTIR-6133), judged against the
            // TARGET's PROJECTED kind — the patch's re-kind when it carries one
            // (bug MOTIR-8192), else the live kind — the append's two halves in
            // one call, since the transaction is already open.
            if (input.patch?.difficulty !== undefined && input.patch?.difficulty !== null) {
              const target = item.workItemId
                ? await workItemRepository.findById(item.workItemId, tx)
                : null;
              validateProposedDifficulty(
                input.patch.difficulty,
                input.patch.kind ?? (target ? target.kind : null),
                proposalLabel({ op: item.op, workItemId: item.workItemId }),
              );
            }
            // The replacement patch's STEPS (MOTIR-8668), the same way: the rows
            // against the store's caps always, the container half against the
            // target's PROJECTED kind, read only when the list is non-empty.
            if (Array.isArray(input.patch?.todos) && input.patch.todos.length > 0) {
              const target = item.workItemId
                ? await workItemRepository.findById(item.workItemId, tx)
                : null;
              validateProposedTodos(
                input.patch.todos,
                input.patch.kind ?? (target ? target.kind : null),
                proposalLabel({ op: item.op, workItemId: item.workItemId }),
              );
            } else {
              validateProposedTodos(
                input.patch?.todos,
                null,
                proposalLabel({ op: item.op, workItemId: item.workItemId }),
              );
            }
            assertKnownRepoRole(
              input.patch?.targetRepoRole,
              item.id,
              proposalLabel({ op: item.op, workItemId: item.workItemId }),
            );
            // The replacement patch clears the append's boundary checks with it
            // (bug MOTIR-4904): a correction REPLACES the patch, so a patch that
            // describes the repository axis twice must be refused here exactly as
            // `validateProposal` refuses one at the append.
            assertSingleTargetRepoInput(
              input.patch?.targetRepo,
              input.patch?.targetRepos,
              input.patch?.targetRepositories,
              input.patch?.targetRepositoryRef,
            );
            data.patch = (input.patch ?? Prisma.JsonNull) as Prisma.InputJsonValue;
            touched.push('patch');
          }
        }

        if (input.parentRef !== undefined) {
          if (item.op !== 'add') {
            throw new InvalidProposalError('Only an `add` proposal carries a `parentRef`.');
          }
          data.parentRef = input.parentRef;
          touched.push('parentRef');
        }
        if (input.blockedByRefs !== undefined) {
          data.blockedByRefs = input.blockedByRefs;
          touched.push('blockedByRefs');
        }
        // The reasons REPLACE with the edges they explain (MOTIR-9827), held to the
        // refs the corrected proposal draws.
        if (input.edgeReasons !== undefined) {
          const correctedEdges = {
            op: item.op,
            blockedByRefs: (data.blockedByRefs as string[] | undefined) ?? item.blockedByRefs,
            patch: (input.patch !== undefined ? input.patch : item.patch) as {
              blockedByAdd?: string[];
            } | null,
            edgeReasons: input.edgeReasons,
          };
          assertEdgeReasonsKeyed(
            correctedEdges,
            proposalLabel({ op: item.op, workItemId: item.workItemId }),
          );
          data.edgeReasons = input.edgeReasons;
          touched.push('edgeReasons');
        }
        // REPLACES the `add`'s supersedes set (MOTIR-6630), as `blockedByRefs`
        // does; a `modify` corrects its edges through its `patch`.
        if (input.supersedesRefs !== undefined) {
          if (item.op !== 'add') {
            throw new InvalidProposalError(
              "Only an `add` proposal carries `supersedesRefs`; correct a `modify`'s supersedes edges through its `patch`.",
            );
          }
          data.supersedesRefs = input.supersedesRefs;
          touched.push('supersedesRefs');
        }

        if (touched.length === 0)
          throw new InvalidProposalError('A correction must change something.');

        // ⚠️ THE APPEND'S OWN CHECK, RE-RUN ON THE CORRECTED SHAPE (MOTIR-3539).
        // The resolvable set is every OTHER `add` on this plan — excluding this
        // one, so `planItem:<itself>` is refused rather than stored as a
        // one-node cycle for materialize to trip over.
        const corrected: ProposalRefCarrier = {
          label: proposalLabel({
            op: item.op,
            workItemId: item.workItemId,
            title: (data.proposedFields as { title?: string } | undefined)?.title,
          }),
          parentRef: (data.parentRef as string | null | undefined) ?? item.parentRef,
          blockedByRefs: (data.blockedByRefs as string[] | undefined) ?? item.blockedByRefs,
          supersedesRefs:
            (data.supersedesRefs as string[] | undefined) ?? item.supersedesRefs ?? [],
          patch: (input.patch !== undefined
            ? input.patch
            : (item.patch as ProposalRefCarrier['patch'])) as ProposalRefCarrier['patch'],
        };
        assertTempRefsResolvable(
          [corrected],
          new Set(all.filter((i) => i.op === 'add' && i.id !== item.id).map((i) => i.id)),
          (ref, proposal) => new UnresolvedPlanRefError(ref, proposal),
        );

        // The append's FOLDER gate on the corrected shape (MOTIR-5414), run
        // unconditionally rather than left to the before/after verdict below —
        // that verdict ADMITS a correction to a plan that was already
        // unapprovable, and an unknown folder is a mistake this write
        // introduces, not a repair of one it inherits.
        const correctedNode: ProposalNode = {
          ...toProposalNode(item),
          parentRef: corrected.parentRef ?? null,
          blockedByRefs: [...(corrected.blockedByRefs ?? [])],
          supersedesRefs: [...(corrected.supersedesRefs ?? [])],
          patch: (corrected.patch ?? null) as ProposalNode['patch'],
        };
        assertProposalSetSelfConsistent([correctedNode]);
        if (collectReferencedFolderIds([correctedNode]).length > 0) {
          await assertFolderPlacementsLegalAtAppend([correctedNode], ctx, plan.projectId, tx);
        }
        // The append's RE-PARENT gate on the corrected shape, for the same reason
        // as the folder gate above — including a move under a proposed `add`
        // (AMENDMENT 18 §1, MOTIR-6050), judged against the plan's OTHER
        // proposals, which is the set the corrected one will sit among.
        if (anyReparent([correctedNode])) {
          await assertReparentsLegalAtAppend(
            [...all.filter((i) => i.id !== item.id).map(toProposalNode), correctedNode],
            ctx,
            plan.projectId,
            tx,
          );
        }
        // …and the append's RE-KIND gate (bug MOTIR-8192), for the same reason:
        // a kind the projected tree refuses is a mistake this write introduces.
        if (correctedNode.op === 'modify' && correctedNode.patch?.kind !== undefined) {
          await assertKindChangesLegalAtAppend(
            [...all.filter((i) => i.id !== item.id).map(toProposalNode), correctedNode],
            ctx,
            plan.projectId,
            tx,
          );
        }

        // A `blocked_by` CYCLE the correction closes on a GENERATING plan
        // (MOTIR-9267) — refused where the edge is written, as the append does,
        // and before the write. A `planned` plan is held by the before/after
        // gate below.
        if (
          fresh.status === 'generating' &&
          (input.blockedByRefs !== undefined || (input.patch?.blockedByAdd?.length ?? 0) > 0)
        ) {
          await assertBlockedByAcyclicAtAppend(
            [...all.filter((i) => i.id !== item.id).map(toProposalNode), correctedNode],
            new Set([correctedNode.id]),
            ctx,
            plan.projectId,
            tx,
          );
        }

        await planItemRepository.update(planItemId, data, tx);

        // ⚠️ THE CLOSE'S OWN GATE, RE-RUN ON THE CORRECTED PLAN (MOTIR-3936).
        // `assertTempRefsResolvable` above is the APPEND's check and covers the
        // `planItem:` half only; a ref naming a REAL work item — the half that
        // needs a workspace read — was checked at the close and never again, so
        // a correction could write one that resolves to nothing and the reviewer
        // met it by pressing Approve. A throw here rolls this update back.
        await assertCorrectionKeepsPlanApprovable(
          all,
          await planItemRepository.findByPlan(planId, tx),
          ctx,
          correctionTerminalStatusKeys,
          plan.projectId,
          tx,
        );

        // The correction, on the plan's content trail (MOTIR-3535), in the same
        // transaction as the write it records.
        //
        // ⚠️ THE AGENT ACTOR, not the person — the discriminator `editAddProposal`
        // uses (`expectedStatus`) is the wrong one here. It reads `planned` as
        // "only a person reaches this", which was true while the review route was
        // the sole caller. This method exists precisely so an AGENT can reach a
        // `planned` plan, and a reviewer must be able to see WHICH harness and
        // model changed the tree under them — that is the story's own criterion.
        await planRevisionsService.recordRevision(
          {
            planId,
            planItemId,
            changeKind: 'edited',
            ...(opts.byReviewer
              ? { changedById: ctx.userId, actor: null }
              : generationActor(fresh, ctx)),
            diff: { fields: touched, proposalCount: 1, correction: true },
          },
          tx,
        );
        // The plan's activity stamp (MOTIR-7822).
        await stampPlanActivity(fresh, new Date(), tx);
        return { row: fresh, items: await planItemRepository.findByPlan(planId, tx) };
      },
    );
    return withLinkWarnings(toPlanWithItemsDto(row, items), items, [planItemId], ctx);
  },

  /**
   * WITHDRAW a proposal from a `generating` or `planned` plan (Story MOTIR-3533 ·
   * Subtask MOTIR-3540) — the substrate `agent-authored-plans.md` AMENDMENT 3 D4
   * recorded as absent and deferred to this card.
   *
   * Two things it is NOT. It is not `op: 'remove'`, which is a PROPOSAL to delete
   * an existing work item from the tree at approve and requires a `workItemId`;
   * this takes a proposal off the PLAN and nothing reaches the tree either way.
   * And it is not the neutering D4 rejected — retitling a card *withdrawn* and
   * emptying it leaves a proposal a reviewer must still read and makes the plan's
   * item count a lie.
   *
   * ⚠️ IT REFUSES rather than cascades when a sibling still references it. This
   * is MOTIR-3539's check in the mirror: that card made a dangling ref impossible
   * to CREATE, and this stops one arriving by DELETION instead. Cascading would
   * take cards off the plan nobody asked to withdraw; blanking the refs would
   * change what those proposals mean.
   *
   * Withdrawing a `modify` RELEASES its target, so a corrected `modify` on that
   * work item can be appended — the escape `DUPLICATE_PLAN_TARGET` has never had.
   * That falls out of the delete rather than being coded: `foldAppend` reads the
   * rows that exist.
   */
  async withdrawProposal(
    planId: string,
    planItemId: string,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    // The project's TERMINAL statuses, for the post-withdrawal gate below —
    // resolved outside the transaction for the reason `markPlanned` states.
    const withdrawTerminalStatusKeys = await workflowsService.getTerminalStatusKeys(
      plan.projectId,
      ctx.workspaceId,
    );

    const { row, items, ended } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);

        const all = await planItemRepository.findByPlan(planId, tx);
        const item = all.find((i) => i.id === planItemId);
        if (!item || item.planId !== planId) throw new PlanItemNotFoundError(planItemId);

        const ref = `${TEMP_REF_PREFIX}${planItemId}`;
        const referrers = all
          .filter((i) => i.id !== planItemId)
          .filter((i) => tempRefsOf(refCarrierOfRow(i)).some((t) => t.ref === ref))
          .map((i) => i.id);
        if (referrers.length > 0) throw new PlanProposalReferencedError(planItemId, referrers);

        await planItemRepository.deleteById(planItemId, tx);

        // ⚠️ THE CLOSE'S OWN GATE, RE-RUN ON WHAT IS LEFT (MOTIR-3936). The
        // referrer refusal above stops a `planItem:` ref being orphaned; it says
        // nothing about the rest of the graph, and a withdrawal is a write to a
        // `planned` plan exactly as a correction is. A throw rolls the delete
        // back — and, as everywhere in this pair, a plan that was ALREADY
        // unapprovable is left withdrawable, because a withdrawal is often the
        // repair.
        await assertCorrectionKeepsPlanApprovable(
          all,
          await planItemRepository.findByPlan(planId, tx),
          ctx,
          withdrawTerminalStatusKeys,
          plan.projectId,
          tx,
        );

        // ⚠️ `planItemId` is NOT recorded on the revision: the row it names has
        // just been deleted, and `PlanRevision.planItemId` is a real relation, so
        // recording it would either fail the insert or be nulled by the cascade —
        // a trail row that quietly loses its subject. The id rides in the `diff`
        // instead, where it is a value rather than a reference.
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: 'withdrawn',
            ...generationActor(fresh, ctx),
            diff: { proposalCount: 1, withdrewPlanItemId: planItemId, op: item.op },
          },
          tx,
        );
        // The plan's activity stamp (MOTIR-7822).
        await stampPlanActivity(fresh, new Date(), tx);

        const remaining = await planItemRepository.findByPlan(planId, tx);

        // ⚠️ THE WITHDRAWAL THAT EMPTIES A `planned` PLAN ENDS IT (MOTIR-4146),
        // by exactly the route the CLOSE takes over an empty set: `declined`
        // with `decisionReason: 'discarded'`, decided by nobody.
        //
        // MOTIR-4124 established that a plan proposing nothing must not wear
        // `planned` — the status that says *a person is being asked to decide
        // this* — and established it at the close alone. This is the door that
        // then re-created the state: `assertPlanProposalsEditable` admits
        // `planned`, so the last proposal can be taken off a queued plan and
        // NOTHING re-asks the question the close had answered. The file already
        // names this exact class one invariant earlier ("AMENDMENT 8 then opened
        // two doors onto a `planned` plan … and neither re-asks the question the
        // close answered", MOTIR-3936); this is its second instance.
        //
        // ⚠️ `generating` IS DELIBERATELY EXCLUDED, and the exclusion is the
        // rule rather than an omission: a `generating` plan holding nothing is a
        // producer that has not finished writing, which is precisely the state
        // MOTIR-3193 relaxed the empty final batch to ESCAPE. Ending it here
        // would decide a plan whose author is still typing.
        //
        // The LOSING BRANCH, named because it is the obvious one: refusing the
        // last withdrawal. It makes the final withdrawal a special case with an
        // error of its own, and lands the plan in the same terminal place
        // anyway — by a route the author has to discover.
        if (fresh.status === 'planned' && remaining.length === 0) {
          const ended = await planRepository.update(
            planId,
            {
              status: 'declined',
              decidedAt: new Date(),
              decidedById: null,
              decisionReason: 'discarded',
            },
            tx,
          );
          // The question ends with the plan (MOTIR-6036; §11.7): its awaiting gate
          // is withdrawn as `plan_discarded`, under the plan lock this transaction
          // already holds. A withdrawal SHORT of the last supersedes nothing — the
          // stamp refuses a reader of the old set (§11.5c).
          await planGateService.supersede(planId, 'plan_discarded', tx);
          await planRevisionsService.recordRevision(
            {
              planId,
              changeKind: 'declined',
              ...generationActor(fresh, ctx),
              diff: { itemCount: 0, decisionReason: 'discarded' },
            },
            tx,
          );
          // The ending is an ADDITIONAL verb on the trail, not a replacement for
          // the `withdrawn` recorded above it: the timeline has to say what the
          // caller did AND what it caused.
          return { row: ended, items: remaining, ended: true };
        }

        return { row: fresh, items: remaining, ended: false };
      },
    );
    // A discarded plan is as terminal as a declined one, so it releases the
    // planning-target locks the same way `markPlanned`'s empty close does — a
    // `modify` withdrawn off a plan leaves its target leased otherwise, and that
    // lease would sit out its expiry blocking a colleague. Post-commit and
    // best-effort, exactly as it is there.
    if (ended) await releasePlanTargetLocks(plan, ctx);
    return toPlanWithItemsDto(row, items);
  },

  /**
   * RECORD WHY a change was asked of a plan that is not yet approved (Story
   * MOTIR-5543 · Subtask MOTIR-6083) — one INTERNAL `reason_classified` row.
   *
   * ⚠️ IT IS RECORDED ON EVERY BRANCH, INCLUDING THE TWO THAT FILE NOTHING, and
   * that is the card rather than a detail. A silent "no bug" is indistinguishable
   * from a forgotten one, so *different solution, no bug* has to be a written
   * judgement Motir can audit. Filing on every re-plan instead is what made the
   * planner-bug home unreadable — hundreds of rows in which a reviewer preferring
   * a side panel looks exactly like a plan that forgot to check whether its
   * repository still exists.
   *
   * ⚠️ NO TENANT SEES IT. This is Motir's own judgement about its own planner:
   * the row's kind is in `INTERNAL_PLAN_REVISION_CHANGE_KINDS`, every
   * tenant-facing read excludes that set at the query
   * (`planRevisionRepository`'s `TENANT_VISIBLE_PLAN_REVISION_WHERE`), and
   * `PlanHistoryEventDto` is unchanged — no field was added for it to render.
   * Epic 10 is the eventual reader.
   *
   * ⚠️ IT WRITES NO BUG. The caller files the planning bug and passes its id, on
   * the two rule branches. This method's job is the RECORD; the doors above it
   * (MOTIR-6086's MCP tool, MOTIR-6087's internal route) are what a planner
   * reaches, and neither is this card's.
   *
   * The access check, the lock and the status refusal are `correctProposal`'s
   * exactly — `ai:view_plan`, not `ai:decide_plan`, because classifying a
   * requested change is part of authoring the correction rather than deciding
   * the plan. An `approved` or `declined` plan is refused with the same
   * {@link PlanNotEditableError} the correction doors raise: those plans are
   * frozen, and a classification recorded against one would be a judgement about
   * a change that can no longer happen.
   */
  /**
   * Record the step ONE running planner session is on (Story MOTIR-7820 ·
   * MOTIR-7822), REPLACING the step that session reported before. Legal only
   * while the plan is `generating`; anything else is {@link PlanNotGeneratingError}
   * and writes nothing. `startedAt` and the activity stamp are the SERVER's
   * clock. A null target on `lay` / `author` is the untargeted form, never an
   * error. No door calls this yet beyond the signal routes that wrap it.
   */
  async recordPlanStep(
    planId: string,
    input: RecordPlanStepInput,
    ctx: ServiceContext,
  ): Promise<PlanStepDto> {
    const sessionKey = assertSessionKey(input.sessionKey);
    const targetRef = input.targetRef ?? null;
    return withGeneratingPlanStep(planId, ctx, async (plan, tx, now) => {
      await assertStepTarget(plan, input.kind, targetRef, ctx, tx);
      const row = await planStepRepository.upsertForSession(
        planId,
        sessionKey,
        {
          kind: input.kind,
          targetRef,
          startedAt: now,
          // A session that moved on was evidently served (MOTIR-9619).
          providerWaitSince: null,
          providerWaitUntil: null,
          providerWaitAttempt: null,
          providerWaitMaxAttempts: null,
        },
        tx,
      );
      // The session's STEP WORDS (MOTIR-8062), in the same transaction: the head
      // its chat-panel group keeps after `end` deletes the step row above.
      await planNarrationRepository.upsertSession(
        planId,
        sessionKey,
        {
          stepKind: input.kind,
          targetRef,
          targetTitle: await resolveStepTargetTitle(plan, targetRef, ctx, tx),
        },
        tx,
      );
      return toPlanStepDto(row);
    });
  },

  /**
   * Append a session's NARRATION (Story MOTIR-8060 · MOTIR-8062): its own
   * plain-language sentences about its work, in the order it wrote them, to the
   * plan's kept history. Each is cleaned to one line and capped; the whole call
   * is refused — nothing written — when the batch is empty or over
   * {@link PLAN_NARRATION_BATCH_MAX}, any sentence cleans to nothing, the plan is
   * not `generating`, or the session holds no step. Accepted sentences take the
   * next consecutive per-plan `seq` values under the plan row lock, share the
   * call's server time, and stamp the plan's activity.
   *
   * ⚠️ IT NEVER TOUCHES THE STEP. Sentences go to their own table, so the
   * session's `PlanStep` row (`startedAt` included) and its stored step words
   * are untouched by construction.
   */
  async recordPlanNarration(
    planId: string,
    input: { sessionKey: string; narration: unknown },
    ctx: ServiceContext,
  ): Promise<PlanNarrationDto[]> {
    const sessionKey = assertSessionKey(input.sessionKey);
    const raw = input.narration;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLAN_NARRATION_BATCH_MAX) {
      throw new InvalidPlanStepError(
        `\`narration\` is 1 to ${PLAN_NARRATION_BATCH_MAX} sentences — nothing was recorded.`,
      );
    }
    const bodies: string[] = [];
    for (const sentence of raw) {
      const body = typeof sentence === 'string' ? cleanNarrationSentence(sentence) : null;
      if (body === null) {
        throw new InvalidPlanStepError(
          'A narration sentence is one non-empty sentence — nothing was recorded.',
        );
      }
      bodies.push(body);
    }
    return withGeneratingPlanStep(planId, ctx, async (_plan, tx, now) => {
      const steps = await planStepRepository.listByPlan(planId, tx);
      if (!steps.some((step) => step.sessionKey === sessionKey)) {
        throw new InvalidPlanStepError(
          `Session \`${sessionKey}\` has no step on this plan — report \`settle\` / \`lay\` / ` +
            '`author` first; nothing was recorded.',
        );
      }
      const base = await planNarrationRepository.maxSeq(planId, tx);
      const rows = await planNarrationRepository.createMany(
        bodies.map((body, i) => ({ planId, sessionKey, seq: base + i + 1, body, createdAt: now })),
        tx,
      );
      return rows.map(toPlanNarrationDto);
    });
  },

  /**
   * Record — or clear — a session's provider-retry WAIT (Story MOTIR-9540 ·
   * MOTIR-9619). A `waiting` report is checked (integers in
   * `1..PLAN_PROVIDER_RETRY_ATTEMPTS_MAX`, `attempt ≤ maxAttempts`, a `retryAt`
   * that parses), its `retryAt` CLAMPED to `[now, now + PLAN_STALLED_AFTER_MS]`,
   * and stored with the server's clock as `since`; `cleared` nulls it. Refused
   * {@link InvalidPlanStepError} when the session holds no step on the plan.
   *
   * ⚠️ IT NEVER TOUCHES THE STEP, exactly as narration does not: the wait is its
   * own four columns, so the overlay's step words and `startedAt` hold still
   * through a retry. It stamps the plan's activity (via `withGeneratingPlanStep`),
   * so a long retry-after is not read as a stall.
   */
  async recordProviderRetry(
    planId: string,
    input: { sessionKey: string; providerRetry: unknown },
    ctx: ServiceContext,
  ): Promise<PlanStepProviderWaitDto | null> {
    const sessionKey = assertSessionKey(input.sessionKey);
    const raw = (input.providerRetry ?? null) as Record<string, unknown> | null;
    const state = raw && typeof raw === 'object' ? raw.state : undefined;
    let wait: { attempt: number; maxAttempts: number; retryAtMs: number } | null = null;
    if (state === 'waiting') {
      const { attempt, maxAttempts, retryAt } = raw!;
      if (!isRetryAttempt(attempt) || !isRetryAttempt(maxAttempts) || attempt > maxAttempts) {
        throw new InvalidPlanStepError(
          `\`attempt\` and \`maxAttempts\` are integers in 1..${PLAN_PROVIDER_RETRY_ATTEMPTS_MAX} ` +
            'with `attempt` ≤ `maxAttempts` — nothing was recorded.',
        );
      }
      const retryAtMs = typeof retryAt === 'string' ? Date.parse(retryAt) : Number.NaN;
      if (Number.isNaN(retryAtMs)) {
        throw new InvalidPlanStepError('`retryAt` is an ISO-8601 time — nothing was recorded.');
      }
      wait = { attempt, maxAttempts, retryAtMs };
    } else if (state !== 'cleared') {
      throw new InvalidPlanStepError(
        '`providerRetry.state` is `waiting` or `cleared` — nothing was recorded.',
      );
    }
    return withGeneratingPlanStep(planId, ctx, async (_plan, tx, now) => {
      const stored = wait
        ? {
            since: now,
            until: new Date(
              Math.min(
                Math.max(wait.retryAtMs, now.getTime()),
                now.getTime() + PLAN_STALLED_AFTER_MS,
              ),
            ),
            attempt: wait.attempt,
            maxAttempts: wait.maxAttempts,
          }
        : null;
      const count = await planStepRepository.setProviderWait(planId, sessionKey, stored, tx);
      if (count === 0) {
        throw new InvalidPlanStepError(
          `Session \`${sessionKey}\` has no step on this plan — report \`settle\` / \`lay\` / ` +
            '`author` first; nothing was recorded.',
        );
      }
      return stored
        ? {
            attempt: stored.attempt,
            maxAttempts: stored.maxAttempts,
            since: stored.since.toISOString(),
            retryAt: stored.until.toISOString(),
          }
        : null;
    });
  },

  /**
   * Clear a session's step (MOTIR-7822). A session with no step is a no-op
   * SUCCESS — a planner clearing on every exit must not be able to fail — and
   * still stamps the activity: an ending session is a sign of life. Refused on a
   * plan that is not `generating`, exactly like {@link recordPlanStep}.
   */
  async endPlanStep(planId: string, sessionKey: string, ctx: ServiceContext): Promise<void> {
    const key = assertSessionKey(sessionKey);
    await withGeneratingPlanStep(planId, ctx, async (_plan, tx) => {
      await planStepRepository.deleteForSession(planId, key, tx);
    });
  },

  /**
   * The ONE dispatch both step DOORS make (MOTIR-7824): `report_plan_step` and
   * `POST /api/internal/ai/plan-step` carry four values, `settle` · `lay` ·
   * `author` · `end`, and this maps them onto {@link recordPlanStep} /
   * {@link endPlanStep} — so the one rule `endPlanStep` cannot see, that an `end`
   * names no target, lives here once rather than in each door. Returns the
   * stored step, or `null` for an `end`.
   */
  async reportPlanStep(
    planId: string,
    input: {
      sessionKey: string;
      step?: PlanStepKindDto | 'end';
      targetRef: string | null;
      narration?: string[];
      /** The session's provider-retry wait (MOTIR-9619) — the third exclusive form. */
      providerRetry?: PlanProviderRetryInput;
    },
    ctx: ServiceContext,
  ): Promise<ReportPlanStepResult> {
    // EXACTLY ONE of `step` / `narration` / `providerRetry` (MOTIR-8062 ·
    // MOTIR-9619): a step report re-stamps `startedAt`, so keeping them apart is
    // what lets a narration or a wait never touch the step.
    const forms = [input.step, input.narration, input.providerRetry].filter(
      (form) => form !== undefined,
    ).length;
    if (forms !== 1) {
      throw new InvalidPlanStepError(
        'Send exactly one of `step`, `narration` or `providerRetry` — nothing was recorded.',
      );
    }
    if (input.providerRetry !== undefined) {
      if (input.targetRef !== null) {
        throw new InvalidPlanStepError(
          'A `providerRetry` call names no target — send it with none; nothing was recorded.',
        );
      }
      const providerWait = await plansService.recordProviderRetry(
        planId,
        { sessionKey: input.sessionKey, providerRetry: input.providerRetry },
        ctx,
      );
      return { kind: 'providerRetry', providerWait };
    }
    const hasNarration = input.narration !== undefined;
    if (hasNarration) {
      if (input.targetRef !== null) {
        throw new InvalidPlanStepError(
          'A `narration` call names no target — send it with none; nothing was recorded.',
        );
      }
      const narration = await plansService.recordPlanNarration(
        planId,
        { sessionKey: input.sessionKey, narration: input.narration },
        ctx,
      );
      return { kind: 'narration', narration };
    }
    if (input.step === 'end') {
      if (input.targetRef !== null) {
        throw new InvalidPlanStepError('An `end` step names no target — send it with none.');
      }
      await plansService.endPlanStep(planId, input.sessionKey, ctx);
      return { kind: 'end' };
    }
    const step = await plansService.recordPlanStep(
      planId,
      { sessionKey: input.sessionKey, kind: input.step!, targetRef: input.targetRef },
      ctx,
    );
    return { kind: 'step', step };
  },

  async recordRevisionClassification(
    args: {
      planId: string;
      branch: RevisionReasonBranch;
      evidenceMd: string;
      /** The planning bug by its work-item ID — what motir-ai's `createBug` hands back. */
      planningBugId?: string | null;
      /**
       * The planning bug by its `MOTIR-<n>` KEY — what the runbook holds after
       * `create_work_item`.
       *
       * ⚠️ TWO SPELLINGS OF ONE ARGUMENT, resolved HERE rather than at each door,
       * because resolving a key needs the PLAN'S PROJECT and this method is the
       * only place that already has it. A door that resolved it for itself would
       * have to read the plan a second time just to learn the project — and the
       * MCP transport is supposed to make one service call, not three.
       *
       * Giving both is refused rather than silently resolved: they are the same
       * field in two forms, so a call sending both has not decided what it means.
       */
      planningBugKey?: string | null;
      actor?: PlanRevisionAgentActor | null;
    },
    ctx: ServiceContext,
  ): Promise<{
    revisionId: string;
    branch: RevisionReasonBranch;
    planningBugId: string | null;
    planningBugKey: string | null;
    /** The row's OWN `changedAt`, so a caller reports when it was recorded
     *  rather than when it asked. */
    at: string;
  }> {
    const { planId, branch } = args;
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    if (!isRevisionReasonBranch(branch)) {
      throw new PlanRevisionClassificationInvalidError(
        planId,
        String(branch),
        `it is not one of the four branches: ${REVISION_REASON_BRANCHES.join(', ')}.`,
      );
    }

    // The EVIDENCE, trimmed and bounded before anything is locked. Empty is
    // refused on every branch, not only the two that file: the branch alone is a
    // verdict with no working shown, and "recorded so it can be checked" is the
    // property this whole row exists for.
    const evidenceMd = (args.evidenceMd ?? '').trim();
    if (evidenceMd.length === 0) {
      throw new PlanRevisionClassificationInvalidError(
        planId,
        branch,
        'it carries no evidence. Every branch records why it was chosen — quote the turn that raised the thing, or the rule search that came back empty.',
      );
    }
    if (evidenceMd.length > REVISION_REASON_EVIDENCE_MAX) {
      throw new PlanRevisionClassificationInvalidError(
        planId,
        branch,
        `its evidence is ${evidenceMd.length} characters; the limit is ${REVISION_REASON_EVIDENCE_MAX}.`,
      );
    }

    // ONE ARGUMENT, TWO SPELLINGS. Both given is refused rather than resolved —
    // the same call `assertSingleTargetRepoInput` makes for the repository axis,
    // and for the same reason: a caller sending two forms of one field has not
    // decided what it means, and inventing a precedence rule would settle it for
    // them silently.
    const rawKey = args.planningBugKey?.trim() ?? '';
    if (args.planningBugId && rawKey !== '') {
      throw new PlanRevisionClassificationInvalidError(
        planId,
        branch,
        'it names the planning bug twice — give `planningBugId` or `planningBugKey`, not both.',
      );
    }

    // THE BRANCH AND THE BUG MUST AGREE. Both directions are refused, because
    // both make the row say something its caller did not. Asked of the PAIR
    // rather than of the resolved id, so a rule branch that sent no key at all
    // is refused before a lookup it has nothing to look up.
    const namesABug = Boolean(args.planningBugId) || rawKey !== '';
    const filesABug = isRuleRevisionReasonBranch(branch);
    if (filesABug && !namesABug) {
      throw new PlanRevisionClassificationInvalidError(
        planId,
        branch,
        "it is a branch about the planner, so it files exactly one planning bug — pass that bug's id. File the bug first; this row records which bug the classification produced.",
      );
    }
    if (!filesABug && namesABug) {
      throw new PlanRevisionClassificationInvalidError(
        planId,
        branch,
        'it is a branch about what the person wants, so it files nothing — a planning bug here would be the noise this classification exists to remove.',
      );
    }

    // THE KEY, RESOLVED — in the plan's OWN project, which is what makes the
    // same-project rule below hold for this spelling by construction: a key in
    // another project is not found rather than found-and-refused, which is the
    // family's no-leak posture.
    let planningBugId = args.planningBugId ?? null;
    let planningBugKey: string | null = null;
    if (rawKey !== '') {
      const resolved = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findByIdentifier(plan.projectId, rawKey.toUpperCase(), tx),
      );
      if (!resolved) {
        throw new PlanRevisionClassificationInvalidError(
          planId,
          branch,
          `no work item \`${rawKey.toUpperCase()}\` exists in this plan's project.`,
        );
      }
      planningBugId = resolved.id;
      planningBugKey = rawKey.toUpperCase();
    }

    // THE BUG MUST BE A BUG, AND IT MUST BE IN THE PLAN'S OWN PROJECT.
    //
    // ⚠️ WHICH RULE THIS IS, because the card left it to be settled by reading
    // the code: `bugDestinationService.resolvePlannerBug(projectId)` resolves the
    // project's OWN `plannerBugDestinationFolderId`, else its own product bug
    // destination, else its own root — so the shipped filer always lands a
    // planning bug in the SAME project as the plan it was filed about. There is
    // no cross-project hop to accommodate, and accepting one would let a
    // classification point at a row in a project the reader of the plan cannot
    // open. (`lib/ai/plannerBugHome.ts` documents the marker; the marker's job is
    // only to survive a key renumbering, not to cross a project.)
    if (planningBugId) {
      const bug = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findById(planningBugId, tx),
      );
      if (!bug) {
        throw new PlanRevisionClassificationInvalidError(
          planId,
          branch,
          `the planning bug ${planningBugId} does not exist.`,
        );
      }
      if (bug.kind !== 'bug') {
        throw new PlanRevisionClassificationInvalidError(
          planId,
          branch,
          `the work item ${planningBugId} is a \`${bug.kind}\`, not a \`bug\`. A classification points at the defect record it produced.`,
        );
      }
      if (bug.projectId !== plan.projectId) {
        throw new PlanRevisionClassificationInvalidError(
          planId,
          branch,
          `the planning bug ${planningBugId} is in a different project from the plan. A planning bug is filed into its own project's planner-bug destination, so the two always match.`,
        );
      }
    }

    // ONE transaction, the same shape the correction doors use: lock the plan,
    // re-read it under the lock, refuse a frozen status, write the row. The lock
    // is what makes the status check meaningful — without it a plan can be
    // approved between the read and the write, and the classification would land
    // on a plan nothing can change any more.
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);

        return planRevisionsService.recordRevision(
          {
            planId,
            // No `planItemId`: a classification is about the REQUEST, not about
            // any one proposal — the same call the open, the close and
            // `bug_filed` make.
            planItemId: null,
            changedById: ctx.userId,
            changeKind: REASON_CLASSIFIED_KIND,
            actor: args.actor ?? null,
            // COUNT-SHAPED, as every `diff` is: two identifiers and no prose.
            // The evidence rides `noteMd` precisely so this payload keeps the
            // contract its own doc comment makes to every existing reader.
            diff: { branch, planningBugId },
            noteMd: evidenceMd,
          },
          tx,
        );
      },
    );

    // The KEY rides back only when the caller supplied one: a door that named
    // the bug by id never asked for its key, and resolving one to report it
    // would be a read nobody needs.
    return {
      revisionId: row.id,
      branch,
      planningBugId,
      planningBugKey,
      at: row.changedAt.toISOString(),
    };
  },

  // `approvePlanForWorkItem` — the v1 plan-approval route's entrance — moved to
  // `planDecisionService.approveForWorkItem` (MOTIR-6038): it decides the plan's gate
  // through the door now, and the anchoring walk it shares with `readPlanForWorkItem`
  // stays here as `resolvePlanIdForWorkItem`.

  /**
   * READ the plan a card produced, WITHOUT deciding it (MOTIR-4085).
   *
   * ⚠️ IT IS THE APPROVE'S OWN RESOLUTION, MINUS THE DECISION — same anchoring
   * walk, same key, same refusal when there is no conversation at this scope. The
   * two share {@link plansService.resolvePlanIdForWorkItem} rather than each
   * spelling the walk out, because a read that resolved a DIFFERENT plan from the
   * one the approve would take is worse than no read at all: an operator's loop
   * would check the lane of one plan and approve another.
   *
   * ⚠️ WHY IT EXISTS. `--auto-approve-replan` approves a plan an agent submitted
   * while nobody was watching, and the bound on WHAT that plan may touch is the
   * operator's loop to enforce — the agent cannot be trusted with its own bound,
   * and the server cannot know which card an unattended iteration is on. So the
   * loop needs the proposals BEFORE the approval; every other read it has is
   * addressed by a plan id it never learns (the id came back in the sandboxed
   * agent's tool result). Reading is `ai:view_plan`; DECIDING stays
   * `ai:decide_plan`, which no MCP tool asserts at all — so this widens what a
   * loop can look at and nothing about what an agent can cause.
   */
  async readPlanForWorkItem(
    projectId: string,
    workItemKey: string,
    ctx: ServiceContext,
  ): Promise<PlanWithItemsDto> {
    // ⚠️ BROWSE, NOT THE AUTHOR KEY, and the assertion is here rather than left
    // to `getPlan` below — which asserts the same thing — so that the ANCHORING
    // WALK cannot run for a caller who may not browse this project. Without it a
    // stranger could tell an anchored plan from an unanchored one by which
    // refusal came back, which is an existence leak the route's own 404 exists to
    // prevent one layer up.
    //
    // ⚠️ IT WAS `ai:view_plan` IN REVIEW, AND THAT WAS WRONG. This hands back the
    // document `getPlan` hands back, and `getPlan` is browse — so an author key
    // here would have made one document readable through two doors with two
    // different answers about who may open it. The key that matters is the one on
    // `approvePlan`, and it is untouched.
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const planId = await plansService.resolvePlanIdForWorkItem(projectId, workItemKey, ctx);
    return plansService.getPlan(planId, ctx);
  },

  /**
   * The UNDECIDED plans that name ONE work item — what the work-item detail page
   * announces about the plan that is about to change it, ARCHIVE it, or ADD
   * CHILDREN under it (bug MOTIR-4197 · design MOTIR-4256; widened by bug
   * MOTIR-4365 · design MOTIR-4364 AMENDMENT A).
   *
   * ⚠️ ONE ROW PER PLAN, NOT PER PROPOSAL, and the fold below is what makes that
   * true. The repository's second arm returns one row per `add` parented on this
   * card, so a single plan expanding a story into eight subtasks arrives as
   * eight rows. `pendingPlanCountHeadline` counts PLANS and always did — it was
   * only ever ACCIDENTALLY equal to the proposal count, because
   * `@@unique([planId, workItemId])` capped a plan at one targeting op per card.
   * Handing the component the un-folded rows would announce *"11 pending plans
   * name this item"* about three plans: no error, still grammatical, false.
   *
   * The fold is IN MEMORY and deliberately not a second query — the rows already
   * arrive ordered by `plan.createdAt`, and the set is bounded by the proposals
   * naming ONE card, so `§3`'s *one indexed lookup inside a group that already
   * awaits several* survives, which is the figure MOTIR-4197 made a shipping
   * condition.
   *
   * ⚠️ ITS OWN READ, NOT `aiBoundaryService.readPendingPlans`. That seam is
   * PROJECT-scoped, returns `itemCount` and never the proposals, caps at ten,
   * and lives behind `/api/internal/ai/*` for a prompt — it cannot answer *which
   * plans name THIS card*. This is `planItemRepository.findPendingByWorkItemId`,
   * the drift listener's own first question narrowed to the undecided statuses,
   * with the plan's id / title / status on the same row: ONE indexed lookup.
   *
   * ⚠️ THE STATUS SET IS DECIDED HERE — `WORK_ITEM_PENDING_PLAN_STATUSES`
   * (`planned` + `stale`), never `AI_PENDING_PLAN_STATUSES`, which admits
   * `generating` because it answers a different question. A caller cannot ask
   * for a decided plan: the signature has nowhere to put a status.
   *
   * Browse-gated like every other plan read; the page that calls it has already
   * resolved the same permission set and skips the call entirely for an actor
   * without `ai:view_plan` (an indicator naming a plan the viewer cannot open is
   * worse than none — MOTIR-4197 AC 4).
   */
  async listPendingProposalsForWorkItem(
    projectId: string,
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<WorkItemPendingProposalDto[]> {
    await projectAccessService.assertCanBrowse(projectId, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findPendingByWorkItemId(
        workItemId,
        ctx.workspaceId,
        projectId,
        WORK_ITEM_PENDING_PLAN_STATUSES,
        tx,
      ),
    );
    // A Map preserves insertion order, and the rows arrive ordered by
    // `plan.createdAt` — so the folded list keeps plan-creation order without a
    // second sort, and the first row of each plan is the one that fixes its
    // position.
    const byPlan = new Map<string, WorkItemPendingProposalDto>();
    for (const row of rows) {
      let claim = byPlan.get(row.plan.id);
      if (!claim) {
        claim = {
          planId: row.plan.id,
          planTitle: row.plan.title,
          // The repository filtered on exactly this set, so the narrowing is a
          // restatement of the predicate rather than a second decision.
          planStatus: row.plan.status as WorkItemPendingPlanStatusDto,
          op: null,
          childCount: 0,
        };
        byPlan.set(row.plan.id, claim);
      }
      // An `add` is a CHILD proposed under this card (it reached this read
      // through `parentRef`, since its own `workItemId` is null until
      // materialize); a `modify` / `remove` is a claim ON the card, and
      // `@@unique([planId, workItemId])` caps a plan at one of them, so the
      // assignment cannot be overwriting a different op.
      if (row.op === 'add') claim.childCount += 1;
      else claim.op = row.op as Exclude<PlanItemOpDto, 'add'>;
    }
    return [...byPlan.values()];
  },

  /**
   * EVERY plan related to ONE work item, oldest first — the item page's PLAN
   * HISTORY (Story MOTIR-5542 · MOTIR-5546). Related means the plan created the
   * card, changed it, archived it, or added children under it; every
   * `PlanStatus` is listed, because a declined plan is part of how a card came to
   * look the way it does.
   *
   * ⚠️ ONE ROW PER PLAN, folded in memory exactly as
   * `listPendingProposalsForWorkItem` folds — but the page is bounded BY PLAN
   * first (`planRepository.findPageRelatedToWorkItem`), so a plan with more
   * child `add`s than the page size is never split across two pages.
   *
   * QUERY COUNT, inside ONE bound transaction, after the permission reads: a
   * page with plans costs TWO queries — the plan page, then that page's rows —
   * and a card NO plan relates to costs exactly ONE, the plan page's
   * index-driven `IN (SELECT … FROM plan_item …)` probe, because the row read is
   * skipped when the page is empty. Nearly every card is that case.
   *
   * Gated on `ai:view_plan`, the key every plan read on a card asks: an entry
   * naming a plan the viewer cannot open is worse than none. The page skips the
   * call for an actor without it; the route relies on this assertion. The card
   * is NOT re-read here — the page passes the project of the card it already
   * holds, and a work item from another project simply has no rows under this
   * one. The route's by-id entrance below is what answers 404.
   */
  async listPlanHistoryForWorkItem(
    projectId: string,
    workItemId: string,
    options: PlanHistoryListOptions,
    ctx: ServiceContext,
  ): Promise<WorkItemPlanHistoryPageDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:view_plan');
    return readPlanHistoryPage(projectId, workItemId, options, ctx);
  },

  /**
   * {@link plansService.listPlanHistoryForWorkItem} addressed by the work item
   * ALONE — the `GET /api/work-items/[id]/plans` entrance, which has no project
   * in hand. Resolves the card through the tenant read and answers
   * {@link WorkItemNotFoundError} for an unknown or cross-workspace id (no
   * existence leak), then asks for the history under the card's OWN project.
   */
  async listPlanHistoryByWorkItemId(
    workItemId: string,
    options: PlanHistoryListOptions,
    ctx: ServiceContext,
  ): Promise<WorkItemPlanHistoryPageDto> {
    const item = await readWorkItem(workItemId, ctx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(workItemId);
    }
    return plansService.listPlanHistoryForWorkItem(item.projectId, workItemId, options, ctx);
  },

  /**
   * IS EACH WORK ITEM STILL WHAT THE LAST APPROVED PLAN APPROVED? (Story
   * MOTIR-5544 · Subtask MOTIR-6225.) Answers `unchanged | changed | no_plan`
   * per id, in the order supplied — the read a run that finds its target
   * unbuildable asks before blaming the planner.
   *
   * Per id:
   *   1. the APPROVING plan is the LATEST `approved` entry of
   *      {@link plansService.listPlanHistoryForWorkItem} (reused, not
   *      re-queried — so withdrawn proposals and cross-project ids behave
   *      exactly as the history does). None → `no_plan`, never an error.
   *   2. the revisions written strictly after its `decidedAt` are walked oldest
   *      first, and the FIRST one {@link classifyRevision} calls `'shape'` is the
   *      diverging revision. The verdict is computed from the REVISION LOG, not
   *      by diffing field values: a `modify`'s patch is sparse, and the approve
   *      writes its own rows (inside its transaction, so before `decidedAt`).
   *   3. a CONTAINER (a card with children now, or children approved) also
   *      compares its live child set against the approving plan's child `add`s
   *      ({@link planItemRepository.findByPlanForWorkItem}). When that plan did
   *      not create the container, the children it already had are part of what
   *      was approved: a live child created at or before `decidedAt` counts as
   *      approved. That side can only miss a change, never invent one — the safe
   *      direction for a read that files bugs.
   *
   * Gated on `ai:view_plan`, asserted here exactly as the history read asserts
   * it, so an actor without it gets the same refusal even for an empty set.
   */
  async resolveApprovedShapeVerdict(
    projectId: string,
    workItemIds: readonly string[],
    ctx: ServiceContext,
  ): Promise<WorkItemApprovedShapeVerdictPageDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:view_plan');
    const ids = [...new Set(workItemIds)];
    if (ids.length > APPROVED_SHAPE_VERDICT_MAX_IDS) {
      throw new ApprovedShapeVerdictTooManyIdsError(ids.length, APPROVED_SHAPE_VERDICT_MAX_IDS);
    }
    return computeApprovedShapeVerdicts(projectId, workItemIds, ids, ctx);
  },

  /**
   * The approved-shape verdict for ONE work item, and the plan that approved it —
   * the SERVER-INTERNAL read beneath {@link resolveApprovedShapeVerdict}'s
   * `ai:view_plan` assertion (Story MOTIR-5544 · Subtask MOTIR-6284,
   * `docs/decisions/run-found-trigger-dispatched-path.md`, *Its key*).
   *
   * ⚠️ NOT AN ENTRANCE, AND IT ASSERTS NO PERMISSION. No route, action, hook or
   * tool calls this. Its ONE legitimate caller is the run-found report service
   * (`lib/services/runFoundReportService.ts`, MOTIR-6285), which acts on a
   * dispatched runner's report under a CLI-minted token — and `CLI_TOKEN_GRANT`
   * deliberately does not carry `ai:view_plan`. It may skip the key because that
   * caller hands its caller an ACKNOWLEDGEMENT only — never the verdict, the plan
   * or a bug key — so what the gate protects never reaches anyone who lacks it:
   * the gate is not laundered. `tests/plans/approvedShapeForReportEntrances.test.ts`
   * fails the build on any other production file that references this name.
   *
   * Every read still runs under `withWorkspaceServiceContext(ctx.workspaceId, …)`,
   * exactly as the gated path does, so RLS confines it to the caller's own
   * workspace. `approvingPlan` is the approving entry's plan and its author triple,
   * which the SERVER writes (`Plan.authorSource`, never taken from a caller); it is
   * `null` exactly when the verdict is `no_plan`.
   */
  async resolveApprovedShapeForReport(
    projectId: string,
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<{
    verdict: WorkItemApprovedShapeVerdictDto;
    approvingPlan: {
      id: string;
      /** A plan's title is nullable on the row (an untitled plan). */
      title: string | null;
      authorSource: PlanAuthorSourceDto | null;
      authorHarness: string | null;
      authorModel: string | null;
    } | null;
  }> {
    const approving = await latestApprovedPlanEntry(projectId, workItemId, ctx);
    if (!approving) return { verdict: noPlanVerdict(workItemId), approvingPlan: null };
    return {
      verdict: await verdictAgainst(workItemId, approving, ctx),
      approvingPlan: {
        id: approving.planId,
        title: approving.planTitle,
        authorSource: approving.author.source,
        authorHarness: approving.author.harness,
        authorModel: approving.author.model,
      },
    };
  },

  /**
   * The ANCHORING walk, in one place: the card's key → `buildScope([key])` → the
   * LATEST plan of the most recently active session anchored at exactly that
   * scope (AMENDMENT 17 §5 — the column, not the retired `lastJobId` hop; a card
   * with several sessions resolves to the one in use). Throws
   * {@link NoPlanForWorkItemError} when there is none.
   *
   * ⚠️ NO CONVERSATION MEANS NO, and that is the bound both callers inherit. A
   * cadence plan, an onboarding generation and a plan submitted from the
   * project-wide panel all sit at no anchor set, and every one of them is a plan a
   * person is expected to decide on.
   */
  async resolvePlanIdForWorkItem(
    projectId: string,
    workItemKey: string,
    ctx: ServiceContext,
  ): Promise<string> {
    // ⚠️ NO PERMISSION OF ITS OWN, deliberately: this is the RESOLUTION and not
    // an entrance. Its two callers assert different keys — browse to read,
    // `ai:view_plan` then `ai:decide_plan` to approve — and a key baked in here
    // would silently become the floor for both. Every caller asserts BEFORE it
    // calls this; it is private to the two above and reachable from no route.
    const scope = buildScope([workItemKey]);
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findLatestInScope(projectId, scope.scopeKey, ctx.workspaceId, tx),
    );
    if (!plan) throw new NoPlanForWorkItemError(workItemKey);
    return plan.id;
  },

  /**
   * Approve a `planned` plan: in ONE transaction set `approved` +
   * decidedAt/decidedById, then MATERIALIZE every PlanItem (add → create,
   * modify → update same id, remove → archive). The plan row is locked + its
   * status re-read first, so two concurrent approves resolve to exactly one
   * materialize — the loser observes `approved` and throws
   * `PlanNotInExpectedStatusError` (the atomic one-shot guard).
   *
   * THE CONFIRMATION GATE (7.12.5 · MOTIR-911) runs here, and there is NO path
   * around it: an explicit human approve of a proposal is the ONLY way a
   * proposed tree change becomes rows, and that approve RE-VALIDATES the
   * proposal independently — the kind-parent grammar (via
   * `lib/issues/parentRules.ts`, the same matrix every human create is gated
   * on), the intra-plan ref graph, and done-work immutability — BEFORE any
   * write. The proposal is NOT trusted: the planner's self-check is irrelevant
   * here (a human may have edited the set through `updateProposal` since), and
   * the gate is trigger-agnostic by construction — a contextual chat turn, the
   * `/ready` nudge and the auto-plan cadence all land on this one function.
   * A rejection leaves the tree and the plan's status byte-identical.
   */
  async approvePlan(
    planId: string,
    ctx: ServiceContext,
    opts: { provisionalProjectName?: string | null } = {},
  ): Promise<PlanWithItemsDto> {
    // ⚠️ NOT AN ENTRANCE (MOTIR-6038; ADR §11.8). No route, action, hook or tool calls
    // this — every surface decides through `planDecisionService`, with the stamp its
    // reader was shown, and `tests/approvalGates/planDecisionEntrances.test.ts` fails the
    // build on a new production caller. It remains a server-side composer for a caller
    // that rendered nothing: while the plan's question is asked it decides the gate
    // THROUGH THE DOOR, without a reader, so it never writes `approved` around the gate.
    if (await hasAwaitingPlanGate(planId, ctx)) {
      return decideAskedPlanWithoutAReader(planId, 'approve', ctx, opts);
    }
    return plansService.approveUnaskedPlan(planId, ctx, opts);
  },

  /**
   * APPROVE'S PLAIN BODY, for a plan nobody is being asked about (MOTIR-6038) — refused
   * under the plan lock with `PlanGateAwaitingError` while an `awaiting` gate exists, so
   * it can never decide a plan around its question. Reachable only through
   * {@link approvePlan}; the entrances never approve an unasked plan (§11.8: a `planned`
   * plan with no gate is *not decidable yet*).
   */
  async approveUnaskedPlan(
    planId: string,
    ctx: ServiceContext,
    opts: { provisionalProjectName?: string | null } = {},
  ): Promise<PlanWithItemsDto> {
    // THREE PHASES, one per side of the transaction (Story MOTIR-6012 · MOTIR-6035; ADR
    // `approval-gates.md` §11.5): what must be read BEFORE it opens, the body that
    // materializes inside it, and what may only happen AFTER it commits. They are named
    // so the plan gate's handler can run the SAME three around the decide door's own
    // transaction (`approvePlanWithin`) — one home for materialize, never a copy.
    const prep = await prepareApprove(planId, ctx);
    const done = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: prep.plan.projectId },
      (tx) => approveWithin(tx, planId, ctx, prep, { ...opts, viaGate: false }),
      // The raised budget, argued at {@link APPROVE_TX_BUDGET}. Second of the
      // two fixes, not the first: the edge pass above was batched before this
      // number was touched (MOTIR-3396).
      APPROVE_TX_BUDGET,
    ).catch(async (err: unknown) => {
      throw await approveFailure(err, prep, ctx);
    });
    await afterApproveCommit(prep.plan, ctx, done);
    return toPlanWithItemsDto(done.row, done.items);
  },

  /**
   * APPROVE'S PRE-TRANSACTION PHASE, for a caller that owns the transaction — the plan
   * gate's handler, through the decide door's `beforeTransaction` seam (MOTIR-6035; ADR
   * §11.5). Asserts `ai:decide_plan`, runs the first persist-gate pass and resolves the
   * repository pins and references, exactly as {@link approvePlan} does before its own
   * transaction opens. Hand the result to {@link approvePlanWithin}.
   */
  async prepareApprovePlan(planId: string, ctx: ServiceContext): Promise<ApprovePlanPreparation> {
    return prepareApprove(planId, ctx);
  },

  /**
   * APPROVE'S BODY INSIDE THE CALLER'S TRANSACTION (MOTIR-6035; ADR §11.5) — the plan
   * lock, the status and revision-lease refusals, materialize, the `approved` write and
   * its trail row, exactly as {@link approvePlan} runs them. The caller commits, then
   * calls `afterCommit` (the events, the convention trigger, the lock release); on a
   * failure it hands the error to {@link approveFailure} after the rollback.
   *
   * ⚠️ `tx` MUST BE ABLE TO TAKE THE PLAN'S ROW LOCK and should carry
   * {@link APPROVE_TX_BUDGET}: a large plan materializes past Prisma's default budget.
   */
  async approvePlanWithin(
    tx: Prisma.TransactionClient,
    planId: string,
    ctx: ServiceContext,
    prep: ApprovePlanPreparation,
    opts: { provisionalProjectName?: string | null } = {},
  ): Promise<{ plan: PlanWithItemsDto; afterCommit: () => Promise<void> }> {
    // The handler's seam: THE door's effect, so the asked-question refusal is waived.
    const done = await approveWithin(tx, planId, ctx, prep, { ...opts, viaGate: true });
    return {
      plan: toPlanWithItemsDto(done.row, done.items),
      afterCommit: () => afterApproveCommit(prep.plan, ctx, done),
    };
  },

  /**
   * What an approve's failure becomes AFTER its transaction rolled back (MOTIR-6035) —
   * the lazy `stale` backstop on `PlanTargetImmutableError` (MOTIR-3579) and the
   * timeout's typed refusal (MOTIR-3396), exactly as {@link approvePlan} applies them.
   * Returns the error to throw; never swallows the refusal.
   */
  async approveFailure(
    err: unknown,
    prep: ApprovePlanPreparation,
    ctx: ServiceContext,
  ): Promise<unknown> {
    return approveFailure(err, prep, ctx);
  },

  /**
   * End a plan without materializing it: set `declined` + decidedAt/decidedById,
   * record WHY it ended, and KEEP every PlanItem. The tree was NEVER touched
   * (adds never materialized; modify/remove targets untouched) → a clean no-op
   * on the work-item tree.
   *
   * ⚠️ THREE FROM-STATUSES, ONE IMPLEMENTATION (MOTIR-3189, widened by
   * MOTIR-3579). `planned` is the
   * REVIEW decision this method was written for; `generating` is a DISCARD of a
   * plan that never finished being written. They are the same act — stop this
   * plan, keep what it proposed — and the only thing that differs is the
   * `decisionReason` the from-status names, so a second method would be a second
   * copy of the permission check, the row lock, the retention rule and the lock
   * release, kept in step by hand.
   *
   * `stale` (AMENDMENT 9 D4) is the third, and it joins `planned` rather than
   * forming a fourth case: it is a REVIEW decision — the plan reached a reviewer,
   * who read it and gave up because its premise had moved. Declining is one of a
   * stale plan's only two exits (the other is waiting for the drift to reverse),
   * so without this widening the status would be a dead end wearing a live face.
   *
   * ⚠️ AND `generating` HAD NO EXIT AT ALL BEFORE THIS, which is the defect.
   * Both deciders re-read under the row lock and threw unless the status was
   * `planned`, so a plan whose producer died mid-generation could not be
   * approved, declined or discarded by anyone — while
   * `findUndecidedByProject` went on reading it as UNDECIDED and pausing that
   * project's auto-plan cadence for good, with the settings page reporting a
   * proposal waiting on a decision nobody could make. AMENDMENT 2 excluded
   * partial plans from the reconciling sweep precisely to leave that decision to
   * a person; nobody checked that the person had a door.
   *
   * ⚠️ `plannedAt` IS NOT BACK-FILLED on a discard. The generation frontier
   * genuinely never closed, and stamping it would make a plan that died halfway
   * indistinguishable from one that finished and was turned down — the exact
   * conflation `decisionReason` exists to remove.
   *
   * ⚠️ This used to drop every item inside the same transaction, and that is
   * the defect MOTIR-3154 reports (fixed here, MOTIR-3160). Not writing
   * to the tree is what declining MEANS; erasing the proposal is a separate act
   * nobody asked for, and it destroyed the only record of what the planner
   * offered and a person turned down. A declined plan read `0 items` for ever —
   * indistinguishable from a plan that proposed nothing — so the review model
   * had nothing to draw and MOTIR-1377 had to short-circuit the empty state to
   * stop it shadowing the declined outcome. That holds for a DISCARD unchanged,
   * and matters more there: a half-generated plan's proposals are the only
   * record of how far the producer got.
   */
  /**
   * ACQUIRE the revision lease (Story MOTIR-3595 · Subtask MOTIR-3598;
   * `agent-authored-plans.md` AMENDMENT 10 D2) — one `revision_started` row on
   * the plan's own content trail, written under the plan row lock.
   *
   * ⚠️ THE LOCK IS ON THE PLAN ROW, NOT ON THE LEASE. The plan always exists, so
   * the lock is real; a lease "row" may not exist yet, and a `FOR UPDATE` over
   * zero rows locks NOTHING, so every racer would fall through the guard
   * together. This is the reasoning `planTargetLockService` records for locking
   * the work ITEM rather than its lease, and it applies here unchanged.
   *
   * A second acquire while one is held is REFUSED with the same error a racing
   * decision gets — so one plan is revised by one job at a time, which is also
   * what makes it safe for the plan's `sourceJobId` to name the revision that
   * holds it (MOTIR-3599).
   *
   * A DECIDED plan is refused by `assertPlanProposalsEditable`: there is nothing
   * to revise once the proposals have materialized or the decision is closed.
   */
  async acquireRevisionLease(
    planId: string,
    ctx: ServiceContext,
    actor: PlanRevisionAgentActor,
    opts: { jobId?: string } = {},
  ): Promise<{ planId: string; expiresAt: Date }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        assertPlanProposalsEditable(fresh);
        await assertNoRevisionInFlight(planId, tx);

        const at = new Date();
        // ⚠️ THE BIND RIDES THE ACQUIRE, in the same transaction and under the
        // same row lock — it is not a second act and must not be a second door.
        //
        // `sourceJobId` is how the internal seams resolve *the job's plan*
        // (`findBySourceJobId`), so the revision job cannot call back until it is
        // pointed here. Doing it separately would leave a window where the plan
        // is LEASED to a job the seams cannot resolve, and would add a mutation
        // door that writes no trail row — which `planTrailCompleteness` refuses,
        // correctly: every plan mutation is on the record or it is not a mutation
        // this service performs.
        //
        // The column's meaning is unchanged — WHICH JOB — it becomes the job that
        // most recently WROTE this plan, which is what every reader of it wants
        // (`getOutcome` and the abandoned-plan sweep are both scoped to
        // `generating`, which a revised plan is not). The lease is what makes a
        // single scalar safe: one plan is revised by one job.
        //
        // ⚠️ AND THE RE-OPEN RIDES IT TOO (Bug MOTIR-8208). A revision of a
        // `planned` plan moves it back to `generating` for as long as it runs: the
        // revision WRITES the plan again, so its steps and notes (which only a
        // `generating` plan takes) land, and Approve and Decline are unavailable
        // until it closes. The status it came from is recorded on this start row,
        // which is what {@link closeRevision} and every failure path read to give
        // it back. The plan's `plan_approval` gate is untouched: it stays
        // `awaiting` and HELD (the lease is what holds it), so the question a
        // person was asked is the same question when the plan closes again.
        const reopens = fresh.status === 'planned';
        if (opts.jobId || reopens) {
          await planRepository.update(
            planId,
            {
              ...(opts.jobId ? { sourceJobId: opts.jobId } : {}),
              ...(reopens ? { status: 'generating', lastActivityAt: at } : {}),
            },
            tx,
          );
        }
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: REVISION_STARTED_KIND,
            ...generationActor(fresh, ctx),
            actor,
            diff: {
              revision: true,
              ...(opts.jobId ? { jobId: opts.jobId } : {}),
              ...(reopens ? { [REVISION_REOPENED_FROM_KEY]: 'planned' } : {}),
            },
          },
          tx,
        );
        return { planId, expiresAt: new Date(at.getTime() + PLAN_REVISION_LEASE_MS) };
      },
    );
  },

  /**
   * RELEASE the revision lease — one `revision_ended` row, under the same lock.
   *
   * IDEMPOTENT by construction: with nothing held it writes nothing and reports
   * `released: false`. A revision that touches no proposal still releases through
   * here (its pass is over either way), and a job that DIES releases nothing at
   * all — the expiry window in `revisionLease.ts` is the only thing that recovers
   * such a plan, exactly as `targetLock.ts` records of its own.
   *
   * It does NOT assert the plan is editable. A lease taken on a `planned` plan
   * that a race then decided must still be closeable; refusing here would leave a
   * `revision_started` with no terminator on a plan nobody can act on.
   */
  /**
   * IS a revision holding this plan? A READ — no lock, no write.
   *
   * It exists so a submit can refuse a held plan BEFORE it spends an AI job; the
   * ACQUIRE remains the authority and re-checks under the lock, because anything
   * read outside the lock is a courtesy rather than a guarantee.
   */
  async readRevisionLease(
    planId: string,
    ctx: ServiceContext,
  ): Promise<{ heldBy: string | null; expiresAt: Date } | null> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) =>
      revisionLeaseOf(await planRevisionRepository.listByPlan(planId, tx), new Date()),
    );
  },

  async releaseRevisionLease(
    planId: string,
    ctx: ServiceContext,
    actor: PlanRevisionAgentActor,
    diff: Record<string, unknown> = {},
  ): Promise<{ planId: string; released: boolean }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        return plansService.releaseRevisionLeaseWithin(tx, planId, ctx, actor, diff);
      },
    );
  },

  /**
   * RELEASE THE LEASE INSIDE THE CALLER'S TRANSACTION, with no permission assertion
   * (Story MOTIR-7905 · MOTIR-7936) — the body of {@link releaseRevisionLease}, for a SYSTEM
   * caller: the failure settle (a relay's terminal frame, or the abandoned-plan sweep) gives a
   * dead revision's lease back at once, so the plan is decidable now rather than in ten minutes.
   *
   * The caller holds the plan's row lock (`planRepository.lockById`). Idempotent: with nothing
   * held it writes nothing and reports `released: false`, so a relay and the sweep settling one
   * failure leave ONE `revision_ended` row.
   */
  async releaseRevisionLeaseWithin(
    tx: Prisma.TransactionClient,
    planId: string,
    ctx: ServiceContext,
    actor: PlanRevisionAgentActor,
    diff: Record<string, unknown> = {},
    opts: { closeExpired?: boolean } = {},
  ): Promise<{ planId: string; released: boolean }> {
    const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
    if (!fresh) throw new PlanNotFoundError(planId);
    // `closeExpired` reads the lease as of the epoch, so a start with no end counts as held
    // however old it is: the failure settle writes the closing row an expired lease never
    // got, which is what stops the sweep from re-finding the plan on every pass.
    const rows = await planRevisionRepository.listByPlan(planId, tx);
    const held = revisionLeaseOf(rows, opts.closeExpired ? new Date(0) : new Date());
    // A revision that RE-OPENED the plan owes it its status back however its lease
    // stands (Bug MOTIR-8208): a lapsed lease over a `generating` plan is still a
    // plan nobody is writing, and leaving it there is the stuck state this closes.
    const reopened = fresh.status === 'generating' ? revisionReopenedFrom(rows) : null;
    if (!held && !reopened) return { planId, released: false };
    await planRevisionsService.recordRevision(
      {
        planId,
        changeKind: REVISION_ENDED_KIND,
        ...generationActor(fresh, ctx),
        actor,
        diff: { revision: true, ...diff, ...(reopened ? { restoredTo: reopened } : {}) },
      },
      tx,
    );
    if (reopened) await restoreReopenedPlanWithin(planId, tx);
    return { planId, released: true };
  },

  /**
   * {@link restoreReopenedPlanWithin} for a SYSTEM caller that has just ended a
   * re-opening revision itself (`planSessionEndService.releaseRevisionForFailedJob`),
   * in its transaction and under its plan lock.
   */
  async restoreReopenedPlanWithin(tx: Prisma.TransactionClient, planId: string): Promise<void> {
    await restoreReopenedPlanWithin(planId, tx);
  },

  /** {@link settleLapsedRevisionWithin}, for a caller outside this service holding the
   *  plan's lock in its own transaction (the planning-lock sweep, the plan gate's door). */
  async settleLapsedRevisionWithin(
    tx: Prisma.TransactionClient,
    planId: string,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    return settleLapsedRevisionWithin(planId, workspaceId, tx, now);
  },

  /**
   * CLOSE A REVISION (Bug MOTIR-8208) — the end of a revision pass, for the two
   * doors that end one on purpose: a hosted revision's final append and the MCP
   * `hold_plan_revision { op: 'end' }`.
   *
   * A revision that RE-OPENED its plan closes it the way a generation closes —
   * through {@link markPlanned}, so the close's gate, the briefing and the empty
   * close all apply to the revised plan exactly as they did to the first one —
   * and then ends the lease. A revision that did not re-open it (a plan that was
   * still `generating` when the revision began, or one closed already) only ends
   * the lease, as before.
   *
   * ⚠️ A CLOSE THE GATE REFUSES STILL GIVES THE PLAN BACK. The refusal is
   * re-thrown so the caller learns why, but the lease is released first, which
   * restores the plan to `planned` as it stands: a revision whose result cannot
   * be closed must not leave the plan `generating` with nobody writing it, and
   * the person can ask for the revision again.
   */
  async closeRevision(
    planId: string,
    ctx: ServiceContext,
    actor: PlanRevisionAgentActor,
    opts: {
      summary?: string | null;
      /** The job's resolved planning model (Bug MOTIR-8420), for `markPlanned`. */
      authorModel?: string | null;
      /** Extra keys for the `revision_ended` row on the plan's trail. */
      trailDiff?: Record<string, unknown>;
    } = {},
  ): Promise<{ planId: string; released: boolean; planned: boolean; status: string }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    const reopened =
      plan.status === 'generating'
        ? await withWorkspaceServiceContext(ctx.workspaceId, async (tx) =>
            revisionReopenedFrom(await planRevisionRepository.listByPlan(planId, tx)),
          )
        : null;
    let status = plan.status as string;
    if (reopened) {
      try {
        const closed = await plansService.markPlanned(planId, ctx, {
          summary: opts.summary ?? null,
          authorModel: opts.authorModel ?? null,
          revision: true,
        });
        status = closed.status;
      } catch (err) {
        await plansService.releaseRevisionLease(planId, ctx, actor, {
          ...opts.trailDiff,
          closeRefused: true,
        });
        throw err;
      }
    }
    const { released } = await plansService.releaseRevisionLease(
      planId,
      ctx,
      actor,
      opts.trailDiff ?? {},
    );
    return { planId, released, planned: status === 'planned', status };
  },

  /**
   * RENEW a held revision lease — one `revision_renewed` row, under the same lock
   * (Bug MOTIR-7988). The lease's window runs from the latest trail row, so the
   * heartbeat keeps the plan held while a revision is between two real writes.
   * Both kinds of holder call it: an MCP-driven revision (`hold_plan_revision
   * renew`), and a hosted one, whose motir-ai worker renews on a timer for as long
   * as the job runs (Bug MOTIR-8523, through {@link aiGenerationService}'s
   * `renewRevisionLeaseForJob`). A hosted revision's conversation and author
   * sessions can run past the window without writing the trail, so without it the
   * lease lapsed mid-job and the plan read `planned` with a live Approve.
   *
   * ⚠️ `opts.jobId` RENEWS ONLY THAT JOB'S LEASE. A job renews the lease its own
   * acquire took (the `revision_started` row's `jobId`), never one an MCP holder or
   * a later revision took on the same plan: a lease held by anybody else answers
   * `renewed: false` and writes nothing, exactly as a lapsed one does.
   *
   * ⚠️ IT NEVER TAKES A LEASE THAT IS NOT HELD. A lapsed lease means the plan was
   * decidable for a moment and a person may already be reading it as a question,
   * so quietly re-holding it is a decision this door does not make: it answers
   * `renewed: false` and the caller takes it again with
   * {@link plansService.acquireRevisionLease}, which refuses a plan that is no
   * longer editable and one somebody else is revising. Nothing is written then.
   */
  async renewRevisionLease(
    planId: string,
    ctx: ServiceContext,
    actor: PlanRevisionAgentActor,
    opts: { jobId?: string } = {},
  ): Promise<{ planId: string; renewed: boolean; expiresAt: Date | null }> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:view_plan');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      async (tx) => {
        const locked = await planRepository.lockById(planId, tx);
        if (!locked) throw new PlanNotFoundError(planId);
        const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
        if (!fresh) throw new PlanNotFoundError(planId);
        const rows = await planRevisionRepository.listByPlan(planId, tx);
        const now = new Date();
        const held = revisionLeaseOf(rows, now);
        if (!held) return { planId, renewed: false, expiresAt: null };
        if (opts.jobId !== undefined && revisionLeaseJobId(rows, now) !== opts.jobId) {
          return { planId, renewed: false, expiresAt: null };
        }
        const at = new Date();
        await planRevisionsService.recordRevision(
          {
            planId,
            changeKind: REVISION_RENEWED_KIND,
            ...generationActor(fresh, ctx),
            actor,
            diff: { revision: true },
          },
          tx,
        );
        return {
          planId,
          renewed: true,
          expiresAt: new Date(at.getTime() + PLAN_REVISION_LEASE_MS),
        };
      },
    );
  },

  async declinePlan(planId: string, ctx: ServiceContext): Promise<PlanDto> {
    // ⚠️ NOT AN ENTRANCE (MOTIR-6038) — see {@link approvePlan}. An asked plan is
    // declined through the door; an unasked one through the plain body below.
    if (await hasAwaitingPlanGate(planId, ctx)) {
      return decideAskedPlanWithoutAReader(planId, 'decline', ctx, {});
    }
    return plansService.declineUnaskedPlan(planId, ctx);
  },

  /**
   * DECLINE A PLAN NOBODY IS BEING ASKED ABOUT — the one plain decision an entrance
   * makes (ADR §11.8 item 5): a `generating` plan's discard, or a `stale` plan whose
   * question was superseded. There is no gate to decide, so none is recorded; the plan's
   * row and trail record the ending as they always have. Refused under the plan lock
   * with `PlanGateAwaitingError` if a question is asked by the time it runs.
   */
  async declineUnaskedPlan(planId: string, ctx: ServiceContext): Promise<PlanDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    // `ai:decide_plan` (MOTIR-3188) — declining ENDS a plan, which is a decision
    // about somebody's tree even though it writes no work item. It travels with
    // approve rather than with the author writes for that reason: the pair is
    // "who decides", not "who writes to a plan row".
    await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:decide_plan');

    const { row, count } = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
      (tx) => declineWithin(tx, planId, ctx, { viaGate: false }),
    );
    // Declining is as terminal for the lock as approving: the output will never
    // exist, so continuing to hold the targets blocks a colleague for nothing
    // (MOTIR-2787). The tree was never touched, so there is nothing else to undo.
    await releasePlanTargetLocks(plan, ctx);
    return toPlanDto(row, count);
  },

  /**
   * DECLINE'S BODY INSIDE THE CALLER'S TRANSACTION (Story MOTIR-6012 · MOTIR-6035; ADR
   * `approval-gates.md` §11.4–§11.5) — the plan lock, the status and revision-lease
   * refusals, the `declined` write with its reason and its trail row, exactly as
   * {@link declinePlan} runs them. The caller has asserted `ai:decide_plan` (the decide
   * door's floor) and commits, then calls `afterCommit` to release the plan's target
   * locks — which opens its own transaction, so it may never run inside this one.
   */
  async declinePlanWithin(
    tx: Prisma.TransactionClient,
    planId: string,
    ctx: ServiceContext,
  ): Promise<{ plan: PlanDto; afterCommit: () => Promise<void> }> {
    const { row, count } = await declineWithin(tx, planId, ctx, { viaGate: true });
    return { plan: toPlanDto(row, count), afterCommit: () => releasePlanTargetLocks(row, ctx) };
  },
};

// Re-export the DTO `toPlanItemDto` use so the unused-import linter doesn't trip
// when a caller only needs the item mapper through the service module surface.
export { toPlanItemDto };

// ─────────────────────────────────────────────────────────────────────────────
// APPROVE, IN ITS THREE PHASES (Story MOTIR-6012 · MOTIR-6035; ADR
// `approval-gates.md` §11.5). `plansService.approvePlan` composes them around its own
// transaction; the plan gate's handler composes them around the decide door's. The
// bodies are the ones `approvePlan` has always run, moved rather than rewritten.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the plan's question is asked right now — an `awaiting` plan gate (§11.8). A
 *  lock-free courtesy read: the plain bodies re-check it under the plan lock. */
async function hasAwaitingPlanGate(planId: string, ctx: ServiceContext): Promise<boolean> {
  const gate = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planGateService.awaitingFor(planId, tx),
  );
  return gate !== null;
}

/**
 * {@link plansService.approvePlan} / `declinePlan` on an ASKED plan: the door decides it,
 * with no reader (nobody rendered a stamp for this server-side composer), and the gate's
 * state refusals keep the methods' documented contract — a plan somebody already decided
 * is `PlanNotInExpectedStatusError`, carrying the status it is in.
 */
async function decideAskedPlanWithoutAReader(
  planId: string,
  decision: 'approve',
  ctx: ServiceContext,
  opts: { provisionalProjectName?: string | null },
): Promise<PlanWithItemsDto>;
async function decideAskedPlanWithoutAReader(
  planId: string,
  decision: 'decline',
  ctx: ServiceContext,
  opts: { provisionalProjectName?: string | null },
): Promise<PlanDto>;
async function decideAskedPlanWithoutAReader(
  planId: string,
  decision: 'approve' | 'decline',
  ctx: ServiceContext,
  opts: { provisionalProjectName?: string | null },
): Promise<PlanWithItemsDto | PlanDto> {
  // Through `planGateDoor`, NOT `planDecisionService`: that service imports this module,
  // and reaching back into it needed a lazy `await import(...)` the Playwright seed
  // runtime cannot load. The door steps are the same ones `planDecisionService` composes.
  const input: DecidePlanInput = { planId, stamp: DECIDED_WITHOUT_A_READER, source: 'api' };
  try {
    const { plan, gate } = await planAndGate(planId, ctx);
    if (!gate) refuseUngated(plan, decision);
    await decideThroughDoor(gate, decision, input, ctx, opts);
  } catch (err) {
    throw await asPlanStatusRefusal(err, planId, ctx);
  }
  return plansService.getPlan(planId, ctx);
}

/** Approve's PRE-TRANSACTION phase: the plan, the permission, the first gate pass and
 *  every read that opens its own context (so cannot run inside the transaction). */
async function prepareApprove(planId: string, ctx: ServiceContext) {
  const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan) throw new PlanNotFoundError(planId);
  // `ai:decide_plan` (MOTIR-3188) — the DECIDE half, split out of
  // `ai:view_plan`. This is the only path from a proposal to a row and it can
  // create a whole subtree at once, so it is gated by the key whose name says
  // so rather than by the one whose name says "can look at a plan". Behaviour
  // is unchanged for every built-in role: both keys sit at `admin` and
  // `member` and at neither `viewer` nor the implicit workspace-member grant.
  await projectAccessService.assertPermission(plan.projectId, ctx, 'ai:decide_plan');

  // ⚠️ THE LAZY BACKSTOP (MOTIR-3579, AMENDMENT 9 D5). The eager mover is
  // `planDriftService` on `work-item/transitioned`; this is what catches the
  // race it can lose. `PlanTargetImmutableError` means a `modify`/`remove`
  // target reached a terminal status while the plan waited — the one Class B
  // rejection no close-time gate can foresee — and BEFORE this the plan was
  // left sitting at `planned`, unapprovable, with the reviewer told only that
  // their click failed. One button press now never leaves the plan in a worse
  // state than it found it.
  //
  // ⚠️ THE CALLER STILL GETS THE REFUSAL. The error is re-thrown unchanged, so
  // the route still answers 409: what changed is what the plan row READS
  // afterwards, never what the API returns.
  //
  // It wraps BOTH gate passes deliberately. The pre-transaction one is a
  // snapshot and the in-transaction one runs under the target row locks — the
  // reason `runPersistGate` is called twice at all — and drift is exactly the
  // thing that can arrive between them, so a backstop on one pass would leave
  // the other stranding the plan.

  try {
    // The project's TERMINAL statuses — every `category = 'done'` key, never a
    // hardcoded `'done'`, so `cancelled` is terminal too. Workflow statuses are
    // project CONFIG (not a row a concurrent approve moves), so this one read
    // serves both the pre-transaction and the in-transaction gate pass.
    const terminalStatusKeys = await workflowsService.getTerminalStatusKeys(
      plan.projectId,
      ctx.workspaceId,
    );

    // Pass 1 — reject BEFORE the transaction opens (the card's atomicity point:
    // a malformed proposal never even starts a write). Pass 2 runs inside, under
    // the target row locks, and is the verdict that actually gates materialize.
    const preItems = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(planId, tx),
    );
    // ⚠️ THERE IS NOTHING TO APPROVE (MOTIR-4146). Every gate below is a gate
    // over a proposal SET, and over the EMPTY set each of them passes
    // vacuously — which is exactly why the count is read here rather than
    // trusted to them. It is `markPlanned`'s own reasoning at the other door:
    // the emptiness rule was established where a plan is WRITTEN, and an
    // invariant enforced at one door is a habit, not an invariant.
    //
    // Refused rather than discarded: an empty `planned` plan is a legacy row
    // in front of a reviewer, and Decline is the ending they already have —
    // deciding it for them from inside their own Approve click would be a
    // different act than the one they asked for.
    //
    // ⚠️ IT ONLY SPEAKS FOR A PLAN THAT IS OTHERWISE APPROVABLE, and the
    // `status` read is what keeps it from stealing the STATUS refusal. This
    // pass runs BEFORE the transaction, and the status guard runs inside it —
    // so an unguarded check here answers "holds no proposals" for a plan whose
    // real problem is that it is still `generating`, which is the answer a
    // caller branches on (`PlanNotInExpectedStatusError.actual` carries it as
    // DATA for exactly that reason, MOTIR-3025) and the one the CLI prints
    // while it waits for a planner. Emptiness is the second question; the
    // status is the first, and the in-transaction check below asks this one
    // again in the right order anyway.
    if (plan.status === 'planned') assertPlanHasProposals(planId, preItems);
    await runPersistGate(preItems, ctx, terminalStatusKeys, plan.projectId);
    // ⚠️ A MALFORMED BODY LINK STOPS APPROVE (MOTIR-10104). The write doors KEEP a
    // body carrying one and answer with a warning naming the corrected link, so
    // this is the one place it can still be refused before it ships as dead text.
    // It is deliberately NOT part of `runPersistGate`: the correction doors run that
    // gate before/after, and a correction that writes a link it was warned about
    // must be kept, not rolled back. Bodies do not drift under the row locks, so
    // the pre-transaction pass is the whole check.
    const linkBlocker = await proposalLinkWarningsService.firstShippingBlocker(
      preItems,
      planItemLabel,
      ctx,
    );
    if (linkBlocker) throw linkBlocker;

    // The proposed repo PINS (MOTIR-1884), normalized + validated against this
    // PROJECT's repository set. Out here because the domain read opens its own
    // workspace context and cannot nest inside the approve transaction (the same
    // hazard `lib/workItems/targetRepo.ts` documents and the direct-write path
    // obeys) — and because an unknown repo should be rejected while the tree is
    // still byte-identical.
    //
    // ⚠️ RESOLVED FROM A SNAPSHOT, AND THE TRANSACTION RE-CHECKS IT
    // (MOTIR-3604, AMENDMENT 9 D4). This map is read outside the transaction and
    // written inside it, so what makes it safe is a PROPERTY rather than a
    // promise: `assertRepoPinsUnmoved` compares, under the plan lock, the pins
    // the FRESH proposal set authors against the ones resolved here, and refuses
    // the approve when they disagree.
    //
    // It states a property because the alternative decays silently. This comment
    // used to enumerate the doors that could not move a `planned` plan's pins —
    // correctly, on the day it was written — and warned about the one widening
    // its author expected (`mergeProposedFields`). AMENDMENT 8's correction door
    // (`plansService.correctProposal`, MOTIR-3533) arrived through
    // `CorrectProposalInput` instead, eight days later, and walked straight past
    // an enumeration that still read exactly as true as it had before. A list of
    // the ways something cannot happen goes stale with no signal that it has;
    // a re-check does not.
    const repoPins = await resolveProposedTargetRepos(preItems, plan.projectId, ctx);
    const snapshotPins = collectAuthoredTargetRepos(preItems);
    // …and the proposed repository SETS (bug MOTIR-4904), under exactly the
    // same contract: resolved out here against the same project domain by the
    // direct path's own resolvers, re-checked under the plan lock by the same
    // `assertRepoPinsUnmoved`. The two maps are disjoint by construction —
    // `assertSingleTargetRepoInput` refuses a proposal describing the axis more
    // than once — so no proposal appears in both.
    const repoSets = await resolveProposedRepoSets(preItems, plan.projectId, ctx);
    const snapshotRepoSets = collectAuthoredRepoSets(preItems);

    // The proposed repo ROLES (MOTIR-1912) — validated against the vocabulary and
    // collected from the SAME pre-transaction snapshot, so an unknown role is
    // rejected while the tree is still byte-identical. Pure — unlike the name
    // pin, this needs no domain read, because a role's domain is a closed enum.
    //
    // ⚠️ IT DOES *NOT* REST ON THE FROZEN-SET CLAIM THE PIN'S COMMENT ABOVE JUST
    // LOST (MOTIR-3604). A role needs no in-transaction re-check for a stronger
    // reason: nothing STALE is written from this pass. `materialize` and
    // `applyModify` both read `targetRepoRole` off the FRESH row and resolve it
    // there (`proposalRepoRef`), so a role corrected inside approve's window is
    // HONOURED, not dropped — asserted in `approvePlanTargetRepo.test.ts`. And
    // the vocabulary assertion here has no reachable window either, because
    // every door a role can arrive or move through asserts it at its OWN
    // boundary: `validateProposal` at the append, `correctProposal` on a
    // `modify`'s patch, and `CorrectProposalInput` carries no `targetRepoRole`
    // for an `add` at all. What remains is defence in depth, which is what it
    // was always for.
    //
    // The list is ALSO §0.1.1's derivation signal, handed to `proposeRepositorySet`
    // after the commit below.
    const repoRoles = resolveProposedRepoRoles(preItems);

    // PROPOSE the project's repository set BEFORE the tree is materialized (Story
    // MOTIR-2732 · MOTIR-3033, ADR `work-item-repository-set.md` "Amendment
    // 2026-08-18" §A3, answer (b)).
    //
    // It used to run AFTER the commit, and §5.3 of `project-repository-set.md`
    // recorded that ordering as forced. The reading that settled it: this call's
    // ONLY derivation input is `repoRoles`, computed from the pre-transaction
    // proposal snapshot three lines above — nothing in it reads a created work
    // item. So the rows CAN exist first, and once they do a materialized card can
    // point at one from birth instead of carrying a role for a later pass to
    // resolve.
    //
    // ⚠️ It does NOT move INSIDE the transaction, and that is the other half of
    // §A3: `proposeRepositorySet` makes a `server-only` cross-boundary read and
    // writes each row in its OWN transaction (ADR `project-repository-set.md`
    // §4.2's "rows are INDEPENDENT and nothing is rolled back"). Before, not
    // within.
    //
    // Still BEST-EFFORT, for the reason §4.3 gives: establishing repositories is
    // not worth failing a plan approval over. A failure leaves the items with no
    // reference — honestly unrouted, the same signal §5.3's second outcome emits —
    // and the role→item mapping survives on the plan (`plan_item.workItemId` plus
    // its `proposedFields.targetRepoRole`), so a repair is reconstructable.
    //
    // The cost §A3 accepts, stated here because this is where it happens: a
    // rolled-back approve (the in-transaction status re-read rejecting) now leaves
    // `proposed` rows behind. They are editable, the proposer refuses to touch a
    // set that already has rows, and the approve that wins the race writes the
    // same set from the same plan.
    await import('@/lib/services/projectRepoProposalService')
      .then(({ projectRepoProposalService }) =>
        projectRepoProposalService.proposeRepositorySet(plan.projectId, ctx, {
          itemRoles: repoRoles,
        }),
      )
      .catch((err: unknown) => {
        console.warn(
          `[plansService.approvePlan] repository-set proposal failed for project ${plan.projectId}; skipping (the set stays empty and editable)`,
          err,
        );
      });

    // The project's repository ROWS, read AFTER the propose so a first-onboarding
    // plan sees the rows it just caused. This is what turns a proposal's pin — a
    // NAME (§5.4's settled case) or a ROLE (§5.2's portable one) — into the
    // reference a materialized card stores.
    const repoRefs = await resolveProposalRepoRefs(plan.projectId, ctx);

    return {
      plan,
      preItems,
      terminalStatusKeys,
      repoPins,
      snapshotPins,
      repoSets,
      snapshotRepoSets,
      repoRefs,
    };
  } catch (err) {
    await markStaleOnImmutableTarget(err, plan, ctx);
    throw err;
  }
}

/** What {@link prepareApprove} read — handed to the in-transaction body. */
export type ApprovePlanPreparation = Awaited<ReturnType<typeof prepareApprove>>;

/**
 * WHO is running a decision body (MOTIR-6038). `viaGate: true` is the plan gate's
 * handler, inside the decide door's transaction — the ONE writer §11.8 allows while a
 * plan's question is asked. Every other caller is a PLAIN writer and is refused while
 * an `awaiting` gate exists.
 */
interface PlanDecisionBodyOptions {
  viaGate: boolean;
}

/** Refuse a plain decision of a plan whose question is asked — read under the plan
 *  lock the caller already holds, so it races nothing (ADR §11.8's converse). */
async function assertNoAwaitingGateUnlessDeciding(
  planId: string,
  opts: PlanDecisionBodyOptions,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (opts.viaGate) return;
  const awaiting = await planGateService.awaitingFor(planId, tx);
  if (awaiting) throw new PlanGateAwaitingError(planId, awaiting.id);
}

/** Approve's IN-TRANSACTION body, on the caller's `tx`. */
async function approveWithin(
  tx: Prisma.TransactionClient,
  planId: string,
  ctx: ServiceContext,
  prep: ApprovePlanPreparation,
  opts: PlanDecisionBodyOptions & { provisionalProjectName?: string | null },
) {
  const { plan, terminalStatusKeys, repoPins, snapshotPins, repoSets, snapshotRepoSets, repoRefs } =
    prep;
  const locked = await planRepository.lockById(planId, tx);
  if (!locked) throw new PlanNotFoundError(planId);
  // A revision that re-opened the plan and LAPSED gives it back first (MOTIR-8208),
  // so the status read below is the one the lease says it has.
  await settleLapsedRevisionWithin(planId, ctx.workspaceId, tx);
  const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
  if (!fresh) throw new PlanNotFoundError(planId);
  // ⚠️ REFUSE IF A REVISION HOLDS IT (MOTIR-3598, AMENDMENT 10 D2) —
  // under the lock, before a single row is materialized. Approve is
  // one-shot, so the only safe answer to "a revision is halfway through
  // rewriting this set" is not to materialize it. The reviewer waits,
  // reads what changed, and approves the plan they asked for.
  //
  // FIRST, ahead of the status test (Bug MOTIR-8208): a revision RE-OPENS the
  // plan to `generating`, so the status alone would refuse it as not `planned`
  // and lose the answer the reviewer needs — who is revising it, and until when.
  await assertNoRevisionInFlight(planId, tx);
  if (fresh.status !== 'planned') {
    throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned');
  }
  // ⚠️ WHILE A QUESTION IS ASKED, ONLY THE DOOR DECIDES (MOTIR-6038; ADR §11.8's
  // converse) — under the plan lock, which the raise takes too, so no gate can land
  // between this read and the `approved` write.
  await assertNoAwaitingGateUnlessDeciding(planId, opts, tx);
  const proposals = await planItemRepository.findByPlan(planId, tx);
  // …AND THE EMPTINESS CHECK AGAIN, ON THE FRESH SET UNDER THE LOCK
  // (MOTIR-4146). Same placement and same reason as `assertRepoPins
  // Unmoved` below: the pre-transaction pass is a SNAPSHOT, and a
  // withdrawal committed between it and this lock would otherwise
  // materialize nothing while recording an approval. The pre-pass is
  // the courtesy; this one is the guarantee.
  assertPlanHasProposals(planId, proposals);
  // THE GATE, under the plan lock + the targets' row locks, on the FRESH
  // proposal set — nothing has been written yet, so a rejection here rolls
  // back a transaction that touched no work-item row.
  await assertProposalsPersistable(proposals, ctx, terminalStatusKeys, plan.projectId, tx);
  // …AND THE PINS THE SNAPSHOT RESOLVED ARE STILL THE PINS THESE ROWS
  // AUTHOR (MOTIR-3604). Same placement, same reason: on the fresh set,
  // under the lock, before a single row is materialized.
  assertRepoPinsUnmoved(snapshotPins, proposals, snapshotRepoSets);
  const { touchedWorkItemIds, reparented, restingMoves } = await materialize(
    proposals,
    fresh,
    ctx,
    tx,
    repoPins,
    repoRefs,
    repoSets,
  );
  // Read the project ONCE, before `markOnboardingRan` writes: its
  // pre-write `onboardingRanAt` gates the rename below, and its
  // `identifier` (the tenant projectKey) + the first-onboarding signal both
  // feed the fresh-establish convention trigger fired after the tx commits.
  const project = await projectRepository.findById(fresh.projectId, tx);
  // Name the onboarded project from the AI plan (MOTIR-1551). The onboarding
  // generation (MOTIR-1554) stamped a suggested `productName` on the Plan;
  // apply it here — but ONLY on the FIRST onboarding approve of a draft the
  // user hasn't already named. Read BEFORE `markOnboardingRan` below (which
  // sets `onboardingRanAt`), so `onboardingRanAt == null` is the "first
  // onboarding" gate; the `name === provisionalProjectName` check (the
  // caller passes the current-locale "Untitled project" placeholder) means a
  // user rename during review is never clobbered. A reconciliation re-plan
  // carries no `productName`, so it never reaches here. Best-effort: rename
  // failure would abort the tx, so keep it a plain guarded write. Done via
  // the repo in-tx — `renameProject` opens its own workspace context.
  if (fresh.productName && fresh.productName.trim().length > 0 && opts.provisionalProjectName) {
    if (
      project &&
      project.onboardingRanAt == null &&
      project.name === opts.provisionalProjectName
    ) {
      await projectRepository.update(project.id, { name: fresh.productName.trim() }, tx);
    }
  }
  // Stamp the immutable onboarding-ran marker the FIRST time this project's
  // plan is approved + materialized (Subtask 7.4 / MOTIR-1264). The repo's
  // null-guarded write makes it set-once, so calling it on every approve is
  // safe — only the first materialized tree writes it. This is the single
  // source of truth the /onboarding redirect AND the roadmap planning-origin
  // cluster (MOTIR-1013) read. Its return count (1 on the first approve, 0
  // after) IS the onboarding-completion signal the convention trigger fires on.
  const firstOnboarding =
    (await projectRepository.markOnboardingRan(fresh.projectId, new Date(), tx)) === 1;
  const updated = await planRepository.update(
    planId,
    { status: 'approved', decidedAt: new Date(), decidedById: ctx.userId },
    tx,
  );
  // The decision ENDS the conversation that produced it (AMENDMENT 23 §2).
  await endDecidedSession(tx, updated, 'approved', ctx);
  // The approval, on the plan's content trail (MOTIR-3535), inside the
  // very transaction that materialized the tree — so a rolled-back
  // approve (the in-transaction status re-read rejecting, or the budget
  // expiring) leaves no row claiming it happened.
  //
  // A decision is always a PERSON's: `ai:decide_plan` has no machine
  // path, so the row records the decider and NO agent triple, however the
  // plan itself was written. `touchedWorkItemCount` is what the approve
  // actually did to the tree, which is the fact `itemCount` alone cannot
  // give (a plan of `remove`s materializes none).
  await planRevisionsService.recordRevision(
    {
      planId,
      changeKind: 'approved',
      changedById: ctx.userId,
      diff: {
        itemCount: proposals.length,
        touchedWorkItemCount: touchedWorkItemIds.length,
      },
    },
    tx,
  );
  // Re-read so the returned items carry the written-back work-item ids.
  const finalItems = await planItemRepository.findByPlan(planId, tx);
  return {
    row: updated,
    items: finalItems,
    firstOnboarding,
    projectKey: project?.identifier ?? null,
    touchedWorkItemIds,
    reparented,
    restingMoves,
  };
}

/** Approve's POST-COMMIT phase — best-effort events and triggers, never inside a
 *  transaction, never announcing a rolled-back approve. */
async function afterApproveCommit(
  plan: Plan,
  ctx: ServiceContext,
  done: Awaited<ReturnType<typeof approveWithin>>,
): Promise<void> {
  const { touchedWorkItemIds, reparented, restingMoves, firstOnboarding, projectKey } = done;
  // Plan-tree embedding, MATERIALIZE trigger (Story MOTIR-2694 · MOTIR-2696,
  // ADR §6.3.1). AFTER the commit, for the same two reasons the create path
  // emits post-commit: the embedding is an external call that must never sit
  // inside a write transaction (§6.3.2), and a rolled-back approve must not
  // leave jobs embedding rows that do not exist. `sendEvent` is best-effort by
  // construction — a dropped enqueue leaves an item "not yet a candidate",
  // which the backfill later fills and which is never an error (§6.3.5) — so
  // it cannot turn a materialized tree into a failed approve.
  for (const workItemId of touchedWorkItemIds) {
    await sendEvent('work-item/embedding.requested', {
      workspaceId: ctx.workspaceId,
      workItemId,
    });
  }

  // STATUS DERIVATION, for the re-parents this approve performed (MOTIR-3859 ·
  // `docs/decisions/status-derivation.md` §3a). A move changes TWO direct child
  // sets in opposite directions — the parent left may now be finished, the one
  // joined may need to come back — and `work-item/transitioned` fires on
  // neither, which is the whole reason this event exists. `moveWorkItem` emits
  // exactly this for exactly this edit; a re-parent through the plan door is
  // the same edit and owes the same signal, or an approve would be invisible to
  // every job in the system the way `move_to_parent` once was.
  //
  // POST-COMMIT and best-effort, like the embedding trigger above and for the
  // same two reasons: a job must never run inside the write transaction, and a
  // rolled-back approve must not announce a move that did not happen.
  for (const move of reparented) {
    const parentIds = [move.previousParentId, move.newParentId].filter(
      (p): p is string => p !== null,
    );
    // At least one end is non-null by construction — `applyModify` records a
    // move only when the two DIFFER — but a top-level-to-top-level move is not
    // expressible, so the guard is about the type, not about a real case.
    if (parentIds.length === 0) continue;
    await sendEvent('work-item/child-set.changed', {
      workspaceId: ctx.workspaceId,
      parentIds,
      workItemId: move.workItemId,
      reason: 'reparented',
      // The approve's own instant: the row has LEFT its old aggregate, so
      // nothing it can read dates the change (MOTIR-2965, the same argument
      // `moveWorkItem` makes).
      occurredAt: new Date().toISOString(),
    });
  }

  // THE RESTING STATUSES' TRANSITIONS (bug MOTIR-5640 · MOTIR-5646, which
  // supersedes MOTIR-5359's re-scope resets and inherits this loop). Every
  // other status write in the product announces itself with
  // `work-item/transitioned` after its transaction commits — the watcher
  // email, the bell, automation's `transitioned` trigger and status
  // derivation all ride it — and a card the approve returned from `planning`
  // to To Do or Blocked is a status change like any other: its parent's
  // derived status can move with it. POST-COMMIT and best-effort, for the two
  // reasons the events above give. `revisionId` is the one revision
  // `restPlanTargets` recorded, which carries the `status` cell.
  for (const move of restingMoves) {
    await sendEvent('work-item/transitioned', {
      workspaceId: ctx.workspaceId,
      workItemId: move.workItemId,
      actorId: ctx.userId,
      fromStatusKey: move.fromStatusKey,
      toStatusKey: move.toStatusKey,
      revisionId: move.revisionId,
    });
  }

  // Fresh-establish the coding convention at onboarding completion (7.3.10 ·
  // MOTIR-839). The FIRST time a project's onboarding plan is approved +
  // materialized, trigger the fresh `propose_convention` job so a `proposed`
  // convention exists for the user to adopt (the 7.14.5/MOTIR-926 surface). The
  // service applies the FRESH gate itself (a repo-backed project's convention is
  // the migrate/audit path's job, MOTIR-931) and reads the pinned stack over the
  // 7.1 boundary. Fired BEST-EFFORT and AFTER the tx commits: the `server-only`
  // client call cannot run inside the DB transaction, and a motir-ai hiccup must
  // never fail an approve that already materialized the tree (the convention can
  // be re-established later; the approve is the durable, user-visible effect).
  // Imported LAZILY (dynamic import) so the `server-only` motir-ai client stays
  // OUT of plansService's static import graph — the E2E plan seeds import
  // plansService in the Playwright Node process, where `server-only` does not
  // resolve; the client loads only when the trigger actually fires on the server.
  if (firstOnboarding && projectKey) {
    await import('@/lib/services/conventionEstablishService')
      .then(({ conventionEstablishService }) =>
        conventionEstablishService.establishForFreshProject({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          projectId: plan.projectId,
          projectKey,
        }),
      )
      .catch((err: unknown) => {
        console.warn(
          `[plansService.approvePlan] fresh-establish convention trigger failed for project ${plan.projectId}; skipping (a proposal can be re-established later)`,
          err,
        );
      });
  }

  // Give the conversation its targets back — the epic's stories now exist, so
  // the level the lock was held at is finished (MOTIR-2787).
  await releasePlanTargetLocks(plan, ctx, { approved: true });

  // PROPOSE the project's repository set (Story MOTIR-1775 · MOTIR-1881) — the
  // approved plan is what the set's cardinality is derived from, so this is the
  // moment it can be proposed at all. Writes `proposed` rows the establish step
  // then shows as editable (ADR §0.2: Motir proposes, the user decides); it
  // creates nothing on GitHub.
  //
  // Fired on EVERY approve, not only the first onboarding: the proposer's own
  // guard is "a project whose set has any row is left completely alone", so a
  // re-plan approve of an established project is one cheap read, while a project
  // whose first attempt lost to a motir-ai hiccup gets another chance instead of
  // being permanently setless.
  //
  // BEST-EFFORT and AFTER the tx commits, for both of the reasons the convention
  // trigger above is: the pre-plan read is a `server-only` client call that
  // cannot run inside the DB transaction, and establishing repos — important as
  // it is — is not worth failing a plan approval over (ADR §4.3 is the same
  // judgement one level down). A failure leaves the user an empty-but-editable
  // set, which MOTIR-1782 can complete later (ADR §4.4: approval is not the last
  // chance to establish a repo). Imported LAZILY for the same reason: the E2E
  // plan seeds import plansService in the Playwright Node process, where
  // `server-only` does not resolve.
}

/** The error an approve's failure becomes after its rollback: the lazy `stale` backstop
 *  runs, and a transaction timeout reads as its typed refusal. */
async function approveFailure(
  err: unknown,
  prep: ApprovePlanPreparation,
  ctx: ServiceContext,
): Promise<unknown> {
  await markStaleOnImmutableTarget(err, prep.plan, ctx);
  try {
    translateApproveTimeout(err, prep.plan.id, prep.preItems.length);
  } catch (translated) {
    return translated;
  }
}

/** THE LAZY BACKSTOP (MOTIR-3579, AMENDMENT 9 D5) — see `approvePlan`'s note on it. */
async function markStaleOnImmutableTarget(
  err: unknown,
  plan: { id: string; projectId: string },
  ctx: ServiceContext,
): Promise<void> {
  const planId = plan.id;
  if (err instanceof PlanTargetImmutableError) {
    // BEST-EFFORT, and it must not mask the refusal. If this write fails the
    // caller still gets its 409 and the eager listener remains the primary
    // mover — so a swallowed error here costs a status flip, never the
    // verdict. Lock-then-re-read, the same guard `markPlanned` /
    // `declinePlan` use: a plan somebody decided under us is a no-op.
    try {
      await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: plan.projectId },
        async (tx) => {
          const locked = await planRepository.lockById(planId, tx);
          if (!locked) return;
          const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
          if (!fresh || fresh.status !== 'planned') return;
          await planRepository.update(planId, { status: 'stale' }, tx);
          // A stale plan cannot be approved, so its question is withdrawn in the
          // same write (MOTIR-6036; §11.7) — plan lock first, then the gate.
          await planGateService.supersede(planId, 'plan_stale', tx);
        },
      );
    } catch {
      // Swallowed on purpose — see above.
    }
  }
}

/** Decline's IN-TRANSACTION body (MOTIR-6035) — `declinePlan` and the plan gate's
 *  handler both run it; see `declinePlan` for every rule it keeps. */
/**
 * End the session a just-decided plan came from (AMENDMENT 23 §2) — in the
 * decision's own transaction, by the decider, and only when the plan is that
 * session's LATEST: deciding an earlier plan of a conversation that has since
 * produced a newer one leaves the conversation open, the same rule the lock
 * release applies after commit (`releasePlanTargetLocks`). The plan row is
 * already locked here, so the end takes the session's lock second, in the order
 * the end operation takes them.
 *
 * The cards are NOT given back here: the decision's after-commit step releases
 * the plan's and the session's locks exactly as it always has.
 */
async function endDecidedSession(
  tx: Prisma.TransactionClient,
  plan: Plan,
  reason: 'approved' | 'declined',
  ctx: ServiceContext,
): Promise<void> {
  if (!plan.sessionId) return;
  if ((await planRepository.findLatestIdBySession(plan.sessionId, tx)) !== plan.id) return;
  await endSessionWithin(tx, plan.sessionId, ctx.workspaceId, reason, {
    endedById: ctx.userId,
    actor: ctx,
  });
}

async function declineWithin(
  tx: Prisma.TransactionClient,
  planId: string,
  ctx: ServiceContext,
  opts: PlanDecisionBodyOptions,
) {
  const locked = await planRepository.lockById(planId, tx);
  if (!locked) throw new PlanNotFoundError(planId);
  // A lapsed re-opening revision gives the plan back first (MOTIR-8208): declining it
  // is then the decision on a `planned` plan it is, never a DISCARD of one being written.
  await settleLapsedRevisionWithin(planId, ctx.workspaceId, tx);
  const fresh = await planRepository.findById(planId, ctx.workspaceId, tx);
  if (!fresh) throw new PlanNotFoundError(planId);
  if (fresh.status !== 'planned' && fresh.status !== 'generating' && fresh.status !== 'stale') {
    // `approved` / `declined` — already decided. The message names both
    // legal origins so the 409 says what would have worked, and `actual`
    // still rides the field for a caller that has to branch on it
    // (MOTIR-3025).
    throw new PlanNotInExpectedStatusError(planId, fresh.status, 'planned, stale or generating');
  }
  // A DECLINE is refused under the lease too, and for a reason of its own:
  // `declined` is a closed decision, so a revision that finishes writing
  // into a declined plan leaves proposals on a plan nobody will ever read.
  // Ahead of the gate test, so a plan a revision RE-OPENED (MOTIR-8208) is
  // refused for the revision, which is the reason that holds.
  await assertNoRevisionInFlight(planId, tx);
  // The PLAIN decline is for a plan nobody is being asked about (§11.8 item 5 — a
  // `generating` or `stale` plan); an asked one is declined through the door.
  await assertNoAwaitingGateUnlessDeciding(planId, opts, tx);
  const updated = await planRepository.update(
    planId,
    {
      status: 'declined',
      decidedAt: new Date(),
      decidedById: ctx.userId,
      // The FROM-status is the reason, and it is read under the lock
      // rather than from the pre-lock `plan` — a plan that reached
      // `planned` while this call was in flight was reviewed, not
      // discarded, and the record should say so.
      // ⚠️ `stale` RECORDS `reviewed`, WITH `planned` (MOTIR-3579,
      // AMENDMENT 9 D4). The reason names the HISTORY, and a stale plan's
      // history is that it reached a reviewer and was read — the drift is
      // why they gave up, not a different kind of ending. `discarded` is
      // for a plan that never finished being written, which this one did.
      decisionReason:
        fresh.status === 'planned' || fresh.status === 'stale' ? 'reviewed' : 'discarded',
    },
    tx,
  );
  // A person's decline ENDS the conversation that produced it (AMENDMENT 23 §2).
  await endDecidedSession(tx, updated, 'declined', ctx);
  // The real count, read inside the same transaction — `markPlanned` above
  // does exactly this. The return used to be `toPlanDto(row, 0)`, a
  // hardcoded zero that was true only while the delete above existed; with
  // the rows retained it would tell the caller that just declined a plan it
  // has no items while `listPlans` (which counts through
  // `countByPlanIds`) says otherwise (MOTIR-3160).
  const n = await planItemRepository.countByPlan(planId, tx);
  // The ending, on the trail (MOTIR-3535). A decision is always a PERSON's
  // — `ai:decide_plan` has no machine path — so it records the decider and
  // no agent triple, however the plan itself was written. The reason is the
  // same one the row stores, so the timeline can tell the three histories
  // `declined` covers apart without re-deriving them (MOTIR-3189).
  await planRevisionsService.recordRevision(
    {
      planId,
      changeKind: 'declined',
      changedById: ctx.userId,
      diff: { itemCount: n, decisionReason: updated.decisionReason },
    },
    tx,
  );
  return { row: updated, count: n };
}
