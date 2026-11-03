import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { EXEMPT_TOOLS } from '@/lib/mcp/payloads/exemptions';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import {
  CODE_HISTORY_COMMIT_RENDER_CAP,
  CODE_HISTORY_RANGE_RENDER_CAP,
  GET_CODE_HISTORY_TOOL_NAME,
  renderGetCodeHistory,
} from '@/lib/mcp/tools/getCodeHistory';
import { CODE_HISTORY_MAX_COMMITS, CODE_HISTORY_MAX_RANGES } from '@/lib/git';
import { RepoNotInProjectError } from '@/lib/git/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { repoHistoryService } from '@/lib/services/repoHistoryService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures';
import { linkAllWorkspaceReposIntoProject } from '../fixtures/codeContextFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `get_code_history` (MOTIR-10237) over real Postgres — the LOG or BLAME of a path
// in a repository of the PROJECT's set, gated on `ai:plan`. The git host is reached
// through the REAL GitHub provider with the global `fetch` stubbed (the
// `list-changed-files.test.ts` seam); everything else is the real Postgres path.

const TOKEN = 'ghs_get_code_history_secret';
const SHA_A = '0328041d1152db8ae77652d1618a02e57f745f17';
const SHA_B = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Reply = (url: string) => Response | Promise<Response>;
let reply: Reply = () => new Response('', { status: 500 });
const hostCalls: string[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ghCommit = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/acme/alpha/commit/${sha}`,
  commit: { author: { name: 'Ada', date: '2026-10-01T10:00:00Z' }, message },
  files: [{ filename: 'lib/a.ts', patch: '@@ +const secretHunk = 1;' }],
});

const blameBody = (n: number) => ({
  data: {
    repository: {
      object: {
        __typename: 'Commit',
        blame: {
          ranges: Array.from({ length: n }, (_, i) => ({
            startingLine: i * 2 + 1,
            endingLine: i * 2 + 2,
            commit: {
              oid: i % 2 ? SHA_B : SHA_A,
              authoredDate: '2026-09-01T00:00:00Z',
              messageHeadline: 'feat: add the thing',
              author: { name: 'Bo' },
            },
          })),
        },
      },
    },
  },
});

function stubHost(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/access_tokens')) {
      return json({ token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    hostCalls.push(url);
    return reply(url);
  });
}

async function connectClient(
  ctx: ServiceContext,
  grant?: readonly PermissionKey[],
): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'get-code-history-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(
  ctx: ServiceContext,
  args: Record<string, unknown>,
  grant?: readonly PermissionKey[],
): Promise<CallToolResult> {
  const client = await connectClient(ctx, grant);
  try {
    return (await client.callTool({
      name: GET_CODE_HISTORY_TOOL_NAME,
      arguments: args,
    })) as CallToolResult;
  } finally {
    await client.close();
  }
}

const summaryOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
function outcomeOf(res: CallToolResult): Record<string, unknown> {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as Record<string, unknown>;
}

async function seedRepoSet(f: WorkItemFixture): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: f.workspaceId,
    installation: {
      installationId: `inst-${f.workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: ['alpha', 'beta'].map((name) => ({
      providerRepoId: `repo-${name}-${f.workspaceId}`,
      owner: 'acme',
      name,
      defaultBranch: name === 'alpha' ? 'main' : 'trunk',
      archived: false,
    })),
  });
  await linkAllWorkspaceReposIntoProject({ ...f.ctx, projectId: f.projectId });
}

let fx: WorkItemFixture;
const args = (extra: Record<string, unknown> = {}) => ({
  projectKey: fx.projectIdentifier,
  repo: 'alpha',
  path: 'lib/a.ts',
  kind: 'log',
  ...extra,
});

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  hostCalls.length = 0;
  reply = () => json([ghCommit(SHA_A, 'fix: second\n\nbody'), ghCommit(SHA_B, 'feat: first')]);
  stubHost();
  fx = await makeWorkItemFixture();
  await seedRepoSet(fx);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('get_code_history — registered and permissioned', () => {
  it('tools/list names it, titled, read-only and OPEN-world; every declaration home carries it', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === GET_CODE_HISTORY_TOOL_NAME);
    expect(tool, 'get_code_history is not registered').toBeTruthy();
    expect(tool!.title).toBe('Get code history');
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.openWorldHint).toBe(true);
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(
      ['kind', 'path', 'projectKey', 'ref', 'repo'].sort(),
    );
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(['projectKey', 'repo', 'path', 'kind']),
    );

    expect(MCP_TOOL_NAMES).toContain(GET_CODE_HISTORY_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_CODE_HISTORY_TOOL_NAME]).toBe('ai:plan');
    expect(TOOL_SCOPES[GET_CODE_HISTORY_TOOL_NAME]).toBe('read');
    expect(TOOL_ANNOTATIONS[GET_CODE_HISTORY_TOOL_NAME]).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(EXEMPT_TOOLS).toHaveProperty(GET_CODE_HISTORY_TOOL_NAME);
  });

  it('the render caps are the provider caps', () => {
    expect(CODE_HISTORY_COMMIT_RENDER_CAP).toBe(CODE_HISTORY_MAX_COMMITS);
    expect(CODE_HISTORY_RANGE_RENDER_CAP).toBe(CODE_HISTORY_MAX_RANGES);
  });

  it('a token whose grant lacks ai:plan is refused at the door, before any host call', async () => {
    const denied = await callTool(
      fx.ctx,
      args(),
      GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
    );
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(JSON.stringify(denied.content)).toContain('ai:plan');
    expect(hostCalls).toEqual([]);

    const allowed = await callTool(fx.ctx, args(), ['project:browse', 'ai:plan']);
    expect(outcomeOf(allowed)['outcome']).toBe('ok');
  });

  it('a key from another workspace reads as the plain not-found', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await seedRepoSet(other);
    const res = await callTool(fx.ctx, { ...args(), projectKey: other.projectIdentifier });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('PROJECT_NOT_FOUND');
    expect(hostCalls).toEqual([]);
  });
});

