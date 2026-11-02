import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  fleetReadinessService,
  FleetReadinessTargetNotFoundError,
  requestsFleetRunner,
  type FleetReadiness,
} from '@/lib/services/fleetReadinessService';
import type { FleetJobInventory, FleetInventoryJob } from '@/lib/ciFleet/fleetJobInventoryTypes';
import { workflowFingerprint } from '@/lib/ciFleet/workflowFingerprint';
import checkedInInventory from '@/lib/ciFleet/fleetJobInventory.json';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET READINESS VERDICT (Story MOTIR-8699 · MOTIR-8713), over real
// Postgres. The project, its repositories, their mirror rows and the runner-group
// row are real; GitHub (`fetch`) is the only fake, and the inventory manifest is
// handed in so each case can shape it.
//
// The fixture is an all-met world: a connected org whose provisioning-App
// installation has NO mirror row (the intake's fallback path), two private
// repositories and one public one, a synced runner group, and an inventory where
// every job is runnable. Each case breaks one thing.

// A `let` so one block can read the org the shipped manifest names (MOTIR-9410).
let ORG = 'acme-connected';
const STUDIO_INSTALLATION = '880011';
/** The user-facing App's installation on the org — the one that HAS a mirror row. */
const MIRROR_INSTALLATION = '55501';
const MEASURED_AT = '2026-10-01T00:00:00Z';
const SECRET_TOKEN = 'ghs_readiness_secret';

interface World {
  install: 'ok' | 404 | 500 | 'unreachable';
  installationId: string;
  permissions: Record<string, string>;
  events: string[];
  suspendedAt: string | null;
  visibility: Map<string, boolean>;
  reachable: Set<number> | null;
  head: Map<string, { sha: string; date: string } | 'fail'>;
  /** The workflow files each repository has at its head (MOTIR-8870); absent ⇒ the read is refused. */
  files: Map<string, Array<{ path: string; text: string }>>;
}

let world: World;
let repoIds: Map<string, number>;
let fx: WorkItemFixture;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const u = new URL(String(url));
      if (u.pathname === `/orgs/${ORG}/installation`) {
        if (world.install === 'unreachable') throw new TypeError('fetch failed');
        if (world.install !== 'ok') return json(world.install, { message: 'nope' });
        return json(200, {
          id: Number(world.installationId),
          permissions: world.permissions,
          events: world.events,
          repository_selection: 'selected',
          suspended_at: world.suspendedAt,
        });
      }
      if (/\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) {
        return json(200, {
          token: SECRET_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (u.pathname === '/installation/repositories') {
        const ids = world.reachable ?? new Set(repoIds.values());
        return json(200, { repositories: [...ids].map((id) => ({ id })) });
      }
      const commits = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(u.pathname);
      if (commits) {
        const head = world.head.get(commits[2]!);
        if (head === 'fail') return json(500, { message: 'boom' });
        return json(
          200,
          head ? [{ sha: head.sha, commit: { committer: { date: head.date } } }] : [],
        );
      }
      const tree = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/[^/]+$/.exec(u.pathname);
      if (tree) {
        const files = world.files.get(tree[2]!);
        if (!files) return json(500, { message: 'boom' });
        return json(200, {
          truncated: false,
          tree: files.map((f) => ({ type: 'blob', path: f.path })),
        });
      }
      const contents = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(u.pathname);
      if (contents) {
        const found = world.files
          .get(contents[2]!)
          ?.find((f) => f.path === decodeURI(contents[3]!));
        if (!found) return json(404, { message: 'Not Found' });
        return json(200, {
          encoding: 'base64',
          content: Buffer.from(found.text).toString('base64'),
        });
      }
      const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
      if (repo) {
        const isPrivate = world.visibility.get(repo[2]!);
        if (isPrivate === undefined) return json(404, { message: 'Not Found' });
        return json(200, { private: isPrivate });
      }
      return json(500, { message: `unexpected fetch ${u.href}` });
    }),
  );
}

let nextRepoId = 810_001;

