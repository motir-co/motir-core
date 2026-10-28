import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_FLEET_APP,
  FLEET_CONTAINER_SIZE,
  fakeFleetInventory,
  fakeOrchestrator,
  fakePersistentOrchestrator,
  type ContainerHandle,
  type ContainerOrchestrator,
  type FleetInventory,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetAttributionService,
  FLEET_ATTRIBUTION_GRACE_MS,
  CI_INTENT_END_AFTER_BOOT_MS,
} from '@/lib/services/fleetAttributionService';
import { indexSlotRef } from '@/lib/services/codeGraphIndexAdmissionService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { describeAge } from '@/lib/ciFleet/attributionErrors';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// EVERY MACHINE BELONGS TO A PAYING ORG, OR IT DIES (Story MOTIR-6906 ·
// MOTIR-6925) against real Postgres — `docs/decisions/fleet-per-org-pool.md` §5.
//
// Real: every record the reconciler attributes against (intents, usage
// checkpoints, slots, agent instances) and the kill record. The provider is the
// fake inventory over the two fake orchestrators, plus `addStray` for what no
// record names. Sentry is the one external boundary, observed at its call.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const MINUTE = 60_000;
/** A clock one grace (and a minute) after "now" — the first pass that may kill. */
const pastGrace = () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);

interface Fixture {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `attribution-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `F${randomInt(100, 1000)}`,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

async function bootFleetContainer(
  fx: Fixture,
  workload: 'ci_runner' | 'code_graph_index' | 'hosted_agent',
): Promise<ContainerHandle> {
  return fakeOrchestrator.provision({
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName: 'motir-projects/acme-web',
    workload,
    workflowJobId: workload === 'ci_runner' ? 70_001 : null,
    image: 'motir/runner@sha256:test',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    timeoutSeconds: 3600,
    region: 'iad',
  });
}

let jobSeq = 0;

async function seedIntent(
  fx: Fixture,
  handle: ContainerHandle,
  overrides: { status?: string; teardownReason?: string | null; bootedAt?: Date } = {},
) {
  jobSeq += 1;
  const settled = overrides.status !== undefined && overrides.status !== 'running';
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '66601',
      runId: `run-${jobSeq}`,
      runAttempt: 1,
      jobId: String(70_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: overrides.status ?? 'running',
      containerProvider: handle.provider,
      containerId: handle.id,
      containerRegion: handle.region,
      bootedAt: overrides.bootedAt ?? new Date(),
      startedAt: new Date(),
      teardownReason: overrides.teardownReason ?? null,
      settledAt: settled ? new Date() : null,
    },
  });
}

async function seedCheckpoint(
  fx: Fixture,
  handle: ContainerHandle,
  workload: 'index' | 'agent',
  options: { stopped?: boolean; dispatchRunId?: string } = {},
) {
  await adminDb.ciContainerUsage.create({
    data: {
      containerProvider: handle.provider,
      handleId: handle.id,
      containerRegion: handle.region,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      workload,
      repoFullName: 'motir-projects/acme-web',
      cpuKind: 'shared',
      cpus: 2,
      memoryMb: 4096,
      containerCreatedAt: handle.createdAt,
      containerStartedAt: handle.createdAt,
      containerStoppedAt: options.stopped ? new Date() : null,
      billableSeconds: 60,
      periodStart: new Date('2026-09-01T00:00:00.000Z'),
      usdPerSecond: '0.00003',
      costUsd: '0.0018',
      dispatchRunId: options.dispatchRunId ?? null,
    },
  });
}

async function seedSlot(fx: Fixture, workload: string, ref: string, expiresAt: Date) {
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref,
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      expiresAt,
    },
  });
}

async function bootInstance(
  fx: Fixture,
  overrides: { state?: 'running' | 'hibernated' | 'failed'; deleted?: boolean } = {},
) {
  const instanceId = `inst-${randomInt(1_000_000)}`;
  const handle = await fakePersistentOrchestrator.provisionPersistent({
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    instanceId,
    image: 'motir/sandbox@sha256:test',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    region: 'iad',
    volumeSizeGb: 10,
    mountPath: '/home/node',
    terminal: null,
  });
  const row = await adminDb.agentInstance.create({
    data: {
      id: instanceId,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      ownerId: fx.userId,
      name: `agent-${instanceId}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      flyApp: handle.app,
      machineId: handle.machineId,
      volumeId: handle.volumeId,
      region: 'iad',
      state: overrides.state ?? 'running',
      deletedAt: overrides.deleted ? new Date() : null,
    },
  });
  return { handle, row };
}

