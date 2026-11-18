// ── IS A PLAN'S WALK COMPLETE? (Bug MOTIR-11701) ────────────────────────────────
//
// THE RULE: a plan can be approved only when its walk is complete — every `add`
// proposal and every committed card the walk re-authors reads `authored`. Until then
// the plan is `stopped`: it shows Resume, never Approve, however the walk ended early
// (the person's Stop, a failed author session, a limit, a crash).
//
// THE STATES ARE `authoringState.ts`'s, never a second derivation. A proposal is
// written when it carries the stored `authorFinished` (MOTIR-10496); a committed card
// the walk re-authors is written once an author session ended on it or a `modify`
// carries its new body (MOTIR-10001). This module only answers the conjunction, and
// names what is still owed so a Resume can say which cards it will write.
//
// ⚠️ ONLY A PLAN THAT HAD A WALK IS JUDGED. A walk is what a planner's driver reports:
// a step (`report_plan_step`, the hosted walk's reporter), the narration session every
// step opens, or the committed cards a lay listed (`plannerRecord.walkListed`). A plan
// written by hand over the MCP — `create_plan`, one `add_plan_items` holding whole
// bodies, `final: true` — has none of the three, and its `add`s are never stamped
// (an append may not claim the author state, MOTIR-10490), so judging it would read
// every such plan as incomplete and close none of them. Nothing walked it, so there is
// no walk to be incomplete: it is complete by construction.
//
// PURE: no DB, no `tx`. `planWalkCompletenessService` gathers the rows.

import type { PlanItemDto } from '@/lib/dto/plans';
import {
  deriveAuthoringStates,
  deriveCommittedStates,
  type AuthorSessionFact,
  type CommittedCard,
} from '@/lib/plans/authoringState';

/** One card the walk still owes — a proposal (`planItem:<id>`) or a committed card (its id). */
export interface UnwrittenCard {
  ref: string;
  /** The committed card's key; `null` for a proposal, which has none until approve. */
  key: string | null;
  title: string | null;
}

/** The verdict. `complete` is true for a plan that had no walk at all. */
export interface WalkCompleteness {
  /** Whether a planner's driver walked this plan — the precondition for judging it. */
  walked: boolean;
  complete: boolean;
  /** What is still owed, proposals first then committed cards, in the plan's order. */
  unwritten: UnwrittenCard[];
}

/** The facts the verdict reads, as the service gathers them. */
export interface WalkFacts {
  items: readonly PlanItemDto[];
  /** LIVE step rows (`plan_step`): a card under a live author step is being written. */
  liveSteps: readonly AuthorSessionFact[];
  /** Every narration session the plan ever opened, ended ones included. */
  sessions: readonly AuthorSessionFact[];
  /** `plannerRecord.walkListed` — the committed cards a lay listed before their sessions. */
  listed: readonly string[];
  /** The committed cards the walk re-authors, resolved to their keys and titles. */
  committed: readonly CommittedCard[];
}

/** Whether a driver walked this plan (see the header). */
export function planWasWalked(
  facts: Pick<WalkFacts, 'liveSteps' | 'sessions' | 'listed'>,
): boolean {
  return facts.liveSteps.length > 0 || facts.sessions.length > 0 || facts.listed.length > 0;
}

/**
 * THE VERDICT. A PROPOSAL is judged by its stored `authorFinished` ALONE: a close can
 * race its own last author step's `end`, and a card whose author already stamped it is
 * written whether or not that step row has gone — while one nobody stamped is owed
 * whatever the steps say. A COMMITTED card has no stamp: under a live author step it
 * reads `authoring` and is owed, the safe answer — the plan closes `stopped` and a
 * Resume writes it.
 */
export function judgeWalkCompleteness(facts: WalkFacts): WalkCompleteness {
  if (!planWasWalked(facts)) return { walked: false, complete: true, unwritten: [] };
  const unwritten: UnwrittenCard[] = [];
  for (const row of deriveAuthoringStates(facts.items, [])) {
    if (row.state !== 'authored') unwritten.push({ ref: row.ref, key: null, title: row.title });
  }
  const committedRows = deriveCommittedStates(
    facts.items,
    facts.liveSteps,
    facts.sessions,
    facts.listed,
    facts.committed,
  );
  for (const row of committedRows) {
    if (row.inWalk && row.state !== 'authored') {
      unwritten.push({ ref: row.ref, key: row.key, title: row.title });
    }
  }
  return { walked: true, complete: unwritten.length === 0, unwritten };
}

/** The plan record's `walkListed` ids; anything else in the record is not this read's. */
export function walkListedOf(record: unknown): string[] {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return [];
  const listed = (record as Record<string, unknown>).walkListed;
  return Array.isArray(listed)
    ? listed.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
}
