// MOTIR-10033 — every production release posts its GitHub deployment status,
// against real Postgres, the deploy port's fake, and GitHub stubbed at its
// `fetch` boundary (a stateful fake of the deployments and statuses endpoints).
// The loop is closed through the SHIPPED ingestion: the payloads the fake
// received are replayed as `deployment_status` webhooks through
// `githubWebhookService`, and `repo_deployment` is read back.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { ReleaseStatusPostError } from '@/lib/hosting/errors';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { releaseDeploymentStatus } from '@/lib/jobs/definitions/releaseDeploymentStatus';
import { jobServices } from '@/lib/jobs/services';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { productionRollbackService } from '@/lib/services/productionRollbackService';
import {
  releaseDeploymentStatusService as service,
  type ReleaseStatusRequestedData,
} from '@/lib/services/releaseDeploymentStatusService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';

const ORG = 'motir-projects';
const INSTALLATION = '556677';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
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

interface PostedStatus {
  repo: string;
  deploymentId: string;
  state: string;
  environmentUrl: string | null;
  at: string;
}
interface CreatedDeployment {
  repo: string;
  id: string;
  ref: string;
  environment: string;
}

let deployments: CreatedDeployment[];
let statuses: PostedStatus[];
let order: string[];
let failNextStatus: number | null;
let clock: number;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function route(method: string, path: string, body: Record<string, unknown> | null): Response {
  if (path === `/orgs/${ORG}/installation`) return json(200, { id: 556677 });
  if (path.includes('/access_tokens')) {
    return json(200, {
      token: 'ghs_test',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  const created = /^\/repos\/([^/]+)\/([^/]+)\/deployments$/.exec(path);
  if (method === 'POST' && created) {
    expect(body).toMatchObject({ auto_merge: false, required_contexts: [] });
    const deployment = {
      repo: created[2]!,
      id: String(9000 + deployments.length),
      ref: String(body?.['ref']),
      environment: String(body?.['environment']),
    };
    deployments.push(deployment);
    order.push(`deployment:${deployment.repo}`);
    return json(201, { id: Number(deployment.id), ref: deployment.ref });
  }
  const status = /^\/repos\/([^/]+)\/([^/]+)\/deployments\/(\d+)\/statuses$/.exec(path);
  if (method === 'POST' && status) {
    if (failNextStatus !== null) {
      const code = failNextStatus;
      failNextStatus = null;
      return json(code, { message: 'Server Error' });
    }
    clock += 1000;
    const posted = {
      repo: status[2]!,
      deploymentId: status[3]!,
      state: String(body?.['state']),
      environmentUrl:
        typeof body?.['environment_url'] === 'string' ? body['environment_url'] : null,
      at: new Date(clock).toISOString(),
    };
    statuses.push(posted);
    order.push(`status:${posted.state}`);
    return json(201, { id: statuses.length, state: posted.state });
  }
  throw new Error(`unexpected fetch: ${method} ${path}`);
}

function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

beforeEach(async () => {
  await truncateAuthTables();
  deployments = [];
  statuses = [];
  order = [];
  failNextStatus = null;
  clock = Date.parse('2026-10-29T12:00:00Z');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.github.com', '');
      const raw = typeof init?.body === 'string' ? init.body : null;
      return route(
        init?.method ?? 'GET',
        path,
        raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace(identifier = 'ACME'): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: identifier, identifier });
}

let seq = 0;
/** A Motir repository on GitHub, established, on Fly, with an application at
 *  `address`. */
async function motirRepo(fx: WorkItemFixture, opts: { github?: boolean } = {}) {
  seq += 1;
  const name = `shop-${seq}`;
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION },
    update: {},
    create: {
      installationId: INSTALLATION,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: ORG,
      accountType: 'Organization',
    },
  });
  const githubRepo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: String(770000 + seq),
      owner: ORG,
      name,
      defaultBranch: 'main',
    },
  });
  const row = await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: githubRepo.id,
    name,
    role: 'web',
  });
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      state: 'created',
      seedSource: 'nextjs-prisma-fly-starter',
      hostingTarget: 'fly',
      ...(opts.github === false ? { githubRepoId: null } : {}),
    },
  });
  const app = await hostedApplicationService.ensureApplication(row.id);
  const address = `${name}.acme.motir.site`;
  await adminDb.hostedApplication.update({
    where: { id: app.id },
    data: { productionAddress: address },
  });
  return {
    projectRepositoryId: row.id,
    applicationId: app.id,
    name,
    providerRepoId: githubRepo.repoId,
    address,
  };
}

