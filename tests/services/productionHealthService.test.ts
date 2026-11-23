// MOTIR-12106 — a live app's health and its crash events, against real Postgres
// and the deploy port's fake. One prober run moves an exited app to `crashed`;
// two failed probes make one `unhealthy`; `since` holds while a state does; a
// suspended app is never probed; a restarted-from exit is recorded once; each
// event carries the release's last lines MASKED (or `[]` when the logs cannot be
// read) and notifies every project administrator exactly once, retried or run
// concurrently; a customer repository is never probed; the rows are
// workspace-scoped; and the probe's lane seam is off outside the fake.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { OrchestratorApiError, RuntimeHealthUnavailableError } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { LOG_SECRET_MASK } from '@/lib/hosting/logMasking';
import { probeHealthCheck } from '@/lib/hosting/healthProbe';
import {
  PRODUCTION_HEALTH_PROBE_CRON,
  productionHealthProbe,
} from '@/lib/jobs/definitions/productionHealthProbe';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { hostedApplicationHealthRepository } from '@/lib/repositories/hostedApplicationHealthRepository';
import { hostedApplicationRepository } from '@/lib/repositories/hostedApplicationRepository';
import { productionLogsService } from '@/lib/services/productionLogsService';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { environmentConfigService } from '@/lib/services/environmentConfigService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import {
  productionHealthService as health,
  type ProbeApplicationOutcome,
} from '@/lib/services/productionHealthService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { releaseDeploymentStatusService } from '@/lib/services/releaseDeploymentStatusService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

const KEY = 'cd'.repeat(32);
const SECRET = 'sk_live_crash_secret_99';
const TYPE = 'production_app_crashed';
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

