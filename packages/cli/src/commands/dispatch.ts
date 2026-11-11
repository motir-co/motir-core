import { AgentProfileCannotRunError, CliError } from '../errors.js';
import { errVerbatim, info, outVerbatim } from '../output.js';
import { parseKinds, refuseLaneFlagConflicts } from './read.js';
import { withHostedProjectSession, withProjectSession, type ProjectSession } from '../session.js';
import {
  assertAdoptsLeaf,
  hostedRunId,
  isAgentRun,
  legAsDispatchItem,
  SANDBOX_AGENT_ENV_VAR,
  type AdoptedRun,
} from '../hostedMode.js';
import { getAgentCommand } from '../config/userConfig.js';
import {
  agentProfileById,
  agentProfileIds,
  deriveAgentHarness,
  parseAgentCommand,
  unattendedAgentCommand,
  type ParsedAgentCommand,
} from '../agentProfiles.js';
import { hostedPromptAddendum } from '../hostedAttribution.js';
import { runAgent } from '../agentRun.js';
import { hostedOpenCodeAgent } from '../hostedAgent.js';
import { prepareHostedCheckouts } from '../hostedCodegraph.js';
import type { LegBranch } from '../checkpoint.js';
import { runDispatchLeg } from '../dispatchLeg.js';
import { createDispatchRunReporter, type DispatchRunReporter } from '../dispatchRunReporter.js';
import { bindInterruptSignals, closeRunAndExit, type InterruptSignal } from '../interrupt.js';
import { createLegLogTee } from '../agentLogTee.js';
import { runCiWatchPhase, type CiWatchOutcome } from '../ciWatch.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import { execCommand, runIdFromDate, sessionBranchName, type CommandRunner } from '../git.js';
import {
  claimScopeForRun,
  readOpenChildren,
  refuseLeafOnlyFlag,
  resolveScopeTarget,
  softBlockAncestor,
  type ClaimedScope,
  type ScopeRunOptions,
} from './scope.js';
import { orderClaimedSet, type ScopeEdges, type ScopeTarget } from '../scopedRun.js';
import { drainScope, readScopeEdges } from './scopeDrain.js';
import { runCloseOutHowToTest } from '../closeOutHowToTest.js';
import { autoExitCode, renderAutoSummary } from '../autoLoop.js';
import {
  closeOutContainer,
  closeOutRepos,
  parseMax,
  requireAgent,
  type ResolvedAgent,
} from './auto.js';
import {
  autoOnlyFlagError,
  findingsPolicyOf,
  renderAgentFailure,
  renderAgentSuccess,
  renderClaimRefusal,
  pushedButUnlinked,
  unlinkedDeliveries,
  renderUnpushedRepositories,
  renderNoLinkedPullRequest,
  renderNothingPushed,
  renderFindingsPolicy,
  renderReplanSubmitted,
  renderDispatchAdvisories,
  renderDispatchSummary,
  renderPromptEchoHeader,
  renderResumeNotice,
  renderSessionOutcomes,
  resolveDispatchTarget,
  resolveDispatchTargets,
  type AgentSource,
  type FindingsPolicyOptions,
  type PromptEchoOptions,
} from '../dispatch.js';
import type {
  DispatchEventKind,
  DispatchItem,
  DispatchPrompt,
  DispatchStopReason,
  MotirClient,
  WorkItemClaim,
} from '../client.js';

// `motir next` / `motir run <key>` / `motir done <key>` — SINGLE DISPATCH
// (Story 7.9 · Subtask 7.9.3 · MOTIR-881). The heart of the CLI: take one work
// item from "ready" to "an agent is working on it", and close it out after the
// human merges.
//
// The pipeline is the same for `next` and `run`; only the SELECTION differs
// (`next_ready` picks, `run` is told which):
//
//   select → flip to in_progress → dispatch_prompt → deliver
//
// `deliver` is either `--print` (the prompt to stdout, for any agent, the BYOK
// default) or `--agent` (launch the user's agent on it and report the outcome).
//
// The CLI NEVER assembles prompt text. Every word the agent sees comes from the
// server's `dispatch_prompt` (MOTIR-1802), which is why every harness — Claude
// Code, Codex, opencode, a human reading it — gets the identical instruction
// and the grammar versions with the product.

/** The workflow status keys the CLI still names. All three are the default
 *  workflow's (lib/workflows/defaultWorkflow.ts); a project on a custom workflow
 *  surfaces the server's own allowed-targets error, which is the honest failure.
 *
 *  ⚠️ `in_progress` is NOT among them any more (MOTIR-3048): the dispatch flip
 *  happens inside the server's claim, so no path here writes that status and a
 *  constant for it would be a name with no caller. `planning` has gone the same
 *  way — the claim refuses it, so nothing here needs to recognise it. */
/** Where a FINISHED run leaves the card (MOTIR-3003 / MOTIR-3004): built, pushed,
 *  pull request open, CI not yet green. In Review is written by CI, never here. */
const IMPLEMENTED = 'implemented';
const IN_REVIEW = 'in_review';
const DONE = 'done';

/**
 * What `motir done --session` reports about how the work was implemented: the
 * SOURCE, and nothing else (MOTIR-2447).
 *
 * The bulk close-out runs after a human merged the pull request — minutes or
 * days after the agents that did the work exited. It knows the work was BYOK
 * (that is what this CLI is), and it knows nothing whatsoever about which agent
 * ran or on which model. It used to send `motir-cli/<version>` as the harness,
 * which overwrote the agent name and model `mark_integrated` had recorded during
 * the run — the fix in MOTIR-2419 undone by the very next step of the lifecycle.
 *
 * Reporting only this leaves those fields alone (the service treats an omitted
 * field as "I do not know", not "there is none") while still stamping the source
 * for the `--print` lane, whose items never reach `mark_integrated` and would
 * otherwise carry no implementation provenance at all.
 */
const CLOSE_OUT_SOURCE = 'byok' as const;

// ── agent resolution ────────────────────────────────────────────────────────

export interface DeliveryOptions extends FindingsPolicyOptions, PromptEchoOptions {
  /** `--agent <cmd>` — launch THIS agent on the prompt. */
  agent?: string;
  /** `--print` — print the prompt and stop (the default when no agent). */
  print?: boolean;
  /**
   * `--auto-approve-replan` — REGISTERED here in order to be REFUSED
   * (MOTIR-3022). `run` and `next` dispatch one item and exit, so there is no
   * continuation for an approval to feed; the flag belongs to `motir auto`.
   * Declaring it is what lets the guard's message reach the user instead of
   * commander's `unknown option` (MOTIR-1828 / MOTIR-1830).
   */
  autoApproveReplan?: boolean;
  /**
   * `--report-log` — ALSO send the agent's output to Motir (Story MOTIR-1789 ·
   * MOTIR-1794), so a failed run shows its tail on the run page.
   *
   * ⚠️ OFF BY DEFAULT, AND THE DEFAULT IS THE PROMISE. A BYOK run executes on
   * the operator's own machine, against a checkout Motir has never seen, under a
   * key Motir does not hold; its log carries file paths, source excerpts, error
   * output and possibly environment secrets. Without this flag the lifecycle
   * goes and no body does — the stripping is enforced in ONE place, in the
   * reporter, because a call site that forgot would leak and there are dozens.
   * `docs/decisions/dispatch-run-record.md` Q4 is the decision.
   */
  reportLog?: boolean;
}

/**
 * Injectable seams; never overridden in production — and deliberately NOT on
 * `DeliveryOptions`, which is the FLAG surface (`optionRegistrationAudit` holds
 * every field there to a registered option). `motir auto` and `motir batch` take
 * their seams the same way.
 */
export interface DeliveryDeps {
  /** The git runner the push check (MOTIR-3004) asks, so a test can script "the
   *  agent pushed" / "the agent pushed nothing" without a real remote. */
  run?: CommandRunner;
  /** The agent spawner, injected by the SCOPED drain's tests (MOTIR-3199) —
   *  the same seam `motir auto`'s `AutoDeps` carries, for the same reason. */
  runAgentFn?: typeof runAgent;
  /** The run clock, so a driven drain reports deterministic durations. */
  clock?: () => number;
  /** The run id, so a driven drain gets a deterministic session branch. */
  now?: () => Date;
  /** The CI watch's inter-poll wait (MOTIR-3685), so a test does not spend real
   *  seconds proving that a pending verdict does not consume the fix budget. */
  wait?: () => Promise<void>;
  /** The CI watch's POLL bound (MOTIR-3685) — distinct from the five-fix cap;
   *  a test uses it to pin the never-reports case in one call rather than 240. */
  maxCiPolls?: number;
  /**
   * Install the interrupt handler and return its remover (MOTIR-6530).
   * Production binds SIGINT and SIGTERM; a test calls the handler directly.
   */
  onInterrupt?: (handler: (signal: InterruptSignal) => void) => () => void;
  /** How the process ends after an interrupt. `process.exit` in production. */
  exit?: (code: number) => void;
}

