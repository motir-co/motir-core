import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ec2Api, Ec2Instance, Ec2Tag } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetAttributionService,
  FLEET_ATTRIBUTION_GRACE_MS,
} from '@/lib/services/fleetAttributionService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { indexSlotRef } from '@/lib/services/codeGraphIndexAdmissionService';
import { AWS_RUNNER_AMI_ENV_VAR } from '@/lib/orchestrator';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { UnattributedMachineDestroyedError } from '@/lib/ciFleet/attributionErrors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// A HOST ORGANISATION'S OWN ACCOUNTS ARE REAPED AND ATTRIBUTED TO THEIR OWNER
// (Story MOTIR-9365 · MOTIR-9584), against real Postgres.
//
// Each own account is an `org_owned` row with its owner, reached through the
// real composition root (`inventoryForShard` → `createEc2Api`, answered by the
// `AwsEc2Fake` its access key id names) and found by the pass itself — no
// `accounts` option, so the role the walk asks `listShards` for is what is
// proved. The merged account is two rows (indexer + hoster) naming ONE AWS
// account and one credential, so one fake. Sentry is observed at its call.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE SOURCE here, so the fake's
// `Ec2ApiError` and the adapter's `instanceof` read one copy of the class.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

interface Ec2Fake extends Ec2Api {
  readonly instances: ReadonlyMap<string, Ec2Instance>;
  plantInstance(instance: Partial<Ec2Instance> & { tags: readonly Ec2Tag[] }): string;
  liveInstanceIds(): string[];
  count(method: string): number;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
}

const fakes = vi.hoisted(() => ({ ec2ByKeyId: new Map<string, unknown>() }));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  return {
    ...source,
    createEc2Api: (config: { accessKeyId: string }) => {
      const ec2 = fakes.ec2ByKeyId.get(config.accessKeyId);
      if (!ec2) throw new Error(`no EC2 fake for ${config.accessKeyId}`);
      return ec2;
    },
  };
});

let AwsEc2Fake: new () => Ec2Fake;
const MINUTE = 60_000;
const REGION = 'us-east-1';
const SECRET = 'SECRET-MARKER-9584';
const OLD = () => new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS);
const pastGrace = () => new Date(Date.now() + MINUTE);

interface Fixture {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `org-owned-${suffix}@example.com`,
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
    identifier: `O${randomInt(100, 1000)}`,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

type Kind = 'ci_runner' | 'hosted_agent' | 'code_graph_index' | 'agent_instance';

interface OwnAccount {
  /** The row's id per fleet kind — two for the merged account. */
  rows: Partial<Record<Kind, string>>;
  names: Partial<Record<Kind, string>>;
  awsAccountId: string;
  ec2: Ec2Fake;
}

/** One own AWS account of `owner`, recorded as one row per kind in `kinds`. */
async function ownAccount(owner: Fixture, kinds: readonly Kind[]): Promise<OwnAccount> {
  const label = randomToken(6).toUpperCase();
  const credentialRef = `HOST_OWN_${label}`;
  const accessKeyId = `AKIA${label}`;
  vi.stubEnv(`${credentialRef}_ACCESS_KEY_ID`, accessKeyId);
  vi.stubEnv(`${credentialRef}_SECRET_ACCESS_KEY`, SECRET);
  const ec2 = new AwsEc2Fake();
  fakes.ec2ByKeyId.set(accessKeyId, ec2);
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const account: OwnAccount = { rows: {}, names: {}, awsAccountId, ec2 };
  for (const fleetKind of kinds) {
    const name = `host-${label.toLowerCase()}-${fleetKind.replace(/_/g, '-')}`;
    const row = await adminDb.fleetShard.create({
      data: {
        name,
        fleetKind,
        provider: 'aws',
        role: 'org_owned',
        ownerOrganizationId: owner.organizationId,
        state: 'active',
        githubOrg: 'motir-projects',
        githubInstallationId: '556677',
        awsAccountId,
        awsRegion: REGION,
        credentialRef,
      },
    });
    account.rows[fleetKind] = row.id;
    account.names[fleetKind] = name;
  }
  return account;
}

/** A VM on an account. Ids are unique across the fakes, as AWS's are. */
function plant(account: OwnAccount, launchedAt = OLD(), tags: Ec2Tag[] = []): string {
  const instanceId = `i-${randomToken(12).toLowerCase()}`;
  return account.ec2.plantInstance({ instanceId, launchTime: launchedAt, tags });
}

async function seedIntent(fx: Fixture, shardId: string, instanceId: string) {
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9584',
      runAttempt: 1,
      jobId: String(95_840 + randomInt(1000)),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: 'running',
      containerProvider: 'aws',
      containerId: instanceId,
      containerRegion: REGION,
      fleetShardId: shardId,
      bootedAt: new Date(),
      startedAt: new Date(),
    },
  });
}

