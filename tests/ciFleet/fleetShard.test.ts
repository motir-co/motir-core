import { type Prisma } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  FleetShardInvalidError,
  FleetShardNotFoundError,
  FleetShardTakenError,
} from '@/lib/ciFleet/errors';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { adminDb } from '../helpers/adminDb';

// The FLEET ACCOUNT RECORD (Story MOTIR-8953 · MOTIR-8961), against real
// Postgres: the database holds every invariant on its own (direct writes through
// the owner client, which skips the service), the service refuses the same rows
// first with typed errors, and no secret ever reaches the row or the DTO.

const FLY_ROW: Prisma.FleetShardUncheckedCreateInput = {
  name: 'ci-runner-iad-1',
  fleetKind: 'ci_runner',
  provider: 'fly',
  githubOrg: 'motir-projects',
  githubInstallationId: '4242',
  flyOrg: 'motir',
  flyApp: 'motir-ci-fleet',
  flyRegion: 'iad',
  credentialRef: 'FLY_FLEET_API_TOKEN',
  machineLimit: 100,
};

const INPUT: CreateFleetShardInput = {
  name: 'ci-runner-iad-1',
  fleetKind: 'ci_runner',
  provider: 'fly',
  githubOrg: 'motir-projects',
  githubInstallationId: '4242',
  flyOrg: 'motir',
  flyApp: 'motir-ci-fleet',
  flyRegion: 'iad',
  credentialRef: 'FLY_FLEET_API_TOKEN',
  limits: { machineLimit: 100, githubRegistrationsPer5Min: 1500 },
  limitsSource: { machineLimit: 'provider_read', githubRegistrationsPer5Min: 'documented' },
};

beforeEach(async () => {
  await adminDb.fleetShard.deleteMany({});
});

afterEach(() => {
  delete process.env['FLEET_SHARD_TEST_SECRET'];
});

afterAll(async () => {
  // No account row outlives this file: the owned-org set reads them (MOTIR-8974).
  await adminDb.fleetShard.deleteMany({});
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the database holds the invariants on its own', () => {
  const insert = (overrides: Partial<Prisma.FleetShardUncheckedCreateInput>) =>
    adminDb.fleetShard.create({ data: { ...FLY_ROW, ...overrides } });

  it('accepts a complete fly account', async () => {
    await expect(insert({})).resolves.toMatchObject({ state: 'provisioning', role: 'primary' });
  });

  it('refuses a row without a fleet kind, or with a kind outside the three', async () => {
    await expect(
      adminDb.$executeRawUnsafe(
        `INSERT INTO fleet_shard (id, name, provider, github_org, github_installation_id, fly_org, fly_app, fly_region, credential_ref, machine_limit, updated_at)
         VALUES ('x', 'no-kind', 'fly', 'o', '1', 'motir', 'a', 'iad', 'FLY_FLEET_API_TOKEN', 1, now())`,
      ),
    ).rejects.toThrow(/fleet_kind/);
    await expect(insert({ fleetKind: 'gpu_burst' })).rejects.toThrow(
      /fleet_shard_fleet_kind_check/,
    );
  });

  it.each([['flyApp'], ['flyRegion'], ['flyOrg'], ['machineLimit']] as const)(
    'refuses a fly account without %s',
    async (column) => {
      await expect(insert({ [column]: null })).rejects.toThrow(/fleet_shard_fly_location_check/);
    },
  );

  it.each([
    ['vcpuQuota', 0],
    ['machineLimit', -1],
    ['githubRegistrationsPer5Min', 0],
    ['githubApiPerHour', -5],
  ] as const)('refuses %s = %d', async (column, value) => {
    await expect(insert({ [column]: value })).rejects.toThrow(/fleet_shard_limits_positive_check/);
  });

  it('refuses two accounts on the same fly org and app', async () => {
    await insert({});
    await expect(insert({ name: 'ci-runner-iad-2' })).rejects.toThrow(/Unique constraint/i);
  });
});

