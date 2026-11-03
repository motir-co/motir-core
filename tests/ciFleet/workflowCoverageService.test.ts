import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatRunnerImageTools,
  parseRunnerImageTools,
  RUNNER_IMAGE_TOOLS_LABEL,
} from '@/lib/ciFleet/runnerImageTools';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  latestWorkflowCommit,
  OrgInstallationReadError,
  readActionMetadata,
  readWorkflowSources,
} from '@/lib/github/orgInstallation';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { configuredFleetRunnerImage, fleetRunnerImage } from '@/lib/orchestrator';
import {
  _resetRunnerImageToolsCache,
  runnerImageToolsService,
} from '@/lib/services/runnerImageToolsService';
import {
  _resetWorkflowCoverageCache,
  workflowCoverageService,
} from '@/lib/services/workflowCoverageService';

// MOTIR-10290: the reads behind image coverage — a repository's jobs judged at
// its newest `.github` commit, and the pinned image's own tool list. `fetch` is
// the only fake; the judge itself is pinned in `jobCoverage.test.ts`.

const ORG = 'acme-cov';
const TARGET: GithubOrgTarget = { org: ORG, installationId: '7001', role: 'provisioning' };
const SEAM = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}";
const TOOLS = new Set(['bash', 'git', 'docker']);
const REGISTRY = 'registry.coverage.test';
const IMAGE = `${REGISTRY}/runner@sha256:${'0f'.repeat(32)}`;

const b64 = (text: string) => Buffer.from(text).toString('base64');

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Fake {
  head: { sha: string } | null | number;
  files: Array<{ path: string; text: string }> | number;
  /** `owner/repo/path/file` → text or status. */
  actions: Map<string, string | number>;
  calls: string[];
}

let fake: Fake;

function install(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string): Promise<Response> => {
      const u = new URL(String(raw));
      fake.calls.push(`${u.host}${u.pathname}`);
      if (/\/access_tokens$/.test(u.pathname)) {
        return json(200, {
          token: 'ghs_cov',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (u.pathname === `/repos/${ORG}/api/commits`) {
        expect(u.searchParams.get('path')).toBe('.github');
        if (typeof fake.head === 'number') return json(fake.head, {});
        return json(
          200,
          fake.head ? [{ sha: fake.head.sha, commit: { committer: { date: '2026-11-01' } } }] : [],
        );
      }
      if (u.pathname.startsWith(`/repos/${ORG}/api/git/trees/`)) {
        if (typeof fake.files === 'number') return json(fake.files, {});
        return json(200, {
          truncated: false,
          tree: fake.files.map((f) => ({ type: 'blob', path: f.path })),
        });
      }
      const local = new RegExp(`^/repos/${ORG}/api/contents/(.+)$`).exec(u.pathname);
      if (local && typeof fake.files !== 'number') {
        const found = fake.files.find((f) => f.path === decodeURI(local[1]!));
        return found ? json(200, { encoding: 'base64', content: b64(found.text) }) : json(404, {});
      }
      const remote = /^\/repos\/(.+)\/contents\/(.+)$/.exec(u.pathname);
      if (remote) {
        const found = fake.actions.get(`${remote[1]}/${decodeURI(remote[2]!)}`);
        if (found === undefined) return json(404, {});
        if (typeof found === 'number') return json(found, {});
        return json(200, { encoding: 'base64', content: b64(found) });
      }
      return json(599, { message: `unexpected ${u.href}` });
    }),
  );
}

const ci = (steps: string[]) =>
  ['jobs:', '  build:', `    runs-on: "${SEAM}"`, '    steps:', ...steps.map((s) => `      - ${s}`)]
    .join('\n')
    .concat('\n');

