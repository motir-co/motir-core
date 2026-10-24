import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContainerOrchestrator,
  Ec2Api,
  Ec2Instance,
  Ec2RunInstanceInput,
  FakeOrchestratorControls,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SHARD_VCPU_QUOTA_TARGET, wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { createAwsShardProvisioningProvider } from '@/lib/fleetShards/awsProvisioningProvider';
import { registerShardProvisioningProvider } from '@/lib/fleetShards/provisioningProviders';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { AWS_RUNNER_AMI_ENV_VAR } from '@/lib/orchestrator';
import {
  ciRunnerBootService,
  INITIAL_POLL_STATE,
  type PollResult,
  type SupervisionSession,
} from '@/lib/services/ciRunnerBootService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runFleetAdmin, EXIT_ERROR, EXIT_OK, EXIT_PENDING } from '@/scripts/fleet/fleetAdmin';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import {
  ADD_SHARD_ENTERPRISE_SLUG,
  FakeOrganization,
  installAddShardGithub,
  newGithubWorld,
} from '../helpers/addShardFakes';
import { truncateAuthTables } from '../helpers/db';
import { stubPaidAiPlan } from '../helpers/paidAiPlan';
import { randomInt, randomToken } from '../helpers/random';

// THE STORY'S E2E (Story MOTIR-9270 · MOTIR-9281): one AWS account's whole
// journey, in order, on one database — `fleet-admin add-shard --provider aws`
// creates it (and resumes after an interruption), the CI kind is switched to its
// AWS pool, a job's runner boots as one EC2 VM from the configured AMI in the
// network add-shard built, and the VM is terminated at settle with a priced
// usage row.
//
// The seams are proven elsewhere and not repeated: row → adapter → network tag
// agreement and the SDK boundary in `awsShardSeam.test.ts` / `awsSdkBoundary.test.ts`
// (MOTIR-9280), capacity moves and deferral in `awsPoolDeferral.test.ts`
// (MOTIR-9279). This file adds the ORDER of events and the interrupted resume.
//
// What is faked: AWS — the management API is `FakeOrganization`, and one
// `AwsEc2Fake` is the member account, answered by `createEc2Api` to add-shard's
// network step (the assumed-role session) and to the adapter (the runtime key)
// alike; GitHub, stubbed at `fetch`; Fly, a fake present only so the test can say
// it was never used. Our own services are real.
//
// The command is called through its exported `runFleetAdmin`, not spawned: the
// esbuild bundle itself is covered by the add-shard card's tests.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE here, as in the seam
// test: the EC2 fake throws the source's `Ec2ApiError`, and the adapter types
// refusals by `instanceof`.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly zones: ReadonlyArray<{ zoneName: string }>;
  readonly vpcs: ReadonlyMap<string, unknown>;
  readonly internetGateways: ReadonlyMap<string, unknown>;
  readonly routeTables: ReadonlyMap<string, unknown>;
  readonly subnets: ReadonlyMap<string, unknown>;
  readonly securityGroups: ReadonlyMap<string, unknown>;
  readonly instances: ReadonlyMap<string, Ec2Instance & { request: Ec2RunInstanceInput }>;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
  endJob(instanceId: string, at?: Date): void;
  liveInstanceIds(): string[];
  mutations(): Array<{ method: string; input: unknown }>;
  count(method: string): number;
}

type FakeFleet = ContainerOrchestrator & FakeOrchestratorControls;

const world = vi.hoisted(() => ({ ec2: null as unknown, fly: null as unknown }));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  world.fly = source.createFakeOrchestrator({ idPrefix: 'fly-machine' });
  return {
    ...source,
    createEc2Api: () => world.ec2,
    flyOrchestrator: world.fly,
  };
});

let AwsEc2Fake: new () => Ec2Fake;
const ec2 = () => world.ec2 as Ec2Fake;
const fly = () => world.fly as FakeFleet;

const NAME = 'ci-runner-use1-e2e';
const ORG = 'motir-fleet-use1-e2e';
const PREFIX = 'FLEET_SHARD_CI_RUNNER_USE1_E2E';
const REGION = 'us-east-1';
const AMI = 'ami-0e2e0e2e0e2e0e2e0';
const REPO_ORG = 'motir-projects';
const RUNNER_GROUP_ID = 5042;
const FAST = { bootDeadlineMs: 5_000, jobTimeoutMs: 60_000, pollIntervalMs: 1 } as const;

