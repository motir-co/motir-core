import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FakeDatabaseControls,
  FakeHostingControls,
  HostingDeployPort,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  previewEffect,
  previewReaper,
  previewStart,
} from '@/lib/jobs/definitions/previewLifecycle';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { PREVIEW_IMAGE_WORKFLOW_PATH } from '@/lib/preview/lifecycleEvents';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import {
  PREVIEW_START_POLLS,
  previewEnvironment,
  previewLifecycleService,
  previewRuntime,
} from '@/lib/services/previewLifecycleService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../helpers/jobs';

// THE PREVIEW LIFECYCLE over real Postgres (Story MOTIR-5766 · MOTIR-5776). The
// deploy port and the database port are the orchestrator's fakes
// (`MOTIR_FLEET_ORCHESTRATOR=fake`); GitHub is `fetch`, served by a recorded
// deployments API, the contents API (the hosting manifest) and the pulls API.
// Every delivery goes in as GitHub sends it, and every effect runs through its
// own job, so the commit-then-effect split is what is tested.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const PROVIDER_REPO_ID = 9001;
const REPO = 'acme-web';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

const MANIFEST = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

interface DeploymentRecord {
  id: number;
  sha: string;
  environment: string;
  transient: boolean;
  statuses: Array<{ state: string; environment_url?: string; description: string }>;
}

let fetches: Array<{ url: string; method: string }>;
let deployments: DeploymentRecord[];
let manifestText: string | null;
let pullState: Map<number, 'open' | 'closed'>;
let jobs: { events: CapturedJobEvent[]; restore: () => void };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      fetches.push({ url: u, method });
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const base = `https://api.github.com/repos/${MOTIR_ORG}/${REPO}`;
      if (u === `${base}/deployments` && method === 'POST') {
        const made: DeploymentRecord = {
          id: 700 + deployments.length,
          sha: body.ref,
          environment: body.environment,
          transient: body.transient_environment,
          statuses: [],
        };
        deployments.push(made);
        return json(201, { id: made.id });
      }
      const status = /\/deployments\/(\d+)\/statuses$/.exec(u);
      if (status && method === 'POST') {
        const target = deployments.find((d) => d.id === Number(status[1]));
        if (!target) return json(404, { message: 'Not Found' });
        target.statuses.push(body);
        return json(201, { id: target.statuses.length });
      }
      if (u.startsWith(`${base}/contents/motir.hosting.json`)) {
        if (manifestText === null) return json(404, { message: 'Not Found' });
        return json(200, {
          type: 'file',
          content: Buffer.from(manifestText).toString('base64'),
        });
      }
      const pull = /\/pulls\/(\d+)$/.exec(u);
      if (pull) {
        const state = pullState.get(Number(pull[1]));
        return state ? json(200, { state }) : json(404, { message: 'Not Found' });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

/** A Motir-created row, realized in Motir's org, hosted on `target`, previews on. */
async function enabledRow(
  fx: WorkItemFixture,
  options: { target?: 'fly' | 'serverless' | 'aws'; enabled?: boolean } = {},
): Promise<{ rowId: string; mirrorId: string }> {
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    create: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: String(PROVIDER_REPO_ID),
      owner: MOTIR_ORG,
      name: REPO,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: REPO }, fx.ctx);
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
  await projectRepoSetService.setHosting(
    row.id,
    { target: options.target ?? 'fly', useCase: 'mvp', size: 'small' },
    fx.ctx,
  );
  if (options.enabled !== false) {
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: { previewPushNamespace: `mh-${row.id}-pv`, previewEnabledAt: new Date() },
    });
  }
  return { rowId: row.id, mirrorId: mirror.id };
}

const delivery = {
  repository: { id: PROVIDER_REPO_ID, name: REPO, owner: { login: MOTIR_ORG } },
  installation: { id: Number(INSTALLATION_ID) },
};

function pr(action: string, number: number, sha: string): Record<string, unknown> {
  return { action, number, pull_request: { number, head: { sha } }, ...delivery };
}

function imageRun(sha: string, number: number, conclusion: string): Record<string, unknown> {
  return {
    action: 'completed',
    workflow_run: {
      path: PREVIEW_IMAGE_WORKFLOW_PATH,
      event: 'pull_request',
      head_sha: sha,
      pull_requests: [{ number }],
      conclusion,
    },
    ...delivery,
  };
}