async function seedUsage(
  fx: Fixture,
  instanceId: string,
  workload: 'agent' | 'index',
  repoFullName: string,
  dispatchRunId: string | null,
) {
  const at = new Date(Date.now() - 30 * MINUTE);
  await adminDb.ciContainerUsage.create({
    data: {
      containerProvider: 'aws',
      handleId: instanceId,
      containerRegion: REGION,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      workload,
      repoFullName,
      cpuKind: 'shared',
      cpus: 2,
      memoryMb: 4096,
      containerCreatedAt: at,
      containerStartedAt: at,
      containerStoppedAt: null,
      billableSeconds: 60,
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      usdPerSecond: '0.00003',
      costUsd: '0.0018',
      dispatchRunId,
    },
  });
}

/** A live hosted-agent run: dispatch run, checkpoint, unexpired slot. */
async function seedHostedRun(fx: Fixture, shardId: string, instanceId: string) {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      fleetShardId: shardId,
    },
  });
  await seedUsage(fx, instanceId, 'agent', 'motir-projects/acme-web', run.id);
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref: hostedRunDispatchId(run.id),
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      fleetShardId: shardId,
      expiresAt: new Date(Date.now() + 60 * MINUTE),
    },
  });
}

/** A live index container: checkpoint and unexpired slot. */
async function seedIndex(fx: Fixture, instanceId: string) {
  const repo = `motir-projects/repo-${randomToken(4).toLowerCase()}`;
  await seedUsage(fx, instanceId, 'index', repo, null);
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'code_graph_index',
      ref: indexSlotRef(fx.projectId, repo),
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      expiresAt: new Date(Date.now() + 60 * MINUTE),
    },
  });
}

let instanceSeq = 0;
async function seedInstance(fx: Fixture, shardId: string, name: string, machineId: string) {
  instanceSeq += 1;
  return adminDb.agentInstance.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      ownerId: fx.userId,
      name: `agent-${instanceSeq}`,
      profileId: 'claude-code',
      imageTag: 'latest',
      imageDigest: 'sha256:test',
      flyApp: name,
      machineId,
      volumeId: null,
      region: REGION,
      fleetShardId: shardId,
      availabilityZone: 'us-east-1a',
      state: 'running',
    },
  });
}

const destroyedAlerts = (): UnattributedMachineDestroyedError[] =>
  captureException.mock.calls
    .map(([err]) => err as UnattributedMachineDestroyedError)
    .filter((err) => err.name === 'UnattributedMachineDestroyedError');

