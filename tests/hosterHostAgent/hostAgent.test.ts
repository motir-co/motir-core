import { readFileSync, readdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  OrchestratorApiError,
  createHostAgentClient,
  mintHostCertificateAuthority,
  mintHostClientCertificate,
  mintHostServerCertificate,
  type HostCertificatePem,
} from '@motir/orchestrator';
import {
  handleExec,
  parseExecRequest,
  spawnRunner,
  type RunInContainer,
} from '../../infra/hoster-host-agent/src/exec';
import { createRequestLog } from '../../infra/hoster-host-agent/src/log';
import { terminalPortFrom } from '../../infra/hoster-host-agent/src/main';
import { createServer } from '../../infra/hoster-host-agent/src/server';

// THE HOSTER HOST AGENT (Story MOTIR-9361 · MOTIR-9480) — the real service over
// real TLS on a loopback port, dialled by Motir's own host-agent client (the
// other side of the same contract). The container runtime is a stub, or a tiny
// `node -e` standing in for `docker`; the terminal server is a local WebSocket
// stub. The CAs and certificates are minted here.

const NOW = new Date();
const MARKER = 'SECRET-MARKER-9480';
const AGENT_DIR = join(__dirname, '../../infra/hoster-host-agent');
const CONTRACT = readFileSync(
  join(__dirname, '../../docs/decisions/aws-hoster-host-agent.md'),
  'utf8',
);

let ca: HostCertificatePem;
let client: HostCertificatePem;
let strangerCa: HostCertificatePem;
let strangerClient: HostCertificatePem;
let serverPair: HostCertificatePem;

beforeAll(async () => {
  ca = await mintHostCertificateAuthority({ name: 'Motir hoster CA (test)', now: NOW, days: 30 });
  client = await mintHostClientCertificate({ ca, name: 'motir-app (test)', now: NOW });
  strangerCa = await mintHostCertificateAuthority({ name: 'Someone else', now: NOW, days: 30 });
  strangerClient = await mintHostClientCertificate({ ca: strangerCa, name: 'stranger', now: NOW });
  serverPair = await mintHostServerCertificate({ ca, instanceId: 'inst-agent', now: NOW });
});

let server: Server;
let port: number;
let logLines: string[];
let onRequest: ReturnType<typeof vi.fn>;
let onUpgrade: ReturnType<typeof vi.fn>;
let run: ReturnType<typeof vi.fn<RunInContainer>>;
let terminal: { server: HttpServer; wss: WebSocketServer; port: number; headers: string[] };

async function startTerminalStub(): Promise<typeof terminal> {
  const http = createHttpServer();
  const wss = new WebSocketServer({ server: http });
  const headers: string[] = [];
  wss.on('connection', (ws, req) => {
    headers.push(String(req.headers['motir-relay'] ?? ''), req.url ?? '');
    ws.on('message', (raw) => ws.send(Buffer.concat([Buffer.from('echo:'), raw as Buffer])));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { server: http, wss, port: (http.address() as AddressInfo).port, headers };
}

beforeEach(async () => {
  logLines = [];
  run = vi.fn<RunInContainer>(async ({ argv, stdin }) => ({
    kind: 'exited',
    exitCode: argv[0] === 'false' ? 1 : 0,
    stdout: `ran ${argv.join(' ')} stdin=${stdin ?? ''}`,
    stderr: argv[0] === 'false' ? 'it failed' : '',
  }));
  terminal = await startTerminalStub();
  server = createServer({
    tls: { certPem: serverPair.certPem, keyPem: serverPair.keyPem, caPem: ca.certPem },
    runInContainer: run,
    terminalTarget: async () => ({ host: '127.0.0.1', port: terminal.port }),
    log: createRequestLog((line) => logLines.push(line)),
  });
  onRequest = vi.fn();
  onUpgrade = vi.fn();
  server.prependListener('request', onRequest);
  server.prependListener('upgrade', onUpgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const ws of terminal.wss.clients) ws.terminate();
  terminal.wss.close();
  terminal.server.closeAllConnections();
  await new Promise<void>((resolve) => terminal.server.close(() => resolve()));
});

const motir = () =>
  createHostAgentClient({
    caPem: ca.certPem,
    certPem: client.certPem,
    keyPem: client.keyPem,
    port,
  });

/** A raw request with whatever client certificate (or none) the test gives. */
function rawRequest(cert: { certPem: string; keyPem: string } | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/exec',
        ca: ca.certPem,
        ...(cert ? { cert: cert.certPem, key: cert.keyPem } : {}),
        checkServerIdentity: () => undefined,
        agent: false,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ command: ['true'] }));
  });
}

describe('the TLS gate', () => {
  it('answers a client with a CA-signed certificate', async () => {
    expect(await motir().exec('127.0.0.1', { command: ['echo', 'hi'], timeoutSeconds: 5 })).toEqual(
      { exitCode: 0, stdout: 'ran echo hi stdin=', stderr: '' },
    );
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses at the handshake a client with no certificate, or one from another CA — no handler runs', async () => {
    await expect(rawRequest(null)).rejects.toThrow();
    await expect(rawRequest(strangerClient)).rejects.toThrow();
    expect(onRequest).not.toHaveBeenCalled();
    expect(onUpgrade).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(logLines).toEqual([]);
  });
});

