import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { makeCertificates, startTlsFront } from '../helpers/postgresTlsFront';
import { DATABASE_PART_ENV, type DatabaseEnv } from '@/scripts/fleet/fleetAdminDatabaseUrl';
import {
  deployCheckExitLine,
  loadDeployCheck,
  redactStream,
  runDeployCheckEntry,
  type EntryStream,
  type LoadDeployCheck,
} from '@/scripts/hosting-deploy-check-main';

// MOTIR-10301 — the operator deploy check in a Fargate task of the core image,
// over ECS Exec, with no management key. The task holds the database LOGIN PARTS,
// not `DATABASE_URL`, so the bundle's entry composes the URL (verify-full) before
// anything evaluates the database client, redacts the URL and the password from
// everything the process writes, and — because `aws ecs execute-command` drops
// the remote exit code — prints the code as its last line.
//
// The trap the card names is a bundle that does NOTHING and exits 0. So the last
// block runs the REAL esbuild bundle in a child process, against this worker's
// database, through a TLS front, as a role whose password holds `@`, `/`, `:`
// and `%`: `converge` must print the outcome it read from the database.

const HOSTILE_PASSWORD = 'p@ss/w:rd%41%%x';

const PARTS = {
  [DATABASE_PART_ENV.username]: 'deploy check',
  [DATABASE_PART_ENV.password]: HOSTILE_PASSWORD,
  [DATABASE_PART_ENV.host]: 'db.internal.example',
  [DATABASE_PART_ENV.port]: '5432',
  [DATABASE_PART_ENV.dbname]: 'motir core',
};

/** Two streams that record what was written, in order. */
function recordingStreams(): {
  streams: { stdout: EntryStream; stderr: EntryStream };
  written: Array<{ stream: 'stdout' | 'stderr'; text: string }>;
} {
  const written: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const sink = (stream: 'stdout' | 'stderr'): EntryStream => ({
    write: (chunk) => {
      written.push({ stream, text: String(chunk) });
      return true;
    },
  });
  return { written, streams: { stdout: sink('stdout'), stderr: sink('stderr') } };
}

/** A check that writes `lines` to the streams it is handed and answers `code`. */
function fakeCheck(
  streams: { stdout: EntryStream; stderr: EntryStream },
  code: number,
  lines: (env: DatabaseEnv) => string[] = () => ['[hosting-deploy-check] app'],
  env: DatabaseEnv = {},
) {
  const seen: { argv?: readonly string[] } = {};
  const load: LoadDeployCheck = async () => async (argv) => {
    seen.argv = argv;
    for (const line of lines(env)) streams.stdout.write(`${line}\n`);
    return code;
  };
  return { seen, load };
}

describe('runDeployCheckEntry', () => {
  it.each([0, 1])('on the parts path, answers %i and prints it as the last line', async (code) => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    const { seen, load } = fakeCheck(streams, code);
    const argv = ['app', '--target', 'aws', '--repository', 'r1'];
    expect(await runDeployCheckEntry(argv, env, streams, load)).toBe(code);
    expect(seen.argv).toEqual(argv);
    expect(env['DATABASE_URL']).toMatch(/^postgresql:\/\/.*\?sslmode=verify-full$/);
    expect(written).toEqual([
      { stream: 'stdout', text: '[hosting-deploy-check] app\n' },
      { stream: 'stdout', text: `${deployCheckExitLine(code)}\n` },
    ]);
    expect(deployCheckExitLine(code)).toBe(`deploy-check exit ${code}`);
  });

  it.each<[string, DatabaseEnv]>([
    ['DATABASE_URL set (a Fly machine)', { DATABASE_URL: 'postgresql://a:b@h:1/d' }],
    ['neither the URL nor the parts (a laptop, the fake)', {}],
  ])('with %s, prints what the check printed and no exit line', async (_name, start) => {
    const env: DatabaseEnv = { ...start };
    const { streams, written } = recordingStreams();
    const { load } = fakeCheck(streams, 1);
    expect(await runDeployCheckEntry(['status'], env, streams, load)).toBe(1);
    expect(written).toEqual([{ stream: 'stdout', text: '[hosting-deploy-check] app\n' }]);
    expect(env['DATABASE_URL']).toBe(start['DATABASE_URL']);
  });

  it('redacts the composed URL and the password from every write, raw or encoded', async () => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    const { load } = fakeCheck(
      streams,
      1,
      (e) => [
        `connecting to ${e['DATABASE_URL'] ?? ''}`,
        `password ${HOSTILE_PASSWORD} / ${encodeURIComponent(HOSTILE_PASSWORD)}`,
      ],
      env,
    );
    expect(await runDeployCheckEntry(['converge'], env, streams, load)).toBe(1);
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
    const { seen, load } = fakeCheck(streams, 0);
    expect(await runDeployCheckEntry(['converge'], env, streams, load)).toBe(1);
    expect(seen.argv).toBeUndefined();
    expect(written).toEqual([
      { stream: 'stderr', text: '[hosting-deploy-check] error: MOTIR_DB_HOST is not set\n' },
      { stream: 'stdout', text: 'deploy-check exit 1\n' },
    ]);
  });

  it('answers 1 on a load that refuses, redacted, still ending with the exit line', async () => {
    const env: DatabaseEnv = { ...PARTS };
    const { streams, written } = recordingStreams();
    const load: LoadDeployCheck = async () => {
      throw new Error(`cannot reach ${env['DATABASE_URL'] ?? ''}`);
    };
    expect(await runDeployCheckEntry(['converge'], env, streams, load)).toBe(1);
    expect(written).toEqual([
      { stream: 'stderr', text: '[hosting-deploy-check] error: cannot reach [redacted]\n' },
      { stream: 'stdout', text: 'deploy-check exit 1\n' },
    ]);
  });

  it('names an unknown throw without a message', async () => {
    const { streams, written } = recordingStreams();
    const load: LoadDeployCheck = () => Promise.reject('not an error');
    expect(await runDeployCheckEntry([], {}, streams, load)).toBe(1);
    expect(written).toEqual([
      { stream: 'stderr', text: '[hosting-deploy-check] error: unknown\n' },
    ]);
  });
});