function alerts(): string[] {
  return captureException.mock.calls.map(([err]) => (err as Error).message);
}

beforeEach(async () => {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  fakeOrchestrator.reset();
  fakePersistentOrchestrator.reset();
  fakeFleetInventory.reset();
  captureException.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.ciContainerUsage.deleteMany({});
  await truncateAuthTables();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await db.$disconnect();
});

describe('a machine nothing attributes', () => {
  it('AC1 — is destroyed on the first pass after the grace, with ONE Sentry issue naming it', async () => {
    const created = new Date();
    fakeFleetInventory.addStray({
      app: FAKE_FLEET_APP,
      machineId: 'm-stray',
      name: 'by-hand',
      createdAt: created,
    });

    // Pinned to `created`, not the wall clock, so `ageSeconds` is exactly 660 on a slow runner.
    const at = new Date(created.getTime() + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);
    const result = await fleetAttributionService.reconcile({ now: () => at });

    expect(result).toMatchObject({
      outcome: 'reconciled',
      killed: [{ app: FAKE_FLEET_APP, machineId: 'm-stray', reason: 'no_record' }],
    });
    expect(fakeFleetInventory.strayMachineIds()).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0]!;
    expect((error as Error).name).toBe('UnattributedMachineDestroyedError');
    expect((error as Error).message).toBe(
      `Destroyed Fly machine m-stray (by-hand) in ${FAKE_FLEET_APP}, 11 min old: no_record.`,
    );
    expect(context.fingerprint).toEqual([
      'fleet-attribution',
      'UnattributedMachineDestroyedError',
      FAKE_FLEET_APP,
      'm-stray',
    ]);

    // The kill record: decided, then completed.
    const [row] = await adminDb.fleetMachineKill.findMany();
    expect(row).toMatchObject({
      app: FAKE_FLEET_APP,
      machineId: 'm-stray',
      machineName: 'by-hand',
      reason: 'no_record',
      action: 'destroyed',
      workload: null,
      organizationId: null,
      failureDetail: null,
      ageSeconds: 660,
    });
    expect(row!.completedAt).not.toBeNull();
  });

  it('destroys a machine in an app nothing in Motir created', async () => {
    fakeFleetInventory.addStray({
      app: 'someone-elses-app',
      machineId: 'm-x',
      createdAt: new Date(),
    });
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ killed: [{ app: 'someone-elses-app', machineId: 'm-x' }] });
    expect(fakeFleetInventory.actions).toEqual(['destroy:someone-elses-app/m-x']);
  });

  it('AC2 — a machine inside the grace is left alone, and nobody is told', async () => {
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-new', createdAt: new Date() });
    const result = await fleetAttributionService.reconcile({
      now: () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS - MINUTE),
    });
    expect(result).toMatchObject({ spared: 1, killed: [] });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-new']);
    expect(captureException).not.toHaveBeenCalled();
    expect(await adminDb.fleetMachineKill.count()).toBe(0);
  });

  it('a machine with no creation instant is alerted, never destroyed on a guess', async () => {
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-undated', createdAt: null });
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ undated: 1, killed: [] });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-undated']);
    expect(alerts()).toEqual([
      `Could not list machines in ${FAKE_FLEET_APP}: machine m-undated has no creation instant, ` +
        'so it cannot be aged. Nothing was destroyed there.',
    ]);
  });

  it('a stopped-and-gone machine is not judged at all', async () => {
    fakeFleetInventory.addStray({
      app: FAKE_FLEET_APP,
      machineId: 'm-gone',
      createdAt: new Date(0),
      state: 'gone',
    });
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ listed: 0, killed: [] });
  });
});

