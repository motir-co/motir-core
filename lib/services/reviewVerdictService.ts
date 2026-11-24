import type { ApprovalGate, Prisma, ReviewVerdictRecord } from '@/generated/prisma/client';
import {
  ReviewNotYetAskedError,
  ReviewNothingToReviewError,
  ReviewTargetNotRunTargetError,
  ReviewVerdictAnswerExistsError,
  ReviewVerdictInvalidError,
  ReviewVerdictLateError,
  ReviewVerdictRunTokenNotAllowedError,
  ReviewVerdictSecondError,
} from '@/lib/agentReview/errors';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { agentReviewStanding } from '@/lib/approvalGates/gateSet';
import { withoutAncestorDeliveries } from '@/lib/approvalGates/ownDeliveries';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateStaleSubjectError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import type { ReviewVerdict } from '@/lib/dispatch/reviewPromptTemplate';
import {
  REVIEW_CHECKLIST_MAX_ROWS,
  REVIEW_CHECKLIST_STATUSES,
  REVIEW_SUBMITTER_FIELD_MAX_LENGTH,
  type ReviewDoorVerdict,
  type ReviewVerdictResultDto,
  type SubmitReviewVerdictInput,
} from '@/lib/dto/agentReview';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { reviewDismissalRepository } from '@/lib/repositories/reviewDismissalRepository';
import {
  reviewVerdictRecordRepository,
  type ReviewVerdictRecordCreateRow,
} from '@/lib/repositories/reviewVerdictRecordRepository';
import { reviewVerdictRecordService } from '@/lib/services/reviewVerdictRecordService';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { reviewBotPostService } from '@/lib/services/reviewBotPostService';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE USER-TOKEN VERDICT DOOR (Story MOTIR-10327 · MOTIR-10333; `docs/decisions/
// approval-gates.md` §12.11–§12.14) — one service behind the MCP tool
// `submit_review_verdict` and `POST /api/v1/work-items/{key}/review-verdict`.
//
// A person's OWN review agent submits its verdict here, with the person's own token: any
// teammate holding `work_item:edit` on the card, not only its assignee. The run-token
// route (`agentReviewRunService.submitVerdict`) stays the HOSTED run's alone; both write
// one `review_verdict_record` row per verdict, so the bot, the activity and the read model
// read every agent verdict from one place.
//
// ── What a verdict does, in order ────────────────────────────────────────────────────
//   1. LATE (§12.13) — it names a version that is not the card's current one. SECOND —
//      the version already has a decided review gate or an answering record. Either is
//      STORED with that outcome, decides nothing, and is refused with a typed 409.
//   2. GATE ON — an awaiting `agent_review` gate at the current version: the verdict
//      decides it through `approvalGatesService.decideAgentReview`, whatever the source,
//      and a hosted run still in flight for it is cancelled after commit.
//   3. NOT YET ASKED (Bug MOTIR-12147) — the review gate is ON and the review at this
//      version is owed, but no gate is awaiting yet (the set is not green and in review, or
//      the raise is late). Refused with a typed 409 and STORED NOTHING: a `recorded` row
//      would answer the version, and the gate raised later could never be decided.
//   4. GATE OFF — no review is owed: the verdict IS the record (`recorded`). A pass
//      decides and moves nothing.
//   5. A SEND-BACK, either way (§12.14): no status moves, an awaiting approve-and-merge
//      gate is withdrawn under `agent_changes_requested`, and `resolveGateSet` does not
//      raise it again at this version while the send-back stands. The card's To fix
//      answer is recomputed in the same transaction.
//
// ── Why the gate-on decide is NOT in this service's transaction ──────────────────────
// `decide()` opens its own (it is the one door every gate decision passes through, with
// its lock, its stale check and its effect), so it cannot run inside a caller's. The
// door's own lock is the concurrency guard there: a second verdict racing the first finds
// the gate decided and is stored as `second`. The gate-off branch has no gate to lock,
// so its guard is the partial unique index on answering records — the loser's insert is
// refused, its transaction rolls back, and it is stored again as `second`.

/** The door's wire word → the gate's verdict word. */
function gateVerdictOf(verdict: ReviewDoorVerdict): ReviewVerdict {
  return verdict === 'approved' ? 'pass' : 'changes_requested';
}

