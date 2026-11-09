import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// THE RELAY TOKEN (MOTIR-6938 · `docs/decisions/agent-terminal.md` Q3).
//
// The ONE definition of the credential the relay (MOTIR-6940, in the Next app)
// presents to the in-agent terminal server on every WebSocket upgrade. Both
// sides import THIS module — the relay by relative path, the same crossing
// `lib/apiDocs/*` makes into `packages/cli/src` (the root tsconfig already
// compiles `packages/cli/src/**`) — so the format has no second home that could
// drift. It imports only `node:crypto` and holds no state.
//
// ── The exact byte format ───────────────────────────────────────────────────
//
//   header      Authorization: Motir-Relay <token>
//   token       <p>.<s>
//   p           base64url (RFC 4648 §5, no padding) of PAYLOAD_BYTES
//   PAYLOAD_BYTES  the UTF-8 bytes of JSON.stringify(payload), keys in the order
//               instanceId, machineId, exp, nonce[, sessionId]
//   s           base64url (no padding) of HMAC-SHA256(instanceKey, PAYLOAD_BYTES)
//   payload     { instanceId: string, machineId: string,
//                 exp: integer seconds since the Unix epoch (now + 60),
//                 nonce: base64url of 16 random bytes,
//                 sessionId?: string (a session UUID, to resume one) }
//
//   instanceKey the STRING base64url(HMAC-SHA256(key = UTF-8(masterKey),
//               message = UTF-8(instanceId))), no padding, 43 characters — what
//               MOTIR-6939's `deriveTerminalKey` (lib/agentInstances/terminalKey.ts)
//               sets as the machine env MOTIR_TERMINAL_KEY, and what
//               `deriveInstanceKey` below computes the same way.
//   HMAC key    the UTF-8 bytes of that STRING, as the env var holds it — NOT
//               its base64url-decoded form (`keyBytes`).
//
// The signature is computed over the DECODED payload bytes the token carries,
// never over a re-serialisation, so key order and whitespace cannot make a
// valid token fail. `RELAY_TOKEN_TEST_VECTOR` below is a fixed vector (master
// key, instance key, payload, token) that `test/agentTerminal/relayToken.test.ts`
// recomputes by hand and the relay's own tests can assert against.

/** The Authorization scheme word. */
export const RELAY_AUTH_SCHEME = 'Motir-Relay';

/** How long a relay token lives, in seconds (Q3: `exp: now + 60 s`). */
export const RELAY_TOKEN_TTL_SECONDS = 60;

