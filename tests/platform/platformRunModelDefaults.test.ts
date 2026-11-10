import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  RunModelDefaultKeyUnknownError,
  RunModelDefaultUnchangedError,
} from '@/lib/platform/errors';
import { MotirAiUnavailableError, RunModelDefaultNotOfferedError } from '@/lib/ai/errors';
import { getRunModelDefaults, setRunModelDefault } from '@/lib/ai/motirAiClient';
import type { RunModelDefaultKey, RunModelDefaultRead } from '@/lib/ai/types';
import { platformRunModelDefaultsService as service } from '@/lib/services/platformRunModelDefaultsService';
import { platformRunModelService } from '@/lib/services/platformRunModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The RUN-SIDE PLATFORM DEFAULTS in the console (Story MOTIR-10838 · MOTIR-10844)
 * — the client, the seam and the action.
 *
 * Real Postgres for the audit trail and the run-model list: every refusal is
 * checked against the ROW COUNT. motir-ai is stubbed at the HTTP boundary:
 * `/v1/agent-models` (the offer the run-model list narrows) and `GET` / `PUT
 * /v1/admin/run-model-defaults`. The PUT answers `audit` from the stub's own
 * store, so a no-op answers `audit: null` exactly as motir-ai does.
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

const { setRunModelDefaultAction } = await import('@/app/(admin)/admin/run-models/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+run-defaults-${role}-${seq++}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const GLM = 'glm-5.2';
const EPOCH = '1970-01-01T00:00:00.000Z';

let offered: { id: string; provider: string }[] = [];
let store: Record<RunModelDefaultKey, RunModelDefaultRead>;
let down: 'none' | 'defaults' | 'offer' | 'put' = 'none';
let putAnswer:
  | { kind: 'store' }
  | { kind: 'noop' }
  | { kind: 'body'; body: unknown }
  | { kind: 'problem'; code: string; status: number } = { kind: 'store' };
let puts: { url: string; body: Record<string, unknown> }[] = [];

function seededRow(key: RunModelDefaultKey, model: string | null): RunModelDefaultRead {
  return {
    key,
    model,
    offered: model === null ? null : true,
    effectiveModel: model,
    updatedAt: EPOCH,
    updatedByCoreUserId: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const KEYS: RunModelDefaultKey[] = ['trivial', 'low', 'medium', 'high', 'review', 'design'];

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  if (url.endsWith('/v1/agent-models')) {
    if (down === 'offer') throw new TypeError('fetch failed');
    return json({
      models: offered,
      default: SONNET,
      defaultsByDifficulty: {
        trivial: store.trivial.model,
        low: store.low.model,
        medium: store.medium.model,
        high: store.high.model,
      },
      reviewAgentDefault: store.review.model,
      designRunDefault: store.design.model,
    });
  }
  if (init.method === 'GET') {
    if (down === 'defaults') throw new TypeError('fetch failed');
    return json({ settings: KEYS.map((k) => store[k]), models: offered });
  }
  if (down === 'put') throw new TypeError('fetch failed');
  const body = JSON.parse(String(init.body)) as {
    key: RunModelDefaultKey;
    model: string | null;
    actorCoreUserId: string;
  };
  puts.push({ url, body });
  if (putAnswer.kind === 'problem') {
    const { code, status } = putAnswer;
    return json({ type: 'about:blank', title: code, status, code }, status);
  }
  if (putAnswer.kind === 'body') return json(putAnswer.body);
  const before = store[body.key].model;
  if (putAnswer.kind === 'noop' || before === body.model) {
    return json({ setting: store[body.key], audit: null });
  }
  store[body.key] = {
    key: body.key,
    model: body.model,
    offered: body.model === null ? null : true,
    effectiveModel: body.model,
    updatedAt: '2026-11-10T10:00:00.000Z',
    updatedByCoreUserId: body.actorCoreUserId,
  };
  return json({
    setting: store[body.key],
    audit: {
      action: 'ai.run_model_default.set',
      actorCoreUserId: body.actorCoreUserId,
      at: '2026-11-10T10:00:00.000Z',
      key: body.key,
      before: { model: before },
      after: { model: body.model },
    },
  });
});

const auditRows = () =>
  adminDb.platformAuditLog.findMany({
    where: { action: 'ai.run_model_default.set' },
    orderBy: { seq: 'asc' },
  });

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  vi.mocked(revalidatePath).mockClear();
  down = 'none';
  putAnswer = { kind: 'store' };
  puts = [];
  offered = [
    { id: OPUS, provider: 'anthropic' },
    { id: SONNET, provider: 'anthropic' },
    { id: GLM, provider: 'z-ai' },
  ];
  store = {
    trivial: seededRow('trivial', SONNET),
    low: seededRow('low', SONNET),
    medium: seededRow('medium', OPUS),
    high: seededRow('high', OPUS),
    review: seededRow('review', null),
    design: seededRow('design', null),
  };
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
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

/** Seed the run-model list from the offer, then take `model` off it. */
async function delist(model: string) {
  await platformRunModelService.listModels(currentPrincipal!);
  await adminDb.platformRunModel.deleteMany({ where: { model } });
}

describe('the client', () => {
  it('getRunModelDefaults GETs the six rows with the service bearer', async () => {
    const read = await getRunModelDefaults();
    expect(read.settings.map((s) => s.key)).toEqual(KEYS);
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.example.test/v1/admin/run-model-defaults');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it.each([
    ['no settings', { models: [] }],
    ['an unknown key', { settings: [{ ...seededRow('review', null), key: 'plan' }], models: [] }],
    [
      'a numeric updatedAt',
      { settings: [{ ...seededRow('low', null), updatedAt: 1 }], models: [] },
    ],
    ['a model without a provider', { settings: [], models: [{ id: 'x' }] }],
    ['a null model entry', { settings: [], models: [null] }],
  ])('a read with %s is unavailable', async (_, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(body)),
    );
    await expect(getRunModelDefaults()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a body that is not JSON is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    );
    await expect(getRunModelDefaults()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a 5xx read is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'internal_error', title: 'x', status: 500 }, 500)),
    );
    await expect(getRunModelDefaults()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('a validation_error on the write is the run-side not-offered error naming the model', async () => {
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400 };
    const err = await setRunModelDefault({ key: 'review', model: GLM, actorCoreUserId: 'u' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RunModelDefaultNotOfferedError);
    expect((err as RunModelDefaultNotOfferedError).model).toBe(GLM);
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400 };
    await expect(
      setRunModelDefault({ key: 'review', model: null, actorCoreUserId: 'u' }),
    ).rejects.toThrow('"" is not offered');
  });

  it('another problem on the write is the typed error', async () => {
    putAnswer = { kind: 'problem', code: 'internal_error', status: 500 };
    await expect(
      setRunModelDefault({ key: 'review', model: GLM, actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it.each([
    ['no setting', { audit: null }],
    ['another key', { setting: seededRow('low', GLM), audit: null }],
    ['an audit of another key', { setting: seededRow('review', GLM), audit: { key: 'low' } }],
    [
      'an audit with a numeric before',
      {
        setting: seededRow('review', GLM),
        audit: { key: 'review', at: 'n', before: { model: 1 }, after: { model: GLM } },
      },
    ],
    ['an audit that is a string', { setting: seededRow('review', GLM), audit: 'x' }],
  ])('a write answer with %s is unavailable', async (_, body) => {
    putAnswer = { kind: 'body', body };
    await expect(
      setRunModelDefault({ key: 'review', model: GLM, actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('getDefaults — six rows, narrowed to the run-model list', () => {
  it('in review, design, trivial…high order; unset review inherits the run default, design nothing', async () => {
    const dto = await service.getDefaults(currentPrincipal!);
    expect(dto.canEdit).toBe(true);
    expect(dto.rows.map((r) => r.key)).toEqual([
      'review',
      'design',
      'trivial',
      'low',
      'medium',
      'high',
    ]);
    expect(dto.rows[0]).toEqual({
      key: 'review',
      model: null,
      withdrawn: false,
      inheritsModel: SONNET,
      updatedAt: null,
      updatedBy: null,
      seeded: true,
    });
    expect(dto.rows[1]).toMatchObject({ key: 'design', model: null, inheritsModel: null });
    expect(dto.rows[2]).toMatchObject({ key: 'trivial', model: SONNET, seeded: true });
    expect(dto.options.map((o) => o.id)).toEqual([OPUS, SONNET, GLM]);
  });

  it('a cleared level shows the environment value motir-ai answers as effectiveModel', async () => {
    store.low = { ...seededRow('low', null), effectiveModel: 'env-model' };
    const dto = await service.getDefaults(currentPrincipal!);
    expect(dto.rows.find((r) => r.key === 'low')).toMatchObject({
      model: null,
      inheritsModel: 'env-model',
    });
  });

  it('withdrawn when motir-ai stops offering it OR it is off the run-model list; options follow the list', async () => {
    const changer = await seedStaff('superadmin');
    store.review = {
      ...seededRow('review', GLM),
      updatedAt: '2026-11-09T09:00:00.000Z',
      updatedByCoreUserId: changer.userId,
    };
    store.design = { ...seededRow('design', OPUS), offered: false };
    await delist(GLM);
    const dto = await service.getDefaults(currentPrincipal!);
    expect(dto.options.map((o) => o.id)).toEqual([OPUS, SONNET]);
    expect(dto.rows.find((r) => r.key === 'review')).toMatchObject({
      model: GLM,
      withdrawn: true,
      updatedAt: '2026-11-09T09:00:00.000Z',
      updatedBy: 'Ops superadmin',
      seeded: false,
    });
    expect(dto.rows.find((r) => r.key === 'design')?.withdrawn).toBe(true);
    expect(dto.rows.find((r) => r.key === 'medium')?.withdrawn).toBe(false);
  });

  it('a row motir-ai did not answer is left out, never invented', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) =>
        url.endsWith('/v1/admin/run-model-defaults')
          ? json({ settings: [store.review], models: offered })
          : fetchStub(url, init),
      ),
    );
    const dto = await service.getDefaults(currentPrincipal!);
    expect(dto.rows.map((r) => r.key)).toEqual(['review']);
  });

  it.each(['support', 'operator'] as const)('a %s reads it, without editing', async (role) => {
    currentPrincipal = await seedStaff(role);
    expect((await service.getDefaults(currentPrincipal)).canEdit).toBe(false);
  });

  it.each(['defaults', 'offer'] as const)(
    'motir-ai unanswered (%s) is unavailable — no rows, no guess',
    async (which) => {
      down = which;
      await expect(service.getDefaults(currentPrincipal!)).rejects.toBeInstanceOf(
        MotirAiUnavailableError,
      );
    },
  );

  it('a non-staff caller is refused', async () => {
    currentPrincipal = null;
    await expect(
      service.getDefaults({ userId: 'x', email: 'x@y', role: 'support' }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('setDefault — superadmin writes, one row from motir-ai’s audit', () => {
  it('sets review: the PUT names the superadmin and sends the run-model list; one row', async () => {
    await delist('nothing-to-delist');
    const result = await service.setDefault(currentPrincipal!, 'review', OPUS, 'reviews on Opus');
    expect(result).toEqual({
      key: 'review',
      fromModel: null,
      toModel: OPUS,
      at: '2026-11-10T10:00:00.000Z',
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe('https://ai.example.test/v1/admin/run-model-defaults');
    expect(puts[0]?.body).toMatchObject({
      key: 'review',
      model: OPUS,
      actorCoreUserId: currentPrincipal!.userId,
    });
    expect([...(puts[0]?.body['allowedModels'] as string[])].sort()).toEqual([OPUS, SONNET, GLM]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetKind: 'platform',
      targetId: 'review',
      reason: 'reviews on Opus',
      actorUserId: currentPrincipal!.userId,
      actorRole: 'superadmin',
      metadata: { key: 'review', fromModel: null, toModel: OPUS },
    });
  });

  it('a list never initialised sends no allowedModels', async () => {
    await service.setDefault(currentPrincipal!, 'high', GLM, 'try GLM');
    expect(puts[0]?.body).not.toHaveProperty('allowedModels');
  });

  it('from → to comes from motir-ai’s audit, not the earlier read', async () => {
    putAnswer = {
      kind: 'body',
      body: {
        setting: { ...seededRow('low', GLM), updatedByCoreUserId: 'x' },
        audit: {
          action: 'ai.run_model_default.set',
          actorCoreUserId: 'x',
          at: '2026-11-10T11:00:00.000Z',
          key: 'low',
          before: { model: 'raced-in' },
          after: { model: GLM },
        },
      },
    };
    const result = await service.setDefault(currentPrincipal!, 'low', GLM, 'cheaper');
    expect(result.fromModel).toBe('raced-in');
    expect((await auditRows())[0]?.metadata).toEqual({
      key: 'low',
      fromModel: 'raced-in',
      toModel: GLM,
    });
  });

  it('clearing a level (null) is audited the same way', async () => {
    await service.setDefault(currentPrincipal!, 'medium', null, 'back to env');
    expect((await auditRows())[0]?.metadata).toEqual({
      key: 'medium',
      fromModel: OPUS,
      toModel: null,
    });
  });

  it('audit: null from motir-ai writes no row and answers unchanged', async () => {
    putAnswer = { kind: 'noop' };
    await expect(
      service.setDefault(currentPrincipal!, 'review', OPUS, 'race lost'),
    ).rejects.toBeInstanceOf(RunModelDefaultUnchangedError);
    expect(puts).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('the value already shown is unchanged before any write', async () => {
    await expect(service.setDefault(currentPrincipal!, 'trivial', SONNET, 'again')).rejects.toThrow(
      'The trivial default is already "claude-sonnet-5-5"',
    );
    await expect(service.setDefault(currentPrincipal!, 'review', null, 'again')).rejects.toThrow(
      'The review default already inherits',
    );
    expect(puts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it.each(['support', 'operator'] as const)(
    'a %s is refused before any remote call, and no row is written',
    async (role) => {
      currentPrincipal = await seedStaff(role);
      await expect(
        service.setDefault(currentPrincipal, 'review', OPUS, 'why'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('an unknown key, or a blank reason, is refused with no remote call', async () => {
    await expect(service.setDefault(currentPrincipal!, 'plan', OPUS, 'why')).rejects.toBeInstanceOf(
      RunModelDefaultKeyUnknownError,
    );
    await expect(service.setDefault(currentPrincipal!, 'review', OPUS, ' ')).rejects.toBeInstanceOf(
      MissingAuditReasonError,
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('a validation_error rolls back with no row', async () => {
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400 };
    await expect(
      service.setDefault(currentPrincipal!, 'review', 'not-listed', 'try'),
    ).rejects.toBeInstanceOf(RunModelDefaultNotOfferedError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('motir-ai applied but the audit row did not commit: logged as the residual case, and rethrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method === 'PUT') await new Promise((r) => setTimeout(r, 5_500));
        return fetchStub(url, init);
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(service.setDefault(currentPrincipal!, 'review', OPUS, 'try')).rejects.toThrow();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('but the audit row did not commit'),
      expect.any(String),
      expect.anything(),
    );
    expect(await auditRows()).toHaveLength(0);
  }, 20_000);
});

describe('setRunModelDefaultAction — each refusal reaches the page as its own code', () => {
  it('ok re-reads the page', async () => {
    expect(await setRunModelDefaultAction('review', OPUS, 'opus')).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/run-models');
    expect(await auditRows()).toHaveLength(1);
  });

  it('NOT_OFFERED re-reads the page; UNCHANGED from a no-op; UNAVAILABLE; FAILED — none leave a row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400 };
    expect(await setRunModelDefaultAction('review', OPUS, 'x')).toEqual({
      ok: false,
      code: 'NOT_OFFERED',
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/run-models');
    putAnswer = { kind: 'noop' };
    expect(await setRunModelDefaultAction('review', OPUS, 'x')).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
    putAnswer = { kind: 'store' };
    down = 'put';
    expect(await setRunModelDefaultAction('review', OPUS, 'x')).toEqual({
      ok: false,
      code: 'UNAVAILABLE',
    });
    down = 'none';
    putAnswer = { kind: 'problem', code: 'conflict', status: 409 };
    expect(await setRunModelDefaultAction('review', OPUS, 'x')).toEqual({
      ok: false,
      code: 'FAILED',
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('REASON_REQUIRED, NOT_PERMITTED and an unknown key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await setRunModelDefaultAction('review', OPUS, ' ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(await setRunModelDefaultAction('plan', OPUS, 'x')).toEqual({
      ok: false,
      code: 'FAILED',
    });
    currentPrincipal = await seedStaff('operator');
    expect(await setRunModelDefaultAction('review', OPUS, 'x')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await auditRows()).toHaveLength(0);
  });
});
