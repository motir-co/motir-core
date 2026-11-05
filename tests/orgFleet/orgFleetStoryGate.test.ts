import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator, type ContainerSpec } from '@motir/orchestrator';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { OrgFleetInstanceNotFoundError, OrgFleetRunNotFoundError } from '@/lib/orgFleet/errors';
import { toNotificationDto } from '@/lib/mappers/notificationMappers';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { clock, intervals, MIN, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

/**
 * STORY MOTIR-10363's INTEGRATION GATE (MOTIR-10371): org admins see what their
 * organisation runs on the fleet, and can stop it — ASSEMBLED, against a real
 * Postgres.
 *
 * Two organisations, A and B, are seeded from ONE helper so their fleets are
 * structurally identical and any leak is visible: a live hosted run, a CI job in
 * flight and one waiting, the owner's, the admin's and a member's running agent,
 * a member's hibernated agent, an index container, and Motir kills inside and
 * outside the 7-day window. Every door of the story — the read, its route, the
 * preview, Stop everything, Cancel, Hibernate, the page's Server Actions, the
 * owner notification and the platform last-org-admin-stop read — is then driven
 * as one org's admin, and the OTHER org's every row is snapshotted before and
 * compared after.
 *
 * ⚠️ Every one of these paths reads under the system context, which bypasses
 * row-level security: the services' own organisation filter is the ONLY
 * isolation, and this file is its proof.
 *
 * The only fakes are the existing seams: the session (a test has no cookie jar),
 * the platform principal, the container orchestrator, GitHub at `fetch`, and the
 * hosted-run END at its service seam (as the stop-service test plays it). Each
 * predecessor's unit cases stay in its own file and are not repeated here.
 */

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session.current),
}));
vi.mock('@/lib/auth/requireCompliantSession', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireCompliantSession: vi.fn(async () =>
      session.current
        ? { ok: true, session: { user: { id: session.current.user.id, email: 'x@test' } } }
        : { ok: false, response: NextResponse.json({}, { status: 401 }) },
    ),
  };
});

let currentPrincipal: PlatformPrincipal;
vi.mock('@/lib/platform/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/auth')>();
  return {
    ...actual,
    requirePlatformStaff: async (minimum: PlatformRole = 'support') => {
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        const { NotPlatformStaffError } = await import('@/lib/platform/errors');
        throw new NotPlatformStaffError();
      }
      return currentPrincipal;
    },
  };
});

const { orgFleetService } = await import('@/lib/services/orgFleetService');
const { orgFleetStopService } = await import('@/lib/services/orgFleetStopService');
const { platformFleetStopService } = await import('@/lib/services/platformFleetStopService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const actions = await import('@/app/(authed)/settings/organization/fleet/actions');
const { GET } = await import('@/app/api/organizations/[orgId]/fleet/route');

const MOTIR_ORG = 'motir-projects';
const TYPE = 'agent_hibernated_by_admin';
const DAY = 24 * 60 * MIN;
let seq = 0;

interface Tenant {
  label: string;
  t: WorkItemFixture;
  organizationId: string;
  admin: { id: string; name: string };
  member: { id: string; name: string };
  repo: string;
  hostedRun: string;
  endedRun: string;
  intents: { inFlight: string; waiting: string };
  agents: { owner: string; admin: string; member: string; memberResting: string };
  /** Every identifying value of this tenant that must never leave the server. */
  secrets: string[];
}

async function joinOrg(t: WorkItemFixture, role: 'admin' | 'member', name: string) {
  const user = await createTestUser({ name });
  await organizationsService.addMember({
    organizationId: t.workspace.organizationId,
    userId: user.id,
    role,
    actorUserId: t.ownerId,
  });
  await adminDb.workspaceMembership.createMany({
    data: [{ workspaceId: t.workspaceId, userId: user.id, workspaceRole: 'member' }],
    skipDuplicates: true,
  });
  return { id: user.id, name };
}

async function hostedRepo(t: WorkItemFixture, name: string) {
  seq += 1;
  const installationId = `inst-gate-${t.workspaceId}`;
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
      repoId: `gate-${seq}`,
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
      position: `g${String(seq).padStart(3, '0')}1`,
      githubRepoId: mirror.id,
    },
  });
}

