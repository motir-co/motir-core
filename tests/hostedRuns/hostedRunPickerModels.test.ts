import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapacityEntry } from '@/lib/gateway/capacityClient';
import {
  CAPACITY_FAKE_STATE_PATH_ENV_VAR,
  writeCapacityFakeStateFile,
} from '@/lib/gateway/capacityFakeState';
import {
  __resetAgentRunCapacityForTests,
  agentRunCapacityService,
} from '@/lib/services/agentRunCapacityService';
import { hostedRunPickerService } from '@/lib/services/hostedRunPickerService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { setProjectAccess } from '../helpers/projectAccess';

// THE RUN HOSTED PICKER'S READ carries the card's resolved model (Story MOTIR-6989
// · MOTIR-6996) — `hostedRunPickerService.readModels` and
// `GET /api/hosted-runs/models?workItem=<KEY>` over the real Postgres. motir-ai is
// the one HTTP seam (`fetch` stubbed with `/v1/agent-models`); the compliant-
// session gate is stubbed for the route half, handing it a REAL context.
//
// Pinned: the three wordings' inputs (a leaf's difficulty, a project override, a
// parent's highest leaf), a leaf with no difficulty resolving to the platform
// default, the answer unchanged without `workItem`, and every way the resolution
// can fail — an unknown key, a card the caller cannot browse — answering
// `resolved: null` rather than refusing the list.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { GET } = await import('@/app/api/hosted-runs/models/route');

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

/** The offered list as the picker read answers it: each model with its capacity (MOTIR-9629). */
const OFFERED_WIRE = OFFERED.models.map((m) => ({ ...m, capacity: { verdict: 'available' } }));

let modelCalls = 0;

