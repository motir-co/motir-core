import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { deliveryMemberVersion } from '@/lib/approvalGates/deliverySetVersion';
import {
  primaryApprovalStandsForMerge,
  resolveGateSet,
  type AwaitableGateKind,
  type GateSet,
  type GateSetMember,
} from '@/lib/approvalGates/gateSet';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import {
  decisionMembersOf,
  loadPageDecisionIdentity,
} from '@/lib/approvalGates/decisionApprovalHandler';
import { decisionIdentityOf } from '@/lib/approvalGates/decisionSubject';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { reviewDismissalRepository } from '@/lib/repositories/reviewDismissalRepository';
import { reviewVerdictRecordRepository } from '@/lib/repositories/reviewVerdictRecordRepository';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { queueExitStandsAtHead } from '@/lib/workItems/deliverySet';
import { prCiStateAtHead, pullRequestHead } from '@/lib/github/pullRequestHead';
import {
  classOfMergeRefusal,
  classOfQueueExit,
  type LandingClass,
} from '@/lib/mergeQueue/queueExit';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { githubPullRequestMergeRefusalRepository } from '@/lib/repositories/githubPullRequestMergeRefusalRepository';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { reviewRaiseKey } from '@/lib/agentReview/reviewRunKey';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { mergeCandidateHead } from './mergeGates';
import { workflowsService } from './workflowsService';

/** The ONE status at which the approve-to-merge question is asked (MOTIR-6971). */
export const IN_REVIEW_STATUS_KEY = 'in_review';

// THE PREDICATE'S ONE LOADER (Story MOTIR-5652 · Subtask MOTIR-5662) — reads the
// facts `resolveGateSet` is a function of, for one card, on a transaction it is
// handed.
//
// ⚠️ THE SPLIT IS THE POINT, not ceremony. `lib/approvalGates/gateSet.ts` is the
// RULE and is pure, so it can be read against AMENDMENT 6 line by line and tested
// without a fixture. This module is the READ, and it is the only place the rule's
// inputs are gathered — so a caller cannot answer half of the question inline and
// ask the predicate the other half, which is exactly how MOTIR-5603, MOTIR-5604
// and MOTIR-5652 were each written by somebody being locally careful.
//
// ⚠️ IT OPENS NO TRANSACTION AND TAKES NO LOCK. Every caller already holds the
// card's row lock for its own write; adding one here would change lock ordering in
// four places at once. Every read is on the caller's `tx`, so what the predicate
// sees is what that transaction will write against.

/**
 * A head this TRANSACTION knows about and the stored check runs do not — the
 * `synchronize` delivery's own sha. Threaded so a re-ask after a head-move
 * withdrawal cannot raise a gate over the commits it just retired.
 */
export interface MovedHead {
  pullRequestId: string;
  /** The delivery's head, or undefined when it carried none. */
  headSha: string | undefined;
}

/** What the CALLING EVENT knows that the card's rows do not yet say. */
export interface GateSetSignals {
  movedHead?: MovedHead;
}

/** What a raise did, or why it did not — enough for a caller to log a true sentence. */
export interface GateSetForResult extends GateSet {
  /**
   * The members that could NOT be merged now, with the reason visible in the row.
   * Empty when the set is mergeable or when the card delivers nothing.
   *
   * MOTIR-5604's `console.warn` needs this: the predicate answers *no merge gate
   * is owed*, and a person looking at an unapprovable card needs to know WHICH
   * pull request is why. The rule stays in the predicate; the naming stays here.
   */
  /**
   * Whether the card delivers pull requests of its own — a STORY RUN, when it holds an
   * acceptance receipt. {@link withdrawMergeQuestionOffReview} withdraws a story run's
   * acceptance question with its merge question; a subtask run's is timed by its
   * subtree and is left alone (MOTIR-6971).
   */
  readonly deliversPullRequests: boolean;
  readonly blockedMembers: ReadonlyArray<{
    pullRequestId: string;
    state: string;
    merged: boolean;
    ciState: string | null;
  }>;
}

