import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { PlanBlockReasonDto, PlanBlockerDto, PlannabilityDto } from '@/lib/dto/plannability';

// CAN THIS CARD BE PLANNED? (MOTIR-10544) — the rule, stated once, with no I/O.
//
// RULE 1, "a childless story still holds" — the motir-core side of the hold the
// planner already applies (motir-ai `src/llm/blockerHold.ts`, rule 1): a STORY
// that has an open `blocked_by` edge to a STORY with no live children can't be
// planned, because the planner lays a story's subtasks only once every story it
// waits on has subtasks of its own. Without this check the Plan click starts a
// planning run that stalls on that hold.
//
// What counts, and what does not:
//   · Only an OPEN blocker holds. A blocker in a `done`-CATEGORY status never does
//     — the category, not the `done` key, because projects define their own
//     statuses and the default workflow already has a second terminal one
//     (`cancelled`); the same vocabulary `planEntranceVisibility.ts` reads. A
//     `null` category is NOT terminal: the fail-safe direction keeps a hold on
//     work we cannot prove is finished, the way that module keeps its door.
//   · An ARCHIVED blocker never holds. The repository read drops it already (an
//     archived item is soft-removed, the readiness rule's MOTIR-1328); the flag
//     is checked here too so the rule is true of whatever it is handed.
//   · Only a STORY blocker holds. A childless task or bug is a leaf: it has no
//     subtasks to wait for, and the planner's hold is about stories.
//   · "No children" is no LIVE (non-archived) child of any kind.
//   · Only a STORY card is held. The canvas offers Plan on a To plan story only
//     (MOTIR-10508); any other kind is plannable as far as this rule goes.

/** What the rule needs to know about each `blocked_by` target of the card. */
export interface PlannabilityBlockerFacts {
  id: string;
  identifier: string;
  /** The key NUMBER — the order the reason lines are drawn in. */
  key: number;
  title: string;
  kind: string;
  statusCategory: StatusCategoryDto | null;
  archived: boolean;
  liveChildCount: number;
  /** Is the blocker in the same project as the card? (The per-line Plan's gate.) */
  sameProject: boolean;
}

/** Does this blocker hold a story out of planning (rule 1)? */
export function holdsStory(blocker: PlannabilityBlockerFacts): boolean {
  if (blocker.archived) return false;
  if (blocker.statusCategory === 'done') return false;
  return blocker.kind === 'story' && blocker.liveChildCount === 0;
}

function toBlockerDto(blocker: PlannabilityBlockerFacts): PlanBlockerDto {
  return {
    id: blocker.id,
    identifier: blocker.identifier,
    title: blocker.title,
    // A held blocker is already a childless story, so To plan is its category.
    toPlan: blocker.sameProject && blocker.statusCategory === 'todo',
  };
}

/** Every reason the card can't be planned, in a stable order. */
export function planBlockReasons(
  card: { kind: string },
  blockers: readonly PlannabilityBlockerFacts[],
): PlanBlockReasonDto[] {
  if (card.kind !== 'story') return [];
  const held = blockers.filter(holdsStory).sort((a, b) => a.key - b.key);
  if (held.length === 0) return [];
  return [{ kind: 'blocker_has_no_subtasks', blockers: held.map(toBlockerDto) }];
}

/** The whole answer: `plannable` is exactly "no reasons". */
export function plannabilityOf(
  card: { kind: string },
  blockers: readonly PlannabilityBlockerFacts[],
): PlannabilityDto {
  const reasons = planBlockReasons(card, blockers);
  return { plannable: reasons.length === 0, reasons };
}
