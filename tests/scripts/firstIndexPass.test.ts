import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runDataScriptEntry } from '@/scripts/data-script-main';
import type { EntryStream } from '@/scripts/fleet/fleetAdminDatabaseUrl';
import { main, parseArgs, run } from '@/scripts/first-index-pass';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../helpers/jobs';

// THE FIRST-INDEX PASS (MOTIR-11885 · story MOTIR-11022), against real Postgres.
//
// `pnpm db:first-index-pass` enqueues `system.code-graph-index` for every connected
// repository that is not archived, reading NO ledger, so a repository the old fleet
// indexed reaches motir-codegraph too. Afterwards the first-index gate counts only
// the repositories a handoff row covers. The only double is the enqueue transport.

let sendSpy: ReturnType<typeof spyOnJobDispatch>;

async function makeWorkspace(slug: string): Promise<string> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

async function connect(
  workspaceId: string,
  installationId: string,
  repos: { id: string; name: string; archived?: boolean }[],
): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: repos.map((r) => ({
      providerRepoId: r.id,
      owner: 'moooon',
      name: r.name,
      defaultBranch: 'main',
      archived: r.archived ?? false,
    })),
  });
}

async function seedIndexRow(workspaceId: string, repoRef: string, handoff: boolean) {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${handoff ? 'new' : 'old'}-${workspaceId}-${repoRef}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      output: {
        indexed: true,
        repoRef,
        projectsIndexed: 1,
        ...(handoff ? { indexedBy: 'motir-codegraph' } : {}),
      },
    },
  });
}

const enqueued = () =>
  dispatchedEvents(sendSpy)
    .filter((e) => e.name === 'system.code-graph-index')
    .map((e) => e.data as { workspaceId: string; repoOwner: string; repoName: string })
    .map((d) => `${d.repoOwner}/${d.repoName}`);

/** Two workspaces: old-fleet, handoff, never-indexed and archived repositories. */
async function seedWorld() {
  const a = await makeWorkspace('pass-a');
  const b = await makeWorkspace('pass-b');
  await connect(a, 'inst-a', [
    { id: '1', name: 'old-fleet' },
    { id: '2', name: 'handed-off' },
    { id: '3', name: 'never' },
    { id: '4', name: 'shelved', archived: true },
  ]);
  await connect(b, 'inst-b', [{ id: '5', name: 'other' }]);
  await seedIndexRow(a, 'moooon/old-fleet', false);
  await seedIndexRow(a, 'moooon/handed-off', true);
  await seedIndexRow(b, 'moooon/other', false);
  return { a, b };
}

const lines: string[] = [];
const out = { log: (line: string) => void lines.push(line) };

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  sendSpy = spyOnJobDispatch();
  sendSpy.mockClear();
  lines.length = 0;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the pass enqueues every non-archived connected repository, whatever the ledger says', () => {
  it('then the gate treats only the handoff-indexed repositories as indexed', async () => {
    const { a, b } = await seedWorld();

    expect(await run([], { out })).toBe(0);

    // Ordered by workspace, then repository — the read's order.
    const inA = ['moooon/handed-off', 'moooon/never', 'moooon/old-fleet'];
    expect(enqueued()).toEqual(a < b ? [...inA, 'moooon/other'] : ['moooon/other', ...inA]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '[first-index-pass] scope: every workspace with connected repos.',
        '[first-index-pass] scanned 5 connected repo(s): enqueued 4, skipped 1.',
        `[first-index-pass]   skipped moooon/shelved (workspace ${a}): archived`,
        expect.stringMatching(/^\[first-index-pass\] done — 4 index job\(s\) enqueued/),
      ]),
    );
    expect(lines.join('\n')).not.toContain('DRY RUN');

    // The gate, after the pass: only the handoff row counts.
    const sweep = await codeGraphIndexService.sweepReposMissingFirstIndex({ dryRun: true });
    expect(sweep.missing.map((r) => r.repoRef).sort()).toEqual([
      'moooon/never',
      'moooon/old-fleet',
      'moooon/other',
      'moooon/shelved',
    ]);
    expect(sweep.alreadyIndexed).toBe(1);
  });

  it('a dry run enqueues nothing and reports what it would enqueue', async () => {
    const { a } = await seedWorld();

    const report = await codeGraphIndexService.enqueueFirstIndexPass({ dryRun: true });
    expect(report).toMatchObject({ dryRun: true, scanned: 5, enqueued: 0 });
    expect(report.repos).toHaveLength(4);
    expect(report.skipped).toEqual([
      { workspaceId: a, repoRef: 'moooon/shelved', reason: 'archived' },
    ]);
    expect(enqueued()).toEqual([]);

    expect(await run(['--dry-run'], { out })).toBe(0);
    expect(enqueued()).toEqual([]);
    expect(lines).toEqual(
      expect.arrayContaining([
        '[first-index-pass] DRY RUN — listing only, nothing will be enqueued.',
        '[first-index-pass] scanned 5 connected repo(s): would enqueue 4, skipped 1.',
        `[first-index-pass]   would enqueue moooon/old-fleet (@main, workspace ${a})`,
        '[first-index-pass] done. Re-run without --dry-run to enqueue them.',
      ]),
    );
  });

  it('`--workspace` touches only that workspace’s repositories', async () => {
    const { b } = await seedWorld();

    expect(await run([`--workspace=${b}`], { out })).toBe(0);

    expect(enqueued()).toEqual(['moooon/other']);
    expect(lines).toContain(`[first-index-pass] scope: workspace ${b}.`);
    const data = dispatchedEvents(sendSpy)[0]!.data;
    expect(data).toEqual({
      installationId: 'inst-b',
      workspaceId: b,
      repoOwner: 'moooon',
      repoName: 'other',
      defaultBranch: 'main',
    });
  });

  it('reads under system context: the application role sees every workspace with none bound', async () => {
    await seedWorld();
    const report = await codeGraphIndexService.enqueueFirstIndexPass({ dryRun: true });
    expect(new Set(report.repos.map((r) => r.workspaceId)).size).toBe(2);
  });

  it('an empty database is an empty pass', async () => {
    const report = await codeGraphIndexService.enqueueFirstIndexPass();
    expect(report).toEqual({ dryRun: false, scanned: 0, repos: [], skipped: [], enqueued: 0 });
  });
});

describe('the command line', () => {
  it.each([['--apply'], ['--workspace='], ['--workspace']])('refuses %s', (flag) => {
    expect(() => parseArgs([flag])).toThrow(`[first-index-pass] unknown argument: ${flag}`);
  });

  it('parses both flags', () => {
    expect(parseArgs(['--dry-run', '--workspace=ws_1'])).toEqual({
      dryRun: true,
      workspaceId: 'ws_1',
    });
    expect(parseArgs([])).toEqual({ dryRun: false, workspaceId: undefined });
  });

  it('`main` prints on the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['--dry-run'])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      '[first-index-pass] scanned 0 connected repo(s): would enqueue 0, skipped 0.',
    );
  });

  it('through the data-script entry, an unknown flag answers exit code 1', async () => {
    const written: string[] = [];
    const sink: EntryStream = {
      write: (chunk) => {
        written.push(String(chunk));
        return true;
      },
    };
    const code = await runDataScriptEntry(['first-index-pass', '--apply'], process.env, {
      stdout: sink,
      stderr: sink,
    });
    expect(code).toBe(1);
    expect(written.join('')).toContain('unknown argument: --apply');
  });
});
