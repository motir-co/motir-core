import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceContext,
} from '@/lib/workspaces/context';
import type { GithubCheckRun, Prisma, WorkItem } from '@/generated/prisma/client';
import { prCiStateAtHead } from '@/lib/github/pullRequestHead';
import {
  readReportedCheckSet,
  reconcileRecordedCheckSet,
  shaToReReadFromHost,
} from './checkSetReconcile';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import {
  collectDeliveries,
  classifyDeliveries,
  standingQueueFailures,
  type DeliveredPullRequest,
} from './deliveryVerdict';
import {
  isConflictedAtCurrentHead,
  isMergeabilityOwedAtCurrentHead,
  isOutOfDateAtCurrentHead,
} from '@/lib/github/mergeability';
import { deliverySetIsGreen, deliveryStateForPromotion } from '@/lib/workItems/deliverySet';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from './workItemsService';
import { resolveChangeRequestWorkItemSet } from './changeRequestWorkItems';
import { settleGreenVerdict, type AutoMergeRequest } from './mergeGates';
import { queueExitCardMoves, settleUnlandedOutcome } from './mergeQueueExitService';
import { resolveDeliveredWorkItems } from './changeRequestWorkItems';
import {
  raisePullRequestApprovalGate,
  withdrawPullRequestApprovalGatesOnCiFailure,
  withdrawPullRequestApprovalGatesOnCiRerun,
} from './pullRequestApprovalGates';
import { evaluateAfterRaise } from './pullRequestReviewSync';
import { gateSetFor } from './gateSetFor';
import { sendEvent } from '@/lib/jobs/sendEvent';
import {
  ContainerHasOpenChildrenError,
  ApprovalGatePendingError,
  PlanTargetHeldError,
  IllegalTransitionError,
  MarkedCardCannotReopenError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// CI GREEN IS WHAT MAKES A CARD REVIEWABLE (MOTIR-3006).
//
// `implemented` says the code is pushed and the pull request is open; In Review
// says a human should look at it. The only thing entitled to move a card between
// those two is the build, and this module is where that happens — for EVERY card
// the pull request delivers, not for the one its link column happens to name.
//
// ── TWO EDGES, ONE VERDICT ──────────────────────────────────────────────────
// The run pushes BEFORE it transitions (MOTIR-3004 — `implemented` confirms the
// push rather than predicting it), so the green verdict can arrive first:
//
//   agent pushes → CI starts → CI goes GREEN → agent transitions to implemented
//                                   ↑                       ↑
//                        edge 1 fires and finds        edge 2 fires here
//                        nothing at `implemented`      and finds the green
//
// So the promotion is a LATCH, not an edge: it is evaluated both when CI reports
// and when a card ARRIVES at `implemented`, from the SAME durable verdict. The
// check rows are persisted, so edge 2 re-reads state that already exists rather
// than inventing a record or a queue.
//
// ⚠️ The window is NOT closed by widening the source states. Accepting
// `in_progress → in_review` on green would promote a card whose agent died
// before it finished, and would break the idempotence the `implemented` guard
// gives for free. The state stays `implemented`; what changes is WHEN the
// question gets asked.
//
// ── THE VERDICT IS `derivePrCiState`, DELIBERATELY ──────────────────────────
// Both edges ask the shipped per-PR derivation over ALL of a change request's
// rows, which computes at the LATEST recorded sha. That single choice buys three
// of this card's guards at once: a still-pending aggregate is `running` (not
// promoted), a failure is `failing` (not promoted), and a green run for a
// SUPERSEDED sha loses to the newer push's rows (not promoted). Re-deriving any
// of them here would be a second opinion that could drift from the pill a person
// reads on the Development surface.
//
// ⚠️ AMENDED BY MOTIR-7005: "the latest recorded sha" is now the pull request's
// STORED head (`prCiStateAtHead`), not the newest check row's commit. A push that
// produced no CI (every push to a conflicting pull request) left the rows at the old
// green commit, and the latest-sha reading promoted that commit every reconcile tick.
// A head with no rows reads `null` — not reported yet — and withholds.

/**
 * The refusals a promotion TOLERATES, per card.
 *
 * Each is a legitimate answer from a project's own workflow or permissions —
 * a custom workflow with no `in_review`, a missing edge to it, an actor without
 * edit rights there — and none of them says anything about the OTHER cards the
 * same run delivered. Anything not on this list is a real fault and is rethrown.
 */
const SKIPPABLE = [
  IllegalTransitionError,
  UnknownStatusError,
  ProjectAccessDeniedError,
  // The container-completeness gate (MOTIR-3229). A green build says nothing
  // about a card's own children, so a CONTAINER whose children are not landed is
  // refused In Review — and that refusal is precisely what the card is for: In
  // Review is a promise to a person, and MOTIR-1343 made it over two `todo`
  // children. Skippable rather than fatal for this list's stated reason: it says
  // nothing about the OTHER cards the same run delivered.
  ContainerHasOpenChildrenError,
  // The approval-gate guard (MOTIR-5526). No kind registered today owns
  // `in_review`, but the guard reads the registry rather than a literal, so a
  // kind that did would refuse this promotion for that one card — which, like
  // the rest of this list, says nothing about the other cards the run delivered.
  ApprovalGatePendingError,
  // THE PLAN HOLD (MOTIR-6265; AMENDMENT 21 §5(b)). A promotion only ever moves a
  // card out of `implemented`, so it cannot meet a held card today — listed so a
  // widened source status inherits the right answer rather than a failed job.
  PlanTargetHeldError,
  // A MARKED card stays finished (MOTIR-6672 · MOTIR-6681). A promotion moves a
  // card from `implemented` to `in_review`, both outside the done category; a card
  // marked under the rule is `done` and never here, but a LEGACY card marked while
  // open is, and the mark refuses its promotion — which, like the rest of this list,
  // says nothing about the other cards the run delivered.
  MarkedCardCannotReopenError,
];

/** The ONLY status a promotion moves a card out of. */
const SOURCE_STATUS = 'implemented';
/** The status CI green moves it to. */
const TARGET_STATUS = 'in_review';
/**
 * The statuses a card can hold while its merge gates are still a live question —
 * where a green verdict RE-RAISES a gate a head move withdrew (MOTIR-5515). A card
 * the promotion moves never passes through here: its gates are raised in the
 * promotion's own transaction.
 */
const REVIEW_STATUSES: readonly string[] = ['in_review', 'approved'];
/** The status an approval writes — a card there whose commits moved is asked again at
 *  `in_review` (MOTIR-6971). */
const APPROVED_STATUS = 'approved';

/**
 * Would this `approved` card owe a merge question over its CURRENT set if it were in
 * review? The predicate answers it — the card's own status read as `in_review` — so the
 * move back to review happens only when a question is genuinely owed (MOTIR-6971).
 */
async function asksAgainInReview(item: WorkItem, tx: Prisma.TransactionClient): Promise<boolean> {
  const set = await gateSetFor({ ...item, status: TARGET_STATUS }, tx);
  return set.awaited.some((gate) => gate.kind === 'pull_request_approval');
}

// `collectDeliveries` — every pull request that delivers this card — MOVED to
// `deliveryVerdict.ts` (MOTIR-5470), and imported at the top of this file. It was
// extracted here (MOTIR-4199) so the check-set reconcile could address exactly the
// same members the judgement will; it now serves a THIRD reader, the card's own
// stored `ciState`, which is a different question folded off the same set. Its doc
// block, including why the set is a union, travels with it.

/**
 * IS EVERY PULL REQUEST DELIVERING THIS CARD GREEN? (Story MOTIR-3655 ·
 * MOTIR-3685.)
 *
 * ── ONE function, called by BOTH edges ────────────────────────────────────
 * The latch only works if the two edges ask the same question of the same set.
 * Edge 1 fires because a pull request reported; edge 2 fires because a card
 * arrived at `implemented`. If one counted ANY and the other counted EVERY, a
 * card would be reviewable or not depending on which edge happened to run — and
 * nobody could tell which answer was the wrong one.
 *
 * ── The set is a UNION, deliberately, for the length of the EXPAND window ──
 * `work_item_delivery` holds rows the singular link column structurally cannot
 * (a `motir auto` pull request delivering twelve cards), and the column holds
 * rows the table has not been told about (`historicalPullRequestBackfillService`
 * resolves a card by parsing the title and writes only the column). Neither is
 * complete on its own today, and this is the ONE place where dropping a member
 * is dangerous in the direction that matters: a missed red pull request promotes
 * a card that is not reviewable. Deduplicated on the pull request's own id, so a
 * row recorded on both sides is counted once. The union collapses when
 * MOTIR-3672 retires the parse.
 *
 * The verdict per member is `prCiStateAtHead` — `derivePrCiState`'s precedence over
 * the rows AT the pull request's stored head (MOTIR-7005). A second opinion here would drift from what a person
 * reads on the card it is deciding about.
 *
 * ── ONE AMENDMENT, AND IT IS THE PROMOTION'S ALONE (MOTIR-3823) ───────────
 * `derivePrCiState`'s `null` means "no check rows", which is true of a
 * repository with NO CI and of one that has not reported YET. The first counts
 * as green and the second must withhold, so this function asks a second question
 * — of the REPOSITORY, since the pull request cannot tell them apart — and maps
 * the member through `deliveryStateForPromotion` before the set is judged. The
 * derivation itself is untouched: every surface that renders `null` as "no CI
 * pill" keeps doing so.
 */
async function everyDeliveryIsGreen(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  // ⚠️ THE SECOND QUESTION — asked inside `classifyDeliveries` (MOTIR-3823), and
  // asked there rather than here (MOTIR-5470) because the CARD's own `ciState` has
  // to ask exactly the same one of exactly the same members. `derivePrCiState`
  // returns `null` both for a repository that has no CI and for one that has
  // simply not reported yet, and the two must be read oppositely: the first is
  // green, the second withholds. What stays HERE is the promotion's own reading of
  // that classification — `deliveryStateForPromotion`, which maps the withholding
  // case to `null` because `deliverySetIsGreen` has no third answer to give.
  const members = await classifyDeliveries(item, tx);

  return deliverySetIsGreen(members.map((m) => deliveryStateForPromotion(m.state, m.cannotReport)));
}

/**
 * IS THIS CARD HELD BY A MERGE-QUEUE FAILURE? (Story MOTIR-5461 · MOTIR-5632;
 * `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 6.)
 *
 * True when ANY pull request delivering it has a latest queue exit that is a
 * `failure`, has not been re-queued, and was recorded at that pull request's
 * CURRENT head.
 *
 * ⚠️ WHY A GREEN SET IS NOT ENOUGH HERE. A queue ejects on the MERGE GROUP's checks;
 * the pull request's own checks at its head are still green. Without this hold the
 * card the ejection just moved to `implemented` would be promoted straight back —
 * by edge 2 the moment it arrived, or by edge 1 on the next check event at that
 * head — and the promotion's gate raise would ask a person to approve commits they
 * already approved.
 *
 * It lifts in exactly two ways: a PUSH moves the head, so the exit no longer names
 * the current head and the next green verdict promotes (with ONE fresh gate over
 * the new heads); or *Queue again* stamps the exit and moves the card itself.
 *
 * "Current head" is `pullRequestHead` — the rule the gate's own `subjectVersion` is
 * written with (`deliveryMemberVersion`), so the two cannot disagree about which
 * commit a member is at (MOTIR-7005).
 */
async function heldByQueueFailure(
  byId: Map<string, { headSha: string | null; checkRuns: GithubCheckRun[] }>,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  // The rule is `queueExitHoldsAtHead` (MOTIR-5717), shared with the card's own
  // `ciState` fold — so the badge reads *failing* exactly while this hold refuses.
  return (await standingQueueFailures(byId, tx)).size > 0;
}

/**
 * THE PROMOTION VERDICT — every delivering pull request green, and no merge-queue
 * failure holding the card (MOTIR-5632). The ONE question all three callers ask
 * (edge 1, edge 2 and the re-raise), for the reason `everyDeliveryIsGreen`'s own
 * doc gives: two answers depending on which edge fired is a latch nobody can trust.
 */
async function isPromotable(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  if (!(await everyDeliveryIsGreen(item, tx))) return false;
  const byId = await collectDeliveries(item, tx);
  if (heldByConflict(byId)) return false;
  return !(await heldByQueueFailure(byId, tx));
}

/**
 * THE CONFLICT HOLD (MOTIR-5913, for bug MOTIR-5907; design/github § 30 rule 2) —
 * true while any OPEN delivering pull request is stored `dirty` at its current head,
 * OR `behind` there (MOTIR-10054), OR its reading is still OWED there (MOTIR-7063).
 *
 * A conflict is the CAN'T-LAND class however it is found (§ 28's class table): a card
 * whose set cannot combine with its base stays at Implemented, because In Review
 * means a person is being asked and nobody should be. It lifts the way the queue hold
 * does — a PUSH replaces the reading (`synchronize`) — and then the host's answer at the
 * new head decides.
 *
 * ⚠️ OWED IS HELD, NOT CLEAN (MOTIR-7063). The push used to clear the reading to `null`,
 * which this read as "no conflict": a head pushed onto a base that had already moved
 * past it went green, was promoted, and asked a person to approve a merge the host
 * would refuse — for as long as the reconcile tick took to find the row quiet. So a
 * member whose reading is owed at its head holds the card until the answer lands; the
 * `pull-request/head-moved` re-read that answers it re-runs this latch on a clean answer
 * (`pullRequestMergeabilityService.releaseHeldPromotion`), and the reconcile tick is the
 * backstop for both.
 */
function heldByConflict(byId: Map<string, DeliveredPullRequest>): boolean {
  for (const pr of byId.values()) {
    if (pr.state !== 'open' || pr.merged) continue;
    if (isConflictedAtCurrentHead(pr) || isMergeabilityOwedAtCurrentHead(pr)) return true;
    // ⚠️ AND SO IS A MEMBER OUT OF DATE WITH A BASE THAT REQUIRES IT (Bug MOTIR-10054):
    // the host refuses its merge however green it is, so it is brought up to date — by a
    // push, which re-reads it — before anybody is asked. To fix lists it meanwhile.
    if (isOutOfDateAtCurrentHead(pr)) return true;
  }
  return false;
}

/**
 * EDGE 1 — CI has just reported a terminal verdict for one change request.
 *
 * Promotes every card that change request delivers and that currently sits at
 * `implemented`. Best-effort by construction: it runs AFTER the feedback
 * comment and the `ciState` write have committed, and a failure here must never
 * turn a recorded verdict into a webhook the host retries forever.
 *
 * Returns the ids it promoted, so a caller can report how many rather than
 * asserting one.
 */
export async function promoteDeliveredCardsOnGreen(args: {
  changeRequestId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<string[]> {
  const targets = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, args.workspaceId);
    const none = { promote: [] as string[], reRaise: [] as string[] };
    const pr = await githubPullRequestRepository.findByIdWithInstallation(args.changeRequestId, tx);
    if (!pr) return none;
    if (prCiStateAtHead(pr) !== 'passing') return none;

    // ⚠️ THE PULL REQUEST, NOT A CARD READ OFF IT (MOTIR-3721). This used to
    // resolve the pull request's own link column and hand the resolver a single
    // `linked` ref, which
    // capped an explicitly-linked pull request at ONE promoted card whatever its
    // delivery set held — the cap lived in a `| null` parameter, not in a column,
    // which is why no grep of the link column ever found it (ADR §2).
    const set = await resolveChangeRequestWorkItemSet({
      workspaceId: args.workspaceId,
      headRef: pr.headRef,
      githubPullRequestId: pr.id,
      tx,
    });
    // Only the cards at `implemented`. A sibling a human moved back to In
    // Progress to rework must not be yanked forward by a green run.
    const atImplemented = set.items.filter((item) => item.status === SOURCE_STATUS);

    // ⚠️ AND ONLY THE ONES WHOSE WHOLE SET IS GREEN (MOTIR-3685). This pull
    // request going green is what WOKE the promotion; it is not what decides it.
    // A card this pull request delivers may also be delivered by another that is
    // red or still running, and announcing it reviewable on half its evidence is
    // the defect. Evaluated per card, because the answer genuinely differs
    // between two cards the same pull request delivers.
    const green: string[] = [];
    for (const item of atImplemented) {
      // `set.items` carries no `sessionBranch`, and the legacy branch join needs
      // it — so the row is re-read rather than guessed at.
      const row = await workItemRepository.findById(item.id, tx);
      if (row && (await isPromotable(row, tx))) green.push(item.id);
    }

    // ⚠️ AND THE CARDS ALREADY IN REVIEW (MOTIR-5515). A card that went green, was
    // promoted and had a gate withdrawn by a push stays in review — so the green
    // verdict for its new head is the moment its fresh gate is owed, and the
    // `implemented` filter above would never reach it. Their verdict is judged under
    // the card's lock, in `reRaiseMergeGates`.
    const reRaise = set.items
      .filter((item) => REVIEW_STATUSES.includes(item.status))
      .map((item) => item.id);
    return { promote: green, reRaise };
  });

  const ctx = { userId: args.actorUserId, workspaceId: args.workspaceId };
  const promoted = await promoteEach(targets.promote, ctx);
  await reRaiseMergeGates(targets.reRaise, ctx);
  return promoted;
}

