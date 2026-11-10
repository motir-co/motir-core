import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { hostedRunModelService } from '@/lib/services/hostedRunModelService';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';
import { platformRunModelService } from '@/lib/services/platformRunModelService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

/**
 * STORY GATE — Story MOTIR-7521 (Subtask MOTIR-7529).
 *
 * Platform admins curate which models Motir may plan with (motir-ai's planning
 * list) and run with (motir-core's run-model list), and a hosted run offers only
 * listed models. The units each mock a neighbour; this file assembles the seams
 * against the real Postgres, with motir-ai stubbed at the HTTP boundary:
 *
 *   1. run list → `hostedRunModelService` → the project settings save and the
 *      start path's `assertOffered`;
 *   2. the first read's lazy initialisation, which changes no offer;
 *   3. the in-use refusal, naming the project and its level;
 *   4. every list write's gate and audit row, both lists, through the actions;
 *   5. motir-ai down reads `unavailable` everywhere, never an empty list.
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
const { addPlannerListModelAction, removePlannerListModelAction } =
  await import('@/app/(admin)/admin/ai-planning/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `ops+lists-gate-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

// ── motir-ai, stubbed at the HTTP boundary ──────────────────────────────────

const OFFER = [
  { id: 'claude-opus-5-5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic' },
  { id: 'glm-5.2', provider: 'z-ai' },
];
let motirAiDown = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
  if (motirAiDown) throw new TypeError('fetch failed');
  if (url.endsWith('/v1/agent-models')) {
    return json({
      models: OFFER,
      default: 'claude-opus-5-5',
      defaultsByDifficulty: {
        trivial: 'claude-sonnet-5-5',
        low: 'claude-sonnet-5-5',
        medium: 'claude-opus-5-5',
        high: 'claude-opus-5-5',
      },
    });
  }
  // The run-side defaults a remove checks before it takes a model away (MOTIR-10844):
  // the levels as the offer serves them, review and design unset.
  if (url.endsWith('/v1/admin/run-model-defaults')) {
    const row = (key: string, model: string | null) => ({
      key,
      model,
      offered: model === null ? null : true,
      effectiveModel: model,
      updatedAt: '1970-01-01T00:00:00.000Z',
      updatedByCoreUserId: null,
    });
    return json({
      settings: [
        row('trivial', 'claude-sonnet-5-5'),
        row('low', 'claude-sonnet-5-5'),
        row('medium', 'claude-opus-5-5'),
        row('high', 'claude-opus-5-5'),
        row('review', null),
        row('design', null),
      ],
      models: OFFER,
    });
  }
  if (url.endsWith('/v1/planner-model-settings')) return json({ settings: [], offered: [] });
  if (url.endsWith('/v1/planner-model-list') && init?.method === 'PUT') {
    return json({ entries: [] });
  }
  return json({ entries: [] });
});

const auditRows = () => adminDb.platformAuditLog.findMany();
const truncateLists = () =>
  adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
const truncateAudit = () =>
  adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  motirAiDown = false;
  await truncateLists();
  await truncateAudit();
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await truncateLists();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ids = (models: { id: string }[]) => models.map((m) => m.id).sort();

describe('first read initialises the run list, and changes no offer', () => {
  it('offers motir-ai’s whole offer before and after the list is initialised', async () => {
    const before = await hostedRunModelService.listOfferedModels();
    expect(before.state === 'ok' && ids(before.models)).toEqual(ids(OFFER));
    expect(await adminDb.platformRunModelList.count()).toBe(0);

    await platformRunModelService.listModels(currentPrincipal!);
    expect((await adminDb.platformRunModel.findMany()).map((r) => r.model).sort()).toEqual(
      ids(OFFER),
    );

    const after = await hostedRunModelService.listOfferedModels();
    expect(after).toEqual(before);
  });
});

describe('run list → offer → settings save and start path', () => {
  it('a model removed through the action is refused by the settings save and by assertOffered', async () => {
    const fx = await makeWorkItemFixture();
    await platformRunModelService.listModels(currentPrincipal!);
    await truncateAudit();

    // Listed and offered: both doors accept it.
    await expect(hostedRunModelService.assertOffered('glm-5.2')).resolves.toMatchObject({
      id: 'glm-5.2',
    });

    expect(await removeRunModelAction('glm-5.2', 'retire GLM')).toEqual({ ok: true });
    expect(await auditRows()).toHaveLength(1);

    await expect(
      projectHostedAgentSettingsService.update(
        fx.projectIdentifier,
        { low: 'glm-5.2' },
        { userId: fx.ownerId, workspaceId: fx.workspaceId },
      ),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    await expect(hostedRunModelService.assertOffered('glm-5.2')).rejects.toBeInstanceOf(
      HostedModelNotOfferedError,
    );
    const offered = await hostedRunModelService.listOfferedModels();
    expect(offered.state === 'ok' && ids(offered.models)).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('a project override naming a model blocks its removal, naming the project and level', async () => {
    const fx = await makeWorkItemFixture();
    await platformRunModelService.listModels(currentPrincipal!);
    await projectHostedAgentSettingsService.update(
      fx.projectIdentifier,
      { high: 'glm-5.2' },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );
    await truncateAudit();

    const result = await removeRunModelAction('glm-5.2', 'retire GLM');
    expect(result).toMatchObject({
      ok: false,
      code: 'IN_USE',
      platformLevels: [],
      projects: [{ projectKey: fx.projectIdentifier, levels: ['high'] }],
    });
    expect(await auditRows()).toHaveLength(0);
    expect(await adminDb.platformRunModel.count({ where: { model: 'glm-5.2' } })).toBe(1);
  });
});

describe('every list write is gated and audited, both lists', () => {
  const writes = [
    ['run add', () => addRunModelAction('kimi-k2.6', 'r')],
    ['run remove', () => removeRunModelAction('glm-5.2', 'r')],
    ['planning add', () => addPlannerListModelAction('kimi-k2.6', 'r')],
    ['planning remove', () => removePlannerListModelAction('glm-5.2', 'r')],
  ] as const;

  it.each(writes)('%s by an operator is NOT_PERMITTED and writes nothing', async (_, write) => {
    await platformRunModelService.listModels(currentPrincipal!);
    await truncateAudit();
    currentPrincipal = await seedStaff('operator');
    fetchStub.mockClear();
    expect(await write()).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it.each([
    ['run add', () => addRunModelAction('kimi-k2.6', ' ')],
    ['run remove', () => removeRunModelAction('glm-5.2', '')],
    ['planning add', () => addPlannerListModelAction('kimi-k2.6', ' ')],
    ['planning remove', () => removePlannerListModelAction('glm-5.2', '')],
  ] as const)('%s by a superadmin with no reason is REASON_REQUIRED', async (_, write) => {
    await platformRunModelService.listModels(currentPrincipal!);
    await truncateAudit();
    expect(await write()).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(await auditRows()).toHaveLength(0);
  });

  it('each successful write leaves exactly one audit row', async () => {
    await platformRunModelService.listModels(currentPrincipal!);
    // A model motir-ai offers that the list does not hold yet.
    await adminDb.platformRunModel.delete({ where: { model: 'claude-sonnet-5-5' } });
    await truncateAudit();

    const steps: [string, () => Promise<{ ok: boolean }>][] = [
      ['ai.run_model_list.add', () => addRunModelAction('claude-sonnet-5-5', 'r1')],
      ['ai.run_model_list.remove', () => removeRunModelAction('glm-5.2', 'r2')],
      ['ai.planner_model_list.add', () => addPlannerListModelAction('kimi-k2.6', 'r3')],
      ['ai.planner_model_list.remove', () => removePlannerListModelAction('kimi-k2.6', 'r4')],
    ];
    for (const [, step] of steps) {
      const before = (await auditRows()).length;
      expect(await step()).toEqual({ ok: true });
      expect((await auditRows()).length).toBe(before + 1);
    }
    const rows = (await adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } })).map((r) => [
      r.action,
      r.reason,
    ]);
    expect(rows).toEqual(steps.map(([action], i) => [action, `r${i + 1}`]));
  });
});

describe('motir-ai down: unavailable, never empty', () => {
  it('both lists and the offer read unavailable, and the run list stays uninitialised', async () => {
    motirAiDown = true;
    await expect(platformRunModelService.listModels(currentPrincipal!)).rejects.toBeInstanceOf(
      HostedModelsUnavailableError,
    );
    await expect(platformPlannerModelService.listModels(currentPrincipal!)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    expect(await hostedRunModelService.listOfferedModels()).toEqual({ state: 'unavailable' });
    await expect(hostedRunModelService.assertOffered('glm-5.2')).rejects.toBeInstanceOf(
      HostedModelsUnavailableError,
    );
    expect(await adminDb.platformRunModelList.count()).toBe(0);
    expect(await adminDb.platformRunModel.count()).toBe(0);
  });
});
