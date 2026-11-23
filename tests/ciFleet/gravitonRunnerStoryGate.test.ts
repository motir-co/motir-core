import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorNotConfiguredError,
  type ContainerOrchestrator,
  type ContainerSpec,
  type Ec2Api,
  type Ec2Instance,
  type Ec2RunInstanceInput,
  type FakeOrchestratorControls,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformRole } from '@/generated/prisma/client';
import {
  MOTIR_ARM64_RUNNER_LABEL,
  MOTIR_RUNNER_ARM64_VARIABLE,
  MOTIR_RUNNER_LABEL,
  MOTIR_RUNNER_VARIABLE,
  isMotirFleetJob,
} from '@/lib/ciFleet/config';
import { MOTIR_FLEET_ARM64_RUNNER_LABEL } from '@/lib/ciMetering/runnerRates';
import { CI_SPOT_ALLOWED_INSTANCE_TYPES } from '@/lib/ciFleet/ciSpotInstanceTypes';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { AWS_RUNNER_AMI_ENV_VAR, AWS_RUNNER_ARM64_AMI_ENV_VAR } from '@/lib/orchestrator';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { CI_SPOT_SETTING_SCOPE } from '@/lib/repositories/platformCiSpotSettingRepository';
import { ciRunnerReconcileService } from '@/lib/services/ciRunnerReconcileService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetOrgCiSettingService } from '@/lib/services/fleetOrgCiSettingService';
import { fleetReadinessService, type FleetReadiness } from '@/lib/services/fleetReadinessService';
import { fleetRunnerVariableService } from '@/lib/services/fleetRunnerVariableService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import { randomInt, randomToken } from '../helpers/random';
import { runnerRole, stubAwsManagementCredential } from '../helpers/awsRunnerRoleFake';

// THE GRAVITON RUNNER STORY GATE (Story MOTIR-11779 · MOTIR-11787).
//
// Each child of the story tests its own part and fakes the part next to it, and
// that boundary is exactly where an arm64 job goes wrong silently: the label the
// gate accepts (MOTIR-11781), the AMI and instance type the boot sends
// (MOTIR-11782), the variable the console writes (MOTIR-11786) and the AMI the
// release builds (MOTIR-11783) are decided in four places. This file drives the
// real services across those seams in one process:
//
//   a queued arm64 job → the real reconcile mints an intent → the real boot
//   launches through the real AWS adapter → the JIT runner is registered
//
// plus the org-variable flip and the establish path, which must read the SAME
// arm64 readiness the boot reads.
//
// Real: Postgres, the intent table, `ciRunnerReconcileService`,
// `ciRunnerBootService`, `fleetOrgCiSettingService`, `fleetRunnerVariableService`
// and the AWS orchestrator adapter. Faked: EC2, by the in-memory `AwsEc2Fake`
// handed to the adapter through `createEc2Api` (keyed on the account's runner-role
// session, as `ciRunnerArm64Boot.test.ts` and `awsPoolDeferral.test.ts` wire it),
// so the instance type, image and market are read from what the adapter SENT;
// GitHub, stubbed at `fetch`, with the stateful Actions-variable fake; the boot
// dispatch, captured (the test boots each minted intent itself). The arm64 pin is
// switched per test with `vi.stubEnv`.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE here, so the EC2 fake
// and the adapter share one copy of every error class.
//
// ⚠️ THIS FILE NEVER WRITES THE ARM64 LABEL AS A LITERAL except as the static
// scan's expected value: every other use imports it, so a drift between the
// gate, the boot and the console is a drift this file sees.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  readonly calls: ReadonlyArray<{ method: string; input: unknown }>;
  readonly instances: ReadonlyMap<string, Ec2Instance & { request: Ec2RunInstanceInput }>;
  seedShardNetwork(shardTag: string, zones?: readonly string[]): unknown;
  count(method: string): number;
}

type FakeFleet = ContainerOrchestrator & FakeOrchestratorControls;

