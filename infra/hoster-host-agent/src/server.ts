import { createServer as createHttpsServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { MAX_REQUEST_BYTES, handleExec, type RunInContainer } from './exec';
import { createRequestLog, type RequestLog } from './log';
import { TERMINAL_PATHS, proxyTerminal, type TerminalTarget } from './terminal';

// THE HOSTER HOST AGENT (Story MOTIR-9361 · MOTIR-9480) — the HTTPS service on
// port 8443 of every AWS agent instance, built to
// `docs/decisions/aws-hoster-host-agent.md`.
//
// ⚠️ THE GATE IS THE TLS HANDSHAKE, not a handler. `requestCert: true` asks every
// client for a certificate and `rejectUnauthorized: true` makes the handshake
// FAIL for a client that sends none or one that does not chain to `ca` — the
// Motir hoster CA, the only trust anchor (the system roots are not consulted
// when `ca` is given). So no route below is reachable without Motir's client
// certificate. Node: https://nodejs.org/api/tls.html#tlscreateserveroptions-secureconnectionlistener
// (`requestCert`, `rejectUnauthorized`, `ca`). Each route checks
// `socket.authorized` again anyway; it is never false here.
//
// It never logs a body, a header, an env value or a key: `log.ts` is the only
// log path and takes the route, the status and the duration.

export interface HostAgentTlsFiles {
  readonly certPem: string;
  readonly keyPem: string;
  /** The Motir hoster CA certificate. */
  readonly caPem: string;
}

export interface HostAgentServerOptions {
  readonly tls: HostAgentTlsFiles;
  readonly runInContainer: RunInContainer;
  readonly terminalTarget: TerminalTarget;
  readonly log?: RequestLog;
  /** The clock for the log's duration — the test seam. */
  readonly now?: () => number;
}

function routeOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0] ?? '/';
}

function authorized(req: IncomingMessage): boolean {
  return (req.socket as TLSSocket).authorized === true;
}

function answer(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** The body as JSON; `too_large` past the limit, null when it is not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown | 'too_large'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return 'too_large';
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export function createServer(options: HostAgentServerOptions): Server {
  const log = options.log ?? createRequestLog();
  const now = options.now ?? (() => Date.now());

  const server = createHttpsServer(
    {
      cert: options.tls.certPem,
      key: options.tls.keyPem,
      ca: options.tls.caPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      const started = now();
      const route = routeOf(req);
      const done = (status: number, body: Record<string, unknown>) => {
        answer(res, status, body);
        log({ route, status, durationMs: now() - started });
      };
      if (!authorized(req)) {
        done(403, { error: 'forbidden' });
        return;
      }
      if (route !== '/v1/exec') {
        done(404, { error: 'not_found' });
        return;
      }
      if (req.method !== 'POST') {
        done(405, { error: 'method_not_allowed' });
        return;
      }
      void (async () => {
        const body = await readJson(req);
        if (body === 'too_large') {
          done(413, { error: 'too_large' });
          return;
        }
        const result = await handleExec(body, options.runInContainer);
        done(result.status, result.body);
      })().catch(() => done(500, { error: 'internal' }));
    },
  );

  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const started = now();
    const route = routeOf(req);
    const refuse = (status: number, reason: string) => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      log({ route, status, durationMs: now() - started });
    };
    if (!authorized(req)) return refuse(403, 'Forbidden');
    if (!TERMINAL_PATHS.has(route) || req.method !== 'GET') return refuse(404, 'Not Found');
    void proxyTerminal(req, socket, head, options.terminalTarget).then((status) =>
      log({ route, status, durationMs: now() - started }),
    );
  });

  return server;
}
