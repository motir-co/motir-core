import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  FAKE_HOSTING_STATE_PATH_ENV,
  ORIGIN_SECRET_HEADER,
  createFakeHostingDeployPort,
  deriveOriginSecret,
  type FakeDatabaseControls,
  type FakeHostingControls,
  type HostingDeployPort,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { previewEnablementSweep } from '@/lib/jobs/definitions/previewEnablementSweep';
import { previewEffect, previewStart } from '@/lib/jobs/definitions/previewLifecycle';
// The composition root, as the lifecycle loads it: it binds the preview meter to
// the ports' destroys, so a teardown's usage reaches the pool through it.
import {
  getDatabasePort,
  getHostingDeployPort,
  resetDatabaseFakes,
  resetHostingFakes,
} from '@/lib/orchestrator';
import { hostingFakeControls, hostingOriginSecretKey } from '@/lib/orchestrator/hosting';
import { previewHostName } from '@/lib/preview/hostName';
import { PREVIEW_IMAGE_WORKFLOW_PATH } from '@/lib/preview/lifecycleEvents';
import { previewUrl } from '@/lib/preview/url';
import { previewDeploymentRepository } from '@/lib/repositories/previewDeploymentRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { previewGateService, resetPreviewRouteCache } from '@/lib/services/previewGateService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_WORKSPACE_ROLE_TIER } from '@/lib/workspaces/roles';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../helpers/jobs';
import {
  startPreviewUpstreamStandIn,
  type PreviewUpstreamStandIn,
} from '../helpers/previewUpstreamStandIn';
import {
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../helpers/repositoryActionsConfigFake';

// THE STORY GATE for Motir's pull-request previews (Story MOTIR-5766 ·
// MOTIR-5780), over real Postgres. Each card's own suite proves its card; this
// one proves the SEAMS between them, by driving one preview through the shipped
// code end to end — switched on by the enablement service (MOTIR-5775), built,
// started and torn down by the lifecycle (MOTIR-5776) through the real webhook
// dispatcher, metered at its teardown (MOTIR-5777), read into the Development
// block's pull-request row (MOTIR-10099) and served by the gate (MOTIR-5779).
//
// THE DISPLAY SEAM is `preview_deployment` → the row's `preview` on BOTH of the
// Development block's reads (`listLinkedPullRequests` and `listDeliverySet`).
// `repo_deployment` is NOT a display path: nothing in the product reads it since
// How to test's per-repository preview was retired (MOTIR-5691). The one case
// that visits it proves GitHub's record of what Motir posted, and says so.
//
// Two seams cross a PROCESS boundary in the E2E lane — a job worker deploys, the
// web server routes — and are asserted here over two fake hosting instances
// sharing one store file (MOTIR-10098), plus the upstream override reaching
// `route()` from the other instance's write (MOTIR-10100).
//
// It holds the story's five guards:
//
//   1. a teardown leaves nothing: no app, no Neon branch, the row closed and
//      served as closed;
//   2. the gate is a PERMISSION check, never a role name;
//   3. `preview_deployment` and `preview_usage` are tenant-isolated under RLS;
//   4. only a Motir-hosted repository is ever touched — a connected one makes
//      no outbound call at all;
//   5. no Fly type or name leaks into the story's code outside the adapter, and
//      no story file builds a hosting port itself.
//
// The source sweeps (guards 2 and 5, and the display-path sweep) RE-ENUMERATE
// their files at run time — every file whose path names a preview, beside the
// roots listed by name — and each states its pattern and roots beside its result:
// a sweep's silence is a result about the files it ran over, never a claim that
// the surface is complete.
//
// The deploy and database ports are the orchestrator's fakes
// (`MOTIR_FLEET_ORCHESTRATOR=fake`); GitHub and motir-ai are `fetch`.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const PROVIDER_REPO_ID = 9001;
const REPO = 'acme-web';
const SHA = 'a'.repeat(40);
const NOW = new Date('2026-07-15T12:00:00.000Z');
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');

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
  statuses: Array<{ state: string; environment_url?: string; description: string }>;
}

let fetches: Array<{ url: string; method: string }>;
let deployments: DeploymentRecord[];
let github: RepositoryActionsConfigFake;
let orgVariables: ActionsVariableFake;
let jobs: { events: CapturedJobEvent[]; restore: () => void };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** GitHub as the whole story speaks to it — the Actions secrets and variables
 *  enablement writes, the deployments API the lifecycle posts to, the hosting
 *  manifest and the pull request — and motir-ai's pool charge. */
