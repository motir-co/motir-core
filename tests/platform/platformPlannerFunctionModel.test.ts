import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerFunctionModelUnchangedError,
  PlannerFunctionUnknownError,
} from '@/lib/platform/errors';
import {
  MotirAiUnavailableError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import { getPlannerModelSettings } from '@/lib/ai/motirAiClient';
import type { PlannerFunctionDefaultRead } from '@/lib/ai/types';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * Guide, Debug and Ask platform defaults in the console (Story MOTIR-10838 ·
 * MOTIR-10844) — the client, the seam and the action.
 *
 * Real Postgres for the audit trail: every refusal is checked against the ROW
 * COUNT, because a refused write must leave no row. motir-ai is stubbed at the
 * HTTP boundary (`GET /v1/planner-model-settings` with its `functions` field, and
 * `PUT /v1/planner-model-settings/functions`).
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

const { setPlannerFunctionModelAction } = await import('@/app/(admin)/admin/ai-planning/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+fn-${role}-${seq++}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

const unset = (fn: PlannerFunctionDefaultRead['function']): PlannerFunctionDefaultRead => ({
  function: fn,
  model: null,
  offered: null,
  updatedAt: null,
  updatedByCoreUserId: null,
});

/** What the stub serves as `functions`; `undefined` = an older motir-ai. */
let functions: unknown;
let putAnswer:
  | { kind: 'ok'; previousModel?: string | null; body?: unknown }
  | { kind: 'problem'; code: string; status: number; detail?: string }
  | { kind: 'down' } = { kind: 'ok' };
let puts: { url: string; body: unknown }[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const storedModel = (fn: string) =>
  (Array.isArray(functions)
    ? (functions as PlannerFunctionDefaultRead[]).find((f) => f.function === fn)?.model
    : null) ?? null;

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  if (putAnswer.kind === 'down' && init.method !== 'GET') throw new TypeError('fetch failed');
  if (init.method === 'GET') {
    return json({
      settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
        audience,
        model: 'claude-opus-5-5',
        offered: true,
        updatedAt: '2026-10-02T09:00:00.000Z',
        updatedByCoreUserId: null,
        reachable: true,
        lastProbeAt: null,
        lastProbeError: null,
      })),
      ...(functions === undefined ? {} : { functions }),
      offered: [
        { id: 'claude-opus-5-5', provider: 'anthropic' },
        { id: 'deepseek-v4-flash', provider: 'deepseek' },
      ],
    });
  }
  const body = JSON.parse(String(init.body)) as { function: string; model: string | null };
  puts.push({ url, body });
  if (putAnswer.kind === 'problem') {
    const { code, status, detail } = putAnswer;
    return json({ type: 'about:blank', title: code, status, code, detail }, status);
  }
  if (putAnswer.kind === 'ok' && putAnswer.body !== undefined) return json(putAnswer.body);
  return json({
    function: body.function,
    previousModel:
      putAnswer.kind === 'ok' && putAnswer.previousModel !== undefined
        ? putAnswer.previousModel
        : storedModel(body.function),
    model: body.model,
    updatedAt: '2026-11-10T10:00:00.000Z',
  });
});

