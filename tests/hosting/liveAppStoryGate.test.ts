// MOTIR-12111 — the story gate for a live Motir-hosted app (Story MOTIR-9799).
//
// One integration suite that runs the story's seams TOGETHER, through the
// shipped writers into the shipped readers, on real Postgres: the deploy port's
// fake (`MOTIR_FLEET_ORCHESTRATOR=fake`) and the fake database port are the only
// stand-ins for a target. Each case starts from a real application and release
// row made by `productionReleaseService.deployProductionRelease`, acts through
// the production routes as an administrator, a plain member or nobody, runs the
// prober and the accrual through their job definitions and services, and reads
// the answer back through the routes.
//
// The only mocks are the ones the house rules allow: the session
// (`getWorkspaceContext`, the seam every route's `getSession()` resolves
// through), and motir-ai at `fetch` with recorded bodies, so a debit is the
// exact outgoing body. Two boundary stubs are inherited from every production
// test and are not between the seams: the manifest read (GitHub) and the
// release-status post (a queued GitHub write).
//
// Every case advances the fake's clock or passes the service a clock; nothing
// sleeps.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls, HostingDeployPort, ReleaseUsage } from '@motir/orchestrator';
import { db } from '@/lib/db';
import type { HostingManifest } from '@/lib/hosting/manifest';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { JobTestEngine } from '../helpers/jobs';

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const ROUTES = '@/app/api/projects/[key]/repositories/[rowId]/production';
const { POST: ROLLBACK } = await import(`${ROUTES}/rollback/route`);
const { GET: GET_LOGS } = await import(`${ROUTES}/logs/route`);
const { GET: GET_HEALTH } = await import(`${ROUTES}/health/route`);
const { GET: GET_IDLE, PUT: PUT_IDLE } = await import(`${ROUTES}/idle-policy/route`);
const { GET: GET_USAGE } = await import(`${ROUTES}/usage/route`);
const { getHostingDeployPort, resetHostingFakes } = await import('@/lib/orchestrator/hosting');
const { resetDatabaseFakes } = await import('@/lib/orchestrator/database');
const { LOG_SECRET_MASK } = await import('@/lib/hosting/logMasking');
const { productionHealthProbe } = await import('@/lib/jobs/definitions/productionHealthProbe');
const { productionUsageAccrual } = await import('@/lib/jobs/definitions/productionUsageAccrual');
const { environmentConfigService } = await import('@/lib/services/environmentConfigService');
const { hostedRepositoryAccessService } =
  await import('@/lib/services/hostedRepositoryAccessService');
const { productionLogsService } = await import('@/lib/services/productionLogsService');
const { productionReleaseService } = await import('@/lib/services/productionReleaseService');
const { productionUsageMeterService: meter } =
  await import('@/lib/services/productionUsageMeterService');
const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');
const { releaseDeploymentStatusService } =
  await import('@/lib/services/releaseDeploymentStatusService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { addToProjectAs } = await import('../helpers/workspaceRoleFixtures');

const KEY = 'cd'.repeat(32);
const SECRET = 'sk_live_story_gate_7781';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'none' },
};

interface DebitBody {
  coreOrganizationId: string;
  applicationId: string;
  day: string;
  credits: number;
}
let debits: DebitBody[];

function hosting() {
  return getHostingDeployPort('fly') as HostingDeployPort & FakeHostingControls;
}

