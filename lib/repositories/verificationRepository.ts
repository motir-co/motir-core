import { Prisma, type Verification } from '@/generated/prisma/client';
import { db } from '@/lib/db';

// Verification repository — Better-Auth's catch-all token table
// (identifier + value + expiresAt). Used by both password-reset (via
// Better-Auth internals) and our own invite flow (`workspace-invite:`
// prefix on identifier).

/**
 * The `identifier` prefix Better-Auth's two-factor plugin writes a trusted-device
 * grant under (`plugins/two-factor/verify-two-factor.mjs`). Declared here because
 * this repository is the only thing that keys on it; it is the PLUGIN's literal,
 * so a Better-Auth upgrade that changed it would silently empty the list — which
 * is what `tests/twoFactorTrustedDevices.test.ts` writes a real row to catch.
 */
export const TRUST_DEVICE_PREFIX = 'trust-device-';

export const verificationRepository = {
  async findByIdentifier(identifier: string): Promise<Verification | null> {
    return db.verification.findFirst({ where: { identifier } });
  },

  /**
   * Count rows whose identifier starts with `identifierPrefix`, whose
   * `value` contains every entry in `valueContainsAll`, and whose
   * createdAt is >= `since`. Used by the invites service's rate-limit
   * gate: prefix narrows to invite tokens (via the existing
   * `@@index([identifier])`), the value substrings constrain to a
   * specific (workspaceId, email) pair, and the time window bounds the
   * scan.
   */
  async countByIdentifierPrefixAndValueAndSince(args: {
    identifierPrefix: string;
    valueContainsAll: string[];
    since: Date;
  }): Promise<number> {
    return db.verification.count({
      where: {
        identifier: { startsWith: args.identifierPrefix },
        createdAt: { gte: args.since },
        AND: args.valueContainsAll.map((substr) => ({ value: { contains: substr } })),
      },
    });
  },

  /**
   * Unexpired rows whose identifier starts with `identifierPrefix` and whose
   * `value` contains `valueContains`, newest first, at most `limit` (MOTIR-9995).
   * The invites service's pending list: the prefix narrows to invite tokens, the
   * value substring to one workspace. The substring is only a NARROWING — the
   * caller parses each payload and compares the workspace id before trusting a
   * row. An accepted invite's row is deleted and a retired one is back-dated, so
   * neither is returned.
   */
  async listPendingByIdentifierPrefixAndValue(args: {
    identifierPrefix: string;
    valueContains: string;
    now: Date;
    limit: number;
  }): Promise<Verification[]> {
    return db.verification.findMany({
      where: {
        identifier: { startsWith: args.identifierPrefix },
        expiresAt: { gt: args.now },
        value: { contains: args.valueContains },
      },
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });
  },

  async create(
    data: { identifier: string; value: string; expiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<Verification> {
    return tx.verification.create({ data });
  },

  /**
   * Returns the number of rows deleted. The invite-accept flow uses
   * this inside a $transaction so the deletion is atomic with the
   * membership insert.
   */
  /**
   * Every live TRUSTED-DEVICE grant for a user (Story 8.11 · Subtask
   * MOTIR-1221), newest first.
   *
   * A trusted device is not a table — it is a row HERE, written by
   * Better-Auth's two-factor plugin when a reader ticks "don't ask again":
   * `identifier` is `trust-device-<32 random chars>`, `value` is the user id,
   * and `expiresAt` is the 30-day horizon (`verify-two-factor.mjs`). So the
   * pairing below is the whole query — the prefix says WHAT kind of grant, the
   * value says WHOSE.
   *
   * ⚠️ IT CARRIES NO DEVICE IDENTITY, and that is a property of the row rather
   * than of this read: no user-agent, no IP, no label. A surface listing these
   * can honestly say WHEN a device was trusted and when the trust lapses, and
   * cannot say which browser it was.
   *
   * Expired rows are excluded rather than shown greyed: an expired grant already
   * fails the cookie check, so listing it would offer a reader a revoke that
   * changes nothing.
   *
   * Read-only path, so the `db` singleton and no `tx`.
   */
  async findTrustedDevicesByUserId(userId: string): Promise<Verification[]> {
    return db.verification.findMany({
      where: {
        identifier: { startsWith: TRUST_DEVICE_PREFIX },
        value: userId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Delete ONE trusted-device grant, scoped to its owner.
   *
   * ⚠️ `value: userId` IS THE AUTHORIZATION, not a convenience filter. The `id`
   * comes from a request body, and `verification` holds every kind of token this
   * product mints — password resets, email-change confirmations, other people's
   * device grants. A delete keyed on `id` alone would let any signed-in user
   * revoke any row in the table by guessing a cuid. Pairing the id with the
   * owner AND the prefix means a mismatched request deletes nothing and reports
   * zero, which is what the route turns into a 404.
   *
   * Write → `tx` required.
   */
  async deleteTrustedDeviceForUser(
    id: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.verification.deleteMany({
      where: { id, value: userId, identifier: { startsWith: TRUST_DEVICE_PREFIX } },
    });
    return result.count;
  },

  /** Drop EVERY trusted-device grant a user holds. Write → `tx` required. */
  async deleteTrustedDevicesForUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.verification.deleteMany({
      where: { value: userId, identifier: { startsWith: TRUST_DEVICE_PREFIX } },
    });
    return result.count;
  },

  /**
   * Delete up to `limit` OAuth authorization codes past their expiry — the OAuth
   * sweep (MOTIR-6984). `@better-auth/oauth-provider` keeps a code here for its
   * ten-minute life, as a row whose `value` is JSON opening with
   * `{"type":"authorization_code"`, and deletes it only when it is redeemed, so
   * an abandoned authorization leaves it behind. Matched on that prefix alone, so
   * no other kind of verification row is ever touched. One bounded statement.
   */
  async deleteExpiredAuthorizationCodes(
    before: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      DELETE FROM "verification"
       WHERE "id" IN (
         SELECT "id" FROM "verification"
          WHERE "expiresAt" < ${before}
            AND "value" LIKE '{"type":"authorization_code"%'
          LIMIT ${limit}
       )`;
  },

  async deleteByIdentifier(identifier: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.verification.deleteMany({ where: { identifier } });
    return result.count;
  },

  /**
   * Back-dates a row's `expiresAt` — only used by tests to simulate
   * "user clicked the link after expiry" without sleeping. Production
   * code never calls this.
   */
  async updateExpiresAt(
    identifier: string,
    expiresAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.verification.updateMany({
      where: { identifier },
      data: { expiresAt },
    });
    return result.count;
  },
};
