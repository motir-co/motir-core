import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NoPreviousReleaseError,
  OrchestratorApiError,
  createFakeDatabasePort,
  createNeonDatabasePort,
  type DatabasePort,
  type DeployReleaseInput,
  type HostingEnvironment,
  type ReleaseEnvVar,
} from '../src/index';
import {
  ADAPTERS,
  IMAGE,
  START,
  serverlessHarness,
  type HostingHarness,
} from './contract/hostingHarnesses';
import { NEON_SIM_KEY, NEON_SIM_ORG, createNeonApiSim, uriOf } from './contract/neonApiSim';
import {
  declaredTypesOf,
  importsOf,
  scanPortBoundary,
  type BoundaryRule,
  type SourceText,
} from './portBoundary';

// THE STORY TEST GATE of the serverless adapter story (MOTIR-9793 · MOTIR-9976):
// the properties that hold only ACROSS its cards, asserted from outside the
// adapter folders, with simulators and scripted APIs and no network. Each
// adapter's own suite proves its own cases; this file proves that one deploy
// contract covers all three deploy adapters, that the two database ports
// agree, that no destroy ends without usage, that no secret leaks out of a
// whole lifecycle, and that no provider type crosses the port. The app-side half
// (the composition roots) is `tests/orchestrator/storyGate.accessor.test.ts`.

const ROOT = resolve(__dirname, '../../..');
const R = 'cmgate1';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const NEON_CONFIG = { apiKey: NEON_SIM_KEY, orgId: NEON_SIM_ORG, region: 'aws-us-east-1' };

function releaseOf(
  h: HostingHarness,
  appRef: string,
  marker: string,
  env: readonly ReleaseEnvVar[] = [],
): DeployReleaseInput {
  return {
    appRef,
    environment: PRODUCTION,
    // Another digest per marker: the serverless target publishes nothing new
    // for an image it already runs.
    artifact: { kind: 'image', ref: (h.image ?? IMAGE).ref, digest: `sha256:${marker}` },
    runtime: {
      port: 8080,
      healthCheck: { path: '/health' },
      startCommand: '/whoami',
      database: { kind: 'postgres' },
      requires: { websockets: false, backgroundWork: false },
    },
    env: [{ name: 'WHOAMI_NAME', value: marker, secret: false }, ...env],
    idle: h.idle,
    ...(h.shape ? { shape: h.shape } : {}),
  };
}

function neon() {
  let clock = START;
  const sim = createNeonApiSim(() => clock);
  const port = createNeonDatabasePort(NEON_CONFIG, {
    fetch: sim.fetch,
    now: () => new Date(clock),
    sleep: async () => {},
  });
  return {
    sim,
    port,
    advanceSeconds: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('one deploy contract for every deploy adapter', () => {
  it('the contract runs the fake, Fly and serverless adapters, beside the AWS ones', () => {
    expect(ADAPTERS.map(([name]) => name)).toEqual([
      'fake',
      'fly',
      'serverless',
      'fake-aws-function',
      'fake-aws-container',
      'aws function',
      'aws container',
    ]);
  });
});

describe.each(ADAPTERS)('across the deploy adapters — %s', (_name, make) => {
  it('a second release then a rollback keeps the address and one live release', async () => {
    const h = make();
    const { appRef } = await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION });
    const a = await h.port.deploy(releaseOf(h, appRef, 'a'));
    await expect(h.port.rollback({ appRef, environment: PRODUCTION })).rejects.toBeInstanceOf(
      NoPreviousReleaseError,
    );
    const first = await h.port.describe(a);
    const b = await h.port.deploy(releaseOf(h, appRef, 'b'));
    expect(await h.port.describe(b)).toMatchObject({
      releaseId: b.releaseId,
      previousReleaseId: a.releaseId,
      upstreamAddress: first.upstreamAddress,
    });
    const live = async () => (await h.port.listReleases({ appRef })).map((r) => r.handle.releaseId);
    expect(await live()).toEqual([b.releaseId]);
    const back = await h.port.rollback({ appRef, environment: PRODUCTION });
    expect(await h.port.describe(back)).toMatchObject({
      releaseId: a.releaseId,
      upstreamAddress: first.upstreamAddress,
    });
    expect(await live()).toEqual([a.releaseId]);
  });

  it('every destroy resolves with usage, and an already-gone release with zero', async () => {
    const h = make();
    const { appRef } = await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION });
    const a = await h.port.deploy(releaseOf(h, appRef, 'a'));
    h.advanceSeconds(60);
    const usage = await h.port.destroy(a, 'operator');
    expect(usage).toMatchObject({ appRef, releaseId: a.releaseId });
    const again = await h.port.destroy(a, 'operator');
    expect(again).toMatchObject({ appRef, runningSeconds: 0 });
    expect(await h.port.destroyApp({ appRef })).toEqual(expect.any(Array));
  });
});

