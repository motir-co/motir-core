import { Prisma, type WorkItem } from '@/generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { reconcileGatesFor } from '@/lib/services/gateSetFor';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { headPrivateBlob, mintPrivateUploadToken, putPrivateAttachment } from '@/lib/blob/uploader';
import { MAX_UPLOAD_BYTES, isAllowedAcceptanceVideoType } from '@/lib/blob/allowlist';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';
import {
  AcceptanceEvidenceBlobMissingError,
  AcceptanceEvidenceCommitShaError,
  AcceptanceEvidenceNotAStoryError,
  AcceptanceEvidenceNotFoundError,
  AcceptanceEvidencePathnameError,
  AcceptanceEvidenceStoryClosedError,
} from '@/lib/acceptanceEvidence/errors';
import { isReceiptOwner } from '@/lib/acceptanceEvidence/receiptOwner';
import { normalizeCommitSha } from '@/lib/git/commitSha';
import { toAcceptanceEvidenceDto } from '@/lib/mappers/acceptanceEvidenceMappers';
import type {
  AcceptanceEvidenceChapterDTO,
  AcceptanceEvidenceDTO,
  AcceptanceEvidenceStatusDTO,
  AcceptanceUploadTargetDTO,
  AcceptanceUploadTokensDTO,
} from '@/lib/dto/acceptanceEvidence';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

/**
 * Story-acceptance evidence — business logic (Story MOTIR-1627 · Subtask
 * MOTIR-1629). Owns the create-from-upload flow (supersede the prior current +
 * store the new video receipt), the panel read, and the status update. Reuses
 * the shipped blob pipeline + the entitlements caps for the bytes; the
 * PLAN/toggle ELIGIBILITY gate lives in MOTIR-1630 and is applied by the publish
 * routes (MOTIR-1631/1681) in FRONT of these methods — this service enforces the
 * mechanical cost bounds (allowlist, per-file, storage cap) only.
 */
export interface RecordAcceptanceVideoInput {
  /** The STORY this evidence accepts. */
  workItemId: string;
  /** The recorded acceptance video (webm/mp4 — the acceptance-scoped allowlist). */
  video: File;
  /** Chapter markers `[{ label, tSeconds }]`; omitted → no markers. */
  chapters?: AcceptanceEvidenceChapterDTO[];
  /** The Playwright trace blob (dev diagnostic), when captured. */
  trace?: File | null;
  commitSha?: string | null;
  ciRunUrl?: string | null;
  /** The E2E subtask key that produced the video (e.g. "MOTIR-1638"). */
  producedByKey?: string | null;
}

/**
 * Register pre-uploaded acceptance artifacts by their blob PATHNAME (MOTIR-1681)
 * — the direct-to-Blob publish path, so a large video never streams through the
 * ~4.5MB serverless body cap.
 */
export interface RecordFromPathnamesInput {
  workItemId: string;
  /** The private-store key the CI client-uploaded the video to. */
  videoPathname: string;
  /** The trace's private-store key, when captured. */
  tracePathname?: string | null;
  chapters?: AcceptanceEvidenceChapterDTO[];
  commitSha?: string | null;
  ciRunUrl?: string | null;
  producedByKey?: string | null;
}

interface ArtifactMeta {
  pathname: string;
  contentType: string;
  size: number;
  filename: string;
}

/** The private-store key prefix that scopes a story's acceptance artifacts. */
function acceptancePrefix(workspaceId: string, storyId: string): string {
  return `acceptance/${workspaceId}/${storyId}/`;
}

