import { Prisma, type WorkItem } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { resumeStateService } from '@/lib/services/resumeStateService';
import { requestGateResumeAfterDecision } from '@/lib/services/gateResumeRequest';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { handlerFor } from '@/lib/approvalGates/registry';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { gateSetFor } from '@/lib/services/gateSetFor';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { randomUUID } from 'node:crypto';
import { headPrivateBlob, mintPrivateUploadToken, putPrivateAttachment } from '@/lib/blob/uploader';
import { MAX_UPLOAD_BYTES, isAllowedDesignAssetType } from '@/lib/blob/allowlist';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';
import {
  DesignCardClosedError,
  DesignEvidenceBlobMissingError,
  DesignEvidenceCommitShaError,
  DesignEvidenceEmptyError,
  DesignEvidenceImageRetiredError,
  DesignEvidenceMockRequiredError,
  DesignEvidenceNoteFileRequiredError,
  DesignEvidenceNoteMdRetiredError,
  DesignEvidenceNothingWaitsError,
  DesignEvidenceNotAChildError,
  DesignEvidenceNotALeafError,
  DesignEvidenceNoCurrentResultError,
  DesignEvidenceNotFoundError,
  DesignEvidencePathnameError,
  DesignEvidenceSupersedeConflictError,
} from '@/lib/designEvidence/errors';
import { toDesignEvidenceDto } from '@/lib/mappers/designEvidenceMappers';
import { normalizeCommitSha } from '@/lib/git/commitSha';
import type {
  DesignAssetKindDTO,
  DesignEvidenceDTO,
  DesignGateSubjectDTO,
  DesignUploadTargetDTO,
  DesignUploadTokensDTO,
} from '@/lib/dto/designEvidence';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { AppliedGateTransition } from '@/lib/approvalGates/registry';
import { emitAppliedGateTransitions } from '@/lib/approvalGates/gateTransition';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

/**
 * Design results — business logic (Story MOTIR-2664 · Subtask MOTIR-2666).
 * Owns the register-from-pathnames flow (supersede the prior current + store the
 * new artifacts) and the panel read. Reuses the shipped blob pipeline and the
 * entitlements caps for the bytes.
 *
 * **No eligibility gate.** Unlike acceptance video, a design result is NOT
 * plan-gated or org-toggled — it is tens of kilobytes and reading the design of
 * the work you are reviewing is core project management, not a paid AI feature
 * (docs/decisions/design-result.md §2). Only the mechanical cost bounds apply,
 * and they are enforced here.
 */

/** Every `design_asset_kind` the store knows. `image` stays readable for rows
 *  published before AMENDMENT 4 and is refused for a new publish by
 *  {@link assertResultShape} — a named refusal, not an unknown kind. */
const ASSET_KINDS: readonly DesignAssetKindDTO[] = ['mock', 'image', 'note_file'];

export interface DesignAssetInput {
  kind: DesignAssetKindDTO;
  /** The repo path the file came from. */
  sourcePath: string;
  /** The private-store key the client uploaded it to. */
  pathname: string;
}

export interface RecordDesignResultInput {
  /** The work item whose design this is — the card that produced it. */
  workItemId: string;
  assets: DesignAssetInput[];
  /** The extracted `design-notes.md` section text, if the PR changed any. */
  noteMd?: string | null;
  commitSha?: string | null;
  ciRunUrl?: string | null;
  producedByKey?: string | null;
  /**
   * The container whose PARENT-RUN branch this publish belongs to (MOTIR-3177).
   * Present only on that path; it asserts the target is one of that container's
   * children, and is never persisted.
   */
  withinParentKey?: string | null;
}

/**
 * One asset published with its BYTES IN HAND, for the caller that is already
 * inside the server (MOTIR-3782). {@link DesignAssetInput} names a blob the
 * CLIENT has already PUT; this names one nobody has uploaded yet.
 */
export interface DesignAssetBytesInput {
  kind: DesignAssetKindDTO;
  /** The repo path the file came from. */
  sourcePath: string;
  /** The media type the caller declares. Checked here, and again at register
   *  against what the store actually holds. */
  contentType: string;
  /** The decoded file bytes. */
  bytes: Buffer;
}

export interface RecordDesignResultFromBytesInput extends Omit<RecordDesignResultInput, 'assets'> {
  assets: DesignAssetBytesInput[];
}

/** The private-store key prefix that scopes one item's design artifacts. */
export function designPrefix(workspaceId: string, workItemId: string): string {
  return `design/${workspaceId}/${workItemId}/`;
}

/** The last path segment (the stored filename) of a blob pathname. */
function blobFilename(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/** The basename of a repo path, used to keep a stored key recognisable. */
function basenameOf(sourcePath: string): string {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1) || 'asset';
}

/**
 * Kinds that may own a design result. A result belongs to the CARD THAT
 * PRODUCED IT, so a container is refused: a story has many designs, one per
 * design subtask (§3). Deliberately the mirror image of the acceptance path,
 * which rolls a subtask key UP to its story.
 */
const LEAF_KINDS = new Set(['task', 'bug', 'subtask']);

/**
 * ⚠️ LEAF is a position in the tree, not a kind (MOTIR-3146).
 *
 * `LEAF_KINDS` answers *"is this a kind that CAN be a leaf?"*, and only `subtask`
 * makes those two questions the same: `lib/issues/parentRules.ts` has
 * `bug → [subtask]` and `task → [bug, subtask]`, so a `bug` or a `task` may hold
 * children and be a CONTAINER. Reading the kind alone let one through — a
 * `parent/MOTIR-<bug>-…` pull request from the parent-run form, whose branch
 * carries the container's key by design — and the publish proceeded into a 500
 * instead of the clean no-op MOTIR-3124 built for exactly this case.
 *
 * So the check is structural: a target is publishable when it has NO CHILDREN.
 * The kind test stays as the cheap first pass (an `epic` / `story` needs no
 * query); the child read settles the rest.
 */
async function isLeafPosition(item: WorkItem, ctx: ServiceContext): Promise<boolean> {
  if (!LEAF_KINDS.has(item.kind)) return false;
  if (item.kind === 'subtask') return true; // the only kind nothing may parent to
  const children = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findChildren(item.id, tx),
  );
  return children.length === 0;
}

/**
 * A PARENT-RUN publisher declares the container whose branch it is publishing
 * for, and the target must be one of that container's own children (MOTIR-3177).
 *
 * The publisher reads the producing card's key out of a COMMIT SUBJECT, which is
 * prose: a mistyped key resolves to a real, unrelated leaf that would otherwise
 * accept the publish. Only the tenant can see the tree, so only the tenant can
 * refuse. Absent (the ordinary one-card publish, where the branch names the card
 * directly) this check does not run at all.
 *
 * A container key that resolves to nothing is refused for the same reason a
 * non-child is: it is a claim about the tree that the tree does not support.
 */
async function assertChildOf(
  item: WorkItem,
  containerIdentifier: string,
  ctx: ServiceContext,
): Promise<void> {
  const container = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    // Same project by construction: both keys carry the project's prefix, and a
    // cross-project identifier simply does not resolve here.
    (tx) => workItemRepository.findByIdentifier(item.projectId, containerIdentifier, tx),
  );
  if (!container || item.parentId !== container.id) {
    throw new DesignEvidenceNotAChildError(item.identifier, containerIdentifier);
  }
}

