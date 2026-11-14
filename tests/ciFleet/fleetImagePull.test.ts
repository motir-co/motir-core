import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { verifyFleetBootable, verifyIndexFleetBootable } from '@/lib/orchestrator';
import type { EcrRegistryCredentialReader } from '@/lib/awsServices/ecrRegistryCredential';

// THE FLEET BOOT PREFLIGHT (Story MOTIR-1916 · MOTIR-2006) — §7 of
// `docs/decisions/fleet-image-pull.md`.
//
// ⚠️ §6.1's half — the probe itself and its parsers — moved to
// `packages/orchestrator/test/imagePull.test.ts` with the code (MOTIR-4300).
// What is here is the part that is about THIS APP: `verifyFleetBootable` and
// `verifyIndexFleetBootable` read this deployment's configuration through the
// composition root, which is exactly what a package cannot do.
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

let urls: string[];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A registry that behaves exactly like GHCR — challenge the anonymous manifest
 * GET with a per-REPOSITORY scope, hand out a token only for `publicRepos`, then
 * serve the manifest to a bearer.
 *
 * Per-repository is the whole point: a fixture whose challenge always named the
 * same repo would answer "public" for every input, and the test that consumes it
 * exists to prove the probe distinguishes.
 */
function ghcrLike(publicRepos: string[]) {
  return async (rawUrl: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(rawUrl);
    urls.push(rawUrl);

    if (url.pathname === '/token') {
      const scope = url.searchParams.get('scope') ?? '';
      return publicRepos.some((repo) => scope.includes(repo))
        ? json(200, { token: 'anon-pull-token' })
        : json(401, { errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] });
    }

    const repository = /^\/v2\/(.+)\/manifests\//.exec(url.pathname)?.[1] ?? '';
    const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
    if (auth) return json(200, {}, { 'docker-content-digest': 'sha256:served' });
    return json(
      401,
      {},
      {
        'www-authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${repository}:pull"`,
      },
    );
  };
}

beforeEach(() => {
  urls = [];
});

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

// ── THE INDEXER IMAGE'S OWN PREFLIGHT (MOTIR-2030) ───────────────────────────
//
// `docs/decisions/fleet-image-pull.md` §5's third constraint, in one sentence:
// "It is a second pull path. The fleet then has two, and each needs §6's
// preflight independently." MOTIR-1989 added the second path; until now
// `verifyFleetBootable()` probed one image and the indexer's was checked by
// nothing.
//
// §5's SECOND constraint is why this is the path that matters most:
// `registry.fly.io` garbage-collects UNREFERENCED images, and a fleet whose
// machines are ephemeral by design references nothing between jobs. So the image
// more likely to vanish was the one with no assertion over it — the MOTIR-1980
// shape ("every predicate answers configured") re-opened one workload over.
//
// The fixtures below give the two paths DIFFERENT references on purpose. A test
// where both images are the same string would pass for a preflight that probed
// the runner's image twice, which is precisely the bug being fixed.

const INDEXER_IMAGE =
  'registry.fly.io/motir-ci-fleet/motir-indexer@sha256:9f2c1ab4de77c0138a6d5e4b2f0c9a7318e4d6b5c2019fae83d7c4b6e5109a2d';

/**
 * ⚠️ CORRECTED (MOTIR-3606). THIS CONSTANT WAS THE BUG, AND IT WAS A FIXTURE
 * RATHER THAN A LINE OF SHIPPED CODE.
 *
 * It used to read
 * `Bearer realm="https://registry.fly.io/token",service="registry.fly.io",scope="…"`
 * — a Fly registry that speaks the GHCR dialect. **No such registry exists.**
 * Measured against the live one on 2026-08-27, three requests, verbatim:
 *
 *   registry.fly.io · the production indexer digest  → 401 · `Basic realm="flyio-registry.fly.dev"`
 *   registry.fly.io · a repository that DOES NOT EXIST → 401 · BYTE-IDENTICAL
 *   registry.fly.io · the same digest, `Authorization: Basic` with the org token
 *                                                     → **200** · `docker-content-digest: sha256:0b4d2747…`
 *
 * So the shipped probe — which understands only a Bearer challenge — could never
 * return anything but `unpullable` for a Fly-mirrored image, and could never
 * distinguish an intact mirror from a garbage-collected one, which is the single
 * fault §5's second constraint says this preflight exists to catch. Production
 * dead-lettered `system.daily-health-check` every morning from 2026-08-04 to
 * 2026-08-26 on an image that was intact the entire time.
 *
 * **Every test in this file was green throughout**, because this fixture
 * described a registry nobody had asked. That is the whole lesson of the card:
 * a fixture is a CLAIM about the wire, and a claim nobody measured is not
 * evidence — least of all for a probe whose only value is being right about a
 * registry it can no longer reach in a unit test.
 */
