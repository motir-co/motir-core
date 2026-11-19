/**
 * `pnpm deploy:image <command>` (MOTIR-11718) — the AWS deploy's proof that the
 * image it pushed runs on BOTH CPUs the Fargate services may use, before any
 * task rolls onto it.
 *
 *   platforms  the pushed tag is an image INDEX listing linux/amd64 and
 *              linux/arm64 (attestation entries aside); prints each child
 *   smoke      for each platform: pull that child BY ITS OWN DIGEST, check the
 *              container really runs as that CPU (`process.arch`), run the
 *              release lane's migrations against the database, then start the
 *              web, the worker and the relay exactly as the task definitions
 *              do (`node /app/server.js`, `node /app/worker/worker.mjs`,
 *              `node /app/relay/relay.mjs`) and require:
 *                * web    `/api/health/ready` 200 — readiness answers 200 only
 *                         after its Prisma `SELECT 1` warm-up opened the pool,
 *                         so it is the health answer AND a Prisma query
 *                * relay  `/healthz` 200, after its start-up Prisma write
 *                         (closing its own leftover connections) succeeded
 *                * worker logged `[worker] started` and is still running once
 *                         the other two answer — its claim loop polls the job
 *                         queue through Prisma from the first tick
 *
 * The arm64 half runs under QEMU on an amd64 runner (aws-deploy.yml registers
 * it), which is slow but executes the arm64 binaries for real: a native addon or
 * engine built for the wrong CPU fails here instead of in production. Each
 * child is addressed by its own digest, never `--platform` against the index,
 * so a Docker store holding the other CPU's child under the same name cannot
 * answer for it.
 *
 * Every container runs with `--network host` against the job's Postgres, with
 * throwaway placeholder secrets; nothing here reaches AWS or production. Exit
 * codes: 0 on success, 1 on a failed check or a usage error.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** The CPUs the production services may run on, as Docker names them. */
export const REQUIRED_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;

/** Docker's platform → Node's `process.arch` inside that container. */
export const NODE_ARCH: Readonly<Record<string, string>> = {
  'linux/amd64': 'x64',
  'linux/arm64': 'arm64',
};

/** Where each service listens on the runner (host network, so they must differ). */
export const WEB_PORT = 18080;
export const RELAY_PORT = 18081;

