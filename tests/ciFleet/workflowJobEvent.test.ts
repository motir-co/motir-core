import { describe, expect, it } from 'vitest';
import { getGitProvider } from '@/lib/git';

// `parseWorkflowJobEvent` — the GitHub half of the fleet's normalize-then-service
// shape (Story MOTIR-1916 · MOTIR-1920). Pure: no DB, no network. The webhook
// handler holds no GitHub-specific parsing (the `GitProvider` seam), so the
// payload-shape contract is pinned here.

const provider = getGitProvider('github');

/** A `workflow_job` delivery shaped like GitHub's own — the fields the fleet
 *  reads, in the places GitHub puts them. */
function jobPayload(
  overrides: {
    action?: string;
    labels?: unknown;
    runAttempt?: unknown;
    startedAt?: unknown;
    createdAt?: unknown;
    jobId?: unknown;
    runId?: unknown;
    repository?: unknown;
  } = {},
) {
  const job: Record<string, unknown> = {
    id: 44001,
    run_id: 7001,
    run_attempt: overrides.runAttempt ?? 1,
    name: 'build',
    workflow_name: 'CI',
    status: 'queued',
    labels: overrides.labels ?? ['motir-runner'],
    started_at: overrides.startedAt ?? '2026-08-01T09:00:00Z',
  };
  if ('jobId' in overrides) job['id'] = overrides.jobId;
  if ('runId' in overrides) job['run_id'] = overrides.runId;
  if ('createdAt' in overrides) job['created_at'] = overrides.createdAt;
  if (overrides.startedAt === null) delete job['started_at'];

  const payload: Record<string, unknown> = {
    action: overrides.action ?? 'queued',
    workflow_job: job,
    repository: {
      id: 99001,
      name: 'acme-web',
      owner: { login: 'motir-projects' },
    },
    installation: { id: 55501 },
  };
  if ('repository' in overrides) payload['repository'] = overrides.repository;
  return payload;
}

describe('parseWorkflowJobEvent — only a QUEUED job normalizes', () => {
  it('normalizes a queued job, carrying the ids, labels and queue instant', () => {
    expect(provider.parseWorkflowJobEvent!(jobPayload())).toEqual({
      providerRepoId: '99001',
      runId: '7001',
      runAttempt: 1,
      jobId: '44001',
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: ['motir-runner'],
      queuedAt: new Date('2026-08-01T09:00:00Z'),
    });
  });

  it.each(['in_progress', 'completed', 'waiting'])('ignores the `%s` action', (action) => {
    // Provisioning for these boots a machine nothing will claim: `in_progress`
    // means a runner was already assigned, `completed` means the work is done.
    // The runner would then idle until its timeout, costing real money for no
    // work — which is why this is refused at the parser rather than downstream.
    expect(provider.parseWorkflowJobEvent!(jobPayload({ action }))).toBeNull();
  });

  it('carries the run ATTEMPT, so a re-run is a distinct provisioning request', () => {
    const parsed = provider.parseWorkflowJobEvent!(jobPayload({ runAttempt: 2 }));
    expect(parsed?.runAttempt).toBe(2);
  });

  it('defaults a missing/invalid run_attempt to 1', () => {
    expect(provider.parseWorkflowJobEvent!(jobPayload({ runAttempt: undefined }))?.runAttempt).toBe(
      1,
    );
    expect(provider.parseWorkflowJobEvent!(jobPayload({ runAttempt: 0 }))?.runAttempt).toBe(1);
    expect(provider.parseWorkflowJobEvent!(jobPayload({ runAttempt: 'two' }))?.runAttempt).toBe(1);
  });

  it('falls back to `created_at` when `started_at` is absent', () => {
    const parsed = provider.parseWorkflowJobEvent!(
      jobPayload({ startedAt: null, createdAt: '2026-08-01T08:30:00Z' }),
    );
    expect(parsed?.queuedAt).toEqual(new Date('2026-08-01T08:30:00Z'));
  });

  it('REFUSES a delivery with no usable queue instant rather than stamping `now`', () => {
    // The age of an unclaimed intent is the stuck-queue signal; a guessed
    // timestamp would make a job that queued an hour ago look fresh.
    expect(provider.parseWorkflowJobEvent!(jobPayload({ startedAt: null }))).toBeNull();
  });

  it('keeps only string labels, and tolerates a missing labels array', () => {
    expect(
      provider.parseWorkflowJobEvent!(jobPayload({ labels: ['motir-runner', 7, null] }))
        ?.requestedLabels,
    ).toEqual(['motir-runner']);
    expect(
      provider.parseWorkflowJobEvent!(jobPayload({ labels: 'motir-runner' }))?.requestedLabels,
    ).toEqual([]);
  });

  it.each([
    ['a non-object payload', 'nope' as unknown],
    ['a payload with no workflow_job', { action: 'queued', repository: {} } as unknown],
  ])('returns null for %s', (_label, payload) => {
    expect(provider.parseWorkflowJobEvent!(payload)).toBeNull();
  });

  it.each([
    ['no job id', { jobId: null }],
    ['no run id', { runId: null }],
    ['no repository', { repository: null }],
    ['no repo owner login', { repository: { id: 99001, name: 'acme-web', owner: {} } }],
    ['no repo name', { repository: { id: 99001, owner: { login: 'motir-projects' } } }],
  ])('returns null when the payload has %s', (_label, overrides) => {
    expect(provider.parseWorkflowJobEvent!(jobPayload(overrides))).toBeNull();
  });

  it('reads the OWNER from the delivery, never from a mirror (§5.5)', () => {
    // The same rule the meter follows: a repo that has been transferred to its
    // user reports the NEW owner here while the mirror may still hold the old
    // one, and the fleet's runner group belongs to the owner the delivery names.
    const parsed = provider.parseWorkflowJobEvent!(
      jobPayload({ repository: { id: 99001, name: 'acme-web', owner: { login: 'acme-inc' } } }),
    );
    expect(parsed?.repoOwner).toBe('acme-inc');
  });
});