/**
 * WHICH GATES this card should be asking, read from the database and decided by
 * {@link resolveGateSet}.
 *
 * Nine reads, all on `tx`: the current design result and receipt, the latest gate of each
 * kind (the decision's only when the card asks that question), the delivery set with its
 * check runs, the project's merge mode, and the project's terminal status keys.
 */
export async function gateSetFor(
  item: WorkItem,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<GateSetForResult> {
  const asksDecision = asksTheDecisionQuestion(item);
  const [
    currentDesign,
    latestDesignGate,
    currentReceipt,
    latestAcceptanceGate,
    latestMergeGate,
    latestDecisionGate,
    latestAgentReviewGate,
    deliveries,
    mode,
    terminalByProject,
    pageDecision,
    latestAgentSendBack,
    latestDismissal,
  ] = await Promise.all([
    designEvidenceRepository.findCurrentByWorkItem(item.id, tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'design_result', tx),
    // MOTIR-5789 — a STORY's acceptance receipt and its latest gate, loaded here in the
    // predicate's ONE loader so no caller answers half the question itself.
    acceptanceEvidenceRepository.findCurrentByWorkItem(item.id, tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'acceptance_result', tx),
    approvalGateRepository.findLatestByWorkItem(item.id, 'pull_request_approval', tx),
    // Only a card that asks the decision question reads its gate (clause 10), so every
    // other card's reads — and its answer — are what they were before the kind existed.
    asksDecision
      ? approvalGateRepository.findLatestByWorkItem(item.id, 'decision_approval', tx)
      : Promise.resolve(null),
    // The review agent's question (MOTIR-6819; `approval-gates.md` §12.2) — its latest row,
    // read beside the merge gate's so the predicate can tell a decided version from one
    // still owed a review.
    approvalGateRepository.findLatestByWorkItem(item.id, 'agent_review', tx),
    workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    // The merge mode AND the review agent's switch, in one read (§12.2a).
    projectRepository.findMergeSettings(item.projectId, tx),
    workflowsService.getTerminalStatusKeysByProjects([item.projectId], item.workspaceId, tx),
    // A PUBLISHED PAGE (MOTIR-7433) — read only when the card asks the question, like
    // its gate above, and preferred over the capture below.
    asksDecision ? loadPageDecisionIdentity(item.id, tx) : Promise.resolve(null),
    // A GATE-OFF agent send-back (MOTIR-10333; `approval-gates.md` §12.14) — a record, not a
    // gate, so the predicate is handed its version to tell whether it still stands.
    reviewVerdictRecordRepository.findLatestRecordedSendBack(item.id, tx),
    // A person's DISMISSAL of a send-back (MOTIR-10334; §12.15) — the predicate is handed
    // its version to tell whether the send-back there still stands.
    reviewDismissalRepository.findLatestByWorkItem(item.id, tx),
  ]);

  const members: GateSetMember[] = [];
  const blockedMembers: GateSetForResult['blockedMembers'][number][] = [];
  for (const delivery of deliveries) {
    const candidate = mergeCandidateHead({ ...delivery.pullRequest, repo: delivery.repo });
    // ⚠️ A HEAD THIS TRANSACTION KNOWS ABOUT AND THE ROWS DO NOT (MOTIR-5663).
    // `mergeCandidateHead` reads the CHECK RUNS, so a `synchronize` that has not
    // yet produced a check row still looks green at the OLD commit. The delivery
    // that carried the move knows better, and it is the same override
    // `withdrawPullRequestApprovalGatesOnHeadMove` already threads into
    // `deliveryMemberVersion` — without it the re-ask would raise a fresh gate
    // over exactly the commits the withdrawal just retired.
    const movedHead = signals.movedHead;
    const moved =
      movedHead !== undefined &&
      movedHead.pullRequestId === delivery.githubPullRequestId &&
      movedHead.headSha !== candidate;
    const head = moved ? null : candidate;
    if (!head) {
      blockedMembers.push({
        pullRequestId: delivery.githubPullRequestId,
        state: delivery.pullRequest.state,
        merged: delivery.pullRequest.merged,
        ciState: prCiStateAtHead(delivery.pullRequest),
      });
    }
    members.push({
      memberVersion: deliveryMemberVersion(
        delivery,
        moved ? signals.movedHead!.headSha : (head ?? undefined),
      ),
      isMergeCandidate: head !== null,
      merged: delivery.pullRequest.merged,
    });
  }

  // ⚠️ AN UN-LANDED OUTCOME STANDING AT A MEMBER'S HEAD RE-ASKS THE MERGE, AND ITS
  // CLASS SAYS WHETHER IT ASKS AT ALL (§4 FOURTH AMENDMENT, points 2–3; MOTIR-5802 ·
  // MOTIR-5805). Read over EVERY disposition, not only the failures the promotion hold
  // reads: a NEUTRAL removal spends the approval exactly as a failure does (Yue,
  // 2026-09-19: *"re-ask too"*), so it must reach the predicate. One indexed read, and
  // nothing for nearly every card.
  const latestExits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    deliveries.map((delivery) => delivery.githubPullRequestId),
    tx,
  );
  // ⚠️ AND A HOST REFUSAL IS THE OTHER SOURCE (MOTIR-5833). The queue's removal and the
  // refusal at the press are two ways the SAME approval fails to land, so both feed the
  // one predicate; a refusal stands while nothing superseded it and the head it names is
  // still the member's.
  const latestRefusals = await githubPullRequestMergeRefusalRepository.findLatestByPullRequests(
    deliveries.map((delivery) => delivery.githubPullRequestId),
    tx,
  );
  const standingOutcomes = deliveries.flatMap((delivery) => {
    const head = pullRequestHead(delivery.pullRequest);
    const outcomes: { at: Date; landingClass: LandingClass }[] = [];
    const exit = latestExits.get(delivery.githubPullRequestId);
    // The RULE is `deliverySet.ts`'s `queueExitStandsAtHead` — the promotion hold's own
    // twin, one disposition wider — so the two readers cannot disagree about which exit
    // still describes the code.
    if (queueExitStandsAtHead(exit, head)) {
      outcomes.push({ at: exit!.exitedAt, landingClass: classOfQueueExit(exit!) });
    }
    const refusal = latestRefusals.get(delivery.githubPullRequestId);
    const refusalClass = refusal ? classOfMergeRefusal(refusal.code) : null;
    if (
      refusal &&
      refusalClass !== null &&
      refusal.supersededAt === null &&
      head &&
      refusal.headSha === head &&
      !delivery.pullRequest.merged
    ) {
      outcomes.push({ at: refusal.refusedAt, landingClass: refusalClass });
    }
    return outcomes;
  });
  // The LATEST outcome is the one the question is about; an older one is history.
  const standingUnlandedOutcome =
    standingOutcomes.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;

  // ⚠️ THE ACCEPTANCE QUESTION'S SUBTASK-RUN TIMING (Bug MOTIR-5903; `approval-gates.md`
  // §1, the MOTIR-5903 amendment). A story that delivers no pull request of its own had
  // its receipt recorded by a child, and approving it is what sets the story `done` — so
  // the predicate needs to know whether anything under the story is still open. One
  // recursive read, and only for a card holding a receipt and no delivery set: every other
  // card pays nothing.
  //
  // ⚠️ AND FOR A STORY RUN WHOSE EVERY DELIVERY HAS MERGED (Bug MOTIR-10837). Its merge
  // question has nothing left to land, so the video cannot ride it; the predicate asks it
  // as a finished story's, on this same settled-subtree input. (`every` over an empty set
  // is the subtask-run case above.)
  const subtreeSettled =
    currentReceipt !== null && deliveries.every((delivery) => delivery.pullRequest.merged === true)
      ? (await workItemRepository.findSubtreeMembersForValidity(item.id, item.workspaceId, tx))
          .filter((member) => member.id !== item.id)
          .every((member) =>
            isTerminalStatus(
              { status: member.status, projectId: item.projectId },
              terminalByProject,
            ),
          )
      : false;

  const set = resolveGateSet({
    currentDesignEvidence: currentDesign
      ? { id: currentDesign.id, commitSha: currentDesign.commitSha }
      : null,
    currentReceipt: currentReceipt
      ? { id: currentReceipt.id, commitSha: currentReceipt.commitSha }
      : null,
    latestAcceptanceGate,
    subtreeSettled,
    primaryApprovalStandsForMerge: primaryApprovalStandsForMerge({
      currentDesign,
      latestDesignGate,
      currentReceipt,
      latestAcceptanceGate,
    }),
    latestDesignGate,
    latestMergeGate,
    members,
    prMergeMode: mode?.prMergeMode ?? null,
    reviewAgentEnabled: mode?.reviewAgentEnabled ?? false,
    latestAgentReviewGate,
    agentSendBackVersion: latestAgentSendBack?.subjectVersion ?? null,
    dismissedSendBackVersion: latestDismissal?.subjectVersion ?? null,
    cardIsTerminal: isTerminalStatus(item, terminalByProject),
    // By the literal KEY, as the status ladder compares it (MOTIR-6971): the merge
    // question is asked only of a card the run has settled into review.
    cardInReview: item.status === IN_REVIEW_STATUS_KEY,
    workItemId: item.id,
    standingUnlandedOutcome,
    // THE DECISION QUESTION (MOTIR-5677) — read from the SAME delivery rows as the
    // merge question, off the capture MOTIR-5674 writes, so the two can never be about
    // different pull requests and no host is called.
    ...(asksDecision
      ? {
          decision: {
            // A published page wins over the capture (MOTIR-7433).
            identity: pageDecision ?? decisionIdentityOf(decisionMembersOf(deliveries)),
            latestGate: latestDecisionGate,
          },
        }
      : {}),
  });

  return { ...set, blockedMembers, deliversPullRequests: deliveries.length > 0 };
}

