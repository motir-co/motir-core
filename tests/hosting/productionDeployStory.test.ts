// Story MOTIR-9797 · MOTIR-10038 — the production path of a Motir repository,
// assembled, against real Postgres. Every case enters where a real caller does
// (the `workflow_run` webhook and its job for a merge, a saved value and its job
// for a config change, the HTTP handlers for the panel and the rollback, the
// `deployment_status` webhook for the statuses) and asserts through the
// datastore, the fakes' recorded calls and what GitHub received. Each card's
// own suite proves its unit; this one proves the seams between them and the
// story's three guards: a preview never receives the production database, two
// repositories in one project never act on each other, and a customer
// repository produces nothing. Fixture: `./productionStoryFixture.ts`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { resolveEnvironment } from '@/lib/environmentConfig/resolveEnvironment';
import { CustomerRepositoryNotDeployableError } from '@/lib/hosting/errors';
import type { EnvironmentConfigChangedData } from '@/lib/jobs/types';
import { environmentConfigService } from '@/lib/services/environmentConfigService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionConfigRedeployService } from '@/lib/services/productionConfigRedeployService';
import { repoDeploymentService } from '@/lib/services/repoDeploymentService';
import type { WorkspaceContext } from '@/lib/workspaces';
import { adminDb } from '../helpers/adminDb';
import {
  CONFIG_JOB,
  MERGE_JOB,
  STATUS_JOB,
  applicationOf,
  deploymentStatusPayload,
  deliverWorkflowRun,
  hosting,
  ingestStatuses,
  merge,
  mergeService,
  productionDatabaseSecrets,
  queued,
  releasesOf,
  runConfigJob,
  runMergeJobs,
  runStatusJobs,
  seedRepo,
  seedStory,
  setUpStory,
  sha,
  snapshot,
  state,
  storedDeployments,
  tearDownStory,
  workflowRun,
  type Story,
  type StoryRepo,
} from './productionStoryFixture';

const ctxRef = vi.hoisted(() => ({ current: null as WorkspaceContext | null }));

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET } = await import('@/app/api/projects/[key]/repositories/[rowId]/production/route');
const { POST } =
  await import('@/app/api/projects/[key]/repositories/[rowId]/production/rollback/route');

beforeEach(async () => {
  ctxRef.current = null;
  await setUpStory();
});

afterEach(() => tearDownStory());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The HTTP surface, as the browser calls it ───────────────────────────────

const asAdmin = (s: Story) => (ctxRef.current = s.fx.ctx);
const asMember = (s: Story) =>
  (ctxRef.current = { userId: s.memberId, workspaceId: s.fx.workspaceId });

const routeUrl = (key: string, rowId: string) =>
  `http://localhost:3000/api/projects/${key}/repositories/${rowId}/production`;
const params = (key: string, rowId: string) => ({ params: Promise.resolve({ key, rowId }) });

async function readPanel(key: string, rowId: string): Promise<{ status: number; text: string }> {
  const res = await GET(new Request(routeUrl(key, rowId)), params(key, rowId));
  return { status: res.status, text: await res.text() };
}

async function postRollback(key: string, rowId: string): Promise<{ status: number; text: string }> {
  const res = await POST(
    new Request(`${routeUrl(key, rowId)}/rollback`, { method: 'POST' }),
    params(key, rowId),
  );
  return { status: res.status, text: await res.text() };
}

const body = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;
const code = (r: { text: string }) => (body(r)['error'] as { code: string }).code;

/** Put `n` merges of commits 1…n live, settling usage between them on the
 *  fake's clock so a replaced release has seconds to record. */
async function mergesLive(repo: StoryRepo, n: number) {
  for (let i = 1; i <= n; i++) {
    const [outcome] = await merge(repo, sha(i));
    expect(outcome).toMatchObject({ outcome: 'released', state: 'live' });
    const app = await applicationOf(repo.projectRepositoryId);
    await adminDb.hostedRelease.update({
      where: { id: app.currentReleaseId! },
      data: { liveAt: hosting().now() },
    });
    hosting().advanceSeconds(3600);
  }
}

