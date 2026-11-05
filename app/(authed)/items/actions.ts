'use server';

import { reviewStateService } from '@/lib/services/reviewStateService';
import type { CardReviewMap } from '@/lib/dto/reviewState';
import { revalidatePath } from 'next/cache';
import { resolveActionReadActor } from '@/lib/visitor/readActor';
import { redirect } from 'next/navigation';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { explanationLanguageFromClient } from '@/lib/ai/explanationSource';
import type { Locale } from '@/lib/i18n/locales';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import type { PendingDecisionMap } from './_components/issueRows';
import { isIssueType } from '@/lib/issues/parentRules';
import { isRelationshipKind } from '@/lib/workItems/linkRelationships';
import { parseSort } from '@/lib/issues/issueListView';
import { linkErrorMessage } from '@/lib/workItems/linkErrorMessages';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { EntitlementExceededError } from '@/lib/billing/errors';
import type { EntitlementKind } from '@/lib/billing/entitlements';
import {
  IllegalParentTypeError,
  WorkItemError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { WorkItemLinkError } from '@/lib/workItems/linkErrors';
import {
  CrossProjectFolderError,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
  InvalidFolderNameError,
  SubtaskNeedsPlacementError,
} from '@/lib/folders/errors';
import { foldersService } from '@/lib/services/foldersService';
import type {
  DeleteFolderResultDto,
  FolderDeletionPreviewDto,
  FolderDto,
  ProjectFoldersDto,
} from '@/lib/dto/folders';
import type {
  CreateWorkItemLinkInput,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
  WorkItemExplanationSourceDto,
  ExecutorDto,
  WorkItemSummaryDto,
  TreeLevelDto,
  PagedArchivedWorkItemsDto,
} from '@/lib/dto/workItems';

// Server Actions for the create-issue surface (Subtask 2.3.3). Transport only:
// resolve the session + the ACTIVE project (the shipped shell has no
// `projects/[key]` route tree — projects are resolved from the workspace
// context, the same model 2.2.5's workflow settings use), call the ONE shipped
// service method (`workItemsService.createWorkItem`, Story 1.4 — it owns key
// allocation, initial-status seeding, the parent gate, and the create
// revision), and translate typed errors. NO business logic, NO service
// extension. The reporter is ALWAYS the session user, set here from the
// resolved context — never read from the client payload.

const ISSUES_PATH = '/items';
const MAX_TITLE_LENGTH = 200;

/** The whitelisted fields the modal submits. Anything else on the wire (e.g. a
 *  forged `reporterId`) is dropped — only these named fields reach the service. */
export interface CreateIssueInput {
  kind: WorkItemKindDto;
  title: string;
  descriptionMd?: string | null;
  // The "why this matters" axis (Story 1.4). Optional at create time (the modal
  // exposes it as a collapsible section per design/work-items/create.png); when
  // a human types it, the service defaults explanationSource to user_authored.
  // "Draft with AI" (Subtask 8.8.12) is now wired in the modal.
  explanationMd?: string | null;
  // Explanation provenance (Subtask 8.8.12). The modal sends `ai_draft` for an
  // untouched AI draft, `user_edited` after the user edits a draft, and OMITS it
  // for a hand-typed explanation (the service then defaults it to
  // `user_authored`). Whitelisted here so it actually reaches the service —
  // otherwise an AI draft would persist as `user_authored` (create-action
  // whitelist drops un-listed fields).
  explanationSource?: WorkItemExplanationSourceDto;
  // The language a drafted explanation was written in (MOTIR-8744). Only
  // `explanation` is honoured (`explanationLanguageFromClient`); a hand-typed
  // explanation sends none and records the organisation's content language.
  languages?: { explanation?: Locale };
  priority?: WorkItemPriorityDto;
  // Accepted for forward-compat but NOT yet surfaced in the modal: the filtered
  // parent picker is 2.3.4, the assignee combobox a later subtask. Until those
  // land the modal omits them and an issue is created top-level + unassigned.
  parentId?: string | null;
  assigneeId?: string | null;
  // Work-item type + executor (Story 2.7), leaf-only. The modal sends them only
  // when a type was chosen on a leaf kind; the service enforces leaf-only and
  // seeds the executor from the type→executor default when a type arrives
  // without one (seed-if-absent). Whitelisted here so they actually reach the
  // service — omitting them silently dropped the picker's choice on create
  // (the patch/inline-edit path persisted type, but create did not).
  type?: WorkItemTypeDto | null;
  executor?: ExecutorDto | null;
  // Optional Due date (Subtask 2.3.12 — the modal's DatePicker field; finding
  // #56 "mirror Jira"). An ISO 8601 string the service stores on the work item;
  // omitted/null when no date is chosen (Due date is nullable).
  dueDate?: string | null;
  // Links to create with the issue (Subtask 2.4.10 — the modal's "Linked
  // issues" section). Each is the user-facing (relationship, target) pair; the
  // service resolves direction + writes them atomically with the item. Validated
  // here against the five relationship kinds before reaching the service.
  links?: CreateWorkItemLinkInput[];
}

export type CreateIssueResult =
  | { ok: true; id: string; identifier: string }
  | { ok: false; error: string; field?: 'parent' | 'links'; entitlement?: EntitlementKind };

export async function createIssueAction(input: CreateIssueInput): Promise<CreateIssueResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.noProjectForIssue') };

  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: t('actions.titleRequired') };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: t('actions.titleTooLong', { max: MAX_TITLE_LENGTH }) };
  }

  // Whitelist the pending links: keep only well-formed (relationship, target)
  // pairs (a forged relationship / empty target is dropped before the service).
  const links = (input.links ?? []).filter(
    (l): l is CreateWorkItemLinkInput => Boolean(l.targetId) && isRelationshipKind(l.relationship),
  );

  try {
    const issue = await workItemsService.createWorkItem(
      {
        projectId: ctx.projectId,
        kind: input.kind,
        title,
        descriptionMd: input.descriptionMd?.trim() ? input.descriptionMd : null,
        explanationMd: input.explanationMd?.trim() ? input.explanationMd : null,
        // Only forward the source when there's actually explanation text + an AI
        // provenance to record; a blank explanation carries no source claim.
        ...(input.explanationSource && input.explanationMd?.trim()
          ? { explanationSource: input.explanationSource }
          : {}),
        ...explanationLanguageFromClient(input.languages, input.explanationMd),
        parentId: input.parentId ?? null,
        assigneeId: input.assigneeId ?? null,
        ...(input.priority ? { priority: input.priority } : {}),
        // Type + executor (Story 2.7), leaf-only: forward only when a type was
        // chosen, mirroring the modal's payload shape. `executor` rides along
        // (the service seeds it from the type default if absent).
        ...(input.type
          ? { type: input.type, ...(input.executor ? { executor: input.executor } : {}) }
          : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(links.length ? { links } : {}),
        // Planning provenance (MOTIR-1685): a human creating in the UI → source
        // `manual` (harness/model null). SERVER-SET here — it is deliberately NOT
        // a field on `CreateIssueInput`, so a client-forged `planningSource` never
        // reaches the DB (the same discipline the whitelist applies to
        // `reporterId`, which the ServiceContext below sets).
        provenance: { planning: { source: 'manual' } },
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId }, // reporter = session user
    );
    revalidatePath(ISSUES_PATH);
    return { ok: true, id: issue.id, identifier: issue.identifier };
  } catch (err) {
    // An illegal parent is a field-level problem — surface it inline on the
    // parent picker, not as a toast.
    if (err instanceof IllegalParentTypeError)
      return { ok: false, error: workItemErrorMessage(err, t), field: 'parent' };
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, error: t('actions.projectGone') };
    }
    // A bad pending link (cycle / cross-workspace / duplicate) aborts the whole
    // create (one transaction — the issue is NOT created) and surfaces inline on
    // the Linked-issues section. WorkItemLinkError is its OWN hierarchy (not a
    // WorkItemError), so this branch precedes the generic one below.
    if (err instanceof WorkItemLinkError) {
      return {
        ok: false,
        error: linkErrorMessage(err, t) ?? t('actions.couldNotLink'),
        field: 'links',
      };
    }
    // §4 work-item cap hit (8.1.11) — the org is at its free-tier ceiling.
    // The DISCRIMINATOR crosses the boundary and the modal picks the translated
    // sentence by it (MOTIR-5133); `error` stays the server's English string,
    // which no reader-facing arm renders for a refusal that carries a kind.
    if (err instanceof EntitlementExceededError) {
      return { ok: false, error: err.message, entitlement: err.entitlement };
    }
    // Any other typed work-item error (cross-project parent, assignee/reporter
    // not a member, …) surfaces as a toast with its own message.
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    throw err;
  }
}

