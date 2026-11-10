import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6989 · MOTIR-6993 — the per-project hosted-agent model overrides and
// the effective-model resolver, over the real Postgres. motir-ai is the one HTTP
// seam: `fetch` is stubbed with the `/v1/agent-models` answer, exactly as the
// hosted-run model-service suite does. `getWorkspaceContext` is stubbed for the
// route half (no cookies in the test env); the real `withWorkspaceContext` stays.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET, PATCH } = await import('@/app/api/projects/[key]/hosted-agent-settings/route');
const { projectHostedAgentSettingsService: service } =
  await import('@/lib/services/projectHostedAgentSettingsService');

const OFFERED = {
  models: [
    { id: 'claude-opus-5', provider: 'anthropic' },
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-5-5', provider: 'anthropic' },
  ],
  default: 'claude-opus-5-5',
  defaultsByDifficulty: {
    trivial: 'claude-sonnet-5-5',
    low: 'claude-sonnet-5-5',
    medium: 'claude-opus-5-5',
    high: 'claude-opus-5-5',
  },
};

function serveModels(body: unknown = OFFERED, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  serveModels();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (fx: WorkItemFixture, userId = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
});

async function addMember(fx: WorkItemFixture, workspaceRole: 'member' | 'viewer' = 'member') {
  const member = await createTestUser({
    email: `${workspaceRole}-${fx.workspaceId}@example.com`,
  });
  await adminDb.workspaceMembership.create({
    data: { userId: member.id, workspaceId: fx.workspaceId, workspaceRole },
  });
  return member;
}

const levelOf = (dto: Awaited<ReturnType<typeof service.get>>, level: string) =>
  dto.levels.find((l) => l.level === level)!;

describe('projectHostedAgentSettingsService.get', () => {
  it('reads every level at its platform default on a fresh project, easiest first', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await service.get(fx.projectIdentifier, ctxFor(fx));
    expect(dto.levels.map((l) => l.level)).toEqual(['trivial', 'low', 'medium', 'high']);
    expect(levelOf(dto, 'low')).toEqual({
      level: 'low',
      override: null,
      overrideOffered: true,
      platformDefault: 'claude-sonnet-5-5',
      inheritedFrom: 'platform',
      effective: 'claude-sonnet-5-5',
      source: 'platform_level',
    });
    expect(levelOf(dto, 'high').effective).toBe('claude-opus-5-5');
    expect(dto.offeredModels).toEqual(['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    // MOTIR-6995 — the room labels each option with its provider.
    expect(dto.offered).toEqual(OFFERED.models);
    expect(dto.noDifficulty).toEqual({ effective: 'claude-opus-5-5', source: 'platform_default' });
  });

  it('flags a WITHDRAWN override with overrideOffered: false, and falls back to the platform default', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { hostedModelLow: 'claude-retired-4' },
    });
    const low = levelOf(await service.get(fx.projectIdentifier, ctxFor(fx)), 'low');
    expect(low).toMatchObject({
      override: 'claude-retired-4',
      overrideOffered: false,
      effective: 'claude-sonnet-5-5',
      source: 'platform_level',
    });
  });

  it('refuses a key in another workspace as not found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await expect(service.get(other.projectIdentifier, ctxFor(fx))).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('refuses with HostedModelsUnavailableError when motir-ai cannot answer', async () => {
    const fx = await makeWorkItemFixture();
    serveModels({}, 503);
    await expect(service.get(fx.projectIdentifier, ctxFor(fx))).rejects.toBeInstanceOf(
      HostedModelsUnavailableError,
    );
  });
});

