import type { LandingClass } from '@/lib/mergeQueue/queueExit';
import type { ApprovalGateState } from '@/generated/prisma/client';
import { decisionSubjectVersion, type DecisionIdentity } from '@/lib/approvalGates/decisionSubject';

// THE GATE-SET PREDICATE — which questions a card should currently be ASKING
// (Story MOTIR-5652 · Subtask MOTIR-5660; ADR `docs/decisions/design-result.md`
// AMENDMENT 6, `docs/decisions/approval-gates.md` §1's MOTIR-5658 amendment).
//
// ⚠️ THE QUESTION NO INDIVIDUAL RAISER COULD ANSWER, AND THAT IS THE WHOLE
// POINT. Before this module, which gates a card held was the emergent sum of
// eleven call sites across five services: four that CREATE a gate row and seven
// that supersede one. Each asked a narrow question about its own trigger —
// *should I raise a merge gate?*, *should I retire the design gate?* — and none
// asked *what should this card have?* Every defect in that family lived in the
// space between two locally-correct answers:
//
//   · MOTIR-5603 — two MERGE gates, because two raisers could not see each other.
//   · MOTIR-5604 — a push withdrew the gate and the next green raised nothing,
//     because a withdrawer had no matching raiser.
//   · MOTIR-5652 — NO gate at all, because two suppressors could not see each
//     other: the design gate was suppressed on the reasoning that the merge gate
//     would carry the decision, and the merge gate then refused on the run target.
//
// ⚠️ IT ANSWERS A SET WITH A PRIMARY, NOT ONE GATE. AMENDMENT 6 Q1: a design
// card with a published result and open pull requests has TWO questions, and
// they have different lifetimes — *is this design right?* is durable, *do these
// commits land?* is per attempt. Collapsing them is the mistake this level
// reverses, so a predicate that returned one gate would encode the same error one
// layer deeper, where it would be much harder to see.
//
// ⚠️ PURE, AND DELIBERATELY SO. No repository call, no Prisma client, no
// transaction. Every caller already holds these facts under its own lock, so this
// adds no query, no writer and no lock ordering — and its tests need no fixtures.
// It imports one TYPE and one pure sibling (`decisionSubject`, whose version rule the
// decision question must share with the handler), and nothing else.
//
// ⚠️ ITS INPUTS ARE LOADED IN EXACTLY ONE PLACE — `lib/services/gateSetFor.ts`
// (MOTIR-5662). A caller that gathered some of them itself could answer half the
// question inline and ask the predicate the other half, which is the shape all
// three defects above already have. It shipped with NO caller at all (MOTIR-5660)
// so it could be reviewed as an ANSWER, read against AMENDMENT 6 line by line,
// before any behaviour depended on it; the RAISERS were converted by MOTIR-5662
// and the WITHDRAWERS are MOTIR-5663's.

/** The kinds this predicate decides between. `decision_approval` joined with Story
 *  MOTIR-4907 (MOTIR-5677; `approval-gates.md` §8's FIFTH AMENDMENT) and
 *  `acceptance_result` with Story MOTIR-4949 (MOTIR-5789; §1's MOTIR-5787 amendment).
 *  THREE of the four are PRIMARY carriers; the merge question leads only when it is
 *  asked alone. */
export type AwaitableGateKind =
  | 'design_result'
  | 'decision_approval'
  | 'acceptance_result'
  | 'pull_request_approval'
  /** The REVIEW AGENT's question (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.2)
   *  — asked INSTEAD of the merge question at a green version the agent has not passed. */
  | 'agent_review';

/** One member of the card's delivery set, reduced to what the answer depends on. */
export interface GateSetMember {
  /**
   * `owner/name#number@headSha` — `deliveryMemberVersion`'s spelling, so a member
   * here and that pull request's own gate can never disagree about its head. Null
   * when no head is known, which is NOT the same as "not a candidate": a set with
   * an unknown head cannot be named at all (`deliverySetVersion` returns null).
   */
  memberVersion: string | null;
  /**
   * Whether this member could be merged NOW — open, on a provider that can merge,
   * green at its latest head (`mergeCandidateHead` answers it). MOTIR-5604's
   * refusal, moved here from `raisePullRequestApprovalGate`'s guard chain.
   */
  isMergeCandidate: boolean;
  /**
   * Whether this member's pull request has already MERGED. A merged member is SETTLED —
   * nothing about it is asked again — rather than a reason the question cannot be asked
   * at all. MOTIR-5805 read it so after a queue ejection (§4 FOURTH AMENDMENT); MOTIR-5901
   * extends it to every merge, including one made on the host (§4 SECOND AMENDMENT,
   * decision 4's amendment). Optional; absent reads as not merged.
   */
  merged?: boolean;
}

/** A gate the card already has, reduced to what decides whether it still answers. */
export interface ExistingGate {
  state: ApprovalGateState;
  /** The `DesignEvidence` id for a design gate; the card's own id for a merge gate. */
  subjectId: string;
  subjectVersion: string | null;
  /** When it was decided; null while it awaits (MOTIR-5805 — an ejection outranks
   *  only a decision made BEFORE it). Optional so a caller with no decision in hand
   *  need not spell one. */
  decidedAt?: Date | null;
  /** WHAT A REFUSAL MEANT — `revise` / `re_plan` on a Motir-pressed design or story-run
   *  acceptance refusal, else null (MOTIR-6501). The acceptance merge hold reads it: a
   *  refusal carrying a verdict holds the story's merge, a verdict-less one (GitHub, or a
   *  finished story) holds nothing. Optional; absent reads as no verdict. */
  refusalVerdict?: string | null;
}