const fly = () => getHostingDeployPort('fly') as HostingDeployPort & FakeHostingControls;
const neon = () => getDatabasePort('neon') as unknown as FakeDatabaseControls;

async function preview(number = 7) {
  return adminDb.previewDeployment.findFirstOrThrow({ where: { pullRequestNumber: number } });
}

/** Run every job event captured since `from` through its own job. */
async function drain(from = 0): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const event of jobs.events.slice(from)) {
    const fn =
      event.name === 'preview/effect.requested'
        ? previewEffect
        : event.name === 'preview/start.requested'
          ? previewStart
          : null;
    if (!fn) continue;
    const outcome = await new JobTestEngine({ function: fn, events: [event] }).execute();
    if (outcome.error) throw outcome.error;
    results.push(outcome.result);
  }
  return results;
}

/** Open pull request 7 at SHA1 and land its image: a `ready` preview. */
async function readyPreview(fx: WorkItemFixture) {
  const ids = await enabledRow(fx);
  await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
  await drain();
  const mark = jobs.events.length;
  await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));
  await drain(mark);
  return ids;
}

beforeEach(async () => {
  await truncateAuthTables();
  fetches = [];
  deployments = [];
  manifestText = JSON.stringify(MANIFEST);
  pullState = new Map([[7, 'open']]);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  resetHostingFakes();
  resetDatabaseFakes();
  installGitHub();
  jobs = captureJobEvents();
});

afterEach(() => {
  jobs.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('opened → building → ready', () => {
  it('builds, starts on its Neon branch, and posts in_progress then success at the host', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, mirrorId } = await enabledRow(fx);

    expect(await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1))).toMatchObject({
      outcome: 'building',
    });
    const built = await preview();
    expect(built).toMatchObject({
      state: 'building',
      headSha: SHA1,
      repoId: mirrorId,
      host: `pr-7--acme-web.preview.motir.site`,
    });
    // Committed BEFORE any outbound call: the GitHub deployment is the effect's.
    expect(deployments).toEqual([]);
    expect(jobs.events.map((e) => e.name)).toEqual(['preview/effect.requested']);

    await drain();
    expect(deployments).toEqual([
      expect.objectContaining({
        sha: SHA1,
        environment: 'preview/pr-7',
        transient: true,
        statuses: [expect.objectContaining({ state: 'in_progress' })],
      }),
    ]);

    expect(await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'))).toMatchObject({
      outcome: 'starting',
    });
    expect((await preview()).state).toBe('starting');
    expect(await drain(1)).toEqual([{ started: 'deployed', settled: 'ready' }]);

    const ready = await preview();
    expect(ready).toMatchObject({ state: 'ready', flyAppName: `mh-${rowId}-pr7` });
    const app = fly().app(`mh-${rowId}-pr7`)!;
    expect(app.live?.image).toBe(`registry.fake.invalid/mh-${rowId}-pv:${SHA1}`);
    // The preview's environment: its own branch, its own URL, no Google.
    expect(app.live?.env).toMatchObject({
      BETTER_AUTH_URL: `https://${ready.host}`,
      EMAIL_PROVIDER: 'console',
      NODE_ENV: 'production',
    });
    expect(app.live?.env['DATABASE_URL']).toEqual(expect.any(String));
    expect(app.live?.env['DATABASE_URL_UNPOOLED']).toEqual(expect.any(String));
    expect(Object.keys(app.live?.env ?? {})).not.toContain('GOOGLE_CLIENT_ID');
    expect(app.live?.runtime.startCommand).toBe(
      `sh -c 'node migrate.js deploy && exec node server.js'`,
    );
    expect(
      neon()
        .branches()
        .map((b) => b.branch.name),
    ).toEqual(['pr-7']);
    expect(ready.neonBranchId).toEqual(expect.any(String));

    const [deployment] = deployments;
    expect(deployment!.statuses.map((s) => s.state)).toEqual(['in_progress', 'success']);
    expect(deployment!.statuses[1]!.environment_url).toBe(`https://${ready.host}`);

    // The posted status comes back as GitHub's `deployment_status` delivery and
    // lands, through the SHIPPED handler, in `repo_deployment` for the head.
    expect(
      await githubWebhookService.handleDeploymentStatus({
        ...delivery,
        deployment: {
          id: deployment!.id,
          sha: SHA1,
          ref: SHA1,
          environment: deployment!.environment,
        },
        deployment_status: {
          state: 'success',
          environment_url: deployment!.statuses[1]!.environment_url,
          created_at: new Date().toISOString(),
        },
      }),
    ).toEqual({ event: 'deployment_status', outcome: 'recorded' });
    const stored = await adminDb.repoDeployment.findMany({
      where: { repoId: mirrorId, commitSha: SHA1 },
    });
    expect(stored).toEqual([
      expect.objectContaining({
        state: 'success',
        environment: 'preview/pr-7',
        environmentUrl: `https://${ready.host}`,
      }),
    ]);
  });

  it('a new push rebuilds the same row and replaces the release in place', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    const mark = jobs.events.length;

    expect(await previewLifecycleService.onPullRequest(pr('synchronize', 7, SHA2))).toMatchObject({
      outcome: 'building',
    });
    expect(await preview()).toMatchObject({
      state: 'building',
      headSha: SHA2,
      githubDeploymentId: null,
    });
    await previewLifecycleService.onImageRun(imageRun(SHA2, 7, 'success'));
    await drain(mark);

    expect((await preview()).state).toBe('ready');
    expect(fly().app(`mh-${rowId}-pr7`)?.live?.image).toMatch(new RegExp(`:${SHA2}$`));
    expect(deployments.map((d) => d.sha)).toEqual([SHA1, SHA2]);
    expect(await adminDb.previewDeployment.count()).toBe(1);
    // A redelivered head changes nothing.
    expect(await previewLifecycleService.onPullRequest(pr('synchronize', 7, SHA2))).toMatchObject({
      outcome: 'stale',
    });
  });
});

