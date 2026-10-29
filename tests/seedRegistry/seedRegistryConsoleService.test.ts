import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostingTarget,
  PlatformRole,
  ProjectRepoRole,
  ProjectRepoState,
  ProjectRepoTakeoverState,
} from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_ORGANIZATION,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';

// THE STARTER LIBRARY's console reads (Story MOTIR-704 · MOTIR-712; design
// MOTIR-705 §2–§3) over the real test database. What is proved: only an operator
// and above reads either list, and each read is audited; the library filters by
// role, status and hosting target (an EMPTY target list is `none`), pages 25 at a
// time newest first and clamps a page past the end; its provenance names who
// promoted an entry from which repository and who retired it, when and why; and
// the promote form's picker lists only repositories Motir created, the held ones
// marked with the reason. (Refusals are matched by name: each case re-imports
// the module graph, so the error class is a fresh one.)

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

let seq = 0;
async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `seed-console-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return { userId: user.id, email: user.email, role: role ?? ('support' as const) };
}

/** A fresh module graph per case: `requirePlatformStaff` is React-`cache()`d. */
async function fresh() {
  const { seedRegistryConsoleService } = await import('@/lib/services/seedRegistryConsoleService');
  const { seedRegistryPromotionService } =
    await import('@/lib/services/seedRegistryPromotionService');
  return { console: seedRegistryConsoleService, promotion: seedRegistryPromotionService };
}

/** An entry written straight to the table, `minutesAgo` old. */
async function entry(
  key: string,
  over: {
    role?: ProjectRepoRole;
    hostingTargets?: HostingTarget[];
    status?: 'active' | 'retired';
    minutesAgo?: number;
    promotedFrom?: string;
    promotedBy?: string;
  } = {},
) {
  return adminDb.seedRegistryEntry.create({
    data: {
      key,
      role: over.role ?? 'web',
      stack: 'nextjs',
      label: `Label ${key}`,
      templateOwner: 'motir-co',
      templateRepo: key,
      useCases: ['mvp'],
      sizes: ['small'],
      hostingTargets: over.hostingTargets ?? ['fly'],
      status: over.status ?? 'active',
      createdAt: new Date(Date.now() - (over.minutesAgo ?? 0) * 60_000),
      ...(over.promotedFrom
        ? {
            promotedFrom: over.promotedFrom,
            promotedRef: 'c0ffee0000000000000000000000000000000001',
            promotedBy: over.promotedBy ?? null,
            promotedAt: new Date(),
          }
        : {}),
    },
  });
}

/** A Motir-created row of `state`, realised on GitHub once it is created. */
async function motirRow(
  name: string,
  over: {
    state?: ProjectRepoState;
    takeoverState?: ProjectRepoTakeoverState | null;
    seedSource?: string;
  } = {},
) {
  const fx = await makeWorkItemFixture();
  const state = over.state ?? 'created';
  let githubRepoId: string | null = null;
  if (state === 'created' || state === 'connected') {
    const installation = await adminDb.githubInstallation.create({
      data: {
        installationId: `inst-${fx.workspaceId}`,
        workspaceId: fx.workspaceId,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: fx.workspaceId,
        organizationId: await organizationIdOf(fx.workspaceId),
        repoId: `repo-${fx.workspaceId}`,
        owner: 'motir-projects',
        name,
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    githubRepoId = repo.id;
  }
  return adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      seedSource: over.seedSource ?? SEED_SOURCE_PLATFORM_STARTER,
      state,
      githubRepoId,
      takeoverState: over.takeoverState ?? null,
      position: 'a0',
    },
  });
}

const auditRows = (action: string) => adminDb.platformAuditLog.findMany({ where: { action } });

beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterEach(async () => {
  await adminDb.seedRegistryEntry.deleteMany({
    where: { key: { notIn: [SEED_SOURCE_PLATFORM_STARTER, SEED_SOURCE_INITIALISED] } },
  });
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the library', () => {
  it('refuses support, and answers an operator the shipped starters as defaults, audited', async () => {
    const support = await signInAs('support');
    await expect(
      (await fresh()).console.listLibrary(support, { status: 'active' }, 1),
    ).rejects.toMatchObject({ name: 'NotPlatformStaffError' });

    vi.resetModules();
    const operator = await signInAs('operator');
    const page = await (await fresh()).console.listLibrary(operator, { status: 'active' }, 1);
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(25);
    expect(page.rows.map((r) => r.entry.key).sort()).toEqual(
      [SEED_SOURCE_INITIALISED, SEED_SOURCE_PLATFORM_STARTER].sort(),
    );
    for (const row of page.rows) {
      expect(row.isDefault).toBe(true);
      expect(row.promotedByEmail).toBeNull();
      expect(row.promotedFromRepo).toBeNull();
      expect(row.retirement).toBeNull();
    }
    const reads = await auditRows('seed_registry.library_read');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.actorUserId).toBe(operator.userId);
  });

  it('filters by role, status and hosting target, newest first', async () => {
    await entry('fly-web', { minutesAgo: 3 });
    await entry('aws-web', { hostingTargets: ['aws'], minutesAgo: 2 });
    await entry('expo-mobile', { role: 'mobile', hostingTargets: [], minutesAgo: 1 });
    await entry('old-fly', { status: 'retired', minutesAgo: 4 });
    const operator = await signInAs('operator');
    const { console: service } = await fresh();

    const fly = await service.listLibrary(operator, { status: 'active', target: 'fly' }, 1);
    expect(fly.rows.map((r) => r.entry.key)).toEqual(['fly-web']);

    const none = await service.listLibrary(operator, { status: 'active', target: 'none' }, 1);
    // The mobile starter and `initialised` both deploy nowhere; newest first.
    expect(none.rows.map((r) => r.entry.key)).toContain('expo-mobile');
    expect(none.rows.every((r) => r.entry.hostingTargets.length === 0)).toBe(true);

    const mobile = await service.listLibrary(operator, { status: 'active', role: 'mobile' }, 1);
    expect(mobile.rows.map((r) => r.entry.key)).toEqual(['expo-mobile']);

    const retired = await service.listLibrary(operator, { status: 'retired' }, 1);
    expect(retired.rows.map((r) => r.entry.key)).toEqual(['old-fly']);

    const all = await service.listLibrary(operator, { status: 'all', role: 'web' }, 1);
    expect(all.rows.map((r) => r.entry.key).slice(0, 3)).toEqual(['aws-web', 'fly-web', 'old-fly']);
  });

  it('pages 25 at a time and clamps a page past the end to the last one', async () => {
    for (let i = 0; i < 26; i++) {
      await entry(`bulk-${String(i).padStart(2, '0')}`, { minutesAgo: i + 1 });
    }
    const operator = await signInAs('operator');
    const { console: service } = await fresh();

    const first = await service.listLibrary(operator, { status: 'active', target: 'fly' }, 1);
    expect(first.total).toBe(26);
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0]?.entry.key).toBe('bulk-00');

    const past = await service.listLibrary(operator, { status: 'active', target: 'fly' }, 9);
    expect(past.page).toBe(2);
    expect(past.rows.map((r) => r.entry.key)).toEqual(['bulk-25']);
  });

  it('spells out who promoted an entry from which repository, and who retired it and why', async () => {
    const operator = await signInAs('operator');
    const source = await motirRow('acme-booking-web');
    await entry('acme-booking', { promotedFrom: source.id, promotedBy: operator.userId });
    await entry('gone-source', { promotedFrom: 'no-such-row', promotedBy: 'no-such-user' });

    const { promotion } = await fresh();
    await promotion.retire(operator, 'acme-booking', 'Replaced by the v2 booking starter');

    vi.resetModules();
    const page = await (await fresh()).console.listLibrary(operator, { status: 'all' }, 1);
    const promoted = page.rows.find((r) => r.entry.key === 'acme-booking');
    expect(promoted?.promotedByEmail).toBe(operator.email);
    expect(promoted?.promotedFromRepo).toBe('motir-projects/acme-booking-web');
    expect(promoted?.isDefault).toBe(false);
    expect(promoted?.retirement).toMatchObject({
      byEmail: operator.email,
      reason: 'Replaced by the v2 booking starter',
    });

    const orphan = page.rows.find((r) => r.entry.key === 'gone-source');
    expect(orphan?.promotedByEmail).toBeNull();
    expect(orphan?.promotedFromRepo).toBeNull();
    expect(orphan?.retirement).toBeNull();
  });
});

describe("the promote form's picker", () => {
  it('lists only repositories Motir created, the held ones marked with why, audited', async () => {
    const ready = await motirRow('ready-web');
    const proposed = await motirRow('proposed-web', { state: 'proposed' });
    const leaving = await motirRow('leaving-web', { takeoverState: 'requested' });
    const own = await motirRow('their-own', {
      state: 'connected',
      seedSource: SEED_SOURCE_ORGANIZATION,
    });

    const support = await signInAs('support');
    await expect((await fresh()).console.listPromotionSources(support)).rejects.toMatchObject({
      name: 'NotPlatformStaffError',
    });

    vi.resetModules();
    const operator = await signInAs('operator');
    const sources = await (await fresh()).console.listPromotionSources(operator);
    const byId = new Map(sources.map((s) => [s.id, s]));

    expect(byId.get(ready.id)).toMatchObject({
      repoRef: 'motir-projects/ready-web',
      role: 'web',
      unavailable: null,
    });
    expect(byId.get(proposed.id)).toMatchObject({ repoRef: null, unavailable: 'not_created' });
    expect(byId.get(leaving.id)?.unavailable).toBe('leaving');
    expect(byId.has(own.id)).toBe(false);
    expect(await auditRows('seed_registry.promote_sources_read')).toHaveLength(1);
  });
});
