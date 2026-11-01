import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __forTests,
  isLoopBlockWatchdogRunning,
  startLoopBlockWatchdog,
} from '@/lib/monitoring/loopBlockWatchdog';
import { stopEventLoopDelayPublisherForTests } from '@/lib/monitoring/cloudwatchMetrics';
import {
  WATCHDOG_METRICS_INTERVAL_MS,
  setProcStatReaderForTests,
  startWatchdogMetricsPublisher,
  stopWatchdogMetricsPublisherForTests,
} from '@/lib/monitoring/watchdogMetrics';

// MOTIR-9882 — each ended loop block's length and (opt-in) CPU steal as
// CloudWatch EMF lines: nothing when the namespace is unset, a block series
// only for an interval in which a block ended, and steal only when switched on
// and readable.

const SET = {
  MONITORING_CLOUDWATCH_NAMESPACE: 'Motir/Test',
  MONITORING_CLOUDWATCH_SERVICE: 'web',
};
const STEAL_ON = { ...SET, MONITORING_CLOUDWATCH_STEAL: 'true' };
const THRESHOLD_MS = 200;
const HEARTBEAT_MS = 100;

let written: string[];

/** `/proc/stat` text whose aggregate line carries `steal` in its eighth field. */
function procStat(steal: number | string): string {
  return `cpu  2080 0 1626 18727 480 0 66 ${steal} 0 0\ncpu0 1040 0 813 9363 240 0 33 46 0 0\n`;
}

function blockLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin: block the event loop
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lines(): Record<string, unknown>[] {
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function tick(): void {
  vi.advanceTimersByTime(WATCHDOG_METRICS_INTERVAL_MS);
}

beforeEach(async () => {
  await stopWatchdogMetricsPublisherForTests();
  stopEventLoopDelayPublisherForTests();
  setProcStatReaderForTests(null);
  __forTests.setThresholdMs(THRESHOLD_MS);
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  // The publisher's interval is faked. A case that needs real blocks starts the
  // watchdog first (`startRealWatchdog`), so its heartbeat runs on real time.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

/** Start the watchdog on real timers; the publisher's own start is then a no-op. */
function startRealWatchdog(): void {
  vi.useRealTimers();
  startLoopBlockWatchdog();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
}

afterEach(async () => {
  vi.useRealTimers();
  await stopWatchdogMetricsPublisherForTests();
  stopEventLoopDelayPublisherForTests();
  setProcStatReaderForTests(null);
  __forTests.setThresholdMs(null);
  vi.restoreAllMocks();
});

describe('with the namespace unset or blank', () => {
  it.each([{}, { MONITORING_CLOUDWATCH_NAMESPACE: ' ' }])(
    'starts no thread, no timer and writes nothing (%o)',
    (env) => {
      const reader = vi.fn(() => procStat(1));
      setProcStatReaderForTests(reader);
      expect(startWatchdogMetricsPublisher({ ...env, MONITORING_CLOUDWATCH_STEAL: 'true' })).toBe(
        null,
      );
      for (let i = 0; i < 5; i += 1) tick();
      expect(isLoopBlockWatchdogRunning()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(written).toEqual([]);
      expect(reader).not.toHaveBeenCalled();
    },
  );
});

describe('defaults', () => {
  it('reads process.env when no env is passed', () => {
    vi.stubEnv('MONITORING_CLOUDWATCH_NAMESPACE', '');
    expect(startWatchdogMetricsPublisher()).toBeNull();
    vi.unstubAllEnvs();
  });

  it('a stop with nothing running is a no-op', async () => {
    await expect(stopWatchdogMetricsPublisherForTests()).resolves.toBeUndefined();
  });
});

describe('loop-block length', () => {
  it('publishes the interval’s ended blocks once, and nothing for a quiet interval', async () => {
    startRealWatchdog();
    const publisher = startWatchdogMetricsPublisher(SET);
    expect(publisher).not.toBeNull();
    expect(isLoopBlockWatchdogRunning()).toBe(true);
    await sleep(300);

    blockLoop(600);
    await sleep(300);
    blockLoop(400);
    await sleep(300);
    tick();

    expect(written).toHaveLength(1);
    const [line] = lines();
    const aws = line!['_aws'] as {
      CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: unknown[] }[];
    };
    expect(aws.CloudWatchMetrics[0]!.Namespace).toBe('Motir/Test');
    expect(aws.CloudWatchMetrics[0]!.Dimensions).toEqual([['Service']]);
    expect(aws.CloudWatchMetrics[0]!.Metrics).toEqual([
      { Name: 'LoopBlockMaxMs', Unit: 'Milliseconds' },
      { Name: 'LoopBlockCount', Unit: 'Count' },
    ]);
    expect(line!['Service']).toBe('web');
    expect(line!['LoopBlockMaxMs']).toBeGreaterThanOrEqual(600 - HEARTBEAT_MS);
    expect(line!['LoopBlockCount']).toBe(2);

    await sleep(200);
    tick();
    expect(written).toHaveLength(1);
  });

  it('keeps one publisher per process, and never keeps the process alive', () => {
    startRealWatchdog();
    const first = startWatchdogMetricsPublisher(SET);
    expect(startWatchdogMetricsPublisher({ ...SET, MONITORING_CLOUDWATCH_SERVICE: 'relay' })).toBe(
      first,
    );
    expect(vi.getTimerCount()).toBe(1);
    expect(first!.timer.hasRef()).toBe(false);
  });

  it('the stop clears the timer, the holder and the thread', async () => {
    const first = startWatchdogMetricsPublisher(SET);
    await stopWatchdogMetricsPublisherForTests();
    expect(vi.getTimerCount()).toBe(0);
    expect(isLoopBlockWatchdogRunning()).toBe(false);
    expect(startWatchdogMetricsPublisher(SET)).not.toBe(first);
  });
});

describe('a blank service', () => {
  it('warns once per process, beside the delay publisher', async () => {
    const { startEventLoopDelayPublisher } = await import('@/lib/monitoring/cloudwatchMetrics');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { ...SET, MONITORING_CLOUDWATCH_SERVICE: '' };
    startEventLoopDelayPublisher(env);
    expect(startWatchdogMetricsPublisher(env)!.settings.service).toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('CPU steal', () => {
  it.each([{}, { MONITORING_CLOUDWATCH_STEAL: 'yes' }, { MONITORING_CLOUDWATCH_STEAL: '0' }])(
    'never reads /proc/stat with the setting off (%o)',
    (extra) => {
      const reader = vi.fn(() => procStat(1));
      setProcStatReaderForTests(reader);
      startWatchdogMetricsPublisher({ ...SET, ...extra });
      tick();
      tick();
      expect(reader).not.toHaveBeenCalled();
      expect(written.some((line) => line.includes('CpuStealMs'))).toBe(false);
    },
  );

  it('publishes the counter’s growth in ms, and skips an interval where it fell', () => {
    const values = [100, 137, 120, 150];
    setProcStatReaderForTests(() => procStat(values.shift()!));
    startWatchdogMetricsPublisher({ ...SET, MONITORING_CLOUDWATCH_STEAL: '1' });
    tick();
    tick();
    tick();

    const steal = lines().filter((line) => 'CpuStealMs' in line);
    expect(steal.map((line) => line['CpuStealMs'])).toEqual([370, 300]);
    const aws = steal[0]!['_aws'] as { CloudWatchMetrics: { Metrics: unknown[] }[] };
    expect(aws.CloudWatchMetrics[0]!.Metrics).toEqual([
      { Name: 'CpuStealMs', Unit: 'Milliseconds' },
    ]);
    expect(steal[0]!['Service']).toBe('web');
  });

  it.each([
    ['absent', () => null],
    ['without an eighth field', () => 'cpu  1 2 3 4 5 6 7\n'],
    ['with a non-numeric eighth field', () => procStat('x')],
  ])('warns once and publishes nothing when /proc/stat is %s', (_label, reader) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setProcStatReaderForTests(reader);
    const publisher = startWatchdogMetricsPublisher(STEAL_ON);
    tick();
    tick();
    expect(publisher!.stealActive).toBe(false);
    expect(written).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once when a readable counter later becomes unreadable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const values: (string | null)[] = [procStat(10), null, null, procStat(20)];
    setProcStatReaderForTests(() => values.shift() ?? null);
    startWatchdogMetricsPublisher(STEAL_ON);
    tick();
    tick();
    tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(lines().map((line) => line['CpuStealMs'])).toEqual([100]);
  });

  it('reads the real /proc/stat by default', () => {
    const publisher = startWatchdogMetricsPublisher(STEAL_ON);
    // Linux reports the counter; anything else reads as unreadable.
    expect(typeof publisher!.stealActive).toBe('boolean');
  });
});

describe('the three entrypoints', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it.each(['instrumentation.ts', 'scripts/worker.ts', 'scripts/relay.ts'])(
    '%s calls it once, directly after the delay publisher',
    (path) => {
      const source = read(path);
      expect(source.match(/startWatchdogMetricsPublisher\(\);/g)).toHaveLength(1);
      expect(source).toMatch(
        /startEventLoopDelayPublisher\(\);\n(?:\s*(?:\/\/.*|const \{ startWatchdogMetricsPublisher \}[^\n]*)\n)*\s*startWatchdogMetricsPublisher\(\);/,
      );
      const init = source.indexOf('function initMonitoring(): void {');
      if (init >= 0) {
        const body = source.slice(init, source.indexOf('async function main(): Promise<void> {'));
        expect(body).not.toContain('startWatchdogMetricsPublisher');
      }
    },
  );
});