describe('failure', () => {
  it('a failed image build is failed with a reason and a failure status', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await drain();

    expect(await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'cancelled'))).toMatchObject({
      outcome: 'failed',
    });
    const failed = await preview();
    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toMatch(/"cancelled"/);
    await drain(1);
    expect(deployments[0]!.statuses.map((s) => s.state)).toEqual(['in_progress', 'failure']);
    expect(deployments[0]!.statuses[1]!.description).toBe(failed.failureReason!.slice(0, 140));
  });

  it('a release that fails its health check is failed, and left in place', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));

    const started = await previewLifecycleService.start((await preview()).id, SHA1);
    expect(started.status).toBe('deployed');
    fly().setHealth(`mh-${rowId}-pr7`, 'unhealthy');
    if (started.status !== 'deployed') throw new Error('unreachable');
    expect(await previewLifecycleService.checkStart(started.handle)).toBe('unhealthy');
    expect(
      await previewLifecycleService.settleStart((await preview()).id, SHA1, 'unhealthy'),
    ).toEqual({ status: 'failed' });

    expect(await preview()).toMatchObject({
      state: 'failed',
      failureReason: 'The preview started but failed its health check.',
    });
    expect(fly().app(`mh-${rowId}-pr7`)?.live).not.toBeNull();
    // The announce never ran here, so the failure created the deployment itself.
    expect(deployments).toEqual([
      expect.objectContaining({
        sha: SHA1,
        statuses: [expect.objectContaining({ state: 'failure' })],
      }),
    ]);
  });

  it('a release that never turns healthy times out within the bound', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));
    const event = jobs.events.find((e) => e.name === 'preview/start.requested')!;
    const deploy = fly().deploy.bind(fly());
    vi.spyOn(fly(), 'deploy').mockImplementation(async (input) => {
      const handle = await deploy(input);
      fly().setHealth(`mh-${rowId}-pr7`, 'deploying');
      return handle;
    });

    const outcome = await new JobTestEngine({ function: previewStart, events: [event] }).execute();
    expect(outcome.result).toEqual({ started: 'deployed', settled: 'failed' });
    expect(outcome.ctx.step.sleep).toHaveBeenCalledTimes(PREVIEW_START_POLLS - 1);
    expect((await preview()).failureReason).toMatch(/within 10 minutes/);
  });

  it('a repository with no hosting manifest is failed naming the file', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    manifestText = null;
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));
    const started = await previewLifecycleService.start((await preview()).id, SHA1);
    expect(started).toMatchObject({ status: 'failed' });
    expect((await preview()).failureReason).toMatch(/motir\.hosting\.json/);
  });
});