/** Every secret the journey handles, as a marker that must surface nowhere. */
const MARKERS = {
  managementKey: 'MOTIR9281MGMTKEYSECRET',
  sessionToken: 'MOTIR9281SESSIONTOKEN',
  sessionSecret: 'MOTIR9281SESSIONSECRET',
  runtimeKey: 'MOTIR9281RUNTIMEKEYSECRET',
  jit: 'MOTIR9281JITMARKER',
} as const;
const ENCODED_JIT = Buffer.from(`{"marker":"${MARKERS.jit}"}`).toString('base64');
const SESSION = {
  accessKeyId: 'ASIA_E2E_SESSION',
  secretAccessKey: MARKERS.sessionSecret,
  sessionToken: MARKERS.sessionToken,
  expiration: null,
};

let organization: FakeOrganization;
let unregister: () => void;
let operatorEmail: string;
/** Everything the command printed and the process logged, across the case. */
let printed: string[];
let logged: unknown[][];
let mintCalls: string[];

async function addShard(): Promise<number> {
  return runFleetAdmin(
    [
      'add-shard',
      '--create-org',
      '--provider',
      'aws',
      '--fleet-kind',
      'ci_runner',
      '--name',
      NAME,
      '--region',
      REGION,
      '--github-org',
      ORG,
      '--admin-login',
      'zhuyue11',
      '--account-email',
      `aws+${NAME}@motir.co`,
      '--operator',
      operatorEmail,
    ],
    { out: (line) => printed.push(line), err: (line) => printed.push(line) },
  );
}

function setRuntimeKey(): void {
  vi.stubEnv(`${PREFIX}_ACCESS_KEY_ID`, 'AKIA_E2E_RUNTIME');
  vi.stubEnv(`${PREFIX}_SECRET_ACCESS_KEY`, MARKERS.runtimeKey);
}

/** The `<step> <outcome>` line add-shard printed for `step` on its last run. */
function stepLine(output: string[], step: string): string {
  return [...output].reverse().find((line) => line.startsWith(`${step} `)) ?? '';
}

async function shardRows() {
  return adminDb.fleetShard.findMany({ where: { name: NAME } });
}

/** Add-shard through to an active row: a first run, then the person's two steps. */
async function activeShard() {
  expect(await addShard()).toBe(EXIT_PENDING);
  organization.quota = SHARD_VCPU_QUOTA_TARGET;
  setRuntimeKey();
  expect(await addShard()).toBe(EXIT_OK);
  const [row] = await shardRows();
  return row!;
}

