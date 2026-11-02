import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { roleMigrationReportRepository } from '@/lib/repositories/roleMigrationReportRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workspaceRoleDefinitionRepository } from '@/lib/repositories/workspaceRoleDefinitionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_WORKSPACE_ROLE_TIER, WORKSPACE_ROLES } from '@/lib/workspaces/roles';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { expectRestrictViolation } from './helpers/restrictViolation';

// Schema + tenancy + repository proof for the workspace role STORAGE (Story
// MOTIR-6168 · Subtask MOTIR-6457) — the EXPAND step. It covers only what that
// card ships:
//
//   * `workspace_role_definition` and `role_migration_report` are RLS-isolated by
//     workspace under the non-bypass `motir_app` role, and `WITH CHECK` refuses a
//     write naming another workspace;
//   * `workspace_membership.role_definition_id` REFUSES the delete of a role
//     somebody holds (the RESTRICT that is the point of the column);
//   * the new columns backfill NULL — nothing is migrated here;
//   * every repository leaf, including the paired-column writer
//     `setWorkspaceRole` and the manager count.
//
// ⚠️ THE FIXTURE HOLDS ROWS IN BOTH WORKSPACES ON PURPOSE. A read under a
// workspace context that returned every row would pass an assertion written
// against a one-tenant fixture; only a fixture whose scoped and unscoped answers
// DIFFER can tell a policy that bites from one that does not.
//
// RLS assertions run inside a transaction that drops to `motir_app`
// (PRODECT_FINDINGS #5: the dev/CI connection is a BYPASSRLS superuser).
// Constraint and repository-leaf tests ride the admin client, where a policy
// denial would replace the signal with noise.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  w1: string;
  w2: string;
  owner1: string;
  owner2: string;
  member1: string;
  roleW1: string;
  roleW2: string;
  reportW1: string;
  reportW2: string;
}

async function makeTenants(): Promise<Fixture> {
  const owner1 = await usersService.createUser({
    email: 'wrs-owner-1@example.com',
    password: 'hunter2hunter2',
    name: 'WRS Owner 1',
  });
  const owner2 = await usersService.createUser({
    email: 'wrs-owner-2@example.com',
    password: 'hunter2hunter2',
    name: 'WRS Owner 2',
  });
  const member1 = await usersService.createUser({
    email: 'wrs-member-1@example.com',
    password: 'hunter2hunter2',
    name: 'WRS Member 1',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'WRS 1', ownerUserId: owner1.id });
  const w2 = await workspacesService.createWorkspace({ name: 'WRS 2', ownerUserId: owner2.id });
  await adminDb.workspaceMembership.create({
    data: {
      userId: member1.id,
      workspaceId: w1.workspace.id,
      workspaceRole: 'member',
    },
  });
  const roleW1 = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: w1.workspace.id,
      name: 'Reviewer',
      permissions: ['project:browse', 'comment:add'],
    },
  });
  const roleW2 = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: w2.workspace.id, name: 'Reviewer', permissions: ['project:browse'] },
  });
  const reportW1 = await adminDb.roleMigrationReport.create({
    data: {
      workspaceId: w1.workspace.id,
      userId: member1.id,
      beforeJson: { workspaceRole: 'member', projects: [] },
      afterRole: 'viewer',
      reason: 'narrowest_kept',
    },
  });
  const reportW2 = await adminDb.roleMigrationReport.create({
    data: {
      workspaceId: w2.workspace.id,
      userId: owner2.id,
      beforeJson: { workspaceRole: 'owner', projects: [] },
      afterRole: 'manager',
      reason: 'org_admin_granted',
    },
  });
  return {
    w1: w1.workspace.id,
    w2: w2.workspace.id,
    owner1: owner1.id,
    owner2: owner2.id,
    member1: member1.id,
    roleW1: roleW1.id,
    roleW2: roleW2.id,
    reportW1: reportW1.id,
    reportW2: reportW2.id,
  };
}