async function connectRepos(names: string[]): Promise<void> {
  for (const name of names) repoIds.set(name, nextRepoId++);
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: MIRROR_INSTALLATION,
      accountLogin: ORG,
      accountType: 'Organization',
    },
    repos: names.map((name) => ({
      providerRepoId: String(repoIds.get(name)),
      owner: ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  const roles = ['web', 'api', 'mobile', 'shared', 'infra', 'other'] as const;
  for (const [i, name] of names.entries()) {
    const mirror = await adminDb.githubRepo.findFirstOrThrow({
      where: { repoId: String(repoIds.get(name)) },
    });
    await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: roles[i % roles.length]!,
        name,
        seedSource: SEED_SOURCE_PLATFORM_STARTER,
        position: `a${i}`,
        githubRepoId: mirror.id,
        state: 'connected',
      },
    });
  }
}

// What a job that follows the switch asks for (MOTIR-8813: only such a job counts).
const SEAM = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}";

function job(jobId: string, overrides: Partial<FleetInventoryJob> = {}): FleetInventoryJob {
  return {
    jobId,
    runsOn: SEAM,
    triggers: ['push'],
    verdict: 'runnable',
    missing: [],
    evidence: '.github/workflows/ci.yml:10',
    ...overrides,
  };
}

function inventory(jobs: Record<string, FleetInventoryJob[]> = {}): FleetJobInventory {
  const repos: FleetJobInventory['repos'] = {};
  for (const name of ['api', 'web', 'site']) {
    repos[`${ORG}/${name}`] = {
      repoRef: `${ORG}/${name}`,
      ref: 'main',
      sha: `sha-${name}`,
      visibility: name === 'site' ? 'public' : 'private',
      measuredAt: MEASURED_AT,
      imageDockerfileSha: 'df',
      jobCount: 1,
      workflows: [{ path: '.github/workflows/ci.yml', jobs: jobs[name] ?? [job('build')] }],
    };
  }
  return { schemaVersion: 1, repos };
}

function target() {
  return { projectId: fx.projectId, workspaceId: fx.workspaceId, org: ORG };
}

function cond(result: FleetReadiness, key: string) {
  const found = result.conditions.find((c) => c.key === key);
  if (!found) throw new Error(`no condition ${key}`);
  return found;
}

/** Exactly `key` is not met; every other condition is. */
function expectOnly(result: FleetReadiness, key: string, state: 'unmet' | 'unknown') {
  expect(result.ready).toBe(false);
  for (const c of result.conditions) {
    expect([c.key, c.state]).toEqual([c.key, c.key === key ? state : 'met']);
  }
}

const ORDER = [
  'kill_switch',
  'app_installed',
  'app_runner_permission',
  'app_variables_permission',
  'workflow_job_subscription',
  'app_repositories',
  'delivery_attributable',
  'runner_group',
  'image_coverage',
];

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  _resetInstallationTokenCache();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  fx = await makeWorkItemFixture();
  repoIds = new Map();
  await connectRepos(['api', 'web', 'site']);
  await adminDb.projectRunnerGroup.create({
    data: {
      projectId: fx.projectId,
      workspaceId: fx.workspaceId,
      org: ORG,
      installationId: STUDIO_INSTALLATION,
      runnerGroupId: 77,
      runnerGroupName: 'motir-project-x',
      syncedAt: new Date(),
      syncPending: false,
    },
  });
  world = {
    install: 'ok',
    installationId: STUDIO_INSTALLATION,
    permissions: {
      organization_self_hosted_runners: 'write',
      organization_actions_variables: 'write',
    },
    events: ['workflow_job'],
    suspendedAt: null,
    visibility: new Map([
      ['api', true],
      ['web', true],
      ['site', false],
    ]),
    reachable: null,
    head: new Map([
      ['api', { sha: 'sha-api', date: MEASURED_AT }],
      ['web', { sha: 'sha-web', date: MEASURED_AT }],
    ]),
    files: new Map(),
  };
  installGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the all-met world', () => {
  it('is ready, with the nine conditions in order, each carrying a message', async () => {
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });

    expect(result.ready).toBe(true);
    expect(result.org).toBe(ORG);
    expect(result.conditions.map((c) => c.key)).toEqual(ORDER);
    for (const c of result.conditions) {
      expect(c.state).toBe('met');
      expect(c.reasonCode).toMatch(/\w/);
      expect(c.message.length).toBeGreaterThan(0);
    }
    // The fallback path: the Studio installation has no mirror row, and that is
    // NOT unmet in workflow_job_subscription.
    expect(cond(result, 'delivery_attributable').params).toMatchObject({ path: 'unmirrored' });
  });

  it('never considers the public repository', async () => {
    world.reachable = new Set([repoIds.get('api')!, repoIds.get('web')!]);
    const result = await fleetReadinessService.readinessFor(target(), {
      inventory: inventory({ site: [job('build', { verdict: 'needs-image', missing: ['gh'] })] }),
    });

    expect(result.ready).toBe(true);
    const text = JSON.stringify(
      ['app_repositories', 'delivery_attributable', 'image_coverage'].map(
        (k) => cond(result, k).params,
      ),
    );
    expect(text).not.toContain(`${ORG}/site`);
  });

  it('leaks no token or JWT into any field', async () => {
    world.install = 500;
    const failed = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    const ok =
      (world.install = 'ok') &&
      (await fleetReadinessService.readinessFor(target(), { inventory: inventory() }));
    for (const result of [failed, ok]) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(SECRET_TOKEN);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    }
  });
});

