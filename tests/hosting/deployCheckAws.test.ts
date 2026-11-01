// MOTIR-10011 — the operator deploy check on the AWS target, driven against the
// fake hosting deploy port built for `aws`. Pure: no database, no Docker, no AWS
// and no network. The command runner, the convergence and the page reads are
// recording stubs; the page stub answers as the fixture app would, from the
// image the fake's release runs.
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  awsReleaseImage,
  DEPLOY_CHECK_AWS_FIXTURE_DIR,
  DEPLOY_CHECK_AWS_MANIFEST,
  DEPLOY_CHECK_PAGE_ATTEMPTS,
  parseDeployCheckArgs,
  runDeployCheck,
  type DeployCheckDeps,
} from '@/lib/hosting/deployCheck';
import { parseHostingManifest } from '@/lib/hosting/manifest';
import {
  createFakeHostingDeployPort,
  deriveOriginSecret,
  type DeployReleaseInput,
  type HostingDeployPort,
  type ReleaseShape,
} from '@/lib/orchestrator';

const RID = 'cmcheck1';
const APP = `mh-${RID}`;
const NAMESPACE = `mh/${RID}/production`;
const KEY = 'aws-check-origin-key';
const ACCOUNT = '400000000901';
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const PUSH_ROLE = `arn:aws:iam::${ACCOUNT}:role/${APP}-production-push`;
const PASSWORD = 'ECR_PASSWORD_never_printed';
const ORG = 'org-check-1';

type Block = { label: string; fields: Record<string, unknown> };
type Exec = { command: string; args: readonly string[]; stdin?: string };

const base = (shape?: ReleaseShape) => [
  '--target',
  'aws',
  '--repository',
  RID,
  ...(shape ? ['--shape', shape] : []),
];
const full = (shape: ReleaseShape) => [
  ...base(shape),
  '--organization',
  ORG,
  '--aws-profile',
  'staging-tenant',
];

