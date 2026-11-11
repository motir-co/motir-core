import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  challengeScheme,
  OrchestratorImageUnpullableError,
  parseBearerChallenge,
  parseImageReference,
  probeImagePull,
  readImageCreated,
  readImageLabels,
} from '../src/index';

// THE IMAGE-PULL PROBE (Story MOTIR-1916 · MOTIR-2006) — §6.1 of
// `docs/decisions/fleet-image-pull.md`.
//
// ⚠️ SPLIT OUT OF `tests/ciFleet/fleetImagePull.test.ts` (MOTIR-4300). That file
// covered TWO things at once: this probe, which is the package's, and
// `verifyFleetBootable`, which is the app's composition root reading this
// deployment's configuration. When the probe moved into `@motir/orchestrator`
// the file could not follow it — the app half cannot be tested from here — so
// the file was CUT rather than copied, and neither half lost an assertion. What
// stayed behind still reads `probeImagePull` through the app's re-export, which
// is the seam it actually exercises.
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

describe('parseImageReference — the registry a reference actually names', () => {
  it('splits a digest-pinned GHCR reference into host, repository and digest', () => {
    expect(parseImageReference(PUBLIC_IMAGE)).toEqual({
      registry: 'ghcr.io',
      repository: 'motir-co/motir-ci-runner',
      reference: 'sha256:446c692df68c80367876c65082c60ec3b1c667f32a98811ac53f0dfa8a0e6d1d',
      isDigest: true,
    });
  });

  it('splits a tagged reference and marks it as NOT a digest', () => {
    expect(parseImageReference(PRIVATE_IMAGE)).toMatchObject({
      registry: 'ghcr.io',
      repository: 'motir-co/motir-sandbox',
      reference: 'claude',
      isDigest: false,
    });
  });

  it('defaults a bare name to Docker Hub AND to the implicit `library/` namespace', () => {
    // `ubuntu` means `registry-1.docker.io/library/ubuntu:latest`. Only Hub does
    // this, and getting it wrong would probe a URL that 404s and report a real
    // public image as absent.
    expect(parseImageReference('ubuntu')).toEqual({
      registry: 'registry-1.docker.io',
      repository: 'library/ubuntu',
      reference: 'latest',
      isDigest: false,
    });
  });

  it('treats a first segment WITHOUT a dot, colon or `localhost` as a Hub namespace', () => {
    expect(parseImageReference('moooon/motir:v2')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'moooon/motir',
      reference: 'v2',
    });
  });

  it('recognises `localhost:5000` and a host:port as registries, not namespaces', () => {
    expect(parseImageReference('localhost:5000/motir/runner:dev')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'motir/runner',
    });
  });

  it('does NOT mistake a registry port for a tag', () => {
    // `registry.example.com:5000/x` has a colon AFTER no slash-bounded tag. A
    // parser that took the last colon would probe `registry.example.com` for a
    // repository named `5000/x`.
    expect(parseImageReference('registry.example.com:5000/motir/runner')).toMatchObject({
      registry: 'registry.example.com:5000',
      repository: 'motir/runner',
      reference: 'latest',
    });
  });

  it('returns null for nonsense rather than guessing', () => {
    // A parser that guessed would report "private image" for what is really a
    // typo in MOTIR_RUNNER_IMAGE, and §6's preflight is only worth having if its
    // verdict can be trusted.
    expect(parseImageReference('')).toBeNull();
    expect(parseImageReference('   ')).toBeNull();
    expect(parseImageReference('ghcr.io/repo@')).toBeNull();
    expect(parseImageReference('@sha256:abc')).toBeNull();
    // A host with no repository at all — `https://ghcr.io/v2//manifests/latest`
    // is not a URL worth issuing.
    expect(parseImageReference('ghcr.io/')).toBeNull();
  });
});

