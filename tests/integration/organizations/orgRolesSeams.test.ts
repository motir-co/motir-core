import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../../helpers/adminDb';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// THE SEAMS THE UNIT SUITES MOCK (Story MOTIR-6167 · MOTIR-6315). Each code card
// of the story tested its own half of these; none could test the join, because
// the join is two cards' code meeting. Real Postgres throughout. Run it under
// `TEST_DB_APP_ROLE=1` (the non-bypass role), as the story asks: two of the
// four cross RLS, and a policy that admits too little answers with an EMPTY
// read, not an error.
//
// The boundary mocks are the session (no cookie in the test env) and the
// post-commit seat-sync ENQUEUE that membership writes fire.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const workspaceRoute =
  await import('@/app/api/organizations/[orgId]/workspaces/[workspaceId]/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { accountDeletionService } = await import('@/lib/services/accountDeletionService');
const { accountErasureSweepService } = await import('@/lib/services/accountErasureSweepService');
const { organizationMembershipRepository } =
  await import('@/lib/repositories/organizationMembershipRepository');
const { withOrgContext } = await import('@/lib/organizations/context');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { createTestProject } = await import('../../fixtures/projectFixtures');
const { truncateAuthTables, truncateCodeGraphOffboarding, truncateJobRuns } =
  await import('../../helpers/db');
const { OwnershipChangedError } = await import('@/lib/organizations/errors');

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateCodeGraphOffboarding();
  session.current = null;
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterEach(async () => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  await truncateJobRuns();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

/** An org with an Owner, an Admin and a Member. */
async function makeOrg() {
  const owner = await createTestUser();
  const { workspace: home } = await workspacesService.createWorkspace({
    name: 'Home',
    ownerUserId: owner.id,
  });
  const organizationId = home.organizationId;
  const orgName = (await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } }))
    .name;
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return { organizationId, orgName, home, owner, admin, member };
}

async function ownersOf(organizationId: string): Promise<string[]> {
  const rows = await adminDb.organizationMembership.findMany({
    where: { organizationId, role: 'owner' },
  });
  return rows.map((r) => r.userId);
}

describe('seam 1 — a transfer, read straight back through the reach resolver', () => {
  it('the new Owner reaches a workspace they never joined the moment the transfer commits; the old one keeps an Admin’s reach', async () => {
    const org = await makeOrg();
    // A workspace the OWNER creates and then leaves, so neither the old Owner
    // nor the Admin holds a membership in it: whoever reaches it, reaches it as
    // the Owner.
    const { workspace: vault } = await workspacesService.createWorkspace({
      name: 'Vault',
      ownerUserId: org.owner.id,
      organizationId: org.organizationId,
    });
    const project = await createTestProject({
      workspaceId: vault.id,
      actorUserId: org.owner.id,
      identifier: 'VLT',
    });
    await setProjectAccess(adminDb, project.id, 'members');
    await adminDb.workspaceMembership.deleteMany({ where: { workspaceId: vault.id } });

    // Before: the Owner reaches it as the Owner, and the Admin as an Admin —
    // an org Admin carries the Manager role into every workspace (MOTIR-6168,
    // overturning reading R1).
    expect(
      (await organizationsService.resolveWorkspaceAccess(org.owner.id, vault.id))?.isOrgOwner,
    ).toBe(true);
    expect(await organizationsService.resolveWorkspaceAccess(org.admin.id, vault.id)).toMatchObject(
      {
        effectiveRole: 'manager',
        isOrgOwner: false,
        reachesEveryWorkspace: true,
      },
    );

    await organizationsService.transferOwnership({
      organizationId: org.organizationId,
      actorUserId: org.owner.id,
      toUserId: org.admin.id,
      confirmName: org.orgName,
    });

    expect(await ownersOf(org.organizationId)).toEqual([org.admin.id]);
    // After: the reach moved with the role — through the workspace tier AND
    // the project tier's permission input, on a private project.
    const newOwner = await organizationsService.resolveWorkspaceAccess(org.admin.id, vault.id);
    expect(newOwner).toMatchObject({
      effectiveRole: 'manager',
      workspaceRole: null,
      isOrgOwner: true,
    });
    await expect(
      projectAccessService.assertPermission(
        project.id,
        { userId: org.admin.id, workspaceId: vault.id },
        'work_item:edit',
      ),
    ).resolves.toBeUndefined();
    // The previous Owner is an Admin now, and still reaches it — as an Admin, no
    // longer as the Owner — at the access resolver and at the shell's read.
    expect(await organizationsService.resolveWorkspaceAccess(org.owner.id, vault.id)).toMatchObject(
      {
        effectiveRole: 'manager',
        isOrgOwner: false,
      },
    );
    expect((await workspacesService.getWorkspaceSummary(vault.id, org.owner.id))?.id).toBe(
      vault.id,
    );
    expect((await workspacesService.getWorkspaceSummary(vault.id, org.admin.id))?.id).toBe(
      vault.id,
    );
  });
});