export type ListCreateLinkCandidatesResult =
  | { ok: true; candidates: WorkItemSummaryDto[] }
  | { ok: false; error: string };

/**
 * Candidate target issues for the create modal's "Linked issues" picker
 * (Subtask 2.4.10; server-search since 6.9.2): the 6.9.1 quick-search by `query`
 * (key + title, workspace + 6.4-permission-scoped, bounded) — the Combobox
 * fetches this per keystroke, an empty / short query returns `[]`. No current
 * item to exclude (the issue isn't created yet); the modal drops already-pending
 * targets client-side. Resolves the active project server-side, like
 * createIssueAction.
 */
export async function listCreateLinkCandidatesAction(
  query: string,
): Promise<ListCreateLinkCandidatesResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: (await getErrorsTranslator())('actions.pickProjectFirst') };

  const candidates = await workItemsService.listCreateLinkCandidates(query, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return { ok: true, candidates };
}

export type ListCandidateParentsResult =
  | { ok: true; candidates: WorkItemSummaryDto[] }
  | { ok: false; error: string };

/**
 * Candidate parents for the parent picker (Subtask 2.3.4): the active project's
 * non-archived work items whose kind may legally hold a `childType`, pre-
 * filtered by the inverted kind-parent matrix so the UI can't construct an
 * illegal pair. Resolves the active project server-side (same active-project
 * model as createIssueAction); `childType` is validated against the issue-type
 * set before it reaches the service.
 */
