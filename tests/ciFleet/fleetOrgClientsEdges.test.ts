import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { resolveOrgAuth, OrgTargetAuthError, type GithubOrgTarget } from '@/lib/github/orgTarget';
import {
  getOrgInstallation,
  latestWorkflowCommit,
  listInstallationRepositoryIds,
  OrgInstallationReadError,
  readWorkflowSources,
} from '@/lib/github/orgInstallation';
import { RepoVisibilityApiError, repoVisibilityClient } from '@/lib/github/repoVisibility';
import { ActionsVariableApiError, actionsVariableClient } from '@/lib/github/actionsVariables';
import { toFleetOrgCiStoredStateDTO } from '@/lib/mappers/fleetOrgCiSettingMappers';

// THE EDGES OF THE FLEET'S ORG-SCOPED GITHUB CLIENTS (Story MOTIR-8699 · MOTIR-8716
// part B). The connected-org story gate drives these through the happy path; this
// file drives every refusal, transport failure and malformed body each one is
// written to reject, so the per-file coverage floor the story's files carry in
// `vitest.config.ts` measures behaviour rather than luck.
//
// Nothing here is mocked but `fetch`: the App JWT is signed for real with a
// throwaway key, and the token cache is the real one, reset between cases.

const { privateKey: APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TARGET: GithubOrgTarget = {
  org: 'acme-connected',
  installationId: '880011',
  role: 'provisioning',
};

type Answer =
  | { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
  | { throws: unknown }
  | { response: unknown };

/** Routes by `METHOD path` (path with its query); the access-token mint answers a
 *  token unless a route overrides it. */
let routes: Map<string, Answer[]>;
let calls: string[];

function route(key: string, ...answers: Answer[]): void {
  routes.set(key, answers);
}

const fetchFake = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
  calls.push(key);
  const queue = routes.get(key);
  let answer: Answer | undefined = queue && queue.length > 1 ? queue.shift() : queue?.[0];
  if (!answer && /\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
    answer = {
      status: 201,
      body: { token: 'ghs_t', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    };
  }
  if (!answer) return new Response(`unrouted ${key}`, { status: 599 });
  if ('throws' in answer) throw answer.throws;
  if ('response' in answer) return answer.response as Response;
  const empty = answer.status === 204 && answer.body === undefined && answer.raw === undefined;
  return new Response(empty ? null : (answer.raw ?? JSON.stringify(answer.body ?? null)), {
    status: answer.status,
    headers: answer.headers,
  });
});

beforeEach(() => {
  routes = new Map();
  calls = [];
  vi.stubGlobal('fetch', fetchFake);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', APP_PRIVATE_KEY);
  _resetInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchFake.mockClear();
});

const TOKEN_PATH = 'POST /app/installations/880011/access_tokens';

describe('resolveOrgAuth with a named target', () => {
  it('answers the target org, its installation and the minted token', async () => {
    await expect(resolveOrgAuth(TARGET)).resolves.toEqual({
      org: 'acme-connected',
      installationId: '880011',
      token: 'ghs_t',
    });
  });

  it('a token endpoint that answered carries its status', async () => {
    route(TOKEN_PATH, { status: 404, body: { message: 'Not Found' } });
    const err = await resolveOrgAuth(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgTargetAuthError);
    expect(err).toMatchObject({
      code: 'ORG_TARGET_AUTH_FAILED',
      org: 'acme-connected',
      installationId: '880011',
      role: 'provisioning',
      status: 404,
    });
    expect((err as Error).message).toContain('(HTTP 404)');
  });

  it('a token endpoint that never answered carries a null status', async () => {
    route(TOKEN_PATH, { throws: new Error('ECONNRESET') });
    const err = await resolveOrgAuth(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgTargetAuthError);
    expect((err as OrgTargetAuthError).status).toBeNull();
    expect((err as Error).message).not.toContain('HTTP');
  });

  it('an App not configured on this deployment is a null-status auth error', async () => {
    vi.stubEnv('GITHUB_STUDIO_APP_ID', '');
    const err = await resolveOrgAuth(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgTargetAuthError);
    expect((err as OrgTargetAuthError).status).toBeNull();
    expect((err as Error).message).toContain('not configured');
  });

  it('an error that is neither App error is rethrown untouched', async () => {
    const boom = new TypeError('a response whose ok getter throws');
    route(TOKEN_PATH, {
      response: {
        get ok(): boolean {
          throw boom;
        },
      },
    });
    await expect(resolveOrgAuth(TARGET)).rejects.toBe(boom);
  });
});

describe('getOrgInstallation', () => {
  const PATH = 'GET /orgs/acme-connected/installation';

  it('normalises an installation: string id, filtered permissions and events, selection', async () => {
    route(PATH, {
      status: 200,
      body: {
        id: 'abc',
        permissions: { actions: 'read', bogus: 7 },
        events: ['workflow_job', 3],
        repository_selection: 'all',
        suspended_at: '2026-10-01T00:00:00Z',
      },
    });
    await expect(getOrgInstallation('acme-connected', 'provisioning')).resolves.toEqual({
      id: 'abc',
      permissions: { actions: 'read' },
      events: ['workflow_job'],
      repositorySelection: 'all',
      suspendedAt: '2026-10-01T00:00:00Z',
    });
  });

  it('defaults a sparse installation to selected, no permissions, no events, not suspended', async () => {
    route(PATH, { status: 200, body: { id: 7, permissions: [], events: 'nope' } });
    await expect(getOrgInstallation('acme-connected', 'provisioning')).resolves.toEqual({
      id: '7',
      permissions: {},
      events: [],
      repositorySelection: 'selected',
      suspendedAt: null,
    });
  });

  it('a 404 is "not installed"', async () => {
    route(PATH, { status: 404, body: { message: 'Not Found' } });
    await expect(getOrgInstallation('acme-connected', 'provisioning')).resolves.toBeNull();
  });

  it('a refusal carries the status and a clipped message', async () => {
    route(PATH, { status: 403, body: { message: 'x'.repeat(300) } });
    const err = await getOrgInstallation('acme-connected', 'provisioning').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgInstallationReadError);
    expect((err as OrgInstallationReadError).status).toBe(403);
    expect((err as Error).message).toContain('x'.repeat(200) + ').');
    expect((err as Error).message).not.toContain('x'.repeat(201));
  });

  it('a refusal with a non-string message, or a non-JSON body, carries no detail', async () => {
    route(PATH, { status: 500, body: { message: 42 } }, { status: 502, raw: '<html>' });
    const first = await getOrgInstallation('acme-connected', 'provisioning').catch(
      (e: unknown) => e,
    );
    expect((first as Error).message).toBe('GitHub refused the read (HTTP 500).');
    const second = await getOrgInstallation('acme-connected', 'provisioning').catch(
      (e: unknown) => e,
    );
    expect((second as Error).message).toBe('GitHub refused the read (HTTP 502).');
  });

  it('a body with no usable id is refused', async () => {
    route(PATH, { status: 200, body: { id: null } }, { status: 200, body: [1, 2] });
    for (let i = 0; i < 2; i += 1) {
      const err = await getOrgInstallation('acme-connected', 'provisioning').catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OrgInstallationReadError);
      expect((err as Error).message).toContain('no id');
    }
  });

  it('a transport failure is a null-status read error', async () => {
    route(PATH, { throws: new Error('ETIMEDOUT') }, { throws: 'not an error' });
    const first = await getOrgInstallation('acme-connected', 'provisioning').catch(
      (e: unknown) => e,
    );
    expect(first).toMatchObject({ status: null });
    expect((first as Error).message).toContain('ETIMEDOUT');
    const second = await getOrgInstallation('acme-connected', 'provisioning').catch(
      (e: unknown) => e,
    );
    expect((second as Error).message).toContain('(unknown)');
  });

  it('an App that cannot sign a JWT is a null-status read error, and nothing is fetched', async () => {
    vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', '');
    const err = await getOrgInstallation('acme-connected', 'provisioning').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgInstallationReadError);
    expect((err as Error).message).toContain('the provisioning App is not configured');
    expect(calls).toEqual([]);
  });
});