describe('parseWorkflowJobProgressEvent — a runner took the job, or it finished (MOTIR-11230)', () => {
  function progressPayload(
    action: string,
    job: Record<string, unknown> = {},
    payload: Record<string, unknown> = {},
  ) {
    const base = jobPayload({ action });
    const workflowJob = { ...(base['workflow_job'] as Record<string, unknown>), ...job };
    return { ...base, workflow_job: workflowJob, ...payload };
  }

  it('normalizes an in_progress job, carrying the runner GitHub assigned it to', () => {
    expect(
      provider.parseWorkflowJobProgressEvent!(progressPayload('in_progress', { runner_id: 9001 })),
    ).toEqual({
      action: 'in_progress',
      runId: '7001',
      runAttempt: 1,
      jobId: '44001',
      runnerId: 9001,
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      requestedLabels: ['motir-runner'],
      completedAt: null,
    });
  });

  it('normalizes a completed job with its completion instant', () => {
    expect(
      provider.parseWorkflowJobProgressEvent!(
        progressPayload('completed', {
          runner_id: 9002,
          run_attempt: 3,
          completed_at: '2026-08-01T09:07:00Z',
        }),
      ),
    ).toMatchObject({
      action: 'completed',
      runAttempt: 3,
      runnerId: 9002,
      completedAt: new Date('2026-08-01T09:07:00Z'),
    });
  });

  it('a job cancelled while queued completes with NO runner', () => {
    for (const runnerId of [null, 0, 'x']) {
      expect(
        provider.parseWorkflowJobProgressEvent!(
          progressPayload('completed', { runner_id: runnerId }),
        ),
      ).toMatchObject({ runnerId: null, completedAt: null });
    }
  });

  it('defaults a missing or invalid run attempt to 1 and drops non-string labels', () => {
    expect(
      provider.parseWorkflowJobProgressEvent!(
        progressPayload('in_progress', { run_attempt: 0, labels: ['motir-runner', 7] }),
      ),
    ).toMatchObject({ runAttempt: 1, requestedLabels: ['motir-runner'] });
    expect(
      provider.parseWorkflowJobProgressEvent!(progressPayload('in_progress', { labels: 'x' })),
    ).toMatchObject({ requestedLabels: [] });
  });

  it.each(['queued', 'waiting', undefined])('ignores the `%s` action', (action) => {
    const payload = progressPayload('in_progress');
    expect(provider.parseWorkflowJobProgressEvent!({ ...payload, action })).toBeNull();
  });

  it('refuses a malformed body', () => {
    expect(provider.parseWorkflowJobProgressEvent!(null)).toBeNull();
    expect(provider.parseWorkflowJobProgressEvent!({ action: 'completed' })).toBeNull();
    expect(
      provider.parseWorkflowJobProgressEvent!(progressPayload('completed', { id: null })),
    ).toBeNull();
    expect(
      provider.parseWorkflowJobProgressEvent!(
        progressPayload('completed', {}, { repository: { id: 1, name: 'acme-web' } }),
      ),
    ).toBeNull();
    expect(
      provider.parseWorkflowJobProgressEvent!(
        progressPayload('completed', {}, { repository: { id: 1, owner: { login: 'o' } } }),
      ),
    ).toBeNull();
  });
});
