import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

/**
 * The /admin/jobs Server ACTIONS (MOTIR-9987) against the real database: the
 * row replay and Replay all, each with its own `operator` gate and the
 * service's refusal behind it.
 *
 * `requirePlatformStaff` is replaced so a test can choose the principal; it
 * honours the degree the action asks for, unless a test lets the gate through
 * to prove the service still refuses.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let currentPrincipal: PlatformPrincipal | null = null;
let gateHonoured = true;

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (gateHonoured && !actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

const { replayDeadLetterAction, replayAllDeadLettersAction } =
  await import('@/app/(admin)/admin/jobs/actions');

const METER = 'system.platform-meter-report';

let operator: PlatformPrincipal;
let support: PlatformPrincipal;
let workspaceId: string;

async function seedDlq(i: number, opts: { workspaceId?: string | null } = {}): Promise<string> {
  const row = await adminDb.jobRunDlq.create({
    data: {
      workspaceId: opts.workspaceId ?? null,
      functionId: METER,
      eventName: METER,
      eventData: { containerId: `c-${i}`, idempotencyKey: `meter-key-${i}` },
      failure: { message: 'MOTIR_AI_UNAVAILABLE' },
      attempts: 5,
    },
  });
  return row.id;
}

const replayedCount = () => adminDb.jobRunDlq.count({ where: { replayedAt: { not: null } } });
const auditCount = () => adminDb.platformAuditLog.count({ where: { action: 'jobs.dlq_replay' } });

beforeEach(async () => {
  vi.mocked(revalidatePath).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  gateHonoured = true;
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  const op = await usersService.createUser({
    email: 'operator@motir.test',
    password: 'hunter2hunter2',
    name: 'Platform Operator',
  });
  const sup = await usersService.createUser({
    email: 'support@motir.test',
    password: 'hunter2hunter2',
    name: 'Platform Support',
  });
  await adminDb.user.update({ where: { id: op.id }, data: { platformRole: 'operator' } });
  await adminDb.user.update({ where: { id: sup.id }, data: { platformRole: 'support' } });
  operator = { userId: op.id, email: 'operator@motir.test', role: 'operator' };
  support = { userId: sup.id, email: 'support@motir.test', role: 'support' };
  const owner = await usersService.createUser({
    email: 'tenant-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Tenant Owner',
  });
  workspaceId = (await workspacesService.createWorkspace({ name: 'Tenant', ownerUserId: owner.id }))
    .workspace.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('replayDeadLetterAction', () => {
  it('support: NOT_PERMITTED at the gate, nothing replayed, nothing revalidated', async () => {
    const dlqId = await seedDlq(0);
    currentPrincipal = support;

    await expect(replayDeadLetterAction(dlqId)).resolves.toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await replayedCount()).toBe(0);
    expect(await auditCount()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('support past the gate: the service refuses, still NOT_PERMITTED and nothing replayed', async () => {
    const dlqId = await seedDlq(0);
    currentPrincipal = support;
    gateHonoured = false;

    await expect(replayDeadLetterAction(dlqId)).resolves.toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await replayedCount()).toBe(0);
  });

  it('operator: replays a workspace row, audits it and revalidates the page', async () => {
    const dlqId = await seedDlq(0, { workspaceId });
    currentPrincipal = operator;

    await expect(replayDeadLetterAction(dlqId)).resolves.toEqual({
      ok: true,
      outcome: 'replayed',
    });
    expect(await replayedCount()).toBe(1);
    expect(await auditCount()).toBe(1);
    expect(revalidatePath).toHaveBeenCalledWith('/admin/jobs');

    await expect(replayDeadLetterAction(dlqId)).resolves.toEqual({
      ok: true,
      outcome: 'already-replayed',
    });
    expect(await auditCount()).toBe(1);
  });

  it('operator: an unknown id is NOT_FOUND', async () => {
    currentPrincipal = operator;
    await expect(replayDeadLetterAction('does-not-exist')).resolves.toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('replayAllDeadLettersAction', () => {
  it('support: NOT_PERMITTED at the gate and past it, nothing replayed', async () => {
    await seedDlq(0);
    await seedDlq(1, { workspaceId });
    currentPrincipal = support;

    await expect(replayAllDeadLettersAction(METER)).resolves.toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    gateHonoured = false;
    await expect(replayAllDeadLettersAction(METER)).resolves.toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await replayedCount()).toBe(0);
    expect(await auditCount()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('operator: replays every waiting row of the function and revalidates; a repeat replays none', async () => {
    await seedDlq(0);
    await seedDlq(1, { workspaceId });
    currentPrincipal = operator;

    await expect(replayAllDeadLettersAction(METER)).resolves.toEqual({
      ok: true,
      result: { functionId: METER, replayed: 2, alreadyReplayed: 0, failed: [] },
    });
    expect(await replayedCount()).toBe(2);
    expect(await auditCount()).toBe(2);
    expect(revalidatePath).toHaveBeenCalledWith('/admin/jobs');

    await expect(replayAllDeadLettersAction(METER)).resolves.toEqual({
      ok: true,
      result: { functionId: METER, replayed: 0, alreadyReplayed: 0, failed: [] },
    });
    expect(await auditCount()).toBe(2);
  });
});
