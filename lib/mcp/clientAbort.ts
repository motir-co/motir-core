import { CLIENT_CLOSED_REQUEST_STATUS, isClientAbort } from '@/lib/api/clientAbort';
// `req.auth` is `mcp-handler`'s global augmentation of `Request`. Import it here
// rather than inherit it from whichever route happens to load the library: the
// lib layer is its own type-check project (`tsconfig.lib.json`, MOTIR-10798).
import type {} from 'mcp-handler';

// A caller that hung up before its MCP request body was read (MOTIR-6853).
//
// `mcp-handler` reads a POST's JSON-RPC body itself, so when the connection
// closes first the read rejects with Node's `Error: aborted` / `ECONNRESET`
// inside the library. Patched (`patches/mcp-handler@1.1.0.patch`), the library
// hands that rejection back to the route instead of dropping it as an unhandled
// rejection; this is what the route then does with it.
//
// It is not a server fault: the caller is gone, no JSON-RPC message was read, so
// no tool ran and no answer will be read. It answers 499 and says so at warn
// level. The MCP client (an agent, the CLI) owns the retry.
//
// ⚠️ NARROW, exactly as MOTIR-6256's webhook read is: only `isClientAbort`'s
// shapes are answered here. Any other failure — a body that is not JSON, a fault
// in the auth or rate-limit layers — is re-thrown and still reaches the monitor.

type McpRouteHandler = (req: Request) => Promise<Response>;

export function answerClientAbort(handler: McpRouteHandler): McpRouteHandler {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (!isClientAbort(err, req.signal)) throw err;
      const user = req.auth?.extra?.['userId'];
      console.warn(
        `[mcp] ${req.method} /api/mcp: the client closed the connection before its request ` +
          `body was read; nothing was dispatched${typeof user === 'string' ? ` (user ${user})` : ''}.`,
      );
      return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS });
    }
  };
}
