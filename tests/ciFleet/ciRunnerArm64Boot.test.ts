import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorCapacityError,
  OrchestratorNotConfiguredError,
  type Ec2RunInstanceInput,
  type ContainerOrchestrator,
  type Ec2Api,
  type Ec2Instance,
  type FakeOrchestratorControls,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { SHARD_CAPACITY_DETAIL } from '@/lib/services/fleetShardAdmissionService';
import {
  AWS_RUNNER_AMI_ENV_VAR,
  AWS_RUNNER_ARM64_AMI_ENV_VAR,
  readArm64RunnerAmiId,
  setAwsEc2OverrideForTests,
  resetShardFakes,
} from '@/lib/orchestrator';
import { ARM64_RUNNER_AMI_NOT_PINNED_DETAIL } from '@/lib/services/ciRunnerBootService';
import { MOTIR_ARM64_RUNNER_LABEL, MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { CI_SPOT_SETTING_SCOPE } from '@/lib/repositories/platformCiSpotSettingRepository';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { runnerRole, stubAwsManagementCredential } from '../helpers/awsRunnerRoleFake';

// AN ARM64 CI RUNNER BOOTS A GRAVITON VM, OR IS REFUSED NOT BOOTABLE (MOTIR-11782),
// against real Postgres. An intent whose job asked for `motir-graviton` boots
// ON-DEMAND m7g.large from `MOTIR_AWS_RUNNER_ARM64_AMI_ID` with a JIT runner
// carrying only that label, through the same boot, account move and
// `shard_capacity` deferral an x86 runner takes; with no arm64 AMI pinned it is
// refused before the mint, and never booted on the x86 AMI or an x86 type.
//
// The harness is `awsPoolDeferral.test.ts`'s: the REAL `createAwsOrchestrator`,
// reached through the real per-account resolution for `aws` rows of the
// `ci_runner` pool, each over its own in-memory EC2 keyed on the credential the
// resolution read; GitHub is `fetch`; Fly is a fake that must never be called.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE'S SOURCE HERE, not its built
// `dist`, so the EC2 fake and the adapter share one copy of every error class.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly instances: ReadonlyMap<string, Ec2Instance>;
  readonly refusals: ReadonlyArray<{ zone: string; clientToken: string; code: string }>;
  clear(): void;
  seedShardNetwork(shardTag: string, zones?: readonly string[]): unknown;
  failNextRunInstances(refusal: { code: string; zone?: string }): void;
  liveInstanceIds(): string[];
  count(method: string): number;
}

type FakeFleet = ContainerOrchestrator & FakeOrchestratorControls;

const fakes = vi.hoisted(() => ({
  /** Each account's EC2, by the access key id of its runner-role session. */
  ec2ByKeyId: new Map<string, unknown>(),
  fly: null as unknown,
}));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  fakes.fly = source.createFakeOrchestrator({ idPrefix: 'fly-machine' });
  return {
    ...source,
    createAwsManagementApi: () => runnerRole.management(),
    createEc2Api: (config: Parameters<typeof runnerRole.ec2For>[0]) =>
      runnerRole.ec2For(config, (keyId) => fakes.ec2ByKeyId.get(keyId) as object | undefined),
    flyOrchestrator: fakes.fly,
  };
});

const PASSWORD = 'hunter2hunter2';
const MOTIR_ORG = 'motir-projects';
const RUNNER_GROUP_ID = 5042;
const QUEUED_AT = new Date(Date.now() - 5_000);
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;
const REGION = 'us-east-1';
const ZONES = ['us-east-1a', 'us-east-1b'];
const AMI_ID = 'ami-0123456789abcdef0';
const ARM64_AMI_ID = 'ami-0a1b2c3d4e5f6a7b8';

/** The JIT config GitHub mints — a marker that must surface in no error and no log. */
const JIT_MARKER = 'MOTIR-11782-JIT-MARKER';
const ENCODED_JIT = Buffer.from(`{"marker":"${JIT_MARKER}"}`).toString('base64');

let AwsEc2Fake: new () => Ec2Fake;

interface GithubCall {
  url: string;
  method: string;
  body: unknown;
}

let githubCalls: GithubCall[];
let logged: unknown[][];
/** Every error an account's orchestrator threw at the boot service. */
let received: Array<{ shardId: string; error: unknown }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mintCalls = () => githubCalls.filter((c) => c.url.includes('generate-jitconfig'));
const deleteRunnerCalls = () =>
  githubCalls.filter((c) => c.method === 'DELETE' && /\/actions\/runners\/\d+$/.test(c.url));
