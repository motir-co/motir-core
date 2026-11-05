import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Story MOTIR-6905's INTEGRATION GATE, part 3 (MOTIR-7321) — THE TENANT BOUNDARY
 * around the fleet monitor and the admin stop, with the REAL `requirePlatformStaff`
 * over real Postgres and only the SESSION mocked (the test environment has no
 * cookies), as `consoleGate.test.ts` does for Story MOTIR-727.
 *
 *  1. Every non-staff principal kind — no session, a user with no role, a
 *     workspace member, the org's own owner — gets the 404 posture on
 *     `/admin/monitoring` and `/admin/tenants/[orgId]`: the `(admin)` layout
 *     answers `notFound()`, and so does each page's own gate (MOTIR-7613).
 *  2. Both Stop-containers Server Actions refuse them (`NOT_PERMITTED`), and so
 *     does a forged stop from `support` / `operator` — before any effect: the
 *     org's in-flight CI intent and hosted slot are untouched and no audit row is
 *     written.
 *  3. THE IMPORT BOUNDARY: no tenant-facing module imports
 *     `platformFleetMonitorService` or `platformFleetStopService` — only the
 *     `(admin)` route group and the alert job's service.
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
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getTranslations: vi.fn(async () => (key: string) => key),
}));

const { db } = await import('@/lib/db');
const { MOTIR_RUNNER_LABEL } = await import('@/lib/ciFleet/config');
const { hostedRunDispatchId } = await import('@/lib/hostedRuns/ids');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { walk } = await import('../helpers/serverPageHarness');
const { OrgFleetCard } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/OrgFleetCard');

interface Estate {
  orgId: string;
  workspaceId: string;
  intentId: string;
  nonStaff: Record<'noRole' | 'workspaceMember' | 'orgOwner', string>;
}

let seq = 0;

async function seedEstate(): Promise<Estate> {
  seq += 1;
  const owner = await createTestUser({ email: `owner-${seq}@acme.test` });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const member = await createTestUser({ email: `member-${seq}@acme.test` });
  await workspacesService.addMember({
    userId: member.id,
    workspaceId: workspace.id,
    workspaceRole: 'member',
  });
  const loner = await createTestUser({ email: `nobody-${seq}@example.test` });

  // Something a stop would act on, so a refusal that leaked an effect shows.
  const intent = await adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      installationId: '1',
      runId: `gate-${seq}`,
      runAttempt: 1,
      jobId: `gate-${seq}`,
      repoOwner: 'motir-projects',
      repoName: 'web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: new Date(),
      status: 'provisioning',
    },
  });
  await adminDb.fleetInFlightSlot.create({
    data: {
      workload: 'hosted_agent',
      ref: hostedRunDispatchId(`gate-run-${seq}`),
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });

  return {
    orgId: workspace.organizationId,
    workspaceId: workspace.id,
    intentId: intent.id,
    nonStaff: { noRole: loner.id, workspaceMember: member.id, orgOwner: owner.id },
  };
}

