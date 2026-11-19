import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEADLINE_MS,
  EXIT_ERROR,
  EXIT_OK,
  POLL_MS,
  RELAY_PORT,
  RELAY_PRISMA_FAILURE,
  REQUIRED_PLATFORMS,
  SERVICES,
  WEB_PORT,
  WORKER_STARTED,
  checkPlatforms,
  childRef,
  containerName,
  main,
  missingPlatforms,
  parseIndex,
  runArgs,
  smoke,
  smokeEnvironment,
  smokePlatform,
  type CommandResult,
  type ImagePorts,
} from '../../scripts/aws-deploy/imageSmoke';

// MOTIR-11718: the deploy pushes ONE image index for linux/amd64 and
// linux/arm64, and proves each child starts web, worker and relay against a
// database before any service rolls onto it.

const REPO = '944842271421.dkr.ecr.eu-central-1.amazonaws.com/motir/motir-core';
const IMAGE = `${REPO}@sha256:index`;
const DB = 'postgresql://prodect:prodect@127.0.0.1:5432/prodect';
const AMD = 'sha256:amd64child';
const ARM = 'sha256:arm64child';

function index(manifests: unknown[]): string {
  return JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests });
}

const BOTH = index([
  { digest: AMD, platform: { os: 'linux', architecture: 'amd64' } },
  { digest: ARM, platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
  {
    digest: 'sha256:att1',
    platform: { os: 'unknown', architecture: 'unknown' },
    annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
  },
]);

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): CommandResult => ({ code, stdout: '', stderr });

interface FakeOpts {
  /** `imagetools inspect --raw` answer. */
  manifest?: CommandResult;
  /** Per-command overrides, matched on the joined argv; first match wins. */
  rules?: [RegExp, CommandResult | ((n: number) => CommandResult)][];
  /** HTTP statuses per URL, answered in order (the last repeats). */
  http?: Record<string, (number | null)[]>;
}

