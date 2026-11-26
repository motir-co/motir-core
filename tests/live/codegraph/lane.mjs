#!/usr/bin/env node
/* eslint-disable no-console -- a command-line script: its console is its output. */
// THE LIVE CODE-GRAPH LANE (MOTIR-12260 · story MOTIR-12250) — `pnpm test:live:codegraph`.
//
// Brings the whole path up on this machine, runs the suite against it, and stops
// everything it started. Nothing here is a stand-in for motir-ai or motir-codegraph:
// both are checked out at a commit this script names and started from their READMEs,
// each on its own Postgres database and with its own worker.
//
//   1. inputs        every input is checked before anything starts; a missing or blank
//                    one fails the lane and names it (the lane never skips)
//   2. checkouts     motir-ai and motir-codegraph at LIVE_AI_COMMIT / LIVE_CODEGRAPH_COMMIT
//                    (their default branches' heads when unpinned)
//   3. postgres      one throwaway cluster (initdb) with three databases
//   4. codegraph     db:bootstrap · db:migrate · operator:bootstrap · serve · worker
//                    (windows 120000 / 600000 ms, sweep every 30000 ms, on the WORKER)
//   5. credentials   motir-ai's operator and read-client credentials, minted through
//                    codegraph's operator calls
//   6. archive host  a TLS host serving the scratch repository's archives
//   7. motir-ai      prisma migrate deploy · its server (the worker runs in-process)
//   8. motir-core    migrate · build:worker · next dev · the job worker with the
//                    GitHub preload
//   9. the suite     playwright, `tests/live/codegraph/playwright.config.ts`
//
// Every child gets a SANITIZED environment (a short allowlist plus what this script
// sets), so no credential of the shell that runs the lane reaches a service, and
// `next dev` does not see an agent's markers. Logs land in `<work dir>/logs/`.
//
// See README.md beside this file for every input.

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '../../..');

// ── 1. inputs ───────────────────────────────────────────────────────────────

const DEFAULT_AI_URL = 'https://github.com/motir-co/motir-ai.git';
const DEFAULT_CODEGRAPH_URL = 'https://github.com/motir-co/motir-codegraph.git';

/** The webhook secret the suite signs with (`tests/e2e/_helpers/github-const.ts`). */
const WEBHOOK_SECRET = 'e2e-github-webhook-secret';

/** The windows the card fixes, set on codegraph's WORKER (where the sweep runs). */
const WINDOWS = {
  DEFAULT_BRANCH_RETENTION_WINDOW_MS: '120000',
  REF_RETENTION_WINDOW_MS: '600000',
  RETENTION_SWEEP_INTERVAL_MS: '30000',
};

function fail(message) {
  console.error(`\n[live-lane] FAILED: ${message}`);
  process.exitCode = 1;
  throw new LaneError(message);
}

class LaneError extends Error {}

/** An optional input: unset is fine, set-but-blank is a mistake and fails. */
function optional(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (raw.trim() === '') fail(`${name} is set but blank — unset it or give it a value`);
  return raw.trim();
}

function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function pgBinDir() {
  const pinned = optional('LIVE_PG_BIN');
  const candidates = [];
  if (pinned) candidates.push(pinned);
  else {
    const fromConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
    if (fromConfig.status === 0) candidates.push(fromConfig.stdout.trim());
    for (const v of ['18', '17', '16']) candidates.push(`/usr/lib/postgresql/${v}/bin`);
  }
  const dir = candidates.find(
    (d) => existsSync(path.join(d, 'initdb')) && existsSync(path.join(d, 'pg_ctl')),
  );
  if (!dir) {
    fail(
      `LIVE_PG_BIN: no Postgres 16+ server binaries (initdb, pg_ctl) found in ${candidates.join(', ')} — ` +
        'install Postgres 16 or later, or point LIVE_PG_BIN at its bin directory',
    );
  }
  return dir;
}

