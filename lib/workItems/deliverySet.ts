import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import type { PrCiState } from '@/lib/github/prCiState';
import type { RepoDelivery, RepoDeliveryState } from './repoDelivery';
import { repoNameKey } from './repoName';

/**
 * The DELIVERY SET's shortfall — which of a card's deliveries have not landed
 * (Story MOTIR-3655 · MOTIR-3659, ADR `docs/decisions/work-item-delivery-links.md`).
 *
 * ── What this answers, and why it is not the repository-set gate ───────────
 * The repository-set gate asks *"has every repository this card CARRIES seen a
 * merge?"* — a declaration about work that was PROMISED, which can hold a card
 * for a repository whose pull request was never opened at all. This asks *"has
 * every pull request that DELIVERS this card merged?"* — evidence about work
 * that HAPPENED. Since MOTIR-10135 the evidence wins: once a card has a landed
 * delivery ({@link hasLandedDelivery}) it completes on this set alone, and the
 * repository list is read only by the re-check of a card with no landed
 * delivery at all.
 *
 * ── The comparison is PER REPOSITORY, deliberately ────────────────────────
 * A member is landed when its pull request is merged **onto its own
 * repository's default branch**. Never a hard-coded `'main'`: a self-hoster's
 * trunk is `master` or `trunk`, and a card spanning two repositories may face
 * two different names. `repoId` is on the delivery row precisely so this
 * comparison costs no join per member.
 *
 * Pure — no Prisma client, no database — so the gate's hold and the note it
 * posts are both derived from one function rather than two filters that can
 * drift apart.
 */

/** One delivery, in the minimal shape this reasons over. */
export interface DeliveryMember {
  /** `owner/name`, for the note a held card carries. */
  repoLabel: string;
  /** The pull request's number, so the reader can go and look at it. */
  number: number;
  /**
   * The pull request's state — THREE values, not two (MOTIR-5004).
   *
   * ⚠️ THIS WAS `merged: boolean`, AND THE BOOLEAN WAS THE DEFECT. `!merged`
   * collapses two OPPOSITE situations into one branch: a pull request that has
   * not merged YET, and one that was CLOSED and never will. The first is the
   * entire reason this gate exists; the second delivers nothing, so holding a
   * card for it holds it for ever — nothing re-decides such a card, because the
   * gate runs only on a change-request event and a closed pull request emits no
   * further merge. Observed on MOTIR-4789: `motir-core#2715` closed unmerged,
   * `#2747` merged onto `main`, and the merge did not complete the card.
   *
   * `'merged'` is the DISPLAY collapse (`merged` wins over the raw open/closed
   * pair), which is what `LinkedPullRequestDto.state` already carries — so the
   * two UI callers pass theirs straight through, and the sync collapses its raw
   * row with {@link deliveryMemberState}.
   */
  state: 'open' | 'merged' | 'closed';
  /** The branch the pull request TARGETS — null on a row mirrored before Motir
   *  recorded base branches. */
  baseRef: string | null;
  /** That repository's OWN default branch. */
  defaultBranch: string;
}

/**
 * Collapse a stored pull-request row's RAW pair into the member's three-valued
 * state (MOTIR-5004).
 *
 * `github_pull_request` keeps `state: 'open' | 'closed'` and `merged: boolean`
 * separately, because that is what the host reports. Every surface that reasons
 * about a pull request wants the collapse instead, and `LinkedPullRequestDto`
 * already performs it — this is the same collapse for a caller holding the row
 * rather than the DTO.
 */
export function deliveryMemberState(row: {
  state: string;
  merged: boolean;
}): DeliveryMember['state'] {
  if (row.merged) return 'merged';
  return row.state === 'open' ? 'open' : 'closed';
}

/** A stored delivery row, in the fields {@link deliveryMembersOf} reads — the
 *  shape `workItemDeliveryRepository.listByWorkItem` returns. */
export interface StoredDeliveryRow {
  repo: { owner: string; name: string; defaultBranch: string };
  pullRequest: { number: number; state: string; merged: boolean; baseRef: string | null };
}

/**
 * A card's stored delivery rows as the members this module reasons over.
 *
 * One mapping for the two callers that decide completion — the merge sync and the
 * event-free re-check (`repoSetCompletionService`) — so the re-check can never
 * read a member differently from the merge it stands in for (MOTIR-10135).
 */