export async function listCandidateParentsAction(
  childType: string,
): Promise<ListCandidateParentsResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: t('actions.noProjectForParent') };
  if (!isIssueType(childType)) return { ok: false, error: t('actions.unknownIssueType') };

  const candidates = await workItemsService.listCandidateParents(ctx.projectId, childType, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return { ok: true, candidates };
}

// ── Lazy tree reads (Subtask 2.5.14, finding #57) ──────────────────────────
// Transport for the lazy Tree view: the client fetches ONE level on expand /
// "load more" / sort change. Resolve the session + active project, parse the
// sort through the trusted whitelist (never the client's raw value), call the
// shipped 2.5.13 read, return the level. `listChildIssues` gates the parent by
// workspace in the service (a cross-workspace/missing parent → a not-found,
// surfaced here as a benign error, never a leak).

/** `?sort=`-string in (parsed through the whitelist) + an offset for paging. */
export interface ListTreeLevelInput {
  sortParam: string;
  offset?: number;
}

/**
 * A level plus `pendingDecisionsFor`'s answer for ITS work-item rows (Story
 * MOTIR-4908 · MOTIR-5881) — asked once per level, never per row, and carried
 * beside the DTOs rather than on them. A folder row gets no entry.
 */
export type TreeLevelResult =
  | { ok: true; level: TreeLevelDto; pending: PendingDecisionMap; reviews: CardReviewMap }
  | { ok: false; error: string };

