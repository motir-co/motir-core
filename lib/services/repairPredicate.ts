import type { GithubCheckRun, GithubPullRequestQueueExit, Prisma } from '@/generated/prisma/client';
import { readAcceptanceRerun } from '@/lib/approvalGates/acceptanceRefusal';
import { readStandingReviewRefusal } from '@/lib/approvalGates/reviewRefusal';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  AcceptanceRefusalDto,
  RepairPullRequestDto,
  ReviewRefusalDto,
  WorkItemRepairClass,
  WorkItemRepairRefusal,
} from '@/lib/dto/workItemRepair';
import { isConflictedAtCurrentHead, isOutOfDateAtCurrentHead } from '@/lib/github/mergeability';
import { derivePrCiState } from '@/lib/github/prCiState';
import { pullRequestHead, prCiStateAtHead, checkRowsAtHead } from '@/lib/github/pullRequestHead';
import { classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { standingQueueFailures } from '@/lib/services/deliveryVerdict';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { queueExitStandsAtHead } from '@/lib/workItems/deliverySet';
import { REVIEW_AGENT_REVIEWER_NAME, reviewerNameOf } from '@/lib/workItems/fixReason';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';

// THE REPAIR PREDICATE — whether `motir fix` can act on a card, and with what (Story
// MOTIR-5460 · MOTIR-5464; extracted by MOTIR-6600).
//
// ── Why it is its own module ────────────────────────────────────────────────
// It had one home, inside `workItemRepairService`, read by the claim and by the
// Development block. Story MOTIR-6588 adds a THIRD reader: `WorkItem.fixReason`, the
// stored answer the Workbench's To fix tab lists by, whose whole promise is that the
// tab never lists a card the command would refuse and never misses one it would claim.
// That promise holds only if the column reads THIS function rather than a copy of its
// rules, so the function moved here unchanged.
//
// The move is also what makes the third reader safe to call from anywhere. The
// recompute runs inside the writers that change a card's delivery set — the CI
// feedback, the status transition — and `workItemRepairService` imports
// `workItemsService` (for the keyed read the claim opens with). A recompute reaching
// the predicate THROUGH that service would close an import cycle through the status
// writer; this module imports no service that writes a card.

export type RepairEvaluation =
  | {
      ok: true;
      pullRequests: RepairPullRequestDto[];
      repairClass: WorkItemRepairClass;
      acceptanceRefusal: AcceptanceRefusalDto | null;
      /** Set exactly on the `review` class (MOTIR-6822). */
      reviewRefusal: ReviewRefusalDto | null;
    }
  | {
      ok: false;
      reason: WorkItemRepairRefusal;
      runTargetKey: string | null;
      /** The card's own failing open pull requests — what a child's pointer names. */
      failing: RepairPullRequestDto[];
    };

/** The Implemented rung's key set, resolved by KEY PRESENCE (see `claimRepair`). */
function ladderKeysOf(statuses: readonly WorkflowStatusDto[]) {
  const keyOf = (key: string) => statuses.find((s) => s.key === key)?.key ?? null;
  return {
    reviewKey: keyOf('in_review'),
    implementedKey: keyOf('implemented'),
    approvedKey: keyOf('approved'),
  };
}

/**
 * Every member's latest merge-queue exit that still STANDS at its current head, of any
 * disposition (MOTIR-5803). `standingQueueFailures` answers the narrower question the
 * promotion hold asks — a FAILURE holding the card — and the repair claim needs the
 * wider one, because a neutral removal is a real outcome to refuse rather than an
 * absence to report as *nothing is failing*.
 */
async function standingExitsAtHead(
  openRows: ReadonlyArray<{
    pullRequest: { id: string; headSha: string | null; checkRuns: readonly GithubCheckRun[] };
  }>,
  tx: Prisma.TransactionClient,
): Promise<GithubPullRequestQueueExit[]> {
  const exits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    openRows.map((row) => row.pullRequest.id),
    tx,
  );
  const standing: GithubPullRequestQueueExit[] = [];
  for (const row of openRows) {
    const exit = exits.get(row.pullRequest.id);
    const head = pullRequestHead(row.pullRequest) ?? undefined;
    // The RULE is `deliverySet.ts`'s, never re-derived here — the promotion hold reads
    // its narrower twin, and the two must not drift.
    if (queueExitStandsAtHead(exit, head)) standing.push(exit!);
  }
  return standing;
}

