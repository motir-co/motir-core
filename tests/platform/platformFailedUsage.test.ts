import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawFailedUsageGroup, RawFailedUsageReplayWrite } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';

/**
 * Usage & cost's FAILED USAGE door (MOTIR-11794) over the real database:
 * `platformFailedUsageService` and the `/admin/usage` Replay action.
 *
 * The read is one `estate.read` whether or not motir-ai answered; the replay is
 * an operator write audited AFTER motir-ai answers, once per replay that reset
 * a row, and never for a group that had nothing left. The two motir-ai calls
 * are replaced; the gate honours the degree it is asked for unless a test lets
 * it through to prove the service still refuses.
 */

let currentPrincipal: PlatformPrincipal | null = null;
let gateHonoured = true;
const listMock = vi.fn<() => Promise<RawFailedUsageGroup[]>>();
const replayMock = vi.fn<(error: string, actor: string) => Promise<RawFailedUsageReplayWrite>>();

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

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return {
    ...actual,
    listFailedGatewayUsageGroups: () => listMock(),
    replayFailedGatewayUsageGroup: (error: string, actor: string) => replayMock(error, actor),
  };
});

const { db } = await import('@/lib/db');
const { platformFailedUsageService, FAILED_USAGE_REPLAY_AUDIT_REASON } =
  await import('@/lib/services/platformFailedUsageService');
const { replayFailedUsageAction } = await import('@/app/(admin)/admin/usage/actions');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const ERROR = 'Invalid `tx.usageMonthly.upsert()` invocation:\n\nValue out of range.';
const GROUP: RawFailedUsageGroup = {
  error: ERROR,
  rows: 7352,
  organizations: 41,
  oldestReceivedAt: '2026-11-12T03:18:00.000Z',
  newestReceivedAt: '2026-11-14T22:51:00.000Z',
};

function write(actor: string): RawFailedUsageReplayWrite {
  return {
    replay: { error: ERROR, reset: 7352, applied: 7340, failedAgain: 12, pending: 0 },
    audit: {
      action: 'ai.gateway_usage.replay',
      actorCoreUserId: actor,
      at: '2026-11-19T10:00:00.000Z',
      before: { error: ERROR, failedRows: 7352, organizations: 41 },
      after: { applied: 7340, failedAgain: 12, pending: 0 },
    },
  };
}

let operator: PlatformPrincipal;
let support: PlatformPrincipal;

const auditRows = (action: string) =>
  adminDb.platformAuditLog.findMany({ where: { action }, orderBy: { seq: 'asc' } });

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  gateHonoured = true;
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const op = await createTestUser({ email: 'ops+failed-usage@moooon.net' });
  const sup = await createTestUser({ email: 'support+failed-usage@moooon.net' });
  await adminDb.user.update({ where: { id: op.id }, data: { platformRole: 'operator' } });
  await adminDb.user.update({ where: { id: sup.id }, data: { platformRole: 'support' } });
  operator = { userId: op.id, email: op.email, role: 'operator' };
  support = { userId: sup.id, email: sup.email, role: 'support' };
  listMock.mockReset();
  replayMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformFailedUsageService.listGroups', () => {
  it('support reads the groups, and the read writes one estate.read row', async () => {
    currentPrincipal = support;
    listMock.mockResolvedValue([GROUP]);

    expect(await platformFailedUsageService.listGroups(support)).toEqual([GROUP]);
    const rows = await auditRows('estate.read');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: support.userId,
      targetKind: 'platform',
      targetLabel: 'failed usage',
    });
  });

  it('motir-ai not answering is the Unavailable state, still one audited read', async () => {
    currentPrincipal = support;
    listMock.mockRejectedValue(new MotirAiUnavailableError('down'));

    expect(await platformFailedUsageService.listGroups(support)).toBeNull();
    expect(await auditRows('estate.read')).toHaveLength(1);
  });

  it('a non-Error failure of the read is Unavailable too', async () => {
    currentPrincipal = support;
    listMock.mockRejectedValue('socket hang up');
    expect(await platformFailedUsageService.listGroups(support)).toBeNull();
  });

  it('refuses a caller with no standing before reading anything', async () => {
    currentPrincipal = null;
    await expect(platformFailedUsageService.listGroups(support)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(listMock).not.toHaveBeenCalled();
    expect(await auditRows('estate.read')).toHaveLength(0);
  });
});