describe('listInstallationRepositoryIds', () => {
  const FIRST = 'GET /installation/repositories?per_page=100';

  it('follows Link to the end, skips non-numeric ids, and stops on a Link with no next', async () => {
    route(FIRST, {
      status: 200,
      body: { repositories: [{ id: 1 }, { id: 'two' }, null] },
      headers: {
        link: '<https://api.github.com/installation/repositories?page=9>; rel="last", <https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
      },
    });
    route('GET /installation/repositories?per_page=100&page=2', {
      status: 200,
      body: { repositories: [{ id: 3 }] },
      headers: { link: '<https://api.github.com/installation/repositories?page=1>; rel="prev"' },
    });
    await expect(listInstallationRepositoryIds(TARGET)).resolves.toEqual([1, 3]);
  });

  it('a page that is not a repository list is refused', async () => {
    route(FIRST, { status: 200, body: { total_count: 0 } });
    const err = await listInstallationRepositoryIds(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgInstallationReadError);
    expect((err as Error).message).toContain('no repositories');
  });

  it('a refused page throws with its status', async () => {
    route(FIRST, { status: 401, body: { message: 'Bad credentials' } });
    await expect(listInstallationRepositoryIds(TARGET)).rejects.toMatchObject({ status: 401 });
  });

  it('a Link that never ends is an error after the page cap, not a hang', async () => {
    route(FIRST, {
      status: 200,
      body: { repositories: [{ id: 1 }] },
      headers: {
        link: '<https://api.github.com/installation/repositories?per_page=100>; rel="next"',
      },
    });
    const err = await listInstallationRepositoryIds(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgInstallationReadError);
    expect((err as Error).message).toContain('did not end');
    expect(calls.filter((c) => c === FIRST)).toHaveLength(100);
  });
});

