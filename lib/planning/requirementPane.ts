// THE LEFT PANE'S REQUIREMENT, the pure half (Story MOTIR-9430 · MOTIR-9437). While the
// conversation's live offer is a plan offer with NO target, the planning overlay's left
// pane shows the requirement Motir AI composed for it, so the person reads what will be
// planned before saying yes. Whether that layer is up is DERIVED from the thread through
// the one rule the rail already reads (`pendingPlanOfferOf`), so the pane and the rail
// cannot disagree about which offer is live, and a reload or reopen needs no stored flag.
import { pendingPlanOfferOf, type PlanOfferTurn } from '@/lib/planChange/planOffer';
import type { SubmittedRequirement } from '@/lib/ai/types';

export interface RequirementPane {
  /** The offer's turn — a newer offer is a different key, so the pane's scroll resets. */
  turnId: string;
  /** The offer's request text, shown as the document's title line. */
  requestMd: string;
  /** The composed requirement; null for an offer that carries none. */
  requirement: SubmittedRequirement | null;
}

/** The pane for a thread, or null when no no-target plan offer is pending. */
export function requirementPaneOf(turns: readonly PlanOfferTurn[]): RequirementPane | null {
  const pending = pendingPlanOfferOf(turns);
  if (!pending) return null;
  const { offer } = pending;
  if (offer.kind !== 'plan' || offer.targetKey !== null) return null;
  return {
    turnId: pending.turnId,
    requestMd: offer.requestMd,
    requirement: offer.requirement ?? null,
  };
}

export interface AssumptionRow {
  id: string;
  text: string;
}

/**
 * The assumptions as rows: a bare string is one row, an entry with no id shows as
 * `r<position>` (1-based), and nothing (or an empty list) is no rows. A blank entry
 * is dropped, and the position counts the entries as stored.
 */
export function assumptionRowsOf(
  assumptions: SubmittedRequirement['assumptions'],
): AssumptionRow[] {
  if (assumptions === undefined || assumptions === null) return [];
  const list = typeof assumptions === 'string' ? [assumptions] : assumptions;
  const rows: AssumptionRow[] = [];
  list.forEach((entry, i) => {
    const text = (typeof entry === 'string' ? entry : entry?.text) ?? '';
    if (text.trim().length === 0) return;
    const id = typeof entry === 'string' ? undefined : entry.id;
    rows.push({ id: id && id.trim().length > 0 ? id : `r${i + 1}`, text });
  });
  return rows;
}
