import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../errors.js';
import type { HostedRunAccess } from '../hostedGit.js';
import {
  AGENT_RUN_COMMANDS,
  CONTROL_SOCKET,
  CONTROL_SOCKET_ENV,
  ControlUnavailableError,
  controlRequest,
  isAgentRunCommand,
  isRunId,
  isWorkItemKey,
  runStateDir,
  type AgentRunCommand,
  type ControlRequest,
  type ControlResponse,
} from '../agentTerminal/control.js';
import {
  DEFAULT_TERMINAL_MODULE_DIR,
  NOT_AN_AGENT_IMAGE,
  TERMINAL_MODULE_DIR_ENV,
  loadNodePty,
  type SpawnPty,
} from '../agentTerminal/pty.js';
import {
  RUN_STOP_GRACE_MS,
  TERMINAL_KEY_ENV,
  createTerminalServer,
  type TerminalServer,
} from '../agentTerminal/server.js';
import { checkSignIn, type StatFn } from '../agentTerminal/signIn.js';

// `motir agent-terminal serve` — the in-agent terminal server
// (MOTIR-6938 · `docs/decisions/agent-terminal.md` Q4).
//
// It runs as the main process of a user's agent machine (MOTIR-6939 wires
// `init.cmd`), listens on 0.0.0.0:7681, and hands a login shell to Motir's
// relay — and to nothing that cannot present a relay token signed with this
// machine's key. Outside an agent image it refuses in words, because the PTY
// it needs is compiled into the image and is not a dependency of this package.

export const DEFAULT_TERMINAL_PORT = 7681;

/** The machine env the server cannot start without. Named, never echoed. */
const REQUIRED_ENV = [TERMINAL_KEY_ENV, 'MOTIR_INSTANCE_ID'] as const;

/**
 * The machine id the relay's tokens bind (MOTIR-10817), host-neutral. An AWS
 * agent VM's boot script sets it to the EC2 instance id
 * (`@motir/orchestrator`'s `MACHINE_ID_ENV_KEYS`).
 */
export const MACHINE_ID_ENV = 'MOTIR_MACHINE_ID';

/** The machine id the Fly platform sets on every machine — read when {@link MACHINE_ID_ENV} is not set. */
export const FLY_MACHINE_ID_ENV = 'FLY_MACHINE_ID';

/** The machine id, by its host-neutral name first and Fly's second; null when neither is set. */
function machineIdOf(env: NodeJS.ProcessEnv): string | null {
  for (const name of [MACHINE_ID_ENV, FLY_MACHINE_ID_ENV]) {
    const value = env[name];
    if (value?.trim()) return value;
  }
  return null;
}

export interface AgentTerminalServeOptions {
  port?: string;
}

/** `agent-terminal run | stop | status` — the run the command acts on. */
export interface AgentTerminalRunIdOptions {
  runId?: string;
}

/** `agent-terminal run` only (MOTIR-9045): the run, and what the session is for. */
export interface AgentTerminalRunOptions extends AgentTerminalRunIdOptions {
  /** run (the default), fix or continue. */
  command?: string;
}

export interface AgentTerminalServeDeps {
  env?: NodeJS.ProcessEnv;
  loadPty?: (dir: string) => SpawnPty | null;
  log?: (line: string) => void;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TERMINAL_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new CliError(`--port must be a TCP port between 1 and 65535, got "${raw}".`);
  }
  return port;
}

export async function agentTerminalServeCommand(
  opts: AgentTerminalServeOptions,
  deps: AgentTerminalServeDeps = {},
): Promise<TerminalServer> {
  const env = deps.env ?? process.env;
  const port = parsePort(opts.port);
  const dir = env[TERMINAL_MODULE_DIR_ENV]?.trim() || DEFAULT_TERMINAL_MODULE_DIR;
  const spawnPty = (deps.loadPty ?? loadNodePty)(dir);
  if (!spawnPty) {
    throw new CliError(NOT_AN_AGENT_IMAGE, {
      hint: 'It is started by the agent machine Motir runs for you; there is nothing to serve here.',
    });
  }
  for (const name of REQUIRED_ENV) {
    if (!env[name]?.trim()) {
      throw new CliError(`The terminal server needs ${name}, which the agent's machine sets.`);
    }
  }
  const machineId = machineIdOf(env);
  if (machineId === null) {
    throw new CliError(
      `The terminal server needs ${MACHINE_ID_ENV} (${FLY_MACHINE_ID_ENV} on Fly), which the agent's machine sets.`,
    );
  }
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const terminal = createTerminalServer({
    instanceKey: env[TERMINAL_KEY_ENV] as string,
    instanceId: env['MOTIR_INSTANCE_ID'] as string,
    machineId,
    spawnPty,
    env,
    log,
  });
  await terminal.listen(port);
  // The LOCAL door the run launcher uses (agent-instance-run.md §1). The relay
  // port and its token are untouched by it.
  await terminal.listenControl(controlSocketPath(env));
  return terminal;
}

