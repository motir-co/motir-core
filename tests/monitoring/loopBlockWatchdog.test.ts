import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOCK_THRESHOLD_MS,
  NOT_IN_JS,
  NO_APP_FRAME,
  __forTests,
  frameTagOf,
  isLoopBlockWatchdogRunning,
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

/**
 * Block the thread in NATIVE code that V8 cannot interrupt: a pause request
 * cannot land until the child exits. (`Atomics.wait` is NOT such a block — V8
 * services interrupts inside its wait loop, so the pause lands mid-wait.)
 */
function blockLoopInNativeCodeForTest(ms: number): void {
  spawnSync('sleep', [String(ms / 1000)]);
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

  it('captures again in the next window', async () => {
    blockLoopForTest(SPIN_MS);
    await sleep(300);
    rollLoopBlockWindow();
    blockLoopForTest(SPIN_MS);
    readLoopBlock();
    expect(__forTests.captureCount()).toBe(2);
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
  const capture = (over: Partial<RawCapture>): RawCapture => ({
    t: 'capture',
    hbStart: 0,
    probeMs: 5,
    pauseMs: 5,
    staleAtPausedMs: BLOCK_THRESHOLD_MS + 500,
    holdMs: 1,
    frames: [frame('file:///app/lib/x.ts', 'doWork', 12)],
    ...over,
  });

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