/**
 * Resolve WHICH agent to launch, in the same priority order `motir doctor`
 * reports: `--agent`, then `MOTIR_AGENT`, then the user config's
 * `agentCommand`. Returns null when the user asked for `--print`, or when no
 * agent is configured anywhere — in which case printing IS the right behaviour
 * (BYOK's default is "hand me the prompt", not "fail").
 */
export function resolveAgent(
  opts: DeliveryOptions & { runId?: string },
  env: NodeJS.ProcessEnv = process.env,
  configured: () => string | undefined = getAgentCommand,
): { parsed: ParsedAgentCommand; source: AgentSource } | null {
  if (opts.print) return null;
  // ⚠️ A HOSTED RUN LAUNCHES ITS OWN AGENT (MOTIR-6559): OpenCode on the run's
  // model through the gateway key, on an allow-listed environment. `MOTIR_AGENT`
  // and the user config are a LOCAL person's choices and are not read — only an
  // explicit `--agent`, for someone running the hosted path by hand.
  // ⚠️ A RUN IN THE DEVELOPER'S OWN AGENT (MOTIR-7024, `agent-instance-run.md`
  // §3) launches the coding agent the agent was created with, on the
  // developer's own sign-in: the image's profile, with its unattended command.
  // Not `--agent`, not `MOTIR_AGENT`, not the config — and NEVER the hosted
  // OpenCode on Motir's gateway, whose key an agent never holds.
  if (hostedRunId(opts, env) && isAgentRun(env))
    return { parsed: agentModeAgent(env), source: 'agent' };
  if (hostedRunId(opts, env)) {
    const flagged = parseAgentCommand(opts.agent);
    if (flagged) return { parsed: flagged, source: 'flag' };
    return { parsed: hostedOpenCodeAgent(env), source: 'hosted' };
  }
  const candidates: [string | undefined, AgentSource][] = [
    [opts.agent, 'flag'],
    [env['MOTIR_AGENT'], 'env'],
    [configured(), 'config'],
  ];
  for (const [raw, source] of candidates) {
    const parsed = parseAgentCommand(raw);
    if (parsed) return { parsed, source };
  }
  return null;
}

/**
 * The command that CONTINUES the run's own agent session for the CI watch's fixing
 * iterations (MOTIR-9048), or null when a resume cannot be established — in which
 * case the watch keeps today's fresh-agent fix.
 */
