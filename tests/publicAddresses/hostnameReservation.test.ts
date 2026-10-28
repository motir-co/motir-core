import { createHash } from 'node:crypto';

import type { AccountDeletionRequest } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateCodeGraphOffboarding, truncateJobRuns } from '../helpers/db';

// THE §8 RESERVATION SURVIVES A WORKSPACE DELETE — Bug MOTIR-4366.
//
// The defect: `docs/decisions/public-tenant-addresses.md` §8 decides a public
// subdomain is never released, and MOTIR-4209 implemented that with the
// `public_address.hostname` unique index alone. `public_address.workspace_id` is
// `onDelete: Cascade`, so deleting a workspace deleted the rows and handed the
// live subdomain AND every retained alias back to whoever asked next.
//
// The suite is organised around the two paths that reach the delete, because the
// SECOND is what makes this a defect rather than an oddity:
//
//   1. the workspace delete (`removeWorkspaceAsOrgAdmin` / `deleteWorkspaceForErasure`) — the delete itself;
//   2. `accountErasureSweepService.sweep` — the SCHEDULED JOB that calls it on a
//      GDPR erasure request, with no operator and no decision;
//   3. what is RETAINED, which the erasure obligation constrains from the other
//      side: the address rows must be gone, and the one row that survives must
//      not carry the hostname;
//   4. the boundary — a CUSTOMER's own domain is not ours to hold.
//
// Real Postgres throughout (the no-mocks rule); the only toggles are the
// `MOTIR_CLOUD` and `MOTIR_PUBLIC_TENANT_DOMAIN` env vars.

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { accountDeletionService } = await import('@/lib/services/accountDeletionService');
const { accountErasureSweepService } = await import('@/lib/services/accountErasureSweepService');
const { hostnameReservationHash, reservesItsHostname } =
  await import('@/lib/publicAddresses/hostnameReservation');
const { NameQuarantinedError } = await import('@/lib/publicAddresses/errors');
const { createTestUser, createTestProject } = await import('../fixtures');

const BASE = 'motir.example';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateCodeGraphOffboarding();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
});

afterEach(async () => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * A user who SOLELY owns a workspace holding a live subdomain and one retired
 * alias, the exact shape the erasure sweep deletes.
 *
 * ⚠️ THE ALIAS IS WRITTEN DIRECTLY. A rename no longer leaves one (§8 Amendment
 * 3, MOTIR-9507), but alias rows written before it are still in the database
 * until the one-off cleanup (MOTIR-9520) turns them into expiring holds — and a
 * workspace deleted before that runs must still hold every one of them.
 *
 * Built through `workspacesService.createWorkspace` rather than the workspace
 * fixture, because the erasure arm selects on `memberCount <= 1` and the thing
 * under test is what a REAL sole-membership workspace leaves behind.
 */
async function soleOwnerWithRenamedSubdomain(label = 'acme', renamedTo = 'acme-inc') {
  const user = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Personal',
    ownerUserId: user.id,
  });
  await publicSubdomainService.claim(workspace.id, renamedTo, user.id);
  await ageLiveSubdomain(workspace.id);
  await giveLegacyAlias(workspace.id, `${label}.${BASE}`);
  return {
    userId: user.id,
    workspaceId: workspace.id,
    live: `${renamedTo}.${BASE}`,
    alias: `${label}.${BASE}`,
    liveLabel: renamedTo,
    aliasLabel: label,
  };
}

/**
 * Move the live subdomain's claim two days back, so the delete holds it: a label
 * held under 24 hours returns to the pool at once (§8 Amendment 3 rule 3), and
 * that case is `workspaceDeleteReservation.test.ts`'s.
 */
async function ageLiveSubdomain(workspaceId: string) {
  await adminDb.publicAddress.updateMany({
    where: { workspaceId, kind: 'workspace_subdomain' },
    data: { createdAt: new Date(Date.now() - 2 * DAY_MS) },
  });
}

/** A legacy `workspace_subdomain_alias` row, as the retired rename wrote them. */
async function giveLegacyAlias(workspaceId: string, hostname: string) {
  return adminDb.publicAddress.create({
    data: { workspaceId, hostname, kind: 'workspace_subdomain_alias', status: 'alias' },
  });
}

