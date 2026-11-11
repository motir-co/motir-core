import type { HowToTestForBody } from '../closeOutHowToTest.js';
import { CliError, ContainerHasOpenChildrenError, PlanNotDecidableError } from '../errors.js';
import { info } from '../output.js';
import { createLegLogTee } from '../agentLogTee.js';
import { parseKinds } from './read.js';
import {
  claimAllowsDispatch,
  ensureInProgress,
  resolveAgent,
  resumeFixAgent,
  echoPromptIfAsked,
  resolveOwnerId,
  type DeliveryOptions,
} from './dispatch.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { legBranches, startCheckpoints } from '../checkpoint.js';
import { runAgent } from '../agentRun.js';
import {
  createDispatchRunReporter,
  nullDispatchRunReporter,
  type DispatchRunReporter,
} from '../dispatchRunReporter.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import {
  agentSubmittedReplan,
  checkBootstrapCheckout,
  contradictoryReplanFlags,
  cwdReasonLabel,
  findingsPolicyOf,
  renderClaimRefusal,
  renderFindingsPolicy,
  renderReplanSubmitted,
  renderRepositoriesBlock,
  materializeDispatchCheckouts,
  renderMaterialization,
  resolveDispatchTarget,
  resolveDispatchTargets,
  type DispatchTarget,
  type PromptEchoOptions,
} from '../dispatch.js';
import {
  autoExitCode,
  classifyReadyItem,
  formatDuration,
  landedWork,
  planReviewUrl,
  renderAutoSummary,
  deliveredContainerKey,
  renderSessionPrBody,
  sessionPrTitle,
  type ApprovalRecord,
  type AutoSummary,
  type DispatchRecord,
  type PlanningRecord,
  type PrReport,
  type RepoSession,
  type ReplanLaneRecord,
  type SessionPrContainer,
  type ReplanRefresh,
  type SkipRecord,
  type StopReason,
  manualWaitingOn,
} from '../autoLoop.js';
import { inLane, renderElsewhereAnchored, renderLaneDecline, type Lane } from '../replanLane.js';
import {
  ensureSessionBranchOnOrigin,
  mergeBaseIntoRemoteBranch,
  execCommand,
  workReachedRemote,
  GitError,
  markSessionPrReady,
  openSessionPr,
  updateSessionPr,
  pushSessionBranchIfAhead,
  runIdFromDate,
  sessionBranchCommits,
  sessionBranchHasCommits,
  sessionBranchName,
  type CommandRunner,
} from '../git.js';
import { deriveAgentHarness, withFreshSessionId } from '../agentProfiles.js';
import { runCiWatchPhase } from '../ciWatch.js';
import type { DispatchItem, DispatchPrompt, MotirClient } from '../client.js';
import { bindInterruptSignals, closeRunAndExit, type InterruptSignal } from '../interrupt.js';

// `motir auto` — THE SEQUENTIAL WHILE LOOP (Story 7.9 · Subtask 7.9.4 ·
// MOTIR-882). Drain the ready set unattended: one item per iteration, strictly
// one at a time, until the server says there is nothing left.
//
// ── The shape is a WHILE loop, never a batch drain ──────────────────────────
// The loop asks the server for exactly ONE item per iteration (`next_ready`)
// and never materializes a list. That is not a style choice: the ready set
// CHANGES while the run executes. Integrating item A unlocks its dependents,
// which were not ready — and may not even have existed — when the run started.
// A pre-computed plan-of-the-run would therefore be stale by iteration two and
// would silently cap the run at whatever happened to be ready at second zero.
// There is deliberately no code path here that reads more than one item ahead.
//
// ── Session-branch mode is the ONLY mode ────────────────────────────────────
// Items do not each get a pull request. The run opens ONE session branch per
// repo it dispatches into (lazily, on that repo's first item) and every item's
// work is integrated onto it; at the end the CLI surfaces ONE pull request per
// repo, which is the run's single human review gate. MAIN IS NEVER AUTO-
// ADVANCED — not by the CLI, and not by the prompt, whose session-lineage GIT
// WORKFLOW section instructs the agent to integrate into the session branch and
// explicitly not to open a pull request. Nothing reaches Done until a human
// merges that PR and runs `motir done --session <branch>`.

export interface AutoOptions extends DeliveryOptions {
  kinds?: string;
  /** `--max <n>` — cap the dispatches this invocation makes. */
  max?: string;
  /** `--keep-going` — continue past a failed agent instead of halting. */
  keepGoing?: boolean;
  /** `--reset` — clear this project's persisted exclude list first. */
  reset?: boolean;
  /** `--include-planning` — fire an AI expansion for each unexpanded epic/story
   *  the ready set hands back, instead of skipping it (MOTIR-886). */
  includePlanning?: boolean;
  /**
   * `--auto-approve-replan` — approve a re-plan the agent submitted and KEEP
   * LOOPING, instead of stopping for a human (MOTIR-3022).
   *
   * ⚠️ `auto` ONLY, and the reason is the mechanism rather than taste: this is
   * the one command that re-asks `next_ready` each iteration, so a
   * newly-approved card genuinely enters the run. `run` / `next` exit after one
   * item and `batch` froze its list before starting; all three REGISTER the flag
   * in order to refuse it with that reason.
   *
   * This card registers, validates and passes it through. What the loop DOES
   * with it is MOTIR-3023.
   */
  autoApproveReplan?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface AutoDeps {
  run?: CommandRunner;
  now?: () => Date;
  clock?: () => number;
  /** The CI watch's inter-poll wait (MOTIR-3685) — injected so a test does not
   *  spend real seconds proving a pending verdict costs no attempt. */
  wait?: () => Promise<void>;
  /** The CI watch's POLL bound (MOTIR-3685), distinct from the five-fix cap. */
  maxCiPolls?: number;
  /** The agent launcher. Injected by the tests so the loop can be driven with a
   *  scripted agent — the fixture the acceptance criteria are written against. */
  runAgentFn?: typeof runAgent;
  /** The wait between approval retries while a planner is still writing
   *  (MOTIR-3025). Injected so a test can prove the RETRY without spending a
   *  real minute on it; never overridden in production. */
  sleep?: (ms: number) => Promise<void>;
}

/** A resolved agent — `motir auto` refuses to start without one, so every
 *  downstream signature takes the non-null form. */
export type ResolvedAgent = NonNullable<ReturnType<typeof resolveAgent>>;

/**
 * Parse `--max`. A cap that silently means "no cap" because it did not parse is
 * the worst outcome for an unattended loop, so anything non-positive is a hard
 * error rather than an ignored flag.
 */
export function parseMax(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new CliError(`--max must be a positive whole number, got "${raw}".`);
  }
  return n;
}

/**
 * `motir auto` REQUIRES an agent. `--print` is the copy-paste-into-your-agent
 * mode, and there is no human in an unattended loop to copy anything — so it is
 * an error with guidance rather than a silently degraded run.
 */
export function requireAgent(opts: AutoOptions, command = 'motir auto'): ResolvedAgent {
  if (opts.print) {
    throw new CliError(`\`${command}\` cannot run in --print mode.`, {
      hint: 'An unattended loop has nobody to paste a prompt. Use `motir next --print` for one item, or pass --agent <cmd>.',
    });
  }
  const agent = resolveAgent(opts);
  if (!agent) {
    throw new CliError(`\`${command}\` needs an agent to run.`, {
      hint: 'Pass --agent "<cmd>", set MOTIR_AGENT, or configure agentCommand. `motir doctor` checks it.',
    });
  }
  return agent;
}

// ── the repo session registry ───────────────────────────────────────────────

/**
 * The session branch for the repo an item routes into, created on FIRST USE.
 *
 * Lazy on purpose: a run that never dispatches a `motir-ai` item must not leave
 * a stray branch in `motir-ai`. Keyed by resolved PATH rather than repo name, so
 * two names pointing at one checkout share one branch.
 *
 * Returns null when this target cannot carry a lineage — a BOOTSTRAP dispatch
 * (the checkout does not exist yet, so there is no repo to branch in) or an
 * UNPINNED item whose fallback root is not a git repository. Those items are
 * dispatched with no seed, which makes the server hand them the per-item-PR
 * prompt: the honest outcome, not a lineage the CLI could not actually create.
 */
export class RepoSessions {
  private readonly byPath = new Map<string, RepoSession | null>();

  constructor(
    private readonly branch: string,
    private readonly run: CommandRunner,
    /**
     * A RESUMED scope (MOTIR-6535, `motir continue <parent>`): a session branch
     * already on origin is the dead run's, and `origin/main` is merged into it
     * before the first child builds on it. A fresh run never sets this.
     */
    private readonly opts: {
      mergeBaseOnReuse?: boolean;
      /**
       * Each repository's OWN session branch, when a resumed scope's dead run left
       * a different one per repository (MOTIR-6794) — keyed by repository name.
       * A repository absent here takes `branch`, cut the way a fresh run cuts it.
       */
      branches?: readonly { repository: string | null; branch: string }[];
    } = {},
  ) {}

  /** The session branch a repository's work goes on. */
  private branchFor(target: DispatchTarget): string {
    const name = target.targetRepo?.toLowerCase();
    const own = name
      ? this.opts.branches?.find((b) => b.repository?.toLowerCase() === name)
      : undefined;
    return own?.branch ?? this.branch;
  }

  /**
   * The session(s) an item's whole repository SET routes into (MOTIR-3135).
   *
   * ⚠️ ALL-OR-NOTHING per card, and that is the decision this method carries. A
   * lineage in SOME of a card's repositories and not others is the one outcome
   * that cannot be closed out: `closeOutRepos` opens a pull request per TOUCHED
   * repository, so a repository holding the work but not the branch is invisible
   * to it — the work sits on a local branch nothing will ever push or review. So
   * if any repository of the card cannot carry the lineage, the CARD gets none,
   * and the server hands it the per-item-pull-request prompt for all of them.
   *
   * For a multi-repository card the un-carryable case is settled BEFORE any
   * branch is created, so a card that falls back leaves no stray branch behind
   * in the repositories that could have carried it.
   *
   * Returns `null` when this card gets no seed.
   */
  ensure(targets: readonly DispatchTarget[]): RepoSession[] | null {
    if (targets.length <= 1) {
      const single = this.ensureOne(targets[0]!);
      return single === null ? null : [single];
    }
    // The cheap pass first: a target with no checkout to branch in, or one an
    // earlier item already found un-carryable, decides this without touching git.
    for (const target of targets) {
      const cached = this.byPath.get(target.cwd);
      if (cached === null || (cached === undefined && target.reason !== 'repo_checkout')) {
        info(
          `No session branch possible in ${target.cwd} (${target.targetRepo ?? 'unpinned'}).` +
            ' This work item carries more than one repository, so it ships as its own pull' +
            ' requests in all of them rather than a lineage in some.',
        );
        return null;
      }
    }
    // Every element is a real checkout: create or reuse, and a git failure in one
    // of them is the same run-ending problem it is for a single-repository card.
    return targets.map((target) => this.ensureOne(target)!);
  }