export interface GateSetInput {
  /**
   * The card's CURRENT non-withdrawn design result, or null. Current-ness is right
   * here and wrong in `designResultHandler.resolveSubject`, for opposite reasons:
   * that one answers *what was THIS gate asked about* and must never re-point; this
   * answers *what would a gate raised NOW ask about*.
   */
  currentDesignEvidence: { id: string; commitSha: string | null } | null;
  /** The card's most recent `design_result` gate, whatever its state, or null. */
  latestDesignGate: ExistingGate | null;
  /**
   * The card's CURRENT acceptance receipt, or null — a STORY's (Story MOTIR-4949 · Subtask
   * MOTIR-5789; `approval-gates.md` §1, the MOTIR-5787 amendment; WHEN it is asked is the
   * MOTIR-5903 amendment's, below). Current-ness is right here
   * for the reason it is for the design result above: this answers what a gate raised NOW
   * would ask about.
   */
  currentReceipt: { id: string; commitSha: string | null } | null;
  /** The card's most recent `acceptance_result` gate, whatever its state, or null. */
  latestAcceptanceGate: ExistingGate | null;
  /**
   * Whether every live DESCENDANT of the card sits in its project's done category —
   * the acceptance question's timing input on a SUBTASK run (Bug MOTIR-5903;
   * `approval-gates.md` §1, the MOTIR-5903 amendment). Read only when the card
   * delivers no pull request of its own: then the receipt was recorded by a child
   * (the E2E subtask), and approving it is what sets the story `done` — so it is not
   * asked while anything under the story, the recording subtask included, is still
   * open. Optional; absent reads as NOT settled, so a caller that did not load it
   * never raises the question early.
   */
  subtreeSettled?: boolean;
  /** The card's most recent approve-to-merge gate, whatever its state, or null. */
  latestMergeGate: ExistingGate | null;
  /** Every pull request the card delivers. Empty when it delivers none. */
  members: readonly GateSetMember[];
  /** The project's `prMergeMode`. In `auto` Motir merges with no person. */
  prMergeMode: string | null;
  /**
   * Whether the card's status sits in its project's DONE category (`cancelled`
   * included) — resolved by the caller through the workflow, never by comparing a
   * key to `'done'`, so a renamed done status is closed too.
   */
  cardIsTerminal: boolean;
  /**
   * Whether the card's status is `in_review` — by the literal KEY, never by category
   * (`approved` and `implemented` share `in_review`'s category), resolved by the loader
   * from the card it read under the caller's lock (MOTIR-6971).
   *
   * ⚠️ THE CARD'S STATUS IS THE RUN'S OWN STATEMENT THAT IT FINISHED, AND GREEN CI IS
   * NOT. Any pull request can be linked to a card, so a green delivery set says nothing
   * about whether the run that owns the card followed the runbook to the end: it opens
   * its pull requests, sets the card to `implemented`, and CI's promotion then writes
   * `in_review`. A card still at `in_progress` is a DEAD run, waiting for a `motir
   * continue` to set its status right — and asking a person to approve it offered a
   * button the workflow can never honour (`in_progress → approved` is no edge;
   * MOTIR-6914's gate, Sentry `IllegalTransitionError`). So the merge question — and a
   * story run's acceptance question beside it — is asked ONLY at `in_review`: CI all
   * green AND the card in review, both, or no gate.
   */
  cardInReview: boolean;
  /**
   * Whether a STANDING PRIMARY APPROVAL already authorises the merge — the card's
   * latest `design_result` gate is `approved` over its CURRENT result (AMENDMENT 6
   * Q4; Story MOTIR-5652 · Subtask MOTIR-5664), or its latest `acceptance_result`
   * gate is `approved` over its CURRENT receipt (the MOTIR-5787 amendment, point 4;
   * Subtask MOTIR-5789) — {@link primaryApprovalStandsForMerge}.
   *
   * The design gate rises on PUBLISH and the merge gate on GREEN, so the primary
   * can be pressed before CI has spoken. Q4 settles that the press is not refused:
   * the decision stands and **the merge follows on the next green verdict, with no
   * second press**. A merge gate raised at that moment would BE the second press —
   * a question whose answer is already on the record.
   */
  /**
   * ⚠️ THE TWO EVIDENCE-CARRIED PRIMARIES ONLY — the design's standing approval or the
   * acceptance's (MOTIR-5789). The DECISION's is derived here from `decision` below,
   * because its subject is the card's own captured head rather than an evidence row the
   * loader can read; one boolean for all three would hide which of them is carrying.
   */
  primaryApprovalStandsForMerge: boolean;
  /**
   * THE DECISION QUESTION'S INPUTS (Story MOTIR-4907 · MOTIR-5677; `approval-gates.md`
   * §8's FIFTH AMENDMENT). Absent on every card that is not a `decision` +
   * `coding_agent` card, which is what keeps such a card's answer byte-identical to
   * the one it had before the kind existed.
   */
  decision?: {
    /** What the card's pull requests carry, from the capture — or null when nothing
     *  has been captured yet (clause 3: a question is not asked before the head has
     *  been looked at). An UNRESOLVABLE identity is still asked about. */
    identity: DecisionIdentity | null;
    /** The card's most recent `decision_approval` gate, whatever its state. */
    latestGate: ExistingGate | null;
  };
  /** The card's own id — a merge gate's `subjectId` is the card (MOTIR-5603). */
  workItemId: string;
  /**
   * The LATEST UN-LANDED OUTCOME still standing at a member's CURRENT head — when it
   * was recorded, and what CLASS its reason falls in (§4 FOURTH AMENDMENT, points 2–3;
   * MOTIR-5802 · MOTIR-5805). Null when no member carries one. Optional, and absent
   * reads as null, so a caller with no outcome in hand is unchanged.
   *
   * ⚠️ THE CLASS DECIDES WHETHER THE QUESTION COMES BACK AT ALL. `retryable` and
   * `setting` re-ask, because the same commits could still land; `cant_land` does NOT,
   * because they cannot, and a gate there would offer a button guaranteed to fail.
   */
  standingUnlandedOutcome?: { at: Date; landingClass: LandingClass } | null;
  /**
   * `Project.reviewAgentEnabled` (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.2).
   * Honoured in a `manual` project only — §12.2a makes the switch and `auto` exclude each
   * other, and a legacy row holding both reads as the review agent OFF. Optional; absent
   * reads as off, so every caller that does not load it keeps its answer byte-identical.
   */
  reviewAgentEnabled?: boolean;
  /** The card's most recent `agent_review` gate, whatever its state, or null. */
  latestAgentReviewGate?: ExistingGate | null;
  /**
   * The version of the card's newest GATE-OFF agent send-back — a review verdict record the
   * review agent stored as `changes_requested` with the review gate off (Story MOTIR-10327 ·
   * MOTIR-10333; `approval-gates.md` §12.14) — or null. When it is the set's CURRENT version
   * the send-back stands, and neither the merge question nor a review is asked at it.
   * Optional; absent reads as none.
   */
  agentSendBackVersion?: string | null;
  /**
   * The version of the card's newest DISMISSAL of an agent send-back (Story MOTIR-10327 ·
   * MOTIR-10334; `approval-gates.md` §12.15), or null. When it is the set's CURRENT version
   * the send-back there — a gate-off record or a decided `agent_review` refusal — no longer
   * stands, and the merge question is asked again at the same version. Optional; absent
   * reads as none.
   */
  dismissedSendBackVersion?: string | null;
}

