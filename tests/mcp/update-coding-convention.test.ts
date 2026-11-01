import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RawConvention, RawConventionSurface } from '@/lib/ai/motirAiClient';

// `update_coding_convention` (MOTIR-10183) over real Postgres — the /code editor's
// convention save, on the MCP, gated on `ai:configure`.
//
// The motir-ai HTTP client is stubbed at its module seam — the one sanctioned
// boundary mock, as `tests/mcp/get-coding-convention.test.ts` does it — by a small
// in-memory convention store that behaves like motir-ai's: a save appends an
// `edited` version, and a save whose `baseVersion` is not the current version is
// refused with the conflict carrying the version that won. Workspace, project,
// repositories, the repository set, the token grant and every permission decision
// are the real Postgres path.
//
// What it pins, criterion by criterion: the tool's arguments and its adapter (1);
// `ai:configure` at the door AND in the role, nothing written on a refusal (2); the
// stale-version conflict with what won, the blank and too-long refusals the editor
// gets (3); the person behind the token as the version's author, in the editor's
// history (4); `get_coding_convention` reading the new text right after (5); and
// every declaration home (6) — its documentation half is
// `tests/mcp/update-coding-convention-docs.test.ts`, which the docs-guard lane runs.

const getConventionMock = vi.fn<(q: Record<string, unknown>) => Promise<RawConventionSurface>>();
const putConventionMock = vi.fn<(i: Record<string, unknown>) => Promise<RawConvention>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getCodeAudit: vi.fn(),
  getConvention: (q: Record<string, unknown>) => getConventionMock(q),
  putConvention: (i: Record<string, unknown>) => putConventionMock(i),
  refreshCodeAudit: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { buildMcpServer, MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { TOOL_ANNOTATIONS } = await import('@/lib/mcp/toolAnnotations');
const { EXEMPT_TOOLS } = await import('@/lib/mcp/payloads/exemptions');
const { isBillableTool } = await import('@/lib/mcp/rateLimitGate');
const { PERMISSION_NOT_GRANTED_CODE } = await import('@/lib/mcp/permissionGate');
const { UPDATE_CODING_CONVENTION_TOOL_NAME, renderSavedConvention, conventionConflictResult } =
  await import('@/lib/mcp/tools/updateCodingConvention');
const { McpMissingContextError } = await import('@/lib/mcp/context');
const { GET_CODING_CONVENTION_TOOL_NAME } = await import('@/lib/mcp/tools/getCodingConvention');
const { mcpToolRows } = await import('@/lib/apiDocs/mcp');
const { MCP_TOOL_INPUT_SCHEMAS } = await import('@/lib/apiDocs/mcpToolSchemas');
const { GRANTABLE_PERMISSIONS, DEFAULT_TOKEN_GRANT, grantableFor } =
  await import('@/lib/tokens/grant');
const { CONVENTION_MAX_CHARS, aiConventionService } =
  await import('@/lib/services/aiConventionService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { MotirAiConventionConflictError, MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { toToolError } = await import('@/lib/mcp/toolResult');
const { ConventionBlankError, ConventionVersionConflictError } =
  await import('@/lib/codeHealth/errors');
const { createTestUser, makeWorkItemFixture } = await import('../fixtures');
const { linkAllWorkspaceReposIntoProject } = await import('../fixtures/codeContextFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { addToProjectAs } = await import('../helpers/workspaceRoleFixtures');

import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';

const text = (r: CallToolResult) => JSON.stringify(r.content);

const REPO_A = 'acme/alpha';

// ── The fake motir-ai convention store ──────────────────────────────────────
// Versions per repoKey, newest LAST. The current version is the last one.
let store: Map<string, RawConvention[]>;

function row(repoKey: string, version: number, over: Partial<RawConvention> = {}): RawConvention {
  return {
    id: `conv_${repoKey}_${version}`,
    aiProjectId: 'ai_1',
    repoKey,
    version,
    contentMd: `# ${repoKey} v${version}\n`,
    provenance: [],
    sourceAuditId: null,
    createdAt: `2026-10-${String(10 + version).padStart(2, '0')}T09:00:00.000Z`,
    updatedAt: `2026-10-${String(10 + version).padStart(2, '0')}T09:00:00.000Z`,
    ...over,
  } as RawConvention;
}

function installFakeStore(): void {
  getConventionMock.mockImplementation(async (q) => {
    const versions = store.get(String(q['repoKey'])) ?? [];
    return {
      convention: versions.at(-1) ?? null,
      versions: [...versions].reverse(),
      nextCursor: null,
    };
  });
  putConventionMock.mockImplementation(async (i) => {
    const repoKey = String(i['repoKey']);
    const versions = store.get(repoKey) ?? [];
    const current = versions.at(-1)?.version ?? 0;
    if (i['baseVersion'] !== current) throw new MotirAiConventionConflictError(current);
    const saved = row(repoKey, current + 1, {
      contentMd: String(i['contentMd']),
      authorKind: 'edited',
      editedByUserId: String(i['editedByUserId']),
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    store.set(repoKey, [...versions, saved]);
    return saved;
  });
}

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
  const client = new Client({ name: 'update-coding-convention-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(
  ctx: ServiceContext,
  args: Record<string, unknown>,
  grant?: readonly PermissionKey[],
  name: string = UPDATE_CODING_CONVENTION_TOOL_NAME,
): Promise<CallToolResult> {
  const client = await connectClient(ctx, grant);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

/** One realized repository, `acme/alpha`, in the project's set. */
async function seedRepoSet(fx: WorkItemFixture): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: `inst-${fx.workspaceId}`,
      accountLogin: 'acme',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: `repo-alpha-${fx.workspaceId}`,
        owner: 'acme',
        name: 'alpha',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  await linkAllWorkspaceReposIntoProject({ ...fx.ctx, projectId: fx.projectId });
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
  store = new Map();
  getConventionMock.mockReset();
  putConventionMock.mockReset();
  installFakeStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SAVE = (fx: WorkItemFixture, over: Record<string, unknown> = {}) => ({
  projectKey: fx.projectIdentifier,
  repo: 'alpha',
  contentMd: '# House rules\n\n- Routes call one service.\n',
  baseVersion: 2,
  ...over,
});
const structured = (res: CallToolResult) => {
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as Record<string, unknown>;
};
/** The current version a fixture's repository starts at: v2, derived. */
const seedTwoVersions = () =>
  store.set(REPO_A, [row(REPO_A, 1), row(REPO_A, 2, { contentMd: '# Derived v2\n' })]);

describe('update_coding_convention — registered, permissioned, documented (AC 1, 6)', () => {
  it('tools/list names it, titled, a write that is additive and not idempotent', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === UPDATE_CODING_CONVENTION_TOOL_NAME);
    expect(tool, 'update_coding_convention is not registered').toBeTruthy();
    expect(tool!.title).toBe('Update coding convention');
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(Object.keys(tool!.inputSchema.properties ?? {}).sort()).toEqual(
      ['baseVersion', 'contentMd', 'projectKey', 'repo'].sort(),
    );
    expect(tool!.inputSchema.required?.slice().sort()).toEqual(
      ['baseVersion', 'contentMd', 'projectKey', 'repo'].sort(),
    );
  });

  it('every declaration home carries it, on ai:configure, outside the CLI grant', () => {
    expect(MCP_TOOL_NAMES).toContain(UPDATE_CODING_CONVENTION_TOOL_NAME);
    expect(TOOL_PERMISSIONS[UPDATE_CODING_CONVENTION_TOOL_NAME]).toBe('ai:configure');
    expect(TOOL_SCOPES[UPDATE_CODING_CONVENTION_TOOL_NAME]).toBe('work_items:write');
    expect(TOOL_ANNOTATIONS[UPDATE_CODING_CONVENTION_TOOL_NAME].readOnlyHint).toBe(false);
    expect(EXEMPT_TOOLS).toHaveProperty(UPDATE_CODING_CONVENTION_TOOL_NAME);
    expect(mcpToolRows().map((r) => r.name)).toContain(UPDATE_CODING_CONVENTION_TOOL_NAME);
    expect(MCP_TOOL_INPUT_SCHEMAS[UPDATE_CODING_CONVENTION_TOOL_NAME]).toBeTruthy();
    // A save starts no model job, so it spends no AI rate budget.
    expect(isBillableTool(UPDATE_CODING_CONVENTION_TOOL_NAME)).toBe(false);
    // The tool is what makes the key grantable — and a `motir run` token never holds it.
    expect(GRANTABLE_PERMISSIONS).toContain('ai:configure');
    expect(CLI_TOKEN_GRANT).not.toContain('ai:configure');
  });
});

describe('update_coding_convention — the save (AC 1, 4, 5)', () => {
  it('writes a new edited version through the editor’s save, authored by the person behind the token', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    seedTwoVersions();

    const res = await callTool(fx.ctx, SAVE(fx));
    const s = structured(res);

    expect(putConventionMock).toHaveBeenCalledTimes(1);
    expect(putConventionMock).toHaveBeenCalledWith({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      repoKey: REPO_A,
      contentMd: SAVE(fx).contentMd,
      editedByUserId: fx.ctx.userId,
      baseVersion: 2,
    });
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
    expect(s).toMatchObject({
      state: 'saved',
      repoRef: REPO_A,
      version: 3,
      authorKind: 'edited',
      editedByUserId: fx.ctx.userId,
      editedByName: owner.name,
      contentMd: SAVE(fx).contentMd,
    });
    expect((res.content[0] as { text: string }).text).toBe(
      `Saved ${REPO_A} · coding convention v3 · edited by ${owner.name} on 2026-11-01.`,
    );
  });

  it('get_coding_convention returns the new text and version right after, and the editor’s history shows it', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    seedTwoVersions();
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });

    structured(await callTool(fx.ctx, SAVE(fx, { repo: 'ACME/Alpha' })));
    const after = structured(
      await callTool(
        fx.ctx,
        { projectKey: fx.projectIdentifier, repo: 'alpha' },
        undefined,
        GET_CODING_CONVENTION_TOOL_NAME,
      ),
    );

    expect(after).toMatchObject({
      state: 'present',
      repoRef: REPO_A,
      version: 3,
      authorKind: 'edited',
      editedByName: owner.name,
      contentMd: SAVE(fx).contentMd,
    });
    // The /code editor's own read: the MCP save is a version in its history, by name.
    const surface = await aiConventionService.getConvention(fx.projectId, fx.ctx, {
      repoKey: REPO_A,
    });
    expect(surface.versions.map((v) => [v.version, v.authorKind, v.editedByName])).toEqual([
      [3, 'edited', owner.name],
      [2, 'derived', null],
      [1, 'derived', null],
    ]);
  });

  it('a first convention is written on baseVersion 0', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const s = structured(await callTool(fx.ctx, SAVE(fx, { baseVersion: 0 })));

    expect(s).toMatchObject({ state: 'saved', repoRef: REPO_A, version: 1 });
  });

  it('a repository outside the set returns the set and never reaches motir-ai', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const res = await callTool(fx.ctx, SAVE(fx, { repo: 'not-a-repo' }));

    expect(structured(res)).toEqual({
      state: 'repo_not_in_project',
      repo: 'not-a-repo',
      repoSet: [REPO_A],
    });
    expect(text(res)).toContain('Nothing was written');
    expect(putConventionMock).not.toHaveBeenCalled();
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('a save motir-ai answers with no re-read convention is still reported saved', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    putConventionMock.mockResolvedValue(row(REPO_A, 1));
    getConventionMock.mockResolvedValue({ convention: null, versions: [], nextCursor: null });

    const res = await callTool(fx.ctx, SAVE(fx, { baseVersion: 0 }));

    expect(structured(res)).toEqual({ state: 'saved', repoRef: REPO_A });
    expect(text(res)).toContain('call get_coding_convention');
  });

  it('a motir-ai failure is an error result naming its code', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    putConventionMock.mockRejectedValue(new MotirAiUnavailableError('connection refused'));

    const res = await callTool(fx.ctx, SAVE(fx, { baseVersion: 0 }));

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('MOTIR_AI_UNAVAILABLE');
  });
});