  private ensureOne(target: DispatchTarget): RepoSession | null {
    const existing = this.byPath.get(target.cwd);
    if (existing !== undefined) return existing;

    if (target.reason !== 'repo_checkout') {
      // No checkout to branch in (bootstrap), or an unpinned item at the root.
      // Try the root anyway — `motir link --repo .` makes it a real checkout —
      // but treat a git failure as "no lineage here", not as a run-ending error.
      const session = this.tryCreate(target, { tolerateFailure: true });
      this.byPath.set(target.cwd, session);
      return session;
    }
    const session = this.tryCreate(target, { tolerateFailure: false });
    this.byPath.set(target.cwd, session);
    return session;
  }

  private tryCreate(
    target: DispatchTarget,
    opts: { tolerateFailure: boolean },
  ): RepoSession | null {
    const branch = this.branchFor(target);
    try {
      const outcome = ensureSessionBranchOnOrigin(target.cwd, branch, this.run);
      info(
        outcome === 'created'
          ? `Session branch ${branch} created on origin in ${target.cwd}.`
          : `Session branch ${branch} already on origin in ${target.cwd} — reusing it.`,
      );
      if (outcome === 'already_on_origin' && this.opts.mergeBaseOnReuse) {
        const merged = mergeBaseIntoRemoteBranch(target.cwd, branch, this.run);
        info(
          merged === 'merged'
            ? `Merged origin/main into ${branch} in ${target.cwd}.`
            : merged === 'up_to_date'
              ? `${branch} already contains origin/main in ${target.cwd}.`
              : `origin/main does not merge cleanly into ${branch} in ${target.cwd} — left as it was; each child merges it itself.`,
        );
      }
      return { repoName: target.targetRepo, cwd: target.cwd, branch, keys: [] };
    } catch (err) {
      if (!opts.tolerateFailure) throw err;
      info(
        `No session branch in ${target.cwd} (${err instanceof Error ? err.message : String(err)}).` +
          ' Items routed here ship as their own pull request.',
      );
      return null;
    }
  }

  /** Every repo a session branch was opened in, in first-touch order. A repo
   *  whose only item failed is included on purpose: its branch EXISTS on origin,
   *  and the summary saying so beats leaving a stray branch unmentioned. */
  touched(): RepoSession[] {
    return [...this.byPath.values()].filter((s): s is RepoSession => s !== null);
  }
}

// ── the command ─────────────────────────────────────────────────────────────