let logged: string[];

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  resetHostingFakes();
  resetDatabaseFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.spyOn(releaseDeploymentStatusService, 'enqueueReleaseStatusPost').mockResolvedValue();
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function repo(fx: WorkItemFixture, seedSource = 'initialised', role: 'web' | 'api' = 'web') {
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

/** A live release with a production address, and its app ref and application. */
async function live(projectRepositoryId: string) {
  const release = await productionReleaseService.deployProductionRelease({
    projectRepositoryId,
    commitSha: sha(1),
    artifactRef: `registry.fly.io/x:${sha(1)}`,
    cause: 'merge',
  });
  expect(release.state).toBe('live');
  const app = await adminDb.hostedApplication.update({
    where: { projectRepositoryId },
    data: { productionAddress: `shop-${projectRepositoryId}--acme.motir.site` },
  });
  const { appRef } = await hosting().ensureApp({
    repositoryId: projectRepositoryId,
    environment: { kind: 'production' },
  });
  return { appRef, applicationId: app.id, releaseId: release.id };
}

async function setup() {
  const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const member = await usersService.createUser({
    email: 'member@health.test',
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
  const id = await repo(fx);
  return { fx, memberId: member.id, id };
}

const healthRow = (applicationId: string) =>
  adminDb.hostedApplicationHealth.findUnique({ where: { applicationId } });
const events = (applicationId: string) =>
  adminDb.hostedApplicationEvent.findMany({
    where: { applicationId },
    orderBy: { occurredAt: 'asc' },
  });
const notifications = () =>
  adminDb.notification.findMany({ where: { type: TYPE }, orderBy: { createdAt: 'asc' } });

/** Count the probes the lane seam answers (it reads the fake store's app). */
function countProbes(): () => number {
  const spy = vi.spyOn(hosting(), 'app');
  return () => spy.mock.calls.length;
}

describe('probeApplication — the state', () => {
  it('reads healthy for a running app whose check passes', async () => {
    const { id } = await setup();
    const { applicationId } = await live(id);
    expect(await health.probeApplication(applicationId)).toEqual({
      outcome: 'probed',
      state: 'healthy',
      events: 0,
    });
    expect(await healthRow(applicationId)).toMatchObject({
      state: 'healthy',
      condition: null,
      consecutiveProbeFailures: 0,
      healthCheckPath: '/api/health',
    });
  });

  it('reads crashed after ONE run on an exit, and since holds on the next', async () => {
    const { id } = await setup();
    const { appRef, applicationId, releaseId } = await live(id);
    await health.probeApplication(applicationId);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 3 });

    await health.probeApplication(applicationId);
    const first = await healthRow(applicationId);
    expect(first!.state).toBe('crashed');
    expect(first!.since).toEqual(hosting().now());

    hosting().advanceSeconds(60);
    await health.probeApplication(applicationId);
    expect((await healthRow(applicationId))!.since).toEqual(first!.since);

    const written = await events(applicationId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: 'crashed',
      reason: 'exit code 3',
      exitCode: 3,
      releaseId,
      occurredAt: first!.since,
    });
  });

  it('reads crashed with reason out of memory on a memory kill', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().setRuntimeState(appRef, { state: 'oom_killed' });
    await health.probeApplication(applicationId);
    expect((await events(applicationId))[0]).toMatchObject({
      reason: 'out of memory',
      exitCode: null,
    });
  });

  it('reads unhealthy after TWO failed checks, since the second', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    await health.probeApplication(applicationId);
    hosting().setHealth(appRef, 'unhealthy');

    await health.probeApplication(applicationId);
    expect(await healthRow(applicationId)).toMatchObject({
      state: 'healthy',
      consecutiveProbeFailures: 1,
    });
    const now = new Date();
    await health.probeApplication(applicationId, { now: () => now });
    expect(await healthRow(applicationId)).toMatchObject({
      state: 'unhealthy',
      since: now,
      consecutiveProbeFailures: 2,
    });
    expect(await events(applicationId)).toMatchObject([
      { kind: 'health_check_failed', reason: 'HTTP 503' },
    ]);
  });

  it('never probes a suspended app, and reads suspended', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().idleStop(appRef);
    const probes = countProbes();
    await health.probeApplication(applicationId);
    expect(probes()).toBe(0);
    expect((await healthRow(applicationId))!.state).toBe('suspended');
  });

  it('lets the probe alone decide when the runtime cannot be read', async () => {
    const { id } = await setup();
    const { applicationId } = await live(id);
    vi.spyOn(hosting(), 'readHealth').mockRejectedValue(
      new RuntimeHealthUnavailableError('fly', 'down'),
    );
    const probes = countProbes();
    await health.probeApplication(applicationId);
    expect(probes()).toBe(1);
    expect((await healthRow(applicationId))!.state).toBe('healthy');
  });

  it('reads deploying for a current release that is not live, without the port', async () => {
    const { id } = await setup();
    const { applicationId, releaseId } = await live(id);
    await adminDb.hostedRelease.update({ where: { id: releaseId }, data: { state: 'failed' } });
    const readHealth = vi.spyOn(hosting(), 'readHealth');
    await health.probeApplication(applicationId);
    expect(readHealth).not.toHaveBeenCalled();
    expect((await healthRow(applicationId))!.state).toBe('deploying');
  });

  it('reads deploying when the release has no handle, or the target holds none', async () => {
    const { id } = await setup();
    const { appRef, applicationId, releaseId } = await live(id);
    await adminDb.hostedRelease.update({ where: { id: releaseId }, data: { providerRef: null } });
    await health.probeApplication(applicationId);
    expect((await healthRow(applicationId))!.state).toBe('deploying');
    await adminDb.hostedRelease.update({
      where: { id: releaseId },
      data: { providerRef: 'restored' },
    });
    await hosting().destroyApp({ appRef });
    await health.probeApplication(applicationId);
    expect((await healthRow(applicationId))!.state).toBe('deploying');
  });

  it('reads the manifest once per release, and skips the probe when it cannot', async () => {
    const { id } = await setup();
    const { applicationId } = await live(id);
    const read = vi.mocked(hostedRepositoryAccessService.readManifestAt);
    read.mockClear();
    await health.probeApplication(applicationId);
    await health.probeApplication(applicationId);
    expect(read).toHaveBeenCalledTimes(1);

    await adminDb.hostedApplicationHealth.update({
      where: { applicationId },
      data: { probedReleaseId: null },
    });
    read.mockRejectedValueOnce(new Error('postgres://u:hunter2@db unreachable'));
    const probes = countProbes();
    await health.probeApplication(applicationId);
    expect(probes()).toBe(0);
    expect((await healthRow(applicationId))!.healthCheckPath).toBeNull();
    expect(logged.join('\n')).not.toMatch(/hunter2|postgres/);
  });

  it('counts a failed read as a failure and changes nothing', async () => {
    const { id } = await setup();
    const { applicationId } = await live(id);
    await health.probeApplication(applicationId);
    const before = await healthRow(applicationId);
    vi.spyOn(hosting(), 'readHealth').mockRejectedValueOnce(new TypeError('secret words'));
    expect(await health.probeApplication(applicationId)).toEqual({ outcome: 'failed' });
    expect(await healthRow(applicationId)).toEqual(before);
    expect(logged.join('\n')).not.toContain('secret words');
  });

  it('logs a failure as facts only: a provider status and a code, never a message', async () => {
    const { id } = await setup();
    const { applicationId } = await live(id);
    vi.spyOn(hosting(), 'readHealth').mockRejectedValueOnce(
      new OrchestratorApiError('fly', 502, 'secret detail'),
    );
    expect(await health.probeApplication(applicationId)).toEqual({ outcome: 'failed' });
    const line = logged.find((l) => l.includes('could not probe an application'))!;
    expect(line).toContain('"error":"OrchestratorApiError"');
    expect(line).toContain('"status":502');
    expect(line).toContain('"code":"ORCHESTRATOR_API_FAILED"');
    expect(logged.join('\n')).not.toContain('secret detail');

    logged.length = 0;
    vi.spyOn(hosting(), 'readHealth').mockRejectedValueOnce({ code: 'not a code!', x: 'secret' });
    expect(await health.probeApplication(applicationId)).toEqual({ outcome: 'failed' });
    const bare = logged.find((l) => l.includes('could not probe an application'))!;
    expect(bare).toContain('"error":"UNKNOWN"');
    expect(bare).not.toContain('code');
    expect(bare).not.toContain('secret');
  });

  it('reads deploying for an application whose current release is gone, at the given time', async () => {
    const { id } = await setup();
    const { applicationId } = await live(id);
    await adminDb.hostedApplication.update({
      where: { id: applicationId },
      data: { currentReleaseId: null },
    });
    const at = new Date('2026-11-23T12:00:00.000Z');
    expect(await health.probeApplication(applicationId, { now: () => at })).toEqual({
      outcome: 'probed',
      state: 'deploying',
      events: 0,
    });
    expect(await healthRow(applicationId)).toMatchObject({ state: 'deploying', since: at });
  });

  it('skips an application that is gone', async () => {
    expect(await health.probeApplication('missing')).toEqual({ outcome: 'skipped' });
  });
});

