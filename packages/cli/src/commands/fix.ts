import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runAgent as defaultRunAgent, type AgentRunResult } from '../agentRun.js';
import type { ParsedAgentCommand } from '../agentProfiles.js';
import {
  pluralize,
  queueReasonInWords,
  renderAcceptanceRecordPrompt,
  renderAcceptanceRerunPrompt,
  renderReviewFixPrompt,
  runCiWatchPhase,
  type AcceptanceRerunInput,
  type ReviewFixInput,
  type CiWatchOutcome,
  type FixCheckout,
} from '../ciWatch.js';
import type {
  DispatchRunRepair,
  DispatchStopReason,
  MotirClient,
  RepairPullRequest,
  WorkItemRepairClaim,
  WorkItemRepairRefusal,
} from '../client.js';
import {
  materializeDispatchCheckouts,
  renderMaterialization,
  resolveDispatchTarget,
  resolveDispatchTargets,
} from '../dispatch.js';
import { createLegLogTee } from '../agentLogTee.js';
import { createDispatchRunReporter } from '../dispatchRunReporter.js';
import { bindInterruptSignals, INTERRUPT_EXIT_CODE, type InterruptSignal } from '../interrupt.js';
import { CliError } from '../errors.js';
import { execCommand, type CommandRunner } from '../git.js';
import type { LinkConfig } from '../config/linkConfig.js';
import { chooseRepairAgent, withFreshFallback } from '../agentResume.js';
import { hostedOpenCodeAgent } from '../hostedAgent.js';
import { activeHostedRun } from '../hostedAttribution.js';
import { lockHostedRunToBranches } from '../hostedGit.js';
import { assertAdoptsLeaf, hostedRunId, isAgentRun, type AdoptedRun } from '../hostedMode.js';
import { info } from '../output.js';
import { withHostedProjectSession, withProjectSession } from '../session.js';
import { requireAgent } from './auto.js';
import { CI_WATCH_EVENT, CI_WATCH_STOP_REASON, hostedCheckoutPreparer } from './dispatch.js';

// `motir fix <key>` (Story MOTIR-5460 · MOTIR-5465) — hand a card's RED pull
// requests to an agent, after the run that opened them has ended: an `implemented`
// card, or an `in_review` one the merge queue threw out for a reason a code change
// could answer (MOTIR-5803; a setting or a hand removal is refused `repair_not_code`).
//
// ── Everything it needs already ships, except the claim and the checkout ─────
// The fixing loop is `runCiWatchPhase` exactly as `motir run` calls it: the same
// prompt (`renderFixPrompt`), the same five-attempt cap, the same green / pending
// / red rules. What a finished run lacks is (a) a claim that says *this repair is
// mine* without moving the card — the server's repair claim, which opens a `fix`
// dispatch run as its lock — and (b) a checkout of the pull requests' OWN
// branches, because the worktree the original run used is long gone.
//
// ── Every exit path CLOSES the run ────────────────────────────────────────────
// The item page reads an open `fix` run as *being fixed*. A command that died
// with its run open would tell everyone somebody is still working when nobody
// is — and would refuse every later `motir fix` as `taken`. So the close is
// idempotent and is reached from the refusal of a checkout, from green, from a
// give-up, from a thrown error, and from Ctrl-C.
//
// ── An ACCEPTANCE RE-RUN is a repair too (MOTIR-6502) ─────────────────────────
// A story whose acceptance video was sent back with **Re-run** is claimed as an
// `acceptance_rerun`: its checks are usually green, and the claim hands over every
// open member with the reviewer's reason. Before the CI loop, the agent runs ONCE on
// the re-run prompt (the reason, the scope, push to the same branches); the loop then
// runs unchanged; and once it is green, a CLOSING turn re-records and publishes the
// acceptance video, which asks the question again (`acceptance-refusal-verdict.md` §4).
// The `ci` class is byte for byte what it was.
//
// ── A card a REVIEW SENT BACK is a repair too (MOTIR-6822) ────────────────────
// The review agent's findings, or a person's Request changes on the approve-and-merge
// gate, still standing over the current version, is claimed as a `review`: its checks are
// usually green, and the claim hands over every open member with the findings. Before the
// CI loop the agent runs ONCE on the review-fix prompt (every finding, in full, push to the
// same branches); the loop then runs unchanged. There is no closing turn — the push
// withdraws the review, and the next green version is reviewed again (§12.4, §12.5).
//
// ── In a HOSTED container it ADOPTS, never claims (MOTIR-6929) ────────────────
// *Fix on the hosted agent* (`hosted-agent-run.md` §8.6): the server took the repair
// claim when the person pressed, opened the `command: fix` run as its lock, recorded
// what it decided on the run's ONE `run_opened` (MOTIR-6928), and booted this
// container with `MOTIR_RUN_MODE=fix`. So with a hosted run id the command reads that
// decision back from the run (`DispatchRun.repair`) — the hosted `continue`'s
// precedent (MOTIR-6795) — and `claimWorkItemRepair` is never called: a second claim
// would find the card `taken` by its own run. It then clones every repository of the
// pull requests, checks each out ON its own branch, LOCKS pushes to exactly those
// branches and `gh` shut (`lockHostedRunToBranches`), and hands the same `repair()`
// the same claim shape a terminal would. A repair whose agent pushed nothing ends
// there: nothing to watch, the card stays To fix.
//
// ── What it never does ────────────────────────────────────────────────────────
// It writes no status (the build moves the card, through `ciPromotion`), opens
// no pull request, and links nothing. It adds nothing to `motir auto` or
// `motir batch`.

