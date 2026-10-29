import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MOTIR-9881 — event-loop delay as CloudWatch embedded-metric lines: nothing at
// all when the namespace is unset, one EMF line a minute when it is set, one
// publisher per process, and a call from each of the three entrypoints.

const perfHooks = vi.hoisted(() => ({ created: 0 }));

vi.mock('node:perf_hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:perf_hooks')>();
  return {
    ...actual,
    monitorEventLoopDelay: (...args: Parameters<typeof actual.monitorEventLoopDelay>) => {
      perfHooks.created += 1;
      return actual.monitorEventLoopDelay(...args);
    },
  };
});

const {
  EMF_INTERVAL_MS,
  emitEmfLine,
  nsToMs,
  readCloudWatchSettings,
  startEventLoopDelayPublisher,
  stopEventLoopDelayPublisherForTests,
} = await import('@/lib/monitoring/cloudwatchMetrics');

const SET = {
  MONITORING_CLOUDWATCH_NAMESPACE: 'Motir/Test',
  MONITORING_CLOUDWATCH_SERVICE: 'worker',
};

let written: string[];

beforeEach(() => {
  stopEventLoopDelayPublisherForTests();
  perfHooks.created = 0;
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  // Only the interval is faked: the histogram samples on libuv's own timer, and
  // the busy-wait case needs a real turn of the loop for it to record the block.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  stopEventLoopDelayPublisherForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin: block the event loop
  }
}

