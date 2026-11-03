import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CERTIFICATE_REQUEST_TIMEOUT_MS,
  CertificateHostnameUnknownError,
  CertificateProviderNotConfiguredError,
  CertificateProviderRefusedError,
  CertificateProviderUnavailableError,
} from '@/lib/publicAddresses/certificateProvider';
import {
  flyCertificateProvider,
  flyCertsConfig,
  isFlyCertsConfigured,
} from '@/lib/publicAddresses/adapters/fly/flyCertificates';

// The Fly certificates adapter — Story MOTIR-3878 · Subtask MOTIR-4210.
//
// Every test drives a FAKE `fetch`. There is no Fly account in CI, and a test
// that reached the real one would be measuring Fly's uptime rather than this
// mapping. What IS asserted for real is the request this adapter composes — the
// method, the path, the app, the header — because that is the half a fake cannot
// get wrong on our behalf.

const HOST = 'roadmap.acme.example';

/** The last request the adapter made, for asserting the wire shape. */
let calls: Array<{ url: string; init: RequestInit }>;

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return handler(String(url), (init ?? {}) as RequestInit);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  vi.stubEnv('FLY_CERTS_TOKEN', 'test-token');
  vi.stubEnv('FLY_CERTS_APP', 'motir-marketing');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('configuration', () => {
  it('reads the token and app at CALL time, not at import', () => {
    // The module was imported at the top of this file with NOTHING stubbed, and
    // that import threw nothing — which is the property a self-hosted build
    // depends on. Proved by this file existing and running at all, and asserted
    // here so the reason is written down rather than incidental.
    vi.unstubAllEnvs();
    expect(isFlyCertsConfigured()).toBe(false);
    vi.stubEnv('FLY_CERTS_TOKEN', 'test-token');
    vi.stubEnv('FLY_CERTS_APP', 'motir-marketing');
    expect(isFlyCertsConfigured()).toBe(true);
    expect(flyCertsConfig()).toEqual({ token: 'test-token', app: 'motir-marketing' });
  });

  it('names EVERY missing variable, not just the first', () => {
    // A message naming one of two missing variables costs the operator a second
    // deploy to discover the other.
    vi.unstubAllEnvs();
    try {
      flyCertsConfig();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CertificateProviderNotConfiguredError);
      expect((err as Error).message).toContain('FLY_CERTS_TOKEN');
      expect((err as Error).message).toContain('FLY_CERTS_APP');
    }
  });

  it('throws NotConfigured from every port method when unset', async () => {
    vi.unstubAllEnvs();
    mockFetch(() => jsonResponse(200, {}));
    await expect(flyCertificateProvider.request(HOST)).rejects.toBeInstanceOf(
      CertificateProviderNotConfiguredError,
    );
    await expect(flyCertificateProvider.check(HOST)).rejects.toBeInstanceOf(
      CertificateProviderNotConfiguredError,
    );
    await expect(flyCertificateProvider.remove(HOST)).rejects.toBeInstanceOf(
      CertificateProviderNotConfiguredError,
    );
    // And it never reached the network — a not-configured deployment must not
    // send an unauthenticated request to a third party.
    expect(calls).toHaveLength(0);
  });

  it('has NO fallback to another Fly token', async () => {
    // The token is scoped to one app, and this path is driven by customer input.
    // A deploy-capable token here would be a much larger grant than the work
    // needs — `flyMachines.ts`'s rule, transferred.
    vi.unstubAllEnvs();
    vi.stubEnv('FLY_API_TOKEN', 'a-broader-token');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'the-fleet-token');
    vi.stubEnv('FLY_CERTS_APP', 'motir-marketing');
    await expect(flyCertificateProvider.check(HOST)).rejects.toBeInstanceOf(
      CertificateProviderNotConfiguredError,
    );
  });
});

