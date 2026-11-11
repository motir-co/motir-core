import { Prisma, type Notification } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Notification repository — single Prisma operations on the `notification`
// table (Story 5.7 · Subtask 5.7.2). The persistence leaf the 5.7.3 fan-in job
// WRITES (a fan-out batch in one transaction) and the 5.7.4
// `notificationsService` READS (the cursor-paged feed + the cheap unread
// count). The SERVICE (5.7.4) is the authority: it owns transactions, the
// per-user scoping (a user reads/mutates only their OWN rows — cross-user
// access reads as 404, finding #44), DTO mapping, and typed errors. This leaf
// holds none of that.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx` (the fan-in `createMany` rides
// the job's transaction; mark-read/mark-all ride the service's). Pure read
// paths use the `db` singleton (optional `tx` for reads inside a transaction).
// No business logic, no transactions, no DTO mapping here.
//
// RLS: the table is workspace-gated (ENABLE + FORCE; see the migration), so the
// active-workspace GUC governs visibility for non-bypass roles. The per-user
// filter every read here applies (`recipientUserId`) is the application-layer
// scoping on TOP of that tenant gate.

/**
 * The READ-TIME entry filter (Story MOTIR-6169 · MOTIR-6549): a notification about
 * a work item is kept only while that item's project is one the reader can ENTER;
 * a workspace-level notification (no `workItemId`) is always kept. Undefined means
 * "no filter" — the write paths and the mark-all bulk update take none.
 */
function enterableFilter(
  enterableProjectIds: readonly string[] | undefined,
): Prisma.NotificationWhereInput {
  if (enterableProjectIds === undefined) return {};
  return {
    OR: [{ workItemId: null }, { workItem: { projectId: { in: [...enterableProjectIds] } } }],
  };
}

/** Options for the recipient feed read — cursor-paged, optionally per-tab. */
export interface ListByRecipientOptions {
  /** Page size (default 20 — the drawer's "newest 20 + Show more", finding #57). */
  take?: number;
  /** Resume strictly AFTER this notification id (the previous page's last row). */
  cursor?: string;
  /** Narrow to one drawer tab (`direct` | `watching`); omitted = both. */
  category?: Prisma.NotificationWhereInput['category'];
  /** Walk direction (default `desc` — newest first, the drawer order). */
  order?: 'asc' | 'desc';
  /** Keep only rows about projects the reader can enter (MOTIR-6549), filtered in SQL. */
  enterableProjectIds?: readonly string[];
}

