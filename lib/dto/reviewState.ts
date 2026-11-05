import type {
  ReviewLine,
  ReviewMarker,
  ReviewRecordRef,
  ReviewReviewer,
  ReviewState,
  ReviewStatePerson,
} from '@/lib/agentReview/reviewState';

// THE REVIEW STATE on the wire (Story MOTIR-10327 · MOTIR-10340;
// `design/github/design-notes.md` § 32) — what the board card, the List / Tree cell, the
// item header, To approve and the approve-and-merge gate frame read about one card's agent
// review at its CURRENT delivery-set version. Derived by `reviewStateService`, never stored.
// Dates are ISO strings, as every DTO here.

/** A person the review state names. `name` is null when their row no longer resolves. */
export interface ReviewStatePersonDTO {
  id: string;
  name: string | null;
}

/** Who passed the review: Motir's hosted agent, or a person's own agent. */
export type ReviewReviewerDTO =
  | { kind: 'hosted'; model: string | null }
  | { kind: 'own'; person: ReviewStatePersonDTO | null; harness: string; model: string };

/** The review that answered a version — what *Findings and checklist* opens. */
export type ReviewRecordRefDTO = { kind: 'record'; id: string } | { kind: 'gate'; id: string };

/**
 * The marker (§ 32.1) — one at a time. `forViewer` says it is aimed at the reader, the
 * routed person, which is what makes *Review could not run* and *Waiting for your review
 * agent* loud.
 */
export type ReviewMarkerDTO =
  | { kind: 'agent_reviewing' }
  | {
      kind: 'could_not_run';
      /** The could-not-run code written on the gate (`approval-gates.md` §12.6). */
      reason: string;
      routedTo: ReviewStatePersonDTO | null;
      forViewer: boolean;
    }
  | {
      kind: 'waiting_for_own_agent';
      routedTo: ReviewStatePersonDTO | null;
      forViewer: boolean;
      /** `motir review <KEY>` — the copyable command. */
      command: string;
    };

/** The review line's value at the current version (§ 32.4). */
export type ReviewLineValueDTO =
  | 'reviewed_by_agent'
  | 'review_skipped'
  | 'review_dismissed'
  | 'not_reviewed';

export interface ReviewLineDTO {
  value: ReviewLineValueDTO;
  /** Who skipped or dismissed the review; null for the other values. */
  actor: ReviewStatePersonDTO | null;
  /** The reason they gave; null for the other values. */
  reason: string | null;
  /** For `reviewed_by_agent`: the reviewer and when. */
  reviewer: ReviewReviewerDTO | null;
  at: string | null;
  /** Each countable GitHub approval recorded at its pull request's current head. */
  githubApprovals: { login: string; repo: string; number: number }[];
  /** For `not_reviewed`: the version an EARLIER pass was at, or null. */
  lastReviewedVersion: string | null;
  /** For `not_reviewed`: `motir review <KEY>`. */
  command: string | null;
}

/** A container's count over the open run targets in its tree (§ 32.3, container form). */
export interface ReviewContainerDTO {
  passed: number;
  total: number;
  /** Every open run target passed — the container reads Reviewed. */
  allPassed: boolean;
}

export interface ReviewStateDTO {
  workItemId: string;
  identifier: string;
  /** The version every answer is about; null for an empty set or an unknown head. */
  currentVersion: string | null;
  marker: ReviewMarkerDTO | null;
  /** The Reviewed state — only at the current version, never on a Done card. */
  reviewed: {
    reviewer: ReviewReviewerDTO;
    at: string;
    commits: { repo: string; number: number; headSha: string }[];
  } | null;
  /** The review line for an approve-and-merge row or gate frame; null with no version. */
  reviewLine: ReviewLineDTO | null;
  /** The answering pass at the current version, for its findings and checklist. */
  recordRef: ReviewRecordRefDTO | null;
  /** An agent send-back stands at the current version (the card is To fix). */
  sentBack: boolean;
  /** For a card with children: the count over its open run targets; null for a leaf. */
  container: ReviewContainerDTO | null;
  /** A review waiting to be run by the routed person's own agent, or null. */
  reviewToRun: { gateId: string; command: string } | null;
  /** The routed person opened EVERY pull request of the set on GitHub. */
  authorOfEveryPr: boolean;
  routedTo: ReviewStatePersonDTO | null;
  /** The reader is the routed person. */
  viewerIsRouted: boolean;
}

function personDto(person: ReviewStatePerson | null): ReviewStatePersonDTO | null {
  return person ? { id: person.id, name: person.name } : null;
}

function reviewerDto(reviewer: ReviewReviewer): ReviewReviewerDTO {
  return reviewer.kind === 'hosted'
    ? { kind: 'hosted', model: reviewer.model }
    : {
        kind: 'own',
        person: personDto(reviewer.person),
        harness: reviewer.harness,
        model: reviewer.model,
      };
}