export function resumeFixAgent(
  agent: ParsedAgentCommand,
  sessionId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ParsedAgentCommand | null {
  const id = sessionId?.trim();
  // The profile comes from the launched command's OWN stamp: a command no launcher
  // built (a typed --agent, MOTIR_AGENT, the config command) is never resumed on a guess.
  const profile = agent.stream?.profile;
  if (!id || !profile) return null;
  const resumed = unattendedAgentCommand(profile, agent.env ?? env, { resumeSessionId: id });
  // ⚠️ The launcher SILENTLY IGNORES the id for a profile with no streaming form (or
  // under MOTIR_AGENT_OUTPUT=text) and returns a plain, unstamped command. "A session id
  // was passed" is therefore no evidence that a resume was built — decide on what the
  // launcher RETURNED: its stamped session must be the id asked for.
  if (!resumed || resumed.stream?.sessionId !== id) return null;
  return agent.promptAddendum ? { ...resumed, promptAddendum: agent.promptAddendum } : resumed;
}

/**
 * The agent-mode launcher: the `MOTIR_SANDBOX_AGENT` profile's unattended
 * command, told how git and pull requests work in this run. Refused in words —
 * never a fallback — when the image names no profile or one with no unattended
 * form.
 */
export function agentModeAgent(env: NodeJS.ProcessEnv): ParsedAgentCommand {
  const profileId = env[SANDBOX_AGENT_ENV_VAR]?.trim();
  if (!profileId) {
    throw new CliError(`An agent-mode run needs ${SANDBOX_AGENT_ENV_VAR}.`, {
      hint: "The agent's image names its coding agent; this machine's does not.",
    });
  }
  const profile = agentProfileById(profileId);
  if (!profile) {
    throw new CliError(`"${profileId}" is not a coding agent Motir knows.`, {
      hint: `Known agents: ${agentProfileIds().join(', ')}.`,
    });
  }
  const parsed = unattendedAgentCommand(profile.id, env);
  if (!parsed) throw new AgentProfileCannotRunError(profile.id);
  return { ...parsed, promptAddendum: () => hostedPromptAddendum() };
}

/**
 * A hosted run's per-checkout preparation, or none: an agent-mode run's image
 * already wires its own agent's code graph, and the hosted preparer registers
 * OpenCode's MCP server GLOBALLY — in the developer's home (MOTIR-7024).
 */
function adoptedCheckoutPreparer(): { prepareCheckouts?: (cwds: string[]) => void } {
  return isAgentRun() ? {} : { prepareCheckouts: hostedCheckoutPreparer };
}

// ── the shared pipeline ─────────────────────────────────────────────────────

/**
 * TAKE the card — one locked call, and it can say no (MOTIR-3048).
 *
 * This is the single funnel every dispatch path in the CLI goes through, which
 * is why the claim lives here rather than being repeated in four commands that
 * could drift. It used to make TWO unlocked writes — a `PATCH { assigneeId }`
 * followed by a `transition_status` — with a read-to-write gap between them
 * that two runs starting together fell straight into. Both are now ONE
 * `POST /work-items/{key}/claim` (MOTIR-2961), which locks the row, re-asserts
 * the TO-DO category, assigns and transitions inside one transaction. **There
 * is nothing to transition afterwards: the claim IS the status flip.**
 *
 * ⚠️ IT RETURNS THE OUTCOME, AND CALLERS MUST BRANCH ON IT. Not because a
 * refusal throws — it does not, it is a 200 — but because the four answers call
 * for four different next moves, and the value of the whole change is in
 * keeping them apart rather than collapsing them back into "did it throw". This
 * function handles the one that is pure output (`mine` prints the line the
 * documented recovery has always printed) and hands the rest to the caller,
 * whose vocabulary for a refusal differs: `run` / `next` end the command,
 * `batch` / `auto` record a SKIP and keep going.
 */
export async function ensureInProgress(client: MotirClient, key: string): Promise<WorkItemClaim> {
  const claim = await client.claimWorkItem({ key });
  if (claim.outcome === 'mine') {
    info(`${key}: already In Progress — leaving the status as it is.`);
  }
  return claim;
}

/**
 * May this run dispatch, given what the claim resolved to?
 *
 * `claimed` and `mine` are both a yes — the second is the interrupted run this
 * session is resuming, which is the recovery `motir run <key>` exists to serve.
 * Exported so the four entry points ask the SAME question rather than each
 * writing its own list of outcome strings.
 */
export function claimAllowsDispatch(claim: WorkItemClaim): boolean {
  return claim.outcome === 'claimed' || claim.outcome === 'mine';
}

/**
 * Echo the prompt this dispatch is about to send, if the run asked for it
 * (`--print-prompt`, MOTIR-3052).
 *
 * ⚠️ ONE implementation for every dispatch site, and it lives HERE rather than
 * beside its renderer in `../dispatch.js` because that module is the PURE half
 * and writes to no stream. `motir auto` and `motir batch` already import this
 * module for `ensureInProgress` / `claimAllowsDispatch`, so the four commands
 * share one writer instead of four `process.stderr.write` calls that could
 * drift on the byte that matters.
 *
 * ⚠️ IT ECHOES `dispatch.prompt` AND NEVER RE-ASSEMBLES. The prompt is already
 * in memory at every call site — the CLI has never assembled prompt text and
 * must not start here — because a transcript regenerated for display is one that
 * can disagree with the run it claims to describe, which is worse than none.
 *
 * ⚠️ AND EVERY CALLER INVOKES IT BEFORE THE AGENT STARTS. The run you most want
 * a transcript for is the one that went wrong, so the prompt must already be on
 * the stream when the agent then fails, times out, or is killed.
 *
 * The header goes through `info` (narration); the prompt through `errVerbatim`,
 * which terminates it with exactly one newline and changes nothing else — so a
 * reader slicing the header off a captured stderr holds the string the agent
 * received, byte for byte.
 */
export function echoPromptIfAsked(
  opts: PromptEchoOptions,
  key: string,
  dispatch: DispatchPrompt,
): void {
  if (!opts.printPrompt) return;
  info(renderPromptEchoHeader(key, dispatch));
  errVerbatim(dispatch.prompt);
}

export interface DeliverInput {
  session: ProjectSession;
  /** Which command converged here — the one thing `next` and `run` differ in
   *  that the run RECORD has to know, so a person reading a run page can tell a
   *  picked card from a named one. `continue` (MOTIR-6533) arrives with its run
   *  already open — see {@link DeliverInput.reporter}. */
  command: 'next' | 'run' | 'continue';
  /**
   * A reporter that ALREADY holds this delivery's run (MOTIR-6533). `motir
   * continue`'s run is opened by the server's continue claim, inside the lock that
   * decided the takeover, so it is ADOPTED rather than opened here — and the
   * server wrote its `run_opened` event. Absent for `next` / `run`, which open
   * their own.
   */
  reporter?: DispatchRunReporter;
  key: string;
  title: string | null;
  dispatch: DispatchPrompt;
  opts: DeliveryOptions;
  deps: DeliveryDeps;
  /**
   * The run the SERVER opened, when this is a hosted run (MOTIR-6558) — the
   * reporter ADOPTS it instead of opening one. Null on every local run, which
   * opens its own exactly as before.
   */
  adoptedRunId?: string | null;
  /**
   * Every repository's branch, for a `continue` (MOTIR-6793): the leg records and
   * checkpoints THESE rather than the card's fresh branch. Absent otherwise.
   */
  continueBranches?: LegBranch[];
}

/**
 * Deliver the prompt: print it, or run the agent on it and record the outcome.
 * This is the ONE place both `next` and `run` converge, so their behaviour can
 * never drift.
 */
export async function deliver(input: DeliverInput): Promise<void> {
  const { session, key, title, dispatch, opts, deps } = input;
  const { client, link, serverUrl, projectKey } = session;

  const agent = resolveAgent(opts);
  // MOTIR-3133 — one target per repository the card ships in, resolved by the
  // SAME rule, in the payload's order. The agent's cwd is element 0's — one
  // dispatch, one agent process, standing in the primary's checkout exactly as
  // it does today. An older server sends no `targetRepos`, and the empty set
  // falls straight back to the single-repository resolve.
  const targets = resolveDispatchTargets(
    link.dir,
    link.config,
    // The clone URL travels WITH the name (MOTIR-3588): a checkout that is
    // missing but materializable resolves to `clonable_checkout` rather than to
    // the workspace root.
    (dispatch.targetRepos ?? []).map((repo) => ({ name: repo.name, cloneUrl: repo.cloneUrl })),
  );
  const target =
    targets[0] ??
    resolveDispatchTarget(link.dir, link.config, dispatch.targetRepo, {
      cloneUrl: dispatch.targetRepoCloneUrl ?? null,
    });
  const summary = renderDispatchSummary({
    key,
    title,
    dispatch,
    target,
    targets,
    agent: agent ? { command: agent.parsed.command, source: agent.source } : null,
  });

  // The PROSE-vs-GRAPH warning (MOTIR-2079). It is emitted HERE, in the shared
  // `deliver`, precisely because `next` and `run` converge here — one site, and
  // the two commands can never drift on whether the human is told. It is a
  // WARNING: nothing below branches on it, no exit code changes, and no `--force`
  // is involved (see `renderDispatchAdvisories` for why a refusal would be wrong).
  const advisory = renderDispatchAdvisories(dispatch);
  // MOTIR-3136 — a partially delivered card is a legitimate resting state, and
  // a resumed run that reads like a fresh one is how an agent re-opens a pull
  // request in a repository that has already merged.
  const resume = renderResumeNotice(dispatch);

  // The policy this run used, said out loud (MOTIR-3022). Without it a run whose
  // agent FILED nothing is indistinguishable from one that was not allowed to,
  // and `--print` would show a prompt whose missing branch had no explanation.
  const policyLine = renderFindingsPolicy(opts);

  if (!agent && input.adoptedRunId) {
    // ⚠️ A HOSTED RUN HAS NOBODY TO PASTE A PROMPT. Print mode is the local
    // default because a person is at the terminal; in a container the default
    // would end the run having done nothing, with the card claimed.
    throw new CliError('A hosted run needs an agent to launch.', {
      hint: 'A hosted run launches OpenCode itself; --print is not available on one.',
    });
  }

  if (!agent) {
    // PRINT mode: the prompt is the PAYLOAD (stdout, byte-identical), the
    // summary is DIAGNOSTICS (stderr). That split is what lets
    // `motir next --print | pbcopy` copy the prompt and nothing else, while the
    // user still sees the repo + resolved path on screen.
    //
    // ⚠️ The policy line is DIAGNOSTICS too — it goes to stderr with the rest,
    // never into the payload, and the prompt above it is the one the agent
    // would actually receive. There is no preview-only assembly.
    info(summary);
    if (resume) info(resume);
    if (advisory) info(advisory);
    info(policyLine);
    info('');
    // ⚠️ BOTH STREAMS, and exactly once each. `--print` and `--print-prompt`
    // COMPOSE (MOTIR-3052): the payload copy goes to stdout because that is what
    // `--print` is for, and the transcript copy to stderr because that is where
    // this flag always puts it. Emitting the stderr copy first keeps the echo in
    // the same position relative to the summary as it holds on the agent path
    // below, so `2> prompts.log` reads the same either way.
    echoPromptIfAsked(opts, key, dispatch);
    outVerbatim(dispatch.prompt);
    return;
  }

  info(summary);
  if (resume) info(resume);
  if (advisory) info(advisory);
  info(policyLine);

  // ⚠️ THE SHARED LEG (MOTIR-3695) — materialize-before-spawn (MOTIR-3588),
  // echo-before-spawn (MOTIR-3052), exit-0-is-not-an-outcome (MOTIR-3018) and
  // exit-0-is-not-a-push (MOTIR-3004), in that order, from the one place that
  // implements them. `motir batch` runs the same function; what each command
  // does with the VERDICT is where they legitimately differ, and that stays
  // here.
  // THE RUN RECORD (Story MOTIR-1789 · MOTIR-1794) — opened here, with a SET OF
  // ONE, which is the degenerate case of the same object a scoped run opens with
  // eleven. It carries the run id `runIdFromDate` already produced, so the branch
  // a reviewer sees and the run row in Motir name the same run.
  //
  // ⚠️ EVERYTHING BELOW IS BEST-EFFORT AND CANNOT FAIL THIS DISPATCH. The
  // reporter swallows its own failures by construction; there is deliberately no
  // error handling at this call site, because handling would imply there is
  // something a caller could do.
  // ⚠️ A HOSTED RUN ALWAYS REPORTS ITS AGENT'S OUTPUT (MOTIR-6559). The stall
  // watchdog ends a run with no event inside its window, and the agent's own
  // output is the only thing a long step produces — the entrypoint this replaces
  // teed it unconditionally, for exactly that reason.
  const adopted = input.reporter !== undefined;
  const reporter =
    input.reporter ??
    createDispatchRunReporter({
      client,
      reportLogBodies: opts.reportLog === true || Boolean(input.adoptedRunId),
    });
  if (!adopted) {
    if (input.adoptedRunId) {
      // ⚠️ ADOPT, NEVER OPEN, A HOSTED RUN (MOTIR-6558). The server opened it with
      // this card as its leg and wrote its `run_opened`; a second open would be a
      // second run for one dispatch, and the fleet, the gateway and motir-ai all
      // already name the first (`hosted-agent-run.md` §1).
      reporter.adopt(input.adoptedRunId);
    } else {
      await reporter.open({
        projectKey,
        command: input.command,
        runId: runIdFromDate((deps.now ?? (() => new Date()))()),
        cards: [{ key, disposition: 'queued' }],
        // `agent` is non-null here by construction — the PRINT arm above returns
        // before this line, and printing a prompt is not a run. Written flat rather
        // than guarded, because a guard on a value that cannot be null is a branch
        // no test can reach and a reader has to stop and disprove.
        agent: agent.parsed.binary,
      });
      reporter.event({ kind: 'run_opened', data: { command: input.command, key } });
    }
  }
  // An adopted run's `run_opened` was written by whoever opened it — `motir
  // continue`'s claim (MOTIR-6533) or the hosted run's own open (MOTIR-6558).

  // ⚠️ A STOP IS A DECISION, AND THE RECORD SAYS SO (MOTIR-6530): Ctrl-C or a
  // SIGTERM closes the run `interrupted` after flushing what is queued, rather
  // than leaving it to read `running` until its heartbeat lapses. No work-item
  // status moves — the card stays exactly where the work left it.
  const detachInterrupt = (deps.onInterrupt ?? bindInterruptSignals)((signal) => {
    info('');
    info(`Interrupted — closing the run of ${key}.`);
    void closeRunAndExit(reporter, signal, deps.exit);
  });
  try {
    const verdict = await runDispatchLeg({
      client,
      rootDir: link.dir,
      key,
      dispatch,
      agent: agent.parsed,
      targets,
      primary: target,
      sessionBranch: dispatch.sessionBranch,
      reporter,
      onMaterialization: (lines: string[]) => {
        for (const line of lines) info(line);
      },
      beforeSpawn: () => {
        info('');
        echoPromptIfAsked(opts, key, dispatch);
      },
      ...(deps.run ? { run: deps.run } : {}),
      ...(input.continueBranches ? { branches: input.continueBranches } : {}),
      // A hosted container's checkouts are fresh clones: index them before the
      // agent starts, as the image's entrypoint used to (MOTIR-6560).
      ...(input.adoptedRunId ? adoptedCheckoutPreparer() : {}),
    });

    if (verdict.kind === 'checkout_unavailable') {
      await reporter.close('halted');
      process.exitCode = 1;
      return;
    }

    if (verdict.kind === 'agent_failed') {
      // The item stays In Progress on purpose — work was started. Record it so
      // the next `motir next` moves past it instead of re-picking the failure.
      addExclude(serverUrl, projectKey, { key });
      info('');
      info(renderAgentFailure(key, verdict.exitCode, dispatch));
      // Surface the agent's own exit code as ours: a script wrapping `motir next`
      // must be able to tell a failed run from a successful one.
      await reporter.close('halted');
      process.exitCode = verdict.exitCode;
      return;
    }

    // ⚠️ EXIT 0 IS NOT AN OUTCOME (MOTIR-3018). A finished card and a REFUSED one
    // both exit 0, so the run asks the card which it was before deciding anything
    // else. This read comes FIRST — before the push check — because a refusing
    // agent reverts its worktree and pushes nothing by design, so the push check
    // would otherwise report a correctly-refused card as work that went missing.
    if (verdict.kind === 'replan_submitted') {
      // Nothing to exclude: `planning` is in the in-progress CATEGORY, so the card
      // is already out of the pickable set — which is the entire reason that
      // status exists (MOTIR-2425). Adding it to the session exclude list would
      // record a local opinion about a card the server already holds back.
      info('');
      info(renderReplanSubmitted(key));
      // ⚠️ `replanned`, NOT `halted`. The agent read its card, found the premise
      // false, submitted a plan and exited 0 — a CORRECT outcome, and a run summary
      // that called it a failure would teach an operator to ignore failures.
      await reporter.close('replanned');
      return;
    }

    // ⚠️ EXIT 0 IS NOT A PUSH (MOTIR-3004). `implemented` says the code is on the
    // remote and the pull request is open — a claim this run can only make by
    // checking. An agent that exits 0 having pushed nothing leaves a card asserting
    // built work that exists only in a worktree the run is about to delete, so the
    // recording is refused and the card stays In Progress, which is what an
    // interrupted run actually looks like.
    if (verdict.kind === 'nothing_pushed') {
      addExclude(serverUrl, projectKey, { key });
      info('');
      info(renderNothingPushed(key, dispatch));
      await reporter.close('completed');
      return;
    }

    // ⚠️ PUSHED, BUT LINKED TO NOTHING (MOTIR-10877). The leg linked every pull request it
    // could find (`runDelivery.ts`); one that found none must not report a clean
    // Implemented — that is the card nothing closes on merge and no CI watch can see. The
    // leg records why, naming each branch, and the card stays In Progress.
    //
    // ⚠️ AND A PARTIAL DELIVERY IS NOT IMPLEMENTED EITHER (MOTIR-10888). A card spanning two
    // repositories whose second pull request could not be linked would complete on the first
    // merge, because Motir completes a card on its LINKED pull requests alone — so the leg
    // names each pushed-but-unlinked branch beside the pull requests that did link.
    if (pushedButUnlinked(verdict)) {
      const delivery = verdict.delivery;
      const unlinked = unlinkedDeliveries(delivery);
      const partial = delivery.linked.length > 0;
      addExclude(serverUrl, projectKey, { key });
      reporter.event({
        kind: 'card_settled',
        workItemKey: key,
        disposition: 'failed',
        data: {
          reason: partial ? 'unlinked_pull_request' : 'no_linked_pull_request',
          branches: unlinked.map((u) => ({
            repository: u.repository,
            branch: u.branch,
            detail: u.reason,
          })),
          ...(partial
            ? { linked: delivery.linked.map((d) => ({ repository: d.repository, url: d.url })) }
            : {}),
        },
      });
      info('');
      info(renderNoLinkedPullRequest(key, unlinked, delivery.linked));
      await reporter.close('halted');
      process.exitCode = 1;
      return;
    }

    // Exit 0 AND the work is on the remote: the agent completed the prompt's GIT
    // WORKFLOW section, whose last step is opening the PR / integrating the
    // branch. Both modes therefore land the item at IMPLEMENTED — built, pushed,
    // and waiting on CI, which is the step of the lifecycle this run can vouch for.
    if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
      await client.markIntegrated({
        key,
        sessionBranch: dispatch.sessionBranch,
        // Same split as the loop's (MOTIR-2419): the harness names the agent this
        // command launched — not the CLI that launched it — and the model is the
        // agent's own report, or null.
        implementationHarness: deriveAgentHarness(agent.parsed.binary),
        implementationModel: verdict.model,
      });
    } else {
      await client.transitionStatus({ key, status: IMPLEMENTED });
    }
    // A listed repository the run pushed nothing to is recorded on the leg too (MOTIR-10888),
    // so the run says it was left alone rather than leaving a reader to wonder.
    const unpushed = verdict.delivery?.unlinked ?? [];
    reporter.event({
      kind: 'card_settled',
      workItemKey: key,
      disposition: 'implemented',
      ...(dispatch.sessionBranch ? { sessionBranch: dispatch.sessionBranch } : {}),
      ...(unpushed.length > 0
        ? {
            data: {
              unlinked: unpushed.map((u) => ({
                repository: u.repository,
                branch: u.branch,
                detail: u.reason,
                pushed: u.pushed,
              })),
            },
          }
        : {}),
    });
    removeExclude(serverUrl, projectKey, key);

    // EVERY repository of the set, not only the primary (MOTIR-3133): a card whose
    // second half had no checkout to happen in is exactly the run that otherwise
    // exits 0 with half the work missing.
    //
    // ⚠️ A WARNING here, and a FAILURE in `motir batch` — the leg reports the
    // suspects and lets each command decide, because the two genuinely disagree
    // and a refactor is not the place to settle it.
    const suspects = verdict.suspects;
    info('');
    info(renderAgentSuccess(key, dispatch));
    if (unpushed.length > 0) {
      info('');
      info(renderUnpushedRepositories(key, unpushed));
    }
    for (const suspect of suspects) {
      info('');
      info(suspect.message);
      info(`Hint: ${suspect.hint}`);
    }

    // ── THE CI WATCH (Story MOTIR-3655 · MOTIR-3685) ──────────────────────────
    //
    // `motir run` has no next card, so it simply watches its own until CI speaks:
    // green ends the run, red dispatches a fixing iteration, and the sixth red
    // gives up non-zero. A red check does NOT move the card — `implemented` is
    // exactly right for code that is committed and whose build has not spoken.
    const ciLogTee = createLegLogTee(reporter, key);
    const resumeAgent = resumeFixAgent(agent.parsed, verdict.sessionId);
    const watch = await runCiWatchPhase({
      client,
      key,
      title,
      agent: agent.parsed,
      // The fix arrives in the conversation that built the branch (MOTIR-9048); a
      // command that cannot be resumed leaves today's fresh-agent fix.
      ...(resumeAgent ? { resumeAgent } : {}),
      cwd: target.cwd,
      report: (line) => info(line),
      // The watch's sign of life, and the fixing agent's output (MOTIR-8979): the
      // server reads the run's latest event to decide a run has stalled, so a
      // watch that writes none is killed after 15 minutes of CI.
      onEvent: (event) => reporter.event({ ...event, workItemKey: key }),
      ...(ciLogTee ? { onOutput: ciLogTee.write } : {}),
      ...(deps.wait ? { wait: deps.wait } : {}),
      ...(deps.runAgentFn ? { runAgentFn: deps.runAgentFn } : {}),
      ...(deps.maxCiPolls === undefined ? {} : { maxPolls: deps.maxCiPolls }),
    });
    ciLogTee?.flush();
    // ⚠️ NON-ZERO on a give-up, and it must be obvious it gave up rather than
    // succeeded: the card is at `implemented` either way, and a script wrapping
    // `motir run` can only tell the two apart by the exit code.
    // ⚠️ TWO TOTAL LOOKUPS, NOT TWO CONDITIONALS. Both are keyed on the watch's
    // own closed vocabulary, so adding a `CiWatchOutcome` member is a TYPE ERROR
    // here rather than a silent fall-through to the `else` — the same totality the
    // ADR asks of every renderer of a closed enum. It also adds no branch to a
    // function whose per-file coverage gate is real: a ternary here would be an
    // arm no test reaches, on a tail that already has one.
    reporter.event({ kind: CI_WATCH_EVENT[watch.kind], workItemKey: key, data: watch });
    if (watch.kind === 'gave_up' || watch.kind === 'fix_failed') process.exitCode = 1;
    await reporter.close(CI_WATCH_STOP_REASON[watch.kind]);
  } finally {
    detachInterrupt();
  }
}

