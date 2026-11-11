import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  getGitProvider,
  registeredGitProviderIds,
  UnknownGitProviderError,
  type GitProviderId,
} from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// The GitProvider seam (Story 7.10 · MOTIR-891) — the registry + the GitHub
// implementation's pure normalizers. No DB; importing `@/lib/git` registers the
// GitHub provider via its module side-effect.

describe('git provider registry', () => {
  it('registers GitHub as a resolvable provider', () => {
    expect(registeredGitProviderIds()).toContain('github');
    expect(getGitProvider('github').id).toBe('github');
  });

  it('registers GitLab as a resolvable provider (7.23 · MOTIR-1474)', () => {
    // GitLab implements the SAME interface + registers itself — additivity proven.
    expect(registeredGitProviderIds()).toContain('gitlab');
    expect(getGitProvider('gitlab').id).toBe('gitlab');
  });

  it('throws UnknownGitProviderError for a provider that is not registered', () => {
    expect(() => getGitProvider('bitbucket' as GitProviderId)).toThrow(UnknownGitProviderError);
  });
});

const github = getGitProvider('github');

function prEvent(over: Record<string, unknown> = {}): unknown {
  return {
    action: 'opened',
    repository: { id: 555 },
    pull_request: {
      number: 7,
      state: 'open',
      merged: false,
      title: 'feat: a thing',
      head: { ref: 'subtask/MOTIR-891-github-app', sha: 'abc123' },
      base: { ref: 'main' },
      ...over,
    },
  };
}

describe('github.parseChangeRequestEvent', () => {
  it('normalizes an opened pull_request payload', () => {
    expect(github.parseChangeRequestEvent(prEvent())).toEqual({
      providerRepoId: '555',
      number: 7,
      state: 'open',
      merged: false,
      headRef: 'subtask/MOTIR-891-github-app',
      baseRef: 'main',
      title: 'feat: a thing',
      draft: false,
      // MOTIR-7005 — the head COMMIT, the host's word for where the pull request is.
      headSha: 'abc123',
      // MOTIR-10340 — no `user` on this payload, so no author.
      author: null,
    });
  });

  it('reads the author from `pull_request.user` — the id as a string, and the login (MOTIR-10340)', () => {
    expect(
      github.parseChangeRequestEvent(prEvent({ user: { id: 4242, login: 'octo', type: 'User' } })),
    ).toMatchObject({ author: { githubUserId: '4242', login: 'octo' } });
    // An id without a login, or a login without an id, names no author.
    expect(github.parseChangeRequestEvent(prEvent({ user: { id: 4242 } }))).toMatchObject({
      author: null,
    });
    expect(github.parseChangeRequestEvent(prEvent({ user: { login: 'octo' } }))).toMatchObject({
      author: null,
    });
  });

  it('a payload whose head names no commit normalizes with headSha null (MOTIR-7005)', () => {
    expect(
      github.parseChangeRequestEvent(prEvent({ head: { ref: 'subtask/MOTIR-891-github-app' } })),
    ).toMatchObject({ headSha: null });
  });

  // MOTIR-4968 — the DRAFT flag, read off `pull_request.draft`. The payload has
  // always carried it; the seam did not, which is why a draft was
  // indistinguishable from a ready pull request.
  it('reads the DRAFT flag off a real draft payload (MOTIR-4968)', () => {
    expect(github.parseChangeRequestEvent(prEvent({ draft: true }))).toMatchObject({
      state: 'open',
      merged: false,
      draft: true,
    });
  });

  it('normalizes a MISSING draft field to false, never to a truthy guess', () => {
    // GitHub always sends it, but the parser is strict everywhere else and is
    // strict here: `=== true`, so an absent or non-boolean field is not a draft.
    expect(github.parseChangeRequestEvent(prEvent())).toMatchObject({ draft: false });
    expect(github.parseChangeRequestEvent(prEvent({ draft: 'yes' }))).toMatchObject({
      draft: false,
    });
  });

  it('marks a merged PR closed + merged', () => {
    const cr = github.parseChangeRequestEvent(prEvent({ state: 'closed', merged: true }));
    expect(cr).toMatchObject({ state: 'closed', merged: true });
  });

  it('marks a closed-unmerged PR closed but not merged', () => {
    const cr = github.parseChangeRequestEvent(prEvent({ state: 'closed', merged: false }));
    expect(cr).toMatchObject({ state: 'closed', merged: false });
  });

  it('returns null for a non-change-request payload', () => {
    expect(github.parseChangeRequestEvent({ zen: 'hi', repository: { id: 1 } })).toBeNull();
    expect(github.parseChangeRequestEvent(null)).toBeNull();
    // A PR payload missing the head ref is unusable → null.
    expect(github.parseChangeRequestEvent(prEvent({ head: {} }))).toBeNull();
    // Nor is one missing the BASE ref (MOTIR-1873) — a merge whose destination is
    // unknown cannot be judged against the trunk, so it does not normalize either.
    expect(github.parseChangeRequestEvent(prEvent({ base: {} }))).toBeNull();
  });
});

