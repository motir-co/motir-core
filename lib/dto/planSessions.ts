import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { PlanStatusDto, PlanWalkPhaseDto } from '@/lib/dto/plans';

// The Plans page's SESSION LIST (MOTIR-6025, `agent-authored-plans.md`
// AMENDMENT 17 §8; built to `design/ai-planning/design-notes.md` Part XIX).
// `/plans` lists planning CONVERSATIONS, newest activity first, and each row
// states its latest plan's state — or that it has proposed nothing yet.

/**
 * A session's PLAN STATE (§8, as amended by AMENDMENT 23 §1). The END is read
 * FIRST: a session Motir ended (`failed` · `idle` · `restarted`) is `closed`, one
 * a person ended reads `declined` / `approved`. An OPEN session reads its LATEST
 * plan's `PlanStatus`, or `none` when it has proposed nothing — except that an open session
 * waiting on a FAILED attempt reads `waiting` (Waiting to resume; Story MOTIR-7905 · MOTIR-7921)
 * while its plan is still being written, and one whose plan waits for a decision reads that
 * plan's status (MOTIR-7944). `none`, `waiting` and
 * `closed` are members of the vocabulary in their own right, never fallbacks:
 * the filter, the counts and the chip are all TOTAL over them. The type is
 * derived from the array, so the two cannot drift.
 */
export const PLAN_SESSION_STATE_VALUES = [
  'none',
  'generating',
  'waiting',
  'planned',
  'approving',
  'stale',
  'approved',
  'declined',
  'closed',
] as const satisfies readonly ('none' | 'closed' | 'waiting' | PlanStatusDto)[];

export type PlanSessionStateDto = (typeof PLAN_SESSION_STATE_VALUES)[number];

/** A state the list FILTERS by — every row state but `none` (MOTIR-9301) and `approving` (MOTIR-9006). */
export type PlanSessionFilterDto = Exclude<PlanSessionStateDto, 'none' | 'approving'>;

/**
 * The Plans list's FILTER vocabulary (MOTIR-9301): the row vocabulary without `none`.
 * The list and its counts admit only a session holding at least one plan (MOTIR-9300),
 * so no listed row can be `none`, and the strip offers no segment for it. `none` stays
 * a true ROW state — the overlay's by-id door still returns a plan-less conversation,
 * and its row chip still labels it — so it is the filter set that narrows, never the
 * row set. One vocabulary, split by which door asks; DERIVED, so order and membership
 * follow the row array with no second literal.
 *
 * ⚠️ `approving` IS NOT A SEGMENT EITHER (Bug MOTIR-9006). It is a true row state — a
 * session whose plan is being materialized reads *Approving…*, not *Waiting for
 * approval* — but it lasts for the seconds an approve takes, so a filter for it would
 * nearly always be empty and would empty itself under the reader. Its count is still
 * kept (the counts are total over the ROW vocabulary).
 */
export const PLAN_SESSION_FILTER_VALUES: readonly PlanSessionFilterDto[] =
  PLAN_SESSION_STATE_VALUES.filter(
    (s): s is PlanSessionFilterDto => s !== 'none' && s !== 'approving',
  );

/**
 * WHY a session ended (AMENDMENT 23 §1) — `PlanSessionEndReason`, mirrored so
 * the DTO layer names no generated type. Derived from the array, so a switch
 * over it is total.
 */
export const PLAN_SESSION_END_REASON_VALUES = [
  'failed',
  'idle',
  'restarted',
  'declined',
  'approved',
] as const;

export type PlanSessionEndReasonDto = (typeof PLAN_SESSION_END_REASON_VALUES)[number];

/** How many sessions hold each plan state — total over the vocabulary. */
export type PlanSessionStateCountsDto = Record<PlanSessionStateDto, number>;

/**
 * The gate kinds a session can be SEEDED by (story MOTIR-6068 · MOTIR-6209) —
 * the refusals `isRefusalSeedGate` accepts: the three decision kinds, since
 * MOTIR-6424 a `design_result` sent back with the Re-plan verdict, and since MOTIR-6504
 * an `acceptance_result` sent back to be re-planned or remedied. The row's verb lookup
 * is TOTAL over this list.
 */
export const PLAN_SESSION_SEED_GATE_KINDS = [
  'decision_approval',
  'decision_confirmation',
  'decision_choice',
  'design_result',
  'acceptance_result',
] as const;

export type PlanSessionSeedGateKindDto = (typeof PLAN_SESSION_SEED_GATE_KINDS)[number];

/** Whether a seeded session re-plans after a REFUSAL, plans the follow-up to a
 *  PICK, or was started by Confirm on a GUIDE's re-plan offer (MOTIR-8697). */