/**
 * The run event each CI-watch outcome produces — TOTAL over `CiWatchOutcome`.
 *
 * `nothing` reports a `ci_verdict` like the rest: *there was nothing to watch*
 * is a verdict a person reading a run page needs, and it is NOT the same as
 * green (`ciWatch.ts` says so in its own words — a card whose pull requests are
 * unknown to this build has not been shown to pass).
 */
export const CI_WATCH_EVENT = {
  green: 'ci_verdict',
  nothing: 'ci_verdict',
  gave_up: 'ci_gave_up',
  fix_failed: 'ci_gave_up',
} as const satisfies Record<CiWatchOutcome['kind'], DispatchEventKind>;

/**
 * The run's stop reason for each CI-watch outcome — TOTAL over the same union.
 *
 * `halted` ONLY on a give-up. A green watch, and a run with nothing to watch,
 * both ended the way they meant to.
 */
export const CI_WATCH_STOP_REASON = {
  green: 'completed',
  nothing: 'completed',
  gave_up: 'halted',
  fix_failed: 'halted',
} as const satisfies Record<CiWatchOutcome['kind'], DispatchStopReason>;

/**
 * Refuse `--auto-approve-replan` on a command with no loop to continue into —
 * BEFORE anything else, so nothing is claimed for a run that cannot proceed.
 *
 * The flag is registered on these commands precisely so this message is
 * reachable; without the registration commander answers `unknown option` and
 * this function is dead code from the command line (MOTIR-1828 / MOTIR-1830).
 */
