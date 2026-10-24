import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorNotConfiguredError,
  fakeOrchestrator,
  type ContainerOrchestrator,
  type FleetInventory,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  fakeOrchestratorForShard,
  getOrchestrator,
  inventoryForShard,
  legacyFleetLocationKey,
  orchestratorForShard,
  registerShardAdapter,
  resetShardFakes,
  shardLocationKey,
  unregisterShardAdapter,
} from '@/lib/orchestrator';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { fleetShardService, type CreateFleetShardInput } from '@/lib/services/fleetShardService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// ONE ORCHESTRATOR PER FLEET ACCOUNT (Story MOTIR-8953 · MOTIR-8964), against real
// Postgres: an account row becomes its own adapter in the composition root, every
// container path reaches the account the container was booted in, and a `null`
// account is the process-wide fleet every pre-account container lives on.
//
// The Fly cases select the real Fly adapter and stub `fetch`, so the assertion is
// on WHICH app a call reaches — the one thing that distinguishes two accounts.

const ACCOUNT: CreateFleetShardInput = {
  name: 'ci-runner-a',
  fleetKind: 'ci_runner',
  provider: 'fly',
  githubOrg: 'motir-projects',
  githubInstallationId: '4242',
  flyOrg: 'motir',
  flyApp: 'motir-ci-a',
  flyRegion: 'ams',
  credentialRef: 'FLEET_SHARD_A_TOKEN',
  limits: { machineLimit: 50 },
};

async function createAccount(overrides: Partial<CreateFleetShardInput> = {}) {
  return fleetShardService.createShard({ ...ACCOUNT, ...overrides });
}

/** Every Fly URL the adapter reached, answered with a 404 so a call ends there. */
function captureFlyCalls(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }),
  );
  return urls;
}