function serveModels(body: unknown = OFFERED, status = 200) {
  modelCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      modelCalls += 1;
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  __resetAgentRunCapacityForTests();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  serveModels();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (fx: WorkItemFixture, userId = fx.ownerId): WorkspaceContext => ({
  userId,
  workspaceId: fx.workspaceId,
});

async function leaf(fx: WorkItemFixture, difficulty: 'trivial' | 'low' | 'medium' | 'high' | null) {
  const item = await createTestWorkItem(fx, { kind: 'task', title: `Leaf ${difficulty}` });
  if (difficulty) {
    await adminDb.workItem.update({ where: { id: item.id }, data: { difficulty } });
  }
  return item;
}

describe('hostedRunPickerService.readModels', () => {
  it('answers exactly the old shape — no `resolved` key — when no card is named', async () => {
    const fx = await makeWorkItemFixture();
    const read = await hostedRunPickerService.readModels(null, ctxFor(fx));
    expect(read).toEqual({ state: 'ok', models: OFFERED_WIRE, default: 'claude-opus-5-5' });
    expect(read).not.toHaveProperty('resolved');
  });

  it("resolves a Low leaf with no override to the platform's Low model", async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'low');
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(read).toMatchObject({
      state: 'ok',
      default: 'claude-opus-5-5',
      resolved: {
        model: 'claude-sonnet-5-5',
        source: 'platform_level',
        difficulty: 'low',
        fromLeaves: false,
      },
    });
    // motir-ai is asked ONCE for the list and the resolution together.
    expect(modelCalls).toBe(1);
  });

  it("resolves a High leaf to the project's override for High", async () => {
    const fx = await makeWorkItemFixture();
    await projectHostedAgentSettingsService.update(
      fx.projectIdentifier,
      { high: 'claude-opus-5' },
      ctxFor(fx),
    );
    const item = await leaf(fx, 'high');
    const read = await hostedRunPickerService.readModels(item.identifier.toLowerCase(), ctxFor(fx));
    expect(read).toMatchObject({
      resolved: { model: 'claude-opus-5', source: 'override', difficulty: 'high' },
    });
  });

  it('resolves a leaf with no difficulty to the platform default — the picker draws no line', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, null);
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(read).toMatchObject({
      resolved: { model: 'claude-opus-5-5', source: 'platform_default', difficulty: null },
    });
  });

  it('resolves a parent from the highest difficulty among its leaves', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    for (const difficulty of ['low', 'high'] as const) {
      const child = await createTestWorkItem(fx, {
        kind: 'subtask',
        title: difficulty,
        parentId: story.id,
      });
      await adminDb.workItem.update({ where: { id: child.id }, data: { difficulty } });
    }
    const read = await hostedRunPickerService.readModels(story.identifier, ctxFor(fx));
    expect(read).toMatchObject({
      resolved: {
        model: 'claude-opus-5-5',
        source: 'platform_level',
        difficulty: 'high',
        fromLeaves: true,
      },
    });
  });

  it('answers resolved: null for a key that names nothing, and still offers the list', async () => {
    const fx = await makeWorkItemFixture();
    const read = await hostedRunPickerService.readModels(
      `${fx.projectIdentifier}-9999`,
      ctxFor(fx),
    );
    expect(read).toEqual({
      state: 'ok',
      models: OFFERED_WIRE,
      default: 'claude-opus-5-5',
      resolved: null,
    });
    const noProject = await hostedRunPickerService.readModels('NOPE-1', ctxFor(fx));
    expect(noProject).toMatchObject({ state: 'ok', resolved: null });
  });

  it('answers resolved: null for a card in a project the caller cannot browse — no leak', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'high');
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { hostedModelHigh: 'claude-opus-5' },
    });
    const stranger = await createTestUser({ email: `stranger-${fx.workspaceId}@example.com` });
    await adminDb.workspaceMembership.create({
      data: { userId: stranger.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    await setProjectAccess(adminDb, fx.projectId, 'members');
    const error = vi.spyOn(console, 'error');
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx, stranger.id));
    expect(read).toMatchObject({ state: 'ok', resolved: null });
    // A refusal, not a failure: nothing is logged.
    expect(error).not.toHaveBeenCalled();
    // The positive control: the owner, who may browse it, is told.
    expect(await hostedRunPickerService.readModels(item.identifier, ctxFor(fx))).toMatchObject({
      resolved: { model: 'claude-opus-5', source: 'override' },
    });
  });

  it('degrades an UNEXPECTED resolve failure to resolved: null, and logs it', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'high');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(projectHostedAgentSettingsService, 'resolveForWorkItem').mockRejectedValueOnce(
      new Error('connection reset'),
    );
    const read = await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(read).toMatchObject({ state: 'ok', resolved: null });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('answers unavailable when motir-ai cannot answer — never a resolution without a list', async () => {
    const fx = await makeWorkItemFixture();
    const item = await leaf(fx, 'high');
    serveModels({ code: 'internal_error' }, 503);
    expect(await hostedRunPickerService.readModels(item.identifier, ctxFor(fx))).toEqual({
      state: 'unavailable',
    });
  });
});

