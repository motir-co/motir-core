import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type {
  FakeDatabaseControls,
  FakeHostingControls,
  HostingDeployPort,
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
import { PREVIEW_IMAGE_WORKFLOW_PATH } from '@/lib/preview/lifecycleEvents';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { ciMinutesMeterService } from '@/lib/services/ciMinutesMeterService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { previewGateService, resetPreviewRouteCache } from '@/lib/services/previewGateService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { usersService } from '@/lib/services/usersService';
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
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../helpers/repositoryActionsConfigFake';

// THE STORY GATE for Motir's pull-request previews (Story MOTIR-5766 ·
// MOTIR-5780), over real Postgres. Each card's own suite proves its card; this
// one proves the SEAMS between them, by driving one preview through the shipped
// code end to end — switched on by the enablement service (MOTIR-5775), built,
// started and torn down by the lifecycle (MOTIR-5776), metered at its teardown
// (MOTIR-5777) and served by the gate (MOTIR-5779) — and holds the story's five
// guards:
//
//   1. a teardown leaves nothing: no app, no Neon branch, the row closed and
//      served as closed;
//   2. the gate is a PERMISSION check, never a role name;
//   3. `preview_deployment` and `preview_usage` are tenant-isolated under RLS;
//   4. only a Motir-hosted repository is ever touched — a connected one makes
//      no outbound call at all;
//   5. no Fly type or name leaks into the story's code outside the adapter.
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

describe('seam 2 — the lifecycle’s status → the shipped deployment_status handler → repo_deployment', () => {
  it('the success status the lifecycle posts is stored against the head, at the preview host', async () => {
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

describe('seam 3 — the lifecycle’s row → serving, under the host it posted', () => {
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

describe('seam 4 — teardown through the composition root → preview_usage → the pool read', () => {
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
    const offenders = storyFiles(GATE_ROOTS).filter((file) =>
      /role ===|roleName|isWorkspaceManagerFor/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
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

/** Every source file the story ships outside the orchestrator package. */
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
  // The proxy sits at the repository root, outside the general boundary guard's
  // `lib` / `app` / `components` reach, and it is where preview hosts enter.
  'proxy.ts',
];

/** The gate's own sources: who may view a preview is decided only here. */
const GATE_ROOTS = [
  'lib/preview/gate.ts',
  'lib/preview/gateProxy.ts',
  'lib/services/previewGateService.ts',
  'app/(preview-host)',
  'app/(auth)/preview-access',
  'components/preview',
];

function storyFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else if (/\.(ts|tsx)$/.test(path)) {
      out.push(path);
    }
  };
  for (const root of roots) walk(join(REPO_ROOT, root));
  return out;
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

describe('guard 5 — no Fly type outside the adapter', () => {
  it('every story file exists, and none of them names Fly’s adapter, API or types', () => {
    const files = storyFiles(STORY_ROOTS);
    expect(files.length).toBeGreaterThan(STORY_ROOTS.length);
    const leaks = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return FLY_TELLS.filter((tell) => tell.test(text)).map(
        (tell) => `${relative(REPO_ROOT, file)}: ${tell}`,
      );
    });
    expect(leaks).toEqual([]);
  });
});
