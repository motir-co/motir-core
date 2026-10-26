import { revalidatePath } from 'next/cache';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  CAPACITY_GATEWAY,
  jsonResponse,
  refusalResponse,
  storedRowBody,
} from '../fixtures/gatewayCapacityWire';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CAPACITY SCREEN'S SERVER ACTIONS (Story MOTIR-9539 · MOTIR-9613) through
// the REAL staff gate — a Server Action is a POST the admin layout never renders,
// so the action's own gate is what refuses. `getSession()` is the only identity
// stub; the gateway is a stubbed `fetch` under the real client.

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const SENTINEL = 'sentinel-capacity-token-9613-actions';
let gatewayAnswer: () => Promise<Response> = async () => jsonResponse(storedRowBody());
const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => gatewayAnswer());

let seq = 0;
async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `capacity-action-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return user;
}

/** A fresh module graph per case: `requirePlatformStaff` is React-`cache()`d. */
const actions = () => import('@/app/(admin)/admin/capacity/actions');

beforeEach(async () => {
  vi.resetModules();
  vi.mocked(revalidatePath).mockClear();
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
  vi.stubEnv('MOTIR_GATEWAY_URL', CAPACITY_GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', SENTINEL);
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  gatewayAnswer = async () => jsonResponse(storedRowBody());
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await adminDb.capacityAlertSetting.deleteMany();
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await adminDb.capacityAlertSetting.deleteMany();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('editCapacityLimitsAction', () => {
  it('a valid edit returns the stored entry and revalidates the screen', async () => {
    await signInAs('operator');
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', {
      rpm: 600,
    });
    expect(result).toMatchObject({
      ok: true,
      entry: { provider: 'qwen', model: 'qwen-example-1' },
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/capacity');
  });

  it('core refuses a negative limit as INVALID_VALUE on rpm, without asking the gateway', async () => {
    await signInAs('operator');
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', {
      rpm: -1,
    });
    expect(result).toEqual({ ok: false, code: 'INVALID_VALUE', field: 'rpm' });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty edit', {}, { ok: false, code: 'EMPTY_EDIT' }],
    ['an unknown key', { rps: 1 }, { ok: false, code: 'INVALID_BODY', field: 'rps' }],
  ])('core refuses %s', async (_label, edit, expected) => {
    await signInAs('operator');
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', edit as never);
    expect(result).toEqual(expected);
  });

  it('a provider outside the three is UNKNOWN_PROVIDER', async () => {
    await signInAs('operator');
    expect(await (await actions()).editCapacityLimitsAction('openai', 'gpt', { rpm: 1 })).toEqual({
      ok: false,
      code: 'UNKNOWN_PROVIDER',
    });
  });

  it.each([
    [404, 'capacity_unknown_model', undefined, { ok: false, code: 'UNKNOWN_MODEL' }],
    [400, 'capacity_invalid_value', 'tpm', { ok: false, code: 'INVALID_VALUE', field: 'tpm' }],
    [400, 'capacity_invalid_body', undefined, { ok: false, code: 'INVALID_BODY' }],
    [500, 'capacity_store_error', undefined, { ok: false, code: 'STORE_ERROR' }],
    [401, 'capacity_auth_invalid', undefined, { ok: false, code: 'CREDENTIAL' }],
    [403, 'capacity_auth_forbidden', undefined, { ok: false, code: 'CREDENTIAL' }],
    [502, 'unknown', undefined, { ok: false, code: 'UNAVAILABLE' }],
  ])('a gateway %i %s answers %j', async (status, code, field, expected) => {
    gatewayAnswer = async () => refusalResponse(status, code, field);
    await signInAs('operator');
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', {
      rpm: 5,
    });
    expect(result).toEqual(expected);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('an unset token is CREDENTIAL', async () => {
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '');
    await signInAs('operator');
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', {
      rpm: 5,
    });
    expect(result).toEqual({ ok: false, code: 'CREDENTIAL' });
  });

  it('a gateway that never answers is UNAVAILABLE', async () => {
    fetchStub.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await signInAs('operator');
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', {
      rpm: 5,
    });
    expect(result).toEqual({ ok: false, code: 'UNAVAILABLE' });
  }, 15_000);

  it.each(['support', null] as const)('a %s caller is NOT_PERMITTED', async (role) => {
    await signInAs(role);
    const result = await (
      await actions()
    ).editCapacityLimitsAction('qwen', 'qwen-example-1', {
      rpm: 5,
    });
    expect(result).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('setCapacityAlertShareAction', () => {
  it('an operator sets 90; 90 again is UNCHANGED; the next view evaluates against 90', async () => {
    await signInAs('operator');
    expect(await (await actions()).setCapacityAlertShareAction(90)).toEqual({
      ok: true,
      alertShare: { percent: 90, isDefault: false },
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/capacity');
    vi.resetModules();
    expect(await (await actions()).setCapacityAlertShareAction(90)).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
    vi.resetModules();
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
    const { platformCapacityService } = await import('@/lib/services/platformCapacityService');
    const { requirePlatformStaff } = await import('@/lib/platform/auth');
    const view = await platformCapacityService.getView(await requirePlatformStaff('support'));
    expect(view.alertShare).toEqual({ percent: 90, isDefault: false });
  });

  it.each([0, 101])('%i is INVALID_VALUE', async (percent) => {
    await signInAs('operator');
    expect(await (await actions()).setCapacityAlertShareAction(percent)).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
    });
  });

  it('a support caller is NOT_PERMITTED', async () => {
    await signInAs('support');
    expect(await (await actions()).setCapacityAlertShareAction(90)).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
  });
});

describe('privacy', () => {
  it('no action result carries the token, the principal or an identifier key', async () => {
    const user = await signInAs('operator');
    const a = await actions();
    const results: unknown[] = [
      await a.editCapacityLimitsAction('qwen', 'qwen-example-1', { rpm: 600 }),
      await a.editCapacityLimitsAction('qwen', 'qwen-example-1', { rpm: -1 }),
      await a.setCapacityAlertShareAction(90),
      await a.setCapacityAlertShareAction(101),
    ];
    gatewayAnswer = async () => refusalResponse(401, 'capacity_auth_invalid');
    results.push(await a.editCapacityLimitsAction('qwen', 'qwen-example-1', { rpm: 5 }));
    const text = JSON.stringify(results);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(user.id);
    expect(text).not.toContain(user.email);
    expect(text).not.toMatch(/"(userId|updatedByUserId|email|workspaceId|organizationId|orgId)"/);
  });
});
