// The edge's ONE call per request (MOTIR-10127): `GET {MOTIR_BASE_URL}/api/public/hosts/{host}`
// with the edge's bearer, parsed into exactly five outcomes.
//
// The contract (`app/api/public/hosts/[host]/route.ts`) answers three kinds and
// one 404. Only a credentialed `application` answer carries `upstream`, so the
// bearer is what makes a forward possible at all.
//
// ── FAIL CLOSED ───────────────────────────────────────────────────────────
//
// Every answer this file cannot read with certainty is `not-found`: a 404, any
// other status, a body that is not JSON, an unknown `kind`, an `application`
// with no `upstream`, an origin that is not an `https:` URL, a network error and
// a timeout. The origin comes from this answer and ONLY from it — nothing a
// request carries can choose where the edge connects, so a crafted `Host` cannot
// turn it into an open proxy.
//
// `unavailable` is taken from one answer only: a well-formed `https:` upstream
// whose credential this edge cannot present (`aws_sigv4`). That domain resolves
// and its site is live, which is why it is not the 404.
//
// ── NO CACHE ──────────────────────────────────────────────────────────────
//
// Nothing here remembers an answer. A removed domain is answered by the
// contract on the very next request; the contract's own 30-second bound is the
// only staleness in the system, and this file adds none on top.

import { canPresent, type CredentialKind } from './credential.ts';

/** How long one contract call may take before the visitor gets the 404. */
export const CONTRACT_TIMEOUT_MS = 5_000;

export type EdgeOutcome =
  | {
      readonly kind: 'forward';
      readonly origin: URL;
      readonly appRef: string;
      readonly credential: 'origin_secret' | 'none';
    }
  | { readonly kind: 'no-application'; readonly name: string }
  | { readonly kind: 'members-only'; readonly name: string; readonly opensAt: string | null }
  | { readonly kind: 'unavailable'; readonly name: string }
  | { readonly kind: 'not-found' };

const NOT_FOUND: EdgeOutcome = { kind: 'not-found' };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ContractClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Injected, never the global: a test counts the calls a request makes. */
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
}

/** Resolve one `Host` against the contract. Never throws. */
export function createContractClient(options: ContractClientOptions) {
  const timeoutMs = options.timeoutMs ?? CONTRACT_TIMEOUT_MS;
  return async function resolve(host: string): Promise<EdgeOutcome> {
    let res: Response;
    try {
      res = await options.fetch(`${options.baseUrl}/api/public/hosts/${encodeURIComponent(host)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      return NOT_FOUND;
    }
    if (res.status !== 200) return NOT_FOUND;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return NOT_FOUND;
    }
    return parseOutcome(body);
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const CREDENTIAL_KINDS: readonly string[] = [
  'origin_secret',
  'aws_sigv4',
  'none',
] satisfies CredentialKind[];

/** An `https:` origin with no userinfo, or null. Its path is never used. */
export function httpsOrigin(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return new URL(url.origin);
}

/** The contract's answer, read into the edge's five outcomes. */
export function parseOutcome(body: unknown): EdgeOutcome {
  if (!isRecord(body) || !isRecord(body.workspace)) return NOT_FOUND;
  const name = body.workspace.name;
  if (typeof name !== 'string') return NOT_FOUND;

  switch (body.kind) {
    case 'no_application':
      return { kind: 'no-application', name };
    case 'members_only_application':
      return {
        kind: 'members-only',
        name,
        opensAt: typeof body.opensAt === 'string' ? body.opensAt : null,
      };
    case 'application': {
      const upstream = body.upstream;
      if (!isRecord(upstream)) return NOT_FOUND;
      const origin = httpsOrigin(upstream.origin);
      const credential = upstream.credential;
      const appRef = upstream.appRef;
      if (!origin || typeof appRef !== 'string' || appRef === '') return NOT_FOUND;
      if (typeof credential !== 'string' || !CREDENTIAL_KINDS.includes(credential)) {
        return NOT_FOUND;
      }
      const kind = credential as CredentialKind;
      if (!canPresent(kind)) return { kind: 'unavailable', name };
      return { kind: 'forward', origin, appRef, credential: kind };
    }
    default:
      return NOT_FOUND;
  }
}
