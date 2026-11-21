import type { PersistentTerminalConfig } from '@motir/orchestrator';
import type { DispatchCommand } from '@/generated/prisma/client';
import { AgentInstancesUnavailableError } from '@/lib/agentInstances/errors';
import { deriveTerminalKey, terminalKeyId } from '@/lib/agentInstances/terminalKey';

// THE AGENT TERMINAL'S MACHINE CONFIG (Story MOTIR-6861 · MOTIR-6939) — the
// numbers and the command `docs/decisions/agent-terminal.md` fixes, named once.
// The orchestrator port carries them; only the Fly adapter knows how they are
// spelled in a Fly machine config.

/** Q2 / Q4: the terminal server listens here inside the machine. */
export const AGENT_TERMINAL_PORT = 7681;

/**
 * Q8: the machine config's version, stamped in the machine's metadata. BUMP IT
 * whenever {@link agentTerminalMachineConfig}'s output changes shape, so the next
 * wake of every older agent rewrites its config before starting it.
 *   1 — MOTIR-6939: the terminal server as the main process, the public
 *       service on 7681 → 443, `MOTIR_TERMINAL_KEY`.
 */
export const AGENT_MACHINE_CONFIG_VERSION = 1;

/**
 * Q4: the main process, under the image's UNCHANGED `ENTRYPOINT` (which seeds the
 * home and sources the agent's config env first). A current image runs the
 * server; an image whose `motir` has no such command idles instead of
 * crash-looping, so a new config on an old image boots and stays up (Q8).
 */
export const AGENT_TERMINAL_COMMAND: readonly string[] = [
  'sh',
  '-c',
  'motir agent-terminal --help >/dev/null 2>&1 && exec motir agent-terminal serve; exec sleep infinity',
];

/**
 * The main process of a machine booted with the terminal OFF (MOTIR-7336). The
 * image's own `CMD` is `bash -l`, which exits 0 at once with no TTY — and Fly's
 * `on-failure` policy does not restart a clean exit — so a machine left on it
 * stopped two seconds after it started and its boot never ended. Q4's terminal
 * command already idles on an image with no server ("boots and stays up"), and
 * this is that same idle for a deployment with no terminal at all: the machine
 * stays up, reachable through `exec`, exactly as "boot as before the terminal"
 * assumed it would.
 */
export const AGENT_IDLE_COMMAND: readonly string[] = ['sleep', 'infinity'];

/** Q8: the probe run once per image digest on a booted machine — exit 0 means the server is there. */
export const AGENT_TERMINAL_PROBE_COMMAND: readonly string[] = [
  'motir',
  'agent-terminal',
  '--help',
];

/** The master key must carry at least this many characters (≈ 256 bits of base64). */
export const TERMINAL_MASTER_KEY_MIN_LENGTH = 32;

/**
 * `MOTIR_TERMINAL_MASTER_KEY`, read at CALL time (the instance lane's rule), or
 * null when the deployment has not set it — the terminal is then OFF: machines
 * boot with no service, idling on {@link AGENT_IDLE_COMMAND}, and nothing is
 * probed. A key that is set but too short is a misconfiguration and FAILS LOUDLY
 * rather than deriving weak keys.
 */
export function terminalMasterKey(): string | null {
  const raw = process.env['MOTIR_TERMINAL_MASTER_KEY']?.trim();
  if (!raw) return null;
  if (raw.length < TERMINAL_MASTER_KEY_MIN_LENGTH) {
    throw new AgentInstancesUnavailableError(
      `MOTIR_TERMINAL_MASTER_KEY must be at least ${TERMINAL_MASTER_KEY_MIN_LENGTH} characters`,
    );
  }
  return raw;
}

/** Is the agent terminal switched on for this deployment? */
export function isAgentTerminalConfigured(): boolean {
  return terminalMasterKey() !== null;
}

/**
 * The machine config one instance's machine runs its terminal with (Q2, Q3, Q4),
 * or null when the terminal is off. The same value on create and on a wake's
 * config update, so the two can never disagree.
 */
export function agentTerminalMachineConfig(instanceId: string): PersistentTerminalConfig | null {
  const masterKey = terminalMasterKey();
  if (!masterKey) return null;
  const key = deriveTerminalKey(masterKey, instanceId);
  return {
    version: AGENT_MACHINE_CONFIG_VERSION,
    keyId: terminalKeyId(key),
    command: AGENT_TERMINAL_COMMAND,
    env: { MOTIR_TERMINAL_KEY: key },
    service: {
      internalPort: AGENT_TERMINAL_PORT,
      ports: [{ port: 443, handlers: ['tls', 'http'] }],
      autostart: false,
      autostop: 'off',
    },
  };
}

