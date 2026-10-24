import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrchestratorApiError,
  OrchestratorCapacityError,
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
import { AWS_RUNNER_AMI_ENV_VAR } from '@/lib/orchestrator';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SHARD_PAUSE_SECONDS, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// AN AWS CAPACITY REFUSAL MOVES THE JOB OR DEFERS IT — NEVER TO FLY (Story
// MOTIR-9270 · MOTIR-9279), against real Postgres.
//
// The two seams this joins are each proven alone: the AWS adapter types EC2's
// "full" refusals (`awsCapacity.test.ts`, MOTIR-9277), and admission moves a
// refused boot to the next account of the kind or defers it
// (`ciRunnerBootService.test.ts`, MOTIR-8968 — over the generic per-account
// fake). What nothing showed is the two together: the REAL `createAwsOrchestrator`,
// reached through the real per-account resolution (`awsOrchestratorForShard`,
// MOTIR-8964 · MOTIR-9276) for two `aws` rows of the `ci_runner` pool, refused by
// its own in-memory EC2, ending on the other account or deferred.
//
// What is faked, and how:
//   - EC2: each account's `createEc2Api` answers the `AwsEc2Fake` keyed on that
//     account's access key id — so the credential the resolution READ is what
//     picks the fake, and every refusal comes out of the adapter's own
//     classification.
//   - Fly: the process-wide `flyOrchestrator` is a fake, present only so a test
//     can say it was never called while the CI switch is on AWS.
//   - GitHub: `fetch`, exactly as `ciRunnerBootService.test.ts` stubs it.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE'S SOURCE HERE, not its built
// `dist`. The EC2 fake lives beside the adapter's own tests and throws the
// SOURCE's `Ec2ApiError`; the adapter tells a capacity code by `instanceof`, so a
// fake and an adapter from two copies of the package would read every refusal as
// unknown. Pointing the app at the source keeps one copy of every class.

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
  /** Each account's EC2, by the access key id its credential names. */
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
    createEc2Api: (config: { accessKeyId: string }) => {
      const ec2 = fakes.ec2ByKeyId.get(config.accessKeyId);
      if (!ec2) throw new Error(`no EC2 fake for ${config.accessKeyId}`);
      return ec2;
    },
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

/** The JIT config GitHub mints — a marker that must surface in no error and no log. */
const JIT_MARKER = 'MOTIR-9279-JIT-MARKER';
const ENCODED_JIT = Buffer.from(`{"marker":"${JIT_MARKER}"}`).toString('base64');

let AwsEc2Fake: new () => Ec2Fake;

