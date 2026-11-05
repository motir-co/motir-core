import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_FLEET_APP,
  fakeFleetInventory,
  fakeOrchestrator,
  type ContainerSpec,
} from '@motir/orchestrator';
import type { PlatformRole } from '@/generated/prisma/client';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { runnerJitConfigClient } from '@/lib/github/runnerJitConfig';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { clock, fleet, fx, MIN, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

/**
 * Story MOTIR-6905's INTEGRATION GATE, part 2 (MOTIR-7321) — THE PREVIEW → STOP →
 * CENSUS SEAM and THE RECONCILER HAND-OFF, against a real Postgres.
 *
 * Two organisations, each holding Motir-hosted repositories with live workflow
 * runs, CI containers, a hosted-agent slot, an index slot and running agent
 * instances. A superadmin previews and stops org A; the claims are about rows
 * one service wrote and another read:
 *
 *   · the preview's counts are exactly what the stop then reports;
 *   · `fleetCeilingService.orgCensus(A)` reads zero CI runners and zero agent
 *     instances afterwards, and org B's census is byte-identical before and after;
 *   · the fleet reconciler, finding one of A's CI machines still listed by the
 *     provider, classifies it `org_stopped` from the `admin_stop` settle the stop
 *     wrote — and the monitor's kill list shows it under A's name;
 *   · every stop writes ONE `fleet.stop` row, a partial one included.
 *
 * ⚠️ THE CROSS-ORG GUARD IS BUILT TO CATCH APP-SCOPING. Both orgs' CI containers
 * live in the SAME fake fleet app and both orgs' repositories in the SAME GitHub
 * org (`motir-projects`), so a step scoped by app, fleet or GitHub org instead of
 * by organisation would reach B and fail the B assertions.
 *
 * Fakes, as the units use them: the orchestrator (`fake`, ephemeral and
 * persistent), the fleet inventory over both, GitHub at `fetch`, motir-ai at
 * `fetch` (the instance harness), Sentry at its module. The hosted-run END is
 * observed at its service seam — `endHostedRun`'s own revocations and close are
 * pinned by the hosted-run suites, and its supervisor's teardown is not this
 * story's. The SESSION is mocked; `requirePlatformStaff` is the real one.
 */

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({ token: 'ghs_test', expiresAt: new Date() })),
}));

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const { db } = await import('@/lib/db');
const { requirePlatformStaff } = await import('@/lib/platform/auth');
const { MissingAuditReasonError, NotPlatformStaffError } = await import('@/lib/platform/errors');
const { platformFleetStopService } = await import('@/lib/services/platformFleetStopService');
const { platformFleetMonitorService } = await import('@/lib/services/platformFleetMonitorService');
const { hostedRunService } = await import('@/lib/services/hostedRunService');
const { fleetCeilingService } = await import('@/lib/services/fleetCeilingService');
const { fleetAttributionService, FLEET_ATTRIBUTION_GRACE_MS } =
  await import('@/lib/services/fleetAttributionService');
const { agentInstanceLifecycleService: lifecycle } =
  await import('@/lib/services/agentInstanceLifecycleService');
const { actionsRunsClient } = await import('@/lib/github/actionsRuns');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { toFleetLastStopDTO } = await import('@/lib/mappers/platformFleetStopMappers');

type PlatformPrincipal = import('@/lib/platform/auth').PlatformPrincipal;

const MOTIR_ORG = 'motir-projects';
let seq = 0;

async function seedHostedRepo(t: WorkItemFixture, name: string): Promise<void> {
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
      position: `g${String(seq).padStart(3, '0')}`,
      githubRepoId: mirror.id,
    },
  });
}

/** A CI intent in flight with a live container in the SHARED fake fleet app. */
async function seedCiContainer(t: WorkItemFixture): Promise<{ id: string; containerId: string }> {
  seq += 1;
  const handle = await fakeOrchestrator.provision({ region: 'iad' } as ContainerSpec);
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: t.workspaceId,
      organizationId: t.workspace.organizationId,
      projectId: t.projectId,
      installationId: '556677',
      runId: String(9000 + seq),
      runAttempt: 1,
      jobId: String(90_000 + seq),
      repoOwner: MOTIR_ORG,
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: clock.now(),
      status: 'running',
      startedAt: clock.now(),
      containerProvider: handle.provider,
      containerId: handle.id,
      containerRegion: handle.region,
      bootedAt: handle.createdAt,
    },
  });
  return { id: intent.id, containerId: handle.id };
}

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

/** A fake GitHub Actions runs API over `liveRuns`, delegating the rest to the harness. */
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