/** Run `fn` as the non-bypass `motir_app` role, optionally bound to a workspace. */
async function asAppRole<T>(
  ctx: { workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('the new columns and tables land BESIDE the old ones', () => {
  it('a membership carries its workspace role, and no custom role for a built-in', async () => {
    // Since MOTIR-6561 the workspace role is NOT NULL, so the pre-6168 shape — a
    // row with only the legacy column — cannot be written any more; the
    // migration's own test (`tests/migrations/workspaceRoleNotNull.test.ts`)
    // holds that refusal.
    const fx = await makeTenants();
    const m = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: fx.member1, workspaceId: fx.w1 } },
    });
    expect(m?.workspaceRole).toBe('member');
    expect(m?.roleDefinitionId).toBeNull();
  });

  it('the vocabulary: three built-ins, and a custom role sits at the member tier', () => {
    expect(WORKSPACE_ROLES).toEqual(['manager', 'member', 'viewer']);
    expect(CUSTOM_WORKSPACE_ROLE_TIER).toBe('member');
  });
});

describe('RLS — workspace_role_definition and role_migration_report', () => {
  it("a context bound to W1 reads W1's rows only, from both tables", async () => {
    const fx = await makeTenants();
    const [roles, reports] = await asAppRole({ workspaceId: fx.w1 }, async (tx) => [
      await tx.workspaceRoleDefinition.findMany(),
      await tx.roleMigrationReport.findMany(),
    ]);
    expect((roles as { id: string }[]).map((r) => r.id)).toEqual([fx.roleW1]);
    expect((reports as { id: string }[]).map((r) => r.id)).toEqual([fx.reportW1]);
    // …while the unscoped truth holds both tenants' rows.
    expect(await adminDb.workspaceRoleDefinition.count()).toBe(2);
    expect(await adminDb.roleMigrationReport.count()).toBe(2);
  });

  it('with no workspace bound, both tables read EMPTY (the safe failure)', async () => {
    await makeTenants();
    const counts = await asAppRole({}, async (tx) => [
      await tx.workspaceRoleDefinition.count(),
      await tx.roleMigrationReport.count(),
    ]);
    expect(counts).toEqual([0, 0]);
  });

  it('a write naming ANOTHER workspace is refused by WITH CHECK, on both tables', async () => {
    const fx = await makeTenants();
    await expect(
      asAppRole({ workspaceId: fx.w1 }, (tx) =>
        workspaceRoleDefinitionRepository.create(
          { workspaceId: fx.w2, name: 'Smuggled', permissions: [] },
          tx,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asAppRole({ workspaceId: fx.w1 }, (tx) =>
        tx.roleMigrationReport.create({
          data: {
            workspaceId: fx.w2,
            userId: fx.owner2,
            beforeJson: {},
            afterRole: 'viewer',
            reason: 'mapped_narrower',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a W1 context cannot update or delete W2's role — the row is invisible, so nothing matches", async () => {
    const fx = await makeTenants();
    const { count } = await asAppRole({ workspaceId: fx.w1 }, (tx) =>
      tx.workspaceRoleDefinition.deleteMany({ where: { id: fx.roleW2 } }),
    );
    expect(count).toBe(0);
    expect(
      await adminDb.workspaceRoleDefinition.findUnique({ where: { id: fx.roleW2 } }),
    ).not.toBeNull();
  });
});

describe('the RESTRICT foreign key', () => {
  it('deleting a workspace role a membership still points at FAILS with a foreign-key error', async () => {
    const fx = await makeTenants();
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: fx.roleW1 },
        tx,
      ),
    );
    await expectRestrictViolation(
      adminDb.$transaction((tx) => workspaceRoleDefinitionRepository.delete(fx.roleW1, tx)),
    );
    expect(
      await adminDb.workspaceRoleDefinition.findUnique({ where: { id: fx.roleW1 } }),
    ).not.toBeNull();
  });

  it('a role nobody holds deletes, and a report row naming it keeps its row with the pointer cleared', async () => {
    const fx = await makeTenants();
    await adminDb.roleMigrationReport.update({
      where: { id: fx.reportW1 },
      data: { afterRoleDefinitionId: fx.roleW1 },
    });
    await adminDb.$transaction((tx) => workspaceRoleDefinitionRepository.delete(fx.roleW1, tx));
    const report = await adminDb.roleMigrationReport.findUnique({ where: { id: fx.reportW1 } });
    expect(report).not.toBeNull();
    expect(report?.afterRoleDefinitionId).toBeNull();
  });
});

describe('workspaceRoleDefinitionRepository', () => {
  it('lists a workspace’s roles by name, reads by id and by ids, updates, and counts holders', async () => {
    const fx = await makeTenants();
    const out = await asAppRole({ workspaceId: fx.w1 }, async (tx) => {
      const second = await workspaceRoleDefinitionRepository.create(
        { workspaceId: fx.w1, name: 'Auditor', permissions: ['project:browse'] },
        tx,
      );
      const listed = await workspaceRoleDefinitionRepository.findManyByWorkspace(fx.w1, tx);
      const byId = await workspaceRoleDefinitionRepository.findById(fx.roleW1, tx);
      const foreign = await workspaceRoleDefinitionRepository.findById(fx.roleW2, tx);
      const byIds = await workspaceRoleDefinitionRepository.findManyByIds(
        [fx.roleW1, second.id, fx.roleW2],
        tx,
      );
      const none = await workspaceRoleDefinitionRepository.findManyByIds([], tx);
      const renamed = await workspaceRoleDefinitionRepository.update(
        second.id,
        { name: 'Auditor (read)' },
        tx,
      );
      return { second, listed, byId, foreign, byIds, none, renamed };
    });
    expect(out.listed.map((r) => r.name)).toEqual(['Auditor', 'Reviewer']);
    expect(out.byId?.name).toBe('Reviewer');
    expect(out.foreign).toBeNull(); // W2's row is not visible from W1
    expect(out.byIds.map((r) => r.id).sort()).toEqual([fx.roleW1, out.second.id].sort());
    expect(out.none).toEqual([]);
    expect(out.renamed.name).toBe('Auditor (read)');
  });

  it('countHolders groups holders per role and omits a role nobody holds', async () => {
    const fx = await makeTenants();
    await adminDb.$transaction(async (tx) => {
      await workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: fx.roleW1 },
        tx,
      );
    });
    const counts = await adminDb.$transaction((tx) =>
      workspaceRoleDefinitionRepository.countHolders([fx.roleW1, fx.roleW2], tx),
    );
    expect(counts.get(fx.roleW1)).toBe(1);
    expect(counts.has(fx.roleW2)).toBe(false);
    const empty = await adminDb.$transaction((tx) =>
      workspaceRoleDefinitionRepository.countHolders([], tx),
    );
    expect(empty.size).toBe(0);
  });

  it('a duplicate (workspaceId, name) raises P2002, untranslated', async () => {
    const fx = await makeTenants();
    let caught: unknown;
    try {
      await adminDb.$transaction((tx) =>
        workspaceRoleDefinitionRepository.create(
          { workspaceId: fx.w1, name: 'Reviewer', permissions: [] },
          tx,
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });
});

describe('workspaceMembershipRepository — the workspace-role writers and readers', () => {
  it('setWorkspaceRole writes BOTH columns in one statement, and a built-in clears the pointer', async () => {
    const fx = await makeTenants();
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: 'member', roleDefinitionId: fx.roleW1 },
        tx,
      ),
    );
    let m = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: fx.member1, workspaceId: fx.w1 } },
    });
    expect([m?.workspaceRole, m?.roleDefinitionId]).toEqual(['member', fx.roleW1]);

    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: 'viewer', roleDefinitionId: null },
        tx,
      ),
    );
    m = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: fx.member1, workspaceId: fx.w1 } },
    });
    expect([m?.workspaceRole, m?.roleDefinitionId]).toEqual(['viewer', null]);
  });

  it('setWorkspaceRole issues exactly ONE statement against workspace_membership', async () => {
    const fx = await makeTenants();
    const statements: string[] = [];
    await adminDb.$transaction(async (tx) => {
      const spy = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === 'workspaceMembership') {
            return new Proxy(target.workspaceMembership, {
              get(t, p, r) {
                const v = Reflect.get(t, p, r);
                if (typeof v === 'function') {
                  return (...args: unknown[]) => {
                    statements.push(String(p));
                    return (v as (...a: unknown[]) => unknown).apply(t, args);
                  };
                }
                return v;
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      await workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: 'manager', roleDefinitionId: null },
        spy,
      );
    });
    expect(statements).toEqual(['update']);
  });

  it('countManagers counts workspace_role = manager rows only', async () => {
    const fx = await makeTenants();
    // The creator is written as a Manager since MOTIR-6462; demote W1's rows to
    // Member.
    await adminDb.workspaceMembership.updateMany({
      where: { workspaceId: fx.w1 },
      data: { workspaceRole: 'member' },
    });
    const before = await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.countManagers(fx.w1, tx),
    );
    // The W1 founder is `workspace_role = 'member'` now: not counted.
    expect(before).toBe(0);
    await adminDb.$transaction(async (tx) => {
      await workspaceMembershipRepository.setWorkspaceRole(
        fx.owner1,
        fx.w1,
        { workspaceRole: 'manager', roleDefinitionId: null },
        tx,
      );
      await workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: 'member', roleDefinitionId: null },
        tx,
      );
      await workspaceMembershipRepository.setWorkspaceRole(
        fx.owner2,
        fx.w2,
        { workspaceRole: 'manager', roleDefinitionId: null },
        tx,
      );
    });
    const after = await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.countManagers(fx.w1, tx),
    );
    expect(after).toBe(1);
  });

  it('findByUserAndWorkspaceWithRoleDefinition returns the membership with its custom role, or null', async () => {
    const fx = await makeTenants();
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        fx.member1,
        fx.w1,
        { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: fx.roleW1 },
        tx,
      ),
    );
    const [withRole, builtIn, missing] = await adminDb.$transaction(async (tx) => [
      await workspaceMembershipRepository.findByUserAndWorkspaceWithRoleDefinition(
        fx.member1,
        fx.w1,
        tx,
      ),
      await workspaceMembershipRepository.findByUserAndWorkspaceWithRoleDefinition(
        fx.owner1,
        fx.w1,
        tx,
      ),
      await workspaceMembershipRepository.findByUserAndWorkspaceWithRoleDefinition(
        fx.member1,
        fx.w2,
        tx,
      ),
    ]);
    expect(withRole?.roleDefinition?.name).toBe('Reviewer');
    expect(withRole?.roleDefinition?.permissions).toEqual(['project:browse', 'comment:add']);
    expect(builtIn?.roleDefinition).toBeNull();
    expect(missing).toBeNull();
  });
});