export function deliveryMembersOf(rows: readonly StoredDeliveryRow[]): DeliveryMember[] {
  return rows.map((d) => ({
    repoLabel: `${d.repo.owner}/${d.repo.name}`,
    number: d.pullRequest.number,
    // ⚠️ THE COLLAPSE, not the raw `merged` flag (MOTIR-5004). The stored row
    // keeps `state` and `merged` apart; passing only the boolean threw away the
    // difference between a pull request that has not merged YET and one that was
    // CLOSED and never will, and the gate then held the card for the latter for
    // ever.
    state: deliveryMemberState(d.pullRequest),
    baseRef: d.pullRequest.baseRef,
    defaultBranch: d.repo.defaultBranch,
  }));
}

/**
 * Whether ANY member has LANDED — merged onto its own repository's default branch
 * (MOTIR-10135).
 *
 * This is what retires the repository-SET gate for a card. A landed delivery is
 * evidence that the card's work happened, and from then on the card completes on
 * its delivery set alone: the repository list is a planning guess about where the
 * work might land, not a promise that every repository on it gets a pull request.
 * A card with no landed member — every delivery still open, closed unmerged, or
 * merged somewhere the trunk cannot vouch for — has no such evidence, and the
 * re-check keeps asking the repository set.
 */
export function hasLandedDelivery(members: readonly DeliveryMember[]): boolean {
  return members.some(
    (m) => m.state === 'merged' && m.baseRef !== null && m.baseRef === m.defaultBranch,
  );
}

export interface DeliverySetShortfall {
  /** Members still OPEN — work the card is genuinely waiting for. ⚠️ A CLOSED,
   *  unmerged member does NOT belong here (MOTIR-5004): it is abandoned, it
   *  delivers nothing, and it appears in no list at all. */
  outstanding: string[];
  /** Members merged onto a base that is NOT their repository's default branch —
   *  a stranded merge, which delivers nothing to the trunk. Its own list because
   *  the note must send the reader to the base that swallowed it. */
  strandedBase: string[];
  /** Members whose base branch was never recorded, so whether the work reached
   *  the trunk cannot be told. Holds, like the other two, and its own list
   *  because the remedy is an operator backfill rather than a merge. */
  unknownBase: string[];
}

export const EMPTY_DELIVERY_SHORTFALL: DeliverySetShortfall = {
  outstanding: [],
  strandedBase: [],
  unknownBase: [],
};

function label(m: DeliveryMember): string {
  return `${m.repoLabel}#${m.number}`;
}

/**
 * The shortfall of a card's delivery set.
 *
 * **Empty for an EMPTY set, which is how the gate ABSTAINS on the common case.**
 * Almost every card in the tree has zero or one delivery, and a card with none
 * behaves exactly as it does today — that is the property this whole story must
 * not perturb, and it falls out of the empty list rather than a special case.
 */
export function deliverySetShortfall(members: readonly DeliveryMember[]): DeliverySetShortfall {
  const outstanding: string[] = [];
  const strandedBase: string[] = [];
  const unknownBase: string[] = [];

  for (const m of members) {
    // ⚠️ ABANDONED FIRST, AND THE ORDER IS LOAD-BEARING (MOTIR-5004). A closed
    // pull request keeps whatever base it targeted, and one mirrored before base
    // capture has none — so testing its base before excluding it drops it into
    // `strandedBase` or `unknownBase`, where it holds the card exactly as
    // `outstanding` used to. The defect would survive its own fix, in a
    // different list.
    if (m.state === 'closed') continue;
    if (m.state === 'open') {
      outstanding.push(label(m));
      continue;
    }
    if (m.baseRef === null) {
      unknownBase.push(label(m));
      continue;
    }
    if (m.baseRef !== m.defaultBranch) {
      strandedBase.push(label(m));
    }
  }

  return { outstanding, strandedBase, unknownBase };
}