const fakes = vi.hoisted(() => ({
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

// The console's superadmin check reads a session; the flip is driven as one.
let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return { ...actual, requirePlatformStaff: async () => currentPrincipal };
});

const MOTIR_ORG = 'motir-projects';
const CONNECTED_ORG = 'acme-connected';
const INSTALLATION = '556677';
const CONNECTED_INSTALLATION = '880011';
const RUNNER_GROUP_ID = 5042;
const REGION = 'us-east-1';
const ZONES = ['us-east-1a', 'us-east-1b'];
const AMI_ID = 'ami-0123456789abcdef0';
const ARM64_AMI_ID = 'ami-0a1b2c3d4e5f6a7b8';
const FAST = { bootDeadlineMs: 40, jobTimeoutMs: 400, pollIntervalMs: 1 } as const;
const ARM64 = [MOTIR_ARM64_RUNNER_LABEL];
const X86 = [MOTIR_RUNNER_LABEL];

let AwsEc2Fake: new () => Ec2Fake;

interface GhJob {
  id: number;
  runId: number;
  labels: string[];
}

interface GhRunner {
  id: number;
  labels: string[];
}

interface GithubCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** What GitHub holds: queued jobs in `motir-projects/acme-web`, the org's runners. */
let queuedJobs: GhJob[];
let orgRunners: GhRunner[];
let githubCalls: GithubCall[];
let variables: Record<string, ActionsVariableFake>;
let captured: { events: CapturedJobEvent[]; restore: () => void };
let now: Date;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGithub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      githubCalls.push({ url, method, body });
      for (const fake of Object.values(variables)) {
        const answered = fake.handle(url, method, body);
        if (answered) return answered;
      }
      const path = new URL(url).pathname;
      if (path === `/orgs/${MOTIR_ORG}/installation`)
        return json(200, { id: Number(INSTALLATION) });
      if (path === `/orgs/${CONNECTED_ORG}/installation`) {
        return json(200, { id: Number(CONNECTED_INSTALLATION) });
      }
      if (path.endsWith('/access_tokens')) {
        return json(200, {
          token: 'ghs_story_gate',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (path === `/repos/${MOTIR_ORG}/acme-web/actions/runs`) {
        const status = new URL(url).searchParams.get('status');
        const ids = [...new Set(queuedJobs.map((j) => j.runId))];
        return json(200, { workflow_runs: status === 'queued' ? ids.map((id) => ({ id })) : [] });
      }
      const runJobs = path.match(/^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/);
      if (runJobs) {
        const jobs = queuedJobs.filter((j) => j.runId === Number(runJobs[1]));
        return json(200, {
          jobs: jobs.map((j) => ({
            id: j.id,
            run_attempt: 1,
            name: 'build',
            workflow_name: 'CI',
            status: 'queued',
            labels: j.labels,
            created_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
          })),
        });
      }
      if (path === `/orgs/${MOTIR_ORG}/actions/runners`) {
        return json(200, {
          runners: orgRunners.map((r) => ({
            id: r.id,
            name: `r${r.id}`,
            status: 'online',
            busy: false,
            labels: r.labels.map((name) => ({ name })),
          })),
        });
      }
      if (path.endsWith('/generate-jitconfig')) {
        return json(201, {
          runner: { id: 9001, name: 'fleet-runner', status: 'offline' },
          encoded_jit_config: Buffer.from('{"jit":"story-gate"}').toString('base64'),
        });
      }
      // The console's repository and CodeQL reads (MOTIR-10289): private, no setup.
      if (/^\/repos\/[^/]+\/[^/]+\/code-scanning\/default-setup$/.test(path)) {
        return json(200, { state: 'not-configured', runner_type: 'standard', runner_label: null });
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return json(200, { private: true });
      return new Response(null, { status: 204 });
    }),
  );
}

const mintCalls = () => githubCalls.filter((c) => c.url.includes('generate-jitconfig'));

/** The CI fleet's AWS pool: one account with its tagged network and its own EC2. */
async function awsPool(): Promise<{ shard: FleetShardDTO; ec2: Ec2Fake }> {
  const accessKeyId = `AKIAGATE${randomToken(8).toUpperCase()}`;
  runnerRole.grant('111111111111', accessKeyId);
  const shard = await fleetShardService.createShard({
    name: `ci-runner-use1-gate-${randomToken(4).toLowerCase()}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    state: 'active',
    githubOrg: MOTIR_ORG,
    githubInstallationId: INSTALLATION,
    awsAccountId: '111111111111',
    awsRegion: REGION,
    credentialRef: `AWS_POOL_GATE_${randomToken(4).toUpperCase()}`,
    limits: { machineLimit: 50 },
  });
  const ec2 = new AwsEc2Fake();
  ec2.seedShardNetwork(shard.name, ZONES);
  fakes.ec2ByKeyId.set(accessKeyId, ec2);
  wireFleetKindSwitch('ci_runner', () => true);
  return { shard, ec2 };
}

interface Tenant {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Tenant> {
  const email = `graviton-gate-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `G${randomInt(100, 1000)}`,
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

/** An intent of `motir-projects/acme-web` — by default the SETTLED one a lost
 *  runner leaves while GitHub still holds the job, which the reconcile serves. */
async function seedIntent(
  tenant: Tenant,
  jobId: number,
  labels: string[],
  status: 'completed' | 'pending' = 'completed',
) {
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      ...tenant,
      installationId: INSTALLATION,
      runId: '700',
      runAttempt: 1,
      jobId: String(jobId),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: labels,
      queuedAt: new Date(now.getTime() - 3_600_000),
      status,
      teardownReason: status === 'completed' ? 'job_completed' : null,
    },
  });
}

/** A job GitHub holds queued, with the settled intent the reconcile reads it from. */
async function queueJob(tenant: Tenant, jobId: number, labels: string[]): Promise<void> {
  await seedIntent(tenant, jobId, labels);
  queuedJobs.push({ id: jobId, runId: 700, labels });
}

async function reconcile() {
  return ciRunnerReconcileService.reconcile({ now: () => now });
}

/** The intents the reconcile minted, oldest job first. */
async function minted() {
  return adminDb.ciRunnerProvisioningIntent.findMany({
    where: { reconcileGeneration: { gt: 0 } },
    orderBy: { jobId: 'asc' },
  });
}

/** Boot one intent; answer the launch the EC2 fake recorded and the labels the
 *  JIT runner was minted with. */
async function bootAndRead(ec2: Ec2Fake, intentId: string) {
  const mintsBefore = mintCalls().length;
  const booted = await ciRunnerBootService.bootIntent(intentId, FAST);
  if (booted.phase !== 'supervising') throw new Error(`unreachable: ${booted.phase}`);
  const instance = ec2.instances.get(booted.session.handle.id);
  if (!instance) throw new Error('the EC2 fake holds no instance for the booted handle');
  const mints = mintCalls().slice(mintsBefore);
  expect(mints).toHaveLength(1);
  return { request: instance.request, labels: mints[0]!.body?.['labels'] };
}

function launches(ec2: Ec2Fake): Ec2RunInstanceInput[] {
  return ec2.calls
    .filter((c) => c.method === 'runInstances')
    .map((c) => c.input as Ec2RunInstanceInput);
}

function expectArm64Launch(request: Ec2RunInstanceInput): void {
  expect(request.instanceType).toBe('m7g.large');
  expect(request.imageId).toBe(ARM64_AMI_ID);
  expect(request).not.toHaveProperty('market');
}

function expectX86Launch(request: Ec2RunInstanceInput): void {
  expect(request.instanceType).toBe('m6i.large');
  expect(request.imageId).toBe(AMI_ID);
}

async function saveSpotSetting(enabled: boolean, instanceTypes: string[]): Promise<void> {
  await adminDb.platformCiSpotSetting.upsert({
    where: { scope: CI_SPOT_SETTING_SCOPE },
    create: { scope: CI_SPOT_SETTING_SCOPE, enabled, instanceTypes, lastReason: 'story gate' },
    update: { enabled, instanceTypes },
  });
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.platformCiSpotSetting.deleteMany();
  (fakes.fly as FakeFleet).reset();
  fakes.ec2ByKeyId.clear();
  runnerRole.reset();
  stubAwsManagementCredential();
  fleetShardOrchestratorService.resetCache();
  now = new Date();
  queuedJobs = [];
  orgRunners = [];
  githubCalls = [];
  variables = {
    [MOTIR_ORG]: createActionsVariableFake(MOTIR_ORG),
    [CONNECTED_ORG]: createActionsVariableFake(CONNECTED_ORG),
  };
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  // The deployment's own selection is Fly, configured; the CI kind is switched to
  // its AWS pool, so every runner resolves through the real `aws` case.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly-token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-ci');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', 'motir/ci-runner@sha256:test');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, AMI_ID);
  vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, ARM64_AMI_ID);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  installGithub();
  captured = captureJobEvents();
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(() => undefined);
  }
});