const auditRows = () => adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  vi.mocked(revalidatePath).mockClear();
  puts = [];
  putAnswer = { kind: 'ok' };
  functions = [unset('guide'), unset('debug'), unset('ask')];
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the client reads `functions` additively', () => {
  it('an older motir-ai with no `functions` field parses, and the page has no function rows', async () => {
    functions = undefined;
    const read = await getPlannerModelSettings();
    expect(read.functions).toBeUndefined();
    const dto = await platformPlannerModelService.getSettings(currentPrincipal!);
    expect(dto.functions).toEqual([]);
    expect(dto.rows).toHaveLength(3);
  });

  it.each([
    ['not a list', { guide: null }],
    ['a null entry', [null]],
    ['an unknown function', [{ ...unset('guide'), function: 'plan' }]],
    ['a numeric model', [{ ...unset('guide'), model: 7 }]],
    ['a string offered', [{ ...unset('guide'), offered: 'yes' }]],
    ['a missing updatedAt', [{ function: 'guide', model: null, offered: null }]],
  ])('a `functions` that is %s is an answer we cannot draw: unavailable', async (_, bad) => {
    functions = bad;
    await expect(getPlannerModelSettings()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('getSettings carries the Guide, Debug and Ask rows', () => {
  it('in guide, debug, ask order, unset as seeded, a set one naming its changer', async () => {
    const changer = await seedStaff('superadmin');
    functions = [
      unset('ask'),
      {
        function: 'debug',
        model: 'deepseek-v4-flash',
        offered: false,
        updatedAt: '2026-11-09T09:00:00.000Z',
        updatedByCoreUserId: changer.userId,
      },
      unset('guide'),
    ];
    const dto = await platformPlannerModelService.getSettings(currentPrincipal!);
    expect(dto.functions.map((f) => f.function)).toEqual(['guide', 'debug', 'ask']);
    expect(dto.functions[0]).toEqual({
      function: 'guide',
      model: null,
      offered: null,
      updatedAt: null,
      updatedBy: null,
      seeded: true,
    });
    expect(dto.functions[1]).toEqual({
      function: 'debug',
      model: 'deepseek-v4-flash',
      offered: false,
      updatedAt: '2026-11-09T09:00:00.000Z',
      updatedBy: 'Ops superadmin',
      seeded: false,
    });
  });

  it('a function motir-ai did not answer is left out, never invented', async () => {
    functions = [unset('guide')];
    const dto = await platformPlannerModelService.getSettings(currentPrincipal!);
    expect(dto.functions.map((f) => f.function)).toEqual(['guide']);
  });
});

describe('setFunctionModel — superadmin writes, and every write is audited', () => {
  it('sets Debug: one PUT naming the superadmin and exactly one row, from inherits (null)', async () => {
    const result = await platformPlannerModelService.setFunctionModel(
      currentPrincipal!,
      'debug',
      'deepseek-v4-flash',
      'cheaper diagnoses',
    );
    expect(result).toEqual({
      function: 'debug',
      fromModel: null,
      toModel: 'deepseek-v4-flash',
      updatedAt: '2026-11-10T10:00:00.000Z',
    });
    expect(puts).toEqual([
      {
        url: 'https://ai.example.test/v1/planner-model-settings/functions',
        body: {
          function: 'debug',
          model: 'deepseek-v4-flash',
          actorCoreUserId: currentPrincipal!.userId,
        },
      },
    ]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ai.planner_function_model.set',
      targetKind: 'platform',
      targetId: 'debug',
      reason: 'cheaper diagnoses',
      actorUserId: currentPrincipal!.userId,
      actorRole: 'superadmin',
      metadata: { function: 'debug', fromModel: null, toModel: 'deepseek-v4-flash' },
    });
  });

  it('clears a stored model back to inherits (null), audited the same way', async () => {
    functions = [
      unset('guide'),
      unset('debug'),
      { ...unset('ask'), model: 'deepseek-v4-flash', offered: true },
    ];
    const result = await platformPlannerModelService.setFunctionModel(
      currentPrincipal!,
      'ask',
      null,
      'follow planning again',
    );
    expect(result).toMatchObject({ fromModel: 'deepseek-v4-flash', toModel: null });
    expect((await auditRows())[0]?.metadata).toEqual({
      function: 'ask',
      fromModel: 'deepseek-v4-flash',
      toModel: null,
    });
  });

  it.each(['support', 'operator'] as const)(
    'a %s is refused before any remote call, and no row is written',
    async (role) => {
      currentPrincipal = await seedStaff(role);
      await expect(
        platformPlannerModelService.setFunctionModel(currentPrincipal, 'guide', 'x', 'why'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('an unknown function, or a blank reason, is refused with no remote call and no row', async () => {
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'plan', 'x', 'why'),
    ).rejects.toBeInstanceOf(PlannerFunctionUnknownError);
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'guide', 'x', '  '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('saving the value already stored is unchanged — no write, no row', async () => {
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'guide', null, 'again'),
    ).rejects.toBeInstanceOf(PlannerFunctionModelUnchangedError);
    functions = [{ ...unset('guide'), model: 'deepseek-v4-flash' }];
    await expect(
      platformPlannerModelService.setFunctionModel(
        currentPrincipal!,
        'guide',
        'deepseek-v4-flash',
        'again',
      ),
    ).rejects.toThrow('guide already runs on "deepseek-v4-flash"');
    expect(puts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('an older motir-ai with no function rows is unavailable — no write, no row', async () => {
    functions = undefined;
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'guide', 'x', 'try'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(puts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a validation_error is not offered, and the row rolls back', async () => {
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400, detail: 'not offered' };
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'debug', 'glm-5.2', 'try'),
    ).rejects.toBeInstanceOf(PlannerModelNotOfferedError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a model_unreachable carries the probe reason, and the row rolls back', async () => {
    putAnswer = {
      kind: 'problem',
      code: 'model_unreachable',
      status: 422,
      detail: 'model "glm-5.2" is not reachable for the planner: the provider key was refused',
    };
    const err = await platformPlannerModelService
      .setFunctionModel(currentPrincipal!, 'debug', 'glm-5.2', 'try')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelUnreachableError);
    expect((err as PlannerModelUnreachableError).reason).toBe('the provider key was refused');
    expect(await auditRows()).toHaveLength(0);
  });

  it('another problem code is the typed error, and the row rolls back', async () => {
    putAnswer = { kind: 'problem', code: 'internal_error', status: 500 };
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'debug', 'glm-5.2', 'try'),
    ).rejects.toThrow();
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([
    [
      'a numeric previousModel',
      { function: 'debug', previousModel: 7, model: 'x', updatedAt: 'n' },
    ],
    ['another function', { function: 'ask', previousModel: null, model: 'x', updatedAt: 'n' }],
    ['no updatedAt', { function: 'debug', previousModel: null, model: 'x' }],
    ['a numeric model', { function: 'debug', previousModel: null, model: 3, updatedAt: 'n' }],
  ])('an answer with %s is unavailable, and the row rolls back', async (_, body) => {
    putAnswer = { kind: 'ok', body };
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'debug', 'x', 'try'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a concurrent write between read and save warns with both values and still succeeds', async () => {
    putAnswer = { kind: 'ok', previousModel: 'claude-opus-5-5' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await platformPlannerModelService.setFunctionModel(
      currentPrincipal!,
      'guide',
      'deepseek-v4-flash',
      'race',
    );
    expect(result.fromModel).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('concurrent write on the guide'));
    expect(await auditRows()).toHaveLength(1);
  });

  it('motir-ai applied but the audit row did not commit: logged as the residual case, and rethrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (init.method !== 'GET') await new Promise((r) => setTimeout(r, 5_500));
        return fetchStub(url, init);
      }),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      platformPlannerModelService.setFunctionModel(currentPrincipal!, 'guide', 'glm-5.2', 'try'),
    ).rejects.toThrow();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('but the audit row did not commit'),
      expect.anything(),
    );
    expect(await auditRows()).toHaveLength(0);
  }, 20_000);
});

