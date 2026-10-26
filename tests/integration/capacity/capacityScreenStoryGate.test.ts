import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense, type ReactElement } from 'react';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import type { PlatformRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { GATEWAY_CAPACITY_TIMEOUT_MS } from '@/lib/gateway/capacityClient';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  CAPACITY_GATEWAY,
  jsonResponse,
  refusalResponse,
  storedRowBody,
} from '../../fixtures/gatewayCapacityWire';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { findFirst, textOf } from '../../helpers/serverPageHarness';

/**
 * STORY GATE — Story MOTIR-9539 · MOTIR-9615. The provider capacity screen held
 * together: the page, its poll route and its two Server Actions over
 * `platformCapacityService`, the alert evaluation, the scheduled pass and the
 * real Postgres. Each card shipped its own unit tests; this suite is the one that
 * would catch the seams between them — a tenant reaching the numbers, a screen
 * load and the job alerting twice, an edit that writes more than it was given.
 *
 * ⚠️ THE GATEWAY IS A `fetch` STUB AT ITS URL, under the REAL capacity client:
 * every read and write crosses the wire contract, so the parsing, the timeout and
 * the refusal mapping run for real. Beside it only the session (vitest has no
 * cookies), `next/cache`, `next/navigation`, `next-intl/server` and the Sentry
 * seam are stubbed.
 */

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
}));
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const SENTINEL = 'sentinel-capacity-token-9615-gate';
const PRIVATE_KEYS = /"(userId|updatedByUserId|email|workspaceId|organizationId|orgId)"/;

// ── the wire ──────────────────────────────────────────────────────────────────

const NA = { value: null, status: 'not_applicable' };
const UNKNOWN = { value: null, status: 'unknown' };
const set = (value: number) => ({ value, status: 'set' });

interface LaneFigures {
  in_flight?: number;
  requests_per_minute?: number;
  tokens_per_minute?: number;
  tokens_per_day?: number;
}

function lane(figures: LaneFigures = {}) {
  return {
    in_flight: 0,
    requests_per_minute: 0,
    tokens_per_minute: 0,
    tokens_per_day: 0,
    rate_limited_429: { minute: 0, day: 1 },
    ...figures,
  };
}

/** The usage split 1 : 3 planning : agent, so a total is what the share reads. */
function lanes(figures: LaneFigures) {
  const planning: LaneFigures = {};
  const agent: LaneFigures = {};
  for (const [key, total] of Object.entries(figures) as [keyof LaneFigures, number][]) {
    planning[key] = Math.floor(total / 4);
    agent[key] = total - Math.floor(total / 4);
  }
  return { planning: lane(planning), agent: lane(agent) };
}

interface ReadShape {
  /** Second of the minute the gateway stamped the read at. */
  second?: number;
  qwenRpm?: number;
  qwenTpm?: number;
  deepseekInFlight?: number;
  store?: 'live' | 'unavailable';
}

/** A §9 read: Claude (two token rows not reported, tpd unknown), Qwen and DeepSeek. */
function readBody({
  second = 45,
  qwenRpm = 60,
  qwenTpm = 1000,
  deepseekInFlight = 10,
  store = 'live',
}: ReadShape = {}) {
  const live = store === 'live';
  return {
    success: true,
    read_at: `2026-10-25T12:00:${String(second).padStart(2, '0')}Z`,
    counter_store: { state: store, scope: 'shared' },
    entries: [
      {
        provider: 'claude',
        model: 'claude-example-1',
        tier_note: 'Example tier 4',
        unknown_note: 'tpd: not published',
        planning_share_percent: 50,
        limits: {
          max_concurrency: NA,
          rpm: set(1000),
          input_tpm: set(200000),
          output_tpm: set(40000),
          tpm: NA,
          tpd: UNKNOWN,
        },
        lanes: live ? lanes({ requests_per_minute: 40 }) : { planning: null, agent: null },
        provider_hint: null,
      },
      {
        provider: 'qwen',
        model: 'qwen-example-1',
        tier_note: 'Tier 3',
        unknown_note: 'tpm: not published for this tier',
        planning_share_percent: 40,
        limits: {
          max_concurrency: NA,
          rpm: set(600),
          input_tpm: NA,
          output_tpm: NA,
          tpm: UNKNOWN,
          tpd: NA,
        },
        lanes: live
          ? lanes({ requests_per_minute: qwenRpm, tokens_per_minute: qwenTpm })
          : { planning: null, agent: null },
        provider_hint: null,
      },
      {
        provider: 'deepseek',
        model: 'deepseek-example-1',
        tier_note: 'Pay as you go',
        unknown_note: '',
        planning_share_percent: 30,
        limits: {
          max_concurrency: set(100),
          rpm: NA,
          input_tpm: NA,
          output_tpm: NA,
          tpm: NA,
          tpd: NA,
        },
        lanes: live ? lanes({ in_flight: deepseekInFlight }) : { planning: null, agent: null },
        provider_hint: null,
      },
    ],
  };
}

