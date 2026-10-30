import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { E2E_REFUSED_HOSTS, installSharedMockAgent } from '@/lib/test-mock-agent';
import { githubMergeSeamEnv, productionReleaseSeamEnv } from './e2e/_helpers/job-worker-process';

// Guard for Bug MOTIR-5837: EVERY process in the E2E lane fakes the GitHub
// boundary, and none of them can reach the real api.github.com.
//
// The E2E lane runs three processes — the Playwright runner, the Next server and
// the Postgres job engine's WORKER. The seams were installed by
// `instrumentation.ts`, a Next.js hook the worker never runs, so a job handler
// that merged, read or posted to GitHub got no intercept at all:
// `pull-request/auto-merge.requested` dead-lettered on
// `GITHUB_APP_NOT_CONFIGURED`, and with the App env mirrored it minted a token
// against the real host and died on a 401. The whole approve-before-green →
// merges-by-itself path was unreachable from any spec.
//
// Three properties, one per half of the fix, so the NEXT process added cannot
// re-open the hole without a red test:
//
//   1. Every process entry point installs from the ONE seam table and never
//      assembles its own (a hand-built install is how the worker ended up with
//      one seam of fourteen).
//   2. The shared agent REFUSES an api.github.com call no seam answers — with
//      the method and path named — instead of passing it through.
//   3. The worker's merge seam and the App credentials it needs travel
//      TOGETHER, and the process-local repos seam is never mirrored.

const ROOT = process.cwd();

/** Source with comments stripped — every assertion below is about CODE, and these
 *  files discuss exactly the calls they no longer make. Whole-line `//` comments go
 *  FIRST: one of them reads `/v1/stripe/*`, which would otherwise open a block. */
const codeOf = (rel: string): string =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

/** The processes that install E2E seams. A new one belongs in this list. */
const ENTRY_POINTS = ['instrumentation.ts', 'scripts/worker.ts'] as const;

describe('every E2E process installs from the one seam table (MOTIR-5837)', () => {
  it.each(ENTRY_POINTS)('%s installs through installE2EMockSeams', (file) => {
    const code = codeOf(file);
    expect(code).toMatch(/import\('@\/lib\/test-mock-seams'\)/);
    expect(code).toMatch(/\binstallE2EMockSeams\(/);
  });

  it.each(ENTRY_POINTS)('%s assembles no seam of its own', (file) => {
    const code = codeOf(file);
    // The agent is the table's to install — a second one would disconnect the
    // first one's intercepts — and so is every boundary mock.
    expect(code).not.toMatch(/\binstallSharedMockAgent\(/);
    expect(code).not.toMatch(/import\('@\/lib\/test-[\w-]+-mock'\)/);
  });
});

describe('the shared agent refuses the real GitHub API (MOTIR-5837)', () => {
  const ORIGINAL: Dispatcher = getGlobalDispatcher();

  afterEach(() => {
    // `setGlobalDispatcher` is process-wide and a vitest worker runs many files.
    setGlobalDispatcher(ORIGINAL);
  });
  afterAll(() => setGlobalDispatcher(ORIGINAL));

  it('names api.github.com', () => {
    expect(E2E_REFUSED_HOSTS).toContain('api.github.com');
  });

  it('fails an UNINTERCEPTED api.github.com call by name, and never sends it', async () => {
    installSharedMockAgent();

    // Node's own `fetch`: the one every provider in lib/ calls.
    const failure = await fetch('https://api.github.com/repos/acme/web/pulls/7/merge', {
      method: 'PUT',
    }).then(
      () => null,
      (err: unknown) => err as Error & { cause?: Error },
    );

    expect(failure, 'the call must not succeed or reach the network').not.toBeNull();
    const reason = failure!.cause ?? failure!;
    expect(reason.name).toBe('MockNotMatchedError');
    // The line a reader gets in the job's failure: which call, to which host.
    expect(reason.message).toContain('/repos/acme/web/pulls/7/merge');
    expect(reason.message).toContain('https://api.github.com');
  });

  it('still answers what a seam DOES intercept on that host', async () => {
    const agent = installSharedMockAgent();
    agent
      .get('https://api.github.com')
      .intercept({ path: '/repos/acme/web', method: 'GET' })
      .reply(200, { allow_squash_merge: true });

    const res = await fetch('https://api.github.com/repos/acme/web');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allow_squash_merge: true });
  });
});