const HANDLE_TIME = new Date('2026-10-23T12:00:00.000Z');

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetShard.deleteMany({});
  fakeOrchestrator.reset();
  resetShardFakes();
  fleetShardOrchestratorService.resetCache();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await adminDb.fleetShard.deleteMany({});
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('orchestratorForShard — the account row becomes its own adapter', () => {
  it('builds a Fly orchestrator per account, each reaching its OWN app, whatever the env names', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-process');
    vi.stubEnv('FLEET_SHARD_A_TOKEN', 'token-a');
    vi.stubEnv('FLEET_SHARD_B_TOKEN', 'token-b');
    const a = await createAccount();
    const b = await createAccount({
      name: 'ci-runner-b',
      flyApp: 'motir-ci-b',
      credentialRef: 'FLEET_SHARD_B_TOKEN',
    });
    const urls = captureFlyCalls();

    for (const account of [a, b]) {
      const orchestrator = orchestratorForShard(account);
      expect(orchestrator.provider).toBe('fly');
      await orchestrator
        .describe({ provider: 'fly', id: 'm-1', region: 'iad', createdAt: HANDLE_TIME })
        .catch(() => undefined);
    }

    expect(urls.some((u) => u.includes('/apps/motir-ci-a/'))).toBe(true);
    expect(urls.some((u) => u.includes('/apps/motir-ci-b/'))).toBe(true);
    expect(urls.some((u) => u.includes('motir-ci-process'))).toBe(false);
  });

  it('throws the typed not-configured error NAMING the credentialRef when it is unset', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    const account = await createAccount();
    expect(() => orchestratorForShard(account)).toThrow(OrchestratorNotConfiguredError);
    expect(() => orchestratorForShard(account)).toThrow(/FLEET_SHARD_A_TOKEN/);
  });

  it('routes any other provider through the registry, handing it the WHOLE account', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    const row = await createAccount();
    // A provider the enum does not hold.
    const account = { ...row, provider: 'stub' } as unknown as FleetShardDTO;
    expect(() => orchestratorForShard(account)).toThrow(/no stub adapter is registered/);

    const seen: FleetShardDTO[] = [];
    const stubOrchestrator = { provider: 'fake' } as unknown as ContainerOrchestrator;
    const stubInventory = { provider: 'fake' } as unknown as FleetInventory;
    registerShardAdapter('stub', {
      orchestrator: (shard) => {
        seen.push(shard);
        return stubOrchestrator;
      },
      inventory: () => stubInventory,
    });
    try {
      expect(orchestratorForShard(account)).toBe(stubOrchestrator);
      expect(inventoryForShard(account)).toBe(stubInventory);
      expect(seen[0]).toMatchObject({
        fleetKind: 'ci_runner',
        credentialRef: 'FLEET_SHARD_A_TOKEN',
        fly: { app: 'motir-ci-a' },
      });
    } finally {
      unregisterShardAdapter('stub');
    }
  });

  describe('an aws account (MOTIR-9276)', () => {
    const AWS_ACCOUNT: Partial<CreateFleetShardInput> = {
      name: 'ci-runner-use1-1',
      provider: 'aws',
      flyOrg: null,
      flyApp: null,
      flyRegion: null,
      awsAccountId: '123456789012',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_CI_RUNNER_USE1_1',
      limits: { vcpuQuota: 640 },
    };

    it('builds an AWS orchestrator from the row when its key and the AMI are set', async () => {
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
      vi.stubEnv('FLEET_SHARD_CI_RUNNER_USE1_1_ACCESS_KEY_ID', 'AKIAEXAMPLE');
      vi.stubEnv('FLEET_SHARD_CI_RUNNER_USE1_1_SECRET_ACCESS_KEY', 'secret-example');
      vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
      const account = await createAccount(AWS_ACCOUNT);

      expect(account.aws).toEqual({ accountId: '123456789012', region: 'us-east-1' });
      expect(orchestratorForShard(account).provider).toBe('aws');
      expect(inventoryForShard(account)).toBeNull();
    });

    it('names EVERY missing variable at once', async () => {
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
      vi.stubEnv('FLEET_SHARD_CI_RUNNER_USE1_1_ACCESS_KEY_ID', '');
      vi.stubEnv('FLEET_SHARD_CI_RUNNER_USE1_1_SECRET_ACCESS_KEY', '');
      vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', '');
      const account = await createAccount(AWS_ACCOUNT);

      const thrown = (() => {
        try {
          orchestratorForShard(account);
        } catch (err) {
          return err as Error;
        }
      })();
      expect(thrown).toBeInstanceOf(OrchestratorNotConfiguredError);
      for (const name of [
        'FLEET_SHARD_CI_RUNNER_USE1_1_ACCESS_KEY_ID',
        'FLEET_SHARD_CI_RUNNER_USE1_1_SECRET_ACCESS_KEY',
        'MOTIR_AWS_RUNNER_AMI_ID',
      ]) {
        expect(thrown!.message).toContain(name);
      }
    });

    it('refuses an aws row with no account id or region', async () => {
      await expect(createAccount({ ...AWS_ACCOUNT, awsRegion: null })).rejects.toMatchObject({
        code: 'FLEET_SHARD_INVALID',
        field: 'awsLocation',
      });
    });
  });

  it('lists no Fly account separately — the organisation walk already covers it', async () => {
    expect(inventoryForShard(await createAccount())).toBeNull();
  });

  it('keys an account by WHERE it lives, so two routes to one app are one place', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-a');
    const a = await createAccount();
    const b = await createAccount({ name: 'ci-runner-a-again', flyOrg: 'motir-2' });
    expect(shardLocationKey(a)).toBe('fly:motir-ci-a');
    expect(shardLocationKey(b)).toBe(shardLocationKey(a));
    expect(legacyFleetLocationKey()).toBe(shardLocationKey(a));
  });

  it('gives each account its own fake while the fake is selected', async () => {
    const a = await createAccount();
    const b = await createAccount({ name: 'ci-runner-b', flyApp: 'motir-ci-b' });
    expect(orchestratorForShard(a)).toBe(fakeOrchestratorForShard(a.id));
    expect(orchestratorForShard(a)).not.toBe(orchestratorForShard(b));
    expect(orchestratorForShard(a)).not.toBe(fakeOrchestrator);
  });
});

describe('fleetShardOrchestratorService', () => {
  it('a null account is the process-wide fleet', async () => {
    expect(await fleetShardOrchestratorService.forShard(null)).toBe(getOrchestrator());
  });

  it('reaches a DISABLED account — its containers still need polling, settling and reaping', async () => {
    const account = await createAccount({ state: 'active' });
    await fleetShardService.setState(account.id, 'disabled');
    expect(await fleetShardOrchestratorService.forShard(account.id)).toBe(
      fakeOrchestratorForShard(account.id),
    );
  });

  it('caches per account and rebuilds when the row changes', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLEET_SHARD_A_TOKEN', 'token-a');
    const account = await createAccount();
    const first = await fleetShardOrchestratorService.forShard(account.id);
    expect(await fleetShardOrchestratorService.forShard(account.id)).toBe(first);

    await fleetShardService.setLimits(
      account.id,
      { machineLimit: 60 },
      {
        machineLimit: 'provider_read',
      },
    );
    expect(await fleetShardOrchestratorService.forShard(account.id)).not.toBe(first);
  });
});

