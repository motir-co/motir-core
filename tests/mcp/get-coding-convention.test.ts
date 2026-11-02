import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  RawCodeAuditSurface,
  RawConvention,
  RawConventionSurface,
} from '@/lib/ai/motirAiClient';

// `get_coding_convention` (Story MOTIR-9079 · Subtask MOTIR-9083) over real Postgres —
// ONE repository's current coding convention in full, gated on `ai:plan`.
//
// The motir-ai HTTP client is stubbed at its module seam — the one sanctioned
// boundary mock, exactly as `tests/code-health-page.test.ts` does it. Workspace,
// project, repositories, the project's repository set and every permission
// decision are the real Postgres path.
//
// What it pins: the text is returned in full and byte-for-byte; an edited version
// names its editor and a derived one says so; none / outside-the-set / unavailable
// are named non-error results; the permission is `ai:plan` at the door and in the
// service; and a `motir run` token (the CLI grant) reaches it.

const getCodeAuditMock = vi.fn<(q: Record<string, unknown>) => Promise<RawCodeAuditSurface>>();
const getConventionMock = vi.fn<(q: Record<string, unknown>) => Promise<RawConventionSurface>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: (q: Record<string, unknown>) => getCodeAuditMock(q),
  getConvention: (q: Record<string, unknown>) => getConventionMock(q),
  refreshCodeAudit: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { buildMcpServer, MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { EXEMPT_TOOLS } = await import('@/lib/mcp/payloads/exemptions');
const { isBillableTool } = await import('@/lib/mcp/rateLimitGate');
const { PERMISSION_NOT_GRANTED_CODE } = await import('@/lib/mcp/permissionGate');
const { GET_CODING_CONVENTION_TOOL_NAME } = await import('@/lib/mcp/tools/getCodingConvention');
const { GRANTABLE_PERMISSIONS, UNGRANTABLE_PERMISSIONS } = await import('@/lib/tokens/grant');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { keyForAppend } = await import('@/lib/workItems/positioning');
const { createTestUser, makeWorkItemFixture } = await import('../fixtures');
const { linkAllWorkspaceReposIntoProject } = await import('../fixtures/codeContextFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { addToProjectAs } = await import('../helpers/workspaceRoleFixtures');

import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const text = (r: CallToolResult) => JSON.stringify(r.content);

const REPO_A = 'acme/alpha';
const REPO_B = 'acme/beta';

/** Connect an in-memory client to a server bound to `ctx`, optionally behind a token grant. */
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
  const client = new Client({ name: 'get-coding-convention-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(
  ctx: ServiceContext,
  args: Record<string, unknown>,
  grant?: readonly PermissionKey[],
  name: string = GET_CODING_CONVENTION_TOOL_NAME,
): Promise<CallToolResult> {
  const client = await connectClient(ctx, grant);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function rawConvention(repoKey: string, over: Partial<RawConvention> = {}): RawConvention {
  return {
    id: `conv_${repoKey}`,
    aiProjectId: 'ai_1',
    repoKey,
    version: 3,
    contentMd: `# ${repoKey} house rules\n\n- Routes call one service.\n`,
    provenance: [],
    sourceAuditId: 'audit_1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  } as RawConvention;
}

const surfaceOf = (row: RawConvention): RawConventionSurface => ({
  convention: row,
  versions: [row],
  nextCursor: null,
});

const EMPTY_CONVENTION: RawConventionSurface = { convention: null, versions: [], nextCursor: null };

/** Two realized repositories in the project's set, plus one PROPOSED row (no repository yet). */
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
      defaultBranch: 'main',
      archived: false,
    })),
  });
  await linkAllWorkspaceReposIntoProject({ ...fx.ctx, projectId: fx.projectId });
  const last = await adminDb.projectRepo.findFirst({
    where: { projectId: fx.projectId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: null,
      role: 'api',
      name: 'gamma-not-created-yet',
      seedSource: 'blank',
      state: 'proposed',
      position: keyForAppend(last?.position ?? null),
    },
  });
}

/** A workspace member on a given built-in role, added to the fixture's project. */
async function actorWithRole(
  fx: WorkItemFixture,
  role: 'member' | 'viewer',
): Promise<ServiceContext> {
  const user = await createTestUser({ name: role });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

beforeEach(async () => {
  await truncateAuthTables();
  getCodeAuditMock.mockReset();
  getConventionMock.mockReset();
  getConventionMock.mockResolvedValue(EMPTY_CONVENTION);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ARGS = (fx: WorkItemFixture, repo = 'alpha') => ({ projectKey: fx.projectIdentifier, repo });
const structured = (res: CallToolResult) => {
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as Record<string, unknown>;
};

describe('get_coding_convention — registered, permissioned, documented', () => {
  it('tools/list names it, titled and read-only', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === GET_CODING_CONVENTION_TOOL_NAME);
    expect(tool, 'get_coding_convention is not registered').toBeTruthy();
    expect(tool!.title).toBe('Get coding convention');
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.openWorldHint).toBe(false);
  });

  it('every declaration home carries it, on ai:plan, and the CLI grant already holds the key', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_CODING_CONVENTION_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_CODING_CONVENTION_TOOL_NAME]).toBe('ai:plan');
    expect(TOOL_SCOPES[GET_CODING_CONVENTION_TOOL_NAME]).toBe('read');
    expect(EXEMPT_TOOLS).toHaveProperty(GET_CODING_CONVENTION_TOOL_NAME);
    expect(isBillableTool(GET_CODING_CONVENTION_TOOL_NAME)).toBe(false);
    expect(CLI_TOKEN_GRANT).toContain('ai:plan');
    // The READ stays on `ai:plan`; `ai:configure` is the WRITE's key
    // (`update_coding_convention`, MOTIR-10183) and the CLI grant never holds it.
    expect(CLI_TOKEN_GRANT).not.toContain('ai:configure');
    expect(GRANTABLE_PERMISSIONS).toContain('ai:configure');
    expect(UNGRANTABLE_PERMISSIONS).not.toContain('ai:configure');
  });

  it('the design build script carries it (docs/mcp.md is held by mcp-doc-guards)', () => {
    expect(read('design/mcp-server/build.py')).toContain(`"${GET_CODING_CONVENTION_TOOL_NAME}":`);
  });
});

