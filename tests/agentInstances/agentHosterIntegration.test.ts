import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import { AGENT_WAITING_POLL_MS } from '@/lib/agentInstances/config';
import { imageCatalogSeam } from '@/lib/agentInstances/imageCatalog';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { fleetPoolGrowthPassService } from '@/lib/services/fleetPoolGrowthPassService';
import { db } from '@/lib/db';
import {
  agentInstanceBootSteps,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceBootService } from '@/lib/services/agentInstanceBootService';
import { agentInstanceRunService as runs } from '@/lib/services/agentInstanceRunService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { agentTerminalService } from '@/lib/services/agentTerminalService';
import {
  agentTerminalClock,
  agentTerminalRelayService as relay,
} from '@/lib/services/agentTerminalRelayService';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../helpers/adminDb';
import { driveBoot } from '../helpers/agentBootDriver';
import {
  configureHoster,
  ec2CallsOf,
  fillAccount,
  freeRoom,
  seedHosterAccount,
  type HosterAccount,
} from '../helpers/agentHosterFixture';
import { truncateJobRuns } from '../helpers/db';
import { clock, fleet, fx, seedRepo, setUpHarness, tearDownHarness } from './_harness';

vi.mock('@motir/orchestrator', async () =>
  (await import('../helpers/agentHosterFixture')).hosterOrchestratorPackage(),
);
vi.mock('@/lib/orchestrator', async (importOriginal) =>
  (await import('../helpers/agentHosterFixture')).hosterCompositionRoot(
    await importOriginal<Record<string, unknown>>(),
  ),
);

// THE STORY'S INTEGRATION GATE (Story MOTIR-9361 · MOTIR-9477), against a real
// Postgres: two AWS hoster accounts, each the real AWS persistent adapter over its
// own in-memory EC2 and host agent, and the Fly fake as the process-wide
// orchestrator. One instance life is driven across both providers, with the
// switch flipped in the middle, in the order of the story's recipe. A call that
// wrongly reaches Fly shows as a Fly-fake call; one that reaches the wrong
// account shows in that account's EC2 or host-agent log.
//
// It adds no behaviour. A case that fails is a finding in the owning card's code.

