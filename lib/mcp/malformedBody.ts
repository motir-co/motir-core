// `req.auth` is `mcp-handler`'s global augmentation of `Request`. Import it here
// rather than inherit it from whichever route happens to load the library: the
// lib layer is its own type-check project (`tsconfig.lib.json`, MOTIR-10798).
import type {} from 'mcp-handler';

// A POST whose body is not JSON (MOTIR-7299).
//
// `mcp-handler@1.1.0` reads a POST's body with `await req.json()` whenever the
// Content-Type says JSON, BEFORE the MCP transport sees the request. An empty
// body (`curl -X POST … -d ''`), a truncated one, or one that is simply not JSON
// rejects that read with `SyntaxError: Unexpected end of JSON input` (or a
// sibling message). Since MOTIR-6853's patch the library hands the rejection
// back to the route, where `answerClientAbort` re-throws anything that is not a
// departed client — so a caller's malformed request reached the monitor as an
// unhandled server fault on every occurrence.
//
// It is the caller's fault, and the protocol already says what to answer: the
// SDK's own transport (`WebStandardStreamableHTTPServerTransport.handlePostRequest`)
// answers a body it cannot parse with 400 and JSON-RPC error -32700 "Parse
// error: Invalid JSON". It never gets the chance only because the library parsed
// first. So this wrapper parses first instead, on a CLONE (the original stream
// is left for the library), and gives that same answer.
//
// ⚠️ NARROW, like `answerClientAbort`: it decides only on the body it parsed
// itself, under the same Content-Type test the library applies. It catches
// nothing the wrapped handler throws, so a SyntaxError raised anywhere else is
// still a server fault and still reaches the monitor. A read that fails because
// the client hung up is re-thrown untouched, for `answerClientAbort` to answer.

type McpRouteHandler = (req: Request) => Promise<Response>;

/** JSON-RPC 2.0's code for an unparseable request (spec §5.1). */
export const JSON_RPC_PARSE_ERROR = -32700;

/** The message the MCP SDK's transport uses for the same refusal. */
const PARSE_ERROR_MESSAGE = 'Parse error: Invalid JSON';

/** True when the library will read this request's body with `req.json()` —
 *  the exact test `mcp-handler` applies. */
function libraryParsesAsJson(req: Request): boolean {
  return (
    req.method === 'POST' && (req.headers.get('content-type') ?? '').includes('application/json')
  );
}

export function answerMalformedBody(handler: McpRouteHandler): McpRouteHandler {
  return async (req) => {
    if (!libraryParsesAsJson(req)) return handler(req);

    // A read failure (the client hung up) propagates as it always has.
    const body = await req.clone().text();
    try {
      JSON.parse(body);
    } catch {
      const user = req.auth?.extra?.['userId'];
      console.warn(
        `[mcp] POST /api/mcp: the request body is not valid JSON (${body.length} bytes); ` +
          `answered 400 / ${JSON_RPC_PARSE_ERROR}${typeof user === 'string' ? ` (user ${user})` : ''}.`,
      );
      return Response.json(
        {
          jsonrpc: '2.0',
          error: { code: JSON_RPC_PARSE_ERROR, message: PARSE_ERROR_MESSAGE },
          id: null,
        },
        { status: 400 },
      );
    }
    return handler(req);
  };
}