export async function autoCommand(opts: AutoOptions, deps: AutoDeps = {}): Promise<void> {
  // ⚠️ CONTRADICTORY FLAGS ARE REFUSED, not resolved by precedence (MOTIR-3022).
  // `--auto-approve-replan` with `--disable-replan` says approve a submission the
  // agent was told not to make; honouring either one silently leaves the operator
  // believing the other. Refused BEFORE the agent is resolved, so nothing is
  // claimed for a run that cannot mean what it says.
  if (opts.autoApproveReplan) {
    const contradiction = contradictoryReplanFlags(opts);
    if (contradiction) {
      throw new CliError(contradiction, {
        hint: 'Drop one: `--auto-approve-replan` to keep the agent from re-planning at all, or `--disable-replan` to approve what it submits.',
      });
    }
  }
  const run = deps.run ?? execCommand;
  const clock = deps.clock ?? Date.now;
  const kinds = parseKinds(opts.kinds);
  const max = parseMax(opts.max);
  const agent = requireAgent(opts);
  const runId = runIdFromDate((deps.now ?? (() => new Date()))());
  const branch = sessionBranchName(runId);

  await withProjectSession(async (session) => {
    // ONE `whoami` for the whole run: the owner cannot change mid-loop, and an
    // unattended drain that asked per item would spend a request on a constant.
    const ownerId = await resolveOwnerId(session.client);

    // ── THE RUN RECORD (Story MOTIR-1789 · MOTIR-1794) ──────────────────────
    //
    // ⚠️ OPENED WITH AN EMPTY SET, deliberately. This loop holds no plan: it
    // asks the server for exactly one item per iteration, because the ready set
    // changes underneath it as an integrated card unblocks its dependents. A
    // list materialised here to make the run page look complete would be wrong
    // by the second iteration AND would break the property the loop exists to
    // have — so the legs arrive one at a time, from inside the loop.
    const reporter = createDispatchRunReporter({
      client: session.client,
      reportLogBodies: opts.reportLog === true,
    });
    await reporter.open({
      projectKey: session.projectKey,
      command: 'auto',
      // The id the session branch and the pull-request body already name.
      runId,
      cards: [],
      agent: agent.parsed.binary,
    });
    reporter.event({ kind: 'run_opened', data: { command: 'auto', branch } });

    const summary = await runAutoLoop({
      // `motir auto` is the lane that opens each repository's pull request at its
      // first implemented card (MOTIR-3681). See `LoopInput.openPrEagerly`.
      openPrEagerly: true,
      session,
      opts,
      kinds,
      max,
      agent,
      runId,
      branch,
      run,
      clock,
      runAgentFn: deps.runAgentFn ?? runAgent,
      ownerId,
      reporter,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    closeOutRepos(summary, run);
    // ⚠️ AFTER, and the order is the rule (MOTIR-4969): every repository's pull
    // request has its final title and body and has been marked ready by the line
    // above before the container is told it is built.
    await closeOutContainer(session.client, summary);
    for (const pr of summary.prs) {
      reporter.event({
        kind: 'session_pr',
        data: { repo: pr.repoName, branch: pr.branch, url: pr.url, outcome: pr.outcome },
      });
    }
    for (const approval of summary.approvals) {
      // ⚠️ WHAT THE RUN DECIDED WHILE NOBODY WAS WATCHING (MOTIR-3023). Every
      // other event says what the loop BUILT; this one says what it did to a
      // plan someone else owns, and it is the first thing they should be able to
      // find in the morning.
      reporter.event({ kind: 'plan_approved', workItemKey: approval.key, data: approval });
    }

    // ── THE CI WATCH (Story MOTIR-3655 · MOTIR-3685) ────────────────────────
    //
    // `motir auto` does NOT gate between cards: its pull requests are for the
    // whole run, so they are not finished until the run is. It keeps picking up
    // work and watches HERE — after the close-out, when there is no card left to
    // pick up and every pull request is open.
    //
    // The watch is per CARD, because the delivery set is a property of the card
    // and a run's cards can be red and green independently. The fixing agent
    // stands in the repository session that card was integrated in — a run
    // spanning three repositories has three branches, and a fix must be
    // committed to the one CI is red on.
    const watched = await watchRunCi(summary, session, agent, opts, deps);
    reporter.event({ kind: 'ci_verdict', data: { green: watched } });
    reporter.event({ kind: 'run_closed', data: { stopReason: summary.stopReason } });
    await reporter.close(summary.stopReason);

    info('');
    info(renderAutoSummary(summary));
    info(renderFindingsPolicy(opts));
    const exit = autoExitCode(summary);
    // ⚠️ A give-up must be OBVIOUS, including when the run otherwise succeeded:
    // the cards sit at `implemented` either way, and a script wrapping
    // `motir auto` can only tell "built and green" from "built and still red"
    // by the exit code.
    process.exitCode = exit !== 0 ? exit : watched ? 0 : 1;
  });
}

export interface LoopInput {
  /**
   * Open each repository's pull request at its FIRST implemented card, rather
   * than only at the close-out (Story MOTIR-3655 · MOTIR-3681).
   *
   * ⚠️ NO LONGER A LANE GATE — IT IS A TEST SEAM (MOTIR-4999). It was once a
   * SAFETY gate: the scoped run could finish under a hold (Bug MOTIR-3268) that
   * an eager open would have defeated, and MOTIR-4967 retired that hold by
   * opening every session pull request as a DRAFT. What was left after that was
   * a plain fact about which loop each lane runs — the scoped run drains through
   * `commands/scopeDrain.ts`, which has a loop of its own — and MOTIR-4999 gave
   * THAT loop the same first-implemented-card timing, calling the same
   * `ensureRepoPullRequest`.
   *
   * ⚠️ SO BOTH PRODUCTION LANES NOW OPEN EAGERLY, and this flag has no remaining
   * `false` consumer outside `test/auto.test.ts`, where it is what lets the
   * harness drive this loop's close-out-only path. Read it as "the tests may ask
   * for the pull request not to be opened mid-loop", never as "some lane defers
   * its pull request to the close-out" — nothing does, and a future caller
   * leaving it unset is choosing the tests' shape rather than a lane's.
   */
  openPrEagerly?: boolean;
  session: ProjectSession;
  opts: AutoOptions;
  kinds: string[] | undefined;
  max: number | null;
  agent: ResolvedAgent;
  runId: string;
  branch: string;
  run: CommandRunner;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The token owner — every card this run takes is CLAIMED for them, and rows
   *  claimed by anyone else are not taken at all (MOTIR-2427). */
  ownerId: string;
  /**
   * The run REPORTER (Story MOTIR-1789 · MOTIR-1794), already OPENED by the
   * command with an EMPTY set.
   *
   * ⚠️ EMPTY, AND THIS LOOP MUST NOT FILL IT UP FRONT. `autoLoop.ts`'s own header
   * states the loop's defining property: it holds no plan of the run, asks the
   * server for exactly ONE item per iteration, and *"there is deliberately no
   * function here that takes or returns a ready LIST"*. A reporter that
   * materialised a list to draw a nicer page would break the property the loop
   * exists to have — so a leg is APPENDED as each card is picked, and nothing
   * here reads a set.
   */
  reporter?: DispatchRunReporter;
  /** The approval-retry wait (MOTIR-3025), injected by the tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The WHILE loop itself. Exported so it can be driven end-to-end against a
 *  scripted client + agent, which is the only way the "re-queries every
 *  iteration" property can actually be asserted. */
export async function runAutoLoop(input: LoopInput): Promise<AutoSummary> {
  const {
    session,
    opts,
    kinds,
    max,
    agent,
    runId,
    branch,
    run,
    clock,
    runAgentFn,
    ownerId,
    openPrEagerly = false,
  } = input;
  const { client, serverUrl, projectKey } = session;
  const reporter = input.reporter ?? nullDispatchRunReporter;

  if (opts.reset) {
    const cleared = clearExcludes(serverUrl, projectKey);
    info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
  }

  // Seeded from the PERSISTED list (items a previous session's agent failed on),
  // then grown in-process: an item skipped or failed this run must not be handed
  // straight back by the very next `next_ready`, or the loop would spin on it.
  // The PERSISTED list is keyed by KEY (MOTIR-2338); `next_ready` still narrows
  // by row ID. So the id set starts EMPTY and absorbs each excluded item's id
  // the first time the server hands it back — one extra round trip per
  // persisted exclusion, once, and the server keeps choosing.
  const excludedKeys = new Set(readExcludes(serverUrl, projectKey).map((e) => e.key.toUpperCase()));
  /** Every key this run has been handed — the termination guard below. */
  const seenKeys = new Set<string>();
  const records: DispatchRecord[] = [];
  const skipped: SkipRecord[] = [];
  const planning: PlanningRecord[] = [];
  /** What `--auto-approve-replan` approved (MOTIR-3023). */
  const approvals: ApprovalRecord[] = [];
  /** Every lane DECISION the run made about a submitted re-plan (MOTIR-4085) —
   *  a superset of `approvals`, because a decline is a decision too. */
  const lanes: ReplanLaneRecord[] = [];
  const repos = new RepoSessions(branch, run);

  let interrupted = false;
  // A SIGTERM, or a SECOND Ctrl-C, ends the process NOW — after closing the run
  // `interrupted` with what is queued flushed, so the record says it was stopped
  // rather than reading `running` until its heartbeat lapses (MOTIR-6530).
  const onSignal = (signal: InterruptSignal): void => {
    if (interrupted || signal === 'SIGTERM') {
      void closeRunAndExit(reporter, signal);
      return;
    }
    interrupted = true;
    info('');
    info('Interrupt received — finishing up and opening the session pull request(s).');
    info('Press Ctrl-C again to exit immediately.');
  };
  const detachInterrupt = bindInterruptSignals(onSignal);

  let stopReason: StopReason = 'drained';
  try {
    for (;;) {
      if (interrupted) {
        stopReason = 'interrupted';
        break;
      }
      if (max !== null && records.length >= max) {
        stopReason = 'max';
        break;
      }

      // ONE item, asked for fresh. Never a list — see the module header.
      // Held out by KEY: the client skips excluded rows inside the page walk,
      // so a previous run's failures cost no extra round trip (MOTIR-2398).
      // `ownerId` narrows the pick to what this run may take: unassigned rows,
      // and its own interrupted work. Both filters are CLIENT-SIDE — the ready
      // set has no status facet, and its `assigneeId` is single-valued, so
      // "unassigned OR mine" has no wire form — which is why the page walk that
      // backs this must follow the cursor rather than stop at a page it cannot
      // use (MOTIR-2427).
      // LEAVES FIRST, THEN BUGS (Story MOTIR-6829 · MOTIR-6835): the loop drains
      // the leaves lane before it takes the first bug, so an unattended run
      // finishes the planned work before it turns to defects.
      const { item } = await client.nextReady({
        projectKey,
        lanes: ['leaf', 'bug'],
        ownerId,
        ...(kinds ? { kinds } : {}),
        ...(excludedKeys.size > 0 ? { excludeKeys: [...excludedKeys] } : {}),
      });
      if (!item) {
        stopReason = 'drained';
        break;
      }
      // ⚠️ TERMINATION. The loop asks again after every item, so a key it has
      // already taken coming back a second time means the ready set is not
      // shrinking — a status that did not move, or a server that disagrees with
      // this client about what is ready. Left alone the run spins forever
      // making requests, which is how an unattended command burns a night and a
      // quota. The old MCP enumeration had this guard for the same reason;
      // moving the pick client-side (MOTIR-2398) does not remove the need.
      if (seenKeys.has(item.key.toUpperCase())) {
        stopReason = 'halted';
        info('');
        info(
          `${item.key} was offered twice — the ready set is not advancing. Stopping rather than ` +
            "looping; check the item's status.",
        );
        break;
      }
      seenKeys.add(item.key.toUpperCase());

      const disposition = classifyReadyItem(item);
      if (disposition === 'needs_planning' && opts.includePlanning) {
        // TRIGGER, NEVER WAIT. Submit the expansion and go straight back to
        // `next_ready` — the job runs server-side and its output is a plan a
        // human must approve, so there is nothing here to wait FOR. The item
        // goes on the exclude list because it stays childless and would
        // otherwise be handed straight back on the very next iteration.
        planning.push(await triggerExpansion(client, serverUrl, item));
        excludedKeys.add(item.key.toUpperCase());
        continue;
      }
      if (disposition !== 'dispatch') {
        // Not dispatched, so NOT transitioned: a planning item and a human item
        // are both left exactly as the loop found them.
        // Who a manual card now waits on (MOTIR-7477, ADR §8) — absent is the starter.
        const waitingOn =
          disposition === 'needs_human' ? manualWaitingOn(item, ownerId) : undefined;
        skipped.push({
          key: item.key,
          title: item.title,
          reason: disposition,
          ...(waitingOn ? { waitingOn } : {}),
        });
        // The LEG is appended here too — a card the run looked at and left is
        // exactly the thing that exists nowhere else, and a skip with no leg is
        // a skip nobody can read.
        await reporter.addCard({ key: item.key, disposition: 'skipped', skipReason: disposition });
        reporter.event({
          kind: 'card_skipped',
          workItemKey: item.key,
          disposition: 'skipped',
          skipReason: disposition,
        });
        excludedKeys.add(item.key.toUpperCase());
        info(
          `${item.key}: skipped — ${
            disposition === 'needs_planning'
              ? 'an unexpanded container needs planning'
              : 'human work'
          }.`,
        );
        continue;
      }

      // ⚠️ SEED FIRST, THEN RESOLVE (MOTIR-2398). The loop cannot resolve the
      // checkout before this read — `targetRepo` lives on the PROMPT, not on the
      // ready row (Amendment 10 Q2) — and cannot seed after it, because
      // `repos.ensure` creates the branch the seed names. So the seed goes out
      // first: the prompt is a pure READ that neither claims the item nor moves
      // its status, so asking before knowing whether a checkout exists costs
      // nothing and keeps the common path at ONE request.
      let dispatch = await client.dispatchPrompt(item.key, {
        sessionBranch: branch,
        findingsPolicy: findingsPolicyOf(opts),
        // ⚠️ THE PROMPT IS THE ONLY PLACE THE AGENT LEARNS ITS LANE (MOTIR-4085).
        // A flag the agent never reads cannot change what it does, and this one
        // has to reach it: without the section this renders, an agent believes a
        // person will read every plan it submits, and writes the wider kind when
        // the narrower one would have done — and the narrower one is the only one
        // this loop can act on.
        ...(opts.autoApproveReplan ? { autoApproveReplan: true } : {}),
      });
      // One target per repository the card ships in (MOTIR-3133), primary first.
      // An older server sends no set, and the empty array falls back to the
      // single-repository resolve — exactly the shape this loop had before.
      const targets = resolveDispatchTargets(
        session.link.dir,
        session.link.config,
        // The clone URL travels WITH the name (MOTIR-3588).
        (dispatch.targetRepos ?? []).map((r) => ({ name: r.name, cloneUrl: r.cloneUrl })),
      );
      const resolved =
        targets.length > 0
          ? targets
          : [
              resolveDispatchTarget(session.link.dir, session.link.config, dispatch.targetRepo, {
                cloneUrl: dispatch.targetRepoCloneUrl ?? null,
              }),
            ];
      const target = resolved[0]!;

      // ⚠️ MATERIALIZE BEFORE `repos.ensure` (MOTIR-3588). `ensure` creates the
      // session branch IN a real checkout, so a repository that is missing but
      // clonable has to arrive first — and a clone that fails halts the run
      // rather than launching an agent at the workspace root against a prompt
      // whose first command is `git worktree add`.
      const materialized = materializeDispatchCheckouts(session.link.dir, resolved);
      for (const line of renderMaterialization(materialized)) info(line);
      if (materialized.failures.length > 0) {
        stopReason = 'halted';
        break;
      }

      let repo: RepoSession[] | null;
      try {
        repo = repos.ensure(resolved);
      } catch (err) {
        // A git failure in a REAL checkout is a run-ending problem, and it
        // happens before any status flip — the item is untouched. Stop, but
        // still close out whatever earlier repos completed.
        info('');
        info(`${item.key}: ${err instanceof GitError ? err.message : String(err)}`);
        stopReason = 'halted';
        break;
      }

      if (!repo) {
        // No checkout to branch in, so the seeded prompt's lineage instruction
        // names a branch that does not exist here. Re-read WITHOUT the seed and
        // hand the agent the per-item-pull-request text instead. The extra
        // request buys correctness on a path that was already the exception.
        dispatch = await client.dispatchPrompt(item.key, {
          findingsPolicy: findingsPolicyOf(opts),
          ...(opts.autoApproveReplan ? { autoApproveReplan: true } : {}),
        });
      }

      // ⚠️ THE LEG ARRIVES NOW, one card at a time — the loop's own shape.
      await reporter.addCard({ key: item.key, disposition: 'queued' });

      const outcome = await dispatchOne({
        client,
        item,
        dispatch,
        target,
        targets: resolved,
        repos: resolved.map((t) => t.targetRepo).filter((n): n is string => n !== null),
        agent,
        clock,
        runAgentFn,
        run,
        opts,
        // The card is integrated in EVERY repository of its lineage, so it is
        // carried by every one of their pull requests (MOTIR-3135).
        onIntegrated: (key) => repo?.forEach((s) => s.keys.push(key)),
        reporter,
      });
      if (outcome.kind === 'skipped') {
        // The claim was refused. Recorded beside the loop's other skips — not in
        // `records`, which is what the failure policy and the exit code read —
        // and excluded so the next `next_ready` does not offer it straight back.
        skipped.push({ key: item.key, title: item.title, reason: outcome.reason });
        excludedKeys.add(item.key.toUpperCase());
        continue;
      }
      const record = outcome.record;
      records.push(record);

      // MOTIR-3681 — OPEN THE PULL REQUEST AT THE FIRST IMPLEMENTED CARD, per
      // repository, rather than at the end of the run.
      //
      // The trigger is IMPLEMENTED, not ATTEMPTED: an agent that failed before
      // integrating leaves nothing to review, so `landedWork` is the gate and the
      // next successful card in that repository opens it instead. `openSessionPr`
      // lists before it creates, so every later iteration finds the same pull
      // request and this is a no-op — the idempotence is the helper's, not a flag
      // kept here.
      //
      // The body written now describes only what has landed so far. The close-out
      // still runs at the end and REWRITES it from every record, so a reviewer
      // reads the whole run (see `closeOutRepo`).
      //
      // ⚠️ AND WHAT IT OPENS IS A DRAFT (MOTIR-4967), which is what makes an
      // early open safe rather than merely early: it runs CI on the work as it
      // lands while refusing review, and it cannot be merged — so it cannot claim
      // the container is built while a child of its own is not, which is the
      // invariant Bug MOTIR-3268's hold used to carry by opening nothing.
      if (openPrEagerly && landedWork(record)) {
        for (const repoSession of repo ?? []) {
          // `records` and not `[record]`: the LINK reads the WHOLE run's parent
          // partition, which is what turns a set of one into a container run at
          // the second card (MOTIR-4969).
          await ensureRepoPullRequest(repoSession, runId, run, { client, carried: records });
        }
      }

      // ⚠️ A REFUSED CARD STOPS THE RUN, and `--keep-going` does not override it
      // (MOTIR-3018). That flag says "one agent failing is not a reason to
      // abandon the rest"; this is not a failure — it is the agent reporting
      // that the PLAN is wrong, and the cards the loop would take next are the
      // ones the submitted plan may be about to change. The prompt's own branch
      // tells the agent not to pick up other work; the loop honours the same
      // instruction.
      //
      // ⚠️ UNLESS THE OPERATOR SAID OTHERWISE (MOTIR-3023). With
      // `--auto-approve-replan` the run approves the plan the card produced and
      // CONTINUES — which is the whole value of the flag: an overnight sweep of
      // twenty cards should not end at card three because one premise was stale.
      if (record.outcome === 'replanned') {
        if (!opts.autoApproveReplan) {
          stopReason = 'replanned';
          break;
        }
        // ⚠️ HELD OUT FIRST, BEFORE the approval — and this is the guard that
        // costs real money if it is missed. Approve → the card returns to the
        // ready set → dispatched again → refused again → another submit, and
        // every submit spends the token owner's AI credits. The exclusion goes
        // in whether or not the approval succeeds, because a card that refused
        // itself once will refuse itself again.
        addExclude(serverUrl, projectKey, { key: item.key });
        excludedKeys.add(item.key.toUpperCase());

        // ── TWO CHECKS, TWO JOBS, IN ORDER (MOTIR-4085) ──────────────────
        //
        // 1. VALIDITY — may this plan become rows at all? Already answered, and
        //    not by anything here: `validateCandidatePlan` runs on every
        //    finished plan, and `approvePlan` re-validates the whole proposal
        //    set — the kind matrix, the intra-plan ref graph, done-work
        //    immutability — before a single write. An invalid plan is refused
        //    whatever lane it is in, and the refusal arrives below as a failed
        //    approval. This loop CONSUMES that verdict; it adds no validation.
        //
        // 2. THE LANE — who approves it? Only a valid plan gets this far in
        //    practice, and keeping the two apart is what lets the lane check
        //    stay a comparison of keys with no opinion about structure.
        const lane = await resolveLane(client, item.key, dispatch.parentKey);
        const decision = await decideLane(client, item.key, lane, {
          ...(input.sleep ? { sleep: input.sleep } : {}),
        });
        if (decision.kind !== 'in_lane') {
          // ⚠️ NONE OF THESE IS A FAILURE, and two of them are the bound
          // WORKING: a plan wider than the card's lane, and a plan the agent
          // deliberately anchored elsewhere, both belong to a person. The third
          // — a plan this run could not read — stops for the opposite reason,
          // and the record says which so the summary can too.
          info('');
          info(decision.message);
          lanes.push(decision.record);
          stopReason = 'replanned';
          break;
        }

        const approved = await approveSubmittedPlan(client, item.key, {
          ...(input.sleep ? { sleep: input.sleep } : {}),
        });
        if (!approved.ok) {
          // ⚠️ A REFUSED APPROVAL STOPS THE RUN, with the SERVER's own message.
          // Continuing would dispatch against a tree the operator has not agreed
          // to — and the server's refusals are exactly the bounds that say so
          // (a plan already decided, a proposal the confirmation gate rejected,
          // a scope the token lacks). None of them is a reason to carry on.
          info('');
          info(`${item.key}: the re-plan could NOT be approved — ${approved.message}`);
          info('Stopping rather than continuing against a tree nobody approved.');
          lanes.push({
            key: item.key,
            lane: 'unreadable',
            planId: decision.planId,
            continued: false,
            detail: approved.message,
          });
          stopReason = 'replanned';
          break;
        }
        approvals.push({ key: item.key, ...approved.plan });

        // ⚠️ THE REFRESH IS THE PRECONDITION FOR CONTINUING, not a courtesy.
        // An in-lane plan changes the very children the loop is about to work
        // through, and `autoLoop.ts`'s `replanned` stop reason refuses to run
        // past exactly that. Re-reading is what answers it: without this the
        // loop would go on against a queue that no longer exists, which is
        // strictly worse than today's stop.
        const refresh = await refreshParent(client, lane, {
          exclude: (key) => {
            addExclude(serverUrl, projectKey, { key });
            excludedKeys.add(key.toUpperCase());
          },
        });
        lanes.push({
          key: item.key,
          lane: 'auto_approved',
          planId: approved.plan.planId,
          continued: true,
          refresh,
        });
        info(
          `${item.key}: its re-plan was IN LANE and APPROVED (plan ${approved.plan.planId}, ` +
            `${approved.plan.proposalCount} proposal(s) materialized). Continuing.`,
        );
        for (const line of renderRefresh(refresh)) info(line);
        continue;
      }

      if (record.outcome === 'failed') {
        addExclude(serverUrl, projectKey, { key: item.key });
        excludedKeys.add(item.key.toUpperCase());
        if (!opts.keepGoing) {
          stopReason = interrupted ? 'interrupted' : 'halted';
          break;
        }
      } else {
        removeExclude(serverUrl, projectKey, item.key);
        excludedKeys.delete(item.key.toUpperCase());
      }
    }
  } finally {
    detachInterrupt();
  }

  // Whatever the loop queued reaches the server before the command closes the
  // run — best-effort, so a failure is one stderr line and nothing else.
  await reporter.flush();

  return {
    runId,
    records,
    skipped,
    planning,
    repos: repos.touched(),
    prs: [],
    approvals,
    lanes,
    stopReason,
  };
}

// ── THE LANE: what an unattended loop may approve on its own (MOTIR-4085) ────

/**
 * The lane this iteration is working in: the leaf, its parent, and the parent's
 * children AS THEY STAND RIGHT NOW.
 *
 * ⚠️ RE-READ, NEVER REMEMBERED. The sibling set is what the lane check tests
 * membership against, and the run has been executing this container for a while
 * — a sibling may have been filed since it started. A stale set would refuse a
 * correction to a card that is genuinely a sibling, which is the direction that
 * looks like the check working.
 *
 * A parentless leaf has no sibling level (its kind cannot parent anything, so
 * there is nowhere for a correction to go but wider), and that is reported
 * honestly as an empty set rather than papered over: `inLane` then declines
 * every `add`, and names why.
 *
 * A failed read yields the NARROWEST lane — the leaf alone. Failing open here
 * would make the bound disappear exactly when the run cannot see the tree.
 */
async function resolveLane(
  client: MotirClient,
  leafKey: string,
  parentKey: string | null,
): Promise<Lane> {
  if (parentKey === null) return { leafKey, parentKey: null, siblingKeys: [] };
  try {
    const detail = await client.getWorkItem(parentKey);
    return { leafKey, parentKey, siblingKeys: detail.children.map((c) => c.identifier) };
  } catch {
    return { leafKey, parentKey, siblingKeys: [] };
  }
}

/** What the loop decided about one submitted re-plan, before approving anything. */
type LaneDecision =
  | { kind: 'in_lane'; planId: string }
  | {
      kind: 'declined' | 'elsewhere' | 'unreadable';
      message: string;
      planId: string | null;
      record: ReplanLaneRecord;
    };

/**
 * Read the submitted plan and decide whether this run may approve it.
 *
 * ⚠️ THE READ CARRIES THE PATIENCE, and it moved here from the approval on
 * purpose. An agent submits and exits within milliseconds, so the loop routinely
 * arrives while motir-ai is still writing — and a lane check over a HALF-WRITTEN
 * plan is worse than no check at all: the proposals that have not arrived yet are
 * exactly the ones that might be out of lane, and a plan checked at proposal
 * three and approved at proposal nine has been approved unread. So this waits for
 * the plan to STOP GENERATING before it looks, with the same budget the approval
 * used to spend, and gives up by name rather than by guessing.
 */
async function decideLane(
  client: MotirClient,
  key: string,
  lane: Lane,
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LaneDecision> {
  const attempts = opts.attempts ?? APPROVE_ATTEMPTS;
  const waitMs = opts.waitMs ?? APPROVE_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let plan: NonNullable<Awaited<ReturnType<MotirClient['readWorkItemPlan']>>> | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const read = await client.readWorkItemPlan(key);
      if (read === null) {
        // ⚠️ THE ELECTION, NOT AN ERROR. Both halves of the plan-approval
        // resource resolve through the conversation ANCHORED at this key, so a
        // plan the agent deliberately anchored at a container — or at nothing,
        // when what is missing is a precondition no card names yet — is
        // structurally out of this loop's reach. The prompt offers that lane and
        // calls it legitimate, so the run reports the CHOICE rather than a
        // missing plan.
        const detail = `no plan is anchored at ${key}`;
        return {
          kind: 'elsewhere',
          message: renderElsewhereAnchored(key, detail),
          planId: null,
          record: { key, lane: 'anchored_elsewhere', planId: null, continued: false, detail },
        };
      }
      if (read.status !== 'generating') {
        plan = read;
        break;
      }
      if (attempt >= attempts) {
        // `generating` appears by NAME, not as a paraphrase: it is the plan's
        // own status, it is what the operator will see in Motir, and it is the
        // one word that tells "the planner has not finished" apart from "somebody
        // already decided this". The end-to-end test pins it for that reason.
        return unreadable(
          key,
          read.planId,
          `its plan is still generating after ${attempts} attempts — the planner has not finished writing it; approve it in Motir once it has`,
        );
      }
      if (attempt === 1) info(`${key}: its plan is still being written — waiting for the planner.`);
      await sleep(waitMs);
    } catch (err) {
      // A read that FAILED, which is a different thing from a read that answered
      // "nothing is anchored here" — that answer arrives as `null` above.
      return unreadable(
        key,
        null,
        `this run could not read it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const verdict = inLane(plan, lane);
  if (verdict.ok) return { kind: 'in_lane', planId: plan.planId };
  return {
    kind: 'declined',
    message: renderLaneDecline(key, verdict),
    planId: plan.planId,
    record: {
      key,
      lane: 'declined_out_of_lane',
      planId: plan.planId,
      continued: false,
      outOfLane: verdict.outOfLane.map((p) => `${p.op} ${p.affects} — ${p.reason}`),
    },
  };
}

/**
 * The run could not SEE the plan it was asked to approve.
 *
 * ⚠️ IT SAYS "could NOT be approved", AND THAT WORDING IS A CONTRACT RATHER THAN
 * A CHOICE. The patience for a plan that is still `generating` used to live on
 * the approval and now lives on the READ (a lane check over a half-written plan
 * is worse than none), so the STEP that gives up moved — and from the operator's
 * seat nothing moved at all: the plan was not approved, the run stopped, and the
 * reason is the planner. `tests/cli/cli-findings-story.test.ts` pins exactly
 * those two sentences end to end, and it is right to: an internal re-routing
 * must not change what an unattended run tells the person reading it in the
 * morning. What the detail adds is WHY, which is new information beside an
 * unchanged fact.
 */
function unreadable(key: string, planId: string | null, detail: string): LaneDecision {
  return {
    kind: 'unreadable',
    message: [
      `${key}: the re-plan could NOT be approved — ${detail}.`,
      'Stopping rather than continuing against a tree nobody approved.',
    ].join('\n'),
    planId,
    record: { key, lane: 'unreadable', planId, continued: false, detail },
  };
}

/**
 * RE-READ the iteration's parent after an approved in-lane plan, and hold out
 * what the plan removed (MOTIR-4085).
 *
 * ⚠️ SCOPED TO THAT PARENT, and the scope is a decision rather than an economy.
 * An in-lane plan changes the children of exactly one container; re-deriving
 * anything wider would let one leaf silently re-order work an operator queued
 * elsewhere. Nothing else in the run's state is touched.
 *
 * ⚠️ THE REMOVAL IS THE ARM THAT DOES DAMAGE SILENTLY. An added sibling arrives
 * on its own — `next_ready` asks again every iteration, so a new card that is
 * ready is offered without anybody doing anything. A REMOVED one is the opposite:
 * `remove` archives, and an archived card should never be offered — but if
 * anything ever offers one, the run would build work a plan deleted and nothing
 * would look wrong. So the removals go on the exclude list, which is the same
 * mechanism the loop already trusts to keep a card out of its own hands.
 */
async function refreshParent(
  client: MotirClient,
  lane: Lane,
  opts: { exclude: (key: string) => void },
): Promise<ReplanRefresh> {
  const before = new Set(lane.siblingKeys.map((k) => k.toUpperCase()));
  if (lane.parentKey === null) {
    return { parentKey: null, removed: [], added: [] };
  }
  let after: string[];
  try {
    after = (await client.getWorkItem(lane.parentKey)).children.map((c) => c.identifier);
  } catch {
    // A failed re-read is reported as "nothing observed" rather than as an empty
    // child set — treating it as emptiness would name every sibling as removed
    // and exclude the lot.
    return { parentKey: lane.parentKey, removed: [], added: [] };
  }
  const afterSet = new Set(after.map((k) => k.toUpperCase()));
  const removed = lane.siblingKeys.filter((k) => !afterSet.has(k.toUpperCase()));
  const added = after.filter((k) => !before.has(k.toUpperCase()));
  for (const key of removed) opts.exclude(key);
  return { parentKey: lane.parentKey, removed, added };
}

/** The per-iteration lines the operator reads about a refresh, or nothing when
 *  the approved plan left the sibling level as it found it. */
function renderRefresh(refresh: ReplanRefresh): string[] {
  const lines: string[] = [];
  if (refresh.removed.length > 0) {
    lines.push(
      `   the plan removed ${refresh.removed.join(', ')} — held out of the rest of this run.`,
    );
  }
  if (refresh.added.length > 0) {
    lines.push(`   the plan added ${refresh.added.join(', ')} — picked up when they are ready.`);
  }
  return lines;
}

/**
 * Fire ONE expansion and record how the submit went. Never throws.
 *
 * A failed expansion is NON-halting, unlike a failed agent: nothing else in the
 * run depends on it (its output could not have joined this run anyway — it needs
 * a human's approval first), so the honest response is to name the item and keep
 * dispatching. That asymmetry is the reason this swallows the error here rather
 * than letting the loop's failure policy see it.
 */
async function triggerExpansion(
  client: MotirClient,
  serverUrl: string,
  item: DispatchItem,
): Promise<PlanningRecord> {
  const base = { key: item.key, title: item.title };
  try {
    const { planId, jobId } = await client.expandItem(item.key);
    const reviewUrl = planReviewUrl(serverUrl, planId);
    info(
      `${item.key}: planning triggered — job ${jobId}, plan ${planId}. ` +
        'It produces PROPOSALS awaiting your approval; the loop moves on.',
    );
    return { ...base, outcome: 'triggered', planId, reviewUrl };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    info(`${item.key}: planning FAILED — ${detail}. Left unexpanded; the loop continues.`);
    return { ...base, outcome: 'failed', planId: null, reviewUrl: null, detail };
  }
}

export interface DispatchOneInput {
  client: MotirClient;
  item: DispatchItem;
  /** Read by the CALLER, before the checkout was resolved — see the seed-first
   *  note there. Passed in so this function makes no second prompt request. */
  dispatch: DispatchPrompt;
  target: DispatchTarget;
  /** Every repository the card ships in, primary first (MOTIR-3135) — recorded
   *  so a FAILED card reaches every repository's session pull request. */
  repos: string[];
  /** The RESOLVED targets behind {@link DispatchOneInput.repos}, so the loop's
   *  per-item output names every checkout the card will be worked in. */
  targets: DispatchTarget[];
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The run's flags — read for `--print-prompt` alone (MOTIR-3052), which has
   *  to reach the moment the prompt is handed over. Threaded as the whole option
   *  bag rather than a boolean so the SCOPED drain and `auto` pass the same
   *  thing they already hold. */
  opts: PromptEchoOptions;
  onIntegrated: (key: string) => void;
  /** The loop's git runner — the push check (MOTIR-3004) uses it. */
  run: CommandRunner;
  /**
   * The run REPORTER (Story MOTIR-1789 · MOTIR-1794), or absent.
   *
   * ⚠️ HOOKED HERE ONCE AND IT SERVES BOTH LOOPS. This function's own header
   * says `auto` and the scoped drain "differ in how they pick the next card and
   * in nothing else" — which is exactly why the events belong here rather than
   * in each command: a card dispatched by either produces the same sequence, and
   * a per-command copy would be two places for it to drift.
   *
   * Defaults to the null reporter, so wiring it in changed no behaviour and
   * every existing caller keeps working. Reporting is best-effort by
   * construction: none of these calls can throw.
   */
  reporter?: DispatchRunReporter;
  /**
   * Prepare the card's checkouts before the spawn — a HOSTED run's code graph
   * (MOTIR-6560). Absent for `auto` and a local scope.
   */
  prepareCheckouts?: (cwds: string[]) => void;
  /** The checkpoint interval (MOTIR-6539) — the tests' seam; one minute otherwise. */
  checkpointIntervalMs?: number;
}

/**
 * How long the loop will wait for a planner to finish writing a submitted plan
 * before giving up on approving it (MOTIR-3025).
 *
 * ⚠️ BOUNDED, and the bound is the decision. An unattended run must not block on
 * a planner indefinitely — that is the reason the agent submits with `--detach`
 * in the first place — but it must not give up in the first hundred
 * milliseconds either, because that is where the plan almost always is when the
 * agent exits. Roughly a minute of patience, then the run reports precisely what
 * it was waiting for and stops.
 */
const APPROVE_ATTEMPTS = Number(process.env['MOTIR_APPROVE_ATTEMPTS'] ?? '') || 12;
const APPROVE_WAIT_MS = Number(process.env['MOTIR_APPROVE_WAIT_MS'] ?? '') || 5_000;

/**
 * What one loop iteration's dispatch resolved to.
 *
 * A SKIP is not a record: nothing ran, so there is no outcome, no duration and
 * no repo to report — and `records` is what the failure policy and the exit
 * code read. Modelled as a union rather than a nullable record so the caller
 * cannot forget which of the two it is holding (the same shape `motir batch`'s
 * drain uses).
 */
export type DispatchOneResult =
  | { kind: 'record'; record: DispatchRecord }
  | { kind: 'skipped'; reason: SkipRecord['reason'] };

/**
 * Run ONE item through the single-dispatch pipeline and record how it ended.
 *
 * ⚠️ EXPORTED so the SCOPED drain (MOTIR-3199) composes it rather than growing a
 * second copy. The two loops differ in how they choose the next card — `auto`
 * asks the server every iteration, a scoped run orders a set it already owns —
 * and in nothing else: the claim, the agent spawn, the replan check, the
 * bootstrap check, the push check and the integration are one pipeline, and a
 * fork of it would be two places for the MOTIR-3004 / MOTIR-3018 checks to drift.
 */
export async function dispatchOne(input: DispatchOneInput): Promise<DispatchOneResult> {
  const { client, item, dispatch, target, agent, clock, runAgentFn, onIntegrated, run } = input;
  const reporter = input.reporter ?? nullDispatchRunReporter;

  /** Report the leg's terminal disposition, then return the result unchanged. */
  const settle = (
    result: DispatchOneResult,
    disposition: 'integrated' | 'implemented' | 'failed' | 'replanned',
  ): DispatchOneResult => {
    reporter.event({
      kind: 'card_settled',
      workItemKey: item.key,
      disposition,
      ...(result.kind === 'record' && result.record.sessionBranch
        ? { sessionBranch: result.record.sessionBranch }
        : {}),
      ...(result.kind === 'record' && result.record.detail
        ? { data: { detail: result.record.detail } }
        : {}),
    });
    return result;
  };

  // THE CLAIM, and it can say no (MOTIR-3048). The pick already narrowed to rows
  // this loop may take, but that read and this write are not one act — so a
  // sibling can have taken the card in between, and the server is the only thing
  // that can tell us so. Nothing below has run yet, so a refusal costs the loop
  // one request and no state.
  const claim = await ensureInProgress(client, item.key);
  reporter.event({
    kind: 'card_claimed',
    workItemKey: item.key,
    data: { outcome: claim.outcome },
    ...(claimAllowsDispatch(claim)
      ? { disposition: 'running' as const }
      : { disposition: 'skipped' as const, skipReason: 'claim_refused' as const }),
  });
  if (!claimAllowsDispatch(claim)) {
    info('');
    info(renderClaimRefusal(claim));
    return { kind: 'skipped', reason: 'claim_refused' };
  }

  info('');
  info(`── ${item.key} — ${item.title}`);
  info(`   ${target.cwd}  (${cwdReasonLabel(target)})`);
  // Every OTHER repository the card ships in, from the same renderer `run` /
  // `next` / `batch` use (MOTIR-3133) — nothing at all for a one-repository card.
  for (const line of renderRepositoriesBlock(input.targets)) info(`   ${line.trimStart()}`);
  info(
    dispatch.sessionBranch
      ? `   integrating into ${dispatch.sessionBranch}`
      : '   no session lineage — this item ships as its own pull request',
  );

  // BEFORE the spawn (MOTIR-3052), so the prompt is on the stream even when the
  // agent then fails, times out or is killed. One block per dispatched item, in
  // dispatch order — this function is `auto`'s loop AND the scoped drain's, so
  // both transcripts are produced by the same line.
  input.prepareCheckouts?.([
    target.cwd,
    ...input.targets.map((other) => other.cwd).filter((cwd) => cwd !== target.cwd),
  ]);
  echoPromptIfAsked(input.opts, item.key, dispatch);
  // Every repository of the leg with its branch, named before the agent exists —
  // the same event `run` / `next` / `batch` emit from the dispatch leg (MOTIR-6539).
  // The checkouts are already in place here: the drain ensured them.
  const legTargets = input.targets.length > 0 ? input.targets : [target];
  reporter.event({
    kind: 'checkout_ready',
    workItemKey: item.key,
    data: {
      repositories: legTargets.map((t) => t.targetRepo),
      failures: 0,
      branches: legBranches(dispatch, legTargets),
    },
  });
  reporter.event({ kind: 'prompt_issued', workItemKey: item.key });

  // THIS card's own conversation (MOTIR-10983). The run resolved its agent ONCE, so a
  // Motir-chosen session id is the same on every card's command, and the agent refuses
  // the second spawn on an id already in use. Each card gets its own, and records it.
  const legAgent = withFreshSessionId(agent.parsed);
  const started = clock();
  reporter.event({
    kind: 'agent_started',
    workItemKey: item.key,
    data: {
      agent: legAgent.binary,
      // Known before the spawn, as `dispatchLeg` records it (MOTIR-8980).
      ...(legAgent.stream?.sessionId ? { sessionId: legAgent.stream.sessionId } : {}),
    },
  });
  // The producer for the `log` event kind (MOTIR-3961). `null` unless the
  // operator passed `--report-log`, and then the spawn is unchanged.
  const logTee = createLegLogTee(reporter, item.key);
  // The agent's commits reach origin as it makes them (MOTIR-6539) — stopped,
  // with one last push, however the agent ends.
  const checkpoints = startCheckpoints({
    key: item.key,
    targets: legTargets,
    workBranch: dispatch.workBranch ?? null,
    reporter,
    run,
    ...(input.checkpointIntervalMs ? { intervalMs: input.checkpointIntervalMs } : {}),
  });
  const result = await runAgentFn({
    command: legAgent,
    prompt: dispatch.prompt,
    cwd: target.cwd,
    ...(logTee ? { onOutput: logTee.write } : {}),
  }).finally(() => checkpoints.stop());
  // The tail, BEFORE the exit event — same ordering as `dispatchLeg`.
  logTee?.flush();
  const durationMs = clock() - started;
  reporter.event({
    kind: 'agent_exited',
    workItemKey: item.key,
    exitCode: result.exitCode,
    // The model only the AGENT can answer for (MOTIR-2419) — its self-report, or
    // null. Never a guess. Top-level is what lands on the leg (MOTIR-7504).
    model: result.model ?? null,
    data: { model: result.model ?? null, signal: result.signal ?? null, durationMs },
  });

  const base = {
    key: item.key,
    title: item.title,
    durationMs,
    repo: dispatch.targetRepo,
    // This card's OWN conversation, for its CI watch to resume (MOTIR-9059).
    sessionId: result.sessionId ?? null,
    // The whole set, so a FAILED record reaches the pull-request body of every
    // repository it half-touched, not only the primary's (MOTIR-3135).
    repos: input.repos,
    // Off the prompt the loop already fetched — no extra request (MOTIR-2445).
    parentKey: dispatch.parentKey,
  };

  if (result.exitCode !== 0) {
    info(`${item.key}: agent exited ${result.exitCode} — left In Progress, nothing reverted.`);
    return settle(
      {
        kind: 'record',
        record: {
          ...base,
          outcome: 'failed',
          sessionBranch: null,
          detail: result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`,
        },
      },
      'failed',
    );
  }

  // ⚠️ EXIT 0 IS NOT AN OUTCOME (MOTIR-3018). A finished card and a REFUSED one
  // both exit 0, so ask the card which it was before deciding anything else.
  // FIRST, ahead of the bootstrap and push checks, because a refusing agent
  // reverts its worktree and pushes nothing BY DESIGN — those checks would
  // otherwise report a correctly-refused card as a failed bootstrap or as work
  // that went missing.
  if (await agentSubmittedReplan(client, item.key)) {
    info('');
    info(renderReplanSubmitted(item.key));
    // `sessionBranch: null` is the substantive claim here, not bookkeeping: the
    // card was never integrated, so it must not appear among the cards the
    // branch carries or in the pull request this run opens.
    // A RECORD, not a skip — and the distinction is the point. A skip means
    // nothing ran; here an agent ran, read its card and reported. The run has an
    // outcome to name (MOTIR-3048 introduced the union around this).
    return settle(
      { kind: 'record', record: { ...base, outcome: 'replanned', sessionBranch: null } },
      'replanned',
    );
  }

  // A bootstrap dispatch that did not produce its checkout is a FAILED dispatch,
  // not a success with a warning: the prompt's whole job was to create it, and
  // every later item routed at that repo would repeat the same bootstrap.
  const suspect = checkBootstrapCheckout(target);
  if (suspect) {
    info(`${item.key}: ${suspect.message}`);
    info(`Hint: ${suspect.hint}`);
    return settle(
      {
        kind: 'record',
        record: {
          ...base,
          outcome: 'failed',
          sessionBranch: null,
          detail: 'bootstrap checkout missing',
        },
      },
      'failed',
    );
  }

  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    await client.markIntegrated({
      key: item.key,
      sessionBranch: dispatch.sessionBranch,
      // The provenance triple, split by WHO KNOWS (MOTIR-2419): the harness is
      // derived from the command this loop launched, the model comes from the
      // agent's own report and is null when it made none.
      implementationHarness: deriveAgentHarness(agent.parsed.binary),
      implementationModel: result.model,
    });
    onIntegrated(item.key);
    info(`${item.key}: integrated on ${dispatch.sessionBranch} in ${formatDuration(durationMs)}.`);
    return settle(
      {
        kind: 'record',
        record: { ...base, outcome: 'integrated', sessionBranch: dispatch.sessionBranch },
      },
      'integrated',
    );
  }

  // The server kept this item off the session lineage — a target with no repo
  // checkout to branch in. Its prompt told the agent to open a pull request of
  // its own, so Implemented is the truthful status: built, pushed, waiting on CI.
  //
  // ⚠️ EXIT 0 IS NOT A PUSH (MOTIR-3004) — checked here for the same reason the
  // single-item path checks it, and with the loop's own git runner.
  if (workReachedRemote(target.cwd, item.key, null, run) === 'nothing') {
    info(`${item.key}: agent exited 0 but nothing reached the remote — left In Progress.`);
    return settle(
      {
        kind: 'record',
        record: {
          ...base,
          outcome: 'failed',
          sessionBranch: null,
          detail: 'nothing reached the remote',
        },
      },
      'failed',
    );
  }
  // ⚠️ THE REFUSAL IS AN OUTCOME, NOT A CRASH (Bug MOTIR-3268). A CONTAINER
  // reaching this line — a `task` or `bug` that acquired children of its own —
  // is told `CONTAINER_HAS_OPEN_CHILDREN`, and an unhandled throw here escapes
  // the loop before `closeOutRepos`, abandoning every other repository's
  // finished work. The card honestly stays In Progress, which is what `failed`
  // means in this vocabulary: nothing was reverted, and the work IS on the
  // remote.
  const refusal = await transitionToImplemented(client, item.key);
  if (refusal) {
    info(`${item.key}: ${refusal}`);
    return settle(
      {
        kind: 'record',
        record: {
          ...base,
          outcome: 'failed',
          sessionBranch: null,
          detail: 'container has open children',
        },
      },
      'failed',
    );
  }
  info(
    `${item.key}: Implemented via its own pull request in ${formatDuration(durationMs)} — CI decides when it is reviewable.`,
  );
  return settle(
    {
      kind: 'record',
      record: { ...base, outcome: 'implemented', sessionBranch: null, detail: 'own pull request' },
    },
    'implemented',
  );
}