// ── A merge goes live ───────────────────────────────────────────────────────

describe('a merge to main', () => {
  it('creates the database, migrates, then deploys exactly the head commit live', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);

    await deliverWorkflowRun(workflowRun(repo, { head_sha: sha(1) }));
    const [outcome] = await runMergeJobs();

    expect(outcome).toMatchObject({ outcome: 'released', state: 'live' });
    const [release] = await releasesOf(repo.projectRepositoryId);
    expect(release).toMatchObject({
      commitSha: sha(1),
      state: 'live',
      cause: 'merge',
      artifactRef: `registry.fly.io/${repo.appName}:${sha(1)}`,
    });
    expect(release!.providerReleaseId).toMatch(/^rel-/);
    expect((await applicationOf(repo.projectRepositoryId)).currentReleaseId).toBe(release!.id);
    const order = state.timeline.filter((t) =>
      ['database:createDatabase', 'hosting:runReleaseCommand', 'hosting:deploy'].includes(t),
    );
    expect(order).toEqual([
      'database:createDatabase',
      'hosting:runReleaseCommand',
      'hosting:deploy',
    ]);
  });

  it('replaces the live release with the next commit, settling its usage before the deploy', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 1);
    const [first] = await releasesOf(repo.projectRepositoryId);
    state.timeline = [];

    const [outcome] = await merge(repo, sha(2));

    expect(outcome).toMatchObject({ outcome: 'released', state: 'live' });
    const [old, current] = await releasesOf(repo.projectRepositoryId);
    expect(old).toMatchObject({ id: first!.id, state: 'replaced' });
    expect(old!.usageSeconds).not.toBeNull();
    expect(old!.usageSeconds).toBeGreaterThanOrEqual(3600);
    expect(current).toMatchObject({ commitSha: sha(2), state: 'live' });
    const app = await applicationOf(repo.projectRepositoryId);
    expect([app.currentReleaseId, app.previousReleaseId]).toEqual([current!.id, old!.id]);
    expect(state.timeline.indexOf('usage:settle')).toBeGreaterThanOrEqual(0);
    expect(state.timeline.indexOf('usage:settle')).toBeLessThan(
      state.timeline.indexOf('hosting:deploy'),
    );
  });
});

// ── Statuses round-trip through GitHub ──────────────────────────────────────