function installOutbound(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      fetches.push({ url: u, method });
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const repoConfig = await github.handle(u, method, rawBody);
      if (repoConfig) return repoConfig;
      const orgVariable = orgVariables.handle(u, method, rawBody ? JSON.parse(rawBody) : null);
      if (orgVariable) return orgVariable;
      const body = rawBody ? JSON.parse(rawBody) : null;
      const base = `https://api.github.com/repos/${MOTIR_ORG}/${REPO}`;
      if (u === `${base}/deployments` && method === 'POST') {
        const made = {
          id: 700 + deployments.length,
          sha: body.ref,
          environment: body.environment,
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
        return json(200, {
          type: 'file',
          content: Buffer.from(JSON.stringify(MANIFEST)).toString('base64'),
        });
      }
      if (/\/pulls\/\d+$/.test(u)) return json(200, { state: 'open' });
      // `attachRealizedRepo`'s post-commit collaborator invitation (MOTIR-1900).
      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/collaborators/')) return json(201, { id: 1, html_url: 'https://x' });
      if (u.includes('/v1/usage')) return json(200, { balance: 1000 });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

const fly = () => getHostingDeployPort('fly') as HostingDeployPort & FakeHostingControls;
const neon = () => getDatabasePort('neon') as unknown as FakeDatabaseControls;

/** A Motir-created repository row, realized in Motir's org and hosted on Fly —
 *  previews NOT yet on: switching them on is the enablement service's. */
async function motirRow(fx: WorkItemFixture): Promise<{ rowId: string; mirrorId: string }> {
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
    { target: 'fly', useCase: 'mvp', size: 'small' },
    fx.ctx,
  );
  return { rowId: row.id, mirrorId: mirror.id };
}

/** A row the organisation CONNECTED — its own repository, under its own
 *  installation, hosted on Fly all the same. */
async function connectedRow(fx: WorkItemFixture): Promise<string> {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: '990011',
      workspaceId: fx.workspaceId,
      accountLogin: 'yue-personal',
      accountType: 'User',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: '9002',
      owner: 'yue-personal',
      name: REPO,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name: REPO }, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
  await projectRepoSetService.setHosting(
    row.id,
    { target: 'fly', useCase: 'mvp', size: 'small' },
    fx.ctx,
  );
  return row.id;
}

const delivery = {
  repository: { id: PROVIDER_REPO_ID, name: REPO, owner: { login: MOTIR_ORG } },
  installation: { id: Number(INSTALLATION_ID) },
};

function pr(action: string, sha = SHA, on = delivery): Record<string, unknown> {
  return { action, number: 7, pull_request: { number: 7, head: { sha } }, ...on };
}

function imageRun(sha = SHA, on = delivery): Record<string, unknown> {
  return {
    action: 'completed',
    workflow_run: {
      path: PREVIEW_IMAGE_WORKFLOW_PATH,
      event: 'pull_request',
      head_sha: sha,
      pull_requests: [{ number: 7 }],
      conclusion: 'success',
    },
    ...on,
  };
}

/** Run every job event captured since `from` through its own job. */
async function drain(from = 0): Promise<void> {
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
  }
}

async function preview() {
  return adminDb.previewDeployment.findFirstOrThrow({ where: { pullRequestNumber: 7 } });
}

/** Switch previews on through the enablement service, open pull request 7 through
 *  the webhook and land its image: a `ready` preview, every hop the shipped one. */
async function readyPreview(fx: WorkItemFixture) {
  const ids = await motirRow(fx);
  expect((await previewEnablementService.enable(ids.rowId)).outcome).toBe('enabled');
  vi.spyOn(githubWebhookService, 'handlePullRequest').mockResolvedValue({
    event: 'ignored',
    reason: 'the status sync is not this story’s',
  });
  vi.spyOn(githubWebhookService, 'handleWorkflowRun').mockResolvedValue({
    event: 'workflow_run',
    outcome: 'ignored_action',
  });
  await githubWebhookService.handleEvent('pull_request', pr('opened'));
  await drain();
  const mark = jobs.events.length;
  await githubWebhookService.handleEvent('workflow_run', imageRun());
  await drain(mark);
  const row = await preview();
  expect(row.state).toBe('ready');
  return { ...ids, row };
}

/** The host the lifecycle POSTED to GitHub as the deployment's URL. */
function postedHost(): string {
  const posted = deployments[0]!.statuses.find((s) => s.state === 'success')!.environment_url!;
  return new URL(posted).host;
}

/** Pull request 7 of `repoId`, linked to a fresh card through its delivery set —
 *  the way a run's `link_pull_request` leaves it — and any number of siblings. */
async function linkedCard(
  fx: WorkItemFixture,
  pulls: ReadonlyArray<{ repoId: string; number: number }>,
) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Preview the invoices page' },
    fx.ctx,
  );
  const ids: string[] = [];
  for (const { repoId, number } of pulls) {
    const pull = await adminDb.githubPullRequest.create({
      data: {
        repoId,
        number,
        title: `Change ${number}`,
        state: 'open',
        headRef: `subtask/ACME-${number}`,
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pull.id,
        repoId,
      },
    });
    ids.push(pull.id);
  }
  return { item, pullRequestIds: ids };
}

