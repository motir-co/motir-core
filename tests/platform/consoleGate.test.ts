import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Story 10.1's motir-core INTEGRATION GATE, part 1 (Story MOTIR-727 · MOTIR-734) —
 * the security boundary over every screen, tab and read the story added, with the
 * REAL `requirePlatformStaff` over real Postgres and only the SESSION mocked (the
 * test environment has no cookies). motir-ai is faked at `fetch`: the boundary under
 * test is motir-core's own.
 *
 *  1. Every non-staff principal kind — no session, a user with no role, a workspace
 *     member, a workspace manager, an org owner — is refused by every story-added
 *     `platform*Service` read, server action and page, and the (admin) layout answers
 *     them 404. A refusal reads nothing remote and writes no audit row.
 *  2. Every cross-tenant read by platform staff writes EXACTLY ONE `platform_audit_log`
 *     row; a read that throws writes none.
 *  3. The Billing tab's service exposes no write, and the TENANT billing gate still
 *     refuses another org's member.
 */

let currentSession: { user: { id: string } } | null = null;

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: vi.fn(() => {
    throw new NotFoundSentinel();
  }),
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const { db } = await import('@/lib/db');
const { NotPlatformStaffError, PlatformOrganizationNotFoundError, PlatformWorkspaceNotFoundError } =
  await import('@/lib/platform/errors');
const { platformReadService } = await import('@/lib/services/platformReadService');
const { platformUsageService } = await import('@/lib/services/platformUsageService');
const { platformOrgPageService } = await import('@/lib/services/platformOrgPageService');
const { platformOrgBillingService } = await import('@/lib/services/platformOrgBillingService');
const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

// ── motir-ai, faked at fetch: a minimal valid body per route the console reads ──

const zeroRow = (entityId: string) => {
  const credits = {
    planning_tokens: 0,
    agent_tokens: 0,
    agent_machine: 0,
    agent_instance: 0,
    agent_storage: 0,
    ci: 0,
    search: 0,
  };
  return {
    entityId,
    credits,
    indexingSeconds: 0,
    chargedCredits: 0,
    costMicroUsd: 0,
    cost: { ...credits, indexing: 0 },
  };
};
const spend = {
  chargedCredits: 0,
  chargedCostMicroUsd: 0,
  costMicroUsdInclIndexing: 0,
  machineSeconds: 0,
};
let remoteCalls: string[] = [];

function fakeMotirAi(input: string | URL): Response {
  const url = new URL(String(input));
  remoteCalls.push(url.pathname);
  const json = (body: unknown) => Response.json(body);
  switch (url.pathname) {
    case '/v1/platform/runs':
      return json({ items: [], nextCursor: null, codingRunsUnattributedExcluded: false });
    case '/v1/platform/usage':
      return json({
        period: url.searchParams.get('period'),
        level: url.searchParams.get('level'),
        entityId: url.searchParams.get('entityId') ?? '',
        categories: [],
        models: { planning_tokens: [], agent_tokens: [] },
        spend,
        orgsWithSpend: 0,
      });
    case '/v1/platform/usage/orgs':
      return json({
        period: 'all',
        sort: 'cost',
        items: [],
        nextCursor: null,
        estate: zeroRow('platform'),
      });
    case '/v1/platform/usage/children':
      return json({
        period: 'all',
        sort: 'cost',
        level: 'organization',
        entityId: 'x',
        childLevel: 'workspace',
        items: [],
        nextCursor: null,
        remainder: null,
      });
    case '/v1/platform/usage/months':
      return json({
        level: 'organization',
        entityId: 'x',
        items: [],
        nextCursor: null,
        allTime: { period: 'all', categories: {}, spend },
      });
    case '/v1/platform/usage/provider-reconciliation':
      return json({
        period: url.searchParams.get('period'),
        providers: [],
        findings: [],
        unreconciledProviders: [],
      });
    case '/v1/usage':
      return json({
        balance: 0,
        tier: null,
        monthSpend: 0,
        search: null,
        agentMachine: null,
        agentStorage: null,
      });
    case '/v1/stripe/subscription':
      return json({ status: null, currentPeriodEnd: null, priceId: null, planTier: null });
    default:
      return new Response(JSON.stringify({ code: 'not_found', title: 'Not found', status: 404 }), {
        status: 404,
      });
  }
}

// ── The estate ──────────────────────────────────────────────────────────────────

interface Estate {
  staffId: string;
  orgId: string;
  workspaceId: string;
  /** Each non-staff principal kind, by the user id its session carries. */
  nonStaff: Record<'noRole' | 'workspaceMember' | 'workspaceManager' | 'orgOwner', string>;
}

