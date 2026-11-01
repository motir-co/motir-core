import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { db } from '@/lib/db';
import { deriveTerminalKey } from '@/lib/agentInstances/terminalKey';
import {
  CHAT_PING_ACTIVE,
  CHAT_PING_INACTIVE,
  CHAT_PONG,
  TERMINAL_CLOSE,
  addressForChannel,
  channelForPath,
  isAgentTerminalChannel,
  type AgentTerminalChannel,
} from '@/lib/agentTerminal/protocol';
import { createTerminalRelay, type TerminalRelay } from '@/lib/agentTerminal/relay/terminalRelay';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import {
  agentTerminalClock,
  agentTerminalRelayService as relayService,
} from '@/lib/services/agentTerminalRelayService';
import { agentTerminalService } from '@/lib/services/agentTerminalService';
import {
  NonceMemory,
  verifyRelayAuthorization,
} from '../../packages/cli/src/agentTerminal/relayToken';
import { adminDb } from '../helpers/adminDb';
import { clock, fleet, fx, setUpHarness, tearDownHarness } from '../agentInstances/_harness';

// THE RELAY'S CHAT CHANNEL (Story MOTIR-6863 · MOTIR-7013,
// `docs/decisions/agent-chat.md` Q4, Q8, Q9, Q10): a real browser-side WebSocket
// → the relay at `/v1/chat` → a LOCAL fake machine the fake fleet resolves the
// agent to, over the real ticket service and a real Postgres. The fake stands in
// for MOTIR-7012's in-agent chat server: it verifies the relay token with that
// server's OWN `verifyRelayAuthorization`, echoes every chat frame back exactly as
// it arrived, answers the two pings with `{"t":"pong"}`, and can be told to
// answer the chat upgrade with a status instead (the image that predates chat).
//
// ⚠️ The fake never decodes a frame either — it compares bytes — so a JSON.parse
// spy can prove the RELAY decoded nothing after `auth`.

const MASTER = 'm'.repeat(48);
const ORIGIN = 'https://motir.test';
const MARKER = 'PROMPT-7013-never-logged-c4e1';
const RELAY_ID = 'relay-chat-test';
/**
 * How long any wait in this file — and the relay's own auth window — may take
 * (MOTIR-9875). Sized for a loaded CI shard, where a ticket mint alone measured
 * 437–519 ms on one throttled CPU, and kept under vitest's 15 s `testTimeout` so a
 * wait that cannot be met still fails as a wait.
 */
const WAIT_MS = 10_000;

// ── The fake machine ────────────────────────────────────────────────────────

interface FakeMachine {
  url: string;
  /** Who the relay token must name — set once the agent exists. */
  identity: { instanceId: string; machineId: string } | null;
  /** Answer the upgrade on this path with a status instead of serving it. */
  refuse: Partial<Record<string, number>>;
  /** On a hidden tab's ping, also push one event frame (server → browser alone). */
  pushOnQuietPing: boolean;
  upgrades: { path: string; verdict: string }[];
  received: Buffer[];
  close(): Promise<void>;
}

const bytesOf = (data: RawData): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);

