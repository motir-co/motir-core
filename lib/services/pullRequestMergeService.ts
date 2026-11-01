import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type {
  ChangeRequestMergeability,
  GitProviderId,
  MergeChangeRequestResult,
  MergeRefusalCode,
} from '@/lib/git/types';
// ⚠️ The MEMBER SPELLING, not a merge gate: `owner/name#number@headSha` is how the
// surviving approval gate names each of its members, so the pull request's version now
// and the version the card was approved at are comparable (MOTIR-5613). It lives beside
// the set version since MOTIR-5616 retired the handler it was written in.
import { pullRequestSubjectVersion } from '@/lib/approvalGates/deliverySetVersion';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateAlreadyRequeuedError,
  ApprovalGateError,
  ApprovalGateMergeRefusedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
  type MergeConflictMember,
  type MergeRefusalTag,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { githubPullRequestMergeRefusalRepository } from '@/lib/repositories/githubPullRequestMergeRefusalRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { OUT_OF_DATE_MERGEABLE_STATE } from '@/lib/github/mergeability';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { toGateRefusal, type GateRefusal } from '@/lib/approvalGates/refusals';
import { unlandedOutcomeOutranksApproval } from '@/lib/approvalGates/gateSet';
import { classOfMergeRefusal, classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import { membersOf, type MemberVersion } from '@/lib/approvalGates/memberVersion';
import type {
  ApproveAndMergeMemberOutcomeDTO,
  PullRequestApprovalMemberDTO,
} from '@/lib/dto/approvalGate';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { pullRequestHead } from '@/lib/github/pullRequestHead';
import { QueueAgainRefusedError } from '@/lib/mergeQueue/errors';
import { sendEvent } from '@/lib/jobs/sendEvent';
import type { GithubPullRequestQueueExit } from '@/generated/prisma/client';
import type { PullRequestStandingExitDTO } from '@/lib/dto/approvalGate';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { projectAccessService } from './projectAccessService';
import { queueExitCardMoves, settleUnlandedOutcome } from './mergeQueueExitService';
import { pullRequestMergeabilityService } from './pullRequestMergeabilityService';
import {
  pullRequestApprovalMembersService,
  toQueueExitDto,
} from './pullRequestApprovalMembersService';
import {
  approvalGatesService,
  resolveGateAuthority,
  type DecideGateInput,
  type DecideGateResult,
} from './approvalGatesService';
import { settleAfterPrimaryApproval } from './ciPromotion';
import { requireGateCard } from '@/lib/approvalGates/gateCard';
import { recomputeWorkItemFixReason } from './fixReasonService';

// THE MERGE ENTRY POINT (Story MOTIR-4882 · MOTIR-5517 · MOTIR-5613; `approval-gates.md`
// §8's SECOND AMENDMENT, decisions 4 and 6) — the one path by which an approved card's
// pull requests are MERGED, or enqueued.
//
// ⚠️ IT IS KEYED ON (THE CARD'S OWN GATE, ONE PULL REQUEST) — never on a gate of its own.
// Until MOTIR-5611 each pull request carried a `pull_request_merge` gate and a merge was
// addressed by that gate's id. There is now ONE gate per card, so a merge is addressed by
// the card's approved `pull_request_approval` gate plus the pull request being merged, and
// nothing here needs a merge-gate row to exist.
//
// ⚠️ THE ORDER IS THE WHOLE DESIGN: CHECK, MERGE, THEN RECORD.
//
//   1. the member is CHECKED — the card's gate is approved and decidable by this actor,
//      and the pull request is still delivered by the card, still open and still at the
//      head the gate was approved at. A member that no longer answers that description is
//      `stale`: the question was withdrawn, and no host is called;
//   2. the seam is called OUTSIDE ANY TRANSACTION;
//   3. the outcome is recorded on the PULL REQUEST (`merge_authority` / `merge_outcome_ref`),
//      which is where it belonged all along — a fact about a pull request, not about a gate.
//
// ⚠️ ONE APPROVAL AUTHORIZES ONE MERGE OR ENQUEUE ACTION (§4 FOURTH AMENDMENT, points 1
// and 8; MOTIR-5802 · MOTIR-5833 · MOTIR-5834). The card's gate is decided when the
// person presses *Approve and merge*, and the merge that follows CARRIES THAT DECISION
// OUT — once. A host refusal is recorded on the pull request and SPENDS the approval, so
// the card is asked again by class, and the row's *Retry merge* decides THAT fresh gate
// rather than re-pressing the old one. §8's *"a retry is step (b) for that one gate
// alone. The approval stands above it."* is struck: it is the same shortcut as *Queue
// again*, one door over.

/** The one gate a merge now carries out — the card's own (MOTIR-5611). */
const APPROVAL_KIND = 'pull_request_approval' as const;

/**
 * That gate's PERMISSION FLOOR, `pullRequestApprovalGateHandler.permission`.
 *
 * ⚠️ COPIED, NOT IMPORTED, AND THAT IS DELIBERATE. `pullRequestApprovalHandler` imports
 * `workItemsService` for its status write, so importing it here evaluates that handler
 * BEFORE `approvalGatesService` pulls in the registry — and the registry then records
 * `undefined` for the kind still mid-evaluation, which fails every status transition in
 * the process. It is the module cycle `deliverySetVersion.ts` exists to avoid, reached
 * from the other side. `tests/github/pullRequestMergeEntry.test.ts` pins this constant to
 * the handler's own value, so the copy cannot drift.
 */
export const APPROVAL_MERGE_PERMISSION = 'work_item:edit' as const;

/** The seam's refusal, one to one onto the gate refusal a person is shown (MOTIR-5512).
 *  `subject_changed` is absent on purpose: it makes a member stale, it does not refuse. */
const REFUSAL_TAG: Record<Exclude<MergeRefusalCode, 'subject_changed'>, MergeRefusalTag> = {
  checks_not_green: 'MERGE_CHECKS_NOT_GREEN',
  conflict: 'MERGE_CONFLICT',
  out_of_date: 'MERGE_OUT_OF_DATE',
  branch_protected: 'MERGE_BRANCH_PROTECTED',
  already_merged: 'MERGE_ALREADY_MERGED',
  app_permission_missing: 'MERGE_APP_PERMISSION_MISSING',
};

interface MergeTarget {
  pullRequestId: string;
  workItemId: string;
  provider: GitProviderId;
  installationId: string;
  owner: string;
  name: string;
  number: number;
  expectedHeadSha: string;
}

/**
 * STEP 1 — everything decided before a host is called, asked about ONE member of the card's
 * approved gate. Refusals the door itself would give are thrown here with the door's own
 * errors, so a press that cannot be honoured never reaches GitHub. A member whose pull
 * request has moved, closed or left the card answers `stale`, and NOTHING is written: the
 * card's gate is already decided and there is no per-member question left to withdraw.
 */
async function checkMember(
  args: { approvalGateId: string; member: MemberVersion },
  ctx: ServiceContext,
): Promise<
  { kind: 'mergeable'; target: MergeTarget; approvalDecidedAt: Date | null } | { kind: 'stale' }
> {
  const { approvalGateId, member } = args;
  return withWorkspaceContext(ctx, async (tx) => {
    const gate = await approvalGateRepository.findById(approvalGateId, tx);
    if (!gate || gate.kind !== APPROVAL_KIND) throw new ApprovalGateNotFoundError(approvalGateId);
    const item = await workItemRepository.findById(
      requireGateCard(gate, 'pullRequestMergeService'),
      tx,
    );
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new ApprovalGateNotFoundError(approvalGateId);
    }

    // The door's two actor checks, in the door's order: the kind's floor, then §2's
    // relationship. A merge carries out a decision, so the actor who may carry it out is
    // the actor who could have made it.
    await projectAccessService.assertPermission(item.projectId, ctx, APPROVAL_MERGE_PERMISSION, tx);
    if (!(await resolveGateAuthority(item, ctx, tx))) {
      throw new ApprovalGateNotAuthorisedError(approvalGateId);
    }

    if (gate.state === 'superseded')
      throw new ApprovalGateSupersededError(approvalGateId, gate.supersededCause);
    // A merge only ever follows an APPROVAL: changes requested on the set merges none of it.
    if (gate.state === 'changes_requested') {
      throw new ApprovalGateAlreadyDecidedError(
        approvalGateId,
        gate.state,
        gate.decidedById,
        gate.decidedAt,
        gate.decidedByLabel,
      );
    }
    // `awaiting` means nobody has decided anything yet, so there is no decision to carry
    // out. Both callers commit or verify the approval before they reach here, so this is a
    // programming error rather than a refusal a person should be shown.
    if (gate.state !== 'approved') {
      throw new Error(`a merge was attempted under an ${gate.state} gate (${approvalGateId})`);
    }

    // The member must still be one of THIS card's deliveries — a pull request unlinked
    // after the approval is no longer covered by it.
    const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(
      requireGateCard(gate, 'pullRequestMergeService'),
      tx,
    );
    const delivery = deliveries.find(
      (row) =>
        `${row.repo.owner}/${row.repo.name}` === member.repo &&
        row.pullRequest.number === member.number,
    );
    if (!delivery) return { kind: 'stale' };

    const pr = await githubPullRequestRepository.findByIdWithInstallation(
      delivery.pullRequest.id,
      tx,
    );
    // …and it must still be the SAME COMMITS the card was approved at.
    const current = pr ? pullRequestSubjectVersion(pr) : null;
    if (!pr || pr.state !== 'open' || pr.merged || current !== member.subjectVersion) {
      return { kind: 'stale' };
    }

    return {
      kind: 'mergeable',
      approvalDecidedAt: gate.decidedAt,
      target: {
        pullRequestId: pr.id,
        workItemId: requireGateCard(gate, 'pullRequestMergeService'),
        provider: pr.repo.provider as GitProviderId,
        installationId: pr.repo.installation.installationId,
        owner: pr.repo.owner,
        name: pr.repo.name,
        number: pr.number,
        // The head the card was approved on.
        expectedHeadSha: member.headSha,
      },
    };
  });
}

