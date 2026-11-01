import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import { adminDb } from './helpers/adminDb';

// Service test for entitlementsService (Subtask 8.1.11) — the §4 PM-core
// entitlement caps. Everything is exercised against the REAL Postgres (the
// no-mocks rule); the only toggle is the `MOTIR_CLOUD` env flag (the ADR §6
// cloud-only gate). Proves each gate (work items / projects / workspaces / org
// creation / per-file size / total storage), the §4 divergences (caps key off
// the scaled-tracker subscription NOT the AI PlanTier; the work-item count is
// ALL items incl. archived), the cloud-only inertness, AND the FOR UPDATE
// real-concurrency contract for the headline work-item cap.

const { entitlementsService } = await import('@/lib/services/entitlementsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { workItemRepository } = await import('@/lib/repositories/workItemRepository');
const { organizationRepository } = await import('@/lib/repositories/organizationRepository');
const { organizationMembershipRepository } =
  await import('@/lib/repositories/organizationMembershipRepository');
const { userRepository } = await import('@/lib/repositories/userRepository');
const { ORGANIZATION_ROLE } = await import('@/lib/organizations/roles');
const { makeWorkItemFixture, createTestUser, nextTestPosition } = await import('./fixtures');
const { keyForAppend } = await import('@/lib/workItems/positioning');
const { truncateAuthTables } = await import('./helpers/db');
const { CapLockUnavailableError, EntitlementExceededError } = await import('@/lib/billing/errors');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { organizationsService } = await import('@/lib/services/organizationsService');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const SCALED: ScaledTrackerSubscription = {
  status: 'active',
  priceId: 'tracker_annual',
  currentPeriodEnd: 1893456000,
};
const CANCELED: ScaledTrackerSubscription = { ...SCALED, status: 'canceled' };

async function orgIdOf(workspaceId: string): Promise<string> {
  return (await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).organizationId;
}

async function setTier(organizationId: string, sub: ScaledTrackerSubscription): Promise<void> {
  await adminDb.organization.update({
    where: { id: organizationId },
    data: { scaledTrackerSubscription: sub as unknown as Prisma.InputJsonValue },
  });
}

/** One-line rendering of a settled rejection, for the race test's failure census —
 *  an `EntitlementExceededError` and a `40P01 deadlock detected` are different
 *  worlds and the split alone shows neither. */
function reasonLabel(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message.slice(0, 120)}`;
  return String(reason);
}

/**
 * A RENDEZVOUS for `parties` transactions (MOTIR-3710). Every caller blocks
 * until the last one arrives, then all are released together.
 *
 * ⚠️ THIS IS WHAT MAKES THE RACE BELOW A RACE. `Promise.allSettled` on its own
 * does NOT overlap two interactive transactions: the first reaches its count,
 * its create AND its COMMIT before the second counts, so the second legitimately
 * sees the limit and rejects — with or without a lock. The test then passes on a
 * guard that does nothing, which is precisely what happened here for months.
 * Arriving on the FIRST line inside `withWorkspaceContext` means both
 * transactions are open and GUC-bound before either can touch the cap.
 *
 * The deadline is not a fallback that weakens the overlap — it REJECTS, so a run
 * where the second transaction never arrived says so instead of hanging until
 * Vitest's timeout and leaving a reader to guess which world they are in (the
 * same reason MOTIR-3707 put a census on the assertions below). It is under
 * Prisma's 5 000 ms interactive-transaction budget on purpose.
 */
function rendezvous(parties: number, deadlineMs = 3_000): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++arrived === parties) release();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `rendezvous: only ${arrived}/${parties} transactions arrived within ${deadlineMs}ms ` +
                '— the race did not overlap, so it proves nothing about the lock',
            ),
          ),
        deadlineMs,
      );
    });
    try {
      await Promise.race([gate, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Flag the org as the META org (moooon B.V.) — the `meta` tier, every cap lifted. */
async function setMeta(organizationId: string): Promise<void> {
  await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });
}

/** Bulk-seed `count` top-level task rows in the fixture's project (one INSERT —
 *  fast even at the 250 cap). `archived` stamps `archivedAt` so the §4
 *  "archived items still count" divergence is testable. */
async function seedWorkItems(
  fx: { workspaceId: string; projectId: string; projectIdentifier: string; ownerId: string },
  count: number,
  opts: { archived?: boolean } = {},
): Promise<void> {
  const archivedAt = opts.archived ? new Date() : null;
  // Real fractional-index positions, chained in creation order — never a
  // zero-padded number (see `nextTestPosition`'s warning; MOTIR-2196). Chained
  // in memory rather than re-reading per row: this seeds hundreds of items.
  let position = await nextTestPosition(fx.projectId);
  const rows = Array.from({ length: count }, (_, i) => {
    const row = {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      kind: 'task' as const,
      key: i + 1,
      identifier: `${fx.projectIdentifier}-${i + 1}`,
      title: `Item ${i + 1}`,
      reporterId: fx.ownerId,
      position,
      archivedAt,
    };
    position = keyForAppend(position);
    return row;
  });
  await adminDb.workItem.createMany({ data: rows });
}

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('entitlementsService — work-item cap (§4.1)', () => {
  it('passes at 249 and blocks at the 250-item ceiling for a free org', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    await seedWorkItems(fx, 249);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();

    await adminDb.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 250,
        identifier: `${fx.projectIdentifier}-250`,
        title: 'Item 250',
        reporterId: fx.ownerId,
        position: await nextTestPosition(fx.projectId),
      },
    });

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).rejects.toMatchObject({ name: 'EntitlementExceededError', entitlement: 'work_items' });
  });

  it('counts ARCHIVED items too — archiving does NOT free room (§4 divergence)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedWorkItems(fx, 250, { archived: true });

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  it('lifts the cap for a scaled (active scaled-tracker) org', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);
    await seedWorkItems(fx, 250);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('lifts the cap for the META org (moooon B.V.) even with NO subscription', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setMeta(orgId); // the `meta` tier — every cap lifted, never billed
    await seedWorkItems(fx, 250);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('a canceled scaled-tracker subscription is treated as free (caps re-apply)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, CANCELED);
    await seedWorkItems(fx, 250);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  it('is INERT off-cloud — no cap when MOTIR_CLOUD is unset', async () => {
    delete process.env['MOTIR_CLOUD'];
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedWorkItems(fx, 300);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkItemCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('createWorkItem itself enforces the cap (end-to-end wiring)', async () => {
    const fx = await makeWorkItemFixture();
    await seedWorkItems(fx, 250);
    // Advance the project key counter past the bulk-seeded rows so the next
    // create allocates a FREE key (251) — proving the cap, not a key collision.
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { lastWorkItemNumber: 250 },
    });

    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'over' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  // The required real-concurrency test: two creates racing at the 249→250 edge.
  // The org-row FOR UPDATE lock must serialize them so EXACTLY ONE lands the
  // 250th item and the other is rejected — never a 251-item overage (the
  // warm-pool TOCTOU a count-then-write with no lock would allow).
  //
  // ⚠️ THE RACE USED TO BE WEAKER THAN ITS NAME — MOTIR-3707 measured it,
  // MOTIR-3710 fixed both halves. `Promise.allSettled` on its own does NOT
  // overlap the two attempts: the first reaches its count, its create AND its
  // COMMIT before the second counts, so the second legitimately saw 250 and
  // rejected — with or without the lock. Deleting `lockByIdForUpdate` from
  // `assertWithinWorkItemCap` left this test GREEN. It is the `rendezvous`
  // barrier below that makes the two transactions actually overlap, and it is
  // the barrier that makes this test able to fail: on UNMODIFIED product code it
  // reported `finalCount=251, fulfilled=2, rejected=0`, because
  // `SELECT … FOR UPDATE` on `organization` matched zero rows under
  // `withWorkspaceContext` — the UPDATE policy `organization_mutate_active` reads
  // `app.organization_id`, which that context never bound.
  //
  // ⚠️ SO DO NOT REMOVE THE BARRIER TO "SIMPLIFY" THIS TEST. Without it the test
  // passes on a guard that does nothing, and the passing looks identical.
  //
  // ⚠️ THE ASSERTION ORDER IS LOAD-BEARING (MOTIR-3707) — do not reorder it back.
  // `fulfilled.length === 2` is produced by TWO different worlds and the split
  // alone cannot tell them apart: the lock did not serialize (a real 251-item
  // overage, a product defect) or `seedWorkItems` under-delivered (both creates
  // legitimately under the cap). The PROJECT ROW COUNT is the discriminator, so
  // it is asserted BEFORE the race (the precondition, world b) and measured
  // BEFORE the split assertion can throw (the outcome, world a). A red run then
  // names its own world instead of stating the one fact both worlds share —
  // which is what made this test's three reds cost a hand triage each.
  it('serializes concurrent creates at the boundary via FOR UPDATE (no overage)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedWorkItems(fx, 249);

    // WORLD (b) — the fixture. Assert the precondition the race is premised on,
    // here, where the observed count is the failure message. Without this the
    // same shortfall surfaces 30 lines down as an ambiguous 2-fulfilled race.
    const seededCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(
      seededCount,
      'precondition: seedWorkItems(fx, 249) must land exactly 249 rows before the race',
    ).toBe(249);

    // Both positions are minted BEFORE the race, and distinct: two racing
    // transactions would each read the same last sibling and mint the same
    // key, and duplicate positions are the second half of the trap
    // `nextTestPosition` warns about (keyBetween(k, k) throws).
    const racePosition = await nextTestPosition(fx.projectId);
    const positions: Record<number, string> = {
      250: racePosition,
      251: keyForAppend(racePosition),
    };

    // The concurrency probe runs at production altitude too: `createWorkItem` opens
    // withWorkspaceContext and does the cap-assert + the create inside it, so the
    // FOR-UPDATE serialization under test is the one production actually gets.
    // ⚠️ THE BARRIER IS THE INSTRUMENT (MOTIR-3710). Arriving on the FIRST line
    // inside the context means neither transaction can count, create or COMMIT
    // until both are open and GUC-bound — which is the overlap `Promise.allSettled`
    // alone never produced. Measured on this file before the fix, with the barrier
    // and UNMODIFIED product code: finalCount=251, fulfilled=2, rejected=0.
    const arrive = rendezvous(2);
    const attempt = (key: number) =>
      withWorkspaceContext(fx.ctx, async (tx) => {
        await arrive();
        await entitlementsService.assertWithinWorkItemCap(orgId, tx);
        await workItemRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            kind: 'task',
            key,
            identifier: `${fx.projectIdentifier}-${key}`,
            title: `race ${key}`,
            reporterId: fx.ownerId,
            position: positions[key]!,
          },
          tx,
        );
      });

    const results = await Promise.allSettled([attempt(250), attempt(251)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // WORLD (a) — the lock. MEASURED FIRST, before any assertion can throw, so
    // the number survives into every failure below: 250 = the lock held,
    // 251 = it did not serialize, 249 = both attempts lost the race.
    const finalCount = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const census =
      `census: seeded=${seededCount} finalCount=${finalCount} ` +
      `fulfilled=${fulfilled.length} rejected=${rejected.length} ` +
      `rejections=[${rejected.map((r) => reasonLabel((r as PromiseRejectedResult).reason)).join(' | ')}]`;

    // The overage is the headline: a 251 here is a paying customer past their cap.
    expect(finalCount, `${census} — 251 means the org-row FOR UPDATE did not serialize`).toBe(250);
    expect(fulfilled, census).toHaveLength(1);
    expect(rejected, census).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason, census).toBeInstanceOf(
      EntitlementExceededError,
    );
  });
});

describe('entitlementsService — the org-row lock every count cap serializes on (MOTIR-3710)', () => {
  // The lock was INERT: `SELECT … FOR UPDATE` on `organization` matched zero rows
  // under `withWorkspaceContext`, so it serialized nobody, and the boolean that
  // said so was thrown away at all three call sites. These are the two halves of
  // the fix, asserted where a future reader will find them.

  it('LOCKS the org row inside withWorkspaceContext — the probe returns true', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    // The probe MOTIR-3710 was filed on, re-run. The two readings taken BEFORE
    // the lock are what make its `false` legible rather than mysterious: the org
    // row was READABLE the whole time (`organization_membership_visible` admits
    // it on `app.user_id`) while `app.organization_id` — the GUC the UPDATE
    // policy `organization_mutate_active` reads, and the one a `FOR UPDATE` is
    // therefore filtered by — was unbound. Readable and not lockable.
    const probe = await withWorkspaceContext(fx.ctx, async (tx) => {
      const [before] = await tx.$queryRaw<
        Array<{ ws: string | null; org: string | null; role: string }>
      >`
        SELECT current_setting('app.workspace_id', true) AS ws,
               current_setting('app.organization_id', true) AS org,
               current_user::text AS role
      `;
      const [visible] = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "organization" WHERE "id" = ${orgId}
      `;
      const locked = await organizationRepository.lockByIdForUpdate(orgId, tx);
      const [after] = await tx.$queryRaw<Array<{ org: string | null }>>`
        SELECT current_setting('app.organization_id', true) AS org
      `;
      return {
        locked,
        visibleOrgRows: Number(visible!.n),
        workspaceGuc: before!.ws,
        orgGucBeforeLock: before!.org ?? null,
        orgGucAfterLock: after!.org ?? null,
        role: before!.role,
      };
    });

    const census = `probe: ${JSON.stringify(probe)}`;

    // The headline, and the whole card: `locked: false` here is a §4 cap
    // enforcing nothing while every other signal reads green.
    expect(probe.locked, `${census} — false means the FOR UPDATE matched no row`).toBe(true);
    // The two readings that say WHY, so a regression names its own cause.
    expect(probe.visibleOrgRows, `${census} — the row is admitted for READ`).toBe(1);
    expect(probe.orgGucBeforeLock ?? '', `${census} — withWorkspaceContext binds no org GUC`).toBe(
      '',
    );
    expect(probe.orgGucAfterLock, `${census} — lockByIdForUpdate binds it itself`).toBe(orgId);
    expect(probe.workspaceGuc, census).toBe(fx.workspaceId);
  });

  // ⚠️ ALL THREE CAPS, because the defect was never specific to the work-item
  // one — `assertWithinProjectCap` and `assertWithinWorkspaceCap` open with the
  // identical two lines. A test that covered only the headline cap would leave
  // the other two able to regress silently, which is exactly the shape of the
  // bug being fixed.
  const CAPS = [
    'assertWithinWorkItemCap',
    'assertWithinProjectCap',
    'assertWithinWorkspaceCap',
  ] as const;

  it.each(CAPS)('%s REFUSES when the org-row lock matches no row', async (method) => {
    const fx = await makeWorkItemFixture();

    // An org id that resolves to no row is the cheapest way to drive
    // `lockByIdForUpdate` to `false` without breaking RLS: the lock matches
    // nothing, so the cap cannot serialize and must refuse rather than fall
    // through to an unguarded count → compare → create.
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService[method]('org_does_not_exist', tx)),
    ).rejects.toBeInstanceOf(CapLockUnavailableError);
  });

  it('is still INERT off-cloud — the refusal never fires on a self-hosted build', async () => {
    // The refusal sits BEHIND the `isCloudBilling()` early return, so a
    // self-hosted (GPL-3.0) build cannot be 500ed by a cap it does not have.
    delete process.env['MOTIR_CLOUD'];
    const fx = await makeWorkItemFixture();

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        entitlementsService.assertWithinWorkItemCap('org_does_not_exist', tx),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('entitlementsService — project cap (§4.2)', () => {
  it('blocks the 4th project on free, allows it on scaled', async () => {
    const fx = await makeWorkItemFixture(); // creates project #1
    const orgId = await orgIdOf(fx.workspaceId);
    // Seed 2 more (total 3 = the free cap).
    for (let i = 2; i <= 3; i++) {
      await adminDb.project.create({
        data: {
          workspaceId: fx.workspaceId,
          name: `P${i}`,
          slug: `p${i}`,
          identifier: `PRJ${i}`,
        },
      });
    }

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinProjectCap(orgId, tx)),
    ).rejects.toMatchObject({ entitlement: 'projects' });

    await setTier(orgId, SCALED);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinProjectCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });
});

