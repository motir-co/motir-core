import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCK_THRESHOLD_MS,
  NOT_IN_JS,
  NO_APP_FRAME,
  __forTests,
  frameTagOf,
  isLoopBlockWatchdogRunning,
  framesOnBothPauses,
  pauseInterruptedJs,
  readLoopBlock,
  rollLoopBlockWindow,
  startLoopBlockWatchdog,
  stopLoopBlockWatchdog,
  type RawCapture,
} from '@/lib/monitoring/loopBlockWatchdog';

// THE WATCHDOG NAMES WHAT HELD THE LOOP (MOTIR-8265).
//
// A blocked main thread runs no timer, so these tests block it for real and
// read the result back through the same synchronous path a P2028's tag reader
// uses. Each arm has a control: a reading that must NOT appear when the
// condition is absent, so a watchdog that always named a frame could not pass.

const SPIN_MS = BLOCK_THRESHOLD_MS + 700;

/** Hold the event loop in a named synchronous function. */
function blockLoopForTest(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

/** The same block under another name, so a reading can tell two blocks apart. */
function blockLoopEarlierForTest(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

/**
 * Block the thread in NATIVE code that V8 cannot interrupt: a pause request
 * cannot land until the child exits. (`Atomics.wait` is NOT such a block — V8
 * services interrupts inside its wait loop, so the pause lands mid-wait.)
 */
function blockLoopInNativeCodeForTest(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)]);
}

/** Spin until the capture reaches `stage`, or give up after `capMs`. */
function spinUntilStage(stage: number, capMs = 5000): void {
  const giveUpAt = Date.now() + capMs;
  while (__forTests.captureStage() < stage && Date.now() < giveUpAt) {
    // spin
  }
}

/**
 * The block itself: it holds the loop until the worker's probe was answered,
 * which happens only once the heartbeat is stale past the threshold. It is ONE
 * spin with no separate fixed-length spin first (MOTIR-9580): a fixed spin can
 * still be running when the probe is answered, and then both pauses land inside
 * it, a real block, and the tag correctly names it. Ending on the probe is what
 * puts every pause after the block.
 */
function blockUntilProbedForTest(): void {
  spinUntilStage(1);
}

/** Code the block handed on to, still running when the first pause lands. */
function followOnForTest(): void {
  spinUntilStage(2);
}

/** Further follow-on code, running when the confirming pause lands. */
function laterFollowOnForTest(): void {
  spinUntilStage(3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  await stopLoopBlockWatchdog();
  startLoopBlockWatchdog();
  // Let the worker thread come up and the first heartbeat land.
  await sleep(300);
});

afterEach(async () => {
  await stopLoopBlockWatchdog();
});

describe('the capture', () => {
  it('names the function that blocked the loop, read synchronously after the block', () => {
    blockLoopForTest(SPIN_MS);
    // No await: the read happens in the same tick the block ended, which is where
    // a rejection handler runs — the worker's message must already be readable.
    const block = readLoopBlock();
    expect(block).not.toBeNull();
    expect(block!.blockMs).toBeGreaterThanOrEqual(SPIN_MS - 100);
    expect(block!.frame).toContain('blockLoopForTest');
    expect(block!.ageS).not.toBeNull();
    expect(Number.isFinite(block!.ageS)).toBe(true);
    expect(block!.context!.inJs).toBe(true);
    expect(block!.context!.frames.length).toBeGreaterThan(0);
    expect(block!.context!.frames.length).toBeLessThanOrEqual(50);
  });

  it('holds the main thread for no more than 50 ms', () => {
    blockLoopForTest(SPIN_MS);
    readLoopBlock();
    expect(__forTests.captureCount()).toBe(1);
    expect(__forTests.lastHoldMs()).toBeLessThanOrEqual(50);
  });

  it('takes ONE capture per window, and the longer block wins the duration', async () => {
    blockLoopForTest(SPIN_MS);
    await sleep(300);
    blockLoopForTest(SPIN_MS + 900);
    const block = readLoopBlock();
    expect(__forTests.captureCount()).toBe(1);
    expect(block!.blockMs).toBeGreaterThanOrEqual(SPIN_MS + 900 - 100);
  });

  // MOTIR-9499: the window's one capture belongs to its FIRST block. When a
  // later block is the longer one, the reading must not name the first block's
  // frame against the second block's length.
  it('never tags a longer, uncaptured block with an earlier block’s frame', async () => {
    blockLoopEarlierForTest(SPIN_MS);
    await sleep(300);
    blockLoopForTest(SPIN_MS + 900);
    const block = readLoopBlock();
    expect(__forTests.captureCount()).toBe(1);
    expect(block!.blockMs).toBeGreaterThanOrEqual(SPIN_MS + 900 - 100);
    expect(block!.frame).toBeNull();
    expect(block!.ageS).toBeNull();
    expect(block!.context).toBeNull();
  });

  it('keeps the capture when the captured block is the longer one', async () => {
    blockLoopEarlierForTest(SPIN_MS + 900);
    await sleep(300);
    blockLoopForTest(SPIN_MS);
    const block = readLoopBlock();
    expect(__forTests.captureCount()).toBe(1);
    expect(block!.blockMs).toBeGreaterThanOrEqual(SPIN_MS + 900 - 100);
    expect(block!.frame).toContain('blockLoopEarlierForTest');
    expect(block!.context!.frames.some((f) => / blockLoopForTest$/.test(f))).toBe(false);
  });

  it('captures again in the next window', async () => {
    blockLoopForTest(SPIN_MS);
    await sleep(300);
    rollLoopBlockWindow();
    blockLoopForTest(SPIN_MS);
    readLoopBlock();
    expect(__forTests.captureCount()).toBe(2);
  });
});

