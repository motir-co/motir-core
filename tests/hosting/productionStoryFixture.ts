// The shared fixture of the production-deploy story suite (Story MOTIR-9797 ·
// MOTIR-10038): a workspace with a project, an administrator and a member, Motir
// repositories switched on for production, a customer repository, and every
// seam the story's entries cross held at its edge:
//   * the deploy port and the database port as their fakes, each call appended
//     to one TIMELINE so a test can assert the order across the two ports;
//   * GitHub at its `fetch` boundary, a stateful fake of the deployments and
//     statuses endpoints that keeps every request body it received;
//   * the job engine's real queue, its jobs driven through their own handlers
//     with a step API that executes steps and records sleeps;
//   * the console, captured, so a test can scan every line logged.
// Nothing here mocks a repository or a service; the one service seam stubbed is
// the manifest read at a commit (the release service's own suite covers it).
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { environmentConfigCrypto } from '@/lib/environmentConfig/crypto';
import { getGitProvider } from '@/lib/git';
import type { HostingManifest } from '@/lib/hosting/manifest';
import { productionConfigRedeploy } from '@/lib/jobs/definitions/productionConfigRedeploy';
import { productionMergeRelease } from '@/lib/jobs/definitions/productionMergeRelease';
import { releaseDeploymentStatus } from '@/lib/jobs/definitions/releaseDeploymentStatus';
import { jobServices } from '@/lib/jobs/services';
import type { EnvironmentConfigChangedData } from '@/lib/jobs/types';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { hostedReleaseUsageService } from '@/lib/services/hostedReleaseUsageService';
import { hostedRepositoryAccessService } from '@/lib/services/hostedRepositoryAccessService';
import {
  productionMergeReleaseService,
  type MergeReleaseRequestedData,
} from '@/lib/services/productionMergeReleaseService';
import type { ReleaseStatusRequestedData } from '@/lib/services/releaseDeploymentStatusService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

export const ORG = 'motir-projects';
export const INSTALLATION = '556677';
export const MERGE_JOB = 'hosting/merge-release.requested';
export const CONFIG_JOB = 'hosting/production-config-redeploy';
export const STATUS_JOB = 'hosted-release.status';
const KEY = '9a'.repeat(32);
const WORKFLOW_RUN = 'tests/fixtures/github/workflow-run/production-image.completed.json';

/** A manifest with a database, so a release creates it and migrates first. */
export const MANIFEST: HostingManifest = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

export const sha = (n: number) => n.toString(16).padStart(40, '0');

// ── GitHub at its fetch boundary ────────────────────────────────────────────

export interface CreatedDeployment {
  repo: string;
  id: string;
  ref: string;
  environment: string;
}
export interface PostedStatus {
  repo: string;
  deploymentId: string;
  state: string;
  environmentUrl: string | null;
  at: string;
}

export interface StoryState {
  /** Every port call on both fakes, in order: `hosting:<op>` / `database:<op>`,
   *  plus `usage:settle` for the usage service's settle. */
  timeline: string[];
  /** Every line the console received. */
  logged: string[];
  /** Every request body GitHub received, raw. */
  githubBodies: string[];
  deployments: CreatedDeployment[];
  statuses: PostedStatus[];
}

