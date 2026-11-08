import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerReviewModelUnchangedError,
} from '@/lib/platform/errors';
import {
  MotirAiUnavailableError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import type { PlannerReviewModelRead } from '@/lib/ai/types';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The dry-run REVIEW model in the console (MOTIR-10632) — the seam, the action
 * and the boundary.
 *
 * Real Postgres for the audit trail: every refusal is checked against the ROW
 * COUNT, because a refused write must leave no row. motir-ai is stubbed at the
 * HTTP boundary; its own suites own validation and the probe.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The DEGREE is honoured, so a role refusal is the code's own gate.
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

const { setPlannerReviewModelAction } = await import('@/app/(admin)/admin/ai-planning/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+review-${role}-${seq++}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

/** What the stub serves as `review` on GET; `undefined` = an older motir-ai. */
let review: PlannerReviewModelRead | undefined;
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
      ...(review === undefined ? {} : { review }),
      offered: [
        { id: 'claude-opus-5-5', provider: 'anthropic' },
        { id: 'deepseek-v4-flash', provider: 'deepseek' },
      ],
    });
  }
  const body = JSON.parse(String(init.body)) as { model: string | null };
  puts.push({ url, body });
  if (putAnswer.kind === 'problem') {
    const { code, status, detail } = putAnswer;
    return json({ type: 'about:blank', title: code, status, code, detail }, status);
  }
  if (putAnswer.kind === 'ok' && putAnswer.body !== undefined) return json(putAnswer.body);
  return json({
    previousModel:
      putAnswer.kind === 'ok' && putAnswer.previousModel !== undefined
        ? putAnswer.previousModel
        : (review?.model ?? null),
    model: body.model,
    updatedAt: '2026-11-08T10:00:00.000Z',
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
  review = { model: null, offered: null, updatedAt: null, updatedByCoreUserId: null };
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

describe('getSettings carries the review row', () => {
  it('unset reads as "same as the planning model", seeded', async () => {
    const dto = await platformPlannerModelService.getSettings(currentPrincipal!);
    expect(dto.review).toEqual({
      model: null,
      offered: null,
      updatedAt: null,
      updatedBy: null,
      seeded: true,
    });
  });

  it.each(['support', 'operator'] as const)('a %s reads it too, without the picker', async (r) => {
    currentPrincipal = await seedStaff(r);
    review = {
      model: 'deepseek-v4-flash',
      offered: false,
      updatedAt: '2026-11-08T09:00:00.000Z',
      updatedByCoreUserId: currentPrincipal.userId,
    };
    const dto = await platformPlannerModelService.getSettings(currentPrincipal);
    expect(dto.canEdit).toBe(false);
    expect(dto.review).toEqual({
      model: 'deepseek-v4-flash',
      offered: false,
      updatedAt: '2026-11-08T09:00:00.000Z',
      updatedBy: `Ops ${r}`,
      seeded: false,
    });
  });

  it('an older motir-ai that serves no review gives no row, never a guessed one', async () => {
    review = undefined;
    const dto = await platformPlannerModelService.getSettings(currentPrincipal!);
    expect(dto.review).toBeNull();
    expect(dto.rows).toHaveLength(3);
  });
});

describe('setReviewModel — superadmin writes, and every write is audited', () => {
  it('sets a model: one PUT and exactly one row, from "same as planning" (null)', async () => {
    const result = await platformPlannerModelService.setReviewModel(
      currentPrincipal!,
      'deepseek-v4-flash',
      'review on the planning provider',
    );
    expect(result).toEqual({
      fromModel: null,
      toModel: 'deepseek-v4-flash',
      updatedAt: '2026-11-08T10:00:00.000Z',
    });
    expect(puts).toEqual([
      {
        url: 'https://ai.example.test/v1/planner-model-settings/review',
        body: { model: 'deepseek-v4-flash', actorCoreUserId: currentPrincipal!.userId },
      },
    ]);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ai.planner_review_model.set',
      targetKind: 'platform',
      targetId: 'review',
      reason: 'review on the planning provider',
      actorUserId: currentPrincipal!.userId,
      actorRole: 'superadmin',
      metadata: { fromModel: null, toModel: 'deepseek-v4-flash' },
    });
  });

  it('sets it back to "same as the planning model" (null), audited the same way', async () => {
    review = { ...review!, model: 'deepseek-v4-flash', offered: true };
    const result = await platformPlannerModelService.setReviewModel(
      currentPrincipal!,
      null,
      'follow planning again',
    );
    expect(result).toMatchObject({ fromModel: 'deepseek-v4-flash', toModel: null });
    expect(puts[0]?.body).toEqual({ model: null, actorCoreUserId: currentPrincipal!.userId });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ fromModel: 'deepseek-v4-flash', toModel: null });
  });

  it.each(['support', 'operator'] as const)(
    'a %s is refused before any remote call, and no row is written',
    async (role) => {
      currentPrincipal = await seedStaff(role);
      await expect(
        platformPlannerModelService.setReviewModel(currentPrincipal, 'deepseek-v4-flash', 'why'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('a blank reason is refused before the transaction, with no remote call and no row', async () => {
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'deepseek-v4-flash', '  '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('saving the value already stored is PlannerReviewModelUnchangedError — no write, no row', async () => {
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, null, 'again'),
    ).rejects.toBeInstanceOf(PlannerReviewModelUnchangedError);
    review = { ...review!, model: 'deepseek-v4-flash' };
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'deepseek-v4-flash', 'again'),
    ).rejects.toThrow('already runs on "deepseek-v4-flash"');
    expect(puts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('an older motir-ai with no review setting is unavailable — no write, no row', async () => {
    review = undefined;
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'deepseek-v4-flash', 'try'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(puts).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a validation_error is PlannerModelNotOfferedError, and the row rolls back', async () => {
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400, detail: 'not offered' };
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'glm-5.2', 'try GLM'),
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
      .setReviewModel(currentPrincipal!, 'glm-5.2', 'try GLM')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerModelUnreachableError);
    expect((err as PlannerModelUnreachableError).reason).toBe('the provider key was refused');
    expect(await auditRows()).toHaveLength(0);
  });

  it('another problem code is the typed §5 error, and the row rolls back', async () => {
    putAnswer = { kind: 'problem', code: 'internal_error', status: 500 };
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'glm-5.2', 'try'),
    ).rejects.toThrow();
    expect(await auditRows()).toHaveLength(0);
  });

  it('an answer that is not a review-model write is unavailable, and the row rolls back', async () => {
    putAnswer = { kind: 'ok', body: { previousModel: 7, model: 'glm-5.2' } };
    await expect(
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'glm-5.2', 'try'),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('a concurrent write between read and save warns with both values and still succeeds', async () => {
    putAnswer = { kind: 'ok', previousModel: 'claude-opus-5-5' };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await platformPlannerModelService.setReviewModel(
      currentPrincipal!,
      'deepseek-v4-flash',
      'race',
    );
    expect(result.fromModel).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('concurrent write on the review'));
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
      platformPlannerModelService.setReviewModel(currentPrincipal!, 'glm-5.2', 'try GLM'),
    ).rejects.toThrow();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('but the audit row did not commit'),
      expect.anything(),
    );
    expect(await auditRows()).toHaveLength(0);
  }, 20_000);
});

