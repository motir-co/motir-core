// THE REVIEW-DISMISSAL HISTORY ENTRY (bug MOTIR-10434, beside Story MOTIR-10327's
// `agent_verdict` entry in `./verdictActivity.ts`).
//
// Dismissing the review (`reviewDismissalService.dismiss`, approval-gates.md §12.15) appends
// ONE `review_dismissed` revision to the card's trail, in the same transaction as the
// `review_dismissal` row. The revision's actor is the person who dismissed; its diff carries a
// SNAPSHOT of what the feed draws — the version dismissed at, the send-back it dismissed and
// the reason — the `comment_deleted` / `agent_verdict` precedent: the trail is append-only and
// the entry must read the same however the dismissal row is later read. The row stays the
// source of truth for everything that DECIDES; this snapshot only describes.
//
// ⚠️ CLIENT-SAFE. Imported by the activity row, so it imports nothing server-only.

/** The `diff` key the revision carries (`{ reviewDismissal: { from: null, to: snapshot } }`). */
export const REVIEW_DISMISSAL_DIFF_KEY = 'reviewDismissal';

/** The revision's change kind. */
export const REVIEW_DISMISSED_CHANGE_KIND = 'review_dismissed' as const;

/** What a dismissal was, as the trail keeps it. */
export interface ReviewDismissalSnapshot {
  dismissalId: string;
  /** The send-back dismissed: a gate-off review verdict record, or a decided review gate. */
  dismissed: { kind: 'record' | 'gate'; id: string };
  /** The delivery-set version dismissed at — `owner/name#n@sha`, comma-joined. */
  subjectVersion: string;
  /** The person's reason, as they wrote it (trimmed; at most 2000 characters). */
  reasonMd: string;
}
