import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
  type MessagePort,
} from 'node:worker_threads';

// WHAT THE MAIN THREAD WAS RUNNING WHILE THE EVENT LOOP WAS BLOCKED (MOTIR-8265).
//
// MOTIR-6701's tags prove a P2028 happened on a blocked loop (a 5.8 s block on a
// warm machine with a free pool, MOTIR-8262) and cannot say what held it. A
// blocked main thread runs no timer, so it cannot sample itself: the watcher
// lives on a `worker_threads` thread.
//
// HOW IT WORKS
//   - The main thread writes `Date.now()` into a SharedArrayBuffer every
//     HEARTBEAT_MS from an `unref`'d interval.
//   - The worker polls that value. When it is stale past BLOCK_THRESHOLD_MS the
//     main thread has not run a timer for that long, and the worker asks V8 for
//     the main thread's stack through `inspector.Session#connectToMainThread()`:
//     `Debugger.enable` → `Debugger.pause` → read `callFrames` from
//     `Debugger.paused` → `Debugger.resume` → `Debugger.disable`.
//   - THE CAPTURE ROUTE, AND WHY. V8 services inspector messages through an
//     isolate INTERRUPT, so a `Debugger.pause` sent from another thread lands
//     while the main thread is still inside a synchronous JS loop, at its next
//     back-edge, and the paused event carries the frames that were running.
//     Nothing is enabled while the loop is healthy (no profiler, no debugger),
//     which a continuously sampling `Profiler` would cost on every request for
//     an event that is rare. The worker sends nothing between `paused` and
//     `resume`, so the main thread is held only for that round trip.
//   - THE WORKER IS BUILT FROM INLINE SOURCE (`new Worker(src, { eval: true })`).
//     The app server is a Next standalone build, which traces only files that are
//     imported; a worker reached by path would not ship in the image.
//
// ⚠️ THE DELIVERY TRAP. The P2028's rejection is a macrotask that runs as soon
// as the block ends, and the worker's result reaches the main thread as a
// message: their order is not guaranteed, so a reader that waits for the message
// can read nothing on exactly the event the capture was for. Every read here is
// SYNCHRONOUS: results ride a `MessageChannel` drained with
// `receiveMessageOnPort`, which sees messages already queued without a turn of
// the loop, and the block's length comes from shared memory the worker wrote
// during the block.
//
// ⚠️ THE NATIVE/GC TRAP. A pause request only takes effect at the next JS
// statement. If the block is a GC, native code or the VM being descheduled, the
// pause lands AFTER the block, on whatever runs next, and naming that frame
// would point MOTIR-8262 at innocent code. The pause is therefore only trusted
// when it landed promptly (PROMPT_PAUSE_MS) while the heartbeat was still stale,
// and never when its top frame is the heartbeat's own callback. Anything else
// reads `not_in_js`, with its stack kept in the event's `contexts`.
//
// ⚠️ MODULE-LOCAL STATE, ON PURPOSE (the MOTIR-7007 rule, stated). Like the
// event-loop monitor it rides on, the watchdog is started and read in the same
// module evaluation (the server's Sentry config, the worker's single bundle),
// and `tests/monitoring/sentry-init-gate.test.ts` relies on `vi.resetModules()`
// discarding it. There is deliberately NO `globalThis` guard against a second
// thread: `startTransactionStallMonitor()` runs from exactly one place per
// process (where `Sentry.init` does), so a second evaluation never starts one,
// and a guard that outlived `vi.resetModules()` would wrongly refuse a start.

/** The block length past which a capture is taken. */
export const BLOCK_THRESHOLD_MS = 1000;
const HEARTBEAT_MS = 100;
const POLL_MS = 100;
/** A request the main thread answered later than this was not served mid-block. */
const PROMPT_PAUSE_MS = 250;
/** At most this many frames ride in the event's `contexts`. */
export const MAX_CONTEXT_FRAMES = 50;
const MAX_FRAME_CHARS = 200;

/** The heartbeat callback's name: a pause that lands in it landed AFTER the block. */
const HEARTBEAT_FN = 'motirLoopBlockHeartbeat';

/** What the frame tag reads when the captured block was not JS. */
export const NOT_IN_JS = 'not_in_js';
/** What the frame tag reads when a capture held no application frame. */
export const NO_APP_FRAME = 'no_app_frame';

// Slots of the shared stats array (BigInt64Array).
const S_EPOCH = 0;
const S_MAX_BASE = 1; // two windows: S_MAX_BASE + (epoch & 1)