/** The decision-waiting answer for one level's work-item rows. */
async function pendingForLevel(
  level: TreeLevelDto,
  ctx: { userId: string; workspaceId: string; projectId: string },
): Promise<PendingDecisionMap> {
  return Object.fromEntries(
    await approvalGatesService.pendingDecisionsFor(
      {
        projectId: ctx.projectId,
        workItemIds: level.rows.filter((row) => row.kind !== 'folder').map((row) => row.id),
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    ),
  );
}

/**
 * The decision answer AND the review markers / Reviewed badges (Story MOTIR-10327 ·
 * MOTIR-10341) for one level's work-item rows — each one batch, asked together.
 */
async function answersForLevel(
  level: TreeLevelDto,
  ctx: { userId: string; workspaceId: string; projectId: string },
): Promise<{ pending: PendingDecisionMap; reviews: CardReviewMap }> {
  const ids = level.rows.filter((row) => row.kind !== 'folder').map((row) => row.id);
  const [pending, reviews] = await Promise.all([
    pendingForLevel(level, ctx),
    reviewStateService.cardReviewsFor(ctx.projectId, ids, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
  ]);
  return { pending, reviews };
}

/** What a tree level answers a Visitor who has spent their read budget (MOTIR-6647). */
const VISITOR_RATE_LIMITED = 'You’re reading a little too fast. Try again in a moment.';

export async function listRootIssuesAction(input: ListTreeLevelInput): Promise<TreeLevelResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  // A VISITOR's tree (MOTIR-6647): the root of the public project the
  // `motir_visitor` cookie names, private-epic descendants withheld (MOTIR-6644).
  // A Visitor decides nothing, so no card is waiting on them.
  const actor = await resolveActionReadActor();
  if (actor.kind === 'limited') return { ok: false, error: VISITOR_RATE_LIMITED };
  if (actor.kind === 'visitor') {
    const level = await workItemsService.listRootIssues(
      actor.ctx.project.id,
      { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
      actor.ctx,
    );
    return { ok: true, level, pending: {}, reviews: {} };
  }
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  const level = await workItemsService.listRootIssues(
    ctx.projectId,
    { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
  return { ok: true, level, ...(await answersForLevel(level, ctx)) };
}

export async function listChildIssuesAction(
  input: ListTreeLevelInput & { parentId: string },
): Promise<TreeLevelResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  // A VISITOR's drill (MOTIR-6647): a hidden parent is the same "no longer exists"
  // an unknown one is (MOTIR-6644).
  const actor = await resolveActionReadActor();
  if (actor.kind === 'limited') return { ok: false, error: VISITOR_RATE_LIMITED };
  if (actor.kind === 'visitor') {
    try {
      const level = await workItemsService.listChildIssues(
        input.parentId,
        { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
        actor.ctx,
      );
      return { ok: true, level, pending: {}, reviews: {} };
    } catch (err) {
      if (err instanceof WorkItemNotFoundError) {
        return { ok: false, error: 'That issue no longer exists.' };
      }
      throw err;
    }
  }
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  try {
    const level = await workItemsService.listChildIssues(
      input.parentId,
      { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, level, ...(await answersForLevel(level, ctx)) };
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return { ok: false, error: 'That issue no longer exists.' };
    }
    throw err;
  }
}

/**
 * One FOLDER's level for the lazy tree (Story MOTIR-5308 · MOTIR-5315) — its
 * child folders, then the work items filed in it, paged like a work item's
 * children. The service gates on browsing the folder's project; a folder that
 * vanished (deleted in another tab) is a benign error, never a leak.
 */
export async function listFolderLevelAction(
  input: ListTreeLevelInput & { folderId: string },
): Promise<TreeLevelResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  // A VISITOR's folder level (MOTIR-6647): a folder of another project is the same
  // "no longer exists" an unknown one is.
  const actor = await resolveActionReadActor();
  if (actor.kind === 'limited') return { ok: false, error: VISITOR_RATE_LIMITED };
  if (actor.kind === 'visitor') {
    try {
      const level = await workItemsService.listFolderLevel(
        input.folderId,
        { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
        actor.ctx,
      );
      return { ok: true, level, pending: {}, reviews: {} };
    } catch (err) {
      if (err instanceof FolderNotFoundError) {
        return { ok: false, error: 'That folder no longer exists.' };
      }
      throw err;
    }
  }
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  try {
    const level = await workItemsService.listFolderLevel(
      input.folderId,
      { sort: parseSort(input.sortParam), offset: input.offset ?? 0 },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, level, ...(await answersForLevel(level, ctx)) };
  } catch (err) {
    if (err instanceof FolderNotFoundError) {
      return { ok: false, error: 'That folder no longer exists.' };
    }
    throw err;
  }
}

// ── Folder create + rename (Story MOTIR-5308 · MOTIR-5344) ─────────────────
// Transport for the tree's inline folder name row: resolve the session + active
// project, call ONE `foldersService` method, and hand every expected refusal back
// as a stable `code` — the tree renders the name collision inline and toasts the
// rest. No folder rule lives here (CLAUDE.md's 4-layer contract).

export type FolderWriteErrorCode =
  | 'FOLDER_NAME_TAKEN'
  | 'INVALID_FOLDER_NAME'
  | 'FOLDER_NOT_FOUND'
  | 'CROSS_PROJECT_FOLDER'
  | 'FOLDER_CYCLE'
  | 'SUBTASK_NEEDS_PLACEMENT'
  | 'PROJECT_ACCESS_DENIED'
  | 'NO_ACTIVE_PROJECT';

export type FolderWriteResult =
  | { ok: true; folder: FolderDto }
  | {
      ok: false;
      code: FolderWriteErrorCode;
      error: string;
      /** `FOLDER_NAME_TAKEN`: the name that collided, when the service knows it. */
      folderName?: string | null;
    };

function folderWriteFailure(err: unknown): Extract<FolderWriteResult, { ok: false }> | null {
  if (err instanceof FolderNameTakenError) {
    return { ok: false, code: err.code, error: err.message, folderName: err.folderName };
  }
  if (err instanceof InvalidFolderNameError) {
    return { ok: false, code: err.code, error: err.message };
  }
  if (err instanceof SubtaskNeedsPlacementError) {
    return { ok: false, code: err.code, error: err.message };
  }
  if (err instanceof FolderNotFoundError) {
    return { ok: false, code: err.code, error: 'That folder no longer exists.' };
  }
  if (err instanceof CrossProjectFolderError) {
    return { ok: false, code: err.code, error: 'That folder belongs to another project.' };
  }
  if (err instanceof FolderCycleError) {
    return { ok: false, code: err.code, error: 'A folder can’t move into one of its own folders.' };
  }
  if (err instanceof ProjectAccessDeniedError) {
    return { ok: false, code: err.code, error: 'You can’t change folders in this project.' };
  }
  return null;
}

export async function createFolderAction(input: {
  parentFolderId: string | null;
  name: string;
}): Promise<FolderWriteResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, code: 'NO_ACTIVE_PROJECT', error: 'No active project.' };
  try {
    const folder = await foldersService.createFolder(
      {
        projectId: ctx.projectId,
        parentFolderId: input.parentFolderId ?? null,
        name: String(input.name ?? ''),
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, folder };
  } catch (err) {
    const failure = folderWriteFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function renameFolderAction(input: {
  folderId: string;
  name: string;
}): Promise<FolderWriteResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, code: 'NO_ACTIVE_PROJECT', error: 'No active project.' };
  try {
    const folder = await foldersService.renameFolder(
      { projectId: ctx.projectId, folderId: input.folderId, name: String(input.name ?? '') },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, folder };
  } catch (err) {
    const failure = folderWriteFailure(err);
    if (failure) return failure;
    throw err;
  }
}

// ── Folder move + reorder (Story MOTIR-5308 · MOTIR-5345) ──────────────────
// Transport for Move to… and Move up / Move down. A reorder is a move to the
// folder's own parent with neighbours; `beforeId` / `afterId` keep
// `MoveFolderInput`'s semantics. The picker's folder list is a read: a member who
// may browse the project gets it.

export async function moveFolderAction(input: {
  folderId: string;
  targetParentFolderId: string | null;
  beforeId?: string | null;
  afterId?: string | null;
}): Promise<FolderWriteResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, code: 'NO_ACTIVE_PROJECT', error: 'No active project.' };
  try {
    const folder = await foldersService.moveFolder(
      {
        projectId: ctx.projectId,
        folderId: input.folderId,
        targetParentFolderId: input.targetParentFolderId ?? null,
        beforeId: input.beforeId ?? null,
        afterId: input.afterId ?? null,
      },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, folder };
  } catch (err) {
    const failure = folderWriteFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export type ListProjectFoldersResult =
  | { ok: true; data: ProjectFoldersDto }
  | { ok: false; error: string };

export async function listProjectFoldersAction(): Promise<ListProjectFoldersResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  try {
    const data = await foldersService.listProjectFolders(
      { projectId: ctx.projectId },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ProjectAccessDeniedError) {
      return { ok: false, error: 'You don’t have access to this project’s folders.' };
    }
    throw err;
  }
}

// ── Folder delete (Story MOTIR-5308 · MOTIR-5346) ──────────────────────────
// The delete confirmation reads what the delete WOULD move before the person
// confirms, then the delete itself. Both refusals of a delete — a child folder's
// name already at the destination, a subtask that would land at the root — come
// back as codes the open dialog renders.

export type FolderFailure = Extract<FolderWriteResult, { ok: false }>;

export async function describeFolderDeletionAction(input: {
  folderId: string;
}): Promise<{ ok: true; preview: FolderDeletionPreviewDto } | FolderFailure> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, code: 'NO_ACTIVE_PROJECT', error: 'No active project.' };
  try {
    const preview = await foldersService.describeFolderDeletion(
      { projectId: ctx.projectId, folderId: input.folderId },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, preview };
  } catch (err) {
    const failure = folderWriteFailure(err);
    if (failure) return failure;
    throw err;
  }
}

