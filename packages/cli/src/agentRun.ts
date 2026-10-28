import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedAgentCommand } from './agentProfiles.js';
import { createAgentStreamFormatter, lookupSessionId } from './agentStreamLog.js';
import { CliError } from './errors.js';
import { DESIGN_SUBDIR, MOTIR_DESIGN_DIR_ENV } from './designFiles.js';

// Running the user's OWN coding agent (Subtask 7.9.3 · MOTIR-881). BYOK: the
// agent binary, its credential, and its model are the user's — Motir launches
// it, hands it the server-generated prompt, and reports its exit code. It never
// reads the agent's credential, and it inspects the agent's output only when
// the operator has asked it to (`--report-log`; see TEEING below). That
// sentence used to end "and never inspects its output", which stopped being
// true the moment a caller could pass `onOutput` — amended rather than left to
// contradict the code beneath it.
//
// The prompt is delivered BOTH ways, because agent CLIs disagree about how they
// take input:
//   • on STDIN, for the ones that read a piped prompt; and
//   • as `$MOTIR_PROMPT_FILE`, a path to a temp file, for the ones that want
//     `--prompt-file <path>` (or that re-exec themselves and lose stdin).
// Supplying both means a new agent usually needs no Motir change at all — which
// is the point of the agent-agnostic BYOK design.
//
// The child inherits stdout/stderr so its output STREAMS THROUGH live rather
// than being buffered and replayed: a coding agent run is minutes long, and a
// silent terminal is indistinguishable from a hang.
//
// ── TEEING the output ($MOTIR log bodies · MOTIR-3961) ─────────────────────
// `inherit` hands the child our own file descriptors, so the output never
// passes through this process and there is nothing to copy. When — and ONLY
// when — a caller supplies `onOutput`, the two streams are PIPED instead and
// every chunk is written through to the same place it would have gone anyway,
// plus handed to the callback. With no callback the stdio is byte-identical to
// what it always was, which is deliberate: the overwhelmingly common run does
// not report bodies and must not pay for the ones that do.
//
// ── the agent's SELF-REPORT ($MOTIR_AGENT_REPORT · MOTIR-2419) ──────────────
// One thing about a BYOK run only the agent can answer: WHICH MODEL ANSWERED.
// Nothing outside the process can see it, so it arrives by self-report — a JSON
// file the agent writes at the path in `$MOTIR_AGENT_REPORT`, which the prompt
// asks it for and this module reads back.
//
// The path lives in the SAME per-run temp dir as the prompt, and that is what
// makes the channel safe rather than merely convenient: the dir is created for
// this dispatch and removed when it ends, so there is no file for a later item
// to inherit. A fixed path in the checkout would carry item N's model onto item
// N+1 whenever the agent forgot to write one — a wrong answer wearing the shape
// of a right one, which is the exact failure the model field exists to avoid.
// Nothing here is trusted beyond its shape: an absent, unreadable, malformed or
// blank report is a null model, never a guess and never an error.

/** The file mode for the prompt temp file: owner read/write only. It carries
 *  the item's full description, which is the user's project data. */
const PROMPT_FILE_MODE = 0o600;

