import { retryAfterSeconds, type RateLimitDecision } from '@/lib/api/v1/rateLimit';
import { mcpBudget } from '@/lib/rateLimit/budgets';
import {
  rateLimitResponseHeaders,
  RATE_LIMITED_CODE,
  spendOwnThenShared,
} from '@/lib/rateLimit/guard';
import { rateLimitKey } from '@/lib/rateLimit/keys';
import { agentWorkspaceLimb } from '@/lib/rateLimit/workspaceCeiling';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The MCP TRANSPORT guard (MOTIR-2610) — the ceiling on `POST /api/mcp` itself.
//
// ── Why this surface needed its own guard at all ────────────────────────────
// 8.5.9 limited the browser AI routes and MOTIR-2597 gave the job-submitting
// ones their own tighter bucket. `/api/mcp` was in neither pass and carried no
// limiter of ANY kind — while being the door Motir's own CLI and every coding
// agent speak through, i.e. the caller most likely to loop.
//
// ── TWO layers, because ONE address carries two different costs ─────────────
// `/api/mcp` multiplexes every tool through a single route, so a guard here
// cannot tell a `get_work_item` from an `expand_item`. Rather than pick one
// ceiling for both, the surface is metered twice, each layer metering what it
// actually is:
//
//   1. HERE — every POST spends `mcp:call`, a generous VOLUME budget. Reads,
//      transitions, sprint writes and an agent's polling loop are cheap but not
//      free, and this is the only layer that sees the requests a tool dispatch
//      never reaches (`initialize`, `tools/list`, a malformed body).
//   2. `lib/mcp/rateLimitGate.ts` — the two tools that submit a MODEL JOB
//      additionally spend `ai:generate`, through the very same
//      `enforceAiRateLimit` the browser's `/api/ai/expand` calls.
//
// ── KEYED ON USER + WORKSPACE, like `/api/ai/*` — not on the PAT fingerprint ─
// `/api/v1` keys on the credential (`lib/api/v1/route.ts`) because a token there
// IS the client: one integration per token, and a customer running two of them
// legitimately gets two budgets. That reasoning inverts here. The MCP actor
// resolves all the way to `{ userId, workspaceId }` (`lib/mcp/context.ts`), and
// the expensive half of this surface draws the SAME `ai:generate` bucket as the
// browser — so keying on the fingerprint would hand every newly-minted PAT a
// fresh generation allowance, and minting tokens is self-service. The ceiling
// MOTIR-2597 put on a user's spend would then be a ceiling on their browser tab
// only. Cost accrues to a workspace and is caused by a user; the key is both, on
// both doors, or it is not a ceiling.
//
// ── AMENDED (MOTIR-8601, Story MOTIR-8548): VOLUME per agent, MONEY per person ─
// The argument above is about the MONEY half, and it still holds: the generation
// budget lives one layer in (`lib/mcp/rateLimitGate.ts` → `ai:generate`, keyed
// on `(workspace, user)`) and is unchanged. Applied to the VOLUME half it
// starved a person's concurrent agents of one shared 300/min. So `mcp:call` is
// now keyed on the presented CREDENTIAL's fingerprint — one bucket per agent —
// and every request ALSO spends the workspace's shared `agent:workspace`
// ceiling (`lib/rateLimit/workspaceCeiling.ts`). Minting a credential adds a
// per-agent bucket and no ceiling, so self-service minting still cannot buy past
// what the workspace may spend; and a credential is only ever a fingerprint
// here, never the plaintext. The ceiling is spent only after the agent's own
// limb admits (MOTIR-8610), so a refused agent costs its workspace nothing.

/** The JSON-RPC error code a transport-level refusal carries.
 *
 * `-32029` sits inside JSON-RPC 2.0's implementation-defined server-error range
 * (`-32000..-32099`) and clear of every code the MCP SDK reserves in it
 * (`ConnectionClosed = -32000`, `RequestTimeout = -32001`,
 * `UrlElicitationRequired = -32042`), so a client can key off it without
 * colliding with a transport condition. */
export const MCP_RATE_LIMITED_JSONRPC_CODE = -32029;