async function user(tag: string) {
  return usersService.createUser({ email: `${tag}@ex.com`, password: 'hunter2hunter2', name: tag });
}

async function asAppRole<T>(
  workspaceId: string,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

function alignFakeClocks(): void {
  for (const target of ['fly', 'serverless', 'aws'] as const) {
    const fake = getHostingDeployPort(target) as HostingDeployPort & FakeHostingControls;
    fake.advanceSeconds((NOW.getTime() - fake.now().getTime()) / 1000);
  }
  neon().setClock(NOW);
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.previewGateAdmission.deleteMany();
  fetches = [];
  deployments = [];
  github = createRepositoryActionsConfigFake();
  orgVariables = createActionsVariableFake(MOTIR_ORG);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  vi.stubEnv('MOTIR_HOSTING_GATE_SIGNING_KEY', 'test-gate-signing-key');
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  resetHostingFakes();
  resetDatabaseFakes();
  resetPreviewRouteCache();
  alignFakeClocks();
  installOutbound();
  jobs = captureJobEvents();
});

afterEach(() => {
  jobs.restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('seam 1 — enablement → lifecycle', () => {
  it('an opened pull request on a switched-on repository records one building preview and asks for its effect', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await motirRow(fx);
    expect((await previewEnablementService.enable(rowId)).outcome).toBe('enabled');
    const synced = { event: 'ignored', reason: 'the status sync is not this story’s' } as const;
    vi.spyOn(githubWebhookService, 'handlePullRequest').mockResolvedValue(synced);

    expect(await githubWebhookService.handleEvent('pull_request', pr('opened'))).toEqual(synced);

    const rows = await adminDb.previewDeployment.findMany();
    expect(rows).toEqual([
      expect.objectContaining({
        state: 'building',
        headSha: SHA,
        pullRequestNumber: 7,
        host: previewHostName({
          pullRequestNumber: 7,
          repositoryName: REPO,
          repositoryId: rowId,
          domain: 'preview.motir.site',
        }),
      }),
    ]);
    // The row is committed and the effect REQUESTED before anything leaves Motir:
    // the only job event is the lifecycle's effect, and GitHub has heard nothing yet.
    expect(jobs.events.map((e) => e.name)).toEqual(['preview/effect.requested']);
    expect(deployments).toEqual([]);

    // The effect, run, creates the one deployment on that head.
    await drain();
    expect(deployments.map((d) => ({ sha: d.sha, environment: d.environment }))).toEqual([
      { sha: SHA, environment: 'preview/pr-7' },
    ]);
  });

  it('a delivery for a repository never switched on touches nothing, and still answers the sync’s own result', async () => {
    const fx = await makeWorkItemFixture();
    await motirRow(fx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no outbound call may be made for a repository previews are off on');
      }),
    );
    const synced = { event: 'ignored', reason: 'the status sync is not this story’s' } as const;
    vi.spyOn(githubWebhookService, 'handlePullRequest').mockResolvedValue(synced);

    expect(await githubWebhookService.handleEvent('pull_request', pr('opened'))).toEqual(synced);
    expect(fetch).not.toHaveBeenCalled();
    expect(await adminDb.previewDeployment.count()).toBe(0);
    expect(deployments).toEqual([]);
    expect(jobs.events).toEqual([]);
  });

  it('a repository the enablement service switched on gets a preview for its pull request', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId, row } = await readyPreview(fx);
    // What enablement wrote is what the lifecycle pushed to and started from.
    expect(fly().pushNamespaces()).toEqual([`mh-${rowId}-pv`]);
    expect(fly().app(row.flyAppName!)?.live?.image).toBe(
      `registry.fake.invalid/mh-${rowId}-pv:${SHA}`,
    );
  });

  it('the hourly sweep switches on a repository established before previews, and its next pull request builds', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await motirRow(fx);
    const swept = await new JobTestEngine({ function: previewEnablementSweep }).execute();
    expect(swept.error).toBeUndefined();
    expect(swept.result).toEqual({ rows: [{ repositoryId: rowId, outcome: 'enabled' }] });

    expect(await previewLifecycleService.onPullRequest(pr('opened'))).toMatchObject({
      outcome: 'building',
    });
    // A second tick with nothing due visits nothing.
    expect(
      (await new JobTestEngine({ function: previewEnablementSweep }).execute()).result,
    ).toEqual({ rows: [] });
  });

  it('a repository never switched on is ignored: no row, no job, no deployment', async () => {
    const fx = await makeWorkItemFixture();
    await motirRow(fx);
    expect(await previewLifecycleService.onPullRequest(pr('opened'))).toEqual({
      outcome: 'not_enabled',
    });
    expect(await previewLifecycleService.onImageRun(imageRun())).toEqual({
      outcome: 'not_enabled',
    });
    expect(await adminDb.previewDeployment.count()).toBe(0);
    expect(jobs.events).toEqual([]);
    expect(deployments).toEqual([]);
  });

  it('a repository switched on and then off again is ignored the same way', async () => {
    const fx = await makeWorkItemFixture();
    const { rowId } = await motirRow(fx);
    await previewEnablementService.enable(rowId);
    expect(await previewEnablementService.disable(rowId)).toBe('disabled');
    expect(await previewLifecycleService.onPullRequest(pr('opened'))).toEqual({
      outcome: 'not_enabled',
    });
    expect(await adminDb.previewDeployment.count()).toBe(0);
  });
});