/** One stack frame as V8 reports it. */
export interface RawFrame {
  readonly fn: string;
  readonly url: string;
  /** 1-based. */
  readonly line: number;
  readonly col: number;
}

/** What the worker saw — raw facts only; every judgement is made here. */
export interface RawCapture {
  readonly t: 'capture';
  /** The heartbeat value the block started from. */
  readonly hbStart: number;
  /** How long the main thread took to answer a cheap inspector request, in ms. */
  readonly probeMs: number;
  /** `Debugger.pause` sent → `Debugger.paused`, in ms. */
  readonly pauseMs: number;
  /** How stale the heartbeat still was when `Debugger.paused` arrived. */
  readonly staleAtPausedMs: number;
  /** `Debugger.paused` → `Debugger.resume` answered: how long the main thread was held. */
  readonly holdMs: number;
  readonly frames: readonly RawFrame[];
}

interface RawBlockEnd {
  readonly t: 'end';
  readonly hbStart: number;
  readonly endedAt: number;
}

interface Capture extends RawCapture {
  readonly epoch: number;
  endedAt: number | null;
}

/** The reading a P2028 carries. */
export interface LoopBlockReading {
  readonly blockMs: number;
  /** `file:line fn`, `no_app_frame`, `not_in_js` — or null when nothing was captured. */
  readonly frame: string | null;
  /** Seconds from the captured block's end to now; null with no capture. */
  readonly ageS: number | null;
  readonly context: {
    readonly blockMs: number;
    readonly endedAt: string | null;
    readonly inJs: boolean;
    readonly frames: readonly string[];
  } | null;
}

// ── The worker (inline source) ───────────────────────────────────────────────

const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const inspector = require('node:inspector');
const { hb, stats, port, thresholdMs, pollMs, S_EPOCH, S_MAX_BASE } = workerData;

let capturing = false;
let capturedEpoch = -1;
let block = null; // { hbStart, captured }

function capture(hbStart) {
  capturing = true;
  const session = new inspector.Session();
  session.connectToMainThread();
  const post = (method) =>
    new Promise((resolve, reject) =>
      session.post(method, (err, res) => (err ? reject(err) : resolve(res))),
    );
  let probeMs = 0;
  let pauseRequestedAt = 0;
  let settle;
  const done = new Promise((resolve) => (settle = resolve));
  // ALWAYS resume — even a pause that lands long after we stopped waiting — or
  // the main thread would stay paused.
  session.once('Debugger.paused', (msg) => {
    const pausedAt = Date.now();
    const stale = pausedAt - Number(Atomics.load(hb, 0));
    const frames = msg.params.callFrames.map((f) => ({
      fn: f.functionName,
      url: f.url,
      line: f.location.lineNumber + 1,
      col: f.location.columnNumber + 1,
    }));
    post('Debugger.resume').then(
      () => {
        port.postMessage({
          t: 'capture',
          hbStart,
          probeMs,
          pauseMs: pausedAt - pauseRequestedAt,
          staleAtPausedMs: stale,
          holdMs: Date.now() - pausedAt,
          frames,
        });
        settle();
      },
      () => settle(),
    );
  });
  // A cheap request first: the main thread answers it from the same interrupt a
  // pause rides on, so how long it takes says whether V8 could interrupt the
  // block at all. Debugger.enable cannot say, because replaying every parsed
  // script to the session is slow on a big app even when the thread is free.
  const probeStartedAt = Date.now();
  post('Runtime.getHeapUsage')
    .then(() => {
      probeMs = Date.now() - probeStartedAt;
      return post('Debugger.enable');
    })
    .then(() => {
      pauseRequestedAt = Date.now();
      return post('Debugger.pause');
    })
    .catch(() => settle());
  return done
    .then(() => post('Debugger.disable'))
    .catch(() => {})
    .then(() => {
      session.disconnect();
      capturing = false;
    });
}

function bumpMax(ms) {
  const slot = S_MAX_BASE + (Number(Atomics.load(stats, S_EPOCH)) & 1);
  if (BigInt(ms) > Atomics.load(stats, slot)) Atomics.store(stats, slot, BigInt(ms));
}