export const notificationRepository = {
  /**
   * Fan-out insert — one row per recipient, in ONE transaction (the 5.7.3 job
   * writes a whole event's recipient batch atomically). Required `tx`.
   * `skipDuplicates` makes the write IDEMPOTENT against the
   * `(dedupe_key, recipient_user_id)` unique: a replayed/retried event (or an
   * overlapping comment-edit re-fire) silently no-ops the rows that already
   * exist instead of throwing. Empty-input guard: no rows to write → no DB
   * round-trip, return 0 (the createMany convention).
   */
  async createMany(
    data: Prisma.NotificationCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const result = await tx.notification.createMany({ data, skipDuplicates: true });
    return result.count;
  },

  /**
   * Which of `recipientUserIds` already hold a row under `dedupeKey` — the read a
   * fan-in makes BEFORE its insert, so the ids it reports as written are the ones
   * it actually wrote (MOTIR-10924). `createMany` answers a count and no ids, so
   * `skipDuplicates` alone cannot say who was new; it stays the guard against a
   * concurrent duplicate. Served by the `(dedupe_key, recipient_user_id)` unique.
   * Required `tx`: the caller reads and writes on one workspace binding.
   */
  async findRecipientIdsByDedupeKey(
    dedupeKey: string,
    recipientUserIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (recipientUserIds.length === 0) return [];
    const rows = await tx.notification.findMany({
      where: { dedupeKey, recipientUserId: { in: [...recipientUserIds] } },
      select: { recipientUserId: true },
    });
    return rows.map((r) => r.recipientUserId);
  },

  /**
   * One notification by id, or null. Read-only path → `db` singleton (the
   * service reads it to gate ownership before a mark-read write). Takes `tx`
   * when read inside a transaction.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Notification | null> {
    const client = tx ?? dbRead;
    return client.notification.findUnique({ where: { id } });
  },

  /**
   * One PAGE of a recipient's feed (the 5.7.4 read composes). Scoped to the
   * recipient, optionally narrowed to one drawer tab. NEVER a load-all
   * (finding #57): `take` caps the page, `cursor` (a notification id) resumes
   * strictly after the previous page's last row (`skip: 1`), and `order` flips
   * the walk — `desc` reads newest-first (the drawer's "newest page + Show
   * more" shape), `asc` oldest-first.
   *
   * `id` is the required secondary sort: `createdAt` alone is not a total order
   * (same-millisecond writes tie), and an unbroken tie makes cursor paging
   * skip/repeat rows at a page boundary (PRODECT_FINDINGS #38). Backed by the
   * (recipient_user_id, created_at) index. Read-only path → `db` singleton.
   */
  async listByRecipient(
    recipientUserId: string,
    options: ListByRecipientOptions = {},
    tx?: Prisma.TransactionClient,
  ): Promise<Notification[]> {
    const client = tx ?? dbRead;
    const { take = 20, cursor, category, order = 'desc', enterableProjectIds } = options;
    return client.notification.findMany({
      // The entry filter is IN the query, so a page stays full across a gap of
      // rows the reader may no longer see and the cursor walk never short-reads.
      where: {
        recipientUserId,
        ...(category ? { category } : {}),
        ...enterableFilter(enterableProjectIds),
      },
      orderBy: [{ createdAt: order }, { id: order }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * How many UNREAD notifications a recipient holds — omit `category` for the
   * GLOBAL total (the bell-badge aggregate), or pass `category: 'direct' |
   * 'watching'` for ONE drawer tab's unread count (the per-tab badge). Bug
   * 8.8.1: the Watching tab's count must be category-scoped, not the global
   * total — so this mirrors `countByRecipient`'s optional-`category` shape.
   * Backed by the PARTIAL index `notification_unread_idx` (`WHERE read_at IS
   * NULL`, raw SQL in the migration), so this is an index-only count over the
   * small hot set, never a seq scan as the table grows unbounded per active
   * user (finding #57). Read-only → `db` singleton.
   */
  async countUnreadByRecipient(
    recipientUserId: string,
    options: {
      category?: Prisma.NotificationWhereInput['category'];
      enterableProjectIds?: readonly string[];
    } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const { category, enterableProjectIds } = options;
    return client.notification.count({
      where: {
        recipientUserId,
        readAt: null,
        ...(category ? { category } : {}),
        ...enterableFilter(enterableProjectIds),
      },
    });
  },

  /**
   * How many notifications (read AND unread) a recipient holds — the drawer's
   * "N notifications" total, optionally narrowed to one tab (`direct` |
   * `watching`) so it matches the active filter (the 5.7.4
   * `listNotifications` page total). Distinct from `countUnreadByRecipient`,
   * which is the badge's unread-only aggregate. Read-only → `db` singleton.
   */
  async countByRecipient(
    recipientUserId: string,
    options: {
      category?: Prisma.NotificationWhereInput['category'];
      enterableProjectIds?: readonly string[];
    } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const { category, enterableProjectIds } = options;
    return client.notification.count({
      where: {
        recipientUserId,
        ...(category ? { category } : {}),
        ...enterableFilter(enterableProjectIds),
      },
    });
  },

  /**
   * Mark ONE notification read (sets `read_at`). Required `tx` — a mark-read
   * write rides the service transaction that also re-reads the fresh unread
   * count to return. The service gates ownership (reads `findById` first; a
   * row the caller doesn't own reads as 404, finding #44) and idempotency
   * (already-read is a service no-op) BEFORE calling this. Throws P2025 if the
   * id doesn't exist — belt-and-suspenders behind the service's own read.
   */
  async markRead(id: string, readAt: Date, tx: Prisma.TransactionClient): Promise<Notification> {
    return tx.notification.update({ where: { id }, data: { readAt } });
  },

  /**
   * Mark ALL of a recipient's unread notifications read in ONE bulk statement
   * (the "Mark all as read" action). A single `updateMany` over the unread set
   * — NOT a per-row client loop (the JRACLOUD-85017 anti-pattern Jira's own
   * mark-all shipped). Required `tx`. Returns the number of rows flipped.
   */
  async markAllReadByRecipient(
    recipientUserId: string,
    readAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.notification.updateMany({
      where: { recipientUserId, readAt: null },
      data: { readAt },
    });
    return result.count;
  },
};
