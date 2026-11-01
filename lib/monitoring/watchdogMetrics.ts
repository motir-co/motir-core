import { readFileSync } from 'node:fs';
import { emitEmfLine, readCloudWatchSettings, type CloudWatchSettings } from './cloudwatchMetrics';
import {
  startLoopBlockWatchdog,
  stopLoopBlockWatchdog,
  takeCompletedBlockLengths,
} from './loopBlockWatchdog';
import { MS_PER_TICK, procStatSteal } from './processPressure';

// LOOP-BLOCK LENGTH AND CPU STEAL AS CLOUDWATCH METRICS (MOTIR-9882).
//
// Two series a delay histogram cannot give, written as EMF lines through
// `emitEmfLine` beside the event-loop delay (MOTIR-9881), on the same
// `MONITORING_CLOUDWATCH_NAMESPACE` and `Service` dimension:
//   - `LoopBlockMaxMs` and `LoopBlockCount`: every block over the watchdog's
//     threshold that ENDED in the interval, read from the watchdog's per-block
//     length seam (`takeCompletedBlockLengths`). An interval with no ended block
//     writes no line — the alarm treats missing data as not breaching.
//   - `CpuStealMs`: the growth of `/proc/stat`'s steal counter over the interval,
//     only when `MONITORING_CLOUDWATCH_STEAL` is `true` or `1` and the first read
//     finds the counter. MOTIR-9880 read it live on a Fargate task (`reported`);
//     the task definition, not this code, decides whether the setting is on.
//
// ⚠️ THE WATCHDOG IS STARTED HERE, NOT ONLY UNDER SENTRY. A Fargate task may run
// with no DSN, and `startTransactionStallMonitor()` (the only other starter) runs
// only with one. `startLoopBlockWatchdog()` is idempotent, so whichever runs
// first starts the thread. `rollLoopBlockWindow()` is never called from here: its
// windows belong to the Sentry tags and are left exactly as they were.
//
// ⚠️ UNSET MEANS NOTHING: no thread, no timer, no line. One publisher per
// process, on `globalThis` (the MOTIR-7007 rule), as the delay publisher does.

export const WATCHDOG_METRICS_INTERVAL_MS = 60_000;

const PUBLISHER_KEY = Symbol.for('motir.watchdogMetrics.publisher');
const PROC_STAT = '/proc/stat';

type Env = Readonly<Record<string, string | undefined>>;
type ProcStatReader = () => string | null;

export interface WatchdogMetricsPublisher {
  readonly settings: CloudWatchSettings;
  readonly timer: NodeJS.Timeout;
  /** True while CPU steal is being published. */
  stealActive: boolean;
}

interface PublisherState extends WatchdogMetricsPublisher {
  previousSteal: number | null;
  stealWarned: boolean;
}

type Holder = { [PUBLISHER_KEY]?: PublisherState };

function readProcStatFile(): string | null {
  try {
    return readFileSync(PROC_STAT, 'utf8');
  } catch {
    return null;
  }
}

let readProcStat: ProcStatReader = readProcStatFile;

function stealSettingOn(env: Env): boolean {
  const value = env['MONITORING_CLOUDWATCH_STEAL']?.trim().toLowerCase();
  return value === 'true' || value === '1';
}

function readStealTicks(): number | null {
  const text = readProcStat();
  return text === null ? null : procStatSteal(text);
}

function warnStealUnreadable(state: PublisherState): void {
  if (state.stealWarned) return;
  state.stealWarned = true;
  console.warn(
    `[watchdogMetrics] MONITORING_CLOUDWATCH_STEAL is on but ${PROC_STAT} reports no steal counter; publishing no CpuStealMs.`,
  );
}

function emitBlocks(settings: CloudWatchSettings): void {
  const lengths = takeCompletedBlockLengths();
  if (lengths.length === 0) return;
  emitEmfLine(settings.namespace, { Service: settings.service }, [
    { name: 'LoopBlockMaxMs', unit: 'Milliseconds', value: Math.max(...lengths) },
    { name: 'LoopBlockCount', unit: 'Count', value: lengths.length },
  ]);
}

function emitSteal(state: PublisherState): void {
  if (!state.stealActive) return;
  const current = readStealTicks();
  if (current === null) {
    warnStealUnreadable(state);
    return;
  }
  const previous = state.previousSteal;
  state.previousSteal = current;
  // A counter that went backwards (a reset) has no delta for this interval; the
  // next one is measured from the new value.
  if (previous === null || current < previous) return;
  emitEmfLine(state.settings.namespace, { Service: state.settings.service }, [
    { name: 'CpuStealMs', unit: 'Milliseconds', value: (current - previous) * MS_PER_TICK },
  ]);
}

/**
 * Start publishing loop-block lengths (and, when switched on, CPU steal) when
 * `MONITORING_CLOUDWATCH_NAMESPACE` is set. Returns the publisher, or null when
 * the namespace is unset or blank. A second call returns the first publisher.
 */
export function startWatchdogMetricsPublisher(
  env: Env = process.env,
): WatchdogMetricsPublisher | null {
  const holder = globalThis as Holder;
  if (holder[PUBLISHER_KEY]) return holder[PUBLISHER_KEY];
  const settings = readCloudWatchSettings(env);
  if (!settings) return null;

  startLoopBlockWatchdog();
  const state: PublisherState = {
    settings,
    stealActive: false,
    previousSteal: null,
    stealWarned: false,
    timer: setInterval(() => {
      emitBlocks(settings);
      emitSteal(state);
    }, WATCHDOG_METRICS_INTERVAL_MS),
  };
  // Never keep a process alive for a measurement.
  state.timer.unref();
  if (stealSettingOn(env)) {
    state.previousSteal = readStealTicks();
    if (state.previousSteal === null) warnStealUnreadable(state);
    else state.stealActive = true;
  }
  holder[PUBLISHER_KEY] = state;
  return state;
}

/** Tests only: stop the publisher and the watchdog it started, and forget both. */
export async function stopWatchdogMetricsPublisherForTests(): Promise<void> {
  const holder = globalThis as Holder;
  const state = holder[PUBLISHER_KEY];
  delete holder[PUBLISHER_KEY];
  if (state) clearInterval(state.timer);
  await stopLoopBlockWatchdog();
}

/** Tests only: read `/proc/stat` text from `reader`; null restores the real file. */
export function setProcStatReaderForTests(reader: ProcStatReader | null): void {
  readProcStat = reader ?? readProcStatFile;
}
