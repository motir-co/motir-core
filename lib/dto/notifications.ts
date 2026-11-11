import type { NotificationCategory } from '@/generated/prisma/client';

// Wire DTOs for the notifications domain (Story 5.7 · Subtask 5.7.4). The
// service maps Prisma rows to these via lib/mappers/notificationMappers.ts
// just before returning (CLAUDE.md — services never return raw Prisma
// models). Dates are ISO strings, matching the comments / work-items DTO
// convention.

/** The actor who caused a notification, as the feed row renders it (Avatar ·
 * name). Null when the notification has no actor (a system event) OR when the
 * actor user has since been deleted — the `actor` relation is
 * `onDelete: SetNull` (5.7.2), so "no actor" is a renderable state, not a bug. */
export interface NotificationActorDTO {
  id: string;
  name: string;
  image: string | null;
}

/**
 * The denormalized render payload captured at FAN-IN time (5.7.3 writes it;
 * 5.7.4 surfaces it) so the feed read is a single-table scan — no join storm
 * per row (Story 5.7 description; the 5.7.2 `data Json` column). The client
 * (5.7.5) composes the human sentence ("**Zhu Yue** mentioned you on
 * **PROD-42: …**") from `kind` + actor + these nouns.
 *
 * **This is the SINGLE source-of-truth contract for `Notification.data`** —
 * imported by BOTH the fan-in WRITER (`notificationFanInService`) and the read
 * MAPPER (`notificationMappers.toNotificationDto`). Subtask 5.7.9 collapsed the
 * two divergent definitions that had drifted: the writer stored
 * `workItemKey` / `workItemTitle`, this DTO declared `issueKey` / `title`, and
 * `toNotificationDto` passed `data` through with a blind `as` cast — so a
 * fanned-in row read back through the DTO exposed the producer keys verbatim and
 * `issueKey` / `title` came out `undefined`. One type now governs both ends, and
 * the mapper translates explicitly at the read boundary (no blind cast).
 *
 * A discriminated union on `kind`: the shape grows with the event types that
 * fan in via the registry seam — `mentioned` ships now (the 5.1.6 events); the
 * `transitioned` arm is the documented Story 5.4 slot (no producer yet, no
 * forward dep). `issueKey` is the deep-link target the drawer routes to
 * (`/items/[key]`, per `design/notifications/drawer.mock.html`).
 *
 * `page_mentioned` and `page_replied` (Story MOTIR-10868 · MOTIR-10922) are the
 * first arms whose subject is a PAGE. Their rows reuse the `mentioned` and
 * `commented` TYPES, so a person's existing preferences gate them, which leaves
 * the type unable to tell them from a work-item row: the KIND is the only field
 * that can, and every reader branches on it. The row's `workItemId` is null and
 * its `pageId` column carries the page.
 */
export type NotificationData =
  | NotificationMentionedData
  | NotificationTransitionedData
  | NotificationCodeAccessRefusedData
  | NotificationAgentHibernatedByAdminData
  | NotificationReviewToRunData
  | NotificationReviewSentBackData
  | NotificationPageMentionedData
  | NotificationPageRepliedData;

/** A mention — the SHIPPED 5.1.6 `work-item/mentioned` + `work-item/comment.created`
 * events. `source` selects the row copy (comment body vs item description);
 * `excerpt` is the plain-text body (mention tokens already rendered as @Name),
 * `null` when empty. */
export interface NotificationMentionedData {
  kind: 'mentioned';
  source: 'comment' | 'description';
  /** The deep-link target's issue key (e.g. `PROD-42`) — the row click target. */
  issueKey: string;
  /** The work item's title, for the summary line. */
  title: string;
  /** A plain-text comment/description excerpt, or `null` when there is none. */
  excerpt: string | null;
}

/** A status transition — the Story 5.4 `work-item/transitioned` fan-in slot (a
 * documented seam; no producer yet, no forward dep on 5.4 here). */
export interface NotificationTransitionedData {
  kind: 'transitioned';
  /** The deep-link target's issue key (e.g. `PROD-42`). */
  issueKey: string;
  /** The work item's title, for the summary line. */
  title: string;
  /** Status transition nouns. */
  fromStatus: string;
  toStatus: string;
}