function fakePorts(opts: FakeOpts = {}) {
  const calls: string[][] = [];
  const counts = new Map<string, number>();
  const httpCalls: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const http = new Map(Object.entries(opts.http ?? {}));
  const archFor = (argv: string): string => (argv.includes('linux/arm64') ? 'arm64\n' : 'x64\n');
  const ports: ImagePorts = {
    docker: async (args) => {
      calls.push([...args]);
      const argv = args.join(' ');
      for (const [re, res] of opts.rules ?? []) {
        if (re.test(argv)) {
          const n = (counts.get(re.source) ?? 0) + 1;
          counts.set(re.source, n);
          return typeof res === 'function' ? res(n) : res;
        }
      }
      if (argv.startsWith('buildx imagetools inspect')) return opts.manifest ?? ok(BOTH);
      if (argv.includes('process.arch')) return ok(archFor(argv));
      if (argv.startsWith('inspect --format')) return ok('true\n');
      if (argv.startsWith('logs ') && argv.endsWith('-worker'))
        return ok(`${WORKER_STARTED} as w-1\n`);
      if (argv.startsWith('logs ')) return ok('listening\n');
      return ok();
    },
    httpStatus: async (url) => {
      httpCalls.push(url);
      const queue = http.get(url);
      if (!queue) return 200;
      return queue.length > 1 ? (queue.shift() as number | null) : (queue[0] ?? null);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { ports, calls, httpCalls, sleeps };
}

function collect() {
  const lines: string[] = [];
  return { io: { log: (l: string) => lines.push(l) }, lines };
}

const WEB_URL = `http://127.0.0.1:${WEB_PORT}/api/health/ready`;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}/healthz`;

describe('parseIndex', () => {
  it('lists the platform children and leaves attestation entries out', () => {
    expect(parseIndex(BOTH)).toEqual([
      { platform: 'linux/amd64', digest: AMD },
      { platform: 'linux/arm64', digest: ARM },
    ]);
  });

  it('keeps a non-arm64 variant and drops an entry annotated as an attestation', () => {
    const raw = index([
      { digest: 'sha256:v7', platform: { os: 'linux', architecture: 'arm', variant: 'v7' } },
      {
        digest: 'sha256:att',
        platform: { os: 'linux', architecture: 'amd64' },
        annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
      },
      { platform: { os: 'linux', architecture: 'amd64' } },
      { digest: 'sha256:noplat' },
    ]);
    expect(parseIndex(raw)).toEqual([{ platform: 'linux/arm/v7', digest: 'sha256:v7' }]);
  });

  it('refuses a single-platform manifest — the push this card retires', () => {
    expect(() =>
      parseIndex(
        JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', layers: [] }),
      ),
    ).toThrow(/single manifest \(application\/vnd\.oci\.image\.manifest\.v1\+json\)/);
    expect(() => parseIndex('{}')).toThrow(/no mediaType/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseIndex('not json')).toThrow(/not JSON/);
  });
});

describe('missingPlatforms / childRef / runArgs', () => {
  it('names the required platforms an index lacks', () => {
    expect(missingPlatforms(parseIndex(BOTH))).toEqual([]);
    expect(missingPlatforms([{ platform: 'linux/amd64', digest: AMD }])).toEqual(['linux/arm64']);
    expect(REQUIRED_PLATFORMS).toEqual(['linux/amd64', 'linux/arm64']);
  });

  it('addresses a child by digest whatever the index was addressed by', () => {
    expect(childRef(IMAGE, ARM)).toBe(`${REPO}@${ARM}`);
    expect(childRef(`${REPO}:abc123`, ARM)).toBe(`${REPO}@${ARM}`);
    expect(childRef('localhost:5000/motir-core', ARM)).toBe(`localhost:5000/motir-core@${ARM}`);
    expect(childRef('localhost:5000/motir-core:tag', ARM)).toBe(`localhost:5000/motir-core@${ARM}`);
  });

  it('starts each service as the task definitions do, on its own port', () => {
    const env = smokeEnvironment(DB);
    expect(env.DATABASE_URL).toBe(DB);
    expect(env.DATABASE_URL_UNPOOLED).toBe(DB);
    expect(SERVICES.map((s) => s.entrypoint)).toEqual([
      '/app/server.js',
      '/app/worker/worker.mjs',
      '/app/relay/relay.mjs',
    ]);
    const web = runArgs('r@d', 'linux/arm64', SERVICES[0]!, env);
    expect(web.slice(0, 8)).toEqual([
      'run',
      '--detach',
      '--name',
      'image-smoke-linux-arm64-web',
      '--network',
      'host',
      '--platform',
      'linux/arm64',
    ]);
    expect(web).toContain(`PORT=${WEB_PORT}`);
    expect(web.slice(-3)).toEqual(['r@d', 'node', '/app/server.js']);
    const worker = runArgs('r@d', 'linux/amd64', SERVICES[1]!, env);
    expect(worker.some((a) => a.startsWith('PORT='))).toBe(false);
    expect(containerName('linux/amd64', 'relay')).toBe('image-smoke-linux-amd64-relay');
  });
});

describe('checkPlatforms', () => {
  it('passes an index listing both CPUs', async () => {
    const { ports } = fakePorts();
    const { io, lines } = collect();
    expect(await checkPlatforms(ports, IMAGE, io)).toBe(EXIT_OK);
    expect(lines).toContain(`linux/arm64  ${ARM}`);
  });

  it('fails an index without arm64', async () => {
    const { ports } = fakePorts({
      manifest: ok(index([{ digest: AMD, platform: { os: 'linux', architecture: 'amd64' } }])),
    });
    const { io, lines } = collect();
    expect(await checkPlatforms(ports, IMAGE, io)).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toMatch(/::error::.*lists no linux\/arm64 image/);
  });

  it('throws when the manifest cannot be read', async () => {
    const { ports } = fakePorts({ manifest: fail('denied') });
    await expect(checkPlatforms(ports, IMAGE, collect().io)).rejects.toThrow(/denied/);
    const silent = fakePorts({ manifest: fail('', 2) });
    await expect(checkPlatforms(silent.ports, IMAGE, collect().io)).rejects.toThrow(/exit 2/);
  });
});

const ARM_OPTS = {
  image: IMAGE,
  platform: 'linux/arm64',
  digest: ARM,
  databaseUrl: DB,
  deadlineMs: 30_000,
};

describe('smokePlatform', () => {
  it('pulls the child by digest, proves the CPU, migrates, starts all three and cleans up', async () => {
    const { ports, calls } = fakePorts();
    const { io, lines } = collect();
    const result = await smokePlatform(ports, ARM_OPTS, io);
    expect(result).toEqual({ ok: true, problems: [] });
    const argvs = calls.map((c) => c.join(' '));
    expect(argvs[0]).toBe(`pull --quiet ${REPO}@${ARM}`);
    expect(argvs[1]).toContain('--platform linux/arm64');
    expect(argvs.some((a) => a.endsWith('node /app/migrate/release-migrate.mjs'))).toBe(true);
    for (const entry of ['/app/server.js', '/app/worker/worker.mjs', '/app/relay/relay.mjs']) {
      expect(argvs.some((a) => a.startsWith('run --detach') && a.endsWith(`node ${entry}`))).toBe(
        true,
      );
    }
    expect(argvs.at(-1)).toBe(
      'rm --force image-smoke-linux-arm64-web image-smoke-linux-arm64-worker image-smoke-linux-arm64-relay',
    );
    expect(lines).toContain('linux/arm64: node runs as arm64');
    expect(lines).toContain('linux/arm64: worker started its claim loop');
  });

  it('polls until the services answer', async () => {
    const { ports, sleeps } = fakePorts({
      http: { [WEB_URL]: [null, 503, 200], [RELAY_URL]: [null, 200] },
    });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([POLL_MS, POLL_MS]);
  });

  it('fails when the pull fails, before starting anything', async () => {
    const { ports, calls } = fakePorts({ rules: [[/^pull /, fail('manifest unknown')]] });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result).toEqual({ ok: false, problems: ['linux/arm64: pull failed: manifest unknown'] });
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
  });

  it('fails a child that runs as the wrong CPU', async () => {
    const { ports } = fakePorts({ rules: [[/process\.arch/, ok('x64\n')]] });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result.problems).toEqual([
      `linux/arm64: the container reports process.arch 'x64' (want 'arm64')`,
    ]);
  });

  it('fails a child whose node cannot execute', async () => {
    const { ports } = fakePorts({ rules: [[/process\.arch/, fail('exec format error', 126)]] });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result.problems[0]).toMatch(/process\.arch '' \(want 'arm64'\): exec format error/);
  });

  it('fails when migrations fail, with their last lines', async () => {
    const { ports } = fakePorts({
      rules: [
        [
          /release-migrate/,
          { code: 1, stdout: 'Applying…\n', stderr: 'Error: P1001 cannot reach\n' },
        ],
      ],
    });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result.problems[0]).toMatch(/migrations failed:\nApplying…\nError: P1001 cannot reach/);
  });

  it('fails a service that does not start, and removes those that did', async () => {
    const { ports, calls } = fakePorts({
      rules: [[/run --detach .*worker\.mjs$/, fail('no such image')]],
    });
    const { io, lines } = collect();
    const result = await smokePlatform(ports, ARM_OPTS, io);
    expect(result.problems).toEqual(['linux/arm64: worker did not start: no such image']);
    expect(calls.at(-1)).toEqual(['rm', '--force', 'image-smoke-linux-arm64-web']);
    expect(lines).toContain('── image-smoke-linux-arm64-web: last log lines');
  });

  it('fails a service that exits before it answers and prints its logs', async () => {
    const { ports } = fakePorts({
      rules: [
        [/^inspect .*-relay$/, ok('false\n')],
        [
          /^logs .*-relay$/,
          { code: 0, stdout: '', stderr: `Error: Cannot find module '/app/relay/x.node'\n` },
        ],
      ],
      http: { [RELAY_URL]: [null] },
    });
    const { io, lines } = collect();
    const result = await smokePlatform(ports, ARM_OPTS, io);
    expect(result.problems).toEqual(['linux/arm64: relay exited before it answered']);
    expect(lines).toContain(`Error: Cannot find module '/app/relay/x.node'`);
  });

  it('fails a service that never answers within the deadline', async () => {
    const { ports } = fakePorts({
      http: { [WEB_URL]: [503] },
      rules: [[/^logs .*-worker$/, ok('booting\n')]],
    });
    const result = await smokePlatform(ports, { ...ARM_OPTS, deadlineMs: 9_000 }, collect().io);
    expect(result.problems).toEqual([
      'linux/arm64: web did not answer within 9s',
      'linux/arm64: worker did not answer within 9s',
    ]);
  });

  it('fails when the relay logged its Prisma start-up failure', async () => {
    const { ports } = fakePorts({
      rules: [[/^logs .*-relay$/, ok(`[relay] ${RELAY_PRISMA_FAILURE}\n`)]],
    });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result.problems).toEqual([
      `linux/arm64: the relay's start-up Prisma write failed (${RELAY_PRISMA_FAILURE})`,
    ]);
  });

  it('fails a service that stops after it answered', async () => {
    const { ports } = fakePorts({
      rules: [[/^inspect .*-worker$/, (n) => ok(n === 1 ? 'true' : 'false')]],
    });
    const result = await smokePlatform(ports, ARM_OPTS, collect().io);
    expect(result.problems).toEqual(['linux/arm64: worker stopped after it answered']);
  });
});