describe('get_code_history — log and blame', () => {
  it('a log lists the commits newest first at the stored default branch, metadata only', async () => {
    const res = await callTool(fx.ctx, args());
    expect(outcomeOf(res)).toEqual({
      outcome: 'ok',
      kind: 'log',
      repoRef: 'acme/alpha',
      path: 'lib/a.ts',
      ref: 'main',
      commits: [
        { sha: SHA_A, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'fix: second' },
        { sha: SHA_B, author: 'Ada', date: '2026-10-01T10:00:00Z', subject: 'feat: first' },
      ],
      truncated: false,
    });
    const summary = summaryOf(res);
    expect(summary).toContain('changed by 2 commits, newest first');
    expect(summary).toContain(`${SHA_A.slice(0, 12)} 2026-10-01T10:00:00Z Ada — fix: second`);
    expect(summary).not.toContain('TRUNCATED');
    expect(hostCalls[0]).toContain('/repos/acme/alpha/commits?sha=main&path=lib%2Fa.ts');
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('secretHunk');
    expect(serialized).not.toContain('github.com');
  });

  it('a named ref and the other repo’s default branch are honoured', async () => {
    const res = await callTool(fx.ctx, args({ repo: 'acme/BETA', ref: 'release' }));
    expect(outcomeOf(res)).toMatchObject({ repoRef: 'acme/beta', ref: 'release' });
    const dflt = await callTool(fx.ctx, args({ repo: 'beta' }));
    expect(outcomeOf(dflt)).toMatchObject({ ref: 'trunk' });
  });

  it('a cut log says so in a sentence, with "at least"', async () => {
    reply = () =>
      json([ghCommit(SHA_A, 'x')], 200, { link: '<https://api.github.com/x?page=2>; rel="next"' });
    const res = await callTool(fx.ctx, args());
    expect(outcomeOf(res)).toMatchObject({ truncated: true });
    expect(summaryOf(res)).toContain('changed by at least 1 commit');
    expect(summaryOf(res)).toContain('[TRUNCATED — the log stopped after 1 commits');
  });

  it('a blame lists line ranges, and a cut blame says so', async () => {
    reply = () => json(blameBody(2));
    const res = await callTool(fx.ctx, args({ kind: 'blame' }));
    expect(outcomeOf(res)).toMatchObject({
      outcome: 'ok',
      kind: 'blame',
      blame: [
        { startLine: 1, endLine: 2, sha: SHA_A, author: 'Bo' },
        { startLine: 3, endLine: 4, sha: SHA_B },
      ],
      truncated: false,
    });
    expect(summaryOf(res)).toContain(`- lines 1-2: ${SHA_A.slice(0, 12)}`);
    expect(summaryOf(res)).toContain('— feat: add the thing');

    reply = () => json(blameBody(CODE_HISTORY_MAX_RANGES + 1));
    const cut = await callTool(fx.ctx, args({ kind: 'blame' }));
    const out = outcomeOf(cut);
    expect(out['truncated']).toBe(true);
    expect((out['blame'] as unknown[]).length).toBe(CODE_HISTORY_MAX_RANGES);
    expect(summaryOf(cut)).toContain(
      `[TRUNCATED — the blame stopped after ${CODE_HISTORY_MAX_RANGES} line ranges`,
    );
  });

  it('an empty file’s blame is a statement about the file', async () => {
    reply = () => json(blameBody(0));
    const res = await callTool(fx.ctx, args({ kind: 'blame' }));
    expect(outcomeOf(res)).toMatchObject({ outcome: 'ok', blame: [] });
    expect(summaryOf(res)).toContain('has NO lines to blame');
  });
});

