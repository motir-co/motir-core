import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `app/(admin)/layout.tsx` — the route segment's gate (MOTIR-2896 ·
// `docs/decisions/platform-staff-auth.md` §4).
//
// The layout is the single choke point for every page in the group, so the
// assertion is about what it DOES with each principal, not about what the gate
// beneath it returns (`platformStaffGate.test.ts` covers that). Three denial
// cases, one per acceptance criterion, each ending in `notFound()` — the
// ordinary app 404, indistinguishable from a route that does not exist.
//
// `notFound()` is stubbed rather than driven through the real renderer: what is
// being asserted is that the layout CALLS it, and Next's own implementation
// throwing a routing sentinel would only add a digest string to match on.

const notFoundCalls: number[] = [];
class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: vi.fn(() => {
    notFoundCalls.push(1);
    throw new NotFoundSentinel();
  }),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  // The layout needs the shell's labels, not a locale negotiation. Returning the
  // key keeps every label non-empty and lets the "no response body says 403"
  // assertion below read the real rendered tree.
  getTranslations: vi.fn(async () => (key: string) => key),
}));

// Warm the `(admin)` module graph ONCE, outside any case's clock. It reaches the
// design-system package through `AdminShell`, and the first transform of that
// graph costs more than the suite's 15s per-test timeout on a cold runner — so
// without this the failure lands on whichever case happens to run first, and
// says nothing about that case. `vi.resetModules()` clears the module REGISTRY,
// not vitest's transform cache, so every later import is cheap.
beforeAll(async () => {
  await import('@/app/(admin)/layout');
}, 180_000);

beforeEach(async () => {
  vi.resetModules();
  notFoundCalls.length = 0;
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Re-import the layout so `requirePlatformStaff`'s per-request cache is empty. */
async function renderAdminLayout() {
  const mod = await import('@/app/(admin)/layout');
  return mod.default({ children: null });
}

describe('the (admin) layout returns 404 for', () => {
  it('(a) an anonymous request', async () => {
    currentSession = null;
    await expect(renderAdminLayout()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(notFoundCalls).toHaveLength(1);
  });

  it('(b) a signed-in tenant member', async () => {
    const owner = await createTestUser({ email: 'owner@example.com' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const member = await createTestUser({ email: 'member@example.com' });
    await workspacesService.addMember({
      userId: member.id,
      workspaceId: workspace.id,
      workspaceRole: 'member',
    });
    currentSession = { user: { id: member.id } };

    await expect(renderAdminLayout()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(notFoundCalls).toHaveLength(1);
  });

  it('(c) a tenant OWNER', async () => {
    const owner = await createTestUser({ email: 'boss@example.com' });
    await workspacesService.createWorkspace({ name: 'Acme', ownerUserId: owner.id });
    currentSession = { user: { id: owner.id } };

    await expect(renderAdminLayout()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(notFoundCalls).toHaveLength(1);
  });

  it('and writes NO audit row for any of them — a refusal is not console access', async () => {
    const owner = await createTestUser({ email: 'boss@example.com' });
    await workspacesService.createWorkspace({ name: 'Acme', ownerUserId: owner.id });
    currentSession = { user: { id: owner.id } };

    await expect(renderAdminLayout()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('the (admin) layout renders for platform staff', () => {
  it('returns the shell and audits the console entry', async () => {
    const staff = await createTestUser({ email: 'ops@moooon.net' });
    await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
    currentSession = { user: { id: staff.id } };

    const tree = await renderAdminLayout();
    expect(notFoundCalls).toHaveLength(0);
    expect(tree).toBeTruthy();

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('console.open');
    expect(rows[0]!.targetKind).toBe('platform');
    expect(rows[0]!.actorUserId).toBe(staff.id);
  });

  it('hands the shell an operator DTO — an email and a role, never the principal', async () => {
    const staff = await createTestUser({ email: 'ops@moooon.net' });
    await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'operator' } });
    currentSession = { user: { id: staff.id } };

    const tree = (await renderAdminLayout()) as { props: { operator: unknown } };
    expect(tree.props.operator).toEqual({ email: 'ops@moooon.net', role: 'operator' });
    expect(tree.props.operator).not.toHaveProperty('userId');
  });
});

describe('the 404 posture, asserted as absence', () => {
  it('no source under app/(admin) or lib/platform says 403 or "forbidden"', async () => {
    // The acceptance criterion is about what a RESPONSE says, and the only way a
    // response could say it is if a source file did. Read as text, over the whole
    // surface, so a future error page cannot reintroduce it in a file this suite
    // has no other reason to import.
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk('app/(admin)');
    walk('lib/platform');
    expect(files.length).toBeGreaterThan(3);

    for (const file of files) {
      // Skip the prose that EXPLAINS the posture — a comment saying "never a
      // 403" is the rule, not a violation of it. Only executable text counts,
      // so line comments and block comments are stripped first.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source, `${file} names 403`).not.toMatch(/\b403\b/);
      expect(source.toLowerCase(), `${file} says forbidden`).not.toContain('forbidden');
    }
  });

  it('`/admin` is absent from the proxy matcher — the redirect would prove it real', async () => {
    const { readFileSync } = await import('node:fs');
    const { config } = await import('@/proxy');
    expect(config.matcher).not.toContain('/admin');
    expect(config.matcher.some((m) => typeof m === 'string' && m.startsWith('/admin'))).toBe(false);
    // And the reasoning stays attached to the list, so the next person adding a
    // route does not "complete" it.
    expect(readFileSync('proxy.ts', 'utf8')).toContain('DELIBERATELY NOT HERE');
  });
});
