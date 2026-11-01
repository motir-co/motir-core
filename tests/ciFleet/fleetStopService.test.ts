import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, type ContainerSpec } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { actionsRunsClient } from '@/lib/github/actionsRuns';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import * as orchestrator from '@/lib/orchestrator';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// STOP ONE ORGANISATION'S FLEET against real Postgres (Story MOTIR-6906 ·
// MOTIR-6908). What is faked: GitHub (`fetch`, behind a mocked installation
// token — the `actionsPermissions.test.ts` convention) and the orchestrator (the
// `fake` adapter, selected exactly as a deployment selects Fly). Everything else
// is real: the intents, their RLS contexts, the mirror → workspace → org
// traversal and the settle that records why each container ended.

// The token mint answers as GitHub does (MOTIR-10071): only for an installation
// id GitHub issued — a seeded `GithubInstallation.installationId` — and 404 for
// any other, Motir's own cuid included. So a run listed or cancelled under the
// wrong id fails this suite instead of passing behind the fake.
const minted = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async (installationId: string) => {
    const { adminDb: admin } = await import('../helpers/adminDb');
    const issued = await admin.githubInstallation.findUnique({ where: { installationId } });
    if (!issued) {
      throw new Error(`installation-token mint failed: token endpoint returned 404`);
    }
    minted.push(installationId);
    return { token: 'ghs_test', expiresAt: new Date() };
  }),
}));

const MOTIR_ORG = 'motir-projects';

interface Tenant {
  organizationId: string;
  workspaceId: string;
  projectId: string;
}

let seq = 0;

async function seedTenant(): Promise<Tenant> {
  seq += 1;
  const user = await usersService.createUser({
    email: `fleet-stop-${seq}-${randomToken(6)}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${seq}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Proj ${seq}`,
    identifier: `S${seq}X`,
  });
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}

/** GitHub's numeric id of the installation `seedRepo` puts a tenant's repos in. */
function hostInstallationIdOf(tenant: Tenant): string {
  return `inst-${tenant.workspaceId}`;
}

/** A repository Motir CREATED for the tenant, in Motir's own GitHub org. Its
 *  installation has a NULL `workspace_id`, as Motir's shared provisioning
 *  installation does in production — a tenant context cannot read it. */
async function seedRepo(
  tenant: Tenant,
  name: string,
  opts: { state?: 'created' | 'connected'; owner?: string } = {},
): Promise<void> {
  const owner = opts.owner ?? MOTIR_ORG;
  const installationId = hostInstallationIdOf(tenant);
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: null,
      accountLogin: owner,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      repoId: `${name}-${randomToken(8)}`,
      owner,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: opts.state ?? 'created',
      position: `a${seq}${name}`,
      githubRepoId: mirror.id,
    },
  });
}

let jobSeq = 0;

/** An intent in flight. `container: true` boots a real fake container for it,
 *  the way the boot records one. */
async function seedIntent(
  tenant: Tenant,
  opts: { container?: boolean; status?: string; runnerId?: number | null } = {},
): Promise<{ intentId: string; containerId: string | null }> {
  jobSeq += 1;
  const handle =
    opts.container === false
      ? null
      : await fakeOrchestrator.provision({ region: 'iad' } as ContainerSpec);
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      installationId: '556677',
      runId: String(7000 + jobSeq),
      runAttempt: 1,
      jobId: String(80_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: opts.status ?? 'running',
      containerProvider: handle?.provider ?? null,
      containerId: handle?.id ?? null,
      containerRegion: handle?.region ?? null,
      bootedAt: handle?.createdAt ?? null,
      githubRunnerId: opts.runnerId ?? null,
    },
  });
  return { intentId: intent.id, containerId: handle?.id ?? null };
}

/** A fake GitHub: live run ids per repository, and a record of every cancel. */
let liveRuns: Map<string, number[]>;
let cancels: string[];
let refuse: Set<string>;

function fakeGithub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const match = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs(?:\/(\d+)\/cancel)?$/.exec(
        url.pathname,
      );
      if (!match) throw new Error(`unexpected fetch to ${url.href}`);
      const repo = `${match[1]}/${match[2]}`;
      if (refuse.has(repo)) {
        return new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 });
      }
      const runs = liveRuns.get(repo) ?? [];
      if (init?.method === 'POST') {
        const runId = Number(match[3]);
        if (!runs.includes(runId)) return new Response(null, { status: 409 });
        liveRuns.set(
          repo,
          runs.filter((id) => id !== runId),
        );
        cancels.push(`${repo}#${runId}`);
        return new Response(null, { status: 202 });
      }
      // Each live run is reported under ONE status, as GitHub does.
      const status = url.searchParams.get('status');
      const listed = status === 'in_progress' ? runs.slice(0, 1) : runs.slice(1);
      return new Response(JSON.stringify({ workflow_runs: listed.map((id) => ({ id, status })) }), {
        status: 200,
      });
    }),
  );
}