describe('github.changeRequestLifecycle', () => {
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
    expect(github.changeRequestLifecycle({ ...base, state: 'open', merged: false })).toBe(
      'implemented',
    );
    expect(github.changeRequestLifecycle({ ...base, state: 'closed', merged: true })).toBe('done');
    expect(github.changeRequestLifecycle({ ...base, state: 'closed', merged: false })).toBe('todo');
  });

  // MOTIR-4968 — the draft arm, and the two cases a blanket early return breaks.
  it('maps an OPEN DRAFT to NO lifecycle (MOTIR-4968)', () => {
    expect(
      github.changeRequestLifecycle({ ...base, state: 'open', merged: false, draft: true }),
    ).toBeNull();
  });

  it('still maps a CLOSED draft to todo — the case a top-of-function guard swallows', () => {
    // GitHub permits closing a draft without merging. If the draft guard sat
    // above the closed arm this would answer null and the card would be stranded
    // wherever it was, which is the whole reason the guard's POSITION is the rule.
    expect(
      github.changeRequestLifecycle({ ...base, state: 'closed', merged: false, draft: true }),
    ).toBe('todo');
  });

  it('still maps a MERGED draft to done — the seam does not depend on GitHub blocking it', () => {
    expect(
      github.changeRequestLifecycle({ ...base, state: 'closed', merged: true, draft: true }),
    ).toBe('done');
  });
});

