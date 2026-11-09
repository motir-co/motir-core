import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorNotConfiguredError,
  type ContainerSpec,
  type UsageAttribution,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { INSTALL_FLEET_SHARD_ID, INSTALL_FLEET_TAG } from '@/lib/ciFleet/installFleet';
import {
  installFleetInventory,
  installFleetOrchestrator,
  installFleetPersistentOrchestrator,
  resetShardFakes,
  setAwsEc2OverrideForTests,
} from '@/lib/orchestrator';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { installFakeAwsSeam } from '@/lib/test-fake-aws';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { fakeAwsInstances, plantUntaggedInstance } from '../e2e/_helpers/fake-aws-boundary';

// THE INSTALL FLEET THROUGH THE FAKE AWS (Story MOTIR-10792 · MOTIR-10794): the
// REAL AWS adapter over the lane's file-backed EC2, in the install fleet's own
// account — no fleet account row, no management credential, no pool role. An
// index VM is booted into the configured subnets with the install fleet's tag,
// described and torn down; the reconciler lists only the install fleet's tagged
// machines in that account and judges them; and off the fake, the orchestrator is
// built on core's own credentials with no management credential set.

const REGION = 'us-east-1';
// The fake EC2 names an account's subnets `subnet-<last 8 of its id><zone letter>`.
const FAKE_SUBNETS = ['subnet-ll-fleeta', 'subnet-ll-fleetb'];
const INDEX_IMAGE = `123456789012.dkr.ecr.${REGION}.amazonaws.com/indexer@sha256:${'b'.repeat(64)}`;

let dir: string;

function indexSpec(): ContainerSpec {
  return {
    orgId: 'org-meta',
    workspaceId: 'ws-meta',
    projectId: 'project-meta',
    repoFullName: 'motir-co/motir-core',
    workload: 'code_graph_index',
    workflowJobId: null,
    image: INDEX_IMAGE,
    size: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
    env: { MOTIR_INDEX_RUN_ID: 'run-1' },
    timeoutSeconds: 1800,
    region: REGION,
  };
}

const attribution: UsageAttribution = {
  orgId: 'org-meta',
  workspaceId: 'ws-meta',
  projectId: 'project-meta',
  repoFullName: 'motir-co/motir-core',
  workload: 'code_graph_index',
  workflowJobId: null,
  size: { cpuKind: 'performance', cpus: 2, memoryMb: 8192 },
  observedStartedAt: null,
};

function stubInstallEnv(): void {
  vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', 'code_graph_index,agent_instance,hosted_agent');
  vi.stubEnv('MOTIR_INSTALL_FLEET_SUBNET_IDS', FAKE_SUBNETS.join(','));
  vi.stubEnv('MOTIR_INSTALL_FLEET_SECURITY_GROUP_ID', 'sg-install');
  vi.stubEnv(
    'MOTIR_INSTALL_FLEET_INSTANCE_PROFILE_ARN',
    'arn:aws:iam::944842271421:instance-profile/motir-install-fleet-vm',
  );
  vi.stubEnv('MOTIR_INSTALL_FLEET_REGION', REGION);
  // The per-kind AMI pin every pool account boots an index VM from.
  vi.stubEnv('MOTIR_AWS_INDEXER_AMI_ID', 'ami-indexer');
}

/** No management credential at all: the pool path could not assume anything. */
function noManagementCredential(): void {
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', '');
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
}

beforeEach(async () => {
  await truncateAuthTables();
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
  dir = mkdtempSync(join(tmpdir(), 'motir-install-fleet-'));
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  stubInstallEnv();
  noManagementCredential();
});

