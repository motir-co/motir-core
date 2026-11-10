import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  RunModelAlreadyListedError,
  RunModelInUseError,
  RunModelNotListedError,
  RunModelNotOfferedError,
} from '@/lib/platform/errors';
import { HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { platformRunModelRepository } from '@/lib/repositories/platformRunModelRepository';
import { platformRunModelService } from '@/lib/services/platformRunModelService';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The platform HOSTED-RUN MODEL LIST (Story MOTIR-7521 · MOTIR-7525).
 *
 * Real Postgres throughout: the once-only seed is a read-derived write whose
 * concurrency is a criterion, and every refusal is checked against the audit
 * ROW COUNT, because the way to break "a refused write leaves no row" is to
 * throw outside the transaction. motir-ai's `/v1/agent-models` is stubbed at
 * the HTTP boundary.
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The DEGREE is honoured, so a role refusal below is the service's own.
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

let currentPrincipal: PlatformPrincipal | null = null;

async function seedStaff(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({
    email: `ops+run-models-${role}@moooon.net`,
    name: `Ops ${role}`,
  });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

type Level = 'trivial' | 'low' | 'medium' | 'high';
let offered: { id: string; provider: string }[] = [];
let defaults: Record<Level, string | null> = { trivial: null, low: null, medium: null, high: null };
let motirAiDown = false;

/** The run-side review-agent and design-run defaults (MOTIR-10844) the stub stores. */
let roleDefaults: { review: string | null; design: string | null } = { review: null, design: null };
let runDefaultsDown = false;

const fetchStub = vi.fn(async (url: string) => {
  if (motirAiDown) throw new TypeError('fetch failed');
  if (url.endsWith('/v1/admin/run-model-defaults')) {
    if (runDefaultsDown) throw new TypeError('fetch failed');
    const row = (key: string, model: string | null) => ({
      key,
      model,
      offered: model === null ? null : true,
      effectiveModel: model,
      updatedAt: '1970-01-01T00:00:00.000Z',
      updatedByCoreUserId: null,
    });
    return new Response(
      JSON.stringify({
        settings: [
          ...(['trivial', 'low', 'medium', 'high'] as const).map((l) => row(l, defaults[l])),
          row('review', roleDefaults.review),
          row('design', roleDefaults.design),
        ],
        models: offered,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({ models: offered, default: null, defaultsByDifficulty: defaults }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});

async function auditRows(action?: string) {
  return adminDb.platformAuditLog.findMany({
    where: action ? { action } : {},
    orderBy: { seq: 'asc' },
  });
}

async function listed() {
  return (await adminDb.platformRunModel.findMany({ orderBy: { model: 'asc' } })).map(
    (r) => r.model,
  );
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  motirAiDown = false;
  roleDefaults = { review: null, design: null };
  runDefaultsDown = false;
  offered = [
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', provider: 'anthropic' },
    { id: 'glm-5.2', provider: 'z-ai' },
  ];
  defaults = {
    trivial: 'claude-sonnet-5-5',
    low: 'claude-sonnet-5-5',
    medium: 'claude-opus-5-5',
    high: 'claude-opus-5-5',
  };
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  // An initialised list narrows every hosted-run offer (MOTIR-7526), so it is
  // not left behind for a later file that never asked for one.
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the first read seeds the list from motir-ai, exactly once', () => {
  it('writes the offer as the list with one seed row; a second read writes nothing', async () => {
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    expect(dto.entries.map((e) => e.model).sort()).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'glm-5.2',
    ]);
    expect(dto.entries.every((e) => e.seeded && e.addedBy === null && e.offered)).toBe(true);
    expect(dto.addable).toEqual([]);
    const seeds = await auditRows('ai.run_model_list.seed');
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.metadata).toEqual({
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'glm-5.2'],
    });

    offered = [...offered, { id: 'qwen-4', provider: 'qwen' }];
    const again = await platformRunModelService.listModels(currentPrincipal!);
    expect(again.entries).toHaveLength(3);
    expect(again.addable).toEqual([{ id: 'qwen-4', provider: 'qwen' }]);
    expect(await auditRows('ai.run_model_list.seed')).toHaveLength(1);
    expect(await listed()).toHaveLength(3);
  });

  it('two concurrent first reads produce one list, no duplicate, no error and one seed row', async () => {
    const [a, b] = await Promise.all([
      platformRunModelService.listModels(currentPrincipal!),
      platformRunModelService.listModels(currentPrincipal!),
    ]);
    expect(a.entries).toHaveLength(3);
    expect(b.entries).toHaveLength(3);
    expect(await listed()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'glm-5.2']);
    expect(await auditRows('ai.run_model_list.seed')).toHaveLength(1);
    expect(await adminDb.platformRunModelList.count()).toBe(1);
  });

  // The concurrent case above reaches the losing seed only when the scheduler
  // interleaves the two reads that way; these two pin both of its exits.
  it('a seed that finds the list already seeded rolls back with no row and reads the list', async () => {
    await platformRunModelService.listModels(currentPrincipal!);
    // As a concurrent first read sees it: not yet initialised, then seeded by the time it seeds.
    vi.spyOn(platformRunModelRepository, 'isInitialized').mockResolvedValueOnce(false);
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    expect(dto.entries).toHaveLength(3);
    expect(await auditRows('ai.run_model_list.seed')).toHaveLength(1);
    expect(await adminDb.platformRunModelList.count()).toBe(1);
  });

  it('a seed that fails for any other reason propagates and initialises nothing', async () => {
    vi.spyOn(platformRunModelRepository, 'createSeeded').mockRejectedValueOnce(
      new RangeError('boom'),
    );
    await expect(platformRunModelService.listModels(currentPrincipal!)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(await adminDb.platformRunModelList.count()).toBe(0);
    expect(await auditRows('ai.run_model_list.seed')).toHaveLength(0);
  });

  it('motir-ai down on the first read raises and leaves the list UNINITIALISED, not empty', async () => {
    motirAiDown = true;
    await expect(platformRunModelService.listModels(currentPrincipal!)).rejects.toBeInstanceOf(
      HostedModelsUnavailableError,
    );
    expect(await adminDb.platformRunModelList.count()).toBe(0);
    expect(await auditRows()).toHaveLength(0);

    motirAiDown = false;
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    expect(dto.entries).toHaveLength(3);
  });

  it('an emptied list stays empty: the marker, not the rows, says it was initialised', async () => {
    defaults = { trivial: null, low: null, medium: null, high: null };
    await platformRunModelService.listModels(currentPrincipal!);
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'glm-5.2']) {
      await platformRunModelService.removeModel(currentPrincipal!, m, 'empty it');
    }
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    expect(dto.entries).toEqual([]);
    expect(dto.addable).toHaveLength(3);
  });
});

