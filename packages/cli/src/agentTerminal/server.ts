import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { HOSTED_STATE_ENV, defaultCliInvocation } from '../hostedGit.js';
import { RUN_ID_ENV_VAR } from '../hostedMode.js';
import { resolveChatAdapter, type ChatAdapter, type ChatContext } from './chat/adapter.js';
import {
  createChatHub,
  spawnChatProcess,
  type ChatConnectionHandle,
  type SpawnChat,
} from './chat/turns.js';
import {
  CONTROL_SOCKET,
  listenControl,
  runStateDir,
  runWorkspaceDir,
  type AgentRunCommand,
  type ControlRequest,
  type ControlResponse,
  type ControlServer,
} from './control.js';
import { OutputRing, REPLAY_BYTES } from './outputRing.js';
import {
  CHAT_PATH,
  TERMINAL_PATH,
  encodeServerFrame,
  parseClientFrame,
  type ServerFrame,
  type SessionKind,
  type SessionListing,
} from './protocol.js';
import type { PtyProcess, SpawnPty } from './pty.js';
import { NonceMemory, verifyRelayAuthorization } from './relayToken.js';
import { checkSignIn, type SignInStatus, type StatFn } from './signIn.js';
import {
  acceptWebSocket,
  isWebSocketUpgrade,
  refuseUpgrade,
  type WebSocketConnection,
} from './websocket.js';

// The in-agent terminal server (MOTIR-6938 · `docs/decisions/agent-terminal.md`
// Q3, Q4, Q5, Q7, Q8), and the chat beside it at `/v1/chat` (MOTIR-7012 ·
// `docs/decisions/agent-chat.md` Q4, Q6, Q10, Q11) — the same upgrade, the
// same relay-token check, then a second handler (`chat/turns.ts`).
//
// ⚠️ WHAT IS NEVER LOGGED. Fly ships this process's stdout to logs, so the
// only lines written are LIFECYCLE lines carrying ids: a session opened,
// attached, detached, reaped or exited, an upgrade refused with its reason
// CODE. Never a frame, a byte of PTY input or output, a token, the key, or an
// `Error` message built from any of them. PTY bytes travel between the PTY and
// the socket and the in-memory replay ring, and nowhere else.
//
// THE RUN SESSION (MOTIR-7025 · `docs/decisions/agent-instance-run.md` §1, §2).
// Besides a person's shells, the server holds at most ONE run session: `motir
// run <KEY> --run-id <id>` in agent mode, opened on a request over the LOCAL
// control socket (`control.ts`), never over the relay. It is tagged with its
// run id, never reaped and never counted against the four shells, watch-only
// (input frames are dropped, resize applies), and listed to every connection so
// the panel can offer it. Its environment carries the run's private state
// directory — where the launcher wrote the run token — and never a token. When
// its process exits, however it exits, the state and workspace directories are
// removed.
//
// Everything with a side effect (the PTY, the clock, `fs.stat`, the log sink,
// signalling a process group, removing a directory) is injected, so the tests
// drive this module against a fake PTY.

/** The env var holding the instance key; it is removed from the shell's env. */
export const TERMINAL_KEY_ENV = 'MOTIR_TERMINAL_KEY';
/** Live sessions per agent (Q5). */
export const MAX_SESSIONS = 4;
/** How often the sign-in state is re-checked while a session is attached (Q7). */
export const SIGNIN_INTERVAL_MS = 5_000;
/** How long an authenticated connection may wait before its `open` frame. */
export const OPEN_TIMEOUT_MS = 30_000;
/** How long a stopped run gets after SIGTERM before SIGKILL (agent-instance-run.md §1). */
export const RUN_STOP_GRACE_MS = 10_000;
/** The env var that puts `motir run` in agent mode (agent-instance-run.md §1, §3). */
export const AGENT_RUN_ENV = 'MOTIR_AGENT_RUN';
/** The env var naming the run's own checkouts directory (agent-instance-run.md §2). */
export const RUN_WORKSPACE_ENV = 'MOTIR_WORKSPACE';
/** The PTY a run session is opened with, before anyone attaches and resizes it. */
export const RUN_COLS = 120;
export const RUN_ROWS = 40;
/** Exited runs whose status is remembered for `status`; the oldest is forgotten first. */
const EXITED_RUNS_KEPT = 16;

