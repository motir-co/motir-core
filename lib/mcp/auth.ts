import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { apiTokensService } from '@/lib/services/apiTokensService';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';
import { TOKEN_PREFIX } from '@/lib/apiTokens/token';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { OAuthAccessTokenRejectedError } from '@/lib/oauth/errors';
import { isConnectionError, retryReadOnceOnConnectionError } from '@/lib/prisma/connectionError';
import type { McpAuthExtra } from './context';

// The MCP server's transport-level auth gate (Story 7.8 · Subtask 7.8.4).
//
// This is the ONLY authorization logic in the MCP layer — no tool re-checks
// permissions. mcp-handler's `withMcpAuth(handler, verifyMcpToken, { required:
// true })` calls this for every request and, when it returns `undefined`,
// rejects the request with a 401 (`WWW-Authenticate`) BEFORE any JSON-RPC tool
// dispatch — the MCP-spec-correct, transport-level place to reject auth (the
// spec's auth is transport-level; an OAuth layer could be added in front later
// without re-shaping a single tool — story-7.8 header, the PAT-over-OAuth
// deviation). On success it resolves the actor and stashes `{ userId,
// workspaceId }` in `AuthInfo.extra`; from there every tool builds the same
// `ServiceContext` the cookie session would have produced, so the tools hit the
// exact 6.4 role checks + the 404-not-403 cross-tenant contract the routes do.
//
// The workspace comes from the TOKEN, not the user's default (bug 7.21). A PAT
// is workspace-scoped (the verified Linear mirror): `verify` returns the
// `workspaceId` the token was bound to at mint time, and that IS the request
// workspace — so a token minted in workspace A always acts on A, even when A is
// not the owner's oldest/default workspace. (The retired behaviour resolved the
// owner's first workspace via `resolveActiveWorkspace(userId, null)`, which made
// every token act on the signup-default workspace and left projects in any other
// workspace unreachable.) The per-tool 6.4 gates still apply with this
// `workspaceId`, so a token whose owner has lost membership simply gets the same
// 404-not-403 the cookie path would.
//
// TWO BEARERS, ONE ACTOR (MOTIR-6983). A `motir_pat_…` string takes the PAT path
// above, unchanged. Anything else is an OAuth access token from "Sign in with
// Motir": it resolves to the CONNECTION the person approved, which is itself an
// `api_token` row, and yields the SAME `AuthInfo.extra` — so no tool, permission
// gate or rate limiter can tell the two apart, and none needs to. Every refusal
// on either arm is `undefined`, which `withMcpAuth` answers 401 with
// `WWW-Authenticate: Bearer … resource_metadata="<base>/.well-known/oauth-protected-resource"`
// (`app/api/mcp/route.ts`), the pointer an MCP client follows to start OAuth.
//
// A DROPPED CONNECTION IS NOT A REFUSAL (MOTIR-10168). `withMcpAuth` answers
// EVERY throw out of this verifier with the same 401 `invalid_token` a bad token
// gets — mcp-handler 1.1.0 catches it, `console.error`s it and refuses — so a
// database that dropped its pooled connections (a machine waking, a failover)
// told every client its valid credential was rejected, and the clients asked
// their people to re-authorise. So the lookup on BOTH arms is retried once on a
// connection error, and a second one is raised as `McpAuthUnavailableError`,
// which the route answers 503 with `Retry-After` and reports. Anything else that
// is not a refusal propagates untouched, and the route re-throws it as the
// unhandled fault it is.

/**
 * `Retry-After` on the 503 a token check answers when its database connection
 * dropped twice (MOTIR-10168). A dropped pooled connection is replaced within
 * moments — the same horizon as the session read's and the public ideas
 * routes' 503s (`SESSION_UNAVAILABLE`, MOTIR-5864 · MOTIR-8350).
 */
export const MCP_AUTH_RETRY_AFTER_SECONDS = 5;

/**
 * The token check could not REACH the database: the connection dropped on the
 * first attempt and on the one retry. Not a refusal — the credential was never
 * judged — so the route answers 503 with `Retry-After`, never the 401 that would
 * send an MCP client into re-authorisation.
 */
export class McpAuthUnavailableError extends Error {
  readonly code = 'MCP_AUTH_UNAVAILABLE';

  constructor(cause: unknown) {
    super('The token could not be checked: the database connection was lost.', { cause });
    this.name = 'McpAuthUnavailableError';
  }
}

