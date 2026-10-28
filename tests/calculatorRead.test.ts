import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import type {
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
} from '@/lib/dto/billing';

// The Calculator's read behind motir-core's own door (Story MOTIR-8381 ·
// MOTIR-8637): GET /api/organizations/[orgId]/billing/calculator/categories and
// POST …/calculator/estimate. What motir-core owns on this path, and what this
// file proves:
//   - the gate is the billing page's own: signed-out 401, off-cloud 404, a
//     non-member 404, a plain member 403 — none of them reaching the engine,
//   - the request schema refuses a bad body by field (400) before the engine,
//   - the engine's answers cross UNALTERED (an estimate, or its empty_category,
//     both 200, both `no-store`), and nothing on the path caches,
//   - the engine's own refusals come out distinct: its unavailable answer and its
//     rate limit → 503, its validation_error → 400, any other failure → 502.
// Real Postgres for the org and its memberships (the no-mocks rule). The boundary
// is mocked at `fetch`, BELOW the real motir-ai client, so the client's shape
// validation and its problem recognizers are exercised rather than stubbed.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { GET: categoriesGET } =
  await import('@/app/api/organizations/[orgId]/billing/calculator/categories/route');
const { POST: estimatePOST } =
  await import('@/app/api/organizations/[orgId]/billing/calculator/estimate/route');
const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

const ENGINE = 'http://motir-ai.test';

// The engine's bodies, as `src/services/calculatorService.ts` writes them. The
// values are fixture data, not motir-core figures.
const CATEGORIES: CalculatorCategoriesDTO = {
  version: 1,
  categoryRuleVersion: 'rule-fixture',
  modelsReadAt: '2026-10-15T08:00:00.000Z',
  cadences: ['annual', 'monthly'],
  defaultCadence: 'annual',
  categories: [
    { key: 'band-a', models: [{ id: 'model-a1', provider: 'provider-x' }] },
    {
      key: 'band-b',
      models: [
        { id: 'model-b1', provider: 'provider-y' },
        { id: 'model-b2', provider: 'provider-z' },
      ],
    },
    // A band with nothing behind it is listed on purpose (calculatorCategories.ts).
    { key: 'band-empty', models: [] },
  ],
};

const ESTIMATE: CalculatorEstimateDTO = {
  version: 1,
  kind: 'estimate',
  profilesVersion: 'profiles-fixture',
  categoryRuleVersion: 'rule-fixture',
  cadence: 'monthly',
  plannedPerMonth: { low: 10, high: 40 },
  runPerMonth: { low: 10, high: 40 },
  credits: { low: 1234, high: 5678 },
  perItemCredits: { planning: 12.5, running: 30.25 },
  split: {
    count: 2,
    categories: [
      { key: 'band-a', weight: 0.5, models: ['model-a1'] },
      { key: 'band-b', weight: 0.5, models: ['model-b1', 'model-b2'] },
    ],
  },
  recommendation: { planKey: 'plan-fixture', planName: 'Plan Fixture', monthlyPriceUsd: 42 },
  topUp: {
    low: { units: 0, credits: 0, priceUsd: 0 },
    high: { units: 3, credits: 3000, priceUsd: 15 },
  },
  ceiling: { credits: 99999, exceeded: false, excessCredits: 0, outcome: 'within_ladder' },
};

const EMPTY_CATEGORY: CalculatorEmptyCategoryDTO = {
  version: 1,
  kind: 'empty_category',
  categoryRuleVersion: 'rule-fixture',
  categories: ['band-empty'],
};

const REQUEST = {
  plannedPerMonth: { low: 10, high: 40 },
  runPerMonth: { low: 10, high: 40 },
  categories: ['band-a', 'band-b'],
  cadence: 'monthly',
};

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

function getCategories(orgId: string) {
  return categoriesGET(new Request(`http://localhost:3000/api/organizations/${orgId}/x`), {
    params: Promise.resolve({ orgId }),
  });
}