describe('smoke', () => {
  it('runs both platforms, amd64 first', async () => {
    const { ports, calls } = fakePorts();
    const { io, lines } = collect();
    expect(await smoke(ports, { image: IMAGE, databaseUrl: DB, deadlineMs: 1000 }, io)).toBe(
      EXIT_OK,
    );
    const pulls = calls.filter((c) => c[0] === 'pull').map((c) => c[2]);
    expect(pulls).toEqual([`${REPO}@${AMD}`, `${REPO}@${ARM}`]);
    expect(lines).toContain('linux/amd64: web, worker and relay are up against the database');
    expect(lines).toContain('linux/arm64: web, worker and relay are up against the database');
  });

  it('still smokes arm64 when amd64 fails, and reports both', async () => {
    const { ports, calls } = fakePorts({ rules: [[/^pull .*amd64child/, fail('gone')]] });
    const { io, lines } = collect();
    expect(await smoke(ports, { image: IMAGE, databaseUrl: DB, deadlineMs: 1000 }, io)).toBe(
      EXIT_ERROR,
    );
    expect(calls.filter((c) => c[0] === 'pull')).toHaveLength(2);
    expect(lines).toContain('::error::linux/amd64: pull failed: gone');
  });

  it('refuses an index missing a platform without pulling', async () => {
    const { ports, calls } = fakePorts({
      manifest: ok(index([{ digest: ARM, platform: { os: 'linux', architecture: 'arm64' } }])),
    });
    const { io, lines } = collect();
    expect(await smoke(ports, { image: IMAGE, databaseUrl: DB, deadlineMs: 1000 }, io)).toBe(
      EXIT_ERROR,
    );
    expect(lines.join('\n')).toMatch(/lists no linux\/amd64 image/);
    expect(calls.some((c) => c[0] === 'pull')).toBe(false);
  });
});