async function staff(role: 'support' | 'operator' | 'superadmin'): Promise<string> {
  seq += 1;
  const user = await createTestUser({ email: `ops+fleetgate-${role}-${seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user.id;
}

async function untouched(e: Estate) {
  expect(
    await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id: e.intentId } }),
  ).toMatchObject({ status: 'provisioning', teardownReason: null });
  expect(await adminDb.fleetInFlightSlot.count({ where: { organizationId: e.orgId } })).toBe(1);
  expect(await adminDb.platformAuditLog.count()).toBe(0);
}

let estate: Estate;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_audit_log", "fleet_in_flight_slot", "ci_runner_provisioning_intent" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  estate = await seedEstate();
  currentSession = null;
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const KINDS = ['noSession', 'noRole', 'workspaceMember', 'orgOwner'] as const;
const sessionFor = (kind: (typeof KINDS)[number]) =>
  kind === 'noSession' ? null : { user: { id: estate.nonStaff[kind] } };

describe('1 · the 404 posture on both pages (AC4)', () => {
  it.each(KINDS)('%s — the (admin) layout answers 404, and each page refuses', async (kind) => {
    currentSession = sessionFor(kind);
    const layout = await import('@/app/(admin)/layout');
    await expect(layout.default({ children: null })).rejects.toBeInstanceOf(NotFoundSentinel);

    const monitoring = await import('@/app/(admin)/admin/monitoring/page');
    await expect(monitoring.default({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );

    const tenant = await import('@/app/(admin)/admin/tenants/[orgId]/page');
    await expect(
      tenant.default({
        params: Promise.resolve({ orgId: estate.orgId }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toBeInstanceOf(NotFoundSentinel);

    await untouched(estate);
  });
});

describe('2 · both Stop-containers actions refuse (AC4)', () => {
  it.each(KINDS)('%s — preview and stop answer NOT_PERMITTED, touching nothing', async (kind) => {
    currentSession = sessionFor(kind);
    const { previewStopAction, stopContainersAction } =
      await import('@/app/(admin)/admin/tenants/[orgId]/actions');
    expect(await previewStopAction(estate.orgId)).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(await stopContainersAction(estate.orgId, 'Runaway spend')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    await untouched(estate);
  });

  it('a forged stop from support or operator is NOT_PERMITTED; support may still preview', async () => {
    const { previewStopAction, stopContainersAction } =
      await import('@/app/(admin)/admin/tenants/[orgId]/actions');
    for (const role of ['support', 'operator'] as const) {
      currentSession = { user: { id: await staff(role) } };
      expect(await stopContainersAction(estate.orgId, 'Runaway spend'), role).toEqual({
        ok: false,
        code: 'NOT_PERMITTED',
      });
    }
    await untouched(estate);

    currentSession = { user: { id: await staff('support') } };
    const preview = await previewStopAction(estate.orgId);
    expect(preview).toMatchObject({ ok: true, preview: { ciContainers: 1, hostedRuns: 1 } });
    // The preview is a read: audited once, and it stopped nothing.
    expect(await adminDb.platformAuditLog.count()).toBe(1);
    expect(
      await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: estate.intentId },
      }),
    ).toMatchObject({ status: 'provisioning' });
  });

  it('the gate is not vacuous: a superadmin session passes it and stops the org', async () => {
    const { stopContainersAction } = await import('@/app/(admin)/admin/tenants/[orgId]/actions');
    currentSession = { user: { id: await staff('superadmin') } };
    expect(await stopContainersAction(estate.orgId, 'Runaway spend')).toMatchObject({
      ok: true,
      result: { ciContainersStopped: 0 },
    });
    expect(
      await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: estate.intentId },
      }),
    ).toMatchObject({ status: 'failed', teardownReason: 'admin_stop' });
    expect(await adminDb.platformAuditLog.count({ where: { action: 'fleet.stop' } })).toBe(1);
  });
});

describe('the tenant page’s Fleet section, for staff (coverage top-up)', () => {
  /** Call the page as staff, find its Fleet section in the tree, and run it. */
  async function fleetSection(): Promise<unknown> {
    const page = await import('@/app/(admin)/admin/tenants/[orgId]/page');
    const tree = await page.default({
      params: Promise.resolve({ orgId: estate.orgId }),
      searchParams: Promise.resolve({}),
    });
    const section = walk(tree).find(
      (el) => typeof el.type === 'function' && el.type.name === 'OrgFleetSection',
    );
    if (!section) throw new Error('the page rendered no Fleet section');
    return (section.type as (p: unknown) => Promise<unknown>)(section.props);
  }

  it('on cloud it is the Fleet card over the org’s real row and its last stop', async () => {
    currentSession = { user: { id: await staff('superadmin') } };
    const { stopContainersAction } = await import('@/app/(admin)/admin/tenants/[orgId]/actions');
    expect(await stopContainersAction(estate.orgId, 'Runaway spend')).toMatchObject({ ok: true });

    const card = (await fleetSection()) as { type: unknown; props: Record<string, unknown> };
    expect(card.type).toBe(OrgFleetCard);
    expect(card.props).toMatchObject({
      orgId: estate.orgId,
      orgName: 'Acme',
      role: 'superadmin',
      row: expect.objectContaining({ organizationId: estate.orgId }),
      lastStop: expect.objectContaining({ reason: 'Runaway spend' }),
      // A platform stop settles `admin_stop`: no org-admin stop to show.
      lastOrgAdminStop: null,
    });
  });

  it('an org admin’s stop reaches the card as its own prop, apart from lastStop', async () => {
    currentSession = { user: { id: await staff('support') } };
    const settledAt = new Date();
    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: estate.intentId },
      data: { status: 'failed', teardownReason: 'org_admin_stop', settledAt },
    });
    const card = (await fleetSection()) as { props: Record<string, unknown> };
    expect(card.props).toMatchObject({
      lastStop: null,
      lastOrgAdminStop: {
        at: settledAt.toISOString(),
        ciContainersStopped: 1,
        agentInstancesHibernated: 0,
      },
    });
  });

  it('off-cloud there is no fleet and no meter, so there is no card', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    currentSession = { user: { id: await staff('support') } };
    expect(await fleetSection()).toBeNull();
  });
});

// ── 3 · The import boundary ───────────────────────────────────────────────────

const ROOT = resolve(__dirname, '..', '..');
const GUARDED = /['"]@\/lib\/services\/platformFleet(Monitor|Stop)Service['"]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** May reach the two services: the operator console, and the alert job's service. */
function isAllowedImporter(path: string): boolean {
  return (
    path.startsWith('app/(admin)/') ||
    path.startsWith('app/api/admin/') ||
    path === 'lib/services/fleetDebitMonitorService.ts' ||
    path === 'lib/services/platformFleetMonitorService.ts' ||
    path === 'lib/services/platformFleetStopService.ts'
  );
}

describe('3 · no tenant-facing module imports either service (AC4)', () => {
  const importers = ['app', 'lib', 'components']
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .filter((file) => GUARDED.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .sort();

  it('every importer is in the (admin) group or is the alert job', () => {
    expect(importers.filter((file) => !isAllowedImporter(file))).toEqual([]);
  });

  it('the scan is not vacuous: it finds the console pages, the actions and the job', () => {
    expect(importers).toEqual(
      expect.arrayContaining([
        'app/(admin)/admin/monitoring/page.tsx',
        'app/(admin)/admin/tenants/[orgId]/actions.ts',
        'app/(admin)/admin/tenants/[orgId]/page.tsx',
        'lib/services/fleetDebitMonitorService.ts',
      ]),
    );
  });

  it('the predicate would catch a tenant-facing importer', () => {
    for (const leak of [
      'app/(authed)/settings/organization/billing/page.tsx',
      'app/api/v1/fleet/route.ts',
      'components/billing/FleetCard.tsx',
      'lib/services/billingService.ts',
    ]) {
      expect(isAllowedImporter(leak), leak).toBe(false);
    }
  });
});
