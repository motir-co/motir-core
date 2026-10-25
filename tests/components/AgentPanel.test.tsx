// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import {
  TERMINAL_PING_MS,
  TERMINAL_RECONNECT_WINDOW_MS,
  terminalSessionKey,
} from '@/app/(authed)/my-agents/_components/useAgentTerminal';
import type { AgentInstanceListItemDto, AgentInstanceListPageDto } from '@/lib/dto/agentInstances';

// THE AGENT PANEL (Story MOTIR-6861 · MOTIR-6941), held to the approved
// `design/my-agents/my-agents--panel.mock.html` (MOTIR-6937) and
// `docs/decisions/agent-terminal.md` Q3–Q7. The routes are stubbed at `fetch`, the
// relay at `WebSocket`, and xterm at its module (happy-dom has no canvas): what is
// asserted is the panel's own decisions — which face it wears for each lifecycle,
// connection and sign-in state, what it sends on the wire, and that its mutations
// re-read the list beside it.

// ── xterm, at the module boundary ──────────────────────────────────────────
const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    written: Uint8Array[];
    resets: number;
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    disposed: boolean;
    fireData: (data: string) => void;
    fireResize: (cols: number, rows: number) => void;
  }>,
}));
vi.mock('@xterm/xterm', () => {
  class Terminal {
    written: Uint8Array[] = [];
    resets = 0;
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    disposed = false;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    private dataCb: ((d: string) => void) | null = null;
    private resizeCb: ((s: { cols: number; rows: number }) => void) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    write(bytes: Uint8Array) {
      this.written.push(bytes);
    }
    reset() {
      this.resets += 1;
    }
    dispose() {
      this.disposed = true;
    }
    scrollToBottom() {}
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
    }
    onResize(cb: (s: { cols: number; rows: number }) => void) {
      this.resizeCb = cb;
    }
    onScroll() {}
    onWriteParsed() {}
    fireData(data: string) {
      this.dataCb?.(data);
    }
    fireResize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizeCb?.({ cols, rows });
    }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

// ── the relay, at the WebSocket boundary ───────────────────────────────────
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: Array<string | Uint8Array> = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  /** Server side. */
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  bytes(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get frames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}
const lastSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

// ── fixtures ───────────────────────────────────────────────────────────────
const PROFILES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'kimi', name: 'Kimi Code' },
];

function agent(over: Partial<AgentInstanceListItemDto> = {}): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: 'yue-claude',
    projectId: 'p1',
    profileId: 'claude',
    profileName: 'Claude Code',
    imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
    imageDigest: 'sha256:abc',
    imageVersion: '1.0.0',
    update: null,
    pendingImageVersion: null,
    updateFailureReason: null,
    region: 'iad',
    state: 'running',
    failureReason: null,
    terminalServer: 'present',
    stateChangedAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    createdAt: '2026-09-29T10:00:00.000Z',
    machineSecondsThisMonth: 72 * 60,
    creditsThisMonth: 72,
    stopReason: null,
    scheduledDeletionAt: null,
    activeRun: null,
    lastRun: null,
    bootStep: null,
    ...over,
  };
}
const codex = (over: Partial<AgentInstanceListItemDto> = {}) =>
  agent({ id: 'a2', name: 'yue-codex', profileId: 'codex', profileName: 'Codex', ...over });

const page = (instances: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
  instances,
  total: instances.length,
  planLapse: null,
});

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

const TICKET = { url: 'wss://relay.motir.test/v1/terminal', ticket: 't0k3n', expiresAt: 'x' };

/** Routes the stubbed fetch answers; each test overrides what it needs. */
let routes: {
  list: () => AgentInstanceListPageDto;
  ticket: () => Response;
  wake: () => Response;
  hibernate: () => Response;
  del: () => Response;
  /** The boot stream's frames; null answers it with no body (no read-out). */
  boot?: (() => string[]) | null;
};
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  if (url.includes('/boot/stream')) {
    const frames = routes.boot?.();
    if (!frames) return json(200, {});
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
      },
    });
    return { ok: true, status: 200, body } as Response;
  }
  if (url.endsWith('/terminal-ticket')) return routes.ticket();
  if (url.endsWith('/wake')) return routes.wake();
  if (url.endsWith('/hibernate')) return routes.hibernate();
  if (method === 'DELETE') return routes.del();
  return json(200, routes.list());
});
const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
  }));
const ticketCalls = () => calls().filter((c) => c.url.endsWith('/terminal-ticket')).length;