/**
 * COULD A CODE CHANGE ANSWER THIS OUTCOME? (§4 FOURTH AMENDMENT, point 6; MOTIR-5803;
 * narrowed by the FIFTH AMENDMENT, MOTIR-6594.)
 *
 * `motir fix` hands the pull request to an agent that changes code and pushes, so the
 * question is not whether the merge failed but whether the CODE is a plausible cause:
 *
 *  · `cant_land` — a conflict, or a queue FAILURE (the checks failed or timed out, the
 *    merge commit or tree could not be built): yes, and a new head is the only way
 *    forward;
 *  · `setting` (branch protection, a missing app permission) and every NEUTRAL removal
 *    (`MANUAL`, `QUEUE_CLEARED`, `ROLL_BACK`, an unmapped reason): no. Nothing in the
 *    repository is wrong, and a person is what is needed.
 *
 * ⚠️ THE `retryable && failure` ARM IS GONE, NOT FORGOTTEN. Before the FIFTH AMENDMENT
 * the four failures were `retryable`, and that arm is what admitted them; they are
 * `cant_land` now, and no `retryable` reason is a failure, so the arm could never answer
 * true again.
 */
function repairableOutcome(exit: { rawReason: string; disposition: string }): boolean {
  return classOfQueueExit(exit) === 'cant_land';
}

/** One open member as a repair hands it over — the claim's wire row. */
function toRepairPullRequest(m: {
  row: DeliveryWithChecks;
  ci: ReturnType<typeof derivePrCiState>;
  exit: GithubPullRequestQueueExit | null;
  conflicted: boolean;
  outOfDate: boolean;
}): RepairPullRequestDto {
  const { row, ci, exit, conflicted, outOfDate } = m;
  return {
    conflicted,
    outOfDate,
    repo: `${row.repo.owner}/${row.repo.name}`,
    number: row.pullRequest.number,
    url: `https://github.com/${row.repo.owner}/${row.repo.name}/pull/${row.pullRequest.number}`,
    headRef: row.pullRequest.headRef,
    baseRef: row.pullRequest.baseRef,
    ci,
    // The names behind the verdict, from the SAME window `derivePrCiState`
    // judged — so a give-up can say which check is still red.
    failingChecks: [
      ...new Set(
        checkRowsAtHead(row.pullRequest)
          .filter((c) => c.conclusion === 'failure')
          .map((c) => c.checkName),
      ),
    ].sort(),
    queueExit:
      exit === null
        ? null
        : {
            rawReason: exit.rawReason,
            disposition: exit.disposition,
            exitedAt: exit.exitedAt.toISOString(),
            headSha: exit.headSha,
            failingCheckName: exit.failingCheckName,
            failingCheckUrl: exit.failingCheckUrl,
          },
  };
}

type DeliveryWithChecks = Awaited<
  ReturnType<typeof workItemDeliveryRepository.listByWorkItemWithChecks>
>[number];

/**
 * THE PREDICATE — whether a card can be repaired, and with what. ONE function,
 * read by the claim (under its row lock) and by the Development block (without
 * one), so the page never offers a command the claim would refuse
 * (design § 21: *"the part and the claim read one predicate"*).
 *
 * The REFUSAL order is the claim's contract: not implemented → not the run target
 * → no pull requests → nothing failing. The deliveries are read before the run
 * target is resolved only because the child pointer names the child's own failing
 * rows; the reason returned is unchanged by that.
 */