export interface RelayTokenPayload {
  instanceId: string;
  machineId: string;
  /** Expiry, whole seconds since the Unix epoch. */
  exp: number;
  /** base64url of 16 random bytes; single-use at the server. */
  nonce: string;
  /** The session to resume, when the panel holds one (Q5). */
  sessionId?: string;
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * The per-instance key, as the base64url string set in MOTIR_TERMINAL_KEY.
 * `instanceKey = HMAC-SHA256(MOTIR_TERMINAL_MASTER_KEY, instanceId)`.
 */
export function deriveInstanceKey(masterKey: string, instanceId: string): string {
  return b64url(
    createHmac('sha256', Buffer.from(masterKey, 'utf8')).update(instanceId, 'utf8').digest(),
  );
}

/**
 * The HMAC key for a MOTIR_TERMINAL_KEY string: its UTF-8 bytes, exactly as the
 * env var holds it (the convention MOTIR-6939 set). Never base64url-decoded.
 */
export function keyBytes(instanceKey: string): Buffer {
  return Buffer.from(instanceKey, 'utf8');
}

function sign(key: Buffer, payloadBytes: Buffer): Buffer {
  return createHmac('sha256', key).update(payloadBytes).digest();
}

/** A fresh nonce: base64url of 16 random bytes. */
export function newNonce(): string {
  return b64url(randomBytes(16));
}

/**
 * Sign a payload with the instance key (the MOTIR_TERMINAL_KEY string). Key
 * order is fixed so two signers produce the same bytes for the same payload.
 */
export function signRelayToken(instanceKey: string, payload: RelayTokenPayload): string {
  const ordered: RelayTokenPayload = {
    instanceId: payload.instanceId,
    machineId: payload.machineId,
    exp: payload.exp,
    nonce: payload.nonce,
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
  };
  const payloadBytes = Buffer.from(JSON.stringify(ordered), 'utf8');
  return `${b64url(payloadBytes)}.${b64url(sign(keyBytes(instanceKey), payloadBytes))}`;
}

/** The `Authorization` header value for a token. */
export function relayAuthorizationHeader(token: string): string {
  return `${RELAY_AUTH_SCHEME} ${token}`;
}

/**
 * Why a token was refused. A CODE, never the token or any part of it, so a
 * caller can log it without leaking a credential.
 */
export type RelayTokenRefusal =
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'wrong_instance'
  | 'wrong_machine'
  | 'expired'
  | 'replayed';

export type RelayTokenVerdict =
  | { ok: true; payload: RelayTokenPayload }
  | { ok: false; reason: RelayTokenRefusal };

export interface VerifyRelayTokenOptions {
  /** The server's MOTIR_TERMINAL_KEY string. */
  instanceKey: string;
  /** The server's MOTIR_INSTANCE_ID. */
  instanceId: string;
  /** The server's machine id: MOTIR_MACHINE_ID, else FLY_MACHINE_ID. */
  machineId: string;
  /** Now, in whole seconds since the epoch. */
  nowSeconds: number;
  /** The nonce memory; omit to skip the replay check (pure verification). */
  nonces?: NonceMemory;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function parsePayload(bytes: Buffer): RelayTokenPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { instanceId, machineId, exp, nonce, sessionId } = record;
  if (typeof instanceId !== 'string' || typeof machineId !== 'string') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  if (sessionId !== undefined && typeof sessionId !== 'string') return null;
  return {
    instanceId,
    machineId,
    exp,
    nonce,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * Verify an `Authorization` header value. The signature is checked FIRST and
 * timing-safely, so nothing about an unsigned payload is trusted; then the
 * instance, the machine, the expiry, and — only for an otherwise valid token —
 * the nonce, which is remembered until its `exp`.
 */
export function verifyRelayAuthorization(
  header: string | undefined,
  options: VerifyRelayTokenOptions,
): RelayTokenVerdict {
  if (!header) return { ok: false, reason: 'missing' };
  const prefix = `${RELAY_AUTH_SCHEME} `;
  if (!header.startsWith(prefix)) return { ok: false, reason: 'malformed' };
  return verifyRelayToken(header.slice(prefix.length).trim(), options);
}

/** Verify a bare token (see `verifyRelayAuthorization`). */
export function verifyRelayToken(
  token: string,
  options: VerifyRelayTokenOptions,
): RelayTokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [p, s] = parts as [string, string];
  if (!B64URL.test(p) || !B64URL.test(s)) return { ok: false, reason: 'malformed' };
  const payloadBytes = Buffer.from(p, 'base64url');
  const given = Buffer.from(s, 'base64url');
  const key = keyBytes(options.instanceKey);
  if (key.length === 0) return { ok: false, reason: 'bad_signature' };
  const expected = sign(key, payloadBytes);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const payload = parsePayload(payloadBytes);
  if (!payload) return { ok: false, reason: 'malformed' };
  if (payload.instanceId !== options.instanceId) return { ok: false, reason: 'wrong_instance' };
  if (payload.machineId !== options.machineId) return { ok: false, reason: 'wrong_machine' };
  if (payload.exp <= options.nowSeconds) return { ok: false, reason: 'expired' };
  if (options.nonces && !options.nonces.claim(payload.nonce, payload.exp, options.nowSeconds)) {
    return { ok: false, reason: 'replayed' };
  }
  return { ok: true, payload };
}

/**
 * The seen-nonce set, in memory, each entry kept until its token's `exp` (after
 * which the token is refused as expired anyway, so the nonce can be forgotten).
 */
export class NonceMemory {
  private readonly seen = new Map<string, number>();

  /** True when the nonce is new (and now remembered); false on a replay. */
  claim(nonce: string, exp: number, nowSeconds: number): boolean {
    this.sweep(nowSeconds);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, exp);
    return true;
  }

  /** How many nonces are held — for tests. */
  get size(): number {
    return this.seen.size;
  }

  private sweep(nowSeconds: number): void {
    for (const [nonce, exp] of this.seen) if (exp <= nowSeconds) this.seen.delete(nonce);
  }
}

/**
 * A fixed vector of the format, for both sides' tests. Nothing here is a real
 * secret: `masterKey` is a test string.
 */
export const RELAY_TOKEN_TEST_VECTOR = {
  masterKey: 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm',
  instanceId: 'inst_1',
  instanceKey: 'yQ3UpqcoVnc1TqoLi_mZVvBWZh7fI4BbdZNYCcVPIpI',
  payload: {
    instanceId: 'inst_1',
    machineId: 'mach_1',
    exp: 1790000000,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    sessionId: '6f1c1c2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  },
  token:
    'eyJpbnN0YW5jZUlkIjoiaW5zdF8xIiwibWFjaGluZUlkIjoibWFjaF8xIiwiZXhwIjoxNzkwMDAwMDAwLCJub25jZSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHciLCJzZXNzaW9uSWQiOiI2ZjFjMWMyZS0zYTRiLTRjNWQtOGU2Zi03YThiOWMwZDFlMmYifQ.nwIwYnzW32HlXXt9Li5Gwd4smpk4fm2_y0laZHl7kTc',
} as const satisfies { payload: RelayTokenPayload } & Record<string, unknown>;
