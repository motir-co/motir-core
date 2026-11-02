import type { DeviceCode, Prisma } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for the `device_code` table (Story MOTIR-1863 · Subtasks MOTIR-1865 /
// MOTIR-1888) — the in-flight `motir login` grants. Single-op methods only; writes
// require `tx` (CLAUDE.md 4-layer split). All business logic — the five-state branch,
// the mint, the single-use delete — lives in `cliDeviceService`.
//
// The table has TWO writers: Better-Auth's `deviceAuthorization` plugin drives
// `status` / `userId` / `lastPolledAt` through its own adapter, and this repository
// owns Motir's columns plus every read the service branches on. That is not a
// layering violation — the plugin IS the framework boundary `lib/auth/index.ts`
// already documents — but it IS why the lock methods below exist: two independent
// writers on one row make every read-derived write here a racing one.
//
// No RLS on this table (identity-scoped — see the `DeviceCode` docstring), so no
// GUC-binding context is needed and no `withWorkspaceContext` wrapper is required.
//
// Nearly every method here takes `tx`, and not only the writes: each read in the CLI's
// flow guards a write in the same transaction, which is precisely the case CLAUDE.md
// says must take `tx` and read under `SELECT FOR UPDATE`. The ONE exception is
// `findByUserCodeForRead` — see its docstring for why a lock there would guard
// nothing.

export const deviceCodeRepository = {
  /**
   * Take the row's write lock by device code and hold it for the rest of the
   * transaction, so a concurrent poll on the same grant serializes behind it
   * instead of interleaving with the mint (`notes.html` #35). No row → nothing to
   * lock and the caller's re-read returns null, which is the right answer: an
   * unknown device code is `invalid_grant`, and no concurrent INSERT can create one
   * (codes are server-minted, never client-chosen).
   */
  async lockByDeviceCode(deviceCode: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "device_code" WHERE "device_code" = ${deviceCode} FOR UPDATE`;
  },

  /** The same lock, keyed by the human-typed user code — the approve path's guard. */
  async lockByUserCode(userCode: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "device_code" WHERE "user_code" = ${userCode} FOR UPDATE`;
  },

  /** Re-read INSIDE the transaction, after `lockByDeviceCode` — the state every
   * poll decision is computed from. Never read the row before the lock. */
  async findByDeviceCode(
    deviceCode: string,
    tx: Prisma.TransactionClient,
  ): Promise<DeviceCode | null> {
    return tx.deviceCode.findUnique({ where: { deviceCode } });
  },

  /** Re-read INSIDE the transaction, after `lockByUserCode`. */
  async findByUserCode(userCode: string, tx: Prisma.TransactionClient): Promise<DeviceCode | null> {
    return tx.deviceCode.findUnique({ where: { userCode } });
  },

  /**
   * The `/device` page's read (Subtask MOTIR-1888) — the one method here that takes no
   * `tx`, because it guards no write of ours: `describe` renders the row, it does not
   * compute a decision from it. CLAUDE.md's "read methods used only by read-only
   * service paths may use the `db` singleton" is exactly this case.
   *
   * A `FOR UPDATE` here would be worse than useless. The write in that flow — the
   * CLAIM — is performed by Better-Auth's adapter in its OWN transaction and has
   * already committed by the time this runs, so a lock could not make the pair atomic;
   * it would only hold a row lock across a request that never writes, adding
   * contention with the poll for nothing. The residual race is benign and handled by
   * the caller: a concurrent poll can reap the row between the claim and this read, and
   * `null` then means "the grant is gone", which is an honest 404.
   */
  async findByUserCodeForRead(
    userCode: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DeviceCode | null> {
    const client = tx ?? dbRead;
    return client.deviceCode.findUnique({ where: { userCode } });
  },

  /** Record the CLI-reported hostname on a freshly created grant. */
  async setHostname(
    id: string,
    hostname: string,
    tx: Prisma.TransactionClient,
  ): Promise<DeviceCode> {
    return tx.deviceCode.update({ where: { id }, data: { hostname } });
  },

  /** Record the CLI token this grant UPDATES (`motir auth refresh`, MOTIR-10189).
   * Written at start, inside the same transaction as the hostname, from the
   * token the presented bearer secret resolved to. */
  async setUpdateToken(
    id: string,
    updateTokenId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DeviceCode> {
    return tx.deviceCode.update({ where: { id }, data: { updateTokenId } });
  },

  /** Record the workspace the approver chose. Written BEFORE the plugin flips the
   * status, so a poll that sees `approved` always has somewhere to mint. */
  async setWorkspaceBinding(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DeviceCode> {
    return tx.deviceCode.update({ where: { id }, data: { workspaceId } });
  },

  /** Stamp the poll clock — the input to the next poll's `slow_down` check. */
  async touchLastPolled(id: string, at: Date, tx: Prisma.TransactionClient): Promise<DeviceCode> {
    return tx.deviceCode.update({ where: { id }, data: { lastPolledAt: at } });
  },

  /** Consume the grant. This delete IS the single-use guard: it happens under the
   * row lock, so the winner of a two-poll race deletes and every later poll finds
   * nothing. Also how a denied / expired grant is reaped. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.deviceCode.delete({ where: { id } });
  },

  /**
   * Drop every in-flight `motir login` grant this user has claimed — the
   * erasure sweep's DELETE group (MOTIR-3702). A claimed-but-unapproved grant
   * is a live credential in the making, and an erased account must not be able
   * to finish one.
   */
  async deleteAllForUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.deviceCode.deleteMany({ where: { userId } });
    return count;
  },
};
