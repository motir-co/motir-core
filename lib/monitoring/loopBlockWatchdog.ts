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
// ⚠️ A STALE HEARTBEAT IS NOT PROOF THE BLOCK IS STILL RUNNING (MOTIR-9498).
// The heartbeat stays stale after a JS block ends, until its own timer runs, and
// the macrotasks queued during the block (the P2028 rejection, pg socket reads)
// run first. A pause requested just before the block ends lands promptly on that
// follow-on code and passes every check above. So the worker pauses TWICE,
// CONFIRM_GAP_MS apart, and the tag names only a frame on both stacks while the
// heartbeat never moved: code that was still running at the second pause, not
// something that ran once on the way out of the block.

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
/** First pause resumed → confirming pause sent. Longer than the code a block hands on to. */
const CONFIRM_GAP_MS = 50;
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
// The heartbeat value the window's longest block started from, so the reading
// can pair that block with ITS capture rather than the window's (MOTIR-9499).
const S_MAX_HB_BASE = 3; // two windows: S_MAX_HB_BASE + (epoch & 1)
/** How far the current capture has got: 1 probed, 2 first pause, 3 confirming pause. */
const S_STAGE = 5;
const STATS_SLOTS = 6;

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
  /** The first pause's stack, top first. */
  readonly frames: readonly RawFrame[];
  /** The confirming pause; null until it has arrived (or when it never did). */
  readonly confirm: RawConfirm | null;
}

/** The confirming pause, CONFIRM_GAP_MS after the first resumed. */
export interface RawConfirm {
  /** `Debugger.pause` sent → `Debugger.paused`, in ms. */
  readonly pauseMs: number;
  /** The heartbeat value when it arrived. */
  readonly hb: number;
  readonly holdMs: number;
  /** Its stack, top first. */
  readonly frames: readonly RawFrame[];
}

interface RawConfirmMessage extends RawConfirm {
  readonly t: 'confirm';
  readonly hbStart: number;
}

interface RawBlockEnd {
  readonly t: 'end';
  readonly hbStart: number;
  readonly endedAt: number;
}