/** One member of an approve-and-merge press, and what happened to it (MOTIR-5483) — the
 *  DTO the Development frame reads it as (MOTIR-5484). */
export type ApproveAndMergeMemberOutcome = ApproveAndMergeMemberOutcomeDTO;

/** The press's answer: the approval, which stands in every case, and every member's outcome. */
export interface ApproveAndMergeResult {
  approval: DecideGateResult;
  members: ApproveAndMergeMemberOutcome[];
}

/**
 * MERGE OR ENQUEUE ONE checked member — steps 2 and 3, with no transaction open across the
 * host call and nothing decided afterwards.
 *
 * Throws `ApprovalGateMergeRefusedError` for a host refusal (nothing is written),
 * `ApprovalGateSupersededError` when the host reports the head moved under us, and
 * `MergeChangeRequestError` when the host did not answer at all.
 */
async function mergeOrEnqueue(
  approvalGateId: string,
  target: MergeTarget,
  ctx: ServiceContext,
): Promise<'merged' | 'enqueued'> {
  const provider = getGitProvider(target.provider);
  // A card only reaches an approve-to-merge gate when every member is a merge candidate
  // (`raisePullRequestApprovalGate`), so a provider without the capability here is a
  // programming error, not a refusal.
  if (!providerSupportsMerge(provider)) {
    throw new Error(
      `a ${target.provider} pull request is a member of an approved gate (${approvalGateId})`,
    );
  }
  let result: MergeChangeRequestResult;
  try {
    result = await provider.mergeChangeRequest({
      installationId: target.installationId,
      owner: target.owner,
      name: target.name,
      number: target.number,
      expectedHeadSha: target.expectedHeadSha,
    });
  } catch (err) {
    if (err instanceof MergeChangeRequestError) {
      console.error(
        '[pullRequestMergeService] the host did not answer the merge; nothing recorded',
        {
          approvalGateId,
          pullRequestId: target.pullRequestId,
          reason: err.reason,
        },
      );
    }
    throw err;
  }

  if (result.outcome === 'refused') {
    // A head that moved between the check and the merge (the host's 409) is the same
    // withdrawn question step 1 would have found. NOTHING is recorded: the approval
    // was never acted on, so it was not spent (§4 FOURTH AMENDMENT, point 2).
    if (result.refusal.code === 'subject_changed') {
      throw new ApprovalGateSupersededError(approvalGateId);
    }
    // ⚠️ THE REFUSAL IS RECORDED, AND THE CARD IS SETTLED BY ITS CLASS (point 5;
    // MOTIR-5833). One approval authorizes ONE attempt, and this one did not land —
    // so the fact has to outlive this response, and the card must stop claiming an
    // approval it has already spent.
    await recordMergeRefusal(approvalGateId, target, result.refusal, ctx);
    throw new ApprovalGateMergeRefusedError(approvalGateId, REFUSAL_TAG[result.refusal.code], {
      permission: result.refusal.permission ?? null,
      reason: result.refusal.reason ?? null,
    });
  }

  // STEP 3 — the outcome, on the PULL REQUEST. No gate is decided by a merge any more.
  await withWorkspaceContext(ctx, async (tx) => {
    await githubPullRequestRepository.recordMotirMerge(
      target.pullRequestId,
      {
        mergeAuthority: 'gate',
        mergeOutcomeRef: result.outcome === 'merged' ? result.commitSha : `queue:${result.entryId}`,
      },
      tx,
    );
    // This press LANDED, so any refusal the pull request still carried is history —
    // the head is unchanged, so nothing else would retire it (MOTIR-5833).
    await githubPullRequestMergeRefusalRepository.supersedeStanding(
      target.pullRequestId,
      new Date(),
      tx,
    );
  });
  return result.outcome;
}

/**
 * A decision as a surface records it: what the door decided, plus every member the decision
 * MERGED (MOTIR-5624). `members` is empty for every decision that merges nothing — any
 * `request_changes`, and an `approve` on a kind that is not the approve-to-merge gate.
 */
export interface DecideGateWithMergeResult extends DecideGateResult {
  members: ApproveAndMergeMemberOutcome[];
}