/**
 * THE OTHER DIRECTION OF THE LATCH — CI has just reported a terminal FAILURE
 * (MOTIR-6271; `approval-gates.md` §8's amendment, decision 2).
 *
 * ⚠️ WHY IT BELONGS BESIDE THE PROMOTION AND NOT IN THE FEEDBACK CONSUMER. This module is
 * the ONE place a CI verdict is allowed to move a card between `implemented` and
 * `in_review` — the header above says so of the green direction, and a red verdict moving
 * it back is the same authority exercised the other way. Splitting them would give the
 * pair two homes and let them drift about which statuses they touch, which is the defect
 * `everyDeliveryIsGreen`'s own doc block argues against for the two green edges.
 *
 * It withdraws the approve-to-merge question over every card the change request delivers,
 * and HOLDS at Implemented each card that was waiting on a person. The shape is
 * `pullRequestMergeabilityService.withdrawForConflict`'s, deliberately: a red build and a
 * conflict are the same CAN'T-LAND class (§ 28's class table) reached from two directions,
 * so they take the same lock order, the same `settleUnlandedOutcome` and the same
 * only-a-card-at-`in_review`-moves rule.
 *
 * ⚠️ ONLY A CARD AT `in_review` MOVES. That is where a person is being asked; a card at
 * Implemented already, Approved mid-merge, or in a terminal status is left exactly where it
 * is — the gate is still withdrawn, which is the part that matters for *To approve*. A
 * DECIDED gate is untouched on every path (§8's decision 5).
 *
 * Best-effort, like the promotion: it runs after the feedback comment and the `ciState`
 * write have committed, and it must never turn a recorded verdict into a webhook the host
 * retries for ever.
 */
