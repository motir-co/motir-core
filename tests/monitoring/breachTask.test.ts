import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREACH_EXIT_REFUSED,
  CGROUP_V1_CPU_PERIOD,
  CGROUP_V1_CPU_QUOTA,
  CGROUP_V1_MEMORY_LIMIT,
  CGROUP_V2_CPU_MAX,
  CGROUP_V2_MEMORY_MAX,
  MEMORY_STEP_BYTES,
  breachWorkerCount,
  busyBlock,
  logBreachEvent,
  parseBreachArgs,
  readBreachFile,
  readCpuQuota,
  readMemoryLimitBytes,
  realClock,
  resolveMemoryLimit,
  runBreachCommand,
  runCpuBreach,
  runLoopBreach,
  runMemoryBreach,
  type BreachSystem,
  type BreachWorker,
} from '@/lib/monitoring/breachTask';
import {
  EMF_INTERVAL_MS,
  startEventLoopDelayPublisher,
  stopEventLoopDelayPublisherForTests,
} from '@/lib/monitoring/cloudwatchMetrics';

// MOTIR-9884 — the rehearsal breach: inert without its guard, refused on any bad
// argument, bounded in time, and never past 95 percent of the memory limit. The
// modes are driven with a fake clock, allocator and worker factory; one case
// blocks the real loop for 300 ms and reads it back from the delay publisher.

const GUARD = { MOTIR_BREACH_ENABLED: 'true' };
const MB = 1024 * 1024;
const GB = 1024 * MB;

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function files(contents: Record<string, string>) {
  return (path: string) => contents[path] ?? null;
}

function fakeWorker(): BreachWorker & { terminated: number; fail: (e: Error) => void } {
  const listeners: ((e: Error) => void)[] = [];
  const worker = {
    terminated: 0,
    on: (_event: 'error', listener: (e: Error) => void) => {
      listeners.push(listener);
      return worker;
    },
    terminate: async () => {
      worker.terminated += 1;
      return 1;
    },
    fail: (e: Error) => listeners.forEach((listener) => listener(e)),
  };
  return worker;
}

describe('parseBreachArgs', () => {
  it.each<[string, string[], Record<string, string | undefined>]>([
    ['the guard unset', ['cpu'], {}],
    ['the guard not "true"', ['cpu'], { MOTIR_BREACH_ENABLED: '1' }],
    ['no mode', [], GUARD],
    ['an unknown mode', ['disk'], GUARD],
    ['--seconds above 900', ['cpu', '--seconds', '901'], GUARD],
    ['--seconds below 1', ['cpu', '--seconds', '0'], GUARD],
    ['--seconds not a number', ['cpu', '--seconds', '1e2'], GUARD],
    ['memory without --percent', ['memory'], GUARD],
    ['memory --percent 0', ['memory', '--percent', '0'], GUARD],
    ['memory --percent 96', ['memory', '--percent=96'], GUARD],
    ['memory --limit-mb 0', ['memory', '--percent', '50', '--limit-mb', '0'], GUARD],
    ['loop without --block-ms', ['loop'], GUARD],
    ['loop --block-ms 99', ['loop', '--block-ms', '99'], GUARD],
    ['loop --block-ms 20001', ['loop', '--block-ms', '20001'], GUARD],
    ['an unknown flag', ['cpu', '--force'], GUARD],
    ['a flag of another mode', ['cpu', '--percent', '50'], GUARD],
    ['a flag given twice', ['cpu', '--seconds', '10', '--seconds=20'], GUARD],
    ['a flag with no value', ['loop', '--block-ms'], GUARD],
    ['a flag with an empty value', ['loop', '--block-ms='], GUARD],
  ])('refuses with exit code 2: %s', (_label, argv, env) => {
    const result = parseBreachArgs(argv, env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(BREACH_EXIT_REFUSED);
    expect(result.reason).not.toContain('\n');
  });

  it('refuses without the guard before judging the arguments', () => {
    const result = parseBreachArgs(['memory', '--percent', '50'], {});
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('MOTIR_BREACH_ENABLED'),
    });
  });

  it('returns the typed command, --seconds defaulting to 300, the same for the same input', () => {
    expect(parseBreachArgs(['cpu'], GUARD)).toEqual({
      ok: true,
      command: { mode: 'cpu', seconds: 300 },
    });
    expect(parseBreachArgs(['loop', '--block-ms', '1500', '--seconds=900'], GUARD)).toEqual({
      ok: true,
      command: { mode: 'loop', seconds: 900, blockMs: 1500 },
    });
    const memory = ['memory', '--percent', '95', '--limit-mb', '2048', '--seconds', '1'];
    expect(parseBreachArgs(memory, GUARD)).toEqual({
      ok: true,
      command: { mode: 'memory', seconds: 1, percent: 95, limitMb: 2048 },
    });
    expect(parseBreachArgs(memory, GUARD)).toEqual(parseBreachArgs(memory, GUARD));
    expect(parseBreachArgs(['memory', '--percent', '1'], GUARD)).toMatchObject({
      command: { limitMb: null, seconds: 300 },
    });
  });
});

