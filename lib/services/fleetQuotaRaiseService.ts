import {
  AwsManagementApiError,
  awsManagementCredentials,
  createAwsManagementApi,
  type AwsManagementApi,
  type AwsSessionCredentials,
  type FleetWorkloadKind,
} from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import {
  FleetQuotaRequestOpenError,
  FleetShardNotFoundError,
  QuotaRaiseFilingFailedError,
  QuotaRaiseRefusedError,
  QuotaRequestReadFailedError,
} from '@/lib/ciFleet/errors';
import type { FleetQuotaRequestDTO, FleetQuotaRequestStatusDTO } from '@/lib/dto/fleetPools';
import {
  DEFAULT_FLEET_QUOTA_CODE,
  isTerminalQuotaRequestStatus,
} from '@/lib/mappers/fleetPoolMappers';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetQuotaRequestService } from '@/lib/services/fleetQuotaRequestService';
import { awsReasonOf, recordGrantedVcpuQuota } from '@/lib/services/fleetShardQuotaService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE FLEET'S OWN QUOTA RAISES (Story MOTIR-9362 · MOTIR-9459): file an
// `L-1216C47A` increase for one fleet account through Service Quotas, store it
// with AWS's request id, and read each open one back until AWS closes it. An
// approved raise writes its granted value to the account's row at once
// (source `raised`), so the 70% comparison measures against it on the next pass.
//
// AWS is called OUTSIDE any database transaction; each result is stored after,
// in a short one. No schedule and no command of its own: add-shard files a new
// spare's raise (MOTIR-9460), `fleet-admin request-quota` files them for
// several accounts (MOTIR-9463), and the per-pass job refreshes (MOTIR-9462).
//
// ⚠️ The member session lives in memory for the call; no error, result or log
// line carries a credential — a failure names AWS's error code only.

/** AWS's `RequestStatus` → the stored status: the one table. */
const AWS_REQUEST_STATUS: Readonly<Record<string, FleetQuotaRequestStatusDTO>> = {
  PENDING: 'pending',
  CASE_OPENED: 'case_opened',
  APPROVED: 'approved',
  DENIED: 'denied',
  NOT_APPROVED: 'not_approved',
  CASE_CLOSED: 'case_closed',
  INVALID_REQUEST: 'invalid_request',
};

/** AWS's status as one of the seven, or null for a value it added since. */
export function quotaRequestStatusOf(aws: string): FleetQuotaRequestStatusDTO | null {
  return Object.hasOwn(AWS_REQUEST_STATUS, aws) ? AWS_REQUEST_STATUS[aws]! : null;
}

export interface FleetQuotaRaiseDeps {
  /** The management API, from this deployment's management credential. */
  management(): AwsManagementApi;
  now(): Date;
}

const defaultDeps: FleetQuotaRaiseDeps = {
  management: () => createAwsManagementApi(awsManagementCredentials(process.env)),
  now: () => new Date(),
};

export type QuotaRequestRefresh =
  | {
      requestId: string;
      shardId: string;
      status: FleetQuotaRequestStatusDTO;
      grantedValue: number | null;
      closed: boolean;
    }
  | { requestId: string; shardId: string; failure: QuotaRequestReadFailedError };

interface AwsLocation {
  accountId: string;
  region: string;
}

function awsLocationOf(shard: FleetShard): AwsLocation | null {
  return shard.provider === 'aws' && shard.awsAccountId && shard.awsRegion
    ? { accountId: shard.awsAccountId, region: shard.awsRegion }
    : null;
}

async function shardOf(shardId: string): Promise<FleetShard> {
  const shard = await withSystemContext((tx) => fleetShardRepository.findById(shardId, tx));
  if (!shard) throw new FleetShardNotFoundError(shardId);
  return shard;
}