// MOTIR-9498: the heartbeat stays stale after a block ends, while the
// macrotasks queued behind it run, so a pause requested just before the end
// lands promptly on code that ran AFTER the block. Three immediates queued in one
// check phase run back to back with no timer between them, so the heartbeat stays
// stale throughout: the block ends once the probe is answered, and the pauses land
// somewhere after it. Neither follow-on held the loop.
//
// WHERE a real pause lands is not deterministic (MOTIR-9955): on a loaded runner
// the first pause can land in a follow-on, or between immediates in Node's own
// loop, with only internals on the stack. So this live test asserts only what
// holds for every landing, and the cases that depend on the landing are fed to
// the pure readers as captures below ('the landings of a pause after the block').
describe('a pause that lands after the block', () => {
  it('names no follow-on code when the pause lands after the block ended', async () => {
    await new Promise<void>((resolve) => {
      setImmediate(blockUntilProbedForTest);
      setImmediate(followOnForTest);
      setImmediate(() => {
        laterFollowOnForTest();
        resolve();
      });
    });
    await sleep(300);
    const block = readLoopBlock();
    expect(__forTests.captureStage(), 'the confirming pause never landed').toBe(3);
    expect(block).not.toBeNull();
    expect(block!.frame).not.toBeNull();
    expect(block!.frame).not.toMatch(/followOnForTest|laterFollowOnForTest/);
    // The only frame the tag may name is the one that held the loop.
    if (block!.frame !== NOT_IN_JS) {
      expect(block!.context!.frames.join('\n')).toContain('blockUntilProbedForTest');
    }
    expect(block!.context!.inJs).toBe(block!.frame !== NOT_IN_JS);
  });
});

describe('what is not a block', () => {
  it('reads null (every tag `unmeasured`) when nothing blocked the loop', async () => {
    blockLoopForTest(300); // under the threshold
    await sleep(200);
    expect(readLoopBlock()).toBeNull();
  });

  it('reads null when the watchdog was never started', async () => {
    await stopLoopBlockWatchdog();
    expect(isLoopBlockWatchdogRunning()).toBe(false);
    expect(readLoopBlock()).toBeNull();
  });

  it('reads `not_in_js` for a block the pause cannot interrupt, and names no frame', async () => {
    blockLoopInNativeCodeForTest(SPIN_MS);
    // The pause lands only AFTER such a block, so its capture is delivered a few
    // milliseconds after the block ends rather than during it.
    await sleep(300);
    const block = readLoopBlock();
    expect(block).not.toBeNull();
    expect(block!.frame).toBe(NOT_IN_JS);
    expect(block!.frame).not.toContain('blockLoopInNativeCodeForTest');
    expect(block!.context!.inJs).toBe(false);
    // The stack is still kept for whoever wants it.
    expect(block!.context!.frames.length).toBeGreaterThan(0);
  });
});

