import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';

// Story 7.23 · MOTIR-1476 — the GitLab code-graph FEED, against a real Postgres
// (the motir-core convention). Two triggers, both driving the SAME
// provider-agnostic indexer GitHub feeds (`codeGraphIndexService` dispatches by the
// stored `provider`):
//   * a `push` hook → the incremental `system.code-graph-refresh` job (mirror of
//     `githubWebhookService.handlePush` / MOTIR-893);
//   * a first-time `connectProject` → the full `system.code-graph-index` job
//     (mirror of GitHub's `enqueueNewlyAddedRepos` / MOTIR-1500).
// Only `fetch` (the GitLab host, for the connect path's authoritative project read)
// and `inngest.send` (the enqueue transport) are stubbed; every DB path is real.

const PASSWORD = 'hunter2hunter2';
const KEY = 'a'.repeat(64); // 64 hex chars → a valid 32-byte AES key
// A GitLab connection id is minted per workspace (`gitlab-ws-<id>`); the project id
// is the host's numeric id, stored as the repo's `repoId`.
const PROJECT_ID = '42';

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
  vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', KEY);
  // Connecting registers the project webhook (MOTIR-5349), which needs the secret;
  // the `fetch` stub below answers the hooks calls too.
  vi.stubEnv('GITLAB_WEBHOOK_SECRET', 'webhook-secret');
});
afterEach(() => {
  // `vi.spyOn` returns the SAME accumulating mock when re-spied and the global
  // inngest no-op is an assignment, so restore to isolate each test's history.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A fresh, history-clean spy on the enqueue transport (`inngest.send`). */
function spySend() {
  const spy = spyOnJobDispatch();
  spy.mockClear();
  return spy;
}

/** The spy's calls that enqueued `name`. */
function callsFor(sendSpy: { mock: { calls: unknown[][] } }, name: string) {
  return dispatchedEvents(sendSpy).filter((e) => e.name === name);
}

/** Seed a workspace + a GitLab connection with a still-valid token (so the token
 *  mint is a no-op read, no refresh fetch). Optionally seed a connected project row. */
async function makeScenario(email: string, opts: { withRepo?: boolean } = {}) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await withSystemContext(async (tx) => {
    const connection = await githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspace.id}`,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: encryptToken('good-token'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      tx,
    );
    if (opts.withRepo) {
      await githubRepoRepository.upsert(
        {
          installationId: connection.id,
          workspaceId: workspace.id,
          organizationId: workspace.organizationId,
          repoId: PROJECT_ID,
          owner: 'octocat',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
          provider: 'gitlab',
        },
        tx,
      );
    }
  });
  return { user, workspace, ctx: { userId: user.id, workspaceId: workspace.id } };
}

/** A GitLab `push` webhook body. The scenario repo is project 42 / branch `main`. */
function pushPayload(
  opts: { ref?: string; projectId?: number; after?: string } = {},
): Record<string, unknown> {
  return {
    object_kind: 'push',
    ref: opts.ref ?? 'refs/heads/main',
    after: opts.after ?? 'a'.repeat(40),
    project: { id: opts.projectId ?? Number(PROJECT_ID) },
  };
}

describe('gitlabWebhookService — push → code-graph refresh enqueue (MOTIR-1476)', () => {
  it('a default-branch push enqueues the incremental refresh job (async, not inline)', async () => {
    const { workspace } = await makeScenario('gl-push-default@example.com', { withRepo: true });
    const sendSpy = spySend();

    const res = await gitlabWebhookService.handleEvent('Push Hook', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });

    const calls = callsFor(sendSpy, 'system.code-graph-refresh');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({
      installationId: `gitlab-ws-${workspace.id}`,
      workspaceId: workspace.id,
      repoOwner: 'octocat',
      repoName: 'acme',
      defaultBranch: 'main',
      // MOTIR-11884: a push says it is one, so the run can hand motir-ai a `push`.
      refreshCause: 'push',
    });
  });

  it('a push to a NON-default branch is ignored — no refresh enqueued', async () => {
    await makeScenario('gl-push-feature@example.com', { withRepo: true });
    const sendSpy = spySend();

    const res = await gitlabWebhookService.handleEvent(
      'Push Hook',
      pushPayload({ ref: 'refs/heads/feature/MOTIR-1476' }),
    );
    expect(res).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(callsFor(sendSpy, 'system.code-graph-refresh')).toHaveLength(0);
  });

  it('a branch deletion (all-zero after) is ignored — not a branch push we index', async () => {
    await makeScenario('gl-push-delete@example.com', { withRepo: true });
    const sendSpy = spySend();

    const res = await gitlabWebhookService.handleEvent(
      'Push Hook',
      pushPayload({ after: '0'.repeat(40) }),
    );
    expect(res).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(callsFor(sendSpy, 'system.code-graph-refresh')).toHaveLength(0);
  });

  it('a push to a project we do not track is a clean no-op (missing repo degrades gracefully)', async () => {
    await makeScenario('gl-push-unknown@example.com', { withRepo: true });
    const sendSpy = spySend();

    const res = await gitlabWebhookService.handleEvent(
      'Push Hook',
      pushPayload({ projectId: 999 }),
    );
    expect(res).toEqual({ event: 'push', outcome: 'unknown_repo' });
    expect(callsFor(sendSpy, 'system.code-graph-refresh')).toHaveLength(0);
  });

  it('an enqueue transport failure never fails the ack (best-effort, fast 2xx)', async () => {
    await makeScenario('gl-push-enqueue-down@example.com', { withRepo: true });
    spyOnJobDispatch().mockRejectedValue(new Error('queue down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await gitlabWebhookService.handleEvent('Push Hook', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    expect(errorSpy).toHaveBeenCalled(); // dropped refresh is logged, not thrown
  });
});

describe('gitlabConnectionService — connect → full code-graph index (MOTIR-1476)', () => {
  /** Stub GitLab's `GET /api/v4/projects` so `connectProject` resolves the
   *  authoritative owner/name/branch for project 42. */
  function stubProjects() {
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      expect(String(url)).toContain('/api/v4/projects');
      return Response.json([
        {
          id: Number(PROJECT_ID),
          path: 'acme',
          path_with_namespace: 'octocat/acme',
          default_branch: 'main',
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('connecting a NEW project enqueues a full code-graph index for it', async () => {
    const { workspace, ctx } = await makeScenario('gl-connect-new@example.com');
    stubProjects();
    const sendSpy = spySend();

    await gitlabConnectionService.connectProject(ctx, PROJECT_ID);

    // The row is persisted…
    const repo = await withSystemContext((tx) =>
      githubRepoRepository.findByRepoIdAndProvider(PROJECT_ID, 'gitlab', tx),
    );
    expect(repo).not.toBeNull();

    // …and exactly one full-index job is enqueued for it, with the connection's id.
    const calls = callsFor(sendSpy, 'system.code-graph-index');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({
      installationId: `gitlab-ws-${workspace.id}`,
      workspaceId: workspace.id,
      repoOwner: 'octocat',
      repoName: 'acme',
      defaultBranch: 'main',
    });
  });

  it('RE-connecting an already-connected project does NOT re-index (only first connect)', async () => {
    const { ctx } = await makeScenario('gl-connect-again@example.com', { withRepo: true });
    stubProjects();
    const sendSpy = spySend();

    await gitlabConnectionService.connectProject(ctx, PROJECT_ID);

    expect(callsFor(sendSpy, 'system.code-graph-index')).toHaveLength(0);
  });
});