describe('seam 2 — a workspace removed at the org tier, its survivals read back', () => {
  it('an Admin outside the workspace removes it; the offboarding row and the hostname reservation are both written', async () => {
    const org = await makeOrg();
    const { workspace: spare } = await workspacesService.createWorkspace({
      name: 'Spare',
      ownerUserId: org.owner.id,
      organizationId: org.organizationId,
    });
    const project = await createTestProject({
      workspaceId: spare.id,
      actorUserId: org.owner.id,
      identifier: 'SPR',
    });
    // Cloud on only now: the plan caps are cloud-only too, and would have
    // refused the second workspace above.
    process.env['MOTIR_CLOUD'] = 'true';
    process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = 'motir.test';
    await publicSubdomainService.claim(spare.id, 'spare-co', org.owner.id);
    // Held two days, so the delete must reserve it: a label held under 24 hours
    // returns to the pool at once (§8 Amendment 3 rule 3).
    await adminDb.publicAddress.updateMany({
      where: { workspaceId: spare.id, kind: 'workspace_subdomain' },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    expect(
      await adminDb.workspaceMembership.count({
        where: { workspaceId: spare.id, userId: org.admin.id },
      }),
    ).toBe(0);

    session.current = { user: { id: org.admin.id, email: org.admin.email } };
    const res = await workspaceRoute.DELETE(
      new Request(
        `http://localhost/api/organizations/${org.organizationId}/workspaces/${spare.id}`,
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ orgId: org.organizationId, workspaceId: spare.id }) },
    );

    expect(res.status).toBe(200);
    expect(await adminDb.workspace.count({ where: { id: spare.id } })).toBe(0);
    const offboarding = await adminDb.codeGraphOffboarding.findMany({
      where: { coreWorkspaceId: spare.id },
    });
    expect(offboarding).toHaveLength(1);
    expect(offboarding[0]).toMatchObject({
      reason: 'workspace_deleted',
      coreProjectId: project.id,
    });
    expect(await adminDb.publicHostnameReservation.count()).toBe(1);
  });
});

describe('seam 3 — the account-erasure sweep, after the create/remove gate change', () => {
  it('still deletes a plain Member’s sole-member workspace, which the Admin door would refuse them', async () => {
    const org = await makeOrg();
    // The Owner makes a workspace and leaves the Member alone in it.
    const { workspace: solo } = await workspacesService.createWorkspace({
      name: 'Solo',
      ownerUserId: org.owner.id,
      organizationId: org.organizationId,
    });
    await workspacesService.addMember({ userId: org.member.id, workspaceId: solo.id });
    await adminDb.workspaceMembership.deleteMany({
      where: { workspaceId: solo.id, userId: org.owner.id },
    });
    // Schedule the Member's deletion and back-date it so the sweep finds it due.
    const dto = await accountDeletionService.scheduleAccountDeletion(org.member.id);
    const requestedAt = new Date(Date.now() - 31 * DAY_MS);
    await adminDb.accountDeletionRequest.update({
      where: { id: dto.id },
      data: { requestedAt, erasureDueAt: new Date(requestedAt.getTime() + 30 * DAY_MS) },
    });

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ erased: 1, failed: 0 });
    expect(summary.workspacesDeleted).toBe(1);
    expect(await adminDb.workspace.count({ where: { id: solo.id } })).toBe(0);
    // The org's own workspace, which the Member shared, stands.
    expect(await adminDb.workspace.count({ where: { id: org.home.id } })).toBe(1);
    expect(await ownersOf(org.organizationId)).toEqual([org.owner.id]);
  });
});

// Three rounds, each resetting the fixture — a loop of truncates, which is
// lock-wait bound under shard contention (MOTIR-4089). Measured at 2.5 s alone
// (TEST_DB_APP_ROLE=1, one worker); the budget is ~24x that, the headroom the
// other per-round race suites carry for a contended CI shard.
const RACE_TEST_TIMEOUT_MS = 60_000;

describe('seam 4 — the one-Owner index raced from two paths at once', () => {
  it(
    'a transfer and a direct repository write racing for the Owner slot end with exactly one Owner',
    { timeout: RACE_TEST_TIMEOUT_MS },
    async () => {
      for (let round = 0; round < 3; round++) {
        await truncateAuthTables();
        const org = await makeOrg();

        const transfer = organizationsService.transferOwnership({
          organizationId: org.organizationId,
          actorUserId: org.owner.id,
          toUserId: org.admin.id,
          confirmName: org.orgName,
        });
        // The raw path no service guards: a repository write straight to `owner`.
        // Only the partial unique index stands in its way.
        const rawWrite = withOrgContext(
          { userId: org.owner.id, organizationId: org.organizationId },
          (tx) =>
            organizationMembershipRepository.updateRole(
              org.organizationId,
              org.member.id,
              'owner',
              tx,
            ),
        );
        const [t, w] = await Promise.allSettled([transfer, rawWrite]);

        const owners = await ownersOf(org.organizationId);
        expect(owners, `round ${round}`).toHaveLength(1);
        // The raw write can never win while an Owner exists: it is refused by the
        // index, whichever way the two interleave.
        expect(w.status, `round ${round}`).toBe('rejected');
        if (w.status === 'rejected') {
          expect(String((w.reason as Error)?.message ?? w.reason)).toMatch(
            /unique|owner_key|P2002|23505/i,
          );
        }
        if (t.status === 'fulfilled') {
          expect(owners).toEqual([org.admin.id]);
        } else {
          // The only legitimate refusal is the typed one.
          expect(t.reason).toBeInstanceOf(OwnershipChangedError);
          expect(owners).toEqual([org.owner.id]);
        }
      }
    },
  );
});