describe('closed', () => {
  it('destroys the app and the branch, posts inactive, and closes the row', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    const mark = jobs.events.length;

    expect(await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1))).toMatchObject({
      outcome: 'closed',
    });
    expect((await preview()).state).toBe('closed');
    // Committed before the effect: the app is still there until the teardown runs.
    expect(fly().app(`mh-${rowId}-pr7`)).toBeDefined();
    await drain(mark);

    expect(fly().app(`mh-${rowId}-pr7`)).toBeUndefined();
    expect(neon().branches()).toEqual([]);
    expect(deployments[0]!.statuses.map((s) => s.state)).toEqual([
      'in_progress',
      'success',
      'inactive',
    ]);
    expect(await preview()).toMatchObject({
      state: 'closed',
      flyAppName: null,
      neonBranchId: null,
    });
  });

  it('a reopened pull request rebuilds its closed row', async () => {
    const fx = await makeWorkItemFixture();
    await readyPreview(fx);
    await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1));
    expect(await previewLifecycleService.onPullRequest(pr('reopened', 7, SHA1))).toMatchObject({
      outcome: 'building',
    });
    expect(await preview()).toMatchObject({ state: 'building', closedAt: null });
  });
});

describe('out of order', () => {
  it('a run for an older head changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onPullRequest(pr('synchronize', 7, SHA2));
    const before = await preview();

    expect(await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'))).toEqual({
      outcome: 'stale',
    });
    expect(await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'failure'))).toEqual({
      outcome: 'stale',
    });
    expect(await preview()).toEqual(before);
    expect(jobs.events.filter((e) => e.name === 'preview/start.requested')).toEqual([]);
  });

  it('every event after closed but a reopen changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await readyPreview(fx);
    await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1));
    await drain();
    const before = await preview();
    const mark = jobs.events.length;

    expect(await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'))).toEqual({
      outcome: 'stale',
    });
    expect(await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1))).toMatchObject({
      outcome: 'stale',
    });
    expect(await previewLifecycleService.start(before.id, SHA1)).toEqual({ status: 'skipped' });
    expect(await previewLifecycleService.settleStart(before.id, SHA1, 'healthy')).toEqual({
      status: 'skipped',
    });
    expect(await previewLifecycleService.runEffect(before.id, 'announce')).toEqual({
      status: 'skipped',
    });
    expect(await preview()).toEqual(before);
    expect(jobs.events.slice(mark)).toEqual([]);
  });

  it('ignores a delivery that is not a preview event', async () => {
    expect(await previewLifecycleService.onPullRequest(pr('labeled', 7, SHA1))).toEqual({
      outcome: 'ignored',
    });
    expect(
      await previewLifecycleService.onImageRun({
        ...imageRun(SHA1, 7, 'success'),
        workflow_run: { path: '.github/workflows/ci.yml', event: 'pull_request' },
      }),
    ).toEqual({ outcome: 'ignored' });
    expect(await previewLifecycleService.onPullRequest(pr('closed', 99, SHA1))).toEqual({
      outcome: 'not_enabled',
    });
  });
});

describe('a repository whose previews are off', () => {
  it('writes no row and makes no outbound call', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx, { enabled: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no outbound call may be made');
      }),
    );
    const port = fly();
    const calls = (['ensureApp', 'deploy', 'destroyApp', 'ensurePushNamespace'] as const).map(
      (method) => vi.spyOn(port, method),
    );

    for (const body of [pr('opened', 7, SHA1), pr('closed', 7, SHA1)]) {
      expect(await previewLifecycleService.onPullRequest(body)).toEqual({ outcome: 'not_enabled' });
    }
    expect(await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'))).toEqual({
      outcome: 'not_enabled',
    });
    // Through the webhook, too: the lifecycle runs beside the status sync.
    await githubWebhookService.handleEvent('workflow_run', imageRun(SHA1, 7, 'success'));

    expect(await adminDb.previewDeployment.count()).toBe(0);
    expect(jobs.events).toEqual([]);
    for (const spy of calls) expect(spy).not.toHaveBeenCalled();
  });
});