/** The last path segment (the stored filename) of a blob pathname. */
function blobFilename(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

/** Resolve + validate the acceptance target is a visible STORY (RLS-scoped). */
async function resolveStory(workItemId: string, ctx: ServiceContext): Promise<WorkItem> {
  const story = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => workItemRepository.findById(workItemId, tx),
  );
  if (!story) throw new AcceptanceEvidenceNotFoundError(workItemId);
  if (!(await isReceiptOwner(story, ctx))) throw new AcceptanceEvidenceNotAStoryError(story.kind);
  // `work_item:edit` (Story MOTIR-2291 · Subtask MOTIR-2365) — THE SHARPEST ITEM
  // IN THE BUCKET. Both acceptance-evidence rows were labelled `existing` while
  // the SAME row's `Gate today` column read "— none —", a contradiction inside one
  // line of a `done` document. The code agreed with the second half: this resolver
  // loaded the story, checked its kind, and asked nothing about the project — so
  // `createUploadTokens`, which MINTS a pre-signed upload token against the
  // workspace's blob store, was reachable with a session and a story id alone.
  //
  // Both callers go through here, so the gate goes here: attaching acceptance
  // evidence to a story is editing that story, and the project is resolved from
  // the STORY rather than the actor's active project.
  await projectAccessService.assertPermission(story.projectId, ctx, 'work_item:edit');
  return story;
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
 * The receipt's commit CITATION, canonical — or a typed refusal (MOTIR-5619).
 *
 * ⚠️ CALLED ONCE PER PUBLISH, AND ITS RESULT FEEDS BOTH JOBS. `commitSha` is
 * compared by `findIdempotentExisting` and stored by `persistEvidence`, so
 * normalising it in one place and passing that one value to both is what makes
 * the idempotency key canonical. Normalising at each use would compare one
 * spelling and store another.
 *
 * ⚠️ AND IT LIVES HERE RATHER THAN AT EITHER DOOR. The publish path has two
 * entry points — `publish_acceptance_result` and
 * `POST /api/work-items/[id]/acceptance-evidence` — and they must not be able to
 * disagree about what a citation is. Both `toToolError` and the route's error
 * mapping key on the ABSTRACT `AcceptanceEvidenceError`, so a throw here is
 * already a typed refusal naming the field on both of them, with no door-side
 * wiring at all. Same reasoning the eligibility gate and the owning-story hop
 * are shared rather than restated (MOTIR-4144).
 *
 * An ABSENT citation stays absent: the field is optional, and a receipt with no
 * commit is watchable (it simply cites nothing, and idempotency is skipped).
 */
function normalizeReceiptCommitSha(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const result = normalizeCommitSha(raw);
  if (!result.ok) throw new AcceptanceEvidenceCommitShaError(result.reason);
  return result.commitSha;
}

/**
 * Idempotency: a CI redelivery of the SAME commit+producer is a no-op — the
 * current evidence already records it, so return it (no re-upload, no duplicate
 * history row). Null when there is no matching current evidence.
 *
 * ⚠️ THE COMPARISON IS `===` ON THE STORED STRING, so it is only sound because
 * the value reaching it has been through `normalizeReceiptCommitSha` and the
 * value it compares against was stored the same way. Two spellings of one
 * commit were two keys until they were (MOTIR-5619).
 */
async function findIdempotentExisting(
  storyId: string,
  commitSha: string | null | undefined,
  producedByKey: string | null | undefined,
  ctx: ServiceContext,
): Promise<AcceptanceEvidenceDTO | null> {
  if (!commitSha) return null;
  const existing = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => acceptanceEvidenceRepository.findCurrentByWorkItem(storyId, tx),
  );
  return existing &&
    existing.commitSha === commitSha &&
    existing.producedByKey === (producedByKey ?? null)
    ? toAcceptanceEvidenceDto(existing)
    : null;
}

/**
 * Refuse a new receipt for a story that cannot take one (MOTIR-5872) — the
 * acceptance twin of the design gate's `assertStatusOpen` + `assertDesignSettled`,
 * and deliberately the SAME two conditions:
 *
 * · **A CLOSED story** (a terminal status) takes no new receipt. Its acceptance is
 *   decided; reopening it by hand is the way back.
 * · **A story STANDING ON an approved receipt.** The current receipt is
 *   `approved`, the story is at or above `implemented` — the rung that says its
 *   pull request is open and it is OFFERING commits — and a delivery is still
 *   open. That merge ships with whatever receipt is current, so a republish now
 *   would carry a recording nobody approved to `done`. Below `implemented` the
 *   work is being redone, which is exactly when a new recording is right; a
 *   person pulling the story back to `in_progress` is the deliberate re-open.
 *
 * What it does NOT refuse, and this is the fix: an approved receipt on a story
 * that has come back to be reworked. Approval pins the recording and moves the
 * story; it does not freeze the story (`acceptance-receipt-lifecycle.md`
 * AMENDMENT 1).
 *
 * ⚠️ The status vocabulary is a policy-gated read, so it is given the caller's
 * bound transaction — unbound under the runtime role it returns no statuses and
 * every story would read as open.
 */
