import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePersistentOrchestrator as fleet } from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import {
  AGENT_WAITING_POLL_MS,
  AGENT_WAITING_REASONS,
  INSTANCE_BOOT_DEADLINE_MS,
  parseWaitingReason,
} from '@/lib/agentInstances/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { isJobRunDefer, type JobRunDefer } from '@/lib/jobs/engine/defer';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import { fakePersistentOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import {
  readShardFakeCalls,
  resetShardFakeJournal,
  shardHeldShared,
} from '@/lib/orchestrator/shardFakeJournal';
import { agentInstanceBootService as boot } from '@/lib/services/agentInstanceBootService';
import {
  agentInstanceBootSteps,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { adminDb } from '../helpers/adminDb';
import { bootDriver, driveBoot, INLINE_BOOT_HOLDER } from '../helpers/agentBootDriver';
import { clock, debits, fx, intervals, MIN, setUpHarness, tearDownHarness } from './_harness';

// A FULL POOL MEANS WAITING (Story MOTIR-9361 · MOTIR-9474), against a real
// Postgres and the fake fleet, one view of it per AWS hoster account. A capacity
// refusal is never a failure: the boot's `provision` step stays in progress with
// a reason code, the boot job retries on its waiting poll, and the instance is
// created (any account of the pool) or started (only its own account) once room
// appears. Any other provider error still fails the boot, as it always did.

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
      awsAccountId: `4444${String(seq++).padStart(8, '0')}`,
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_${name.toUpperCase().replace(/-/g, '_')}`,
      machineLimit,
    },
  });
}

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

/** Room again: the refusal lifted and the pause a refusal put on the account ended. */
async function makeRoom(...shards: FleetShard[]): Promise<void> {
  for (const shard of shards) fakePersistentOrchestratorForShard(shard.id).releaseCapacity();
  await adminDb.fleetShard.updateMany({
    where: { id: { in: shards.map((s) => s.id) } },
    data: { admissionPausedUntil: null, admissionPausedReason: null },
  });
}

const readBoot = (id: string) => boot.readBoot(fx.projectIdentifier, id, fx.ctx);

async function provisionStep(id: string) {
  const dto = await readBoot(id);
  return dto!.steps.find((s) => s.step === 'provision')!;
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

describe('the waiting reason codes', () => {
  it('parses exactly the two codes, and nothing else', () => {
    expect(parseWaitingReason(AGENT_WAITING_REASONS.poolFull)).toBe('pool');
    expect(parseWaitingReason(AGENT_WAITING_REASONS.accountFull)).toBe('account');
    expect(parseWaitingReason(null)).toBeNull();
    expect(parseWaitingReason('deleted')).toBeNull();
    expect(parseWaitingReason('waiting_for_room:zone')).toBeNull();
  });
});

describe('a new instance with every account full', () => {
  it('waits in `starting` with the reason `pool`, creating nothing and failing nothing', async () => {
    const a = await seedShard('agent-hoster-a');
    const b = await seedShard('agent-hoster-b');
    fakePersistentOrchestratorForShard(a.id).holdCapacity('provision');
    fakePersistentOrchestratorForShard(b.id).holdCapacity('provision');
    wireFleetKindSwitch('agent_instance', () => true);
    const fail = vi.spyOn(agentInstanceBootSteps, 'failInstance');

    const dto = await create();
    expect(dto.state).toBe('starting');
    expect(await rowOf(dto.id)).toMatchObject({
      state: 'starting',
      fleetShardId: null,
      availabilityZone: null,
      machineId: null,
      volumeId: null,
    });
    const provision = await provisionStep(dto.id);
    expect(provision).toMatchObject({ state: 'in_progress', waited: null });
    expect(provision.waiting).toEqual({ reason: 'pool', since: provision.startedAt });
    // The list row names the wait too.
    const listed = await lifecycle.list(fx.projectIdentifier, { take: 10, skip: 0 }, fx.ctx);
    expect(listed.instances.find((r) => r.id === dto.id)?.bootStep).toMatchObject({
      step: 'provision',
      waiting: 'pool',
    });
    expect(fleet.operations.filter((o) => o.startsWith('machine:create'))).toEqual([]);
    expect(fleet.operations.filter((o) => o.startsWith('volume:create'))).toEqual([]);
    expect(fail).not.toHaveBeenCalled();
  });

  it('is created on the account that has room once it appears, and boots to `running`', async () => {
    const a = await seedShard('agent-hoster-a', 10);
    const b = await seedShard('agent-hoster-b', 2);
    fakePersistentOrchestratorForShard(a.id).holdCapacity('provision');
    fakePersistentOrchestratorForShard(b.id).holdCapacity('provision');
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    expect(dto.state).toBe('starting');

    // Only B gets room: the retry may choose any account of the pool.
    await makeRoom(b);
    expect(await driveUntilSettled(dto.id)).toBe('running');
    const row = await rowOf(dto.id);
    expect(row).toMatchObject({
      state: 'running',
      fleetShardId: b.id,
      availabilityZone: 'us-east-1a',
    });
    expect(row.machineId).not.toBeNull();
    const provision = await provisionStep(dto.id);
    expect(provision).toMatchObject({ state: 'done', waiting: null });
    expect(provision.waited).toEqual({
      reason: 'pool',
      since: provision.startedAt,
      until: provision.endedAt,
    });
    expect((await readBoot(dto.id))!.steps.every((s) => s.waiting === null)).toBe(true);
  });

  it('a provider error that is not a capacity refusal fails the create as it always did', async () => {
    await seedShard('agent-hoster-a');
    wireFleetKindSwitch('agent_instance', () => true);
    fleet.failNextProvision('the fake refused to provision');
    const dto = await create();
    expect(dto.state).toBe('failed');
    expect((await rowOf(dto.id)).failureReason).toContain('The machine could not be created');
    expect((await provisionStep(dto.id)).waiting).toBeNull();
  });

  it('a provider error on the retry fails the boot with its reason, never waits', async () => {
    const a = await seedShard('agent-hoster-a');
    fakePersistentOrchestratorForShard(a.id).holdCapacity('provision');
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    await makeRoom(a);
    fleet.failNextProvision('the fake refused to provision');
    expect(await driveBoot(dto.id)).toBe('failed');
    const row = await rowOf(dto.id);
    expect(row.failureReason).toContain('The machine could not be created');
    expect(row.machineId).toBeNull();
    const provision = await provisionStep(dto.id);
    expect(provision.state).toBe('failed');
    expect(provision.waiting).toBeNull();
  });
});

describe('the waiting pass', () => {
  it('defers at the waiting poll, rewrites nothing on a repeated refusal, and keeps its `since`', async () => {
    const a = await seedShard('agent-hoster-a');
    fakePersistentOrchestratorForShard(a.id).holdCapacity('provision');
    wireFleetKindSwitch('agent_instance', () => true);
    bootDriver.inline = false;
    const dto = await create();
    const [sent] = bootDriver.sent;
    const first = await provisionStep(dto.id);
    const rows = () =>
      adminDb.agentInstanceBootStep.findMany({
        where: { bootAttempt: { agentInstanceId: dto.id } },
        orderBy: { ordinal: 'asc' },
      });
    const before = await rows();

    clock.advance(3 * MIN);
    const verdict = await boot.advance(dto.id, sent!.attempt, INLINE_BOOT_HOLDER);
    expect(verdict).toEqual({
      next: 'defer',
      deferUntil: new Date(clock.now().getTime() + AGENT_WAITING_POLL_MS),
      waiting: true,
    });
    expect(await rows()).toEqual(before);
    const again = await provisionStep(dto.id);
    expect(again.waiting).toEqual(first.waiting);

    // The job says why it defers.
    const step = { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() };
    const handler = engineJob('agent-instance/boot')!.handler;
    const deferred: unknown = await Promise.resolve(
      handler(
        { step, runId: INLINE_BOOT_HOLDER, attempt: 1, event: { data: sent } } as never,
        jobServices as never,
      ),
    ).catch((err: unknown) => err);
    expect(isJobRunDefer(deferred)).toBe(true);
    expect((deferred as JobRunDefer).reason).toBe('the agent is waiting for room');
  });

  it('is not failed by the boot deadline while it waits; the deadline counts from the pass that got room', async () => {
    const a = await seedShard('agent-hoster-a');
    fakePersistentOrchestratorForShard(a.id).holdCapacity('provision');
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();

    clock.advance(INSTANCE_BOOT_DEADLINE_MS + 5 * MIN);
    expect(await driveBoot(dto.id)).toBe('pending');
    expect((await rowOf(dto.id)).state).toBe('starting');
    expect((await provisionStep(dto.id)).waiting?.reason).toBe('pool');

    fleet.setBootBehaviour('never_start');
    await makeRoom(a);
    expect(await driveBoot(dto.id)).toBe('pending'); // room: provisioned
    expect((await provisionStep(dto.id)).state).toBe('done');
    expect(await driveBoot(dto.id)).toBe('pending'); // the machine is starting
    clock.advance(INSTANCE_BOOT_DEADLINE_MS - MIN);
    expect(await driveBoot(dto.id)).toBe('pending');
    clock.advance(2 * MIN);
    expect(await driveBoot(dto.id)).toBe('failed');
    expect((await rowOf(dto.id)).failureReason).toContain('did not finish starting');
  });

  it('a delete while waiting ends the attempt `deleted`, creates nothing, and bills nothing', async () => {
    const a = await seedShard('agent-hoster-a');
    fakePersistentOrchestratorForShard(a.id).holdCapacity('provision');
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    clock.advance(7 * MIN);

    await lifecycle.delete(fx.projectIdentifier, dto.id, fx.ctx);
    const row = await rowOf(dto.id);
    expect(row.deletedAt).not.toBeNull();
    const attempt = await adminDb.agentInstanceBootAttempt.findFirstOrThrow({
      where: { agentInstanceId: dto.id },
      orderBy: { attempt: 'desc' },
    });
    expect(attempt.outcome).toBe('deleted');
    const provision = await adminDb.agentInstanceBootStep.findFirstOrThrow({
      where: { bootAttemptId: attempt.id, step: 'provision' },
    });
    expect(provision).toMatchObject({ state: 'failed', detail: 'deleted' });
    expect(fleet.operations.filter((o) => /^(machine|volume):(create|destroy)/.test(o))).toEqual(
      [],
    );
    const [interval] = await intervals();
    expect(interval).toMatchObject({ endReason: 'deleted', chargeOutcome: 'not_charged' });
    expect(interval!.credits).toBe(0);
    expect(debits()).toEqual([]);
    // Nothing left to drive.
    expect(await driveBoot(dto.id)).toBe('noop');
  });
});

describe('a hibernated instance woken while its own account is full', () => {
  async function hibernatedOnA() {
    const a = await seedShard('agent-hoster-a', 10);
    const b = await seedShard('agent-hoster-b', 2);
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    expect(dto.state).toBe('running');
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    const row = await rowOf(dto.id);
    expect(row).toMatchObject({ state: 'hibernated', fleetShardId: a.id });
    return { a, b, row };
  }

  it('waits in `waking` with the reason `account`, asking only its own account', async () => {
    const { a, b, row } = await hibernatedOnA();
    const viewA = fakePersistentOrchestratorForShard(a.id);
    const viewB = fakePersistentOrchestratorForShard(b.id);
    viewA.holdCapacity('start');
    const start = vi.spyOn(fleet, 'start');
    const provision = vi.spyOn(fleet, 'provisionPersistent');
    viewB.calls.length = 0;

    const dto = await lifecycle.wake(fx.projectIdentifier, row.id, fx.ctx);
    expect(dto.state).toBe('waking');
    const step = await provisionStep(row.id);
    expect(step.state).toBe('in_progress');
    expect(step.waiting).toEqual({ reason: 'account', since: step.startedAt });
    expect(await driveBoot(row.id)).toBe('pending');
    // Every start was asked of A (and refused there); B and the fake behind them heard nothing.
    expect(viewA.calls.filter((c) => c === 'start').length).toBeGreaterThan(1);
    expect(viewB.calls).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();

    await makeRoom(a);
    expect(await driveUntilSettled(row.id)).toBe('running');
    expect(await rowOf(row.id)).toMatchObject({
      state: 'running',
      fleetShardId: a.id,
      availabilityZone: 'us-east-1a',
      machineId: row.machineId,
      volumeId: row.volumeId,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(viewB.calls).toEqual([]);
    const woke = await provisionStep(row.id);
    expect(woke.waiting).toBeNull();
    expect(woke.waited?.reason).toBe('account');
  });

  it('a start refused for any other reason fails the wake as it always did', async () => {
    const { row } = await hibernatedOnA();
    fleet.failNextStart('the fake refused to start');
    const dto = await lifecycle.wake(fx.projectIdentifier, row.id, fx.ctx);
    expect(dto.state).toBe('failed');
    expect((await rowOf(row.id)).failureReason).toContain('The machine could not start');
  });

  it('a provider error on the waiting retry fails the wake with its reason, never waits', async () => {
    const { a, row } = await hibernatedOnA();
    fakePersistentOrchestratorForShard(a.id).holdCapacity('start');
    await lifecycle.wake(fx.projectIdentifier, row.id, fx.ctx);
    await makeRoom(a);
    fleet.failNextStart('the fake refused to start');
    expect(await driveBoot(row.id)).toBe('failed');
    const failed = await rowOf(row.id);
    expect(failed.failureReason).toContain('The machine could not start');
    expect(failed.failureReason).toContain('Wake to try again, or delete it.');
    const provision = await provisionStep(row.id);
    expect(provision.state).toBe('failed');
    expect(provision.waiting).toBeNull();
  });

  it('the boot read names no provider, account, zone or quota', async () => {
    const { a, row } = await hibernatedOnA();
    fakePersistentOrchestratorForShard(a.id).holdCapacity('start');
    await lifecycle.wake(fx.projectIdentifier, row.id, fx.ctx);
    const wire = JSON.stringify(await readBoot(row.id));
    for (const leak of [a.id, a.name, a.awsAccountId!, 'us-east-1', 'aws', 'quota']) {
      expect(wire).not.toContain(leak);
    }
  });
});

// MOTIR-9478: with the persistent fake's state file set (the E2E lane), each
// account's calls and holds live beside it, so the spec, the web server and the
// job worker read the same record.
describe('the shared journal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shard-journal-'));
    vi.stubEnv('MOTIR_FAKE_PERSISTENT_STATE_PATH', join(dir, 'state.json'));
    resetShardFakeJournal();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records each account's calls, the refused provision unnamed and the made one by its machine", async () => {
    const a = await seedShard('agent-hoster-a');
    const viewA = fakePersistentOrchestratorForShard(a.id);
    viewA.holdCapacity('provision');
    expect(shardHeldShared(a.id, 'provision')).toBe(true);
    wireFleetKindSwitch('agent_instance', () => true);
    const dto = await create();
    expect(dto.state).toBe('starting');
    const refused = readShardFakeCalls().filter((c) => c.shardId === a.id);
    expect(refused).toEqual([{ shardId: a.id, op: 'provisionPersistent', ref: null }]);

    await makeRoom(a);
    expect(shardHeldShared(a.id, 'provision')).toBe(false);
    expect(await driveUntilSettled(dto.id)).toBe('running');
    const row = await rowOf(dto.id);
    const calls = readShardFakeCalls().filter((c) => c.shardId === a.id);
    expect(calls).toContainEqual({ shardId: a.id, op: 'provisionPersistent', ref: row.machineId });
    // Every other call names the machine it was asked about.
    expect(
      calls.filter((c) => c.op !== 'provisionPersistent').every((c) => c.ref === row.machineId),
    ).toBe(true);
  });

  it('a held start is refused for every process, and a failed provision is recorded unnamed', async () => {
    const a = await seedShard('agent-hoster-a');
    wireFleetKindSwitch('agent_instance', () => true);
    fleet.failNextProvision('the fake refused to provision');
    const failed = await create('yue-failed');
    expect(failed.state).toBe('failed');
    expect(readShardFakeCalls()).toContainEqual({
      shardId: a.id,
      op: 'provisionPersistent',
      ref: null,
    });

    const dto = await create();
    expect(dto.state).toBe('running');
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    // Another process holds the room: this view reads the hold from the file.
    resetShardFakes();
    fakePersistentOrchestratorForShard(a.id).holdCapacity('start');
    resetShardFakes();
    const woke = await lifecycle.wake(fx.projectIdentifier, dto.id, fx.ctx);
    expect(woke.state).toBe('waking');
    expect((await provisionStep(dto.id)).waiting?.reason).toBe('account');
    fakePersistentOrchestratorForShard(a.id).releaseCapacity('start');
    expect(shardHeldShared(a.id, 'start')).toBe(false);
  });
});