describe('each condition, broken alone', () => {
  it('kill_switch', async () => {
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'kill_switch', 'unmet');
    expect(cond(result, 'kill_switch')).toMatchObject({ reasonCode: 'kill_switch_engaged' });
    expect(cond(result, 'kill_switch').message).toContain('MOTIR_FLEET_MAX_IN_FLIGHT=0');
  });

  it('app_installed (404) — and its dependants are unknown, never met', async () => {
    world.install = 404;
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(result.ready).toBe(false);
    expect(cond(result, 'app_installed')).toMatchObject({
      state: 'unmet',
      reasonCode: 'app_not_installed',
    });
    for (const key of ORDER.slice(2, 7)) {
      expect(cond(result, key)).toMatchObject({ state: 'unknown', reasonCode: 'app_not_readable' });
    }
    expect(cond(result, 'image_coverage').state).toBe('unknown');
  });

  it('app_installed (suspended)', async () => {
    world.suspendedAt = '2026-10-10T00:00:00Z';
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(cond(result, 'app_installed')).toMatchObject({
      state: 'unmet',
      reasonCode: 'app_suspended',
    });
    expect(result.ready).toBe(false);
  });

  it.each([
    ['a 5xx', 500 as const, 500],
    ['a transport failure', 'unreachable' as const, null],
  ])(
    'app_installed is unknown on %s, and so are its dependants',
    async (_label, install, status) => {
      world.install = install;
      const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
      expect(result.ready).toBe(false);
      expect(cond(result, 'app_installed')).toMatchObject({
        state: 'unknown',
        reasonCode: 'read_failed',
        params: { status },
      });
      for (const key of ORDER.slice(2, 7)) {
        expect(cond(result, key)).toMatchObject({
          state: 'unknown',
          reasonCode: 'app_not_readable',
        });
      }
      expect(result.conditions.filter((c) => c.state === 'met').map((c) => c.key)).toEqual([
        'kill_switch',
        'runner_group',
      ]);
    },
  );

  it.each([
    [
      'app_runner_permission',
      'organization_self_hosted_runners',
      'read',
      'permission_insufficient',
    ],
    ['app_runner_permission', 'organization_self_hosted_runners', undefined, 'permission_missing'],
    [
      'app_variables_permission',
      'organization_actions_variables',
      'read',
      'permission_insufficient',
    ],
    ['app_variables_permission', 'organization_actions_variables', undefined, 'permission_missing'],
  ])('%s with %s=%s', async (key, permission, value, reasonCode) => {
    if (value === undefined) delete world.permissions[permission];
    else world.permissions[permission] = value;
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, key, 'unmet');
    expect(cond(result, key).reasonCode).toBe(reasonCode);
  });

  it('workflow_job_subscription', async () => {
    world.events = ['push'];
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'workflow_job_subscription', 'unmet');
    expect(cond(result, 'workflow_job_subscription').message).toContain('workflow_job');
  });

  it('app_repositories names the private repository the installation does not reach', async () => {
    world.reachable = new Set([repoIds.get('api')!]);
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'app_repositories', 'unmet');
    expect(cond(result, 'app_repositories')).toMatchObject({
      reasonCode: 'repositories_not_granted',
      params: { missing: [`${ORG}/web`] },
    });
  });

  it('a project with no private repository in the org is never ready', async () => {
    world.visibility.set('api', false);
    world.visibility.set('web', false);
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(result.ready).toBe(false);
    for (const key of ['app_repositories', 'delivery_attributable', 'image_coverage']) {
      expect(cond(result, key)).toMatchObject({
        state: 'unmet',
        reasonCode: 'no_private_repositories',
      });
    }
  });

  it('runner_group — no row', async () => {
    await adminDb.projectRunnerGroup.deleteMany({ where: { projectId: fx.projectId } });
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'runner_group', 'unmet');
    expect(cond(result, 'runner_group').reasonCode).toBe('no_runner_group');
    expect(cond(result, 'runner_group').message).toContain(
      'scripts/ci-fleet/sync-project-runner-groups.ts',
    );
  });

  it('runner_group — sync pending', async () => {
    await adminDb.projectRunnerGroup.updateMany({
      where: { projectId: fx.projectId },
      data: { syncPending: true },
    });
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'runner_group', 'unmet');
    expect(cond(result, 'runner_group').reasonCode).toBe('sync_pending');
  });
});

