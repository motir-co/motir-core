import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { buildMcpServer } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { READ_FILE_CONTENT_CAP } from '@/lib/mcp/tools/readFile';
import { summarizeCodeGraphRead } from '@/lib/mcp/tools/codeGraphRead';
import { REPO_FILE_FETCH_MAX_BYTES } from '@/lib/git';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { repoFileReadService } from '@/lib/services/repoFileReadService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures';
import { linkAllWorkspaceReposIntoProject } from '../fixtures/codeContextFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CODE-READ DOOR (Story MOTIR-7858 · Subtask MOTIR-7865) — the three code-read
// tools (`read_file`, `code_explore`, `code_search`) as an MCP client sees them:
// `buildMcpServer` behind an in-memory `Client`, over real Postgres. Each tool
// work item ships its own test; this suite holds the three to ONE door, ONE gate
// and ONE zero-call refusal, and drives every named outcome through it.
//
// Exactly two seams, both on the global `fetch`:
//   - the GIT HOST, reached through the real GitHub provider (the installation
//     token mint is answered, every other host URL is recorded in `hostCalls`);
//   - MOTIR-AI's `POST /v1/code-graph/read`, under `AI_URL` (recorded in
//     `aiCalls`).
// Nothing below them is mocked, so a refusal is proven NON-vacuous by both
// recorders staying empty, not only by the refusal's text.

const AI_URL = 'http://motir-ai.door.test';
const SERVICE_TOKEN = 'svc-token-7865';
const HOST_TOKEN = 'ghs_code_read_door_secret';
const OWNER = 'moooon-B-V';
const SET = [`${OWNER}/motir-ai`, `${OWNER}/motir-core`];
const TOOLS = ['read_file', 'code_explore', 'code_search'] as const;
const PLANNING_GRANT: PermissionKey[] = ['project:browse', 'ai:plan'];

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface AiCall {
  url: string;
  body: Record<string, unknown> & { args: Record<string, unknown>; repoRefs: string[] };
}
const aiCalls: AiCall[] = [];
const hostCalls: string[] = [];
let aiReply: () => Response | Promise<Response>;
let hostReply: (url: string) => Response | Promise<Response>;
// A ref is resolved to its commit before the read (MOTIR-10122); the read is AT it.
const HEAD_SHA = 'beef'.padEnd(40, '1');
const headReply = () => new Response(HEAD_SHA, { status: 200 });
let resolveReply: (url: string) => Response | Promise<Response> = headReply;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin === AI_URL) {
      aiCalls.push({ url, body: JSON.parse(String(init?.body)) as AiCall['body'] });
      return aiReply();
    }
    if (url.includes('/access_tokens')) {
      return json({
        token: HOST_TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    hostCalls.push(url);
    return url.includes('/commits/') ? resolveReply(url) : hostReply(url);
  });
}

async function connect(ctx: ServiceContext, grant?: readonly PermissionKey[]): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'code-read-door-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  name: (typeof TOOLS)[number],
  args: Record<string, unknown>,
  opts: { ctx?: ServiceContext; grant?: readonly PermissionKey[] } = {},
): Promise<CallToolResult> {
  const client = await connect(opts.ctx ?? fx.ctx, opts.grant);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function structured(res: CallToolResult): Record<string, unknown> {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as Record<string, unknown>;
}
const textOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

async function seedRepoSet(f: WorkItemFixture): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: f.workspaceId,
    installation: {
      installationId: `inst-${f.workspaceId}`,
      accountLogin: OWNER,
      accountType: 'Organization',
    },
    repos: ['motir-core', 'motir-ai'].map((name) => ({
      providerRepoId: `repo-${name}-${f.workspaceId}`,
      owner: OWNER,
      name,
      defaultBranch: name === 'motir-core' ? 'main' : 'trunk',
      archived: false,
    })),
  });
  await linkAllWorkspaceReposIntoProject({ ...f.ctx, projectId: f.projectId });
}

/** Minimal valid arguments per tool, aimed at `projectKey`. */
function argsFor(tool: (typeof TOOLS)[number], projectKey: string): Record<string, unknown> {
  return tool === 'read_file'
    ? { projectKey, repo: 'motir-core', path: 'lib/x.ts' }
    : { projectKey, query: 'readFile' };
}

let fx: WorkItemFixture;
const readArgs = (extra: Record<string, unknown> = {}) => ({
  ...argsFor('read_file', fx.projectIdentifier),
  ...extra,
});
const graphArgs = (extra: Record<string, unknown> = {}) => ({
  ...argsFor('code_explore', fx.projectIdentifier),
  ...extra,
});

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  aiCalls.length = 0;
  hostCalls.length = 0;
  aiReply = () => json({ state: 'ok', text: 'unset' });
  hostReply = () => new Response('export const x = 1;\n', { status: 200 });
  resolveReply = headReply;
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', SERVICE_TOKEN);
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  stubFetch();
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