describe('seam 2 — the lifecycle’s row → the Development block’s pull-request row, on both reads', () => {
  it('the linked read and the delivery set carry the lifecycle’s row as one fact, with its composed address', async () => {
    const fx = await makeWorkItemFixture();
    const { mirrorId, row } = await readyPreview(fx);
    const { item } = await linkedCard(fx, [{ repoId: mirrorId, number: 7 }]);
    const expected = {
      state: row.state,
      host: row.host,
      failureReason: row.failureReason,
      url: previewUrl(row.host),
    };

    const [linked] = await workItemsService.listLinkedPullRequests(item.id, fx.ctx);
    expect(linked!.preview).toEqual(expected);
    // The delivery set is the block's second source: a row that reaches the surface
    // through it alone must carry the same preview, spelled the same way.
    const [member] = await workItemsService.listDeliverySet(item.id, fx.ctx);
    expect(member!.pullRequest.preview).toEqual(expected);
  });

  it('a pull request with no preview record answers null on both reads', async () => {
    const fx = await makeWorkItemFixture();
    const { mirrorId } = await motirRow(fx);
    const { item } = await linkedCard(fx, [{ repoId: mirrorId, number: 7 }]);
    expect(await adminDb.previewDeployment.count()).toBe(0);

    const [linked] = await workItemsService.listLinkedPullRequests(item.id, fx.ctx);
    expect(linked!.preview).toBeNull();
    const [member] = await workItemsService.listDeliverySet(item.id, fx.ctx);
    expect(member!.pullRequest.preview).toBeNull();
  });

  it('three pull requests in three states are read in ONE call naming all three pairs', async () => {
    const fx = await makeWorkItemFixture();
    const { mirrorId, row } = await readyPreview(fx);
    for (const [number, state] of [
      [8, 'building'],
      [9, 'failed'],
    ] as const) {
      await adminDb.previewDeployment.create({
        data: {
          workspaceId: fx.workspaceId,
          repoId: mirrorId,
          pullRequestNumber: number,
          headSha: SHA,
          host: row.host.replace('pr-7--', `pr-${number}--`),
          state,
          failureReason: state === 'failed' ? 'The preview could not start.' : null,
        },
      });
    }
    const { item, pullRequestIds } = await linkedCard(fx, [
      { repoId: mirrorId, number: 7 },
      { repoId: mirrorId, number: 8 },
      { repoId: mirrorId, number: 9 },
    ]);
    const read = vi.spyOn(previewDeploymentRepository, 'listForPullRequests');

    const rows = await workItemsService.listLinkedPullRequests(item.id, fx.ctx);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      [...read.mock.calls[0]![0]].sort((a, b) => a.pullRequestNumber - b.pullRequestNumber),
    ).toEqual([
      { repoId: mirrorId, pullRequestNumber: 7 },
      { repoId: mirrorId, pullRequestNumber: 8 },
      { repoId: mirrorId, pullRequestNumber: 9 },
    ]);
    const stateOf = new Map(rows.map((r) => [r.id, r.preview?.state]));
    expect(pullRequestIds.map((id) => stateOf.get(id))).toEqual(['ready', 'building', 'failed']);

    read.mockClear();
    await workItemsService.listDeliverySet(item.id, fx.ctx);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toHaveLength(3);
  });

  it('nothing that supplies the row’s preview reads repo_deployment', () => {
    // Re-enumerated: every file under the product roots that names the row's
    // preview read, its mapper, its composer or its element.
    const pattern =
      /readPreviewsForPullRequests|toLinkedPullRequestPreviewDto|previewUrl\(|<PreviewLine\b/;
    const roots = ['lib', 'components', 'app'];
    const suppliers = sourceFiles(roots)
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file))
      .sort();
    expect(suppliers).toEqual(
      expect.arrayContaining([
        'components/github/DevelopmentSection.tsx',
        'lib/mappers/githubMappers.ts',
        'lib/services/workItemsService.ts',
      ]),
    );
    const offenders = suppliers.filter((file) =>
      /repoDeploymentRepository/.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );
    expect({ pattern: pattern.source, roots, suppliers, offenders }).toEqual({
      pattern: pattern.source,
      roots,
      suppliers,
      offenders: [],
    });
    expect(readFileSync(join(REPO_ROOT, 'lib/services/workItemsService.ts'), 'utf8')).toMatch(
      /previewDeploymentRepository\.listForPullRequests/,
    );
  });
});

