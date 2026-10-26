import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_CAPACITY_TIMEOUT_MS,
  readGatewayCapacity,
  writeGatewayCapacityLimits,
} from '@/lib/gateway/capacityClient';
import {
  GatewayCapacityConfigError,
  GatewayCapacityRefusedError,
  GatewayCapacityUnavailableError,
} from '@/lib/gateway/capacityErrors';

// THE GATEWAY CAPACITY CLIENT (MOTIR-9608). motir-core never imports motir-gateway
// (the open-core boundary), so `fetch` is the seam stubbed here — as in
// `tests/gateway/statusClient.test.ts` and `tests/hostedRuns/hostedRunKeyService.test.ts`.
//
// The bodies are motir-gateway `docs/motir-capacity-api.md` §3, §4 and §9's own
// examples.

const GATEWAY = 'https://gateway.test';
const TOKEN = 'sentinel-capacity-token-6f1c';

const NA = { value: null, status: 'not_applicable' };

function deepseekEntry(lanes: unknown) {
  return {
    provider: 'deepseek',
    model: 'deepseek-example-1',
    tier_note: 'Example tier',
    unknown_note: '',
    planning_share_percent: 50,
    limits: {
      max_concurrency: { value: 500, status: 'set' },
      rpm: NA,
      input_tpm: NA,
      output_tpm: NA,
      tpm: NA,
      tpd: NA,
    },
    lanes,
    provider_hint: null,
  };
}

const LIVE_LANES = {
  planning: {
    in_flight: 1,
    requests_per_minute: 3,
    tokens_per_minute: 4200,
    tokens_per_day: 98000,
    rate_limited_429: { minute: 0, day: 0 },
  },
  agent: {
    in_flight: 0,
    requests_per_minute: 0,
    tokens_per_minute: 0,
    tokens_per_day: 0,
    rate_limited_429: { minute: 0, day: 0 },
  },
};

const CLAUDE_ENTRY = {
  provider: 'claude',
  model: 'claude-example-1',
  tier_note: 'Example tier, read 2026-01-01',
  unknown_note: 'tpd: not published',
  planning_share_percent: 50,
  limits: {
    max_concurrency: NA,
    rpm: { value: 1000, status: 'set' },
    input_tpm: { value: 200000, status: 'set' },
    output_tpm: { value: 40000, status: 'set' },
    tpm: NA,
    tpd: { value: null, status: 'unknown' },
  },
  lanes: LIVE_LANES,
  provider_hint: {
    remaining_requests: 960,
    remaining_tokens: null,
    remaining_input_tokens: 150000,
    remaining_output_tokens: 38000,
    requests_reset: '2026-10-25T12:00:30Z',
    tokens_reset: null,
    retry_after_seconds: null,
    observed_at: '2026-10-25T11:59:58Z',
  },
};

function readBody(entries: unknown[], state = 'live') {
  return {
    success: true,
    read_at: '2026-10-25T12:00:00Z',
    counter_store: { state, scope: 'shared' },
    entries,
  };
}

