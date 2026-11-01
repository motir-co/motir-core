import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseReturnSurfaceId, type GithubReturnSurfaceId } from './returnSurface';
import {
  INSTALL_RETURN_CONTEXT_KEYS,
  INSTALL_RETURN_CONTEXT_MAX_LENGTH,
  type InstallReturnContext,
} from './installReturnContext';

export type { InstallReturnContext } from './installReturnContext';

// Signed, self-contained state carried through the GitHub App install round-trip
// (MOTIR-1588). Unlike the OAuth identity flow — which stashes a CSRF nonce in an
// httpOnly cookie (MOTIR-1498) — the App INSTALL starts from a bare GitHub URL
// (`github.com/apps/<slug>/installations/new`) with no request to Motir, so no
// cookie can be set. GitHub echoes back whatever `state` the install URL carried,
// so the state must be self-verifying: a base64url JSON payload
// `{ w: workspaceId, u: userId, exp }` + an HMAC-SHA256 signature.
//
// Keyed by `BETTER_AUTH_SECRET` (always configured — the app can't run without
// it) with a domain-separation context so this signature can never be confused
// with any other HMAC the app makes. Short-lived (10 min) so a leaked install
// link can't be replayed to bind an installation later. The setup handler
// re-checks the acting session user == `u` and that they're a member of `w`, so
// the state is a binding HINT, not an authorization by itself.

const CONTEXT = 'github-install-state.v1';
const TTL_SECONDS = 600;

function signingKey(): string {
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is not set (required to sign the GitHub install state)');
  }
  return secret;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', signingKey()).update(`${CONTEXT}.${payloadB64}`).digest('base64url');
}

/** Shape-narrow an untrusted context: known keys, non-empty bounded strings.
 *  Returns `undefined` when nothing survives, so an empty context is never
 *  written and never decoded into an extra key. */