/**
 * The input, checked — the transports parse the same shape first, and this is the
 * service's own backstop so no caller can store a send-back without findings or a `met`
 * row without evidence.
 */
function normalise(input: SubmitReviewVerdictInput): SubmitReviewVerdictInput {
  const harness = input.harness.trim();
  const model = input.model.trim();
  const subjectVersion = input.subjectVersion.trim();
  if (!subjectVersion) throw new ReviewVerdictInvalidError('subjectVersion', 'is required');
  if (!harness || harness.length > REVIEW_SUBMITTER_FIELD_MAX_LENGTH) {
    throw new ReviewVerdictInvalidError(
      'harness',
      `is required, at most ${REVIEW_SUBMITTER_FIELD_MAX_LENGTH} characters`,
    );
  }
  if (!model || model.length > REVIEW_SUBMITTER_FIELD_MAX_LENGTH) {
    throw new ReviewVerdictInvalidError(
      'model',
      `is required, at most ${REVIEW_SUBMITTER_FIELD_MAX_LENGTH} characters`,
    );
  }
  const findingsMd = input.findingsMd?.trim() ? input.findingsMd : null;
  if (input.verdict === 'changes_requested' && findingsMd === null) {
    throw new ReviewVerdictInvalidError(
      'findingsMd',
      'is required, and must not be empty, on `changes_requested`',
    );
  }
  if (input.checklist.length > REVIEW_CHECKLIST_MAX_ROWS) {
    throw new ReviewVerdictInvalidError(
      'checklist',
      `holds at most ${REVIEW_CHECKLIST_MAX_ROWS} rows`,
    );
  }
  input.checklist.forEach((row, i) => {
    if (!row.criterion.trim()) {
      throw new ReviewVerdictInvalidError(`checklist.${i}.criterion`, 'is required');
    }
    if (!(REVIEW_CHECKLIST_STATUSES as readonly string[]).includes(row.status)) {
      throw new ReviewVerdictInvalidError(
        `checklist.${i}.status`,
        'must be `met`, `not_met` or `cannot_tell`',
      );
    }
    if (row.status === 'met' && !row.evidence?.trim()) {
      throw new ReviewVerdictInvalidError(`checklist.${i}.evidence`, 'is required on `met`');
    }
  });
  return {
    ...input,
    subjectVersion,
    harness,
    model,
    summaryMd: input.summaryMd?.trim() ? input.summaryMd.trim() : null,
    findingsMd,
  };
}

/** A decided `agent_review` gate at the version — the gate-on half of SECOND. Exported for
 *  the hosted review with no gate (`agentReviewRunService.submitVerdict`), which gives this
 *  door's outcomes and so must read SECOND the same way. */
export function decidedAt(gate: ApprovalGate | null, version: string): boolean {
  return (
    gate !== null &&
    gate.subjectVersion === version &&
    (gate.state === 'approved' || gate.state === 'changes_requested' || gate.state === 'overturned')
  );
}

/**
 * Withdraw the card's awaiting approve-and-merge gate on a send-back (§12.14). The caller
 * then recomputes the card's To fix answer — gates first, then the card, the order every
 * withdrawal takes. Returns the gates withdrawn. Exported so the hosted review with no gate
 * (§12.18) sends back exactly as this door does, rather than through a copy.
 */
export async function applySendBack(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  // ⚠️ …AND A STORY RUN'S AWAITING ACCEPTANCE QUESTION WITH IT. The video is the evidence
  // for that merge and its press merges, so a send-back that left it awaiting would keep
  // the story in To approve over the code just sent back (`pullRequestApprovalHandler`'s
  // `requestChanges` holds the same rule for a person's refusal).
  const kinds = ['pull_request_approval', 'acceptance_result'] as const;
  const awaiting = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).filter(
    (gate) => (kinds as readonly string[]).includes(gate.kind),
  );
  for (const kind of kinds) {
    if (!awaiting.some((gate) => gate.kind === kind)) continue;
    await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      kind,
      'agent_changes_requested',
      tx,
    );
  }
  return awaiting.map((gate) => gate.id);
}

