import { describe, expect, it } from 'vitest';
import {
  firstPostMergeChildTell,
  isPostMergeChildCandidate,
  isPostMergeChildCheckExemptContainer,
} from '@/lib/workItems/proseVsGraph';

// The PURE half of the POST-MERGE-CHILD check (MOTIR-8863).

describe('firstPostMergeChildTell', () => {
  it('reads the MOTIR-8860 tell from the Context, outside any criterion', () => {
    const body = [
      '## Context',
      '',
      'Earliest legal start: after the deploy that ships the controller has finished.',
      '',
      '## Acceptance criteria',
      '',
      '1. the seven steps pass',
    ].join('\n');
    expect(firstPostMergeChildTell(body)).toBe('earliest legal start');
  });

  it('is markup- and wrap-tolerant', () => {
    expect(firstPostMergeChildTell('Run it **after the\ndeploy** completes')).toBe(
      'after the deploy',
    );
  });

  it('is word-bounded and quiet on a body that reads nothing post-deploy', () => {
    expect(firstPostMergeChildTell('Wire the reproduction into CI')).toBeNull();
    expect(firstPostMergeChildTell(null)).toBeNull();
  });
});

// MOTIR-10057: the five post-deploy verification cards MOTIR-9710's lay put
// inside the story. Each body takes the merge or the deployment as given, and
// none of them used a phrase from the list, so the advisory stayed silent.
describe('firstPostMergeChildTell — a body that takes the merge as given (MOTIR-10057)', () => {
  it.each([
    [
      'MOTIR-9890',
      'Where it starts. The motir-infra and motir-core cards listed in the blockers have merged: the parameter model and topic.',
      'have merged',
    ],
    [
      'MOTIR-9892',
      'Starts from: the deployed-state read-back card has recorded the memory alarm in OK.',
      'the deployed',
    ],
    ['MOTIR-9893', 'the breach entrypoint is in the **deployed** core image', 'the deployed'],
    [
      'MOTIR-9894',
      'Starts from the deployed state recorded by the rehearsal read-back card.',
      'the deployed',
    ],
    [
      'MOTIR-9895',
      'Record the account, region, cluster, the three service names, the deployed image digests.',
      'the deployed',
    ],
  ])('%s', (_key, body, phrase) => {
    expect(firstPostMergeChildTell(body)).toBe(phrase);
  });

  it('reads "has been merged" and "deployed to" as well', () => {
    expect(firstPostMergeChildTell('Starts once the infra card has been\nmerged.')).toBe(
      'have merged',
    );
    expect(
      firstPostMergeChildTell('once the monitoring work is deployed to the rehearsal services'),
    ).toBe('deployed to');
  });

  it('stays quiet on a body that only mentions deploying or merging', () => {
    expect(firstPostMergeChildTell('Nothing is deployed or changed by this card.')).toBeNull();
    expect(firstPostMergeChildTell('Read the deploy workflow and record its inputs.')).toBeNull();
    expect(firstPostMergeChildTell('Decide whether the two configs should be merged.')).toBeNull();
  });
});

describe('scope', () => {
  it('asks only the cards that wait on a deployment', () => {
    expect(isPostMergeChildCandidate('verification', 'coding_agent')).toBe(true);
    expect(isPostMergeChildCandidate('deploy', null)).toBe(true);
    expect(isPostMergeChildCandidate('code', 'human')).toBe(true);
    expect(isPostMergeChildCandidate('code', 'coding_agent')).toBe(false);
  });

  it('never asks a child of an epic or a root', () => {
    expect(isPostMergeChildCheckExemptContainer('epic')).toBe(true);
    expect(isPostMergeChildCheckExemptContainer(null)).toBe(true);
    expect(isPostMergeChildCheckExemptContainer('story')).toBe(false);
  });
});