describe('github.parseCiStatusEvent', () => {
  it('normalizes a completed check_run conclusion', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: {
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        name: 'ci',
        check_suite: { id: 87626227873, head_branch: 'feat/x' },
        pull_requests: [{ number: 7 }],
      },
    });
    expect(ev).toEqual({
      providerRepoId: '9',
      commitSha: 'abc123',
      conclusion: 'success',
      context: 'ci',
      prNumbers: [7],
      headBranch: 'feat/x',
      // The RUN this check belongs to (MOTIR-3209) — GitHub gives every workflow
      // run its own check suite, which is what lets a re-run at one commit
      // supersede the run it cancelled instead of merging into it by name.
      suiteId: '87626227873',
      // No `completed_at` in this payload, so the state cannot be dated.
      occurredAt: null,
    });
  });

  it('carries no suite id when the payload has none — the pre-MOTIR-3209 shape', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: {
        head_sha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        name: 'ci',
        check_suite: { head_branch: 'feat/x' },
        pull_requests: [],
      },
    });
    expect(ev).toMatchObject({ suiteId: null });
  });

  it('normalizes a completed check_suite conclusion (aggregate; app slug as context)', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_suite: {
        head_sha: 'abc123',
        head_branch: 'feat/x',
        status: 'completed',
        conclusion: 'failure',
        app: { slug: 'github-actions' },
        pull_requests: [{ number: 7 }, { number: 8 }],
        id: 87626129473,
      },
    });
    expect(ev).toEqual({
      providerRepoId: '9',
      commitSha: 'abc123',
      conclusion: 'failure',
      context: 'github-actions',
      prNumbers: [7, 8],
      headBranch: 'feat/x',
      suiteId: '87626129473',
      // The App slug names the APP, not the workflow, so the row is marked as a
      // roll-up the supersession rule must not read as a shared check (MOTIR-6274).
      suiteAggregate: true,
      occurredAt: null,
    });
  });

  // MOTIR-5918 — CodeQL default setup's suite, as GitHub's REST API returned it
  // for motir-gateway#45 at f6faeec (suite 96436591673): the PULL REF in
  // `head_branch` and no `pull_requests`. The ref names the PR by number, so it
  // is read as one; the literal is never offered as a branch to match.
  it('reads a refs/pull/<n>/head head_branch as PR <n>, not as a branch (check_run)', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: {
        head_sha: 'f6faeec',
        status: 'in_progress',
        conclusion: null,
        name: 'Analyze (go)',
        check_suite: { id: 96436591673, head_branch: 'refs/pull/45/head' },
        pull_requests: [],
      },
    });
    expect(ev).toMatchObject({ prNumbers: [45], headBranch: null, conclusion: 'pending' });
  });

  it('reads a refs/pull/<n>/merge head_branch as PR <n> (check_suite), merged with any PR list', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_suite: {
        id: 96436591673,
        head_sha: 'f6faeec',
        head_branch: 'refs/pull/45/merge',
        status: 'completed',
        conclusion: 'success',
        app: { slug: 'github-actions' },
        pull_requests: [{ number: 45 }, { number: 7 }],
      },
    });
    expect(ev).toMatchObject({ prNumbers: [45, 7], headBranch: null });
  });

  it('keeps a branch that merely LOOKS like a pull ref as a branch', () => {
    for (const branch of ['refs/pull/45', 'refs/pull/x/head', 'feat/refs/pull/45/head']) {
      const ev = github.parseCiStatusEvent({
        repository: { id: 9 },
        check_suite: { head_sha: 'a', head_branch: branch, status: 'queued', pull_requests: [] },
      });
      expect(ev).toMatchObject({ prNumbers: [], headBranch: branch });
    }
  });

  it('reports an in-progress check_run as pending', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: { head_sha: 'abc', status: 'in_progress', conclusion: null, name: 'ci' },
    });
    expect(ev).toMatchObject({ conclusion: 'pending' });
  });

  it('maps failing conclusions (timed_out) to failure', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      check_run: { head_sha: 'abc', status: 'completed', conclusion: 'timed_out', name: 'ci' },
    });
    expect(ev).toMatchObject({ conclusion: 'failure' });
  });

  it('normalizes a legacy commit-status payload', () => {
    const ev = github.parseCiStatusEvent({
      repository: { id: 9 },
      sha: 'deadbeef',
      state: 'failure',
      context: 'continuous-integration/ci',
    });
    expect(ev).toEqual({
      providerRepoId: '9',
      commitSha: 'deadbeef',
      conclusion: 'failure',
      context: 'continuous-integration/ci',
      prNumbers: [],
      headBranch: null,
      // A commit-`status` event predates check suites — there is no run to name,
      // and the rows it writes degrade to the one no-identity group.
      suiteId: null,
      occurredAt: null,
    });
  });

  // MOTIR-10456 — the time of the STATE the event reports, which is what orders a
  // late pending delivery against a terminal row (older: refused) and a re-run
  // (newer: written).
  it('dates a pending check_run by started_at and a completed one by completed_at', () => {
    const run = (status: string, conclusion: string | null) =>
      github.parseCiStatusEvent({
        repository: { id: 9 },
        check_run: {
          head_sha: 'abc',
          status,
          conclusion,
          name: 'ci',
          started_at: '2026-11-05T10:00:00Z',
          completed_at: status === 'completed' ? '2026-11-05T10:04:00Z' : null,
        },
      });
    expect(run('in_progress', null)?.occurredAt).toEqual(new Date('2026-11-05T10:00:00Z'));
    expect(run('queued', null)?.occurredAt).toEqual(new Date('2026-11-05T10:00:00Z'));
    expect(run('completed', 'success')?.occurredAt).toEqual(new Date('2026-11-05T10:04:00Z'));
  });

  it('dates a check_suite and a commit status by updated_at, and an unparseable time as null', () => {
    expect(
      github.parseCiStatusEvent({
        repository: { id: 9 },
        check_suite: { head_sha: 'a', status: 'queued', updated_at: '2026-11-05T10:01:00Z' },
      })?.occurredAt,
    ).toEqual(new Date('2026-11-05T10:01:00Z'));
    expect(
      github.parseCiStatusEvent({
        repository: { id: 9 },
        sha: 'deadbeef',
        state: 'pending',
        updated_at: '2026-11-05T10:02:00Z',
      })?.occurredAt,
    ).toEqual(new Date('2026-11-05T10:02:00Z'));
    expect(
      github.parseCiStatusEvent({
        repository: { id: 9 },
        check_run: { head_sha: 'a', status: 'in_progress', name: 'ci', started_at: 'not a date' },
      })?.occurredAt,
    ).toBeNull();
  });

  it('returns null for an unrelated payload', () => {
    expect(github.parseCiStatusEvent({ repository: { id: 9 }, foo: 1 })).toBeNull();
    expect(github.parseCiStatusEvent({ sha: 'x', state: 'success' })).toBeNull(); // no repo id
  });
});