describe('setPlannerReviewModelAction — each refusal reaches the page as its own code', () => {
  it('ok re-reads the page', async () => {
    expect(await setPlannerReviewModelAction('deepseek-v4-flash', 'cheaper')).toEqual({ ok: true });
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
    expect(await setPlannerReviewModelAction('deepseek-v4-flash', 'try')).toEqual({
      ok: false,
      ...expected,
    });
    expect(await auditRows()).toHaveLength(0);
  });

  it('UNCHANGED and REASON_REQUIRED', async () => {
    expect(await setPlannerReviewModelAction(null, 'again')).toEqual({
      ok: false,
      code: 'UNCHANGED',
    });
    expect(await setPlannerReviewModelAction('deepseek-v4-flash', ' ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
  });
});

describe('a tenant can neither read nor write the review model', () => {
  it('a signed-in tenant user (not platform staff) is refused the read and the write', async () => {
    // An org owner with no platform role: the gate refuses before motir-ai is asked.
    await createTestUser({ email: 'owner@tenant.example' });
    currentPrincipal = null;
    await expect(
      platformPlannerModelService.getSettings({
        userId: 'tenant-user',
        email: 'owner@tenant.example',
        role: 'support',
      }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await expect(
      platformPlannerModelService.setReviewModel(
        { userId: 'tenant-user', email: 'owner@tenant.example', role: 'superadmin' },
        'deepseek-v4-flash',
        'mine now',
      ),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await setPlannerReviewModelAction('deepseek-v4-flash', 'mine now')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('no /api/v1 route, MCP tool or tenant page reaches the review-model client or its route', () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name)) files.push(p);
      }
    };
    // Every page and route outside the platform console, and every MCP tool.
    for (const name of readdirSync(join(root, 'app'))) {
      const p = join(root, 'app', name);
      if (name !== '(admin)' && statSync(p).isDirectory()) walk(p);
    }
    walk(join(root, 'lib/mcp'));
    expect(files.some((f) => f.includes('/app/api/v1/'))).toBe(true);
    const reaching = files.filter((f) =>
      /setPlannerReviewModel|planner-model-settings|getPlannerModelSettings|platformPlannerModelService/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(reaching).toEqual([]);
  });
});