const MASTER = 'm'.repeat(48);
const HOME_FILE = '/home/node/notes.txt';

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: 'signed_in' })}\n`);
  }
  if (line.includes('motir agent-terminal run ') && !line.endsWith('--help')) {
    return ok('{"session":"sess-1"}\n');
  }
  return ok();
}

/** How many times the switch was read since the counter was last reset. */
let switchReads = 0;
let switchOn = false;
function setSwitch(on: boolean): void {
  switchOn = on;
}

let a: HosterAccount;
let b: HosterAccount;

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  imageCatalogSeam.reset();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.stubEnv('MOTIR_RELAY_URL', '');
  vi.spyOn(agentTerminalClock, 'now').mockImplementation(() => clock.now());
  fleet.setExecResponder(answer);
  await configureHoster({
    now: () => clock.now(),
    sleep: async (ms) => clock.advance(ms),
    answer,
  });
  await seedRepo('acme', 'web');
  // A has more headroom than B.
  a = await seedHosterAccount('agent-hoster-a', 10);
  b = await seedHosterAccount('agent-hoster-b', 2);
  // The pool-growth pass (MOTIR-9362) is a cron the harness drains with every
  // job; it reads each kind's switch, and the reads counted here are the
  // instance's own.
  vi.spyOn(fleetPoolGrowthPassService, 'runGrowthPass').mockResolvedValue({
    ran: false,
    kinds: {},
    requestAlerts: 0,
    failures: 0,
  });
  switchReads = 0;
  switchOn = false;
  wireFleetKindSwitch('agent_instance', () => {
    switchReads += 1;
    return switchOn;
  });
});

afterEach(async () => {
  wireFleetKindSwitch('agent_instance', null);
  imageCatalogSeam.reset();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const create = (name: string) =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
const flyOps = () => fleet.operations.length;
const execOn = async (id: string, command: string[], stdin?: string) => {
  const row = await rowOf(id);
  const { orchestrator, handle } = await agentInstanceBootSteps.routeOf(row);
  if (!handle) throw new Error(`instance ${id} has no machine`);
  return orchestrator.exec(handle, command, stdin === undefined ? {} : { stdin });
};

describe('the agent hoster, assembled', () => {
  it('switch off: a new instance is created on Fly, and no hoster account holds anything', async () => {
    const dto = await create('on-fly');
    expect(dto.state).toBe('running');
    const row = await rowOf(dto.id);
    expect(row).toMatchObject({ fleetShardId: null, availabilityZone: null });
    expect(fleet.operations.some((op) => op.includes(row.machineId!))).toBe(true);
    expect(fleet.operations).toContain(`volume:create:${row.volumeId}`);
    expect(a.liveMachines()).toEqual([]);
    expect(b.liveMachines()).toEqual([]);
    expect(a.liveVolumes()).toEqual([]);
    expect(b.liveVolumes()).toEqual([]);
    const { handle } = await agentInstanceBootSteps.routeOf(row);
    expect(handle?.provider).not.toBe('aws');
  });

  it('switch on: a new instance is placed on the account with most headroom, its machine and disk in the recorded zone', async () => {
    await create('on-fly');
    const flyBefore = flyOps();
    setSwitch(true);
    const dto = await create('on-aws');
    expect(dto.state).toBe('running');
    const row = await rowOf(dto.id);
    expect(row).toMatchObject({ fleetShardId: a.shard.id, availabilityZone: 'us-east-1a' });
    expect(a.liveMachines()).toEqual([row.machineId]);
    expect(a.liveVolumes()).toEqual([row.volumeId]);
    const machine = a.ec2.instances.get(row.machineId!)!;
    expect(machine.availabilityZone).toBe('us-east-1a');
    expect(a.ec2.volumes.get(row.volumeId!)!.availabilityZone).toBe('us-east-1a');
    expect(machine.tags).toContainEqual({ key: 'motir_instance_id', value: dto.id });
    expect(b.liveMachines()).toEqual([]);
    expect(ec2CallsOf(b, 'runInstances')).toBe(0);
    expect(flyOps()).toBe(flyBefore);
  });

  it('an AWS instance hibernates and wakes on its own machine and disk, and a file in its home survives', async () => {
    const id = await placedOnA();
    const placed = await rowOf(id);
    await execOn(id, ['tee', HOME_FILE], 'kept across a stop');

    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    expect((await rowOf(id)).state).toBe('hibernated');
    expect(a.ec2.instances.get(placed.machineId!)!.state).toBe('stopped');
    await lifecycle.wake(fx.projectIdentifier, id, fx.ctx);

    expect(await rowOf(id)).toMatchObject({
      state: 'running',
      fleetShardId: a.shard.id,
      availabilityZone: 'us-east-1a',
      machineId: placed.machineId,
      volumeId: placed.volumeId,
    });
    expect(ec2CallsOf(a, 'deleteVolume')).toBe(0);
    expect(a.liveVolumes()).toEqual([placed.volumeId]);
    expect((await execOn(id, ['cat', HOME_FILE])).stdout).toBe('kept across a stop');
  });

  it('a run on the AWS instance is executed on account A only', async () => {
    const id = await placedOnA();
    const flyExecs = fleet.execs.length;
    const execsOnA = a.execs.length;
    const item = await card();
    const { dispatchRunId } = await runs.start(
      { workItemKey: item.identifier, agentInstanceId: id },
      fx.ctx,
    );
    expect(await runs.launchNow(dispatchRunId)).toBe('launched');
    const launched = a.execs.slice(execsOnA);
    expect(launched.some((e) => e.command.join(' ').includes('motir agent-terminal run '))).toBe(
      true,
    );
    expect(launched.every((e) => e.machineId === a.liveMachines()[0])).toBe(true);
    expect(fleet.execs.length).toBe(flyExecs);
    expect(b.execs).toEqual([]);
  });

  it('with the switch off, on and off again, every operation of the AWS instance reaches A, never Fly, and none reads the switch', async () => {
    const id = await placedOnA();
    const placed = await rowOf(id);
    const flyBefore = flyOps();
    const flyExecs = fleet.execs.length;
    let version = 1;
    for (const on of [false, true, false]) {
      setSwitch(on);
      switchReads = 0;
      const before = { calls: ec2CallsOf(a), execs: a.execs.length };

      await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
      await lifecycle.wake(fx.projectIdentifier, id, fx.ctx);
      expect((await rowOf(id)).state).toBe('running');
      // exec, the sign-in probe and the reconcile (liveness of the record).
      expect((await execOn(id, ['tee', HOME_FILE], `pass ${String(on)}`)).exitCode).toBe(0);
      expect(await lifecycle.probeSignIn(id)).toBe('signed_in');
      expect(await lifecycle.reconcileRunning(id)).toBe('ok');
      // The terminal endpoint the relay dials is A's machine, on its host agent.
      const { ticket } = await agentTerminalService.issueTicket(fx.projectIdentifier, id, fx.ctx);
      const authorized = await relay.authorizeConnection(ticket);
      expect(authorized.ok).toBe(true);
      const address = a.ec2.instances.get(placed.machineId!)!.publicIpAddress;
      if (authorized.ok) expect(authorized.target.dial.url).toContain(`wss://${address}:8443/`);
      // An image update moves the image on A's machine and checks its liveness there.
      version += 1;
      imageCatalogSeam.setFakeNewest('claude', `1.${version}.0`);
      expect(await lifecycle.update(fx.projectIdentifier, id, fx.ctx)).toMatchObject({
        state: 'running',
        imageVersion: `1.${version}.0`,
      });
      // A sweep pass reconciles it through A.
      expect((await sweeper.sweep()).errors).toBe(0);

      expect(await rowOf(id)).toMatchObject({
        state: 'running',
        fleetShardId: a.shard.id,
        availabilityZone: 'us-east-1a',
        machineId: placed.machineId,
        volumeId: placed.volumeId,
      });
      expect(ec2CallsOf(a, 'stopInstances')).toBeGreaterThan(0);
      expect(ec2CallsOf(a)).toBeGreaterThan(before.calls);
      expect(a.execs.length).toBeGreaterThan(before.execs);
      expect(switchReads).toBe(0);
    }
    expect(flyOps()).toBe(flyBefore);
    expect(fleet.execs.length).toBe(flyExecs);
    expect(ec2CallsOf(b, 'runInstances') + ec2CallsOf(b, 'startInstances')).toBe(0);
    expect(b.execs).toEqual([]);

    // Delete, too, reaches A whatever the switch says.
    setSwitch(true);
    switchReads = 0;
    await lifecycle.delete(fx.projectIdentifier, id, fx.ctx);
    expect((await rowOf(id)).deletedAt).not.toBeNull();
    expect(a.liveMachines()).toEqual([]);
    expect(switchReads).toBe(0);
    expect(flyOps()).toBe(flyBefore);
  });

  it('the Fly instance made with the switch off still lives on Fly after the switch was on and off', async () => {
    const flyId = (await create('on-fly')).id;
    const onFly = await rowOf(flyId);
    setSwitch(true);
    await create('on-aws');
    setSwitch(false);

    expect(await rowOf(flyId)).toMatchObject({ fleetShardId: null, machineId: onFly.machineId });
    expect(a.liveMachines()).toHaveLength(1);
    expect(a.liveMachines()).not.toContain(onFly.machineId);
    expect(b.liveMachines()).toEqual([]);
    const awsCalls = ec2CallsOf(a) + ec2CallsOf(b);
    for (const on of [true, false]) {
      setSwitch(on);
      const flyBefore = flyOps();
      await lifecycle.hibernate(fx.projectIdentifier, flyId, fx.ctx);
      await lifecycle.wake(fx.projectIdentifier, flyId, fx.ctx);
      expect(fleet.operations.slice(flyBefore).length).toBeGreaterThan(0);
      expect(await rowOf(flyId)).toMatchObject({
        state: 'running',
        fleetShardId: null,
        machineId: onFly.machineId,
        volumeId: onFly.volumeId,
      });
    }
    expect(fleet.operations).not.toContain(`volume:destroy:${onFly.volumeId}`);
    expect(ec2CallsOf(a) + ec2CallsOf(b)).toBe(awsCalls);
  });

  it('with both accounts full a new instance waits for room in the pool, creating and failing nothing', async () => {
    await placedOnA();
    fillAccount(a);
    fillAccount(b);
    const fail = vi.spyOn(agentInstanceBootSteps, 'failInstance');
    const machinesBefore = [a.liveMachines().length, b.liveMachines().length];
    const flyBefore = flyOps();
    setSwitch(true);

    const dto = await create('waits');
    expect(dto.state).toBe('starting');
    expect(await rowOf(dto.id)).toMatchObject({
      state: 'starting',
      fleetShardId: null,
      availabilityZone: null,
      machineId: null,
      volumeId: null,
    });
    const provision = await provisionStep(dto.id);
    expect(provision).toMatchObject({ state: 'in_progress' });
    expect(provision.waiting).toEqual({ reason: 'pool', since: provision.startedAt });
    expect([a.liveMachines().length, b.liveMachines().length]).toEqual(machinesBefore);
    expect(flyOps()).toBe(flyBefore);
    expect(fail).not.toHaveBeenCalled();

    // Room on B only: the next pass creates it there.
    await freeRoom(b);
    expect(await driveUntilSettled(dto.id)).toBe('running');
    const row = await rowOf(dto.id);
    expect(row).toMatchObject({ state: 'running', fleetShardId: b.shard.id });
    expect(b.liveMachines()).toEqual([row.machineId]);
    expect(b.liveVolumes()).toEqual([row.volumeId]);
    expect((await provisionStep(dto.id)).waiting).toBeNull();
    expect(flyOps()).toBe(flyBefore);
  });

  it('a hibernated AWS instance whose account is full waits for its own account, and starts there with the same disk', async () => {
    const id = await placedOnA();
    const placed = await rowOf(id);
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    fillAccount(a);
    const flyBefore = flyOps();
    const startsOnA = ec2CallsOf(a, 'startInstances');

    const woken = await lifecycle.wake(fx.projectIdentifier, id, fx.ctx);
    expect(woken.state).toBe('waking');
    expect(await driveUntilSettled(id, 3)).toBe('pending');
    expect((await rowOf(id)).state).toBe('waking');
    const provision = await provisionStep(id);
    expect(provision.waiting).toMatchObject({ reason: 'account' });
    expect(ec2CallsOf(a, 'startInstances')).toBeGreaterThan(startsOnA);
    // B has room, and is never asked; nor is Fly.
    expect(ec2CallsOf(b, 'runInstances') + ec2CallsOf(b, 'startInstances')).toBe(0);
    expect(flyOps()).toBe(flyBefore);

    await freeRoom(a);
    expect(await driveUntilSettled(id)).toBe('running');
    expect(await rowOf(id)).toMatchObject({
      state: 'running',
      fleetShardId: a.shard.id,
      machineId: placed.machineId,
      volumeId: placed.volumeId,
    });
    expect(a.ec2.instances.get(placed.machineId!)!.state).toBe('running');
  });

  it('a delete terminates the machine, then deletes the disk, and leaves nothing for the reconciler', async () => {
    const id = await placedOnA();
    const placed = await rowOf(id);
    await lifecycle.delete(fx.projectIdentifier, id, fx.ctx);
    expect((await rowOf(id)).deletedAt).not.toBeNull();
    expect(a.teardownLog()).toEqual([`machine:${placed.machineId}`, `volume:${placed.volumeId}`]);
    expect(a.liveMachines()).toEqual([]);
    expect(a.liveVolumes()).toEqual([]);
    const result = await fleetAttributionService.reconcile({
      now: () => new Date(clock.now().getTime() + 24 * 3_600_000),
      listingRetryDelayMs: 0,
    });
    expect(result).toMatchObject({ outcome: 'reconciled' });
    if (result.outcome === 'reconciled') expect(result.killed).toEqual([]);
  });

  it('with the switch off throughout, a Fly instance’s create, wake, hibernate, terminal and delete run as they did', async () => {
    const dto = await create('on-fly');
    const row = await rowOf(dto.id);
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    await lifecycle.wake(fx.projectIdentifier, dto.id, fx.ctx);
    const { ticket } = await agentTerminalService.issueTicket(fx.projectIdentifier, dto.id, fx.ctx);
    expect((await relay.authorizeConnection(ticket)).ok).toBe(true);
    await lifecycle.delete(fx.projectIdentifier, dto.id, fx.ctx);
    expect(
      fleet.operations.filter((op) => op.includes(row.machineId!) || op.includes(row.volumeId!)),
    ).toEqual(FLY_LIFE(row.machineId!, row.volumeId!));
    expect(ec2CallsOf(a) + ec2CallsOf(b)).toBe(0);
    expect(switchReads).toBe(1);
  });
});

