import type { OrgFleetLastStop, OrgFleetStopAction, Prisma } from '@/generated/prisma/client';

// Data access for the ORG FLEET LAST-STOP RECORD — one row per organisation,
// the newest stop an owner or admin made from the org's Fleet page. The table's
// policy admits the system arm or the org's own binding and nothing unbound, so
// every method takes the transaction: an unbound read would see no row and
// raise nothing.

export interface OrgFleetLastStopInput {
  organizationId: string;
  actorUserId: string;
  actorName: string | null;
  action: OrgFleetStopAction;
  stoppedAt: Date;
}

export const orgFleetLastStopRepository = {
  /** Record the newest stop — it replaces the org's previous one. */
  async upsert(input: OrgFleetLastStopInput, tx: Prisma.TransactionClient): Promise<void> {
    const fields = {
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      action: input.action,
      stoppedAt: input.stoppedAt,
    };
    await tx.orgFleetLastStop.upsert({
      where: { organizationId: input.organizationId },
      create: { organizationId: input.organizationId, ...fields },
      update: fields,
    });
  },

  /** The org's newest stop, or null when it has never been stopped. */
  async findForOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrgFleetLastStop | null> {
    return tx.orgFleetLastStop.findUnique({ where: { organizationId } });
  },
};
