import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import {
  fleetAttributionService,
  FLEET_ATTRIBUTION_GRACE_MS,
} from '@/lib/services/fleetAttributionService';
import { adminDb } from '../helpers/adminDb';
import {
  configureHoster,
  freeRoom,
  seedHosterAccount,
  type HosterAccount,
} from '../helpers/agentHosterFixture';
import { clock, fleet, fx, MIN, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));
vi.mock('@motir/orchestrator', async () =>
  (await import('../helpers/agentHosterFixture')).hosterOrchestratorPackage(),
);
vi.mock('@/lib/orchestrator', async (importOriginal) =>
  (await import('../helpers/agentHosterFixture')).hosterCompositionRoot(
    await importOriginal<Record<string, unknown>>(),
  ),
);

// A MACHINE STARTED BY HAND IN A HOSTER ACCOUNT IS DESTROYED (Story MOTIR-9361 ·
// MOTIR-9477), against a real Postgres: live instances made by the product in two
// AWS hoster accounts (the real AWS adapter over each account's in-memory EC2) and
// on Fly (the Fly fake), plus two machines nobody recorded — one carrying only the
// account's tag, one untagged. One reconciler pass destroys exactly the two, with
// a kill record and a platform alert each, and leaves every live machine alone.

const answer = (): PersistentExecResult => ({ exitCode: 0, stdout: '', stderr: '' });

let a: HosterAccount;
let b: HosterAccount;
let switchOn = false;

beforeEach(async () => {
  await setUpHarness();
  fleet.setExecResponder(answer);
  captureException.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await adminDb.fleetMachineKill.deleteMany({});
  await configureHoster({
    now: () => clock.now(),
    sleep: async (ms) => clock.advance(ms),
    answer,
  });
  a = await seedHosterAccount('agent-hoster-a', 10);
  b = await seedHosterAccount('agent-hoster-b', 2);
  switchOn = false;
  wireFleetKindSwitch('agent_instance', () => switchOn);
});

afterEach(async () => {
  wireFleetKindSwitch('agent_instance', null);
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const create = async (name: string) => {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
};

describe('the reconciler over the assembled hoster', () => {
  it('destroys a hand-started machine in each account, with a kill record and an alert, and spares every live instance', async () => {
    const onFly = await create('on-fly');
    switchOn = true;
    const onA = await create('on-a');
    // A is out of the running, so the next instance lands on B.
    await adminDb.fleetShard.update({
      where: { id: a.shard.id },
      data: { admissionPausedUntil: new Date('2999-01-01T00:00:00Z') },
    });
    const onB = await create('on-b');
    await freeRoom(a);
    expect([onA.fleetShardId, onB.fleetShardId]).toEqual([a.shard.id, b.shard.id]);

    const launched = new Date(clock.now().getTime() - MIN);
    const shardTagged = a.ec2.plantInstance({
      tags: [{ key: 'motir-shard', value: a.shard.name }],
      launchTime: launched,
    });
    const untagged = b.ec2.plantInstance({ tags: [], launchTime: launched });
    const flyOps = fleet.operations.length;

    const result = await fleetAttributionService.reconcile({
      now: () => new Date(clock.now().getTime() + FLEET_ATTRIBUTION_GRACE_MS + MIN),
      listingRetryDelayMs: 0,
    });

    expect(result).toMatchObject({ outcome: 'reconciled' });
    if (result.outcome !== 'reconciled') return;
    expect(new Set(result.killed.map((k) => k.machineId))).toEqual(
      new Set([shardTagged, untagged]),
    );
    expect(result.killed.every((k) => k.action === 'destroyed')).toBe(true);
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(new Set(kills.map((k) => k.machineId))).toEqual(new Set([shardTagged, untagged]));
    expect(kills.every((k) => k.completedAt !== null)).toBe(true);
    const alerts = captureException.mock.calls.map(([err]) => err as Error);
    for (const machineId of [shardTagged, untagged]) {
      expect(
        alerts.some(
          (e) => e.name === 'UnattributedMachineDestroyedError' && e.message.includes(machineId),
        ),
      ).toBe(true);
    }

    // The live instances' machines and disks are untouched, in both accounts and on Fly.
    expect(a.liveMachines()).toEqual([onA.machineId]);
    expect(b.liveMachines()).toEqual([onB.machineId]);
    expect(a.ec2.instances.get(onA.machineId!)!.state).toBe('running');
    expect(b.ec2.instances.get(onB.machineId!)!.state).toBe('running');
    expect(a.liveVolumes()).toEqual([onA.volumeId]);
    expect(b.liveVolumes()).toEqual([onB.volumeId]);
    expect(fleet.operations.slice(flyOps).some((op) => op.includes(onFly.machineId!))).toBe(false);
  });
});