describe('fleetShardService.createShard refuses with a typed error first', () => {
  const refusal = (input: Partial<CreateFleetShardInput>) =>
    fleetShardService.createShard({ ...INPUT, ...input }).then(
      () => null,
      (err: unknown) => err,
    );

  it.each([
    ['a bad slug', { name: 'CI Runner!' }, 'name'],
    ['an unknown fleet kind', { fleetKind: 'gpu_burst' }, 'fleetKind'],
    [
      'a credentialRef that is not a variable name',
      { credentialRef: 'fly_live_abc123' },
      'credentialRef',
    ],
    ['a fly account without its app', { flyApp: null }, 'flyLocation'],
    ['a fly account without its region', { flyRegion: '' }, 'flyLocation'],
    ['a fly account without a machine limit', { limits: {} }, 'machineLimit'],
    ['a zero limit', { limits: { machineLimit: 0 } }, 'limit'],
    ['a non-numeric installation', { githubInstallationId: 'abc' }, 'githubInstallationId'],
    [
      'an unknown limit source',
      { limitsSource: { machineLimit: 'guessed' as never } },
      'limitsSource',
    ],
  ] as const)('%s', async (_label, input, field) => {
    const err = await refusal(input as Partial<CreateFleetShardInput>);
    expect(err).toBeInstanceOf(FleetShardInvalidError);
    expect((err as FleetShardInvalidError).field).toBe(field);
    expect(await adminDb.fleetShard.count()).toBe(0);
  });

  it('a taken name or location is FleetShardTakenError, not a Prisma error', async () => {
    await fleetShardService.createShard(INPUT);
    await expect(
      fleetShardService.createShard({ ...INPUT, name: 'ci-runner-iad-2' }),
    ).rejects.toBeInstanceOf(FleetShardTakenError);
  });

  it('creates the account and answers its DTO, limits and their source', async () => {
    const at = new Date('2026-10-23T12:00:00.000Z');
    const dto = await fleetShardService.createShard(INPUT, () => at);
    expect(dto).toMatchObject({
      name: 'ci-runner-iad-1',
      fleetKind: 'ci_runner',
      provider: 'fly',
      role: 'primary',
      state: 'provisioning',
      github: { org: 'motir-projects', installationId: '4242', appRole: 'provisioning' },
      fly: { org: 'motir', app: 'motir-ci-fleet', region: 'iad' },
      credentialRef: 'FLY_FLEET_API_TOKEN',
      limits: {
        vcpuQuota: null,
        machineLimit: 100,
        githubRegistrationsPer5Min: 1500,
        githubApiPerHour: null,
      },
      limitsSource: { machineLimit: 'provider_read', githubRegistrationsPer5Min: 'documented' },
      limitsVerifiedAt: at.toISOString(),
    });
    expect(await fleetShardService.getShard(dto.id)).toEqual(dto);
  });
});

describe('listShards answers one kind, role and state', () => {
  it('returns only the active ci_runner accounts', async () => {
    const active = await fleetShardService.createShard({ ...INPUT, state: 'active' });
    await fleetShardService.createShard({ ...INPUT, name: 'ci-runner-iad-2', flyApp: 'b' });
    const disabled = await fleetShardService.createShard({
      ...INPUT,
      name: 'ci-runner-iad-3',
      flyApp: 'c',
    });
    await fleetShardService.setState(disabled.id, 'disabled');
    await fleetShardService.createShard({
      ...INPUT,
      name: 'hosted-agent-iad-1',
      fleetKind: 'hosted_agent',
      flyApp: 'd',
      state: 'active',
    });

    const listed = await fleetShardService.listShards({
      fleetKind: 'ci_runner',
      role: 'primary',
      state: 'active',
    });

    expect(listed.map((s) => s.id)).toEqual([active.id]);
    expect(await fleetShardService.listShards({ fleetKind: 'hosted_agent' })).toHaveLength(1);
    expect(await fleetShardService.listShards()).toHaveLength(4);
  });
});

describe('setLimits and setState', () => {
  it('re-records the limits with their source and verification instant', async () => {
    const shard = await fleetShardService.createShard(INPUT);
    const at = new Date('2026-10-24T09:00:00.000Z');

    const raised = await fleetShardService.setLimits(
      shard.id,
      { machineLimit: 400, vcpuQuota: 1600 },
      { machineLimit: 'raised', vcpuQuota: 'provider_read' },
      () => at,
    );

    expect(raised.limits).toMatchObject({
      machineLimit: 400,
      vcpuQuota: 1600,
      githubRegistrationsPer5Min: null,
    });
    expect(raised.limitsSource).toEqual({ machineLimit: 'raised', vcpuQuota: 'provider_read' });
    expect(raised.limitsVerifiedAt).toBe(at.toISOString());
  });

  it('keeps a fly account’s machine limit', async () => {
    const shard = await fleetShardService.createShard(INPUT);
    await expect(fleetShardService.setLimits(shard.id, { vcpuQuota: 8 }, {})).rejects.toMatchObject(
      {
        field: 'machineLimit',
      },
    );
  });

  it('refuses an unknown account', async () => {
    await expect(fleetShardService.setState('nope', 'active')).rejects.toBeInstanceOf(
      FleetShardNotFoundError,
    );
    await expect(fleetShardService.getShard('nope')).rejects.toBeInstanceOf(
      FleetShardNotFoundError,
    );
    await expect(
      fleetShardService.setLimits('nope', { machineLimit: 1 }, {}),
    ).rejects.toBeInstanceOf(FleetShardNotFoundError);
  });
});

describe('no secret reaches the row or the DTO', () => {
  it('stores and answers the variable NAME, never its value', async () => {
    const secret = 'fo1_live_d0-not-store-me';
    process.env['FLEET_SHARD_TEST_SECRET'] = secret;

    const dto = await fleetShardService.createShard({
      ...INPUT,
      credentialRef: 'FLEET_SHARD_TEST_SECRET',
    });

    expect(JSON.stringify(dto)).not.toContain(secret);
    expect(JSON.stringify(await adminDb.fleetShard.findMany())).not.toContain(secret);
    expect(dto.credentialRef).toBe('FLEET_SHARD_TEST_SECRET');
  });
});

describe('the table is platform-only', () => {
  it('a context without system_admin, as the runtime role, sees no account', async () => {
    await fleetShardService.createShard(INPUT);
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.fleetShard.findMany();
    });
    expect(seen).toEqual([]);
  });
});
