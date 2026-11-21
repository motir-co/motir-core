import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MotirClient } from '../src/client.js';
import { startTestServer, type TestServer } from './helpers/testServer.js';

// The three client calls a HOSTED run adds (MOTIR-6558 · MOTIR-6559), against a
// real HTTP server so the operation each one names, where its argument goes and
// the response validator it passes through are asserted rather than assumed.
//
// ⚠️ `me()` is the hosted identity read: a run credential is REFUSED on
// `listWorkspaces` (MOTIR-6557), so the call must reach `getMe` and nothing
// else — `whoami()` would fail the run on its first line.

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ token: 'run-token' });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  server.v1Calls.length = 0;
  server.resetV1();
});

function client(): MotirClient {
  return new MotirClient({ serverUrl: server.url, token: 'run-token' });
}

function card(over: {
  key: string | null;
  position: number;
  disposition: 'queued' | 'running' | 'implemented' | 'skipped';
}) {
  return {
    id: `card-${over.position}`,
    key: over.key,
    workItemId: over.key === null ? null : `wi-${over.position}`,
    position: over.position,
    disposition: over.disposition,
    skipReason: null,
    sessionBranch: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    model: null,
  };
}

describe('client.me — the hosted identity read', () => {
  it('reads getMe ALONE and returns the user', async () => {
    const me = await client().me();

    expect(me).toEqual({ id: 'user-1', name: 'Zhu Yue', email: 'yue@motir.test' });
    expect(server.v1Calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/me']);
  });
});

describe('client.getDispatchRun — the run a hosted CLI adopts', () => {
  it('reads the run by id and returns its view with the legs in POSITION order', async () => {
    server.scriptV1({
      'GET /api/v1/dispatch-runs/{id}': {
        body: {
          id: 'run-9',
          projectId: 'proj-1',
          command: 'run_scope',
          origin: 'hosted',
          scopeWorkItemId: 'wi-parent',
          scopeLabel: 'PROD-1',
          status: 'running',
          stopReason: null,
          lastHeartbeatAt: null,
          agent: 'opencode',
          model: 'claude-opus-5-5',
          startedAt: '2026-09-27T00:00:00.000Z',
          endedAt: null,
          createdById: 'user-1',
          agentInstance: null,
          // Deliberately OUT of position order: the adapter owns the ordering,
          // because the run's order is what a scope drain follows.
          cards: [
            card({ key: 'PROD-3', position: 2, disposition: 'queued' }),
            card({ key: 'PROD-2', position: 1, disposition: 'running' }),
            card({ key: null, position: 3, disposition: 'skipped' }),
          ],
          seq: 4,
        },
      },
    });

    const run = await client().getDispatchRun('run-9');

    expect(server.v1Calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/dispatch-runs/run-9',
    ]);
    expect(run).toEqual({
      runId: 'run-9',
      status: 'running',
      command: 'run_scope',
      origin: 'hosted',
      model: 'claude-opus-5-5',
      endedAt: null,
      cards: [
        { key: 'PROD-2', position: 1, disposition: 'running' },
        { key: 'PROD-3', position: 2, disposition: 'queued' },
        { key: null, position: 3, disposition: 'skipped' },
      ],
      // Not a continue run, so it resumes nothing (MOTIR-6795).
      continues: null,
      // Not a hosted fix run, so it carries no repair decision (MOTIR-6929).
      repair: null,
      // Not a review run, so it names no review target (MOTIR-11953).
      review: null,
    });
  });
});

describe('client.issueRunGitCredentials — trading the run credential for git tokens', () => {
  it('POSTs to the run’s git-credential route and returns one credential per repository', async () => {
    server.scriptV1({
      'POST /api/v1/dispatch-runs/{id}/git-credential': {
        body: {
          credentials: [
            {
              repository: 'acme/web',
              token: 'ghs_web',
              expiresAt: '2026-09-27T01:00:00.000Z',
              authorName: 'motir-integration[bot]',
              authorEmail: '42+motir-integration[bot]@users.noreply.github.com',
            },
            {
              repository: 'acme/api',
              token: 'ghs_web',
              expiresAt: '2026-09-27T01:00:00.000Z',
              authorName: 'motir-integration[bot]',
              authorEmail: '42+motir-integration[bot]@users.noreply.github.com',
            },
          ],
          dispatchedBy: 'Zhu Yue',
        },
      },
    });

    const creds = await client().issueRunGitCredentials('run-9');

    expect(server.v1Calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/dispatch-runs/run-9/git-credential',
    ]);
    expect(creds.dispatchedBy).toBe('Zhu Yue');
    expect(creds.credentials.map((c) => c.repository)).toEqual(['acme/web', 'acme/api']);
    expect(creds.credentials[0]).toEqual({
      repository: 'acme/web',
      token: 'ghs_web',
      expiresAt: '2026-09-27T01:00:00.000Z',
      authorName: 'motir-integration[bot]',
      authorEmail: '42+motir-integration[bot]@users.noreply.github.com',
    });
  });

  it('carries a null dispatcher through unchanged', async () => {
    server.scriptV1({
      'POST /api/v1/dispatch-runs/{id}/git-credential': {
        body: { credentials: [], dispatchedBy: null },
      },
    });

    await expect(client().issueRunGitCredentials('run-9')).resolves.toEqual({
      credentials: [],
      dispatchedBy: null,
    });
  });
});