describe('entitlementsService — workspace cap (§4.4)', () => {
  it('blocks the 2nd workspace on free (cap = 1), allows it on scaled', async () => {
    const fx = await makeWorkItemFixture(); // org already has its 1 workspace
    const orgId = await orgIdOf(fx.workspaceId);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkspaceCap(orgId, tx)),
    ).rejects.toMatchObject({ entitlement: 'workspaces' });

    await setTier(orgId, SCALED);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertWithinWorkspaceCap(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('createWorkspace blocks a 2nd workspace under a free org (end-to-end)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await expect(
      workspacesService.createWorkspace({
        name: 'Second',
        ownerUserId: fx.ownerId,
        organizationId: orgId,
      }),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });
});

describe('entitlementsService — org-creation gate (§4.5)', () => {
  it('allows a user FIRST org, blocks a 2nd free one, allows it once they own a paid org', async () => {
    const user = await createTestUser();

    // First org — the user owns none yet, always allowed.
    await expect(
      withUserContext(user.id, (tx) =>
        entitlementsService.assertCanCreateOrganization(user.id, tx),
      ),
    ).resolves.toBeUndefined();

    // Give them one (free) org.
    const { workspace } = await workspacesService.createWorkspace({
      name: 'First',
      ownerUserId: user.id,
    });
    const orgId = await orgIdOf(workspace.id);

    // A 2nd org is now gated (no paid org).
    await expect(
      withUserContext(user.id, (tx) =>
        entitlementsService.assertCanCreateOrganization(user.id, tx),
      ),
    ).rejects.toMatchObject({ entitlement: 'organizations' });

    // Upgrade the first org → the owner can now create more orgs.
    await setTier(orgId, SCALED);
    await expect(
      withUserContext(user.id, (tx) =>
        entitlementsService.assertCanCreateOrganization(user.id, tx),
      ),
    ).resolves.toBeUndefined();
  });

  it('is INERT off-cloud — a free account can create a 2nd org', async () => {
    delete process.env['MOTIR_CLOUD'];
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'First', ownerUserId: user.id });
    await expect(
      withUserContext(user.id, (tx) =>
        entitlementsService.assertCanCreateOrganization(user.id, tx),
      ),
    ).resolves.toBeUndefined();
  });

  it('owning the META org clears the gate (treated as paid)', async () => {
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'First',
      ownerUserId: user.id,
    });
    const orgId = await orgIdOf(workspace.id);

    // Without meta/paid → a 2nd org is gated.
    await expect(
      withUserContext(user.id, (tx) =>
        entitlementsService.assertCanCreateOrganization(user.id, tx),
      ),
    ).rejects.toMatchObject({ entitlement: 'organizations' });

    // Flag the org meta → the owner can now create more orgs.
    await setMeta(orgId);
    await expect(
      withUserContext(user.id, (tx) =>
        entitlementsService.assertCanCreateOrganization(user.id, tx),
      ),
    ).resolves.toBeUndefined();
  });
});

