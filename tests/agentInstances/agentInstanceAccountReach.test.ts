import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistentExecResult } from '@motir/orchestrator';
import type { FleetShard } from '@/generated/prisma/client';
import { fakeDigestFor, imageCatalogSeam } from '@/lib/agentInstances/imageCatalog';
import { pinnedImageReference } from '@/lib/agentInstances/imageDigest';
import { sandboxImageTag } from '@/lib/agentInstances/profiles';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { fakePersistentOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceRunService as runs } from '@/lib/services/agentInstanceRunService';
import { agentInstanceSweepService as sweeper } from '@/lib/services/agentInstanceSweepService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { workItemsService } from '@/lib/services/workItemsService';
import { truncateJobRuns } from '../helpers/db';
import { adminDb } from '../helpers/adminDb';
import { fleet, fx, seedRepo, setUpHarness, tearDownHarness } from './_harness';

// EVERY LATER OPERATION BY THE RECORDED ACCOUNT (Story MOTIR-9361 · MOTIR-9473),
// against a real Postgres and the fake fleet. An instance placed on account A
// launches and stops its runs, probes its sign-in, reconciles, updates and rolls
// back through A — whatever the switch says. An account that cannot be resolved
// is refused or skipped, and nothing is sent anywhere else.

const MASTER = 'm'.repeat(48);
let seq = 0;

async function seedShard(name: string): Promise<FleetShard> {
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
      machineLimit: 10,
    },
  });
}

function answer(command: readonly string[]): PersistentExecResult {
  const line = command.join(' ');
  const ok = (stdout = ''): PersistentExecResult => ({ exitCode: 0, stdout, stderr: '' });
  if (line === 'motir agent-terminal run --help') return ok();
  if (line.endsWith('motir agent-terminal signin')) {
    return ok(`${JSON.stringify({ profile: 'claude', state: 'signed_in' })}\n`);
  }
  if (line.includes('motir agent-terminal run ')) return ok('{"session":"sess-1"}\n');
  return ok();
}

let a: FleetShard;

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  imageCatalogSeam.reset();
  resetShardFakes();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  fleet.setExecResponder(answer);
  await seedRepo('acme', 'web');
  a = await seedShard('agent-hoster-a');
  wireFleetKindSwitch('agent_instance', () => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  wireFleetKindSwitch('agent_instance', null);
  imageCatalogSeam.reset();
  resetShardFakes();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
const callsOn = (shardId: string, op: string) =>
  fakePersistentOrchestratorForShard(shardId).calls.filter((c) => c === op).length;

async function placedAgent(): Promise<string> {
  const dto = await lifecycle.create(
    fx.projectIdentifier,
    { name: 'yue-claude', profileId: 'claude' },
    fx.ctx,
  );
  expect(dto.state).toBe('running');
  expect((await rowOf(dto.id)).fleetShardId).toBe(a.id);
  return dto.id;
}

const card = () =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'a card' },
    fx.ctx,
  );

/** Make the account unreadable, as one taken off record would be. */
const accountGone = () =>
  vi.spyOn(fleetShardService, 'getShard').mockRejectedValue(new Error('fleet account not found'));

