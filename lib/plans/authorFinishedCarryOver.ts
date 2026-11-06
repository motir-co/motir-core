// ── The authorFinished CARRY-OVER's judgement (MOTIR-10491) ───────────────────
//
// MOTIR-10490 stores `authorFinished` on a proposal: `true` says an author
// session finished writing the card, and absent or `null` reads not written.
// Every card written BEFORE that shipped carries no key, so once the readers
// switch to the stored state each finished card on a plan already open would
// read as unwritten, and the next resume would author it again from scratch.
// The carry-over (`planAuthorFinishedBackfillService`) records the state on
// those cards once. This module is the ONE predicate its dry run and its real
// run share, so the two can never disagree about which card is stamped.
//
// THE ORDER IS THE CONTRACT. One verdict per proposal, the first that holds:
//
//   1. `skipped`            — not an `add`. A `modify` or `remove` never holds
//                              the state.
//   2. `already_has_state`  — the proposed fields already hold the key, `null`
//                              included: somebody said something about this
//                              card, and the carry-over never overrules it.
//   3. `in_flight`          — a LIVE author step targets the card. Its session
//                              is writing it now and its driver states the
//                              result when it finishes; stamping it could mark a
//                              card written just before that session fails.
//   4. `not_complete`       — `proposalComplete` fails, with the plan's own
//                              explanation rule (`requireExplanationFor`).
//   5. `boundary_only`      — the body holds nothing beyond its `Scope
//                              BOUNDARY` (`hasBodyBeyondBoundary`). Needed
//                              beside 4: with explanations off, a container
//                              whose body is only its boundary passes
//                              `proposalComplete`.
//   6. `stamp`              — a finished card with no recorded state.
//
// The three tests in 3–5 disagree on purpose: completeness is the planners'
// "would I open a session on this?" question, the boundary test is the
// hand-stamp's "did anybody write this?" question, and the live step is "is
// somebody writing it right now?". A card is stamped only when all three agree
// that it is finished.
//
// PURE: no DB, no `tx`. The service reads the rows and hands them in.

import type { PlanItemDto } from '@/lib/dto/plans';
import { proposalComplete } from '@/lib/plans/authoringState';
import { hasBodyBeyondBoundary } from '@/lib/plans/authorFinished';
import { DEFAULT_PROPOSED_KIND } from '@/lib/plans/validateProposals';

export const CARRY_OVER_VERDICTS = [
  'skipped',
  'already_has_state',
  'in_flight',
  'not_complete',
  'boundary_only',
  'stamp',
] as const;

export type CarryOverVerdict = (typeof CARRY_OVER_VERDICTS)[number];

export interface CarryOverInput {
  /** The proposal being judged. */
  item: PlanItemDto;
  /** Every proposal of its plan — `proposalComplete` reads them for childlessness. */
  items: readonly PlanItemDto[];
  /** The `planItem:<id>` refs a section finding names. */
  findingRefs: ReadonlySet<string>;
  /** Whether this plan's cards owe an explanation (`requireExplanationFor`). */
  requireExplanation: boolean;
  /** The refs a LIVE author step targets — empty unless the plan is `generating`. */
  liveAuthorTargets: ReadonlySet<string>;
}

/** The verdict for one proposal — see the header for the order. */
export function carryOverVerdict(input: CarryOverInput): CarryOverVerdict {
  const { item } = input;
  if (item.op !== 'add') return 'skipped';
  const fields = (item.proposedFields ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(fields, 'authorFinished')) return 'already_has_state';
  if (input.liveAuthorTargets.has(`planItem:${item.id}`)) return 'in_flight';
  if (
    !proposalComplete(item, input.items, input.findingRefs, {
      requireExplanation: input.requireExplanation,
    })
  ) {
    return 'not_complete';
  }
  const kind = typeof fields.kind === 'string' ? fields.kind : DEFAULT_PROPOSED_KIND;
  const type = typeof fields.type === 'string' ? fields.type : null;
  const body = typeof fields.descriptionMd === 'string' ? fields.descriptionMd : null;
  if (!hasBodyBeyondBoundary(body, kind, type)) return 'boundary_only';
  return 'stamp';
}