export const state: StoryState = {
  timeline: [],
  logged: [],
  githubBodies: [],
  deployments: [],
  statuses: [],
};
let clock = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function github(method: string, path: string, body: Record<string, unknown> | null): Response {
  if (path === `/orgs/${ORG}/installation`) return json(200, { id: Number(INSTALLATION) });
  if (path.includes('/access_tokens')) {
    return json(200, {
      token: 'ghs_story',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  const created = /^\/repos\/([^/]+)\/([^/]+)\/deployments$/.exec(path);
  if (method === 'POST' && created) {
    const deployment = {
      repo: created[2]!,
      id: String(9000 + state.deployments.length),
      ref: String(body?.['ref']),
      environment: String(body?.['environment']),
    };
    state.deployments.push(deployment);
    return json(201, { id: Number(deployment.id), ref: deployment.ref });
  }
  const status = /^\/repos\/([^/]+)\/([^/]+)\/deployments\/(\d+)\/statuses$/.exec(path);
  if (method === 'POST' && status) {
    clock += 1000;
    const posted = {
      repo: status[2]!,
      deploymentId: status[3]!,
      state: String(body?.['state']),
      environmentUrl:
        typeof body?.['environment_url'] === 'string' ? body['environment_url'] : null,
      at: new Date(clock).toISOString(),
    };
    state.statuses.push(posted);
    return json(201, { id: state.statuses.length, state: posted.state });
  }
  throw new Error(`unexpected fetch: ${method} ${path}`);
}

// ── The fakes ───────────────────────────────────────────────────────────────

export function hosting() {
  return getHostingDeployPort('fly') as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

const HOSTING_OPS = ['ensureApp', 'deploy', 'runReleaseCommand', 'rollback', 'usageSince'] as const;
const DATABASE_OPS = [
  'createDatabase',
  'connectionEnv',
  'usageSince',
  'deleteDatabase',
  'list',
] as const;

/** Wrap each named method so a call appends `label:<op>` to the timeline and
 *  then runs the real one (the fake's own call log included). */
function onTimeline<T extends object>(target: T, label: string, ops: readonly string[]): void {
  const methods = target as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const op of ops) {
    const inner = methods[op]!.bind(target);
    vi.spyOn(methods, op).mockImplementation((...args: unknown[]) => {
      state.timeline.push(`${label}:${op}`);
      return inner(...args);
    });
  }
}

/** The per-test setup: an empty database, fresh fakes, GitHub stubbed, the
 *  console captured. Call from `beforeEach`. */
export async function setUpStory(): Promise<void> {
  await truncateAuthTables();
  state.timeline = [];
  state.logged = [];
  state.githubBodies = [];
  state.deployments = [];
  state.statuses = [];
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
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  resetHostingFakes();
  resetDatabaseFakes();
  onTimeline(hosting(), 'hosting', HOSTING_OPS);
  onTimeline(getDatabasePort(), 'database', DATABASE_OPS);
  const settle = hostedReleaseUsageService.settleReleaseUsage.bind(hostedReleaseUsageService);
  vi.spyOn(hostedReleaseUsageService, 'settleReleaseUsage').mockImplementation(async (id) => {
    state.timeline.push('usage:settle');
    return settle(id);
  });
  vi.spyOn(hostedRepositoryAccessService, 'readManifestAt').mockResolvedValue(MANIFEST);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.github.com', '');
      const raw = typeof init?.body === 'string' ? init.body : null;
      if (raw) state.githubBodies.push(raw);
      return github(
        init?.method ?? 'GET',
        path,
        raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      );
    }),
  );
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      state.logged.push(
        args
          .map((a) =>
            a instanceof Error
              ? `${a.name}: ${a.message}`
              : typeof a === 'string'
                ? a
                : JSON.stringify(a),
          )
          .join(' '),
      );
    });
  }
}

/** The per-test teardown. Call from `afterEach`. */
export function tearDownStory(): void {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

// ── The seed ────────────────────────────────────────────────────────────────

export interface Story {
  fx: WorkItemFixture;
  memberId: string;
}

/** A workspace and project with its owner (an administrator) and a member. */
export async function seedStory(identifier = 'ACME'): Promise<Story> {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const member = await usersService.createUser({
    email: `member-${identifier.toLowerCase()}@story.test`,
    password: 'story-password-1',
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
  return { fx, memberId: member.id };
}

export interface StoryRepo {
  projectRepositoryId: string;
  providerRepoId: string;
  name: string;
  appName: string;
  address: string;
}

let repoSeq = 0;

/** A repository mirrored under Motir's GitHub installation, established, on
 *  Fly. A Motir repository is switched on for production the way enablement
 *  records it, with its production address; a customer one gets no application. */
export async function seedRepo(
  fx: WorkItemFixture,
  opts: { customer?: boolean; role?: 'web' | 'api' } = {},
): Promise<StoryRepo> {
  repoSeq += 1;
  const name = `shop-${repoSeq}`;
  const providerRepoId = String(660000 + repoSeq);
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
      repoId: providerRepoId,
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
    role: opts.role ?? 'web',
  });
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      state: 'created',
      seedSource: opts.customer ? 'organization' : 'nextjs-prisma-fly-starter',
      hostingTarget: 'fly',
    },
  });
  const appName = `mh-${row.id}`;
  const address = `${name}--${fx.projectIdentifier.toLowerCase()}.motir.site`;
  if (!opts.customer) {
    const app = await hostedApplicationService.ensureApplication(row.id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: {
        productionAppName: appName,
        productionEnabledAt: new Date(),
        productionAddress: address,
      },
    });
  }
  return { projectRepositoryId: row.id, providerRepoId, name, appName, address };
}

// ── The merge entry ─────────────────────────────────────────────────────────

export type RunOverrides = Partial<{
  name: string;
  event: string;
  head_branch: string;
  head_sha: string;
  conclusion: string;
  id: number;
  run_attempt: number;
}>;

let runSeq = 0;

/** A GitHub `workflow_run` completed delivery for the repository, from the
 *  recorded fixture, changed field by field. Each gets its own run id. */
export function workflowRun(
  repo: StoryRepo,
  overrides: RunOverrides = {},
): Record<string, unknown> {
  const body = JSON.parse(readFileSync(WORKFLOW_RUN, 'utf8')) as {
    workflow_run: Record<string, unknown>;
    repository: Record<string, unknown>;
  };
  runSeq += 1;
  Object.assign(body.workflow_run, { id: 7_000_000 + runSeq, head_sha: sha(1) }, overrides);
  Object.assign(body.repository, { id: Number(repo.providerRepoId), name: repo.name });
  return body;
}

/** Deliver a `workflow_run` through the webhook, as GitHub does. */
export async function deliverWorkflowRun(body: Record<string, unknown>): Promise<void> {
  const result = await githubWebhookService.handleEvent('workflow_run', body);
  expect(result.event).toBe('workflow_run');
}

