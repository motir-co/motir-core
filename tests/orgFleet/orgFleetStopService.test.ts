import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, type ContainerSpec } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { OrgFleetInstanceNotFoundError, OrgFleetRunNotFoundError } from '@/lib/orgFleet/errors';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import {
  clock,
  fleet,
  fx,
  intervals,
  MIN,
  otherMember,
  setUpHarness,
  tearDownHarness,
} from '../agentInstances/_harness';

// AN ORGANISATION OWNER OR ADMIN STOPS THE ORG'S OWN FLEET WORK
// (`agent-instances.md` §8 AMENDMENT 8) against a real Postgres: the real CI stop
// (fake orchestrator + a fake GitHub at `fetch`), the real agent hibernate (the
// fake persistent fleet, via the instance harness), and the hosted-run END spied
// at its service seam, as `platformFleetStopService.test.ts` does. Two seeded
// organisations prove every call is scoped to the caller's org, both ways; the
// gate refuses before any effect; a partial stop is a result, never a throw; and
// `org_admin_stop` is what every stop records.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

const { orgFleetStopService } = await import('@/lib/services/orgFleetStopService');
const { fleetStopService } = await import('@/lib/services/fleetStopService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { fleetInFlightSlotRepository } =
  await import('@/lib/repositories/fleetInFlightSlotRepository');
const { agentInstanceRepository } = await import('@/lib/repositories/agentInstanceRepository');
const { organizationsService } = await import('@/lib/services/organizationsService');

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
let githubCalls: string[];
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
      githubCalls.push(repo);
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

interface Tenant {
  t: WorkItemFixture;
  organizationId: string;
  intents: string[];
  instances: string[];
  hostedRun: string;
  repos: string[];
}

/** 2 runs, 2 CI containers, 1 hosted run, 2 running agents, 1 index container. */
async function seedBusy(t: WorkItemFixture, label: string): Promise<Tenant> {
  const repos = [`${label}-web`, `${label}-api`];
  for (const repo of repos) await seedHostedRepo(t, repo);
  liveRuns.set(`${MOTIR_ORG}/${repos[0]}`, [101]);
  liveRuns.set(`${MOTIR_ORG}/${repos[1]}`, [202]);
  const intents = [await seedCiContainer(t), await seedCiContainer(t)];
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      command: 'run',
      origin: 'hosted',
      status: 'running',
      createdById: t.ownerId,
      startedAt: clock.now(),
    },
  });
  const hostedRun = run.id;
  await seedSlot(t, 'hosted_agent', hostedRunDispatchId(hostedRun));
  await seedSlot(t, 'code_graph_index', `index-${t.workspaceId}`);
  const instances = [
    await runningInstance(t, `${label}-a`),
    await runningInstance(t, `${label}-b`),
  ];
  return { t, organizationId: t.workspace.organizationId, intents, instances, hostedRun, repos };
}

async function addOrgMember(t: WorkItemFixture, role: 'admin' | 'member', name: string) {
  const user = await createTestUser({ name });
  await organizationsService.addMember({
    organizationId: t.workspace.organizationId,
    userId: user.id,
    role,
    actorUserId: t.ownerId,
  });
  return user;
}

const actor = (t: WorkItemFixture, actorUserId = t.ownerId) => ({
  organizationId: t.workspace.organizationId,
  actorUserId,
});

const instanceRow = async (id: string) =>
  adminDb.agentInstance.findUniqueOrThrow({ where: { id } });

/** Everything of a tenant a stop could change. */
async function stateOf(tenant: Tenant) {
  return {
    intents: await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { organizationId: tenant.organizationId },
      select: { id: true, status: true, teardownReason: true },
      orderBy: { id: 'asc' },
    }),
    instances: await adminDb.agentInstance.findMany({
      where: { organizationId: tenant.organizationId },
      select: { id: true, state: true },
      orderBy: { id: 'asc' },
    }),
    slots: await adminDb.fleetInFlightSlot.count({
      where: { organizationId: tenant.organizationId },
    }),
    runs: tenant.repos.map((repo) => liveRuns.get(`${MOTIR_ORG}/${repo}`)),
  };
}

