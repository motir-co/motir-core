import type { $Enums } from '@/generated/prisma/client';

// Notification-preference domain constants (Story 5.7 · Subtask 5.7.6).
//
// The per-user × EVENT-TYPE × CHANNEL preference matrix is the single CHANNEL
// GATE consulted by BOTH the 5.7.3 in-app fan-in job (`in_app`) AND the DONE
// 5.1.6 email job (`email`). This module is the one source of truth for:
//   * the closed CHANNEL set;
//   * the event-type rows the settings matrix renders (and whether each is
//     SETTABLE — the `settable: false` mechanism stays for any FUTURE
//     "drawn disabled until Story X ships" seam, though no row needs it today);
//   * the DEFAULT for an UNSET (event, channel) cell — the resolver supplies
//     it, so an untouched user has ZERO rows yet still gets the documented
//     behaviour (direct/mention events ON for both channels). An unset row is
//     NOT "off".
//
// Prisma-free of the client (only the generated `$Enums` type), so routes,
// services, AND client components can import it.

/** The closed delivery-channel set — tied to the Prisma enum so the two never
 * drift. `email` = the DONE 5.1.6 job; `in_app` = the 5.7.3 bell feed. */
export type NotificationChannel = $Enums.NotificationChannel;

export const NOTIFICATION_CHANNELS = [
  'email',
  'in_app',
] as const satisfies readonly NotificationChannel[];

/** The notification EVENT-TYPE discriminators — the SAME open axis as
 * `Notification.type` (a string, not an enum), so Story 5.4 (`transitioned`)
 * and Story 6.6 (`created` / `field.changed`) extend it with no migration. */
export const NOTIFICATION_EVENT_TYPE = {
  mentioned: 'mentioned',
  commented: 'commented',
  assigned: 'assigned',
  transitioned: 'transitioned',
  /** GitHub REFUSED a collaborator invitation (MOTIR-5016 · Story MOTIR-5010).
   *  The first type whose subject is a PROJECT rather than a work item. */
  codeAccessRefused: 'code_access_refused',
  /** A review waits for the routed person's OWN agent (Story MOTIR-10327 · MOTIR-10340;
   *  `approval-gates.md` §12.1, §12.10). Actorless; one row per awaiting review gate. */
  reviewToRun: 'review_to_run',
  /** An agent SENT BACK the recipient's card (Story MOTIR-10327 · MOTIR-10338;
   *  `approval-gates.md` §12.16). Actorless; one row per send-back verdict record. */
  reviewSentBack: 'review_sent_back',
} as const;

export interface NotificationPreferenceEventTypeMeta {
  /** The discriminator stored on `NotificationPreference.eventType`. */
  readonly type: string;
  /** `false` ⇒ drawn DISABLED in the matrix and REJECTED on write — a
   * documented future seam ("available once Story X ships"), not yet active.
   * Every CURRENT row is settable; this flag is kept as the mechanism a future
   * not-yet-shipped event type would use (the 5.4 `transitioned` seam used it
   * until both its channels became real — 5.7.10 in-app + 5.7.11 email). */
  readonly settable: boolean;
  /** The default for an UNSET row, per channel (the resolver supplies it). */
  readonly defaults: Readonly<Record<NotificationChannel, boolean>>;
}

/** The event-type rows, in matrix display order. All default ON for both
 * channels (the Jira personal-notification-settings shape + the design's
 * annotated default). `transitioned` (Story 5.4 — shipped) is fanned in by
 * 5.7.10 (in_app) + 5.4.5/5.7.11 (email), gated by the user's
 * transitioned·{channel} cell — so it is settable like the other three. */
export const NOTIFICATION_PREFERENCE_EVENT_TYPES: readonly NotificationPreferenceEventTypeMeta[] = [
  {
    type: NOTIFICATION_EVENT_TYPE.mentioned,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  {
    type: NOTIFICATION_EVENT_TYPE.commented,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  {
    type: NOTIFICATION_EVENT_TYPE.assigned,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  // Story 5.4 (issue-watching) — SHIPPED. Watcher transition events are fanned
  // in by 5.7.10 (in_app) + 5.4.5/5.7.11 (email), gated by this row's cells.
  {
    type: NOTIFICATION_EVENT_TYPE.transitioned,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  // ⚠️ LAST, and appended rather than sorted in: the matrix renders this array in
  // order, so the four rows above keep the positions users have learned
  // (`design/notifications/design-notes.md`, the ACCESS-REFUSED row).
  //
  // ⚠️ EMAIL ON IS A DECISION, NOT AN OVERSIGHT. This event exists precisely
  // because GITHUB's invitation email never left the building; Motir's own
  // notification email is a second, INDEPENDENT carrier, and defaulting it off
  // would re-create by default the silence the row was added to end. It stays the
  // user's to turn off.
  {
    type: NOTIFICATION_EVENT_TYPE.codeAccessRefused,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  // APPENDED, for the reason above. Nothing starts a review with the source `own`, so this
  // row is the one thing that tells the routed person a review is theirs to run.
  {
    type: NOTIFICATION_EVENT_TYPE.reviewToRun,
    settable: true,
    defaults: { email: true, in_app: true },
  },
  // APPENDED, for the same reason. An agent's send-back moves the card to To fix and asks
  // nobody to approve it, so the assignee is the one person who must hear of it.
  {
    type: NOTIFICATION_EVENT_TYPE.reviewSentBack,
    settable: true,
    defaults: { email: true, in_app: true },
  },
];

/** True iff `value` is one of the closed delivery channels. */
export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return value === 'email' || value === 'in_app';
}

/** The meta for an event type, or `undefined` when the type is unmodelled. */
export function findNotificationEventTypeMeta(
  eventType: string,
): NotificationPreferenceEventTypeMeta | undefined {
  return NOTIFICATION_PREFERENCE_EVENT_TYPES.find((m) => m.type === eventType);
}

/** The documented default for an UNSET (event, channel) cell. An UNMODELLED
 * event type defaults to ENABLED — the gate never silently suppresses an event
 * Motir has not yet given the user a preference for (fail-open: notify). */
export function defaultChannelEnabled(eventType: string, channel: NotificationChannel): boolean {
  return findNotificationEventTypeMeta(eventType)?.defaults[channel] ?? true;
}
