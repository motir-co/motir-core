import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { DATABASE_PART_ENV, type DatabaseEnv } from '@/scripts/fleet/fleetAdminDatabaseUrl';
import type { EntryStream } from '@/scripts/fleet/fleetAdminDatabaseUrl';
import {
  DATA_SCRIPTS,
  dataScriptExitLine,
  dataScriptUsage,
  isDataScriptName,
  loadDataScript,
  runDataScriptEntry,
  type LoadDataScript,
} from '@/scripts/data-script-main';
import { main as backfillBoards } from '@/scripts/backfill-default-boards';
import { main as backfillCiState } from '@/scripts/backfill-work-item-ci-state';
import { main as backfillFixReason } from '@/scripts/backfill-fix-reason';
import { main as convergeUnlanded } from '@/scripts/converge-ejected-cards';
import { adminDb } from '../helpers/adminDb';

// MOTIR-10465 — the data scripts reach production after the AWS cutover by running
// INSIDE a core worker task over ECS Exec, from a bundle in the image. The task holds
// the database LOGIN PARTS, not `DATABASE_URL`, so the entry composes the URL before
// any script evaluates the database client, redacts the URL and the password from
// everything the process writes, and — because `aws ecs execute-command` drops the
// remote exit code — prints the code as its last line.
//
// This file drives the entry in-process (a recording loader, then the real one) and
// each script's `main` against the real database. The bundle itself, in a child
// process over TLS, is `dataScriptBundle.test.ts`.

const HOSTILE_PASSWORD = 'p@ss/w:rd%41%%x';

const PARTS: DatabaseEnv = {
  [DATABASE_PART_ENV.username]: 'data script',
  [DATABASE_PART_ENV.password]: HOSTILE_PASSWORD,
  [DATABASE_PART_ENV.host]: 'db.internal.example',
  [DATABASE_PART_ENV.port]: '5432',
  [DATABASE_PART_ENV.dbname]: 'motir core',
};

type Written = Array<{ stream: 'stdout' | 'stderr'; text: string }>;

function recordingStreams(): {
  streams: { stdout: EntryStream; stderr: EntryStream };
  written: Written;
} {
  const written: Written = [];
  const sink = (stream: 'stdout' | 'stderr'): EntryStream => ({
    write: (chunk) => {
      written.push({ stream, text: String(chunk) });
      return true;
    },
  });
  return { written, streams: { stdout: sink('stdout'), stderr: sink('stderr') } };
}

/** A script that writes `lines` and answers `code`, recording what it was given. */
function fakeScript(
  streams: { stdout: EntryStream; stderr: EntryStream },
  code: number,
  lines: () => string[] = () => ['[backfill-ci-state] done'],
) {
  const seen: { name?: string; argv?: readonly string[]; disconnected: number } = {
    disconnected: 0,
  };
  const load: LoadDataScript = async (name) => {
    seen.name = name;
    return {
      main: async (argv) => {
        seen.argv = argv;
        for (const line of lines()) streams.stdout.write(`${line}\n`);
        return code;
      },
      disconnect: async () => {
        seen.disconnected += 1;
      },
    };
  };
  return { seen, load };
}