export interface AgentRunResult {
  /** The agent's exit code — 0 is success. A signal death reports 1 (there is
   *  no exit code in that case, and it is unambiguously not success). */
  exitCode: number;
  /** The signal that killed the agent, when it was killed by one. */
  signal: NodeJS.Signals | null;
  /**
   * The agent's OWN session id (MOTIR-8980) — the conversation a later fix resumes. Read
   * from the agent's stream, or chosen by Motir before the spawn where the agent lets it,
   * or looked up in the agent's session store. Null when the run was not in a streaming
   * form or none could be established; absent from a caller's fake.
   */
  sessionId?: string | null;
  /**
   * The model the agent SELF-REPORTED, or null when it reported none.
   *
   * Null is a first-class answer, not a missing value: the caller records it
   * verbatim as `implementationModel`. Never defaulted — a run whose agent said
   * nothing must leave the field empty rather than name a model nobody
   * observed.
   */
  model: string | null;
  /**
   * The agent's REASON for stopping on an unbuildable card, when it wrote one into
   * its self-report as `unbuildable` (MOTIR-8698) — the prompt's STOP branch tells
   * it to, so the CLI can make the run-found report with the run's own credential.
   * Null (or absent, from a caller's fake) when the agent built the card, or said
   * nothing.
   */
  unbuildableReason?: string | null;
  /**
   * The points of a BUILD-THROUGH the agent wrote into its self-report as `discrepancy`
   * (MOTIR-8722) — the prompt tells an agent with no Motir tools to, so the CLI can record
   * them with the run's own credential. Null (or absent) when it wrote none.
   */
  discrepancy?: AgentDiscrepancyPoint[] | null;
  /**
   * The DECISIONS the agent made where its card left the HOW open, written into its
   * self-report as `decisions` (MOTIR-10000) — the prompt tells an agent with no Motir tools
   * to, so the CLI records them beside any discrepancy. Null (or absent) when it wrote none.
   */
  decisions?: AgentDecisionPoint[] | null;
  /**
   * The agent's STOP, when it wrote one into its self-report as `stop` (MOTIR-8722) — the
   * comment, whether the card goes to Planning, and the re-plan brief — so the CLI can
   * make those writes with the run's own credential. Null (or absent) when it wrote none.
   */
  stop?: AgentStopReport | null;
}

/** One point of a build-through: what the plan asked · what was built · why. */
export interface AgentDiscrepancyPoint {
  planAsked: string;
  built: string;
  why: string;
}

/** One decision the agent made: what the plan said · what it chose · why (· alternatives). */
export interface AgentDecisionPoint {
  planSaid: string;
  chose: string;
  why: string;
  alternatives?: string;
}

/** The six `SettledRequirement` fields of a re-plan brief, as far as the agent wrote them. */
export type AgentStopRequirement = Partial<
  Record<
    'outcome' | 'behaviour' | 'scopeEdge' | 'constraints' | 'acceptance' | 'assumptions',
    string
  >
>;

/** What the agent asked the run to do on a STOP. */
export interface AgentStopReport {
  /** The finding for the card's comment — `stop.comment`, else the `unbuildable` text. */
  comment: string;
  toPlanning: boolean;
  requirement: AgentStopRequirement | null;
}

/** The server's bounds on a discrepancy record (`RUN_DISCREPANCY_*_MAX`). */
const MAX_DISCREPANCY_POINTS = 20;
const MAX_DISCREPANCY_FIELD_LENGTH = 2000;
/** The server's bounds on a stop report (`RUN_STOP_*_MAX`). */
const MAX_STOP_COMMENT_LENGTH = 4000;
const MAX_STOP_FIELD_LENGTH = 2000;
const REQUIREMENT_FIELDS = [
  'outcome',
  'behaviour',
  'scopeEdge',
  'constraints',
  'acceptance',
  'assumptions',
] as const;

/**
 * The longest unbuildable reason carried — the server's own bound
 * (`RUN_FOUND_REPORT_REASON_MAX`). A longer one is CUT to it rather than dropped:
 * unlike a model id, the head of a reason is still the reason, and dropping it
 * would silence the report it exists to make.
 */
const MAX_UNBUILDABLE_REASON_LENGTH = 4000;

/**
 * The longest string accepted as a model identifier. A self-report is UNTRUSTED
 * input that gets written to a database column, and something longer than this
 * is not a model id — it is an agent that dumped its context into the field.
 * Rejected rather than truncated: half an identifier is a wrong answer.
 */
const MAX_MODEL_LENGTH = 200;

/** What the self-report said. Each field is read on its own: a bad one is null. */
export interface AgentReport {
  model: string | null;
  unbuildableReason: string | null;
  discrepancy: AgentDiscrepancyPoint[] | null;
  decisions: AgentDecisionPoint[] | null;
  stop: AgentStopReport | null;
}

const EMPTY_REPORT: AgentReport = {
  model: null,
  unbuildableReason: null,
  discrepancy: null,
  decisions: null,
  stop: null,
};

/**
 * Read the agent's self-report. Total: every failure mode — no file, no
 * permission, invalid JSON, a non-object — is the empty report; a non-string, a
 * blank or an implausibly long `model` is a null model; a non-string or blank
 * `unbuildable` is a null reason.
 */