describe("the worker's merge seam travels WITH its credentials (MOTIR-5837)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it('mirrors nothing unless the lane opts in', () => {
    vi.stubEnv('E2E_JOB_WORKER_GITHUB_MERGE_SEAM', '');
    expect(githubMergeSeamEnv()).toEqual({});
  });

  it('mirrors the seam flag, its files and the App it merges as — together', () => {
    vi.stubEnv('E2E_JOB_WORKER_GITHUB_MERGE_SEAM', '1');
    vi.stubEnv('MOTIR_GITHUB_MERGE_CONTROL_PATH', '/tmp/merge-control.json');
    vi.stubEnv('MOTIR_GITHUB_MERGE_JOURNAL_PATH', '/tmp/merge-journal.jsonl');

    const env = githubMergeSeamEnv();

    // Credentials without the seam is the half that sent real traffic — so the
    // flag is the first thing this map must carry.
    expect(env['E2E_TEST_GITHUB_MERGE']).toBe('1');
    expect(env['GITHUB_STUDIO_APP_ID']).toBeTruthy();
    expect(env['GITHUB_STUDIO_APP_PRIVATE_KEY']).toContain('BEGIN PRIVATE KEY');
    expect(env['GITHUB_FALLBACK_ORG']).toBeTruthy();
    // ONE control file and ONE journal for both processes, so a spec steers and
    // reads them through the files it already writes.
    expect(env['MOTIR_GITHUB_MERGE_CONTROL_PATH']).toBe('/tmp/merge-control.json');
    expect(env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']).toBe('/tmp/merge-journal.jsonl');
  });

  it('never mirrors the repos seam, whose fake keeps its state in the process', () => {
    vi.stubEnv('E2E_JOB_WORKER_GITHUB_MERGE_SEAM', '1');
    expect(githubMergeSeamEnv()).not.toHaveProperty('E2E_TEST_GITHUB_REPOS');
  });

  it('is switched on by the acceptance lane — the lane whose server merges', () => {
    const config = codeOf('playwright.acceptance.config.ts');
    expect(config).toMatch(/process\.env\['E2E_JOB_WORKER_GITHUB_MERGE_SEAM'\] \?\?= '1'/);
    expect(config).toMatch(/E2E_TEST_GITHUB_MERGE: '1'/);
  });
});

describe("the worker's production-release seam travels with its store and key (MOTIR-10040)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it('mirrors nothing unless the lane opts in', () => {
    vi.stubEnv('E2E_JOB_WORKER_PRODUCTION_RELEASE_SEAM', '');
    expect(productionReleaseSeamEnv()).toEqual({});
  });

  it('mirrors the seam flag, the shared hosting store, its files, the fake and the sealing key', () => {
    vi.stubEnv('E2E_JOB_WORKER_PRODUCTION_RELEASE_SEAM', '1');
    vi.stubEnv('MOTIR_FAKE_HOSTING_STATE_PATH', '/tmp/hosting.json');
    vi.stubEnv('MOTIR_PRODUCTION_RELEASE_CONTROL_PATH', '/tmp/release-control.json');
    vi.stubEnv('MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH', '');

    const env = productionReleaseSeamEnv();

    expect(env['E2E_TEST_PRODUCTION_RELEASE']).toBe('1');
    expect(env['MOTIR_FLEET_ORCHESTRATOR']).toBe('fake');
    // The webServer rolls back what this process deploys: ONE store for both.
    expect(env['MOTIR_FAKE_HOSTING_STATE_PATH']).toBe('/tmp/hosting.json');
    expect(env['MOTIR_PRODUCTION_RELEASE_CONTROL_PATH']).toBe('/tmp/release-control.json');
    expect(env).not.toHaveProperty('MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH');
    expect(env['ENVIRONMENT_CONFIG_ENCRYPTION_KEY']).toMatch(/^[0-9a-f]{64}$/);
    expect(env['GITHUB_FALLBACK_ORG']).toBeTruthy();
    expect(env['GITHUB_STUDIO_APP_PRIVATE_KEY']).toContain('BEGIN PRIVATE KEY');
  });

  it('is switched on by the acceptance lane, whose webServer shares the store', () => {
    const config = codeOf('playwright.acceptance.config.ts');
    expect(config).toMatch(/process\.env\['E2E_JOB_WORKER_PRODUCTION_RELEASE_SEAM'\] \?\?= '1'/);
    expect(config).toMatch(
      /MOTIR_FAKE_HOSTING_STATE_PATH: process\.env\['MOTIR_FAKE_HOSTING_STATE_PATH'\]!/,
    );
  });
});
