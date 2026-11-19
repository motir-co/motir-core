import type { CiSpotRerunPin, Prisma } from '@/generated/prisma/client';

// Data access for the ON-DEMAND PIN HOLDS of second Spot re-runs (MOTIR-11732).
// Single-op methods only (CLAUDE.md 4-layer); every method takes a `tx`, and
// every caller runs it under `withSystemContext` — the table's one policy arm.

/** How long a hold stays open at most, measured from when it was opened. */
export const CI_SPOT_RERUN_PIN_MAX_AGE_MS = 24 * 60 * 60_000;

/** Why a hold closed. */
export type CiSpotRerunPinCloseReason =
  | 'picked_up'
  | 'rerun_refused'
  | 'rerun_expired'
  | 'aged_out';

/** The runner target a repository owner's jobs run in, as the hold keys it:
 *  GitHub logins compare case-insensitively. */
export function pinTargetOrg(repoOwner: string): string {
  return repoOwner.trim().toLowerCase();
}

/** The oldest `openedAt` a hold can have and still be open at `now`. */
const openSince = (now: Date) => new Date(now.getTime() - CI_SPOT_RERUN_PIN_MAX_AGE_MS);

export const ciSpotRerunPinRepository = {
  /**
   * Open the hold for the job an interrupted runner took, keyed by that runner's
   * intent — or answer the one already there, untouched, so a retried re-run
   * neither reopens a closed hold nor moves an open one's 24 hours.
   */
  async open(
    input: {
      sourceIntentId: string;
      repoOwner: string;
      repoName: string;
      runId: string;
      runAttempt: number;
      jobName: string;
    },
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<CiSpotRerunPin> {
    return tx.ciSpotRerunPin.upsert({
      where: { sourceIntentId: input.sourceIntentId },
      create: { ...input, targetOrg: pinTargetOrg(input.repoOwner), openedAt: now },
      update: {},
    });
  },

  /** The holds OPEN in one runner target at `now`: not closed, under 24 hours old. */
  async listOpenForTarget(
    targetOrg: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<CiSpotRerunPin[]> {
    return tx.ciSpotRerunPin.findMany({
      where: { targetOrg, closedAt: null, openedAt: { gt: openSince(now) } },
      orderBy: { openedAt: 'asc' },
    });
  },

  /** Every hold still marked open, whatever its age — the reconcile's close pass. */
  async listUnclosed(tx: Prisma.TransactionClient): Promise<CiSpotRerunPin[]> {
    return tx.ciSpotRerunPin.findMany({ where: { closedAt: null }, orderBy: { openedAt: 'asc' } });
  },

  /** Close one hold, if it is still open. Answers whether this call closed it. */
  async close(
    id: string,
    reason: CiSpotRerunPinCloseReason,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.ciSpotRerunPin.updateMany({
      where: { id, closedAt: null },
      data: { closedAt: now, closeReason: reason },
    });
    return count === 1;
  },

  /** Close the hold an interrupted runner's intent opened, if it is still open. */
  async closeBySource(
    sourceIntentId: string,
    reason: CiSpotRerunPinCloseReason,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.ciSpotRerunPin.updateMany({
      where: { sourceIntentId, closedAt: null },
      data: { closedAt: now, closeReason: reason },
    });
    return count === 1;
  },

  /**
   * Close every open hold on this job whose interrupted attempt is EARLIER than
   * the attempt a runner just took: the re-run was picked up. Repository compared
   * case-insensitively. Answers how many it closed.
   */
  async closePickedUp(
    job: {
      repoOwner: string;
      repoName: string;
      runId: string;
      jobName: string;
      runAttempt: number;
    },
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.ciSpotRerunPin.updateMany({
      where: {
        repoOwner: { equals: job.repoOwner, mode: 'insensitive' },
        repoName: { equals: job.repoName, mode: 'insensitive' },
        runId: job.runId,
        jobName: job.jobName,
        runAttempt: { lt: job.runAttempt },
        closedAt: null,
      },
      data: { closedAt: now, closeReason: 'picked_up' },
    });
    return count;
  },
};
