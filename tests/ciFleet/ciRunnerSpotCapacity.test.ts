import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  fakeOrchestrator,
  type ContainerSpec,
  type Ec2Api,
  type Ec2RunInstanceInput,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciSpotSettingService } from '@/lib/services/ciSpotSettingService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { CI_SPOT_SETTING_SCOPE } from '@/lib/repositories/platformCiSpotSettingRepository';
import { resetShardFakes, setAwsEc2OverrideForTests } from '@/lib/orchestrator';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// A CI RUNNER LAUNCHED AS SPOT (MOTIR-11716), against real Postgres: the boot
// asks for Spot only while the CI Spot setting (MOTIR-11725) is on, and records
// on the intent the capacity the launch GOT; and a CI pool account's AWS adapter
// walks the setting's ordered types, read on every launch.
//
// What is real: Postgres, the setting's row and its system read, the intent and
// the whole boot service, and — in the second block — the composition root and
// the AWS adapter. What is faked: GitHub (`fetch`), the orchestrator for the
// boot (the shipped `fake` adapter), and EC2 (the in-memory fake) for the adapter.

//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE here: the EC2 fake
// throws the source's `Ec2ApiError`, and the adapter types a Spot refusal by
// `instanceof` — the convention of `tests/ciFleet/fleetAttributionHoster.test.ts`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
}));

