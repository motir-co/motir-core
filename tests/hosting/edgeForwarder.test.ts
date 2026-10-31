import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  createServer,
  request,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveOriginSecret as orchestratorDerive } from '@motir/orchestrator';
import {
  EDGE_ENV,
  EdgeConfigError,
  readEdgeConfig,
  type EdgeConfig,
} from '../../packages/hosting-edge/src/config';
import { parseOutcome, type FetchLike } from '../../packages/hosting-edge/src/contract';
import { deriveOriginSecret } from '../../packages/hosting-edge/src/credential';
import type { Transport } from '../../packages/hosting-edge/src/forward';
import { createEdgeServer } from '../../packages/hosting-edge/src/server';

// THE EDGE FORWARDER (MOTIR-10127) against a real loopback upstream that records
// the headers it RECEIVED, so the assertions read what the application saw rather
// than what the edge meant to send. The contract is an injected, COUNTED `fetch`
// — never a patched global — so each test reads the calls a request actually
// made and the bearer they carried.
//
// The upstream here is plain HTTP on loopback, reached through an injected
// transport that stands in for TLS; `packages/hosting-edge/smoke.sh` proves the
// same forward over real TLS against the built image.

const CONFIG: EdgeConfig = {
  baseUrl: 'https://app.motir.test',
  contractToken: 'edge-bearer',
  originSecretKey: 'the-hosting-key',
};

let upstream: Server;
let edge: Server;
let edgePort: number;
let upstreamPort: number;
let received: { headers: IncomingHttpHeaders; method?: string; url?: string; body: string }[];
let upgraded: IncomingHttpHeaders[];
let sockets: Socket[];
let calls: { url: string; init: RequestInit }[];
let answer: (host: string) => { status: number; body: unknown };

const portOf = (server: Server) => (server.address() as AddressInfo).port;

/** Forwards to the loopback upstream whatever origin the contract named. */
const loopback: Transport = {
  request: (options, onResponse) =>
    httpRequest(
      { ...options, protocol: 'http:', hostname: '127.0.0.1', port: upstreamPort },
      onResponse,
    ),
  connect: (_origin, onReady) => connect(upstreamPort, '127.0.0.1', onReady),
};

const countedFetch: FetchLike = async (url, init) => {
  calls.push({ url, init });
  const host = decodeURIComponent(url.split('/api/public/hosts/')[1]!);
  const { status, body } = answer(host);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
};

const application = (credential: string, origin = 'https://mh-abc.fly.dev') => ({
  kind: 'application',
  workspace: { name: 'Acme' },
  application: { id: 'app_1', slug: 'shop' },
  upstream: { origin, appRef: 'mh-abc', credential },
});

beforeEach(async () => {
  received = [];
  upgraded = [];
  sockets = [];
  calls = [];
  answer = () => ({ status: 200, body: application('origin_secret') });
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(201, {
        'content-type': 'text/plain',
        'x-app': 'yes',
        'cache-control': 'max-age=60',
      });
      res.end('from the app');
    });
  });
  upstream.on('upgrade', (req, socket) => {
    upgraded.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (data: Buffer) => socket.write(`echo:${data.toString()}`));
  });
  upstream.on('connection', (s: Socket) => sockets.push(s));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  upstreamPort = portOf(upstream);

  edge = createEdgeServer(CONFIG, { fetch: countedFetch, transport: loopback });
  edge.on('connection', (s: Socket) => sockets.push(s));
  edge.listen(0, '127.0.0.1');
  await once(edge, 'listening');
  edgePort = portOf(edge);
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  edge.closeAllConnections();
  upstream.closeAllConnections();
  await new Promise((r) => edge.close(r));
  await new Promise((r) => upstream.close(r));
});