export async function deleteFolderAction(input: {
  folderId: string;
}): Promise<{ ok: true; result: DeleteFolderResultDto } | FolderFailure> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, code: 'NO_ACTIVE_PROJECT', error: 'No active project.' };
  try {
    const result = await foldersService.deleteFolder(
      { projectId: ctx.projectId, folderId: input.folderId },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, result };
  } catch (err) {
    const failure = folderWriteFailure(err);
    if (failure) return failure;
    throw err;
  }
}

// ── Archived items read (Story 2.9 · Subtask 2.9.2) ────────────────────────
// Transport for the archive-management surface (the view UI is 2.9.3): resolve
// the session + active project, call the shipped read, return the page. The
// service gates on `canBrowse` and treats a cross-workspace/missing project as
// a not-found (surfaced here as a benign error, never a leak). `page` is the
// 1-based pager position; the service clamps it to the last page.

/** 1-based page of the archived view (defaults to page 1). */
export interface ListArchivedWorkItemsInput {
  page?: number;
}

export type ListArchivedWorkItemsResult =
  | { ok: true; data: PagedArchivedWorkItemsDto }
  | { ok: false; error: string };

export async function listArchivedWorkItemsAction(
  input: ListArchivedWorkItemsInput = {},
): Promise<ListArchivedWorkItemsResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) return { ok: false, error: 'No active project.' };
  try {
    const data = await workItemsService.listArchivedWorkItems(
      ctx.projectId,
      { page: input.page },
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
    );
    return { ok: true, data };
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, error: 'That project no longer exists.' };
    }
    throw err;
  }
}
