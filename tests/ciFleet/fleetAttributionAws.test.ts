import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ec2ApiError, type Ec2Api, type Ec2Instance, type Ec2Tag } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetAttributionService,
  FLEET_ATTRIBUTION_GRACE_MS,
} from '@/lib/services/fleetAttributionService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { hostedRunChargeService } from '@/lib/services/hostedRunChargeService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { AWS_RUNNER_AMI_ENV_VAR } from '@/lib/orchestrator';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { runnerRole, stubRunnerRoleManagementEnv } from '../helpers/awsRunnerRoleFake';

// EVERY VM ON EVERY AGENT-RUNNER ACCOUNT BELONGS TO A RECORD, OR IT DIES (Story
// MOTIR-9359 · MOTIR-9426, `docs/decisions/fleet-per-org-pool.md` §5), against
// real Postgres.
//
// `fleetAttribution.test.ts` proves the matcher over the generic fake inventory.
// What it cannot show is the AWS half end to end: the reconciler walking each
// `aws` account through the REAL `createAwsFleetInventory`, reached through
// `inventoryForShard`, over that account's own EC2 — the whole region, untagged
// VMs included — and a hosted VM it kills settled through the account it was
// LISTED in.
//
// Faked: EC2 (each account's `createEc2Api` answers the `AwsEc2Fake` keyed on the
// access key id of its runner-role session, `awsRunnerRoleFake`), the
// motir-ai charge and the run's end (spied — their own suites prove them), and
// Sentry, observed at its call.
//
// ⚠️ `@motir/orchestrator` RESOLVES TO THE PACKAGE'S SOURCE, so the fake's
// `Ec2ApiError` and the adapter's `instanceof` read one copy of the class.

const paths = vi.hoisted(() => ({
  orchestratorSource: '../../packages/orchestrator/src/index',
  ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake',
}));

/** The surface of `AwsEc2Fake` this file drives. */
interface Ec2Fake extends Ec2Api {
  readonly instances: ReadonlyMap<string, Ec2Instance>;
  plantInstance(instance: Partial<Ec2Instance> & { tags: readonly Ec2Tag[] }): string;
  count(method: string): number;
}

const fakes = vi.hoisted(() => ({ ec2ByKeyId: new Map<string, unknown>() }));

vi.mock('@motir/orchestrator', async () => {
  const source = (await import(
    /* @vite-ignore */ paths.orchestratorSource
  )) as typeof import('@motir/orchestrator');
  return {
    ...source,
    createAwsManagementApi: () => runnerRole.management(),
    createEc2Api: (config: Parameters<typeof runnerRole.ec2For>[0]) =>
      runnerRole.ec2For(config, (keyId) => fakes.ec2ByKeyId.get(keyId) as object | undefined),
  };
});

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const MINUTE = 60_000;
const REGION = 'us-east-1';
const pastGrace = () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);

let AwsEc2Fake: new () => Ec2Fake;

interface Fixture {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `attribution-aws-${suffix}@example.com`,
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
    identifier: `W${randomInt(100, 1000)}`,
  });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

interface AwsAccount {
  shard: FleetShardDTO;
  ec2: Ec2Fake;
}

/** One `aws` fleet account: its row, its credential (unless `withoutCredential`)
 *  and its own EC2. */
async function awsAccount(
  fleetKind: 'hosted_agent' | 'ci_runner',
  label: string,
  options: { withoutCredential?: boolean } = {},
): Promise<AwsAccount> {
  const credentialRef = `AWS_RECON_${label}_${randomToken(4).toUpperCase()}`;
  const accessKeyId = `AKIA${label}${randomToken(8).toUpperCase()}`;
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  if (!options.withoutCredential) runnerRole.grant(awsAccountId, accessKeyId);
  const prefix = fleetKind === 'hosted_agent' ? 'hosted-agent' : 'ci-runner';
  const shard = await fleetShardService.createShard({
    name: `${prefix}-use1-${label.toLowerCase()}-${randomToken(4).toLowerCase()}`,
    fleetKind,
    provider: 'aws',
    state: 'active',
    githubOrg: 'motir-projects',
    githubInstallationId: '556677',
    awsAccountId,
    awsRegion: REGION,
    credentialRef,
    limits: { machineLimit: 10 },
  });
  const ec2 = new AwsEc2Fake();
  fakes.ec2ByKeyId.set(accessKeyId, ec2);
  return { shard, ec2 };
}

/** A VM in an account, as EC2 lists it. */
function plant(
  account: AwsAccount,
  name: string | null,
  tags: Ec2Tag[] = [],
  launchedAt = new Date(),
) {
  return account.ec2.plantInstance({
    launchTime: launchedAt,
    tags: [...(name ? [{ key: 'Name', value: name }] : []), ...tags],
  });
}

