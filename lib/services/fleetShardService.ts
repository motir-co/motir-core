import { Prisma } from '@/generated/prisma/client';
import type {
  FleetShardDTO,
  FleetShardLimitName,
  FleetShardLimitsDTO,
  FleetShardLimitSource,
  FleetShardProviderDTO,
  FleetShardRoleDTO,
  FleetShardStateDTO,
} from '@/lib/dto/fleetShard';
import {
  FleetShardInvalidError,
  FleetShardNotFoundError,
  FleetShardTakenError,
} from '@/lib/ciFleet/errors';
import { FLEET_WORKLOAD_KINDS } from '@/lib/ciFleet/workloads';
import type { GithubAppRole } from '@/lib/github/appAuth';
import {
  FLEET_SHARD_LIMIT_NAMES,
  FLEET_SHARD_LIMIT_SOURCES,
  toFleetShardDTO,
} from '@/lib/mappers/fleetShardMappers';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// The FLEET ACCOUNT RECORD (Story MOTIR-8953 · MOTIR-8961) — one row per account
// of one fleet kind's pool. This service is the write door: it refuses every
// input the database's CHECKs would refuse, first, with a typed error, so no
// caller ever sees a raw constraint violation.
//
// Nothing in a boot, stop, reap or admission path reads it yet — the add-shard
// script (MOTIR-8967) is its first writer, the per-shard orchestrator
// (MOTIR-8964) its first reader.

/** A lowercase slug, e.g. `ci-runner-iad-1`. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX_LENGTH = 63;
/** An environment-variable name or prefix — the only thing a row may say about a
 *  credential. */
const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const INSTALLATION_ID_PATTERN = /^[0-9]+$/;

export type FleetShardLimitsInput = Partial<FleetShardLimitsDTO>;
export type FleetShardLimitsSourceInput = Partial<
  Record<FleetShardLimitName, FleetShardLimitSource>
>;

