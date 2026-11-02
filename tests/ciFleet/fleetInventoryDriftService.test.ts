import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import checkedInInventory from '@/lib/ciFleet/fleetJobInventory.json';
import type { FleetInventoryRepo, FleetJobInventory } from '@/lib/ciFleet/fleetJobInventoryTypes';
import { workflowFingerprint } from '@/lib/ciFleet/workflowFingerprint';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { fleetInventoryDriftService, judgeDrift } from '@/lib/services/fleetInventoryDriftService';
import { FleetInventoryStaleError } from '@/lib/jobs/definitions/dailyHealthCheck';

// THE FLEET-INVENTORY DRIFT PROBE (MOTIR-10211): the daily health check's
// question, "has a private repository's workflows moved past its inventory
// entry?", asked by the readiness verdict's own rule. GitHub (`fetch`) is the
// only fake, as in `fleetReadinessService.test.ts`; the inventory is handed in.

const SEAM = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}";
const CI = '.github/workflows/ci.yml';
const MEASURED_AT = '2026-10-01T00:00:00Z';
const NEWER = '2026-10-12T00:00:00Z';
const NOW = new Date('2026-11-02T09:00:00Z');

const ci = (extraJobs = '', buildRunsOn = SEAM) =>
  `jobs:\n  build:\n    runs-on: ${buildRunsOn}\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm test\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n${extraJobs}`;

interface Org {
  install: 'ok' | 'suspended' | 404 | 'unreachable';
  head: Map<string, { sha: string; date: string } | 'fail'>;
  /** Files at the head; absent ⇒ the tree read is refused. */
  files: Map<string, string>;
}

let orgs: Map<string, Org>;
let installationReads: string[];

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
      const install = /^\/orgs\/([^/]+)\/installation$/.exec(u.pathname);
      if (install) {
        installationReads.push(install[1]!);
        const org = orgs.get(install[1]!);
        if (!org || org.install === 404) return json(404, { message: 'Not Found' });
        if (org.install === 'unreachable') throw new TypeError('fetch failed');
        return json(200, {
          id: 9000 + [...orgs.keys()].indexOf(install[1]!),
          permissions: {},
          events: [],
          repository_selection: 'selected',
          suspended_at: org.install === 'suspended' ? '2026-10-30T00:00:00Z' : null,
        });
      }
      if (/\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) {
        return json(200, {
          token: 'ghs_drift',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const commits = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(u.pathname);
      if (commits) {
        const head = orgs.get(commits[1]!)?.head.get(commits[2]!);
        if (head === 'fail') return json(502, { message: 'boom' });
        return json(
          200,
          head ? [{ sha: head.sha, commit: { committer: { date: head.date } } }] : [],
        );
      }
      const tree = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/[^/]+$/.exec(u.pathname);
      if (tree) {
        const text = orgs.get(tree[1]!)?.files.get(tree[2]!);
        if (text === undefined) return json(500, { message: 'boom' });
        return json(200, { truncated: false, tree: [{ type: 'blob', path: CI }] });
      }
      const contents = /^\/repos\/([^/]+)\/([^/]+)\/contents\/.+$/.exec(u.pathname);
      if (contents) {
        const text = orgs.get(contents[1]!)?.files.get(contents[2]!) ?? '';
        return json(200, { encoding: 'base64', content: Buffer.from(text).toString('base64') });
      }
      return json(500, { message: `unexpected fetch ${u.href}` });
    }),
  );
}

function entry(repoRef: string, visibility = 'private'): FleetInventoryRepo {
  return {
    repoRef,
    ref: 'main',
    sha: `sha-${repoRef}`,
    visibility,
    measuredAt: MEASURED_AT,
    imageDockerfileSha: 'df',
    structureFingerprint: workflowFingerprint([{ path: CI, text: ci() }]),
    jobCount: 2,
    workflows: [
      {
        path: CI,
        jobs: [
          {
            jobId: 'build',
            runsOn: SEAM,
            triggers: ['push'],
            verdict: 'runnable',
            missing: [],
            evidence: null,
          },
          {
            jobId: 'lint',
            runsOn: 'ubuntu-latest',
            triggers: ['push'],
            verdict: 'runnable',
            missing: [],
            evidence: null,
          },
        ],
      },
    ],
  };
}

function inventory(...entries: FleetInventoryRepo[]): FleetJobInventory {
  return { schemaVersion: 1, repos: Object.fromEntries(entries.map((e) => [e.repoRef, e])) };
}

/** Two private repositories in `acme`, one public: the all-current world. */
const world = () => inventory(entry('acme/api'), entry('acme/infra'), entry('acme/site', 'public'));