describe('GET /api/hosted-runs/models?workItem=', () => {
  const get = (query = '') => GET(new Request(`http://localhost/api/hosted-runs/models${query}`));

  it("adds the card's resolution to the list", async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    await projectHostedAgentSettingsService.update(
      fx.projectIdentifier,
      { high: 'claude-opus-5' },
      ctxFor(fx),
    );
    const item = await leaf(fx, 'high');
    const res = await get(`?workItem=${encodeURIComponent(item.identifier)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      models: OFFERED_WIRE,
      default: 'claude-opus-5-5',
      resolved: {
        model: 'claude-opus-5',
        source: 'override',
        difficulty: 'high',
        fromLeaves: false,
      },
    });
  });

  it('answers the unchanged shape without it, or with a blank one', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    for (const query of ['', '?workItem=', '?workItem=%20']) {
      const res = await get(query);
      expect(await res.json()).toEqual({ models: OFFERED_WIRE, default: 'claude-opus-5-5' });
    }
  });

  it('answers 200 with resolved: null for an unknown card', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    const res = await get(`?workItem=${fx.projectIdentifier}-4242`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resolved: null });
  });

  it('answers 503 with the stable code when motir-ai is unavailable, card or not', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    serveModels({ code: 'internal_error' }, 503);
    const res = await get(`?workItem=${fx.projectIdentifier}-1`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'hosted_models_unavailable' });
  });
});

// ── CAPACITY ON EACH MODEL (Story MOTIR-9541 · MOTIR-9629) ──────────────────
// The verdict is driven through the capacity client's FILE-BACKED FAKE (MOTIR-9608 ·
// MOTIR-9617) — the real binding, the real verdict service and the real rule — so a
// test names the entries it expects a verdict from.

const LIMITS = {
  max_concurrency: { status: 'unknown' as const },
  rpm: { status: 'unknown' as const },
  input_tpm: { status: 'unknown' as const },
  output_tpm: { status: 'unknown' as const },
  tpm: { status: 'unknown' as const },
  tpd: { status: 'unknown' as const },
};

/** A claude entry; distinctive numbers so a leak into the body would be visible. */
function claude(model: string, over: Partial<CapacityEntry> = {}): CapacityEntry {
  const lane = {
    inFlight: 7,
    requestsPerMinute: 4321,
    tokensPerMinute: 987_654,
    tokensPerDay: 13_579_246,
    rateLimited429: { minute: 0, day: 0 },
  };
  return {
    provider: 'claude',
    model,
    tierNote: 'secret-tier-note',
    unknownNote: '',
    planningSharePercent: 50,
    limits: LIMITS,
    lanes: { planning: lane, agent: lane },
    providerHint: null,
    ...over,
  };
}

let fakeDir: string | null = null;

function serveCapacity(entries: CapacityEntry[], mode: 'live' | 'unreachable' = 'live'): void {
  fakeDir = mkdtempSync(join(tmpdir(), 'capacity-'));
  const path = join(fakeDir, 'state.json');
  writeCapacityFakeStateFile(path, { mode, scope: 'shared', entries });
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
  vi.stubEnv(CAPACITY_FAKE_STATE_PATH_ENV_VAR, path);
}

afterEach(() => {
  if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
  fakeDir = null;
});

const SHARE_FULL = claude('claude-opus-5', {
  limits: { ...LIMITS, max_concurrency: { status: 'set', value: 14 } },
});
const RATE_LIMITED = (model: string) =>
  claude(model, {
    lanes: {
      planning: null,
      agent: {
        inFlight: 1,
        requestsPerMinute: 1,
        tokensPerMinute: 1,
        tokensPerDay: 1,
        rateLimited429: { minute: 3, day: 3 },
      },
    },
  });

function expectClosedShape(models: unknown[]): void {
  for (const m of models as Array<{ capacity: object }>) {
    expect(Object.keys(m).sort()).toEqual(['capacity', 'id', 'provider']);
    expect(Object.keys(m.capacity).length).toBeGreaterThanOrEqual(1);
    expect(['verdict', 'reason']).toEqual(expect.arrayContaining(Object.keys(m.capacity)));
  }
}

describe('capacity on each offered model', () => {
  it('a model whose agent share is used reads no_capacity / agent_share_exhausted; the rest available', async () => {
    const fx = await makeWorkItemFixture();
    serveCapacity([SHARE_FULL]);
    const read = await hostedRunPickerService.readModels(null, ctxFor(fx));
    expect(read).toEqual({
      state: 'ok',
      default: 'claude-opus-5-5',
      models: [
        {
          id: 'claude-opus-5',
          provider: 'anthropic',
          capacity: { verdict: 'no_capacity', reason: 'agent_share_exhausted' },
        },
        { id: 'claude-opus-5-5', provider: 'anthropic', capacity: { verdict: 'available' } },
        { id: 'claude-sonnet-5-5', provider: 'anthropic', capacity: { verdict: 'available' } },
      ],
    });
  });

  it('the same for provider_rate_limited', async () => {
    const fx = await makeWorkItemFixture();
    serveCapacity([RATE_LIMITED('claude-sonnet-5-5')]);
    const read = await hostedRunPickerService.readModels(null, ctxFor(fx));
    expect(read.state === 'ok' && read.models.map((m) => m.capacity)).toEqual([
      { verdict: 'available' },
      { verdict: 'available' },
      { verdict: 'no_capacity', reason: 'provider_rate_limited' },
    ]);
  });

  it('one readModels makes one verdictsFor call over every offered model', async () => {
    const fx = await makeWorkItemFixture();
    const spy = vi.spyOn(agentRunCapacityService, 'verdictsFor');
    const item = await leaf(fx, 'low');
    await hostedRunPickerService.readModels(item.identifier, ctxFor(fx));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].map((m) => m.id)).toEqual(OFFERED.models.map((m) => m.id));
  });

  it('a capacity read that cannot be made reads every model available', async () => {
    const fx = await makeWorkItemFixture();
    serveCapacity([SHARE_FULL], 'unreachable');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await hostedRunPickerService.readModels(null, ctxFor(fx));
    expect(read).toEqual({ state: 'ok', default: 'claude-opus-5-5', models: OFFERED_WIRE });
  });

  it('motir-ai unavailable: unavailable as today, and the verdict is never asked', async () => {
    const fx = await makeWorkItemFixture();
    serveModels({ code: 'internal_error' }, 503);
    const spy = vi.spyOn(agentRunCapacityService, 'verdictsFor');
    expect(await hostedRunPickerService.readModels(null, ctxFor(fx))).toEqual({
      state: 'unavailable',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('GET /api/hosted-runs/models — capacity', () => {
  const get = (query = '') => GET(new Request(`http://localhost/api/hosted-runs/models${query}`));

  it('carries capacity beside resolved, in a closed shape, with nothing of the read leaking', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    serveCapacity([SHARE_FULL, RATE_LIMITED('claude-sonnet-5-5')]);
    const item = await leaf(fx, 'high');

    const res = await get(`?workItem=${encodeURIComponent(item.identifier)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const text = await res.clone().text();
    const body = (await res.json()) as { models: unknown[]; resolved: unknown };
    expect(body.resolved).toMatchObject({ model: 'claude-opus-5-5', difficulty: 'high' });
    expectClosedShape(body.models);
    expect(body.models.map((m) => (m as { capacity: unknown }).capacity)).toEqual([
      { verdict: 'no_capacity', reason: 'agent_share_exhausted' },
      { verdict: 'available' },
      { verdict: 'no_capacity', reason: 'provider_rate_limited' },
    ]);
    for (const leak of ['4321', '987654', '13579246', 'secret-tier-note', '"14"', ':14']) {
      expect(text).not.toContain(leak);
    }
    for (const id of [fx.workspaceId, fx.projectId, fx.ownerId]) expect(text).not.toContain(id);
  });

  it('a verdict read that rejects still answers 200, every model available, with one error logged', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    vi.spyOn(agentRunCapacityService, 'verdictsFor').mockRejectedValueOnce(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: OFFERED_WIRE, default: 'claude-opus-5-5' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('capacity verdict failed');
  });

  it('a capacity client answering not_configured: 200 with every model available', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '');
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: OFFERED_WIRE, default: 'claude-opus-5-5' });
  });

  it('motir-ai unavailable: the same 503 body as today, and no verdict asked', async () => {
    const fx = await makeWorkItemFixture();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: ctxFor(fx) });
    serveModels({ code: 'internal_error' }, 503);
    const spy = vi.spyOn(agentRunCapacityService, 'verdictsFor');
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'hosted_models_unavailable' });
    expect(spy).not.toHaveBeenCalled();
  });
});