describe('update_coding_convention — the editor’s refusals, nothing written (AC 3)', () => {
  it('a stale baseVersion returns the conflict with the version that won, and overwrites nothing', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const editor = await createTestUser({ name: 'Yue' });
    store.set(REPO_A, [
      row(REPO_A, 1),
      row(REPO_A, 2),
      row(REPO_A, 3, {
        contentMd: '# Saved by Yue\n',
        authorKind: 'edited',
        editedByUserId: editor.id,
        createdAt: '2026-10-31T08:00:00.000Z',
      }),
    ]);

    const res = await callTool(fx.ctx, SAVE(fx, { baseVersion: 2 }));

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('CONVENTION_VERSION_CONFLICT');
    expect(text(res)).toContain('edited by Yue on 2026-10-31');
    expect(text(res)).toContain('send baseVersion 3');
    expect(res.structuredContent).toEqual({
      code: 'CONVENTION_VERSION_CONFLICT',
      repoRef: REPO_A,
      latestVersion: 3,
      latest: {
        version: 3,
        authorKind: 'edited',
        editedByName: 'Yue',
        editedByUserId: editor.id,
        updatedAt: '2026-10-31T08:00:00.000Z',
        contentMd: '# Saved by Yue\n',
      },
    });
    expect(store.get(REPO_A)!.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(store.get(REPO_A)!.at(-1)!.contentMd).toBe('# Saved by Yue\n');
  });

  it('a conflict against a derived version names it derived', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    seedTwoVersions();

    const res = await callTool(fx.ctx, SAVE(fx, { baseVersion: 1 }));

    expect(text(res)).toContain('The convention is at v2 (derived)');
    expect((res.structuredContent as { latest: { authorKind: string } }).latest.authorKind).toBe(
      'derived',
    );
  });

  it('a blank body is CONVENTION_BLANK and never reaches motir-ai', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const res = await callTool(fx.ctx, SAVE(fx, { contentMd: '  \n\t ' }));

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('CONVENTION_BLANK');
    expect(putConventionMock).not.toHaveBeenCalled();
  });

  it('an oversized body is CONVENTION_TOO_LONG and never reaches motir-ai', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const res = await callTool(
      fx.ctx,
      SAVE(fx, { contentMd: 'x'.repeat(CONVENTION_MAX_CHARS + 1) }),
    );

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('CONVENTION_TOO_LONG');
    expect(text(res)).toContain(String(CONVENTION_MAX_CHARS));
    expect(putConventionMock).not.toHaveBeenCalled();
  });

  it('a negative or fractional baseVersion is refused by the schema', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    for (const baseVersion of [-1, 1.5]) {
      const res = await callTool(fx.ctx, SAVE(fx, { baseVersion }));
      expect(res.isError, `baseVersion ${baseVersion}`).toBe(true);
    }
    expect(putConventionMock).not.toHaveBeenCalled();
  });

  it('the shared error mapper names the convention refusals for any other caller', () => {
    expect(text(toToolError(new ConventionBlankError()))).toContain('CONVENTION_BLANK');
    const conflict = new ConventionVersionConflictError(4, {
      repoKey: REPO_A,
      convention: null,
      versions: [],
      nextCursor: null,
    });
    const res = toToolError(conflict);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('CONVENTION_VERSION_CONFLICT');
    expect(text(res)).toContain('v4');
  });
});