async function seedEstate(): Promise<Estate> {
  const staff = await createTestUser({ email: 'ops+gate@moooon.net' });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'superadmin' } });

  const owner = await createTestUser({ email: 'owner@acme.test' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Web',
    identifier: 'WEB',
  });

  const member = await createTestUser({ email: 'member@acme.test' });
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: workspace.id,
    workspaceRole: 'member',
  });
  const manager = await createTestUser({ email: 'manager@acme.test' });
  await workspacesService.addMember({
    userId: manager.id,
    workspaceId: workspace.id,
    workspaceRole: 'manager',
  });
  const loner = await createTestUser({ email: 'nobody@example.test' });

  return {
    staffId: staff.id,
    orgId: workspace.organizationId,
    workspaceId: workspace.id,
    nonStaff: {
      noRole: loner.id,
      workspaceMember: member.id,
      workspaceManager: manager.id,
      orgOwner: owner.id,
    },
  };
}

/** A principal argument as a page would pass it — the gate reads the SESSION, not this. */
const asPrincipal = (userId: string) => ({
  userId,
  email: 'x@example.test',
  role: 'support' as const,
});

/** Every story-added platform read, as one call each. */
function storyReads(e: Estate, userId: string) {
  const p = asPrincipal(userId);
  return {
    'platformReadService.getEstateCounts': () => platformReadService.getEstateCounts(p),
    'platformReadService.getOrganizationEstate': () =>
      platformReadService.getOrganizationEstate(p, e.orgId),
    'platformReadService.getOverview': () => platformReadService.getOverview(p, { period: '7d' }),
    'platformReadService.getEstateUsage': () => platformReadService.getEstateUsage(p, 'all'),
    // A month adds the provider-bill reconciliation read (MOTIR-11376) to the same view.
    'platformReadService.getEstateUsage (month, provider bills)': () =>
      platformReadService.getEstateUsage(p, '2026-09'),
    'platformUsageService.listTenants': () =>
      platformUsageService.listTenants(p, { period: 'all', sort: 'cost' }),
    'platformUsageService.listTenants (filtered)': () =>
      platformUsageService.listTenants(p, { period: 'all', sort: 'cost', filter: 'acme' }),
    'platformOrgPageService.getOverview': () => platformOrgPageService.getOverview(p, e.orgId),
    'platformOrgPageService.getUsageTab': () =>
      platformOrgPageService.getUsageTab(p, e.orgId, { period: 'all' }),
    'platformOrgPageService.getWorkspaceProjectsSpend': () =>
      platformOrgPageService.getWorkspaceProjectsSpend(p, e.orgId, e.workspaceId, 'all'),
    'platformOrgPageService.getWorkspacePage': () =>
      platformOrgPageService.getWorkspacePage(p, e.orgId, e.workspaceId),
    'platformOrgBillingService.getOrgBilling': () =>
      platformOrgBillingService.getOrgBilling(p, e.orgId),
  } as const;
}

/** Every story-added route and server action, as the framework would call them. */
async function storyRoutes(e: Estate) {
  const page = (m: { default: (props: never) => unknown }, props: unknown) => () =>
    m.default(props as never);
  const overview = await import('@/app/(admin)/admin/page');
  const usage = await import('@/app/(admin)/admin/usage/page');
  const tenants = await import('@/app/(admin)/admin/tenants/page');
  const org = await import('@/app/(admin)/admin/tenants/[orgId]/page');
  const ws = await import('@/app/(admin)/admin/tenants/[orgId]/workspaces/[workspaceId]/page');
  const { loadMoreTenants } = await import('@/app/(admin)/admin/tenants/listActions');
  const { loadWorkspaceProjects } =
    await import('@/app/(admin)/admin/tenants/[orgId]/usageActions');
  const params = Promise.resolve({ orgId: e.orgId, workspaceId: e.workspaceId });
  const sp = (q: Record<string, string>) => ({ params, searchParams: Promise.resolve(q) });
  return {
    '/admin': page(overview, sp({})),
    '/admin/usage': page(usage, sp({ period: 'all' })),
    '/admin/usage?period=2026-09 (provider bills)': page(usage, sp({ period: '2026-09' })),
    '/admin/tenants': page(tenants, sp({})),
    '/admin/tenants/[orgId] (Overview)': page(org, sp({})),
    '/admin/tenants/[orgId]?tab=usage': page(org, sp({ tab: 'usage' })),
    '/admin/tenants/[orgId]?tab=billing': page(org, sp({ tab: 'billing' })),
    '/admin/tenants/[orgId]/workspaces/[workspaceId]': page(ws, sp({})),
    'action loadMoreTenants': () =>
      loadMoreTenants({ period: 'all', sort: 'cost', filter: '', cursor: 'x' }),
    'action loadWorkspaceProjects': () =>
      loadWorkspaceProjects({ orgId: e.orgId, workspaceId: e.workspaceId, period: 'all' }),
  } as const;
}

let estate: Estate;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  estate = await seedEstate();
  currentSession = null;
  remoteCalls = [];
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => fakeMotirAi(input)),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KINDS = ['noSession', 'noRole', 'workspaceMember', 'workspaceManager', 'orgOwner'] as const;
const sessionFor = (kind: (typeof KINDS)[number]) =>
  kind === 'noSession' ? null : { user: { id: estate.nonStaff[kind] } };