describe('AC4 — every legitimately running container survives the pass', () => {
  // A hosted run holding its slot is proved in `tests/hostedRuns/hostedRunEnd.test.ts`,
  // against a real dispatch run.
  it('a CI runner, an index container holding its slot, and agent instances', async () => {
    const fx = await seedTenant();
    const ci = await bootFleetContainer(fx, 'ci_runner');
    await seedIntent(fx, ci);

    const index = await bootFleetContainer(fx, 'code_graph_index');
    await seedCheckpoint(fx, index, 'index');
    await seedSlot(
      fx,
      'code_graph_index',
      indexSlotRef(fx.projectId, 'motir-projects/acme-web'),
      new Date(Date.now() + 3_600_000),
    );

    const instance = await bootInstance(fx);
    const hibernated = await bootInstance(fx, { state: 'hibernated' });
    await fakePersistentOrchestrator.stop(hibernated.handle);

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({ outcome: 'reconciled', matched: 4, killed: [], failures: 0 });
    expect(fakeOrchestrator.liveContainerIds().sort()).toEqual([ci.id, index.id].sort());
    expect(fakePersistentOrchestrator.liveMachineIds()).toContain(instance.handle.machineId);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('a machine whose record says it should have stopped', () => {
  it("a SETTLED intent's machine still running is destroyed — record_ended", async () => {
    const fx = await seedTenant();
    const ci = await bootFleetContainer(fx, 'ci_runner');
    const intent = await seedIntent(fx, ci, { status: 'succeeded', teardownReason: 'completed' });

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({
      killed: [{ machineId: ci.id, reason: 'record_ended', workload: 'ci_runner' }],
    });
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    const [row] = await adminDb.fleetMachineKill.findMany();
    expect(row).toMatchObject({ recordRef: intent.id, organizationId: fx.organizationId });
  });

  it('an intent the org stop settled reads org_stopped', async () => {
    const fx = await seedTenant();
    const ci = await bootFleetContainer(fx, 'ci_runner');
    await seedIntent(fx, ci, { status: 'failed', teardownReason: 'credits_exhausted' });

    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ killed: [{ reason: 'org_stopped' }] });
    expect(alerts()[0]).toContain(': org_stopped.');
  });

  it("an in-flight intent past its OWN end is torn down through the port and settled 'reaped'", async () => {
    const fx = await seedTenant();
    const ci = await bootFleetContainer(fx, 'ci_runner');
    const intent = await seedIntent(fx, ci);
    const pastEnd = () =>
      new Date(Date.now() + CI_INTENT_END_AFTER_BOOT_MS + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);

    // Before its end (+ the grace) the same machine is attributed.
    expect(await fleetAttributionService.reconcile({ now: pastGrace })).toMatchObject({
      matched: 1,
    });
    const result = await fleetAttributionService.reconcile({ now: pastEnd });

    expect(result).toMatchObject({ killed: [{ machineId: ci.id, reason: 'record_ended' }] });
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled).toMatchObject({ status: 'failed', teardownReason: 'reaped' });
    // Through the PORT's teardown — which is what writes its usage row.
    expect(fakeOrchestrator.teardowns).toEqual([{ handleId: ci.id, reason: 'reaped' }]);
  });

  it('an index container whose slot has expired, or whose checkpoint closed, is destroyed', async () => {
    const fx = await seedTenant();
    const expired = await bootFleetContainer(fx, 'code_graph_index');
    await seedCheckpoint(fx, expired, 'index');
    await seedSlot(
      fx,
      'code_graph_index',
      indexSlotRef(fx.projectId, 'motir-projects/acme-web'),
      new Date(Date.now() - 3_600_000),
    );
    const closed = await bootFleetContainer(fx, 'code_graph_index');
    await seedCheckpoint(fx, closed, 'index', { stopped: true });

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({ outcome: 'reconciled' });
    if (result.outcome !== 'reconciled') throw new Error('unreachable');
    expect(result.killed.map((k) => [k.machineId, k.reason, k.workload]).sort()).toEqual(
      [
        [expired.id, 'record_ended', 'code_graph_index'],
        [closed.id, 'record_ended', 'code_graph_index'],
      ].sort(),
    );
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
  });

  it('a hosted-agent checkpoint with no dispatch run to key a slot by has ended', async () => {
    const fx = await seedTenant();
    const hosted = await bootFleetContainer(fx, 'hosted_agent');
    await seedCheckpoint(fx, hosted, 'agent');
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ killed: [{ machineId: hosted.id, workload: 'hosted_agent' }] });
  });
});