// ── The run launcher and its probes (MOTIR-7025 · agent-instance-run.md §1, §2, §4) ──
//
// Motir reaches these only through a short synchronous Fly `exec`, as `node`:
//
//   motir agent-terminal run <KEY> --run-id <id>   (credentials JSON on stdin)
//                                                  → {"session":"<uuid>"}, at once
//   motir agent-terminal stop --run-id <id>        → {"result":"stopped"|"not_found"}
//   motir agent-terminal status --run-id <id>      → {"state":"running"|"exited"|"not_found",…}
//   motir agent-terminal signin                    → {"profile","state"}
//
// Each prints ONE JSON line on stdout — what the exec's caller parses — and a
// refusal also exits non-zero with its words on stderr. `run --help` exiting 0
// is the image-capability probe.
//
// ⚠️ THE RUN TOKEN TRAVELS stdin → a 0600 file, and nowhere else. It is never
// an argument, never an environment variable, never sent over the control
// socket, never printed and never in an error message. The launcher writes it
// into the run's 0700 state directory as `run.json` (`hostedGit.ts`'s
// `HostedRunAccess` shape, which agent mode reads), and the server points the
// run session at that directory.

/** The most the launcher reads from stdin: a URL and a token, with room to spare. */
const MAX_STDIN_BYTES = 64 * 1024;
/** How long a `run` or `status` request may take before the server counts as absent. */
const CONTROL_TIMEOUT_MS = 10_000;
/** `stop` waits for the grace period and a little more. */
const STOP_TIMEOUT_MS = RUN_STOP_GRACE_MS + 10_000;

function controlSocketPath(env: NodeJS.ProcessEnv): string {
  return env[CONTROL_SOCKET_ENV]?.trim() || CONTROL_SOCKET;
}

export interface AgentTerminalControlDeps {
  env?: NodeJS.ProcessEnv;
  /** One JSON line is written here. */
  stdout?: (text: string) => void;
  request?: (path: string, request: ControlRequest, timeoutMs: number) => Promise<ControlResponse>;
}

export interface AgentTerminalRunDeps extends AgentTerminalControlDeps {
  readStdin?: () => Promise<string>;
  /** Where the run's state directory is (tests point it at a temp dir). */
  stateDir?: (runId: string) => string;
}

function print(deps: AgentTerminalControlDeps, value: unknown): void {
  (deps.stdout ?? ((text: string) => process.stdout.write(text)))(`${JSON.stringify(value)}\n`);
}

/** Read stdin to its end, bounded. A terminal on stdin carries no credentials. */
export function readStdinBounded(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_STDIN_BYTES) {
        stream.destroy();
        reject(new CliError('The run’s credentials on stdin are larger than expected.'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () =>
      reject(new CliError('Could not read the run’s credentials on stdin.')),
    );
  });
}

/** `{apiUrl, token}` from stdin, or a refusal that quotes none of it. */
function parseRunCredentials(text: string): { apiUrl: string; token: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const apiUrl = typeof record['apiUrl'] === 'string' ? record['apiUrl'].trim() : '';
  const token = typeof record['token'] === 'string' ? record['token'].trim() : '';
  if (!/^https?:\/\/\S+$/.test(apiUrl) || token.length === 0) {
    throw new CliError('The run’s credentials are read on stdin as JSON: {"apiUrl","token"}.', {
      hint: 'Motir writes them when it starts a run in this agent; this command is not typed by hand.',
    });
  }
  return { apiUrl, token };
}

function requireRunId(raw: string | undefined): string {
  if (!isRunId(raw)) {
    throw new CliError('--run-id must name the run (letters, digits, "-" and "_").');
  }
  return raw;
}

/** `--command`: absent is a plain run; anything outside the three is refused up front. */
function requireCommand(raw: string | undefined): AgentRunCommand | undefined {
  if (raw === undefined) return undefined;
  if (!isAgentRunCommand(raw)) {
    throw new CliError(`--command must be one of ${AGENT_RUN_COMMANDS.join(', ')}.`);
  }
  return raw;
}

async function ask(
  deps: AgentTerminalControlDeps,
  request: ControlRequest,
  timeoutMs: number,
): Promise<ControlResponse> {
  const env = deps.env ?? process.env;
  try {
    return await (deps.request ?? controlRequest)(controlSocketPath(env), request, timeoutMs);
  } catch (err) {
    if (!(err instanceof ControlUnavailableError)) throw err;
    print(deps, { error: 'server_unavailable' });
    throw new CliError('The agent’s terminal server is not answering.', {
      hint: 'It is the agent machine’s main process; a machine that is still booting answers shortly.',
      cause: err,
    });
  }
}