async function intentOf(intentId: string) {
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: intentId } });
}

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  liveRuns = new Map();
  cancels = [];
  minted.length = 0;
  refuse = new Set();
  fakeGithub();
  vi.spyOn(runnerJitConfigClient, 'deleteRunner').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('fleetStopService.stopOrganization', () => {
  it('cancels every live run, tears down every container, and records why (AC1)', async () => {
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    await seedRepo(fx, 'alpha-api');
    liveRuns.set(`${MOTIR_ORG}/alpha-web`, [101]);
    liveRuns.set(`${MOTIR_ORG}/alpha-api`, [202]);
    const a = await seedIntent(fx, { runnerId: 9001 });
    const b = await seedIntent(fx);
    const c = await seedIntent(fx, { status: 'provisioning' });

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'credits_exhausted');

    expect(result).toEqual({ runsCancelled: 2, containersStopped: 3, failures: 0 });
    expect(cancels.sort()).toEqual([`${MOTIR_ORG}/alpha-api#202`, `${MOTIR_ORG}/alpha-web#101`]);
    // Every list and cancel minted for GitHub's id, never Motir's cuid (MOTIR-10071).
    expect(minted.length).toBeGreaterThan(0);
    expect(new Set(minted)).toEqual(new Set([hostInstallationIdOf(fx)]));
    expect(fakeOrchestrator.liveContainerIds()).toEqual([]);
    expect(fakeOrchestrator.teardowns.map((t) => t.reason)).toEqual([
      'gate_revoked',
      'gate_revoked',
      'gate_revoked',
    ]);
    for (const { intentId } of [a, b, c]) {
      expect(await intentOf(intentId)).toMatchObject({
        status: 'failed',
        teardownReason: 'credits_exhausted',
        failureDetail: "the organization's fleet was stopped at zero credits",
      });
    }
    // The stopped runner is de-registered, as every teardown path does — in the
    // provisioning org, so with no target (MOTIR-8711).
    expect(runnerJitConfigClient.deleteRunner).toHaveBeenCalledWith(9001, undefined);
    // And each container's cost is recorded, so a stop is still billed.
    expect(await adminDb.ciContainerUsage.count()).toBe(3);
  });

  it('CANCELS BEFORE IT TEARS DOWN, so no job re-requests a runner', async () => {
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    liveRuns.set(`${MOTIR_ORG}/alpha-web`, [101]);
    await seedIntent(fx);
    const order: string[] = [];
    const teardown = fakeOrchestrator.teardown.bind(fakeOrchestrator);
    vi.spyOn(fakeOrchestrator, 'teardown').mockImplementation(async (...args) => {
      order.push('teardown');
      return teardown(...args);
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (init?.method === 'POST') order.push('cancel');
        return realFetch(input, init);
      }),
    );

    await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(order).toEqual(['cancel', 'teardown']);
  });

  it('is IDEMPOTENT — a second call finds nothing and returns zeros (AC2)', async () => {
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    liveRuns.set(`${MOTIR_ORG}/alpha-web`, [101, 102]);
    await seedIntent(fx);

    await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');
    const again = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(again).toEqual({ runsCancelled: 0, containersStopped: 0, failures: 0 });
  });

  it('leaves ANOTHER org’s runs and containers untouched (AC3)', async () => {
    const stopped = await seedTenant();
    const other = await seedTenant();
    await seedRepo(stopped, 'mine');
    await seedRepo(other, 'theirs');
    liveRuns.set(`${MOTIR_ORG}/mine`, [1]);
    liveRuns.set(`${MOTIR_ORG}/theirs`, [2]);
    await seedIntent(stopped);
    const theirs = await seedIntent(other);

    await fleetStopService.stopOrganization(stopped.organizationId, 'credits_exhausted');

    expect(liveRuns.get(`${MOTIR_ORG}/theirs`)).toEqual([2]);
    expect(fakeOrchestrator.liveContainerIds()).toEqual([theirs.containerId]);
    expect(await intentOf(theirs.intentId)).toMatchObject({ status: 'running' });
  });

  it('never touches a repository Motir did not create, or one handed off out of its org', async () => {
    const fx = await seedTenant();
    await seedRepo(fx, 'users-own', { state: 'connected' });
    await seedRepo(fx, 'handed-off', { owner: 'someone-else' });
    liveRuns.set(`${MOTIR_ORG}/users-own`, [1]);
    liveRuns.set('someone-else/handed-off', [2]);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.runsCancelled).toBe(0);
    expect(cancels).toEqual([]);
  });

  it('a GitHub error on one repo does not stop the others, and is logged with the repo (AC4)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    await seedRepo(fx, 'broken');
    await seedRepo(fx, 'fine');
    refuse.add(`${MOTIR_ORG}/broken`);
    liveRuns.set(`${MOTIR_ORG}/fine`, [7]);
    await seedIntent(fx);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result).toEqual({ runsCancelled: 1, containersStopped: 1, failures: 1 });
    expect(error).toHaveBeenCalledWith(
      '[fleetStopService] could not cancel the runs of a repository',
      expect.objectContaining({ repo: `${MOTIR_ORG}/broken` }),
    );
  });

  it('a container that will not tear down is LEFT IN FLIGHT for the reaper, and the rest still go', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const stuck = await seedIntent(fx);
    const fine = await seedIntent(fx);
    fakeOrchestrator.failNextTeardown();

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result).toEqual({ runsCancelled: 0, containersStopped: 1, failures: 1 });
    expect(await intentOf(stuck.intentId)).toMatchObject({ status: 'running' });
    expect(await intentOf(fine.intentId)).toMatchObject({
      status: 'failed',
      teardownReason: 'admin_stop',
    });
    expect(error).toHaveBeenCalled();
  });

  it('settles an intent that has no container yet, without counting a container', async () => {
    const fx = await seedTenant();
    const booting = await seedIntent(fx, { container: false, status: 'provisioning' });

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.containersStopped).toBe(0);
    expect(await intentOf(booting.intentId)).toMatchObject({
      status: 'failed',
      teardownReason: 'admin_stop',
    });
  });

  it('with no orchestrator, leaves every container in flight and reports each as a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    const live = await seedIntent(fx);
    vi.spyOn(orchestrator, 'getOrchestrator').mockImplementation(() => {
      throw new Error('not configured');
    });

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result).toEqual({ runsCancelled: 0, containersStopped: 0, failures: 1 });
    expect(await intentOf(live.intentId)).toMatchObject({ status: 'running' });
  });

  it('a failed runner de-registration is logged, and the stop still settles the intent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(runnerJitConfigClient.deleteRunner).mockRejectedValue(new Error('403'));
    const fx = await seedTenant();
    const a = await seedIntent(fx, { runnerId: 5 });

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.containersStopped).toBe(1);
    expect(await intentOf(a.intentId)).toMatchObject({ status: 'failed' });
    expect(error).toHaveBeenCalledWith(
      '[fleetStopService] could not de-register a runner',
      expect.objectContaining({ runnerId: 5 }),
    );
  });

  it('with no provisioning org configured there are no repos to cancel on', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', '');
    const fx = await seedTenant();
    await seedIntent(fx);

    expect(await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop')).toEqual({
      runsCancelled: 0,
      containersStopped: 1,
      failures: 0,
    });
  });
});

