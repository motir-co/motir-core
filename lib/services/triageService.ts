import type { Prisma, WorkItem } from '@/generated/prisma/client';
import {
  workItemRepository,
  type WorkItemUpdateInput,
} from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { readMembership } from '@/lib/workspaces/membershipGate';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { commentsService } from '@/lib/services/commentsService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { SprintNotFoundError, CrossProjectSprintAssignmentError } from '@/lib/sprints/errors';
import { WorkItemNotFoundError, CrossProjectParentError } from '@/lib/workItems/errors';
import { assertValidParent } from '@/lib/issues/parentRules';
import { keyForAppend, keyBetween } from '@/lib/workItems/positioning';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type {
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemKindDto,
  WorkItemDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type {
  TriageQueuePageDto,
  TriageItemDetailDto,
  TriageSubmitterDto,
  TriageSubmissionResultDto,
} from '@/lib/dto/triage';
import { toTriageQueueItemDto } from '@/lib/mappers/triageMappers';
import { clampTriageLimit, decodeTriageCursor, encodeTriageCursor } from '@/lib/triage/triageQueue';
import {
  NotInTriageError,
  TriageSelfMergeError,
  InvalidSnoozeUntilError,
  InvalidTriageSubmissionKindError,
  InvalidTriageSubmissionTitleError,
  MAX_TRIAGE_TITLE_LENGTH,
} from '@/lib/triage/errors';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';
import { readProject, readProjectByIdentifier, readWorkItem } from '@/lib/workspaces/tenantRead';
import { resolveMarkdownWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

/** The two request-grammar kinds a triage submission is born as (ADR §1): a
 *  `bug` (bug report) or a `task` (feature request). Never epic/story/subtask. */
export type TriageSubmissionKind = 'bug' | 'task';

/** What the in-app widget (and, via Story 6.12, the public form) sends to
 *  create a triage item. */
export interface CreateTriageSubmissionInput {
  /** The project to submit into — its identifier ("PROD"), resolved within the
   *  actor's workspace (a cross-tenant / non-browsable key reads as 404). */
  projectKey: string;
  kind: TriageSubmissionKind;
  title: string;
  descriptionMd?: string | null;
  /**
   * The human who submitted (recorded as `work_item.submittedByUserId`).
   * Defaults to the actor (`ctx.userId`) — the in-app member case, where the
   * submitter IS the reporter. Story 6.12 passes a signed-in NON-member's id
   * here while `ctx` carries the project's intake reporter, so a non-member
   * submission is attributed without making a non-member the tenant reporter
   * (which `createWorkItem`'s member gate forbids). 6.11 owns this create path;
   * 6.12 owns its public route + the `canSubmitToTriage` grant.
   */
  submittedByUserId?: string;
  /**
   * The PLANNED fields a debug turn's diagnosis carries (Story MOTIR-7042 ·
   * MOTIR-7049; ADR `conversation-turn-intent.md` AMENDMENT 1 · A1.4), so a bug
   * filed from the orb's debug turn is BORN with its diagnosis in this one create
   * — one transaction, no half-written card. Absent on every other submission
   * (the widget, the public form), which stay exactly as they were. The
   * diagnosis's description rides in `descriptionMd`.
   */
  diagnosis?: TriageSubmissionDiagnosis;
}

/** The planned fields of {@link CreateTriageSubmissionInput.diagnosis} — the
 *  validated `AuthoredBug` sizing and explanation (`lib/ai/authoredBug.ts`). */
export interface TriageSubmissionDiagnosis {
  explanationMd: string;
  type: WorkItemTypeDto;
  executor: ExecutorDto;
  storyPoints: number;
  estimateMinutes: number;
  /** `null` when the answer carried no difficulty — then none is written. */
  difficulty: WorkItemDifficultyDto | null;
}

const TRIAGE_SUBMISSION_KINDS: ReadonlySet<string> = new Set<TriageSubmissionKind>(['bug', 'task']);

// The terminal status a declined / merged submission moves to (ADR §5). It is
// the default workflow's `cancelled` key (category `done`); the `todo →
// cancelled` transition already ships in `lib/workflows/defaultWorkflow.ts`.
const CANCELLED_STATUS_KEY = 'cancelled';

/**
 * The graduation TARGET an accept / promote resolves to (ADR §4). `parentId`
 * and `sprintId` are each applied only when PRESENT (`undefined` = leave as-is):
 *   - epic/story promote → `parentId` set (+ tree `position` from before/after);
 *   - sprint promote      → `sprintId` set;
 *   - backlog (accept)    → `parentId: null, sprintId: null`.
 * A fresh `backlogRank` is always minted at the BOTTOM of the destination scope
 * (the target sprint, or the backlog) so a graduated item lands last in line —
 * the UI re-ranks afterwards via the shipped rank endpoint if needed.
 */
interface GraduateTarget {
  parentId?: string | null;
  sprintId?: string | null;
  beforeId?: string;
  afterId?: string;
}

// Triage inbox — business logic (Story 6.11). Subtask 6.11.3 ships the READ
// side: the queue read, gated + paged + mapped to DTOs. The triage ACTIONS
// (accept / promote / decline / mark-duplicate-merge / snooze, 6.11.5) and the
// intake create paths (6.11.4) land their own methods here on top of the same
// `triagedAt` model. All reads/writes go through the shipped
// repositories/services (4-layer) — no raw Prisma in this layer.

export const triageService = {
  /**
   * One page of a project's ACTIVE triage queue (Subtask 6.11.3) — the inbox
   * an admin works through. Resolves + workspace-gates the project (a missing
   * or cross-workspace `projectId` → `ProjectNotFoundError`, no existence leak)
   * and asserts the actor can browse it (6.4), then reads ONLY triage items via
   * `findTriageQueue` (the single read that inverts the global triage exclusion).
   *
   * Cursor-paginated (finding #57 — the public form can flood the inbox, never
   * load-all): fetches `limit + 1` rows so `hasMore` needs no separate COUNT;
   * `nextCursor` is the opaque `(triagedAt, id)` seek-after token, or null on the
   * last page. The limit is clamped to `[1, TRIAGE_QUEUE_MAX_LIMIT]`; an invalid
   * cursor token throws `InvalidTriageCursorError` (→ 400 at the route).
   */
  async getTriageQueue(
    projectId: string,
    params: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<TriageQueuePageDto> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    // `work_item:triage`, not `project:browse` (MOTIR-2354): the queue is a
    // MODERATION surface, and its contents are requests from outside the team
    // that nobody has accepted yet. Reading it is part of triaging.
    await projectAccessService.assertPermission(projectId, ctx, 'work_item:triage');
    return readTriageQueuePage(project.id, project.workspaceId, params);
  },

  /**
   * The same ACTIVE triage queue page as {@link getTriageQueue}, but addressed
   * by the project's human IDENTIFIER ("PROD") rather than its id — the shape
   * the inbox's `GET /api/projects/[key]/triage/queue` "Load older" pagination
   * binds to (the page itself reads page 1 via `getTriageQueue` on the active
   * project). Resolves + gates the key exactly like `createSubmission` (a
   * missing / cross-workspace / non-browsable key reads as `ProjectNotFoundError`
   * → 404, no existence leak), then shares the paged-read body.
   */
  async getTriageQueueByKey(
    projectKey: string,
    params: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<TriageQueuePageDto> {
    const project = await readProjectByIdentifier(projectKey.trim().toUpperCase(), ctx);
    if (!project) throw new ProjectNotFoundError(projectKey);
    try {
      await projectAccessService.assertPermission(project.id, ctx, 'work_item:triage');
    } catch (err) {
      // A non-browser already arrives as ProjectNotFoundError; the legacy
      // browse-flavoured denial is re-shaped to the same 404 so the key stays
      // unable to confirm a project the actor may not see.
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new ProjectNotFoundError(projectKey);
      }
      throw err;
    }
    return readTriageQueuePage(project.id, project.workspaceId, params);
  },

  /**
   * The full triage item the inbox DETAIL pane renders (Subtask 6.11.6) — the
   * read behind a queue-row click. `workItemRepository.findById` returns triage
   * items (it is NOT triage-excluded). Gate: tenant (`workspaceId`) then browse
   * (6.4); assert the item is still IN triage (`triagedAt !== null`) else
   * `NotInTriageError` (a graduated/never-a-submission item is a 409, not a
   * missing one). The submitter is resolved into the SHIPPED
   * {@link TriageSubmitterDto} shape; the body + comments + attachments reuse
   * the issue-detail reads so the pane shares the existing display primitives.
   */
  async getTriageItemDetail(workItemId: string, ctx: ServiceContext): Promise<TriageItemDetailDto> {
    const item = await readWorkItem(workItemId, ctx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(workItemId);
    }
    await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:triage');
    if (item.triagedAt === null) throw new NotInTriageError(workItemId);

    const submitter = await resolveSubmitter(item);
    const [commentsPage, attachmentsPage, bodyRefs] = await Promise.all([
      commentsService.listComments(workItemId, { order: 'asc' }, ctx),
      attachmentsService.listForWorkItem(workItemId, {}, ctx),
      // The thread's links come resolved with its page; the body's are read here — no
      // query when it links nothing (bug MOTIR-10023).
      resolveMarkdownWorkItemRefs(item.descriptionMd ?? '', ctx),
    ]);
    // Flatten roots + their single-level replies (oldest-first) — the detail
    // pane renders a read-only thread, not the paged composer surface.
    const comments = commentsPage.threads.flatMap((thread) => [thread, ...thread.replies]);

    return {
      id: item.id,
      kind: item.kind as WorkItemKindDto,
      identifier: item.identifier,
      title: item.title,
      descriptionMd: item.descriptionMd,
      submitter,
      // Non-null by the `triagedAt !== null` gate above.
      triagedAt: item.triagedAt.toISOString(),
      comments,
      attachments: attachmentsPage.attachments,
      workItemRefs: { ...commentsPage.workItemRefs, ...bodyRefs },
    };
  },

  /**
   * Create a triage submission (Subtask 6.11.4) — the intake path the in-app
   * "report a bug / request a feature" widget posts to, and the SHARED
   * triage-create authority Story 6.12's public-project "Submit a request"
   * reuses. A submission IS a `work_item` (kind `bug` or `task`) born with the
   * `triage` marker and NO parent, so it is EXCLUDED from every normal read
   * (tree / board / list / ready / search, 6.11.3) until an admin promotes it
   * (6.11.5); the triage-queue read is the only read that returns it.
   *
   * Creation goes through the SAME `workItemsService.createWorkItem` authority
   * the rest of the app uses (4-layer — no raw Prisma here): it allocates the
   * key, records the `created` revision, auto-watches the reporter, and runs
   * the kind-parent matrix + the 6.4 access gates. `createWorkItem` REQUIRES a
   * member actor (the reporter), which is exactly why intake is signed-in only
   * — the unauthenticated public portal is dropped (Yue 2026-06-14).
   *
   * Attribution: the new item's `reporterId` is the actor (`ctx.userId`, a
   * member) and `submittedByUserId` is the real submitter — equal for the
   * in-app member case, distinct for the 6.12 non-member case (see
   * {@link CreateTriageSubmissionInput.submittedByUserId}).
   *
   * Gating mirrors `labelsService` (the no-leak [key] convention): a missing /
   * cross-tenant / non-browsable project key reads as `ProjectNotFoundError`
   * (404); a browser without edit rights surfaces `createWorkItem`'s
   * `ProjectAccessDeniedError` ('edit' → 403). A blank/over-long title or a
   * non-`bug`/`task` kind is a typed 422.
   */
  async createSubmission(
    input: CreateTriageSubmissionInput,
    ctx: ServiceContext,
  ): Promise<TriageSubmissionResultDto> {
    // Domain validation (the server backstop; the widget gates client-side too).
    if (!TRIAGE_SUBMISSION_KINDS.has(input.kind)) {
      throw new InvalidTriageSubmissionKindError();
    }
    const title = input.title.trim();
    if (title.length === 0) throw new InvalidTriageSubmissionTitleError('empty');
    if (title.length > MAX_TRIAGE_TITLE_LENGTH) {
      throw new InvalidTriageSubmissionTitleError('too_long');
    }

    // Resolve the project by key within the workspace, mapping a browse-denial
    // to 404 so a non-browser can't probe project existence (the labelsService
    // pattern). The edit gate is left to `createWorkItem` (→ 403 for a browser
    // without edit rights).
    const project = await readProjectByIdentifier(input.projectKey.trim().toUpperCase(), ctx);
    if (!project) throw new ProjectNotFoundError(input.projectKey);
    try {
      // ⚠️ SUBMITTING IS NOT TRIAGING (MOTIR-2354). The inventory mapped this row
      // to `work_item:triage`; that was wrong. Somebody filing an inbound request
      // is the act `public_request:submit` already governs, and Plane draws the
      // same line — a Guest or Commenter submits an intake item while only Admin
      // and Contributor accept or decline one. So the gate stays browse-shaped
      // (an internal member on a private project submits through here too, which
      // the level-gated `public_request:submit` could not admit) and only the
      // inventory row is corrected.
      await projectAccessService.assertCanBrowse(project.id, ctx);
    } catch (err) {
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new ProjectNotFoundError(input.projectKey);
      }
      throw err;
    }

    const description = input.descriptionMd?.trim() ? input.descriptionMd : null;

    const dto = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: input.kind,
        title,
        descriptionMd: description,
        // No parent — a triage submission lands parentless (legal for bug/task);
        // promotion (6.11.5) sets the parent/rank. The triage marker carries the
        // real submitter; the reporter is the member actor (`ctx.userId`).
        triage: { submittedByUserId: input.submittedByUserId ?? ctx.userId },
        // A debug turn's diagnosis (MOTIR-7049), in the SAME create — so the bug
        // is never visible half-planned. The explanation is the model's draft,
        // and says so (`ai_draft`), as the monitor enrichment's does.
        ...(input.diagnosis
          ? {
              explanationMd: input.diagnosis.explanationMd,
              explanationSource: 'ai_draft' as const,
              type: input.diagnosis.type,
              executor: input.diagnosis.executor,
              storyPoints: input.diagnosis.storyPoints,
              estimateMinutes: input.diagnosis.estimateMinutes,
              ...(input.diagnosis.difficulty !== null
                ? { difficulty: input.diagnosis.difficulty }
                : {}),
            }
          : {}),
      },
      ctx,
    );

    return { id: dto.id, kind: dto.kind, identifier: dto.identifier, title: dto.title };
  },

  // ─── Triage ACTIONS (Subtask 6.11.5, per docs/decisions/triage-model.md §4/§5) ───
  // The verbs an admin clears the queue with: accept / promote (graduate →
  // clear `triagedAt`), decline / mark-duplicate-merge (terminal → cancel,
  // KEEP `triagedAt` so the item never re-pollutes the tree), and snooze /
  // unsnooze (defer out of the active queue). Each is ONE service method = ONE
  // transaction; the gate read (`lockTriageItem`) takes `tx` + a FOR-UPDATE
  // lock so two concurrent actions can't race the same item
  // (lock-before-read-derived-update). Graduation / re-parent route through the
  // shipped write authority — never raw Prisma — honouring 6.4 permissions and
  // the kind-parent matrix.

  /**
   * **Accept → backlog** (ADR §4). Graduate the item into the project backlog
   * (no parent) at the bottom of the rank, with an optional admin comment. The
   * item is born at the workflow's initial status, so accept changes no status —
   * it clears the triage marker and re-ranks. Returns the graduated item.
   */
  async acceptTriageItem(
    workItemId: string,
    input: { comment?: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const row = await graduate(item, { parentId: null, sprintId: null }, ctx, tx);
      await addTriageNote(item, input.comment, ctx, tx);
      return toWorkItemDto(row);
    });
  },

  /**
   * **Promote → sprint / epic / story / backlog** (ADR §4). Graduate the item to
   * a chosen destination: an `parentId` (epic/story — the kind-parent matrix
   * bounds it, the same `assertValidParent` pre-flight the rest of the app uses)
   * and/or a `sprintId`, with an optional tree position via before/after
   * neighbours. Clears the triage marker so the same row — with its full
   * comment/attachment/history thread — appears in the tree.
   */
  async promoteTriageItem(
    workItemId: string,
    input: {
      parentId?: string | null;
      sprintId?: string | null;
      beforeId?: string;
      afterId?: string;
      comment?: string;
    },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const row = await graduate(
        item,
        {
          parentId: input.parentId,
          sprintId: input.sprintId,
          beforeId: input.beforeId,
          afterId: input.afterId,
        },
        ctx,
        tx,
      );
      await addTriageNote(item, input.comment, ctx, tx);
      return toWorkItemDto(row);
    });
  },

  /**
   * **Decline** (ADR §5). Move the submission to the terminal `cancelled`
   * status with an optional comment; the triage marker is KEPT, so the
   * parentless cancelled item stays out of EVERY normal read (a cleared marker
   * would surface it as a tree root) while leaving the active queue. The
   * `todo → cancelled` transition runs through the shipped
   * `workItemsService.applyStatusTransition` (same validation + revision), and
   * the `work-item/transitioned` event fires post-commit.
   */
  async declineTriageItem(
    workItemId: string,
    input: { comment?: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const { dto, transition } = await withWorkspaceContext(ctx, async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): `cancelled` is in the done
      // category, and the mark refuses only a move out of it.
      const result = await workItemsService.applyStatusTransition(
        workItemId,
        CANCELLED_STATUS_KEY,
        ctx,
        tx,
      );
      await addTriageNote(item, input.comment, ctx, tx);
      return result;
    });
    await emitTransition(dto, transition, ctx);
    return dto;
  },

  /**
   * **Mark duplicate / merge** (ADR §5). Fold the submission into a canonical
   * item: re-point the duplicate's comments + attachments onto the canonical
   * item (mirroring Linear moving attachments to the canonical issue), record a
   * `duplicates` link, then cancel the duplicate (triage marker KEPT). The
   * optional comment lands on the duplicate. Returns the (now cancelled)
   * duplicate.
   */
  async markDuplicateTriageItem(
    workItemId: string,
    input: { canonicalId: string; comment?: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    if (workItemId === input.canonicalId) throw new TriageSelfMergeError(workItemId);
    const { dto, transition } = await withWorkspaceContext(ctx, async (tx) => {
      const item = await lockTriageItem(workItemId, ctx, tx);
      const canonical = await workItemRepository.findById(input.canonicalId, tx);
      if (!canonical || canonical.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(input.canonicalId);
      }

      // Fold the thread onto the canonical item BEFORE cancelling the duplicate.
      await commentRepository.reassignWorkItem(workItemId, input.canonicalId, tx);
      await attachmentRepository.reassignWorkItem(workItemId, input.canonicalId, tx);

      // Record the duplicate→canonical link (the 6.9 `duplicates` grammar) on
      // the duplicate, then a revision for the trail.
      await workItemLinkRepository.create(
        {
          workspaceId: item.workspaceId,
          fromId: workItemId,
          toId: input.canonicalId,
          kind: 'duplicates',
          createdById: ctx.userId,
        },
        tx,
      );
      await workItemRevisionsService.recordRevision(
        {
          workItemId,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { links: { added: [{ toId: input.canonicalId, kind: 'duplicates' }] } },
        },
        tx,
      );

      // Never meets MARKED_CARD_CANNOT_REOPEN (MOTIR-6681): `cancelled` is in the done
      // category, and the mark refuses only a move out of it.
      const result = await workItemsService.applyStatusTransition(
        workItemId,
        CANCELLED_STATUS_KEY,
        ctx,
        tx,
      );
      await addTriageNote(item, input.comment, ctx, tx);
      return result;
    });
    await emitTransition(dto, transition, ctx);
    return dto;
  },

  /**
   * **Snooze** (ADR §5). Hide the item from the ACTIVE queue until
   * `snoozedUntil` — or until new activity returns it sooner (a comment clears
   * the marker; see `commentsService.addComment`). The marker stays set, so the
   * item never leaks into a normal read while snoozed. `snoozedUntil` must be a
   * valid future instant.
   */
  async snoozeTriageItem(
    workItemId: string,
    input: { snoozedUntil: string },
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const until = new Date(input.snoozedUntil);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new InvalidSnoozeUntilError();
    }
    return withWorkspaceContext(ctx, async (tx) => {
      await lockTriageItem(workItemId, ctx, tx);
      const row = await workItemRepository.update(workItemId, { snoozedUntil: until }, tx);
      return toWorkItemDto(row);
    });
  },

  /**
   * **Unsnooze** (ADR §5). Clear `snoozedUntil` immediately, returning the item
   * to the active queue.
   */
  async unsnoozeTriageItem(workItemId: string, ctx: ServiceContext): Promise<WorkItemDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      await lockTriageItem(workItemId, ctx, tx);
      const row = await workItemRepository.update(workItemId, { snoozedUntil: null }, tx);
      return toWorkItemDto(row);
    });
  },
};