function send(
  opts: {
    host?: string;
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: edgePort,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { host: opts.host ?? 'shop.acme.com', ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

describe('readEdgeConfig', () => {
  it.each([EDGE_ENV.baseUrl, EDGE_ENV.contractToken, EDGE_ENV.originSecretKey])(
    'refuses when %s is unset or blank, naming it',
    (variable) => {
      const env: Record<string, string> = {
        [EDGE_ENV.baseUrl]: 'https://app.motir.co',
        [EDGE_ENV.contractToken]: 't',
        [EDGE_ENV.originSecretKey]: 'k',
      };
      for (const value of [undefined, '   ']) {
        const e = { ...env, [variable]: value };
        expect(() => readEdgeConfig(e)).toThrow(EdgeConfigError);
        try {
          readEdgeConfig(e);
        } catch (err) {
          expect((err as EdgeConfigError).variable).toBe(variable);
        }
      }
    },
  );

  it('the process exits non-zero naming the first missing variable', async () => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        join(__dirname, '../../packages/hosting-edge/src/main.ts'),
      ],
      // Nothing inherited but PATH, so no variable leaks in from the runner.
      { env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production' } },
    );
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const [code] = await once(child, 'close');
    expect(code).not.toBe(0);
    expect(stderr).toContain(EDGE_ENV.baseUrl);
  });
});

describe('the forward', () => {
  it('carries method, path, query, body and cookies intact, with the forwarded host', async () => {
    const res = await send({
      method: 'POST',
      path: '/cart/add?item=7&qty=2',
      headers: { cookie: 'session=abc; theme=dark', 'content-type': 'application/json' },
      body: '{"sku":"x"}',
    });
    expect(res.status).toBe(201);
    expect(res.body).toBe('from the app');
    expect(res.headers['x-app']).toBe('yes');
    // The application's cacheability, untouched.
    expect(res.headers['cache-control']).toBe('max-age=60');

    const seen = received[0]!;
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/cart/add?item=7&qty=2');
    expect(seen.body).toBe('{"sku":"x"}');
    expect(seen.headers.cookie).toBe('session=abc; theme=dark');
    expect(seen.headers.host).toBe('mh-abc.fly.dev');
    expect(seen.headers['x-forwarded-host']).toBe('shop.acme.com');
    expect(seen.headers['x-forwarded-proto']).toBe('https');
  });

  it('presents the derived origin secret, equal to the orchestrator’s', async () => {
    expect(deriveOriginSecret('k1', 'mh-abc')).toBe(orchestratorDerive('k1', 'mh-abc'));
    expect(deriveOriginSecret('another', 'mh-xyz')).toBe(orchestratorDerive('another', 'mh-xyz'));
    await send();
    expect(received[0]!.headers['x-motir-origin-secret']).toBe(
      orchestratorDerive(CONFIG.originSecretKey, 'mh-abc'),
    );
  });

  it('`none` sends no credential header at all', async () => {
    answer = () => ({ status: 200, body: application('none') });
    await send();
    expect(received[0]!.headers['x-motir-origin-secret']).toBeUndefined();
  });

  it('never passes a visitor’s own x-motir-* or forwarded headers upstream', async () => {
    answer = () => ({ status: 200, body: application('none') });
    await send({
      headers: {
        'x-motir-origin-secret': 'forged',
        'x-motir-public-workspace': 'other',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      },
    });
    const headers = received[0]!.headers;
    expect(Object.keys(headers).filter((h) => h.startsWith('x-motir-'))).toEqual([]);
    expect(headers['x-forwarded-host']).toBe('shop.acme.com');
    expect(headers['x-forwarded-proto']).toBe('https');
  });

  it('upgrades through to the same upstream with the same credential, piped both ways', async () => {
    const socket = connect(edgePort, '127.0.0.1');
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: shop.acme.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    const [first] = (await once(socket, 'data')) as [Buffer];
    expect(first.toString()).toContain('101 Switching Protocols');
    socket.write('ping');
    const [echoed] = (await once(socket, 'data')) as [Buffer];
    expect(echoed.toString()).toBe('echo:ping');
    expect(upgraded[0]!['x-motir-origin-secret']).toBe(
      orchestratorDerive(CONFIG.originSecretKey, 'mh-abc'),
    );
    expect(upgraded[0]!['x-forwarded-host']).toBe('shop.acme.com');
  });

  it('refuses an upgrade on a host that resolves to a page', async () => {
    answer = () => ({ status: 404, body: { code: 'NOT_FOUND' } });
    const socket = connect(edgePort, '127.0.0.1');
    sockets.push(socket);
    await once(socket, 'connect');
    socket.write(
      'GET /ws HTTP/1.1\r\nHost: gone.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    const [first] = (await once(socket, 'data')) as [Buffer];
    expect(first.toString()).toMatch(/^HTTP\/1\.1 404 /);
    expect(upgraded).toEqual([]);
  });
});

describe('the contract call', () => {
  it('is ONE call per request with the bearer, and nothing is cached', async () => {
    for (let i = 0; i < 3; i++) await send();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url).toBe('https://app.motir.test/api/public/hosts/shop.acme.com');
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer edge-bearer');
    }
    // Removed between two requests: the next one is the contract's 404.
    answer = () => ({ status: 404, body: { code: 'NOT_FOUND' } });
    const after = await send();
    expect(after.status).toBe(404);
    expect(calls).toHaveLength(4);
  });

  it('reads the host from Host without its port, lower-cased', async () => {
    await send({ host: 'Shop.Acme.COM:443' });
    expect(calls[0]!.url).toBe('https://app.motir.test/api/public/hosts/shop.acme.com');
  });
});

