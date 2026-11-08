import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerReconcileService } from '@/lib/services/ciRunnerReconcileService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import { fleetQueueClient } from '@/lib/github/fleetQueue';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { fakeOrchestrator } from '@motir/orchestrator';
import { captureJobEvents, type CapturedJobEvent } from '../helpers/jobs';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
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
let urls: string[];

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
      if (url.includes('/access_tokens')) {
        return json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      const runs = path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/);
      if (runs) {
        const jobs = queuedJobs[runs[1]!] ?? [];
        const status = new URL(url).searchParams.get('status');
        const ids = [...new Set(jobs.map((j) => j.run_id))];
        return json({ workflow_runs: status === 'queued' ? ids.map((id) => ({ id })) : [] });
      }
      const runJobs = path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/jobs$/);
      if (runJobs) {
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
      requestedLabels: [MOTIR_RUNNER_LABEL],
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
  urls = [];
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
  it('answers an empty queue for a repository GitHub no longer knows (404)', async () => {
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
    expect(await fleetQueueClient.listQueuedFleetJobs({ owner: MOTIR_ORG, repo: 'gone' })).toEqual(
      [],
    );
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
});
