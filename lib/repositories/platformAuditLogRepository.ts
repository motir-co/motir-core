import {
  Prisma,
  type PlatformAuditLog,
  type PlatformAuditTargetKind,
} from '@/generated/prisma/client';

/** The append's input — the generated type, named here so callers above never spell it. */
export type PlatformAuditLogCreateInput = Prisma.PlatformAuditLogCreateInput;

/** A row with its actor's display fields, as `search` returns it. */
export type PlatformAuditLogWithActor = Prisma.PlatformAuditLogGetPayload<{
  include: { actor: { select: { name: true; email: true } } };
}>;

/** `search`'s filters. Every member optional; they AND together. */
export interface PlatformAuditLogSearchFilters {
  actorUserId?: string | null;
  organizationId?: string | null;
  /** One exact action. Wins over `excludeActions`. */
  action?: string | null;
  /** Actions to leave out — the service passes the READ verbs for "Writes". */
  excludeActions?: readonly string[] | null;
  /** Inclusive lower bound on `createdAt`. */
  createdFrom?: Date | null;
  /** EXCLUSIVE upper bound on `createdAt`. */
  createdTo?: Date | null;
  /** Free text over the reason and the target (label substring, or exact id). */
  text?: string | null;
}

/**
 * The platform audit trail — `docs/decisions/platform-staff-auth.md` §3b.
 *
 * ⚠️ APPEND-ONLY, and this file is what makes that true. The table's RLS policy
 * is `FOR ALL` (the four-verb totality guard requires every verb to be covered,
 * and under the non-bypass role an uncovered verb is a CLOSED door rather than
 * an open one — notes.html #248), so the DATABASE does not forbid an UPDATE or
 * a DELETE under a platform context. What forbids them is that this repository
 * exposes `create` and reads and no mutator, and there is no second path to the
 * table. Do NOT add `update`, `delete` or `deleteMany` here: an audit row that
 * can be edited answers "who touched this tenant?" the way the person who
 * touched it would prefer.
 *
 * TAMPER-EVIDENT since MOTIR-751. Every row is a link in a SHA-256 chain
 * (`seq` / `prevHash` / `entryHash` — `lib/platform/auditChain.ts`), so an edit
 * or a deletion that does get past this surface — a hand-run UPDATE, a restored
 * backup with a row changed — is DETECTED by `platformAuditService.verifyChain`
 * at the first entry it affects. Append-only is still enforced HERE; the chain
 * is what makes a breach of it visible rather than silent. The two reads at the
 * top of this object (`lockChainHead`, `findChainHead`) exist for the append
 * path in `withPlatformRead` and nothing else.
 *
 * Every method takes `tx` as a REQUIRED parameter, reads included, which is one
 * step stricter than `CLAUDE.md`'s read-method rule allows. The reason is the
 * policy: the only thing that admits a row is `app.platform_staff`, and the
 * only thing that binds it is `withPlatformRead` (`lib/platform/context.ts`).
 * A read issued on the `db` singleton would return ZERO ROWS AND RAISE NOTHING
 * — the exact silent-denial shape MOTIR-2880 recorded for `withSystemContext`.
 * Requiring `tx` makes that a compile-time error instead.
 */