/**
 * Refuse a card whose review belongs to an ancestor — {@link ReviewTargetNotRunTargetError},
 * naming the ancestor that holds the run's How to test.
 *
 * ⚠️ A CARD THAT DELIVERS PULL REQUESTS OF ITS OWN IS ITS OWN REVIEW SUBJECT, WHOEVER HOLDS
 * THE TEST RECORD (Bug MOTIR-11673). The run target (`resolveRunTarget`) answers *whose How
 * to test is this*, and a story run writes that record once, onto the story. A child built
 * in ANOTHER repository by its own run — a starter re-pin with its own pull request — then
 * resolves to the story, but the story's delivery set is the story's own rows and never
 * holds the child's pull request. Refusing the child sent the verdict to a card whose
 * version cannot name that pull request, so no verdict could ever land on it.
 *
 * So the run target refuses only a card with NO pull request of its own: one that delivers
 * nothing, or whose every pull request an ancestor also delivers (a child riding its parent
 * run's branch, Bug MOTIR-11624). That is the same "own" set the review and approve-and-merge
 * gates are raised on (`gateSetFor`), so the card the door accepts is the card the gate asks.
 *
 * ⚠️ AND IT RETURNS THAT OWN SET, BECAUSE THE VERSION IS MEASURED OVER IT (Bug MOTIR-11693).
 * The review gate's `subjectVersion` names the card's own members only. A door that measured
 * `current` over the whole linked set named one more pull request for a child that shares
 * one with its story, so a verdict at `current` never matched the awaiting gate and a
 * verdict at the gate's version was refused late — the gate was never decided.
 */
export async function reviewSubjectDeliveries(
  item: { id: string; identifier: string; parentId: string | null },
  deliveries: readonly WorkItemDeliveryWithChecks[],
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<WorkItemDeliveryWithChecks[]> {
  const { own } = await withoutAncestorDeliveries(
    { id: item.id, parentId: item.parentId, workspaceId },
    deliveries,
    tx,
  );
  if (own.length > 0) return own;
  const target = await resolveRunTargetFor({ id: item.id, workspaceId }, tx);
  if (target.kind === 'ancestor') {
    throw new ReviewTargetNotRunTargetError(item.identifier, target.holder.identifier);
  }
  return own;
}

/**
 * Is the review at `current` OWED but not asked yet (Bug MOTIR-12147)? True when the
 * project's review gate stands in front of this card's merge question at `current` —
 * {@link agentReviewStanding} answers `owed`, the same rule `resolveGateSet` raises the gate
 * by — and no gate is awaiting there (the caller has already routed an awaiting one to the
 * decide). A verdict stored as `recorded` here would answer the version, so every verdict
 * on the `agent_review` gate raised later would be refused SECOND and that gate could never
 * be decided. `not_required` — the switch off, `auto`, or a merge question already asked at
 * this version — is the gate-off branch, unchanged.
 */
async function reviewOwedButNotAsked(
  item: { id: string; projectId: string },
  current: string,
  latestReview: ApprovalGate | null,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const settings = await projectRepository.findMergeSettings(item.projectId, tx);
  if (!settings?.reviewAgentEnabled) return false;
  const [latestMergeGate, latestDismissal] = await Promise.all([
    approvalGateRepository.findLatestByWorkItem(item.id, 'pull_request_approval', tx),
    reviewDismissalRepository.findLatestByWorkItem(item.id, tx),
  ]);
  const standing = agentReviewStanding({
    reviewAgentEnabled: settings.reviewAgentEnabled,
    prMergeMode: settings.prMergeMode,
    workItemId: item.id,
    version: current,
    latestAgentReviewGate: latestReview,
    latestMergeGate,
    dismissedVersion: latestDismissal?.subjectVersion ?? null,
  });
  return standing === 'owed';
}

/** Why a verdict was refused, once its record is stored. */
type Refused = { refused: 'late'; currentVersion: string } | { refused: 'second' };

type FirstPass =
  | Refused
  | { decide: { gateId: string } }
  | { recorded: ReviewVerdictRecord; withdrew: string[] };

/**
 * THE RUN-TOKEN ADMISSION (Story MOTIR-11941 · MOTIR-11953; `approval-gates.md` §12.18): the
 * token's run must be a RUNNING review in a person's own agent (`origin: instance`, `command:
 * review`) with a leg on `workItemId`. Its token was minted as the person who started it, so
 * `ctx.userId` is already that person. Anything else is {@link ReviewVerdictRunTokenNotAllowedError}.
 */
async function assertOwnAgentReviewRun(
  runId: string,
  workItemId: string,
  ctx: ServiceContext,
): Promise<void> {
  const admitted = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    async (tx) => {
      const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
      return (
        run !== null &&
        run.origin === 'instance' &&
        run.command === 'review' &&
        run.status === 'running' &&
        run.cards.some((leg) => leg.workItemId === workItemId)
      );
    },
  );
  if (!admitted) throw new ReviewVerdictRunTokenNotAllowedError();
}

