// CAN THIS IMAGE REFERENCE BE PULLED BY THE THING THAT WILL BOOT IT? (Story
// MOTIR-1916 · MOTIR-2006 · MOTIR-3606) — the OCI Distribution v2 probe behind
// the fleet's boot preflight.
//
// `docs/decisions/fleet-image-pull.md` is why this file exists, and §0 is the
// finding that shapes it: **the Fly Machines API has no registry-credential
// field at all** (§2.3, measured — there is no `registry_auth`, no `docker_auth`,
// no `image_pull_secret`). So for a THIRD-PARTY registry, "can Fly boot this
// image?" reduces exactly to "does the registry serve this manifest to an
// ANONYMOUS caller?" — a question this repository can ask directly, cheaply, and
// without Fly.
//
// ⚠️ THAT REDUCTION DOES NOT HOLD FOR THE PLATFORM'S OWN REGISTRY, AND ASSUMING
// IT DID COST 23 DAYS OF A RED HEALTH CHECK (MOTIR-3606). `registry.fly.io` is
// not a third party Fly has to be handed a credential for — it is Fly, and a
// Machine authenticates to it as the org. Which is precisely WHY §5 mirrors a
// closed image there. Measured 2026-08-27 against the live registry:
//
//   registry.fly.io · a real digest      → 401 · www-authenticate: Basic realm="flyio-registry.fly.dev"
//   registry.fly.io · a repo that is GONE → 401 · BYTE-IDENTICAL
//   ghcr.io         · a public image      → 401 · www-authenticate: Bearer realm="https://ghcr.io/token",…
//
// An anonymous probe against a Basic-auth registry therefore returns the SAME
// answer for an intact mirror and for one that was garbage-collected last night
// — which is the exact fault §5's second constraint says the preflight exists to
// catch. Reporting that answer as `unpullable` was not a conservative reading of
// a genuine refusal; it was a verdict carrying zero information, delivered
// loudly, every morning. So:
//
//   * a registry that challenges with **Bearer** is probed ANONYMOUSLY, unchanged
//     — that is what "public" means on GHCR and Docker Hub, and it is the
//     question that matters for an image Fly must pull as a stranger;
//   * a registry that challenges with a scheme this probe cannot satisfy
//     anonymously (**Basic**, or no challenge at all) is probed with a
//     CREDENTIAL when the caller supplied one for that host, and is otherwise
//     "could not tell" — never a claim about the image.
//
// The credential arrives as a RESOLVER the caller passes in, keyed by registry
// HOST. That keeps the file provider-neutral: it names no Fly concept, so it
// still lives OUTSIDE `adapters/fly/` and
// `tests/ciFleet/orchestratorPortBoundary.test.ts` still passes. The composition
// root — the one file permitted to name the adapter — is what marries a host to
// a token, exactly as it already marries the probe to the configured image.
//
// ⚠️ THREE-VALUED ON PURPOSE — `true` / `false` / "could not tell". A registry
// that refuses is a statement ABOUT THE IMAGE; a registry that cannot be reached,
// or cannot be asked at all, is a statement about the PROBE, and collapsing the
// two would let one DNS blip page an operator with "the runner image is private"
// (it isn't) or, worse, let a genuinely private image hide behind a retry. §6's
// preflight only fails loudly on the DEFINITE refusal; see
// `FleetBootableVerdict`.

/** How long one registry call may take. A preflight that hangs is a preflight
 *  that turns into a timeout somewhere less legible than here. */
const REGISTRY_TIMEOUT_MS = 10_000;

/** Docker Hub's real registry host — the one `nginx:latest` means. Hub is the
 *  only registry whose references omit their host, so it is the only one that
 *  needs naming here. */
const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

/** The manifest media types a v2 registry may answer with. All four, because a
 *  digest-pinned multi-arch reference resolves to an INDEX (`…index.v1+json` is
 *  what `ghcr.io/motir-co/motir-ci-runner@sha256:446c692d…` returns, measured
 *  2026-08-02) while a single-arch one resolves to a plain manifest — and a
 *  registry answers 404 for a media type the client did not accept. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/** An image reference, split into the two things a registry call needs. */