/**
 * RAISE WHATEVER THE CARD SHOULD BE ASKING AND IS NOT, in the caller's transaction.
 * Returns the kinds it created, in the order {@link resolveGateSet} names them.
 *
 * ⚠️ THE ONE PLACE A GATE ROW IS CREATED (Story MOTIR-5652 · Subtask MOTIR-5663).
 * `raisePullRequestApprovalGate` is a thin wrapper over this, and the withdrawers
 * call it straight after superseding — which is the structural half of this level.
 * Each withdrawer answers a narrow and correct question (*this head moved, so the
 * gate about the old head is stale*) and none was ever in a position to ask *and
 * what should the card have instead?* — so a question retired for an excellent
 * reason simply stopped existing. MOTIR-5604 is that, already paid for once, at
 * one site, with six others behaving the same way.
 *
 * ⚠️ IT DOES NOT SUPERSEDE. Reconciliation is deliberately one-directional here:
 * each withdrawer already knows which question IT is retiring and why, and a
 * general "supersede everything not in the set" would take that cause away and
 * make one site's event able to retire another kind's question. Raising what is
 * missing is safe from any caller; retiring stays where the cause is known.
 * **ONE exception, and it keeps that rule rather than breaking it (MOTIR-6971):** a
 * card that is not `in_review` loses its awaiting merge question as `pulled_back`,
 * because that cause IS known to every caller — it is the card's own status, read
 * under the lock the caller holds. See {@link withdrawMergeQuestionOffReview}.
 *
 * ⚠️ IT ASKS FOR NO HANDLER. `designResultHandler` imports `workItemsService`,
 * which imports the CI promotion that calls this module. Both registered kinds
 * route by ADR §2's `assigneeId ?? reporterId` — which is all `routeTo` does — so
 * the shared `routingTargetId` is the same answer without the cycle.
 */