describe('delivery_attributable, on both of the intake’s paths', () => {
  it('MIRRORED installation: resolves through findByInstallationAndRepoId', async () => {
    world.installationId = MIRROR_INSTALLATION;
    const byPair = vi.spyOn(githubRepoRepository, 'findByInstallationAndRepoId');
    const byRepo = vi.spyOn(githubRepoRepository, 'listByRepoId');
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(result.ready).toBe(true);
    expect(cond(result, 'delivery_attributable').params).toMatchObject({ path: 'mirrored' });
    expect(byPair).toHaveBeenCalled();
    expect(byRepo).not.toHaveBeenCalled();
  });

  it('MIRRORED installation with no row for the repository ⇒ unmet, no_row', async () => {
    // A mirrored installation that does not carry the project's repositories.
    await adminDb.githubInstallation.create({
      data: {
        installationId: '99901',
        workspaceId: fx.workspaceId,
        accountLogin: ORG,
        accountType: 'Organization',
        provider: 'github',
      },
    });
    world.installationId = '99901';
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      path: 'mirrored',
      failures: [
        { repository: `${ORG}/api`, reason: 'no_row' },
        { repository: `${ORG}/web`, reason: 'no_row' },
      ],
    });
  });

  it('UNMIRRORED installation: several rows for one repository ⇒ unmet, several_rows', async () => {
    const second = await adminDb.githubInstallation.create({
      data: {
        installationId: '99902',
        workspaceId: fx.workspaceId,
        accountLogin: ORG,
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: second.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: String(repoIds.get('web')),
        owner: ORG,
        name: 'web',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    const byRepo = vi.spyOn(githubRepoRepository, 'listByRepoId');
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(byRepo).toHaveBeenCalled();
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      path: 'unmirrored',
      failures: [{ repository: `${ORG}/web`, reason: 'several_rows' }],
    });
  });

  it('UNMIRRORED installation: an owner mismatch or no row ⇒ unmet, naming each', async () => {
    const real = githubRepoRepository.listByRepoId.bind(githubRepoRepository);
    vi.spyOn(githubRepoRepository, 'listByRepoId').mockImplementation(async (repoId, tx) => {
      if (repoId === String(repoIds.get('api'))) return [];
      const rows = await real(repoId, tx);
      return rows.map((r) => ({ ...r, owner: 'someone-else' }));
    });
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      failures: [
        { repository: `${ORG}/api`, reason: 'no_row' },
        { repository: `${ORG}/web`, reason: 'owner_mismatch' },
      ],
    });
  });
});