type Repo = Awaited<ReturnType<typeof motirRepo>>;

async function release(repo: Repo, sha = SHA_A) {
  return productionReleaseService.deployProductionRelease({
    projectRepositoryId: repo.projectRepositoryId,
    commitSha: sha,
    artifactRef: `registry.fly.io/mh-x:${sha}`,
    cause: 'merge',
  });
}

async function releaseRow(id: string) {
  return adminDb.hostedRelease.findUniqueOrThrow({ where: { id } });
}

/** Replay what the fake received as GitHub's `deployment_status` webhooks. */
async function deliverWebhooks(repo: Repo) {
  for (const posted of statuses.filter((s) => s.repo === repo.name)) {
    const deployment = deployments.find((d) => d.id === posted.deploymentId)!;
    await githubWebhookService.handleEvent('deployment_status', {
      action: 'created',
      installation: { id: Number(INSTALLATION) },
      repository: { id: Number(repo.providerRepoId), name: repo.name, owner: { login: ORG } },
      deployment: {
        id: Number(deployment.id),
        sha: deployment.ref,
        ref: deployment.ref,
        environment: deployment.environment,
      },
      deployment_status: {
        state: posted.state,
        environment_url: posted.environmentUrl ?? '',
        created_at: posted.at,
        updated_at: posted.at,
      },
    });
  }
}

async function storedDeployments(repo: Repo) {
  return adminDb.repoDeployment.findMany({
    where: { repo: { repoId: repo.providerRepoId } },
    orderBy: { providerDeploymentId: 'asc' },
  });
}

describe('a release going live', () => {
  it('creates one production deployment of the commit, then pending, in progress and success', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);

    expect(await service.postReleaseDeploymentStatus(live.id)).toEqual({
      outcome: 'posted',
      statuses: ['pending', 'in_progress', 'success'],
    });

    expect(order).toEqual([
      `deployment:${repo.name}`,
      'status:pending',
      'status:in_progress',
      'status:success',
    ]);
    expect(deployments).toEqual([
      { repo: repo.name, id: '9000', ref: SHA_A, environment: 'production' },
    ]);
    expect(statuses.map((s) => s.environmentUrl)).toEqual([null, null, `https://${repo.address}`]);
    expect(await releaseRow(live.id)).toMatchObject({
      githubDeploymentId: '9000',
      statusPostedState: 'success',
      state: 'live',
    });
  });

  it('is stored in repo_deployment through the shipped webhook ingestion as success', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);
    await service.postReleaseDeploymentStatus(live.id);

    await deliverWebhooks(repo);

    expect(await storedDeployments(repo)).toEqual([
      expect.objectContaining({
        providerDeploymentId: '9000',
        environment: 'production',
        commitSha: SHA_A,
        state: 'success',
        environmentUrl: `https://${repo.address}`,
      }),
    ]);
  });

  it('sends no environment URL when the application has no production address', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    await adminDb.hostedApplication.update({
      where: { id: repo.applicationId },
      data: { productionAddress: null },
    });
    const live = await release(repo);
    await service.postReleaseDeploymentStatus(live.id);

    expect(statuses.map((s) => s.environmentUrl)).toEqual([null, null, null]);
  });
});

describe('a release that is replaced or rolled back', () => {
  it('posts inactive for the replaced release, read back as inactive', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const first = await release(repo, SHA_A);
    await service.postReleaseDeploymentStatus(first.id);
    const second = await release(repo, SHA_B);

    await service.postReleaseDeploymentStatus(first.id);
    await service.postReleaseDeploymentStatus(second.id);
    await deliverWebhooks(repo);

    expect((await releaseRow(first.id)).state).toBe('replaced');
    const stored = await storedDeployments(repo);
    expect(stored.map((d) => [d.commitSha, d.state])).toEqual([
      [SHA_A, 'inactive'],
      [SHA_B, 'success'],
    ]);
  });

  it('posts inactive for a rolled-back release and success for the restored one', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const first = await release(repo, SHA_A);
    const second = await release(repo, SHA_B);
    await service.postReleaseDeploymentStatus(first.id);
    await service.postReleaseDeploymentStatus(second.id);

    await withSystemContext(async (tx) => {
      await hostedApplicationService.transitionRelease(first.id, 'replaced', 'live', {}, tx);
      await hostedApplicationService.swapCurrentRelease(repo.applicationId, first.id, tx, {
        outgoing: 'rolled_back',
      });
    });
    await service.postReleaseDeploymentStatus(second.id);
    await service.postReleaseDeploymentStatus(first.id);
    await deliverWebhooks(repo);

    expect((await releaseRow(second.id)).statusPostedState).toBe('inactive');
    expect((await releaseRow(first.id)).statusPostedState).toBe('success');
    const stored = await storedDeployments(repo);
    expect(stored.map((d) => [d.commitSha, d.state])).toEqual([
      [SHA_A, 'success'],
      [SHA_B, 'inactive'],
    ]);
    expect(deployments).toHaveLength(2);
  });
});

