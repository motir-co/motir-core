// DTOs for the triage inbox (Story 6.11). What crosses the HTTP / Server-Action
// boundary for the triage-queue read (Subtask 6.11.3) — no Prisma row shape
// leaks. Dates become ISO-8601 strings; the submitter is resolved to a single
// shape (member vs public) so the inbox UI (6.11.6) renders the submitter avatar
// and a "Public" chip without re-deriving origin.

import type { WorkItemKindDto, WorkItemPriorityDto, WorkItemRefMap } from './workItems';
import type { CommentDTO } from './comments';
import type { AttachmentDTO } from './attachments';

/**
 * Who submitted a triage item (ADR §3, the 2026-06-14 signed-in-only revision —
 * Subtask 6.11.10). Intake is signed-in only, so EVERY triage item carries a
 * real account (`submittedByUserId`); the captured-external name/email shape is
 * retired. `kind` distinguishes the two signed-in origins, derived from whether
 * the submitter is a member of the work item's workspace:
 *   - `member` — a workspace member submitting through the in-app "report a bug
 *     / request a feature" widget.
 *   - `public` — a signed-in NON-member submitting through Story 6.12's
 *     public-project "Submit a request" form (granted by `canSubmitToTriage`);
 *     they have an account but no tenant access.
 * `userId` is the submitter's account id (null only for a legacy/never-attributed
 * triage row); `name` / `email` / `image` are that account's display fields.
 */
export interface TriageSubmitterDto {
  kind: 'member' | 'public';
  userId: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * One row of the triage inbox queue. The lighter list shape (no full Markdown
 * body — a bounded `descriptionSnippet` instead) plus the triage-specific
 * fields: submitter attribution, the `triagedAt` age timestamp, and
 * `snoozedUntil` (always null for an item in the ACTIVE queue, carried for the
 * snoozed-variant view).
 */
export interface TriageQueueItemDto {
  id: string;
  /** A submission is born `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  /** A bounded prefix of the submission body (never the full `@db.Text` blob). */
  descriptionSnippet: string | null;
  status: string;
  priority: WorkItemPriorityDto;
  submitter: TriageSubmitterDto;
  /** When the item entered triage (ISO-8601) — the inbox renders its age. */
  triagedAt: string;
  /** Snooze-until (ISO-8601), or null when active. */
  snoozedUntil: string | null;
  /**
   * How many accounts upvoted this request (Story 6.12 · Subtask 6.12.6) — the
   * demand signal the queue is sorted by (highest-first). 0 when no public
   * votes; the inbox renders it so the admin sees what's in demand.
   */
  voteCount: number;
  createdAt: string;
}

/**
 * One page of the triage queue. `nextCursor` is the opaque seek-after token for
 * the following page, or null when this is the last page (finding #57 — the
 * inbox is cursor-paginated, never load-all).
 */
export interface TriageQueuePageDto {
  items: TriageQueueItemDto[];
  nextCursor: string | null;
}

/**
 * The full triage item the inbox DETAIL pane renders (Subtask 6.11.6) — the
 * read behind a row click. Unlike the lighter {@link TriageQueueItemDto} list
 * shape it carries the FULL Markdown body plus the item's whole comment +
 * attachment thread (the SAME shipped `CommentDTO` / `AttachmentDTO` shapes the
 * issue-detail page renders), so the inbox reuses the existing display
 * primitives without re-deriving anything. The comments arrive flattened
 * (roots + their single-level replies) oldest-first; attachments newest-first.
 */
export interface TriageItemDetailDto {
  id: string;
  /** A submission is born `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  identifier: string;
  title: string;
  /** The full submission body (Markdown), or null when none was given. */
  descriptionMd: string | null;
  submitter: TriageSubmitterDto;
  /** When the item entered triage (ISO-8601) — the detail renders its age. */
  triagedAt: string;
  comments: CommentDTO[];
  attachments: AttachmentDTO[];
  /** The chips of every `[KEY](motir:<id>)` in the body and the thread, resolved for the
   *  reader (bug MOTIR-10023) — `{}` when nothing links a card. */
  workItemRefs: WorkItemRefMap;
}

/**
 * What the intake path returns after creating a triage submission (Subtask
 * 6.11.4). A thin confirmation — the in-app widget (6.11.7) only needs to toast
 * success and may deep-link by `identifier`; the full body lives in the inbox
 * (the queue / detail reads). The created item is in the `triage` state, so it
 * is NOT yet in the tree / board / list / search.
 */
export interface TriageSubmissionResultDto {
  id: string;
  /** A submission is born `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  /** The allocated work-item identifier (e.g. "PROD-42"). */
  identifier: string;
  title: string;
}
