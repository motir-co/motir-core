import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mintGatewayAppKey,
  revokeGatewayAppKey,
  revokeGatewayAppKeysForProject,
} from '@/lib/gateway/appKeyClient';
import {
  GatewayAppKeyConfigError,
  GatewayAppKeyRefusedError,
  GatewayAppKeyUnavailableError,
} from '@/lib/gateway/errors';
import * as runKeyClient from '@/lib/gateway/runKeyClient';
import { GATEWAY_RUN_KEY_TIMEOUT_MS } from '@/lib/gateway/runKeyClient';

// THE TENANT-APP KEY CLIENT (MOTIR-8339) against motir-gateway's
// `POST/DELETE /api/motir/app-keys` contract (`controller/motir_app_key.go`).
// The gateway is an external service across the open-core boundary, so `fetch`
// is the seam stubbed here, as the run-key client's tests do.

const GATEWAY = 'https://gateway.test';
const SECRET = 'app-key-mint-secret-value-of-enough-length';
const EXPIRES = new Date('2026-12-01T00:00:00.000Z');
const EXPIRES_S = Math.floor(EXPIRES.getTime() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function minted(overrides: Record<string, unknown> = {}): Response {
  return json(
    {
      key: 'sk-app-key-1',
      keyId: 42,
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: EXPIRES_S,
      lane: 'app',
      ...overrides,
    },
    201,
  );
}

const MINT = { projectRef: 'proj_1', coreOrganizationId: 'org_1', expiresAt: EXPIRES };

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
}

beforeEach(() => {
  vi.stubEnv('MOTIR_GATEWAY_URL', `${GATEWAY}/`);
  vi.stubEnv('MOTIR_APP_KEY_MINT_SECRET', SECRET);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the request shape', () => {
  it('mints with POST, the app-key bearer, JSON and expiresAt in unix seconds, without models', async () => {
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintGatewayAppKey(MINT)).resolves.toEqual({
      key: 'sk-app-key-1',
      keyId: 42,
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: new Date(EXPIRES_S * 1000),
      lane: 'app',
    });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${GATEWAY}/api/motir/app-keys`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${SECRET}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: EXPIRES_S,
    });
  });

  it('sends models only when given', async () => {
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);
    await mintGatewayAppKey({ ...MINT, models: ['claude-sonnet-4-5'] });
    expect(JSON.parse(String(lastCall(fetchMock)[1].body))).toEqual({
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: EXPIRES_S,
      models: ['claude-sonnet-4-5'],
    });
  });

  it('revokes one key with DELETE on its keyId, and a project with DELETE on its url-encoded ref', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ keyId: 42, revoked: 1 }))
      .mockResolvedValueOnce(json({ projectRef: 'proj 1/&x', revoked: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeGatewayAppKey(42)).resolves.toEqual({ keyId: 42, revoked: 1 });
    let [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${GATEWAY}/api/motir/app-keys/42`);
    expect(init.method).toBe('DELETE');
    expect(init.headers).toEqual({ Authorization: `Bearer ${SECRET}` });

    await expect(revokeGatewayAppKeysForProject('proj 1/&x')).resolves.toEqual({
      projectRef: 'proj 1/&x',
      revoked: 2,
    });
    [url, init] = lastCall(fetchMock);
    expect(url).toBe(`${GATEWAY}/api/motir/app-keys?projectRef=proj+1%2F%26x`);
    expect(new URL(url).searchParams.get('projectRef')).toBe('proj 1/&x');
    expect(init.method).toBe('DELETE');
    expect(init.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
  });
});

