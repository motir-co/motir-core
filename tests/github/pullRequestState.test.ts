import { describe, expect, it } from 'vitest';
import { hostConfirmedMotirMerge, presentedPullRequestState } from '@/lib/github/pullRequestState';

// THE PRESENTED PULL-REQUEST STATE (Bug MOTIR-12232): `merged` once the host has said so,
// by its delivery or by its answer to Motir's own merge — never on a queue entry.

const open = { state: 'open', merged: false, mergeOutcomeRef: null };

describe('hostConfirmedMotirMerge', () => {
  it('is true for a recorded merge commit, false for a queue entry or no record', () => {
    expect(hostConfirmedMotirMerge('3f2a9c1')).toBe(true);
    expect(hostConfirmedMotirMerge('queue:MQE_1')).toBe(false);
    expect(hostConfirmedMotirMerge(null)).toBe(false);
  });
});

describe('presentedPullRequestState', () => {
  it('reads open and closed as delivered when Motir recorded no merge', () => {
    expect(presentedPullRequestState(open)).toBe('open');
    expect(presentedPullRequestState({ ...open, state: 'closed' })).toBe('closed');
  });

  it('reads merged from the delivery', () => {
    expect(
      presentedPullRequestState({ state: 'closed', merged: true, mergeOutcomeRef: null }),
    ).toBe('merged');
  });

  it('reads merged from the host’s answer to Motir’s merge, before any delivery', () => {
    expect(presentedPullRequestState({ ...open, mergeOutcomeRef: 'merge-11' })).toBe('merged');
  });

  it('an enqueued pull request is still open', () => {
    expect(presentedPullRequestState({ ...open, mergeOutcomeRef: 'queue:MQE_1' })).toBe('open');
  });
});
