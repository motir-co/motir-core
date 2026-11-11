import type { Notification, User } from '@/generated/prisma/client';
import type {
  NotificationActorDTO,
  NotificationData,
  NotificationDTO,
} from '@/lib/dto/notifications';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';

// Prisma → DTO converters for the notifications domain (Story 5.7 · Subtask
// 5.7.4). The service batches the actor lookup — ONE user read per page (no
// N+1) — and hands the bucket in; the mapper is pure shaping.

/**
 * Resolve a notification's actor from the batched user read. Unlike the
 * comment author (`onDelete: Restrict`, always present), the notification
 * `actor` relation is `onDelete: SetNull` (5.7.2) and `actorId` is nullable, so
 * a null `actorId` (a system notification) OR a deleted actor (id present in
 * the row but absent from the batch because the user is gone) both resolve to
 * `null` — a renderable "no actor" state, never a thrown error.
 */
function actorFor(row: Notification, actorsById: Map<string, User>): NotificationActorDTO | null {
  if (!row.actorId) return null;
  const user = actorsById.get(row.actorId);
  if (!user) return null;
  return { id: user.id, name: user.name, image: storedAssetUrl(user.image) };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Translate the stored `Notification.data` JSON into the typed
 * `NotificationData` union at the READ boundary (Subtask 5.7.9). The fan-in
 * (5.7.3) writes this exact shape via the SAME `@/lib/dto/notifications`
 * contract, so the reader and writer cannot drift — but the column is `Json`, so
 * this reads the known keys EXPLICITLY by `kind` rather than blind-casting the
 * raw value (the blind `as NotificationData` cast is what let the old
 * `workItemKey`/`workItemTitle` ↔ `issueKey`/`title` mismatch ship unnoticed).
 * A null / malformed payload degrades to an empty `mentioned` shape rather than
 * crashing the feed read.
 */
function toNotificationData(raw: Notification['data']): NotificationData {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (d.kind === 'code_access_refused') {
    return {
      kind: 'code_access_refused',
      projectKey: str(d.projectKey),
      projectName: str(d.projectName),
      repoRef: str(d.repoRef),
    };
  }
  if (d.kind === 'agent_hibernated_by_admin') {
    return {
      kind: 'agent_hibernated_by_admin',
      agentName: str(d.agentName),
      hibernatedAt: str(d.hibernatedAt),
    };
  }
  if (d.kind === 'review_sent_back') {
    return {
      kind: 'review_sent_back',
      issueKey: str(d.issueKey),
      title: str(d.title),
      recordId: str(d.recordId),
    };
  }
  if (d.kind === 'review_to_run') {
    return {
      kind: 'review_to_run',
      issueKey: str(d.issueKey),
      title: str(d.title),
      command: str(d.command),
    };
  }
  // The page arms (MOTIR-10922) — matched BEFORE the mention fallback below,
  // which would otherwise turn them into a work-item mention with an empty key
  // and no destination.
  if (d.kind === 'page_mentioned' || d.kind === 'page_replied') {
    return {
      kind: d.kind,
      pageId: str(d.pageId),
      pageTitle: str(d.pageTitle),
      projectKey: str(d.projectKey),
      threadRootId: str(d.threadRootId),
      excerpt: typeof d.excerpt === 'string' ? d.excerpt : null,
    };
  }
  if (d.kind === 'transitioned') {
    return {
      kind: 'transitioned',
      issueKey: str(d.issueKey),
      title: str(d.title),
      fromStatus: str(d.fromStatus),
      toStatus: str(d.toStatus),
    };
  }
  return {
    kind: 'mentioned',
    source: d.source === 'description' ? 'description' : 'comment',
    issueKey: str(d.issueKey),
    title: str(d.title),
    excerpt: typeof d.excerpt === 'string' ? d.excerpt : null,
  };
}

export function toNotificationDto(
  row: Notification,
  actorsById: Map<string, User>,
): NotificationDTO {
  return {
    id: row.id,
    type: row.type,
    category: row.category,
    actor: actorFor(row, actorsById),
    workItemId: row.workItemId,
    data: toNotificationData(row.data),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