async function seedIntent() {
  const email = `aws-e2e-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `E${randomInt(100, 1000)}`,
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: {
      runnerGroupId: RUNNER_GROUP_ID,
      runnerGroupName: `motir-project-${project.id}`,
      runnerGroupSyncedAt: new Date(),
    },
  });
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      projectId: project.id,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: '92810',
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: REPO_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(Date.now() - 5_000),
      status: 'pending',
    },
  });
}

/** Poll the boot service until it reads the job as finished, as the job's loop does. */
async function pollUntilDone(
  session: SupervisionSession,
  onRunning: () => void,
): Promise<Extract<PollResult, { done: true }>> {
  let state: PollResult = INITIAL_POLL_STATE;
  let ended = false;
  for (let i = 0; i < 20; i += 1) {
    state = await ciRunnerBootService.pollOnce(session, state, FAST);
    if (state.done) return state;
    if (state.startedAt && !ended) {
      onRunning();
      ended = true;
    }
  }
  throw new Error('the boot service never read the job as finished');
}

/** Wrap add-shard's GitHub stub with the calls a boot makes. */
function installBootGithub(): void {
  const addShardFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      // The cloud admission's credit-balance read (motir-ai).
      if (url.includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance: 1_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('generate-jitconfig')) {
        mintCalls.push(url);
        return new Response(
          JSON.stringify({
            runner: { id: 9001, name: 'motir-runner', status: 'offline' },
            encoded_jit_config: ENCODED_JIT,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'DELETE' && /\/actions\/runners\/\d+$/.test(url)) {
        return new Response(null, { status: 204 });
      }
      return addShardFetch(input, init);
    }),
  );
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  fly().reset();
  fleetShardOrchestratorService.resetCache();
  printed = [];
  logged = [];
  mintCalls = [];
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', REPO_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4445390');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_ENTERPRISE_SLUG', ADD_SHARD_ENTERPRISE_SLUG);
  vi.stubEnv('GITHUB_ENTERPRISE_ADMIN_TOKEN', 'ghp_admin');
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', 'AKIA_E2E_MANAGEMENT');
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', MARKERS.managementKey);
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::576360162297:role/motir-add-shard');
  // The deployment's own selection — Fly, configured — so the process-wide fleet
  // is the Fly fake and the account resolves through its real `aws` case.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-ci');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'motir/ci-runner@sha256:test');
  vi.stubEnv(`${PREFIX}_ACCESS_KEY_ID`, '');
  vi.stubEnv(`${PREFIX}_SECRET_ACCESS_KEY`, '');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, '');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  installAddShardGithub(newGithubWorld(), 'ghs_installation');
  world.ec2 = new AwsEc2Fake();
  organization = new FakeOrganization(SESSION);
  // The real provider; only its management API is the in-memory organization.
  unregister = registerShardProvisioningProvider(
    createAwsShardProvisioningProvider({
      management: () => organization,
      ec2: () => ec2(),
      env: () => process.env,
    }),
  );
  const user = await createTestUser();
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
  operatorEmail = user.email;
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
});

afterEach(async () => {
  // Every case's output, audit rows and logs carry no marker.
  const audited = JSON.stringify(
    await adminDb.platformAuditLog.findMany({ where: { action: { startsWith: 'fleet.' } } }),
  );
  const logs = logged
    .map((args) =>
      args
        .map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : JSON.stringify(a)))
        .join(' '),
    )
    .join('\n');
  for (const marker of [...Object.values(MARKERS), ENCODED_JIT]) {
    expect(printed.join('\n')).not.toContain(marker);
    expect(audited).not.toContain(marker);
    expect(logs).not.toContain(marker);
  }
  unregister();
  wireFleetKindSwitch('ci_runner', null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('add-shard for aws, from nothing', () => {
  it('a first run exits 2 with a provisioning row, the tagged network, no NAT and the manual steps', async () => {
    expect(await addShard()).toBe(EXIT_PENDING);

    const rows = await shardRows();
    expect(rows).toHaveLength(1);
    const account = organization.accounts.get(NAME)!;
    expect(rows[0]).toMatchObject({
      provider: 'aws',
      fleetKind: 'ci_runner',
      role: 'primary',
      state: 'provisioning',
      awsAccountId: account.accountId,
      awsRegion: REGION,
      credentialRef: PREFIX,
    });
    expect((await fleetShardService.findShardByName(NAME))!.limits.vcpuQuota).toBe(
      organization.quota,
    );

    expect(ec2().vpcs.size).toBe(1);
    expect(ec2().internetGateways.size).toBe(1);
    expect(ec2().routeTables.size).toBe(1);
    expect(ec2().subnets.size).toBe(ec2().zones.length);
    expect(ec2().securityGroups.size).toBe(1);
    const group = (
      await ec2().describeSecurityGroups([{ name: 'tag:motir-shard', values: [NAME] }])
    )[0]!;
    expect(group.ingressRuleCount).toBe(0);
    // No NAT gateway and no elastic IP: nothing the adapter calls can make one.
    expect(ec2().calls.filter((c) => /nat|address/i.test(c.method))).toEqual([]);

    const output = printed.join('\n');
    expect(output).toContain('Pending manual steps:');
    expect(output).toContain(
      `then run: flyctl secrets set -a motir-core ${PREFIX}_ACCESS_KEY_ID=… ${PREFIX}_SECRET_ACCESS_KEY=…`,
    );
  });

  it('interrupted at the network, a re-run completes with one account, one of each resource and one row', async () => {
    ec2().failNext('createSubnet');
    expect(await addShard()).toBe(EXIT_ERROR);
    expect(await shardRows()).toEqual([]);
    expect(organization.accounts.size).toBe(1);

    const rerun = printed.length;
    expect(await addShard()).toBe(EXIT_PENDING);
    const second = printed.slice(rerun);

    expect(organization.calls.filter((c) => c === 'createOrganizationAccount')).toHaveLength(1);
    expect(organization.accounts.size).toBe(1);
    expect(ec2().vpcs.size).toBe(1);
    expect(ec2().internetGateways.size).toBe(1);
    expect(ec2().routeTables.size).toBe(1);
    expect(ec2().subnets.size).toBe(ec2().zones.length);
    expect(ec2().securityGroups.size).toBe(1);
    expect(await shardRows()).toHaveLength(1);
    for (const step of ['github_org', 'app_installation', 'provider_account']) {
      expect(stepLine(second, step)).toMatch(/ already — /);
    }
  });

  it('with the runtime key set and the quota at target, a re-run exits 0, activates the row and creates nothing', async () => {
    expect(await addShard()).toBe(EXIT_PENDING);
    const mutations = ec2().mutations().length;
    const created = organization.calls.filter((c) => c.startsWith('create')).length;

    organization.quota = SHARD_VCPU_QUOTA_TARGET;
    setRuntimeKey();
    expect(await addShard()).toBe(EXIT_OK);

    const rows = await shardRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('active');
    expect(ec2().mutations()).toHaveLength(mutations);
    expect(organization.calls.filter((c) => c.startsWith('create'))).toHaveLength(created);
  });
});

describe('the account as the CI pool', () => {
  it('a job boots one VM from the AMI in the add-shard network, and settle terminates it with a priced row', async () => {
    const shard = await activeShard();
    const subnetIds = new Set(ec2().subnets.keys());
    const groupIds = [...ec2().securityGroups.keys()];
    wireFleetKindSwitch('ci_runner', () => true);
    vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI);
    // A cloud build, so the settle writes the cost row; the org holds a paid plan.
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
    stubPaidAiPlan();
    installBootGithub();
    const intent = await seedIntent();

    const booted = await ciRunnerBootService.bootIntent(intent.id, FAST);
    if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);

    expect(booted.session.handle).toMatchObject({ provider: 'aws', shardId: shard.id });
    expect(
      await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intent.id } }),
    ).toMatchObject({ status: 'running', fleetShardId: shard.id, fleetShardMoveReason: null });
    expect(ec2().count('runInstances')).toBe(1);
    const request = ec2().instances.get(booted.session.handle.id)!.request;
    expect(request.imageId).toBe(AMI);
    expect(subnetIds.has(request.subnetId)).toBe(true);
    expect(request.securityGroupIds).toEqual(groupIds);
    expect(request.tags).toContainEqual({ key: 'motir-shard', value: NAME });
    const userData = Buffer.from(request.userData, 'base64').toString('utf8');
    expect(userData.trimEnd().split('\n')).toHaveLength(4);
    for (const line of userData.trimEnd().split('\n')) expect(line).toMatch(/^[A-Z_]+=\S+$/);
    expect(mintCalls).toHaveLength(1);
    expect(fly().provisioned).toEqual([]);

    // The job ends as the AMI ends it: the VM powers itself off.
    const verdict = await pollUntilDone(booted.session, () =>
      ec2().endJob(booted.session.handle.id),
    );
    expect(verdict.reason).toBe('job_completed');
    expect(
      await ciRunnerBootService.settleSupervision(booted.session, verdict, FAST),
    ).toMatchObject({ outcome: 'settled', reason: 'job_completed' });

    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled.status).toBe('completed');
    expect(settled.settledAt).not.toBeNull();
    expect(ec2().instances.get(booted.session.handle.id)!.state).toBe('terminated');
    const usage = await adminDb.ciContainerUsage.findFirstOrThrow({
      where: { handleId: booted.session.handle.id },
    });
    expect(usage).toMatchObject({ containerProvider: 'aws', containerRegion: REGION });
    // Priced: a rate row covered it (an unpriced container records a null rate date).
    expect(usage.rateEffectiveFrom).not.toBeNull();
    expect(Number(usage.usdPerSecond)).toBeGreaterThan(0);
    const live = await ec2().describeInstances({
      filters: [
        { name: 'tag:motir-shard', values: [NAME] },
        { name: 'instance-state-name', values: ['pending', 'running', 'stopping', 'stopped'] },
      ],
    });
    expect(live.instances).toEqual([]);
    expect(ec2().liveInstanceIds()).toEqual([]);
  });
});
