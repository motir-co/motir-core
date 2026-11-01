// MOTIR-10103 — `mergeCommitFacts`, what a merge release says it was: the
// subject the Production panel shows and the pull request its trigger line
// names, read from the head commit's message. Pure: no DB, no network.
import { describe, expect, it } from 'vitest';
import { COMMIT_SUBJECT_MAX, mergeCommitFacts } from '@/lib/hosting/mergeCommit';

describe('mergeCommitFacts', () => {
  it('reads a merge commit: the number from its first line, the title from the next', () => {
    expect(
      mergeCommitFacts(
        'Merge pull request #48 from acme/basket-estimate\n\nShow the delivery estimate on the basket',
      ),
    ).toEqual({ subject: 'Show the delivery estimate on the basket', pullRequestNumber: 48 });
  });

  it('keeps the merge line as the subject when the commit carries no title', () => {
    expect(mergeCommitFacts('Merge pull request #12 from acme/x')).toEqual({
      subject: 'Merge pull request #12 from acme/x',
      pullRequestNumber: 12,
    });
  });

  it('reads a squash: the number from its suffix, the subject without it', () => {
    expect(mergeCommitFacts('Add a column for the gift note (#47)\r\n\r\n* one\n* two')).toEqual({
      subject: 'Add a column for the gift note',
      pullRequestNumber: 47,
    });
  });

  it('names no pull request for a direct push, and nothing for an empty message', () => {
    expect(mergeCommitFacts('Fix the footer link\n\nbody (#3)')).toEqual({
      subject: 'Fix the footer link',
      pullRequestNumber: null,
    });
    for (const message of [undefined, null, 42, '', '  \n\n ']) {
      expect(mergeCommitFacts(message)).toEqual({ subject: null, pullRequestNumber: null });
    }
  });

  it('refuses a number that is not a positive safe integer', () => {
    expect(mergeCommitFacts('Merge pull request #0 from a/b').pullRequestNumber).toBeNull();
    expect(mergeCommitFacts('Huge (#99999999999999999999)').pullRequestNumber).toBeNull();
  });

  it('caps a long subject', () => {
    const long = 'x'.repeat(COMMIT_SUBJECT_MAX + 50);
    expect(mergeCommitFacts(long).subject).toHaveLength(COMMIT_SUBJECT_MAX);
  });
});
