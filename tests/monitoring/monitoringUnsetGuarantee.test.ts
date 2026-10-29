import { readFileSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { parseBreachArgs, runBreachCommand, type BreachSystem } from '@/lib/monitoring/breachTask';
import {
  EMF_INTERVAL_MS,
  startEventLoopDelayPublisher,
  stopEventLoopDelayPublisherForTests,
} from '@/lib/monitoring/cloudwatchMetrics';
import {
  __forTests,
  isLoopBlockWatchdogRunning,
  startLoopBlockWatchdog,
} from '@/lib/monitoring/loopBlockWatchdog';
import {
  METRICS_PATH,
  startMetricsServer,
  stopMetricsServerForTests,
} from '@/lib/monitoring/metricsServer';
import {
  recordTransactionMeasurement,
  REQUEST_DB_TIMING_METRICS,
  resetRequestDbTimingForTests,
} from '@/lib/monitoring/requestDbTiming';
import {
  setProcStatReaderForTests,
  startWatchdogMetricsPublisher,
  stopWatchdogMetricsPublisherForTests,
} from '@/lib/monitoring/watchdogMetrics';

// MOTIR-9889 — the CloudWatch publishers, started together as the entrypoints
// start them: with MONITORING_CLOUDWATCH_NAMESPACE unset they open, start and
// write NOTHING; set, they write EMF lines and still open no port; and the 9091
// server Fly scrapes serves the same body either way.

const ROOT = join(__dirname, '..', '..');
const NAMESPACE = 'Motir/Guarantee';
const SET = { MONITORING_CLOUDWATCH_NAMESPACE: NAMESPACE, MONITORING_CLOUDWATCH_SERVICE: 'web' };
const CLOUDWATCH_METRICS = [
  'EventLoopDelayMaxMs',
  'LoopBlockMaxMs',
  'LoopBlockCount',
  'CpuStealMs',
];
const FIVE_MINUTES_MS = 5 * 60_000;
const THRESHOLD_MS = 200;
const METRICS_SERVER_KEY = Symbol.for('motir.metricsServer.server');

type Env = Readonly<Record<string, string | undefined>>;

let written: string[];
let stdout: MockInstance;
let listen: MockInstance;
let outbound: MockInstance[];

/** Start every publisher the entrypoints start, in their order. */
function startAll(env: Env) {
  return {
    server: startMetricsServer(env),
    delay: startEventLoopDelayPublisher(env),
    watchdog: startWatchdogMetricsPublisher(env),
  };
}

async function stopAll(): Promise<void> {
  stopEventLoopDelayPublisherForTests();
  await stopWatchdogMetricsPublisherForTests();
  await stopMetricsServerForTests();
}

const outboundCalls = () => outbound.reduce((n, spy) => n + spy.mock.calls.length, 0);

function blockLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin: block the event loop
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Port 0 is refused by the server's parser, so pick a free port by listening first. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

beforeEach(async () => {
  await stopAll();
  resetRequestDbTimingForTests();
  setProcStatReaderForTests(null);
  __forTests.setThresholdMs(THRESHOLD_MS);
  written = [];
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  listen = vi.spyOn(net.Server.prototype, 'listen');
  // Every outbound socket, http(s) and fetch included, is opened through these.
  outbound = [
    vi.spyOn(net, 'connect'),
    vi.spyOn(net, 'createConnection'),
    vi.spyOn(tls, 'connect'),
  ];
});

afterEach(async () => {
  vi.useRealTimers();
  await stopAll();
  resetRequestDbTimingForTests();
  setProcStatReaderForTests(null);
  __forTests.setThresholdMs(null);
  vi.restoreAllMocks();
  expect(isLoopBlockWatchdogRunning()).toBe(false);
});

describe.each([
  ['unset', {}],
  ['blank', { MONITORING_CLOUDWATCH_NAMESPACE: '  ', MONITORING_CLOUDWATCH_SERVICE: 'web' }],
  ['whitespace-only', { MONITORING_CLOUDWATCH_NAMESPACE: '\t\n' }],
])('with the namespace %s and no metrics port', (_label, env: Env) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });

  it('starts nothing: every publisher returns null', () => {
    expect(startAll(env)).toEqual({ server: null, delay: null, watchdog: null });
  });

  it('leaves no timer', () => {
    startAll(env);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(FIVE_MINUTES_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no watchdog thread', () => {
    startAll(env);
    vi.advanceTimersByTime(FIVE_MINUTES_MS);
    expect(isLoopBlockWatchdogRunning()).toBe(false);
  });

  it('writes nothing to stdout across five minutes', () => {
    startAll(env);
    vi.advanceTimersByTime(FIVE_MINUTES_MS);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('listens on no socket', () => {
    startAll(env);
    vi.advanceTimersByTime(FIVE_MINUTES_MS);
    expect(listen).not.toHaveBeenCalled();
  });

  it('attempts no outbound connection', () => {
    startAll(env);
    vi.advanceTimersByTime(FIVE_MINUTES_MS);
    expect(outboundCalls()).toBe(0);
  });
});

describe('with the namespace set and no metrics port', () => {
  beforeEach(() => {
    // The watchdog's heartbeat runs on real time so a real block is measured;
    // only the publishers' 60 s intervals are faked.
    startLoopBlockWatchdog();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  it('writes only whole-line EMF objects in the namespace, and opens nothing', async () => {
    const reader = vi.fn(() => 'cpu  1 0 1 1 1 0 0 9 0 0\n');
    setProcStatReaderForTests(reader);
    const started = startAll(SET);
    expect(started.server).toBeNull();
    expect(started.delay).not.toBeNull();
    expect(started.watchdog).not.toBeNull();
    await sleep(300);
    blockLoop(600);
    await sleep(300);
    vi.advanceTimersByTime(EMF_INTERVAL_MS);

    expect(written.length).toBeGreaterThanOrEqual(2);
    const metrics: string[] = [];
    for (const chunk of written) {
      expect(chunk.endsWith('\n')).toBe(true);
      expect(chunk.indexOf('\n')).toBe(chunk.length - 1);
      const line = JSON.parse(chunk) as {
        _aws: { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] };
      };
      expect(line._aws.CloudWatchMetrics).toHaveLength(1);
      expect(line._aws.CloudWatchMetrics[0]!.Namespace).toBe(NAMESPACE);
      metrics.push(...line._aws.CloudWatchMetrics[0]!.Metrics.map((m) => m.Name));
    }
    expect(metrics).toEqual(
      expect.arrayContaining(['EventLoopDelayMaxMs', 'LoopBlockMaxMs', 'LoopBlockCount']),
    );
    expect(listen).not.toHaveBeenCalled();
    expect(outboundCalls()).toBe(0);
    expect((globalThis as Record<symbol, unknown>)[METRICS_SERVER_KEY]).toBeUndefined();
  });

  it('with steal unset, never reads /proc/stat and publishes no CpuStealMs', async () => {
    const reader = vi.fn(() => 'cpu  1 0 1 1 1 0 0 9 0 0\n');
    setProcStatReaderForTests(reader);
    startAll(SET);
    await sleep(300);
    blockLoop(400);
    await sleep(300);
    for (let i = 0; i < 5; i += 1) vi.advanceTimersByTime(EMF_INTERVAL_MS);
    expect(reader).not.toHaveBeenCalled();
    expect(written.join('')).not.toContain('CpuStealMs');
  });
});

describe('the 9091 server Fly scrapes', () => {
  const measurement = {
    context: 'workspace',
    attempt: 1,
    waitMs: 3,
    holdMs: 7,
    outcome: 'committed',
    pool: { total: 4, waiting: 1, idle: 2, max: 10, count: 1 },
  } as const;

  async function body(port: number): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}${METRICS_PATH}`);
    expect(response.status).toBe(200);
    return response.text();
  }

  async function listening(server: NonNullable<ReturnType<typeof startMetricsServer>>) {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('serves the same series and body whether or not the CloudWatch publishers run', async () => {
    recordTransactionMeasurement(measurement);
    const env = { MONITORING_METRICS_PORT: String(await freePort()) };
    const server = startMetricsServer(env);
    expect(server).not.toBeNull();
    const port = await listening(server!);
    const without = await body(port);

    expect(startAll({ ...env, ...SET }).delay).not.toBeNull();
    expect(isLoopBlockWatchdogRunning()).toBe(true);
    const withPublishers = await body(port);

    expect(withPublishers).toBe(without);
    for (const name of Object.values(REQUEST_DB_TIMING_METRICS)) {
      expect(withPublishers, name).toContain(`# TYPE ${name} `);
    }
    for (const name of CLOUDWATCH_METRICS) expect(withPublishers, name).not.toContain(name);
  });

  it.each([
    ['unset', {}],
    ['set', SET],
  ])('opens no port with MONITORING_METRICS_PORT unset and the namespace %s', (_l, env: Env) => {
    expect(startAll(env).server).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe('the code paths stay apart', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
  const NEW_MODULES = /(cloudwatchMetrics|watchdogMetrics|breachTask)/;

  it.each(['lib/monitoring/metricsServer.ts', 'lib/monitoring/requestDbTiming.ts'])(
    '%s imports none of the CloudWatch or breach modules',
    (path) => {
      const imports = read(path)
        .split('\n')
        .filter((line) => /^\s*(import|export)\b.*from\s+['"]|\bimport\(\s*['"]/.test(line));
      expect(imports.length).toBeGreaterThan(0);
      for (const line of imports) expect(line).not.toMatch(NEW_MODULES);
    },
  );

  it.each(['scripts/worker.ts', 'scripts/relay.ts', 'instrumentation.ts'])(
    '%s never references the breach command',
    (path) => {
      const source = read(path);
      expect(source).not.toMatch(/breachTask|scripts\/breach|breach\/breach|\bbreach\b/i);
    },
  );

  it('the breach command refuses without MOTIR_BREACH_ENABLED and allocates nothing', async () => {
    const parsed = parseBreachArgs(['memory', '--percent', '80'], {});
    expect(parsed).toMatchObject({ ok: false, exitCode: 2 });
    const allocate = vi.fn(() => null);
    const sys = {
      clock: { now: () => 0, sleep: () => Promise.resolve() },
      write: vi.fn(),
      writeError: vi.fn(),
      readFile: () => null,
      hostTotalBytes: 0,
      availableParallelism: 1,
      allocate,
      rssBytes: () => 0,
      createWorker: vi.fn(),
      block: vi.fn(),
      startPublishers: vi.fn(),
      armDeadline: vi.fn(),
    } as unknown as BreachSystem;
    expect(await runBreachCommand(['memory', '--percent', '80'], {}, sys)).toBe(2);
    expect(allocate).not.toHaveBeenCalled();
    expect(sys.startPublishers).not.toHaveBeenCalled();
    expect(sys.armDeadline).not.toHaveBeenCalled();
  });
});
