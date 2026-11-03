// THE EDGE FORWARDER (MOTIR-10127), the process `motir-edge` runs: every
// request to a customer domain makes ONE call to the host contract and is
// dispatched on the answer — forwarded to the application it names, or answered
// with one of the edge's four pages. Total over the five outcomes `contract.ts`
// reads, with no fall-through to a forward.
//
// Dependency-free (`node:http`, `node:https`, `node:tls`, `node:crypto`), so the
// image runs this source directly, as the guard's does.

import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import type { EdgeConfig } from './config.ts';
import { createContractClient, type EdgeOutcome, type FetchLike } from './contract.ts';
import { credentialHeaders } from './credential.ts';
import { TLS_TRANSPORT, forwardHttp, forwardUpgrade, type Transport } from './forward.ts';
import { pageFor, pageHeaders } from './pages.ts';

export interface EdgeDeps {
  /** The contract call's `fetch`; injected so a test counts and inspects it. */
  readonly fetch: FetchLike;
  /** How an origin is reached; production is TLS. */
  readonly transport?: Transport;
  readonly contractTimeoutMs?: number;
}

/** The visitor's host from `Host`: lower case, without a port, or null. */
export function visitorHostOf(req: IncomingMessage): string | null {
  const raw = req.headers.host?.trim().toLowerCase();
  if (!raw) return null;
  // `[v6]:port` is never a customer domain; a bare name keeps everything before
  // the port separator.
  if (raw.startsWith('[')) return null;
  const host = raw.replace(/:\d+$/, '').replace(/\.$/, '');
  return host === '' ? null : host;
}

function answerPage(res: ServerResponse, outcome: Exclude<EdgeOutcome, { kind: 'forward' }>) {
  const page = pageFor(outcome);
  res.writeHead(page.status, pageHeaders(page.body));
  res.end(page.body);
}

function refuseUpgrade(socket: Duplex, outcome: Exclude<EdgeOutcome, { kind: 'forward' }>) {
  const page = pageFor(outcome);
  const headers = { ...pageHeaders(page.body), connection: 'close' };
  let head = `HTTP/1.1 ${page.status} ${STATUS_CODES[page.status]}\r\n`;
  for (const [name, value] of Object.entries(headers)) head += `${name}: ${value}\r\n`;
  socket.end(`${head}\r\n${page.body}`);
}

/** The edge's server, not yet listening. */
export function createEdgeServer(config: EdgeConfig, deps: EdgeDeps): Server {
  const resolve = createContractClient({
    baseUrl: config.baseUrl,
    token: config.contractToken,
    fetch: deps.fetch,
    timeoutMs: deps.contractTimeoutMs,
  });
  const transport = deps.transport ?? TLS_TRANSPORT;

  const outcomeOf = async (req: IncomingMessage): Promise<[EdgeOutcome, string | null]> => {
    const host = visitorHostOf(req);
    if (!host) return [{ kind: 'not-found' }, null];
    return [await resolve(host), host];
  };

  const targetOf = (outcome: Extract<EdgeOutcome, { kind: 'forward' }>, host: string) => ({
    origin: outcome.origin,
    visitorHost: host,
    credential: credentialHeaders(outcome.credential, config.originSecretKey, outcome.appRef),
  });

  const server = createServer((req, res) => {
    // The body waits in the socket until the forward pipes it on.
    req.pause();
    void outcomeOf(req).then(([outcome, host]) => {
      if (outcome.kind === 'forward' && host) {
        forwardHttp(transport, targetOf(outcome, host), req, res);
        req.resume();
        return;
      }
      req.resume();
      answerPage(res, outcome.kind === 'forward' ? { kind: 'not-found' } : outcome);
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    void outcomeOf(req).then(([outcome, host]) => {
      if (outcome.kind === 'forward' && host) {
        forwardUpgrade(transport, targetOf(outcome, host), req, socket, head);
        return;
      }
      refuseUpgrade(socket, outcome.kind === 'forward' ? { kind: 'not-found' } : outcome);
    });
  });
  return server;
}
