import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorCapacityError,
  type ContainerSpec,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  AWS_RUNNER_AMI_ENV_VAR,
  hostedAgentImage,
  inventoryForShard,
  orchestratorForShard,
  resetShardFakes,
  setAwsEc2OverrideForTests,
} from '@/lib/orchestrator';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import {
  setAgentRunnerSwitchForTests,
  setCiRunnerSwitchForTests,
} from '@/lib/ciFleet/fleetKindSwitches';
import { E2E_MOCK_SEAMS, installE2EMockSeams } from '@/lib/test-mock-seams';
import { installFakeAwsSeam, readFakeAwsState } from '@/lib/test-fake-aws';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import {
  fakeAwsContainerEnv,
  fakeAwsInstanceForRun,
  fakeAwsInstances,
  plantUntaggedInstance,
  refuseNextLaunch,
  resetFakeAws,
  stopFakeAwsInstance,
  writeAgentRunnerSwitch,
} from '../e2e/_helpers/fake-aws-boundary';

// THE ACCEPTANCE LANE'S FAKE AWS (Story MOTIR-9359 · MOTIR-9429): a file-backed
// EC2 behind the REAL AWS adapter and inventory, the agent-runner switch as a
// fixture, the lane wiring and the spec-side helpers. Real Postgres for the
// account rows, a real temp file for the state every lane process shares.
//
// The first block is the seam's whole safety claim: with
// `MOTIR_FAKE_AWS_STATE_PATH` unset, nothing routes differently.

const ROOT = join(__dirname, '..', '..');
const IMAGE =
  'ghcr.io/motir-co/motir-hosted-agent@sha256:e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0';

const AWS_ACCOUNT: CreateFleetShardInput = {
  name: 'hosted-agent-use1-1',
  fleetKind: 'hosted_agent',
  provider: 'aws',
  state: 'active',
  githubOrg: 'motir-projects',
  githubInstallationId: '556677',
  awsAccountId: '111111111111',
  awsRegion: 'us-east-1',
  credentialRef: 'AWS_SEAM_ACCOUNT',
  limits: { machineLimit: 10 },
};

const FLY_ACCOUNT: CreateFleetShardInput = {
  name: 'hosted-agent-fly-1',
  fleetKind: 'hosted_agent',
  provider: 'fly',
  state: 'active',
  githubOrg: 'motir-projects',
  githubInstallationId: '556677',
  flyOrg: 'motir',
  flyApp: 'motir-agents-1',
  flyRegion: 'iad',
  credentialRef: 'FLY_SEAM_ACCOUNT',
  limits: { machineLimit: 10 },
};

let dir: string;
let statePath: string;
let switchPath: string;

async function account(input: CreateFleetShardInput): Promise<FleetShardDTO> {
  return fleetShardService.createShard({ ...input, name: `${input.name}-${randomToken(4)}` });
}

function hostedSpec(dispatchRunId: string): ContainerSpec {
  return {
    orgId: 'org-seam',
    workspaceId: 'ws-seam',
    projectId: 'proj-seam',
    repoFullName: 'motir-projects/acme-web',
    workload: 'hosted_agent',
    workflowJobId: null,
    image: hostedAgentImage('aws'),
    size: { ...FLEET_CONTAINER_SIZE, memoryMb: 8192 },
    env: { MOTIR_DISPATCH_RUN_ID: dispatchRunId, MOTIR_RUN_TOKEN: `token-${dispatchRunId}` },
    timeoutSeconds: 3600,
    region: 'us-east-1',
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetShard.deleteMany({});
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
  dir = mkdtempSync(join(tmpdir(), 'motir-fake-aws-'));
  statePath = join(dir, 'fake-aws.json');
  switchPath = join(dir, 'switch.json');
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', IMAGE);
});

