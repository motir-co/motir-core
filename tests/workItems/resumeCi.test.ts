import { describe, expect, it } from 'vitest';
import {
  advanceResumeCiSnapshot,
  sameResumeCiSnapshot,
  takeResumeCiSnapshot,
  toResumeCiSnapshot,
  type ResumeCiMember,
} from '@/lib/workItems/resumeCi';

// MOVING AGAIN, MEASURED AGAINST THE GATED RUN'S SNAPSHOT (Story MOTIR-10305 · MOTIR-10308).
// The rules are `lib/workItems/resumeCi.ts`'s header; the database half is
// `tests/workbench/resumeState.test.ts`.

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BEFORE = new Date('2026-11-01T09:00:00Z');
const STOP = new Date('2026-11-01T10:00:00Z');
const AFTER = new Date('2026-11-01T11:00:00Z');

let n = 0;
/** One check row; each gets its own name, so none supersedes another. */
function row(commitSha: string, conclusion: string, createdAt: Date, updatedAt = createdAt) {
  n += 1;
  return { commitSha, conclusion, createdAt, updatedAt, checkName: `ci ${n}`, checkSuiteId: '' };
}

function pr(id: string, headSha: string | null, rows: ReturnType<typeof row>[]): ResumeCiMember {
  return { id, headSha, checkRuns: rows };
}

describe('takeResumeCiSnapshot', () => {
  it('records each head, settled only when CI there reported and nothing is pending', () => {
    const snap = takeResumeCiSnapshot('run_1', [
      pr('p1', A, [row(A, 'success', BEFORE)]),
      pr('p2', B, [row(B, 'pending', BEFORE)]),
      pr('p3', B, [row(A, 'success', BEFORE)]),
    ]);
    expect(snap).toEqual({
      runId: 'run_1',
      moved: false,
      heads: {
        p1: { head: A, settled: true },
        p2: { head: B, settled: false },
        p3: { head: B, settled: false },
      },
    });
  });
});

describe('advanceResumeCiSnapshot', () => {
  const settled = takeResumeCiSnapshot('run_1', [pr('p1', A, [row(A, 'success', BEFORE)])]);
  const running = takeResumeCiSnapshot('run_1', [pr('p1', A, [row(A, 'pending', BEFORE)])]);

  it("the run's own CI going on after the stop is not a start", () => {
    const next = advanceResumeCiSnapshot(
      running,
      [pr('p1', A, [row(A, 'pending', BEFORE, AFTER), row(A, 'pending', AFTER)])],
      STOP,
    );
    expect(next.moved).toBe(false);
    expect(next.heads.p1).toEqual({ head: A, settled: false });
  });

  it('marks that CI settled once it finishes, so only a LATER re-run counts', () => {
    const done = advanceResumeCiSnapshot(
      running,
      [pr('p1', A, [row(A, 'success', BEFORE, AFTER), row(A, 'failure', AFTER)])],
      STOP,
    );
    expect(done).toEqual({
      runId: 'run_1',
      moved: false,
      heads: { p1: { head: A, settled: true } },
    });
    const rerun = advanceResumeCiSnapshot(
      done,
      [pr('p1', A, [row(A, 'pending', BEFORE, AFTER)])],
      STOP,
    );
    expect(rerun.moved).toBe(true);
  });

  it('at a settled head: a row pending again, or a new suite, is a start; a finished old row is not', () => {
    expect(
      advanceResumeCiSnapshot(settled, [pr('p1', A, [row(A, 'success', BEFORE, AFTER)])], STOP)
        .moved,
    ).toBe(false);
    expect(
      advanceResumeCiSnapshot(settled, [pr('p1', A, [row(A, 'pending', BEFORE, AFTER)])], STOP)
        .moved,
    ).toBe(true);
    expect(
      advanceResumeCiSnapshot(
        settled,
        [pr('p1', A, [row(A, 'success', BEFORE), row(A, 'success', AFTER)])],
        STOP,
      ).moved,
    ).toBe(true);
  });

  it('a new head counts once CI has reported there, not on the announcement alone', () => {
    expect(
      advanceResumeCiSnapshot(settled, [pr('p1', B, [row(A, 'success', BEFORE)])], STOP).moved,
    ).toBe(false);
    expect(
      advanceResumeCiSnapshot(
        settled,
        [pr('p1', B, [row(A, 'success', BEFORE), row(B, 'pending', AFTER)])],
        STOP,
      ).moved,
    ).toBe(true);
  });

  it('a pull request opened after the stop counts by its rows created after it', () => {
    expect(
      advanceResumeCiSnapshot(settled, [pr('p2', B, [row(B, 'pending', BEFORE)])], STOP).moved,
    ).toBe(false);
    expect(
      advanceResumeCiSnapshot(settled, [pr('p2', B, [row(B, 'pending', AFTER)])], STOP).moved,
    ).toBe(true);
  });

  it('a moved snapshot stays moved', () => {
    const moved = { ...settled, moved: true };
    expect(advanceResumeCiSnapshot(moved, [], STOP)).toBe(moved);
  });
});

describe('toResumeCiSnapshot / sameResumeCiSnapshot', () => {
  it('reads a stored value back and treats anything malformed as none', () => {
    const snap = takeResumeCiSnapshot('run_1', [pr('p1', A, [row(A, 'success', BEFORE)])]);
    expect(toResumeCiSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(toResumeCiSnapshot(null)).toBeNull();
    expect(toResumeCiSnapshot([])).toBeNull();
    expect(toResumeCiSnapshot({ heads: {} })).toBeNull();
  });

  it('compares key by key', () => {
    const a = takeResumeCiSnapshot('run_1', [pr('p1', A, [row(A, 'success', BEFORE)])]);
    const b = takeResumeCiSnapshot('run_1', [pr('p1', A, [row(A, 'pending', BEFORE)])]);
    expect(sameResumeCiSnapshot(a, { ...a, heads: { ...a.heads } })).toBe(true);
    expect(sameResumeCiSnapshot(a, b)).toBe(false);
    expect(sameResumeCiSnapshot(a, { ...a, moved: true })).toBe(false);
    expect(sameResumeCiSnapshot(null, null)).toBe(true);
    expect(sameResumeCiSnapshot(null, a)).toBe(false);
  });
});
