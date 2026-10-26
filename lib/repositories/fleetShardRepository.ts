import type {
  FleetShard,
  FleetShardPauseReason,
  FleetShardProvider,
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

  /** Every row naming one AWS account — two for a merged Host account
   *  (MOTIR-9583), one otherwise. */
  async listByAwsAccountInTx(
    awsAccountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    return tx.fleetShard.findMany({ where: { awsAccountId }, orderBy: { createdAt: 'asc' } });
  },

  async findByName(name: string, tx?: Prisma.TransactionClient): Promise<FleetShard | null> {
    const client = tx ?? dbRead;
    return client.fleetShard.findUnique({ where: { name } });
  },

  /** One role's accounts (`null`: every role), optionally of one kind, in one
   *  state and on one provider — oldest first. */
  async listByRole(
    role: FleetShardRole | null,
    filter: { fleetKind?: string; state?: FleetShardState; provider?: FleetShardProvider },
    tx?: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    const client = tx ?? dbRead;
    return client.fleetShard.findMany({
      where: {
        ...(role !== null ? { role } : {}),
        ...(filter.provider !== undefined ? { provider: filter.provider } : {}),
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

  /** One Host organisation's own accounts, of every kind and state, oldest first
   *  (MOTIR-9581) — admission's and the state reader's per-org read. */
  async listOrgOwnedInTx(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    return tx.fleetShard.findMany({
      where: { role: 'org_owned', ownerOrganizationId: organizationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Every `org_owned` account, optionally of one organisation or one kind,
   *  oldest first (MOTIR-9581) — the listings and the reconciles. */
  async listOrgOwned(
    filter: { organizationId?: string; fleetKind?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<FleetShard[]> {
    const client = tx ?? dbRead;
    return client.fleetShard.findMany({
      where: {
        role: 'org_owned',
        ...(filter.organizationId !== undefined
          ? { ownerOrganizationId: filter.organizationId }
          : {}),
        ...(filter.fleetKind !== undefined ? { fleetKind: filter.fleetKind } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** When an own account entered each state (MOTIR-9581). Only the keys given are
   *  written; `null` clears one. */
  async setStateTimestampsInTx(
    id: string,
    times: Partial<Record<'quotaRequestedAt' | 'grantedAt' | 'liveAt', Date | null>>,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard> {
    return tx.fleetShard.update({ where: { id }, data: times });
  },

  /** The organisation's own account of one kind that is LIVE (MOTIR-9586): role
   *  `org_owned`, owned by it, `active`, `liveAt` set. At most one per kind — the
   *  (AWS account, kind) uniqueness and one account per slot. */
  async findLiveOrgOwnedInTx(
    organizationId: string,
    fleetKind: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetShard | null> {
    return tx.fleetShard.findFirst({
      where: {
        role: 'org_owned',
        ownerOrganizationId: organizationId,
        fleetKind,
        state: 'active',
        liveAt: { not: null },
      },
      orderBy: [{ liveAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Set each given state time on EVERY `org_owned` row of one AWS account — but
   *  only on a row where it is still null (MOTIR-9585), so a replay, a race or a
   *  later pass never moves a time. The merged account's two rows are one call. */
  async fillAccountStateTimesInTx(
    awsAccountId: string,
    times: Partial<Record<'quotaRequestedAt' | 'grantedAt' | 'liveAt', Date>>,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const column of ['quotaRequestedAt', 'grantedAt', 'liveAt'] as const) {
      const at = times[column];
      if (!at) continue;
      await tx.fleetShard.updateMany({
        where: { awsAccountId, role: 'org_owned', [column]: null },
        data: { [column]: at },
      });
    }
  },

  /** Settle every still-`provisioning` `org_owned` row of one AWS account to
   *  `active` (MOTIR-9585); answers how many moved. */
  async settleOrgOwnedAccountInTx(
    awsAccountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.fleetShard.updateMany({
      where: { awsAccountId, role: 'org_owned', state: 'provisioning' },
      data: { state: 'active' },
    });
    return count;
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
   * read-derived; id order so two assignments cannot deadlock. A Host org's own
   * account is never a candidate (MOTIR-9581): its GitHub org is not one other
   * tenants are hosted in.
   */
  async lockActiveWithGithubOrgInTx(tx: Prisma.TransactionClient): Promise<FleetShard[]> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "fleet_shard"
       WHERE "state" = 'active' AND btrim("github_org") <> ''
         AND "role" <> 'org_owned'
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
