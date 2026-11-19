import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Sentry's recorder is mocked at its module (the sanctioned second mock, as the
// fleet debit monitor's suite does): the blind-spot report is asserted on it.
const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage, addBreadcrumb: vi.fn() }));

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerReconcileService, coverPartitions } from '@/lib/services/ciRunnerReconcileService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetQueueClient } from '@/lib/github/fleetQueue';
import { MOTIR_ON_DEMAND_RUNNER_LABEL, MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { fakeOrchestrator } from '@motir/orchestrator';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { randomToken, randomInt } from '../helpers/random';

// THE GITHUB-SIDE RECONCILE against real Postgres (Bug MOTIR-8976).
//
// A fleet runner is not tied to a job, so a lost runner leaves a job queued on
// GitHub while every intent is settled. Real here: Postgres, the intent table, the
// whole reconcile service and the admission gate. Faked: GitHub (`fetch`), as the
// rest of the fleet lane fakes it, and the Inngest transport.

const MOTIR_ORG = 'motir-projects';
const CONNECTED_ORG = 'moooon-B-V';
const PROVISIONING_INSTALLATION = '88001';
const CONNECTED_INSTALLATION = '88002';
const PASSWORD = 'hunter2hunter2';
const NOW = new Date('2026-10-19T08:00:00Z');
const OLD = new Date(NOW.getTime() - 10 * 60_000).toISOString();
const FRESH = new Date(NOW.getTime() - 30_000).toISOString();

const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface GhJob {
  id: number;
  run_id: number;
  created_at: string;
  status?: string;
  labels?: string[];
}
interface GhRunner {
  id: number;
  busy?: boolean;
  status?: string;
  labels?: string[];
}

/** What GitHub holds, per `owner/repo` and per org. */
let queuedJobs: Record<string, GhJob[]>;
let orgRunners: Record<string, GhRunner[]>;
/** Runs whose jobs read GitHub refuses, by run id → HTTP status (MOTIR-10790). */
let failingRunJobs: Record<number, number>;
/** `owner/repo`s whose runs list GitHub refuses, → HTTP status. */
let failingRunLists: Record<string, number>;
let urls: string[];
/** The provisioning App's installation per org login (lowercase), beyond motir-projects. */
let orgInstallations: Record<string, number>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubGithub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      const path = new URL(url).pathname;
      if (path.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json({ id: Number(PROVISIONING_INSTALLATION) });
      }
      const installation = path.match(/^\/orgs\/([^/]+)\/installation$/);
      if (installation) {
        const id = orgInstallations[installation[1]!.toLowerCase()];
        return id ? json({ id }) : json({ message: 'Not Found' }, 404);
      }
      if (url.includes('/access_tokens')) {
        return json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      const runs = path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
      if (runs) {
        const refused = failingRunLists[runs[1]!];
        if (refused) return json({ message: 'Server Error' }, refused);
        const jobs = queuedJobs[runs[1]!] ?? [];
        const status = new URL(url).searchParams.get('status');
        const ids = [...new Set(jobs.map((j) => j.run_id))];
        return json({ workflow_runs: status === 'queued' ? ids.map((id) => ({ id })) : [] });
      }
      const runJobs = path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/);
      if (runJobs) {
        const refused = failingRunJobs[Number(runJobs[2])];
        if (refused) return json({ message: 'Server Error' }, refused);
        const jobs = (queuedJobs[runJobs[1]!] ?? []).filter((j) => j.run_id === Number(runJobs[2]));
        return json({
          jobs: jobs.map((j) => ({
            id: j.id,
            run_attempt: 1,
            name: 'build',
            workflow_name: 'CI',
            status: j.status ?? 'queued',
            labels: j.labels ?? [MOTIR_RUNNER_LABEL],
            created_at: j.created_at,
          })),
        });
      }
      const runners = path.match(/^\/orgs\/([^/]+)\/actions\/runners$/);
      if (runners) {
        return json({
          runners: (orgRunners[runners[1]!.toLowerCase()] ?? []).map((r) => ({
            id: r.id,
            name: `r${r.id}`,
            status: r.status ?? 'online',
            busy: r.busy ?? false,
            labels: (r.labels ?? [MOTIR_RUNNER_LABEL]).map((name) => ({ name })),
          })),
        });
      }
      throw new Error(`unexpected GitHub call ${url}`);
    }),
  );
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const email = `fleet-reconcile-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `R${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

/** An intent for `jobId` of repo `owner/repo` — by default the SETTLED one a lost
 *  runner leaves behind: `job_completed`, though GitHub still holds the job. */
async function seedIntent(
  fx: Fixture,
  data: {
    owner?: string;
    repo?: string;
    jobId: number;
    runId?: number;
    status?: string;
    createdAt?: Date;
    requestedLabels?: string[];
  },
) {
  const owner = data.owner ?? MOTIR_ORG;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: owner === MOTIR_ORG ? PROVISIONING_INSTALLATION : CONNECTED_INSTALLATION,
      runId: String(data.runId ?? 500),
      runAttempt: 1,
      jobId: String(data.jobId),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: owner,
      repoName: data.repo ?? 'acme-web',
      requestedLabels: data.requestedLabels ?? [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(NOW.getTime() - 3_600_000),
      status: data.status ?? 'completed',
      teardownReason: data.status ? null : 'job_completed',
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

function stranded(id: number, runId = 500, createdAt = OLD): GhJob {
  return { id, run_id: runId, created_at: createdAt };
}

const reconcile = () => ciRunnerReconcileService.reconcile({ now: () => NOW });

let captured: { events: CapturedJobEvent[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  fakeOrchestrator.reset();
  queuedJobs = {};
  orgRunners = {};
  failingRunJobs = {};
  failingRunLists = {};
  orgInstallations = {};
  urls = [];
  captureMessage.mockReset();
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  stubGithub();
  captured = captureJobEvents();
});

afterEach(() => {
  captured.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const bootEvents = () => captured.events.filter((e) => e.name === 'system.ci-runner-boot');

/** The labels of a job that asked never to run on Spot (MOTIR-11727). */
const ON_DEMAND = [MOTIR_RUNNER_LABEL, MOTIR_ON_DEMAND_RUNNER_LABEL];

describe('a job GitHub holds with no runner coming gets one', () => {
  it('mints a reconcile generation for a stranded job whose every intent is settled, and dispatches its boot', async () => {
    const fx = await seedTenant();
    const original = await seedIntent(fx, { jobId: 9001 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    const outcome = await reconcile();

    expect(outcome.added).toBe(1);
    expect(outcome.orgs).toEqual([
      { org: MOTIR_ORG, queued: 1, idleRunners: 0, awaiting: 0, added: 1 },
    ]);
    const minted = await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { jobId: '9001', reconcileGeneration: 1 },
    });
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      status: 'pending',
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      runId: original.runId,
      repoOwner: MOTIR_ORG,
    });
    expect(bootEvents().map((e) => (e.data as { intentId: string }).intentId)).toEqual([
      minted[0]!.id,
    ]);
  });

  it('is idempotent: the intent it minted covers the job, so the next sweep adds nothing', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    await reconcile();
    const second = await reconcile();

    expect(second.added).toBe(0);
    expect(second.orgs[0]).toMatchObject({ awaiting: 1, added: 0 });
    expect(await adminDb.ciRunnerProvisioningIntent.count({ where: { jobId: '9001' } })).toBe(2);
  });

  it('mints the NEXT generation when the reconciled runner is lost too', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];
    await reconcile();
    await adminDb.ciRunnerProvisioningIntent.updateMany({
      where: { jobId: '9001', reconcileGeneration: 1 },
      data: { status: 'failed', teardownReason: 'provision_failed' },
    });

    await reconcile();

    const generations = await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { jobId: '9001' },
      orderBy: { reconcileGeneration: 'asc' },
    });
    expect(generations.map((g) => g.reconcileGeneration)).toEqual([0, 1, 2]);
  });

  it('stops minting for a job that has been reconciled the maximum number of times', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    for (let g = 1; g <= 5; g++) {
      await adminDb.ciRunnerProvisioningIntent.create({
        data: {
          ...(await seedIntentData(fx, 9001)),
          reconcileGeneration: g,
          status: 'failed',
        },
      });
    }
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    expect((await reconcile()).added).toBe(0);
  });

  it('a racing sweep that loses the unique index adds nothing and does not throw', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    const [a, b] = await Promise.all([reconcile(), reconcile()]);

    expect(a.added + b.added).toBeLessThanOrEqual(2);
    const generations = await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { jobId: '9001' },
    });
    expect(new Set(generations.map((g) => g.reconcileGeneration)).size).toBe(generations.length);
  });
});

