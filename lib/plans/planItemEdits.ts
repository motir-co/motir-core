// WHEN EACH PROPOSAL WAS LAST CHANGED (MOTIR-11185) — the pure half of the live
// read's per-item edit time, so the rule is tested against plain rows.
//
// Every write that changes a proposal already on a plan — a deepen, a correction
// (`update_plan_proposal`), a merge that widens an existing `modify` — records ONE
// `plan_revision` row with `change_kind = 'edited'` and the `plan_item_id` it
// touched (`plansService`). The planning canvas highlights a card when that time
// moves between two polls, so the read carries the NEWEST such time per item.
//
// Only `edited` counts. An `appended` row is plan-level (no item: the new cards
// it carries ARRIVE, which the canvas already draws), a `withdrawn` proposal is
// gone from the plan, and the lifecycle rows (`created`, `planned`, a decision)
// name no proposal at all.

/** The change kind every proposal edit writes (`PlanRevisionChangeKind`). */
export const PLAN_ITEM_EDITED_KIND = 'edited';

/** The fields of a trail row this reads — `PlanRevision`'s. */
export interface PlanItemEditRow {
  changeKind: string;
  changedAt: Date;
  planItemId: string | null;
}

/**
 * The newest `edited` time per proposal, as an ISO string, keyed by
 * `planItemId`. A proposal never edited is absent. Order-independent: the trail
 * is read oldest first, but nothing here relies on it.
 */
export function lastEditedAtByItem(rows: readonly PlanItemEditRow[]): Map<string, string> {
  const newest = new Map<string, Date>();
  for (const row of rows) {
    if (row.changeKind !== PLAN_ITEM_EDITED_KIND || !row.planItemId) continue;
    const seen = newest.get(row.planItemId);
    if (!seen || row.changedAt > seen) newest.set(row.planItemId, row.changedAt);
  }
  return new Map([...newest].map(([id, at]) => [id, at.toISOString()] as const));
}