/** One question the card should be asking. */
export interface AwaitedGate {
  kind: AwaitableGateKind;
  subjectId: string;
  subjectVersion: string | null;
}

export interface GateSet {
  /**
   * The questions the card should currently be ASKING — what SHOULD be `awaiting`.
   * A caller reconciles: raise what is here and absent, supersede what is absent
   * here and awaiting. A gate that is already DECIDED is not in this set, because
   * it is an answer rather than a question.
   */
  awaited: readonly AwaitedGate[];
  /**
   * Which of `awaited` is PRESENTED as the thing being decided (AMENDMENT 6 Q1).
   * The design gate whenever it is awaited — it carries the question a person is
   * actually answering — else the merge gate, else null. After the design has been
   * decided and a merge later fails, the merge gate is awaited alone and is
   * therefore primary (Q2).
   */
  primary: AwaitableGateKind | null;
}

/**
 * Does this gate already ANSWER the question, rather than ask it?
 *
 * A gate `approved` or `changes_requested` over the same subject is a decision
 * somebody made about exactly this thing. `awaiting` is the question still open —
 * which still belongs in `awaited`, so a reconciling caller leaves it alone
 * instead of superseding and re-raising an identical row (the idempotence
 * MOTIR-5670 tests hardest).
 *
 * ⚠️ `versionIdentifies` IS NOT A CONVENIENCE — the two kinds identify their
 * subject differently, and conflating them is wrong in both directions
 * (MOTIR-5662).
 *
 * · A MERGE gate's `subjectId` is the CARD, which never changes, so only the
 *   version says which commits were answered. Ignoring it would let one approval
 *   silence every later set of commits — the opposite of MOTIR-5632.
 * · A DESIGN gate's `subjectId` is a `design_evidence` row, and those are
 *   IMMUTABLE: a new commit means a new publish means a new row. The id is
 *   therefore the whole identity, and requiring the version to match as well
 *   would re-ask a question somebody has already answered whenever the two
 *   spellings differ — which they do for every design gate raised before this
 *   card, all of which carry a null `subjectVersion`.
 */
/**
 * Has the approval been SPENT on an attempt that did not land (§4 FOURTH AMENDMENT,
 * points 1–4; MOTIR-5802 · MOTIR-5805)? True when an un-landed outcome stands and no
 * approval of the merge was given AFTER it.
 *
 * ⚠️ THE ORDER IS THE WHOLE RULE. The yes that sent the commits was given BEFORE the
 * attempt failed to land, so it has been used and is asked again. A yes given AFTER the
 * outcome — the re-asked gate's own approval — IS the answer to it: it re-queues or
 * merges, and a host refusing THAT is a new outcome of its own rather than a third
 * question about the same one.
 *
 * ⚠️ AND THE CALLER DECIDES WHAT IS UN-LANDED, which is why this takes an instant
 * rather than a row. An outcome reaches it only when it is STANDING — a queue exit
 * nobody put back, a recorded host refusal nobody superseded — and `landed` never
 * reaches it at all. Every DISPOSITION is otherwise in scope, NEUTRAL included: the
 * amendment's point 1 admits no exception, and the disposition decides the CLASS
 * (`lib/mergeQueue/queueExit.ts`), never whether the approval was spent.
 *
 * Shared by the gate set (is the question owed?), the members read (is the row's verb
 * offered?) and the retry (may it act?), so the three cannot disagree.
 */
