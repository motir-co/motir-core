import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, type ContainerSpec } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { clock, fx, MIN, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

// THE ORG FLEET LAST-STOP RECORD against a real Postgres, with the stop service's
// own harness (`orgFleetStopService.test.ts`): a stop that did something records
// the newest owner or admin stop, best effort; a stop that did nothing, was
// refused or found nothing leaves it; the Fleet read carries it as `lastStop`,
// read / null / not_read; and nothing of another organisation is written or read.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

const { orgFleetStopService } = await import('@/lib/services/orgFleetStopService');
const { fleetStopService } = await import('@/lib/services/fleetStopService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { orgFleetService } = await import('@/lib/services/orgFleetService');
const { orgFleetLastStopRepository } =
  await import('@/lib/repositories/orgFleetLastStopRepository');

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
      startedAt: new Date(),
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

const row = (organizationId: string) =>
  adminDb.orgFleetLastStop.findUnique({ where: { organizationId } });

const lastStopOf = async (t: WorkItemFixture) =>
  (await orgFleetService.read(actor(t), clock.now())).lastStop;

describe('a stop that did something records the newest stop', () => {
  it('stopEverything: the admin’s name, the action and the time — read back on the Fleet read', async () => {
    const admin = await addOrgMember(fx, 'admin', 'Ada Admin');
    const result = await orgFleetStopService.stopEverything(actor(fx, admin.id), () => clock.now());
    expect(await row(a.organizationId)).toMatchObject({
      organizationId: a.organizationId,
      actorUserId: admin.id,
      actorName: 'Ada Admin',
      action: 'stop_everything',
      stoppedAt: new Date(result.stoppedAt),
    });
    expect(await lastStopOf(fx)).toEqual({
      kind: 'read',
      stop: { actorName: 'Ada Admin', action: 'stop_everything', at: result.stoppedAt },
    });
  });

  it('a later stop by another admin replaces it — one row per organisation', async () => {
    const ada = await addOrgMember(fx, 'admin', 'Ada Admin');
    const bo = await addOrgMember(fx, 'admin', 'Bo Admin');
    await orgFleetStopService.cancelHostedRun(actor(fx, ada.id), a.hostedRun, clock.now());
    clock.advance(5 * MIN);
    await orgFleetStopService.hibernateAgent(actor(fx, bo.id), a.instances[0]!, () => clock.now());
    expect(
      await adminDb.orgFleetLastStop.count({ where: { organizationId: a.organizationId } }),
    ).toBe(1);
    expect(await lastStopOf(fx)).toEqual({
      kind: 'read',
      stop: { actorName: 'Bo Admin', action: 'hibernate_agent', at: clock.now().toISOString() },
    });
  });

  it('cancelHostedRun records cancel_hosted_run', async () => {
    await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now());
    expect(await row(a.organizationId)).toMatchObject({ action: 'cancel_hosted_run' });
  });
});

describe('a stop that did nothing leaves the record as it was', () => {
  async function recorded() {
    await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now());
    clock.advance(MIN);
    return row(a.organizationId);
  }

  it('a second Stop everything that stopped nothing', async () => {
    await orgFleetStopService.stopEverything(actor(fx), () => clock.now());
    const before = await row(a.organizationId);
    clock.advance(MIN);
    const admin = await addOrgMember(fx, 'admin', 'Late Admin');
    await orgFleetStopService.stopEverything(actor(fx, admin.id), () => clock.now());
    expect(await row(a.organizationId)).toEqual(before);
  });

  it('a Cancel of a run that had already closed', async () => {
    const before = await recorded();
    await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now());
    expect(await row(a.organizationId)).toEqual(before);
  });

  it.each([
    ['hibernated', 'already_resting'],
    ['waking', 'in_motion'],
  ] as const)('a Hibernate of an agent %s (%s)', async (state, _kind) => {
    const before = await recorded();
    await adminDb.agentInstance.update({ where: { id: a.instances[0]! }, data: { state } });
    await orgFleetStopService.hibernateAgent(actor(fx), a.instances[0]!, () => clock.now());
    expect(await row(a.organizationId)).toEqual(before);
  });

  it('a not-found and a refusal', async () => {
    const before = await recorded();
    await expect(
      orgFleetStopService.hibernateAgent(actor(fx), b.instances[0]!, () => clock.now()),
    ).rejects.toThrow();
    await expect(
      orgFleetStopService.cancelHostedRun(actor(fx), b.hostedRun, clock.now()),
    ).rejects.toThrow();
    const member = await addOrgMember(fx, 'member', 'Mo Member');
    await expect(
      orgFleetStopService.stopEverything(actor(fx, member.id), () => clock.now()),
    ).rejects.toMatchObject({ name: 'BillingForbiddenError' });
    expect(await row(a.organizationId)).toEqual(before);
  });
});

