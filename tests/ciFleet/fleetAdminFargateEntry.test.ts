import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { makeCertificates, startTlsFront } from '../helpers/postgresTlsFront';
import {
  composeDatabaseUrl,
  DATABASE_PART_ENV,
  DatabasePartsIncompleteError,
  type DatabaseEnv,
} from '@/scripts/fleet/fleetAdminDatabaseUrl';
import {
  exitLine,
  loadFleetAdmin,
  redactor,
  runFleetAdminEntry,
  type FleetAdminCommands,
} from '@/scripts/fleet/fleetAdminMain';

// MOTIR-10264 — `fleet-admin` in a Fargate task of the core image. The task holds
// the database LOGIN PARTS, not `DATABASE_URL` (motir-infra composes the URL
// inside each service's own process), so the bundle's entry composes it, with
// `sslmode=verify-full`, before anything evaluates the database client — and,
// because `aws ecs execute-command` drops the remote exit code, prints the code
// as its last line.
//
// The trap the card names is a command that does NOTHING and exits 0, which reads
// as success. So the last block here runs the REAL esbuild bundle in a child
// process, against this worker's database, through a TLS front that speaks
// Postgres's SSLRequest, as a role whose password holds `@`, `/`, `:` and `%`.

/** A password that breaks an unencoded URL in every way the card names. */
const HOSTILE_PASSWORD = 'p@ss/w:rd%41%%x';

const PARTS = {
  [DATABASE_PART_ENV.username]: 'fleet admin',
  [DATABASE_PART_ENV.password]: HOSTILE_PASSWORD,
  [DATABASE_PART_ENV.host]: 'db.internal.example',
  [DATABASE_PART_ENV.port]: '5432',
  [DATABASE_PART_ENV.dbname]: 'motir core',
};

describe('composeDatabaseUrl', () => {
  it('leaves a set DATABASE_URL alone (a Fly machine, a shell)', () => {
    const env: DatabaseEnv = { DATABASE_URL: 'postgresql://a:b@h:1/d', ...PARTS };
    expect(composeDatabaseUrl(env)).toEqual({ source: 'environment' });
    expect(env['DATABASE_URL']).toBe('postgresql://a:b@h:1/d');
    // The parts are not touched either: nothing was composed from them.
    expect(env[DATABASE_PART_ENV.password]).toBe(HOSTILE_PASSWORD);
  });

  it('answers none when neither the URL nor any part is set', () => {
    const env: DatabaseEnv = {};
    expect(composeDatabaseUrl(env)).toEqual({ source: 'none' });
    expect(env['DATABASE_URL']).toBeUndefined();
  });

  it('composes a verify-full URL that pg reads back to the exact parts, and drops the parts', () => {
    const env: DatabaseEnv = { ...PARTS };
    const result = composeDatabaseUrl(env);
    const url = env['DATABASE_URL'] ?? '';
    expect(result).toEqual({
      source: 'parts',
      secrets: [url, HOSTILE_PASSWORD, encodeURIComponent(HOSTILE_PASSWORD)],
    });
    expect(url).toBe(
      'postgresql://fleet%20admin:p%40ss%2Fw%3Ard%2541%25%25x@db.internal.example:5432/' +
        'motir%20core?sslmode=verify-full',
    );
    // What node-postgres itself makes of it — the client the services use.
    // (A client is only constructed, never connected.)
    const read = new pg.Client({ connectionString: url });
    expect(read.user).toBe('fleet admin');
    expect(read.password).toBe(HOSTILE_PASSWORD);
    expect(read.host).toBe('db.internal.example');
    expect(read.port).toBe(5432);
    expect(read.database).toBe('motir core');
    // verify-full: TLS on, and the certificate checked (pg's default for an object).
    expect(read.ssl).toEqual({});
    for (const name of Object.values(DATABASE_PART_ENV)) expect(env[name]).toBeUndefined();
  });

  it('refuses a partial set of parts, naming the missing variables and no value', () => {
    const env: DatabaseEnv = { ...PARTS };
    delete env[DATABASE_PART_ENV.host];
    delete env[DATABASE_PART_ENV.dbname];
    let thrown: unknown;
    try {
      composeDatabaseUrl(env);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DatabasePartsIncompleteError);
    expect((thrown as Error).message).toBe('MOTIR_DB_HOST, MOTIR_DB_NAME are not set');
    expect((thrown as Error).message).not.toContain(HOSTILE_PASSWORD);
    expect(env['DATABASE_URL']).toBeUndefined();

    const one: DatabaseEnv = { ...PARTS, [DATABASE_PART_ENV.port]: '' };
    expect(() => composeDatabaseUrl(one)).toThrow('MOTIR_DB_PORT is not set');
  });
});

