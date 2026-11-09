import { describe, expect, it } from 'vitest';
import {
  checkRowsAtHead,
  isCiUndecidedAtHead,
  isReRunAtHead,
  lastDecidedBeforeHead,
  prCiStateAtHead,
  pullRequestHead,
} from '@/lib/github/pullRequestHead';
import {
  isConflictedAtCurrentHead,
  isMergeabilityOwedAt,
  isMergeabilityOwedAtCurrentHead,
  isOutOfDateAt,
  isOutOfDateAtCurrentHead,
} from '@/lib/github/mergeability';

// THE PULL REQUEST'S HEAD, READ ONE WAY (MOTIR-7005). The check rows are not the head:
// a push that produces no CI — every push to a conflicting pull request — leaves them
// at the old commit. These pin the three readers every head question now goes through.

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

let seq = 0;
function run(commitSha: string, conclusion: string, checkName = 'ci / vitest') {
  seq += 1;
  const at = new Date(Date.UTC(2026, 8, 30, 10, 0, seq));
  return {
    id: `run-${seq}`,
    pullRequestId: 'pr-1',
    commitSha,
    checkName,
    checkSuiteId: '1',
    suiteAggregate: false,
    conclusion,
    createdAt: at,
    updatedAt: at,
  };
}

describe('pullRequestHead', () => {
  it('is the stored host head, whatever commit the check rows are at', () => {
    expect(pullRequestHead({ headSha: B, checkRuns: [run(A, 'success')] })).toBe(B);
  });

  it('falls back to the check rows for a row no delivery has stored a head on', () => {
    expect(pullRequestHead({ headSha: null, checkRuns: [run(A, 'success')] })).toBe(A);
  });

  it('is null when neither names one', () => {
    expect(pullRequestHead({ headSha: null, checkRuns: [] })).toBeNull();
  });
});

// FIXING's reading of a member (Story MOTIR-10305 · MOTIR-10310): CI has not decided at the
// head when a check runs there OR when none has reported there yet — the window between a
// push the host announced and its first check row — on a pull request CI has reported on.
describe('isCiUndecidedAtHead', () => {
  it('is true while a check runs at the head, and for a new head with no rows yet', () => {
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [run(B, 'pending')] })).toBe(true);
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [run(A, 'failure')] })).toBe(true);
  });

  it('is false on a pull request CI has never reported on: nothing is coming', () => {
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [] })).toBe(false);
    expect(isCiUndecidedAtHead({ headSha: null, checkRuns: [] })).toBe(false);
  });

  it('is false when every row at the head reported a conclusion the fold does not rank', () => {
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [run(B, 'skipped')] })).toBe(false);
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [run(B, 'neutral')] })).toBe(false);
  });

  it('is false once the head has a verdict, red or green', () => {
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [run(B, 'success')] })).toBe(false);
    expect(isCiUndecidedAtHead({ headSha: B, checkRuns: [run(B, 'failure')] })).toBe(false);
  });
});

describe('checkRowsAtHead / prCiStateAtHead', () => {
  it('a head with no rows of its own is NOT green, however green an older commit is', () => {
    const pr = { headSha: B, checkRuns: [run(A, 'success')] };
    expect(checkRowsAtHead(pr)).toEqual([]);
    expect(prCiStateAtHead(pr)).toBeNull();
  });

  it('reads only the rows at the head', () => {
    const pr = { headSha: B, checkRuns: [run(A, 'failure'), run(B, 'success')] };
    expect(checkRowsAtHead(pr).map((r) => r.commitSha)).toEqual([B]);
    expect(prCiStateAtHead(pr)).toBe('passing');
  });

  it('keeps the failure > pending > success precedence at the head', () => {
    const pr = {
      headSha: B,
      checkRuns: [run(B, 'success', 'lint'), run(B, 'pending', 'e2e'), run(B, 'failure', 'unit')],
    };
    expect(prCiStateAtHead(pr)).toBe('failing');
  });

  it('with no stored head, is the latest-sha reading it replaced', () => {
    const pr = { headSha: null, checkRuns: [run(A, 'failure'), run(B, 'success')] };
    expect(prCiStateAtHead(pr)).toBe('passing');
  });
});

describe('isConflictedAtCurrentHead', () => {
  it('a `dirty` reading at the stored head is a conflict even when the rows are older', () => {
    expect(
      isConflictedAtCurrentHead({
        headSha: B,
        checkRuns: [run(A, 'success')],
        mergeableState: 'dirty',
        mergeableStateHeadSha: B,
      }),
    ).toBe(true);
  });

  it('a reading taken at another head is not', () => {
    expect(
      isConflictedAtCurrentHead({
        headSha: B,
        checkRuns: [run(B, 'success')],
        mergeableState: 'dirty',
        mergeableStateHeadSha: A,
      }),
    ).toBe(false);
  });
});