describe('parseBearerChallenge — the WWW-Authenticate dance', () => {
  it("reads GHCR's real challenge into its params", () => {
    expect(parseBearerChallenge(GHCR_CHALLENGE)).toEqual({
      realm: 'https://ghcr.io/token',
      service: 'ghcr.io',
      scope: 'repository:motir-co/motir-ci-runner:pull',
    });
  });

  it('names the SCHEME separately, which is what tells a Basic registry from a broken Bearer one', () => {
    // ⚠️ THE DISTINCTION MOTIR-3606 ADDED. `parseBearerChallenge` returns null
    // for BOTH — and the probe used to read that one null as a refusal.
    expect(challengeScheme(GHCR_CHALLENGE)).toBe('bearer');
    expect(challengeScheme('Basic realm="flyio-registry.fly.dev"')).toBe('basic');
    expect(challengeScheme('Negotiate')).toBe('negotiate');
    expect(challengeScheme(null)).toBeNull();
    expect(challengeScheme('')).toBeNull();
  });

  it('reads params whatever their spacing and case, and stays linear on a hostile header', () => {
    // MOTIR-7816 — a scan replaced two regexes CodeQL flagged as polynomial.
    expect(parseBearerChallenge('  bearer   realm="r" ,service="s",scope="a:b:pull,push"')).toEqual(
      { realm: 'r', service: 's', scope: 'a:b:pull,push' },
    );
    expect(parseBearerChallenge('Bearer x-realm="no",realm="yes"')).toEqual({
      realm: 'yes',
    });
    expect(parseBearerChallenge('Bearer realm="unterminated')).toBeNull();
    expect(parseBearerChallenge('Bearerrealm="r"')).toBeNull();

    const started = performance.now();
    expect(parseBearerChallenge(`Bearer ${' '.repeat(100_000)}x`)).toBeNull();
    expect(parseBearerChallenge(`Bearer ${'A'.repeat(100_000)}`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('is null for a missing header, a non-Bearer scheme, or a Bearer with no realm', () => {
    expect(parseBearerChallenge(null)).toBeNull();
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge('Bearer service="ghcr.io"')).toBeNull();
  });
});

describe('probeImagePull — the question Fly asks at machine-create, asked early', () => {
  it('a PUBLIC digest resolves: token, then manifest, then `pullable: true`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        urls.push(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon-pull-token' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        if (!auth) return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
        return json(
          200,
          {},
          { 'docker-content-digest': 'sha256:446c692d', 'content-type': 'application/json' },
        );
      }),
    );

    const verdict = await probeImagePull(PUBLIC_IMAGE);

    expect(verdict).toEqual({
      pullable: true,
      reference: PUBLIC_IMAGE,
      registry: 'ghcr.io',
      digest: 'sha256:446c692d',
    });
    // The token request must carry the challenge's OWN service + scope — a probe
    // that hardcoded GHCR's would silently stop working on the §5 mirror.
    const tokenUrl = new URL(urls.find((u) => u.includes('/token')) as string);
    expect(tokenUrl.searchParams.get('service')).toBe('ghcr.io');
    expect(tokenUrl.searchParams.get('scope')).toBe('repository:motir-co/motir-ci-runner:pull');
  });

  it('a PRIVATE repository is `pullable: false` — the token endpoint refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        urls.push(String(rawUrl));
        if (url.pathname === '/token') {
          return json(401, {
            errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }],
          });
        }
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );

    const verdict = await probeImagePull(PRIVATE_IMAGE);

    expect(verdict).toMatchObject({ pullable: false, reason: 'unauthorized', registry: 'ghcr.io' });
    // No manifest fetch was attempted after the refusal — the question was
    // already answered, and a second call would only be noise in a log.
    expect(urls.filter((u) => u.includes('/manifests/'))).toHaveLength(1);
  });

  it('a registry that demands auth with NO bearer challenge is `unauthenticatable` — NOT `unauthorized`', async () => {
    // ⚠️ CORRECTED (MOTIR-3606). This assertion used to read `unauthorized`, and
    // that single word is the defect: it turns "I could not ask" into "the
    // registry said no", which is a claim about the IMAGE made from a fact about
    // the PROBE. Downstream, `unauthorized` is the loud arm — so a registry this
    // probe simply does not speak became a dead-lettered health check every
    // morning for 23 days.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, {})),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: null,
      reason: 'unauthenticatable',
      detail: expect.stringContaining('no credential is configured'),
    });
  });

  it('a BASIC challenge with no credential is `unauthenticatable`, and names the scheme', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(401, {}, { 'www-authenticate': 'Basic realm="flyio-registry.fly.dev"' }),
      ),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: null,
      reason: 'unauthenticatable',
      detail: expect.stringContaining('`basic`'),
    });
  });

  it('a BASIC challenge WITH a credential is retried authenticated, and resolves', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
      return auth
        ? json(200, {}, { 'docker-content-digest': 'sha256:authenticated' })
        : json(401, {}, { 'www-authenticate': 'Basic realm="flyio-registry.fly.dev"' });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      probeImagePull(PRIVATE_IMAGE, () => ({ username: 'x', password: 'fly_token' })),
    ).resolves.toMatchObject({ pullable: true, digest: 'sha256:authenticated' });

    // The header is real HTTP Basic, not a Bearer wearing the name — a registry
    // that got the wrong scheme would 401 and the verdict would flip.
    const sent = (fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>)['authorization'];
    expect(sent).toBe(`Basic ${Buffer.from('x:fly_token', 'utf8').toString('base64')}`);
  });

  it('a BASIC registry that 404s the AUTHENTICATED read is `absent` — the collected mirror', async () => {
    // The verdict the anonymous probe could never reach, and the only one worth
    // being loud about on `registry.fly.io`.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth
          ? json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] })
          : json(401, {}, { 'www-authenticate': 'Basic realm="flyio-registry.fly.dev"' });
      }),
    );
    await expect(
      probeImagePull(PRIVATE_IMAGE, () => ({ username: 'x', password: 'fly_token' })),
    ).resolves.toMatchObject({ pullable: false, reason: 'absent' });
  });

  it('a BASIC registry that refuses the SUPPLIED credential blames the credential, not the image', async () => {
    // Two different fixes, so two different sentences: an expired or wrong-org
    // token sends an operator to the registry's visibility page for nothing.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(401, {}, { 'www-authenticate': 'Basic realm="flyio-registry.fly.dev"' }),
      ),
    );
    await expect(
      probeImagePull(PRIVATE_IMAGE, () => ({ username: 'x', password: 'stale' })),
    ).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
      detail: expect.stringContaining('OWN registry credential'),
    });
  });

  it('a resolver that THROWS is read as "no credential", not as a crash', async () => {
    // ⚠️ THE PROBE NEVER THROWS, and a resolver is caller code — so the guarantee
    // has to be enforced where it is declared. This repository's configuration
    // accessors throw on an unwired deployment BY DESIGN (`flyFleetConfig()` and
    // its siblings), which makes a throwing resolver the ordinary case on a
    // self-hosted build rather than an exotic one. A `try` in each resolver would
    // be the same code per registry, and the first one written without it would
    // take down a health check instead of returning a verdict.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(401, {}, { 'www-authenticate': 'Basic realm="flyio-registry.fly.dev"' }),
      ),
    );
    await expect(
      probeImagePull(PRIVATE_IMAGE, () => {
        throw new Error('set FLY_FLEET_API_TOKEN, FLY_FLEET_APP and MOTIR_RUNNER_IMAGE');
      }),
    ).resolves.toMatchObject({ pullable: null, reason: 'unauthenticatable' });
  });

  it('a resolver returning `undefined` is read as "no credential" too', async () => {
    // The resolver's type admits `undefined` because a lookup that misses is the
    // natural shape of "not this registry"; a `?? null` at the call site is what
    // keeps that from becoming an `Authorization: Basic undefined`.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(401, {}, { 'www-authenticate': 'Basic realm="flyio-registry.fly.dev"' }),
      ),
    );
    await expect(probeImagePull(PRIVATE_IMAGE, () => undefined)).resolves.toMatchObject({
      pullable: null,
      reason: 'unauthenticatable',
    });
  });

  it('a BEARER registry is NEVER offered the credential — a private image stays private', async () => {
    // ⚠️ THE GUARD ON THE FIX. A credential resolver must not turn "this GHCR
    // image is private" into a green preflight: Fly's machine-create has no
    // field to hand that credential over, so anonymous really is the question
    // there. The resolver is consulted only for a challenge the anonymous dance
    // cannot answer.
    const resolver = vi.fn(() => ({ username: 'x', password: 'should-not-be-used' }));
    vi.stubGlobal('fetch', vi.fn(ghcrLike([])));

    await expect(probeImagePull(PRIVATE_IMAGE, resolver)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('a token endpoint that answers 200 with NO token is still `unauthorized`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { expires_in: 300 });
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });

  it('a token endpoint that answers 200 with a NON-JSON body is `unauthorized`, not a crash', async () => {
    // A proxy or a captive portal in front of the registry answers HTML with a
    // 200. Parsing must not throw out of a probe whose whole contract is that it
    // never throws.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') {
          return new Response('<html>sign in</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });

  it('a thrown NON-Error still produces a verdict rather than escaping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'undici exploded';
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: null,
      reason: 'unreachable',
      detail: expect.stringContaining('unknown'),
    });
  });

  it('accepts `access_token` as well as `token` — both are in the spec', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { access_token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth ? json(200, {}) : json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({ pullable: true });
  });

  it('a 404 is `absent` — a distinct diagnosis from "private"', async () => {
    // A garbage-collected `registry.fly.io` mirror (§5.2) and a private GHCR
    // package both stop the fleet, and the operator's next action is different
    // for each. The verdict says which.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] })),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'absent',
    });
  });

  it('any other hard NO is `refused` rather than being read as absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(500, {})),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'refused',
      detail: expect.stringContaining('500'),
    });
  });

  it('a 403 after a token is `unauthorized`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(rawUrl));
        if (url.pathname === '/token') return json(200, { token: 'anon' });
        const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
        return auth ? json(403, {}) : json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });

  it('a TRANSPORT failure is `pullable: null` — never a claim about the image', async () => {
    // ⚠️ THE ARM THAT KEEPS THE PREFLIGHT TRUSTWORTHY. If a DNS failure reported
    // "unpullable", the health check would page an operator about a private
    // image that is in fact public, and the row would be learned as noise.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io');
      }),
    );
    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({
      pullable: null,
      reason: 'unreachable',
      detail: expect.stringContaining('ENOTFOUND'),
    });
  });

  it('an unparseable reference is `pullable: null`, not `false`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, {})),
    );
    await expect(probeImagePull('  ')).resolves.toMatchObject({
      pullable: null,
      reason: 'unparseable',
      registry: null,
    });
  });

  it('the ghcr-like fixture distinguishes public from private — the probe is not matching everything', async () => {
    // A guard nobody has watched DISAGREE is a guard that may be answering the
    // same thing to every input. One registry fake, two repositories, two
    // verdicts.
    const registry = ghcrLike(['motir-ci-runner']);
    vi.stubGlobal(
      'fetch',
      vi.fn((rawUrl: string, init?: RequestInit) => registry(String(rawUrl), init)),
    );

    await expect(probeImagePull(PUBLIC_IMAGE)).resolves.toMatchObject({ pullable: true });
    await expect(probeImagePull(PRIVATE_IMAGE)).resolves.toMatchObject({
      pullable: false,
      reason: 'unauthorized',
    });
  });
});