describe('update_coding_convention — who may write it (AC 2)', () => {
  it('a token whose grant lacks ai:configure is refused at the door, and nothing is written', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const denied = await callTool(
      fx.ctx,
      SAVE(fx),
      GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:configure'),
    );

    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text(denied)).toContain('ai:configure');
    expect(putConventionMock).not.toHaveBeenCalled();
    expect(getConventionMock).not.toHaveBeenCalled();
  });

  it('a CLI-minted token (the `motir run` grant) is refused at the door', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const denied = await callTool(fx.ctx, SAVE(fx), CLI_TOKEN_GRANT);

    expect(text(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(putConventionMock).not.toHaveBeenCalled();
  });

  it('a Member — who holds ai:plan and NOT ai:configure — is refused by the service, with a key in the grant', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const member = await actorWithRole(fx, 'member');

    const denied = await callTool(member, SAVE(fx), GRANTABLE_PERMISSIONS);

    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('PERMISSION_DENIED');
    expect(text(denied)).toContain('ai:configure');
    expect(putConventionMock).not.toHaveBeenCalled();
    // Refused before the repository set is read: the refusal reveals nothing.
    expect(text(denied)).not.toContain(REPO_A);
  });

  it('a key from another workspace reads as not-found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await seedRepoSet(other);

    const res = await callTool(fx.ctx, SAVE(fx, { projectKey: other.projectIdentifier }));

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PROJECT_NOT_FOUND');
    expect(putConventionMock).not.toHaveBeenCalled();
  });

  it('an admin can mint a project token carrying ai:configure, and that token writes; a member cannot confer it', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    seedTwoVersions();
    const member = await actorWithRole(fx, 'member');

    const adminOffer = grantableFor(
      await projectAccessService.getPermissions(fx.projectId, fx.ctx),
    );
    const memberOffer = grantableFor(
      await projectAccessService.getPermissions(fx.projectId, member),
    );
    expect(adminOffer).toContain('ai:configure');
    expect(memberOffer).not.toContain('ai:configure');
    expect(DEFAULT_TOKEN_GRANT).toContain('ai:configure');

    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'convention-editor',
      projectId: fx.projectId,
      permissions: ['project:browse', 'ai:configure'],
    });
    const verified = await apiTokensService.verify(token);
    expect(verified.grant).toContain('ai:configure');

    const s = structured(await callTool(fx.ctx, SAVE(fx), verified.grant));
    expect(s).toMatchObject({ state: 'saved', version: 3, editedByUserId: fx.ownerId });

    await expect(
      apiTokensService.create(member.userId, fx.workspaceId, {
        label: 'not-mine-to-give',
        projectId: fx.projectId,
        permissions: ['project:browse', 'ai:configure'],
      }),
    ).rejects.toThrow();
  });
});