function refuseAutoOnlyFlag(opts: DeliveryOptions, command: 'run' | 'next'): void {
  if (!opts.autoApproveReplan) return;
  const { message, hint } = autoOnlyFlagError(command);
  throw new CliError(message, { hint });
}

// ── motir next ──────────────────────────────────────────────────────────────

export interface NextOptions extends DeliveryOptions {
  kinds?: string;
  /** `--reset` — clear this project's session exclude list first. */
  reset?: boolean;
  /** `--parent` — run the next runnable CONTAINER as a parent run (MOTIR-6837). */
  parent?: boolean;
  /** `--bug` — take the next BUG instead of the next leaf (MOTIR-6837). */
  bug?: boolean;
}

/**
 * `motir next` — the next item of ONE ready lane (Story MOTIR-6829 ·
 * MOTIR-6837). By default the next LEAF, never a bug. `--parent` takes the next
 * runnable container and runs it exactly as `motir run <KEY>` does — the same
 * function, so a parent run has one implementation. `--bug` takes the next bug:
 * a childless bug dispatches as a leaf, and a bug's subtask runs its bug as a
 * parent run.
 */
export async function nextCommand(opts: NextOptions, deps: DeliveryDeps = {}): Promise<void> {
  refuseAutoOnlyFlag(opts, 'next');
  refuseLaneFlagConflicts(opts);
  if (opts.parent) {
    // `motir run <container> --print`'s own refusal, verbatim: a parent run has
    // no single prompt to print.
    refuseLeafOnlyFlag(opts);
    const key = await pickLaneContainer(opts);
    if (key) await runCommand(key, opts, deps);
    return;
  }
  const kinds = parseKinds(opts.kinds);
  const lane = opts.bug ? 'bug' : 'leaf';
  let runWhole: string | null = null;
  await withProjectSession(async (session) => {
    const { client, serverUrl, projectKey } = session;
    if (opts.reset) {
      const cleared = clearExcludes(serverUrl, projectKey);
      info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
    }
    const excluded = readExcludes(serverUrl, projectKey);
    if (excluded.length > 0) {
      info(`Skipping ${excluded.length} previously-failed item(s): ${keyList(excluded)}.`);
    }

    const ownerId = await resolveOwnerId(client);
    const item = await claimNextNotExcluded(client, projectKey, kinds, excluded, ownerId, lane);
    if (!item) {
      info(
        excluded.length > 0
          ? `No ready work items in the ${lane} lane (excluding the skipped ones — \`motir next --reset\` to retry them).`
          : `No ready work items in the ${lane} lane.`,
      );
      return;
    }
    // A BUG'S SUBTASK runs its bug whole, as a parent run (MOTIR-6837) — outside
    // this session, through `runCommand`, exactly as `motir run <bug>` would.
    if (lane === 'bug' && item.containerKey) {
      runWhole = item.containerKey;
      return;
    }

    const claim = await ensureInProgress(client, item.key);
    if (!claimAllowsDispatch(claim)) {
      // The server refused between the pick and the claim — a sibling took it,
      // or it left the to-do category. `next` has nothing else in hand, so it
      // reports and ends: re-running picks whatever is next.
      info(renderClaimRefusal(claim));
      return;
    }
    const dispatch = await client.dispatchPrompt(item.key, {
      findingsPolicy: findingsPolicyOf(opts),
    });
    await deliver({
      session,
      command: 'next',
      key: item.key,
      title: item.title,
      dispatch,
      opts,
      deps,
    });
  });
  if (runWhole) {
    refuseLeafOnlyFlag(opts);
    await runCommand(runWhole, opts, deps);
  }
}

/**
 * The next runnable container not on the persisted exclude list — `motir next
 * --parent`'s pick (MOTIR-6837). The exclude list is keyed by KEY and a
 * container's key is its own, so the one store serves every lane. `null` (and
 * the empty-lane line) when the containers lane has nothing left.
 */
async function pickLaneContainer(opts: NextOptions): Promise<string | null> {
  return withProjectSession(async ({ client, serverUrl, projectKey }) => {
    if (opts.reset) {
      const cleared = clearExcludes(serverUrl, projectKey);
      info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
    }
    const excluded = readExcludes(serverUrl, projectKey);
    const { container } = await client.nextReadyContainer({
      projectKey,
      ...(excluded.length > 0 ? { excludeKeys: excluded.map((e) => e.key) } : {}),
    });
    if (!container) {
      info('No ready work items in the container lane.');
      return null;
    }
    info(`Next container: ${container.key} — ${container.title}.`);
    return container.key;
  });
}

/**
 * The token owner's user id — who a claim assigns to (MOTIR-2427).
 *
 * One `whoami` per command invocation, not per item: the answer cannot change
 * inside a run, and an unattended loop that asked per dispatch would spend a
 * request on a constant.
 */
export async function resolveOwnerId(client: MotirClient): Promise<string> {
  return (await client.whoami()).user.id;
}

/**
 * A hosted run's per-checkout preparation (MOTIR-6560): its code graph, built
 * once the CLI has cloned the checkout and before the agent is spawned on it.
 * Best-effort — every failure is a line on the transcript, never a stop.
 */
export function hostedCheckoutPreparer(cwds: string[]): void {
  prepareHostedCheckouts(cwds, (line) => info(line));
}

/**
 * The same answer for a HOSTED run (MOTIR-6558), from `getMe` alone: a run's own
 * credential reads who it is and nothing wider — `whoami`'s workspace list is a
 * route it is refused (`lib/hostedRuns/runTokenRoutes.ts`).
 */
export async function resolveHostedOwnerId(client: MotirClient): Promise<string> {
  return (await client.me()).id;
}

/**
 * Why a NAMED card would not have been picked — or null when it would have been.
 *
 * ONE axis now: WHOSE it is (MOTIR-3048). It used to warn about WHERE it is too
 * — `in_review`, `planning` — and then dispatch anyway, on the reasoning that a
 * person who names a key has a reason. That is a good argument about ownership
 * and a bad one about state, and the server settles the state half now: the
 * claim refuses anything outside the TO-DO category, so those two warnings
 * would describe outcomes that can no longer happen. A warning for something
 * that cannot occur is noise, and eventually a lie.
 *
 * The assignee axis stays here because it is the one the server deliberately
 * does NOT refuse: a to-do card assigned to a teammate is still claimable, and
 * taking a card off somebody is a thing a person is allowed to decide. They
 * just have to be told they are doing it.
 */
export function pickWarning(
  item: { status: string; assigneeId: string | null },
  ownerId: string,
): string | null {
  if (item.assigneeId !== null && item.assigneeId !== ownerId) {
    return 'assigned to someone else — dispatching it anyway will put two agents on one work item.';
  }
  return null;
}

/**
 * The next ready item that is not on the persisted exclude list.
 *
 * The persisted list is keyed by KEY (MOTIR-2338) and so is the ready row, so
 * there is nothing to translate: the keys go straight to the client, which
 * skips them as it walks the ranked page (MOTIR-2398). One call, no round trip
 * per excluded item, and no row id anywhere.
 *
 * The SERVER still chooses. The client skips what this run has already tried
 * and takes the next row in the order it was given — a client that re-ranked
 * would be re-deriving the dispatch order the ready endpoint exists to own.
 */
async function claimNextNotExcluded(
  client: MotirClient,
  projectKey: string,
  kinds: string[] | undefined,
  excluded: readonly { key: string }[],
  ownerId: string,
  lane: 'leaf' | 'bug' = 'leaf',
): Promise<DispatchItem | null> {
  // ONE call. The hold-out is applied inside the client's page walk (MOTIR-2398),
  // so the ask-learn-the-id-ask-again loop this used to need is gone: the
  // exclusion list is keyed by KEY and so is the ready row.
  const { item } = await client.nextReady({
    projectKey,
    ownerId,
    lanes: [lane],
    ...(kinds ? { kinds } : {}),
    ...(excluded.length > 0 ? { excludeKeys: excluded.map((e) => e.key) } : {}),
  });
  return item;
}