/** Resolve + validate the design target is a visible LEAF (RLS-scoped). */
async function resolveTarget(
  workItemId: string,
  ctx: ServiceContext,
  withinParentKey?: string | null,
): Promise<WorkItem> {
  const item = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findById(workItemId, tx),
  );
  if (!item) throw new DesignEvidenceNotFoundError(workItemId);
  if (!(await isLeafPosition(item, ctx))) {
    throw new DesignEvidenceNotALeafError(item.kind, !LEAF_KINDS.has(item.kind));
  }
  if (withinParentKey) await assertChildOf(item, withinParentKey.trim().toUpperCase(), ctx);
  // Attaching a design result to an item is editing that item; the project is
  // resolved from the ITEM, never from the actor's active project (the gate
  // MOTIR-2365 added to the acceptance resolver after a token-minting endpoint
  // turned out to be reachable with a session and an id).
  await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');
  return item;
}

/**
 * Resolve + authorize a WITHDRAWAL target (MOTIR-3215).
 *
 * ⚠️ Deliberately WITHOUT {@link isLeafPosition}, which {@link resolveTarget}
 * applies. The leaf rule belongs to PUBLISH — it decides which card a design
 * result may be attached to (§3). Applying it here would mean a card that has
 * since GAINED a child can no longer have its wrong result taken back, which
 * re-creates the permanence this whole path exists to remove: a `task` or `bug`
 * is leaf-CAPABLE, not leaf-BY-KIND (MOTIR-3146), so an ordinary re-plan is
 * enough to strand a row forever. A row that exists is withdrawable.
 *
 * The item-scoped `work_item:edit` gate is unchanged and is the real authority
 * check: withdrawing a design result is editing that item, and the project is
 * resolved from the ITEM rather than the actor's active project (the same gate
 * MOTIR-2365 put on the acceptance resolver).
 */
async function resolveWithdrawTarget(workItemId: string, ctx: ServiceContext): Promise<WorkItem> {
  const item = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findById(workItemId, tx),
  );
  if (!item) throw new DesignEvidenceNotFoundError(workItemId);
  await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');
  return item;
}

/** The org's per-file byte cap + org id (10 MB baseline off-cloud/unresolved). */
async function resolveCostContext(
  workspaceId: string,
): Promise<{ organizationId: string | null; perFileLimit: number }> {
  const organizationId =
    (
      await withWorkspaceServiceContext(workspaceId, (tx) =>
        workspaceRepository.findById(workspaceId, tx),
      )
    )?.organizationId ?? null;
  const perFileLimit = organizationId
    ? await entitlementsService.resolvePerFileLimitBytes(organizationId)
    : MAX_UPLOAD_BYTES;
  return { organizationId, perFileLimit };
}

/**
 * The SHAPE a design result must have (MOTIR-5491; `docs/decisions/design-result.md`
 * AMENDMENT 4 Q1): one or more `mock` assets plus exactly ONE `note_file`, and
 * neither of the two retired inputs. Checked in this order so a caller still
 * sending the old three-file shape is told WHICH input is retired, rather than
 * something vaguer about a count.
 *
 * A retired input is REFUSED, never dropped: an agent cannot tell an ignored
 * field from an accepted one, and a quietly-dropped `.png` would come back as a
 * report that a screenshot was published.
 */
function assertResultShape(
  assets: ReadonlyArray<{ kind: DesignAssetKindDTO; sourcePath: string }>,
  noteMd: string | null | undefined,
): void {
  const image = assets.find((asset) => asset.kind === 'image');
  if (image) throw new DesignEvidenceImageRetiredError(image.sourcePath);
  if (noteMd != null) throw new DesignEvidenceNoteMdRetiredError();
  if (!assets.some((asset) => asset.kind === 'mock')) throw new DesignEvidenceMockRequiredError();
  const noteFiles = assets.filter((asset) => asset.kind === 'note_file').length;
  if (noteFiles !== 1) throw new DesignEvidenceNoteFileRequiredError(noteFiles);
}

/**
 * The ids of every OPEN work item waiting on this one — not archived, carrying an
 * `is_blocked_by` edge to it, and with a status outside its own project's `done`
 * category. The done test is `isTerminalStatus`, the predicate readiness applies to
 * the same edge from the other end, so "this dependent still waits" and "this
 * blocker is still open" can never disagree about one status.
 *
 * Takes the caller's `tx` because at publish the answer GATES the write in that
 * transaction: a dependent closed between the check and the insert must be seen.
 */
async function openDependentIds(
  workItemId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const dependents = await workItemLinkRepository.findDependentStates(workItemId, tx);
  if (dependents.length === 0) return [];
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    dependents.map((dependent) => dependent.projectId),
    workspaceId,
    tx,
  );
  return dependents
    .filter((dependent) => !isTerminalStatus(dependent, terminalByProject))
    .map((dependent) => dependent.id);
}

/**
 * Refuse a design result for a card nothing waits on (AMENDMENT 4 Q2). A publish
 * raises an approval gate, and a gate is only worth a person's time when work is
 * held up by its answer; a design nobody depends on is reviewed on its pull request.
 */
async function assertSomethingWaits(
  item: WorkItem,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const open = tx
    ? await openDependentIds(item.id, ctx.workspaceId, tx)
    : await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (t) =>
        openDependentIds(item.id, ctx.workspaceId, t),
      );
  if (open.length === 0) throw new DesignEvidenceNothingWaitsError(item.identifier);
}

/**
 * Refuse any change to the design result of a CLOSED card — one whose status is
 * in its project's `done` category, `cancelled` included (MOTIR-5556; ADR §6c
 * SECOND AMENDMENT). The category is resolved through the project's workflow by
 * the same predicate readiness applies to a `blocked_by` edge, never by
 * comparing a key to `'done'`, so a renamed done status is closed too.
 *
 * ⚠️ It reads the CARD's status, never a gate — and that is now a DIVISION OF
 * LABOUR rather than the whole rule. It used to be the whole rule because a
 * design card with an open pull request raised no gate to read (AMENDMENT 4 Q8);
 * such a card raises one again (MOTIR-5662), and the gate-keyed half is
 * {@link assertDesignSettled}, which runs beside this one.
 *
 * Without a `tx` it tests the status the caller already read — the courtesy
 * pre-check that stops a doomed publish uploading anything. With one it LOCKS
 * the work item and re-reads it, which is the authoritative check; see the
 * lock-order note in {@link persistEvidence}.
 */
async function assertCardOpen(
  item: WorkItem,
  ctx: ServiceContext,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  // ⚠️ The status vocabulary is a policy-gated read, so it is ALWAYS given a bound
  // transaction — the caller's, or one opened here. Unbound under the runtime role
  // it returns no statuses and raises nothing, so every card would read as open
  // and the refusal would never fire (`tests/rls/call-site-guard.test.ts`).
  if (!tx) {
    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (bound) => {
        await assertStatusOpen(item, ctx, bound);
        await assertDesignSettled(item, ctx, bound);
      },
    );
  }
  await workItemRepository.lockById(item.id, tx);
  const current = (await workItemRepository.findById(item.id, tx)) ?? item;
  await assertStatusOpen(current, ctx, tx);
  return assertDesignSettled(current, ctx, tx);
}

async function assertStatusOpen(
  item: WorkItem,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    [item.projectId],
    ctx.workspaceId,
    tx,
  );
  if (isTerminalStatus(item, terminalByProject)) {
    throw new DesignCardClosedError(item.identifier, item.status);
  }
}