/** motir-ai at `fetch`: the balance read and the hosting debit, bodies recorded. */
function stubMotirAi(): void {
  let balance = 10_000;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const u = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (u.includes('/v1/usage')) return json({ balance });
      if (u.includes('/v1/credits/hosting-production')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as DebitBody;
        debits.push(body);
        balance -= body.credits;
        return json({
          transactionId: `tx_${debits.length}`,
          aiOrganizationId: 'ai_org',
          credits: -body.credits,
          balanceAfter: balance,
          exhausted: balance <= 0,
          idempotent: false,
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  debits = [];
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  resetHostingFakes();
  resetDatabaseFakes();
  stubMotirAi();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.spyOn(releaseDeploymentStatusService, 'enqueueReleaseStatusPost').mockResolvedValue();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Project {
  fx: WorkItemFixture;
  memberId: string;
  asAdmin: () => void;
  asMember: () => void;
}

async function project(identifier = 'ACME'): Promise<Project> {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const member = await usersService.createUser({
    email: `member-${identifier.toLowerCase()}@gate.test`,
    password: 'hunter2hunter2',
    name: 'Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: member.id,
    role: 'member',
  });
  return {
    fx,
    memberId: member.id,
    asAdmin: () => (ctxRef.current = fx.ctx),
    asMember: () => (ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId }),
  };
}

async function repo(
  fx: WorkItemFixture,
  role: 'web' | 'api' = 'web',
  seedSource = 'initialised',
): Promise<string> {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role, name: `repo-${role}` },
    fx.ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { seedSource, state: 'created', hostingTarget: 'fly' },
  });
  return row.id;
}

interface Live {
  appRef: string;
  applicationId: string;
  releaseId: string;
  artifactRef: string;
  liveAt: Date;
  organizationId: string;
}

/** Release `n` of the repository, made live by the shipped production deploy. */
async function goLive(projectRepositoryId: string, n = 1): Promise<Live> {
  const artifactRef = `registry.fly.io/gate-${projectRepositoryId}:${sha(n)}`;
  const release = await productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha: sha(n),
    artifactRef,
    cause: 'merge',
  });
  expect(release.state).toBe('live');
  const app = await adminDb.hostedApplication.update({
    where: { projectRepositoryId },
    data: { productionAddress: `gate-${projectRepositoryId}--acme.motir.site` },
    include: { workspace: true },
  });
  const { appRef } = await hosting().ensureApp({
    repositoryId: projectRepositoryId,
    environment: { kind: 'production' },
  });
  return {
    appRef,
    applicationId: app.id,
    releaseId: release.id,
    artifactRef,
    liveAt: release.liveAt ? new Date(release.liveAt) : new Date(),
    organizationId: app.workspace.organizationId,
  };
}

// ── The routes ───────────────────────────────────────────────────────────────

const params = (key: string, rowId: string) => ({ params: Promise.resolve({ key, rowId }) });
const at = (key: string, rowId: string, path: string) =>
  `http://localhost:3000/api/projects/${key}/repositories/${rowId}/production${path}`;
const readLogs = (key: string, rowId: string) =>
  GET_LOGS(new Request(at(key, rowId, '/logs')), params(key, rowId)) as Promise<Response>;
const readHealth = (key: string, rowId: string) =>
  GET_HEALTH(new Request(at(key, rowId, '/health')), params(key, rowId)) as Promise<Response>;
const readIdle = (key: string, rowId: string) =>
  GET_IDLE(new Request(at(key, rowId, '/idle-policy')), params(key, rowId)) as Promise<Response>;
const readUsage = (key: string, rowId: string) =>
  GET_USAGE(new Request(at(key, rowId, '/usage')), params(key, rowId)) as Promise<Response>;
