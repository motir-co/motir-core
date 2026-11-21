import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_SOCKET,
  CONTROL_SOCKET_ENV,
  ControlUnavailableError,
  controlRequest,
  listenControl,
  isRunId,
  isWorkItemKey,
  parseControlRequest,
  type ControlRequest,
  runStateDir,
  runWorkspaceDir,
} from '../../src/agentTerminal/control.js';
import { checkSignIn } from '../../src/agentTerminal/signIn.js';
import {
  AGENT_RUN_ENV,
  RUN_STOP_GRACE_MS,
  signalProcessGroup,
  type SignalGroup,
} from '../../src/agentTerminal/server.js';
import {
  agentTerminalRunCommand,
  agentTerminalSignInCommand,
  agentTerminalStatusCommand,
  agentTerminalStopCommand,
  readStdinBounded,
} from '../../src/commands/agentTerminal.js';
import { CliError } from '../../src/errors.js';
import { HOSTED_STATE_ENV } from '../../src/hostedGit.js';
import { buildProgram } from '../../src/program.js';
import { startHarness, type Client, type FakePty, type Harness } from './harness.js';

// The run launcher (MOTIR-7025 · `docs/decisions/agent-instance-run.md` §1, §2,
// §4): a run-tagged session the terminal server opens on a LOCAL control
// request, `stop` and `status` for it, the sign-in and image-capability probes,
// and the run token's path stdin → a 0600 file, never argv, env or the socket.

const CLI = ['node', '/opt/motir/cli.js'];
const HOME = '/home/agent-test';
const TOKEN = 'mtr_run_SECRET-TOKEN-7025';
const API = 'https://motir.example';

let harness: Harness | null = null;
const clients: Client[] = [];
const temps: string[] = [];

function temp(prefix = 'mtr-7025-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface RunHarness extends Harness {
  signals: { pid: number; signal: NodeJS.Signals }[];
  removed: string[];
  socket: string;
}

/** A harness whose fake PTYs answer signals the way a process group would. */
async function start(
  options: { stopGraceMs?: number; ignoreTerm?: boolean; ignoreAll?: boolean } = {},
): Promise<RunHarness> {
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const removed: string[] = [];
  let ptys: FakePty[] = [];
  const signalGroup: SignalGroup = (pid, signal) => {
    signals.push({ pid, signal });
    if (options.ignoreAll) return;
    if (signal === 'SIGTERM' && options.ignoreTerm) return;
    const pty = ptys.find((candidate) => candidate.pid === pid);
    pty?.exit(null, signal === 'SIGKILL' ? 9 : 15);
  };
  const h = await startHarness({
    env: { HOME, MOTIR_SANDBOX_AGENT: 'kimi', MOTIR_TERMINAL_KEY: 'k', PATH: '/usr/bin' },
    cli: CLI,
    signalGroup,
    removeDir: (path) => removed.push(path),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
  });
  ptys = h.ptys;
  const socket = join(temp('mtr-ctl-'), 'ctl', 'control.sock');
  await h.terminal.listenControl(socket);
  harness = h;
  return { ...h, signals, removed, socket };
}

async function connect(h: Harness): Promise<Client> {
  const client = await h.connect();
  clients.push(client);
  return client;
}

async function openShell(h: Harness): Promise<{ client: Client; session: string }> {
  const client = await connect(h);
  client.sendJson({ t: 'open', cols: 80, rows: 24 });
  const ready = await client.frame('ready');
  return { client, session: ready['session'] as string };
}