afterEach(async () => {
  captured.restore();
  wireFleetKindSwitch('ci_runner', null);
  await adminDb.platformCiSpotSetting.deleteMany();
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

describe('seam: a queued job → reconcile → boot through the AWS adapter → JIT runner', () => {
  it('an arm64 job is a fleet job, mints an arm64 intent and boots ONE on-demand m7g.large from the arm64 AMI', async () => {
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    expect(isMotirFleetJob(ARM64)).toBe(true);
    await queueJob(tenant, 9101, ARM64);

    const outcome = await reconcile();

    expect(outcome.added).toBe(1);
    const rows = await minted();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestedLabels).toEqual(ARM64);
    const { request, labels } = await bootAndRead(ec2, rows[0]!.id);
    expect(launches(ec2)).toHaveLength(1);
    expectArm64Launch(request);
    expect(labels).toEqual([MOTIR_ARM64_RUNNER_LABEL]);
    expect(labels).not.toContain(MOTIR_RUNNER_LABEL);
    expect((fakes.fly as FakeFleet).provisioned).toEqual([]);
  });

  it('an x86 job boots m6i.large from the x86 AMI and mints exactly the x86 label', async () => {
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    await queueJob(tenant, 9102, X86);

    await reconcile();

    const rows = await minted();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestedLabels).toEqual(X86);
    const { request, labels } = await bootAndRead(ec2, rows[0]!.id);
    expectX86Launch(request);
    expect(labels).toEqual([MOTIR_RUNNER_LABEL]);
  });
});

