import {
  REVIEW_CHECKLIST_STATUSES,
  type ReviewChecklistRowDto,
  type ReviewChecklistStatus,
} from '@/lib/dto/agentReview';

// THE STORED CHECKLIST ROWS of a review verdict record (Story MOTIR-10327 · MOTIR-10460;
// `design/workbench/design-notes.md` § 42.2) — read DEFENSIVELY, because the column is JSON
// (`review_verdict_record.checklist`). The verdict door validates every row it writes
// (`reviewVerdictService`), so a malformed row is not expected; one that is there anyway is
// left out rather than drawn as a guess, and the rows keep the order they were stored in.
//
// ⚠️ CLIENT-SAFE AND PURE. The findings view and the activity read both use it.

const STATUSES: ReadonlySet<string> = new Set(REVIEW_CHECKLIST_STATUSES);

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** One stored row, or null when it is not a row the door could have written. */
function rowOf(value: unknown): ReviewChecklistRowDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const criterion = textOrNull(row['criterion']);
  const status = row['status'];
  if (criterion === null || typeof status !== 'string' || !STATUSES.has(status)) return null;
  return {
    key: textOrNull(row['key']),
    criterion,
    status: status as ReviewChecklistStatus,
    evidence: textOrNull(row['evidence']),
  };
}

/** The record's checklist rows, in stored order; `[]` for anything that is not a list. */
export function reviewChecklistRowsOf(checklist: unknown): ReviewChecklistRowDto[] {
  if (!Array.isArray(checklist)) return [];
  return checklist.flatMap((value) => {
    const row = rowOf(value);
    return row ? [row] : [];
  });
}