const fly = () => fakes.fly as FakeFleet;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const email = `aws-pool-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `A${randomInt(100, 1000)}`,
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      runnerGroupId: RUNNER_GROUP_ID,
      runnerGroupName: `motir-project-${project.id}`,
      runnerGroupSyncedAt: new Date(),
    },
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;

async function seedIntent(fx: Fixture, labels: string[] = [MOTIR_ARM64_RUNNER_LABEL]) {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(92_790 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: labels,
      queuedAt: QUEUED_AT,
      status: 'pending',
    },
  });
}

interface AwsAccount {
  shard: FleetShardDTO;
  ec2: Ec2Fake;
}

/** One `aws` account of the CI pool: its row, its credential and its own EC2,
 *  with the tagged network the pool-account definition builds. */
async function awsAccount(label: string, machineLimit: number): Promise<AwsAccount> {
  const credentialRef = `AWS_POOL_${label}_${randomToken(4).toUpperCase()}`;
  const accessKeyId = `AKIA${label}${randomToken(8).toUpperCase()}`;
  const awsAccountId = label === 'A' ? '111111111111' : '222222222222';
  runnerRole.grant(awsAccountId, accessKeyId);
  const shard = await fleetShardService.createShard({
    name: `ci-runner-use1-${label.toLowerCase()}-${randomToken(4).toLowerCase()}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: MOTIR_ORG,
    githubInstallationId: '556677',
    awsAccountId,
    awsRegion: REGION,
    credentialRef,
    limits: { machineLimit },
  });
  const ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(shard.name, ZONES);
  fakes.ec2ByKeyId.set(accessKeyId, ec2);
  return { shard, ec2 };
}

/** The CI kind on its AWS pool: A (most headroom, so chosen first) and B. */
async function pool() {
  wireFleetKindSwitch('ci_runner', () => true);
  return { a: await awsAccount('A', 50), b: await awsAccount('B', 10) };
}

async function rowOf(id: string) {
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });
}

/** The JIT marker reached no thrown error and no log line. */
function expectMarkerNowhere(): void {
  for (const { error } of received) {
    const text = error instanceof Error ? `${error.message} ${error.stack ?? ''}` : String(error);
    expect(text).not.toContain(JIT_MARKER);
    expect(text).not.toContain(ENCODED_JIT);
  }
  for (const args of logged) {
    const text = args
      .map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : JSON.stringify(a)))
      .join(' ');
    expect(text).not.toContain(JIT_MARKER);
    expect(text).not.toContain(ENCODED_JIT);
  }
}

/** One mint, in the repository's own org. */
function expectOneMintInRepoOrg(): void {
  expect(mintCalls()).toHaveLength(1);
  expect(mintCalls()[0]!.url).toContain(`/orgs/${MOTIR_ORG}/`);
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
  fly().reset();
  fakes.ec2ByKeyId.clear();
  runnerRole.reset();
  stubAwsManagementCredential();
  fleetShardOrchestratorService.resetCache();
  githubCalls = [];
  logged = [];
  received = [];

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  // The deployment's own selection — Fly, configured — so the process-wide fleet
  // is the Fly fake and each account resolves through its real `aws` case.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-ci');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'motir/ci-runner@sha256:test');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI_ID);
  vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, ARM64_AMI_ID);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: GithubCall = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      githubCalls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) return json(200, { id: 556677 });
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (call.url.includes('generate-jitconfig')) {
        return json(201, {
          runner: { id: 9001, name: 'motir-runner', status: 'offline' },
          encoded_jit_config: ENCODED_JIT,
        });
      }
      return new Response(null, { status: 204 });
    }),
  );

  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }

  // Pass-through: every account orchestrator the boot resolves is the real one;
  // this only keeps what its `provision` threw.
  const resolve = fleetShardOrchestratorService.forShardRow.bind(fleetShardOrchestratorService);
  vi.spyOn(fleetShardOrchestratorService, 'forShardRow').mockImplementation((shard) => {
    const orchestrator = resolve(shard);
    return new Proxy(orchestrator, {
      get(target, prop, receiver) {
        if (prop !== 'provision') return Reflect.get(target, prop, receiver);
        return async (spec: Parameters<ContainerOrchestrator['provision']>[0]) => {
          try {
            return await target.provision(spec);
          } catch (error) {
            received.push({ shardId: shard.id, error });
            throw error;
          }
        };
      },
    });
  });
});