describe('listModels — any staff role reads, and each entry says what uses it', () => {
  it.each([
    ['support', false],
    ['operator', false],
    ['superadmin', true],
  ] as const)('a %s reads the list; canEdit=%s', async (role, canEdit) => {
    if (role !== 'superadmin') currentPrincipal = await seedStaff(role);
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    expect(dto.canEdit).toBe(canEdit);
    expect(dto.entries).toHaveLength(3);
  });

  it('a non-staff caller is refused before motir-ai is asked', async () => {
    const tenant = await createTestUser({ email: 'tenant@example.com' });
    currentPrincipal = null;
    await expect(
      platformRunModelService.listModels({
        userId: tenant.id,
        email: tenant.email,
        role: 'support',
      }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('names the platform-default levels and every live project override', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const p = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await adminDb.project.update({
      where: { id: p.id },
      data: { hostedModelLow: 'glm-5.2', hostedModelHigh: 'glm-5.2' },
    });
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    const byModel = new Map(dto.entries.map((e) => [e.model, e]));
    expect(byModel.get('glm-5.2')).toMatchObject({
      platformDefaultLevels: [],
      projects: [{ projectKey: 'PROD', projectName: 'Motir', levels: ['low', 'high'] }],
    });
    expect(byModel.get('claude-sonnet-5-5')?.platformDefaultLevels).toEqual(['trivial', 'low']);
  });

  it('a listed model motir-ai stopped offering reads as not offered', async () => {
    await platformRunModelService.listModels(currentPrincipal!);
    offered = offered.filter((m) => m.id !== 'glm-5.2');
    const dto = await platformRunModelService.listModels(currentPrincipal!);
    expect(dto.entries.find((e) => e.model === 'glm-5.2')).toMatchObject({
      offered: false,
      provider: null,
    });
  });
});

describe('addModel — superadmin, reason, offered, one audit row', () => {
  beforeEach(async () => {
    await platformRunModelService.listModels(currentPrincipal!);
    offered = [...offered, { id: 'qwen-4', provider: 'qwen' }];
  });

  it('adds an offered model with one row naming the action, model and reason', async () => {
    const before = (await auditRows()).length;
    const dto = await platformRunModelService.addModel(currentPrincipal!, ' qwen-4 ', 'cheap');
    expect(dto.entries.at(-1)).toMatchObject({
      model: 'qwen-4',
      seeded: false,
      addedBy: 'Ops superadmin',
      provider: 'qwen',
    });
    const rows = await auditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'ai.run_model_list.add',
      targetKind: 'platform',
      targetId: 'qwen-4',
      reason: 'cheap',
      actorUserId: currentPrincipal!.userId,
      metadata: { action: 'add', model: 'qwen-4' },
    });
  });

  it('refuses a model motir-ai does not offer, with no row', async () => {
    const before = (await auditRows()).length;
    await expect(
      platformRunModelService.addModel(currentPrincipal!, 'gpt-9', 'try it'),
    ).rejects.toBeInstanceOf(RunModelNotOfferedError);
    expect(await auditRows()).toHaveLength(before);
  });

  it('refuses a model already listed, with no row', async () => {
    const before = (await auditRows()).length;
    await expect(
      platformRunModelService.addModel(currentPrincipal!, 'glm-5.2', 'again'),
    ).rejects.toBeInstanceOf(RunModelAlreadyListedError);
    expect(await auditRows()).toHaveLength(before);
  });

  it('seeds first when the add is the very first write — the seed already lists every offered model', async () => {
    await adminDb.$transaction([
      adminDb.platformRunModel.deleteMany(),
      adminDb.platformRunModelList.deleteMany(),
    ]);
    await expect(
      platformRunModelService.addModel(currentPrincipal!, 'qwen-4', 'cheap'),
    ).rejects.toBeInstanceOf(RunModelAlreadyListedError);
    expect(await listed()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'glm-5.2', 'qwen-4']);
  });
});

