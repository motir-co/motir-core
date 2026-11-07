// ── Which proposals are AUTHORED, being authored, or not started (MOTIR-9821) ──
//
// An author session may hand not-done work in its `## Scope BOUNDARY` only to a
// card that reads that boundary — one `blocked_by` it. The one edge a session may
// wire onto a SIBLING to make a hand-off legal is "that sibling `blocked_by` me",
// and only while the sibling's own author session has NOT STARTED: a sibling being
// written now, or already written, never reads the line. The level view a session
// opens on is a snapshot that puts "running" and "not started" in one bucket, so
// the session asks this read, live, before it wires the edge.
//
// THE THREE STATES OF AN `add` (Story MOTIR-10413 · MOTIR-10496):
//
//   - authoring    — a LIVE `PlanStep` row of kind `author` targets the card
//                    (`end` deletes the row);
//   - authored     — the card is WRITTEN: its proposal carries the stored
//                    `authorFinished` (`isProposalWritten`, `lib/plans/proposalWritten.ts`),
//                    which a driver sends once an author session finished the
//                    card and core stamps on a card written by hand;
//   - not_started  — every other `add`.
//
// ⚠️ NEITHER AN ENDED SESSION NOR A COMPLETE BODY MAKES A CARD AUTHORED ANY MORE.
// Both used to (MOTIR-9821): an ended `PlanNarrationSession` row read authored, and
// so did a card that passed `proposalComplete`. The first is false because the
// ended-session record also covers an author that FAILED, after writing a whole
// body or none; the second is false since the lay saves every card with its Scope
// BOUNDARY as its only section, so a body stopped saying whether its author
// finished. A failed session's card therefore reads `not_started`, which is true:
// a resume writes it again, it may still be given an edge, and its next author
// session will read that edge.
//
// `proposalComplete` stays, for the one-time carry-over that stamped the cards of
// the plans already open when the state shipped (MOTIR-10491). It answers no
// written-state question.
//
// COMMITTED CARDS (MOTIR-10001) are answered apart from the proposals, because the
// question differs, and keep their meaning: a committed card has no stored state.
// A committed card the walk RE-AUTHORS — one the lay listed (a `modify` that
// changes its title, or a card the driver recorded on the plan's
// `plannerRecord.walkListed`), one a `modify` rewrote the body of, or one an author
// step has targeted — races exactly as a proposal does and reads the same three
// states. Every OTHER committed card is `not_in_walk`: no session of this plan will
// ever rewrite its body, so an edge drawn onto it is legal only where that body
// already rests on the blocker — a rule the corpus states, not this read.
//
// PURE: no DB, no `tx`. The service hands in the plan's items, its step rows, its
// narration-session rows (for the committed cards) and the committed cards' identities.

import type { PlanItemDto } from '@/lib/dto/plans';
import { isProposalWritten } from '@/lib/plans/proposalWritten';

export type PlanAuthoringState = 'not_started' | 'authoring' | 'authored';

/** A committed card's state: the three above when the walk re-authors it, else `not_in_walk`. */
export type CommittedAuthoringState = PlanAuthoringState | 'not_in_walk';

/** One proposal's state, as the read answers it. */
export interface PlanAuthoringStateRow {
  /** `planItem:<id>` — the `add` proposal's ref. */
  ref: string;
  op: 'add';
  title: string | null;
  state: PlanAuthoringState;
}

/** One committed card's state, as the read answers it (MOTIR-10001). */
export interface CommittedAuthoringStateRow {
  /** The work item's id. */
  ref: string;
  key: string | null;
  title: string | null;
  /** True when this plan's walk re-authors the card (it was listed, rewritten or opened). */
  inWalk: boolean;
  state: CommittedAuthoringState;
}

/** A committed card's identity, resolved by the service. */
export interface CommittedCard {
  id: string;
  key: string | null;
  title: string | null;
}

/** The step and session facts the derivation reads — the two rows' shared fields. */
export interface AuthorSessionFact {
  kind: string;
  targetRef: string | null;
}

const CONTAINER_KINDS: ReadonlySet<string> = new Set(['epic', 'story']);
const LEAF_FIELDS = ['type', 'executor', 'storyPoints', 'estimateMinutes', 'difficulty'] as const;

/** The ref a step names a proposal by: `planItem:<id>` for an `add`, the work-item id for a `modify`. */
export function proposalRef(item: Pick<PlanItemDto, 'id' | 'op' | 'workItemId'>): string | null {
  if (item.op === 'add') return `planItem:${item.id}`;
  if (item.op === 'modify') return item.workItemId;
  return null;
}

const filled = (v: unknown): boolean =>
  v !== null && v !== undefined && !(typeof v === 'string' && v.trim().length === 0);

/** How {@link proposalComplete} judges a card. Every field is optional. */
export interface ProposalCompleteOptions {
  /**
   * Whether the card owes an explanation (MOTIR-10491). Defaults to `true`, the
   * rule every reader applied before the option existed. A caller that knows the
   * plan's rule passes `requireExplanationFor`'s answer (`lib/plans/planProgress.ts`):
   * a hosted plan on a project with explanations off never writes one, so the
   * default would read every one of its cards as unfinished.
   */
  requireExplanation?: boolean;
}