/**
 * Lock + tenant-gate + TRIAGE-gate + assert-in-triage, inside the caller's `tx`.
 * The `SELECT FOR UPDATE` (via `lockById`) serialises concurrent triage actions
 * on the same item (lock-before-read-derived-update). A cross-workspace or
 * unknown id, and a non-browsable project, all read as 404 (no existence leak —
 * the gate rejects a non-browser as `ProjectNotFoundError` first); an item
 * that has already graduated (`triagedAt IS NULL`) is a 409 `NotInTriageError`.
 *
 * ⚠️ THE KEY IS `work_item:triage`, NOT `work_item:edit` (Subtask MOTIR-2354).
 * Accepting, declining, promoting, de-duplicating and snoozing an inbound request
 * are MODERATION acts on work somebody outside the team submitted — the same
 * shape as `comment:moderate`, which the model story already made narrower than
 * writing a comment. A member keeps both; a `viewer` loses the queue's actions
 * and keeps reading it, which is where Plane draws the line too.
 */
async function lockTriageItem(
  workItemId: string,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) throw new WorkItemNotFoundError(workItemId);
  const item = await workItemRepository.findById(workItemId, tx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);
  await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:triage', tx);
  if (item.triagedAt === null) throw new NotInTriageError(workItemId);
  return item;
}