export async function evaluateRepair(
  item: { id: string; status: string; archivedAt: Date | null },
  statuses: readonly WorkflowStatusDto[],
  ctx: Pick<ServiceContext, 'workspaceId'>,
  tx: Prisma.TransactionClient,
): Promise<RepairEvaluation> {
  const rank = rankOfStatus(item.status, statuses, ladderKeysOf(statuses));
  // ⚠️ IN REVIEW IS ADMITTED TOO — but only for a card the merge queue threw out for a
  // reason a CODE CHANGE could fix (MOTIR-5803; `approval-gates.md` §4 FOURTH AMENDMENT,
  // point 6). A retryable or setting-blocked outcome returns the card to In Review with a
  // fresh approve-to-merge gate, and `motir fix` is the answer only where the code may be
  // at fault. An In Review card whose set is green is waiting on a person, not on a
  // repair, so it is refused below as `not_failing`.
  //
  // ⚠️ SINCE THE FIFTH AMENDMENT (MOTIR-6594) A LIVE FAILURE NEVER REACHES IN REVIEW —
  // it holds the card at Implemented. What this admission still serves is a card the OLD
  // rule re-asked: at In Review, holding a gate raised from a standing failure exit. It
  // stays admitted until the convergence (MOTIR-6595) has moved it to Implemented; after
  // that the admission finds only neutral and setting outcomes, and refuses them.
  //
  // ⚠️ AND A RED OR CONFLICTED MEMBER ADMITS IT TOO (MOTIR-7491). "Never reaches In
  // Review" holds for the green PROMOTION only. The red HOLD (`withdrawDeliveredCardsOnRed`)
  // is edge-triggered, so a card moved to In Review by hand while a member was ALREADY red
  // is neither held back nor asked — and refusing it here left it in no queue at all
  // (MOTIR-1408: one green member, one red, In Review for hours). A red pull request
  // belongs to the fix loop (`approval-gates.md`, *a red pull request never reaches In
  // Review*), so the card is repaired from where it stands.
  const inReview = rank === RUNG_RANK.in_review;
  if (item.archivedAt !== null || (rank !== RUNG_RANK.implemented && !inReview)) {
    return { ok: false, reason: 'not_implemented', runTargetKey: null, failing: [] };
  }

  // The verdict is `derivePrCiState` — the one the Development pill and
  // `ciPromotion` read — per member. Only an OPEN member can be repaired: a push
  // cannot change a merged or closed pull request, so its colour says nothing
  // about what an agent could do.
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
  const openRows = deliveries.filter(
    (d) => d.pullRequest.state === 'open' && !d.pullRequest.merged,
  );
  // ⚠️ A STANDING MERGE-QUEUE FAILURE IS A FAILING MEMBER (MOTIR-5719). The queue
  // ejected the pull request on its merge group, so its own checks are usually
  // green — and a repair it needs (a conflict above all) was refused `not_failing`.
  // The rule is the fold's and the promotion hold's (`queueExitHoldsAtHead`, read
  // through `standingQueueFailures`), never re-derived here.
  const queueHeld = await standingQueueFailures(
    new Map(openRows.map((d) => [d.pullRequest.id, d.pullRequest])),
    tx,
  );
  // ⚠️ AN ACCEPTANCE SENT BACK WITH RE-RUN IS A REPAIR CLASS OF ITS OWN (MOTIR-6502;
  // `acceptance-refusal-verdict.md` §4). The story's checks are usually GREEN — the
  // reviewer watched the video and asked for a fix to what was built — so it is checked
  // BEFORE the red-work arms below, which would refuse it `not_failing`. It hands over
  // EVERY open member, green ones included, because the fix is to the code the reviewer
  // saw, and it carries the reason. It holds at either rung until a newer receipt asks
  // again (`readAcceptanceRerun`), and only on the story's OWN run target: a child that
  // shares the pull requests is pointed at the story below, as for any repair.
  const rerun = openRows.length > 0 ? await readAcceptanceRerun(item.id, tx) : null;
  if (rerun !== null) {
    const target = await resolveRunTargetFor({ id: item.id, workspaceId: ctx.workspaceId }, tx);
    if (target.kind !== 'ancestor') {
      return {
        ok: true,
        repairClass: 'acceptance_rerun',
        reviewRefusal: null,
        acceptanceRefusal: {
          reasonMd: rerun.reasonMd,
          decidedByLabel: rerun.decidedByLabel,
          decidedAt: rerun.decidedAt.toISOString(),
        },
        pullRequests: openRows.map((row) =>
          toRepairPullRequest({
            row,
            ci: prCiStateAtHead(row.pullRequest),
            exit: queueHeld.get(row.pullRequest.id) ?? null,
            conflicted: isConflictedAtCurrentHead(row.pullRequest),
            outOfDate: isOutOfDateAtCurrentHead(row.pullRequest),
          }),
        ),
      };
    }
  }
  // ⚠️ A CARD A REVIEW SENT BACK IS A REPAIR CLASS OF ITS OWN (MOTIR-6822;
  // `approval-gates.md` §12.4, §12.7). The review agent's `changes_requested`, or a
  // person's Request changes on the approve-and-merge gate, still standing over the
  // delivery set's CURRENT version: the card sits at In Review (or Implemented) with
  // GREEN checks, and without this arm it is refused `not_failing` below — so the To fix
  // tab would name a repair nobody could perform. Like the re-run, it is checked BEFORE
  // the red-work arms and hands over EVERY open member with the findings; a red member
  // rides along and is fixed by the same CI loop. It stands until a push moves a head
  // (the version no longer matches) or a later decision answers it, and only on the
  // card's OWN run target: a child that shares the pull requests is pointed below.
  const review =
    openRows.length > 0 ? await readStandingReviewRefusal(item.id, deliveries, tx) : null;
  if (review !== null) {
    const target = await resolveRunTargetFor({ id: item.id, workspaceId: ctx.workspaceId }, tx);
    if (target.kind !== 'ancestor') {
      const byAgent = review.kind === 'agent_review';
      const person =
        !byAgent && review.decidedById
          ? await userRepository.findById(review.decidedById, tx)
          : null;
      return {
        ok: true,
        repairClass: 'review',
        acceptanceRefusal: null,
        reviewRefusal: {
          gate: review.kind,
          findingsMd: review.noteMd,
          // The agent is named as the agent, never as the run's attributed user (§12.3).
          reviewerName: byAgent
            ? REVIEW_AGENT_REVIEWER_NAME
            : reviewerNameOf(person, review.decidedByLabel),
          // `findLatestDecidedByWorkItem` reads only rows whose `decidedAt` is set.
          decidedAt: (review.decidedAt as Date).toISOString(),
        },
        pullRequests: openRows.map((row) =>
          toRepairPullRequest({
            row,
            ci: prCiStateAtHead(row.pullRequest),
            exit: queueHeld.get(row.pullRequest.id) ?? null,
            conflicted: isConflictedAtCurrentHead(row.pullRequest),
            outOfDate: isOutOfDateAtCurrentHead(row.pullRequest),
          }),
        ),
      };
    }
  }
  // In Review with no red or conflicted member: the ONLY admission is a standing outcome at
  // a member's current head whose reason a CODE CHANGE could answer. The read is of EVERY
  // disposition, not just the failures `standingQueueFailures` holds the promotion on,
  // because the two refusals differ and a person deserves the true one: no outcome at all
  // is `not_failing`, and an outcome no agent can act on is `repair_not_code`. A red or
  // conflicted member skips this (MOTIR-7491, above) and is classed below like
  // Implemented's.
  const redAtHead = openRows.some(
    (d) => prCiStateAtHead(d.pullRequest) === 'failing' || isConflictedAtCurrentHead(d.pullRequest),
  );
  if (inReview && !redAtHead) {
    const standing = await standingExitsAtHead(openRows, tx);
    if (standing.length === 0) {
      return { ok: false, reason: 'not_failing', runTargetKey: null, failing: [] };
    }
    // ⚠️ A REASON NO CODE CHANGE FIXES IS REFUSED BY NAME (point 6). `motir fix` sends an
    // agent to change code: against branch protection, a missing app permission or a hand
    // removal from the queue it has nothing to change, and the run would be spent finding
    // nothing. What helps there is a person — approving again, or changing the setting —
    // and the refusal says so.
    if (!standing.some(repairableOutcome)) {
      return { ok: false, reason: 'repair_not_code', runTargetKey: null, failing: [] };
    }
  }
  // ⚠️ AND SO IS A MEMBER THE HOST REPORTS CONFLICTED AT ITS HEAD (MOTIR-5913, for bug
  // MOTIR-5907; design/github § 30 rule 2). A conflict withdrawn before any press holds
  // the card at Implemented with green checks, and `motir fix` is the answer the band
  // offers — so it must not be refused `not_failing`. The fixing prompt merges the base
  // first (`renderFixPrompt`), which is exactly what resolving a conflict takes.
  //
  // ⚠️ AND SO IS A MEMBER OUT OF DATE WITH A BASE THAT REQUIRES IT (Bug MOTIR-10054). The
  // host refuses its merge with every check green, the promotion holds it at Implemented,
  // and the merge of the base the fixing prompt opens with is the whole repair. It is NOT
  // an In Review admission (`redAtHead` above): a card in review whose base moved is
  // refused at the press, which settles it at Implemented, where this arm finds it.
  const open = openRows.map((d) => ({
    row: d,
    ci: prCiStateAtHead(d.pullRequest),
    exit: queueHeld.get(d.pullRequest.id) ?? null,
    conflicted: isConflictedAtCurrentHead(d.pullRequest),
    outOfDate: isOutOfDateAtCurrentHead(d.pullRequest),
  }));
  const failing: RepairPullRequestDto[] = open
    .filter((m) => m.ci === 'failing' || m.exit !== null || m.conflicted || m.outOfDate)
    .map(toRepairPullRequest);

  // The repair runs where the run that delivered the pull requests was launched.
  // The resolution is `runTarget.ts`'s, shared with How to test and the
  // approve-to-merge gate — one answer to "which card is this run about".
  const target = await resolveRunTargetFor({ id: item.id, workspaceId: ctx.workspaceId }, tx);
  if (target.kind === 'ancestor') {
    return {
      ok: false,
      reason: 'repair_on_run_target',
      runTargetKey: target.holder.identifier,
      failing,
    };
  }
  if (deliveries.length === 0) {
    return { ok: false, reason: 'no_pull_requests', runTargetKey: null, failing };
  }
  if (failing.length === 0) {
    return {
      ok: false,
      reason: open.some((m) => m.ci === 'running') ? 'ci_running' : 'not_failing',
      runTargetKey: null,
      failing,
    };
  }
  return {
    ok: true,
    repairClass: 'ci',
    acceptanceRefusal: null,
    reviewRefusal: null,
    pullRequests: failing,
  };
}