export function unlandedOutcomeOutranksApproval(
  outcome: { at: Date } | null | undefined,
  approvalDecidedAt: Date | null | undefined,
): boolean {
  if (!outcome) return false;
  return !approvalDecidedAt || outcome.at.getTime() >= approvalDecidedAt.getTime();
}

function alreadyDecided(
  gate: ExistingGate | null,
  subjectId: string,
  subjectVersion: string | null,
  versionIdentifies: boolean,
): boolean {
  if (gate === null) return false;
  if (
    gate.state !== 'approved' &&
    gate.state !== 'changes_requested' &&
    gate.state !== 'overturned'
  ) {
    return false;
  }
  if (gate.subjectId !== subjectId) return false;
  return versionIdentifies ? gate.subjectVersion === subjectVersion : true;
}

/**
 * The canonical version of the delivery SET — each member sorted and joined, so the
 * same set always gives the same string. Null for an empty set and null when ANY
 * member's head is unknown: a set version with a hole in it would claim commits
 * nobody can name.
 *
 * ⚠️ IT DUPLICATES `deliverySetVersion`'s RULE AND NOT ITS CODE, deliberately.
 * That helper takes repository row types; this module is pure over plain values so
 * its tests need no fixtures. The two must agree, and `tests/` asserts it rather
 * than trusting the comment.
 */
function setVersion(members: readonly GateSetMember[]): string | null {
  if (members.length === 0) return null;
  const versions = members.map((member) => member.memberVersion);
  if (versions.some((version) => version === null)) return null;
  return [...(versions as string[])].sort().join(',');
}

/**
 * Does a decided approval of ONE subject authorise the merge that rides on it? True only
 * when the gate is `approved` AND its subject is the one the card currently carries —
 * the pair check every PRIMARY kind shares (AMENDMENT 6 Q4; the MOTIR-5787 amendment,
 * point 4).
 *
 * ⚠️ BOTH HALVES. An approval of v1 authorises nothing once v2 is current — that
 * is the same substitution MOTIR-5661's refusal exists to prevent, read from the
 * other side.
 */
export function approvalStandsForSubject(
  current: { id: string } | null,
  latestGate: { state: string; subjectId: string } | null,
): boolean {
  if (!current || !latestGate) return false;
  return latestGate.state === 'approved' && latestGate.subjectId === current.id;
}

/**
 * Does a decided PRIMARY approval already authorise this card's merge — the design's
 * (AMENDMENT 6 Q4) or the acceptance's (the MOTIR-5787 amendment, point 4)?
 *
 * ⚠️ ONE READER FOR EVERY PRIMARY KIND, generalised rather than twinned (MOTIR-5789). A
 * second acceptance-specific boolean beside the design one would be two answers to *may
 * this merge follow on the next green?*, which is how MOTIR-5652's two suppressors each
 * came to assume the other.
 *
 * ⚠️ IT LIVES IN THE PURE MODULE because `settleGreenVerdict` asks the same
 * question, and `gateSetFor` already imports `mergeGates` for `mergeCandidateHead`
 * — putting it there would close a cycle. The predicate
 * answers *no merge gate is owed*, and something still has to merge. One reader
 * would leave a card with neither.
 */
export function primaryApprovalStandsForMerge(args: {
  currentDesign: { id: string } | null;
  latestDesignGate: { state: string; subjectId: string } | null;
  currentReceipt: { id: string } | null;
  latestAcceptanceGate: { state: string; subjectId: string } | null;
}): boolean {
  return (
    approvalStandsForSubject(args.currentDesign, args.latestDesignGate) ||
    approvalStandsForSubject(args.currentReceipt, args.latestAcceptanceGate)
  );
}

/**
 * Does the card's DESIGN hold its merge (Bug MOTIR-5762; AMENDMENT 6 Q1)? True whenever
 * the card carries a current design result that no approval over THAT result has
 * answered — awaiting, decided `changes_requested`, or approved for a result since
 * superseded. A card with no design result is never held.
 *
 * ⚠️ IT IS NOT "A DESIGN GATE IS AWAITING". A design sent back is not an open question
 * — `resolveGateSet` rightly asks nothing about it — and it still must not merge. The
 * merge FOLLOWS an approval; anything short of one holds it, in either mode.
 *
 * ⚠️ AND IT IS THE MERGE PATHS THAT DO NOT GO THROUGH THE DESIGN'S OWN PRESS that ask
 * it: `settleGreenVerdict`'s `auto` arm and the GitHub review sync. The press decides
 * the design first and carries the merge after, so it never meets a hold.
 */
export function designHoldsMerge(
  currentDesign: { id: string } | null,
  latestDesignGate: { state: string; subjectId: string } | null,
): boolean {
  return currentDesign !== null && !approvalStandsForSubject(currentDesign, latestDesignGate);
}

