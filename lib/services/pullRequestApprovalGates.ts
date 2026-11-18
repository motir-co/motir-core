import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { gateSetFor, reconcileGatesFor, type GateSetSignals } from './gateSetFor';
import { agentReviewStartService } from './agentReviewStartService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  approvalGateRepository,
  type LiveSupersedeCause,
} from '@/lib/repositories/approvalGateRepository';
import { listOwnDeliveriesWithChecks } from '@/lib/approvalGates/ownDeliveries';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';

// RAISE and WITHDRAW the `pull_request_approval` gate (Story MOTIR-4909 · MOTIR-5482;
// `docs/decisions/approval-gates.md` §8's amendment, decisions 1, 3 and 4).
//
// ONE question per card — *are these commits right?* — asked on the RUN TARGET once CI has
// judged its whole delivery set green, in a `manual` project. It is raised in the SAME
// transaction as the merge gates (the promotion's `implemented → in_review` write, or the
// re-raise for a card already in review), and withdrawn (`superseded`) the moment the set it
// asked about changes: a member's head moves, a member closes, or a delivery row joins or
// leaves the card.
//
// ⚠️ EVERY FUNCTION HERE WRITES INSIDE A TRANSACTION IT IS HANDED, and the raise relies on
// its caller holding the CARD's row lock. That lock is what serialises two green events for
// one card: the second reads the first's committed gate and raises nothing — so a lost race
// is a no-op, never a unique-index violation that would abort the caller's transaction.
//
// ⚠️ IT IMPORTS NO HANDLER. The handler module imports `workItemsService`, which imports the
// CI promotion that calls this module; the version and routing it needs live in
// service-free modules instead (`deliverySetVersion.ts`, `routing.ts`).

const KIND = 'pull_request_approval' as const;
const ACCEPTANCE_KIND = 'acceptance_result' as const;
const REVIEW_KIND = 'agent_review' as const;

/**
 * Retire the card's awaiting REVIEW AGENT question with the withdrawal's own cause (Story
 * MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.5). The review is about exactly the
 * commits the approve-and-merge gate would be about (§12.1's one stamp), so every event
 * that withdraws one withdraws the other, under the same cause and touching no decision
 * field. A decided review is history and is never touched. The next green raises a fresh
 * review at the new version (the re-ask below).
 *
 * The review RUN in flight for it is CANCELLED once this transaction commits (§12.5's
 * third bullet; MOTIR-6820): its answer can no longer decide anything and it is still
 * being paid for.
 */
async function withdrawAgentReview(
  workItemId: string,
  cause: LiveSupersedeCause,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const awaiting = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).filter(
    (gate) => gate.kind === REVIEW_KIND,
  );
  const count = await approvalGateRepository.supersedeAwaitingByWorkItem(
    workItemId,
    REVIEW_KIND,
    cause,
    tx,
  );
  const first = awaiting[0];
  if (count > 0 && first) {
    agentReviewStartService.cancelRunsAfterCommit(
      first.workspaceId,
      awaiting.map((gate) => gate.id),
    );
  }
  return count;
}