describe('image_coverage', () => {
  it('lists EVERY job that requests the fleet and is not runnable', async () => {
    const result = await fleetReadinessService.readinessFor(target(), {
      inventory: inventory({
        api: [
          job('build', { verdict: 'needs-image', missing: ['gh'] }),
          job('arm', { verdict: 'cannot-host', reason: 'arm64 only' }),
          job('ok'),
        ],
      }),
    });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage')).toMatchObject({
      reasonCode: 'jobs_not_runnable',
      params: {
        jobs: [
          { repoRef: `${ORG}/api`, jobId: 'build', verdict: 'needs-image', missing: ['gh'] },
          { repoRef: `${ORG}/api`, jobId: 'arm', verdict: 'cannot-host', reason: 'arm64 only' },
        ],
      },
    });
  });

  it('a job that never requests the fleet does not count, and is named as GitHub-hosted (MOTIR-8813)', async () => {
    const result = await fleetReadinessService.readinessFor(target(), {
      inventory: inventory({
        api: [
          job('mac', {
            runsOn: 'macos-latest',
            verdict: 'cannot-host',
            reason: 'runs-on macos-latest',
          }),
          job('pinned', {
            runsOn: 'ubuntu-latest',
            verdict: 'needs-image',
            missing: ['binfmt-misc'],
          }),
          job('ok'),
        ],
      }),
    });
    expect(result.ready).toBe(true);
    expect(cond(result, 'image_coverage')).toMatchObject({
      state: 'met',
      reasonCode: 'all_runnable',
      params: {
        githubHostedJobs: [
          { repoRef: `${ORG}/api`, workflow: '.github/workflows/ci.yml', jobId: 'mac' },
          { repoRef: `${ORG}/api`, workflow: '.github/workflows/ci.yml', jobId: 'pinned' },
        ],
      },
    });
  });

  it('the same job asking for the fleet label outright still counts (MOTIR-8813)', async () => {
    const result = await fleetReadinessService.readinessFor(target(), {
      inventory: inventory({
        web: [
          job('img', {
            runsOn: ['self-hosted', 'motir-runner'],
            verdict: 'needs-image',
            missing: ['binfmt-misc'],
          }),
        ],
      }),
    });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage')).toMatchObject({
      reasonCode: 'jobs_not_runnable',
      params: { jobs: [{ repoRef: `${ORG}/web`, jobId: 'img' }], githubHostedJobs: [] },
    });
  });

  it('an unverified job is unmet, and named', async () => {
    const result = await fleetReadinessService.readinessFor(target(), {
      inventory: inventory({
        web: [job('e2e', { verdict: 'needs-image', missing: ['unverified'] })],
      }),
    });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage').message).toContain('e2e');
  });

  it('a private repository missing from the manifest ⇒ not_inventoried', async () => {
    const inv = inventory();
    delete inv.repos[`${ORG}/web`];
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inv });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage').reasonCode).toBe('not_inventoried');
  });

  it('workflows changed after the measurement ⇒ inventory_stale', async () => {
    world.head.set('api', { sha: 'newer', date: '2026-10-12T00:00:00Z' });
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage')).toMatchObject({
      reasonCode: 'inventory_stale',
      params: { stale: [{ repository: `${ORG}/api`, measuredSha: 'sha-api', headSha: 'newer' }] },
    });
  });

  it('a failed commits read ⇒ unknown', async () => {
    world.head.set('web', 'fail');
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'image_coverage', 'unknown');
  });

  it("an entry measured under the org's former name still matches after a rename (MOTIR-9410)", async () => {
    const inv = inventory({ api: [job('build', { verdict: 'needs-image', missing: ['gh'] })] });
    for (const [key, entry] of Object.entries(inv.repos)) {
      const name = key.slice(key.indexOf('/') + 1);
      delete inv.repos[key];
      inv.repos[`former-org/${name}`] = { ...entry, repoRef: `former-org/${name}` };
    }
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inv });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage')).toMatchObject({
      reasonCode: 'jobs_not_runnable',
      // The live repository is named, never the manifest's stale `owner/`.
      params: { jobs: [{ repoRef: `${ORG}/api`, jobId: 'build' }] },
    });
  });

  it("an exact owner/name entry wins over another org's entry of the same name", async () => {
    const inv = inventory();
    // Listed FIRST, so a name-only lookup would land on it.
    inv.repos = {
      'other-org/api': {
        ...inv.repos[`${ORG}/api`]!,
        repoRef: 'other-org/api',
        workflows: [
          { path: '.github/workflows/ci.yml', jobs: [job('x', { verdict: 'needs-image' })] },
        ],
      },
      ...inv.repos,
    };
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inv });
    expect(cond(result, 'image_coverage').state).toBe('met');
  });

  describe('the shipped manifest, read for the org it names (MOTIR-9410)', () => {
    const shipped = checkedInInventory as FleetJobInventory;
    const entry = shipped.repos['motir-co/motir-ai']!;

    beforeAll(() => {
      ORG = 'motir-co';
    });
    afterAll(() => {
      ORG = 'acme-connected';
    });

    beforeEach(async () => {
      await connectRepos(['motir-ai']);
      world.visibility = new Map([
        ['api', false],
        ['web', false],
        ['site', false],
        ['motir-ai', true],
      ]);
      world.head.set('motir-ai', { sha: entry.sha, date: entry.measuredAt });
    });

    it('a motir-co/motir-ai private repository is inventoried, and its image coverage is met', async () => {
      const result = await fleetReadinessService.readinessFor(target(), { inventory: shipped });
      expect(cond(result, 'image_coverage')).toMatchObject({
        state: 'met',
        reasonCode: 'all_runnable',
        params: { repositories: ['motir-co/motir-ai'] },
      });
    });
  });

  describe('a newer workflow commit that leaves the structure alone (MOTIR-8870)', () => {
    const CI = '.github/workflows/ci.yml';
    // `build` runs on the seam, as the recorded job does; `lint` keeps
    // `ubuntu-latest` in use, so a move between the two leaves the digest put.
    const ci = (steps: string, buildRunsOn = SEAM, extraJobs = '') =>
      `jobs:\n  build:\n    runs-on: ${buildRunsOn}\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm test\n${steps}  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n${extraJobs}`;
    const measured = [{ path: CI, text: ci('') }];

    function recorded(): FleetJobInventory {
      const inv = inventory();
      inv.repos[`${ORG}/api`]!.structureFingerprint = workflowFingerprint(measured);
      return inv;
    }

    beforeEach(() => {
      world.head.set('api', { sha: 'newer', date: '2026-10-12T00:00:00Z' });
    });

    it('a new step with tools the repository already uses ⇒ met', async () => {
      world.files.set('api', [{ path: CI, text: ci('      - run: pnpm lint\n') }]);
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expect(result.ready).toBe(true);
      expect(cond(result, 'image_coverage').state).toBe('met');
    });

    // MOTIR-10211: motir-infra#7's `verify` job, on the seam with known tools.
    it('a job added on a runner and with tools the repository already uses ⇒ met', async () => {
      const verify = `  verify:\n    runs-on: ${SEAM}\n    steps:\n      - run: pnpm test\n`;
      world.files.set('api', [{ path: CI, text: ci('', SEAM, verify) }]);
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expect(result.ready).toBe(true);
      expect(cond(result, 'image_coverage').state).toBe('met');
    });

    it('a job added on a runner the repository does not use yet ⇒ inventory_stale', async () => {
      const mac = `  mac:\n    runs-on: macos-latest\n    steps:\n      - run: pnpm test\n`;
      world.files.set('api', [{ path: CI, text: ci('', SEAM, mac) }]);
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expect(cond(result, 'image_coverage').reasonCode).toBe('inventory_stale');
    });

    it('a recorded job moving to another runner the repository already uses ⇒ inventory_stale', async () => {
      // `seam` keeps the seam in use, so the repository-wide runners are unchanged.
      const moved = ci(
        '',
        'ubuntu-latest',
        `  seam:\n    runs-on: ${SEAM}\n    steps:\n      - run: pnpm test\n`,
      );
      world.files.set('api', [{ path: CI, text: moved }]);
      // The digest cannot see this move; the per-job runner check does.
      expect(workflowFingerprint([{ path: CI, text: moved }])).toBe(workflowFingerprint(measured));
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expectOnly(result, 'image_coverage', 'unmet');
      expect(cond(result, 'image_coverage')).toMatchObject({
        reasonCode: 'inventory_stale',
        params: { stale: [{ repository: `${ORG}/api`, measuredSha: 'sha-api', headSha: 'newer' }] },
      });
    });

    it('a new executable ⇒ inventory_stale', async () => {
      world.files.set('api', [{ path: CI, text: ci('      - run: gh pr list\n') }]);
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expectOnly(result, 'image_coverage', 'unmet');
      expect(cond(result, 'image_coverage').reasonCode).toBe('inventory_stale');
    });

    it('a head whose files cannot be read ⇒ inventory_stale, never met', async () => {
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expectOnly(result, 'image_coverage', 'unmet');
      expect(cond(result, 'image_coverage').reasonCode).toBe('inventory_stale');
    });

    it('invalid YAML at the head ⇒ inventory_stale', async () => {
      world.files.set('api', [{ path: CI, text: 'jobs: [unclosed' }]);
      const result = await fleetReadinessService.readinessFor(target(), { inventory: recorded() });
      expect(cond(result, 'image_coverage').reasonCode).toBe('inventory_stale');
    });

    it('an entry with no recorded fingerprint is stale on any newer commit, as before', async () => {
      world.files.set('api', [{ path: CI, text: ci('') }]);
      const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
      expect(cond(result, 'image_coverage').reasonCode).toBe('inventory_stale');
    });
  });
});