async function seedIntentData(fx: Fixture, jobId: number) {
  return {
    workspaceId: fx.workspaceId,
    organizationId: fx.organizationId,
    projectId: fx.projectId,
    installationId: PROVISIONING_INSTALLATION,
    runId: '500',
    runAttempt: 1,
    jobId: String(jobId),
    repoOwner: MOTIR_ORG,
    repoName: 'acme-web',
    requestedLabels: [MOTIR_RUNNER_LABEL],
    queuedAt: NOW,
  };
}

describe('it never boots more runners than uncovered jobs', () => {
  it('N queued, N intents in flight → 0 boots', async () => {
    const fx = await seedTenant();
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1), stranded(2), stranded(3)];
    await seedIntent(fx, { jobId: 1, status: 'pending' });
    await seedIntent(fx, { jobId: 2, status: 'provisioning' });
    await seedIntent(fx, { jobId: 3, status: 'pending' });

    const outcome = await reconcile();

    expect(outcome.added).toBe(0);
    expect(bootEvents()).toHaveLength(0);
  });

  it('idle live runners cover queued jobs; busy and offline ones do not', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1), stranded(2), stranded(3), stranded(4)];
    orgRunners[MOTIR_ORG] = [
      { id: 1 },
      { id: 2, busy: true },
      { id: 3, status: 'offline' },
      { id: 4, labels: ['someone-elses'] },
    ];

    const outcome = await reconcile();

    // 4 queued − 1 idle fleet runner = 3 uncovered.
    expect(outcome.orgs[0]).toMatchObject({ queued: 4, idleRunners: 1, added: 3 });
  });

  it('mints only for the shortfall: 3 queued, 1 in flight, 1 idle → 1', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1, status: 'provisioning' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1), stranded(2), stranded(3)];
    orgRunners[MOTIR_ORG] = [{ id: 1 }];

    expect((await reconcile()).added).toBe(1);
  });

  it('leaves a job younger than the grace to the webhook hot path', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1, 500, FRESH)];

    expect((await reconcile()).added).toBe(0);
  });

  it('ignores a queued job that does not ask for the fleet label, and nothing at all when nothing is queued', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [{ ...stranded(1), labels: ['ubuntu-latest'] }];

    expect((await reconcile()).added).toBe(0);
    queuedJobs = {};
    expect((await reconcile()).added).toBe(0);
  });

  it('does nothing when the fleet has no orchestrator configured', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];

    expect(await reconcile()).toEqual({ orgs: [], added: 0 });
  });

  it('reconciles on the CI runner pool with no Fly fleet set (MOTIR-10625)', async () => {
    // The gate follows the CI runner's switch: on its pool the AWS values a boot
    // needs are what count, and the Fly fleet's three are not read.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    vi.stubEnv('MOTIR_FLEET_CI_RUNNER_PROVIDER', 'aws');
    vi.stubEnv('MOTIR_AWS_RUNNER_AMI_ID', 'ami-0123456789abcdef0');
    vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', 'arn:aws:iam::944842271421:role/motir-add-shard');
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];

    expect((await reconcile()).added).toBe(1);
    expect(bootEvents()).toHaveLength(1);
  });
});

