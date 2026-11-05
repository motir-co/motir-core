import { membersOf } from '@/lib/approvalGates/memberVersion';
import type { ActivityTab } from '@/lib/activity/tab';
import type { ReviewRecordRefDTO } from '@/lib/dto/reviewState';

// THE AGENT-VERDICT HISTORY ENTRY (Story MOTIR-10327 · MOTIR-10338; design
// `design/work-items/decision-waiting--review-path.mock.html` M12, notes § 32.9).
//
// Every review verdict record — the user-token door's and the hosted run's, at every
// version and every outcome — appends ONE `agent_verdict` revision to its card's trail,
// in the same transaction as the record. The revision carries a SNAPSHOT of what the feed
// draws (who, which agent, the outcome, the commits, the findings), the `comment_deleted`
// precedent: the trail is append-only and the entry must read the same after the record's
// submitter or the card's assignee changes. The record stays the source of truth for
// everything that DECIDES; this snapshot only describes.
//
// ⚠️ CLIENT-SAFE. Imported by the activity row, so it imports nothing server-only.

/** The `diff` key the revision carries (`{ agentVerdict: { from: null, to: snapshot } }`). */
export const AGENT_VERDICT_DIFF_KEY = 'agentVerdict';

/** The revision's change kind. */
export const AGENT_VERDICT_CHANGE_KIND = 'agent_verdict' as const;

/** The findings kept on the trail are capped; the record holds them whole. */
export const FINDINGS_EXCERPT_MAX = 4000;

/** What a verdict record was, as the trail keeps it. */
export interface AgentVerdictSnapshot {
  recordId: string;
  /** `pass` or `changes_requested`. */
  verdict: 'pass' | 'changes_requested';
  /** `decided` / `recorded` answered the version; `late` and `second` decided nothing. */
  outcome: 'decided' | 'recorded' | 'late' | 'second';
  /** Motir's hosted review run, or a person's own agent. */
  hosted: boolean;
  harness: string;
  model: string;
  /** The delivery-set version reviewed — `owner/name#n@sha`, comma-joined. */
  subjectVersion: string;
  findingsExcerpt: string | null;
  /** The assignee a send-back notified, or null (a pass, late, second — or no assignee). */
  notifiedUserId: string | null;
}

/** A send-back that answered its version — the only verdict that notifies anyone. */
export function isAnsweringSendBack(record: { verdict: string; outcome: string }): boolean {
  return (
    record.verdict === 'changes_requested' &&
    (record.outcome === 'decided' || record.outcome === 'recorded')
  );
}

/** The trail's excerpt of a record's findings. */
export function findingsExcerptOf(findingsMd: string | null): string | null {
  const trimmed = findingsMd?.trim();
  if (!trimmed) return null;
  return trimmed.length > FINDINGS_EXCERPT_MAX
    ? `${trimmed.slice(0, FINDINGS_EXCERPT_MAX - 1).trimEnd()}…`
    : trimmed;
}

/**
 * The commits a delivery-set version names, as the review path writes them:
 * `acme/web#88 @ 3f2a9c1, acme/api#41 @ 9b07de4` (seven-character heads). A version that
 * does not parse is shown as written rather than dropped.
 */
export function reviewCommitsLabel(subjectVersion: string): string {
  const members = membersOf(subjectVersion);
  if (members.length === 0) return subjectVersion;
  return members.map((m) => `${m.repo}#${m.number} @ ${m.headSha.slice(0, 7)}`).join(', ');
}

/** The activity entry's element id — the send-back notification's deep link lands on it. */
export function agentVerdictAnchor(recordId: string): string {
  return `agent-verdict-${recordId}`;
}

/**
 * The Activity tab that draws a verdict's entry. Comments — the DEFAULT tab — reads
 * comments only, so an address carrying the anchor alone lands on a page without it.
 */
const AGENT_VERDICT_TAB: ActivityTab = 'all';

/**
 * Where a verdict's Activity entry lives on its card page: `itemHref` (the reader's own
 * route to the card, from `useReaderRoutes` on a shared body) on the All tab, then the
 * entry's anchor — which the entry reads to open its findings (MOTIR-10458). The tab is
 * named in the address, so the link lands the same whichever tab the reader last used.
 */
export function agentVerdictHref(itemHref: string, recordId: string): string {
  const hashAt = itemHref.indexOf('#');
  const path = hashAt < 0 ? itemHref : itemHref.slice(0, hashAt);
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}activity=${AGENT_VERDICT_TAB}#${agentVerdictAnchor(recordId)}`;
}

/**
 * Where a review record or gate's findings live on the card page: a RECORD's Activity
 * entry ({@link agentVerdictHref}), or the Development section for a pass with no record,
 * only a gate. Null when there is nothing to open.
 */
export function findingsHrefOf(itemHref: string, ref: ReviewRecordRefDTO | null): string | null {
  if (!ref) return null;
  return ref.kind === 'record' ? agentVerdictHref(itemHref, ref.id) : `${itemHref}#development`;
}

/** The name in a stored decider label (`Name <email>`), without the address. */
export function nameOfDeciderLabel(label: string): string {
  return label.replace(/\s*<[^<>]*>\s*$/, '').trim() || label;
}
