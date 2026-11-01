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
  CHANGED_FILES_RENDER_CAP,
  LIST_CHANGED_FILES_TOOL_NAME,
  renderListChangedFiles,
} from '@/lib/mcp/tools/listChangedFiles';
import { CHANGED_FILES_MAX } from '@/lib/git';
import { RepoNotInProjectError } from '@/lib/git/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { repoChangesService } from '@/lib/services/repoChangesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures';
import { linkAllWorkspaceReposIntoProject } from '../fixtures/codeContextFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `list_changed_files` (MOTIR-10069) over real Postgres — the PATHS a branch
// changed in a repository of the PROJECT's set, against its default branch or a
// named base, gated on `ai:plan`: the listing the hosted planner's
// `list_changed_files` makes, for an agent planning over the MCP.
//
// The git host is reached through the REAL GitHub provider with the global
// `fetch` stubbed — `read-file.test.ts`'s seam — so the token mint, the compare
// call and every status mapping are the shipped path. Workspace, project,
// installation, the project's repository set and every permission decision are
// the real Postgres path. The host-call count (every fetch that was NOT the token
// mint) is how "no provider call" is asserted.

const TOKEN = 'ghs_list_changed_files_secret';
const BASE_SHA = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
const MERGE_BASE_SHA = '9a2c6f1e0b1d7c4e5f3a8b9c0d1e2f3a4b5c6d7e';
const HEAD_SHA = '0328041d1152db8ae77652d1618a02e57f745f17';
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

/** A GitHub compare response, as the host sends it (trimmed): one added, one
 *  modified, one renamed — with a patch hunk the result must NOT carry. */
function compareBody(files: unknown[]) {
  return {
    base_commit: { sha: BASE_SHA },
    merge_base_commit: { sha: MERGE_BASE_SHA },
    status: 'ahead',
    commits: [{ sha: HEAD_SHA }],
    files,
  };
}
const threeFiles = () => [
  { filename: 'lib/new.ts', status: 'added', patch: '@@ +export const secretHunk = 1;' },
  { filename: 'lib/changed.ts', status: 'modified' },
  { filename: 'lib/after.ts', previous_filename: 'lib/before.ts', status: 'renamed' },
];

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
  const client = new Client({ name: 'list-changed-files-test', version: '0.0.0' });
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
      name: LIST_CHANGED_FILES_TOOL_NAME,
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

/** Two realized repositories (acme/alpha on `main`, acme/beta on `trunk`) in the project's set. */
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
  head: 'parent/ACME-7-story',
  ...extra,
});

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  hostCalls.length = 0;
  reply = () => json(compareBody(threeFiles()));
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

