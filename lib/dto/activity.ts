// Activity-feed DTOs (Story 5.5 · Subtask 5.5.1) — the wire shape of the
// issue History feed. A `work_item_revision` row crosses the API boundary as
// an ActivityEntryDto: the raw machine diff ({ assigneeId: { from, to } })
// becomes a list of typed PARTS the UI renders as sentences ("changed the
// Assignee: Odie → Mo"). The service ships DATA, not prose — field keys and
// discriminated value forms — so the UI owns wording via next-intl and the
// 5.5.3 design owns the row grammar.

import type { CommentThreadDTO } from '@/lib/dto/comments';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

/**
 * One side of a change, resolved to its display form. Discriminated by
 * `type` so the UI picks the right rendering (Pill for statuses, Avatar +
 * name for users, …). A deleted referent keeps its stored id with the
 * resolved field (`label` / `name` / `identifier`) null — the UI renders its
 * fallback form ("former member", the raw key) instead of crashing; the id is
 * never dropped.
 */
export type ActivityValueDto =
  | { type: 'none' }
  | { type: 'text'; text: string }
  | { type: 'status'; key: string; label: string | null }
  | { type: 'user'; userId: string; name: string | null; image: string | null }
  | { type: 'date'; date: string }
  | { type: 'sprint'; sprintId: string; name: string | null }
  | { type: 'issue'; workItemId: string; identifier: string | null };

/**
 * One renderable piece of an activity entry. A scalar field edit is a
 * `field` part; body fields (description / explanation) are `fieldEdited` —
 * the feed says "updated the Description" and NEVER inlines the text; link
 * changes carry the link kind + the target issue; in-flight collection
 * shapes (attachments / labels / components, Stories 5.2 / 5.4) are
 * `collection` parts; a 5.1.2 comment deletion is a `commentDeleted` part
 * (who + reply count, never the content); and any diff key the registry
 * doesn't know renders as the `generic` part — the mistake-#29 fallback that
 * keeps the lookup total by construction.
 */
export type ActivityEntryPartDto =
  | { kind: 'created' }
  | { kind: 'archived' }
  | { kind: 'unarchived' }
  | { kind: 'field'; field: string; from: ActivityValueDto; to: ActivityValueDto }
  | { kind: 'fieldEdited'; field: string }
  | { kind: 'link'; op: 'added' | 'removed'; linkKind: string; target: ActivityValueDto }
  | { kind: 'collection'; field: string; op: 'added' | 'removed'; items: string[] }
  | { kind: 'commentDeleted'; author: ActivityValueDto; replyCount: number }
  | ActivityAgentVerdictPartDto
  | ActivityReviewDismissedPartDto
  | { kind: 'generic'; key: string; from: string | null; to: string | null };

/**
 * An agent's review VERDICT (Story MOTIR-10327 · MOTIR-10338; design
 * `decision-waiting--review-path.mock.html` M12) — one per verdict record, at every
 * version and outcome. The entry's ACTOR is who submitted it (the token's user, or the
 * hosted run's); `hosted` says whether Motir's hosted agent or that person's own agent
 * (`harness`, `model`) reviewed. `late` and `second` decided nothing, and say so.
 */
export interface ActivityAgentVerdictPartDto {
  kind: 'agentVerdict';
  recordId: string;
  verdict: 'pass' | 'changes_requested';
  outcome: 'decided' | 'recorded' | 'late' | 'second';
  hosted: boolean;
  harness: string;
  model: string;
  /** The delivery-set version reviewed — `owner/name#n@sha`, comma-joined. */
  subjectVersion: string;
  /** The findings as the trail kept them (capped), or null. */
  findingsExcerpt: string | null;
  /** The assignee a send-back notified, or null. */
  notified: ActivityValueDto | null;
}

/**
 * The routed person DISMISSED the agent's standing send-back (bug MOTIR-10434, beside
 * MOTIR-10338's verdict entry). The entry's ACTOR is who dismissed it; the part names the
 * version dismissed at and the reason they gave.
 */
export interface ActivityReviewDismissedPartDto {
  kind: 'reviewDismissed';
  dismissalId: string;
  /** The delivery-set version dismissed at — `owner/name#n@sha`, comma-joined. */
  subjectVersion: string;
  /** The reason, as the person wrote it. */
  reasonMd: string;
}

/** One history feed entry — a displayable revision, actor resolved. */
export interface ActivityEntryDto {
  /** The underlying revision id (also the page cursor). */
  id: string;
  workItemId: string;
  /**
   * The revision's audit verb. Widened to `string` (vs the closed
   * RevisionChangeKind union) on purpose: sibling stories add kinds (5.1.2's
   * `comment_deleted`), and an unknown kind must degrade to its diff-driven
   * parts, never crash the feed.
   */
  changeKind: string;
  /** ISO-8601. */
  changedAt: string;
  actor: { userId: string; name: string | null; image: string | null };
  /** Always ≥1 — a revision whose every diff key is suppressed is no entry. */
  parts: ActivityEntryPartDto[];
}

export type ActivityOrder = 'asc' | 'desc';

export interface ActivityListOptions {
  /** Resume after this revision id (the previous page's `nextCursor`). */
  cursor?: string;
  /** `desc` (newest first — the default) or `asc`. */
  order?: ActivityOrder;
}

/**
 * One entry of the **All** merged stream (Subtask 5.5.2) — the two sources
 * keep their NATIVE wire shapes under a discriminated `type` (the 5.5.3
 * design renders each in its own row grammar: conversation loud, telemetry
 * quiet). A comment entry is the 5.1 thread DTO whole — the root carries its
 * single-level replies, and the thread interleaves at the ROOT's timestamp; a
 * history entry is the 5.5.1 entry unchanged. A deleted comment appears
 * exactly once, as history (`commentDeleted` is a revision, not a comment);
 * live comments never duplicate into history — the verified
 * comment-adds-not-in-History rule holds by construction.
 */
export type ActivityAllEntryDto =
  | { type: 'comment'; thread: CommentThreadDTO }
  | { type: 'history'; entry: ActivityEntryDto };

/**
 * One page of the All stream: up to a page of entries merged from the two
 * cursor-paged sources in true timestamp order, plus the composite
 * continuation cursor (opaque — it carries BOTH sources' positions) and the
 * per-source totals the section header renders ("12 comments · 34 changes").
 */
export interface ActivityAllPageDto {
  entries: ActivityAllEntryDto[];
  /**
   * Opaque composite cursor for the next page, or null when both sources are
   * exhausted. Like the History read, a page may come back SHORT with a
   * non-null cursor when the bounded revision scan stopped early inside a
   * noise stretch — "Show more" just continues from it.
   */
  nextCursor: string | null;
  /** Every comment on the issue, replies included (the 5.1.2 count). */
  totalComments: number;
  /** Displayable revisions in the whole trail (the History count). */
  totalChanges: number;
  /**
   * Resolved `motir:` work-item references across THIS page's comment bodies
   * (Subtask 5.8.6) — the internal-link chips render against it, exactly as the
   * dedicated Comments tab does. Sourced from the nested `listComments` read, so
   * the All view never shows a struck-through (unresolved) reference.
   */
  workItemRefs: WorkItemRefMap;
}

/** One page of the History feed. */
export interface ActivityHistoryPageDto {
  entries: ActivityEntryDto[];
  /**
   * Cursor for the next page, or null when the trail is exhausted. May be
   * non-null with `entries.length < pageSize` when the bounded noise scan
   * stopped early — "Show more" just continues from it.
   */
  nextCursor: string | null;
  /** Displayable entries in the whole trail (suppressed-only rows excluded). */
  totalCount: number;
}
