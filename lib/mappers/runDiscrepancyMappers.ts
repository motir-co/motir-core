import type { RunDiscrepancyEntry } from '@/generated/prisma/client';
import type {
  RunDiscrepancyEntryDto,
  WorkItemRunDiscrepancyRecordDto,
} from '@/lib/dto/runDiscrepancy';
import type { RunDiscrepancyRecordForWorkItem } from '@/lib/repositories/runDiscrepancyRecordRepository';

// `run_discrepancy_record` rows → the work item page's DTO (Task MOTIR-11996). PURE.

function toEntryDto(entry: RunDiscrepancyEntry): RunDiscrepancyEntryDto {
  return {
    position: entry.position,
    planText: entry.planText,
    outcomeText: entry.outcomeText,
    why: entry.why,
    alternatives: entry.alternatives,
  };
}

/** The entries of one kind, in their stored `position` order. */
function entriesOf(
  entries: readonly RunDiscrepancyEntry[],
  kind: RunDiscrepancyEntry['kind'],
): RunDiscrepancyEntryDto[] {
  return entries
    .filter((entry) => entry.kind === kind)
    .sort((a, b) => a.position - b.position)
    .map(toEntryDto);
}

export function toWorkItemRunDiscrepancyRecordDto(
  record: RunDiscrepancyRecordForWorkItem,
): WorkItemRunDiscrepancyRecordDto {
  return {
    id: record.id,
    source: record.source,
    recordedAt: record.recordedAt.toISOString(),
    recordedByName: record.recordedBy?.name ?? null,
    run: record.dispatchRun
      ? { id: record.dispatchRun.id, startedAt: record.dispatchRun.startedAt.toISOString() }
      : null,
    pointCount: record.pointCount,
    decisionCount: record.decisionCount,
    points: entriesOf(record.entries, 'point'),
    decisions: entriesOf(record.entries, 'decision'),
  };
}