const putIdle = (key: string, rowId: string, body: unknown) =>
  PUT_IDLE(
    new Request(at(key, rowId, '/idle-policy'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(key, rowId),
  ) as Promise<Response>;
const rollback = (key: string, rowId: string) =>
  ROLLBACK(
    new Request(at(key, rowId, '/rollback'), { method: 'POST' }),
    params(key, rowId),
  ) as Promise<Response>;

const probeJob = () => new JobTestEngine({ function: productionHealthProbe }).execute();
const accrualJob = () => new JobTestEngine({ function: productionUsageAccrual }).execute();

const events = (applicationId: string) =>
  adminDb.hostedApplicationEvent.findMany({
    where: { applicationId },
    orderBy: { occurredAt: 'asc' },
  });
const crashNotifications = () =>
  adminDb.notification.findMany({ where: { type: 'production_app_crashed' } });
const slices = (applicationId: string) =>
  adminDb.productionUsageSlice.findMany({ where: { applicationId }, orderBy: { unit: 'asc' } });

/** `usageSince` answering `seconds` of running time up to `until` for every window. */
function releaseUsage(until: Date, seconds = 3600) {
  return vi.spyOn(hosting(), 'usageSince').mockImplementation(
    async (handle, since): Promise<ReleaseUsage> => ({
      target: handle.target,
      appRef: handle.appRef,
      releaseId: handle.releaseId,
      since,
      until,
      runningSeconds: seconds,
    }),
  );
}

/**
 * Move an application's slices into a UTC day that has ended. The windows end
 * an hour after the release went live, so after 23:00 UTC that end is
 * tomorrow, and one day back would still be today; a day and an hour back
 * always lands before the start of today.
 */
const INTO_ENDED_DAY = DAY + HOUR;

async function intoYesterday(applicationId: string): Promise<void> {
  await adminDb.$executeRaw`
    UPDATE "production_usage_slice"
       SET "slice_start" = "slice_start" - (${INTO_ENDED_DAY} * INTERVAL '1 millisecond'),
           "slice_end" = "slice_end" - (${INTO_ENDED_DAY} * INTERVAL '1 millisecond'),
           "charge_day" = date_trunc('day', ("slice_end" - (${INTO_ENDED_DAY} * INTERVAL '1 millisecond')) - INTERVAL '1 millisecond')
     WHERE "application_id" = ${applicationId}`;
}

// ── Logs ─────────────────────────────────────────────────────────────────────

describe('logs', () => {
  it('returns a line carrying a production secret masked, through the route and the service', async () => {
    const p = await project();
    const id = await repo(p.fx);
    await environmentConfigService.set(
      id,
      'production',
      { name: 'API_SECRET', value: SECRET, isSecret: true },
      p.fx.ctx,
    );
    const live = await goLive(id);
    hosting().appendLogLines(live.appRef, [
      { at: hosting().now(), stream: 'app', message: `charging with ${SECRET}` },
    ]);
    p.asMember();

    const res = await readLogs('ACME', id);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('ok');
    expect(body.lines.map((l: { message: string }) => l.message)).toContain(
      `charging with ${LOG_SECRET_MASK}`,
    );
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const direct = await productionLogsService.readMaskedLines(
      { workspaceId: p.fx.workspaceId, projectRepositoryId: id },
      { limit: 100 },
    );
    expect(direct.lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(direct)).not.toContain(SECRET);
  });

  it('answers the named unavailable state, never a 500, when the target cannot read logs', async () => {
    const p = await project();
    const id = await repo(p.fx);
    const live = await goLive(id);
    hosting().setLogsUnavailable(live.appRef, 'log drain offline');
    p.asMember();

    const res = await readLogs('ACME', id);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'unavailable', lines: [] });
  });

  it('answers each read’s empty state before a first release, reading no logs', async () => {
    const p = await project();
    const id = await repo(p.fx);
    p.asMember();

    expect(await (await readLogs('ACME', id)).json()).toMatchObject({
      state: 'no_release',
      lines: [],
    });
    expect((await readHealth('ACME', id)).status).toBe(200);
    expect(await (await readUsage('ACME', id)).json()).toMatchObject({
      state: 'no_release',
      usage: [],
    });
    expect(hosting().calls.filter((c) => c.operation === 'readLogs')).toEqual([]);
  });
});

// ── Health and crashes ───────────────────────────────────────────────────────