export interface FixOptions {
  /** `--agent <cmd>` — the fixing agent (overrides MOTIR_AGENT). */
  agent?: string;
  /** `--report-log` — ALSO send the agent's output to Motir. Off by default. */
  reportLog?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface FixDeps {
  /** The git runner, so a test scripts the checkout without a real remote. */
  run?: CommandRunner;
  /** Path existence, for the checkout resolution and a resumed worktree. */
  exists?: (path: string) => boolean;
  runAgentFn?: (input: {
    command: ParsedAgentCommand;
    prompt: string;
    cwd: string;
  }) => Promise<AgentRunResult>;
  wait?: () => Promise<void>;
  maxCiPolls?: number;
  /**
   * Install the interrupt handler and return its remover. Production binds
   * SIGINT and SIGTERM (`interrupt.ts`, MOTIR-6530); a test calls the handler
   * directly to prove the run is closed.
   */
  onInterrupt?: (handler: (signal?: InterruptSignal) => void) => () => void;
  /** How the process ends after an interrupt. `process.exit` in production. */
  exit?: (code: number) => void;
  /** The environment — where a hosted run id and the run's model are read. */
  env?: NodeJS.ProcessEnv;
  /** HOSTED: lock the run's pushes to these branches. Defaults to the active hosted run's state. */
  lockPushes?: (
    allowed: ReadonlyArray<{ repository: string; branch: string }>,
    env: NodeJS.ProcessEnv,
  ) => void;
  /** HOSTED: per-checkout preparation (the code graph). */
  prepareHostedCheckouts?: (cwds: string[]) => void;
}

/** The launcher's exit code for a run that could not be set up (`sandbox/hosted/entrypoint.ts`). */
const HOSTED_SETUP_FAILED = 20;

/**
 * The words for each refusal — TOTAL over the server's reason vocabulary, so a
 * new reason is a type error here rather than a silent generic line.
 */
const REFUSAL_LINES = {
  not_implemented: () =>
    'it is not waiting on a repair. `motir fix` picks up a card whose run has ended and whose ' +
    'pull requests went red afterwards, or that the merge queue threw out.',
  repair_on_run_target: (claim) =>
    `its pull requests belong to the run on ${claim.runTargetKey ?? 'its parent'} — ` +
    `run \`motir fix ${claim.runTargetKey ?? '<that key>'}\` instead.`,
  no_pull_requests: () => 'it has no pull requests, so there is nothing to repair.',
  ci_running: () =>
    'its checks are still running and nothing has failed yet. Wait for the verdict, and run ' +
    'this again if it goes red.',
  not_failing: () => 'nothing is failing on its open pull requests, so there is nothing to repair.',
  // ⚠️ THE MERGE FAILED, AND NO CODE CHANGE ANSWERS IT (MOTIR-5803; `approval-gates.md`
  // §4 FOURTH AMENDMENT, point 6). An agent would push nothing and the run would be
  // spent, so the refusal names what would actually help.
  repair_not_code: () =>
    'its merge did not land for a reason no code change fixes — a repository setting blocked ' +
    'it, or somebody took the pull request out of the queue. Approve it again in Motir, or ' +
    'change the setting the card names; there is nothing here for an agent to repair.',
} as const satisfies Record<WorkItemRepairRefusal, (claim: WorkItemRepairClaim) => string>;

/** A refused repair, in words. Exported so the vocabulary can be pinned. */
export function renderRepairRefusal(claim: WorkItemRepairClaim): string {
  if (claim.outcome === 'taken') {
    const who = claim.holder?.name ?? 'somebody else';
    const since = claim.startedAt ? ` since ${claim.startedAt}` : '';
    return [
      `${claim.key}: already being fixed by ${who}${since} — not starting a second repair.`,
      'Two agents pushing to one pull request undo each other. Nothing was changed.',
    ].join('\n');
  }
  // `not_repairable` is the only other refusal; a missing reason is a server
  // that predates the field, and the generic line is the honest answer to it.
  const reason = claim.reason;
  const why = reason ? REFUSAL_LINES[reason](claim) : 'the server refused the repair.';
  return `${claim.key}: not repairable — ${why}\nNothing was changed.`;
}

type Prepared = { ok: true; checkouts: FixCheckout[] } | { ok: false; message: string };

/**
 * CHECK OUT each failing pull request's OWN branch in a worktree beside its
 * repository's checkout — ON the branch, never detached, so the agent's push
 * updates the pull request that is already open.
 *
 * A resumed repair (`mine`) finds its worktree still there and reuses it when it
 * is on the right branch. Anything else that is in the way is a refusal: this
 * command never resets, removes or re-points a worktree it did not just make.
 */
export function prepareCheckouts(input: {
  key: string;
  pullRequests: readonly RepairPullRequest[];
  rootDir: string;
  config: LinkConfig;
  run: CommandRunner;
  exists: (path: string) => boolean;
}): Prepared {
  const checkouts: FixCheckout[] = [];
  for (const pr of input.pullRequests) {
    const repoName = pr.repo.slice(pr.repo.indexOf('/') + 1);
    const target = resolveDispatchTarget(input.rootDir, input.config, repoName, {
      exists: input.exists,
    });
    if (target.reason !== 'repo_checkout' || target.repoPath === null) {
      return {
        ok: false,
        message:
          `${pr.repo}#${pr.number}: no local checkout of ${repoName}` +
          `${target.repoPath ? ` at ${target.repoPath}` : ''}. Clone it there, ` +
          `or map it in .motir.json, then run \`motir fix ${input.key}\` again.`,
      };
    }
    const repoPath = target.repoPath;
    const branch = pr.headRef;
    const path = join(
      dirname(repoPath),
      `${basename(repoPath)}-fix-${input.key.toLowerCase()}-${pr.number}`,
    );
    const git = (args: string[], cwd = repoPath) => input.run('git', args, cwd);
    const fail = (what: string, detail: string): Prepared => ({
      ok: false,
      message: `${pr.repo}#${pr.number}: ${what}${detail ? ` — ${detail}` : ''}.`,
    });

    const fetched = git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    if (fetched.exitCode !== 0) {
      return fail(`could not fetch its branch \`${branch}\``, fetched.stderr);
    }

    if (input.exists(path)) {
      const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
      if (head.exitCode !== 0 || head.stdout !== branch) {
        return fail(
          `${path} already exists and is not a checkout of \`${branch}\``,
          'move it aside and run this again',
        );
      }
    } else {
      const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      const added =
        local.exitCode === 0
          ? git(['worktree', 'add', path, branch])
          : git(['worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
      if (added.exitCode !== 0) {
        return fail(`could not check out \`${branch}\` at ${path}`, added.stderr);
      }
    }

    // Bring a local branch up to the pull request's head. Fast-forward ONLY: a
    // local branch that has diverged from the pull request holds work nobody
    // pushed, and merging it in would ship it under a repair.
    const ff = git(['merge', '--ff-only', `origin/${branch}`], path);
    if (ff.exitCode !== 0) {
      return fail(`the local \`${branch}\` has diverged from the pull request`, ff.stderr);
    }
    const on = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
    if (on.stdout !== branch) {
      return fail(`the checkout at ${path} is not on \`${branch}\``, on.stdout);
    }
    checkouts.push({ repo: pr.repo, branch, path });
  }
  return { ok: true, checkouts };
}

/** How a repair that did not go green is reported — the check, the repository,
 *  and how many attempts were spent. */
export function renderRepairGaveUp(input: {
  key: string;
  watch: Extract<CiWatchOutcome, { kind: 'gave_up' | 'fix_failed' }>;
  pullRequests: readonly RepairPullRequest[];
}): string {
  const { key, watch } = input;
  const head =
    watch.kind === 'gave_up'
      ? `${key}: the repair gave up after ${pluralize(watch.attempts, 'attempt')}.`
      : `${key}: the repair stopped after ${pluralize(watch.attempts, 'attempt')} — ${watch.detail}.`;
  const lines = [head];
  for (const pr of input.pullRequests) {
    // A queue-failing pull request names the QUEUE's check (MOTIR-5720) — its own
    // `failingChecks` are usually empty, because its own checks are green.
    const checks = pr.queueExit
      ? `in the merge queue — ${pr.queueExit.failingCheckName ?? queueReasonInWords(pr.queueExit.rawReason)}`
      : pr.failingChecks.length > 0
        ? pr.failingChecks.join(', ')
        : 'unknown checks';
    lines.push(`  ${pr.repo}#${pr.number} — failing: ${checks} (${pr.url})`);
  }
  lines.push(
    `The card stays where it is. Look at the failure, then run \`motir fix ${key}\` again.`,
  );
  return lines.join('\n');
}

export async function fixCommand(key: string, opts: FixOptions, deps: FixDeps = {}): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir fix ACME-7`.');

  // ── HOSTED OR LOCAL? (MOTIR-6929) ─────────────────────────────────────────
  // A run id means the SERVER already took the repair claim (Fix on the hosted
  // agent) and opened this run; this container ADOPTS it rather than claiming.
  const env = deps.env ?? process.env;
  const adoptId = hostedRunId({}, env);
  if (adoptId) {
    await withHostedProjectSession(
      adoptId,
      (session, adopted) =>
        fixHosted({
          key: trimmed,
          client: session.client,
          rootDir: session.link.dir,
          config: session.link.config,
          adopted,
          env,
          opts,
          deps,
        }),
      trimmed,
    );
    return;
  }

  await withProjectSession(async (session) => {
    const { client, link } = session;
    // The agent is resolved BEFORE the claim: a repair nobody can run must not
    // open a run that then has to be closed as a failure.
    const agent = requireAgent({ ...opts, print: false }, 'motir fix');

    const claim = await client.claimWorkItemRepair(trimmed);
    if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
      info(renderRepairRefusal(claim));
      process.exitCode = 1;
      return;
    }
    await repair({
      client,
      claim,
      prepare: () =>
        prepareCheckouts({
          key: claim.key,
          pullRequests: claim.pullRequests,
          rootDir: link.dir,
          config: link.config,
          run: deps.run ?? execCommand,
          exists: deps.exists ?? existsSync,
        }),
      agent,
      opts,
      deps,
    });
  });
}

/** `owner/name` → `name`, the checkout's directory under the workspace. */
function repoNameOf(repository: string): string {
  return repository.slice(repository.lastIndexOf('/') + 1);
}

/**
 * The HOSTED checkout (MOTIR-6929): CLONE every repository of the repair's pull
 * requests into the workspace as `<root>/<name>` through `motir run`'s own
 * materializer, then {@link prepareCheckouts} exactly as a terminal repair does —
 * each pull request ON its own branch, never a new one and never detached.
 */
export function prepareHostedRepairCheckouts(input: {
  key: string;
  pullRequests: readonly RepairPullRequest[];
  rootDir: string;
  config: LinkConfig;
  run: CommandRunner;
  exists: (path: string) => boolean;
}): Prepared {
  const repositories = [...new Set(input.pullRequests.map((pr) => pr.repo))];
  const targets = resolveDispatchTargets(
    input.rootDir,
    input.config,
    repositories.map((repository) => ({
      name: repoNameOf(repository),
      cloneUrl: `https://github.com/${repository}.git`,
    })),
    { exists: input.exists },
  );
  const materialized = materializeDispatchCheckouts(input.rootDir, targets, { run: input.run });
  const lines = renderMaterialization(materialized);
  for (const line of lines) info(line);
  if (materialized.failures.length > 0) {
    return {
      ok: false,
      message: `${input.key}: a repository under repair could not be cloned. No agent was started.`,
    };
  }
  return prepareCheckouts(input);
}

