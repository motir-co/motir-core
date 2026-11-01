import { readFileSync } from 'node:fs';
import os from 'node:os';

// A DELIBERATE, BOUNDED BREACH (MOTIR-9884).
//
// The CloudWatch alarms motir-infra builds (memory, CPU, event-loop block) are
// proven by a real breach on a rehearsal task, not by setting an alarm's state by
// hand. `node breach/breach.mjs <memory|cpu|loop> [flags]` is that breach: run as
// an ECS one-off task of the core image, it pushes the task's memory past a
// percentage of its limit, holds every CPU it may use, or blocks its event loop,
// for a bounded time, and then ends by itself so the alarm returns to OK.
//
// ⚠️ INERT WITHOUT THE GUARD. Nothing happens unless `MOTIR_BREACH_ENABLED=true`
// is in the environment: a stray invocation on a production container exits 2
// with a one-line reason and allocates, spins and blocks nothing. So does an
// unknown mode or flag, a missing required flag and an out-of-range value.
//
// ⚠️ ALWAYS ENDS BY ITSELF. Every mode is bounded by `--seconds` (default 300, at
// most 900; a larger value is refused, never clamped), and the memory mode never
// targets more than 95 percent of the limit: an OOM kill would end the run
// without the clean OK the verification needs.
//
// The pure parts (parsing, limit discovery, the schedule) take their clock,
// allocator, worker factory and writer as arguments, so the tests drive them with
// fakes and never allocate gigabytes or spin cores. `scripts/breach.ts` is the
// thin argv wrapper the bundle runs.

export const BREACH_GUARD_ENV = 'MOTIR_BREACH_ENABLED';
export const BREACH_MODES = ['memory', 'cpu', 'loop'] as const;
export type BreachMode = (typeof BREACH_MODES)[number];

export const BREACH_DEFAULT_SECONDS = 300;
export const BREACH_MAX_SECONDS = 900;
export const BREACH_MAX_MEMORY_PERCENT = 95;
export const BREACH_MIN_BLOCK_MS = 100;
export const BREACH_MAX_BLOCK_MS = 20_000;
/** The size of one memory step: the target is never passed by more than this. */
export const MEMORY_STEP_BYTES = 16 * 1024 * 1024;
/** One loop block starts every this many milliseconds. */
export const LOOP_PERIOD_MS = 5_000;
/** The least idle time between two loop blocks, so timers (the publishers') run. */
export const LOOP_MIN_IDLE_MS = 1_000;
/**
 * The idle time between starting the publishers and the first block: the delay
 * histogram's timer and the watchdog's thread must be running before a block, or
 * they cannot see it.
 */
export const LOOP_WARMUP_MS = 1_000;

/** Every run is over this long after its `--seconds`, whatever it holds. */
export const BREACH_EXIT_GRACE_SECONDS = 5;

export const BREACH_EXIT_OK = 0;
export const BREACH_EXIT_REFUSED = 2;

const BYTES_PER_MB = 1024 * 1024;

export const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
export const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
export const CGROUP_V2_CPU_MAX = '/sys/fs/cgroup/cpu.max';
export const CGROUP_V1_CPU_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
export const CGROUP_V1_CPU_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

export type MemoryBreach = {
  readonly mode: 'memory';
  readonly seconds: number;
  readonly percent: number;
  /** The operator's limit, used when the cgroup reports none (and never above it). */
  readonly limitMb: number | null;
};
export type CpuBreach = { readonly mode: 'cpu'; readonly seconds: number };
export type LoopBreach = {
  readonly mode: 'loop';
  readonly seconds: number;
  readonly blockMs: number;
};
export type BreachCommand = MemoryBreach | CpuBreach | LoopBreach;

export type BreachRefusal = {
  readonly exitCode: typeof BREACH_EXIT_REFUSED;
  readonly reason: string;
};
export type BreachParse =
  | { readonly ok: true; readonly command: BreachCommand }
  | ({ readonly ok: false } & BreachRefusal);

type Env = Readonly<Record<string, string | undefined>>;

/** Reads one file's text, or null when it cannot be read. */
export type BreachFileReader = (path: string) => string | null;

export interface BreachClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Writes one complete line (the caller adds the newline). */
export type BreachWriter = (line: string) => void;

/** The part of a `worker_threads` Worker the CPU mode drives. */
export interface BreachWorker {
  on(event: 'error', listener: (error: Error) => void): unknown;
  terminate(): Promise<number>;
}

