import { readFileSync } from 'node:fs';
import {
  PerformanceObserver,
  constants as perfConstants,
  type PerformanceEntry,
} from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

// WHAT HELD THE CPU WHILE THE LOOP WAS BLOCKED (MOTIR-8264).
//
// MOTIR-6701's tags prove a P2028 happened on a blocked event loop, and nothing
// more: on 2026-10-11 a warm machine with a free pool reported a 5.8 s block
// (MOTIR-8262), and three causes fit it equally well — a long GC pause, a heap
// near its limit, and the shared vCPU being taken away (throttled by the guest's
// own cgroup, or stolen by the host where the guest cannot see it). Each leaves
// a different reading, so this module attaches all of them to the same event:
//
//   - GC:       the longest pause, the total paused, and the major collections,
//               over the same two-window span the loop-delay tags read;
//   - heap:     used and limit, at the moment the event is tagged;
//   - throttle: the cgroup v2 `cpu.stat` counters, as a DELTA over the span;
//   - steal:    `/proc/stat`'s `steal` column, as a DELTA over the span.
//
// The blocking JS stack is the watchdog's (`./loopBlockWatchdog`), not this
// module's.
//
// ⚠️ MODULE-LOCAL STATE, ON PURPOSE. Like the event-loop monitor it rides on,
// this is started and read in the same module evaluation (the server's Sentry
// config, the worker's single bundle). Nothing here is written from a route, so
// it needs none of the `globalThis` registry `transactionStall.ts` keeps for the
// pool (MOTIR-7007), and `tests/monitoring/sentry-init-gate.test.ts`'s
// `vi.resetModules()` discards it like the loop monitor.
//
// ⚠️ AND IT NEVER CLAIMS A ZERO NOBODY MEASURED. A reading that could not be
// taken — no cgroup v2 file, no `/proc` (macOS), the monitor not started — reads
// `unmeasured`, the value `transactionStall.ts` already reports for the same
// case. A `0` is only ever a measurement: GC observed and none happened, a
// counter read at both ends and unchanged.

/** The tag keys, exported so the fix reading them and the tests agree. */
export const PROCESS_PRESSURE_TAG = {
  gcPauseMaxMs: 'tx.gc_pause_max_ms',
  gcPauseTotalMs: 'tx.gc_pause_total_ms',
  gcMajorCount: 'tx.gc_major_count',
  heapUsedMb: 'tx.heap_used_mb',
  heapLimitMb: 'tx.heap_limit_mb',
  cgroupNrThrottled: 'tx.cgroup_nr_throttled',
  cgroupThrottledMs: 'tx.cgroup_throttled_ms',
  cpuStealMs: 'tx.cpu_steal_ms',
} as const;

// The same value `transactionStall.ts` reports for a reading nobody took.
const UNMEASURED = 'unmeasured';

const CGROUP_CPU_STAT = '/sys/fs/cgroup/cpu.stat';
const PROC_STAT = '/proc/stat';

// `/proc/stat` counts in USER_HZ ticks. USER_HZ is fixed at 100 by the kernel
// ABI on x86-64 and arm64 Linux (what Fly runs) — an ASSUMPTION, since nothing in
// Node exposes `sysconf(_SC_CLK_TCK)`; a host with another value would report
// steal scaled by the ratio.
export const MS_PER_TICK = 1000 / 100;
const BYTES_PER_MIB = 1024 * 1024;

/** Reads one file's text, or null when it cannot be read. */
type FileReader = () => string | null;

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const defaultReaders = {
  readCgroupCpuStat: (() => readFileOrNull(CGROUP_CPU_STAT)) as FileReader,
  readProcStat: (() => readFileOrNull(PROC_STAT)) as FileReader,
};

let readers = { ...defaultReaders };

/**
 * Replace the cgroup / procfs readers — for tests, so the delta arithmetic and
 * the `unmeasured` arms are driven by fixture text rather than by whatever host
 * the suite happens to run on. `null` restores the real readers.
 */
export function setProcessPressureReadersForTest(
  next: Partial<{ readCgroupCpuStat: FileReader; readProcStat: FileReader }> | null,
): void {
  readers = next ? { ...defaultReaders, ...next } : { ...defaultReaders };
}

// ── CPU counters (throttle + steal) ──────────────────────────────────────────

interface CpuCounters {
  readonly nrThrottled: number | null;
  readonly throttledUsec: number | null;
  readonly stealTicks: number | null;
}

/** One `key value` line of cgroup v2 `cpu.stat`, or null when absent. */
function cpuStatField(text: string, key: string): number | null {
  const match = new RegExp(`^${key}\\s+(\\d+)\\s*$`, 'm').exec(text);
  return match ? Number(match[1]) : null;
}