async function assertStoryTakesAReceipt(
  story: WorkItem,
  currentReceiptStatus: string | null,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await workItemRepository.lockById(story.id, tx);
  const current = (await workItemRepository.findById(story.id, tx)) ?? story;

  const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
    [current.projectId],
    ctx.workspaceId,
    tx,
  );
  if (isTerminalStatus(current, terminalByProject)) {
    throw new AcceptanceEvidenceStoryClosedError(current.identifier, current.status);
  }

  if (currentReceiptStatus !== 'approved') return;
  if ((await workItemDeliveryRepository.countOpenByWorkItem(current.id, tx)) === 0) return;

  const statuses = await workflowsService.listStatusesByProject(
    current.projectId,
    ctx.workspaceId,
    tx,
  );
  const rank = rankOfStatus(current.status, statuses, {
    reviewKey: statuses.find((s) => s.key === 'in_review')?.key ?? null,
    implementedKey: statuses.find((s) => s.key === 'implemented')?.key ?? null,
    approvedKey: statuses.find((s) => s.key === 'approved')?.key ?? null,
    toPlanKey: statuses.find((s) => s.key === 'to_plan')?.key ?? null,
  });
  if (rank < RUNG_RANK.implemented) return;

  throw AcceptanceEvidenceStoryClosedError.becauseApproved(current.identifier, current.status);
}

/**
 * Supersede the prior current evidence + write the new video (+ trace)
 * Attachment rows and the evidence row, atomically in ONE withWorkspaceContext
 * transaction (binds the RLS GUC for the publish path, which has no
 * request-middleware context). Shared by both publish paths.
 */