/** The flags each mode takes: anything else is refused. */
const MODE_FLAGS: Readonly<Record<BreachMode, readonly string[]>> = {
  memory: ['--seconds', '--percent', '--limit-mb'],
  cpu: ['--seconds'],
  loop: ['--seconds', '--block-ms'],
};

const USAGE =
  'usage: breach <memory --percent N [--limit-mb N] | cpu | loop --block-ms N> [--seconds N]';

function refuse(reason: string): BreachParse {
  return { ok: false, exitCode: BREACH_EXIT_REFUSED, reason };
}

const isMode = (value: string | undefined): value is BreachMode =>
  (BREACH_MODES as readonly (string | undefined)[]).includes(value);

/** A whole number written in decimal digits, or null. */
function wholeNumber(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * Read the command line (`argv` without node and the script) into a typed
 * command, or a refusal with exit code 2. The guard comes first, so without it
 * nothing about the arguments is even judged. The same input always gives the
 * same result.
 */
export function parseBreachArgs(argv: readonly string[], env: Env): BreachParse {
  if (env[BREACH_GUARD_ENV] !== 'true') {
    return refuse(`${BREACH_GUARD_ENV} is not "true"; the breach is a rehearsal-only command`);
  }
  const [mode, ...rest] = argv;
  if (!isMode(mode)) {
    return refuse(`${mode === undefined ? 'no mode' : `unknown mode "${mode}"`}; ${USAGE}`);
  }

  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (!MODE_FLAGS[mode].includes(name)) return refuse(`unknown flag "${name}" for ${mode}`);
    if (flags.has(name)) return refuse(`${name} is given twice`);
    const value = eq >= 0 ? arg.slice(eq + 1) : rest[(i += 1)];
    if (value === undefined || value === '') return refuse(`${name} needs a value`);
    flags.set(name, value);
  }

  const number = (name: string, min: number, max: number): number | string | null => {
    const text = flags.get(name);
    if (text === undefined) return null;
    const value = wholeNumber(text);
    if (value === null || value < min || value > max) {
      return `${name} must be a whole number from ${String(min)} to ${String(max)}, not "${text}"`;
    }
    return value;
  };

  const seconds = number('--seconds', 1, BREACH_MAX_SECONDS) ?? BREACH_DEFAULT_SECONDS;
  if (typeof seconds === 'string') return refuse(seconds);

  if (mode === 'cpu') return { ok: true, command: { mode, seconds } };

  if (mode === 'loop') {
    const blockMs = number('--block-ms', BREACH_MIN_BLOCK_MS, BREACH_MAX_BLOCK_MS);
    if (blockMs === null) return refuse('loop needs --block-ms');
    if (typeof blockMs === 'string') return refuse(blockMs);
    return { ok: true, command: { mode, seconds, blockMs } };
  }

  const percent = number('--percent', 1, BREACH_MAX_MEMORY_PERCENT);
  if (percent === null) return refuse('memory needs --percent');
  if (typeof percent === 'string') return refuse(percent);
  const limitMb = number('--limit-mb', 1, Number.MAX_SAFE_INTEGER);
  if (typeof limitMb === 'string') return refuse(limitMb);
  return { ok: true, command: { mode, seconds, percent, limitMb } };
}

/** A positive whole byte count, or null for `max`, garbage or a value no host has. */
function finiteLimit(text: string | null, hostTotalBytes: number): number | null {
  if (text === null) return null;
  const value = wholeNumber(text.trim());
  if (value === null || value === 0 || value > hostTotalBytes) return null;
  return value;
}

/**
 * The container's memory limit in bytes: cgroup v2 `memory.max`, else cgroup v1
 * `memory.limit_in_bytes`. Null when neither gives a finite limit: `max`, the
 * v1 "unlimited" sentinel, or anything above the host's total all read as none.
 */
export function readMemoryLimitBytes(
  readFile: BreachFileReader = readBreachFile,
  hostTotalBytes: number = os.totalmem(),
): number | null {
  const v2 = readFile(CGROUP_V2_MEMORY_MAX);
  if (v2 !== null) return finiteLimit(v2, hostTotalBytes);
  return finiteLimit(readFile(CGROUP_V1_MEMORY_LIMIT), hostTotalBytes);
}

/**
 * How many whole CPUs the cgroup quota grants (rounded up), or null when it sets
 * none: cgroup v2 `cpu.max` (`<quota> <period>` or `max <period>`), else v1's
 * `cfs_quota_us` / `cfs_period_us` (a quota of -1 is none).
 */