/** One org's whole fleet: 2 repos with 1 live run each, 2 CI containers, a hosted
 *  run, an index container and 2 running agents. */
async function seedBusyOrg(t: WorkItemFixture, tag: string) {
  await seedHostedRepo(t, `${tag}-web`);
  await seedHostedRepo(t, `${tag}-api`);
  liveRuns.set(`${MOTIR_ORG}/${tag}-web`, [seq * 10 + 1]);
  liveRuns.set(`${MOTIR_ORG}/${tag}-api`, [seq * 10 + 2]);
  const intents = [await seedCiContainer(t), await seedCiContainer(t)];
  const hostedRun = `run-${tag}`;
  await seedSlot(t, 'hosted_agent', hostedRunDispatchId(hostedRun));
  await seedSlot(t, 'code_graph_index', `index-${tag}`);
  const instances = [
    await runningInstance(t, `${tag}-agent-1`),
    await runningInstance(t, `${tag}-agent-2`),
  ];
  return { intents, instances, hostedRun, repos: [`${tag}-web`, `${tag}-api`] };
}

async function signIn(role: PlatformRole | null): Promise<PlatformPrincipal> {
  seq += 1;
  const user = await createTestUser({ email: `ops+stopgate${seq}@moooon.net` });
  if (role) {
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  }
  currentSession = { user: { id: user.id } };
  return { userId: user.id, email: user.email, role: role ?? 'support' };
}

async function census(t: WorkItemFixture) {
  return withSystemContext((tx) =>
    fleetCeilingService.orgCensus(t.workspace.organizationId, clock.now(), tx),
  );
}

/** Everything of org B a stop of A could touch, read straight from the tables. */
async function snapshotOrg(t: WorkItemFixture, repos: string[]) {
  const orgId = t.workspace.organizationId;
  return {
    census: await census(t),
    intents: await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { organizationId: orgId },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, teardownReason: true, settledAt: true, containerId: true },
    }),
    instances: await adminDb.agentInstance.findMany({
      where: { organizationId: orgId },
      orderBy: { id: 'asc' },
      select: { id: true, state: true, machineId: true },
    }),
    slots: await adminDb.fleetInFlightSlot.findMany({
      where: { organizationId: orgId },
      orderBy: { ref: 'asc' },
      select: { workload: true, ref: true, expiresAt: true },
    }),
    runs: repos.map((repo) => liveRuns.get(`${MOTIR_ORG}/${repo}`)),
  };
}

const fleetStopRows = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.stop' },
    orderBy: { createdAt: 'asc' },
  });

let superadmin: PlatformPrincipal;
let orgB: WorkItemFixture;

beforeEach(async () => {
  await setUpHarness();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_audit_log", "fleet_machine_kill" RESTART IDENTITY CASCADE',
  );
  await adminDb.ciContainerUsage.deleteMany({});
  fakeOrchestrator.reset();
  fakeFleetInventory.reset();
  captureException.mockReset();
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  liveRuns = new Map();
  refuseRuns = new Set();
  fakeGithubRuns();
  vi.spyOn(runnerJitConfigClient, 'deleteRunner').mockResolvedValue(undefined);
  vi.spyOn(hostedRunService, 'endHostedRun').mockResolvedValue({
    closed: true,
    runKey: 'revoked',
    runCredential: 0,
    gitCredentials: { revoked: 0, failed: 0 },
  });
  orgB = await makeWorkItemFixture({ name: 'Bystander', identifier: 'BYST' });
  superadmin = await signIn('superadmin');
});

