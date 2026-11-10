import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-10850 — an org's own RUN-SIDE models (a default per difficulty, the review
// agent, the design run) through `/api/organizations/[orgId]/ai-models/runs`. Real
// Postgres for membership, roles, the closing guard, the six `organization` columns
// and the run-model list; motir-ai is answered by a stubbed `fetch` on its two
// routes (`/v1/agent-models`, `/v1/admin/orgs/tiers`). The compliance gate is the
// one other stub — a route test has no cookie jar.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { GET, PATCH } = await import('@/app/api/organizations/[orgId]/ai-models/runs/route');
const { createTestWorkspace, createTestUser } = await import('../fixtures');

const AI_URL = 'https://ai.example.test';
const OPUS = 'test-run-opus-10850';
const SONNET = 'test-run-sonnet-10850';
const FABLE = 'test-run-fable-10850';
const GLM = 'test-run-glm-10850';
const GONE = 'test-run-gone-10850';

const OFFER = {
  models: [
    { id: OPUS, provider: 'anthropic' },
    { id: SONNET, provider: 'anthropic' },
    { id: FABLE, provider: 'anthropic' },
    { id: GLM, provider: 'zai' },
  ],
  default: OPUS,
  defaultsByDifficulty: { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS },
  reviewAgentDefault: SONNET,
  designRunDefault: FABLE,
};
const ALL_IDS = [OPUS, SONNET, FABLE, GLM, GONE];

let offer: { status: number; body: unknown };
let tier: { status: number; tierKey: string | null };
let calls: string[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
  calls.push(url);
  if (url.endsWith('/v1/admin/orgs/tiers')) {
    const { coreOrganizationIds } = JSON.parse(String(init?.body)) as {
      coreOrganizationIds: string[];
    };
    return json(
      {
        orgs: coreOrganizationIds.map((id) => ({ coreOrganizationId: id, tierKey: tier.tierKey })),
      },
      tier.status,
    );
  }
  if (url.endsWith('/v1/agent-models')) return json(offer.body, offer.status);
  throw new Error(`unexpected fetch ${url}`);
});

beforeEach(async () => {
  vi.clearAllMocks();
  process.env['MOTIR_AI_URL'] = AI_URL;
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  calls = [];
  offer = { status: 200, body: OFFER };
  tier = { status: 200, tierKey: 'pro' };
  await truncateAuthTables();
  // An uninitialised run-model list narrows nothing (MOTIR-7526).
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function org() {
  const { workspace, owner } = await createTestWorkspace();
  const orgId = workspace.organizationId;
  const add = async (role: 'admin' | 'member') => {
    const user = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: user.id, role },
    });
    return user;
  };
  return {
    orgId,
    owner,
    admin: await add('admin'),
    member: await add('member'),
    outsider: await createTestUser(),
  };
}

type Columns = {
  isMeta?: boolean;
  hostedModelTrivial?: string | null;
  hostedModelLow?: string | null;
  hostedModelMedium?: string | null;
  hostedModelHigh?: string | null;
  hostedReviewModel?: string | null;
  hostedDesignModel?: string | null;
};
const store = (orgId: string, data: Columns) =>
  adminDb.organization.update({ where: { id: orgId }, data });
const columnsOf = (orgId: string) =>
  adminDb.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: {
      hostedModelTrivial: true,
      hostedModelLow: true,
      hostedModelMedium: true,
      hostedModelHigh: true,
      hostedReviewModel: true,
      hostedDesignModel: true,
    },
  });

function signInAs(user: { id: string; email: string }) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
}

