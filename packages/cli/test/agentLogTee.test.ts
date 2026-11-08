import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentLogTee,
  createLegLogTee,
  LOG_CHUNK_BYTES,
  LOG_FLUSH_MS,
  splitLogBody,
} from '../src/agentLogTee.js';
import { createDispatchRunReporter, nullDispatchRunReporter } from '../src/dispatchRunReporter.js';
// ⚠️ FROM `client.js`, WHICH IS WHERE IT LIVES. The reporter only IMPORTS this
// type; it never re-exported it, so the old path type-checked nowhere — and the
// root `tsc` never sees this file, because `packages/cli` runs its OWN
// typecheck. A green root run is not evidence about this code.
import type { DispatchRunEventInput } from '../src/client.js';
import { runAgent } from '../src/agentRun.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import { readFileSync } from 'node:fs';

// The AGENT LOG PRODUCER (Story MOTIR-1789 · MOTIR-3961).
//
// ⚠️ THE FIRST DESCRIBE IS THE LOAD-BEARING ONE, and it asserts a CALLER.
// Everything else about this stream shipped and worked: the event kind, the
// `--report-log` flag on three commands, the central body strip, the 30-day
// sweep, the help text promising all of it. What did not exist was a line that
// emitted one — and every unit around it passed the whole time, because a green
// test proves a method works WHEN CALLED and never proves that anything calls
// it. So the guard here is over the production sources, not over a stub.

function reporterSpy(opts: { reportLogBodies: boolean }) {
  const events: DispatchRunEventInput[] = [];
  const reporter = createDispatchRunReporter({
    client: {
      openDispatchRun: async () => ({ id: 'run_1' }),
      appendDispatchRunEvents: async () => ({ accepted: 0 }),
      closeDispatchRun: async () => undefined,
    } as never,
    reportLogBodies: opts.reportLogBodies,
  });
  const wrapped = {
    ...reporter,
    get wantsLogBodies() {
      return reporter.wantsLogBodies;
    },
    event(e: DispatchRunEventInput) {
      events.push(e);
      reporter.event(e);
    },
  };
  return { reporter: wrapped, events };
}

describe('⚠️ the opt-in decides CAPTURE; the reporter still decides what LEAVES', () => {
  it('there is no tee at all without --report-log', () => {
    const { reporter } = reporterSpy({ reportLogBodies: false });
    expect(reporter.wantsLogBodies).toBe(false);
    expect(createLegLogTee(reporter, 'PROD-1')).toBeNull();
  });

  it('the null reporter never wants bodies, so a wired-but-unreporting run tees nothing', () => {
    expect(nullDispatchRunReporter.wantsLogBodies).toBe(false);
    expect(createLegLogTee(nullDispatchRunReporter, 'PROD-1')).toBeNull();
  });

  it('with --report-log a tee exists and emits CARD-SCOPED log events', () => {
    const { reporter, events } = reporterSpy({ reportLogBodies: true });
    const tee = createLegLogTee(reporter, 'PROD-42');
    expect(tee).not.toBeNull();
    tee!.write('reading lib/services/x.ts\n');
    tee!.flush();
    expect(events).toEqual([
      { kind: 'log', workItemKey: 'PROD-42', body: 'reading lib/services/x.ts\n' },
    ]);
  });
});

describe('it BATCHES — one event per line would blow the reporter’s queue bound', () => {
  it('accumulates to the threshold rather than emitting per write', () => {
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b), chunkBytes: 16 });
    for (let i = 0; i < 8; i += 1) tee.write('12345\n');
    // EIGHT writes of six bytes at a 16-byte threshold emit THREE events, each
    // cut after the last whole line that fits (12 bytes — never the 18 the buffer
    // reached, MOTIR-10705), and leave 12 bytes held. Not eight events, which is
    // the whole point — and the remainder is not lost, it is waiting for the flush.
    expect(bodies).toEqual(['12345\n12345\n', '12345\n12345\n', '12345\n12345\n']);
    tee.flush();
    expect(bodies).toHaveLength(4);
    expect(bodies.join('')).toBe('12345\n'.repeat(8));
  });

  it('the default threshold is a size, and a short run emits ONCE on flush', () => {
    expect(LOG_CHUNK_BYTES).toBeGreaterThanOrEqual(1024);
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b) });
    tee.write('a\n');
    tee.write('b\n');
    expect(bodies).toEqual([]);
    tee.flush();
    expect(bodies).toEqual(['a\nb\n']);
  });

  it('flush on an empty buffer emits NOTHING — no empty-bodied event per leg', () => {
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b) });
    tee.flush();
    tee.flush();
    expect(bodies).toEqual([]);
  });
});