/**
 * Does a STORY RUN's refused acceptance hold its merge (Story MOTIR-6071 · MOTIR-6503;
 * `acceptance-refusal-verdict.md` §3)? True while the story's latest acceptance gate is a
 * `changes_requested` carrying a VERDICT, over the receipt that is CURRENT.
 *
 * ⚠️ WITHDRAWING THE MERGE GATE IS NOT ENOUGH, AND THIS IS WHY IT EXISTS. The refusal
 * withdraws the story's waiting merge gate (`pulled_back`), but a withdrawn gate is not a
 * decided one (`alreadyDecided`), so the next reconcile at a green set would ask the merge
 * question again — alone, because the acceptance question is already answered over that
 * receipt. That reconcile comes from `ciPromotion`, the reconcile sweep, a status move at
 * or above `implemented`, and every push `motir fix` makes before the video is re-recorded.
 * So while the refusal stands the merge is neither ASKED (`resolveGateSet`) nor PERFORMED
 * by a manual-mode path (the approve press, the GitHub review sync). It is the rule a
 * sent-back design already follows ({@link designHoldsMerge}).
 *
 * ⚠️ A NEWER RECEIPT RELEASES IT — the predicate reads the CURRENT receipt, so the video
 * `motir fix` publishes after a Re-run asks the acceptance and the merge together again.
 * A refusal with NO verdict — GitHub-sourced, or a finished story's — holds nothing: a
 * finished story has no merge gate, and a GitHub refusal moves nothing (§2, §7).
 */
export function acceptanceRefusalHoldsMerge(
  currentReceipt: { id: string } | null,
  latestAcceptanceGate: {
    state: string;
    subjectId: string;
    refusalVerdict?: string | null;
  } | null,
): boolean {
  if (!currentReceipt || !latestAcceptanceGate) return false;
  return (
    latestAcceptanceGate.state === 'changes_requested' &&
    latestAcceptanceGate.subjectId === currentReceipt.id &&
    (latestAcceptanceGate.refusalVerdict ?? null) !== null
  );
}

/**
 * WHERE THE REVIEW AGENT STANDS on the merge question at the set's CURRENT version (Story
 * MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.2, §12.2a, §12.5).
 *
 *  · `not_required` — the review does not stand in front of this merge question: the switch
 *    is off, the project is not `manual` (§12.2a — a legacy row holding both reads as OFF),
 *    the set has no version, or the merge question AT THIS VERSION has already been asked
 *    (a merge gate at it that was not withdrawn — awaiting, approved or refused). The last
 *    is §12.5's *switching ON asks nothing of a card already holding an awaiting
 *    approve-and-merge gate*, and it is what keeps a re-ask after an ejection a MERGE
 *    question rather than a second review of commits already answered.
 *  · `passed` — the latest review at this version was approved (the agent's pass, or a
 *    person continuing without it): the ordinary flow is asked.
 *  · `refused` — the agent requested changes at this version: nothing further is asked
 *    for it (§12.4). ONE REVIEW PER VERSION — a decided review is never asked again.
 *    A person's DISMISSAL at this version (`dismissedVersion`, §12.15) reads as `passed`:
 *    the review is answered, overruled, and the merge question is asked.
 *  · `owed` — no decided review at this version (none yet, or only a WITHDRAWN one — a red
 *    build and a green again at the same head is reviewed again): ask the review, and not
 *    the merge.
 *
 * Shared by {@link resolveGateSet} (which question is asked) and the carry's settlement
 * (`mergeGates.settleGreenVerdict` — whether a primary's carried merge may go), so the two
 * cannot disagree about whether the review has passed.
 */
export type AgentReviewStanding = 'not_required' | 'passed' | 'refused' | 'owed';

export function agentReviewStanding(args: {
  reviewAgentEnabled: boolean;
  prMergeMode: string | null;
  workItemId: string;
  version: string | null;
  latestAgentReviewGate: Pick<ExistingGate, 'state' | 'subjectId' | 'subjectVersion'> | null;
  latestMergeGate: Pick<ExistingGate, 'state' | 'subjectVersion'> | null;
  /** The version of the card's newest dismissal of an agent send-back, or null. */
  dismissedVersion?: string | null;
}): AgentReviewStanding {
  if (!args.reviewAgentEnabled || args.prMergeMode !== 'manual' || args.version === null) {
    return 'not_required';
  }
  const merge = args.latestMergeGate;
  if (merge && merge.state !== 'superseded' && merge.subjectVersion === args.version) {
    return 'not_required';
  }
  const review = args.latestAgentReviewGate;
  if (review && review.subjectId === args.workItemId && review.subjectVersion === args.version) {
    if (review.state === 'approved') return 'passed';
    if (review.state === 'changes_requested' || review.state === 'overturned') {
      return args.dismissedVersion === args.version ? 'passed' : 'refused';
    }
  }
  return 'owed';
}

/**
 * Does a decided DECISION approval already authorise this card's merge (clause 5, the
 * design gate's Q4 carry one kind over)? True only when the card's latest decision
 * gate is `approved` over the version the card's pull requests carry NOW.
 *
 * ⚠️ OVER THE CURRENT VERSION, and the version is the document's BLOB (clause 4). An
 * approval of a document a later push rewrote authorises nothing — the new text is a
 * new question — while a push that left the document alone leaves it standing.
 */
export function decisionApprovalStandsForMerge(
  identity: DecisionIdentity | null,
  latestDecisionGate: { state: string; subjectVersion: string | null } | null,
): boolean {
  if (!identity || !identity.resolvable || !latestDecisionGate) return false;
  return (
    latestDecisionGate.state === 'approved' &&
    latestDecisionGate.subjectVersion === decisionSubjectVersion(identity)
  );
}