describe('runDataScriptEntry', () => {
  it.each([0, 1])('on the parts path, answers %i and prints it as the last line', async (code) => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    const { seen, load } = fakeScript(streams, code);
    expect(await runDataScriptEntry(['backfill-ci-state', '--dry-run'], env, streams, load)).toBe(
      code,
    );
    expect(seen).toEqual({ name: 'backfill-ci-state', argv: ['--dry-run'], disconnected: 1 });
    expect(env['DATABASE_URL']).toMatch(/^postgresql:\/\/.*\?sslmode=verify-full$/);
    expect(env[DATABASE_PART_ENV.password]).toBeUndefined();
    expect(written).toEqual([
      { stream: 'stdout', text: '[backfill-ci-state] done\n' },
      { stream: 'stdout', text: `${dataScriptExitLine(code)}\n` },
    ]);
    expect(dataScriptExitLine(code)).toBe(`data-script exit ${code}`);
  });

  it.each<[string, DatabaseEnv]>([
    ['DATABASE_URL set (a checkout, a runner)', { DATABASE_URL: 'postgresql://a:b@h:1/d' }],
    ['neither the URL nor the parts', {}],
  ])('with %s, prints what the script printed and no exit line', async (_name, start) => {
    const env: DatabaseEnv = { ...start };
    const { streams, written } = recordingStreams();
    const { load } = fakeScript(streams, 1);
    expect(await runDataScriptEntry(['converge-unlanded-cards'], env, streams, load)).toBe(1);
    expect(written).toEqual([{ stream: 'stdout', text: '[backfill-ci-state] done\n' }]);
    expect(env['DATABASE_URL']).toBe(start['DATABASE_URL']);
  });

  it('redacts the composed URL and the password from every write, raw or encoded', async () => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    const { load } = fakeScript(streams, 0, () => [
      `connecting to ${env['DATABASE_URL'] ?? ''}`,
      `password ${HOSTILE_PASSWORD} / ${encodeURIComponent(HOSTILE_PASSWORD)}`,
    ]);
    expect(await runDataScriptEntry(['backfill-boards'], env, streams, load)).toBe(0);
    // An error a dependency writes straight to stderr, as bytes, is redacted too.
    streams.stderr.write(new TextEncoder().encode(`failed: ${HOSTILE_PASSWORD}\n`));
    const text = written.map((w) => w.text).join('');
    expect(text).not.toContain(HOSTILE_PASSWORD);
    expect(text).not.toContain(encodeURIComponent(HOSTILE_PASSWORD));
    expect(text).not.toContain('db.internal.example:5432');
    expect(text).toContain('connecting to [redacted]');
    expect(written.at(-1)).toEqual({ stream: 'stderr', text: 'failed: [redacted]\n' });
  });

  it('answers 1, with the exit line, when only some parts are set, and loads nothing', async () => {
    const env: DatabaseEnv = { ...PARTS, [DATABASE_PART_ENV.host]: '' };
    const { streams, written } = recordingStreams();
    const { seen, load } = fakeScript(streams, 0);
    expect(await runDataScriptEntry(['backfill-ci-state'], env, streams, load)).toBe(1);
    expect(seen.name).toBeUndefined();
    expect(written).toEqual([
      { stream: 'stderr', text: '[data-script] error: MOTIR_DB_HOST is not set\n' },
      { stream: 'stdout', text: 'data-script exit 1\n' },
    ]);
  });

  it.each<[string, string[], string]>([
    ['no script', [], '[data-script] no script named'],
    ['an unknown script', ['reseed'], '[data-script] unknown script "reseed"'],
    ['an inherited property name', ['toString'], '[data-script] unknown script "toString"'],
  ])('refuses %s with the usage, loading nothing', async (_name, argv, first) => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    const { seen, load } = fakeScript(streams, 0);
    expect(await runDataScriptEntry(argv, env, streams, load)).toBe(1);
    expect(seen.name).toBeUndefined();
    expect(written).toEqual([
      { stream: 'stderr', text: `${first}\n${dataScriptUsage()}\n` },
      { stream: 'stdout', text: 'data-script exit 1\n' },
    ]);
  });

  it('answers 1 on a script that throws, naming it, redacted, and still ends the pool', async () => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    let disconnected = 0;
    const load: LoadDataScript = async () => ({
      main: async () => {
        throw new Error(`cannot reach ${env['DATABASE_URL'] ?? ''}`);
      },
      disconnect: async () => {
        disconnected += 1;
        throw new Error('pool already closed');
      },
    });
    expect(await runDataScriptEntry(['backfill-fix-reason'], env, streams, load)).toBe(1);
    expect(disconnected).toBe(1);
    expect(written[0]?.stream).toBe('stderr');
    expect(written[0]?.text).toMatch(
      /^\[data-script\] backfill-fix-reason failed: Error: cannot reach \[redacted\]/,
    );
    expect(written.at(-1)).toEqual({ stream: 'stdout', text: 'data-script exit 1\n' });
  });

  it('answers 1 on a load that refuses, and on a throw that is not an Error', async () => {
    const { streams, written } = recordingStreams();
    const load: LoadDataScript = () => Promise.reject('not an error');
    expect(await runDataScriptEntry(['backfill-boards'], {}, streams, load)).toBe(1);
    expect(written).toEqual([
      { stream: 'stderr', text: '[data-script] backfill-boards failed: not an error\n' },
    ]);
  });
});

