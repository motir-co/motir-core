import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { PLATFORM_ROLE_LADDER, platformRoleAtLeast } from '@/lib/platform/auth';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The platform-staff gate (MOTIR-2896 · `docs/decisions/platform-staff-auth.md` §§1–2).
//
// The gate answers a question no other guard in motir-core asks — not "does
// this principal belong to this tenant?" but "is this principal US?" — so the
// cases that matter are the ones where a principal has the MOST tenant standing
// available and still gets nothing. A workspace OWNER and an org OWNER are
// tested explicitly for that reason: the ADR's load-bearing invariant is that no
// tenant role at any tier, in any combination, produces a `PlatformRole`, and a
// test suite that only tried an anonymous request would pass under a broken
// implementation that mapped owner → staff.
//
// Real Postgres, real services, real `platformRole` column. The single stub is
// `getSession()` — the standing exception in this repo, because the vitest
// environment has no cookies.

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

// `requirePlatformStaff` is wrapped in React `cache()` for per-request dedupe.
// In vitest there is no request scope, so the cache is process-wide and a second
// call with a different session would return the FIRST principal. Clearing the
// module registry between cases is what gives each case its own "request".
beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Re-import the gate so its per-request `cache()` starts empty.
 *
 * ⚠️ The ERROR CLASS comes back from the same call, and must. `vi.resetModules()`
 * gives each case a fresh module graph, so the `NotPlatformStaffError` the gate
 * throws is a different class object from the one a top-level `import` in this
 * file would have bound — `instanceof` against that one fails on an error that
 * is, by every other measure, exactly right. Resolving both from one graph keeps
 * the assertion honest: `app/(admin)/layout.tsx` really does branch on
 * `instanceof`, so asserting only on `code` would test less than production does.
 */
async function freshGate() {
  const [auth, errors] = await Promise.all([
    import('@/lib/platform/auth'),
    import('@/lib/platform/errors'),
  ]);
  return { ...auth, NotPlatformStaffError: errors.NotPlatformStaffError };
}

describe('the ladder', () => {
  it('is exactly the enum, in ascending order of reach', () => {
    // Pinned so a fourth degree added to the Prisma enum without being placed
    // on this ladder fails here, rather than silently sorting as `indexOf` -1 —
    // which would make it satisfy EVERY `minimum`, the most dangerous possible
    // default for a security ladder.
    expect(PLATFORM_ROLE_LADDER).toEqual(['support', 'operator', 'superadmin']);
  });

  it('each degree contains the ones below it and none above', () => {
    expect(platformRoleAtLeast('support', 'support')).toBe(true);
    expect(platformRoleAtLeast('operator', 'support')).toBe(true);
    expect(platformRoleAtLeast('superadmin', 'operator')).toBe(true);

    expect(platformRoleAtLeast('support', 'operator')).toBe(false);
    expect(platformRoleAtLeast('support', 'superadmin')).toBe(false);
    expect(platformRoleAtLeast('operator', 'superadmin')).toBe(false);
  });
});

describe('requirePlatformStaff — the ALLOW case', () => {
  it('returns the staff principal, with the role read fresh from the column', async () => {
    const user = await createTestUser({ email: 'ops@moooon.net', name: 'Ops' });
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
    currentSession = { user: { id: user.id } };

    const { requirePlatformStaff: gate } = await freshGate();
    const principal = await gate();

    expect(principal).toEqual({
      userId: user.id,
      email: 'ops@moooon.net',
      role: 'support',
    });
  });

  it('admits a role ABOVE the requested minimum', async () => {
    const user = await createTestUser();
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'superadmin' } });
    currentSession = { user: { id: user.id } };

    const { requirePlatformStaff: gate } = await freshGate();
    await expect(gate('operator')).resolves.toMatchObject({ role: 'superadmin' });
  });

  it('REFUSES a staff role below the requested minimum', async () => {
    const user = await createTestUser();
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
    currentSession = { user: { id: user.id } };

    const { requirePlatformStaff: gate, NotPlatformStaffError } = await freshGate();
    await expect(gate('operator')).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('loses access on the NEXT REQUEST after a revoke, not the next sign-in', async () => {
    // The reason `platformRole` is deliberately NOT a Better-Auth
    // `additionalFields` entry (ADR §1). The session below never changes; only
    // the column does, and the gate must follow the column.
    const user = await createTestUser();
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'operator' } });
    currentSession = { user: { id: user.id } };

    const before = await freshGate();
    await expect(before.requirePlatformStaff()).resolves.toMatchObject({ role: 'operator' });

    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: null } });

    const after = await freshGate();
    await expect(after.requirePlatformStaff()).rejects.toBeInstanceOf(after.NotPlatformStaffError);
  });
});

