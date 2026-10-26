import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyContainerAiAddress,
  isPrivateNetworkHost,
  verifyIndexContainerAiAddress,
} from '@/lib/ai/containerAiAddress';
import {
  MOTIR_AI_CONTAINER_URL_ENV_VAR,
  motirAiBaseUrl,
  motirAiContainerBaseUrl,
} from '@/lib/ai/motirAiClient';
import { MotirAiConfigError } from '@/lib/ai/errors';

// THE INDEX CONTAINER'S motir-ai ADDRESS (MOTIR-4518) — the accessor that had to
// be split, and the preflight that would have caught the split not existing.
//
// ⚠️ THE CENTRAL ASSERTION OF THIS FILE IS A NEGATIVE, and it is the whole card:
// the address handed to a container must NOT come from `motirAiBaseUrl()`, and
// an unset container variable must NOT fall back to it. Everything downstream of
// that fallback looked healthy for two weeks — the machine booted, the repository
// downloaded, the graph built, the ledger recorded success — and the only thing
// that ever went wrong was one DNS lookup in a log nobody could read, because
// index machines are `auto_destroy`.

const PRIVATE_AI_URL = 'http://motir-ai.internal:8080';
const PUBLIC_AI_URL = 'https://motir-ai.fly.dev';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('motirAiContainerBaseUrl — a SECOND accessor, with no fallback to the first', () => {
  it('reads its OWN variable and never MOTIR_AI_URL', () => {
    // The two are stubbed to DIFFERENT values on purpose: a fallback, a shared
    // read, or a copy-pasted variable name all fail here, and each of them was a
    // plausible way to write this function.
    vi.stubEnv('MOTIR_AI_URL', PRIVATE_AI_URL);
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PUBLIC_AI_URL);

    expect(motirAiContainerBaseUrl()).toBe(PUBLIC_AI_URL);
    expect(motirAiBaseUrl()).toBe(PRIVATE_AI_URL);
  });

  it('THROWS when unset — even with MOTIR_AI_URL perfectly well set', () => {
    // ⚠️ The acceptance criterion in its sharpest form. A silent fallback IS the
    // defect, so unconfigured has to be a failure rather than a default. Note
    // what is true at this point: motir-core's own transport is fine, so nothing
    // else in the process has any reason to complain.
    vi.stubEnv('MOTIR_AI_URL', PRIVATE_AI_URL);
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, '');

    expect(() => motirAiContainerBaseUrl()).toThrow(MotirAiConfigError);
    expect(() => motirAiContainerBaseUrl()).toThrow(MOTIR_AI_CONTAINER_URL_ENV_VAR);
    expect(motirAiBaseUrl()).toBe(PRIVATE_AI_URL);
  });

  it('normalises trailing slashes the same way its twin does', () => {
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, `${PUBLIC_AI_URL}///`);
    expect(motirAiContainerBaseUrl()).toBe(PUBLIC_AI_URL);
  });
});

describe('isPrivateNetworkHost — the structural half, decided without a network', () => {
  it.each([
    ['motir-ai.internal', true],
    // Flycast is org-scoped like 6PN (MOTIR-7656).
    ['motir-gateway.flycast', true],
    ['MOTIR-AI.INTERNAL', true],
    ['some.service.svc.cluster.local', true],
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.0.9', true],
    ['fdaa:0:1::3', true],
    ['[fdaa:0:1::3]', true],
    ['::1', true],
    // The bare suffix, with no label in front of it — a host that IS the
    // private zone rather than one inside it.
    ['internal', true],
    ['motir-ai.fly.dev', false],
    ['ai.motir.co', false],
    ['66.241.125.195', false],
  ])('%s → private: %s', (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });
});

describe('classifyContainerAiAddress — what can be decided from the address alone', () => {
  it('UNCONFIGURED when unset, and the message says why there is no fallback', () => {
    const verdict = classifyContainerAiAddress(undefined);
    expect(verdict?.verdict).toBe('unconfigured');
    expect(verdict?.detail).toContain(MOTIR_AI_CONTAINER_URL_ENV_VAR);
    expect(verdict?.detail).toContain('MOTIR_AI_URL');
  });

  it('PRIVATE_ADDRESS for the exact value that shipped — a DEFINITE verdict', () => {
    // ⚠️ THE ARM THE CARD EXISTS FOR. No probe could have produced it: from
    // motir-core, inside the organization the name is scoped to, this address
    // resolves perfectly. It is unusable for the container because of WHERE the
    // container is, which is a fact about the addressing scheme rather than an
    // observation anybody could take from here.
    const verdict = classifyContainerAiAddress(PRIVATE_AI_URL);
    expect(verdict).toMatchObject({ verdict: 'private_address', address: PRIVATE_AI_URL });
    expect(verdict?.detail).toContain('motir-ai.internal');
    expect(verdict?.detail).toContain('NXDOMAIN');
  });

  it.each([
    // ⚠️ `new URL()` PARSES THIS. Scheme `motir-ai:`, path `8080`, hostname ''.
    // A try/catch alone lets it through, and the container is then handed
    // something no `fetch` can resolve.
    'motir-ai:8080',
    'motir-ai.fly.dev',
    '/v1',
    'ftp://motir-ai.fly.dev',
  ])('refuses %s — not a usable absolute http(s) URL', (raw) => {
    const verdict = classifyContainerAiAddress(raw);
    expect(verdict).toMatchObject({ verdict: 'private_address', address: raw });
    expect(verdict?.detail).toContain('absolute http(s) URL');
  });

  it('returns null — nothing decided, probe it — for a public address', () => {
    expect(classifyContainerAiAddress(PUBLIC_AI_URL)).toBeNull();
  });
});

