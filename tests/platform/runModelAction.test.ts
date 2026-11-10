import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformRunModelService } from '@/lib/services/platformRunModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The HOSTED-RUN MODEL LIST Server ACTIONS (MOTIR-7528) — their result codes.
 *
 * Transport only: the rules live in `platformRunModelService`, which has its own
 * suite. What is asserted here is the TRANSLATION — each refusal the page draws
 * differently reaches it as its own code — and that a refusal writes no audit
 * row. motir-ai's `/v1/agent-models` is stubbed at the HTTP boundary.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

const { addRunModelAction, removeRunModelAction } =
  await import('@/app/(admin)/admin/run-models/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+run-model-action-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

let offered: { id: string; provider: string }[] = [];
let motirAiDown = false;

/** The run-side review-agent default the stub stores (MOTIR-10844); design stays unset. */
let reviewDefault: string | null = null;

const fetchStub = vi.fn(async (url: string) => {
  if (motirAiDown) throw new TypeError('fetch failed');
  if (url.endsWith('/v1/admin/run-model-defaults')) {
    return new Response(
      JSON.stringify({
        settings: (['review', 'design'] as const).map((key) => ({
          key,
          model: key === 'review' ? reviewDefault : null,
          offered: null,
          effectiveModel: null,
          updatedAt: '1970-01-01T00:00:00.000Z',
          updatedByCoreUserId: null,
        })),
        models: offered,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      models: offered,
      default: null,
      defaultsByDifficulty: {
        trivial: 'claude-sonnet-5-5',
        low: 'claude-sonnet-5-5',
        medium: 'claude-opus-5-5',
        high: 'claude-opus-5-5',
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});

const auditRows = () => adminDb.platformAuditLog.findMany();

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  vi.mocked(revalidatePath).mockClear();
  motirAiDown = false;
  reviewDefault = null;
  offered = [
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', provider: 'anthropic' },
    { id: 'glm-5.2', provider: 'z-ai' },
  ];
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
  // The first read seeds the list with the offer above.
  await platformRunModelService.listModels(currentPrincipal);
  // Only the action's own rows are counted below, not the seed's.
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('addRunModelAction', () => {
  it('adds a newly offered model, writes one audit row, and revalidates the page', async () => {
    offered.push({ id: 'kimi-k2.6', provider: 'moonshot' });
    expect(await addRunModelAction('kimi-k2.6', 'Try it')).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/run-models');
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'Try it' });
  });

  it('NOT_OFFERED — revalidates so the picker re-reads; no row', async () => {
    expect(await addRunModelAction('never-offered', 'r')).toEqual({
      ok: false,
      code: 'NOT_OFFERED',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/run-models');
    expect(await auditRows()).toHaveLength(0);
  });

  it('ALREADY_LISTED — no row', async () => {
    expect(await addRunModelAction('glm-5.2', 'r')).toEqual({
      ok: false,
      code: 'ALREADY_LISTED',
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNAVAILABLE — motir-ai is down', async () => {
    motirAiDown = true;
    expect(await addRunModelAction('glm-5.2', 'r')).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('REASON_REQUIRED — a blank reason', async () => {
    offered.push({ id: 'kimi-k2.6', provider: 'moonshot' });
    expect(await addRunModelAction('kimi-k2.6', '  ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
  });

  it('NOT_PERMITTED — an operator', async () => {
    currentPrincipal = await seedStaff('operator');
    expect(await addRunModelAction('kimi-k2.6', 'r')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
  });

  it('FAILED — anything else, logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(platformRunModelService, 'addModel').mockRejectedValueOnce(new RangeError('boom'));
    expect(await addRunModelAction('x', 'r')).toEqual({ ok: false, code: 'FAILED' });
    expect(spy).toHaveBeenCalled();
  });
});

describe('removeRunModelAction', () => {
  it('removes an unused model, writes one audit row, and revalidates', async () => {
    expect(await removeRunModelAction('glm-5.2', 'unused')).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/run-models');
    expect(await auditRows()).toHaveLength(1);
  });

  it('IN_USE — names the platform default levels; no row', async () => {
    expect(await removeRunModelAction('claude-opus-5-5', 'r')).toEqual({
      ok: false,
      code: 'IN_USE',
      projects: [],
      platformLevels: ['medium', 'high'],
      platformRoles: [],
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('IN_USE — names the platform review-agent default (MOTIR-10844); no row', async () => {
    reviewDefault = 'glm-5.2';
    expect(await removeRunModelAction('glm-5.2', 'r')).toEqual({
      ok: false,
      code: 'IN_USE',
      projects: [],
      platformLevels: [],
      platformRoles: ['review'],
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('NOT_LISTED — revalidates; no row', async () => {
    expect(await removeRunModelAction('kimi-k2.6', 'r')).toEqual({
      ok: false,
      code: 'NOT_LISTED',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/run-models');
    expect(await auditRows()).toHaveLength(0);
  });
});