export const pullRequestMergeService = {
  /**
   * EVERY decision a surface records enters here — the decide route and the item page's
   * decide action both call it rather than the door (MOTIR-5517).
   *
   * ⚠️ AN APPROVE ON THE APPROVE-TO-MERGE GATE IS {@link approveAndMerge}, WHATEVER DOOR IT
   * CAME THROUGH (MOTIR-5624; `approval-gates.md` §8's THIRD AMENDMENT). MOTIR-5613 made this
   * a straight pass-through because no kind merges BEFORE it is decided — true about ORDER,
   * and it left the REST route approving the card's one gate while merging nothing, with no
   * gate left for anyone to press. `approveAndMerge` decides FIRST and merges after, so the
   * order 5613 protected still holds; what this restores is that every door to the same gate
   * means the same thing. Every other decision reaches the door unchanged.
   *
   * ⚠️ AND AN APPROVE ON A DESIGN GATE IS THE PRIMARY PRESS, WHATEVER DOOR IT CAME THROUGH
   * (Bug MOTIR-5712; `design-result.md` AMENDMENT 6 Q1 and Q4). The same argument one kind
   * over: the item page's frame already pressed the design gate through
   * {@link approveAndMerge}, so one press decided the design AND the merge it carries — while
   * the full-screen overlay (opened from the To-approve row) and the REST route reached the
   * plain door, decided the design alone, and left the merge gate for a SECOND press Q4
   * forbids. Once the queue lists that card by its design gate only, this is the one press
   * it offers, so it has to mean what the frame's press means. A design gate with no merge
   * gate beside it decides exactly as before: `approvePrimaryAndMerge` finds no companion and
   * merges nothing.
   */
  async decideGate(
    input: DecideGateInput,
    ctx: ServiceContext,
  ): Promise<DecideGateWithMergeResult> {
    if (input.decision === 'approve') {
      // Routing only: the door re-reads everything the decision turns on under its own lock.
      const gate = await withWorkspaceContext(ctx, (tx) =>
        approvalGateRepository.findById(input.gateId, tx),
      );
      if (gate?.kind === APPROVAL_KIND) {
        const { approval, members } = await approveAndMergeGate(input, ctx);
        return { ...approval, members };
      }
      if (gate && isPrimaryKind(gate.kind)) {
        const { approval, members } = await approvePrimaryAndMerge(input, ctx);
        return { ...approval, members };
      }
    }
    return { ...(await approvalGatesService.decide(input, ctx)), members: [] };
  },

  /**
   * The approve-and-merge set as the Development frame draws it on a READ (Story MOTIR-4909 ·
   * MOTIR-5484 · MOTIR-5613): each member of one APPROVED `pull_request_approval` gate, with
   * the facts a reload still has once the press's response is gone —
   *
   *   · the PULL REQUEST the member names, while the card still delivers it;
   *   · whether the press QUEUED it — the pull request carries a `queue:` outcome and has not
   *     merged — so the row reads *Queued to merge* for as long as that is true;
   *   · whether a RETRY is offered, which is now a fact about the pull request rather than
   *     about a second gate: the approval stands, and this member has no merge outcome yet.
   *
   * ⚠️ NO REFUSAL REASON: the press does not persist one. Empty for a gate that is not an
   * approved approval gate on this card.
   */
  async listApprovalMembers(
    input: { workItemId: string; approvalGateId: string },
    ctx: ServiceContext,
  ): Promise<PullRequestApprovalMemberDTO[]> {
    return pullRequestApprovalMembersService.listForGate(input, ctx);
  },

  /**
   * The standing merge-queue exits of a card in an `auto` project (MOTIR-5635; design § 22,
   * E5) — the read the Development block draws *Left the queue* and *Queue again* from when
   * there is no approval frame. READ-ONLY. A `manual` project reads its exits through
   * {@link listApprovalMembers}, on its decided gate, so this answers nothing there.
   * `requeueable` is exactly what {@link requeueAutoMember} accepts: open, the exit not put
   * back, and the head the latest checks ran at still the one it left at.
   */
  async listStandingQueueExits(
    input: { workItemId: string },
    ctx: ServiceContext,
  ): Promise<PullRequestStandingExitDTO[]> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(input.workItemId, tx);
      if (!item || item.workspaceId !== ctx.workspaceId) return [];
      const mode = await projectRepository.findPrMergeMode(item.projectId, tx);
      if (mode?.prMergeMode !== 'auto') return [];
      const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
      const exits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
        deliveries.map((row) => row.pullRequest.id),
        tx,
      );
      return deliveries.flatMap((row) => {
        const pr = row.pullRequest;
        const exit = exits.get(pr.id);
        const open = pr.state === 'open' && !pr.merged;
        if (!exit || exit.requeuedAt !== null || !open) return [];
        const head = pullRequestHead(pr) ?? undefined;
        return [
          {
            pullRequestId: pr.id,
            repo: `${row.repo.owner}/${row.repo.name}`,
            number: pr.number,
            exit: toQueueExitDto(exit),
            requeueable: head === exit.headSha,
          },
        ];
      });
    });
  },

  /**
   * APPROVE AND MERGE — the one press behind the approve-and-merge gate (Story MOTIR-4909 ·
   * MOTIR-5483 · MOTIR-5613; `approval-gates.md` §8's SECOND AMENDMENT, decisions 1 and 4).
   *
   * ⚠️ THE ORDER IS THE WHOLE DESIGN:
   *
   *   1. the card's ONE gate is decided first, through the ONE decide door, and the card moves
   *      `in_review → approved`. A refusal the door raises (not authorised, already decided,
   *      superseded) ends the press here, and nothing is merged or queued;
   *   2. AFTER that commit, each member of the approved set — in `subjectVersion`'s canonical
   *      order — is merged or enqueued by the entry point above, and its outcome recorded on
   *      its own pull request. This method never names a host.
   *
   * EVERY member is attempted: a refusal on one does not stop the next, because the approval
   * covers all of them. The approval stands whatever the merges do, and the result reports each
   * member — `merged`, `enqueued`, `refused` with its typed refusal, or `no_merge_gate` when the
   * member is no longer a pull request this card delivers at that head.
   */
  async approveAndMerge(
    input: Omit<DecideGateInput, 'decision'>,
    ctx: ServiceContext,
  ): Promise<ApproveAndMergeResult> {
    const gate = await withWorkspaceContext(ctx, (tx) =>
      approvalGateRepository.findById(input.gateId, tx),
    );
    // ⚠️ `design_result` IS ADMITTED BY NAME (Story MOTIR-5652 · Subtask MOTIR-5664;
    // `design-result.md` AMENDMENT 6 Q1), never by deleting the guard. The guard is what
    // stops a gate of some future kind merging things by accident, and a kind admitted
    // by name is a decision somebody made — a guard deleted is a decision nobody will
    // remember making.
    // `decision_approval` and `acceptance_result` are admitted the same way, by name,
    // for the same reason (Story MOTIR-4907 · MOTIR-5677, `approval-gates.md` §8's FIFTH
    // AMENDMENT clause 5; Story MOTIR-4949 · MOTIR-5789, §1's MOTIR-5787 amendment).
    if (gate && isPrimaryKind(gate.kind)) return approvePrimaryAndMerge(input, ctx);
    if (gate && gate.kind !== APPROVAL_KIND) {
      throw new Error(`approveAndMerge was handed a ${gate.kind} gate (${input.gateId})`);
    }
    return approveAndMergeGate(input, ctx);
  },

  /**
   * THE PULL-REQUEST ROW'S VERB — *Retry merge* on a refused member, *Queue again* on one the
   * merge queue removed (MOTIR-5613 · MOTIR-5634), addressed by (a gate, the pull request).
   *
   * ⚠️ WHICH GATE IT IS HANDED DECIDES WHAT THE PRESS MEANS (MOTIR-5802 · MOTIR-5834;
   * §4 FOURTH AMENDMENT, points 1, 4 and 8):
   *
   *  · an `awaiting` gate — the RE-ASKED one — means the press IS the new approval. It goes
   *    through {@link approveAndMergeGate}, the same path the frame's *Approve and merge*
   *    takes, so the row's button and the frame's verb are one decision with one guard. The
   *    reader's `stamp` is carried into it and the stale check is the door's own;
   *  · a DECIDED gate means the press carries out a decision already made — the shipped
   *    retry. It is refused (`MERGE_REQUEUE_NEEDS_APPROVAL`) the moment that approval has
   *    been SPENT on an outcome that did not land, which is what point 1 forbids: a queue
   *    exit standing at that head, or a host refusal recorded at it (MOTIR-5833). A
   *    CAN'T-LAND outcome is refused with its own reason instead, because no approval,
   *    however fresh, can land those commits — `motir fix` is the way forward.
   *
   * The pull request must still be a member of the gate at the head it names — otherwise
   * this is a withdrawn question, refused with the door's own error rather than re-asked.
   */
  async retryApproveAndMergeMember(
    input: Omit<DecideGateInput, 'decision' | 'gateId'> & {
      approvalGateId: string;
      pullRequestId: string;
    },
    ctx: ServiceContext,
  ): Promise<ApproveAndMergeMemberOutcome> {
    const found = await withWorkspaceContext(ctx, async (tx) => {
      const approval = await approvalGateRepository.findById(input.approvalGateId, tx);
      if (!approval || approval.kind !== APPROVAL_KIND) {
        throw new ApprovalGateNotFoundError(input.approvalGateId);
      }
      // THE RE-ASKED GATE: the press is the new approval, and nothing below applies — the
      // whole set is decided and acted on by the one door (point 4).
      if (approval.state === 'awaiting') return { reask: true as const };
      // Each non-approved state gets the refusal that is TRUE of it: a withdrawn question
      // is superseded, and changes requested is a decision that merges nothing.
      if (approval.state === 'superseded') {
        throw new ApprovalGateSupersededError(input.approvalGateId);
      }
      if (approval.state === 'changes_requested') {
        throw new ApprovalGateAlreadyDecidedError(
          input.approvalGateId,
          approval.state,
          approval.decidedById,
          approval.decidedAt,
          approval.decidedByLabel,
        );
      }
      if (approval.state !== 'approved' || !approval.decidedAt) {
        throw new ApprovalGateNotFoundError(input.approvalGateId);
      }
      const delivered = (
        await workItemDeliveryRepository.listByWorkItemWithChecks(
          requireGateCard(approval, 'pullRequestMergeService'),
          tx,
        )
      ).find((row) => row.pullRequest.id === input.pullRequestId);
      if (!delivered) return null;
      // The member is matched by `owner/name#number`, so a pull request whose head has moved
      // since the approval is found here and goes stale in the check — not silently skipped.
      const member =
        membersOf(approval.subjectVersion).find(
          (candidate) =>
            candidate.repo === `${delivered.repo.owner}/${delivered.repo.name}` &&
            candidate.number === delivered.pullRequest.number,
        ) ?? null;
      if (!member) return null;
      const exit = (
        await githubPullRequestQueueExitRepository.findLatestByPullRequests(
          [delivered.pullRequest.id],
          tx,
        )
      ).get(delivered.pullRequest.id);
      // ⚠️ AND THE OTHER WAY THIS APPROVAL MAY ALREADY HAVE BEEN SPENT (MOTIR-5834): a
      // refusal the HOST gave at an earlier press, standing at the head this member
      // names. Before the refusal was recorded (MOTIR-5833) this door could not see it,
      // which is exactly why §8 let a retry ride on the standing approval.
      const refusal = (
        await githubPullRequestMergeRefusalRepository.findLatestByPullRequests(
          [delivered.pullRequest.id],
          tx,
        )
      ).get(delivered.pullRequest.id);
      const headNow = pullRequestHead(delivered.pullRequest) ?? undefined;
      return {
        member,
        workItemId: requireGateCard(approval, 'pullRequestMergeService'),
        approvalDecidedAt: approval.decidedAt,
        standingRefusal:
          refusal &&
          refusal.supersededAt === null &&
          headNow !== undefined &&
          refusal.headSha === headNow &&
          !delivered.pullRequest.merged
            ? refusal
            : null,
        standingExit: exit && exit.requeuedAt === null ? exit : null,
        // Already put back and still waiting in the queue: a second press would enqueue
        // it twice (MOTIR-5634).
        alreadyRequeued:
          exit !== undefined &&
          exit.requeuedAt !== null &&
          !delivered.pullRequest.merged &&
          (delivered.pullRequest.mergeOutcomeRef?.startsWith('queue:') ?? false),
        pullRequestId: delivered.pullRequest.id,
      };
    });
    // THE PRESS IS THE NEW APPROVAL (point 4): one decision, then every member acted on,
    // exactly as the frame's own verb does it. The row reports ITS member's outcome; a
    // member the decision no longer covers answers `no_merge_gate`, as it does there.
    if (found && 'reask' in found) {
      const { members } = await approveAndMergeGate(
        {
          gateId: input.approvalGateId,
          noteMd: input.noteMd,
          source: input.source,
          stamp: input.stamp,
        },
        ctx,
      );
      return (
        members.find((outcome) => outcome.pullRequestId === input.pullRequestId) ?? {
          subjectVersion: members[0]?.subjectVersion ?? '',
          pullRequestId: null,
          outcome: 'no_merge_gate',
        }
      );
    }
    // Not delivered by this card, or never a member of what was approved: there is no
    // question to carry out, and the card's gate is not re-asked.
    if (!found) throw new ApprovalGateSupersededError(input.approvalGateId);
    if (found.alreadyRequeued) {
      return {
        subjectVersion: found.member.subjectVersion,
        pullRequestId: found.pullRequestId,
        outcome: 'refused',
        refusal: toGateRefusal('MERGE_ALREADY_REQUEUED'),
      };
    }
    // ⚠️ §8's *RETRY MERGE ON THE STANDING APPROVAL* IS CLOSED (MOTIR-5834; §4 FOURTH
    // AMENDMENT, point 8). The host refused, so the approval that sent this pull request
    // has been SPENT: a retry under it would be the second act on one yes, which point 1
    // forbids. The refusal already asked the card again (MOTIR-5833) — press THAT gate.
    if (found.standingRefusal) {
      const landingClass = classOfMergeRefusal(found.standingRefusal.code);
      // The commits cannot land as they stand, so no approval, however fresh, re-presses
      // them: `motir fix` is the way forward (point 2).
      if (landingClass === 'cant_land') {
        return {
          subjectVersion: found.member.subjectVersion,
          pullRequestId: found.pullRequestId,
          outcome: 'refused',
          // `subject_changed` is never recorded, so every code that reaches here has a
          // tag; an unknown one (a second host) falls back to the generic refusal.
          refusal: toGateRefusal(
            REFUSAL_TAG[
              found.standingRefusal.code as Exclude<MergeRefusalCode, 'subject_changed'>
            ] ?? 'MERGE_REQUEUE_NEEDS_APPROVAL',
          ),
        };
      }
      if (
        unlandedOutcomeOutranksApproval(
          { at: found.standingRefusal.refusedAt },
          found.approvalDecidedAt,
        )
      ) {
        return {
          subjectVersion: found.member.subjectVersion,
          pullRequestId: found.pullRequestId,
          outcome: 'refused',
          refusal: toGateRefusal('MERGE_REQUEUE_NEEDS_APPROVAL'),
        };
      }
    }
    if (found.standingExit) {
      return queueAgainUnderApproval(
        input.approvalGateId,
        found.member,
        { workItemId: found.workItemId, exit: found.standingExit },
        ctx,
      );
    }
    return mergeMember(input.approvalGateId, found.member, ctx);
  },

  /**
   * QUEUE AGAIN in an `auto` project (Story MOTIR-5461 · MOTIR-5634; `approval-gates.md`
   * §4 THIRD AMENDMENT, decision 5). There is no approval to reuse — the project's
   * setting authorised the merge — so this is a PERSON's press that re-sends the
   * automatic merge for the SAME head the queue removed.
   *
   * ⚠️ THE SHIPPED DISPATCH IS KEYED `pullRequestId:headSha` (MOTIR-5518), which would
   * refuse the same head for ever. So the key carries the exit's id: once per exit, and
   * a second exit of the same head is a new key.
   *
   * In ONE transaction, under the card's row lock: the checks, the claim on the exit
   * (`requeuedAt`), and the card's return `implemented → in_review` — the status the
   * failure moved it from. The dispatch is sent after the commit.
   */
  async requeueAutoMember(
    input: { workItemId: string; pullRequestId: string },
    ctx: ServiceContext,
  ): Promise<{ pullRequestId: string; headSha: string; status: string }> {
    const now = new Date();
    const claimed = await withWorkspaceContext(ctx, async (tx) => {
      const found = await workItemRepository.findById(input.workItemId, tx);
      if (!found || found.workspaceId !== ctx.workspaceId) {
        throw new WorkItemNotFoundError(input.workItemId);
      }
      await projectAccessService.assertPermission(
        found.projectId,
        ctx,
        APPROVAL_MERGE_PERMISSION,
        tx,
      );
      const mode = await projectRepository.findPrMergeMode(found.projectId, tx);
      if (mode?.prMergeMode !== 'auto') {
        throw new QueueAgainRefusedError('wrong_mode', input.pullRequestId);
      }
      await queueExitCardMoves.lockCard(found.id, tx);
      const item = (await workItemRepository.findById(found.id, tx))!;

      const row = (await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx)).find(
        (candidate) => candidate.pullRequest.id === input.pullRequestId,
      );
      if (!row) throw new QueueAgainRefusedError('not_delivered', input.pullRequestId);
      const pr = row.pullRequest;
      if (pr.state !== 'open' || pr.merged) {
        throw new QueueAgainRefusedError('not_open', input.pullRequestId);
      }
      const exit = (
        await githubPullRequestQueueExitRepository.findLatestByPullRequests([pr.id], tx)
      ).get(pr.id);
      if (!exit) throw new QueueAgainRefusedError('no_exit', input.pullRequestId);
      if (exit.requeuedAt !== null) throw new ApprovalGateAlreadyRequeuedError(pr.id);
      const head = pullRequestHead(pr) ?? undefined;
      if (head !== exit.headSha) throw new QueueAgainRefusedError('head_moved', pr.id);
      if ((await githubPullRequestQueueExitRepository.claimRequeue(exit.id, now, tx)) === 0) {
        throw new ApprovalGateAlreadyRequeuedError(pr.id);
      }
      // The stamp lifts the queue failure from the card's `ciState` (MOTIR-5717).
      await queueExitCardMoves.recomputeDeliveredCiState(pr.id, tx);

      const moved = await queueExitCardMoves.returnCard(item, 'in_review', ctx, tx, {});
      return { item, exit, moved };
    });

    await sendEvent('pull-request/auto-merge.requested', {
      workspaceId: ctx.workspaceId,
      workItemId: claimed.item.id,
      pullRequestId: input.pullRequestId,
      headSha: claimed.exit.headSha,
      actorUserId: ctx.userId,
      idempotencyKey: `${input.pullRequestId}:${claimed.exit.headSha}:requeue:${claimed.exit.id}`,
    });
    await queueExitCardMoves.emitMoved(claimed.item.id, claimed.moved, ctx);
    return {
      pullRequestId: input.pullRequestId,
      headSha: claimed.exit.headSha,
      status: claimed.moved?.toStatusKey ?? claimed.item.status,
    };
  },
};