const FORBIDDEN_KEYS = [
  'organizationId',
  'awsAccountId',
  'shardId',
  'fleetShardId',
  'credentialRef',
  'machineId',
  'flyApp',
  'app',
  'containerId',
  'region',
];

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysOf(inner, out);
    }
  }
  return out;
}

async function expectNoLeak(answer: unknown, tenant: Tenant) {
  const keys = keysOf(JSON.parse(JSON.stringify(answer)));
  for (const key of FORBIDDEN_KEYS) expect(keys.has(key), `key ${key}`).toBe(false);
  const text = JSON.stringify(answer);
  expect(text).not.toContain(tenant.organizationId);
  for (const id of tenant.instances) {
    const row = await instanceRow(id);
    for (const secret of [row.machineId, row.volumeId, row.flyApp]) {
      if (secret) expect(text).not.toContain(secret);
    }
  }
}

let a: Tenant;
let b: Tenant;
let elsewhere: WorkItemFixture;

beforeEach(async () => {
  await setUpHarness();
  fakeOrchestrator.reset();
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  liveRuns = new Map();
  refuseRuns = new Set();
  githubCalls = [];
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

  a = await seedBusy(fx, 'alpha');
  elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
  b = await seedBusy(elsewhere, 'beta');
});

afterEach(tearDownHarness);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('previewStopEverything', () => {
  it.each(['A', 'B'] as const)('counts org %s’s work only', async (who) => {
    const [mine] = who === 'A' ? [a, b] : [b, a];
    const preview = await orgFleetStopService.previewStopEverything(actor(mine.t), clock.now());
    expect(preview).toEqual({
      ciRuns: 2,
      ciContainers: 2,
      hostedRuns: 1,
      runningAgents: 2,
      indexContainers: 1,
    });
    await expectNoLeak(preview, mine);
  });

  it('a count that cannot be read is null, never 0; the others still read', async () => {
    refuseRuns.add(`${MOTIR_ORG}/${a.repos[0]}`);
    vi.spyOn(agentInstanceRepository, 'listLiveForOrganization').mockRejectedValueOnce(
      new Error('down'),
    );
    vi.spyOn(fleetInFlightSlotRepository, 'listLiveForOrganization').mockRejectedValueOnce(
      new Error('down'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const preview = await orgFleetStopService.previewStopEverything(actor(fx), clock.now());
    expect(preview).toMatchObject({
      ciRuns: null,
      ciContainers: 2,
      hostedRuns: null,
      runningAgents: null,
      indexContainers: 1,
    });
  });

  it('every count of the five can fail alone to null', async () => {
    const { ciRunnerProvisioningIntentRepository } =
      await import('@/lib/repositories/ciRunnerProvisioningIntentRepository');
    const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
    vi.spyOn(
      ciRunnerProvisioningIntentRepository,
      'countInFlightForOrganization',
    ).mockRejectedValue('down');
    vi.spyOn(fleetCeilingService, 'orgCensus').mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const preview = await orgFleetStopService.previewStopEverything(actor(fx), clock.now());
    expect(preview).toMatchObject({ ciContainers: null, indexContainers: null, ciRuns: 2 });
  });
});

describe('stopEverything', () => {
  it('stops CI, then hosted runs, then agents — org_admin_stop everywhere, index left running', async () => {
    const admin = await addOrgMember(fx, 'admin', 'Ada Admin');
    const result = await orgFleetStopService.stopEverything(actor(fx, admin.id), () => clock.now());
    expect(result).toEqual({
      runsCancelled: 2,
      ciContainersStopped: 2,
      hostedRunsEnded: 1,
      agentsHibernated: 2,
      failures: { ci: 0, hosted: 0, agents: 0 },
      stoppedByName: 'Ada Admin',
      stoppedAt: clock.now().toISOString(),
    });
    expect(order).toEqual(['ci', 'hosted', 'instances']);
    expect(hostedRunService.endHostedRun).toHaveBeenCalledWith(
      a.hostedRun,
      'cancelled',
      'stopped by Ada Admin, an organization admin',
    );
    for (const id of a.intents) {
      expect(
        await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'failed', teardownReason: 'org_admin_stop' });
    }
    for (const id of a.instances) expect((await instanceRow(id)).state).toBe('hibernated');
    const closed = (await intervals()).filter((i) => a.instances.includes(i.agentInstanceId));
    expect(closed.map((i) => i.endReason)).toEqual(['org_admin_stop', 'org_admin_stop']);
    // The index container is untouched.
    expect(
      await adminDb.fleetInFlightSlot.count({
        where: { organizationId: a.organizationId, workload: 'code_graph_index' },
      }),
    ).toBe(1);
    await expectNoLeak(result, a);
  });

  it.each(['A', 'B'] as const)('org %s’s stop leaves the other org untouched', async (who) => {
    const [mine, theirs] = who === 'A' ? [a, b] : [b, a];
    const before = await stateOf(theirs);
    await orgFleetStopService.stopEverything(actor(mine.t), () => clock.now());
    expect(await stateOf(theirs)).toEqual(before);
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalledWith(
      theirs.hostedRun,
      expect.anything(),
      expect.anything(),
    );
    for (const repo of theirs.repos) expect(githubCalls).not.toContain(`${MOTIR_ORG}/${repo}`);
    expect(fakeOrchestrator.teardowns).toHaveLength(2);
  });

  it('a second stop finds nothing left and returns zeros', async () => {
    await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    const again = await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    expect(again).toMatchObject({
      runsCancelled: 0,
      ciContainersStopped: 0,
      hostedRunsEnded: 0,
      agentsHibernated: 0,
      failures: { ci: 0, hosted: 0, agents: 0 },
    });
  });

  it('a partial failure on every path is counted, never thrown', async () => {
    refuseRuns.add(`${MOTIR_ORG}/${a.repos[1]}`);
    fleet.failNextStop();
    vi.mocked(hostedRunService.endHostedRun).mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    expect(result).toMatchObject({
      runsCancelled: 1,
      hostedRunsEnded: 0,
      agentsHibernated: 1,
      failures: { ci: 1, hosted: 1, agents: 1 },
    });
  });

  it('a run key that could not be revoked counts as a hosted failure', async () => {
    vi.mocked(hostedRunService.endHostedRun).mockResolvedValueOnce({
      closed: true,
      runKey: 'failed',
      runCredential: 0,
      gitCredentials: { revoked: 0, failed: 0 },
    });
    const result = await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    expect(result).toMatchObject({ hostedRunsEnded: 1, failures: { hosted: 1 } });
  });

  it('a path that cannot even list its work is a counted failure, and the next path runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fleetInFlightSlotRepository, 'listLiveForOrganization').mockRejectedValueOnce(
      new Error('down'),
    );
    vi.mocked(lifecycle.hibernateAllForOrganization).mockRejectedValueOnce(new Error('down'));
    const { userRepository } = await import('@/lib/repositories/userRepository');
    vi.spyOn(userRepository, 'findByIds').mockRejectedValueOnce(new Error('down'));
    const result = await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    expect(result).toMatchObject({
      ciContainersStopped: 2,
      hostedRunsEnded: 0,
      agentsHibernated: 0,
      failures: { ci: 0, hosted: 1, agents: 1 },
      stoppedByName: null,
    });
  });
  it('a CI step whose listing throws is one CI failure, and the hosted runs and agents still stop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fleetStopService.stopOrganization).mockRejectedValueOnce(new Error('db down'));
    const result = await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    expect(result).toMatchObject({
      runsCancelled: 0,
      ciContainersStopped: 0,
      hostedRunsEnded: 1,
      agentsHibernated: 2,
      failures: { ci: 1, hosted: 0, agents: 0 },
    });
    for (const id of a.instances) expect((await instanceRow(id)).state).toBe('hibernated');
  });
});