export function readAgentReport(path: string): AgentReport {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return EMPTY_REPORT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_REPORT;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_REPORT;
  const { model, unbuildable, discrepancy, decisions, stop } = parsed as {
    model?: unknown;
    unbuildable?: unknown;
    discrepancy?: unknown;
    decisions?: unknown;
    stop?: unknown;
  };
  const unbuildableReason = reasonOf(unbuildable);
  return {
    model: modelOf(model),
    unbuildableReason,
    discrepancy: discrepancyOf(discrepancy),
    decisions: decisionsOf(decisions),
    stop: stopOf(stop, unbuildableReason),
  };
}

/** A trimmed, non-empty string cut to `max`, or null. Cut rather than dropped, like a reason. */
function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/**
 * The build-through points. A point missing a field is dropped, not the whole record — the
 * rest is still what the agent built differently; more than the server's 20 are cut to it.
 */
function discrepancyOf(value: unknown): AgentDiscrepancyPoint[] | null {
  if (!Array.isArray(value)) return null;
  const points: AgentDiscrepancyPoint[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const planAsked = textOf(raw.planAsked, MAX_DISCREPANCY_FIELD_LENGTH);
    const built = textOf(raw.built, MAX_DISCREPANCY_FIELD_LENGTH);
    const why = textOf(raw.why, MAX_DISCREPANCY_FIELD_LENGTH);
    if (planAsked && built && why) points.push({ planAsked, built, why });
  }
  return points.length === 0 ? null : points.slice(0, MAX_DISCREPANCY_POINTS);
}

/**
 * The decisions, on the same terms as the points: one missing a required field is dropped,
 * not the record; `alternatives` is kept when it is a non-blank string; cut to the server's 20.
 */
function decisionsOf(value: unknown): AgentDecisionPoint[] | null {
  if (!Array.isArray(value)) return null;
  const decisions: AgentDecisionPoint[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const planSaid = textOf(raw.planSaid, MAX_DISCREPANCY_FIELD_LENGTH);
    const chose = textOf(raw.chose, MAX_DISCREPANCY_FIELD_LENGTH);
    const why = textOf(raw.why, MAX_DISCREPANCY_FIELD_LENGTH);
    if (!planSaid || !chose || !why) continue;
    const alternatives = textOf(raw.alternatives, MAX_DISCREPANCY_FIELD_LENGTH);
    decisions.push({ planSaid, chose, why, ...(alternatives ? { alternatives } : {}) });
  }
  return decisions.length === 0 ? null : decisions.slice(0, MAX_DISCREPANCY_POINTS);
}

/**
 * The STOP. Its comment is `stop.comment`, else the `unbuildable` text the prompt asks for
 * anyway; with neither there is nothing to say on the card, so there is no stop.
 * `toPlanning` must be `true` to move the card — anything else leaves it where it is.
 */
function stopOf(value: unknown, unbuildableReason: string | null): AgentStopReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const comment = textOf(raw.comment, MAX_STOP_COMMENT_LENGTH) ?? unbuildableReason;
  if (!comment) return null;
  let requirement: AgentStopRequirement | null = null;
  if (typeof raw.requirement === 'object' && raw.requirement !== null) {
    const bag = raw.requirement as Record<string, unknown>;
    const kept: AgentStopRequirement = {};
    for (const field of REQUIREMENT_FIELDS) {
      // A field the agent wrote as "" is an ANSWER ("considered, there is none"), so it is
      // kept; only a non-string is left out.
      if (typeof bag[field] === 'string') {
        kept[field] = (bag[field] as string).trim().slice(0, MAX_STOP_FIELD_LENGTH);
      }
    }
    if (Object.keys(kept).length > 0) requirement = kept;
  }
  return {
    comment: comment.slice(0, MAX_STOP_COMMENT_LENGTH),
    toPlanning: raw.toPlanning === true,
    requirement,
  };
}

function modelOf(model: unknown): string | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (trimmed === '' || trimmed.length > MAX_MODEL_LENGTH) return null;
  return trimmed;
}

function reasonOf(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_UNBUILDABLE_REASON_LENGTH);
}