/**
 * Raise the card's `awaiting` approve-and-merge gate when {@link gateSetFor} says it is
 * owed and the card does not already hold one, and answer whether it did.
 *
 * ⚠️ IT NO LONGER DECIDES ANYTHING (Story MOTIR-5652 · Subtask MOTIR-5662). Every
 * condition that used to be a line in this function is now a case inside
 * `resolveGateSet`, which is the only thing that knows what a card SHOULD hold. Where
 * each one went, because a condition that quietly evaporates in a conversion is a
 * previously-paid-for bug arriving again with a green suite behind it:
 *
 * · `prMergeMode !== 'manual'` → the predicate's `prMergeMode` input.
 * · every member is a merge candidate → the members' `isMergeCandidate`, which is
 *   {@link mergeCandidateHead}'s answer. **MOTIR-5604's refusal**, and its
 *   `console.warn` is still here — improved, because the loader hands back WHICH
 *   member is not a candidate instead of stopping at the first.
 * · the same commits are never asked about twice → `alreadyDecided` over the set
 *   version. **MOTIR-5632's rule**, unchanged in content.
 * · at least one delivery → an empty set has no version, so no merge gate is owed.
 * · no `awaiting` gate of this kind already → still HERE, and deliberately: it is not
 *   a rule about what the card should hold, it is this writer not writing a row that
 *   exists. The predicate answers *what should be awaiting*; two callers racing on
 *   the same answer is what the card's row lock and this check resolve.
 *
 * ⚠️ AND THE RUN-TARGET REFUSAL IS GONE — `if (resolveRunTargetFor(item).kind ===
 * 'ancestor') return false`, one of MOTIR-5652's two root causes. `resolveRunTargetFor`
 * answers *whose How to test is this*, which is a true and useful question; it was
 * never an answer to *does this card have something to decide*. In a parent run the
 * How-to-test record is written once onto the PARENT, so every child resolved to
 * `ancestor` and raised nothing, while the parent's own promotion was skipped by
 * `ContainerHasOpenChildrenError` — no gate anywhere. `resolveRunTargetFor` itself is
 * untouched.
 *
 * ⚠️ BUT THE CARD'S STATUS IS A CONDITION AGAIN, AND THAT PARENT IS ASKED NOTHING
 * (MOTIR-6971; `approval-gates.md` §8's EIGHTH AMENDMENT). The run-target refusal was
 * the wrong question; *is the card in review* is the right one, and removing the first
 * left nothing asking it. A parent held below `implemented` by an open child is a run
 * that has not settled its status, and green CI is not that statement — so the gate
 * now waits for `in_review` (`resolveGateSet`'s `cardInReview`). MOTIR-6914 was that
 * parent, asked at `in_progress`, and its press could only throw.
 */
export async function raisePullRequestApprovalGate(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const set = await gateSetFor(item, tx);
  if (!set.awaited.some((gate) => gate.kind === KIND) && set.blockedMembers.length > 0) {
    // Every caller has just judged this set green, so a member that is not a merge
    // candidate is the refusal worth naming (MOTIR-5604): the card goes unapprovable
    // until the next green, and nothing else on the page says why.
    console.warn('[pullRequestApprovalGates] raise refused: a member is not a merge candidate', {
      workItemId: item.id,
      members: set.blockedMembers,
    });
  }
  return (await reconcileGatesFor(item, tx)).includes(KIND);
}

/**
 * Ask the predicate what `workItemId` should hold NOW and raise it — the statement
 * that runs immediately after each withdrawal below (Subtask MOTIR-5663).
 *
 * The item is re-read on `tx` because these three functions are handed a pull
 * request, not a card, and the raise needs the row's workspace, project and routing
 * target. Missing means the card is not visible to this transaction, which is the
 * same end state as nothing being owed.
 */
async function reraiseAfterWithdrawal(
  workItemId: string,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<void> {
  const item = await workItemRepository.findById(workItemId, tx);
  if (item) await reconcileGatesFor(item, tx, signals);
}

/**
 * Is the card's awaiting ACCEPTANCE question no longer owed? Each withdrawer below then
 * supersedes it with its own cause —
 * the story-run half of the MOTIR-5903 amendment (`approval-gates.md` §1, point 1).
 *
 * On a story run the acceptance video is EVIDENCE for the one approve-to-merge decision,
 * so it is asked exactly while the set is green. Every event that withdraws the merge
 * question for a set that stopped being mergeable — a head move, a close, a draft, a set
 * change — therefore withdraws it too, with the same cause. Asked through the predicate
 * rather than decided here, so a question that IS still owed (a subtask-run story whose
 * subtree is settled, or a set still green after an event about a different member) is
 * left exactly where it is.
 */
async function acceptanceNoLongerOwed(
  workItemId: string,
  tx: Prisma.TransactionClient,
  signals: GateSetSignals = {},
): Promise<boolean> {
  const awaiting = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).some(
    (row) => row.kind === ACCEPTANCE_KIND,
  );
  if (!awaiting) return false;
  // The awaiting gate row just read holds a foreign key to this card (cascading delete),
  // so inside this transaction the card exists.
  const item = (await workItemRepository.findById(workItemId, tx))!;
  const set = await gateSetFor(item, tx, signals);
  return !set.awaited.some((gate) => gate.kind === ACCEPTANCE_KIND);
}

