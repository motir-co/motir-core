import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { AGENT_BOOT_LEASE_MS } from '@/lib/agentInstances/config';
import { agentBootEventKey } from '@/lib/services/agentInstanceBootService';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { AgentInstanceNameTakenError } from '@/lib/agentInstances/errors';
import { adminDb } from '../helpers/adminDb';
import { bootDriver, driveBoot } from '../helpers/agentBootDriver';
import { clock, fleet, fx, seedRepo, setUpHarness, tearDownHarness } from './_harness';

// THE CUTOVER (Story MOTIR-7393 · MOTIR-7404, `agent-instances.md` AMENDMENT 6
// §4–§5): a create or wake ANSWERS at `starting` / `waking` and hands its boot to
// the `agent-instance/boot` driver after its transaction commits; the sweep only
// resends a boot whose lease expired, or opens one that was in flight across the
// deploy. Here no in-process worker runs the event — the test records it and
// drives the passes itself, so each answer is the request's own.

beforeEach(async () => {
  await setUpHarness();
  await seedRepo('acme', 'web');
  bootDriver.inline = false;
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const create = (name = 'yue-claude') =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
const agent = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const attemptsOf = (agentInstanceId: string) =>
  adminDb.agentInstanceBootAttempt.findMany({
    where: { agentInstanceId },
    orderBy: { attempt: 'asc' },
  });

describe('a create answers at starting', () => {
  it('returns starting while the machine takes a minute, and the driver finishes it', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(dto.state).toBe('starting');
    expect(bootDriver.sent).toEqual([
      {
        workspaceId: fx.workspaceId,
        instanceId: dto.id,
        attempt: 1,
        idempotencyKey: agentBootEventKey(dto.id, 1),
      },
    ]);
    const [opened] = await attemptsOf(dto.id);
    expect(opened).toMatchObject({ kind: 'create', outcome: null, leaseHolder: null });

    clock.advance(60_000);
    fleet.completeBoot((await agent(dto.id)).machineId!);
    expect(await driveBoot(dto.id)).toBe('running');
    expect((await attemptsOf(dto.id))[0]).toMatchObject({ outcome: 'running' });
  });

  it('sends no boot event when the create does not commit', async () => {
    await create('twin');
    await expect(create('twin')).rejects.toBeInstanceOf(AgentInstanceNameTakenError);
    expect(bootDriver.sent).toHaveLength(1);
    expect(await adminDb.agentInstanceBootAttempt.count()).toBe(1);
  });
});

describe('a wake answers at waking', () => {
  it('opens a wake attempt and hands it over, its clones skipped', async () => {
    bootDriver.inline = true;
    const dto = await create();
    await lifecycle.hibernate(fx.projectIdentifier, dto.id, fx.ctx);
    bootDriver.inline = false;
    fleet.setBootBehaviour('never_start');
    const woken = await lifecycle.wake(fx.projectIdentifier, dto.id, fx.ctx);
    expect(woken.state).toBe('waking');
    expect(bootDriver.sent.at(-1)).toMatchObject({ instanceId: dto.id, attempt: 2 });
    const wake = (await attemptsOf(dto.id))[1]!;
    expect(wake.kind).toBe('wake');
    const clones = await adminDb.agentInstanceBootStep.findMany({
      where: { bootAttemptId: wake.id, step: 'clone' },
    });
    expect(clones.map((c) => c.state)).toEqual(['skipped']);
  });
});

describe('the sweep is the boot’s backstop, never its driver', () => {
  it('leaves a boot whose lease is alive to its holder', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(await driveBoot(dto.id)).toBe('pending');
    const sent = bootDriver.sent.length;
    expect(await lifecycle.resumeBoot(dto.id)).toBe('alive');
    expect((await sweeper.sweep()).settled).toBe(0);
    expect(bootDriver.sent).toHaveLength(sent);
  });

  it('resends a boot whose lease expired, keyed so it is never deduplicated', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(await driveBoot(dto.id)).toBe('pending');
    const [held] = await attemptsOf(dto.id);
    clock.advance(AGENT_BOOT_LEASE_MS + 1);
    expect(await lifecycle.resumeBoot(dto.id)).toBe('resent');
    expect(bootDriver.sent.at(-1)).toEqual({
      workspaceId: fx.workspaceId,
      instanceId: dto.id,
      attempt: 1,
      idempotencyKey: agentBootEventKey(dto.id, 1, held!.leaseExpiresAt),
    });
    // The new holder resumes at the step in progress.
    fleet.completeBoot((await agent(dto.id)).machineId!);
    expect(await driveBoot(dto.id)).toBe('running');
  });

  it('resends a boot nobody ever leased — the event was lost', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(await lifecycle.resumeBoot(dto.id)).toBe('resent');
    expect(bootDriver.sent).toHaveLength(2);
  });

  it('opens an attempt for a boot in flight across the deploy, and sends it', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    await adminDb.agentInstanceBootAttempt.deleteMany({ where: { agentInstanceId: dto.id } });
    const before = bootDriver.sent.length;
    expect((await sweeper.sweep()).settled).toBe(1);
    expect(bootDriver.sent).toHaveLength(before + 1);
    const [opened] = await attemptsOf(dto.id);
    expect(opened).toMatchObject({ attempt: 1, kind: 'create', outcome: null });
    fleet.completeBoot((await agent(dto.id)).machineId!);
    expect(await driveBoot(dto.id)).toBe('running');
  });

  it('does nothing for an agent that is not booting', async () => {
    bootDriver.inline = true;
    const dto = await create();
    expect((await agent(dto.id)).state).toBe('running');
    expect(await lifecycle.resumeBoot(dto.id)).toBe('noop');
  });
});

describe('the list names a booting agent’s step (MOTIR-7400)', () => {
  it('carries the step in progress while booting, and nothing once running', async () => {
    fleet.setBootBehaviour('never_start');
    const dto = await create();
    expect(await driveBoot(dto.id)).toBe('pending');
    const list = () =>
      lifecycle.list(fx.projectIdentifier, { take: 10, skip: 0 }, fx.ctx).then((p) => p.instances);
    expect((await list())[0]!.bootStep).toEqual({
      step: 'machine_start',
      repository: null,
      waiting: null,
    });
    fleet.completeBoot((await agent(dto.id)).machineId!);
    expect(await driveBoot(dto.id)).toBe('running');
    expect((await list())[0]!.bootStep).toBeNull();
  });
});
