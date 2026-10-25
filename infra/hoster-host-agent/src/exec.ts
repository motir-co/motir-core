import { spawn } from 'node:child_process';

// `POST /v1/exec` (Story MOTIR-9361 · MOTIR-9480) — one command inside the
// instance's container, to the contract in `docs/decisions/aws-hoster-host-agent.md`:
//
//   request  { "command": [argv…], "stdin": "…optional…", "timeoutSeconds": 120 }
//   200      { "exitCode": 0, "stdout": "…", "stderr": "…" }  (a non-zero exit too)
//   408      the command outlived `timeoutSeconds` (it is killed)
//
// The argv goes to `docker exec` as a LIST, never through a shell, so no element
// can smuggle shell syntax. The stdin is written to the child and closed.

/** The container the boot script starts (`PERSISTENT_CONTAINER_NAME`). */
export const CONTAINER_NAME = 'motir-instance';

/** The contract's default when a request names no timeout. */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/** The longest timeout a request may ask for — a run is supervised, not exec'd. */
export const MAX_TIMEOUT_SECONDS = 3600;

/** The largest request body accepted; a prompt and a credential fit many times. */
export const MAX_REQUEST_BYTES = 1024 * 1024;

export interface ExecRequest {
  readonly command: readonly string[];
  readonly stdin?: string;
  readonly timeoutSeconds: number;
}

export type ContainerRunResult =
  | {
      readonly kind: 'exited';
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: 'timed_out' };

/** How a command reaches the container — the seam a test replaces. */
export type RunInContainer = (input: {
  argv: readonly string[];
  stdin?: string;
  timeoutMs: number;
}) => Promise<ContainerRunResult>;

/** The request body, or null when it is not the contract's shape. */
export function parseExecRequest(body: unknown): ExecRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const command = b['command'];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === 'string')
  ) {
    return null;
  }
  const stdin = b['stdin'];
  if (stdin !== undefined && typeof stdin !== 'string') return null;
  const timeout = b['timeoutSeconds'] ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    timeout > MAX_TIMEOUT_SECONDS
  ) {
    return null;
  }
  return {
    command: command as string[],
    ...(stdin !== undefined ? { stdin } : {}),
    timeoutSeconds: timeout,
  };
}

/**
 * Run `argv` with `program` (the real one is `docker exec`) WITHOUT a shell. The
 * child is killed at the deadline. `program` and `prefix` are the seam a test
 * points at a tiny stand-in for docker.
 */
export function spawnRunner(
  program = 'docker',
  prefix: (hasStdin: boolean) => readonly string[] = (hasStdin) => [
    'exec',
    ...(hasStdin ? ['-i'] : []),
    CONTAINER_NAME,
  ],
): RunInContainer {
  return ({ argv, stdin, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [...prefix(stdin !== undefined), ...argv], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (c: Buffer) => stdout.push(c));
      child.stderr.on('data', (c: Buffer) => stderr.push(c));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({ kind: 'timed_out' });
          return;
        }
        resolve({
          kind: 'exited',
          // A child killed by a signal has no code; 128 + signal is the shell's word for it.
          exitCode: code ?? 137,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      // A child that exits before reading its stdin closes the pipe; that is
      // the command's business, not an error of the request.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? '');
    });
}

/** The status and JSON body `POST /v1/exec` answers for one request. */
export async function handleExec(
  body: unknown,
  run: RunInContainer,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = parseExecRequest(body);
  if (!request) return { status: 400, body: { error: 'bad_request' } };
  let result: ContainerRunResult;
  try {
    result = await run({
      argv: request.command,
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      timeoutMs: request.timeoutSeconds * 1000,
    });
  } catch {
    // Docker itself could not be started; the reason may name the command.
    return { status: 503, body: { error: 'container_unavailable' } };
  }
  if (result.kind === 'timed_out') return { status: 408, body: { error: 'exec_timeout' } };
  return {
    status: 200,
    body: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
  };
}
