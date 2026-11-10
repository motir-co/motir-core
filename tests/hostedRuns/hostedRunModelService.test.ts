import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentModels } from '@/lib/ai/motirAiClient';
import { hostedRunModelService, toOpenCodeModel } from '@/lib/services/hostedRunModelService';
import { HostedModelNotOfferedError, HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { adminDb } from '../helpers/adminDb';

// THE MODELS A HOSTED RUN MAY USE (MOTIR-6483; `docs/decisions/hosted-agent-run.md`
// §7), over the real client with only `fetch` stubbed — the HTTP seam to motir-ai.
//
// Pinned: motir-ai's list and default arrive UNCHANGED; every failure (network,
// timeout, 5xx, a non-2xx, a body that is not a list, an unconfigured client) is
// `unavailable` and NEVER an empty list; `assertOffered` refuses an absent id and
// an unanswered question with two DIFFERENT errors; and the prefix is added once.

const LIST = {
  models: [
    { id: 'claude-opus-5-5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-6', provider: 'anthropic' },
  ],
  default: 'claude-opus-5-5',
};

/** What a motir-ai that predates MOTIR-6990 is read as: every level null. */
const NO_LEVELS = { trivial: null, low: null, medium: null, high: null };
/** A motir-ai that predates MOTIR-10840 sends neither role default: both read as null. */
const NO_ROLES = { reviewAgentDefault: null, designRunDefault: null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Leave the run-model list uninitialised — it narrows nothing (MOTIR-7526). */
async function clearRunModelList() {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "platform_run_model", "platform_run_model_list" CASCADE',
  );
}

/** Initialise the run-model list holding exactly `models`. */
async function listRunModels(models: string[]) {
  await adminDb.platformRunModelList.create({ data: { id: 'platform' } });
  await adminDb.platformRunModel.createMany({ data: models.map((model) => ({ model })) });
}

beforeEach(async () => {
  await clearRunModelList();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await clearRunModelList();
  await adminDb.$disconnect();
});

describe('getAgentModels (the client read)', () => {
  it('GETs /v1/agent-models with the service credential', async () => {
    const fetchMock = vi.fn(async () => json(LIST));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAgentModels()).toEqual({
      state: 'ok',
      ...LIST,
      defaultsByDifficulty: NO_LEVELS,
      ...NO_ROLES,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ai.test/v1/agent-models');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
  });

  it('carries a null default through as null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ models: LIST.models, default: null })),
    );
    expect(await getAgentModels()).toEqual({
      state: 'ok',
      models: LIST.models,
      default: null,
      defaultsByDifficulty: NO_LEVELS,
      ...NO_ROLES,
    });
  });

  it('carries defaultsByDifficulty through, a null level as null (MOTIR-6993)', async () => {
    const defaultsByDifficulty = {
      trivial: 'claude-sonnet-4-6',
      low: 'claude-sonnet-4-6',
      medium: 'claude-opus-5-5',
      high: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...LIST, defaultsByDifficulty })),
    );
    expect(await getAgentModels()).toEqual({
      state: 'ok',
      ...LIST,
      defaultsByDifficulty,
      ...NO_ROLES,
    });
  });

  it('reads a defaultsByDifficulty with a level missing as that level null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ ...LIST, defaultsByDifficulty: { high: 'claude-opus-5-5' } })),
    );
    const read = await getAgentModels();
    expect(read.state === 'ok' && read.defaultsByDifficulty).toEqual({
      ...NO_LEVELS,
      high: 'claude-opus-5-5',
    });
  });

  it('carries the review-agent and design-run defaults through, a null as null (MOTIR-10843)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ ...LIST, reviewAgentDefault: 'claude-opus-5-5', designRunDefault: null }),
      ),
    );
    expect(await getAgentModels()).toMatchObject({
      state: 'ok',
      reviewAgentDefault: 'claude-opus-5-5',
      designRunDefault: null,
    });
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 5xx', async () => json({ code: 'internal_error' }, 503)],
    ['a 404 from a motir-ai that does not serve the route', async () => json({}, 404)],
    ['a 2xx whose body is not a list', async () => json({ models: 'nope' })],
    [
      'a 2xx whose model rows are malformed',
      async () => json({ models: [{ id: 3 }], default: null }),
    ],
    [
      'a 2xx whose defaultsByDifficulty is not an object',
      async () => json({ ...LIST, defaultsByDifficulty: 'opus' }),
    ],
    [
      'a 2xx whose defaultsByDifficulty level is not a string',
      async () => json({ ...LIST, defaultsByDifficulty: { low: 7 } }),
    ],
    [
      'a 2xx whose reviewAgentDefault is not a string',
      async () => json({ ...LIST, reviewAgentDefault: 7 }),
    ],
    [
      'a 2xx whose designRunDefault is not a string',
      async () => json({ ...LIST, designRunDefault: { id: 'x' } }),
    ],
    ['a 2xx that is not JSON', async () => new Response('<html>', { status: 200 })],
  ])('answers unavailable — never an empty list — on %s', async (_name, impl) => {
    vi.stubGlobal('fetch', vi.fn(impl));
    const read = await getAgentModels();
    expect(read.state).toBe('unavailable');
    expect(read).not.toHaveProperty('models');
  });

  it('answers unavailable on a timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        ),
      );
      const pending = getAgentModels();
      await vi.advanceTimersByTimeAsync(31_000);
      const read = await pending;
      expect(read.state).toBe('unavailable');
      expect(read.state === 'unavailable' && read.reason).toMatch(/did not respond/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers unavailable when the client is not configured', async () => {
    vi.stubEnv('MOTIR_AI_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await getAgentModels()).state).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hostedRunModelService.listOfferedModels', () => {
  it("returns motir-ai's models and default unchanged", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    expect(await hostedRunModelService.listOfferedModels()).toEqual({
      state: 'ok',
      models: LIST.models,
      default: LIST.default,
      defaultsByDifficulty: NO_LEVELS,
      ...NO_ROLES,
    });
  });

  it('returns { state: unavailable } — not an empty list — when motir-ai cannot answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 500)),
    );
    expect(await hostedRunModelService.listOfferedModels()).toEqual({ state: 'unavailable' });
  });

  it('asks motir-ai on every call — there is no cache', async () => {
    const fetchMock = vi.fn(async () => json(LIST));
    vi.stubGlobal('fetch', fetchMock);
    await hostedRunModelService.listOfferedModels();
    await hostedRunModelService.listOfferedModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('hostedRunModelService.assertOffered', () => {
  it('resolves for an offered bare id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    await expect(hostedRunModelService.assertOffered('claude-sonnet-4-6')).resolves.toEqual({
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
  });

  it('throws HostedModelNotOfferedError for an id not on the list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    const err = await hostedRunModelService.assertOffered('deepseek-chat').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedModelNotOfferedError);
    expect((err as HostedModelNotOfferedError).code).toBe('hosted_model_not_offered');
  });

  it('refuses the PREFIXED spelling — the list holds bare ids only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    await expect(
      hostedRunModelService.assertOffered('anthropic/claude-opus-5-5'),
    ).rejects.toBeInstanceOf(HostedModelNotOfferedError);
  });

  it('throws HostedModelsUnavailableError when motir-ai cannot answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const err = await hostedRunModelService
      .assertOffered('claude-opus-5-5')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostedModelsUnavailableError);
    expect((err as HostedModelsUnavailableError).code).toBe('hosted_models_unavailable');
  });
});

