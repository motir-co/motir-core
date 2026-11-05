import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, type ContainerSpec } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { MissingAuditReasonError, NotPlatformStaffError } from '@/lib/platform/errors';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { clock, fleet, fx, MIN, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

// A PLATFORM ADMIN'S STOP of one organisation's containers (Story MOTIR-6905 ·
// MOTIR-7317) against a real Postgres: the real CI stop (fake orchestrator + a
// fake GitHub at `fetch`), the real agent-instance hibernate (the fake persistent
// fleet, via the instance harness), and the real audit trail. The hosted-run END
// is spied at its service seam — `endHostedRun`'s own revocations and close are
// pinned by the hosted-run suites — and its supervisor's slot release is played
// by hand, as the supervisor's next poll would.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError: Refused } = await import('@/lib/platform/errors');
        throw new Refused();
      }
      return currentPrincipal;
    },
  };
});

const { platformFleetStopService } = await import('@/lib/services/platformFleetStopService');
const { fleetStopService } = await import('@/lib/services/fleetStopService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
const { withSystemContext } = await import('@/lib/workspaces/context');

const MOTIR_ORG = 'motir-projects';
let seq = 0;

/** A repository Motir CREATED for the tenant, in Motir's own GitHub org. */
async function seedHostedRepo(t: WorkItemFixture, name: string): Promise<void> {
  seq += 1;
  const installationId = `inst-stop-${t.workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId: t.workspaceId,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: t.workspaceId,
      organizationId: t.workspace.organizationId,
      repoId: `stop-${seq}`,
      owner: MOTIR_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      role: 'web',
      name,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      state: 'created',
      position: `s${String(seq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

/** A CI intent in flight, with a live fake container. */
async function seedCiContainer(t: WorkItemFixture): Promise<string> {
  seq += 1;
  const handle = await fakeOrchestrator.provision({ region: 'iad' } as ContainerSpec);
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.workspace.organizationId,
      projectId: t.projectId,
      installationId: '556677',
      runId: String(7000 + seq),
      runAttempt: 1,
      jobId: String(80_000 + seq),
      repoOwner: MOTIR_ORG,
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: clock.now(),
      status: 'running',
      containerProvider: handle.provider,
      containerId: handle.id,
      containerRegion: handle.region,
      bootedAt: handle.createdAt,
    },
  });
  return intent.id;
}

/** A live slot of a slot-backed workload — a hosted run's names its run. */
async function seedSlot(t: WorkItemFixture, workload: string, ref: string): Promise<void> {
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref,
      organizationId: t.workspace.organizationId,
      workspaceId: t.workspaceId,
      claimedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 60 * MIN),
    },
  });
}

async function runningInstance(t: WorkItemFixture, name: string): Promise<string> {
  const dto = await lifecycle.create(t.projectIdentifier, { name, profileId: 'claude' }, t.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
}

/** A fake GitHub for the Actions runs API, delegating everything else to the
 *  instance harness's stub. */
let liveRuns: Map<string, number[]>;
let refuseRuns: Set<string>;
function fakeGithubRuns(): void {
  const inner = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      const match = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs(?:\/(\d+)\/cancel)?$/.exec(
        url.pathname,
      );
      if (!match) return inner(input, init);
      const repo = `${match[1]}/${match[2]}`;
      if (refuseRuns.has(repo)) return new Response('{}', { status: 500 });
      const runs = liveRuns.get(repo) ?? [];
      if (init?.method === 'POST') {
        const runId = Number(match[3]);
        if (!runs.includes(runId)) return new Response(null, { status: 409 });
        liveRuns.set(
          repo,
          runs.filter((id) => id !== runId),
        );
        return new Response(null, { status: 202 });
      }
      const status = url.searchParams.get('status');
      const listed = status === 'in_progress' ? runs : [];
      return new Response(JSON.stringify({ workflow_runs: listed.map((id) => ({ id, status })) }), {
        status: 200,
      });
    }),
  );
}

/** The hosted-run end, played at its seam: the first end of a running run closes
 *  it; a second end of the same run finds it closed. */
let endedRuns: Set<string>;
let order: string[];