describe('roleMigrationReportRepository', () => {
  it('lists a workspace’s OPEN rows newest first, in pages, and a dismiss removes one from the list', async () => {
    const fx = await makeTenants();
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      await adminDb.roleMigrationReport.create({
        data: {
          workspaceId: fx.w1,
          userId: fx.owner1,
          beforeJson: { i },
          afterRole: 'manager',
          reason: 'project_role_dropped',
          createdAt: new Date(t0 + (i + 1) * 1000),
        },
      });
    }
    const out = await asAppRole({ workspaceId: fx.w1 }, async (tx) => {
      const page1 = await roleMigrationReportRepository.listOpenByWorkspace(
        fx.w1,
        { limit: 2 },
        tx,
      );
      const page2 = await roleMigrationReportRepository.listOpenByWorkspace(
        fx.w1,
        { cursor: page1.nextCursor, limit: 2 },
        tx,
      );
      const first = await roleMigrationReportRepository.dismiss(fx.reportW1, tx);
      const again = await roleMigrationReportRepository.dismiss(fx.reportW1, tx);
      const foreign = await roleMigrationReportRepository.dismiss(fx.reportW2, tx);
      const afterDismiss = await roleMigrationReportRepository.listOpenByWorkspace(fx.w1, {}, tx);
      return { page1, page2, first, again, foreign, afterDismiss };
    });
    expect(out.page1.rows.map((r) => (r.beforeJson as { i: number }).i)).toEqual([2, 1]);
    expect(out.page1.nextCursor).not.toBeNull();
    expect(out.page2.rows).toHaveLength(2);
    expect(out.page2.nextCursor).toBeNull();
    expect(out.first).toBe(true);
    expect(out.again).toBe(false); // idempotent: the first timestamp stands
    expect(out.foreign).toBe(false); // W2's row is invisible from W1
    expect(out.afterDismiss.rows.map((r) => r.id)).not.toContain(fx.reportW1);
    expect(out.afterDismiss.rows).toHaveLength(3);
  });
});