export async function reconcileGatesFor(
  item: WorkItem,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<AwaitableGateKind[]> {
  const set = await gateSetFor(item, tx, signals);
  // ⚠️ THE ONE STATUS-AXIS WITHDRAWAL (MOTIR-6971; `approval-gates.md` §8's EIGHTH
  // AMENDMENT). The header below says this function does not supersede, because each
  // CHECK-SET withdrawer knows its own cause. This is not one of theirs: the merge
  // question exists only while the card is `in_review`, so an awaiting one on a card
  // anywhere else is a question the predicate no longer owes for a reason every caller
  // can see — the card's own status. It is what retires a gate raised before this rule
  // (MOTIR-6914's, at `in_progress`) on the next reconcile, the 30-minute sweep's
  // included.
  if (item.status !== IN_REVIEW_STATUS_KEY) {
    await withdrawMergeQuestionOffReview(item, tx, set);
  }
  if (set.awaited.length === 0) return [];

  const awaiting = await approvalGateRepository.findAwaitingByWorkItem(item.id, tx);
  const raised: AwaitableGateKind[] = [];
  for (const owed of set.awaited) {
    // The card's row lock (every caller holds it) is what serialises two events
    // for one card; this read is the second of them seeing the first's committed
    // row, so a lost race is a no-op rather than a unique-index violation that
    // would abort the caller's transaction.
    if (awaiting.some((gate) => gate.kind === owed.kind)) continue;
    const created = await approvalGateRepository.create(
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        workItemId: item.id,
        kind: owed.kind,
        subjectId: owed.subjectId,
        subjectVersion: owed.subjectVersion,
        routedToId: routingTargetId(item),
      },
      tx,
    );
    raised.push(owed.kind);
    if (created.kind === 'agent_review') requestAgentReviewAfterCommit(created);
  }
  return raised;
}

