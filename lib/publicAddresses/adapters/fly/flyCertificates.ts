import {
  CERTIFICATE_REQUEST_TIMEOUT_MS,
  CertificateHostnameUnknownError,
  CertificateProviderNotConfiguredError,
  CertificateProviderRefusedError,
  CertificateProviderUnavailableError,
  type CertificateDnsRequirement,
  type CertificateProvider,
  type CertificateState,
} from '../../certificateProvider';

// THE ONLY MODULE IN `motir-core` THAT ASKS FLY FOR A CUSTOMER'S CERTIFICATE.
// Story MOTIR-3878 · Subtask MOTIR-4210. `docs/decisions/public-tenant-addresses.md` §6.
//
// It is the twin of `lib/orchestrator/adapters/fly/flyMachines.ts` — same
// boundary shape, same call-time config rule, same no-fallback token rule — for
// a DIFFERENT app with a DIFFERENT token. `tests/publicAddresses/certificatePortBoundary.test.ts`
// asserts that the Fly names below appear here and nowhere else outside the two
// adapter directories.
//
// ⚠️ THE TOKEN IS SCOPED TO ONE APP AND HAS NO FALLBACK, and the reason is
// `flyMachines.ts`'s verbatim, transferred: "a token that could reach the
// production org is the one thing that could quietly undo that". Here the grant
// this path needs is add-and-remove-certificates on `motir-marketing` and
// nothing else, and the path is driven by CUSTOMER INPUT — a hostname somebody
// typed into a settings pane. A deploy-capable token in that position is a much
// larger grant than the work requires, so the accessor names its own variable
// and there is no `FLY_API_TOKEN` to fall back to.
//
// ── The wire format, quoted from the doc rather than remembered ────────────
//
// Read from `https://fly.io/docs/networking/custom-domain-api/` on 2026-09-03.
// Each mapped field carries the doc's own name beside it, so a future reader can
// check the mapping without re-deriving what Fly returns:
//
//   POST /v1/apps/{app_name}/certificates/acme          — request a certificate
//   POST /v1/apps/{app_name}/certificates/{hostname}/check — read its state
//   DELETE /v1/apps/{app_name}/certificates/{hostname}  — withdraw it
//
// The check response carries `hostname`, `configured`, `acme_requested`,
// `status`, `dns_provider`, `rate_limited_until`, `certificates`, `validation`,
// `dns_requirements`, `validation_errors` and `dns_records`; `validation` carries
// `dns_configured`, `alpn_configured`, `http_configured` and
// `ownership_txt_configured`. `dns_requirements` carries an `acme_challenge`
// object with a `name` (e.g. `_acme-challenge.example.com`) and a `target`.
// Each `certificates` element carries `source` (`fly` | `custom`), `status`,
// `created_at`, `expires_at`, `issuer` and `issued` (re-read on 2026-10-30 for
// MOTIR-9526, whose expiry arm depends on `expires_at` being there).

const FLY_API = 'https://api.machines.dev/v1';

interface FlyCertsConfig {
  readonly token: string;
  readonly app: string;
}

/**
 * The config, read at CALL time.
 *
 * Never at module load: a self-hosted deploy that never provisions a certificate
 * must not crash on boot, it must simply be unable to reach this path
 * (`appAuth.ts`'s contract, cited by `flyMachines.ts` for the same reason).
 */
export function flyCertsConfig(): FlyCertsConfig {
  const token = process.env['FLY_CERTS_TOKEN'];
  const app = process.env['FLY_CERTS_APP'];
  const missing: string[] = [];
  if (!token) missing.push('FLY_CERTS_TOKEN');
  if (!app) missing.push('FLY_CERTS_APP');
  if (missing.length > 0) throw new CertificateProviderNotConfiguredError(missing);
  return { token: token as string, app: app as string };
}

/** Is this deployment wired for customer certificates? Never throws. */
export function isFlyCertsConfigured(): boolean {
  return Boolean(process.env['FLY_CERTS_TOKEN']) && Boolean(process.env['FLY_CERTS_APP']);
}

