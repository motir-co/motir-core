import { describe, expect, it } from 'vitest';
import { checkRowsAtHead, prCiStateAtHead, pullRequestHead } from '@/lib/github/pullRequestHead';
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