describe('POST /v1/exec', () => {
  it('a non-zero exit is a normal answer, and the stdin reaches the command', async () => {
    expect(
      await motir().exec('127.0.0.1', { command: ['false'], stdin: 'input', timeoutSeconds: 5 }),
    ).toEqual({ exitCode: 1, stdout: 'ran false stdin=input', stderr: 'it failed' });
    expect(run).toHaveBeenCalledWith({ argv: ['false'], stdin: 'input', timeoutMs: 5000 });
  });

  it('a command past its timeout is 408, which the client reads as exec_timeout', async () => {
    run.mockResolvedValueOnce({ kind: 'timed_out' });
    const err = await motir()
      .exec('127.0.0.1', { command: ['sleep', '99'], timeoutSeconds: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorApiError);
    expect((err as OrchestratorApiError).status).toBe(408);
  });

  it('refuses a body that is not the contract’s shape, and any other route or method', async () => {
    for (const body of [
      null,
      [],
      {},
      { command: [] },
      { command: ['x', 1] },
      { command: ['x'], stdin: 3 },
    ]) {
      expect((await handleExec(body, run)).status).toBe(400);
    }
    expect(parseExecRequest({ command: ['x'], timeoutSeconds: 0 })).toBeNull();
    expect(parseExecRequest({ command: ['x'] })).toEqual({ command: ['x'], timeoutSeconds: 120 });
    run.mockRejectedValueOnce(new Error(`docker missing ${MARKER}`));
    expect(await handleExec({ command: ['x'] }, run)).toEqual({
      status: 503,
      body: { error: 'container_unavailable' },
    });
  });

  it('matches the contract document’s examples field for field', async () => {
    const examples = [...CONTRACT.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
      (m) => JSON.parse(m[1]!) as Record<string, unknown>,
    );
    const [request, response] = examples;
    expect(parseExecRequest(request)).not.toBeNull();
    const answered = (await handleExec(request, run)).body;
    const shape = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v]));
    expect(shape(answered)).toEqual(shape(response!));
  });
});

describe('the real runner, without a shell', () => {
  const standIn = (script: string) => spawnRunner(process.execPath, () => ['-e', script]);

  it('passes shell metacharacters through unchanged, writes the stdin, and keeps the exit code', async () => {
    const runner = standIn(
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:d}));process.stderr.write("e");process.exit(3)})',
    );
    const argv = ['$(touch /tmp/pwned)', '; rm -rf /', '`id`', 'a b'];
    const result = await runner({ argv, stdin: MARKER, timeoutMs: 10_000 });
    expect(result).toEqual({
      kind: 'exited',
      exitCode: 3,
      stdout: JSON.stringify({ argv, stdin: MARKER }),
      stderr: 'e',
    });
  });

  it('kills a command at its deadline', async () => {
    const result = await standIn('setTimeout(() => {}, 60_000)')({ argv: [], timeoutMs: 200 });
    expect(result).toEqual({ kind: 'timed_out' });
  });

  it('a program that cannot be started rejects', async () => {
    await expect(
      spawnRunner('/no/such/docker')({ argv: ['x'], timeoutMs: 1000 }),
    ).rejects.toThrow();
  });
});

describe('GET /v1/terminal', () => {
  function dial(path = '/v1/terminal') {
    return new WebSocket(`wss://localhost:${port}${path}`, {
      ca: ca.certPem,
      cert: client.certPem,
      key: client.keyPem,
      checkServerIdentity: () => undefined,
      headers: { 'Motir-Relay': 'relay-token' },
    });
  }

  it('proxies bytes both ways, with the relay’s path and authorization', async () => {
    for (const path of ['/v1/terminal', '/v1/chat']) {
      const ws = dial(path);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const reply = new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))));
      ws.send('ls');
      expect(await reply).toBe('echo:ls');
      ws.close();
    }
    expect(terminal.headers).toEqual(['relay-token', '/v1/terminal', 'relay-token', '/v1/chat']);
  });

  it('closes the client when the terminal server closes, and the reverse', async () => {
    const ws = dial();
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    for (const inner of terminal.wss.clients) inner.terminate();
    await closed;

    const second = dial();
    await new Promise<void>((resolve) => second.once('open', () => resolve()));
    const innerClosed = new Promise<void>((resolve) =>
      [...terminal.wss.clients].at(-1)!.once('close', () => resolve()),
    );
    second.terminate();
    await innerClosed;
  });

  it('a terminal server that cannot be reached is a 502, and another path a 404', async () => {
    terminal.server.closeAllConnections();
    await new Promise<void>((resolve) => terminal.server.close(() => resolve()));
    terminal.server = createHttpServer();
    terminal.server.listen(0);
    const statusOf = (path: string) =>
      new Promise<number>((resolve) => {
        const ws = dial(path);
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('error', () => undefined);
      });
    expect(await statusOf('/v1/terminal')).toBe(502);
    expect(await statusOf('/v1/other')).toBe(404);
  });
});

describe('what the service writes and imports', () => {
  it('logs only the route, the status and the duration — no stdin, no command, no key', async () => {
    await motir().exec('127.0.0.1', {
      command: ['echo', MARKER],
      stdin: MARKER,
      timeoutSeconds: 5,
    });
    expect(logLines).toHaveLength(1);
    expect(Object.keys(JSON.parse(logLines[0]!) as object).sort()).toEqual([
      'durationMs',
      'route',
      'status',
    ]);
    expect(logLines.join('\n')).not.toContain(MARKER);
    expect(logLines.join('\n')).not.toContain('PRIVATE KEY');
  });

  it('reads the terminal port from the config document', async () => {
    const file = join(__dirname, '../fixtures/hosterHostAgent-instance.json');
    expect(await terminalPortFrom(file)).toBe(7681);
  });

  it('never disables certificate checks and imports nothing from the app or the orchestrator', () => {
    const src = join(AGENT_DIR, 'src');
    for (const name of readdirSync(src)) {
      const text = readFileSync(join(src, name), 'utf8');
      expect(text).not.toMatch(/rejectUnauthorized:\s*false/);
      expect(text).not.toMatch(/from '@\/|from '@motir\//);
      expect(text).not.toMatch(/from '(?!node:|\.\/)/);
    }
  });
});