describe('a usage read that fails deletes nothing', () => {
  it('the serverless destroy throws, leaves the function, and the retry returns usage', async () => {
    const h = serverlessHarness();
    const { appRef } = await h.port.ensureApp({ repositoryId: R, environment: PRODUCTION });
    const a = await h.port.deploy(releaseOf(h, appRef, 'a'));
    h.advanceSeconds(60);
    const before = h.sim.calls.length;
    h.sim.failNext('GetMetricDataCommand');
    await expect(h.port.destroy(a, 'operator')).rejects.toBeInstanceOf(OrchestratorApiError);
    const deletes = h.sim.calls.slice(before).filter((c) => c.command.startsWith('Delete'));
    expect(deletes).toEqual([]);
    expect(h.sim.functions.has(appRef)).toBe(true);
    expect(await h.port.destroy(a, 'operator')).toMatchObject({ appRef, releaseId: a.releaseId });
    expect(h.sim.functions.has(appRef)).toBe(false);
  });

  it('the Neon deleteDatabase throws, sends no delete, and the retry returns usage', async () => {
    const { sim, port, advanceSeconds } = neon();
    const { handle } = await port.createDatabase({ applicationRef: 'mh-gate' });
    advanceSeconds(60);
    // A refusal Neon does not retry, so the delete really is attempted once.
    sim.failNext((call) => call.url.pathname.includes('consumption_history'), 403);
    await expect(port.deleteDatabase(handle)).rejects.toBeInstanceOf(OrchestratorApiError);
    expect(sim.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(sim.live()).toHaveLength(1);
    expect(await port.deleteDatabase(handle)).toMatchObject({ applicationRef: 'mh-gate' });
    expect(sim.live()).toEqual([]);
  });
});

describe('the database fake and the Neon adapter agree', () => {
  /** What a caller can observe of one database lifecycle, with the values that
   *  are each adapter's own (ids, strings, amounts) reduced to their shape. */
  async function observe(port: DatabasePort, advanceSeconds: (s: number) => void) {
    const a = await port.createDatabase({ applicationRef: 'mh-gate-a' });
    const again = await port.createDatabase({ applicationRef: 'mh-gate-a' });
    const b = await port.createDatabase({ applicationRef: 'mh-gate-b' });
    advanceSeconds(120);
    const usage = await port.deleteDatabase(a.handle);
    const left = (await port.list()).map((d) => d.handle.applicationRef);
    const second = await port.deleteDatabase(a.handle);
    return {
      pairs: a.env.map(({ name, secret }) => ({ name, secret })),
      reread: (await port.connectionEnv(b.handle)).map(({ name }) => name),
      idempotent: again.handle.databaseRef === a.handle.databaseRef,
      separate: b.handle.databaseRef !== a.handle.databaseRef,
      usage: { applicationRef: usage.applicationRef, provider: usage.provider },
      usageFields: Object.keys(usage).sort(),
      left,
      second: { computeSeconds: second.computeSeconds, storageBytes: second.storageBytes },
    };
  }

  it('observes the same lifecycle through both', async () => {
    const fake = createFakeDatabasePort({ start: new Date(START) });
    const fromFake = await observe(fake, (s) => fake.advanceSeconds(s));
    const { port, advanceSeconds } = neon();
    const fromNeon = await observe(port, advanceSeconds);
    expect(fromFake).toEqual({
      pairs: [
        { name: 'DATABASE_URL', secret: true },
        { name: 'DIRECT_URL', secret: true },
      ],
      reread: ['DATABASE_URL', 'DIRECT_URL'],
      idempotent: true,
      separate: true,
      usage: { applicationRef: 'mh-gate-a', provider: 'neon' },
      usageFields: [
        'applicationRef',
        'computeSeconds',
        'provider',
        'since',
        'storageBytes',
        'until',
      ],
      left: ['mh-gate-b'],
      second: { computeSeconds: 0, storageBytes: 0 },
    });
    expect(fromNeon).toEqual(fromFake);
  });
});

describe('no secret leaves a whole lifecycle', () => {
  function serialised(value: unknown): string {
    if (value instanceof Error) return `${value.name} ${value.message} ${JSON.stringify(value)}`;
    return JSON.stringify(value);
  }

  async function caught(run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (err) {
      return err;
    }
  }

  it('pairs, connection strings, session credentials and the API key appear only where they belong', async () => {
    const h = serverlessHarness();
    const db = neon();
    const seen: unknown[] = [];
    const keep = async <T>(value: Promise<T>): Promise<T> => {
      const resolved = await value;
      seen.push(resolved);
      return resolved;
    };

    // The pairs themselves are what the port hands out, to be handed on to the
    // provider; everything else it returns is searched for them.
    const created = await db.port.createDatabase({ applicationRef: 'mh-gate' });
    seen.push(created.handle);
    const pairs = await db.port.connectionEnv(created.handle);
    // An error body that quotes a connection string, as a real one can.
    const project = db.sim.live()[0]!;
    db.sim.failNext(() => true, 400, { code: 'internal', message: uriOf(project, true) });
    seen.push(await caught(() => db.port.connectionEnv(created.handle)));
    db.sim.failNext(() => true, 422, { message: `bad ${uriOf(project, false)}` });
    seen.push(await caught(() => db.port.usageSince(created.handle, new Date(START))));
    expect(seen.slice(-2).every((e) => e instanceof OrchestratorApiError)).toBe(true);

    const app = await keep(h.port.ensureApp({ repositoryId: R, environment: PRODUCTION }));
    const a = await keep(h.port.deploy(releaseOf(h, app.appRef, 'a', pairs)));
    const b = await keep(h.port.deploy(releaseOf(h, app.appRef, 'b', pairs)));
    await keep(h.port.describe(b));
    const back = await keep(h.port.rollback({ appRef: app.appRef, environment: PRODUCTION }));
    await keep(h.port.describe(back));
    await keep(h.port.listReleases({ appRef: app.appRef }));
    h.sim.failNext('DeleteFunctionCommand');
    seen.push(await caught(() => h.port.destroy(a, 'operator')));
    seen.push([...h.sim.functions.values()].map((fn) => fn.tags));
    await keep(h.port.destroy(a, 'operator'));
    await keep(h.port.destroyApp({ appRef: app.appRef }));
    await keep(db.port.list());
    await keep(db.port.deleteDatabase(created.handle));

    const secrets = [
      ...pairs.map((pair) => pair.value),
      uriOf(project, true),
      uriOf(project, false),
      project.password,
      NEON_SIM_KEY,
      ...h.sim.sessions.map((s) => s.accessKeyId),
      'sim-session-secret',
      'sim-session-token',
    ];
    const text = seen.map(serialised).join('\n');
    expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);

    // Not vacuous: the pairs reached the provider, and the key only its header.
    const variables = h.sim.calls
      .filter((c) => c.command === 'CreateFunctionCommand')
      .map((c) => JSON.stringify(c.input));
    expect(variables.join('')).toContain(pairs[0]!.value);
    expect(db.sim.calls.every((c) => c.headers['authorization'] === `Bearer ${NEON_SIM_KEY}`)).toBe(
      true,
    );
    const elsewhere = db.sim.calls.map((c) => `${c.url} ${c.body ?? ''}`).join('\n');
    expect(elsewhere).not.toContain(NEON_SIM_KEY);
    expect(h.sim.sessions.length).toBeGreaterThan(0);
  });
});

