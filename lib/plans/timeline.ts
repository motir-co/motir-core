import type { PlanHistoryEventDto, PlanVersionDto } from '@/lib/dto/planReview';

// The plan timeline's MERGE (Story MOTIR-3532 · Subtask MOTIR-3536) — pure logic,
// no I/O, so the ordering and collapse rules `design/ai-planning/design-notes.md`
// Part X decides can be pinned directly rather than through a database fixture.
// `planReviewService` is the only caller; it supplies the derived lifecycle
// events and the stored content ones and renders what comes back.

/**
 * The stored `changeKind`s the DERIVED timeline already says (MOTIR-3536).
 *
 * The trail records all six plan mutations, and it must: it is the audit record,
 * and a trail with holes in it cannot be filled in later. The TIMELINE renders
 * only what the derived four cannot express, because `Plan.createdAt` /
 * `plannedAt` / `decidedAt` / `decisionReason` already say these four correctly,
 * from columns that cannot disagree with themselves, and rendering both copies
 * would put every plan's open and close on the rail twice.
 *
 * ⚠️ THE SET IS THE EXCLUSION, NOT THE INCLUSION — deliberately, so the totality
 * runs the safe way. A stored kind this file has never heard of (the sibling
 * story's structural edits and withdrawals are the expected next ones) RENDERS,
 * and the worst case is a row whose label needs a copy key. The inverse — an
 * allow-list — would make a new verb vanish silently from the one surface built
 * to show it.
 */
export const DERIVED_EVENT_KINDS = new Set(['created', 'planned', 'approved', 'declined']);

/**
 * The stored `changeKind`s that are NOT EVENTS at all (Bug MOTIR-7988), dropped
 * from the timeline for the opposite reason from {@link DERIVED_EVENT_KINDS}:
 * those are said elsewhere, these say nothing a reader acts on.
 *
 * `revision_renewed` is the revision lease's heartbeat — a holder still working
 * writes one every few minutes so the plan stays held. The trail keeps it because
 * the lease is READ off the trail; a rail of *still revising* rows would bury
 * the revision it belongs to.
 */
export const TRAIL_ONLY_KINDS = new Set(['revision_renewed']);

/** How many proposals a content event covered — its own count, else one act. */
export function revisionCount(diff: unknown): number {
  const n = (diff as { proposalCount?: unknown } | null)?.proposalCount;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * The COLLAPSE key (Part X §5): consecutive events of the same kind BY THE SAME
 * ACTOR, with nothing between them, are one row.
 *
 * Keyed on the actor in BOTH senses, so an agent's run and a person's run never
 * merge even when they land in the same second. Adjacency does the rest — and it
 * is adjacency rather than a time window on purpose: a window merges two parties'
 * work whenever it happens to fall close together, and it cannot be made not to.
 */
function collapseKey(ev: PlanHistoryEventDto): string {
  return [ev.kind, ev.byName ?? '', ev.actorSource ?? '', ev.actorHarness ?? ''].join('\u0000');
}

/**
 * Merge the STORED content events into the DERIVED lifecycle ones, in time order,
 * and collapse the runs (MOTIR-3536 · Part X §2 and §5).
 *
 * ⚠️ THE SORT IS STABLE AND THE DERIVED EVENT WINS A TIE. `createPlan` writes the
 * plan row and its revision in ONE transaction, so `plan.createdAt` and the
 * trail's first `changed_at` can land on the same millisecond; the same holds for
 * `markPlanned` and both decisions. Putting the derived event first at equal
 * timestamps keeps *Generation started* above the append it enclosed, which is
 * the order a reader expects and the order the acts actually happened in.
 *
 * ⚠️ A COLLAPSED RUN NEVER SWALLOWS A DIFFERENT KIND. The collapse runs over the
 * MERGED list, so a lifecycle event between two appends breaks the run by
 * construction — no decision can ever be hidden inside a count.
 */
export function mergeTimeline(
  derived: PlanHistoryEventDto[],
  stored: PlanHistoryEventDto[],
): PlanHistoryEventDto[] {
  const ordered = [
    ...derived.map((ev, i) => ({ ev, derived: true, i })),
    ...stored.map((ev, i) => ({ ev, derived: false, i })),
  ].sort((a, b) => {
    const at = a.ev.at ? Date.parse(a.ev.at) : Number.POSITIVE_INFINITY;
    const bt = b.ev.at ? Date.parse(b.ev.at) : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    if (a.derived !== b.derived) return a.derived ? -1 : 1;
    return a.i - b.i;
  });

  const out: PlanHistoryEventDto[] = [];
  for (const { ev, derived: isDerived } of ordered) {
    const prev = out[out.length - 1];
    if (
      !isDerived &&
      prev &&
      prev.count !== undefined &&
      collapseKey(prev) === collapseKey(ev) &&
      ev.at
    ) {
      // Fold into the run: the count sums, and the timestamp becomes a span whose
      // END moves with each absorbed event. `at` — the run's first instant —
      // never moves, because that is when the run started.
      prev.count = (prev.count ?? 0) + (ev.count ?? 1);
      prev.until = ev.at;
      continue;
    }
    out.push({ ...ev });
  }
  return out;
}

/**
 * The plan's VERSIONS, oldest first (MOTIR-11487; design MOTIR-11486 § "The
 * earlier version, kept as history"): one per stored `planned` close, which is
 * the moment a version became something a person was asked to read. Each carries
 * the count that close recorded and the briefing it closed with — `null` for a
 * close written before the briefing was kept, which the planning rail draws as
 * its one *briefing was not kept* line.
 *
 * Pure: `planReviewService` hands it the trail it already read. A close whose
 * diff is not the shape this file reads (a hand-written row) still yields a
 * version — a count of 0 and no briefing — rather than vanishing from the rail.
 */
export function planVersionsOf(
  trail: ReadonlyArray<{ id: string; changeKind: string; changedAt: Date; diff: unknown }>,
): PlanVersionDto[] {
  return trail
    .filter((row) => row.changeKind === 'planned')
    .map((row) => {
      const diff = (row.diff ?? {}) as { itemCount?: unknown; summary?: unknown };
      return {
        id: row.id,
        plannedAt: row.changedAt.toISOString(),
        itemCount:
          typeof diff.itemCount === 'number' && Number.isFinite(diff.itemCount)
            ? diff.itemCount
            : 0,
        summary:
          typeof diff.summary === 'string' && diff.summary.trim() !== '' ? diff.summary : null,
      };
    })
    .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));
}
