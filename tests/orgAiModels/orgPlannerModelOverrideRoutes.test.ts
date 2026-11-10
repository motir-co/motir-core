import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
  OrgModelChoiceNotQualifiedError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
} from '@/lib/ai/errors';
import type { OrgPlannerModelOverridesRead } from '@/lib/ai/types';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-10845 — an org's own planning-side models (Planning, Guide, Debug, Ask)
// through motir-core: the client calls, the service's three-state read and gated
// write, and the route. Real Postgres for membership, roles and the closing guard;
// motir-ai is answered by a stubbed `fetch` at its URL (its own suites own storage,
// qualification and the probe). The compliance gate is the one other stub — a route
// test has no cookie jar.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { GET, PATCH } = await import('@/app/api/organizations/[orgId]/ai-models/planning/route');
const { getOrgPlannerModelOverrides, setOrgPlannerModelOverride } =
  await import('@/lib/ai/motirAiClient');
const { createTestWorkspace, createTestUser } = await import('../fixtures');

const AI_URL = 'https://ai.example.test';
const GUIDE = 'test-guide-model-10845';
const GONE = 'test-gone-model-10845';
const PLATFORM = 'test-platform-model-10845';
const OFFERED_A = 'test-offered-a-10845';
const OFFERED_B = 'test-offered-b-10845';

/** motir-ai's read for a qualifying org with a Guide override and a withdrawn Ask one. */
function readFor(
  overrides: Partial<OrgPlannerModelOverridesRead> = {},
): OrgPlannerModelOverridesRead {
  const row = (
    fn: 'planning' | 'guide' | 'debug' | 'ask',
    model: string | null,
    offered: boolean | null,
    applies: boolean,
  ) => ({
    function: fn,
    model,
    offered,
    applies,
    updatedAt: model ? '2026-11-09T10:00:00.000Z' : null,
    updatedByCoreUserId: model ? 'someone' : null,
  });
  return {
    known: true,
    qualifies: true,
    overrides: [
      row('planning', null, null, false),
      row('guide', GUIDE, true, true),
      row('debug', null, null, false),
      row('ask', GONE, false, false),
    ],
    effective: [
      { function: 'planning', model: PLATFORM, source: 'audience' },
      { function: 'guide', model: GUIDE, source: 'org' },
      { function: 'debug', model: PLATFORM, source: 'function_default' },
      { function: 'ask', model: PLATFORM, source: 'audience' },
    ],
    offered: [
      { id: GUIDE, provider: 'anthropic' },
      { id: OFFERED_A, provider: 'anthropic' },
      { id: OFFERED_B, provider: 'deepseek' },
    ],
    ...overrides,
  };
}

type Answer =
  | { kind: 'ok'; body: unknown }
  | { kind: 'problem'; code: string; status: number; detail?: string }
  | { kind: 'down' };

let getAnswer: Answer;
let putAnswer: Answer;
let calls: { url: string; method: string; body: unknown }[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function answer(a: Answer): Response {
  if (a.kind === 'down') throw new TypeError('fetch failed');
  if (a.kind === 'problem') {
    return json(
      { type: 'about:blank', title: a.code, status: a.status, code: a.code, detail: a.detail },
      a.status,
    );
  }
  return json(a.body);
}

const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  const method = init.method ?? 'GET';
  const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  calls.push({ url, method, body });
  if (method === 'GET') return answer(getAnswer);
  const sent = body as { function: string; model: string | null };
  if (putAnswer.kind === 'ok' && putAnswer.body === undefined) {
    return json({
      function: sent.function,
      previousModel: sent.model === null ? GUIDE : null,
      model: sent.model,
      updatedAt: '2026-11-10T10:00:00.000Z',
    });
  }
  return answer(putAnswer);
});