function keyList(entries: { key: string }[]): string {
  return entries.map((e) => e.key).join(', ');
}

// ── motir run <key> ─────────────────────────────────────────────────────────

export interface RunOptions extends DeliveryOptions, ScopeRunOptions {
  /** `--force` — dispatch even though the item is not ready (HARD or SOFT). */
  force?: boolean;
  /** `--allow-soft-block` — see `ScopeRunOptions.allowSoftBlock` (MOTIR-6355). */
  allowSoftBlock?: boolean;
  /** `--max <n>` — stop after n cards of a SCOPE. Leaf runs ignore it. */
  max?: string;
  /** `--keep-going` — continue a SCOPE past a failed agent. */
  keepGoing?: boolean;
  /**
   * `--run-id <id>` — ADOPT this run the server opened instead of opening one
   * (MOTIR-6558): the hosted mode. `MOTIR_DISPATCH_RUN_ID` is its env twin.
   */
  runId?: string;
}

/**
 * Build the refusal for a not-ready item. Readiness is DEPENDENCY-ONLY, so the
 * message names the open blockers: the human then decides whether the override
 * is correct (they may know the blocker is about to merge). That is why
 * `--force` exists at all rather than the CLI silently deciding.
 */
export function notReadyError(detail: {
  identifier: string;
  openBlockers: { identifier: string; title: string }[];
  blockedByAncestor: { identifier: string } | null;
  /** Whether `--allow-soft-block` was passed — and failed to cover this block. */
  allowSoftBlock?: boolean;
}): CliError {
  const reasons: string[] = detail.openBlockers.map((b) => `${b.identifier} (${b.title})`);
  if (detail.blockedByAncestor) {
    reasons.push(`its ancestor ${detail.blockedByAncestor.identifier} is blocked`);
  }
  const because = reasons.length > 0 ? ` Waiting on: ${reasons.join(', ')}.` : '';
  // The hint names the override that FITS the block (MOTIR-6355). A SOFT block —
  // no open blocker of its own, only an ancestor's — is what `--allow-soft-block`
  // exists for; a HARD one (its own open `blocked_by`) only `--force` passes.
  const soft = detail.openBlockers.length === 0 && detail.blockedByAncestor !== null;
  const hint = soft
    ? `It is held only by its ancestor's block (SOFT). Pass --allow-soft-block to dispatch it anyway.`
    : detail.allowSoftBlock
      ? `--allow-soft-block overrides only an ancestor's block; this item's own blocker is open (HARD). Pass --force to dispatch it anyway.`
      : `Pass --force to dispatch it anyway.`;
  return new CliError(`${detail.identifier} is not ready.${because}`, { hint });
}

/**
 * `--force` already overrides a HARD and a SOFT block, so naming both is not a
 * stronger request — it is a confused one, and refused before anything is read.
 */
function refuseRedundantOverride(opts: RunOptions): void {
  if (opts.force && opts.allowSoftBlock) {
    throw new CliError('`--allow-soft-block` is redundant with `--force`.', {
      hint: '`--force` already overrides both a HARD and a SOFT block; pass one of them, not both.',
    });
  }
}