describe('health and crashes', () => {
  it('records ONE crash with its masked last lines, notifies administrators once, on a re-run too', async () => {
    const p = await project();
    const id = await repo(p.fx);
    await environmentConfigService.set(
      id,
      'production',
      { name: 'API_SECRET', value: SECRET, isSecret: true },
      p.fx.ctx,
    );
    const live = await goLive(id);
    await probeJob();
    hosting().appendLogLines(live.appRef, [
      { at: hosting().now(), stream: 'app', message: `fatal: bad key ${SECRET}` },
    ]);
    hosting().setRuntimeState(live.appRef, { state: 'exited', exitCode: 1 });

    await probeJob();
    hosting().advanceSeconds(60);
    await probeJob();

    p.asMember();
    const health = await (await readHealth('ACME', id)).json();
    expect(health.state).toBe('crashed');
    const written = await events(live.applicationId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: 'crashed', reason: 'exit code 1' });
    expect(health.since).toBe(written[0]!.occurredAt.toISOString());
    const lines = JSON.stringify(written[0]!.lastLogLines);
    expect(lines).toContain(LOG_SECRET_MASK);
    expect(lines).not.toContain(SECRET);
    const notified = await crashNotifications();
    expect(notified.map((n) => n.recipientUserId)).toEqual([p.fx.ownerId]);
    expect(notified.map((n) => n.recipientUserId)).not.toContain(p.memberId);
  });

  it('reads out of memory as a crash, and a failing health check as unhealthy', async () => {
    const p = await project();
    const oom = await goLive(await repo(p.fx, 'web'));
    const failing = await goLive(await repo(p.fx, 'api'));
    await probeJob();
    hosting().setRuntimeState(oom.appRef, { state: 'oom_killed' });
    hosting().setHealth(failing.appRef, 'unhealthy');

    await probeJob();
    await probeJob();

    expect(await events(oom.applicationId)).toMatchObject([
      { kind: 'crashed', reason: 'out of memory' },
    ]);
    expect(await events(failing.applicationId)).toMatchObject([
      { kind: 'health_check_failed', reason: 'HTTP 503' },
    ]);
    const states = await adminDb.hostedApplicationHealth.findMany({
      where: { applicationId: { in: [oom.applicationId, failing.applicationId] } },
    });
    expect(Object.fromEntries(states.map((s) => [s.applicationId, s.state]))).toEqual({
      [oom.applicationId]: 'crashed',
      [failing.applicationId]: 'unhealthy',
    });
  });

  it('reads healthy again after Roll back, and keeps the crash event', async () => {
    const p = await project();
    const id = await repo(p.fx);
    await goLive(id, 1);
    const second = await goLive(id, 2);
    await probeJob();
    hosting().setRuntimeState(second.appRef, { state: 'exited', exitCode: 1 });
    await probeJob();
    p.asMember();
    const crashed = await (await readHealth('ACME', id)).json();
    expect(crashed.state).toBe('crashed');

    p.asAdmin();
    expect((await rollback('ACME', id)).status).toBe(200);
    hosting().setRuntimeState(second.appRef, null);
    hosting().advanceSeconds(60);
    await probeJob();

    const healthy = await (await readHealth('ACME', id)).json();
    expect(healthy.state).toBe('healthy');
    expect(healthy.since).not.toBe(crashed.since);
    expect(await events(second.applicationId)).toHaveLength(1);
  });
});

// ── Idle policy ──────────────────────────────────────────────────────────────