async function intent(t: WorkItemFixture, repo: string, status: 'running' | 'pending') {
  seq += 1;
  const handle =
    status === 'running'
      ? await fakeOrchestrator.provision({ region: 'iad' } as ContainerSpec)
      : null;
  const row = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.workspace.organizationId,
      projectId: t.projectId,
      installationId: '556677',
      runId: String(9000 + seq),
      runAttempt: 1,
      jobId: String(90_000 + seq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: repo,
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: clock.now(),
      status,
      waitingReason: status === 'pending' ? 'plan_limit' : null,
      containerProvider: handle?.provider ?? null,
      containerId: handle?.id ?? null,
      containerRegion: handle?.region ?? null,
      bootedAt: handle?.createdAt ?? null,
    },
  });
  return { id: row.id, containerId: handle?.id ?? null };
}

async function dispatchRun(
  t: WorkItemFixture,
  createdById: string,
  status: 'running' | 'succeeded',
) {
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      command: 'run',
      origin: 'hosted',
      status,
      createdById,
      startedAt: new Date(clock.now().getTime() - 5 * MIN),
    },
  });
  return run.id;
}

async function slot(t: WorkItemFixture, workload: string, ref: string) {
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload,
      ref,
      ownerRef: ref,
      organizationId: t.workspace.organizationId,
      workspaceId: t.workspaceId,
      claimedAt: clock.now(),
      // The route and the Server Actions read at the wall clock, the services at
      // the harness clock: the claim must be live at both.
      expiresAt: new Date(Math.max(clock.now().getTime(), Date.now()) + 60 * MIN),
    },
  });
}

async function agent(t: WorkItemFixture, userId: string, name: string) {
  const dto = await lifecycle.create(
    t.projectIdentifier,
    { name, profileId: 'claude' },
    { userId, workspaceId: t.workspaceId },
  );
  expect(dto.state).toBe('running');
  return dto.id;
}

async function kill(t: WorkItemFixture, decidedAt: Date, secrets: string[]) {
  seq += 1;
  const machineId = `kill-mach-${seq}-${t.workspaceId}`;
  const app = `motir-ci-gate-${seq}`;
  await adminDb.fleetMachineKill.create({
    data: {
      app,
      machineId,
      reason: 'record_ended',
      action: 'destroyed',
      workload: 'ci_runner',
      recordRef: `kill-ref-${seq}`,
      organizationId: t.workspace.organizationId,
      ageSeconds: 600,
      decidedAt,
      completedAt: decidedAt,
      failureDetail: `provider said ${seq}`,
    },
  });
  secrets.push(machineId, app);
}

/** ONE helper, called for A and for B: structurally identical fleets. */
async function seedTenant(label: string): Promise<Tenant> {
  const t = await makeWorkItemFixture({ name: `Org ${label}`, identifier: `G${label}` });
  const organizationId = t.workspace.organizationId;
  const admin = await joinOrg(t, 'admin', `Admin ${label}`);
  const member = await joinOrg(t, 'member', `Member ${label}`);
  const repo = `web-${label.toLowerCase()}`;
  await hostedRepo(t, repo);
  liveRuns.set(`${MOTIR_ORG}/${repo}`, [seq * 10]);
  const inFlight = await intent(t, repo, 'running');
  const waiting = await intent(t, repo, 'pending');
  const hostedRun = await dispatchRun(t, member.id, 'running');
  await slot(t, 'hosted_agent', hostedRunDispatchId(hostedRun));
  const endedRun = await dispatchRun(t, member.id, 'succeeded');
  await slot(t, 'code_graph_index', `index-${t.workspaceId}`);
  const l = label.toLowerCase();
  const agents = {
    owner: await agent(t, t.ownerId, `${l}-owner`),
    admin: await agent(t, admin.id, `${l}-admin`),
    member: await agent(t, member.id, `${l}-member`),
    memberResting: await agent(t, member.id, `${l}-resting`),
  };
  await adminDb.agentInstance.update({
    where: { id: agents.memberResting },
    data: { state: 'hibernated' },
  });
  const secrets: string[] = [organizationId];
  await kill(t, new Date(clock.now().getTime() - DAY), secrets);
  await kill(t, new Date(clock.now().getTime() - 2 * 60 * MIN), secrets);
  await kill(t, new Date(clock.now().getTime() - 8 * DAY), secrets);
  for (const id of Object.values(agents)) {
    const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
    for (const value of [row.machineId, row.volumeId, row.flyApp]) if (value) secrets.push(value);
  }
  if (inFlight.containerId) secrets.push(inFlight.containerId);
  return {
    label,
    t,
    organizationId,
    admin,
    member,
    repo,
    hostedRun,
    endedRun,
    intents: { inFlight: inFlight.id, waiting: waiting.id },
    agents,
    secrets,
  };
}