export interface RunAgentOptions {
  command: ParsedAgentCommand;
  /** The server-generated prompt, delivered verbatim. */
  prompt: string;
  /** The resolved checkout (or workspace root) the agent runs in. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Receive a COPY of the agent's stdout and stderr as they arrive.
   *
   * Supplying it switches the child's stdio from `inherit` to `pipe` — the
   * output still reaches the terminal, through this process instead of around
   * it. Omit it and nothing about the spawn changes.
   *
   * ⚠️ It is called from a stream handler, so it MUST NOT THROW and must not
   * block: reporting is an observation of the run and may never fail it, change
   * its exit code or slow the agent down. This function swallows a throw for
   * the same reason, at the one place every chunk passes through.
   */
  onOutput?: (chunk: string) => void;
  /**
   * Put the card's APPROVED DESIGN in the run's own directory before the spawn
   * (Story MOTIR-5553 · Subtask MOTIR-5562).
   *
   * Called with the design root — `<the run directory>/design` — and resolves
   * `true` only when EVERY file landed, which is the only case in which the
   * child is given `$MOTIR_DESIGN_DIR`. Anything else resolves `false`, having
   * already cleaned up and warned, and the run continues: the prompt's fetch
   * instruction is written for exactly that case.
   *
   * ⚠️ IT LIVES HERE, not in the caller, because the directory it writes into is
   * this function's — created by `tempDirFactory` and removed in the `finally`
   * below. That is what makes *the design is gone when the run ends* true by
   * construction rather than by somebody remembering to delete it.
   *
   * ⚠️ AND A THROW IS THE SAME AS `false`. A design that could not be fetched is
   * a degraded run, never a broken one, so nothing it does may fail the dispatch.
   */
  materializeDesigns?: (designRoot: string) => Promise<boolean>;
  /** Injectable seams for the tests — never overridden in production. */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  tempDirFactory?: () => string;
}

/**
 * The session id to record: what the stream said, else the one Motir chose or is
 * resuming, else the newest session the agent's own store holds for this checkout.
 */
async function sessionIdOf(
  opts: RunAgentOptions,
  fromStream: string | null,
  since: number,
): Promise<string | null> {
  const stream = opts.command.stream;
  if (!stream) return null;
  const known = fromStream ?? stream.sessionId;
  if (known) return known;
  return lookupSessionId(
    stream.profile,
    { cwd: opts.cwd, env: opts.command.env ?? opts.env ?? process.env },
    since,
  );
}

function defaultTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'motir-prompt-'));
}