/**
 * WHICH GATES this card should be asking, and which one leads.
 *
 * The whole answer, in the order the ADR states it:
 *
 *  1. **A terminal card asks nothing.** Its work is over; a question on it could
 *     never be acted on.
 *  2. **The DESIGN question** is owed whenever the card has a current design result
 *     that no decision has answered. It does NOT depend on pull requests, on CI, or
 *     on who holds the run target — AMENDMENT 6 Q1 reverses AMENDMENT 4 Q8's
 *     suppression, and MOTIR-5652's run-target refusal is not represented here at
 *     all because a card with something to decide has a gate regardless of it.
 *  2b. **The ACCEPTANCE question** is owed when the card has a current receipt no
 *     decision has answered AND the work it shows can finish — the MOTIR-5903
 *     amendment, which reverses the MOTIR-5787 amendment's *"does not depend on pull
 *     requests"*. On a STORY run (the story delivers pull requests) that is exactly when
 *     every member could be merged now; on a SUBTASK run (it delivers none) it is when
 *     every descendant is in the done category. Never while a story's set is red, and
 *     never while the recording subtask is unmerged.
 *  3. **The MERGE question** is owed in a `manual` project when the card delivers at
 *     least one pull request, EVERY member could be merged now or has already merged
 *     (a merged member is settled — MOTIR-5901), at least one is still open to merge,
 *     no decision has already answered these exact commits, and no standing design
 *     approval already authorises the merge (Q4 — asking there would be the second
 *     press Q4 forbids).
 *
 *     ⚠️ **A MERGE THAT DID NOT LAND PUTS THE QUESTION BACK — UNLESS THE COMMITS
 *     CANNOT LAND AT ALL** — §4's FOURTH AMENDMENT, points 1–3 (MOTIR-5802 ·
 *     MOTIR-5805), which REVERSES the rule MOTIR-5666 wrote here (*"a failed merge
 *     does not put the question back"*, keyed to *Queue again*). When a member
 *     carries an UN-LANDED outcome standing at its current head — a queue exit of
 *     any disposition, NEUTRAL included, or a recorded host refusal — and no merge
 *     approval was given after it, the question is OWED in a `manual` project even
 *     though the latest merge gate is `approved` at the same set version, and even
 *     where the design's one-press carry answered it: one approval authorizes ONE
 *     attempt, and that attempt did not land. The one EXCEPTION is the `cant_land`
 *     class (a conflict): the same commits cannot combine, so a gate there would
 *     offer a button guaranteed to fail — the card is held at `implemented` with
 *     `motir fix`, and only a PUSH brings the question back. The DESIGN question is
 *     untouched — the design was never the problem. The old gate row is never
 *     edited or re-decided; the re-ask is computed from the OUTCOME
 *     (`standingUnlandedOutcome`), not from the approval. A PUSH still moves the
 *     head, the outcome stops standing, and the next green asks about the new
 *     commits. The candidacy check is MOTIR-5604's and the same-commits check is
 *     MOTIR-5632's; both survive as inputs rather than as guards scattered across
 *     raisers.
 *  3b. **The REVIEW AGENT's question** (`approval-gates.md` §12.2, MOTIR-6819) is owed
 *     INSTEAD of the merge question when the project's review agent is on (`manual` only,
 *     §12.2a) and no review at the current set version has been decided — see
 *     {@link agentReviewStanding}. A pass puts the merge question back for the SAME
 *     version; the agent's Request changes asks nothing more for it.
 *  4. **The DESIGN gate is primary** whenever both are owed (Q1). A merge gate owed
 *     alone — after an approval whose merge then failed — leads by itself (Q2).
 */