describe('the wire shape', () => {
  it('requests a certificate with the documented call', async () => {
    mockFetch(() => jsonResponse(200, { hostname: HOST, configured: false }));
    await flyCertificateProvider.request(HOST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://api.machines.dev/v1/apps/motir-marketing/certificates/acme',
    );
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ hostname: HOST });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
  });

  it('checks with the documented call', async () => {
    mockFetch(() => jsonResponse(200, { hostname: HOST, configured: true }));
    await flyCertificateProvider.check(HOST);
    expect(calls[0]!.url).toBe(
      `https://api.machines.dev/v1/apps/motir-marketing/certificates/${HOST}/check`,
    );
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('removes with the documented call', async () => {
    mockFetch(() => jsonResponse(200, {}));
    await flyCertificateProvider.remove(HOST);
    expect(calls[0]!.url).toBe(
      `https://api.machines.dev/v1/apps/motir-marketing/certificates/${HOST}`,
    );
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('URL-ENCODES the hostname into the path', async () => {
    // The value comes from a settings form. Fly's own doc calls the encoding out
    // for the wildcard case (`*` → `%2A`); the reason it is unconditional here
    // is that a customer-supplied string must never reach a path unescaped.
    mockFetch(() => jsonResponse(200, {}));
    await flyCertificateProvider.check('*.acme.example');
    expect(calls[0]!.url).toContain('%2A.acme.example');
    expect(calls[0]!.url).not.toContain('/*.');
  });
});

describe('the mapping', () => {
  it('maps configured and issued as TWO facts', async () => {
    // A hostname can be pointed correctly with no certificate yet — the ordinary
    // state for the minute after a customer creates their records. Collapsing
    // the two would make that indistinguishable from "not pointed".
    mockFetch(() => jsonResponse(200, { hostname: HOST, configured: true, certificates: [] }));
    const pointedNotIssued = await flyCertificateProvider.check(HOST);
    expect(pointedNotIssued.configured).toBe(true);
    expect(pointedNotIssued.issued).toBe(false);

    mockFetch(() =>
      jsonResponse(200, { hostname: HOST, configured: true, certificates: [{ id: 'c1' }] }),
    );
    const live = await flyCertificateProvider.check(HOST);
    expect(live.configured).toBe(true);
    expect(live.issued).toBe(true);
  });

  it('maps the Fly-issued certificate’s expires_at onto expiresAt (MOTIR-9526)', async () => {
    mockFetch(() =>
      jsonResponse(200, {
        hostname: HOST,
        configured: true,
        certificates: [
          { source: 'custom', status: 'active', expires_at: '2039-01-15T10:30:00Z' },
          { source: 'fly', status: 'active', expires_at: '2027-01-28T12:00:00Z' },
        ],
      }),
    );
    const state = await flyCertificateProvider.check(HOST);
    // The one this adapter asked for wins over a later customer-uploaded date.
    expect(state.expiresAt?.toISOString()).toBe('2027-01-28T12:00:00.000Z');
  });

  it('a reading with no (or an unparseable) date maps to null rather than throwing', async () => {
    mockFetch(() =>
      jsonResponse(200, { hostname: HOST, configured: true, certificates: [{ id: 'c1' }] }),
    );
    expect((await flyCertificateProvider.check(HOST)).expiresAt).toBeNull();
    mockFetch(() =>
      jsonResponse(200, {
        hostname: HOST,
        configured: true,
        certificates: [{ source: 'fly', expires_at: 'not a date' }],
      }),
    );
    expect((await flyCertificateProvider.check(HOST)).expiresAt).toBeNull();
    mockFetch(() => jsonResponse(200, { hostname: HOST, configured: true }));
    expect((await flyCertificateProvider.check(HOST)).expiresAt).toBeNull();
  });

  it("maps Fly's dns_requirements onto the records a customer must create", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        hostname: HOST,
        configured: false,
        certificates: [],
        dns_requirements: {
          acme_challenge: { name: `_acme-challenge.${HOST}`, target: 'acme.fly.dev' },
          cname: { name: HOST, target: 'motir-marketing.fly.dev' },
        },
      }),
    );
    const state = await flyCertificateProvider.check(HOST);
    expect(state.dnsRequirements).toEqual([
      { type: 'CNAME', name: `_acme-challenge.${HOST}`, value: 'acme.fly.dev' },
      { type: 'CNAME', name: HOST, value: 'motir-marketing.fly.dev' },
    ]);
  });

  it('maps A and AAAA records for an APEX, which cannot take a CNAME', async () => {
    // RFC 1034 §3.6.2 — the constraint `marketing-site-hosting.md` §3 already
    // documents at `motir.co`. An apex customer domain hits the same rule.
    mockFetch(() =>
      jsonResponse(200, {
        hostname: 'acme.example',
        configured: false,
        dns_requirements: { a_record: ['66.241.125.1'], aaaa_record: ['2a09:8280:1::1'] },
      }),
    );
    const state = await flyCertificateProvider.check('acme.example');
    expect(state.dnsRequirements).toEqual([
      { type: 'A', name: 'acme.example', value: '66.241.125.1' },
      { type: 'AAAA', name: 'acme.example', value: '2a09:8280:1::1' },
    ]);
  });

  it('survives a response carrying none of the optional fields', async () => {
    // Every field the adapter reads is optional in the narrowing, so a lean
    // response maps to a defined state rather than throwing on a missing key.
    mockFetch(() => jsonResponse(200, {}));
    const state = await flyCertificateProvider.check(HOST);
    expect(state).toMatchObject({
      hostname: HOST,
      configured: false,
      issued: false,
      dnsRequirements: [],
    });
    expect(state.checkedAt).toBeInstanceOf(Date);
  });
});