describe('probeApplication — events and notifications', () => {
  it('stores the masked last lines and tells every administrator, and no one else, once', async () => {
    const { fx, id, memberId } = await setup();
    await environmentConfigService.set(
      id,
      'production',
      { name: 'STRIPE_KEY', value: SECRET, isSecret: true },
      fx.ctx,
    );
    const { appRef, applicationId } = await live(id);
    hosting().appendLogLines(appRef, [
      { at: new Date(Date.now() - 1000), stream: 'app', message: `boot with ${SECRET}` },
      { at: new Date(), stream: 'app', message: 'panic: boom' },
    ]);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });

    await health.probeApplication(applicationId);
    const [event] = await events(applicationId);
    expect(event!.lastLogLines).toMatchObject([
      { stream: 'app', message: 'panic: boom' },
      { stream: 'app', message: `boot with ${LOG_SECRET_MASK}` },
    ]);
    expect(JSON.stringify(event!.lastLogLines)).not.toContain(SECRET);

    const sent = await notifications();
    expect(sent.map((n) => n.recipientUserId)).toEqual([fx.ownerId]);
    expect(sent.map((n) => n.recipientUserId)).not.toContain(memberId);
    expect(sent[0]).toMatchObject({
      category: 'direct',
      actorId: null,
      workItemId: null,
      dedupeKey: `${TYPE}:${event!.id}`,
      data: {
        kind: TYPE,
        projectKey: 'ACME',
        projectRepositoryId: id,
        repositoryName: 'repo-web',
        applicationId,
        eventId: event!.id,
        eventKind: 'crashed',
        reason: 'exit code 1',
        occurredAt: event!.occurredAt.toISOString(),
      },
    });
  });

  it('writes the event with [] when the logs cannot be read', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().setLogsUnavailable(appRef, 'rate limited');
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    await health.probeApplication(applicationId);
    expect((await events(applicationId))[0]!.lastLogLines).toEqual([]);
  });

  it('writes one event and one notification when the same transition is run twice', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    await health.probeApplication(applicationId);
    // A retry that lost its stored state still finds the event key taken.
    await adminDb.hostedApplicationHealth.delete({ where: { applicationId } });
    await health.probeApplication(applicationId);
    expect(await events(applicationId)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it('writes one event and one notification when two runs race', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    await health.probeApplication(applicationId);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    const outcomes: ProbeApplicationOutcome[] = await Promise.all([
      health.probeApplication(applicationId),
      health.probeApplication(applicationId),
      health.probeApplication(applicationId),
    ]);
    expect(outcomes.map((o) => (o.outcome === 'probed' ? o.events : -1)).sort()).toEqual([0, 0, 1]);
    expect(await events(applicationId)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it('records a restarted-from exit once, while the app stays healthy', async () => {
    const { appRef, applicationId } = await (async () => {
      const s = await setup();
      return live(s.id);
    })();
    const at = new Date(hosting().now().getTime() - 5_000);
    hosting().recordRestartedExit(appRef, { exitCode: 2, oomKilled: false, at });

    await health.probeApplication(applicationId);
    await health.probeApplication(applicationId);
    expect((await healthRow(applicationId))!.state).toBe('healthy');
    const written = await events(applicationId);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: 'crashed',
      reason: 'exit code 2',
      transitionKey: `exit:${at.toISOString()}`,
    });
    expect(await notifications()).toHaveLength(1);
  });

  it('writes the event with [] when the masked read itself throws', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    vi.spyOn(productionLogsService, 'readMaskedLines').mockRejectedValueOnce(new Error('boom'));
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    expect(await health.probeApplication(applicationId)).toMatchObject({ events: 1 });
    expect((await events(applicationId))[0]!.lastLogLines).toEqual([]);
    expect(await notifications()).toHaveLength(1);
    expect(logged.some((l) => l.includes("could not read an event's last lines"))).toBe(true);
  });

  it('keeps the event and its notifications when storing the lines fails', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    vi.spyOn(productionLogsService, 'readMaskedLines').mockResolvedValueOnce({
      state: 'ok',
      lines: [{ at: new Date(), stream: 'app', message: 'about to fall over' }],
      cursor: null,
    } as unknown as Awaited<ReturnType<typeof productionLogsService.readMaskedLines>>);
    vi.spyOn(hostedApplicationHealthRepository, 'setEventLogLines').mockRejectedValueOnce(
      new Error('boom'),
    );
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    expect(await health.probeApplication(applicationId)).toMatchObject({ events: 1 });
    expect((await events(applicationId))[0]!.lastLogLines).toEqual([]);
    expect(await notifications()).toHaveLength(1);
    expect(logged.some((l) => l.includes("could not store an event's last lines"))).toBe(true);
  });

  it('keeps a notification failure from undoing the event', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    vi.spyOn(projectAccessService, 'listUserIdsWithPermission').mockRejectedValueOnce(
      new Error('boom'),
    );
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    expect(await health.probeApplication(applicationId)).toMatchObject({ events: 1 });
    expect(await notifications()).toHaveLength(0);
  });
});