// ⚠️ GITHUB'S RECORD, NOT A DISPLAY PATH. `repo_deployment` has had no reader in
// the product since How to test's per-repository preview was retired (MOTIR-5691,
// `design/github/design-notes.md` § 25). This case stays because it is the one
// place proving the statuses Motir POSTS survive the shipped handler; what a
// reader sees of a preview comes from `preview_deployment` (seam 2).
describe('seam 3 — GitHub’s record of what Motir posted: the lifecycle’s status → deployment_status → repo_deployment', () => {
  it('the success status the lifecycle posts is recorded against the head, at the preview host — GitHub’s record, not the display path', async () => {
    const fx = await makeWorkItemFixture();
    const { mirrorId, row } = await readyPreview(fx);
    const [deployment] = deployments;
    const success = deployment!.statuses.find((s) => s.state === 'success')!;

    // GitHub echoes the posted status back as a delivery, into the webhook's
    // own dispatcher — not the handler called directly.
    expect(
      await githubWebhookService.handleEvent('deployment_status', {
        ...delivery,
        deployment: {
          id: deployment!.id,
          sha: SHA,
          ref: SHA,
          environment: deployment!.environment,
        },
        deployment_status: {
          state: success.state,
          environment_url: success.environment_url,
          created_at: NOW.toISOString(),
        },
      }),
    ).toEqual({ event: 'deployment_status', outcome: 'recorded' });

    expect(await adminDb.repoDeployment.findMany({ where: { repoId: mirrorId } })).toEqual([
      expect.objectContaining({
        commitSha: SHA,
        state: 'success',
        environment: 'preview/pr-7',
        environmentUrl: `https://${row.host}`,
      }),
    ]);
  });
});

describe('seam 4 — the lifecycle’s row → serving, under the host it posted', () => {
  it('the gate finds the preview by the posted host and routes it to the release', async () => {
    const fx = await makeWorkItemFixture();
    const { row } = await readyPreview(fx);
    const host = postedHost();
    expect(host).toBe(row.host);

    const route = await previewGateService.route(host);
    expect(route).toMatchObject({ state: 'ready', target: 'fly' });
    expect(route?.upstream?.origin).toBe(`https://${row.flyAppName}.fake.invalid`);
    expect(route?.upstream?.credential).toBe('origin_secret');
    expect((await previewGateService.view(host))?.repository).toBe(`${MOTIR_ORG}/${REPO}`);
  });
});

describe('seam 5 — teardown through the composition root → preview_usage → the pool read', () => {
  it('a closed pull request’s destroy writes its final slice, and the pool counts it', async () => {
    const fx = await makeWorkItemFixture();
    await readyPreview(fx);
    for (const target of ['fly'] as const) {
      (getHostingDeployPort(target) as HostingDeployPort & FakeHostingControls).advanceSeconds(600);
    }
    neon().advanceSeconds(600);
    const mark = jobs.events.length;
    await githubWebhookService.handleEvent('pull_request', pr('closed'));
    await drain(mark);

    const slices = await adminDb.previewUsage.findMany({ orderBy: { kind: 'asc' } });
    expect(slices.map((s) => s.kind).sort()).toEqual(['machine_seconds', 'neon_compute_hours']);
    expect(slices.every((s) => s.periodStart.getTime() === JULY_2026.getTime())).toBe(true);
    const minutes = slices.reduce((sum, s) => sum + Number(s.linuxEquivalentMinutes), 0);
    expect(minutes).toBeGreaterThan(0);

    const consumption = await ciMinutesMeterService.getOrgPeriodConsumption(
      fx.workspace.organizationId,
      NOW,
    );
    expect(consumption.bySource).toEqual({ ci: 0, preview: expect.closeTo(minutes, 4) });
  });
});