// ⚠️ `github.fetchRepoTarball` HAD ITS OWN SUITE HERE UNTIL MOTIR-2124, and it
// went with the method. It proved the byte-returning path minted a token, hit
// `/repos/{owner}/{name}/tarball/{ref}` and returned the bytes — all true, and
// all about a method that had had ZERO production callers since MOTIR-2057 moved
// both code-graph jobs onto containers. What replaced the capability is
// `resolveRepoTarballUrl`, covered end to end in `tests/git/repoTarballUrl.test.ts`,
// which asserts the STRONGER property: the body is never read at all.

describe('github.parsePushEvent (MOTIR-893)', () => {
  const SHA = 'f'.repeat(40);

  it('normalizes a branch push (short branch name + head sha)', () => {
    expect(
      github.parsePushEvent({
        ref: 'refs/heads/main',
        after: SHA,
        repository: { id: 555 },
      }),
    ).toEqual({ providerRepoId: '555', branch: 'main', headSha: SHA });
  });

  it('keeps a slashed branch name intact', () => {
    expect(
      github.parsePushEvent({
        ref: 'refs/heads/subtask/MOTIR-893-feed',
        after: SHA,
        repository: { id: 555 },
      }),
    ).toMatchObject({ branch: 'subtask/MOTIR-893-feed' });
  });

  it('returns null for a tag push, a branch deletion, and a malformed body', () => {
    expect(
      github.parsePushEvent({ ref: 'refs/tags/v1.0.0', after: SHA, repository: { id: 555 } }),
    ).toBeNull();
    expect(
      github.parsePushEvent({
        ref: 'refs/heads/main',
        deleted: true,
        after: '0'.repeat(40),
        repository: { id: 555 },
      }),
    ).toBeNull();
    expect(github.parsePushEvent({ ref: 'refs/heads/main', after: SHA })).toBeNull(); // no repo
    expect(github.parsePushEvent('not an object')).toBeNull();
  });

  it('normalizes a missing/empty after to headSha null', () => {
    expect(github.parsePushEvent({ ref: 'refs/heads/main', repository: { id: 555 } })).toEqual({
      providerRepoId: '555',
      branch: 'main',
      headSha: null,
    });
  });
});

// --- CI-minutes metering capability (Story MOTIR-1775 · MOTIR-1896) ----------
// `docs/decisions/ci-minutes-allowance.md` §5.6 makes these OPTIONAL on the
// seam: GitHub is the only host whose compute Motir pays for, because Motir
// creates repositories only in its own GitHub org. GitLab is reachable through
// connect-existing only — a namespace the user owns and GitLab bills them for.

describe('the metering capability is GitHub-only, by design (§5.6)', () => {
  it('GitHub declares it; GitLab does not', () => {
    expect(typeof github.parseWorkflowRunEvent).toBe('function');
    expect(typeof github.fetchWorkflowRunJobs).toBe('function');
    expect(getGitProvider('gitlab').parseWorkflowRunEvent).toBeUndefined();
    expect(getGitProvider('gitlab').fetchWorkflowRunJobs).toBeUndefined();
  });

  it('the runner-FLEET capability is scoped the same way (MOTIR-1920)', () => {
    // Same structural reason, one card later: the fleet boots runners only for
    // repositories Motir hosts, and Motir hosts none on GitLab — so there is no
    // GitLab job it would ever provision for. `parseWorkflowJobEvent`'s own
    // behaviour is pinned in `tests/ciFleet/workflowJobEvent.test.ts`; what is
    // asserted here is that it stayed a CAPABILITY rather than becoming a
    // contract every provider must stub.
    expect(typeof github.parseWorkflowJobEvent).toBe('function');
    expect(getGitProvider('gitlab').parseWorkflowJobEvent).toBeUndefined();
  });
});