function postEstimate(orgId: string, body: unknown) {
  return estimatePOST(
    new Request(`http://localhost:3000/api/organizations/${orgId}/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return { organizationId, owner, admin, member };
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_AI_URL'] = ENGINE;
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_AI_URL'];
  delete process.env['MOTIR_AI_SERVICE_TOKEN'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the gate — the billing page’s own, on both routes, before the engine', () => {
  const calls: Array<[string, (orgId: string) => Promise<Response>]> = [
    ['categories', (orgId) => getCategories(orgId)],
    ['estimate', (orgId) => postEstimate(orgId, REQUEST)],
  ];

  it.each(calls)('%s: signed out is refused by the session gate', async (_name, call) => {
    const { organizationId } = await makeOrg();
    const res = await call(organizationId);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(calls)('%s: off-cloud is 404', async (_name, call) => {
    const { organizationId, owner } = await makeOrg();
    delete process.env['MOTIR_CLOUD'];
    signInAs(owner);
    const res = await call(organizationId);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('BILLING_NOT_AVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(calls)('%s: a non-member of the org is 404', async (_name, call) => {
    const { organizationId } = await makeOrg();
    signInAs(await createTestUser());
    const res = await call(organizationId);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(calls)('%s: a member without manageBilling is 403', async (_name, call) => {
    const { organizationId, member } = await makeOrg();
    signInAs(member);
    const res = await call(organizationId);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('BILLING_FORBIDDEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an admin holds manageBilling too, and is answered', async () => {
    const { organizationId, admin } = await makeOrg();
    signInAs(admin);
    fetchMock.mockResolvedValueOnce(json(200, CATEGORIES));
    expect((await getCategories(organizationId)).status).toBe(200);
  });
});

describe('GET …/calculator/categories', () => {
  it('answers the engine’s body band for band — the empty band included — with no-store', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, CATEGORIES));

    const res = await getCategories(organizationId);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toStrictEqual(CATEGORIES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ENGINE}/v1/public/calculator/categories`);
    expect(init?.method).toBe('GET');
  });

  it('caches nothing — a second identical call reaches the engine again', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const retired = {
      ...CATEGORIES,
      categories: [{ key: 'band-a', models: [] }],
    } satisfies CalculatorCategoriesDTO;
    fetchMock
      .mockResolvedValueOnce(json(200, CATEGORIES))
      .mockResolvedValueOnce(json(200, retired));

    await getCategories(organizationId);
    const second = await getCategories(organizationId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await second.json()).toStrictEqual(retired);
  });

  it('the engine’s unavailable answer is 503, never a 500', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(
      problem(500, 'internal_error', 'calculator_unavailable: models_read_failed'),
    );
    const res = await getCategories(organizationId);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('CALCULATOR_UNAVAILABLE');
  });

  it('a malformed body is a boundary failure (502), not a half-drawn picker', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, { ...CATEGORIES, categories: [{ key: 'band-a' }] }));
    const res = await getCategories(organizationId);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe('MOTIR_AI_UNAVAILABLE');
  });
});