describe('projectHostedAgentSettingsService.update', () => {
  it('sets an override, persists it, and reports it as the effective model', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await service.update(fx.projectIdentifier, { low: 'claude-opus-5' }, ctxFor(fx));
    expect(levelOf(dto, 'low')).toMatchObject({
      override: 'claude-opus-5',
      effective: 'claude-opus-5',
      source: 'override',
    });
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.hostedModelLow).toBe('claude-opus-5');
    expect(row.hostedModelHigh).toBeNull();
  });

  it('resets a level with null, leaving the others untouched', async () => {
    const fx = await makeWorkItemFixture();
    await service.update(
      fx.projectIdentifier,
      { low: 'claude-opus-5', high: 'claude-sonnet-5-5' },
      ctxFor(fx),
    );
    const dto = await service.update(fx.projectIdentifier, { low: null }, ctxFor(fx));
    expect(levelOf(dto, 'low')).toMatchObject({ override: null, source: 'platform_level' });
    expect(levelOf(dto, 'high')).toMatchObject({ override: 'claude-sonnet-5-5' });
  });

  // MOTIR-6997 coverage floor — the two patch shapes a JSON body can still carry.
  it('reads a blank string as a reset, and trims an offered model', async () => {
    const fx = await makeWorkItemFixture();
    await service.update(fx.projectIdentifier, { low: 'claude-opus-5' }, ctxFor(fx));
    const dto = await service.update(
      fx.projectIdentifier,
      { low: '   ', medium: ' claude-opus-5 ' },
      ctxFor(fx),
    );
    expect(levelOf(dto, 'low')).toMatchObject({ override: null, source: 'platform_level' });
    expect(levelOf(dto, 'medium')).toMatchObject({ override: 'claude-opus-5' });
  });

  it('refuses a non-string value as a model that is not offered', async () => {
    const fx = await makeWorkItemFixture();
    const err = await service
      .update(fx.projectIdentifier, { high: 42 as unknown as string }, ctxFor(fx))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedModelNotOfferedError);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.hostedModelHigh).toBeNull();
  });

  it('refuses a model that is not offered and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      service.update(fx.projectIdentifier, { trivial: 'claude-opus-5', low: 'gpt-9' }, ctxFor(fx)),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.hostedModelTrivial).toBeNull();
    expect(row.hostedModelLow).toBeNull();
  });

  it('refuses an override to a model motir-ai offers but the run-model list does not hold (MOTIR-7526)', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.platformRunModelList.create({ data: { id: 'platform' } });
    await adminDb.platformRunModel.createMany({
      data: [{ model: 'claude-opus-5-5' }, { model: 'claude-sonnet-5-5' }],
    });
    await expect(
      service.update(fx.projectIdentifier, { high: 'claude-opus-5' }, ctxFor(fx)),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(row.hostedModelHigh).toBeNull();
    // The room offers the listed models only, and still accepts one of them.
    const dto = await service.update(
      fx.projectIdentifier,
      { high: 'claude-sonnet-5-5' },
      ctxFor(fx),
    );
    expect(dto.offeredModels).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(levelOf(dto, 'high').effective).toBe('claude-sonnet-5-5');
  });

  it('lets a member READ but not CHANGE the settings (ai:configure)', async () => {
    const fx = await makeWorkItemFixture();
    const member = await addMember(fx);
    await expect(service.get(fx.projectIdentifier, ctxFor(fx, member.id))).resolves.toBeTruthy();
    const err = await service
      .update(fx.projectIdentifier, { low: 'claude-opus-5' }, ctxFor(fx, member.id))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('ai:configure');
  });

  // MOTIR-6995 — the READ asks for the room's VIEW key, `work_item:edit` (design
  // MOTIR-6991): a viewer browses the project but may not start a hosted run, so
  // it may not read which model one would use either.
  it('refuses a READ to a viewer, who browses but lacks work_item:edit', async () => {
    const fx = await makeWorkItemFixture();
    const viewer = await addMember(fx, 'viewer');
    const err = await service
      .get(fx.projectIdentifier, ctxFor(fx, viewer.id))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('work_item:edit');
  });
});