export async function withdrawDeliveredCardsOnRed(args: {
  changeRequestId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<{ withdrawn: number; moved: string[] }> {
  return withdrawDeliveredCardsOffGreen(args, 'failing');
}

/**
 * THE SAME WITHDRAWAL, FOR A SET THAT LEFT GREEN WITHOUT GOING RED (MOTIR-6946).
 *
 * A check at the head is `pending` again — a workflow run the raise could not see, a
 * re-run, an App reporting late — so the approve-to-merge question was asked over a set
 * whose verdict is not in. Everything `withdrawDeliveredCardsOnRed` says above holds, with
 * one difference in what is retired: the gate goes only where it asked about the commits
 * that are running now (`withdrawPullRequestApprovalGatesOnCiRerun`), and the card is
 * held at Implemented as `cant_land` for THIS verdict only — no hold is recorded, so the
 * next green at the same head promotes it again and raises exactly one fresh gate.
 */
export async function withdrawDeliveredCardsOnRerun(args: {
  changeRequestId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<{ withdrawn: number; moved: string[] }> {
  return withdrawDeliveredCardsOffGreen(args, 'running');
}

async function withdrawDeliveredCardsOffGreen(
  args: {
    changeRequestId: string;
    workspaceId: string;
    actorUserId: string;
  },
  verdict: 'failing' | 'running',
): Promise<{ withdrawn: number; moved: string[] }> {
  const ctx = { userId: args.actorUserId, workspaceId: args.workspaceId };
  const outcome = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, args.workspaceId);
    const pr = await githubPullRequestRepository.findByIdWithInstallation(args.changeRequestId, tx);
    // ⚠️ RE-DERIVE, never trust the delivery that woke us. The event that called this is one
    // check; the question is whether the PULL REQUEST is red (or running) at its latest
    // head, which is the same reading `prCiStateAtHead` gives the promotion. A single red
    // check on a superseded run must retire nothing.
    if (!pr || prCiStateAtHead(pr) !== verdict) {
      return { withdrawn: 0, moved: [] as string[] };
    }
    const refs = await resolveDeliveredWorkItems(args.changeRequestId, tx);
    // LOCK ORDER — each card's awaiting gates, then the card (ADR §6d amendment, rule 8),
    // the order `applyStatusTransition` takes them in.
    for (const ref of refs) await queueExitCardMoves.lockCard(ref.id, tx);
    // A running set moves only the cards whose question it just retired: a card whose
    // gate asked about OTHER commits is a head move's to retire, and a card with no merge
    // question (an `auto` project) was never asked to approve anything.
    let withdrawn: number;
    let movable: readonly { id: string }[] = refs;
    if (verdict === 'failing') {
      withdrawn = await withdrawPullRequestApprovalGatesOnCiFailure(args.changeRequestId, tx);
    } else {
      const retired = new Set(
        await withdrawPullRequestApprovalGatesOnCiRerun(args.changeRequestId, tx),
      );
      withdrawn = retired.size;
      movable = refs.filter((ref) => retired.has(ref.id));
    }
    const moved: string[] = [];
    for (const ref of movable) {
      const item = await workItemRepository.findById(ref.id, tx);
      // `TARGET_STATUS` — the very status the green direction moves a card TO, read back
      // here as the only status the red direction moves one FROM. One constant for both,
      // so the pair cannot drift about which rung the person is being asked at.
      if (!item || item.status !== TARGET_STATUS) continue;
      const settled = await settleUnlandedOutcome(item, 'cant_land', ctx, tx);
      if (settled.transition) moved.push(item.id);
    }
    return { withdrawn, moved };
  });
  if (outcome.withdrawn > 0 || outcome.moved.length > 0) {
    console.warn(
      `[ciPromotion] a ${verdict === 'failing' ? 'red' : 'running'} build withdrew the approve-to-merge question`,
      {
        changeRequestId: args.changeRequestId,
        withdrawn: outcome.withdrawn,
        heldAtImplemented: outcome.moved.length,
      },
    );
  }
  return outcome;
}

/**
 * EDGE 2 — a card has just ARRIVED at `implemented`.
 *
 * Re-reads the change request's already-recorded verdict and promotes
 * immediately when it is terminally green, which is the case the push-first
 * ordering opens. A clean no-op for a card with no change request, an untracked
 * one, or one with no check rows yet — which is the ordinary case for a human
 * moving a card to Implemented by hand.
 *
 * Returns whether it promoted, so the caller can log it; never throws.
 */
export async function promoteIfCiAlreadyGreen(
  workItemId: string,
  ctx: { userId: string; workspaceId: string },
  /** The host reader, injectable for the same reason `applyCiStatusFeedback`
   *  takes its `resolveContext`: this edge has no delivery behind it, so there
   *  is no payload to carry a provider seam in, and a test that cannot supply
   *  one cannot exercise the partial-set case at all. Defaults to the real
   *  read; production callers pass nothing. */
  readCheckSet: typeof readReportedCheckSet = readReportedCheckSet,
  /** The clock the stale-pending re-read ages rows against, injectable for the
   *  same reason the reader is: a test must be able to place a row either side
   *  of the threshold without sleeping for it (MOTIR-5838). */
  now: Date = new Date(),
): Promise<boolean> {
  // ⚠️ THE OTHER DOOR INTO THE PARTIAL-SET DEFECT (MOTIR-4199). Edge 1 reaches
  // this module through the CI-feedback consumer, which has already reconciled
  // the commit's check set against the host before it forms a verdict. Edge 2
  // has no delivery behind it at all — it fires because a card ARRIVED at
  // `implemented`, which the run does moments after `gh pr create`, when the
  // recorded set is at its most partial. Left alone it would read three
  // successes as five and promote for exactly the reason edge 1 no longer does.
  //
  // So it asks the same question, of the same set, before it judges — and it is
  // paid for on the same terms: only the delivering pull requests whose recorded
  // set CLAIMS to be complete are asked about, so the ordinary card (one pull
  // request, checks still reporting pending rows) pays nothing.
  await reconcileClaimedCompleteDeliveries(workItemId, ctx, readCheckSet, now);

  const shouldPromote = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, ctx.workspaceId);
    const item = await workItemRepository.findById(workItemId, tx);
    // Re-read rather than trusting the caller: between the transition committing
    // and this running, the card may have moved again.
    if (!item || item.status !== SOURCE_STATUS) return false;

    // ⚠️ EVERY pull request delivering it, not ANY (MOTIR-3685) — and the SAME
    // function edge 1 asks, so the latch cannot answer two ways depending on
    // which edge happened to fire. This is what makes the LAST pull request's
    // green promote a card whose earlier ones went green hours ago.
    return isPromotable(item, tx);
  });

  if (!shouldPromote) return false;
  const promoted = await promoteEach([workItemId], ctx);
  return promoted.length > 0;
}