export function resolveGateSet(input: GateSetInput): GateSet {
  if (input.cardIsTerminal) return { awaited: [], primary: null };

  const awaited: AwaitedGate[] = [];

  const evidence = input.currentDesignEvidence;
  if (
    evidence !== null &&
    !alreadyDecided(input.latestDesignGate, evidence.id, evidence.commitSha, false)
  ) {
    awaited.push({
      kind: 'design_result',
      subjectId: evidence.id,
      subjectVersion: evidence.commitSha,
    });
  }

  // THE DECISION QUESTION (clauses 1–4). Owed whenever the card asks it and a captured
  // head gives it something to ask about — INCLUDING an unresolvable one, which raises
  // a gate that cannot be approved and holds the merge (clause 3). `subjectId` is the
  // card, so only the VERSION says which document was answered.
  const decision = input.decision;
  const decisionVersion = decision?.identity ? decisionSubjectVersion(decision.identity) : null;
  if (
    decision?.identity &&
    !alreadyDecided(decision.latestGate, input.workItemId, decisionVersion, true)
  ) {
    awaited.push({
      kind: 'decision_approval',
      subjectId: input.workItemId,
      subjectVersion: decisionVersion,
    });
  }
  const decisionStands = decisionApprovalStandsForMerge(
    decision?.identity ?? null,
    decision?.latestGate ?? null,
  );

  const version = setVersion(input.members);
  // ⚠️ Q4'S CARRY IS ONE-TIME, AND ONLY WHILE THE CARD HAS NO MERGE GATE AT ALL
  // (MOTIR-5666 found this; MOTIR-5664 shipped it without the second clause). Q4
  // holds the merge a press made BEFORE the set went green and lets it follow on
  // the next verdict. Once a merge gate has existed — raised, approved, ejected —
  // the commits have a history of their own, and a later PUSH is a new question
  // about new commits. Without this clause the design approval would go on
  // authorising every future green, merging code nobody approved.
  //
  // EVERY primary carries the merge on exactly the same one-time terms — the design's
  // (Q4), the decision's (clause 5) and the acceptance's (the MOTIR-5787 amendment,
  // point 4): a primary answered before the set went green, followed once.
  const carriedByPrimary =
    (input.primaryApprovalStandsForMerge || decisionStands) && input.latestMergeGate === null;
  // §4 FOURTH AMENDMENT (MOTIR-5802 · MOTIR-5805): an UN-LANDED outcome standing at a
  // member's head outranks every merge decision made BEFORE it — a decided gate and the
  // primary's carry alike. `manual` only: `auto` has no person to ask, and never reaches
  // here.
  const outcome = input.standingUnlandedOutcome ?? null;
  const reaskedByEjection =
    outcome !== null &&
    // ⚠️ A CAN'T-LAND OUTCOME ASKS NOTHING (point 2). The commits cannot land as they
    // stand, so the card waits at `implemented` with `motir fix`, and the question comes
    // back only when a PUSH moves the head — at which point this outcome stops standing.
    outcome.landingClass !== 'cant_land' &&
    unlandedOutcomeOutranksApproval(
      { at: outcome.at },
      // Any DECISION after the outcome answers it — an approval (which re-queues) or a
      // request for changes (which re-queues nothing and is still an answer).
      input.latestMergeGate?.decidedAt ?? null,
    );
  const answered =
    !reaskedByEjection &&
    (carriedByPrimary || alreadyDecided(input.latestMergeGate, input.workItemId, version, true));
  // ⚠️ A member that has already MERGED is SETTLED, not blocking — whatever made it merge
  // (MOTIR-5901; §4 SECOND AMENDMENT, decision 4's amendment). MOTIR-5805 read it this way
  // for an ejection only, and everywhere else a merged member kept the set unaskable for
  // ever: a member merged with the host's own button withdrew the gate (`member_closed`)
  // and no later verdict could re-raise it, so the rest could only be merged on the host.
  // The question is about the commits that have NOT landed; the set version still names
  // every member, merged ones included.
  //
  // ⚠️ AND AT LEAST ONE MEMBER MUST STILL BE OPEN AND MERGEABLE. A set with nothing left
  // to land asks nothing — ejection or not. A member CLOSED WITHOUT MERGING is neither,
  // and still blocks: reopening or unlinking it is what puts the question back.
  const everyMemberMergeable =
    input.members.some((member) => member.isMergeCandidate) &&
    input.members.every((member) => member.isMergeCandidate || member.merged === true);
  // THE ACCEPTANCE QUESTION (Story MOTIR-4949 · Subtask MOTIR-5789) — owed when the
  // card carries a current receipt no decision has answered AND the work it shows can
  // actually finish (Bug MOTIR-5903; `approval-gates.md` §1, the MOTIR-5903 amendment,
  // which REPLACES the MOTIR-5787 amendment's *"it does not depend on pull requests, on
  // CI, or on the run target"*). The acceptance video is the STORY's gate, never a
  // question of its own, so its timing follows the run shape:
  //
  //  · STORY RUN — the story delivers pull requests of its own. The video is EVIDENCE
  //    for the one approve-to-merge decision, so it is asked exactly when that set is
  //    green — beside the merge question, which it leads — and never while any member
  //    is red, pending, drafted or closed.
  //  · SUBTASK RUN — the story delivers nothing; a child (the E2E subtask) recorded the
  //    video and delivered the code. Approving it sets the story `done`, so it is asked
  //    only once nothing under the story is left open (`subtreeSettled`): while the
  //    recording subtask's pull request is unmerged the story cannot finish, and there
  //    is nothing to approve yet.
  //
  // A receipt row is immutable like an evidence row, so its id is the whole identity
  // (`versionIdentifies: false`).
  const receipt = input.currentReceipt;
  const storyRun = input.members.length > 0;
  // A story run's video rides the merge question, so it takes that question's status
  // condition too (MOTIR-6971): asked only while the story is `in_review`.
  //
  // ⚠️ AND A STORY RUN'S VIDEO IS NOT ASKED WHILE THE MERGE IS REFUSED AT THIS VERSION —
  // a person's Request changes on the merge gate, or a standing agent send-back. The video
  // rides the merge question, so refusing the commits withdrew it too
  // (`pullRequestApprovalHandler.requestChanges`, `reviewVerdictService`'s send-back), and
  // without this clause the next reconcile would ask it again, alone, over the code just
  // sent back. A push moves the version and asks both again.
  const sentBack =
    version !== null &&
    (input.agentSendBackVersion ?? null) === version &&
    (input.dismissedSendBackVersion ?? null) !== version;
  const mergeRefusedAtVersion =
    version !== null &&
    input.latestMergeGate?.state === 'changes_requested' &&
    input.latestMergeGate.subjectId === input.workItemId &&
    input.latestMergeGate.subjectVersion === version;
  const acceptanceTimely = storyRun
    ? everyMemberMergeable && input.cardInReview && !mergeRefusedAtVersion && !sentBack
    : input.subtreeSettled === true;
  if (
    receipt !== null &&
    acceptanceTimely &&
    !alreadyDecided(input.latestAcceptanceGate, receipt.id, receipt.commitSha, false)
  ) {
    awaited.push({
      kind: 'acceptance_result',
      subjectId: receipt.id,
      subjectVersion: receipt.commitSha,
    });
  }

  // ⚠️ A STORY RUN'S REFUSED ACCEPTANCE HOLDS THE MERGE (MOTIR-6503;
  // `acceptance-refusal-verdict.md` §3). The refusal withdrew the merge gate, and without
  // this clause the very next green would ask it again, alone — so the refused code could
  // be merged by one press. Held until a NEWER receipt is current.
  const acceptanceHolds = acceptanceRefusalHoldsMerge(
    input.currentReceipt,
    input.latestAcceptanceGate,
  );
  // ⚠️ A STANDING CAN'T-LAND OUTCOME ASKS NOTHING, WHATEVER THE LATEST GATE SAYS (§4
  // FOURTH AMENDMENT, point 3; MOTIR-6595). Until the convergence of MOTIR-6595 this held
  // only because the latest merge gate was the APPROVAL the outcome spent, which
  // `answered` reads. Withdrawing a gate the OLD rule re-asked from a queue failure leaves
  // the latest gate `superseded`, and without this clause the reconcile would ask again
  // over the very commits that cannot land. A push is what ends the outcome, and the next
  // green asks about the new commits.
  const cantLandHolds = outcome?.landingClass === 'cant_land';
  // ⚠️ ONLY A CARD AT `in_review` IS ASKED (MOTIR-6971; `approval-gates.md` §8's EIGHTH
  // AMENDMENT). Green CI alone is not a finished run — see `cardInReview`. The CI
  // promotion writes `implemented → in_review` BEFORE it reconciles, in the same
  // transaction, so the ordinary path is unchanged; every other raiser (the sweep, the
  // post-transition re-ask, a withdrawer's re-raise) now asks nothing of a card the run
  // has not settled. It gates `mergeAskable`, so the REVIEW AGENT's question, which
  // stands in front of the merge question, is asked only there too.
  const mergeAskable =
    input.prMergeMode === 'manual' &&
    input.cardInReview &&
    !acceptanceHolds &&
    !cantLandHolds &&
    everyMemberMergeable &&
    version !== null;
  // ⚠️ THE REVIEW AGENT STANDS IN FRONT OF THE MERGE QUESTION (Story MOTIR-1626 ·
  // MOTIR-6819; `approval-gates.md` §12.2). With the switch on, a green set asks the
  // REVIEW instead of the merge until the review at this version has passed or been
  // overridden — HERE, in the one rule, so every raiser (the promotion, a status move into
  // review, the reconcile tick, a queue exit, every withdrawal's re-raise) asks the same
  // thing. It also holds a primary's CARRIED merge: `answered` by the carry asks nothing
  // either way, and `settleGreenVerdict` reads the same standing before it merges.
  const review = agentReviewStanding({
    reviewAgentEnabled: input.reviewAgentEnabled === true,
    prMergeMode: input.prMergeMode,
    workItemId: input.workItemId,
    version,
    latestAgentReviewGate: input.latestAgentReviewGate ?? null,
    latestMergeGate: input.latestMergeGate,
    dismissedVersion: input.dismissedSendBackVersion ?? null,
  });
  // ⚠️ A STANDING AGENT SEND-BACK ASKS NOTHING AT ITS VERSION (MOTIR-10333; §12.14). With
  // the review gate off the send-back is a record, not a gate, so `review` cannot see it:
  // the merge question stays withdrawn (`agent_changes_requested`) until a push moves the
  // version, and a review switched on since is not asked of commits already reviewed.
  // A person's DISMISSAL at the version (MOTIR-10334; §12.15) ends it: the merge question is
  // asked again, at the same version, through this one rule. (`sentBack` is computed above,
  // where the acceptance question reads it too.)
  if (mergeAskable && !sentBack && review === 'owed') {
    awaited.push({
      kind: 'agent_review',
      subjectId: input.workItemId,
      subjectVersion: version,
    });
  } else if (mergeAskable && !sentBack && review !== 'refused' && !answered) {
    awaited.push({
      kind: 'pull_request_approval',
      subjectId: input.workItemId,
      subjectVersion: version,
    });
  }

  // ⚠️ A CARD CANNOT HOLD BOTH A DESIGN AND AN ACCEPTANCE PRIMARY — a design result
  // belongs to the design LEAF that produced it and a receipt to a STORY
  // (`design-result.md` §3; the MOTIR-5787 amendment, point 2). ASSERTED, never ranked:
  // a card that arrives here with both is a defect upstream, and choosing one would
  // quietly hide the other question.
  const designOwed = awaited.some((gate) => gate.kind === 'design_result');
  const acceptanceOwed = awaited.some((gate) => gate.kind === 'acceptance_result');
  if (designOwed && acceptanceOwed) {
    throw new Error(
      `gate set: work item ${input.workItemId} owes BOTH a design and an acceptance question`,
    );
  }
  // A PRIMARY question leads whenever it is owed — the design, else the decision
  // (clause 5), else the acceptance (the MOTIR-5787 amendment, point 2); the merge
  // question leads only when it is asked alone.
  const primary: AwaitableGateKind | null =
    awaited.find((gate) => gate.kind === 'design_result')?.kind ??
    awaited.find((gate) => gate.kind === 'decision_approval')?.kind ??
    awaited.find((gate) => gate.kind === 'acceptance_result')?.kind ??
    awaited[0]?.kind ??
    null;

  return { awaited, primary };
}
