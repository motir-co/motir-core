import { describe, expect, it } from 'vitest';
import type { RepairPullRequestDto } from '@/lib/dto/workItemRepair';
import { FIX_REASON_PRIORITY, pullRequestReasonOf } from '@/lib/workItems/fixReason';

// OUT OF DATE ON TO FIX (Bug MOTIR-10054). A member behind a base branch that requires
// it to be up to date is listed for that reason — after a conflict, before red CI — and
// only for the members the repair predicate saw out of date.

const member = (over: Partial<RepairPullRequestDto> = {}): RepairPullRequestDto => ({
  repo: 'acme/web',
  number: 1,
  url: 'https://github.com/acme/web/pull/1',
  headRef: 'subtask/one',
  baseRef: 'main',
  ci: 'passing',
  failingChecks: [],
  queueExit: null,
  conflicted: false,
  outOfDate: false,
  ...over,
});

describe('pullRequestReasonOf — out of date', () => {
  it('names the base and counts the members behind it', () => {
    const value = pullRequestReasonOf(
      [member({ outOfDate: true }), member({ number: 2, outOfDate: true }), member({ number: 3 })],
      3,
    );
    expect(value).toMatchObject({
      fixReason: 'out_of_date',
      fixDetail: { repair: 'fix', base: 'main', affected: 2, total: 3 },
    });
  });

  it('keeps a base the row never recorded as null', () => {
    expect(pullRequestReasonOf([member({ outOfDate: true, baseRef: null })], 1)).toMatchObject({
      fixReason: 'out_of_date',
      fixDetail: { base: null },
    });
  });

  it('ranks after a conflict and before red CI', () => {
    expect(
      pullRequestReasonOf([member({ outOfDate: true }), member({ number: 2, conflicted: true })], 2)
        ?.fixReason,
    ).toBe('conflicted');
    expect(
      pullRequestReasonOf(
        [member({ outOfDate: true }), member({ number: 2, ci: 'failing', failingChecks: ['t'] })],
        2,
      )?.fixReason,
    ).toBe('out_of_date');
    expect(FIX_REASON_PRIORITY.indexOf('out_of_date')).toBe(
      FIX_REASON_PRIORITY.indexOf('conflicted') + 1,
    );
  });

  it('a member that is only green and current is nothing to fix', () => {
    expect(pullRequestReasonOf([member()], 1)).toBeNull();
  });
});