beforeEach(() => {
  fetchMock.mockClear();
  FakeSocket.instances = [];
  xterm.instances.length = 0;
  routes = {
    list: () => page([agent(), codex({ state: 'hibernated' })]),
    ticket: () => json(200, TICKET),
    wake: () => json(202, {}),
    hibernate: () => json(202, {}),
    del: () => json(204, null),
  };
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeSocket);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/my-agents');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let fetches, dynamic imports and the effects they trigger settle. */
async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(
  initial: AgentInstanceListPageDto = routes.list(),
  opts: { openAgentId?: string | null; messages?: Record<string, unknown> } = {},
) {
  const result = render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={initial}
      profiles={PROFILES}
      openAgentId={opts.openAgentId ?? null}
    />,
    opts.messages ? { messages: opts.messages, locale: 'zh' } : {},
  );
  await flush();
  return result;
}

/** Accept the latest socket and attach it to a shell. */
async function goLive(session = 'sess-1', resumed = false) {
  const ws = lastSocket();
  act(() => ws.accept());
  act(() => ws.frame({ t: 'ready', session, resumed }));
  await flush();
  return ws;
}

const panel = () => screen.getByTestId('agent-panel');
const connWord = () => screen.getByTestId('agent-conn').textContent;

// ─────────────────────────────────────────────────────────────────────────────
describe('the access path (panel 1)', () => {
  it('a row click opens the panel beside a still-usable list, and the address names it', async () => {
    await mount();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
    const row = screen.getAllByTestId('agent-row')[0]!;
    fireEvent.click(row);
    await flush();

    expect(window.location.search).toBe('?agent=a1');
    expect(within(panel()).getByRole('heading', { name: /yue-claude/ })).toBeTruthy();
    expect(within(panel()).getByText('Claude Code · motir')).toBeTruthy();
    // The list stays, in its card form, with the open agent marked.
    const column = screen.getByTestId('agent-list-column');
    const cards = within(column).getAllByRole('listitem');
    expect(cards[0]!.getAttribute('aria-current')).toBe('true');
    expect(cards[1]!.getAttribute('aria-current')).toBeNull();

    // Clicking another card switches the panel and the address.
    fireEvent.click(cards[1]!);
    await flush();
    expect(window.location.search).toBe('?agent=a2');
    expect(within(panel()).getByRole('heading', { name: /yue-codex/ })).toBeTruthy();
  });

  it('Enter on a focused row opens it; the row menu keeps its own click', async () => {
    await mount();
    const row = screen.getAllByTestId('agent-row')[0]!;
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for yue-claude' }));
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
    expect(window.location.search).toBe('');

    fireEvent.keyDown(row, { key: 'Enter' });
    await flush();
    expect(screen.getByTestId('agent-panel')).toBeTruthy();
  });

  it('a reload of the address reopens the agent', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    expect(within(panel()).getByRole('heading', { name: /yue-claude/ })).toBeTruthy();
  });

  it('× closes: the address drops ?agent=, the list returns to its table, focus returns to the row, the socket closes', async () => {
    await mount();
    fireEvent.click(screen.getAllByTestId('agent-row')[0]!);
    await flush();
    const ws = await goLive();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close yue-claude' }));
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
    expect(window.location.search).toBe('');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-agent-id')).toBe('a1');
    expect(ws.closedWith).toBe(1000);
  });

  it('Esc closes from the panel, but not from inside the terminal (it is the shell’s there)', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    await goLive();
    fireEvent.keyDown(screen.getByTestId('agent-terminal'), { key: 'Escape' });
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeTruthy();
    fireEvent.keyDown(within(panel()).getByRole('button', { name: 'Close yue-claude' }), {
      key: 'Escape',
    });
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
  });

  it('Back closes the panel (the address moved)', async () => {
    await mount();
    fireEvent.click(screen.getAllByTestId('agent-row')[0]!);
    await flush();
    act(() => {
      window.history.replaceState(null, '', '/my-agents');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
  });

  it('an address naming an agent the reader’s list does not hold: one answer, nothing about it', async () => {
    await mount(undefined, { openAgentId: 'someone-elses' });
    expect(
      within(panel()).getByRole('heading', { name: 'This agent isn’t available' }),
    ).toBeTruthy();
    expect(panel().textContent).toContain('Only the person who created an agent can open it.');
    expect(ticketCalls()).toBe(0);
    // The list stays the reader's own, with nothing selected.
    const cards = within(screen.getByTestId('agent-list-column')).getAllByRole('listitem');
    expect(cards.every((c) => c.getAttribute('aria-current') === null)).toBe(true);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Back to My agents' }));
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
  });
});

