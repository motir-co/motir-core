import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkIndexAllowance } from '@/lib/ai/motirAiClient';
import { parseIndexAllowanceVerdict } from '@/lib/ciFleet/indexAllowance';

// THE INDEX-ALLOWANCE CLIENT CALL IS TOTAL (MOTIR-4544 top-up over MOTIR-4593's
// clients; the per-container draw left with MOTIR-12036). Every failure —
// unconfigured, unreachable, a non-2xx, a body that is not a verdict — returns
// `null`, because `null` is "could not ask" and the handoff proceeds on it. A throw here would stop the fleet on a blip; a verdict invented from
// an error body would stop it or wave it through for the wrong reason.
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal.

const VERDICT = {
  outcome: 'soft_gate_crossed',
  mayIndex: true,
  window: '2026-09',
  grantedCredits: 400,
  consumedCredits: 410,
  attributedCredits: 12,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each([
  [
    'checkIndexAllowance',
    () => checkIndexAllowance('org_1'),
    '/v1/credits/index-check',
    { coreOrganizationId: 'org_1' },
  ],
] as const)('%s', (_name, call, path, body) => {
  it('POSTs the body to its route with the service credential, and parses the verdict', async () => {
    const fetchMock = vi.fn(async () => json(VERDICT));
    vi.stubGlobal('fetch', fetchMock);

    expect(await call()).toEqual({
      outcome: 'soft_gate_crossed',
      window: '2026-09',
      grantedCredits: 400,
      consumedCredits: 410,
      attributedCredits: 12,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://ai.test${path}`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer svc-token');
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it('returns null — never a verdict — on a non-2xx, even one carrying JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'internal_error', outcome: 'ok' }, 500)),
    );
    expect(await call()).toBeNull();
  });

  it('returns null on a 2xx whose body is not a verdict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ credential: 'x' })),
    );
    expect(await call()).toBeNull();
  });

  it('returns null when motir-ai is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await call()).toBeNull();
  });

  it('returns null when the client is unconfigured, without calling out', async () => {
    vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', '');
    const fetchMock = vi.fn(async () => json(VERDICT));
    vi.stubGlobal('fetch', fetchMock);
    expect(await call()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseIndexAllowanceVerdict — the absent fields', () => {
  it('reads a missing attribution as 0 and a non-finite figure as unknown, never as a number', () => {
    expect(
      parseIndexAllowanceVerdict({
        outcome: 'ok',
        grantedCredits: Number.NaN,
        consumedCredits: '3',
      }),
    ).toEqual({
      outcome: 'ok',
      window: null,
      grantedCredits: null,
      consumedCredits: null,
      attributedCredits: 0,
    });
  });
});
