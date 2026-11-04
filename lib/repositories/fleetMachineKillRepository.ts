import type { FleetMachineKill, Prisma } from '@/generated/prisma/client';

// Data access for the KILL RECORD (Story MOTIR-6906 · MOTIR-6925,
// `docs/decisions/fleet-per-org-pool.md` §5) — one row per machine the
// attribution reconciler destroyed or stopped. The table's policy is
// `app.system_admin` only, so every method takes the transaction.

export interface FleetMachineKillCreateInput {
  app: string;
  machineId: string;
  machineName: string;
  reason: string;
  action: string;
  workload: string | null;
  recordRef: string | null;
  organizationId: string | null;
  machineCreatedAt: Date | null;
  ageSeconds: number;
  decidedAt: Date;
}

export const fleetMachineKillRepository = {
  /** Record the DECISION — before the provider is asked to act on it. */
  async create(
    data: FleetMachineKillCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<FleetMachineKill> {
    return tx.fleetMachineKill.create({ data });
  },

  /** The provider carried it out. */
  async markCompleted(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetMachineKill.update({ where: { id }, data: { completedAt: at } });
  },

  /**
   * The kill record since `since`, NEWEST FIRST — the platform fleet monitor's
   * list (MOTIR-7316). Paged by offset because the console pages by number with
   * a total ({@link countSince}). Rides `decided_at`.
   */
  async listSince(
    since: Date,
    page: { offset: number; limit: number },
    tx: Prisma.TransactionClient,
  ): Promise<FleetMachineKill[]> {
    return tx.fleetMachineKill.findMany({
      where: { decidedAt: { gte: since } },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.limit,
    });
  },

  /**
   * ONE organisation's kill record since `since`, NEWEST FIRST — the org Fleet
   * page's "Stopped by Motir" list. Unpaged: the window is seven days of one
   * org's machines. Rides `[organization_id, decided_at]`.
   */
  async listSinceForOrganization(
    organizationId: string,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetMachineKill[]> {
    return tx.fleetMachineKill.findMany({
      where: { organizationId, decidedAt: { gte: since } },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** How many kills were decided since `since` — the list's total. */
  async countSince(since: Date, tx: Prisma.TransactionClient): Promise<number> {
    return tx.fleetMachineKill.count({ where: { decidedAt: { gte: since } } });
  },

  /**
   * How many kills decided since `since` the provider REFUSED — not completed,
   * with a failure recorded. The monitor's "{n} failed" head count, over the
   * whole window rather than one page of it.
   */
  async countFailedSince(since: Date, tx: Prisma.TransactionClient): Promise<number> {
    return tx.fleetMachineKill.count({
      where: { decidedAt: { gte: since }, completedAt: null, failureDetail: { not: null } },
    });
  },

  /** The provider refused; the next pass decides again. */
  async markFailed(id: string, detail: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.fleetMachineKill.update({ where: { id }, data: { failureDetail: detail } });
  },
};