/**
 * What the hosted repair's agent is told on top of the fix prompt — in place of the
 * BUILD addendum, which would tell it how to end a pull request's body it must not open.
 */
export function hostedRepairAddendum(): string {
  return [
    '',
    '## HOSTED REPAIR RUN — git',
    '',
    "- git is already authenticated for this run's repositories and commits as Motir's GitHub App.",
    '  Do not change `user.name`, `user.email`, remote URLs or credential settings.',
    '- Push ONLY to the branch each checkout above is on — its pull request’s own branch. A push',
    '  to any other ref, a branch delete and a force push are refused.',
    '- `gh` is disabled: open no pull request, and comment on or review nothing.',
    '',
  ].join('\n');
}

/** The hosted run's push lock, on the active run's state (`prepareHostedRun`). */
function lockActiveRunToBranches(
  allowed: ReadonlyArray<{ repository: string; branch: string }>,
  env: NodeJS.ProcessEnv,
): void {
  const active = activeHostedRun();
  if (!active) {
    throw new CliError('This hosted run has no git setup to lock; refusing to repair.', {
      exitCode: HOSTED_SETUP_FAILED,
    });
  }
  lockHostedRunToBranches(active.stateDir, allowed, env);
}

/**
 * The claim a terminal `motir fix` would have been handed, rebuilt from what the
 * server's claim RECORDED on the run — so `repair()` runs unchanged.
 */