describe('the reads that can fail, and the remaining shapes', () => {
  /** Answer one path from `override`, every other from the world's fake. */
  function overrideFetch(path: string, override: () => Response | Promise<Response>): void {
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      new URL(String(url)).pathname === path ? override() : inner(url, init),
    );
  }

  it('a refused visibility read ⇒ the three conditions that need the private set are unknown', async () => {
    world.visibility.delete('web');
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(result.ready).toBe(false);
    for (const key of ['app_repositories', 'delivery_attributable', 'image_coverage']) {
      expect(cond(result, key)).toMatchObject({
        state: 'unknown',
        reasonCode: 'read_failed',
        params: { status: 404 },
      });
      expect(cond(result, key).message).toContain('GitHub answered HTTP 404');
    }
    expect(cond(result, 'runner_group').state).toBe('met');
  });

  it('a visibility read that fails with no GitHub status reads as unreachable, and leaks nothing', async () => {
    overrideFetch(`/repos/${ORG}/api`, () => {
      // A response whose `ok` getter throws: an error that is none of GitHub's.
      return {
        get ok(): boolean {
          throw new TypeError('the private detail');
        },
        json: async () => ({}),
      } as unknown as Response;
    });
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(cond(result, 'app_repositories')).toMatchObject({
      state: 'unknown',
      params: { status: null },
    });
    expect(cond(result, 'app_repositories').message).toContain('GitHub could not be reached');
    expect(JSON.stringify(result)).not.toContain('the private detail');
  });

  it('a failed installation-repositories read ⇒ app_repositories unknown, the rest met', async () => {
    overrideFetch('/installation/repositories', () => json(502, { message: 'Bad Gateway' }));
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'app_repositories', 'unknown');
    expect(cond(result, 'app_repositories').params).toEqual({ status: 502 });
  });

  it('MIRRORED installation whose row sits in another workspace ⇒ other_workspace', async () => {
    world.installationId = MIRROR_INSTALLATION;
    const real = githubRepoRepository.findByInstallationAndRepoId.bind(githubRepoRepository);
    vi.spyOn(githubRepoRepository, 'findByInstallationAndRepoId').mockImplementation(
      async (installationId, repoId, tx) => {
        const row = await real(installationId, repoId, tx);
        return row && repoId === String(repoIds.get('api'))
          ? { ...row, workspaceId: 'another-workspace' }
          : row;
      },
    );
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      path: 'mirrored',
      failures: [{ repository: `${ORG}/api`, reason: 'other_workspace' }],
    });
    expect(cond(result, 'delivery_attributable').message).toContain(
      'a mirror row in another workspace',
    );
  });

  it('UNMIRRORED installation whose one row sits in another workspace ⇒ other_workspace', async () => {
    const real = githubRepoRepository.listByRepoId.bind(githubRepoRepository);
    vi.spyOn(githubRepoRepository, 'listByRepoId').mockImplementation(async (repoId, tx) => {
      const rows = await real(repoId, tx);
      return repoId === String(repoIds.get('web'))
        ? rows.map((r) => ({ ...r, workspaceId: 'another-workspace' }))
        : rows;
    });
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      path: 'unmirrored',
      failures: [{ repository: `${ORG}/web`, reason: 'other_workspace' }],
    });
  });

  it('an attribution read that throws ⇒ delivery_attributable unknown, naming only the error class', async () => {
    const spy = vi.spyOn(githubRepoRepository, 'listByRepoId');
    spy.mockRejectedValueOnce(new RangeError('the private detail'));
    const first = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(first, 'delivery_attributable', 'unknown');
    expect(cond(first, 'delivery_attributable')).toMatchObject({ reasonCode: 'read_failed' });
    expect(cond(first, 'delivery_attributable').message).toContain(': RangeError.');
    expect(JSON.stringify(first)).not.toContain('the private detail');

    spy.mockRejectedValueOnce('not an error');
    const second = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(cond(second, 'delivery_attributable').message).toContain(': read failed.');
  });

  it('a runner-group read that throws ⇒ runner_group unknown, naming only the error class', async () => {
    const spy = vi.spyOn(projectRunnerGroupService, 'readForOrg');
    spy.mockRejectedValueOnce(new SyntaxError('the private detail'));
    const first = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expectOnly(first, 'runner_group', 'unknown');
    expect(cond(first, 'runner_group')).toMatchObject({ reasonCode: 'read_failed' });
    expect(cond(first, 'runner_group').message).toContain('(SyntaxError)');
    expect(JSON.stringify(first)).not.toContain('the private detail');

    spy.mockRejectedValueOnce(42);
    const second = await fleetReadinessService.readinessFor(target(), { inventory: inventory() });
    expect(cond(second, 'runner_group').message).toContain('(read failed)');
  });

  it('two private repositories missing from the manifest are named in the plural', async () => {
    const inv = inventory();
    delete inv.repos[`${ORG}/web`];
    delete inv.repos[`${ORG}/api`];
    const result = await fleetReadinessService.readinessFor(target(), { inventory: inv });
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage')).toMatchObject({
      reasonCode: 'not_inventoried',
      params: { repositories: [`${ORG}/api`, `${ORG}/web`] },
    });
    expect(cond(result, 'image_coverage').message).toContain('are not in the fleet job inventory');
    expect(cond(result, 'image_coverage').message).toContain('their jobs');
  });

  it('one job not runnable is named in the singular', async () => {
    const result = await fleetReadinessService.readinessFor(target(), {
      inventory: inventory({ web: [job('lint', { verdict: 'needs-image', missing: [] })] }),
    });
    expect(cond(result, 'image_coverage').message).toMatch(/^1 job cannot run/);
    expect(cond(result, 'image_coverage').message).toContain('lint (needs-image)');
  });
});

