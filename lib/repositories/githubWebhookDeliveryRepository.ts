import { Prisma, type GithubWebhookDelivery } from '@/generated/prisma/client';

// Data access for the GITHUB WEBHOOK INBOX (Bug MOTIR-10425) — one row per verified
// App delivery, written before `/api/github/webhook` answers and processed by the
// `system.github-webhook-delivery` job. Platform bookkeeping with no workspace; the
// table's policy is `app.system_admin` only, so every caller holds a
// `withSystemContext` transaction.

/** The two coordinates a processing run is keyed on. */
export interface GithubWebhookDeliveryRef {
  deliveryId: string;
  generation: number;
}

export const githubWebhookDeliveryRepository = {
  /**
   * Insert the delivery unless a row for its GUID already exists. ONE statement,
   * arbitrated by the unique index rather than by a read first, so two copies of one
   * delivery arriving together land exactly one row. Answers whether THIS call
   * created it.
   */
  async insertIfAbsent(
    data: { deliveryId: string; event: string; payload: Prisma.InputJsonValue },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.githubWebhookDelivery.createMany({
      data: [data],
      skipDuplicates: true,
    });
    return count === 1;
  },

  /**
   * Re-arm a FAILED delivery that GitHub delivered again (a hand "Redeliver" repeats
   * the GUID): back to `received`, with the body of the new copy and a new
   * generation, so the job's idempotency key is new and a fresh run is owed. A row
   * in any other state is left alone. Answers the re-armed row, or null.
   */
  async rearmFailed(
    deliveryId: string,
    payload: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<GithubWebhookDelivery | null> {
    const { count } = await tx.githubWebhookDelivery.updateMany({
      where: { deliveryId, state: 'failed' },
      data: { state: 'received', payload, generation: { increment: 1 }, lastError: null },
    });
    if (count === 0) return null;
    return tx.githubWebhookDelivery.findUnique({ where: { deliveryId } });
  },

  async findByDeliveryId(
    deliveryId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubWebhookDelivery | null> {
    return tx.githubWebhookDelivery.findUnique({ where: { deliveryId } });
  },

  /**
   * Count one processing attempt — only while the row is still owed work at THIS
   * generation (`received`, or `failed` between the job's retries). Answers the row
   * after the increment, or null when there is nothing for this run to do: the row is
   * missing, already processed, or a redelivery has re-armed it under a newer
   * generation that owns it now.
   */
  async startAttempt(
    ref: GithubWebhookDeliveryRef,
    tx: Prisma.TransactionClient,
  ): Promise<GithubWebhookDelivery | null> {
    const { count } = await tx.githubWebhookDelivery.updateMany({
      where: {
        deliveryId: ref.deliveryId,
        generation: ref.generation,
        state: { in: ['received', 'failed'] },
      },
      data: { attempts: { increment: 1 } },
    });
    if (count === 0) return null;
    return tx.githubWebhookDelivery.findUnique({ where: { deliveryId: ref.deliveryId } });
  },

  /** Record the answer, and drop the body: a processed row is never run again. */
  async markProcessed(
    id: string,
    result: Prisma.InputJsonValue,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.githubWebhookDelivery.update({
      where: { id },
      data: {
        state: 'processed',
        result,
        processedAt: at,
        lastError: null,
        payload: Prisma.DbNull,
      },
    });
  },

  async markFailed(id: string, error: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.githubWebhookDelivery.update({
      where: { id },
      data: { state: 'failed', lastError: error },
    });
  },

  /** Rows still `received` since before `before`, oldest first — the ones whose run
   *  may never have been enqueued. */
  async listReceivedBefore(
    before: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<GithubWebhookDeliveryRef[]> {
    return tx.githubWebhookDelivery.findMany({
      where: { state: 'received', receivedAt: { lt: before } },
      orderBy: { receivedAt: 'asc' },
      take,
      select: { deliveryId: true, generation: true },
    });
  },

  /** Delete the rows in `state` received before `before` — on the `(state,
   *  received_at)` index the sweep's other read uses. Answers how many. */
  async deleteInStateBefore(
    state: 'processed' | 'failed',
    before: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.githubWebhookDelivery.deleteMany({
      where: { state, receivedAt: { lt: before } },
    });
    return count;
  },
};
