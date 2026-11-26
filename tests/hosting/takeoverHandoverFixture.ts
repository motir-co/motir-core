// THE TAKEOVER HANDOVER'S INTEGRATION WORLD (Story MOTIR-9800 · MOTIR-12139).
//
// Two organisations on real Postgres. Organisation A has a `ready` tenant AWS
// account holding two AWS-target Motir repositories (one with an open preview,
// both with a live production application), plus one Fly and one serverless
// Motir repository, each with a live application on a database, a live release
// and a bound customer domain. Organisation B has the same AWS shape on its own
// account, for isolation. Each has an owner, a second admin and a member.
//
// Only the provider clients are faked, and every one of them appends to ONE
// ordered timeline, so an ordering criterion is read off the timeline, never
// inferred from the end state:
//   * the AWS reach (Organizations, Account, CloudFormation, IAM) is
//     `createHandoverFakes` — the orchestrator's tenant-account fake driven
//     through the real handover calls — whose log IS the timeline;
//   * the hosting deploy port (Fly and serverless) and the database port are
//     their fakes, each call wrapped onto the timeline (`hosting:<op>`,
//     `database:<op>`);
//   * GitHub at its `fetch` boundary (`github:<METHOD> <path>`), a permissive
//     fake of the repository endpoints the shipped saga calls, and GitHub's
//     transfer call `repoTransferClient.transferRepo` (`transfer:<repo>`);
//   * the object store through its own seam (`installBlobStoreMock`) and the
//     database dump through the stand-in `pg_dump` first on PATH.
// The job engine's queue is the real one: `sendEvent` writes `job_event` rows,
// and a job is driven through its own handler.
import { delimiter, join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import { repoTransferClient } from '@/lib/github/repoTransfer';
import { jobServices } from '@/lib/jobs/services';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import { getHostingDeployPort, resetHostingFakes } from '@/lib/orchestrator/hosting';
import { installBlobStoreMock } from '@/lib/test-blob-mock';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addOrgMember } from '../helpers/hostedApplicationExportFixtures';
import {
  createHandoverFakes,
  seedAwsRepository,
  seedHandoverWorld,
  type HandoverFakes,
  type HandoverWorld,
} from '../helpers/tenantHandoverFixtures';

export const MOTIR_ORG = 'motir-projects';
export const INSTALLATION = '556677';
export const TENANT_DOMAIN = 'motir.example';
export const DAY = 86_400_000;
const KEY = '7c'.repeat(32);
const ACCOUNT_B = '310987654321';
const REAL_PATH = process.env['PATH'];

const S3_ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.takeover-handover.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'test-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.takeover-handover.invalid/motir-public',
} as const;

// ── The timeline ────────────────────────────────────────────────────────────

/** The one ordered timeline every fake appends to. Re-pointed at the AWS
 *  fakes' own log when a world is seeded, so both write ONE array. */
export const timeline: { log: string[] } = { log: [] };

/** The calls a fake is told to fail: `failOn(call, times)`. */
const failures = new Map<string, number>();
/** What a test runs at the moment a call is made, before the fake answers:
 *  `onCall('database:deleteDatabase', read)`. */
const hooks = new Map<string, () => Promise<void>>();
export function onCall(call: string, hook: () => Promise<void>): void {
  hooks.set(call, hook);
}
export function failOn(call: string, times = 1): void {
  failures.set(call, times);
}
function failIfAsked(call: string): void {
  const left = failures.get(call) ?? 0;
  if (left <= 0) return;
  failures.set(call, left - 1);
  throw new Error(`the fake refused ${call}`);
}