function readInputs() {
  for (const bin of ['git', 'pnpm', 'openssl']) {
    if (!which(bin)) fail(`${bin} is not on PATH — the lane needs it to bring the stack up`);
  }
  const isRoot = userInfo().uid === 0;
  const pgUser = optional('LIVE_PG_OS_USER') ?? (isRoot ? 'postgres' : null);
  if (isRoot && pgUser && spawnSync('id', ['-u', pgUser]).status !== 0) {
    fail(`LIVE_PG_OS_USER: Postgres refuses to run as root and no OS user "${pgUser}" exists`);
  }
  return {
    pgBin: pgBinDir(),
    pgUser,
    workDir: optional('LIVE_WORK_DIR') ?? path.join(tmpdir(), `motir-live-codegraph-${Date.now()}`),
    keep: process.env['LIVE_KEEP_STACK'] === '1',
    ai: {
      name: 'motir-ai',
      dir: optional('LIVE_AI_DIR'),
      url: optional('LIVE_AI_REPO_URL') ?? DEFAULT_AI_URL,
      commit: optional('LIVE_AI_COMMIT'),
      commitEnv: 'LIVE_AI_COMMIT',
    },
    codegraph: {
      name: 'motir-codegraph',
      dir: optional('LIVE_CODEGRAPH_DIR'),
      url: optional('LIVE_CODEGRAPH_REPO_URL') ?? DEFAULT_CODEGRAPH_URL,
      commit: optional('LIVE_CODEGRAPH_COMMIT'),
      commitEnv: 'LIVE_CODEGRAPH_COMMIT',
    },
    grep: optional('LIVE_GREP'),
  };
}

// ── processes ───────────────────────────────────────────────────────────────

/** The only variables of the calling shell a child sees. */
const PASS_THROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER', 'SHELL', 'TERM'];

function cleanEnv(extra = {}) {
  const env = {};
  for (const key of PASS_THROUGH) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

/** Installs (pnpm / git fetch) need the network the shell has — its proxy and CA — and nothing else. */
function networkEnv() {
  const env = cleanEnv();
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|GIT_SSL_CAINFO|npm_config_.*)$/.test(
        key,
      )
    ) {
      env[key] = value;
    }
  }
  return env;
}

const children = [];
let logDir;