/** The waits between asks while the host answers `mergeable: null` at the press (MOTIR-5915):
 *  two more asks, a second apart, then the press PROCEEDS as it always did (§ 30 rule 4). */
export const PRESS_READ_RETRY_WAITS_MS = [1_000, 1_000] as const;

/**
 * THE PRESS-TIME MERGEABILITY READ (MOTIR-5915, for bug MOTIR-5907; design/github § 30
 * rule 3, Panels 5a and 6).
 *
 * The approval commits in its own transaction BEFORE any merge is attempted (STEP 1 above),
 * so a conflict the merge discovers arrives after the card already read Approved — the
 * `in_review → approved → implemented` two seconds apart the bug reproduced. So each open
 * member is asked FIRST, outside any transaction (a network call never holds one open):
 *
 *  · `dirty` / `mergeable: false` → the reading is stored, the question is WITHDRAWN and the
 *    card held at Implemented through the one entry point the base-branch push also uses
 *    (`pullRequestMergeabilityService.settleReading`), and the press is refused
 *    `MERGE_CONFLICT` marked `atPress` — nothing was decided, so a reload shows the
 *    withdrawn frame, never the awaiting one;
 *  · `mergeable: null` → asked again {@link PRESS_READ_RETRY_WAITS_MS}, then the press
 *    PROCEEDS: "not computed" is never a conflict, and the post-merge classification still
 *    catches one that appears between this read and the merge;
 *  · a read that THROWS → the press proceeds on the same reasoning — a host that did not
 *    answer said nothing, and the merge path already turns a real refusal into a result.
 *
 * Only an AWAITING approve-to-merge gate is read for: a decided or superseded one is
 * refused by the decide door with its own true reason (Panel 5b's stale tab), and reading
 * the host first would only make that refusal slower.
 *
 * ⚠️ THIS IS THE DIRECT PRESS ONLY. A press on a PRIMARY that carries this gate with it is
 * read by {@link refusePrimaryPressOnConflict} (Bug MOTIR-7006), which ends in the same
 * {@link refuseIfMembersConflict}.
 */
