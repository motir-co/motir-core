import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_CONTAINER_SIZE,
  OrchestratorNotConfiguredError,
  fakeOrchestrator,
  fakePersistentOrchestrator,
  type ContainerOrchestrator,
  type FleetInventory,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { FleetShardDTO } from '@/lib/dto/fleetShard';
import {
  fakeOrchestratorForShard,
  fakePersistentOrchestratorForShard,
  getOrchestrator,
  getPersistentOrchestrator,
  hosterTerminalEndpointFor,
  inventoryForShard,
  legacyFleetLocationKey,
  orchestratorForShard,
  persistentOrchestratorForShard,
  persistentTerminalEndpoint,
  registerShardAdapter,
  resetShardFakes,
  runnerRoleCredentialProvider,
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
import { TEST_MANAGEMENT_ROLE_ARN } from '../helpers/awsRunnerRoleFake';

// ONE ORCHESTRATOR PER FLEET ACCOUNT (Story MOTIR-8953 · MOTIR-8964), against real
// Postgres: an account row becomes its own adapter in the composition root, every
// container path reaches the account the container was booted in, and a `null`
// account is the process-wide fleet every pre-account container lives on.
//
// The Fly cases select the real Fly adapter and stub `fetch`, so the assertion is
// on WHICH app a call reaches — the one thing that distinguishes two accounts.

/** No management credential at all: the runner role cannot be assumed. */
function stubNoManagementCredential(): void {
  vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', '');
  vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', '');
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', '');
}

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

    it('builds an AWS orchestrator from the row when the management role and the AMI are set', async () => {
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
      vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', TEST_MANAGEMENT_ROLE_ARN);
      vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
      const account = await createAccount(AWS_ACCOUNT);

      expect(account.aws).toEqual({ accountId: '123456789012', region: 'us-east-1' });
      expect(orchestratorForShard(account).provider).toBe('aws');
      expect(inventoryForShard(account)?.provider).toBe('aws');
      expect(await inventoryForShard(account)!.listApps()).toEqual(['ci-runner-use1-1']);
    });

    it('names EVERY missing variable at once', async () => {
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
      stubNoManagementCredential();
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
      for (const name of ['AWS_ORG_ADMIN_ROLE_ARN', 'MOTIR_AWS_RUNNER_AMI_ID']) {
        expect(thrown!.message).toContain(name);
      }
      // No per-account runner key exists to name (MOTIR-9847).
      expect(thrown!.message).not.toContain('FLEET_SHARD_CI_RUNNER_USE1_1_ACCESS_KEY_ID');
    });

    it('assumes the runner role from the management credential (MOTIR-9460)', async () => {
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
      vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
      vi.stubEnv('AWS_ORG_ADMIN_ACCESS_KEY_ID', 'AKIAMANAGEMENT');
      vi.stubEnv('AWS_ORG_ADMIN_SECRET_ACCESS_KEY', 'management-secret');
      vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', TEST_MANAGEMENT_ROLE_ARN);
      const account = await createAccount(AWS_ACCOUNT);

      // Built without a call: the session is assumed when the SDK first signs.
      expect(orchestratorForShard(account).provider).toBe('aws');
    });

    it('signs with a fresh runner-role session, its expiry only when AWS gave one', async () => {
      const expiration = new Date('2026-10-25T00:00:00Z');
      const sessions = [
        { accessKeyId: 'ASIA1', secretAccessKey: 's1', sessionToken: 't1', expiration },
        { accessKeyId: 'ASIA2', secretAccessKey: 's2', sessionToken: 't2', expiration: null },
      ];
      const assumeRunnerRole = vi.fn(async () => sessions.shift()!);
      const provide = runnerRoleCredentialProvider({ assumeRunnerRole }, '123456789012');

      await expect(provide()).resolves.toEqual({
        accessKeyId: 'ASIA1',
        secretAccessKey: 's1',
        sessionToken: 't1',
        expiration,
      });
      await expect(provide()).resolves.toEqual({
        accessKeyId: 'ASIA2',
        secretAccessKey: 's2',
        sessionToken: 't2',
      });
      expect(assumeRunnerRole).toHaveBeenCalledWith('123456789012');
      expect(assumeRunnerRole).toHaveBeenCalledTimes(2);
    });

    it('with no management credential, names it and the role it assumes', async () => {
      vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
      stubNoManagementCredential();
      vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
      const account = await createAccount(AWS_ACCOUNT);

      expect(() => orchestratorForShard(account)).toThrow(
        /set AWS_ORG_ADMIN_ROLE_ARN \(the management credential, .*, assumes motir-fleet-runner\)\.$/,
      );
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

describe('persistentOrchestratorForShard — where an account’s agent instances live (MOTIR-9469)', () => {
  const HOSTER: Partial<CreateFleetShardInput> = {
    name: 'agent-hoster-use1-1',
    fleetKind: 'agent_instance',
    provider: 'aws',
    flyOrg: null,
    flyApp: null,
    flyRegion: null,
    awsAccountId: '210987654321',
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_SHARD_AGENT_HOSTER_USE1_1',
    limits: { vcpuQuota: 640 },
  };
  // The hoster CA and Motir's client pair (MOTIR-9470). A secret store keeps a
  // PEM on one line, so `\n` in the value reads as a newline.
  const HOSTER_TLS_VARS = [
    'MOTIR_HOSTER_CA_CERT',
    'MOTIR_HOSTER_CA_KEY',
    'MOTIR_HOSTER_CLIENT_CERT',
    'MOTIR_HOSTER_CLIENT_KEY',
  ];
  const stubHosterTls = () => {
    for (const name of HOSTER_TLS_VARS) vi.stubEnv(name, `-----BEGIN ${name}-----\\nbody\\n`);
  };

  it('builds an AWS persistent orchestrator from an aws row, naming every missing variable', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    const account = await createAccount(HOSTER);
    stubNoManagementCredential();
    vi.stubEnv('MOTIR_AWS_HOSTER_AMI_ID', '');
    for (const name of HOSTER_TLS_VARS) vi.stubEnv(name, '');
    const thrown = (() => {
      try {
        persistentOrchestratorForShard(account);
      } catch (err) {
        return err as Error;
      }
    })();
    expect(thrown).toBeInstanceOf(OrchestratorNotConfiguredError);
    for (const name of ['AWS_ORG_ADMIN_ROLE_ARN', 'MOTIR_AWS_HOSTER_AMI_ID', ...HOSTER_TLS_VARS]) {
      expect(thrown!.message).toContain(name);
    }

    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', TEST_MANAGEMENT_ROLE_ARN);
    vi.stubEnv('MOTIR_AWS_HOSTER_AMI_ID', 'ami-0fedcba9876543210');
    stubHosterTls();
    const persistent = persistentOrchestratorForShard(account);
    expect(persistent.provider).toBe('aws');
    expect(persistent.appNameFor('any-org')).toBe('agent-hoster-use1-1');
    expect(persistent.defaultRegion()).toBe('us-east-1');
  });

  it('the relay’s endpoint on an aws row reads the management credential and the client pair, never the AMI or the CA key', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    const account = await createAccount(HOSTER);
    stubNoManagementCredential();
    vi.stubEnv('MOTIR_AWS_HOSTER_AMI_ID', '');
    for (const name of HOSTER_TLS_VARS) vi.stubEnv(name, '');
    const handle = {
      provider: 'aws' as const,
      app: 'agent-hoster-use1-1',
      machineId: 'i-0123456789abcdef0',
      volumeId: 'vol-0123456789abcdef0',
      region: 'us-east-1',
      createdAt: HANDLE_TIME,
    };
    const thrown = await hosterTerminalEndpointFor(account, handle).catch((err: Error) => err);
    expect(thrown).toBeInstanceOf(OrchestratorNotConfiguredError);
    const message = (thrown as Error).message;
    for (const name of [
      'AWS_ORG_ADMIN_ROLE_ARN',
      'MOTIR_HOSTER_CA_CERT',
      'MOTIR_HOSTER_CLIENT_CERT',
      'MOTIR_HOSTER_CLIENT_KEY',
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain('MOTIR_AWS_HOSTER_AMI_ID');
    expect(message).not.toContain('MOTIR_HOSTER_CA_KEY');
  });

  it('the relay’s endpoint on a fly row, or under the fake, is the process-wide one', async () => {
    const account = await createAccount(HOSTER);
    const handle = {
      provider: 'fake' as const,
      app: 'agent-hoster-use1-1',
      machineId: 'm-1',
      volumeId: 'v-1',
      region: 'us-east-1',
      createdAt: HANDLE_TIME,
    };
    expect(await hosterTerminalEndpointFor(account, handle)).toEqual(
      await persistentTerminalEndpoint(handle),
    );
    const fly = await createAccount();
    expect(await hosterTerminalEndpointFor(fly, handle)).toEqual(
      await persistentTerminalEndpoint(handle),
    );
  });

  it('a fly row is the process-wide Fly instance lane, and the fake answers while it is selected', async () => {
    const account = await createAccount();
    // Under the fake, each account gets its own view of the shared fake (MOTIR-9472).
    expect(persistentOrchestratorForShard(account)).toBe(
      fakePersistentOrchestratorForShard(account.id),
    );
    expect(persistentOrchestratorForShard(account).provider).toBe('fake');
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_INSTANCES_API_TOKEN', 'instances-token');
    expect(persistentOrchestratorForShard(account)).toBe(getPersistentOrchestrator());
  });

  it('routes another provider through its registration, and refuses one that hosts no instances', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    const account = { ...(await createAccount()), provider: 'stub' } as unknown as FleetShardDTO;
    registerShardAdapter('stub', {
      orchestrator: () => fakeOrchestrator,
      inventory: () => null,
    });
    expect(() => persistentOrchestratorForShard(account)).toThrow(/hosts no agent instances/);
    registerShardAdapter('stub', {
      orchestrator: () => fakeOrchestrator,
      inventory: () => null,
      persistent: () => fakePersistentOrchestrator,
    });
    expect(persistentOrchestratorForShard(account)).toBe(fakePersistentOrchestrator);
    unregisterShardAdapter('stub');
  });
});