/** An instance on Fly (switch off), then one placed on A (switch on); answers the second. */
async function placedOnA(): Promise<string> {
  await create('on-fly');
  setSwitch(true);
  const dto = await create('on-aws');
  expect(dto.state).toBe('running');
  expect((await rowOf(dto.id)).fleetShardId).toBe(a.shard.id);
  setSwitch(false);
  return dto.id;
}

const card = () =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'a card' },
    fx.ctx,
  );

const readBoot = (id: string) =>
  agentInstanceBootService.readBoot(fx.projectIdentifier, id, fx.ctx);

async function provisionStep(id: string) {
  return (await readBoot(id))!.steps.find((s) => s.step === 'provision')!;
}

/** Drive the boot until it stops waiting, at most `passes` passes. */
async function driveUntilSettled(id: string, passes = 20): Promise<string> {
  for (let i = 0; i < passes; i += 1) {
    const result = await driveBoot(id);
    if (result !== 'pending') return result;
    clock.advance(AGENT_WAITING_POLL_MS);
  }
  return 'pending';
}

/** The Fly fake's operations for one instance's life — create, its boot's five
 *  execs (clone and probes), hibernate, wake and its probe, delete — exactly as
 *  the same life records them at origin/main (read 2026-10-24, before this story). */
const FLY_LIFE = (machineId: string, volumeId: string) => [
  `volume:create:${volumeId}`,
  `machine:create:${machineId}`,
  ...Array.from({ length: 5 }, () => `machine:exec:${machineId}`),
  `machine:stop:${machineId}`,
  `machine:start:${machineId}`,
  `machine:exec:${machineId}`,
  `machine:destroy:${machineId}`,
  `volume:destroy:${volumeId}`,
];