describe('projectHostedAgentSettingsService.resolveForWorkItem', () => {
  it("resolves a leaf from its own difficulty and the project's override", async () => {
    const fx = await makeWorkItemFixture();
    const leaf = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    await adminDb.workItem.update({ where: { id: leaf.id }, data: { difficulty: 'low' } });
    await service.update(fx.projectIdentifier, { low: 'claude-opus-5' }, ctxFor(fx));
    expect(await service.resolveForWorkItem(leaf.id, ctxFor(fx))).toEqual({
      model: 'claude-opus-5',
      source: 'override',
      difficulty: 'low',
      fromLeaves: false,
      design: false,
    });
  });

  it('resolves a leaf with no difficulty to the platform default', async () => {
    const fx = await makeWorkItemFixture();
    const leaf = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    expect(await service.resolveForWorkItem(leaf.id, ctxFor(fx))).toEqual({
      model: 'claude-opus-5-5',
      source: 'platform_default',
      difficulty: null,
      fromLeaves: false,
      design: false,
    });
  });

  it('resolves a story from the HIGHEST difficulty among its UNFINISHED leaves, ignoring a done one', async () => {
    const fx = await makeWorkItemFixture();
    await service.update(
      fx.projectIdentifier,
      { medium: 'claude-sonnet-5-5', high: 'claude-opus-5' },
      ctxFor(fx),
    );
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    const low = await createTestWorkItem(fx, { kind: 'subtask', title: 'Low', parentId: story.id });
    const med = await createTestWorkItem(fx, { kind: 'subtask', title: 'Med', parentId: story.id });
    const doneHigh = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Done high',
      parentId: story.id,
    });
    await adminDb.workItem.update({ where: { id: low.id }, data: { difficulty: 'low' } });
    await adminDb.workItem.update({ where: { id: med.id }, data: { difficulty: 'medium' } });
    await adminDb.workItem.update({
      where: { id: doneHigh.id },
      data: { difficulty: 'high', status: 'done' },
    });
    expect(await service.resolveForWorkItem(story.id, ctxFor(fx))).toEqual({
      model: 'claude-sonnet-5-5',
      source: 'override',
      difficulty: 'medium',
      fromLeaves: true,
      design: false,
    });

    // Reopen the high leaf: it now counts.
    await adminDb.workItem.update({ where: { id: doneHigh.id }, data: { status: 'todo' } });
    expect(await service.resolveForWorkItem(story.id, ctxFor(fx))).toMatchObject({
      model: 'claude-opus-5',
      difficulty: 'high',
    });
  });

  it('answers null for an id that names no card, without asking motir-ai', async () => {
    const fx = await makeWorkItemFixture();
    serveModels({}, 503);
    expect(await service.resolveForWorkItem('no-such-work-item', ctxFor(fx))).toBeNull();
  });

  it('answers null when nothing is offered', async () => {
    const fx = await makeWorkItemFixture();
    const leaf = await createTestWorkItem(fx, { kind: 'task', title: 'Leaf' });
    serveModels({ models: [], default: null });
    expect(await service.resolveForWorkItem(leaf.id, ctxFor(fx))).toBeNull();
  });
});

describe('GET / PATCH /api/projects/[key]/hosted-agent-settings', () => {
  const BASE = 'http://localhost:3000/api/projects';
  const params = (key: string) => ({ params: Promise.resolve({ key }) });
  const get = (key: string) =>
    GET(new Request(`${BASE}/${key}/hosted-agent-settings`), params(key));
  const patch = (key: string, body: unknown) =>
    PATCH(
      new Request(`${BASE}/${key}/hosted-agent-settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      params(key),
    );

  it('401s with no workspace context', async () => {
    expect((await get('PROD')).status).toBe(401);
  });

  it('answers the settings to a member', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = ctxFor(fx);
    const res = await get(fx.projectIdentifier);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { levels: unknown[] }).levels).toHaveLength(4);
  });

  it('PATCH forwards a null reset and answers the new settings', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = ctxFor(fx);
    expect((await patch(fx.projectIdentifier, { high: 'claude-opus-5' })).status).toBe(200);
    const res = await patch(fx.projectIdentifier, { high: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { levels: { level: string; override: string | null }[] };
    expect(body.levels.find((l) => l.level === 'high')?.override).toBeNull();
  });

  it('422s an unoffered model with HOSTED_MODEL_NOT_OFFERED', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = ctxFor(fx);
    const res = await patch(fx.projectIdentifier, { low: 'gpt-9' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'HOSTED_MODEL_NOT_OFFERED', model: 'gpt-9' });
  });

  it('403s a GET from a viewer without work_item:edit', async () => {
    const fx = await makeWorkItemFixture();
    const viewer = await addMember(fx, 'viewer');
    ctxRef.current = ctxFor(fx, viewer.id);
    expect((await get(fx.projectIdentifier)).status).toBe(403);
  });

  it('403s a member without ai:configure', async () => {
    const fx = await makeWorkItemFixture();
    const member = await addMember(fx);
    ctxRef.current = ctxFor(fx, member.id);
    expect((await patch(fx.projectIdentifier, { low: 'claude-opus-5' })).status).toBe(403);
  });

  it('404s an unknown key', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = ctxFor(fx);
    expect((await get('NOPE')).status).toBe(404);
  });

  it('503s with HOSTED_MODELS_UNAVAILABLE when motir-ai cannot answer', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = ctxFor(fx);
    serveModels({}, 500);
    const res = await get(fx.projectIdentifier);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'HOSTED_MODELS_UNAVAILABLE' });
  });

  it('400s a body that is not JSON', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = ctxFor(fx);
    const res = await PATCH(
      new Request(`${BASE}/${fx.projectIdentifier}/hosted-agent-settings`, {
        method: 'PATCH',
        body: 'nope',
      }),
      params(fx.projectIdentifier),
    );
    expect(res.status).toBe(400);
  });
});
