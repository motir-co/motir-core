import { type FleetShard, type Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { fleetShardRoleOf, toFleetShardDTO } from '@/lib/mappers/fleetShardMappers';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// THE MOTIR SPARE (Story MOTIR-9362 · MOTIR-9456), against real Postgres: the
// `spare` role is storable, at most one READY spare per fleet kind is a database
// rule (the partial unique index `fleet_shard_one_ready_spare_per_kind`), the
// repository reads and promotes it, and the DTO carries the role as stored.

let seq = 0;

function row(
  overrides: Partial<Prisma.FleetShardUncheckedCreateInput> = {},
): Prisma.FleetShardUncheckedCreateInput {
  seq += 1;
  return {
    name: `spare-test-${seq}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    role: 'spare',
    state: 'active',
    githubOrg: 'motir-projects',
    githubInstallationId: '4242',
    awsAccountId: `11112222${String(seq).padStart(4, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: `FLEET_SHARD_SPARE_TEST_${seq}`,
    vcpuQuota: 64,
    ...overrides,
  };
}

const insert = (overrides: Partial<Prisma.FleetShardUncheckedCreateInput> = {}) =>
  adminDb.fleetShard.create({ data: row(overrides) });

beforeEach(async () => {
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await adminDb.fleetShard.deleteMany({});
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the spare role is stored', () => {
  it('a shard can be stored with role spare', async () => {
    await expect(insert()).resolves.toMatchObject({ role: 'spare', state: 'active' });
  });
});

describe('at most one ready spare per fleet kind', () => {
  it('refuses a second active spare of the same kind', async () => {
    await insert();
    await expect(insert()).rejects.toThrow(/fleet_shard_one_ready_spare_per_kind|Unique/);
  });

  it('refuses promoting a second spare to active beside a ready one', async () => {
    await insert();
    const unready = await insert({ state: 'provisioning' });
    await expect(
      adminDb.fleetShard.update({ where: { id: unready.id }, data: { state: 'active' } }),
    ).rejects.toThrow(/fleet_shard_one_ready_spare_per_kind|Unique/);
  });

  it('accepts a spare of another kind, a disabled spare beside a new one, and unready spares', async () => {
    await insert();
    await expect(insert({ fleetKind: 'hosted_agent' })).resolves.toBeTruthy();

    await insert({ fleetKind: 'code_graph_index', state: 'disabled' });
    await expect(insert({ fleetKind: 'code_graph_index' })).resolves.toBeTruthy();

    // An unready spare (its raise pending) does not count: growth may create the
    // next account as a spare while the kind has one still waiting for quota.
    await expect(insert({ state: 'provisioning' })).resolves.toBeTruthy();
    await expect(insert({ state: 'provisioning' })).resolves.toBeTruthy();
  });

  it('a primary of the kind never collides with its spare', async () => {
    await insert();
    await expect(insert({ role: 'primary' })).resolves.toMatchObject({ role: 'primary' });
    await expect(insert({ role: 'primary' })).resolves.toMatchObject({ role: 'primary' });
  });
});

describe('the repository reads and promotes the spare', () => {
  it('lists the kind’s non-disabled spares, the ready one first', async () => {
    const unready = await insert({ state: 'provisioning' });
    const ready = await insert();
    await insert({ state: 'disabled' });
    await insert({ fleetKind: 'hosted_agent' });
    await insert({ role: 'primary' });

    const spares = await withSystemContext((tx) =>
      fleetShardRepository.listSparesForKind('ci_runner', tx),
    );

    expect(spares.map((s) => s.id)).toEqual([ready.id, unready.id]);
  });

  it('setRoleInTx moves the spare into the shared pool', async () => {
    const spare = await insert();
    const promoted = await adminDb.$transaction((tx) =>
      fleetShardRepository.setRoleInTx(spare.id, 'primary', tx),
    );
    expect(promoted.role).toBe('primary');
    // The kind may then hold a new ready spare.
    await expect(insert()).resolves.toMatchObject({ role: 'spare' });
  });

  it('listActiveForKindInTx answers only the roles asked for', async () => {
    const primary = await insert({ role: 'primary' });
    const spare = await insert();
    await insert({ role: 'primary', state: 'provisioning' });

    const shared = await adminDb.$transaction((tx) =>
      fleetShardRepository.listActiveForKindInTx('ci_runner', ['primary'], tx),
    );
    const all = await adminDb.$transaction((tx) =>
      fleetShardRepository.listActiveForKindInTx('ci_runner', ['primary', 'spare'], tx),
    );

    expect(shared.map((s) => s.id)).toEqual([primary.id]);
    expect(all.map((s) => s.id).sort()).toEqual([primary.id, spare.id].sort());
  });
});

describe('listShards and the DTO carry the role', () => {
  it('lists the spare by its role, and every role with `any`', async () => {
    const spare = await insert();
    const primary = await insert({ role: 'primary' });

    expect((await fleetShardService.listShards({ role: 'spare' })).map((s) => s.id)).toEqual([
      spare.id,
    ]);
    expect((await fleetShardService.listShards()).map((s) => s.id)).toEqual([primary.id]);
    expect((await fleetShardService.listShards({ role: 'any' })).map((s) => s.role).sort()).toEqual(
      ['primary', 'spare'],
    );
  });

  it('the DTO exposes the role, and an unknown role keeps its identity', async () => {
    const spare = await insert();
    expect(toFleetShardDTO(spare).role).toBe('spare');

    const unknown = { ...spare, role: 'reserve' } as unknown as FleetShard;
    expect(toFleetShardDTO(unknown).role).toBe('reserve');
    expect(fleetShardRoleOf('reserve')).toBe('reserve');
  });
});
