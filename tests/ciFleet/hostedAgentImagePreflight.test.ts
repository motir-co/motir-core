import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTED_AGENT_IMAGE_ENV_VAR, verifyHostedAgentImagePullable } from '@/lib/orchestrator';

// THE HOSTED-AGENT IMAGE's preflight (MOTIR-9420) — the third pull path, probed
// the way an agent-runner VM pulls it: ANONYMOUSLY. The VM has no instance
// profile and no Fly org credential, so the one thing this file pins hardest is
// that the probe sends no credential of its own — the only `Authorization` on
// the wire is the anonymous Bearer token the registry itself issued.
//
// The registry is stubbed the way `fleetImagePull.test.ts` stubs GHCR for
// `verifyIndexFleetBootable`: the measured wire shapes, `fetch` the only fake.
// No database, no network.

const REPO = 'motir-co/motir-hosted-agent';
const IMAGE = `ghcr.io/${REPO}@sha256:${'b'.repeat(64)}`;
const ANON_TOKEN = 'anon-pull-token';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Call = { url: URL; authorization: string | undefined };

/** GHCR as measured: an anonymous token for a public repository, then the
 *  manifest to a caller presenting exactly that token. */
function ghcrLike(publicRepo: boolean, calls: Call[]) {
  return vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(rawUrl));
    const authorization = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    calls.push({ url, authorization });
    if (url.pathname === '/token') {
      return publicRepo
        ? json(200, { token: ANON_TOKEN })
        : json(401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] });
    }
    if (authorization === `Bearer ${ANON_TOKEN}`) {
      return json(200, {}, { 'docker-content-digest': 'sha256:served' });
    }
    return json(
      401,
      {},
      {
        'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${REPO}:pull"`,
      },
    );
  });
}

function stubHostedAgent(image: string | undefined) {
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
  // A Fly fleet IS configured, so a probe that reached for the fleet's org
  // credential could find one. It must not.
  vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
  vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
  vi.stubEnv('MOTIR_RUNNER_IMAGE', `ghcr.io/motir-co/motir-ci-runner@sha256:${'a'.repeat(64)}`);
  vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, image);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('verifyHostedAgentImagePullable', () => {
  it('answers `not_applicable` under the fake orchestrator', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv(HOSTED_AGENT_IMAGE_ENV_VAR, IMAGE);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(verifyHostedAgentImagePullable()).resolves.toMatchObject({
      verdict: 'not_applicable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `not_applicable` when the variable is unset', async () => {
    stubHostedAgent(undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const verdict = await verifyHostedAgentImagePullable();
    expect(verdict).toMatchObject({ verdict: 'not_applicable' });
    expect((verdict as { detail: string }).detail).toContain(HOSTED_AGENT_IMAGE_ENV_VAR);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `bootable` with the digest, sending no credential of its own', async () => {
    stubHostedAgent(IMAGE);
    const calls: Call[] = [];
    vi.stubGlobal('fetch', ghcrLike(true, calls));

    await expect(verifyHostedAgentImagePullable()).resolves.toEqual({
      verdict: 'bootable',
      reference: IMAGE,
      digest: 'sha256:served',
    });

    // The token request carries NO client credential — no Basic, nothing.
    const tokenCalls = calls.filter((c) => c.url.pathname === '/token');
    expect(tokenCalls.length).toBeGreaterThan(0);
    for (const call of tokenCalls) expect(call.authorization).toBeUndefined();
    // The manifest requests carry nothing, or exactly the registry's anonymous token.
    const manifestCalls = calls.filter((c) => c.url.pathname.includes('/manifests/'));
    expect(manifestCalls.length).toBeGreaterThan(0);
    for (const call of manifestCalls) {
      expect([undefined, `Bearer ${ANON_TOKEN}`]).toContain(call.authorization);
    }
    expect(calls.some((c) => c.authorization?.startsWith('Basic '))).toBe(false);
    expect(calls.every((c) => c.url.host === 'ghcr.io')).toBe(true);
  });

  it('answers `unpullable` on a definite refusal, naming the reference', async () => {
    stubHostedAgent(IMAGE);
    const calls: Call[] = [];
    vi.stubGlobal('fetch', ghcrLike(false, calls));

    const verdict = await verifyHostedAgentImagePullable();
    expect(verdict).toMatchObject({ verdict: 'unpullable', reference: IMAGE });
    expect((verdict as { detail: string }).detail).toContain('ghcr.io');
    expect(calls.some((c) => c.authorization?.startsWith('Basic '))).toBe(false);
  });

  it('answers `indeterminate` on a transport failure, and never throws', async () => {
    stubHostedAgent(IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      }),
    );
    await expect(verifyHostedAgentImagePullable()).resolves.toMatchObject({
      verdict: 'indeterminate',
      reference: IMAGE,
    });
  });

  it.each([
    ['a tag', 'ghcr.io/motir-co/motir-hosted-agent:main', 'pinned by digest'],
    [
      'a registry.fly.io mirror',
      `registry.fly.io/motir-hosted-agent@sha256:${'c'.repeat(64)}`,
      'pulls anonymously',
    ],
  ])(
    'answers `unpullable` without a request for %s, which no VM can pull',
    async (_case, image, detail) => {
      stubHostedAgent(image);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const verdict = await verifyHostedAgentImagePullable();
      expect(verdict).toMatchObject({ verdict: 'unpullable', reference: image });
      expect((verdict as { detail: string }).detail).toContain(detail);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