export type PlanSessionSeedOriginDto = 'refusal' | 'pick' | 'guide';

/** Where a SEEDED session came from: the seeding gate's work item and kind, or —
 *  for a guide seed — the work item the guide conversation was walking. */
export interface PlanSessionSeedDto {
  /** The seeding work item's identifier (`ACME-44`) — the row links to it. For a
   *  pick it is the CHOICE card, and for a guide seed the GUIDED card, never the
   *  session's anchor. */
  cardKey: string;
  /** The seeding gate's kind. NULL on a guide seed (MOTIR-8697): a guide offer is
   *  not an approval gate — it refuses nothing and picks nothing — so there is no
   *  gate kind, and no gate verb, to show. Non-null on every refusal and pick. */
  gateKind: PlanSessionSeedGateKindDto | null;
  /** A pick is never a refusal (MOTIR-6434), and a guide seed is neither: the row
   *  words all three differently. */
  origin: PlanSessionSeedOriginDto;
  /** The chosen option's label on a pick; null on a refusal. */
  chosenLabel: string | null;
}

/** One row of the list: one session, and the one plan it is known by. */
export interface PlanSessionRowDto {
  id: string;
  origin: PlanSessionOriginDto;
  /** The anchor set, as identifiers; empty = the whole project. */
  targetKeys: string[];
  lastActivityAt: string;
  /** Who started it. Null on a cadence session and on a departed member's. */
  startedBy: { id: string; name: string } | null;
  /** The session's first `user` turn — what was asked. Null when it has none
   *  (every door but a conversation opens a session without a turn). */
  firstTurn: string | null;
  /** The LATEST plan, or null when the session has proposed nothing. */
  latestPlan: { id: string; status: PlanStatusDto; title: string | null } | null;
  /** How many plans the session holds — `latestPlan` included. */
  planCount: number;
  /** The session's state, END first (AMENDMENT 23 §1) — the value the filter
   *  and the counts read, so the chip can never disagree with its tab. */
  state: PlanSessionStateDto;
  /** The failed attempt's record while the session is OPEN and waiting on it (Story MOTIR-7905 ·
   *  MOTIR-7921) — the row's stop line — else null. The reason is the stable code. */
  failure?: {
    failedAt: string;
    reason: string;
    stopPhase: PlanWalkPhaseDto | null;
    stopTitle: string | null;
    /** The cards the halted walk left unplanned, one line each, worded by motir-ai for the
     *  person (`walkStop.notPlannedYet`, MOTIR-10209) — rendered verbatim and in order. Absent
     *  or empty: none, and the failure renders as it always did. */
    notPlannedYet?: string[];
  } | null;
  /** When it ended, or null while it is OPEN. */
  endedAt: string | null;
  /** Why it ended, or null while it is OPEN. */
  endReason: PlanSessionEndReasonDto | null;
  /** Who ended it; null while open, when Motir ended it, or for a departed member. */
  endedBy: { id: string; name: string } | null;
  /** The session this one CONTINUES (AMENDMENT 23 §6) — its id and end time —
   *  or null when it is no copy, or its source is gone. */
  copiedFrom: { id: string; endedAt: string | null } | null;
  /** Where the session was SEEDED from, resolved to a work item — EITHER the
   *  refused or picked gate (MOTIR-6207's `seedGateId`; origin `refusal` / `pick`)
   *  OR the guide reply turn whose re-plan offer was confirmed (MOTIR-8691's
   *  `seedGuideTurnId`; origin `guide`, naming the guided card). Null on an
   *  unseeded session, when the seeding row is gone (`SetNull`), and when the
   *  viewer cannot browse the seed's work item — an unresolvable seed reads
   *  exactly like no seed (MOTIR-6209, MOTIR-8697). */
  seed: PlanSessionSeedDto | null;
}

/**
 * WHICH sessions a Plans-room read covers (Story MOTIR-6179 · MOTIR-6330).
 *
 *   * `project` — every session of the project; served only to a reader who
 *     holds `plan:view_any`.
 *   * `mine` — the sessions the reader started, and those holding a plan they
 *     asked for, decided, or have routed to them; served to anyone who browses.
 *
 * A caller only ASKS for one. The service resolves what it SERVES and says so on
 * the DTO, the `approvalGatesService.listRecords` shape: a `project` request from
 * a reader without the key is served `mine`, never refused.
 */
export type PlanSessionView = 'mine' | 'project';

export interface PlanSessionListPageDto {
  sessions: PlanSessionRowDto[];
  /** Opaque; null at the end of the list. */
  nextCursor: string | null;
  /** The scope the service actually SERVED — see {@link PlanSessionView}. */
  scope: PlanSessionView;
}