/** How long one platform may take to answer, QEMU included. */
export const DEFAULT_DEADLINE_MS = 10 * 60_000;
export const POLL_MS = 3_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the commands touch, so every branch is testable without Docker or a network. */
export interface ImagePorts {
  docker(args: readonly string[]): Promise<CommandResult>;
  /** The HTTP status of a GET, or null when nothing answered. */
  httpStatus(url: string): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ImageIo {
  log(line: string): void;
}

export interface IndexEntry {
  platform: string;
  digest: string;
}

interface RawManifest {
  digest?: string;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations?: Record<string, string>;
}

/**
 * The platform children of an image index, read from `imagetools inspect --raw`.
 * Attestation manifests (`unknown/unknown`, or annotated as one) are not
 * platforms and are left out. Throws when `raw` is not an index at all — a
 * single-platform push, which is exactly what this card retires.
 */
export function parseIndex(raw: string): IndexEntry[] {
  let doc: { manifests?: RawManifest[]; mediaType?: string };
  try {
    doc = JSON.parse(raw) as typeof doc;
  } catch {
    throw new Error('the image manifest is not JSON');
  }
  if (!Array.isArray(doc.manifests)) {
    throw new Error(
      `the image is a single manifest (${doc.mediaType ?? 'no mediaType'}), not an index of platforms`,
    );
  }
  const entries: IndexEntry[] = [];
  for (const m of doc.manifests) {
    const os = m.platform?.os;
    const arch = m.platform?.architecture;
    if (!m.digest || !os || !arch || os === 'unknown' || arch === 'unknown') continue;
    if (m.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') continue;
    const variant = m.platform?.variant;
    entries.push({
      platform: `${os}/${arch}${variant && arch !== 'arm64' ? `/${variant}` : ''}`,
      digest: m.digest,
    });
  }
  return entries;
}

/** The required platforms the index does not list. */
export function missingPlatforms(
  entries: readonly IndexEntry[],
  required: readonly string[] = REQUIRED_PLATFORMS,
): string[] {
  const have = new Set(entries.map((e) => e.platform));
  return required.filter((p) => !have.has(p));
}

/** `repo@sha256:…` for a child of `image`, whatever `image` was addressed by. */
export function childRef(image: string, digest: string): string {
  const at = image.indexOf('@');
  let repo = at === -1 ? image : image.slice(0, at);
  // A trailing `:tag` (after the last `/`, so a registry port is left alone).
  const colon = repo.lastIndexOf(':');
  if (colon > repo.lastIndexOf('/')) repo = repo.slice(0, colon);
  return `${repo}@${digest}`;
}

async function readIndex(ports: ImagePorts, image: string): Promise<IndexEntry[]> {
  const res = await ports.docker(['buildx', 'imagetools', 'inspect', '--raw', image]);
  if (res.code !== 0) {
    throw new Error(
      `could not read ${image}'s manifest: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  }
  return parseIndex(res.stdout);
}

/** `platforms`: the index lists every required platform. */
export async function checkPlatforms(
  ports: ImagePorts,
  image: string,
  io: ImageIo,
): Promise<number> {
  const entries = await readIndex(ports, image);
  for (const e of entries) io.log(`${e.platform}  ${e.digest}`);
  const missing = missingPlatforms(entries);
  if (missing.length > 0) {
    io.log(
      `::error::${image} lists no ${missing.join(' or ')} image; the services could not run there`,
    );
    return EXIT_ERROR;
  }
  io.log(`${image} lists ${REQUIRED_PLATFORMS.join(' and ')}`);
  return EXIT_OK;
}

/** The throwaway environment every smoke container runs with. */
export function smokeEnvironment(databaseUrl: string): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
    BETTER_AUTH_SECRET: 'image-smoke-placeholder-secret-32-bytes-minimum',
    GOOGLE_CLIENT_ID: 'image-smoke-placeholder-client-id',
    GOOGLE_CLIENT_SECRET: 'image-smoke-placeholder-client-secret',
    MOTIR_BASE_URL: `http://127.0.0.1:${WEB_PORT}`,
    MOTIR_TERMINAL_MASTER_KEY: 'image-smoke-placeholder-terminal-master-key',
    EMAIL_PROVIDER: 'console',
  };
}

export interface Service {
  name: 'web' | 'worker' | 'relay';
  entrypoint: string;
  port?: number;
}

/** The three processes the services stack starts from this image (motir-infra `CORE_ENTRYPOINTS`). */
export const SERVICES: readonly Service[] = [
  { name: 'web', entrypoint: '/app/server.js', port: WEB_PORT },
  { name: 'worker', entrypoint: '/app/worker/worker.mjs' },
  { name: 'relay', entrypoint: '/app/relay/relay.mjs', port: RELAY_PORT },
];

/** The relay's line when its start-up Prisma write failed (`scripts/relay.ts`). */
export const RELAY_PRISMA_FAILURE = 'closing leftover connections failed';
/** The worker's line once its claim loop is running (`scripts/worker.ts`). */
export const WORKER_STARTED = '[worker] started';

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
}

export function containerName(platform: string, service: Service['name']): string {
  return `image-smoke-${platform.replace(/\//g, '-')}-${service}`;
}

export function runArgs(
  ref: string,
  platform: string,
  service: Service,
  env: Record<string, string>,
): string[] {
  return [
    'run',
    '--detach',
    '--name',
    containerName(platform, service.name),
    '--network',
    'host',
    '--platform',
    platform,
    ...envArgs(service.port ? { ...env, PORT: String(service.port) } : env),
    ref,
    'node',
    service.entrypoint,
  ];
}

async function isRunning(ports: ImagePorts, name: string): Promise<boolean> {
  const res = await ports.docker(['inspect', '--format', '{{.State.Running}}', name]);
  return res.code === 0 && res.stdout.trim() === 'true';
}

async function logsOf(ports: ImagePorts, name: string): Promise<string> {
  const res = await ports.docker(['logs', name]);
  return `${res.stdout}${res.stderr}`;
}

export interface SmokeOptions {
  image: string;
  platform: string;
  digest: string;
  databaseUrl: string;
  deadlineMs: number;
}

/** One platform, end to end. Never throws on a failed check; the result says why. */
export async function smokePlatform(
  ports: ImagePorts,
  opts: SmokeOptions,
  io: ImageIo,
): Promise<{ ok: boolean; problems: string[] }> {
  const { platform } = opts;
  const ref = childRef(opts.image, opts.digest);
  const env = smokeEnvironment(opts.databaseUrl);
  const problems: string[] = [];
  const started: string[] = [];
  io.log(`── ${platform}: ${ref}`);

  try {
    const pull = await ports.docker(['pull', '--quiet', ref]);
    if (pull.code !== 0)
      return { ok: false, problems: [`${platform}: pull failed: ${pull.stderr.trim()}`] };

    const arch = await ports.docker([
      'run',
      '--rm',
      '--platform',
      platform,
      ref,
      'node',
      '-p',
      'process.arch',
    ]);
    const want = NODE_ARCH[platform];
    if (arch.code !== 0 || arch.stdout.trim() !== want) {
      return {
        ok: false,
        problems: [
          `${platform}: the container reports process.arch '${arch.stdout.trim()}' (want '${want}')${arch.code !== 0 ? `: ${arch.stderr.trim()}` : ''}`,
        ],
      };
    }
    io.log(`${platform}: node runs as ${want}`);

    // The release lane's own entrypoint: the schema engine for this CPU.
    const migrate = await ports.docker([
      'run',
      '--rm',
      '--network',
      'host',
      '--platform',
      platform,
      ...envArgs(env),
      ref,
      'node',
      '/app/migrate/release-migrate.mjs',
    ]);
    io.log(`${platform}: migrate exit ${migrate.code}`);
    if (migrate.code !== 0) {
      return {
        ok: false,
        problems: [
          `${platform}: migrations failed:\n${`${migrate.stdout}${migrate.stderr}`.trim().split('\n').slice(-40).join('\n')}`,
        ],
      };
    }

    for (const service of SERVICES) {
      const res = await ports.docker(runArgs(ref, platform, service, env));
      if (res.code !== 0) {
        problems.push(`${platform}: ${service.name} did not start: ${res.stderr.trim()}`);
        return { ok: false, problems };
      }
      started.push(containerName(platform, service.name));
    }

    const deadline = ports.now() + opts.deadlineMs;
    const pending = new Map<string, string>([
      ['web', `http://127.0.0.1:${WEB_PORT}/api/health/ready`],
      ['relay', `http://127.0.0.1:${RELAY_PORT}/healthz`],
      ['worker', ''],
    ]);
    while (pending.size > 0) {
      for (const [name, url] of [...pending]) {
        const container = containerName(platform, name as Service['name']);
        if (!(await isRunning(ports, container))) {
          problems.push(`${platform}: ${name} exited before it answered`);
          pending.delete(name);
          continue;
        }
        if (url) {
          if ((await ports.httpStatus(url)) === 200) {
            io.log(`${platform}: ${name} answered 200 at ${url}`);
            pending.delete(name);
          }
        } else if ((await logsOf(ports, container)).includes(WORKER_STARTED)) {
          io.log(`${platform}: worker started its claim loop`);
          pending.delete(name);
        }
      }
      if (pending.size === 0) break;
      if (ports.now() >= deadline) {
        for (const name of pending.keys()) {
          problems.push(
            `${platform}: ${name} did not answer within ${Math.round(opts.deadlineMs / 1000)}s`,
          );
        }
        break;
      }
      await ports.sleep(POLL_MS);
    }

    if (problems.length === 0) {
      const relayLog = await logsOf(ports, containerName(platform, 'relay'));
      if (relayLog.includes(RELAY_PRISMA_FAILURE)) {
        problems.push(
          `${platform}: the relay's start-up Prisma write failed (${RELAY_PRISMA_FAILURE})`,
        );
      }
      for (const name of ['web', 'worker', 'relay'] as const) {
        if (!(await isRunning(ports, containerName(platform, name)))) {
          problems.push(`${platform}: ${name} stopped after it answered`);
        }
      }
    }
    return { ok: problems.length === 0, problems };
  } finally {
    if (problems.length > 0) {
      for (const name of started) {
        io.log(`── ${name}: last log lines`);
        for (const line of (await logsOf(ports, name)).trim().split('\n').slice(-60)) io.log(line);
      }
    }
    if (started.length > 0) await ports.docker(['rm', '--force', ...started]);
  }
}

/** `smoke`: every required platform of the index, one after another. */
export async function smoke(
  ports: ImagePorts,
  opts: { image: string; databaseUrl: string; deadlineMs: number },
  io: ImageIo,
): Promise<number> {
  const entries = await readIndex(ports, opts.image);
  const missing = missingPlatforms(entries);
  if (missing.length > 0) {
    io.log(`::error::${opts.image} lists no ${missing.join(' or ')} image`);
    return EXIT_ERROR;
  }
  const problems: string[] = [];
  for (const platform of REQUIRED_PLATFORMS) {
    const entry = entries.find((e) => e.platform === platform)!;
    const result = await smokePlatform(
      ports,
      {
        image: opts.image,
        platform,
        digest: entry.digest,
        databaseUrl: opts.databaseUrl,
        deadlineMs: opts.deadlineMs,
      },
      io,
    );
    if (result.ok) io.log(`${platform}: web, worker and relay are up against the database`);
    problems.push(...result.problems);
  }
  for (const p of problems) io.log(`::error::${p}`);
  return problems.length === 0 ? EXIT_OK : EXIT_ERROR;
}

const COMMANDS = ['platforms', 'smoke'] as const;
const USAGE = 'usage: imageSmoke.ts <platforms|smoke> --image <repo@digest> [--database-url <url>]';

/** The script's whole behaviour: argv in, an exit code out. */
export async function main(argv: string[], io: ImageIo, ports: ImagePorts): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    io.log(USAGE);
    return EXIT_ERROR;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        image: { type: 'string' },
        'database-url': { type: 'string' },
        'deadline-seconds': { type: 'string' },
      },
      strict: true,
    });
    if (!values.image) throw new Error('--image is required');
    if (command === 'platforms') return await checkPlatforms(ports, values.image, io);
    if (!values['database-url']) throw new Error('--database-url is required');
    const seconds = values['deadline-seconds'] ? Number(values['deadline-seconds']) : undefined;
    if (seconds !== undefined && !(seconds > 0))
      throw new Error('--deadline-seconds must be a positive number');
    return await smoke(
      ports,
      {
        image: values.image,
        databaseUrl: values['database-url'],
        deadlineMs: seconds ? seconds * 1000 : DEFAULT_DEADLINE_MS,
      },
      io,
    );
  } catch (err) {
    io.log(`::error::${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
}

/* v8 ignore start -- the production adapters: one call each, exercised by the deploy itself. */
export function processPorts(): ImagePorts {
  return {
    docker: (args) =>
      new Promise((resolve) => {
        const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err) =>
          resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }),
        );
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      }),
    httpStatus: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        await res.arrayBuffer();
        return res.status;
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

const isEntry =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  void main(
    process.argv.slice(2),
    { log: (line) => process.stderr.write(`${line}\n`) },
    processPorts(),
  ).then((code) => process.exit(code));
}
/* v8 ignore stop */