/**
 * Refuse any change to a design the card's reviewer has ALREADY APPROVED, while
 * the card is still standing on that approval (Story MOTIR-5652 · Subtask
 * MOTIR-5661; `docs/decisions/design-result.md` AMENDMENT 6 Q3).
 *
 * {@link assertStatusOpen} closes a `done` card, and in the two-gate model an
 * approved design card is NOT yet `done` — the merge writes `done`. AMENDMENT 5
 * Q2 named the window that leaves, in its own words: *"a card at `approved` with
 * an open pull request is not yet `done`, so a publish in that window supersedes
 * the approved version and the merge would leave `done` with a version nobody
 * approved."* This is the second, earlier condition that closes it. The
 * status-keyed refusal above is untouched; nothing is removed.
 *
 * **Three things decide it, and each one is load-bearing:**
 *
 * · **`approved`, NOT merely `decided`.** `changes_requested` is a decision too,
 *   and it is the one that ASKS FOR A NEW VERSION — refusing a republish on it
 *   would break the review loop the verb exists for. (AMENDMENT 6 Q3 said
 *   "decided"; the correction is recorded on that Q.)
 * · **Over the CARD'S CURRENT RESULT.** An approval of v1 says nothing about a
 *   card whose current result is already v2, and an AWAITING gate closes nothing
 *   at all — a question nobody has answered is exactly what a republish is for.
 * · **WITH AN OPEN DELIVERY.** A merge is what would ship the unapproved version,
 *   so an open pull request is what makes the window a window. Without one there
 *   is nothing to ship and the approve → reopen → republish → approve cycle §6d
 *   blesses is untouched (`tests/approval-gate-decided-read.test.ts` drives it).
 * · **AT OR ABOVE `implemented`.** This is the door back, and the RUNG is the
 *   decision. `implemented` is the rung that claims *the branch is pushed and the
 *   pull request is open* — from there up the card is OFFERING commits, and the
 *   design that ships with them is settled. Below it the work is being reworked,
 *   which is exactly when a design may legitimately change. A person pulling the
 *   card back to `in_progress` is therefore the deliberate re-open AMENDMENT 6 Q3
 *   asks for, and the SAME move withdraws every awaiting question with the cause
 *   `pulled_back`, so no merge gate survives it to carry an unapproved design to
 *   `done`. Nothing mutates the approved gate itself: a decided row is frozen by
 *   `trg_approval_gate_decided_immutable` (MOTIR-4912), and it is the record of
 *   what somebody agreed to.
 *
 *   ⚠️ **IT WAS `in_review` AND THAT WAS WRONG — corrected by MOTIR-5666, which
 *   found the falsifier rather than reasoning about it.** A merge-queue ejection
 *   moves every card it delivers to `implemented` (§4's THIRD AMENDMENT), which
 *   sat one rung BELOW the old band — so the ordinary shape this refusal was
 *   written for, *the queue ejects the pull request and an agent comes back and
 *   re-publishes the asset*, was the one shape it let through.
 */
/**
 * PUBLISHING HANDS THE CARD TO A PERSON, SO THE PUBLISH MOVES IT TO REVIEW —
 * and ONLY when nothing else owns its status (Bug MOTIR-6009).
 *
 * The defect this closes: both `motir run` paths wrote `implemented` after a
 * publish, which claims *the branch is pushed and CI decides when this becomes
 * reviewable*. A design card opens no pull request (`design-result.md`
 * AMENDMENT 5 Q1), so no verdict ever arrives — the promotion keys on a linked
 * delivery — and the card sat in the Implemented column while its own
 * `awaiting` gate waited on a reviewer. Two callers each decided the status for
 * themselves and both decided it wrong, which is why the write belongs HERE,
 * in the transaction that raises the question: every door is then correct
 * without having to know the rule.
 *
 * ⚠️ THE DISCRIMINATOR IS THE OPEN DELIVERY, AND IT IS DELIBERATELY THE SAME
 * QUESTION `designResultHandler.approve` ASKS AT DECISION TIME
 * (`countOpenByWorkItem`): with an open pull request the PR lifecycle owns the
 * card — `implemented` on push, `in_review` on green, `done` on merge — and a
 * write here would be a SECOND writer racing it, which is the collision ADR §8
 * exists to end. Without one there is nothing else that can move the card,
 * which is precisely why the publish must.
 *
 * ⚠️ IT ONLY EVER MOVES FORWARD. `hopsToReview` returns nothing for a card
 * already at `in_review`, and the rank test refuses anything above it, so a
 * republish on an `approved` card — the revise loop — is not dragged back a
 * rung on its way. A card BELOW review walks there by DECLARED edges only, so
 * a project whose workflow cannot reach `in_review` from where the card stands
 * keeps its status rather than having one forced on it.
 *
 * ⚠️ THE WALK IS `choiceGateService`'s, called rather than re-derived — its own
 * contract says *"one walk, not two"*, and this is its third caller. The import
 * is LAZY for the reason that module's header gives: the walk is applied
 * through `workItemsService`, which imports THIS module, so naming it at the
 * top would close the cycle.
 *
 * Silent by design when there is nothing to do: no hops, an open delivery, or a
 * card at or above review each return without writing.
 */
async function moveToReviewWhenUndelivered(
  item: WorkItem,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if ((await workItemDeliveryRepository.countOpenByWorkItem(item.id, tx)) > 0) return;

  // The row as this transaction has left it — `assertCardOpen` above locked and
  // re-read it, and the status is what that read is about.
  const current = (await workItemRepository.findById(item.id, tx)) ?? item;
  const statuses = await workflowsService.listStatusesByProject(
    current.projectId,
    ctx.workspaceId,
    tx,
  );
  const rank = rankOfStatus(current.status, statuses, {
    reviewKey: statuses.find((s) => s.key === 'in_review')?.key ?? null,
    implementedKey: statuses.find((s) => s.key === 'implemented')?.key ?? null,
    approvedKey: statuses.find((s) => s.key === 'approved')?.key ?? null,
  });
  if (rank >= RUNG_RANK.in_review) return;

  const { hopsToReview } = await import('@/lib/services/choiceGateService');
  const { workItemsService } = await import('@/lib/services/workItemsService');
  // MARKED_CARD_CANNOT_REOPEN (MOTIR-6681) PROPAGATES to the publisher: a DONE design
  // card is already refused (`DESIGN_CARD_CLOSED`), so only a LEGACY card marked while
  // open reaches this walk, and the publisher is told to clear the mark.
  for (const key of await hopsToReview(current, tx)) {
    await workItemsService.applyStatusTransition(current.id, key, ctx, tx);
  }
}

async function assertDesignSettled(
  item: WorkItem,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const approved = (
    await approvalGateRepository.findLatestApprovedByWorkItems([item.id], 'design_result', tx)
  ).get(item.id);
  if (!approved) return;

  const current = await designEvidenceRepository.findCurrentByWorkItem(item.id, tx);
  if (!current || current.id !== approved.subjectId) return;

  if ((await workItemDeliveryRepository.countOpenByWorkItem(item.id, tx)) === 0) return;

  const statuses = await workflowsService.listStatusesByProject(
    item.projectId,
    ctx.workspaceId,
    tx,
  );
  const rank = rankOfStatus(item.status, statuses, {
    reviewKey: statuses.find((s) => s.key === 'in_review')?.key ?? null,
    implementedKey: statuses.find((s) => s.key === 'implemented')?.key ?? null,
    approvedKey: statuses.find((s) => s.key === 'approved')?.key ?? null,
  });
  if (rank < RUNG_RANK.implemented) return;

  throw DesignCardClosedError.becauseApproved(item.identifier, item.status);
}