afterEach(tearDownHarness);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('preview → stop → census (AC3)', () => {
  it('the preview names exactly what the stop does; A reads zero, B is byte-identical', async () => {
    const a = await seedBusyOrg(fx, 'alpha');
    const b = await seedBusyOrg(orgB, 'bravo');
    const orgA = fx.workspace.organizationId;

    expect((await census(fx)).byWorkload).toMatchObject({
      ci_runner: 2,
      hosted_agent: 1,
      agent_instance: 2,
      code_graph_index: 1,
    });
    const bBefore = await snapshotOrg(orgB, b.repos);
    expect(bBefore.census.byWorkload).toMatchObject({ ci_runner: 2, agent_instance: 2 });

    const preview = await platformFleetStopService.preview(superadmin, orgA, clock.now());
    const result = await platformFleetStopService.stop(
      superadmin,
      orgA,
      'Runaway spend reported by the customer',
      clock.now(),
    );

    // The preview IS the stop's answer.
    expect(preview).toEqual({
      ciRuns: 2,
      ciContainers: 2,
      hostedRuns: 1,
      agentInstances: 2,
      indexContainers: 1,
    });
    expect(result).toEqual({
      runsCancelled: preview.ciRuns,
      ciContainersStopped: preview.ciContainers,
      hostedRunsEnded: preview.hostedRuns,
      agentInstancesHibernated: preview.agentInstances,
      failures: { ci: 0, hosted: 0, instances: 0 },
    });

    // A's census: no CI runner, no agent instance. Index containers are never stopped.
    expect((await census(fx)).byWorkload).toMatchObject({
      ci_runner: 0,
      agent_instance: 0,
      code_graph_index: 1,
    });
    for (const { id } of a.intents) {
      expect(
        await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: 'failed', teardownReason: 'admin_stop' });
    }
    for (const id of a.instances) {
      expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
        'hibernated',
      );
    }
    expect(a.repos.map((repo) => liveRuns.get(`${MOTIR_ORG}/${repo}`))).toEqual([[], []]);
    expect(vi.mocked(hostedRunService.endHostedRun).mock.calls.map(([run]) => run)).toEqual([
      a.hostedRun,
    ]);

    // B: every row, every run, every container — and the census — unchanged.
    const bAfter = await snapshotOrg(orgB, b.repos);
    expect(bAfter).toStrictEqual(bBefore);
    expect(JSON.stringify(bAfter.census)).toBe(JSON.stringify(bBefore.census));
    for (const { containerId } of b.intents) {
      expect(fakeOrchestrator.liveContainerIds()).toContain(containerId);
    }
    // And a second preview, after the stop, says there is nothing left to stop in A.
    expect(await platformFleetStopService.preview(superadmin, orgA, clock.now())).toMatchObject({
      ciRuns: 0,
      ciContainers: 0,
      agentInstances: 0,
    });
  });
});

describe('the reconciler hand-off', () => {
  it('a CI machine of A still listed after the stop is killed org_stopped — and the kill list names A', async () => {
    const a = await seedBusyOrg(fx, 'alpha');
    await seedBusyOrg(orgB, 'bravo');
    await platformFleetStopService.stop(
      superadmin,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );

    // The provider still lists one of A's torn-down machines (a destroy that
    // has not landed on the provider's side yet).
    const lingering = a.intents[0]!.containerId;
    fakeFleetInventory.addStray({
      app: FAKE_FLEET_APP,
      machineId: lingering,
      name: 'ci-runner',
      createdAt: clock.now(),
    });
    const pastGrace = () => new Date(Date.now() + FLEET_ATTRIBUTION_GRACE_MS + MIN);

    const result = await fleetAttributionService.reconcile({
      now: pastGrace,
      inventory: fakeFleetInventory,
    });

    // ONE kill: A's machine, org_stopped — not no_record, not record_ended.
    // B's live containers and agents are attributed, not killed.
    expect(result).toMatchObject({ outcome: 'reconciled', failures: 0 });
    if (result.outcome !== 'reconciled') throw new Error('expected a reconciled pass');
    expect(result.killed).toEqual([
      {
        app: FAKE_FLEET_APP,
        machineId: lingering,
        reason: 'org_stopped',
        action: 'destroyed',
        workload: 'ci_runner',
      },
    ]);
    expect(
      await adminDb.fleetMachineKill.findMany({ select: { reason: true, organizationId: true } }),
    ).toEqual([{ reason: 'org_stopped', organizationId: fx.workspace.organizationId }]);

    // The monitor page's kill list shows it, under A's name.
    const kills = await platformFleetMonitorService.listKills(superadmin, {}, pastGrace());
    if (kills.meter !== 'enabled') throw new Error('expected the meter enabled');
    expect(kills.rows).toEqual([
      expect.objectContaining({
        machineId: lingering,
        reason: 'org_stopped',
        organizationId: fx.workspace.organizationId,
        organizationName: fx.workspace.name,
      }),
    ]);
  });
});