interface HarnessOptions {
  /** Answers a page read instead of the fixture stand-in. */
  readonly page?: (url: string) => Promise<Response>;
  /** The convergence outcome. */
  readonly outcome?: string;
  /** Throw from the command runner for this command line. */
  readonly failExec?: (exec: Exec) => boolean;
  /** Mint the fake's own (secret) credential instead of the federated one. */
  readonly secretCredential?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const fake = createFakeHostingDeployPort({ target: 'aws' });
  const calls: string[] = [];
  const deploys: DeployReleaseInput[] = [];
  const port = new Proxy(fake, {
    get(target, prop, receiver) {
      if (prop === 'mintDeployCredential' && !options.secretCredential) {
        return async ({ pushNamespace }: { pushNamespace: string }) => {
          calls.push('mintDeployCredential');
          return { kind: 'federated', pushNamespace, subject: PUSH_ROLE };
        };
      }
      if (prop === 'ensureApp') {
        // The AWS adapter's push namespace is the tenant ECR repository
        // `mh/<id>/production`, not the fake's app name.
        return async (input: Parameters<HostingDeployPort['ensureApp']>[0]) => {
          calls.push('ensureApp');
          const app = await target.ensureApp(input);
          return { ...app, pushNamespace: `mh/${input.repositoryId}/production` };
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        if (prop === 'deploy') deploys.push(args[0] as DeployReleaseInput);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as HostingDeployPort;

  const out: Block[] = [];
  const execs: Exec[] = [];
  const converged: string[] = [];
  const signed: string[] = [];
  const plain: Array<{ url: string; headers: Record<string, string> }> = [];
  const sleeps: number[] = [];

  /** The fixture app's answer, from the image the app's live release runs. */
  const fixture = async (url: string): Promise<Response> => {
    const { hostname, pathname } = new URL(url);
    const image = fake.app(hostname.split('.')[0]!)?.live?.image ?? '';
    const release = Number(/release-(\d)/.exec(image)?.[1] ?? 0);
    if (pathname === '/health') return Response.json({ ok: true, release });
    if (pathname === '/row') {
      return Response.json({ release, row: { id: 1, note: 'seeded by the fixture' } });
    }
    return new Response(null, { status: 404 });
  };
  const answer = options.page ?? fixture;

  const deps: DeployCheckDeps = {
    port: () => port,
    readManifest: (path) => {
      try {
        return readFileSync(resolve(process.cwd(), path), 'utf8');
      } catch {
        return null;
      }
    },
    print: (label, fields) => out.push({ label, fields }),
    fetch: async (url, init) => {
      plain.push({ url, headers: init.headers });
      const appRef = new URL(url).hostname.split('.')[0]!;
      const secret = init.headers['X-Motir-Origin-Secret'];
      if (secret !== deriveOriginSecret(KEY, appRef)) {
        return new Response(null, { status: 403, statusText: 'Forbidden' });
      }
      return answer(url);
    },
    originSecretKey: () => KEY,
    exec: async (command, args, opts) => {
      const exec: Exec = { command, args, ...(opts?.stdin ? { stdin: opts.stdin } : {}) };
      execs.push(exec);
      if (options.failExec?.(exec)) throw new Error(`${command} ${args[0]} exited 1`);
      if (args[0] === 'sts') return { stdout: `${ACCOUNT}\n` };
      if (args[1] === 'get-login-password') return { stdout: `${PASSWORD}\n` };
      if (args[0] === 'image') {
        const ref = args.at(-1)!;
        return { stdout: `${ref.slice(0, ref.lastIndexOf(':'))}@sha256:${ref.slice(-1)}abc\n` };
      }
      return { stdout: '' };
    },
    converge: async (organizationId) => {
      converged.push(organizationId);
      return options.outcome ?? 'changed';
    },
    signedFetch: async (url) => {
      signed.push(url);
      return answer(url);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const run = (...argv: string[]) => runDeployCheck(argv, deps);
  const block = (label: string) => out.findLast((b) => b.label === label)?.fields;
  const blocks = (label: string) => out.filter((b) => b.label === label).map((b) => b.fields);
  return {
    fake,
    calls,
    deploys,
    out,
    execs,
    converged,
    signed,
    plain,
    sleeps,
    deps,
    run,
    block,
    blocks,
  };
}

type Harness = ReturnType<typeof harness>;

/** Everything a run printed or handed to a command, as one string to scan. */
const collected = (h: Harness) =>
  JSON.stringify(h.out) + JSON.stringify(h.execs.map((e) => [e.command, ...e.args]));

describe('no shape', () => {
  it('no-shape prints the port’s refusal naming the shape, lists no release, creates nothing', async () => {
    const h = harness();
    expect(await h.run('no-shape', ...base())).toBe(1);
    expect(h.block('no-shape')).toEqual({ app: APP, releases: 'none' });
    expect(h.block('refused')).toEqual({
      error: 'HOSTING_SHAPE_REQUIRED',
      message: expect.stringMatching(/needs a release shape/),
    });
    expect(h.calls).toEqual(['deploy', 'listReleases']);
    expect(h.fake.app(APP)).toBeUndefined();

    expect(await h.run('status', ...base())).toBe(0);
    expect(h.block('status')).toEqual({ app: APP, state: 'none', servingReleaseId: null });
  });

  it('deploy with no --shape is refused by the port the same way, without asking for the app', async () => {
    const h = harness();
    expect(await h.run('deploy', ...base())).toBe(1);
    expect(h.block('refused')).toMatchObject({ error: 'HOSTING_SHAPE_REQUIRED' });
    expect(h.calls).toEqual(['deploy']);
    expect(h.fake.app(APP)).toBeUndefined();
  });

  it('no-shape fails when the port accepts the release', async () => {
    const h = harness();
    const lenient = createFakeHostingDeployPort({ target: 'fly', appPrefix: 'mh-' });
    await lenient.ensureApp({ repositoryId: RID, environment: { kind: 'production' } });
    const code = await runDeployCheck(['no-shape', ...base()], { ...h.deps, port: () => lenient });
    expect(code).toBe(1);
    expect(h.block('no-shape')).toEqual({ app: APP, releases: 'rel-1' });
    expect(h.block('refused')).toMatchObject({ error: 'DEPLOY_CHECK_SHAPE_NOT_REFUSED' });
  });

  it('no-shape with --shape is a usage refusal, with no port call', async () => {
    const h = harness();
    expect(await h.run('no-shape', ...base('function'))).toBe(1);
    expect(h.block('refused')).toMatchObject({
      error: 'DEPLOY_CHECK_USAGE',
      message: expect.stringMatching(/no-shape runs without --shape/),
    });
    expect(h.calls).toEqual([]);
  });
});

describe.each([
  {
    shape: 'function' as const,
    host: `${APP}.lambda-url.fake.invalid`,
    credential: 'aws_sigv4',
    unit: 'lambda',
  },
  {
    shape: 'container' as const,
    host: `${APP}.alb.fake.invalid`,
    credential: 'origin_secret',
    unit: 'fargate',
  },
])('all, $shape shape', ({ shape, host, credential, unit }) => {
  it('runs converge, push, deploy, page, release2, page, rollback, page, destroy on mh-<id>', async () => {
    const h = harness();
    expect(await h.run('all', ...full(shape))).toBe(0);
    expect(h.out.map((b) => b.label)).toEqual([
      'converge',
      'push',
      'deploy',
      'page',
      'release2',
      'page',
      'rollback',
      'page',
      'destroy',
      'destroyApp',
    ]);
    expect(h.converged).toEqual([ORG]);

    const deployed = h.block('deploy')!;
    expect(deployed).toMatchObject({
      app: APP,
      shape,
      release: 1,
      state: 'healthy',
      address: `https://${host}`,
      originCredential: credential,
    });
    expect(String(deployed['address'])).toMatch(/^https:\/\//);

    const pages = h.blocks('page');
    expect(pages.map((p) => p['release'])).toEqual([1, 2, 1]);
    for (const page of pages) {
      expect(page).toMatchObject({
        app: APP,
        address: `https://${host}`,
        originCredential: credential,
        health: '200',
        row: '200',
      });
      expect(JSON.parse(String(page['data']))).toEqual({ id: 1, note: 'seeded by the fixture' });
    }
    expect(h.block('release2')!['releaseId']).not.toBe(deployed['releaseId']);
    expect(pages[1]!['servingReleaseId']).toBe(h.block('release2')!['releaseId']);
    expect(pages[2]!['servingReleaseId']).toBe(deployed['releaseId']);

    // Every page read went through the release's own credential.
    const paths = [`https://${host}/health`, `https://${host}/row`];
    if (credential === 'aws_sigv4') {
      expect(h.signed).toEqual([...paths, ...paths, ...paths]);
      expect(h.plain).toEqual([]);
    } else {
      expect(h.signed).toEqual([]);
      expect(h.plain.map((r) => r.url)).toEqual([...paths, ...paths, ...paths]);
      for (const r of h.plain) {
        expect(r.headers).toEqual({ 'X-Motir-Origin-Secret': deriveOriginSecret(KEY, APP) });
      }
    }

    // Always on: a container refuses `suspend`, a function idles either way.
    expect(h.deploys.map((d) => [d.shape, d.idle])).toEqual([
      [shape, { mode: 'always_on' }],
      [shape, { mode: 'always_on' }],
    ]);

    const compute = JSON.parse(String(h.block('destroy')!['compute'])) as { unit: string };
    expect(compute.unit).toBe(unit);
    expect(JSON.parse(String(h.block('destroy')!['usage']))).toMatchObject({
      appRef: APP,
      compute: { unit },
    });
    expect(h.block('destroyApp')).toEqual({ app: APP, usage: '[]', releases: '[]' });
    expect(h.fake.app(APP)).toBeUndefined();
  });

  it('rolls back to release 1 with no push and no build', async () => {
    const h = harness();
    const flags = full(shape);
    expect(await h.run('push', ...flags)).toBe(0);
    expect(await h.run('deploy', ...flags)).toBe(0);
    expect(await h.run('release2', ...flags)).toBe(0);
    expect(h.block('page')).toMatchObject({ release: 2 });

    const execsBefore = h.execs.length;
    expect(await h.run('rollback', ...flags)).toBe(0);
    expect(h.execs.length).toBe(execsBefore);
    expect(h.block('page')).toMatchObject({ release: 1 });
    expect(h.fake.app(APP)?.live?.image).toBe(`${NAMESPACE}:release-1`);
  });
});

describe('deploy', () => {
  it('defaults each release to its pushed tag under mh/<id>/production', async () => {
    const h = harness();
    expect(await h.run('deploy', ...base('function'))).toBe(0);
    expect(h.calls.slice(0, 2)).toEqual(['ensureApp', 'deploy']);
    expect(h.fake.app(APP)?.live?.image).toBe(`${NAMESPACE}:release-1`);
    expect(h.deploys[0]!.runtime.database.kind).toBe('postgres');
    expect(await h.run('release2', ...base('function'))).toBe(0);
    expect(h.fake.app(APP)?.live?.image).toBe(`${NAMESPACE}:release-2`);
    expect(awsReleaseImage(RID, 2)).toBe(`${NAMESPACE}:release-2`);
  });

  it('takes --image over the pushed tag', async () => {
    const h = harness();
    expect(await h.run('deploy', ...base('container'), '--image', 'example.invalid/x:7')).toBe(0);
    expect(h.fake.app(APP)?.live?.image).toBe('example.invalid/x:7');
  });
});

describe('destroy', () => {
  it('with no release prints zero usage and exits 0', async () => {
    const h = harness();
    expect(await h.run('destroy', ...base('function'))).toBe(0);
    expect(h.block('destroy')).toEqual({
      app: APP,
      usage: 'none (no release)',
      compute: 'none',
    });
    expect(h.block('destroyApp')).toEqual({ app: APP, usage: '[]', releases: '[]' });
  });
});

describe('push', () => {
  it('prints the CI push role, logs in with the operator’s profile over stdin, pushes both tags', async () => {
    const h = harness();
    expect(await h.run('push', ...full('function'))).toBe(0);
    expect(h.block('push')).toEqual({
      app: APP,
      pushNamespace: NAMESPACE,
      pushesInCiAs: PUSH_ROLE,
      registry: REGISTRY,
      release1: `${REGISTRY}/${NAMESPACE}@sha256:1abc`,
      release2: `${REGISTRY}/${NAMESPACE}@sha256:2abc`,
    });
    const profile = ['--region', 'us-east-1', '--profile', 'staging-tenant'];
    expect(h.execs).toEqual([
      {
        command: 'aws',
        args: ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text', ...profile],
      },
      { command: 'aws', args: ['ecr', 'get-login-password', ...profile] },
      {
        command: 'docker',
        args: ['login', '--username', 'AWS', '--password-stdin', REGISTRY],
        stdin: PASSWORD,
      },
      ...([1, 2] as const).flatMap((n) => {
        const ref = `${REGISTRY}/${NAMESPACE}:release-${n}`;
        return [
          {
            command: 'docker',
            args: [
              'build',
              '--platform',
              'linux/amd64',
              '--provenance=false',
              '--build-arg',
              `RELEASE=${n}`,
              '--tag',
              ref,
              DEPLOY_CHECK_AWS_FIXTURE_DIR,
            ],
          },
          { command: 'docker', args: ['push', ref] },
          {
            command: 'docker',
            args: ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', ref],
          },
        ];
      }),
    ]);
    expect(h.calls).toEqual(['ensureApp', 'mintDeployCredential']);
    expect(collected(h)).not.toContain(PASSWORD);
  });

  it('never prints a secret push credential’s value', async () => {
    const h = harness({ secretCredential: true });
    expect(await h.run('push', ...full('container'))).toBe(0);
    expect(h.block('push')).toMatchObject({ pushesInCiAs: 'secret credential' });
    expect(collected(h)).not.toContain('fake-deploy-token');
  });

  it('a failed push is refused by command name, with no secret in the refusal', async () => {
    const h = harness({ failExec: (e) => e.args[0] === 'push' });
    expect(await h.run('push', ...full('function'))).toBe(1);
    expect(h.block('refused')).toEqual({ error: 'Error', message: 'docker push exited 1' });
    expect(collected(h)).not.toContain(PASSWORD);
  });

  it('needs --aws-profile, refused before any port call', async () => {
    const h = harness();
    expect(await h.run('push', ...base('function'))).toBe(1);
    expect(h.block('refused')).toMatchObject({ message: expect.stringMatching(/--aws-profile/) });
    expect(h.calls).toEqual([]);
    expect(h.execs).toEqual([]);
  });
});

describe('converge', () => {
  it('prints the outcome name only', async () => {
    const h = harness({ outcome: 'unchanged' });
    expect(await h.run('converge', ...full('function'))).toBe(0);
    expect(h.block('converge')).toEqual({ organization: ORG, outcome: 'unchanged' });
    expect(h.calls).toEqual([]);
  });

  it.each(['not_ready', 'failed'])('fails on %s', async (outcome) => {
    const h = harness({ outcome });
    expect(await h.run('converge', ...full('function'))).toBe(1);
    expect(h.block('refused')).toMatchObject({
      error: 'DEPLOY_CHECK_CONVERGE_FAILED',
      message: expect.stringContaining(outcome),
    });
  });

  it('needs --organization', async () => {
    const h = harness();
    expect(await h.run('converge', ...base('function'))).toBe(1);
    expect(h.block('refused')).toMatchObject({ message: expect.stringMatching(/--organization/) });
    expect(h.converged).toEqual([]);
  });
});

describe('page', () => {
  it('retries a waking release and its database, then reads the row', async () => {
    let calls = 0;
    const h = harness({
      page: async (url) => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        if (calls === 2) return new Response(null, { status: 503 });
        return url.endsWith('/row')
          ? Response.json({ release: 1, row: { id: 1 } })
          : new Response('ok', { status: 200, statusText: 'OK' });
      },
    });
    await h.run('deploy', ...base('function'));
    expect(await h.run('page', ...base('function'))).toBe(0);
    expect(h.sleeps).toEqual([5000, 5000]);
    expect(h.block('page')).toMatchObject({ health: '200 OK', release: 1, data: '{"id":1}' });
  });

  it('fails when health stays 5xx after every attempt', async () => {
    const h = harness({ page: async () => new Response(null, { status: 502 }) });
    await h.run('deploy', ...base('function'));
    expect(await h.run('page', ...base('function'))).toBe(1);
    expect(h.signed.length).toBe(DEPLOY_CHECK_PAGE_ATTEMPTS * 2);
    expect(h.block('refused')).toMatchObject({
      error: 'DEPLOY_CHECK_PAGE_FAILED',
      message: expect.stringMatching(/health answered 502/),
    });
  });

  it('fails when the release cannot be reached at all', async () => {
    const h = harness({
      page: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    await h.run('deploy', ...base('function'));
    expect(await h.run('page', ...base('function'))).toBe(1);
    expect(h.block('refused')).toMatchObject({ message: 'getaddrinfo ENOTFOUND' });
  });

  it.each([
    ['no row', () => Response.json({ release: 1, row: null })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
    ['a JSON scalar', () => Response.json(7)],
    ['a refusal', () => new Response(null, { status: 404 })],
  ])('fails on %s from /row', async (_, row) => {
    const h = harness({
      page: async (url) => (url.endsWith('/row') ? row() : new Response('ok', { status: 200 })),
    });
    await h.run('deploy', ...base('container'));
    expect(await h.run('page', ...base('container'))).toBe(1);
    expect(h.block('page')).toMatchObject({ health: '200', data: 'null' });
    expect(h.block('refused')).toMatchObject({ message: expect.stringMatching(/no row/) });
  });

  it('fails when nothing is served, reading nothing', async () => {
    const h = harness();
    expect(await h.run('page', ...base('function'))).toBe(1);
    expect(h.block('page')).toEqual({ app: APP, state: 'none' });
    expect(h.signed).toEqual([]);
  });

  it('a release with no origin credential is read with no header', async () => {
    const h = harness();
    await h.run('deploy', ...base('container'));
    const withNone: HostingDeployPort = {
      ...h.fake,
      describe: async (handle) => ({
        ...(await h.fake.describe(handle)),
        originCredential: 'none',
      }),
    };
    const code = await runDeployCheck(['page', ...base('container')], {
      ...h.deps,
      port: () => withNone,
    });
    expect(code).toBe(1);
    expect(h.plain.map((r) => r.headers)).toEqual([{}, {}]);
  });
});

describe('refusals', () => {
  it.each([
    [['deploy', '--target', 'aws'], /--target aws needs --repository/],
    [
      ['deploy', ...base(), '--name', 'motir-deploy-check-x'],
      /--name is refused with --target aws/,
    ],
    [['deploy', ...base(), '--shape', 'lambda'], /--shape is function or container/],
    [['deploy', '--target', 'gcp'], /--target is fly or aws/],
    [['deploy', '--repository', RID], /--repository is for --target aws only/],
    [['push'], /push runs with --target aws only/],
    [['no-shape'], /no-shape runs with --target aws only/],
    [['all', ...base('function'), '--aws-profile', 'p'], /all needs --organization/],
    [['all', ...base('function'), '--organization', ORG], /all needs --aws-profile/],
  ])('%j is refused by name with no port call', async (argv, message) => {
    const h = harness();
    expect(await h.run(...argv)).toBe(1);
    expect(h.block('refused')).toMatchObject({ message: expect.stringMatching(message) });
    expect(h.calls).toEqual([]);
    expect(h.converged).toEqual([]);
  });

  it('a step whose dependency was not wired names it', async () => {
    const h = harness();
    const { exec: _exec, ...unwired } = h.deps;
    expect(await runDeployCheck(['push', ...full('function')], unwired)).toBe(1);
    expect(h.block('refused')).toMatchObject({
      message: 'The deploy check was started without its exec.',
    });
  });

  it('parses the AWS options, defaulting the manifest and the image', () => {
    expect(parseDeployCheckArgs(['all', ...full('container')])).toEqual({
      step: 'all',
      options: {
        manifestPath: DEPLOY_CHECK_AWS_MANIFEST,
        appName: APP,
        image: `${NAMESPACE}:release-1`,
        aws: {
          repositoryId: RID,
          shape: 'container',
          organizationId: ORG,
          awsProfile: 'staging-tenant',
          image: null,
        },
      },
    });
  });
});

describe('the fixture app and its manifest', () => {
  type FixtureModule = {
    createFixtureServer: (input: {
      release: string;
      query: (sql: string) => Promise<{ rows: unknown[] }>;
    }) => Server;
  };
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });

  /** A one-table stand-in for `pg`: the fixture's three statements, nothing else. */
  function stubDatabase() {
    const statements: string[] = [];
    let table: Array<{ id: number; note: string }> | null = null;
    let failNext = false;
    const query = async (sql: string) => {
      statements.push(sql.split(' ').slice(0, 2).join(' '));
      if (failNext) {
        failNext = false;
        throw new Error('postgres://user:pw@db/app is resuming');
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS deploy_check')) table ??= [];
      else if (sql.startsWith('INSERT INTO deploy_check')) {
        if (table!.length === 0) table!.push({ id: 1, note: 'seeded by the deploy check fixture' });
      } else if (sql.startsWith('SELECT')) return { rows: table!.slice(0, 1) };
      return { rows: [] };
    };
    return { statements, query, failOnce: () => (failNext = true) };
  }

  async function start(database: ReturnType<typeof stubDatabase>): Promise<string> {
    const path = resolve(process.cwd(), DEPLOY_CHECK_AWS_FIXTURE_DIR, 'server.mjs');
    const { createFixtureServer } = (await import(pathToFileURL(path).href)) as FixtureModule;
    server = createFixtureServer({ release: '2', query: database.query });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves /health and the same single seeded row on every /row', async () => {
    const database = stubDatabase();
    const url = await start(database);
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    const first = (await (await fetch(`${url}/row`)).json()) as unknown;
    const second = (await (await fetch(`${url}/row`)).json()) as unknown;
    const row = { id: 1, note: 'seeded by the deploy check fixture' };
    expect(first).toEqual({ release: '2', row });
    expect(second).toEqual(first);
    expect(database.statements).toEqual([
      'CREATE TABLE',
      'INSERT INTO',
      'SELECT id,',
      'SELECT id,',
    ]);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/row`, { method: 'POST' })).status).toBe(405);
  });

  it('answers 503 without the connection string while the database wakes, then seeds', async () => {
    const database = stubDatabase();
    const url = await start(database);
    database.failOnce();
    const waking = await fetch(`${url}/row`);
    expect(waking.status).toBe(503);
    expect(await waking.text()).not.toContain('postgres://');
    expect(await (await fetch(`${url}/row`)).json()).toMatchObject({ row: { id: 1 } });
  });

  it('its manifest parses, targets aws and declares Postgres with a migrate command', () => {
    const manifest = parseHostingManifest(readFileSync(DEPLOY_CHECK_AWS_MANIFEST, 'utf8'));
    expect(manifest.targets).toEqual(['aws']);
    expect(manifest.healthCheck.path).toBe('/health');
    expect(manifest.database).toMatchObject({ kind: 'postgres', migrateCommand: 'true' });
  });
});

describe('the AWS SDK stays behind the orchestrator package', () => {
  it.each([
    'lib/hosting/deployCheck.ts',
    'scripts/hosting-deploy-check.ts',
    'tests/hosting/deployCheck.test.ts',
    'tests/hosting/deployCheckAws.test.ts',
  ])('%s imports no @aws-sdk package', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(/from '@aws-sdk\//);
  });
});
