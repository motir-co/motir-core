import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyFleetBootable } from '@/lib/orchestrator';

// THE FLEET BOOT PREFLIGHT (Story MOTIR-1916 · MOTIR-2006) — §7 of
// `docs/decisions/fleet-image-pull.md`.
//
// ⚠️ §6.1's half — the probe itself and its parsers — moved to
// `packages/orchestrator/test/imagePull.test.ts` with the code (MOTIR-4300).
// What is here is the part that is about THIS APP: `verifyFleetBootable` reads
// this deployment's configuration through the composition root, which is
// exactly what a package cannot do. (Its indexer twin, `verifyIndexFleetBootable`,
// and the ECR-hosted indexer's preflight left with the index fleet in MOTIR-12037.)
//
// The assertion MOTIR-1980 did not have. The fleet shipped code-complete and
// unable to boot a single container while `isFlyFleetConfigured()` answered
// `true` throughout, because "three env vars are non-empty" was all it ever
// checked. These tests pin the predicate that DOES ask the real question, and —
// just as importantly — pin the boundary between its three answers: pullable,
// definitely not pullable, and could-not-tell. Collapsing the last two is how a
// registry blip becomes "your image is private" and how a private image hides
// behind a retry.
//
// ⚠️ THE FIXTURES ARE MEASURED, NOT INVENTED. Every wire shape below was
// observed against ghcr.io and api.machines.dev on 2026-08-02 (recorded in the
// ADR §2.1–§2.2 and re-run by MOTIR-2006):
//
//   * public  → GET /token returns {"token":"…"}, then the manifest GET returns
//     200 with `content-type: application/vnd.oci.image.index.v1+json`.
//   * private → GET /token returns
//     {"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}
//     with HTTP 401, and the pull never happens.
//
// No database, no network. `fetch` is the only fake.

const PUBLIC_IMAGE =
  'ghcr.io/motir-co/motir-ci-runner@sha256:446c692df68c80367876c65082c60ec3b1c667f32a98811ac53f0dfa8a0e6d1d';
const PRIVATE_IMAGE = 'ghcr.io/motir-co/motir-sandbox:claude';

/** GHCR's real challenge header, copied from a live 401. */
const GHCR_CHALLENGE =
  'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:motir-co/motir-ci-runner:pull"';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('verifyFleetBootable — §7: the predicate `isFlyFleetConfigured()` deliberately is NOT', () => {
  function stubFleetEnv(image: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', image);
  }

  it('answers `bootable` when the configured image resolves anonymously', async () => {
    stubFleetEnv(PUBLIC_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth
          ? json(200, {}, { 'docker-content-digest': 'sha256:446c692d' })
          : json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );

    await expect(verifyFleetBootable()).resolves.toEqual({
      verdict: 'bootable',
      reference: PUBLIC_IMAGE,
      digest: 'sha256:446c692d',
    });
  });

  it("answers `unpullable` — WITH the image reference and the registry's words — for a private image", async () => {
    // THE MOTIR-1980 CASE, caught. This is the exact state the fleet shipped in:
    // configured, and unable to pull anything.
    stubFleetEnv(PRIVATE_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') {
          return json(401, {
            errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }],
          });
        }
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );

    const verdict = await verifyFleetBootable();

    expect(verdict.verdict).toBe('unpullable');
    // The reference is IN the verdict, because the operator surface renders the
    // verdict and "the fleet is unhealthy" is not a fix.
    expect(verdict).toMatchObject({ reference: PRIVATE_IMAGE });
    expect((verdict as { detail: string }).detail).toContain('ghcr.io');
    expect((verdict as { detail: string }).detail).toContain('unauthorized');
  });

  it('answers `indeterminate` — NOT `unpullable` — when the registry cannot be reached', async () => {
    stubFleetEnv(PUBLIC_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    await expect(verifyFleetBootable()).resolves.toMatchObject({
      verdict: 'indeterminate',
      reference: PUBLIC_IMAGE,
    });
  });

  it('answers `not_applicable` on the fake adapter, and touches no network', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `not_applicable` on an UNWIRED deployment — a self-hosted build is not a fault', async () => {
    // The same posture `isOrchestratorConfigured()` holds: off-cloud there is no
    // fleet, so there is nothing here to be loud about. A preflight that failed
    // on every self-hosted install would be a daily false alarm.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