describe('the deployment statuses', () => {
  it('are stored by the shipped ingestion: success for the live release, inactive for the replaced one', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 2);
    await runStatusJobs();
    const record = vi.spyOn(repoDeploymentService, 'record');

    await ingestStatuses(repo);

    expect(record).toHaveBeenCalledTimes(state.statuses.filter((p) => p.repo === repo.name).length);
    const stored = await storedDeployments(repo);
    expect(stored.map((d) => [d.environment, d.commitSha, d.state])).toEqual([
      ['production', sha(1), 'inactive'],
      ['production', sha(2), 'success'],
    ]);
    expect(stored[1]!.environmentUrl).toBe(`https://${repo.address}`);
  });

  it('keep the newer state when an older status is replayed out of order', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 1);
    await runStatusJobs();
    await merge(repo, sha(2));
    await runStatusJobs();
    await ingestStatuses(repo);
    const firstDeployment = state.deployments.find((d) => d.ref === sha(1))!;
    const olderSuccess = state.statuses.find(
      (p) => p.deploymentId === firstDeployment.id && p.state === 'success',
    )!;

    await (
      await import('@/lib/services/githubWebhookService')
    ).githubWebhookService.handleEvent(
      'deployment_status',
      deploymentStatusPayload(repo, olderSuccess),
    );

    const stored = await storedDeployments(repo);
    expect(stored.find((d) => d.commitSha === sha(1))!.state).toBe('inactive');
  });

  it.each(['failure', 'timed_out'])(
    'record a failed build (%s) with a failure status, the previous release still current',
    async (conclusion) => {
      const s = await seedStory();
      const repo = await seedRepo(s.fx);
      await mergesLive(repo, 1);
      const before = await applicationOf(repo.projectRepositoryId);
      const deploys = hosting().calls.filter((c) => c.operation === 'deploy').length;

      const [outcome] = await merge(repo, sha(2), { conclusion });
      await runStatusJobs();
      await ingestStatuses(repo);

      expect(outcome).toMatchObject({ outcome: 'build_failed_recorded' });
      const failed = (await releasesOf(repo.projectRepositoryId)).find(
        (r) => r.commitSha === sha(2),
      );
      expect(failed).toMatchObject({ state: 'failed', failureReason: `build ${conclusion}` });
      expect((await applicationOf(repo.projectRepositoryId)).currentReleaseId).toBe(
        before.currentReleaseId,
      );
      expect(hosting().calls.filter((c) => c.operation === 'deploy')).toHaveLength(deploys);
      const stored = await storedDeployments(repo);
      expect(stored.find((d) => d.commitSha === sha(2))!.state).toBe('failure');
      expect(stored.find((d) => d.commitSha === sha(1))!.state).toBe('success');
    },
  );

  it('record a failed migration with a failure status and no deploy for it', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 1);
    const before = await applicationOf(repo.projectRepositoryId);
    hosting().setReleaseCommandResult({ exitCode: 1, timedOut: false });
    state.timeline = [];

    const [outcome] = await merge(repo, sha(2));
    await runStatusJobs();
    await ingestStatuses(repo);

    expect(outcome).toMatchObject({ outcome: 'released', state: 'failed' });
    const failed = (await releasesOf(repo.projectRepositoryId)).find((r) => r.commitSha === sha(2));
    expect(failed).toMatchObject({ state: 'failed', failureReason: 'migrate: exit 1' });
    expect(state.timeline).toContain('hosting:runReleaseCommand');
    expect(state.timeline).not.toContain('hosting:deploy');
    expect((await applicationOf(repo.projectRepositoryId)).currentReleaseId).toBe(
      before.currentReleaseId,
    );
    const stored = await storedDeployments(repo);
    expect(stored.find((d) => d.commitSha === sha(2))!.state).toBe('failure');
  });
});

// ── A production config change ──────────────────────────────────────────────

describe('a production config change', () => {
  it('coalesces five saves into one redeploy of the live commit carrying the latest value', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 1);
    const [live] = await releasesOf(repo.projectRepositoryId);

    for (let i = 1; i <= 5; i++) {
      await environmentConfigService.set(
        repo.projectRepositoryId,
        'production',
        { name: 'GREETING', value: `hello-${i}`, isSecret: false },
        s.fx.ctx,
      );
    }
    const runs = await queued<EnvironmentConfigChangedData>(CONFIG_JOB);
    expect(runs).toHaveLength(1);
    const { result } = await runConfigJob(runs[0]!);

    expect(result).toMatchObject({ outcome: 'redeployed' });
    const redeploys = (await releasesOf(repo.projectRepositoryId)).filter(
      (r) => r.cause === 'config_change',
    );
    expect(redeploys).toHaveLength(1);
    expect(redeploys[0]).toMatchObject({
      commitSha: live!.commitSha,
      artifactRef: live!.artifactRef,
      state: 'live',
    });
    expect(hosting().app(repo.appName)!.live!.env['GREETING']).toBe('hello-5');
  });

  it('defers without a port call while a merge is in flight, then redeploys', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 1);
    const app = await applicationOf(repo.projectRepositoryId);
    const building = await hostedApplicationService.createRelease({
      applicationId: app.id,
      commitSha: sha(9),
      cause: 'merge',
    });
    const calls = hosting().calls.length;

    expect(
      await productionConfigRedeployService.runProductionRedeploy({
        projectRepositoryId: repo.projectRepositoryId,
        attempt: 0,
      }),
    ).toEqual({ outcome: 'deferred_in_progress' });
    expect(hosting().calls.slice(calls)).toEqual([]);

    await hostedApplicationService.transitionRelease(building.id, 'building', 'failed', {
      failureReason: 'build failure',
    });
    expect(
      await productionConfigRedeployService.runProductionRedeploy({
        projectRepositoryId: repo.projectRepositoryId,
        attempt: 1,
      }),
    ).toMatchObject({ outcome: 'redeployed' });
  });
});

