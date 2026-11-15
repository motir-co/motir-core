import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_MODEL_SERVING_TIMEOUT_MS,
  GatewayModelServingConfigError,
  GatewayModelServingRefusedError,
  GatewayModelServingUnavailableError,
  readGatewayModelServing,
  writeGatewayModelServing,
} from '@/lib/gateway/modelServingClient';
import {
  SERVING_GATEWAY,
  glm53Entry,
  jsonResponse,
  servingReadBody,
} from '../fixtures/gatewayModelServingWire';

// THE GATEWAY MODEL SERVING CLIENT (MOTIR-11280). motir-core never imports the
// gateway, so `fetch` is the seam, as in `capacityClient.test.ts`.

const TOKEN = 'sentinel-serving-token-11280';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('MOTIR_GATEWAY_URL', SERVING_GATEWAY);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', TOKEN);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readGatewayModelServing', () => {
  it('reads every entry through the fixed field list, with the bearer token', async () => {
    const extra = { ...glm53Entry({ secret: 'never-shown' }) };
    fetchMock.mockResolvedValueOnce(jsonResponse(servingReadBody([extra])));
    const read = await readGatewayModelServing();
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVING_GATEWAY}/api/motir/model-serving`,
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    );
    const init = fetchMock.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(read.outcome).toBe('answered');
    if (read.outcome !== 'answered') return;
    expect(read.readAt.toISOString()).toBe('2026-11-15T10:00:00.000Z');
    const [e] = read.entries;
    expect(e).toEqual({
      model: 'glm-5.3',
      originProvider: 'z-ai',
      charged: { prompt: 1.4, completion: 4.4, cacheRead: 0.26 },
      priceSource: { url: 'https://docs.z.ai/guides/overview/pricing', readDate: '2026-11-15' },
      selected: null,
      selectedBy: null,
      selectedAt: null,
      effective: 'z-ai',
      offerings: [
        expect.objectContaining({ provider: 'z-ai', channelName: 'GLM', enabled: true }),
        {
          provider: 'qwen',
          channelId: 7,
          channelName: 'Qwen',
          channelType: 49,
          enabled: true,
          cost: { prompt: 1.131, completion: 3.957, cacheRead: null },
          costSource: {
            url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
            readDate: '2026-11-12',
          },
        },
      ],
    });
    expect(JSON.stringify(read)).not.toContain('never-shown');
  });

  it('reads a saved choice with its time, and an offering with no price row', async () => {
    const entry = glm53Entry({
      selected: 'qwen',
      selectedBy: 'yue@motir.co',
      selectedAt: '2026-11-14T09:00:00Z',
      effective: 'qwen',
    });
    (entry.offerings as Record<string, unknown>[])[1]!['costUSDPerMTok'] = null;
    (entry.offerings as Record<string, unknown>[])[1]!['costSource'] = null;
    (entry.chargedUSDPerMTok as Record<string, unknown>)['completion'] = null;
    fetchMock.mockResolvedValueOnce(jsonResponse(servingReadBody([entry])));
    const read = await readGatewayModelServing();
    if (read.outcome !== 'answered') throw new Error('unanswered');
    const [e] = read.entries;
    expect(e!.selectedAt?.toISOString()).toBe('2026-11-14T09:00:00.000Z');
    expect(e!.charged.completion).toBeNull();
    expect(e!.offerings[1]!.cost).toBeNull();
    expect(e!.offerings[1]!.costSource).toBeNull();
  });

  it('answers not_configured, and sends nothing, without a token or a gateway URL', async () => {
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', ' ');
    expect(await readGatewayModelServing()).toEqual({
      outcome: 'unavailable',
      reason: 'not_configured',
    });
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', TOKEN);
    vi.stubEnv('MOTIR_GATEWAY_URL', '');
    expect(await readGatewayModelServing()).toMatchObject({ reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth_refused'],
    [403, 'auth_refused'],
    [500, 'server_error'],
  ])('answers a %i as %s', async (status, reason) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'x' } }, status));
    expect(await readGatewayModelServing()).toEqual({ outcome: 'unavailable', reason });
  });

  it.each([
    ['not a read', { success: false }],
    ['no data', { success: true, readAt: '2026-11-15T10:00:00Z' }],
    ['a bad time', servingReadBody([]) && { success: true, readAt: 'soon', data: [] }],
    ['a negative price', servingReadBody([glm53Entry({ chargedUSDPerMTok: { prompt: -1 } })])],
    ['no offerings', servingReadBody([glm53Entry({ offerings: 'z-ai' })])],
    [
      'an offering with no flag',
      servingReadBody([glm53Entry({ offerings: [{ provider: 'z-ai' }] })]),
    ],
    ['a string id', servingReadBody([glm53Entry({ model: 7 })])],
    [
      'a fractional channel id',
      servingReadBody([
        glm53Entry({
          offerings: [{ ...glm53Entry().offerings[0], channelId: 1.5 }],
        }),
      ]),
    ],
    ['an array entry', servingReadBody([[]])],
  ])('answers %s as bad_response', async (_name, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body));
    expect(await readGatewayModelServing()).toEqual({
      outcome: 'unavailable',
      reason: 'bad_response',
    });
  });

  it('answers a network failure and a timeout apart', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED with the url in it'));
    expect(await readGatewayModelServing()).toEqual({ outcome: 'unavailable', reason: 'network' });

    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = readGatewayModelServing();
    await vi.advanceTimersByTimeAsync(GATEWAY_MODEL_SERVING_TIMEOUT_MS);
    expect(await pending).toEqual({ outcome: 'unavailable', reason: 'timeout' });
  });
});

describe('writeGatewayModelServing', () => {
  it('PUTs the provider and the actor, and answers the saved entry', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: glm53Entry({ selected: 'qwen', effective: 'qwen' }) }),
    );
    const saved = await writeGatewayModelServing('glm-5.3', 'qwen', 'yue@motir.co');
    expect(saved.selected).toBe('qwen');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVING_GATEWAY}/api/motir/model-serving/glm-5.3`);
    expect(init!.method).toBe('PUT');
    expect(JSON.parse(init!.body as string)).toEqual({ provider: 'qwen', actor: 'yue@motir.co' });
  });

  it('sends null to clear the choice, and cuts an actor to the gateway limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: glm53Entry() }));
    await writeGatewayModelServing('glm 5/3', null, 'a'.repeat(300));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SERVING_GATEWAY}/api/motir/model-serving/glm%205%2F3`);
    const body = JSON.parse(init!.body as string);
    expect(body.provider).toBeNull();
    expect(body.actor).toHaveLength(191);
  });

  it('throws the config error, and sends nothing, without a token', async () => {
    vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '');
    await expect(writeGatewayModelServing('glm-5.3', 'qwen', 'x')).rejects.toBeInstanceOf(
      GatewayModelServingConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a refusal with the code, the field and the offerings', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          error: {
            code: 'model_serving_unknown_provider',
            field: 'provider',
            offerings: ['z-ai', 'qwen', 7],
          },
        },
        400,
      ),
    );
    const err = await writeGatewayModelServing('glm-5.3', 'openai', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayModelServingRefusedError);
    expect(err).toMatchObject({
      status: 400,
      code: 'model_serving_unknown_provider',
      field: 'provider',
      offerings: ['z-ai', 'qwen'],
    });
  });

  it('treats the store error as a refusal and any other 5xx as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'model_serving_store_error' } }, 500),
    );
    await expect(writeGatewayModelServing('glm-5.3', 'qwen', 'x')).rejects.toMatchObject({
      code: 'model_serving_store_error',
      field: null,
      offerings: [],
    });
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    await expect(writeGatewayModelServing('glm-5.3', 'qwen', 'x')).rejects.toBeInstanceOf(
      GatewayModelServingUnavailableError,
    );
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(writeGatewayModelServing('glm-5.3', 'qwen', 'x')).rejects.toMatchObject({
      status: 404,
      code: 'unknown',
    });
  });

  it('throws unavailable on no answer, a timeout, or an unreadable entry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('reset'));
    await expect(writeGatewayModelServing('glm-5.3', 'qwen', 'x')).rejects.toThrow(
      'could not be reached',
    );
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { model: 'glm-5.3' } }));
    await expect(writeGatewayModelServing('glm-5.3', 'qwen', 'x')).rejects.toThrow('unreadable');

    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = writeGatewayModelServing('glm-5.3', 'qwen', 'x').catch((e) => e);
    await vi.advanceTimersByTimeAsync(GATEWAY_MODEL_SERVING_TIMEOUT_MS);
    expect(String(await pending)).toContain(`${GATEWAY_MODEL_SERVING_TIMEOUT_MS}ms`);
  });
});
