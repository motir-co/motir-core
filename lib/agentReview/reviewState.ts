import type {
  ApprovalGate,
  ReviewAgentSource,
  ReviewDismissal,
  ReviewVerdictRecord,
} from '@/generated/prisma/client';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import { standingReviewRefusalFrom } from '@/lib/approvalGates/reviewRefusal';
import { countableReviewsAtHead, type CountableReview } from '@/lib/approvalGates/reviewVerdict';

// THE REVIEW STATE, DERIVED (Story MOTIR-10327 · MOTIR-10340; `approval-gates.md` §12.1,
// §12.6, §12.10–§12.15; `design/github/design-notes.md` § 32). Pure: no I/O. The service
// (`reviewStateService`) reads the rows in a fixed number of queries and hands each card's
// facts here; this module turns them into the six answers every surface draws.
//
// ⚠️ EVERYTHING IS READ AT THE CARD'S CURRENT DELIVERY-SET VERSION. A head move changes the
// version, so a pass, a skip, a dismissal or an awaiting gate about an older version simply
// stops matching — the badge and the marker go without a cleanup job, and nothing an older
// head earned carries over.
//
// ⚠️ DERIVED, NEVER STORED. The only write this read model owns is the one-time
// review-to-run notification, and that is not here.

/** The `harness` the hosted review run records on its verdict rows. */
export const HOSTED_REVIEW_HARNESS = 'Motir hosted review';

/** A verdict record ANSWERS its version when it decided the gate or stood as the review. */
const ANSWERING = new Set<ReviewVerdictRecord['outcome']>(['decided', 'recorded']);

/** One member of the card's delivery set, with what the read model needs of it. */
export interface ReviewStateMember {
  repo: string;
  number: number;
  /** The head the set's version names for this member. */
  headSha: string;
  /** The host's numeric id of the pull request's author; null when not known. */
  authorGithubUserId: string | null;
  /** Every stored GitHub review of the pull request. */
  reviews: readonly CountableReview[];
}

/** A person, as a review state names them. */
export interface ReviewStatePerson {
  id: string;
  name: string | null;
}

export type ReviewStateGate = Pick<
  ApprovalGate,
  | 'id'
  | 'kind'
  | 'state'
  | 'subjectVersion'
  | 'noteMd'
  | 'decidedById'
  | 'decidedByLabel'
  | 'decidedUnderAuthority'
  | 'decidedAt'
  | 'reviewUnavailableReason'
  | 'createdAt'
> & {
  /** The decider's live name, resolved by the service; null when it no longer resolves. */
  decidedByName: string | null;
};

export type ReviewStateRecord = Pick<
  ReviewVerdictRecord,
  | 'id'
  | 'gateId'
  | 'subjectVersion'
  | 'verdict'
  | 'outcome'
  | 'findingsMd'
  | 'submittedById'
  | 'harness'
  | 'model'
  | 'createdAt'
> & { submittedByName: string | null };

export type ReviewStateDismissal = Pick<
  ReviewDismissal,
  'id' | 'subjectVersion' | 'reasonMd' | 'dismissedById' | 'createdAt'
> & { dismissedByName: string | null };

/** Everything one card's review state is derived from — rows the service already read. */
export interface ReviewStateFacts {
  identifier: string;
  /** The card's status is in the done category (Done or Cancelled). */
  finished: boolean;
  reviewAgentEnabled: boolean;
  reviewAgentSource: ReviewAgentSource;
  /** `deliverySetVersion` of the card's set; null when it is empty or a head is unknown. */
  currentVersion: string | null;
  members: readonly ReviewStateMember[];
  /** Every `agent_review` gate of the card, any state. */
  agentGates: readonly ReviewStateGate[];
  /** The card's latest DECIDED gate of any kind — the standing-refusal rule's input. */
  latestDecidedGate: ApprovalGate | null;
  /** Every review verdict record of the card, any version and outcome. */
  records: readonly ReviewStateRecord[];
  /** Every dismissal on the card. */
  dismissals: readonly ReviewStateDismissal[];
  /** Whether a hosted review run is in flight for the awaiting `agent_review` gate. */
  reviewRunInFlight: boolean;
  /** §2's routed person (`assigneeId ?? reporterId`), or null. */
  routedTo: ReviewStatePerson | null;
  /** The routed person's linked GitHub user id, or null when they linked none. */
  routedGithubUserId: string | null;
  /** The reader. */
  viewerUserId: string;
}

