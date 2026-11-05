import type { ReviewVerdictRecord } from '@/generated/prisma/client';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// THE TEXT MOTIR'S APP BOT POSTS (Story MOTIR-10327 · MOTIR-10335; `approval-gates.md` §12
// rule 7) — the review body on the pull request, and the one-line reason a dismissal of
// its own Request changes carries. Fixed English, not catalogue copy: it is written onto
// a third party's page, read by whoever reviews there, and is no Motir surface.
//
// Pure: no I/O. The verdict, its checklist and its findings are the record's own words.

/** GitHub's limit on a review body is 65,536 characters; stay clear of it. */
export const BOT_REVIEW_BODY_MAX_LENGTH = 60_000;

/** Why the bot dismissed its own Request changes. */
export type BotDismissalReason = 'passed' | 'dismissed' | 'posting_off';

/** The card's page in Motir. */
export function cardUrl(identifier: string): string {
  return `${resolveBaseUrlTrimmed()}/items/${encodeURIComponent(identifier)}`;
}

interface ChecklistRow {
  criterion: string;
  status: string;
}

/** The record's checklist rows, read defensively — the column is JSON. */
function checklistOf(record: Pick<ReviewVerdictRecord, 'checklist'>): ChecklistRow[] {
  if (!Array.isArray(record.checklist)) return [];
  return record.checklist.flatMap((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const { criterion, status } = row as Record<string, unknown>;
    return typeof criterion === 'string' && typeof status === 'string'
      ? [{ criterion, status }]
      : [];
  });
}

const STATUS_WORD: Record<string, string> = {
  met: 'met',
  not_met: 'not met',
  cannot_tell: 'cannot tell',
};

/** One line counting the checklist, and the rows that were not met. */
function checklistSection(rows: ChecklistRow[]): string[] {
  if (rows.length === 0) return [];
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const lines = [
    `**Checklist:** ${count('met')} met · ${count('not_met')} not met · ` +
      `${count('cannot_tell')} cannot tell (of ${rows.length})`,
  ];
  for (const row of rows) {
    if (row.status === 'met') continue;
    lines.push(`- ${STATUS_WORD[row.status] ?? row.status}: ${row.criterion.replace(/\s+/g, ' ')}`);
  }
  return lines;
}

/** The review body for one verdict record. */
export function botReviewBody(
  record: Pick<ReviewVerdictRecord, 'verdict' | 'summaryMd' | 'findingsMd' | 'checklist'>,
  identifier: string,
  url: string,
): string {
  const passed = record.verdict === 'pass';
  const parts: string[] = [
    passed
      ? `**Motir agent review: passed** — [${identifier}](${url})`
      : `**Motir agent review: changes requested** — [${identifier}](${url})`,
  ];
  if (record.summaryMd?.trim()) parts.push(record.summaryMd.trim());
  const checklist = checklistSection(checklistOf(record));
  if (checklist.length > 0) parts.push(checklist.join('\n'));
  if (record.findingsMd?.trim()) parts.push(`**Findings**\n\n${record.findingsMd.trim()}`);
  parts.push(
    passed
      ? '_Posted by Motir for the review agent. This is not an approval: a person approves the merge in Motir._'
      : '_Posted by Motir for the review agent. It is dismissed when a later review passes, or when a person dismisses it in Motir._',
  );
  const body = parts.join('\n\n');
  return body.length <= BOT_REVIEW_BODY_MAX_LENGTH
    ? body
    : `${body.slice(0, BOT_REVIEW_BODY_MAX_LENGTH)}\n\n… (cut — the full review is on [${identifier}](${url}))`;
}

/** The one-line reason a dismissal of the bot's own Request changes carries. */
export function botDismissalMessage(
  reason: BotDismissalReason,
  identifier: string,
  url: string,
): string {
  switch (reason) {
    case 'passed':
      return `A later Motir agent review passed ${identifier}: ${url}`;
    case 'dismissed':
      return `A person dismissed this agent review in Motir on ${identifier}: ${url}`;
    case 'posting_off':
      return `Posting agent reviews was turned off for this project; see ${identifier}: ${url}`;
  }
}