/** The pass as the job runs it: no Fly organisation, the accounts read from the rows. */
const reconcile = (now = pastGrace) =>
  fleetAttributionService.reconcile({ now, inventory: null, listingRetryDelayMs: 0 });

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  fakes.ec2ByKeyId.clear();
  fleetShardOrchestratorService.resetCache();
  captureException.mockReset();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', '');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, 'ami-0123456789abcdef0');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.agentInstance.deleteMany({});
  await adminDb.dispatchRun.deleteMany({});
  await adminDb.fleetMachineKill.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a machine nothing names on an own account (MOTIR-9584)', () => {
  it('is destroyed past the grace, the kill row and the alert carrying the owner and the account', async () => {
    const owner = await seedTenant();
    const ci = await ownAccount(owner, ['ci_runner']);
    const stray = plant(ci);

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled', accounts: 1, listed: 1 });
    expect(ci.ec2.liveInstanceIds()).not.toContain(stray);
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills).toHaveLength(1);
    const [kill] = kills as [(typeof kills)[number]];
    expect(kill).toMatchObject({
      machineId: stray,
      reason: 'no_record',
      organizationId: owner.organizationId,
    });
    expect(kill.completedAt).not.toBeNull();
    const [alert] = destroyedAlerts() as [UnattributedMachineDestroyedError];
    expect(alert.ownerOrganizationId).toBe(owner.organizationId);
    expect(alert.message).toContain(stray);
    expect(alert.message).toContain(`organization ${owner.organizationId}'s own account`);
    // The account is named by its row — the listing's app is the account's name.
    expect(alert.message).toContain(ci.names.ci_runner!);
    expect(kill.app).toBe(ci.names.ci_runner);
    expect(captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { fleet_owner_org: owner.organizationId },
    });
  });

  it('is spared inside the grace', async () => {
    const owner = await seedTenant();
    const ci = await ownAccount(owner, ['ci_runner']);
    const young = plant(ci, new Date());

    const result = await reconcile(() => new Date());

    expect(result).toMatchObject({ outcome: 'reconciled', spared: 1, killed: [] });
    expect(ci.ec2.liveInstanceIds()).toContain(young);
    expect(await adminDb.fleetMachineKill.count()).toBe(0);
  });

  it('is still destroyed after the owner leaves Host — the plan is never read', async () => {
    // The tenant has no plan at all here, so it does not read `host`: the account
    // stays open and the pass keeps walking it.
    const owner = await seedTenant();
    const merged = await ownAccount(owner, ['code_graph_index', 'agent_instance']);
    const stray = plant(merged);
    const kept = plant(merged, OLD(), [{ key: 'Name', value: 'agent-instance' }]);
    await seedInstance(owner, merged.rows.agent_instance!, merged.names.agent_instance!, kept);

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled', matched: 1 });
    expect(merged.ec2.liveInstanceIds()).toEqual([kept]);
    expect((await adminDb.fleetMachineKill.findMany()).map((k) => k.machineId)).toEqual([stray]);
  });
});