/** Which review answered a version — the link the surfaces open for the findings. */
export type ReviewRecordRef = { kind: 'record'; id: string } | { kind: 'gate'; id: string };

/** Who passed the review. */
export type ReviewReviewer =
  | { kind: 'hosted'; model: string | null }
  | { kind: 'own'; person: ReviewStatePerson | null; harness: string; model: string };

/** One commit the review was at. */
export interface ReviewCommit {
  repo: string;
  number: number;
  headSha: string;
}

export interface ReviewPass {
  reviewer: ReviewReviewer;
  at: Date;
  subjectVersion: string;
  ref: ReviewRecordRef;
}

export type ReviewMarker =
  | { kind: 'agent_reviewing' }
  | {
      kind: 'could_not_run';
      reason: string;
      routedTo: ReviewStatePerson | null;
      forViewer: boolean;
    }
  | {
      kind: 'waiting_for_own_agent';
      routedTo: ReviewStatePerson | null;
      forViewer: boolean;
      command: string;
    };

export type ReviewLineValue =
  | 'reviewed_by_agent'
  | 'review_skipped'
  | 'review_dismissed'
  | 'not_reviewed';

export interface ReviewLine {
  value: ReviewLineValue;
  /** The person who skipped or dismissed; null for the other two values. */
  actor: ReviewStatePerson | null;
  /** The reason they gave; null for the other two values. */
  reason: string | null;
  /** The reviewer, for `reviewed_by_agent`. */
  reviewer: ReviewReviewer | null;
  /** When the agent passed, for `reviewed_by_agent`. */
  at: Date | null;
  /** Each countable GitHub approval at the member's current head. */
  githubApprovals: { login: string; repo: string; number: number }[];
  /** For `not_reviewed`: the version an earlier pass was at, or null. */
  lastReviewedVersion: string | null;
  /** For `not_reviewed`: that earlier pass, for the line's *Last reviewed* link. */
  lastReviewedRef: ReviewRecordRef | null;
  /** For `not_reviewed`: the command a person runs in their own agent. */
  command: string | null;
}

/** What one card's review state answers. */
export interface ReviewState {
  currentVersion: string | null;
  marker: ReviewMarker | null;
  reviewed: { reviewer: ReviewReviewer; at: Date; commits: ReviewCommit[] } | null;
  reviewLine: ReviewLine | null;
  /** The answering pass at the current version — the findings and checklist link. */
  recordRef: ReviewRecordRef | null;
  /** An agent send-back stands at the current version (the To fix rule's own answer). */
  sentBack: boolean;
  /**
   * That send-back, when it is a gate-off review RECORD (MOTIR-10342; design § 32.6) — the
   * one the Development frame draws as its Sent back band, with Dismiss the review under it.
   * Null for a decided `agent_review` gate (the frame draws that from the gate).
   */
  sentBackRecord: { recordId: string; findingsMd: string | null; at: Date } | null;
  reviewToRun: { gateId: string; command: string } | null;
  /** The routed person is the GitHub author of EVERY pull request of the set. */
  authorOfEveryPr: boolean;
  routedTo: ReviewStatePerson | null;
  viewerIsRouted: boolean;
}

/** The command a person runs to review a card with their own agent. */
export function reviewCommand(identifier: string): string {
  return `motir review ${identifier}`;
}

/** Who reviewed, from a verdict record: the hosted run's harness, or a person's own agent. */
export function reviewerOfRecord(
  record: Pick<ReviewStateRecord, 'harness' | 'model' | 'submittedById' | 'submittedByName'>,
): ReviewReviewer {
  if (record.harness === HOSTED_REVIEW_HARNESS) {
    return { kind: 'hosted', model: record.model === 'unknown' ? null : record.model };
  }
  return {
    kind: 'own',
    person: record.submittedById
      ? { id: record.submittedById, name: record.submittedByName }
      : null,
    harness: record.harness,
    model: record.model,
  };
}

/**
 * Every agent PASS on the card, newest first: an answering `pass` record, and a decided
 * `agent_review` gate approved by the review agent that no record covers (a gate decided
 * before records existed — always the hosted run's, since the user-token door writes one).
 */
