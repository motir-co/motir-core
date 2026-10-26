import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  buildContainerAccrual,
  createAwsFleetInventory,
  createAwsOrchestrator,
  type ContainerHandle,
  type ContainerOrchestrator,
  type ContainerSpec,
  type Ec2Api,
  type FleetInventory,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  OrchestratorNotConfiguredError,
  inventoryForShard,
  recordContainerAccrual,
  recordContainerUsage,
} from '@/lib/orchestrator';
import { indexSlotRef } from '@/lib/services/codeGraphIndexAdmissionService';
import {
  FLEET_ATTRIBUTION_GRACE_MS,
  fleetAttributionService,
  type AccountInventory,
} from '@/lib/services/fleetAttributionService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// MOTIR-9450 — an index VM on AWS is attributable and reapable on EVERY account
// of the indexer pool, by the existing attribution pass. Real Postgres for every
// record the pass reads and the kill record; one in-memory EC2 per account, read
// through the real AWS adapter and the real per-account inventory.

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const paths = { ec2Fake: '../../packages/orchestrator/test/contract/awsEc2Fake' };

interface Ec2Fake extends Ec2Api {
  seedShardNetwork(shardTag: string): void;
  plantInstance(instance: {
    tags: ReadonlyArray<{ key: string; value: string }>;
    launchTime?: Date;
  }): string;
  exitIndexContainer(instanceId: string, code: number): void;
  failNext(method: keyof Ec2Api, code?: string, httpStatus?: number): void;
  idsFrom(start: number): void;
  readonly instances: Map<string, { state: string }>;
}

const MINUTE = 60_000;
const pastGrace = () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + MINUTE);
const REPO_A = 'acme/alpha';
const REPO_B = 'acme/beta';

let AwsEc2Fake: new () => Ec2Fake;
/** Each account's fake mints from its own range: EC2 ids are unique across accounts. */
let idRange = 0;

interface Account {
  name: string;
  ec2: Ec2Fake;
  orchestrator: ContainerOrchestrator;
  inventory: FleetInventory;
}