describe('the terminal (panel 5, Q3–Q6)', () => {
  it('connects: a ticket, then the relay with the ticket in the first frame (never the URL), then open', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    expect(connWord()).toContain('Connecting…');
    expect(panel().textContent).toContain('Connecting to yue-claude’s terminal…');
    expect(calls()).toContainEqual({
      url: '/api/projects/MOTIR/instances/a1/terminal-ticket',
      method: 'POST',
    });
    const ws = lastSocket();
    expect(ws.url).toBe(TICKET.url);
    expect(ws.url).not.toContain(TICKET.ticket);
    act(() => ws.accept());
    expect(ws.frames[0]).toEqual({ t: 'auth', ticket: 't0k3n' });
    expect(ws.frames[1]).toEqual({ t: 'open', cols: 80, rows: 24 });
    act(() => ws.frame({ t: 'ready', session: 'sess-1', resumed: false }));
    await flush();
    expect(connWord()).toContain('Live');
    expect(panel().textContent).not.toContain('Connecting to');
  });

  it('typing is sent as bytes, output is written, a resize sends a resize frame', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive();
    const term = xterm.instances[0]!;
    act(() => ws.bytes('node@yue-claude:~/workspace$ '));
    expect(new TextDecoder().decode(term.written[0])).toBe('node@yue-claude:~/workspace$ ');
    act(() => term.fireData('stty size\r'));
    const typed = ws.sent.find((s) => typeof s !== 'string') as Uint8Array;
    expect(new TextDecoder().decode(typed)).toBe('stty size\r');
    act(() => term.fireResize(96, 25));
    expect(ws.frames).toContainEqual({ t: 'resize', cols: 96, rows: 25 });
    expect(term.options['disableStdin']).toBe(false);
  });

  it('pings every 20 s with the page’s visibility', async () => {
    vi.useFakeTimers();
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_PING_MS);
    });
    expect(ws.frames).toContainEqual({ t: 'ping', active: true });
  });

  it('a drop reconnects to the SAME shell (the session from sessionStorage), showing reconnecting', async () => {
    vi.useFakeTimers();
    await mount(undefined, { openAgentId: 'a1' });
    const first = await goLive('sess-42');
    expect(window.sessionStorage.getItem(terminalSessionKey('a1'))).toBe('sess-42');
    act(() => first.drop(1006));
    await flush();
    expect(connWord()).toContain('Reconnecting…');
    expect(panel().textContent).toContain(
      'Connection dropped — reconnecting to the same shell. Your build keeps running.',
    );
    expect(xterm.instances[0]!.options['disableStdin']).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();
    const second = lastSocket();
    expect(second).not.toBe(first);
    act(() => second.accept());
    expect(second.frames[1]).toMatchObject({ t: 'open', session: 'sess-42' });
    act(() => second.frame({ t: 'ready', session: 'sess-42', resumed: true }));
    await flush();
    expect(connWord()).toContain('Live');
  });

  it('after about a minute of failed retries it is lost, with Reconnect — which mints a new ticket', async () => {
    vi.useFakeTimers();
    await mount(undefined, { openAgentId: 'a1' });
    await goLive();
    routes.ticket = () => json(502, {});
    act(() => lastSocket().drop(1006));
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_RECONNECT_WINDOW_MS + 15_000);
    });
    await flush();
    expect(connWord()).toContain('Disconnected');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'Couldn’t reconnect. Your shell is still running on the agent — reconnect to pick it up.',
    );
    routes.ticket = () => json(200, TICKET);
    const before = ticketCalls();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reconnect' }));
    await flush();
    expect(ticketCalls()).toBe(before + 1);
    await goLive();
    expect(connWord()).toContain('Live');
  });

  it('a shell exit is Ended, with Start a new shell — a fresh open, no session', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive('sess-9');
    act(() => ws.frame({ t: 'exit', code: 0, signal: null }));
    act(() => ws.drop(1000));
    await flush();
    expect(connWord()).toContain('Ended');
    expect(panel().textContent).toContain(
      'The shell exited. Your files are all still in the home.',
    );
    expect(window.sessionStorage.getItem(terminalSessionKey('a1'))).toBeNull();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Start a new shell' }));
    await flush();
    const next = lastSocket();
    act(() => next.accept());
    expect(next.frames[1]).toEqual({ t: 'open', cols: 80, rows: 24 });
  });

  it('unknown_session (a cold boot) opens a fresh shell on the same connection, with no words', async () => {
    window.sessionStorage.setItem(terminalSessionKey('a1'), 'gone');
    await mount(undefined, { openAgentId: 'a1' });
    const ws = lastSocket();
    act(() => ws.accept());
    expect(ws.frames[1]).toMatchObject({ session: 'gone' });
    act(() => ws.frame({ t: 'error', code: 'unknown_session' }));
    expect(ws.frames[2]).toEqual({ t: 'open', cols: 80, rows: 24 });
    act(() => ws.frame({ t: 'ready', session: 'fresh', resumed: false }));
    await flush();
    expect(connWord()).toContain('Live');
    expect(window.sessionStorage.getItem(terminalSessionKey('a1'))).toBe('fresh');
  });

  it('no terminal content is ever written to browser storage — only the session id', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive('sess-7');
    act(() => ws.bytes('SECRET-OUTPUT paste-code-123'));
    act(() => xterm.instances[0]!.fireData('SECRET-INPUT'));
    const dump = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i)!)}`).join('\n');
    const everything = `${dump(window.sessionStorage)}\n${dump(window.localStorage)}`;
    expect(everything).not.toContain('SECRET');
    expect(everything).not.toContain('paste-code');
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
  });
});

describe('close codes and refusals (panel 6)', () => {
  it('4403 is the not-available face — nothing about the agent', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    act(() => lastSocket().drop(4403));
    await flush();
    expect(
      within(panel()).getByRole('heading', { name: 'This agent isn’t available' }),
    ).toBeTruthy();
    expect(panel().textContent).not.toContain('yue-claude');
  });

  it('a ticket refused not_owner (403) is the same face', async () => {
    routes.ticket = () => json(403, { code: 'not_owner', error: 'x' });
    await mount(undefined, { openAgentId: 'a1' });
    expect(
      within(panel()).getByRole('heading', { name: 'This agent isn’t available' }),
    ).toBeTruthy();
  });

  it('4410 / no_terminal_server: the header stays, the terminal area says why, no button', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    act(() => lastSocket().drop(4410));
    await flush();
    expect(connWord()).toContain('Unavailable');
    expect(panel().textContent).toContain('This agent can’t open a terminal yet');
    expect(within(panel()).getByRole('button', { name: /Hibernate/ })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: /Reconnect|Wake/ })).toBeNull();
  });

  it('an agent whose probe found no terminal server never asks for a ticket', async () => {
    routes.list = () => page([agent({ terminalServer: 'absent' })]);
    await mount(undefined, { openAgentId: 'a1' });
    expect(ticketCalls()).toBe(0);
    expect(panel().textContent).toContain('It was made from an older image');
  });

  it('4401 retries once silently with a new ticket; a second is lost', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    act(() => lastSocket().drop(4401));
    await flush();
    expect(ticketCalls()).toBe(2);
    expect(connWord()).toContain('Connecting…');
    act(() => lastSocket().drop(4401));
    await flush();
    expect(ticketCalls()).toBe(2);
    expect(connWord()).toContain('Disconnected');
  });

  it('4502 runs the reconnect loop, then the lost face in the machine’s words', async () => {
    vi.useFakeTimers();
    routes.ticket = () => json(200, TICKET);
    await mount(undefined, { openAgentId: 'a1' });
    await goLive();
    // Every attempt reaches the relay and the machine does not answer.
    const drops = setInterval(() => {
      const ws = lastSocket();
      if (ws.readyState === 0) ws.drop(4502);
    }, 100);
    act(() => lastSocket().drop(4502));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TERMINAL_RECONNECT_WINDOW_MS + 15_000);
    });
    clearInterval(drops);
    await flush();
    expect(connWord()).toContain('Disconnected');
    expect(screen.getByRole('alert').textContent).toContain(
      'The agent’s machine isn’t answering. Your files are safe in its home.',
    );
  });

  it('taken_over: another tab has the shell — Use it here takes it back', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive('sess-1');
    act(() => ws.frame({ t: 'error', code: 'taken_over' }));
    act(() => ws.drop(1000));
    await flush();
    expect(panel().textContent).toContain(
      'This shell is open in another tab now. One shell answers one tab at a time.',
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Use it here' }));
    await flush();
    const next = lastSocket();
    act(() => next.accept());
    expect(next.frames[1]).toMatchObject({ session: 'sess-1' });
  });

  it('session_limit: four terminals already open elsewhere, Try again', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = lastSocket();
    act(() => ws.accept());
    act(() => ws.frame({ t: 'error', code: 'session_limit' }));
    act(() => ws.drop(1000));
    await flush();
    expect(panel().textContent).toContain(
      'yue-claude already has 4 terminals open in other tabs. Close one there, then try again.',
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Try again' }));
    await flush();
    expect(ticketCalls()).toBe(2);
  });

  it('a refused wake lands inside the panel in the list’s own copy, with Wake', async () => {
    routes.wake = () =>
      json(402, { code: 'agent_instance_start_refused', reason: 'credits', error: 'x' });
    await mount(undefined, { openAgentId: 'a2' });
    const alert = within(panel()).getByRole('alert');
    expect(alert.textContent).toContain('Your organization is out of credits.');
    expect(within(panel()).getByRole('button', { name: 'Wake' })).toBeTruthy();
    expect(ticketCalls()).toBe(0);
  });

  it('Motir is busy: the peach wait box', async () => {
    routes.wake = () =>
      json(429, { code: 'agent_instance_start_refused', reason: 'fleet_busy', error: 'x' });
    await mount(undefined, { openAgentId: 'a2' });
    expect(within(panel()).getByRole('alert').textContent).toContain(
      'Motir is running as many machines as it can right now.',
    );
  });
});

describe('every lifecycle value (panel 4) and wake-then-connect', () => {
  it('opening a hibernated agent wakes it, shows waking, and connects on running — no second click', async () => {
    vi.useFakeTimers();
    let state: AgentInstanceListItemDto['state'] = 'waking';
    routes.list = () => page([agent(), codex({ state })]);
    await mount(page([agent(), codex({ state: 'hibernated' })]), { openAgentId: 'a2' });
    expect(calls()).toContainEqual({
      url: '/api/projects/MOTIR/instances/a2/wake',
      method: 'POST',
    });
    await flush();
    expect(within(panel()).getByText('Waking')).toBeTruthy();
    expect(panel().textContent).toContain('Starting a fresh machine on your home');
    expect(panel().textContent).toContain(
      'The terminal connects by itself when it’s up — nothing to click.',
    );
    expect(within(panel()).queryByTestId('agent-signin')).toBeNull();
    expect(ticketCalls()).toBe(0);

    state = 'running';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();
    expect(ticketCalls()).toBe(1);
    await goLive();
    expect(connWord()).toContain('Live');
    expect(within(panel()).getByRole('button', { name: /Hibernate/ })).toBeTruthy();
  });

  it('not_running from the ticket, on open, is the cue to wake', async () => {
    routes.ticket = () => json(409, { code: 'not_running', error: 'x' });
    await mount(undefined, { openAgentId: 'a1' });
    expect(calls()).toContainEqual({
      url: '/api/projects/MOTIR/instances/a1/wake',
      method: 'POST',
    });
  });

  it('an agent that hibernates while its terminal sits unattended is NOT woken by the panel', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive();
    routes.list = () => page([agent({ state: 'hibernated', stopReason: 'idle' })]);
    act(() => ws.drop(4409));
    await flush();
    expect(calls().some((c) => c.url.endsWith('/wake'))).toBe(false);
    expect(panel().textContent).toContain('yue-claude is hibernated');
    expect(panel().textContent).toContain('Hibernated after 30 minutes without use');
    expect(panel().textContent).toContain('Your files and your sign-in are kept.');
    expect(connWord()).toContain('Closed');
  });

  // Delete… is offered mid-boot and mid-stop since AMENDMENT 4 (MOTIR-7341): a
  // boot or a stop can fail to settle. A delete already under way offers none.
  it.each([
    ['starting', 'Booting — cloning the project’s repositories into the home', 'Waiting', false],
    ['hibernating', 'Stopping the machine — your home stays', 'Closed', false],
    ['deleting', 'Destroying the machine and its home', 'Closed', true],
  ] as const)(
    '%s: the list’s own words, Delete per §4, no Hibernate',
    async (state, words, conn, deleteDisabled) => {
      routes.list = () => page([agent({ state })]);
      await mount(undefined, { openAgentId: 'a1' });
      expect(panel().textContent).toContain(words);
      expect(connWord()).toContain(conn);
      expect(
        (within(panel()).getByRole('button', { name: /Delete…/ }) as HTMLButtonElement).disabled,
      ).toBe(deleteDisabled);
      expect(within(panel()).queryByRole('button', { name: /Hibernate/ })).toBeNull();
      expect(ticketCalls()).toBe(0);
    },
  );

  it('failed: its reason in danger ink, the way out, and Wake', async () => {
    routes.list = () =>
      page([
        agent({
          state: 'failed',
          failureReason: 'The machine could not start: no capacity on its host.',
        }),
      ]);
    await mount(undefined, { openAgentId: 'a1' });
    expect(panel().textContent).toContain('The machine could not start: no capacity on its host.');
    expect(panel().textContent).toContain('Wake to try again, or delete it.');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Wake' }));
    await flush();
    expect(calls()).toContainEqual({
      url: '/api/projects/MOTIR/instances/a1/wake',
      method: 'POST',
    });
  });
});

describe('sign-in status (panel 3, Q7)', () => {
  it('none before the terminal connects; then the pushed state, turning without a reload', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    expect(within(panel()).queryByTestId('agent-signin')).toBeNull();
    expect(panel().textContent).toContain(
      'Your sign-in belongs to Claude Code and stays in this agent’s home. Motir never sees it.',
    );
    const ws = await goLive();
    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'signed_out' }));
    const line = screen.getByTestId('agent-signin');
    expect(line.getAttribute('data-state')).toBe('signed_out');
    expect(line.textContent).toBe(
      'Not signed in — run claude, then /login, in the terminal to sign in',
    );
    expect(within(line).getAllByText(/claude|\/login/, { selector: 'code' })).toHaveLength(2);

    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'signed_in' }));
    expect(screen.getByTestId('agent-signin').textContent).toBe('Signed in to Claude Code');
    expect(screen.getByTestId('agent-signin').className).toContain('--el-tint-mint');
  });

  it('a coding agent with no checkable file says it can’t tell — never a tick', async () => {
    routes.list = () =>
      page([agent({ id: 'k1', name: 'old-box', profileId: 'kimi', profileName: 'Kimi Code' })]);
    await mount(undefined, { openAgentId: 'k1' });
    const ws = await goLive();
    act(() => ws.frame({ t: 'signin', profile: 'kimi', state: 'unknown' }));
    const line = screen.getByTestId('agent-signin');
    expect(line.getAttribute('data-state')).toBe('unknown');
    expect(line.textContent).toContain('Sign-in status can’t be checked for Kimi Code');
    expect(line.textContent).toContain(
      'To sign in, run kimi in the terminal and follow its sign-in.',
    );
  });

  it('Codex names its own command', async () => {
    routes.list = () => page([codex()]);
    await mount(undefined, { openAgentId: 'a2' });
    const ws = await goLive();
    act(() => ws.frame({ t: 'signin', profile: 'codex', state: 'signed_out' }));
    expect(screen.getByTestId('agent-signin').textContent).toBe(
      'Not signed in — run codex login --device-auth in the terminal to sign in',
    );
  });

  // MOTIR-7062: the lane measures the header now — the turn settling, and every
  // profile's own words (or the generic ones for a profile the table does not know).
  it('the mint turn lands once, then settles to plain ink', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const ws = await goLive();
    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'signed_out' }));
    vi.useFakeTimers();
    act(() => ws.frame({ t: 'signin', profile: 'claude', state: 'signed_in' }));
    expect(screen.getByTestId('agent-signin').className).toContain('--el-tint-mint');
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByTestId('agent-signin').className).not.toContain('--el-tint-mint');
    expect(screen.getByTestId('agent-signin').textContent).toBe('Signed in to Claude Code');
  });

  it.each([
    [
      'opencode',
      'OpenCode',
      'signed_out',
      'Not signed in — run opencode auth login in the terminal to sign in',
    ],
    // A checkable sentence is only for the three that have one; Kimi signed out is generic.
    ['kimi', 'Kimi Code', 'signed_out', 'Not signed in — sign in to Kimi Code in the terminal'],
    ['cursor', 'Cursor', 'signed_out', 'Not signed in — sign in to Cursor in the terminal'],
    [
      'aider',
      'Aider',
      'unknown',
      'Sign-in status can’t be checked for AiderAider uses your model provider’s key: add ANTHROPIC_API_KEY=… (or your provider’s) to ~/.env.',
    ],
    [
      'goose',
      'Goose',
      'unknown',
      'Sign-in status can’t be checked for GooseTo add your model provider’s key, run goose configure in the terminal.',
    ],
    [
      'cursor',
      'Cursor',
      'unknown',
      'Sign-in status can’t be checked for CursorTo sign in, start Cursor in the terminal and follow its sign-in.',
    ],
  ])('%s, %s: %s names its own way in', async (profileId, profileName, state, words) => {
    routes.list = () => page([agent({ id: 'p1', profileId, profileName })]);
    await mount(undefined, { openAgentId: 'p1' });
    const ws = await goLive();
    act(() => ws.frame({ t: 'signin', profile: profileId, state }));
    const line = screen.getByTestId('agent-signin');
    expect(line.getAttribute('data-state')).toBe(state);
    expect(line.textContent).toBe(words);
  });
});

describe('the header’s mutations update the list too (page-state contract)', () => {
  it('Hibernate posts its route and the list re-reads — the row and the pill both move', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    await goLive();
    routes.list = () => page([agent({ state: 'hibernating' }), codex({ state: 'hibernated' })]);
    fireEvent.click(within(panel()).getByRole('button', { name: /Hibernate/ }));
    await flush();
    expect(calls()).toContainEqual({
      url: '/api/projects/MOTIR/instances/a1/hibernate',
      method: 'POST',
    });
    const card = within(screen.getByTestId('agent-list-column')).getAllByRole('listitem')[0]!;
    expect(card.textContent).toContain('Hibernating');
    expect(within(panel()).getAllByText('Hibernating').length).toBeGreaterThan(0);
    expect(panel().textContent).toContain('Stopping the machine — your home stays');
  });

  it('Delete… reuses the page’s confirmation; on success the panel closes and the list keeps the row in Deleting', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    fireEvent.click(within(panel()).getByRole('button', { name: /Delete…/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete yue-claude?');
    routes.list = () => page([agent({ state: 'deleting' }), codex({ state: 'hibernated' })]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));
    await flush();
    expect(calls()).toContainEqual({ url: '/api/projects/MOTIR/instances/a1', method: 'DELETE' });
    expect(screen.queryByTestId('agent-panel')).toBeNull();
    expect(window.location.search).toBe('');
    expect(screen.getAllByTestId('agent-row')[0]!.textContent).toContain('Deleting');
  });
});

describe('the narrow width (panel 7)', () => {
  it('the terminal area keeps a floor of its own, so a tall read-out above the tab strip cannot collapse it (MOTIR-8845)', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const body = within(panel()).getByTestId('agent-terminal-body');
    expect(body.className).toContain('min-h-40');
    expect(body.className).not.toContain('min-h-0');
  });

  it('the panel carries the ← My agents crumb that returns to the list; the list column hides below 1024px', async () => {
    await mount(undefined, { openAgentId: 'a1' });
    const crumb = within(panel()).getByRole('button', { name: 'My agents' });
    // Shown only below the two-column width (a container query on the room).
    expect(crumb.className).toContain('@5xl:hidden');
    expect(screen.getByTestId('agent-list-column').parentElement!.className).toContain(
      'hidden min-w-0 @5xl:block',
    );
    fireEvent.click(crumb);
    await flush();
    expect(screen.queryByTestId('agent-panel')).toBeNull();
  });
});

describe('zh', () => {
  it('renders the panel in Chinese from the zh catalog', async () => {
    routes.list = () => page([agent({ state: 'waking' })]);
    await mount(routes.list(), { openAgentId: 'a1', messages: zhMessages });
    expect(panel().textContent).toContain('正在你的主目录上启动一台新机器');
    expect(panel().textContent).toContain('机器启动后终端会自动连接——无需点击。');
    expect(within(panel()).getByRole('button', { name: '关闭 yue-claude' })).toBeTruthy();
  });
});

describe('the boot read-out in the panel (MOTIR-7400)', () => {
  const at = (s: number) =>
    new Date(Date.parse('2026-09-29T10:00:00.000Z') + s * 1000).toISOString();
  const bootDto = (outcome: string | null, failed = false) => ({
    attempt: 1,
    kind: 'create',
    startedAt: at(0),
    endedAt: outcome ? at(30) : null,
    outcome,
    seq: 8,
    steps: [
      {
        seq: 7,
        ordinal: 0,
        step: 'provision',
        repository: null,
        state: 'done',
        startedAt: at(0),
        endedAt: at(3),
        detail: null,
      },
      {
        seq: 8,
        ordinal: 1,
        step: 'machine_start',
        repository: null,
        state: failed ? 'failed' : 'in_progress',
        startedAt: at(3),
        endedAt: failed ? at(30) : null,
        detail: failed ? 'exit code 0' : null,
      },
      {
        seq: 5,
        ordinal: 2,
        step: 'ready',
        repository: null,
        state: 'waiting',
        startedAt: null,
        endedAt: null,
        detail: null,
      },
    ],
  });
  const snapshot = (b: unknown) => [`event: snapshot\ndata: ${JSON.stringify(b)}\n\n`];

  it('a booting agent shows its steps above the tabs, and the area under them only points to the terminal', async () => {
    routes.list = () => page([agent({ state: 'starting' })]);
    routes.boot = () => snapshot(bootDto(null));
    await mount(undefined, { openAgentId: 'a1' });
    const readout = await screen.findByTestId('agent-boot');
    expect(readout.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('The terminal opens here as soon as the agent is up.')).toBeTruthy();
  });

  it('an agent the row menu already woke shows its boot, not a refusal, when its panel opens on a stale row (MOTIR-7393)', async () => {
    // The list the row was clicked on still read hibernated, so opening it woke
    // it again; the server answers that second wake with a state conflict.
    routes.wake = () => json(409, { code: 'agent_instance_state_conflict', error: 'x' });
    routes.list = () => page([agent({ state: 'waking' })]);
    routes.boot = () => snapshot(bootDto(null));
    await mount(page([agent({ state: 'hibernated' })]), { openAgentId: 'a1' });
    expect(calls()).toContainEqual({
      url: '/api/projects/MOTIR/instances/a1/wake',
      method: 'POST',
    });
    expect(await screen.findByTestId('agent-boot')).toBeTruthy();
    expect(within(panel()).queryByRole('alert')).toBeNull();
  });

  it('a state conflict on an agent that is still not booting keeps its refusal', async () => {
    routes.wake = () => json(409, { code: 'agent_instance_state_conflict', error: 'x' });
    routes.list = () => page([agent({ state: 'hibernated' })]);
    await mount(page([agent({ state: 'hibernated' })]), { openAgentId: 'a1' });
    expect(within(panel()).getByRole('alert')).toBeTruthy();
  });

  it('waiting for room (MOTIR-9475): the header reads Waiting, the Terminal tab is disabled with its reason, and no ticket is asked', async () => {
    const base = bootDto(null);
    const waiting = {
      ...base,
      steps: [
        {
          ...base.steps[0]!,
          state: 'in_progress',
          endedAt: null,
          detail: 'waiting_for_room:pool',
          waiting: { reason: 'pool', since: at(0) },
        },
        { ...base.steps[1]!, state: 'waiting', startedAt: null },
        base.steps[2]!,
      ],
    };
    routes.list = () => page([agent({ state: 'starting' })]);
    routes.boot = () => snapshot(waiting);
    await mount(undefined, { openAgentId: 'a1' });
    await screen.findByTestId('agent-boot');
    const tab = await screen.findByTestId('agent-terminal-tab-disabled');
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    const tip = document.getElementById(tab.getAttribute('aria-describedby')!)!;
    expect(tip.textContent).toBe(
      'The terminal opens once the agent is running. It’s waiting for room.',
    );
    expect(within(panel()).getAllByText('Waiting').length).toBeGreaterThan(0);
    expect(ticketCalls()).toBe(0);
  });

  it('a boot not waiting for room keeps its Terminal tab', async () => {
    routes.list = () => page([agent({ state: 'starting' })]);
    routes.boot = () => snapshot(bootDto(null));
    await mount(undefined, { openAgentId: 'a1' });
    await screen.findByTestId('agent-boot');
    expect(screen.queryByTestId('agent-terminal-tab-disabled')).toBeNull();
  });

  it('a failed boot says the terminal stays closed, and its Delete… opens the delete confirmation', async () => {
    routes.list = () => page([agent({ state: 'failed', failureReason: 'exited' })]);
    routes.boot = () => [
      ...snapshot(bootDto('failed', true)),
      'event: done\ndata: {"state":"failed","seq":8}\n\n',
    ];
    await mount(undefined, { openAgentId: 'a1' });
    const readout = await screen.findByTestId('agent-boot');
    expect(
      screen.getAllByText('The terminal stays closed until the agent is running.').length,
    ).toBeGreaterThan(0);
    fireEvent.click(within(readout).getByRole('button', { name: /Delete/ }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
  });
});
