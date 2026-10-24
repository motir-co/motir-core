import type {
  FleetShard,
  FleetShardPauseReason,
  FleetShardRole,
  FleetShardState,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Data access for the FLEET ACCOUNT RECORD (Story MOTIR-8953 · MOTIR-8961) —
// one row per account of one fleet kind's pool. The table's policy is
// `app.system_admin` only, so the caller holds a `withSystemContext` transaction.

export type FleetShardCreateInput = Prisma.FleetShardUncheckedCreateInput;

/** The four limit columns, as one write. */
export interface FleetShardLimits {
  vcpuQuota: number | null;
  machineLimit: number | null;
  githubRegistrationsPer5Min: number | null;
  githubApiPerHour: number | null;
}

export const fleetShardRepository = {
  async create(data: FleetShardCreateInput, tx: Prisma.TransactionClient): Promise<FleetShard> {
    return tx.fleetShard.create({ data });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<FleetShard | null> {
    const client = tx ?? dbRead;
    return client.fleetShard.findUnique({ where: { id } });
  },

  async findByName(name: string, tx?: Prisma.TransactionClient): Promise<FleetShard | null> {
    const client = tx ?? dbRead;
    return client.fleetShard.findUnique({ where: { name } });
  },

  /** One role's accounts (`null`: every role), optionally of one kind and in one
   *  state — oldest first. */
  async listByRole(
    role: FleetShardRole | null,
    filter: { fleetKind?: string; state?: FleetShardState },
    tx?: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    const client = tx ?? dbRead;
    return client.fleetShard.findMany({
      where: {
        ...(role !== null ? { role } : {}),
        ...(filter.fleetKind !== undefined ? { fleetKind: filter.fleetKind } : {}),
        ...(filter.state !== undefined ? { state: filter.state } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  async updateLimits(
    id: string,
    limits: FleetShardLimits,
    source: Prisma.InputJsonValue,
    verifiedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({
      where: { id },
      data: { ...limits, limitsSource: source, limitsVerifiedAt: verifiedAt },
    });
  },

  async updateState(
    id: string,
    state: FleetShardState,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({ where: { id }, data: { state } });
  },

  /** Move an account between the shared pool and the kind's spare (MOTIR-9456) —
   *  the growth job's promotion is `setRoleInTx(spare, 'primary')`. */
  async setRoleInTx(
    id: string,
    role: FleetShardRole,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({ where: { id }, data: { role } });
  },

  /** The ACTIVE accounts of one fleet kind in the given roles, with their pause
   *  and override columns — admission's candidates (MOTIR-8968). `primary` alone
   *  is the shared pool; a Motir exempt org's job adds `spare` (MOTIR-9456). Read
   *  uncached on every admission, so an override, a pause or a promotion takes
   *  effect on the next job. */
  async listActiveForKindInTx(
    fleetKind: string,
    roles: readonly FleetShardRole[],
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    return tx.fleetShard.findMany({
      where: { fleetKind, role: { in: [...roles] }, state: 'active' },
      orderBy: { id: 'asc' },
    });
  },

  /** A kind's non-disabled spares, the ready (`active`) one first, then oldest
   *  first (MOTIR-9456). At most one is `active` (the partial unique index). */
  async listSparesForKind(fleetKind: string, tx?: Prisma.TransactionClient): Promise<FleetShard[]> {
    const client = tx ?? dbRead;
    return client.fleetShard.findMany({
      where: { fleetKind, role: 'spare', state: { not: 'disabled' } },
      // The enum is declared provisioning, active, disabled: descending puts
      // `active` before `provisioning`.
      orderBy: [{ state: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Lock one account by name for a platform admin's change (MOTIR-8972), so two
   *  changes of one account apply one after the other. Null when none has it. */
  async lockByNameForUpdateInTx(
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "fleet_shard" WHERE "name" = ${name} FOR UPDATE`;
    const id = rows[0]?.id;
    return id ? tx.fleetShard.findUnique({ where: { id } }) : null;
  },

  /** The platform admin's admission ceiling (MOTIR-8972); null returns the
   *  account to its derived ceiling. */
  async setAdmissionCeilingOverrideInTx(
    id: string,
    ceiling: number | null,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({ where: { id }, data: { admissionCeilingOverride: ceiling } });
  },

  /** Skip this account in admission until `until` (MOTIR-8968). */
  async pauseInTx(
    id: string,
    until: Date,
    reason: FleetShardPauseReason,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.fleetShard.update({
      where: { id },
      data: { admissionPausedUntil: until, admissionPausedReason: reason },
    });
  },

  /**
   * Lock and return the ACTIVE accounts that name a GitHub org, of every fleet
   * kind, in id order (MOTIR-8966) — the GitHub orgs a tenant may be hosted in.
   * `FOR UPDATE` because the per-org tenant count read after it is
   * read-derived; id order so two assignments cannot deadlock.
   */
  async lockActiveWithGithubOrgInTx(tx: Prisma.TransactionClient): Promise<FleetShard[]> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "fleet_shard"
       WHERE "state" = 'active' AND btrim("github_org") <> ''
       ORDER BY "id"
       FOR UPDATE
    `;
    if (locked.length === 0) return [];
    return tx.fleetShard.findMany({
      where: { id: { in: locked.map((row) => row.id) } },
      orderBy: { id: 'asc' },
    });
  },

  /** Every account row that names a GitHub org, in any state, case-insensitive
   *  (MOTIR-8966) — where an assigned org's installation is read from. */
  async listByGithubOrgInTx(
    githubOrg: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    return tx.fleetShard.findMany({
      where: { githubOrg: { equals: githubOrg.trim(), mode: 'insensitive' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },
};