async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser({ email: `ops+stop${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

const fleetStopRows = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.stop' },
    orderBy: { createdAt: 'asc' },
  });

async function census(t: WorkItemFixture) {
  return withSystemContext((tx) =>
    fleetCeilingService.orgCensus(t.workspace.organizationId, clock.now(), tx),
  );
}

/** The story's fixture: 2 runs, 3 CI containers, 1 hosted run, 2 agents, 1 index. */
async function seedBusyOrg(t: WorkItemFixture) {
  await seedHostedRepo(t, 'alpha-web');
  await seedHostedRepo(t, 'alpha-api');
  liveRuns.set(`${MOTIR_ORG}/alpha-web`, [101]);
  liveRuns.set(`${MOTIR_ORG}/alpha-api`, [202]);
  const intents = [await seedCiContainer(t), await seedCiContainer(t), await seedCiContainer(t)];
  await seedSlot(t, 'hosted_agent', hostedRunDispatchId(`run-${t.workspaceId}`));
  await seedSlot(t, 'code_graph_index', `index-${t.workspaceId}`);
  const instances = [await runningInstance(t, 'yue-a'), await runningInstance(t, 'yue-b')];
  return { intents, instances, hostedRun: `run-${t.workspaceId}` };
}

beforeEach(async () => {
  await setUpHarness();
  fakeOrchestrator.reset();
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  liveRuns = new Map();
  refuseRuns = new Set();
  fakeGithubRuns();
  vi.spyOn(runnerJitConfigClient, 'deleteRunner').mockResolvedValue(undefined);

  endedRuns = new Set();
  order = [];
  vi.spyOn(hostedRunService, 'endHostedRun').mockImplementation(async (dispatchRunId) => {
    order.push('hosted');
    const closed = !endedRuns.has(dispatchRunId);
    endedRuns.add(dispatchRunId);
    return {
      closed,
      runKey: 'revoked',
      runCredential: 0,
      gitCredentials: { revoked: 0, failed: 0 },
    };
  });
  const stopOrg = fleetStopService.stopOrganization.bind(fleetStopService);
  vi.spyOn(fleetStopService, 'stopOrganization').mockImplementation(async (...args) => {
    order.push('ci');
    return stopOrg(...args);
  });
  const hibernateAll = lifecycle.hibernateAllForOrganization.bind(lifecycle);
  vi.spyOn(lifecycle, 'hibernateAllForOrganization').mockImplementation(async (...args) => {
    order.push('instances');
    return hibernateAll(...args);
  });

  currentPrincipal = await principal('superadmin');
});

afterEach(tearDownHarness);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('stop', () => {
  it('AC1 + AC5: stops CI, then hosted runs, then agents — and the preview named exactly that', async () => {
    const busy = await seedBusyOrg(fx);
    const orgId = fx.workspace.organizationId;

    const preview = await platformFleetStopService.preview(currentPrincipal, orgId, clock.now());
    expect(preview).toEqual({
      ciRuns: 2,
      ciContainers: 3,
      hostedRuns: 1,
      agentInstances: 2,
      indexContainers: 1,
    });

    const result = await platformFleetStopService.stop(
      currentPrincipal,
      orgId,
      '  Runaway spend reported by the customer  ',
      clock.now(),
    );
    expect(result).toEqual({
      runsCancelled: 2,
      ciContainersStopped: 3,
      hostedRunsEnded: 1,
      agentInstancesHibernated: 2,
      failures: { ci: 0, hosted: 0, instances: 0 },
    });
    expect(order).toEqual(['ci', 'hosted', 'instances']);
    expect(hostedRunService.endHostedRun).toHaveBeenCalledWith(
      busy.hostedRun,
      'cancelled',
      'stopped by a platform admin',
    );

    // CI intents settled admin_stop; the agents hibernated.
    for (const id of busy.intents) {
      expect(
        await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'failed', teardownReason: 'admin_stop' });
    }
    for (const id of busy.instances) {
      expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
        'hibernated',
      );
    }

    // The supervisor's next poll tears the hosted container down and releases it.
    await adminDb.fleetInFlightSlot.deleteMany({ where: { workload: 'hosted_agent' } });
    expect((await census(fx)).byWorkload).toMatchObject({
      ci_runner: 0,
      hosted_agent: 0,
      agent_instance: 0,
      // Index containers are counted and never stopped.
      code_graph_index: 1,
    });
  });

  it('AC4: writes ONE fleet.stop row naming the actor, the org, the trimmed reason and the counts', async () => {
    await seedBusyOrg(fx);
    const orgId = fx.workspace.organizationId;
    await platformFleetStopService.stop(currentPrincipal, orgId, '  Runaway spend  ', clock.now());

    const rows = await fleetStopRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: currentPrincipal.userId,
      actorRole: 'superadmin',
      targetKind: 'organization',
      targetId: orgId,
      organizationId: orgId,
      reason: 'Runaway spend',
    });
    expect(rows[0]?.metadata).toMatchObject({
      runsCancelled: 2,
      ciContainersStopped: 3,
      hostedRunsEnded: 1,
      agentInstancesHibernated: 2,
      failures: { ci: 0, hosted: 0, instances: 0 },
    });
  });

  it('a second stop finds nothing left and returns zeros — every step is idempotent', async () => {
    await seedBusyOrg(fx);
    const orgId = fx.workspace.organizationId;
    await platformFleetStopService.stop(currentPrincipal, orgId, 'first', clock.now());
    const again = await platformFleetStopService.stop(
      currentPrincipal,
      orgId,
      'again',
      clock.now(),
    );
    expect(again).toEqual({
      runsCancelled: 0,
      ciContainersStopped: 0,
      hostedRunsEnded: 0,
      agentInstancesHibernated: 0,
      failures: { ci: 0, hosted: 0, instances: 0 },
    });
    expect(await fleetStopRows()).toHaveLength(2);
  });

  it('AC2: a second organisation’s CI intent, hosted run and agent are untouched', async () => {
    await seedBusyOrg(fx);
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const theirIntent = await seedCiContainer(elsewhere);
    await seedSlot(elsewhere, 'hosted_agent', hostedRunDispatchId('their-run'));
    const theirAgent = await runningInstance(elsewhere, 'theirs');

    await platformFleetStopService.stop(
      currentPrincipal,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );

    expect(
      await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: theirIntent } }),
    ).toMatchObject({ status: 'running', teardownReason: null });
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalledWith(
      'their-run',
      expect.anything(),
      expect.anything(),
    );
    expect(
      (await adminDb.agentInstance.findUniqueOrThrow({ where: { id: theirAgent } })).state,
    ).toBe('running');
    expect((await census(elsewhere)).byWorkload).toMatchObject({
      ci_runner: 1,
      hosted_agent: 1,
      agent_instance: 1,
    });
  });

  it('AC4: a partial failure is reported in the counts AND recorded in the audit row', async () => {
    await seedBusyOrg(fx);
    refuseRuns.add(`${MOTIR_ORG}/alpha-api`);
    fleet.failNextStop();

    const result = await platformFleetStopService.stop(
      currentPrincipal,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );
    expect(result.runsCancelled).toBe(1);
    expect(result.ciContainersStopped).toBe(3);
    expect(result.agentInstancesHibernated).toBe(1);
    expect(result.failures).toEqual({ ci: 1, hosted: 0, instances: 1 });

    const [row] = await fleetStopRows();
    expect(row?.metadata).toMatchObject({ failures: { ci: 1, hosted: 0, instances: 1 } });
    expect((row?.metadata as { instanceFailures: unknown[] }).instanceFailures).toHaveLength(1);
  });

  it('counts a hosted run whose key could not be revoked, or whose end threw, as a failure', async () => {
    await seedSlot(fx, 'hosted_agent', hostedRunDispatchId('run-a'));
    await seedSlot(fx, 'hosted_agent', hostedRunDispatchId('run-b'));
    vi.mocked(hostedRunService.endHostedRun)
      .mockResolvedValueOnce({
        closed: true,
        runKey: 'failed',
        runCredential: 0,
        gitCredentials: { revoked: 0, failed: 0 },
      })
      .mockRejectedValueOnce(new Error('boom'));

    const result = await platformFleetStopService.stop(
      currentPrincipal,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );
    expect(result.hostedRunsEnded).toBe(1);
    expect(result.failures.hosted).toBe(2);
  });

  it('AC3: support and operator are refused before any effect, and write no row', async () => {
    await seedBusyOrg(fx);
    for (const role of ['support', 'operator'] as const) {
      currentPrincipal = await principal(role);
      await expect(
        platformFleetStopService.stop(
          currentPrincipal,
          fx.workspace.organizationId,
          'Runaway spend',
          clock.now(),
        ),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
    }
    expect(order).toEqual([]);
    expect(await fleetStopRows()).toHaveLength(0);
  });

  it('AC3: a blank reason is refused before any effect, and writes no row', async () => {
    await seedBusyOrg(fx);
    for (const reason of ['', '   ']) {
      await expect(
        platformFleetStopService.stop(
          currentPrincipal,
          fx.workspace.organizationId,
          reason,
          clock.now(),
        ),
      ).rejects.toBeInstanceOf(MissingAuditReasonError);
    }
    expect(order).toEqual([]);
    expect(await fleetStopRows()).toHaveLength(0);
  });

  it('an unknown organisation is refused before any effect', async () => {
    await expect(
      platformFleetStopService.stop(currentPrincipal, 'no-such-org', 'Runaway spend', clock.now()),
    ).rejects.toThrow(/no-such-org|not found/i);
    expect(order).toEqual([]);
  });
});

describe('preview', () => {
  it('is readable by support and audited as an estate.read on the org', async () => {
    currentPrincipal = await principal('support');
    const before = await adminDb.platformAuditLog.count();
    const preview = await platformFleetStopService.preview(
      currentPrincipal,
      fx.workspace.organizationId,
      clock.now(),
    );
    expect(preview).toEqual({
      ciRuns: 0,
      ciContainers: 0,
      hostedRuns: 0,
      agentInstances: 0,
      indexContainers: 0,
    });
    const rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: fx.workspace.organizationId,
    });
  });

  it('says it does not know the run count when GitHub cannot be read', async () => {
    await seedHostedRepo(fx, 'alpha-web');
    refuseRuns.add(`${MOTIR_ORG}/alpha-web`);
    const preview = await platformFleetStopService.preview(
      currentPrincipal,
      fx.workspace.organizationId,
      clock.now(),
    );
    expect(preview.ciRuns).toBeNull();
  });
});

describe('lastOrgAdminStop', () => {
  async function stoppedIntent(
    t: WorkItemFixture,
    teardownReason: string,
    settledAt: Date,
  ): Promise<void> {
    const id = await seedCiContainer(t);
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id },
      data: { status: 'failed', teardownReason, settledAt },
    });
  }

  /** An interval of one of the org's agents, closed for `endReason` at `endedAt`.
   *  One running agent per org carries them all — the plan caps agents per person,
   *  and the read counts intervals, not agents. */
  const agentOf = new Map<string, string>();
  async function closedInterval(
    t: WorkItemFixture,
    endReason: 'org_admin_stop' | 'admin_stop' | 'credits' | 'idle' | 'backstop',
    endedAt: Date,
  ): Promise<void> {
    let instanceId = agentOf.get(t.workspaceId);
    if (!instanceId) {
      instanceId = await runningInstance(t, `agent-${seq++}`);
      agentOf.set(t.workspaceId, instanceId);
    }
    seq += 1;
    await adminDb.agentInstanceInterval.create({
      data: {
        workspaceId: t.workspaceId,
        organizationId: t.workspace.organizationId,
        agentInstanceId: instanceId,
        runId: `run-closed-${seq}`,
        runStartedAt: new Date(endedAt.getTime() - MIN),
        startedAt: new Date(endedAt.getTime() - MIN),
        endedAt,
        endReason,
        chargeReference: `closed-${seq}`,
      },
    });
  }

  const at = (minutesAgo: number) => new Date(clock.now().getTime() - minutesAgo * MIN);

  beforeEach(async () => {
    agentOf.clear();
    currentPrincipal = await principal('support');
  });

  it('none yet: null, and the read is audited estate.read on the org', async () => {
    const before = await adminDb.platformAuditLog.count();
    expect(
      await platformFleetStopService.lastOrgAdminStop(
        currentPrincipal,
        fx.workspace.organizationId,
      ),
    ).toBeNull();
    const rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: fx.workspace.organizationId,
    });
  });

  it('the newest moment, the rows of each kind in the 10 minutes before it, org_admin_stop only', async () => {
    await stoppedIntent(fx, 'org_admin_stop', at(1));
    await stoppedIntent(fx, 'org_admin_stop', at(9));
    await stoppedIntent(fx, 'org_admin_stop', at(30)); // outside the window
    await stoppedIntent(fx, 'admin_stop', at(1));
    await stoppedIntent(fx, 'credits_exhausted', at(1));
    await closedInterval(fx, 'org_admin_stop', at(2));
    await closedInterval(fx, 'org_admin_stop', at(45)); // outside the window
    await closedInterval(fx, 'credits', at(1));
    await closedInterval(fx, 'admin_stop', at(1));
    await closedInterval(fx, 'idle', at(1));
    await closedInterval(fx, 'backstop', at(1));

    const stop = await platformFleetStopService.lastOrgAdminStop(
      currentPrincipal,
      fx.workspace.organizationId,
    );
    expect(stop).toEqual({
      at: at(1).toISOString(),
      ciContainersStopped: 2,
      agentInstancesHibernated: 1,
      stoppedByName: null,
      hostedRunCancelled: false,
    });
  });

  it('a single Hibernate reads as a stop of one, timed by its interval', async () => {
    await closedInterval(fx, 'org_admin_stop', at(3));
    expect(
      await platformFleetStopService.lastOrgAdminStop(
        currentPrincipal,
        fx.workspace.organizationId,
      ),
    ).toEqual({
      at: at(3).toISOString(),
      ciContainersStopped: 0,
      agentInstancesHibernated: 1,
      stoppedByName: null,
      hostedRunCancelled: false,
    });
  });

  it('org A’s answer carries nothing of org B, though B stopped later and more', async () => {
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    await stoppedIntent(fx, 'org_admin_stop', at(5));
    await stoppedIntent(elsewhere, 'org_admin_stop', at(1));
    await stoppedIntent(elsewhere, 'org_admin_stop', at(2));
    await closedInterval(elsewhere, 'org_admin_stop', at(1));

    const mine = await platformFleetStopService.lastOrgAdminStop(
      currentPrincipal,
      fx.workspace.organizationId,
    );
    expect(mine).toEqual({
      at: at(5).toISOString(),
      ciContainersStopped: 1,
      agentInstancesHibernated: 0,
      stoppedByName: null,
      hostedRunCancelled: false,
    });
    expect(Object.keys(mine!).sort()).toEqual([
      'agentInstancesHibernated',
      'at',
      'ciContainersStopped',
      'hostedRunCancelled',
      'stoppedByName',
    ]);
    expect(
      await platformFleetStopService.lastOrgAdminStop(
        currentPrincipal,
        elsewhere.workspace.organizationId,
      ),
    ).toEqual({
      at: at(1).toISOString(),
      ciContainersStopped: 2,
      agentInstancesHibernated: 1,
      stoppedByName: null,
      hostedRunCancelled: false,
    });
  });

  async function lastStopRecord(
    t: WorkItemFixture,
    action: 'stop_everything' | 'cancel_hosted_run' | 'hibernate_agent',
    stoppedAt: Date,
    actorName: string | null = 'Ada Admin',
  ): Promise<void> {
    await adminDb.orgFleetLastStop.create({
      data: {
        organizationId: t.workspace.organizationId,
        actorUserId: t.ownerId,
        actorName,
        action,
        stoppedAt,
      },
    });
  }

  it('a hosted-run cancel, known only from the last-stop record, shows with the admin’s name', async () => {
    await lastStopRecord(fx, 'cancel_hosted_run', at(2));
    expect(
      await platformFleetStopService.lastOrgAdminStop(
        currentPrincipal,
        fx.workspace.organizationId,
      ),
    ).toEqual({
      at: at(2).toISOString(),
      ciContainersStopped: 0,
      agentInstancesHibernated: 0,
      stoppedByName: 'Ada Admin',
      hostedRunCancelled: true,
    });
  });

  it('the record names the stop only when it falls in the same window', async () => {
    await stoppedIntent(fx, 'org_admin_stop', at(1));
    await closedInterval(fx, 'org_admin_stop', at(1));
    await lastStopRecord(fx, 'stop_everything', at(1));
    expect(
      await platformFleetStopService.lastOrgAdminStop(
        currentPrincipal,
        fx.workspace.organizationId,
      ),
    ).toMatchObject({ stoppedByName: 'Ada Admin', hostedRunCancelled: false });

    await adminDb.orgFleetLastStop.update({
      where: { organizationId: fx.workspace.organizationId },
      data: { stoppedAt: at(40) },
    });
    expect(
      await platformFleetStopService.lastOrgAdminStop(
        currentPrincipal,
        fx.workspace.organizationId,
      ),
    ).toMatchObject({ at: at(1).toISOString(), stoppedByName: null, hostedRunCancelled: false });
  });

  it('refuses a non-staff principal before any read or audit row, and an unknown org', async () => {
    await stoppedIntent(fx, 'org_admin_stop', at(1));
    const before = await adminDb.platformAuditLog.count();
    currentPrincipal = { ...currentPrincipal, role: null as unknown as PlatformRole };
    await expect(
      platformFleetStopService.lastOrgAdminStop(currentPrincipal, fx.workspace.organizationId),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await adminDb.platformAuditLog.count()).toBe(before);

    currentPrincipal = await principal('support');
    await expect(
      platformFleetStopService.lastOrgAdminStop(currentPrincipal, 'no-such-org'),
    ).rejects.toThrow();
    expect(await adminDb.platformAuditLog.count()).toBe(before);
  });
});