// ── the fakes ──────────────────────────────────────────────────────────────

let liveRuns: Map<string, number[]>;
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
      const listed = url.searchParams.get('status') === 'in_progress' ? runs : [];
      return new Response(
        JSON.stringify({ workflow_runs: listed.map((id) => ({ id, status: 'in_progress' })) }),
        { status: 200 },
      );
    }),
  );
}

let endedRuns: Set<string>;

// ── the snapshots and the walk ─────────────────────────────────────────────

/** Every row of a tenant any door of the story could change, in full. */
async function snapshot(tenant: Tenant) {
  const where = { organizationId: tenant.organizationId };
  const instanceIds = Object.values(tenant.agents);
  return JSON.stringify({
    slots: await adminDb.fleetInFlightSlot.findMany({ where, orderBy: { id: 'asc' } }),
    intents: await adminDb.ciRunnerProvisioningIntent.findMany({ where, orderBy: { id: 'asc' } }),
    instances: await adminDb.agentInstance.findMany({ where, orderBy: { id: 'asc' } }),
    intervals: (await intervals()).filter((i) => instanceIds.includes(i.agentInstanceId)),
    kills: await adminDb.fleetMachineKill.findMany({ where, orderBy: { id: 'asc' } }),
    runs: await adminDb.dispatchRun.findMany({
      where: { workspaceId: tenant.t.workspaceId },
      orderBy: { id: 'asc' },
    }),
    notifications: await adminDb.notification.findMany({
      where: { recipientUserId: { in: [tenant.t.ownerId, tenant.admin.id, tenant.member.id] } },
      orderBy: { id: 'asc' },
    }),
    lastStop: await adminDb.orgFleetLastStop.findMany({ where }),
    github: liveRuns.get(`${MOTIR_ORG}/${tenant.repo}`),
    hostedEnded: endedRuns.has(tenant.hostedRun),
    teardowns: fakeOrchestrator.teardowns.filter((td) => tenant.secrets.includes(td.handleId)),
  });
}

const FORBIDDEN_KEYS = [
  'organizationId',
  'awsAccountId',
  'shardId',
  'fleetShardId',
  'credentialRef',
  'machineId',
  'volumeId',
  'region',
  'containerRegion',
  'flyApp',
  'app',
  'appName',
  'containerId',
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

/** The walk: no forbidden key, no seeded identifying value of EITHER org, no
 *  link to an agent's panel or terminal. `other` is the org whose ids must not
 *  appear at all — not even its display names. */
function expectNoLeak(answer: unknown, other?: Tenant) {
  const plain: unknown = JSON.parse(JSON.stringify(answer ?? null));
  const keys = keysOf(plain);
  for (const key of FORBIDDEN_KEYS) expect(keys.has(key), `key ${key}`).toBe(false);
  const text = JSON.stringify(plain);
  for (const secret of [...a.secrets, ...b.secrets]) {
    expect(text.includes(secret), `value ${secret}`).toBe(false);
  }
  expect(text).not.toMatch(/\/agents\/|\/terminal|\/panel/);
  if (other) {
    for (const id of [
      other.hostedRun,
      other.endedRun,
      ...Object.values(other.agents),
      ...Object.values(other.intents),
    ]) {
      expect(text.includes(id), `other org's id ${id}`).toBe(false);
    }
    for (const name of [other.admin.name, other.member.name, other.repo, `Org ${other.label}`]) {
      expect(text.includes(name), `other org's name ${name}`).toBe(false);
    }
  }
}

const as = (tenant: Tenant, actorUserId = tenant.admin.id) => ({
  organizationId: tenant.organizationId,
  actorUserId,
});
const now = () => clock.now();
const notifications = () =>
  adminDb.notification.findMany({ where: { type: TYPE }, orderBy: { createdAt: 'asc' } });

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  await setUpHarness();
  fakeOrchestrator.reset();
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  liveRuns = new Map();
  githubCalls = [];
  fakeGithubRuns();
  vi.spyOn(runnerJitConfigClient, 'deleteRunner').mockResolvedValue(undefined);
  endedRuns = new Set();
  vi.spyOn(hostedRunService, 'endHostedRun').mockImplementation(async (dispatchRunId) => {
    const closed = !endedRuns.has(dispatchRunId);
    endedRuns.add(dispatchRunId);
    return {
      closed,
      runKey: 'revoked',
      runCredential: 0,
      gitCredentials: { revoked: 0, failed: 0 },
    };
  });
  session.current = null;
  await adminDb.fleetMachineKill.deleteMany({});
  a = await seedTenant('A');
  b = await seedTenant('B');
});