afterEach(async () => {
  wireFleetKindSwitch('ci_runner', null);
  await adminDb.platformCiSpotSetting.deleteMany();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // The account is RESTRICTed while an intent records it.
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every RunInstances an account's EC2 was sent. */
function launches(ec2: Ec2Fake): Ec2RunInstanceInput[] {
  return ec2.calls
    .filter((c) => c.method === 'runInstances')
    .map((c) => c.input as Ec2RunInstanceInput);
}

/** The labels of the one JIT runner minted. */
function mintedLabels(): unknown {
  return (mintCalls()[0]!.body as { labels?: unknown }).labels;
}

/** The CI Spot setting as a superadmin would have saved it (MOTIR-11725). */
async function saveSpotSetting(enabled: boolean, instanceTypes: string[]): Promise<void> {
  await adminDb.platformCiSpotSetting.upsert({
    where: { scope: CI_SPOT_SETTING_SCOPE },
    create: { scope: CI_SPOT_SETTING_SCOPE, enabled, instanceTypes, lastReason: 'test' },
    update: { enabled, instanceTypes },
  });
}

describe('an arm64 intent boots on-demand m7g.large from the arm64 AMI', () => {
  it('sends ONE RunInstances of m7g.large with the arm64 AMI, no market, and mints only motir-graviton', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    expect(booted.session.handle).toMatchObject({ provider: 'aws', shardId: a.shard.id });
    const sent = launches(a.ec2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ instanceType: 'm7g.large', imageId: ARM64_AMI_ID });
    expect(sent[0]).not.toHaveProperty('market');
    expect(b.ec2.count('runInstances')).toBe(0);
    expectOneMintInRepoOrg();
    expect(mintedLabels()).toEqual([MOTIR_ARM64_RUNNER_LABEL]);
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'running',
      fleetShardId: a.shard.id,
      capacity: 'on_demand',
    });
    expect(fly().provisioned).toEqual([]);
    expectMarkerNowhere();
  });

  it('with the CI Spot setting ON, still on-demand m7g.large — no Spot type is tried', async () => {
    await saveSpotSetting(true, ['m6i.large', 'm7i.large']);
    const fx = await seedTenant();
    const { a } = await pool();
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    const sent = launches(a.ec2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ instanceType: 'm7g.large', imageId: ARM64_AMI_ID });
    expect(sent.filter((l) => l.market === 'spot')).toEqual([]);
    expect(sent[0]).not.toHaveProperty('market');
    expect((await rowOf(intent.id)).capacity).toBe('on_demand');
  });

  it('buildSpec asks for arm64 and never for Spot, whatever capacity it is handed', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    const spec = ciRunnerBootService.buildSpec({
      intent,
      workflowJobId: 1,
      projectId: fx.projectId,
      encodedJitConfig: 'x',
      timeoutSeconds: 60,
      orchestrator: fly(),
      capacity: 'spot',
    });

    expect(spec.architecture).toBe('arm64');
    expect(spec).not.toHaveProperty('capacity');
    expect(spec.env.MOTIR_RUNNER_LABEL).toBe(MOTIR_ARM64_RUNNER_LABEL);
  });
});

describe('an x86 intent boots exactly as before, arm64 AMI set or not', () => {
  it.each([
    ['set', ARM64_AMI_ID],
    ['unset', ''],
  ])('arm64 AMI %s: m6i.large from the runner AMI, minting only motir-runner', async (_, value) => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, value);
    const fx = await seedTenant();
    const { a } = await pool();
    const intent = await seedIntent(fx, [MOTIR_RUNNER_LABEL]);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    const sent = launches(a.ec2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ instanceType: 'm6i.large', imageId: AMI_ID });
    expect(mintedLabels()).toEqual([MOTIR_RUNNER_LABEL]);
    const spec = ciRunnerBootService.buildSpec({
      intent,
      workflowJobId: 1,
      projectId: fx.projectId,
      encodedJitConfig: 'x',
      timeoutSeconds: 60,
      orchestrator: fly(),
    });
    expect(spec).not.toHaveProperty('architecture');
    expect(spec.env.MOTIR_RUNNER_LABEL).toBe(MOTIR_RUNNER_LABEL);
  });
});

describe('an arm64 intent with no arm64 AMI pinned is refused not bootable', () => {
  it.each([
    ['unset', undefined],
    ['blank', '   '],
  ])('%s: no mint, no launch, settled failed with the named reason', async (_, value) => {
    if (value === undefined) delete process.env[AWS_RUNNER_ARM64_AMI_ENV_VAR];
    else vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, value);
    const fx = await seedTenant();
    const { a, b } = await pool();
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result).toEqual({
      phase: 'terminal',
      outcome: {
        outcome: 'not_bootable',
        reason: 'arm64_runner_ami_not_pinned',
        detail: ARM64_RUNNER_AMI_NOT_PINNED_DETAIL,
      },
    });
    expect(ARM64_RUNNER_AMI_NOT_PINNED_DETAIL).toContain('arm64 runner AMI is pinned');
    expect(mintCalls()).toEqual([]);
    expect(deleteRunnerCalls()).toEqual([]);
    expect(a.ec2.count('runInstances')).toBe(0);
    expect(b.ec2.count('runInstances')).toBe(0);
    expect(fly().provisioned).toEqual([]);
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({ status: 'failed', teardownReason: 'provision_failed' });
    expect(row.failureDetail).toContain('arm64_runner_ami_not_pinned');
  });
});