describe('no log body is ever over the ceiling, in UTF-8 bytes (MOTIR-10705)', () => {
  const bytes = (b: string) => Buffer.byteLength(b, 'utf8');

  it('one 40,000-byte write becomes ten bodies of at most 4096 bytes, and nothing is lost', () => {
    // The card's reproduction: on main this emitted ONE 40,000-byte body, which the
    // server refuses (16 KiB) together with the rest of its batch.
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b) });
    tee.write('x'.repeat(40_000));
    expect(bodies.map(bytes)).toEqual(Array(9).fill(LOG_CHUNK_BYTES));
    tee.flush();
    expect(bodies.map(bytes).at(-1)).toBe(40_000 - 9 * LOG_CHUNK_BYTES);
    expect(bodies.join('')).toBe('x'.repeat(40_000));
  });

  it('measures BYTES, not UTF-16 code units — multi-byte text never overshoots', () => {
    // 3-byte '€' and 4-byte (surrogate-pair) '😀': a code-unit count would let a
    // 4096-unit buffer carry up to 12 KiB.
    const text = '€😀a'.repeat(3_000);
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b) });
    tee.write(text);
    tee.flush();
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(bytes(body)).toBeLessThanOrEqual(LOG_CHUNK_BYTES);
      // Every cut is on a code-point boundary: no piece carries half a surrogate pair.
      expect(Buffer.from(body, 'utf8').toString('utf8')).toBe(body);
    }
    expect(bodies.join('')).toBe(text);
  });

  it('cuts after the last line break that fits, so a row in the log pane is a whole line', () => {
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b), chunkBytes: 10 });
    tee.write('abc\ndefg\nhijk\n');
    expect(bodies).toEqual(['abc\ndefg\n']);
    tee.flush();
    expect(bodies).toEqual(['abc\ndefg\n', 'hijk\n']);
  });

  it('the tail a size cut leaves behind is sent after the wait, like any short batch', () => {
    vi.useFakeTimers();
    try {
      const bodies: string[] = [];
      const tee = createAgentLogTee({ emit: (b) => bodies.push(b), chunkBytes: 4 });
      tee.write('123456');
      expect(bodies).toEqual(['1234']);
      vi.advanceTimersByTime(LOG_FLUSH_MS);
      expect(bodies).toEqual(['1234', '56']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('splitLogBody', () => {
  it('a text of exactly the limit is one piece and no rest', () => {
    expect(splitLogBody('abcd', 4)).toEqual({ pieces: ['abcd'], rest: '' });
  });

  it('a text under the limit is all rest', () => {
    expect(splitLogBody('abc', 4)).toEqual({ pieces: [], rest: 'abc' });
    expect(splitLogBody('', 4)).toEqual({ pieces: [], rest: '' });
  });

  it('a piece stops short rather than split a character that would not fit', () => {
    // 'ab' is 2 bytes; '€' would make 5 at a limit of 4, so the piece is 'ab'.
    expect(splitLogBody('ab€', 4)).toEqual({ pieces: ['ab'], rest: '€' });
  });

  it('counts each code point as UTF-8 does: 1, 2, 3 and 4 bytes, a lone surrogate as 3', () => {
    for (const ch of ['a', 'é', '€', '😀', '\ud800']) {
      const width = Buffer.byteLength(ch, 'utf8');
      expect(splitLogBody(ch, width)).toEqual({ pieces: [ch], rest: '' });
      expect(splitLogBody(ch, width + 1)).toEqual({ pieces: [], rest: ch });
    }
  });

  it('a character wider than the limit still moves the cut forward — it never stalls', () => {
    expect(splitLogBody('😀😀', 2)).toEqual({ pieces: ['😀', '😀'], rest: '' });
  });

  it('a piece without a later break is cut at the limit, after the last break when there is one', () => {
    expect(splitLogBody('\nabcdef', 4)).toEqual({ pieces: ['\n', 'abcd'], rest: 'ef' });
  });
});

describe('a streamed run’s first lines are not held back for a size they will never reach (MOTIR-8980)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues a short batch after the wait, with no flush and no threshold crossed', () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b) });
    tee.write('Read lib/x.ts\n');
    expect(bodies).toEqual([]);
    vi.advanceTimersByTime(LOG_FLUSH_MS - 1);
    expect(bodies).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bodies).toEqual(['Read lib/x.ts\n']);
  });

  it('is one event per wait however many lines arrive in it', () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b) });
    tee.write('a\n');
    vi.advanceTimersByTime(1000);
    tee.write('b\n');
    vi.advanceTimersByTime(1000);
    expect(bodies).toEqual(['a\nb\n']);
    tee.write('c\n');
    vi.advanceTimersByTime(LOG_FLUSH_MS);
    expect(bodies).toEqual(['a\nb\n', 'c\n']);
  });

  it('a size flush or the final flush disarms the wait, so nothing is sent twice', () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    const tee = createAgentLogTee({ emit: (b) => bodies.push(b), chunkBytes: 4 });
    tee.write('12345');
    tee.flush();
    tee.write('x');
    tee.flush();
    vi.advanceTimersByTime(LOG_FLUSH_MS * 3);
    // The size cut sends four bytes and keeps the fifth for the flush (MOTIR-10705).
    expect(bodies).toEqual(['1234', '5', 'x']);
  });

  it('sends each batch to the server now — a log event otherwise waits for the minute-long heartbeat', async () => {
    const flushes: number[] = [];
    const reporter = {
      wantsLogBodies: true,
      event: () => undefined,
      flush: async () => {
        flushes.push(1);
      },
    };
    const tee = createLegLogTee(reporter as never, 'PROD-1')!;
    tee.write('Bash: pnpm test\n');
    tee.flush();
    expect(flushes).toHaveLength(1);
  });
});