async function startRun(h: Harness, runId = 'run_1', key = 'MOTIR-7025'): Promise<string> {
  const response = await h.terminal.control({ op: 'run', runId, workItemKey: key });
  expect(response).toMatchObject({ ok: true });
  return (response as { session: string }).session;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await harness?.terminal.close();
  harness = null;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the run session the server opens', () => {
  it('runs `motir run <KEY> --run-id <id>` in agent mode, pointed at its private dirs — and carries no token', async () => {
    const h = await start();
    const session = await startRun(h);
    const pty = h.ptys[0]!;
    expect(pty.options.file).toBe('node');
    expect(pty.options.args).toEqual([
      '/opt/motir/cli.js',
      'run',
      'MOTIR-7025',
      '--run-id',
      'run_1',
    ]);
    expect(pty.options.env[HOSTED_STATE_ENV]).toBe(runStateDir('run_1'));
    expect(pty.options.env[AGENT_RUN_ENV]).toBe('1');
    expect(pty.options.env['MOTIR_WORKSPACE']).toBe(runWorkspaceDir(HOME, 'run_1'));
    expect(pty.options.env['MOTIR_TERMINAL_KEY']).toBeUndefined();
    expect(pty.options.cwd).toBe(HOME);
    expect(h.terminal.sessionCount()).toBe(1);
    expect(h.logs).toContain(
      `agent-terminal: run run_1 (run) session ${session} opened (pid ${pty.pid})`,
    );
  });

  it('refuses a second run while one is live, then reports it exited with its code', async () => {
    const h = await start();
    const session = await startRun(h);
    expect(await h.terminal.control({ op: 'run', runId: 'run_2', workItemKey: 'MOTIR-1' })).toEqual(
      {
        ok: false,
        code: 'run_active',
      },
    );
    expect(await h.terminal.control({ op: 'run', runId: 'run_1', workItemKey: 'MOTIR-1' })).toEqual(
      {
        ok: false,
        code: 'run_active',
      },
    );
    expect(h.ptys).toHaveLength(1);
    expect(await h.terminal.control({ op: 'status', runId: 'run_1' })).toEqual({
      ok: true,
      state: 'running',
      session,
    });

    h.ptys[0]!.exit(3, null);
    expect(await h.terminal.control({ op: 'status', runId: 'run_1' })).toEqual({
      ok: true,
      state: 'exited',
      session,
      exitCode: 3,
      signal: null,
    });
    // However it ends, its credentials and its checkouts go with it.
    expect(h.removed).toEqual([runStateDir('run_1'), runWorkspaceDir(HOME, 'run_1')]);
    expect(await h.terminal.control({ op: 'status', runId: 'nope' })).toEqual({
      ok: true,
      state: 'not_found',
    });
    // Once it has ended, the next run may start.
    await startRun(h, 'run_2');
  });

  it('refuses in words when the run cannot spawn, and removes its state dir', async () => {
    const h = await start();
    const failing = await startHarness({
      cli: CLI,
      spawnPty: () => {
        throw new Error('no such file');
      },
      removeDir: (path) => h.removed.push(path),
    });
    try {
      expect(
        await failing.terminal.control({ op: 'run', runId: 'r9', workItemKey: 'A-1' }),
      ).toEqual({
        ok: false,
        code: 'spawn_failed',
      });
      expect(h.removed).toEqual([runStateDir('r9')]);
      expect(failing.logs).toContain('agent-terminal: run r9 (run) failed to start');
    } finally {
      await failing.terminal.close();
    }
  });

  it('forgets the oldest exited runs past sixteen', async () => {
    const h = await start();
    for (let i = 0; i < 18; i++) {
      await startRun(h, `r${i}`);
      h.ptys[i]!.exit(0, null);
    }
    expect(await h.terminal.control({ op: 'status', runId: 'r0' })).toEqual({
      ok: true,
      state: 'not_found',
    });
    expect(await h.terminal.control({ op: 'status', runId: 'r17' })).toMatchObject({
      state: 'exited',
      exitCode: 0,
    });
  });
});