describe('agent-instance apps', () => {
  it('AC3 — a machine in an org’s instance app that no instance names is destroyed', async () => {
    const fx = await seedTenant();
    const { handle } = await bootInstance(fx);
    // The record forgets its machine: nothing names it now.
    await adminDb.agentInstance.updateMany({ data: { machineId: null } });

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({
      killed: [{ app: handle.app, machineId: handle.machineId, reason: 'no_record' }],
    });
    expect(fakePersistentOrchestrator.liveMachineIds()).toEqual([]);
    // Its volume is released for the instance sweep's volume half (§6).
    expect(fakePersistentOrchestrator.liveVolumeIds()).toEqual([handle.volumeId]);
  });

  it("a DELETED instance's machine is destroyed — record_ended", async () => {
    const fx = await seedTenant();
    const { handle, row } = await bootInstance(fx, { deleted: true });
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({
      killed: [{ machineId: handle.machineId, reason: 'record_ended', action: 'destroyed' }],
    });
    const [kill] = await adminDb.fleetMachineKill.findMany();
    expect(kill).toMatchObject({ workload: 'agent_instance', recordRef: row.id });
  });

  it('a HIBERNATED instance whose machine runs is STOPPED, never destroyed, and alerted', async () => {
    const fx = await seedTenant();
    const { handle } = await bootInstance(fx, { state: 'hibernated' });
    await adminDb.agentInstance.updateMany({
      data: { stateChangedAt: new Date(Date.now() - 60 * MINUTE) },
    });

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({
      killed: [{ machineId: handle.machineId, reason: 'record_ended', action: 'stopped' }],
    });
    expect(fakeFleetInventory.actions).toEqual([`stop:${handle.app}/${handle.machineId}`]);
    expect(fakePersistentOrchestrator.liveMachineIds()).toEqual([handle.machineId]);
    expect(alerts()[0]).toMatch(/^Stopped Fly machine /);
  });
});