async function refuseAtPressOnConflict(gateId: string, ctx: ServiceContext): Promise<void> {
  const target = await withWorkspaceContext(ctx, async (tx) => {
    const gate = await approvalGateRepository.findById(gateId, tx);
    if (!gate || gate.kind !== APPROVAL_KIND || gate.state !== 'awaiting') return null;
    // A PRIMARY question still awaiting (a design, a decision, an acceptance) refuses this
    // press by name in the decide door (MOTIR-5785) — and that refusal promises the host
    // was never called, so nothing here asks it either. The PRIMARY's own press is not
    // this one: it reads the host itself, before its decision (MOTIR-7006).
    const awaiting = await approvalGateRepository.findAwaitingByWorkItem(
      requireGateCard(gate, 'pullRequestMergeService'),
      tx,
    );
    if (awaiting.some((row) => isPrimaryKind(row.kind))) return null;
    return workItemDeliveryRepository.listByWorkItemWithChecks(
      requireGateCard(gate, 'pullRequestMergeService'),
      tx,
    );
  });
  if (target) await refuseIfMembersConflict(gateId, target, ctx);
}

/**
 * THE SAME READ, FOR A PRESS ON A PRIMARY (Bug MOTIR-7006; MOTIR-5915's promise, kept on
 * the press a person usually makes). A design, decision or acceptance gate whose card also
 * holds an AWAITING approve-to-merge gate decides that gate with it and merges — so a
 * conflicting member has to refuse THIS press before the primary is decided, or the card
 * reads Approved over a merge that can only fail.
 *
 * A conflict refuses the WHOLE press: the primary stays awaiting as well, because nothing
 * was decided. `settleReading` has withdrawn the merge gate and held the card at
 * Implemented, so a press once the conflict is resolved answers the primary over the
 * next green, the ordinary way.
 *
 * ⚠️ NO COMPANION, NO READ. With no awaiting merge gate the press merges nothing (the
 * merge is HELD, `design-result.md` AMENDMENT 6 Q4), and whether a primary may be
 * approved over a set that cannot land yet is the design / acceptance ADRs' question,
 * not this guard's. A primary that is not awaiting is refused by the decide door with
 * its own reason, so it is not read for either.
 */
async function refusePrimaryPressOnConflict(gateId: string, ctx: ServiceContext): Promise<void> {
  const target = await withWorkspaceContext(ctx, async (tx) => {
    const gate = await approvalGateRepository.findById(gateId, tx);
    if (!gate || !isPrimaryKind(gate.kind) || gate.state !== 'awaiting') return null;
    const card = requireGateCard(gate, 'pullRequestMergeService');
    const awaiting = await approvalGateRepository.findAwaitingByWorkItem(card, tx);
    if (!awaiting.some((row) => row.kind === APPROVAL_KIND)) return null;
    return workItemDeliveryRepository.listByWorkItemWithChecks(card, tx);
  });
  if (target) await refuseIfMembersConflict(gateId, target, ctx);
}

