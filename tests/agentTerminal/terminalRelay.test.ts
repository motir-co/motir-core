import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from '@/lib/db';
import { deriveTerminalKey } from '@/lib/agentInstances/terminalKey';
import { createTerminalRelay, type TerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import {
  agentTerminalClock,
  agentTerminalRelayService as relayService,
} from '@/lib/services/agentTerminalRelayService';
import { agentTerminalService } from '@/lib/services/agentTerminalService';
import { adminDb } from '../helpers/adminDb';
import { clock, fleet, fx, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

// THE TERMINAL RELAY, END TO END ON ONE MACHINE (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3, Q6, Q8): a real browser-side WebSocket →
// the relay → a LOCAL fake terminal server the fake fleet resolves the agent to,
// over the real ticket service and a real Postgres. What the fake server stands
// in for is MOTIR-6938's `motir agent-terminal serve`: it verifies the relay
// token the way that server does, keeps sessions for a resume, echoes terminal
// bytes and pushes a sign-in frame.

const MASTER = 'm'.repeat(48);
const ORIGIN = 'https://motir.test';
const MARKER = 'MARKER-6940-never-logged-7f3a';
const RELAY_ID = 'relay-test-machine';
/**
 * The relay's auth window AND every `until`'s deadline (MOTIR-9877): sized for a
 * loaded CI shard, where minting a ticket (a Postgres write) has been measured at
 * 437–519 ms against ~25 ms unloaded (MOTIR-9875). Every ticket is minted BEFORE
 * its browser connects, so nothing a test does waits inside the window; the one
 * test that exercises the window itself runs a relay of its own on
 * `SHORT_AUTH_WINDOW_MS`.
 */
const LOADED_SHARD_MS = 5_000;
const SHORT_AUTH_WINDOW_MS = 300;

// ── The fake terminal server ────────────────────────────────────────────────

interface FakeTerminal {
  url: string;
  upgrades: { authorization: string | undefined; tokenSessionId: unknown }[];
  received: { isBinary: boolean; data: Buffer }[];
  pings: number;
  sessions: Set<string>;
  close(): Promise<void>;
}

function verifyToken(header: string | undefined): Record<string, unknown> | null {
  const token = header?.startsWith('Motir-Relay ') ? header.slice('Motir-Relay '.length) : null;
  if (!token) return null;
  const [p, s] = token.split('.') as [string, string];
  const bytes = Buffer.from(p, 'base64url');
  const payload = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const key = deriveTerminalKey(MASTER, String(payload['instanceId']));
  const expected = createHmac('sha256', Buffer.from(key, 'utf8')).update(bytes).digest();
  return expected.equals(Buffer.from(s, 'base64url')) ? payload : null;
}

async function startFakeTerminal(): Promise<FakeTerminal> {
  const wss = new WebSocketServer({ noServer: true });
  const state: Omit<FakeTerminal, 'url' | 'close'> = {
    upgrades: [],
    received: [],
    pings: 0,
    sessions: new Set(),
  };
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    const payload = verifyToken(req.headers.authorization);
    state.upgrades.push({
      authorization: req.headers.authorization,
      tokenSessionId: payload?.['sessionId'],
    });
    if (!payload || req.url !== '/v1/terminal') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('ping', () => {
        state.pings += 1;
      });
      ws.on('message', (raw, isBinary) => {
        const data = Buffer.from(raw as Buffer);
        state.received.push({ isBinary, data });
        if (isBinary) {
          ws.send(Buffer.concat([Buffer.from('echo:'), data]), { binary: true });
          return;
        }
        const frame = JSON.parse(data.toString('utf8')) as { t: string; session?: string };
        if (frame.t === 'open') {
          const resumed = !!frame.session && state.sessions.has(frame.session);
          const session = resumed ? frame.session! : randomUUID();
          state.sessions.add(session);
          ws.send(JSON.stringify({ t: 'ready', session, resumed }));
          ws.send(JSON.stringify({ t: 'signin', profile: 'claude', state: 'signed_in' }));
        } else if (frame.t === 'emit') {
          ws.send(Buffer.from('output from the shell'), { binary: true });
        } else if (frame.t === 'exit') {
          ws.send(JSON.stringify({ t: 'exit', code: 0, signal: null }));
          ws.close(1000);
        } else if (frame.t === 'die') {
          ws.terminate(); // the machine drops mid-stream
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...state,
    get upgrades() {
      return state.upgrades;
    },
    get received() {
      return state.received;
    },
    get pings() {
      return state.pings;
    },
    url: `ws://127.0.0.1:${port}`,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── The relay under test, and a browser ─────────────────────────────────────

let fake: FakeTerminal;
let relay: TerminalRelay;
let relayUrl: string;
let nowMs = 0;
const logs: string[] = [];
const reported: Error[] = [];
const touches: string[] = [];
const heartbeats: { id: string; workspaceId: string }[][] = [];
let failTouch = false;
/** While set, every touch waits on it — a touch still writing when the relay closes. */
let holdTouch: Promise<void> | null = null;

async function startRelay(
  overrides: { pingIntervalMs?: number; heartbeatIntervalMs?: number; authTimeoutMs?: number } = {},
): Promise<void> {
  relay = createTerminalRelay({
    allowedOrigin: ORIGIN,
    authorize: (ticket, channel) => relayService.authorizeConnection(ticket, channel),
    openConnection: (input) => relayService.openConnection({ ...input, relayMachineId: RELAY_ID }),
    closeConnection: (input) => relayService.closeConnection(input),
    touchActivity: async (instanceId) => {
      touches.push(instanceId);
      if (holdTouch) await holdTouch;
      if (failTouch) throw new Error(`touch failed while carrying ${MARKER}`);
    },
    heartbeat: async (held) => {
      heartbeats.push(held);
      await relayService.heartbeatConnections({ relayMachineId: RELAY_ID, connections: held });
    },
    log: (line) => logs.push(line),
    reportError: (err) => reported.push(err),
    now: () => nowMs,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 60_000,
    authTimeoutMs: overrides.authTimeoutMs ?? LOADED_SHARD_MS,
    pingIntervalMs: overrides.pingIntervalMs ?? 60_000,
    dialTimeoutMs: 2_000,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  relayUrl = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}/v1/terminal`;
}

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.spyOn(agentTerminalClock, 'now').mockImplementation(() => clock.now());
  logs.length = 0;
  reported.length = 0;
  touches.length = 0;
  heartbeats.length = 0;
  failTouch = false;
  holdTouch = null;
  nowMs = 1_000_000;
  fake = await startFakeTerminal();
  fleet.setTerminalAddress(fake.url);
  await startRelay();
});
afterEach(async () => {
  await relay.close();
  await fake.close();
  fleet.setTerminalAddress(null);
  await tearDownHarness();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Browser {
  ws: WebSocket;
  inbox: { isBinary: boolean; data: Buffer }[];
  pings: number;
  /** The close code once the socket has closed, so a wait on it can fail at once. */
  closeCode: number | null;
  closed: Promise<number>;
  opened: Promise<void>;
  texts(): Record<string, unknown>[];
}

function browser(origin: string | null = ORIGIN, url = relayUrl): Browser {
  const ws = new WebSocket(url, origin ? { origin } : {});
  const b: Browser = {
    ws,
    inbox: [],
    pings: 0,
    closeCode: null,
    closed: new Promise((resolve) =>
      ws.on('close', (code) => {
        b.closeCode = code;
        resolve(code);
      }),
    ),
    opened: new Promise((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    }),
    texts: () =>
      b.inbox
        .filter((m) => !m.isBinary)
        .map((m) => JSON.parse(m.data.toString('utf8')) as Record<string, unknown>),
  };
  ws.on('message', (data, isBinary) =>
    b.inbox.push({ isBinary, data: Buffer.from(data as Buffer) }),
  );
  ws.on('ping', () => {
    b.pings += 1;
  });
  return b;
}

/**
 * Poll until `done`. Given the browser the wait depends on, a browser the relay
 * has closed fails the wait at once with its close code and the relay's log
 * lines, instead of running out the deadline as a bare timeout (MOTIR-9877).
 */
async function until(
  done: () => boolean | Promise<boolean>,
  on?: Browser,
  ms = LOADED_SHARD_MS,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (on && on.closeCode !== null) {
      throw new Error(
        `the relay closed the browser ${on.closeCode} while waiting; relay log:\n${logs.join('\n')}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting after ${ms} ms; relay log:\n${logs.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const runningAgent = async () => {
  const dto = await lifecycle.create(
    fx.projectIdentifier,
    { name: `a-${randomUUID().slice(0, 6)}`, profileId: 'claude' },
    fx.ctx,
  );
  expect(dto.state).toBe('running');
  return dto.id;
};
const ticketFor = async (id: string) =>
  (await agentTerminalService.issueTicket(fx.projectIdentifier, id, fx.ctx)).ticket;

/**
 * A browser that has authenticated and whose `open` got a `ready`. The ticket is
 * minted BEFORE the socket connects: the relay's auth window starts at connect.
 */
async function openTerminal(id: string, session?: string) {
  const ticket = await ticketFor(id);
  const b = browser();
  await b.opened;
  b.ws.send(JSON.stringify({ t: 'auth', ticket }));
  b.ws.send(JSON.stringify({ t: 'open', cols: 80, rows: 24, ...(session ? { session } : {}) }));
  await until(() => b.texts().some((f) => f['t'] === 'ready'), b);
  return b;
}

const connections = () =>
  adminDb.agentTerminalConnection.findMany({ orderBy: { openedAt: 'asc' } });

// ── The tests ───────────────────────────────────────────────────────────────

describe('refusals before any byte flows (Q3)', () => {
  it('closes 4401 when no auth frame arrives within the window', async () => {
    await relay.close();
    await startRelay({ authTimeoutMs: SHORT_AUTH_WINDOW_MS });
    const b = browser();
    await b.opened;
    expect(await b.closed).toBe(4401);
    expect(fake.upgrades).toHaveLength(0);
  });

  it('closes 4403 for a foreign Origin, and for none', async () => {
    expect(await browser('https://evil.test').closed).toBe(4403);
    expect(await browser(null).closed).toBe(4403);
  });

  it('closes 4401 for a first frame that is not auth, a binary first frame, and an unknown ticket', async () => {
    for (const first of [
      JSON.stringify({ t: 'open', cols: 80, rows: 24 }),
      Buffer.from('bytes'),
      JSON.stringify({ t: 'auth', ticket: 'nobody-minted-this' }),
      'not json at all',
    ]) {
      const b = browser();
      await b.opened;
      b.ws.send(first);
      expect(await b.closed).toBe(4401);
    }
    expect(fake.upgrades).toHaveLength(0);
    expect(await connections()).toEqual([]);
  });

  it('re-reads the agent: 4409 once it stopped running, 4410 for an image without the server', async () => {
    const id = await runningAgent();
    for (const [patch, code] of [
      [{ state: 'hibernated' as const }, 4409],
      [{ terminalServer: 'absent' as const }, 4410],
    ] as const) {
      const ticket = await ticketFor(id);
      await adminDb.agentInstance.update({ where: { id }, data: patch });
      const b = browser();
      await b.opened;
      b.ws.send(JSON.stringify({ t: 'auth', ticket }));
      expect(await b.closed).toBe(code);
      await adminDb.agentInstance.update({
        where: { id },
        data: { state: 'running', terminalServer: 'present' },
      });
    }
    expect(fake.upgrades).toHaveLength(0);
  });

  it('closes 4502 when the machine does not answer, and records why', async () => {
    const id = await runningAgent();
    fleet.setTerminalAddress('ws://127.0.0.1:1');
    const ticket = await ticketFor(id);
    const b = browser();
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket }));
    expect(await b.closed).toBe(4502);
    await until(async () => (await connections())[0]?.closedAt != null);
    expect(await connections()).toMatchObject([
      { instanceId: id, userId: fx.ownerId, closeCode: 4502, closeReason: 'unreachable' },
    ]);
  });

  it('a chat ticket cannot open the terminal: 4401 on /v1/terminal, nothing dialled (MOTIR-7013)', async () => {
    const id = await runningAgent();
    const { ticket } = await agentTerminalService.issueTicket(
      fx.projectIdentifier,
      id,
      fx.ctx,
      'chat',
    );
    const b = browser();
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket }));
    expect(await b.closed).toBe(4401);
    expect(fake.upgrades).toHaveLength(0);
    expect(await connections()).toEqual([]);
  });

  it('a 404 from the terminal server is NOT the chat’s 4411: the terminal channel still closes 4502 (MOTIR-7013)', async () => {
    const id = await runningAgent();
    const notFound = http.createServer((_req, res) => res.writeHead(404).end());
    notFound.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((resolve) => notFound.listen(0, '127.0.0.1', resolve));
    fleet.setTerminalAddress(`ws://127.0.0.1:${(notFound.address() as AddressInfo).port}`);
    const ticket = await ticketFor(id);
    const b = browser();
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket }));
    expect(await b.closed).toBe(4502);
    expect(reported.map((e) => e.message)).toContain(
      'relay: the terminal server refused the upgrade (HTTP 404)',
    );
    await until(async () => (await connections())[0]?.closedAt != null);
    expect((await connections())[0]).toMatchObject({
      channel: 'terminal',
      closeCode: 4502,
      closeReason: 'unreachable',
    });
    await new Promise<void>((resolve) => notFound.close(() => resolve()));
  });

  it('closes 4502 when the terminal server refuses the relay token, reporting only the status', async () => {
    const id = await runningAgent();
    const ticket = await ticketFor(id);
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', 'z'.repeat(48)); // the relay now signs with the wrong key
    const b = browser();
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket }));
    expect(await b.closed).toBe(4502);
    expect(reported.map((e) => e.message)).toContain(
      'relay: the terminal server refused the upgrade (HTTP 401)',
    );
  });

  it('answers 404 off /v1/terminal and /v1/chat, and 200 on /healthz', async () => {
    // The chat check below waits out the auth window, so this relay's is short.
    await relay.close();
    await startRelay({ authTimeoutMs: SHORT_AUTH_WINDOW_MS });
    for (const path of ['/v1/other', '/v1/terminal/x', '/v1/chatty', '/']) {
      const off = new WebSocket(relayUrl.replace('/v1/terminal', path), { origin: ORIGIN });
      const status = await new Promise<number>((resolve) =>
        off.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
      );
      expect(status).toBe(404);
    }
    // `/v1/chat` is the chat channel's (MOTIR-7013): upgraded, then held to the auth rule.
    const chat = browser(ORIGIN, relayUrl.replace('/v1/terminal', '/v1/chat'));
    await chat.opened;
    expect(await chat.closed).toBe(4401);
    const health = await fetchLocal(
      relayUrl.replace('ws://', 'http://').replace('/v1/terminal', '/healthz'),
    );
    expect(health).toEqual({ status: 200, body: 'ok' });
    expect((await fetchLocal(relayUrl.replace('ws://', 'http://'))).status).toBe(404);
  });
});