const hostedTags = (account: AwsAccount): Ec2Tag[] => [
  { key: 'motir-fleet', value: 'hosted_agent' },
  { key: 'motir-shard', value: account.shard.name },
];

async function seedDispatchRun(fx: Fixture, shardId: string) {
  return adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run',
      fleetShardId: shardId,
    },
  });
}

async function seedAgentCheckpoint(fx: Fixture, instanceId: string, dispatchRunId: string) {
  const at = new Date(Date.now() - 30 * MINUTE);
  await adminDb.ciContainerUsage.create({
    data: {
      containerProvider: 'aws',
      handleId: instanceId,
      containerRegion: REGION,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      workload: 'agent',
      repoFullName: 'motir-projects/acme-web',
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

async function seedSlot(fx: Fixture, dispatchRunId: string, shardId: string, expiresAt: Date) {
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref: hostedRunDispatchId(dispatchRunId),
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      fleetShardId: shardId,
      expiresAt,
    },
  });
}

async function seedInFlightIntent(fx: Fixture, account: AwsAccount, instanceId: string) {
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9426',
      runAttempt: 1,
      jobId: String(94_260 + randomInt(1000)),
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
      fleetShardId: account.shard.id,
      bootedAt: new Date(),
      startedAt: new Date(),
    },
  });
}

/** Every alert's message, in order. */
const alerts = () => captureException.mock.calls.map(([err]) => (err as Error).message);

