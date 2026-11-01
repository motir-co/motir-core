import * as Sentry from '@sentry/nextjs';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { MCP_SERVER_INFO, registerMcpTools } from '@/lib/mcp/registry';
import { contextFromAuthInfo, contextFromExtra, grantFromExtra } from '@/lib/mcp/context';
import {
  MCP_AUTH_RETRY_AFTER_SECONDS,
  McpAuthUnavailableError,
  verifyMcpToken,
} from '@/lib/mcp/auth';
import { answerClientAbort } from '@/lib/mcp/clientAbort';
import { answerMalformedBody } from '@/lib/mcp/malformedBody';
import { enforceMcpRateLimit } from '@/lib/rateLimit/mcpGuard';
import { tokenFingerprint } from '@/lib/api/v1/bearer';
import { stampRateLimitHeaders } from '@/lib/rateLimit/guard';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { PROTECTED_RESOURCE_METADATA_PATH } from '@/lib/oauth/config';
import { OrganizationSuspendedError } from '@/lib/organizations/errors';
import { withRequestLabel } from '@/lib/monitoring/requestLabel';

// The Motir MCP server (Story 7.8 · Subtask 7.8.4) — one streamable-HTTP
// endpoint exposing the PM core to AI agents and the CLI (7.9), all of which
// speak Model Context Protocol to this single URL.
//
// ── Transport pick (the card asked to evaluate + record). ──────────────────
// We use Vercel's `mcp-handler` (the maintained App-Router adapter) rather than
// wiring `@modelcontextprotocol/sdk`'s transport by hand: the SDK's server
// transport is Node-`req/res`-shaped, and mcp-handler is the piece that bridges
// the Next.js Web `Request`/`Response` to it (creating a fresh stateless
// `WebStandardStreamableHTTPServerTransport` per POST). It also threads the
// resolved `req.auth` straight into each tool handler's `extra.authInfo`, which
// is exactly the actor seam this server needs.
//
// ── Path: a static `/api/mcp` (not the `[transport]` layout). ──────────────
// We serve streamable HTTP ONLY (no legacy SSE), so we don't need the
// `[transport]` dynamic segment that multiplexes `/mcp` vs `/sse`. A static
// `app/api/mcp/route.ts` gives the clean client-facing URL the docs use
// (`/api/mcp`) AND avoids a dynamic catch-all at the `/api` root that an
// `app/api/[transport]/route.ts` would introduce. `mcp-handler` matches the
// request pathname against the endpoint derived from `basePath`, so
// `basePath: '/api'` derives the streamable endpoint to exactly `/api/mcp`;
// `disableSse` turns off the SSE/redis path entirely (stateless, no redis).
//
// ── Auth: transport-level bearer PAT, gated BEFORE any tool dispatch. ───────
// `withMcpAuth(..., { required: true })` runs `verifyMcpToken` on every request
// and rejects an absent/invalid/revoked/expired token with a 401 before a tool
// ever executes. On success the resolved `{ userId, workspaceId }` rides
// `AuthInfo.extra`; `contextFromExtra` lifts it into the `ServiceContext` every
// tool passes to the SAME permission-scoped services the HTTP routes call (6.4
// roles + the 404-not-403 cross-tenant contract). No tool re-checks auth.
//
// ── Rate limiting: TWO layers, because one address carries two costs (2610). ─
// `withMcpAuth` → `limitedHandler` → the JSON-RPC dispatch, in that order. The
// transport layer here spends `mcp:call` on EVERY authenticated request — a
// VOLUME ceiling covering reads, writes, an agent's polling loop, and the
// `initialize` / `tools/list` traffic no tool callback ever sees — and refuses
// with a 429 carrying a JSON-RPC error envelope. The MONEY ceiling on the two
// tools that submit a model job lives one layer in, at the dispatch seam
// (`registerMcpTools(…, meterBillableTools)` → `lib/mcp/rateLimitGate.ts`), so
// spend is metered per TOOL rather than per request. Both use the shared store
// and the shipped guards; `lib/rateLimit/mcpGuard.ts` carries the key-axis
// reasoning: VOLUME per presented credential plus a per-workspace ceiling
// (MOTIR-8601), MONEY per user + workspace like `/api/ai/*`.

export const runtime = 'nodejs';
// Readiness + work-item state flip constantly; never serve a cached MCP body.
export const dynamic = 'force-dynamic';

const baseHandler = createMcpHandler(
  // Register the tool surface on the per-request server, wiring each tool to the
  // production context resolver (reads the bearer-resolved actor off authInfo)
  // and the per-token scope gate (reads the token's granted scopes off the same
  // authInfo) — so every tool call is narrowed to the scopes the token holds
  // (Subtask 7.7.17) before the unchanged 6.4 role checks run in the service.
  // The trailing `true` turns on the billable-tool gate (MOTIR-2610): the two
  // job-submitting tools spend the `ai:generate` budget — the browser's own —
  // before they run.
  (server) => registerMcpTools(server, contextFromExtra, grantFromExtra, true),
  { serverInfo: MCP_SERVER_INFO },
  { basePath: '/api', disableSse: true },
);