describe('classifying a capture (pure)', () => {
  const frame = (url: string, fn: string, line = 1) => ({ url, fn, line, col: 1 });
  type CaptureOver = Partial<Omit<RawCapture, 'confirm'>> & {
    confirm?: Partial<NonNullable<RawCapture['confirm']>> | null;
  };
  // Both pauses land on the same stack unless a test says otherwise.
  const capture = ({ confirm, ...over }: CaptureOver): RawCapture => {
    const frames = over.frames ?? [frame('file:///app/lib/x.ts', 'doWork', 12)];
    return {
      t: 'capture',
      hbStart: 0,
      probeMs: 5,
      pauseMs: 5,
      staleAtPausedMs: BLOCK_THRESHOLD_MS + 500,
      holdMs: 1,
      ...over,
      frames,
      confirm: confirm === null ? null : { pauseMs: 5, hb: 0, holdMs: 1, frames, ...confirm },
    };
  };

  it('names the top in-app frame as file:line fn', () => {
    expect(frameTagOf(capture({}), BLOCK_THRESHOLD_MS)).toMatch(/lib\/x\.ts:12 doWork$/);
  });

  it('skips node: and node_modules frames', () => {
    const tag = frameTagOf(
      capture({
        frames: [
          frame('node:internal/fs', 'readFileSync'),
          frame('file:///app/node_modules/lib/a.js', 'parse'),
          frame('file:///app/app/route.ts', 'GET', 7),
        ],
      }),
      BLOCK_THRESHOLD_MS,
    );
    expect(tag).toMatch(/app\/route\.ts:7 GET$/);
  });

  // MOTIR-9443: the pause can land inside a URL-less evaluated frame (a test
  // runner's getter) above the function that holds the loop. Name the frame
  // with a URL; fall back to the URL-less one only when it is all there is.
  it('prefers an app frame with a URL over a URL-less one above it', () => {
    const tag = frameTagOf(
      capture({
        frames: [frame('', 'get', 10), frame('file:///app/lib/x.test.ts', 'blockLoopForTest', 30)],
      }),
      BLOCK_THRESHOLD_MS,
    );
    expect(tag).toMatch(/lib\/x\.test\.ts:30 blockLoopForTest$/);
  });

  it('still names a URL-less frame when no app frame has a URL', () => {
    const tag = frameTagOf(
      capture({
        frames: [
          frame('node:internal/fs', 'readFileSync'),
          frame('', 'evaluated', 3),
          frame('', 'outer', 9),
        ],
      }),
      BLOCK_THRESHOLD_MS,
    );
    expect(tag).toBe('<anonymous>:3 evaluated');
  });

  // MOTIR-9498: Node's dispatchers carry no URL and stay under every callback
  // they run, so two follow-ons share them and they prove nothing.
  it('reads `not_in_js` when the pauses share only a dispatcher', () => {
    const dispatched = capture({
      frames: [frame('', 'followOn', 3), frame('', 'processImmediate', 485)],
      confirm: {
        frames: [frame('', 'laterFollowOn', 8), frame('', 'processImmediate', 485)],
      },
    });
    expect(frameTagOf(dispatched, BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
  });

  it('names no URL-less frame below the outermost shared userland frame', () => {
    const tag = frameTagOf(
      capture({
        frames: [
          frame('file:///app/node_modules/pg/lib/connection.js', 'parse', 40),
          frame('', 'emit', 519),
          frame('', 'onStreamRead', 191),
        ],
      }),
      BLOCK_THRESHOLD_MS,
    );
    expect(tag).toBe(NO_APP_FRAME);
  });

  it('reads `no_app_frame` when only library or internal frames ran', () => {
    const tag = frameTagOf(
      capture({
        frames: [
          frame('node:internal/fs', 'readFileSync'),
          frame('file:///app/node_modules/lib/a.js', 'parse'),
        ],
      }),
      BLOCK_THRESHOLD_MS,
    );
    expect(tag).toBe(NO_APP_FRAME);
  });

  it('reads `not_in_js` when the pause landed in the heartbeat callback, after the block', () => {
    const late = capture({
      frames: [
        frame('file:///app/lib/monitoring/loopBlockWatchdog.ts', 'motirLoopBlockHeartbeat'),
        frame('file:///app/lib/x.ts', 'doWork'),
      ],
    });
    expect(pauseInterruptedJs(late, BLOCK_THRESHOLD_MS)).toBe(false);
    expect(frameTagOf(late, BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
  });

  it('reads `not_in_js` when the pause was slow, or the heartbeat was no longer stale', () => {
    expect(frameTagOf(capture({ probeMs: 900 }), BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
    expect(frameTagOf(capture({ pauseMs: 900 }), BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
    expect(frameTagOf(capture({ staleAtPausedMs: 20 }), BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
  });

  it('reads `not_in_js` when the confirming pause was slow, missing, or after a heartbeat', () => {
    expect(frameTagOf(capture({ confirm: { pauseMs: 900 } }), BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
    expect(frameTagOf(capture({ confirm: null }), BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
    expect(frameTagOf(capture({ confirm: { hb: 1 } }), BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
  });

  // MOTIR-9498: the confirming pause is what proves the code was still running.
  it('reads `not_in_js` when the two pauses share no frame outside Node internals', () => {
    const late = capture({
      frames: [frame('', '_request', 99), frame('node:internal/timers', 'processTimers', 5)],
      confirm: {
        frames: [
          frame('file:///app/lib/y.ts', 'onData', 4),
          frame('node:internal/timers', 'processTimers', 5),
        ],
      },
    });
    expect(framesOnBothPauses(late).map((f) => f.fn)).toEqual(['processTimers']);
    expect(pauseInterruptedJs(late, BLOCK_THRESHOLD_MS)).toBe(false);
    expect(frameTagOf(late, BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
  });

  it("names the frame both pauses were inside, at the first pause's line", () => {
    const tag = frameTagOf(
      capture({
        frames: [
          frame('file:///app/lib/helper.ts', 'step', 3),
          frame('file:///app/lib/x.ts', 'doWork', 12),
          frame('file:///app/app/route.ts', 'GET', 7),
        ],
        confirm: {
          frames: [
            frame('file:///app/lib/x.ts', 'doWork', 15),
            frame('file:///app/app/route.ts', 'GET', 7),
          ],
        },
      }),
      BLOCK_THRESHOLD_MS,
    );
    expect(tag).toMatch(/lib\/x\.ts:12 doWork$/);
  });

  // MOTIR-9955: the live test above cannot choose where its pauses land, so the
  // landings it can meet are fed here as captures, with the stacks CI observed.
  // Every one is a pause after the block, and none may name a follow-on.
  describe('the landings of a pause after the block', () => {
    const TEST_FILE = 'file:///app/tests/monitoring/loopBlockWatchdog.test.ts';
    const immediate = frame('', 'processImmediate', 485);
    const blockFrames = [
      frame(TEST_FILE, 'spinUntilStage', 57),
      frame(TEST_FILE, 'blockUntilProbedForTest', 70),
      immediate,
    ];
    const followOnFrames = [
      frame(TEST_FILE, 'spinUntilStage', 57),
      frame(TEST_FILE, 'followOnForTest', 75),
      immediate,
    ];
    const laterFrames = [
      frame(TEST_FILE, 'spinUntilStage', 57),
      frame(TEST_FILE, 'laterFollowOnForTest', 80),
      immediate,
    ];

    it('reads `not_in_js` when the first pause lands in Node’s loop between immediates', () => {
      // motir-core#3829, Vitest 8/20: the first pause held internals only.
      const betweenTicks = capture({
        frames: [frame('', 'hasRejectionToWarn', 3), frame('', 'runNextTicks', 60), immediate],
        confirm: { frames: laterFrames },
      });
      expect(pauseInterruptedJs(betweenTicks, BLOCK_THRESHOLD_MS)).toBe(false);
      expect(frameTagOf(betweenTicks, BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);

      // merge-group run, Vitest 18/20: the same, after a script's hooks ran.
      const afterScript = capture({
        frames: [frame('', 'emitAfterScript', 92), immediate],
        confirm: { frames: laterFrames },
      });
      expect(frameTagOf(afterScript, BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
    });

    it('reads `not_in_js` when the first pause lands in follow-on code', () => {
      const late = capture({ frames: followOnFrames, confirm: { frames: laterFrames } });
      expect(framesOnBothPauses(late).map((f) => f.fn)).toEqual(['processImmediate']);
      expect(pauseInterruptedJs(late, BLOCK_THRESHOLD_MS)).toBe(false);
      expect(frameTagOf(late, BLOCK_THRESHOLD_MS)).toBe(NOT_IN_JS);
      // The control: read off the first pause alone, the tag would name the
      // follow-on's frame as if it had held the loop.
      const firstPauseOnly = capture({ frames: followOnFrames });
      expect(frameTagOf(firstPauseOnly, BLOCK_THRESHOLD_MS)).toMatch(/:57 spinUntilStage$/);
    });

    it('names a frame of the block when both pauses land inside it', () => {
      const inside = capture({ frames: blockFrames, confirm: { frames: blockFrames } });
      expect(pauseInterruptedJs(inside, BLOCK_THRESHOLD_MS)).toBe(true);
      expect(frameTagOf(inside, BLOCK_THRESHOLD_MS)).toMatch(/:57 spinUntilStage$/);
      expect(framesOnBothPauses(inside).map((f) => f.fn)).toEqual([
        'spinUntilStage',
        'blockUntilProbedForTest',
        'processImmediate',
      ]);
    });
  });

  it('truncates a long frame to 200 characters', () => {
    const tag = frameTagOf(
      capture({ frames: [frame(`file:///${'a'.repeat(400)}.ts`, 'fn')] }),
      1000,
    );
    expect(tag.length).toBeLessThanOrEqual(200);
  });
});

describe('the thread', () => {
  it('starts one thread, once, and stop terminates it', async () => {
    expect(isLoopBlockWatchdogRunning()).toBe(true);
    const id = __forTests.threadId();
    expect(id).not.toBeNull();
    startLoopBlockWatchdog(); // idempotent
    expect(__forTests.threadId()).toBe(id);
    const exited = __forTests.exited();
    await stopLoopBlockWatchdog();
    await exited; // resolves only once the thread has exited
    expect(isLoopBlockWatchdogRunning()).toBe(false);
    expect(__forTests.threadId()).toBeNull();
  });
});
