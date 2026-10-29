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
import { isBillableTool } from '@/lib/mcp/rateLimitGate';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import {
  CODE_EXPLORE_TOOL_NAME,
  CODE_GREP_TOOL_NAME,
  CODE_SEARCH_TOOL_NAME,
} from '@/lib/mcp/tools/codeGraphRead';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures';
import { linkAllWorkspaceReposIntoProject } from '../fixtures/codeContextFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `code_explore` / `code_search` (Story MOTIR-7858 · Subtask MOTIR-7862) over real
// Postgres. motir-ai's `POST /v1/code-graph/read` is stubbed at the `fetch` the
// client's `aiFetch` calls — the one boundary seam; the workspace, project,
// repository set, code-context facts and every permission decision are the real
// path. One case per service branch, and the calls the stub saw are how "the
// route was not called" and "what crossed the boundary" are asserted.

const AI_URL = 'http://motir-ai.test';
const SERVICE_TOKEN = 'svc-token-7862';
const OWNER = 'moooon-B-V';
// The project's set, in the order its link positions give it.
const SET = [`${OWNER}/motir-ai`, `${OWNER}/motir-core`];

interface AiCall {
  url: string;
  auth: string | null;
  body: {
    coreWorkspaceId: string;
    coreProjectId: string;
    tool: string;
    repoRefs: string[];
    args: Record<string, unknown>;
  };
}
const aiCalls: AiCall[] = [];
let aiReply: () => Response | Promise<Response>;
const okText = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

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
  const client = new Client({ name: 'code-graph-read-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(
  name: string,
  ctx: ServiceContext,
  args: Record<string, unknown>,
  grant?: readonly PermissionKey[],
): Promise<CallToolResult> {
  const client = await connectClient(ctx, grant);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function dtoOf(res: CallToolResult): Record<string, unknown> {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as Record<string, unknown>;
}
const summaryOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;

/** Two realized repositories — moooon-B-V/motir-core and moooon-B-V/motir-ai. */
async function seedRepoSet(fx: WorkItemFixture): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: OWNER,
      accountType: 'Organization',
    },
    repos: ['motir-core', 'motir-ai'].map((name) => ({
      providerRepoId: `repo-${name}-${fx.workspaceId}`,
      owner: OWNER,
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  await linkAllWorkspaceReposIntoProject({ ...fx.ctx, projectId: fx.projectId });
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  aiCalls.length = 0;
  aiReply = () => okText({ state: 'ok', text: 'unset' });
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', SERVICE_TOKEN);
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== AI_URL) return realFetch(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    aiCalls.push({
      url,
      auth: headers['Authorization'] ?? null,
      body: JSON.parse(String(init?.body)) as AiCall['body'],
    });
    return aiReply();
  });
  fx = await makeWorkItemFixture();
  await seedRepoSet(fx);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('code_explore / code_search / code_grep — registered and permissioned', () => {
  it('tools/list names all three, read-only and closed-world; every declaration home carries them', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    for (const name of [CODE_EXPLORE_TOOL_NAME, CODE_SEARCH_TOOL_NAME, CODE_GREP_TOOL_NAME]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `${name} is not registered`).toBeTruthy();
      expect(tool!.annotations?.readOnlyHint).toBe(true);
      expect(tool!.annotations?.openWorldHint).toBe(false);
      expect(MCP_TOOL_NAMES).toContain(name);
      expect(TOOL_PERMISSIONS[name as keyof typeof TOOL_PERMISSIONS]).toBe('ai:plan');
      expect(TOOL_SCOPES[name as keyof typeof TOOL_SCOPES]).toBe('read');
      expect(TOOL_ANNOTATIONS[name as keyof typeof TOOL_ANNOTATIONS].readOnlyHint).toBe(true);
      expect(EXEMPT_TOOLS).toHaveProperty(name);
      // A read starts no model job, so it spends no AI rate budget.
      expect(isBillableTool(name)).toBe(false);
    }
    const search = tools.find((t) => t.name === CODE_SEARCH_TOOL_NAME)!;
    expect(Object.keys(search.inputSchema.properties ?? {}).sort()).toEqual(
      ['cursor', 'limit', 'projectKey', 'query', 'repo'].sort(),
    );
    const grep = tools.find((t) => t.name === CODE_GREP_TOOL_NAME)!;
    expect(Object.keys(grep.inputSchema.properties ?? {}).sort()).toEqual(
      [
        'caseInsensitive',
        'cursor',
        'limit',
        'path',
        'pattern',
        'projectKey',
        'regex',
        'repo',
      ].sort(),
    );
    expect(grep.inputSchema.required).toEqual(['projectKey', 'pattern']);
  });

  it('a token whose grant lacks ai:plan is refused at the door for all three, before any ai call', async () => {
    for (const name of [CODE_EXPLORE_TOOL_NAME, CODE_SEARCH_TOOL_NAME, CODE_GREP_TOOL_NAME]) {
      const denied = await callTool(
        name,
        fx.ctx,
        name === CODE_GREP_TOOL_NAME
          ? { projectKey: fx.projectIdentifier, pattern: 'readFile' }
          : { projectKey: fx.projectIdentifier, query: 'readFile' },
        GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
      );
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
    }
    expect(aiCalls).toEqual([]);
  });

  it('a key from another workspace reads as not-found, before any ai call', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await seedRepoSet(other);
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: other.projectIdentifier,
      query: 'readFile',
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('PROJECT_NOT_FOUND');
    expect(aiCalls).toEqual([]);
  });
});

