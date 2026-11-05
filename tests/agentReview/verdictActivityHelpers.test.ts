import { describe, expect, it } from 'vitest';
import {
  FINDINGS_EXCERPT_MAX,
  findingsExcerptOf,
  isAnsweringSendBack,
  nameOfDeciderLabel,
  reviewCommitsLabel,
} from '@/lib/agentReview/verdictActivity';

// The pure helpers the verdict entry and the record line share (MOTIR-10338).

describe('verdictActivity helpers', () => {
  it('only an answering send-back notifies', () => {
    expect(isAnsweringSendBack({ verdict: 'changes_requested', outcome: 'decided' })).toBe(true);
    expect(isAnsweringSendBack({ verdict: 'changes_requested', outcome: 'recorded' })).toBe(true);
    expect(isAnsweringSendBack({ verdict: 'changes_requested', outcome: 'late' })).toBe(false);
    expect(isAnsweringSendBack({ verdict: 'changes_requested', outcome: 'second' })).toBe(false);
    expect(isAnsweringSendBack({ verdict: 'pass', outcome: 'decided' })).toBe(false);
  });

  it('excerpts findings: none for blank, whole when short, cut with an ellipsis when long', () => {
    expect(findingsExcerptOf(null)).toBeNull();
    expect(findingsExcerptOf('   ')).toBeNull();
    expect(findingsExcerptOf('  short  ')).toBe('short');
    const long = 'x'.repeat(FINDINGS_EXCERPT_MAX + 50);
    const cut = findingsExcerptOf(long)!;
    expect(cut).toHaveLength(FINDINGS_EXCERPT_MAX);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('names a set’s commits, and shows an unparsable version as written', () => {
    expect(
      reviewCommitsLabel(
        'acme/api#41@9b07de4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,acme/web#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe('acme/api#41 @ 9b07de4, acme/web#88 @ 3f2a9c1');
    expect(reviewCommitsLabel('not-a-version')).toBe('not-a-version');
  });

  it('drops the address from a decider label, and keeps a label that is only an address', () => {
    expect(nameOfDeciderLabel('Ana Lima <ana@ex.com>')).toBe('Ana Lima');
    expect(nameOfDeciderLabel('Ana Lima')).toBe('Ana Lima');
    expect(nameOfDeciderLabel('<ana@ex.com>')).toBe('<ana@ex.com>');
  });
});
