import { describe, expect, it } from 'vitest';
import {
  PREVIEW_IMAGE_WORKFLOW_PATH,
  parsePreviewImageRunEvent,
  parsePreviewPullRequestEvent,
} from '@/lib/preview/lifecycleEvents';

// What the preview lifecycle reads of a delivery (MOTIR-5776): exactly the
// actions and runs it acts on, and null for everything else.

const SHA = 'c'.repeat(40);
const repo = { repository: { id: 9001 }, installation: { id: 556677 } };

const pr = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  pull_request: { number: 4, head: { sha: SHA } },
  ...repo,
  ...extra,
});

const run = (workflowRun: Record<string, unknown>, action = 'completed') => ({
  action,
  workflow_run: {
    path: PREVIEW_IMAGE_WORKFLOW_PATH,
    event: 'pull_request',
    head_sha: SHA,
    pull_requests: [{ number: 4 }],
    conclusion: 'success',
    ...workflowRun,
  },
  ...repo,
});

describe('parsePreviewPullRequestEvent', () => {
  it.each(['opened', 'synchronize', 'reopened'])('reads %s as a new head', (action) => {
    expect(parsePreviewPullRequestEvent(pr(action))).toEqual({
      kind: 'head',
      installationId: '556677',
      providerRepoId: '9001',
      pullRequestNumber: 4,
      headSha: SHA,
    });
  });

  it('reads closed as a close, merged or not, and string ids as ids', () => {
    expect(
      parsePreviewPullRequestEvent(
        pr('closed', { repository: { id: '9001' }, installation: { id: '556677' } }),
      ),
    ).toMatchObject({ kind: 'closed', providerRepoId: '9001', installationId: '556677' });
  });

  it('falls back to the delivery number when the pull request carries none', () => {
    expect(
      parsePreviewPullRequestEvent({
        ...pr('opened'),
        number: 5,
        pull_request: { head: { sha: SHA } },
      }),
    ).toMatchObject({ pullRequestNumber: 5 });
  });

  it.each([
    ['another action', pr('labeled')],
    ['no installation', { ...pr('opened'), installation: null }],
    ['a non-numeric repository id', { ...pr('opened'), repository: { id: 'x' } }],
    ['no head', { ...pr('opened'), pull_request: { number: 4 } }],
    ['an empty head', { ...pr('opened'), pull_request: { number: 4, head: { sha: '' } } }],
    ['an array for a pull request', { ...pr('opened'), pull_request: [] }],
  ])('is null for %s', (_label, body) => {
    expect(parsePreviewPullRequestEvent(body as Record<string, unknown>)).toBeNull();
  });
});

describe('parsePreviewImageRunEvent', () => {
  it('reads a successful run of the preview-image workflow', () => {
    expect(parsePreviewImageRunEvent(run({}))).toEqual({
      installationId: '556677',
      providerRepoId: '9001',
      pullRequestNumber: 4,
      headSha: SHA,
      conclusion: 'success',
      rawConclusion: 'success',
    });
  });

  it.each(['failure', 'cancelled', 'timed_out'])('reads %s as a failure, keeping the word', (c) => {
    expect(parsePreviewImageRunEvent(run({ conclusion: c }))).toMatchObject({
      conclusion: 'failure',
      rawConclusion: c,
    });
  });

  it('reads a missing conclusion as an unknown failure', () => {
    expect(parsePreviewImageRunEvent(run({ conclusion: null }))).toMatchObject({
      conclusion: 'failure',
      rawConclusion: 'unknown',
    });
  });

  it.each([
    ['a run still going', run({}, 'in_progress')],
    ['another workflow', run({ path: '.github/workflows/ci.yml' })],
    ['a push-triggered run', run({ event: 'push' })],
    ['a run with no pull request (a fork)', run({ pull_requests: [] })],
    ['a run with no pull-request list', run({ pull_requests: null })],
    ['a run with no head', run({ head_sha: '' })],
    ['no run at all', { action: 'completed', ...repo }],
    ['no repository', { ...run({}), repository: null }],
  ])('is null for %s', (_label, body) => {
    expect(parsePreviewImageRunEvent(body as Record<string, unknown>)).toBeNull();
  });
});