/** The queued payloads of a job, oldest first. */
export async function queued<T>(jobId: string): Promise<T[]> {
  const runs = await adminDb.jobQueueRun.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
  });
  const events = await adminDb.jobEvent.findMany({
    where: { id: { in: runs.map((r) => r.eventId!) } },
  });
  return runs.map((r) => events.find((e) => e.id === r.eventId)!.data as unknown as T);
}

interface Handler {
  handler: unknown;
}

/** Drive a job definition's own handler: steps execute, sleeps are recorded. */
export async function runHandler<R>(
  job: Handler,
  name: string,
  data: unknown,
): Promise<{ result: R; slept: number[] }> {
  const slept: number[] = [];
  const ctx = {
    event: { name, data },
    attempt: 0,
    runId: 'run_story',
    step: {
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
      sleep: async (_id: string, ms: number | string) => {
        slept.push(Number(ms));
      },
    },
  };
  const result = await (job.handler as (c: typeof ctx, s: typeof jobServices) => Promise<R>)(
    ctx,
    jobServices,
  );
  return { result, slept };
}

/** Run every merge job queued since `from` (an index into the queue). */
export async function runMergeJobs(from = 0) {
  const jobs = (await queued<MergeReleaseRequestedData>(MERGE_JOB)).slice(from);
  const results = [];
  for (const data of jobs) {
    results.push((await runHandler(productionMergeRelease, MERGE_JOB, data)).result);
  }
  return results;
}

/** Deliver a merge of `headSha` and run the release it enqueues. */
export async function merge(repo: StoryRepo, headSha: string, overrides: RunOverrides = {}) {
  const from = (await queued(MERGE_JOB)).length;
  await deliverWorkflowRun(workflowRun(repo, { head_sha: headSha, ...overrides }));
  return runMergeJobs(from);
}

/** The config-redeploy job, driven through its handler. */
export async function runConfigJob(data: EnvironmentConfigChangedData) {
  return runHandler(productionConfigRedeploy, 'environment.config.changed', data);
}

/** Run the status job for every release an announcement named, oldest first —
 *  the job is idempotent, so a release already posted posts nothing new. */
export async function runStatusJobs(): Promise<void> {
  const seen = new Set<string>();
  for (const data of await queued<ReleaseStatusRequestedData>(STATUS_JOB)) {
    if (seen.has(data.releaseId)) continue;
    seen.add(data.releaseId);
    await runHandler(releaseDeploymentStatus, STATUS_JOB, data);
  }
}

/** The `deployment_status` webhook payload GitHub would send for one status the
 *  fake received. */
export function deploymentStatusPayload(
  repo: StoryRepo,
  posted: PostedStatus,
): Record<string, unknown> {
  const deployment = state.deployments.find((d) => d.id === posted.deploymentId)!;
  return {
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
  };
}

/** Feed every status the fake received for the repository through GitHub's
 *  normalizer and the shipped ingestion, in the order they were posted. */
export async function ingestStatuses(repo: StoryRepo): Promise<void> {
  for (const posted of state.statuses.filter((s) => s.repo === repo.name)) {
    const payload = deploymentStatusPayload(repo, posted);
    expect(getGitProvider('github').parseDeploymentStatusEvent!(payload)).not.toBeNull();
    await githubWebhookService.handleEvent('deployment_status', payload);
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function releasesOf(projectRepositoryId: string) {
  return adminDb.hostedRelease.findMany({
    where: { application: { projectRepositoryId } },
    orderBy: { createdAt: 'asc' },
  });
}

export async function applicationOf(projectRepositoryId: string) {
  return adminDb.hostedApplication.findUniqueOrThrow({ where: { projectRepositoryId } });
}

export async function storedDeployments(repo: StoryRepo) {
  return adminDb.repoDeployment.findMany({
    where: { repo: { repoId: repo.providerRepoId } },
    orderBy: { providerDeploymentId: 'asc' },
  });
}

/** The production connection string the application stores, and its ciphertext. */
export async function productionDatabaseSecrets(projectRepositoryId: string) {
  const app = await applicationOf(projectRepositoryId);
  expect(app.databaseUrlCiphertext).not.toBeNull();
  const ciphertext = app.databaseUrlCiphertext!;
  return { connectionString: environmentConfigCrypto.decryptToken(ciphertext), ciphertext };
}

/** Everything about one repository a test compares before and after. */
export async function snapshot(projectRepositoryId: string) {
  const app = await applicationOf(projectRepositoryId);
  return {
    pointers: [app.currentReleaseId, app.previousReleaseId],
    database: [app.databaseProjectId, app.databaseUrlCiphertext],
    releases: (await releasesOf(projectRepositoryId)).map((r) => ({
      id: r.id,
      state: r.state,
      usageSeconds: r.usageSeconds,
      usageSettledUntil: r.usageSettledUntil,
      statusPostedState: r.statusPostedState,
    })),
  };
}

export const mergeService = productionMergeReleaseService;