vi.mock('@motir/orchestrator', async () => {
  return (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
});

const ec2FakePath = '../../packages/orchestrator/test/contract/awsEc2Fake';

const MOTIR_ORG = 'motir-projects';
const RUNNER_GROUP_ID = 5042;
/** Supervision, at test speed — the boot path is what is under test. */
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;

let jobSeq = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The CI Spot setting as a superadmin would have saved it. */
async function saveSetting(enabled: boolean, instanceTypes: string[]): Promise<void> {
  await adminDb.platformCiSpotSetting.upsert({
    where: { scope: CI_SPOT_SETTING_SCOPE },
    create: { scope: CI_SPOT_SETTING_SCOPE, enabled, instanceTypes, lastReason: 'test' },
    update: { enabled, instanceTypes },
  });
}

async function seedIntent() {
  const email = `fleet-spot-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'O' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `S${randomInt(100, 1000)}`,
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      runnerGroupId: RUNNER_GROUP_ID,
      runnerGroupName: `motir-project-${project.id}`,
      runnerGroupSyncedAt: new Date(),
    },
  });
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      projectId: project.id,
      installationId: '556677',
      runId: '8101',
      runAttempt: 1,
      jobId: String(61_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(Date.now() - 5_000),
      status: 'pending',
    },
  });
}

/** Boot one intent to a never-starting container, and read the intent back. */
async function bootAndRead(intentId: string) {
  fakeOrchestrator.setBootBehaviour('never_start');
  await ciRunnerBootService.runIntent(intentId, FAST);
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intentId } });
}

/** Make the fake's handle report `capacity`, as an adapter with Spot does. */
function handlesReport(capacity: 'spot' | 'on_demand') {
  const provision = fakeOrchestrator.provision.bind(fakeOrchestrator);
  vi.spyOn(fakeOrchestrator, 'provision').mockImplementation(async (spec) => ({
    ...(await provision(spec)),
    capacity,
  }));
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
  fakeOrchestrator.reset();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const href = String(url);
      if (href.endsWith(`/orgs/${MOTIR_ORG}/installation`)) return json(200, { id: 556677 });
      if (href.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (href.includes('generate-jitconfig')) {
        return json(201, {
          runner: { id: 9101, name: 'motir-runner', status: 'offline' },
          encoded_jit_config: 'ZW5jb2RlZC1qaXQ=',
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.platformCiSpotSetting.deleteMany();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the boot asks for Spot only while the setting is on', () => {
  it('setting off (no row): the spec asks for no Spot, and the intent records on_demand', async () => {
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]).not.toHaveProperty('capacity');
    expect(read.capacity).toBe('on_demand');
  });

  it('setting saved OFF: the same — no Spot asked, on_demand recorded', async () => {
    await saveSetting(false, ['m6i.large']);
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]).not.toHaveProperty('capacity');
    expect(read.capacity).toBe('on_demand');
  });

  it('setting on: the spec asks for Spot, and the intent records the spot the handle reports', async () => {
    await saveSetting(true, ['m6i.large', 'm7i.large']);
    handlesReport('spot');
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]!.capacity).toBe('spot');
    expect(read.capacity).toBe('spot');
  });

  it('setting on, Spot refused: the intent records the on_demand the handle reports', async () => {
    await saveSetting(true, ['m6i.large']);
    handlesReport('on_demand');
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]!.capacity).toBe('spot');
    expect(read.capacity).toBe('on_demand');
  });

  it('setting on, a provider with no Spot (no capacity on its handle): on_demand recorded', async () => {
    await saveSetting(true, ['m6i.large']);
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs[0]!.capacity).toBe('spot');
    expect(read.capacity).toBe('on_demand');
  });

  it('a setting that cannot be read asks for no Spot — the runner still boots', async () => {
    vi.spyOn(ciSpotSettingService, 'read').mockRejectedValue(new Error('database away'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const intent = await seedIntent();

    const read = await bootAndRead(intent.id);

    expect(fakeOrchestrator.specs).toHaveLength(1);
    expect(fakeOrchestrator.specs[0]).not.toHaveProperty('capacity');
    expect(read.capacity).toBe('on_demand');
    expect(JSON.stringify(warn.mock.calls)).toContain('could not be read');
  });

  it('buildSpec puts capacity on the spec only when it is spot', async () => {
    const intent = await seedIntent();
    const base = {
      intent,
      workflowJobId: 1,
      projectId: intent.projectId!,
      encodedJitConfig: 'x',
      timeoutSeconds: 60,
      orchestrator: fakeOrchestrator,
    };

    expect(ciRunnerBootService.buildSpec({ ...base, capacity: 'spot' }).capacity).toBe('spot');
    expect(ciRunnerBootService.buildSpec({ ...base, capacity: 'on_demand' })).not.toHaveProperty(
      'capacity',
    );
    expect(ciRunnerBootService.buildSpec(base)).not.toHaveProperty('capacity');
  });
});

describe("a CI pool account's AWS adapter walks the setting's types, read per launch", () => {
  let ec2: Ec2Api & {
    seedShardNetwork(tag: string, zones?: readonly string[]): unknown;
    calls: Array<{ method: string; input: unknown }>;
    refuseSpot(refusal: { instanceType: string; zone?: string; code?: string }): void;
  };

  beforeAll(async () => {
    const { AwsEc2Fake } = (await import(/* @vite-ignore */ ec2FakePath)) as {
      AwsEc2Fake: new () => typeof ec2;
    };
    ec2 = new AwsEc2Fake();
  });

  beforeEach(async () => {
    await adminDb.fleetShard.deleteMany({});
    resetShardFakes();
    fleetShardOrchestratorService.resetCache();
    (ec2 as unknown as { clear(): void }).clear();
    setAwsEc2OverrideForTests(() => ec2);
  });

  afterEach(async () => {
    setAwsEc2OverrideForTests(null);
    await adminDb.fleetShard.deleteMany({});
  });

  function runnerSpec(capacity?: 'spot' | 'on_demand'): ContainerSpec {
    return {
      orgId: 'org-spot',
      workspaceId: 'ws-spot',
      projectId: 'proj-spot',
      repoFullName: `${MOTIR_ORG}/acme-web`,
      workload: 'ci_runner',
      workflowJobId: 61_001,
      image: 'unused-on-aws',
      size: FLEET_CONTAINER_SIZE,
      env: {
        ACTIONS_RUNNER_INPUT_JITCONFIG: 'jit',
        MOTIR_RUNNER_LABEL: 'motir-spot',
        MOTIR_INTENT_ID: 'intent-spot',
        MOTIR_WORKFLOW_JOB_ID: '61001',
      },
      timeoutSeconds: 3600,
      region: 'us-east-1',
      ...(capacity ? { capacity } : {}),
    };
  }

  function launches(): Ec2RunInstanceInput[] {
    return ec2.calls
      .filter((c) => c.method === 'runInstances')
      .map((c) => c.input as Ec2RunInstanceInput);
  }

  async function poolAccount() {
    const shard = await fleetShardService.createShard({
      name: `ci-runner-use1-${randomToken(4)}`,
      fleetKind: 'ci_runner',
      provider: 'aws',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      awsAccountId: '111111111111',
      awsRegion: 'us-east-1',
      credentialRef: 'AWS_SPOT_ACCOUNT',
      limits: { machineLimit: 10 },
    });
    ec2.seedShardNetwork(shard.name, ['us-east-1a', 'us-east-1b']);
    return shard;
  }

  it("launches a Spot runner on the setting's first type, and a saved change reaches the next launch", async () => {
    await saveSetting(true, ['m7i.large', 'm5.large']);
    const shard = await poolAccount();

    const first = await fleetShardOrchestratorService
      .forShardRow(shard)
      .provision(runnerSpec('spot'));

    expect(first.capacity).toBe('spot');
    expect(launches()).toEqual([
      expect.objectContaining({ instanceType: 'm7i.large', market: 'spot' }),
    ]);

    // The adapter is cached per account; the list is not.
    await saveSetting(true, ['m5.large']);
    await fleetShardOrchestratorService.forShardRow(shard).provision(runnerSpec('spot'));

    expect(launches()[1]).toMatchObject({ instanceType: 'm5.large', market: 'spot' });
  });

  it('falls back to ONE on-demand launch on the account type when every listed type is refused', async () => {
    await saveSetting(true, ['m7i.large']);
    ec2.refuseSpot({ instanceType: 'm7i.large' });
    const shard = await poolAccount();

    const handle = await fleetShardOrchestratorService
      .forShardRow(shard)
      .provision(runnerSpec('spot'));

    expect(handle.capacity).toBe('on_demand');
    const sent = launches();
    expect(sent.filter((l) => l.market === 'spot')).toHaveLength(2);
    const onDemand = sent.filter((l) => l.market !== 'spot');
    expect(onDemand).toHaveLength(1);
    expect(onDemand[0]!.instanceType).toBe('m6i.large');
    expect(onDemand[0]).not.toHaveProperty('market');
  });

  it('a runner that asks for no Spot sends exactly the on-demand request, reading no setting', async () => {
    await saveSetting(true, ['m7i.large']);
    const read = vi.spyOn(ciSpotSettingService, 'read');
    const shard = await poolAccount();

    const handle = await fleetShardOrchestratorService.forShardRow(shard).provision(runnerSpec());

    expect(handle).not.toHaveProperty('capacity');
    expect(launches()).toHaveLength(1);
    expect(launches()[0]).toMatchObject({ instanceType: 'm6i.large' });
    expect(launches()[0]).not.toHaveProperty('market');
    expect(read).not.toHaveBeenCalled();
  });
});