export async function runCommand(
  key: string,
  opts: RunOptions,
  deps: DeliveryDeps = {},
): Promise<void> {
  refuseAutoOnlyFlag(opts, 'run');
  refuseRedundantOverride(opts);
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir run ACME-7`.');

  // ── HOSTED OR LOCAL? (MOTIR-6558) ─────────────────────────────────────────
  // A run id — `--run-id`, or `MOTIR_DISPATCH_RUN_ID` from the hosted image —
  // means the server has ALREADY opened this run and claimed its cards; this
  // process adopts it. Everything below is the one pipeline either way: the
  // hosted arm changes where the session comes from, who opened the run and
  // where the scope's members come from, and nothing else.
  const adoptId = hostedRunId(opts);
  const enter = (fn: (session: ProjectSession, adopted: AdoptedRun | null) => Promise<void>) =>
    adoptId
      ? withHostedProjectSession(adoptId, fn, trimmed)
      : withProjectSession((session) => fn(session, null));

  if (adoptId && opts.includePlanning) {
    // ⚠️ An expansion is an AI PLANNING surface a run's credential is refused, and
    // what it produces is a plan a person approves — nothing a hosted run could
    // wait for. Refused up front, before anything is read.
    throw new CliError('`--include-planning` is not available on a hosted run.', {
      hint: 'Expand the story in Motir, approve the plan, then run it hosted.',
    });
  }

  await enter(async (session, adopted) => {
    const { client } = session;
    // An agent-mode run whose image cannot run unattended is refused HERE,
    // before any card is claimed or cloned (MOTIR-7024) — not at the spawn.
    if (adopted && isAgentRun()) agentModeAgent(process.env);

    // ── SCOPE or CARD? The SHAPE decides (MOTIR-3195 / MOTIR-3198) ──────────
    //
    // `motir run` takes a SCOPE now: a work-item key, or the reserved word
    // `sprint`. Which run it performs is decided by what the target turns out to
    // be — a leaf falls through to everything below, unchanged, byte for byte;
    // a container with children runs its leaves; an epic and a childless
    // container are refused, by `resolveScopeTarget`, with the copy the ADR
    // spells out.
    //
    // ⚠️ THIS BRANCH COSTS NOTHING, AND THAT IS LOAD-BEARING.
    // `resolveScopeTarget` makes the SAME `getWorkItem` read this function
    // already made as its first act — one line earlier — and HANDS IT BACK on
    // the leaf arm. Re-reading it here instead would put a second round-trip on
    // the path every dispatched card takes, to save threading one value.
    const decision = await resolveScopeTarget(client, trimmed, opts, session.serverUrl);
    if (decision.action === 'stop') return;
    if (decision.action === 'scope') {
      refuseLeafOnlyFlag(opts);
      // An agent is REQUIRED here, unlike on the leaf path where `--print` is the
      // default: a set has no single prompt to paste, so there is nothing for a
      // print-mode scoped run to do. The message is `motir auto`'s, verbatim,
      // because it is the same requirement for the same reason.
      const agent = requireAgent({ ...opts, print: false }, 'motir run <scope>');
      if (adopted && decision.target.kind !== 'work_item') {
        throw new CliError('A hosted run adopts a work item scope, not a sprint.', {
          hint: 'The server opens a hosted run on the card that was dispatched.',
        });
      }
      // ⚠️ A HOSTED SCOPE IS NOT CLAIMED HERE (MOTIR-6558). The server already
      // claimed it and opened the run with its members, in claim order — so the
      // members are READ BACK from the run's legs, never re-derived from a ready
      // set the claim has already emptied. Each leg is still re-claimed by
      // `dispatchOne` exactly as locally, which answers `mine` for a card the
      // server claimed for this dispatcher and refuses one somebody else holds.
      const claimed =
        adopted && decision.target.kind === 'work_item'
          ? await adoptScope(client, decision.target, adopted, session.projectKey)
          : await claimScopeForRun(
              session,
              decision.target,
              opts,
              await resolveOwnerId(client),
              decision.readiness,
            );
      if (!claimed) return;

      // The session branch names the run. A hosted run's is the server's run id,
      // so the branch, the run page and the fleet all name the same run.
      const runId = adopted ? adopted.runId : runIdFromDate((deps.now ?? (() => new Date()))());
      const branch = sessionBranchName(runId);
      const run = deps.run ?? execCommand;
      // ⚠️ A HOSTED SCOPE (`claimed.claim === null`, MOTIR-6558) is handled
      // inline here rather than through `runClaimedScope` (MOTIR-6535, used by
      // `motir continue <parent>`): that helper's `ClaimedScope` requires a real
      // claim to read `scope.name`/`outcome` off, which a hosted scope has none
      // of — its set is the run's own legs, adopted rather than claimed.

      // ── THE RUN RECORD (Story MOTIR-1789 · MOTIR-1794) ──────────────────
      //
      // ⚠️ OPENED WITH THE CLAIM'S FULL MEMBER SET, IN `orderClaimedSet` ORDER,
      // and this is the operation the whole record is shaped around. The claim
      // has just locked every member — including the ones that are not startable
      // yet — and the order has just been computed from edges the run already
      // holds. That knowledge exists for exactly one moment, in one process:
      // rebuilt afterwards from per-card events it becomes a list of what the
      // run got round to, and the SKIPPED cards vanish entirely.
      //
      // The order comes from the SAME `orderClaimedSet` the drain uses, so the
      // positions a person reads on the run page are the order the drain
      // actually worked. Nothing is re-queried to produce it.
      const reporter = createDispatchRunReporter({
        client,
        // A hosted run always reports its agent's output (see the leaf path).
        reportLogBodies: opts.reportLog === true || adopted !== null,
      });
      if (claimed.claim === null) {
        // A HOSTED scope — nothing was claimed here. ADOPT, never open: the set
        // is the one the server opened the run with, and `runId` is its id.
        reporter.adopt(runId);
      } else {
        const claimOrder = orderClaimedSet(
          claimed.ready.map((m) => m.key),
          claimed.edges,
        );
        await reporter.open({
          projectKey: session.projectKey,
          command: 'run_scope',
          runId,
          cards: claimOrder.map((key) => ({ key, disposition: 'queued' as const })),
          ...(decision.target.kind === 'work_item' ? { scopeKey: decision.target.key } : {}),
          scopeLabel: claimed.claim.scope.name,
          agent: agent.parsed.binary,
        });
        reporter.event({
          kind: 'scope_claimed',
          data: { outcome: claimed.claim.outcome, members: claimOrder.length },
        });
      }

      const summary = await drainScope({
        session,
        // ⚠️ UNATTENDED (MOTIR-6558): nobody is at a hosted run to re-run it
        // after the first failed card, so it keeps going, as `motir auto` does.
        opts: adopted ? { ...opts, keepGoing: true } : opts,
        members: claimed.ready,
        edges: claimed.edges,
        max: parseMax(opts.max),
        agent,
        runId,
        branch,
        run,
        clock: deps.clock ?? Date.now,
        runAgentFn: deps.runAgentFn ?? runAgent,
        reporter,
        // MOTIR-10985 — the work item the session pull request is titled for and
        // linked to from its first landed card. A sprint scope names none.
        ...(decision.target.kind === 'work_item'
          ? {
              container: {
                key: decision.target.key,
                title: decision.title ?? claimed.claim?.scope.name ?? '',
              },
            }
          : {}),
        // A hosted workspace starts EMPTY: every repository a leg ships in is
        // cloned before its session branch is made, as `motir auto` does.
        materialize: adopted !== null,
        ...(adopted ? adoptedCheckoutPreparer() : {}),
      });
      // ⚠️ THE CLOSE-OUT RE-READS THE CONTAINER'S CHILDREN FIRST (Bug
      // MOTIR-3268). The claim was taken at t=0; a bug filed mid-drain
      // (MOTIR-3017) parents itself under this very container, so the set this
      // run holds is a statement about the past by the time it is finished.
      //
      // ⚠️ THE READ SURVIVES; ITS CONSEQUENCE CHANGED (MOTIR-4967). It used to
      // decide whether a pull request was opened AT ALL, because one opened over
      // an unfinished container claims the story is built. The pull request is
      // now a DRAFT either way, and a draft cannot be merged — so it cannot
      // complete the container or cascade `done` onto the children that are
      // missing. What this read decides now is whether the close-out marks it
      // READY, which is the same question asked at the only moment it can be
      // answered.
      const open = await readOpenChildren(client, decision.target);
      // ⚠️ HOW TO TEST IS WRITTEN BEFORE THE PULL REQUESTS GO READY (MOTIR-5358;
      // `docs/decisions/approval-gates.md` §9's 2026-09-13 amendment). The run
      // target is the claimed container; ONE agent, handed the server's close-out
      // prompt, publishes the run's record onto it, and the record it reads back
      // is rendered into every body below. It never strands the run — a failure
      // is logged and the close-out carries on. A sprint scope has no work-item
      // target, so it has no step.
      const howToTest =
        decision.target.kind === 'work_item'
          ? await runCloseOutHowToTest({
              client,
              dispatchRunId: reporter.runId,
              targetKey: decision.target.key,
              summary,
              agent,
              runAgentFn: deps.runAgentFn ?? runAgent,
            })
          : undefined;
      // ONE pull request per TOUCHED repo, through the shipped close-out. On a
      // multi-repo scope that is one PER REPO, and the summary names each — "one
      // pull request, one CI run" is exactly true for a single-repo scope only.
      closeOutRepos(summary, run, open, howToTest);
      // ⚠️ THEN THE CONTAINER (MOTIR-4969), and only then. The close-out above
      // is what rewrites every repository's pull request and marks it ready; the
      // story is told it is built afterwards, so a run that dies in between
      // leaves drafts AND a container that is not Implemented — the pair that is
      // true. It re-reads the same `open` the close-out did, through
      // `summary.outstanding`, so the two cannot disagree about whether a child
      // is missing.
      await closeOutContainer(client, summary);
      // Each repository's session pull request, with the outcome the close-out
      // reported — `opened` · `existing` · `failed` · `empty`. Whether it was
      // left a DRAFT rides on the report too, and it is the thing a person
      // reading a run page most needs to see: a draft is not something to merge.
      for (const pr of summary.prs) {
        reporter.event({
          kind: 'session_pr',
          data: { repo: pr.repoName, branch: pr.branch, url: pr.url, outcome: pr.outcome },
        });
      }
      reporter.event({ kind: 'run_closed', data: { stopReason: summary.stopReason } });
      await reporter.close(summary.stopReason);
      info('');
      info(renderAutoSummary(summary));
      info(renderFindingsPolicy(opts));
      process.exitCode = autoExitCode(summary);
      return;
    }

    const detail = decision.detail;
    const { item, readiness } = detail;
    if (adopted) assertAdoptsLeaf(adopted, item.identifier);

    // HARD vs SOFT (MOTIR-6354), classified from the verdict already in hand —
    // no second read. `--allow-soft-block` passes only a SOFT block; `--force`
    // passes either.
    const softAncestor = softBlockAncestor(readiness);
    const softOverride = opts.allowSoftBlock === true && softAncestor !== null;
    if (!readiness.ready && !opts.force && !softOverride) {
      throw notReadyError({
        identifier: item.identifier,
        openBlockers: readiness.openBlockers,
        blockedByAncestor: readiness.blockedByAncestor,
        ...(opts.allowSoftBlock ? { allowSoftBlock: true } : {}),
      });
    }
    if (softOverride) {
      info(
        `${item.identifier} is held only by its ancestor ${softAncestor.identifier}'s block — dispatching (--allow-soft-block).`,
      );
    } else if (!readiness.ready) {
      info(`${item.identifier} is not ready — dispatching anyway (--force).`);
    }

    // `run` is GIVEN a card by a person; `next` / `auto` / `batch` PICK one. So
    // the ASSIGNEE axis warns here instead of refusing (MOTIR-2427): a human who
    // names a key has a reason to take a card off a teammate, and refusing
    // outright would break the documented recovery for a card an agent left in
    // progress. The warning still has to be said — dispatching onto a
    // teammate's live card is the failure this whole card exists to make
    // visible, and silence is what made it invisible.
    //
    // The STATUS axis is no longer warned about (MOTIR-3048). The claim below
    // refuses anything outside the to-do category, so `in_review`, `planning`
    // and `done` are answered by the server, in the one place they can actually
    // be enforced.
    const ownerId = adopted ? await resolveHostedOwnerId(client) : await resolveOwnerId(client);
    const warning = pickWarning(item, ownerId);
    if (warning) info(`${item.identifier}: ${warning}`);

    const claim = await ensureInProgress(client, item.identifier);
    if (!claimAllowsDispatch(claim)) {
      // ⚠️ A REFUSAL ENDS THE COMMAND — cleanly, not as an error. `run` was
      // given ONE card and cannot substitute another, and the four outcomes are
      // ordinary states rather than failures, so there is nothing to throw:
      // the refusal names who holds it, or where it is, and exits 0.
      info(renderClaimRefusal(claim));
      return;
    }
    const dispatch = await client.dispatchPrompt(item.identifier, {
      findingsPolicy: findingsPolicyOf(opts),
    });
    await deliver({
      session,
      command: 'run',
      key: item.identifier,
      title: item.title,
      dispatch,
      opts,
      deps,
      adoptedRunId: adopted?.runId ?? null,
    });
  });
}

/**
 * A HOSTED scope's members, from the run the server opened (MOTIR-6558).
 *
 * The same `{ ready, edges }` shape `claimScopeForRun` returns, so the drain and
 * the close-out below cannot tell the two apart — except that nothing here
 * claims: the members are the run's legs, in the run's own order, each read from
 * its own card (the drain needs its type and executor), and the edges are the
 * container's, read once exactly as a local scope reads them.
 */
async function adoptScope(
  client: ProjectSession['client'],
  target: { kind: 'work_item'; key: string },
  adopted: AdoptedRun,
  projectKey: string,
): Promise<{ ready: DispatchItem[]; edges: ScopeEdges; claim: null }> {
  const ready: DispatchItem[] = [];
  for (const key of adopted.legs) ready.push(legAsDispatchItem(await client.getWorkItem(key)));
  const edges = await readScopeEdges(client, target, projectKey);
  info(`Adopted run ${adopted.runId}: ${adopted.legs.length} card(s) of ${target.key}.`);
  return { ready, edges, claim: null };
}

// ── motir done <key> | --session <branch> ───────────────────────────────────