// ── against an intent ───────────────────────────────────────────────────────

interface Tenant {
  organizationId: string;
  workspaceId: string;
  projectId: string;
}

async function seedTenant(): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `fleet-shard-orch-${randomToken(6)}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${randomToken(4)}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `K${randomInt(100, 1000)}`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

let jobSeq = 0;

/** A running intent whose container was booted on `orchestrator`, recorded in
 *  `fleetShardId`'s account. */
async function seedBootedIntent(
  tenant: Tenant,
  orchestrator: ContainerOrchestrator,
  fleetShardId: string | null,
) {
  jobSeq += 1;
  const jobId = 61_000 + jobSeq;
  const handle = await orchestrator.provision({
    orgId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
    repoFullName: 'motir-projects/acme-web',
    workload: 'ci_runner',
    workflowJobId: jobId,
    image: 'motir/ci-runner@sha256:test',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    timeoutSeconds: 3600,
    region: 'ams',
  });
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      installationId: '556677',
      runId: String(9000 + jobSeq),
      runAttempt: 1,
      jobId: String(jobId),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: 'running',
      containerProvider: handle.provider,
      containerId: handle.id,
      containerRegion: handle.region,
      bootedAt: handle.createdAt,
      startedAt: handle.createdAt,
      fleetShardId,
    },
  });
  return { handle, intent };
}

describe('a container is reached through the account its intent recorded', () => {
  it('forIntent resolves the recorded account; a legacy intent the process-wide fleet', async () => {
    const tenant = await seedTenant();
    const account = await createAccount();
    const onAccount = await seedBootedIntent(
      tenant,
      fakeOrchestratorForShard(account.id),
      account.id,
    );
    const legacy = await seedBootedIntent(tenant, fakeOrchestrator, null);

    expect(await fleetShardOrchestratorService.forIntent(onAccount.intent)).toBe(
      fakeOrchestratorForShard(account.id),
    );
    expect(await fleetShardOrchestratorService.forIntent(legacy.intent)).toBe(fakeOrchestrator);
  });

  it("the reaper tears a container down in ITS account, not the process-wide fleet's", async () => {
    const tenant = await seedTenant();
    const accountB = await createAccount({ name: 'ci-runner-b', flyApp: 'motir-ci-b' });
    const fakeB = fakeOrchestratorForShard(accountB.id);
    const { handle, intent } = await seedBootedIntent(tenant, fakeB, accountB.id);

    expect(await ciRunnerBootService.reapContainer(handle)).toBe(true);

    expect(fakeB.teardowns).toEqual([{ handleId: handle.id, reason: 'reaped' }]);
    expect(fakeOrchestrator.teardowns).toEqual([]);
    const settled = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(settled).toMatchObject({ status: 'failed', teardownReason: 'reaped' });
  });

  it('the account the container was LISTED in wins over the recorded one', async () => {
    const tenant = await seedTenant();
    const accountB = await createAccount({ name: 'ci-runner-b', flyApp: 'motir-ci-b' });
    const fakeB = fakeOrchestratorForShard(accountB.id);
    // Recorded as the process-wide fleet, found in account B's listing.
    const { handle } = await seedBootedIntent(tenant, fakeB, null);

    expect(await ciRunnerBootService.reapContainer(handle, { shardId: accountB.id })).toBe(true);
    expect(fakeB.teardowns.map((t) => t.handleId)).toEqual([handle.id]);
  });

  it('an account cannot be deleted while an intent still records it', async () => {
    const tenant = await seedTenant();
    const account = await createAccount();
    await seedBootedIntent(tenant, fakeOrchestratorForShard(account.id), account.id);
    await expect(adminDb.fleetShard.delete({ where: { id: account.id } })).rejects.toThrow();
    expect(await adminDb.fleetShard.count()).toBe(1);
  });
});
