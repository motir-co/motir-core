import { Prisma } from '@/generated/prisma/client';
import {
  FleetCapacityRequestLinkMismatchError,
  FleetCapacityRequestNotFoundError,
  FleetCapacityRequestNotOwnedError,
  FleetCapacityRequestOpenError,
  FleetCapacityRequestStateError,
  FleetPoolValueInvalidError,
  FleetQuotaRequestNotFoundError,
} from '@/lib/ciFleet/errors';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import type {
  FleetCapacityRequestDTO,
  OrgFleetCapacityRequestDTO,
} from '@/lib/dto/fleetCapacityRequest';
import {
  toFleetCapacityRequestDTO,
  toOrgFleetCapacityRequestDTO,
  type FleetCapacityRequestRow,
} from '@/lib/mappers/fleetCapacityRequestMappers';
import { DEFAULT_FLEET_QUOTA_CODE } from '@/lib/mappers/fleetPoolMappers';
import { alertFleetCapacityRequest } from '@/lib/monitoring/fleetCapacityRequestAlert';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { fleetCapacityRequestRepository } from '@/lib/repositories/fleetCapacityRequestRepository';
import { fleetQuotaRequestRepository } from '@/lib/repositories/fleetQuotaRequestRepository';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { billingService } from '@/lib/services/billingService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// A HOST ORGANISATION'S ASK FOR MORE CAPACITY (Story MOTIR-9365 · MOTIR-9583) on
// one of its OWN accounts. Creating one alerts the platform admin, who talks to
// AWS, files the raise through the quota-request records (`fleet-admin
// request-quota`) and LINKS it here. Whether AWS granted is the linked quota
// request's, read at read time — never stored twice. Nothing here calls AWS or
// computes a figure: the caps card follows the granted value.
//
// One ask per AWS ACCOUNT: the merged indexer + agent hoster account is two rows
// with one quota, so an open or filed request on either of its kinds holds the
// account (the partial unique index is the backstop for a race).

/** The reason an organisation gives, at most this long. */
export const CAPACITY_REASON_MAX = 2000;