describe('a placed instance is reached through its account', () => {
  it('launches and stops a run through A while the switch flips off, on and off', async () => {
    const id = await placedAgent();
    for (const on of [false, true, false]) {
      wireFleetKindSwitch('agent_instance', () => on);
      const before = callsOn(a.id, 'exec');
      const item = await card();
      const { dispatchRunId } = await runs.start(
        { workItemKey: item.identifier, agentInstanceId: id },
        fx.ctx,
      );
      expect(await runs.launchNow(dispatchRunId)).toBe('launched');
      expect(callsOn(a.id, 'exec')).toBeGreaterThan(before);
      const execsBeforeStop = callsOn(a.id, 'exec');
      expect(await runs.stopSession(dispatchRunId, id)).toBe('stopped');
      expect(callsOn(a.id, 'exec')).toBe(execsBeforeStop + 1);
      await runs.end(dispatchRunId, 'cancelled', 'the test is done', { stopSession: false });
    }
  });

  it('probes the sign-in and reconciles the machine through A', async () => {
    const id = await placedAgent();
    wireFleetKindSwitch('agent_instance', () => false);
    const execs = callsOn(a.id, 'exec');
    expect(await lifecycle.probeSignIn(id)).toBe('signed_in');
    expect(callsOn(a.id, 'exec')).toBe(execs + 1);
    const described = callsOn(a.id, 'describePersistent');
    expect(await lifecycle.reconcileRunning(id)).toBe('ok');
    expect(callsOn(a.id, 'describePersistent')).toBeGreaterThan(described);
  });

  it('updates, and rolls back a failing image, through A', async () => {
    const id = await placedAgent();
    wireFleetKindSwitch('agent_instance', () => false);
    imageCatalogSeam.setFakeNewest('claude', '1.1.0');
    const updated = await lifecycle.update(fx.projectIdentifier, id, fx.ctx);
    expect(updated).toMatchObject({ state: 'running', imageVersion: '1.1.0' });
    expect(callsOn(a.id, 'moveImage')).toBe(1);
    expect(callsOn(a.id, 'checkLiveness')).toBe(1);

    imageCatalogSeam.setFakeNewest('claude', '1.2.0');
    const row = await rowOf(id);
    fleet.markImageFailing(
      pinnedImageReference(sandboxImageTag('claude'), fakeDigestFor('claude', '1.2.0')),
    );
    const rolledBack = await lifecycle.update(fx.projectIdentifier, id, fx.ctx);
    expect(rolledBack).toMatchObject({ state: 'running', imageVersion: '1.1.0' });
    // The move there and the move back both went to A, on the same machine.
    expect(callsOn(a.id, 'moveImage')).toBe(3);
    expect((await rowOf(id)).machineId).toBe(row.machineId);
  });

  it('a sweep pass reconciles a placed instance through A', async () => {
    const id = await placedAgent();
    wireFleetKindSwitch('agent_instance', () => false);
    const described = callsOn(a.id, 'describePersistent');
    const summary = await sweeper.sweep();
    expect(summary.errors).toBe(0);
    expect(callsOn(a.id, 'describePersistent')).toBeGreaterThan(described);
    expect((await rowOf(id)).state).toBe('running');
  });
});

describe('an account that cannot be resolved', () => {
  it('a run launch is refused in words and nothing is executed anywhere', async () => {
    const id = await placedAgent();
    const item = await card();
    const { dispatchRunId } = await runs.start(
      { workItemKey: item.identifier, agentInstanceId: id },
      fx.ctx,
    );
    const execsBefore = fleet.execs.length;
    accountGone();
    expect(await runs.launchNow(dispatchRunId)).toBe('failed');
    expect(fleet.execs.length).toBe(execsBefore);
    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
    expect(run.status).toBe('failed');
  });

  it('the sign-in probe answers nothing and the reconcile does nothing', async () => {
    const id = await placedAgent();
    accountGone();
    const execsBefore = fleet.execs.length;
    expect(await lifecycle.probeSignIn(id)).toBeNull();
    expect(await lifecycle.reconcileRunning(id)).toBe('noop');
    expect(fleet.execs.length).toBe(execsBefore);
    expect((await rowOf(id)).state).toBe('running');
  });

  it('a sweep skips its instances with the reason and goes on', async () => {
    const id = await placedAgent();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    accountGone();
    const described = callsOn(a.id, 'describePersistent');
    const summary = await sweeper.sweep();
    expect(summary.errors).toBe(0);
    expect(callsOn(a.id, 'describePersistent')).toBe(described);
    expect(warn).toHaveBeenCalledWith(
      '[agentInstanceSweep] skipped the instances of an unreachable account',
      expect.objectContaining({ fleetShardId: a.id }),
    );
    expect((await rowOf(id)).state).toBe('running');
  });
});