describe('partition guard: neither architecture covers the other', () => {
  it('an idle x86 runner and an awaiting x86 intent never cover a queued arm64 job', async () => {
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    orgRunners = [{ id: 1, labels: X86 }];
    await seedIntent(tenant, 9200, X86, 'pending');
    await queueJob(tenant, 9201, ARM64);

    const outcome = await reconcile();

    expect(outcome.orgs[0]).toMatchObject({ idleRunners: 1, awaiting: 1, added: 1 });
    const rows = await minted();
    expect(rows.map((r) => r.jobId)).toEqual(['9201']);
    expect(rows[0]!.requestedLabels).toEqual(ARM64);
    expectArm64Launch((await bootAndRead(ec2, rows[0]!.id)).request);
  });

  it('an idle arm64 runner never covers a queued x86 job', async () => {
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    orgRunners = [{ id: 1, labels: ARM64 }];
    await queueJob(tenant, 9202, X86);

    const outcome = await reconcile();

    expect(outcome.orgs[0]).toMatchObject({ idleRunners: 1, added: 1 });
    const rows = await minted();
    expect(rows.map((r) => r.jobId)).toEqual(['9202']);
    expect(rows[0]!.requestedLabels).toEqual(X86);
    expectX86Launch((await bootAndRead(ec2, rows[0]!.id)).request);
  });

  it('a mixed queue with no capacity yields one intent per job, each booting its own architecture', async () => {
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    await queueJob(tenant, 9301, ARM64);
    await queueJob(tenant, 9302, X86);
    await queueJob(tenant, 9303, ARM64);
    await queueJob(tenant, 9304, X86);

    const outcome = await reconcile();

    expect(outcome.orgs[0]).toMatchObject({
      added: 4,
      arm64: { queued: 2, idleRunners: 0, awaiting: 0, added: 2 },
    });
    const rows = await minted();
    expect(rows.map((r) => [r.jobId, r.requestedLabels])).toEqual([
      ['9301', ARM64],
      ['9302', X86],
      ['9303', ARM64],
      ['9304', X86],
    ]);
    for (const row of rows) {
      const { request, labels } = await bootAndRead(ec2, row.id);
      if (row.requestedLabels.includes(MOTIR_ARM64_RUNNER_LABEL)) {
        expectArm64Launch(request);
        expect(labels).toEqual([MOTIR_ARM64_RUNNER_LABEL]);
      } else {
        expectX86Launch(request);
        expect(labels).toEqual([MOTIR_RUNNER_LABEL]);
      }
    }
    expect(launches(ec2)).toHaveLength(4);
  });

  it('with the CI Spot setting ON, the arm64 launch is on-demand m7g.large; the x86 one walks the Spot list', async () => {
    const spotTypes = ['m6i.large', 'm7i.large'];
    await saveSpotSetting(true, spotTypes);
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    await queueJob(tenant, 9401, ARM64);
    await queueJob(tenant, 9402, X86);

    await reconcile();

    const [arm64Row, x86Row] = await minted();
    const arm64Before = launches(ec2).length;
    const arm64 = await bootAndRead(ec2, arm64Row!.id);
    const arm64Requests = launches(ec2).slice(arm64Before);
    expectArm64Launch(arm64.request);
    for (const request of arm64Requests) {
      expect(request).not.toHaveProperty('market');
      expect(CI_SPOT_ALLOWED_INSTANCE_TYPES as readonly string[]).not.toContain(
        request.instanceType,
      );
    }
    expect(
      await adminDb.ciRunnerProvisioningIntent.findUnique({ where: { id: arm64Row!.id } }),
    ).toMatchObject({ capacity: 'on_demand' });

    const x86 = await bootAndRead(ec2, x86Row!.id);
    expect(x86.request).toMatchObject({ market: 'spot', imageId: AMI_ID });
    expect(spotTypes).toContain(x86.request.instanceType);
  });
});