export interface DoneOptions {
  /** `--session <branch>` — bulk close-out for a merged session PR. */
  session?: string;
  /**
   * `--via <status>` — walk to done through this status first. The default
   * workflow gained a direct `in_progress → done` edge in MOTIR-1625, so this is
   * no longer needed to close out an item dispatched with `--print`; it remains
   * for a CUSTOM workflow with no direct edge, and for a team that wants the
   * In Review hop on the record. Opt-in, never inferred: the CLI does not
   * silently move an item through a status the user did not name.
   */
  via?: string;
}

export async function doneCommand(key: string | undefined, opts: DoneOptions): Promise<void> {
  if (opts.session) {
    if (key) {
      throw new CliError('Pass either a work item key or --session <branch>, not both.');
    }
    await withProjectSession(async ({ client }) => {
      const result = await client.completeSession({
        sessionBranch: opts.session as string,
        implementationSource: CLOSE_OUT_SOURCE,
      });
      info(renderSessionOutcomes(result.sessionBranch, result.results));
    });
    return;
  }

  const trimmed = (key ?? '').trim();
  if (!trimmed) {
    throw new CliError('A work item key is required, e.g. `motir done ACME-7`.', {
      hint: 'Or close out a merged session PR with `motir done --session <branch>`.',
    });
  }

  await withProjectSession(async ({ client, serverUrl, projectKey }) => {
    if (opts.via) {
      await client.transitionStatus({ key: trimmed, status: opts.via });
      info(`${trimmed}: → ${opts.via}`);
    }
    try {
      await client.transitionStatus({ key: trimmed, status: DONE });
    } catch (err) {
      // The tool's own error text NAMES the allowed targets — surface it
      // verbatim rather than paraphrasing, and add the one-hop hint only when
      // the user has not already asked for a hop.
      if (err instanceof CliError && !opts.via) {
        throw new CliError(err.message, {
          hint: `If the PR is merged but the item never reached In Review, try \`motir done --via ${IN_REVIEW} ${trimmed}\`.`,
        });
      }
      throw err;
    }
    removeExclude(serverUrl, projectKey, trimmed);
    info(`${trimmed}: done.`);
  });
}

/** What {@link runClaimedScope} needs — the scope arm AFTER its claim. */
export interface ClaimedScopeRunInput {
  session: ProjectSession;
  target: ScopeTarget;
  claimed: ClaimedScope;
  opts: RunOptions;
  deps: DeliveryDeps;
  agent: ResolvedAgent;
  runId: string;
  /** The session branch — minted for a fresh run, the dead run's on a resume. */
  branch: string;
  /** A run the SERVER already opened (`motir continue <parent>`, MOTIR-6535). */
  reporter?: DispatchRunReporter;
  /** `branch` is a dead run's, being resumed: merge the base into it first. */
  resumeBranch?: boolean;
  /** On a resume, each repository's own session branch (MOTIR-6794). */
  branches?: readonly { repository: string | null; branch: string }[];
  /** Clone a leg's missing repositories before its session branch is made. */
  materialize?: boolean;
  /** Prepare each leg's checkouts before its spawn (a hosted run's code graph). */
  prepareCheckouts?: (cwds: string[]) => void;
}

/**
 * THE SCOPE ARM, after its claim (MOTIR-3199; extracted by MOTIR-6535 so a
 * resumed parent run drains through exactly the code a fresh one does): open the
 * run with the claimed set, drain it on `branch`, write How to test, close out one
 * pull request per repository, and report.
 */
export async function runClaimedScope(input: ClaimedScopeRunInput): Promise<void> {
  const { session, target, claimed, opts, deps, agent, runId, branch } = input;
  const decision = { target };
  const { client } = session;
  const run = deps.run ?? execCommand;

  // ── THE RUN RECORD (Story MOTIR-1789 · MOTIR-1794) ──────────────────
  //
  // ⚠️ OPENED WITH THE CLAIM'S FULL MEMBER SET, IN `orderClaimedSet` ORDER,
  // and this is the operation the whole record is shaped around. The claim
  // has just locked every member — including the ones that are not startable
  // yet — and the order has just been computed from edges the run already
  // holds. That knowledge exists for exactly one moment, in one process:
  // rebuilt afterwards from per-card events it becomes a list of what the
  // run got round to, and the SKIPPED cards vanish entirely.
  //
  // The order comes from the SAME `orderClaimedSet` the drain uses, so the
  // positions a person reads on the run page are the order the drain
  // actually worked. Nothing is re-queried to produce it.
  const reporter =
    input.reporter ??
    createDispatchRunReporter({
      client,
      reportLogBodies: opts.reportLog === true,
    });
  const claimOrder = orderClaimedSet(
    claimed.ready.map((m) => m.key),
    claimed.edges,
  );
  await reporter.open({
    projectKey: session.projectKey,
    command: 'run_scope',
    runId,
    cards: claimOrder.map((key) => ({ key, disposition: 'queued' as const })),
    ...(decision.target.kind === 'work_item' ? { scopeKey: decision.target.key } : {}),
    scopeLabel: claimed.claim.scope.name,
    agent: agent.parsed.binary,
  });
  reporter.event({
    kind: 'scope_claimed',
    data: { outcome: claimed.claim.outcome, members: claimOrder.length },
  });

  const summary = await drainScope({
    session,
    opts,
    members: claimed.ready,
    edges: claimed.edges,
    max: parseMax(opts.max),
    agent,
    runId,
    branch,
    run,
    ...(input.resumeBranch ? { resumeBranch: true } : {}),
    ...(input.branches ? { branches: input.branches } : {}),
    ...(input.materialize ? { materialize: true } : {}),
    ...(input.prepareCheckouts ? { prepareCheckouts: input.prepareCheckouts } : {}),
    clock: deps.clock ?? Date.now,
    runAgentFn: deps.runAgentFn ?? runAgent,
    reporter,
    // MOTIR-10985 — the claimed work item, whose title the claim carries.
    ...(decision.target.kind === 'work_item'
      ? { container: { key: decision.target.key, title: claimed.claim.scope.name } }
      : {}),
  });
  // ⚠️ THE CLOSE-OUT RE-READS THE CONTAINER'S CHILDREN FIRST (Bug
  // MOTIR-3268). The claim was taken at t=0; a bug filed mid-drain
  // (MOTIR-3017) parents itself under this very container, so the set this
  // run holds is a statement about the past by the time it is finished.
  //
  // ⚠️ THE READ SURVIVES; ITS CONSEQUENCE CHANGED (MOTIR-4967). It used to
  // decide whether a pull request was opened AT ALL, because one opened over
  // an unfinished container claims the story is built. The pull request is
  // now a DRAFT either way, and a draft cannot be merged — so it cannot
  // complete the container or cascade `done` onto the children that are
  // missing. What this read decides now is whether the close-out marks it
  // READY, which is the same question asked at the only moment it can be
  // answered.
  const open = await readOpenChildren(client, decision.target);
  // ⚠️ HOW TO TEST IS WRITTEN BEFORE THE PULL REQUESTS GO READY (MOTIR-5358;
  // `docs/decisions/approval-gates.md` §9's 2026-09-13 amendment). The run
  // target is the claimed container; ONE agent, handed the server's close-out
  // prompt, publishes the run's record onto it, and the record it reads back
  // is rendered into every body below. It never strands the run — a failure
  // is logged and the close-out carries on. A sprint scope has no work-item
  // target, so it has no step.
  const howToTest =
    decision.target.kind === 'work_item'
      ? await runCloseOutHowToTest({
          client,
          dispatchRunId: reporter.runId,
          targetKey: decision.target.key,
          summary,
          agent,
          runAgentFn: deps.runAgentFn ?? runAgent,
        })
      : undefined;
  // ONE pull request per TOUCHED repo, through the shipped close-out. On a
  // multi-repo scope that is one PER REPO, and the summary names each — "one
  // pull request, one CI run" is exactly true for a single-repo scope only.
  closeOutRepos(summary, run, open, howToTest);
  // ⚠️ THEN THE CONTAINER (MOTIR-4969), and only then. The close-out above
  // is what rewrites every repository's pull request and marks it ready; the
  // story is told it is built afterwards, so a run that dies in between
  // leaves drafts AND a container that is not Implemented — the pair that is
  // true. It re-reads the same `open` the close-out did, through
  // `summary.outstanding`, so the two cannot disagree about whether a child
  // is missing.
  await closeOutContainer(client, summary);
  // Each repository's session pull request, with the outcome the close-out
  // reported — `opened` · `existing` · `failed` · `empty`. Whether it was
  // left a DRAFT rides on the report too, and it is the thing a person
  // reading a run page most needs to see: a draft is not something to merge.
  for (const pr of summary.prs) {
    reporter.event({
      kind: 'session_pr',
      data: { repo: pr.repoName, branch: pr.branch, url: pr.url, outcome: pr.outcome },
    });
  }
  reporter.event({ kind: 'run_closed', data: { stopReason: summary.stopReason } });
  await reporter.close(summary.stopReason);
  info('');
  info(renderAutoSummary(summary));
  info(renderFindingsPolicy(opts));
  process.exitCode = autoExitCode(summary);
}