/** The gateway at `CAPACITY_GATEWAY`: what it answers next, and what it was sent. */
const gateway = {
  read: (): Promise<Response> => Promise.resolve(jsonResponse(readBody())),
  write: (): Promise<Response> => Promise.resolve(jsonResponse(storedRowBody())),
  reads: 0,
  writes: [] as { url: string; body: unknown; auth: string | null }[],
};

function answerReads(shape: ReadShape) {
  gateway.read = () => Promise.resolve(jsonResponse(readBody(shape)));
}

const fetchStub = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (!url.startsWith(`${CAPACITY_GATEWAY}/api/motir/capacity`)) {
    throw new Error(`unexpected fetch ${url}`);
  }
  if ((init.method ?? 'GET') === 'GET') {
    gateway.reads++;
    return gateway.read();
  }
  gateway.writes.push({
    url,
    body: JSON.parse(String(init.body)),
    auth: new Headers(init.headers).get('authorization'),
  });
  return gateway.write();
});

// ── the people ────────────────────────────────────────────────────────────────

type Who = PlatformRole | 'tenant user' | 'workspace owner' | 'org owner' | 'anonymous';

let seq = 0;
async function signInAs(who: Who) {
  const user = await createTestUser({ email: `capacity-gate-${++seq}@example.com` });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  if (who === 'support' || who === 'operator' || who === 'superadmin') {
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole: who } });
  }
  if (who === 'workspace owner') {
    await workspacesService.createWorkspace({ name: `Northwind ${seq}`, ownerUserId: user.id });
  }
  if (who === 'org owner') {
    // The owner of an ORGANIZATION that holds no workspace of theirs.
    const org = await adminDb.organization.create({
      data: { name: `Contoso ${seq}`, slug: `contoso-capacity-${seq}` },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: org.id, userId: user.id, role: 'owner' },
    });
  }
  if (who === 'anonymous') currentSession = null;
  return { userId: user.id, email: user.email, role: 'support' as PlatformRole };
}

/** A fresh module graph per case: `requirePlatformStaff` is React-`cache()`d. */
async function fresh() {
  const { GET } = await import('@/app/api/platform/capacity/route');
  const { default: CapacityPage } = await import('@/app/(admin)/admin/capacity/page');
  const actions = await import('@/app/(admin)/admin/capacity/actions');
  const { platformCapacityService } = await import('@/lib/services/platformCapacityService');
  const { capacityAlertEvaluation } =
    await import('@/lib/jobs/definitions/capacityAlertEvaluation');
  const { JobTestEngine } = await import('../../helpers/jobs');
  return {
    service: platformCapacityService,
    actions,
    CapacityPage,
    async route() {
      const res = await GET();
      return { res, body: (await res.json()) as Record<string, unknown> };
    },
    /** One scheduled pass, as the worker runs it (its sleep is the harness's no-op). */
    async jobPass() {
      const outcome = await new JobTestEngine({ function: capacityAlertEvaluation }).execute();
      if (outcome.error) throw outcome.error;
      return outcome.result;
    },
  };
}

const raisedRows = () =>
  adminDb.capacityRaisedAlert.findMany({ orderBy: [{ provider: 'asc' }, { limitUnit: 'asc' }] });
