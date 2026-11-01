import type { PublicAddressKind } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateCodeGraphOffboarding, truncateJobRuns } from '../helpers/db';

// THE WORKSPACE DELETE HOLDS A NAME UNDER THE SAME RULE AS A RELEASE —
// Story MOTIR-4528 · Subtask MOTIR-9508, `docs/decisions/public-tenant-addresses.md`
// §8 Amendments 1 and 3.
//
// A workspace delete is a release for rule 3: a label held under 24 hours goes
// straight back to the pool, one held longer is reserved for 90 days. A legacy
// alias row has no recoverable hold clock, so it is always held the full 90
// days. All three entries onto the delete — the Admin door, the account-erasure
// sweep and the organization-erasure sweep — share `deleteWorkspaceCascade`, so
// they must write the same rows.
//
// The delete reads the real clock, so the hold's START is moved instead: each
// test sets the address row's `createdAt` and brackets the delete between two
// instants to bound the `expires_at` it writes. No sleeps.

const { db } = await import('@/lib/db');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { accountDeletionService } = await import('@/lib/services/accountDeletionService');
const { accountErasureSweepService } = await import('@/lib/services/accountErasureSweepService');
const { workspaceRepository } = await import('@/lib/repositories/workspaceRepository');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { NameQuarantinedError } = await import('@/lib/publicAddresses/errors');
const { createTestUser, createTestProject } = await import('../fixtures');

const BASE = 'motir.example';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateCodeGraphOffboarding();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A user who SOLELY owns a workspace that has claimed `label`, held for `heldMs`. */
async function soleOwnerHolding(label: string, heldMs: number, email?: string) {
  const user = await createTestUser(email ? { email } : {});
  const { workspace } = await workspacesService.createWorkspace({
    name: `Holder ${label}`,
    ownerUserId: user.id,
  });
  await publicSubdomainService.claim(workspace.id, label, user.id);
  await adminDb.publicAddress.updateMany({
    where: { workspaceId: workspace.id, kind: 'workspace_subdomain' },
    data: { createdAt: new Date(Date.now() - heldMs) },
  });
  return { userId: user.id, workspaceId: workspace.id, organizationId: workspace.organizationId };
}