describe('get_code_history — every absence is named and distinct', () => {
  it('no_such_ref · path_not_found · invalid_path · revoked · too_large · host_error · not_connected · repo_not_connected', async () => {
    const seen = new Map<string, string>();
    const expectOutcome = async (outcome: string, a: Record<string, unknown>) => {
      const res = await callTool(fx.ctx, a);
      expect(outcomeOf(res)['outcome']).toBe(outcome);
      seen.set(outcome, summaryOf(res));
      return res;
    };

    reply = () => json({ message: 'No commit found' }, 422);
    await expectOutcome('no_such_ref', args({ ref: 'nope' }));
    reply = () => json([]);
    await expectOutcome('path_not_found', args({ path: 'lib/gone.ts' }));
    hostCalls.length = 0;
    const invalid = await expectOutcome('invalid_path', args({ path: '../etc/passwd' }));
    expect(outcomeOf(invalid)).toHaveProperty('reason');
    expect(hostCalls).toEqual([]);
    reply = () => json({ message: 'Bad credentials' }, 401);
    await expectOutcome('revoked', args());
    reply = () =>
      json({
        data: { repository: { object: { __typename: 'Commit', blame: null } } },
        errors: [{ message: 'timeout' }],
      });
    await expectOutcome('too_large', args({ kind: 'blame' }));
    reply = () => new Response('bad gateway', { status: 502 });
    const hostErr = await expectOutcome('host_error', args());
    expect(summaryOf(hostErr)).toContain('NOT evidence that nobody changed the file');
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    _resetInstallationTokenCache();
    await expectOutcome('not_connected', args());

    vi.spyOn(repoHistoryService, 'readHistory').mockRejectedValueOnce(
      new RepoNotInProjectError('acme/alpha'),
    );
    const notInOrg = await expectOutcome('repo_not_connected', args({ ref: 'release' }));
    expect(outcomeOf(notInOrg)).toMatchObject({ repoRef: 'acme/alpha', ref: 'release' });

    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  it('a repo outside the set is answered with the set, before any host call', async () => {
    const res = await callTool(fx.ctx, args({ repo: 'acme/gamma' }));
    expect(outcomeOf(res)).toEqual({
      outcome: 'repo_not_in_project',
      repo: 'acme/gamma',
      repoSet: ['acme/alpha', 'acme/beta'],
    });
    expect(summaryOf(res)).toContain('"acme/alpha", "acme/beta"');
    expect(hostCalls).toEqual([]);
  });

  it('a service failure that is not a named outcome is an error result', async () => {
    vi.spyOn(repoHistoryService, 'readHistory').mockRejectedValueOnce(new Error('boom'));
    const res = await callTool(fx.ctx, args());
    expect(res.isError).toBe(true);
  });

  it('an empty set and an unknown outcome still render a sentence', () => {
    expect(
      renderGetCodeHistory({ outcome: 'repo_not_in_project', repo: 'x', repoSet: [] }).summary,
    ).toContain('none — no repository is connected to it');
    const odd = renderGetCodeHistory({
      outcome: 'weird',
      repoRef: 'acme/alpha',
      kind: 'log',
      path: 'p',
      ref: 'main',
    } as never);
    expect(odd.summary).toContain('does not recognise ("weird")');
  });
});

describe('get_code_history — rendering the sparse fields', () => {
  const base = { repoRef: 'acme/alpha', path: 'lib/a.ts', ref: 'main' } as const;

  it('an empty ok log, cut or not, says nothing can be concluded', () => {
    const plain = renderGetCodeHistory({
      ...base,
      outcome: 'ok',
      kind: 'log',
      commits: [],
      truncated: false,
    });
    expect(plain.summary).toContain('EMPTY log');
    expect(plain.summary).not.toContain('was cut');
    const cut = renderGetCodeHistory({
      ...base,
      outcome: 'ok',
      kind: 'log',
      commits: [],
      truncated: true,
    });
    expect(cut.summary).toContain('said the answer was cut');
  });

  it('a commit with no date, author or subject still renders one line', () => {
    const one = renderGetCodeHistory({
      ...base,
      outcome: 'ok',
      kind: 'log',
      commits: [{ sha: SHA_A, author: null, date: null, subject: '' }],
      truncated: false,
    });
    expect(one.summary).toContain('changed by 1 commit, newest first');
    expect(one.summary).toContain('unknown date unknown author — (no subject)');
  });

  it('a blame range with no date, author or subject; one range is singular', () => {
    const one = renderGetCodeHistory({
      ...base,
      outcome: 'ok',
      kind: 'blame',
      blame: [{ startLine: 1, endLine: 1, sha: SHA_A, author: null, date: null, subject: null }],
      truncated: false,
    });
    expect(one.summary).toContain('1 line range:');
    expect(one.summary).toContain('unknown date unknown author');
    expect(one.summary).not.toContain(' — ');
  });

  it('a host_error with no detail says so', () => {
    const r = renderGetCodeHistory({ ...base, outcome: 'host_error', kind: 'blame', detail: '' });
    expect(r.summary).toContain('(no detail)');
    expect(r.summary).toContain('the blame of lib/a.ts');
  });

  it('a list longer than the render cap is cut in the render too', () => {
    const commits = Array.from({ length: CODE_HISTORY_COMMIT_RENDER_CAP + 1 }, () => ({
      sha: SHA_A,
      author: 'a',
      date: 'd',
      subject: 's',
    }));
    const r = renderGetCodeHistory({
      ...base,
      outcome: 'ok',
      kind: 'log',
      commits,
      truncated: false,
    });
    expect(r.structured['truncated']).toBe(true);
    expect(r.summary).toContain('[TRUNCATED');
  });
});