/**
 * The design result's `commitSha`, canonical — or a typed refusal naming the
 * field (MOTIR-5620).
 *
 * ⚠️ CALLED ON THE SERVICE, NOT ON EITHER DOOR, AND THAT IS THE WHOLE POINT.
 * This path has TWO entry points — the MCP tool and
 * `POST /api/work-items/[id]/design-evidence` — and a guard written at one of
 * them is absent the first time anything reaches the other. Both doors map on
 * the abstract `DesignEvidenceError`, so a throw here is already a typed refusal
 * on each of them with no door-side wiring at all. Same shape, and the same
 * shared guard, as `normalizeReceiptCommitSha` one file over.
 *
 * ⚠️ THE RESULT FEEDS BOTH JOBS. The value returned here is what the idempotency
 * lookup COMPARES and what `persistEvidence` STORES, so the compared value and
 * the stored value cannot differ — which is the only reason the `===` in
 * {@link findIdempotentExisting} is sound.
 *
 * An ABSENT citation stays absent: the field is optional, and a result with no
 * commit publishes fine (it simply cites nothing, and idempotency is skipped).
 */
function normalizeDesignCommitSha(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const result = normalizeCommitSha(raw);
  if (!result.ok) throw new DesignEvidenceCommitShaError(result.reason);
  return result.commitSha;
}

/**
 * Idempotency: a CI redelivery of the SAME commit+producer is a no-op — the
 * current result already records it, so return it (no re-upload, no duplicate
 * history row). Null when there is no matching current result.
 *
 * ⚠️ THE COMPARISON IS `===` ON THE STORED STRING, so it is only sound because
 * the value reaching it has been through {@link normalizeDesignCommitSha} and
 * the value it compares against was stored the same way. Two spellings of one
 * commit were two keys until they were (MOTIR-5620) — and the second key did not
 * merely write a history row, it marked the prior version's awaiting gate
 * `superseded` under a reviewer who was mid-review.
 */
async function findIdempotentExisting(
  workItemId: string,
  commitSha: string | null | undefined,
  producedByKey: string | null | undefined,
  ctx: ServiceContext,
): Promise<DesignEvidenceDTO | null> {
  if (!commitSha) return null;
  const existing = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
  );
  return existing &&
    existing.commitSha === commitSha &&
    existing.producedByKey === (producedByKey ?? null)
    ? toDesignEvidenceDto(existing)
    : null;
}

/**
 * Translate a lost supersede race into a typed domain error. The
 * `design_evidence_one_current_per_item` partial-unique index is what makes two
 * current rows unrepresentable, so the loser surfaces as a Prisma `P2002`;
 * letting that escape would leak a raw DB error out of the service (the
 * typed-error rule in CLAUDE.md). Anything else is re-thrown untouched.
 *
 * Extracted so the mapping is unit-testable without having to win a real race.
 */
export function translateSupersedeConflict(err: unknown, workItemId: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new DesignEvidenceSupersedeConflictError(workItemId);
  }
  return err;
}

interface ArtifactMeta extends DesignAssetInput {
  contentType: string;
  size: number;
  filename: string;
}

/**
 * Supersede the prior current result + write the new Attachment / asset /
 * evidence rows, atomically in ONE withWorkspaceContext transaction (which binds
 * the RLS GUC for the publish path, whose caller has no request middleware).
 */
