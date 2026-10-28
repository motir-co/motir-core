import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GUARD_ENV,
  GuardConfigError,
  createGuardServer,
  readGuardConfig,
} from '../../packages/hosting-guard/src/guard';

// THE HOSTING GUARD (MOTIR-9947) against a real local upstream: an echo app on
// 127.0.0.1 that records the headers it RECEIVED, so the test reads what the app
// saw rather than what the guard meant to send. No network beyond loopback, no
// image: the image runs exactly this source (`packages/hosting-guard/Dockerfile`).

const SECRET = 'the-apps-derived-origin-secret';

let app: Server;
let guard: Server;
let guardPort: number;
let received: IncomingHttpHeaders[];
let upgraded: IncomingHttpHeaders[];
/** Every socket either server accepted: an UPGRADED one leaves the server's own
 *  bookkeeping, so `closeAllConnections` cannot end it and `close` would wait. */
let sockets: Socket[];

const portOf = (server: Server) => (server.address() as AddressInfo).port;

beforeEach(async () => {
  received = [];
  upgraded = [];
  sockets = [];
  app = createServer((req, res) => {
    received.push(req.headers);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/drop') {
        // Answers, then dies mid-body.
        res.writeHead(200, { 'content-length': '100' });
        res.write('partial');
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.writeHead(201, { 'content-type': 'text/plain', 'x-app': 'yes' });
      res.end(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
    });
  });
  app.on('upgrade', (req, socket) => {
    upgraded.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (data: Buffer) => socket.write(`echo:${data.toString()}`));
  });
  app.on('connection', (s: Socket) => sockets.push(s));
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  guard = createGuardServer({ secret: SECRET, appPort: portOf(app) });
  guard.on('connection', (s: Socket) => sockets.push(s));
  guard.listen(0, '127.0.0.1');
  await once(guard, 'listening');
  guardPort = portOf(guard);
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await Promise.all([new Promise((r) => guard.close(r)), new Promise((r) => app.close(r))]);
});

function call(
  headers: Record<string, string>,
  body = '',
  method = 'POST',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: guardPort, method, path: '/things?x=1', headers },
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
    req.end(body);
  });
}

/** A raw websocket upgrade through the guard; resolves with everything the
 *  client read once the exchange settles. */
function upgrade(headers: Record<string, string>, send?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(guardPort, '127.0.0.1', () => {
      const lines = [
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${guardPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let read = '';
    socket.on('data', (data: Buffer) => {
      read += data.toString();
      if (send && read.includes('101 Switching Protocols') && !read.includes('echo:')) {
        socket.write(send);
      }
      if (!send || read.includes('echo:')) {
        socket.end();
        resolve(read);
      }
    });
    socket.on('end', () => resolve(read));
    socket.on('error', reject);
  });
}

describe('the hosting guard — HTTP', () => {
  it('answers 403 with an empty body when the header is missing, and the app sees nothing', async () => {
    const res = await call({}, 'payload');
    expect(res.status).toBe(403);
    expect(res.body).toBe('');
    expect(received).toEqual([]);
  });

  it('answers 403 to a wrong secret, a prefix of it, and one longer than it', async () => {
    for (const wrong of ['nope', SECRET.slice(0, -1), `${SECRET}x`, '']) {
      const res = await call({ 'X-Motir-Origin-Secret': wrong });
      expect(res.status).toBe(403);
      expect(res.body).toBe('');
    }
    expect(received).toEqual([]);
  });

  it('proxies the right secret to the app with the header REMOVED, body and status both ways', async () => {
    const res = await call(
      {
        'X-Motir-Origin-Secret': SECRET,
        'X-Forwarded-For': '203.0.113.7',
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'text/plain',
      },
      'hello app',
    );
    expect(res).toMatchObject({ status: 201, body: 'POST /things?x=1 hello app' });
    expect(res.headers['x-app']).toBe('yes');
    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty('x-motir-origin-secret');
    expect(received[0]).toMatchObject({
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-proto': 'https',
      host: `127.0.0.1:${guardPort}`,
    });
  });

  it('cuts the client off when the app dies mid-answer, rather than end it cleanly', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: guardPort,
          path: '/drop',
          headers: { 'X-Motir-Origin-Secret': SECRET },
        },
        (res) => {
          res.on('data', () => undefined);
          res.on('end', () => resolve('ended'));
          res.on('error', () => resolve('cut off'));
          res.on('aborted', () => resolve('cut off'));
        },
      );
      req.on('error', () => resolve('cut off'));
      req.end();
    });
    expect(outcome).toBe('cut off');
  });

  it('answers 502 when the app is not listening', async () => {
    const down = createGuardServer({ secret: SECRET, appPort: 1 });
    down.listen(0, '127.0.0.1');
    await once(down, 'listening');
    const saved = guardPort;
    guardPort = portOf(down);
    try {
      expect((await call({ 'X-Motir-Origin-Secret': SECRET }, '', 'GET')).status).toBe(502);
    } finally {
      guardPort = saved;
      down.close();
    }
  });
});

