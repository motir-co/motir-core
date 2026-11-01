import type { PermissionKey } from '@/lib/permissions/catalog';
import { grantAllows } from '@/lib/tokens/grant';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { TOKEN_PREFIX } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';

/**
 * Bearer-token auth for a plain REST route (Story MOTIR-1627 · Subtask
 * MOTIR-1631) — the non-MCP counterpart to `verifyMcpToken`. The acceptance-video
 * publish endpoint is the first REST route a CI/service token (not a session
 * cookie) may call, so it authenticates the `Authorization: Bearer motir_pat_…`
 * header the same way: resolve the token to its bound `{ userId, workspaceId }`
 * and require a specific PERMISSION (MOTIR-2576 — it took a `TokenScope` until
 * the vocabularies merged).
 *
 * Returns a discriminated result the route maps to a status: `unauthenticated`
 * → 401 (missing / malformed / unknown / revoked / expired — never
 * distinguished, matching the MCP gate), `forbidden` → 403 (valid token, but its
 * grant does not hold the required permission). A real outage propagates so it
 * surfaces as a 500, not a masked auth failure.
 */
export type ApiTokenAuthResult =
  | {
      ok: true;
      userId: string;
      workspaceId: string;
      /** The token's project binding, or null (MOTIR-2607). The wrapper puts it
       *  on the ServiceContext, where `projectAccessService` enforces it. */
      projectId: string | null;
      /** The token's resolved grant — carried onto the ServiceContext as
       *  `tokenGrant` for the record-view reads (MOTIR-6330). */
      grant: PermissionKey[];
      /** The dispatch run a RUN token is bound to (MOTIR-688), or null. Only
       *  ever non-null on a route that passed `acceptsRunToken`. */
      dispatchRunId: string | null;
    }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' | 'run_token_refused' };

export interface AuthenticateApiTokenOptions {
  /**
   * Admit a RUN token (MOTIR-688, `docs/decisions/hosted-agent-run.md` §3) —
   * a token bound to one dispatch run. Default FALSE, and that default is the
   * whole lock: a run token holds `work_item:edit`, which on its own reaches
   * every card in the project, so every door refuses it unless the route
   * declared it one of the three a hosted run needs (its run's ingest append
   * and close, its card's dispatch prompt). A route that opts in MUST then
   * check the binding against what it touches — the key admits the kind of
   * call, the binding decides which run.
   */
  acceptsRunToken?: boolean;
}

/** The secret out of an `Authorization: Bearer …` header, or undefined. */
export function bearerFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

export async function authenticateApiToken(
  req: Request,
  requiredPermission: PermissionKey,
  options: AuthenticateApiTokenOptions = {},
): Promise<ApiTokenAuthResult> {
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token || !token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'unauthenticated' };

  let user;
  let workspaceId: string;
  let grant: PermissionKey[];
  let projectId: string | null;
  let dispatchRunId: string | null;
  try {
    ({ user, workspaceId, grant, projectId, dispatchRunId } = await apiTokensService.verify(token));
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError
    ) {
      return { ok: false, reason: 'unauthenticated' };
    }
    throw err;
  }

  // A RUN token at a door that did not opt in. Checked BEFORE the grant: the
  // grant would admit it (it holds `work_item:edit`), which is exactly why the
  // grant cannot be what refuses it.
  if (dispatchRunId !== null && !options.acceptsRunToken) {
    return { ok: false, reason: 'run_token_refused' };
  }
  if (!grantAllows(grant, requiredPermission)) return { ok: false, reason: 'forbidden' };
  return { ok: true, userId: user.id, workspaceId, projectId, grant, dispatchRunId };
}