function fetchLocal(url: string): Promise<{ status: number; body: string }> {
  // `fetch` is stubbed by the harness; a plain http GET is the honest client here.
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('a live terminal (Q3, Q4, Q5)', () => {
  it('dials the agent with the machine header and a relay token, and carries frames both ways unchanged', async () => {
    const id = await runningAgent();
    const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
    const b = await openTerminal(id);

    expect(fake.upgrades).toHaveLength(1);
    expect(fake.upgrades[0]!.authorization).toMatch(/^Motir-Relay /);
    expect(fake.upgrades[0]!.tokenSessionId).toBeUndefined();
    // The auth frame is consumed by the relay; the open frame arrives byte-identical.
    expect(fake.received[0]).toEqual({
      isBinary: false,
      data: Buffer.from(JSON.stringify({ t: 'open', cols: 80, rows: 24 })),
    });

    // The sign-in frame is the server's, as the server sent it.
    await until(() => b.texts().some((f) => f['t'] === 'signin'), b);
    expect(b.texts().find((f) => f['t'] === 'signin')).toEqual({
      t: 'signin',
      profile: 'claude',
      state: 'signed_in',
    });

    // Terminal bytes: input reaches the shell exactly, and its output comes back binary.
    const input = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xff, ...Buffer.from('ls -la\r')]);
    b.ws.send(input, { binary: true });
    await until(() => b.inbox.some((m) => m.isBinary), b);
    expect(fake.received.find((m) => m.isBinary)).toEqual({ isBinary: true, data: input });
    expect(b.inbox.find((m) => m.isBinary)!.data).toEqual(
      Buffer.concat([Buffer.from('echo:'), input]),
    );

    // A second auth frame mid-session is dropped, never forwarded.
    b.ws.send(JSON.stringify({ t: 'auth', ticket: 'again' }));
    b.ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
    await until(() => fake.received.length === 3, b);
    expect(
      fake.received.map((m) => (m.isBinary ? 'bin' : JSON.parse(m.data.toString())['t'])),
    ).toEqual(['open', 'bin', 'resize']);
    expect(row.machineId).toBeTruthy();
    b.ws.close(1000);
    expect(await b.closed).toBe(1000);
  });

  it('a re-open with the session id re-attaches the SAME shell', async () => {
    const id = await runningAgent();
    const first = await openTerminal(id);
    const ready = first.texts().find((f) => f['t'] === 'ready')!;
    expect(ready['resumed']).toBe(false);
    first.ws.close(1000);
    await first.closed;

    const second = await openTerminal(id, ready['session'] as string);
    expect(second.texts().find((f) => f['t'] === 'ready')).toEqual({
      t: 'ready',
      session: ready['session'],
      resumed: true,
    });
    // A fresh ticket for each connection; the session rode the open frame only.
    expect(fake.upgrades.map((u) => u.tokenSessionId)).toEqual([undefined, undefined]);
    second.ws.close(1000);
    await second.closed;
  });

  it('records one row per connection: opened, then closed with the browser’s code and the reason', async () => {
    const id = await runningAgent();
    const b = await openTerminal(id);
    await until(async () => (await connections()).length === 1);
    const [open] = await connections();
    expect(open).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      channel: 'terminal',
      closedAt: null,
    });
    clock.advance(42_000);
    b.ws.close(1000);
    await b.closed;
    await until(async () => (await connections())[0]!.closedAt != null);
    const [closed] = await connections();
    expect(closed).toMatchObject({ closeCode: 1000, closeReason: 'browser_closed' });
    expect(closed!.closedAt!.getTime() - closed!.openedAt.getTime()).toBe(42_000);
    expect(logs.some((l) => /closed instance=\S+ code=1000 reason=browser_closed/.test(l))).toBe(
      true,
    );
  });

  it('passes a shell exit through (1000, terminal_closed)', async () => {
    const id = await runningAgent();
    const b = await openTerminal(id);
    b.ws.send(JSON.stringify({ t: 'exit' }));
    expect(await b.closed).toBe(1000);
    expect(b.texts().some((f) => f['t'] === 'exit')).toBe(true);
    await until(async () => (await connections())[0]?.closedAt != null);
    expect((await connections())[0]).toMatchObject({
      closeCode: 1000,
      closeReason: 'terminal_closed',
    });
  });

  it('closes every connection 1012 on shutdown and records relay_shutdown', async () => {
    const id = await runningAgent();
    const b = await openTerminal(id);
    expect(relay.liveConnections).toBe(1);
    await relay.close();
    expect(await b.closed).toBe(1012);
    expect((await connections())[0]).toMatchObject({
      closeCode: 1012,
      closeReason: 'relay_shutdown',
    });
    await startRelay(); // for afterEach
  });

  it('pings both sides at the protocol level', async () => {
    await relay.close();
    await startRelay({ pingIntervalMs: 40 });
    const id = await runningAgent();
    const b = await openTerminal(id);
    await until(() => fake.pings >= 2 && b.pings >= 2, b);
    b.ws.close(1000);
    await b.closed;
  });
});