const REFUSAL_WORDS: Record<string, string> = {
  run_active: 'A run is already running in this agent.',
  bad_request: 'The terminal server did not accept the request.',
  spawn_failed: 'The terminal server could not start the run.',
};

/**
 * `motir agent-terminal run <KEY> --run-id <id>`: write the run's credentials
 * into its private state directory, ask the server for a run session, and
 * return at once with its id. The run's own exit is never awaited.
 */
export async function agentTerminalRunCommand(
  key: string,
  opts: AgentTerminalRunOptions,
  deps: AgentTerminalRunDeps = {},
): Promise<string> {
  if (!isWorkItemKey(key)) {
    throw new CliError(`"${key}" is not a card key (like MOTIR-123).`);
  }
  const runId = requireRunId(opts.runId);
  const command = requireCommand(opts.command);
  const credentials = parseRunCredentials(await (deps.readStdin ?? readStdinBounded)());
  const dir = (deps.stateDir ?? runStateDir)(runId);

  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Only a live run of this id may own an existing directory; anything else
    // is left over from a run that died without its server (a crash), so it is
    // replaced rather than trusted.
    const status = await ask(deps, { op: 'status', runId }, CONTROL_TIMEOUT_MS);
    if ('state' in status && status.state === 'running') {
      print(deps, { error: 'run_active' });
      throw new CliError(REFUSAL_WORDS['run_active'] as string);
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
  }
  chmodSync(dir, 0o700);
  const access: HostedRunAccess = { apiUrl: credentials.apiUrl, runId, token: credentials.token };
  const runFile = join(dir, 'run.json');
  writeFileSync(runFile, `${JSON.stringify(access)}\n`, { mode: 0o600 });
  chmodSync(runFile, 0o600);

  let response: ControlResponse;
  try {
    response = await ask(
      deps,
      // A plain run sends today's request byte for byte; only a fix or a continue names its command.
      {
        op: 'run',
        runId,
        workItemKey: key.toUpperCase(),
        ...(command !== undefined && command !== 'run' ? { command } : {}),
      },
      CONTROL_TIMEOUT_MS,
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  if (response.ok && 'session' in response && !('state' in response)) {
    print(deps, { session: response.session });
    return response.session;
  }
  // A refusal leaves nothing behind: the directory was this launch's own.
  rmSync(dir, { recursive: true, force: true });
  const code = response.ok ? 'bad_request' : response.code;
  print(deps, { error: code });
  throw new CliError(REFUSAL_WORDS[code] ?? (REFUSAL_WORDS['bad_request'] as string));
}

/** `motir agent-terminal stop --run-id <id>`: SIGTERM, then SIGKILL after the grace. */
export async function agentTerminalStopCommand(
  opts: AgentTerminalRunIdOptions,
  deps: AgentTerminalControlDeps = {},
): Promise<'stopped' | 'not_found'> {
  const runId = requireRunId(opts.runId);
  const response = await ask(deps, { op: 'stop', runId }, STOP_TIMEOUT_MS);
  if (!response.ok || !('result' in response)) {
    print(deps, { error: 'bad_request' });
    throw new CliError(REFUSAL_WORDS['bad_request'] as string);
  }
  print(deps, { result: response.result });
  return response.result;
}

/** `motir agent-terminal status --run-id <id>`: running, exited with its code, or not_found. */
export async function agentTerminalStatusCommand(
  opts: AgentTerminalRunIdOptions,
  deps: AgentTerminalControlDeps = {},
): Promise<ControlResponse> {
  const runId = requireRunId(opts.runId);
  const response = await ask(deps, { op: 'status', runId }, CONTROL_TIMEOUT_MS);
  if (!response.ok || !('state' in response)) {
    print(deps, { error: 'bad_request' });
    throw new CliError(REFUSAL_WORDS['bad_request'] as string);
  }
  const { ok: _ok, ...status } = response;
  print(deps, status);
  return response;
}

/**
 * `motir agent-terminal signin`: the same `checkSignIn` answer the panel sees,
 * for this machine's profile — `{profile, state}` and nothing else (§4).
 */
export async function agentTerminalSignInCommand(
  deps: { env?: NodeJS.ProcessEnv; stat?: StatFn; stdout?: (text: string) => void } = {},
): Promise<void> {
  const status = await checkSignIn(deps.env ?? process.env, deps.stat);
  print(deps, { profile: status.profile, state: status.state });
}