// OWED IS NOT CLEAN (MOTIR-7063): the reading a push marks pending, or one taken at an
// older commit, holds the CI promotion — and is still no conflict.
describe('isMergeabilityOwedAtCurrentHead', () => {
  const at = (mergeableState: string | null, mergeableStateHeadSha: string | null) => ({
    headSha: B,
    checkRuns: [run(B, 'success')],
    mergeableState,
    mergeableStateHeadSha,
  });

  it('pending at the head is owed, and is not a conflict', () => {
    expect(isMergeabilityOwedAtCurrentHead(at('unknown', B))).toBe(true);
    expect(isConflictedAtCurrentHead(at('unknown', B))).toBe(false);
  });

  it('a reading taken at another head is owed, whatever it said', () => {
    expect(isMergeabilityOwedAtCurrentHead(at('clean', A))).toBe(true);
    expect(isMergeabilityOwedAtCurrentHead(at('dirty', A))).toBe(true);
  });

  it('a computed reading AT the head is not owed', () => {
    expect(isMergeabilityOwedAtCurrentHead(at('clean', B))).toBe(false);
    expect(isMergeabilityOwedAtCurrentHead(at('dirty', B))).toBe(false);
  });

  it('a row nothing has ever asked about is not owed', () => {
    expect(isMergeabilityOwedAtCurrentHead(at(null, null))).toBe(false);
  });

  it('with no known head, only the pending marker is owed', () => {
    expect(
      isMergeabilityOwedAt({ mergeableState: 'unknown', mergeableStateHeadSha: A }, null),
    ).toBe(true);
    expect(isMergeabilityOwedAt({ mergeableState: 'clean', mergeableStateHeadSha: A }, null)).toBe(
      false,
    );
  });
});

// BEHIND A STRICT BASE (Bug MOTIR-10054): the same head rule as a conflict, and never
// a conflict itself.
describe('isOutOfDateAtCurrentHead', () => {
  const at = (mergeableState: string | null, mergeableStateHeadSha: string | null) => ({
    headSha: B,
    checkRuns: [run(B, 'success')],
    mergeableState,
    mergeableStateHeadSha,
  });

  it('a `behind` reading at the head is out of date, and is not a conflict', () => {
    expect(isOutOfDateAtCurrentHead(at('behind', B))).toBe(true);
    expect(isConflictedAtCurrentHead(at('behind', B))).toBe(false);
  });

  it('a reading taken at another head, another state, or none at all is not', () => {
    expect(isOutOfDateAtCurrentHead(at('behind', A))).toBe(false);
    expect(isOutOfDateAtCurrentHead(at('dirty', B))).toBe(false);
    expect(isOutOfDateAtCurrentHead(at('clean', B))).toBe(false);
    expect(isOutOfDateAtCurrentHead(at(null, null))).toBe(false);
  });

  it('with no known head, any `behind` reading with a head of its own counts', () => {
    expect(isOutOfDateAt({ mergeableState: 'behind', mergeableStateHeadSha: A }, null)).toBe(true);
    expect(isOutOfDateAt({ mergeableState: 'behind', mergeableStateHeadSha: null }, null)).toBe(
      false,
    );
  });
});