/**
 * GitHub REFUSED a collaborator invitation (MOTIR-5016 · Story MOTIR-5010) — the
 * ONE access outcome with no other carrier, which is the whole rule for whether a
 * notification is owed. An invitation that SENDS is carried by GitHub's own email
 * to the account it names; an identity that was never connected is carried by the
 * plan review rail's `needs_access` outcome and by `/settings/project/code-access`.
 * A refusal has neither: no email left the building, and the user has private code
 * they cannot reach.
 *
 * ⚠️ THE FIRST ARM WHOSE SUBJECT IS A PROJECT, not a work item — `workItemId` is
 * null on these rows, so the drawer routes from the TYPE rather than from the
 * presence of an issue key.
 */
export interface NotificationCodeAccessRefusedData {
  kind: 'code_access_refused';
  /** The project the repository belongs to — the row's deep-link target. */
  projectKey: string;
  /** The project's display name, for the summary line. */
  projectName: string;
  /** The repository GitHub refused the invitation on, as `owner/name`. */
  repoRef: string;
}

/**
 * An organisation owner or admin HIBERNATED the recipient's agent (MOTIR-10368 ·
 * Story MOTIR-10363, `docs/decisions/agent-instances.md` §8 AMENDMENT 8). The
 * row's ACTOR is the admin, so who did it travels on `actorId`, not here. The row
 * deep-links nowhere: the drawer offers no route to an agent's panel or terminal.
 *
 * ⚠️ NAMES AND A TIME ONLY — never an organisation, account, shard, machine,
 * volume, region or provider id.
 */
export interface NotificationAgentHibernatedByAdminData {
  kind: 'agent_hibernated_by_admin';
  /** The agent's name, as its owner named it. */
  agentName: string;
  /** When it was hibernated, ISO-8601. */
  hibernatedAt: string;
}

/**
 * An agent SENT BACK the recipient's card (Story MOTIR-10327 · MOTIR-10338) — written once
 * per answering send-back verdict record, to the card's assignee. No actor: the agent did
 * it, not a person.
 */
export interface NotificationReviewSentBackData {
  kind: 'review_sent_back';
  /** The card sent back — the row's deep-link target. */
  issueKey: string;
  /** The card's title, for the summary line. */
  title: string;
  /** The verdict record — the deep link lands on its activity entry and findings. */
  recordId: string;
}

/**
 * A review waits for the routed person's OWN agent (Story MOTIR-10327 · MOTIR-10340) —
 * raised once per awaiting `agent_review` gate with the project's review source `own`. No
 * actor: nobody did this to the recipient.
 */
export interface NotificationReviewToRunData {
  kind: 'review_to_run';
  /** The card to review — the row's deep-link target. */
  issueKey: string;
  /** The card's title, for the summary line. */
  title: string;
  /** `motir review <KEY>` — the command the recipient runs in their own agent. */
  command: string;
}

/** Someone mentioned the recipient in a page comment or reply (Story MOTIR-10868).
 * `threadRootId` is the thread's root comment — the destination is the page with
 * the discussion panel at that thread. `pageTitle` is the page's own title,
 * verbatim, possibly `''`: the untitled fallback is applied when a surface
 * renders, in the reader's language, never stored. */
export interface NotificationPageMentionedData {
  kind: 'page_mentioned';
  pageId: string;
  pageTitle: string;
  projectKey: string;
  threadRootId: string;
  /** A plain-text comment excerpt (mention tokens as @Name), or `null` when empty. */
  excerpt: string | null;
}

/** Someone replied in a page thread the recipient started or replied in before
 * (Story MOTIR-10868). The same five fields as {@link NotificationPageMentionedData}. */
export interface NotificationPageRepliedData {
  kind: 'page_replied';
  pageId: string;
  pageTitle: string;
  projectKey: string;
  threadRootId: string;
  /** A plain-text reply excerpt (mention tokens as @Name), or `null` when empty. */
  excerpt: string | null;
}

