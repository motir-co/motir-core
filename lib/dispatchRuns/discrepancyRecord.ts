import type { RunDiscrepancyEntry } from '@/generated/prisma/client';
import type { RunDiscrepancyEntryInput } from '@/lib/repositories/runDiscrepancyRecordRepository';
import type { RunDecisionPoint, RunDiscrepancyPoint } from './discrepancyComment';

// A discrepancy record's entries ⇄ the points and decisions a run sends (Task MOTIR-11361).
// PURE. The two kinds share one row shape (`run_discrepancy_entry`), so the mapping
// between a field name and its column lives here once, for the writer, the reads and the
// backfill alike:
//
//   point     planAsked → plan_text · built → outcome_text · why → why
//   decision  planSaid  → plan_text · chose → outcome_text · why → why · alternatives

/** The rows one record's points and decisions are stored as, each kind numbered from 1. */
export function toEntryInputs(
  points: readonly RunDiscrepancyPoint[],
  decisions: readonly RunDecisionPoint[],
): RunDiscrepancyEntryInput[] {
  return [
    ...points.map((p, i) => ({
      kind: 'point' as const,
      position: i + 1,
      planText: p.planAsked,
      outcomeText: p.built,
      why: p.why,
      alternatives: null,
    })),
    ...decisions.map((d, i) => ({
      kind: 'decision' as const,
      position: i + 1,
      planText: d.planSaid,
      outcomeText: d.chose,
      why: d.why,
      alternatives: d.alternatives ?? null,
    })),
  ];
}

/** A record's stored entries back as points and decisions, in the order the run sent them. */
export function fromEntries(entries: readonly RunDiscrepancyEntry[]): {
  points: RunDiscrepancyPoint[];
  decisions: RunDecisionPoint[];
} {
  const ordered = [...entries].sort((a, b) => a.position - b.position);
  return {
    points: ordered
      .filter((e) => e.kind === 'point')
      .map((e) => ({ planAsked: e.planText, built: e.outcomeText, why: e.why })),
    decisions: ordered
      .filter((e) => e.kind === 'decision')
      .map((e) => ({
        planSaid: e.planText,
        chose: e.outcomeText,
        why: e.why,
        ...(e.alternatives !== null ? { alternatives: e.alternatives } : {}),
      })),
  };
}