/**
 * WITHDRAW THE MERGE QUESTION FROM A CARD THAT IS NOT IN REVIEW (MOTIR-6971;
 * `approval-gates.md` §8's EIGHTH AMENDMENT) — its awaiting `pull_request_approval`, the
 * `agent_review` that stands in front of it (MOTIR-1626), and on a STORY RUN the
 * `acceptance_result` asked beside it, superseded as
 * `pulled_back`: the work is not in review, so nobody is being asked about it.
 *
 * Returns how many rows it superseded. A DECIDED gate is never touched (§8 decision 5):
 * the repository's `state: 'awaiting'` equality is the whole guard.
 *
 * ⚠️ THE CALLER DECIDES THAT THE CARD IS OUT OF REVIEW, and holds its locks —
 * `applyStatusTransition` in the decide door's order (gates, then card; rule 8), every
 * `reconcileGatesFor` caller the card's row lock, exactly as the check-set withdrawers
 * supersede under it.
 *
 * ⚠️ A SUBTASK-RUN STORY'S ACCEPTANCE QUESTION IS LEFT ALONE. It is timed by the
 * story's subtree (MOTIR-5903), not by a pull request the story delivers, so the
 * merge question's status rule is not its rule.
 */
export async function withdrawMergeQuestionOffReview(
  item: WorkItem,
  tx: Prisma.TransactionClient,
  set?: GateSetForResult,
): Promise<number> {
  let withdrawn = 0;
  for (const kind of ['pull_request_approval', 'agent_review'] as const) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      item.id,
      kind,
      'pulled_back',
      tx,
    );
  }
  const storyRun = (set ?? (await gateSetFor(item, tx))).deliversPullRequests;
  if (storyRun) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      item.id,
      'acceptance_result',
      'pulled_back',
      tx,
    );
  }
  if (withdrawn > 0) {
    console.warn('[gateSetFor] merge question withdrawn: the card is not in review', {
      workItemId: item.id,
      status: item.status,
      withdrawn,
    });
  }
  return withdrawn;
}