describe('an arm64 capacity refusal moves or defers exactly as an x86 one', () => {
  it('out of stock in every zone of A boots the same runner on B, still m7g.large', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    for (const zone of ZONES) {
      a.ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity', zone });
    }
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    expect(received).toHaveLength(1);
    expect(received[0]!.error).toBeInstanceOf(OrchestratorCapacityError);
    expect(booted.session.handle).toMatchObject({ provider: 'aws', shardId: b.shard.id });
    expect(
      [...launches(a.ec2), ...launches(b.ec2)].every((l) => l.instanceType === 'm7g.large'),
    ).toBe(true);
    expect(launches(b.ec2)[0]).toMatchObject({ imageId: ARM64_AMI_ID });
    // The SAME JIT runner: one mint, no de-registration.
    expectOneMintInRepoOrg();
    expect(deleteRunnerCalls()).toEqual([]);
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'running',
      fleetShardId: b.shard.id,
      fleetShardMoveReason: 'capacity_refused',
    });
    expectMarkerNowhere();
  });

  it('every account at quota defers shard_capacity and de-registers the runner', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    a.ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' });
    b.ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' });
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result).toEqual({
      phase: 'terminal',
      outcome: {
        outcome: 'gate_deferred',
        reason: 'shard_capacity',
        detail: SHARD_CAPACITY_DETAIL,
      },
    });
    expectOneMintInRepoOrg();
    expect(deleteRunnerCalls()).toHaveLength(1);
    expect(await rowOf(intent.id)).toMatchObject({ status: 'pending', teardownReason: null });
    expect(fly().provisioned).toEqual([]);
    expectMarkerNowhere();
  });
});

describe('readArm64RunnerAmiId — the one arm64-readiness read', () => {
  it.each([
    ['ami-0a1b2c3d4e5f6a7b8', 'ami-0a1b2c3d4e5f6a7b8'],
    ['  ami-0a1b2c3d4e5f6a7b8 \n', 'ami-0a1b2c3d4e5f6a7b8'],
    ['', null],
    ['   ', null],
  ])('%j reads %j', (value, expected) => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, value);
    expect(readArm64RunnerAmiId()).toBe(expected);
  });

  it('reads null when the variable is unset', () => {
    delete process.env[AWS_RUNNER_ARM64_AMI_ENV_VAR];
    expect(readArm64RunnerAmiId()).toBeNull();
  });
});

describe("under the acceptance lane's fake EC2, an unset arm64 AMI stays unset", () => {
  afterEach(() => {
    setAwsEc2OverrideForTests(null);
    resetShardFakes();
  });

  it("builds the CI shard's adapter with no arm64 AMI rather than the lane's fake one", async () => {
    vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, '');
    delete process.env[AWS_RUNNER_ARM64_AMI_ENV_VAR];
    const ec2 = new AwsEc2Fake();
    setAwsEc2OverrideForTests(() => ec2);
    resetShardFakes();
    fleetShardOrchestratorService.resetCache();
    const { a } = await pool();
    ec2.seedShardNetwork(a.shard.name, ZONES);
    const orchestrator = fleetShardOrchestratorService.forShardRow(a.shard);
    const spec = {
      orgId: 'org-arm',
      workspaceId: 'ws-arm',
      projectId: 'proj-arm',
      repoFullName: `${MOTIR_ORG}/acme-web`,
      workload: 'ci_runner' as const,
      workflowJobId: 61_001,
      image: 'unused-on-aws',
      size: FLEET_CONTAINER_SIZE,
      env: {
        ACTIONS_RUNNER_INPUT_JITCONFIG: 'jit',
        MOTIR_RUNNER_LABEL: 'motir-runner',
        MOTIR_INTENT_ID: 'i',
        MOTIR_WORKFLOW_JOB_ID: '1',
      },
      timeoutSeconds: 3600,
      region: REGION,
    };

    // x86 still boots: the lane fills the missing runner AMI with its fake id.
    await orchestrator.provision(spec);
    expect(ec2.count('runInstances')).toBe(1);
    // arm64 is refused before any launch: no fake arm64 AMI was filled in.
    await expect(orchestrator.provision({ ...spec, architecture: 'arm64' })).rejects.toBeInstanceOf(
      OrchestratorNotConfiguredError,
    );
    expect(ec2.count('runInstances')).toBe(1);
  });
});