export const fleetQuotaRaiseService = {
  /**
   * File a raise of the account's `L-1216C47A` to `desiredVcpu` and store it.
   * An open request for the same value is answered with no AWS call; a desired
   * value not above the account's granted quota is refused before AWS. Works for
   * a spare and for an account still `provisioning` (a new spare's raise is
   * filed before it is granted anything).
   */
  async fileRaise(
    shardId: string,
    desiredVcpu: number,
    deps: FleetQuotaRaiseDeps = defaultDeps,
  ): Promise<FleetQuotaRequestDTO> {
    const quotaCode = DEFAULT_FLEET_QUOTA_CODE;
    const shard = await shardOf(shardId);
    const location = awsLocationOf(shard);
    if (!location) {
      throw new QuotaRaiseRefusedError(shard.id, shard.name, 'not an aws account');
    }
    if (!Number.isInteger(desiredVcpu) || desiredVcpu <= 0) {
      throw new QuotaRaiseRefusedError(shard.id, shard.name, 'the desired value is not a count');
    }

    const open = await fleetQuotaRequestService.findOpen(shard.id, quotaCode);
    if (open && open.desiredValue === desiredVcpu) return open;
    // AWS holds one open request per quota: another value waits for this one.
    if (open) throw new FleetQuotaRequestOpenError(shard.id, quotaCode, open.id);

    if (shard.vcpuQuota !== null && desiredVcpu <= shard.vcpuQuota) {
      throw new QuotaRaiseRefusedError(
        shard.id,
        shard.name,
        `${desiredVcpu} is not above the granted ${shard.vcpuQuota}`,
      );
    }

    let filed: { requestId: string; status: string; desiredValue: number | null };
    try {
      const management = deps.management();
      const session = await management.assumeMemberRole(location.accountId);
      try {
        filed = await management.requestVcpuQuotaIncrease(
          session,
          location.region,
          desiredVcpu,
          quotaCode,
        );
      } catch (err) {
        // Filed before but never stored (the store failed after AWS accepted):
        // AWS holds one open request per quota, so adopt it rather than fail.
        const existing =
          err instanceof AwsManagementApiError && err.awsCode === 'ResourceAlreadyExistsException'
            ? await management.findOpenQuotaRequest(session, location.region, quotaCode)
            : null;
        if (!existing) throw err;
        filed = existing;
      }
    } catch (err) {
      throw new QuotaRaiseFilingFailedError(shard.id, shard.name, awsReasonOf(err));
    }

    const stored = await fleetQuotaRequestService.createRequest({
      shardId: shard.id,
      quotaCode,
      desiredValue: filed.desiredValue ?? desiredVcpu,
      awsRequestId: filed.requestId,
    });
    const status = quotaRequestStatusOf(filed.status);
    if (status === null || status === 'pending' || stored.status !== 'pending') return stored;
    return fleetQuotaRequestService.recordRead(stored.id, { status, grantedValue: null }, deps.now);
  },

  /**
   * Read every open request (of `kind`, or of every kind) from AWS and store its
   * status, granted value and read time. A terminal status closes the request;
   * an `approved` one also writes its granted value to the account's row. One
   * request's failure is returned and never stops the others.
   */
  async refreshOpenRequests(
    kind?: FleetWorkloadKind,
    deps: FleetQuotaRaiseDeps = defaultDeps,
  ): Promise<QuotaRequestRefresh[]> {
    const open = await fleetQuotaRequestService.listOpen(kind ? { fleetKind: kind } : {});
    if (open.length === 0) return [];

    let management: AwsManagementApi | null = null;
    let managementFailure: unknown = null;
    try {
      management = deps.management();
    } catch (err) {
      managementFailure = err;
    }

    // One member session per account, shared by its requests.
    const sessions = new Map<string, Promise<AwsSessionCredentials>>();
    const results: QuotaRequestRefresh[] = [];
    for (const request of open) {
      const fail = (reason: string): QuotaRequestRefresh => ({
        requestId: request.id,
        shardId: request.shardId,
        failure: new QuotaRequestReadFailedError(request.id, request.shardId, reason),
      });
      if (!management) {
        results.push(fail(awsReasonOf(managementFailure)));
        continue;
      }
      try {
        const shard = await shardOf(request.shardId);
        const location = awsLocationOf(shard);
        if (!location) {
          results.push(fail('MissingAwsLocation'));
          continue;
        }
        let session = sessions.get(shard.id);
        if (!session) {
          session = management.assumeMemberRole(location.accountId);
          sessions.set(shard.id, session);
        }
        const credentials = await session;
        const read = await management.getQuotaRequest(
          credentials,
          location.region,
          request.awsRequestId,
        );
        const status = quotaRequestStatusOf(read.status);
        if (status === null) {
          results.push(fail(`UnknownStatus:${read.status}`));
          continue;
        }
        // `GetRequestedServiceQuotaChange` carries only the desired value: what
        // was granted is the account's applied quota once AWS approves.
        const grantedValue =
          status === 'approved'
            ? await management.readVcpuQuota(credentials, location.region)
            : null;
        if (grantedValue !== null) {
          await recordGrantedVcpuQuota(shard.id, grantedValue, 'raised', deps.now());
        }
        const stored = await fleetQuotaRequestService.recordRead(
          request.id,
          { status, grantedValue },
          deps.now,
        );
        results.push({
          requestId: request.id,
          shardId: request.shardId,
          status: stored.status,
          grantedValue: stored.grantedValue,
          closed: isTerminalQuotaRequestStatus(stored.status),
        });
      } catch (err) {
        results.push(fail(awsReasonOf(err)));
      }
    }
    return results;
  },
};