describe("the webhook runs the lifecycle beside each event's own handler", () => {
  it('a pull request delivery opens the preview, and the status sync still runs', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    const sync = vi
      .spyOn(githubWebhookService, 'handlePullRequest')
      .mockResolvedValue({ event: 'ignored', reason: 'stubbed' });
    expect(await githubWebhookService.handleEvent('pull_request', pr('opened', 7, SHA1))).toEqual({
      event: 'ignored',
      reason: 'stubbed',
    });
    expect(sync).toHaveBeenCalledOnce();
    expect((await preview()).state).toBe('building');
  });

  it('a lifecycle failure never fails the delivery', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(previewLifecycleService, 'onPullRequest').mockRejectedValue(new Error('boom'));
    vi.spyOn(previewLifecycleService, 'onImageRun').mockRejectedValue('not an error');
    vi.spyOn(githubWebhookService, 'handlePullRequest').mockResolvedValue({
      event: 'ignored',
      reason: 'stubbed',
    });
    vi.spyOn(githubWebhookService, 'handleWorkflowRun').mockResolvedValue({
      event: 'workflow_run',
      outcome: 'ignored_action',
    });
    await githubWebhookService.handleEvent('pull_request', pr('opened', 7, SHA1));
    await githubWebhookService.handleEvent('workflow_run', imageRun(SHA1, 7, 'success'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('preview lifecycle failed'),
      expect.objectContaining({ eventType: 'pull_request', error: 'boom' }),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('preview lifecycle failed'),
      expect.objectContaining({ eventType: 'workflow_run', error: 'unknown' }),
    );
  });
});

describe('the reaper', () => {
  const later = () => new Date(Date.now() + 2 * 60 * 60_000);

  it('finishes a teardown a crash interrupted between commit and effect', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    const mark = jobs.events.length;
    await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1));
    fly().failNext('destroyApp');
    await expect(drain(mark)).rejects.toThrow();
    expect(await preview()).toMatchObject({ state: 'closed', flyAppName: `mh-${rowId}-pr7` });

    const outcome = await new JobTestEngine({ function: previewReaper }).execute();
    expect(outcome.result).toMatchObject({ teardownsFinished: 1, failed: 0 });
    expect(fly().app(`mh-${rowId}-pr7`)).toBeUndefined();
    expect(neon().branches()).toEqual([]);
    expect(await preview()).toMatchObject({ flyAppName: null, neonBranchId: null });
  });

  it('closes a preview whose pull request closed with no delivery', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    pullState.set(7, 'closed');

    expect(await previewLifecycleService.reap({ now: later })).toMatchObject({ closed: 1 });
    expect(await preview()).toMatchObject({ state: 'closed', flyAppName: null });
    expect(fly().app(`mh-${rowId}-pr7`)).toBeUndefined();
  });

  it('leaves an open one alone and moves on past it', async () => {
    const fx = await makeWorkItemFixture();
    await readyPreview(fx);
    const before = await preview();
    expect(await previewLifecycleService.reap({ now: later })).toEqual({
      teardownsFinished: 0,
      closed: 0,
      announced: 0,
      startsAbandoned: 0,
      failed: 0,
    });
    const after = await preview();
    expect(after.state).toBe('ready');
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it('announces a deployment that was never made, and fails an abandoned start', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    pullState.set(8, 'open');
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onPullRequest(pr('opened', 8, SHA2));
    await previewLifecycleService.onImageRun(imageRun(SHA2, 8, 'success'));

    expect(await previewLifecycleService.reap({ now: later })).toMatchObject({
      announced: 1,
      startsAbandoned: 1,
    });
    expect((await preview(7)).githubDeploymentId).toEqual(expect.any(String));
    expect(await preview(8)).toMatchObject({ state: 'failed' });
    expect(deployments.map((d) => [d.sha, d.statuses.map((s) => s.state)])).toEqual([
      [SHA1, ['in_progress']],
      [SHA2, ['failure']],
    ]);
  });

  it('closes a preview whose repository previews were switched off, and counts a failure', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    await adminDb.projectRepo.update({ where: { id: rowId }, data: { previewEnabledAt: null } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fly().failNext('destroyApp');

    expect(await previewLifecycleService.reap({ now: later })).toMatchObject({
      closed: 1,
      failed: 1,
    });
    expect((await preview()).state).toBe('closed');
    // The next pass finishes it.
    expect(await previewLifecycleService.reap({ now: later })).toMatchObject({
      teardownsFinished: 1,
    });
  });
});