beforeEach(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetWorkflowCoverageCache();
  _resetRunnerImageToolsCache();
  fake = {
    head: { sha: 'h1' },
    files: [{ path: '.github/workflows/ci.yml', text: ci(['run: git status']) }],
    actions: new Map(),
    calls: [],
  };
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const coverage = (now?: () => number) =>
  workflowCoverageService.repositoryCoverage(TARGET, ORG, 'api', TOOLS, now);

describe('workflowCoverageService.repositoryCoverage', () => {
  it('judges every job at the newest .github commit', async () => {
    expect(await coverage()).toMatchObject({
      state: 'judged',
      headSha: 'h1',
      jobs: [{ jobId: 'build', verdict: 'runnable' }],
    });
  });

  it('a repository with no .github commit has nothing to judge', async () => {
    fake.head = null;
    expect(await coverage()).toEqual({ state: 'judged', headSha: null, jobs: [] });
  });

  it('answers unreadable with the phase that failed', async () => {
    fake.head = 502;
    expect(await coverage()).toMatchObject({ state: 'unreadable', phase: 'head', headSha: null });
    fake.head = { sha: 'h2' };
    fake.files = 403;
    expect(await coverage()).toMatchObject({ state: 'unreadable', phase: 'files', headSha: 'h2' });
    fake.files = [{ path: '.github/workflows/ci.yml', text: ci(['uses: acme/act@v1']) }];
    fake.actions.set('acme/act/action.yml', 500);
    const failed = await coverage();
    expect(failed).toMatchObject({ state: 'unreadable', phase: 'actions', headSha: 'h2' });
    expect((failed as { error: unknown }).error).toBeInstanceOf(OrgInstallationReadError);
  });

  it('follows composite actions round by round, and reads each action once', async () => {
    fake.files = [{ path: '.github/workflows/ci.yml', text: ci(['uses: acme/outer@v1']) }];
    fake.actions.set(
      'acme/outer/action.yml',
      'runs:\n  using: composite\n  steps:\n    - uses: acme/inner/sub@v2',
    );
    fake.actions.set('acme/inner/sub/action.yaml', 'runs:\n  using: docker\n  image: x');
    expect(await coverage()).toMatchObject({
      state: 'judged',
      jobs: [{ verdict: 'runnable', missing: [] }],
    });
    const reads = fake.calls.filter((c) => c.includes('/contents/') && !c.includes(`${ORG}/api`));
    expect(reads).toEqual([
      'api.github.com/repos/acme/outer/contents/action.yml',
      'api.github.com/repos/acme/inner/contents/sub/action.yml',
      'api.github.com/repos/acme/inner/contents/sub/action.yaml',
    ]);
  });

  it('an action with no action.yml, or one that is not YAML, is never runnable', async () => {
    fake.files = [
      { path: '.github/workflows/ci.yml', text: ci(['uses: acme/gone@v1', 'uses: acme/bad@v1']) },
    ];
    fake.actions.set('acme/bad/action.yml', 'runs: [unclosed');
    expect(await coverage()).toMatchObject({
      jobs: [
        {
          verdict: 'unverified',
          unjudged: [
            'acme/bad@v1, whose action kind is not known',
            'acme/gone@v1, which has no action.yml',
          ],
        },
      ],
    });
  });

  it('caches files by commit and actions for a while, then reads again', async () => {
    fake.files = [{ path: '.github/workflows/ci.yml', text: ci(['uses: acme/act@v1']) }];
    fake.actions.set('acme/act/action.yml', "runs:\n  using: 'node20'");
    let now = 1_000;
    await coverage(() => now);
    await coverage(() => now);
    const count = (part: string) => fake.calls.filter((c) => c.includes(part)).length;
    expect(count('/git/trees/')).toBe(1);
    expect(count('acme/act/contents')).toBe(1);
    now += 31 * 60_000;
    await coverage(() => now);
    expect(count('/git/trees/')).toBe(1);
    expect(count('acme/act/contents')).toBe(2);
    fake.head = { sha: 'h9' };
    await coverage(() => now);
    expect(count('/git/trees/')).toBe(2);
  });
});

describe('the .github reads refuse what they cannot read', () => {
  function answer(body: (path: string) => Response) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string) => {
        const u = new URL(String(raw));
        return /access_tokens/.test(u.pathname)
          ? json(200, { token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
          : body(u.pathname);
      }),
    );
  }

  it('latestWorkflowCommit: a non-list, or a commit with no sha or date', async () => {
    answer(() => json(200, { not: 'a list' }));
    await expect(latestWorkflowCommit(TARGET, ORG, 'api')).rejects.toBeInstanceOf(
      OrgInstallationReadError,
    );
    answer(() => json(200, [{ commit: {} }]));
    await expect(latestWorkflowCommit(TARGET, ORG, 'api')).rejects.toBeInstanceOf(
      OrgInstallationReadError,
    );
  });

  it('readWorkflowSources: a truncated tree, too many files, a file that is not text', async () => {
    answer(() => json(200, { truncated: true, tree: [] }));
    await expect(readWorkflowSources(TARGET, ORG, 'api', 'h')).rejects.toThrow('truncated');

    const many = Array.from({ length: 121 }, (_, i) => ({
      type: 'blob',
      path: `.github/workflows/w${i}.yml`,
    }));
    answer(() => json(200, { truncated: false, tree: many }));
    await expect(readWorkflowSources(TARGET, ORG, 'api', 'h')).rejects.toThrow('too many');

    answer((path) =>
      path.includes('/git/trees/')
        ? json(200, {
            truncated: false,
            tree: [
              { type: 'blob', path: '.github/workflows/ci.yml' },
              { type: 'tree', path: '.github/workflows' },
              { type: 'blob', path: 'README.md' },
            ],
          })
        : json(200, { type: 'dir' }),
    );
    await expect(readWorkflowSources(TARGET, ORG, 'api', 'h')).rejects.toThrow('not base64');

    answer((path) =>
      path.includes('/git/trees/')
        ? json(200, { truncated: false, tree: [{ type: 'blob', path: '.github/workflows/a.yml' }] })
        : json(403, { message: 'nope' }),
    );
    await expect(readWorkflowSources(TARGET, ORG, 'api', 'h')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('readActionMetadata', () => {
  it('throws when the answer is not base64 text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (raw: string) =>
        /access_tokens/.test(String(raw))
          ? json(200, { token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
          : json(200, { type: 'dir' }),
      ),
    );
    await expect(readActionMetadata(TARGET, 'acme', 'act', '', 'v1')).rejects.toBeInstanceOf(
      OrgInstallationReadError,
    );
  });
});

describe('runner image tools', () => {
  it('parses and formats the label', () => {
    expect(parseRunnerImageTools({})).toBeNull();
    expect(parseRunnerImageTools({ [RUNNER_IMAGE_TOOLS_LABEL]: ' , ' })).toBeNull();
    expect([...parseRunnerImageTools({ [RUNNER_IMAGE_TOOLS_LABEL]: 'git, bash,,jq' })!]).toEqual([
      'git',
      'bash',
      'jq',
    ]);
    expect(formatRunnerImageTools(['jq', 'bash', 'jq'])).toBe('bash,jq');
  });

  it('reads the pinned image once per reference, and never keeps a failed read', async () => {
    let status = 200;
    let labels: Record<string, string> = { [RUNNER_IMAGE_TOOLS_LABEL]: 'bash,git' };
    const registry = vi.fn(async (raw: string) => {
      const u = new URL(String(raw));
      if (status !== 200) return json(status, {});
      if (u.pathname.includes('/manifests/')) {
        return json(
          200,
          { config: { digest: 'sha256:c' } },
          { 'docker-content-digest': 'sha256:m' },
        );
      }
      return json(200, { config: { Labels: labels } });
    });
    vi.stubGlobal('fetch', registry);

    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    expect(configuredFleetRunnerImage()).toBeNull();
    expect(fleetRunnerImage()).toBe('motir/ci-runner@sha256:unset');
    expect(await runnerImageToolsService.read()).toEqual({ state: 'unset' });

    vi.stubEnv('MOTIR_RUNNER_IMAGE', ` ${IMAGE} `);
    expect(fleetRunnerImage()).toBe(IMAGE);
    status = 503;
    expect(await runnerImageToolsService.read()).toMatchObject({
      state: 'unreadable',
      image: IMAGE,
      reason: 'refused',
    });
    status = 200;
    const read = await runnerImageToolsService.read();
    expect(read).toMatchObject({ state: 'read', image: IMAGE, digest: 'sha256:m' });
    if (read.state !== 'read') throw new Error(`expected a read, got ${read.state}`);
    expect([...read.tools]).toEqual(['bash', 'git']);
    const calls = registry.mock.calls.length;
    await runnerImageToolsService.read();
    expect(registry.mock.calls.length).toBe(calls);

    labels = {};
    vi.stubEnv('MOTIR_RUNNER_IMAGE', `${REGISTRY}/runner@sha256:${'1e'.repeat(32)}`);
    expect(await runnerImageToolsService.read()).toMatchObject({ state: 'unrecorded' });
  });
});