describe('cancelHostedRun', () => {
  it('cancels one of the org’s live runs, whoever started it', async () => {
    const admin = await addOrgMember(fx, 'admin', 'Ada Admin');
    const outcome = await orgFleetStopService.cancelHostedRun(
      actor(fx, admin.id),
      a.hostedRun,
      clock.now(),
    );
    expect(outcome).toEqual({
      dispatchRunId: a.hostedRun,
      closed: true,
      at: clock.now().toISOString(),
    });
    expect(hostedRunService.endHostedRun).toHaveBeenCalledWith(
      a.hostedRun,
      'cancelled',
      'stopped by Ada Admin, an organization admin',
    );
    const again = await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now());
    expect(again.closed).toBe(false);
  });

  it('another org’s run, an ended run and an agent’s slot are all not found, and nothing ends', async () => {
    await seedSlot(fx, 'agent_instance', 'agent-slot-ref');
    for (const id of [b.hostedRun, 'run-that-ended', 'agent-slot-ref']) {
      await expect(
        orgFleetStopService.cancelHostedRun(actor(fx), id, clock.now()),
      ).rejects.toBeInstanceOf(OrgFleetRunNotFoundError);
    }
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalled();
  });

  it('a run already closed whose slot its supervisor has not released yet is not live', async () => {
    // A cancel closes the run at once; the container and its slot go at the
    // supervisor's next poll. In between the run is neither counted nor cancelled.
    await adminDb.dispatchRun.update({ where: { id: a.hostedRun }, data: { status: 'cancelled' } });
    await expect(
      orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now()),
    ).rejects.toBeInstanceOf(OrgFleetRunNotFoundError);
    const preview = await orgFleetStopService.previewStopEverything(actor(fx), clock.now());
    expect(preview.hostedRuns).toBe(0);
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalled();
  });

  it('a name that cannot be read still closes the run, with the plain detail', async () => {
    const { userRepository } = await import('@/lib/repositories/userRepository');
    vi.spyOn(userRepository, 'findByIds').mockResolvedValueOnce([]);
    await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now());
    expect(hostedRunService.endHostedRun).toHaveBeenCalledWith(
      a.hostedRun,
      'cancelled',
      'stopped by an organization admin',
    );
  });
});