describe('hostedRunModelService.assertOffered over a mixed list (MOTIR-7208)', () => {
  it('resolves to the DeepSeek entry, provider included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          ...LIST,
          models: [...LIST.models, { id: 'deepseek-v4-pro', provider: 'deepseek' }],
        }),
      ),
    );
    await expect(hostedRunModelService.assertOffered('deepseek-v4-pro')).resolves.toEqual({
      id: 'deepseek-v4-pro',
      provider: 'deepseek',
    });
  });
});

describe('hostedRunModelService.defaultOffered (MOTIR-7208)', () => {
  it('resolves to the default ENTRY, provider included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    await expect(hostedRunModelService.defaultOffered()).resolves.toEqual({
      id: 'claude-opus-5-5',
      provider: 'anthropic',
    });
  });

  it('falls back to the first offered entry — a DeepSeek one keeps its provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ models: [{ id: 'deepseek-v4-pro', provider: 'deepseek' }], default: null }),
      ),
    );
    await expect(hostedRunModelService.defaultOffered()).resolves.toEqual({
      id: 'deepseek-v4-pro',
      provider: 'deepseek',
    });
  });
});

describe('toOpenCodeModel', () => {
  it("prefixes the offered entry's OWN provider: <provider>/<bare id>", () => {
    expect(toOpenCodeModel({ id: 'claude-opus-5-5', provider: 'anthropic' })).toBe(
      'anthropic/claude-opus-5-5',
    );
    expect(toOpenCodeModel({ id: 'deepseek-v4-pro', provider: 'deepseek' })).toBe(
      'deepseek/deepseek-v4-pro',
    );
    expect(
      hostedRunModelService.toOpenCodeModel({ id: 'claude-opus-5-5', provider: 'anthropic' }),
    ).toBe('anthropic/claude-opus-5-5');
  });
  it("prefixes GLM and Qwen entries with the CATALOG provider, never OpenCode's own ids (MOTIR-7244)", () => {
    expect(toOpenCodeModel({ id: 'glm-4.6', provider: 'z-ai' })).toBe('z-ai/glm-4.6');
    expect(toOpenCodeModel({ id: 'qwen-plus', provider: 'qwen' })).toBe('qwen/qwen-plus');
  });
  it('prefixes a Kimi entry with the catalog provider `moonshotai` (MOTIR-7361)', () => {
    expect(toOpenCodeModel({ id: 'kimi-k2.6', provider: 'moonshotai' })).toBe(
      'moonshotai/kimi-k2.6',
    );
  });
});

