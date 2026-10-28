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
// The facts are already on the server: both planners report every author
// session's start and end (`report_plan_step`).
//
//   - authoring    — a LIVE `PlanStep` row of kind `author` targets the card
//                    (`end` deletes the row);
//   - authored     — an ENDED author session targeted it (its
//                    `PlanNarrationSession` row outlives `end`), or the card has
//                    no session at all and is already COMPLETE: a card the
//                    surgical add appends complete never gets an author session,
//                    and read sessions-only it would read `not_started` for ever;
//   - not_started  — no author session, live or ended, AND the card is still
//                    incomplete.
//
// "Complete" is not "has a body": a failed session can leave a partial body, and a
// `modify` always has one. The test is the one both planners use to decide whether
// a card still needs its author session — plan.py's `author_gaps`: both bodies,
// no `validate_plan` section finding for the card's kind × type, and, on a
// childless leaf, its type, executor, sizing pair and difficulty. A `modify` is
// appended complete (only an `add` is deepened), so it is complete.
//
// PURE: no DB, no `tx`. The service hands in the plan's items, its step rows, its
// narration-session rows and the section findings.

import type { PlanItemDto } from '@/lib/dto/plans';
import type { SectionFindingDto } from '@/lib/dto/workItems';

export type PlanAuthoringState = 'not_started' | 'authoring' | 'authored';

/** One proposal's state, as the read answers it. */
export interface PlanAuthoringStateRow {
  /** `planItem:<id>` for an `add`; the target work item's id for a `modify`. */
  ref: string;
  op: 'add' | 'modify';
  title: string | null;
  state: PlanAuthoringState;
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

/**
 * Is this proposal complete — would neither planner open an author session on it?
 * `findingRefs` is the set of items `validate_plan`'s `sectionFindings` names.
 */
export function proposalComplete(
  item: PlanItemDto,
  items: readonly PlanItemDto[],
  findingRefs: ReadonlySet<string>,
): boolean {
  if (item.op === 'modify') return true;
  if (item.op !== 'add') return false;
  const ref = `planItem:${item.id}`;
  const f = (item.proposedFields ?? {}) as Record<string, unknown>;
  if (!filled(f.descriptionMd) || !filled(f.explanationMd)) return false;
  if (findingRefs.has(ref)) return false;
  const kind = typeof f.kind === 'string' ? f.kind : 'task';
  const childless = !items.some((other) => other.op === 'add' && other.parentRef === ref);
  if (!CONTAINER_KINDS.has(kind) && childless) {
    return LEAF_FIELDS.every((k) => filled(f[k]));
  }
  return true;
}

/**
 * Every `add` and `modify` on the plan with its authoring state, in the plan's own
 * order. A `remove` is never authored and is left out.
 */
export function deriveAuthoringStates(
  items: readonly PlanItemDto[],
  liveSteps: readonly AuthorSessionFact[],
  sessions: readonly AuthorSessionFact[],
  findings: readonly Pick<SectionFindingDto, 'item'>[],
): PlanAuthoringStateRow[] {
  const authorTargets = (facts: readonly AuthorSessionFact[]): Set<string> =>
    new Set(
      facts
        .filter((f) => f.kind === 'author' && f.targetRef !== null)
        .map((f) => f.targetRef as string),
    );
  const live = authorTargets(liveSteps);
  const ever = authorTargets(sessions);
  const findingRefs = new Set(findings.map((f) => f.item));

  const rows: PlanAuthoringStateRow[] = [];
  for (const item of items) {
    const ref = proposalRef(item);
    if (ref === null || (item.op !== 'add' && item.op !== 'modify')) continue;
    const state: PlanAuthoringState = live.has(ref)
      ? 'authoring'
      : ever.has(ref) || proposalComplete(item, items, findingRefs)
        ? 'authored'
        : 'not_started';
    const title = (item.proposedFields as { title?: unknown } | null)?.title;
    rows.push({
      ref,
      op: item.op,
      title: typeof title === 'string' ? title : null,
      state,
    });
  }
  return rows;
}
