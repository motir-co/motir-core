import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { previewDomain } from './config';
import { PreviewHostingNotConfiguredError } from './errors';

// THE PREVIEW MEMBER GATE (Story MOTIR-5766 · Subtask MOTIR-5779), as pure
// functions. The decision of record is MOTIR-5769 §5 and §9 (page
// cmvrcywwc00jkhpr1zvvnike8, version 1):
//
//   1. A request to a preview host with no valid gate cookie is sent to
//      `app.motir.co/preview-access?host=<host>&return=<path>`, which needs a
//      Motir session and checks `project:browse`.
//   2. A member gets a signed, single-use ADMISSION (60 s) and is redirected to
//      `https://<host>/__motir/preview-auth?token=…`.
//   3. The preview host verifies it for THIS host, records its id as consumed,
//      and sets `__Host-motir-gate` — host-only, Secure, HttpOnly, SameSite=Lax,
//      8 hours — then sends the viewer to the remembered path.
//
// Everything here is free of Prisma, so `proxy.ts` can import it on every
// request. The consumed-admission record and the host → row read live in
// `lib/services/previewGateService.ts`, loaded only on a preview host.

/** The env var holding the HMAC key the admission and the cookie are signed
 *  with. Read at call time (`lib/preview/config.ts`'s contract). */
export const GATE_SIGNING_KEY_ENV = 'MOTIR_HOSTING_GATE_SIGNING_KEY';

/** The gate cookie. `__Host-` makes the browser refuse it unless it is Secure,
 *  Path=/ and carries no Domain, so a neighbouring preview cannot plant one. */
export const GATE_COOKIE = '__Host-motir-gate';
/** How long a gate cookie admits its viewer (§9: 8 hours). */
export const GATE_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;
/** How long an admission may wait to be consumed (§9: 60 seconds). */
export const ADMISSION_TTL_MS = 60_000;

/** The preview host's one Motir-owned path: where an admission is consumed. */
export const PREVIEW_AUTH_PATH = '/__motir/preview-auth';
/** Where a browser is sent to read why the gate refused its request (Panel 6b). */
export const PREVIEW_UNSUPPORTED_PATH = '/__motir/preview-unsupported';
/** The page every non-ready preview-host answer is rewritten to. Internal: it
 *  re-derives everything from the Host header and the gate cookie. */
export const PREVIEW_GATE_PAGE_PATH = '/preview-gate';
/** Where preview-access lives on app.motir.co. */
export const PREVIEW_ACCESS_PATH = '/preview-access';

/** A preview host's first label (`lib/preview/hostName.ts`): `pr-<n>--<slug>`. */
const PREVIEW_LABEL = /^pr-[1-9]\d*--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The preview host a request is for, or null when it is not one. The Host
 * header is lowercased and its port dropped; the host must be ONE label under
 * the configured preview domain and that label must be a preview's. A
 * deployment with no preview domain configured answers null for every host, so
 * it never enters the preview branch.
 */
export function previewHostOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
  let domain: string;
  try {
    domain = previewDomain();
  } catch (error) {
    if (error instanceof PreviewHostingNotConfiguredError) return null;
    throw error;
  }
  if (!host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, -(domain.length + 1));
  return PREVIEW_LABEL.test(label) ? host : null;
}

// ── Signing ─────────────────────────────────────────────────────────────────

/** The gate's signing key, or the typed refusal (→ 503 on the preview host). */
export function gateSigningKey(): string {
  const key = process.env[GATE_SIGNING_KEY_ENV]?.trim();
  if (!key) throw new PreviewHostingNotConfiguredError(`set ${GATE_SIGNING_KEY_ENV}`);
  return key;
}

/** What an admission says: who was let in, to which host, once, until when. */
export interface Admission {
  readonly host: string;
  /** The admitted user — carried into the cookie for the record, never trusted
   *  as a session. */
  readonly sub: string;
  /** The admission's id; recorded as consumed so it works once. */
  readonly jti: string;
  /** Expiry, ms since the epoch. */
  readonly exp: number;
}

/** What a gate cookie says. */
export interface GatePass {
  readonly host: string;
  readonly sub: string;
  readonly exp: number;
}

type Purpose = 'admission' | 'gate';

function mac(key: string, purpose: Purpose, body: string): Buffer {
  // The purpose is signed with the body, so an admission can never be replayed
  // as a cookie or a cookie as an admission.
  return createHmac('sha256', key).update(`${purpose}.${body}`).digest();
}