describe('the run-model list narrows the offer (MOTIR-7526; hosted-agent-run.md §7 as amended)', () => {
  const OFFER = {
    models: [
      { id: 'claude-opus-5-5', provider: 'anthropic' },
      { id: 'deepseek-v4-pro', provider: 'deepseek' },
    ],
    default: 'deepseek-v4-pro',
    defaultsByDifficulty: {
      trivial: 'deepseek-v4-pro',
      low: 'deepseek-v4-pro',
      medium: 'claude-opus-5-5',
      high: 'claude-opus-5-5',
    },
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(OFFER)),
    );
  });

  it('offers only models that are BOTH listed and offered by motir-ai', async () => {
    await listRunModels(['claude-opus-5-5']);
    const offered = await hostedRunModelService.listOfferedModels();
    expect(offered).toMatchObject({
      state: 'ok',
      models: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
    });
  });

  it('a default naming an unlisted model reads null, exactly as an unoffered one does', async () => {
    await listRunModels(['claude-opus-5-5']);
    expect(await hostedRunModelService.listOfferedModels()).toMatchObject({
      default: null,
      defaultsByDifficulty: {
        trivial: null,
        low: null,
        medium: 'claude-opus-5-5',
        high: 'claude-opus-5-5',
      },
    });
  });

  it('a listed model motir-ai stops offering is absent on the next read', async () => {
    await listRunModels(['claude-opus-5-5', 'claude-sonnet-5-5']);
    const offered = await hostedRunModelService.listOfferedModels();
    expect(offered.state === 'ok' && offered.models.map((m) => m.id)).toEqual(['claude-opus-5-5']);
    await expect(hostedRunModelService.assertOffered('claude-sonnet-5-5')).rejects.toBeInstanceOf(
      HostedModelNotOfferedError,
    );
  });

  it('assertOffered refuses an offered but unlisted model, and accepts a listed one', async () => {
    await listRunModels(['claude-opus-5-5']);
    await expect(hostedRunModelService.assertOffered('deepseek-v4-pro')).rejects.toBeInstanceOf(
      HostedModelNotOfferedError,
    );
    await expect(hostedRunModelService.assertOffered('claude-opus-5-5')).resolves.toEqual({
      id: 'claude-opus-5-5',
      provider: 'anthropic',
    });
  });

  it('a review run with nobody to choose takes the first LISTED model when the default is unlisted', async () => {
    await listRunModels(['claude-opus-5-5']);
    await expect(hostedRunModelService.defaultOffered()).resolves.toEqual({
      id: 'claude-opus-5-5',
      provider: 'anthropic',
    });
  });

  it('an initialised but EMPTY list offers nothing — an operator held every model back', async () => {
    await listRunModels([]);
    expect(await hostedRunModelService.listOfferedModels()).toMatchObject({
      state: 'ok',
      models: [],
      default: null,
    });
  });

  it('a list never initialised narrows nothing — its first read seeds it with the whole offer', async () => {
    const offered = await hostedRunModelService.listOfferedModels();
    expect(offered).toEqual({ state: 'ok', ...OFFER, ...NO_ROLES });
  });

  it('motir-ai unavailable still reads unavailable, never an empty list', async () => {
    await listRunModels(['claude-opus-5-5']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'boom' }, 500)),
    );
    expect(await hostedRunModelService.listOfferedModels()).toEqual({ state: 'unavailable' });
    await expect(hostedRunModelService.assertOffered('claude-opus-5-5')).rejects.toBeInstanceOf(
      HostedModelsUnavailableError,
    );
  });
});

describe('the review-agent and design-run defaults (MOTIR-10843)', () => {
  const ROLES = {
    ...LIST,
    reviewAgentDefault: 'claude-opus-5-5',
    designRunDefault: 'claude-sonnet-4-6',
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(ROLES)),
    );
  });

  it('listOfferedModels passes both through when they are offered', async () => {
    expect(await hostedRunModelService.listOfferedModels()).toMatchObject({
      state: 'ok',
      reviewAgentDefault: 'claude-opus-5-5',
      designRunDefault: 'claude-sonnet-4-6',
    });
  });

  it('a role default naming an unlisted model reads null, like a level default', async () => {
    await listRunModels(['claude-opus-5-5']);
    expect(await hostedRunModelService.listOfferedModels()).toMatchObject({
      reviewAgentDefault: 'claude-opus-5-5',
      designRunDefault: null,
    });
  });

  it("reviewModelFor: the org's offered review model, else the platform's", async () => {
    expect(await hostedRunModelService.reviewModelFor({ review: 'claude-sonnet-4-6' })).toBe(
      'claude-sonnet-4-6',
    );
    expect(await hostedRunModelService.reviewModelFor({ review: 'gone' })).toBe('claude-opus-5-5');
    expect(await hostedRunModelService.reviewModelFor(null)).toBe('claude-opus-5-5');
  });

  it('reviewModelFor answers undefined when neither is set, or motir-ai is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    expect(await hostedRunModelService.reviewModelFor(null)).toBeUndefined();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 503)),
    );
    expect(
      await hostedRunModelService.reviewModelFor({ review: 'claude-opus-5-5' }),
    ).toBeUndefined();
  });
});