export function claimFromRun(input: {
  key: string;
  runId: string;
  repair: DispatchRunRepair;
}): WorkItemRepairClaim {
  const { repair: decided } = input;
  return {
    key: input.key,
    title: decided.title ?? input.key,
    outcome: 'claimed',
    reason: null,
    runTargetKey: null,
    runId: input.runId,
    holder: null,
    startedAt: null,
    repairClass: decided.repairClass,
    acceptanceRefusal: null,
    reviewRefusal: decided.findings
      ? {
          gate: decided.findings.gate,
          findingsMd: decided.findings.findingsMd,
          reviewerName: decided.findings.reviewerName,
          decidedAt: decided.findings.decidedAt,
        }
      : null,
    pullRequests: decided.pullRequests.map((pr) => ({
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      headRef: pr.branch,
      baseRef: pr.baseRef,
      ci: null,
      failingChecks: [],
      queueExit: null,
    })),
  };
}

/**
 * `motir fix` IN A HOSTED CONTAINER (Story MOTIR-1626 · MOTIR-6929) — on the `fix`
 * run the server's repair claim opened. Nothing is claimed.
 */
async function fixHosted(input: {
  key: string;
  client: MotirClient;
  rootDir: string;
  config: LinkConfig;
  adopted: AdoptedRun;
  env: NodeJS.ProcessEnv;
  opts: FixOptions;
  deps: FixDeps;
}): Promise<void> {
  const { key, client, adopted, env, opts, deps } = input;
  // ⚠️ REFUSED BEFORE ANYTHING IS ADOPTED: a run that is not a repair is somebody
  // else's work, and closing it from here would end it.
  const view = await client.getDispatchRun(adopted.runId);
  if (view.command !== 'fix') {
    throw new CliError(
      `Run ${adopted.runId} is a \`${view.command}\` run, not a repair — nothing to fix.`,
      {
        exitCode: HOSTED_SETUP_FAILED,
        hint: 'A hosted repair is booted by Fix on the hosted agent, on the `fix` run its claim opened.',
      },
    );
  }
  assertAdoptsLeaf(adopted, key);
  const decided = view.repair ?? null;
  // A run in the person's OWN agent (MOTIR-9052) answers every class; the hosted lane
  // answers a review only (§12.4b).
  const ownAgent = isAgentRun(env);
  // What the claim decided, or a refusal — never a guess: without it there is no
  // branch this run may push to. The run IS ours, so it is closed on the way out.
  const missing =
    decided === null
      ? 'the run records no repair decision'
      : decided.repairClass !== 'review' && !ownAgent
        ? `the run records a \`${decided.repairClass}\` repair, and a hosted repair answers a review`
        : decided.repairClass === 'review' && decided.findings === null
          ? 'the run records no review findings'
          : decided.pullRequests.length === 0
            ? 'the run records no pull request'
            : null;
  if (missing !== null || decided === null) {
    const reporter = createDispatchRunReporter({ client, reportLogBodies: true });
    reporter.adopt(adopted.runId);
    reporter.event({
      kind: 'card_settled',
      workItemKey: key,
      disposition: 'failed',
      data: { reason: missing },
    });
    await reporter.close('halted');
    throw new CliError(`${key}: cannot repair on run ${adopted.runId} — ${missing}.`, {
      exitCode: HOSTED_SETUP_FAILED,
    });
  }

  // ── The push lock, before any agent: those branches, and nothing else. ──
  (deps.lockPushes ?? lockActiveRunToBranches)(
    decided.pullRequests.map((pr) => ({ repository: pr.repo, branch: pr.branch })),
    env,
  );
  // Read AFTER the lock, so the agent's allow-listed environment carries it. An explicit
  // `--agent` is honoured, as `resolveAgent` honours it for every hosted command.
  let agent: { parsed: ParsedAgentCommand };
  let agentDeps = deps;
  if (opts.agent) {
    agent = requireAgent({ ...opts, print: false }, 'motir fix');
  } else if (ownAgent) {
    // The person's own agent resumes the card's last session when it can (MOTIR-9052).
    const choice = chooseRepairAgent(key, decided.resume, env);
    info(choice.line);
    agent = choice;
    agentDeps = {
      ...deps,
      runAgentFn: withFreshFallback(deps.runAgentFn ?? defaultRunAgent, choice, info),
    };
  } else {
    agent = { parsed: hostedOpenCodeAgent(env, { addendum: hostedRepairAddendum }) };
  }

  const claim = claimFromRun({ key, runId: adopted.runId, repair: decided });
  info(
    `Adopted run ${adopted.runId}: repairing ${key}, ${
      decided.repairClass === 'review' ? 'sent back by a review' : 'red on CI or acceptance'
    }.`,
  );
  const run = deps.run ?? execCommand;
  await repair({
    client,
    claim,
    prepare: () => {
      const prepared = prepareHostedRepairCheckouts({
        key,
        pullRequests: claim.pullRequests,
        rootDir: input.rootDir,
        config: input.config,
        run,
        exists: deps.exists ?? existsSync,
      });
      if (prepared.ok) {
        (deps.prepareHostedCheckouts ?? hostedCheckoutPreparer)([
          ...new Set(prepared.checkouts.map((c) => c.path)),
        ]);
      }
      return prepared;
    },
    agent,
    opts,
    deps: agentDeps,
    hosted: { run },
  });
}