describe('AC5 — a failed listing destroys nothing, and alerts', () => {
  it('a failed APP list stops the whole pass', async () => {
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-1', createdAt: new Date() });
    fakeFleetInventory.failNextAppList('503 from the Machines API');

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({ outcome: 'inventory_unavailable' });
    if (result.outcome !== 'inventory_unavailable') throw new Error('unreachable');
    expect(result.detail).toContain('503 from the Machines API');
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-1']);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatch(
      /^Could not list machines in the fleet organization: .*503 from the Machines API.*\. Nothing was destroyed there\.$/,
    );
    expect(captureException.mock.calls[0]![1].level).toBe('error');
  });

  it('a failed machine list skips THAT app, and the pass continues', async () => {
    fakeFleetInventory.addStray({ app: 'app-a', machineId: 'm-a', createdAt: new Date() });
    fakeFleetInventory.addStray({ app: 'app-b', machineId: 'm-b', createdAt: new Date() });
    fakeFleetInventory.failNextMachineList('app-a', 'timeout');

    const result = await fleetAttributionService.reconcile({ now: pastGrace });

    expect(result).toMatchObject({ unavailableApps: ['app-a'], killed: [{ machineId: 'm-b' }] });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-a']);
  });

  // MOTIR-8302: one `HTTP 502` from Fly's edge on an instance app's machine list
  // raised an error-level issue for a refusal the next request would not repeat.
  // A transient answer is asked ONCE more in the same pass; only a second
  // failure is "the inventory is unavailable".
  it('a single 502 on a machine list is asked again, and nobody is told', async () => {
    fakeFleetInventory.addStray({ app: 'motir-inst-a', machineId: 'm-a', createdAt: new Date() });
    fakeFleetInventory.failNextMachineList('motir-inst-a', 'bad gateway', { status: 502 });

    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      listingRetryDelayMs: 0,
    });

    expect(result).toMatchObject({ unavailableApps: [], killed: [{ machineId: 'm-a' }] });
    expect(alerts().filter((m) => m.startsWith('Could not list'))).toEqual([]);
  });

  it('a single 503 on the APP list is asked again, and the pass runs', async () => {
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-1', createdAt: new Date() });
    fakeFleetInventory.failNextAppList('service unavailable', { status: 503 });

    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      listingRetryDelayMs: 0,
    });

    expect(result).toMatchObject({ outcome: 'reconciled', killed: [{ machineId: 'm-1' }] });
    expect(alerts().filter((m) => m.startsWith('Could not list'))).toEqual([]);
  });

  it('a 502 that repeats skips the app and alerts once — nothing destroyed there', async () => {
    fakeFleetInventory.addStray({ app: 'motir-inst-a', machineId: 'm-a', createdAt: new Date() });
    fakeFleetInventory.addStray({ app: 'motir-inst-b', machineId: 'm-b', createdAt: new Date() });
    fakeFleetInventory.failNextMachineList('motir-inst-a', 'bad gateway', {
      status: 502,
      times: 2,
    });

    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      listingRetryDelayMs: 0,
    });

    expect(result).toMatchObject({
      unavailableApps: ['motir-inst-a'],
      killed: [{ machineId: 'm-b' }],
    });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-a']);
    const listing = alerts().filter((m) => m.startsWith('Could not list'));
    expect(listing).toEqual([
      'Could not list machines in motir-inst-a: The fake orchestrator refused a call ' +
        '(HTTP 502: bad gateway). Nothing was destroyed there.',
    ]);
  });

  it('a refusal that is not transient is not asked again', async () => {
    fakeFleetInventory.addStray({ app: 'app-a', machineId: 'm-a', createdAt: new Date() });
    // Once only: were a 401 retried, the second listing would succeed and kill m-a.
    fakeFleetInventory.failNextMachineList('app-a', 'unauthorized', { status: 401 });

    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      listingRetryDelayMs: 0,
    });

    expect(result).toMatchObject({ unavailableApps: ['app-a'], killed: [] });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-a']);
  });

  it('a refused destroy is recorded, alerted, and retried on the next pass', async () => {
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-1', createdAt: new Date() });
    fakeFleetInventory.failNextDestroy('m-1', 'machine is locked');

    const first = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(first).toMatchObject({ failures: 1, killed: [] });
    const [failed] = await adminDb.fleetMachineKill.findMany();
    expect(failed).toMatchObject({ completedAt: null });
    expect(failed!.failureDetail).toContain('machine is locked');
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain(
      `Could not list machines in ${FAKE_FLEET_APP}: could not destroy machine m-1: `,
    );

    const second = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(second).toMatchObject({ failures: 0, killed: [{ machineId: 'm-1' }] });
    expect(await adminDb.fleetMachineKill.count()).toBe(2);
  });

  it('a record read that throws leaves the machine running', async () => {
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-1', createdAt: new Date() });
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'findByContainerId').mockRejectedValueOnce(
      new Error('connection reset'),
    );
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ failures: 1, killed: [] });
    expect(fakeFleetInventory.strayMachineIds()).toEqual(['m-1']);
  });
});

describe('the edges', () => {
  it('is inert with no fleet to inventory', async () => {
    expect(await fleetAttributionService.reconcile({ inventory: null })).toEqual({
      outcome: 'disabled',
    });
  });

  it('reads an alert age in minutes, then hours', () => {
    expect(describeAge(11 * MINUTE)).toBe('11 min');
    expect(describeAge(125 * MINUTE)).toBe('2 h 5 min');
    expect(describeAge(-5)).toBe('0 min');
  });

  it('an alert that throws never stops the pass', async () => {
    captureException.mockImplementation(() => {
      throw new Error('sentry is down');
    });
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-1', createdAt: new Date() });
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ killed: [{ machineId: 'm-1' }] });
  });
});