/**
 * Graduate a triage item into the planned tree (ADR §4): clear `triagedAt`, set
 * the chosen parent/sprint, and mint a fresh `backlogRank` at the bottom of the
 * destination scope — all in the caller's `tx`, recording one revision. The
 * kind-parent matrix is enforced via the shipped `assertValidParent` pre-flight
 * (the DB trigger is the backstop). Returns the updated row.
 */
async function graduate(
  item: WorkItem,
  target: GraduateTarget,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<WorkItem> {
  const update: WorkItemUpdateInput = { triagedAt: null };
  const diff: Record<string, { from: unknown; to: unknown }> = {};

  // ── Parent (epic/story, or null for the backlog) ──────────────────────────
  let targetSprintId = item.sprintId;
  if (target.parentId !== undefined) {
    const targetParentId = target.parentId;
    if (targetParentId === null) {
      assertValidParent(null, item.kind);
    } else {
      const parent = await workItemRepository.findById(targetParentId, tx);
      if (!parent) throw new WorkItemNotFoundError(targetParentId);
      if (parent.projectId !== item.projectId) throw new CrossProjectParentError();
      assertValidParent(parent.kind, item.kind);
    }
    update.parentId = targetParentId;
    if (targetParentId !== item.parentId) {
      diff.parentId = { from: item.parentId, to: targetParentId };
      const newPosition = await resolveTreePosition(
        item.projectId,
        targetParentId,
        target.beforeId,
        target.afterId,
        tx,
      );
      update.position = newPosition;
      if (newPosition !== item.position) diff.position = { from: item.position, to: newPosition };
    }
  }

  // ── Sprint association ────────────────────────────────────────────────────
  if (target.sprintId !== undefined) {
    if (target.sprintId !== null) {
      const sprint = await sprintRepository.findById(target.sprintId, ctx.workspaceId, tx);
      if (!sprint) throw new SprintNotFoundError(target.sprintId);
      if (sprint.projectId !== item.projectId) {
        throw new CrossProjectSprintAssignmentError(item.id, target.sprintId);
      }
    }
    targetSprintId = target.sprintId;
    update.sprintId = target.sprintId;
    if (target.sprintId !== item.sprintId) {
      diff.sprintId = { from: item.sprintId, to: target.sprintId };
    }
  }

  // ── Fresh backlog rank at the BOTTOM of the destination scope ─────────────
  const lastRank = await workItemRepository.findBoundaryBacklogRank(
    item.projectId,
    ctx.workspaceId,
    targetSprintId,
    'max',
    tx,
  );
  const backlogRank = keyForAppend(lastRank);
  update.backlogRank = backlogRank;
  diff.backlogRank = { from: item.backlogRank, to: backlogRank };

  const row = await workItemRepository.update(item.id, update, tx);
  await workItemRevisionsService.recordRevision(
    { workItemId: item.id, changedById: ctx.userId, changeKind: 'updated', diff },
    tx,
  );
  return row;
}

/**
 * The tree `position` (fractional index under the new parent) a promotion lands
 * at — between named neighbours, else appended after the parent's last child.
 * Mirrors `workItemsService.moveWorkItem` / `createWorkItem` positioning.
 */
async function resolveTreePosition(
  projectId: string,
  parentId: string | null,
  beforeId: string | undefined,
  afterId: string | undefined,
  tx: Prisma.TransactionClient,
): Promise<string> {
  if (beforeId == null && afterId == null) {
    const siblings = await workItemRepository.findSiblings(projectId, parentId, tx);
    const last = siblings.length ? siblings[siblings.length - 1]!.position : null;
    return keyForAppend(last);
  }
  const beforePos = beforeId
    ? ((await workItemRepository.findById(beforeId, tx))?.position ?? null)
    : null;
  const afterPos = afterId
    ? ((await workItemRepository.findById(afterId, tx))?.position ?? null)
    : null;
  return keyBetween(beforePos, afterPos);
}

/**
 * Persist an optional admin note (accept / promote / decline / merge) as a plain
 * root comment on the item, in the caller's `tx`. A triage-action note is a
 * record, not a discussion post, so it goes straight through the comment
 * repository — no mention fan-out / watcher events (the inbox's normal comment
 * composer, `commentsService.addComment`, owns those). A blank/whitespace
 * comment is a no-op.
 */
async function addTriageNote(
  item: WorkItem,
  comment: string | undefined,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const body = comment?.trim();
  if (!body) return;
  await commentRepository.create(
    {
      workspaceId: item.workspaceId,
      workItemId: item.id,
      authorId: ctx.userId,
      parentCommentId: null,
      bodyMd: body,
    },
    tx,
  );
}

/**
 * Post-commit `work-item/transitioned` emit for decline / merge (the status
 * change rolls back with the tx, so the event can never fire inside it). A
 * no-op transition (`null`) emits nothing.
 */
async function emitTransition(
  dto: WorkItemDto,
  transition: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null,
  ctx: ServiceContext,
): Promise<void> {
  if (!transition) return;
  await sendEvent('work-item/transitioned', {
    workspaceId: ctx.workspaceId,
    workItemId: dto.id,
    actorId: ctx.userId,
    fromStatusKey: transition.fromStatusKey,
    toStatusKey: transition.toStatusKey,
    revisionId: transition.revisionId,
  });
}

/**
 * The shared paged-read body for `getTriageQueue` / `getTriageQueueByKey` (the
 * project + browse gate is the caller's, so this assumes an already-authorised
 * project). Fetches `limit + 1` rows so `hasMore` needs no separate COUNT
 * (finding #57 — cursor-forward, never load-all); `nextCursor` is the opaque
 * `(triagedAt, id)` seek-after token, or null on the last page.
 */
async function readTriageQueuePage(
  projectId: string,
  workspaceId: string,
  params: { cursor?: string; limit?: number },
): Promise<TriageQueuePageDto> {
  const limit = clampTriageLimit(params.limit);
  const cursor = params.cursor ? decodeTriageCursor(params.cursor) : undefined;

  const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
    workItemRepository.findTriageQueue(
      projectId,
      workspaceId,
      {
        limit: limit + 1,
        cursor: cursor
          ? { voteCount: cursor.voteCount, triagedAt: new Date(cursor.triagedAt), id: cursor.id }
          : undefined,
      },
      tx,
    ),
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(toTriageQueueItemDto);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTriageCursor({
          voteCount: last.voteCount,
          triagedAt: last.triagedAt!.toISOString(),
          id: last.id,
        })
      : null;

  return { items, nextCursor };
}

/**
 * Resolve a triage item's submitter into the SHIPPED {@link TriageSubmitterDto}
 * shape (mirrors `triageMappers.toSubmitterDto`, which works over the joined
 * queue row; the detail read has only the bare `WorkItem`, so it looks the
 * submitter + workspace-membership up via the repositories). Intake is signed-in
 * only (the 2026-06-14 revision — Subtask 6.11.10): the submitter is the real
 * `submittedByUserId` account, classified `member` when it belongs to the item's
 * workspace and `public` for a signed-in non-member (Story 6.12). A
 * legacy/never-attributed item (null `submittedByUserId`) maps to a `public`
 * shape with a null `userId`.
 */
async function resolveSubmitter(item: WorkItem): Promise<TriageSubmitterDto> {
  const submitterId = item.submittedByUserId;
  if (submitterId === null) {
    return { kind: 'public', userId: null, name: null, email: null, image: null };
  }
  // MOTIR-2527: the membership read is what SEPARATES `member` from `public` here, so
  // an unbound read does not merely deny — it silently re-labels every member submitter
  // as an outside public one. `readMembership` binds the item's own workspace, which is
  // the context this detail read is already operating in.
  const [submitter, membership] = await Promise.all([
    userRepository.findById(submitterId),
    readMembership(submitterId, item.workspaceId),
  ]);
  return {
    kind: membership !== null ? 'member' : 'public',
    userId: submitterId,
    name: submitter?.name ?? null,
    email: submitter?.email ?? null,
    image: storedAssetUrl(submitter?.image),
  };
}