describe('the port boundary', () => {
  const ORCHESTRATOR = 'packages/orchestrator/src';
  const SERVERLESS = `${ORCHESTRATOR}/adapters/serverless/`;
  const NEON = `${ORCHESTRATOR}/adapters/neon/`;
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
  const filesOf = (dir: string) =>
    readdirSync(join(ROOT, dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `${dir}${f}`);

  /** The SDK client packages the serverless adapter depends on and imports. */
  function serverlessModules(): Set<string> {
    const pkg = JSON.parse(read('packages/orchestrator/package.json')) as {
      dependencies: Record<string, string>;
    };
    const clients = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@aws-sdk/client-'));
    const imported = new Set(filesOf(SERVERLESS).flatMap((f) => importsOf(read(f))));
    return new Set(clients.filter((c) => imported.has(c)));
  }

  /** The request and response shapes the Neon adapter declares. */
  function neonTypes(): Set<string> {
    return new Set(
      filesOf(NEON)
        .flatMap((f) => declaredTypesOf(read(f)))
        .filter((name) => name.startsWith('Neon')),
    );
  }

  function rules(): BoundaryRule[] {
    return [
      {
        name: 'serverless-sdk',
        // The fleet's AWS adapter shares the STS client and is held to its own
        // directory by `tests/ciFleet/awsSdkBoundary.test.ts`.
        allowed: [SERVERLESS, `${ORCHESTRATOR}/adapters/aws/`],
        modules: serverlessModules(),
        identifiers: new Set(),
      },
      { name: 'neon-types', allowed: [NEON], modules: new Set(), identifiers: neonTypes() },
    ];
  }

  function trackedSources(): SourceText[] {
    const listed = execFileSync(
      'git',
      ['ls-files', '--', ORCHESTRATOR, 'lib', 'app', 'tests', 'scripts'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return listed
      .split('\n')
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.endsWith('.d.ts'))
      .map((path) => ({ path, text: read(path) }));
  }

  it('derives what it bans from the adapters, so the scan is not vacuous', () => {
    expect([...serverlessModules()]).toEqual(
      expect.arrayContaining(['@aws-sdk/client-lambda', '@aws-sdk/client-ecr']),
    );
    expect([...neonTypes()]).toEqual(expect.arrayContaining(['NeonProject', 'NeonConsumption']));
  });

  it('no file outside the adapter folders imports the serverless SDK or names a Neon type', () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(1000);
    expect(scanPortBoundary(files, rules())).toEqual([]);
  }, 60_000);

  it('reports a planted offender of each rule, by file and line', () => {
    const planted: SourceText = {
      path: 'lib/hosting/planted.ts',
      text: [
        '// a comment naming NeonProject is not an offence',
        "import { LambdaClient } from '@aws-sdk/client-lambda';",
        'const project: NeonProject | null = null;',
      ].join('\n'),
    };
    expect(scanPortBoundary([planted], rules())).toEqual([
      { rule: 'serverless-sdk', path: planted.path, line: 2, what: '@aws-sdk/client-lambda' },
      { rule: 'neon-types', path: planted.path, line: 3, what: 'NeonProject' },
    ]);
    // The same text inside its adapter folder is allowed.
    expect(scanPortBoundary([{ ...planted, path: `${NEON}x.ts` }], rules())).toEqual([
      { rule: 'serverless-sdk', path: `${NEON}x.ts`, line: 2, what: '@aws-sdk/client-lambda' },
    ]);
  });

  it('the barrel exports no provider type, and from Neon only its factory and config', () => {
    const index = join(ROOT, ORCHESTRATOR, 'index.ts');
    const program = ts.createProgram([index], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    });
    const checker = program.getTypeChecker();
    const barrel = checker.getSymbolAtLocation(program.getSourceFile(index)!)!;
    const exported = checker.getExportsOfModule(barrel).map((symbol) => {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return {
        name: symbol.name,
        file: target.declarations?.[0]?.getSourceFile().fileName ?? '',
      };
    });
    expect(exported.length).toBeGreaterThan(50);
    expect(exported.filter((e) => /node_modules|@aws-sdk|@smithy/.test(e.file))).toEqual([]);
    expect(
      exported
        .filter((e) => e.file.includes('/adapters/neon/'))
        .map((e) => e.name)
        .sort(),
    ).toEqual(['createNeonDatabasePort', 'neonDatabaseConfig']);
    const serverless = exported.filter((e) => e.file.includes('/adapters/serverless/'));
    expect(serverless.map((e) => e.name)).toEqual(
      expect.arrayContaining(['createServerlessHostingDeployPort', 'signFunctionUrlRequest']),
    );
  }, 120_000);
});