/** Signal a PTY's process GROUP (node-pty starts each child as a session leader). */
export type SignalGroup = (pid: number, signal: NodeJS.Signals) => void;

export const signalProcessGroup: SignalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

function removeDirQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort: /tmp is reset on every wake, and the run's credentials are
    // revoked at its close whatever is left on disk.
  }
}

export interface TerminalServerOptions {
  /** MOTIR_TERMINAL_KEY. */
  instanceKey: string;
  /** MOTIR_INSTANCE_ID. */
  instanceId: string;
  /** The machine id: MOTIR_MACHINE_ID, else FLY_MACHINE_ID (`commands/agentTerminal.ts`). */
  machineId: string;
  spawnPty: SpawnPty;
  /** The server's own environment; the shell gets it minus the key. */
  env: NodeJS.ProcessEnv;
  /** Lifecycle lines only. */
  log: (line: string) => void;
  /** Milliseconds since the epoch. */
  now?: () => number;
  stat?: StatFn;
  /** The chat turn process spawn; the real one by default. */
  spawnChat?: SpawnChat;
  /** The chat adapter registry (`chat/adapter.ts` `CHAT_ADAPTERS` by default). */
  chatAdapters?: readonly ChatAdapter[];
  /** Stop's SIGINT → SIGKILL grace for a chat turn. */
  chatStopGraceMs?: number;
  maxSessions?: number;
  replayBytes?: number;
  signInIntervalMs?: number;
  openTimeoutMs?: number;
  /** The command that re-enters this CLI; the run session runs `<cli> run <KEY> --run-id <id>`. */
  cli?: readonly string[];
  /** SIGTERM / SIGKILL a run session's process group. */
  signalGroup?: SignalGroup;
  /** Remove a run's state and workspace directories when its session ends. */
  removeDir?: (path: string) => void;
  /** SIGTERM → SIGKILL grace for a stopped run. */
  stopGraceMs?: number;
}

interface Session {
  id: string;
  /** A person's shell, or the one session a card's run lives in (never reaped). */
  kind: SessionKind;
  /** Set on a run session only. */
  runId?: string;
  pty: PtyProcess;
  ring: OutputRing;
  connection: Attachment | null;
  /** When it last lost its connection; null while attached. */
  detachedAt: number | null;
  /** Monotonic tiebreak for sessions detached in the same millisecond. */
  detachSeq: number;
}

interface RunRecord {
  runId: string;
  command: AgentRunCommand;
  session: Session;
  state: 'running' | 'exited';
  exitCode: number | null;
  signal: number | null;
  /** Resolves once the session's process has exited. */
  exited: Promise<void>;
  markExited: () => void;
  killTimer: NodeJS.Timeout | null;
}

interface Attachment {
  ws: WebSocketConnection;
  session: Session | null;
  /** The session the relay token names, if any. */
  tokenSession: string | undefined;
}

export interface TerminalServer {
  readonly server: Server;
  /** Start listening; resolves with the bound port. */
  listen(port: number, host?: string): Promise<number>;
  /** Start the LOCAL control socket the run launcher speaks to (agent-instance-run.md §1). */
  listenControl(path?: string): Promise<void>;
  /** Answer one control request — what the socket calls; exposed for tests. */
  control(request: ControlRequest): Promise<ControlResponse>;
  /** Kill every shell, drop every connection, stop listening. */
  close(): Promise<void>;
  /** How many live sessions the server holds, the run session included. */
  sessionCount(): number;
  /** The running chat turn's number, or null (one per agent). */
  chatTurn(): number | null;
}

/** The shell's environment: the server's own, minus the key, plus the terminal type. */
export function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === TERMINAL_KEY_ENV || value === undefined) continue;
    out[name] = value;
  }
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  return out;
}