/**
 * WITHDRAW on a HEAD MOVE: for every card this pull request delivers, supersede its awaiting
 * approve-and-merge gate when the set's CURRENT version differs from the one the gate asked
 * about.
 *
 * `headSha` is the head a `pull_request` delivery carries; without one each member's head is
 * its latest check run's commit — the rule the version was written with, so a late row for
 * an OLD commit withdraws nothing. Nothing is superseded while any member's head is unknown.
 * Returns the count.
 *
 * ⚠️ THE CURRENT VERSION IS MEASURED OVER THE CARD'S OWN SET (Bug MOTIR-11695) — the set
 * `gateSetFor` raised both gates over, less every pull request an ancestor also delivers.
 * Over every linked row, a child sharing one pull request with its story never matched its
 * own gates' version, so every head move on ANY member — the story's pull request included
 * — withdrew the child's review and merge questions and asked them again. The same holds
 * for the CI-rerun retirement below.
 */
export async function withdrawPullRequestApprovalGatesOnHeadMove(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
  headSha?: string,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    const signals: GateSetSignals = { movedHead: { pullRequestId, headSha } };
    const awaitingRows = await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx);
    const gate = awaitingRows.find((row) => row.kind === KIND);
    // ⚠️ THE REVIEW AGENT'S QUESTION RIDES THE SAME VERSION (MOTIR-6819; §12.5). It is
    // awaiting INSTEAD of the merge gate while the switch is on, so it is withdrawn on its
    // own version check — before, and independently of, the merge gate's below.
    const review = awaitingRows.find((row) => row.kind === REVIEW_KIND);
    let reviewWithdrawn = false;
    if (review) {
      const deliveries = await listOwnDeliveriesWithChecks(workItemId, tx);
      const current = deliverySetVersion(
        deliveries.map((delivery) =>
          deliveryMemberVersion(
            delivery,
            delivery.githubPullRequestId === pullRequestId ? headSha : undefined,
          ),
        ),
      );
      if (current && current !== review.subjectVersion) {
        reviewWithdrawn = (await withdrawAgentReview(workItemId, 'head_moved', tx)) > 0;
      }
    }
    if (!gate) {
      // No merge question to retire — but a story run's acceptance question may be
      // awaiting on its own (an `auto` project raises no merge gate), and a moved head
      // makes the set it is evidence for not green (MOTIR-5903).
      if (await acceptanceNoLongerOwed(workItemId, tx, signals)) {
        await approvalGateRepository.supersedeAwaitingByWorkItem(
          workItemId,
          ACCEPTANCE_KIND,
          'head_moved',
          tx,
        );
        await reraiseAfterWithdrawal(workItemId, tx, signals);
      } else if (reviewWithdrawn) {
        await reraiseAfterWithdrawal(workItemId, tx, signals);
      }
      continue;
    }
    const deliveries = await listOwnDeliveriesWithChecks(workItemId, tx);
    const current = deliverySetVersion(
      deliveries.map((delivery) =>
        deliveryMemberVersion(
          delivery,
          delivery.githubPullRequestId === pullRequestId ? headSha : undefined,
        ),
      ),
    );
    if (!current || current === gate.subjectVersion) continue;
    // Named, so a gate raised and withdrawn again in the same minute can be traced to
    // the head each side read (MOTIR-5604).
    console.warn('[pullRequestApprovalGates] withdrawn on a head move', {
      workItemId,
      pullRequestId,
      asked: gate.subjectVersion,
      current,
    });
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'head_moved',
      tx,
    );
    // The acceptance question rides on the same green set (MOTIR-5903).
    if (await acceptanceNoLongerOwed(workItemId, tx, signals)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'head_moved',
        tx,
      );
    }
    // ⚠️ AND ASK WHAT THE CARD SHOULD HOLD NOW (MOTIR-5663). The commits just
    // changed, so the new head has no verdict yet and the predicate answers *no
    // merge gate* — the NEXT green raises it. That is the case worth stating,
    // because it is the one that makes this call look pointless: it is not the
    // re-raise that matters here, it is that the re-ask happens at all. A design
    // gate the card is owed and does not have goes up from the same statement.
    await reraiseAfterWithdrawal(workItemId, tx, signals);
  }
  return withdrawn;
}

/**
 * WITHDRAW on CLOSE, merged or not: a closed member means the set the question was asked
 * about is no longer the set anybody can merge. Every card the pull request delivers loses
 * its awaiting gate; a gate already decided is untouched.
 */