describe('the typed errors', () => {
  it('a 4xx is a REFUSAL, carrying the body’s message', async () => {
    mockFetch(() => jsonResponse(422, { error: 'hostname is not pointed at this app' }));
    const err = await flyCertificateProvider.check(HOST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateProviderRefusedError);
    expect((err as CertificateProviderRefusedError).status).toBe(422);
    expect((err as CertificateProviderRefusedError).reason).toBe(
      'hostname is not pointed at this app',
    );
  });

  it('a 5xx is UNAVAILABLE, not a refusal', async () => {
    // The dispositions are opposite: a refusal is shown to the customer and not
    // retried; an outage is retried and shown to nobody.
    mockFetch(() => jsonResponse(503, { error: 'upstream' }));
    await expect(flyCertificateProvider.check(HOST)).rejects.toBeInstanceOf(
      CertificateProviderUnavailableError,
    );
  });

  it('a transport failure is UNAVAILABLE', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err = await flyCertificateProvider.check(HOST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateProviderUnavailableError);
    expect((err as Error).message).toContain('fetch failed');
  });

  it('a TIMEOUT resolves to unavailable rather than hanging', async () => {
    // The whole point of the bound: unbounded, a provider that accepts the
    // connection and never answers holds a request thread open behind a customer
    // pressing Verify.
    vi.useFakeTimers();
    try {
      mockFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal | undefined;
            signal?.addEventListener('abort', () => {
              reject(
                Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
              );
            });
          }),
      );
      const pending = flyCertificateProvider.check(HOST);
      const assertion = expect(pending).rejects.toBeInstanceOf(CertificateProviderUnavailableError);
      await vi.advanceTimersByTimeAsync(CERTIFICATE_REQUEST_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 404 on CHECK is the hostname-unknown error, distinct from a refusal', async () => {
    mockFetch(() => jsonResponse(404, { error: 'not found' }));
    const err = await flyCertificateProvider.check(HOST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateHostnameUnknownError);
    expect(err).not.toBeInstanceOf(CertificateProviderRefusedError);
  });

  it('a 404 on REMOVE is SUCCESS — already gone is what removal wanted', async () => {
    // A retry of a half-finished removal is the ordinary way to arrive here.
    // Throwing would make the second attempt fail for having succeeded the first.
    mockFetch(() => jsonResponse(404, { error: 'not found' }));
    await expect(flyCertificateProvider.remove(HOST)).resolves.toBeUndefined();
  });

  it('a 5xx on REMOVE still throws — only the 404 is swallowed', async () => {
    // The narrow swallow, asserted narrow. Treating every failure on remove as
    // success would silently leave certificates behind.
    mockFetch(() => jsonResponse(500, { error: 'boom' }));
    await expect(flyCertificateProvider.remove(HOST)).rejects.toBeInstanceOf(
      CertificateProviderUnavailableError,
    );
  });

  it('a non-JSON error body still produces a useful reason', async () => {
    mockFetch(() => new Response('<html>gateway error</html>', { status: 400 }));
    const err = await flyCertificateProvider.check(HOST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CertificateProviderRefusedError);
    expect((err as CertificateProviderRefusedError).reason).toContain('gateway error');
  });
});