describe('hibernateAgent', () => {
  it('hibernates another member’s agent with org_admin_stop and names its owner', async () => {
    const other = await otherMember();
    const dto = await lifecycle.create(
      fx.projectIdentifier,
      { name: 'theirs', profileId: 'claude' },
      other,
    );
    const outcome = await orgFleetStopService.hibernateAgent(actor(fx), dto.id, () => clock.now());
    expect(outcome).toEqual({
      kind: 'hibernated',
      instanceId: dto.id,
      ownerUserId: other.userId,
      actorUserId: fx.ownerId,
      at: clock.now().toISOString(),
    });
    expect((await instanceRow(dto.id)).state).toBe('hibernated');
    const closed = (await intervals()).filter((i) => i.agentInstanceId === dto.id);
    expect(closed.map((i) => i.endReason)).toEqual(['org_admin_stop']);
    // Nobody else's agent moved.
    for (const id of [...a.instances, ...b.instances]) {
      expect((await instanceRow(id)).state).toBe('running');
    }
    await expectNoLeak(outcome, a);
  });

  it('another org’s agent, a deleted one and an unknown id are not found, and nothing moves', async () => {
    await adminDb.agentInstance.update({
      where: { id: a.instances[1]! },
      data: { deletedAt: clock.now() },
    });
    for (const id of [b.instances[0]!, a.instances[1]!, 'no-such-agent']) {
      await expect(
        orgFleetStopService.hibernateAgent(actor(fx), id, () => clock.now()),
      ).rejects.toBeInstanceOf(OrgFleetInstanceNotFoundError);
    }
    expect((await instanceRow(b.instances[0]!)).state).toBe('running');
  });

  it.each([
    ['hibernated', 'already_resting'],
    ['hibernating', 'already_resting'],
    ['starting', 'in_motion'],
    ['waking', 'in_motion'],
    ['updating', 'in_motion'],
    ['deleting', 'in_motion'],
  ] as const)('an agent %s answers %s and is not moved', async (state, kind) => {
    const id = a.instances[0]!;
    await adminDb.agentInstance.update({ where: { id }, data: { state } });
    const begin = vi.spyOn(lifecycle, 'beginHibernate');
    expect(await orgFleetStopService.hibernateAgent(actor(fx), id, () => clock.now())).toEqual({
      kind,
      instanceId: id,
    });
    expect(begin).not.toHaveBeenCalled();
    expect((await instanceRow(id)).state).toBe(state);
  });

  it.each([
    ['hibernated', 'already_resting'],
    ['waking', 'in_motion'],
  ] as const)(
    'another path moves it first (%s): answers %s, never hibernated',
    async (state, kind) => {
      const id = a.instances[0]!;
      vi.spyOn(lifecycle, 'beginHibernate').mockImplementationOnce(async () => {
        await adminDb.agentInstance.update({ where: { id }, data: { state } });
        return false;
      });
      expect(await orgFleetStopService.hibernateAgent(actor(fx), id, () => clock.now())).toEqual({
        kind,
        instanceId: id,
      });
    },
  );
});