/** The `steal` column — the 8th number — of `/proc/stat`'s aggregate `cpu` line. */
export function procStatSteal(text: string): number | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1);
  const steal = fields[7];
  return steal !== undefined && /^\d+$/.test(steal) ? Number(steal) : null;
}

function readCpuCounters(): CpuCounters {
  const cpuStat = readers.readCgroupCpuStat();
  const procStat = readers.readProcStat();
  return {
    nrThrottled: cpuStat === null ? null : cpuStatField(cpuStat, 'nr_throttled'),
    throttledUsec: cpuStat === null ? null : cpuStatField(cpuStat, 'throttled_usec'),
    stealTicks: procStat === null ? null : procStatSteal(procStat),
  };
}

// ── GC ───────────────────────────────────────────────────────────────────────

interface GcWindow {
  maxMs: number;
  totalMs: number;
  majorCount: number;
}

function emptyGcWindow(): GcWindow {
  return { maxMs: 0, totalMs: 0, majorCount: 0 };
}

function isMajorGc(entry: PerformanceEntry): boolean {
  const detail = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail;
  return detail?.kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR;
}

// ── The monitor ──────────────────────────────────────────────────────────────
//
// Two windows, rolled by the event-loop monitor's existing timer so there is one
// window clock in the process: the reported span is the current window plus the
// one before it, exactly the span `tx.event_loop_delay_*` reads. The counters
// keep the reading taken at the START of each of those windows, so a delta at tag
// time covers the same span — before the first roll, the start reading.

interface PressureState {
  readonly observer: PerformanceObserver;
  currentGc: GcWindow;
  previousGc: GcWindow | null;
  windowStart: CpuCounters;
  previousWindowStart: CpuCounters | null;
}

let state: PressureState | null = null;

/** Start observing GC and take the first counter reading. Idempotent. */
export function startProcessPressure(): void {
  if (state) return;
  const observer = new PerformanceObserver((list) => {
    if (!state) return;
    for (const entry of list.getEntries()) {
      const window = state.currentGc;
      window.maxMs = Math.max(window.maxMs, entry.duration);
      window.totalMs += entry.duration;
      if (isMajorGc(entry)) window.majorCount += 1;
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  state = {
    observer,
    currentGc: emptyGcWindow(),
    previousGc: null,
    windowStart: readCpuCounters(),
    previousWindowStart: null,
  };
}

/** Stop observing and forget every reading. Idempotent. */
export function stopProcessPressure(): void {
  if (!state) return;
  state.observer.disconnect();
  state = null;
}

/** Close the current window — called by the event-loop monitor's roll timer. */
export function rollProcessPressureWindow(): void {
  if (!state) return;
  state.previousGc = state.currentGc;
  state.currentGc = emptyGcWindow();
  state.previousWindowStart = state.windowStart;
  state.windowStart = readCpuCounters();
}

function delta(now: number | null, baseline: number | null): number | null {
  if (now === null || baseline === null) return null;
  return now - baseline;
}

function asTag(value: number | null): string {
  return value === null ? UNMEASURED : String(Math.round(value));
}

/**
 * The pressure tags, as strings (Sentry tags are). Every value is `unmeasured`
 * when the monitor is not running.
 */
export function processPressureTags(): Record<string, string> {
  if (!state) {
    return Object.fromEntries(Object.values(PROCESS_PRESSURE_TAG).map((key) => [key, UNMEASURED]));
  }
  const current = state.currentGc;
  const previous = state.previousGc ?? emptyGcWindow();
  const heap = getHeapStatistics();
  const now = readCpuCounters();
  const baseline = state.previousWindowStart ?? state.windowStart;
  const throttledUsec = delta(now.throttledUsec, baseline.throttledUsec);
  const stealTicks = delta(now.stealTicks, baseline.stealTicks);
  return {
    [PROCESS_PRESSURE_TAG.gcPauseMaxMs]: asTag(Math.max(current.maxMs, previous.maxMs)),
    [PROCESS_PRESSURE_TAG.gcPauseTotalMs]: asTag(current.totalMs + previous.totalMs),
    [PROCESS_PRESSURE_TAG.gcMajorCount]: asTag(current.majorCount + previous.majorCount),
    [PROCESS_PRESSURE_TAG.heapUsedMb]: asTag(heap.used_heap_size / BYTES_PER_MIB),
    [PROCESS_PRESSURE_TAG.heapLimitMb]: asTag(heap.heap_size_limit / BYTES_PER_MIB),
    [PROCESS_PRESSURE_TAG.cgroupNrThrottled]: asTag(delta(now.nrThrottled, baseline.nrThrottled)),
    [PROCESS_PRESSURE_TAG.cgroupThrottledMs]: asTag(
      throttledUsec === null ? null : throttledUsec / 1000,
    ),
    [PROCESS_PRESSURE_TAG.cpuStealMs]: asTag(stealTicks === null ? null : stealTicks * MS_PER_TICK),
  };
}