/** Ask the host about every open member of `deliveries`, settle each computed reading, and
 *  refuse the press on `gateId` with `MERGE_CONFLICT` `atPress` when any member conflicts. */
async function refuseIfMembersConflict(
  gateId: string,
  deliveries: Awaited<ReturnType<typeof workItemDeliveryRepository.listByWorkItemWithChecks>>,
  ctx: ServiceContext,
): Promise<void> {
  const conflicts: MergeConflictMember[] = [];
  for (const delivery of deliveries) {
    if (delivery.pullRequest.state !== 'open' || delivery.pullRequest.merged) continue;
    const reading = await readAtPress(delivery.githubPullRequestId);
    if (!reading) continue;
    const settled = await pullRequestMergeabilityService.settleReading(
      ctx.workspaceId,
      delivery.githubPullRequestId,
      reading,
    );
    if (settled.conflicted) {
      conflicts.push({
        pullRequest: `${delivery.repo.owner}/${delivery.repo.name}#${delivery.pullRequest.number}`,
        baseRef: delivery.pullRequest.baseRef,
      });
    }
  }
  if (conflicts.length > 0) {
    throw new ApprovalGateMergeRefusedError(gateId, 'MERGE_CONFLICT', { atPress: true, conflicts });
  }
}

/** One member's host answer at the press — asked again while it is `null`, and `null`
 *  (proceed) when the host will not say. */
async function readAtPress(pullRequestId: string): Promise<ChangeRequestMergeability | null> {
  for (let attempt = 0; ; attempt++) {
    let reading: ChangeRequestMergeability | null;
    try {
      reading = await pullRequestMergeabilityService.readFromHost(pullRequestId);
    } catch (err) {
      console.warn('[pullRequestMergeService] the press could not read mergeability; proceeding', {
        pullRequestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!reading || reading.mergeable !== null || reading.mergeableState === 'dirty')
      return reading;
    if (attempt >= PRESS_READ_RETRY_WAITS_MS.length) return null;
    await new Promise((resolve) => setTimeout(resolve, PRESS_READ_RETRY_WAITS_MS[attempt]));
  }
}

/**
 * The press's two steps, once the gate is known to be the approve-to-merge kind — shared by
 * {@link pullRequestMergeService.approveAndMerge} and the route's `decideGate` so the two
 * doors cannot drift apart again.
 */
async function approveAndMergeGate(
  input: Omit<DecideGateInput, 'decision'>,
  ctx: ServiceContext,
): Promise<ApproveAndMergeResult> {
  // STEP 0 — ASK THE HOST BEFORE ANYTHING IS WRITTEN (MOTIR-5915, for bug MOTIR-5907;
  // design/github § 30 rule 3). A member that cannot merge into its base refuses the press
  // here, so the card never passes through `approved` on a merge that could only fail.
  await refuseAtPressOnConflict(input.gateId, ctx);

  // STEP 1 — the approval, committed in the door's own transaction.
  const approval = await approvalGatesService.decide({ ...input, decision: 'approve' }, ctx);

  // STEP 2 — each member, after that commit, addressed by (this gate, its pull request).
  const members = await mergeApprovedSetMembers(input.gateId, approval.gate.subjectVersion, ctx);
  return { approval, members };
}

/**
 * THE PRIMARY PRESS — one press, two questions answered (Subtask MOTIR-5664;
 * `design-result.md` AMENDMENT 6 Q1, building Yue's sentence in AMENDMENT 4 Q8:
 * *"if there's linked PR, the PR and the design should show together in one section …
 * because they become one gate, approve the design will merge the PR too."*).
 *
 * A design card with commits has TWO questions with different lifetimes — *is this
 * design right?* is durable, *do these commits land?* is per attempt — and the design
 * gate is the one a person is presented with. Pressing it:
 *
 *  1. decides the DESIGN gate, in its own transaction, through the one decide door;
 *  2. decides the card's awaiting MERGE gate with the SAME `decidedAt`, so the two rows
 *     read as one person's decision at one instant (§8's amendment, decision 5(c) — the
 *     option the approve-and-merge press already uses for exactly this);
 *  3. merges or enqueues every member through {@link mergeApprovedSetMembers}, the
 *     shared path, after those decisions commit.
 *
 * ⚠️ NO SECOND MERGE PATH. `approveAndMerge` was re-keyed onto *(the card's own gate,
 * the pull request)* by MOTIR-5613 precisely so any approving kind could drive it; a
 * merge written for the design case would be the same duplication that produced two
 * gates on one card, one layer down.
 *
 * ⚠️ AND WHEN THERE IS NO MERGE GATE, THE MERGE IS HELD, NOT REFUSED (AMENDMENT 6 Q4).
 * The design gate rises on PUBLISH and the merge gate on GREEN, so the press can land
 * first. The decision stands, `members` comes back empty, and the merge follows on the
 * next green verdict with no second press — `settleGreenVerdict` carries it, because
 * the predicate has answered *no merge gate is owed* for the same reason.
 */
/**
 * The PRIMARY kinds — a question a person answers ABOVE the merge, whose one press also
 * decides the approve-to-merge gate beside it: the design (`design-result.md` AMENDMENT
 * 6), the decision (`approval-gates.md` §8's FIFTH AMENDMENT) and a story's acceptance
 * (§1's MOTIR-5787 amendment, point 2). Named, never inferred.
 */
const PRIMARY_KINDS: ReadonlySet<string> = new Set([
  'design_result',
  'decision_approval',
  'acceptance_result',
]);

function isPrimaryKind(kind: string): boolean {
  return PRIMARY_KINDS.has(kind);
}

async function approvePrimaryAndMerge(
  input: Omit<DecideGateInput, 'decision'>,
  ctx: ServiceContext,
): Promise<ApproveAndMergeResult> {
  // STEP 0 — ASK THE HOST BEFORE THE PRIMARY IS DECIDED (Bug MOTIR-7006), exactly as the
  // merge gate's own press does: this press decides that gate too.
  await refusePrimaryPressOnConflict(input.gateId, ctx);

  const approval = await approvalGatesService.decide({ ...input, decision: 'approve' }, ctx);

  const merge = await withWorkspaceContext(ctx, async (tx) =>
    (
      await approvalGateRepository.findAwaitingByWorkItem(
        requireGateCard(approval.gate, 'pullRequestMergeService'),
        tx,
      )
    ).find((row) => row.kind === APPROVAL_KIND),
  );
  if (!merge) {
    // ⚠️ NO COMPANION — THE MERGE IS HELD, AND IT MAY ALREADY BE OWED (Bug MOTIR-5762;
    // for a decision, MOTIR-5677 clause 6). In `manual` the set is simply not green yet and
    // the next green carries this approval (Q4). In `auto` no approve-to-merge gate is ever
    // raised, so a primary approved over a set that is ALREADY green would wait for a
    // verdict that never comes: settle the card now, the same way a green verdict would. A
    // request for changes never reaches here.
    await settleAfterPrimaryApproval(
      requireGateCard(approval.gate, 'pullRequestMergeService'),
      ctx,
    );
    return { approval, members: [] };
  }
  // ⚠️ ONLY THE MERGE GATE THE READER WAS SHOWN (Story MOTIR-5232 · MOTIR-5234). The
  // design decision's stamp covered the companion's version AS THE DOOR READ IT UNDER
  // ITS LOCK, and that transaction has committed. A push since then supersedes the
  // gate and a green raises a NEW one over commits nobody saw — deciding that one here
  // would merge them on the strength of a press about something else. So it is left
  // awaiting: a new question about new commits, asked the ordinary way.
  if (merge.subjectVersion !== approval.companionSubjectVersion) {
    return { approval, members: [] };
  }

  await approvalGatesService.decide(
    {
      gateId: merge.id,
      decision: 'approve',
      source: input.source,
      noteMd: null,
      // The companion of a press whose PRIMARY was just checked — its version is the
      // one that check covered (above), so nobody's page is compared twice.
      stamp: DECIDED_WITHOUT_A_READER,
    },
    ctx,
    // The DTO carries an ISO string; the option wants the instant.
    { decidedAt: approval.gate.decidedAt ? new Date(approval.gate.decidedAt) : undefined },
  );
  const members = await mergeApprovedSetMembers(merge.id, merge.subjectVersion, ctx);
  return { approval, members };
}

/**
 * STEP 2 OF THE PRESS, ON ITS OWN — merge or enqueue every member of a gate that has just
 * been approved, in the set's canonical order.
 *
 * ⚠️ EXPORTED FOR THE SYNCED PATH (Story MOTIR-4910 · MOTIR-5608; ADR §8 FOURTH AMENDMENT,
 * decision 6), and exported rather than re-implemented ON PURPOSE. A GitHub approval decides
 * the same gate a press decides, so it must merge the same way: same `expectedHeadSha`
 * check, same refusal union, same `recordMotirMerge` outcome on each pull request. A second
 * implementation would be a second set of answers to *what happened to this pull request?*,
 * and the Development frame reads only one.
 *
 * ⚠️ CALL IT ONLY AFTER THE DECISION HAS COMMITTED. It merges into somebody else's
 * repository; inside the deciding transaction it would hold the gate's row lock across a
 * network round trip, and a host failure would roll back an approval a person made.
 *
 * A per-member refusal is a RESULT, not a throw, so the next member is still attempted and
 * the approval stands either way.
 */
export async function mergeApprovedSetMembers(
  approvalGateId: string,
  subjectVersion: string | null,
  ctx: ServiceContext,
): Promise<ApproveAndMergeMemberOutcome[]> {
  const members: ApproveAndMergeMemberOutcome[] = [];
  for (const member of membersOf(subjectVersion)) {
    members.push(await mergeMember(approvalGateId, member, ctx));
  }
  return members;
}

/**
 * Merge or enqueue ONE member of an approved card through the entry point above, and turn a
 * refusal into a result rather than a throw — so the next member is still tried. An error
 * that is not a refusal of this member is rethrown.
 */
async function mergeMember(
  approvalGateId: string,
  member: MemberVersion,
  ctx: ServiceContext,
): Promise<ApproveAndMergeMemberOutcome> {
  let target: MergeTarget;
  try {
    const checked = await checkMember({ approvalGateId, member }, ctx);
    // ⚠️ `no_merge_gate` NO LONGER NAMES A GATE (MOTIR-5613). It is the member this card no
    // longer delivers at the head it was approved at — nothing to merge, and nothing
    // refused. The literal is kept so the frame's copy stays MOTIR-5615's to rename.
    if (checked.kind === 'stale') {
      return {
        subjectVersion: member.subjectVersion,
        pullRequestId: null,
        outcome: 'no_merge_gate',
      };
    }
    target = checked.target;
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: null,
      outcome: 'refused',
      refusal,
    };
  }

  // ⚠️ APPROVING THE RE-ASKED GATE RE-QUEUES AN EJECTED MEMBER (§4 FOURTH AMENDMENT,
  // point 3; MOTIR-5805). A member whose latest merge-queue exit still stands at the head
  // this approval names goes through the SAME path *Queue again* uses — claim the exit
  // (`requeuedAt`, which lifts the card's red and the promotion hold), merge or enqueue,
  // and release the claim if the host refuses — so the exit is stamped exactly once and
  // a refusal leaves it standing to retry. The approval post-dates the exit, so that
  // path's failure refusal does not fire.
  const standingExit = await withWorkspaceContext(ctx, async (tx) =>
    (
      await githubPullRequestQueueExitRepository.findLatestByPullRequests(
        [target.pullRequestId],
        tx,
      )
    ).get(target.pullRequestId),
  );
  if (
    standingExit &&
    standingExit.requeuedAt === null &&
    standingExit.headSha === target.expectedHeadSha
  ) {
    return queueAgainUnderApproval(
      approvalGateId,
      member,
      { workItemId: target.workItemId, exit: standingExit },
      ctx,
    );
  }

  try {
    const outcome = await mergeOrEnqueue(approvalGateId, target, ctx);
    return { subjectVersion: member.subjectVersion, pullRequestId: target.pullRequestId, outcome };
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    // ⚠️ THE APPROVAL STANDS AND NO GATE IS RE-RAISED (Subtask MOTIR-5666). A
    // refusal is news about the COMMITS, and the merge question comes back as
    // RETRY on the decision that already stands — §4's THIRD AMENDMENT decision 6,
    // which AMENDMENT 6 Q2 names as its own mechanism. Raising a fresh gate would
    // ask about commits somebody approved a moment ago. The DESIGN gate is
    // untouched for the same reason, and cannot be swapped underneath the standing
    // approval either (MOTIR-5661).
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: target.pullRequestId,
      outcome: 'refused',
      refusal,
    };
  }
}