const params = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const url = (orgId: string) => `http://localhost:3000/api/organizations/${orgId}/ai-models/runs`;
const get = (orgId: string) => GET(new Request(url(orgId)), params(orgId));
const patch = (orgId: string, body: unknown, raw = false) =>
  PATCH(
    new Request(url(orgId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    params(orgId),
  );
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;
const noModelIdIn = (body: unknown) => {
  const text = JSON.stringify(body);
  for (const id of ALL_IDS) expect(text).not.toContain(id);
};

describe('GET /api/organizations/[orgId]/ai-models/runs', () => {
  it.each(['owner', 'admin', 'member'] as const)(
    'a Pro org reads ready to its %s: six rows in order, canEdit only for owner/admin',
    async (who) => {
      const o = await org();
      await store(o.orgId, { hostedModelHigh: FABLE, hostedReviewModel: GLM });
      signInAs(o[who]);
      const res = await get(o.orgId);
      expect(res.status).toBe(200);
      expect(await bodyOf(res)).toEqual({
        state: 'ready',
        canEdit: who !== 'member',
        rows: [
          {
            key: 'trivial',
            model: null,
            withdrawn: false,
            effectiveModel: SONNET,
            effectiveSource: 'platform_level',
          },
          {
            key: 'low',
            model: null,
            withdrawn: false,
            effectiveModel: SONNET,
            effectiveSource: 'platform_level',
          },
          {
            key: 'medium',
            model: null,
            withdrawn: false,
            effectiveModel: OPUS,
            effectiveSource: 'platform_level',
          },
          {
            key: 'high',
            model: FABLE,
            withdrawn: false,
            effectiveModel: FABLE,
            effectiveSource: 'org_level',
          },
          {
            key: 'review',
            model: GLM,
            withdrawn: false,
            effectiveModel: GLM,
            effectiveSource: 'org_review',
          },
          {
            key: 'design',
            model: null,
            withdrawn: false,
            effectiveModel: FABLE,
            effectiveSource: 'platform_design',
          },
        ],
        offered: OFFER.models,
      });
    },
  );

  it('a stored value off the offer reads withdrawn and its row falls to the next layer', async () => {
    const o = await org();
    await store(o.orgId, {
      hostedModelLow: GONE,
      hostedReviewModel: GONE,
      hostedDesignModel: GONE,
    });
    signInAs(o.owner);
    const body = await bodyOf(await get(o.orgId));
    const rows = body['rows'] as Record<string, unknown>[];
    const row = (key: string) => rows.find((r) => r['key'] === key);
    expect(row('low')).toMatchObject({
      model: GONE,
      withdrawn: true,
      effectiveModel: SONNET,
      effectiveSource: 'platform_level',
    });
    expect(row('review')).toMatchObject({ withdrawn: true, effectiveSource: 'platform_review' });
    expect(row('design')).toMatchObject({ withdrawn: true, effectiveSource: 'platform_design' });
  });

  it('a model removed from the run-model list reads withdrawn — the list is not blocked by it', async () => {
    const o = await org();
    await store(o.orgId, { hostedModelHigh: GLM });
    await adminDb.platformRunModelList.create({ data: { id: 'platform' } });
    await adminDb.platformRunModel.createMany({
      data: [OPUS, SONNET, FABLE].map((model) => ({ model })),
    });
    signInAs(o.owner);
    const rows = (await bodyOf(await get(o.orgId)))['rows'] as Record<string, unknown>[];
    expect(rows.find((r) => r['key'] === 'high')).toMatchObject({
      model: GLM,
      withdrawn: true,
      effectiveModel: OPUS,
      effectiveSource: 'platform_level',
    });
  });

  it('with no platform review or design model: review reads the default, design the difficulty', async () => {
    const o = await org();
    offer = { status: 200, body: { ...OFFER, reviewAgentDefault: null, designRunDefault: null } };
    signInAs(o.owner);
    const rows = (await bodyOf(await get(o.orgId)))['rows'] as Record<string, unknown>[];
    expect(rows.find((r) => r['key'] === 'review')).toMatchObject({
      effectiveModel: OPUS,
      effectiveSource: 'platform_default',
    });
    expect(rows.find((r) => r['key'] === 'design')).toEqual({
      key: 'design',
      model: null,
      withdrawn: false,
      effectiveModel: null,
      effectiveSource: 'difficulty_mapping',
    });
  });

  it('a Standard org with a stored High reads locked, kept choices, and names no model id', async () => {
    const o = await org();
    await store(o.orgId, { hostedModelHigh: FABLE, hostedDesignModel: GONE });
    tier = { status: 200, tierKey: 'standard' };
    signInAs(o.owner);
    const body = await bodyOf(await get(o.orgId));
    expect(body).toEqual({ state: 'locked', canEdit: false, keptChoices: true });
    noModelIdIn(body);
    expect(calls.some((c) => c.endsWith('/v1/agent-models'))).toBe(false);
  });

  it('a Standard org with nothing stored reads locked with no kept choices', async () => {
    const o = await org();
    tier = { status: 200, tierKey: 'free' };
    signInAs(o.member);
    expect(await bodyOf(await get(o.orgId))).toEqual({
      state: 'locked',
      canEdit: false,
      keptChoices: false,
    });
  });

  it('the meta org on tier free reads ready without a tier read', async () => {
    const o = await org();
    await store(o.orgId, { isMeta: true });
    tier = { status: 200, tierKey: 'free' };
    signInAs(o.owner);
    expect((await bodyOf(await get(o.orgId)))['state']).toBe('ready');
    expect(calls.some((c) => c.endsWith('/v1/admin/orgs/tiers'))).toBe(false);
  });

  it('reads unreadable when the tier read fails, or the offer is unavailable', async () => {
    const o = await org();
    await store(o.orgId, { hostedModelHigh: FABLE });
    signInAs(o.owner);
    tier = { status: 503, tierKey: 'pro' };
    let body = await bodyOf(await get(o.orgId));
    expect(body).toEqual({ state: 'unreadable', canEdit: false });
    tier = { status: 200, tierKey: 'pro' };
    offer = { status: 503, body: { code: 'internal_error' } };
    body = await bodyOf(await get(o.orgId));
    expect(body).toEqual({ state: 'unreadable', canEdit: false });
    noModelIdIn(body);
  });

  it('401 without a session, 404 for a signed-in non-member, neither calling motir-ai', async () => {
    const o = await org();
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await get(o.orgId)).status).toBe(401);
    signInAs(o.outsider);
    expect((await get(o.orgId)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('PATCH /api/organizations/[orgId]/ai-models/runs', () => {
  it.each(['owner', 'admin'] as const)(
    'an %s stores High and answers previous → new with the recomputed row',
    async (who) => {
      const o = await org();
      signInAs(o[who]);
      const res = await patch(o.orgId, { key: 'high', model: FABLE });
      expect(res.status).toBe(200);
      expect(await bodyOf(res)).toEqual({
        key: 'high',
        previousModel: null,
        model: FABLE,
        row: {
          key: 'high',
          model: FABLE,
          withdrawn: false,
          effectiveModel: FABLE,
          effectiveSource: 'org_level',
        },
      });
      expect((await columnsOf(o.orgId)).hostedModelHigh).toBe(FABLE);
    },
  );

  it('null clears the column and answers the previous model; review and design work the same', async () => {
    const o = await org();
    await store(o.orgId, { hostedModelHigh: FABLE });
    signInAs(o.owner);
    const cleared = await bodyOf(await patch(o.orgId, { key: 'high', model: null }));
    expect(cleared).toMatchObject({
      key: 'high',
      previousModel: FABLE,
      model: null,
      row: { model: null, effectiveModel: OPUS, effectiveSource: 'platform_level' },
    });
    expect(await bodyOf(await patch(o.orgId, { key: 'review', model: GLM }))).toMatchObject({
      row: { key: 'review', effectiveModel: GLM, effectiveSource: 'org_review' },
    });
    expect(await bodyOf(await patch(o.orgId, { key: 'design', model: SONNET }))).toMatchObject({
      row: { key: 'design', effectiveModel: SONNET, effectiveSource: 'org_design' },
    });
    expect(await columnsOf(o.orgId)).toEqual({
      hostedModelTrivial: null,
      hostedModelLow: null,
      hostedModelMedium: null,
      hostedModelHigh: null,
      hostedReviewModel: GLM,
      hostedDesignModel: SONNET,
    });
  });

  it('403 for a plain member and 404 for a non-member, without calling motir-ai', async () => {
    const o = await org();
    signInAs(o.member);
    expect((await patch(o.orgId, { key: 'high', model: FABLE })).status).toBe(403);
    signInAs(o.outsider);
    expect((await patch(o.orgId, { key: 'high', model: FABLE })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a non-JSON body', 'not json', true],
    ['a JSON array', [], false],
    ['a missing key', { model: FABLE }, false],
    ['a planning-side key', { key: 'guide', model: FABLE }, false],
    ['a numeric model', { key: 'high', model: 3 }, false],
    ['an empty model', { key: 'high', model: '  ' }, false],
    ['a missing model', { key: 'high' }, false],
  ] as const)('400 BAD_REQUEST for %s', async (_name, body, raw) => {
    const o = await org();
    signInAs(o.owner);
    const res = await patch(o.orgId, body, raw);
    expect(res.status).toBe(400);
    expect((await bodyOf(res))['code']).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('409 for a closing org, without calling motir-ai', async () => {
    const o = await org();
    await adminDb.organization.update({
      where: { id: o.orgId },
      data: { closingSince: new Date() },
    });
    signInAs(o.owner);
    expect((await patch(o.orgId, { key: 'high', model: FABLE })).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('403 ORG_MODEL_CHOICE_NOT_QUALIFIED for a Standard org', async () => {
    const o = await org();
    tier = { status: 200, tierKey: 'standard' };
    signInAs(o.owner);
    const res = await patch(o.orgId, { key: 'high', model: FABLE });
    expect(res.status).toBe(403);
    expect((await bodyOf(res))['code']).toBe('ORG_MODEL_CHOICE_NOT_QUALIFIED');
  });

  it('422 MODEL_NOT_OFFERED naming a model outside the narrowed offer', async () => {
    const o = await org();
    signInAs(o.owner);
    const res = await patch(o.orgId, { key: 'review', model: GONE });
    expect(res.status).toBe(422);
    expect(await bodyOf(res)).toMatchObject({ code: 'MODEL_NOT_OFFERED', model: GONE });
  });

  it('503 MODELS_UNREADABLE when the tier read fails or the offer is unavailable', async () => {
    const o = await org();
    signInAs(o.owner);
    tier = { status: 503, tierKey: 'pro' };
    let res = await patch(o.orgId, { key: 'high', model: FABLE });
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('MODELS_UNREADABLE');
    tier = { status: 200, tierKey: 'pro' };
    offer = { status: 503, body: { code: 'internal_error' } };
    res = await patch(o.orgId, { key: 'high', model: FABLE });
    expect(res.status).toBe(503);
    expect((await bodyOf(res))['code']).toBe('MODELS_UNREADABLE');
  });

  it('every refusal leaves the six columns unchanged', async () => {
    const o = await org();
    await store(o.orgId, { hostedModelHigh: SONNET, hostedReviewModel: GLM });
    const before = await columnsOf(o.orgId);
    signInAs(o.member);
    await patch(o.orgId, { key: 'high', model: FABLE });
    signInAs(o.owner);
    await patch(o.orgId, { key: 'high', model: GONE });
    tier = { status: 200, tierKey: 'standard' };
    await patch(o.orgId, { key: 'high', model: FABLE });
    tier = { status: 503, tierKey: null };
    await patch(o.orgId, { key: 'high', model: FABLE });
    expect(await columnsOf(o.orgId)).toEqual(before);
  });

  it('401 passes straight through from the session gate', async () => {
    const o = await org();
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await patch(o.orgId, { key: 'high', model: FABLE })).status).toBe(401);
  });
});
