import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createTestUser } from '../fixtures/userFixtures';
import {
  SERVING_GATEWAY,
  glm53Entry,
  jsonResponse,
  servingReadBody,
} from '../fixtures/gatewayModelServingWire';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE MODEL SERVING SCREEN'S SERVER SIDE (MOTIR-11280) through the REAL staff
// gate: only `getSession()` is stubbed, so `requirePlatformStaff` reads the real
// `platformRole`. The gateway is a stubbed `fetch` under the real client.

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const fetchMock = vi.fn<typeof fetch>();
let seq = 0;

async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `serving-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return { userId: user.id, email: user.email, role: role ?? 'support' };
}

/** A fresh module graph per case: `requirePlatformStaff` is React-`cache()`d. */
async function fresh() {
  const { platformModelServingService } =
    await import('@/lib/services/platformModelServingService');
  return platformModelServingService;
}

const setRows = () => adminDb.platformAuditLog.findMany({ where: { action: 'model_serving.set' } });

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('MOTIR_GATEWAY_URL', SERVING_GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', 'sentinel-serving-token');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('getView', () => {
  it.each([
    ['support', false],
    ['operator', false],
    ['superadmin', true],
  ] as const)('%s reads the list; canChange %s', async (role, canChange) => {
    const principal = await signInAs(role);
    fetchMock.mockResolvedValueOnce(jsonResponse(servingReadBody()));
    const view = await (await fresh()).getView(principal);
    expect(view).toMatchObject({ state: 'ok', canChange });
    if (view.state !== 'ok') return;
    const [e] = view.entries;
    // Listed under its maker, at its maker's price, with the channel names only.
    expect(e).toMatchObject({
      model: 'glm-5.3',
      modelName: 'GLM-5.3',
      originProvider: 'z-ai',
      originName: 'Z.ai',
      charged: { input: 1.4, output: 4.4 },
      priceSource: { host: 'docs.z.ai', readDate: '2026-11-15' },
      selected: null,
      effective: 'z-ai',
    });
    expect(e!.offerings.map((o) => [o.providerName, o.isOrigin, o.cost?.input])).toEqual([
      ['Z.ai', true, 1.4],
      ['Alibaba Cloud', false, 1.131],
    ]);
    expect(e!.offerings[1]!.costSource!.host).toBe('alibabacloud.com');
    expect(JSON.stringify(view)).not.toMatch(/channelId|channelType|sentinel/);
    // A read writes no audit row.
    expect(await setRows()).toHaveLength(0);
  });

  it('answers unavailable when the gateway cannot be read', async () => {
    const principal = await signInAs('support');
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await (await fresh()).getView(principal)).toEqual({ state: 'unavailable' });
  });

  it('refuses a non-staff caller before the gateway is asked', async () => {
    const principal = await signInAs(null);
    await expect((await fresh()).getView(principal)).rejects.toMatchObject({
      name: 'NotPlatformStaffError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('setServing', () => {
  it('saves the choice through the gateway and writes one audit row with from and to', async () => {
    const principal = await signInAs('superadmin');
    fetchMock.mockResolvedValueOnce(jsonResponse(servingReadBody())).mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: glm53Entry({
          selected: 'qwen',
          selectedBy: principal.email,
          selectedAt: '2026-11-15T10:01:00Z',
          effective: 'qwen',
        }),
      }),
    );
    const saved = await (await fresh()).setServing(principal, 'glm-5.3', 'qwen');
    expect(saved).toMatchObject({
      selected: 'qwen',
      effective: 'qwen',
      selectedBy: principal.email,
    });
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(init!.body as string)).toEqual({ provider: 'qwen', actor: principal.email });
    const rows = await setRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetKind: 'platform',
      targetId: 'glm-5.3',
      reason: 'changed in the model serving screen',
      metadata: {
        model: 'glm-5.3',
        fromProvider: null,
        toProvider: 'qwen',
        originProvider: 'z-ai',
      },
    });
  });

  it('clears a saved choice (null), recording the provider it moved from', async () => {
    const principal = await signInAs('superadmin');
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(servingReadBody([glm53Entry({ selected: 'qwen', effective: 'qwen' })])),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: glm53Entry() }));
    await (await fresh()).setServing(principal, 'glm-5.3', null);
    const [row] = await setRows();
    expect(row!.metadata).toMatchObject({ fromProvider: 'qwen', toProvider: null });
  });

  it.each(['support', 'operator', null] as const)(
    'refuses %s with no gateway call and no row',
    async (role) => {
      const principal = await signInAs(role);
      await expect((await fresh()).setServing(principal, 'glm-5.3', 'qwen')).rejects.toMatchObject({
        name: 'NotPlatformStaffError',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await setRows()).toHaveLength(0);
    },
  );

  it('refuses an unknown model and an unknown provider by name, before any write', async () => {
    const principal = await signInAs('superadmin');
    fetchMock.mockImplementation(async () => jsonResponse(servingReadBody()));
    const service = await fresh();
    await expect(service.setServing(principal, 'qwen-plus', 'qwen')).rejects.toMatchObject({
      name: 'ModelServingUnknownModelError',
      model: 'qwen-plus',
    });
    await expect(service.setServing(principal, 'glm-5.3', 'openai')).rejects.toMatchObject({
      name: 'ModelServingUnknownProviderError',
      provider: 'openai',
      offerings: ['z-ai', 'qwen'],
    });
    expect(fetchMock.mock.calls.every(([, init]) => init!.method === 'GET')).toBe(true);
    expect(await setRows()).toHaveLength(0);
  });

  it('refuses when the gateway cannot be read first', async () => {
    const principal = await signInAs('superadmin');
    fetchMock.mockRejectedValueOnce(new Error('reset'));
    await expect((await fresh()).setServing(principal, 'glm-5.3', 'qwen')).rejects.toMatchObject({
      name: 'ModelServingUnavailableError',
      reason: 'network',
    });
  });

  it('a gateway refusal rolls the audit row back', async () => {
    const principal = await signInAs('superadmin');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(servingReadBody()))
      .mockResolvedValueOnce(
        jsonResponse({ success: false, error: { code: 'model_serving_store_error' } }, 500),
      );
    await expect((await fresh()).setServing(principal, 'glm-5.3', 'qwen')).rejects.toMatchObject({
      name: 'GatewayModelServingRefusedError',
    });
    expect(await setRows()).toHaveLength(0);
  });

  it('logs, and rethrows, when the gateway saved but the audit row did not commit', async () => {
    const principal = await signInAs('superadmin');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(servingReadBody()))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: glm53Entry() }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const context = await import('@/lib/platform/context');
    vi.spyOn(context, 'withPlatformRead').mockImplementationOnce(async (_p, _e, fn) => {
      await fn({} as never);
      throw new Error('commit failed');
    });
    await expect((await fresh()).setServing(principal, 'glm-5.3', 'qwen')).rejects.toThrow(
      'commit failed',
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('did not commit'),
      { model: 'glm-5.3', provider: 'qwen' },
      expect.any(Error),
    );
  });
});
