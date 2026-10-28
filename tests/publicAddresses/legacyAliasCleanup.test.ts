import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE LEGACY ALIAS CLEANUP — Story MOTIR-4528 · Subtask MOTIR-9520.
//
// Every leftover `workspace_subdomain_alias` row is replaced by a hold on its
// name's digest and then deleted, in one transaction per batch. Real Postgres
// throughout, under the app role, so the system arms of both tables are what
// admit the cross-workspace read, write and delete.
//
// The instants are in the PAST on purpose, as in the sweep's test: the
// reservation table's `refresh` policy and a later claim read the database's
// clock as well as the test's `now`, so a hold must lapse by both.

const { db } = await import('@/lib/db');
const { legacyAliasCleanupService } = await import('@/lib/services/legacyAliasCleanupService');
const { publicSubdomainService } = await import('@/lib/services/publicSubdomainService');
const { publicAddressRepository } = await import('@/lib/repositories/publicAddressRepository');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { hostnameReservationHash } = await import('@/lib/publicAddresses/hostnameReservation');
const { QUARANTINE_DAYS, addDays } = await import('@/lib/publicAddresses/nameHold');
const { NameQuarantinedError } = await import('@/lib/publicAddresses/errors');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { createTestWorkspace } = await import('../fixtures');

const BASE = 'motir.example';
const DAY = 24 * 60 * 60 * 1000;
// Far enough back that `NOW + QUARANTINE_DAYS` is also in the past, so a hold
// written for NOW has lapsed by the database's clock and the claim test can
// pick the instant either side of it.
const NOW = new Date('2025-01-01T00:00:00.000Z');
const HOLD_END = addDays(NOW, QUARANTINE_DAYS);

let workspaceId: string;
let otherWorkspaceId: string;
let otherOwnerId: string;

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_PUBLIC_TENANT_DOMAIN'] = BASE;
  const first = await createTestWorkspace({ name: 'Holder' });
  const second = await createTestWorkspace({ name: 'Claimant' });
  workspaceId = first.workspace.id;
  otherWorkspaceId = second.workspace.id;
  otherOwnerId = second.owner.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_PUBLIC_TENANT_DOMAIN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function alias(label: string, ws = workspaceId) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: ws,
      hostname: `${label}.${BASE}`,
      kind: 'workspace_subdomain_alias',
      status: 'alias',
    },
  });
}

function hold(label: string, expiresAt: Date, ws = workspaceId) {
  return adminDb.publicHostnameReservation.create({
    data: { hostnameHash: digest(label), retiredFromWorkspaceId: ws, expiresAt },
  });
}

function digest(label: string): string {
  return hostnameReservationHash(`${label}.${BASE}`);
}