describe('refusals — never a forward', () => {
  it.each([
    ['no upstream', { ...application('origin_secret'), upstream: undefined }],
    ['a plain-http origin', application('origin_secret', 'http://mh-abc.fly.dev')],
    ['a bare host', application('origin_secret', 'mh-abc.fly.dev')],
    ['an empty origin', application('origin_secret', '')],
    ['an origin with userinfo', application('origin_secret', 'https://u:p@mh-abc.fly.dev')],
    ['an unknown credential', application('mutual_tls')],
    ['an unknown kind', { kind: 'project', workspace: { name: 'Acme' } }],
  ])('%s answers the Not-found page and makes no upstream request', async (_label, body) => {
    answer = () => ({ status: 200, body });
    const res = await send();
    expect(res.status).toBe(404);
    expect(res.body).toContain('There’s no site here');
    expect(received).toEqual([]);
  });

  it.each([
    ['the contract’s 404', () => ({ status: 404, body: { code: 'NOT_FOUND' } })],
    ['a 500', () => ({ status: 500, body: {} })],
    ['an unparseable body', () => ({ status: 200, body: 'not json{' })],
  ])('%s is the Not-found page', async (_label, a) => {
    answer = a;
    const res = await send();
    expect(res.status).toBe(404);
    expect(received).toEqual([]);
  });

  it('a contract that throws or times out is the Not-found page', async () => {
    edge.close();
    const failing = createEdgeServer(CONFIG, {
      fetch: async (_url, init) => {
        await new Promise((_r, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('timeout'))),
        );
        throw new Error('unreachable');
      },
      transport: loopback,
      contractTimeoutMs: 20,
    });
    failing.listen(0, '127.0.0.1');
    await once(failing, 'listening');
    edge = failing;
    edgePort = portOf(failing);
    const res = await send();
    expect(res.status).toBe(404);
    expect(received).toEqual([]);
  });

  it('`aws_sigv4` answers the Unavailable page at 503, with no request to the origin', async () => {
    answer = () => ({ status: 200, body: application('aws_sigv4') });
    const res = await send();
    expect(res.status).toBe(503);
    expect(res.body).toContain('This site can’t be reached right now');
    expect(received).toEqual([]);
  });

  it('`aws_sigv4` over a malformed origin is still the 404, not the 503', () => {
    expect(parseOutcome(application('aws_sigv4', 'http://x.fly.dev'))).toEqual({
      kind: 'not-found',
    });
  });
});