interface Capture extends RawCapture {
  readonly epoch: number;
  endedAt: number | null;
  confirm: RawConfirm | null;
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
const {
  hb,
  stats,
  port,
  thresholdMs,
  pollMs,
  confirmGapMs,
  S_EPOCH,
  S_MAX_BASE,
  S_MAX_HB_BASE,
  S_STAGE,
} = workerData;

let capturing = false;
let capturedEpoch = -1;
let block = null; // { hbStart, captured }

function setStage(n) {
  Atomics.store(stats, S_STAGE, BigInt(n));
}

function capture(hbStart) {
  capturing = true;
  setStage(0);
  const session = new inspector.Session();
  session.connectToMainThread();
  const post = (method) =>
    new Promise((resolve, reject) =>
      session.post(method, (err, res) => (err ? reject(err) : resolve(res))),
    );
  // One pause: ALWAYS resumed — even one that lands long after we stopped
  // waiting — or the main thread would stay paused.
  const pauseOnce = (stage) =>
    new Promise((resolve, reject) => {
      let requestedAt = 0;
      session.once('Debugger.paused', (msg) => {
        const pausedAt = Date.now();
        const hbAtPaused = Number(Atomics.load(hb, 0));
        const frames = msg.params.callFrames.map((f) => ({
          fn: f.functionName,
          url: f.url,
          line: f.location.lineNumber + 1,
          col: f.location.columnNumber + 1,
        }));
        setStage(stage);
        post('Debugger.resume').then(
          () =>
            resolve({
              pauseMs: pausedAt - requestedAt,
              staleMs: pausedAt - hbAtPaused,
              hbAtPaused,
              holdMs: Date.now() - pausedAt,
              frames,
            }),
          reject,
        );
      });
      requestedAt = Date.now();
      post('Debugger.pause').catch(reject);
    });
  // A cheap request first: the main thread answers it from the same interrupt a
  // pause rides on, so how long it takes says whether V8 could interrupt the
  // block at all. Debugger.enable cannot say, because replaying every parsed
  // script to the session is slow on a big app even when the thread is free.
  let probeMs = 0;
  const probeStartedAt = Date.now();
  return post('Runtime.getHeapUsage')
    .then(() => {
      probeMs = Date.now() - probeStartedAt;
      setStage(1);
      return post('Debugger.enable');
    })
    .then(() => pauseOnce(2))
    .then((first) => {
      // Posted now, so a read right after a block that ended before the
      // confirming pause still finds the capture (as not_in_js).
      port.postMessage({
        t: 'capture',
        hbStart,
        probeMs,
        pauseMs: first.pauseMs,
        staleAtPausedMs: first.staleMs,
        holdMs: first.holdMs,
        frames: first.frames,
        confirm: null,
      });
      return new Promise((resolve) => setTimeout(resolve, confirmGapMs));
    })
    .then(() => pauseOnce(3))
    .then((confirm) => {
      port.postMessage({
        t: 'confirm',
        hbStart,
        pauseMs: confirm.pauseMs,
        hb: confirm.hbAtPaused,
        holdMs: confirm.holdMs,
        frames: confirm.frames,
      });
    })
    .catch(() => {})
    .then(() => post('Debugger.disable'))
    .catch(() => {})
    .then(() => {
      session.disconnect();
      capturing = false;
    });
}

// The block's start is stored BEFORE its length: a reader that sees the new
// length then also sees the block it belongs to (and re-reads to be sure).
function bumpMax(ms, hbStart) {
  const half = Number(Atomics.load(stats, S_EPOCH)) & 1;
  const slot = S_MAX_BASE + half;
  if (BigInt(ms) > Atomics.load(stats, slot)) {
    Atomics.store(stats, S_MAX_HB_BASE + half, BigInt(hbStart));
    Atomics.store(stats, slot, BigInt(ms));
  }
}

setInterval(() => {
  const now = Date.now();
  const last = Number(Atomics.load(hb, 0));
  if (last === 0) return;
  const stale = now - last;
  if (stale > thresholdMs) {
    if (!block) block = { hbStart: last, captured: false };
    bumpMax(stale, block.hbStart);
    const epoch = Number(Atomics.load(stats, S_EPOCH));
    if (!capturing && capturedEpoch !== epoch) {
      capturedEpoch = epoch;
      block.captured = true;
      capture(block.hbStart);
    }
  } else if (block) {
    bumpMax(last - block.hbStart, block.hbStart);
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
  const stats = new BigInt64Array(new SharedArrayBuffer(8 * STATS_SLOTS));
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
      confirmGapMs: CONFIRM_GAP_MS,
      S_EPOCH,
      S_MAX_BASE,
      S_MAX_HB_BASE,
      S_STAGE,
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
    const message = received.message as RawCapture | RawConfirmMessage | RawBlockEnd;
    if (message.t === 'capture') {
      w.captures.push({ ...message, epoch: epochOf(w), endedAt: null, confirm: null });
      w.lastHold = message.holdMs;
    } else if (message.t === 'confirm') {
      const match = w.captures.find((c) => c.hbStart === message.hbStart);
      if (match) {
        match.confirm = {
          pauseMs: message.pauseMs,
          hb: message.hb,
          holdMs: message.holdMs,
          frames: message.frames,
        };
        w.captureCount += 1;
        w.lastHold = Math.max(w.lastHold, message.holdMs);
      }
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
  Atomics.store(w.stats, S_MAX_HB_BASE + (next & 1), BigInt(0));
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

/** Same function: a frame still running sits at a different line on each pause. */
function sameFunction(a: RawFrame, b: RawFrame): boolean {
  return a.fn === b.fn && a.url === b.url;
}

/**
 * The frames that were on BOTH pauses' stacks, top first: the shared outer frames
 * (caller frames sit at the same call site), plus the innermost frame both
 * pauses were still inside, at the first pause's line. Code that ran only after
 * the block, or only at one of the pauses, is not in it.
 */
export function framesOnBothPauses(capture: RawCapture): readonly RawFrame[] {
  const a = capture.frames;
  const b = capture.confirm?.frames ?? [];
  let shared = 0;
  while (shared < a.length && shared < b.length) {
    const fa = a[a.length - 1 - shared]!;
    const fb = b[b.length - 1 - shared]!;
    if (!sameFunction(fa, fb)) break;
    shared += 1;
    if (fa.line !== fb.line) break; // still running here, on another statement
  }
  return a.slice(a.length - shared);
}

/** A frame with a source URL outside Node: application or library code. */
function hasUserlandUrl(frame: RawFrame): boolean {
  return frame.url !== '' && !frame.url.startsWith('node:');
}

/**
 * Node's event-loop dispatchers. Each stays on the stack across every callback
 * it runs back to back, so two pauses in two different follow-ons share it, and
 * as a builtin from the startup snapshot it carries no URL.
 */
const EVENT_LOOP_DISPATCHERS = new Set([
  'processImmediate',
  'processTimers',
  'listOnTimeout',
  'processTicksAndRejections',
  'runNextTicks',
  'runMicrotasks',
]);

/**
 * The shared frames that can stand for the code that held the loop. Never a
 * `node:` frame or a dispatcher; and when a shared frame has a userland URL, no
 * URL-less frame below the outermost such one, which is Node's own plumbing
 * under the callback (URL-less frames ABOVE it are evaluated code, MOTIR-9443).
 */
function nameableShared(capture: RawCapture): readonly RawFrame[] {
  const shared = framesOnBothPauses(capture);
  let outermost = -1;
  shared.forEach((frame, i) => {
    if (hasUserlandUrl(frame)) outermost = i;
  });
  const scope = outermost >= 0 ? shared.slice(0, outermost + 1) : shared;
  return scope.filter(
    (frame) =>
      !frame.url.startsWith('node:') && !(frame.url === '' && EVENT_LOOP_DISPATCHERS.has(frame.fn)),
  );
}

/**
 * Did the pause interrupt the block, rather than land after it? Both pauses must
 * have arrived promptly, with the heartbeat still stale from the block and never
 * inside the heartbeat callback, and their stacks must share a frame of
 * application or library code, not just Node's dispatcher under two different
 * callbacks: the code that held the loop was still running when the confirming
 * pause landed (MOTIR-9498).
 */
export function pauseInterruptedJs(capture: RawCapture, thresholdMs: number): boolean {
  if (capture.probeMs > PROMPT_PAUSE_MS || capture.pauseMs > PROMPT_PAUSE_MS) return false;
  const confirm = capture.confirm;
  if (!confirm || confirm.pauseMs > PROMPT_PAUSE_MS) return false;
  if (capture.staleAtPausedMs <= thresholdMs) return false;
  if (confirm.hb !== capture.hbStart) return false;
  if (capture.frames[0]?.fn === HEARTBEAT_FN) return false;
  if (confirm.frames[0]?.fn === HEARTBEAT_FN) return false;
  return nameableShared(capture).length > 0;
}

/**
 * The frame tag a capture reads, named from the frames on both pauses' stacks.
 * An app frame with a URL outranks a URL-less one above it: the pause can land
 * inside evaluated code (a runner's getter) called from the function that holds
 * the loop, and the tag should name that function (MOTIR-9443). A URL-less frame
 * is named only when no app frame has a URL.
 */
export function frameTagOf(capture: RawCapture, thresholdMs: number): string {
  if (!pauseInterruptedJs(capture, thresholdMs)) return NOT_IN_JS;
  const appFrames = nameableShared(capture).filter(isAppFrame);
  const top = appFrames.find((frame) => frame.url !== '') ?? appFrames[0];
  return top ? formatFrame(top) : NO_APP_FRAME;
}

/** A window's longest block: its length and the heartbeat value it started from. */
function windowMax(w: Watchdog, epoch: number): { ms: number; hbStart: number } {
  const half = epoch & 1;
  // The worker writes the start, then the length; re-read until the start is
  // the same on both sides of the length, so the pair is one block's.
  for (;;) {
    const hbStart = Number(Atomics.load(w.stats, S_MAX_HB_BASE + half));
    const ms = Number(Atomics.load(w.stats, S_MAX_BASE + half));
    if (Number(Atomics.load(w.stats, S_MAX_HB_BASE + half)) === hbStart) return { ms, hbStart };
  }
}

/**
 * The longest block of the current or previous window, with the capture taken
 * OF THAT BLOCK. Null when the watchdog is not running or no block reached the
 * threshold.
 *
 * ⚠️ A window gets one capture, and it belongs to the window's FIRST block. When
 * a later block is the longer one, it has no capture of its own, and the
 * earlier block's frame does not explain it: the reading then carries the
 * length alone, with the frame and age `unmeasured` (MOTIR-9499). A capture is
 * matched to its block by the heartbeat value the block started from.
 */
export function readLoopBlock(): LoopBlockReading | null {
  const w = watchdog;
  if (!w) return null;
  drain(w);
  const now = Date.now();
  const epoch = epochOf(w);

  // A block still in progress (or just ended, before the next heartbeat) is
  // visible as a stale heartbeat even before the worker's next poll; it started
  // from the heartbeat value it left stale.
  const beatAt = Number(Atomics.load(w.heartbeat, 0));
  const ongoingMs = now - beatAt > w.thresholdMs ? now - beatAt : 0;
  const recorded = windowMax(w, epoch);
  const current = ongoingMs > recorded.ms ? { ms: ongoingMs, hbStart: beatAt } : recorded;
  const previous = epoch > 0 ? windowMax(w, epoch - 1) : { ms: 0, hbStart: 0 };
  const longest = current.ms >= previous.ms ? current : previous;
  const blockMs = longest.ms;
  if (blockMs <= 0) return null;

  const capture = w.captures.find((c) => c.hbStart === longest.hbStart) ?? null;
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
  /** Captures taken since start, both pauses landed (drained from the worker). */
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
  /** How far the current capture has got: 0 none, 1 probed, 2 first pause, 3 confirming pause. */
  captureStage(): number {
    return watchdog ? Number(Atomics.load(watchdog.stats, S_STAGE)) : 0;
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
