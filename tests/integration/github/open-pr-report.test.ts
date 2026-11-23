import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { db } from '@/lib/db';
import * as forwardModule from '@/lib/jobs/codeGraphForward';
import type { CodeGraphForwardData } from '@/lib/jobs/types';
import { openPullRequestReportService } from '@/lib/services/openPullRequestReportService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { main, parseArgs, run } from '@/scripts/report-open-pull-requests';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { organizationIdOf } from '../../helpers/organizationOf';

// THE ONE-TIME OPEN-PULL-REQUEST REPORT (MOTIR-12057 · story MOTIR-11870) on real
// Postgres. Two things are stubbed, both above the code under test, as the
// historical backfill suite stubs them: `fetch` (GitHub's listing) and the App's
// token mint. `enqueueCodeGraphForward` is observed, so the exact events are read
// and nothing is sent.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const UPDATED = '2026-11-20T09:00:00Z';

let fetchMock: ReturnType<typeof vi.fn>;
let enqueue: MockInstance<typeof forwardModule.enqueueCodeGraphForward>;

/** What GitHub lists, by `owner/name`; a repository not here answers 404. */
let listings: Record<string, unknown[]>;

let seq = 0;

async function workspace(): Promise<{ workspaceId: string; organizationId: string }> {
  seq += 1;
  const user = await usersService.createUser({
    email: `opr-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace: ws } = await workspacesService.createWorkspace({
    name: `WS ${seq}`,
    ownerUserId: user.id,
  });
  return { workspaceId: ws.id, organizationId: await organizationIdOf(ws.id) };
}

/** One installation and its repository rows, mirrored as the install path writes them. */
async function connect(
  workspaceId: string,
  installationId: string,
  repos: { repoId: string; owner: string; name: string; archived?: boolean; provider?: string }[],
): Promise<void> {
  const inst = await adminDb.githubInstallation.create({
    data: {
      installationId,
      workspaceId,
      accountLogin: repos[0]!.owner,
      accountType: 'Organization',
      provider: repos[0]!.provider ?? 'github',
    },
  });
  for (const r of repos) {
    await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId,
        organizationId: await organizationIdOf(workspaceId),
        repoId: r.repoId,
        owner: r.owner,
        name: r.name,
        defaultBranch: 'main',
        archived: r.archived ?? false,
        provider: r.provider ?? 'github',
      },
    });
  }
}

function pull(number: number, headRepoId: number | null, headRef = `feature-${number}`) {
  return {
    number,
    state: 'open',
    updated_at: UPDATED,
    head: { ref: headRef, repo: headRepoId === null ? null : { id: headRepoId } },
    base: { ref: 'main' },
  };
}

/** Every public table's row count, to show the report writes nothing of its own. */
async function rowCounts(): Promise<Record<string, number>> {
  const rows = await adminDb.$queryRawUnsafe<{ t: string; n: number }[]>(`
    SELECT table_name AS t,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text::int AS n
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

const forwards = () => enqueue.mock.calls.map((c) => c[0] as CodeGraphForwardData);

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "github_repo", "github_installation" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  listings = {};
  fetchMock = vi.fn(async (url: string) => {
    const match = /\/repos\/([^/]+)\/([^/]+)\/pulls\?.*&page=(\d+)$/.exec(url);
    const rows = match ? listings[`${match[1]}/${match[2]}`] : undefined;
    if (!rows) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(match![3] === '1' ? rows : []), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  enqueue = vi.spyOn(forwardModule, 'enqueueCodeGraphForward').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Two organisations, each with one GitHub repository and a mix of heads. */
async function twoOrganisations() {
  const a = await workspace();
  const b = await workspace();
  await connect(a.workspaceId, 'inst-a', [{ repoId: '101', owner: 'acme', name: 'web' }]);
  await connect(b.workspaceId, 'inst-b', [{ repoId: '202', owner: 'beta', name: 'api' }]);
  listings['acme/web'] = [pull(1, 101), pull(2, 999), pull(3, null), pull(4, 101, 'main')];
  listings['beta/api'] = [pull(7, 202, 'fix/login'), { number: 8, head: { repo: { id: 202 } } }];
  return { a, b };
}

describe('reportOpenPullRequests', () => {
  it('enqueues exactly one open report per same-repository head, in two organisations', async () => {
    const { a, b } = await twoOrganisations();
    const report = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });

    const open = (o: string, repoRef: string, ref: string, n: number) => ({
      kind: 'pull_request_state',
      coreOrganizationId: o,
      repoRef,
      ref,
      pullRequestNumber: n,
      state: 'open',
      reportedAt: UPDATED,
    });
    expect(forwards()).toHaveLength(3);
    expect(forwards()).toEqual(
      expect.arrayContaining([
        open(a.organizationId, 'acme/web', 'feature-1', 1),
        // The default branch is the service's call, not this report's.
        open(a.organizationId, 'acme/web', 'main', 4),
        open(b.organizationId, 'beta/api', 'fix/login', 7),
      ]),
    );
    for (const f of forwards()) expect(f).not.toHaveProperty('mergedAt');

    const byRef = Object.fromEntries(report.repos.map((r) => [r.repoRef, r]));
    expect(byRef['acme/web']).toEqual({
      repoRef: 'acme/web',
      organizationId: a.organizationId,
      pages: 1,
      truncated: false,
      scanned: 4,
      forwarded: 2,
      skippedForks: 2,
      skippedMalformed: 0,
    });
    expect(byRef['beta/api']).toMatchObject({ forwarded: 1, skippedMalformed: 1, scanned: 2 });
    expect(report.totals).toEqual({
      repos: 2,
      failed: 0,
      truncated: 0,
      scanned: 6,
      forwarded: 3,
      skippedForks: 2,
      skippedMalformed: 1,
    });
  });

  it('skips an archived row and a non-GitHub row, and lists both', async () => {
    const a = await workspace();
    await connect(a.workspaceId, 'inst-a', [
      { repoId: '101', owner: 'acme', name: 'web' },
      { repoId: '102', owner: 'acme', name: 'shelved', archived: true },
    ]);
    await connect(a.workspaceId, 'gl-1', [
      { repoId: '303', owner: 'acme', name: 'gitlab-proj', provider: 'gitlab' },
    ]);
    listings['acme/web'] = [pull(1, 101)];
    listings['acme/shelved'] = [pull(2, 102)];

    const report = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    expect(report.repos.map((r) => r.repoRef)).toEqual(['acme/web']);
    expect(report.skippedArchived).toEqual(['acme/shelved']);
    expect(report.skippedNonGithub).toEqual(['acme/gitlab-proj']);
    expect(forwards().map((f) => f.repoRef)).toEqual(['acme/web']);
  });

  it('a token that cannot be minted, and a listing that fails, are reported on their repository; the next is still forwarded', async () => {
    const a = await workspace();
    await connect(a.workspaceId, 'inst-revoked', [
      { repoId: '101', owner: 'acme', name: 'a-revoked' },
    ]);
    await connect(a.workspaceId, 'inst-ok', [
      { repoId: '102', owner: 'acme', name: 'b-gone' },
      { repoId: '103', owner: 'acme', name: 'c-fine' },
    ]);
    listings['acme/c-fine'] = [pull(5, 103)];
    const { mintInstallationToken } = await import('@/lib/github/appAuth');
    vi.mocked(mintInstallationToken).mockImplementation(async (installationId: string) => {
      if (installationId === 'inst-revoked') throw new Error('installation suspended');
      return { token: 'ghs_test', expiresAt: new Date(Date.now() + 3_600_000) };
    });

    const report = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    const byRef = Object.fromEntries(report.repos.map((r) => [r.repoRef, r]));
    expect(byRef['acme/a-revoked']!.error).toBe(
      'could not mint an installation token: installation suspended',
    );
    expect(byRef['acme/b-gone']!.error).toBe(
      'Could not read acme/b-gone open pull requests (404): not retryable',
    );
    expect(byRef['acme/c-fine']).toMatchObject({ forwarded: 1 });
    expect(byRef['acme/c-fine']!.error).toBeUndefined();
    expect(report.totals.failed).toBe(2);
    expect(forwards().map((f) => f.repoRef)).toEqual(['acme/c-fine']);
  });

  it('a second run enqueues the identical events and writes no row; a dry run enqueues nothing with the same counts', async () => {
    await twoOrganisations();
    const before = await rowCounts();
    const first = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    const firstEvents = forwards();
    enqueue.mockClear();
    const second = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    expect(forwards()).toEqual(firstEvents);
    expect(second).toEqual(first);
    expect(await rowCounts()).toEqual(before);

    enqueue.mockClear();
    const dry = await openPullRequestReportService.reportOpenPullRequests({ dryRun: true });
    expect(enqueue).not.toHaveBeenCalled();
    expect(dry).toEqual({ ...first, dryRun: true });
  });

  it('narrows to one workspace, and to one repository case-insensitively', async () => {
    const { a } = await twoOrganisations();
    const inWs = await openPullRequestReportService.reportOpenPullRequests({
      dryRun: true,
      workspaceId: a.workspaceId,
    });
    expect(inWs.repos.map((r) => r.repoRef)).toEqual(['acme/web']);
    const one = await openPullRequestReportService.reportOpenPullRequests({
      dryRun: true,
      repoRef: 'BETA/API',
    });
    expect(one.repos.map((r) => r.repoRef)).toEqual(['beta/api']);
  });

  it('a non-Error thrown by the mint is reported as unknown error', async () => {
    const a = await workspace();
    await connect(a.workspaceId, 'inst-a', [{ repoId: '101', owner: 'acme', name: 'web' }]);
    const { mintInstallationToken } = await import('@/lib/github/appAuth');
    vi.mocked(mintInstallationToken).mockRejectedValueOnce('nope');
    const report = await openPullRequestReportService.reportOpenPullRequests({ dryRun: false });
    expect(report.repos[0]!.error).toBe('could not mint an installation token: unknown error');
  });
});

describe('pnpm codegraph:report-open-pull-requests', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: { log: (line: string) => lines.push(line) } };
  };

  it('prints each repository, the skips and the totals, and exits 0 when a repository failed', async () => {
    await twoOrganisations();
    const a = await workspace();
    await connect(a.workspaceId, 'inst-c', [
      { repoId: '301', owner: 'gamma', name: 'old', archived: true },
      { repoId: '302', owner: 'gamma', name: 'missing' },
    ]);
    await connect(a.workspaceId, 'gl-c', [
      { repoId: '303', owner: 'gamma', name: 'lab', provider: 'gitlab' },
    ]);
    const { lines, out } = capture();
    expect(await run([], { out })).toBe(0);
    expect(lines[0]).toBe('[report-open-pull-requests] scope: every connected repository.');
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\[report-open-pull-requests\] {3}acme\/web \(organization \S+\): pages=1 truncated=false scanned=4 forwarded=2 skippedForks=2 skippedMalformed=0 error=none$/,
        ),
        expect.stringMatching(
          /gamma\/missing .*forwarded=0 .*error=Could not read gamma\/missing open pull requests \(404\)/,
        ),
        '[report-open-pull-requests]   skipped gamma/old: archived',
        '[report-open-pull-requests]   skipped gamma/lab: not GitHub',
        '[report-open-pull-requests] totals: repos=3 failed=1 truncated=0 scanned=6 forwarded=3 skippedForks=2 skippedMalformed=1 skippedArchived=1 skippedNonGithub=1',
      ]),
    );
  });

  it('--dry-run, --workspace and --repo reach the service, and a dry run says would forward', async () => {
    const { a } = await twoOrganisations();
    const { lines, out } = capture();
    await run(['--dry-run', `--workspace=${a.workspaceId}`, '--repo=acme/web'], { out });
    expect(enqueue).not.toHaveBeenCalled();
    expect(lines).toEqual([
      '[report-open-pull-requests] DRY RUN — deciding only, nothing will be enqueued.',
      `[report-open-pull-requests] scope: acme/web in workspace ${a.workspaceId}.`,
      expect.stringMatching(/acme\/web .* would forward=2 /),
      '[report-open-pull-requests] totals: repos=1 failed=0 truncated=0 scanned=4 would forward=2 skippedForks=2 skippedMalformed=0 skippedArchived=0 skippedNonGithub=0',
    ]);
  });

  it('says so when nothing is in scope', async () => {
    const { lines, out } = capture();
    await run(['--repo=nobody/here'], { out });
    expect(lines).toContain('[report-open-pull-requests] no GitHub-connected repository in scope.');
  });

  it('main runs the same CLI on the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--dry-run'])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      '[report-open-pull-requests] DRY RUN — deciding only, nothing will be enqueued.',
    );
  });

  it.each(['--apply', '--workspace=', '--repo=', '--repo=just-a-name', '--repo=a/b/c'])(
    'a usage error (%s) throws, so the entry exits non-zero',
    (flag) => {
      expect(() => parseArgs([flag])).toThrow(
        `[report-open-pull-requests] unknown argument: ${flag}`,
      );
    },
  );
});