const auditRows = (action: string) => adminDb.platformAuditLog.findMany({ where: { action } });

type View = Awaited<
  ReturnType<
    (typeof import('@/lib/services/platformCapacityService'))['platformCapacityService']['getView']
  >
>;

function rowOf(view: View, provider: string, unit: string) {
  if (view.capacity.outcome !== 'answered') throw new Error('expected an answered read');
  const entry = view.capacity.entries.find((e) => e.provider === provider)!;
  return entry.limits.find((r) => r.unit === unit)!;
}

// The first `fresh()` transforms the page, the actions and the job's whole graph;
// under coverage that alone can outrun a case's timeout, so it is paid here once.
beforeAll(async () => {
  await fresh();
}, 120_000);

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
  vi.stubEnv('MOTIR_GATEWAY_URL', CAPACITY_GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', SENTINEL);
  vi.stubGlobal('fetch', fetchStub);
  answerReads({});
  gateway.write = () => Promise.resolve(jsonResponse(storedRowBody()));
  gateway.reads = 0;
  gateway.writes = [];
  fetchStub.mockClear();
  captureException.mockReset();
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await adminDb.capacityRaisedAlert.deleteMany();
  await adminDb.capacityAlertSetting.deleteMany();
  await truncateAuthTables();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await adminDb.capacityRaisedAlert.deleteMany();
  await adminDb.capacityAlertSetting.deleteMany();
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── who reaches it ────────────────────────────────────────────────────────────

describe('who reaches the screen', () => {
  it.each(['tenant user', 'workspace owner', 'org owner', 'anonymous'] as const)(
    'a %s gets the not-found from the route and the page, and the gateway is never asked',
    async (who) => {
      await signInAs(who);
      const { route, CapacityPage } = await fresh();
      const { res, body } = await route();
      expect(res.status).toBe(404);
      for (const key of ['capacity', 'entries', 'alertShare', 'raised', 'canEdit']) {
        expect(body).not.toHaveProperty(key);
      }
      await expect(CapacityPage()).rejects.toBeInstanceOf(NotFoundSentinel);
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it.each(['tenant user', 'workspace owner', 'org owner', 'anonymous', 'support'] as const)(
    "a %s's writes are refused with no PUT, no audit row and the share unchanged",
    async (who) => {
      await signInAs(who);
      const { actions } = await fresh();
      expect(
        await actions.editCapacityLimitsAction('qwen', 'qwen-example-1', { rpm: 900 }),
      ).toEqual({ ok: false, code: 'NOT_PERMITTED' });
      expect(await actions.setCapacityAlertShareAction(90)).toEqual({
        ok: false,
        code: 'NOT_PERMITTED',
      });
      expect(gateway.writes).toEqual([]);
      expect(await adminDb.platformAuditLog.count()).toBe(0);
      expect(await adminDb.capacityAlertSetting.count()).toBe(0);
    },
  );

  it.each(['support', 'operator', 'superadmin'] as const)(
    '%s staff open the page and the route answers the view',
    async (role) => {
      await signInAs(role);
      const { route, CapacityPage } = await fresh();
      // The page's header paints at once; the read waits under its Suspense, whose
      // fallback is the skeleton and whose child seeds the screen with the view.
      const tree = await CapacityPage();
      expect(textOf(tree)).toContain(en.platformAdmin.capacity.title);
      type Async = ReactElement<Record<string, unknown>> & {
        type: (props: Record<string, unknown>) => Promise<ReactElement<Record<string, unknown>>>;
      };
      const boundary = findFirst<{ fallback: Async; children: Async }>(tree, Suspense)!;
      const skeleton = await boundary.props.fallback.type(boundary.props.fallback.props);
      expect(skeleton.props).toMatchObject({
        'aria-busy': 'true',
        'aria-label': en.platformAdmin.capacity.loading,
      });
      const screen = await boundary.props.children.type(boundary.props.children.props);
      expect(screen.props).toMatchObject({
        refreshMs: 15_000,
        initialView: { canEdit: role !== 'support', capacity: { outcome: 'answered' } },
      });
      const { res, body } = await route();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(body).toMatchObject({ canEdit: role !== 'support' });
    },
  );
});

// ── what the rows say ─────────────────────────────────────────────────────────

describe('the rows', () => {
  it('near (75%) and over (85%) read their states, and only the over one alerts — once', async () => {
    answerReads({ qwenRpm: 510, deepseekInFlight: 75 });
    const principal = await signInAs('support');
    const { service } = await fresh();
    const view = await service.getView(principal);
    expect(rowOf(view, 'qwen', 'rpm')).toMatchObject({ state: 'over_share', sharePercent: 85 });
    expect(rowOf(view, 'deepseek', 'max_concurrency')).toMatchObject({
      state: 'near_limit',
      sharePercent: 75,
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![1]).toMatchObject({
      fingerprint: ['capacity-limit-share', 'qwen', 'qwen-example-1', 'rpm'],
    });
    expect(view.raised).toEqual([
      expect.objectContaining({ provider: 'qwen', unit: 'rpm', observedValue: 510 }),
    ]);
  });

  it('a row with no number reads its reason, never 0', async () => {
    const principal = await signInAs('support');
    const { service } = await fresh();
    const view = await service.getView(principal);
    expect(rowOf(view, 'claude', 'tpm')).toMatchObject({
      state: 'not_applicable',
      usage: null,
      sharePercent: null,
    });
    expect(rowOf(view, 'qwen', 'tpm')).toMatchObject({
      state: 'unknown_limit',
      limit: { status: 'unknown' },
      sharePercent: null,
    });
    for (const unit of ['input_tpm', 'output_tpm']) {
      expect(rowOf(view, 'claude', unit)).toMatchObject({
        state: 'usage_not_reported',
        usage: null,
        sharePercent: null,
      });
    }
    expect(JSON.stringify(view)).not.toMatch(/"value":null/);
  });
});

// ── a degraded or failed read ─────────────────────────────────────────────────

describe('a degraded or failed read', () => {
  it('the store going down after a raise keeps the read answered, every row unavailable and the alert raised', async () => {
    answerReads({ qwenRpm: 510 });
    const principal = await signInAs('support');
    const { service } = await fresh();
    await service.getView(principal);
    expect(await raisedRows()).toHaveLength(1);

    answerReads({ store: 'unavailable' });
    const view = await service.getView(principal);
    if (view.capacity.outcome !== 'answered') throw new Error('expected an answered read');
    expect(view.capacity.counterStore.state).toBe('unavailable');
    for (const entry of view.capacity.entries) {
      for (const row of entry.limits) {
        expect(row).toMatchObject({ state: 'unavailable', usage: null, sharePercent: null });
      }
    }
    expect(view.raised).toEqual([expect.objectContaining({ provider: 'qwen', unit: 'rpm' })]);
    expect(await raisedRows()).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 502', () => Promise.resolve(new Response('bad gateway', { status: 502 }))],
  ])('%s reads as unreachable', async (_label, answer) => {
    gateway.read = answer;
    const principal = await signInAs('support');
    const { service } = await fresh();
    const view = await service.getView(principal);
    expect(view.capacity).toEqual({ outcome: 'unavailable', reason: 'unreachable' });
    expect(view.alertShare).toEqual({ percent: 80, isDefault: true });
  });

  it('a read past the deadline reads as unreachable', async () => {
    let called: () => void = () => {};
    const asked = new Promise<void>((resolve) => (called = resolve));
    gateway.read = () => {
      const signal = fetchStub.mock.lastCall![1]!.signal!;
      called();
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    };
    const principal = await signInAs('support');
    const { service } = await fresh();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = service.getView(principal);
    await asked;
    await vi.advanceTimersByTimeAsync(GATEWAY_CAPACITY_TIMEOUT_MS);
    vi.useRealTimers();
    expect((await pending).capacity).toEqual({ outcome: 'unavailable', reason: 'unreachable' });
  });

  it.each([
    ['a 401 capacity_auth_invalid', () => vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', SENTINEL)],
    ['an unset token', () => vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '')],
  ])('%s reads as the credential panel', async (_label, arrange) => {
    arrange();
    gateway.read = () => Promise.resolve(refusalResponse(401, 'capacity_auth_invalid'));
    const principal = await signInAs('support');
    const { service } = await fresh();
    const view = await service.getView(principal);
    expect(view.capacity).toEqual({ outcome: 'unavailable', reason: 'credential' });
  });
});

// ── the edit ──────────────────────────────────────────────────────────────────

describe('the limit edit', () => {
  it('round-trips: exactly the changed keys on the wire, the stored row back, one audit row', async () => {
    await signInAs('operator');
    const { actions } = await fresh();
    const result = await actions.editCapacityLimitsAction('qwen', 'qwen-example-1', {
      tpm: 800000,
      tierNote: 'Tier 3',
    });
    expect(result).toMatchObject({ ok: true, entry: { provider: 'qwen', tierNote: 'Tier 3' } });
    expect(gateway.writes).toHaveLength(1);
    expect(gateway.writes[0]!.url).toBe(
      `${CAPACITY_GATEWAY}/api/motir/capacity/limits/qwen/qwen-example-1`,
    );
    expect(JSON.stringify(gateway.writes[0]!.body)).toBe('{"tpm":800000,"tier_note":"Tier 3"}');
    expect(gateway.writes[0]!.auth).toBe(`Bearer ${SENTINEL}`);
    const rows = await auditRows('capacity.limits.edit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetId: 'qwen/qwen-example-1',
      metadata: { keys: { tpm: 800000, tier_note: 'Tier 3' } },
    });
  });

  it('refuses a negative limit in core: the field named, no PUT, no audit row', async () => {
    await signInAs('operator');
    const { actions } = await fresh();
    expect(await actions.editCapacityLimitsAction('qwen', 'qwen-example-1', { rpm: -1 })).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      field: 'rpm',
    });
    expect(gateway.writes).toEqual([]);
    expect(await auditRows('capacity.limits.edit')).toHaveLength(0);
  });

  it.each([
    [
      400,
      'capacity_invalid_value',
      'planning_share_percent',
      { ok: false, code: 'INVALID_VALUE', field: 'planning_share_percent' },
    ],
    [404, 'capacity_unknown_model', undefined, { ok: false, code: 'UNKNOWN_MODEL' }],
  ])(
    "passes the gateway's %i %s refusal through, with no audit row",
    async (status, code, field, expected) => {
      gateway.write = () => Promise.resolve(refusalResponse(status, code, field));
      await signInAs('operator');
      const { actions } = await fresh();
      expect(
        await actions.editCapacityLimitsAction('qwen', 'qwen-example-1', {
          planningSharePercent: 45,
        }),
      ).toEqual(expected);
      expect(gateway.writes).toHaveLength(1);
      expect(await auditRows('capacity.limits.edit')).toHaveLength(0);
    },
  );
});

describe('a refused or failed write reaches the screen as a closed code', () => {
  it.each([
    ['an unset token', 'CREDENTIAL', () => vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '')],
    [
      "the gateway's 401",
      'CREDENTIAL',
      () => (gateway.write = () => Promise.resolve(refusalResponse(401, 'capacity_auth_invalid'))),
    ],
    [
      'an unreachable gateway',
      'UNAVAILABLE',
      () => (gateway.write = () => Promise.reject(new TypeError('fetch failed'))),
    ],
    [
      "the gateway's 500",
      'STORE_ERROR',
      () => (gateway.write = () => Promise.resolve(refusalResponse(500, 'capacity_store_error'))),
    ],
  ])('%s answers %s, with no audit row', async (_label, code, arrange) => {
    arrange();
    await signInAs('operator');
    const { actions } = await fresh();
    expect(await actions.editCapacityLimitsAction('qwen', 'qwen-example-1', { rpm: 900 })).toEqual({
      ok: false,
      code,
    });
    expect(await auditRows('capacity.limits.edit')).toHaveLength(0);
  });

  it.each([
    [0, 'INVALID_VALUE'],
    [80, 'UNCHANGED'],
  ])('an alert share of %i answers %s and stores nothing', async (percent, code) => {
    await signInAs('operator');
    const { actions } = await fresh();
    expect(await actions.setCapacityAlertShareAction(percent)).toEqual({ ok: false, code });
    expect(await adminDb.capacityAlertSetting.count()).toBe(0);
    expect(await auditRows('capacity.alert_share.set')).toHaveLength(0);
  });
});

