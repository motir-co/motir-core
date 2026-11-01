// MOTIR-10031 — `parseProductionImageRunEvent`, the GitHub half of a merge
// release. Pure: no DB, no network. The payload is a recorded-shape fixture of a
// completed `production-image` run; each test changes one field of it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getGitProvider } from '@/lib/git';

const FIXTURE = 'tests/fixtures/github/workflow-run/production-image.completed.json';
const provider = getGitProvider('github');

type Payload = {
  action?: unknown;
  workflow_run: Record<string, unknown>;
  repository: Record<string, unknown>;
};

function payload(): Payload {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Payload;
}

const parse = (body: unknown) => provider.parseProductionImageRunEvent!(body);

describe('github.parseProductionImageRunEvent', () => {
  it('normalizes a completed production-image run', () => {
    expect(parse(payload())).toEqual({
      providerRepoId: '880011',
      repoOwner: 'motir-projects',
      repoName: 'shop',
      workflowName: 'production-image',
      event: 'push',
      headBranch: 'main',
      headSha: '4f1c2b8e9a7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b',
      conclusion: 'success',
      runId: '9182736450',
      runAttempt: 1,
      headCommitSubject: 'Show the delivery estimate on the basket',
      pullRequestNumber: 48,
    });
  });

  it('reads a squash subject and its pull request, and still parses a run with no head commit (MOTIR-10103)', () => {
    const squash = payload();
    squash.workflow_run['head_commit'] = {
      message: 'Add a column for the gift note (#47)\n\nBody',
    };
    expect(parse(squash)).toMatchObject({
      headCommitSubject: 'Add a column for the gift note',
      pullRequestNumber: 47,
    });
    for (const headCommit of [undefined, null, { message: 42 }, { message: '' }]) {
      const body = payload();
      body.workflow_run['head_commit'] = headCommit;
      expect(parse(body)).toMatchObject({
        headSha: '4f1c2b8e9a7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b',
        headCommitSubject: null,
        pullRequestNumber: null,
      });
    }
  });

  it('keeps a re-run attempt, and reads a missing or malformed attempt as 1', () => {
    const rerun = payload();
    rerun.workflow_run['run_attempt'] = 3;
    expect(parse(rerun)?.runAttempt).toBe(3);
    for (const bad of [undefined, 0, 1.5, '2']) {
      const body = payload();
      body.workflow_run['run_attempt'] = bad;
      expect(parse(body)?.runAttempt).toBe(1);
    }
  });

  it('passes the event, branch and conclusion through for the service to filter', () => {
    const body = payload();
    body.workflow_run['event'] = 'pull_request';
    body.workflow_run['head_branch'] = 'feature/x';
    body.workflow_run['conclusion'] = 'timed_out';
    expect(parse(body)).toMatchObject({
      event: 'pull_request',
      headBranch: 'feature/x',
      conclusion: 'timed_out',
    });
  });

  it.each(['requested', 'in_progress', undefined])('is null for action %s', (action) => {
    const body = payload();
    body.action = action;
    expect(parse(body)).toBeNull();
  });

  it.each([
    ['head sha', 'head_sha'],
    ['head branch', 'head_branch'],
    ['workflow name', 'name'],
    ['run id', 'id'],
    ['conclusion', 'conclusion'],
    ['triggering event', 'event'],
  ])('is null when the %s is missing or empty', (_label, field) => {
    const missing = payload();
    delete missing.workflow_run[field];
    expect(parse(missing)).toBeNull();
    const empty = payload();
    empty.workflow_run[field] = '';
    expect(parse(empty)).toBeNull();
  });

  it('is null when the repository id, owner or name is missing', () => {
    const noId = payload();
    delete noId.repository['id'];
    const noOwner = payload();
    delete noOwner.repository['owner'];
    const noName = payload();
    delete noName.repository['name'];
    for (const body of [noId, noOwner, noName]) expect(parse(body)).toBeNull();
  });

  it('is null for a body that is not a workflow_run delivery', () => {
    expect(parse(null)).toBeNull();
    expect(parse('completed')).toBeNull();
    expect(parse({ action: 'completed' })).toBeNull();
    expect(parse({ action: 'completed', workflow_run: {} })).toBeNull();
  });

  it("leaves the meter's parser as it was: a run it meters needs no head sha", () => {
    const body = payload();
    delete body.workflow_run['head_sha'];
    expect(provider.parseWorkflowRunEvent!(body)).toMatchObject({ runId: '9182736450' });
    expect(parse(body)).toBeNull();
  });

  it('is GitHub-only', () => {
    expect(getGitProvider('gitlab').parseProductionImageRunEvent).toBeUndefined();
  });
});