export async function withdrawPullRequestApprovalGatesOnClose(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'member_closed',
      tx,
    );
    await withdrawAgentReview(workItemId, 'member_closed', tx);
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'member_closed',
        tx,
      );
    }
    await reraiseAfterWithdrawal(workItemId, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on a DRAFT: a member was converted back to a draft (MOTIR-5699), so its author
 * has taken the set out of review and the host will not merge it. Every card the pull
 * request delivers loses its awaiting gate, and the re-ask raises no merge gate while the
 * member stays a draft — `mergeCandidateHead` refuses one. Marking it ready again is what
 * re-asks (`changeRequestStatusSync`'s ready-flip). A gate already decided is untouched.
 */
export async function withdrawPullRequestApprovalGatesOnDraft(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'member_drafted',
      tx,
    );
    await withdrawAgentReview(workItemId, 'member_drafted', tx);
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'member_drafted',
        tx,
      );
    }
    await reraiseAfterWithdrawal(workItemId, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on a CONFLICT: the host reports a member `dirty` — it no longer combines with
 * its base (MOTIR-5914, for bug MOTIR-5907; design/github § 30 rule 1). One unmergeable
 * member makes the whole set unmergeable (§ 28: one approval merges the set), so every
 * card the pull request delivers loses its WHOLE awaiting gate, as `conflict`. The re-ask
 * raises nothing while the reading stands — `mergeCandidateHead` refuses a member `dirty`
 * at its head — so the caller persists the reading BEFORE calling this. A push that
 * resolves the conflict replaces the reading (`synchronize`), and once the host's clean
 * answer at the new head is in and CI is green, the question is asked again (MOTIR-7063).
 *
 * ⚠️ GATES ONLY. The Implemented hold that goes with it is a STATUS write, which this
 * module may not reach (it imports no service — see the header), so it is composed by
 * `pullRequestMergeabilityService.withdrawForConflict`, the one entry point both the
 * base-branch push and the press call.
 */
export async function withdrawPullRequestApprovalGatesOnConflict(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'conflict',
      tx,
    );
    await withdrawAgentReview(workItemId, 'conflict', tx);
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'conflict',
        tx,
      );
    }
    await reraiseAfterWithdrawal(workItemId, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on a RED BUILD: CI reported a terminal FAILURE at the commits the question was
 * asked about (MOTIR-6271; `approval-gates.md` §8's amendment, decision 2).
 *
 * ⚠️ THIS IS THE CAUSE THE ENUMERATION WAS MISSING, NOT A NEW RULE. Decision 2 states the
 * governing principle over EVERY event — *the question rides on the green set, so every
 * event that takes the set out of green withdraws it … an unanswered question about a set
 * that is no longer green is not a question anybody can act on* — and then lists four
 * events, none of which is the most direct way a set stops being green. So a gate raised on
 * a green verdict and contradicted by the build minutes later stood for ever: the feedback
 * consumer re-rendered its comment as ❌ and recomputed `ciState` to `failing`, and the card
 * kept asking a person to approve a pull request whose suite was red.
 *
 * ⚠️ AND IT IS THE ACCEPTED ANSWER TO A FALLIBLE RAISE, WHICH IS WHY IT IS NOT MERELY A
 * TIDY-UP. `ci-verdict-expected-check-set.md` accepts, in its failure modes 1 and 3, that
 * the raise CANNOT be made exact: a host read sees only the runs GitHub has CREATED, and a
 * host that cannot be reached answers `null` and falls back to the recorded set. Both leave
 * a window in which a verdict is formed over a partial set, and this is the correction the
 * ADR's own principle prescribes for it.
 *
 * ⚠️ GATES ONLY — the Implemented hold that goes with it is a STATUS write, which this
 * module may not reach (it imports no service; see the header). `ciPromotion`'s
 * `withdrawDeliveredCardsOnRed` composes the two, exactly as
 * `pullRequestMergeabilityService.withdrawForConflict` does for the conflict class.
 *
 * A gate a person already DECIDED is untouched, as with every cause here: §8's decision 5
 * settles that a failure after approval re-opens the merge question alone, through its own
 * doors.
 */
export async function withdrawPullRequestApprovalGatesOnCiFailure(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  let withdrawn = 0;
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    withdrawn += await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'ci_failed',
      tx,
    );
    await withdrawAgentReview(workItemId, 'ci_failed', tx);
    // The acceptance question rides on the same green set (MOTIR-5903): a story run's
    // receipt is evidence for the one approve-to-merge decision, so a red build retires it
    // with the merge question under the same cause.
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'ci_failed',
        tx,
      );
    }
    // Ask what the card should hold NOW (MOTIR-5663). The verdict is red, so the predicate
    // answers *no merge gate* and nothing goes back up — the NEXT green raises it. A design
    // gate the card is owed and does not have still goes up from the same statement.
    await reraiseAfterWithdrawal(workItemId, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW when the set leaves green WITHOUT going red: a check at the very commits the
 * question was asked about is `pending` again (MOTIR-6946; `approval-gates.md` §8's
 * amendment, decision 2).
 *
 * ⚠️ THE OTHER HALF OF THE ASYMMETRY `ci_failed` CLOSED ONE ARM OF. A gate raised over a
 * set that looked green — a workflow run GitHub had created but that had not created a job
 * yet, a re-run of a finished check, a slow App reporting late — stood `awaiting` for the
 * whole of the run that followed, so a person could press *Approve and merge* over commits
 * whose tests had not finished. Green → `running` at an unchanged head is none of the
 * other causes: no head moved, no member closed, nothing failed.
 *
 * ⚠️ ONLY AT THE GATE'S OWN VERSION. A pending row for a NEW head is a push, which
 * `withdrawPullRequestApprovalGatesOnHeadMove` retires as `head_moved` — the same delivery
 * calls it first — so a gate whose asked-about set no longer matches the current one is
 * left to that cause rather than mislabelled here.
 *
 * The caller has already established that the pull request's live set at its head reads
 * `running` (`derivePrCiState`); this retires the question, and the re-ask raises nothing
 * while it runs — the NEXT green raises exactly one fresh gate. Returns the cards whose
 * merge question it retired, which are the only cards the caller moves. GATES ONLY, like
 * `…OnCiFailure`: `ciPromotion`'s `withdrawDeliveredCardsOffGreen` composes the status
 * move. A DECIDED gate is untouched (§8's decision 5).
 */
export async function withdrawPullRequestApprovalGatesOnCiRerun(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const withdrawn: string[] = [];
  for (const { workItemId } of await workItemDeliveryRepository.listByPullRequest(
    pullRequestId,
    tx,
  )) {
    const awaiting = await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx);
    const gate = awaiting.find((row) => row.kind === KIND);
    // The REVIEW stands where the merge question would (Story MOTIR-1626; `approval-gates.md`
    // §12.2), so a set that leaves green retires it the same way — only at its own version,
    // cancelling its run — and the next green asks it again (§12.5: a WITHDRAWN review is
    // owed again at the same head).
    const review = awaiting.find((row) => row.kind === REVIEW_KIND);
    if (gate || review) {
      const deliveries = await listOwnDeliveriesWithChecks(workItemId, tx);
      const current = deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d)));
      let retired = 0;
      if (gate && current && current === gate.subjectVersion) {
        retired += await approvalGateRepository.supersedeAwaitingByWorkItem(
          workItemId,
          KIND,
          'ci_rerunning',
          tx,
        );
      }
      if (review && current && current === review.subjectVersion) {
        retired += await withdrawAgentReview(workItemId, 'ci_rerunning', tx);
      }
      if (retired === 0) continue;
      withdrawn.push(workItemId);
    }
    // The acceptance question rides on the same green set (MOTIR-5903) — and an `auto`
    // project raises no merge gate, so it can be the only question standing. Asked
    // through the predicate, which leaves one still owed exactly where it is.
    if (await acceptanceNoLongerOwed(workItemId, tx)) {
      await approvalGateRepository.supersedeAwaitingByWorkItem(
        workItemId,
        ACCEPTANCE_KIND,
        'ci_rerunning',
        tx,
      );
    }
    await reraiseAfterWithdrawal(workItemId, tx);
  }
  return withdrawn;
}

/**
 * WITHDRAW on a SET CHANGE: a delivery row joined or left this card, so the set its gate
 * asked about is not the set it now carries. Called by every writer of `work_item_delivery`
 * (`githubPullRequestService`'s two link arms and two unlink arms), only when the write
 * actually changed the set.
 */
export async function withdrawPullRequestApprovalGateOnSetChange(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<number> {
  const withdrawn = await approvalGateRepository.supersedeAwaitingByWorkItem(
    workItemId,
    KIND,
    'set_changed',
    tx,
  );
  await withdrawAgentReview(workItemId, 'set_changed', tx);
  if (await acceptanceNoLongerOwed(workItemId, tx)) {
    await approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      ACCEPTANCE_KIND,
      'set_changed',
      tx,
    );
  }
  await reraiseAfterWithdrawal(workItemId, tx);
  return withdrawn;
}
