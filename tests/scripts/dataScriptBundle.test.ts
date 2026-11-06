import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { DATABASE_PART_ENV, type DatabaseEnv } from '@/scripts/fleet/fleetAdminDatabaseUrl';
import { adminDb } from '../helpers/adminDb';
import { makeCertificates, startTlsFront } from '../helpers/postgresTlsFront';

// MOTIR-10465 — the REAL data-script bundle, in a child process shaped like a core
// worker task: no `DATABASE_URL`, the login PARTS of a role whose password holds `@`,
// `/`, `:` and `%`, the database behind a TLS front the CA bundle verifies, and the
// role a member of the application role the code under test runs as — the role a
// production run uses, under every RLS policy.
//
// The trap is a bundle that does NOTHING and exits 0. So each case reads a result
// that only a database round trip can produce: the board backfill must seed the
// board a fixture project lost, and the sweep must open a TLS session.

const ROOT = process.cwd();
const ROLE = `data_script_fargate_${process.pid}`;
const HOSTILE_PASSWORD = 'p@ss/w:rd%41%%x';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runBundle(bundle: string, argv: string[], env: DatabaseEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    // A cwd with no `.env`, as `/app` in the image has none.
    const cwd = mkdtempSync(path.join(tmpdir(), 'data-script-cwd-'));
    const child = spawn(process.execPath, [bundle, ...argv], {
      cwd,
      env: env as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      rmSync(cwd, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

describe('the data-script bundle in a Fargate-shaped process', () => {
  let work = '';
  let bundle = '';
  let caPath = '';
  let front: Awaited<ReturnType<typeof startTlsFront>>;
  let database = '';
  let baseEnv: DatabaseEnv = {};

  beforeAll(async () => {
    // Built INSIDE the checkout, so the bundle's external `pg` resolves upward into
    // this repository's node_modules, as it resolves into /app's in the image.
    mkdirSync(path.join(ROOT, '.data-script'), { recursive: true });
    work = mkdtempSync(path.join(ROOT, '.data-script', 'fargate-entry-'));
    bundle = path.join(work, 'data-script.mjs');
    execFileSync(process.execPath, ['scripts/build-data-script.mjs', '--outfile', bundle], {
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

    const certs = makeCertificates(mkdtempSync(path.join(tmpdir(), 'data-script-tls-')));
    caPath = certs.caPath;
    front = await startTlsFront(
      { host: testUrl.hostname, port: Number(testUrl.port || 5432) },
      certs,
    );

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

  it('seeds a lost board as the application role, over verify-full TLS, and says 0 last', async () => {
    const user = await usersService.createUser({
      email: `data-script-bundle-${process.pid}@example.com`,
      password: 'hunter2hunter2',
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Bundle',
      ownerUserId: user.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Bundle',
      identifier: 'DSBUN',
    });
    await adminDb.board.deleteMany({ where: { projectId: project.id } });

    const before = front.handshakes();
    const run = await runBundle(bundle, ['backfill-boards'], fargateEnv());
    expect(run.stdout).toContain(`[backfill-boards] seeded board for ${project.id} (Bundle).`);
    expect(await adminDb.board.count({ where: { projectId: project.id } })).toBe(1);
    expect(front.handshakes()).toBeGreaterThan(before);
    expect(run.code).toBe(0);
    expect(lastLine(run.stdout)).toBe('data-script exit 0');
    expect(run.stdout).not.toContain('injected env');
    assertNoSecret(run);
  }, 60_000);

  it('runs a dry-run sweep and passes its flags through', async () => {
    const run = await runBundle(bundle, ['backfill-ci-state', '--dry-run'], fargateEnv());
    expect(run.stdout).toContain('[backfill-ci-state] DRY RUN');
    expect(run.stdout).toContain('[backfill-ci-state] done — ');
    expect(run.code).toBe(0);
    expect(lastLine(run.stdout)).toBe('data-script exit 0');
    assertNoSecret(run);
  }, 60_000);

  it('is verify-full: without the CA the certificate is refused, and the run answers 1', async () => {
    const run = await runBundle(
      bundle,
      ['converge-unlanded-cards', '--dry-run'],
      fargateEnv({ NODE_EXTRA_CA_CERTS: '' }),
    );
    expect(run.stderr).toContain('[data-script] converge-unlanded-cards failed:');
    expect(run.stdout).not.toContain('done — scanned');
    expect(run.code).toBe(1);
    expect(lastLine(run.stdout)).toBe('data-script exit 1');
    assertNoSecret(run);
  }, 60_000);

  it('refuses an unknown script with the usage, and reaches no database', async () => {
    const before = front.handshakes();
    const run = await runBundle(bundle, ['reseed'], fargateEnv());
    expect(run.stderr).toContain('[data-script] unknown script "reseed"');
    expect(run.stderr).toContain('scripts: backfill-boards, backfill-ci-state');
    expect(front.handshakes()).toBe(before);
    expect(run.code).toBe(1);
    expect(lastLine(run.stdout)).toBe('data-script exit 1');
  }, 60_000);

  it('with DATABASE_URL already set, behaves as a checkout does: real exit code, no exit line', async () => {
    const run = await runBundle(bundle, ['backfill-fix-reason', '--nope'], {
      ...baseEnv,
      DATABASE_URL: process.env['DATABASE_URL'],
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('unknown argument: --nope');
    expect(run.stdout).not.toContain('data-script exit');
  }, 60_000);
});