describe('refusal guard: no arm64 AMI pinned', () => {
  it('the arm64 intent is refused not bootable — no launch, no x86 fallback', async () => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '');
    const tenant = await seedTenant();
    const { ec2 } = await awsPool();
    await queueJob(tenant, 9501, ARM64);

    await reconcile();
    const [row] = await minted();
    expect(row!.requestedLabels).toEqual(ARM64);

    const result = await ciRunnerBootService.bootIntent(row!.id, FAST);

    expect(result).toMatchObject({
      phase: 'terminal',
      outcome: { outcome: 'not_bootable', reason: 'arm64_runner_ami_not_pinned' },
    });
    expect(ec2.count('runInstances')).toBe(0);
    expect(
      launches(ec2).filter((l) => l.imageId === AMI_ID || l.instanceType === 'm6i.large'),
    ).toEqual([]);
    expect(mintCalls()).toEqual([]);
    expect((fakes.fly as FakeFleet).provisioned).toEqual([]);
  });
});

describe('variable seam: the console and the establish path read the boot’s readiness', () => {
  let principal: PlatformPrincipal;
  let projectId: string;
  const pair = () => ({ projectId, org: CONNECTED_ORG });
  const held = () => [...variables[CONNECTED_ORG]!.variables.values()];

  function readiness(): FleetReadiness {
    return {
      ready: true,
      org: CONNECTED_ORG,
      checkedAt: new Date().toISOString(),
      conditions: [
        {
          key: 'kill_switch',
          state: 'met',
          reasonCode: 'kill_switch_off',
          message: 'off',
          params: {},
        },
      ],
    } as FleetReadiness;
  }

  /** A meta-org project with one private repository in the connected org. */
  async function connectedPair(): Promise<void> {
    const fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MOTIR' });
    projectId = fx.projectId;
    await adminDb.organization.update({
      where: { id: fx.workspace.organizationId },
      data: { isMeta: true },
    });
    const installation = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${CONNECTED_ORG}-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: CONNECTED_ORG,
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const mirror = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: String(870_000 + randomInt(1, 9_999)),
        owner: CONNECTED_ORG,
        name: 'api',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'api',
        name: 'api',
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        state: 'connected',
        position: 'a001',
        githubRepoId: mirror.id,
      },
    });
  }

  async function staff(role: PlatformRole): Promise<PlatformPrincipal> {
    const user = await createTestUser();
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
    return { userId: user.id, email: user.email, role };
  }

  beforeEach(async () => {
    await connectedPair();
    principal = await staff('superadmin');
    currentPrincipal = principal;
    vi.spyOn(fleetReadinessService, 'readinessFor').mockResolvedValue(readiness());
  });

  it('ON with the arm64 AMI pinned leaves both variables, each holding its own label', async () => {
    await fleetOrgCiSettingService.setEnabled(principal, pair(), true, 'move CI to the fleet');

    expect(held()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: MOTIR_RUNNER_VARIABLE, value: MOTIR_RUNNER_LABEL }),
        expect.objectContaining({
          name: MOTIR_RUNNER_ARM64_VARIABLE,
          value: MOTIR_ARM64_RUNNER_LABEL,
        }),
      ]),
    );
    expect(held()).toHaveLength(2);
    const state = await fleetOrgCiSettingService.getState(principal, pair());
    expect(state.arm64).toMatchObject({ ready: true, reason: null });
  });

  it('ON unpinned succeeds with only MOTIR_RUNNER, reporting the reason the boot refuses with', async () => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '');

    const flip = await fleetOrgCiSettingService.setEnabled(principal, pair(), true, 'move CI');

    expect(flip.outcome).toBe('changed');
    expect(held().map((v) => v.name)).toEqual([MOTIR_RUNNER_VARIABLE]);
    const state = await fleetOrgCiSettingService.getState(principal, pair());
    expect(state.arm64).toMatchObject({ ready: false, variable: { state: 'absent' } });

    // The boot's own verdict on an arm64 intent, on the same deployment.
    const tenant = await seedTenant();
    await awsPool();
    const intent = await seedIntent(tenant, 9601, ARM64, 'pending');
    const boot = await ciRunnerBootService.bootIntent(intent.id, FAST);
    expect(boot).toMatchObject({ outcome: { outcome: 'not_bootable' } });
    const refused = (boot as { outcome: { reason: string } }).outcome.reason;
    expect(state.arm64.reason).toBe(refused);
    expect(refused).toBe('arm64_runner_ami_not_pinned');
  });

  it.each([
    ['pinned', ARM64_AMI_ID],
    ['unpinned', ''],
  ])('OFF (%s) leaves neither variable', async (_label, pin) => {
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, pin);
    await fleetOrgCiSettingService.setEnabled(principal, pair(), true, 'move CI');

    await fleetOrgCiSettingService.setEnabled(principal, pair(), false, 'back to hosted');

    expect(held()).toEqual([]);
  });

  it('the establish path writes the arm64 variable only when the arm64 AMI is pinned', async () => {
    const pinned = await fleetRunnerVariableService.ensureForFleet();
    expect(pinned).toMatchObject({ outcome: 'ensured', arm64: { outcome: 'ensured' } });
    const provisioning = variables[MOTIR_ORG]!.variables;
    expect(provisioning.get(MOTIR_RUNNER_VARIABLE)?.value).toBe(MOTIR_RUNNER_LABEL);
    expect(provisioning.get(MOTIR_RUNNER_ARM64_VARIABLE)?.value).toBe(MOTIR_ARM64_RUNNER_LABEL);

    provisioning.clear();
    vi.stubEnv(AWS_RUNNER_ARM64_AMI_ENV_VAR, '');
    const unpinned = await fleetRunnerVariableService.ensureForFleet();
    expect(unpinned).toMatchObject({ outcome: 'ensured', arm64: { outcome: 'not_ready' } });
    expect([...provisioning.keys()]).toEqual([MOTIR_RUNNER_VARIABLE]);
  });
});