describe('github.parseWorkflowRunEvent (MOTIR-1896)', () => {
  function runDelivery(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: 'completed',
      repository: { id: 555, name: 'acme-web', owner: { login: 'motir-projects' } },
      workflow_run: {
        id: 7001,
        name: 'CI',
        run_attempt: 2,
        run_started_at: '2026-07-30T11:00:00Z',
        updated_at: '2026-07-30T12:00:00Z',
      },
      ...over,
    };
  }

  it('normalizes a completed run, taking the owner from the RUN payload (§5.5)', () => {
    expect(github.parseWorkflowRunEvent!(runDelivery())).toEqual({
      providerRepoId: '555',
      runId: '7001',
      attempt: 2,
      repoOwner: 'motir-projects',
      repoName: 'acme-web',
      workflowName: 'CI',
      completedAt: new Date('2026-07-30T12:00:00Z'),
    });
  });

  it('returns null for a run that has not completed (§5.7)', () => {
    // The predicate is evaluated at run COMPLETION — that is what makes the
    // repo-transfer edge fall out with no special handling.
    expect(github.parseWorkflowRunEvent!(runDelivery({ action: 'requested' }))).toBeNull();
    expect(github.parseWorkflowRunEvent!(runDelivery({ action: 'in_progress' }))).toBeNull();
  });

  it('defaults a payload with no run_attempt to attempt 1', () => {
    const delivery = runDelivery();
    delete (delivery['workflow_run'] as Record<string, unknown>)['run_attempt'];
    expect(github.parseWorkflowRunEvent!(delivery)).toMatchObject({ attempt: 1 });
  });

  it('ignores a nonsensical run_attempt rather than trusting it', () => {
    const delivery = runDelivery();
    (delivery['workflow_run'] as Record<string, unknown>)['run_attempt'] = 0;
    expect(github.parseWorkflowRunEvent!(delivery)).toMatchObject({ attempt: 1 });
  });

  it('falls back to run_started_at when updated_at is absent', () => {
    const delivery = runDelivery();
    delete (delivery['workflow_run'] as Record<string, unknown>)['updated_at'];
    expect(github.parseWorkflowRunEvent!(delivery)).toMatchObject({
      completedAt: new Date('2026-07-30T11:00:00Z'),
    });
  });

  it('REFUSES a run with no usable timestamp rather than guessing one', () => {
    // Without an instant the run cannot be assigned a period or a rate
    // effective-date, and inventing one would silently misfile real spend.
    const delivery = runDelivery();
    delete (delivery['workflow_run'] as Record<string, unknown>)['updated_at'];
    delete (delivery['workflow_run'] as Record<string, unknown>)['run_started_at'];
    expect(github.parseWorkflowRunEvent!(delivery)).toBeNull();
    (delivery['workflow_run'] as Record<string, unknown>)['updated_at'] = 'not-a-date';
    expect(github.parseWorkflowRunEvent!(delivery)).toBeNull();
  });

  it('returns null for a malformed or unrelated payload', () => {
    expect(github.parseWorkflowRunEvent!('not an object')).toBeNull();
    expect(github.parseWorkflowRunEvent!(runDelivery({ workflow_run: undefined }))).toBeNull();
    expect(github.parseWorkflowRunEvent!(runDelivery({ repository: undefined }))).toBeNull();
    expect(
      github.parseWorkflowRunEvent!(runDelivery({ repository: { id: 555, name: 'x' } })),
    ).toBeNull(); // no owner login
  });
});

describe('github.fetchWorkflowRunJobs (MOTIR-1896)', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    // Which App mints the token follows `motirOwnedOrgLogins()`, which reads the
    // worker's `fleet_shard` rows: a fleet test earlier in the same worker can
    // leave a `motir-projects` account behind and make that owner Motir's, so the
    // PROVISIONING App is picked. These tests are about the jobs endpoint, not the
    // role — configure both Apps so the result does not depend on file order.
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '998');
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubJobs(body: unknown, status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      const u = String(url);
      if (u.includes('/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_jobs',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reads the ATTEMPT-scoped jobs endpoint, so a re-run does not double-count', async () => {
    const fetchMock = stubJobs({
      jobs: [
        {
          id: 42,
          name: 'build',
          started_at: '2026-07-30T11:00:00Z',
          completed_at: '2026-07-30T11:05:00Z',
          labels: ['ubuntu-latest'],
        },
      ],
    });

    const jobs = await github.fetchWorkflowRunJobs!(
      '9001',
      'motir-projects',
      'acme-web',
      '7001',
      2,
    );

    expect(jobs).toEqual([
      {
        id: '42',
        name: 'build',
        startedAt: new Date('2026-07-30T11:00:00Z'),
        completedAt: new Date('2026-07-30T11:05:00Z'),
        labels: ['ubuntu-latest'],
      },
    ]);
    // `/runs/{id}/jobs` would return EVERY attempt's jobs; the attempt-scoped
    // path is what keeps a re-run billing only its own compute.
    const jobsUrl = String(
      fetchMock.mock.calls.find((c) => !String(c[0]).includes('access_tokens'))?.[0],
    );
    expect(jobsUrl).toContain('/repos/motir-projects/acme-web/actions/runs/7001/attempts/2/jobs');
  });

  it('does NOT use the closing-down /timing endpoint (§5.8)', async () => {
    const fetchMock = stubJobs({ jobs: [] });
    await github.fetchWorkflowRunJobs!('9001', 'motir-projects', 'acme-web', '7001', 1);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('/timing');
    }
  });

  it('normalizes a job with missing timestamps rather than dropping it', async () => {
    // Keeping the row makes "why did this run meter nothing?" answerable from
    // the job list; the arithmetic is what skips it.
    stubJobs({ jobs: [{ id: 43, name: 'queued', labels: [] }] });
    expect(await github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).toEqual([
      { id: '43', name: 'queued', startedAt: null, completedAt: null, labels: [] },
    ]);
  });

  it('drops an entry with no usable id, and tolerates a missing jobs array', async () => {
    stubJobs({ jobs: [{ name: 'nameless' }, 'garbage'] });
    expect(await github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).toEqual([]);
    stubJobs({});
    expect(await github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    stubJobs({ message: 'Not Found' }, 404);
    await expect(github.fetchWorkflowRunJobs!('9001', 'o', 'r', '7001', 1)).rejects.toThrow(
      /workflow-jobs endpoint returned 404/,
    );
  });
});

