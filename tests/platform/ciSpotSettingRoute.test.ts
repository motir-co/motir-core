import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CI SPOT SETTING's route (MOTIR-11725): `GET` and `PUT
// /api/platform/fleet/ci-spot` through the real session gate and the real
// service, against a real Postgres. The one mock is `getSession()`. A
// `superadmin` reads and saves the setting; anyone below gets the console's
// not-found and learns nothing — a bearer token alone included.

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const DEFAULTS = ['m6i.large', 'm7i.large', 'm5.large', 'm6a.large'];

let seq = 0;
async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `ci-spot-route-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return user;
}

async function get() {
  const { GET } = await import('@/app/api/platform/fleet/ci-spot/route');
  const res = await GET();
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function put(body: unknown, init: { raw?: string; headers?: Record<string, string> } = {}) {
  const { PUT } = await import('@/app/api/platform/fleet/ci-spot/route');
  const res = await PUT(
    new Request('http://localhost/api/platform/fleet/ci-spot', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: init.raw ?? JSON.stringify(body),
    }),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function auditCount() {
  return adminDb.platformAuditLog.count({ where: { action: 'fleet.ci_spot.update' } });
}

beforeEach(async () => {
  currentSession = null;
  await adminDb.platformCiSpotSetting.deleteMany();
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.platformCiSpotSetting.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/platform/fleet/ci-spot', () => {
  it('answers a superadmin 200 with the state and no-store', async () => {
    await signInAs('superadmin');
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      enabled: false,
      instanceTypes: DEFAULTS,
      isDefault: true,
      lastReason: null,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it.each(['support', 'operator', 'tenant user', 'anonymous', 'bearer token only'] as const)(
    'answers a %s 404 NOT_FOUND with nothing about the setting',
    async (who) => {
      if (who === 'support' || who === 'operator') await signInAs(who);
      else if (who === 'tenant user') await signInAs(null);
      const { res, body } = await get();
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(body).toEqual({ code: 'NOT_FOUND' });
    },
  );
});

describe('PUT /api/platform/fleet/ci-spot', () => {
  it('saves for a superadmin: 200 with outcome and the new state, one audit row', async () => {
    const user = await signInAs('superadmin');
    const { res, body } = await put({
      enabled: true,
      instanceTypes: ['m7i.large', 'm6i.large'],
      reason: 'on-demand label and interruptions are live',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      outcome: 'changed',
      state: {
        enabled: true,
        instanceTypes: ['m7i.large', 'm6i.large'],
        isDefault: false,
        lastReason: 'on-demand label and interruptions are live',
        updatedBy: { userId: user.id, email: user.email },
      },
    });
    expect(await auditCount()).toBe(1);

    const again = await put({
      enabled: true,
      instanceTypes: ['m7i.large', 'm6i.large'],
      reason: 'again',
    });
    expect(again.res.status).toBe(200);
    expect(again.body['outcome']).toBe('unchanged');
    expect(await auditCount()).toBe(1);

    const read = await get();
    expect(read.body).toMatchObject({ enabled: true, instanceTypes: ['m7i.large', 'm6i.large'] });
  });

  it.each(['', '   '])('a blank reason (%j) is 400 MISSING_AUDIT_REASON', async (reason) => {
    await signInAs('superadmin');
    const { res, body } = await put({ enabled: true, instanceTypes: DEFAULTS, reason });
    expect(res.status).toBe(400);
    expect(body).toEqual({ code: 'MISSING_AUDIT_REASON' });
    expect(await adminDb.platformCiSpotSetting.count()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it.each([
    ['not JSON', undefined, '{not json'],
    ['a missing flag', { instanceTypes: DEFAULTS, reason: 'go' }, undefined],
    ['a string flag', { enabled: 'yes', instanceTypes: DEFAULTS, reason: 'go' }, undefined],
    [
      'a list that is not an array',
      { enabled: true, instanceTypes: 'm6i.large', reason: 'go' },
      undefined,
    ],
    ['a missing reason', { enabled: true, instanceTypes: DEFAULTS }, undefined],
  ] as const)('a malformed body (%s) is 400 INVALID_BODY', async (_label, body, raw) => {
    await signInAs('superadmin');
    const out = await put(body, raw ? { raw } : {});
    expect(out.res.status).toBe(400);
    expect(out.body).toEqual({ code: 'INVALID_BODY' });
    expect(await adminDb.platformCiSpotSetting.count()).toBe(0);
  });

  it.each([
    ['empty', [], null],
    ['duplicate', ['m6i.large', 'm6i.large'], 'm6i.large'],
    ['not_allowed', ['m6g.large'], 'm6g.large'],
  ] as const)(
    'an invalid list (%s) is 400 naming the rule and the type',
    async (rule, list, type) => {
      await signInAs('superadmin');
      const { res, body } = await put({ enabled: true, instanceTypes: list, reason: 'go' });
      expect(res.status).toBe(400);
      expect(body).toEqual({ code: 'INVALID_CI_SPOT_INSTANCE_TYPES', rule, instanceType: type });
      expect(await adminDb.platformCiSpotSetting.count()).toBe(0);
      expect(await auditCount()).toBe(0);
    },
  );

  it.each(['support', 'operator', 'tenant user', 'anonymous'] as const)(
    'answers a %s 404 NOT_FOUND and writes nothing',
    async (who) => {
      if (who === 'support' || who === 'operator') await signInAs(who);
      else if (who === 'tenant user') await signInAs(null);
      const { res, body } = await put({ enabled: true, instanceTypes: DEFAULTS, reason: 'go' });
      expect(res.status).toBe(404);
      expect(body).toEqual({ code: 'NOT_FOUND' });
      expect(await adminDb.platformCiSpotSetting.count()).toBe(0);
      expect(await auditCount()).toBe(0);
    },
  );

  it('a bearer token alone does not reach it', async () => {
    const { res, body } = await put(
      { enabled: true, instanceTypes: DEFAULTS, reason: 'go' },
      { headers: { authorization: 'Bearer motir_pat_not_a_session' } },
    );
    expect(res.status).toBe(404);
    expect(body).toEqual({ code: 'NOT_FOUND' });
    expect(await adminDb.platformCiSpotSetting.count()).toBe(0);
  });
});

describe('an unexpected service failure', () => {
  it('is not swallowed as a 404 or a 400 — GET and PUT rethrow it', async () => {
    await signInAs('superadmin');
    const { ciSpotSettingService } = await import('@/lib/services/ciSpotSettingService');
    const boom = new Error('database went away');
    const getSpy = vi.spyOn(ciSpotSettingService, 'getState').mockRejectedValueOnce(boom);
    const saveSpy = vi.spyOn(ciSpotSettingService, 'save').mockRejectedValueOnce(boom);
    try {
      await expect(get()).rejects.toBe(boom);
      await expect(put({ enabled: true, instanceTypes: DEFAULTS, reason: 'go' })).rejects.toBe(
        boom,
      );
    } finally {
      getSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });
});