describe('memory limit discovery', () => {
  const HOST = 8 * GB;

  it('reads cgroup v2 memory.max', () => {
    expect(readMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: `${2 * GB}\n` }), HOST)).toBe(
      2 * GB,
    );
  });

  it('treats v2 `max` as no limit, without reading v1', () => {
    const read = vi.fn(files({ [CGROUP_V2_MEMORY_MAX]: 'max\n', [CGROUP_V1_MEMORY_LIMIT]: '1' }));
    expect(readMemoryLimitBytes(read, HOST)).toBeNull();
    expect(read).not.toHaveBeenCalledWith(CGROUP_V1_MEMORY_LIMIT);
  });

  it('falls back to cgroup v1, whose unlimited sentinel is above the host total', () => {
    expect(readMemoryLimitBytes(files({ [CGROUP_V1_MEMORY_LIMIT]: `${GB}` }), HOST)).toBe(GB);
    expect(
      readMemoryLimitBytes(files({ [CGROUP_V1_MEMORY_LIMIT]: '9223372036854771712' }), HOST),
    ).toBeNull();
  });

  it.each(['', '0', 'garbage'])('treats %o as no limit', (text) => {
    expect(readMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: text }), HOST)).toBeNull();
  });

  it('reads nothing as no limit, and the real files by default', () => {
    expect(readMemoryLimitBytes(files({}), HOST)).toBeNull();
    const real = readMemoryLimitBytes();
    expect(real === null || real > 0).toBe(true);
  });

  it('then requires --limit-mb, and takes the lower of the two', () => {
    const command = { mode: 'memory', seconds: 1, percent: 50, limitMb: null } as const;
    expect(resolveMemoryLimit(command, null)).toMatchObject({
      ok: false,
      exitCode: BREACH_EXIT_REFUSED,
    });
    expect(resolveMemoryLimit(command, GB)).toEqual({ ok: true, limitBytes: GB });
    expect(resolveMemoryLimit({ ...command, limitMb: 512 }, null)).toEqual({
      ok: true,
      limitBytes: 512 * MB,
    });
    expect(resolveMemoryLimit({ ...command, limitMb: 512 }, GB)).toEqual({
      ok: true,
      limitBytes: 512 * MB,
    });
    expect(resolveMemoryLimit({ ...command, limitMb: 4096 }, GB)).toEqual({
      ok: true,
      limitBytes: GB,
    });
  });
});

describe('CPU count', () => {
  it.each<[string, Record<string, string>, number | null]>([
    ['a v2 quota of two CPUs', { [CGROUP_V2_CPU_MAX]: '200000 100000\n' }, 2],
    ['a fractional v2 quota, rounded up', { [CGROUP_V2_CPU_MAX]: '150000 100000' }, 2],
    ['v2 `max`', { [CGROUP_V2_CPU_MAX]: 'max 100000' }, null],
    ['a v2 period of 0', { [CGROUP_V2_CPU_MAX]: '100000 0' }, null],
    ['a v1 quota', { [CGROUP_V1_CPU_QUOTA]: '50000', [CGROUP_V1_CPU_PERIOD]: '100000' }, 1],
    ['a v1 quota of -1', { [CGROUP_V1_CPU_QUOTA]: '-1', [CGROUP_V1_CPU_PERIOD]: '100000' }, null],
    ['no cgroup files', {}, null],
  ])('reads %s', (_label, contents, quota) => {
    expect(readCpuQuota(files(contents))).toBe(quota);
  });

  it('takes the lower of the parallelism and the quota, and at least one', () => {
    expect(breachWorkerCount(8, 2)).toBe(2);
    expect(breachWorkerCount(2, 4)).toBe(2);
    expect(breachWorkerCount(4, null)).toBe(4);
    expect(breachWorkerCount(0, null)).toBe(1);
    expect(readCpuQuota() === null || (readCpuQuota() as number) > 0).toBe(true);
  });
});