export interface FleetCapacityRequestInput {
  organizationId: string;
  userId: string;
  shardId: string;
  /** The kind the organisation named — one of the account's kinds. */
  fleetKind: string;
  desiredVcpu: number;
  reason: string;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** The active request for the account, answered when it asks the same figure
 *  (the idempotent create) and refused when it asks another. */
function sameOrRefuse(
  active: FleetCapacityRequestRow,
  desiredVcpu: number,
): FleetCapacityRequestDTO {
  if (active.desiredVcpu !== desiredVcpu) {
    throw new FleetCapacityRequestOpenError(active.awsAccountId, active.id);
  }
  return toFleetCapacityRequestDTO(active);
}

function auditMetadata(row: FleetCapacityRequestRow): Prisma.InputJsonValue {
  return {
    organizationId: row.organizationId,
    awsAccountId: row.awsAccountId,
    fleetKind: row.fleetKind,
    desiredVcpu: row.desiredVcpu,
    quotaRequestId: row.quotaRequestId,
  };
}

export const fleetCapacityRequestService = {
  /**
   * Ask for more capacity on one of the organisation's own accounts. Idempotent:
   * while the AWS account has an open or filed request for the same figure, that
   * request is answered and nothing is written (and nothing alerted).
   *
   * @throws FleetPoolValueInvalidError before any write (figure, reason, kind);
   *   FleetCapacityRequestNotOwnedError for an account that is not the asker's;
   *   FleetCapacityRequestOpenError for an active request with another figure.
   */
  async request(
    input: FleetCapacityRequestInput,
    now: () => Date = () => new Date(),
  ): Promise<FleetCapacityRequestDTO> {
    if (!positiveInteger(input.desiredVcpu)) {
      throw new FleetPoolValueInvalidError('desiredVcpu', input.desiredVcpu);
    }
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > CAPACITY_REASON_MAX) {
      throw new FleetPoolValueInvalidError('reason', `${reason.length} characters`);
    }
    if (!(FLEET_WORKLOAD_KINDS as string[]).includes(input.fleetKind)) {
      throw new FleetPoolValueInvalidError('fleetKind', input.fleetKind);
    }

    let created = false;
    let dto: FleetCapacityRequestDTO;
    try {
      dto = await withSystemContext(async (tx) => {
        const shard = await fleetShardRepository.findById(input.shardId, tx);
        if (
          !shard ||
          shard.role !== 'org_owned' ||
          shard.ownerOrganizationId !== input.organizationId ||
          !shard.awsAccountId
        ) {
          throw new FleetCapacityRequestNotOwnedError(input.shardId);
        }
        const rows = (
          await fleetShardRepository.listByAwsAccountInTx(shard.awsAccountId, tx)
        ).filter((row) => row.ownerOrganizationId === input.organizationId);
        if (!rows.some((row) => row.fleetKind === input.fleetKind)) {
          throw new FleetPoolValueInvalidError('fleetKind', input.fleetKind);
        }
        const granted = Math.max(0, ...rows.map((row) => row.vcpuQuota ?? 0));
        if (input.desiredVcpu <= granted) {
          throw new FleetPoolValueInvalidError('desiredVcpu', input.desiredVcpu);
        }
        const active = await fleetCapacityRequestRepository.findActiveByAwsAccount(
          shard.awsAccountId,
          tx,
        );
        if (active) return sameOrRefuse(active, input.desiredVcpu);
        const row = await fleetCapacityRequestRepository.create(
          {
            organizationId: input.organizationId,
            shardId: shard.id,
            awsAccountId: shard.awsAccountId,
            fleetKind: input.fleetKind,
            quotaCode: DEFAULT_FLEET_QUOTA_CODE,
            desiredVcpu: input.desiredVcpu,
            reasonMd: reason,
            requestedByUserId: input.userId,
            createdAt: now(),
          },
          tx,
        );
        created = true;
        return toFleetCapacityRequestDTO(row);
      });
    } catch (err) {
      // Two asks raced past the read: the index kept one; answer it.
      if (!isUniqueViolation(err)) throw err;
      const shard = await withSystemContext((tx) =>
        fleetShardRepository.findById(input.shardId, tx),
      );
      const active = shard?.awsAccountId
        ? await withSystemContext((tx) =>
            fleetCapacityRequestRepository.findActiveByAwsAccount(shard.awsAccountId!, tx),
          )
        : null;
      if (!active) throw err;
      return sameOrRefuse(active, input.desiredVcpu);
    }
    // After the commit: an alert that fails changes nothing about the ask.
    if (created) alertFleetCapacityRequest(dto);
    return dto;
  },

  /**
   * The org admin's Request more capacity (Story MOTIR-9368 · MOTIR-9662): an
   * owner or admin of the org names its OWN account by fleet kind — never by id —
   * and gets the tenant-safe record back. The merged indexer + agent hoster
   * account is one row per kind on one AWS account, so either kind resolves to
   * its own row and {@link request}'s one-ask-per-account rule holds the pair.
   *
   * @throws BillingNotAvailableError / OrganizationNotFoundError /
   *   BillingForbiddenError / OrganizationClosingError (the billing mutation
   *   gate); FleetPoolValueInvalidError for an unknown kind, before any lookup;
   *   FleetCapacityRequestNotOwnedError when the org owns no account of that
   *   kind; and whatever {@link request} throws.
   */
  async requestForOrganization(input: {
    organizationId: string;
    actorUserId: string;
    fleetKind: string;
    desiredVcpu: number;
    reason: string;
  }): Promise<OrgFleetCapacityRequestDTO> {
    await billingService.assertBillingManagerForMutation({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    });
    if (!(FLEET_WORKLOAD_KINDS as string[]).includes(input.fleetKind)) {
      throw new FleetPoolValueInvalidError('fleetKind', input.fleetKind);
    }
    const [account] = await withSystemContext((tx) =>
      fleetShardRepository.listOrgOwned(
        { organizationId: input.organizationId, fleetKind: input.fleetKind },
        tx,
      ),
    );
    // No account of that kind (a non-Host org, or one not created yet): the same
    // no-tell-apart refusal as another org's account.
    if (!account) throw new FleetCapacityRequestNotOwnedError(input.fleetKind);
    const dto = await this.request({
      organizationId: input.organizationId,
      userId: input.actorUserId,
      shardId: account.id,
      fleetKind: input.fleetKind,
      desiredVcpu: input.desiredVcpu,
      reason: input.reason,
    });
    return toOrgFleetCapacityRequestDTO(dto);
  },