describe('POST …/calculator/estimate — the answers', () => {
  it('answers the engine’s estimate unaltered, key for key, with no-store', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, ESTIMATE));

    const res = await postEstimate(organizationId, REQUEST);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toStrictEqual(ESTIMATE);
  });

  it('sends exactly the three keys — no organization id, no quantity, no model — once', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, ESTIMATE));

    await postEstimate(organizationId, REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${ENGINE}/v1/public/calculator/estimate`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toStrictEqual(REQUEST);
  });

  it('defaults an absent cadence to the engine’s own default before sending', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, { ...ESTIMATE, cadence: 'annual' }));
    const { cadence: _omitted, ...withoutCadence } = REQUEST;

    expect((await postEstimate(organizationId, withoutCadence)).status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toStrictEqual({
      ...withoutCadence,
      cadence: 'annual',
    });
  });

  it.each([
    ['one category', ['band-a']],
    ['two categories', ['band-a', 'band-b']],
    ['three categories', ['band-a', 'band-b', 'band-c']],
  ])('%s reach the engine as exactly the two ranges, categories and cadence', async (_n, cats) => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, ESTIMATE));

    const res = await postEstimate(organizationId, { ...REQUEST, categories: cats });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual(ESTIMATE);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'cadence',
      'categories',
      'plannedPerMonth',
      'runPerMonth',
    ]);
    expect(sent['categories']).toStrictEqual(cats);
  });

  it('forwards the shares unchanged when the body carries them (MOTIR-9832)', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, ESTIMATE));
    const withShares = { ...REQUEST, shares: { 'band-a': 70, 'band-b': 30 } };

    expect((await postEstimate(organizationId, withShares)).status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toStrictEqual(withShares);
  });

  it('accepts a category key no fixture names — the set is open', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, ESTIMATE));
    const res = await postEstimate(organizationId, { ...REQUEST, categories: ['a-new-band'] });
    expect(res.status).toBe(200);
  });

  it('a recommendation naming a plan this repo does not sell crosses unchanged', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const larger = {
      ...ESTIMATE,
      recommendation: { planKey: 'pool_x', planName: 'Pool X', monthlyPriceUsd: 700 },
      ceiling: { ...ESTIMATE.ceiling, exceeded: true, excessCredits: 10, outcome: 'larger_pool' },
    };
    fetchMock.mockResolvedValueOnce(json(200, larger));
    const res = await postEstimate(organizationId, REQUEST);
    expect(await res.json()).toStrictEqual(larger);
  });

  it('a recommendation carrying its pool’s credits crosses unchanged (MOTIR-9262)', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const pooled = {
      ...ESTIMATE,
      recommendation: {
        planKey: 'pool_x',
        planName: 'Pool X',
        monthlyPriceUsd: 700,
        poolCredits: 120_000,
      },
      ceiling: { ...ESTIMATE.ceiling, exceeded: true, excessCredits: 10, outcome: 'larger_pool' },
    };
    fetchMock.mockResolvedValueOnce(json(200, pooled));
    const res = await postEstimate(organizationId, REQUEST);
    expect(await res.json()).toStrictEqual(pooled);
  });

  it('the engine’s empty_category answer is a 200, never a 4xx and never a number', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockResolvedValueOnce(json(200, EMPTY_CATEGORY));

    const res = await postEstimate(organizationId, REQUEST);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual(EMPTY_CATEGORY);
  });

  it('caches nothing — the same ask twice reaches the engine twice', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    fetchMock.mockImplementation(async () => json(200, ESTIMATE));

    await postEstimate(organizationId, REQUEST);
    await postEstimate(organizationId, REQUEST);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('POST …/calculator/estimate — a refused body never reaches the engine', () => {
  const cases: Array<[string, unknown, string]> = [
    ['no categories', { ...REQUEST, categories: undefined }, 'categories'],
    ['an empty categories list', { ...REQUEST, categories: [] }, 'categories'],
    [
      'four categories',
      { ...REQUEST, categories: ['band-a', 'band-b', 'band-c', 'band-d'] },
      'categories',
    ],
    ['a duplicate category', { ...REQUEST, categories: ['band-a', 'band-a'] }, 'categories'],
    ['a blank category key', { ...REQUEST, categories: ['band-a', '  '] }, 'categories.1'],
    ['an empty-string category key', { ...REQUEST, categories: [''] }, 'categories.0'],
    [
      'a non-integer end',
      { ...REQUEST, plannedPerMonth: { low: 1.5, high: 4 } },
      'plannedPerMonth.low',
    ],
    ['a negative end', { ...REQUEST, runPerMonth: { low: 1, high: -4 } }, 'runPerMonth.high'],
    ['a missing end', { ...REQUEST, plannedPerMonth: { low: 1 } }, 'plannedPerMonth.high'],
    ['low > high', { ...REQUEST, runPerMonth: { low: 50, high: 4 } }, 'runPerMonth.low'],
    ['a missing range', { ...REQUEST, runPerMonth: undefined }, 'runPerMonth'],
    [
      'both ranges 0–0',
      { ...REQUEST, plannedPerMonth: { low: 0, high: 0 }, runPerMonth: { low: 0, high: 0 } },
      'plannedPerMonth',
    ],
    // The single-count shape the two ranges replaced (MOTIR-9224) is refused by name.
    [
      'the replaced shape: itemsPerMonth',
      { ...REQUEST, itemsPerMonth: { low: 1, high: 4 } },
      'itemsPerMonth',
    ],
    ['a cadence outside annual | monthly', { ...REQUEST, cadence: 'weekly' }, 'cadence'],
    ['an unknown key: quantity', { ...REQUEST, quantity: 2 }, 'quantity'],
    ['an unknown key: seats', { ...REQUEST, seats: 4 }, 'seats'],
    // The replaced two-lane shape is refused by name, not tolerated.
    [
      'the replaced shape: planning',
      { ...REQUEST, planning: { category: 'band-a', modelIds: ['model-a1'] } },
      'planning',
    ],
    [
      'the replaced shape: running',
      { ...REQUEST, running: { category: 'band-b', modelIds: ['model-b1'] } },
      'running',
    ],
    ['the replaced shape: modelIds', { ...REQUEST, modelIds: ['model-a1'] }, 'modelIds'],
    // The shares hold the engine's own rules (MOTIR-9832), so a bad one is refused here.
    ['shares that are not an object', { ...REQUEST, shares: [70, 30] }, 'shares'],
    ['a share of 0', { ...REQUEST, shares: { 'band-a': 100, 'band-b': 0 } }, 'shares.band-b'],
    [
      'a fractional share',
      { ...REQUEST, shares: { 'band-a': 70.5, 'band-b': 29.5 } },
      'shares.band-a',
    ],
    [
      'a share keyed by a category not picked',
      { ...REQUEST, shares: { 'band-a': 50, 'band-b': 30, 'band-z': 20 } },
      'shares.band-z',
    ],
    ['a picked category with no share', { ...REQUEST, shares: { 'band-a': 100 } }, 'shares.band-b'],
    [
      'shares that do not total 100',
      { ...REQUEST, shares: { 'band-a': 70, 'band-b': 20 } },
      'shares',
    ],
  ];

  it.each(cases)('%s → 400 naming the field', async (_name, body, field) => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const res = await postEstimate(organizationId, body);
    expect(res.status).toBe(400);
    const out = (await res.json()) as { code: string; field?: string; error: string };
    expect(out.code).toBe('CALCULATOR_REQUEST_INVALID');
    expect(out.field).toBe(field);
    expect(typeof out.error).toBe('string');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a body that is not JSON → 400, and the engine is not asked', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const res = await postEstimate(organizationId, '{not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('CALCULATOR_REQUEST_INVALID');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST …/calculator/estimate — the engine’s refusals, kept distinct', () => {
  async function ask(response: Response | Error) {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
    const res = await postEstimate(organizationId, REQUEST);
    return { status: res.status, body: (await res.json()) as { code: string; field?: string } };
  }

  it('its unavailable answer (internal_error + calculator_unavailable:) → 503', async () => {
    const out = await ask(problem(500, 'internal_error', 'calculator_unavailable: rates_running'));
    expect(out).toMatchObject({ status: 503, body: { code: 'CALCULATOR_UNAVAILABLE' } });
  });

  it('its rate limit → the same 503: ask again', async () => {
    const out = await ask(problem(429, 'rate_limited', 'more than 60 requests a minute'));
    expect(out).toMatchObject({ status: 503, body: { code: 'CALCULATOR_UNAVAILABLE' } });
  });

  it('its own validation_error → 400 CALCULATOR_REQUEST_INVALID, never the blanket 502', async () => {
    const out = await ask(
      problem(400, 'validation_error', 'categories.0 must be one of: band-a, band-b'),
    );
    expect(out).toMatchObject({
      status: 400,
      body: { code: 'CALCULATOR_REQUEST_INVALID', field: 'categories.0' },
    });
  });

  it('a transport failure → 502, distinct from the 503', async () => {
    const out = await ask(new TypeError('fetch failed'));
    expect(out.status).toBe(502);
    expect(out.body.code).toBe('MOTIR_AI_UNAVAILABLE');
  });

  it('a 5xx WITHOUT the calculator prefix → 502', async () => {
    const out = await ask(problem(500, 'internal_error', 'something else broke'));
    expect(out.status).toBe(502);
    expect(out.body.code).not.toBe('CALCULATOR_UNAVAILABLE');
  });

  it('a malformed 200 body → 502', async () => {
    const { credits: _dropped, ...noCredits } = ESTIMATE;
    const out = await ask(json(200, noCredits));
    expect(out.status).toBe(502);
    expect(out.body.code).toBe('MOTIR_AI_UNAVAILABLE');
  });

  it('a poolCredits that is not a number → 502', async () => {
    const out = await ask(
      json(200, { ...ESTIMATE, recommendation: { ...ESTIMATE.recommendation, poolCredits: '9' } }),
    );
    expect(out.status).toBe(502);
    expect(out.body.code).toBe('MOTIR_AI_UNAVAILABLE');
  });
});

describe('billingService — the two methods directly', () => {
  it('estimateCalculator gates before it parses: a non-member with a bad body is 404, not 400', async () => {
    const { organizationId } = await makeOrg();
    const stranger = await createTestUser();
    await expect(
      billingService.estimateCalculator({
        organizationId,
        actorUserId: stranger.id,
        body: { quantity: 1 },
      }),
    ).rejects.toMatchObject({ code: 'ORGANIZATION_NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCalculatorCategories returns the engine’s body for an owner', async () => {
    const { organizationId, owner } = await makeOrg();
    fetchMock.mockResolvedValueOnce(json(200, CATEGORIES));
    await expect(
      billingService.getCalculatorCategories({ organizationId, actorUserId: owner.id }),
    ).resolves.toStrictEqual(CATEGORIES);
  });
});
