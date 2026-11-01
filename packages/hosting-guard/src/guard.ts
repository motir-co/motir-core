// THE HOSTING GUARD (MOTIR-9947), to the decision of record MOTIR-5769 §4 and
// D-5 (page cmvrcywwc00jkhpr1zvvnike8, v1): every release Motir hosts on Fly is
// reached only through an upstream that refuses a request without its origin
// credential. This is that upstream — a second container in the release's
// Machine, on the service's port, in front of the app.
//
// For every request, HTTP and websocket upgrade alike:
//   - `X-Motir-Origin-Secret` missing or wrong → 403 with an empty body;
//   - right → the header is REMOVED and the request is proxied to the app on
//     127.0.0.1:<app port>, bodies streamed both ways, upgraded sockets piped.
//
// The comparison is constant-time over SHA-256 digests of both values, so
// neither the secret's content nor its length leaks through timing. The secret's
// value is never logged. Dependency-free: `node:http`, `node:net`, `node:crypto`.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** The port the guard listens on in every Machine; a release may not use it. */
export const GUARD_PORT = 9180;

/** The header a forwarder sends, as Node presents it (lower case). */
export const ORIGIN_SECRET_HEADER = 'x-motir-origin-secret';

export const GUARD_ENV = {
  secret: 'MOTIR_GUARD_ORIGIN_SECRET',
  appPort: 'MOTIR_GUARD_APP_PORT',
} as const;

export interface GuardConfig {
  /** The app's origin secret, derived by the deploying adapter. */
  readonly secret: string;
  /** The app's own port inside the Machine. */
  readonly appPort: number;
}

/** The app shares the Machine's network namespace with the guard. */
const APP_HOST = '127.0.0.1';

/** A variable the guard cannot start without is unset or unusable. */
export class GuardConfigError extends Error {
  // A declared field, not a parameter property: the image runs this file with
  // Node's type stripping, which accepts only erasable syntax.
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super(`${variable} ${reason}; refusing to start.`);
    this.name = 'GuardConfigError';
    this.variable = variable;
  }
}

/** The guard's configuration from its environment, or the error naming the
 *  first variable that is missing or not a port. */
export function readGuardConfig(env: Record<string, string | undefined>): GuardConfig {
  const secret = env[GUARD_ENV.secret]?.trim();
  if (!secret) throw new GuardConfigError(GUARD_ENV.secret, 'is not set');
  const rawPort = env[GUARD_ENV.appPort]?.trim();
  if (!rawPort) throw new GuardConfigError(GUARD_ENV.appPort, 'is not set');
  const appPort = Number(rawPort);
  if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535 || appPort === GUARD_PORT) {
    throw new GuardConfigError(GUARD_ENV.appPort, `is not a usable app port (${rawPort})`);
  }
  return { secret, appPort };
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Whether the request carries the secret, compared in constant time. */
export function carriesSecret(req: IncomingMessage, secret: string): boolean {
  const given = req.headers[ORIGIN_SECRET_HEADER];
  if (typeof given !== 'string') return false;
  return timingSafeEqual(digest(given), digest(secret));
}

/** The request's raw header pairs without the secret, as `rawHeaders` keeps
 *  them (original case and order, duplicates intact). */
function forwardedRawHeaders(req: IncomingMessage): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (name.toLowerCase() === ORIGIN_SECRET_HEADER) continue;
    out.push(name, req.rawHeaders[i + 1]!);
  }
  return out;
}

function refuseHttp(res: ServerResponse): void {
  res.writeHead(403, { 'content-length': '0', connection: 'close' });
  res.end();
}

function refuseSocket(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
}

function proxyHttp(config: GuardConfig, req: IncomingMessage, res: ServerResponse): void {
  const upstream = httpRequest(
    {
      host: APP_HOST,
      port: config.appPort,
      method: req.method,
      path: req.url,
      headers: forwardedRawHeaders(req),
    },
    (answer) => {
      res.writeHead(answer.statusCode!, answer.statusMessage, answer.rawHeaders);
      // The app dropped the connection mid-answer: drop the client's too, so it
      // sees a truncated response rather than a complete-looking one.
      answer.on('error', () => res.destroy());
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    // The app is not listening (yet), or refused the connection.
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-length': '0' });
    res.end();
  });
  req.pipe(upstream);
}

function proxyUpgrade(config: GuardConfig, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const app: Socket = connect(config.appPort, APP_HOST, () => {
    const headers = forwardedRawHeaders(req);
    let preamble = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < headers.length; i += 2) preamble += `${headers[i]}: ${headers[i + 1]}\r\n`;
    // `head` is whatever the client sent past the upgrade request, often empty.
    app.write(Buffer.concat([Buffer.from(`${preamble}\r\n`), head]));
    app.pipe(socket);
    socket.pipe(app);
  });
  app.on('error', () => refuseSocket(socket, '502 Bad Gateway'));
  socket.on('error', () => app.destroy());
  socket.on('close', () => app.destroy());
}

/** The guard's server, not yet listening. */
export function createGuardServer(config: GuardConfig): Server {
  const server = createServer((req, res) => {
    if (!carriesSecret(req, config.secret)) return refuseHttp(res);
    proxyHttp(config, req, res);
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!carriesSecret(req, config.secret)) return refuseSocket(socket, '403 Forbidden');
    proxyUpgrade(config, req, socket, head);
  });
  return server;
}
