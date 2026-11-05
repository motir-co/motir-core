import { describe, expect, it } from 'vitest';
import { getGitProvider, registeredGitProviderIds, type GitProviderId } from '@/lib/git';

// Story 7.23 · MOTIR-1474 — the GitLab provider's PURE normalizers + its
// registration. No DB, no network: importing `@/lib/git` registers GitLab via its
// module side-effect. Mirrors the GitHub half in tests/git/providerSeam.test.ts,
// proving the SAME seam handles GitLab's merge-request / pipeline / push payloads.

const gitlab = getGitProvider('gitlab');

describe('gitlab provider registration', () => {
  it('is registered + resolvable under the "gitlab" id', () => {
    expect(registeredGitProviderIds()).toContain('gitlab');
    expect(getGitProvider('gitlab' as GitProviderId).id).toBe('gitlab');
  });
});

function mrEvent(overAttrs: Record<string, unknown> = {}): unknown {
  return {
    object_kind: 'merge_request',
    project: { id: 42 },
    object_attributes: {
      iid: 7,
      state: 'opened',
      merged: false,
      title: 'feat: a thing',
      source_branch: 'subtask/MOTIR-1474-gitlab',
      target_branch: 'main',
      last_commit: { id: 'def456' },
      ...overAttrs,
    },
  };
}

describe('gitlab.parseChangeRequestEvent', () => {
  it('normalizes an opened merge_request payload', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent())).toEqual({
      providerRepoId: '42',
      number: 7,
      state: 'open',
      merged: false,
      headRef: 'subtask/MOTIR-1474-gitlab',
      baseRef: 'main',
      title: 'feat: a thing',
      draft: false,
      // MOTIR-7005 — the MR's head commit, `last_commit.id`.
      headSha: 'def456',
      // MOTIR-10340 — a GitLab user is never a GitHub author.
      author: null,
    });
  });

  it('an MR payload with no last_commit normalizes with headSha null (MOTIR-7005)', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent({ last_commit: undefined }))).toMatchObject({
      headSha: null,
    });
  });

  // MOTIR-4968 — the GitLab half of the DRAFT flag, asserted on its own so the
  // seam cannot have one provider silently omitting it. GitLab carries BOTH
  // names, so both are read.
  it('reads the DRAFT flag off `draft` (MOTIR-4968)', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent({ draft: true }))).toMatchObject({
      state: 'open',
      draft: true,
    });
  });

  it('reads the DRAFT flag off the legacy `work_in_progress` alias too', () => {
    // Self-hosted GitLab lags the SaaS release arbitrarily, so a single-name read
    // would fail silently on exactly the deployments that cannot upgrade.
    expect(gitlab.parseChangeRequestEvent(mrEvent({ work_in_progress: true }))).toMatchObject({
      draft: true,
    });
  });

  it('normalizes a MISSING draft field to false, never to a truthy guess', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent())).toMatchObject({ draft: false });
    expect(gitlab.parseChangeRequestEvent(mrEvent({ draft: 'yes' }))).toMatchObject({
      draft: false,
    });
  });

  it('marks a merged MR closed + merged (GitLab "merged" is its own state)', () => {
    const cr = gitlab.parseChangeRequestEvent(mrEvent({ state: 'merged' }));
    expect(cr).toMatchObject({ state: 'closed', merged: true });
  });

  it('marks a closed-unmerged MR closed but not merged', () => {
    const cr = gitlab.parseChangeRequestEvent(mrEvent({ state: 'closed' }));
    expect(cr).toMatchObject({ state: 'closed', merged: false });
  });

  it('treats a locked MR as open', () => {
    expect(gitlab.parseChangeRequestEvent(mrEvent({ state: 'locked' }))).toMatchObject({
      state: 'open',
    });
  });

  it('returns null for a non-merge_request payload or a missing source branch', () => {
    expect(gitlab.parseChangeRequestEvent({ object_kind: 'push', project: { id: 1 } })).toBeNull();
    expect(gitlab.parseChangeRequestEvent(null)).toBeNull();
    expect(gitlab.parseChangeRequestEvent(mrEvent({ source_branch: undefined }))).toBeNull();
    // …or the TARGET branch (MOTIR-1873) — the trunk gate has nothing to compare.
    expect(gitlab.parseChangeRequestEvent(mrEvent({ target_branch: undefined }))).toBeNull();
  });
});

describe('gitlab.changeRequestLifecycle', () => {
  const base = {
    providerRepoId: '1',
    number: 1,
    headRef: 'b',
    baseRef: 'main',
    title: null,
    draft: false,
    headSha: null,
    author: null,
  } as const;

  it('maps open → implemented, merged → done, closed-unmerged → todo (MOTIR-3005)', () => {
    expect(gitlab.changeRequestLifecycle({ ...base, state: 'open', merged: false })).toBe(
      'implemented',
    );
    expect(gitlab.changeRequestLifecycle({ ...base, state: 'closed', merged: true })).toBe('done');
    expect(gitlab.changeRequestLifecycle({ ...base, state: 'closed', merged: false })).toBe('todo');
  });

  // MOTIR-4968 — identical to GitHub's arm, asserted separately: "a draft is not
  // implemented" is provider-agnostic by construction, and the way that stays true
  // is that both implementations are held to it.
  it('maps an OPEN DRAFT to NO lifecycle (MOTIR-4968)', () => {
    expect(
      gitlab.changeRequestLifecycle({ ...base, state: 'open', merged: false, draft: true }),
    ).toBeNull();
  });

  it('still maps a CLOSED draft to todo — the case a top-of-function guard swallows', () => {
    expect(
      gitlab.changeRequestLifecycle({ ...base, state: 'closed', merged: false, draft: true }),
    ).toBe('todo');
  });

  it('still maps a MERGED draft to done', () => {
    expect(
      gitlab.changeRequestLifecycle({ ...base, state: 'closed', merged: true, draft: true }),
    ).toBe('done');
  });
});

