import type { RunDiscrepancySource } from '@/generated/prisma/client';

// A card's run discrepancy records as its Run discrepancy section reads them (Task
// MOTIR-11996; `design/runs/design-notes.md` § _Run discrepancy — the record gets its own
// section on the work item page_, its *Fields read* table). Read-only: nothing on the page
// edits a record.

/** One point or decision, its fields as the run sent them. */
export interface RunDiscrepancyEntryDto {
  /** Its place among the entries of its kind, from 1. */
  position: number;
  /** A point's _Plan asked_, a decision's _Plan said_. */
  planText: string;
  /** A point's _Built_, a decision's _Chose_. */
  outcomeText: string;
  why: string;
  /** A decision's _Alternatives_; always null on a point, and on a decision that sent none. */
  alternatives: string | null;
}

/** One `run_discrepancy_record` of a card. */
export interface WorkItemRunDiscrepancyRecordDto {
  id: string;
  source: RunDiscrepancySource;
  /** ISO-8601. */
  recordedAt: string;
  /** The recorder's name; null once their account is gone (`recorded_by_id` SET NULL). */
  recordedByName: string | null;
  /** The run the record was made in; null on the no-open-leg arm, or once the run is gone. */
  run: { id: string; startedAt: string } | null;
  /** Stored counts — what an unreadable backfill says it lost. */
  pointCount: number;
  decisionCount: number;
  /** Ordered by `position`. Empty on `backfill_unreadable`. */
  points: RunDiscrepancyEntryDto[];
  decisions: RunDiscrepancyEntryDto[];
}