describe('list_changed_files — registered and permissioned', () => {
  it('tools/list names it, titled, read-only and OPEN-world; every declaration home carries it', async () => {
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === LIST_CHANGED_FILES_TOOL_NAME);
    expect(tool, 'list_changed_files is not registered').toBeTruthy();
    expect(tool!.title).toBe('List changed files');
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.openWorldHint).toBe(true);
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(
      ['base', 'head', 'projectKey', 'repo'].sort(),
    );
    expect(tool!.inputSchema.required).toEqual(
      expect.arrayContaining(['projectKey', 'repo', 'head']),
    );

    expect(MCP_TOOL_NAMES).toContain(LIST_CHANGED_FILES_TOOL_NAME);
    expect(TOOL_PERMISSIONS[LIST_CHANGED_FILES_TOOL_NAME]).toBe('ai:plan');
    expect(TOOL_SCOPES[LIST_CHANGED_FILES_TOOL_NAME]).toBe('read');
    expect(TOOL_ANNOTATIONS[LIST_CHANGED_FILES_TOOL_NAME]).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(EXEMPT_TOOLS).toHaveProperty(LIST_CHANGED_FILES_TOOL_NAME);
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

describe('list_changed_files — the listing', () => {
  it('lists the paths with status against the stored default branch, a rename with its old path', async () => {
    const res = await callTool(fx.ctx, args());
    expect(outcomeOf(res)).toEqual({
      outcome: 'ok',
      repoRef: 'acme/alpha',
      base: 'main',
      head: 'parent/ACME-7-story',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      files: [
        { path: 'lib/new.ts', status: 'added' },
        { path: 'lib/changed.ts', status: 'modified' },
        { path: 'lib/after.ts', status: 'renamed', previousPath: 'lib/before.ts' },
      ],
      truncated: false,
    });
    expect(hostCalls).toEqual([
      'https://api.github.com/repos/acme/alpha/compare/main...parent%2FACME-7-story',
    ]);
    const summary = summaryOf(res);
    expect(summary).toContain(
      'Branch parent/ACME-7-story in acme/alpha changes 3 files against main',
    );
    expect(summary).toContain('- renamed lib/after.ts (from lib/before.ts)');
    expect(summary).toContain('read_file { repo: "acme/alpha", path, ref: "parent/ACME-7-story" }');
    // Names only: no patch hunk, no credential, no host URL.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('secretHunk');
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('api.github.com');

    // The other repository's default branch is ITS row's, not a global `main`.
    hostCalls.length = 0;
    expect(outcomeOf(await callTool(fx.ctx, args({ repo: 'beta' })))['base']).toBe('trunk');
    expect(hostCalls[0]).toContain('/compare/trunk...');
  });

  it('compares against a NAMED base, and resolves owner/name case-insensitively', async () => {
    const out = outcomeOf(
      await callTool(fx.ctx, args({ repo: 'ACME/Alpha', base: 'release/1.0', head: 'feat/x' })),
    );
    expect(out).toMatchObject({
      outcome: 'ok',
      repoRef: 'acme/alpha',
      base: 'release/1.0',
      head: 'feat/x',
    });
    expect(hostCalls[0]).toBe(
      'https://api.github.com/repos/acme/alpha/compare/release%2F1.0...feat%2Fx',
    );
  });

  it('one changed file reads in the singular', async () => {
    reply = () => json(compareBody([{ filename: 'lib/one.ts', status: 'removed' }]));
    const res = await callTool(fx.ctx, args());
    expect(summaryOf(res)).toContain('changes 1 file against main');
    expect(summaryOf(res)).toContain('- removed lib/one.ts');
  });

  it('a list AT the host’s cap is truncated, says AT LEAST, and ends with the SENTENCE', async () => {
    const many = Array.from({ length: CHANGED_FILES_MAX }, (_, i) => ({
      filename: `f/${i}.ts`,
      status: 'modified',
    }));
    reply = () => json(compareBody(many));
    const res = await callTool(fx.ctx, args());
    const out = outcomeOf(res);
    expect(out['truncated']).toBe(true);
    expect((out['files'] as unknown[]).length).toBe(CHANGED_FILES_RENDER_CAP);
    const summary = summaryOf(res);
    expect(summary).toContain(`changes at least ${CHANGED_FILES_MAX} files`);
    expect(summary).toMatch(
      /\[TRUNCATED — the list stopped after 300 paths\. .*to check it directly\.\]$/,
    );
  });

  it('an identical pair is ok with no files — a fact about the BRANCH', async () => {
    reply = () => json({ ...compareBody([]), commits: [], status: 'identical' });
    const res = await callTool(fx.ctx, args());
    expect(outcomeOf(res)).toMatchObject({ outcome: 'ok', files: [], truncated: false });
    expect(summaryOf(res)).toContain('changes NO files against main');
    expect(summaryOf(res)).toContain('not about the repository');
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

  it('a project with no repository set says so, and the host is never asked', async () => {
    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BARE' });
    const res = await callTool(bare.ctx, {
      projectKey: bare.projectIdentifier,
      repo: 'alpha',
      head: 'feat/x',
    });
    expect(outcomeOf(res)).toEqual({ outcome: 'repo_not_in_project', repo: 'alpha', repoSet: [] });
    expect(summaryOf(res)).toContain('none — no repository is connected to it');
    expect(hostCalls).toEqual([]);
  });
});

describe('list_changed_files — every absence is its own named, non-error result', () => {
  async function outcomeFor(
    arrange: () => void,
  ): Promise<{ outcome: Record<string, unknown>; summary: string }> {
    arrange();
    const res = await callTool(fx.ctx, args());
    return { outcome: outcomeOf(res), summary: summaryOf(res) };
  }
  const refs = { repoRef: 'acme/alpha', base: 'main', head: 'parent/ACME-7-story' };

  it('no_such_ref · revoked · too_large · host_error · not_connected · repo_not_connected', async () => {
    const seen = new Map<string, string>();

    const noRef = await outcomeFor(() => {
      reply = () => json({ message: 'Not Found' }, 404);
    });
    expect(noRef.outcome).toEqual({ outcome: 'no_such_ref', ...refs });
    expect(noRef.summary).toContain('re-read the item with get_work_item');
    seen.set('no_such_ref', noRef.summary);

    const revoked = await outcomeFor(() => {
      reply = () => json({ message: 'Bad credentials' }, 401);
    });
    expect(revoked.outcome).toEqual({ outcome: 'revoked', ...refs });
    seen.set('revoked', revoked.summary);

    const tooLarge = await outcomeFor(() => {
      reply = () => json({ message: 'Server Error: Sorry, this diff is taking too long.' }, 422);
    });
    expect(tooLarge.outcome).toEqual({ outcome: 'too_large', ...refs });
    expect(tooLarge.summary).toContain('The branch EXISTS');
    seen.set('too_large', tooLarge.summary);

    const hostError = await outcomeFor(() => {
      reply = () => new Response('bad gateway', { status: 502 });
    });
    expect(hostError.outcome).toEqual({
      outcome: 'host_error',
      ...refs,
      detail: 'GitHub compare returned 502',
    });
    expect(hostError.summary).toContain('failure to ASK');
    seen.set('host_error', hostError.summary);

    // A REFUSED CONNECTION: the App is not configured on this deployment.
    const notConnected = await outcomeFor(() => {
      reply = () => json(compareBody(threeFiles()));
      _resetInstallationTokenCache();
      vi.stubEnv('GITHUB_APP_ID', '');
      vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    });
    expect(notConnected.outcome).toEqual({ outcome: 'not_connected', ...refs });
    seen.set('not_connected', notConnected.summary);

    // In the realized set yet not resolvable to a CONNECTED row: unreachable
    // through the realized set (realization IS a connected row), so the service's
    // own throw is substituted at its seam — `read-file.test.ts`'s precedent; the
    // service's mapping and the render are what is under test.
    vi.spyOn(repoChangesService, 'listChangedFiles').mockRejectedValueOnce(
      new RepoNotInProjectError('acme/alpha'),
    );
    const notInOrg = await outcomeFor(() => undefined);
    expect(notInOrg.outcome).toEqual({
      outcome: 'repo_not_connected',
      repoRef: 'acme/alpha',
      base: null,
      head: 'parent/ACME-7-story',
    });
    seen.set('repo_not_connected', notInOrg.summary);

    expect(new Set(seen.values()).size).toBe(seen.size);
  });

  it('a repo_not_connected answer echoes a named base', async () => {
    vi.spyOn(repoChangesService, 'listChangedFiles').mockRejectedValueOnce(
      new RepoNotInProjectError('acme/alpha'),
    );
    const out = outcomeOf(await callTool(fx.ctx, args({ base: ' release ' })));
    expect(out).toMatchObject({ outcome: 'repo_not_connected', base: 'release' });
  });

  it('any OTHER service failure is the door’s error, never a named outcome', async () => {
    vi.spyOn(repoChangesService, 'listChangedFiles').mockRejectedValueOnce(new Error('boom'));
    const res = await callTool(fx.ctx, args());
    expect(res.isError).toBe(true);
  });

  it('a truncated but EMPTY list says nothing can be concluded', () => {
    const { summary, structured } = renderListChangedFiles({
      outcome: 'ok',
      repoRef: 'acme/alpha',
      base: 'main',
      head: 'feat/x',
      files: [],
      truncated: true,
      baseSha: null,
      headSha: null,
    });
    expect(structured).toMatchObject({ outcome: 'ok', truncated: true, files: [] });
    expect(summary).toContain('truncated but EMPTY change list');
    expect(summary).not.toContain('(head');
  });

  it('a list longer than the render cap is cut to it even when the host did not flag it', () => {
    const files = Array.from({ length: CHANGED_FILES_RENDER_CAP + 5 }, (_, i) => ({
      path: `f/${i}.ts`,
      status: 'added' as const,
    }));
    const { summary, structured } = renderListChangedFiles({
      outcome: 'ok',
      repoRef: 'acme/alpha',
      base: 'main',
      head: 'feat/x',
      files,
      truncated: false,
      baseSha: null,
      headSha: HEAD_SHA,
    });
    expect((structured['files'] as unknown[]).length).toBe(CHANGED_FILES_RENDER_CAP);
    expect(structured['truncated']).toBe(true);
    expect(summary).toContain(`(head ${HEAD_SHA.slice(0, 7)}, base unknown)`);
    expect(summary).toContain('[TRUNCATED');
  });

  it('a host_error with no detail still says so', () => {
    const { summary } = renderListChangedFiles({
      outcome: 'host_error',
      repoRef: 'acme/alpha',
      base: 'main',
      head: 'feat/x',
      detail: '',
    });
    expect(summary).toContain('(no detail)');
  });

  it('an outcome the tool does not know is named verbatim, not guessed at', () => {
    const { summary, structured } = renderListChangedFiles({
      outcome: 'quarantined',
      repoRef: 'acme/alpha',
      base: 'main',
      head: 'feat/x',
    } as never);
    expect(structured).toEqual({
      outcome: 'quarantined',
      repoRef: 'acme/alpha',
      base: 'main',
      head: 'feat/x',
    });
    expect(summary).toContain('"quarantined"');
  });
});