async function expiryOf(label: string): Promise<Date | undefined> {
  const row = await adminDb.publicHostnameReservation.findUnique({
    where: { hostnameHash: digest(label) },
  });
  return row?.expiresAt;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('cleanupLegacyAliases', () => {
  it('holds each alias for exactly QUARANTINE_DAYS, deletes it, and the name is refused until then', async () => {
    await alias('old-one');
    await alias('old-two');

    const report = await legacyAliasCleanupService.cleanupLegacyAliases(NOW);

    expect(report).toEqual({ aliasesRemoved: 2, holdsCreated: 2, holdsRaised: 0, holdsKept: 0 });
    expect(
      await adminDb.publicAddress.count({ where: { kind: 'workspace_subdomain_alias' } }),
    ).toBe(0);
    expect((await expiryOf('old-one'))?.getTime()).toBe(HOLD_END.getTime());
    expect((await expiryOf('old-two'))?.getTime()).toBe(HOLD_END.getTime());

    const refused = await publicSubdomainService
      .claim(otherWorkspaceId, 'old-one', otherOwnerId, new Date(HOLD_END.getTime() - 1))
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NameQuarantinedError);
    await expect(
      publicSubdomainService.claim(otherWorkspaceId, 'old-two', otherOwnerId, HOLD_END),
    ).resolves.toMatchObject({ hostname: `old-two.${BASE}` });
  });

  it('keeps a hold already in force unchanged — even one ending after NOW + QUARANTINE_DAYS', async () => {
    const earlier = addDays(NOW, 10);
    const later = addDays(NOW, QUARANTINE_DAYS + 30);
    await alias('short');
    await alias('long');
    await hold('short', earlier);
    await hold('long', later);

    const report = await legacyAliasCleanupService.cleanupLegacyAliases(NOW);

    expect(report).toMatchObject({ aliasesRemoved: 2, holdsKept: 2, holdsCreated: 0 });
    expect((await expiryOf('short'))?.getTime()).toBe(earlier.getTime());
    expect((await expiryOf('long'))?.getTime()).toBe(later.getTime());
  });

  it('raises a LAPSED hold to NOW + QUARANTINE_DAYS rather than skipping it', async () => {
    await alias('lapsed');
    await hold('lapsed', addDays(NOW, -1), otherWorkspaceId);

    const report = await legacyAliasCleanupService.cleanupLegacyAliases(NOW);

    expect(report).toMatchObject({ aliasesRemoved: 1, holdsRaised: 1, holdsCreated: 0 });
    expect((await expiryOf('lapsed'))?.getTime()).toBe(HOLD_END.getTime());
    const refused = await publicSubdomainService
      .claim(otherWorkspaceId, 'lapsed', otherOwnerId, new Date(HOLD_END.getTime() - 1))
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NameQuarantinedError);
  });

  it('commits the hold and the delete together — a failing delete leaves no new hold', async () => {
    await alias('atomic');
    const boom = new Error('delete exploded');
    vi.spyOn(publicAddressRepository, 'removeMany').mockRejectedValueOnce(boom);

    await expect(legacyAliasCleanupService.cleanupLegacyAliases(NOW)).rejects.toBe(boom);

    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
    expect(await adminDb.publicAddress.count({ where: { hostname: `atomic.${BASE}` } })).toBe(1);
  });

  it('and a failing hold leaves the alias row in place', async () => {
    await alias('kept');
    const boom = new Error('hold exploded');
    vi.spyOn(publicHostnameReservationRepository, 'holdUntilInTx').mockRejectedValueOnce(boom);

    await expect(legacyAliasCleanupService.cleanupLegacyAliases(NOW)).rejects.toBe(boom);

    expect(await adminDb.publicAddress.count({ where: { hostname: `kept.${BASE}` } })).toBe(1);
    expect(await adminDb.publicHostnameReservation.count()).toBe(0);
  });

  it('a second run reports all zeros and changes no row', async () => {
    await alias('once');
    await legacyAliasCleanupService.cleanupLegacyAliases(NOW);
    const before = await adminDb.publicHostnameReservation.findMany();

    await expect(legacyAliasCleanupService.cleanupLegacyAliases(NOW)).resolves.toEqual({
      aliasesRemoved: 0,
      holdsCreated: 0,
      holdsRaised: 0,
      holdsKept: 0,
    });
    expect(await adminDb.publicHostnameReservation.findMany()).toEqual(before);
  });

  it('never deletes or reserves a live subdomain or a custom domain', async () => {
    await alias('gone');
    await adminDb.publicAddress.create({
      data: {
        workspaceId,
        hostname: `live.${BASE}`,
        kind: 'workspace_subdomain',
        status: 'issued',
      },
    });
    const project = await adminDb.project.create({
      data: { workspaceId, name: 'P', slug: 'p', identifier: 'PRJ' },
    });
    await adminDb.publicAddress.create({
      data: {
        workspaceId,
        projectId: project.id,
        hostname: 'docs.customer.example',
        kind: 'custom_domain',
        status: 'issued',
      },
    });

    await legacyAliasCleanupService.cleanupLegacyAliases(NOW);

    const left = await adminDb.publicAddress.findMany({ orderBy: { hostname: 'asc' } });
    expect(left.map((r) => r.hostname)).toEqual(['docs.customer.example', `live.${BASE}`]);
    const held = await adminDb.publicHostnameReservation.findMany();
    expect(held.map((r) => r.hostnameHash)).toEqual([digest('gone')]);
  });

  it('removes every alias across batches when there are more than batchSize', async () => {
    for (let i = 0; i < 5; i++) await alias(`batch-${i}`, i % 2 ? workspaceId : otherWorkspaceId);

    const report = await legacyAliasCleanupService.cleanupLegacyAliases(NOW, 2);

    expect(report).toMatchObject({ aliasesRemoved: 5, holdsCreated: 5 });
    expect(
      await adminDb.publicAddress.count({ where: { kind: 'workspace_subdomain_alias' } }),
    ).toBe(0);
  });

  it('stores only the digest, the expiry and the retiring workspace — never a hostname', async () => {
    await alias('jane-smith');
    await legacyAliasCleanupService.cleanupLegacyAliases(NOW);

    const rows = await adminDb.publicHostnameReservation.findMany();
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'expiresAt',
      'hostnameHash',
      'id',
      'retiredAt',
      'retiredFromWorkspaceId',
    ]);
    expect(JSON.stringify(rows)).not.toContain('jane-smith');
    expect(rows[0]!.retiredFromWorkspaceId).toBe(workspaceId);
  });
});

describe('holdUntilInTx', () => {
  it('never lowers an existing expiry, and raises it to a later one', async () => {
    const stored = addDays(NOW, 50);
    await hold('raise-me', stored);
    const write = (expiresAt: Date) =>
      withSystemContext((tx) =>
        publicHostnameReservationRepository.holdUntilInTx(
          [{ hostnameHash: digest('raise-me'), retiredFromWorkspaceId: workspaceId, expiresAt }],
          NOW,
          tx,
        ),
      );

    await expect(write(addDays(NOW, 20))).resolves.toBe(0);
    expect((await expiryOf('raise-me'))?.getTime()).toBe(stored.getTime());

    const later = new Date(stored.getTime() + 7 * DAY);
    await expect(write(later)).resolves.toBe(1);
    expect((await expiryOf('raise-me'))?.getTime()).toBe(later.getTime());
  });
});