/** A real turn of the loop, so the histogram's native timer records a sample. */
async function realTick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parsedLines(): Record<string, unknown>[] {
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('with the namespace unset or blank', () => {
  it.each([{}, { MONITORING_CLOUDWATCH_NAMESPACE: '   ' }])(
    'starts nothing and writes nothing (%o)',
    (env) => {
      expect(startEventLoopDelayPublisher(env)).toBeNull();
      vi.advanceTimersByTime(5 * EMF_INTERVAL_MS);
      expect(written).toEqual([]);
      expect(perfHooks.created).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('with the namespace set', () => {
  it('writes exactly one EMF line per interval, in the documented shape', async () => {
    const publisher = startEventLoopDelayPublisher(SET);
    expect(publisher).not.toBeNull();
    await realTick();
    vi.advanceTimersByTime(EMF_INTERVAL_MS);

    expect(written).toHaveLength(1);
    expect(written[0]!.endsWith('\n')).toBe(true);
    expect(written[0]!.trimEnd().includes('\n')).toBe(false);
    const [line] = parsedLines();
    const aws = line!['_aws'] as {
      Timestamp: number;
      CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: unknown[] }[];
    };
    expect(Number.isInteger(aws.Timestamp)).toBe(true);
    expect(aws.Timestamp).toBe(Date.now());
    expect(aws.CloudWatchMetrics[0]!.Namespace).toBe('Motir/Test');
    expect(aws.CloudWatchMetrics[0]!.Dimensions).toEqual([['Service']]);
    expect(aws.CloudWatchMetrics[0]!.Metrics).toEqual([
      { Name: 'EventLoopDelayMaxMs', Unit: 'Milliseconds' },
      { Name: 'EventLoopDelayP99Ms', Unit: 'Milliseconds' },
    ]);
    expect(line!['Service']).toBe('worker');
    expect(typeof line!['EventLoopDelayMaxMs']).toBe('number');
    expect(typeof line!['EventLoopDelayP99Ms']).toBe('number');
  });

  it('reports a block in the next line and resets after each emit', async () => {
    startEventLoopDelayPublisher(SET);
    await realTick();
    busyWait(300);
    await realTick();
    vi.advanceTimersByTime(EMF_INTERVAL_MS);

    await realTick();
    await realTick();
    vi.advanceTimersByTime(EMF_INTERVAL_MS);

    const [blocked, after] = parsedLines();
    expect(blocked!['EventLoopDelayMaxMs']).toBeGreaterThanOrEqual(250);
    expect(after!['EventLoopDelayMaxMs']).toBeLessThan(250);
  });

  it('skips an interval in which the histogram took no sample', () => {
    startEventLoopDelayPublisher(SET);
    // No real turn of the loop: the histogram has nothing to report.
    vi.advanceTimersByTime(EMF_INTERVAL_MS);
    expect(written).toEqual([]);
  });

  it('publishes as `unknown` with one warning when the service is blank', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startEventLoopDelayPublisher({ ...SET, MONITORING_CLOUDWATCH_SERVICE: ' ' });
    for (let i = 0; i < 3; i += 1) {
      await realTick();
      vi.advanceTimersByTime(EMF_INTERVAL_MS);
    }
    expect(parsedLines().map((line) => line['Service'])).toEqual(['unknown', 'unknown', 'unknown']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps one publisher per process', async () => {
    const first = startEventLoopDelayPublisher(SET);
    const second = startEventLoopDelayPublisher({ ...SET, MONITORING_CLOUDWATCH_SERVICE: 'web' });
    expect(second).toBe(first);
    expect(perfHooks.created).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await realTick();
    vi.advanceTimersByTime(EMF_INTERVAL_MS);
    expect(written).toHaveLength(1);
    expect(parsedLines()[0]!['Service']).toBe('worker');

    stopEventLoopDelayPublisherForTests();
    expect(vi.getTimerCount()).toBe(0);
    expect(startEventLoopDelayPublisher(SET)).not.toBe(first);
  });

  it('never keeps the process alive', () => {
    const publisher = startEventLoopDelayPublisher(SET);
    expect(publisher!.timer.hasRef()).toBe(false);
  });

  it('a stop with nothing running is a no-op', () => {
    expect(() => stopEventLoopDelayPublisherForTests()).not.toThrow();
  });
});

describe('emitEmfLine', () => {
  it('writes nothing for an empty metric list', () => {
    emitEmfLine('Motir/Test', { Service: 'web' }, []);
    expect(written).toEqual([]);
  });

  it('carries every dimension and metric at top level', () => {
    emitEmfLine(
      'Motir/Test',
      { Service: 'relay' },
      [{ name: 'LoopBlockMs', unit: 'Milliseconds', value: 1234.5 }],
      1_700_000_000_123.9,
    );
    expect(parsedLines()).toEqual([
      {
        _aws: {
          Timestamp: 1_700_000_000_123,
          CloudWatchMetrics: [
            {
              Namespace: 'Motir/Test',
              Dimensions: [['Service']],
              Metrics: [{ Name: 'LoopBlockMs', Unit: 'Milliseconds' }],
            },
          ],
        },
        Service: 'relay',
        LoopBlockMs: 1234.5,
      },
    ]);
  });
});

describe('readCloudWatchSettings and nsToMs', () => {
  it('trims both settings', () => {
    expect(
      readCloudWatchSettings({
        MONITORING_CLOUDWATCH_NAMESPACE: ' Motir/Core ',
        MONITORING_CLOUDWATCH_SERVICE: ' web ',
      }),
    ).toEqual({ namespace: 'Motir/Core', service: 'web' });
  });

  it('rounds nanoseconds to milliseconds with 2 decimals', () => {
    expect(nsToMs(12_345_678)).toBe(12.35);
    expect(nsToMs(0)).toBe(0);
  });
});

describe('the three entrypoints', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
  const CALL = /startEventLoopDelayPublisher\(\);/g;

  it('the web server starts it from register(), below the runtime gate', () => {
    const source = read('instrumentation.ts');
    expect(source.match(CALL)).toHaveLength(1);
    const gate = source.indexOf("if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;");
    expect(gate).toBeGreaterThan(-1);
    expect(source.indexOf("import('@/lib/monitoring/cloudwatchMetrics')")).toBeGreaterThan(gate);
  });

  it.each(['scripts/worker.ts', 'scripts/relay.ts'])(
    '%s starts it once in main(), not inside initMonitoring()',
    (path) => {
      const source = read(path);
      expect(source.match(CALL)).toHaveLength(1);
      const main = source.slice(source.indexOf('async function main(): Promise<void> {'));
      const firstLines = main.split('\n').slice(0, 8).join('\n');
      expect(firstLines).toContain('initMonitoring();');
      expect(firstLines).toMatch(CALL);
      const init = source.slice(
        source.indexOf('function initMonitoring(): void {'),
        source.indexOf('async function main(): Promise<void> {'),
      );
      expect(init).not.toContain('startEventLoopDelayPublisher');
    },
  );
});