describe('teardownRepository (the takeover step)', () => {
  it('closes every open preview, then destroys the image app and the Neon preview project', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 8, SHA2));
    await fly().ensurePushNamespace({ repositoryId: rowId, kind: 'preview' });

    const result = await previewLifecycleService.teardownRepository(rowId, {
      pushNamespace: `mh-${rowId}-pv`,
    });
    expect(result.closed).toBe(2);
    expect(result.usage.length).toBeGreaterThan(0);
    const rows = await adminDb.previewDeployment.findMany();
    expect(rows.map((r) => r.state)).toEqual(['closed', 'closed']);
    expect(fly().app(`mh-${rowId}-pr7`)).toBeUndefined();
    expect(fly().pushNamespaces()).toEqual([]);
    expect(neon().databases()).toEqual([]);
  });

  it('is a no-op for a row with no repository', async () => {
    expect(
      await previewLifecycleService.teardownRepository('cmnosuchrow', { pushNamespace: null }),
    ).toEqual({ closed: 0, usage: [] });
  });
});

describe('what a release runs', () => {
  it('runs a database-free app as its start command alone', () => {
    expect(
      previewRuntime({
        ...MANIFEST,
        targets: ['fly'],
        database: { kind: 'none' },
      } as never).startCommand,
    ).toBe('node server.js');
  });

  it('quotes a migration command that carries a quote', () => {
    expect(
      previewRuntime({
        ...MANIFEST,
        database: { kind: 'postgres', migrateCommand: "echo 'x'" },
      } as never).startCommand,
    ).toBe(`sh -c 'echo '\\''x'\\'' && exec node server.js'`);
  });

  it('derives a stable, per-preview auth secret and adds the unpooled URL', () => {
    const env = (previewId: string) =>
      previewEnvironment({
        previewId,
        host: 'pr-1--x.preview.motir.site',
        databaseEnv: [
          { name: 'DATABASE_URL', value: 'postgres://pooled', secret: true },
          { name: 'DIRECT_URL', value: 'postgres://direct', secret: true },
        ],
        secretKey: 'k',
      });
    const secret = (previewId: string) =>
      env(previewId).find((v) => v.name === 'BETTER_AUTH_SECRET')!.value;
    expect(secret('a')).toBe(secret('a'));
    expect(secret('a')).not.toBe(secret('b'));
    expect(env('a').find((v) => v.name === 'DATABASE_URL_UNPOOLED')?.value).toBe(
      'postgres://direct',
    );
    expect(
      previewEnvironment({ previewId: 'a', host: 'h', databaseEnv: [], secretKey: 'k' }).map(
        (v) => v.name,
      ),
    ).not.toContain('DATABASE_URL_UNPOOLED');
  });
});