describe('the door — listing, the ai:plan gate, the tenant', () => {
  it('tools/list on a planning token names all three, read-only; read_file alone is open-world', async () => {
    const client = await connect(fx.ctx, PLANNING_GRANT);
    const { tools } = await client.listTools();
    await client.close();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of TOOLS) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get('read_file')!.annotations?.openWorldHint).toBe(true);
  });

  it.each(TOOLS)(
    '%s without ai:plan is refused at the door, with zero downstream calls',
    async (tool) => {
      const res = await call(tool, argsFor(tool, fx.projectIdentifier), {
        grant: GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(hostCalls).toEqual([]);
      expect(aiCalls).toEqual([]);
    },
  );

  it.each(TOOLS)(
    '%s with another workspace’s key is the plain not-found, with zero downstream calls',
    async (tool) => {
      const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
      await seedRepoSet(other);
      const res = await call(tool, argsFor(tool, other.projectIdentifier));
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('PROJECT_NOT_FOUND');
      expect(hostCalls).toEqual([]);
      expect(aiCalls).toEqual([]);
    },
  );
});

describe('read_file — every outcome through the door', () => {
  it('no ref reads at the repository row’s default branch; a ref reads at that ref', async () => {
    const atDefault = structured(await call('read_file', readArgs({ repo: 'motir-ai' })));
    expect(atDefault).toMatchObject({
      outcome: 'found',
      repoRef: `${OWNER}/motir-ai`,
      ref: 'trunk',
      commitSha: HEAD_SHA,
      bytes: 20,
    });
    expect(hostCalls).toEqual([
      `https://api.github.com/repos/${OWNER}/motir-ai/commits/trunk`,
      `https://api.github.com/repos/${OWNER}/motir-ai/contents/lib/x.ts?ref=${HEAD_SHA}`,
    ]);

    hostCalls.length = 0;
    const atRef = structured(await call('read_file', readArgs({ ref: 'feat/y' })));
    expect(atRef).toMatchObject({ outcome: 'found', ref: 'feat/y', commitSha: HEAD_SHA });
    expect(hostCalls).toEqual([
      `https://api.github.com/repos/${OWNER}/motir-core/commits/feat%2Fy`,
      `https://api.github.com/repos/${OWNER}/motir-core/contents/lib/x.ts?ref=${HEAD_SHA}`,
    ]);
  });

  it('a bare name, owner/name and a different case all reach the same repoRef', async () => {
    for (const repo of ['motir-core', `${OWNER}/motir-core`, 'MOOOON-B-V/MOTIR-CORE']) {
      expect(structured(await call('read_file', readArgs({ repo })))['repoRef']).toBe(
        `${OWNER}/motir-core`,
      );
    }
    // One resolve and one read per call, the same two URLs each time.
    expect(new Set(hostCalls).size).toBe(2);
    expect(hostCalls).toHaveLength(6);
  });

  it('a whitespace-only repo matches nothing — repo_not_in_project, zero host calls', async () => {
    expect(structured(await call('read_file', readArgs({ repo: '  ' })))).toMatchObject({
      outcome: 'repo_not_in_project',
      repoSet: SET,
    });
    expect(hostCalls).toEqual([]);
  });

  it('startLine / endLine head the result "lines a-b of N", clamped to the file', async () => {
    hostReply = () => new Response('l1\nl2\nl3\nl4', { status: 200 });
    const res = await call('read_file', readArgs({ startLine: 3, endLine: 40 }));
    expect(structured(res)).toMatchObject({ text: 'l3\nl4', lines: { from: 3, to: 4, total: 4 } });
    expect(textOf(res)).toContain('lines 3-4 of 4:');
  });

  it('text over 24,000 characters is cut there and ends in the truncation sentence', async () => {
    const body = 'b'.repeat(READ_FILE_CONTENT_CAP + 1_000);
    hostReply = () => new Response(body, { status: 200 });
    const out = structured(await call('read_file', readArgs()));
    const text = out['text'] as string;
    expect(out['truncated']).toBe(true);
    expect(text.indexOf('\n\n… [TRUNCATED')).toBe(READ_FILE_CONTENT_CAP);
    expect(text).toMatch(/to reach the rest\.\]$/);
  });

  it('every outcome is a non-error result, and the eleven summaries are pairwise distinct', async () => {
    const seen = new Map<string, string>();
    const record = async (
      expected: string,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const res = await call('read_file', readArgs(extra));
      const out = structured(res);
      expect(out['outcome']).toBe(expected);
      expect(JSON.stringify(res)).not.toContain(HOST_TOKEN);
      expect(JSON.stringify(res)).not.toContain('download_url');
      seen.set(expected, textOf(res));
      return out;
    };

    await record('found');

    hostReply = () => new Response('GIF89a\u0000\u0001', { status: 200 });
    const binary = await record('binary', { path: 'a.gif' });
    expect(binary).not.toHaveProperty('text');

    hostReply = () => json({ message: 'Not Found' }, 404);
    await record('not_found');

    resolveReply = () => json({ message: 'No commit found for SHA: gone' }, 422);
    await record('ref_not_found', { ref: 'gone' });
    resolveReply = headReply;

    hostReply = () => json({ errors: [{ code: 'too_large' }] }, 403);
    expect(await record('too_large')).toMatchObject({ limitBytes: REPO_FILE_FETCH_MAX_BYTES });

    hostReply = () => json({ message: 'Bad credentials' }, 401);
    await record('unauthorized');

    hostCalls.length = 0;
    await record('invalid_path', { path: '../../etc/passwd' });
    expect(hostCalls).toEqual([]);

    hostReply = () => {
      throw new TypeError('fetch failed');
    };
    await record('unreachable');

    hostCalls.length = 0;
    const notInProject = await record('repo_not_in_project', { repo: 'someone/else' });
    expect(notInProject['repoSet']).toEqual(SET);
    expect(hostCalls).toEqual([]);

    // Realization IS a connected row, so `repo_not_connected` cannot be staged
    // through the project's set; the service's own answer is substituted at its
    // seam and the rest of the door is the real path.
    vi.spyOn(repoFileReadService, 'readFile').mockResolvedValueOnce({
      outcome: 'repo_not_connected',
      repoRef: `${OWNER}/motir-core`,
    });
    await record('repo_not_connected');

    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    _resetInstallationTokenCache();
    await record('provider_unavailable');

    expect(seen.size).toBe(11);
    expect(new Set(seen.values()).size).toBe(11);
  });
});

