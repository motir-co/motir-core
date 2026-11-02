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
import { _resetChangedFilesCache } from '@/lib/services/repoChangesService';
import { codeGraphReadDriftService } from '@/lib/services/codeGraphReadDriftService';
import { getGitProvider } from '@/lib/git';
import type { ChangedFilesResult } from '@/lib/git/types';
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
  _resetChangedFilesCache();
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
    expect(dtoOf(res)).toEqual({ state: 'ok', text: PAGED, commits: [] });
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
    expect(dtoOf(res)).toEqual({ state: 'ok', text: 'page 2 of 2', commits: [] });
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
    expect(dtoOf(res)).toEqual({ state: 'ok', text: GREP, commits: [] });
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

describe('the DRIFT a read carries when the graph trails the default branch (MOTIR-10094)', () => {
  // The fixture repository: its graph was built at INDEXED, and ONE commit later the
  // default branch is at HEAD — the commit that ADDED `chooseInTx` in
  // `lib/services/fleetShardAdmissionService.ts`. The graph therefore cannot find it.
  const INDEXED = '8b23b07a1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
  const HEAD = '300f5bfa1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
  const ADDED = 'lib/services/fleetShardAdmissionService.ts';
  const CORE = `${OWNER}/motir-core`;

  async function behindByOne(name = 'motir-core'): Promise<void> {
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId, name },
      data: {
        indexedHeadSha: INDEXED,
        defaultBranchHeadSha: HEAD,
        commitsBehind: 1,
        commitsBehindBaseSha: INDEXED,
        commitsBehindHeadSha: HEAD,
      },
    });
  }

  /** The REAL registered provider's compare, replaced — the object the service is handed. */
  function stubCompare(answer: (base: string, head: string) => ChangedFilesResult) {
    const github = getGitProvider('github');
    return vi
      .spyOn(github, 'listChangedFiles')
      .mockImplementation(async (_inst, _owner, _name, base, head) => answer(base, head));
  }
  const listed = (paths: string[], truncated = false): ChangedFilesResult => ({
    outcome: 'ok',
    base: INDEXED,
    head: HEAD,
    files: paths.map((path) => ({ path, status: 'modified' as const })),
    truncated,
    baseSha: INDEXED,
    headSha: HEAD,
  });

  it('AC1 — code_search for a symbol the one missing commit added: no match, commitsBehind 1, and the file in changedPaths', async () => {
    await behindByOne();
    const compare = stubCompare(() => listed([ADDED, 'lib/fleet/containerSize.ts']));
    aiReply = () => okText({ state: 'ok', text: 'No symbols found.' });

    const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'chooseInTx',
      repo: 'motir-core',
    });
    const dto = dtoOf(res);
    expect(dto['state']).toBe('ok');
    expect(dto['text']).toBe('No symbols found.');
    expect(dto['drift']).toEqual([
      {
        repoRef: CORE,
        indexedSha: INDEXED,
        defaultHead: HEAD,
        commitsBehind: 1,
        changedPaths: [ADDED, 'lib/fleet/containerSize.ts'],
        changedPathsTruncated: false,
        changedPathsUnavailable: null,
        // `chooseInTx` → `choose`, which no changed path names: a lead, not a bound.
        changedPathsInQueryArea: [],
      },
    ]);
    // The compare is the graph's commit against the head, on the stored coordinates.
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]!.slice(1)).toEqual([OWNER, 'motir-core', INDEXED, HEAD]);

    // The text an agent reads: the executor's bytes FIRST and untouched, then the note.
    const summary = summaryOf(res);
    expect(summary.startsWith('No symbols found.\n\n')).toBe(true);
    expect(summary).toContain('THE GRAPH IS BEHIND THE DEFAULT BRANCH');
    expect(summary).toContain(
      `${CORE}: the graph is at 8b23b07, 1 commit behind the default branch at 300f5bf.`,
    );
    expect(summary).toContain(`These 2 paths changed since: ${ADDED}, lib/fleet/containerSize.ts.`);
    expect(summary).toContain('a symbol need not be named in its file’s path');
    expect(summary).toContain('holds only for code OUTSIDE the changed paths');
  });

  it('AC1 — a graph at the head carries NO drift fields, and no compare is made', async () => {
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId },
      data: { indexedHeadSha: HEAD, defaultBranchHeadSha: HEAD },
    });
    const compare = stubCompare(() => listed([ADDED]));
    aiReply = () => okText({ state: 'ok', text: 'No symbols found.' });
    const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'chooseInTx',
    });
    // The commit each repository's graph was read at (MOTIR-10122), full sha, in set order.
    expect(dtoOf(res)).toEqual({
      state: 'ok',
      text: 'No symbols found.',
      commits: [
        { repoRef: `${OWNER}/motir-ai`, indexedSha: HEAD },
        { repoRef: `${OWNER}/motir-core`, indexedSha: HEAD },
      ],
    });
    expect(summaryOf(res)).toBe(
      `No symbols found.\n\nGraph commits read: ${OWNER}/motir-ai@${HEAD}, ${OWNER}/motir-core@${HEAD}.`,
    );
    expect(compare).not.toHaveBeenCalled();
  });

  it('a graph with an unknown sha on either side is not called behind — null is "not known yet"', async () => {
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId },
      data: { indexedHeadSha: INDEXED, defaultBranchHeadSha: null },
    });
    const compare = stubCompare(() => listed([ADDED]));
    aiReply = () => okText({ state: 'ok', text: 'x' });
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(res)).toEqual({
      state: 'ok',
      text: 'x',
      commits: [
        { repoRef: `${OWNER}/motir-ai`, indexedSha: INDEXED },
        { repoRef: `${OWNER}/motir-core`, indexedSha: INDEXED },
      ],
    });
    expect(compare).not.toHaveBeenCalled();
  });

  it('AC2 — a compare too large to list is a BOUNDED list marked as cut, never an empty one', async () => {
    await behindByOne();
    // The host's own cap (300) reached, so it says `truncated` — and this answer
    // bounds the list again, at 50.
    const many = Array.from({ length: 300 }, (_, i) => `lib/gen/file${i}.ts`);
    many[120] = 'lib/fleet/admission.ts';
    stubCompare(() => listed(many, true));
    aiReply = () => okText({ state: 'ok', text: '3 symbols:' });
    const res = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'fleet admission',
      repo: 'motir-core',
    });
    const [drift] = dtoOf(res)['drift'] as Record<string, unknown>[];
    expect(drift!['changedPaths']).toHaveLength(50);
    expect(drift!['changedPaths']).toEqual(many.slice(0, 50));
    expect(drift!['changedPathsTruncated']).toBe(true);
    // The area is matched over every path the host listed, past the 50 shown.
    expect(drift!['changedPathsInQueryArea']).toEqual(['lib/fleet/admission.ts']);
    const summary = summaryOf(res);
    expect(summary).toContain('At least these 50 paths changed since:');
    expect(summary).toContain('and 30 more in `drift`');
    expect(summary).toContain('(the list was cut)');
    expect(summary).toContain('The searched area touches 1 of them: lib/fleet/admission.ts');

    // Fewer than the host's cap but more than this answer's bound is cut too.
    _resetChangedFilesCache();
    stubCompare(() => listed(many.slice(0, 60)));
    const again = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
      repo: 'motir-core',
    });
    const [cut] = dtoOf(again)['drift'] as Record<string, unknown>[];
    expect(cut!['changedPaths']).toHaveLength(50);
    expect(cut!['changedPathsTruncated']).toBe(true);
  });

  it.each([
    ['too_large', { outcome: 'too_large', base: INDEXED, head: HEAD }],
    ['no_such_ref', { outcome: 'no_such_ref', base: INDEXED, head: HEAD }],
    ['revoked', { outcome: 'revoked', base: INDEXED, head: HEAD }],
    ['host_error', { outcome: 'host_error', base: INDEXED, head: HEAD, detail: 'boom' }],
  ] as const)(
    'a host that declines (%s) is named — changedPaths null, never []',
    async (reason, answer) => {
      await behindByOne();
      stubCompare(() => answer as ChangedFilesResult);
      aiReply = () => okText({ state: 'ok', text: 'No symbols found.' });
      const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
        projectKey: fx.projectIdentifier,
        query: 'chooseInTx',
        repo: 'motir-core',
      });
      const [drift] = dtoOf(res)['drift'] as Record<string, unknown>[];
      expect(drift).toMatchObject({
        changedPaths: null,
        changedPathsTruncated: false,
        changedPathsUnavailable: reason,
        changedPathsInQueryArea: null,
      });
      expect(summaryOf(res)).toContain(
        `What changed could not be listed (${reason}), so every absence in this answer is unproven`,
      );
    },
  );

  it('a compare that THROWS is reported as host_error, and the read still answers', async () => {
    await behindByOne();
    const github = getGitProvider('github');
    vi.spyOn(github, 'listChangedFiles').mockRejectedValue(new Error('socket hang up'));
    aiReply = () => okText({ state: 'ok', text: 'x' });
    const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
      repo: 'motir-core',
    });
    expect((dtoOf(res)['drift'] as Record<string, unknown>[])[0]).toMatchObject({
      changedPaths: null,
      changedPathsUnavailable: 'host_error',
    });
  });

  it('a drift read that fails outright never fails the graph answer', async () => {
    await behindByOne();
    vi.spyOn(codeGraphReadDriftService, 'forRead').mockRejectedValue(new Error('unexpected'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    aiReply = () => okText({ state: 'ok', text: 'x' });
    const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(res)).toEqual({ state: 'ok', text: 'x', commits: expect.any(Array) });
  });

  it('the paths come from ONE compare per commit pair — a second read is answered from the cache', async () => {
    await behindByOne();
    const compare = stubCompare(() => listed([ADDED]));
    aiReply = () => okText({ state: 'ok', text: 'x' });
    for (const query of ['chooseInTx', 'fleetKindOnPool']) {
      await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
        projectKey: fx.projectIdentifier,
        query,
        repo: 'motir-core',
      });
    }
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('only the repositories READ carry drift, in the set’s order; a non-ok answer carries none', async () => {
    await behindByOne('motir-core');
    await behindByOne('motir-ai');
    stubCompare(() => listed([ADDED]));
    aiReply = () => okText({ state: 'ok', text: 'x' });
    const all = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect((dtoOf(all)['drift'] as { repoRef: string }[]).map((d) => d.repoRef)).toEqual(SET);
    const one = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
      repo: 'motir-ai',
    });
    expect((dtoOf(one)['drift'] as { repoRef: string }[]).map((d) => d.repoRef)).toEqual([
      `${OWNER}/motir-ai`,
    ]);

    aiReply = () => okText({ state: 'stale_cursor' });
    const stale = await callTool(CODE_EXPLORE_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
    });
    expect(dtoOf(stale)).toEqual({ state: 'stale_cursor' });
  });

  it('code_grep: the searched area is its path prefix, matched exactly; an uncounted drift says so', async () => {
    await behindByOne();
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId, name: 'motir-core' },
      data: { commitsBehind: null },
    });
    stubCompare(() => listed(['lib/billing/plans.ts', 'app/pricing/page.tsx']));
    aiReply = () => okText({ state: 'ok', text: '0 matching lines' });
    const res = await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: 'Enterprise',
      path: './lib/billing/',
      repo: 'motir-core',
    });
    const [drift] = dtoOf(res)['drift'] as Record<string, unknown>[];
    expect(drift).toMatchObject({
      commitsBehind: null,
      changedPathsInQueryArea: ['lib/billing/plans.ts'],
    });
    expect(summaryOf(res)).toContain('an uncounted number of commits behind');
    expect(summaryOf(res)).toContain(
      'The searched area touches 1 of them: lib/billing/plans.ts — read those with `read_file`',
    );

    // Without a path, the pattern's words are the area.
    const byWords = await callTool(CODE_GREP_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      pattern: 'pricing',
      repo: 'motir-core',
    });
    expect((dtoOf(byWords)['drift'] as Record<string, unknown>[])[0]).toMatchObject({
      changedPathsInQueryArea: ['app/pricing/page.tsx'],
    });
  });

  it('two commits that changed no file say the graph’s code is the default branch’s', async () => {
    await behindByOne();
    stubCompare(() => listed([]));
    aiReply = () => okText({ state: 'ok', text: 'x' });
    const res = await callTool(CODE_SEARCH_TOOL_NAME, fx.ctx, {
      projectKey: fx.projectIdentifier,
      query: 'q',
      repo: 'motir-core',
    });
    expect((dtoOf(res)['drift'] as Record<string, unknown>[])[0]).toMatchObject({
      changedPaths: [],
      changedPathsTruncated: false,
    });
    expect(summaryOf(res)).toContain('No file changed between the two commits');
  });

  it('the description of every graph tool names the drift', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    for (const name of [CODE_EXPLORE_TOOL_NAME, CODE_SEARCH_TOOL_NAME, CODE_GREP_TOOL_NAME]) {
      expect(tools.find((t) => t.name === name)!.description).toContain('`changedPaths`');
    }
  });
});