afterEach(async () => {
  setAwsEc2OverrideForTests(null);
  setAgentRunnerSwitchForTests(null);
  setCiRunnerSwitchForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Turn the seam on in this process, with the lane's two paths. */
async function seamOn(): Promise<void> {
  vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', statePath);
  vi.stubEnv('MOTIR_FAKE_FLEET_SWITCH_PATH', switchPath);
  expect(await installFakeAwsSeam()).toBe(true);
}

describe('with MOTIR_FAKE_AWS_STATE_PATH unset, nothing routes differently', () => {
  it('installs nothing', async () => {
    expect(await installFakeAwsSeam()).toBe(false);
    const aws = await account(AWS_ACCOUNT);
    expect(orchestratorForShard(aws).provider).toBe('fake');
    expect(inventoryForShard(aws)).toBeNull();
    expect(hostedAgentImage('aws')).toBe('motir/hosted-agent@sha256:fake');
  });

  it('routes fake, fly and aws selection exactly as before', async () => {
    const aws = await account(AWS_ACCOUNT);
    const fly = await account(FLY_ACCOUNT);
    expect(orchestratorForShard(fly).provider).toBe('fake');
    expect(inventoryForShard(fly)).toBeNull();

    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    // The real aws case still demands the management credential (which assumes
    // the account's runner role) and the AMI.
    vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', '');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
    expect(() => orchestratorForShard(aws)).toThrow(/AWS_ORG_ADMIN_ROLE_ARN/);
    expect(() => inventoryForShard(aws)).toThrow(/AWS_ORG_ADMIN_ROLE_ARN/);
    expect(inventoryForShard(fly)).toBeNull();
  });

  it('is off in the seam table too', async () => {
    const lines: string[] = [];
    expect(await installE2EMockSeams((l) => lines.push(l))).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('with the seam on, an aws account runs the real adapter over the state file', () => {
  it('boots a hosted run into that account with real user-data and tags; fly stays fake', async () => {
    await seamOn();
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
    const aws = await account(AWS_ACCOUNT);
    const fly = await account(FLY_ACCOUNT);

    const orchestrator = orchestratorForShard(aws);
    expect(orchestrator.provider).toBe('aws');
    expect(orchestratorForShard(fly).provider).toBe('fake');

    // No credential and no AMI in the env: the seam satisfies both, ahead of
    // any credential read.
    expect(process.env['AWS_ORG_ADMIN_ROLE_ARN']).toBe('');
    expect(process.env[AWS_RUNNER_AMI_ENV_VAR]).toBeUndefined();

    const handle = await orchestrator.provision(hostedSpec('run-1'));
    expect(handle.provider).toBe('aws');

    const instances = fakeAwsInstancesIn(aws);
    expect(instances).toHaveLength(1);
    const [instance] = instances;
    expect(instance!.instanceId).toBe(handle.id);
    const tags = Object.fromEntries(instance!.tags.map((t) => [t.key, t.value]));
    expect(tags).toMatchObject({
      'motir-shard': aws.name,
      motir_dispatch_run_id: 'run-1',
      motir_org_id: 'org-seam',
      Name: expect.stringContaining('run-1'),
    });
    const userData = Buffer.from(instance!.request!.userData, 'base64').toString('utf8');
    expect(userData).toContain('MOTIR_BOOT_MODE=container');
    // The lane's digest-shaped image, not the fake orchestrator's answer.
    expect(userData).toContain(`MOTIR_CONTAINER_IMAGE=${IMAGE}`);
    expect(fakeAwsContainerEnv(instance!)).toEqual({
      MOTIR_DISPATCH_RUN_ID: 'run-1',
      MOTIR_RUN_TOKEN: 'token-run-1',
    });
    expect(fakeAwsInstanceForRun('run-1')).toEqual({ shardId: aws.id, instance });
  });

  it('is installed from the seam table, on the path alone', async () => {
    vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', statePath);
    const lines: string[] = [];
    expect(await installE2EMockSeams((l) => lines.push(l))).toEqual(['MOTIR_FAKE_AWS_STATE_PATH']);
    expect(lines).toEqual([expect.stringContaining('MOTIR_FAKE_AWS_STATE_PATH active — ')]);
    const aws = await account(AWS_ACCOUNT);
    expect(orchestratorForShard(aws).provider).toBe('aws');
  });

  it('is seen by a second process, and listed by the account inventory', async () => {
    await seamOn();
    const aws = await account(AWS_ACCOUNT);
    const handle = await orchestratorForShard(aws).provision(hostedSpec('run-2'));

    const seen = execFileSync(
      process.execPath,
      [
        '-e',
        'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));' +
          'process.stdout.write(Object.keys(s.accounts[process.argv[2]].instances).join(","));',
        statePath,
        aws.id,
      ],
      { encoding: 'utf8' },
    );
    expect(seen).toBe(handle.id);

    const inventory = inventoryForShard(aws)!;
    expect(inventory.provider).toBe('aws');
    expect(await inventory.listApps()).toEqual([aws.name]);
    expect((await inventory.listMachines(aws.name)).map((m) => m.machineId)).toEqual([handle.id]);
  });
});

describe('the control entries', () => {
  it('an account-wide quota code stops the zone walk', async () => {
    await seamOn();
    const aws = await account(AWS_ACCOUNT);
    refuseNextLaunch(aws, { code: 'VcpuLimitExceeded' });

    const err = await orchestratorForShard(aws)
      .provision(hostedSpec('run-3'))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OrchestratorCapacityError);
    expect((err as OrchestratorCapacityError).reason).toBe('quota_exceeded');
    expect(fakeAwsInstancesIn(aws)).toEqual([]);
    // Consumed: the next launch goes through.
    await orchestratorForShard(aws).provision(hostedSpec('run-3'));
    expect(fakeAwsInstancesIn(aws)).toHaveLength(1);
  });

  it('a zone-local out-of-stock code moves the launch to the next zone', async () => {
    await seamOn();
    const aws = await account(AWS_ACCOUNT);
    refuseNextLaunch(aws, { code: 'InsufficientInstanceCapacity', zone: 'us-east-1a' });

    await orchestratorForShard(aws).provision(hostedSpec('run-4'));

    const [instance] = fakeAwsInstancesIn(aws);
    expect(instance!.availabilityZone).toBe('us-east-1b');
    expect(readFakeAwsState(statePath).accounts[aws.id]!.refusals).toEqual([]);
  });

  it('a stop makes describe read the instance ended', async () => {
    await seamOn();
    const aws = await account(AWS_ACCOUNT);
    const orchestrator = orchestratorForShard(aws);
    const handle = await orchestrator.provision(hostedSpec('run-5'));
    expect((await orchestrator.describe(handle)).terminal).toBe(false);

    stopFakeAwsInstance(aws, handle.id);

    const status = await orchestrator.describe(handle);
    expect(status.terminal).toBe(true);
    expect(status.stoppedAt).toBeInstanceOf(Date);
  });

  it('an untagged instance is listed with its launch time', async () => {
    await seamOn();
    const aws = await account(AWS_ACCOUNT);
    const launchedAt = new Date('2026-10-24T08:00:00.000Z');
    const id = plantUntaggedInstance(aws, launchedAt);

    const machines = await inventoryForShard(aws)!.listMachines(aws.name);

    expect(machines).toEqual([
      expect.objectContaining({ machineId: id, name: '', createdAt: launchedAt, metadata: {} }),
    ]);
  });

  it('resetFakeAws forgets every account', async () => {
    await seamOn();
    const aws = await account(AWS_ACCOUNT);
    plantUntaggedInstance(aws, new Date());
    resetFakeAws();
    expect(fakeAwsInstances(aws.id)).toEqual([]);
  });
});

describe('the agent-runner switch reads the fixture with the seam on', () => {
  it('re-reads it on every call, and falls back to the env var when it says nothing', async () => {
    await seamOn();
    const { agentRunnerOnPool } = await import('@/lib/ciFleet/fleetKindSwitches');
    const { fleetKindOnPool } = await import('@/lib/ciFleet/shardTargets');

    writeAgentRunnerSwitch('aws');
    expect(agentRunnerOnPool()).toBe(true);
    expect(await fleetKindOnPool('hosted_agent')).toBe(true);
    writeAgentRunnerSwitch('fly');
    expect(agentRunnerOnPool()).toBe(false);

    writeFileSync(switchPath, '{}');
    vi.stubEnv('MOTIR_FLEET_AGENT_RUNNER_PROVIDER', 'aws');
    expect(agentRunnerOnPool()).toBe(true);
  });

  it.each([
    ['the switch module first', true],
    ['the seam first', false],
  ])('wins with %s imported', async (_label, switchFirst) => {
    vi.resetModules();
    vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', statePath);
    vi.stubEnv('MOTIR_FAKE_FLEET_SWITCH_PATH', switchPath);
    vi.stubEnv('MOTIR_FLEET_AGENT_RUNNER_PROVIDER', 'fly');
    writeAgentRunnerSwitch('aws');

    let switches: typeof import('@/lib/ciFleet/fleetKindSwitches');
    if (switchFirst) {
      switches = await import('@/lib/ciFleet/fleetKindSwitches');
      await (await import('@/lib/test-fake-aws')).installFakeAwsSeam();
    } else {
      await (await import('@/lib/test-fake-aws')).installFakeAwsSeam();
      switches = await import('@/lib/ciFleet/fleetKindSwitches');
    }
    const { fleetKindOnPool } = await import('@/lib/ciFleet/shardTargets');

    expect(switches.agentRunnerOnPool()).toBe(true);
    expect(await fleetKindOnPool('hosted_agent')).toBe(true);
  });
});

describe('the CI runner switch (MOTIR-9565) is the lane fixture’s, and Fly without it', () => {
  it('reads Fly with the seam off, and with the fixture absent, empty or on fly', async () => {
    const { fleetKindOnPool } = await import('@/lib/ciFleet/shardTargets');
    const { ciRunnerOnPoolInLane } = await import('@/lib/ciFleet/fleetKindSwitches');
    // No seam installed: nothing can say yes.
    expect(ciRunnerOnPoolInLane()).toBe(false);
    expect(await fleetKindOnPool('ci_runner')).toBe(false);

    await seamOn();
    // The fixture file does not exist yet.
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    writeFileSync(switchPath, '{}');
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    writeFileSync(switchPath, JSON.stringify({ ciRunner: 'fly' }));
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    // The agent runner's entry moves the agent runner only.
    writeAgentRunnerSwitch('aws');
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
    writeFileSync(switchPath, 'not json');
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
  });

  it('reads AWS when the fixture says so, re-read on every call, and leaves the agent runner alone', async () => {
    await seamOn();
    const { fleetKindOnPool } = await import('@/lib/ciFleet/shardTargets');
    writeFileSync(switchPath, JSON.stringify({ ciRunner: 'aws', hostedAgent: 'fly' }));
    expect(await fleetKindOnPool('ci_runner')).toBe(true);
    expect(await fleetKindOnPool('hosted_agent')).toBe(false);
    writeFileSync(switchPath, JSON.stringify({ ciRunner: 'fly' }));
    expect(await fleetKindOnPool('ci_runner')).toBe(false);
  });
});

describe('the lane wiring', () => {
  const config = readFileSync(join(ROOT, 'playwright.acceptance.config.ts'), 'utf8');

  it('hands the two paths and a digest-shaped image to the webServer and the runner', () => {
    for (const name of [
      'MOTIR_FAKE_AWS_STATE_PATH',
      'MOTIR_FAKE_FLEET_SWITCH_PATH',
      'MOTIR_HOSTED_AGENT_IMAGE',
    ]) {
      // Set on the runner (inherited by the spec process) …
      expect(config).toMatch(new RegExp(`process\\.env\\['${name}'\\] \\?\\?=`));
      // … and passed to the webServer.
      expect(config).toContain(`${name}: process.env['${name}']!`);
    }
    const image = /MOTIR_HOSTED_AGENT_IMAGE'\] \?\?=\s*'([^']+)'/.exec(config)![1]!;
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', image);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    expect(hostedAgentImage('aws')).toBe(image);
  });

  it('mirrors them to the job worker through hostedRunSeamEnv', async () => {
    vi.stubEnv('E2E_JOB_WORKER_HOSTED_RUN_SEAM', '1');
    vi.stubEnv('MOTIR_FAKE_AWS_STATE_PATH', statePath);
    vi.stubEnv('MOTIR_FAKE_FLEET_SWITCH_PATH', switchPath);
    vi.stubEnv('MOTIR_HOSTED_AGENT_IMAGE', IMAGE);
    const { hostedRunSeamEnv } = await import('../e2e/_helpers/job-worker-process');
    expect(hostedRunSeamEnv()).toMatchObject({
      MOTIR_FAKE_AWS_STATE_PATH: statePath,
      MOTIR_FAKE_FLEET_SWITCH_PATH: switchPath,
      MOTIR_HOSTED_AGENT_IMAGE: IMAGE,
    });
  });

  it('is one row of the table both the webServer and the worker install from', () => {
    expect(E2E_MOCK_SEAMS.map((s) => s.flag)).toContain('MOTIR_FAKE_AWS_STATE_PATH');
    for (const file of ['instrumentation.ts', 'scripts/worker.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain('installE2EMockSeams');
    }
  });
});

function fakeAwsInstancesIn(shard: FleetShardDTO) {
  expect(existsSync(statePath)).toBe(true);
  return fakeAwsInstances(shard.id);
}
