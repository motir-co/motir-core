import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_STATUS_TIMEOUT_MS,
  httpGatewayStatusReader,
  readGatewayStatus,
} from '@/lib/gateway/statusClient';
import { gatewayStatusReader, usingFakeGatewayStatus } from '@/lib/gateway/statusProvider';
import { GatewayStatusMalformedError } from '@/lib/gateway/statusErrors';

// THE GATEWAY STATUS CLIENT (MOTIR-742). motir-core never imports motir-gateway
// (the open-core boundary), so `fetch` is the seam stubbed here — as in
// `tests/hostedRuns/hostedRunKeyService.test.ts` for the run-key client.
//
// The recorded body is motir-gateway's own `GetStatus` (`controller/misc.go`),
// trimmed of the login-page settings the client ignores: `start_time` is UNIX
// SECONDS.

const RECORDED = {
  success: true,
  message: '',
  data: {
    version: 'v0.18.3',
    start_time: 1_759_154_520,
    system_name: 'Motir Gateway',
    email_verification: false,
  },
};

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('readGatewayStatus', () => {
  it('reads version and start time from the recorded body, with a latency', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test/');
    const fetchMock = vi.fn(async () => answer(RECORDED));
    vi.stubGlobal('fetch', fetchMock);

    const status = await readGatewayStatus();

    expect(status.version).toBe('v0.18.3');
    expect(status.startTime).toBe(new Date(1_759_154_520 * 1000).toISOString());
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    // The trailing slash is normalised by the run-key client's origin reader.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.example.test/api/status');
    expect(init.method).toBe('GET');
  });

  it('sends GET and nothing else — no body and no credential', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubEnv('MOTIR_RUN_KEY_MINT_SECRET', 'mint-secret');
    const fetchMock = vi.fn(async () => answer(RECORDED));
    vi.stubGlobal('fetch', fetchMock);

    await readGatewayStatus();

    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      const init = call[1];
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      expect(JSON.stringify(init.headers ?? {})).not.toContain('mint-secret');
      expect(JSON.stringify(init.headers ?? {}).toLowerCase()).not.toContain('authorization');
    }
  });

  it('throws when the gateway answers success:false', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer({ success: false, message: 'down', data: null })),
    );
    await expect(readGatewayStatus()).rejects.toThrow(/did not report success/);
  });

  it('throws on a 5xx', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer({ error: 'bad gateway' }, 502)),
    );
    await expect(readGatewayStatus()).rejects.toThrow(/answered 502/);
  });

  it('throws on a body that is not JSON', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>oops</html>', { status: 200 })),
    );
    await expect(readGatewayStatus()).rejects.toThrow();
  });

  it.each([
    ['no data', { success: true, message: '' }, /no data/],
    ['no version', { success: true, data: { start_time: 1 } }, /no version/],
    ['an empty version', { success: true, data: { version: '', start_time: 1 } }, /no version/],
    ['no start time', { success: true, data: { version: 'v1' } }, /no start time/],
    [
      'a zero start time',
      { success: true, data: { version: 'v1', start_time: 0 } },
      /no start time/,
    ],
    ['a JSON array', [1, 2], /did not report success/],
  ])('throws on a malformed body — %s', async (_label, body, message) => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer(body)),
    );
    await expect(readGatewayStatus()).rejects.toThrow(message);
  });

  it('throws when the gateway does not answer within the deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );

    const pending = readGatewayStatus();
    const assertion = expect(pending).rejects.toThrow(/did not answer within 3000ms/);
    await vi.advanceTimersByTimeAsync(GATEWAY_STATUS_TIMEOUT_MS);
    await assertion;
    expect(GATEWAY_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

  it('rethrows a network failure as itself', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(readGatewayStatus()).rejects.toThrow('fetch failed');
  });
});

describe('which kind of no (MOTIR-9641)', () => {
  // An answer that arrived and was rejected is typed, with WHY; a missing answer
  // is not. The console's Gateway card reads the difference.
  async function rejection(): Promise<unknown> {
    return readGatewayStatus().then(
      () => null,
      (err: unknown) => err,
    );
  }

  it.each([
    ['a 503', () => answer({ error: 'unavailable' }, 503), 'httpStatus', 503],
    ['a body that is not JSON', () => new Response('<html>oops</html>'), 'notJson', null],
    ['success:false', () => answer({ success: false, data: null }), 'noSuccess', null],
    ['no data', () => answer({ success: true }), 'noData', null],
    [
      'an empty version',
      () => answer({ success: true, data: { version: '', start_time: 1 } }),
      'noVersion',
      null,
    ],
    [
      'no start time',
      () => answer({ success: true, data: { version: 'v1' } }),
      'noStartTime',
      null,
    ],
  ])('%s throws GatewayStatusMalformedError naming why', async (_label, reply, why, status) => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply()),
    );
    const err = await rejection();
    expect(err).toBeInstanceOf(GatewayStatusMalformedError);
    expect((err as GatewayStatusMalformedError).why).toBe(why);
    expect((err as GatewayStatusMalformedError).httpStatus).toBe(status);
  });

  it('a deadline that passes is NOT a malformed answer', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const pending = rejection();
    await vi.advanceTimersByTimeAsync(GATEWAY_STATUS_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GatewayStatusMalformedError);
  });

  it('a network failure is NOT a malformed answer', async () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await rejection()).not.toBeInstanceOf(GatewayStatusMalformedError);
  });
});

describe('the real reader', () => {
  it('is not configured, and has no status page, without MOTIR_GATEWAY_URL', () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', '   ');
    expect(httpGatewayStatusReader.configured()).toBe(false);
    expect(httpGatewayStatusReader.statusUrl()).toBeNull();
  });

  it('links out to the status endpoint it reads', () => {
    vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');
    expect(httpGatewayStatusReader.configured()).toBe(true);
    expect(httpGatewayStatusReader.statusUrl()).toBe('https://gateway.example.test/api/status');
  });
});

describe('the E2E fake binding', () => {
  it('is used when the flag is set outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_STATUS', '1');
    expect(usingFakeGatewayStatus()).toBe(true);
    const reader = gatewayStatusReader();
    expect(reader).not.toBe(httpGatewayStatusReader);
    expect(reader.configured()).toBe(true);
    expect(reader.statusUrl()).toBeNull();
    const status = await reader.read();
    expect(status.latencyMs).toBeGreaterThan(0);
    expect(status.version).toBeTruthy();
  });

  it('⚠️ is IGNORED in a production build without the E2E harness', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_STATUS', '1');
    expect(usingFakeGatewayStatus()).toBe(false);
    expect(gatewayStatusReader()).toBe(httpGatewayStatusReader);
  });

  it('arms in a production build only when the E2E harness is ALSO set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '1');
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_STATUS', '1');
    expect(usingFakeGatewayStatus()).toBe(true);
  });

  it('is the real reader when the flag is unset', () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_STATUS', '');
    expect(gatewayStatusReader()).toBe(httpGatewayStatusReader);
  });
});