describe('guard: the other workloads launch as they did before the story', () => {
  const base: ContainerSpec = {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: `${MOTIR_ORG}/acme-web`,
    workload: 'hosted_agent',
    workflowJobId: null,
    image: `ghcr.io/motir-co/motir-hosted-agent@sha256:${'a'.repeat(64)}`,
    size: FLEET_CONTAINER_SIZE,
    env: {
      MOTIR_DISPATCH_RUN_ID: 'run-77',
      MOTIR_WORK_ITEM_KEY: 'ACME-12',
      MOTIR_API_URL: 'https://app.motir.test',
    },
    timeoutSeconds: 3600,
    region: REGION,
  };

  it('with the arm64 AMI pinned, a hosted agent is m6i.large on the x86 AMI', async () => {
    // (The index VM this case also booted, on its own AMI, was retired with the
    // index fleet in MOTIR-12037.)
    const { shard, ec2 } = await awsPool();
    const orchestrator = fleetShardOrchestratorService.forShardRow(shard);

    const hosted = await orchestrator.provision(base);

    const hostedRequest = ec2.instances.get(hosted.id)!.request;
    expect(hostedRequest).toMatchObject({ instanceType: 'm6i.large', imageId: AMI_ID });
    expect(hostedRequest.instanceType).not.toBe('m7g.large');
    expect(hostedRequest.imageId).not.toBe(ARM64_AMI_ID);
  });

  it('an agent instance is still refused by the per-run AWS adapter, before any EC2 call', async () => {
    const { shard, ec2 } = await awsPool();
    const orchestrator = fleetShardOrchestratorService.forShardRow(shard);

    await expect(
      orchestrator.provision({ ...base, workload: 'agent_instance' }),
    ).rejects.toBeInstanceOf(OrchestratorNotConfiguredError);
    expect(ec2.count('runInstances')).toBe(0);
  });
});

