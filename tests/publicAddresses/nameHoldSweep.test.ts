import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE EXPIRED NAME-HOLD SWEEP — Story MOTIR-4528 · Subtask MOTIR-9509.
//
// Housekeeping over `public_hostname_reservation`: rows whose `expires_at` has
// passed are deleted, rows still holding a name are never touched. Real
// Postgres throughout, under the non-bypass app role, so the delete is proved to
// reach every workspace's rows through the table's system arm.
//
// The instants are in the PAST on purpose: the table's `refresh` policy reads
// the database clock, so a re-reserve of a lapsed digest must be lapsed by the
// database's clock too, not only by the test's `now`.

const { db } = await import('@/lib/db');
const { publicHostnameReservationRepository } =
  await import('@/lib/repositories/publicHostnameReservationRepository');
const { publicHostnameReservationService } =
  await import('@/lib/services/publicHostnameReservationService');
const { withSystemContext, withWorkspaceContext } = await import('@/lib/workspaces/context');
const { engineJob } = await import('@/lib/jobs/engine/registry');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { publicHostnameReservationSweep, PUBLIC_HOSTNAME_RESERVATION_SWEEP_CRON } =
  await import('@/lib/jobs/definitions/publicHostnameReservationSweep');
const { createTestWorkspace } = await import('../fixtures');

const NOW = new Date('2025-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function at(days: number): Date {
  return new Date(NOW.getTime() + days * DAY);
}

async function hold(hostnameHash: string, workspaceId: string, expiresAt: Date) {
  await adminDb.publicHostnameReservation.create({
    data: { hostnameHash, retiredFromWorkspaceId: workspaceId, expiresAt },
  });
}

let workspaceId: string;
let otherWorkspaceId: string;
let ownerId: string;

beforeEach(async () => {
  await truncateAuthTables();
  const first = await createTestWorkspace({ name: 'Holder' });
  const second = await createTestWorkspace({ name: 'Other' });
  workspaceId = first.workspace.id;
  ownerId = first.owner.id;
  otherWorkspaceId = second.workspace.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('deleteExpiredInTx', () => {
  it('deletes rows lapsed at or before `now`, keeps later ones, and counts what went', async () => {
    await hold('lapsed-long-ago', workspaceId, at(-30));
    await hold('lapses-exactly-now', otherWorkspaceId, NOW);
    await hold('still-held', workspaceId, at(1));

    const deleted = await withSystemContext((tx) =>
      publicHostnameReservationRepository.deleteExpiredInTx(NOW, tx),
    );

    expect(deleted).toBe(2);
    const left = await adminDb.publicHostnameReservation.findMany();
    expect(left.map((r) => r.hostnameHash)).toEqual(['still-held']);
  });
});

describe('sweepExpiredNameHolds', () => {
  it('reaches every workspace, and a second run deletes nothing', async () => {
    await hold('a', workspaceId, at(-1));
    await hold('b', otherWorkspaceId, at(-2));

    await expect(publicHostnameReservationService.sweepExpiredNameHolds(NOW)).resolves.toEqual({
      deleted: 2,
    });
    await expect(publicHostnameReservationService.sweepExpiredNameHolds(NOW)).resolves.toEqual({
      deleted: 0,
    });
  });

  it('never touches a hold still in force — it is still reserved afterwards', async () => {
    await hold('in-force', workspaceId, at(10));
    await publicHostnameReservationService.sweepExpiredNameHolds(NOW);

    const reserved = await withWorkspaceContext({ userId: ownerId, workspaceId }, (tx) =>
      publicHostnameReservationRepository.isReservedInTx('in-force', NOW, tx),
    );
    expect(reserved).toBe(true);
  });

  it('lets a swept digest be reserved again, with no unique-key collision', async () => {
    await hold('reused', otherWorkspaceId, at(-1));
    await publicHostnameReservationService.sweepExpiredNameHolds(NOW);

    const written = await withWorkspaceContext({ userId: ownerId, workspaceId }, (tx) =>
      publicHostnameReservationRepository.reserveMany(
        [{ hostnameHash: 'reused', retiredFromWorkspaceId: workspaceId, expiresAt: at(90) }],
        NOW,
        tx,
      ),
    );
    expect(written).toBe(1);
    const row = await adminDb.publicHostnameReservation.findUniqueOrThrow({
      where: { hostnameHash: 'reused' },
    });
    expect(row.retiredFromWorkspaceId).toBe(workspaceId);
  });
});

describe('the job', () => {
  it('is registered as a daily, catch-up-latest, idempotent system job', () => {
    const def = engineJob('system.public-hostname-reservation-sweep');
    expect(def).toBe(publicHostnameReservationSweep);
    expect(jobDefinitions).toContain(publicHostnameReservationSweep);
    expect(def!.cron).toBe(PUBLIC_HOSTNAME_RESERVATION_SWEEP_CRON);
    // Daily: a fixed minute and hour, every day.
    expect(PUBLIC_HOSTNAME_RESERVATION_SWEEP_CRON).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    expect(def!.catchUp).toBe('latest');
    expect(def!.retryPolicy).toBe('idempotent');
  });
});