// ── the two seams that cross a process boundary in the lane ─────────────────
//
// In the E2E lane the job worker deploys a preview and the web server routes it:
// two processes, two fake hosting instances, one store file. Here the file is the
// test's own (`MOTIR_FAKE_HOSTING_STATE_PATH` under a fresh temp directory), the
// composition root's cached fake plays the web server, and a SECOND fake built
// over the same path plays the job worker — so no lane default is inherited, and
// both caches are reset around the arrangement.
describe('seams 6 and 7 — one preview across two fake hosting instances over one store', () => {
  let dir: string;
  let standIn: PreviewUpstreamStandIn | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'preview-story-gate-'));
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, join(dir, 'hosting.json'));
    resetHostingFakes();
    resetPreviewRouteCache();
    alignFakeClocks();
  });

  afterEach(async () => {
    await standIn?.stop();
    standIn = null;
    resetHostingFakes();
    resetPreviewRouteCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The job worker's instance: a fake of its own, over the same store file. */
  const worker = () => createFakeHostingDeployPort({ shareAcrossProcesses: true, target: 'fly' });

  it('seam 6 — a release the lifecycle deployed is answered by another instance with the same release', async () => {
    const fx = await makeWorkItemFixture();
    const { row } = await readyPreview(fx);
    expect(hostingFakeControls('fly')).toBe(getHostingDeployPort('fly'));
    const deployedBy = await fly().listReleases({ appRef: row.flyAppName! });

    const other = worker();
    expect(other).not.toBe(fly());
    const releases = await other.listReleases({ appRef: row.flyAppName! });
    expect(releases.map((r) => r.handle.releaseId)).toEqual(
      deployedBy.map((r) => r.handle.releaseId),
    );
    const live = releases.at(-1)!;
    const described = await other.describe(live.handle);
    expect(described.releaseId).toBe(live.handle.releaseId);
    expect(described.upstreamAddress).not.toBeNull();
    expect(described.state).toBe('healthy');
  });

  it('seam 7 — an upstream another instance set reaches route(), moving the address and nothing else', async () => {
    const fx = await makeWorkItemFixture();
    const { row } = await readyPreview(fx);
    const host = postedHost();
    const before = await previewGateService.route(host);

    standIn = await startPreviewUpstreamStandIn();
    worker().setUpstream(row.flyAppName!, standIn.origin);
    resetPreviewRouteCache();

    const route = await previewGateService.route(host);
    expect(route?.upstream?.origin).toBe(standIn.origin);
    expect(route?.upstream?.credential).toBe('origin_secret');
    expect(route?.upstream?.headers[ORIGIN_SECRET_HEADER]).toBe(
      deriveOriginSecret(hostingOriginSecretKey(), row.flyAppName!),
    );
    expect(route).toEqual({
      ...before,
      upstream: { ...before!.upstream!, origin: standIn.origin },
    });
  });
});

describe('guard 1 — a teardown leaves nothing', () => {
  it('no app, no Neon branch, the row closed with nothing named, served as closed', async () => {
    const fx = await makeWorkItemFixture();
    const { row } = await readyPreview(fx);
    expect(neon().branches()).toHaveLength(1);
    const mark = jobs.events.length;
    await githubWebhookService.handleEvent('pull_request', pr('closed'));
    await drain(mark);

    expect(fly().app(row.flyAppName!)).toBeUndefined();
    expect(neon().branches()).toEqual([]);
    expect(await preview()).toMatchObject({
      state: 'closed',
      flyAppName: null,
      neonBranchId: null,
      closedAt: expect.any(Date),
    });
    expect(deployments[0]!.statuses.at(-1)?.state).toBe('inactive');
    // The host stops reaching anything: the gate has no upstream for it.
    resetPreviewRouteCache();
    expect(await previewGateService.route(row.host)).toEqual({
      state: 'closed',
      target: 'fly',
      upstream: null,
    });
  });
});

describe('guard 2 — the gate is a permission check, not a role', () => {
  async function onCustomRole(workspaceId: string, userId: string, permissions: string[]) {
    const definition = await adminDb.workspaceRoleDefinition.create({
      data: { workspaceId, name: `Role ${permissions.join('+')}`, permissions },
    });
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        userId,
        workspaceId,
        { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: definition.id },
        tx,
      ),
    );
  }

  it('a custom role carrying project:browse is admitted; one without it, and a built-in member not on the project, are not', async () => {
    const fx = await makeWorkItemFixture();
    await readyPreview(fx);
    const host = postedHost();
    const contractor = await user('contractor');
    await workspacesService.addMember({ userId: contractor.id, workspaceId: fx.workspaceId });
    await onCustomRole(fx.workspaceId, contractor.id, ['project:browse']);
    const commenter = await user('commenter');
    await workspacesService.addMember({ userId: commenter.id, workspaceId: fx.workspaceId });
    await onCustomRole(fx.workspaceId, commenter.id, ['comment:add']);

    const admitted = await previewGateService.admit({
      userId: contractor.id,
      host,
      returnPath: '/',
    });
    expect(admitted.admitted).toBe(true);
    expect(await previewGateService.admit({ userId: commenter.id, host, returnPath: '/' })).toEqual(
      { admitted: false },
    );

    // A BUILT-IN member role is no key either: on a members-only project, a
    // workspace member who was not added is refused while the owner is let in.
    await projectMembersService.setAccessMode({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    const member = await user('member');
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    expect(await previewGateService.admit({ userId: member.id, host, returnPath: '/' })).toEqual({
      admitted: false,
    });
    expect(
      (await previewGateService.admit({ userId: fx.ownerId, host, returnPath: '/' })).admitted,
    ).toBe(true);
  });

  it('no gate source decides by a role name', () => {
    const pattern = /role ===|roleName|isWorkspaceManagerFor/;
    const files = storyFiles(GATE_ROOTS, GATE_PATH).filter((file) => STORY_PATH.test(file));
    expect(files.length).toBeGreaterThanOrEqual(GATE_ROOTS.length);
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));
    expect({ pattern: pattern.source, ranOver: files.length, offenders }).toEqual({
      pattern: pattern.source,
      ranOver: files.length,
      offenders: [],
    });
  });
});