/**
 * PUT AN EXITED MEMBER BACK IN THE QUEUE under an approval that COVERS the exit (Story
 * MOTIR-5461 · MOTIR-5634; narrowed to one act per approval by MOTIR-5802,
 * `approval-gates.md` §4 FOURTH AMENDMENT, points 1 and 4). The only approval that covers
 * an exit is one given AFTER it — the re-asked gate's own, which the row's verb or the
 * frame's *Approve and merge* has just decided. An exit that PRE-DATES nothing, i.e. one
 * standing against an older approval, is REFUSED here before anything is claimed, whatever
 * its disposition: a neutral removal spends the yes exactly as a failure does.
 *
 * ⚠️ THE CLAIM COMES BEFORE THE HOST CALL. Two presses on one exit must enqueue ONCE,
 * so the first stamps the exit's `requeuedAt` under the card's row lock and the second
 * finds it stamped. A host that refuses releases the stamp, so the exit is offered
 * again.
 *
 * ⚠️ IT MOVES NO CARD. A neutral removal never moved the card out of `approved`, so
 * there is nothing to return — and this was the last writer of `implemented → approved`,
 * which the FOURTH AMENDMENT removes from the workflow.
 */
async function queueAgainUnderApproval(
  approvalGateId: string,
  member: MemberVersion,
  args: { workItemId: string; exit: GithubPullRequestQueueExit },
  ctx: ServiceContext,
): Promise<ApproveAndMergeMemberOutcome> {
  let target: MergeTarget;
  let approvalDecidedAt: Date | null;
  try {
    const checked = await checkMember({ approvalGateId, member }, ctx);
    // A moved head: the approval no longer describes the code, so nothing is claimed.
    // The next green verdict raises the fresh question (decision 6).
    if (checked.kind === 'stale') throw new ApprovalGateSupersededError(approvalGateId);
    target = checked.target;
    approvalDecidedAt = checked.approvalDecidedAt;
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: null,
      outcome: 'refused',
      refusal,
    };
  }

  // ⚠️ NO EXIT IS RE-QUEUED ON AN APPROVAL GIVEN BEFORE IT — WHATEVER ITS DISPOSITION
  // (MOTIR-5802; `approval-gates.md` §4 FOURTH AMENDMENT, points 1 and 4). One approval
  // authorizes ONE enqueue: the pull request left the queue without landing, so that yes
  // has been used, and a NEUTRAL removal is no exception (Yue, 2026-09-19: *"re-ask
  // too"*). The card is asked again on a fresh gate, and approving THAT re-queues
  // (MOTIR-5805) — through this very function, whose approval then post-dates the exit.
  // Nothing is claimed or written. (A moved head was answered above: the approval no
  // longer describes the code.)
  if (unlandedOutcomeOutranksApproval({ at: args.exit.exitedAt }, approvalDecidedAt)) {
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: target.pullRequestId,
      outcome: 'refused',
      refusal: toGateRefusal('MERGE_REQUEUE_NEEDS_APPROVAL'),
    };
  }

  // ⚠️ AND A CAN'T-LAND EXIT IS NEVER RE-QUEUED, whatever anyone approves (§4 FOURTH
  // AMENDMENT, point 2). A conflict does not resolve by being asked again: the commits
  // have to change, so the card sits at Implemented with `motir fix` (MOTIR-5803) and
  // the next push re-arms the question. Since the FIFTH AMENDMENT (MOTIR-6594) a queue
  // FAILURE is can't-land too, and it is refused as what it is: a CI failure reported
  // as a conflict would send a person looking for a conflict that does not exist. The
  // approval that reaches here post-dates the exit — a gate re-asked under the old rule,
  // before the convergence (MOTIR-6595) withdrew it.
  if (classOfQueueExit(args.exit) === 'cant_land') {
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: target.pullRequestId,
      outcome: 'refused',
      refusal:
        args.exit.rawReason === 'MERGE_CONFLICT'
          ? toGateRefusal('MERGE_CONFLICT')
          : toGateRefusal('MERGE_QUEUE_FAILED_NEEDS_FIX', { reason: args.exit.rawReason }),
    };
  }

  const claimedAt = new Date();
  try {
    await withWorkspaceContext(ctx, async (tx) => {
      await queueExitCardMoves.lockCard(args.workItemId, tx);
      const count = await githubPullRequestQueueExitRepository.claimRequeue(
        args.exit.id,
        claimedAt,
        tx,
      );
      if (count === 0) throw new ApprovalGateAlreadyRequeuedError(target.pullRequestId);
      // The stamp lifts the queue failure from every delivered card's `ciState`
      // (MOTIR-5717); a refused re-enqueue below puts it back.
      await queueExitCardMoves.recomputeDeliveredCiState(args.exit.pullRequestId, tx);
    });
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: target.pullRequestId,
      outcome: 'refused',
      refusal,
    };
  }

  let outcome: 'merged' | 'enqueued';
  try {
    outcome = await mergeOrEnqueue(approvalGateId, target, ctx);
  } catch (err) {
    // The host said no, or said nothing: the exit is offered again.
    await withWorkspaceContext(ctx, async (tx) => {
      await githubPullRequestQueueExitRepository.releaseRequeue(args.exit.id, claimedAt, tx);
      // The exit stands again, and so does the card's red (MOTIR-5717).
      await queueExitCardMoves.recomputeDeliveredCiState(args.exit.pullRequestId, tx);
    });
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: target.pullRequestId,
      outcome: 'refused',
      refusal,
    };
  }

  return { subjectVersion: member.subjectVersion, pullRequestId: target.pullRequestId, outcome };
}

