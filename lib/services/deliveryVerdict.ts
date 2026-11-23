import type {
  GithubCheckRun,
  GithubPullRequestMergeRefusal,
  GithubPullRequestQueueExit,
  Prisma,
} from '@/generated/prisma/client';
import type { PrCiState } from '@/lib/github/prCiState';
import { prCiStateAtHead, pullRequestHead } from '@/lib/github/pullRequestHead';
import { githubPullRequestMergeRefusalRepository } from '@/lib/repositories/githubPullRequestMergeRefusalRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  deliveryMemberState,
  deliveryStateForCard,
  foldCardCiState,
  membersWithAVerdict,
  queueExitHoldsAtHead,
  repoCannotReportChecks,
  type DeliveryMember,
} from '@/lib/workItems/deliverySet';

// A CARD'S DELIVERY SET, AND THE TWO VERDICTS READ OFF IT (MOTIR-5470).
//
// ── Why this is its own module ──────────────────────────────────────────────
// `ciPromotion` owns a QUESTION — may this card move out of `implemented`? — and
// it answered that question by collecting the card's deliveries and classifying
// each one. The card's stored `ciState` is a DIFFERENT question read off the very
// same set: not *may it move* but *what would a person see if they looked*.
//
// Two questions over one set is exactly the shape `everyDeliveryIsGreen`'s own
// header warns about one level down ("the latch only works if the two edges ask
// the same question of the same set"). So the SET and its per-member
// classification live here, once, and both consumers call it unmodified:
//
//   * the PROMOTION (`ciPromotion.everyDeliveryIsGreen`) maps each member through
//     `deliveryStateForPromotion` and asks `deliverySetIsGreen`;
//   * the CARD (`recomputeWorkItemCiState`, below) maps each member through
//     `deliveryStateForCard` and folds with `foldCardCiState`.
//
// The two mappers differ in ONE cell (a repository that can report and has not
// yet: `null` for the promotion, `'running'` for the card), which is what makes
// the column read `passing` exactly when the promotion would promote. If they
// read two different sets that equivalence would be a coincidence; reading one
// set makes it a property.

/** A delivering pull request, in the fields the verdicts read. `state` and
 *  `merged` are the host's raw pair, collapsed by `deliveryMemberState`
 *  (MOTIR-5786 reads them to tell a finished member from a waiting one). */
export interface DeliveredPullRequest {
  repoId: string;
  state: string;
  merged: boolean;
  /** Whether the host reports it a draft; `null` when no delivery or host read has said
   *  (MOTIR-5002). The promotion's draft hold reads it (MOTIR-12094). */
  draft: boolean | null;
  /** The host's head (MOTIR-7005) — `lib/github/pullRequestHead.ts` reads it with
   *  `checkRuns`, so a member whose rows are at an older commit is not green. */
  headSha: string | null;
  checkRuns: GithubCheckRun[];
  /** The host's stored mergeability reading and its head (MOTIR-5913) —
   *  `lib/github/mergeability.ts` reads the pair. */
  mergeableState: string | null;
  mergeableStateHeadSha: string | null;
}

/**
 * EVERY pull request that delivers this card, by id, with the check rows the
 * verdict is derived from.
 *
 * ── The set is a UNION, and each arm exists for a shape the others cannot hold ─
 *   * `work_item_delivery` — the declared links, which is the ordinary case and
 *     the only one that is many-to-many;
 *   * the pull-request mirror's own `listByWorkItemWithContext` — rows written by
 *     `historicalPullRequestBackfillService`, which the delivery table has not
 *     been told about;
 *   * the card's `sessionBranch` — a `motir auto` run's pull request, which
 *     deliberately carries no card key at all and is therefore linked by nothing.
 *
 * ⚠️ THE THIRD ARM IS WHY A SESSION-BRANCH CARD FINALLY GETS A `ciState`. The
 * column's previous writer looped over the LINKED cards only, which is empty on
 * the session arm — so every card a run delivered through its own branch stayed
 * `null` for ever, however red its build. Reading the set here rather than
 * re-deriving it at the call site is what closes that, for both consumers at once.
 *
 * Deduplicated on the pull request's own id, so a row recorded on two arms counts
 * once. Extracted from `ciPromotion` (MOTIR-5470) rather than copied: a second
 * collection would be a second answer to *what delivers this card*, which is the
 * one thing this module exists to prevent.
 */