describe('OrchestratorImageUnpullableError — the sentence that reaches the operator', () => {
  // It is not decoration. This message becomes
  // `ci_runner_provisioning_intent.failure_detail`, which the operator surface
  // renders verbatim — so every arm of it is the difference between a diagnosis
  // and "the orchestrator refused a call".
  it('names the image, the status and the registry error', () => {
    const err = new OrchestratorImageUnpullableError(
      'fly',
      400,
      PRIVATE_IMAGE,
      'failed to get manifest ghcr.io/motir-co/motir-sandbox:claude: unauthorized',
    );
    expect(err.message).toContain(PRIVATE_IMAGE);
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('failed to get manifest');
    expect(err.imageReference).toBe(PRIVATE_IMAGE);
    expect(err.code).toBe('ORCHESTRATOR_API_FAILED');
  });

  it('says "no response" rather than "HTTP null" when the provider never answered', () => {
    const err = new OrchestratorImageUnpullableError('fly', null, PRIVATE_IMAGE, 'socket hang up');
    expect(err.message).toContain('no response');
    expect(err.message).not.toContain('null');
  });

  it('omits an empty detail instead of trailing a bare colon', () => {
    const err = new OrchestratorImageUnpullableError('fly', 400, PRIVATE_IMAGE, '');
    expect(err.message).toContain('(HTTP 400)');
    expect(err.message).not.toContain('HTTP 400:');
  });
});