describe('it covers BOTH sides of the fleet', () => {
  it('motir-projects through the provisioning credential', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];

    await reconcile();

    expect(urls.some((u) => u.includes(`/installations/${PROVISIONING_INSTALLATION}/`))).toBe(true);
    expect(urls.some((u) => u.includes(`/orgs/${MOTIR_ORG}/actions/runners`))).toBe(true);
    expect(urls.some((u) => u.includes(CONNECTED_INSTALLATION))).toBe(false);
  });

  it('a connected org through the installation its deliveries arrived on', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];

    const outcome = await reconcile();

    expect(outcome.orgs).toEqual([
      { org: CONNECTED_ORG, queued: 1, idleRunners: 0, awaiting: 0, added: 1 },
    ]);
    expect(
      urls.some((u) => u.includes(`/installations/${CONNECTED_INSTALLATION}/access_tokens`)),
    ).toBe(true);
    expect(urls.some((u) => u.includes(`/orgs/${CONNECTED_ORG}/actions/runners`))).toBe(true);
    // The provisioning org was never touched on the connected org's behalf.
    expect(urls.some((u) => u.includes(`/orgs/${MOTIR_ORG}/`))).toBe(false);
    const minted = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { reconcileGeneration: 1 },
    });
    expect(minted).toMatchObject({
      repoOwner: CONNECTED_ORG,
      installationId: CONNECTED_INSTALLATION,
    });
  });

  it('counts coverage per org: one org’s idle runner does not cover another’s job', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];
    orgRunners[MOTIR_ORG.toLowerCase()] = [{ id: 1 }];

    const outcome = await reconcile();

    const byOrg = Object.fromEntries(outcome.orgs.map((o) => [o.org, o.added]));
    expect(byOrg).toEqual({ [MOTIR_ORG]: 0, [CONNECTED_ORG]: 1 });
  });

  it('one org failing to read does not starve the other', async () => {
    const fx = await seedTenant();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 1 });
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];
    const original = fleetQueueClient.listFleetRunners;
    vi.spyOn(fleetQueueClient, 'listFleetRunners').mockImplementation(async (target) => {
      if (target?.org === CONNECTED_ORG) throw new Error('installation revoked');
      return original(target);
    });

    const outcome = await reconcile();

    expect(outcome.added).toBe(1);
    expect(outcome.orgs.find((o) => o.org === CONNECTED_ORG)?.error).toBe('installation revoked');
  });
});