describe('requestsFleetRunner (MOTIR-8813)', () => {
  it.each([
    [SEAM, true],
    ['${{ vars.MOTIR_RUNNER }}', true],
    ['motir-runner', true],
    ['MOTIR-RUNNER', true],
    [['self-hosted', 'motir-runner'], true],
    [[SEAM], true],
    [{ group: 'g', labels: ['motir-runner'] }, true],
    [{ group: 'g', labels: 'motir-runner' }, true],
    ['ubuntu-latest', false],
    [['ubuntu-latest'], false],
    ['macos-latest', false],
    ['windows-latest', false],
    [{ group: 'g' }, false],
    [null, false],
    [undefined, false],
  ])('%j ⇒ %s', (runsOn, expected) => {
    expect(requestsFleetRunner(runsOn)).toBe(expected);
  });
});

describe('the checked-in manifest (MOTIR-8813 · MOTIR-8815)', () => {
  it("every fleet-bound job in project MOTIR's private repositories is runnable", () => {
    const gaps = Object.values(checkedInInventory.repos)
      .filter((r) => r.visibility === 'private')
      .flatMap((r) =>
        r.workflows.flatMap((w) =>
          w.jobs
            .filter((j) => requestsFleetRunner(j.runsOn))
            .filter((j) => j.verdict !== 'runnable' || j.missing.includes('unverified'))
            .map((j) => `${r.repoRef} ${w.path} ${j.jobId} ${j.missing.join(',')}`),
        ),
      );
    expect(gaps).toEqual([]);
  });
});