// ── The panel and the rollback, over HTTP ───────────────────────────────────

describe('the panel and the rollback', () => {
  it('reads for both roles, rolls back for the administrator, and posts inactive and success', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 2);
    await runStatusJobs();
    const [first, second] = await releasesOf(repo.projectRepositoryId);

    asAdmin(s);
    const adminView = body(await readPanel('ACME', repo.projectRepositoryId));
    expect(adminView).toMatchObject({ isAdministrator: true, canRollback: true });
    expect(adminView['currentRelease']).toMatchObject({ id: second!.id, state: 'live' });
    expect(adminView['previousRelease']).toMatchObject({ id: first!.id, state: 'replaced' });
    expect((adminView['releases'] as Array<{ id: string }>).map((r) => r.id)).toEqual([
      second!.id,
      first!.id,
    ]);
    asMember(s);
    expect(body(await readPanel('ACME', repo.projectRepositoryId))).toMatchObject({
      isAdministrator: false,
      canRollback: false,
    });

    asAdmin(s);
    const rolled = await postRollback('ACME', repo.projectRepositoryId);
    await runStatusJobs();
    await ingestStatuses(repo);

    expect(rolled.status).toBe(200);
    expect(body(rolled)['currentRelease']).toMatchObject({ id: first!.id, state: 'live' });
    expect(body(rolled)['previousRelease']).toMatchObject({
      id: second!.id,
      state: 'rolled_back',
    });
    expect(hosting().calls.filter((c) => c.operation === 'rollback')).toHaveLength(1);
    const stored = await storedDeployments(repo);
    expect(stored.map((d) => [d.commitSha, d.state])).toEqual([
      [sha(1), 'success'],
      [sha(2), 'inactive'],
    ]);
  });

  it('answers a member forbidden, with no port call and nothing changed', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 2);
    const before = await snapshot(repo.projectRepositoryId);
    const calls = hosting().calls.length;
    asMember(s);

    const res = await postRollback('ACME', repo.projectRepositoryId);

    expect(res.status).toBe(403);
    expect(code(res)).toBe('rollback_not_permitted');
    expect(hosting().calls.slice(calls)).toEqual([]);
    expect(await snapshot(repo.projectRepositoryId)).toEqual(before);
  });

  it('answers distinct conflicts with one release, and with a release building', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 1);
    asAdmin(s);
    const calls = hosting().calls.length;
    const one = await snapshot(repo.projectRepositoryId);

    const none = await postRollback('ACME', repo.projectRepositoryId);
    expect([none.status, code(none)]).toEqual([409, 'no_previous_release']);
    expect(await snapshot(repo.projectRepositoryId)).toEqual(one);

    await mergesLive(repo, 2);
    const app = await applicationOf(repo.projectRepositoryId);
    await hostedApplicationService.createRelease({
      applicationId: app.id,
      commitSha: sha(9),
      cause: 'merge',
    });
    const building = await snapshot(repo.projectRepositoryId);
    const from = hosting().calls.length;

    const busy = await postRollback('ACME', repo.projectRepositoryId);
    expect([busy.status, code(busy)]).toEqual([409, 'release_in_progress']);
    expect(code(none)).not.toBe(code(busy));
    expect(hosting().calls.slice(from)).toEqual([]);
    expect(
      hosting()
        .calls.slice(calls)
        .filter((c) => c.operation === 'rollback'),
    ).toEqual([]);
    expect(await snapshot(repo.projectRepositoryId)).toEqual(building);
  });

  it('never migrates, touches the database port or reads DATABASE_URL', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 2);
    asAdmin(s);
    state.timeline = [];
    const reads: string[] = [];
    const env = process.env;
    process.env = new Proxy(env, {
      get(target, name, receiver) {
        if (typeof name === 'string' && /DATABASE_URL|DIRECT_URL/.test(name)) reads.push(name);
        return Reflect.get(target, name, receiver);
      },
    });
    let res: { status: number; text: string };
    try {
      res = await postRollback('ACME', repo.projectRepositoryId);
    } finally {
      process.env = env;
    }

    expect(res.status).toBe(200);
    expect(state.timeline.filter((t) => t.startsWith('database:'))).toEqual([]);
    expect(state.timeline).not.toContain('hosting:runReleaseCommand');
    expect(state.timeline).not.toContain('hosting:deploy');
    expect(state.timeline).toContain('hosting:rollback');
    expect(reads).toEqual([]);
  });
});