describe('redactStream', () => {
  it('passes every write through the redactor, decoding bytes', () => {
    const { streams, written } = recordingStreams();
    redactStream(streams.stdout, (t) => t.replaceAll('secret', '[x]'));
    streams.stdout.write('a secret\n');
    streams.stdout.write(Buffer.from('b secret\n'));
    expect(written.map((w) => w.text)).toEqual(['a [x]\n', 'b [x]\n']);
  });
});

describe('loadDeployCheck', () => {
  it('loads the real check, which prints a refusal for an unknown step', async () => {
    const run = await loadDeployCheck();
    const lines: string[] = [];
    // The check's output surface is console.log; capture it for this one call.
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      expect(await run(['no-such-step'])).toBe(1);
    } finally {
      log.mockRestore();
    }
    expect(lines[0]).toBe('[hosting-deploy-check] refused');
    expect(lines.join('\n')).toContain('Unknown argument: no-such-step');
  });
});

// ── the real bundle, in a child process ─────────────────────────────────────

const ROOT = process.cwd();
const ROLE = `deploy_check_fargate_${process.pid}`;
/** An organisation with no tenant account: `converge` reads its row and answers
 *  `not_ready` — a database it could not reach answers `failed`. */
const ORG = 'org-deploy-check-fargate-none';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBundle(bundle: string, argv: string[], env: DatabaseEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...argv], {
      cwd: ROOT,
      env: env as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';
const AWS = ['--target', 'aws', '--repository', 'cmdeploycheckfargate'];

describe('the deploy-check bundle in a Fargate-shaped process', () => {
  let work = '';
  let bundle = '';
  let caPath = '';
  let front: Awaited<ReturnType<typeof startTlsFront>>;
  let database = '';
  let baseEnv: DatabaseEnv = {};

  beforeAll(async () => {
    // Built INSIDE the checkout, so the bundle's external `pg` resolves upward
    // into this repository's node_modules, as it resolves into /app's in the
    // image. `.deploy-check/` exists only after a `pnpm build:deploy-check`.
    mkdirSync(path.join(ROOT, '.deploy-check'), { recursive: true });
    work = mkdtempSync(path.join(ROOT, '.deploy-check', 'fargate-entry-'));
    bundle = path.join(work, 'deploy-check.mjs');
    execFileSync(process.execPath, ['scripts/build-deploy-check.mjs', '--outfile', bundle], {
      cwd: ROOT,
      stdio: 'pipe',
    });

    const testUrl = new URL(process.env['DATABASE_URL'] ?? '');
    database = decodeURIComponent(testUrl.pathname.slice(1));
    // The login gets exactly the privileges of the role the code under test
    // connects as, as a member of it; only its name and password are new.
    const runtimeRole = decodeURIComponent(testUrl.username);
    await adminDb.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
    const [create] = await adminDb.$queryRaw<Array<{ sql: string }>>`
      SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE %I',
        ${ROLE}::text, ${HOSTILE_PASSWORD}::text, ${runtimeRole}::text) AS sql`;
    await adminDb.$executeRawUnsafe(create?.sql ?? '');

    const certs = makeCertificates(mkdtempSync(path.join(tmpdir(), 'deploy-check-tls-')));
    caPath = certs.caPath;
    front = await startTlsFront(
      { host: testUrl.hostname, port: Number(testUrl.port || 5432) },
      certs,
    );

    // The child gets the test process's environment minus every database URL,
    // and the real orchestrator: the fake would never reach the database.
    baseEnv = { ...process.env };
    delete baseEnv['DATABASE_URL'];
    delete baseEnv['DATABASE_URL_UNPOOLED'];
    delete baseEnv['NODE_OPTIONS'];
    delete baseEnv['MOTIR_FLEET_ORCHESTRATOR'];
  }, 120_000);

  afterAll(async () => {
    await front?.close();
    await adminDb.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const fargateEnv = (extra: DatabaseEnv = {}): DatabaseEnv => ({
    ...baseEnv,
    [DATABASE_PART_ENV.username]: ROLE,
    [DATABASE_PART_ENV.password]: HOSTILE_PASSWORD,
    [DATABASE_PART_ENV.host]: 'localhost',
    [DATABASE_PART_ENV.port]: String(front.port),
    [DATABASE_PART_ENV.dbname]: database,
    NODE_EXTRA_CA_CERTS: caPath,
    ...extra,
  });

  const assertNoSecret = (run: Run) => {
    const all = run.stdout + run.stderr;
    expect(all).not.toContain(HOSTILE_PASSWORD);
    expect(all).not.toContain(encodeURIComponent(HOSTILE_PASSWORD));
    expect(all).not.toContain('postgresql://');
  };

  it('composes the URL from the parts, verifies the certificate and reads the database', async () => {
    const before = front.handshakes();
    const run = await runBundle(bundle, ['converge', ...AWS, '--organization', ORG], fargateEnv());
    // It DID something: the outcome came from a read of hosting_tenant_account
    // over TLS. `not_ready` is the answer for an organisation with no account;
    // an unreachable database would answer `failed`.
    expect(run.stdout).toContain('[hosting-deploy-check] converge');
    expect(run.stdout).toContain(`  organization: ${ORG}`);
    expect(run.stdout).toContain('  outcome: not_ready');
    expect(front.handshakes()).toBeGreaterThan(before);
    // not_ready is a refusal: 1, to the caller and on the last line.
    expect(run.code).toBe(1);
    expect(lastLine(run.stdout)).toBe('deploy-check exit 1');
    assertNoSecret(run);
  }, 60_000);

  it('is verify-full: without the CA the certificate is refused, and the read fails', async () => {
    const run = await runBundle(
      bundle,
      ['converge', ...AWS, '--organization', ORG],
      fargateEnv({ NODE_EXTRA_CA_CERTS: '' }),
    );
    expect(run.stdout).toContain('  outcome: failed');
    expect(run.stdout).not.toContain('not_ready');
    expect(run.code).toBe(1);
    expect(lastLine(run.stdout)).toBe('deploy-check exit 1');
    assertNoSecret(run);
  }, 60_000);

  it('answers a step that succeeds as 0, on the last line, from the AWS manifest it carries', async () => {
    // The fake orchestrator: `app` and `deploy` run against the fake port, so
    // the AWS manifest the image has no `tests/` for must come from the bundle.
    const env = fargateEnv({ MOTIR_FLEET_ORCHESTRATOR: 'fake' });
    const app = await runBundle(bundle, ['app', ...AWS], env);
    expect(app.stdout).toContain('[hosting-deploy-check] app');
    expect(app.stdout).toContain('  release1: mh/cmdeploycheckfargate/production:release-1');
    expect(app.code).toBe(0);
    expect(lastLine(app.stdout)).toBe('deploy-check exit 0');

    const cwd = mkdtempSync(path.join(tmpdir(), 'deploy-check-no-tests-'));
    const deploy = await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [bundle, 'deploy', ...AWS, '--shape', 'function'], {
        cwd,
        env: env as NodeJS.ProcessEnv,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    rmSync(cwd, { recursive: true, force: true });
    expect(deploy.stdout).toContain('[hosting-deploy-check] deploy');
    expect(deploy.stdout).not.toContain('HOSTING_MANIFEST_MISSING');
    expect(deploy.code).toBe(0);
    expect(lastLine(deploy.stdout)).toBe('deploy-check exit 0');
    assertNoSecret(app);
    assertNoSecret(deploy);
  }, 60_000);

  it('with DATABASE_URL already set, behaves as on Fly: real exit code, no exit line', async () => {
    const run = await runBundle(bundle, ['no-such-step'], {
      ...baseEnv,
      DATABASE_URL: process.env['DATABASE_URL'],
    });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('[hosting-deploy-check] refused');
    expect(run.stdout).not.toContain('deploy-check exit');
  }, 60_000);
});