async function persistEvidence(
  args: {
    item: WorkItem;
    artifacts: ArtifactMeta[];
    commitSha: string | null;
    ciRunUrl: string | null;
    producedByKey: string | null;
  },
  ctx: ServiceContext,
) {
  // The system approval's status hops (below), announced once this publish commits
  // (Bug MOTIR-9415) — `approveBySystem` runs in this transaction and cannot.
  const appliedTransitions: AppliedGateTransition[] = [];
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    // ⚠️ THE AUTHORITATIVE "DOES WORK WAIT ON THIS?" READ — INSIDE the write's own
    // transaction (MOTIR-5491; AMENDMENT 4 Q2). The callers pre-check the same
    // thing so a doomed publish uploads nothing, but only this read is taken where
    // a dependent closing between the check and the insert can still be seen. A
    // refusal here rolls the whole publish back: nothing superseded, no gate.
    await assertSomethingWaits(args.item, ctx, tx);

    // ⚠️ RETIRE THE PRIOR VERSION'S AWAITING GATE **FIRST** — before the
    // `design_evidence` lock, and the ORDER is the contract (MOTIR-4913; ADR §6b).
    //
    // WHAT it does: the revise loop publishes v2 while v1's gate is still
    // `awaiting`, and without this the Approvals tab keeps asking about a design
    // that is no longer current — a question whose answer would pin bytes for a
    // version the product had already moved past. `superseded` is the product's
    // own state: no actor, no authority, no note (the repository's own contract).
    //
    // WHY HERE rather than beside the supersede below, which is where it reads
    // as belonging: `approvalGatesService.decide` locks the GATE row and then
    // writes `design_evidence` (its pin). A publish that locked
    // `design_evidence` first and reached for the gate afterwards would take the
    // same two locks in the opposite order, and two transactions doing that is a
    // deadlock — precisely on the interleaving §6c cares about, an approval
    // racing a republish. Retiring the gate before the evidence lock makes both
    // paths take `approval_gate` then `design_evidence`, so the race resolves by
    // WAITING and each outcome is one of the two legitimate ones:
    //
    //   · the publish wins → v1's gate is `superseded`, the decide door re-reads
    //     it under its own lock and refuses with `ApprovalGateSupersededError`.
    //     Nothing was approved, so nothing needed pinning.
    //   · the decide wins → this statement WAITS on its gate-row lock, and by the
    //     time it returns v1's gate is `approved` and v1 is pinned; it therefore
    //     matches no `awaiting` row, and the supersede below finds the pin and
    //     keeps the bytes.
    //
    // Unconditional rather than gated on `prior`: a first publish has no gate to
    // retire, so the predicate matches nothing, and a condition here would have
    // to be derived from the very read this statement must precede.
    await approvalGateRepository.supersedeAwaitingByWorkItem(
      args.item.id,
      'design_result',
      // A NEWER VERSION is the cause here, and it is the one cause the two
      // surfaces MOTIR-5586 and MOTIR-5651 had to stop asserting because the row
      // could not tell them apart (AMENDMENT 6 Q5). From this write on they can.
      'republished',
      tx,
    );

    // Lock BEFORE reading what to supersede — the decision is read-derived, so
    // an unlocked read lets two publishes both target the same current row.
    await designEvidenceRepository.lockCurrentByWorkItem(args.item.id, tx);

    // ⚠️ A CLOSED CARD TAKES NO NEW VERSION — read HERE, under a `work_item` lock,
    // and the POSITION is the contract (MOTIR-5556; ADR §6c SECOND AMENDMENT).
    //
    // LOCK ORDER on this path: `approval_gate` (the supersede above) →
    // `design_evidence` (the line above) → `work_item` (this check). That is the
    // order `approvalGatesService.decide` takes — the gate FOR UPDATE, then the
    // pin's `design_evidence` lock, then the kind's effect, which transitions the
    // card and locks its row. Locking `work_item` any earlier would take the last
    // two in the opposite order and deadlock on exactly the race this check is
    // for: an Approve that closes the card, landing while this publish runs.
    // Resolved by waiting instead:
    //
    //   · the approval wins → this transaction waits on the gate (or on the row
    //     the pin holds), then reads `done` here and is refused. Nothing written.
    //   · the publish wins → it commits first; `decide` re-reads the gate the
    //     supersede above retired and refuses it. The card never reaches `done`.
    await assertCardOpen(args.item, ctx, tx);

    const prior = await designEvidenceRepository.findCurrentByWorkItem(args.item.id, tx);
    if (prior) {
      await designEvidenceRepository.markSupersededByWorkItem(args.item.id, tx);
      // ⚠️ THE PIN (ADR §6c). On a card that is still OPEN the supersede always
      // proceeds — the revise loop depends on republishing, and a card reopened
      // after approval is decided again. A CLOSED card never reaches this line
      // (`assertCardOpen` above, MOTIR-5556): a design evolves after approval
      // only once a person reopens its card. What the pin changes is ONE thing:
      // an approved version's attachments are not handed to the orphan-GC.
      //
      // ⚠️ The predicate reads `pinnedAt` ON THE ROW, and that is what makes it
      // blind to the gate KIND — which is the whole point of §6c's amendment. A
      // design that opened a pull request is approved through
      // `pull_request_approval`, so a predicate that went looking for an approved
      // `design_result` gate would stop pinning for the COMMON case, unlink as it
      // always did, and surface seven days later as an approval pointing at
      // nulls. The decide door writes this column for every kind, so nothing here
      // needs to know which door the decision came through.
      //
      // Unpinned — never decided, or `changes_requested` — is the intended loss:
      // the gate ROW keeps who said what and when; the bytes go.
      if (prior.pinnedAt === null) {
        // Unlink the superseded artifacts so the orphan-GC reclaims their blobs
        // after the safety window (one current result per item).
        const priorAttachmentIds = prior.assets
          .map((a) => a.attachmentId)
          .filter((id): id is string => id !== null);
        if (priorAttachmentIds.length > 0) {
          await attachmentRepository.unlinkFromWorkItem(priorAttachmentIds, tx);
        }
      }
    }

    const evidence = await designEvidenceRepository.create(
      {
        workspaceId: ctx.workspaceId,
        workItemId: args.item.id,
        // AMENDMENT 4: the note is published as the `note_file` and SHOWN as a
        // link, so a new row stores no inline copy. The columns stay for rows
        // published before it.
        noteMd: null,
        noteTruncated: false,
        commitSha: args.commitSha,
        ciRunUrl: args.ciRunUrl,
        producedByKey: args.producedByKey,
        isCurrent: true,
      },
      tx,
    );

    let position = 0;
    for (const artifact of args.artifacts) {
      const attachment = await attachmentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          uploaderUserId: ctx.userId,
          workItemId: args.item.id,
          source: 'design_asset',
          blobPathname: artifact.pathname,
          mimeType: artifact.contentType,
          sizeBytes: artifact.size,
          originalFilename: artifact.filename,
        },
        tx,
      );
      await designEvidenceRepository.createAsset(
        {
          workspaceId: ctx.workspaceId,
          designEvidenceId: evidence.id,
          kind: artifact.kind,
          attachmentId: attachment.id,
          sourcePath: artifact.sourcePath,
          position: position++,
        },
        tx,
      );
    }

    // THE APPROVAL GATE (Story MOTIR-4778 · Subtask MOTIR-4790; ADR
    // docs/decisions/approval-gates.md §6a). A gate is an EAGER row, written
    // **when its subject appears** — here, in the publish's own transaction —
    // rather than derived on read. Two things force it and both are
    // requirements elsewhere in the story: the partial unique index over the
    // `awaiting` state cannot exist without a row, and the decide door's
    // `SELECT … FOR UPDATE` has nothing to lock without one. A derived model is
    // the eager model minus its index and its lock.
    //
    // ⚠️ ONE GATE PER PUBLISHED VERSION, keyed on the EVIDENCE row, not on the
    // card. `subjectId` is `evidence.id`, which was created a few statements
    // above and is therefore new — so the partial unique
    // `(work_item_id, kind, subject_id) WHERE state = 'awaiting'` can never
    // collide here, and the publish is idempotent against it by construction.
    // ADR §6d step 5 is explicit that a republish *"supersedes the old row and
    // gets its own new gate, `awaiting`"*: a gate asks about specific BYTES, so
    // re-pointing an existing gate at a new version would silently change the
    // question under whoever is reading it.
    //
    // ⚠️ RETIRING THE PRIOR version's gate to `superseded` is MOTIR-4913's, and
    // it has LANDED — it is the first statement of this transaction, above,
    // rather than a step beside this one, for the lock-order reason recorded
    // there. So a republish leaves the previous version's gate `superseded` and
    // the decide door refuses it (`ApprovalGateSupersededError`), which it always
    // did; what changed is that something now writes the state.
    // ⚠️ AND IT CARRIES `routedToId` — §2's answer, COMPUTED HERE (MOTIR-5046).
    // §6a: *"§2's answer computed at creation; the assignee can change
    // afterwards"*, and that second clause is the whole reason the column exists:
    // the live card cannot answer who the product actually ASKED, only who it
    // would ask now. The answer comes from the KIND's own `routeTo` rather than
    // from `assigneeId ?? reporterId` written out again here — a second copy of a
    // routing rule is a second thing to keep in agreement with §2, and this door
    // will create gates of other kinds as they register.
    //
    // This is `routeTo`'s FIRST caller. It had none because its parameter type
    // demanded the gate row, which does not exist at the moment routing must be
    // answered; `GateRoutingArgs` is that knot untied.
    // ⚠️ THE Q8 SUPPRESSION IS GONE (Story MOTIR-5652 · Subtask MOTIR-5662;
    // AMENDMENT 6 Q1 reverses AMENDMENT 4 Q8). This block used to return early
    // when the card had an open delivering pull request, on the reasoning that
    // the approve-to-merge gate would carry the design decision. It did not: the
    // merge gate then refused on the run target, so a design card with a
    // published result and an open pull request had NO question at all — green
    // CI, In Review, and nothing to press. Two locally-careful suppressions, and
    // neither author could see the hole from their own card.
    //
    // ⚠️ AND THIS SITE NO LONGER DECIDES. It asks the predicate what the card
    // should hold and creates the design gate it names — so the card can, and
    // now does, hold TWO gates of different kinds, with the design one primary.
    // MOTIR-5603's invariant is about ONE MERGE gate per card and is untouched.
    const owed = (await gateSetFor(args.item, tx)).awaited.find(
      (gate) => gate.kind === 'design_result',
    );
    if (!owed) return (await designEvidenceRepository.findById(evidence.id, tx))!;

    // The switch, read under this transaction so it is the value at RAISE time: a flip
    // never decides a gate already waiting (MOTIR-697; `hosted-design-rerun-and-design-
    // approval-switch.md` §2f). OFF ⇒ nobody is asked, so the gate is routed to nobody
    // (§2c: `routedToId` null) and approved below by the system.
    const project = await projectRepository.findById(args.item.projectId, tx);
    const systemApproves = project !== null && !project.designApprovalGate;
    const routedToId = systemApproves
      ? null
      : handlerFor('design_result').routeTo({ item: args.item, ctx, tx });

    const raised = await approvalGateRepository.create(
      {
        workspaceId: ctx.workspaceId,
        projectId: args.item.projectId,
        workItemId: args.item.id,
        kind: 'design_result',
        subjectId: owed.subjectId,
        // ⚠️ WRITTEN FROM THE PREDICATE, and it used to be left null. A design
        // gate's subject id already identifies it (an evidence row is
        // immutable), so nothing READ this — but leaving it null made the row
        // unable to say which commit the design was drawn at, which is the same
        // silence MOTIR-5659 removed from a supersede.
        subjectVersion: owed.subjectVersion,
        routedToId,
      },
      tx,
    );

    // THE STATUS FOLLOWS THE QUESTION, in the same transaction that asked it
    // (Bug MOTIR-6009). It is placed AFTER the gate deliberately: the card is
    // In Review *because* somebody has been asked, so a rollback that loses the
    // gate must lose the status with it — and the early return above, where the
    // predicate says this card owes no design gate, must not move it at all.
    await moveToReviewWhenUndelivered(args.item, ctx, tx);

    // ⚠️ DESIGN APPROVAL SWITCHED OFF — the gate above is APPROVED BY THE SYSTEM, here,
    // in this same transaction (Story MOTIR-693 · MOTIR-697;
    // `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §2b–§2c). The
    // question is still asked and recorded — never skipped — so every reader of an
    // approved design (the retention pin, the republish guard, `list_designs`) sees the
    // one shape it already reads. `approveBySystem` runs the kind's own `approve`, so
    // the status effect is a person's approval's exactly: `done` with no open pull
    // request, nothing with one (the merge still follows `prMergeMode`).
    //
    // AFTER the review walk, because an approval writes `done`, and `in_review → done`
    // is the edge a person's press takes. LAZY import: `approvalGatesService` imports
    // this service for the pin.
    if (systemApproves) {
      const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
      await approvalGatesService.approveBySystem(raised.id, ctx, tx, appliedTransitions);
    }

    // Re-read so the caller gets the evidence WITH its just-inserted assets.
    // Non-null by construction: the row was created in THIS transaction, a few
    // statements above, and nothing between can remove it.
    return (await designEvidenceRepository.findById(evidence.id, tx))!;
  }).then(async (persisted) => {
    await emitAppliedGateTransitions(appliedTransitions, ctx);
    // TO RESUME (MOTIR-7707): with design approval switched off the gate above was
    // approved by the system, which releases a parent run that stopped at this
    // design. After the commit, in the close's lock order —
    // `resumeStateService.afterGateDecided` says why. A publish that only asked the
    // question moves nothing, and costs one read.
    await resumeStateService.afterGateDecided(args.item.id, ctx);
    // …and asks for the hosted resume of the run it released (MOTIR-7710), only when
    // the publish's gate is APPROVED — the read decides, so a publish that asked the
    // question enqueues nothing.
    await requestGateResumeAfterDecision(
      { workItemId: args.item.id, kind: 'design_result' },
      ctx.workspaceId,
    );
    return persisted;
  });
}