describe('readImageLabels — what the pinned image says about itself (MOTIR-10290)', () => {
  const INDEX = 'sha256:index';
  const AMD = 'sha256:amd64';
  const CONFIG = 'sha256:config';
  const LABEL = 'co.motir.ci-runner.tools';

  /** GHCR-shaped: challenge, anonymous token, then index → platform manifest → config. */
  function registry(
    overrides: {
      manifest?: (auth: boolean) => Response;
      platformManifest?: () => Response;
      config?: () => Response;
      token?: () => Response;
    } = {},
  ) {
    return vi.fn(async (rawUrl: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(rawUrl));
      urls.push(String(rawUrl));
      if (url.pathname === '/token') {
        return overrides.token?.() ?? json(200, { token: 'anon-pull-token' });
      }
      const auth = Boolean(
        (init?.headers as Record<string, string> | undefined)?.['authorization'],
      );
      if (!auth) return json(401, {}, { 'www-authenticate': GHCR_CHALLENGE });
      if (url.pathname.endsWith(`/manifests/${AMD}`)) {
        return (
          overrides.platformManifest?.() ??
          json(200, { schemaVersion: 2, config: { digest: CONFIG }, layers: [] })
        );
      }
      if (url.pathname.includes('/manifests/')) {
        return (
          overrides.manifest?.(auth) ??
          json(
            200,
            {
              mediaType: 'application/vnd.oci.image.index.v1+json',
              manifests: [
                { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
                { digest: AMD, platform: { os: 'linux', architecture: 'amd64' } },
              ],
            },
            { 'docker-content-digest': INDEX },
          )
        );
      }
      if (url.pathname.endsWith(`/blobs/${CONFIG}`)) {
        return (
          overrides.config?.() ??
          json(200, { config: { Labels: { [LABEL]: 'bash,git', other: 'x', n: 1 } } })
        );
      }
      return json(404, {});
    });
  }

  it("resolves an index to linux/amd64 and returns its config's string labels", async () => {
    vi.stubGlobal('fetch', registry());
    expect(await readImageLabels(PUBLIC_IMAGE)).toEqual({
      ok: true,
      reference: PUBLIC_IMAGE,
      digest: AMD,
      labels: { [LABEL]: 'bash,git', other: 'x' },
    });
    expect(urls.some((u) => u.includes('/token'))).toBe(true);
  });

  it('reads a single-platform manifest directly, and an image with no labels as none', async () => {
    vi.stubGlobal(
      'fetch',
      registry({
        manifest: () =>
          json(200, { config: { digest: CONFIG } }, { 'docker-content-digest': 'sha256:single' }),
        config: () => json(200, { config: {} }),
      }),
    );
    expect(await readImageLabels(PUBLIC_IMAGE)).toEqual({
      ok: true,
      reference: PUBLIC_IMAGE,
      digest: 'sha256:single',
      labels: {},
    });
  });

  it('answers each failure as a reason, never as an image with no labels', async () => {
    const cases: Array<[Parameters<typeof registry>[0], string]> = [
      [{ token: () => json(401, {}) }, 'unauthorized'],
      [{ manifest: () => json(404, {}) }, 'absent'],
      [{ manifest: () => json(500, {}) }, 'refused'],
      [{ manifest: () => new Response('not json', { status: 200 }) }, 'malformed'],
      [
        {
          manifest: () =>
            json(200, { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }),
        },
        'absent',
      ],
      [{ platformManifest: () => json(403, {}) }, 'unauthorized'],
      [{ platformManifest: () => new Response('[]', { status: 200 }) }, 'malformed'],
      [{ platformManifest: () => json(200, { config: {} }) }, 'malformed'],
      [{ config: () => json(404, {}) }, 'absent'],
      [{ config: () => new Response('nope', { status: 200 }) }, 'malformed'],
    ];
    for (const [overrides, reason] of cases) {
      vi.stubGlobal('fetch', registry(overrides));
      const read = await readImageLabels(PUBLIC_IMAGE);
      expect(read, reason).toMatchObject({ ok: false, reason });
    }
  });

  it('reports an unparseable reference and an unreachable registry', async () => {
    expect(await readImageLabels('   ')).toMatchObject({ ok: false, reason: 'unparseable' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    expect(await readImageLabels(PUBLIC_IMAGE)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('keeps a 401 when the challenge yields no token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, {}, { 'www-authenticate': 'Basic realm="x"' })),
    );
    expect(await readImageLabels(PUBLIC_IMAGE)).toMatchObject({
      ok: false,
      reason: 'unauthorized',
    });
  });
  // MOTIR-10882 — the same three reads, answering what a TAG resolves to and when
  // that image was built: the reference's own digest (the index's, which is what a
  // digest pin names), not the platform manifest's.
  describe('readImageCreated (MOTIR-10882)', () => {
    it("answers the reference's own digest and the config's created time", async () => {
      vi.stubGlobal(
        'fetch',
        registry({ config: () => json(200, { created: '2026-11-09T08:00:00.123456789Z' }) }),
      );
      expect(await readImageCreated('ghcr.io/motir-co/motir-hosted-agent:main')).toEqual({
        ok: true,
        reference: 'ghcr.io/motir-co/motir-hosted-agent:main',
        digest: INDEX,
        createdAt: '2026-11-09T08:00:00.123Z',
      });
    });

    it('answers a null time when the config records none or an unreadable one', async () => {
      for (const config of [{}, { created: 'yesterday' }, { created: 7 }]) {
        vi.stubGlobal('fetch', registry({ config: () => json(200, config) }));
        expect(await readImageCreated(PUBLIC_IMAGE)).toMatchObject({ ok: true, createdAt: null });
      }
    });

    it('answers a null digest when the registry sends none', async () => {
      vi.stubGlobal(
        'fetch',
        registry({
          manifest: () => json(200, { config: { digest: CONFIG } }),
          config: () => json(200, { created: '2026-11-09T08:00:00Z' }),
        }),
      );
      expect(await readImageCreated(PUBLIC_IMAGE)).toMatchObject({ ok: true, digest: null });
    });

    it('passes every failure through as its reason', async () => {
      vi.stubGlobal('fetch', registry({ manifest: () => json(404, {}) }));
      expect(await readImageCreated(PUBLIC_IMAGE)).toMatchObject({ ok: false, reason: 'absent' });
      expect(await readImageCreated('   ')).toMatchObject({ ok: false, reason: 'unparseable' });
    });
  });
});
