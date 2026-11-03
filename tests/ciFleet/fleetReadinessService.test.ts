import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  fleetReadinessService,
  FleetReadinessTargetNotFoundError,
  requestsFleetRunner,
  type FleetReadiness,
} from '@/lib/services/fleetReadinessService';
import { _resetRunnerImageToolsCache } from '@/lib/services/runnerImageToolsService';
import { _resetWorkflowCoverageCache } from '@/lib/services/workflowCoverageService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRunnerGroupService } from '@/lib/services/projectRunnerGroupService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE FLEET READINESS VERDICT (Story MOTIR-8699 · MOTIR-8713), over real
// Postgres. The project, its repositories, their mirror rows and the runner-group
// row are real; GitHub and the runner image's registry (`fetch`) are the only
// fakes.
//
// The fixture is an all-met world: a connected org whose provisioning-App
// installation has NO mirror row (the intake's fallback path), two private
// repositories and one public one, a synced runner group, workflows whose every
// fleet job the pinned image can run (MOTIR-10290), and that image's tool list.
// Each case breaks one thing.

const ORG = 'acme-connected';
const STUDIO_INSTALLATION = '880011';
/** The user-facing App's installation on the org — the one that HAS a mirror row. */
const MIRROR_INSTALLATION = '55501';
const MEASURED_AT = '2026-10-01T00:00:00Z';
const REGISTRY = 'registry.readiness.test';
const RUNNER_IMAGE = `${REGISTRY}/motir-ci-runner@sha256:${'ab'.repeat(32)}`;
const CI = '.github/workflows/ci.yml';
const IMAGE_TOOLS = ['bash', 'sh', 'git', 'echo', 'curl', 'jq', 'docker', 'node', 'npm'];
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
  /** The workflow files each repository has at its head; absent ⇒ the read is refused. */
  files: Map<string, Array<{ path: string; text: string }>>;
  /** Remote actions' `action.yml` by `owner/repo[/path]`: text, or the status the read answers. */
  actions: Map<string, string | number>;
  /** The pinned image's tool label: its tools, no label, or the registry's failure status. */
  image: string[] | 'unlabelled' | number;
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
      if (u.host === REGISTRY) {
        if (typeof world.image === 'number') return json(world.image, {});
        if (u.pathname.includes('/manifests/')) {
          return json(200, { schemaVersion: 2, config: { digest: 'sha256:cfg' }, layers: [] });
        }
        const labels =
          world.image === 'unlabelled' ? {} : { 'co.motir.ci-runner.tools': world.image.join(',') };
        return json(200, { config: { Labels: labels } });
      }
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
      if (contents && contents[1] !== ORG) {
        const dir = decodeURI(contents[3]!).replace(/\/?action\.ya?ml$/, '');
        const key = [contents[1], contents[2], dir].filter(Boolean).join('/');
        const found = u.pathname.endsWith('action.yml') ? world.actions.get(key) : undefined;
        if (found === undefined) return json(404, { message: 'Not Found' });
        if (typeof found === 'number') return json(found, { message: 'nope' });
        return json(200, { encoding: 'base64', content: Buffer.from(found).toString('base64') });
      }
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