/**
 * Run one arm's token lookup, retried ONCE on a dropped connection
 * (`retryReadOnceOnConnectionError`, MOTIR-8350); a second connection error in a
 * row becomes {@link McpAuthUnavailableError}.
 *
 * ⚠️ The helper is for reads, and each lookup also WRITES a throttled
 * `lastUsedAt` touch in the same transaction. Repeating it is safe all the same:
 * the touch stamps "now" on the row the read just found, so a first attempt that
 * committed before its connection dropped leaves the retry either skipping the
 * touch (inside the throttle window) or stamping a later "now" — the same row,
 * the same meaning, nothing counted twice.
 */
async function lookupWithOneRetry<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await retryReadOnceOnConnectionError(lookup);
  } catch (err) {
    if (isConnectionError(err)) throw new McpAuthUnavailableError(err);
    throw err;
  }
}

/** Extract the `Bearer` credential from an Authorization header value. */
function bearerFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Resolve a bearer PAT to the {@link AuthInfo} mcp-handler attaches to the
 * request (`req.auth`), or `undefined` to reject the request as unauthenticated
 * (→ 401 before any tool runs).
 *
 * `bearerToken` is supplied by mcp-handler (parsed from the `Authorization`
 * header); we fall back to parsing the header off `req` so the function is also
 * usable/testable standalone. Unknown / revoked / expired / malformed tokens
 * all resolve to `undefined` — a uniform rejection that never distinguishes the
 * reason to a caller. A lookup whose database connection drops is retried once;
 * a second drop throws {@link McpAuthUnavailableError}. Any OTHER error
 * propagates. Neither may reach `withMcpAuth` as a throw — it would answer it
 * 401 like a refusal — so `app/api/mcp/route.ts` catches both around this call:
 * the first becomes a 503, the second is re-thrown as a 500.
 */
export async function verifyMcpToken(
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  const token = bearerToken ?? bearerFromHeader(req.headers.get('authorization'));
  if (!token) return undefined;
  if (!token.startsWith(TOKEN_PREFIX)) return verifyOAuthAccessToken(token);

  let user;
  let workspaceId: string;
  let grant: string[];
  let projectId: string | null;
  let dispatchRunId: string | null;
  try {
    ({ user, workspaceId, grant, projectId, dispatchRunId } = await lookupWithOneRetry(() =>
      apiTokensService.verify(token),
    ));
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError
    ) {
      return undefined;
    }
    throw err;
  }

  // A RUN token (MOTIR-688) never reaches the MCP surface. It holds
  // `work_item:edit`, which every write tool here asserts, and nothing on this
  // transport knows which run it is bound to — so the only safe answer is the
  // same uniform rejection an unknown token gets. A hosted run reports through
  // the `/api/v1` ingest, which checks the binding.
  if (dispatchRunId !== null) return undefined;

  // The request workspace IS the workspace the token was bound to at mint time
  // (bug 7.21) — NOT the owner's default workspace. The per-tool 6.4 gates
  // enforce access with it. The token's resolved GRANT rides alongside so the
  // dispatch gate can narrow the role to the permitted operations. It is already
  // expanded (`apiTokensService.verify`), so a legacy scope string never reaches
  // the gate.
  const extra: McpAuthExtra = {
    userId: user.id,
    workspaceId,
    userName: user.name,
    projectId,
    grant,
  };
  return {
    token,
    clientId: user.id,
    scopes: [],
    extra: { ...extra },
  };
}

/**
 * The OAuth arm (MOTIR-6983): resolve an access token to its connection and build
 * the same {@link AuthInfo} the PAT arm does. Every refusal — unknown, expired,
 * unbound, a person who left the workspace — is the same `undefined` (→ 401);
 * a dropped connection is retried once, and every other error propagates, as on
 * the PAT arm.
 */
async function verifyOAuthAccessToken(token: string): Promise<AuthInfo | undefined> {
  let resolved;
  try {
    resolved = await lookupWithOneRetry(() => oauthConnectionsService.resolveAccessToken(token));
  } catch (err) {
    if (err instanceof OAuthAccessTokenRejectedError) return undefined;
    throw err;
  }
  const extra: McpAuthExtra = {
    userId: resolved.user.id,
    workspaceId: resolved.workspaceId,
    userName: resolved.user.name,
    projectId: resolved.projectId,
    grant: resolved.grant,
  };
  return {
    token,
    clientId: resolved.user.id,
    scopes: [],
    // Seconds, as `withMcpAuth` compares it — a second check at the transport.
    expiresAt: Math.floor(resolved.expiresAt.getTime() / 1000),
    extra: { ...extra },
  };
}