describe('guard 3 — preview_deployment and preview_usage are tenant-isolated', () => {
  it('a workspace reads only its own previews and usage, and can write no usage', async () => {
    const fx = await makeWorkItemFixture();
    const { row } = await readyPreview(fx);
    await adminDb.previewUsage.create({
      data: {
        previewDeploymentId: row.id,
        organizationId: fx.workspace.organizationId,
        workspaceId: fx.workspaceId,
        kind: 'machine_seconds',
        sourceRef: row.flyAppName!,
        quantity: 60,
        linuxEquivalentMinutes: 1,
        motirCostUsd: 0.001,
        periodStart: JULY_2026,
        sliceStart: new Date(NOW.getTime() - 60_000),
        sliceEnd: NOW,
      },
    });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });

    const ownPreviews = await asAppRole(fx.workspaceId, fx.ownerId, (tx) =>
      tx.previewDeployment.findMany(),
    );
    expect(ownPreviews.map((p) => p.id)).toEqual([row.id]);
    expect(await asAppRole(fx.workspaceId, fx.ownerId, (tx) => tx.previewUsage.count())).toBe(1);

    expect(
      await asAppRole(other.workspaceId, other.ownerId, (tx) => tx.previewDeployment.findMany()),
    ).toEqual([]);
    expect(
      await asAppRole(other.workspaceId, other.ownerId, (tx) => tx.previewUsage.findMany()),
    ).toEqual([]);
    // Usage is the meter's alone to write: a tenant cannot add a slice, even its own.
    await expect(
      asAppRole(fx.workspaceId, fx.ownerId, (tx) =>
        tx.previewUsage.create({
          data: {
            previewDeploymentId: row.id,
            organizationId: fx.workspace.organizationId,
            workspaceId: fx.workspaceId,
            kind: 'machine_seconds',
            sourceRef: row.flyAppName!,
            quantity: 1,
            linuxEquivalentMinutes: 0,
            motirCostUsd: 0,
            periodStart: JULY_2026,
            sliceStart: NOW,
            sliceEnd: new Date(NOW.getTime() + 1000),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('guard 4 — only Motir-hosted repositories are touched', () => {
  it('a connected repository makes zero outbound calls, wherever the story is entered', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await connectedRow(fx);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no outbound call may be made for a connected repository');
      }),
    );
    const port = fly();
    const calls = (
      ['ensurePushNamespace', 'mintDeployCredential', 'ensureApp', 'deploy', 'destroyApp'] as const
    ).map((method) => vi.spyOn(port, method));
    const branches = neon().branches().length;

    expect(await previewEnablementService.enable(rowId)).toEqual({
      repositoryId: rowId,
      outcome: 'ineligible',
      reason: 'not_motir_created',
    });
    expect(await previewEnablementService.sweep()).toEqual({ rows: [] });
    expect(await previewEnablementService.disable(rowId)).toBe('nothing_to_disable');
    const theirs = {
      repository: { id: 9002, name: REPO, owner: { login: 'yue-personal' } },
      installation: { id: 990011 },
    };
    for (const action of ['opened', 'synchronize', 'closed']) {
      expect(await previewLifecycleService.onPullRequest(pr(action, SHA, theirs))).toEqual({
        outcome: 'not_enabled',
      });
    }
    expect(await previewLifecycleService.onImageRun(imageRun(SHA, theirs))).toEqual({
      outcome: 'not_enabled',
    });

    expect(fetch).not.toHaveBeenCalled();
    for (const spy of calls) expect(spy).not.toHaveBeenCalled();
    expect(neon().branches()).toHaveLength(branches);
    expect(await adminDb.previewDeployment.count()).toBe(0);
    expect(jobs.events).toEqual([]);
  });
});

// ── guard 5, and the source scans guard 2 shares ────────────────────────────

const REPO_ROOT = process.cwd();

/** The story's sources outside the orchestrator package that are listed BY NAME
 *  — a floor: each must still exist. The sweeps run over these AND every file
 *  {@link storyFiles} discovers at run time, because files are added to this
 *  story after a list like this one is written. */
const STORY_ROOTS = [
  'lib/preview',
  'lib/services/previewEnablementService.ts',
  'lib/services/previewLifecycleService.ts',
  'lib/services/previewGateService.ts',
  'lib/services/ciPreviewUsageMeterService.ts',
  'lib/repositories/previewDeploymentRepository.ts',
  'lib/repositories/previewUsageRepository.ts',
  'lib/repositories/previewGateAdmissionRepository.ts',
  'lib/github/previewDeployments.ts',
  'lib/ciMetering/previewRates.ts',
  'lib/jobs/definitions/previewLifecycle.ts',
  'lib/jobs/definitions/previewUsageAccrual.ts',
  'lib/jobs/definitions/previewEnablementSweep.ts',
  'app/(preview-host)',
  'app/(auth)/preview-access',
  'components/preview',
  'components/github/PreviewLine.tsx',
  // The proxy sits at the repository root, outside the general boundary guard's
  // `lib` / `app` / `components` reach, and it is where preview hosts enter.
  'proxy.ts',
];

/** The product roots a discovery walks. */
const PRODUCT_ROOTS = ['lib', 'app', 'components'];

/** What makes a discovered file the story's: its PATH names a preview. */
const STORY_PATH = /preview/i;

/** The gate's own sources, by name: who may view a preview is decided only here. */
const GATE_ROOTS = [
  'lib/preview/gate.ts',
  'lib/preview/gateProxy.ts',
  'lib/services/previewGateService.ts',
  'app/(preview-host)',
  'app/(auth)/preview-access',
  'components/preview',
];

/** …and, discovered, every story file whose path names the gate or its door. */
const GATE_PATH = /preview.*(gate|access|host)|(gate|access)[^/]*preview|\(preview-host\)/i;

/** Every `.ts` / `.tsx` file under `roots` (files or directories). */
function sourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === 'node_modules' || entry === 'generated') continue;
        walk(join(path, entry));
      }
    } else if (/\.(ts|tsx)$/.test(path)) {
      out.push(path);
    }
  };
  for (const root of roots) walk(join(REPO_ROOT, root));
  return out;
}

