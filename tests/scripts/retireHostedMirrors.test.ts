import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { runDataScriptEntry } from '@/scripts/data-script-main';
import type { EntryStream } from '@/scripts/fleet/fleetAdminDatabaseUrl';
import { main, parseArgs, printReport, run } from '@/scripts/retire-hosted-mirrors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pnpm db:retire:hosted-mirrors` — the data migration of bug MOTIR-12192, over
// real Postgres: the hosted mirrors left behind before the removal retired them
// leave the connected set, a dry run writes nothing, and a re-run is a no-op.
// The service's selection rules have their own suite
// (`tests/projectRepos/hostedMirrorConnectedSet.test.ts`); this one pins the
// command line and what it prints.

const MOTIR_ORG = 'motir-projects';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The two mirrors production held on 2026-11-24, neither held by a project. */
async function leftBehind() {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: 'host-177182871',
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
  });
  for (const name of ['motir-envcheck-sandbox', 'motir']) {
    await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: `host-${name}`,
        owner: MOTIR_ORG,
        name,
        defaultBranch: 'main',
      },
    });
  }
}

function capture() {
  const lines: string[] = [];
  return { lines, out: { log: (line: string) => lines.push(line) } };
}

describe('the run', () => {
  it('a dry run lists both and writes nothing; the run retires both; a re-run retires none', async () => {
    await leftBehind();

    const dry = capture();
    expect(await run(['--dry-run'], { out: dry.out })).toBe(0);
    expect(dry.lines[0]).toBe(
      '[retire-hosted-mirrors] DRY RUN — listing only, nothing will be written.',
    );
    expect(dry.lines).toContain(
      '[retire-hosted-mirrors] scanned 2 connected repo(s) no project holds: would retire 2 Motir-hosted mirror(s).',
    );
    expect(dry.lines.join('\n')).toContain(`would retire ${MOTIR_ORG}/motir-envcheck-sandbox`);
    expect(dry.lines.at(-1)).toBe(
      '[retire-hosted-mirrors] done. Re-run without --dry-run to retire them.',
    );
    expect(await adminDb.githubRepo.count({ where: { retiredAt: { not: null } } })).toBe(0);

    const real = capture();
    expect(await run([], { out: real.out })).toBe(0);
    expect(real.lines.join('\n')).toContain(`retired ${MOTIR_ORG}/motir (github_repo `);
    expect(real.lines.at(-1)).toContain('done — 2 mirror(s) retired.');
    expect(await adminDb.githubRepo.count({ where: { retiredAt: { not: null } } })).toBe(2);

    const again = capture();
    await run([], { out: again.out });
    expect(again.lines).toContain(
      '[retire-hosted-mirrors] scanned 0 connected repo(s) no project holds: retired 0 Motir-hosted mirror(s).',
    );
  });
});

describe('the command line', () => {
  it.each([['--apply'], ['--workspace=ws_1']])('refuses %s', (flag) => {
    expect(() => parseArgs([flag])).toThrow(`[retire-hosted-mirrors] unknown argument: ${flag}`);
  });

  it('parses the dry-run flag', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(parseArgs([])).toEqual({ dryRun: false });
  });

  it('prints one line per mirror with its ids', () => {
    const { lines, out } = capture();
    printReport(
      {
        dryRun: false,
        scanned: 3,
        retired: [
          { id: 'gr_1', repoRef: 'motir-projects/motir', organizationId: 'o', workspaceId: 'w' },
        ],
      },
      out,
    );
    expect(lines).toEqual([
      '[retire-hosted-mirrors] scanned 3 connected repo(s) no project holds: retired 1 Motir-hosted mirror(s).',
      '[retire-hosted-mirrors]   retired motir-projects/motir (github_repo gr_1, organisation o, workspace w)',
    ]);
  });

  it('`main` prints on the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['--dry-run'])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      '[retire-hosted-mirrors] scanned 0 connected repo(s) no project holds: would retire 0 Motir-hosted mirror(s).',
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
    const code = await runDataScriptEntry(['retire-hosted-mirrors', '--apply'], process.env, {
      stdout: sink,
      stderr: sink,
    });
    expect(code).toBe(1);
    expect(written.join('')).toContain('unknown argument: --apply');
  });
});
