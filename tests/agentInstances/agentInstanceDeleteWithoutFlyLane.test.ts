import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentInstanceLaneMissingError,
  AgentInstancesUnavailableError,
} from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { imageCatalog, imageCatalogSeam } from '@/lib/agentInstances/imageCatalog';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { db } from '@/lib/db';
import { resetShardFakes } from '@/lib/orchestrator';
import {
  agentInstanceLaneMissing,
  agentInstanceLifecycleService as lifecycle,
} from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService } from '@/lib/services/agentInstanceSweepService';
import { adminDb } from '../helpers/adminDb';
import { truncateJobRuns } from '../helpers/db';
import { fleet, fx, intervals, seedRepo, setUpHarness, slots, tearDownHarness } from './_harness';

// AN AGENT RECORDED ON THE FLY LANE IS DELETED ON AN INSTALL WITH NO FLY LANE
// (MOTIR-10809). Production moved its agents to AWS and dropped the Fly instances
// token; MOTIR-10801 let an org placed off the Fly lane create and delete again.
// Deleting an agent whose ROW still records a Fly machine moved it to `deleting`,
// the destroy then failed on the missing token, and the sweep skipped the row as
// unreachable on every pass — so it sat `deleting` for ever and stayed on My
// agents. Its machine is destroyed on the Fly side by the lane's decommissioning
// (MOTIR-9716); Motir finishes the delete on its own records.
//
// The missing token is modelled at both switches the real code reads: the lane
// check `isPersistentOrchestratorConfigured`, and `getPersistentOrchestrator`,
// which throws exactly as it does in production with no token. The install fleet
// stays on its fake, so the org can still be placed off the Fly lane.

const lane = vi.hoisted(() => ({ configured: null as boolean | null }));
vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/orchestrator')>();
  return {
    ...real,
    isPersistentOrchestratorConfigured: () =>
      lane.configured ?? real.isPersistentOrchestratorConfigured(),
    getPersistentOrchestrator: () => {
      if (lane.configured === false) {
        throw new real.OrchestratorNotConfiguredError(
          'set FLY_INSTANCES_API_TOKEN, or select the fake adapter',
        );
      }
      return real.getPersistentOrchestrator();
    },
  };
});

const REGION = 'us-east-1';

/** The install's agents now go to the install fleet (production after MOTIR-10801). */
async function placeOffFlyLane(): Promise<void> {
  vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'agent_instance');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SUBNET_IDS', 'subnet-a,subnet-b');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID', 'sg-install');
  vi.stubEnv(
    'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN',
    'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm',
  );
  vi.stubEnv('MOTIR_INSTALL_FLEET_REGION', REGION);
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId! },
    data: { isMeta: true },
  });
}

/** The deployment loses its Fly instances token, and its agents leave the lane. */
async function dropFlyLane(): Promise<void> {
  await placeOffFlyLane();
  lane.configured = false;
}

const rowOf = (id: string) => adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

/** A running agent made on the process-wide (Fly) lane while it was configured. */
async function flyAgent(name = 'claude-code-11'): Promise<string> {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  const row = await rowOf(dto.id);
  expect(row).toMatchObject({ fleetShardId: null });
  expect(row.machineId).not.toBeNull();
  return dto.id;
}

/** `lastInterval`: how its last interval ended — `deleted` when the delete closed it. */
async function expectFinished(id: string, lastInterval = 'deleted'): Promise<void> {
  const row = await rowOf(id);
  expect(row.state).toBe('deleting');
  expect(row.deletedAt).not.toBeNull();
  expect(await slots()).toEqual([]);
  const open = (await intervals()).filter((i) => i.agentInstanceId === id && i.endedAt === null);
  expect(open).toEqual([]);
  expect((await intervals()).filter((i) => i.agentInstanceId === id).at(-1)).toMatchObject({
    endReason: lastInterval,
  });
  const listed = await lifecycle.list(fx.projectIdentifier, { take: 50, skip: 0 }, fx.ctx);
  expect(listed.instances.map((i) => i.id)).not.toContain(id);
}

/** The log line naming what is left for the Fly-side destruction. */
function leftBehindLine(warn: { mock: { calls: unknown[][] } }, id: string) {
  return warn.mock.calls.find(
    ([message, detail]: unknown[]) =>
      typeof message === 'string' &&
      message.includes('left for the Fly-side destruction') &&
      (detail as { instanceId?: string } | undefined)?.instanceId === id,
  );
}

beforeEach(async () => {
  await setUpHarness();
  await truncateJobRuns();
  lane.configured = null;
  imageCatalogSeam.reset();
  resetShardFakes();
  wireFleetKindSwitch('agent_instance', null);
  await seedRepo('acme', 'web');
});