export interface CreateFleetShardInput {
  name: string;
  fleetKind: string;
  provider: FleetShardProviderDTO;
  role?: FleetShardRoleDTO;
  state?: FleetShardStateDTO;
  githubOrg: string;
  githubInstallationId: string;
  githubAppRole?: GithubAppRole;
  flyOrg?: string | null;
  flyApp?: string | null;
  flyRegion?: string | null;
  awsAccountId?: string | null;
  awsRegion?: string | null;
  credentialRef: string;
  limits?: FleetShardLimitsInput;
  limitsSource?: FleetShardLimitsSourceInput;
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Every limit, null where none was given — each one given a positive integer. */
function validLimits(limits: FleetShardLimitsInput = {}): FleetShardLimitsDTO {
  const out = {} as FleetShardLimitsDTO;
  for (const name of FLEET_SHARD_LIMIT_NAMES) {
    const value = limits[name] ?? null;
    if (value !== null && !(Number.isInteger(value) && value > 0)) {
      throw new FleetShardInvalidError('limit', `${name} must be a positive integer`);
    }
    out[name] = value;
  }
  return out;
}

function validLimitsSource(source: FleetShardLimitsSourceInput = {}): FleetShardLimitsSourceInput {
  for (const [name, value] of Object.entries(source)) {
    if (!FLEET_SHARD_LIMIT_NAMES.includes(name as FleetShardLimitName)) {
      throw new FleetShardInvalidError('limitsSource', `${name} is not a recorded limit`);
    }
    if (!FLEET_SHARD_LIMIT_SOURCES.includes(value)) {
      throw new FleetShardInvalidError(
        'limitsSource',
        `${name}'s source must be one of ${FLEET_SHARD_LIMIT_SOURCES.join(', ')}`,
      );
    }
  }
  return source;
}

function validateIdentity(input: CreateFleetShardInput): void {
  if (!NAME_PATTERN.test(input.name) || input.name.length > NAME_MAX_LENGTH) {
    throw new FleetShardInvalidError(
      'name',
      'a lowercase slug of letters, digits and single hyphens',
    );
  }
  if (!(FLEET_WORKLOAD_KINDS as string[]).includes(input.fleetKind)) {
    throw new FleetShardInvalidError('fleetKind', `one of ${FLEET_WORKLOAD_KINDS.join(', ')}`);
  }
  if (!CREDENTIAL_REF_PATTERN.test(input.credentialRef)) {
    throw new FleetShardInvalidError(
      'credentialRef',
      'an UPPER_SNAKE_CASE environment-variable name',
    );
  }
  if (!present(input.githubOrg)) {
    throw new FleetShardInvalidError('githubOrg', 'the Motir-owned GitHub org is required');
  }
  if (!INSTALLATION_ID_PATTERN.test(input.githubInstallationId)) {
    throw new FleetShardInvalidError('githubInstallationId', 'a numeric App installation id');
  }
}

/** The provider's own invariants — for `fly`, its location and machine limit;
 *  for `aws`, its account id and region. */
function validateProvider(input: CreateFleetShardInput, limits: FleetShardLimitsDTO): void {
  if (input.provider === 'aws') {
    if (!present(input.awsAccountId) || !present(input.awsRegion)) {
      throw new FleetShardInvalidError(
        'awsLocation',
        'an aws account names its account id and region',
      );
    }
    return;
  }
  if (!present(input.flyOrg) || !present(input.flyApp) || !present(input.flyRegion)) {
    throw new FleetShardInvalidError('flyLocation', 'a fly account names its org, app and region');
  }
  if (limits.machineLimit === null) {
    throw new FleetShardInvalidError('machineLimit', 'a fly account records its machine limit');
  }
}

async function requireShard(id: string, tx: Prisma.TransactionClient) {
  const row = await fleetShardRepository.findById(id, tx);
  if (!row) throw new FleetShardNotFoundError(id);
  return row;
}

export const fleetShardService = {
  async createShard(
    input: CreateFleetShardInput,
    now: () => Date = () => new Date(),
  ): Promise<FleetShardDTO> {
    validateIdentity(input);
    const limits = validLimits(input.limits);
    const limitsSource = validLimitsSource(input.limitsSource);
    validateProvider(input, limits);
    try {
      const row = await withSystemContext((tx) =>
        fleetShardRepository.create(
          {
            name: input.name,
            fleetKind: input.fleetKind,
            provider: input.provider,
            role: input.role ?? 'primary',
            state: input.state ?? 'provisioning',
            githubOrg: input.githubOrg,
            githubInstallationId: input.githubInstallationId,
            githubAppRole: input.githubAppRole ?? 'provisioning',
            flyOrg: input.flyOrg ?? null,
            flyApp: input.flyApp ?? null,
            flyRegion: input.flyRegion ?? null,
            awsAccountId: input.awsAccountId ?? null,
            awsRegion: input.awsRegion ?? null,
            credentialRef: input.credentialRef,
            ...limits,
            limitsSource,
            limitsVerifiedAt: Object.keys(limitsSource).length > 0 ? now() : null,
          },
          tx,
        ),
      );
      return toFleetShardDTO(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new FleetShardTakenError(input.name);
      throw err;
    }
  },

  async getShard(id: string): Promise<FleetShardDTO> {
    return toFleetShardDTO(await withSystemContext((tx) => requireShard(id, tx)));
  },

  /** The account with this name, or null — how `fleet-admin` resumes a run. */
  async findShardByName(name: string): Promise<FleetShardDTO | null> {
    const row = await withSystemContext((tx) => fleetShardRepository.findByName(name, tx));
    return row ? toFleetShardDTO(row) : null;
  },

  /** The accounts of one role (default `primary`), optionally one kind and state. */
  async listShards(
    filter: { fleetKind?: string; role?: FleetShardRoleDTO; state?: FleetShardStateDTO } = {},
  ): Promise<FleetShardDTO[]> {
    const rows = await withSystemContext((tx) =>
      fleetShardRepository.listByRole(
        filter.role ?? 'primary',
        { fleetKind: filter.fleetKind, state: filter.state },
        tx,
      ),
    );
    return rows.map(toFleetShardDTO);
  },

  /** Re-record an account's limits and where each was read (after a raise). The
   *  provider's invariants still hold: a fly account keeps a machine limit. */
  async setLimits(
    id: string,
    limits: FleetShardLimitsInput,
    source: FleetShardLimitsSourceInput,
    now: () => Date = () => new Date(),
  ): Promise<FleetShardDTO> {
    const valid = validLimits(limits);
    const validSource = validLimitsSource(source);
    const row = await withSystemContext(async (tx) => {
      const current = await requireShard(id, tx);
      if (current.provider === 'fly' && valid.machineLimit === null) {
        throw new FleetShardInvalidError('machineLimit', 'a fly account records its machine limit');
      }
      return fleetShardRepository.updateLimits(id, valid, validSource, now(), tx);
    });
    return toFleetShardDTO(row);
  },

  async setState(id: string, state: FleetShardStateDTO): Promise<FleetShardDTO> {
    const row = await withSystemContext(async (tx) => {
      await requireShard(id, tx);
      return fleetShardRepository.updateState(id, state, tx);
    });
    return toFleetShardDTO(row);
  },
};