describe('a rollback through the rollback service (MOTIR-10035)', () => {
  it('announces inactive for the left release and success for the restored one, read back', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const first = await release(repo, SHA_A);
    const second = await release(repo, SHA_B);
    await service.postReleaseDeploymentStatus(first.id);
    await service.postReleaseDeploymentStatus(second.id);
    const announced: string[] = [];
    vi.spyOn(service, 'enqueueReleaseStatusPost').mockImplementation(async (releaseId) => {
      announced.push(releaseId);
    });

    await productionRollbackService.rollbackProduction({
      projectRepositoryId: repo.projectRepositoryId,
      actor: fx.ctx,
    });
    // The job the announcements enqueue, run for each release they named.
    for (const releaseId of new Set(announced)) {
      await service.postReleaseDeploymentStatus(releaseId);
    }
    await deliverWebhooks(repo);

    expect([...new Set(announced)].sort()).toEqual([first.id, second.id].sort());
    const stored = await storedDeployments(repo);
    expect(stored.map((d) => [d.commitSha, d.state])).toEqual([
      [SHA_A, 'success'],
      [SHA_B, 'inactive'],
    ]);
  });
});

describe('a release that fails', () => {
  it('posts failure alone for a failed deploy, creating its deployment first', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    hosting().failNext('deploy');
    const failed = await release(repo);
    expect(failed.state).toBe('failed');

    await service.postReleaseDeploymentStatus(failed.id);

    expect(order).toEqual([`deployment:${repo.name}`, 'status:failure']);
  });

  it('posts failure alone for a failed build recorded straight into failed', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const failed = await productionReleaseService.recordFailedRelease(
      repo.projectRepositoryId,
      SHA_A,
      'build failure',
    );

    await service.postReleaseDeploymentStatus(failed.id);
    await deliverWebhooks(repo);

    expect(statuses.map((s) => s.state)).toEqual(['failure']);
    expect((await storedDeployments(repo)).map((d) => d.state)).toEqual(['failure']);
  });
});

describe('a job that runs late, twice, or after a failure', () => {
  it('posts nothing the second time', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);
    await service.postReleaseDeploymentStatus(live.id);

    expect(await service.postReleaseDeploymentStatus(live.id)).toEqual({ outcome: 'up_to_date' });
    expect(order).toHaveLength(4);
  });

  it('reuses the stored deployment on a retry after a failed post, and resumes where it stopped', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);
    failNextStatus = 502;

    const thrown = await service.postReleaseDeploymentStatus(live.id).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ReleaseStatusPostError);
    expect(thrown).toMatchObject({ step: 'status', status: 502 });
    expect((thrown as Error).message).not.toMatch(/Server Error|ghs_/);
    expect(await releaseRow(live.id)).toMatchObject({
      state: 'live',
      githubDeploymentId: '9000',
      statusPostedState: null,
    });

    await service.postReleaseDeploymentStatus(live.id);
    expect(deployments).toHaveLength(1);
    expect(statuses.map((s) => s.state)).toEqual(['pending', 'in_progress', 'success']);
  });

  it('converges when two jobs for one release run at once', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);

    await Promise.all([
      service.postReleaseDeploymentStatus(live.id),
      service.postReleaseDeploymentStatus(live.id),
    ]);

    expect(deployments).toHaveLength(1);
    expect(statuses.map((s) => s.state)).toEqual(['pending', 'in_progress', 'success']);
  });

  it('answers release_not_found for a release that does not exist', async () => {
    expect(await service.postReleaseDeploymentStatus('nope')).toEqual({
      outcome: 'release_not_found',
    });
  });
});