describe('redactor', () => {
  it('removes each secret, longest first, then every credential shape', () => {
    const redact = redactor(['p@ss', 'postgresql://u:p@ss@h/d', '', 'p@ss']);
    expect(redact('url postgresql://u:p@ss@h/d and p@ss')).toBe('url [redacted] and [redacted]');
    expect(redact('key AKIAABCDEFGHIJKLMNOP')).toBe('key [redacted]');
    expect(redactor([])('plain line')).toBe('plain line');
  });
});

/** An io that records every line, in order, with its stream. */
function recordingIo(): {
  io: { out(line: string): void; err(line: string): void };
  lines: Array<{ stream: 'out' | 'err'; line: string }>;
} {
  const lines: Array<{ stream: 'out' | 'err'; line: string }> = [];
  return {
    lines,
    io: {
      out: (line) => lines.push({ stream: 'out', line }),
      err: (line) => lines.push({ stream: 'err', line }),
    },
  };
}

/** Commands that print `printed` and answer `code`, recording the environment they saw. */
function fakeCommands(code: number, printed: string[] = ['did the thing']) {
  const seen: { argv?: string[]; url?: string; disconnected: boolean } = { disconnected: false };
  const load = async (): Promise<FleetAdminCommands> => ({
    runFleetAdmin: async (argv, io) => {
      seen.argv = argv;
      for (const line of printed) io.out(line);
      return code;
    },
    disconnect: async () => {
      seen.disconnected = true;
    },
  });
  return { seen, load };
}

describe('runFleetAdminEntry', () => {
  it.each([0, 1, 2])(
    'on the parts path, answers %i and prints it as the last line',
    async (code) => {
      const env: DatabaseEnv = { ...PARTS };
      const { io, lines } = recordingIo();
      const { seen, load } = fakeCommands(code);
      expect(await runFleetAdminEntry(['pool-status', '--kind', 'ci_runner'], env, io, load)).toBe(
        code,
      );
      expect(seen.argv).toEqual(['pool-status', '--kind', 'ci_runner']);
      expect(seen.disconnected).toBe(true);
      expect(lines).toEqual([
        { stream: 'out', line: 'did the thing' },
        { stream: 'out', line: exitLine(code) },
      ]);
      expect(exitLine(code)).toBe(`fleet-admin exit ${code}`);
    },
  );

  it('with DATABASE_URL set, prints what the command printed and no exit line', async () => {
    const env: DatabaseEnv = { DATABASE_URL: 'postgresql://a:b@h:1/d' };
    const { io, lines } = recordingIo();
    const { load } = fakeCommands(2);
    expect(await runFleetAdminEntry(['add-spare'], env, io, load)).toBe(2);
    expect(lines).toEqual([{ stream: 'out', line: 'did the thing' }]);
  });

  it('redacts the composed URL and the password from every line, raw or encoded', async () => {
    const env: DatabaseEnv = { ...PARTS };
    const { io, lines } = recordingIo();
    const load = async (): Promise<FleetAdminCommands> => ({
      runFleetAdmin: async (_argv, sink) => {
        sink.out(`connecting to ${process.env['DATABASE_URL'] ?? env['DATABASE_URL'] ?? ''}`);
        sink.err(`password ${HOSTILE_PASSWORD} / ${encodeURIComponent(HOSTILE_PASSWORD)}`);
        return 1;
      },
      disconnect: async () => undefined,
    });
    expect(await runFleetAdminEntry(['pool-status'], env, io, load)).toBe(1);
    const text = lines.map((l) => l.line).join('\n');
    expect(text).not.toContain(HOSTILE_PASSWORD);
    expect(text).not.toContain(encodeURIComponent(HOSTILE_PASSWORD));
    expect(text).not.toContain('db.internal.example:5432');
    expect(lines.at(-1)).toEqual({ stream: 'out', line: 'fleet-admin exit 1' });
  });

  it('answers 1, with the exit line, when only some parts are set', async () => {
    const env: DatabaseEnv = { ...PARTS, [DATABASE_PART_ENV.username]: '' };
    const { io, lines } = recordingIo();
    const { seen, load } = fakeCommands(0);
    expect(await runFleetAdminEntry(['pool-status'], env, io, load)).toBe(1);
    expect(seen.argv).toBeUndefined();
    expect(lines).toEqual([
      { stream: 'err', line: 'error: MOTIR_DB_USERNAME is not set' },
      { stream: 'out', line: 'fleet-admin exit 1' },
    ]);
  });

  it('answers 1 on a load that refuses, redacted, and still ends with the exit line', async () => {
    const env: DatabaseEnv = { ...PARTS };
    const { io, lines } = recordingIo();
    const load = async (): Promise<FleetAdminCommands> => {
      throw new Error(`cannot reach ${env['DATABASE_URL'] ?? ''}`);
    };
    expect(await runFleetAdminEntry(['pool-status'], env, io, load)).toBe(1);
    expect(lines).toEqual([
      { stream: 'err', line: 'error: cannot reach [redacted]' },
      { stream: 'out', line: 'fleet-admin exit 1' },
    ]);
  });

  it('keeps the exit code when ending the pool fails', async () => {
    const { io, lines } = recordingIo();
    const load = async (): Promise<FleetAdminCommands> => ({
      runFleetAdmin: async () => 2,
      disconnect: () => Promise.reject(new Error('pool already ended')),
    });
    expect(await runFleetAdminEntry([], { ...PARTS }, io, load)).toBe(2);
    expect(lines).toEqual([{ stream: 'out', line: 'fleet-admin exit 2' }]);
  });

  it('names an unknown throw on load without a message', async () => {
    const { io, lines } = recordingIo();
    const load = (): Promise<FleetAdminCommands> => Promise.reject('not an error');
    expect(await runFleetAdminEntry([], { DATABASE_URL: 'x' }, io, load)).toBe(1);
    expect(lines).toEqual([{ stream: 'err', line: 'error: unknown' }]);
  });
});