afterEach(() => {
  setAwsEc2OverrideForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seamOn(): Promise<void> {
  vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', join(dir, 'fake-aws.json'));
  vi.stubEnv('MOTIR_FAKE_FLEET_SWITCH_PATH', join(dir, 'switch.json'));
  expect(await installFakeAwsSeam()).toBe(true);
}

describe('through the fake AWS, in core’s own account', () => {
  it('boots, describes and tears down an index VM with the install fleet’s tag, network and no account row', async () => {
    await seamOn();
    const orchestrator = await fleetShardOrchestratorService.forShard(INSTALL_FLEET_SHARD_ID);
    expect(orchestrator.provider).toBe('aws');

    const handle = await orchestrator.provision(indexSpec());
    expect(handle).toMatchObject({ provider: 'aws', region: REGION });

    const [instance] = fakeAwsInstances(INSTALL_FLEET_SHARD_ID);
    expect(instance!.instanceId).toBe(handle.id);
    expect(FAKE_SUBNETS).toContain(instance!.request!.subnetId);
    const tags = Object.fromEntries(instance!.tags.map((t) => [t.key, t.value]));
    expect(tags).toMatchObject({
      'motir-shard': INSTALL_FLEET_TAG,
      motir_org_id: 'org-meta',
    });
    expect(tags['motir-shard']).toBe('motir-install-fleet');

    const status = await orchestrator.describe(handle);
    expect(status).toMatchObject({ exists: true, terminal: false });

    const usage = await orchestrator.teardown(handle, 'job_completed', attribution);
    expect(usage).toMatchObject({ handleId: handle.id, provider: 'aws', orgId: 'org-meta' });
    expect(fakeAwsInstances(INSTALL_FLEET_SHARD_ID)[0]!.state).toBe('terminated');
    // No fleet account was ever written.
    expect(await adminDb.fleetShard.count()).toBe(0);
  });

  it('lists only the install fleet’s tagged machines, and the reconciler judges them', async () => {
    await seamOn();
    const orchestrator = installFleetOrchestrator();
    const handle = await orchestrator.provision(indexSpec());
    // A machine of core's own account that is not the fleet's: never listed.
    const stranger = plantUntaggedInstance(
      { id: INSTALL_FLEET_SHARD_ID, name: INSTALL_FLEET_TAG },
      new Date('2026-11-01T00:00:00.000Z'),
    );

    const inventory = installFleetInventory();
    expect(inventory).not.toBeNull();
    expect(await inventory!.listApps()).toEqual([INSTALL_FLEET_TAG]);
    const listed = (await inventory!.listMachines(INSTALL_FLEET_TAG)).map((m) => m.machineId);
    expect(listed).toEqual([handle.id]);

    // Past the grace, an index VM no record holds is killed in that account,
    // and the stranger is never reached.
    const later = new Date(Date.now() + 24 * 3_600_000);
    const result = await fleetAttributionService.reconcile({
      inventory: null,
      accounts: [],
      now: () => later,
    });
    expect(result).toMatchObject({ outcome: 'reconciled', accounts: 1, listed: 1 });
    if (result.outcome !== 'reconciled') return;
    expect(result.killed.map((k) => k.machineId)).toEqual([handle.id]);
    const states = Object.fromEntries(
      fakeAwsInstances(INSTALL_FLEET_SHARD_ID).map((i) => [i.instanceId, i.state]),
    );
    expect(states[handle.id]).toBe('terminated');
    expect(states[stranger]).toBe('running');
  });

  it('keeps the agent host on the persistent fake, as the lane does for every account', async () => {
    await seamOn();
    expect(installFleetPersistentOrchestrator()).toBe(
      await fleetShardOrchestratorService.persistentOrchestratorFor({
        fleetShardId: null,
        flyApp: INSTALL_FLEET_TAG,
      }),
    );
  });
});

describe('off the fake: core’s own credentials, nothing assumed', () => {
  it('builds every install-fleet adapter with no management credential set', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-runner');
    vi.stubEnv('MOTIR_AWS_HOSTER_AMI_ID', 'ami-hoster');
    for (const name of [
      'MOTIR_HOSTER_CA_CERT',
      'MOTIR_HOSTER_CA_KEY',
      'MOTIR_HOSTER_CLIENT_CERT',
      'MOTIR_HOSTER_CLIENT_KEY',
    ]) {
      vi.stubEnv(name, '-----BEGIN PLACEHOLDER-----\\nAAAA\\n-----END PLACEHOLDER-----');
    }
    expect(installFleetOrchestrator().provider).toBe('aws');
    expect(installFleetPersistentOrchestrator().provider).toBe('aws');
    expect(installFleetInventory()?.provider).toBe('aws');
  });

  it('names a missing AMI pin, and lists nothing with no kind configured', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', '');
    expect(() => installFleetOrchestrator()).toThrow(OrchestratorNotConfiguredError);
    expect(() => installFleetOrchestrator()).toThrow(/MOTIR_AWS_RUNNER_AMI_ID/);
    vi.stubEnv('MOTIR_INSTALL_FLEET_KINDS', '');
    expect(installFleetInventory()).toBeNull();
  });

  it('is the per-account fake on the plain fake orchestrator', () => {
    expect(installFleetOrchestrator().provider).toBe('fake');
    expect(installFleetInventory()).toBeNull();
  });
});
