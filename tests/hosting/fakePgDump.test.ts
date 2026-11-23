import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_DATABASE_STATE_PATH_ENV, createFakeDatabasePort } from '@motir/orchestrator';
import {
  armFakePgDumpFailure,
  fakeDatabaseExists,
  fakePgDumpSidecarPath,
} from '../e2e/_helpers/hosting-grace-fakes';

// THE ACCEPTANCE LANE'S `pg_dump` (Story MOTIR-9800 · MOTIR-12142), run as the
// export service runs it: a child process, the custom format, the database named
// by `--dbname`, and an environment holding only PATH (and the password). It
// reads the database fake's store, so a database another process created dumps
// and a deleted one fails as an unreachable server does.

const SCRIPT = resolve('tests/e2e/_fakes/bin/pg_dump');

let statePath: string;

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), 'fake-pg-dump-')), 'database.json');
  vi.stubEnv(FAKE_DATABASE_STATE_PATH_ENV, statePath);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function pgDump(args: string[], env: Record<string, string> = {}, script = SCRIPT) {
  const run = spawnSync(process.execPath, [script, ...args], {
    env: {
      PATH: process.env['PATH'] ?? '',
      PGPASSWORD: 'secret',
      ...env,
    } as unknown as NodeJS.ProcessEnv,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr.toString('utf8') };
}

/** The `--dbname` the export service passes: the direct URL, password removed. */
function dbnameOf(directUrl: string): string {
  const url = new URL(directUrl);
  url.password = '';
  return url.toString();
}

async function storedDatabase(applicationRef = 'app-1') {
  const port = createFakeDatabasePort();
  const { env } = await port.createDatabase({ applicationRef });
  const directUrl = env.find((pair) => pair.name === 'DIRECT_URL')!.value;
  return { port, dbname: dbnameOf(directUrl) };
}

describe('the fake pg_dump', () => {
  it('writes a custom-format archive of a stored database, different on each run', async () => {
    const { dbname } = await storedDatabase();
    const state = { MOTIR_FAKE_DATABASE_STATE_PATH: statePath };
    const first = pgDump(
      ['--format=custom', '--no-owner', '--no-acl', `--dbname=${dbname}`],
      state,
    );
    expect(first.status).toBe(0);
    expect(first.stdout.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    expect(first.stdout.toString('latin1')).toContain('-- database: app\n');
    expect(first.stdout.toString('latin1')).toContain('-- run: 1\n');
    const second = pgDump(['-Fc', '-d', dbname], state);
    expect(second.stdout.toString('latin1')).toContain('-- run: 2\n');
    const positional = pgDump(['-F', 'c', dbname], state);
    expect(positional.status).toBe(0);
    // The password never reaches the archive.
    expect(first.stdout.toString('latin1')).not.toContain('fake-password');
  });

  it('refuses any format but custom', async () => {
    const { dbname } = await storedDatabase();
    const plain = pgDump([`--dbname=${dbname}`], { MOTIR_FAKE_DATABASE_STATE_PATH: statePath });
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain('only the custom format, not "plain"');
    const dangling = pgDump(['--format'], { MOTIR_FAKE_DATABASE_STATE_PATH: statePath });
    expect(dangling.status).toBe(1);
  });

  it('fails as an unreachable server for a deleted, unknown or unparseable database', async () => {
    const { port, dbname } = await storedDatabase();
    const state = { MOTIR_FAKE_DATABASE_STATE_PATH: statePath };
    const [held] = await port.list();
    await port.deleteDatabase(held!.handle);
    const deleted = pgDump(['--format=custom', `--dbname=${dbname}`], state);
    expect(deleted.status).toBe(1);
    expect(deleted.stderr).toMatch(/could not connect to server/);
    expect(deleted.stderr).toContain(new URL(dbname).hostname);

    expect(pgDump(['--format=custom', '--dbname', 'not a url'], state).stderr).toContain(
      '"localhost"',
    );
    expect(pgDump(['--format=custom'], state).status).toBe(1);
  });

  it('fails the one run a spec armed, then dumps again', async () => {
    const { dbname } = await storedDatabase();
    const state = { MOTIR_FAKE_DATABASE_STATE_PATH: statePath };
    expect(pgDump(['-Fc', `--dbname=${dbname}`], state).status).toBe(0);
    armFakePgDumpFailure();
    expect(JSON.parse(readFileSync(fakePgDumpSidecarPath(), 'utf8'))).toEqual({
      runs: 1,
      armed: true,
    });
    const failed = pgDump(['-Fc', `--dbname=${dbname}`], state);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/could not connect/);
    const again = pgDump(['-Fc', `--dbname=${dbname}`], state);
    expect(again.status).toBe(0);
    expect(again.stdout.toString('latin1')).toContain('-- run: 2\n');
  });

  it('arms a failure before any run, with no sidecar yet', () => {
    armFakePgDumpFailure();
    expect(JSON.parse(readFileSync(fakePgDumpSidecarPath(), 'utf8'))).toEqual({
      runs: 0,
      armed: true,
    });
  });

  it('falls back to the lane’s default store when the variable does not reach it', async () => {
    // The export service hands its child only PATH, PGPASSWORD and
    // PGCONNECT_TIMEOUT, so the script finds the store under its own repository
    // root. A copy in a scratch tree stands in for the repository.
    const root = mkdtempSync(join(tmpdir(), 'fake-pg-dump-root-'));
    const script = join(root, 'tests', 'e2e', '_fakes', 'bin', 'pg_dump');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(SCRIPT, script);
    const lanePath = join(root, 'out', 'playwright-output-acceptance', '.fake-database.json');
    vi.stubEnv(FAKE_DATABASE_STATE_PATH_ENV, lanePath);
    const { dbname } = await storedDatabase();

    const run = pgDump(['--format=custom', `--dbname=${dbname}`], {}, script);
    expect(run.status).toBe(0);
    expect(existsSync(`${lanePath}.pg-dump.json`)).toBe(true);
  });
});

describe('the grace-window spec helpers', () => {
  it('report whether the fake still holds an application’s database', async () => {
    expect(fakeDatabaseExists('app-1')).toBe(false);
    const { port } = await storedDatabase('app-1');
    expect(fakeDatabaseExists('app-1')).toBe(true);
    expect(fakeDatabaseExists('app-2')).toBe(false);
    const [held] = await port.list();
    await port.deleteDatabase(held!.handle);
    expect(fakeDatabaseExists('app-1')).toBe(false);
  });

  it('refuse loudly outside a lane that sets the stores', () => {
    vi.stubEnv(FAKE_DATABASE_STATE_PATH_ENV, '');
    expect(() => fakeDatabaseExists('app-1')).toThrow(/run under the acceptance lane/);
    expect(() => armFakePgDumpFailure()).toThrow(/run under the acceptance lane/);
  });
});