export interface ParsedImageReference {
  /** The registry HOST (`ghcr.io`, `registry.fly.io`, `registry-1.docker.io`). */
  readonly registry: string;
  /** The repository path, Hub-normalised (`ubuntu` → `library/ubuntu`). */
  readonly repository: string;
  /** A `sha256:…` digest or a tag — whatever the reference pinned. */
  readonly reference: string;
  /** True when `reference` is a digest, which is what §7.2 requires of the
   *  fleet's image. Carried out so a caller can say so without re-parsing. */
  readonly isDigest: boolean;
}

/** A username / password pair for a registry that authenticates with HTTP Basic.
 *
 *  Provider-neutral by construction — a host and two strings. `registry.fly.io`
 *  takes any username with the org token as the password, and a second platform
 *  registry would fill the same shape without this file learning its name. */
export interface RegistryBasicCredential {
  readonly username: string;
  readonly password: string;
}

/**
 * Resolve the credential to probe one registry HOST with, or null when the
 * caller has none for it.
 *
 * ⚠️ IT IS ONLY EVER CONSULTED FOR A CHALLENGE THIS PROBE CANNOT ANSWER
 * ANONYMOUSLY, and that is the whole point of passing it rather than a flat
 * credential. A Bearer registry keeps being asked the anonymous question —
 * "would a stranger be served this?" — because for GHCR and Docker Hub that IS
 * the question Fly's machine-create asks. Supplying a credential must never
 * turn a private third-party image into a green preflight.
 */
export type RegistryCredentialResolver = (
  registry: string,
) => RegistryBasicCredential | null | undefined;

/**
 * The probe's answer about one reference.
 *
 * `pullable: null` is the "could not tell" arm and it is NOT a failure — see the
 * header. Every arm carries `reference` so a log line names the image without
 * the caller re-assembling it.
 */
export type ImagePullVerdict =
  /** The registry served the manifest to the caller that will boot it — anonymously
   *  on a Bearer registry, or with the supplied credential on a Basic one. */
  | { pullable: true; reference: string; registry: string; digest: string | null }
  /** DEFINITE refusal. `unauthorized` = private (or the token endpoint said so);
   *  `absent` = the repository or digest does not exist; `refused` = any other
   *  hard registry NO. All three mean a Fly Machine create will 400. */
  | {
      pullable: false;
      reference: string;
      registry: string;
      reason: 'unauthorized' | 'absent' | 'refused';
      detail: string;
    }
  /** Could not tell: a transport failure, a reference this probe cannot parse,
   *  or a registry whose authentication scheme this probe cannot satisfy and for
   *  which no credential was supplied (`unauthenticatable`). Never a statement
   *  about the image. */
  | {
      pullable: null;
      reference: string;
      registry: string | null;
      reason: 'unreachable' | 'unparseable' | 'unauthenticatable';
      detail: string;
    };

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'unknown';
}

/** Does this first path segment name a HOST rather than a Docker Hub namespace?
 *  The standard rule, and the only one there is: a host has a dot or a port, or
 *  is literally `localhost`. `motir-co/motir-ci-runner` has neither, which is
 *  why an unqualified reference means Hub. */
function looksLikeRegistryHost(segment: string): boolean {
  return segment === 'localhost' || segment.includes('.') || segment.includes(':');
}

/**
 * Split `[registry/]repository[:tag|@digest]`.
 *
 * Returns null for a reference this cannot make sense of, which the caller turns
 * into `unparseable` — never into "unpullable". A parser that guessed would
 * report a private image for what is really a typo in an env var, and the whole
 * point of §6's preflight is that its verdict can be trusted.
 */