/**
 * RECORD A HOST REFUSAL, AND SETTLE THE CARD BY ITS CLASS (§4 FOURTH AMENDMENT,
 * point 5; MOTIR-5833).
 *
 * ⚠️ IN ITS OWN TRANSACTION, AFTER THE PRESS'S HAS COMMITTED. The approval committed
 * in step 1 and the host call happened outside any transaction, so this write has
 * nothing to roll back with — which is the point: the refusal must survive the press
 * that was refused.
 *
 * The CLASS then decides what happens to the card, through the one entry point every
 * source shares ({@link settleUnlandedOutcome}): a conflict or red checks hold it at
 * `implemented` with `motir fix`, a setting sends it back to `in_review` with ONE
 * fresh question naming that setting. `already_merged` settles nothing — the merge
 * webhook owns that card — and `subject_changed` never reaches here at all.
 *
 * A failure to record is LOGGED AND SWALLOWED: the caller is about to throw the
 * refusal a person is waiting to read, and losing that message to a bookkeeping
 * error would be the worse outcome.
 */
async function recordMergeRefusal(
  approvalGateId: string,
  target: MergeTarget,
  refusal: { code: MergeRefusalCode; permission?: string; reason?: string },
  ctx: ServiceContext,
): Promise<void> {
  try {
    await withWorkspaceContext(ctx, async (tx) => {
      await queueExitCardMoves.lockCard(target.workItemId, tx);
      await githubPullRequestMergeRefusalRepository.create(
        {
          pullRequestId: target.pullRequestId,
          code: refusal.code,
          headSha: target.expectedHeadSha,
          approvalGateId,
          permission: refusal.permission ?? null,
          reason: hostReasonOf(refusal.reason),
          refusedAt: new Date(),
        },
        tx,
      );
      // ⚠️ AN OUT-OF-DATE REFUSAL IS ALSO A MERGEABILITY READING (Bug MOTIR-10054). The
      // host classified it from `mergeable_state: behind` at the approved head, so that
      // reading is stored here as any host read stores one: the promotion holds the card
      // on it and the repair predicate hands the member to `motir fix`, which is what lists
      // it under To fix. A push replaces it, as it replaces every reading.
      if (refusal.code === 'out_of_date') {
        await githubPullRequestRepository.setMergeability(
          target.pullRequestId,
          { mergeableState: OUT_OF_DATE_MERGEABLE_STATE, headSha: target.expectedHeadSha },
          tx,
        );
      }
      const landingClass = classOfMergeRefusal(refusal.code);
      if (landingClass !== null) {
        const item = await workItemRepository.findById(target.workItemId, tx);
        const mode = item
          ? (await projectRepository.findPrMergeMode(item.projectId, tx))?.prMergeMode
          : null;
        // `auto` has no approval to spend and no person to ask, so it records nothing.
        if (item && mode === 'manual') await settleUnlandedOutcome(item, landingClass, ctx, tx);
      }
      // The refusal may have held the card at Implemented — re-decide what it is waiting
      // on (MOTIR-6602), under the lock taken above.
      await recomputeWorkItemFixReason(target.workItemId, tx);
    });
  } catch (err) {
    console.error('[pullRequestMergeService] the refusal could not be recorded', {
      approvalGateId,
      pullRequestId: target.pullRequestId,
      code: refusal.code,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The longest host message kept on a refusal row — GitHub's run to a sentence or
 *  two; the bound only keeps a pathological body from riding into every read. */
const HOST_REASON_MAX_LENGTH = 2000;

/**
 * The host's own message, as the refusal row keeps it (Bug MOTIR-6735). For a
 * `branch_protected` refusal it is the ONLY record of which setting refused the
 * merge — the classifier puts every error it does not recognise under that code — so
 * it is kept verbatim, trimmed, and bounded. Blank is no message at all.
 */
function hostReasonOf(reason: string | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, HOST_REASON_MAX_LENGTH);
}

/** A member's refusal in the frame's own vocabulary — the mapping the decide action uses. */
function memberRefusal(err: unknown): GateRefusal | null {
  if (err instanceof ApprovalGateMergeRefusedError) {
    return toGateRefusal(err.tag, { permission: err.permission, reason: err.reason });
  }
  if (err instanceof ApprovalGateAlreadyDecidedError) {
    return toGateRefusal(err.tag, { decidedByLabel: err.decidedByLabel });
  }
  if (err instanceof ApprovalGateSupersededError)
    return toGateRefusal(err.tag, { supersedeCause: err.supersedeCause });
  if (err instanceof ApprovalGateError) return toGateRefusal(err.tag);
  if (err instanceof PermissionDeniedError) return toGateRefusal('APPROVAL_GATE_NOT_AUTHORISED');
  if (err instanceof ProjectNotFoundError) return toGateRefusal('APPROVAL_GATE_NOT_FOUND');
  // The host did not answer: nothing was decided, and there is no host refusal to draw.
  if (err instanceof MergeChangeRequestError) return toGateRefusal('UNEXPECTED');
  return null;
}