describe('run-session edges', () => {
  it('re-enters this CLI by default, and falls back to / with no HOME', async () => {
    const other = await startHarness({ env: {} });
    try {
      await other.terminal.control({ op: 'run', runId: 'd1', workItemKey: 'A-1' });
      const options = other.ptys[0]!.options;
      expect(options.file).toBe(process.execPath);
      expect(options.args.slice(-4)).toEqual(['run', 'A-1', '--run-id', 'd1']);
      expect(options.env['MOTIR_WORKSPACE']).toBe('/.motir/runs/d1');
    } finally {
      await other.terminal.close();
    }
  });

  it('refuses to start a run once the server is closing', async () => {
    const h = await start();
    await h.terminal.close();
    harness = null;
    expect(await h.terminal.control({ op: 'run', runId: 'late', workItemKey: 'A-1' })).toEqual({
      ok: false,
      code: 'spawn_failed',
    });
  });

  it('a run that exits on its own during the grace period cancels the SIGKILL', async () => {
    const h = await start({ stopGraceMs: 200, ignoreTerm: true });
    await startRun(h);
    const stopping = h.terminal.control({ op: 'stop', runId: 'run_1' });
    h.ptys[0]!.exit(0, null);
    expect(await stopping).toEqual({ ok: true, result: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(h.signals.map((entry) => entry.signal)).toEqual(['SIGTERM']);
  });
});

describe('stop', () => {
  it('sends SIGTERM to the process group, and answers stopped once it has exited', async () => {
    const h = await start();
    await startRun(h);
    expect(await h.terminal.control({ op: 'stop', runId: 'run_1' })).toEqual({
      ok: true,
      result: 'stopped',
    });
    expect(h.signals).toEqual([{ pid: h.ptys[0]!.pid, signal: 'SIGTERM' }]);
    expect(await h.terminal.control({ op: 'status', runId: 'run_1' })).toMatchObject({
      state: 'exited',
      signal: 15,
    });
    // Stopping it again is still success.
    expect(await h.terminal.control({ op: 'stop', runId: 'run_1' })).toEqual({
      ok: true,
      result: 'stopped',
    });
  });

  it('SIGKILLs after the grace period when SIGTERM is ignored', async () => {
    const h = await start({ stopGraceMs: 30, ignoreTerm: true });
    await startRun(h);
    expect(await h.terminal.control({ op: 'stop', runId: 'run_1' })).toEqual({
      ok: true,
      result: 'stopped',
    });
    const pid = h.ptys[0]!.pid;
    expect(h.signals).toEqual([
      { pid, signal: 'SIGTERM' },
      { pid, signal: 'SIGKILL' },
    ]);
    expect(h.logs).toContain('agent-terminal: run run_1 (run) killed (grace elapsed)');
    expect(await h.terminal.control({ op: 'status', runId: 'run_1' })).toMatchObject({
      state: 'exited',
      signal: 9,
    });
  });

  it('answers after a bounded wait even when nothing kills the process', async () => {
    const h = await start({ stopGraceMs: 1, ignoreAll: true });
    await startRun(h);
    const started = Date.now();
    expect(await h.terminal.control({ op: 'stop', runId: 'run_1' })).toEqual({
      ok: true,
      result: 'stopped',
    });
    expect(Date.now() - started).toBeLessThan(RUN_STOP_GRACE_MS);
  }, 10_000);

  it('is a no-op success for a run it does not know', async () => {
    const h = await start();
    expect(await h.terminal.control({ op: 'stop', runId: 'ghost' })).toEqual({
      ok: true,
      result: 'not_found',
    });
    expect(h.signals).toEqual([]);
  });

  it('closing the server releases a waiting stop', async () => {
    const h = await start({ ignoreAll: true });
    await startRun(h);
    const stopping = h.terminal.control({ op: 'stop', runId: 'run_1' });
    await h.terminal.close();
    harness = null;
    expect(await stopping).toEqual({ ok: true, result: 'stopped' });
  });
});

describe('the run session and the four shells', () => {
  it('starts with four person shells open, and a fifth shell reaps a PERSON’s detached shell, never the run', async () => {
    const h = await start();
    const shells = [];
    for (let i = 0; i < 4; i++) shells.push(await openShell(h));
    await startRun(h);
    const runPty = h.ptys[4]!;
    expect(h.terminal.sessionCount()).toBe(5);

    shells[1]!.client.close();
    await shells[1]!.client.closed();
    const fifth = await openShell(h);
    expect(fifth.session).toBeDefined();
    expect(h.ptys[1]!.killed).toBe(true);
    expect(runPty.killed).toBe(false);
    expect(await h.terminal.control({ op: 'status', runId: 'run_1' })).toMatchObject({
      state: 'running',
    });
  });

  it('with four attached shells, a fifth is still refused — the run does not free a slot', async () => {
    const h = await start();
    for (let i = 0; i < 4; i++) await openShell(h);
    await startRun(h);
    const fifth = await connect(h);
    fifth.sendJson({ t: 'open', cols: 80, rows: 24 });
    expect(await fifth.frame('error')).toEqual({ t: 'error', code: 'session_limit' });
  });
});

describe('a person watches the run', () => {
  it('lists the run session on attach, and attaching to it replays its output', async () => {
    const h = await start();
    const runSession = await startRun(h);
    h.ptys[0]!.emitData('cloning MOTIR-7025…\r\n');

    const shell = await openShell(h);
    const listed = await shell.client.frame('sessions');
    expect(listed).toEqual({
      t: 'sessions',
      sessions: [
        { session: runSession, kind: 'run', runId: 'run_1' },
        { session: shell.session, kind: 'shell' },
      ],
    });

    const watcher = await connect(h);
    watcher.sendJson({ t: 'open', cols: 100, rows: 30, session: runSession });
    expect(await watcher.frame('ready')).toEqual({
      t: 'ready',
      session: runSession,
      resumed: true,
      kind: 'run',
      runId: 'run_1',
    });
    await watcher.until(() => watcher.output().includes('cloning MOTIR-7025'));
    h.ptys[0]!.emitData('agent started\r\n');
    await watcher.until(() => watcher.output().includes('agent started'));
    // Resize applies to the run's PTY.
    expect(h.ptys[0]!.sizes).toContainEqual({ cols: 100, rows: 30 });
  });

  it('is watch-only: typed input never reaches the run', async () => {
    const h = await start();
    const runSession = await startRun(h);
    const watcher = await connect(h);
    watcher.sendJson({ t: 'open', cols: 80, rows: 24, session: runSession });
    await watcher.frame('ready');
    watcher.sendBytes('rm -rf /\r');
    watcher.sendJson({ t: 'resize', cols: 90, rows: 20 });
    await watcher.until(() => h.ptys[0]!.sizes.some((size) => size.cols === 90));
    expect(h.ptys[0]!.written).toEqual([]);
  });

  it('tells attached connections when the run opens and when it ends', async () => {
    const h = await start();
    const shell = await openShell(h);
    const runSession = await startRun(h);
    expect(await shell.client.frame('sessions')).toEqual({
      t: 'sessions',
      sessions: [
        { session: shell.session, kind: 'shell' },
        { session: runSession, kind: 'run', runId: 'run_1' },
      ],
    });
    h.ptys[1]!.exit(0, null);
    expect(await shell.client.frame('sessions', 1)).toEqual({
      t: 'sessions',
      sessions: [{ session: shell.session, kind: 'shell' }],
    });
  });

  it('a shell attached with no run is sent no session list (the frames it always got)', async () => {
    const h = await start();
    const shell = await openShell(h);
    shell.client.sendJson({ t: 'ping', active: true });
    await shell.client.frame('pong');
    expect(shell.client.frames.map((frame) => frame['t'])).toEqual(['ready', 'signin', 'pong']);
  });
});

describe('the control socket', () => {
  it('lives in a 0700 directory and answers one JSON line per connection', async () => {
    const h = await start();
    const dir = join(h.socket, '..');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(await controlRequest(h.socket, { op: 'status', runId: 'x' }, 2000)).toEqual({
      ok: true,
      state: 'not_found',
    });
    expect(h.logs).toContain('agent-terminal: control socket listening');
  });

  it('answers bad_request to a malformed request', async () => {
    const h = await start();
    const { connect: netConnect } = await import('node:net');
    const answer = await new Promise<string>((resolve) => {
      const socket = netConnect(h.socket, () => socket.end('{"op":"run","runId":"../../etc"}\n'));
      let text = '';
      socket.on('data', (chunk) => (text += chunk.toString()));
      socket.on('end', () => resolve(text));
    });
    expect(JSON.parse(answer)).toEqual({ ok: false, code: 'bad_request' });
  });

  it('refuses unavailable when nothing listens', async () => {
    await expect(
      controlRequest(join(temp(), 'absent.sock'), { op: 'status', runId: 'x' }, 2000),
    ).rejects.toBeInstanceOf(ControlUnavailableError);
  });

  it('removes its socket file on close', async () => {
    const h = await start();
    expect(existsSync(h.socket)).toBe(true);
    await h.terminal.close();
    harness = null;
    expect(existsSync(h.socket)).toBe(false);
  });

  it('answers bad_request to an oversized request, and to a handler that throws', async () => {
    const path = join(temp('mtr-ctl-'), 'c.sock');
    const control = await listenControl(path, async () => {
      throw new Error('handler bug');
    });
    const { connect: netConnect } = await import('node:net');
    const exchange = (payload: Buffer | string, end: boolean): Promise<string> =>
      new Promise((resolve) => {
        const socket = netConnect(path, () => {
          if (end) socket.end(payload);
          else socket.write(payload);
        });
        let text = '';
        socket.on('data', (chunk) => (text += chunk.toString()));
        socket.on('end', () => resolve(text));
      });
    try {
      // No newline, and ended: the whole stream is the request.
      expect(JSON.parse(await exchange('{"op":"stop","runId":"a"}', true))).toEqual({
        ok: false,
        code: 'bad_request',
      });
      expect(JSON.parse(await exchange(Buffer.alloc(20 * 1024, 0x61), false))).toEqual({
        ok: false,
        code: 'bad_request',
      });
    } finally {
      await control.close();
    }
  });

  it('treats a server that answers garbage, nothing, or too late as unavailable', async () => {
    const { createServer } = await import('node:net');
    const dir = temp('mtr-ctl-');
    const serve = (path: string, onLine: (socket: import('node:net').Socket) => void) =>
      new Promise<import('node:net').Server>((resolve) => {
        const server = createServer((socket) => socket.once('data', () => onLine(socket)));
        server.listen(path, () => resolve(server));
      });
    const garbage = await serve(join(dir, 'g.sock'), (socket) => socket.end('not json\n'));
    const silent = await serve(join(dir, 's.sock'), (socket) => socket.end());
    const slow = await serve(join(dir, 'w.sock'), () => undefined);
    try {
      for (const [name, timeout] of [
        ['g.sock', 2000],
        ['s.sock', 2000],
        ['w.sock', 50],
      ] as const) {
        await expect(
          controlRequest(join(dir, name), { op: 'status', runId: 'x' }, timeout),
        ).rejects.toBeInstanceOf(ControlUnavailableError);
      }
    } finally {
      for (const server of [garbage, silent, slow]) server.close();
    }
  });

  it('defaults to /tmp/motir-agent-terminal/control.sock', () => {
    expect(CONTROL_SOCKET).toBe('/tmp/motir-agent-terminal/control.sock');
    expect(runStateDir('abc')).toBe('/tmp/motir-run-abc');
    expect(runWorkspaceDir('/home/node', 'abc')).toBe('/home/node/.motir/runs/abc');
  });

  it('parses only well-formed requests', () => {
    expect(parseControlRequest('{"op":"stop","runId":"a"}')).toEqual({ op: 'stop', runId: 'a' });
    expect(parseControlRequest('{"op":"status","runId":"a"}')).toEqual({
      op: 'status',
      runId: 'a',
    });
    // An absent command is today's `run` (an older launcher sends none).
    expect(parseControlRequest('{"op":"run","runId":"a","workItemKey":"ACME-7"}')).toEqual({
      op: 'run',
      runId: 'a',
      workItemKey: 'ACME-7',
      command: 'run',
    });
    expect(
      parseControlRequest('{"op":"run","runId":"a","workItemKey":"ACME-7","command":"fix"}'),
    ).toEqual({ op: 'run', runId: 'a', workItemKey: 'ACME-7', command: 'fix' });
    expect(
      parseControlRequest('{"op":"run","runId":"a","workItemKey":"ACME-7","command":"continue"}'),
    ).toMatchObject({ command: 'continue' });
    // A review in the person's own agent (MOTIR-11953).
    expect(
      parseControlRequest('{"op":"run","runId":"a","workItemKey":"ACME-7","command":"review"}'),
    ).toMatchObject({ command: 'review' });
    // A command outside the set is a bad request, so the server spawns nothing.
    for (const command of ['run_scope', 'nope', '', 7, null]) {
      expect(
        parseControlRequest(
          JSON.stringify({ op: 'run', runId: 'a', workItemKey: 'ACME-7', command }),
        ),
      ).toBeNull();
    }
    for (const bad of [
      'not json',
      '[]',
      'null',
      '{"op":"run","runId":"a"}',
      '{"op":"run","runId":"a","workItemKey":"x; rm"}',
      '{"op":"launch","runId":"a"}',
      '{"op":"stop","runId":"a/b"}',
    ]) {
      expect(parseControlRequest(bad)).toBeNull();
    }
    expect(isRunId('cmun_1-x')).toBe(true);
    expect(isRunId('')).toBe(false);
    expect(isWorkItemKey('MOTIR-7025')).toBe(true);
    expect(isWorkItemKey('MOTIR-0')).toBe(false);
  });
});

// ── The CLI surface Motir `exec`s ───────────────────────────────────────────

function output(): { lines: unknown[]; write: (text: string) => void } {
  const lines: unknown[] = [];
  return { lines, write: (text) => lines.push(JSON.parse(text)) };
}

describe('motir agent-terminal run --command (MOTIR-9045)', () => {
  const asks = async (opts: { command?: string }) => {
    const stateRoot = temp();
    const sent: ControlRequest[] = [];
    await agentTerminalRunCommand(
      'motir-1',
      { runId: 'run_c', ...opts },
      {
        env: { [CONTROL_SOCKET_ENV]: '/nowhere' },
        readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
        stateDir: (runId) => join(stateRoot, runId),
        stdout: () => undefined,
        request: async (_path, request) => {
          sent.push(request);
          return { ok: true, session: 's1' };
        },
      },
    );
    return sent;
  };

  it('puts a fix or a continue on the control request', async () => {
    expect(await asks({ command: 'fix' })).toEqual([
      { op: 'run', runId: 'run_c', workItemKey: 'MOTIR-1', command: 'fix' },
    ]);
    expect(await asks({ command: 'continue' })).toEqual([
      { op: 'run', runId: 'run_c', workItemKey: 'MOTIR-1', command: 'continue' },
    ]);
  });

  it('sends today’s request byte for byte for a plain run, with or without the flag', async () => {
    const plain = { op: 'run', runId: 'run_c', workItemKey: 'MOTIR-1' };
    expect(await asks({})).toEqual([plain]);
    const [flagged] = await asks({ command: 'run' });
    expect(flagged).toEqual(plain);
    expect(Object.keys(flagged as object)).not.toContain('command');
  });

  it('refuses a command outside the four before any state or socket is touched', async () => {
    const stateRoot = temp();
    let asked = 0;
    const err = await agentTerminalRunCommand(
      'MOTIR-1',
      { runId: 'run_c', command: 'nope' },
      {
        env: { [CONTROL_SOCKET_ENV]: '/nowhere' },
        readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
        stateDir: (runId) => join(stateRoot, runId),
        stdout: () => undefined,
        request: async () => {
          asked += 1;
          return { ok: true, session: 's1' };
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe('--command must be one of run, fix, continue, review.');
    expect(asked).toBe(0);
    expect(existsSync(join(stateRoot, 'run_c'))).toBe(false);
  });
});

describe('motir agent-terminal run', () => {
  it('returns the session id within 2 seconds, with the token in a 0600 run.json — never in argv or env', async () => {
    const h = await start();
    const stateRoot = temp();
    const out = output();
    const started = Date.now();
    const session = await agentTerminalRunCommand(
      'MOTIR-7025',
      { runId: 'run_1' },
      {
        env: { [CONTROL_SOCKET_ENV]: h.socket },
        readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
        stateDir: (runId) => join(stateRoot, `motir-run-${runId}`),
        stdout: out.write,
      },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.lines).toEqual([{ session }]);
    // The run lives on after the command returned.
    expect(await h.terminal.control({ op: 'status', runId: 'run_1' })).toMatchObject({
      state: 'running',
    });

    const dir = join(stateRoot, 'motir-run-run_1');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const runFile = join(dir, 'run.json');
    expect(statSync(runFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(runFile, 'utf8'))).toEqual({
      apiUrl: API,
      runId: 'run_1',
      token: TOKEN,
    });

    const spawned = h.ptys[0]!.options;
    expect(JSON.stringify(spawned.args)).not.toContain(TOKEN);
    expect(JSON.stringify(spawned.env)).not.toContain(TOKEN);
    expect(h.logs.join('\n')).not.toContain(TOKEN);
  });

  it('refuses run_active in words, prints the code, and leaves no state behind', async () => {
    const h = await start();
    await startRun(h, 'run_live');
    const stateRoot = temp();
    const out = output();
    const err = await agentTerminalRunCommand(
      'MOTIR-2',
      { runId: 'run_2' },
      {
        env: { [CONTROL_SOCKET_ENV]: h.socket },
        readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
        stateDir: (runId) => join(stateRoot, runId),
        stdout: out.write,
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe('A run is already running in this agent.');
    expect(out.lines).toEqual([{ error: 'run_active' }]);
    expect(existsSync(join(stateRoot, 'run_2'))).toBe(false);
  });

  it('refuses a directory a LIVE run of the same id owns, without touching it', async () => {
    const h = await start();
    await startRun(h, 'run_1');
    const stateRoot = temp();
    const dir = join(stateRoot, 'run_1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'run.json'), 'LIVE');
    const out = output();
    await expect(
      agentTerminalRunCommand(
        'MOTIR-1',
        { runId: 'run_1' },
        {
          env: { [CONTROL_SOCKET_ENV]: h.socket },
          readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
          stateDir: () => dir,
          stdout: out.write,
        },
      ),
    ).rejects.toThrow('A run is already running in this agent.');
    expect(readFileSync(join(dir, 'run.json'), 'utf8')).toBe('LIVE');
    expect(out.lines).toEqual([{ error: 'run_active' }]);
  });

  it('replaces a stale directory left by a run that is not live', async () => {
    const h = await start();
    const stateRoot = temp();
    const dir = join(stateRoot, 'run_9');
    mkdirSync(dir);
    writeFileSync(join(dir, 'leftover'), 'x');
    await agentTerminalRunCommand(
      'MOTIR-9',
      { runId: 'run_9' },
      {
        env: { [CONTROL_SOCKET_ENV]: h.socket },
        readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
        stateDir: () => dir,
        stdout: () => undefined,
      },
    );
    expect(existsSync(join(dir, 'leftover'))).toBe(false);
    expect(existsSync(join(dir, 'run.json'))).toBe(true);
  });

  it('says server_unavailable when no server answers, and removes the state it wrote', async () => {
    const stateRoot = temp();
    const out = output();
    await expect(
      agentTerminalRunCommand(
        'MOTIR-1',
        { runId: 'run_1' },
        {
          env: { [CONTROL_SOCKET_ENV]: join(stateRoot, 'none.sock') },
          readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
          stateDir: (runId) => join(stateRoot, runId),
          stdout: out.write,
        },
      ),
    ).rejects.toThrow('The agent’s terminal server is not answering.');
    expect(out.lines).toEqual([{ error: 'server_unavailable' }]);
    expect(existsSync(join(stateRoot, 'run_1'))).toBe(false);
  });

  it('maps a spawn failure and an unexpected answer to their words', async () => {
    const stateRoot = temp();
    for (const [answer, words, code] of [
      [
        { ok: false, code: 'spawn_failed' },
        'The terminal server could not start the run.',
        'spawn_failed',
      ],
      [
        { ok: true, result: 'stopped' },
        'The terminal server did not accept the request.',
        'bad_request',
      ],
    ] as const) {
      const out = output();
      await expect(
        agentTerminalRunCommand(
          'MOTIR-1',
          { runId: 'run_1' },
          {
            request: async () => answer,
            readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
            stateDir: (runId) => join(stateRoot, runId),
            stdout: out.write,
          },
        ),
      ).rejects.toThrow(words);
      expect(out.lines).toEqual([{ error: code }]);
    }
  });

  it('falls back to generic words for a refusal code it does not know', async () => {
    const out = output();
    await expect(
      agentTerminalRunCommand(
        'MOTIR-1',
        { runId: 'run_1' },
        {
          request: async () => ({ ok: false, code: 'weird' }) as never,
          readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
          stateDir: (runId) => join(temp(), runId),
          stdout: out.write,
        },
      ),
    ).rejects.toThrow('did not accept');
    expect(out.lines).toEqual([{ error: 'weird' }]);
  });

  it('surfaces a state directory it cannot create (not an existing one)', async () => {
    await expect(
      agentTerminalRunCommand(
        'MOTIR-1',
        { runId: 'run_1' },
        {
          readStdin: async () => JSON.stringify({ apiUrl: API, token: TOKEN }),
          stateDir: () => join(temp(), 'missing-parent', 'run_1'),
        },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['not JSON', 'mtr_run_SECRET-TOKEN-7025'],
    ['no token', JSON.stringify({ apiUrl: API })],
    ['no URL', JSON.stringify({ token: TOKEN })],
    ['a non-http URL', JSON.stringify({ apiUrl: 'file:///x', token: TOKEN })],
  ])('refuses %s on stdin without quoting it', async (_label, stdin) => {
    const err = await agentTerminalRunCommand(
      'MOTIR-1',
      { runId: 'r' },
      { readStdin: async () => stdin, stateDir: () => join(temp(), 'unused') },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).not.toContain(TOKEN);
  });

  it('refuses a bad card key or run id before reading stdin', async () => {
    const readStdin = async (): Promise<string> => {
      throw new Error('stdin must not be read');
    };
    await expect(agentTerminalRunCommand('nope', { runId: 'r' }, { readStdin })).rejects.toThrow(
      'is not a card key',
    );
    await expect(agentTerminalRunCommand('MOTIR-1', {}, { readStdin })).rejects.toThrow('--run-id');
    await expect(
      agentTerminalRunCommand('MOTIR-1', { runId: '../x' }, { readStdin }),
    ).rejects.toThrow('--run-id');
  });
});

describe('motir agent-terminal stop / status', () => {
  it('stop prints stopped, then status prints the exit; an unknown run is not_found', async () => {
    const h = await start();
    await startRun(h);
    const env = { [CONTROL_SOCKET_ENV]: h.socket };
    const out = output();
    expect(
      await agentTerminalStatusCommand({ runId: 'run_1' }, { env, stdout: out.write }),
    ).toMatchObject({
      state: 'running',
    });
    expect(await agentTerminalStopCommand({ runId: 'run_1' }, { env, stdout: out.write })).toBe(
      'stopped',
    );
    await agentTerminalStatusCommand({ runId: 'run_1' }, { env, stdout: out.write });
    expect(await agentTerminalStopCommand({ runId: 'ghost' }, { env, stdout: out.write })).toBe(
      'not_found',
    );
    expect(out.lines).toEqual([
      { state: 'running', session: expect.any(String) },
      { result: 'stopped' },
      { state: 'exited', session: expect.any(String), exitCode: null, signal: 15 },
      { result: 'not_found' },
    ]);
  });

  it('refuse an unexpected answer and an absent server', async () => {
    const out = output();
    const request = async () => ({ ok: false as const, code: 'bad_request' as const });
    await expect(
      agentTerminalStopCommand({ runId: 'r' }, { request, stdout: out.write }),
    ).rejects.toThrow('did not accept');
    await expect(
      agentTerminalStatusCommand({ runId: 'r' }, { request, stdout: out.write }),
    ).rejects.toThrow('did not accept');
    await expect(
      agentTerminalStatusCommand(
        { runId: 'r' },
        {
          request: async () => {
            throw new ControlUnavailableError();
          },
          stdout: out.write,
        },
      ),
    ).rejects.toThrow('not answering');
    await expect(
      agentTerminalStatusCommand(
        { runId: 'r' },
        {
          request: async () => {
            throw new Error('boom');
          },
          stdout: out.write,
        },
      ),
    ).rejects.toThrow('boom');
    expect(out.lines).toEqual([
      { error: 'bad_request' },
      { error: 'bad_request' },
      { error: 'server_unavailable' },
    ]);
  });
});

describe('motir agent-terminal signin — the same answer the panel sees', () => {
  async function both(env: NodeJS.ProcessEnv): Promise<[unknown, unknown]> {
    const out = output();
    await agentTerminalSignInCommand({ env, stdout: out.write });
    return [out.lines[0], await checkSignIn(env)];
  }

  it('claude signed in, claude signed out, and a profile that answers unknown', async () => {
    const home = temp();
    const cfg = join(home, 'cfg');
    mkdirSync(cfg);
    const claude = { HOME: home, MOTIR_SANDBOX_AGENT: 'claude', CLAUDE_CONFIG_DIR: cfg };

    let [printed, checked] = await both(claude);
    expect(printed).toEqual({ profile: 'claude', state: 'signed_out' });
    expect(printed).toEqual(checked);

    writeFileSync(join(cfg, '.credentials.json'), '{"x":1}');
    [printed, checked] = await both(claude);
    expect(printed).toEqual({ profile: 'claude', state: 'signed_in' });
    expect(printed).toEqual(checked);

    [printed, checked] = await both({ HOME: home, MOTIR_SANDBOX_AGENT: 'kimi' });
    expect(printed).toEqual({ profile: 'kimi', state: 'unknown' });
    expect(printed).toEqual(checked);
  });
});

describe('the default sinks', () => {
  it('prints one JSON line to process.stdout, reading the process env', async () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => (writes.push(String(chunk)), true));
    try {
      await agentTerminalSignInCommand();
    } finally {
      spy.mockRestore();
    }
    expect(writes).toHaveLength(1);
    expect(Object.keys(JSON.parse(writes[0]!) as object).sort()).toEqual(['profile', 'state']);
  });
});

describe('the image-capability probe', () => {
  function helpOf(argv: string[]): { exitCode: number | null; printed: string } {
    let printed = '';
    const program = buildProgram();
    const configure = (command: typeof program): void => {
      command.exitOverride();
      command.configureOutput({ writeOut: (text) => (printed += text), writeErr: () => {} });
      for (const child of command.commands) configure(child);
    };
    configure(program);
    let exitCode: number | null = null;
    try {
      program.parse(['node', 'motir', ...argv]);
    } catch (err) {
      exitCode = (err as CommanderError).exitCode;
    }
    return { exitCode, printed };
  }

  it('`agent-terminal --help` lists run, stop, status and signin', () => {
    const { exitCode, printed } = helpOf(['agent-terminal', '--help']);
    expect(exitCode).toBe(0);
    for (const name of ['serve', 'run', 'stop', 'status', 'signin'])
      expect(printed).toContain(name);
  });

  it('`agent-terminal run --help` exits 0', () => {
    const { exitCode, printed } = helpOf(['agent-terminal', 'run', '--help']);
    expect(exitCode).toBe(0);
    expect(printed).toContain('--run-id');
  });
});

describe('reading stdin', () => {
  it('reads a pipe to its end', async () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream;
    const reading = readStdinBounded(stream);
    (stream as unknown as PassThrough).end('{"a":1}');
    expect(await reading).toBe('{"a":1}');
  });

  it('reads string chunks too', async () => {
    const stream = new PassThrough({ encoding: 'utf8' }) as unknown as NodeJS.ReadStream;
    const reading = readStdinBounded(stream);
    (stream as unknown as PassThrough).end('abc');
    expect(await reading).toBe('abc');
  });

  it('reads nothing from a terminal', async () => {
    const stream = Object.assign(new PassThrough(), {
      isTTY: true,
    }) as unknown as NodeJS.ReadStream;
    expect(await readStdinBounded(stream)).toBe('');
  });

  it('refuses more than it could ever need, and a failed read', async () => {
    const big = new PassThrough() as unknown as NodeJS.ReadStream;
    const reading = readStdinBounded(big);
    (big as unknown as PassThrough).write(Buffer.alloc(70 * 1024));
    await expect(reading).rejects.toThrow('larger than expected');

    const broken = new PassThrough() as unknown as NodeJS.ReadStream;
    const failing = readStdinBounded(broken);
    (broken as unknown as PassThrough).destroy(new Error('EPIPE'));
    await expect(failing).rejects.toThrow('Could not read');
  });
});

describe('signalProcessGroup', () => {
  it('signals the process itself when it leads no group', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise<string | null>((resolve) =>
      child.on('exit', (_c, sig) => resolve(sig)),
    );
    await new Promise((resolve) => child.on('spawn', resolve));
    signalProcessGroup(child.pid!, 'SIGTERM');
    expect(await exited).toBe('SIGTERM');
  });

  it('tolerates a process that is already gone', () => {
    // A pid far beyond pid_max: both the group and the process kill throw ESRCH.
    expect(() => signalProcessGroup(2_000_000_000, 'SIGTERM')).not.toThrow();
  });
});