/** A user who is a plain MEMBER of somebody else's org and owns none — every
 *  invited teammate (MOTIR-8779). */
async function makeInvitedMember(): Promise<{ memberId: string; hostOrgId: string }> {
  const host = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Host',
    ownerUserId: host.id,
  });
  const hostOrgId = await orgIdOf(workspace.id);
  const member = await createTestUser();
  await adminDb.organizationMembership.create({
    data: { organizationId: hostOrgId, userId: member.id, role: 'member' },
  });
  return { memberId: member.id, hostOrgId };
}

describe('entitlementsService — can this account create an org? (§4.5 read, MOTIR-8779)', () => {
  it('a MEMBER of one org who owns none may create exactly one, and the second is refused', async () => {
    const { memberId } = await makeInvitedMember();
    expect(await entitlementsService.canCreateOrganization(memberId)).toBe(true);

    await organizationsService.createOrganization({ name: 'Mine', actorUserId: memberId });
    expect(await entitlementsService.canCreateOrganization(memberId)).toBe(false);

    await expect(
      organizationsService.createOrganization({ name: 'Another', actorUserId: memberId }),
    ).rejects.toMatchObject({ entitlement: 'organizations' });
    // Belongs to two orgs now, owns one free one: still at the quota.
    expect(await adminDb.organizationMembership.count({ where: { userId: memberId } })).toBe(2);
    expect(await entitlementsService.canCreateOrganization(memberId)).toBe(false);
  });

  it('agrees with the gate as the owned org is upgraded', async () => {
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'First',
      ownerUserId: user.id,
    });
    const orgId = await orgIdOf(workspace.id);
    expect(await entitlementsService.canCreateOrganization(user.id)).toBe(false);

    await setTier(orgId, SCALED);
    expect(await entitlementsService.canCreateOrganization(user.id)).toBe(true);

    await setTier(orgId, CANCELED);
    expect(await entitlementsService.canCreateOrganization(user.id)).toBe(false);
  });

  it('keeps the META exemption: an ADMIN of the meta org is uncapped, a MEMBER of it is not', async () => {
    const { memberId, hostOrgId } = await makeInvitedMember();
    await setMeta(hostOrgId);
    // A member of the meta org owns nothing, so they hold the ordinary one free org…
    await organizationsService.createOrganization({ name: 'Mine', actorUserId: memberId });
    expect(await entitlementsService.canCreateOrganization(memberId)).toBe(false);

    // …and being made an ADMIN of the meta org is what lifts the quota.
    await adminDb.organizationMembership.update({
      where: { organizationId_userId: { organizationId: hostOrgId, userId: memberId } },
      data: { role: 'admin' },
    });
    expect(await entitlementsService.canCreateOrganization(memberId)).toBe(true);
    await expect(
      organizationsService.createOrganization({ name: 'Another', actorUserId: memberId }),
    ).resolves.toMatchObject({ name: 'Another' });
  });

  it('is always true off-cloud', async () => {
    delete process.env['MOTIR_CLOUD'];
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'First', ownerUserId: user.id });
    expect(await entitlementsService.canCreateOrganization(user.id)).toBe(true);
  });
});