/** A second workspace, ready to try to claim a freed name. */
async function claimant() {
  const user = await createTestUser({ email: 'claimant@example.com' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Claimant',
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

async function addRow(workspaceId: string, hostname: string, kind: PublicAddressKind) {
  const projectId =
    kind === 'custom_domain'
      ? (await adminDb.project.findFirst({ where: { workspaceId } }))?.id
      : undefined;
  return adminDb.publicAddress.create({
    data: {
      workspaceId,
      projectId: projectId ?? null,
      hostname,
      kind,
      status: kind === 'workspace_subdomain_alias' ? 'alias' : 'unverified',
      createdAt: new Date('2020-01-01T00:00:00Z'),
    },
  });
}

/** Delete through the Admin door, returning the instants that bracket it. */
async function deleteBracketed(ws: { workspaceId: string; userId: string }) {
  const before = new Date();
  await workspacesService.removeWorkspaceAsOrgAdmin({
    workspaceId: ws.workspaceId,
    actorUserId: ws.userId,
  });
  return { before, after: new Date() };
}

function expectExpiryWithin(expiresAt: Date, window: { before: Date; after: Date }) {
  expect(expiresAt.getTime()).toBeGreaterThanOrEqual(window.before.getTime() + 90 * DAY);
  expect(expiresAt.getTime()).toBeLessThanOrEqual(window.after.getTime() + 90 * DAY);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the direct delete', () => {
  it('frees a label held under 24 hours at once — no row, claimable straight after', async () => {
    const gone = await soleOwnerHolding('fresh', DAY - 60_000);
    await deleteBracketed(gone);

    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    const next = await claimant();
    await expect(
      publicSubdomainService.claim(next.workspaceId, 'fresh', next.userId),
    ).resolves.toMatchObject({ hostname: `fresh.${BASE}` });
  });

  it('holds a label held 24 hours or more for 90 days from the delete, then frees it', async () => {
    const gone = await soleOwnerHolding('aged', 2 * DAY);
    const window = await deleteBracketed(gone);

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.map((r) => r.hostnameHash)).toEqual([hostnameReservationHash(`aged.${BASE}`)]);
    const expiresAt = rows[0]!.expiresAt;
    expectExpiryWithin(expiresAt, window);

    const next = await claimant();
    const refused = await publicSubdomainService
      .claim(next.workspaceId, 'aged', next.userId, new Date(expiresAt.getTime() - 1))
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NameQuarantinedError);
    expect((refused as InstanceType<typeof NameQuarantinedError>).returnsAt.getTime()).toBe(
      expiresAt.getTime(),
    );
    await expect(
      publicSubdomainService.claim(next.workspaceId, 'aged', next.userId, expiresAt),
    ).resolves.toMatchObject({ hostname: `aged.${BASE}` });
  });

  it('holds a legacy ALIAS for 90 days whatever its age, and never a CUSTOM DOMAIN', async () => {
    // The live label is fresh, so only the alias may be held: the alias's own
    // hold clock is not recoverable, and freeing a name somebody may have linked
    // early is the mistake the conservative reading avoids.
    const gone = await soleOwnerHolding('live', HOUR);
    await createTestProject({ workspaceId: gone.workspaceId, actorUserId: gone.userId });
    await addRow(gone.workspaceId, `old.${BASE}`, 'workspace_subdomain_alias');
    await addRow(gone.workspaceId, 'docs.customer.example', 'custom_domain');

    const window = await deleteBracketed(gone);

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.map((r) => r.hostnameHash)).toEqual([hostnameReservationHash(`old.${BASE}`)]);
    expectExpiryWithin(rows[0]!.expiresAt, window);
  });

  it('commits the hold and the delete together — a failing delete leaves no row', async () => {
    const gone = await soleOwnerHolding('atomic', 2 * DAY);
    const boom = new Error('delete exploded');
    vi.spyOn(workspaceRepository, 'delete').mockRejectedValueOnce(boom);

    await expect(
      workspacesService.removeWorkspaceAsOrgAdmin({
        workspaceId: gone.workspaceId,
        actorUserId: gone.userId,
      }),
    ).rejects.toBe(boom);

    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(await adminDb.workspace.count({ where: { id: gone.workspaceId } })).toBe(1);
  });

  it('treats a repeated hold write as a no-op, never a 23505', async () => {
    // A resumed erasure tick can re-run the write; the second must be silent.
    const gone = await soleOwnerHolding('again', 2 * DAY);
    await deleteBracketed(gone);
    const [row] = await adminDb.publicHostnameReservation.findMany();

    await adminDb.$transaction((tx) =>
      publicHostnameReservationRepository.reserveMany(
        [
          {
            hostnameHash: row!.hostnameHash,
            retiredFromWorkspaceId: row!.retiredFromWorkspaceId,
            expiresAt: row!.expiresAt,
          },
        ],
        new Date(),
        tx,
      ),
    );
    const after = await adminDb.publicHostnameReservation.findMany();
    expect(after).toHaveLength(1);
    expect(after[0]!.expiresAt.getTime()).toBe(row!.expiresAt.getTime());
  });

  it('stores only the digest and an orphaned workspace id — no hostname, no live foreign key', async () => {
    const gone = await soleOwnerHolding('jane-smith', 2 * DAY);
    await deleteBracketed(gone);

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'expiresAt',
      'hostnameHash',
      'id',
      'retiredAt',
      'retiredFromWorkspaceId',
    ]);
    expect(JSON.stringify(rows)).not.toContain('jane-smith');
    expect(rows[0]!.retiredFromWorkspaceId).toBe(gone.workspaceId);
    expect(await adminDb.workspace.count({ where: { id: gone.workspaceId } })).toBe(0);
  });

  it('deletes a workspace that has a change-ledger row, and leaves no ledger row behind', async () => {
    const gone = await soleOwnerHolding('ledger', 2 * DAY);
    await adminDb.publicSubdomainChange.create({
      data: { workspaceId: gone.workspaceId, lastChangedAt: new Date() },
    });
    await deleteBracketed(gone);
    expect(await adminDb.publicSubdomainChange.count()).toBe(0);
  });
});

describe('the erasure entries write the same rows as the direct delete', () => {
  it('the account-erasure sweep, for a sole-member workspace', async () => {
    const gone = await soleOwnerHolding('leaver', 2 * DAY, 'leaver@example.com');
    const dto = await accountDeletionService.scheduleAccountDeletion(gone.userId);
    const requestedAt = new Date(Date.now() - 31 * DAY);
    await adminDb.accountDeletionRequest.update({
      where: { id: dto.id },
      data: { requestedAt, erasureDueAt: new Date(requestedAt.getTime() + 30 * DAY) },
    });

    const before = new Date();
    const summary = await accountErasureSweepService.sweep();
    const window = { before, after: new Date() };

    expect(summary).toMatchObject({ erased: 1, failed: 0, workspacesDeleted: 1 });
    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.map((r) => [r.hostnameHash, r.retiredFromWorkspaceId])).toEqual([
      [hostnameReservationHash(`leaver.${BASE}`), gone.workspaceId],
    ]);
    expectExpiryWithin(rows[0]!.expiresAt, window);
  });

  it('the organization-erasure sweep', async () => {
    const gone = await soleOwnerHolding('closing', 2 * DAY, 'closing@example.com');
    const request = await adminDb.organizationDeletionRequest.create({
      data: {
        organizationId: gone.organizationId,
        requestedByUserId: gone.userId,
        erasureDueAt: new Date(Date.now() - DAY),
        status: 'erasing',
        erasingStartedAt: new Date(),
      },
    });

    const before = new Date();
    await workspacesService.deleteWorkspaceForOrganizationErasure({
      workspaceId: gone.workspaceId,
      requestId: request.id,
      actorUserId: gone.userId,
    });
    const window = { before, after: new Date() };

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(rows.map((r) => [r.hostnameHash, r.retiredFromWorkspaceId])).toEqual([
      [hostnameReservationHash(`closing.${BASE}`), gone.workspaceId],
    ]);
    expectExpiryWithin(rows[0]!.expiresAt, window);
  });
});