/** A chat turn's environment: the server's own, minus the key, and nothing added (Q11). */
export function chatEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name === TERMINAL_KEY_ENV || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

/** `$HOME/workspace`, or `$HOME` when the workspace does not exist yet. */
export function shellCwd(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'] || '/';
  const workspace = join(home, 'workspace');
  try {
    if (existsSync(workspace) && statSync(workspace).isDirectory()) return workspace;
  } catch {
    // fall through to HOME
  }
  return home;
}

export function createTerminalServer(options: TerminalServerOptions): TerminalServer {
  const now = options.now ?? Date.now;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const replayBytes = options.replayBytes ?? REPLAY_BYTES;
  const signInIntervalMs = options.signInIntervalMs ?? SIGNIN_INTERVAL_MS;
  const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? RUN_STOP_GRACE_MS;
  const signalGroup = options.signalGroup ?? signalProcessGroup;
  const removeDir = options.removeDir ?? removeDirQuietly;
  const log = options.log;
  const nonces = new NonceMemory();
  const sessions = new Map<string, Session>();
  const connections = new Set<Attachment>();
  const runs = new Map<string, RunRecord>();
  let control: ControlServer | null = null;
  let detachCounter = 0;
  let signInTimer: NodeJS.Timeout | null = null;
  let lastSignIn: SignInStatus | null = null;
  let closing = false;

  // ── Chat (MOTIR-7012) ─────────────────────────────────────────────────────
  const profile = options.env['MOTIR_SANDBOX_AGENT']?.trim() || null;
  const chatContext: ChatContext = {
    home: options.env['HOME'] || '/',
    cwd: shellCwd(options.env),
    env: chatEnv(options.env),
  };
  const chat = createChatHub({
    profile,
    adapter: resolveChatAdapter(profile, options.chatAdapters),
    ctx: chatContext,
    spawn: options.spawnChat ?? spawnChatProcess,
    readSignIn: () => readSignIn(),
    log,
    now,
    ...(options.chatStopGraceMs !== undefined ? { stopGraceMs: options.chatStopGraceMs } : {}),
  });
  const chatSockets = new Set<WebSocketConnection>();

  const send = (attachment: Attachment, frame: ServerFrame): void => {
    if (attachment.ws.isOpen) attachment.ws.send(encodeServerFrame(frame));
  };

  const attachedCount = (): number =>
    [...sessions.values()].filter((session) => session.connection !== null).length;

  // ── Sign-in (Q7) ──────────────────────────────────────────────────────────
  const readSignIn = (): Promise<SignInStatus> => checkSignIn(options.env, options.stat);

  const sameState = (a: SignInStatus | null, b: SignInStatus): boolean =>
    a !== null && a.profile === b.profile && a.state === b.state;

  const pushSignIn = (status: SignInStatus, to: Iterable<Attachment>): void => {
    for (const attachment of to) {
      send(attachment, { t: 'signin', profile: status.profile, state: status.state });
    }
  };

  const attachedConnections = (): Attachment[] =>
    [...sessions.values()]
      .map((session) => session.connection)
      .filter((connection): connection is Attachment => connection !== null);

  const pollSignIn = async (): Promise<void> => {
    const status = await readSignIn();
    if (closing || sameState(lastSignIn, status)) return;
    lastSignIn = status;
    pushSignIn(status, attachedConnections());
    chat.pushSignIn(status);
  };

  const syncSignInTimer = (): void => {
    const wanted = (attachedCount() > 0 || chatSockets.size > 0) && !closing;
    if (wanted && signInTimer === null) {
      signInTimer = setInterval(() => void pollSignIn(), signInIntervalMs);
      signInTimer.unref();
    } else if (!wanted && signInTimer !== null) {
      clearInterval(signInTimer);
      signInTimer = null;
    }
  };

  /** On attach: always tell this connection; tell the others only on a change. */
  const signInOnAttach = async (attachment: Attachment): Promise<void> => {
    const status = await readSignIn();
    if (closing) return;
    const changed = !sameState(lastSignIn, status);
    lastSignIn = status;
    const others = changed ? attachedConnections().filter((other) => other !== attachment) : [];
    pushSignIn(status, [attachment, ...others]);
  };

  // ── Sessions (Q5) ─────────────────────────────────────────────────────────
  /** A person's shells: what the four-session limit counts. A run session never does. */
  const shellCount = (): number =>
    [...sessions.values()].filter((session) => session.kind === 'shell').length;

  const liveRun = (): RunRecord | undefined =>
    [...runs.values()].find((record) => record.state === 'running');

  const listing = (): SessionListing[] =>
    [...sessions.values()].map((session) =>
      session.kind === 'run'
        ? { session: session.id, kind: 'run', runId: session.runId as string }
        : { session: session.id, kind: 'shell' },
    );

  /** Tell every attached connection which sessions exist (a run opened or ended). */
  const broadcastSessions = (): void => {
    const sessionsFrame: ServerFrame = { t: 'sessions', sessions: listing() };
    for (const attachment of attachedConnections()) send(attachment, sessionsFrame);
  };

  const detach = (session: Session): void => {
    session.connection = null;
    session.detachedAt = now();
    session.detachSeq = ++detachCounter;
    syncSignInTimer();
  };

  const removeSession = (session: Session): void => {
    sessions.delete(session.id);
    syncSignInTimer();
  };

  const attach = (attachment: Attachment, session: Session, resumed: boolean): void => {
    const previous = session.connection;
    if (previous && previous !== attachment) {
      // One connection per session: the newer attach takes it over.
      previous.session = null;
      send(previous, { t: 'error', code: 'taken_over' });
      previous.ws.close(1000);
      log(`agent-terminal: session ${session.id} taken over`);
    }
    session.connection = attachment;
    session.detachedAt = null;
    attachment.session = session;
    send(
      attachment,
      session.kind === 'run'
        ? { t: 'ready', session: session.id, resumed, kind: 'run', runId: session.runId as string }
        : { t: 'ready', session: session.id, resumed },
    );
    if (resumed) {
      const replay = session.ring.snapshot();
      if (replay.length > 0) attachment.ws.send(replay);
    }
    // The run session is offered to whoever attaches, beside their own shell.
    if (liveRun()) send(attachment, { t: 'sessions', sessions: listing() });
    log(`agent-terminal: session ${session.id} ${resumed ? 'resumed' : 'attached'}`);
    syncSignInTimer();
    void signInOnAttach(attachment);
  };

  const reapLongestDetached = (): boolean => {
    let victim: Session | null = null;
    for (const session of sessions.values()) {
      // A run session is never reaped: opening terminals never kills a run.
      if (session.kind === 'run') continue;
      if (session.connection !== null || session.detachedAt === null) continue;
      if (
        victim === null ||
        session.detachedAt < (victim.detachedAt as number) ||
        (session.detachedAt === victim.detachedAt && session.detachSeq < victim.detachSeq)
      ) {
        victim = session;
      }
    }
    if (!victim) return false;
    removeSession(victim);
    victim.pty.kill();
    log(`agent-terminal: session ${victim.id} reaped (session limit)`);
    return true;
  };

  /** Register a spawned PTY as a session: its output feeds the ring and the attached socket. */
  const registerSession = (
    pty: PtyProcess,
    kind: SessionKind,
    runId: string | undefined,
    onExit: (exitCode: number | null, signal: number | null) => void,
  ): Session => {
    const session: Session = {
      id: randomUUID(),
      kind,
      ...(runId === undefined ? {} : { runId }),
      pty,
      ring: new OutputRing(replayBytes),
      connection: null,
      detachedAt: kind === 'run' ? now() : null,
      detachSeq: 0,
    };
    sessions.set(session.id, session);
    pty.onData((data) => {
      session.ring.push(data);
      if (session.connection) session.connection.ws.send(data);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (!sessions.has(session.id)) return;
      removeSession(session);
      const connection = session.connection;
      session.connection = null;
      if (connection) {
        connection.session = null;
        send(connection, { t: 'exit', code: exitCode, signal });
        connection.ws.close(1000);
      }
      log(`agent-terminal: session ${session.id} exited (code ${String(exitCode)})`);
      onExit(exitCode, signal);
    });
    return session;
  };

  const openSession = (attachment: Attachment, cols: number, rows: number): void => {
    if (shellCount() >= maxSessions && !reapLongestDetached()) {
      send(attachment, { t: 'error', code: 'session_limit' });
      attachment.ws.close(1000);
      log('agent-terminal: open refused (session limit)');
      return;
    }
    let pty: PtyProcess;
    try {
      pty = options.spawnPty({
        file: 'bash',
        args: ['-l'],
        cols,
        rows,
        cwd: shellCwd(options.env),
        env: shellEnv(options.env),
      });
    } catch {
      // The error is not logged: its message is not ours to vouch for.
      log('agent-terminal: shell failed to start');
      attachment.ws.close(1011);
      return;
    }
    const session = registerSession(pty, 'shell', undefined, () => undefined);
    log(`agent-terminal: session ${session.id} opened (pid ${pty.pid})`);
    attach(attachment, session, false);
  };

  // ── Runs (agent-instance-run.md §1, §2) ───────────────────────────────────
  const home = options.env['HOME'] || '/';

  const forgetOldRuns = (): void => {
    const exited = [...runs.values()].filter((record) => record.state === 'exited');
    for (const record of exited.slice(0, Math.max(0, exited.length - EXITED_RUNS_KEPT))) {
      runs.delete(record.runId);
    }
  };

  /** The run's environment: a shell's, plus agent mode and its private dirs — never a token. */
  const runEnv = (runId: string): Record<string, string> => ({
    ...shellEnv(options.env),
    [HOSTED_STATE_ENV]: runStateDir(runId),
    [AGENT_RUN_ENV]: '1',
    [RUN_WORKSPACE_ENV]: runWorkspaceDir(home, runId),
  });

  /**
   * The process a run's command turns into (MOTIR-9050): `<cli> <command> <KEY>`, the
   * shape the hosted entrypoint's `cliArgs` already uses. `motir run` is the only one of
   * the three that registers `--run-id`, so it keeps that argument; `fix` and `continue`
   * adopt the server-opened run through `MOTIR_DISPATCH_RUN_ID`, as both already do. The
   * switch is TOTAL over the command, with no fallback to `run`: a fix started as a run
   * would work the card again instead of repairing its branch.
   */
  const runProcess = (
    command: AgentRunCommand,
    runId: string,
    workItemKey: string,
  ): { args: string[]; env: Record<string, string> } => {
    switch (command) {
      case 'run':
        return { args: [command, workItemKey, '--run-id', runId], env: runEnv(runId) };
      case 'fix':
      case 'continue':
        return {
          args: [command, workItemKey],
          env: { ...runEnv(runId), [RUN_ID_ENV_VAR]: runId },
        };
    }
  };

  const startRun = (
    runId: string,
    workItemKey: string,
    command: AgentRunCommand,
  ): ControlResponse => {
    if (closing) return { ok: false, code: 'spawn_failed' };
    const active = liveRun();
    if (active) {
      log(`agent-terminal: run ${runId} (${command}) refused (run ${active.runId} active)`);
      return { ok: false, code: 'run_active' };
    }
    const cli = options.cli ?? defaultCliInvocation();
    let pty: PtyProcess;
    try {
      const spawned = runProcess(command, runId, workItemKey);
      pty = options.spawnPty({
        file: cli[0] as string,
        args: [...cli.slice(1), ...spawned.args],
        cols: RUN_COLS,
        rows: RUN_ROWS,
        cwd: shellCwd(options.env),
        env: spawned.env,
      });
    } catch {
      log(`agent-terminal: run ${runId} (${command}) failed to start`);
      removeDir(runStateDir(runId));
      return { ok: false, code: 'spawn_failed' };
    }
    let markExited = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const record: RunRecord = {
      runId,
      command,
      // Assigned just below; the exit callback cannot fire before it is.
      session: null as unknown as Session,
      state: 'running',
      exitCode: null,
      signal: null,
      exited,
      markExited,
      killTimer: null,
    };
    runs.set(runId, record);
    record.session = registerSession(pty, 'run', runId, (exitCode, signal) => {
      record.state = 'exited';
      record.exitCode = exitCode;
      record.signal = signal;
      if (record.killTimer) clearTimeout(record.killTimer);
      record.killTimer = null;
      // However the run ends, its credentials and its checkouts go with it (§2).
      removeDir(runStateDir(runId));
      removeDir(runWorkspaceDir(home, runId));
      log(`agent-terminal: run ${runId} (${command}) ended (code ${String(exitCode)})`);
      record.markExited();
      forgetOldRuns();
      broadcastSessions();
    });
    log(
      `agent-terminal: run ${runId} (${command}) session ${record.session.id} opened (pid ${pty.pid})`,
    );
    broadcastSessions();
    return { ok: true, session: record.session.id };
  };

  const stopRun = async (runId: string): Promise<ControlResponse> => {
    const record = runs.get(runId);
    if (!record) return { ok: true, result: 'not_found' };
    if (record.state === 'running') {
      const pid = record.session.pty.pid;
      log(`agent-terminal: run ${runId} (${record.command}) stopping`);
      signalGroup(pid, 'SIGTERM');
      if (!record.killTimer) {
        record.killTimer = setTimeout(() => {
          record.killTimer = null;
          if (record.state !== 'running') return;
          log(`agent-terminal: run ${runId} (${record.command}) killed (grace elapsed)`);
          signalGroup(pid, 'SIGKILL');
        }, stopGraceMs);
        record.killTimer.unref();
      }
      // A process that survives even SIGKILL (stuck in the kernel) must not
      // hold the caller's exec open forever: answer after a bounded wait.
      await Promise.race([
        record.exited,
        new Promise<void>((resolve) => setTimeout(resolve, stopGraceMs + 5_000).unref()),
      ]);
    }
    return { ok: true, result: 'stopped' };
  };

  const runStatus = (runId: string): ControlResponse => {
    const record = runs.get(runId);
    if (!record) return { ok: true, state: 'not_found' };
    return record.state === 'running'
      ? { ok: true, state: 'running', session: record.session.id }
      : {
          ok: true,
          state: 'exited',
          session: record.session.id,
          exitCode: record.exitCode,
          signal: record.signal,
        };
  };

  const handleControl = async (request: ControlRequest): Promise<ControlResponse> => {
    switch (request.op) {
      case 'run':
        return startRun(request.runId, request.workItemKey, request.command ?? 'run');
      case 'stop':
        return stopRun(request.runId);
      case 'status':
        return runStatus(request.runId);
    }
  };

  const onOpenFrame = (
    attachment: Attachment,
    frame: { cols: number; rows: number; session?: string },
  ): void => {
    if (attachment.session) return; // already attached; one `open` per connection
    const wanted = frame.session ?? attachment.tokenSession;
    if (wanted === undefined) {
      openSession(attachment, frame.cols, frame.rows);
      return;
    }
    const session = sessions.get(wanted);
    if (!session || (attachment.tokenSession !== undefined && attachment.tokenSession !== wanted)) {
      // The connection stays open: the panel may `open` a fresh session on it.
      send(attachment, { t: 'error', code: 'unknown_session' });
      log('agent-terminal: resume refused (unknown session)');
      return;
    }
    attach(attachment, session, true);
    session.pty.resize(frame.cols, frame.rows);
  };

  const onMessage = (attachment: Attachment, data: Buffer, isBinary: boolean): void => {
    if (isBinary) {
      // A run session is watch-only: a person stops it with Cancel, never a keystroke.
      if (attachment.session?.kind === 'run') return;
      attachment.session?.pty.write(data);
      return;
    }
    const frame = parseClientFrame(data.toString('utf8'));
    if (!frame) return; // ignored, and never echoed or logged
    switch (frame.t) {
      case 'open':
        onOpenFrame(attachment, frame);
        return;
      case 'resize':
        attachment.session?.pty.resize(frame.cols, frame.rows);
        return;
      case 'ping':
        send(attachment, { t: 'pong' });
        return;
    }
  };

  // ── The upgrade: authenticate BEFORE anything else exists (Q3) ────────────
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    const path = (req.url ?? '/').split('?')[0];
    if (path !== TERMINAL_PATH && path !== CHAT_PATH) {
      refuseUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isWebSocketUpgrade(req)) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return;
    }
    const verdict = verifyRelayAuthorization(req.headers.authorization, {
      instanceKey: options.instanceKey,
      instanceId: options.instanceId,
      machineId: options.machineId,
      nowSeconds: Math.floor(now() / 1000),
      nonces,
    });
    if (!verdict.ok) {
      refuseUpgrade(socket, 401, 'Unauthorized');
      log(`agent-terminal: upgrade refused (${verdict.reason})`);
      return;
    }
    if (closing) {
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (path === CHAT_PATH) {
      acceptChat(ws);
      return;
    }
    const attachment: Attachment = { ws, session: null, tokenSession: verdict.payload.sessionId };
    connections.add(attachment);
    log('agent-terminal: connection opened');
    const openTimer = setTimeout(() => {
      if (!attachment.session) ws.close(1008);
    }, openTimeoutMs);
    openTimer.unref();
    ws.on('message', (data, isBinary) => onMessage(attachment, data, isBinary));
    ws.on('close', (code) => {
      clearTimeout(openTimer);
      connections.delete(attachment);
      const session = attachment.session;
      attachment.session = null;
      if (session && session.connection === attachment) {
        detach(session);
        log(`agent-terminal: session ${session.id} detached`);
      }
      log(`agent-terminal: connection closed (${code})`);
    });
  };

  /** A chat socket, past the same token check as the terminal's. */
  const acceptChat = (ws: WebSocketConnection): void => {
    chatSockets.add(ws);
    syncSignInTimer();
    const handle: ChatConnectionHandle = chat.accept(ws);
    ws.on('message', (data, isBinary) => handle.message(data, isBinary));
    ws.on('close', (code) => {
      chatSockets.delete(ws);
      handle.closed();
      syncSignInTimer();
      log(`agent-chat: connection closed (${code})`);
    });
  };

  const server = createServer((req, res) => {
    // Plain HTTP is not served. `426` on a WebSocket path says why.
    const path = (req.url ?? '/').split('?')[0];
    res.statusCode = path === TERMINAL_PATH || path === CHAT_PATH ? 426 : 404;
    res.end();
  });
  server.on('upgrade', onUpgrade);
  // A malformed request is dropped silently: its bytes are the client's.
  server.on('clientError', (_err, socket) => socket.destroy());

  return {
    server,
    listen(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          const bound = typeof address === 'object' && address ? address.port : port;
          log(`agent-terminal: listening on ${host}:${bound}`);
          resolve(bound);
        });
      });
    },
    async listenControl(path = CONTROL_SOCKET) {
      control = await listenControl(path, handleControl);
      log('agent-terminal: control socket listening');
    },
    control: handleControl,
    async close() {
      closing = true;
      syncSignInTimer();
      for (const record of runs.values()) {
        if (record.killTimer) clearTimeout(record.killTimer);
        record.killTimer = null;
        // The kill below skips the exit bookkeeping; release any waiting `stop`.
        record.markExited();
      }
      if (control) await control.close();
      control = null;
      for (const session of [...sessions.values()]) {
        sessions.delete(session.id);
        session.pty.kill();
      }
      for (const attachment of connections) attachment.ws.terminate();
      connections.clear();
      // The chat shares the shutdown: its running turn is killed, its sockets dropped.
      chat.close();
      for (const ws of chatSockets) ws.terminate();
      chatSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    sessionCount: () => sessions.size,
    chatTurn: () => chat.runningTurn(),
  };
}
