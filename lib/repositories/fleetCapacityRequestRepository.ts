import type { FleetCapacityRequestStatus, Prisma } from '@/generated/prisma/client';
import type { FleetCapacityRequestRow } from '@/lib/mappers/fleetCapacityRequestMappers';

// Data access for a Host organisation's CAPACITY REQUESTS (Story MOTIR-9365 ·
// MOTIR-9583). Platform-only, as `fleet_shard`: the caller holds a
// `withSystemContext` transaction. Every read carries the linked quota request,
// whose status and granted value are the request's outcome.

const withQuota = { quotaRequest: true } as const;

export const fleetCapacityRequestRepository = {
  async create(
    data: Prisma.FleetCapacityRequestUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow> {
    return tx.fleetCapacityRequest.create({ data, include: withQuota });
  },

  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow | null> {
    return tx.fleetCapacityRequest.findUnique({ where: { id }, include: withQuota });
  },

  /** The AWS account's open or filed request — at most one (the partial unique
   *  index `fleet_capacity_request_one_active`). */
  async findActiveByAwsAccount(
    awsAccountId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow | null> {
    return tx.fleetCapacityRequest.findFirst({
      where: { awsAccountId, status: { in: ['open', 'filed'] } },
      include: withQuota,
    });
  },

  /** One organisation's requests — newest first. */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow[]> {
    return tx.fleetCapacityRequest.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: withQuota,
    });
  },

  /** Every request in one of `statuses` — oldest first. */
  async listByStatus(
    statuses: FleetCapacityRequestStatus[],
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow[]> {
    return tx.fleetCapacityRequest.findMany({
      where: { status: { in: statuses } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: withQuota,
    });
  },

  async markFiled(
    id: string,
    quotaRequestId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow> {
    return tx.fleetCapacityRequest.update({
      where: { id },
      data: { status: 'filed', quotaRequestId, filedAt: at },
      include: withQuota,
    });
  },

  async markClosed(
    id: string,
    note: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<FleetCapacityRequestRow> {
    return tx.fleetCapacityRequest.update({
      where: { id },
      data: { status: 'closed', closedNote: note, closedAt: at },
      include: withQuota,
    });
  },
};