// ── Guard: a preview never receives the production database ─────────────────

const ROOT = join(__dirname, '..', '..');
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

describe('a preview beside a production application', () => {
  it('receives neither the production connection string nor its ciphertext, anywhere', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 2);
    hosting().setReleaseCommandResult({ exitCode: 1, timedOut: false });
    await merge(repo, sha(3));
    await runStatusJobs();
    const { connectionString, ciphertext } = await productionDatabaseSecrets(
      repo.projectRepositoryId,
    );
    expect(hosting().app(repo.appName)!.live!.env['DATABASE_URL']).toBe(connectionString);

    // The preview path: the preview environment resolved, then deployed to a
    // preview app of the same repository through the same port.
    await environmentConfigService.set(
      repo.projectRepositoryId,
      'preview',
      { name: 'GREETING', value: 'preview', isSecret: false },
      s.fx.ctx,
    );
    const env = await resolveEnvironment(repo.projectRepositoryId, 'preview', {
      workspaceId: s.fx.workspaceId,
    });
    const environment = { kind: 'preview' as const, pullRequest: 42 };
    const from = hosting().calls.length;
    const { appRef } = await hosting().ensureApp({
      repositoryId: repo.projectRepositoryId,
      environment,
    });
    const previewHandle = await hosting().deploy({
      appRef,
      environment,
      artifact: { kind: 'image', ref: `registry.fly.io/${repo.appName}:${sha(2)}` },
      runtime: { ...(await import('./productionStoryFixture')).MANIFEST },
      env,
      size: 'small',
      idle: { mode: 'suspend', idleSeconds: 300 },
    });

    asAdmin(s);
    const panel = await readPanel('ACME', repo.projectRepositoryId);
    const rolled = await postRollback('ACME', repo.projectRepositoryId);
    const dto = await hostedApplicationService.getApplicationForRepository(
      s.fx.workspaceId,
      repo.projectRepositoryId,
    );
    const reasons = (await adminDb.hostedRelease.findMany()).map((r) => r.failureReason);

    const scanned = {
      previewRequests: hosting().calls.slice(from),
      previewEnv: hosting().app(appRef)!.live!.env,
      previewHandle,
      panel: panel.text,
      rollback: rolled.text,
      dto,
      logged: state.logged,
      github: state.githubBodies,
      reasons,
    };
    expect(env.map((v) => v.name)).not.toContain('DATABASE_URL');
    for (const [where, value] of Object.entries(scanned)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      expect(text, where).not.toContain(connectionString);
      expect(text, where).not.toContain(ciphertext);
      expect(text, where).not.toMatch(/postgres(ql)?:\/\//);
    }
    expect(reasons).toContain('migrate: exit 1');
  });

  it('lets only the production release service import the production database service', () => {
    const importers = ['lib', 'app']
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) =>
        /from\s+['"]@\/lib\/services\/productionDatabaseService['"]/.test(
          readFileSync(join(ROOT, f), 'utf8'),
        ),
      );
    expect(importers).toEqual(['lib/services/productionReleaseService.ts']);
  });
});

// ── Guard: two Motir repositories in one project ────────────────────────────