/** The default statuses a card reaches AFTER Implemented and can be moved back from. */
const PAST_IMPLEMENTED: ReadonlySet<string> = new Set(['in_review', 'approved']);

/**
 * Move one card to Implemented, answering the ONE refusal a run reports rather
 * than dies on: `null` on success, the server's own sentence when the container
 * gate refused it (Bug MOTIR-3268).
 *
 * ⚠️ IT NARROWS TO THAT ONE CODE AND RETHROWS EVERYTHING ELSE. A blanket catch
 * here would swallow an auth failure, a rate limit and a 500 into a card-shaped
 * outcome, which is how a run reports "the container has open children" for a
 * server that was simply unreachable. Shared by `motir auto`'s loop and `motir
 * batch` so the two cannot disagree about what a 422 means.
 */
export async function transitionToImplemented(
  client: MotirClient,
  key: string,
): Promise<string | null> {
  // ⚠️ NEVER BACKWARDS. `in_review → implemented` and `approved → implemented`
  // are DECLARED edges since MOTIR-5630 (a merge-queue ejection writes them), so
  // the server no longer refuses this move when CI got there first. Written
  // blind, it would demote a card the webhook already promoted, and nothing
  // would promote it again: its checks are already green. A card past
  // Implemented is already what this call wants, so it is a success.
  //
  // A read that fails falls through to the write it guards, which is what ran
  // before: an auth or network fault surfaces there, and is rethrown below.
  const status = await client.getWorkItem(key).then(
    (d) => d.item.status,
    () => null,
  );
  if (status !== null && PAST_IMPLEMENTED.has(status)) return null;
  try {
    await client.transitionStatus({ key, status: 'implemented' });
    return null;
  } catch (err) {
    if (err instanceof ContainerHasOpenChildrenError) return err.message;
    throw err;
  }
}