describe('the test harness holds on a loaded shard (MOTIR-9877)', () => {
  it('a mint slower than the old 300 ms window still dials, because it happens before connect', async () => {
    const id = await runningAgent();
    const issue = agentTerminalService.issueTicket.bind(agentTerminalService);
    vi.spyOn(agentTerminalService, 'issueTicket').mockImplementation(async (...args) => {
      await new Promise((r) => setTimeout(r, 1_000));
      return issue(...args);
    });
    const b = await openTerminal(id);
    expect(b.texts().find((f) => f['t'] === 'ready')).toMatchObject({ resumed: false });
    b.ws.close(1000);
    await b.closed;
  });

  it('a wait on the dial fails at once with the close code when the relay refuses it', async () => {
    const id = await runningAgent();
    const ticket = await ticketFor(id);
    await adminDb.agentInstance.update({ where: { id }, data: { state: 'hibernated' } });
    const started = Date.now();
    const b = browser();
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket }));
    b.ws.send(JSON.stringify({ t: 'open', cols: 80, rows: 24 }));
    await expect(until(() => b.texts().some((f) => f['t'] === 'ready'), b)).rejects.toThrow(
      /closed the browser 4409 while waiting/,
    );
    expect(Date.now() - started).toBeLessThan(LOADED_SHARD_MS);
  });
});