afterEach(async () => {
  session.current = null;
  await adminDb.fleetMachineKill.deleteMany({});
  await tearDownHarness();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const pairs = [
  ['A', () => [a, b] as const],
  ['B', () => [b, a] as const],
] as const;

describe('the read, both ways', () => {
  it.each(pairs)('org %s’s admin reads its own fleet and nothing of the other', async (_, pick) => {
    const [mine, theirs] = pick();
    const before = await snapshot(theirs);
    const fleet = await orgFleetService.read(as(mine), now());

    if (fleet.hostedRuns.kind !== 'read') throw new Error('hosted runs not read');
    expect(fleet.hostedRuns.rows.map((r) => r.id)).toEqual([mine.hostedRun]);
    if (fleet.agentInstances.kind !== 'read') throw new Error('agents not read');
    expect(new Set(fleet.agentInstances.rows.map((r) => r.id))).toEqual(
      new Set(Object.values(mine.agents)),
    );
    // Only the reader's own agent is flagged as theirs.
    expect(fleet.agentInstances.rows.filter((r) => r.ownedByViewer).map((r) => r.id)).toEqual([
      mine.agents.admin,
    ]);
    if (fleet.ciJobs.kind !== 'read') throw new Error('CI not read');
    expect(fleet.ciJobs.rows.map((r) => r.id).sort()).toEqual(Object.values(mine.intents).sort());
    expect(fleet.ciJobs.inFlight).toBe(1);
    expect(fleet.indexJobs).toEqual({ kind: 'read', running: 1 });
    // Motir's stops: the last 7 days only, newest first, time + kind + completed.
    if (fleet.motirStops.kind !== 'read') throw new Error('kills not read');
    expect(fleet.motirStops.entries).toEqual([
      {
        decidedAt: new Date(clock.now().getTime() - 2 * 60 * MIN).toISOString(),
        workload: 'ci_runner',
        reason: 'record_ended',
        completed: true,
      },
      {
        decidedAt: new Date(clock.now().getTime() - DAY).toISOString(),
        workload: 'ci_runner',
        reason: 'record_ended',
        completed: true,
      },
    ]);
    expectNoLeak(fleet, theirs);
    expect(await snapshot(theirs)).toBe(before);
  });

  it.each(pairs)('the route answers org %s’s own read, field by field', async (_, pick) => {
    const [mine, theirs] = pick();
    session.current = { user: { id: mine.admin.id } };
    const res = await GET(new Request('http://localhost/api'), {
      params: Promise.resolve({ orgId: mine.organizationId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fleet: { hostedRuns: { rows: { id: string }[] } } };
    expect(body.fleet.hostedRuns.rows.map((r) => r.id)).toEqual([mine.hostedRun]);
    expectNoLeak(body, theirs);
    // Addressing the OTHER org by its id is a 404, never its data.
    const cross = await GET(new Request('http://localhost/api'), {
      params: Promise.resolve({ orgId: theirs.organizationId }),
    });
    expect(cross.status).toBe(404);
  });
});

describe('the preview and Stop everything, both ways', () => {
  it.each(pairs)('org %s’s preview counts its own work only', async (_, pick) => {
    const [mine, theirs] = pick();
    const before = await snapshot(theirs);
    const preview = await orgFleetStopService.previewStopEverything(as(mine), now());
    expect(preview).toEqual({
      ciRuns: 1,
      ciContainers: 1,
      hostedRuns: 1,
      runningAgents: 3,
      indexContainers: 1,
    });
    expectNoLeak(preview, theirs);
    expect(await snapshot(theirs)).toBe(before);
  });

  it.each(pairs)(
    'org %s’s Stop everything stops its own work, leaves its index and the other org',
    async (_, pick) => {
      const [mine, theirs] = pick();
      const before = await snapshot(theirs);
      const result = await orgFleetStopService.stopEverything(as(mine), now);
      expect(result).toMatchObject({
        runsCancelled: 1,
        ciContainersStopped: 1,
        hostedRunsEnded: 1,
        agentsHibernated: 3,
        failures: { ci: 0, hosted: 0, agents: 0 },
        stoppedByName: mine.admin.name,
      });
      expect(liveRuns.get(`${MOTIR_ORG}/${mine.repo}`)).toEqual([]);
      expect(
        await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
          where: { id: mine.intents.inFlight },
        }),
      ).toMatchObject({ status: 'failed', teardownReason: 'org_admin_stop' });
      expect(fakeOrchestrator.teardowns.map((td) => td.handleId)).toHaveLength(1);
      expect(hostedRunService.endHostedRun).toHaveBeenCalledTimes(1);
      expect(hostedRunService.endHostedRun).toHaveBeenCalledWith(
        mine.hostedRun,
        'cancelled',
        expect.any(String),
      );
      const running = [mine.agents.owner, mine.agents.admin, mine.agents.member];
      for (const id of running) {
        expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
          'hibernated',
        );
      }
      const closed = (await intervals()).filter(
        (i) => running.includes(i.agentInstanceId) && i.endedAt,
      );
      expect(closed.map((i) => i.endReason)).toEqual([
        'org_admin_stop',
        'org_admin_stop',
        'org_admin_stop',
      ]);
      // The index container keeps running: Stop everything never stops it.
      expect(
        await adminDb.fleetInFlightSlot.count({
          where: { organizationId: mine.organizationId, workload: 'code_graph_index' },
        }),
      ).toBe(1);
      expectNoLeak(result, theirs);
      expect(await snapshot(theirs)).toBe(before);

      // A second call stops nothing.
      const again = await orgFleetStopService.stopEverything(as(mine), now);
      expect(again).toMatchObject({
        runsCancelled: 0,
        ciContainersStopped: 0,
        hostedRunsEnded: 0,
        agentsHibernated: 0,
      });
      // The read afterwards: the org's own after-state, still nothing of the other.
      const fleet = await orgFleetService.read(as(mine), now());
      expectNoLeak(fleet, theirs);
      if (fleet.lastStop.kind !== 'read') throw new Error('last stop not read');
      expect(fleet.lastStop.stop).toMatchObject({
        actorName: mine.admin.name,
        action: 'stop_everything',
      });
    },
  );
});

describe('Cancel and Hibernate address only the caller’s own org', () => {
  it('Cancel: another org’s live run, an ended run and an agent slot are not found', async () => {
    await slot(a.t, 'agent_instance', `agent-slot-${a.t.workspaceId}`);
    const before = await snapshot(b);
    for (const id of [b.hostedRun, a.endedRun, `agent-slot-${a.t.workspaceId}`]) {
      await expect(orgFleetStopService.cancelHostedRun(as(a), id, now())).rejects.toBeInstanceOf(
        OrgFleetRunNotFoundError,
      );
    }
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalled();
    expect(await snapshot(b)).toBe(before);
  });

  it('Hibernate: another org’s agent and a deleted one are not found', async () => {
    await adminDb.agentInstance.update({
      where: { id: a.agents.owner },
      data: { deletedAt: clock.now() },
    });
    const before = await snapshot(b);
    for (const id of [b.agents.member, a.agents.owner]) {
      await expect(orgFleetStopService.hibernateAgent(as(a), id, now)).rejects.toBeInstanceOf(
        OrgFleetInstanceNotFoundError,
      );
    }
    expect(await snapshot(b)).toBe(before);
  });

  it('Hibernate: a member’s running agent with org_admin_stop; a resting one and a starting one do not move', async () => {
    const before = await snapshot(b);
    const outcome = await orgFleetStopService.hibernateAgent(as(a), a.agents.member, now);
    expect(outcome).toMatchObject({
      kind: 'hibernated',
      instanceId: a.agents.member,
      ownerUserId: a.member.id,
      actorUserId: a.admin.id,
    });
    const closed = (await intervals()).filter(
      (i) => i.agentInstanceId === a.agents.member && i.endedAt,
    );
    expect(closed.map((i) => i.endReason)).toEqual(['org_admin_stop']);

    expect(await orgFleetStopService.hibernateAgent(as(a), a.agents.memberResting, now)).toEqual({
      kind: 'already_resting',
      instanceId: a.agents.memberResting,
    });
    await adminDb.agentInstance.update({
      where: { id: a.agents.owner },
      data: { state: 'starting' },
    });
    expect(await orgFleetStopService.hibernateAgent(as(a), a.agents.owner, now)).toEqual({
      kind: 'in_motion',
      instanceId: a.agents.owner,
    });
    expect(
      (await adminDb.agentInstance.findUniqueOrThrow({ where: { id: a.agents.owner } })).state,
    ).toBe('starting');
    expect(await snapshot(b)).toBe(before);
  });
});

describe('the page’s Server Actions', () => {
  it('each makes one service call, answers a discriminated result and touches nothing of B', async () => {
    session.current = { user: { id: a.admin.id } };
    const before = await snapshot(b);
    const calls = {
      cancel: vi.spyOn(orgFleetStopService, 'cancelHostedRun'),
      hibernate: vi.spyOn(orgFleetStopService, 'hibernateAgent'),
      preview: vi.spyOn(orgFleetStopService, 'previewStopEverything'),
      stop: vi.spyOn(orgFleetStopService, 'stopEverything'),
    };

    const answers = [
      await actions.cancelHostedRunAction(a.organizationId, b.hostedRun),
      await actions.hibernateAgentAction(a.organizationId, b.agents.member),
      await actions.cancelHostedRunAction(a.organizationId, a.hostedRun),
      await actions.hibernateAgentAction(a.organizationId, a.agents.member),
      await actions.hibernateAgentAction(a.organizationId, a.agents.memberResting),
      await actions.previewStopEverythingAction(a.organizationId),
      await actions.stopEverythingAction(a.organizationId),
    ];
    expect(answers.map((x) => (x.ok ? ('code' in x ? x.code : 'ok') : x.code))).toEqual([
      'notFound',
      'notFound',
      'ok',
      'hibernated',
      'alreadyResting',
      'ok',
      'ok',
    ]);
    expect(calls.cancel).toHaveBeenCalledTimes(2);
    expect(calls.hibernate).toHaveBeenCalledTimes(3);
    expect(calls.preview).toHaveBeenCalledTimes(1);
    expect(calls.stop).toHaveBeenCalledTimes(1);
    for (const answer of answers) expectNoLeak(answer, b);
    expect(await snapshot(b)).toBe(before);
  });
});

describe('who may — refused before any effect', () => {
  type Who = 'member' | 'stranger' | 'offCloud';
  const refusals: Array<[Who, string, number]> = [
    ['member', 'forbidden', 403],
    ['stranger', 'notFound', 404],
    ['offCloud', 'notFound', 404],
  ];

  it.each(refusals)(
    '%s: every door refuses (%s, route %i), nothing moves',
    async (who, code, status) => {
      let actorUserId = a.member.id;
      if (who === 'stranger') actorUserId = (await createTestUser({ name: 'Stranger' })).id;
      if (who === 'offCloud') {
        actorUserId = a.admin.id;
        vi.stubEnv('MOTIR_CLOUD', 'false');
      }
      session.current = { user: { id: actorUserId } };
      const beforeA = await snapshot(a);
      const beforeB = await snapshot(b);
      const begin = vi.spyOn(lifecycle, 'beginHibernate');
      const errorName = {
        member: 'BillingForbiddenError',
        stranger: 'OrganizationNotFoundError',
        offCloud: 'BillingNotAvailableError',
      }[who];

      const input = { organizationId: a.organizationId, actorUserId };
      await expect(orgFleetService.read(input, now())).rejects.toMatchObject({ name: errorName });
      await expect(orgFleetStopService.previewStopEverything(input, now())).rejects.toMatchObject({
        name: errorName,
      });
      await expect(orgFleetStopService.stopEverything(input, now)).rejects.toMatchObject({
        name: errorName,
      });
      await expect(
        orgFleetStopService.cancelHostedRun(input, a.hostedRun, now()),
      ).rejects.toMatchObject({ name: errorName });
      await expect(
        orgFleetStopService.hibernateAgent(input, a.agents.member, now),
      ).rejects.toMatchObject({ name: errorName });

      for (const answer of [
        await actions.cancelHostedRunAction(a.organizationId, a.hostedRun),
        await actions.hibernateAgentAction(a.organizationId, a.agents.member),
        await actions.previewStopEverythingAction(a.organizationId),
        await actions.stopEverythingAction(a.organizationId),
      ]) {
        expect(answer).toEqual({ ok: false, code });
      }
      const res = await GET(new Request('http://localhost/api'), {
        params: Promise.resolve({ orgId: a.organizationId }),
      });
      expect(res.status).toBe(status);

      expect(githubCalls).toEqual([]);
      expect(fakeOrchestrator.teardowns).toEqual([]);
      expect(hostedRunService.endHostedRun).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
      expect(await snapshot(a)).toBe(beforeA);
      expect(await snapshot(b)).toBe(beforeB);
    },
  );
});

describe('the owner is told — and only the owner', () => {
  it('Hibernate tells the agent’s owner once, naming the admin; nobody else hears', async () => {
    await orgFleetStopService.hibernateAgent(as(a), a.agents.member, now);
    const rows = await notifications();
    expect(rows.map((r) => [r.recipientUserId, r.actorId])).toEqual([[a.member.id, a.admin.id]]);
    const dto = toNotificationDto(
      rows[0]!,
      new Map([[a.admin.id, { name: a.admin.name }]]) as never,
    );
    expectNoLeak(rows[0]!.data, b);
    expectNoLeak(dto, b);
  });

  it('Stop everything tells each other owner once; the admin’s own agent tells nobody', async () => {
    await orgFleetStopService.stopEverything(as(a), now);
    const rows = await notifications();
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([a.t.ownerId, a.member.id].sort());
    for (const row of rows) {
      expect(row.actorId).toBe(a.admin.id);
      expectNoLeak(row.data, b);
    }
    const reached = new Set(rows.map((r) => r.recipientUserId));
    for (const id of [a.admin.id, b.t.ownerId, b.admin.id, b.member.id]) {
      expect(reached.has(id)).toBe(false);
    }
  });
});

describe('the platform card', () => {
  async function principal(role: PlatformRole): Promise<PlatformPrincipal> {
    const user = await createTestUser({ email: `ops+gate${seq++}@moooon.net` });
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
    return { userId: user.id, email: user.email, role };
  }

  it('reads only A’s org-admin stop, and the platform stop still records admin_stop', async () => {
    await orgFleetStopService.stopEverything(as(a), now);
    currentPrincipal = await principal('support');
    const forA = await platformFleetStopService.lastOrgAdminStop(
      currentPrincipal,
      a.organizationId,
    );
    expect(forA).toMatchObject({ at: clock.now().toISOString(), ciContainersStopped: 1 });
    expectNoLeak(forA, b);
    expect(
      await platformFleetStopService.lastOrgAdminStop(currentPrincipal, b.organizationId),
    ).toBeNull();

    // The platform's own stop of B: admin_stop, which the org-admin read ignores.
    currentPrincipal = await principal('superadmin');
    clock.advance(MIN);
    await platformFleetStopService.stop(currentPrincipal, b.organizationId, 'Runaway spend', now());
    expect(
      await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: b.intents.inFlight },
      }),
    ).toMatchObject({ teardownReason: 'admin_stop' });
    expect(
      await platformFleetStopService.lastOrgAdminStop(currentPrincipal, b.organizationId),
    ).toBeNull();
    expect(
      await platformFleetStopService.lastOrgAdminStop(currentPrincipal, a.organizationId),
    ).toEqual(forA);
  });
});