async function startFakeMachine(): Promise<FakeMachine> {
  const wss = new WebSocketServer({ noServer: true });
  const nonces = new NonceMemory();
  const machine: Omit<FakeMachine, 'url' | 'close'> = {
    identity: null,
    refuse: {},
    pushOnQuietPing: false,
    upgrades: [],
    received: [],
  };
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const refuseWith = (socket: Duplex, status: number) => {
    socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const identity = machine.identity;
    const verdict = identity
      ? verifyRelayAuthorization(req.headers.authorization, {
          instanceKey: deriveTerminalKey(MASTER, identity.instanceId),
          instanceId: identity.instanceId,
          machineId: identity.machineId,
          nowSeconds: Math.floor(clock.now().getTime() / 1000),
          nonces,
        })
      : ({ ok: false, reason: 'no identity' } as const);
    machine.upgrades.push({ path, verdict: verdict.ok ? 'ok' : verdict.reason });
    const status = machine.refuse[path];
    if (status) return refuseWith(socket, status);
    if (!verdict.ok) return refuseWith(socket, 401);
    if (path !== '/v1/chat' && path !== '/v1/terminal') return refuseWith(socket, 404);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (raw, isBinary) => {
        const data = bytesOf(raw);
        machine.received.push(data);
        if (data.equals(Buffer.from(CHAT_PING_ACTIVE))) return void ws.send(CHAT_PONG);
        if (data.equals(Buffer.from(CHAT_PING_INACTIVE))) {
          ws.send(CHAT_PONG);
          if (machine.pushOnQuietPing) ws.send('{"t":"event","turn":1,"e":{"kind":"text"}}');
          return;
        }
        if (data.equals(Buffer.from('DROP'))) return void ws.terminate();
        ws.send(data, { binary: isBinary }); // an echo, byte for byte
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(machine, {
    url: `ws://127.0.0.1:${port}`,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

// ── The relay under test, and a browser ─────────────────────────────────────

let machine: FakeMachine;
let relay: TerminalRelay;
let relayBase: string;
let nowMs = 0;
const logs: string[] = [];
const reported: Error[] = [];
const touches: string[] = [];
let failTouch = false;

async function startRelay(): Promise<void> {
  relay = createTerminalRelay({
    allowedOrigin: ORIGIN,
    authorize: (ticket, channel) => relayService.authorizeConnection(ticket, channel),
    openConnection: (input) => relayService.openConnection({ ...input, relayMachineId: RELAY_ID }),
    closeConnection: (input) => relayService.closeConnection(input),
    touchActivity: async (instanceId) => {
      touches.push(instanceId);
      if (failTouch) throw new Error(`touch failed while carrying ${MARKER}`);
    },
    heartbeat: async () => {},
    log: (line) => logs.push(line),
    reportError: (err) => reported.push(err),
    now: () => nowMs,
    heartbeatIntervalMs: 60_000,
    authTimeoutMs: WAIT_MS,
    pingIntervalMs: 60_000,
    dialTimeoutMs: 2_000,
  });
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  relayBase = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.spyOn(agentTerminalClock, 'now').mockImplementation(() => clock.now());
  logs.length = 0;
  reported.length = 0;
  touches.length = 0;
  failTouch = false;
  nowMs = 1_000_000;
  machine = await startFakeMachine();
  fleet.setTerminalAddress(machine.url);
  await startRelay();
});
afterEach(async () => {
  await relay.close();
  await machine.close();
  fleet.setTerminalAddress(null);
  await tearDownHarness();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Browser {
  ws: WebSocket;
  inbox: Buffer[];
  closed: Promise<number>;
  /** The close code once the relay (or the test) has closed this browser. */
  closeCode: number | null;
  opened: Promise<void>;
}

function browser(path: '/v1/chat' | '/v1/terminal' = '/v1/chat'): Browser {
  const ws = new WebSocket(`${relayBase}${path}`, { origin: ORIGIN });
  const b: Browser = {
    ws,
    inbox: [],
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
  };
  ws.on('message', (data) => b.inbox.push(bytesOf(data)));
  return b;
}

/** What the relay said, for a wait that failed: a refusal and a slow dial must not read alike. */
const relayState = () =>
  `relay log: ${JSON.stringify(logs)}; reported: ${JSON.stringify(reported.map((e) => e.message))}`;

/**
 * Poll until `done`. Given the browser the wait depends on, a close fails it AT
 * ONCE with the close code (MOTIR-9875) — the relay refusing it is an answer,
 * not a reason to run out the clock.
 */
async function until(
  done: () => boolean | Promise<boolean>,
  { ms = WAIT_MS, browser: b }: { ms?: number; browser?: Browser } = {},
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (b?.closeCode != null) {
      throw new Error(`browser closed ${b.closeCode} while waiting; ${relayState()}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting ${ms} ms; ${relayState()}`);
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
  const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: dto.id } });
  machine.identity = { instanceId: row.id, machineId: row.machineId! };
  return dto.id;
};

const ticketFor = async (id: string, channel: AgentTerminalChannel = 'chat') =>
  (await agentTerminalService.issueTicket(fx.projectIdentifier, id, fx.ctx, channel)).ticket;

/**
 * A browser on `path` that has sent `ticket` as its first frame. The ticket is
 * minted BEFORE this is called: the relay's auth window opens with the socket, so
 * a mint inside it is a database write racing the window (MOTIR-9875).
 */
async function authed(ticket: string, path?: '/v1/chat' | '/v1/terminal'): Promise<Browser> {
  const b = browser(path);
  await b.opened;
  b.ws.send(JSON.stringify({ t: 'auth', ticket }));
  return b;
}

/** Wait until the relay has authorised `b` and dialled the machine. */
const dialled = (b: Browser) =>
  until(() => machine.upgrades.length === 1 && relay.liveConnections === 1, { browser: b });

/** A browser on `/v1/chat` that has authenticated, once its dial is through. */
async function openChat(id: string): Promise<Browser> {
  const b = await authed(await ticketFor(id));
  await dialled(b);
  // The first frame the machine sees proves the upstream socket is open.
  b.ws.send('{"t":"list"}');
  await until(() => machine.received.length === 1);
  // ...and its echo back through the relay, so the bump it causes lands before a test moves the clock.
  await until(() => b.inbox.length === 1);
  return b;
}

/** Send one frame and wait until the machine has it (and the relay has acted on it). */
async function sendAndSettle(b: Browser, frame: string | Buffer): Promise<void> {
  const before = machine.received.length;
  b.ws.send(frame);
  await until(() => machine.received.length > before);
  await new Promise((r) => setTimeout(r, 30));
}

const connections = () =>
  adminDb.agentTerminalConnection.findMany({ orderBy: { openedAt: 'asc' } });

// ── The tests ───────────────────────────────────────────────────────────────

describe('the channel’s words (agent-chat.md Q4, Q8, Q9)', () => {
  it('names two channels, one path each, and the close code and heartbeat bytes the ADR fixes', () => {
    expect(['terminal', 'chat'].every(isAgentTerminalChannel)).toBe(true);
    for (const bad of ['Chat', 'shell', '', null, undefined, 7, ['chat']]) {
      expect(isAgentTerminalChannel(bad)).toBe(false);
    }
    expect(channelForPath('/v1/terminal')).toBe('terminal');
    expect(channelForPath('/v1/chat')).toBe('chat');
    expect(channelForPath('/v1/chat/')).toBeNull();
    expect(TERMINAL_CLOSE).toMatchObject({ noTerminalServer: 4410, noChatServer: 4411 });
    expect([CHAT_PING_ACTIVE, CHAT_PING_INACTIVE, CHAT_PONG]).toEqual([
      '{"t":"ping","active":true}',
      '{"t":"ping","active":false}',
      '{"t":"pong"}',
    ]);
  });

  it('moves an address to the chat path, keeping its host and prefix', () => {
    expect(addressForChannel('wss://a.fly.dev/v1/terminal', 'terminal')).toBe(
      'wss://a.fly.dev/v1/terminal',
    );
    expect(addressForChannel('wss://a.fly.dev/v1/terminal', 'chat')).toBe(
      'wss://a.fly.dev/v1/chat',
    );
    expect(addressForChannel('ws://localhost:8080/relay/v1/terminal', 'chat')).toBe(
      'ws://localhost:8080/relay/v1/chat',
    );
    expect(addressForChannel('wss://relay.example//', 'chat')).toBe('wss://relay.example/v1/chat');
  });
});

describe('the chat channel carries frames both ways, unchanged (agent-chat.md Q4)', () => {
  it('dials the machine’s /v1/chat with a relay token its own verifier accepts, and frames pass byte for byte', async () => {
    const id = await runningAgent();
    const b = await openChat(id);

    expect(machine.upgrades).toEqual([{ path: '/v1/chat', verdict: 'ok' }]);
    // The auth frame was consumed by the relay; the first frame through is the list.
    expect(machine.received[0]).toEqual(Buffer.from('{"t":"list"}'));

    const frames = [
      JSON.stringify({ t: 'prompt', text: 'héllo — 你好 🚀 "quoted" \\ backslash' }),
      JSON.stringify({ t: 'open', session: 'abc' }),
      'x'.repeat(200_000), // a prompt-sized frame, forwarded unread
    ];
    for (const frame of frames) {
      const before = b.inbox.length;
      await sendAndSettle(b, frame);
      await until(() => b.inbox.length > before);
      expect(machine.received.at(-1)).toEqual(Buffer.from(frame));
      expect(b.inbox.at(-1)).toEqual(Buffer.from(frame));
    }
    b.ws.close(1000);
    expect(await b.closed).toBe(1000);
  });

  it('records the chat connection’s row: channel chat, its open and its close — and nothing else about it', async () => {
    const id = await runningAgent();
    const b = await openChat(id);
    await until(async () => (await connections()).length === 1);
    expect((await connections())[0]).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      channel: 'chat',
      closedAt: null,
    });
    clock.advance(30_000);
    b.ws.close(1000);
    await b.closed;
    await until(async () => (await connections())[0]?.closedAt != null);
    const [row] = await connections();
    expect(row).toMatchObject({ channel: 'chat', closeCode: 1000, closeReason: 'browser_closed' });
    expect(row!.closedAt!.getTime() - row!.openedAt.getTime()).toBe(30_000);
    expect(logs.some((l) => / opened instance=\S+ user=\S+ channel=chat$/.test(l))).toBe(true);
  });
});

describe('a ticket opens only its own channel (agent-chat.md Q4)', () => {
  it('a chat ticket on /v1/terminal and a terminal ticket on /v1/chat both close 4401, and nothing is dialled', async () => {
    const id = await runningAgent();
    for (const [minted, path] of [
      ['chat', '/v1/terminal'],
      ['terminal', '/v1/chat'],
    ] as const) {
      const b = await authed(await ticketFor(id, minted), path);
      expect(await b.closed).toBe(TERMINAL_CLOSE.badTicket);
      expect(logs.at(-1)).toMatch(/refused code=4401 \(refused\)$/); // not the auth window
    }
    expect(machine.upgrades).toEqual([]);
    expect(await connections()).toEqual([]);
  });
});

describe('an image with no chat server (agent-chat.md Q8)', () => {
  it('the machine’s 404 on /v1/chat closes the browser 4411, recorded, and reported nowhere', async () => {
    const id = await runningAgent();
    machine.refuse['/v1/chat'] = 404;
    const b = await authed(await ticketFor(id));
    expect(await b.closed).toBe(TERMINAL_CLOSE.noChatServer);
    expect(TERMINAL_CLOSE.noChatServer).toBe(4411);
    await until(async () => (await connections())[0]?.closedAt != null);
    expect((await connections())[0]).toMatchObject({
      channel: 'chat',
      closeCode: 4411,
      closeReason: 'no_chat_server',
    });
    expect(reported).toEqual([]);
    expect(logs.some((l) => l.includes('has no chat server'))).toBe(true);
  });

  it('any other refusal on /v1/chat stays 4502', async () => {
    const id = await runningAgent();
    machine.refuse['/v1/chat'] = 500;
    const b = await authed(await ticketFor(id));
    expect(await b.closed).toBe(TERMINAL_CLOSE.unreachable);
    expect(reported.map((e) => e.message)).toContain(
      'relay: the chat server refused the upgrade (HTTP 500)',
    );
  });

  it('a 404 on /v1/terminal is unchanged: the terminal channel closes 4502', async () => {
    const id = await runningAgent();
    machine.refuse['/v1/terminal'] = 404;
    const b = await authed(await ticketFor(id, 'terminal'), '/v1/terminal');
    expect(await b.closed).toBe(TERMINAL_CLOSE.unreachable);
    expect(reported.map((e) => e.message)).toContain(
      'relay: the terminal server refused the upgrade (HTTP 404)',
    );
  });
});

describe('activity (agent-chat.md Q9) — every chat frame counts, but a hidden tab’s heartbeat', () => {
  it('bumps on open, on frames either way and on an active ping, never on the inactive ping or a pong, through the once-a-minute throttle', async () => {
    const id = await runningAgent();
    const b = await openChat(id);
    await until(() => touches.length === 1); // on open (the list frame fell in the same minute)

    // A new minute: the hidden tab's heartbeat, its pong, and a pong from the browser do not count.
    nowMs += 60_000;
    await sendAndSettle(b, CHAT_PING_INACTIVE);
    await until(() => b.inbox.some((m) => m.equals(Buffer.from(CHAT_PONG))));
    await sendAndSettle(b, CHAT_PONG);
    expect(touches).toHaveLength(1);

    // A byte-level near miss is content, and content counts.
    await sendAndSettle(b, '{"t": "ping","active":false}');
    expect(touches).toHaveLength(2);

    // A visible tab's heartbeat counts.
    nowMs += 60_000;
    await sendAndSettle(b, CHAT_PING_ACTIVE);
    expect(touches).toHaveLength(3);
    // ...and a second one inside the same minute is throttled.
    await sendAndSettle(b, CHAT_PING_ACTIVE);
    expect(touches).toHaveLength(3);

    // A prompt-sized frame counts.
    nowMs += 60_000;
    await sendAndSettle(b, JSON.stringify({ t: 'prompt', text: 'y'.repeat(64 * 1024) }));
    expect(touches).toHaveLength(4);

    // Server → browser alone counts: the quiet ping and its pong do not, the pushed event does.
    nowMs += 60_000;
    machine.pushOnQuietPing = true;
    const before = b.inbox.length;
    await sendAndSettle(b, CHAT_PING_INACTIVE);
    await until(() => b.inbox.length >= before + 2);
    expect(touches).toHaveLength(5);

    // Close: one last bump — then silence.
    nowMs += 60_000;
    b.ws.close(1000);
    await b.closed;
    await until(() => touches.length === 6);
    nowMs += 10 * 60_000;
    await new Promise((r) => setTimeout(r, 100));
    expect(touches).toHaveLength(6);
    expect(new Set(touches)).toEqual(new Set([id]));
  });

  it('decodes no chat frame after auth: a frame that is not JSON — or looks like auth — passes through and counts', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const id = await runningAgent();
    const b = await openChat(id);
    await until(() => touches.length === 1);

    nowMs += 60_000;
    const notJson = `{"t":"prompt","text":"${MARKER} — unterminated`;
    await sendAndSettle(b, notJson);
    expect(machine.received.at(-1)).toEqual(Buffer.from(notJson));
    expect(touches).toHaveLength(2);

    // The terminal drops a repeated auth after parsing it; the chat does not parse, so it forwards.
    const lateAuth = JSON.stringify({ t: 'auth', ticket: `late-${MARKER}` });
    await sendAndSettle(b, lateAuth);
    expect(machine.received.at(-1)).toEqual(Buffer.from(lateAuth));

    const small = JSON.stringify({ t: 'stop', note: MARKER }); // under MAX_PARSED_TEXT_BYTES
    await sendAndSettle(b, small);
    expect(machine.received.at(-1)).toEqual(Buffer.from(small));

    // Not one of those frames reached a JSON.parse — the relay compared bytes only.
    const parsed = parse.mock.calls.map((call) => String(call[0]));
    expect(parsed.filter((text) => text.includes(MARKER))).toEqual([]);
    b.ws.close(1000);
    await b.closed;
  });
});

describe('nothing that flows is logged or reported (agent-chat.md Q10)', () => {
  it('a chat carrying a known prompt — through a failing bump and a machine that drops — leaves it in no log line, report or row', async () => {
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
    const b = await authed(ticket);
    await dialled(b);
    await sendAndSettle(b, JSON.stringify({ t: 'open' }));

    failTouch = true; // every bump from here on throws, with the prompt in its message
    nowMs += 60_000;
    const prompt = JSON.stringify({ t: 'prompt', text: `please ${MARKER} refactor` });
    await sendAndSettle(b, prompt);
    await until(() => b.inbox.some((m) => m.includes(MARKER)));
    await sendAndSettle(b, `broken ${MARKER} {`);
    b.ws.send('DROP'); // the machine drops mid-turn
    expect(await b.closed).toBe(TERMINAL_CLOSE.unreachable);
    await until(async () => (await connections())[0]?.closedAt != null);

    // The failing bump WAS reported — scrubbed of its message.
    expect(reported.map((e) => e.message)).toContain('relay: touchActivity failed (Error)');

    const everything = [
      ...logs,
      ...consoleLines,
      ...reported.flatMap((e) => [e.message, e.stack ?? '', e.name]),
    ].join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [MARKER, ticket]) expect(everything).not.toContain(secret);
    // The database holds the row — channel chat, open and close — and nothing that flowed.
    const rows = await connections();
    expect(rows).toMatchObject([{ channel: 'chat', closeCode: 4502, closeReason: 'unreachable' }]);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    expect(JSON.stringify(await adminDb.agentTerminalTicket.findMany({}))).not.toContain(MARKER);
  });
});