describe('⚠️ reporting is an OBSERVATION and may never break the run it observes', () => {
  it('a throwing emit is swallowed, and later chunks still flow', () => {
    const bodies: string[] = [];
    let first = true;
    const tee = createAgentLogTee({
      emit: (b) => {
        if (first) {
          first = false;
          throw new Error('the reporter fell over');
        }
        bodies.push(b);
      },
      chunkBytes: 4,
    });
    expect(() => tee.write('aaaa')).not.toThrow();
    expect(() => tee.write('bbbb')).not.toThrow();
    expect(bodies).toEqual(['bbbb']);
  });
});

describe('runAgent tees the agent’s REAL output, and leaves the terminal alone without it', () => {
  const work = mkdtempSync(join(tmpdir(), 'motir-tee-'));
  const fakeAgent = (script: string) => {
    const parsed = parseAgentCommand(process.execPath);
    if (!parsed) throw new Error('unreachable: execPath is non-empty');
    return { ...parsed, args: ['-e', script] };
  };

  it('captures stdout AND stderr from a real child process', async () => {
    const seen: string[] = [];
    const result = await runAgent({
      command: fakeAgent(
        `process.stdout.write('OUT:reading\\n');process.stderr.write('ERR:oops\\n');`,
      ),
      prompt: 'p',
      cwd: work,
      onOutput: (c) => seen.push(c),
    });
    expect(result.exitCode).toBe(0);
    const all = seen.join('');
    expect(all).toContain('OUT:reading');
    expect(all).toContain('ERR:oops');
    rmSync(work, { recursive: true, force: true });
  });

  it('a THROWING onOutput does not fail the agent run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'motir-tee2-'));
    const result = await runAgent({
      command: fakeAgent(`process.stdout.write('x\\n');process.exit(0);`),
      prompt: 'p',
      cwd: dir,
      onOutput: () => {
        throw new Error('reporter down');
      },
    });
    expect(result.exitCode).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('⚠️ THE GUARD THAT WOULD HAVE CAUGHT THIS — a PRODUCTION caller, not a working method', () => {
  // The whole `log` mechanism shipped and was inert: kind, flag, strip, sweep,
  // help text, and unit tests that all passed. What was missing was a line in
  // `packages/cli/src` that emits one. No behavioural test can notice that —
  // pass a reporter a log event and it handles it correctly, which is exactly
  // what the old tests asserted. So this one reads the SOURCES.
  const SRC = new URL('../src/', import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, SRC), 'utf8');

  it('something in src EMITS a log event', () => {
    expect(read('agentLogTee.ts')).toMatch(/kind:\s*'log'/);
  });

  it('and BOTH dispatch paths call it — a producer wired into one of two is worse than none', () => {
    for (const path of ['dispatchLeg.ts', 'commands/auto.ts']) {
      const src = read(path);
      expect(src, `${path} must build the tee`).toMatch(/createLegLogTee\(/);
      expect(src, `${path} must pass it to the agent`).toMatch(/onOutput:\s*logTee\.write/);
      expect(src, `${path} must flush the tail`).toMatch(/logTee\?\.flush\(\)/);
    }
  });

  it('the tail is flushed BEFORE the exit event, so the transcript ends where the agent did', () => {
    for (const path of ['dispatchLeg.ts', 'commands/auto.ts']) {
      const src = read(path);
      expect(src.indexOf('logTee?.flush()'), path).toBeLessThan(
        src.indexOf("kind: 'agent_exited'"),
      );
    }
  });

  it('NO call site re-derives the opt-in — the strip stays the reporter’s alone', () => {
    // The flag has exactly ONE legitimate appearance outside the reporter: the
    // command handing it in at CONSTRUCTION, which is how the reporter learns
    // it. Anywhere else it would be a second reading of the policy — the thing
    // the central strip exists to make impossible, whose own comment says a
    // call site that forgot would leak.
    expect(read('agentLogTee.ts'), 'the tee reads wantsLogBodies, never the flag').not.toMatch(
      /reportLogBodies/,
    );
    expect(read('dispatchLeg.ts'), 'the leg reads wantsLogBodies, never the flag').not.toMatch(
      /reportLogBodies/,
    );
    const auto = read('commands/auto.ts');
    const uses = auto.match(/reportLogBodies/g) ?? [];
    expect(uses, 'auto.ts names the flag once, to build the reporter').toHaveLength(1);
    expect(auto).toMatch(/createDispatchRunReporter\(\{[^}]*reportLogBodies/s);
  });
});