setInterval(() => {
  const now = Date.now();
  const last = Number(Atomics.load(hb, 0));
  if (last === 0) return;
  const stale = now - last;
  if (stale > thresholdMs) {
    if (!block) block = { hbStart: last, captured: false };
    bumpMax(stale);
    const epoch = Number(Atomics.load(stats, S_EPOCH));
    if (!capturing && capturedEpoch !== epoch) {
      capturedEpoch = epoch;
      block.captured = true;
      capture(block.hbStart);
    }
  } else if (block) {
    bumpMax(last - block.hbStart);
    if (block.captured) port.postMessage({ t: 'end', hbStart: block.hbStart, endedAt: last });
    block = null;
  }
}, pollMs);
`;

// ── Main-thread state ────────────────────────────────────────────────────────

interface Watchdog {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly heartbeat: BigInt64Array;
  readonly stats: BigInt64Array;
  readonly timer: NodeJS.Timeout;
  readonly exited: Promise<void>;
  readonly thresholdMs: number;
  captures: Capture[];
  captureCount: number;
  lastHold: number;
}

let watchdog: Watchdog | null = null;
let thresholdOverrideMs: number | null = null;

/** Start the watchdog thread. Idempotent. Called ONLY from `startTransactionStallMonitor()`. */
export function startLoopBlockWatchdog(): void {
  if (watchdog) return;
  const thresholdMs = thresholdOverrideMs ?? BLOCK_THRESHOLD_MS;
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8));
  const stats = new BigInt64Array(new SharedArrayBuffer(8 * 3));
  const { port1, port2 } = new MessageChannel();

  // A named function declaration, so a pause that lands inside it is
  // recognisable as late (`HEARTBEAT_FN`).
  function motirLoopBlockHeartbeat(): void {
    Atomics.store(heartbeat, 0, BigInt(Date.now()));
  }
  const timer = setInterval(motirLoopBlockHeartbeat, HEARTBEAT_MS);
  timer.unref();
  motirLoopBlockHeartbeat();

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      hb: heartbeat,
      stats,
      port: port2,
      thresholdMs,
      pollMs: POLL_MS,
      S_EPOCH,
      S_MAX_BASE,
    },
    transferList: [port2],
  });
  // Never keep a process alive for a measurement, and never let a failed
  // thread take the process down with it.
  worker.unref();
  port1.unref();
  const exited = new Promise<void>((resolve) => {
    worker.once('exit', resolve);
  });
  worker.on('error', () => {});

  watchdog = {
    worker,
    port: port1,
    heartbeat,
    stats,
    timer,
    exited,
    thresholdMs,
    captures: [],
    captureCount: 0,
    lastHold: 0,
  };
}

/** Terminate the watchdog thread. Resolves once the thread has exited. */
export function stopLoopBlockWatchdog(): Promise<void> {
  const current = watchdog;
  if (!current) return Promise.resolve();
  watchdog = null;
  clearInterval(current.timer);
  current.port.close();
  void current.worker.terminate();
  return current.exited;
}

/** True when this module evaluation started a thread that is still running. */
export function isLoopBlockWatchdogRunning(): boolean {
  return watchdog !== null;
}

// ── Windows ──────────────────────────────────────────────────────────────────

function epochOf(w: Watchdog): number {
  return Number(Atomics.load(w.stats, S_EPOCH));
}

/** Move every message the worker has already queued into main-thread state. */
function drain(w: Watchdog): void {
  for (;;) {
    const received = receiveMessageOnPort(w.port);
    if (!received) return;
    const message = received.message as RawCapture | RawBlockEnd;
    if (message.t === 'capture') {
      w.captures.push({ ...message, epoch: epochOf(w), endedAt: null });
      w.captureCount += 1;
      w.lastHold = message.holdMs;
    } else if (message.t === 'end') {
      const match = w.captures.find((c) => c.hbStart === message.hbStart);
      if (match) match.endedAt = message.endedAt;
    }
  }
}

/**
 * Roll the window — called from the same timer as the event-loop histogram, so
 * a block is reported over the same two-window span as every other tag.
 */
export function rollLoopBlockWindow(): void {
  const w = watchdog;
  if (!w) return;
  drain(w);
  const next = epochOf(w) + 1;
  Atomics.store(w.stats, S_MAX_BASE + (next & 1), BigInt(0));
  Atomics.store(w.stats, S_EPOCH, BigInt(next));
  w.captures = w.captures.filter((c) => c.epoch >= next - 1);
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Frames the capture should NOT name: Node internals, dependencies, and the
 * heartbeat callback itself. A frame with no URL is evaluated code (a test
 * runner's module wrapper, an `eval`) and is application code, not a library,
 * though `frameTagOf` names it only when no app frame with a URL is on the stack.
 */
function isAppFrame(frame: RawFrame): boolean {
  if (frame.fn === HEARTBEAT_FN) return false;
  if (frame.url.startsWith('node:')) return false;
  return !frame.url.includes('/node_modules/');
}

/** `file:line fn` — a path relative to the working directory, ≤ 200 chars. */
export function formatFrame(frame: RawFrame): string {
  let file = frame.url.replace(/^file:\/\//, '');
  const cwd = `${process.cwd()}/`;
  if (file.startsWith(cwd)) file = file.slice(cwd.length);
  const text = `${file === '' ? '<anonymous>' : file}:${frame.line} ${frame.fn || '<anonymous>'}`;
  return text.length > MAX_FRAME_CHARS ? text.slice(0, MAX_FRAME_CHARS) : text;
}

/**
 * Did the pause interrupt the block, rather than land after it? Only a pause
 * that arrived promptly, while the heartbeat was still stale, and not inside the
 * heartbeat callback, names the code that held the loop.
 */
export function pauseInterruptedJs(capture: RawCapture, thresholdMs: number): boolean {
  if (capture.probeMs > PROMPT_PAUSE_MS || capture.pauseMs > PROMPT_PAUSE_MS) return false;
  if (capture.staleAtPausedMs <= thresholdMs) return false;
  return capture.frames[0]?.fn !== HEARTBEAT_FN;
}

/**
 * The frame tag a capture reads. An app frame with a URL outranks a URL-less one
 * above it: the pause can land inside evaluated code (a runner's getter) called
 * from the function that holds the loop, and the tag should name that function
 * (MOTIR-9443). A URL-less frame is named only when no app frame has a URL.
 */
export function frameTagOf(capture: RawCapture, thresholdMs: number): string {
  if (!pauseInterruptedJs(capture, thresholdMs)) return NOT_IN_JS;
  const appFrames = capture.frames.filter(isAppFrame);
  const top = appFrames.find((frame) => frame.url !== '') ?? appFrames[0];
  return top ? formatFrame(top) : NO_APP_FRAME;
}

/**
 * The longest block of the current or previous window, with the capture that
 * explains it. Null when the watchdog is not running or no block reached the
 * threshold.
 */
export function readLoopBlock(): LoopBlockReading | null {
  const w = watchdog;
  if (!w) return null;
  drain(w);
  const now = Date.now();
  const epoch = epochOf(w);
  const slot = (e: number) => Number(Atomics.load(w.stats, S_MAX_BASE + (e & 1)));

  // A block still in progress (or just ended, before the next heartbeat) is
  // visible as a stale heartbeat even before the worker's next poll.
  const beatAt = Number(Atomics.load(w.heartbeat, 0));
  const ongoingMs = now - beatAt > w.thresholdMs ? now - beatAt : 0;
  const current = Math.max(slot(epoch), ongoingMs);
  const previous = epoch > 0 ? slot(epoch - 1) : 0;
  const blockMs = Math.max(current, previous);
  if (blockMs <= 0) return null;

  const owner = current >= previous ? epoch : epoch - 1;
  const capture =
    w.captures.find((c) => c.epoch === owner) ??
    w.captures.find((c) => c.epoch === (owner === epoch ? epoch - 1 : epoch)) ??
    null;
  if (!capture) return { blockMs, frame: null, ageS: null, context: null };

  const stillStale = beatAt === capture.hbStart;
  const endedAt = capture.endedAt ?? (stillStale ? null : beatAt);
  const ageS = endedAt === null ? 0 : Math.max(0, Math.round((now - endedAt) / 1000));
  return {
    blockMs,
    frame: frameTagOf(capture, w.thresholdMs),
    ageS,
    context: {
      blockMs,
      endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
      inJs: pauseInterruptedJs(capture, w.thresholdMs),
      frames: capture.frames.slice(0, MAX_CONTEXT_FRAMES).map(formatFrame),
    },
  };
}

/** Test hooks. Never used by application code. */
export const __forTests = {
  /** Lower the block threshold for the NEXT start. Pass null to restore the default. */
  setThresholdMs(ms: number | null): void {
    thresholdOverrideMs = ms;
  },
  /** Captures taken since start (drained from the worker). */
  captureCount(): number {
    const w = watchdog;
    if (!w) return 0;
    drain(w);
    return w.captureCount;
  },
  /** How long the main thread was held by the latest capture, ms. */
  lastHoldMs(): number {
    const w = watchdog;
    if (!w) return 0;
    drain(w);
    return w.lastHold;
  },
  /** The worker's thread id, or null when none runs. */
  threadId(): number | null {
    return watchdog ? watchdog.worker.threadId : null;
  },
  /** Resolves when the worker thread has exited. */
  exited(): Promise<void> {
    return watchdog ? watchdog.exited : Promise.resolve();
  },
};
