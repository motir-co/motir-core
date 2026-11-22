import 'server-only';
import type { WorkItemRunDiscrepancyRecordDto } from '@/lib/dto/runDiscrepancy';
import { formatRunInstant } from '@/lib/runs/runClock';
import type { RunDiscrepancyRecordView } from './RunDiscrepancySection';

// The Run discrepancy section's times, formatted ON THE SERVER (Task MOTIR-11996; design
// decision 7) — the same seam and the same reason as `runTimes.ts`: a list of dates the
// client formats during render reads the browser's clock and locale and mismatches the
// streamed markup. The section receives the strings and has no clock of its own.

export function toRunDiscrepancyViews(
  records: readonly WorkItemRunDiscrepancyRecordDto[],
  locale: string,
): RunDiscrepancyRecordView[] {
  return records.map((record) => ({
    ...record,
    recordedAtLabel: formatRunInstant(record.recordedAt, locale),
    runStartedAtLabel: record.run ? formatRunInstant(record.run.startedAt, locale) : null,
  }));
}