/** Whether a shortfall HOLDS the card — any list being non-empty. */
export function hasDeliverySetShortfall(shortfall: DeliverySetShortfall): boolean {
  return (
    shortfall.outstanding.length > 0 ||
    shortfall.strandedBase.length > 0 ||
    shortfall.unknownBase.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The RAIL's amended predicate (Story MOTIR-3655 · MOTIR-3660)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AMEND a classified repository set with what the DELIVERY SET knows
 * (design `design/work-items/delivery-set.mock.html`, CHANGE 1).
 *
 * ── The bug this closes, stated exactly ───────────────────────────────────
 * `classifyRepoDelivery` calls a repository `delivered` when **any** linked pull
 * request merged onto its default branch. That is the right answer to
 * the repository-set question (the retired `deferred_incomplete_repo_set` hold,
 * MOTIR-10135; the re-check still asks it when nothing landed) — *has this repository seen a
 * merge?* — and the WRONG answer for a reader, because a card with two pull
 * requests in ONE repository, one merged and one open, then reads `Delivered`
 * while `deferred_incomplete_delivery_set` is holding it. The rail would assert
 * finished about a card the gate is refusing to finish, which is the failure
 * MOTIR-3655 was filed about, one layer up.
 *
 * So a row is `delivered` only when NEITHER gate holds on it: the repository has
 * seen a merge AND every delivery recorded in that repository has landed on that
 * repository's own default branch. The two gates keep their separate questions —
 * they are not collapsed here, and neither reads this — and the glyph mirrors
 * their CONJUNCTION, which is what a reader actually wants to know.
 *
 * ── What it never does ────────────────────────────────────────────────────
 * **It only ever weakens a row.** A repository the classifier called `awaiting`
 * or `unestablished` is never promoted by a delivery, because a delivery is
 * evidence about a pull request and those two states are claims about the
 * repository. And a card with an EMPTY delivery set — nearly every card in the
 * tree — comes back byte-identical, which is the property the whole story must
 * not perturb and is why the empty case is the first line.
 *
 * Pure, and it lives beside the shortfall it agrees with rather than in the
 * component, so the peek and the detail page cannot each grow their own version
 * of it — the drift `repoDelivery.ts`'s own header was written about.
 */
export function amendRepoDeliveryWithSet(
  repos: readonly RepoDelivery[],
  deliveries: readonly WorkItemDeliveryDto[],
): RepoDelivery[] {
  if (deliveries.length === 0) return [...repos];

  // Grouped on the shared repository IDENTITY: the two sides are written by
  // different tables in different forms (`motir-core` from the card's pin,
  // `moooon-B-V/motir-core` from the pull request), and comparing the raw
  // strings matches nothing at all — the defect `awaitingRepoRows` documents.
  const byRepo = new Map<string, WorkItemDeliveryDto[]>();
  for (const delivery of deliveries) {
    const key = repoNameKey(delivery.pullRequest.repo);
    if (key === null) continue;
    const bucket = byRepo.get(key);
    if (bucket) bucket.push(delivery);
    else byRepo.set(key, [delivery]);
  }

  return repos.map((row) => {
    if (row.state !== 'delivered') return row;
    const key = repoNameKey(row.repo);
    const mine = key === null ? undefined : byRepo.get(key);
    if (mine === undefined || mine.length === 0) return row;

    const shortfall = deliverySetShortfall(
      mine.map((d) => ({
        repoLabel: d.pullRequest.repo,
        number: d.pullRequest.number,
        // The DTO already carries the three-valued collapse, so this passes it
        // straight through (MOTIR-5004) rather than re-deriving a boolean.
        state: d.pullRequest.state,
        baseRef: d.baseRef,
        defaultBranch: d.defaultBranch,
      })),
    );
    if (!hasDeliverySetShortfall(shortfall)) return row;

    // WHICH weaker state, and the order matters: an unrecorded base is a
    // question the reader has to answer (`unknown`, the warning glyph), while an
    // open or stranded delivery is work that has not arrived (`awaiting`, the
    // dashed one). A row with both is `unknown`, because that is the one that
    // asks for an action rather than for patience.
    const state: RepoDeliveryState = shortfall.unknownBase.length > 0 ? 'unknown' : 'awaiting';
    return { ...row, state };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The PROMOTION's predicate (Story MOTIR-3655 · MOTIR-3685)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is a card's whole delivery set GREEN — the question `implemented → in_review`
 * turns on (design decision recorded on MOTIR-3685, 2026-08-27).
 *
 * ── What changed, and why it is a change rather than an addition ───────────
 * `ciPromotion` shipped promoting *every card the pull request delivers* the
 * moment THAT pull request went green. Correct while a card had exactly one
 * pull request, and wrong the first time it has two: a card delivered by
 * `motir-core#1` (green) and `motir-ai#2` (red) was announced reviewable on half
 * its evidence. **One green and one red leaves the card at `implemented`.**
 *
 * ── Two properties, and the second is the one that is easy to lose ────────
 *   1. EVERY member must be `passing`. A `running` member is not a failure and
 *      not a pass — the loop is waiting for a verdict, not receiving one — so it
 *      withholds exactly as a red one does.
 *   2. **An EMPTY set is NOT green.** `[].every(...)` is vacuously true, and a
 *      card with no pull request at all would promote itself to In Review on no
 *      evidence whatever. A card with no pull request has no evidence, and no
 *      evidence is not a pass.
 *
 * ⚠️ A `null` MEMBER IS NOT ALWAYS "NOT PASSING" ANY MORE (MOTIR-3823). This
 * function still reads exactly what it is handed — `passing` or nothing — but the
 * PROMOTION now maps each member through `deliveryStateForPromotion` first, which
 * turns the `null` of a repository that CANNOT report a check into `passing`. The
 * empty-set rule above is untouched by that and is the one property this file
 * must never lose: a card with no delivery at all still has nothing to map.
 *
 * A card with exactly ONE pull request gets the same answer it always did:
 * over a set of one, "every" and "some" agree. That is what makes this safe for
 * the overwhelming majority of cards, and it is asserted rather than assumed.
 */
export function deliverySetIsGreen(states: readonly (string | null)[]): boolean {
  if (states.length === 0) return false;
  return states.every((state) => state === 'passing');
}

// ─────────────────────────────────────────────────────────────────────────────
// A REPOSITORY THAT CANNOT REPORT A CHECK (MOTIR-3823)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `derivePrCiState` answers `null` for a pull request with no check rows, and it
 * is right to: absence of CI is not a state, and the Development pill renders
 * nothing for it. **But `deliverySetIsGreen` reads that `null` as "not passing",
 * which is only correct for ONE of the two situations that produce it:**
 *
 *   1. the repository has **no CI at all** — nothing will ever report; and
 *   2. **nothing has reported YET** — a pull request opened seconds ago, a
 *      webhook still in flight, a run that has not started.
 *
 * Decided by Yue, 2026-08-28: **(1) counts as GREEN.** A repository is allowed
 * to have no CI — `motir-meta` is this project's own instance and carries the
 * planning corpus — and holding its cards at `implemented` for ever punishes it
 * for a choice it was entitled to make. **(2) must keep withholding**, because
 * it is the normal state of every pull request for the first seconds of its
 * life, which is exactly when the arrival edge fires. Mapping `null` to
 * `passing` outright would announce almost every card in the system reviewable
 * the instant its pull request opened, whatever CI later said.
 *
 * ── THE DISCRIMINATOR ─────────────────────────────────────────────────────
 * The two are indistinguishable AT THE PULL REQUEST, so the question is asked of
 * the REPOSITORY, from what Motir has already recorded about it:
 *
 *   - **It has recorded a check run, ever** ⇒ it CAN report. Its silence on this
 *     pull request means "not yet", and the card is held.
 *   - **It has never recorded one, AND at least one of its pull requests reached
 *     MERGE without ever recording one** ⇒ it CANNOT report. A merged pull
 *     request had its entire lifetime to produce a check and produced none; that
 *     is evidence, where "a pull request exists" is only a lack of it.
 *   - **Neither** — a repository with no history at all ⇒ treated as ABLE to
 *     report, which HOLDS the card. Absence of evidence resolves to the
 *     conservative side, deliberately.
 *
 * Its cost: two indexed reads, and only for a delivery whose verdict came back
 * `null` — so nearly every card pays nothing at all. No GitHub API call, no
 * cached column, and nothing for a human to configure. It is self-correcting in
 * both directions: the first check row a repository records answers it for ever,
 * and so does the first merge without one.
 *
 * ── WHAT IT ANSWERS, AND WHAT IT DOES NOT ────────────────────────────────
 * It answers *"can this REPOSITORY report a check?"* It does NOT answer *"will
 * anything report for THIS pull request?"* — a repository whose workflows are
 * paths-filtered can be perfectly able to report and stay silent on a docs-only
 * pull request, and such a card is still held at `implemented`. That is the
 * conservative direction and it is deliberate: the alternative reads a silence
 * as a pass, which is the regression above.
 *
 * **The residual failure, stated so the next reader does not over-trust it:** a
 * genuinely CI-less repository holds its cards until ONE of its pull requests has
 * been WATCHED to merge. Bounded to the start of a repository's life, in the safe
 * direction, and it clears itself. The mirror failure — a repository that HAS CI
 * but has never run it promoting a card early — is what the watched-merge
 * evidence buys out: a pull request Motir saw open and saw merge, with nothing
 * reported in between, is a repository that did not run CI for it.
 *
 * `docs/decisions/ci-less-repository-is-green.md` is the record.
 */
export interface RepoCheckReportingFact {
  repoId: string;
  /** Has ANY pull request in this repository ever recorded a check run? */
  hasEverReportedACheck: boolean;
  /** Has at least one of its pull requests MERGED without recording one? */
  hasMergedWithoutAnyCheck: boolean;
}

/**
 * Is this repository unable to report a check — so a `null` verdict from it is
 * "no CI" rather than "no verdict yet"?
 *
 * Pure, and deliberately NOT in the repository layer: which facts amount to
 * evidence is a judgement, and a judgement belongs where it can be read and
 * asserted without a database.
 */
export function repoCannotReportChecks(fact: RepoCheckReportingFact): boolean {
  if (fact.hasEverReportedACheck) return false;
  return fact.hasMergedWithoutAnyCheck;
}

/**
 * One delivery's contribution to `deliverySetIsGreen`, with the second question
 * asked (MOTIR-3823).
 *
 * ⚠️ IT AMENDS THE PROMOTION'S READING, NEVER `derivePrCiState`. The shared
 * derivation keeps its meaning — `null` is still "absence of CI is not a state",
 * and every surface reading it (the Development pill, the `deliveries` field) is
 * untouched. Only the promotion asks the follow-up, because only the promotion
 * has to turn an absence into a yes or a no.
 *
 * Every non-null state passes through unchanged, which is what keeps this
 * invisible for the overwhelming majority of cards.
 */
export function deliveryStateForPromotion(
  state: string | null,
  cannotReportChecks: boolean,
): string | null {
  if (state !== null) return state;
  return cannotReportChecks ? 'passing' : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// A FINISHED PULL REQUEST THAT NEVER REPORTED (MOTIR-5786)
// ─────────────────────────────────────────────────────────────────────────────

/** One member of a delivery set, in the shape the verdict rule below reads. */
export interface VerdictMember {
  /** `derivePrCiState` at the pull request's latest recorded sha. */
  state: string | null;
  /** Its repository cannot report a check at all ({@link repoCannotReportChecks}). */
  cannotReport: boolean;
  /** A standing merge-queue failure holds it ({@link queueExitHoldsAtHead}). */
  queueFailure: boolean;
  /** The pull request's lifecycle — {@link deliveryMemberState}'s collapse. */
  lifecycle: DeliveryMember['state'];
}

/**
 * The members of a delivery set that carry, or are still WAITING FOR, a
 * verdict — the set BOTH readings are taken over (MOTIR-5786 · MOTIR-5817).
 *
 * ── What it drops: a FINISHED member that is not waiting on anything ───────
 * A pull request that is already MERGED or CLOSED, sits in a repository that
 * CAN report checks, and has said nothing conclusive. The `running` arm of
 * {@link deliveryStateForCard} was written for a pull request opened seconds ago
 * (MOTIR-5470), whose silence means *not yet*. A finished one's means *never*:
 * it will emit no further check, so reading it as `running` pinned the card at
 * `running` for ever.
 *
 * ⚠️ AND "SAID NOTHING CONCLUSIVE" IS TWO ARMS, NOT ONE. MOTIR-5786 closed the
 * first and left the second open, which is why this rule is written on the
 * QUESTION rather than on a state:
 *   - **no check rows at all** → `derivePrCiState` gives `null`. 212 finished
 *     cards on production, nearly all old merges from before checks were
 *     recorded, or merges that skipped CI.
 *   - **rows still at `pending`** → `derivePrCiState` gives `'running'`, not
 *     `null`, so the first arm's `state !== null` test kept it. A completion
 *     event was lost, or the check was abandoned when the pull request merged.
 *     40 finished cards on production, every one of them `done` and correctly
 *     `passing` until the backfill would have overwritten it.
 * Both are a wait that can never end, and neither says anything about the card.
 *
 * ── Why it is a FILTER over the set, not a cell in either mapper ───────────
 * The card could have mapped the member to `null`, which its fold ignores. The
 * promotion cannot: `deliverySetIsGreen` reads `null` as NOT PASSING, so one
 * silent merged pull request beside a green one would still hold the card at
 * `implemented`, and `foldCardCiState` would say `passing` about a card the
 * promotion refuses. The equivalence those two must keep (`passing` exactly when
 * the promotion would promote) holds only if both read the SAME members. So the
 * member leaves the set before either mapper sees it, and the equivalence stays a
 * property instead of a coincidence.
 *
 * ── What it keeps, deliberately ───────────────────────────────────────────
 *   - an OPEN member with no checks, or stuck at pending: still `running`, the
 *     just-opened case — an open pull request really can still report;
 *   - a finished member in a repository that CANNOT report: still `passing`
 *     (MOTIR-3823 decided a CI-less repository is green);
 *   - a finished member that reported a SETTLED verdict: it stands, so a red
 *     merged pull request still makes its card `failing`;
 *   - a member held by a queue failure: never dropped, whatever else is true.
 *
 * A set of only dropped members becomes EMPTY, which folds to `null` and does
 * not promote: the empty-set rule decides it, with no special case here.
 */
export function membersWithAVerdict<M extends VerdictMember>(members: readonly M[]): M[] {
  return members.filter((m) => {
    // A standing queue failure is never dropped, whatever else is true
    // (MOTIR-5717). It outranks both arms below.
    if (m.queueFailure) return true;
    // An OPEN member is still genuinely waiting: both its silence and its
    // `running` mean *not yet*, which is the case MOTIR-5470 wrote them for.
    if (m.lifecycle === 'open') return true;
    // FINISHED from here — it will emit no further check, so the only question
    // left is whether what it already said is a VERDICT or a wait.
    //   - silent: a verdict only where the repository cannot report at all,
    //     which MOTIR-3823 reads as green;
    //   - `running`: a wait that can never end (MOTIR-5817);
    //   - `passing` / `failing`: settled, and it stands.
    if (m.state === null) return m.cannotReport;
    return m.state !== 'running';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The CARD's own verdict (Story MOTIR-5469 · MOTIR-5470)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One delivery's contribution to the CARD's `ciState`, with the same second
 * question the promotion asks (MOTIR-5470).
 *
 * ⚠️ IT DIFFERS FROM {@link deliveryStateForPromotion} IN EXACTLY ONE CELL, AND
 * THAT CELL IS THE WHOLE POINT. Both map a non-null state through untouched, and
 * both turn the `null` of a repository that CANNOT report a check into
 * `'passing'`. They part on the remaining case — a repository that CAN report and
 * has not yet:
 *
 *   - the PROMOTION maps it to `null`, because `deliverySetIsGreen` needs a value
 *     that is not `'passing'` and the promotion has no third answer to give;
 *   - the CARD maps it to `'running'`, because the card's column is READ BY A
 *     PERSON and *waiting for a verdict* is exactly what they want to be told.
 *
 * `'running'` is not `'passing'`, so the two predicates still agree on the only
 * question they share: {@link foldCardCiState} answers `'passing'` over a set
 * precisely when {@link deliverySetIsGreen} answers `true` over the same set.
 * That equivalence is asserted rather than assumed, because it is what lets the
 * badge promise *green CI has already moved this card to In Review*.
 */
export function deliveryStateForCard(
  state: string | null,
  cannotReportChecks: boolean,
  queueFailure: boolean,
): PrCiState {
  // ⚠️ A STANDING MERGE-QUEUE FAILURE WINS OVER THE MEMBER'S OWN CHECKS (MOTIR-5717).
  // The queue ejected this pull request on its MERGE GROUP's checks, so its own
  // checks at the head are usually still green — and a card reading `passing` while
  // the promotion refuses it is exactly the disagreement this fold exists to
  // prevent. `derivePrCiState` is NOT amended (`approval-gates.md` §4 THIRD
  // AMENDMENT, guard (a)): the pill and the promotion's green test keep reading the
  // pull request's own checks; only the CARD's verdict counts the exit.
  if (queueFailure) return 'failing';
  if (state !== null) return state as PrCiState;
  return cannotReportChecks ? 'passing' : 'running';
}

/**
 * FOLD a card's whole delivery set into ONE verdict (MOTIR-5470).
 *
 * ── Precedence: `failing` > `running` > `passing` ─────────────────────────
 * A person scanning a board wants the worst news first. A card delivered by a
 * red pull request and a green one is RED — that is the pull request they have
 * to go and fix, and averaging it away is the defect this fold replaces. Below
 * red, a set still waiting on any member is `running`: the card has no settled
 * verdict yet, and saying `passing` while a member is mid-flight is the same
 * mistake one value down.
 *
 * ── `null` means NO CHECKS, and it is not a fourth verdict ────────────────
 * An EMPTY set folds to `null`, and so does a set none of whose members has a
 * verdict at all. That is the same `null` {@link deliveryStateForCard} and
 * `derivePrCiState` carry — *absence of CI is not a state* — so the badge renders
 * nothing for it and the filter's empty pair matches it.
 *
 * ⚠️ AND THE LAST WRITER DOES NOT WIN ANY MORE. The column's previous writer
 * stamped THIS pull request's verdict onto each delivered card, so a card with
 * two pull requests read whichever reported last — a wrong answer rather than a
 * missing one. The fold is over the SET, so the order events arrive in cannot
 * change what the column says.
 *
 * Pure, and it lives beside the promotion's predicate rather than in the service,
 * so the two readings of one delivery set cannot drift apart.
 */
export function foldCardCiState(states: readonly PrCiState[]): PrCiState {
  if (states.some((s) => s === 'failing')) return 'failing';
  if (states.some((s) => s === 'running')) return 'running';
  if (states.some((s) => s === 'passing')) return 'passing';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// A MERGE-QUEUE FAILURE THAT STILL HOLDS (Story MOTIR-5628 · MOTIR-5717)
// ─────────────────────────────────────────────────────────────────────────────

/** The fields of a pull request's LATEST queue exit this rule reads. */
export interface QueueExitFacts {
  disposition: string;
  requeuedAt: Date | null;
  headSha: string;
}

/**
 * Does this pull request's latest merge-queue exit still HOLD it — a `failure`,
 * not re-queued, recorded at the pull request's CURRENT head?
 *
 * ── ONE RULE, THREE READERS ───────────────────────────────────────────────
 * The promotion hold (`ciPromotion.heldByQueueFailure`, MOTIR-5632), the card's
 * `ciState` fold ({@link deliveryStateForCard}) and the repair claim all ask this
 * question of the same member, and they must get the same answer: a card whose
 * badge says *passing* while the promotion refuses it, or *failing* while it
 * would promote, is a badge nobody can trust. So the rule is stated HERE, once,
 * and every reader calls it.
 *
 * It lifts in exactly two ways: a re-queue stamps `requeuedAt` (*Queue again*, or
 * GitHub's `enqueued` for a re-queue made outside Motir — MOTIR-6903), or a PUSH
 * moves the head so the exit no longer names it. A `neutral` exit (a manual removal, a
 * cleared queue) says nothing about the work and never holds.
 *
 * `headSha` is the member's current head — `pullRequestHead` (MOTIR-7005), the rule
 * the approval gate's `subjectVersion` is written with. A member with no known head
 * holds nothing.
 */
export function queueExitHoldsAtHead(
  exit: QueueExitFacts | null | undefined,
  headSha: string | null | undefined,
): boolean {
  return queueExitStandsAtHead(exit, headSha) && exit!.disposition === 'failure';
}

/**
 * Does this pull request's latest merge-queue exit still STAND at its current head —
 * whatever its disposition (MOTIR-5802 · MOTIR-5805)?
 *
 * The wider half of the rule above, and the one the APPROVAL reads. A `neutral`
 * removal holds no promotion — nothing was learned about the commits — but it DID
 * spend the approval that sent them, so the re-ask and the repair claim ask this
 * question while the promotion hold asks the narrower one. Both are stated here, so
 * the difference between them is one line rather than two re-derivations.
 *
 * It stops standing in exactly two ways, the same two: a re-queue stamps
 * `requeuedAt`, or a PUSH moves the head so the exit no longer names it.
 */
export function queueExitStandsAtHead(
  exit: QueueExitFacts | null | undefined,
  headSha: string | null | undefined,
): boolean {
  if (!exit || !headSha) return false;
  return exit.requeuedAt === null && exit.headSha === headSha;
}