// ── the screen and the job, together ──────────────────────────────────────────

describe('the screen and the scheduled pass', () => {
  it('a job pass at :45 and three screen loads alert once', async () => {
    answerReads({ qwenRpm: 510 });
    const principal = await signInAs('support');
    const { service, jobPass } = await fresh();
    expect(await jobPass()).toMatchObject({ outcome: 'evaluated', overShareCount: 1 });
    for (let i = 0; i < 3; i++) await service.getView(principal);
    expect(await raisedRows()).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a job pass and a screen load racing raise one row and one alert', async () => {
    answerReads({ qwenRpm: 510 });
    const principal = await signInAs('support');
    const { service, jobPass } = await fresh();
    await Promise.all([jobPass(), service.getView(principal)]);
    expect(await raisedRows()).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('an rpm alert survives a read at second 10 and the :45 pass clears it, silently', async () => {
    answerReads({ qwenRpm: 510 });
    const principal = await signInAs('support');
    const { service, jobPass } = await fresh();
    await jobPass();
    expect(await raisedRows()).toHaveLength(1);

    answerReads({ second: 10, qwenRpm: 30 });
    const early = await service.getView(principal);
    expect(rowOf(early, 'qwen', 'rpm').state).toBe('normal');
    expect(early.raised).toHaveLength(1);
    expect(await raisedRows()).toHaveLength(1);

    answerReads({ second: 45, qwenRpm: 30 });
    expect(await jobPass()).toMatchObject({ outcome: 'evaluated', raisedCount: 0 });
    expect(await raisedRows()).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('a max_concurrency alert is cleared by a screen load at any second', async () => {
    answerReads({ deepseekInFlight: 90 });
    const principal = await signInAs('support');
    const { service, jobPass } = await fresh();
    await jobPass();
    expect(await raisedRows()).toEqual([
      expect.objectContaining({ provider: 'deepseek', limitUnit: 'max_concurrency' }),
    ]);

    answerReads({ second: 5, deepseekInFlight: 10 });
    const view = await service.getView(principal);
    expect(view.raised).toEqual([]);
    expect(await raisedRows()).toEqual([]);
  });

  it('raising the share 80 → 90 makes an 85% limit near and clears its alert', async () => {
    answerReads({ qwenRpm: 510 });
    const principal = await signInAs('operator');
    const { service, actions } = await fresh();
    await service.getView(principal);
    expect(await raisedRows()).toHaveLength(1);

    expect(await actions.setCapacityAlertShareAction(90)).toEqual({
      ok: true,
      alertShare: { percent: 90, isDefault: false },
    });
    const view = await service.getView(principal);
    expect(view.alertShare).toEqual({ percent: 90, isDefault: false });
    expect(rowOf(view, 'qwen', 'rpm')).toMatchObject({ state: 'near_limit', sharePercent: 85 });
    expect(view.raised).toEqual([]);
    expect(await raisedRows()).toEqual([]);
    expect(await auditRows('capacity.alert_share.set')).toHaveLength(1);
  });
});

// ── privacy ───────────────────────────────────────────────────────────────────

describe('privacy', () => {
  it('no route body, view, action result or job output carries the token, the principal or an identifier key', async () => {
    answerReads({ qwenRpm: 510 });
    const principal = await signInAs('superadmin');
    const { service, actions, route, jobPass } = await fresh();
    const outputs = [
      (await route()).body,
      await service.getView(principal),
      await actions.editCapacityLimitsAction('qwen', 'qwen-example-1', { tierNote: 'Tier 4' }),
      await actions.setCapacityAlertShareAction(90),
      await jobPass(),
      (await route()).body,
    ];
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(principal.userId);
    expect(text).not.toContain(principal.email);
    expect(text).not.toMatch(PRIVATE_KEYS);
  });
});