describe('code_explore / code_search — the read', () => {
  const PAGED =
    '12 symbols (page 1 of 2):\n[1] readFile · function · lib/services/repoFileReadService.ts:94\n' +
    '— page 1 of 2 · next: cursor: "moooon-B-V/motir-core::c1"';

  it('code_explore passes the route’s text through BYTE-EQUAL, sending the whole set and no credential', async () => {
    aiReply = () => okText({ state: 'ok', text: PAGED });
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'readFile',
    });
    expect(dtoOf(res)).toEqual({ state: 'ok', text: PAGED });
    expect(summaryOf(res)).toBe(PAGED);

    expect(aiCalls).toHaveLength(1);
    const [call] = aiCalls;
    expect(call!.url).toBe(`${AI_URL}/v1/code-graph/read`);
    expect(call!.auth).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(call!.body).toEqual({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      tool: 'code_explore',
      repoRefs: SET,
      args: { query: 'readFile' },
    });
  });

  it('code_search forwards tool, limit and cursor', async () => {
    aiReply = () => okText({ state: 'ok', text: 'page 2 of 2' });
    const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'readFile',
      limit: 5,
      cursor: 'moooon-B-V/motir-core::c1',
    });
    expect(dtoOf(res)).toEqual({ state: 'ok', text: 'page 2 of 2' });
    expect(aiCalls[0]!.body).toMatchObject({
      tool: 'code_search',
      args: { query: 'readFile', limit: 5, cursor: 'moooon-B-V/motir-core::c1' },
    });
  });

  it('a bare-name or owner/name repo is sent as args.repos: [owner/name]', async () => {
    aiReply = () => okText({ state: 'ok', text: 'x' });
    for (const repo of ['motir-core', 'MOOOON-B-V/Motir-Core']) {
      await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
        projectKey: fx.projectIdentifier,
        query: 'q',
        repo,
      });
    }
    expect(aiCalls.map((c) => c.body.args['repos'])).toEqual([
      [`${OWNER}/motir-core`],
      [`${OWNER}/motir-core`],
    ]);
    expect(aiCalls.every((c) => c.body.repoRefs.length === 2)).toBe(true);
  });

  it('an unknown repo is repo_not_in_set with the set, and motir-ai is never called', async () => {
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
      repo: 'someone/else',
    });
    expect(dtoOf(res)).toEqual({
      state: 'repo_not_in_set',
      repo: 'someone/else',
      available: SET,
    });
    expect(aiCalls).toEqual([]);
  });

  it('a project with no realized repository is no_repositories, and motir-ai is never called', async () => {
    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BARE' });
    const res = await callTool(CODE_SEARCH_TOOL_NAME, bare.ctx, {
      projectKey: bare.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(res)).toEqual({ state: 'no_repositories' });
    expect(aiCalls).toEqual([]);
  });

  it('not_indexed is enriched with core’s index state and commits behind', async () => {
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId, name: 'motir-ai' },
      data: {
        indexedHeadSha: 'aaa111',
        defaultBranchHeadSha: 'bbb222',
        commitsBehind: 12,
        commitsBehindBaseSha: 'aaa111',
        commitsBehindHeadSha: 'bbb222',
      },
    });
    aiReply = () => okText({ state: 'not_indexed', repoRef: `${OWNER}/motir-ai` });
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
      repo: 'motir-ai',
    });
    const dto = dtoOf(res);
    expect(dto).toMatchObject({
      state: 'not_indexed',
      repoRef: `${OWNER}/motir-ai`,
      commitsBehind: 12,
      refreshFailing: false,
      graphTooLarge: null,
    });
    expect(typeof dto['indexState']).toBe('string');
    expect(summaryOf(res)).toContain('12 commits behind');
    expect(summaryOf(res)).toContain('read_file');
  });

  it.each([
    [{ state: 'no_graph' }, { state: 'no_graph' }],
    [{ state: 'stale_cursor' }, { state: 'stale_cursor' }],
    [{ state: 'invalid_cursor' }, { state: 'invalid_cursor' }],
    [
      { state: 'graph_unavailable', reason: 'hydrate_failed' },
      { state: 'graph_unavailable', reason: 'hydrate_failed' },
    ],
    [
      { state: 'repo_not_in_set', repoRef: 'x/y' },
      {
        state: 'repo_not_in_set',
        repo: 'x/y',
        available: SET,
      },
    ],
  ])('route state %j comes back named: %j', async (route, expected) => {
    aiReply = () => okText(route);
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(res)).toEqual(expected);
  });

  it('a route 5xx, an unreachable motir-ai and an unconfigured AI service are graph_unavailable', async () => {
    aiReply = () =>
      new Response(JSON.stringify({ code: 'internal_error', status: 500, title: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/problem+json' },
      });
    const fiveHundred = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(fiveHundred)).toEqual({ state: 'graph_unavailable', reason: 'ai_unreachable' });

    aiReply = () => {
      throw new TypeError('fetch failed');
    };
    const thrown = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(thrown)).toEqual({ state: 'graph_unavailable', reason: 'ai_unreachable' });

    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    const unconfigured = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(unconfigured)).toEqual({
      state: 'graph_unavailable',
      reason: 'ai_not_configured',
    });
  });

  it('a route without this door (404 on an older motir-ai) is graph_unavailable ai_error', async () => {
    aiReply = () =>
      new Response(JSON.stringify({ code: 'not_found', status: 404, title: 'Not Found' }), {
        status: 404,
      });
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(res)).toEqual({ state: 'graph_unavailable', reason: 'ai_error' });
  });

  it('a request motir-ai rejects as malformed stays an ERROR, never a soft state', async () => {
    aiReply = () =>
      new Response(
        JSON.stringify({ code: 'validation_error', status: 400, title: 'Bad', detail: 'bad args' }),
        { status: 400 },
      );
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('MOTIR_AI_BAD_REQUEST');
  });
});

