// The forward (MOTIR-10127): the visitor's request, intact, to the remote
// `https` origin the contract named — ordinary requests and websocket upgrades
// alike.
//
// What the upstream receives: the visitor's method, path, query, body, cookies
// and every other header as sent (original case and order), EXCEPT
//   - `Host`, which becomes the origin's own host — TLS and virtual hosting at
//     the origin need its name, and the app reads the customer host from
//   - `x-forwarded-host` (the visitor's host) and `x-forwarded-proto: https`,
//     both set here and never passed through from the visitor;
//   - every `x-motir-*` header the visitor sent: a visitor must not be able to
//     present an origin secret or a Motir-internal header of its own;
// plus the credential `credential.ts` derives for the app. The answer goes back
// with its status, headers and body unchanged, and no cache header of the
// edge's own: the visitor's cacheability is the application's.
//
// Shaped on `packages/hosting-guard/src/guard.ts`, which proxies to the app on
// 127.0.0.1; this one connects to a remote origin per request.

import type { ClientRequest, IncomingMessage, RequestOptions, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

/** How the edge reaches an origin. Injected so a test can stand a loopback
 *  upstream in for a remote TLS one; production is always `https` / `tls`. */
export interface Transport {
  request(options: RequestOptions, onResponse: (res: IncomingMessage) => void): ClientRequest;
  connect(origin: URL, onReady: () => void): Duplex;
}

export const TLS_TRANSPORT: Transport = {
  request: (options, onResponse) => httpsRequest(options, onResponse),
  connect: (origin, onReady) =>
    tlsConnect(
      { host: origin.hostname, port: portOf(origin), servername: origin.hostname },
      onReady,
    ),
};

export interface ForwardTarget {
  readonly origin: URL;
  /** The visitor's host, as the contract resolved it. */
  readonly visitorHost: string;
  /** Header pairs carrying the app's credential (possibly none). */
  readonly credential: readonly string[];
}

function portOf(origin: URL): number {
  return origin.port ? Number(origin.port) : 443;
}

const DROPPED = new Set(['host', 'x-forwarded-host', 'x-forwarded-proto']);

/** The raw header pairs the upstream receives. */
export function forwardedRawHeaders(req: IncomingMessage, target: ForwardTarget): string[] {
  const out: string[] = ['Host', target.origin.host];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const lower = name.toLowerCase();
    if (DROPPED.has(lower) || lower.startsWith('x-motir-')) continue;
    out.push(name, req.rawHeaders[i + 1]!);
  }
  out.push('X-Forwarded-Host', target.visitorHost, 'X-Forwarded-Proto', 'https');
  out.push(...target.credential);
  return out;
}

export function forwardHttp(
  transport: Transport,
  target: ForwardTarget,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const upstream = transport.request(
    {
      protocol: 'https:',
      hostname: target.origin.hostname,
      port: portOf(target.origin),
      servername: target.origin.hostname,
      method: req.method,
      path: req.url,
      headers: forwardedRawHeaders(req, target),
    } as RequestOptions,
    (answer) => {
      res.writeHead(answer.statusCode!, answer.statusMessage, answer.rawHeaders);
      // The origin dropped mid-answer: drop the visitor's too, so a truncated
      // answer never looks complete.
      answer.on('error', () => res.destroy());
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-length': '0', 'cache-control': 'no-store' });
    res.end();
  });
  req.pipe(upstream);
}

export function forwardUpgrade(
  transport: Transport,
  target: ForwardTarget,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const origin = transport.connect(target.origin, () => {
    const headers = forwardedRawHeaders(req, target);
    let preamble = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < headers.length; i += 2) preamble += `${headers[i]}: ${headers[i + 1]}\r\n`;
    origin.write(Buffer.concat([Buffer.from(`${preamble}\r\n`), head]));
    origin.pipe(socket);
    socket.pipe(origin);
  });
  origin.on('error', () =>
    socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n'),
  );
  socket.on('error', () => origin.destroy());
  socket.on('close', () => origin.destroy());
}