async function persistEvidence(
  args: {
    story: WorkItem;
    video: ArtifactMeta;
    trace: ArtifactMeta | null;
    chapters: AcceptanceEvidenceChapterDTO[];
    commitSha: string | null;
    ciRunUrl: string | null;
    producedByKey: string | null;
  },
  ctx: ServiceContext,
) {
  return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
    // ⚠️ RETIRE THE PRIOR RECORDING'S AWAITING GATE **FIRST** — before the receipt
    // lock below, and the ORDER is the contract (MOTIR-4950; the same one
    // `designEvidenceService` records for its pair). The decide door locks the GATE
    // and then the receipt (the acceptance handler's stamp); taking them here in the
    // opposite order would deadlock precisely on an approval racing a republish.
    // `republished` is the cause AMENDMENT 6 Q5 already names for a newer version,
    // and the MOTIR-5787 amendment (point 5) re-uses it rather than minting one.
    //
    // ⚠️ AN APPROVED RECEIPT HAS NO AWAITING GATE, so this retires nothing about
    // it: its gate is decided, and a decided row is immutable. A refusal further
    // down rolls this statement back with the rest of the publish.
    await approvalGateRepository.supersedeAwaitingByWorkItem(
      args.story.id,
      'acceptance_result',
      'republished',
      tx,
    );

    // Lock the current receipt BEFORE reading what to supersede — the decision is
    // read-derived, so an unlocked read lets two publishes both target one row.
    const locked = await acceptanceEvidenceRepository.lockCurrentStatusByWorkItem(
      args.story.id,
      tx,
    );

    // ⚠️ THE STORY MUST BE OPEN — read HERE, under a `work_item` lock, and the
    // POSITION is the contract (MOTIR-5872; the design gate's `assertCardOpen`,
    // MOTIR-5556). Lock order on this path: `approval_gate` (the supersede above)
    // → `acceptance_evidence` (the line above) → `work_item` (this check), which is
    // the order the decide door takes: the gate FOR UPDATE, the handler's receipt
    // stamp, then the story's transition. So an Approve racing this publish is
    // resolved by WAITING, never by a deadlock.
    await assertStoryTakesAReceipt(args.story, locked?.status ?? null, ctx, tx);

    const prior = await acceptanceEvidenceRepository.findCurrentByWorkItem(args.story.id, tx);
    if (prior) {
      await acceptanceEvidenceRepository.markSupersededByWorkItem(args.story.id, tx);
      // ⚠️ THE PIN (MOTIR-5872, replacing MOTIR-2764's freeze). An APPROVED
      // receipt is the record of a person watching THAT recording and signing it,
      // so its video + trace stay linked and the orphan-GC never reclaims them —
      // the same promise `design_evidence.pinned_at` makes for an approved design
      // version. The row keeps `status: 'approved'` and its approver stamp; it is
      // history now, not the current receipt.
      //
      // Anything else — `pending`, `changes_requested` — is the intended loss:
      // unlinked, so the GC reclaims the bytes after its safety window (one
      // current receipt per story). The gate row keeps who said what, and when.
      if (prior.status !== 'approved') {
        const priorAttachmentIds = [prior.attachmentId, prior.traceAttachmentId].filter(
          (id): id is string => id !== null,
        );
        if (priorAttachmentIds.length > 0) {
          await attachmentRepository.unlinkFromWorkItem(priorAttachmentIds, tx);
        }
      }
    }
    const attachment = await attachmentRepository.create(
      {
        workspaceId: ctx.workspaceId,
        uploaderUserId: ctx.userId,
        workItemId: args.story.id,
        source: 'acceptance_video',
        blobPathname: args.video.pathname,
        mimeType: args.video.contentType,
        sizeBytes: args.video.size,
        originalFilename: args.video.filename,
      },
      tx,
    );
    let traceAttachmentId: string | null = null;
    if (args.trace) {
      const traceAttachment = await attachmentRepository.create(
        {
          workspaceId: ctx.workspaceId,
          uploaderUserId: ctx.userId,
          workItemId: args.story.id,
          source: 'acceptance_trace',
          blobPathname: args.trace.pathname,
          mimeType: args.trace.contentType,
          sizeBytes: args.trace.size,
          originalFilename: args.trace.filename,
        },
        tx,
      );
      traceAttachmentId = traceAttachment.id;
    }
    const evidence = await acceptanceEvidenceRepository.create(
      {
        workspaceId: ctx.workspaceId,
        workItemId: args.story.id,
        attachmentId: attachment.id,
        traceAttachmentId,
        chapters: (args.chapters ?? []) as unknown as Prisma.InputJsonValue,
        status: 'pending',
        commitSha: args.commitSha,
        ciRunUrl: args.ciRunUrl,
        producedByKey: args.producedByKey,
        isCurrent: true,
      },
      tx,
    );

    // ⚠️ THE ACCEPTANCE QUESTION, RAISED ON THE STORY (MOTIR-4950; `approval-gates.md`
    // §1's MOTIR-5787 amendment, point 1). `args.story` is the receipt's owner, which
    // both publish doors resolve UP from a leaf key — so the gate lands on the story
    // whatever card the run was launched against, and never on the E2E subtask that
    // recorded the video. The switch needs no check here: both doors refuse an
    // ineligible project before anything is uploaded, so a receipt that reaches this
    // line exists only on a project whose switch is ON.
    //
    // ⚠️ AND IT IS THE PREDICATE THAT RAISES IT (MOTIR-5789), not this site. The publish
    // WAKES the evaluation (MOTIR-5670's *the card's own changes re-ask it*) and
    // `reconcileGatesFor` raises whatever the card should be asking — the acceptance
    // question over the receipt just inserted, and on a story run whose set is green the
    // merge question beside it. One creator, so the two can never disagree about which
    // questions this story holds.
    await reconcileGatesFor(args.story, tx);
    return evidence;
  });
}

/**
 * The stamp itself: `approved` records the deciding actor + the moment; every
 * other status clears both. Takes `tx` so a caller that must hold a row lock
 * across the read and the write can do so in ONE transaction (`decide`), while
 * the standalone `setStatus` opens its own.
 */
async function stampStatus(
  evidenceId: string,
  status: AcceptanceEvidenceStatusDTO,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
) {
  const approved = status === 'approved';
  return acceptanceEvidenceRepository.updateStatus(
    evidenceId,
    {
      status,
      approvedById: approved ? ctx.userId : null,
      approvedAt: approved ? new Date() : null,
    },
    tx,
  );
}