describe('verifyIndexContainerAiAddress — the preflight', () => {
  it('NOT_APPLICABLE when this deployment runs no index containers', async () => {
    // Asserted with the variable set to the broken value, so the arm is proved
    // to be the CONFIGURED gate rather than an accident of the address.
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PRIVATE_AI_URL);
    const fetchImpl = vi.fn();

    await expect(
      verifyIndexContainerAiAddress({ isConfigured: false, fetchImpl }),
    ).resolves.toEqual({
      verdict: 'not_applicable',
      detail: 'this deployment is not configured to run index containers',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('UNCONFIGURED on a deployment that indexes and has no container address', async () => {
    vi.stubEnv('MOTIR_AI_URL', PRIVATE_AI_URL);
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, '');
    const fetchImpl = vi.fn();

    const verdict = await verifyIndexContainerAiAddress({ isConfigured: true, fetchImpl });

    expect(verdict.verdict).toBe('unconfigured');
    // It never reaches the network — there is no address to reach.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('PRIVATE_ADDRESS without probing — and this is the case a probe would have PASSED', async () => {
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PRIVATE_AI_URL);
    // The probe would have SUCCEEDED from motir-core, which is exactly why the
    // structural verdict is taken first and the probe is never made.
    const fetchImpl = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));

    const verdict = await verifyIndexContainerAiAddress({ isConfigured: true, fetchImpl });

    expect(verdict).toMatchObject({ verdict: 'private_address' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('REACHABLE when a public address answers /health', async () => {
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, `${PUBLIC_AI_URL}/`);
    // The parameter is DECLARED — a zero-arg `vi.fn` types `mock.calls` as `[]`,
    // so indexing into it is a compile error rather than an assertion.
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request) => new Response('{"status":"ok"}', { status: 200 }),
    );

    const verdict = await verifyIndexContainerAiAddress({ isConfigured: true, fetchImpl });

    expect(verdict).toEqual({ verdict: 'reachable', address: PUBLIC_AI_URL, status: 200 });
    // The trailing slash was normalised away, and the probe asks for /health.
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${PUBLIC_AI_URL}/health`);
  });

  it('INDETERMINATE — never a claim — when this process cannot reach it', async () => {
    // The same boundary both image preflights hold: a transport failure is a
    // statement about THIS network. Being loud about it teaches an operator that
    // the row is noise, which is how the next silent fault gets missed.
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PUBLIC_AI_URL);
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo EAI_AGAIN motir-ai.fly.dev');
    });

    await expect(verifyIndexContainerAiAddress({ isConfigured: true, fetchImpl })).resolves.toEqual(
      {
        verdict: 'indeterminate',
        address: PUBLIC_AI_URL,
        detail: 'getaddrinfo EAI_AGAIN motir-ai.fly.dev',
      },
    );
  });

  it('INDETERMINATE when the thrown value is not an Error at all', async () => {
    // `fetch` rejecting with a non-Error is rare and not impossible (an aborted
    // stream, a polyfill), and a health check that crashed on it would take the
    // whole daily tick down over the shape of somebody else's rejection.
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PUBLIC_AI_URL);
    const fetchImpl = vi.fn(async () => {
      throw 'socket hang up';
    });

    await expect(verifyIndexContainerAiAddress({ isConfigured: true, fetchImpl })).resolves.toEqual(
      {
        verdict: 'indeterminate',
        address: PUBLIC_AI_URL,
        detail: 'socket hang up',
      },
    );
  });

  it('INDETERMINATE on a non-2xx answer, naming the status', async () => {
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PUBLIC_AI_URL);
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }));

    const verdict = await verifyIndexContainerAiAddress({ isConfigured: true, fetchImpl });

    expect(verdict).toMatchObject({ verdict: 'indeterminate', address: PUBLIC_AI_URL });
    expect((verdict as { detail: string }).detail).toContain('502');
  });

  it('falls back to the ambient fetch when none is injected', async () => {
    vi.stubEnv(MOTIR_AI_CONTAINER_URL_ENV_VAR, PUBLIC_AI_URL);
    const ambient = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    vi.stubGlobal('fetch', ambient);

    await expect(verifyIndexContainerAiAddress({ isConfigured: true })).resolves.toMatchObject({
      verdict: 'reachable',
    });
    expect(ambient).toHaveBeenCalledOnce();
  });
});