const FLY_BASIC_CHALLENGE = 'Basic realm="flyio-registry.fly.dev"';

describe('verifyIndexFleetBootable — §5.3: the fleet has TWO pull paths, and each needs its own preflight', () => {
  /** A cloud deployment wired for CI. `indexerImage` omitted = indexing not
   *  wired, which is the state the `not_applicable` arm exists for. */
  function stubIndexEnv(indexerImage?: string) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', PUBLIC_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', indexerImage ?? '');
  }

  /**
   * `registry.fly.io` as it actually behaves — the corrected fixture.
   *
   * Basic, never Bearer. No `/token` endpoint at all: an anonymous caller gets a
   * 401 and nothing else, whether or not the repository exists. A caller
   * presenting `Authorization: Basic` is served the manifest for a repository in
   * `presentRepos` and gets a 404 for one that has been collected — which is the
   * DISTINCTION the old fixture could not express, because anonymously the two
   * are the same 401.
   */
  function flyLike(presentRepos: string[]) {
    return vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(rawUrl));
      const repository = /^\/v2\/(.+)\/manifests\//.exec(url.pathname)?.[1] ?? '';
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      if (!auth) return json(401, {}, { 'www-authenticate': FLY_BASIC_CHALLENGE });
      if (!auth.startsWith('Basic ')) {
        return json(401, {}, { 'www-authenticate': FLY_BASIC_CHALLENGE });
      }
      return presentRepos.includes(repository)
        ? json(200, {}, { 'docker-content-digest': 'sha256:9f2c1ab4' })
        : json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    });
  }

  it("probes the INDEXER image — not the runner's — and answers `bootable`", async () => {
    stubIndexEnv(INDEXER_IMAGE);
    const fetchSpy = flyLike(['motir-ci-fleet/motir-indexer']);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyIndexFleetBootable()).resolves.toEqual({
      verdict: 'bootable',
      reference: INDEXER_IMAGE,
      digest: 'sha256:9f2c1ab4',
    });
    // The manifest call went to Fly's registry for the indexer's repository. A
    // preflight that re-probed `MOTIR_RUNNER_IMAGE` would have hit ghcr.io.
    // ⚠️ Compare the parsed HOST, never a substring of the URL: `ghcr.io` can
    // appear in a path or query of a request to somewhere else entirely, so a
    // substring test both under- and over-matches (CodeQL
    // `js/incomplete-url-substring-sanitization`).
    const hosts = fetchSpy.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(hosts).toContain('registry.fly.io');
    expect(hosts).not.toContain('ghcr.io');
  });

  it('answers `unpullable` naming the INDEXER reference — §5.2 GC is the likeliest cause', async () => {
    // The garbage-collected mirror, caught. `absent` is exactly what a registry
    // says about a digest it has cleaned up — and it says it ONLY to a caller it
    // has authenticated. This is the assertion the pre-MOTIR-3606 probe could
    // not make honestly: anonymously, a collected mirror and an intact one are
    // the same 401.
    stubIndexEnv(INDEXER_IMAGE);
    const fetchSpy = flyLike([]); // the repository is gone
    vi.stubGlobal('fetch', fetchSpy);

    const verdict = await verifyIndexFleetBootable();

    expect(verdict.verdict).toBe('unpullable');
    // ⚠️ THE INDEXER'S reference, never the runner's. The operator surface is a
    // message; naming the wrong image sends the fix to the wrong registry.
    expect(verdict).toMatchObject({ reference: INDEXER_IMAGE });
    expect((verdict as { reference: string }).reference).not.toBe(PUBLIC_IMAGE);
    expect((verdict as { detail: string }).detail).toContain('registry.fly.io');
    expect((verdict as { detail: string }).detail).toContain('absent');
    // The verdict came from an AUTHENTICATED read. Without the credential there
    // is no 404 to see, so there is no `absent` to report.
    const auths = fetchSpy.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string> | undefined)?.['authorization'],
    );
    expect(auths.some((a) => a?.startsWith('Basic '))).toBe(true);
  });

  it('is BOOTABLE against the real Basic-auth registry — the 23-day false alarm, gone', async () => {
    // ⚠️ THE REGRESSION THIS CARD EXISTS FOR (MOTIR-3606). With the corrected
    // fixture and the shipped probe as it stood on 2026-08-26, this call
    // returned `unpullable` — every night, for 23 nights, about an image that
    // was serving 200s to anyone holding the org token the whole time.
    stubIndexEnv(INDEXER_IMAGE);
    vi.stubGlobal('fetch', flyLike(['motir-ci-fleet/motir-indexer']));

    await expect(verifyIndexFleetBootable()).resolves.toEqual({
      verdict: 'bootable',
      reference: INDEXER_IMAGE,
      digest: 'sha256:9f2c1ab4',
    });
  });

  it('is INDETERMINATE, not `unpullable`, when the fleet credential cannot be read', async () => {
    // The credential resolver reads `flyFleetConfig()`, which throws on a
    // deployment missing the fleet's token — and a probe with no credential for a
    // Basic registry knows NOTHING about the image. Saying so is the only honest
    // verdict, and it is deliberately not loud: an operator paged about an image
    // the probe never asked about is the false alarm that trains them to ignore
    // the row.
    //
    // `MOTIR_INDEXER_IMAGE` alone is not enough to reach the probe at all
    // (`indexFleetConfig()` demands the fleet too), so the token is stubbed
    // present for config and the resolver is starved by pointing the image at a
    // registry it has no credential for.
    stubIndexEnv('registry.example.invalid/motir/indexer@sha256:' + 'a'.repeat(64));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, {}, { 'www-authenticate': FLY_BASIC_CHALLENGE })),
    );

    const verdict = await verifyIndexFleetBootable();

    expect(verdict.verdict).toBe('indeterminate');
    expect((verdict as { detail: string }).detail).toContain('basic');
    expect((verdict as { detail: string }).detail).toContain('no credential is configured');
  });

  it('answers `indeterminate` — NOT `unpullable` — when the registry cannot be reached', async () => {
    // The same boundary its twin holds: a transport failure is never a claim
    // about the image.
    stubIndexEnv(INDEXER_IMAGE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.fly.io');
      }),
    );

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({
      verdict: 'indeterminate',
      reference: INDEXER_IMAGE,
    });
  });

  it('answers `not_applicable` when MOTIR_INDEXER_IMAGE is UNSET on a working CI deployment', async () => {
    // ⚠️ THE ARM THIS CARD EXISTS FOR. A deployment that runs CI but has not
    // wired the indexer simply does not INDEX — it is not broken — and reporting
    // it `unpullable` would fail a daily health check over a feature nobody
    // enabled. That false alarm is what teaches an operator to ignore the row,
    // which is how the next MOTIR-1980 gets missed.
    stubIndexEnv(); // fleet fully configured; only the indexer image is absent
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    const verdict = await verifyIndexFleetBootable();

    expect(verdict.verdict).toBe('not_applicable');
    expect(fetchSpy).not.toHaveBeenCalled();
    // And the RUNNER path on the very same deployment is unaffected — the two
    // verdicts are independent, which is the whole point of splitting them. It
    // is probed with the GHCR fixture, because the runner's image IS on GHCR;
    // pointing the Fly fixture at it would assert the wrong wire shape, which is
    // the mistake MOTIR-3606 was made of.
    vi.stubGlobal('fetch', vi.fn(ghcrLike([])));
    await expect(verifyFleetBootable()).resolves.toMatchObject({ verdict: 'unpullable' });
  });

  it('answers `not_applicable` on the fake adapter, and touches no network', async () => {
    // `indexFleetConfig()` returns a well-formed fake DIGEST under the fake
    // adapter, so a preflight that probed it unconditionally would try to reach
    // a registry for `motir/indexer@sha256:fake`. It must not.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', INDEXER_IMAGE);
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers `not_applicable` on an UNWIRED deployment — a self-hosted build is not a fault', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', '');
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({ verdict: 'not_applicable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── THE ECR-HOSTED INDEXER (MOTIR-11277) ─────────────────────────────────────
//
// Since MOTIR-10123 the AWS deployment pins `MOTIR_INDEXER_IMAGE` to a digest in
// core's own `motir/indexer` ECR repository, and indexes on the AWS pool
// (`MOTIR_INDEX_FLEET_PROVIDER=aws`). The preflight probed that digest with the
// Fly-only credential resolver, ECR's anonymous 401 is `Basic`, and so the
// verdict was `indeterminate` on every run from 2026-11-11 until the daily
// health check dead-lettered on 2026-11-14 with the very sentence the
// reproduction below asserts.
//
// The fixture is ECR's documented registry-API behaviour, and the challenge is
// the one production quoted: an anonymous manifest GET is `401 · Basic`
// whatever the digest; a GET carrying `Basic base64(AWS:<token password>)` is
// served the manifest (200 + `docker-content-digest`) for a digest the
// repository holds and `404 MANIFEST_UNKNOWN` for one it does not.

const ECR_HOST = '944842271421.dkr.ecr.us-east-1.amazonaws.com';
const ECR_DIGEST = `sha256:2f91d206${'a'.repeat(56)}`;
const ECR_INDEXER_IMAGE = `${ECR_HOST}/motir/indexer@${ECR_DIGEST}`;
const ECR_BASIC_CHALLENGE = `Basic realm="https://${ECR_HOST}/",service="ecr.amazonaws.com"`;
/** What ECR's GetAuthorizationToken decodes to: `AWS:<password>`. */
const ECR_PASSWORD = 'eyJwYXlsb2FkIjoiZWNyLXB1bGwtdG9rZW4ifQ==';
const ECR_AUTHORIZATION = `Basic ${Buffer.from(`AWS:${ECR_PASSWORD}`).toString('base64')}`;

describe('verifyIndexFleetBootable — an ECR-hosted indexer image (MOTIR-11277)', () => {
  /** The AWS deployment: indexing on the pool, the indexer pinned in ECR. */
  function stubAwsIndexEnv(image = ECR_INDEXER_IMAGE) {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('MOTIR_INDEX_FLEET_PROVIDER', 'aws');
    vi.stubEnv('MOTIR_INDEXER_IMAGE', image);
  }

  /** ECR's registry API: Basic only, and the manifest only to ECR's own login. */
  function ecrLike(presentDigests: string[]) {
    return vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
      urls.push(String(rawUrl));
      const url = new URL(String(rawUrl));
      const digest = /\/manifests\/(.+)$/.exec(url.pathname)?.[1] ?? '';
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      if (auth !== ECR_AUTHORIZATION) {
        return json(401, {}, { 'www-authenticate': ECR_BASIC_CHALLENGE });
      }
      return presentDigests.includes(digest)
        ? json(200, {}, { 'docker-content-digest': digest })
        : json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    });
  }

  /** A fake ECR that issues the token above, recording what it was asked. */
  function ecrIssuing(): EcrRegistryCredentialReader & { asked: unknown[] } {
    const asked: unknown[] = [];
    return {
      asked,
      async credentialFor(registry) {
        asked.push(registry);
        return { username: 'AWS', password: ECR_PASSWORD };
      },
    };
  }

  it('is BOOTABLE for a digest the repository holds, probed with an ECR-issued credential', async () => {
    stubAwsIndexEnv();
    const fetchSpy = ecrLike([ECR_DIGEST]);
    vi.stubGlobal('fetch', fetchSpy);
    const ecr = ecrIssuing();

    await expect(verifyIndexFleetBootable(ecr)).resolves.toEqual({
      verdict: 'bootable',
      reference: ECR_INDEXER_IMAGE,
      digest: ECR_DIGEST,
    });
    // The token was minted for the registry the PIN names, in its region.
    expect(ecr.asked).toEqual([
      { host: ECR_HOST, registryId: '944842271421', region: 'us-east-1' },
    ]);
    // And the manifest GET that answered carried exactly ECR's `AWS:<password>`.
    const auths = fetchSpy.mock.calls.map(
      (c) => (c[1]?.headers as Record<string, string> | undefined)?.['authorization'],
    );
    expect(auths).toContain(ECR_AUTHORIZATION);
    expect(new Set(fetchSpy.mock.calls.map((c) => new URL(String(c[0])).host))).toEqual(
      new Set([ECR_HOST]),
    );
  });

  it('is UNPULLABLE, naming the ECR reference, for a digest the repository does not hold', async () => {
    stubAwsIndexEnv();
    vi.stubGlobal('fetch', ecrLike([])); // the digest is gone

    const verdict = await verifyIndexFleetBootable(ecrIssuing());

    expect(verdict).toMatchObject({ verdict: 'unpullable', reference: ECR_INDEXER_IMAGE });
    expect((verdict as { detail: string }).detail).toContain(ECR_HOST);
    expect((verdict as { detail: string }).detail).toContain('absent');
  });

  it.each([
    [
      'no permission',
      Object.assign(
        new Error(
          'User: arn:aws:sts::944842271421:assumed-role/core-worker/x is not authorized to perform: ecr:GetAuthorizationToken',
        ),
        { name: 'AccessDeniedException' },
      ),
      'AccessDeniedException',
    ],
    [
      'a transport error',
      new Error('connect ETIMEDOUT api.ecr.us-east-1.amazonaws.com'),
      'ETIMEDOUT',
    ],
    ['a non-Error rejection', 'socket hang up', 'socket hang up'],
  ])(
    'is INDETERMINATE — never `unpullable` — when the ECR token cannot be obtained (%s), naming the cause',
    async (_label, failure, cause) => {
      stubAwsIndexEnv();
      const fetchSpy = ecrLike([ECR_DIGEST]);
      vi.stubGlobal('fetch', fetchSpy);

      const verdict = await verifyIndexFleetBootable({
        credentialFor: () => Promise.reject(failure),
      });

      expect(verdict).toMatchObject({ verdict: 'indeterminate', reference: ECR_INDEXER_IMAGE });
      const detail = (verdict as { detail: string }).detail;
      expect(detail).toContain('could not obtain an ECR authorization token');
      expect(detail).toContain(ECR_HOST);
      expect(detail).toContain(cause);
      // The image was never asked about, so nothing is claimed about it.
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('reads the token through the SDK when no reader is handed in (the production path)', async () => {
    stubAwsIndexEnv();
    vi.stubGlobal('fetch', ecrLike([ECR_DIGEST]));
    const send = vi.spyOn(ECRClient.prototype, 'send').mockImplementation((async () => ({
      authorizationData: [
        { authorizationToken: Buffer.from(`AWS:${ECR_PASSWORD}`).toString('base64') },
      ],
    })) as never);

    await expect(verifyIndexFleetBootable()).resolves.toMatchObject({ verdict: 'bootable' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(GetAuthorizationTokenCommand);
  });

  it('asks ECR nothing for a reference it cannot parse, and answers `indeterminate`', async () => {
    stubAwsIndexEnv(`@${ECR_DIGEST}`); // no repository at all
    const fetchSpy = vi.fn(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchSpy);
    const ecr = ecrIssuing();

    await expect(verifyIndexFleetBootable(ecr)).resolves.toMatchObject({
      verdict: 'indeterminate',
    });
    expect(ecr.asked).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the Fly org credential for a `registry.fly.io` indexer — and never asks ECR', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', 'fly_fleet_token');
    vi.stubEnv('FLY_FLEET_APP', 'motir-ci-fleet');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', PUBLIC_IMAGE);
    vi.stubEnv('MOTIR_INDEXER_IMAGE', INDEXER_IMAGE);
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      return auth === `Basic ${Buffer.from('x:fly_fleet_token').toString('base64')}`
        ? json(200, {}, { 'docker-content-digest': 'sha256:fly' })
        : json(401, {}, { 'www-authenticate': FLY_BASIC_CHALLENGE });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const ecr = ecrIssuing();

    await expect(verifyIndexFleetBootable(ecr)).resolves.toMatchObject({ verdict: 'bootable' });
    expect(ecr.asked).toEqual([]);
  });
});