// THE BUILD A PUSH ANSWERED (Bug MOTIR-10747): the newest commit before the head on which CI
// DECIDED, read from the rows older commits keep — what the Fixing rule falls back on when a
// quick green at the new head wiped the card's stored answer.
describe('lastDecidedBeforeHead', () => {
  const C = 'e'.repeat(40);

  it('is the red commit before the head, naming its failing checks unique and sorted', () => {
    const rows = [
      run(A, 'failure', 'lint'),
      run(A, 'failure', 'ci / vitest'),
      run(A, 'failure', 'lint'),
      run(A, 'success', 'typecheck'),
      run(B, 'success', 'lint'),
      run(B, 'pending'),
    ];
    expect(lastDecidedBeforeHead({ headSha: B, checkRuns: rows })).toEqual({
      commitSha: A,
      red: true,
      failingChecks: ['ci / vitest', 'lint'],
    });
  });

  it('is the NEWEST decided commit by first sighting — a green one is not red', () => {
    // A was red, B went green, C is the head: the build C answers is B's.
    const rows = [run(A, 'failure'), run(B, 'success'), run(C, 'pending')];
    expect(lastDecidedBeforeHead({ headSha: C, checkRuns: rows })).toEqual({
      commitSha: B,
      red: false,
      failingChecks: [],
    });
    // A late row on an OLD commit does not make it the newer one.
    const late = [
      run(A, 'failure'),
      run(B, 'success'),
      run(A, 'failure', 'late'),
      run(C, 'pending'),
    ];
    expect(lastDecidedBeforeHead({ headSha: C, checkRuns: late })?.commitSha).toBe(B);
  });

  it('skips a commit CI never decided on — it says nothing about the build the head answers', () => {
    const rows = [run(A, 'failure'), run(B, 'pending'), run(C, 'success', 'lint')];
    expect(lastDecidedBeforeHead({ headSha: C, checkRuns: rows })).toMatchObject({
      commitSha: A,
      red: true,
    });
  });

  it('a commit whose rows are all unranked (skipped) has decided: not red', () => {
    const rows = [run(A, 'failure'), run(B, 'skipped'), run(C, 'pending')];
    expect(lastDecidedBeforeHead({ headSha: C, checkRuns: rows })).toEqual({
      commitSha: B,
      red: false,
      failingChecks: [],
    });
  });

  it('a red run a later run at the same commit replaced decides nothing', () => {
    const replaced = { ...run(A, 'failure'), checkSuiteId: '1' };
    const rerun = { ...run(A, 'success'), checkSuiteId: '2' };
    expect(
      lastDecidedBeforeHead({ headSha: B, checkRuns: [replaced, rerun, run(B, 'pending')] }),
    ).toMatchObject({ commitSha: A, red: false });
  });

  it('is null with no commit before the head, and never reads the head itself', () => {
    expect(lastDecidedBeforeHead({ headSha: A, checkRuns: [run(A, 'failure')] })).toBeNull();
    expect(lastDecidedBeforeHead({ headSha: null, checkRuns: [] })).toBeNull();
    // A head the rows have not reached yet: every row is before it.
    expect(lastDecidedBeforeHead({ headSha: B, checkRuns: [run(A, 'failure')] })).toMatchObject({
      commitSha: A,
      red: true,
    });
  });
});

// A RE-RUN AT THE HEAD (review of MOTIR-10747): the head had decided before the checks running
// there now, so the build those checks answer is the head's own, and nothing older is read.
describe('isReRunAtHead', () => {
  const startedAt = (row: ReturnType<typeof run>, offsetSeconds: number) => ({
    ...row,
    conclusionAt: new Date(row.createdAt.getTime() + offsetSeconds * 1000),
  });

  it('a pending row whose run started after the row was first recorded is a reopened re-run', () => {
    const reopened = startedAt(run(B, 'pending'), 90);
    expect(isReRunAtHead({ headSha: B, checkRuns: [run(A, 'failure'), reopened] })).toBe(true);
    // …and lastDecidedBeforeHead then reads nothing older.
    expect(
      lastDecidedBeforeHead({ headSha: B, checkRuns: [run(A, 'failure'), reopened] }),
    ).toBeNull();
  });

  it('a fresh pending row — started before we recorded it, or with no start known — is not', () => {
    for (const fresh of [startedAt(run(B, 'pending'), -2), startedAt(run(B, 'pending'), 0)]) {
      expect(isReRunAtHead({ headSha: B, checkRuns: [run(A, 'failure'), fresh] })).toBe(false);
    }
    expect(
      isReRunAtHead({
        headSha: B,
        checkRuns: [run(A, 'failure'), { ...run(B, 'pending'), conclusionAt: null }],
      }),
    ).toBe(false);
    // A terminal row finished after it was recorded is an ordinary completion.
    expect(isReRunAtHead({ headSha: B, checkRuns: [startedAt(run(B, 'success'), 60)] })).toBe(
      false,
    );
  });

  it('a decided run a later run at the same commit replaced is a re-run; a replaced pending one is not', () => {
    const first = { ...run(B, 'failure'), checkSuiteId: '1' };
    const again = { ...run(B, 'pending'), checkSuiteId: '2' };
    expect(isReRunAtHead({ headSha: B, checkRuns: [run(A, 'failure'), first, again] })).toBe(true);
    const cancelled = { ...run(B, 'pending'), checkSuiteId: '1' };
    expect(isReRunAtHead({ headSha: B, checkRuns: [run(A, 'failure'), cancelled, again] })).toBe(
      false,
    );
  });

  it('only the head is read — a reopened row at an older commit says nothing about it', () => {
    const olderReopened = startedAt(run(A, 'pending'), 90);
    expect(isReRunAtHead({ headSha: B, checkRuns: [olderReopened, run(B, 'pending')] })).toBe(
      false,
    );
  });
});