/** A workflow file: each job as `[jobId, runsOn, steps]`, steps as YAML lines. */
function workflow(jobs: Array<[string, unknown, string[]]>): string {
  const lines = ['on: [push]', 'jobs:'];
  for (const [jobId, runsOn, steps] of jobs) {
    lines.push(`  ${jobId}:`, `    runs-on: ${JSON.stringify(runsOn)}`, '    steps:');
    for (const step of steps) lines.push(`      - ${step}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The all-met workflow: one seam job the image can run. */
const runnable = () =>
  workflow([['build', SEAM, ['uses: actions/checkout@v4', 'run: git status && node --version']]]);

/** Set a repository's workflows at a new head, as a push would. */
function push(repo: string, files: Array<{ path: string; text: string }>, sha = `sha-${repo}-2`) {
  world.head.set(repo, { sha, date: '2026-10-12T00:00:00Z' });
  world.files.set(repo, files);
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
    files: new Map([
      ['api', [{ path: CI, text: runnable() }]],
      ['web', [{ path: CI, text: runnable() }]],
    ]),
    actions: new Map([['actions/checkout', "runs:\n  using: 'node24'\n  main: dist/index.js"]]),
    image: [...IMAGE_TOOLS],
  };
  vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
  _resetRunnerImageToolsCache();
  _resetWorkflowCoverageCache();
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
    const result = await fleetReadinessService.readinessFor(target());

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
    world.files.set('site', [{ path: CI, text: workflow([['b', SEAM, ['run: gh pr list']]]) }]);
    world.head.set('site', { sha: 'sha-site', date: MEASURED_AT });
    const result = await fleetReadinessService.readinessFor(target());

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
    const failed = await fleetReadinessService.readinessFor(target());
    const ok = (world.install = 'ok') && (await fleetReadinessService.readinessFor(target()));
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
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'kill_switch', 'unmet');
    expect(cond(result, 'kill_switch')).toMatchObject({ reasonCode: 'kill_switch_engaged' });
    expect(cond(result, 'kill_switch').message).toContain('MOTIR_FLEET_MAX_IN_FLIGHT=0');
  });

  it('app_installed (404) — and its dependants are unknown, never met', async () => {
    world.install = 404;
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
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
      const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, key, 'unmet');
    expect(cond(result, key).reasonCode).toBe(reasonCode);
  });

  it('workflow_job_subscription', async () => {
    world.events = ['push'];
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'workflow_job_subscription', 'unmet');
    expect(cond(result, 'workflow_job_subscription').message).toContain('workflow_job');
  });

  it('app_repositories names the private repository the installation does not reach', async () => {
    world.reachable = new Set([repoIds.get('api')!]);
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'app_repositories', 'unmet');
    expect(cond(result, 'app_repositories')).toMatchObject({
      reasonCode: 'repositories_not_granted',
      params: { missing: [`${ORG}/web`] },
    });
  });

  it('a project with no private repository in the org is never ready', async () => {
    world.visibility.set('api', false);
    world.visibility.set('web', false);
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'runner_group', 'unmet');
    expect(cond(result, 'runner_group').reasonCode).toBe('sync_pending');
  });
});

describe('delivery_attributable, on both of the intake’s paths', () => {
  it('MIRRORED installation: resolves through findByInstallationAndRepoId', async () => {
    world.installationId = MIRROR_INSTALLATION;
    const byPair = vi.spyOn(githubRepoRepository, 'findByInstallationAndRepoId');
    const byRepo = vi.spyOn(githubRepoRepository, 'listByRepoId');
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      failures: [
        { repository: `${ORG}/api`, reason: 'no_row' },
        { repository: `${ORG}/web`, reason: 'owner_mismatch' },
      ],
    });
  });
});

describe('image_coverage, computed from the workflows at head (MOTIR-10290)', () => {
  it('is met, naming the repositories, the heads read and the pinned image', async () => {
    const result = await fleetReadinessService.readinessFor(target());
    expect(cond(result, 'image_coverage')).toMatchObject({
      state: 'met',
      reasonCode: 'all_runnable',
      params: {
        repositories: [`${ORG}/api`, `${ORG}/web`],
        githubHostedJobs: [],
        heads: [
          { repository: `${ORG}/api`, headSha: 'sha-api' },
          { repository: `${ORG}/web`, headSha: 'sha-web' },
        ],
        image: RUNNER_IMAGE,
      },
    });
    expect(cond(result, 'image_coverage').message).toContain(RUNNER_IMAGE);
  });

  // AC1 — a workflow change updates the verdict with no manifest edit.
  it('a NEW JOB the image cannot run is unmet, naming repository, workflow, job and tool', async () => {
    push('api', [
      {
        path: CI,
        text: workflow([
          ['build', SEAM, ['run: git status']],
          ['deploy', SEAM, ['run: aws s3 sync dist s3://bucket']],
        ]),
      },
    ]);
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'image_coverage', 'unmet');
    const c = cond(result, 'image_coverage');
    expect(c).toMatchObject({
      reasonCode: 'jobs_not_runnable',
      params: {
        jobs: [
          {
            repoRef: `${ORG}/api`,
            workflow: CI,
            jobId: 'deploy',
            verdict: 'needs-image',
            missing: ['aws'],
            reason: null,
          },
        ],
      },
    });
    // AC2 — the message names the gap; the old staleness sentence is gone.
    expect(c.message).toContain(`${ORG}/api ci.yml deploy (needs aws, which the image lacks)`);
    expect(c.message).not.toContain('changed after');
  });

  it('a NEW ACTION is judged by its own steps (a composite action needing a tool)', async () => {
    push('web', [{ path: CI, text: workflow([['build', SEAM, ['uses: acme/release@v2']]]) }]);
    world.actions.set(
      'acme/release',
      'runs:\n  using: composite\n  steps:\n    - run: gh release create x\n      shell: bash',
    );
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage').params['jobs']).toEqual([
      expect.objectContaining({ repoRef: `${ORG}/web`, jobId: 'build', missing: ['gh'] }),
    ]);
  });

  it('a NEW EXECUTABLE in an existing job is unmet, and a runnable change stays met', async () => {
    push('api', [
      { path: CI, text: workflow([['build', SEAM, ['run: git status', 'run: terraform plan']]]) },
    ]);
    const gap = await fleetReadinessService.readinessFor(target());
    expect(cond(gap, 'image_coverage').params['jobs']).toEqual([
      expect.objectContaining({ jobId: 'build', missing: ['terraform'] }),
    ]);

    push(
      'api',
      [{ path: CI, text: workflow([['build', SEAM, ['run: curl -sf x | jq .']]]) }],
      'sha-3',
    );
    const fine = await fleetReadinessService.readinessFor(target());
    expect(fine.ready).toBe(true);
  });

  // AC4 — pinning a new image changes the comparison with no second list.
  it('pinning an image that holds the tool turns the same job runnable', async () => {
    push('api', [
      { path: CI, text: workflow([['deploy', SEAM, ['run: aws sts get-caller-identity']]]) },
    ]);
    expect(cond(await fleetReadinessService.readinessFor(target()), 'image_coverage').state).toBe(
      'unmet',
    );
    world.image = [...IMAGE_TOOLS, 'aws'];
    vi.stubEnv('MOTIR_RUNNER_IMAGE', `${REGISTRY}/motir-ci-runner@sha256:${'cd'.repeat(32)}`);
    expect((await fleetReadinessService.readinessFor(target())).ready).toBe(true);
  });

  // AC3 — anything that cannot be judged is never runnable.
  it.each([
    ['a computed command', ['run: $CLI deploy'], 'the computed command $CLI'],
    [
      'a computed action',
      ['uses: ${{ matrix.action }}'],
      'the computed action ${{ matrix.action }}',
    ],
    [
      'an action with no action.yml',
      ['uses: acme/gone@v1'],
      'acme/gone@v1, which has no action.yml',
    ],
  ])('%s is unverified, never runnable', async (_label, steps, reason) => {
    push('web', [{ path: CI, text: workflow([['build', SEAM, steps]]) }]);
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'image_coverage', 'unmet');
    expect(cond(result, 'image_coverage').params['jobs']).toEqual([
      expect.objectContaining({
        jobId: 'build',
        verdict: 'unverified',
        missing: ['unverified'],
        reason,
      }),
    ]);
    expect(cond(result, 'image_coverage').message).toContain(`can't be judged: ${reason}`);
  });

  it('a workflow file that is not YAML is unverified', async () => {
    push('web', [{ path: CI, text: 'jobs: [unclosed' }]);
    const result = await fleetReadinessService.readinessFor(target());
    expect(cond(result, 'image_coverage').params['jobs']).toEqual([
      expect.objectContaining({ workflow: CI, jobId: '*', verdict: 'unverified' }),
    ]);
  });

  it('a job asking for another OS is cannot-host, and a hosted job is listed apart', async () => {
    push('api', [
      {
        path: CI,
        text: workflow([
          ['mac', ['motir-runner', 'macos-14'], ['run: git status']],
          ['hosted', 'ubuntu-latest', ['run: gh pr list']],
        ]),
      },
    ]);
    const result = await fleetReadinessService.readinessFor(target());
    expect(cond(result, 'image_coverage')).toMatchObject({
      state: 'unmet',
      params: {
        jobs: [{ jobId: 'mac', verdict: 'cannot-host', reason: 'it asks for macos-14' }],
        githubHostedJobs: [{ repoRef: `${ORG}/api`, workflow: CI, jobId: 'hosted' }],
      },
    });
    expect(cond(result, 'image_coverage').message).toContain(
      "can't be hosted: it asks for macos-14",
    );
  });

  // AC3 — a GitHub-refused read makes the condition unknown.
  it.each([
    ['the newest-commit read', () => world.head.set('web', 'fail')],
    ['the workflow files read', () => world.files.delete('web')],
    [
      'a remote action read',
      () => {
        push('web', [{ path: CI, text: workflow([['build', SEAM, ['uses: acme/x@v1']]]) }]);
        world.actions.set('acme/x', 403);
      },
    ],
  ])('a refused %s ⇒ unknown, never met', async (_label, breakIt) => {
    breakIt();
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'image_coverage', 'unknown');
    expect(cond(result, 'image_coverage').reasonCode).toBe('read_failed');
  });

  it('a repository with no .github commit has no job to judge', async () => {
    world.head.delete('web');
    const result = await fleetReadinessService.readinessFor(target());
    expect(result.ready).toBe(true);
  });

  it('the image side: unset, no label, unreadable', async () => {
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(
      cond(await fleetReadinessService.readinessFor(target()), 'image_coverage'),
    ).toMatchObject({
      state: 'unmet',
      reasonCode: 'runner_image_unset',
      params: { variable: 'MOTIR_RUNNER_IMAGE' },
    });

    vi.stubEnv('MOTIR_RUNNER_IMAGE', RUNNER_IMAGE);
    world.image = 'unlabelled';
    expect(
      cond(await fleetReadinessService.readinessFor(target()), 'image_coverage'),
    ).toMatchObject({
      state: 'unmet',
      reasonCode: 'image_tools_unrecorded',
      params: { image: RUNNER_IMAGE, label: 'co.motir.ci-runner.tools' },
    });

    _resetRunnerImageToolsCache();
    world.image = 503;
    expect(
      cond(await fleetReadinessService.readinessFor(target()), 'image_coverage'),
    ).toMatchObject({
      state: 'unknown',
      reasonCode: 'image_unreadable',
      params: { image: RUNNER_IMAGE, reason: 'refused' },
    });
  });
});