export function parseImageReference(image: string): ParsedImageReference | null {
  const trimmed = image.trim();
  if (trimmed.length === 0) return null;

  // The digest/tag split first: `@` is unambiguous, and for `:` only the LAST
  // one after the final `/` can be a tag (a registry host may carry `:port`).
  let name = trimmed;
  let reference = 'latest';
  let isDigest = false;
  const at = trimmed.indexOf('@');
  if (at >= 0) {
    name = trimmed.slice(0, at);
    reference = trimmed.slice(at + 1);
    isDigest = true;
  } else {
    const lastSlash = trimmed.lastIndexOf('/');
    const lastColon = trimmed.lastIndexOf(':');
    if (lastColon > lastSlash) {
      name = trimmed.slice(0, lastColon);
      reference = trimmed.slice(lastColon + 1);
    }
  }
  if (name.length === 0 || reference.length === 0) return null;

  const segments = name.split('/');
  let registry = DOCKER_HUB_REGISTRY;
  let repository = name;
  if (segments.length > 1 && looksLikeRegistryHost(segments[0] as string)) {
    registry = segments[0] as string;
    repository = segments.slice(1).join('/');
  } else if (segments.length === 1) {
    // `ubuntu` is `library/ubuntu` on Hub. Only Hub does this.
    repository = `library/${name}`;
  }
  if (repository.length === 0) return null;

  return { registry, repository, reference, isDigest };
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge.
 *
 * This is how a v2 registry says "ask that endpoint for a token first", and it
 * is the ONLY reason the probe needs two round-trips. Returning the params
 * verbatim (rather than hardcoding GHCR's) is what makes the probe work against
 * Hub and any other v2 registry unchanged.
 */
export function parseBearerChallenge(header: string | null): Record<string, string> | null {
  if (!header) return null;
  const challenge = header.trimStart();
  // A scan rather than a regex: the header is the registry's, and both regexes
  // this replaced backtracked polynomially on a long run of spaces or letters
  // (CodeQL js/polynomial-redos, MOTIR-7816).
  if (!/^bearer\s/i.test(challenge)) return null;
  const params = parseAuthParams(challenge.slice('bearer'.length));
  return params['realm'] ? params : null;
}

/** Every `name="value"` pair in a challenge's parameter list, in one linear pass. */
function parseAuthParams(input: string): Record<string, string> {
  const params: Record<string, string> = {};
  let i = 0;
  while (i < input.length) {
    const nameStart = i;
    while (i < input.length && /[a-zA-Z_]/.test(input[i] as string)) i++;
    if (i > nameStart && input.startsWith('="', i)) {
      const valueStart = i + 2;
      const valueEnd = input.indexOf('"', valueStart);
      if (valueEnd === -1) break;
      params[input.slice(nameStart, i)] = input.slice(valueStart, valueEnd);
      i = valueEnd + 1;
    } else if (i === nameStart) {
      i++;
    }
  }
  return params;
}

async function registryFetch(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: { 'user-agent': 'motir', ...headers },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
}

/** Ask the challenge's realm for an ANONYMOUS pull token. A registry that
 *  refuses here has already answered the question — the repository is not
 *  public — so a null is returned and the caller reports `unauthorized`. */
async function anonymousToken(challenge: Record<string, string>): Promise<string | null> {
  const url = new URL(challenge['realm'] as string);
  if (challenge['service']) url.searchParams.set('service', challenge['service']);
  if (challenge['scope']) url.searchParams.set('scope', challenge['scope']);
  const res = await registryFetch(url.toString(), { accept: 'application/json' });
  if (!res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  const token =
    body && typeof body === 'object' && !Array.isArray(body)
      ? ((body as Record<string, unknown>)['token'] ??
        (body as Record<string, unknown>)['access_token'])
      : null;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * The authentication SCHEME a `WWW-Authenticate` header names, lower-cased —
 * `bearer`, `basic`, something else, or null when there is no header at all.
 *
 * Split out from {@link parseBearerChallenge} because the two answer different
 * questions and only one of them used to be asked. That function returns null
 * for BOTH "this is a Basic registry" and "this Bearer challenge is malformed",
 * and the probe read that single null as *the registry refused us* — which is
 * how a Fly-mirrored image reported `unpullable` every night for 23 days
 * (MOTIR-3606). Naming the scheme is what lets the two be told apart.
 */
export function challengeScheme(header: string | null): string | null {
  if (!header) return null;
  const match = /^\s*([A-Za-z][A-Za-z0-9-]*)\b/.exec(header);
  return match ? (match[1] as string).toLowerCase() : null;
}

/** `Authorization: Basic …` for a username/password pair. */
function basicAuthHeader(credential: RegistryBasicCredential): string {
  const raw = `${credential.username}:${credential.password}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Ask the caller's resolver for a credential, treating a THROW as "none".
 *
 * ⚠️ THE SWALLOW BELONGS HERE, NOT IN EVERY RESOLVER. A resolver reads
 * deployment configuration, and this repository's configuration accessors THROW
 * on an unwired deployment by design (`flyFleetConfig()` and its siblings,
 * deliberately — see `lib/orchestrator/index.ts`). {@link probeImagePull}'s
 * contract is that it NEVER throws, so the one place that can guarantee that is
 * the one place that declares it. A `try` in each resolver would be the same
 * code repeated per registry, and the first one written without it would break a
 * health check rather than return a verdict.
 *
 * "None" is the right reading of a throw either way: a credential that cannot be
 * read is a credential this deployment does not have, which lands on
 * `unauthenticatable` — a "could not tell", not an alarm.
 */
function credentialFor(
  resolve: RegistryCredentialResolver | undefined,
  registry: string,
): RegistryBasicCredential | null {
  try {
    return resolve?.(registry) ?? null;
  } catch {
    return null;
  }
}

/**
 * Can the thing that will boot this image resolve its manifest?
 *
 * The exact question Fly answers at machine-create time, asked before any job
 * depends on the answer. Measured against the real thing on 2026-08-02: the flow
 * below returns `pullable: true` for
 * `ghcr.io/motir-co/motir-ci-runner@sha256:446c692d…` (public since
 * MOTIR-2009) and `pullable: false, reason: 'unauthorized'` for
 * `ghcr.io/motir-co/motir-sandbox:claude`, which is still private — the same
 * pair of states Fly itself reports as HTTP 201 and HTTP 400 `failed to get
 * manifest …: unauthorized`.
 *
 * `resolveCredential` is consulted ONLY for a challenge the anonymous dance
 * cannot answer — see {@link RegistryCredentialResolver}. Omit it and the probe
 * behaves exactly as it did for every Bearer registry, and answers
 * `unauthenticatable` (a "could not tell") rather than `unauthorized` for a
 * Basic one.
 *
 * NEVER THROWS. Every failure is a verdict, because the callers are a health
 * check and an operator surface; a throw would turn "could not reach ghcr.io"
 * into a stack trace in the one place that exists to produce a sentence.
 */
export async function probeImagePull(
  image: string,
  resolveCredential?: RegistryCredentialResolver,
): Promise<ImagePullVerdict> {
  const parsed = parseImageReference(image);
  if (!parsed) {
    return {
      pullable: null,
      reference: image,
      registry: null,
      reason: 'unparseable',
      detail: 'the image reference could not be parsed as [registry/]repository[:tag|@digest]',
    };
  }

  const { registry, repository, reference } = parsed;
  const manifestUrl = `https://${registry}/v2/${repository}/manifests/${reference}`;
  /** Did the resolved answer come from a CREDENTIALED call? Only the refusal
   *  arms read it, and only to say which fix the operator needs. */
  let usedCredential = false;

  try {
    let res = await registryFetch(manifestUrl, { accept: MANIFEST_ACCEPT });

    if (res.status === 401) {
      const wwwAuthenticate = res.headers.get('www-authenticate');
      const challenge = parseBearerChallenge(wwwAuthenticate);

      if (challenge) {
        // The standard challenge → anonymous-token dance. A registry that hands
        // out a token for a PUBLIC repository and refuses for a private one is
        // exactly how "is this public?" is answered on the wire. A credential is
        // deliberately NOT offered here: on a Bearer registry the anonymous
        // answer IS the answer Fly will get.
        const token = await anonymousToken(challenge);
        if (!token) {
          return {
            pullable: false,
            reference: image,
            registry,
            reason: 'unauthorized',
            detail:
              'the registry refused an anonymous pull token — the repository is private or absent',
          };
        }
        res = await registryFetch(manifestUrl, {
          accept: MANIFEST_ACCEPT,
          authorization: `Bearer ${token}`,
        });
      } else {
        // ⚠️ NOT a refusal — a challenge this probe cannot answer anonymously.
        // `registry.fly.io` answers `Basic realm="flyio-registry.fly.dev"` and
        // hands out nothing without a credential, INCLUDING for a repository
        // that does not exist: the 401 is byte-identical either way, so an
        // anonymous verdict here carries no information about the image at all
        // (MOTIR-3606, measured 2026-08-27). Reporting it as `unauthorized` made
        // the daily health check red for 23 days over an image that was intact
        // the whole time.
        const credential = credentialFor(resolveCredential, registry);
        const scheme = challengeScheme(wwwAuthenticate) ?? 'none';
        if (!credential) {
          return {
            pullable: null,
            reference: image,
            registry,
            reason: 'unauthenticatable',
            detail:
              `the registry authenticates with \`${scheme}\` and no credential is configured ` +
              `for it — an anonymous probe cannot tell an intact image from a missing one here`,
          };
        }
        usedCredential = true;
        res = await registryFetch(manifestUrl, {
          accept: MANIFEST_ACCEPT,
          authorization: basicAuthHeader(credential),
        });
      }
    }

    if (res.ok) {
      return {
        pullable: true,
        reference: image,
        registry,
        digest: res.headers.get('docker-content-digest'),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        pullable: false,
        reference: image,
        registry,
        reason: 'unauthorized',
        // ⚠️ TWO DIFFERENT FIXES, so two different sentences. Refused ANONYMOUSLY
        // means the image is private and the fix is its visibility; refused WITH
        // the deployment's own credential means the credential is wrong or
        // expired, and sending an operator to the registry's visibility settings
        // for that is sending them to the wrong page (`flyMachines.ts` draws the
        // same distinction for the Machines API's own `unauthorized`).
        detail: usedCredential
          ? `the registry refused the manifest to this deployment's OWN registry credential ` +
            `(HTTP ${res.status}) — suspect an expired or wrong-org token before the image`
          : `the registry refused the manifest to an anonymous caller (HTTP ${res.status})`,
      };
    }
    if (res.status === 404) {
      return {
        pullable: false,
        reference: image,
        registry,
        reason: 'absent',
        detail: 'the registry has no such repository or digest (HTTP 404)',
      };
    }
    return {
      pullable: false,
      reference: image,
      registry,
      reason: 'refused',
      detail: `the registry refused the manifest (HTTP ${res.status})`,
    };
  } catch (err) {
    // Transport, DNS, TLS or the 10s deadline. NOT a statement about the image —
    // see the header's three-valued note.
    return {
      pullable: null,
      reference: image,
      registry,
      reason: 'unreachable',
      detail: `the registry could not be reached: ${detailOf(err)}`,
    };
  }
}

/** What {@link listImageTags} answered: the repository's tags, or why it could not tell. */
export type ImageTagListing =
  | {
      readonly ok: true;
      readonly registry: string;
      readonly repository: string;
      readonly tags: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'unparseable' | 'unauthorized' | 'unreachable' | 'refused';
      readonly detail: string;
    };

/**
 * Every tag of a PUBLIC repository, read ANONYMOUSLY — `GET /v2/<name>/tags/list`
 * behind the same challenge → anonymous-token dance {@link probeImagePull} makes
 * (`docs/decisions/agent-image-update.md` Q1, MOTIR-6949). Measured 2026-10-01
 * against `ghcr.io/motir-co/motir-sandbox`: 117 tags, `claude` … `claude-0.10.0`.
 *
 * `repository` is a reference WITHOUT a tag or digest (`ghcr.io/owner/name`); a
 * tag on it is ignored. NEVER THROWS: a registry that cannot be read is an answer
 * the caller shows as "could not check", never as an empty list.
 */
export async function listImageTags(repository: string): Promise<ImageTagListing> {
  const parsed = parseImageReference(repository);
  if (!parsed) {
    return {
      ok: false,
      reason: 'unparseable',
      detail: `"${repository}" is not an image reference`,
    };
  }
  const base = `https://${parsed.registry}/v2/${parsed.repository}/tags/list?n=1000`;
  try {
    const accept = 'application/json';
    let res = await registryFetch(base, { accept });
    if (res.status === 401) {
      const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
      const token = challenge ? await anonymousToken(challenge) : null;
      if (!token) {
        return {
          ok: false,
          reason: 'unauthorized',
          detail: 'the registry refused an anonymous token to list this repository',
        };
      }
      res = await registryFetch(base, { accept, authorization: `Bearer ${token}` });
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: 'refused',
        detail: `the registry refused the tag list (HTTP ${res.status})`,
      };
    }
    const body: unknown = await res.json().catch(() => null);
    const tags =
      body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['tags'])
        ? ((body as Record<string, unknown>)['tags'] as unknown[]).filter(
            (t): t is string => typeof t === 'string',
          )
        : [];
    return { ok: true, registry: parsed.registry, repository: parsed.repository, tags };
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `the registry could not be reached: ${detailOf(err)}`,
    };
  }
}

/** What {@link readImageLabels} answered: the image config's labels, or why not. */
export type ImageLabelsRead =
  | {
      readonly ok: true;
      readonly reference: string;
      /** The digest of the platform manifest the labels were read from. */
      readonly digest: string | null;
      readonly labels: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly reference: string;
      /** `unparseable` — not an image reference; `unauthorized` — the registry
       *  refused an anonymous caller; `absent` — no such repository, digest or
       *  platform; `refused` — any other registry NO; `malformed` — an answer
       *  that is not an OCI manifest or config; `unreachable` — transport. */
      readonly reason:
        | 'unparseable'
        | 'unauthorized'
        | 'absent'
        | 'refused'
        | 'malformed'
        | 'unreachable';
      readonly detail: string;
    };

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Why an anonymous read of an image's config failed — {@link ImageLabelsRead}'s reasons. */
type ImageReadFailure = Exclude<ImageLabelsRead, { ok: true }>;

/** What {@link readImageConfig} answered: the config and the digests on the way to it. */
type ImageConfigRead =
  | {
      readonly ok: true;
      /** The digest the registry answered for the reference itself — an index's
       *  own digest for a multi-platform push, which is what a digest pin names. */
      readonly referenceDigest: string | null;
      /** The digest of the platform manifest the config was read from. */
      readonly digest: string | null;
      readonly config: Record<string, unknown>;
    }
  | ImageReadFailure;

/**
 * The standard three reads behind the challenge → anonymous-token dance
 * {@link probeImagePull} makes: the manifest at the reference (an INDEX for a
 * multi-platform push, resolved to `platform`'s entry), that platform's
 * manifest, and its config blob. NEVER THROWS.
 */
async function readImageConfig(
  image: string,
  platform: { os: string; architecture: string },
): Promise<ImageConfigRead> {
  const parsed = parseImageReference(image);
  if (!parsed) {
    return {
      ok: false,
      reference: image,
      reason: 'unparseable',
      detail: 'the image reference could not be parsed as [registry/]repository[:tag|@digest]',
    };
  }
  const fail = (reason: ImageReadFailure['reason'], detail: string) =>
    ({ ok: false, reference: image, reason, detail }) as const;
  const base = `https://${parsed.registry}/v2/${parsed.repository}`;
  let authorization: string | null = null;
  const get = async (url: string, accept: string): Promise<Response> => {
    const headers: Record<string, string> = { accept };
    if (authorization) headers['authorization'] = authorization;
    let res = await registryFetch(url, headers);
    if (res.status === 401 && !authorization) {
      const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
      const token = challenge ? await anonymousToken(challenge) : null;
      if (!token) return res;
      authorization = `Bearer ${token}`;
      res = await registryFetch(url, { accept, authorization });
    }
    return res;
  };
  const refusal = (res: Response, what: string) =>
    res.status === 401 || res.status === 403
      ? fail(
          'unauthorized',
          `the registry refused the ${what} to an anonymous caller (HTTP ${res.status})`,
        )
      : res.status === 404
        ? fail('absent', `the registry has no such ${what} (HTTP 404)`)
        : fail('refused', `the registry refused the ${what} (HTTP ${res.status})`);

  try {
    let res = await get(`${base}/manifests/${parsed.reference}`, MANIFEST_ACCEPT);
    if (!res.ok) return refusal(res, 'manifest');
    const referenceDigest = res.headers.get('docker-content-digest');
    let digest = referenceDigest;
    let manifest = recordOf(await res.json().catch(() => null));
    if (!manifest) return fail('malformed', 'the manifest was not a JSON object');
    const mediaType = String(manifest['mediaType'] ?? res.headers.get('content-type') ?? '');
    if (INDEX_TYPES.has(mediaType.split(';')[0]!.trim()) || Array.isArray(manifest['manifests'])) {
      const entries = Array.isArray(manifest['manifests']) ? manifest['manifests'] : [];
      const match = entries.map(recordOf).find((m) => {
        const p = recordOf(m?.['platform']);
        return p?.['os'] === platform.os && p?.['architecture'] === platform.architecture;
      });
      const entryDigest = match?.['digest'];
      if (typeof entryDigest !== 'string') {
        return fail('absent', `the image has no ${platform.os}/${platform.architecture} manifest`);
      }
      res = await get(`${base}/manifests/${entryDigest}`, MANIFEST_ACCEPT);
      if (!res.ok) return refusal(res, 'platform manifest');
      digest = entryDigest;
      manifest = recordOf(await res.json().catch(() => null));
      if (!manifest) return fail('malformed', 'the platform manifest was not a JSON object');
    }
    const configDigest = recordOf(manifest['config'])?.['digest'];
    if (typeof configDigest !== 'string') {
      return fail('malformed', 'the manifest names no config blob');
    }
    res = await get(`${base}/blobs/${configDigest}`, 'application/json, */*');
    if (!res.ok) return refusal(res, 'config blob');
    const config = recordOf(await res.json().catch(() => null));
    if (!config) return fail('malformed', 'the config blob was not a JSON object');
    return { ok: true, referenceDigest, digest, config };
  } catch (err) {
    return fail('unreachable', `the registry could not be reached: ${detailOf(err)}`);
  }
}

/**
 * The LABELS of a PUBLIC image's config, read ANONYMOUSLY for one platform
 * (MOTIR-10290) — how the fleet learns what the runner image it pins says about
 * itself (`co.motir.ci-runner.tools`), with no second copy of that list anywhere.
 *
 * The three reads of {@link readImageConfig}. NEVER THROWS: every failure is an
 * answer the caller shows as "could not read the image", never as an image with
 * no labels.
 */
export async function readImageLabels(
  image: string,
  platform: { os: string; architecture: string } = { os: 'linux', architecture: 'amd64' },
): Promise<ImageLabelsRead> {
  const read = await readImageConfig(image, platform);
  if (!read.ok) return read;
  const raw = recordOf(recordOf(read.config['config'])?.['Labels']) ?? {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') labels[key] = value;
  }
  return { ok: true, reference: image, digest: read.digest, labels };
}

/** What {@link readImageCreated} answered: what a reference resolves to and when it was built. */
export type ImageCreatedRead =
  | {
      readonly ok: true;
      readonly reference: string;
      /** The digest the reference resolves to, as a digest pin of it would name it
       *  (an index's own digest for a multi-platform push); null when the registry
       *  sent no `Docker-Content-Digest`. */
      readonly digest: string | null;
      /** The config's `created` time, as ISO 8601; null when it records none. */
      readonly createdAt: string | null;
    }
  | ImageReadFailure;

/**
 * Which image a PUBLIC reference — typically a TAG such as `:main` — resolves to
 * now, and when that image was built (MOTIR-10882): the digest the registry
 * answers for the reference, and the `created` time of its config. How the daily
 * health check tells that the hosted-agent pin has fallen behind the newest
 * build. The three reads of {@link readImageConfig}; NEVER THROWS.
 */
export async function readImageCreated(
  image: string,
  platform: { os: string; architecture: string } = { os: 'linux', architecture: 'amd64' },
): Promise<ImageCreatedRead> {
  const read = await readImageConfig(image, platform);
  if (!read.ok) return read;
  const created = read.config['created'];
  const time = typeof created === 'string' ? Date.parse(created) : Number.NaN;
  return {
    ok: true,
    reference: image,
    digest: read.referenceDigest,
    createdAt: Number.isNaN(time) ? null : new Date(time).toISOString(),
  };
}