/**
 * Bring the recorded check set of every pull request delivering this card in
 * line with the host's, for the members whose recorded set makes a claim worth
 * checking — one asserting COMPLETENESS (MOTIR-4199) or one that has asserted
 * it is still RUNNING for longer than a check plausibly runs (MOTIR-5838).
 *
 * ⚠️ THE NETWORK READ IS OUTSIDE THE TRANSACTION, deliberately and structurally:
 * it is two phases — resolve the members to ask about, then ask the host and
 * write what is missing or unsettled — because a round trip inside
 * `withSystemContext` would hold a connection open on GitHub's latency for every
 * card arriving at Implemented.
 */
async function reconcileClaimedCompleteDeliveries(
  workItemId: string,
  ctx: { userId: string; workspaceId: string },
  readCheckSet: typeof readReportedCheckSet,
  now: Date,
): Promise<void> {
  try {
    // Phase 1 — WHICH pull requests claim a complete set, and everything needed
    // to ask about them. Resolved in ONE transaction, subject and all: reading
    // the repository back per candidate afterwards would open a window in which
    // the row can vanish, and then owe a `continue` for a race this shape simply
    // does not have.
    const candidates = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, ctx.workspaceId);
      const item = await workItemRepository.findById(workItemId, tx);
      if (item?.status !== SOURCE_STATUS) return [];
      const byId = await collectDeliveries(item, tx);

      const asking: {
        pullRequestId: string;
        commitSha: string;
        installationId: string;
        owner: string;
        name: string;
      }[] = [];
      for (const [pullRequestId, pr] of byId) {
        // The members whose own recorded set makes a claim worth checking — it
        // asserts it is WHOLE (MOTIR-4199), or it has asserted it is STILL
        // RUNNING for longer than a check plausibly runs (MOTIR-5838). The sha
        // comes back with the answer rather than from a second derivation that
        // could disagree with it.
        //
        // ⚠️ A FRESH PENDING ROW STILL COSTS NOTHING, which is the property
        // MOTIR-4199 paid for and this widening keeps: the ordinary pull
        // request, minutes old with lanes still reporting, qualifies under
        // neither arm and is not asked about.
        const commitSha = shaToReReadFromHost(pr.checkRuns, now);
        if (commitSha === null) continue;
        const subject = await githubPullRequestRepository.findByIdWithInstallation(
          pullRequestId,
          tx,
        );
        if (!subject) continue;
        asking.push({
          pullRequestId,
          commitSha,
          installationId: subject.repo.installation.installationId,
          owner: subject.repo.owner,
          name: subject.repo.name,
        });
      }
      return asking;
    });

    // Phase 2 — ask the host and write what is missing. ⚠️ THE ROUND TRIP IS
    // OUTSIDE THE TRANSACTION, structurally: a network read inside
    // `withSystemContext` would hold a connection open on GitHub's latency for
    // every card arriving at Implemented.
    for (const c of candidates) {
      const reported = await readCheckSet(c);
      if (reported === null) continue;
      await withSystemContext(async (tx) => {
        await bindWorkspaceContext(tx, ctx.workspaceId);
        const recorded = await githubCheckRunRepository.listByPrAndSha(
          c.pullRequestId,
          c.commitSha,
          tx,
        );
        await reconcileRecordedCheckSet({
          pullRequestId: c.pullRequestId,
          commitSha: c.commitSha,
          reported,
          recorded,
          tx,
        });
      });
    }
  } catch (err) {
    // Best-effort in the same sense the promotion itself is: this runs BEFORE a
    // verdict, and an unreachable host must cost the sharper answer rather than
    // the card. Whatever threw, the recorded set is exactly as it was — which is
    // the behaviour that shipped before this pass existed.
    console.warn('[ciPromotion] could not reconcile the check set; judging what is recorded', {
      workItemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Settle this card's green verdict — merge gates in a `manual` project, the auto merges
 * owed in an `auto` one — over the SAME delivery set the verdict was judged on
 * (MOTIR-5515 · MOTIR-5518): `collectDeliveries`, so a member the verdict counted is a
 * member the settlement asks about.
 */
async function settleMergesForCard(
  item: WorkItem,
  ctx: { userId: string; workspaceId: string },
  tx: Prisma.TransactionClient,
): Promise<{ autoMerges: AutoMergeRequest[]; raisedApprovalGate: boolean }> {
  const members = await collectDeliveries(item, tx);
  const autoMerges = await settleGreenVerdict(
    { item, pullRequestIds: [...members.keys()] },
    ctx,
    tx,
  );
  // The approve-and-merge gate over the same green set, on the same card, in the same
  // transaction and under the same row lock (MOTIR-5482) — `manual` projects only.
  //
  // ⚠️ WHETHER THE CARD NOW HOLDS THE QUESTION IS RETURNED, because a gate that is
  // awaiting NOW may already have its answer: reviews are recorded whether or not a
  // gate exists (MOTIR-5597, decision 8), so an approval given while CI was still
  // running is sitting in the database waiting for exactly this moment. The caller
  // evaluates it AFTER this transaction commits.
  //
  // ⚠️ IT IS READ FROM THE ROWS, NOT FROM WHO CREATED THEM (Bug MOTIR-5652 · found by
  // CI on MOTIR-5670). This used to be `raisePullRequestApprovalGate`'s own return —
  // *did I just create it* — which was the same answer while this was the only path
  // that could. It no longer is: a status transition into the review band reconciles
  // the card's gates too, so the promotion's own `updateStatus` can raise the gate a
  // statement before this line runs, leaving `false` here and skipping the post-commit
  // evaluation entirely. A standing review then sat unapplied on a card whose gate
  // existed — `githubReviewSyncStoryGate.test.ts` is the test that caught it.
  //
  // The question the caller is really asking is *does this card hold an unanswered
  // merge question now*, and that is a property of the card rather than of this
  // function's history.
  await raisePullRequestApprovalGate(item, tx);
  const raisedApprovalGate = (
    await approvalGateRepository.findAwaitingByWorkItem(item.id, tx)
  ).some((gate) => gate.kind === 'pull_request_approval');
  return { autoMerges, raisedApprovalGate };
}

/**
 * Dispatch the auto merges a committed settlement owes (MOTIR-5518) — ONE job per pull
 * request, keyed on `(pull request, head)` so a redelivered verdict enqueues nothing new.
 * Post-commit by construction: it is called only after the transaction returned.
 */
async function dispatchAutoMerges(
  workItemId: string,
  requests: readonly AutoMergeRequest[],
  ctx: { userId: string; workspaceId: string },
): Promise<void> {
  for (const request of requests) {
    await sendEvent('pull-request/auto-merge.requested', {
      workspaceId: ctx.workspaceId,
      workItemId,
      pullRequestId: request.pullRequestId,
      headSha: request.headSha,
      actorUserId: ctx.userId,
      idempotencyKey: `${request.pullRequestId}:${request.headSha}`,
    });
  }
}

/**
 * SETTLE ONE CARD AFTER ITS PRIMARY WAS APPROVED WITH NO COMPANION TO DECIDE (Bug
 * MOTIR-5762; `design-result.md` AMENDMENT 6 Q1 and Q4 — and, for a decision card, Story
 * MOTIR-4907 · MOTIR-5677; `approval-gates.md` §8's FIFTH AMENDMENT, clause 6).
 *
 * In an `auto` project a design or decision card's green verdict was HELD —
 * `settleGreenVerdict` dispatches nothing while the primary is unanswered — and no
 * approve-to-merge gate exists for the press to carry. Without this, a primary approved
 * over a set that was already green would wait for a verdict that never comes. It is the
 * re-raise below, for one card: under the card's row lock, only for a card in review
 * whose whole set is green, so a card that is not there yet settles nothing and waits
 * for its green.
 */
export async function settleAfterPrimaryApproval(
  workItemId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<void> {
  await reRaiseMergeGates([workItemId], ctx);
}

/**
 * RE-RAISE for cards already in review (MOTIR-5515): under the card's row lock — the
 * same lock the promotion's status write takes, so two green events for one card
 * serialise and the second finds the first's gates — re-judge the whole set and raise
 * whatever is missing. A card whose set is not green raises nothing. In an `auto`
 * project the same verdict dispatches the new head's merge instead (MOTIR-5518).
 */
async function reRaiseMergeGates(
  workItemIds: readonly string[],
  ctx: { userId: string; workspaceId: string },
): Promise<void> {
  for (const id of workItemIds) {
    const settled = await withWorkspaceContext(ctx, async (tx) => {
      // The decide door's lock order — the card's awaiting gates, then the card (ADR
      // §6d AMENDMENT, rule 8) — because the move below goes through the funnel,
      // which takes them in that order too. A card deleted since the verdict locks
      // nothing and reads back null.
      await approvalGateRepository.lockAwaitingByWorkItem(id, tx);
      await workItemRepository.lockById(id, tx);
      let item = await workItemRepository.findById(id, tx);
      const nothing = { autoMerges: [] as AutoMergeRequest[], raisedApprovalGate: false };
      if (!item || !REVIEW_STATUSES.includes(item.status)) return nothing;
      if (!(await isPromotable(item, tx))) return nothing;
      // ⚠️ AN `approved` CARD IS ASKED AGAIN AT `in_review`, NEVER WHERE IT STANDS
      // (MOTIR-6971; `approval-gates.md` §8's EIGHTH AMENDMENT). The merge question is
      // asked only of a card in review, so a green set at commits nobody approved —
      // a push after the approval — first moves the card back to `in_review` (a
      // declared edge, §4's FOURTH AMENDMENT), as a system write: CI spoke and a
      // person must decide. The same commits already approved (MOTIR-5632's late
      // green) owe nothing and move nothing.
      if (item.status === APPROVED_STATUS && (await asksAgainInReview(item, tx))) {
        await workItemsService.applyStatusTransition(item.id, TARGET_STATUS, ctx, tx, {
          system: true,
        });
        item = (await workItemRepository.findById(id, tx)) ?? item;
      }
      return settleMergesForCard(item, ctx, tx);
    });
    await dispatchAutoMerges(id, settled.autoMerges, ctx);
    // POST-COMMIT, and best-effort (MOTIR-5597, decision 8): apply the reviews that were
    // recorded before this gate existed. It can never fail the re-raise.
    if (settled.raisedApprovalGate) await evaluateAfterRaise(id, ctx.workspaceId);
  }
}

/**
 * Move each card through the SHIPPED authority, one transaction each, and treat
 * a per-card refusal as a skip rather than a failure of the whole promotion.
 *
 * A custom workflow with no `in_review`, an item whose status moved underneath
 * us, or an actor without edit rights on one project must not stop the other
 * cards of the same run from being promoted — the same per-item tolerance
 * `completeSession` applies to a session close-out.
 *
 * ⚠️ THE MERGE GATES COMMIT WITH THE STATUS WRITE (MOTIR-5515). They are raised in
 * `updateStatus`'s own transaction, after the transition, so a card never reaches
 * review without them and a failed gate insert rolls the promotion back. The
 * post-commit `work-item/transitioned` event is `updateStatus`'s, exactly as before.
 */
async function promoteEach(
  workItemIds: string[],
  ctx: { userId: string; workspaceId: string },
): Promise<string[]> {
  const promoted: string[] = [];
  for (const id of workItemIds) {
    try {
      let autoMerges: AutoMergeRequest[] = [];
      let raisedApprovalGate = false;
      await workItemsService.updateStatus(id, TARGET_STATUS, ctx, {
        inTransaction: async (tx) => {
          // Non-null by construction: the transition above locked and wrote this row
          // in this same transaction.
          const item = (await workItemRepository.findById(id, tx))!;
          const settled = await settleMergesForCard(item, ctx, tx);
          autoMerges = settled.autoMerges;
          raisedApprovalGate = settled.raisedApprovalGate;
        },
      });
      promoted.push(id);
      // AFTER the promotion committed (MOTIR-5518) — and the promotion to in_review
      // stands whatever the merge does.
      await dispatchAutoMerges(id, autoMerges, ctx);
      // POST-COMMIT, and best-effort (MOTIR-5597, decision 8): a reviewer who approved
      // while CI was still running is not asked a second time — their review is applied
      // to the gate the moment it exists. A failure here leaves the promotion committed.
      if (raisedApprovalGate) await evaluateAfterRaise(id, ctx.workspaceId);
    } catch (err) {
      if (!SKIPPABLE.some((kind) => err instanceof kind)) throw err;
      console.warn('[ciPromotion] skipped a card CI green could not promote', {
        workItemId: id,
        // Every member of SKIPPABLE extends Error, which the `.some()` above
        // cannot tell the compiler.
        error: (err as Error).message,
      });
    }
  }
  return promoted;
}