/**
 * Make sure THIS repository's session pull request exists — as a DRAFT, mid-run
 * (Story MOTIR-3655 · MOTIR-3681 · MOTIR-4967 · MOTIR-4999).
 *
 * Called after every card that LANDS, so the first implemented card in each
 * repository opens that repository's pull request and every card after it finds
 * the same one. `openSessionPr` lists before creating, so the repeat is a cheap
 * no-op and the run holds no "have I opened it?" state of its own — which is
 * what makes a resumed or re-invoked run safe.
 *
 * ⚠️ EXPORTED FOR THE SCOPED LANE (MOTIR-4999), alongside `RepoSessions`,
 * `dispatchOne` and `closeOutRepos`. `commands/scopeDrain.ts` writes its own
 * iteration and calls this on the same trigger `runAutoLoop` uses, so the two
 * loops cannot disagree about WHEN a session pull request opens or about what it
 * is opened WITH. It holds no state, so calling it from a second loop needs
 * nothing coordinated between them.
 *
 * ⚠️ A FAILURE HERE IS REPORTED AND SWALLOWED. The agent's work is already
 * committed and pushed; refusing to continue the loop because `gh` was missing
 * would abandon the cards still queued behind a tooling gap. The close-out at
 * the end tries again and reports properly.
 */