/** The first index of `entry`, failing loudly when it is absent. */
export function at(entry: string): number {
  const index = timeline.log.indexOf(entry);
  expect(index, `${entry} in ${timeline.log.join(', ')}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** How many times `entry` is on the timeline. */
export const count = (entry: string) => timeline.log.filter((e) => e === entry).length;

/** The GitHub calls that name one repository — the calls that need Motir's
 *  access to it. */
export const repoCalls = (name: string) =>
  timeline.log
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) => entry.startsWith('github:') && entry.includes(`/repos/${MOTIR_ORG}/${name}/`),
    );

// ── GitHub at its fetch boundary ───────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function github(method: string, path: string): Response {
  if (path.includes('/access_tokens')) {
    return json(200, {
      token: 'ghs_handover',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  if (path === `/orgs/${MOTIR_ORG}/installation`) return json(200, { id: Number(INSTALLATION) });
  timeline.log.push(`github:${method} ${path}`);
  failIfAsked(`github:${method} ${path}`);
  if (method === 'GET') return json(404, { message: 'Not Found' });
  return new Response(null, { status: 204 });
}

// ── The hosting and database ports ─────────────────────────────────────────

const HOSTING_OPS = [
  'ensureApp',
  'deploy',
  'runReleaseCommand',
  'rollback',
  'destroyApp',
  'revokeDeployCredentials',
] as const;
const DATABASE_OPS = ['createDatabase', 'connectionEnv', 'deleteDatabase'] as const;

/** Wrap each method so a call appends `label:<op>` and may be made to fail,
 *  then runs the fake's own. */
function onTimeline(target: object, label: string, ops: readonly string[]): void {
  const methods = target as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  for (const op of ops) {
    const real = methods[op];
    if (typeof real !== 'function') continue;
    const inner = real.bind(target);
    vi.spyOn(methods as Record<string, (...args: unknown[]) => unknown>, op).mockImplementation(
      async (...args: unknown[]) => {
        timeline.log.push(`${label}:${op}`);
        await hooks.get(`${label}:${op}`)?.();
        failIfAsked(`${label}:${op}`);
        return inner(...args);
      },
    );
  }
}

export function hosting(target: 'fly' | 'serverless' = 'fly') {
  return getHostingDeployPort(target) as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
}

// ── Setup ───────────────────────────────────────────────────────────────────

/** The per-test setup: an empty database, fresh fakes on one timeline. */
export async function setUpHandover(): Promise<void> {
  await truncateAuthTables();
  timeline.log = [];
  failures.clear();
  hooks.clear();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('ENVIRONMENT_CONFIG_ENCRYPTION_KEY', KEY);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_PUBLIC_TENANT_DOMAIN', TENANT_DOMAIN);
  for (const [name, value] of Object.entries(S3_ENV)) vi.stubEnv(name, value);
  process.env['PATH'] = `${join(__dirname, '..', 'helpers', 'fakePgDump')}${delimiter}${REAL_PATH}`;
  const { resetS3ClientForTests } = await import('@/lib/blob/s3');
  resetS3ClientForTests();
  installBlobStoreMock();
  resetHostingFakes();
  resetDatabaseFakes();
  onTimeline(hosting('fly'), 'hosting', HOSTING_OPS);
  onTimeline(hosting('serverless'), 'hosting', HOSTING_OPS);
  onTimeline(getDatabasePort(), 'database', DATABASE_OPS);
  vi.spyOn(repoTransferClient, 'transferRepo').mockImplementation(async (input) => {
    timeline.log.push(`transfer:${input.repo}`);
    failIfAsked(`transfer:${input.repo}`);
    return { completed: true };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) =>
      github(init?.method ?? 'GET', String(url).replace('https://api.github.com', '')),
    ),
  );
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
}

export function tearDownHandover(): void {
  process.env['PATH'] = REAL_PATH;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

// ── The seed ────────────────────────────────────────────────────────────────

export interface People {
  ownerId: string;
  adminId: string;
  memberId: string;
}

export interface HostedRepo {
  repoId: string;
  providerRepoId: string;
  name: string;
  applicationId: string;
  domainId: string;
  domain: string;
  productionAddress: string;
}

export interface OrganisationA {
  world: HandoverWorld;
  fakes: HandoverFakes;
  fx: WorkItemFixture;
  people: People;
  fly: HostedRepo;
  serverless: HostedRepo;
}

export interface OrganisationB {
  fx: WorkItemFixture;
  organizationId: string;
  tenantAccountId: string;
  people: People;
  applicationId: string;
}

async function people(fx: WorkItemFixture, tag: string): Promise<People> {
  const admin = await createTestUser({ name: `Admin ${tag}`, email: `admin-${tag}@handover.test` });
  const member = await createTestUser({
    name: `Member ${tag}`,
    email: `member-${tag}@handover.test`,
  });
  await addOrgMember(fx.workspace.organizationId, admin.id, 'admin');
  await addOrgMember(fx.workspace.organizationId, member.id, 'member');
  return { ownerId: fx.ownerId, adminId: admin.id, memberId: member.id };
}

let seq = 0;

/** A Motir repository on Fly or serverless, mirrored under Motir's GitHub
 *  installation, with its live application on a database, a live release and
 *  a bound customer domain. */
export async function seedHostedRepo(
  fx: WorkItemFixture,
  target: 'fly' | 'serverless',
): Promise<HostedRepo> {
  seq += 1;
  const name = `${target}-${seq}`;
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION },
    create: {
      installationId: INSTALLATION,
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
      repoId: String(810_000 + seq),
      owner: MOTIR_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      position: `t${seq}`,
      seedSource: 'initialised',
      state: 'created',
      hostingTarget: target,
      githubRepoId: mirror.id,
    },
  });
  const { handle } = await getDatabasePort().createDatabase({ applicationRef: repo.id });
  const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
  const productionAddress = `${name}--${workspace.slug}.${TENANT_DOMAIN}`;
  const now = new Date();
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectRepositoryId: repo.id,
      target,
      slug: name,
      productionAppName: `mh-${repo.id}`,
      productionAddress,
      productionEnabledAt: now,
      productionTokenMintedAt: now,
      databaseProjectId: handle.databaseRef,
      databaseUrlCiphertext: 'v1:ciphertext',
    },
  });
  const release = await adminDb.hostedRelease.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      commitSha: 'b'.repeat(40),
      cause: 'merge',
      state: 'live',
      artifactRef: `registry.fly.io/mh-${repo.id}:${'b'.repeat(40)}`,
      providerReleaseId: `mh-${repo.id}@1`,
    },
  });
  const previous = await adminDb.hostedRelease.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      commitSha: 'c'.repeat(40),
      cause: 'merge',
      state: 'replaced',
      artifactRef: `registry.fly.io/mh-${repo.id}:${'c'.repeat(40)}`,
      providerReleaseId: `mh-${repo.id}@0`,
    },
  });
  await adminDb.hostedApplication.update({
    where: { id: app.id },
    data: { currentReleaseId: release.id, previousReleaseId: previous.id },
  });
  const domain = `www.${name}.example`;
  const bound = await adminDb.publicAddress.create({
    data: {
      workspaceId: fx.workspaceId,
      applicationId: app.id,
      hostname: domain,
      kind: 'custom_domain',
      status: 'issued',
      verificationToken: `motir-verify-${domain}`,
      issuedAt: new Date('2026-11-01T00:00:00Z'),
    },
  });
  return {
    repoId: repo.id,
    providerRepoId: mirror.repoId,
    name,
    applicationId: app.id,
    domainId: bound.id,
    domain,
    productionAddress,
  };
}

/** Organisation A, its AWS fakes on the timeline, and its preview and
 *  database stacks: one preview release and its database beside two
 *  production releases and theirs. */
export async function seedOrganisationA(): Promise<OrganisationA> {
  const world = await seedHandoverWorld();
  const fakes = createHandoverFakes(world);
  timeline.log = fakes.log;
  await fakes.seedStacks();
  const cf = fakes.clients.cloudformation;
  const shop = world.repos[0]!;
  await cf.createStack({
    name: `motir-database-${shop.id}-pr3`,
    templateBody: 'Resources: {}',
    parameters: {},
    tags: {},
  });
  for (const repo of world.repos) {
    await cf.createStack({
      name: `motir-database-${repo.id}`,
      templateBody: 'Resources: {}',
      parameters: {},
      tags: {},
    });
  }
  for (const stack of await cf.listStacks()) await cf.describeStack(stack.name);
  // The seed's own calls are not the handover's.
  fakes.log.length = 0;
  const fly = await seedHostedRepo(world.fx, 'fly');
  const serverless = await seedHostedRepo(world.fx, 'serverless');
  timeline.log.length = 0;
  // The default application of the workspace is the Fly one.
  await adminDb.workspace.update({
    where: { id: world.fx.workspaceId },
    data: { defaultApplicationId: fly.applicationId },
  });
  return { world, fakes, fx: world.fx, people: await people(world.fx, 'a'), fly, serverless };
}

/** Organisation B: its own tenant account, an AWS repository with its live
 *  application, an owner, a second admin and a member. */
export async function seedOrganisationB(): Promise<OrganisationB> {
  const fx = await makeWorkItemFixture({ name: 'Beta', identifier: 'BET' });
  const account = await adminDb.hostingTenantAccount.create({
    data: {
      organizationId: fx.workspace.organizationId,
      awsAccountId: ACCOUNT_B,
      state: 'ready',
      region: 'us-east-1',
    },
  });
  const { app } = await seedAwsRepository(fx, 'beta-shop');
  timeline.log.length = 0;
  return {
    fx,
    organizationId: fx.workspace.organizationId,
    tenantAccountId: account.id,
    people: await people(fx, 'b'),
    applicationId: app!.id,
  };
}

// ── Jobs ────────────────────────────────────────────────────────────────────

/** The `job_event` rows of one event name, oldest first. */
export function events<T>(name: string): Promise<{ data: T; idempotencyKey: string | null }[]> {
  return adminDb.jobEvent
    .findMany({ where: { name }, orderBy: { receivedAt: 'asc' } })
    .then((rows) =>
      rows.map((r) => ({ data: r.data as unknown as T, idempotencyKey: r.idempotencyKey })),
    );
}

/** Drive a job definition's own handler, its steps executed once. */
export async function runJob(job: { handler: unknown }, name: string, data: unknown) {
  const ctx = {
    event: { name, data, id: 'e' },
    attempt: 0,
    runId: 'run_handover',
    step: {
      run: async <T>(_id: string, fn: () => T | Promise<T>): Promise<T> => fn(),
      sleep: async () => undefined,
    },
  };
  return (job.handler as (c: typeof ctx, s: typeof jobServices) => Promise<unknown>)(
    ctx,
    jobServices,
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

export const application = (id: string) =>
  adminDb.hostedApplication.findUniqueOrThrow({ where: { id } });

export const repository = (id: string) => adminDb.projectRepo.findUniqueOrThrow({ where: { id } });

/** Every row a refused call must leave as it was, for one organisation. */
export async function rowsOf(organizationId: string) {
  const workspaces = await adminDb.workspace.findMany({ where: { organizationId } });
  const ids = workspaces.map((w) => w.id);
  const [accounts, steps, repos, apps, exportsMade, addresses] = await Promise.all([
    adminDb.hostingTenantAccount.findMany({ where: { organizationId } }),
    adminDb.hostingTenantHandoverStep.findMany({
      where: { tenantAccount: { organizationId } },
      orderBy: { step: 'asc' },
    }),
    adminDb.projectRepo.findMany({ where: { workspaceId: { in: ids } }, orderBy: { id: 'asc' } }),
    adminDb.hostedApplication.findMany({
      where: { workspaceId: { in: ids } },
      orderBy: { id: 'asc' },
    }),
    adminDb.hostedApplicationExport.findMany({
      where: { workspaceId: { in: ids } },
      orderBy: { id: 'asc' },
    }),
    adminDb.publicAddress.findMany({ where: { workspaceId: { in: ids } }, orderBy: { id: 'asc' } }),
  ]);
  return { workspaces, accounts, steps, repos, apps, exportsMade, addresses };
}