describe('get_coding_convention — the answer', () => {
  it('returns a DERIVED convention in full, byte-for-byte, headed by repo, version and "derived"', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const row = rawConvention(REPO_A);
    getConventionMock.mockResolvedValue(surfaceOf(row));

    const res = await callTool(fx.ctx, ARGS(fx));
    const s = structured(res);

    expect(s).toMatchObject({
      state: 'present',
      repoRef: REPO_A,
      version: 3,
      authorKind: 'derived',
      editedByName: null,
      pendingDerived: false,
      contentMd: row.contentMd,
    });
    const summary = (res.content[0] as { text: string }).text;
    expect(summary.startsWith(`${REPO_A} · coding convention v3 · derived\n\n`)).toBe(true);
    expect(summary.endsWith(row.contentMd)).toBe(true);
    expect(getConventionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        coreWorkspaceId: fx.workspaceId,
        coreProjectId: fx.projectId,
        repoKey: REPO_A,
      }),
    );
  });

  it('an EDITED version names its editor and the date, and flags a waiting derived document', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const editor = await createTestUser({ name: 'Yue' });
    const row = rawConvention(REPO_A, {
      version: 4,
      authorKind: 'edited',
      editedByUserId: editor.id,
      pendingDerivedMd: '# newer derived text',
      createdAt: '2026-10-19T09:30:00.000Z',
    });
    getConventionMock.mockResolvedValue(surfaceOf(row));

    const res = await callTool(fx.ctx, ARGS(fx));
    const s = structured(res);

    expect(s).toMatchObject({
      state: 'present',
      version: 4,
      authorKind: 'edited',
      editedByName: 'Yue',
      editedByUserId: editor.id,
      pendingDerived: true,
      contentMd: row.contentMd,
    });
    // The text in force is the person's, never the parked derived one.
    expect((res.content[0] as { text: string }).text).toContain(
      `${REPO_A} · coding convention v4 · edited by Yue on 2026-10-19`,
    );
    expect(text(res)).not.toContain('newer derived text');
  });

  it('resolves the repo the way read_file does: bare name, owner/name, any case', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    getConventionMock.mockResolvedValue(surfaceOf(rawConvention(REPO_B)));

    for (const repo of ['beta', 'acme/beta', 'ACME/Beta']) {
      getConventionMock.mockClear();
      const s = structured(await callTool(fx.ctx, ARGS(fx, repo)));
      expect(s['repoRef']).toBe(REPO_B);
      expect(getConventionMock).toHaveBeenCalledWith(expect.objectContaining({ repoKey: REPO_B }));
    }
  });

  it('a repository with no convention is an explicit "no convention recorded" result, not an error', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const res = await callTool(fx.ctx, ARGS(fx));

    expect(structured(res)).toEqual({ state: 'absent', repoRef: REPO_A });
    expect(text(res)).toContain('No convention recorded');
  });

  it('a repository outside the set returns the set, and never reaches motir-ai', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const res = await callTool(fx.ctx, ARGS(fx, 'gamma-not-created-yet'));

    expect(structured(res)).toEqual({
      state: 'repo_not_in_project',
      repo: 'gamma-not-created-yet',
      repoSet: [REPO_A, REPO_B],
    });
    expect(text(res)).toContain('acme/alpha');
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('a motir-ai failure is a named unavailable result, not "none recorded"', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    getConventionMock.mockRejectedValue(new MotirAiUnavailableError('connection refused'));

    const res = await callTool(fx.ctx, ARGS(fx));

    expect(structured(res)).toEqual({
      state: 'unavailable',
      repoRef: REPO_A,
      code: 'MOTIR_AI_UNAVAILABLE',
    });
  });
});

describe('get_coding_convention — who may read it', () => {
  it('a token whose grant lacks ai:plan is refused at the door, before any read', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const denied = await callTool(
      fx.ctx,
      ARGS(fx),
      GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
    );

    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text(denied)).toContain('ai:plan');
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('a CLI-minted token (the CLI grant) reads it', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    getConventionMock.mockResolvedValue(surfaceOf(rawConvention(REPO_A)));

    const s = structured(await callTool(fx.ctx, ARGS(fx), CLI_TOKEN_GRANT));

    expect(s['state']).toBe('present');
  });

  it('an actor whose ROLE lacks ai:plan is refused by the service', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const viewer = await actorWithRole(fx, 'viewer');

    const denied = await callTool(viewer, ARGS(fx));

    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('PERMISSION_DENIED');
    expect(text(denied)).toContain('ai:plan');
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('a Member — who holds ai:plan and NOT ai:configure — reads it', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const member = await actorWithRole(fx, 'member');
    getConventionMock.mockResolvedValue(surfaceOf(rawConvention(REPO_A)));

    expect(structured(await callTool(member, ARGS(fx)))['state']).toBe('present');
  });

  it('a key from another workspace reads as not-found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await seedRepoSet(other);

    const res = await callTool(fx.ctx, { projectKey: other.projectIdentifier, repo: 'alpha' });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PROJECT_NOT_FOUND');
    expect(getConventionMock).not.toHaveBeenCalled();
  });
});