function account(name: string): Account {
  const ec2 = new AwsEc2Fake();
  idRange += 0x10000;
  ec2.idsFrom(idRange);
  ec2.seedShardNetwork(name);
  return {
    name,
    ec2,
    orchestrator: createAwsOrchestrator({
      ec2,
      region: 'us-east-1',
      shardTag: name,
      amiId: 'ami-0runner000000000',
      indexerAmiId: 'ami-0dockerhost00000',
    }),
    inventory: createAwsFleetInventory({ ec2, region: 'us-east-1', accountName: name }),
  };
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `aws-index-${suffix}@example.com`,
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
    identifier: `X${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

function indexSpec(fx: Fixture, repoFullName: string): ContainerSpec {
  return {
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName,
    workload: 'code_graph_index',
    workflowJobId: null,
    image: `ghcr.io/motir-co/motir-indexer@sha256:${'d'.repeat(64)}`,
    size: FLEET_CONTAINER_SIZE,
    env: { MOTIR_INDEX_PROJECT_ID: fx.projectId },
    timeoutSeconds: 1800,
    region: 'us-east-1',
  };
}

function attribution(fx: Fixture, repoFullName: string) {
  return {
    orgId: fx.organizationId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    repoFullName,
    workload: 'code_graph_index' as const,
    workflowJobId: null,
    size: FLEET_CONTAINER_SIZE,
    observedStartedAt: null,
  };
}

/** The checkpoint the index poll writes for a running container. */
async function checkpoint(fx: Fixture, handle: ContainerHandle, repoFullName: string) {
  await recordContainerAccrual(
    buildContainerAccrual({
      handle,
      attribution: attribution(fx, repoFullName),
      createdAt: handle.createdAt,
      startedAt: handle.createdAt,
      observedAt: new Date(),
    }),
  );
}

async function seedSlot(fx: Fixture, repoFullName: string, expiresAt: Date) {
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'code_graph_index',
      ref: indexSlotRef(fx.projectId, repoFullName),
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      expiresAt,
    },
  });
}

/** An index VM booted on `acct`, with its checkpoint and an unexpired slot. */
async function liveIndex(acct: Account, fx: Fixture, repo: string): Promise<ContainerHandle> {
  const handle = await acct.orchestrator.provision(indexSpec(fx, repo));
  await checkpoint(fx, handle, repo);
  await seedSlot(fx, repo, new Date(Date.now() + 3 * 60 * MINUTE));
  return handle;
}

function pools(...accounts: Account[]): AccountInventory[] {
  return accounts.map((a) => ({
    shardId: `shard-${a.name}`,
    name: a.name,
    inventory: a.inventory,
  }));
}

function reconcile(accounts: Account[], now: () => Date, inventory: FleetInventory | null = null) {
  return fleetAttributionService.reconcile({
    inventory,
    accounts: [],
    accountInventories: pools(...accounts),
    now,
    listingRetryDelayMs: 0,
  });
}

const stateOf = (acct: Account, id: string) => acct.ec2.instances.get(id)!.state;

beforeAll(async () => {
  ({ AwsEc2Fake } = (await import(/* @vite-ignore */ paths.ec2Fake)) as {
    AwsEc2Fake: new () => Ec2Fake;
  });
});

beforeEach(async () => {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  // The cost meter writes only on a cloud build.
  vi.stubEnv('MOTIR_CLOUD', 'true');
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

describe('an index run on AWS bills the right org (MOTIR-9450)', () => {
  it('its usage row carries aws, the instance id, the index workload, org, project, repo and both instants', async () => {
    const fx = await seedTenant();
    const a = account('indexer-use1-1');
    const handle = await a.orchestrator.provision(indexSpec(fx, REPO_A));
    await checkpoint(fx, handle, REPO_A);
    a.ec2.exitIndexContainer(handle.id, 0);
    await recordContainerUsage(
      await a.orchestrator.teardown(handle, 'job_completed', attribution(fx, REPO_A)),
    );

    const rows = await adminDb.ciContainerUsage.findMany({ where: { handleId: handle.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      containerProvider: 'aws',
      handleId: handle.id,
      workload: 'index',
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      repoFullName: REPO_A,
    });
    expect(rows[0]!.containerCreatedAt).not.toBeNull();
    expect(rows[0]!.containerStoppedAt).not.toBeNull();
  });
});

describe('the attribution pass on every indexer-pool account (MOTIR-9450)', () => {
  it('lists both accounts and attributes both live index VMs, killing neither', async () => {
    const fx = await seedTenant();
    const [a, b] = [account('indexer-use1-1'), account('indexer-use1-2')];
    const onA = await liveIndex(a, fx, REPO_A);
    const onB = await liveIndex(b, fx, REPO_B);

    const result = await reconcile([a, b], pastGrace);
    expect(result).toMatchObject({ outcome: 'reconciled', apps: 2, listed: 2, matched: 2 });
    expect(stateOf(a, onA.id)).toBe('running');
    expect(stateOf(b, onB.id)).toBe('running');
    expect(await adminDb.fleetMachineKill.count()).toBe(0);
  });

  it.each([
    ['no checkpoint', 'none', 'no_record'],
    ['a stopped checkpoint', 'stopped', 'record_ended'],
    ['an expired slot', 'expired', 'record_ended'],
  ] as const)(
    'an index VM with %s is spared in the grace, then terminated in its own account',
    async (_label, record, reason) => {
      const fx = await seedTenant();
      const [a, b] = [account('indexer-use1-1'), account('indexer-use1-2')];
      const live = await liveIndex(a, fx, REPO_A);
      const orphan = await b.orchestrator.provision(indexSpec(fx, REPO_B));
      if (record !== 'none') await checkpoint(fx, orphan, REPO_B);
      if (record === 'stopped') {
        await adminDb.ciContainerUsage.updateMany({
          where: { handleId: orphan.id },
          data: { containerStoppedAt: new Date() },
        });
      }
      if (record === 'expired') await seedSlot(fx, REPO_B, new Date(Date.now() - MINUTE));

      const inGrace = await reconcile([a, b], () => new Date());
      expect(inGrace).toMatchObject({ spared: 1, killed: [] });
      expect(stateOf(b, orphan.id)).toBe('running');

      const after = await reconcile([a, b], pastGrace);
      expect(after.outcome === 'reconciled' && after.killed).toEqual([
        expect.objectContaining({ app: b.name, machineId: orphan.id, reason }),
      ]);
      expect(stateOf(b, orphan.id)).toBe('terminated');
      expect(stateOf(a, live.id)).toBe('running');
      const [row] = await adminDb.fleetMachineKill.findMany();
      expect(row).toMatchObject({ app: b.name, machineId: orphan.id, action: 'destroyed' });
      expect(captureException).toHaveBeenCalledTimes(1);
    },
  );

  it('reaps an untagged VM, and one carrying all four index tags but no record', async () => {
    const fx = await seedTenant();
    const [a, b] = [account('indexer-use1-1'), account('indexer-use1-2')];
    const live = await liveIndex(a, fx, REPO_A);
    const longAgo = new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS);
    const untagged = b.ec2.plantInstance({ tags: [], launchTime: longAgo });
    const lookalike = b.ec2.plantInstance({
      launchTime: longAgo,
      tags: [
        { key: 'motir:workload', value: 'code_graph_index' },
        { key: 'motir:org', value: fx.organizationId },
        { key: 'motir:project', value: fx.projectId },
        { key: 'motir:repo', value: REPO_B },
      ],
    });

    const result = await reconcile([a, b], () => new Date());
    expect(result.outcome === 'reconciled' && result.killed.map((k) => k.machineId).sort()).toEqual(
      [untagged, lookalike].sort(),
    );
    expect(stateOf(b, untagged)).toBe('terminated');
    expect(stateOf(b, lookalike)).toBe('terminated');
    expect(stateOf(a, live.id)).toBe('running');
  });

  it('a listing failure on one account skips and alerts it, destroying nothing there, and still reconciles the other', async () => {
    const [a, b] = [account('indexer-use1-1'), account('indexer-use1-2')];
    const longAgo = new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS);
    const strayA = a.ec2.plantInstance({ tags: [], launchTime: longAgo });
    const strayB = b.ec2.plantInstance({ tags: [], launchTime: longAgo });
    // The first call and its one retry both fail.
    vi.spyOn(a.ec2, 'describeInstances').mockRejectedValue(new Error('RequestLimitExceeded'));

    const result = await reconcile([a, b], () => new Date());
    expect(result).toMatchObject({ unavailableApps: [a.name] });
    expect(stateOf(a, strayA)).toBe('running');
    expect(stateOf(b, strayB)).toBe('terminated');
    expect(captureException.mock.calls.map(([e]) => (e as Error).message).join('\n')).toContain(
      a.name,
    );
  });

  it('when the organisation listing fails, nothing is destroyed on any account', async () => {
    const [a, b] = [account('indexer-use1-1'), account('indexer-use1-2')];
    const longAgo = new Date(Date.now() - 2 * FLEET_ATTRIBUTION_GRACE_MS);
    const strayA = a.ec2.plantInstance({ tags: [], launchTime: longAgo });
    const strayB = b.ec2.plantInstance({ tags: [], launchTime: longAgo });
    const failing: FleetInventory = {
      provider: 'fly',
      listApps: () => Promise.reject(new Error('fly is down')),
      listMachines: () => Promise.resolve([]),
      destroyMachine: () => Promise.resolve(),
      stopMachine: () => Promise.resolve(),
    };

    const result = await reconcile([a, b], () => new Date(), failing);
    expect(result.outcome).toBe('inventory_unavailable');
    expect(stateOf(a, strayA)).toBe('running');
    expect(stateOf(b, strayB)).toBe('running');
  });
});

describe('inventoryForShard routes an indexer AWS account to its own listing (MOTIR-9450)', () => {
  function shard(fleetKind: FleetShardDTO['fleetKind']): FleetShardDTO {
    return {
      id: 'shard-x',
      name: 'indexer-use1-1',
      fleetKind,
      provider: 'aws',
      role: 'primary',
      state: 'active',
      github: { org: 'motir-co', installationId: '1', appRole: 'primary' as never },
      fly: null,
      aws: { accountId: '111122223333', region: 'us-east-1' },
      credentialRef: 'FLEET_SHARD_INDEXER_USE1_1',
      ownerOrganizationId: null,
      quotaRequestedAt: null,
      grantedAt: null,
      liveAt: null,
      accountState: null,
      limits: {
        vcpuQuota: null,
        machineLimit: null,
        githubRegistrationsPer5Min: null,
        githubApiPerHour: null,
      },
      limitsSource: {},
      limitsVerifiedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  it('an indexer account with its key set lists through aws, as every AWS account does', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLEET_SHARD_INDEXER_USE1_1_ACCESS_KEY_ID', 'AKIATEST');
    vi.stubEnv('FLEET_SHARD_INDEXER_USE1_1_SECRET_ACCESS_KEY', 'secret');
    expect(inventoryForShard(shard('code_graph_index'))?.provider).toBe('aws');
    expect(inventoryForShard(shard('ci_runner'))?.provider).toBe('aws');
  });

  it('an indexer account with no key throws naming the variables, so the pass alerts and skips it', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLEET_SHARD_INDEXER_USE1_1_ACCESS_KEY_ID', '');
    vi.stubEnv('FLEET_SHARD_INDEXER_USE1_1_SECRET_ACCESS_KEY', '');
    expect(() => inventoryForShard(shard('code_graph_index'))).toThrow(
      OrchestratorNotConfiguredError,
    );
    expect(() => inventoryForShard(shard('code_graph_index'))).toThrow(
      /FLEET_SHARD_INDEXER_USE1_1_ACCESS_KEY_ID/,
    );
  });

  it('with the fake orchestrator selected nothing reads EC2', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    expect(inventoryForShard(shard('code_graph_index'))).toBeNull();
  });
});