describe('runMemoryBreach', () => {
  function memory(startRss: number, msPerStep = 0) {
    const clock = fakeClock();
    let rss = startRss;
    const allocate = vi.fn((bytes: number) => {
      rss += bytes;
      clock.advance(msPerStep);
      return { bytes };
    });
    return { clock, allocate, rssBytes: () => rss };
  }

  it('grows in 16 MB steps to the target, passes it by at most one step, holds, and resolves', async () => {
    const deps = memory(100 * MB);
    const limit = 1000 * MB + 7;
    const result = await runMemoryBreach({ seconds: 60, percent: 50 }, limit, deps);

    const target = Math.floor(limit / 2);
    expect(result.targetBytes).toBe(target);
    expect(deps.allocate.mock.calls.every(([bytes]) => bytes === MEMORY_STEP_BYTES)).toBe(true);
    expect(result.steps).toBe(deps.allocate.mock.calls.length);
    expect(result.peakRssBytes).toBeGreaterThanOrEqual(target);
    expect(result.peakRssBytes).toBeLessThan(target + MEMORY_STEP_BYTES);
    expect(deps.clock.sleeps).toEqual([60_000]);
  });

  it('allocates nothing when the resident set is already at the target', async () => {
    const deps = memory(900 * MB);
    const result = await runMemoryBreach({ seconds: 5, percent: 50 }, 1000 * MB, deps);
    expect(result.steps).toBe(0);
    expect(deps.clock.sleeps).toEqual([5_000]);
  });

  it('stops growing, and does not sleep, when the time is up first', async () => {
    const deps = memory(0, 400);
    const result = await runMemoryBreach({ seconds: 1, percent: 95 }, 64 * GB, deps);
    expect(result.steps).toBe(3);
    expect(deps.clock.sleeps).toEqual([]);
  });

  it.each([0, 96])('never targets %i percent', async (percent) => {
    await expect(runMemoryBreach({ seconds: 1, percent }, GB, memory(0))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('runCpuBreach', () => {
  it('starts one worker per CPU, holds for the time, then terminates every one', async () => {
    const clock = fakeClock();
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const result = await runCpuBreach(
      { seconds: 30 },
      {
        clock,
        workerCount: 3,
        createWorker: () => {
          const worker = fakeWorker();
          workers.push(worker);
          return worker;
        },
      },
    );
    expect(result).toEqual({ workers: 3, workerErrors: 0 });
    expect(clock.sleeps).toEqual([30_000]);
    expect(workers.map((w) => w.terminated)).toEqual([1, 1, 1]);
  });

  it('counts a worker that errors, and still terminates them all', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const clock = fakeClock();
    const result = await runCpuBreach(
      { seconds: 1 },
      {
        clock: {
          ...clock,
          sleep: async (ms) => {
            workers[1]!.fail(new Error('boom'));
            await clock.sleep(ms);
          },
        },
        workerCount: 2,
        createWorker: () => {
          const worker = fakeWorker();
          workers.push(worker);
          return worker;
        },
      },
    );
    expect(result).toEqual({ workers: 2, workerErrors: 1 });
    expect(workers.map((w) => w.terminated)).toEqual([1, 1]);
  });

  it('terminates the started workers when starting one throws', async () => {
    const started = [fakeWorker()];
    let calls = 0;
    await expect(
      runCpuBreach(
        { seconds: 1 },
        {
          clock: fakeClock(),
          workerCount: 3,
          createWorker: () => {
            calls += 1;
            if (calls === 2) throw new Error('no thread');
            return started[0]!;
          },
        },
      ),
    ).rejects.toThrow('no thread');
    expect(started[0]!.terminated).toBe(1);
  });
});

describe('runLoopBreach', () => {
  function loop() {
    const clock = fakeClock(0);
    const events: string[] = [];
    const blockedAt: number[] = [];
    return {
      clock,
      events,
      blockedAt,
      startPublishers: () => events.push('publishers'),
      block: (ms: number) => {
        events.push(`block ${String(ms)}`);
        blockedAt.push(clock.now());
        clock.advance(ms);
      },
    };
  }

  it('starts the publishers, lets them arm, blocks for exactly the ms every 5 s, and ends on time', async () => {
    const deps = loop();
    const result = await runLoopBreach({ seconds: 20, blockMs: 1000 }, deps);
    expect(deps.events[0]).toBe('publishers');
    expect(deps.events.slice(1)).toEqual(Array(4).fill('block 1000'));
    expect(deps.blockedAt).toEqual([1000, 6000, 11_000, 16_000]);
    expect(deps.clock.sleeps).toEqual([1000, 4000, 4000, 4000, 3000]);
    expect(deps.clock.now()).toBe(20_000);
    expect(result).toEqual({ blocks: 4 });
  });

  it('keeps an idle gap after a block longer than the period, and starts none past the end', async () => {
    const deps = loop();
    const result = await runLoopBreach({ seconds: 20, blockMs: 6000 }, deps);
    expect(deps.blockedAt).toEqual([1000, 8000]);
    expect(deps.clock.sleeps).toEqual([1000, 1000, 1000, 5000]);
    expect(deps.clock.now()).toBe(20_000);
    expect(result).toEqual({ blocks: 2 });
  });

  it('blocks nothing when one block does not fit, and still waits out the time', async () => {
    const deps = loop();
    const result = await runLoopBreach({ seconds: 1, blockMs: 2000 }, deps);
    expect(result).toEqual({ blocks: 0 });
    expect(deps.clock.sleeps).toEqual([1000]);
  });

  describe('on the real loop', () => {
    let written: string[];

    beforeEach(() => {
      stopEventLoopDelayPublisherForTests();
      written = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(() => {
      stopEventLoopDelayPublisherForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('a 300 ms block reaches the delay publisher’s next line as EventLoopDelayMaxMs ≥ 250', async () => {
      const result = await runLoopBreach(
        { seconds: 2, blockMs: 300 },
        {
          clock: realClock,
          block: busyBlock,
          startPublishers: () => {
            startEventLoopDelayPublisher({
              MONITORING_CLOUDWATCH_NAMESPACE: 'Motir/Test',
              MONITORING_CLOUDWATCH_SERVICE: 'rehearsal',
            });
          },
        },
      );
      vi.advanceTimersByTime(EMF_INTERVAL_MS);

      expect(result).toEqual({ blocks: 1 });
      const [line] = written.map((text) => JSON.parse(text) as Record<string, unknown>);
      expect(line!['Service']).toBe('rehearsal');
      expect(line!['EventLoopDelayMaxMs']).toBeGreaterThanOrEqual(250);
    });
  });
});

describe('runBreachCommand', () => {
  function system(overrides: Partial<BreachSystem> = {}) {
    const clock = fakeClock();
    const out: string[] = [];
    const err: string[] = [];
    const workers: ReturnType<typeof fakeWorker>[] = [];
    let rss = 0;
    const sys = {
      clock,
      write: (line: string) => out.push(line),
      writeError: (line: string) => err.push(line),
      readFile: files({ [CGROUP_V2_MEMORY_MAX]: `${GB}`, [CGROUP_V2_CPU_MAX]: '200000 100000' }),
      hostTotalBytes: 8 * GB,
      availableParallelism: 8,
      allocate: vi.fn((bytes: number) => {
        rss += bytes;
        return null;
      }),
      rssBytes: () => rss,
      createWorker: vi.fn(() => {
        const worker = fakeWorker();
        workers.push(worker);
        return worker;
      }),
      block: vi.fn((ms: number) => clock.advance(ms)),
      startPublishers: vi.fn(),
      armDeadline: vi.fn(),
      ...overrides,
    };
    return { sys, clock, out, err, workers };
  }

  it('refuses with exit code 2 and one line on stderr, doing no work', async () => {
    const { sys, out, err } = system();
    expect(await runBreachCommand(['memory', '--percent', '50'], {}, sys)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^breach: refused: MOTIR_BREACH_ENABLED/);
    expect(sys.allocate).not.toHaveBeenCalled();
    expect(sys.armDeadline).not.toHaveBeenCalled();
  });

  it('refuses memory mode when no limit is known and no --limit-mb is given', async () => {
    const { sys, out, err } = system({ readFile: files({}) });
    expect(await runBreachCommand(['memory', '--percent', '50'], GUARD, sys)).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toContain('--limit-mb');
    expect(sys.allocate).not.toHaveBeenCalled();
  });

  it.each<[string, string[], Record<string, unknown>]>([
    [
      'memory',
      ['memory', '--percent', '50', '--seconds', '10'],
      { percent: 50, limitBytes: GB, targetBytes: GB / 2 },
    ],
    ['cpu', ['cpu', '--seconds', '10'], { workerCount: 2, workers: 2, workerErrors: 0 }],
    ['loop', ['loop', '--block-ms', '1000', '--seconds', '10'], { blockMs: 1000, blocks: 2 }],
  ])(
    '%s writes one start and one end JSON line and exits 0 within its time',
    async (mode, argv, expected) => {
      const { sys, out, err, workers } = system();
      expect(await runBreachCommand(argv, GUARD, sys)).toBe(0);
      expect(err).toEqual([]);
      expect(out).toHaveLength(2);
      const [start, end] = out.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(start).toMatchObject({ breach: 'start', mode, seconds: 10 });
      expect(typeof start!['startedAt']).toBe('string');
      expect(end).toMatchObject({ breach: 'end', mode, seconds: 10, ...expected });
      expect(end!['durationMs']).toBeLessThanOrEqual(10_000);
      expect(sys.armDeadline).toHaveBeenCalledWith(15_000);
      expect(workers.every((w) => w.terminated === 1)).toBe(true);
    },
  );

  it('the loop mode starts the publishers before its first block', async () => {
    const order: string[] = [];
    const { sys, clock } = system();
    await runBreachCommand(['loop', '--block-ms', '100', '--seconds', '2'], GUARD, {
      ...sys,
      startPublishers: () => order.push('publishers'),
      block: (ms) => {
        order.push('block');
        clock.advance(ms);
      },
    });
    expect(order).toEqual(['publishers', 'block']);
  });
});

describe('logBreachEvent and the real helpers', () => {
  it('writes one JSON line through stdout by default', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    logBreachEvent('start', { mode: 'cpu', seconds: 1 });
    expect(write).toHaveBeenCalledWith('{"breach":"start","mode":"cpu","seconds":1}\n');
    write.mockRestore();
  });

  it('busyBlock holds the loop for the ms; the real clock sleeps; the reader returns null for a missing file', async () => {
    const start = Date.now();
    busyBlock(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    const before = realClock.now();
    await realClock.sleep(5);
    expect(realClock.now()).toBeGreaterThanOrEqual(before + 4);
    expect(readBreachFile('/nonexistent/motir-breach')).toBeNull();
    expect(readBreachFile(join(process.cwd(), 'package.json'))).toContain('build:breach');
  });
});

describe('wiring', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

  it('the script starts both publishers for the loop mode', () => {
    const source = read('scripts/breach.ts');
    expect(source).toMatch(
      /startEventLoopDelayPublisher\(\);\s*startWatchdogMetricsPublisher\(\);/,
    );
  });

  it.each(['instrumentation.ts', 'scripts/worker.ts', 'scripts/relay.ts'])(
    '%s never starts the breach',
    (path) => {
      expect(read(path)).not.toMatch(/breach/i);
    },
  );

  it('the Dockerfile builds the bundle and copies it to /app/breach', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('RUN pnpm build:breach');
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=nextjs:nodejs /app/.breach/breach.mjs ./breach/breach.mjs',
    );
  });

  it('the settings reference lists the guard as rehearsal-only', () => {
    expect(read('.env.example')).toMatch(/MOTIR_BREACH_ENABLED\s+REHEARSAL-ONLY/);
  });
});