beforeEach(async () => {
  vi.clearAllMocks();
  process.env['MOTIR_AI_URL'] = AI_URL;
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  calls = [];
  getAnswer = { kind: 'ok', body: readFor() };
  putAnswer = { kind: 'ok', body: undefined };
  await truncateAuthTables();
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

function signInAs(user: { id: string; email: string }) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
}

const params = (orgId: string) => ({ params: Promise.resolve({ orgId }) });
const url = (orgId: string) =>
  `http://localhost:3000/api/organizations/${orgId}/ai-models/planning`;
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
const ALL_IDS = [GUIDE, GONE, PLATFORM, OFFERED_A, OFFERED_B];

describe('motirAiClient — org planner-model overrides', () => {
  it('reads a well-formed answer at the org-keyed path, with the service credential', async () => {
    expect(await getOrgPlannerModelOverrides('org/1')).toEqual(readFor());
    expect(calls[0]?.url).toBe(`${AI_URL}/v1/orgs/org%2F1/planner-model-overrides`);
    expect(
      new Headers((fetchStub.mock.calls[0]?.[1] as RequestInit).headers).get('authorization'),
    ).toBe('Bearer svc-token');
  });

  it.each([
    ['a transport failure', { kind: 'down' } as Answer],
    ['a 5xx', { kind: 'problem', code: 'internal_error', status: 500 } as Answer],
    [
      'a body without overrides',
      { kind: 'ok', body: { ...readFor(), overrides: undefined } } as Answer,
    ],
    ['a body without effective', { kind: 'ok', body: { ...readFor(), effective: null } } as Answer],
    ['a body without offered', { kind: 'ok', body: { ...readFor(), offered: 'x' } } as Answer],
    ['a non-object body', { kind: 'ok', body: 'nope' } as Answer],
  ])('throws MotirAiUnavailableError for %s', async (_name, a) => {
    getAnswer = a;
    await expect(getOrgPlannerModelOverrides('org_1')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });

  it('answers the write, previous → new', async () => {
    const input = { function: 'guide' as const, model: OFFERED_A, actorCoreUserId: 'u1' };
    expect(await setOrgPlannerModelOverride('org_1', input)).toEqual({
      function: 'guide',
      previousModel: null,
      model: OFFERED_A,
      updatedAt: '2026-11-10T10:00:00.000Z',
    });
    expect(calls[0]).toMatchObject({ method: 'PUT', body: input });
  });

  it('maps permission_denied to OrgModelChoiceNotQualifiedError, never the credential fault', async () => {
    putAnswer = {
      kind: 'problem',
      code: 'permission_denied',
      status: 403,
      detail: 'does not qualify',
    };
    const err = await setOrgPlannerModelOverride('org_1', {
      function: 'guide',
      model: OFFERED_A,
      actorCoreUserId: 'u1',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgModelChoiceNotQualifiedError);
    expect(err).not.toBeInstanceOf(MotirAiUnauthorizedError);
  });

  it('maps validation_error to PlannerModelNotOfferedError naming the model, and model_unreachable to PlannerModelUnreachableError', async () => {
    const input = { function: 'debug' as const, model: OFFERED_B, actorCoreUserId: 'u1' };
    putAnswer = { kind: 'problem', code: 'validation_error', status: 400, detail: 'not offered' };
    const notOffered = await setOrgPlannerModelOverride('org_1', input).catch((e: unknown) => e);
    expect(notOffered).toBeInstanceOf(PlannerModelNotOfferedError);
    expect((notOffered as PlannerModelNotOfferedError).model).toBe(OFFERED_B);

    putAnswer = {
      kind: 'problem',
      code: 'model_unreachable',
      status: 422,
      detail: `model "${OFFERED_B}" is not reachable for the planner: provider refused the key`,
    };
    const unreachable = await setOrgPlannerModelOverride('org_1', input).catch((e: unknown) => e);
    expect(unreachable).toBeInstanceOf(PlannerModelUnreachableError);
    expect((unreachable as PlannerModelUnreachableError).reason).toBe('provider refused the key');
  });

  it('sends any other problem through the generic mapper, and refuses a malformed write body', async () => {
    const input = { function: 'ask' as const, model: null, actorCoreUserId: 'u1' };
    putAnswer = { kind: 'problem', code: 'service_unauthorized', status: 401 };
    await expect(setOrgPlannerModelOverride('org_1', input)).rejects.toBeInstanceOf(
      MotirAiUnauthorizedError,
    );
    putAnswer = { kind: 'ok', body: { function: 'ask', previousModel: 3 } };
    await expect(setOrgPlannerModelOverride('org_1', input)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    putAnswer = { kind: 'ok', body: null };
    await expect(setOrgPlannerModelOverride('org_1', input)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('GET /api/organizations/[orgId]/ai-models/planning', () => {
  it.each(['owner', 'admin', 'member'] as const)(
    'a qualifying org reads ready to its %s, four rows in order, canEdit only for owner/admin',
    async (who) => {
      const o = await org();
      signInAs(o[who]);
      const res = await get(o.orgId);
      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body).toEqual({
        state: 'ready',
        canEdit: who !== 'member',
        rows: [
          {
            function: 'planning',
            model: null,
            withdrawn: false,
            applies: false,
            effectiveModel: PLATFORM,
            effectiveSource: 'audience',
            updatedAt: null,
          },
          {
            function: 'guide',
            model: GUIDE,
            withdrawn: false,
            applies: true,
            effectiveModel: GUIDE,
            effectiveSource: 'org',
            updatedAt: '2026-11-09T10:00:00.000Z',
          },
          {
            function: 'debug',
            model: null,
            withdrawn: false,
            applies: false,
            effectiveModel: PLATFORM,
            effectiveSource: 'function_default',
            updatedAt: null,
          },
          {
            function: 'ask',
            model: GONE,
            withdrawn: true,
            applies: false,
            effectiveModel: PLATFORM,
            effectiveSource: 'audience',
            updatedAt: '2026-11-09T10:00:00.000Z',
          },
        ],
        offered: readFor().offered,
      });
      expect(calls[0]?.url).toBe(`${AI_URL}/v1/orgs/${o.orgId}/planner-model-overrides`);
    },
  );

  it('a non-qualifying org with a kept Guide model reads locked, and names no model id anywhere', async () => {
    const o = await org();
    signInAs(o.owner);
    getAnswer = {
      kind: 'ok',
      body: readFor({
        qualifies: false,
        overrides: readFor().overrides.map((r) => ({ ...r, applies: false })),
      }),
    };
    const res = await get(o.orgId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ state: 'locked', canEdit: false, keptChoices: true });
    for (const id of ALL_IDS) expect(text).not.toContain(id);
  });

  it('an org motir-ai has never seen reads locked with no kept choices', async () => {
    const o = await org();
    signInAs(o.admin);
    getAnswer = {
      kind: 'ok',
      body: readFor({
        known: false,
        qualifies: false,
        overrides: readFor().overrides.map((r) => ({
          ...r,
          model: null,
          offered: null,
          applies: false,
        })),
      }),
    };
    expect(await bodyOf(await get(o.orgId))).toEqual({
      state: 'locked',
      canEdit: false,
      keptChoices: false,
    });
  });

  it('reads unreadable when motir-ai cannot be reached, or is not configured', async () => {
    const o = await org();
    signInAs(o.owner);
    getAnswer = { kind: 'down' };
    const down = await get(o.orgId);
    expect(down.status).toBe(200);
    const text = await down.text();
    expect(JSON.parse(text)).toEqual({ state: 'unreadable', canEdit: false });
    for (const id of ALL_IDS) expect(text).not.toContain(id);

    delete process.env['MOTIR_AI_URL'];
    expect(await bodyOf(await get(o.orgId))).toEqual({ state: 'unreadable', canEdit: false });
  });

  it('a credential fault is not dressed as unreadable: it surfaces as a server error', async () => {
    const o = await org();
    signInAs(o.owner);
    getAnswer = { kind: 'problem', code: 'service_unauthorized', status: 401 };
    await expect(get(o.orgId)).rejects.toBeInstanceOf(MotirAiUnauthorizedError);
  });

  it('401 without a session, 404 for a signed-in non-member, neither calling motir-ai', async () => {
    const o = await org();
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });
    expect((await get(o.orgId)).status).toBe(401);
    signInAs(o.outsider);
    expect((await get(o.orgId)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('PATCH /api/organizations/[orgId]/ai-models/planning', () => {
  it.each(['owner', 'admin'] as const)(
    'an %s sets and clears a model, sending motir-ai the actor',
    async (who) => {
      const o = await org();
      signInAs(o[who]);
      const set = await patch(o.orgId, { function: 'guide', model: OFFERED_A });
      expect(set.status).toBe(200);
      expect(await bodyOf(set)).toEqual({
        function: 'guide',
        previousModel: null,
        model: OFFERED_A,
        updatedAt: '2026-11-10T10:00:00.000Z',
      });
      expect(calls[0]).toEqual({
        url: `${AI_URL}/v1/orgs/${o.orgId}/planner-model-overrides`,
        method: 'PUT',
        body: { function: 'guide', model: OFFERED_A, actorCoreUserId: o[who].id },
      });

      const clear = await patch(o.orgId, { function: 'guide', model: null });
      expect(await bodyOf(clear)).toMatchObject({ previousModel: GUIDE, model: null });
    },
  );

  it('403 for a plain member and 404 for a non-member, without calling motir-ai', async () => {
    const o = await org();
    signInAs(o.member);
    expect((await patch(o.orgId, { function: 'guide', model: OFFERED_A })).status).toBe(403);
    signInAs(o.outsider);
    expect((await patch(o.orgId, { function: 'guide', model: OFFERED_A })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a non-JSON body', 'not json', true],
    ['a JSON array', [], false],
    ['a missing function', { model: OFFERED_A }, false],
    ['the review function', { function: 'review', model: OFFERED_A }, false],
    ['a numeric model', { function: 'guide', model: 3 }, false],
    ['an empty model', { function: 'guide', model: '  ' }, false],
    ['a missing model', { function: 'guide' }, false],
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
    expect((await patch(o.orgId, { function: 'guide', model: OFFERED_A })).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['permission_denied', 403, 403, 'ORG_MODEL_CHOICE_NOT_QUALIFIED'],
    ['validation_error', 400, 422, 'MODEL_NOT_OFFERED'],
    ['model_unreachable', 422, 422, 'MODEL_UNREACHABLE'],
  ] as const)('motir-ai %s → %s %s', async (code, upstream, status, ours) => {
    const o = await org();
    signInAs(o.owner);
    putAnswer = {
      kind: 'problem',
      code,
      status: upstream,
      detail: `model "${OFFERED_B}" is not reachable for the planner: x`,
    };
    const res = await patch(o.orgId, { function: 'debug', model: OFFERED_B });
    expect(res.status).toBe(status);
    const body = await bodyOf(res);
    expect(body['code']).toBe(ours);
    if (ours !== 'ORG_MODEL_CHOICE_NOT_QUALIFIED') expect(body['model']).toBe(OFFERED_B);
  });

  it('503 MODELS_UNREADABLE when motir-ai cannot be reached or is not configured', async () => {
    const o = await org();
    signInAs(o.owner);
    putAnswer = { kind: 'down' };
    const down = await patch(o.orgId, { function: 'ask', model: null });
    expect(down.status).toBe(503);
    expect((await bodyOf(down))['code']).toBe('MODELS_UNREADABLE');
    delete process.env['MOTIR_AI_SERVICE_TOKEN'];
    const unset = await patch(o.orgId, { function: 'ask', model: null });
    expect(unset.status).toBe(503);
  });

  it('a credential fault on the write surfaces as a server error', async () => {
    const o = await org();
    signInAs(o.owner);
    putAnswer = { kind: 'problem', code: 'service_unauthorized', status: 401 };
    await expect(patch(o.orgId, { function: 'ask', model: null })).rejects.toBeInstanceOf(
      MotirAiUnauthorizedError,
    );
  });

  it('401 passes straight through from the session gate', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });
    expect((await patch('any-org', { function: 'guide', model: null })).status).toBe(401);
  });
});