describe('gitlab.parseCiStatusEvent', () => {
  function pipeline(status: string, extra: Record<string, unknown> = {}): unknown {
    return {
      object_kind: 'pipeline',
      project: { id: 9 },
      object_attributes: { id: 100, sha: 'abc123', ref: 'feat/x', status },
      ...extra,
    };
  }

  it('normalizes a successful pipeline with the associated MR iid + branch', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('success', { merge_request: { iid: 7 } }))).toEqual({
      providerRepoId: '9',
      commitSha: 'abc123',
      conclusion: 'success',
      context: 'pipeline',
      prNumbers: [7],
      headBranch: 'feat/x',
      // The PIPELINE is GitLab's run identity (MOTIR-3209) — the analogue of a
      // GitHub check suite, and what makes a retry at one sha supersede the run
      // it replaced instead of merging into it by job name.
      suiteId: '100',
      // No `finished_at` in this hook, so the state cannot be dated.
      occurredAt: null,
    });
  });

  // MOTIR-10456 — what orders a late `running` hook against a finished pipeline
  // row. A RETRIED job is a new build inside the SAME pipeline id, created after
  // the pipeline last finished; a late hook of the first attempt has none.
  it('dates a finished pipeline by finished_at', () => {
    expect(
      gitlab.parseCiStatusEvent({
        object_kind: 'pipeline',
        project: { id: 9 },
        object_attributes: {
          id: 100,
          sha: 'abc123',
          status: 'failed',
          created_at: '2026-11-05 10:00:00 UTC',
          finished_at: '2026-11-05 10:05:00 UTC',
        },
      })?.occurredAt,
    ).toEqual(new Date('2026-11-05T10:05:00Z'));
  });

  it('dates a running pipeline by the latest build it created or started', () => {
    const running = (builds: unknown) =>
      gitlab.parseCiStatusEvent({
        object_kind: 'pipeline',
        project: { id: 9 },
        object_attributes: {
          id: 100,
          sha: 'abc123',
          status: 'running',
          created_at: '2026-11-05 10:00:00 UTC',
          finished_at: null,
        },
        builds,
      })?.occurredAt;
    // A retry: the new build was created at 10:07, after the 10:05 finish.
    expect(
      running([
        { id: 1, created_at: '2026-11-05 10:00:01 UTC', started_at: '2026-11-05 10:00:30 UTC' },
        { id: 2, created_at: '2026-11-05 10:07:00 UTC', started_at: null },
        null,
      ]),
    ).toEqual(new Date('2026-11-05T10:07:00Z'));
    // No builds at all: the pipeline's own creation.
    expect(running(undefined)).toEqual(new Date('2026-11-05T10:00:00Z'));
  });

  it('dates nothing when the hook carries no usable time', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('running'))).toMatchObject({ occurredAt: null });
  });

  it('maps failed → failure, running → pending, skipped → neutral', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('failed'))).toMatchObject({ conclusion: 'failure' });
    expect(gitlab.parseCiStatusEvent(pipeline('running'))).toMatchObject({ conclusion: 'pending' });
    expect(gitlab.parseCiStatusEvent(pipeline('skipped'))).toMatchObject({ conclusion: 'neutral' });
  });

  it('has empty prNumbers when the pipeline carries no merge_request', () => {
    expect(gitlab.parseCiStatusEvent(pipeline('success'))).toMatchObject({ prNumbers: [] });
  });

  it('returns null for a non-pipeline payload or a missing project id', () => {
    expect(gitlab.parseCiStatusEvent({ object_kind: 'push', project: { id: 9 } })).toBeNull();
    expect(
      gitlab.parseCiStatusEvent({
        object_kind: 'pipeline',
        object_attributes: { sha: 'x', status: 'success' },
      }),
    ).toBeNull();
  });
});

describe('gitlab.parsePushEvent', () => {
  const SHA = 'f'.repeat(40);

  it('normalizes a branch push (short branch name + head sha)', () => {
    expect(
      gitlab.parsePushEvent({
        object_kind: 'push',
        ref: 'refs/heads/main',
        after: SHA,
        project: { id: 42 },
      }),
    ).toEqual({ providerRepoId: '42', branch: 'main', headSha: SHA });
  });

  it('keeps a slashed branch name intact', () => {
    expect(
      gitlab.parsePushEvent({
        object_kind: 'push',
        ref: 'refs/heads/subtask/MOTIR-1476-feed',
        after: SHA,
        project: { id: 42 },
      }),
    ).toMatchObject({ branch: 'subtask/MOTIR-1476-feed' });
  });

  it('returns null for a tag push, a branch deletion, and a missing project', () => {
    expect(
      gitlab.parsePushEvent({
        object_kind: 'tag_push',
        ref: 'refs/tags/v1',
        after: SHA,
        project: { id: 42 },
      }),
    ).toBeNull();
    expect(
      gitlab.parsePushEvent({
        object_kind: 'push',
        ref: 'refs/heads/main',
        after: '0'.repeat(40),
        project: { id: 42 },
      }),
    ).toBeNull();
    expect(
      gitlab.parsePushEvent({ object_kind: 'push', ref: 'refs/heads/main', after: SHA }),
    ).toBeNull();
  });
});