describe('entitlementsService — upload caps (§4.3)', () => {
  it('resolves the per-file limit by tier (free 10 MB / scaled 100 MB), Infinity off-cloud', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    expect(await entitlementsService.resolvePerFileLimitBytes(orgId)).toBe(10 * MB);

    await setTier(orgId, SCALED);
    expect(await entitlementsService.resolvePerFileLimitBytes(orgId)).toBe(100 * MB);

    // Off-cloud falls back to the 10 MB operational baseline (not unbounded) —
    // the per-file safety default predates billing; only the SCALED upgrade is
    // cloud-only. (The total-storage + count caps ARE fully lifted off-cloud.)
    delete process.env['MOTIR_CLOUD'];
    expect(await entitlementsService.resolvePerFileLimitBytes(orgId)).toBe(10 * MB);
  });

  it('accumulates org storage and blocks an upload that would exceed 2 GB on free', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);

    // Seed ~1.86 GB of attachments (two ~0.93 GB rows; each fits int4).
    const big = 1_000_000_000; // 1e9 bytes
    for (let i = 0; i < 2; i++) {
      await adminDb.attachment.create({
        data: {
          workspaceId: fx.workspaceId,
          uploaderUserId: fx.ownerId,
          blobPathname: `https://blob.test/${i}`,
          mimeType: 'application/pdf',
          sizeBytes: big,
          originalFilename: `f${i}.pdf`,
        },
      });
    }

    // current = 2e9; 2e9 + 200e6 = 2.2e9 > 2 GB (2,147,483,648) → blocked.
    await expect(
      entitlementsService.assertWithinStorageCap(orgId, 200_000_000),
    ).rejects.toMatchObject({ entitlement: 'storage' });

    // A small file that stays under 2 GB is allowed.
    await adminDb.attachment.deleteMany({ where: { workspaceId: fx.workspaceId } });
    await adminDb.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        uploaderUserId: fx.ownerId,
        blobPathname: 'https://blob.test/small',
        mimeType: 'application/pdf',
        sizeBytes: big,
        originalFilename: 'small.pdf',
      },
    });
    await expect(
      entitlementsService.assertWithinStorageCap(orgId, 100_000_000),
    ).resolves.toBeUndefined();
  });

  it('sums across the org’s WORKSPACES — the reach no workspace binding could have (MOTIR-2956)', async () => {
    // §4.3b is a per-ORGANIZATION cap and an org spans workspaces, which is why
    // the usage read runs under `withOrgServiceWriteContext` rather than a
    // workspace context. Until MOTIR-2956 the org GUC it binds was read by no
    // policy on `attachment` (nor on the `workspace` its sum JOINs), so under
    // `motir_app` the total was 0 and this gate never fired for anyone.
    //
    // Neither workspace here is on its own over the 2 GB free cap; together they
    // are. A per-workspace sum would let both uploads through.
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    const sibling = await adminDb.workspace.create({
      data: { organizationId: orgId, name: 'Second', slug: `second-${fx.workspaceId}` },
    });

    const half = 1_200_000_000; // 1.2e9 each; 2.4e9 > 2 GiB (2,147,483,648)
    for (const [i, workspaceId] of [fx.workspaceId, sibling.id].entries()) {
      await adminDb.attachment.create({
        data: {
          workspaceId,
          uploaderUserId: fx.ownerId,
          blobPathname: `https://blob.test/ws${i}`,
          mimeType: 'application/pdf',
          sizeBytes: half,
          originalFilename: `ws${i}.pdf`,
        },
      });
    }

    await expect(entitlementsService.assertWithinStorageCap(orgId, 1)).rejects.toMatchObject({
      entitlement: 'storage',
      detail: { usage: 2 * half },
    });
  });

  it('lifts the storage cap on scaled (100 GB headroom)', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);
    // A 3 GB incoming file (over free, well under scaled's 100 GB) is allowed.
    await expect(
      entitlementsService.assertWithinStorageCap(orgId, 3 * GB),
    ).resolves.toBeUndefined();
  });
});