/**
 * The arms whose subject is a WORK ITEM — the ones carrying `issueKey` and
 * `title`. Every arm did until MOTIR-5016 added `code_access_refused`, whose
 * subject is a PROJECT, so a reader that wants the deep-link key now has to say
 * which arms it means.
 *
 * ⚠️ EXPORTED AS A GUARD RATHER THAN LEFT TO EACH CALLER, because the alternative
 * is a cast at every site — and a cast is exactly what the 5.7.9 round-trip bug
 * was: a blind `as NotificationData` let `workItemKey`/`issueKey` drift apart and
 * come back `undefined`. A predicate narrows instead of asserting, so a future
 * arm that also lacks an issue key breaks the callers that must care and nothing
 * else.
 */
export function isWorkItemNotificationData(
  data: NotificationData,
): data is
  | NotificationMentionedData
  | NotificationTransitionedData
  | NotificationReviewToRunData
  | NotificationReviewSentBackData {
  return (
    data.kind === 'mentioned' ||
    data.kind === 'transitioned' ||
    data.kind === 'review_to_run' ||
    data.kind === 'review_sent_back'
  );
}

export interface NotificationDTO {
  id: string;
  /** The event-type discriminator (`mentioned` | `commented` | `assigned` |
   * `transitioned` | …) — the axis the 5.7.6 preference matrix keys on and the
   * client renders the summary verb from. */
  type: string;
  /** The drawer tab this row belongs to — `direct` (mentions / assignment /
   * reporter) vs `watching` (the 5.4 fan-in slot). */
  category: NotificationCategory;
  /** Who caused it (the row avatar), or null (system / deleted actor). */
  actor: NotificationActorDTO | null;
  /** The deep-link work item id, or null for a non-item notification. */
  workItemId: string | null;
  /** The denormalized nouns the row renders from (no per-row join). */
  data: NotificationData;
  /** Set on mark-read — drives the blue-dot (unread) vs greyed (read) treatment.
   * Null = unread. */
  readAt: string | null;
  createdAt: string;
}

/**
 * Per-drawer-tab unread counts (bug 8.8.1). The bell badge reads the GLOBAL
 * `unreadCount`; each Segmented tab (Direct · Watching) reads its OWN
 * category-scoped count from here, so the Watching tab shows the watching
 * unread total, not the global one. `unreadCount === unreadByCategory.direct +
 * unreadByCategory.watching` (the enum is exactly these two categories).
 */
export type UnreadByCategoryDTO = Record<NotificationCategory, number>;

/**
 * One cursor-paged window of a recipient's feed (finding #57 — never a
 * load-all). `unreadCount` is the cheap partial-index aggregate the bell badge
 * reads (the GLOBAL total across both tabs); `unreadByCategory` is the per-tab
 * breakdown each Segmented tab's badge reads (bug 8.8.1); `totalCount` is every
 * notification matching the current filter (the drawer's "N notifications");
 * `nextCursor` is the id to resume AFTER for the next (older) page, or null on
 * the last page.
 */
export interface NotificationsPageDTO {
  notifications: NotificationDTO[];
  totalCount: number;
  unreadCount: number;
  unreadByCategory: UnreadByCategoryDTO;
  nextCursor: string | null;
}

/** The bell-badge poll payload — just the cheap unread aggregate. */
export interface UnreadCountDTO {
  unreadCount: number;
}

/**
 * The mark-read mutation result. Carries the freshly-updated row AND the new
 * counts (the global `unreadCount` for the bell + the per-tab
 * `unreadByCategory` for the drawer tabs) so the caller updates the badge +
 * row from the RESPONSE, never a tree re-fetch (the
 * inline-edit-no-whole-tree-refresh contract).
 */
export interface MarkReadResultDTO {
  notification: NotificationDTO;
  unreadCount: number;
  unreadByCategory: UnreadByCategoryDTO;
}

/**
 * The mark-all-read result — the new global `unreadCount` (zero) + the per-tab
 * `unreadByCategory` breakdown (both zero) for the same reason.
 */
export interface MarkAllReadResultDTO {
  unreadCount: number;
  unreadByCategory: UnreadByCategoryDTO;
}