describe('one run GitHub cannot list does not stop the org (MOTIR-10790)', () => {
  it('skips a run whose jobs read answers 5xx and still mints for the other runs’ stranded jobs', async () => {
    // The 2026-11-09 shape: one motir-meta run answered 502 on every jobs read,
    // and that aborted the whole org's reconcile on every tick.
    const fx = await seedTenant();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 9001, runId: 500 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(8001, 600), stranded(9001, 500)];
    failingRunJobs[600] = 502;

    const outcome = await reconcile();

    expect(outcome.added).toBe(1);
    expect(outcome.orgs).toEqual([
      {
        org: MOTIR_ORG,
        queued: 1,
        idleRunners: 0,
        awaiting: 0,
        added: 1,
        skippedRuns: [
          {
            repoOwner: MOTIR_ORG,
            repoName: 'acme-web',
            runId: '600',
            status: 502,
            detail: 'Server Error',
          },
        ],
      },
    ]);
    const minted = await adminDb.ciRunnerProvisioningIntent.findMany({
      where: { reconcileGeneration: 1 },
    });
    expect(minted.map((m) => [m.runId, m.jobId])).toEqual([['500', '9001']]);
    expect(bootEvents()).toHaveLength(1);
    // The skipped run is logged with its id and status; the org did not fail.
    expect(warn).toHaveBeenCalledWith(
      '[ciRunnerReconcile] skipped a run whose jobs GitHub would not list',
      expect.objectContaining({ org: MOTIR_ORG, runId: '600', status: 502 }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('still reports an org-level failure when a repository’s runs list cannot be read', async () => {
    const fx = await seedTenant();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 9001 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];
    failingRunLists[`${MOTIR_ORG}/acme-web`] = 502;

    const outcome = await reconcile();

    expect(outcome.added).toBe(0);
    expect(outcome.orgs).toEqual([
      {
        org: MOTIR_ORG,
        queued: 0,
        idleRunners: 0,
        awaiting: 0,
        added: 0,
        error: 'GitHub refused a fleet-queue call (HTTP 502: Server Error).',
      },
    ]);
  });
});

// ── MOTIR-11437 ──────────────────────────────────────────────────────────────
// The 2026-11-16 shape: motir-codegraph moved its CI to `motir-runner` with the
// motir-studio App not installed on it, so no `workflow_job` delivery — and no
// intent — ever named it, while its jobs took the runners booted for motir-ai's.

let mirrorSeq = 0;

/** A mirrored GitHub repo of the tenant, linked to its project unless `linked: false`. */
async function seedLinkedRepo(
  fx: Fixture,
  data: { owner?: string; name: string; linked?: boolean; archived?: boolean },
) {
  mirrorSeq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: String(990_000 + mirrorSeq),
      workspaceId: fx.workspaceId,
      accountLogin: data.owner ?? CONNECTED_ORG,
      accountType: 'Organization',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      repoId: String(660_000 + mirrorSeq),
      owner: data.owner ?? CONNECTED_ORG,
      name: data.name,
      defaultBranch: 'main',
      archived: data.archived ?? false,
    },
  });
  if (data.linked !== false) {
    await linkProjectRepo({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: mirror.id,
      name: data.name,
    });
  }
  return mirror;
}

const runsListReads = (ref: string) =>
  urls.filter((u) => u.includes(`/repos/${ref}/actions/runs?status=queued`)).length;

