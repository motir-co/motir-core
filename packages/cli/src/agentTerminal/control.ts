import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

// The terminal server's LOCAL control channel (MOTIR-7025 ·
// `docs/decisions/agent-instance-run.md` §1).
//
// Motir starts a run in a developer's agent with one short, synchronous Fly
// `exec` of `motir agent-terminal run <KEY> --run-id <id>`. That command must
// return at once while the run lives on, so it does not run `motir run` itself:
// it asks the terminal server — the one process that owns every PTY on the
// machine — to open a run-tagged session, over a unix socket here.
//
//   /tmp/motir-agent-terminal/            0700, owned by the server's user
//   /tmp/motir-agent-terminal/control.sock
//
// One JSON request and one JSON answer per connection, each a single line:
//
//   {"op":"run","runId","workItemKey"}   → {"ok":true,"session"}
//                                         | {"ok":false,"code":"run_active"|"bad_request"|"spawn_failed"}
//   {"op":"stop","runId"}                → {"ok":true,"result":"stopped"|"not_found"}
//   {"op":"status","runId"}              → {"ok":true,"state":"running"|"exited"|"not_found",
//                                            "session"?,"exitCode"?,"signal"?}
//
// ⚠️ NO CREDENTIAL CROSSES THIS SOCKET. The run token arrives on the launcher's
// stdin and the launcher writes it into the run's private state directory
// (`runStateDir`) before it asks for the session (§2); the request carries the
// run id and the card key, neither of which is a secret. The relay port (7681)
// and its token are untouched.

/** The run-private directory holding the control socket. */
export const CONTROL_DIR = '/tmp/motir-agent-terminal';
/** The control socket the launcher speaks to. */
export const CONTROL_SOCKET = join(CONTROL_DIR, 'control.sock');
/** Env that points the server and its subcommands at another socket (tests). */
export const CONTROL_SOCKET_ENV = 'MOTIR_AGENT_TERMINAL_CONTROL';
/** The largest request or answer either side reads. */
const MAX_LINE_BYTES = 16 * 1024;

/** A run id is a cuid/uuid-like token; it names directories, so it is narrow. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** A card key: `<PROJECT>-<n>`. */
const WORK_ITEM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}-[1-9]\d{0,9}$/;

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

export function isWorkItemKey(value: unknown): value is string {
  return typeof value === 'string' && WORK_ITEM_KEY_PATTERN.test(value);
}

/** `/tmp/motir-run-<runId>` — the run's 0700 state directory, on the rootfs (§2). */
export function runStateDir(runId: string): string {
  return `/tmp/motir-run-${runId}`;
}

/** `$HOME/.motir/runs/<runId>` — the run's own checkouts, never the developer's (§2). */
export function runWorkspaceDir(home: string, runId: string): string {
  return join(home, '.motir', 'runs', runId);
}

/**
 * What a run session is for (MOTIR-9045; `review` since MOTIR-11953 — a review in the
 * person's own agent). A CLI-local copy of the app's `AGENT_RUN_COMMANDS` —
 * `packages/cli` cannot import `lib/` — checked against it by one test so the two
 * cannot drift. Absent on the wire means `run`.
 */
export const AGENT_RUN_COMMANDS = ['run', 'fix', 'continue', 'review'] as const;
export type AgentRunCommand = (typeof AGENT_RUN_COMMANDS)[number];

export function isAgentRunCommand(value: unknown): value is AgentRunCommand {
  return typeof value === 'string' && (AGENT_RUN_COMMANDS as readonly string[]).includes(value);
}

export type ControlRequest =
  | { op: 'run'; runId: string; workItemKey: string; command?: AgentRunCommand }
  | { op: 'stop'; runId: string }
  | { op: 'status'; runId: string };

export type RunRefusal = 'run_active' | 'bad_request' | 'spawn_failed';

export type ControlResponse =
  | { ok: true; session: string }
  | { ok: true; result: 'stopped' | 'not_found' }
  | {
      ok: true;
      state: 'running' | 'exited' | 'not_found';
      session?: string;
      exitCode?: number | null;
      signal?: number | null;
    }
  | { ok: false; code: RunRefusal };

/** Parse one request line; null for anything malformed. */
export function parseControlRequest(text: string): ControlRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const req = value as Record<string, unknown>;
  if (!isRunId(req['runId'])) return null;
  const runId = req['runId'];
  switch (req['op']) {
    case 'run':
      if (!isWorkItemKey(req['workItemKey'])) return null;
      // MOTIR-9045: an absent command is today's `run` (an older launcher sends
      // none); a value outside the set is refused as a bad request.
      if (req['command'] === undefined) {
        return { op: 'run', runId, workItemKey: req['workItemKey'], command: 'run' };
      }
      return isAgentRunCommand(req['command'])
        ? { op: 'run', runId, workItemKey: req['workItemKey'], command: req['command'] }
        : null;
    case 'stop':
      return { op: 'stop', runId };
    case 'status':
      return { op: 'status', runId };
    default:
      return null;
  }
}

export type ControlHandler = (request: ControlRequest) => Promise<ControlResponse>;

/** Read one newline-terminated line (or the whole stream) from a socket, bounded. */
function readLine(socket: Socket): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (line: string | null): void => {
      if (done) return;
      done = true;
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      socket.off('close', onEnd);
      resolve(line);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.length;
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(0x0a);
      if (newline >= 0) finish(all.subarray(0, newline).toString('utf8'));
      else if (size > MAX_LINE_BYTES) finish(null);
    };
    const onEnd = (): void => {
      const all = Buffer.concat(chunks);
      finish(all.length > 0 && all.length <= MAX_LINE_BYTES ? all.toString('utf8') : null);
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onEnd);
    socket.on('close', onEnd);
  });
}

export interface ControlServer {
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Listen on the control socket. The directory is created `0700` (and re-moded
 * if it existed), and a stale socket file from an earlier process is removed.
 */
export function listenControl(path: string, handler: ControlHandler): Promise<ControlServer> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(path, { force: true });
  // Half-open: a client that writes its request and ends its side still gets
  // the answer, which is written after the (async) handler settles.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => socket.destroy());
    void readLine(socket).then(async (line) => {
      const request = line === null ? null : parseControlRequest(line);
      const response: ControlResponse = request
        ? await handler(request).catch((): ControlResponse => ({ ok: false, code: 'bad_request' }))
        : { ok: false, code: 'bad_request' };
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      try {
        chmodSync(path, 0o600);
      } catch {
        // The directory's 0700 is the lock; the socket's own mode is belt and braces.
      }
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              rmSync(path, { force: true });
              done();
            });
          }),
      });
    });
  });
}

/** The server is not there to answer: not started, or not this image. */
export class ControlUnavailableError extends Error {
  constructor() {
    super('The terminal server is not answering on its control socket.');
    this.name = 'ControlUnavailableError';
  }
}

/** Send one request, read one answer. */
export function controlRequest(
  path: string,
  request: ControlRequest,
  timeoutMs: number,
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ControlUnavailableError());
    }, timeoutMs);
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new ControlUnavailableError());
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
      void readLine(socket).then((line) => {
        clearTimeout(timer);
        socket.destroy();
        if (line === null) {
          reject(new ControlUnavailableError());
          return;
        }
        try {
          resolve(JSON.parse(line) as ControlResponse);
        } catch {
          reject(new ControlUnavailableError());
        }
      });
    });
  });
}