const check = (inv: FleetJobInventory = world()) =>
  fleetInventoryDriftService.check({ inventory: inv, now: NOW });

beforeEach(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  installationReads = [];
  orgs = new Map([
    [
      'acme',
      {
        install: 'ok',
        head: new Map([
          ['api', { sha: 'sha-acme/api', date: MEASURED_AT }],
          ['infra', { sha: 'sha-acme/infra', date: MEASURED_AT }],
        ]),
        files: new Map(),
      },
    ],
  ]);
  installGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const acme = () => orgs.get('acme')!;

describe('not_applicable', () => {
  it('with no provisioning App configured, and reads nothing', async () => {
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
    expect(await check()).toEqual({
      verdict: 'not_applicable',
      checkedAt: NOW.toISOString(),
      reason: 'app_not_configured',
    });
    expect(installationReads).toEqual([]);
  });

  it('with no private entry in the inventory', async () => {
    expect(await check(inventory(entry('acme/site', 'public')))).toMatchObject({
      verdict: 'not_applicable',
      reason: 'no_private_entries',
    });
  });
});

describe('current', () => {
  it('reads every private entry, once per org, and never a public one', async () => {
    expect(await check()).toEqual({
      verdict: 'current',
      checkedAt: NOW.toISOString(),
      checked: ['acme/api', 'acme/infra'],
    });
    expect(installationReads).toEqual(['acme']);
  });

  it('a head commit no newer than the measurement is current without reading a file', async () => {
    acme().head.set('api', { sha: 'other', date: MEASURED_AT });
    expect((await check()).verdict).toBe('current');
  });

  it('a repository with no workflow commit is current', async () => {
    acme().head.delete('api');
    expect((await check()).verdict).toBe('current');
  });

  // MOTIR-10211's own shape: motir-infra#7 added `verify` on the seam.
  it('a job added on a known runner with known tools is current', async () => {
    acme().head.set('infra', { sha: 'head-infra', date: NEWER });
    acme().files.set(
      'infra',
      ci(`  verify:\n    runs-on: ${SEAM}\n    steps:\n      - run: pnpm test\n`),
    );
    expect((await check()).verdict).toBe('current');
  });
});

describe('stale — the loud arm', () => {
  it('names the repository, both shas, the reason and the jobs a re-measure must add', async () => {
    acme().head.set('infra', { sha: 'head-infra', date: NEWER });
    acme().files.set(
      'infra',
      ci(`  image:\n    runs-on: ${SEAM}\n    steps:\n      - uses: docker/setup-qemu-action@v3\n`),
    );
    expect(await check()).toEqual({
      verdict: 'stale',
      checkedAt: NOW.toISOString(),
      checked: ['acme/api', 'acme/infra'],
      stale: [
        {
          repository: 'acme/infra',
          measuredSha: 'sha-acme/infra',
          headSha: 'head-infra',
          reason: 'digest_moved',
          movedJobs: [],
          addedJobs: [`${CI}#image`],
        },
      ],
      unreadable: [],
    });
  });

  it('a recorded job moving onto another known runner', async () => {
    acme().head.set('api', { sha: 'head-api', date: NEWER });
    acme().files.set(
      'api',
      ci(`  seam:\n    runs-on: ${SEAM}\n    steps:\n      - run: pnpm test\n`, 'ubuntu-latest'),
    );
    const verdict = await check();
    expect(verdict).toMatchObject({
      verdict: 'stale',
      stale: [{ repository: 'acme/api', reason: 'job_moved', movedJobs: [`${CI}#build`] }],
    });
  });

  it('an entry with no fingerprint, and invalid YAML, are stale', async () => {
    const bare = { ...entry('acme/api'), structureFingerprint: undefined };
    acme().head.set('api', { sha: 'head-api', date: NEWER });
    acme().head.set('infra', { sha: 'head-infra', date: NEWER });
    acme().files.set('api', ci());
    acme().files.set('infra', 'jobs: [unclosed');
    const verdict = await check(inventory(bare, entry('acme/infra')));
    expect(verdict).toMatchObject({
      verdict: 'stale',
      stale: [
        { repository: 'acme/api', reason: 'no_fingerprint' },
        { repository: 'acme/infra', reason: 'invalid_yaml' },
      ],
    });
  });

  it('still lists what it could not read beside what is stale', async () => {
    acme().head.set('api', 'fail');
    acme().head.set('infra', { sha: 'head-infra', date: NEWER });
    acme().files.set('infra', ci('', 'macos-latest'));
    expect(await check()).toMatchObject({
      verdict: 'stale',
      checked: ['acme/infra'],
      stale: [{ repository: 'acme/infra', reason: 'digest_moved' }],
      unreadable: [{ repository: 'acme/api', phase: 'head', status: 502 }],
    });
  });
});

describe('indeterminate — a read failed, which is never current and never loud', () => {
  it('the files at a newer head cannot be read', async () => {
    acme().head.set('api', { sha: 'head-api', date: NEWER });
    expect(await check()).toEqual({
      verdict: 'indeterminate',
      checkedAt: NOW.toISOString(),
      checked: ['acme/infra'],
      unreadable: [{ repository: 'acme/api', phase: 'files', status: 500 }],
    });
  });

  it.each([
    [404, 404],
    ['suspended', 403],
    ['unreachable', null],
  ] as const)(
    'the App on the org is %s ⇒ every repository there is unreadable',
    async (install, status) => {
      acme().install = install;
      expect(await check()).toMatchObject({
        verdict: 'indeterminate',
        checked: [],
        unreadable: [
          { repository: 'acme/api', phase: 'installation', status },
          { repository: 'acme/infra', phase: 'installation', status },
        ],
      });
      expect(installationReads).toEqual(['acme']);
    },
  );

  it('one org unreadable does not stop another org being read', async () => {
    orgs.set('other', {
      install: 404,
      head: new Map(),
      files: new Map(),
    });
    const verdict = await check(inventory(entry('acme/api'), entry('other/tools')));
    expect(verdict).toMatchObject({
      verdict: 'indeterminate',
      checked: ['acme/api'],
      unreadable: [{ repository: 'other/tools', phase: 'installation', status: 404 }],
    });
  });
});

describe('judgeDrift', () => {
  it('prefers stale over unreadable over current', () => {
    const stale = {
      repository: 'a/b',
      measuredSha: 'm',
      headSha: 'h',
      reason: 'digest_moved' as const,
      movedJobs: [],
      addedJobs: [],
    };
    const unreadable = { repository: 'a/c', phase: 'head' as const, status: null };
    expect(judgeDrift('t', [], [stale], [unreadable]).verdict).toBe('stale');
    expect(judgeDrift('t', [], [], [unreadable]).verdict).toBe('indeterminate');
    expect(judgeDrift('t', ['a/b'], [], [])).toEqual({
      verdict: 'current',
      checkedAt: 't',
      checked: ['a/b'],
    });
  });
});

describe('the checked-in manifest', () => {
  it('records a structure fingerprint on every private entry, so none is stale by default', () => {
    const missing = Object.values(checkedInInventory.repos)
      .filter((r) => r.visibility === 'private')
      .filter((r) => !('structureFingerprint' in r) || !r.structureFingerprint)
      .map((r) => r.repoRef);
    expect(missing).toEqual([]);
  });

  it('records motir-infra with its verify job, runnable (MOTIR-10211)', () => {
    const infra = (checkedInInventory as FleetJobInventory).repos['motir-co/motir-infra']!;
    const jobs = infra.workflows.flatMap((w) => w.jobs.map((j) => `${w.path}#${j.jobId}`));
    expect(jobs).toContain('.github/workflows/main.yml#verify');
    expect(infra.jobCount).toBe(jobs.length);
    const verify = infra.workflows
      .find((w) => w.path === '.github/workflows/main.yml')!
      .jobs.find((j) => j.jobId === 'verify')!;
    expect(verify).toMatchObject({ verdict: 'runnable', missing: [] });
  });
});

describe("the health check's FleetInventoryStaleError", () => {
  it('names every stale repository, its moved and unrecorded jobs, in the plural', () => {
    const error = new FleetInventoryStaleError({
      verdict: 'stale',
      checkedAt: NOW.toISOString(),
      checked: ['acme/api', 'acme/infra'],
      stale: [
        {
          repository: 'acme/api',
          measuredSha: 'aaaaaaaaaaaa',
          headSha: 'bbbbbbbbbbbb',
          reason: 'job_moved',
          movedJobs: [`${CI}#build`],
          addedJobs: [],
        },
        {
          repository: 'acme/infra',
          measuredSha: 'cccccccccccc',
          headSha: 'dddddddddddd',
          reason: 'no_fingerprint',
          movedJobs: [],
          addedJobs: [`${CI}#verify`],
        },
      ],
      unreadable: [],
    });
    expect(error.name).toBe('FleetInventoryStaleError');
    expect(error.message).toMatch(/^2 private repositories have workflows/);
    expect(error.message).toContain(
      `acme/api (measured aaaaaaaaa, head bbbbbbbbb: a recorded job changed its runner or the workflow it calls; moved: ${CI}#build)`,
    );
    expect(error.message).toContain(
      `acme/infra (measured ccccccccc, head ddddddddd: the entry records no structure fingerprint; not yet recorded: ${CI}#verify)`,
    );
  });
});