const STORED = {
  success: true,
  data: {
    provider: 'qwen',
    model: 'qwen-example-1',
    tier_note: 'Example tier, read 2026-01-01',
    unknown_note: '',
    planning_share_percent: 40,
    limits: {
      max_concurrency: NA,
      rpm: { value: 600, status: 'set' },
      input_tpm: NA,
      output_tpm: NA,
      tpm: { value: 800000, status: 'set' },
      tpd: NA,
    },
    updated_at: '2026-10-25T12:00:00.123Z',
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(status: number, code: string, field?: string): Response {
  return json({ success: false, error: field ? { code, field } : { code } }, status);
}

beforeEach(() => {
  vi.stubEnv('MOTIR_GATEWAY_URL', `${GATEWAY}/`);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', TOKEN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('readGatewayCapacity — answered', () => {
  it('parses the §9 read: read_at, the store, and every limit typed by its status', async () => {
    const fetchMock = vi.fn(async () => json(readBody([deepseekEntry(LIVE_LANES)])));
    vi.stubGlobal('fetch', fetchMock);

    const read = await readGatewayCapacity();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/api/motir/capacity`);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.readAt).toEqual(new Date('2026-10-25T12:00:00Z'));
    expect(read.counterStore).toEqual({ state: 'live', scope: 'shared' });
    const [entry] = read.entries;
    expect(entry!.limits.max_concurrency).toEqual({ status: 'set', value: 500 });
    expect(entry!.limits.rpm).toEqual({ status: 'not_applicable' });
    expect(entry!.lanes.planning).toEqual({
      inFlight: 1,
      requestsPerMinute: 3,
      tokensPerMinute: 4200,
      tokensPerDay: 98000,
      rateLimited429: { minute: 0, day: 0 },
    });
  });

  it('never reads an unknown or not-applicable limit as 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(readBody([CLAUDE_ENTRY]))),
    );
    const read = await readGatewayCapacity();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    const { limits } = read.entries[0]!;
    for (const unit of ['max_concurrency', 'tpm', 'tpd'] as const) {
      expect(limits[unit]).not.toHaveProperty('value');
      expect('value' in limits[unit] ? limits[unit].value : undefined).not.toBe(0);
    }
    expect(limits.tpd).toEqual({ status: 'unknown' });
  });

  it('carries the unknown note, the tier note and the provider hint', async () => {
    const empty = { ...CLAUDE_ENTRY, model: 'claude-example-2', unknown_note: '' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(readBody([CLAUDE_ENTRY, empty]))),
    );
    const read = await readGatewayCapacity();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.entries[0]!.unknownNote).toBe('tpd: not published');
    expect(read.entries[1]!.unknownNote).toBe('');
    expect(read.entries[0]!.tierNote).toBe('Example tier, read 2026-01-01');
    expect(read.entries[0]!.providerHint).toMatchObject({
      remainingRequests: 960,
      remainingTokens: null,
      observedAt: '2026-10-25T11:59:58Z',
    });
  });

  it('answers the §9 counter-store-down read with its limits and null lanes', async () => {
    const down = readBody([deepseekEntry({ planning: null, agent: null })], 'unavailable');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(down)),
    );
    const read = await readGatewayCapacity();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.counterStore.state).toBe('unavailable');
    const [entry] = read.entries;
    expect(entry!.lanes).toEqual({ planning: null, agent: null });
    expect(entry!.providerHint).toBeNull();
    expect(entry!.limits.max_concurrency).toEqual({ status: 'set', value: 500 });
    expect(entry!.tierNote).toBe('Example tier');
    expect(entry!.unknownNote).toBe('');
    expect(entry!.planningSharePercent).toBe(50);
  });

  it('leaves out a provider outside claude, qwen and deepseek, and keeps the rest', async () => {
    const other = { ...CLAUDE_ENTRY, provider: 'openai', model: 'example' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(readBody([other, CLAUDE_ENTRY]))),
    );
    const read = await readGatewayCapacity();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.entries.map((e) => e.provider)).toEqual(['claude']);
  });

  it('copies a fixed field list: a field the gateway adds later does not pass through', async () => {
    const extra = { ...CLAUDE_ENTRY, updated_by: 'admin-7', future_field: 1 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(readBody([extra]))),
    );
    const read = await readGatewayCapacity();
    expect(JSON.stringify(read)).not.toContain('admin-7');
    expect(JSON.stringify(read)).not.toContain('future_field');
  });
});

describe('readGatewayCapacity — unavailable, never thrown', () => {
  it.each([
    ['the URL', 'MOTIR_GATEWAY_URL'],
    ['the token', 'MOTIR_GATEWAY_CAPACITY_TOKEN'],
  ])('is not_configured with %s unset, and sends nothing', async (_label, name) => {
    vi.stubEnv(name, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await readGatewayCapacity()).toEqual({
      outcome: 'unavailable',
      reason: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'capacity_auth_invalid', 'auth_refused'],
    [403, 'capacity_auth_forbidden', 'auth_refused'],
    [500, 'capacity_config_unavailable', 'config_unavailable'],
    [502, 'unknown', 'server_error'],
  ])('maps %i %s to %s', async (status, code, reason) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(status, code)),
    );
    expect(await readGatewayCapacity()).toEqual({ outcome: 'unavailable', reason, code });
  });

  it('is network when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await readGatewayCapacity()).toEqual({ outcome: 'unavailable', reason: 'network' });
  });

  it('is timeout when the deadline aborts', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = readGatewayCapacity();
    await vi.advanceTimersByTimeAsync(GATEWAY_CAPACITY_TIMEOUT_MS);
    expect(await pending).toEqual({ outcome: 'unavailable', reason: 'timeout' });
  });

  it.each([
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
    [
      "a limit status 'zero'",
      () =>
        json(
          readBody([
            {
              ...CLAUDE_ENTRY,
              limits: { ...CLAUDE_ENTRY.limits, rpm: { value: 0, status: 'zero' } },
            },
          ]),
        ),
    ],
    [
      'a value of -1',
      () =>
        json(
          readBody([
            {
              ...CLAUDE_ENTRY,
              limits: { ...CLAUDE_ENTRY.limits, rpm: { value: -1, status: 'set' } },
            },
          ]),
        ),
    ],
    [
      'a fractional lane count',
      () =>
        json(
          readBody([
            deepseekEntry({ ...LIVE_LANES, agent: { ...LIVE_LANES.agent, in_flight: 1.5 } }),
          ]),
        ),
    ],
  ])('is bad_response for %s', async (_label, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer()),
    );
    expect(await readGatewayCapacity()).toEqual({ outcome: 'unavailable', reason: 'bad_response' });
  });
});

describe('writeGatewayCapacityLimits', () => {
  it('PUTs only the keys present, in snake_case, and parses the stored row', async () => {
    const fetchMock = vi.fn(async () => json(STORED));
    vi.stubGlobal('fetch', fetchMock);

    const row = await writeGatewayCapacityLimits('qwen', 'qwen-example-1', {
      tpm: 800000,
      planningSharePercent: 40,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/api/motir/capacity/limits/qwen/qwen-example-1`);
    expect(init.method).toBe('PUT');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe('{"tpm":800000,"planning_share_percent":40}');
    expect(row.updatedAt).toEqual(new Date('2026-10-25T12:00:00.123Z'));
    expect(row.limits.tpm).toEqual({ status: 'set', value: 800000 });
    expect(row.limits.max_concurrency).toEqual({ status: 'not_applicable' });
    expect(row).not.toHaveProperty('lanes');
  });

  it('sends a null limit as null and leaves an absent tier note out', async () => {
    const fetchMock = vi.fn(async () => json(STORED));
    vi.stubGlobal('fetch', fetchMock);
    await writeGatewayCapacityLimits('qwen', 'qwen-example-1', { rpm: null });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"rpm":null}');
    expect(String(init.body)).not.toContain('tier_note');
  });

  it('escapes both path segments', async () => {
    const fetchMock = vi.fn(async () => json(STORED));
    vi.stubGlobal('fetch', fetchMock);
    await writeGatewayCapacityLimits('qwen', 'a/b c', { rpm: 1 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${GATEWAY}/api/motir/capacity/limits/qwen/a%2Fb%20c`);
  });

  it.each([
    [400, 'capacity_unknown_provider', undefined],
    [404, 'capacity_unknown_model', undefined],
    [400, 'capacity_invalid_body', 'rpm'],
    [400, 'capacity_invalid_body', undefined],
    [400, 'capacity_empty_edit', undefined],
    [400, 'capacity_invalid_value', 'planning_share_percent'],
    [500, 'capacity_store_error', undefined],
    [401, 'capacity_auth_missing', undefined],
    [401, 'capacity_auth_invalid', undefined],
    [403, 'capacity_auth_forbidden', undefined],
  ])('throws refused for %i %s (field %s)', async (status, code, field) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(status, code, field)),
    );
    const err = await writeGatewayCapacityLimits('qwen', 'qwen-example-1', { rpm: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayCapacityRefusedError);
    expect(err).toMatchObject({ status, code, field: field ?? null });
  });

  it('throws unavailable for another 5xx, a network failure and the deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(502, 'bad_gateway')),
    );
    await expect(writeGatewayCapacityLimits('qwen', 'm', { rpm: 1 })).rejects.toBeInstanceOf(
      GatewayCapacityUnavailableError,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    await expect(writeGatewayCapacityLimits('qwen', 'm', { rpm: 1 })).rejects.toBeInstanceOf(
      GatewayCapacityUnavailableError,
    );
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = writeGatewayCapacityLimits('qwen', 'm', { rpm: 1 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(GATEWAY_CAPACITY_TIMEOUT_MS);
    expect(await pending).toBeInstanceOf(GatewayCapacityUnavailableError);
  });

  it.each(['MOTIR_GATEWAY_URL', 'MOTIR_GATEWAY_CAPACITY_TOKEN'])(
    'throws config with %s unset, and sends nothing',
    async (name) => {
      vi.stubEnv(name, '');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      await expect(writeGatewayCapacityLimits('qwen', 'm', { rpm: 1 })).rejects.toBeInstanceOf(
        GatewayCapacityConfigError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('the token never leaves the request', () => {
  it('is in no parsed read, no unavailable read and no typed error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(readBody([CLAUDE_ENTRY]))),
    );
    expect(JSON.stringify(await readGatewayCapacity())).not.toContain(TOKEN);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => refusal(401, 'capacity_auth_invalid')),
    );
    expect(JSON.stringify(await readGatewayCapacity())).not.toContain(TOKEN);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError(`bad ${TOKEN}`))),
    );
    expect(JSON.stringify(await readGatewayCapacity())).not.toContain(TOKEN);

    const errors: unknown[] = [];
    for (const answer of [
      () => refusal(400, 'capacity_invalid_value', 'rpm'),
      () => refusal(502, 'unknown'),
      () => Promise.reject(new TypeError(`bad ${TOKEN}`)),
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => answer()),
      );
      errors.push(await writeGatewayCapacityLimits('qwen', 'm', { rpm: 12345 }).catch((e) => e));
    }
    vi.stubEnv('MOTIR_GATEWAY_URL', '');
    errors.push(await writeGatewayCapacityLimits('qwen', 'm', { rpm: 12345 }).catch((e) => e));
    for (const err of errors) {
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).not.toContain('12345');
    }
  });
});