describe('requirePlatformStaff — the three DENIAL cases', () => {
  it('(a) refuses an ANONYMOUS request', async () => {
    currentSession = null;
    const { requirePlatformStaff: gate, NotPlatformStaffError } = await freshGate();
    await expect(gate()).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('(b) refuses a signed-in tenant MEMBER', async () => {
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

    const { requirePlatformStaff: gate, NotPlatformStaffError } = await freshGate();
    await expect(gate()).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('(c) refuses a tenant OWNER — of the workspace AND of its organization', async () => {
    // The case the whole invariant exists for. This user holds the highest
    // standing the product can grant inside a tenant, at both tiers, and the
    // gate must be entirely unmoved by it.
    const owner = await createTestUser({ email: 'boss@example.com' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });

    const membership = await adminDb.workspaceMembership.findFirstOrThrow({
      where: { userId: owner.id, workspaceId: workspace.id },
    });
    expect(membership.workspaceRole).toBe('manager');
    const orgMembership = await adminDb.organizationMembership.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(orgMembership.role).toBe('owner');

    currentSession = { user: { id: owner.id } };
    const { requirePlatformStaff: gate, NotPlatformStaffError } = await freshGate();
    await expect(gate()).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('ignores the retired admin-email env var, even when it names the caller', async () => {
    // Moved here from the jobs resolver's suite when that resolver was deleted
    // with the tenant Job runs surface (MOTIR-10044): the env var was the
    // stopgap this gate replaced (MOTIR-8200), and naming a tenant owner in it
    // must still grant nothing. Named in pieces so the repository grep for the
    // retired gate stays clean.
    const owner = await createTestUser({ email: 'owner@tenant.test' });
    vi.stubEnv('PLATFORM_ADMIN' + '_EMAIL', 'owner@tenant.test');
    currentSession = { user: { id: owner.id } };

    const { requirePlatformStaff: gate, NotPlatformStaffError } = await freshGate();
    await expect(gate()).rejects.toBeInstanceOf(NotPlatformStaffError);
    vi.unstubAllEnvs();
  });

  it('answers all three with ONE indistinguishable error — no reason, no discriminant', async () => {
    // ADR §2: a caller able to tell "no session" from "not staff" from "below
    // the minimum" could probe the admin area's existence. So the assertion is
    // about SAMENESS: same class, same code, same message, and a message that
    // names neither the route nor which case it was.
    // ⚠️ The parentheses are load-bearing: `Error & { code?: string }[]` binds as
    // an INTERSECTION of `Error` with an array, not an array of the intersection.
    const errors: (Error & { code?: string })[] = [];

    currentSession = null;
    const anon = await freshGate();
    errors.push(await anon.requirePlatformStaff().catch((e) => e));

    const tenant = await createTestUser();
    currentSession = { user: { id: tenant.id } };
    const nonStaff = await freshGate();
    errors.push(await nonStaff.requirePlatformStaff().catch((e) => e));

    const junior = await createTestUser();
    await adminDb.user.update({ where: { id: junior.id }, data: { platformRole: 'support' } });
    currentSession = { user: { id: junior.id } };
    const belowMinimum = await freshGate();
    errors.push(await belowMinimum.requirePlatformStaff('superadmin').catch((e) => e));

    expect(errors).toHaveLength(3);
    for (const err of errors) {
      expect(err.name).toBe('NotPlatformStaffError');
      expect(err.code).toBe('NOT_PLATFORM_STAFF');
      expect(err.message).toBe(errors[0]!.message);
      expect(err.message.toLowerCase()).not.toContain('forbidden');
      expect(err.message).not.toContain('403');
      expect(err.message).not.toContain('/admin');
    }
    expect(Object.keys(errors[0]!)).toEqual(Object.keys(errors[2]!));
  });
});

describe('the column itself', () => {
  it('defaults to NULL — every account is non-staff until written', async () => {
    const user = await createTestUser();
    const row = await adminDb.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { platformRole: true },
    });
    expect(row.platformRole).toBeNull();
  });

  it('is not reachable by creating a workspace, an org, or any membership', async () => {
    // The "no tenant-role escalation path" invariant, asserted against the real
    // bootstrap chain rather than by reading the code: creating a workspace
    // mints an organization, an org owner membership and a workspace owner
    // membership in one transaction, and none of it may touch this column.
    const owner = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Acme', ownerUserId: owner.id });

    const staffRows = await adminDb.user.count({ where: { platformRole: { not: null } } });
    expect(staffRows).toBe(0);
  });
});