describe('the edges of a stop', () => {
  it('a NON-ERROR GitHub failure is still logged, as `unknown`', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    vi.spyOn(actionsRunsClient, 'listActiveRuns').mockRejectedValue('a bare string');

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.failures).toBe(1);
    expect(error).toHaveBeenCalledWith(
      '[fleetStopService] could not cancel the runs of a repository',
      expect.objectContaining({ detail: 'unknown' }),
    );
  });

  it('a run that finished before its cancel landed is not counted', async () => {
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    liveRuns.set(`${MOTIR_ORG}/alpha-web`, [101]);
    vi.spyOn(actionsRunsClient, 'cancelRun').mockResolvedValue(false);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.runsCancelled).toBe(0);
  });

  it('with NO orchestrator configured, a container is left for the reaper', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const fx = await seedTenant();
    const live = await seedIntent(fx);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result).toEqual({ runsCancelled: 0, containersStopped: 0, failures: 1 });
    expect(await intentOf(live.intentId)).toMatchObject({ status: 'running' });
  });

  it('tears down an intent recorded with no project, region, boot time or numeric job id', async () => {
    const fx = await seedTenant();
    const { intentId, containerId } = await seedIntent(fx);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: intentId },
      data: { projectId: null, containerRegion: null, bootedAt: null, jobId: 'not-a-number' },
    });

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.containersStopped).toBe(1);
    expect(fakeOrchestrator.liveContainerIds()).not.toContain(containerId);
    // No project means no tenant to attribute a cost row to — the reaper's rule.
    expect(await adminDb.ciContainerUsage.count()).toBe(0);
  });

  it('an intent someone else settled first is not counted as this stop’s', async () => {
    const fx = await seedTenant();
    await seedIntent(fx);
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'settle').mockResolvedValue(false);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result.containersStopped).toBe(0);
  });
});

