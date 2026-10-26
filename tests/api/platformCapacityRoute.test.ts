import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE CAPACITY SCREEN'S POLL (Story MOTIR-9539 · MOTIR-9613): `GET
// /api/platform/capacity` through the real session gate, with the gateway as the
// client's in-memory fake. Staff get the view, uncached; anyone else gets the
// console's not-found and no capacity data — a bearer token alone included.

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const SENTINEL = 'sentinel-capacity-token-9613-route';

let seq = 0;
async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `capacity-route-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return user;
}

async function get() {
  const { GET } = await import('@/app/api/platform/capacity/route');
  const res = await GET();
  return { res, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', SENTINEL);
  currentSession = null;
  await adminDb.capacityRaisedAlert.deleteMany();
  await truncateAuthTables();
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('GET /api/platform/capacity', () => {
  it.each(['support', 'operator', 'superadmin'] as const)(
    'answers %s staff 200 with the view and no-store',
    async (role) => {
      const user = await signInAs(role);
      const { res, body } = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(body).toHaveProperty('alertShare');
      expect(body).toHaveProperty('raised');
      expect((body['capacity'] as { outcome: string }).outcome).toBe('answered');
      const text = JSON.stringify(body);
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(user.id);
      expect(text).not.toContain(user.email);
      expect(text).not.toMatch(/"(userId|updatedByUserId|email|workspaceId|organizationId|orgId)"/);
    },
  );

  it.each(['tenant user', 'tenant admin', 'anonymous', 'bearer token only'])(
    'answers a %s 404 with no capacity data',
    async (who) => {
      if (who !== 'anonymous' && who !== 'bearer token only') {
        const user = await signInAs(null);
        if (who === 'tenant admin') {
          await workspacesService.createWorkspace({ name: 'Northwind', ownerUserId: user.id });
        }
      }
      // A bearer token alone: the handler takes no request and reads the session
      // through `requirePlatformStaff`, never `ideasGate`, so with no session there
      // is nothing a token could be presented to.
      const { res, body } = await get();
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      for (const key of ['entries', 'alertShare', 'raised', 'capacity']) {
        expect(body).not.toHaveProperty(key);
      }
    },
  );
});