export function readCpuQuota(readFile: BreachFileReader = readBreachFile): number | null {
  const v2 = readFile(CGROUP_V2_CPU_MAX);
  const [quotaText, periodText] =
    v2 !== null
      ? v2.trim().split(/\s+/)
      : [readFile(CGROUP_V1_CPU_QUOTA)?.trim(), readFile(CGROUP_V1_CPU_PERIOD)?.trim()];
  const quota = wholeNumber(quotaText ?? '');
  const period = wholeNumber(periodText ?? '');
  if (quota === null || period === null || quota === 0 || period === 0) return null;
  return Math.ceil(quota / period);
}

/** The lower of the CPUs Node may use and the cgroup quota, and at least one. */
export function breachWorkerCount(availableParallelism: number, quota: number | null): number {
  return Math.max(1, Math.min(availableParallelism, quota ?? availableParallelism));
}

/**
 * The memory limit the run measures against: the cgroup's, and the operator's
 * `--limit-mb` where the cgroup sets none. When both exist the LOWER wins, so a
 * mistyped flag can only make the breach smaller, never push it into an OOM kill.
 */
export function resolveMemoryLimit(
  command: MemoryBreach,
  cgroupLimitBytes: number | null,
): { ok: true; limitBytes: number } | ({ ok: false } & BreachRefusal) {
  const flagBytes = command.limitMb === null ? null : command.limitMb * BYTES_PER_MB;
  if (cgroupLimitBytes === null && flagBytes === null) {
    return {
      ok: false,
      exitCode: BREACH_EXIT_REFUSED,
      reason: 'the cgroup reports no memory limit; give --limit-mb',
    };
  }
  const limits = [cgroupLimitBytes, flagBytes].filter((v): v is number => v !== null);
  return { ok: true, limitBytes: Math.min(...limits) };
}

/** Write one start or end line: a single JSON object naming the mode and parameters. */
export function logBreachEvent(
  event: 'start' | 'end',
  fields: Readonly<Record<string, unknown>>,
  write: BreachWriter = (line) => process.stdout.write(`${line}\n`),
): void {
  write(JSON.stringify({ breach: event, ...fields }));
}

export interface MemoryBreachDeps {
  readonly clock: BreachClock;
  /** Allocate and TOUCH `bytes`, so the pages count in the resident set. */
  readonly allocate: (bytes: number) => unknown;
  readonly rssBytes: () => number;
}

export interface MemoryBreachResult {
  readonly targetBytes: number;
  readonly steps: number;
  readonly peakRssBytes: number;
}

/**
 * Grow the resident set in 16 MB steps until it reaches `percent` of
 * `limitBytes` (passing it by at most one step), hold until the bounded time is
 * up, then drop every buffer.
 */
export async function runMemoryBreach(
  command: Pick<MemoryBreach, 'seconds' | 'percent'>,
  limitBytes: number,
  deps: MemoryBreachDeps,
): Promise<MemoryBreachResult> {
  if (command.percent < 1 || command.percent > BREACH_MAX_MEMORY_PERCENT) {
    throw new RangeError(
      `a memory breach targets 1 to ${String(BREACH_MAX_MEMORY_PERCENT)} percent`,
    );
  }
  const deadline = deps.clock.now() + command.seconds * 1000;
  const targetBytes = Math.floor((limitBytes * command.percent) / 100);
  let buffers: unknown[] = [];
  let peakRssBytes = deps.rssBytes();
  while (peakRssBytes < targetBytes && deps.clock.now() < deadline) {
    buffers.push(deps.allocate(MEMORY_STEP_BYTES));
    peakRssBytes = Math.max(peakRssBytes, deps.rssBytes());
  }
  const steps = buffers.length;
  const left = deadline - deps.clock.now();
  if (left > 0) await deps.clock.sleep(left);
  buffers = [];
  return { targetBytes, steps, peakRssBytes };
}

export interface CpuBreachDeps {
  readonly clock: BreachClock;
  readonly workerCount: number;
  /** A Worker running a busy loop forever. */
  readonly createWorker: () => BreachWorker;
}

export interface CpuBreachResult {
  readonly workers: number;
  readonly workerErrors: number;
}

/**
 * Hold `workerCount` CPUs with one busy Worker each for the bounded time, then
 * terminate every one of them, whether the time ran out or something threw. A
 * worker that errors is counted and the run carries on with the rest.
 */