function narrowContextShape(value: unknown): InstallReturnContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const out: InstallReturnContext = {};
  for (const key of INSTALL_RETURN_CONTEXT_KEYS) {
    const v = source[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= INSTALL_RETURN_CONTEXT_MAX_LENGTH) {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface InstallState {
  workspaceId: string;
  userId: string;
  /** WHERE THE FLOW STARTED, so the setup handler can return the person there
   *  (MOTIR-4676). OPTIONAL, and it has to stay optional: an envelope minted
   *  before this field existed is still in somebody's browser, still verifies,
   *  and must decode to a state with no origin rather than to a rejection.
   *
   *  It is an ID from `GITHUB_RETURN_SURFACES`, never a path — see that module
   *  for why. It rides INSIDE the signature rather than beside it because the
   *  App install starts from a bare github.com URL where no cookie can be set,
   *  so this value takes the round trip and has to come back unforged. */
  origin?: GithubReturnSurfaceId;
  /** The ORGANISATION the install was started for (Story MOTIR-8216 ·
   *  MOTIR-8220) — payload key `g`, omitted when absent exactly as `o` is, so a
   *  token minted before this field still decodes (to a state with none). Its
   *  presence routes the setup round trip through the per-organisation link. */
  organizationId?: string;
  /** The address the install started from, beyond its surface id — see
   *  {@link InstallReturnContext}. Payload key `c`, OMITTED when empty exactly
   *  as `o` and `g` are, so a token minted without one is byte-identical to one
   *  minted before the field existed and decodes with no `context` key. */
  context?: InstallReturnContext;
  /** The PROJECT the install was started for (Bug MOTIR-9828) — payload key
   *  `p`, omitted when absent exactly as `o`, `g` and `c` are. Minted only by a
   *  project's Repositories room, whose `Connect a new one` promises the
   *  organisation connection AND the project link in one act: on return the
   *  setup handler links the repositories this round trip connected into this
   *  project. It is the project's KEY, resolved again under the acting
   *  session's own access checks on return — a hint, like `w`, never an
   *  authorisation by itself. */
  projectKey?: string;
}

/** The longest project key the state carries. Project keys are short prefixes;
 *  anything longer is not one and is dropped rather than signed into a link. */
const PROJECT_KEY_MAX_LENGTH = 64;

function narrowProjectKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= PROJECT_KEY_MAX_LENGTH
    ? value
    : undefined;
}

/** Encode + sign a short-lived install-state token.
 *
 *  ⚠️ `o` is OMITTED when there is no origin rather than written as `null`, so
 *  a token minted with no origin is byte-identical to one minted before the
 *  field existed. That keeps the compatibility claim above testable with a
 *  fixture rather than with a promise. */
export function encodeInstallState(
  state: InstallState,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: {
    w: string;
    u: string;
    exp: number;
    o?: GithubReturnSurfaceId;
    g?: string;
    c?: InstallReturnContext;
    p?: string;
  } = {
    w: state.workspaceId,
    u: state.userId,
    exp: nowSeconds + TTL_SECONDS,
  };
  if (state.origin) payload.o = state.origin;
  if (state.organizationId) payload.g = state.organizationId;
  const context = narrowContextShape(state.context);
  if (context) payload.c = context;
  const projectKey = narrowProjectKey(state.projectKey);
  if (projectKey) payload.p = projectKey;
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/** Why a token did not decode. `expired` is separated from the rest because it
 *  is the one rejection that is NOT a sign anything is wrong: the person took
 *  longer than the TTL on GitHub's repository picker, and the remedy is to start
 *  again from Settings rather than to conclude the install failed (MOTIR-3755).
 *  Everything else — a truncated token, a bad signature, a payload of the wrong
 *  shape — is indistinguishable from tampering and stays one reason. */
export type InstallStateRejection = 'malformed' | 'expired';

export type InstallStateResult =
  | {
      ok: true;
      state: InstallState;
      /** When the token was minted, in epoch seconds — `exp` minus the TTL.
       *  The project round trip (MOTIR-9828) links only the repositories
       *  connected AFTER this moment, so it reads it off the signed payload
       *  rather than trusting a clock nobody signed. */
      issuedAt: number;
    }
  | { ok: false; reason: 'malformed' }
  | {
      ok: false;
      reason: 'expired';
      /** ⚠️ THE ONE THING AN EXPIRED STATE STILL DECIDES (MOTIR-8471): where
       *  the person is returned to. The TTL exists so a leaked install link
       *  cannot BIND an installation later — and the binding stays refused. It
       *  is not a statement about where somebody may land: the signature
       *  verified, the origin is a closed-map id and the context is narrowed,
       *  so honouring them is what lets an install that outlived the TTL come
       *  back to the step it started on, reported as expired. Each key is
       *  present only when the payload carried a readable value. */
      origin?: GithubReturnSurfaceId;
      context?: InstallReturnContext;
    };

/** Verify + decode an install-state token, reporting WHY it was rejected.
 *  Constant-time signature compare. The checks are unchanged — this only names
 *  the outcome the caller was previously handed as a bare `null`. */
export function decodeInstallStateResult(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): InstallStateResult {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const b64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(b64);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'malformed' };

  let payload: {
    w?: unknown;
    u?: unknown;
    exp?: unknown;
    o?: unknown;
    g?: unknown;
    c?: unknown;
    p?: unknown;
  };
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload.w !== 'string' ||
    typeof payload.u !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // The origin is NARROWED, not trusted. It arrived inside the signature, so it
  // is ours — but an id this build no longer registers (a surface that was
  // renamed or removed between minting and return) must decode to "no origin"
  // and fall back, never to a path this build cannot serve.
  const origin = parseReturnSurfaceId(typeof payload.o === 'string' ? payload.o : null);
  // The context likewise: an unreadable value is DROPPED, never a rejection of
  // the token — the signature already said the token is ours.
  const context = narrowContextShape(payload.c);
  // Only a token that VERIFIED can be called expired — an unsigned payload
  // claiming a past `exp` must stay `malformed`, so the expiry banner (which
  // says nothing is broken) is never reachable from an unauthenticated string.
  if (payload.exp < nowSeconds) {
    return {
      ok: false,
      reason: 'expired',
      ...(origin ? { origin } : {}),
      ...(context ? { context } : {}),
    };
  }
  const projectKey = narrowProjectKey(payload.p);
  return {
    ok: true,
    issuedAt: payload.exp - TTL_SECONDS,
    state: {
      workspaceId: payload.w,
      userId: payload.u,
      ...(origin ? { origin } : {}),
      ...(typeof payload.g === 'string' && payload.g.length > 0
        ? { organizationId: payload.g }
        : {}),
      ...(context ? { context } : {}),
      ...(projectKey ? { projectKey } : {}),
    },
  };
}

/** Verify + decode an install-state token, or `null` when it is malformed,
 *  tampered (bad signature), or expired. */
export function decodeInstallState(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): InstallState | null {
  const result = decodeInstallStateResult(token, nowSeconds);
  return result.ok ? result.state : null;
}