describe('stop → audit row → the card’s last-stop line', () => {
  it('lastStop reads back the newest fleet.stop row with the counts the stop reported', async () => {
    await seedBusyOrg(fx, 'alpha');
    const orgA = fx.workspace.organizationId;
    expect(await platformFleetStopService.lastStop(superadmin, orgA)).toBeNull();

    await platformFleetStopService.stop(superadmin, orgA, 'first', clock.now());
    const second = await platformFleetStopService.stop(superadmin, orgA, 'again', clock.now());

    expect(await platformFleetStopService.lastStop(superadmin, orgA)).toEqual({
      at: expect.any(String),
      actorEmail: superadmin.email,
      reason: 'again',
      runsCancelled: second.runsCancelled,
      ciContainersStopped: second.ciContainersStopped,
      hostedRunsEnded: second.hostedRunsEnded,
      agentInstancesHibernated: second.agentInstancesHibernated,
    });
    // B has never been stopped, and A's stops are not B's.
    expect(
      await platformFleetStopService.lastStop(superadmin, orgB.workspace.organizationId),
    ).toBeNull();
  });

  it('a row whose metadata is not the shape the stop writes reads as zeros, never a throw', () => {
    const base = {
      id: 'x',
      createdAt: new Date('2026-10-02T12:00:00.000Z'),
      actor: null,
      reason: null,
    };
    for (const metadata of [
      null,
      [1, 2],
      'text',
      { runsCancelled: 'two', ciContainersStopped: Infinity },
    ]) {
      expect(
        toFleetLastStopDTO({ ...base, metadata } as unknown as Parameters<
          typeof toFleetLastStopDTO
        >[0]),
      ).toEqual({
        at: '2026-10-02T12:00:00.000Z',
        actorEmail: null,
        reason: null,
        runsCancelled: 0,
        ciContainersStopped: 0,
        hostedRunsEnded: 0,
        agentInstancesHibernated: 0,
      });
    }
  });
});

describe('the audit trail of a stop (AC5)', () => {
  it('a stop writes ONE fleet.stop row — actor, org, reason, counts; a preview ONE estate.read', async () => {
    await seedBusyOrg(fx, 'alpha');
    const orgA = fx.workspace.organizationId;

    await platformFleetStopService.preview(superadmin, orgA, clock.now());
    let rows = await adminDb.platformAuditLog.findMany();
    expect(rows.map((r) => [r.action, r.targetKind, r.targetId, r.actorUserId])).toEqual([
      ['estate.read', 'organization', orgA, superadmin.userId],
    ]);

    await platformFleetStopService.stop(superadmin, orgA, '  Runaway spend  ', clock.now());
    rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(await fleetStopRows()).toEqual([
      expect.objectContaining({
        actorUserId: superadmin.userId,
        actorRole: 'superadmin',
        targetKind: 'organization',
        targetId: orgA,
        organizationId: orgA,
        reason: 'Runaway spend',
        metadata: expect.objectContaining({
          runsCancelled: 2,
          ciContainersStopped: 2,
          hostedRunsEnded: 1,
          agentInstancesHibernated: 2,
          failures: { ci: 0, hosted: 0, instances: 0 },
          instanceFailures: [],
        }),
      }),
    ]);
  });

  it('a PARTIAL stop still writes its one row, carrying the failures — and still spares B', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedBusyOrg(fx, 'alpha');
    const b = await seedBusyOrg(orgB, 'bravo');
    const bBefore = await snapshotOrg(orgB, b.repos);
    refuseRuns.add(`${MOTIR_ORG}/alpha-api`);
    fakeOrchestrator.failNextTeardown();
    fleet.failNextStop();
    vi.mocked(hostedRunService.endHostedRun).mockRejectedValueOnce(new Error('revoke failed'));

    const result = await platformFleetStopService.stop(
      superadmin,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );

    expect(result).toEqual({
      runsCancelled: 1,
      ciContainersStopped: 1,
      hostedRunsEnded: 0,
      agentInstancesHibernated: 1,
      failures: { ci: 2, hosted: 1, instances: 1 },
    });
    const rows = await fleetStopRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: superadmin.userId,
      organizationId: fx.workspace.organizationId,
      reason: 'Runaway spend',
      metadata: { failures: { ci: 2, hosted: 1, instances: 1 } },
    });
    expect((rows[0]?.metadata as { instanceFailures: unknown[] }).instanceFailures).toHaveLength(1);
    // No step widened its scope when an earlier one failed.
    expect(await snapshotOrg(orgB, b.repos)).toStrictEqual(bBefore);
    expect(error).toHaveBeenCalled();
  });

  it('a refused stop — not superadmin, or no reason — touches nothing and writes no fleet.stop', async () => {
    const a = await seedBusyOrg(fx, 'alpha');
    const orgA = fx.workspace.organizationId;

    for (const role of [null, 'support', 'operator'] as const) {
      const p = await signIn(role);
      await expect(platformFleetStopService.stop(p, orgA, 'Runaway spend')).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
    }
    // A non-staff session cannot even preview.
    const nobody = await signIn(null);
    await expect(platformFleetStopService.preview(nobody, orgA)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );

    superadmin = await signIn('superadmin');
    await expect(platformFleetStopService.stop(superadmin, orgA, '   ')).rejects.toBeInstanceOf(
      MissingAuditReasonError,
    );
    // A reason that is not a string at all (a form posting nothing) is a blank reason.
    await expect(
      platformFleetStopService.stop(superadmin, orgA, undefined as unknown as string),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);

    expect(await adminDb.platformAuditLog.count()).toBe(0);
    expect((await census(fx)).byWorkload).toMatchObject({ ci_runner: 2, agent_instance: 2 });
    expect(a.repos.map((repo) => liveRuns.get(`${MOTIR_ORG}/${repo}`)?.length)).toEqual([1, 1]);
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalled();
  });
});