describe('loadFleetAdmin', () => {
  it('loads the real commands, and ends the pool', async () => {
    const commands = await loadFleetAdmin();
    const { io, lines } = recordingIo();
    expect(await commands.runFleetAdmin(['no-such-command'], io)).toBe(1);
    expect(lines[0]).toEqual({ stream: 'err', line: expect.stringMatching(/^usage:/) });
    // Prisma reconnects on the next query, so the suite's client survives this.
    await expect(commands.disconnect()).resolves.toBeUndefined();
  });
});

// ── the real bundle, in a child process ─────────────────────────────────────

const ROOT = process.cwd();
const ROLE = `fleet_admin_fargate_${process.pid}`;

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

describe('the fleet-admin bundle in a Fargate-shaped process', () => {
  let work = '';
  let bundle = '';
  let caPath = '';
  let front: Awaited<ReturnType<typeof startTlsFront>>;
  let database = '';
  let baseEnv: DatabaseEnv = {};

  beforeAll(async () => {
    // Built INSIDE the checkout, so the bundle's external `pg` resolves upward
    // into this repository's node_modules, as it resolves into /app's in the image.
    // `.fleet-admin/` exists only after a `pnpm build:fleet-admin`, which CI's
    // test jobs never run.
    mkdirSync(path.join(ROOT, '.fleet-admin'), { recursive: true });
    work = mkdtempSync(path.join(ROOT, '.fleet-admin', 'fargate-entry-'));
    bundle = path.join(work, 'fleet-admin.mjs');
    execFileSync(process.execPath, ['scripts/build-fleet-admin.mjs', '--outfile', bundle], {
      cwd: ROOT,
      stdio: 'pipe',
    });

    const testUrl = new URL(process.env['DATABASE_URL'] ?? '');
    database = decodeURIComponent(testUrl.pathname.slice(1));
    // The login gets exactly the privileges of the role the code under test
    // connects as (`@/lib/db`'s URL — the runtime role under TEST_DB_APP_ROLE=1),
    // as a member of it; only its name and password are new. Read from the URL,
    // not queried, so the singleton runs no raw statement here.
    const runtimeRole = decodeURIComponent(testUrl.username);
    await adminDb.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
    const [create] = await adminDb.$queryRaw<Array<{ sql: string }>>`
      SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE %I',
        ${ROLE}::text, ${HOSTILE_PASSWORD}::text, ${runtimeRole}::text) AS sql`;
    await adminDb.$executeRawUnsafe(create?.sql ?? '');

    const certs = makeCertificates(mkdtempSync(path.join(tmpdir(), 'fleet-admin-tls-')));
    caPath = certs.caPath;
    front = await startTlsFront(
      { host: testUrl.hostname, port: Number(testUrl.port || 5432) },
      certs,
    );

    // The child gets the test process's environment (the auth placeholders the
    // commands' modules read at import) minus every database URL.
    baseEnv = { ...process.env };
    delete baseEnv['DATABASE_URL'];
    delete baseEnv['DATABASE_URL_UNPOOLED'];
    delete baseEnv['NODE_OPTIONS'];
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

  it('composes the URL from the parts, verifies the certificate, reads the database and prints', async () => {
    const before = front.handshakes();
    const run = await runBundle(bundle, ['pool-status'], fargateEnv());
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // It DID something: one line per fleet kind, read from fleet_shard over TLS.
    expect(run.stdout).toMatch(/^ci_runner: /m);
    expect(lastLine(run.stdout)).toBe('fleet-admin exit 0');
    expect(front.handshakes()).toBeGreaterThan(before);
    assertNoSecret(run);
  }, 60_000);

  // MOTIR-10592 — the switches' readers are registered as an import side effect
  // of `lib/ciFleet/fleetKindSwitches.ts`, and an unwired kind reads Fly. The
  // services import it through their admission code; this bundle is a separate
  // module graph, so only a run of the BUILT bundle can show it wired. On AWS
  // production every kind printed `fly (no growth)` with the switches on `aws`.
  it('reads the env-driven fleet switches: aws when set to aws, fly otherwise', async () => {
    const onAws = await runBundle(
      bundle,
      ['pool-status'],
      fargateEnv({ MOTIR_FLEET_CI_RUNNER_PROVIDER: 'aws', MOTIR_INDEX_FLEET_PROVIDER: 'aws' }),
    );
    expect(onAws.stderr).toBe('');
    expect(onAws.code).toBe(0);
    expect(onAws.stdout).toMatch(/^ci_runner: aws {2}growth /m);
    expect(onAws.stdout).toMatch(/^code_graph_index: aws {2}growth /m);
    expect(onAws.stdout).toContain('  shared accounts (granted vCPU as stored):');
    expect(lastLine(onAws.stdout)).toBe('fleet-admin exit 0');
    assertNoSecret(onAws);

    const onFly = await runBundle(
      bundle,
      ['pool-status', '--kind', 'ci_runner'],
      fargateEnv({ MOTIR_FLEET_CI_RUNNER_PROVIDER: 'fly', MOTIR_INDEX_FLEET_PROVIDER: '' }),
    );
    expect(onFly.code).toBe(0);
    expect(onFly.stdout).toMatch(/^ci_runner: fly \(no growth\)$/m);
    expect(onFly.stdout).not.toMatch(/^ci_runner: aws/m);
  }, 60_000);

  it('answers a refusal as 1, to the caller and on the last line', async () => {
    const run = await runBundle(bundle, ['growth-events'], fargateEnv());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('--kind is required');
    expect(lastLine(run.stdout)).toBe('fleet-admin exit 1');
    assertNoSecret(run);
  }, 60_000);

  it('is verify-full: without the CA the certificate is refused, not trusted', async () => {
    const run = await runBundle(bundle, ['pool-status'], fargateEnv({ NODE_EXTRA_CA_CERTS: '' }));
    expect(run.code).toBe(1);
    expect(run.stdout).not.toMatch(/^ci_runner: /m);
    expect(run.stderr).toMatch(/^error: .*certificate/im);
    expect(lastLine(run.stdout)).toBe('fleet-admin exit 1');
    assertNoSecret(run);
  }, 60_000);

  it('with DATABASE_URL already set, behaves as on Fly: same output, real exit code, no exit line', async () => {
    const run = await runBundle(bundle, ['pool-status'], {
      ...baseEnv,
      DATABASE_URL: process.env['DATABASE_URL'],
    });
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^ci_runner: /m);
    expect(run.stdout).not.toContain('fleet-admin exit');

    const usage = await runBundle(bundle, ['no-such-command'], {
      ...baseEnv,
      DATABASE_URL: process.env['DATABASE_URL'],
    });
    expect(usage.code).toBe(1);
    expect(usage.stderr).toMatch(/^usage:/);
    expect(usage.stdout).toBe('');
  }, 60_000);
});