describe('the record is best effort', () => {
  it.each(['stopEverything', 'cancelHostedRun', 'hibernateAgent'] as const)(
    '%s: a failed write changes nothing of the stop and is logged',
    async (method) => {
      vi.spyOn(orgFleetLastStopRepository, 'upsert').mockRejectedValue(new Error('down'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result =
        method === 'stopEverything'
          ? await orgFleetStopService.stopEverything(actor(fx), () => clock.now())
          : method === 'cancelHostedRun'
            ? await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now())
            : await orgFleetStopService.hibernateAgent(actor(fx), a.instances[0]!, () =>
                clock.now(),
              );
      const expected = {
        stopEverything: {
          runsCancelled: 2,
          ciContainersStopped: 2,
          hostedRunsEnded: 1,
          agentsHibernated: 2,
          failures: { ci: 0, hosted: 0, agents: 0 },
          stoppedByName: 'Owner',
          stoppedAt: clock.now().toISOString(),
        },
        cancelHostedRun: {
          dispatchRunId: a.hostedRun,
          closed: true,
          at: clock.now().toISOString(),
        },
        hibernateAgent: {
          kind: 'hibernated',
          instanceId: a.instances[0],
          ownerUserId: fx.ownerId,
          actorUserId: fx.ownerId,
          at: clock.now().toISOString(),
        },
      }[method];
      expect(result).toEqual(expected);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('could not record the last stop'),
        expect.objectContaining({ organizationId: a.organizationId }),
      );
      expect(await row(a.organizationId)).toBeNull();
    },
  );
});

describe('the read part', () => {
  it('reads null when the org has never been stopped', async () => {
    expect(await lastStopOf(fx)).toEqual({ kind: 'read', stop: null });
  });

  it('a failed read is not_read and logged; the other parts still read', async () => {
    vi.spyOn(orgFleetLastStopRepository, 'findForOrganization').mockRejectedValue(
      new Error('down'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = await orgFleetService.read(actor(fx), clock.now());
    expect(answer.lastStop).toEqual({ kind: 'not_read' });
    expect(answer.hostedRuns.kind).toBe('read');
    expect(answer.motirStops.kind).toBe('read');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('last stop'),
      expect.objectContaining({ organizationId: a.organizationId }),
    );
  });

  it('a stop whose actor name could not be read records and reads a null name', async () => {
    const { userRepository } = await import('@/lib/repositories/userRepository');
    vi.spyOn(userRepository, 'findByIds').mockResolvedValueOnce([]);
    await orgFleetStopService.cancelHostedRun(actor(fx), a.hostedRun, clock.now());
    expect(await lastStopOf(fx)).toMatchObject({ kind: 'read', stop: { actorName: null } });
  });

  it('carries no organisation or user id, by key or by value', async () => {
    const admin = await addOrgMember(fx, 'admin', 'Ada Admin');
    await orgFleetStopService.stopEverything(actor(fx, admin.id), () => clock.now());
    const part = await lastStopOf(fx);
    if (part.kind !== 'read' || !part.stop) throw new Error('expected a stop');
    expect(Object.keys(part.stop).sort()).toEqual(['action', 'actorName', 'at']);
    const text = JSON.stringify(part);
    for (const id of [a.organizationId, admin.id, fx.ownerId, fx.workspaceId]) {
      expect(text).not.toContain(id);
    }
    expect(text).not.toMatch(/actorUserId|organizationId|userId/);
  });
});

describe('two organisations', () => {
  it.each(['A', 'B'] as const)(
    'org %s’s stops write and read nothing of the other',
    async (who) => {
      const [mine, theirs] = who === 'A' ? [a, b] : [b, a];
      const upsert = vi.spyOn(orgFleetLastStopRepository, 'upsert');
      await orgFleetStopService.stopEverything(actor(mine.t), () => clock.now());
      await orgFleetStopService.hibernateAgent(actor(mine.t), mine.instances[0]!, () =>
        clock.now(),
      );
      expect(await row(theirs.organizationId)).toBeNull();
      expect(await lastStopOf(theirs.t)).toEqual({ kind: 'read', stop: null });
      expect(await lastStopOf(mine.t)).toMatchObject({
        kind: 'read',
        stop: { action: 'stop_everything' },
      });
      // The org id written is the caller's, every time.
      for (const [input] of upsert.mock.calls)
        expect(input.organizationId).toBe(mine.organizationId);
    },
  );
});