/**
 * Shape the refusal as a **JSON-RPC error envelope under HTTP 429** — the form
 * `mcp-handler` itself uses for a transport-level refusal, rather than the bare
 * `{ code, error }` body the other app guards return.
 *
 * The evidence, from the adapter's own error surface (`mcp-handler@1.1.0`):
 *
 *   - Its GET/DELETE rejection answers with **HTTP 405 AND a JSON-RPC envelope**
 *     — `{ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' },
 *     id: null }`. A non-2xx status paired with a parseable JSON-RPC body is the
 *     established shape for "refused before dispatch", and `id: null` is what it
 *     uses when no request id has been read. This mirrors it exactly.
 *   - Its auth rejections (`withMcpAuth`) return a bare OAuth `{ error,
 *     error_description }` at 401/403 with no JSON-RPC framing at all — so the
 *     adapter does NOT hold that every response must be JSON-RPC. The envelope
 *     here is a deliberate choice for parseability, not a constraint.
 *
 * What a client actually gets: the official SDK's `StreamableHTTPClientTransport`
 * does not parse a non-2xx body — it throws `StreamableHTTPError(status, text)`
 * (`client/streamableHttp.js`, the `!response.ok` arm of `send`). So the STATUS
 * is what an SDK client keys on and the body is what it surfaces; a direct HTTP
 * client (curl, an agent posting JSON-RPC itself) can `JSON.parse` the envelope
 * and read `error.data`. Both are served, and neither is handed an opaque body.
 *
 * The per-tool refusal is the other half of the answer and takes the OTHER
 * shape: an `isError` `CallToolResult` at HTTP 200, which every MCP client
 * parses natively (`lib/mcp/rateLimitGate.ts`).
 */
export function mcpRateLimitedResponse(decision: RateLimitDecision): Response {
  const retryAfter = retryAfterSeconds(decision);
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: MCP_RATE_LIMITED_JSONRPC_CODE,
        message: `Too many requests. Retry in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
        // The machine-readable half: the same `RATE_LIMITED` code the app's other
        // 429s carry, plus the numbers already in the headers — so an agent that
        // only ever reads the JSON-RPC body can still back off correctly.
        data: {
          code: RATE_LIMITED_CODE,
          retryAfterSeconds: retryAfter,
          limit: decision.limit,
          remaining: decision.remaining,
          resetAt: decision.resetAt,
        },
      },
    }),
    {
      status: 429,
      // `Retry-After` is re-stated from the SAME value as the body, so a second
      // boundary ticking between two reads of the clock cannot make them disagree.
      headers: {
        ...rateLimitResponseHeaders(decision),
        'Retry-After': String(retryAfter),
        'Content-Type': 'application/json',
      },
    },
  );
}

/** A transport verdict: the refusal to return, and the headers to stamp on the
 *  handler's response when there is none. */
export interface McpRateLimitVerdict {
  /** The 429 to return instead of dispatching, or null to proceed. */
  refusal: Response | null;
  /** `X-RateLimit-*` (+ `Retry-After` when refused) — stamped on EVERY response,
   *  not only the refusals, so a client can pace itself before it hits the wall. */
  headers: Record<string, string>;
}

/**
 * Spend one request for `ctx` and report the verdict: the per-AGENT `mcp:call`
 * limb, keyed on `credentialFingerprint`, then the workspace's shared ceiling —
 * the ceiling only once the agent's own limb admitted (MOTIR-8610), so an agent
 * throttled on its own bucket never drains the one its workspace shares.
 * Whichever refuses shapes the 429, and the tighter limb's numbers ride the
 * headers when both admit.
 *
 * Called AFTER `withMcpAuth` has resolved the actor, so an unauthenticated
 * request can never spend a real tenant's budget — the ordering `/api/v1` pins
 * for the same reason.
 *
 * `credentialFingerprint` is the `tokenFingerprint` of the presented bearer —
 * never the plaintext. ⚠️ A `null` one (no token on the auth info) is NEVER
 * unlimited: it falls back to the pre-MOTIR-8601 `(workspace, user)` key, so it
 * shares one bucket with every other unidentified call of the same person.
 */
export async function enforceMcpRateLimit(
  ctx: ServiceContext,
  credentialFingerprint: string | null,
): Promise<McpRateLimitVerdict> {
  const agentKey =
    credentialFingerprint === null
      ? rateLimitKey('mcp:call', ctx.workspaceId, ctx.userId)
      : rateLimitKey('mcp:call', ctx.workspaceId, credentialFingerprint);
  const { refused, tightest } = await spendOwnThenShared(
    { scope: 'mcp:call', key: agentKey, budget: mcpBudget() },
    agentWorkspaceLimb(ctx.workspaceId),
  );
  return {
    refusal: refused ? mcpRateLimitedResponse(refused) : null,
    headers: rateLimitResponseHeaders(refused ?? tightest),
  };
}