describe('static guards', () => {
  const root = join(__dirname, '..', '..');

  function walk(dir: string, out: string[]): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else out.push(path);
    }
  }

  it('the arm64 label is written as a literal in product code only in the metering rates', () => {
    const packages = readdirSync(join(root, 'packages')).map((p) => join('packages', p, 'src'));
    const files: string[] = [];
    for (const dir of ['lib', 'app', 'scripts', ...packages]) walk(join(root, dir), files);
    expect(files.length).toBeGreaterThan(100);

    const holding = files
      .filter((file) => readFileSync(file, 'utf8').includes('motir-graviton'))
      .map((file) => relative(root, file));

    expect(holding).toEqual(['lib/ciMetering/runnerRates.ts']);
    expect(MOTIR_FLEET_ARM64_RUNNER_LABEL).toBe('motir-graviton');
    expect(MOTIR_ARM64_RUNNER_LABEL).toBe(MOTIR_FLEET_ARM64_RUNNER_LABEL);
  });

  it('the AMI template builds x86 on the amd64 base and m6i.large beside arm64 on the arm64 base and a Graviton type, one provision.sh', () => {
    const hcl = readFileSync(join(root, 'infra/ci-runner-aws/packer/runner.pkr.hcl'), 'utf8');
    const parameter = (name: string) =>
      new RegExp(`data "amazon-parameterstore" "${name}" \\{[^}]*name\\s*=\\s*"([^"]+)"`).exec(
        hcl,
      )?.[1];
    expect(parameter('ubuntu_noble')).toMatch(/^\/aws\/service\/canonical\/.*\/amd64\//);
    expect(parameter('ubuntu_noble_arm64')).toMatch(/^\/aws\/service\/canonical\/.*\/arm64\//);

    const nested = [...hcl.matchAll(/source "amazon-ebs\.runner" \{([^}]*)\}/g)].map((m) => m[1]!);
    expect(nested).toHaveLength(2);
    const field = (block: string, name: string) =>
      new RegExp(`${name}\\s*=\\s*(\\S+)`).exec(block)?.[1];
    const x86 = nested.find((b) => field(b, 'name') === '"runner"')!;
    const arm64 = nested.find((b) => field(b, 'name') === '"runner-arm64"')!;
    expect(field(x86, 'source_ami')).toBe('data.amazon-parameterstore.ubuntu_noble.value');
    expect(field(x86, 'instance_type')).toBe('"m6i.large"');
    expect(field(arm64, 'source_ami')).toBe('data.amazon-parameterstore.ubuntu_noble_arm64.value');
    expect(field(arm64, 'instance_type')).toMatch(/^"[a-z]+\d+g[a-z]*\.[a-z0-9]+"$/);

    // One build block whose provisioners carry no `only`/`except`, so both
    // sources run the same provision.sh.
    expect(hcl.match(/^build \{/gm)).toHaveLength(1);
    expect(hcl.match(/script\s*=\s*"\$\{path\.root\}\/\.\.\/provision\.sh"/g)).toHaveLength(1);
    expect(hcl).not.toMatch(/^\s*(only|except)\s*=/m);
  });
});