describe('the installation a stop mints for (MOTIR-10071)', () => {
  it("lists every hosted repository under GitHub's numeric installation id", async () => {
    const fx = await seedTenant();
    const other = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    await seedRepo(fx, 'alpha-api');
    await seedRepo(other, 'theirs');
    const cuid = (
      await adminDb.githubInstallation.findUniqueOrThrow({
        where: { installationId: hostInstallationIdOf(fx) },
      })
    ).id;

    const repos = await fleetStopService.listHostedRepos(fx.organizationId);

    expect(repos.map((r) => r.repo).sort()).toEqual(['alpha-api', 'alpha-web']);
    for (const repo of repos) {
      expect(repo.installationId).toBe(hostInstallationIdOf(fx));
      expect(repo.installationId).not.toBe(cuid);
    }
  });

  it('a minted cuid is refused, so a run listed under it is a counted failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    liveRuns.set(`${MOTIR_ORG}/alpha-web`, [101]);
    const cuid = (
      await adminDb.githubInstallation.findUniqueOrThrow({
        where: { installationId: hostInstallationIdOf(fx) },
      })
    ).id;
    vi.spyOn(fleetStopService, 'listHostedRepos').mockResolvedValue([
      { installationId: cuid, owner: MOTIR_ORG, repo: 'alpha-web' },
    ]);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result).toEqual({ runsCancelled: 0, containersStopped: 0, failures: 1 });
    expect(cancels).toEqual([]);
    expect(minted).toEqual([]);
  });

  it('a repository whose installation is gone by the resolve is skipped and logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = await seedTenant();
    await seedRepo(fx, 'alpha-web');
    vi.spyOn(githubInstallationRepository, 'findHostInstallationIdsByIds').mockResolvedValue(
      new Map(),
    );

    expect(await fleetStopService.listHostedRepos(fx.organizationId)).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      '[fleetStopService] a hosted repository has no installation on record',
      expect.objectContaining({ repo: `${MOTIR_ORG}/alpha-web` }),
    );
  });
});

describe('the FIRST settle wins', () => {
  it('a supervisor settling a stopped intent afterwards does not overwrite the stop reason', async () => {
    const fx = await seedTenant();
    const { intentId } = await seedIntent(fx);
    await fleetStopService.stopOrganization(fx.organizationId, 'credits_exhausted');

    const settled = await withSystemContext((tx) =>
      ciRunnerProvisioningIntentRepository.settle(
        intentId,
        {
          status: 'completed',
          teardownReason: 'job_completed',
          settledAt: new Date(),
          failureDetail: null,
        },
        tx,
      ),
    );

    expect(settled).toBe(false);
    expect(await intentOf(intentId)).toMatchObject({
      status: 'failed',
      teardownReason: 'credits_exhausted',
    });
  });
});

describe('each container is stopped in the account it was booted in (MOTIR-8964)', () => {
  afterEach(async () => {
    await adminDb.ciRunnerProvisioningIntent.deleteMany({});
    await adminDb.fleetShard.deleteMany({});
    orchestrator.resetShardFakes();
    fleetShardOrchestratorService.resetCache();
  });

  it("tears down account B's container through account B, and a legacy one through the process-wide fleet", async () => {
    const fx = await seedTenant();
    const accountB = await fleetShardService.createShard({
      name: 'ci-runner-b',
      fleetKind: 'ci_runner',
      provider: 'fly',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      flyOrg: 'motir',
      flyApp: 'motir-ci-b',
      flyRegion: 'ams',
      credentialRef: 'FLEET_SHARD_B_TOKEN',
      limits: { machineLimit: 50 },
    });
    const fakeB = orchestrator.fakeOrchestratorForShard(accountB.id);
    const handle = await fakeB.provision({ region: 'ams' } as ContainerSpec);
    jobSeq += 1;
    await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        projectId: fx.projectId,
        installationId: '556677',
        runId: String(7000 + jobSeq),
        runAttempt: 1,
        jobId: String(80_000 + jobSeq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: MOTIR_ORG,
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: new Date(),
        status: 'running',
        containerProvider: handle.provider,
        containerId: handle.id,
        containerRegion: handle.region,
        bootedAt: handle.createdAt,
        fleetShardId: accountB.id,
      },
    });
    const legacy = await seedIntent(fx);

    const result = await fleetStopService.stopOrganization(fx.organizationId, 'admin_stop');

    expect(result).toMatchObject({ containersStopped: 2, failures: 0 });
    expect(fakeB.teardowns).toEqual([{ handleId: handle.id, reason: 'gate_revoked' }]);
    expect(fakeOrchestrator.teardowns).toEqual([
      { handleId: legacy.containerId, reason: 'gate_revoked' },
    ]);
  });
});