describe('latestWorkflowCommit', () => {
  const PATH = 'GET /repos/acme-connected/acme-core/commits?path=.github&per_page=1';

  it('answers the newest commit', async () => {
    route(PATH, {
      status: 200,
      body: [{ sha: 'abc', commit: { committer: { date: '2026-10-01T00:00:00Z' } } }],
    });
    await expect(latestWorkflowCommit(TARGET, 'acme-connected', 'acme-core')).resolves.toEqual({
      sha: 'abc',
      committedAt: '2026-10-01T00:00:00Z',
    });
  });

  it('an empty list is "no workflow commit"', async () => {
    route(PATH, { status: 200, body: [] });
    await expect(latestWorkflowCommit(TARGET, 'acme-connected', 'acme-core')).resolves.toBeNull();
  });

  it('refuses a refusal, a non-list and a commit with no sha or date', async () => {
    route(
      PATH,
      { status: 409, body: { message: 'Git Repository is empty.' } },
      { status: 200, body: { sha: 'abc' } },
      { status: 200, body: [{ sha: 'abc', commit: {} }] },
    );
    await expect(latestWorkflowCommit(TARGET, 'acme-connected', 'acme-core')).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    await expect(latestWorkflowCommit(TARGET, 'acme-connected', 'acme-core')).rejects.toThrow(
      'not a list',
    );
    await expect(latestWorkflowCommit(TARGET, 'acme-connected', 'acme-core')).rejects.toThrow(
      'no sha or date',
    );
  });
});