describe('code_explore / code_search — every state through the door', () => {
  const PAGE_1 =
    '60 symbols (page 1 of 2):\n[1] readFile · function · lib/x.ts:10\n' +
    `— page 1 of 2 · next: cursor: "${OWNER}/motir-core::c1"`;
  const PAGE_2 = '60 symbols (page 2 of 2):\n[51] readFile50 · function · lib/x.ts:60';

  it('ok is byte-equal to the route’s text, and its cursor reaches the route for page 2', async () => {
    aiReply = () => json({ state: 'ok', text: PAGE_1 });
    const first = await call('code_explore', graphArgs());
    expect(structured(first)).toEqual({ state: 'ok', text: PAGE_1, commits: [] });
    expect(textOf(first)).toBe(PAGE_1);

    const cursor = /cursor: "([^"]+)"/.exec(textOf(first))![1];
    aiReply = () => json({ state: 'ok', text: PAGE_2 });
    const second = await call('code_explore', graphArgs({ cursor }));
    expect(textOf(second)).toBe(PAGE_2);
    expect(aiCalls[1]!.body.args['cursor']).toBe(`${OWNER}/motir-core::c1`);
  });

  it('code_search forwards its tool and limit; a bare repo becomes args.repos over the whole set', async () => {
    aiReply = () => json({ state: 'ok', text: 'x' });
    structured(await call('code_search', graphArgs({ limit: 7, repo: 'motir-ai' })));
    expect(aiCalls).toHaveLength(1);
    const body = aiCalls[0]!.body;
    expect(Object.keys(body).sort()).toEqual(
      ['args', 'coreProjectId', 'coreWorkspaceId', 'repoRefs', 'tool'].sort(),
    );
    expect(body).toMatchObject({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      tool: 'code_search',
      repoRefs: SET,
      args: { query: 'readFile', limit: 7, repos: [`${OWNER}/motir-ai`] },
    });
    expect(JSON.stringify(body)).not.toMatch(/token|credential|secret|authorization/i);
  });

  it('an unknown repo is repo_not_in_set, and an empty set is no_repositories — zero ai calls', async () => {
    expect(structured(await call('code_explore', graphArgs({ repo: 'nope' })))).toEqual({
      state: 'repo_not_in_set',
      repo: 'nope',
      available: SET,
    });

    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BARE' });
    const res = await call('code_search', argsFor('code_search', bare.projectIdentifier), {
      ctx: bare.ctx,
    });
    expect(structured(res)).toEqual({ state: 'no_repositories' });
    expect(aiCalls).toEqual([]);
  });

  it('not_indexed carries the repository row’s index state, commits behind and refresh failure', async () => {
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId, name: 'motir-core' },
      data: {
        indexedHeadSha: 'old111',
        defaultBranchHeadSha: 'new222',
        commitsBehind: 7,
        commitsBehindBaseSha: 'old111',
        commitsBehindHeadSha: 'new222',
      },
    });
    aiReply = () => json({ state: 'not_indexed', repoRef: `${OWNER}/motir-core` });
    const out = structured(await call('code_explore', graphArgs({ repo: 'motir-core' })));
    expect(out).toMatchObject({
      state: 'not_indexed',
      repoRef: `${OWNER}/motir-core`,
      commitsBehind: 7,
      refreshFailing: false,
    });
    expect(typeof out['indexState']).toBe('string');
  });

  it('a whitespace-only repo matches nothing in the set — repo_not_in_set, zero ai calls', async () => {
    expect(structured(await call('code_explore', graphArgs({ repo: '   ' })))).toMatchObject({
      state: 'repo_not_in_set',
      available: SET,
    });
    expect(aiCalls).toEqual([]);
  });

  it('not_indexed for a repo core does not hold carries null facts, and says only "not indexed yet"', async () => {
    aiReply = () => json({ state: 'not_indexed', repoRef: 'ghost/repo' });
    const res = await call('code_explore', graphArgs());
    expect(structured(res)).toEqual({
      state: 'not_indexed',
      repoRef: 'ghost/repo',
      indexState: null,
      commitsBehind: null,
      refreshFailing: null,
      graphTooLarge: null,
    });
    expect(textOf(res)).toBe(
      'ghost/repo is not indexed yet — read its files with `read_file` instead.',
    );
  });

  it('a not_indexed summary names a failing refresh and an over-cap graph', () => {
    expect(
      summarizeCodeGraphRead({
        state: 'not_indexed',
        repoRef: `${OWNER}/motir-core`,
        indexState: 'stale',
        commitsBehind: null,
        refreshFailing: true,
        graphTooLarge: { sizeBytes: 900_000_000, capBytes: 500_000_000 },
      }),
    ).toBe(
      `${OWNER}/motir-core is not indexed yet (stale, refresh failing, graph over the size cap) — read its files with \`read_file\` instead.`,
    );
  });

  it('a state motir-ai added later is graph_unavailable naming it, never guessed at', async () => {
    aiReply = () => json({ state: 'quarantined' });
    expect(structured(await call('code_explore', graphArgs()))).toEqual({
      state: 'graph_unavailable',
      reason: 'unknown_state:quarantined',
    });
  });

  it('a 200 that is not JSON stays an ERROR — an unknown failure is never a soft state', async () => {
    aiReply = () => new Response('<html>proxy</html>', { status: 200 });
    const res = await call('code_search', graphArgs());
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.['state']).toBeUndefined();
  });

  it.each(['no_graph', 'stale_cursor', 'invalid_cursor'])(
    '%s passes through as that state',
    async (state) => {
      aiReply = () => json({ state });
      expect(structured(await call('code_explore', graphArgs()))).toEqual({ state });
    },
  );

  it('a 5xx, a thrown fetch and an unconfigured service are graph_unavailable, never isError', async () => {
    const reasons: Record<string, unknown> = {};

    // A route that answers without this door (an older motir-ai) — ai_error.
    aiReply = () => json({ code: 'not_found', status: 404, title: 'Not Found' }, 404);
    reasons['404'] = structured(await call('code_explore', graphArgs()))['reason'];

    // A 5xx is the boundary DOWN — the client's errorFromProblem maps it to
    // MotirAiUnavailableError, so it reads as ai_unreachable, like a thrown fetch.
    aiReply = () => json({ code: 'internal_error', status: 500, title: 'boom' }, 500);
    reasons['5xx'] = structured(await call('code_explore', graphArgs()))['reason'];

    aiReply = () => {
      throw new TypeError('fetch failed');
    };
    reasons['thrown'] = structured(await call('code_search', graphArgs()))['reason'];

    vi.stubEnv('MOTIR_AI_URL', '');
    reasons['unconfigured'] = structured(await call('code_search', graphArgs()))['reason'];

    expect(reasons).toEqual({
      '404': 'ai_error',
      '5xx': 'ai_unreachable',
      thrown: 'ai_unreachable',
      unconfigured: 'ai_not_configured',
    });
  });

  it('a 400 from the route stays a validation ERROR — the catch does not swallow it', async () => {
    aiReply = () =>
      json({ code: 'validation_error', status: 400, title: 'Bad', detail: 'bad args' }, 400);
    const res = await call('code_explore', graphArgs());
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.['state']).toBeUndefined();
    expect(JSON.stringify(res.content)).toContain('MOTIR_AI_BAD_REQUEST');
  });
});