describe('imageCoverageFor — condition 9 alone, for the daily probe (MOTIR-10290)', () => {
  it('answers what readinessFor answers for condition 9', async () => {
    push('api', [{ path: CI, text: workflow([['deploy', SEAM, ['run: aws s3 ls']]]) }]);
    const alone = await fleetReadinessService.imageCoverageFor(target());
    const full = cond(await fleetReadinessService.readinessFor(target()), 'image_coverage');
    expect(alone).toEqual(full);
  });

  it('reads the installation and the private set first', async () => {
    world.install = 404;
    expect(await fleetReadinessService.imageCoverageFor(target())).toMatchObject({
      state: 'unknown',
      reasonCode: 'app_not_readable',
    });
    world.install = 500;
    expect(await fleetReadinessService.imageCoverageFor(target())).toMatchObject({
      state: 'unknown',
      reasonCode: 'read_failed',
      params: { status: 500 },
    });
    world.install = 'ok';
    world.visibility.delete('web');
    expect(await fleetReadinessService.imageCoverageFor(target())).toMatchObject({
      state: 'unknown',
      reasonCode: 'read_failed',
    });
    world.visibility.set('web', false);
    world.visibility.set('api', false);
    expect(await fleetReadinessService.imageCoverageFor(target())).toMatchObject({
      state: 'unmet',
      reasonCode: 'no_private_repositories',
    });
  });

  it('throws FleetReadinessTargetNotFoundError for a project that does not exist', async () => {
    await expect(
      fleetReadinessService.imageCoverageFor({
        projectId: 'nope',
        workspaceId: fx.workspaceId,
        org: ORG,
      }),
    ).rejects.toBeInstanceOf(FleetReadinessTargetNotFoundError);
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
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
    expect(cond(result, 'app_repositories')).toMatchObject({
      state: 'unknown',
      params: { status: null },
    });
    expect(cond(result, 'app_repositories').message).toContain('GitHub could not be reached');
    expect(JSON.stringify(result)).not.toContain('the private detail');
  });

  it('a failed installation-repositories read ⇒ app_repositories unknown, the rest met', async () => {
    overrideFetch('/installation/repositories', () => json(502, { message: 'Bad Gateway' }));
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
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
    const result = await fleetReadinessService.readinessFor(target());
    expectOnly(result, 'delivery_attributable', 'unmet');
    expect(cond(result, 'delivery_attributable').params).toMatchObject({
      path: 'unmirrored',
      failures: [{ repository: `${ORG}/web`, reason: 'other_workspace' }],
    });
  });

  it('an attribution read that throws ⇒ delivery_attributable unknown, naming only the error class', async () => {
    const spy = vi.spyOn(githubRepoRepository, 'listByRepoId');
    spy.mockRejectedValueOnce(new RangeError('the private detail'));
    const first = await fleetReadinessService.readinessFor(target());
    expectOnly(first, 'delivery_attributable', 'unknown');
    expect(cond(first, 'delivery_attributable')).toMatchObject({ reasonCode: 'read_failed' });
    expect(cond(first, 'delivery_attributable').message).toContain(': RangeError.');
    expect(JSON.stringify(first)).not.toContain('the private detail');

    spy.mockRejectedValueOnce('not an error');
    const second = await fleetReadinessService.readinessFor(target());
    expect(cond(second, 'delivery_attributable').message).toContain(': read failed.');
  });

  it('a runner-group read that throws ⇒ runner_group unknown, naming only the error class', async () => {
    const spy = vi.spyOn(projectRunnerGroupService, 'readForOrg');
    spy.mockRejectedValueOnce(new SyntaxError('the private detail'));
    const first = await fleetReadinessService.readinessFor(target());
    expectOnly(first, 'runner_group', 'unknown');
    expect(cond(first, 'runner_group')).toMatchObject({ reasonCode: 'read_failed' });
    expect(cond(first, 'runner_group').message).toContain('(SyntaxError)');
    expect(JSON.stringify(first)).not.toContain('the private detail');

    spy.mockRejectedValueOnce(42);
    const second = await fleetReadinessService.readinessFor(target());
    expect(cond(second, 'runner_group').message).toContain('(read failed)');
  });

  it('one job not runnable is named in the singular', async () => {
    push('web', [{ path: CI, text: workflow([['lint', SEAM, ['run: shellcheck x.sh']]]) }]);
    const result = await fleetReadinessService.readinessFor(target());
    expect(cond(result, 'image_coverage').message).toMatch(/^1 job cannot run/);
    expect(cond(result, 'image_coverage').message).toContain(
      `${ORG}/web ci.yml lint (needs shellcheck, which the image lacks)`,
    );
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

describe('the boundary', () => {
  it('throws FleetReadinessTargetNotFoundError for a project that does not exist', async () => {
    await expect(
      fleetReadinessService.readinessFor({
        projectId: 'nope',
        workspaceId: fx.workspaceId,
        org: ORG,
      }),
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
