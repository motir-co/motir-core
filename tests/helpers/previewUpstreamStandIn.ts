import { createServer, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

// A STAND-IN for a tenant's preview application (Story MOTIR-5766 · MOTIR-10100):
// a loopback HTTP server a lane points a ready preview's fake release at
// (`setUpstream(appRef, standIn.origin)`), which records every request it receives
// and answers one labelled page.
//
// A REAL SOCKET, because the shipped forward is a server-side rewrite: for an
// origin-secret release `gateProxy.forward()` answers `NextResponse.rewrite`, so
// the fetch is made by the `next` server, which a browser-level `page.route` stub
// never sees. `127.0.0.1` on an ephemeral port, so it is reachable from that server
// however the lane resolves preview hosts.
//
// Imports nothing from `@/`, so a vitest seam and the Playwright walk share it
// without loading the database.

/** One request the stand-in received. `path` is the request line's target,
 *  query included. */
export interface StandInRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface PreviewUpstreamStandIn {
  /** `http://127.0.0.1:<port>` — what a lane passes to `setUpstream`. */
  readonly origin: string;
  /** Everything received, in arrival order. */
  requests(): readonly StandInRequest[];
  /** The latest request, or undefined before the first. */
  last(): StandInRequest | undefined;
  /** The first request (already received or still to come) matching `predicate`. */
  waitForRequest(
    predicate?: (request: StandInRequest) => boolean,
    timeoutMs?: number,
  ): Promise<StandInRequest>;
  /** Forget what was received; the origin stays. */
  reset(): void;
  /** Close the listener and release its port. */
  stop(): Promise<void>;
}

export const STAND_IN_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Preview stand-in</title></head>
  <body>
    <main data-testid="preview-stand-in">
      <h1>A stand-in for the tenant&rsquo;s application</h1>
      <p>The preview gate forwarded this request here.</p>
    </main>
  </body>
</html>
`;

export async function startPreviewUpstreamStandIn(): Promise<PreviewUpstreamStandIn> {
  const received: StandInRequest[] = [];
  const waiters = new Set<{
    predicate: (request: StandInRequest) => boolean;
    resolve: (request: StandInRequest) => void;
  }>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: StandInRequest = {
        // Always set on a request a server receives; optional only in the type.
        method: req.method!,
        path: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(request);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(request)) continue;
        waiters.delete(waiter);
        waiter.resolve(request);
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(STAND_IN_PAGE);
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests: () => [...received],
    last: () => received.at(-1),
    waitForRequest(predicate = () => true, timeoutMs = 10_000) {
      const already = received.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`the preview stand-in received no matching request in ${timeoutMs}ms`));
        }, timeoutMs);
        waiter.resolve = (request) => {
          clearTimeout(timer);
          resolve(request);
        };
        waiters.add(waiter);
      });
    },
    reset() {
      received.length = 0;
    },
    async stop() {
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    },
  };
}