describe('a linked repo the fleet has no delivery from is read too (MOTIR-11437)', () => {
  it('counts its stranded jobs, mints for them with the link’s attribution, and reports the repo', async () => {
    const fx = await seedTenant();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    const codegraph = await seedLinkedRepo(fx, { name: 'motir-codegraph' });
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];
    queuedJobs[`${CONNECTED_ORG}/motir-codegraph`] = [stranded(70, 700)];

    const outcome = await reconcile();

    expect(outcome.orgs).toEqual([
      {
        org: CONNECTED_ORG,
        queued: 2,
        idleRunners: 0,
        awaiting: 0,
        added: 2,
        undeliveredRepos: [`${CONNECTED_ORG}/motir-codegraph`],
      },
    ]);
    const minted = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { jobId: '70' },
    });
    expect(minted).toMatchObject({
      // The job's FIRST intent, and still generation 1: 0 is a delivery's alone,
      // and no delivery ever recorded one for it (MOTIR-11460).
      reconcileGeneration: 1,
      status: 'pending',
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      githubRepoId: codegraph.id,
      // The org's own installation — the one its runners are minted through.
      installationId: CONNECTED_INSTALLATION,
      repoOwner: CONNECTED_ORG,
      repoName: 'motir-codegraph',
      runId: '700',
    });
    expect(bootEvents()).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no workflow_job deliveries'), {
      org: CONNECTED_ORG,
      repos: [`${CONNECTED_ORG}/motir-codegraph`],
    });
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('no workflow_job deliveries'),
      expect.objectContaining({
        level: 'warning',
        fingerprint: ['ci-runner-reconcile', 'undelivered', CONNECTED_ORG.toLowerCase()],
      }),
    );
  });

  it('keeps reporting the repo on the next tick, after its own first mint (MOTIR-11460)', async () => {
    const fx = await seedTenant();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedLinkedRepo(fx, { name: 'motir-codegraph' });
    queuedJobs[`${CONNECTED_ORG}/motir-codegraph`] = [stranded(70, 700)];

    const first = await reconcile();
    const second = await reconcile();

    for (const outcome of [first, second]) {
      expect(outcome.orgs[0]?.undeliveredRepos).toEqual([`${CONNECTED_ORG}/motir-codegraph`]);
    }
    const undeliveredWarnings = captureMessage.mock.calls.filter(
      ([, context]) => (context as { fingerprint?: string[] }).fingerprint?.[1] === 'undelivered',
    );
    expect(undeliveredWarnings).toHaveLength(2);
    // The first tick's runner is still on its way, so the second mints nothing.
    expect(
      await adminDb.ciRunnerProvisioningIntent.findMany({
        where: { jobId: '70' },
        select: { reconcileGeneration: true },
      }),
    ).toEqual([{ reconcileGeneration: 1 }]);
  });

  it('records a late delivery for a job the reconcile already minted for (MOTIR-11460)', async () => {
    const fx = await seedTenant();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedLinkedRepo(fx, { name: 'motir-codegraph' });
    queuedJobs[`${CONNECTED_ORG}/motir-codegraph`] = [stranded(70, 700)];
    await reconcile();

    await seedIntent(fx, { jobId: 70, runId: 700, owner: CONNECTED_ORG, repo: 'motir-codegraph' });

    expect(
      await adminDb.ciRunnerProvisioningIntent.findMany({
        where: { jobId: '70' },
        orderBy: { reconcileGeneration: 'asc' },
        select: { reconcileGeneration: true },
      }),
    ).toEqual([{ reconcileGeneration: 0 }, { reconcileGeneration: 1 }]);
  });

  it('does not report a linked repo whose only queued job is still inside the grace', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedLinkedRepo(fx, { name: 'motir-codegraph' });
    queuedJobs[`${CONNECTED_ORG}/motir-codegraph`] = [stranded(70, 700, FRESH)];

    const outcome = await reconcile();

    expect(outcome.orgs).toEqual([
      { org: CONNECTED_ORG, queued: 1, idleRunners: 0, awaiting: 0, added: 0 },
    ]);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('reads a repo with an intent once, and never a mirror no project uses or an archived one', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedLinkedRepo(fx, { name: 'motir-ai' });
    await seedLinkedRepo(fx, { name: 'unlinked', linked: false });
    await seedLinkedRepo(fx, { name: 'archived', archived: true });
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];

    const outcome = await reconcile();

    expect(outcome.added).toBe(1);
    expect(runsListReads(`${CONNECTED_ORG}/motir-ai`)).toBe(1);
    expect(runsListReads(`${CONNECTED_ORG}/unlinked`)).toBe(0);
    expect(runsListReads(`${CONNECTED_ORG}/archived`)).toBe(0);
    // The repo with an intent keeps the intent's own attribution and installation.
    const minted = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { reconcileGeneration: 1 },
    });
    expect(minted).toMatchObject({ githubRepoId: null, installationId: CONNECTED_INSTALLATION });
  });

  it('reads only the organisations the fleet served: a tenant with no intent is not swept', async () => {
    const served = await seedTenant();
    const other = await seedTenant();
    await seedIntent(served, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedLinkedRepo(other, { owner: 'someone-else', name: 'their-app' });

    await reconcile();

    expect(urls.some((u) => u.includes('someone-else'))).toBe(false);
  });

  it('serves a linked repo in a GitHub org the fleet has no intent in, through the App’s installation there', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    await seedLinkedRepo(fx, { owner: 'acme-co', name: 'acme-api' });
    orgInstallations['acme-co'] = 88003;
    queuedJobs['acme-co/acme-api'] = [stranded(30, 300)];

    const outcome = await reconcile();

    expect(outcome.orgs.find((o) => o.org === 'acme-co')).toEqual({
      org: 'acme-co',
      queued: 1,
      idleRunners: 0,
      awaiting: 0,
      added: 1,
      undeliveredRepos: ['acme-co/acme-api'],
    });
    expect(
      await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({ where: { jobId: '30' } }),
    ).toMatchObject({ installationId: '88003', repoOwner: 'acme-co', repoName: 'acme-api' });
    expect(urls.some((u) => u.includes('/installations/88003/access_tokens'))).toBe(true);
  });

  it('skips a GitHub org the fleet App is not installed on, without an error', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 1 });
    await seedLinkedRepo(fx, { owner: 'acme-co', name: 'acme-api' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];

    const outcome = await reconcile();

    expect(outcome.orgs.map((o) => o.org)).toEqual([MOTIR_ORG]);
    expect(outcome.added).toBe(1);
    expect(urls.some((u) => u.includes('/repos/acme-co/'))).toBe(false);
  });

  it('names a linked repo the fleet cannot read when jobs are left stranded, and only then', async () => {
    const fx = await seedTenant();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedLinkedRepo(fx, { name: 'motir-codegraph' });
    failingRunLists[`${CONNECTED_ORG}/motir-codegraph`] = 404;

    // Quiet tick: nothing stranded, so the unreadable repo is not news.
    const quiet = await reconcile();
    expect(quiet.orgs[0]).not.toHaveProperty('unreadableRepos');
    expect(captureMessage).not.toHaveBeenCalled();

    // A motir-ai job is left with no runner: now the repo nobody can see is named.
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];
    const stalled = await reconcile();

    expect(stalled.orgs).toEqual([
      {
        org: CONNECTED_ORG,
        queued: 1,
        idleRunners: 0,
        awaiting: 0,
        added: 1,
        unreadableRepos: [`${CONNECTED_ORG}/motir-codegraph`],
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot read these linked repos'), {
      org: CONNECTED_ORG,
      repos: [`${CONNECTED_ORG}/motir-codegraph`],
    });
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('unreadable linked repos'),
      expect.objectContaining({
        fingerprint: ['ci-runner-reconcile', 'unreadable', CONNECTED_ORG.toLowerCase()],
      }),
    );
  });

  it('never names a repo with an intent as unreadable', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 7, owner: CONNECTED_ORG, repo: 'motir-ai' });
    await seedIntent(fx, { jobId: 8, owner: CONNECTED_ORG, repo: 'gone' });
    failingRunLists[`${CONNECTED_ORG}/gone`] = 404;
    queuedJobs[`${CONNECTED_ORG}/motir-ai`] = [stranded(7)];

    const outcome = await reconcile();

    expect(outcome.orgs[0]).not.toHaveProperty('unreadableRepos');
  });
});