describe('code_grep — the file-contents search (MOTIR-10066)', () => {
  // The executor's own text, as motir-ai renders it: the commit searched and the
  // files under the path filter that were NOT searched travel inside `ok.text`.
  const GREP =
    '2 matching lines in 2 files · searched 41 files at commit 3f2a9c1:\n' +
    'lib/billing/plans.ts:12: const COPY = "Standard, Pro, Max or Enterprise";\n' +
    'lib/billing/plans.json:4:   "tiers": "Standard, Pro, Max or Enterprise"\n' +
    'Not searched — 2 files under lib/billing/: lib/billing/logo.png (binary), ' +
    'lib/billing/seed.sql (over the 1 MiB cap). Read them with read_file before calling a list complete.';

  it('forwards pattern, regex, caseInsensitive, path, repo and limit, and passes the text through byte-equal', async () => {
    aiReply = () => okText({ state: 'ok', text: GREP });
    const res = await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: 'Standard, Pro, Max or Enterprise',
      regex: false,
      caseInsensitive: true,
      path: 'lib/billing/',
      repo: 'motir-core',
      limit: 20,
    });
    expect(dtoOf(res)).toEqual({ state: 'ok', text: GREP });
    expect(summaryOf(res)).toBe(GREP);
    // AC4: the answer names the indexed commit and the skipped files under its path.
    expect(summaryOf(res)).toContain('at commit 3f2a9c1');
    expect(summaryOf(res)).toContain('lib/billing/logo.png (binary)');
    expect(summaryOf(res)).toContain('lib/billing/seed.sql (over the 1 MiB cap)');

    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]!.body).toEqual({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      tool: 'code_grep',
      repoRefs: SET,
      args: {
        pattern: 'Standard, Pro, Max or Enterprise',
        regex: false,
        caseInsensitive: true,
        path: 'lib/billing/',
        repos: [`${OWNER}/motir-core`],
        limit: 20,
      },
    });
    expect(aiCalls[0]!.body.args).not.toHaveProperty('query');
  });

  it('a pattern is sent untrimmed, and a regex with only the required arguments', async () => {
    aiReply = () => okText({ state: 'ok', text: 'x' });
    await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: ' Max ',
    });
    await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: '(a+)+$',
      regex: true,
    });
    expect(aiCalls.map((c) => c.body.args)).toEqual([
      { pattern: ' Max ' },
      { pattern: '(a+)+$', regex: true },
    ]);
  });

  it('content_not_indexed is NOT an empty match: enriched with commits behind, and says so', async () => {
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId, name: 'motir-ai' },
      data: {
        indexedHeadSha: 'aaa111',
        defaultBranchHeadSha: 'bbb222',
        commitsBehind: 3,
        commitsBehindBaseSha: 'aaa111',
        commitsBehindHeadSha: 'bbb222',
      },
    });
    aiReply = () => okText({ state: 'content_not_indexed', repoRef: `${OWNER}/motir-ai` });
    const res = await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: 'Enterprise',
      repo: 'motir-ai',
    });
    const dto = dtoOf(res);
    expect(dto).toMatchObject({
      state: 'content_not_indexed',
      repoRef: `${OWNER}/motir-ai`,
      commitsBehind: 3,
    });
    expect(typeof dto['indexState']).toBe('string');
    const summary = summaryOf(res);
    expect(summary).toContain(`${OWNER}/motir-ai's file contents are not indexed yet`);
    expect(summary).toContain('3 commits behind');
    expect(summary).toContain('NOT an empty match');
    expect(summary).toContain('read_file');
  });

  it('content_not_indexed for a repo core has no row for carries null facts', async () => {
    aiReply = () => okText({ state: 'content_not_indexed', repoRef: 'x/unknown' });
    const res = await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: 'Enterprise',
    });
    expect(dtoOf(res)).toEqual({
      state: 'content_not_indexed',
      repoRef: 'x/unknown',
      indexState: null,
      commitsBehind: null,
    });
    expect(summaryOf(res)).toBe(
      "x/unknown's file contents are not indexed yet: its graph was built before contents were stored, so this is NOT an empty match. Its next index run stores them; until then read its files with `read_file`.",
    );
  });

  it('an empty pattern is refused by the schema, before any ai call', async () => {
    const res = await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: '',
    });
    expect(res.isError).toBe(true);
    expect(aiCalls).toEqual([]);
  });
});