describe('the script registry', () => {
  it('names exactly the four production data scripts', () => {
    expect(Object.keys(DATA_SCRIPTS)).toEqual([
      'backfill-boards',
      'backfill-ci-state',
      'backfill-fix-reason',
      'converge-unlanded-cards',
    ]);
    expect(isDataScriptName('backfill-boards')).toBe(true);
    expect(isDataScriptName(undefined)).toBe(false);
    expect(isDataScriptName('hasOwnProperty')).toBe(false);
  });

  it('is what every pnpm data-script command runs, and the image builds and copies it', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const entry = 'tsx --tsconfig tsconfig.node.json scripts/data-script-main.ts';
    expect(pkg.scripts['db:backfill:boards']).toBe(`${entry} backfill-boards`);
    expect(pkg.scripts['db:backfill:ci-state']).toBe(`${entry} backfill-ci-state`);
    expect(pkg.scripts['db:backfill:fix-reason']).toBe(`${entry} backfill-fix-reason`);
    expect(pkg.scripts['db:converge:unlanded-cards']).toBe(`${entry} converge-unlanded-cards`);
    expect(pkg.scripts['db:converge:ejected-cards']).toBe(`${entry} converge-unlanded-cards`);
    expect(pkg.scripts['build:data-script']).toBe('node scripts/build-data-script.mjs');

    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('RUN pnpm build:data-script');
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=nextjs:nodejs /app/.data-script/data-script.mjs ./data/data-script.mjs',
    );
  });
});

// ── each script's `main`, through the real loader, on the real database ───────

describe('the data scripts, run through loadDataScript', () => {
  const logged: string[] = [];
  const capture = () => {
    logged.length = 0;
    const push = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    vi.spyOn(console, 'log').mockImplementation(push);
    vi.spyOn(console, 'error').mockImplementation(push);
    vi.spyOn(console, 'warn').mockImplementation(push);
  };
  afterEach(() => vi.restoreAllMocks());

  it('loads the real modules: each one is the main the registry names', async () => {
    expect((await DATA_SCRIPTS['backfill-boards']()).main).toBe(backfillBoards);
    expect((await DATA_SCRIPTS['backfill-ci-state']()).main).toBe(backfillCiState);
    expect((await DATA_SCRIPTS['backfill-fix-reason']()).main).toBe(backfillFixReason);
    expect((await DATA_SCRIPTS['converge-unlanded-cards']()).main).toBe(convergeUnlanded);
  });

  it.each([
    ['backfill-ci-state', '[backfill-ci-state] done — 0 of 0 card(s) with pull requests scanned'],
    ['backfill-fix-reason', '[backfill-fix-reason] done — 0 of 0 candidate card(s) scanned'],
    ['converge-unlanded-cards', '[converge-unlanded-cards] done — scanned 0'],
  ] as const)('%s --dry-run sweeps an empty database and answers 0', async (name, done) => {
    capture();
    const script = await loadDataScript(name);
    expect(await script.main(['--dry-run'])).toBe(0);
    expect(logged.some((line) => line.startsWith(done))).toBe(true);
    expect(logged.join('\n')).toContain('DRY RUN');
  });

  it.each(['backfill-ci-state', 'backfill-fix-reason', 'converge-unlanded-cards'] as const)(
    '%s refuses an unknown flag by throwing',
    async (name) => {
      const script = await loadDataScript(name);
      await expect(script.main(['--apply'])).rejects.toThrow('unknown argument: --apply');
    },
  );

  it('backfill-ci-state and backfill-fix-reason accept a workspace scope', async () => {
    capture();
    for (const name of ['backfill-ci-state', 'backfill-fix-reason'] as const) {
      const script = await loadDataScript(name);
      expect(await script.main(['--dry-run', '--workspace=ws-none'])).toBe(0);
    }
    expect(logged).toContain('[backfill-ci-state] scope: workspace ws-none.');
    expect(logged).toContain('[backfill-fix-reason] scope: workspace ws-none.');
  });

  it('backfill-boards seeds the board a project lost, and takes no flag', async () => {
    const user = await usersService.createUser({
      email: `data-script-boards-${process.pid}@example.com`,
      password: 'hunter2hunter2',
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Boards',
      ownerUserId: user.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Boards',
      identifier: 'DSB',
    });
    await adminDb.board.deleteMany({ where: { projectId: project.id } });

    capture();
    const script = await loadDataScript('backfill-boards');
    expect(await script.main([])).toBe(0);
    expect(logged).toContain(`[backfill-boards] seeded board for ${project.id} (Boards).`);
    expect(await adminDb.board.count({ where: { projectId: project.id } })).toBe(1);
    await expect(script.main(['--dry-run'])).rejects.toThrow(
      '[backfill-boards] unknown argument: --dry-run',
    );
    // The loader's disconnect ends the shared pool; the next query reconnects.
    await script.disconnect();
    expect(await db.project.count({ where: { id: project.id } })).toBeGreaterThanOrEqual(0);
  });
});