/** The named roots, plus every product file whose path matches `discover` —
 *  enumerated now, from the tree under test. Deduplicated and sorted. */
function storyFiles(named: readonly string[], discover: RegExp): string[] {
  const found = sourceFiles(PRODUCT_ROOTS).filter((file) =>
    discover.test(relative(REPO_ROOT, file)),
  );
  return [...new Set([...sourceFiles(named), ...found])].sort();
}

/** The ways Fly leaks that `tests/ciFleet/orchestratorPortBoundary.test.ts`
 *  names — an adapter import, its API host, its variables, its types. */
const FLY_TELLS = [
  /adapters\/fly/,
  /api\.machines\.dev/,
  /\bFLY_[A-Z_]+\b/,
  /\bMOTIR_HOSTING_FLY_[A-Z_]+\b/,
  /\bFlyMachine\b/,
  /\bfly(Machines|Orchestrator|FleetConfig|Machine)\b/,
  /\b(createFlyHostingDeployPort|flyHostingConfig|FlyHostingConfig|flyAppProvisioning)\b/,
];

/** A hosting port built anywhere but the composition root (`lib/orchestrator`):
 *  every outbound hosting call in the story must come from `getHostingDeployPort`. */
const PORT_BUILDERS = /\bcreate\w*HostingDeployPort\b|\bcreateConfiguredAwsHostingPort\b/;

describe('guard 5 — no Fly type outside the adapter', () => {
  it('every story file exists, and none of them names Fly’s adapter, API or types', () => {
    const files = storyFiles(STORY_ROOTS, STORY_PATH);
    expect(files.length).toBeGreaterThan(STORY_ROOTS.length);
    const leaks = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return FLY_TELLS.filter((tell) => tell.test(text)).map(
        (tell) => `${relative(REPO_ROOT, file)}: ${tell}`,
      );
    });
    expect({ tells: FLY_TELLS.map((t) => t.source), ranOver: files.length, leaks }).toEqual({
      tells: FLY_TELLS.map((t) => t.source),
      ranOver: files.length,
      leaks: [],
    });
  });

  it('no story file builds a hosting port: every hosting call goes through getHostingDeployPort', () => {
    const files = storyFiles(STORY_ROOTS, STORY_PATH);
    const builders = files
      .filter((file) => PORT_BUILDERS.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));
    const callers = files.filter((file) =>
      /getHostingDeployPort\(/.test(readFileSync(file, 'utf8')),
    );
    expect(callers.length).toBeGreaterThan(0);
    expect({ pattern: PORT_BUILDERS.source, ranOver: files.length, builders }).toEqual({
      pattern: PORT_BUILDERS.source,
      ranOver: files.length,
      builders: [],
    });
  });
});