describe('the owner match (MOTIR-9584)', () => {
  it("leaves the owner's own live record running, for each of the four fleet kinds", async () => {
    const owner = await seedTenant();
    const ci = await ownAccount(owner, ['ci_runner']);
    const runner = await ownAccount(owner, ['hosted_agent']);
    const merged = await ownAccount(owner, ['code_graph_index', 'agent_instance']);
    const job = plant(ci);
    await seedIntent(owner, ci.rows.ci_runner!, job);
    const run = plant(runner);
    await seedHostedRun(owner, runner.rows.hosted_agent!, run);
    const index = plant(merged);
    await seedIndex(owner, index);
    const instance = plant(merged);
    await seedInstance(owner, merged.rows.agent_instance!, merged.names.agent_instance!, instance);

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled', accounts: 3, matched: 4, killed: [] });
    expect(ci.ec2.liveInstanceIds()).toEqual([job]);
    expect(runner.ec2.liveInstanceIds()).toEqual([run]);
    expect(merged.ec2.liveInstanceIds().sort()).toEqual([index, instance].sort());
    expect(destroyedAlerts()).toEqual([]);
  });

  it("kills a machine whose live record is ANOTHER organisation's — the alert names both", async () => {
    const owner = await seedTenant();
    const other = await seedTenant();
    const ci = await ownAccount(owner, ['ci_runner']);
    const merged = await ownAccount(owner, ['code_graph_index', 'agent_instance']);
    const foreignJob = plant(ci);
    await seedIntent(other, ci.rows.ci_runner!, foreignJob);
    const foreignIndex = plant(merged);
    await seedIndex(other, foreignIndex);

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled', matched: 0 });
    expect(result.outcome === 'reconciled' && result.killed.map((k) => k.reason)).toEqual([
      'foreign_org',
      'foreign_org',
    ]);
    expect(ci.ec2.liveInstanceIds()).toEqual([]);
    expect(merged.ec2.liveInstanceIds()).toEqual([]);
    const kills = await adminDb.fleetMachineKill.findMany();
    expect(kills.map((k) => [k.reason, k.organizationId])).toEqual([
      ['foreign_org', owner.organizationId],
      ['foreign_org', owner.organizationId],
    ]);
    for (const alert of destroyedAlerts()) {
      expect(alert.ownerOrganizationId).toBe(owner.organizationId);
      expect(alert.recordOrganizationId).toBe(other.organizationId);
      expect(alert.message).toContain(owner.organizationId);
      expect(alert.message).toContain(`record names organization ${other.organizationId}`);
    }
    expect(destroyedAlerts()).toHaveLength(2);
  });

  it("spares another organisation's machine inside the grace", async () => {
    const owner = await seedTenant();
    const other = await seedTenant();
    const ci = await ownAccount(owner, ['ci_runner']);
    const foreignJob = plant(ci, new Date());
    await seedIntent(other, ci.rows.ci_runner!, foreignJob);

    const result = await reconcile(() => new Date());

    expect(result).toMatchObject({ outcome: 'reconciled', spared: 1, killed: [] });
    expect(ci.ec2.liveInstanceIds()).toEqual([foreignJob]);
  });
});

describe('the merged account and listing failures (MOTIR-9584)', () => {
  it('lists and judges the merged account once: one stray, one kill row, one alert, one listing', async () => {
    const owner = await seedTenant();
    const merged = await ownAccount(owner, ['code_graph_index', 'agent_instance']);
    const stray = plant(merged);

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled', accounts: 1, listed: 1 });
    expect(merged.ec2.count('describeInstances')).toBe(
      result.outcome === 'reconciled' ? result.apps : -1,
    );
    expect(await adminDb.fleetMachineKill.count({ where: { machineId: stray } })).toBe(1);
    expect(destroyedAlerts()).toHaveLength(1);
  });

  it('alerts a failed listing, destroys nothing there, and still walks every other account', async () => {
    const owner = await seedTenant();
    const broken = await ownAccount(owner, ['ci_runner']);
    const other = await ownAccount(owner, ['hosted_agent']);
    const survivor = plant(broken);
    const stray = plant(other);
    broken.ec2.failNext('describeInstances', 'UnauthorizedOperation', 403);

    const result = await reconcile();

    expect(result).toMatchObject({ outcome: 'reconciled' });
    expect(result.outcome === 'reconciled' && result.unavailableApps.length).toBe(1);
    expect(broken.ec2.liveInstanceIds()).toEqual([survivor]);
    expect(other.ec2.liveInstanceIds()).not.toContain(stray);
    expect(
      captureException.mock.calls.some(([err]) =>
        (err as Error).message.includes('Nothing was destroyed there'),
      ),
    ).toBe(true);
  });

  it('puts no credential, environment value or member-account email in an alert or a kill row', async () => {
    const owner = await seedTenant();
    const ci = await ownAccount(owner, ['ci_runner']);
    plant(ci);

    await reconcile();

    const written = JSON.stringify({
      alerts: captureException.mock.calls,
      kills: await adminDb.fleetMachineKill.findMany(),
    });
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain('AKIA');
    expect(written).not.toMatch(/@[a-z0-9-]+\.[a-z]+/i);
  });
});