function run(label, cmd, args, opts = {}) {
  console.log(`[live-lane] ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? CORE,
    env: opts.env ?? cleanEnv(),
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    fail(
      `${label} exited ${r.status ?? r.signal}${opts.capture ? `: ${(r.stderr || r.stdout).trim().slice(-2000)}` : ''}`,
    );
  }
  return opts.capture ? r.stdout : '';
}

/**
 * Start a long-running child. Its stdout and stderr go STRAIGHT to `<logs>/<name>.log`
 * (a file descriptor, never a pipe this process drains), so a child keeps writing
 * while this script blocks — the suite reads the codegraph worker's log as it runs.
 */
function start(name, cmd, args, opts) {
  const file = path.join(logDir, `${name}.log`);
  const fd = openSync(file, 'a');
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  closeSync(fd);
  const entry = {
    name,
    child,
    exited: null,
    output: () => (existsSync(file) ? readFileSync(file, 'utf8') : ''),
  };
  child.on('exit', (code, signal) => {
    entry.exited = code ?? signal;
  });
  children.push(entry);
  console.log(`[live-lane] started ${name} (pid ${child.pid}) → ${file}`);
  return entry;
}

async function waitFor(label, check, { timeoutMs = 180_000, everyMs = 500, entry } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry && entry.exited !== null) {
      fail(
        `${label}: ${entry.name} exited (${entry.exited}) before it was ready — see ${entry.name}.log:\n${entry.output().slice(-3000)}`,
      );
    }
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  fail(`${label} was not ready within ${timeoutMs} ms${entry ? ` — see ${entry.name}.log` : ''}`);
}

const healthy = (url) => async () => (await fetch(url)).status === 200;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function stopAll() {
  for (const entry of [...children].reverse()) {
    if (entry.exited !== null) continue;
    try {
      process.kill(-entry.child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

// ── 2. checkouts ────────────────────────────────────────────────────────────

function git(args, cwd, capture = true) {
  return run(`git ${args[0]}`, 'git', args, { cwd, env: networkEnv(), capture }).trim();
}

/** The remote default branch's head, when no commit is pinned. */
function defaultHead(spec, cwd) {
  const out = git(['ls-remote', cwd ? 'origin' : spec.url, 'HEAD'], cwd ?? CORE);
  const sha = out.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha ?? ''))
    fail(`${spec.commitEnv}: could not read ${spec.name}'s default head (${out})`);
  return sha;
}

function checkout(spec, workDir) {
  let commit = spec.commit;
  if (commit && !/^[0-9a-f]{7,40}$/.test(commit))
    fail(`${spec.commitEnv}: "${commit}" is not a commit sha`);
  if (spec.dir) {
    if (!existsSync(path.join(spec.dir, '.git')))
      fail(`${spec.name}: ${spec.dir} is not a git checkout`);
    commit = commit
      ? git(['rev-parse', `${commit}^{commit}`], spec.dir)
      : defaultHead(spec, spec.dir);
    const head = git(['rev-parse', 'HEAD'], spec.dir);
    const dirty = git(['status', '--porcelain', '--untracked-files=no'], spec.dir);
    if (head === commit && dirty === '' && existsSync(path.join(spec.dir, 'node_modules'))) {
      console.log(`[live-lane] ${spec.name}: using ${spec.dir} in place at ${commit}`);
      return { dir: spec.dir, commit, installed: true };
    }
    const target = path.join(workDir, spec.name);
    git(['fetch', 'origin', commit], spec.dir, false);
    git(['worktree', 'add', '--detach', target, commit], spec.dir, false);
    return { dir: target, commit, installed: false, worktreeOf: spec.dir };
  }
  commit = commit ?? defaultHead(spec);
  const target = path.join(workDir, spec.name);
  git(['clone', '--quiet', spec.url, target], CORE, false);
  git(['checkout', '--quiet', '--detach', commit], target, false);
  return { dir: target, commit: git(['rev-parse', 'HEAD'], target), installed: false };
}

function install(repo, label) {
  if (repo.installed) return;
  run(`${label} pnpm install`, 'pnpm', ['install', '--frozen-lockfile'], {
    cwd: repo.dir,
    env: networkEnv(),
  });
}

// ── 3. postgres ─────────────────────────────────────────────────────────────

function asPgUser(inputs, bin, args) {
  const full = path.join(inputs.pgBin, bin);
  return inputs.pgUser ? ['runuser', ['-u', inputs.pgUser, '--', full, ...args]] : [full, args];
}

async function startPostgres(inputs, workDir) {
  const data = path.join(workDir, 'pg', 'data');
  const sock = path.join(workDir, 'pg', 'sock');
  mkdirSync(sock, { recursive: true });
  if (inputs.pgUser) run('chown pg dir', 'chown', ['-R', inputs.pgUser, path.join(workDir, 'pg')]);
  const port = await freePort();
  const [initCmd, initArgs] = asPgUser(inputs, 'initdb', [
    '-D',
    data,
    '-U',
    'postgres',
    '--auth=trust',
    '-E',
    'UTF8',
  ]);
  run('initdb', initCmd, initArgs, { capture: true });
  const [ctlCmd, ctlArgs] = asPgUser(inputs, 'pg_ctl', [
    '-D',
    data,
    '-l',
    path.join(workDir, 'pg', 'server.log'),
    '-w',
    '-o',
    `-p ${port} -k ${sock} -c listen_addresses=127.0.0.1 -c max_connections=300`,
    'start',
  ]);
  run('pg_ctl start', ctlCmd, ctlArgs, { capture: true });
  const stop = () => {
    const [cmd, args] = asPgUser(inputs, 'pg_ctl', ['-D', data, '-m', 'fast', 'stop']);
    spawnSync(cmd, args, { stdio: 'ignore' });
  };
  const psql = (sql) => {
    const r = spawnSync(
      path.join(inputs.pgBin, 'psql'),
      [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        sql,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) fail(`psql: ${r.stderr.trim()}`);
  };
  for (const db of ['motir_core', 'motir_ai']) {
    psql(`CREATE ROLE ${db} LOGIN SUPERUSER PASSWORD '${db}'`);
    psql(`CREATE DATABASE ${db} OWNER ${db}`);
  }
  const url = (user, db) => `postgresql://${user}:${user}@127.0.0.1:${port}/${db}`;
  return { port, stop, url, adminUrl: `postgresql://postgres@127.0.0.1:${port}/postgres` };
}

// ── 6. TLS for the archive host ─────────────────────────────────────────────

function mintCertificate(workDir) {
  const dir = path.join(workDir, 'tls');
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  run(
    'openssl',
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ],
    { capture: true },
  );
  return { key, cert };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const inputs = readInputs();
  const workDir = inputs.workDir;
  mkdirSync(workDir, { recursive: true });
  logDir = path.join(workDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  console.log(`[live-lane] work dir ${workDir}`);

  // 2. checkouts
  const ai = checkout(inputs.ai, workDir);
  const cg = checkout(inputs.codegraph, workDir);
  install(ai, 'motir-ai');
  install(cg, 'motir-codegraph');
  const coreCommit = git(['rev-parse', 'HEAD'], CORE);

  // 3. postgres
  const pg = await startPostgres(inputs, workDir);
  // A worktree the lane added is removed with the rest (its checkout is never one of these).
  const cleanups = [ai, cg]
    .filter((repo) => repo.worktreeOf)
    .map(
      (repo) => () =>
        spawnSync('git', ['-C', repo.worktreeOf, 'worktree', 'remove', '--force', repo.dir], {
          stdio: 'ignore',
        }),
    );
  cleanups.push(pg.stop);
  process.on('exit', () => {
    if (!inputs.keep) {
      stopAll();
      for (const c of cleanups.reverse()) c();
    }
  });

  // 4. codegraph
  const cgPort = await freePort();
  const cgOrigin = `http://127.0.0.1:${cgPort}`;
  const tls = mintCertificate(workDir);
  const scratch = path.join(workDir, 'codegraph-scratch');
  mkdirSync(scratch, { recursive: true });
  const bootstrapToken = `cgk_${randomBytes(24).toString('base64url')}`;
  const cgEnv = cleanEnv({
    DATABASE_ADMIN_URL: pg.adminUrl,
    DATABASE_URL: pg.url('codegraph_owner', 'codegraph'),
    DATABASE_APP_URL: pg.url('codegraph_app', 'codegraph'),
    PORT: String(cgPort),
    HOST: '127.0.0.1',
    SCRATCH_DIR: scratch,
    FETCH_ALLOWED_HOSTS: '127.0.0.1',
    MAINTENANCE_INTERVAL_MS: '5000',
    WORKER_POLL_MS: '200',
    NODE_EXTRA_CA_CERTS: tls.cert,
    ...WINDOWS,
  });
  run('codegraph db:bootstrap', 'pnpm', ['--silent', 'db:bootstrap'], { cwd: cg.dir, env: cgEnv });
  run('codegraph db:migrate', 'pnpm', ['--silent', 'db:migrate'], {
    cwd: cg.dir,
    env: cgEnv,
    capture: true,
  });
  run('codegraph operator:bootstrap', 'pnpm', ['--silent', 'operator:bootstrap'], {
    cwd: cg.dir,
    env: { ...cgEnv, OPERATOR_TOKEN: bootstrapToken },
    capture: true,
  });
  const cgServe = start(
    'codegraph-serve',
    process.execPath,
    ['--import', 'tsx', 'src/server/main.ts'],
    { cwd: cg.dir, env: cgEnv },
  );
  await waitFor('codegraph server', healthy(`${cgOrigin}/health`), { entry: cgServe });
  const cgWorker = start(
    'codegraph-worker',
    process.execPath,
    ['--import', 'tsx', 'src/worker/main.ts'],
    { cwd: cg.dir, env: cgEnv },
  );
  await waitFor(
    'codegraph worker',
    async () => cgWorker.output().includes('"retention sweep pass"'),
    { entry: cgWorker, timeoutMs: 120_000 },
  );

  // 5. the suite's own read client. motir-ai mints ITS credentials itself when it
  // starts (step 7); this lane never holds them (motir-core's MOTIR-11649 guard). The
  // suite reads the graph as a client of its own, which it grants the tenant motir-ai
  // registers once that tenant exists.
  const operator = async (p, body) => {
    const res = await fetch(`${cgOrigin}/v1/operator${p}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bootstrapToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) fail(`codegraph operator ${p} answered ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };
  const { clientId: suiteClientId } = await operator('/clients', {
    name: 'live-suite-reader',
    kind: 'client',
  });
  const { token: suiteToken } = await operator(`/clients/${suiteClientId}/credentials`, {});

  // 6. the archive host and the scratch repository
  const archivePort = await freePort();
  const scenarioPath = path.join(workDir, 'scenario.json');
  const githubLog = path.join(workDir, 'github.jsonl');
  writeFileSync(githubLog, '');
  const archive = start('archive-host', process.execPath, [path.join(HERE, 'archiveHost.mjs')], {
    cwd: CORE,
    env: cleanEnv({
      LIVE_SCENARIO: scenarioPath,
      LIVE_ARCHIVE_PORT: String(archivePort),
      LIVE_TLS_KEY: tls.key,
      LIVE_TLS_CERT: tls.cert,
    }),
  });
  await waitFor('archive host', async () => archive.output().includes('listening'), {
    entry: archive,
  });

  // 7. motir-ai
  const aiPort = await freePort();
  const corePort = await freePort();
  const aiOrigin = `http://127.0.0.1:${aiPort}`;
  const coreOrigin = `http://localhost:${corePort}`;
  const serviceToken = `live-${randomBytes(16).toString('hex')}`;
  const aiEnv = cleanEnv({
    DATABASE_URL: pg.url('motir_ai', 'motir_ai'),
    PORT: String(aiPort),
    MOTIR_AI_SERVICE_TOKEN: serviceToken,
    MOTIR_CORE_URL: coreOrigin,
  });
  run('motir-ai prisma generate', 'pnpm', ['exec', 'prisma', 'generate'], {
    cwd: ai.dir,
    env: aiEnv,
    capture: true,
  });
  run('motir-ai migrate:deploy', 'pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: ai.dir,
    env: aiEnv,
    capture: true,
  });
  // motir-ai's own script mints its operator and read client on the service, then
  // serves (motir-ai's docs/codegraph-client-lane.md). The lane hands it the service
  // only: the origin and the bootstrap operator, which the script drops before serving.
  const aiServer = start(
    'motir-ai',
    process.execPath,
    ['--import', 'tsx', 'scripts/serve-with-local-codegraph.ts'],
    {
      cwd: ai.dir,
      env: {
        ...aiEnv,
        LOCAL_CODEGRAPH_ORIGIN: cgOrigin,
        LOCAL_CODEGRAPH_BOOTSTRAP_TOKEN: bootstrapToken,
      },
    },
  );
  await waitFor('motir-ai', healthy(`${aiOrigin}/health`), { entry: aiServer });

  // 8. motir-core
  const coreDb = pg.url('motir_core', 'motir_core');
  const coreEnv = cleanEnv({
    // The repository's own bins (prisma, next) first, as `pnpm run` would put them.
    PATH: `${path.join(CORE, 'node_modules', '.bin')}${path.delimiter}${process.env['PATH'] ?? ''}`,
    DATABASE_URL: coreDb,
    BETTER_AUTH_SECRET: randomBytes(24).toString('hex'),
    BETTER_AUTH_URL: coreOrigin,
    GOOGLE_CLIENT_ID: 'live-lane',
    GOOGLE_CLIENT_SECRET: 'live-lane',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    MOTIR_BASE_URL: coreOrigin,
    EMAIL_PROVIDER: 'file',
    EMAIL_OUTBOX_PATH: path.join(workDir, 'outbox.jsonl'),
    MOTIR_AI_URL: aiOrigin,
    MOTIR_AI_SERVICE_TOKEN: serviceToken,
  });
  run('motir-core migrate', process.execPath, ['scripts/migrate-deploy.mjs'], {
    cwd: CORE,
    env: coreEnv,
    capture: true,
  });
  run('motir-core build:worker', 'pnpm', ['--silent', 'build:worker'], {
    cwd: CORE,
    env: coreEnv,
    capture: true,
  });
  const next = start(
    'motir-core-next',
    process.execPath,
    ['node_modules/next/dist/bin/next', 'dev', '-p', String(corePort)],
    {
      cwd: CORE,
      env: { ...coreEnv, NODE_OPTIONS: '--max-old-space-size=6144' },
    },
  );
  // A route that touches the database: the dev server compiles on first request.
  await waitFor(
    'motir-core',
    async () => {
      const res = await fetch(`${coreOrigin}/api/github/webhook`, { method: 'POST', body: '{}' });
      return res.status === 401;
    },
    { entry: next, timeoutMs: 400_000, everyMs: 2000 },
  );
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const coreWorker = start(
    'motir-core-worker',
    process.execPath,
    ['--import', path.join(HERE, 'githubFake.preload.mjs'), '.worker/worker.mjs'],
    {
      cwd: CORE,
      env: {
        ...coreEnv,
        NODE_ENV: 'production',
        E2E_PROD_HARNESS: '1',
        GITHUB_APP_ID: '424243',
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
        LIVE_SCENARIO: scenarioPath,
        LIVE_GITHUB_LOG: githubLog,
      },
    },
  );
  await waitFor(
    'motir-core job worker',
    async () => coreWorker.output().includes('[worker] started as'),
    { entry: coreWorker },
  );

  // 9. the suite
  // The suite seeds through motir-core's own services, so it carries the app's environment.
  const suiteEnv = {
    ...coreEnv,
    LIVE_CORE_URL: coreOrigin,
    LIVE_CORE_DATABASE_URL: coreDb,
    LIVE_AI_DATABASE_URL: aiEnv.DATABASE_URL,
    LIVE_CODEGRAPH_URL: cgOrigin,
    LIVE_CODEGRAPH_DATABASE_URL: cgEnv.DATABASE_URL,
    LIVE_CODEGRAPH_READ_TOKEN: suiteToken,
    LIVE_CODEGRAPH_READ_CLIENT_ID: suiteClientId,
    LIVE_CODEGRAPH_OPERATOR_TOKEN: bootstrapToken,
    LIVE_CODEGRAPH_WORKER_LOG: path.join(logDir, 'codegraph-worker.log'),
    LIVE_SCENARIO: scenarioPath,
    LIVE_GITHUB_LOG: githubLog,
    LIVE_ARCHIVE_ORIGIN: `https://127.0.0.1:${archivePort}`,
    LIVE_DEFAULT_BRANCH_WINDOW_MS: WINDOWS.DEFAULT_BRANCH_RETENTION_WINDOW_MS,
    LIVE_REF_WINDOW_MS: WINDOWS.REF_RETENTION_WINDOW_MS,
    LIVE_SWEEP_INTERVAL_MS: WINDOWS.RETENTION_SWEEP_INTERVAL_MS,
    LIVE_AI_COMMIT: ai.commit,
    LIVE_CODEGRAPH_COMMIT: cg.commit,
    LIVE_CORE_COMMIT: coreCommit,
    LIVE_OUTPUT_DIR: path.join(workDir, 'test-results'),
  };
  console.log(
    `\n[live-lane] stack up — motir-core ${coreCommit} · motir-ai ${ai.commit} · motir-codegraph ${cg.commit}\n`,
  );
  const args = [
    'exec',
    'playwright',
    'test',
    '-c',
    path.join(HERE, 'playwright.config.ts'),
    '--trace',
    'off',
  ];
  if (inputs.grep) args.push('--grep', inputs.grep);
  const suite = spawnSync('pnpm', args, { cwd: CORE, env: suiteEnv, stdio: 'inherit' });
  console.log(
    `\n[live-lane] ${suite.status === 0 ? 'GREEN' : 'RED'} — motir-core ${coreCommit} · ` +
      `motir-ai ${ai.commit} · motir-codegraph ${cg.commit} · logs in ${logDir}`,
  );
  if (inputs.keep) console.log('[live-lane] LIVE_KEEP_STACK=1: leaving the stack running');
  process.exitCode = suite.status === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    if (!(err instanceof LaneError)) console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // The `exit` handler stops the stack; exit explicitly so the children's pipes do not hold the loop.
    process.exit(process.exitCode ?? 0);
  });