/**
 * Where each pull request's branch is on its remote NOW — fetched, then read. A hosted
 * repair compares it before and after the agent to know whether anything was pushed.
 */
function remoteHeads(checkouts: readonly FixCheckout[], run: CommandRunner): string[] {
  return checkouts.map((c) => {
    run(
      'git',
      ['fetch', '--quiet', 'origin', `+refs/heads/${c.branch}:refs/remotes/origin/${c.branch}`],
      c.path,
    );
    const head = run('git', ['rev-parse', `refs/remotes/origin/${c.branch}`], c.path);
    return head.exitCode === 0 ? head.stdout.trim() : '';
  });
}

async function repair(input: {
  client: MotirClient;
  claim: WorkItemRepairClaim;
  /** Check each pull request out on its own branch — a terminal's worktrees, or a hosted clone. */
  prepare: () => Prepared;
  /** `fresh` is set when `parsed` is a RESUMED command (MOTIR-9052): the watch then launches it as
   *  `resumeAgent`, and `fresh` is the plain command it stands behind. */
  agent: { parsed: ParsedAgentCommand; fresh?: ParsedAgentCommand | null };
  opts: FixOptions;
  deps: FixDeps;
  /**
   * A HOSTED repair (MOTIR-6929): the server's claim wrote the run's `run_opened`, a
   * give-up names the pull requests it started with (a re-claim is not the container's
   * to make), and a review turn that pushed nothing ends the repair.
   */
  hosted?: { run: CommandRunner };
}): Promise<void> {
  const { client, claim, agent, opts, deps, hosted } = input;
  const key = claim.key;
  const reporter = createDispatchRunReporter({ client, reportLogBodies: opts.reportLog === true });
  // `claimed` / `mine` always carry the run — the server opened it.
  reporter.adopt(claim.runId as string);

  let closed = false;
  const close = async (stopReason: DispatchStopReason): Promise<void> => {
    if (closed) return;
    closed = true;
    await reporter.close(stopReason);
  };
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const detach = (deps.onInterrupt ?? bindInterruptSignals)((signal = 'SIGINT') => {
    info('');
    info(`Interrupted — closing the repair of ${key}.`);
    void close('interrupted').finally(() => exit(INTERRUPT_EXIT_CODE[signal]));
  });

  try {
    // A hosted run's ONE `run_opened` is the server claim's record of what it decided.
    if (!hosted) {
      reporter.event({
        kind: 'run_opened',
        data: { command: 'fix', key, outcome: claim.outcome },
      });
    }

    const prepared = input.prepare();
    if (!prepared.ok) {
      info(prepared.message);
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
      process.exitCode = 1;
      await close('halted');
      return;
    }

    info(
      `${key}: ${claim.outcome === 'mine' ? 'resuming' : 'starting'} the repair of ` +
        `${claim.pullRequests.map((pr) => `${pr.repo}#${pr.number}`).join(', ')}.`,
    );
    for (const c of prepared.checkouts) info(`  ${c.repo} — ${c.branch} at ${c.path}`);
    reporter.event({
      kind: 'checkout_ready',
      workItemKey: key,
      disposition: 'running',
      // `branch` (MOTIR-6530): every `checkout_ready` names where the work is. A
      // repair works on its pull requests' own branches; the first is the leg's.
      data: { checkouts: prepared.checkouts, branch: prepared.checkouts[0]?.branch ?? null },
    });

    const runAgentFn = deps.runAgentFn ?? defaultRunAgent;
    const rerun: AcceptanceRerunInput | null =
      claim.repairClass === 'acceptance_rerun' && claim.acceptanceRefusal !== null
        ? {
            key,
            title: claim.title,
            refusal: claim.acceptanceRefusal,
            pullRequests: claim.pullRequests,
            checkouts: prepared.checkouts,
          }
        : null;

    const review: ReviewFixInput | null =
      claim.repairClass === 'review' && claim.reviewRefusal !== null
        ? {
            key,
            title: claim.title,
            refusal: claim.reviewRefusal,
            pullRequests: claim.pullRequests,
            checkouts: prepared.checkouts,
          }
        : null;

    // THE REVIEW TURN — the findings, once, before the CI loop (MOTIR-6822). A failed
    // agent is a stop, as on the re-run: nothing was pushed, so CI has nothing to judge.
    if (review) {
      info(
        `${key}: answering the review sent back by ${review.refusal.reviewerName ?? 'the reviewer'}.`,
      );
      const before = hosted ? remoteHeads(prepared.checkouts, hosted.run) : null;
      const ran = await runAgentStep(runAgentFn, {
        reporter,
        key,
        step: 'review_fix',
        command: agent.parsed,
        prompt: renderReviewFixPrompt(review),
        cwd: prepared.checkouts[0]!.path,
      });
      // A FIX THAT WENT PAST THE CARD'S TEXT IS RECORDED (MOTIR-11094) — the review-fix
      // prompt tells an agent with no Motir tools to write it into `$MOTIR_AGENT_REPORT`,
      // and the run's credential posts it, as a dispatched leg's does. Whatever the exit
      // code: an agent that built past the card and then failed still built it.
      await recordReviewFixDiscrepancy(reporter, key, ran.result);
      if (!ran.ok) {
        info(
          `${key}: the review-fix agent failed — ${ran.detail}. Nothing was pushed by this step.`,
        );
        reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
        process.exitCode = 1;
        await close('halted');
        return;
      }
      // ⚠️ A HOSTED repair that pushed nothing ends HERE (§8.6): the review still stands
      // over the same version, so the card stays To fix, and there is no new head for CI
      // to judge — watching the old one would only fix what nobody asked about.
      if (hosted && before) {
        const after = remoteHeads(prepared.checkouts, hosted.run);
        if (after.every((head, i) => head === before[i])) {
          info(
            `${key}: the agent pushed nothing — the review still stands, and the card stays To fix.`,
          );
          reporter.event({
            kind: 'card_settled',
            workItemKey: key,
            disposition: 'failed',
            data: { reason: 'nothing_pushed' },
          });
          await close('completed');
          return;
        }
      }
    }

    // THE RE-RUN TURN — the reviewer's reason, once, before the CI loop. A failed agent
    // is a stop: nothing was pushed, so there is nothing for CI to judge.
    if (rerun) {
      info(`${key}: answering the acceptance review sent back with Re-run.`);
      const ran = await runAgentStep(runAgentFn, {
        reporter,
        key,
        step: 'acceptance_rerun',
        command: agent.parsed,
        prompt: renderAcceptanceRerunPrompt(rerun),
        cwd: prepared.checkouts[0]!.path,
      });
      if (!ran.ok) {
        info(`${key}: the re-run agent failed — ${ran.detail}. Nothing was pushed by this step.`);
        reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
        process.exitCode = 1;
        await close('halted');
        return;
      }
    }

    const ciLogTee = createLegLogTee(reporter, key);
    const watch = await runCiWatchPhase({
      client,
      key,
      title: claim.title,
      agent: agent.fresh ?? agent.parsed,
      // The session its repair resolved, or none (MOTIR-9059): the watch says "continuing the
      // run's own session" only when it really launches one.
      ...(agent.fresh ? { resumeAgent: agent.parsed } : {}),
      cwd: prepared.checkouts[0]!.path,
      checkouts: prepared.checkouts,
      report: (line) => info(line),
      onEvent: (event) => reporter.event({ ...event, workItemKey: key }),
      ...(ciLogTee ? { onOutput: ciLogTee.write } : {}),
      ...(deps.wait ? { wait: deps.wait } : {}),
      // Each FIXING attempt is reported as a started / exited pair, like every other
      // agent turn here (MOTIR-7506): a `ci` repair runs no agent outside this loop,
      // so without it the leg would never learn which model answered.
      runAgentFn: async (agentInput) => {
        reporter.event({ kind: 'agent_started', workItemKey: key, data: { step: 'ci_fix' } });
        const result = await runAgentFn(agentInput);
        reportAgentExited(reporter, key, 'ci_fix', result);
        return result;
      },
      ...(deps.maxCiPolls === undefined ? {} : { maxPolls: deps.maxCiPolls }),
    });
    ciLogTee?.flush();
    reporter.event({ kind: CI_WATCH_EVENT[watch.kind], workItemKey: key, data: watch });

    if (watch.kind === 'gave_up' || watch.kind === 'fix_failed') {
      // Re-claim to NAME the failing checks now: the repair is still ours, so
      // this is `mine` and writes nothing, and it is the one read that carries
      // check names. A failure here falls back to the pull requests we started
      // with, which still name the repository and the attempt count.
      // A HOSTED container never claims (MOTIR-6929): it names what it started with.
      const now = hosted ? null : await client.claimWorkItemRepair(key).catch(() => null);
      const pullRequests =
        now && now.outcome === 'mine' && now.pullRequests.length > 0
          ? now.pullRequests
          : claim.pullRequests;
      info('');
      info(renderRepairGaveUp({ key, watch, pullRequests }));
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
      process.exitCode = 1;
    } else if (rerun) {
      // THE CLOSING TURN — CI is green on the fixed work, so the recording is re-made
      // and published now, and the fresh receipt asks the reviewer again.
      info(`${key}: re-recording the acceptance video.`);
      const recorded = await runAgentStep(runAgentFn, {
        reporter,
        key,
        step: 'acceptance_record',
        command: agent.parsed,
        prompt: renderAcceptanceRecordPrompt(rerun),
        cwd: prepared.checkouts[0]!.path,
      });
      if (!recorded.ok) {
        info(
          `${key}: CI is green, but re-recording the acceptance video failed — ` +
            `${recorded.detail}. Record and publish it, or run \`motir fix ${key}\` again.`,
        );
        reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'failed' });
        process.exitCode = 1;
        await close('halted');
        return;
      }
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'implemented' });
    } else {
      reporter.event({ kind: 'card_settled', workItemKey: key, disposition: 'implemented' });
    }
    await close(CI_WATCH_STOP_REASON[watch.kind]);
  } catch (err) {
    await close('halted');
    throw err;
  } finally {
    detach();
  }
}