/** The pass over just these accounts (never the Fly organisation). */
function reconcile(accounts: readonly AwsAccount[], now = () => new Date()) {
  return fleetAttributionService.reconcile({
    now,
    inventory: null,
    accounts: accounts.map((a) => a.shard),
    listingRetryDelayMs: 0,
  });
}

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  await truncateAuthTables();
  fakes.ec2ByKeyId.clear();
  runnerRole.reset();
  stubRunnerRoleManagementEnv();
  fleetShardOrchestratorService.resetCache();
  captureException.mockReset();
  // The deployment's own selection — each account resolves through its real
  // `aws` case, not the fake orchestrator.
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
  vi.stubEnv('FLY_FLEET_API_TOKEN', '');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv(AWS_RUNNER_AMI_ENV_VAR, 'ami-0123456789abcdef0');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.dispatchRun.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the reconciler walks every AWS agent-runner account (MOTIR-9426)', () => {
  it('alerts an account it cannot reach and still walks the others', async () => {
    const broken = await awsAccount('hosted_agent', 'X', { withoutCredential: true });
    const b = await awsAccount('hosted_agent', 'B');
    plant(b, 'stray-b', [], new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS));

    const result = await reconcile([broken, b]);

    expect(result).toMatchObject({ outcome: 'reconciled', listed: 1 });
    expect(alerts()[0]).toContain(`Could not list machines in ${broken.shard.name}`);
    expect(alerts()[0]).toContain('Nothing was destroyed there');
    expect(broken.ec2.count('describeInstances')).toBe(0);
  });

  it('matches a live hosted VM by its checkpoint and unexpired slot', async () => {
    const fx = await seedTenant();
    const a = await awsAccount('hosted_agent', 'A');
    const run = await seedDispatchRun(fx, a.shard.id);
    const id = plant(a, `hosted-agent-${run.id}`, hostedTags(a));
    await seedAgentCheckpoint(fx, id, run.id);
    await seedSlot(fx, run.id, a.shard.id, new Date(Date.now() + 60 * MINUTE));

    const result = await reconcile([a]);

    expect(result).toMatchObject({ outcome: 'reconciled', listed: 1, matched: 1, killed: [] });
    expect(a.ec2.count('terminateInstances')).toBe(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('kills a hosted VM whose slot expired through the account it was listed in, settled once', async () => {
    const fx = await seedTenant();
    const a = await awsAccount('hosted_agent', 'A');
    const b = await awsAccount('hosted_agent', 'B');
    const run = await seedDispatchRun(fx, b.shard.id);
    const name = `hosted-agent-${run.id}`;
    const launchedAt = new Date(Date.now() - 90 * MINUTE);
    const id = plant(b, name, hostedTags(b), launchedAt);
    await seedAgentCheckpoint(fx, id, run.id);
    await seedSlot(fx, run.id, b.shard.id, new Date(Date.now() - 60 * MINUTE));
    const charge = vi
      .spyOn(hostedRunChargeService, 'chargeMachineTime')
      .mockResolvedValue({ outcome: 'skipped' } as never);
    const end = vi.spyOn(hostedRunService, 'endHostedRun').mockResolvedValue({} as never);

    const result = await reconcile([a, b]);

    expect(result).toMatchObject({ outcome: 'reconciled', listed: 1 });
    if (result.outcome !== 'reconciled') throw new Error('unreachable');
    expect(result.killed).toEqual([
      expect.objectContaining({
        app: b.shard.name,
        machineId: id,
        reason: 'record_ended',
        workload: 'hosted_agent',
      }),
    ]);
    // Torn down on B only — A's EC2 was listed and never asked to terminate.
    expect(a.ec2.count('terminateInstances')).toBe(0);
    expect(b.ec2.count('terminateInstances')).toBeGreaterThan(0);
    expect(b.ec2.instances.get(id)!.state).toBe('terminated');
    // Settled: the usage row is final, the slot released, charged once, ended.
    const usage = await adminDb.ciContainerUsage.findFirstOrThrow({
      where: { containerProvider: 'aws', handleId: id },
    });
    expect(usage.containerStoppedAt).not.toBeNull();
    expect(
      await adminDb.fleetInFlightSlot.count({ where: { ref: hostedRunDispatchId(run.id) } }),
    ).toBe(0);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge.mock.calls[0]![0]).toBe(run.id);
    expect(end).toHaveBeenCalledWith(run.id, 'lost_supervision', expect.anything());
    // The kill is recorded against the run and its paying organisation.
    expect(
      await adminDb.fleetMachineKill.findFirstOrThrow({ where: { machineId: id } }),
    ).toMatchObject({
      app: b.shard.name,
      machineName: name,
      reason: 'record_ended',
      workload: 'hosted_agent',
      recordRef: run.id,
      organizationId: fx.organizationId,
    });
    // The alert names the account and the VM.
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain(`AWS instance ${id} (${name}) in ${b.shard.name}`);
    expect(alerts()[0]).toContain('record_ended');
  });

  it('spares an untagged VM inside the grace and kills it no_record after it', async () => {
    const a = await awsAccount('hosted_agent', 'A');
    const id = plant(a, null);

    const first = await reconcile([a]);
    expect(first).toMatchObject({ outcome: 'reconciled', listed: 1, spared: 1, killed: [] });
    expect(a.ec2.instances.get(id)!.state).toBe('running');

    const second = await reconcile([a], pastGrace);
    if (second.outcome !== 'reconciled') throw new Error('unreachable');
    expect(second.killed).toEqual([
      expect.objectContaining({ app: a.shard.name, machineId: id, reason: 'no_record' }),
    ]);
    expect(a.ec2.instances.get(id)!.state).toBe('terminated');
    expect(alerts()[0]).toContain(`AWS instance ${id} (unnamed) in ${a.shard.name}`);
  });

  it('kills a VM carrying hosted tags but no checkpoint and no slot as no_record', async () => {
    const a = await awsAccount('hosted_agent', 'A');
    const id = plant(a, 'hosted-agent-ghost', hostedTags(a), new Date(Date.now() - 90 * MINUTE));

    const result = await reconcile([a]);

    if (result.outcome !== 'reconciled') throw new Error('unreachable');
    expect(result.killed).toEqual([
      expect.objectContaining({ machineId: id, reason: 'no_record', workload: null }),
    ]);
    expect(a.ec2.instances.get(id)!.state).toBe('terminated');
  });

  it('matches a CI VM whose intent is in flight on a ci_runner account', async () => {
    const fx = await seedTenant();
    const ci = await awsAccount('ci_runner', 'C');
    const id = plant(ci, 'ci-runner-job', [{ key: 'motir-fleet', value: 'ci_runner' }]);
    await seedInFlightIntent(fx, ci, id);

    const result = await reconcile([ci]);

    expect(result).toMatchObject({ outcome: 'reconciled', listed: 1, matched: 1, killed: [] });
    expect(ci.ec2.count('terminateInstances')).toBe(0);
  });

  it('asks a transient listing failure once more and raises nothing', async () => {
    const a = await awsAccount('hosted_agent', 'A');
    plant(a, null);
    vi.spyOn(a.ec2, 'describeInstances').mockRejectedValueOnce(
      new Ec2ApiError('RequestLimitExceeded', 429, true),
    );

    const result = await reconcile([a]);

    expect(result).toMatchObject({ outcome: 'reconciled', listed: 1, unavailableApps: [] });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('alerts once and destroys nothing when the listing fails twice in a row', async () => {
    const a = await awsAccount('hosted_agent', 'A');
    const id = plant(a, null, [], new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS));
    vi.spyOn(a.ec2, 'describeInstances')
      .mockRejectedValueOnce(new Ec2ApiError('ServiceUnavailable', 503, true))
      .mockRejectedValueOnce(new Ec2ApiError('ServiceUnavailable', 503, true));

    const result = await reconcile([a]);

    expect(result).toMatchObject({
      outcome: 'reconciled',
      killed: [],
      unavailableApps: [a.shard.name],
    });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain(`Could not list machines in ${a.shard.name}`);
    expect(a.ec2.count('terminateInstances')).toBe(0);
    expect(a.ec2.instances.get(id)!.state).toBe('running');
  });
});