/** A second workspace, with its own owner, ready to try to claim a freed name. */
async function squatter() {
  const user = await createTestUser({ email: 'squatter@example.com' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Squatter',
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

/**
 * A `custom_domain` row on a project, written directly.
 *
 * NOT through `customDomainService.add`, deliberately: that path asserts the ADR
 * §9 entitlement cap, mints a verification token and seeds the fake DNS
 * resolver, none of which this file is about — and coupling to the tier gate
 * would make a test about DELETION fail the day a plan's `maxCustomDomains`
 * changes. What is under test is what the delete does to a row of this KIND.
 */
async function giveCustomDomain(workspaceId: string, projectId: string, hostname: string) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId,
      projectId,
      hostname,
      kind: 'custom_domain',
      status: 'unverified',
      verificationToken: 'motir-verify-test',
    },
  });
}

/** Schedule a deletion and back-date it so the sweep picks it up. */
async function scheduleDue(userId: string, daysOverdue = 1): Promise<AccountDeletionRequest> {
  const dto = await accountDeletionService.scheduleAccountDeletion(userId);
  const requestedAt = new Date(Date.now() - (30 + daysOverdue) * DAY_MS);
  return adminDb.accountDeletionRequest.update({
    where: { id: dto.id },
    data: { requestedAt, erasureDueAt: new Date(requestedAt.getTime() + 30 * DAY_MS) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE DELETE ITSELF
// ─────────────────────────────────────────────────────────────────────────────

describe('the workspace delete holds the workspace’s subdomain out of the namespace', () => {
  it('refuses another workspace’s claim of BOTH the live name and the retired alias', async () => {
    // The card's own criterion, and the whole defect in one test: a workspace
    // holding a live name and a retained alias is deleted, then we try to take
    // both names from a workspace that has nothing to do with it.
    const gone = await soleOwnerWithRenamedSubdomain();
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });

    // The cascade really did run — this is not a test that passes because the
    // rows are still there.
    expect(await adminDb.publicAddress.count({ where: { hostname: gone.live } })).toBe(0);
    expect(await adminDb.publicAddress.count({ where: { hostname: gone.alias } })).toBe(0);

    const next = await squatter();
    await expect(
      publicSubdomainService.claim(next.workspaceId, gone.liveLabel, next.userId),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
    await expect(
      publicSubdomainService.claim(next.workspaceId, gone.aliasLabel, next.userId),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
  });

  it('leaves the refused claimant NOTHING — the rollback is the whole refusal', async () => {
    // The check runs AFTER the insert (the ordering that closes the race), so a
    // refusal has to unwind a row that was really written. A leftover
    // `public_address` row would hold the name against its own claimant for ever
    // and read as a claim that succeeded.
    const gone = await soleOwnerWithRenamedSubdomain();
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });

    const next = await squatter();
    await expect(
      publicSubdomainService.claim(next.workspaceId, gone.liveLabel, next.userId),
    ).rejects.toBeInstanceOf(NameQuarantinedError);

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: next.workspaceId } }),
      'the refused claim must have rolled its own insert back',
    ).toBe(0);
    // And the workspace is still able to claim something else — the refusal cost
    // it nothing but the name.
    const dto = await publicSubdomainService.claim(next.workspaceId, 'somewhere-else', next.userId);
    expect(dto.hostname).toBe(`somewhere-else.${BASE}`);
  });

  it('refuses a RENAME onto a deleted workspace’s name, not only a first claim', async () => {
    // `rename` is a second door onto `createSubdomain` and had to be taught the
    // same check. A test that covers only `claim` passes with the rename path
    // still releasing the name.
    const gone = await soleOwnerWithRenamedSubdomain();
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });

    const next = await squatter();
    await publicSubdomainService.claim(next.workspaceId, 'starting-here', next.userId);
    await expect(
      publicSubdomainService.rename(next.workspaceId, gone.liveLabel, next.userId),
    ).rejects.toBeInstanceOf(NameQuarantinedError);

    // And no change was spent on the refusal, and the old name is still served.
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
    const dto = await publicSubdomainService.getForWorkspace(next.workspaceId, next.userId);
    expect(dto?.label).toBe('starting-here');
  });

  it('reserves EVERY retired alias, not just the last one', async () => {
    // A workspace that renamed before §8 Amendment 3 may hold several legacy
    // aliases. Reserving only the live one would leave the older links — the ones
    // most likely to be out in the world — free to be inherited.
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Serial renamer',
      ownerUserId: user.id,
    });
    await publicSubdomainService.claim(workspace.id, 'third', user.id);
    await ageLiveSubdomain(workspace.id);
    await giveLegacyAlias(workspace.id, `first.${BASE}`);
    await giveLegacyAlias(workspace.id, `second.${BASE}`);
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    expect(await adminDb.publicHostnameReservation.count()).toBe(3);

    const next = await squatter();
    for (const label of ['first', 'second', 'third']) {
      await expect(
        publicSubdomainService.claim(next.workspaceId, label, next.userId),
        label,
      ).rejects.toBeInstanceOf(NameQuarantinedError);
    }
  });

  it('is idempotent — a re-reserve of the same digest writes nothing and raises nothing', async () => {
    // The erasure sweep is resumable by construction and re-derives what it acts
    // on, so this write can genuinely run twice. A 23505 here would abort an
    // erasure mid-way.
    const gone = await soleOwnerWithRenamedSubdomain();
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });
    const after = await adminDb.publicHostnameReservation.findMany({ orderBy: { id: 'asc' } });
    expect(after).toHaveLength(2);

    const repeat = await squatter();
    await publicSubdomainService.claim(repeat.workspaceId, 'acme-two', repeat.userId);
    await adminDb.publicHostnameReservation.createMany({
      data: after.map((row) => ({
        hostnameHash: row.hostnameHash,
        retiredFromWorkspaceId: row.retiredFromWorkspaceId,
        expiresAt: row.expiresAt,
      })),
      skipDuplicates: true,
    });
    expect(await adminDb.publicHostnameReservation.count()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE PATH THAT ACTUALLY RUNS IT — the erasure sweep
// ─────────────────────────────────────────────────────────────────────────────

describe('the account-erasure sweep does not release the departed workspace’s address', () => {
  it('reserves the live name and the alias when the scheduled job erases the account', async () => {
    // This is the path the defect fires on. `accountErasureSweepService` routes
    // a sole-membership workspace through `deleteWorkspaceForErasure` on a cron,
    // so the release needed nobody to decide it and raised nothing — a test on
    // the Admin door alone would pass while the automatic path regressed
    // (a future erasure arm reaching the rows by any other route).
    const gone = await soleOwnerWithRenamedSubdomain('leaver', 'leaver-inc');
    await scheduleDue(gone.userId);

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ scanned: 1, erased: 1, failed: 0 });
    expect(summary.workspacesDeleted).toBe(1);
    expect(await adminDb.workspace.count({ where: { id: gone.workspaceId } })).toBe(0);

    const next = await squatter();
    await expect(
      publicSubdomainService.claim(next.workspaceId, 'leaver-inc', next.userId),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
    await expect(
      publicSubdomainService.claim(next.workspaceId, 'leaver', next.userId),
    ).rejects.toBeInstanceOf(NameQuarantinedError);
  });

  it('is unaffected by a re-run of the sweep', async () => {
    // The sweep's own idempotence property, exercised through this write.
    const gone = await soleOwnerWithRenamedSubdomain('leaver', 'leaver-inc');
    await scheduleDue(gone.userId);
    await accountErasureSweepService.sweep();
    const second = await accountErasureSweepService.sweep();

    expect(second).toMatchObject({ erased: 0, failed: 0 });
    expect(await adminDb.publicHostnameReservation.count()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. WHAT IS RETAINED — the erasure obligation, from the other side
// ─────────────────────────────────────────────────────────────────────────────

describe('the retained row satisfies the erasure obligation', () => {
  it('keeps NO tenancy and NO verification token — the address rows are gone entirely', async () => {
    // The card's criterion, and the reason the cascade was KEPT rather than
    // tombstoned: nothing tenant-derived survives, because no address row
    // survives. What is retained is one digest per name.
    const gone = await soleOwnerWithRenamedSubdomain();
    const project = await createTestProject({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
      identifier: 'SOLO',
    });
    await giveCustomDomain(gone.workspaceId, project.id, 'roadmap.acme-customer.example');

    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });

    expect(
      await adminDb.publicAddress.count({ where: { workspaceId: gone.workspaceId } }),
      'no address row may survive — a surviving row is a surviving workspaceId',
    ).toBe(0);

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // Every column, named. A test asserting only "the hostname column is
      // absent" would pass on a schema that added one back.
      expect(Object.keys(row).sort()).toEqual([
        'expiresAt',
        'hostnameHash',
        'id',
        'retiredAt',
        'retiredFromWorkspaceId',
      ]);
      expect(row.hostnameHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('retains the DIGEST and never the hostname — no stored value contains the name', async () => {
    // The legal half of the amendment: a hostname can itself be the personal
    // datum (`jane-smith.<base>`), so the reservation must not be readable back
    // into one. Asserted over the whole serialized row rather than over the one
    // column, because the claim is about what is RETAINED, not about a field.
    const gone = await soleOwnerWithRenamedSubdomain('jane-smith', 'jane-smith-two');
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });

    const rows = await adminDb.publicHostnameReservation.findMany();
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('jane-smith');
    expect(serialized).not.toContain(BASE);

    // And the digest is the one the claim path computes — the reservation is
    // useless if the two transforms disagree, and they are computed in different
    // modules from different inputs (a stored row here, a composed
    // `<label>.<base>` there).
    expect(rows.map((r) => r.hostnameHash).sort()).toEqual(
      [
        hostnameReservationHash(`jane-smith.${BASE}`),
        hostnameReservationHash(`jane-smith-two.${BASE}`),
      ].sort(),
    );
  });

  it('names the workspace it was retired from, and that id points at nothing', async () => {
    // Retained for the RLS `WITH CHECK` and for an operator answering "why is
    // this name held?". It is an orphan by construction, and saying so in a test
    // is what stops a later change re-attaching a foreign key to it — which
    // would cascade the row away at exactly the moment it matters.
    const gone = await soleOwnerWithRenamedSubdomain();
    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: gone.workspaceId,
      actorUserId: gone.userId,
    });

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.every((r) => r.retiredFromWorkspaceId === gone.workspaceId)).toBe(true);
    expect(await adminDb.workspace.count({ where: { id: gone.workspaceId } })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE BOUNDARY — whose namespace is it
// ─────────────────────────────────────────────────────────────────────────────

describe('a CUSTOMER domain is not reserved', () => {
  it('is released with the workspace, so its rightful owner can connect it again', async () => {
    // §8's rule is about MOTIR'S namespace. `roadmap.acme-customer.example`
    // belongs to the customer whatever becomes of their account; holding it for
    // ever would lock them out of their own domain.
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      identifier: 'SOLO',
    });
    await giveCustomDomain(workspace.id, project.id, 'roadmap.acme-customer.example');

    await workspacesService.removeWorkspaceAsOrgAdmin({
      workspaceId: workspace.id,
      actorUserId: user.id,
    });

    expect(await adminDb.publicHostnameReservation.count()).toBe(0);

    // And it really is re-connectable. The `hostname` unique index is the
    // arbiter, so an insert that SUCCEEDS is the proof that nothing holds the
    // name — the same evidence a refused claim gives in the negative.
    const next = await squatter();
    const nextProject = await createTestProject({
      workspaceId: next.workspaceId,
      actorUserId: next.userId,
      identifier: 'NEXT',
    });
    const reconnected = await giveCustomDomain(
      next.workspaceId,
      nextProject.id,
      'roadmap.acme-customer.example',
    );
    expect(reconnected.hostname).toBe('roadmap.acme-customer.example');
  });

  it('classifies the three kinds explicitly', () => {
    expect(reservesItsHostname('workspace_subdomain')).toBe(true);
    expect(reservesItsHostname('workspace_subdomain_alias')).toBe(true);
    expect(reservesItsHostname('custom_domain')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE TRANSFORM
// ─────────────────────────────────────────────────────────────────────────────

describe('hostnameReservationHash', () => {
  it('normalises the way the hostname paths do, so a stored row and a fresh claim agree', () => {
    const canonical = hostnameReservationHash('acme.motir.example');
    expect(hostnameReservationHash('ACME.Motir.Example')).toBe(canonical);
    expect(hostnameReservationHash('  acme.motir.example  ')).toBe(canonical);
    // A trailing dot is legal in DNS and wrong in a URL — `tenantBaseDomain`
    // strips it, and so must this, or one path reserves a name the other cannot
    // test for.
    expect(hostnameReservationHash('acme.motir.example.')).toBe(canonical);
    // EVERY trailing dot, not just one. The strip is a linear loop rather than
    // `/\.+$/` (CodeQL `js/polynomial-redos`, high — an anchored `\.+` retries
    // from every offset), and this is the assertion that pins the loop's
    // behaviour to the regex's rather than only to the single-dot case.
    expect(hostnameReservationHash('acme.motir.example....')).toBe(canonical);
    expect(hostnameReservationHash(`acme.motir.example${'.'.repeat(5000)}`)).toBe(canonical);
    // And a dot-only input degenerates to the empty string rather than looping
    // off the front of the buffer.
    expect(hostnameReservationHash('....')).toBe(hostnameReservationHash(''));
  });

  it('separates two hostnames that differ only in the label', () => {
    expect(hostnameReservationHash('acme.motir.example')).not.toBe(
      hostnameReservationHash('acme-inc.motir.example'),
    );
  });

  it('is domain-separated, so a digest of the bare hostname is not a reservation', () => {
    // The prefix is what stops a digest computed elsewhere — of the same string,
    // for some other purpose — being mistaken for one of these.
    expect(hostnameReservationHash('acme.motir.example')).not.toBe(
      createHash('sha256').update('acme.motir.example').digest('hex'),
    );
  });
});