describe('github.fetchOrgComputeUsage (MOTIR-1896 — the reconciliation read)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the enhanced-billing usage endpoint with the org-billing token', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            usageItems: [
              {
                repositoryName: 'acme-web',
                sku: 'Actions Linux',
                quantity: 120,
                unitType: 'minutes',
                date: '2026-07-15',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const lines = await github.fetchOrgComputeUsage!('motir-projects', 2026, 7, 'ghp_audit');

    expect(lines).toEqual([
      {
        repositoryName: 'acme-web',
        sku: 'Actions Linux',
        quantity: 120,
        unitType: 'minutes',
        date: '2026-07-15',
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.github.com/organizations/motir-projects/settings/billing/usage?year=2026&month=7',
    );
    // The org-billing credential, NOT an installation token: an installation
    // token cannot read org billing at all.
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ghp_audit' });
  });

  it('drops malformed usage lines and throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ usageItems: [{ sku: 'Actions Linux' }, 'garbage'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    expect(await github.fetchOrgComputeUsage!('motir-projects', 2026, 7, 't')).toEqual([]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    await expect(github.fetchOrgComputeUsage!('motir-projects', 2026, 7, 't')).rejects.toThrow(
      /billing-usage endpoint returned 403/,
    );
  });
});

// The LIVENESS field on the normalized repo (MOTIR-1959). Pinned at the seam
// because this is where the fact ENTERS Motir: every guard downstream reads a
// mirror column that is only ever as honest as this normalization.
describe('fetchInstallationRepos carries the repository’s ARCHIVED state', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    _resetInstallationTokenCache();
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function stubRepos(repositories: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        if (u.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_repos',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/installation/repositories')) {
          return new Response(JSON.stringify({ repositories }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch to ${u}`);
      }),
    );
  }

  it('reads GitHub’s own `archived` boolean, per repository', async () => {
    stubRepos([
      { id: 1, name: 'live', full_name: 'moooon/live', default_branch: 'main', archived: false },
      { id: 2, name: 'dead', full_name: 'moooon/dead', default_branch: 'main', archived: true },
    ]);

    const repos = await getGitProvider('github').fetchInstallationRepos('inst-1');
    expect(repos.map((r) => [r.name, r.archived])).toEqual([
      ['live', false],
      ['dead', true],
    ]);
  });

  it('reads an ABSENT / non-boolean `archived` as live', async () => {
    // "Not known to be archived" is the state every mirror row was already in
    // before the column existed, so an omitted field must not archive a repo —
    // and a truthy non-boolean must not either (only `=== true` archives).
    stubRepos([
      { id: 1, name: 'no-field', full_name: 'moooon/no-field', default_branch: 'main' },
      {
        id: 2,
        name: 'stringy',
        full_name: 'moooon/stringy',
        default_branch: 'main',
        archived: 'true',
      },
    ]);

    const repos = await getGitProvider('github').fetchInstallationRepos('inst-1');
    expect(repos.every((r) => r.archived === false)).toBe(true);
  });
});