/** The check endpoint's response, narrowed to the fields this adapter maps. */
interface FlyCertificateResponse {
  hostname?: string;
  configured?: boolean;
  acme_requested?: boolean;
  certificates?: { source?: string; expires_at?: string | null }[];
  validation?: {
    dns_configured?: boolean;
    alpn_configured?: boolean;
    http_configured?: boolean;
    ownership_txt_configured?: boolean;
  };
  dns_requirements?: {
    acme_challenge?: { name?: string; target?: string };
    a_record?: string[];
    aaaa_record?: string[];
    cname?: { name?: string; target?: string };
  };
}

/**
 * A hostname is URL-ENCODED into the path.
 *
 * Fly's own doc calls this out for the wildcard case — `*` must be sent as
 * `%2A` — and the same encoding is what keeps a customer-supplied hostname from
 * reaching the path unescaped. This adapter never requests a wildcard (that is
 * the human's `fly certs add`, MOTIR-4208), but the encoding is not conditional
 * on that: the value comes from a settings form.
 */
function encodeHostname(hostname: string): string {
  // ⚠️ `encodeURIComponent` does NOT escape `*` — it is in that function's
  // unreserved set — so the doc's own requirement (`%2A.example.com`) is NOT
  // satisfied by encoding alone, and the wildcard reaches the path raw. Caught
  // by `tests/publicAddresses/flyCertificates.test.ts`, which asserts the
  // encoded form rather than trusting the call.
  return encodeURIComponent(hostname).replace(/\*/g, '%2A');
}

/**
 * Map Fly's answer onto the port's `CertificateState`.
 *
 * `issued` reads `certificates` being non-empty rather than `status`, because
 * `status` is a string whose vocabulary the doc does not close — mapping a
 * string set nobody has enumerated is how a state machine acquires a silent
 * tenth value. The presence of a certificate is the fact the pane draws.
 */
function toCertificateState(hostname: string, body: FlyCertificateResponse): CertificateState {
  const requirements: CertificateDnsRequirement[] = [];
  const dns = body.dns_requirements ?? {};

  // `dns_requirements.acme_challenge` → { name, target }, the CNAME delegation
  // the DNS-01 challenge needs.
  if (dns.acme_challenge?.name && dns.acme_challenge.target) {
    requirements.push({
      type: 'CNAME',
      name: dns.acme_challenge.name,
      value: dns.acme_challenge.target,
    });
  }
  // `dns_requirements.cname` → { name, target }, for a subdomain pointed at the
  // app's `.fly.dev` hostname.
  if (dns.cname?.name && dns.cname.target) {
    requirements.push({ type: 'CNAME', name: dns.cname.name, value: dns.cname.target });
  }
  // `dns_requirements.a_record` / `.aaaa_record` → the app's addresses, for an
  // APEX, which cannot take a CNAME (RFC 1034 §3.6.2 — the constraint
  // `marketing-site-hosting.md` §3 already documents at `motir.co`).
  for (const value of dns.a_record ?? []) {
    requirements.push({ type: 'A', name: hostname, value });
  }
  for (const value of dns.aaaa_record ?? []) {
    requirements.push({ type: 'AAAA', name: hostname, value });
  }

  return {
    hostname: body.hostname ?? hostname,
    // `configured` — Fly's own name, and its own meaning: the customer's DNS
    // points at this app.
    configured: body.configured === true,
    issued: Array.isArray(body.certificates) && body.certificates.length > 0,
    dnsRequirements: requirements,
    checkedAt: new Date(),
    expiresAt: certificateExpiry(body.certificates),
  };
}

/**
 * `certificates[].expires_at` → the hostname's certificate expiry (MOTIR-9526).
 *
 * The element Fly issued (`source: "fly"`) is the one this adapter asked for, so
 * its date wins; a hostname holding only a customer-uploaded certificate falls
 * back to the latest date among the rest. A missing or unparseable date maps to
 * `null` — never an error, and never a date computed from anything else.
 */