describe('activity (Q6) — throttled, and silent after close', () => {
  it('bumps on open, on binary either way and on an active ping, at most once a minute, then on close — and never after', async () => {
    const id = await runningAgent();
    const b = await openTerminal(id);
    await until(() => touches.length === 1); // on open
    const sendAndSettle = async (data: string | Buffer, binary: boolean) => {
      const before = fake.received.length;
      b.ws.send(data, { binary });
      await until(() => fake.received.length > before, b);
      await new Promise((r) => setTimeout(r, 20));
    };

    // Within the minute: bytes flow both ways and nothing is bumped.
    await sendAndSettle(Buffer.from('a'), true);
    await sendAndSettle(JSON.stringify({ t: 'ping', active: true }), false);
    expect(touches).toHaveLength(1);

    // A minute on, a binary frame from the browser bumps once (its echo does not).
    nowMs += 60_000;
    await sendAndSettle(Buffer.from('b'), true);
    expect(touches).toHaveLength(2);

    // Output alone (server → browser binary) keeps the agent awake too.
    nowMs += 60_000;
    await sendAndSettle(JSON.stringify({ t: 'emit' }), false);
    await until(
      () => b.inbox.some((m) => m.isBinary && m.data.toString() === 'output from the shell'),
      b,
    );
    expect(touches).toHaveLength(3);

    // A hidden tab's ping does not count; a visible one does.
    nowMs += 60_000;
    await sendAndSettle(JSON.stringify({ t: 'ping', active: false }), false);
    expect(touches).toHaveLength(3);
    await sendAndSettle(JSON.stringify({ t: 'ping', active: true }), false);
    expect(touches).toHaveLength(4);

    // Close: one last bump (the idle window starts here) — then silence.
    nowMs += 60_000;
    b.ws.close(1000);
    await b.closed;
    await until(() => touches.length === 5);
    nowMs += 10 * 60_000;
    await new Promise((r) => setTimeout(r, 100));
    expect(touches).toHaveLength(5);
    expect(new Set(touches)).toEqual(new Set([id]));
  });

  it('a shutdown waits for a touch still writing, so none outlives the relay (MOTIR-7815)', async () => {
    let release!: () => void;
    holdTouch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const id = await runningAgent();
    const b = await openTerminal(id);
    await until(() => touches.length === 1); // the open's touch, now held mid-write

    let shutDown = false;
    const closing = relay.close().then(() => {
      shutDown = true;
    });
    expect(await b.closed).toBe(1012);
    await new Promise((r) => setTimeout(r, 100));
    expect(shutDown).toBe(false);

    release();
    await closing;
    expect(shutDown).toBe(true);
    holdTouch = null;
    await startRelay(); // for afterEach
  });
});