export const acceptanceEvidenceService = {
  /**
   * Mint scoped CLIENT upload tokens (MOTIR-1681) so a trusted CI job uploads the
   * acceptance video (+ trace) DIRECTLY to the private store, bypassing the
   * ~4.5MB serverless body cap. Each token is bound to one exact pathname (under
   * the story's `acceptance/<ws>/<storyId>/` prefix), one contentType, and the
   * org's per-file cap. CI then registers the pathnames via `recordFromPathnames`.
   */
  async createUploadTokens(
    input: { workItemId: string; hasTrace: boolean },
    ctx: ServiceContext,
  ): Promise<AcceptanceUploadTokensDTO> {
    const story = await resolveStory(input.workItemId, ctx);
    const { perFileLimit } = await resolveCostContext(ctx.workspaceId);
    const prefix = acceptancePrefix(ctx.workspaceId, story.id);
    const nonce = randomUUID();

    const videoPathname = `${prefix}${nonce}-acceptance.webm`;
    const video: AcceptanceUploadTargetDTO = {
      pathname: videoPathname,
      token: await mintPrivateUploadToken(videoPathname, {
        contentType: 'video/webm',
        maxBytes: perFileLimit,
      }),
      contentType: 'video/webm',
      // Tell the caller the cap it is bound by (MOTIR-1911) — otherwise the only
      // way to learn it is to exceed it and read @vercel/blob's opaque error.
      maxBytes: perFileLimit,
    };

    let trace: AcceptanceUploadTargetDTO | null = null;
    if (input.hasTrace) {
      const tracePathname = `${prefix}${nonce}-trace.zip`;
      trace = {
        pathname: tracePathname,
        token: await mintPrivateUploadToken(tracePathname, {
          contentType: 'application/zip',
          maxBytes: perFileLimit,
        }),
        contentType: 'application/zip',
        maxBytes: perFileLimit,
      };
    }
    return { video, trace };
  },

  /**
   * Register acceptance artifacts already CLIENT-uploaded to the private store
   * (MOTIR-1681), superseding the prior current evidence. The caller reports only
   * pathnames; the server (a) rejects any pathname OUTSIDE the story's acceptance
   * prefix and (b) `head`s each blob for its AUTHORITATIVE size + contentType —
   * so a lying/cross-tenant/absent pathname can never be recorded.
   */
  async recordFromPathnames(
    input: RecordFromPathnamesInput,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    const story = await resolveStory(input.workItemId, ctx);

    // AFTER the access gate, so a caller who cannot see the story still gets the
    // 404-not-403 answer rather than learning its citation was malformed.
    const commitSha = normalizeReceiptCommitSha(input.commitSha);

    const idempotent = await findIdempotentExisting(story.id, commitSha, input.producedByKey, ctx);
    if (idempotent) return idempotent;

    // SECURITY: every reported pathname MUST live under this story's acceptance
    // prefix (reject an arbitrary or cross-tenant blob before any DB write).
    const prefix = acceptancePrefix(ctx.workspaceId, story.id);
    if (!input.videoPathname.startsWith(prefix)) {
      throw new AcceptanceEvidencePathnameError(input.videoPathname);
    }
    if (input.tracePathname && !input.tracePathname.startsWith(prefix)) {
      throw new AcceptanceEvidencePathnameError(input.tracePathname);
    }

    // head() → the blob must EXIST (the client upload completed) and its size +
    // contentType are read from the store, never trusted from the caller.
    const videoHead = await headPrivateBlob(input.videoPathname);
    if (!videoHead) throw new AcceptanceEvidenceBlobMissingError(input.videoPathname);
    if (!isAllowedAcceptanceVideoType(videoHead.contentType)) {
      throw new UnsupportedFileTypeError(videoHead.contentType);
    }

    const { organizationId, perFileLimit } = await resolveCostContext(ctx.workspaceId);
    if (videoHead.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
    if (organizationId) {
      await entitlementsService.assertWithinStorageCap(organizationId, videoHead.size);
    }

    let trace: ArtifactMeta | null = null;
    if (input.tracePathname) {
      const traceHead = await headPrivateBlob(input.tracePathname);
      if (!traceHead) throw new AcceptanceEvidenceBlobMissingError(input.tracePathname);
      trace = {
        pathname: input.tracePathname,
        contentType: traceHead.contentType,
        size: traceHead.size,
        filename: blobFilename(input.tracePathname),
      };
    }

    const row = await persistEvidence(
      {
        story,
        video: {
          pathname: input.videoPathname,
          contentType: videoHead.contentType,
          size: videoHead.size,
          filename: blobFilename(input.videoPathname),
        },
        trace,
        chapters: input.chapters ?? [],
        commitSha,
        ciRunUrl: input.ciRunUrl ?? null,
        producedByKey: input.producedByKey ?? null,
      },
      ctx,
    );
    return toAcceptanceEvidenceDto(row);
  },

  /**
   * Record a new acceptance video for a story from an in-memory File (the
   * server-proxied path — used by tests/seeds and any small-file caller),
   * superseding any prior current evidence. Blob puts happen OUTSIDE the
   * transaction (the side-effects rule); the supersede + rows commit atomically.
   */
  async recordFromUpload(
    input: RecordAcceptanceVideoInput,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    const story = await resolveStory(input.workItemId, ctx);

    // AFTER the access gate — see `recordFromPathnames` for the ordering.
    const commitSha = normalizeReceiptCommitSha(input.commitSha);

    const idempotent = await findIdempotentExisting(story.id, commitSha, input.producedByKey, ctx);
    if (idempotent) return idempotent;

    // MIME gate — the acceptance-scoped allowlist (video is 415 elsewhere).
    if (!isAllowedAcceptanceVideoType(input.video.type)) {
      throw new UnsupportedFileTypeError(input.video.type);
    }

    // Cost bounds — per-file + total-storage caps (both no-op off-cloud).
    const { organizationId, perFileLimit } = await resolveCostContext(ctx.workspaceId);
    if (input.video.size > perFileLimit) throw new FileTooLargeError(perFileLimit);
    if (organizationId) {
      await entitlementsService.assertWithinStorageCap(organizationId, input.video.size);
    }

    // Blob puts OUTSIDE the transaction — PRIVATE store (MOTIR-1667).
    const prefix = acceptancePrefix(ctx.workspaceId, story.id);
    const { pathname: videoPathname } = await putPrivateAttachment(
      `${prefix}${input.video.name}`,
      input.video,
      input.video.type,
    );
    let trace: ArtifactMeta | null = null;
    if (input.trace) {
      const { pathname } = await putPrivateAttachment(
        `${prefix}trace-${input.trace.name}`,
        input.trace,
        input.trace.type,
      );
      trace = {
        pathname,
        contentType: input.trace.type,
        size: input.trace.size,
        filename: input.trace.name,
      };
    }

    const row = await persistEvidence(
      {
        story,
        video: {
          pathname: videoPathname,
          contentType: input.video.type,
          size: input.video.size,
          filename: input.video.name,
        },
        trace,
        chapters: input.chapters ?? [],
        commitSha,
        ciRunUrl: input.ciRunUrl ?? null,
        producedByKey: input.producedByKey ?? null,
      },
      ctx,
    );
    return toAcceptanceEvidenceDto(row);
  },

  /** The current acceptance evidence for a story, as a DTO (null if none yet). */
  async getCurrentForStory(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => acceptanceEvidenceRepository.findCurrentByWorkItem(workItemId, tx),
    );
    return row ? toAcceptanceEvidenceDto(row) : null;
  },

  /**
   * The receipt an `acceptance_result` gate ASKS ABOUT, read by the gate's own
   * `subjectId` (MOTIR-4950) — the approval overlay's acceptance port. Never the
   * story's CURRENT receipt: a decided gate shows the recording that was decided
   * on, and a republish makes a different row current. Scoped to the gate's work
   * item so a subject id from another story resolves to nothing.
   */
  async getForGateSubject(
    input: { workItemId: string; subjectId: string },
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO | null> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => acceptanceEvidenceRepository.findById(input.subjectId, tx),
    );
    return row && row.workItemId === input.workItemId ? toAcceptanceEvidenceDto(row) : null;
  },

  /**
   * Set the acceptance status of one evidence row. `approved` stamps the actor
   * + timestamp (the audit trail behind the `in_review → done` gate the panel /
   * gate-transition card drives); any other status clears the stamp.
   */
  async setStatus(
    evidenceId: string,
    status: AcceptanceEvidenceStatusDTO,
    ctx: ServiceContext,
  ): Promise<AcceptanceEvidenceDTO> {
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const existing = await acceptanceEvidenceRepository.findById(evidenceId, tx);
        if (!existing) throw new AcceptanceEvidenceNotFoundError(evidenceId);
        return stampStatus(evidenceId, status, ctx, tx);
      },
    );
    return toAcceptanceEvidenceDto(row);
  },

  // ⚠️ `decide` WAS HERE (Story MOTIR-1627 · Subtask MOTIR-1634) and is RETIRED
  // (MOTIR-4950). It flipped the story `in_review → done | in_progress` through its own
  // path, so an acceptance decision was invisible to the Approvals tab, skipped
  // `approved` and ignored the manual-flip guard. The decision now goes through the
  // one gate contract: `acceptanceResultGateHandler` (`lib/approvalGates/`) stamps the
  // receipt under the same lock (MOTIR-2851) and writes the status the MOTIR-5787
  // amendment's point 7 records.
};