function certificateExpiry(certificates: FlyCertificateResponse['certificates']): Date | null {
  if (!Array.isArray(certificates)) return null;
  const dated = certificates
    .map((c) => ({ source: c?.source, at: parseDate(c?.expires_at) }))
    .filter((c): c is { source: string | undefined; at: Date } => c.at !== null);
  const fly = dated.filter((c) => c.source === 'fly');
  const pool = fly.length > 0 ? fly : dated;
  if (pool.length === 0) return null;
  return pool.reduce((latest, c) => (c.at > latest ? c.at : latest), pool[0]!.at);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * One bounded call, with every failure mapped to a typed error.
 *
 * The timeout is applied HERE rather than at each call site, so a method added
 * later cannot forget it — the same argument `flyMachines.ts` makes for its own
 * wrapper (`docs/jobs.md` rule 3).
 */
async function flyFetch(
  path: string,
  hostnameForErrors: string,
  init: { method: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const { token, app } = flyCertsConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CERTIFICATE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${FLY_API}/apps/${encodeURIComponent(app)}${path}`, {
      method: init.method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON body from a 4xx/5xx is common (a proxy's HTML error page).
      // Keeping the raw text is what makes the refusal's `reason` useful.
      body = text;
    }
    if (res.status >= 500) {
      throw new CertificateProviderUnavailableError(`${res.status} ${describe(body)}`);
    }
    // A 404 is its OWN outcome, not a refusal. Fly answers it when it does not
    // hold the hostname at all, which `remove` treats as success and the other
    // two methods must be able to report distinctly — a `check` on a hostname
    // nobody ever requested is a different finding from one Fly declined.
    if (res.status === 404) {
      throw new CertificateHostnameUnknownError(hostnameForErrors);
    }
    if (res.status >= 400) {
      throw new CertificateProviderRefusedError(res.status, describe(body));
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof CertificateProviderRefusedError) throw err;
    if (err instanceof CertificateProviderUnavailableError) throw err;
    if (err instanceof CertificateProviderNotConfiguredError) throw err;
    if (err instanceof CertificateHostnameUnknownError) throw err;
    if (controller.signal.aborted) {
      throw new CertificateProviderUnavailableError(
        `timed out after ${CERTIFICATE_REQUEST_TIMEOUT_MS}ms`,
      );
    }
    // A network-level failure — DNS, TLS, connection reset. Unreachable is
    // unavailable, never a refusal: nothing about the customer's input caused it.
    throw new CertificateProviderUnavailableError(
      err instanceof Error ? err.message : 'unknown transport failure',
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A body's most useful one-line description, for an error message. */
function describe(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    return JSON.stringify(body).slice(0, 200);
  }
  return 'no body';
}

/** The Fly implementation of the certificate port. */
export const flyCertificateProvider: CertificateProvider = {
  async request(hostname: string): Promise<CertificateState> {
    const { body } = await flyFetch('/certificates/acme', hostname, {
      method: 'POST',
      body: { hostname },
    });
    return toCertificateState(hostname, (body ?? {}) as FlyCertificateResponse);
  },

  async check(hostname: string): Promise<CertificateState> {
    const { body } = await flyFetch(`/certificates/${encodeHostname(hostname)}/check`, hostname, {
      method: 'POST',
    });
    return toCertificateState(hostname, (body ?? {}) as FlyCertificateResponse);
  },

  async remove(hostname: string): Promise<void> {
    try {
      await flyFetch(`/certificates/${encodeHostname(hostname)}`, hostname, { method: 'DELETE' });
    } catch (err) {
      // ⚠️ ALREADY GONE IS THE OUTCOME REMOVAL WANTED. A 404 here means the
      // hostname is not held, which is exactly the state `remove` exists to
      // reach — and a retry of a half-finished removal is the ordinary way to
      // arrive at it. Throwing would make the second attempt at a cleanup fail
      // for having succeeded the first time.
      if (err instanceof CertificateHostnameUnknownError) return;
      throw err;
    }
  },
};