describe('the orphaned Docker volume sweep (MOTIR-8839)', () => {
  type Sweepable = { sweepOrphanedVolumes?: (olderThan: Date) => Promise<number> };

  it('runs after the machine pass, one grace back, and counts what it destroyed', async () => {
    const sweep = vi.fn(async () => 2);
    (fakeOrchestrator as Sweepable).sweepOrphanedVolumes = sweep;
    try {
      const now = pastGrace();
      const result = await fleetAttributionService.reconcile({ now: () => now });
      expect(result).toMatchObject({ outcome: 'reconciled', orphanedVolumesDestroyed: 2 });
      expect(sweep).toHaveBeenCalledWith(new Date(now.getTime() - FLEET_ATTRIBUTION_GRACE_MS));
    } finally {
      delete (fakeOrchestrator as Sweepable).sweepOrphanedVolumes;
    }
  });

  it('an orchestrator with no volumes to sweep reports none', async () => {
    const result = await fleetAttributionService.reconcile({ now: pastGrace });
    expect(result).toMatchObject({ orphanedVolumesDestroyed: 0 });
  });

  it('a deployment with no orchestrator sweeps nothing', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    try {
      // The inventory is handed in: with no orchestrator configured the default
      // one is absent too, and the pass would answer `disabled` before the sweep.
      const result = await fleetAttributionService.reconcile({
        now: pastGrace,
        inventory: fakeFleetInventory,
      });
      expect(result).toMatchObject({ outcome: 'reconciled', orphanedVolumesDestroyed: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('fleet accounts the organisation walk does not cover (MOTIR-8964)', () => {
  /** One account's own listing: one stray machine in one app. */
  function accountInventory(options: { failListing?: boolean } = {}) {
    const destroyed: string[] = [];
    const inventory: FleetInventory = {
      provider: 'fake',
      listApps: async () => {
        if (options.failListing) throw new Error('the account refused to list');
        return ['acct-app'];
      },
      listMachines: async (app) => [
        {
          app,
          machineId: 'm-acct',
          name: '',
          region: 'ams',
          state: 'running',
          createdAt: new Date(),
          metadata: {},
        },
      ],
      destroyMachine: async (app, machineId) => {
        destroyed.push(`${app}/${machineId}`);
      },
      stopMachine: async () => undefined,
    };
    return { inventory, destroyed };
  }

  it("walks an account's own listing after the organisation, and kills what nothing attributes", async () => {
    const { inventory, destroyed } = accountInventory();
    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      accounts: [],
      accountInventories: [{ shardId: 'acct-1', name: 'aws-ci-1', inventory }],
    });
    expect(result).toMatchObject({
      outcome: 'reconciled',
      killed: [{ app: 'acct-app', machineId: 'm-acct', reason: 'no_record' }],
    });
    expect(destroyed).toEqual(['acct-app/m-acct']);
  });

  it('an account whose listing fails is reported by name and alerted; the rest still runs', async () => {
    const { inventory } = accountInventory({ failListing: true });
    fakeFleetInventory.addStray({ app: FAKE_FLEET_APP, machineId: 'm-org', createdAt: new Date() });
    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      listingRetryDelayMs: 0,
      accounts: [],
      accountInventories: [{ shardId: 'acct-1', name: 'aws-ci-1', inventory }],
    });
    expect(result).toMatchObject({
      unavailableApps: ['aws-ci-1'],
      killed: [{ machineId: 'm-org' }],
    });
    expect(alerts().some((message) => message.includes('aws-ci-1'))).toBe(true);
  });

  it('sweeps volumes ONCE per place: two accounts on one app are one sweep', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    const sweep = vi.fn(async () => 1);
    const forShardRow = vi
      .spyOn(fleetShardOrchestratorService, 'forShardRow')
      .mockReturnValue({ sweepOrphanedVolumes: sweep } as unknown as ContainerOrchestrator);
    const account = (id: string, name: string) =>
      ({
        id,
        name,
        provider: 'fly',
        state: 'active',
        fly: { org: 'motir', app: 'motir-ci-shared', region: 'iad' },
      }) as unknown as FleetShardDTO;

    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      inventory: fakeFleetInventory,
      accounts: [account('a', 'ci-a'), account('b', 'ci-b')],
      accountInventories: [],
    });

    expect(forShardRow).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ orphanedVolumesDestroyed: 1 });
  });
});