function seal(key: string, purpose: Purpose, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(key, purpose, body).toString('base64url')}`;
}

/** The payload, when the signature is this key's for this purpose; else null. */
function open(key: string, purpose: Purpose, value: string): Record<string, unknown> | null {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = mac(key, purpose, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Mint an admission for `sub` to `host`, valid {@link ADMISSION_TTL_MS}. */
export function mintAdmission(
  input: { host: string; sub: string },
  key: string,
  now: Date = new Date(),
): { token: string; admission: Admission } {
  const admission: Admission = {
    host: input.host,
    sub: input.sub,
    jti: randomUUID(),
    exp: now.getTime() + ADMISSION_TTL_MS,
  };
  return { token: seal(key, 'admission', admission), admission };
}

/** Why an admission or a cookie was not accepted. A single-use refusal
 *  (`consumed`) is the service's: only the database knows it. */
export type GateRefusal = 'malformed' | 'tampered' | 'other_host' | 'expired';

function fieldsOf(payload: Record<string, unknown>): {
  host: string;
  sub: string;
  exp: number;
  jti: unknown;
} | null {
  const { host, sub, exp, jti } = payload;
  if (typeof host !== 'string' || typeof sub !== 'string' || typeof exp !== 'number') return null;
  return { host, sub, exp, jti };
}

/** Verify an admission FOR THIS HOST; the caller still consumes its `jti`. */
export function verifyAdmission(
  token: string | null | undefined,
  host: string,
  key: string,
  now: Date = new Date(),
): { ok: true; admission: Admission } | { ok: false; refusal: GateRefusal } {
  if (!token) return { ok: false, refusal: 'malformed' };
  const payload = open(key, 'admission', token);
  if (!payload) return { ok: false, refusal: token.includes('.') ? 'tampered' : 'malformed' };
  const fields = fieldsOf(payload);
  if (!fields || typeof fields.jti !== 'string') return { ok: false, refusal: 'malformed' };
  if (fields.host !== host) return { ok: false, refusal: 'other_host' };
  if (fields.exp <= now.getTime()) return { ok: false, refusal: 'expired' };
  return { ok: true, admission: { ...fields, jti: fields.jti } };
}

/** The gate cookie's value for a consumed admission. */
export function mintGatePass(admission: Admission, key: string, now: Date = new Date()): string {
  const pass: GatePass = {
    host: admission.host,
    sub: admission.sub,
    exp: now.getTime() + GATE_COOKIE_MAX_AGE_SECONDS * 1000,
  };
  return seal(key, 'gate', pass);
}

/** Whether a gate cookie admits its bearer to THIS host now. */
export function verifyGatePass(
  value: string | null | undefined,
  host: string,
  key: string,
  now: Date = new Date(),
): GatePass | null {
  if (!value) return null;
  const payload = open(key, 'gate', value);
  const fields = payload ? fieldsOf(payload) : null;
  if (!fields || fields.host !== host || fields.exp <= now.getTime()) return null;
  return { host: fields.host, sub: fields.sub, exp: fields.exp };
}

/** The gate cookie's attributes (§9). No `domain`, ever: `__Host-` forbids it. */
export function gateCookieOptions() {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: GATE_COOKIE_MAX_AGE_SECONDS,
  };
}

// ── The return path ─────────────────────────────────────────────────────────

/**
 * The path a viewer is sent back to on the preview host, or `/`. Only ever a
 * PATH: an absolute URL, a protocol-relative `//host`, a backslash (which
 * browsers read as a slash), a control character, or any of those spelled with
 * percent-escapes (`/%2F%2Fevil.example`) falls back to the root — the return
 * is resolved against the preview host and can never leave it.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048 || !raw.startsWith('/')) return '/';
  let decoded = raw;
  // Decode until stable (bounded), so a doubly-escaped `%252F` is seen too.
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return '/';
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(decoded)) return '/';
  try {
    const resolved = new URL(raw, 'https://preview.invalid');
    if (resolved.origin !== 'https://preview.invalid') return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

// ── What is forwarded ───────────────────────────────────────────────────────

/** Whether a cookie is Motir's own — its session, or the gate cookie. Neither
 *  ever reaches the preview's code (§9: the session is stripped; the gate
 *  cookie is what the preview cannot read). */
export function isMotirCookie(name: string): boolean {
  if (name === GATE_COOKIE) return true;
  const bare = name.replace(/^__(?:Secure|Host)-/, '');
  return bare.startsWith('better-auth.');
}

/** A `Cookie` header with Motir's cookies removed, or null when none is left. */
export function stripMotirCookies(header: string | null | undefined): string | null {
  if (!header) return null;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const eq = part.indexOf('=');
      return !isMotirCookie((eq === -1 ? part : part.slice(0, eq)).trim());
    });
  return kept.length ? kept.join('; ') : null;
}

/** Hop-by-hop headers (RFC 9110 §7.6.1), plus those the gate owns. */
export const UNFORWARDED_REQUEST_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-motir-origin-secret',
] as const;

/** §5: the largest body the gate carries on each target. A Lambda function
 *  URL's payload limit is 6 MB; Fly and an AWS container sit behind the
 *  proxy's own 10 MB body ceiling. */
export function forwardBodyLimitBytes(target: HostingTarget): number {
  return target === 'serverless' ? 6 * 1024 * 1024 : 10 * 1024 * 1024;
}

/** Why the gate refuses to carry a request (§5), or null when it carries it. */
export type GateUnsupported = 'websocket' | 'tooLarge' | 'noLength';

/** The status each refusal answers with. */
export const UNSUPPORTED_STATUS: Record<GateUnsupported, number> = {
  websocket: 501,
  tooLarge: 413,
  noLength: 411,
};

/** Whether `value` names a refusal the unsupported page can show. */
export function isUnsupportedKind(value: string | null | undefined): value is GateUnsupported {
  return typeof value === 'string' && Object.hasOwn(UNSUPPORTED_STATUS, value);
}

const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS', 'DELETE']);

/**
 * §5 — the gate REFUSES rather than truncates: a websocket upgrade is 501, a
 * body over the target's limit 413, and a write that does not say how large it
 * is 411 (the gate cannot know it fits). A bodiless method with no length is
 * carried as it is.
 */
export function unsupportedRequest(
  method: string,
  headers: Headers,
  target: HostingTarget,
): GateUnsupported | null {
  if (headers.get('upgrade')?.toLowerCase() === 'websocket') return 'websocket';
  const length = headers.get('content-length');
  if (length === null) {
    return BODYLESS.has(method.toUpperCase()) && !headers.has('transfer-encoding')
      ? null
      : 'noLength';
  }
  const bytes = Number(length);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return 'noLength';
  return bytes > forwardBodyLimitBytes(target) ? 'tooLarge' : null;
}

/** Whether a request is a browser navigating to a page (it gets HTML), rather
 *  than a script (it gets the sentence as `text/plain`). */
export function isNavigation(headers: Headers): boolean {
  const dest = headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (headers.get('accept') ?? '').includes('text/html');
}
