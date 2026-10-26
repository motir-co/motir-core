import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  CAPACITY_GATEWAY,
  jsonResponse,
  refusalResponse,
  storedRowBody,
} from '../fixtures/gatewayCapacityWire';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CAPACITY SCREEN'S SERVER SIDE (Story MOTIR-9539 · MOTIR-9613) through the
// REAL staff gate: the only stub on the identity path is `getSession()` (vitest
// has no cookies), so `requirePlatformStaff` reads the real `platformRole`. The
// gateway is the client's in-memory fake, or a stubbed `fetch` under the real
// client; Sentry is the stubbed alert seam.

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const SENTINEL = 'sentinel-capacity-token-9613';
const PRIVATE_KEYS = /"(userId|updatedByUserId|email|workspaceId|organizationId|orgId)"/;

let seq = 0;
async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `capacity-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return { userId: user.id, email: user.email, role: role ?? 'support' };
}

/** A fresh module graph per case: `requirePlatformStaff` is React-`cache()`d. */
async function fresh() {
  const { platformCapacityService } = await import('@/lib/services/platformCapacityService');
  const { gatewayCapacityClient } = await import('@/lib/gateway/capacityProvider');
  const { capacityAlertEvaluationService } =
    await import('@/lib/services/capacityAlertEvaluationService');
  return {
    service: platformCapacityService,
    gateway: gatewayCapacityClient(),
    capacityAlertEvaluationService,
  };
}

const editRows = () =>
  adminDb.platformAuditLog.findMany({ where: { action: 'capacity.limits.edit' } });

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
  vi.stubEnv('MOTIR_GATEWAY_URL', CAPACITY_GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', SENTINEL);
  captureException.mockReset();
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await adminDb.capacityRaisedAlert.deleteMany();
  await adminDb.capacityAlertSetting.deleteMany();
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.capacityRaisedAlert.deleteMany();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('who may read the view', () => {
  it.each([
    ['support', false],
    ['operator', true],
    ['superadmin', true],
  ] as const)('%s reads it, canEdit %s', async (role, canEdit) => {
    const principal = await signInAs(role);
    const { service } = await fresh();
    const view = await service.getView(principal);
    expect(view.canEdit).toBe(canEdit);
    expect(view.capacity.outcome).toBe('answered');
  });

  it.each(['tenant user', 'workspace owner', 'anonymous'])(
    'a %s is refused before the gateway or the evaluation is asked',
    async (who) => {
      const principal = await signInAs(null);
      if (who === 'workspace owner') {
        await workspacesService.createWorkspace({
          name: 'Northwind',
          ownerUserId: principal.userId,
        });
      }
      if (who === 'anonymous') currentSession = null;
      const { service, gateway, capacityAlertEvaluationService } = await fresh();
      const read = vi.spyOn(gateway, 'read');
      const evaluate = vi.spyOn(capacityAlertEvaluationService, 'evaluate');
      await expect(service.getView(principal)).rejects.toMatchObject({
        name: 'NotPlatformStaffError',
      });
      expect(read).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
});

describe('the view of a live read', () => {
  it('carries six rows per entry in contract order, with the evaluation and the 429s', async () => {
    const principal = await signInAs('support');
    const { service } = await fresh();
    const view = await service.getView(principal);
    if (view.capacity.outcome !== 'answered') throw new Error('expected an answer');
    const qwen = view.capacity.entries.find((e) => e.provider === 'qwen')!;
    expect(qwen.limits.map((r) => r.unit)).toEqual([
      'max_concurrency',
      'rpm',
      'input_tpm',
      'output_tpm',
      'tpm',
      'tpd',
    ]);
    expect(qwen.limits[1]).toEqual({
      unit: 'rpm',
      limit: { status: 'set', value: 600 },
      usage: { total: 70, planning: 20, agent: 50 },
      sharePercent: (70 / 600) * 100,
      state: 'normal',
    });
    expect(qwen).toMatchObject({
      tierNote: 'Example tier (E2E fake)',
      unknownNote: '',
      planningSharePercent: 50,
      rateLimited429: { planning: { minute: 0, day: 2 }, agent: { minute: 0, day: 5 } },
    });
    expect(view.alertShare).toEqual({ percent: 80, isDefault: true });
  });

  it('a not-applicable or unknown limit never reads as 0', async () => {
    const principal = await signInAs('support');
    const { service, gateway } = await fresh();
    await gateway.write('qwen', 'qwen-example-1', { tpm: null });
    const view = await service.getView(principal);
    if (view.capacity.outcome !== 'answered') throw new Error('expected an answer');
    const qwen = view.capacity.entries.find((e) => e.provider === 'qwen')!;
    const tpm = qwen.limits.find((r) => r.unit === 'tpm')!;
    expect(tpm.limit).toEqual({ status: 'unknown' });
    expect(tpm.sharePercent).toBeNull();
    for (const row of qwen.limits.filter((r) => r.limit.status !== 'set')) {
      expect(row.limit).not.toHaveProperty('value');
    }
    expect(qwen.limits.find((r) => r.unit === 'tpd')!).toMatchObject({
      limit: { status: 'not_applicable' },
      usage: null,
      sharePercent: null,
    });
  });

  it('reads the gateway once, evaluates that read, and alerts once across two views', async () => {
    const principal = await signInAs('operator');
    const { service, gateway, capacityAlertEvaluationService } = await fresh();
    await gateway.write('deepseek', 'deepseek-example-1', { maxConcurrency: 8 });
    const read = vi.spyOn(gateway, 'read');
    const evaluate = vi.spyOn(capacityAlertEvaluationService, 'evaluate');
    const view = await service.getView(principal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({ read: await read.mock.results[0]!.value });
    expect(view.raised).toEqual([
      expect.objectContaining({
        provider: 'deepseek',
        model: 'deepseek-example-1',
        unit: 'max_concurrency',
        observedValue: 7,
        limitValue: 8,
      }),
    ]);
    await service.getView(principal);
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('a degraded or failed read', () => {
  it('the counter store down: every row unavailable, the limits and notes still shown', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', 'unavailable');
    const principal = await signInAs('support');
    const { service } = await fresh();
    const view = await service.getView(principal);
    if (view.capacity.outcome !== 'answered') throw new Error('expected an answer');
    expect(view.capacity.counterStore.state).toBe('unavailable');
    for (const entry of view.capacity.entries) {
      expect(entry.tierNote).not.toBe('');
      expect(entry.planningSharePercent).toBe(50);
      for (const row of entry.limits)
        expect(row).toMatchObject({ state: 'unavailable', usage: null });
    }
    expect(view.capacity.entries[0]!.limits.some((r) => r.limit.status === 'set')).toBe(true);
  });

  it.each([
    ['not_configured', 'credential'],
    ['auth_refused', 'credential'],
    ['timeout', 'unreachable'],
    ['network', 'unreachable'],
    ['server_error', 'unreachable'],
    ['config_unavailable', 'unreachable'],
    ['bad_response', 'unreachable'],
  ] as const)('%s reads as the %s panel, with the share and raised list', async (reason, panel) => {
    const principal = await signInAs('support');
    const { service, gateway } = await fresh();
    vi.spyOn(gateway, 'read').mockResolvedValue({ outcome: 'unavailable', reason });
    const view = await service.getView(principal);
    expect(view.capacity).toEqual({ outcome: 'unavailable', reason: panel });
    expect(view.alertShare).toEqual({ percent: 80, isDefault: true });
    expect(view.raised).toEqual([]);
  });
});

describe('the limit edit', () => {
  it.each([
    [{ rpm: -1 }, 'capacity_invalid_value', 'rpm'],
    [{ rpm: 1.5 }, 'capacity_invalid_value', 'rpm'],
    [{ tpd: Number.MAX_SAFE_INTEGER + 1 }, 'capacity_invalid_value', 'tpd'],
    [{ planningSharePercent: 101 }, 'capacity_invalid_value', 'planning_share_percent'],
    [{ tierNote: 'x'.repeat(1001) }, 'capacity_invalid_value', 'tier_note'],
    [{ tpm: -1, rpm: -1 }, 'capacity_invalid_value', 'rpm'],
    [{}, 'capacity_empty_edit', null],
  ])('refuses %j before the gateway, with no audit row', async (edit, code, field) => {
    const principal = await signInAs('operator');
    const { service, gateway } = await fresh();
    const write = vi.spyOn(gateway, 'write');
    await expect(
      service.editLimits(principal, 'qwen', 'qwen-example-1', edit),
    ).rejects.toMatchObject({
      code,
      field,
    });
    expect(write).not.toHaveBeenCalled();
    expect(await editRows()).toHaveLength(0);
  });

  it('refuses a provider outside the three', async () => {
    const principal = await signInAs('operator');
    const { service } = await fresh();
    await expect(service.editLimits(principal, 'openai', 'gpt', { rpm: 1 })).rejects.toMatchObject({
      code: 'capacity_unknown_provider',
    });
  });

  it('sends only the supplied keys, returns the stored row and audits once', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return jsonResponse(storedRowBody({ tpm: { status: 'unknown' } }));
      }),
    );
    const principal = await signInAs('operator');
    const { service } = await fresh();
    const entry = await service.editLimits(principal, 'qwen', 'qwen-example-1', {
      rpm: 900,
      tpm: null,
    });
    expect(sent).toEqual([{ rpm: 900, tpm: null }]);
    expect(entry).toMatchObject({ provider: 'qwen', updatedAt: '2026-10-25T12:00:00.123Z' });
    expect(entry.limits.find((r) => r.unit === 'tpm')!.limit).toEqual({ status: 'unknown' });
    const rows = await editRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetKind: 'platform',
      targetId: 'qwen/qwen-example-1',
      reason: 'edited in the capacity screen',
      metadata: { provider: 'qwen', model: 'qwen-example-1', keys: { rpm: 900, tpm: null } },
    });
  });

  it.each([
    [400, 'capacity_invalid_value', 'rpm'],
    [404, 'capacity_unknown_model', undefined],
    [500, 'capacity_store_error', undefined],
  ])('a gateway %i %s refusal leaves no audit row', async (status, code, field) => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusalResponse(status, code, field)),
    );
    const principal = await signInAs('operator');
    const { service } = await fresh();
    await expect(
      service.editLimits(principal, 'qwen', 'qwen-example-1', { rpm: 5 }),
    ).rejects.toMatchObject({ code });
    expect(await editRows()).toHaveLength(0);
  });
});

describe('a write below operator', () => {
  it.each(['support', null] as const)('by %s is refused with no write and no row', async (role) => {
    const principal = await signInAs(role);
    const { service, gateway } = await fresh();
    const write = vi.spyOn(gateway, 'write');
    await expect(
      service.editLimits(principal, 'qwen', 'qwen-example-1', { rpm: 5 }),
    ).rejects.toMatchObject({ name: 'NotPlatformStaffError' });
    await expect(service.setAlertShare(principal, 90)).rejects.toMatchObject({
      name: 'NotPlatformStaffError',
    });
    expect(write).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('privacy', () => {
  it('no view or edit result carries the token, the principal or an identifier key', async () => {
    const principal = await signInAs('superadmin');
    const { service, gateway } = await fresh();
    await gateway.write('deepseek', 'deepseek-example-1', { maxConcurrency: 8 });
    const results = [
      await service.getView(principal),
      await service.editLimits(principal, 'qwen', 'qwen-example-1', { tierNote: 'Tier 4' }),
      await service.setAlertShare(principal, 90),
      await service.getView(principal),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(principal.userId);
    expect(text).not.toContain(principal.email);
    expect(text).not.toMatch(PRIVATE_KEYS);
  });
});