export async function collectDeliveries(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<Map<string, DeliveredPullRequest>> {
  const [deliveries, linked, onBranch] = await Promise.all([
    workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
    githubPullRequestRepository.listByWorkItemWithContext(item.id, tx),
    item.sessionBranch
      ? githubPullRequestRepository.listByHeadRefWithChecks(item.sessionBranch, tx)
      : Promise.resolve([]),
  ]);

  const byId = new Map<string, DeliveredPullRequest>();
  for (const delivery of deliveries) byId.set(delivery.githubPullRequestId, delivery.pullRequest);
  for (const pr of [...linked, ...onBranch]) byId.set(pr.id, pr);
  return byId;
}

/**
 * WHICH members of a delivery set a merge-queue failure still HOLDS (MOTIR-5717) —
 * each held member's pull-request id mapped to the exit row that holds it, over ONE
 * read of the set's latest exits.
 *
 * The rule itself is {@link queueExitHoldsAtHead}; this is only its transaction-
 * scoped wrapper, so the promotion hold, the card's fold and the repair claim read
 * the exits the same way as well as judging them the same way. It returns the ROW,
 * not only the id, because the repair claim hands the agent the exit's reason and
 * failing check (MOTIR-5719). A set with no exit at all — nearly every card — costs
 * one indexed read and returns an empty map.
 */
export async function standingQueueFailures(
  byId: ReadonlyMap<string, { headSha: string | null; checkRuns: readonly GithubCheckRun[] }>,
  tx: Prisma.TransactionClient,
): Promise<Map<string, GithubPullRequestQueueExit>> {
  const exits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    [...byId.keys()],
    tx,
  );
  const held = new Map<string, GithubPullRequestQueueExit>();
  for (const [pullRequestId, exit] of exits) {
    const head = pullRequestHead(byId.get(pullRequestId)!);
    if (queueExitHoldsAtHead(exit, head)) held.set(pullRequestId, exit);
  }
  return held;
}

/**
 * WHICH members of a delivery set carry a STANDING host merge refusal (Bug MOTIR-6735)
 * — each such member's pull-request id mapped to its latest refusal row, over ONE read.
 *
 * The standing rule is the one the approval members' read applies
 * (`pullRequestApprovalMembersService`, MOTIR-5833): nothing superseded the refusal, the
 * head it names is still the pull request's, and the pull request is open and unmerged.
 * A push or a later successful press therefore retires it here exactly as it retires
 * the row on the card.
 */
export async function standingMergeRefusals(
  byId: ReadonlyMap<
    string,
    {
      state: string;
      merged: boolean;
      headSha: string | null;
      checkRuns: readonly GithubCheckRun[];
    }
  >,
  tx: Prisma.TransactionClient,
): Promise<Map<string, GithubPullRequestMergeRefusal>> {
  const refusals = await githubPullRequestMergeRefusalRepository.findLatestByPullRequests(
    [...byId.keys()],
    tx,
  );
  const standing = new Map<string, GithubPullRequestMergeRefusal>();
  for (const [pullRequestId, refusal] of refusals) {
    const pr = byId.get(pullRequestId)!;
    const head = pullRequestHead(pr);
    const open = pr.state === 'open' && !pr.merged;
    if (open && refusal.supersededAt === null && head !== null && refusal.headSha === head) {
      standing.set(pullRequestId, refusal);
    }
  }
  return standing;
}

/** One classified member of a card's delivery set: the verdict its own check rows
 *  give, plus whether its repository is able to report a check at all. */
export interface ClassifiedDelivery {
  repoId: string;
  /** `prCiStateAtHead` — the verdict over the check rows AT this pull request's head,
   *  `null` when the head has none (MOTIR-7005). */
  state: PrCiState;
  /** True when a `null` state means "this repository has no CI" rather than
   *  "nothing has reported yet" (`repoCannotReportChecks`). */
  cannotReport: boolean;
  /** True when this member's latest merge-queue exit still holds it
   *  ({@link standingQueueFailures}) — a failure the pull request's OWN `state`
   *  cannot show, because the queue failed on its merge group (MOTIR-5717). */
  queueFailure: boolean;
  /** Open, merged or closed — `deliveryMemberState`'s collapse (MOTIR-5786). */
  lifecycle: DeliveryMember['state'];
}

/**
 * Classify every member of a card's delivery set — the shared read BOTH verdicts
 * are folded from.
 *
 * The per-member verdict is `prCiStateAtHead` — `derivePrCiState`'s precedence over
 * the rows AT the pull request's stored head. A member pushed past its green rows
 * (a push to a conflicting pull request gets no CI) therefore reads `null`, which the
 * promotion withholds on and the card reads as `running` (MOTIR-7005).
 *
 * ⚠️ THE SECOND QUESTION IS ASKED ONLY OF THE MEMBERS THAT NEED IT (MOTIR-3823).
 * `derivePrCiState` returns `null` both for a repository that has no CI and for
 * one that has simply not reported yet, and those must be read oppositely. The
 * follow-up is asked of the REPOSITORY, because the pull request cannot tell them
 * apart. A set with no `null` in it — nearly every card — pays nothing: the id
 * list is empty and both reads are skipped.
 *
 * ⚠️ AND A FINISHED MEMBER THAT NEVER REPORTED IS NOT RETURNED (MOTIR-5786). A
 * merged or closed pull request with no check rows, in a repository that can
 * report, will never get a verdict, so it is waiting on nothing. Before this it
 * reached the card's mapper as `running` and pinned the card there for ever.
 * The rule is `membersWithAVerdict`; it is applied HERE, once, so the card's fold
 * and the promotion read the same members and keep agreeing on `passing`.
 */