describe('setPlannerFunctionModelAction — each refusal reaches the page as its own code', () => {
  it('ok re-reads the page', async () => {
    expect(await setPlannerFunctionModelAction('debug', 'deepseek-v4-flash', 'cheaper')).toEqual({
      ok: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/ai-planning');
    expect(await auditRows()).toHaveLength(1);
  });

  it.each([
    [{ kind: 'problem', code: 'validation_error', status: 400 } as const, { code: 'NOT_OFFERED' }],
    [
      {
        kind: 'problem',
        code: 'model_unreachable',
        status: 422,
        detail: 'model "x" is not reachable for the planner: timed out',
      } as const,
      { code: 'UNREACHABLE', reason: 'timed out' },
    ],
    [{ kind: 'down' } as const, { code: 'UNAVAILABLE' }],
    [{ kind: 'problem', code: 'conflict', status: 409 } as const, { code: 'FAILED' }],
  ])('%o → %o, with no row', async (answer, expected) => {
    putAnswer = answer;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await setPlannerFunctionModelAction('debug', 'deepseek-v4-flash', 'try')).toEqual({
      ok: false,
      ...expected,
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNCHANGED, REASON_REQUIRED, NOT_PERMITTED and an unknown function', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await setPlannerFunctionModelAction('guide', null, 'again')).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
    expect(await setPlannerFunctionModelAction('guide', 'x', ' ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(await setPlannerFunctionModelAction('plan', 'x', 'why')).toEqual({
      ok: false,
      code: 'FAILED',
    });
    currentPrincipal = await seedStaff('operator');
    expect(await setPlannerFunctionModelAction('guide', 'x', 'why')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await auditRows()).toHaveLength(0);
  });
});