describe('the hosting guard — websocket upgrade', () => {
  it('refuses an upgrade without the secret with 403, and the app never sees it', async () => {
    const read = await upgrade({});
    expect(read).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(upgraded).toEqual([]);
  });

  it('pipes an upgrade carrying the secret to the app, header removed, both directions', async () => {
    const read = await upgrade({ 'X-Motir-Origin-Secret': SECRET }, 'ping');
    expect(read).toContain('HTTP/1.1 101 Switching Protocols');
    expect(read).toContain('echo:ping');
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).not.toHaveProperty('x-motir-origin-secret');
    expect(upgraded[0]).toMatchObject({ upgrade: 'websocket' });
  });

  it('answers 502 to an upgrade when the app is not listening', async () => {
    const down = createGuardServer({ secret: SECRET, appPort: 1 });
    down.listen(0, '127.0.0.1');
    await once(down, 'listening');
    const saved = guardPort;
    guardPort = portOf(down);
    try {
      expect(await upgrade({ 'X-Motir-Origin-Secret': SECRET })).toMatch(/^HTTP\/1\.1 502/);
    } finally {
      guardPort = saved;
      down.close();
    }
  });
});

describe('the hosting guard — configuration', () => {
  it('reads the secret and the app port', () => {
    expect(readGuardConfig({ [GUARD_ENV.secret]: 's', [GUARD_ENV.appPort]: '8080' })).toEqual({
      secret: 's',
      appPort: 8080,
    });
  });

  it.each([
    [{}, GUARD_ENV.secret],
    [{ [GUARD_ENV.secret]: ' ' }, GUARD_ENV.secret],
    [{ [GUARD_ENV.secret]: 's' }, GUARD_ENV.appPort],
    [{ [GUARD_ENV.secret]: 's', [GUARD_ENV.appPort]: 'http' }, GUARD_ENV.appPort],
    [{ [GUARD_ENV.secret]: 's', [GUARD_ENV.appPort]: '9180' }, GUARD_ENV.appPort],
    [{ [GUARD_ENV.secret]: 's', [GUARD_ENV.appPort]: '70000' }, GUARD_ENV.appPort],
  ])('refuses %j, naming %s', (env, variable) => {
    expect(() => readGuardConfig(env)).toThrow(GuardConfigError);
    expect(() => readGuardConfig(env)).toThrow(new RegExp(variable));
  });

  const MAIN = join(process.cwd(), 'packages', 'hosting-guard', 'src', 'main.ts');

  /** A child's whole environment: nothing inherited but PATH. */
  const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    PATH: process.env['PATH'] ?? '',
    NODE_ENV: 'production',
    ...extra,
  });

  function runMain(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
        env: childEnv(env),
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ code, stderr }));
    });
  }

  it('the process starts on 9180 with both variables set, never prints the secret, and exits 0 on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN], {
      env: childEnv({ [GUARD_ENV.secret]: SECRET, [GUARD_ENV.appPort]: '8080' }),
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    while (!output.includes('listening')) {
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(output).toContain('listening on 9180, forwarding to 127.0.0.1:8080');
    child.kill('SIGTERM');
    const [code] = (await once(child, 'close')) as [number | null];
    expect(code).toBe(0);
    expect(output).not.toContain(SECRET);
  });

  it.each([
    [{}, GUARD_ENV.secret],
    [{ [GUARD_ENV.secret]: SECRET }, GUARD_ENV.appPort],
  ])('the process exits non-zero naming the unset variable (%j)', async (env, variable) => {
    const { code, stderr } = await runMain(env);
    expect(code).toBe(1);
    expect(stderr).toContain(variable);
    expect(stderr).not.toContain(SECRET);
  });
});