describe('entitlementsService — the org-creation gate’s ACTOR-row lock (MOTIR-3717)', () => {
  // §4.5 was the ONE cap in this file that took no row lock at all. Its
  // `count → compare → create` read the ACTOR's owner/admin memberships, and on
  // the very first create that set is EMPTY — so the symmetric repair MOTIR-3710
  // applied to the three count caps does not transfer: you cannot lock a row that
  // does not exist yet. Two concurrent first creates for one fresh user both read
  // `orgs.length === 0`, both took the always-free early return, and the user
  // ended with TWO free orgs having never owned a paid one — two full free-tier
  // allowances for an account entitled to one.
  //
  // The anchor is the row the actor genuinely owns and that exists BEFORE the
  // first org does: their own `user` row. `ensureDefaultWorkspace` has serialized
  // its zero-membership check-then-create on exactly that row since Story 1.2.4;
  // this gate is the sibling that never did.

  it('LOCKS the actor’s user row in the gate’s own bootstrap context — the probe returns true', async () => {
    const user = await createTestUser();

    // The context the gate ACTUALLY runs in: both callers
    // (`workspacesService.insertWorkspaceWithOwner`'s mint-own-org branch and
    // `organizationsService.createOrganization`) bind `app.user_id` +
    // `app.bootstrap_slug` on a bare transaction — a tenant-BOOTSTRAP context,
    // not `withOrgContext`, because the org id does not exist until the INSERT
    // runs. Probing anywhere else would prove nothing about the lock this gate
    // takes.
    const probe = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.bootstrap_slug', ${'probe-3717'}, true)`;
      const [ctx] = await tx.$queryRaw<Array<{ uid: string | null; role: string }>>`
        SELECT current_setting('app.user_id', true) AS uid, current_user::text AS role
      `;
      // WHY it is lockable, measured rather than asserted from the migrations:
      // `user` has RLS DISABLED, so no UPDATE policy `USING` clause can filter
      // the `FOR UPDATE` out. That is the exact mechanism that made
      // `organization`'s lock inert under `withWorkspaceContext` (MOTIR-3710) —
      // readable and not lockable — so the reading belongs beside the verdict.
      const [rls] = await tx.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`
        SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE relname = 'user' AND relnamespace = 'public'::regnamespace
      `;
      const locked = (await userRepository.lockById(user.id, tx)) !== null;
      return { locked, userRlsEnabled: rls!.enabled, userGuc: ctx!.uid ?? null, role: ctx!.role };
    });

    const census = `probe: ${JSON.stringify(probe)}`;
    expect(probe.locked, `${census} — false means the FOR UPDATE matched no row`).toBe(true);
    expect(probe.userRlsEnabled, `${census} — RLS on "user" would filter the FOR UPDATE`).toBe(
      false,
    );
    expect(probe.userGuc, census).toBe(user.id);
    // The non-bypass runtime role is the only one that matters: an owner
    // connection would lock regardless and prove nothing (MOTIR-2734 made
    // `@/lib/db` `motir_app` unconditionally).
    expect(probe.role, census).toBe('motir_app');
  });

  it('races two FIRST-org creates for one user and leaves exactly ONE organization', async () => {
    // Production altitude: two `createWorkspace` calls with no `organizationId`,
    // i.e. the mint-own-org branch every signup takes. No barrier is needed here
    // and none is available — each call opens its OWN transaction and does async
    // slug work before reaching the gate, so they interleave naturally. The
    // deterministic-overlap version is the barrier test directly below; this one
    // is the shape a double-submitted signup actually produces.
    const user = await createTestUser();

    const results = await Promise.allSettled([
      workspacesService.createWorkspace({ name: 'First', ownerUserId: user.id }),
      workspacesService.createWorkspace({ name: 'Also first', ownerUserId: user.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // MEASURED BEFORE any assertion can throw, so the number survives into every
    // failure message (MOTIR-3707's census discipline): 1 = the lock held,
    // 2 = the gate did not serialize and the user has two free-tier allowances.
    const orgMembershipsForUser = await adminDb.organizationMembership.count({
      where: { userId: user.id },
    });
    const distinctOrgs = await adminDb.organization.count();
    const census =
      `census: fulfilled=${fulfilled.length} rejected=${rejected.length} ` +
      `orgMembershipsForUser=${orgMembershipsForUser} distinctOrgs=${distinctOrgs} ` +
      `rejections=[${rejected.map((r) => reasonLabel((r as PromiseRejectedResult).reason)).join(' | ')}]`;

    expect(
      orgMembershipsForUser,
      `${census} — 2 means §4.5 admitted a second free org to one account`,
    ).toBe(1);
    expect(distinctOrgs, census).toBe(1);
    expect(fulfilled, census).toHaveLength(1);
    expect(rejected, census).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason, census).toBeInstanceOf(
      EntitlementExceededError,
    );
  });

  it('serializes two gate calls that are PROVABLY overlapped by a barrier', async () => {
    // ⚠️ THE BARRIER IS THE INSTRUMENT (MOTIR-3710). The test above races the real
    // service and relies on its own async work to interleave; this one removes
    // that reliance by replicating the mint-own-org branch inline
    // (`insertWorkspaceWithOwner` lines 146-170: bind the bootstrap GUCs, assert
    // §4.5, create the org, create the owner membership) with a rendezvous on the
    // first line. Neither transaction can count, create or COMMIT until both are
    // open and GUC-bound, so a green here cannot be a green on a guard that does
    // nothing. Do NOT delete it to "simplify" — that is exactly how §4.1's race
    // test passed for months on an inert lock.
    const user = await createTestUser();
    const arrive = rendezvous(2);

    const attempt = (slug: string) =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
        await tx.$executeRaw`SELECT set_config('app.bootstrap_slug', ${slug}, true)`;
        await arrive();
        await entitlementsService.assertCanCreateOrganization(user.id, tx);
        const organization = await organizationRepository.create({ name: slug, slug }, tx);
        await organizationMembershipRepository.create(
          { organizationId: organization.id, userId: user.id, role: ORGANIZATION_ROLE.owner },
          tx,
        );
      });

    const results = await Promise.allSettled([attempt('race-a-3717'), attempt('race-b-3717')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    const orgMembershipsForUser = await adminDb.organizationMembership.count({
      where: { userId: user.id },
    });
    const census =
      `census: fulfilled=${fulfilled.length} rejected=${rejected.length} ` +
      `orgMembershipsForUser=${orgMembershipsForUser} ` +
      `rejections=[${rejected.map((r) => reasonLabel((r as PromiseRejectedResult).reason)).join(' | ')}]`;

    expect(
      orgMembershipsForUser,
      `${census} — 2 means the barrier-overlapped gate let both through`,
    ).toBe(1);
    expect(fulfilled, census).toHaveLength(1);
    expect(rejected, census).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason, census).toBeInstanceOf(
      EntitlementExceededError,
    );
  });

  it('REFUSES when the actor-row lock matches no row', async () => {
    // A user id that resolves to no row is the cheapest way to drive the lock to
    // "matched nothing" without breaking RLS. The gate must REFUSE rather than
    // fall through to an unserialized count → compare → create: a cap that
    // cannot serialize is not a cap (MOTIR-3710's rule, applied to §4.5's
    // different anchor).
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${'user_does_not_exist'}, true)`;
        return entitlementsService.assertCanCreateOrganization('user_does_not_exist', tx);
      }),
    ).rejects.toBeInstanceOf(CapLockUnavailableError);
  });

  it('stays INERT off-cloud — a self-hosted build still creates a SECOND org', async () => {
    // The refusal sits BEHIND the `isCloudBilling()` early return, so a
    // self-hosted (GPL-3.0) build can neither be 500ed by a lock it does not
    // need nor gated by a cap it does not have. Asserted end-to-end, on the real
    // create path, because that is the claim: two workspaces, two orgs, no error.
    delete process.env['MOTIR_CLOUD'];
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'First', ownerUserId: user.id });
    await workspacesService.createWorkspace({ name: 'Second', ownerUserId: user.id });

    expect(await adminDb.organizationMembership.count({ where: { userId: user.id } })).toBe(2);

    // …and the lock refusal itself never fires off-cloud.
    await expect(
      db.$transaction((tx) =>
        entitlementsService.assertCanCreateOrganization('user_does_not_exist', tx),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('entitlementsService — custom-domain cap (Story MOTIR-3878 · the ADR §9)', () => {
  it('refuses the FIRST domain on a free org', async () => {
    // `free: 0` is the ADR's provisional value, and it makes the refusal the
    // upgrade prompt's trigger rather than an empty state the pane special-cases.
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertCanAddCustomDomain(orgId, tx)),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  it('carries `custom_domains` as the entitlement the prompt keys off', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    const err = await withWorkspaceContext(fx.ctx, (tx) =>
      entitlementsService.assertCanAddCustomDomain(orgId, tx),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EntitlementExceededError);
    expect((err as InstanceType<typeof EntitlementExceededError>).entitlement).toBe(
      'custom_domains',
    );
  });

  it('admits a paid org below its cap, and refuses it AT the cap', async () => {
    // Both directions on one org, because a gate that refuses everybody passes
    // every denial test ever written.
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertCanAddCustomDomain(orgId, tx)),
    ).resolves.toBeUndefined();

    await seedCustomDomains(fx, 5);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertCanAddCustomDomain(orgId, tx)),
    ).rejects.toBeInstanceOf(EntitlementExceededError);
  });

  it('counts the domains of EVERY workspace in the org, not only the adding one (MOTIR-10116)', async () => {
    // The adding transaction is bound to workspace A, and `public_address`'s
    // tenancy policy hides B's rows from any invoker read — so a plain count saw
    // three, and the sixth domain was admitted. Neither workspace is at the cap
    // on its own; together they are, which is the fixture where the caller's
    // view and the true population differ.
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);
    const sibling = await makeSiblingWorkspaceProject(orgId, fx.workspaceId);
    await seedCustomDomains(fx, 3);
    await seedCustomDomains(sibling, 2, 'sibling');

    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertCanAddCustomDomain(orgId, tx)),
    ).rejects.toMatchObject({ entitlement: 'custom_domains', detail: { limit: 5, usage: 5 } });
  });

  it('answers 0 for an organisation the bound workspace does not belong to', async () => {
    // The count reads past RLS, so its one boundary is the bound workspace: a
    // caller learns the size of its OWN organisation's estate and no other's.
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await seedCustomDomains(other, 4, 'other');
    const otherOrgId = await orgIdOf(other.workspaceId);

    const seen = await withWorkspaceContext(fx.ctx, (tx) =>
      publicAddressRepository.countCustomDomainsByOrganization(otherOrgId, tx),
    );
    const own = await withWorkspaceContext(other.ctx, (tx) =>
      publicAddressRepository.countCustomDomainsByOrganization(otherOrgId, tx),
    );
    expect(seen).toBe(0);
    expect(own).toBe(4);
  });

  it('never caps the META org', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setMeta(orgId);
    await seedCustomDomains(fx, 12);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertCanAddCustomDomain(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('is INERT off-cloud, and performs no read', async () => {
    // A self-hosted build has no public projects (ADR §11), so it has no
    // addresses and must not consult a cap. Asserted as "returns" rather than
    // "does not throw at the cap", which is the stronger of the two: the org is
    // seeded PAST its cap and the call still returns.
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await seedCustomDomains(fx, 9);
    delete process.env['MOTIR_CLOUD'];
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => entitlementsService.assertCanAddCustomDomain(orgId, tx)),
    ).resolves.toBeUndefined();
  });

  it('serializes concurrent adds at the boundary via FOR UPDATE (no overage)', async () => {
    // The warm-pool TOCTOU the service header describes, for this cap. Seeded at
    // cap − 1, so exactly one of two racers may win.
    const fx = await makeWorkItemFixture();
    const orgId = await orgIdOf(fx.workspaceId);
    await setTier(orgId, SCALED);
    await seedCustomDomains(fx, 4);

    const seeded = await adminDb.publicAddress.count({
      where: { projectId: fx.projectId, kind: 'custom_domain' },
    });
    expect(seeded, 'precondition: the race must start at cap − 1').toBe(4);

    // ⚠️ THE BARRIER IS THE INSTRUMENT (MOTIR-3710). Without it the first
    // transaction counts, writes AND commits before the second counts, so the
    // second rejects legitimately whether or not the lock works — and the test
    // passes on a guard that does nothing.
    const arrive = rendezvous(2);
    const attempt = (n: number) =>
      withWorkspaceContext(fx.ctx, async (tx) => {
        await arrive();
        await entitlementsService.assertCanAddCustomDomain(orgId, tx);
        await publicAddressRepository.createCustomDomain(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            hostname: `race-${n}.acme.example`,
            verificationToken: `motir-verify-race-${n}`,
          },
          tx,
        );
      });

    const results = await Promise.allSettled([attempt(1), attempt(2)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Measured BEFORE any assertion can throw, so the number survives into every
    // failure message: 5 = the lock held, 6 = it did not serialize.
    const finalCount = await adminDb.publicAddress.count({
      where: { projectId: fx.projectId, kind: 'custom_domain' },
    });
    const census =
      `census: seeded=${seeded} finalCount=${finalCount} ` +
      `fulfilled=${fulfilled.length} rejected=${rejected.length} ` +
      `rejections=[${rejected.map((r) => reasonLabel((r as PromiseRejectedResult).reason)).join(' | ')}]`;

    expect(finalCount, `${census} — 6 means the org-row FOR UPDATE did not serialize`).toBe(5);
    expect(fulfilled, census).toHaveLength(1);
    expect(rejected, census).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason, census).toBeInstanceOf(
      EntitlementExceededError,
    );
  });
});

/** Seed `count` issued custom domains on the fixture's project. */
async function seedCustomDomains(
  fx: { workspaceId: string; projectId: string },
  count: number,
  prefix = 'seed',
): Promise<void> {
  await adminDb.publicAddress.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      hostname: `${prefix}-${i}.acme.example`,
      kind: 'custom_domain' as const,
      status: 'issued' as const,
      verificationToken: `motir-verify-${prefix}-${i}`,
    })),
  });
}

/** A second workspace in `orgId`, holding one project, seeded past RLS. */
async function makeSiblingWorkspaceProject(
  orgId: string,
  firstWorkspaceId: string,
): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await adminDb.workspace.create({
    data: { organizationId: orgId, name: 'Second', slug: `second-${firstWorkspaceId}` },
  });
  const project = await adminDb.project.create({
    data: { workspaceId: workspace.id, name: 'Sibling', slug: 'sibling', identifier: 'SIB' },
  });
  return { workspaceId: workspace.id, projectId: project.id };
}