describe('defaults and odd slots', () => {
  it('a hosted slot whose ref names no run is neither counted nor ended', async () => {
    await seedSlot(fx, 'hosted_agent', hostedRunDispatchId(''));
    await seedSlot(fx, 'hosted_agent', 'container:not-a-run');
    const preview = await orgFleetStopService.previewStopEverything(actor(fx), clock.now());
    expect(preview.hostedRuns).toBe(1);
    const result = await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    expect(result.hostedRunsEnded).toBe(1);
    expect(hostedRunService.endHostedRun).toHaveBeenCalledTimes(1);
  });

  it('every method runs on the real clock when none is passed', async () => {
    // The harness's clock is virtual; hold the hosted slot past the real one.
    await adminDb.fleetInFlightSlot.updateMany({
      where: { organizationId: a.organizationId, workload: 'hosted_agent' },
      data: { expiresAt: new Date(Date.now() + 60 * MIN) },
    });
    expect((await orgFleetStopService.previewStopEverything(actor(fx))).hostedRuns).toBe(1);
    expect((await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun)).closed).toBe(true);
    const outcome = await orgFleetStopService.hibernateAgent(actor(fx), a.instances[0]!);
    expect(outcome.kind).toBe('hibernated');
    const result = await orgFleetStopService.stopEverything(actor(fx));
    expect(Number.isNaN(Date.parse(result.stoppedAt))).toBe(false);
  });
});

describe('the gate refuses all four methods before any effect', () => {
  const calls = {
    previewStopEverything: (input: { organizationId: string; actorUserId: string }) =>
      orgFleetStopService.previewStopEverything(input, clock.now()),
    stopEverything: (input: { organizationId: string; actorUserId: string }) =>
      orgFleetStopService.stopEverything(input, () => clock.now()),
    cancelHostedRun: (input: { organizationId: string; actorUserId: string }) =>
      orgFleetStopService.cancelHostedRun(input, a.hostedRun, clock.now()),
    hibernateAgent: (input: { organizationId: string; actorUserId: string }) =>
      orgFleetStopService.hibernateAgent(input, a.instances[0]!, () => clock.now()),
  };

  it.each(
    (Object.keys(calls) as Array<keyof typeof calls>).flatMap((method) =>
      (
        [
          ['a plain member', 'member', 'BillingForbiddenError'],
          ['a non-member', 'stranger', 'OrganizationNotFoundError'],
          ['another org’s owner', 'other', 'OrganizationNotFoundError'],
          ['anyone off a build without the fleet meter', 'offCloud', 'BillingNotAvailableError'],
        ] as const
      ).map(([label, who, error]) => [method, label, who, error] as const),
    ),
  )('%s: %s gets %s', async (method, _label, who, error) => {
    let actorUserId = fx.ownerId;
    if (who === 'member') actorUserId = (await addOrgMember(fx, 'member', 'Mo Member')).id;
    if (who === 'stranger') actorUserId = (await createTestUser()).id;
    if (who === 'other') actorUserId = elsewhere.ownerId;
    if (who === 'offCloud') vi.stubEnv('MOTIR_CLOUD', 'false');
    const begin = vi.spyOn(lifecycle, 'beginHibernate');
    const slots = vi.spyOn(fleetInFlightSlotRepository, 'listLiveForOrganization');
    const before = await stateOf(a);

    await expect(
      calls[method]({ organizationId: a.organizationId, actorUserId }),
    ).rejects.toMatchObject({ name: error });

    expect(order).toEqual([]);
    expect(githubCalls).toEqual([]);
    expect(begin).not.toHaveBeenCalled();
    expect(slots).not.toHaveBeenCalled();
    expect(fakeOrchestrator.teardowns).toEqual([]);
    expect(await stateOf(a)).toEqual(before);
  });
});