describe('idle policy', () => {
  it('starts a new application on suspend, and deploys it so', async () => {
    const deploy = vi.spyOn(hosting(), 'deploy');
    const p = await project();
    const id = await repo(p.fx);
    await goLive(id);
    p.asMember();

    expect(await (await readIdle('ACME', id)).json()).toMatchObject({
      policy: { mode: 'suspend' },
      editable: false,
    });
    expect(deploy.mock.calls.at(-1)![0]).toMatchObject({ idle: { mode: 'suspend' } });
  });

  it('switches to always on by redeploying the current artifact, with no build', async () => {
    const p = await project();
    const id = await repo(p.fx);
    const live = await goLive(id);
    const deploy = vi.spyOn(hosting(), 'deploy');
    const before = hosting().calls.length;
    p.asAdmin();

    const res = await putIdle('ACME', id, { mode: 'always_on' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ policy: { mode: 'always_on' }, editable: true });
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(deploy.mock.calls[0]![0]).toMatchObject({
      artifact: { kind: 'image', ref: live.artifactRef },
      idle: { mode: 'always_on' },
    });
    const added = hosting()
      .calls.slice(before)
      .map((c) => c.operation);
    expect(added.filter((o) => o === 'deploy')).toHaveLength(1);
    expect(added.some((o) => /build/i.test(o))).toBe(false);
  });

  it('keeps the stored policy and answers the refusal when the target cannot run it', async () => {
    const p = await project();
    const id = await repo(p.fx);
    await adminDb.projectRepo.update({
      where: { id },
      data: { hostingTarget: 'aws', hostingShape: 'container' },
    });
    await productionReleaseService.deployProductionRelease({
      projectRepositoryId: id,
      commitSha: sha(1),
      artifactRef: `registry.example/gate:${sha(1)}`,
      cause: 'merge',
    });
    p.asAdmin();

    const res = await putIdle('ACME', id, { mode: 'suspend' });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('HOSTING_IDLE_POLICY_UNSUPPORTED');
    expect(await (await readIdle('ACME', id)).json()).toMatchObject({
      policy: { mode: 'always_on' },
      refusal: { code: 'HOSTING_IDLE_POLICY_UNSUPPORTED', target: 'aws', mode: 'suspend' },
    });
  });

  it('refuses a plain member’s change, deploying nothing', async () => {
    const p = await project();
    const id = await repo(p.fx);
    await goLive(id);
    const before = hosting().calls.length;
    p.asMember();

    const res = await putIdle('ACME', id, { mode: 'always_on' });

    expect(res.status).toBe(403);
    expect(hosting().calls.length).toBe(before);
    expect(await (await readIdle('ACME', id)).json()).toMatchObject({
      policy: { mode: 'suspend' },
      editable: false,
    });
  });
});

// ── Accrual ──────────────────────────────────────────────────────────────────

describe('accrual and charge', () => {
  it('slices a window once, records Motir’s cost, and debits a day once — a replay charges nothing', async () => {
    const p = await project();
    const id = await repo(p.fx);
    const live = await goLive(id);
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);

    await meter.accrue({ now: () => until });
    await meter.accrue({ now: () => until });

    const written = await slices(live.applicationId);
    expect(written).toHaveLength(1);
    expect(written[0]!.motirCostUsd.toNumber()).toBeGreaterThan(0);
    expect(written[0]!.idempotencyKey).toContain(live.applicationId);

    await intoYesterday(live.applicationId);
    const target = {
      id: live.applicationId,
      workspaceId: p.fx.workspaceId,
      organizationId: live.organizationId,
    };
    await meter.chargeEndedDays(target, new Date());
    await meter.chargeEndedDays(target, new Date());

    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      coreOrganizationId: live.organizationId,
      applicationId: live.applicationId,
      credits: Math.ceil(written[0]!.credits.toNumber()),
    });
    expect(await slices(live.applicationId)).toHaveLength(1);
  });

  it('runs through the hourly job', async () => {
    const p = await project();
    const live = await goLive(await repo(p.fx));
    releaseUsage(new Date(live.liveAt.getTime() + HOUR));

    const outcome = await accrualJob();

    expect(outcome.result).toMatchObject({ applications: 1, slices: 1, failed: 0 });
  });

  it('still debits an internal organisation, so motir-ai offsets it', async () => {
    const p = await project();
    const id = await repo(p.fx);
    const live = await goLive(id);
    await adminDb.organization.update({
      where: { id: live.organizationId },
      data: { internalBilling: true },
    });
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });
    await intoYesterday(live.applicationId);

    await meter.chargeEndedDays(
      {
        id: live.applicationId,
        workspaceId: p.fx.workspaceId,
        organizationId: live.organizationId,
      },
      new Date(),
    );

    expect(debits).toMatchObject([{ coreOrganizationId: live.organizationId }]);
  });

  it('writes nothing for an AWS application whose tenant account is not ready', async () => {
    const p = await project();
    const live = await goLive(await repo(p.fx));
    await adminDb.hostedApplication.update({
      where: { id: live.applicationId },
      data: { target: 'aws' },
    });
    const usageSince = vi.spyOn(getHostingDeployPort('aws'), 'usageSince');

    expect((await meter.accrue()).slices).toBe(0);
    expect(usageSince).not.toHaveBeenCalled();
    expect(await slices(live.applicationId)).toEqual([]);
    expect(debits).toEqual([]);
  });

  it('answers two applications in one project only their own usage', async () => {
    const p = await project();
    const web = await repo(p.fx, 'web');
    const api = await repo(p.fx, 'api');
    const a = await goLive(web);
    const b = await goLive(api);
    const until = new Date(Math.max(a.liveAt.getTime(), b.liveAt.getTime()) + HOUR);
    vi.spyOn(hosting(), 'usageSince').mockImplementation(
      async (handle, since): Promise<ReleaseUsage> => ({
        target: handle.target,
        appRef: handle.appRef,
        releaseId: handle.releaseId,
        since,
        until,
        runningSeconds: handle.appRef === a.appRef ? 3600 : 1800,
      }),
    );
    await meter.accrue({ now: () => until });
    p.asMember();

    const usageA = await (await readUsage('ACME', web)).json();
    const usageB = await (await readUsage('ACME', api)).json();

    expect(usageA.usage.map((u: { quantity: number }) => u.quantity)).toEqual([3600]);
    expect(usageB.usage.map((u: { quantity: number }) => u.quantity)).toEqual([1800]);
  });
});

