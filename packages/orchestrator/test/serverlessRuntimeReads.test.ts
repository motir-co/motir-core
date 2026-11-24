import { describe, expect, it, vi } from 'vitest';
import {
  LogsUnavailableError,
  ReleaseNotFoundError,
  RuntimeHealthUnavailableError,
  SERVERLESS_HEALTH_WINDOW_MS,
  createServerlessHostingDeployPort,
  lambdaRuntimeSignal,
  serverlessStreamOf,
  type DeployReleaseInput,
  type ReleaseHandle,
  type ServerlessHostingConfig,
} from '../src/index';
import { lambdaInstant } from '../src/adapters/serverless/client';
import { SIM_ACCOUNT, SIM_REGION, createLambdaSim } from './contract/hostingLambdaSim';

// MOTIR-12103 — the serverless adapter's runtime reads: a release function's log
// group read newest first, and its runtime state read from the function and
// from Lambda's own lines. Driven through the in-memory account at the SDK seam
// (`clientFactory`); no live AWS call.
//
// The platform lines below are the shapes Lambda's documentation gives ("Lambda
// function logging", "Troubleshoot invocation issues in Lambda", read
// 2026-11-23): START / END / REPORT per invocation, the REPORT's memory fields,
// the newer report format's `Status:` / `Error Type:`, and the runtime-exit line
// `RequestId: … Error: Runtime exited with error: …` before `Runtime.ExitError`.

const START = Date.parse('2026-11-23T10:00:00.000Z');
const REGISTRY = `${SIM_ACCOUNT}.dkr.ecr.${SIM_REGION}.amazonaws.com`;
const CONFIG: ServerlessHostingConfig = {
  roleArn: `arn:aws:iam::${SIM_ACCOUNT}:role/motir-hosting-serverless-deploy`,
  accountId: SIM_ACCOUNT,
  region: SIM_REGION,
  appPrefix: 'mh-',
};
const APP = 'mh-rt1';
const GROUP = `/aws/lambda/${APP}`;
const MIN = 60_000;

const REPORT = (id: string, used = 90, size = 1769, extra = '') =>
  `REPORT RequestId: ${id}\tDuration: 12.31 ms\tBilled Duration: 13 ms\tMemory Size: ${size} MB\tMax Memory Used: ${used} MB\t${extra}\n`;
const EXIT = (id: string, how: string) =>
  `RequestId: ${id} Error: Runtime exited with error: ${how}\nRuntime.ExitError\n`;

function input(): DeployReleaseInput {
  return {
    appRef: APP,
    environment: { kind: 'production' },
    artifact: { kind: 'image', ref: `${REGISTRY}/mh/rt1/production`, digest: 'sha256:one' },
    runtime: {
      port: 3000,
      healthCheck: { path: '/api/health' },
      startCommand: 'node server.js',
      database: { kind: 'none' },
      requires: { websockets: false, backgroundWork: false },
    },
    env: [],
    idle: { mode: 'suspend', idleSeconds: 300 },
  };
}

async function deployed() {
  let clock = START;
  const sim = createLambdaSim(() => clock);
  const port = createServerlessHostingDeployPort(CONFIG, {
    clientFactory: sim.clientFactory,
    now: () => new Date(clock),
    sleep: vi.fn(async () => {}),
  });
  const handle = await port.deploy(input());
  const fn = sim.functions.get(APP)!;
  fn.lastModified = '2026-11-23T09:00:00.000+0000';
  let seq = 0;
  return {
    sim,
    port,
    handle,
    fn,
    setClock(ms: number) {
      clock = ms;
    },
    /** Append an event to the release's log group. */
    log(at: number, message: string, stream = '2026/11/23/[$LATEST]abc') {
      seq += 1;
      const events = sim.logEvents.get(GROUP) ?? [];
      events.push({
        eventId: `e${String(seq).padStart(4, '0')}`,
        timestamp: at,
        logStreamName: stream,
        message,
      });
      sim.logEvents.set(GROUP, events);
    },
  };
}