describe('a runner that served another job does not spend a generation (MOTIR-11437)', () => {
  async function seedGenerations(
    fx: Fixture,
    count: number,
    data: { teardownReason?: string | null; jobPickedUpAt?: Date | null; status?: string },
  ) {
    for (let g = 1; g <= count; g++) {
      await adminDb.ciRunnerProvisioningIntent.create({
        data: {
          ...(await seedIntentData(fx, 9001)),
          reconcileGeneration: g,
          status: data.status ?? 'completed',
          teardownReason: data.teardownReason ?? null,
          jobPickedUpAt: data.jobPickedUpAt ?? null,
        },
      });
    }
  }

  it('keeps minting past five generations whose runners each ran a job (taken, not lost)', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    await seedGenerations(fx, 5, { teardownReason: 'job_completed' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    expect((await reconcile()).added).toBe(1);
    expect(
      await adminDb.ciRunnerProvisioningIntent.count({
        where: { jobId: '9001', reconcileGeneration: 6 },
      }),
    ).toBe(1);
  });

  it('counts a runner seen busy (`jobPickedUpAt`) or timed out on a job as served', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    await seedGenerations(fx, 3, { status: 'failed', jobPickedUpAt: NOW });
    for (const g of [4, 5]) {
      await adminDb.ciRunnerProvisioningIntent.create({
        data: {
          ...(await seedIntentData(fx, 9001)),
          reconcileGeneration: g,
          status: 'failed',
          teardownReason: 'job_timed_out',
        },
      });
    }
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    expect((await reconcile()).added).toBe(1);
  });

  it('still stops at five generations that never served a job (idle, failed boots)', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    await seedGenerations(fx, 2, { status: 'completed', teardownReason: 'runner_idle' });
    for (const g of [3, 4, 5]) {
      await adminDb.ciRunnerProvisioningIntent.create({
        data: {
          ...(await seedIntentData(fx, 9001)),
          reconcileGeneration: g,
          status: 'failed',
          teardownReason: 'provision_failed',
        },
      });
    }
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    expect((await reconcile()).added).toBe(0);
  });

  it('stops at the hard ceiling however many generations were served', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9001 });
    await seedGenerations(fx, 25, { teardownReason: 'job_completed' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9001)];

    expect((await reconcile()).added).toBe(0);
  });
});

describe('the new intents go through the admission gate', () => {
  it('an org at its CI figure DEFERS the reconcile intent instead of exceeding it', async () => {
    const fx = await seedTenant();
    // A staff override of the CI burst cap (MOTIR-9375): one CI job at once.
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 1 },
    });
    await seedIntent(fx, { jobId: 1 });
    await seedIntent(fx, { jobId: 2, status: 'running' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(1)];
    orgRunners[MOTIR_ORG] = [];

    await reconcile();
    const minted = await adminDb.ciRunnerProvisioningIntent.findFirstOrThrow({
      where: { reconcileGeneration: 1 },
    });
    const verdict = await ciRunnerAdmissionService.admit(minted);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    expect(
      (await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: minted.id } }))
        .status,
    ).toBe('pending');
  });
});

