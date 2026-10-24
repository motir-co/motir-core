import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakePersistentOrchestrator as fleet,
  OrchestratorNotConfiguredError,
} from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import {
  fakePersistentOrchestratorForShard,
  getPersistentOrchestrator,
  resetShardFakes,
} from '@/lib/orchestrator';
import {
  agentInstanceBootSteps,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { adminDb } from '../helpers/adminDb';
import { fx, setUpHarness, tearDownHarness } from './_harness';

// ROUTING BY THE RECORDED ACCOUNT (Story MOTIR-9361 · MOTIR-9472), against a real
// Postgres and the fake fleet. Each account answers through its own view of the
// shared persistent fake, which records the operations IT was asked for, so a
// test sees where every call of an instance went. Create places by the switch;
// wake, hibernate, boot and delete follow the row, whatever the switch says.

let seq = 0;

async function seedShard(name: string, machineLimit = 10): Promise<FleetShard> {
  return adminDb.fleetShard.create({
    data: {
      name,
      fleetKind: 'agent_instance',
      provider: 'aws',
      state: 'active',
      githubOrg: 'motir-co',
      githubInstallationId: '556677',
      awsAccountId: `3333${String(seq++).padStart(8, '0')}`,
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
      machineLimit,
    },
  });
}

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await setUpHarness();
  resetShardFakes();
  wireFleetKindSwitch('agent_instance', null);
});

afterEach(async () => {
  wireFleetKindSwitch('agent_instance', null);
  resetShardFakes();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const create = (name = 'yue-claude') =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);

describe('persistentOrchestratorFor', () => {
  it('a null account is exactly the process-wide orchestrator', async () => {
    expect(
      await fleetShardOrchestratorService.persistentOrchestratorFor({ fleetShardId: null }),
    ).toBe(getPersistentOrchestrator());
  });

  it('a recorded account is that account’s orchestrator, and one not on record is refused by name', async () => {
    const a = await seedShard('agent-hoster-a');
    expect(
      await fleetShardOrchestratorService.persistentOrchestratorFor({ fleetShardId: a.id }),
    ).toBe(fakePersistentOrchestratorForShard(a.id));
    const err = await fleetShardOrchestratorService
      .persistentOrchestratorFor({ fleetShardId: 'no-such-account' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorNotConfiguredError);
    expect((err as Error).message).toContain('no-such-account');
  });
});

describe('create places; every later step follows the record', () => {
  it('with the switch off, creates on the process-wide orchestrator and records no account', async () => {
    const a = await seedShard('agent-hoster-a');
    const dto = await create();
    expect(dto.state).toBe('running');
    expect((await rowOf(dto.id)).fleetShardId).toBeNull();
    expect(fakePersistentOrchestratorForShard(a.id).calls).toEqual([]);
  });

  it('keeps reaching account A for hibernate, wake, boot and delete while the switch flips off, on and off', async () => {
    const provision = vi.spyOn(fleet, 'provisionPersistent');
    const stop = vi.spyOn(fleet, 'stop');
    const start = vi.spyOn(fleet, 'start');
    const destroy = vi.spyOn(fleet, 'destroyPersistent');
    const a = await seedShard('agent-hoster-a', 10);
    const b = await seedShard('agent-hoster-b', 2);
    wireFleetKindSwitch('agent_instance', () => true);

    const dto = await create();
    expect(dto.state).toBe('running');
    const placed = await rowOf(dto.id);
    expect(placed).toMatchObject({ fleetShardId: a.id, availabilityZone: 'us-east-1a' });
    const viewA = fakePersistentOrchestratorForShard(a.id);
    const viewB = fakePersistentOrchestratorForShard(b.id);
    expect(viewA.calls).toContain('provisionPersistent');
    // The boot's machine start read the machine through A.
    expect(viewA.calls).toContain('describePersistent');
    expect(provision).toHaveBeenCalledTimes(1);

    // The handle names A's provider and carries the row's zone.
    const { handle } = await agentInstanceBootSteps.routeOf(placed);
    expect(handle).toMatchObject({ availabilityZone: 'us-east-1a', machineId: placed.machineId });

    for (const on of [false, true, false]) {
      wireFleetKindSwitch('agent_instance', () => on);
      await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
      expect((await rowOf(dto.id)).state).toBe('hibernated');
      await lifecycle.wake(fx.projectIdentifier, dto.id, fx.ctx);
      expect(await rowOf(dto.id)).toMatchObject({
        state: 'running',
        fleetShardId: a.id,
        availabilityZone: 'us-east-1a',
      });
    }
    // Every stop and start went through A: none reached the fake any other way.
    expect(viewA.calls.filter((c) => c === 'stop')).toHaveLength(3);
    expect(viewA.calls.filter((c) => c === 'start')).toHaveLength(3);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(start).toHaveBeenCalledTimes(3);

    await lifecycle.delete(fx.projectIdentifier, dto.id, fx.ctx);
    expect(viewA.calls).toContain('destroyPersistent');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect((await rowOf(dto.id)).deletedAt).not.toBeNull();
    expect(fleet.operations).toContain(`volume:destroy:${placed.volumeId}`);
    expect(viewB.calls).toEqual([]);
  });

  it('a retried delete after a refused destroy lands on the same account', async () => {
    const a = await seedShard('agent-hoster-a');
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    wireFleetKindSwitch('agent_instance', () => false);
    fleet.failNextDestroy();
    await lifecycle.delete(fx.projectIdentifier, dto.id, fx.ctx);
    expect((await rowOf(dto.id)).state).toBe('deleting');
    expect(await lifecycle.settleDelete(dto.id)).toBe('deleted');
    expect(
      fakePersistentOrchestratorForShard(a.id).calls.filter((c) => c === 'destroyPersistent'),
    ).toHaveLength(2);
  });

  it('with the switch on and every account full, creates no machine anywhere and records no account', async () => {
    const provision = vi.spyOn(fleet, 'provisionPersistent');
    const full = await seedShard('agent-hoster-full', 1);
    await adminDb.fleetShard.update({
      where: { id: full.id },
      data: { admissionPausedUntil: new Date('2999-01-01T00:00:00Z') },
    });
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    expect(provision).not.toHaveBeenCalled();
    expect(await rowOf(dto.id)).toMatchObject({
      fleetShardId: null,
      availabilityZone: null,
      machineId: null,
    });
    expect(fakePersistentOrchestratorForShard(full.id).calls).toEqual([]);
  });

  it('an unplaced instance is handled exactly as before: the process-wide handle, no zone', async () => {
    const dto = await create();
    const row = await rowOf(dto.id);
    const { orchestrator, handle } = await agentInstanceBootSteps.routeOf(row);
    expect(orchestrator).toBe(getPersistentOrchestrator());
    expect(handle).toEqual(agentInstanceBootSteps.handleOf(row));
    expect(handle).not.toHaveProperty('availabilityZone');
  });
});