export async function classifyDeliveries(
  item: { id: string; sessionBranch: string | null },
  tx: Prisma.TransactionClient,
): Promise<ClassifiedDelivery[]> {
  const byId = await collectDeliveries(item, tx);

  const members = [...byId.entries()].map(([id, pr]) => ({
    id,
    repoId: pr.repoId,
    state: prCiStateAtHead(pr),
    lifecycle: deliveryMemberState(pr),
  }));

  const silentRepoIds = [...new Set(members.filter((m) => m.state === null).map((m) => m.repoId))];
  const [reporting, mergedSilent, queueHeld] = await Promise.all([
    githubPullRequestRepository.listRepoIdsWithAnyCheckRun(silentRepoIds, tx),
    githubPullRequestRepository.listRepoIdsWithAWatchedMergeWithoutChecks(silentRepoIds, tx),
    standingQueueFailures(byId, tx),
  ]);
  const hasReported = new Set(reporting);
  const hasMergedSilently = new Set(mergedSilent);
  // A repository neither read returns has no history at all, so it falls to
  // `hasEverReportedACheck: false, hasMergedWithoutAnyCheck: false` — which
  // `repoCannotReportChecks` reads as ABLE to report. Every unknown takes that
  // direction: for the promotion it withholds, and for the card it reads
  // `running`, which are the same conservative answer in two vocabularies.
  const cannotReport = new Set(
    silentRepoIds.filter((repoId) =>
      repoCannotReportChecks({
        repoId,
        hasEverReportedACheck: hasReported.has(repoId),
        hasMergedWithoutAnyCheck: hasMergedSilently.has(repoId),
      }),
    ),
  );

  return membersWithAVerdict(
    members.map((m) => ({
      repoId: m.repoId,
      state: m.state,
      cannotReport: cannotReport.has(m.repoId),
      queueFailure: queueHeld.has(m.id),
      lifecycle: m.lifecycle,
    })),
  );
}

/**
 * RECOMPUTE one card's stored `ciState` from its whole delivery set, and write it
 * if it moved (MOTIR-5470).
 *
 * ── It is a RECOMPUTE, never a stamp, and that is the defect it closes ────────
 * The column's previous writer took the verdict of the pull request whose webhook
 * happened to be in hand and wrote it onto every card that pull request delivered.
 * Three consequences, all of them wrong in the direction that shows a person a
 * stale badge: a card with two pull requests read whichever reported LAST; a card
 * delivered through a run's session branch was never written at all; and a
 * pending check wrote nothing, so a card whose fix was already building kept
 * reading `failing`. Folding the set answers all three at once, because none of
 * them is a question about the event — they are questions about the card.
 *
 * ── THE LOCK IS HELD OVER THE FOLD, NOT ONLY OVER THE WRITE ──────────────────
 * This is a read-derived write: what gets stored is computed from rows another
 * transaction may be inserting concurrently (two workflows reporting at once is
 * the ordinary case, not the exotic one). Taking the card's row lock FIRST and
 * folding under it serializes the recomputes for one card, so the last one to
 * commit is the one that read the most rows. Locking only the write would let two
 * recomputes read the same pre-insert snapshot and race to store the same stale
 * answer — which looks identical to working, until the red one loses.
 *
 * `lockById` filters on the immutable `id` alone, so it cannot miss a row whose
 * status a racing transaction is changing underneath it.
 *
 * Runs INSIDE the caller's transaction and bound tenant context — `work_item` has
 * no system arm, so a caller must have bound a workspace before it gets here.
 * Returns the verdict it settled on, which is also what it stored.
 */
export async function recomputeWorkItemCiState(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<PrCiState> {
  // The lock comes before the read it guards, and the re-read after it: a value
  // read before the lock was granted is a value another transaction may already
  // have replaced.
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) return null;

  const item = await workItemRepository.findById(workItemId, tx);
  /* v8 ignore next -- NO PRODUCER CAN DRIVE THIS, and the invariant that makes it
     so is asserted rather than assumed: `lockById` is `SELECT id … WHERE id = $1
     FOR UPDATE` and `findById` is `findUnique({ where: { id } })`, both unfiltered
     on the SAME immutable id inside ONE transaction — so a granted lock implies a
     readable row. `tests/github/ciStateStoryGate.test.ts` §6 pins exactly that, so
     a `findById` that starts filtering on something `lockById` does not fails
     THERE rather than turning a live card's verdict into a silent `null`. The
     guard stays because the read is nullable and the compiler says so. */
  if (!item) return null;

  const members = await classifyDeliveries({ id: item.id, sessionBranch: item.sessionBranch }, tx);
  const ciState = foldCardCiState(
    members.map((m) => deliveryStateForCard(m.state, m.cannotReport, m.queueFailure)),
  );

  // Idempotent: an unchanged verdict writes nothing. A check event that moves no
  // card is the common case — a second green on an already-green set — and a
  // no-op write would still burn a row version and an activity read.
  if (item.ciState !== ciState) {
    await workItemRepository.update(workItemId, { ciState }, tx);
  }
  return ciState;
}