export const platformAuditLogRepository = {
  /**
   * Take the CHAIN LOCK — a transaction-scoped advisory lock on one fixed key.
   *
   * The chain head is a read-derived write (the next row's `seq` and `prevHash`
   * come from the current head), so two appends that read the head without
   * this lock would both chain to it and FORK the log. A `SELECT … FOR UPDATE`
   * on the head row cannot replace it: there is no row to lock on an empty
   * table, and a waiter woken by the holder's commit still returns the OLD head
   * row (it was not deleted), which is the fork again. The advisory lock is
   * released at COMMIT / ROLLBACK, i.e. after the appended row is visible to
   * the next waiter — and it is per-database, so the per-worker test databases
   * do not contend with each other.
   */
  async lockChainHead(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('platform-audit-chain', 0))`;
  },

  /** The newest link — the row the next append chains to. `null` on an empty log. */
  async findChainHead(
    tx: Prisma.TransactionClient,
  ): Promise<{ seq: number; entryHash: string } | null> {
    return tx.platformAuditLog.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true, entryHash: true },
    });
  },

  /**
   * Append one row. The ONLY write this table has.
   *
   * Called by `withPlatformRead` as the FIRST write inside the platform
   * transaction, before the work it audits runs — so a read that rolls back
   * leaves no row, and a read that commits cannot exist without one. The
   * caller supplies `seq`, `prevHash`, `entryHash` and `createdAt`, computed
   * under `lockChainHead`.
   */
  async create(
    data: PlatformAuditLogCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog> {
    return tx.platformAuditLog.create({ data });
  },

  /** One entry by its chain position. */
  async findBySeq(seq: number, tx: Prisma.TransactionClient): Promise<PlatformAuditLog | null> {
    return tx.platformAuditLog.findUnique({ where: { seq } });
  },

  /**
   * One BATCH of the chain, ascending, for the verifier: `seq > afterSeq` and
   * `seq <= throughSeq`, at most `limit` rows. Keyset on the unique `seq`
   * index, so the verifier walks any length of log in bounded pages.
   */
  async listChainBatch(
    afterSeq: number,
    throughSeq: number | null,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { seq: { gt: afterSeq, ...(throughSeq === null ? {} : { lte: throughSeq }) } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
  },

  /** How many entries lie strictly after `seq` (up to `throughSeq`) — "and the N after it". */
  async countAfterSeq(
    seq: number,
    throughSeq: number | null,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.platformAuditLog.count({
      where: { seq: { gt: seq, ...(throughSeq === null ? {} : { lte: throughSeq }) } },
    });
  },

  /**
   * The audit-log SEARCH (MOTIR-751; the page is MOTIR-752), newest first,
   * keyset-paged on `seq` — `beforeSeq` is the last entry of the previous page.
   * Each filter is optional and they AND together. The actor's name and email
   * ride along for the operator column.
   *
   * Vocabulary-agnostic on purpose, like `listByTarget`: "writes only" arrives
   * as `excludeActions` (the READ verbs), because which verbs are reads is
   * `PLATFORM_AUDIT_ACTIONS`' knowledge, not the table's.
   */
  async search(
    filters: PlatformAuditLogSearchFilters,
    beforeSeq: number | null,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLogWithActor[]> {
    const text = filters.text?.trim();
    return tx.platformAuditLog.findMany({
      where: {
        ...(beforeSeq === null ? {} : { seq: { lt: beforeSeq } }),
        ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
        ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
        ...(filters.action
          ? { action: filters.action }
          : filters.excludeActions && filters.excludeActions.length > 0
            ? { action: { notIn: [...filters.excludeActions] } }
            : {}),
        ...(filters.createdFrom || filters.createdTo
          ? {
              createdAt: {
                ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
                ...(filters.createdTo ? { lt: filters.createdTo } : {}),
              },
            }
          : {}),
        ...(text
          ? {
              OR: [
                { reason: { contains: text, mode: 'insensitive' } },
                { targetLabel: { contains: text, mode: 'insensitive' } },
                { targetId: text },
              ],
            }
          : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit,
      include: { actor: { select: { name: true, email: true } } },
    });
  },

  /**
   * The most recent rows for one actor, newest first. Served by the
   * `(actor_user_id, created_at)` index.
   *
   * Predates the audit-log viewer (whose read is `search`, above — MOTIR-751);
   * it exists so the write path can be asserted end-to-end and so a consumer
   * has a seam to build on rather than reaching for `tx.platformAuditLog`.
   */
  async listByActor(
    actorUserId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { actorUserId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * The most recent rows for ONE TARGET, newest first (MOTIR-1167).
   *
   * Panel 9's "Support actions" log — *"every operator write on this account,
   * newest first, append-only"*. Served by the `(target_kind, target_id,
   * created_at)` index.
   *
   * ⚠️ IT RETURNS READS AS WELL AS WRITES, and the SERVICE decides what the card
   * shows. Keeping the filter out of the repository is the single-op rule doing
   * its job: "which actions count as a write" is the audit vocabulary's
   * knowledge (`PLATFORM_AUDIT_ACTIONS`), not the table's, and a repository that
   * encoded it would have to be edited every time a consumer adds a verb.
   */
  async listByTarget(
    targetKind: PlatformAuditTargetKind,
    targetId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { targetKind, targetId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * The NEWEST row of one action on one target, with the actor's email, or null
   * (MOTIR-7320 — the Fleet card's last `fleet.stop`). Served by the
   * `(target_kind, target_id, created_at)` index; the action filter runs over
   * that one target's rows only.
   */
  async findLatestByTargetAndAction(
    targetKind: PlatformAuditTargetKind,
    targetId: string,
    action: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLogWithActor | null> {
    return tx.platformAuditLog.findFirst({
      where: { targetKind, targetId, action },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { name: true, email: true } } },
    });
  },

  /**
   * Every row of one action on any of `targetIds`, newest first, with the
   * actor's email — the starter library's retirements, one page of entries at a
   * time (MOTIR-712). The caller keeps the newest per target.
   */
  async listByTargetsAndAction(
    targetKind: PlatformAuditTargetKind,
    targetIds: string[],
    action: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLogWithActor[]> {
    return tx.platformAuditLog.findMany({
      where: { targetKind, targetId: { in: targetIds }, action },
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { name: true, email: true } } },
    });
  },

  /** The most recent rows for one organization, newest first. */
  async listByOrganization(
    organizationId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};