describe('probeAll', () => {
  it('probes every application with a release, and never a customer repository', async () => {
    const { fx, id } = await setup();
    const web = await live(id);
    const customer = await repo(fx, 'initialised', 'api');
    const customerApp = await live(customer);
    await adminDb.projectRepo.update({
      where: { id: customer },
      data: { seedSource: 'organization' },
    });
    const readHealth = vi.spyOn(hosting(), 'readHealth');

    expect(await health.probeAll()).toEqual({
      applications: 1,
      probed: 1,
      skipped: 0,
      failures: 0,
      events: 0,
    });
    expect(readHealth).toHaveBeenCalledTimes(1);
    expect(await healthRow(web.applicationId)).not.toBeNull();
    expect(await healthRow(customerApp.applicationId)).toBeNull();
    expect(await events(customerApp.applicationId)).toEqual([]);
    expect(await health.probeApplication(customerApp.applicationId)).toEqual({
      outcome: 'skipped',
    });
  });

  it('counts an application that went away mid-run as skipped', async () => {
    const { id } = await setup();
    await live(id);
    vi.spyOn(hostedApplicationRepository, 'findProbeTarget').mockResolvedValueOnce(null);
    expect(await health.probeAll()).toMatchObject({ applications: 1, probed: 0, skipped: 1 });
  });

  it('counts failures and events', async () => {
    const { id } = await setup();
    const { appRef } = await live(id);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    expect(await health.probeAll()).toMatchObject({ probed: 1, events: 1 });
    vi.spyOn(hosting(), 'readHealth').mockRejectedValueOnce(new TypeError('x'));
    expect(await health.probeAll()).toMatchObject({ failures: 1 });
  });
});