export async function ensureRepoPullRequest(
  session: RepoSession,
  runId: string,
  run: CommandRunner,
  /**
   * The LINK half (MOTIR-4969) — the client to declare through, and the whole
   * run's landed records, whose parent partition decides WHAT this pull request
   * delivers.
   *
   * ⚠️ THE RUN'S SET, NOT THIS REPOSITORY'S. The title is per-repository because
   * a reviewer of repo A must not read repo B's cards; the LINK is not, because
   * a container spanning two repositories is delivered by both of its pull
   * requests and the completion gate holds it until every one of them has
   * merged. Passing one repository's slice here would leave the container linked
   * in whichever repository happened to carry two cards.
   *
   * ⚠️ AND A SCOPED RUN'S `container` (MOTIR-10985). The scoped lane knows the
   * story it delivers before the first card starts, so the draft is titled for
   * that story and linked to it at the FIRST landed card. Reading it off the
   * carried set instead left a one-card set titled for the card and linked to
   * nothing until a second card landed. `motir auto` passes none and keeps the
   * partition's arms.
   */
  link: {
    client: MotirClient;
    carried: readonly DispatchRecord[];
    container?: SessionPrContainer;
  },
): Promise<void> {
  try {
    if (!sessionBranchHasCommits(session.cwd, session.branch, run)) return;
    const result = openSessionPr(
      session.cwd,
      {
        branch: session.branch,
        title: sessionPrTitle(runId, [], link.container),
        // Deliberately thin: what has landed at THIS moment, and a sentence
        // saying the close-out completes it. Rewritten in full at the end.
        // ⚠️ IT NAMES THE RUN, NOT THE COMMAND (MOTIR-4999). Both `motir auto`
        // and the scoped drain open through here now, so a sentence naming one
        // of them is false on the other lane for as long as the draft carries
        // the thin body — which is exactly the window a reviewer might open it.
        body:
          `Opened at this repository's first implemented work item of run \`${runId}\`, ` +
          `so its checks run against the work as it lands rather than only at the end.\n\n` +
          `Carried so far: ${session.keys.length > 0 ? session.keys.join(', ') : '—'}\n\n` +
          `_This body is rewritten with the full run when the loop finishes._`,
      },
      run,
    );
    if (result.outcome === 'opened' && result.url) {
      info(`Opened ${result.url} for ${session.branch}.`);
    } else if (result.outcome === 'failed' && result.message) {
      info(result.message);
    }
    // ⚠️ AT CREATION, which in practice means AS SOON AS THE ARM IS KNOWN
    // (MOTIR-4969, point 5 of the decided lifecycle). A run's first landed card
    // is a set of one — `one-card`, indistinguishable from a leaf run — and only
    // the second card of the same parent makes it `shared-parent`. So this is
    // asked on EVERY landed card rather than only on the call that created the
    // pull request, and the arm is what gates it.
    //
    // Re-declaring the same delivery is a genuine no-op: the row is upserted on
    // `(work_item, pull_request)`, so this holds no "have I linked it?" state,
    // exactly as the open above holds no "have I opened it?" state — which is
    // what keeps a resumed or re-invoked run safe.
    if (result.url) await linkSessionPrToContainer(link, session.branch, result.url);
    // ⚠️ AND, IN A SCOPED RUN, EVERY CARD THAT HAS LANDED HERE (MOTIR-10985). Its
    // agent links its own card only if the pull request already existed, which
    // is never true of the run's first card in a repository, so the run links the
    // cards it carried. An upsert per `(work item, pull request)`, so repeating
    // it on every landed card is a no-op for the cards already linked.
    if (result.url && link.container) {
      for (const key of session.keys) {
        await linkSessionPrTo(link.client, key, session.branch, result.url);
      }
    }
  } catch (err) {
    info(
      `Could not open ${session.branch}'s pull request yet: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The base branch every session pull request targets — `openSessionPr` opens
 * with `--base main`, and a link that named anything else would seed the row
 * with a base the pull request does not have.
 */
const SESSION_PR_BASE = 'main';

/**
 * DECLARE that this repository's session pull request delivers the container the
 * run's carried set shares — when it shares one (MOTIR-4969).
 *
 * ⚠️ IT ADDS TO WHAT THE AGENTS ALREADY WROTE, and does not replace it. Every
 * dispatched agent links this same pull request to its OWN card (MOTIR-3678), so
 * a merge already closes the children; what nothing linked is the CONTAINER, so
 * the story stayed open on work that had entirely shipped. A delivery is a row
 * and rows accumulate, so both are true at once — and linking the parent is what
 * stays correct as children are added, since the merge cascades DOWN from it.
 *
 * ⚠️ REPORTED AND SWALLOWED, like every other close-out side effect here. The
 * agents' work is committed, pushed and open for review by the time this runs;
 * abandoning a run over a link call would strand real work behind a network
 * hiccup, and the missing link is visible on the pull request itself as a red
 * `Motir / work item link` check.
 */
async function linkSessionPrToContainer(
  link: {
    client: MotirClient;
    carried: readonly DispatchRecord[];
    container?: SessionPrContainer;
  },
  branch: string,
  url: string,
): Promise<void> {
  // ⚠️ A SCOPED RUN'S OWN WORK ITEM, or ONLY `shared-parent` (MOTIR-10985). A
  // scoped run links the story it was launched against from its first card. An
  // unscoped `one-card` run's pull request is the card's own and the agent has
  // already linked it; a `many-parents` run has no container, and a run
  // carrying two parents must not invent a story to name.
  const key = deliveredContainerKey(link.carried.filter(landedWork), link.container);
  if (key === null) return;
  await linkSessionPrTo(link.client, key, branch, url);
}

/** Declare that a session pull request delivers `key` — reported and swallowed. */
async function linkSessionPrTo(
  client: MotirClient,
  key: string,
  branch: string,
  url: string,
): Promise<void> {
  try {
    await client.linkPullRequest({ key, url, headRef: branch, baseRef: SESSION_PR_BASE });
  } catch (err) {
    info(
      `Could not link ${url} to ${key}: ` + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The CONTAINER half of the close-out (MOTIR-4969): make sure every repository's
 * session pull request declares the container it delivers, then move that
 * container to Implemented — ONCE.
 *
 * ── Why it is its own call, AFTER `closeOutRepos` ──────────────────────────
 * The order is the rule, and it is invisible on the happy path: ready
 * everywhere, then the flip. `closeOutRepos` is what rewrites each pull
 * request's title and body and then marks it ready, so a container moved to
 * Implemented before it returns would claim the run finished while a reviewer is
 * still looking at a draft saying "0 work items".
 *
 * It reads {@link AutoSummary.prs}, which `closeOutRepos` is what WRITES — so a
 * caller that ran this first finds an empty list and does nothing. The ordering
 * is therefore structural rather than a convention two lanes have to remember,
 * which is the property MOTIR-4999 was paid for by not having.
 *
 * ⚠️ A RUN THAT DIES BEFORE THIS LEAVES DRAFTS AND A CONTAINER THAT IS NOT
 * IMPLEMENTED, and that pair is TRUE. Any other arrangement claims more than
 * happened.
 */
export async function closeOutContainer(client: MotirClient, summary: AutoSummary): Promise<void> {
  const carried = summary.records.filter(landedWork);
  const containerKey = deliveredContainerKey(carried, summary.container);
  if (containerKey === null) return;
  const { container } = summary;

  // Every repository's pull request delivers the container. `ensureRepoPullRequest`
  // has normally said so already; this covers the pull request that did not exist
  // until the close-out opened it, and costs one idempotent call otherwise.
  for (const pr of summary.prs) {
    if (!pr.url) continue;
    await linkSessionPrToContainer(
      { client, carried, ...(container ? { container } : {}) },
      pr.branch,
      pr.url,
    );
  }

  // ⚠️ NOT WHILE A CHILD IS OUTSTANDING — the same gate, and the same re-read,
  // that holds every repository's pull request a draft. Claiming a container is
  // built while a child of its own is not is Bug MOTIR-3229's shape, and the
  // server refuses it (`CONTAINER_HAS_OPEN_CHILDREN`); this is the run declining
  // to ask rather than relying on the refusal.
  if (summary.outstanding && summary.outstanding.keys.length > 0) {
    info(
      `${containerKey} stays as it is: ${summary.outstanding.keys.length} of its children ` +
        `have not landed (${summary.outstanding.keys.join(', ')}).`,
    );
    return;
  }

  // ⚠️ AND NOT WHILE ANY REPOSITORY'S PULL REQUEST IS STILL A DRAFT. A
  // two-repository container finishes its repositories at different points and
  // is marked ready in ONE pass at the close-out, so the honest question is
  // whether that pass succeeded everywhere — a `failed` open, or a `gh pr ready`
  // that refused, leaves work nobody can review, and Implemented would say
  // otherwise.
  const live = summary.prs.filter((pr) => pr.url !== null);
  if (live.length === 0) return;
  const stillDraft = live.filter((pr) => pr.draft);
  if (stillDraft.length > 0) {
    info(
      `${containerKey} stays as it is: ${stillDraft
        .map((pr) => pr.branch)
        .join(', ')} ${stillDraft.length === 1 ? 'is' : 'are'} still a draft.`,
    );
    return;
  }

  // ⚠️ IMPLEMENTED, NEVER IN REVIEW. A pull request being open is what
  // Implemented means (MOTIR-3005); CI is what promotes it from there, and a run
  // that wrote In Review itself would be asserting a verdict nothing has reached.
  //
  // ⚠️ ONCE, not once per repository. A container has one status, and two
  // attempts would spend a second call on a no-op at best.
  //
  // ⚠️ IDEMPOTENT BY THE SERVER'S OWN CONTRACT: a status move to the status the
  // item already holds returns without a revision, so MOTIR-4968's webhook
  // having got here first makes this a no-op rather than an error. The two are
  // deliberately BOTH written — the run writes it eagerly, the webhook writes it
  // authoritatively — and neither is a fallback for the other.
  try {
    const refusal = await transitionToImplemented(client, containerKey);
    if (refusal) info(`${containerKey}: ${refusal}`);
    else info(`${containerKey}: Implemented — every card this run carried has landed.`);
  } catch (err) {
    // Reported and swallowed, exactly as `openSessionPr` / `updateSessionPr` /
    // `markSessionPrReady` are. The commonest arrival here is not a fault at all:
    // a refusal the server wrote (the container gate, or an edge a custom
    // workflow does not declare). A container CI already moved on to In Review is
    // not one: `transitionToImplemented` reads it first and leaves it there. The
    // work is reviewable either way, and a run that aborted its summary over this
    // would hide it.
    info(
      `Could not move ${containerKey} to Implemented: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * WATCH every card this run landed, fixing each red (Story MOTIR-3655 ·
 * MOTIR-3685). Returns whether every one of them ended green.
 *
 * ── Per CARD, and the cwd is the card's OWN repository ────────────────────
 * A `motir auto` run spanning three repositories opens three pull requests off
 * three branches — `sessionLineageWorkflow` builds each worktree from that
 * card's `targetRepo` and branches off `origin/<sessionBranch>` IN that
 * repository. So a fix has to be committed in the checkout CI is red on, not in
 * whichever one happened to be first.
 *
 * ── The budget is PER CARD here, and that is the honest reading ───────────
 * The five is "five fixing attempts against this card's build". A run of twelve
 * cards is twelve independent builds; sharing one budget across them would let
 * the first card's flakes deny the twelfth any attempt at all.
 *
 * A card whose repository session cannot be found is watched with no fixing
 * agent rather than skipped: the verdict is still worth reporting, and a run
 * that quietly declined to look is worse than one that looked and could not act.
 */
export async function watchRunCi(
  summary: AutoSummary,
  session: ProjectSession,
  agent: ResolvedAgent,
  opts: AutoOptions,
  deps: AutoDeps,
): Promise<boolean> {
  const landed = summary.records.filter(landedWork);
  if (landed.length === 0) return true;

  let allGreen = true;
  for (const record of landed) {
    const repo = summary.repos.find((r) => r.keys.includes(record.key));
    // Each card resumes ITS OWN conversation, never the previous card's (MOTIR-9059).
    const resumeAgent = resumeFixAgent(agent.parsed, record.sessionId);
    const outcome = await runCiWatchPhase({
      client: session.client,
      key: record.key,
      title: record.title,
      agent: agent.parsed,
      ...(resumeAgent ? { resumeAgent } : {}),
      cwd: repo?.cwd ?? process.cwd(),
      report: (line) => info(line),
      ...(deps.runAgentFn ? { runAgentFn: deps.runAgentFn } : {}),
      ...(deps.wait ? { wait: deps.wait } : {}),
      ...(deps.maxCiPolls === undefined ? {} : { maxPolls: deps.maxCiPolls }),
    });
    if (outcome.kind === 'gave_up' || outcome.kind === 'fix_failed') allGreen = false;
  }
  // `opts` is read for nothing here ON PURPOSE, and the absence is the decision:
  // `--keep-going` is a DRAIN flag — it says whether one bad card ends the run —
  // and `motir auto` has no next card to start by the time this runs. Gating the
  // watch on it would give the flag a second, unrelated meaning in one lane.
  void opts;
  return allGreen;
}

// ── the end-of-run close-out ────────────────────────────────────────────────

/**
 * Push each touched session branch and open ONE pull request per repo.
 *
 * Runs on EVERY exit path — drained, `--max`, a halt, Ctrl-C — because a run
 * that integrated three items and then hit a failure must not abandon those
 * three. This is the loop's only human gate: main has none of this work until
 * somebody merges these.
 */
export function closeOutRepos(
  summary: AutoSummary,
  run: CommandRunner,
  /**
   * The claimed container's CURRENT children that have not landed
   * (`readOpenChildren`), or `null` when there is no container to re-read —
   * `motir auto` and a sprint scope both pass nothing.
   *
   * ⚠️ IT DECIDES READY, NOT WHETHER TO OPEN — and that is the whole of what
   * MOTIR-4967 changed about Bug MOTIR-3268. A container with an open child used
   * to get NO pull request, on the reasoning that one opened over it claims the
   * container is built. It now gets a DRAFT: a draft cannot be merged, so it
   * cannot close the container or cascade `done` onto the very children that are
   * missing — and the work gets CI, which the hold denied it.
   */
  open: { containerKey: string; openChildren: readonly string[] } | null = null,
  /**
   * The run's HOW TO TEST (MOTIR-5358) — its run target and the record the
   * close-out step read back — rendered as each body's `## How to test` section.
   * Omitted by `motir auto`, which has no run target.
   */
  howToTest?: HowToTestForBody,
): void {
  const outstanding = open && open.openChildren.length > 0 ? open : null;
  if (outstanding) {
    summary.outstanding = {
      containerKey: outstanding.containerKey,
      keys: [...outstanding.openChildren],
    };
  }
  for (const repo of summary.repos) {
    const report = closeOutRepo(summary, repo, run, outstanding, howToTest);
    summary.prs.push(report);
  }
}

function closeOutRepo(
  summary: AutoSummary,
  repo: RepoSession,
  run: CommandRunner,
  outstanding: { containerKey: string; openChildren: readonly string[] } | null,
  howToTest?: HowToTestForBody,
): PrReport {
  const base = { repoName: repo.repoName, branch: repo.branch };
  try {
    // Normally a no-op: the prompt already had the agent push. This catches the
    // agent that integrated locally and stopped.
    const pushed = pushSessionBranchIfAhead(repo.cwd, repo.branch, run);
    if (pushed === 'pushed') info(`Pushed ${repo.branch} in ${repo.cwd}.`);

    if (!sessionBranchHasCommits(repo.cwd, repo.branch, run)) {
      return { ...base, url: null, outcome: 'empty' };
    }
    // Only THIS repo's items belong in THIS repo's pull request: the branch
    // carries the ones integrated onto it, and the failures listed alongside are
    // the ones that were attempted in the same repo.
    const mine = summary.records.filter(
      (r) =>
        r.sessionBranch === repo.branch ||
        // A failed card belongs in the body of EVERY repository it was attempted
        // in, not only its primary (MOTIR-3135). `repos` is absent on records
        // written before it existed, and the scalar is that record's whole set.
        (r.outcome === 'failed' && (r.repos ?? [r.repo]).includes(repo.repoName)),
    );
    const carried = mine.filter(landedWork);
    const result = openSessionPr(
      repo.cwd,
      {
        branch: repo.branch,
        title: sessionPrTitle(summary.runId, carried, summary.container),
        // The agents' own commit messages, read from THIS repo's checkout
        // against THIS repo's branch — a multi-repo run must not put another
        // repo's commits in this body (MOTIR-2411).
        body: renderSessionPrBody(
          summary.runId,
          repo.branch,
          mine,
          sessionBranchCommits(repo.cwd, repo.branch, run),
          howToTest ? { ...howToTest, repoName: repo.repoName } : undefined,
        ),
      },
      run,
    );
    // MOTIR-3681 — the pull request was opened mid-run, at this repository's
    // first implemented card, with a body describing only what had landed then.
    // `existing` is now the ORDINARY outcome rather than a resumed-run edge, so
    // the full body is written here. A refresh failure is reported and does not
    // change the outcome: the work is reviewable either way.
    let refreshMessage: string | undefined;
    if (result.outcome === 'existing') {
      const refreshed = updateSessionPr(
        repo.cwd,
        repo.branch,
        {
          // BOTH, because the title counts cards: one written at the first
          // implemented card names one card for ever.
          title: sessionPrTitle(summary.runId, carried, summary.container),
          body: renderSessionPrBody(
            summary.runId,
            repo.branch,
            mine,
            sessionBranchCommits(repo.cwd, repo.branch, run),
            howToTest ? { ...howToTest, repoName: repo.repoName } : undefined,
          ),
        },
        run,
      );
      if (!refreshed.ok) refreshMessage = refreshed.message;
    }

    // ⚠️ READY COMES LAST, AND THE ORDER IS THE RULE (MOTIR-4967). The pull
    // request opened at the first implemented card carries a title that counts
    // ONE card — `updateSessionPr` above is what makes it describe the whole run.
    // Marking it ready before that rewrite would notify every reviewer about a
    // body saying "0 work items", which is the exact failure the draft exists to
    // prevent; doing it after means the pull request becomes reviewable only once
    // it is worth reading.
    //
    // ⚠️ AND NOT AT ALL WHILE A CHILD IS OUTSTANDING. That is Bug MOTIR-3268's
    // invariant, carried by the draft rather than by withholding the pull
    // request: a draft cannot merge, so it cannot complete the container or
    // cascade `done` onto the children that have not been built.
    //
    // ⚠️ AND NOT WHEN THERE IS NO PULL REQUEST TO MARK. A `failed` open already
    // carries the reason a human needs; asking `gh` to ready a branch that has
    // none would fail a second time and overwrite that reason with a message
    // about draft state, which is not the problem.
    let draftMessage: string | undefined;
    if (result.outcome === 'failed') {
      draftMessage = undefined;
    } else if (outstanding) {
      draftMessage =
        `${outstanding.containerKey} still has ${outstanding.openChildren.length} unlanded ` +
        `child${outstanding.openChildren.length === 1 ? '' : 'ren'} ` +
        `(${outstanding.openChildren.join(', ')}) — see above.`;
    } else {
      const ready = markSessionPrReady(repo.cwd, repo.branch, run);
      if (!ready.ok) draftMessage = ready.message;
    }

    return {
      ...base,
      url: result.url,
      outcome: result.outcome,
      ...(draftMessage ? { draft: true } : {}),
      ...(draftMessage || result.message || refreshMessage
        ? { message: draftMessage ?? result.message ?? refreshMessage ?? '' }
        : {}),
    };
  } catch (err) {
    return {
      ...base,
      url: null,
      outcome: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Approve the plan a refused card produced. NEVER THROWS.
 *
 * ⚠️ THE REFUSALS ARE THE INTERESTING RETURN VALUE, which is why this reports
 * rather than raises. Every one of them is a BOUND the server is enforcing —
 * there is no plan of this card's own, the plan was already decided, the token
 * lacks `ai:view_plan` — and each means the same thing to the loop: it must not
 * carry on against a tree nobody approved. Letting the error propagate would
 * take the run's close-out down with it (the shape MOTIR-3018's reproduction
 * found), abandoning work that has nothing to do with this plan.
 *
 * ⚠️ IT SENDS NO PLAN ID, and cannot. The plan was submitted by the AGENT, in a
 * sandbox, with the `submit_plan_session` tool anchored at `targetKeys: [<KEY>]`
 * (MOTIR-4083; the retired door was `motir plan --detach <KEY>`); its id came
 * back in that agent's tool result, which this process never sees. The card IS the address, and the server derives the plan from the
 * conversation anchored at it — so the run cannot approve a plan the card did
 * not produce even by mistake.
 */
async function approveSubmittedPlan(
  client: MotirClient,
  key: string,
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<
  { ok: true; plan: { planId: string; proposalCount: number } } | { ok: false; message: string }
> {
  const attempts = opts.attempts ?? APPROVE_ATTEMPTS;
  const waitMs = opts.waitMs ?? APPROVE_WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, plan: await client.approveWorkItemPlan(key) };
    } catch (err) {
      // ⚠️ `generating` IS "NOT YET", AND WAITING IS THE POINT. The agent
      // submitted with `--detach` — it must not sit on a planner — and exited
      // within milliseconds, so the loop routinely arrives while motir-ai is
      // still writing the plan. Treating that as a refusal would make the flag
      // useless in exactly its normal case; treating a DECIDED plan the same way
      // would keep retrying something a person already answered. The server
      // tells the two apart as data, which is why this branches on the field.
      const notYet = err instanceof PlanNotDecidableError && err.planStatus === 'generating';
      if (notYet && attempt < attempts) {
        if (attempt === 1) {
          info(`${key}: its plan is still being written — waiting for the planner.`);
        }
        await sleep(waitMs);
        continue;
      }
      // The SERVER's own sentence, verbatim. A message this loop composed would
      // describe the refusal it guessed at rather than the one it received.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: notYet
          ? `${message} (still generating after ${attempts} attempts — approve it in Motir once the planner finishes)`
          : message,
      };
    }
  }
}