describe('two Motir repositories in one project', () => {
  it('act only on the repository a merge, a config change and a rollback name', async () => {
    const s = await seedStory();
    const web = await seedRepo(s.fx, { role: 'web' });
    const api = await seedRepo(s.fx, { role: 'api' });
    await mergesLive(api, 2);
    await runStatusJobs();
    const apiBefore = await snapshot(api.projectRepositoryId);
    const apiCalls = () =>
      hosting().calls.filter(
        (c) => c.appRef !== null && c.appRef.includes(api.projectRepositoryId),
      );
    const apiCallsBefore = apiCalls().length;
    const apiStatusesBefore = state.statuses.filter((p) => p.repo === api.name).length;

    await mergesLive(web, 2);
    await environmentConfigService.set(
      web.projectRepositoryId,
      'production',
      { name: 'GREETING', value: 'web-only', isSecret: false },
      s.fx.ctx,
    );
    const [change] = await queued<EnvironmentConfigChangedData>(CONFIG_JOB);
    expect(change!.projectRepositoryId).toBe(web.projectRepositoryId);
    expect((await runConfigJob(change!)).result).toMatchObject({ outcome: 'redeployed' });
    asAdmin(s);
    expect((await postRollback('ACME', web.projectRepositoryId)).status).toBe(200);
    await runStatusJobs();

    expect(await snapshot(api.projectRepositoryId)).toEqual(apiBefore);
    expect(apiCalls()).toHaveLength(apiCallsBefore);
    expect(state.statuses.filter((p) => p.repo === api.name)).toHaveLength(apiStatusesBefore);
    expect(hosting().app(api.appName)!.live!.env['GREETING']).toBeUndefined();
    const webDb = await productionDatabaseSecrets(web.projectRepositoryId);
    const apiDb = await productionDatabaseSecrets(api.projectRepositoryId);
    expect(webDb.connectionString).not.toBe(apiDb.connectionString);
  });

  it("answer not found when one's id is addressed under another project's path", async () => {
    const s = await seedStory();
    const web = await seedRepo(s.fx);
    await mergesLive(web, 2);
    const other = await seedStory('OTHR');
    const foreign = await seedRepo(other.fx);
    await mergesLive(foreign, 2);
    const before = await snapshot(foreign.projectRepositoryId);
    asAdmin(s);

    for (const res of [
      await readPanel('ACME', foreign.projectRepositoryId),
      await postRollback('ACME', foreign.projectRepositoryId),
    ]) {
      expect([res.status, code(res)]).toEqual([404, 'repository_not_found']);
    }
    expect(await snapshot(foreign.projectRepositoryId)).toEqual(before);
  });
});

// ── Guard: a customer repository produces nothing ───────────────────────────

describe('a customer repository', () => {
  it('produces no row and no port, GitHub or database call, and answers not found', async () => {
    const s = await seedStory();
    const customer = await seedRepo(s.fx, { customer: true });
    const fetchCalls = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls;

    await deliverWorkflowRun(workflowRun(customer, { head_sha: sha(1) }));
    expect(await queued(MERGE_JOB)).toEqual([]);
    expect(
      await runConfigJob({
        workspaceId: s.fx.workspaceId,
        projectRepositoryId: customer.projectRepositoryId,
        environment: 'production',
        name: 'GREETING',
        action: 'replaced',
        actorId: s.fx.ownerId,
      }),
    ).toMatchObject({ result: { outcome: 'skipped_customer_repository' } });
    asAdmin(s);
    for (const res of [
      await readPanel('ACME', customer.projectRepositoryId),
      await postRollback('ACME', customer.projectRepositoryId),
    ]) {
      expect([res.status, code(res)]).toEqual([404, 'repository_not_found']);
    }
    await expect(
      hostedApplicationService.ensureApplication(customer.projectRepositoryId),
    ).rejects.toBeInstanceOf(CustomerRepositoryNotDeployableError);

    expect(await adminDb.hostedApplication.count()).toBe(0);
    expect(await adminDb.hostedRelease.count()).toBe(0);
    expect(hosting().calls).toEqual([]);
    expect(state.timeline).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(await queued(STATUS_JOB)).toEqual([]);
  });
});