interface GithubCall {
  url: string;
  method: string;
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

async function seedIntent(fx: Fixture) {
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
      requestedLabels: [MOTIR_RUNNER_LABEL],
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
 *  with the tagged network `ensureAwsShardNetwork` would have left. */
async function awsAccount(label: string, machineLimit: number): Promise<AwsAccount> {
  const credentialRef = `AWS_POOL_${label}_${randomToken(4).toUpperCase()}`;
  const accessKeyId = `AKIA${label}${randomToken(8).toUpperCase()}`;
  vi.stubEnv(`${credentialRef}_ACCESS_KEY_ID`, accessKeyId);
  vi.stubEnv(`${credentialRef}_SECRET_ACCESS_KEY`, `secret-${label}`);
  const shard = await fleetShardService.createShard({
    name: `ci-runner-use1-${label.toLowerCase()}-${randomToken(4).toLowerCase()}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: MOTIR_ORG,
    githubInstallationId: '556677',
    awsAccountId: label === 'A' ? '111111111111' : '222222222222',
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

async function shardRow(id: string) {
  return adminDb.fleetShard.findUniqueOrThrow({ where: { id } });
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

async function expectNoProvisionFailed(): Promise<void> {
  expect(
    await adminDb.ciRunnerProvisioningIntent.count({
      where: { teardownReason: 'provision_failed' },
    }),
  ).toBe(0);
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  fly().reset();
  fakes.ec2ByKeyId.clear();
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
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: GithubCall = { url: String(url), method: init?.method ?? 'GET' };
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

describe('a capacity refusal on one AWS account moves the job to the other', () => {
  it.each([
    ['quota_exceeded', (ec2: Ec2Fake) => ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' })],
    [
      'out_of_stock',
      (ec2: Ec2Fake) => {
        for (const zone of ZONES) {
          ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity', zone });
        }
      },
    ],
    ['throttled', (ec2: Ec2Fake) => ec2.failNextRunInstances({ code: 'RequestLimitExceeded' })],
  ] as const)('%s on A boots the same runner on B', async (reason, refuse) => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    refuse(a.ec2);
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    // The adapter's OWN typed error is what the boot service received from A.
    expect(received).toHaveLength(1);
    const refusal = received[0]!;
    expect(refusal.shardId).toBe(a.shard.id);
    expect(refusal.error).toBeInstanceOf(OrchestratorCapacityError);
    expect(refusal.error).toMatchObject({ provider: 'aws', reason });

    // Booted on B, one EC2 instance, the same JIT runner.
    expect(booted.session.handle).toMatchObject({ provider: 'aws', shardId: b.shard.id });
    expect(b.ec2.liveInstanceIds()).toEqual([booted.session.handle.id]);
    expect(a.ec2.instances.size).toBe(0);
    expect(a.ec2.liveInstanceIds()).toEqual([]);
    expect(fly().provisioned).toEqual([]);
    expectOneMintInRepoOrg();
    expect(deleteRunnerCalls()).toEqual([]);
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({
      status: 'running',
      fleetShardId: b.shard.id,
      fleetShardMoveReason: 'capacity_refused',
      githubRunnerId: 9001,
      containerId: booted.session.handle.id,
    });
    expect((await shardRow(a.shard.id)).admissionPausedReason).toBe('capacity_refused');
    await expectNoProvisionFailed();
    expectMarkerNowhere();
  });

  it('out of stock in the first zone only stays on A, in another zone', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    a.ec2.failNextRunInstances({ code: 'InsufficientInstanceCapacity' });
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    expect(a.ec2.refusals).toHaveLength(1);
    const refusedZone = a.ec2.refusals[0]!.zone;
    expect(booted.session.handle.shardId).toBe(a.shard.id);
    const instance = a.ec2.instances.get(booted.session.handle.id)!;
    expect(ZONES).toContain(instance.availabilityZone);
    expect(instance.availabilityZone).not.toBe(refusedZone);
    expect(received).toEqual([]);
    expect(b.ec2.count('runInstances')).toBe(0);
    expect(fly().provisioned).toEqual([]);
    expectOneMintInRepoOrg();
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'running',
      fleetShardId: a.shard.id,
      fleetShardMoveReason: null,
    });
    expect((await shardRow(a.shard.id)).admissionPausedUntil).toBeNull();
    expectMarkerNowhere();
  });

  it('while A is paused, the next job is placed on B and A sees no launch', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    a.ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' });
    const first = await seedIntent(fx);
    const moved = await ciRunnerBootService.bootIntent(first.id, FAST);
    if (moved.phase !== 'supervising') throw new Error(`unreachable: ${moved.phase}`);
    expect(moved.session.handle.shardId).toBe(b.shard.id);
    expect(a.ec2.count('runInstances')).toBe(1);

    const second = await seedIntent(fx);
    const next = await ciRunnerBootService.bootIntent(second.id, FAST);
    if (next.phase !== 'supervising') throw new Error(`unreachable: ${next.phase}`);

    expect(next.session.handle.shardId).toBe(b.shard.id);
    expect(await rowOf(second.id)).toMatchObject({
      status: 'running',
      fleetShardId: b.shard.id,
      fleetShardMoveReason: null,
    });
    expect(a.ec2.count('runInstances')).toBe(1);
    expect(b.ec2.liveInstanceIds()).toHaveLength(2);
    expect(fly().provisioned).toEqual([]);
    await expectNoProvisionFailed();
    expectMarkerNowhere();
  });
});

describe('every account refusing defers the job — never Fly, never lost', () => {
  it('both accounts at quota: runner deregistered, claim and account cleared, pending', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    a.ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' });
    b.ec2.failNextRunInstances({ code: 'InstanceLimitExceeded' });
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
    expect(received.map((r) => r.shardId)).toEqual([a.shard.id, b.shard.id]);
    for (const { error } of received) {
      expect(error).toBeInstanceOf(OrchestratorCapacityError);
      expect(error).toMatchObject({ reason: 'quota_exceeded' });
    }
    expectOneMintInRepoOrg();
    expect(deleteRunnerCalls()).toHaveLength(1);
    const row = await rowOf(intent.id);
    expect(row).toMatchObject({
      status: 'pending',
      fleetShardId: null,
      fleetShardMoveReason: null,
      teardownReason: null,
    });
    expect(row.shardCapacityDeferredAt).not.toBeNull();
    expect(a.ec2.liveInstanceIds()).toEqual([]);
    expect(b.ec2.liveInstanceIds()).toEqual([]);
    expect(fly().provisioned).toEqual([]);
    await expectNoProvisionFailed();
    expectMarkerNowhere();
  });

  it('once capacity recovers and the pause passes, the same intent boots once on the pool', async () => {
    const start = new Date();
    vi.setSystemTime(start);
    const fx = await seedTenant();
    const { a, b } = await pool();
    a.ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' });
    b.ec2.failNextRunInstances({ code: 'VcpuLimitExceeded' });
    const intent = await seedIntent(fx);
    expect(await ciRunnerBootService.bootIntent(intent.id, FAST)).toMatchObject({
      outcome: { reason: 'shard_capacity' },
    });

    // Capacity recovers: no refusal is left arranged on either account.
    for (const account of [a, b]) {
      account.ec2.clear();
      account.ec2.seedShardNetwork(account.shard.name, ZONES);
    }
    vi.setSystemTime(new Date(start.getTime() + SHARD_PAUSE_SECONDS * 1000 + 1_000));

    // The sweep finds the deferred intent and boots it.
    expect(await ciRunnerBootService.listRunnableIntentIds()).toContain(intent.id);
    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    expect([a.shard.id, b.shard.id]).toContain(booted.session.handle.shardId);
    expect([...a.ec2.liveInstanceIds(), ...b.ec2.liveInstanceIds()]).toEqual([
      booted.session.handle.id,
    ]);
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'running',
      fleetShardId: booted.session.handle.shardId,
    });
    expect(
      await adminDb.ciRunnerProvisioningIntent.count({
        where: { status: { in: ['provisioning', 'running'] } },
      }),
    ).toBe(1);
    // Two mints — the deferred boot's, deregistered, and this one: one runner left.
    expect(mintCalls()).toHaveLength(2);
    expect(deleteRunnerCalls()).toHaveLength(1);
    expect(fly().provisioned).toEqual([]);
    await expectNoProvisionFailed();
    expectMarkerNowhere();
  });

  it('a pool with no account defers the job without booting it anywhere', async () => {
    wireFleetKindSwitch('ci_runner', () => true);
    const fx = await seedTenant();
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'gate_deferred', reason: 'shard_capacity' },
    });
    expect(await rowOf(intent.id)).toMatchObject({
      status: 'pending',
      fleetShardId: null,
      teardownReason: null,
    });
    expect(mintCalls()).toEqual([]);
    expect(fly().provisioned).toEqual([]);
    await expectNoProvisionFailed();
  });
});

describe('only a typed capacity refusal moves or defers', () => {
  it('an invalid AMI on A neither moves the job to B nor defers it as capacity', async () => {
    const fx = await seedTenant();
    const { a, b } = await pool();
    a.ec2.failNextRunInstances({ code: 'InvalidAMIID.NotFound' });
    const intent = await seedIntent(fx);

    const result = await ciRunnerBootService.bootIntent(intent.id, FAST);

    expect(result.phase).toBe('terminal');
    expect(result).not.toMatchObject({ outcome: { reason: 'shard_capacity' } });
    expect(received).toHaveLength(1);
    expect(received[0]!.error).toBeInstanceOf(OrchestratorApiError);
    expect(received[0]!.error).not.toBeInstanceOf(OrchestratorCapacityError);
    expect(b.ec2.count('runInstances')).toBe(0);
    expect(fly().provisioned).toEqual([]);
    // Today's failure path: the minted runner goes, the account is not paused.
    expect(deleteRunnerCalls()).toHaveLength(1);
    const row = await rowOf(intent.id);
    expect(row.fleetShardMoveReason).toBeNull();
    expect(row.shardCapacityDeferredAt).toBeNull();
    expect((await shardRow(a.shard.id)).admissionPausedUntil).toBeNull();
    expectMarkerNowhere();
  });
});

describe('the CI fleet switched to Fly', () => {
  it('boots on the Fly orchestrator as before, with active aws accounts untouched', async () => {
    const fx = await seedTenant();
    const a = await awsAccount('A', 50);
    const b = await awsAccount('B', 10);
    const intent = await seedIntent(fx);

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    expect(fly().provisioned).toHaveLength(1);
    expect(fly().specs[0]!.region).toBe('iad');
    expect(booted.session.handle.shardId).toBeUndefined();
    expect(a.ec2.calls).toEqual([]);
    expect(b.ec2.calls).toEqual([]);
    expectOneMintInRepoOrg();
    expect(await rowOf(intent.id)).toMatchObject({ status: 'running', fleetShardId: null });
    expectMarkerNowhere();
  });
});