describe('edges a delivery or a job can reach', () => {
  it('a repository Motir does not mirror, under a known installation, is not enabled', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    const body = { ...pr('opened', 7, SHA1), repository: { id: 123456, name: 'other' } };
    expect(await previewLifecycleService.onPullRequest(body)).toEqual({ outcome: 'not_enabled' });
    expect(await adminDb.previewDeployment.count()).toBe(0);
  });

  it('a close for a pull request that never had a preview is ignored', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    expect(await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1))).toEqual({
      outcome: 'ignored',
    });
  });

  it('a job for a row that no longer exists does nothing', async () => {
    expect(await previewLifecycleService.runEffect('cmnosuchrow', 'announce')).toEqual({
      status: 'skipped',
    });
    expect(await previewLifecycleService.runEffect('cmnosuchrow', 'teardown')).toEqual({
      status: 'skipped',
      usage: [],
    });
    expect(await previewLifecycleService.start('cmnosuchrow', SHA1)).toEqual({ status: 'skipped' });
    expect(await previewLifecycleService.settleStart('cmnosuchrow', SHA1, 'healthy')).toEqual({
      status: 'skipped',
    });
    expect(fetches).toEqual([]);
  });

  it('reports a failure only for a failed row, with a default reason when it has none', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    const { id } = await preview();
    expect(await previewLifecycleService.runEffect(id, 'report_failure')).toEqual({
      status: 'skipped',
    });

    await adminDb.previewDeployment.update({
      where: { id },
      data: { state: 'failed', failureReason: null },
    });
    expect(await previewLifecycleService.runEffect(id, 'report_failure')).toEqual({
      status: 'reported',
    });
    expect(deployments[0]!.statuses).toEqual([
      expect.objectContaining({ state: 'failure', description: 'The preview could not start.' }),
    ]);
  });

  it('a start whose repository previews were switched off meanwhile is skipped', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));
    await adminDb.projectRepo.update({ where: { id: rowId }, data: { previewEnabledAt: null } });

    expect(await previewLifecycleService.start((await preview()).id, SHA1)).toEqual({
      status: 'skipped',
    });
    expect(fly().app(`mh-${rowId}-pr7`)).toBeUndefined();
  });

  it('an AWS preview gets no Neon branch and runs always on, as a container', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx, { target: 'aws' });
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));
    const aws = getHostingDeployPort('aws');
    const deploy = vi.spyOn(aws, 'deploy');

    const started = await previewLifecycleService.start((await preview()).id, SHA1);
    expect(started.status).toBe('deployed');
    expect(deploy).toHaveBeenCalledWith(
      expect.objectContaining({ idle: { mode: 'always_on' }, shape: 'container' }),
    );
    expect(neon().branches()).toEqual([]);
    expect(await preview()).toMatchObject({ neonBranchId: null, neonProjectId: null });
  });

  it('names a non-Error refusal in the failure reason', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await previewLifecycleService.onImageRun(imageRun(SHA1, 7, 'success'));
    vi.spyOn(fly(), 'ensureApp').mockRejectedValue('quota reached');

    expect(await previewLifecycleService.start((await preview()).id, SHA1)).toEqual({
      status: 'failed',
      reason: 'Motir could not start the preview: quota reached',
    });
  });

  it('a settle for a row that is no longer starting changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await readyPreview(fx);
    const { id } = await preview();
    const posted = deployments[0]!.statuses.length;
    expect(await previewLifecycleService.settleStart(id, SHA1, 'healthy')).toEqual({
      status: 'skipped',
    });
    expect(await previewLifecycleService.settleStart(id, SHA1, 'unhealthy')).toEqual({
      status: 'skipped',
    });
    expect(await preview()).toMatchObject({ state: 'ready', failureReason: null });
    expect(deployments[0]!.statuses).toHaveLength(posted);
  });

  it('closes a row that never started: no app to destroy, inactive still posted', async () => {
    const fx = await makeWorkItemFixture();
    await enabledRow(fx);
    await previewLifecycleService.onPullRequest(pr('opened', 7, SHA1));
    await drain();
    const mark = jobs.events.length;
    await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1));

    expect(await drain(mark)).toEqual([{ status: 'torn_down', usage: [] }]);
    expect(deployments[0]!.statuses.map((s) => s.state)).toEqual(['in_progress', 'inactive']);
  });

  it('an inactive status GitHub refuses is logged, and the teardown still finishes', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    deployments = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mark = jobs.events.length;
    await previewLifecycleService.onPullRequest(pr('closed', 7, SHA1));

    const [result] = (await drain(mark)) as Array<{ status: string }>;
    expect(result!.status).toBe('torn_down');
    expect(fly().app(`mh-${rowId}-pr7`)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[previewLifecycle] inactive status not posted',
      expect.objectContaining({ previewId: (await preview()).id }),
    );
  });

  it('the reaper closes a row whose repository is in no project, and cannot tear it down', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await readyPreview(fx);
    await adminDb.projectRepo.update({ where: { id: rowId }, data: { githubRepoId: null } });

    expect(
      await previewLifecycleService.reap({ now: () => new Date(Date.now() + 2 * 60 * 60_000) }),
    ).toMatchObject({ closed: 1, failed: 0 });
    expect(await preview()).toMatchObject({ state: 'closed', flyAppName: `mh-${rowId}-pr7` });
    expect(await previewLifecycleService.teardown((await preview()).id)).toEqual({
      status: 'unresolvable',
      usage: [],
    });
  });
});