/** One agent turn outside the CI loop (the re-run and its closing record, the review
 *  fix), reported into the run as a started / exited pair. */
async function runAgentStep(
  runAgentFn: NonNullable<FixDeps['runAgentFn']>,
  input: {
    reporter: ReturnType<typeof createDispatchRunReporter>;
    key: string;
    step: 'acceptance_rerun' | 'acceptance_record' | 'review_fix';
    command: ParsedAgentCommand;
    prompt: string;
    cwd: string;
  },
): Promise<
  { ok: true; result: AgentRunResult } | { ok: false; detail: string; result: AgentRunResult }
> {
  input.reporter.event({
    kind: 'agent_started',
    workItemKey: input.key,
    data: { step: input.step },
  });
  const result = await runAgentFn({ command: input.command, prompt: input.prompt, cwd: input.cwd });
  reportAgentExited(input.reporter, input.key, input.step, result);
  if (result.exitCode === 0) return { ok: true, result };
  return {
    ok: false,
    detail: result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`,
    result,
  };
}

/** Post the build-through points and decisions the review-fix agent wrote into its
 *  self-report, when it wrote any (MOTIR-11094). An agent with Motir tools records them
 *  itself and writes none, so nothing is posted twice. */
async function recordReviewFixDiscrepancy(
  reporter: ReturnType<typeof createDispatchRunReporter>,
  key: string,
  result: AgentRunResult,
): Promise<void> {
  const points = result.discrepancy ?? [];
  const decisions = result.decisions ?? [];
  if (points.length === 0 && decisions.length === 0) return;
  await reporter.reportDiscrepancy?.(key, points, decisions);
}

/** The `agent_exited` every repair turn reports — the review, re-run and record
 *  steps, and each fixing attempt of the CI loop. */
function reportAgentExited(
  reporter: ReturnType<typeof createDispatchRunReporter>,
  key: string,
  step: 'acceptance_rerun' | 'acceptance_record' | 'review_fix' | 'ci_fix',
  result: AgentRunResult,
): void {
  reporter.event({
    kind: 'agent_exited',
    workItemKey: key,
    // Top-level `exitCode` and `model` are what the server writes onto the leg
    // (MOTIR-7504) — a repair leg records both, like every other path. The model
    // is the agent's self-report or null, never a guess (MOTIR-2419).
    exitCode: result.exitCode,
    model: result.model ?? null,
    data: {
      step,
      exitCode: result.exitCode,
      model: result.model ?? null,
      signal: result.signal ?? null,
    },
  });
}