describe('platformFailedUsageService.replayGroup', () => {
  it('replays as the operator and appends motir-ai’s record AFTER it answered', async () => {
    replayMock.mockImplementation(async (_error, actor) => write(actor));

    expect(
      await platformFailedUsageService.replayGroup({ error: ERROR, principal: operator }),
    ).toEqual({ error: ERROR, reset: 7352, applied: 7340, failedAgain: 12, pending: 0 });
    expect(replayMock).toHaveBeenCalledWith(ERROR, operator.userId);
    const rows = await auditRows('ai.gateway_usage.replay');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: operator.userId,
      targetKind: 'platform',
      targetId: null,
      targetLabel: ERROR,
      reason: FAILED_USAGE_REPLAY_AUDIT_REASON,
      metadata: {
        error: ERROR,
        failedRows: 7352,
        organizations: 41,
        applied: 7340,
        failedAgain: 12,
        pending: 0,
      },
    });
  });

  it('cuts a long error to 200 characters in the audit label', async () => {
    const long = 'x'.repeat(500);
    replayMock.mockImplementation(async (_e, actor) => {
      const w = write(actor);
      return { ...w, replay: { ...w.replay, error: long } };
    });
    await platformFailedUsageService.replayGroup({ error: long, principal: operator });
    const [row] = await auditRows('ai.gateway_usage.replay');
    expect(row?.targetLabel).toBe('x'.repeat(200));
  });

  it('a group with nothing left (audit null) replays nothing and records nothing', async () => {
    replayMock.mockResolvedValue({
      replay: { error: ERROR, reset: 0, applied: 0, failedAgain: 0, pending: 0 },
      audit: null,
    });
    const replay = await platformFailedUsageService.replayGroup({
      error: ERROR,
      principal: operator,
    });
    expect(replay.reset).toBe(0);
    expect(await auditRows('ai.gateway_usage.replay')).toHaveLength(0);
  });

  it('refuses support before anything is sent', async () => {
    await expect(
      platformFailedUsageService.replayGroup({ error: ERROR, principal: support }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('a replay motir-ai did not answer throws and records nothing', async () => {
    replayMock.mockRejectedValue(new MotirAiUnavailableError('timed out'));
    await expect(
      platformFailedUsageService.replayGroup({ error: ERROR, principal: operator }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(await auditRows('ai.gateway_usage.replay')).toHaveLength(0);
  });
});

describe('replayFailedUsageAction', () => {
  it('operator: answers the replay', async () => {
    currentPrincipal = operator;
    replayMock.mockImplementation(async (_e, actor) => write(actor));
    await expect(replayFailedUsageAction(ERROR)).resolves.toEqual({
      ok: true,
      replay: { error: ERROR, reset: 7352, applied: 7340, failedAgain: 12, pending: 0 },
    });
  });

  it('support: NOT_PERMITTED at the gate, nothing sent', async () => {
    currentPrincipal = support;
    await expect(replayFailedUsageAction(ERROR)).resolves.toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('support past the gate: the service still refuses', async () => {
    currentPrincipal = support;
    gateHonoured = false;
    await expect(replayFailedUsageAction(ERROR)).resolves.toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('a group that is not a string is INVALID, before the gate', async () => {
    currentPrincipal = operator;
    await expect(replayFailedUsageAction(42)).resolves.toEqual({ ok: false, code: 'INVALID' });
    expect(replayMock).not.toHaveBeenCalled();
  });

  it('a replay that did not answer is FAILED, never a throw', async () => {
    currentPrincipal = operator;
    replayMock.mockRejectedValue(new MotirAiUnavailableError('timed out'));
    await expect(replayFailedUsageAction(ERROR)).resolves.toEqual({ ok: false, code: 'FAILED' });
  });

  it('a non-Error failure is FAILED too', async () => {
    currentPrincipal = operator;
    replayMock.mockRejectedValue('boom');
    await expect(replayFailedUsageAction(ERROR)).resolves.toEqual({ ok: false, code: 'FAILED' });
  });
});
