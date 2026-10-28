import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE EXPIRING RESERVATION AND THE CHANGE LEDGER — Story MOTIR-4528 · MOTIR-9506.
//
// Real Postgres, through `withWorkspaceContext`, so every write passes the RLS
// arms production runs under. Fixture instants sit in the PAST: the table's
// `refresh` arm reads the database clock, and a past instant keeps the
// repository's own `now` and that clock in agreement about what has lapsed.

const { db } = await import('@/lib/db');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { publicHostnameReservationRepository: reservations } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { publicSubdomainChangeRepository: ledger } =
  await import('@/lib/repositories/publicSubdomainChangeRepository');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2025-06-01T00:00:00.000Z');
const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function asWorkspace<T>(
  ws: { workspace: { id: string }; owner: { id: string } },
  fn: Parameters<typeof withWorkspaceContext<T>>[1],
): Promise<T> {
  return withWorkspaceContext({ userId: ws.owner.id, workspaceId: ws.workspace.id }, fn);
}

async function storedExpiry(hostnameHash: string): Promise<Date | undefined> {
  const row = await adminDb.publicHostnameReservation.findUnique({ where: { hostnameHash } });
  return row?.expiresAt;
}

describe('isReservedInTx — only an unexpired row reserves', () => {
  it('answers false for a lapsed row and true for a live one', async () => {
    const ws = await createTestWorkspace();
    await asWorkspace(ws, (tx) =>
      reservations.reserveMany(
        [
          { hostnameHash: 'lapsed', retiredFromWorkspaceId: ws.workspace.id, expiresAt: at(-1) },
          { hostnameHash: 'live', retiredFromWorkspaceId: ws.workspace.id, expiresAt: at(1) },
        ],
        at(-2),
        tx,
      ),
    );
    await asWorkspace(ws, async (tx) => {
      expect(await reservations.isReservedInTx('lapsed', NOW, tx)).toBe(false);
      expect(await reservations.isReservedInTx('live', NOW, tx)).toBe(true);
      expect(await reservations.isReservedInTx('live', at(1), tx)).toBe(false);
    });
  });
});

describe('reserveMany — persists the expiry and never frees a name early', () => {
  it('persists expiresAt on a new digest', async () => {
    const ws = await createTestWorkspace();
    const inserted = await asWorkspace(ws, (tx) =>
      reservations.reserveMany(
        [{ hostnameHash: 'fresh', retiredFromWorkspaceId: ws.workspace.id, expiresAt: at(90) }],
        NOW,
        tx,
      ),
    );
    expect(inserted).toBe(1);
    expect(await storedExpiry('fresh')).toEqual(at(90));
  });

  it('raises a LAPSED row of another workspace to the new expiry and attributes it', async () => {
    const a = await createTestWorkspace();
    const b = await createTestWorkspace();
    await asWorkspace(a, (tx) =>
      reservations.reserveMany(
        [{ hostnameHash: 'reused', retiredFromWorkspaceId: a.workspace.id, expiresAt: at(-1) }],
        at(-91),
        tx,
      ),
    );
    await asWorkspace(b, (tx) =>
      reservations.reserveMany(
        [{ hostnameHash: 'reused', retiredFromWorkspaceId: b.workspace.id, expiresAt: at(90) }],
        NOW,
        tx,
      ),
    );
    const row = await adminDb.publicHostnameReservation.findUnique({
      where: { hostnameHash: 'reused' },
    });
    expect(row?.expiresAt).toEqual(at(90));
    expect(row?.retiredFromWorkspaceId).toBe(b.workspace.id);
  });

  it('keeps the LATER expiry on its own live row, so a re-run is idempotent', async () => {
    const ws = await createTestWorkspace();
    const reserve = (expiresAt: Date) =>
      asWorkspace(ws, (tx) =>
        reservations.reserveMany(
          [{ hostnameHash: 'mine', retiredFromWorkspaceId: ws.workspace.id, expiresAt }],
          NOW,
          tx,
        ),
      );
    await reserve(at(90));
    await reserve(at(30));
    expect(await storedExpiry('mine')).toEqual(at(90));
    await reserve(at(120));
    expect(await storedExpiry('mine')).toEqual(at(120));
    expect(await adminDb.publicHostnameReservation.count({ where: { hostnameHash: 'mine' } })).toBe(
      1,
    );
  });

  it("leaves another workspace's LIVE row exactly as it is", async () => {
    const a = await createTestWorkspace();
    const b = await createTestWorkspace();
    await asWorkspace(a, (tx) =>
      reservations.reserveMany(
        [{ hostnameHash: 'held', retiredFromWorkspaceId: a.workspace.id, expiresAt: at(10) }],
        NOW,
        tx,
      ),
    );
    const written = await asWorkspace(b, (tx) =>
      reservations.reserveMany(
        [{ hostnameHash: 'held', retiredFromWorkspaceId: b.workspace.id, expiresAt: at(90) }],
        NOW,
        tx,
      ),
    );
    expect(written).toBe(0);
    const row = await adminDb.publicHostnameReservation.findUnique({
      where: { hostnameHash: 'held' },
    });
    expect(row?.expiresAt).toEqual(at(10));
    expect(row?.retiredFromWorkspaceId).toBe(a.workspace.id);
  });
});

describe('the change ledger — one row per workspace', () => {
  it('reads null before any change and upserts one row carrying the later change', async () => {
    const ws = await createTestWorkspace();
    await asWorkspace(ws, async (tx) => {
      expect(await ledger.findByWorkspaceInTx(ws.workspace.id, tx)).toBeNull();
      await ledger.recordChangeInTx(ws.workspace.id, at(0), tx);
      await ledger.recordChangeInTx(ws.workspace.id, at(5), tx);
      expect(await ledger.findByWorkspaceInTx(ws.workspace.id, tx)).toEqual({
        lastChangedAt: at(5),
      });
    });
    expect(
      await adminDb.publicSubdomainChange.count({ where: { workspaceId: ws.workspace.id } }),
    ).toBe(1);
  });

  it("does not show one workspace's ledger to another", async () => {
    const a = await createTestWorkspace();
    const b = await createTestWorkspace();
    await asWorkspace(a, (tx) => ledger.recordChangeInTx(a.workspace.id, NOW, tx));
    await asWorkspace(b, async (tx) => {
      expect(await ledger.findByWorkspaceInTx(a.workspace.id, tx)).toBeNull();
    });
  });
});