// ── The run launcher's commands (MOTIR-7026 · `agent-instance-run.md` §1, §4) ──
//
// Each is ONE synchronous Fly `exec` of a short local command the agent's
// terminal server answers (MOTIR-7025's `motir agent-terminal run|signin`). An
// exec runs as root; the launcher and the sign-in query must run as the agent's
// own user with its home, exactly as the clone does (`cloneCommand.ts`), so the
// credential paths `checkSignIn` stats and the run's state directory are node's.

/**
 * The agent-config environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …) is written
 * to `env.sh` by the image's agent-config setup and reaches a process only by a
 * shell SOURCING it (`agent-config-profile.sh`) — it is not a Docker `ENV`. A
 * bare `exec` sources nothing, so without this the sign-in query stats
 * `~/.claude` and `~/.codex` and reads every signed-in agent as `signed_out`
 * (MOTIR-8869). Best-effort like the profile script: a missing file is no error.
 */
const SOURCE_AGENT_CONFIG_ENV =
  'f="$HOME/.motir-sandbox/agent-config/env.sh"; [ -r "$f" ] && . "$f"; exec "$@"';

/** Run a `motir agent-terminal …` subcommand as `node`, with node's home and agent-config environment. */
const AS_NODE: readonly string[] = [
  'runuser',
  '-u',
  'node',
  '--',
  'env',
  'HOME=/home/node',
  'sh',
  '-c',
  SOURCE_AGENT_CONFIG_ENV,
  'sh',
  'motir',
  'agent-terminal',
];

/** §4: the image-capability probe — `run --help` exiting 0 means the launcher is there. */
export const AGENT_RUN_LAUNCHER_PROBE_COMMAND: readonly string[] = [
  'motir',
  'agent-terminal',
  'run',
  '--help',
];

/** §4: the sign-in query — one `{"profile","state"}` line on stdout. */
export const AGENT_SIGN_IN_COMMAND: readonly string[] = [...AS_NODE, 'signin'];

/** §1: its exec timeout, and the sign-in query's (§4: 10 seconds). */
export const AGENT_RUN_LAUNCH_TIMEOUT_SECONDS = 30;
export const AGENT_SIGN_IN_TIMEOUT_SECONDS = 10;

/**
 * §1: the launch. The run id and the card key are its only arguments — neither
 * is a secret; the run's credentials travel on the exec's STDIN (§2), never here.
 */
export function agentRunLaunchCommand(
  workItemKey: string,
  dispatchRunId: string,
  command: DispatchCommand = 'run',
): string[] {
  const base = [...AS_NODE, 'run', workItemKey, '--run-id', dispatchRunId];
  // MOTIR-9045: only a `fix`, `continue` or `review` (MOTIR-11945) names its command.
  // Every other value a run row can hold launches today's argv, so an image whose
  // bundled CLI predates `--command` keeps starting ordinary runs.
  return command === 'fix' || command === 'continue' || command === 'review'
    ? [...base, '--command', command]
    : base;
}

/**
 * §6: stop a run's session in the agent — `SIGTERM`, then `SIGKILL` after the
 * launcher's 10-second grace. Answers `{"result":"stopped"|"not_found"}`; the
 * caller reads nothing from it, because the run is already closed when it asks.
 */
export function agentRunStopCommand(dispatchRunId: string): string[] {
  return [...AS_NODE, 'stop', '--run-id', dispatchRunId];
}

/** The stop's exec timeout: the launcher's grace, its own margin, and room for the exec. */
export const AGENT_RUN_STOP_TIMEOUT_SECONDS = 30;

/** The last line of an exec's stdout that parses as a JSON object, or null. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (!line.startsWith('{')) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
    } catch {
      // not the answer line
    }
  }
  return null;
}

/** The sign-in states `motir agent-terminal signin` answers (§4). */
export type AgentSignInAnswer = 'signed_in' | 'signed_out' | 'unknown';

/**
 * The sign-in query's answer, or null when the exec gave none — a non-zero
 * exit, no JSON line, or a state outside the vocabulary. Null is "no answer",
 * which leaves the recorded value standing (§4).
 */
export function parseSignInAnswer(result: {
  exitCode: number;
  stdout: string;
}): AgentSignInAnswer | null {
  if (result.exitCode !== 0) return null;
  const state = lastJsonObject(result.stdout)?.['state'];
  return state === 'signed_in' || state === 'signed_out' || state === 'unknown' ? state : null;
}

/**
 * The launcher's answer (§1): `{session}` on success, else the refusal code it
 * printed (`run_active`, `server_unavailable`, …) or `launch_failed` for an
 * exec that printed none.
 */
export function parseLaunchAnswer(result: {
  exitCode: number;
  stdout: string;
}): { ok: true; session: string } | { ok: false; error: string } {
  const answer = lastJsonObject(result.stdout);
  const session = answer?.['session'];
  if (result.exitCode === 0 && typeof session === 'string' && session.length > 0) {
    return { ok: true, session };
  }
  const error = answer?.['error'];
  return { ok: false, error: typeof error === 'string' && error ? error : 'launch_failed' };
}