describe('1 · every non-staff principal kind is refused everywhere the story added', () => {
  it.each(KINDS)(
    '%s — every service read refuses before reading, auditing nothing',
    async (kind) => {
      currentSession = sessionFor(kind);
      for (const [name, read] of Object.entries(
        storyReads(estate, currentSession?.user.id ?? 'anon'),
      )) {
        await expect(read(), name).rejects.toBeInstanceOf(NotPlatformStaffError);
      }
      expect(remoteCalls).toEqual([]);
      expect(await adminDb.platformAuditLog.count()).toBe(0);
    },
  );

  it.each(KINDS)(
    '%s — every page and server action refuses, and the (admin) layout answers 404',
    async (kind) => {
      currentSession = sessionFor(kind);
      // A PAGE answers the app's 404 from its own gate, as the layout does — the
      // two render concurrently, so a page that threw instead surfaced as an
      // unhandled production error (MOTIR-7613). A server action refuses.
      for (const [name, route] of Object.entries(await storyRoutes(estate))) {
        await expect(Promise.resolve().then(route), name).rejects.toBeInstanceOf(
          name.startsWith('action ') ? NotPlatformStaffError : NotFoundSentinel,
        );
      }
      const layout = await import('@/app/(admin)/layout');
      await expect(layout.default({ children: null })).rejects.toBeInstanceOf(NotFoundSentinel);
      expect(remoteCalls).toEqual([]);
      expect(await adminDb.platformAuditLog.count()).toBe(0);
    },
  );

  it('a platform role, and nothing else, passes', async () => {
    currentSession = { user: { id: estate.staffId } };
    await expect(
      platformReadService.getEstateCounts(asPrincipal(estate.staffId)),
    ).resolves.toMatchObject({
      organizations: 1,
    });
  });
});

describe('2 · one audit row per cross-tenant read; none for a read that throws', () => {
  it('each story-added read by platform staff writes exactly one row', async () => {
    currentSession = { user: { id: estate.staffId } };
    for (const [name, read] of Object.entries(storyReads(estate, estate.staffId))) {
      const before = await adminDb.platformAuditLog.count();
      await read();
      expect(await adminDb.platformAuditLog.count(), name).toBe(before + 1);
    }
    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows.every((r) => r.action === 'estate.read' && r.actorUserId === estate.staffId)).toBe(
      true,
    );
  });

  it('a month of Usage & cost reads the estate usage AND the provider bills under one row', async () => {
    currentSession = { user: { id: estate.staffId } };
    await platformReadService.getEstateUsage(asPrincipal(estate.staffId), '2026-09');
    expect([...remoteCalls].sort()).toEqual([
      '/v1/platform/usage',
      '/v1/platform/usage/provider-reconciliation',
    ]);
    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'estate.read', actorUserId: estate.staffId });
  });

  it('each read that throws — an unknown org, a foreign workspace — writes none', async () => {
    currentSession = { user: { id: estate.staffId } };
    const p = asPrincipal(estate.staffId);
    const other = await workspacesService.createWorkspace({
      name: 'Other',
      ownerUserId: (await createTestUser({ email: 'other@x.test' })).id,
    });
    const throwing: [string, () => Promise<unknown>, new (...a: never[]) => Error][] = [
      [
        'getOrganizationEstate',
        () => platformReadService.getOrganizationEstate(p, 'org_nope'),
        PlatformOrganizationNotFoundError,
      ],
      [
        'getOverview (org)',
        () => platformOrgPageService.getOverview(p, 'org_nope'),
        PlatformOrganizationNotFoundError,
      ],
      [
        'getUsageTab',
        () => platformOrgPageService.getUsageTab(p, 'org_nope', { period: 'all' }),
        PlatformOrganizationNotFoundError,
      ],
      [
        'getWorkspaceProjectsSpend (foreign workspace)',
        () =>
          platformOrgPageService.getWorkspaceProjectsSpend(
            p,
            estate.orgId,
            other.workspace.id,
            'all',
          ),
        PlatformOrganizationNotFoundError,
      ],
      [
        'getWorkspacePage (foreign workspace)',
        () => platformOrgPageService.getWorkspacePage(p, estate.orgId, other.workspace.id),
        PlatformWorkspaceNotFoundError,
      ],
      [
        'getOrgBilling',
        () => platformOrgBillingService.getOrgBilling(p, 'org_nope'),
        PlatformOrganizationNotFoundError,
      ],
    ];
    for (const [name, read, error] of throwing) {
      await expect(read(), name).rejects.toBeInstanceOf(error);
    }
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('3 · billing: the operator tab writes nothing, the tenant gate is unchanged', () => {
  it('the Billing tab’s service exposes one read and no write', () => {
    expect(Object.keys(platformOrgBillingService)).toEqual(['getOrgBilling']);
  });

  it('the tenant billing read still refuses a member of another org', async () => {
    const outsider = await createTestUser({ email: 'outsider@x.test' });
    await expect(
      billingService.getBillingStatus({ organizationId: estate.orgId, actorUserId: outsider.id }),
    ).rejects.toThrow();
    expect(remoteCalls).toEqual([]);
  });
});