describe('update_coding_convention — the rendering edges', () => {
  it('a project with no connected repository says so, and an unnamed editor is "a team member"', () => {
    expect(
      renderSavedConvention({ state: 'repo_not_in_project', repo: 'x', repoSet: [] }).summary,
    ).toContain('none — no repository is connected to it');
    const saved = renderSavedConvention({
      state: 'saved',
      repoRef: REPO_A,
      convention: {
        id: 'c',
        repoKey: REPO_A,
        version: 5,
        contentMd: '# x',
        provenance: [],
        authorKind: 'edited',
        editedByUserId: 'gone',
        editedByName: null,
        pendingDerivedMd: null,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    });
    expect(saved.summary).toContain('edited by a team member on 2026-11-01');
  });

  it('a conflict whose winner could not be re-read still names the version, with latest null', () => {
    const res = conventionConflictResult(
      new ConventionVersionConflictError(7, {
        repoKey: REPO_A,
        convention: null,
        versions: [],
        nextCursor: null,
      }),
      6,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('The convention is at v7; your edit is based on v6');
    expect(res.structuredContent).toEqual({
      code: 'CONVENTION_VERSION_CONFLICT',
      repoRef: REPO_A,
      latestVersion: 7,
      latest: null,
    });
  });

  it('a dispatch with no resolved actor is an error result, not a throw', async () => {
    const server = buildMcpServer(() => {
      throw new McpMissingContextError();
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'no-context', version: '0.0.0' });
    await client.connect(clientTransport);
    const res = (await client.callTool({
      name: UPDATE_CODING_CONVENTION_TOOL_NAME,
      arguments: { projectKey: 'PROD', repo: 'alpha', contentMd: '# x', baseVersion: 0 },
    })) as CallToolResult;
    await client.close();
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('MCP_MISSING_CONTEXT');
    expect(putConventionMock).not.toHaveBeenCalled();
  });
});