// ── Guards ───────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('gives a customer repository no logs, health, policy change or charge, and leaves the project row alone', async () => {
    const p = await project();
    const ours = await repo(p.fx, 'web');
    const customer = await repo(p.fx, 'api', 'organization');
    const live = await goLive(ours);
    const projectBefore = await adminDb.project.findUniqueOrThrow({
      where: { id: p.fx.projectId },
    });
    const callsBefore = hosting().calls.length;
    p.asAdmin();

    for (const res of [
      await readLogs('ACME', customer),
      await readHealth('ACME', customer),
      await readIdle('ACME', customer),
      await putIdle('ACME', customer, { mode: 'always_on' }),
      await readUsage('ACME', customer),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(hosting().calls.length).toBe(callsBefore);

    hosting().setRuntimeState(live.appRef, { state: 'exited', exitCode: 1 });
    await probeJob();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });

    expect(
      await adminDb.hostedApplication.count({ where: { projectRepositoryId: customer } }),
    ).toBe(0);
    expect(await adminDb.hostedApplicationHealth.count()).toBe(1);
    expect(await adminDb.hostedApplicationEvent.count()).toBe(1);
    expect(await adminDb.productionUsageSlice.count()).toBe(1);
    expect(
      hosting()
        .calls.slice(callsBefore)
        .every((c) => c.appRef === null || c.appRef === live.appRef),
    ).toBe(true);
    // No health or usage signal writes the project, its phase included.
    expect(await adminDb.project.findUniqueOrThrow({ where: { id: p.fx.projectId } })).toEqual(
      projectBefore,
    );
  });

  it('shows another workspace none of the health, crash or slice rows', async () => {
    const p = await project('ACME');
    const live = await goLive(await repo(p.fx));
    hosting().setRuntimeState(live.appRef, { state: 'exited', exitCode: 1 });
    await probeJob();
    const until = new Date(live.liveAt.getTime() + HOUR);
    releaseUsage(until);
    await meter.accrue({ now: () => until });
    const other = await project('OTHR');

    const seenAs = (workspaceId: string) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return [
          await tx.hostedApplicationHealth.count(),
          await tx.hostedApplicationEvent.count(),
          await tx.productionUsageSlice.count(),
        ];
      });

    expect(await seenAs(other.fx.workspaceId)).toEqual([0, 0, 0]);
    expect(await seenAs(p.fx.workspaceId)).toEqual([1, 1, 1]);
  });
});
