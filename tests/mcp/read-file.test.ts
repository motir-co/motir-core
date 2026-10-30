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
  READ_FILE_CONTENT_CAP,
  READ_FILE_TOOL_NAME,
  renderReadFile,
} from '@/lib/mcp/tools/readFile';
import { REPO_FILE_MAX_BYTES } from '@/lib/git';
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

// `read_file` (Story MOTIR-7858 · Subtask MOTIR-7861) over real Postgres — one
// file's text from a repository in the PROJECT's set, at a ref, gated on `ai:plan`.
//
// The git host is reached through the REAL GitHub provider with the global
// `fetch` stubbed — the seam `tests/git/repoFileRead.test.ts` drives the provider
// through — so the token mint, the raw media type and every status mapping are the
// shipped path. Workspace, project, installation, the project's repository set and
// every permission decision are the real Postgres path. The host-call count (every
// fetch that was NOT the token mint) is how "no provider call" is asserted.

const TOKEN = 'ghs_read_file_secret';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Reply = (url: string) => Response | Promise<Response>;
let reply: Reply = () => new Response('', { status: 500 });
// The ref is resolved to its commit first (MOTIR-10122), then the file is read AT
// that commit — so a contents call names `HEAD_SHA`, never the branch.
const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const headReply: Reply = () => new Response(HEAD_SHA, { status: 200 });
let resolveReply: Reply = headReply;
const hostCalls: string[] = [];