describe('the boundary', () => {
  it('throws FleetReadinessTargetNotFoundError for a project that does not exist', async () => {
    await expect(
      fleetReadinessService.readinessFor(
        { projectId: 'nope', workspaceId: fx.workspaceId, org: ORG },
        { inventory: inventory() },
      ),
    ).rejects.toBeInstanceOf(FleetReadinessTargetNotFoundError);
  });

  it('names no org: no moooon, isMeta or motir-projects in either new file', () => {
    let out = '';
    try {
      out = execFileSync(
        'git',
        [
          'grep',
          '-n',
          '-i',
          '-E',
          'moooon|isMeta|motir-projects',
          '--',
          'lib/services/fleetReadinessService.ts',
          'lib/github/orgInstallation.ts',
        ],
        { encoding: 'utf8' },
      );
    } catch {
      out = ''; // git grep exits 1 when nothing matches
    }
    // A COMMENT may name what the code refuses to do — the service's own header
    // says it has no `isMeta` — so only code lines are judged (MOTIR-8716: this
    // grep matched that comment and was red from the commit that added it).
    const codeHits = out
      .split('\n')
      .filter((line) => line !== '')
      .filter((line) => !/^[^:]+:\d+:\s*(\/\/|\*|\/\*)/.test(line));
    expect(codeHits).toEqual([]);
  });
});