describe('readWorkflowSources', () => {
  const REPO = '/repos/acme-connected/acme-core';
  const TREE = `GET ${REPO}/git/trees/abc?recursive=1`;
  const file = (path: string, text: string) => ({
    status: 200,
    body: { encoding: 'base64', content: Buffer.from(text).toString('base64') },
    path,
  });

  it('reads the workflow files and composite actions, and nothing else', async () => {
    route(TREE, {
      status: 200,
      body: {
        truncated: false,
        tree: [
          { type: 'blob', path: '.github/workflows/ci.yml' },
          { type: 'blob', path: '.github/workflows/notes.md' },
          { type: 'blob', path: '.github/workflows/sub/x.yml' },
          { type: 'blob', path: '.github/actions/pnpm/action.yml' },
          { type: 'tree', path: '.github/workflows' },
          { type: 'blob', path: 'src/index.ts' },
        ],
      },
    });
    route(`GET ${REPO}/contents/.github/workflows/ci.yml?ref=abc`, file('', 'jobs: {}'));
    route(`GET ${REPO}/contents/.github/actions/pnpm/action.yml?ref=abc`, file('', 'runs: {}'));
    await expect(
      readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc'),
    ).resolves.toEqual([
      { path: '.github/workflows/ci.yml', text: 'jobs: {}' },
      { path: '.github/actions/pnpm/action.yml', text: 'runs: {}' },
    ]);
  });

  it('refuses a refused tree, a truncated tree and a tree that is not a list', async () => {
    route(
      TREE,
      { status: 404, body: { message: 'Not Found' } },
      { status: 200, body: { truncated: true, tree: [] } },
      { status: 200, body: { tree: 'nope' } },
    );
    await expect(
      readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc')).rejects.toThrow(
      'truncated',
    );
    await expect(readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc')).rejects.toThrow(
      'truncated',
    );
  });

  it('refuses a tree with more files than the cap', async () => {
    route(TREE, {
      status: 200,
      body: {
        truncated: false,
        tree: Array.from({ length: 121 }, (_, i) => ({
          type: 'blob',
          path: `.github/workflows/w${i}.yml`,
        })),
      },
    });
    await expect(readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc')).rejects.toThrow(
      'too many',
    );
  });

  it('refuses a file read that is refused or is not base64 text', async () => {
    const one = {
      status: 200,
      body: { truncated: false, tree: [{ type: 'blob', path: '.github/workflows/ci.yml' }] },
    };
    const FILE = `GET ${REPO}/contents/.github/workflows/ci.yml?ref=abc`;
    route(TREE, one);
    route(
      FILE,
      { status: 403, body: { message: 'forbidden' } },
      { status: 200, body: { encoding: 'none' } },
    );
    await expect(
      readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(readWorkflowSources(TARGET, 'acme-connected', 'acme-core', 'abc')).rejects.toThrow(
      'base64',
    );
  });
});

describe('repoVisibilityClient.isPrivate', () => {
  const PATH = 'GET /repos/acme-connected/acme-core';

  it('answers GitHub’s boolean either way', async () => {
    route(
      PATH,
      { status: 200, body: { private: true } },
      { status: 200, body: { private: false } },
    );
    await expect(
      repoVisibilityClient.isPrivate('acme-connected', 'acme-core', TARGET),
    ).resolves.toBe(true);
    await expect(
      repoVisibilityClient.isPrivate('acme-connected', 'acme-core', TARGET),
    ).resolves.toBe(false);
  });

  it('an unknown visibility is never treated as private', async () => {
    route(PATH, { status: 200, body: { private: 'yes' } }, { status: 200, raw: 'null' });
    for (let i = 0; i < 2; i += 1) {
      const err = await repoVisibilityClient
        .isPrivate('acme-connected', 'acme-core', TARGET)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RepoVisibilityApiError);
      expect((err as Error).message).toContain('returned no visibility');
    }
  });

  it('a refusal carries its status, with or without a message', async () => {
    route(PATH, { status: 404, body: { message: 'Not Found' } }, { status: 500, raw: 'not json' });
    const first = await repoVisibilityClient
      .isPrivate('acme-connected', 'acme-core', TARGET)
      .catch((e: unknown) => e);
    expect(first).toMatchObject({ code: 'REPO_VISIBILITY_API_FAILED', status: 404 });
    expect((first as Error).message).toBe(
      'GitHub refused a repository read (HTTP 404: Not Found).',
    );
    const second = await repoVisibilityClient
      .isPrivate('acme-connected', 'acme-core', TARGET)
      .catch((e: unknown) => e);
    expect((second as Error).message).toBe('GitHub refused a repository read (HTTP 500).');
  });

  it('a transport failure is a null-status error', async () => {
    route(PATH, { throws: new Error('ENOTFOUND') }, { throws: 0 });
    const first = await repoVisibilityClient
      .isPrivate('acme-connected', 'acme-core', TARGET)
      .catch((e: unknown) => e);
    expect(first).toMatchObject({ status: null });
    expect((first as Error).message).toContain('could not be reached');
    expect((first as Error).message).toContain('ENOTFOUND');
    const second = await repoVisibilityClient
      .isPrivate('acme-connected', 'acme-core', TARGET)
      .catch((e: unknown) => e);
    expect((second as Error).message).toContain('(unknown)');
  });
});

