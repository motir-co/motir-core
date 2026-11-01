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

// `get_code_health` (Story MOTIR-7782 · Subtask MOTIR-7793) over real Postgres —
// the PLANNING read of a project's code health: every realized repository in the
// project's set with its index state, its latest audit summary and its derived
// convention, gated on `ai:plan`.
//
// The motir-ai HTTP client is stubbed at its module seam — the one sanctioned
// boundary mock, exactly as `tests/code-health-page.test.ts` does it. Workspace,
// project, repositories, the project's repository set and every permission
// decision are the real Postgres path.
//
// What it pins, in order of what would hurt most if it broke:
//  1. THE PERMISSION — refused at the door without `ai:plan` in the grant,
//     refused by the service for an actor whose ROLE lacks it, readable by a
//     Member (who holds `ai:plan` and NOT `ai:configure` — the proof the gate is
//     the planning key, not the configuration one), and a foreign key is a
//     not-found. Actors whose permissions differ are seeded on purpose, so a pass
//     is not an artifact of an all-powerful fixture.
//  2. THE THREE SECTION STATES stay distinguishable: `present`, `absent` (the
//     store has nothing yet) and `unavailable` (one boundary read failed — and
//     only that section degrades).
//  3. THE SHAPE is the planning one: no findings page, the audit read issued at
//     `findingsLimit: 1`, and exactly the realized repositories with the index
//     state the code-context read reports.

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
const { GET_CODE_HEALTH_TOOL_NAME } = await import('@/lib/mcp/tools/getCodeHealth');
const { OPEN_PLAN_SESSION_TOOL_NAME } = await import('@/lib/mcp/tools/planSession');
const { GRANTABLE_PERMISSIONS, UNGRANTABLE_PERMISSIONS } = await import('@/lib/tokens/grant');
const { codeContextService } = await import('@/lib/services/codeContextService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { keyForAppend } = await import('@/lib/workItems/positioning');
const { createTestUser, makeWorkItemFixture } = await import('../fixtures');
const { linkAllWorkspaceReposIntoProject } = await import('../fixtures/codeContextFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { addToProjectAs } = await import('../helpers/workspaceRoleFixtures');

import type { PlanningCodeHealthDTO } from '@/lib/dto/codeHealth';
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
  const client = new Client({ name: 'get-code-health-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function callTool(
  ctx: ServiceContext,
  args: Record<string, unknown>,
  grant?: readonly PermissionKey[],
  name: string = GET_CODE_HEALTH_TOOL_NAME,
): Promise<CallToolResult> {
  const client = await connectClient(ctx, grant);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function healthOf(res: CallToolResult): PlanningCodeHealthDTO {
  expect(res.isError, text(res)).toBeFalsy();
  return res.structuredContent as unknown as PlanningCodeHealthDTO;
}

// motir-ai's REAL `/v1/code-audit` body shape (see tests/code-health-page.test.ts),
// carrying ONE finding so "the findings were dropped" is observable.
function rawAudit(repoKey: string): RawCodeAuditSurface {
  return {
    audit: {
      id: `audit_${repoKey}`,
      aiProjectId: 'ai_1',
      repoKey,
      healthSummary: { grade: 'B', conformancePct: 82, totalFindings: 7 },
      codeGraphRef: 'graph_1',
      scanner: null,
      jobId: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    findings: [{ ruleId: 'r1', category: 'naming', severity: 'low' }],
    total: 7,
    nextOffset: 1,
    scanner: null,
  } as unknown as RawCodeAuditSurface;
}

function rawConvention(repoKey: string): RawConvention {
  return {
    id: `conv_${repoKey}`,
    aiProjectId: 'ai_1',
    repoKey,
    version: 3,
    contentMd: `# ${repoKey} house rules`,
    provenance: [],
    sourceAuditId: 'audit_1',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  } as RawConvention;
}

const EMPTY_AUDIT: RawCodeAuditSurface = {
  audit: null,
  findings: [],
  total: 0,
  nextOffset: null,
  scanner: null,
};
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
  getCodeAuditMock.mockResolvedValue(EMPTY_AUDIT);
  getConventionMock.mockResolvedValue(EMPTY_CONVENTION);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('get_code_health — registered, permissioned, documented (criteria 1, 8, 9)', () => {
  it('tools/list names it, titled and read-only', async () => {
    const fx = await makeWorkItemFixture();
    const client = await connectClient(fx.ctx);
    const { tools } = await client.listTools();
    await client.close();
    const tool = tools.find((t) => t.name === GET_CODE_HEALTH_TOOL_NAME);
    expect(tool, 'get_code_health is not registered').toBeTruthy();
    expect(tool!.title).toBe('Get code health');
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.openWorldHint).toBe(false);
  });

  it('every declaration home carries it, on ai:plan', () => {
    expect(MCP_TOOL_NAMES).toContain(GET_CODE_HEALTH_TOOL_NAME);
    expect(TOOL_PERMISSIONS[GET_CODE_HEALTH_TOOL_NAME]).toBe('ai:plan');
    expect(TOOL_SCOPES[GET_CODE_HEALTH_TOOL_NAME]).toBe('read');
    expect(EXEMPT_TOOLS).toHaveProperty(GET_CODE_HEALTH_TOOL_NAME);
    // A read starts no model job, so it spends no AI rate budget.
    expect(isBillableTool(GET_CODE_HEALTH_TOOL_NAME)).toBe(false);
  });

  it('widens no grant: ai:plan was already grantable and in the CLI grant, and the CLI grant holds no ai:configure', () => {
    expect(GRANTABLE_PERMISSIONS).toContain('ai:plan');
    expect(CLI_TOKEN_GRANT).toContain('ai:plan');
    // `ai:configure` became grantable with the convention WRITE (MOTIR-10183,
    // AMENDMENT 5) — never through this read, and never for a `motir run` token.
    expect(TOOL_PERMISSIONS[GET_CODE_HEALTH_TOOL_NAME]).not.toBe('ai:configure');
    expect(CLI_TOKEN_GRANT).not.toContain('ai:configure');
    expect(UNGRANTABLE_PERMISSIONS).not.toContain('ai:configure');
  });

  it('the design build script carries it (docs/mcp.md and the ADR amendment are held by mcp-doc-guards)', () => {
    expect(read('design/mcp-server/build.py')).toContain(`"${GET_CODE_HEALTH_TOOL_NAME}":`);
  });
});

describe('get_code_health — the answer (criteria 2, 3, 5, 7)', () => {
  it('returns exactly the realized repositories, with the code-context index state', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const health = healthOf(await callTool(fx.ctx, { projectKey: fx.projectIdentifier }));

    expect(health.project).toEqual({ key: fx.projectIdentifier, name: fx.project.name });
    // The proposed row has no repository behind it, so it contributes nothing.
    expect(health.repos.map((r) => r.repoRef)).toEqual([REPO_A, REPO_B]);
    const context = await codeContextService.getCodeContext(fx.projectId, fx.ctx);
    for (const repo of health.repos) {
      const expected = context.repos.find((r) => r.repoRef === repo.repoRef)!;
      expect(repo.indexState).toBe(expected.indexState);
      expect(repo.commitsBehind).toBe(expected.commitsBehind);
      expect(repo.refreshFailing).toBe(expected.refreshFailing);
    }
  });

  it('present for the repo the store has, absent for the one it has not — no findings key', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    getCodeAuditMock.mockImplementation((q) =>
      Promise.resolve(q['repoKey'] === REPO_A ? rawAudit(REPO_A) : EMPTY_AUDIT),
    );
    getConventionMock.mockImplementation((q) => {
      if (q['repoKey'] !== REPO_A) return Promise.resolve(EMPTY_CONVENTION);
      const row = rawConvention(REPO_A);
      return Promise.resolve({ convention: row, versions: [row], nextCursor: null });
    });

    const res = await callTool(fx.ctx, { projectKey: fx.projectIdentifier });
    const health = healthOf(res);
    const [a, b] = health.repos;

    expect(a!.audit).toEqual({
      state: 'present',
      healthSummary: expect.objectContaining({ grade: 'B', conformancePct: 82, totalFindings: 7 }),
      createdAt: '2026-10-01T00:00:00.000Z',
      codeGraphRef: 'graph_1',
    });
    expect(a!.audit).not.toHaveProperty('findings');
    expect(a!.convention).toEqual({
      state: 'present',
      convention: expect.objectContaining({
        repoKey: REPO_A,
        version: 3,
        contentMd: `# ${REPO_A} house rules`,
      }),
    });
    expect(a!.convention).not.toHaveProperty('versions');
    expect(b!.audit).toEqual({ state: 'absent' });
    expect(b!.convention).toEqual({ state: 'absent' });

    // The human summary says the same, one line per repository.
    const summary = (res.content[0] as { text: string }).text;
    expect(summary).toContain(`- ${REPO_A} ·`);
    expect(summary).toContain('grade B');
    expect(summary).toContain('convention: v3');
    expect(summary).toContain('audit: none yet');
  });

  it('issues the audit read at findingsLimit 1 and the convention read at versionsLimit 1, per repo', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    healthOf(await callTool(fx.ctx, { projectKey: fx.projectIdentifier }));

    expect(getCodeAuditMock).toHaveBeenCalledTimes(2);
    for (const [q] of getCodeAuditMock.mock.calls) {
      expect(q).toMatchObject({
        coreWorkspaceId: fx.workspaceId,
        coreProjectId: fx.projectId,
        findingsLimit: 1,
      });
    }
    expect(getCodeAuditMock.mock.calls.map(([q]) => q['repoKey']).sort()).toEqual([REPO_A, REPO_B]);
    expect(getConventionMock).toHaveBeenCalledTimes(2);
    for (const [q] of getConventionMock.mock.calls) {
      expect(q).toMatchObject({ versionsLimit: 1 });
    }
  });

  it('a project with no repository set returns repos: [] and says so — and never reaches motir-ai', async () => {
    const fx = await makeWorkItemFixture();

    const res = await callTool(fx.ctx, { projectKey: fx.projectIdentifier });

    expect(healthOf(res).repos).toEqual([]);
    expect(text(res)).toContain('No repositories in this project');
    expect(getCodeAuditMock).not.toHaveBeenCalled();
    expect(getConventionMock).not.toHaveBeenCalled();
  });
});

describe('get_code_health — a boundary failure degrades ONE section (criterion 4)', () => {
  it('an audit read that throws MotirAiError is unavailable; the call and the sibling still answer', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    getCodeAuditMock.mockImplementation((q) =>
      q['repoKey'] === REPO_A
        ? Promise.reject(new MotirAiUnavailableError('connection refused'))
        : Promise.resolve(rawAudit(REPO_B)),
    );

    const res = await callTool(fx.ctx, { projectKey: fx.projectIdentifier });
    const [a, b] = healthOf(res).repos;

    expect(a!.audit).toEqual({ state: 'unavailable', code: 'MOTIR_AI_UNAVAILABLE' });
    // The failing repo's OTHER section is untouched.
    expect(a!.convention).toEqual({ state: 'absent' });
    expect(b!.audit).toMatchObject({ state: 'present', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(text(res)).toContain('audit: unavailable (MOTIR_AI_UNAVAILABLE)');
  });
});

describe('get_code_health — who may read it (criterion 6)', () => {
  it('a token whose grant lacks ai:plan is refused at the door, before any read', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);

    const denied = await callTool(
      fx.ctx,
      { projectKey: fx.projectIdentifier },
      GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
    );

    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain(PERMISSION_NOT_GRANTED_CODE);
    expect(text(denied)).toContain('ai:plan');
    expect(getCodeAuditMock).not.toHaveBeenCalled();

    // …and a grant of browse + ai:plan alone is enough.
    const allowed = await callTool(fx.ctx, { projectKey: fx.projectIdentifier }, [
      'project:browse',
      'ai:plan',
    ]);
    expect(healthOf(allowed).repos).toHaveLength(2);
  });

  it('an actor whose ROLE lacks ai:plan is refused by the service with the error the other ai:plan reads give', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const viewer = await actorWithRole(fx, 'viewer');

    const denied = await callTool(viewer, { projectKey: fx.projectIdentifier });
    const sibling = await callTool(
      viewer,
      { projectKey: fx.projectIdentifier },
      undefined,
      OPEN_PLAN_SESSION_TOOL_NAME,
    );

    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('PERMISSION_DENIED');
    expect(text(denied)).toContain('ai:plan');
    expect(sibling.isError).toBe(true);
    expect(text(sibling)).toContain('PERMISSION_DENIED');
    expect(getCodeAuditMock).not.toHaveBeenCalled();
  });

  it('a Member — who holds ai:plan and NOT ai:configure — reads it', async () => {
    const fx = await makeWorkItemFixture();
    await seedRepoSet(fx);
    const member = await actorWithRole(fx, 'member');

    const health = healthOf(await callTool(member, { projectKey: fx.projectIdentifier }));

    expect(health.repos.map((r) => r.repoRef)).toEqual([REPO_A, REPO_B]);
  });

  it('a key from another workspace reads as not-found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await seedRepoSet(other);

    const res = await callTool(fx.ctx, { projectKey: other.projectIdentifier });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('PROJECT_NOT_FOUND');
    expect(getCodeAuditMock).not.toHaveBeenCalled();
  });
});