describe('fleetQueueClient edges', () => {
  it('answers an empty, UNREADABLE queue for a repository GitHub will not show (404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/access_tokens')) {
          return json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
        }
        if (url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
          return json({ id: Number(PROVISIONING_INSTALLATION) });
        }
        return json({ message: 'Not Found' }, 404);
      }),
    );
    expect(await fleetQueueClient.listQueuedFleetJobs({ owner: MOTIR_ORG, repo: 'gone' })).toEqual({
      jobs: [],
      skippedRuns: [],
      unreadable: true,
    });
  });

  it('raises a typed error on a refusal and on an unreachable GitHub', async () => {
    const respond = (res: () => Response | never) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const url = String(input);
          if (url.includes('/access_tokens')) {
            return json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
          }
          if (url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
            return json({ id: Number(PROVISIONING_INSTALLATION) });
          }
          return res();
        }),
      );
    respond(() => json({ message: 'forbidden' }, 403));
    await expect(fleetQueueClient.listFleetRunners()).rejects.toMatchObject({
      code: 'FLEET_QUEUE_API_FAILED',
      status: 403,
    });
    await expect(
      fleetQueueClient.listQueuedFleetJobs({ owner: MOTIR_ORG, repo: 'r' }),
    ).rejects.toMatchObject({ status: 403 });
    respond(() => {
      throw new TypeError('fetch failed');
    });
    await expect(fleetQueueClient.listFleetRunners()).rejects.toMatchObject({ status: null });
  });

  it('skips a run whose jobs read GitHub cannot be reached for, naming it with a null status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes('/access_tokens')) {
          return json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
        }
        if (url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
          return json({ id: Number(PROVISIONING_INSTALLATION) });
        }
        if (url.includes('/actions/runs/77/jobs')) throw new TypeError('fetch failed');
        if (url.includes('/actions/runs?status=queued'))
          return json({ workflow_runs: [{ id: 77 }] });
        return json({ workflow_runs: [] });
      }),
    );

    expect(await fleetQueueClient.listQueuedFleetJobs({ owner: MOTIR_ORG, repo: 'r' })).toEqual({
      jobs: [],
      skippedRuns: [
        {
          repoOwner: MOTIR_ORG,
          repoName: 'r',
          runId: '77',
          status: null,
          detail: 'GitHub could not be reached for the fleet queue (fetch failed).',
        },
      ],
    });
  });
});