describe('nothing that flows is logged or reported (Q8)', () => {
  it('carries a marker both ways, through a failing activity bump and a machine that drops mid-stream, and the marker is nowhere', async () => {
    const consoleLines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(
          args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '),
        );
      });
    }
    const id = await runningAgent();
    const ticket = await ticketFor(id);
    const b = browser();
    await b.opened;
    b.ws.send(JSON.stringify({ t: 'auth', ticket }));
    b.ws.send(JSON.stringify({ t: 'open', cols: 80, rows: 24 }));
    await until(() => b.texts().some((f) => f['t'] === 'ready'), b);

    failTouch = true; // every bump from here on throws, with the marker in its message
    nowMs += 60_000;
    b.ws.send(Buffer.from(`echo ${MARKER}\r`), { binary: true });
    await until(() => b.inbox.some((m) => m.isBinary && m.data.includes(MARKER)), b);
    b.ws.send(JSON.stringify({ t: 'resize', cols: 1, rows: 1, note: MARKER }));
    await until(() => fake.received.some((m) => m.data.includes(`"note":"${MARKER}"`)), b);
    b.ws.send(JSON.stringify({ t: 'die' })); // the machine drops mid-stream
    expect(await b.closed).toBe(4502);
    await until(async () => (await connections())[0]?.closedAt != null);
    expect((await connections())[0]).toMatchObject({ closeReason: 'unreachable', closeCode: 4502 });

    // The failing bump WAS reported — scrubbed of its message.
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.map((e) => e.message)).toContain('relay: touchActivity failed (Error)');

    const token = fake.upgrades[0]!.authorization!;
    const everything = [
      ...logs,
      ...consoleLines,
      ...reported.flatMap((e) => [e.message, e.stack ?? '', e.name]),
    ].join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [MARKER, ticket, token, token.split(' ')[1]!]) {
      expect(everything).not.toContain(secret);
    }
    // And the database holds nothing that flowed.
    expect(JSON.stringify(await connections())).not.toContain(MARKER);
  });
});

describe('liveness — one heartbeat for the whole relay (MOTIR-6959)', () => {
  it('refreshes lastSeenAt on the rows it holds, and lets a row go when it closes', async () => {
    await relay.close();
    await startRelay({ heartbeatIntervalMs: 40 });
    const id = await runningAgent();
    const b = await openTerminal(id);
    // `ready` comes from the machine; the row's insert may still be in flight.
    await until(async () => (await connections()).length === 1);
    const [row] = await connections();
    expect(row).toMatchObject({ relayMachineId: RELAY_ID, lastSeenAt: row!.openedAt });

    clock.advance(60_000);
    await until(
      async () => (await connections())[0]!.lastSeenAt.getTime() === clock.now().getTime(),
    );
    expect(heartbeats.at(-1)).toEqual([{ id: row!.id, workspaceId: fx.workspaceId }]);

    b.ws.close(1000);
    await until(async () => (await connections())[0]?.closedAt != null);
    const after = heartbeats.length;
    await new Promise((r) => setTimeout(r, 200));
    // Nothing held: the timer keeps ticking and writes nothing.
    expect(heartbeats.slice(after).flat()).toEqual([]);
  });
});