describe('failure isolation', () => {
  it('never fails a state change: the post is enqueued after commit and its failure is swallowed', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(service, 'enqueueReleaseStatusPost').mockRejectedValue(new Error('queue down'));

    const live = await release(repo);

    expect(live.state).toBe('live');
    expect(error).toHaveBeenCalled();
  });

  it('a repository with no GitHub row is a retried repository-step failure, not a state change', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);
    await adminDb.projectRepo.update({
      where: { id: repo.projectRepositoryId },
      data: { githubRepoId: null },
    });

    await expect(service.postReleaseDeploymentStatus(live.id)).rejects.toMatchObject({
      step: 'repository',
      status: null,
    });
    expect((await releaseRow(live.id)).state).toBe('live');
    expect(deployments).toEqual([]);
  });

  it('a GitHub refusal to create the deployment carries its status and leaves no handle', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/deployments')
          ? json(403, { message: 'Resource not accessible by integration' })
          : route('GET', String(url).replace('https://api.github.com', ''), null),
      ),
    );

    await expect(service.postReleaseDeploymentStatus(live.id)).rejects.toMatchObject({
      step: 'deployment',
      status: 403,
    });
    expect(await releaseRow(live.id)).toMatchObject({
      githubDeploymentId: null,
      statusPostedState: null,
    });
  });
});

describe('the hook and the job', () => {
  it('enqueues one debounced status job per release for the moves its release made', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);

    const runs = await adminDb.jobQueueRun.findMany({ where: { jobId: 'hosted-release.status' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.debounceKey).toBe(live.id);
  });

  it('runs the post through the job handler', async () => {
    const fx = await workspace();
    const repo = await motirRepo(fx);
    const live = await release(repo);
    const data: ReleaseStatusRequestedData = { workspaceId: fx.workspaceId, releaseId: live.id };
    const ctx = {
      event: { name: 'hosted-release.status', data },
      attempt: 0,
      runId: 'run_test',
      step: { run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn() },
    };

    const result = await (
      releaseDeploymentStatus.handler as unknown as (
        c: typeof ctx,
        s: typeof jobServices,
      ) => Promise<unknown>
    )(ctx, jobServices);

    expect(result).toEqual({ outcome: 'posted', statuses: ['pending', 'in_progress', 'success'] });
  });

  it('enqueues nothing for a release that does not exist', async () => {
    await service.enqueueReleaseStatusPost('nope');
    expect(await adminDb.jobQueueRun.count({ where: { jobId: 'hosted-release.status' } })).toBe(0);
  });
});

describe('two Motir repositories in one project', () => {
  it('posts each release to its own repository and deployment', async () => {
    const fx = await workspace();
    const web = await motirRepo(fx);
    const api = await motirRepo(fx);
    const webLive = await release(web, SHA_A);
    const apiLive = await release(api, SHA_B);

    await Promise.all([
      service.postReleaseDeploymentStatus(webLive.id),
      service.postReleaseDeploymentStatus(apiLive.id),
    ]);

    expect(deployments.map((d) => [d.repo, d.ref]).sort()).toEqual(
      [
        [web.name, SHA_A],
        [api.name, SHA_B],
      ].sort(),
    );
    const webRow = await releaseRow(webLive.id);
    const apiRow = await releaseRow(apiLive.id);
    expect(webRow.githubDeploymentId).not.toBe(apiRow.githubDeploymentId);
    for (const repo of [web, api]) {
      expect(statuses.filter((s) => s.repo === repo.name).map((s) => s.state)).toEqual([
        'pending',
        'in_progress',
        'success',
      ]);
    }
  });
});

describe('layering', () => {
  it('no module of this card writes repo_deployment', () => {
    for (const file of [
      'lib/services/releaseDeploymentStatusService.ts',
      'lib/github/repoDeployments.ts',
      'lib/hosting/releaseDeploymentStatus.ts',
      'lib/jobs/definitions/releaseDeploymentStatus.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      // An IMPORT of the store, not a mention: the comments name it on purpose.
      expect(source, file).not.toMatch(/from '[^']*repoDeployment(Repository|Service)'/);
      expect(source, file).not.toMatch(/\.repoDeployment\./);
      expect(source, file).not.toMatch(/@\/lib\/db['/]/);
    }
  });
});