describe('getHealthForRepository', () => {
  it('answers no state for an application without a current release', async () => {
    const { fx, id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    await health.probeApplication(applicationId);
    await adminDb.hostedApplication.update({
      where: { id: applicationId },
      data: { currentReleaseId: null },
    });
    const read = await health.getHealthForRepository('ACME', id, fx.ctx);
    expect(read).toMatchObject({ state: null, since: null, condition: null });
    expect(read.events).toHaveLength(1);
  });

  it('reads stored lines defensively: only well-formed ones, platform kept apart', async () => {
    const { fx, id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    await health.probeApplication(applicationId);
    const [event] = await events(applicationId);
    const at = '2026-11-23T10:00:00.000Z';
    await adminDb.hostedApplicationEvent.update({
      where: { id: event!.id },
      data: {
        lastLogLines: [
          null,
          { at, message: 7 },
          { message: 'no time' },
          { at, stream: 'platform', message: 'restarting' },
          { at, stream: 'weird', message: 'from the app' },
        ],
      },
    });
    expect(
      (await health.getHealthForRepository('ACME', id, fx.ctx)).events[0]!.lastLogLines,
    ).toEqual([
      { at, stream: 'platform', message: 'restarting' },
      { at, stream: 'app', message: 'from the app' },
    ]);
    await adminDb.hostedApplicationEvent.update({
      where: { id: event!.id },
      data: { lastLogLines: { not: 'a list' } },
    });
    expect(
      (await health.getHealthForRepository('ACME', id, fx.ctx)).events[0]!.lastLogLines,
    ).toEqual([]);
  });

  it('is not found for an actor who cannot browse the project', async () => {
    const { fx, id } = await setup();
    vi.spyOn(projectAccessService, 'getPermissions').mockResolvedValueOnce(new Set());
    await expect(health.getHealthForRepository('ACME', id, fx.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});

describe('the production health probe job', () => {
  it('is the per-minute system job that runs probeAll in one step', async () => {
    const result = { applications: 0, probed: 0, skipped: 0, failures: 0, events: 0 };
    const probeAll = vi.fn(async () => result);
    const steps: string[] = [];
    const ctx = {
      step: {
        run: async <T>(stepId: string, fn: () => T | Promise<T>): Promise<T> => {
          steps.push(stepId);
          return fn();
        },
      },
    };
    expect(productionHealthProbe.id).toBe('system.production-health-probe');
    expect(PRODUCTION_HEALTH_PROBE_CRON).toBe('* * * * *');
    expect(
      await (
        productionHealthProbe.handler as unknown as (
          c: typeof ctx,
          s: { productionHealth: { probeAll: typeof probeAll } },
        ) => Promise<unknown>
      )(ctx, { productionHealth: { probeAll } }),
    ).toBe(result);
    expect(steps).toEqual(['production-health-probe']);
    expect(probeAll).toHaveBeenCalledTimes(1);
  });
});

describe('listUserIdsWithPermission', () => {
  it('agrees with getPermissions for an administrator, a member and a non-member', async () => {
    const { fx, memberId } = await setup();
    const outsider = await usersService.createUser({
      email: 'outsider@health.test',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    const scope = { projectId: fx.projectId, workspaceId: fx.workspaceId };
    const admins = await projectAccessService.listUserIdsWithPermission(
      scope,
      'project:administer',
    );
    expect(admins).toEqual([fx.ownerId]);
    for (const userId of [fx.ownerId, memberId, outsider.id]) {
      const held = await projectAccessService.getPermissions(fx.projectId, {
        userId,
        workspaceId: fx.workspaceId,
      });
      expect(admins.includes(userId), userId).toBe(held.has('project:administer'));
    }
    expect(admins).not.toContain(outsider.id);
    expect(await projectAccessService.listUserIdsWithPermission(scope, 'project:browse')).toEqual(
      [fx.ownerId, memberId].sort(),
    );
  });
});

describe('row-level security', () => {
  it('shows another workspace none of the rows', async () => {
    const { id } = await setup();
    const { appRef, applicationId } = await live(id);
    hosting().setRuntimeState(appRef, { state: 'exited', exitCode: 1 });
    await health.probeApplication(applicationId);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${other.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return [await tx.hostedApplicationHealth.count(), await tx.hostedApplicationEvent.count()];
    });
    expect(seen).toEqual([0, 0]);
    expect(await adminDb.hostedApplicationEvent.count()).toBe(1);
  });
});

describe('probeHealthCheck — the lane seam and the real request', () => {
  const target = {
    productionAddress: 'shop--acme.motir.site',
    path: '/api/health',
    target: 'fly' as const,
    appRef: 'nope',
  };

  it('never makes a request on the fake, and answers from its store', async () => {
    const fetch = vi.fn();
    expect(await probeHealthCheck(target, { fetch })).toEqual({ kind: 'ok', status: 200 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is off when the variable is unset: one GET, redirects not followed', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const fetch = vi.fn(async () => new Response('', { status: 301 }));
    expect(await probeHealthCheck(target, { fetch })).toEqual({ kind: 'ok', status: 301 });
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://shop--acme.motir.site/api/health'),
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('classifies a failure, a timeout and no connection', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    expect(
      await probeHealthCheck(target, { fetch: async () => new Response('x', { status: 500 }) }),
    ).toEqual({ kind: 'failed', status: 500 });
    expect(
      await probeHealthCheck(target, {
        timeoutMs: 5,
        fetch: (_url, init) =>
          new Promise((_, reject) =>
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
          ),
      }),
    ).toEqual({ kind: 'timeout' });
    expect(
      await probeHealthCheck(target, {
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    ).toEqual({ kind: 'unreachable' });
  });

  it('never reads the body, and survives a body that will not cancel', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const cancel = vi.fn(async () => {
      throw new Error('already locked');
    });
    const response = { status: 204, body: { cancel } } as unknown as Response;
    expect(await probeHealthCheck(target, { fetch: async () => response })).toEqual({
      kind: 'ok',
      status: 204,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('the project phase', () => {
  it('is named by none of the files this card adds', () => {
    const root = join(__dirname, '..', '..');
    for (const file of [
      'lib/hosting/healthState.ts',
      'lib/hosting/healthProbe.ts',
      'lib/repositories/hostedApplicationHealthRepository.ts',
      'lib/services/productionHealthService.ts',
      'lib/jobs/definitions/productionHealthProbe.ts',
      'lib/dto/productionHealth.ts',
      'app/api/projects/[key]/repositories/[rowId]/production/health/route.ts',
      'prisma/migrations/20261123190000_hosted_application_health/migration.sql',
    ]) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/phase/i);
    }
  });
});
