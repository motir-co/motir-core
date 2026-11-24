import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformRole } from '@/generated/prisma/client';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The STOP CONTAINERS Server ACTIONS (MOTIR-7320) — `previewStopAction` and
 * `stopContainersAction`, and the last-stop read the Fleet card shows back.
 *
 * The actions are TRANSPORT: what a stop does is `platformFleetStopService`'s
 * own suite (`platformFleetStopService.test.ts`, with the busy fixture). What is
 * asserted here is the TRANSLATION — each typed refusal to its code, against a
 * real Postgres — that a refusal writes nothing, and that the page re-reads on
 * every outcome that may have changed it. The org here runs nothing, so the stop
 * is a real, empty stop: every path runs and finds nothing to act on.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let currentPrincipal: PlatformPrincipal | null = null;
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The platform tier's `getSession` equivalent — the one allowed mock. The
    // DEGREE is honoured, so NOT_PERMITTED exercises the action's own gate.
    requirePlatformStaff: vi.fn(async (minimum: PlatformRole = 'support') => {
      const { NotPlatformStaffError } = await import('@/lib/platform/errors');
      if (!currentPrincipal) throw new NotPlatformStaffError();
      if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
        throw new NotPlatformStaffError();
      }
      return currentPrincipal;
    }),
  };
});

const { previewStopAction, stopContainersAction } =
  await import('@/app/(admin)/admin/tenants/[orgId]/actions');
const { platformFleetStopService } = await import('@/lib/services/platformFleetStopService');

let seq = 0;

async function seedOperator(role: PlatformRole): Promise<PlatformPrincipal> {
  const user = await createTestUser({ email: `ops+fleet-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role };
}

async function seedOrg() {
  return adminDb.organization.create({
    data: { name: 'Northwind Labs', slug: `northwind-fleet-${seq++}` },
  });
}

const stopRows = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'fleet.stop' },
    orderBy: { createdAt: 'asc' },
  });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedOperator('superadmin');
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('stopContainersAction', () => {
  it('stops, reports the result, records fleet.stop and re-reads the page', async () => {
    const org = await seedOrg();

    const answer = await stopContainersAction(org.id, '  Running, not debited for 25 min  ');

    expect(answer).toEqual({
      ok: true,
      result: {
        runsCancelled: 0,
        ciContainersStopped: 0,
        hostedRunsEnded: 0,
        agentInstancesHibernated: 0,
        failures: { ci: 0, hosted: 0, instances: 0 },
      },
    });
    const rows = await stopRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Running, not debited for 25 min');
    expect(rows[0]?.targetId).toBe(org.id);
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${org.id}`);
  });

  it('REASON_REQUIRED for a blank reason — nothing written, nothing re-read', async () => {
    const org = await seedOrg();

    expect(await stopContainersAction(org.id, ' \t ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(await stopRows()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['operator', 'support'] as const)(
    'NOT_PERMITTED for a forged call from %s — nothing stopped',
    async (role) => {
      const org = await seedOrg();
      currentPrincipal = await seedOperator(role);
      const stop = vi.spyOn(platformFleetStopService, 'stop');

      expect(await stopContainersAction(org.id, 'I should not be able to')).toEqual({
        ok: false,
        code: 'NOT_PERMITTED',
      });
      expect(stop).not.toHaveBeenCalled();
      expect(await stopRows()).toEqual([]);
      // The foot must re-read to show the role the caller now has (design S4 m).
      expect(revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${org.id}`);
    },
  );

  it('NOT_PERMITTED for no principal at all', async () => {
    const org = await seedOrg();
    currentPrincipal = null;
    expect(await stopContainersAction(org.id, 'anonymous')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
  });

  it('NOT_FOUND for an organization that does not exist', async () => {
    expect(await stopContainersAction('cmnot-a-real-org', 'A stale link')).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await stopRows()).toEqual([]);
  });

  it('FAILED for anything unexplained — logged, and the page still re-reads', async () => {
    const org = await seedOrg();
    vi.spyOn(platformFleetStopService, 'stop').mockRejectedValueOnce(new Error('fly is down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await stopContainersAction(org.id, 'Stopping a leak')).toEqual({
      ok: false,
      code: 'FAILED',
    });
    expect(logged).toHaveBeenCalled();
    // A stop is three paths, not one transaction: some may have stopped.
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/tenants/${org.id}`);
  });
});

describe('previewStopAction', () => {
  it('returns the counts and when they were read — for support too (a read)', async () => {
    const org = await seedOrg();
    currentPrincipal = await seedOperator('support');

    const answer = await previewStopAction(org.id);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.preview).toMatchObject({
      ciContainers: 0,
      hostedRuns: 0,
      agentInstances: 0,
    });
    expect(Number.isNaN(Date.parse(answer.countedAt))).toBe(false);
  });

  it('NOT_FOUND for an unknown org, NOT_PERMITTED for no principal', async () => {
    expect(await previewStopAction('cmnot-a-real-org')).toEqual({ ok: false, code: 'NOT_FOUND' });
    const org = await seedOrg();
    currentPrincipal = null;
    expect(await previewStopAction(org.id)).toEqual({ ok: false, code: 'NOT_PERMITTED' });
  });

  it('FAILED when the counts cannot be read', async () => {
    const org = await seedOrg();
    vi.spyOn(platformFleetStopService, 'preview').mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await previewStopAction(org.id)).toEqual({ ok: false, code: 'FAILED' });
  });
});

describe('platformFleetStopService.lastStop', () => {
  it('is null before any stop, then the newest fleet.stop row with actor and counts', async () => {
    const org = await seedOrg();
    const me = currentPrincipal!;

    expect(await platformFleetStopService.lastStop(me, org.id)).toBeNull();

    await stopContainersAction(org.id, 'First stop');
    await stopContainersAction(org.id, 'Second stop');
    // A stop of ANOTHER org is never this org's last stop.
    const other = await seedOrg();
    await stopContainersAction(other.id, 'Somebody else');

    const last = await platformFleetStopService.lastStop(me, org.id);
    expect(last).toMatchObject({
      actorEmail: me.email,
      reason: 'Second stop',
      runsCancelled: 0,
      ciContainersStopped: 0,
      hostedRunsEnded: 0,
      agentInstancesHibernated: 0,
    });
  });
});