// A POST body that is not JSON — empty, truncated, or plain text — answers 400
// with JSON-RPC -32700, the refusal the MCP SDK's own transport gives, instead of
// `mcp-handler`'s `req.json()` throwing `SyntaxError` out of the route as a
// server fault (MOTIR-7299). After the rate limiter, so a malformed request
// still spends the caller's volume budget.
const parsedHandler = answerMalformedBody(baseHandler);

/**
 * The transport rate limiter, between the auth gate and the JSON-RPC dispatch.
 *
 * It sits INSIDE `withMcpAuth` deliberately: `req.auth` is what the key is built
 * from, and an unauthenticated caller must never be able to spend a real
 * tenant's budget (the ordering `/api/v1` pins for the same reason — a 401 exits
 * without touching the limiter).
 *
 * Headers ride EVERY response, not only the refusals, so a client can pace
 * itself before it hits the wall rather than discovering the ceiling by being
 * refused at it.
 */
async function limitedHandler(req: Request): Promise<Response> {
  // The credential is fingerprinted HERE and the plaintext goes no further.
  const token = req.auth?.token;
  const { refusal, headers } = await enforceMcpRateLimit(
    contextFromAuthInfo(req.auth),
    token ? tokenFingerprint(token) : null,
  );
  if (refusal) return refusal;
  return stampRateLimitHeaders(await parsedHandler(req), headers);
}

// `answerClientAbort` sits INSIDE the auth gate, around the layer that reads the
// body: a caller that hangs up before `mcp-handler` has read it answers 499
// rather than surfacing `Error: aborted` as a server fault (MOTIR-6853).
//
// The 401 names where OAuth starts (MOTIR-6983): `WWW-Authenticate: Bearer …
// resource_metadata="<base>/.well-known/oauth-protected-resource"`, the RFC 9728
// pointer an MCP client follows to discover the authorization server. `<base>` is
// the app's own origin (`lib/baseUrl.ts`) rather than the request's, so the header
// names the same document the metadata route serves behind any proxy. Built per
// request because the origin is read at request time, as every derived URL is.
const innerHandler = answerClientAbort(limitedHandler);

/**
 * `withMcpAuth` answers EVERY throw out of the verifier with the 401
 * `invalid_token` an unknown token gets (mcp-handler 1.1.0 catches it and only
 * `console.error`s it). So no throw may reach it: this wrapper catches each one,
 * lets `withMcpAuth` see a refusal, and then answers what the throw MEANT.
 *
 *   · A SUSPENDED organization's credential (MOTIR-748) is the dedicated 403
 *     `ORGANIZATION_SUSPENDED`: a 401 would send an MCP client into a
 *     re-authentication loop for a credential that is valid. The verifier
 *     raises the typed error on both arms — the PAT through
 *     `apiTokensService.verify`, an OAuth connection through the workspace
 *     access gate.
 *   · A token check that LOST ITS DATABASE CONNECTION twice
 *     (`McpAuthUnavailableError`, MOTIR-10168) is a handled 503 with
 *     `Retry-After` — the credential was never judged, so a 401 would tell the
 *     client to throw a good one away. It is reported to Sentry here, because a
 *     handled answer is otherwise invisible to the monitor.
 *   · Anything else is a fault, and is re-thrown, so it reaches the monitor and
 *     answers 500 as any unhandled route error does — never 401.
 */
async function handler(req: Request): Promise<Response> {
  let thrown: { err: unknown } | null = null;
  const verify: typeof verifyMcpToken = async (r, bearer) => {
    try {
      return await verifyMcpToken(r, bearer);
    } catch (err) {
      thrown = { err };
      return undefined;
    }
  };
  const res = await withMcpAuth(innerHandler, verify, {
    required: true,
    resourceUrl: resolveBaseUrlTrimmed(),
    resourceMetadataPath: PROTECTED_RESOURCE_METADATA_PATH,
  })(req);
  const outcome = thrown as { err: unknown } | null;
  if (outcome === null) return res;
  const caught = outcome.err;
  if (caught instanceof OrganizationSuspendedError) {
    return Response.json(
      {
        code: caught.code,
        error: caught.message,
        organizationId: caught.organizationId,
      },
      { status: 403 },
    );
  }
  if (caught instanceof McpAuthUnavailableError) {
    Sentry.captureException(caught, { tags: { mcp_auth: 'unavailable' } });
    return Response.json(
      { code: caught.code, error: caught.message },
      { status: 503, headers: { 'Retry-After': String(MCP_AUTH_RETRY_AFTER_SECONDS) } },
    );
  }
  throw caught;
}

/**
 * Every transaction of an MCP request is recorded as `route="mcp"` (MOTIR-8553):
 * the token verify and session resolution here with no tool, and each tool
 * call's own work under its tool, which the registry's per-tool wrapper sets.
 */
async function labelledHandler(req: Request): Promise<Response> {
  return withRequestLabel({ route: 'mcp' }, () => handler(req));
}

export { labelledHandler as GET, labelledHandler as POST, labelledHandler as DELETE };