/**
 * Is this proposal complete — both bodies, no `validate_plan` section finding, and,
 * on a childless leaf, its type, executor, sizing pair and difficulty? `findingRefs`
 * is the set of items `validate_plan`'s `sectionFindings` names.
 *
 * ⚠️ NOT a written-state test (MOTIR-10496): a card is written only when its
 * proposal carries `authorFinished` ({@link deriveAuthoringStates}). This judgement
 * survives for the one-time carry-over (MOTIR-10491), which stamped the finished
 * cards of the plans already open when the state shipped.
 */
export function proposalComplete(
  item: PlanItemDto,
  items: readonly PlanItemDto[],
  findingRefs: ReadonlySet<string>,
  opts: ProposalCompleteOptions = {},
): boolean {
  if (item.op === 'modify') return true;
  if (item.op !== 'add') return false;
  const ref = `planItem:${item.id}`;
  const f = (item.proposedFields ?? {}) as Record<string, unknown>;
  const requireExplanation = opts.requireExplanation ?? true;
  if (!filled(f.descriptionMd)) return false;
  if (requireExplanation && !filled(f.explanationMd)) return false;
  if (findingRefs.has(ref)) return false;
  const kind = typeof f.kind === 'string' ? f.kind : 'task';
  const childless = !items.some((other) => other.op === 'add' && other.parentRef === ref);
  if (!CONTAINER_KINDS.has(kind) && childless) {
    return LEAF_FIELDS.every((k) => filled(f[k]));
  }
  return true;
}

/** The author-step targets among `facts` (a `lay` or a `settle` never starts a card). */
function authorTargets(facts: readonly AuthorSessionFact[]): Set<string> {
  return new Set(
    facts
      .filter((f) => f.kind === 'author' && f.targetRef !== null)
      .map((f) => f.targetRef as string),
  );
}

/**
 * Every `add` on the plan with its authoring state, in the plan's own order. A
 * `modify` targets a committed card and is answered by {@link deriveCommittedStates};
 * a `remove` is never authored.
 *
 * A live author step wins over the stored state: a stamped card being rewritten
 * reads `authoring` for as long as that step lives (the "N authored" count still
 * counts it, because it stays written while it is rewritten).
 */
export function deriveAuthoringStates(
  items: readonly PlanItemDto[],
  liveSteps: readonly AuthorSessionFact[],
): PlanAuthoringStateRow[] {
  const live = authorTargets(liveSteps);

  const rows: PlanAuthoringStateRow[] = [];
  for (const item of items) {
    if (item.op !== 'add') continue;
    const ref = `planItem:${item.id}`;
    const state: PlanAuthoringState = live.has(ref)
      ? 'authoring'
      : isProposalWritten(item.proposedFields)
        ? 'authored'
        : 'not_started';
    const title = (item.proposedFields as { title?: unknown } | null)?.title;
    rows.push({
      ref,
      op: 'add',
      title: typeof title === 'string' ? title : null,
      state,
    });
  }
  return rows;
}

/** The ids of the committed cards this plan's walk re-authors, and which of them a `modify` already rewrote. */
export function committedWalkSet(
  items: readonly PlanItemDto[],
  listed: readonly string[],
  sessions: readonly AuthorSessionFact[],
): { inWalk: Set<string>; rewritten: Set<string> } {
  const inWalk = new Set(listed);
  const rewritten = new Set<string>();
  for (const item of items) {
    if (item.op !== 'modify' || item.workItemId === null) continue;
    const patch = (item.patch ?? {}) as Record<string, unknown>;
    // A TITLE change lists the card for re-authoring in both planners (MOTIR-8644):
    // the title says what the card IS, and its body was written against the old one.
    if ('title' in patch) inWalk.add(item.workItemId);
    if (filled(patch.descriptionMd)) {
      inWalk.add(item.workItemId);
      rewritten.add(item.workItemId);
    }
  }
  for (const ref of authorTargets(sessions)) {
    if (!ref.startsWith('planItem:')) inWalk.add(ref);
  }
  return { inWalk, rewritten };
}

/**
 * Every committed card the read answers, each with its state (MOTIR-10001): the
 * cards the walk re-authors and every card the caller asked about, in that order.
 *
 *   - authoring   — a LIVE author step targets it;
 *   - authored    — an ENDED author session targeted it, or a `modify` already
 *                   carries its new body;
 *   - not_started — the walk re-authors it and no session has opened on it yet;
 *   - not_in_walk — no session of this plan will rewrite its body.
 */
export function deriveCommittedStates(
  items: readonly PlanItemDto[],
  liveSteps: readonly AuthorSessionFact[],
  sessions: readonly AuthorSessionFact[],
  listed: readonly string[],
  cards: readonly CommittedCard[],
): CommittedAuthoringStateRow[] {
  const { inWalk, rewritten } = committedWalkSet(items, listed, sessions);
  const live = authorTargets(liveSteps);
  const ever = authorTargets(sessions);
  const rows: CommittedAuthoringStateRow[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const walked = inWalk.has(card.id);
    const state: CommittedAuthoringState = !walked
      ? 'not_in_walk'
      : live.has(card.id)
        ? 'authoring'
        : ever.has(card.id) || rewritten.has(card.id)
          ? 'authored'
          : 'not_started';
    rows.push({ ref: card.id, key: card.key, title: card.title, inWalk: walked, state });
  }
  return rows;
}