  /**
   * The platform admin filed the raise: link the capacity request to it. The
   * quota request must be on the same AWS account (either row of a merged one).
   * Linking the same quota request again changes nothing.
   *
   * @throws FleetCapacityRequestNotFoundError, FleetQuotaRequestNotFoundError,
   *   FleetCapacityRequestStateError (closed, or filed with another raise),
   *   FleetCapacityRequestLinkMismatchError.
   */
  async linkQuotaRequest(
    input: { requestId: string; quotaRequestId: string },
    principal: PlatformPrincipal,
    now: () => Date = () => new Date(),
  ): Promise<FleetCapacityRequestDTO> {
    const row = await withSystemContext(async (tx) => {
      const request = await fleetCapacityRequestRepository.findById(input.requestId, tx);
      if (!request) throw new FleetCapacityRequestNotFoundError(input.requestId);
      if (request.status === 'closed') {
        throw new FleetCapacityRequestStateError(request.id, request.status);
      }
      if (request.status === 'filed') {
        if (request.quotaRequestId === input.quotaRequestId) return request;
        throw new FleetCapacityRequestStateError(request.id, request.status);
      }
      const quota = await fleetQuotaRequestRepository.findById(input.quotaRequestId, tx);
      if (!quota) throw new FleetQuotaRequestNotFoundError(input.quotaRequestId);
      const quotaShard = await fleetShardRepository.findById(quota.shardId, tx);
      if (!quotaShard || quotaShard.awsAccountId !== request.awsAccountId) {
        throw new FleetCapacityRequestLinkMismatchError(request.id, quota.id);
      }
      return fleetCapacityRequestRepository.markFiled(request.id, quota.id, now(), tx);
    });
    await platformAuditService.record(principal, {
      action: 'fleet.capacity_request.link',
      targetKind: 'platform',
      targetId: row.id,
      targetLabel: `capacity request on ${row.awsAccountId}`,
      organizationId: row.organizationId,
      reason: `fleet-admin capacity-request-link ${row.id} ${input.quotaRequestId}`,
      metadata: auditMetadata(row),
    });
    return toFleetCapacityRequestDTO(row);
  },

  /**
   * Close an open or filed request with the platform admin's note (declined,
   * withdrawn, …). A closed request frees its AWS account for a new one.
   */
  async close(
    input: { requestId: string; note: string },
    principal: PlatformPrincipal,
    now: () => Date = () => new Date(),
  ): Promise<FleetCapacityRequestDTO> {
    const note = input.note.trim();
    if (note.length === 0 || note.length > CAPACITY_REASON_MAX) {
      throw new FleetPoolValueInvalidError('note', `${note.length} characters`);
    }
    const row = await withSystemContext(async (tx) => {
      const request = await fleetCapacityRequestRepository.findById(input.requestId, tx);
      if (!request) throw new FleetCapacityRequestNotFoundError(input.requestId);
      if (request.status === 'closed') {
        throw new FleetCapacityRequestStateError(request.id, request.status);
      }
      return fleetCapacityRequestRepository.markClosed(request.id, note, now(), tx);
    });
    await platformAuditService.record(principal, {
      action: 'fleet.capacity_request.close',
      targetKind: 'platform',
      targetId: row.id,
      targetLabel: `capacity request on ${row.awsAccountId}`,
      organizationId: row.organizationId,
      reason: note,
      metadata: auditMetadata(row),
    });
    return toFleetCapacityRequestDTO(row);
  },

  /** One organisation's requests, newest first — the org admin view's read. */
  async listForOrganization(organizationId: string): Promise<FleetCapacityRequestDTO[]> {
    const rows = await withSystemContext((tx) =>
      fleetCapacityRequestRepository.listByOrganization(organizationId, tx),
    );
    return rows.map(toFleetCapacityRequestDTO);
  },

  /** The open and filed requests, oldest first — the platform admin's list, an
   *  audited read. */
  async listActive(principal: PlatformPrincipal): Promise<FleetCapacityRequestDTO[]> {
    const rows = await withSystemContext((tx) =>
      fleetCapacityRequestRepository.listByStatus(['open', 'filed'], tx),
    );
    await platformAuditService.record(principal, {
      action: 'fleet.capacity_request.list',
      targetKind: 'platform',
      targetLabel: `${rows.length} capacity request(s)`,
      metadata: { count: rows.length },
    });
    return rows.map(toFleetCapacityRequestDTO);
  },
};