describe('removeModel — refused while anything uses the model', () => {
  beforeEach(async () => {
    await platformRunModelService.listModels(currentPrincipal!);
  });

  it('removes an unused model with one row', async () => {
    const before = (await auditRows()).length;
    const dto = await platformRunModelService.removeModel(currentPrincipal!, 'glm-5.2', 'unused');
    expect(dto.entries.map((e) => e.model)).not.toContain('glm-5.2');
    expect(dto.addable).toEqual([{ id: 'glm-5.2', provider: 'z-ai' }]);
    const rows = await auditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      action: 'ai.run_model_list.remove',
      targetId: 'glm-5.2',
      metadata: { action: 'remove', model: 'glm-5.2' },
    });
  });

  it('refuses a model a project override names, listing project keys and levels', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const p = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await adminDb.project.update({ where: { id: p.id }, data: { hostedModelMedium: 'glm-5.2' } });
    const before = (await auditRows()).length;
    const err = await platformRunModelService
      .removeModel(currentPrincipal!, 'glm-5.2', 'retire')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunModelInUseError);
    expect(err).toMatchObject({
      platformLevels: [],
      projects: [{ projectKey: 'PROD', levels: ['medium'] }],
    });
    expect(await auditRows()).toHaveLength(before);
    expect(await listed()).toContain('glm-5.2');
  });

  it('an archived project does not hold a model', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const p = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    await adminDb.project.update({
      where: { id: p.id },
      data: { hostedModelMedium: 'glm-5.2', archivedAt: new Date() },
    });
    await expect(
      platformRunModelService.removeModel(currentPrincipal!, 'glm-5.2', 'retire'),
    ).resolves.toBeTruthy();
  });

  it("refuses a model motir-ai's platform default names, listing the levels", async () => {
    const err = await platformRunModelService
      .removeModel(currentPrincipal!, 'claude-opus-5-5', 'retire')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunModelInUseError);
    expect(err).toMatchObject({ platformLevels: ['medium', 'high'], projects: [] });
  });

  it('refuses a model the platform review-agent or design-run default stores, naming each', async () => {
    roleDefaults = { review: 'glm-5.2', design: 'glm-5.2' };
    const before = (await auditRows()).length;
    const err = await platformRunModelService
      .removeModel(currentPrincipal!, 'glm-5.2', 'retire')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunModelInUseError);
    expect(err).toMatchObject({ platformLevels: [], platformRoles: ['review', 'design'] });
    expect((err as Error).message).toContain('the platform review-agent default');
    expect((err as Error).message).toContain('the platform design-run default');
    expect(await auditRows()).toHaveLength(before);
    roleDefaults = { review: null, design: 'glm-5.2' };
    await expect(
      platformRunModelService.removeModel(currentPrincipal!, 'glm-5.2', 'retire'),
    ).rejects.toMatchObject({ platformRoles: ['design'] });
  });

  it('a run-model-defaults read motir-ai cannot answer refuses the remove as unavailable', async () => {
    runDefaultsDown = true;
    await expect(
      platformRunModelService.removeModel(currentPrincipal!, 'glm-5.2', 'retire'),
    ).rejects.toBeInstanceOf(HostedModelsUnavailableError);
    expect(await listed()).toContain('glm-5.2');
  });

  it('refuses a model that is not listed', async () => {
    await expect(
      platformRunModelService.removeModel(currentPrincipal!, 'gpt-9', 'tidy'),
    ).rejects.toBeInstanceOf(RunModelNotListedError);
  });

  it('motir-ai down refuses the remove, with no row', async () => {
    const before = (await auditRows()).length;
    motirAiDown = true;
    await expect(
      platformRunModelService.removeModel(currentPrincipal!, 'glm-5.2', 'retire'),
    ).rejects.toBeInstanceOf(HostedModelsUnavailableError);
    expect(await auditRows()).toHaveLength(before);
  });
});

describe('the role and reason gates', () => {
  it.each(['support', 'operator'] as const)(
    'a %s may not add or remove, and nothing is asked or written',
    async (role) => {
      currentPrincipal = await seedStaff(role);
      await expect(
        platformRunModelService.addModel(currentPrincipal, 'glm-5.2', 'why'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      await expect(
        platformRunModelService.removeModel(currentPrincipal, 'glm-5.2', 'why'),
      ).rejects.toBeInstanceOf(NotPlatformStaffError);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await auditRows()).toHaveLength(0);
    },
  );

  it('a blank reason is refused before motir-ai is asked', async () => {
    await expect(
      platformRunModelService.addModel(currentPrincipal!, 'glm-5.2', ' '),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    await expect(
      platformRunModelService.removeModel(currentPrincipal!, 'glm-5.2', ''),
    ).rejects.toBeInstanceOf(MissingAuditReasonError);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });
});