export const reviewVerdictService = {
  /**
   * Submit ONE agent verdict for a run-target card (§12.11). Returns what it did —
   * `decided` (gate on) or `recorded` (gate off); a late or second verdict is stored and
   * refused with {@link ReviewVerdictLateError} / {@link ReviewVerdictSecondError}; a
   * verdict before the review gate asks is refused, storing nothing, with
   * {@link ReviewNotYetAskedError}.
   *
   * Throws before anything is stored: `ProjectNotFoundError` / `WorkItemNotFoundError`
   * (not visible), `PermissionDeniedError` (no `work_item:edit`),
   * {@link ReviewVerdictInvalidError}, {@link ReviewTargetNotRunTargetError},
   * {@link ReviewNothingToReviewError}.
   */
  async submit(
    projectId: string,
    identifier: string,
    rawInput: SubmitReviewVerdictInput,
    ctx: ServiceContext,
  ): Promise<ReviewVerdictResultDto> {
    const input = normalise(rawInput);
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    await projectAccessService.assertPermission(projectId, ctx, 'work_item:edit');
    // ONE run kind's token is admitted (MOTIR-11953): a review in the person's own agent,
    // running, with a leg on this card — refused before anything is stored.
    if (ctx.tokenDispatchRunId !== undefined) {
      await assertOwnAgentReviewRun(ctx.tokenDispatchRunId, item.id, ctx);
    }

    const verdict = gateVerdictOf(input.verdict);
    const rowOf = (
      outcome: ReviewVerdictRecordCreateRow['outcome'],
      gateId: string | null,
    ): ReviewVerdictRecordCreateRow => ({
      workspaceId: ctx.workspaceId,
      projectId,
      workItemId: item.id,
      gateId,
      subjectVersion: input.subjectVersion,
      verdict,
      outcome,
      summaryMd: input.summaryMd,
      findingsMd: input.findingsMd,
      checklist: input.checklist.map((row) => ({
        key: row.key ?? null,
        criterion: row.criterion.trim(),
        status: row.status,
        evidence: row.evidence?.trim() ? row.evidence.trim() : null,
      })),
      submittedById: ctx.userId,
      harness: input.harness,
      model: input.model,
    });
    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId };
    /** Store the verdict as `second` and refuse it — its own transaction. */
    const refuseSecond = async (gateId: string | null): Promise<never> => {
      await withWorkspaceContext(scope, (tx) =>
        reviewVerdictRecordService.record(rowOf('second', gateId), tx),
      );
      throw new ReviewVerdictSecondError(input.subjectVersion);
    };

    // 1–3 · LATE / SECOND, then which branch — and the whole gate-off branch.
    let first: FirstPass;
    try {
      first = await withWorkspaceContext(scope, async (tx): Promise<FirstPass> => {
        const deliveries = await reviewSubjectDeliveries(
          item,
          await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
          ctx.workspaceId,
          tx,
        );
        const current = deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d)));
        if (current === null) throw new ReviewNothingToReviewError(item.identifier);

        const review = await approvalGateRepository.findLatestByWorkItem(
          item.id,
          'agent_review',
          tx,
        );
        const reviewAtVersion = review?.subjectVersion === input.subjectVersion ? review : null;
        if (input.subjectVersion !== current) {
          await reviewVerdictRecordService.record(rowOf('late', reviewAtVersion?.id ?? null), tx);
          return { refused: 'late', currentVersion: current };
        }
        const answered = await reviewVerdictRecordRepository.findAnswerAt(item.id, current, tx);
        if (answered || decidedAt(review, current)) {
          await reviewVerdictRecordService.record(rowOf('second', reviewAtVersion?.id ?? null), tx);
          return { refused: 'second' };
        }
        if (review && review.state === 'awaiting' && review.subjectVersion === current) {
          return { decide: { gateId: review.id } };
        }
        // NOT YET ASKED — refused before anything is stored (the transaction holds no write).
        if (await reviewOwedButNotAsked(item, current, review, tx)) {
          throw new ReviewNotYetAskedError(item.identifier, current);
        }
        // GATE OFF — the verdict is the record.
        const recorded = await reviewVerdictRecordService.record(rowOf('recorded', null), tx);
        // Motir's App bot posts it on the pull requests once this commits (MOTIR-10335).
        reviewBotPostService.requestPostAfterCommit(ctx.workspaceId, recorded.id);
        const withdrew = verdict === 'changes_requested' ? await applySendBack(item.id, tx) : [];
        await recomputeWorkItemFixReason(item.id, tx);
        return { recorded, withdrew };
      });
    } catch (err) {
      // A concurrent verdict answered this version first (the partial unique index).
      if (err instanceof ReviewVerdictAnswerExistsError) return refuseSecond(null);
      throw err;
    }

    if ('refused' in first) {
      if (first.refused === 'late') {
        throw new ReviewVerdictLateError(input.subjectVersion, first.currentVersion);
      }
      throw new ReviewVerdictSecondError(input.subjectVersion);
    }
    if ('recorded' in first) {
      return {
        key: item.identifier,
        recordId: first.recorded.id,
        outcome: 'recorded',
        verdict: input.verdict,
        subjectVersion: first.recorded.subjectVersion,
        gateId: null,
        withdrewApprovalGateIds: first.withdrew,
        submittedAt: first.recorded.createdAt.toISOString(),
      };
    }

    // 2 · GATE ON — the door decides, under its own lock and transaction.
    const { gateId } = first.decide;
    try {
      await approvalGatesService.decideAgentReview(
        {
          gateId,
          subjectVersion: input.subjectVersion,
          verdict,
          noteMd: input.findingsMd ?? input.summaryMd,
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof ApprovalGateAlreadyDecidedError) return refuseSecond(gateId);
      if (
        err instanceof ApprovalGateSupersededError ||
        err instanceof ApprovalGateStaleSubjectError
      ) {
        // The set moved, or the review was withdrawn, between the read and the decide.
        await withWorkspaceContext(scope, (tx) =>
          reviewVerdictRecordService.record(rowOf('late', gateId), tx),
        );
        throw new ReviewVerdictLateError(input.subjectVersion, null);
      }
      throw err;
    }

    let decided: { record: ReviewVerdictRecord; withdrew: string[] };
    try {
      decided = await withWorkspaceContext(scope, async (tx) => {
        const record = await reviewVerdictRecordService.record(rowOf('decided', gateId), tx);
        reviewBotPostService.requestPostAfterCommit(ctx.workspaceId, record.id);
        // A hosted run still reviewing this gate can no longer decide anything (§12.12).
        // The own-agent review that sent THIS verdict is closing itself: it is spared, or
        // the review that answered would read as cancelled (MOTIR-11951).
        agentReviewStartService.cancelRunsAfterCommit(
          ctx.workspaceId,
          [gateId],
          ctx.tokenDispatchRunId,
        );
        const withdrew = verdict === 'changes_requested' ? await applySendBack(item.id, tx) : [];
        if (withdrew.length > 0) await recomputeWorkItemFixReason(item.id, tx);
        return { record, withdrew };
      });
    } catch (err) {
      /* v8 ignore next 5 -- the door's lock decided this version for us; an answering
         record beside it would be a gate-off verdict at the same version, and since Bug
         MOTIR-12147 the gate set never raises a review over a version already answered. */
      if (err instanceof ReviewVerdictAnswerExistsError) return refuseSecond(gateId);
      throw err;
    }
    return {
      key: item.identifier,
      recordId: decided.record.id,
      outcome: 'decided',
      verdict: input.verdict,
      subjectVersion: input.subjectVersion,
      gateId,
      withdrewApprovalGateIds: decided.withdrew,
      submittedAt: decided.record.createdAt.toISOString(),
    };
  },
};