describe('the stop’s edges (coverage top-up)', () => {
  it('a preview whose run count fails with a non-Error says it does not know', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedHostedRepo(fx, 'alpha-web');
    vi.spyOn(actionsRunsClient, 'listActiveRuns').mockRejectedValue('a bare string');
    const preview = await platformFleetStopService.preview(
      superadmin,
      fx.workspace.organizationId,
      clock.now(),
    );
    expect(preview.ciRuns).toBeNull();
    expect(error).toHaveBeenCalledWith(
      '[platformFleetStopService] could not count the active runs',
      {
        organizationId: fx.workspace.organizationId,
        detail: 'unknown',
      },
    );
  });

  it('a hosted_agent slot whose ref names no run is neither counted nor ended', async () => {
    await seedSlot(fx, 'hosted_agent', 'not-a-hosted-run-ref');
    await seedSlot(fx, 'hosted_agent', hostedRunDispatchId(''));
    const preview = await platformFleetStopService.preview(
      superadmin,
      fx.workspace.organizationId,
      clock.now(),
    );
    expect(preview.hostedRuns).toBe(0);
    const result = await platformFleetStopService.stop(
      superadmin,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );
    expect(result.hostedRunsEnded).toBe(0);
    expect(hostedRunService.endHostedRun).not.toHaveBeenCalled();
  });

  it('a hosted run whose end throws a non-Error is one failure, logged as `unknown`', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedSlot(fx, 'hosted_agent', hostedRunDispatchId('run-x'));
    vi.mocked(hostedRunService.endHostedRun).mockRejectedValueOnce('bare');
    const result = await platformFleetStopService.stop(
      superadmin,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );
    expect(result.failures.hosted).toBe(1);
    expect(error).toHaveBeenCalledWith('[platformFleetStopService] could not end a hosted run', {
      organizationId: fx.workspace.organizationId,
      dispatchRunId: 'run-x',
      detail: 'unknown',
    });
  });

  it('an agent in motion is counted, not moved — whether it is mid-start or loses the race to another path', async () => {
    const starting = await runningInstance(fx, 'alpha-starting');
    const raced = await runningInstance(fx, 'alpha-raced');
    await adminDb.agentInstance.update({ where: { id: starting }, data: { state: 'starting' } });
    // Another path moves `raced` between the list and the guarded transition.
    vi.spyOn(lifecycle, 'beginHibernate').mockResolvedValueOnce(false);

    const result = await lifecycle.hibernateAllForOrganization(
      fx.workspace.organizationId,
      'admin_stop',
    );
    expect(result).toEqual({
      hibernated: 0,
      alreadyResting: 0,
      inMotion: 2,
      failures: [],
      hibernatedInstanceIds: [],
    });
    expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id: starting } })).state).toBe(
      'starting',
    );
    expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id: raced } })).state).toBe(
      'running',
    );
  });

  it('an agent whose stop THROWS is a counted failure with its id, never a throw out of the stop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await runningInstance(fx, 'alpha-throws');
    vi.spyOn(lifecycle, 'beginHibernate').mockRejectedValueOnce(new Error('guard exploded'));

    const result = await platformFleetStopService.stop(
      superadmin,
      fx.workspace.organizationId,
      'Runaway spend',
      clock.now(),
    );
    expect(result).toMatchObject({ agentInstancesHibernated: 0, failures: { instances: 1 } });
    const [row] = await fleetStopRows();
    expect((row?.metadata as { instanceFailures: unknown[] }).instanceFailures).toEqual([
      { instanceId: id, detail: 'guard exploded' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      '[agentInstanceLifecycle] admin stop failed for one instance',
      {
        instanceId: id,
        detail: 'guard exploded',
      },
    );
  });

  it('the gate is the real one: a superadmin session resolves as superadmin', async () => {
    await expect(requirePlatformStaff('superadmin')).resolves.toMatchObject({
      userId: superadmin.userId,
      role: 'superadmin',
    });
  });
});