function stubHost(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/access_tokens')) {
      return new Response(
        JSON.stringify({
          token: TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    hostCalls.push(url);
    return url.includes('/commits/') ? resolveReply(url) : reply(url);
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
  const client = new Client({ name: 'read-file-test', version: '0.0.0' });
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
      name: READ_FILE_TOOL_NAME,
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

/** Two realized repositories (acme/alpha, acme/beta) in the project's set, default branch `main`. */
async function seedRepoSet(fx: WorkItemFixture): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: ['alpha', 'beta'].map((name) => ({
      providerRepoId: `repo-${name}-${fx.workspaceId}`,
      owner: 'acme',
      name,
      defaultBranch: name === 'alpha' ? 'main' : 'trunk',
      archived: false,
    })),
  });
  await linkAllWorkspaceReposIntoProject({ ...fx.ctx, projectId: fx.projectId });
}

let fx: WorkItemFixture;
const args = (extra: Record<string, unknown> = {}) => ({
  projectKey: fx.projectIdentifier,
  repo: 'alpha',
  path: 'lib/x.ts',
  ...extra,
});

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  hostCalls.length = 0;
  reply = () => new Response('export const x = 1;\n', { status: 200 });
  resolveReply = headReply;
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

describe('read_file — registered and permissioned', () => {
  it('tools/list names it, titled, read-only and OPEN-world; every declaration home carries it', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === READ_FILE_TOOL_NAME);
    expect(tool, 'read_file is not registered').toBeTruthy();
    expect(tool!.title).toBe('Read a file');
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.openWorldHint).toBe(true);
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(
      ['endLine', 'path', 'projectKey', 'ref', 'repo', 'startLine'].sort(),
    );

    expect(MCP_TOOL_NAMES).toContain(READ_FILE_TOOL_NAME);
    expect(TOOL_PERMISSIONS[READ_FILE_TOOL_NAME]).toBe('ai:plan');
    expect(TOOL_SCOPES[READ_FILE_TOOL_NAME]).toBe('read');
    expect(TOOL_ANNOTATIONS[READ_FILE_TOOL_NAME]).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(EXEMPT_TOOLS).toHaveProperty(READ_FILE_TOOL_NAME);
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
    expect(outcomeOf(allowed)['outcome']).toBe('found');
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

describe('read_file — the read', () => {
  it('reads at the repository’s stored default branch when ref is omitted', async () => {
    const out = outcomeOf(await callTool(fx.ctx, args()));
    expect(out).toMatchObject({
      outcome: 'found',
      repoRef: 'acme/alpha',
      path: 'lib/x.ts',
      ref: 'main',
      bytes: 20,
      text: 'export const x = 1;\n',
      lines: null,
      truncated: false,
    });
    expect(out['commitSha']).toBe(HEAD_SHA);
    expect(summaryOf(await callTool(fx.ctx, args()))).toContain(`at main (commit ${HEAD_SHA})`);
    hostCalls.length = 0;
    await callTool(fx.ctx, args());
    expect(hostCalls).toEqual([
      'https://api.github.com/repos/acme/alpha/commits/main',
      `https://api.github.com/repos/acme/alpha/contents/lib/x.ts?ref=${HEAD_SHA}`,
    ]);

    // The other repo's default branch is ITS row's, not a global `main`.
    hostCalls.length = 0;
    expect(outcomeOf(await callTool(fx.ctx, args({ repo: 'beta' })))['ref']).toBe('trunk');
    expect(hostCalls[0]).toContain('/commits/trunk');
  });

  it('reads at an explicit ref, and resolves owner/name case-insensitively', async () => {
    const out = outcomeOf(await callTool(fx.ctx, args({ repo: 'ACME/Alpha', ref: 'feat/x' })));
    expect(out).toMatchObject({ outcome: 'found', repoRef: 'acme/alpha', ref: 'feat/x' });
    expect(hostCalls[0]).toContain('/commits/feat%2Fx');
  });

  it('startLine / endLine return that inclusive range, clamped, headed lines a-b of N', async () => {
    reply = () => new Response('one\ntwo\nthree\nfour\nfive', { status: 200 });
    const res = await callTool(fx.ctx, args({ startLine: 2, endLine: 3 }));
    expect(outcomeOf(res)).toMatchObject({
      text: 'two\nthree',
      lines: { from: 2, to: 3, total: 5 },
    });
    expect(summaryOf(res)).toContain('lines 2-3 of 5:');

    const clamped = outcomeOf(await callTool(fx.ctx, args({ startLine: 4, endLine: 99 })));
    expect(clamped).toMatchObject({ text: 'four\nfive', lines: { from: 4, to: 5, total: 5 } });
  });

  it('cuts a result over 24,000 characters and ends it with the truncation SENTENCE', async () => {
    const body = 'a'.repeat(READ_FILE_CONTENT_CAP + 500);
    expect(body.length).toBeLessThan(REPO_FILE_MAX_BYTES);
    reply = () => new Response(body, { status: 200 });
    const out = outcomeOf(await callTool(fx.ctx, args()));
    const text = out['text'] as string;
    expect(out['truncated']).toBe(true);
    expect(text.startsWith('a'.repeat(READ_FILE_CONTENT_CAP))).toBe(true);
    expect(text.slice(READ_FILE_CONTENT_CAP)).toContain(
      `the first ${READ_FILE_CONTENT_CAP} of ${body.length} characters`,
    );
    expect(text).toMatch(/Re-read with startLine \/ endLine to reach the rest\.\]$/);
  });

  it('a blob holding a NUL is binary, with no text', async () => {
    reply = () => new Response('PK\u0003\u0004\u0000\u0000binary', { status: 200 });
    const res = await callTool(fx.ctx, args({ path: 'assets/logo.png' }));
    const out = outcomeOf(res);
    expect(out).toEqual({
      outcome: 'binary',
      repoRef: 'acme/alpha',
      path: 'assets/logo.png',
      ref: 'main',
      commitSha: HEAD_SHA,
      bytes: expect.any(Number),
    });
    expect(summaryOf(res)).not.toContain('PK');
  });

  // MOTIR-9868 — a DIRECTORY is listed, never handed over as the host's raw JSON.
  it('a directory path lists its immediate entries, not the host’s listing JSON', async () => {
    const item = (name: string, type: string) => ({
      name,
      path: `.github/workflows/${name}`,
      sha: 'a'.repeat(40),
      type,
      _links: { self: 'x' },
    });
    reply = () =>
      new Response(JSON.stringify([item('release.yml', 'file'), item('shared', 'dir')]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const res = await callTool(fx.ctx, args({ path: '.github/workflows' }));
    expect(outcomeOf(res)).toEqual({
      outcome: 'directory',
      repoRef: 'acme/alpha',
      path: '.github/workflows',
      ref: 'main',
      commitSha: HEAD_SHA,
      entries: [
        { name: 'release.yml', type: 'file' },
        { name: 'shared', type: 'dir' },
      ],
      truncated: false,
    });
    const summary = summaryOf(res);
    expect(summary).toContain('is a DIRECTORY');
    expect(summary).toContain('release.yml (file)');
    expect(summary).toContain('\nshared/');
    expect(summary).not.toContain('_links');
  });

  it('a repo outside the project’s set is repo_not_in_project, naming the set, and the host is never asked', async () => {
    const res = await callTool(fx.ctx, args({ repo: 'someone/else' }));
    expect(outcomeOf(res)).toEqual({
      outcome: 'repo_not_in_project',
      repo: 'someone/else',
      repoSet: ['acme/alpha', 'acme/beta'],
    });
    expect(summaryOf(res)).toContain('"acme/alpha", "acme/beta"');
    expect(hostCalls).toEqual([]);
  });

  it('a project with no repository set reads a repository its organisation connected as not in its set', async () => {
    // The organisation's acme/alpha is connected (seeded for `fx`), but this
    // project's set is empty — the set, not the organisation, is the boundary.
    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BARE' });
    const res = await callTool(bare.ctx, {
      projectKey: bare.projectIdentifier,
      repo: 'alpha',
      path: 'lib/x.ts',
    });
    expect(outcomeOf(res)).toMatchObject({ outcome: 'repo_not_in_project', repoSet: [] });
    expect(hostCalls).toEqual([]);
  });

  it('never carries the provider credential or a download URL', async () => {
    for (const r of [
      () => new Response('export const x = 1;\n', { status: 200 }),
      () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    ]) {
      reply = r;
      const serialized = JSON.stringify(await callTool(fx.ctx, args()));
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('download_url');
      expect(serialized).not.toContain('api.github.com');
    }
  });
});

describe('read_file — the ref is resolved to a commit BEFORE the read (MOTIR-10122)', () => {
  it('a ref the host cannot resolve never reaches the read, and names why', async () => {
    resolveReply = () => new Response('{}', { status: 403 });
    expect(outcomeOf(await callTool(fx.ctx, args()))).toEqual({
      outcome: 'unauthorized',
      repoRef: 'acme/alpha',
      path: 'lib/x.ts',
      ref: 'main',
    });
    resolveReply = () => {
      throw new TypeError('fetch failed');
    };
    expect(outcomeOf(await callTool(fx.ctx, args()))).toMatchObject({
      outcome: 'unreachable',
      failure: 'unreachable',
    });
    expect(hostCalls.some((u) => u.includes('/contents/'))).toBe(false);
  });
});

describe('read_file — every other outcome is named, non-error and distinct', () => {
  async function outcomeFor(
    setup: () => void,
    extra: Record<string, unknown> = {},
  ): Promise<{ outcome: Record<string, unknown>; summary: string }> {
    setup();
    const res = await callTool(fx.ctx, args(extra));
    return { outcome: outcomeOf(res), summary: summaryOf(res) };
  }

  it('not_found · ref_not_found · too_large · unauthorized · invalid_path · unreachable · provider_unavailable · repo_not_connected', async () => {
    const seen = new Map<string, string>();

    const notFound = await outcomeFor(() => {
      reply = () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    expect(notFound.outcome).toEqual({
      outcome: 'not_found',
      repoRef: 'acme/alpha',
      path: 'lib/x.ts',
      ref: 'main',
      commitSha: HEAD_SHA,
    });
    seen.set('not_found', notFound.summary);

    const refNotFound = await outcomeFor(
      () => {
        hostCalls.length = 0;
        resolveReply = () =>
          new Response(JSON.stringify({ message: 'No commit found for SHA: nope' }), {
            status: 422,
          });
      },
      { ref: 'nope' },
    );
    expect(refNotFound.outcome).toMatchObject({ outcome: 'ref_not_found', ref: 'nope' });
    expect(hostCalls.some((u) => u.includes('/contents/'))).toBe(false);
    resolveReply = headReply;
    seen.set('ref_not_found', refNotFound.summary);

    const tooLarge = await outcomeFor(() => {
      reply = () =>
        new Response(JSON.stringify({ errors: [{ code: 'too_large' }] }), { status: 403 });
    });
    expect(tooLarge.outcome).toMatchObject({
      outcome: 'too_large',
      limitBytes: REPO_FILE_MAX_BYTES,
    });
    seen.set('too_large', tooLarge.summary);

    const unauthorized = await outcomeFor(() => {
      reply = () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    });
    expect(unauthorized.outcome).toMatchObject({ outcome: 'unauthorized' });
    seen.set('unauthorized', unauthorized.summary);

    hostCalls.length = 0;
    const invalidPath = await outcomeFor(() => undefined, { path: '../secrets.env' });
    expect(invalidPath.outcome).toMatchObject({
      outcome: 'invalid_path',
      path: '../secrets.env',
      reason: expect.any(String),
    });
    expect(hostCalls).toEqual([]);
    seen.set('invalid_path', invalidPath.summary);

    const unreachable = await outcomeFor(() => {
      reply = () => {
        throw new TypeError('fetch failed');
      };
    });
    expect(unreachable.outcome).toMatchObject({ outcome: 'unreachable', failure: 'unreachable' });
    seen.set('unreachable', unreachable.summary);

    // No App configured on this deployment: the mint throws, before any request.
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    _resetInstallationTokenCache();
    const providerUnavailable = await outcomeFor(() => undefined);
    expect(providerUnavailable.outcome).toMatchObject({
      outcome: 'provider_unavailable',
      repoRef: 'acme/alpha',
      detail: expect.any(String),
    });
    seen.set('provider_unavailable', providerUnavailable.summary);

    // A repository in the set whose connection lookup misses cannot be staged
    // through the realized set (realization IS a connected row), so the service's
    // own answer is substituted at its seam — the render is what is under test.
    vi.spyOn(repoFileReadService, 'readFile').mockResolvedValueOnce({
      outcome: 'repo_not_connected',
      repoRef: 'acme/alpha',
    });
    const notConnected = await outcomeFor(() => undefined);
    expect(notConnected.outcome).toEqual({ outcome: 'repo_not_connected', repoRef: 'acme/alpha' });
    seen.set('repo_not_connected', notConnected.summary);

    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  it('an outcome the tool does not know is named verbatim, not guessed at', () => {
    const { summary, structured } = renderReadFile({
      outcome: 'quarantined',
      repoRef: 'acme/alpha',
    } as never);
    expect(structured).toEqual({ outcome: 'quarantined', repoRef: 'acme/alpha' });
    expect(summary).toContain('"quarantined"');
  });

  // MOTIR-9868 — a listing the host cut at the cap says so, and tells the
  // reader an unlisted file is not thereby absent.
  it('a truncated directory listing ends in the TRUNCATED sentence', () => {
    const { summary, structured } = renderReadFile({
      outcome: 'directory',
      repoRef: 'acme/alpha',
      path: 'vendor',
      ref: 'main',
      entries: [
        { name: 'current', type: 'symlink' },
        { name: 'lib', type: 'dir' },
      ],
      truncated: true,
    });
    expect(structured).toMatchObject({ outcome: 'directory', truncated: true });
    expect(summary).toContain('current (symlink)\nlib/');
    expect(summary).toContain('[TRUNCATED — the host listed only the first 2 entries.');
    expect(summary).toContain('do NOT conclude a file is absent');
  });
});