/**
 * ASK FOR THE REVIEW RUN once the transaction that raised this `agent_review` gate has
 * committed (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.2,
 * `hosted-agent-run.md` §8.1 — *one review run per awaiting gate, started by the server
 * from the gate's raise*).
 *
 * ⚠️ HERE, AT THE ONE CREATOR, so every raise path emits it — the promotion, a status move
 * into review, the reconcile tick, a queue exit, every withdrawal's re-raise — without a
 * return value threaded out of a dozen callers' transactions. It is deferred through the
 * transaction helpers' after-commit scope (`lib/workspaces/afterCommit.ts`): a job
 * enqueued before the commit could look for a gate that then rolled back.
 *
 * ⚠️ A RAISE OUTSIDE ANY HELPER SCOPE EMITS NOTHING, and says so. Only a bare
 * `db.$transaction` gets here unscoped (the RLS guards keep those rare, and no production
 * raise path uses one): the gate still stands awaiting on the card, and the person it is
 * routed to can start the review from it (§12.6's *Review again*, MOTIR-6820).
 */
function requestAgentReviewAfterCommit(gate: {
  id: string;
  workspaceId: string;
  workItemId: string | null;
  subjectVersion: string | null;
}): void {
  const { id: gateId, workspaceId, workItemId, subjectVersion } = gate;
  // The predicate raises the review only at a named set version, on a card.
  /* v8 ignore next */
  if (workItemId === null || subjectVersion === null) return;
  const deferred = deferUntilCommit(() =>
    sendEvent('agent-review/requested', {
      workspaceId,
      gateId,
      workItemId,
      subjectVersion,
      idempotencyKey: reviewRaiseKey(gateId),
    }),
  );
  if (!deferred) {
    console.warn(
      '[gateSetFor] an agent_review gate was raised outside a transaction scope; ' +
        'no review run was requested for it',
      { gateId, workItemId },
    );
  }
}

/**
 * RE-ASK THE OWNING STORY when a card beneath it reaches the done category — the wake
 * the acceptance question's SUBTASK-RUN timing needs (Bug MOTIR-5903; `approval-gates.md`
 * §1, the MOTIR-5903 amendment, point 3).
 *
 * The story's acceptance question is owed only once nothing under it is left open
 * (`subtreeSettled`), and that condition changes on a CHILD's status write — never on
 * anything the story's own events see. Without this, the recording subtask's merge would
 * leave the story holding a receipt nobody is asked about, and the parent rollup would
 * then close the story around it.
 *
 * ⚠️ IN THE CHILD'S TRANSACTION, BEFORE THE ROLLUP. The upward rollup runs as a job AFTER
 * this transaction commits, and the gate raised here is what §6d's rule 1 then holds the
 * story's move into `done` on — so the story reaches `done` by the approval, as the
 * amendment says, not by the rollup racing past the question.
 *
 * ⚠️ IT LOCKS THE STORY ROW, because `reconcileGatesFor` relies on its caller holding the
 * card's lock: two children finishing at once would otherwise both see no awaiting gate
 * and the second insert would abort its own status write. The child is already locked;
 * the story is taken second, child-then-parent, the same order the rollup never inverts.
 *
 * Only the NEAREST STORY ancestor is asked, and only when it holds a current receipt —
 * every other done write pays one parent-chain read and stops.
 */
export async function reconcileAcceptanceOwnerOf(
  item: Pick<WorkItem, 'parentId'>,
  tx: Prisma.TransactionClient,
): Promise<void> {
  let parentId = item.parentId;
  while (parentId) {
    const parent = await workItemRepository.findById(parentId, tx);
    if (!parent) return;
    if (parent.kind === 'story') {
      const receipt = await acceptanceEvidenceRepository.findCurrentByWorkItem(parent.id, tx);
      if (!receipt) return;
      await workItemRepository.lockById(parent.id, tx);
      await reconcileGatesFor(parent, tx);
      return;
    }
    parentId = parent.parentId;
  }
}