export function agentPasses(facts: Pick<ReviewStateFacts, 'records' | 'agentGates'>): ReviewPass[] {
  const passes: ReviewPass[] = [];
  const recordedGates = new Set<string>();
  for (const record of facts.records) {
    if (record.gateId) recordedGates.add(record.gateId);
    if (record.verdict !== 'pass' || !ANSWERING.has(record.outcome)) continue;
    passes.push({
      reviewer: reviewerOfRecord(record),
      at: record.createdAt,
      subjectVersion: record.subjectVersion,
      ref: { kind: 'record', id: record.id },
    });
  }
  for (const gate of facts.agentGates) {
    if (
      gate.state !== 'approved' ||
      gate.decidedUnderAuthority !== 'review_agent' ||
      gate.subjectVersion === null ||
      recordedGates.has(gate.id)
    ) {
      continue;
    }
    passes.push({
      reviewer: { kind: 'hosted', model: null },
      at: gate.decidedAt ?? gate.createdAt,
      subjectVersion: gate.subjectVersion,
      ref: { kind: 'gate', id: gate.id },
    });
  }
  return passes.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function markerOf(
  facts: ReviewStateFacts,
  awaiting: ReviewStateGate | null,
  viewerIsRouted: boolean,
): ReviewMarker | null {
  if (!facts.reviewAgentEnabled || !awaiting) return null;
  if (facts.reviewAgentSource === 'own') {
    return {
      kind: 'waiting_for_own_agent',
      routedTo: facts.routedTo,
      forViewer: viewerIsRouted,
      command: reviewCommand(facts.identifier),
    };
  }
  // §12.6 is a hosted-only state: the reason on the row, aimed at the routed person.
  if (awaiting.reviewUnavailableReason) {
    return {
      kind: 'could_not_run',
      reason: awaiting.reviewUnavailableReason,
      routedTo: facts.routedTo,
      forViewer: viewerIsRouted,
    };
  }
  return facts.reviewRunInFlight ? { kind: 'agent_reviewing' } : null;
}

function githubApprovalsOf(members: readonly ReviewStateMember[]): ReviewLine['githubApprovals'] {
  return members.flatMap((member) =>
    countableReviewsAtHead(member.reviews, member.headSha)
      .filter((review) => review.state === 'approved')
      .map((review) => ({ login: review.reviewerLogin, repo: member.repo, number: member.number })),
  );
}

/** What answered one version's review, by the review line's precedence (§ 32.4). */
export type ReviewAnswer =
  | { kind: 'reviewed'; pass: ReviewPass }
  | { kind: 'dismissed'; dismissal: ReviewStateDismissal }
  | { kind: 'skipped'; gate: ReviewStateGate }
  | { kind: 'none' };

/**
 * THE PRECEDENCE AT ONE VERSION — the agent PASSED; else a person DISMISSED the agent's
 * send-back; else a person CONTINUED WITHOUT the review (the `agent_review` gate approved
 * under a person's authority); else nothing. One version has one answering review
 * (§12.13), so the order only settles what cannot happen together. The review line reads it
 * at the CURRENT version; the approval record (MOTIR-10338) reads it at the APPROVED one.
 */
export function reviewAnswerAt(
  version: string,
  facts: Pick<ReviewStateFacts, 'records' | 'agentGates' | 'dismissals'>,
  passes: readonly ReviewPass[] = agentPasses(facts),
): ReviewAnswer {
  const pass = passes.find((p) => p.subjectVersion === version);
  if (pass) return { kind: 'reviewed', pass };
  const dismissal = facts.dismissals.find((d) => d.subjectVersion === version);
  if (dismissal) return { kind: 'dismissed', dismissal };
  const gate = facts.agentGates.find(
    (g) =>
      g.subjectVersion === version &&
      g.state === 'approved' &&
      g.decidedUnderAuthority !== null &&
      g.decidedUnderAuthority !== 'review_agent',
  );
  if (gate) return { kind: 'skipped', gate };
  return { kind: 'none' };
}

/** The name a skipping gate's decider is shown by: their live name, else the stored label
 *  without its `<email>`. */
export function skippedByName(gate: ReviewStateGate): string | null {
  return gate.decidedByName ?? (gate.decidedByLabel?.replace(/\s*<[^<>]*>\s*$/, '').trim() || null);
}

/**
 * THE DERIVATION — one card's review state from its facts.
 *
 * The review line's four values, in this order at the current version: the agent PASSED
 * (reviewed by agent); a person DISMISSED the agent's send-back (review dismissed, with the
 * reason); a person CONTINUED WITHOUT the review — the `agent_review` gate approved under a
 * person's authority (review skipped, with the reason); otherwise not reviewed by an agent.
 * One version has one answering review (§12.13), so the order only settles what cannot
 * happen together.
 */
export function deriveReviewState(facts: ReviewStateFacts): ReviewState {
  const version = facts.currentVersion;
  const viewerIsRouted = facts.routedTo !== null && facts.routedTo.id === facts.viewerUserId;
  const atVersion = <T extends { subjectVersion: string | null }>(rows: readonly T[]) =>
    version === null ? [] : rows.filter((row) => row.subjectVersion === version);

  const awaiting = atVersion(facts.agentGates).find((gate) => gate.state === 'awaiting') ?? null;
  const passes = agentPasses(facts);
  const answer: ReviewAnswer =
    version === null ? { kind: 'none' } : reviewAnswerAt(version, facts, passes);
  const pass = answer.kind === 'reviewed' ? answer.pass : null;
  // The To fix rule asks whether ANY dismissal stands at the version, whatever answered it.
  const dismissal = atVersion(facts.dismissals)[0] ?? null;

  // The To fix rule's own predicate (`reviewRefusal.ts`), so the two cannot disagree.
  const sendBackRecord =
    atVersion(facts.records).find(
      (record) => record.outcome === 'recorded' && record.verdict === 'changes_requested',
    ) ?? null;
  const standing = standingReviewRefusalFrom({
    latest: facts.latestDecidedGate,
    record: sendBackRecord,
    dismissed: dismissal !== null,
    currentVersion: version,
  });

  const commits: ReviewCommit[] = membersOf(version).map((m) => ({
    repo: m.repo,
    number: m.number,
    headSha: m.headSha,
  }));

  let reviewLine: ReviewLine | null = null;
  if (version !== null) {
    const base = {
      actor: null,
      reason: null,
      reviewer: null,
      at: null,
      githubApprovals: githubApprovalsOf(facts.members),
      lastReviewedVersion: null,
      lastReviewedRef: null,
      command: null,
    };
    if (pass) {
      reviewLine = { ...base, value: 'reviewed_by_agent', reviewer: pass.reviewer, at: pass.at };
    } else if (answer.kind === 'dismissed') {
      const d = answer.dismissal;
      reviewLine = {
        ...base,
        value: 'review_dismissed',
        actor: d.dismissedById ? { id: d.dismissedById, name: d.dismissedByName } : null,
        reason: d.reasonMd,
      };
    } else if (answer.kind === 'skipped') {
      const skipped = answer.gate;
      reviewLine = {
        ...base,
        value: 'review_skipped',
        actor: skipped.decidedById
          ? { id: skipped.decidedById, name: skippedByName(skipped) }
          : null,
        reason: skipped.noteMd,
      };
    } else {
      const earlierPass = passes.find((p) => p.subjectVersion !== version);
      reviewLine = {
        ...base,
        value: 'not_reviewed',
        lastReviewedVersion: earlierPass?.subjectVersion ?? null,
        lastReviewedRef: earlierPass?.ref ?? null,
        command: reviewCommand(facts.identifier),
      };
    }
  }

  const routedGithubUserId = facts.routedGithubUserId;
  const authorOfEveryPr =
    routedGithubUserId !== null &&
    facts.members.length > 0 &&
    facts.members.every((member) => member.authorGithubUserId === routedGithubUserId);

  return {
    currentVersion: version,
    marker: markerOf(facts, awaiting, viewerIsRouted),
    reviewed: pass && !facts.finished ? { reviewer: pass.reviewer, at: pass.at, commits } : null,
    reviewLine,
    recordRef: pass?.ref ?? null,
    sentBack: standing !== null && standing.kind === 'agent_review',
    sentBackRecord:
      standing !== null && standing.kind === 'agent_review' && standing.recordId !== null
        ? { recordId: standing.recordId, findingsMd: standing.noteMd, at: standing.decidedAt }
        : null,
    reviewToRun:
      facts.reviewAgentEnabled && facts.reviewAgentSource === 'own' && awaiting
        ? { gateId: awaiting.id, command: reviewCommand(facts.identifier) }
        : null,
    authorOfEveryPr,
    routedTo: facts.routedTo,
    viewerIsRouted,
  };
}