export const designEvidenceService = {
  /**
   * The ids of the OPEN work items `blocked_by` this design card — the answer the
   * publish gate refuses on when it is empty (AMENDMENT 4 Q2). Exported ONCE so
   * the dispatch prompt decides whether to carry the publish step from the same
   * read the server will enforce, rather than from a second rule.
   */
  async findWaitingDependentIds(workItemId: string, ctx: ServiceContext): Promise<string[]> {
    return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      openDependentIds(workItemId, ctx.workspaceId, tx),
    );
  },

  /**
   * Mint scoped CLIENT upload grants so a trusted CI job PUTs each design
   * artifact DIRECTLY to the private store, never through the application. Each
   * grant is bound to one exact pathname (under this item's
   * `design/<ws>/<itemId>/` prefix), one content type, and the org's per-file
   * cap. CI then reports the pathnames back via {@link recordFromPathnames}.
   *
   * The declared content type is checked against the design allowlist HERE, so a
   * disallowed type never gets a key minted for it at all — and checked AGAIN at
   * register against what the store actually holds, because a presigned PUT
   * proves what was signed, not what was sent.
   */
  async createUploadTokens(
    input: {
      workItemId: string;
      files: Array<{ kind: DesignAssetKindDTO; sourcePath: string; contentType: string }>;
      /** The container whose parent-run branch this publish belongs to, if any. */
      withinParentKey?: string | null;
    },
    ctx: ServiceContext,
  ): Promise<DesignUploadTokensDTO> {
    const item = await resolveTarget(input.workItemId, ctx, input.withinParentKey);
    if (!input.files || input.files.length === 0) throw new DesignEvidenceEmptyError();
    // AMENDMENT 4, at the MINT as well as the publish: a grant for a retired kind,
    // or for a card nothing waits on, is a publish that can never succeed — so no
    // bytes get uploaded for it. The mock / note-file COUNT is a property of the
    // whole publish and is checked there, not per grant.
    const image = input.files.find((file) => file.kind === 'image');
    if (image) throw new DesignEvidenceImageRetiredError(image.sourcePath);
    // A grant for a closed card is a publish that can never succeed. The mint
    // writes no row, so the unlocked read is the whole check here.
    await assertCardOpen(item, ctx);
    await assertSomethingWaits(item, ctx);

    const { perFileLimit } = await resolveCostContext(ctx.workspaceId);
    const prefix = designPrefix(ctx.workspaceId, item.id);
    const nonce = randomUUID();

    const targets: DesignUploadTargetDTO[] = [];
    for (const [index, file] of input.files.entries()) {
      if (!ASSET_KINDS.includes(file.kind)) {
        throw new UnsupportedFileTypeError(String(file.kind));
      }
      if (!isAllowedDesignAssetType(file.contentType)) {
        throw new UnsupportedFileTypeError(file.contentType);
      }
      // The nonce + index keep two files of the same basename from colliding,
      // and keep a re-publish from overwriting the previous run's objects (the
      // superseded ones are the orphan-GC's to reclaim, not ours to clobber).
      const pathname = `${prefix}${nonce}-${index}-${basenameOf(file.sourcePath)}`;
      targets.push({
        sourcePath: file.sourcePath,
        kind: file.kind,
        pathname,
        token: await mintPrivateUploadToken(pathname, {
          contentType: file.contentType,
          maxBytes: perFileLimit,
        }),
        contentType: file.contentType,
        maxBytes: perFileLimit,
      });
    }
    return { targets };
  },

  /**
   * Register design artifacts already CLIENT-uploaded to the private store,
   * superseding the prior current result. The caller reports only pathnames; the
   * server (a) rejects any pathname OUTSIDE this item's design prefix and
   * (b) `head`s each blob for its AUTHORITATIVE size + contentType — so a lying,
   * cross-tenant or absent pathname can never be recorded, and a mock that
   * DECLARED `image/png` but uploaded HTML is rejected on what the store holds.
   *
   * **Never advances the item's status.** Publishing is evidence, not a workflow
   * decision — holding dependents and asking a human to approve belongs to the
   * runtime design-approval gate (§7).
   */
  async recordFromPathnames(
    input: RecordDesignResultInput,
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO> {
    const item = await resolveTarget(input.workItemId, ctx, input.withinParentKey);

    if (!input.assets || input.assets.length === 0) throw new DesignEvidenceEmptyError();
    assertResultShape(input.assets, input.noteMd);
    // Before idempotency, so a redelivery after the card closed or the last
    // dependent closed is refused like any other publish rather than handed the
    // stale result. `persistEvidence` re-reads both inside its transaction.
    await assertCardOpen(item, ctx);
    await assertSomethingWaits(item, ctx);

    // AFTER the access gate, so a caller who cannot see the item still gets the
    // 404-not-403 answer rather than learning its citation was malformed. ONE
    // normalisation, feeding both the idempotency lookup and the persist below.
    const commitSha = normalizeDesignCommitSha(input.commitSha);

    const idempotent = await findIdempotentExisting(item.id, commitSha, input.producedByKey, ctx);
    if (idempotent) return idempotent;

    // SECURITY: every reported pathname MUST live under this item's design
    // prefix (reject an arbitrary or cross-tenant blob before any DB write).
    const prefix = designPrefix(ctx.workspaceId, item.id);
    for (const asset of input.assets) {
      if (!asset.pathname.startsWith(prefix)) {
        throw new DesignEvidencePathnameError(asset.pathname);
      }
      if (!ASSET_KINDS.includes(asset.kind)) {
        throw new UnsupportedFileTypeError(String(asset.kind));
      }
    }

    const { organizationId, perFileLimit } = await resolveCostContext(ctx.workspaceId);

    const artifacts: ArtifactMeta[] = [];
    for (const asset of input.assets) {
      // head() → the blob must EXIST (the client upload completed) and its size
      // + contentType are read from the STORE, never trusted from the caller.
      const head = await headPrivateBlob(asset.pathname);
      if (!head) throw new DesignEvidenceBlobMissingError(asset.pathname);
      if (!isAllowedDesignAssetType(head.contentType)) {
        throw new UnsupportedFileTypeError(head.contentType);
      }
      if (head.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
      if (organizationId) {
        await entitlementsService.assertWithinStorageCap(organizationId, head.size);
      }
      artifacts.push({
        ...asset,
        contentType: head.contentType,
        size: head.size,
        filename: blobFilename(asset.pathname),
      });
    }

    try {
      const row = await persistEvidence(
        {
          item,
          artifacts,
          commitSha,
          ciRunUrl: input.ciRunUrl ?? null,
          producedByKey: input.producedByKey ?? null,
        },
        ctx,
      );
      return toDesignEvidenceDto(row);
    } catch (err) {
      throw translateSupersedeConflict(err, item.id);
    }
  },

  /**
   * Publish a design result from BYTES THE CALLER ALREADY HOLDS (MOTIR-3782) —
   * the door for an agent inside the server, where the mint-then-PUT dance has
   * nothing to dance with.
   *
   * ⚠️ IT ADDS NO POLICY. Every decision stays where it already lived: the
   * target resolution and its leaf / child refusals are {@link resolveTarget};
   * the pathname is composed exactly as {@link createUploadTokens} composes it,
   * under the same `design/<ws>/<itemId>/` prefix with the same nonce-and-index
   * collision guard; and the whole register half — the prefix check, the
   * authoritative `head`, the storage cap, the AMENDMENT 4 shape and waiting
   * gates, supersede and idempotency — is {@link recordFromPathnames},
   * called at the end rather than reimplemented. What this method owns is the
   * upload, and nothing else.
   *
   * ⚠️ THE PER-FILE CAP IS CHECKED BEFORE THE WRITE, WHICH THE MINTED PATH
   * CANNOT DO. A presigned PUT is enforced server-side AFTER the object lands
   * (`mintPrivateUploadToken`'s own note), because the grant cannot bound what a
   * client actually sends. Here the bytes are in hand, so an over-cap asset is
   * refused having written nothing — a strictly better outcome reached only
   * because the caller is on this side of the wire. `recordFromPathnames` still
   * re-checks the STORED size, and that check remains the authoritative one.
   *
   * ⚠️ THE DECLARED TYPE IS CHECKED HERE AND THE STORED TYPE AT REGISTER, and
   * both are deliberate. This one refuses a disallowed type before any object
   * exists — the same thing the mint step does for the same reason. The register
   * check reads what the store holds, which is what actually protects §5's
   * one-entrance guarantee for `text/html`.
   */
  async recordFromBytes(
    input: RecordDesignResultFromBytesInput,
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO> {
    const item = await resolveTarget(input.workItemId, ctx, input.withinParentKey);
    if (!input.assets || input.assets.length === 0) throw new DesignEvidenceEmptyError();
    // Refuse BEFORE the upload, so a doomed publish writes no orphan objects;
    // `recordFromPathnames` re-asserts both, and the in-transaction read is the
    // authoritative one.
    assertResultShape(input.assets, input.noteMd);
    await assertCardOpen(item, ctx);
    await assertSomethingWaits(item, ctx);
    // Refuse a malformed citation HERE rather than letting `recordFromPathnames`
    // do it, for the same reason the two gates above are re-asserted: this door
    // UPLOADS before it delegates, so a refusal further down would leave orphan
    // objects in the store. Normalising twice is free — the canonical form is a
    // fixed point.
    normalizeDesignCommitSha(input.commitSha);

    const { perFileLimit } = await resolveCostContext(ctx.workspaceId);
    const prefix = designPrefix(ctx.workspaceId, item.id);
    const nonce = randomUUID();

    const uploaded: DesignAssetInput[] = [];
    for (const [index, asset] of input.assets.entries()) {
      if (!ASSET_KINDS.includes(asset.kind)) {
        throw new UnsupportedFileTypeError(String(asset.kind));
      }
      if (!isAllowedDesignAssetType(asset.contentType)) {
        throw new UnsupportedFileTypeError(asset.contentType);
      }
      if (asset.bytes.byteLength > perFileLimit) throw new FileTooLargeError(perFileLimit);

      // ⚠️ REGISTER THE KEY THE STORE ACTUALLY WROTE, never the one asked for.
      // `putPrivateAttachment` returns the object key, and `putObject` appends a
      // random suffix to it before writing — so the requested pathname names no
      // object, and registering it makes the very next step
      // (`recordFromPathnames`'s authoritative `head`) fail with
      // `DESIGN_EVIDENCE_BLOB_MISSING`. The suffix is still under this item's
      // design prefix, so the prefix check is unaffected.
      const written = await putPrivateAttachment(
        `${prefix}${nonce}-${index}-${basenameOf(asset.sourcePath)}`,
        asset.bytes,
        asset.contentType,
      );
      uploaded.push({
        kind: asset.kind,
        sourcePath: asset.sourcePath,
        pathname: written.pathname,
      });
    }

    // Address the item by ID: it is already resolved, and re-resolving by the
    // caller's original reference would re-run the child gate against a
    // container this call has already cleared.
    return this.recordFromPathnames({ ...input, workItemId: item.id, assets: uploaded }, ctx);
  },

  /**
   * WITHDRAW a work item's CURRENT design result — clear it with NOTHING taking
   * its place (MOTIR-3215).
   *
   * Until this existed the table had exactly two mutations, create and
   * supersede-by-publish, and BOTH need a replacement. A result published onto a
   * card that will never have a design of its own therefore could not be
   * corrected by any means: there is nothing correct to publish over it. That is
   * not a gap somebody failed to fill — it is the reason MOTIR-3213's stray rows
   * were still standing in production days after the publisher was fixed.
   *
   * **Nothing is deleted, and that is settled law in this domain.** The evidence
   * row survives, its `design_asset` rows survive, and their `Attachment` rows
   * are NOT unlinked — unlike a supersede, which hands the old blobs to the
   * orphan-GC because a correct replacement has taken over the record. Here the
   * record IS the point: destroying it would leave no way to see what was
   * wrongly claimed, or that anything was claimed at all. Same position
   * `declinePlan` reached in MOTIR-3154 / MOTIR-3160.
   *
   * **Never advances the item's status**, for the same reason the publish path
   * does not: this is evidence, not a workflow decision.
   *
   * **It DOES retire the question the result raised (MOTIR-5574; ADR §6b).** A
   * withdrawal is the second product write that takes a gate's subject away, and
   * the first — a republish — already marks the prior version's `awaiting`
   * `design_result` gate `superseded`. Without the same write here the gate
   * outlives its subject: the To-approve tab keeps asking about bytes nobody
   * should approve, and the held transitions that read an awaiting gate keep
   * holding the card.
   */
  async withdrawCurrentForWorkItem(
    input: { workItemId: string; reason?: string | null },
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO> {
    const item = await resolveWithdrawTarget(input.workItemId, ctx);

    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // ⚠️ RETIRE THE AWAITING `design_result` GATE **FIRST**, before the
        // `design_evidence` lock (MOTIR-5574; ADR §6b AMENDMENT). This is the
        // publish path's lock order, for the publish path's reason:
        // `approvalGatesService.decide` locks the gate row and then writes
        // `design_evidence` (the pin), so taking the evidence lock first and the
        // gate second would deadlock a withdrawal against a decision. Gate first,
        // and the race resolves by waiting:
        //
        //   · the withdrawal wins → the gate is `superseded`, and the decide door
        //     re-reads it under its lock and refuses with `ApprovalGateSupersededError`.
        //   · the decision wins → this statement waits on the gate row, finds it
        //     decided, matches nothing, and the answer outlives its subject.
        //
        // If there turns out to be no current result, the refusal below rolls
        // this back with everything else, so a refused withdrawal retires nothing.
        await approvalGateRepository.supersedeAwaitingByWorkItem(
          item.id,
          'design_result',
          // The result itself is going away — not being replaced. A reviewer asked
          // about bytes that will not exist when they answer (AMENDMENT 6 Q5).
          'withdrawn',
          tx,
        );

        // Lock BEFORE reading which row to withdraw — the decision is
        // read-derived exactly as the supersede's is, so an unlocked read lets a
        // concurrent publish insert a new current row that this withdrawal then
        // silently misses (the lock-before-read-derived-update rule in
        // CLAUDE.md). The lock is what makes "the row I read is the row I write"
        // true here.
        await designEvidenceRepository.lockCurrentByWorkItem(item.id, tx);
        // A closed card gives up its result as little as it takes a new one
        // (MOTIR-5556). Same lock order as the publish: `design_evidence`, then
        // `work_item`.
        await assertCardOpen(item, ctx, tx);
        const current = await designEvidenceRepository.findCurrentByWorkItem(item.id, tx);
        if (!current) throw new DesignEvidenceNoCurrentResultError(item.identifier);
        return designEvidenceRepository.withdrawById(
          current.id,
          { withdrawnById: ctx.userId, withdrawnReason: input.reason?.trim() || null },
          tx,
        );
      },
    );
    return toDesignEvidenceDto(row);
  },

  /**
   * PIN the work item's CURRENT design version against the orphan-GC, inside a
   * transaction the caller already owns (MOTIR-4913; ADR §6c and its MOTIR-4911
   * amendment).
   *
   * **Called by `approvalGatesService.decide` on every APPROVAL, whatever the
   * gate's kind**, which is the correction §6c's amendment exists for: *when a
   * work item carrying a current design result is approved, pin THAT version —
   * whichever gate carried the decision.* A design with a pull request is
   * approved through `pull_request_approval`, so a rule keyed on the
   * `design_result` gate would stop pinning for the common case, with no error
   * and no red test, and arrive a week later as an approval pointing at nulls.
   *
   * ⚠️ IT TAKES THE CALLER'S `tx`, deliberately, and that is the requirement
   * rather than a convenience. §6c: *written afterwards, a republish racing an
   * approval re-opens the window it exists to close.* Same shape as
   * `workItemsService.applyStatusTransition`, which the design-result handler
   * calls with the door's transaction for the same reason.
   *
   * ⚠️ LOCK BEFORE THE READ-DERIVED WRITE. Which row to pin is READ (`WHERE
   * is_current`) and then WRITTEN, so it takes the SAME `FOR UPDATE` the
   * supersede path takes — that is what serialises the two rather than letting
   * both act on a row the other is replacing.
   *
   * Returns the pinned version's id, or **null when there was nothing to pin** —
   * a card with no design result at all (the ordinary case for most kinds), or a
   * publish that superseded the current row while this transaction waited for the
   * lock. Null is an answer, never a failure: the caller records it and the
   * decision still stands.
   */
  async pinCurrentForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const lockedIds = await designEvidenceRepository.lockCurrentByWorkItem(workItemId, tx);
    // At most one by construction — `design_evidence_one_current_per_item`.
    const currentId = lockedIds[0];
    if (!currentId) return null;
    await designEvidenceRepository.pinById(currentId, tx);
    return currentId;
  },

  /**
   * The CURRENT design result for a work item — the Design result panel's read.
   * Returns null when nothing has been published (the panel's empty state, which
   * is the normal case for every card that shipped before this feature).
   */
  async getCurrentForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DesignEvidenceDTO | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => designEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    );
    return row ? toDesignEvidenceDto(row) : null;
  },

  /**
   * The design version a DECIDED approval gate was about — the port's contents
   * in the frame's states `E` and `F` (Subtask MOTIR-5033; ADR §6c).
   *
   * ⚠️ READ BY THE GATE'S `subjectId`, never by `findCurrentByWorkItem`, and
   * this is the same instruction the gate registry's own `resolveSubject`
   * carries for the same reason: *a gate asks about the bytes somebody was
   * looking at, and a republish makes a different row current.* A port fed the
   * current row would re-point a decided question at a version the decider
   * never saw, silently, and the screen would look right.
   *
   * ⚠️ THE `workItemId` IS A GUARD, NOT A LOOKUP KEY. `design_evidence.id` is a
   * cuid the caller took off a gate row, and the gate and the evidence are
   * joined only by convention — so this asserts the row belongs to the card
   * being rendered and returns the empty answer when it does not. Under RLS a
   * cross-workspace row is already invisible; this closes the narrower
   * cross-CARD case inside one workspace, where nothing else would.
   *
   * `filesKept` is `pinnedAt` off the ROW, never `state === 'approved'` off the
   * gate — the DTO's own note says why that distinction is the point of the
   * line rather than a nicety.
   */
  async getForGateSubject(
    input: { workItemId: string; subjectId: string },
    ctx: ServiceContext,
  ): Promise<DesignGateSubjectDTO> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => designEvidenceRepository.findById(input.subjectId, tx),
    );
    // A row that is gone is the EXPECTED answer for a version that was sent
    // back: only an approval pins, so `changes_requested` bytes are reclaimed.
    if (!row || row.workItemId !== input.workItemId) return { evidence: null, filesKept: false };
    return { evidence: toDesignEvidenceDto(row), filesKept: row.pinnedAt !== null };
  },
};
