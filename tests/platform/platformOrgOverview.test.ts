import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  NotPlatformStaffError,
  PlatformOrganizationNotFoundError,
  PlatformWorkspaceNotFoundError,
} from '@/lib/platform/errors';
import type {
  RawPlatformRunsPage,
  RawPlatformUsage,
  RawPlatformUsageChildren,
  RawSpendRow,
} from '@/lib/ai/motirAiClient';

/**
 * The org page's Overview (Story MOTIR-727 · MOTIR-733, design D5) —
 * `platformOrgPageService.getOverview` over the real database, motir-ai faked at
 * the client: one audit row naming the org, members keyset, workspaces with this
 * month's credits, jobs, and every motir-ai region's unavailable state.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const usageMock = vi.fn<(q: unknown) => Promise<RawPlatformUsage>>();
const childrenMock = vi.fn<(q: unknown) => Promise<RawPlatformUsageChildren>>();
const runsMock = vi.fn<(q: unknown) => Promise<RawPlatformRunsPage>>();
const orgUsageMock = vi.fn<(q: unknown) => Promise<{ balance: number }>>();
const monthsMock = vi.fn<(q: unknown) => Promise<unknown>>();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return {
    ...actual,
    getPlatformUsage: (q: unknown) => usageMock(q),
    getPlatformUsageChildren: (q: unknown) => childrenMock(q),
    getPlatformRuns: (q: unknown) => runsMock(q),
    getOrgUsage: (q: unknown) => orgUsageMock(q),
    getPlatformUsageMonths: (q: unknown) => monthsMock(q),
  };
});

const { db } = await import('@/lib/db');
const { platformOrgPageService, ORG_MEMBERS_PAGE } =
  await import('@/lib/services/platformOrgPageService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-10-02T12:00:00Z');

function row(entityId: string, chargedCredits: number): RawSpendRow {
  const zero = {
    planning_tokens: 0,
    agent_tokens: 0,
    agent_machine: 0,
    agent_instance: 0,
    agent_storage: 0,
    ci: 0,
    search: 0,
    hosting_production: 0,
  };
  return {
    entityId,
    credits: zero,
    indexingSeconds: 0,
    chargedCredits,
    costMicroUsd: 0,
    cost: { ...zero, indexing: 0 },
  };
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+orgpage@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  usageMock.mockReset();
  childrenMock.mockReset();
  runsMock.mockReset();
  orgUsageMock.mockReset();
  monthsMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformOrgPageService.getOverview', () => {
  it('reads this month, the workspaces’ credits and the jobs, under ONE estate.read naming the org', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Engineering' });
    const orgId = workspace.organizationId;
    usageMock.mockResolvedValue({
      period: '2026-10',
      level: 'organization',
      entityId: orgId,
      categories: [],
      models: { planning_tokens: [], agent_tokens: [] },
      spend: {
        chargedCredits: 0,
        chargedCostMicroUsd: 0,
        costMicroUsdInclIndexing: 0,
        machineSeconds: 0,
      },
      orgsWithSpend: null,
    });
    childrenMock.mockResolvedValue({
      period: '2026-10',
      sort: 'charged',
      level: 'organization',
      entityId: orgId,
      childLevel: 'workspace',
      items: [row(workspace.id, 420)],
      nextCursor: null,
      remainder: null,
    });
    runsMock.mockResolvedValue({
      items: [
        {
          kind: 'coding',
          id: 'r1',
          ref: 'run_1',
          coreOrganizationId: orgId,
          coreWorkspaceId: workspace.id,
          coreProjectId: null,
          model: 'claude-opus-5-5',
          status: null,
          startedAt: '2026-10-01T10:00:00.000Z',
          lastActivityAt: '2026-10-01T10:30:00.000Z',
          inputTokens: 1,
          outputTokens: 1,
          credits: 9,
        },
      ],
      nextCursor: 'older',
      codingRunsUnattributedExcluded: false,
    });

    const o = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(usageMock).toHaveBeenCalledWith({
      period: '2026-10',
      level: 'organization',
      entityId: orgId,
    });
    expect(o.month).toBe('2026-10');
    expect(o.monthCategories).toEqual([]);
    expect(o.workspaces).toEqual([
      expect.objectContaining({ id: workspace.id, name: 'Engineering', monthChargedCredits: 420 }),
    ]);
    expect(o.jobs.items[0]).toMatchObject({
      kind: 'coding_run',
      workspace: { name: 'Engineering' },
      credits: 9,
    });
    expect(o.jobs.nextCursor).toBe('older');
    expect(o.members.total).toBe(1);

    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: orgId,
    });
  });

  it('pages the members on a keyset — every member once', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Big' });
    const orgId = workspace.organizationId;
    for (let i = 0; i < ORG_MEMBERS_PAGE + 4; i += 1) {
      const u = await createTestUser({ email: `member-${i}@example.com` });
      await adminDb.organizationMembership.create({
        data: { organizationId: orgId, userId: u.id, role: 'member' },
      });
    }
    usageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));

    const first = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(first.members.items).toHaveLength(ORG_MEMBERS_PAGE);
    expect(first.members.total).toBe(ORG_MEMBERS_PAGE + 5);
    const second = await platformOrgPageService.getOverview(currentPrincipal!, orgId, {
      now: NOW,
      membersCursor: first.members.nextCursor,
    });
    expect(second.members.nextCursor).toBeNull();
    const ids = [...first.members.items, ...second.members.items].map((m) => m.userId);
    expect(new Set(ids).size).toBe(ORG_MEMBERS_PAGE + 5);
    expect(ids).toContain(owner.id);
    expect(first.members.items[0]).toMatchObject({ role: 'owner' });
  });

  it('motir-ai unreachable: every remote region says so, the motir-core half renders, one audit row', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Solo' });
    usageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    const o = await platformOrgPageService.getOverview(
      currentPrincipal!,
      workspace.organizationId,
      { now: NOW },
    );
    expect(o.monthCategories).toBeNull();
    expect(o.workspaceSpendUnavailable).toBe(true);
    expect(o.workspaces[0]).toMatchObject({ name: 'Solo', monthChargedCredits: null });
    expect(o.jobs).toEqual({ items: [], nextCursor: null, unavailable: true });
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('a workspace missing from a CUT-OFF children list reads as unknown, not zero', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Quiet' });
    const orgId = workspace.organizationId;
    usageMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    childrenMock.mockResolvedValue({
      period: '2026-10',
      sort: 'charged',
      level: 'organization',
      entityId: orgId,
      childLevel: 'workspace',
      items: [row('other_ws', 5)],
      nextCursor: 'more',
      remainder: null,
    });
    const cut = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(cut.workspaces[0]!.monthChargedCredits).toBeNull();

    childrenMock.mockResolvedValue({
      ...(await childrenMock.mock.results[0]!.value),
      nextCursor: null,
    });
    const whole = await platformOrgPageService.getOverview(currentPrincipal!, orgId, { now: NOW });
    expect(whole.workspaces[0]!.monthChargedCredits).toBe(0);
  });

  it('an unknown org throws inside the read and leaves no audit row', async () => {
    usageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    await expect(
      platformOrgPageService.getOverview(currentPrincipal!, 'org_nope'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('refuses a non-staff caller before reading', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(platformOrgPageService.getOverview(principal, 'org_x')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(usageMock).not.toHaveBeenCalled();
  });
});

describe('platformOrgPageService.getUsageTab', () => {
  const usage: RawPlatformUsage = {
    period: 'all',
    level: 'organization',
    entityId: 'x',
    categories: [],
    models: { planning_tokens: [], agent_tokens: [] },
    spend: {
      chargedCredits: 0,
      chargedCostMicroUsd: 0,
      costMicroUsdInclIndexing: 0,
      machineSeconds: 0,
    },
    orgsWithSpend: null,
  };

  it('reads the chosen scope — org, workspace or project — each under ONE audit row naming it', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Eng' });
    const orgId = workspace.organizationId;
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Mobile',
      identifier: 'MOB',
    });
    usageMock.mockResolvedValue(usage);
    orgUsageMock.mockResolvedValue({ balance: 1234 });

    const org = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: 'all',
    });
    expect(org.scope).toEqual({ level: 'organization' });
    expect(usageMock).toHaveBeenLastCalledWith({
      period: 'all',
      level: 'organization',
      entityId: orgId,
    });
    expect(org.balance).toBe(1234);
    expect(org.scopes).toEqual([
      { id: workspace.id, name: 'Eng', projects: [{ id: project.id, name: 'Mobile' }] },
    ]);

    const ws = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: '2026-09',
      scope: `workspace:${workspace.id}`,
    });
    expect(ws.scope).toEqual({ level: 'workspace', id: workspace.id, name: 'Eng' });
    expect(usageMock).toHaveBeenLastCalledWith({
      period: '2026-09',
      level: 'workspace',
      entityId: workspace.id,
    });

    const pj = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: '2026-09',
      scope: `project:${project.id}`,
    });
    expect(pj.scope).toMatchObject({
      level: 'project',
      id: project.id,
      workspace: { id: workspace.id },
    });

    const audit = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.targetLabel)).toEqual([
      'usage organization all',
      `usage workspace:${workspace.id} 2026-09`,
      `usage project:${project.id} 2026-09`,
    ]);
    expect(audit.every((a) => a.targetId === orgId && a.action === 'estate.read')).toBe(true);
  });

  it('a workspace of ANOTHER org is never read under this org — it falls back to the org scope', async () => {
    const mine = await createTestWorkspace({ name: 'Mine' });
    const theirs = await createTestWorkspace({ name: 'Theirs' });
    usageMock.mockResolvedValue(usage);
    orgUsageMock.mockResolvedValue({ balance: 0 });
    const tab = await platformOrgPageService.getUsageTab(
      currentPrincipal!,
      mine.workspace.organizationId,
      {
        period: 'all',
        scope: `workspace:${theirs.workspace.id}`,
      },
    );
    expect(tab.scope).toEqual({ level: 'organization' });
    for (const call of usageMock.mock.calls) {
      expect((call[0] as { entityId: string }).entityId).not.toBe(theirs.workspace.id);
    }
  });

  it('motir-ai unreachable: usage and balance are null, the org still renders, one audit row', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Solo' });
    usageMock.mockRejectedValue(new Error('down'));
    orgUsageMock.mockRejectedValue(new Error('down'));
    const tab = await platformOrgPageService.getUsageTab(
      currentPrincipal!,
      workspace.organizationId,
      { period: 'all' },
    );
    expect(tab).toMatchObject({ usage: null, balance: null });
    expect(tab.organization.id).toBe(workspace.organizationId);
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('an unknown org throws inside the read — no audit row, no motir-ai call', async () => {
    await expect(
      platformOrgPageService.getUsageTab(currentPrincipal!, 'org_nope', { period: 'all' }),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(usageMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('the Usage tab’s two lists (MOTIR-7293)', () => {
  const usage: RawPlatformUsage = {
    period: '2026-09',
    level: 'organization',
    entityId: 'x',
    categories: [],
    models: { planning_tokens: [], agent_tokens: [] },
    spend: {
      chargedCredits: 0,
      chargedCostMicroUsd: 0,
      costMicroUsdInclIndexing: 0,
      machineSeconds: 0,
    },
    orgsWithSpend: null,
  };
  const months = {
    level: 'organization' as const,
    entityId: 'x',
    items: [],
    nextCursor: null,
    allTime: { period: 'all', categories: {} as never, spend: usage.spend },
  };

  it('names the children, keeps the remainder rows, and follows the scope and period', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Eng' });
    const orgId = workspace.organizationId;
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Mobile',
      identifier: 'MOB',
    });
    usageMock.mockResolvedValue(usage);
    orgUsageMock.mockResolvedValue({ balance: 0 });
    monthsMock.mockResolvedValue(months);
    childrenMock.mockImplementation(async (q) => ({
      period: '2026-09',
      sort: 'cost',
      level: (q as { level: 'organization' | 'workspace' }).level,
      entityId: orgId,
      childLevel: 'workspace',
      items: [
        row((q as { level: string }).level === 'organization' ? workspace.id : project.id, 5),
      ],
      nextCursor: null,
      remainder:
        (q as { level: string }).level === 'organization'
          ? { noProject: row('np', 1), orgLevel: row('ol', 2) }
          : null,
    }));

    const org = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: '2026-09',
    });
    expect(org.children).toMatchObject({
      childLevel: 'workspace',
      rows: [{ entityId: workspace.id, name: 'Eng' }],
      truncated: false,
    });
    expect(org.children!.remainder).not.toBeNull();
    expect(monthsMock).toHaveBeenLastCalledWith({
      level: 'organization',
      entityId: orgId,
      limit: 24,
      cursor: null,
    });
    expect(org.months).toEqual(months);

    const ws = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: '2026-09',
      scope: `workspace:${workspace.id}`,
      monthsCursor: '2025-10',
    });
    expect(ws.children).toMatchObject({
      childLevel: 'project',
      rows: [{ entityId: project.id, name: 'Mobile' }],
      remainder: null,
    });
    expect(monthsMock).toHaveBeenLastCalledWith({
      level: 'workspace',
      entityId: workspace.id,
      limit: 24,
      cursor: '2025-10',
    });

    const pj = await platformOrgPageService.getUsageTab(currentPrincipal!, orgId, {
      period: 'all',
      scope: `project:${project.id}`,
    });
    expect(pj).toMatchObject({ children: null, childrenUnavailable: false });
  });

  it('motir-ai unreachable: both lists say so', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Solo' });
    usageMock.mockRejectedValue(new Error('down'));
    orgUsageMock.mockRejectedValue(new Error('down'));
    childrenMock.mockRejectedValue(new Error('down'));
    monthsMock.mockRejectedValue(new Error('down'));
    const tab = await platformOrgPageService.getUsageTab(
      currentPrincipal!,
      workspace.organizationId,
      { period: 'all' },
    );
    expect(tab).toMatchObject({ children: null, childrenUnavailable: true, months: null });
  });

  it('expanding a workspace reads its projects, named — and a workspace of another org is refused before motir-ai', async () => {
    const mine = await createTestWorkspace({ name: 'Mine' });
    const theirs = await createTestWorkspace({ name: 'Theirs' });
    const project = await createTestProject({
      workspaceId: mine.workspace.id,
      actorUserId: mine.owner.id,
      name: 'Api',
      identifier: 'API',
    });
    childrenMock.mockResolvedValue({
      period: '2026-09',
      sort: 'cost',
      level: 'workspace',
      entityId: mine.workspace.id,
      childLevel: 'project',
      items: [row(project.id, 4)],
      nextCursor: null,
      remainder: null,
    });
    const got = await platformOrgPageService.getWorkspaceProjectsSpend(
      currentPrincipal!,
      mine.workspace.organizationId,
      mine.workspace.id,
      '2026-09',
    );
    expect(got).toEqual({
      rows: [expect.objectContaining({ entityId: project.id, name: 'Api' })],
      truncated: false,
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);

    childrenMock.mockClear();
    await expect(
      platformOrgPageService.getWorkspaceProjectsSpend(
        currentPrincipal!,
        mine.workspace.organizationId,
        theirs.workspace.id,
        '2026-09',
      ),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(childrenMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(1);

    childrenMock.mockRejectedValue(new Error('down'));
    expect(
      await platformOrgPageService.getWorkspaceProjectsSpend(
        currentPrincipal!,
        mine.workspace.organizationId,
        mine.workspace.id,
        'all',
      ),
    ).toBeNull();
  });
});

describe('platformOrgPageService.getWorkspacePage (MOTIR-7295)', () => {
  it('reads the workspace, its projects’ spend, members and attributed jobs under ONE estate.read naming it', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Eng' });
    const orgId = workspace.organizationId;
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Mobile',
      identifier: 'MOB',
    });
    const quiet = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Quiet',
      identifier: 'QUI',
    });
    const spent = row(project.id, 30);
    spent.credits = {
      ...spent.credits,
      planning_tokens: 10,
      agent_tokens: 8,
      agent_machine: 7,
      ci: 5,
    };
    childrenMock.mockResolvedValue({
      period: '2026-10',
      sort: 'cost',
      level: 'workspace',
      entityId: workspace.id,
      childLevel: 'project',
      items: [spent],
      nextCursor: null,
      remainder: null,
    });
    runsMock.mockResolvedValue({
      items: [],
      nextCursor: null,
      codingRunsUnattributedExcluded: true,
    });

    const page = await platformOrgPageService.getWorkspacePage(
      currentPrincipal!,
      orgId,
      workspace.id,
      { now: NOW },
    );
    expect(childrenMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'workspace', entityId: workspace.id, period: '2026-10' }),
    );
    expect(runsMock).toHaveBeenCalledWith(
      expect.objectContaining({ coreWorkspaceId: workspace.id }),
    );
    const byName = Object.fromEntries(page.projects.map((p) => [p.name, p]));
    expect(byName['Mobile']).toMatchObject({
      key: 'MOB',
      planningCredits: 10,
      runsAndCiCredits: 20,
      chargedCredits: 30,
    });
    expect(byName['Quiet']).toMatchObject({ key: 'QUI', planningCredits: 0, chargedCredits: 0 });
    expect(quiet.id).toBeTruthy();
    expect(page.members).toMatchObject({
      total: 1,
      items: [{ userId: owner.id, role: 'manager' }],
    });

    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'workspace',
      targetId: workspace.id,
    });
  });

  it('a workspace of another org is a not-found — no audit row, motir-ai never asked', async () => {
    const mine = await createTestWorkspace({ name: 'Mine' });
    const theirs = await createTestWorkspace({ name: 'Theirs' });
    await expect(
      platformOrgPageService.getWorkspacePage(
        currentPrincipal!,
        mine.workspace.organizationId,
        theirs.workspace.id,
      ),
    ).rejects.toBeInstanceOf(PlatformWorkspaceNotFoundError);
    expect(childrenMock).not.toHaveBeenCalled();
    expect(runsMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('motir-ai unreachable: spend and jobs say so, members still render', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Solo' });
    await createTestProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'P',
      identifier: 'PPP',
    });
    childrenMock.mockRejectedValue(new Error('down'));
    runsMock.mockRejectedValue(new Error('down'));
    const page = await platformOrgPageService.getWorkspacePage(
      currentPrincipal!,
      workspace.organizationId,
      workspace.id,
    );
    expect(page.projectSpendUnavailable).toBe(true);
    expect(page.projects[0]).toMatchObject({ chargedCredits: null });
    expect(page.jobs.unavailable).toBe(true);
    expect(page.members.total).toBe(1);
  });
});