afterEach(async () => {
  vi.restoreAllMocks();
  lane.configured = null;
  wireFleetKindSwitch('agent_instance', null);
  imageCatalogSeam.reset();
  resetShardFakes();
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('deleting an agent recorded on the Fly lane, with no Fly lane', () => {
  it('finishes in Motir: deletedAt stamped, interval closed, slot released, and the leftovers logged', async () => {
    const id = await flyAgent();
    const { flyApp, machineId, volumeId } = await rowOf(id);
    expect(await slots()).toHaveLength(1);
    await dropFlyLane();
    expect(agentInstanceLaneMissing(await rowOf(id))).toBe(true);
    const warn = vi.spyOn(console, 'warn');

    await lifecycle.delete(fx.projectIdentifier, id, fx.ctx);

    await expectFinished(id);
    expect(leftBehindLine(warn, id)?.[1]).toMatchObject({ flyApp, machineId, volumeId });
    // Nothing was sent to a Fly machine: its destruction is the decommissioning's.
    expect(fleet.liveMachineIds()).toContain(machineId);
    expect(fleet.liveVolumeIds()).toContain(volumeId);
  });

  it('a hibernated one too — it has no open interval, and is still finished', async () => {
    const id = await flyAgent();
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    expect((await rowOf(id)).state).toBe('hibernated');
    await dropFlyLane();

    await lifecycle.delete(fx.projectIdentifier, id, fx.ctx);

    await expectFinished(id, 'hibernated');
  });

  it('rows already stuck `deleting` are finished by the next sweep, with nobody acting on each', async () => {
    const stuck = [await flyAgent('codex-1'), await flyAgent('claude-code-11')];
    await adminDb.agentInstance.updateMany({
      where: { id: { in: stuck } },
      data: { state: 'deleting' },
    });
    await dropFlyLane();
    const warn = vi.spyOn(console, 'warn');

    const summary = await agentInstanceSweepService.sweep();

    expect(summary.settled).toBeGreaterThanOrEqual(2);
    expect(summary.errors).toBe(0);
    for (const id of stuck) {
      await expectFinished(id);
      expect(leftBehindLine(warn, id)).toBeDefined();
    }
  });

  it('the sweep still skips a Fly-lane row that is in any other motion', async () => {
    const id = await flyAgent();
    await adminDb.agentInstance.update({ where: { id }, data: { state: 'hibernating' } });
    await dropFlyLane();

    await agentInstanceSweepService.sweep();

    expect(await rowOf(id)).toMatchObject({ state: 'hibernating', deletedAt: null });
  });
});

describe('with the Fly lane configured, a delete destroys the machine as before', () => {
  it('machine and volume destroyed, nothing logged as left behind', async () => {
    const id = await flyAgent();
    const { machineId, volumeId } = await rowOf(id);
    await placeOffFlyLane();
    expect(agentInstanceLaneMissing(await rowOf(id))).toBe(false);
    const warn = vi.spyOn(console, 'warn');

    await lifecycle.delete(fx.projectIdentifier, id, fx.ctx);

    await expectFinished(id);
    expect(fleet.liveMachineIds()).not.toContain(machineId);
    expect(fleet.liveVolumeIds()).not.toContain(volumeId);
    expect(leftBehindLine(warn, id)).toBeUndefined();
  });
});

describe('wake, hibernate and update of an agent whose lane is missing refuse in words', () => {
  const refusal = (action: 'woken' | 'hibernated' | 'updated') =>
    new AgentInstanceLaneMissingError('x', action).message;

  it('hibernate of a running one: refused, nothing moved', async () => {
    const id = await flyAgent();
    await dropFlyLane();

    await expect(lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx)).rejects.toThrow(
      refusal('hibernated'),
    );
    expect((await rowOf(id)).state).toBe('running');
  });

  it('wake of a hibernated one: refused, nothing moved, no slot taken', async () => {
    const id = await flyAgent();
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    await dropFlyLane();

    await expect(lifecycle.wake(fx.projectIdentifier, id, fx.ctx)).rejects.toThrow(
      refusal('woken'),
    );
    expect((await rowOf(id)).state).toBe('hibernated');
    expect(await slots()).toEqual([]);
  });

  it('update: refused before the image catalog is asked', async () => {
    const id = await flyAgent();
    await dropFlyLane();
    const asked = vi.spyOn(imageCatalog, 'newestFor');

    const err = await lifecycle.update(fx.projectIdentifier, id, fx.ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentInstanceLaneMissingError);
    expect((err as Error).message).toBe(refusal('updated'));
    expect(asked).not.toHaveBeenCalled();
    expect((await rowOf(id)).state).toBe('running');
  });

  it('the refusal answers 409 with its code and words — never the lane-wide 503', async () => {
    const res = mapAgentInstanceError(new AgentInstanceLaneMissingError('x', 'woken'))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'agent_instance_lane_missing',
      error: refusal('woken'),
    });
    expect(
      mapAgentInstanceError(new AgentInstancesUnavailableError('no instance fleet'))!.status,
    ).toBe(503);
  });

  it('an install with no lane at all still refuses with the deployment-wide words', async () => {
    const id = await flyAgent();
    lane.configured = false;

    await expect(lifecycle.wake(fx.projectIdentifier, id, fx.ctx)).rejects.toBeInstanceOf(
      AgentInstancesUnavailableError,
    );
  });
});