describe('fail closed', () => {
  const calls = [
    () => mintGatewayAppKey(MINT),
    () => revokeGatewayAppKey(42),
    () => revokeGatewayAppKeysForProject('proj_1'),
  ];

  it.each([
    ['the gateway url unset', { MOTIR_GATEWAY_URL: '' }],
    ['the app-key secret unset', { MOTIR_APP_KEY_MINT_SECRET: '' }],
    ['the app-key secret blank', { MOTIR_APP_KEY_MINT_SECRET: '   ' }],
    [
      'only the run-key secret set',
      { MOTIR_APP_KEY_MINT_SECRET: '', MOTIR_RUN_KEY_MINT_SECRET: SECRET },
    ],
  ])('throws a config error and sends nothing with %s', async (_name, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const fetchMock = vi.fn(async () => minted());
    vi.stubGlobal('fetch', fetchMock);
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(GatewayAppKeyConfigError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a gateway url carrying /v1 as a config error and sends nothing', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', `${GATEWAY}/v1/`);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(mintGatewayAppKey(MINT)).rejects.toBeInstanceOf(GatewayAppKeyConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes on a failure of the origin read that is not a config error unchanged', async () => {
    const surprise = new RangeError('surprise');
    vi.spyOn(runKeyClient, 'gatewayBaseUrl').mockImplementation(() => {
      throw surprise;
    });
    vi.stubGlobal('fetch', vi.fn());
    await expect(mintGatewayAppKey(MINT)).rejects.toBe(surprise);
  });
});

describe('refusals and unavailability', () => {
  it.each([
    [400, 'app_key_not_minted'],
    [401, 'app_key_unauthorized'],
    [503, 'app_keys_not_configured'],
  ])('a %i with the gateway JSON refusal is REFUSED with its code', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { code, message: 'no' } }, status)),
    );
    const err = await mintGatewayAppKey(MINT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayAppKeyRefusedError);
    expect(err).toMatchObject({ status, code, message: 'no' });
  });

  it('a 4xx with no JSON body is refused as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })),
    );
    await expect(revokeGatewayAppKey(1)).rejects.toMatchObject({
      status: 404,
      code: 'unknown',
      message: 'Not Found',
    });
  });

  it.each([
    ['a 500', () => json({ error: { code: 'app_key_not_minted', message: 'db' } }, 500)],
    ['a 503 with a non-JSON body', () => new Response('<html>bad gateway</html>', { status: 503 })],
    ['a 502 with no status text', () => new Response(null, { status: 502 })],
  ])('%s is UNAVAILABLE', async (_name, respond) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond()),
    );
    await expect(revokeGatewayAppKeysForProject('p')).rejects.toBeInstanceOf(
      GatewayAppKeyUnavailableError,
    );
  });

  it('a network failure is UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(mintGatewayAppKey(MINT)).rejects.toThrow(
      new GatewayAppKeyUnavailableError('fetch failed'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'boom';
      }),
    );
    await expect(revokeGatewayAppKey(1)).rejects.toBeInstanceOf(GatewayAppKeyUnavailableError);
  });

  it('a stalled response is aborted at the deadline and UNAVAILABLE', async () => {
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
    const pending = mintGatewayAppKey(MINT).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(GATEWAY_RUN_KEY_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(GatewayAppKeyUnavailableError);
    expect(String((err as Error).message)).toContain(`${GATEWAY_RUN_KEY_TIMEOUT_MS}ms`);
  });

  it.each([
    ['no key', { key: undefined }],
    ['an empty key', { key: '' }],
    ['no keyId', { keyId: undefined }],
    ['a string keyId', { keyId: '42' }],
  ])('a 201 with %s is UNAVAILABLE', async (_name, overrides) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => minted(overrides)),
    );
    await expect(mintGatewayAppKey(MINT)).rejects.toBeInstanceOf(GatewayAppKeyUnavailableError);
  });

  it('a 201 that is not JSON is UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 201 })),
    );
    await expect(mintGatewayAppKey(MINT)).rejects.toBeInstanceOf(GatewayAppKeyUnavailableError);
  });
});

describe('answers', () => {
  it('a 201 missing optional fields falls back to the request and the app lane', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ key: 'sk-x', keyId: 7 }, 201)),
    );
    await expect(mintGatewayAppKey(MINT)).resolves.toEqual({
      key: 'sk-x',
      keyId: 7,
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: EXPIRES,
      lane: 'app',
    });
  });

  it('a repeat revoke answering revoked: 0 resolves normally, and a body-less 200 reads as 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ keyId: 42, revoked: 0 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }))
        .mockResolvedValueOnce(json(null)),
    );
    await expect(revokeGatewayAppKey(42)).resolves.toEqual({ keyId: 42, revoked: 0 });
    await expect(revokeGatewayAppKeysForProject('p')).resolves.toEqual({
      projectRef: 'p',
      revoked: 0,
    });
    await expect(revokeGatewayAppKey(43)).resolves.toEqual({ keyId: 43, revoked: 0 });
  });
});