// ── The runs that release nothing ───────────────────────────────────────────

describe('a workflow run that is not a production merge', () => {
  it.each([
    ['another workflow', { name: 'CI' }],
    ['a pull-request run', { event: 'pull_request' }],
    ['another branch', { head_branch: 'release/x' }],
    ['a skipped run', { conclusion: 'skipped' }],
  ])('releases and records nothing for %s', async (_label, overrides) => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);

    await deliverWorkflowRun(workflowRun(repo, overrides));
    const outcomes = await runMergeJobs();

    for (const o of outcomes) expect(o).toEqual({ outcome: 'ignored' });
    expect(await releasesOf(repo.projectRepositoryId)).toEqual([]);
    expect(hosting().calls).toEqual([]);
    expect(await queued(STATUS_JOB)).toEqual([]);
  });

  it('releases nothing for a repository production is not switched on for', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await adminDb.hostedApplication.update({
      where: { projectRepositoryId: repo.projectRepositoryId },
      data: { productionEnabledAt: null },
    });

    await deliverWorkflowRun(workflowRun(repo));

    expect(await queued(MERGE_JOB)).toEqual([]);
    expect(await releasesOf(repo.projectRepositoryId)).toEqual([]);
    expect(hosting().calls).toEqual([]);
  });
});

// ── Concurrency ─────────────────────────────────────────────────────────────

describe('under real concurrency', () => {
  it('two merges delivered together leave at most one release in flight', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    const app = await applicationOf(repo.projectRepositoryId);
    const inFlight: number[] = [];
    const create = hostedApplicationService.createRelease.bind(hostedApplicationService);
    vi.spyOn(hostedApplicationService, 'createRelease').mockImplementation(async (...args) => {
      const made = await create(...args);
      inFlight.push(
        await adminDb.hostedRelease.count({
          where: { applicationId: app.id, state: { in: ['building', 'releasing'] } },
        }),
      );
      return made;
    });

    const outcomes = await Promise.all([
      mergeService.runMergeRelease({
        projectRepositoryId: repo.projectRepositoryId,
        headSha: sha(1),
        conclusion: 'success',
        attempt: 0,
      }),
      mergeService.runMergeRelease({
        projectRepositoryId: repo.projectRepositoryId,
        headSha: sha(2),
        conclusion: 'success',
        attempt: 0,
      }),
    ]);

    for (const o of outcomes) expect(['released', 'deferred_in_progress']).toContain(o.outcome);
    expect(outcomes.some((o) => o.outcome === 'released')).toBe(true);
    expect(Math.max(...inFlight)).toBeLessThanOrEqual(1);
    const states = (await releasesOf(repo.projectRepositoryId)).map((r) => r.state);
    expect(states.filter((x) => x === 'building' || x === 'releasing')).toEqual([]);
    expect(states.filter((x) => x === 'live')).toHaveLength(1);
  });

  it('two rollbacks started together leave two distinct releases current and previous', async () => {
    const s = await seedStory();
    const repo = await seedRepo(s.fx);
    await mergesLive(repo, 3);
    asAdmin(s);

    const answers = await Promise.all([
      postRollback('ACME', repo.projectRepositoryId),
      postRollback('ACME', repo.projectRepositoryId),
    ]);

    for (const a of answers) expect([200, 409]).toContain(a.status);
    expect(answers.some((a) => a.status === 200)).toBe(true);
    const app = await applicationOf(repo.projectRepositoryId);
    const releases = await releasesOf(repo.projectRepositoryId);
    const byId = new Map(releases.map((r) => [r.id, r]));
    expect(app.currentReleaseId).not.toBe(app.previousReleaseId);
    expect(byId.get(app.currentReleaseId!)!.state).toBe('live');
    expect(['replaced', 'rolled_back']).toContain(byId.get(app.previousReleaseId!)!.state);
    expect(releases.filter((r) => r.state === 'live')).toHaveLength(1);
    expect(releases.every((r) => ['live', 'replaced', 'rolled_back'].includes(r.state))).toBe(true);
  });
});