describe('actionsVariableClient edges', () => {
  const ONE = 'GET /orgs/acme-connected/actions/variables/MOTIR_RUNNER';
  const PATCH = 'PATCH /orgs/acme-connected/actions/variables/MOTIR_RUNNER';
  const POST = 'POST /orgs/acme-connected/actions/variables';
  const DELETE = 'DELETE /orgs/acme-connected/actions/variables/MOTIR_RUNNER';

  it('a variable with no visibility reads as an empty visibility, and is patched back', async () => {
    route(ONE, { status: 200, body: { name: 'MOTIR_RUNNER', value: 'motir-runner' } });
    route(PATCH, { status: 204 });
    await expect(
      actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', TARGET),
    ).resolves.toBe('updated');
    expect(calls).toContain(PATCH);
  });

  it('a read of an unexpected shape, or a refused read, throws', async () => {
    route(
      ONE,
      { status: 200, body: { name: 'MOTIR_RUNNER' } },
      { status: 403, body: { message: 'Resource not accessible by integration' } },
      { status: 500, raw: '' },
    );
    await expect(actionsVariableClient.getOrgVariable('MOTIR_RUNNER', TARGET)).rejects.toThrow(
      'unexpected shape',
    );
    const refused = await actionsVariableClient
      .getOrgVariable('MOTIR_RUNNER', TARGET)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionsVariableApiError);
    expect((refused as Error).message).toBe(
      'GitHub refused an Actions-variable call (HTTP 403: Resource not accessible by integration).',
    );
    await expect(actionsVariableClient.getOrgVariable('MOTIR_RUNNER', TARGET)).rejects.toThrow(
      'GitHub refused an Actions-variable call (HTTP 500).',
    );
  });

  it('a refused create, and a refused patch, throw with their status', async () => {
    route(POST, { status: 422, body: { message: 'Invalid name' } });
    await expect(
      actionsVariableClient.create('MOTIR_RUNNER', 'motir-runner', TARGET),
    ).rejects.toMatchObject({ status: 422 });
    route(PATCH, { status: 404, body: { message: 'Not Found' } });
    await expect(
      actionsVariableClient.patch('MOTIR_RUNNER', 'motir-runner', TARGET),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a delete that 404s is "absent"; any other refusal throws', async () => {
    route(
      DELETE,
      { status: 404 },
      { status: 200, body: {} },
      { status: 500, body: { message: 'x' } },
    );
    await expect(actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', TARGET)).resolves.toBe(
      'absent',
    );
    await expect(actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', TARGET)).resolves.toBe(
      'deleted',
    );
    await expect(
      actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', TARGET),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('a transport failure is a null-status error', async () => {
    route(ONE, { throws: new Error('socket hang up') }, { throws: Symbol('odd') });
    const first = await actionsVariableClient
      .getOrgVariable('MOTIR_RUNNER', TARGET)
      .catch((e: unknown) => e);
    expect(first).toMatchObject({ status: null });
    expect((first as Error).message).toBe(
      'GitHub could not be reached while managing an Actions variable (socket hang up).',
    );
    const second = await actionsVariableClient
      .getOrgVariable('MOTIR_RUNNER', TARGET)
      .catch((e: unknown) => e);
    expect((second as Error).message).toContain('(unknown)');
  });
});

describe('toFleetOrgCiStoredStateDTO', () => {
  const ROW = {
    enabled: true,
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    lastReason: 'turned on for the pilot',
  };

  it('no row is OFF with nothing recorded', () => {
    expect(toFleetOrgCiStoredStateDTO(null, null)).toEqual({
      enabled: false,
      updatedBy: null,
      updatedAt: null,
      lastReason: null,
    });
  });

  it('a row whose updater is gone keeps the row and names nobody', () => {
    expect(
      toFleetOrgCiStoredStateDTO(ROW as Parameters<typeof toFleetOrgCiStoredStateDTO>[0], null),
    ).toEqual({
      enabled: true,
      updatedBy: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastReason: 'turned on for the pilot',
    });
  });

  it('a row with its updater names them', () => {
    expect(
      toFleetOrgCiStoredStateDTO(ROW as Parameters<typeof toFleetOrgCiStoredStateDTO>[0], {
        id: 'u1',
        email: 'ops@example.test',
      }).updatedBy,
    ).toEqual({ userId: 'u1', email: 'ops@example.test' });
  });
});