export async function runCpuBreach(
  command: Pick<CpuBreach, 'seconds'>,
  deps: CpuBreachDeps,
): Promise<CpuBreachResult> {
  const workers: BreachWorker[] = [];
  let workerErrors = 0;
  try {
    for (let i = 0; i < deps.workerCount; i += 1) {
      const worker = deps.createWorker();
      worker.on('error', () => {
        workerErrors += 1;
      });
      workers.push(worker);
    }
    await deps.clock.sleep(command.seconds * 1000);
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
  return { workers: workers.length, workerErrors };
}

export interface LoopBreachDeps {
  readonly clock: BreachClock;
  /** Hold the event loop synchronously for `ms`. */
  readonly block: (ms: number) => void;
  /** Start the delay and watchdog publishers, as the services start them. */
  readonly startPublishers: () => void;
}

export interface LoopBreachResult {
  readonly blocks: number;
}

/**
 * Start the publishers and give them a second to arm, then block the loop for
 * `blockMs` once every 5 s (or
 * every `blockMs` + 1 s, for a block longer than the period) with idle time
 * between, until the bounded time is up. A block that would run past the end is
 * not started.
 */
export async function runLoopBreach(
  command: Pick<LoopBreach, 'seconds' | 'blockMs'>,
  deps: LoopBreachDeps,
): Promise<LoopBreachResult> {
  const deadline = deps.clock.now() + command.seconds * 1000;
  deps.startPublishers();
  await deps.clock.sleep(Math.min(LOOP_WARMUP_MS, deadline - deps.clock.now()));
  let blocks = 0;
  for (;;) {
    const periodStart = deps.clock.now();
    if (periodStart + command.blockMs > deadline) break;
    deps.block(command.blockMs);
    blocks += 1;
    const after = deps.clock.now();
    const next = Math.max(periodStart + LOOP_PERIOD_MS, after + LOOP_MIN_IDLE_MS);
    if (next >= deadline) break;
    await deps.clock.sleep(next - after);
  }
  const left = deadline - deps.clock.now();
  if (left > 0) await deps.clock.sleep(left);
  return { blocks };
}

/** The real synchronous block: `Atomics.wait` is deliberately not used. */
export function busyBlock(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin: hold the event loop
  }
}

export const realClock: BreachClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The real file reader: one file's text, or null when it cannot be read. */
export function readBreachFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export interface BreachSystem {
  readonly clock: BreachClock;
  readonly write: BreachWriter;
  readonly writeError: BreachWriter;
  readonly readFile: BreachFileReader;
  readonly hostTotalBytes: number;
  readonly availableParallelism: number;
  readonly allocate: MemoryBreachDeps['allocate'];
  readonly rssBytes: MemoryBreachDeps['rssBytes'];
  readonly createWorker: CpuBreachDeps['createWorker'];
  readonly block: LoopBreachDeps['block'];
  readonly startPublishers: LoopBreachDeps['startPublishers'];
  /** Called once a command is accepted, with the most it may run plus 5 s. */
  readonly armDeadline?: (ms: number) => void;
}

/**
 * The whole command: parse, refuse with exit code 2 before any work, or write the
 * start line, run the mode, write the end line and return 0.
 */
export async function runBreachCommand(
  argv: readonly string[],
  env: Env,
  sys: BreachSystem,
): Promise<number> {
  const parsed = parseBreachArgs(argv, env);
  if (!parsed.ok) {
    sys.writeError(`breach: refused: ${parsed.reason}`);
    return parsed.exitCode;
  }
  const { command } = parsed;
  sys.armDeadline?.((command.seconds + BREACH_EXIT_GRACE_SECONDS) * 1000);

  let parameters: Record<string, unknown>;
  let run: () => Promise<Record<string, unknown>>;
  if (command.mode === 'memory') {
    const limit = resolveMemoryLimit(
      command,
      readMemoryLimitBytes(sys.readFile, sys.hostTotalBytes),
    );
    if (!limit.ok) {
      sys.writeError(`breach: refused: ${limit.reason}`);
      return limit.exitCode;
    }
    parameters = { ...command, limitBytes: limit.limitBytes };
    run = async () => ({ ...(await runMemoryBreach(command, limit.limitBytes, sys)) });
  } else if (command.mode === 'cpu') {
    const workerCount = breachWorkerCount(sys.availableParallelism, readCpuQuota(sys.readFile));
    parameters = { ...command, workerCount };
    run = async () => ({ ...(await runCpuBreach(command, { ...sys, workerCount })) });
  } else {
    parameters = { ...command };
    run = async () => ({ ...(await runLoopBreach(command, sys)) });
  }

  const startedAt = sys.clock.now();
  logBreachEvent(
    'start',
    { ...parameters, startedAt: new Date(startedAt).toISOString() },
    sys.write,
  );
  const result = await run();
  const endedAt = sys.clock.now();
  logBreachEvent(
    'end',
    {
      ...parameters,
      ...result,
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
    },
    sys.write,
  );
  return BREACH_EXIT_OK;
}