describe('serverless readLogs (MOTIR-12103)', () => {
  it('reads the function’s log group newest first, Lambda’s lines as platform, newlines trimmed', async () => {
    const s = await deployed();
    s.setClock(START + 10 * MIN);
    s.log(START + 1 * MIN, 'START RequestId: r1 Version: 1\n');
    s.log(START + 1 * MIN + 5, 'listening on 3000\n');
    s.log(START + 1 * MIN + 9, REPORT('r1'));

    const page = await s.port.readLogs(s.handle, { limit: 10 });

    expect(page.cursor).toBeNull();
    expect(page.lines).toEqual([
      {
        at: new Date(START + MIN + 9),
        stream: 'platform',
        message: REPORT('r1').replace(/\n$/, ''),
      },
      { at: new Date(START + MIN + 5), stream: 'app', message: 'listening on 3000' },
      { at: new Date(START + MIN), stream: 'platform', message: 'START RequestId: r1 Version: 1' },
    ]);
    const reads = s.sim.calls.filter((c) => c.command === 'FilterLogEventsCommand');
    expect(reads[0]!.input).toMatchObject({ logGroupName: GROUP });
    expect(reads.every((c) => c.input['filterPattern'] === undefined)).toBe(true);
  });

  it('honours since, until, a case-insensitive filter and the limit', async () => {
    const s = await deployed();
    s.setClock(START + 60 * MIN);
    s.log(START + 1 * MIN, 'ERROR before');
    s.log(START + 10 * MIN, 'error at since');
    s.log(START + 20 * MIN, 'fine');
    s.log(START + 30 * MIN, 'Error inside');
    s.log(START + 40 * MIN, 'error at until');
    s.log(START + 50 * MIN, 'error after');

    const page = await s.port.readLogs(s.handle, {
      since: new Date(START + 10 * MIN),
      until: new Date(START + 40 * MIN),
      filter: 'ERROR',
      limit: 2,
    });

    expect(page.lines.map((l) => l.message)).toEqual(['error at until', 'Error inside']);
    const rest = await s.port.readLogs(s.handle, {
      since: new Date(START + 10 * MIN),
      until: new Date(START + 40 * MIN),
      filter: 'ERROR',
      limit: 2,
      cursor: page.cursor!,
    });
    expect(rest).toEqual({
      lines: [{ at: new Date(START + 10 * MIN), stream: 'app', message: 'error at since' }],
      cursor: null,
    });
  });

  it('pages back over many CloudWatch pages and windows with no line repeated or skipped', async () => {
    const s = await deployed();
    s.setClock(START + 120 * MIN);
    s.sim.logPage.size = 3;
    // Lines across two hours, several in one millisecond.
    for (let i = 0; i < 40; i += 1) s.log(START + i * 3 * MIN, `line ${i}`);
    for (const n of ['a', 'b', 'c', 'd']) s.log(START + 60 * MIN, `same ${n}`);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 50; round += 1) {
      const page = await s.port.readLogs(s.handle, { limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...page.lines.map((l) => l.message));
      if (!page.cursor) break;
      cursor = page.cursor;
    }

    const expected = [
      ...Array.from({ length: 19 }, (_, i) => `line ${39 - i}`),
      // Five lines in one millisecond, ordered by CloudWatch's event id.
      'same d',
      'same c',
      'same b',
      'same a',
      'line 20',
      ...Array.from({ length: 20 }, (_, i) => `line ${19 - i}`),
    ];
    expect(seen).toEqual(expected);
  });

  it('is an empty success when the group holds no matching line', async () => {
    const s = await deployed();
    s.log(START - MIN, 'hello');
    expect(await s.port.readLogs(s.handle, { limit: 5, filter: 'nope' })).toEqual({
      lines: [],
      cursor: null,
    });
  });

  it.each([
    ['a missing log group', null],
    ['AccessDeniedException', 'AccessDeniedException'],
    ['a throttle', 'ThrottlingException'],
  ])('is LogsUnavailableError for %s, with no AWS message', async (_name, code) => {
    const s = await deployed();
    if (code === null) s.sim.logGroups.delete(GROUP);
    else s.sim.failNext('FilterLogEventsCommand', () => true, code, 400);

    const error = await s.port.readLogs(s.handle, { limit: 5 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LogsUnavailableError);
    expect(error).toMatchObject({
      target: 'serverless',
      reason:
        code === null
          ? 'the log group does not exist'
          : `The aws orchestrator refused a call (HTTP 400: logs: ${code}).`,
    });
    expect((error as Error).message).not.toMatch(/simulated|might fill/);
  });

  it('refuses a function that is gone or not a release, and a failed function read', async () => {
    const s = await deployed();
    s.fn.tags['motir:hosting'] = 'other';
    const notOurs = await s.port.readLogs(s.handle, { limit: 5 }).catch((e: unknown) => e);
    expect(notOurs).toBeInstanceOf(ReleaseNotFoundError);
    s.sim.functions.delete(APP);
    await expect(s.port.readLogs(s.handle, { limit: 5 })).rejects.toBeInstanceOf(
      ReleaseNotFoundError,
    );
    s.sim.failNext('GetFunctionCommand', () => true, 'ServiceException', 503);
    await expect(s.port.readLogs(s.handle, { limit: 5 })).rejects.toBeInstanceOf(
      LogsUnavailableError,
    );
  });
});

describe('serverless readHealth (MOTIR-12103)', () => {
  const NOW = START + 60 * MIN;
  const CHANGED = new Date('2026-11-23T09:00:00.000Z');

  async function at(now = NOW) {
    const s = await deployed();
    s.setClock(now);
    return s;
  }

  it.each([
    ['a Pending function', (f: { state: string }) => (f.state = 'Pending')],
    [
      'an InProgress update',
      (f: { lastUpdateStatus: string; pendingReads: number }) => {
        f.lastUpdateStatus = 'InProgress';
        f.pendingReads = 99;
      },
    ],
    ['no live alias', (f: { aliases: Map<string, string> }) => f.aliases.delete('live')],
    [
      'provisioned concurrency IN_PROGRESS',
      (f: { provisioned: Map<string, { instances: number; status: string }> }) =>
        f.provisioned.set('live', { instances: 1, status: 'IN_PROGRESS' }),
    ],
  ])('is deploying for %s, since LastModified', async (_name, change) => {
    const s = await at();
    change(s.fn as never);
    expect(await s.port.readHealth(s.handle)).toEqual({ state: 'deploying', since: CHANGED });
  });

  it('is exited for a Failed function', async () => {
    const s = await at();
    s.fn.state = 'Failed';
    expect(await s.port.readHealth(s.handle)).toEqual({
      state: 'exited',
      exitCode: null,
      since: CHANGED,
    });
  });

  it('is exited with the code for a runtime exit with no later successful invocation', async () => {
    const s = await at();
    s.log(NOW - 3 * MIN, REPORT('r1'));
    s.log(NOW - 2 * MIN, EXIT('r2', 'exit status 3'));
    s.log(
      NOW - 2 * MIN + 1,
      REPORT('r2', 90, 1769, 'Status: error\tError Type: Runtime.ExitError'),
    );
    expect(await s.port.readHealth(s.handle)).toEqual({
      state: 'exited',
      exitCode: 3,
      since: new Date(NOW - 2 * MIN),
    });
  });

  it.each([
    ['signal: killed', EXIT('r2', 'signal: killed')],
    [
      'Runtime.OutOfMemory',
      REPORT('r2', 1769, 1769, 'Status: error\tError Type: Runtime.OutOfMemory'),
    ],
    ['Max Memory Used at Memory Size', REPORT('r2', 1769, 1769)],
  ])('is oom_killed for a memory-limit kill (%s)', async (_name, line) => {
    const s = await at();
    s.log(NOW - MIN, line);
    expect(await s.port.readHealth(s.handle)).toEqual({
      state: 'oom_killed',
      since: new Date(NOW - MIN),
    });
  });

  it('is running again after a crash it recovered from, since the first invocation after it', async () => {
    const s = await at();
    s.log(NOW - 4 * MIN, EXIT('r1', 'exit status 1'));
    s.log(NOW - 3 * MIN, REPORT('r2'));
    s.log(NOW - 1 * MIN, REPORT('r3'));
    expect(await s.port.readHealth(s.handle)).toEqual({
      state: 'running',
      since: new Date(NOW - 3 * MIN),
    });
  });

  it('is running for a READY provisioned instance, with no traffic, since LastModified', async () => {
    const s = await at();
    s.fn.provisioned.set('live', { instances: 1, status: 'READY' });
    expect(await s.port.readHealth(s.handle)).toEqual({ state: 'running', since: CHANGED });
  });

  it('is suspended with no invocation in the window, since the last one before it', async () => {
    const s = await at();
    s.log(NOW - 40 * MIN, 'START RequestId: r0 Version: 1');
    s.log(NOW - 40 * MIN + 5, REPORT('r0'));
    s.log(NOW - 30 * MIN, 'an app line with REPORT in it');
    expect(await s.port.readHealth(s.handle)).toEqual({
      state: 'suspended',
      since: new Date(NOW - 40 * MIN + 5),
    });
  });

  it('is suspended since LastModified when it was never invoked and has no log group', async () => {
    const s = await at();
    s.sim.logGroups.delete(GROUP);
    expect(await s.port.readHealth(s.handle)).toEqual({ state: 'suspended', since: CHANGED });
    expect(SERVERLESS_HEALTH_WINDOW_MS).toBe(5 * MIN);
  });

  it('refuses a function that is gone or not a release', async () => {
    const s = await at();
    s.fn.tags['motir:hosting'] = 'other';
    await expect(s.port.readHealth(s.handle)).rejects.toBeInstanceOf(ReleaseNotFoundError);
    const gone: ReleaseHandle = { ...s.handle, appRef: 'mh-nope' };
    await expect(s.port.readHealth(gone)).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it('throws rather than answering running when the report read fails', async () => {
    const s = await at();
    s.log(NOW - MIN, REPORT('r1'));
    s.sim.failNext('FilterLogEventsCommand', () => true, 'ThrottlingException', 400);
    const error = await s.port.readHealth(s.handle).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeHealthUnavailableError);
    expect(error).toMatchObject({
      reason: 'The aws orchestrator refused a call (HTTP 400: logs: ThrottlingException).',
    });

    s.sim.failNext('GetAliasCommand', () => true, 'ServiceException', 503);
    await expect(s.port.readHealth(s.handle)).rejects.toMatchObject({
      reason: 'The aws orchestrator refused a call (HTTP 503: lambda: ServiceException).',
    });
  });

  it('refuses a window with more runtime lines than it reads', async () => {
    const s = await at();
    s.sim.logPage.size = 1;
    for (let i = 0; i < 10; i += 1) s.log(NOW - MIN + i, REPORT(`r${i}`));
    await expect(s.port.readHealth(s.handle)).rejects.toMatchObject({
      reason: 'too many runtime lines to read',
    });
  });
});

describe('the serverless line readers', () => {
  const T = new Date(START);

  it('reads what each of Lambda’s lines says about the runtime', () => {
    expect(lambdaRuntimeSignal(REPORT('r'), T)).toEqual({ kind: 'invocation', at: T });
    expect(lambdaRuntimeSignal(REPORT('r', 10, 128, 'Status: timeout'), T)).toEqual({
      kind: 'timeout',
      at: T,
    });
    expect(
      lambdaRuntimeSignal('2026-11-23T10:00:00Z r Task timed out after 60.00 seconds', T),
    ).toEqual({
      kind: 'timeout',
      at: T,
    });
    expect(lambdaRuntimeSignal(EXIT('r', 'exit status 137'), T)).toEqual({
      kind: 'exit',
      at: T,
      exitCode: 137,
      requestId: 'r',
    });
    expect(lambdaRuntimeSignal(EXIT('r', 'signal: segmentation fault'), T)).toEqual({
      kind: 'exit',
      at: T,
      exitCode: null,
      requestId: 'r',
    });
    expect(lambdaRuntimeSignal('Runtime.ExitError', T)).toEqual({
      kind: 'exit',
      at: T,
      exitCode: null,
      requestId: null,
    });
    expect(
      lambdaRuntimeSignal(
        'INIT_REPORT Init Duration: 9.1 ms\tPhase: init\tStatus: error\tError Type: Runtime.ExitError',
        T,
      ),
    ).toEqual({ kind: 'exit', at: T, exitCode: null, requestId: null });
    expect(lambdaRuntimeSignal('INIT_REPORT Init Duration: 9.1 ms\tPhase: init', T)).toBeNull();
    expect(lambdaRuntimeSignal('START RequestId: r Version: 1', T)).toBeNull();
    expect(lambdaRuntimeSignal('hello', T)).toBeNull();
  });

  it('reads an exit line with trailing whitespace, and a hostile one in linear time', () => {
    expect(lambdaRuntimeSignal('Runtime exited with error: exit status 2 \t\r\nnext', T)).toEqual({
      kind: 'exit',
      at: T,
      exitCode: 2,
      requestId: null,
    });
    // CodeQL js/polynomial-redos: the old lazy `(.+?)\s*$` backtracked on these.
    const started = performance.now();
    lambdaRuntimeSignal(`Runtime exited with error: a${'\t'.repeat(50_000)}x`, T);
    lambdaRuntimeSignal('Runtime exited with error: a'.repeat(5_000), T);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('tells Lambda’s lines from the app’s', () => {
    expect(serverlessStreamOf('END RequestId: r')).toBe('platform');
    expect(serverlessStreamOf('INIT_START Runtime Version: x')).toBe('platform');
    expect(serverlessStreamOf(EXIT('r', 'exit status 1'))).toBe('platform');
    expect(serverlessStreamOf('GET / 200')).toBe('app');
    expect(serverlessStreamOf('REPORTING is fine')).toBe('app');
  });

  it('reads Lambda’s LastModified, offset with no colon', () => {
    expect(lambdaInstant('2026-11-23T09:00:00.000+0000')).toEqual(new Date('2026-11-23T09:00:00Z'));
    expect(lambdaInstant('2026-11-23T11:00:00.000+0200')).toEqual(new Date('2026-11-23T09:00:00Z'));
    expect(lambdaInstant('nonsense')).toBeNull();
    expect(lambdaInstant(undefined)).toBeNull();
  });
});
