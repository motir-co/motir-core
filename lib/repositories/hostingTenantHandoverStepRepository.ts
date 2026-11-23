import type { HostingTenantHandoverStep, Prisma } from '@/generated/prisma/client';
import {
  TENANT_HANDOVER_STEPS,
  type TenantHandoverStep,
  type TenantHandoverStepStatus,
} from '@/lib/ciFleet/hostingTenantAccounts';

// The takeover handover's STEP ROWS (Story MOTIR-9800 · MOTIR-12126): one row per
// step per tenant account, so a handover a crash cut off resumes at the step it
// stopped on. A step is taken under a lease held on its own row — taken in one
// conditional statement only when nobody holds it or the holder's lease expired —
// so two workers never run the same step. Platform-only: the table's RLS admits
// the system context alone, and every caller holds a `withSystemContext`
// transaction.

/** What a step's holder records when it ends its turn on the step. */
export interface HandoverStepResult {
  status: Exclude<TenantHandoverStepStatus, 'pending' | 'running'>;
  /** The error's NAME on a failure — never a message, which can carry an
   *  address or an id the organisation gave. */
  lastError?: string | null;
}

/** A step's place in the run order. The table's check constraint admits only
 *  the eight steps, so every stored step has one. */
const stepOrder = (step: string): number =>
  (TENANT_HANDOVER_STEPS as readonly string[]).indexOf(step);

export const hostingTenantHandoverStepRepository = {
  /** Create every handover step as `pending` for the account. A step row that
   *  already exists is left exactly as it is, so a replayed start is a no-op. */
  async createAllPending(tenantAccountId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.hostingTenantHandoverStep.createMany({
      data: TENANT_HANDOVER_STEPS.map((step) => ({ tenantAccountId, step, status: 'pending' })),
      skipDuplicates: true,
    });
    return count;
  },

  /** The account's step rows, in the order the handover runs them. */
  async listByTenantAccount(
    tenantAccountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostingTenantHandoverStep[]> {
    const rows = await tx.hostingTenantHandoverStep.findMany({ where: { tenantAccountId } });
    return rows.sort((a, b) => stepOrder(a.step) - stepOrder(b.step));
  },

  /** Take `step` for `holder` until `leaseExpiresAt` — only when the step is not
   *  `done` and nobody holds it at `now`. Taking it marks it `running`, stamps
   *  when it started and counts the attempt. True when taken. */
  async tryClaim(
    tenantAccountId: string,
    step: TenantHandoverStep,
    holder: string,
    now: Date,
    leaseExpiresAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.hostingTenantHandoverStep.updateMany({
      where: {
        tenantAccountId,
        step,
        status: { not: 'done' },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: {
        status: 'running',
        leaseHolder: holder,
        leaseExpiresAt,
        startedAt: now,
        attempts: { increment: 1 },
      },
    });
    return count === 1;
  },

  /** Record how the holder's turn on `step` ended and give the lease back. Only
   *  the holder can; true when it did. A `done` step stamps `completedAt` with
   *  the database's clock, the same clock `updatedAt` reads. */
  async setStatus(
    tenantAccountId: string,
    step: TenantHandoverStep,
    result: HandoverStepResult,
    holder: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.hostingTenantHandoverStep.updateMany({
      where: { tenantAccountId, step, leaseHolder: holder },
      data: {
        status: result.status,
        lastError: result.status === 'failed' ? (result.lastError ?? null) : null,
        leaseHolder: null,
        leaseExpiresAt: null,
        completedAt: result.status === 'done' ? new Date() : null,
      },
    });
    return count === 1;
  },
};