describe('main', () => {
  it('prints usage for no or an unknown command', async () => {
    for (const argv of [[], ['deploy']]) {
      const { io, lines } = collect();
      expect(await main(argv, io, fakePorts().ports)).toBe(EXIT_ERROR);
      expect(lines[0]).toMatch(/^usage:/);
    }
  });

  it('runs platforms', async () => {
    expect(await main(['platforms', '--image', IMAGE], collect().io, fakePorts().ports)).toBe(
      EXIT_OK,
    );
  });

  it('runs smoke with the default deadline and with one given', async () => {
    const { ports, sleeps } = fakePorts({ http: { [WEB_URL]: [null] } });
    const { lines } = collect();
    const code = await main(
      ['smoke', '--image', IMAGE, '--database-url', DB, '--deadline-seconds', '6'],
      { log: (l) => lines.push(l) },
      ports,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(lines.join('\n')).toMatch(/web did not answer within 6s/);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(
      await main(
        ['smoke', '--image', IMAGE, '--database-url', DB],
        collect().io,
        fakePorts().ports,
      ),
    ).toBe(EXIT_OK);
    expect(DEFAULT_DEADLINE_MS).toBe(600_000);
  });

  it('reports missing or bad flags as an error line', async () => {
    const cases: [string[], RegExp][] = [
      [['platforms'], /--image is required/],
      [['smoke', '--image', IMAGE], /--database-url is required/],
      [
        ['smoke', '--image', IMAGE, '--database-url', DB, '--deadline-seconds', '0'],
        /positive number/,
      ],
      [
        ['smoke', '--image', IMAGE, '--database-url', DB, '--deadline-seconds', 'soon'],
        /positive number/,
      ],
      [['platforms', '--image', IMAGE, '--bogus'], /Unknown option/],
    ];
    for (const [argv, message] of cases) {
      const { io, lines } = collect();
      expect(await main(argv, io, fakePorts().ports)).toBe(EXIT_ERROR);
      expect(lines.join('\n')).toMatch(message);
    }
  });

  it('turns a thrown non-Error into an error line', async () => {
    const ports = fakePorts().ports;
    ports.docker = async () => {
      throw 'socket closed';
    };
    const { io, lines } = collect();
    expect(await main(['platforms', '--image', IMAGE], io, ports)).toBe(EXIT_ERROR);
    expect(lines).toEqual(['::error::socket closed']);
  });
});