/**
 * Launch the agent on a prompt and resolve with its exit code.
 *
 * Never rejects on a non-zero exit — a failing agent is an ORDINARY outcome the
 * caller reports and records (the item stays In Progress, the exclude list
 * grows), not an exception. It DOES throw a {@link CliError} when the binary
 * cannot be launched at all (ENOENT), because that is a setup problem `motir
 * doctor` diagnoses rather than a failed piece of work.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const dir = (opts.tempDirFactory ?? defaultTempDir)();
  const promptFile = join(dir, 'prompt.md');
  const reportFile = join(dir, 'agent-report.json');
  // An agent-mode launcher's addendum (MOTIR-7024) rides on every channel, so
  // the file, stdin and argv all carry the same words.
  const prompt = opts.prompt + (opts.command.promptAddendum?.() ?? '');
  writeFileSync(promptFile, prompt, { mode: PROMPT_FILE_MODE });

  // The DESIGN, before the spawn (MOTIR-5562). A throw is swallowed for the same
  // reason a `false` is honoured: fetching a design may never fail a dispatch.
  const designRoot = join(dir, DESIGN_SUBDIR);
  let designReady = false;
  if (opts.materializeDesigns) {
    try {
      designReady = await opts.materializeDesigns(designRoot);
    } catch {
      designReady = false;
    }
  }

  try {
    // Two seconds of slack: a store may stamp a session at a coarser resolution than the clock.
    const startedAt = Date.now() - 2000;
    // The agent's event stream, turned into readable lines (MOTIR-8980). Null for a
    // command the user typed, and for a profile no chat adapter reads.
    const formatter = opts.command.stream
      ? createAgentStreamFormatter(opts.command.stream.profile)
      : null;
    const result = await new Promise<Omit<AgentRunResult, 'model' | 'unbuildableReason'>>(
      (resolve, reject) => {
        const tee = opts.onOutput;
        const promptOnStdin = opts.command.promptOnStdin !== false;
        const args = [
          ...opts.command.args,
          ...(opts.command.promptArgs?.(prompt, promptFile) ?? []),
        ];
        const child = spawnFn(opts.command.binary, args, {
          cwd: opts.cwd,
          // stdin piped (we write the prompt); stdout/stderr inherited so the
          // agent's output streams straight through to the user's terminal —
          // unless a caller wants a COPY, in which case they are piped and
          // forwarded to the very same streams below. A launcher that takes its
          // prompt on argv leaves stdin unconnected (`promptOnStdin: false`).
          stdio: [
            promptOnStdin ? 'pipe' : 'ignore',
            // A stream is never left to `inherit`: its raw JSON is not for a terminal.
            tee || formatter ? 'pipe' : 'inherit',
            tee ? 'pipe' : 'inherit',
          ],
          env: {
            // A built-in launcher's environment REPLACES the inherited one — it is
            // an allow-list (MOTIR-6559), and merging would defeat it.
            ...(opts.command.env ?? opts.env ?? process.env),
            MOTIR_PROMPT_FILE: promptFile,
            MOTIR_AGENT_REPORT: reportFile,
            // Set ONLY when every file landed. An unset variable is what tells the
            // agent to follow the prompt's fetch instruction instead, so setting it
            // over a partial directory would be the one lie this design forbids.
            ...(designReady ? { [MOTIR_DESIGN_DIR_ENV]: designRoot } : {}),
          },
        });

        if (tee || formatter) {
          // Forward FIRST, tee second: the terminal is the contract and the copy
          // is the extra. A `pipe` nobody reads fills its buffer and stalls the
          // child, so both streams are consumed unconditionally once piped.
          const forward = (
            src: NodeJS.ReadableStream | null,
            sink: NodeJS.WritableStream,
            render: (chunk: string) => string = (chunk) => chunk,
          ): void => {
            if (!src) return;
            src.setEncoding('utf8');
            src.on('data', (chunk: string) => {
              const text = render(chunk);
              if (text === '') return;
              sink.write(text);
              try {
                tee?.(text);
              } catch {
                /* an observation may never break the run it observes */
              }
            });
            src.on('error', () => {});
          };
          // stdout goes through the stream formatter when there is one, so what the
          // terminal and the log both get is the readable line, never the JSON event.
          forward(
            child.stdout,
            process.stdout,
            formatter ? (chunk) => formatter.write(chunk) : undefined,
          );
          // stderr is the agent's own words, plain text, in every form.
          forward(child.stderr, process.stderr);
        }

        child.on('error', (err: NodeJS.ErrnoException) => {
          reject(
            err.code === 'ENOENT'
              ? new CliError(`Could not launch the agent "${opts.command.binary}": not found.`, {
                  hint: 'Run `motir doctor` to check your agent command and credentials.',
                })
              : new CliError(`Could not launch the agent "${opts.command.binary}": ${err.message}`),
          );
        });

        // An agent that closes stdin early (or never reads it) makes the write
        // fail with EPIPE. That is not an error: the prompt is ALSO on disk at
        // $MOTIR_PROMPT_FILE, which is the whole reason both channels exist.
        const stdin = promptOnStdin ? child.stdin : null;
        if (stdin) {
          stdin.on('error', () => {});
          stdin.end(prompt);
        }

        child.on('close', (code, signal) => {
          // The line still open when the stream ended goes out before the verdict.
          const rest = formatter?.flush() ?? '';
          if (rest !== '') {
            process.stdout.write(rest);
            try {
              tee?.(rest);
            } catch {
              /* an observation may never break the run it observes */
            }
          }
          resolve({ exitCode: signal ? 1 : (code ?? 1), signal });
        });
      },
    );
    // Read the self-report BEFORE the `finally` takes the temp dir with it —
    // and read it whatever the exit code was: an agent that reported its model
    // and then failed still ran on that model.
    return {
      ...result,
      ...readAgentReport(reportFile),
      ...(opts.command.stream
        ? { sessionId: await sessionIdOf(opts, formatter?.sessionId() ?? null, startedAt) }
        : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
