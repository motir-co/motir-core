import type { FleetWorkloadKind } from '@motir/orchestrator';
import type { GithubAppRole } from '@/lib/github/appAuth';

// One account of one fleet kind's pool (Story MOTIR-8953 · MOTIR-8961).
//
// ⚠️ It carries `credentialRef` — the NAME of the environment variable the
// provider secret lives in — and never a secret value: the row holds none.

export type FleetShardProviderDTO = 'fly' | 'aws';
export type FleetShardRoleDTO = 'primary';
export type FleetShardStateDTO = 'provisioning' | 'active' | 'disabled';

/** The limits an account records, by name. */
export type FleetShardLimitName =
  | 'vcpuQuota'
  | 'machineLimit'
  | 'githubRegistrationsPer5Min'
  | 'githubApiPerHour';

/** Where a recorded limit was read. */
export type FleetShardLimitSource = 'provider_read' | 'documented' | 'raised';

export type FleetShardLimitsDTO = Record<FleetShardLimitName, number | null>;

export interface FleetShardDTO {
  id: string;
  name: string;
  fleetKind: FleetWorkloadKind;
  provider: FleetShardProviderDTO;
  role: FleetShardRoleDTO;
  state: FleetShardStateDTO;
  github: { org: string; installationId: string; appRole: GithubAppRole };
  /** The Fly location — set for a `fly` account. */
  fly: { org: string; app: string; region: string } | null;
  /** The AWS location — set for an `aws` account (MOTIR-9276). */
  aws: { accountId: string; region: string } | null;
  credentialRef: string;
  limits: FleetShardLimitsDTO;
  limitsSource: Partial<Record<FleetShardLimitName, FleetShardLimitSource>>;
  limitsVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
