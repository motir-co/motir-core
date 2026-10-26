import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import type {
  FleetShardDTO,
  FleetShardLimitName,
  FleetShardLimitSource,
  FleetShardRoleDTO,
} from '@/lib/dto/fleetShard';
import type { GithubAppRole } from '@/lib/github/appAuth';
import { stateFromTimes } from '@/lib/ciFleet/hostAccountState';

export const FLEET_SHARD_LIMIT_NAMES: readonly FleetShardLimitName[] = [
  'vcpuQuota',
  'machineLimit',
  'githubRegistrationsPer5Min',
  'githubApiPerHour',
];

export const FLEET_SHARD_LIMIT_SOURCES: readonly FleetShardLimitSource[] = [
  'provider_read',
  'documented',
  'raised',
];

/** Every role an account can hold (MOTIR-9456). */
export const FLEET_SHARD_ROLES: readonly FleetShardRoleDTO[] = ['primary', 'spare', 'org_owned'];

/**
 * The stored role, carried through as it is. A role is a stored value, not a
 * compile-time union: a value this build does not know (a role a newer
 * migration added) keeps its identity rather than reading as `primary`, which
 * would put a non-shared account in every reader's shared pool.
 */
export function fleetShardRoleOf(raw: string): FleetShardRoleDTO {
  return raw as FleetShardRoleDTO;
}

/** The stored `limits_source` object, keeping only known limits and sources. */
function limitsSourceOf(raw: unknown): FleetShardDTO['limitsSource'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: FleetShardDTO['limitsSource'] = {};
  for (const name of FLEET_SHARD_LIMIT_NAMES) {
    const value = (raw as Record<string, unknown>)[name];
    if (FLEET_SHARD_LIMIT_SOURCES.includes(value as FleetShardLimitSource)) {
      out[name] = value as FleetShardLimitSource;
    }
  }
  return out;
}

export function toFleetShardDTO(row: FleetShard): FleetShardDTO {
  return {
    id: row.id,
    name: row.name,
    // The CHECK constraint holds the column to the four kinds.
    fleetKind: row.fleetKind as FleetWorkloadKind,
    provider: row.provider,
    role: fleetShardRoleOf(row.role),
    state: row.state,
    github: {
      org: row.githubOrg,
      installationId: row.githubInstallationId,
      appRole: row.githubAppRole as GithubAppRole,
    },
    fly:
      row.flyOrg !== null && row.flyApp !== null && row.flyRegion !== null
        ? { org: row.flyOrg, app: row.flyApp, region: row.flyRegion }
        : null,
    aws:
      row.awsAccountId !== null && row.awsRegion !== null
        ? { accountId: row.awsAccountId, region: row.awsRegion }
        : null,
    credentialRef: row.credentialRef,
    limits: {
      vcpuQuota: row.vcpuQuota,
      machineLimit: row.machineLimit,
      githubRegistrationsPer5Min: row.githubRegistrationsPer5Min,
      githubApiPerHour: row.githubApiPerHour,
    },
    limitsSource: limitsSourceOf(row.limitsSource),
    limitsVerifiedAt: row.limitsVerifiedAt?.toISOString() ?? null,
    ownerOrganizationId: row.ownerOrganizationId,
    quotaRequestedAt: row.quotaRequestedAt?.toISOString() ?? null,
    grantedAt: row.grantedAt?.toISOString() ?? null,
    liveAt: row.liveAt?.toISOString() ?? null,
    accountState: row.role === 'org_owned' ? stateFromTimes(row) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