describe('coverage is counted per label set (MOTIR-11727)', () => {
  const minted = () =>
    adminDb.ciRunnerProvisioningIntent.findMany({
      where: { reconcileGeneration: { gt: 0 } },
      orderBy: { jobId: 'asc' },
    });

  it('an idle ORDINARY runner does not cover a queued on-demand job: one intent is minted for it', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9101, requestedLabels: ON_DEMAND });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [{ ...stranded(9101), labels: ON_DEMAND }];
    orgRunners[MOTIR_ORG] = [{ id: 1 }];

    const outcome = await reconcile();

    expect(outcome.orgs).toEqual([
      {
        org: MOTIR_ORG,
        queued: 1,
        idleRunners: 1,
        awaiting: 0,
        added: 1,
        onDemand: { queued: 1, idleRunners: 0, awaiting: 0, added: 1 },
      },
    ]);
    const rows = await minted();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: '9101', reconcileGeneration: 1 });
    // The mint copies the job's labels, so the boot it dispatches is on-demand.
    expect(rows[0]!.requestedLabels).toEqual(ON_DEMAND);
    expect(bootEvents()).toHaveLength(1);
  });

  it('an idle ON-DEMAND runner covers a queued ordinary job when no on-demand job wants it: nothing minted', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9102 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9102)];
    orgRunners[MOTIR_ORG] = [{ id: 1, labels: ON_DEMAND }];

    const outcome = await reconcile();

    expect(outcome.orgs).toEqual([
      {
        org: MOTIR_ORG,
        queued: 1,
        idleRunners: 1,
        awaiting: 0,
        added: 0,
        onDemand: { queued: 0, idleRunners: 1, awaiting: 0, added: 0 },
      },
    ]);
    expect(await minted()).toEqual([]);
    expect(bootEvents()).toEqual([]);
  });

  it('a pending ON-DEMAND intent covers a queued on-demand job: nothing minted', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9103, requestedLabels: ON_DEMAND, status: 'pending' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [{ ...stranded(9103), labels: ON_DEMAND }];

    const outcome = await reconcile();

    expect(outcome.orgs[0]).toMatchObject({
      queued: 1,
      awaiting: 1,
      added: 0,
      onDemand: { queued: 1, idleRunners: 0, awaiting: 1, added: 0 },
    });
    expect(await minted()).toEqual([]);
  });

  it('only an ORDINARY intent pending: the on-demand job is minted for, carrying both labels', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9104, requestedLabels: ON_DEMAND });
    await seedIntent(fx, { jobId: 9105, status: 'pending' });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [{ ...stranded(9104), labels: ON_DEMAND }];

    const outcome = await reconcile();

    expect(outcome.orgs[0]).toMatchObject({
      queued: 1,
      awaiting: 1,
      added: 1,
      onDemand: { queued: 1, idleRunners: 0, awaiting: 0, added: 1 },
    });
    const rows = await minted();
    expect(rows.map((r) => r.jobId)).toEqual(['9104']);
    expect(rows[0]!.requestedLabels).toEqual(['motir-runner', 'motir-on-demand']);
  });

  it('mixed queue: the on-demand surplus covers the OLDEST ordinary jobs, and each partition mints its youngest gaps', async () => {
    const fx = await seedTenant();
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    for (const id of [9201, 9202, 9203, 9204, 9205]) await seedIntent(fx, { jobId: id });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [
      { id: 9201, run_id: 500, created_at: at(20), labels: ON_DEMAND },
      { id: 9202, run_id: 500, created_at: at(19), labels: ON_DEMAND },
      { id: 9203, run_id: 500, created_at: at(18) },
      { id: 9204, run_id: 500, created_at: at(17) },
      { id: 9205, run_id: 500, created_at: at(16) },
    ];
    // 1 idle on-demand runner (covers the older on-demand job), 1 idle ordinary
    // runner (covers the oldest ordinary job) — no surplus is left.
    orgRunners[MOTIR_ORG] = [{ id: 1, labels: ON_DEMAND }, { id: 2 }];

    const outcome = await reconcile();

    expect(outcome.orgs[0]).toMatchObject({
      queued: 5,
      idleRunners: 2,
      awaiting: 0,
      added: 3,
      onDemand: { queued: 2, idleRunners: 1, awaiting: 0, added: 1 },
    });
    expect((await minted()).map((r) => r.jobId)).toEqual(['9202', '9204', '9205']);
  });

  it('jobs, runners and intents carrying only motir-runner report no on-demand counts', async () => {
    const fx = await seedTenant();
    await seedIntent(fx, { jobId: 9301 });
    queuedJobs[`${MOTIR_ORG}/acme-web`] = [stranded(9301)];

    const outcome = await reconcile();

    expect(outcome.orgs[0]).not.toHaveProperty('onDemand');
    expect(outcome.orgs[0]).toMatchObject({ queued: 1, added: 1 });
  });
});

describe('coverPartitions — the per-label-set arithmetic (MOTIR-11727)', () => {
  const none = {
    queuedOnDemand: 0,
    queuedOther: 0,
    idleOnDemand: 0,
    idleOther: 0,
    awaitingOnDemand: 0,
    awaitingOther: 0,
  };

  it('ordinary capacity never covers an on-demand job', () => {
    expect(coverPartitions({ ...none, queuedOnDemand: 2, idleOther: 3, awaitingOther: 3 })).toEqual(
      { uncoveredOnDemand: 2, uncoveredOther: 0, uncoveredPinned: 0 },
    );
  });

  it('on-demand capacity left over after the on-demand jobs covers ordinary ones', () => {
    expect(
      coverPartitions({
        ...none,
        queuedOnDemand: 1,
        queuedOther: 4,
        idleOnDemand: 2,
        awaitingOnDemand: 1,
        idleOther: 1,
      }),
    ).toEqual({ uncoveredOnDemand: 0, uncoveredOther: 1, uncoveredPinned: 0 });
  });

  it('a shortfall of on-demand capacity leaves no surplus for the ordinary jobs', () => {
    expect(
      coverPartitions({
        ...none,
        queuedOnDemand: 3,
        idleOnDemand: 1,
        queuedOther: 2,
        idleOther: 1,
      }),
    ).toEqual({ uncoveredOnDemand: 2, uncoveredOther: 1, uncoveredPinned: 0 });
  });

  it('with no on-demand label anywhere it is the old single subtraction', () => {
    expect(coverPartitions({ ...none, queuedOther: 5, idleOther: 1, awaitingOther: 2 })).toEqual({
      uncoveredOnDemand: 0,
      uncoveredOther: 2,
      uncoveredPinned: 0,
    });
    expect(coverPartitions({ ...none, queuedOther: 1, idleOther: 3 })).toEqual({
      uncoveredOnDemand: 0,
      uncoveredOther: 0,
      uncoveredPinned: 0,
    });
  });
});