function markerDto(marker: ReviewMarker | null): ReviewMarkerDTO | null {
  if (!marker) return null;
  switch (marker.kind) {
    case 'agent_reviewing':
      return { kind: 'agent_reviewing' };
    case 'could_not_run':
      return {
        kind: 'could_not_run',
        reason: marker.reason,
        routedTo: personDto(marker.routedTo),
        forViewer: marker.forViewer,
      };
    case 'waiting_for_own_agent':
      return {
        kind: 'waiting_for_own_agent',
        routedTo: personDto(marker.routedTo),
        forViewer: marker.forViewer,
        command: marker.command,
      };
  }
}

function lineDto(line: ReviewLine | null): ReviewLineDTO | null {
  if (!line) return null;
  return {
    value: line.value,
    actor: personDto(line.actor),
    reason: line.reason,
    reviewer: line.reviewer ? reviewerDto(line.reviewer) : null,
    at: line.at?.toISOString() ?? null,
    githubApprovals: line.githubApprovals.map((a) => ({ ...a })),
    lastReviewedVersion: line.lastReviewedVersion,
    command: line.command,
  };
}

function refDto(ref: ReviewRecordRef | null): ReviewRecordRefDTO | null {
  return ref ? { kind: ref.kind, id: ref.id } : null;
}

/** The derived state → its DTO. */
export function toReviewStateDto(
  card: { id: string; identifier: string },
  state: ReviewState,
  container: ReviewContainerDTO | null,
): ReviewStateDTO {
  return {
    workItemId: card.id,
    identifier: card.identifier,
    currentVersion: state.currentVersion,
    marker: markerDto(state.marker),
    reviewed: state.reviewed
      ? {
          reviewer: reviewerDto(state.reviewed.reviewer),
          at: state.reviewed.at.toISOString(),
          commits: state.reviewed.commits.map((c) => ({ ...c })),
        }
      : null,
    reviewLine: lineDto(state.reviewLine),
    recordRef: refDto(state.recordRef),
    sentBack: state.sentBack,
    container,
    reviewToRun: state.reviewToRun ? { ...state.reviewToRun } : null,
    authorOfEveryPr: state.authorOfEveryPr,
    routedTo: personDto(state.routedTo),
    viewerIsRouted: state.viewerIsRouted,
  };
}

/**
 * A REVIEW TO RUN on the routed person's To approve (§ 32.5) — an awaiting `agent_review`
 * gate of a project reviewing with its own agent. ITS OWN ROW KIND: it asks the person to
 * run a review, not to decide anything, and it is never an approval row.
 */
export interface ReviewToRunRowDTO {
  kind: 'review_to_run';
  gateId: string;
  workItemId: string;
  identifier: string;
  title: string;
  /** The delivery-set version the review is asked about. */
  subjectVersion: string | null;
  /** When the review was raised. */
  raisedAt: string;
  /** `motir review <KEY>` — the row's one verb is Copy. */
  command: string;
}

/**
 * WHAT ANSWERED THE AGENT REVIEW AT AN APPROVED VERSION (MOTIR-10338; design notes § 32,
 * mock A3) — the approval record's second clause. `reviewed` names the commits the agent
 * passed; `skipped` / `dismissed` name the person and carry their reason (drawn as the
 * clause's tooltip); `none` is a merge approved with no agent review at that version.
 */
export type ApprovedReviewDTO =
  | { kind: 'reviewed'; commits: string }
  | { kind: 'skipped'; by: string | null; reason: string | null }
  | { kind: 'dismissed'; by: string | null; reason: string | null }
  | { kind: 'none' };

/**
 * WHAT A CARD SURFACE DRAWS OF THE REVIEW (MOTIR-10341; design notes § 32.1, § 32.3) — the
 * board card, the List / Tree status cell and the item header read only the marker, the
 * Reviewed state, the container count and the record its badge links to. Null when there is
 * nothing to draw, so a page carries an entry only for the cards that wear one.
 */
export interface CardReviewDTO {
  identifier: string;
  marker: ReviewMarkerDTO | null;
  reviewed: ReviewStateDTO['reviewed'];
  /** A container's count over its open run targets; never one with no target. */
  container: ReviewContainerDTO | null;
  recordRef: ReviewRecordRefDTO | null;
}

/** A page's card reviews, keyed by work-item id — serializable, beside the rows. */
export type CardReviewMap = Record<string, CardReviewDTO>;

/** The surfaces' slice of a review state; null when it draws nothing. */
export function toCardReviewDto(state: ReviewStateDTO): CardReviewDTO | null {
  const container = state.container && state.container.total > 0 ? state.container : null;
  if (!state.marker && !state.reviewed && !container) return null;
  return {
    identifier: state.identifier,
    marker: state.marker,
    reviewed: state.reviewed,
    container,
    recordRef: state.recordRef,
  };
}
