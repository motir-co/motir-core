import { Prisma } from '@/generated/prisma/client';
import {
  FleetPoolValueInvalidError,
  FleetQuotaRequestNotFoundError,
  FleetQuotaRequestOpenError,
  FleetShardNotFoundError,
} from '@/lib/ciFleet/errors';
import type { FleetQuotaRequestDTO, FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';
import {
  DEFAULT_FLEET_QUOTA_CODE,
  FLEET_QUOTA_REQUEST_STATUSES,
  isTerminalQuotaRequestStatus,
  toFleetQuotaRequestDTO,
} from '@/lib/mappers/fleetPoolMappers';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// The QUOTA RAISES filed for a fleet account (Story MOTIR-9362 · MOTIR-9457).
// This service only stores and reads: the raise card (MOTIR-9459) files each
// request to AWS and records what AWS answers here, and the growth card
// (MOTIR-9461) waits on them. Nothing here calls AWS.

export interface CreateFleetQuotaRequestInput {
  shardId: string;
  /** Default `L-1216C47A`. */
  quotaCode?: string;
  desiredValue: number;
  awsRequestId: string;
}

export interface FleetQuotaRequestRead {
  status: string;
  grantedValue: number | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function validStatus(status: string): FleetQuotaRequestStatusDTO {
  if (!FLEET_QUOTA_REQUEST_STATUSES.includes(status as FleetQuotaRequestStatusDTO)) {
    throw new FleetPoolValueInvalidError('status', status);
  }
  return status as FleetQuotaRequestStatusDTO;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** The open request with this account and code, answered when it asks for the
 *  same value (the idempotent create) and refused when it asks for another. */
function sameOrRefuse(
  open: Prisma.FleetQuotaRequestGetPayload<object>,
  desiredValue: number,
): FleetQuotaRequestDTO {
  if (open.desiredValue !== desiredValue) {
    throw new FleetQuotaRequestOpenError(open.shardId, open.quotaCode, open.id);
  }
  return toFleetQuotaRequestDTO(open);
}

export const fleetQuotaRequestService = {
  /**
   * Store a raise filed for one account. Idempotent: while the account has an
   * OPEN request for the same quota and value, that request is answered and
   * nothing is written. An open request for another value is
   * `FleetQuotaRequestOpenError` — AWS allows one pending request per quota.
   */
  async createRequest(input: CreateFleetQuotaRequestInput): Promise<FleetQuotaRequestDTO> {
    const quotaCode = (input.quotaCode ?? DEFAULT_FLEET_QUOTA_CODE).trim();
    if (quotaCode.length === 0) throw new FleetPoolValueInvalidError('quotaCode', quotaCode);
    if (!positiveInteger(input.desiredValue)) {
      throw new FleetPoolValueInvalidError('desiredValue', input.desiredValue);
    }
    const awsRequestId = input.awsRequestId.trim();
    if (awsRequestId.length === 0) {
      throw new FleetPoolValueInvalidError('awsRequestId', input.awsRequestId);
    }
    try {
      return await withSystemContext(async (tx) => {
        const shard = await fleetShardRepository.findById(input.shardId, tx);
        if (!shard) throw new FleetShardNotFoundError(input.shardId);
        const open = await fleetQuotaRequestRepository.findOpenByShardAndCode(
          shard.id,
          quotaCode,
          tx,
        );
        if (open) return sameOrRefuse(open, input.desiredValue);
        const row = await fleetQuotaRequestRepository.create(
          {
            shardId: shard.id,
            fleetKind: shard.fleetKind,
            quotaCode,
            desiredValue: input.desiredValue,
            awsRequestId,
          },
          tx,
        );
        return toFleetQuotaRequestDTO(row);
      });
    } catch (err) {
      // Two creates raced past the read: the index kept one; answer it.
      if (!isUniqueViolation(err)) throw err;
      const open = await withSystemContext((tx) =>
        fleetQuotaRequestRepository.findOpenByShardAndCode(input.shardId, quotaCode, tx),
      );
      if (!open) throw err;
      return sameOrRefuse(open, input.desiredValue);
    }
  },

  /**
   * Record one Service Quotas read of a request: its status, its granted value
   * and when it was read. A terminal status closes the request, and a closed
   * request stays closed. A status outside the seven is refused before the write.
   */
  async recordRead(
    id: string,
    read: FleetQuotaRequestRead,
    now: () => Date = () => new Date(),
  ): Promise<FleetQuotaRequestDTO> {
    const status = validStatus(read.status);
    if (read.grantedValue !== null && !positiveInteger(read.grantedValue)) {
      throw new FleetPoolValueInvalidError('grantedValue', read.grantedValue);
    }
    const row = await withSystemContext(async (tx) => {
      const current = await fleetQuotaRequestRepository.findById(id, tx);
      if (!current) throw new FleetQuotaRequestNotFoundError(id);
      const at = now();
      const terminal = isTerminalQuotaRequestStatus(status);
      // A closed request keeps the status that closed it: AWS does not reopen one.
      if (current.closedAt !== null) {
        return fleetQuotaRequestRepository.updateRead(
          id,
          {
            status: current.status,
            grantedValue: read.grantedValue ?? current.grantedValue,
            lastReadAt: at,
            closedAt: current.closedAt,
          },
          tx,
        );
      }
      return fleetQuotaRequestRepository.updateRead(
        id,
        {
          status,
          grantedValue: read.grantedValue ?? current.grantedValue,
          lastReadAt: at,
          closedAt: terminal ? at : null,
        },
        tx,
      );
    });
    return toFleetQuotaRequestDTO(row);
  },

  /** The account's open request for this quota, or null. */
  async findOpen(
    shardId: string,
    quotaCode: string = DEFAULT_FLEET_QUOTA_CODE,
  ): Promise<FleetQuotaRequestDTO | null> {
    const row = await withSystemContext((tx) =>
      fleetQuotaRequestRepository.findOpenByShardAndCode(shardId, quotaCode, tx),
    );
    return row ? toFleetQuotaRequestDTO(row) : null;
  },

  async getRequest(id: string): Promise<FleetQuotaRequestDTO> {
    const row = await withSystemContext((tx) => fleetQuotaRequestRepository.findById(id, tx));
    if (!row) throw new FleetQuotaRequestNotFoundError(id);
    return toFleetQuotaRequestDTO(row);
  },

  /** The open requests, optionally of one kind or one account — oldest first. */
  async listOpen(
    filter: { fleetKind?: string; shardId?: string } = {},
  ): Promise<FleetQuotaRequestDTO[]> {
    const rows = await withSystemContext((tx) => fleetQuotaRequestRepository.listOpen(filter, tx));
    return rows.map(toFleetQuotaRequestDTO);
  },

  /** Every request of one account — newest first. */
  async listByShard(shardId: string): Promise<FleetQuotaRequestDTO[]> {
    const rows = await withSystemContext((tx) =>
      fleetQuotaRequestRepository.listByShard(shardId, tx),
    );
    return rows.map(toFleetQuotaRequestDTO);
  },
};
