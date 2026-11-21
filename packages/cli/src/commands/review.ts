import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent as defaultRunAgent } from '../agentRun.js';
import { agentProfileById, type ParsedAgentCommand } from '../agentProfiles.js';
import type {
  AgentReviewVerdict,
  DispatchRunReview,
  DispatchStopReason,
  MotirClient,
  ReviewVerdictSubmission,
} from '../client.js';
import { createDispatchRunReporter } from '../dispatchRunReporter.js';
import { ApiRefusalError, CliError, ReviewStaleError } from '../errors.js';
import { execCommand, type CommandRunner } from '../git.js';
import { hostedOpenCodeAgent } from '../hostedAgent.js';
import { activeHostedRun } from '../hostedAttribution.js';
import { lockHostedRunReadOnly } from '../hostedGit.js';
import {
  assertAdoptsLeaf,
  hostedRunId,
  isAgentRun,
  RUN_ID_ENV_VAR,
  SANDBOX_AGENT_ENV_VAR,
  type AdoptedRun,
} from '../hostedMode.js';
import {
  checkoutStandards,
  prepareReviewCheckouts,
  readReviewVerdict,
  REVIEW_FINDINGS_MAX_LENGTH,
  REVIEW_GATE_ENV,
  REVIEW_VERDICT_FILE_ENV,
  REVIEW_VERSION_ENV,
  reviewRunSection,
} from '../hostedReview.js';
import { bindInterruptSignals, INTERRUPT_EXIT_CODE, type InterruptSignal } from '../interrupt.js';
import { info } from '../output.js';
import { withHostedProjectSession } from '../session.js';
import { agentModeAgent, hostedCheckoutPreparer } from './dispatch.js';

// `motir review <KEY>` (Story MOTIR-1626 · MOTIR-6824; `docs/decisions/hosted-agent-run.md`
// §8) — the REVIEW AGENT, inside a hosted container: read the card's pull requests at
// the version under review, and send back ONE verdict.
//
// ── It copies the hosted `continue` (MOTIR-6795) ─────────────────────────────
// The server opened the `command: review` run when the card's `agent_review` gate was
// raised (MOTIR-6820); this container ADOPTS it. Nothing is claimed — a review changes
// nobody's claim on the card, and the gate it answers is the one-review-at-a-time lock
// (§8.1).
//
// ── The pipeline ─────────────────────────────────────────────────────────────
//   1. adopt the run, refusing one that is not a review or does not hold this card;
//   2. LOCK the run read-only: every push fails, `gh` refuses (§8.3, `hostedGit.ts`);
//   3. read the served review prompt (§8.2) — a version the server did not boot this
//      run for means the code moved: exit clean, the newer version has its own review;
//   4. check out every pull request, detached at its reviewed head, in every repository;
//   5. run OpenCode on the served prompt plus the verdict-file contract (`hostedReview.ts`);
//   6. read the verdict file and POST it ONCE to `agent-review` (§8.4) — with the bugs it
//      carries, which the server files (MOTIR-10513, §8.7) — and name each one; exit.
//
// ── Only the verdict leaves the container ────────────────────────────────────
// The bugs the review logs leave INSIDE it: the agent cannot reach Motir, so a defect its
// verdict cannot carry is a `bugs` entry of the same file, filed by the server. No step here pushes, opens or comments on a pull request, or calls `gh`. A missing or
// malformed verdict is NOT posted: the run closes failed, the process exits non-zero,
// and the server records the review as one that could not run. A LATE verdict
// (`REVIEW_STALE`) was recorded by the server and decided nothing — the code moved,
// which is expected — so it exits zero.
//
// ── In the person's OWN agent (Story MOTIR-11941 · MOTIR-11953) ──────────────
// *Review in my agent* opens the same `command: review` run in one of the person's agents
// (`origin: 'instance'`), and the agent's terminal launches this command on it. The
// pipeline is the one above with four differences, all decided by `isAgentRun`:
//   - the agent is the agent's own profile (`agentModeAgent`), without the hosted prompt
//     addendum, with the verdict file's name added to its environment;
//   - no hosted checkout preparer — the agent's image wires its own code graph;
//   - what the run reviews is read from the run itself (`view.review`), not from the
//     launcher's environment, which a terminal launch does not set;
//   - the verdict goes through the review-verdict door (`submitReviewVerdict`), the one a
//     person's review answers through: `pass` is `approved`, the harness is the agent's
//     profile and the model its self-report. That door files no bugs, so a bug the agent
//     logs is written into the findings and named in the output rather than dropped.
// A late or second verdict there is recorded and decides nothing, as `REVIEW_STALE` is.

/** The launcher's exit code for a run that could not be set up (`sandbox/hosted/entrypoint.ts`). */
const HOSTED_SETUP_FAILED = 20;

/** Injectable seams; never overridden in production. */
export interface ReviewDeps {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  exists?: (path: string) => boolean;
  runAgentFn?: typeof defaultRunAgent;
  /** Lock the prepared run read-only. Defaults to the active hosted run's state. */
  lockReadOnly?: (env: NodeJS.ProcessEnv) => void;
  /** Per-checkout preparation (the code graph). */
  prepareCheckouts?: (cwds: string[]) => void;
  /** Where the verdict file's private directory is made. */
  tempDir?: () => string;
  onInterrupt?: (handler: (signal?: InterruptSignal) => void) => () => void;
  exit?: (code: number) => void;
}

function lockActiveRun(env: NodeJS.ProcessEnv): void {
  const active = activeHostedRun();
  if (!active) {
    throw new CliError('This hosted run has no git setup to lock read-only; refusing to review.', {
      exitCode: HOSTED_SETUP_FAILED,
    });
  }
  lockHostedRunReadOnly(active.stateDir, env);
}

export async function reviewCommand(key: string, deps: ReviewDeps = {}): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new CliError('A work item key is required, e.g. `motir review ACME-7`.');
  const env = deps.env ?? process.env;
  const runId = hostedRunId({}, env);
  if (!runId) {
    throw new CliError(
      `\`motir review\` runs only inside a hosted review run — ${RUN_ID_ENV_VAR} is not set here.`,
      {
        hint:
          'Motir starts a review itself when a card’s pull requests go green with the review ' +
          'agent on (Settings → Approvals), or in your own agent from the card’s ' +
          '*Review in my agent*. To look at a card’s code, check it out yourself.',
      },
    );
  }
  await withHostedProjectSession(
    runId,
    (session, adopted) =>
      reviewHosted({
        key: trimmed,
        client: session.client,
        rootDir: session.link.dir,
        config: session.link.config,
        adopted,
        env,
        deps,
      }),
    trimmed,
  );
}

async function reviewHosted(input: {
  key: string;
  client: MotirClient;
  rootDir: string;
  config: Parameters<typeof prepareReviewCheckouts>[0]['config'];
  adopted: AdoptedRun;
  env: NodeJS.ProcessEnv;
  deps: ReviewDeps;
}): Promise<void> {
  const { key, client, adopted, env, deps } = input;
  // ⚠️ REFUSED BEFORE ANYTHING IS ADOPTED: a run that is not a review is somebody
  // else's work, and closing it from here would end it.
  const view = await client.getDispatchRun(adopted.runId);
  if (view.command !== 'review') {
    throw new CliError(
      `Run ${adopted.runId} is a \`${view.command}\` run, not a review — nothing to review.`,
      {
        exitCode: HOSTED_SETUP_FAILED,
        hint: 'A hosted review is booted by Motir, on the `review` run it opened for the card.',
      },
    );
  }
  assertAdoptsLeaf(adopted, key);
  const ownAgent = isAgentRun(env);
  if (ownAgent && view.origin !== 'instance') {
    throw new CliError(
      `Run ${adopted.runId} is a ${view.origin} review, not one opened in an agent — this ` +
        'agent does not answer it.',
      { exitCode: HOSTED_SETUP_FAILED },
    );
  }

  const reporter = createDispatchRunReporter({ client, reportLogBodies: true });
  reporter.adopt(adopted.runId);
  let closed = false;
  const close = async (stopReason: DispatchStopReason): Promise<void> => {
    if (closed) return;
    closed = true;
    await reporter.close(stopReason);
  };
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const detach = (deps.onInterrupt ?? bindInterruptSignals)((signal = 'SIGINT') => {
    info('');
    info(`Interrupted — closing the review of ${key}.`);
    void close('interrupted').finally(() => exit(INTERRUPT_EXIT_CODE[signal]));
  });
  const settle = (disposition: 'implemented' | 'failed', data?: unknown) =>
    reporter.event({
      kind: 'card_settled',
      workItemKey: key,
      disposition,
      ...(data === undefined ? {} : { data }),
    });
  /** End WITHOUT a verdict: nothing posted, the run failed, the process non-zero. */
  const noVerdict = async (reason: string): Promise<void> => {
    info(`${key}: no verdict was submitted — ${reason}.`);
    settle('failed', { reason });
    process.exitCode = 1;
    await close('halted');
  };

  // An own-agent run answers what the run was opened for; it is ours, so a run that
  // records none is closed on the way out rather than left to time out.
  const target: DispatchRunReview | null = ownAgent ? (view.review ?? null) : null;
  if (ownAgent && target === null) {
    const reason = 'the run records no review target';
    settle('failed', { reason });
    await close('halted');
    detach();
    throw new CliError(`${key}: cannot review on run ${adopted.runId} — ${reason}.`, {
      exitCode: HOSTED_SETUP_FAILED,
    });
  }

  let verdictDir: string | null = null;
  try {
    // ── 2. READ-ONLY, before any checkout and before the agent. ──
    (deps.lockReadOnly ?? lockActiveRun)(env);

    // ── 3. The served prompt, and whether it is still the version we were booted for. ──
    const served = await client.reviewPrompt(key);
    const bootedVersion = target ? target.subjectVersion : env[REVIEW_VERSION_ENV]?.trim();
    const moved = target
      ? target.subjectVersion !== served.subjectVersion || target.gateId !== served.gateId
      : (!!bootedVersion && bootedVersion !== served.subjectVersion) ||
        (!!env[REVIEW_GATE_ENV]?.trim() && env[REVIEW_GATE_ENV]?.trim() !== served.gateId);
    if (moved) {
      info(
        `${key}: the code moved since this review was started — it is now under review as ` +
          `${served.subjectVersion}, which has its own review. Nothing to do here.`,
      );
      reporter.event({
        kind: 'log',
        workItemKey: key,
        data: { reviewMoved: { from: bootedVersion ?? null, to: served.subjectVersion } },
      });
      await close('completed');
      return;
    }
    info(`Adopted run ${adopted.runId}: reviewing ${key} at ${served.subjectVersion}.`);

    // ── 4. Every pull request at its reviewed head. ──
    const exists = deps.exists ?? existsSync;
    const prepared = prepareReviewCheckouts({
      key,
      pullRequests: served.pullRequests,
      rootDir: input.rootDir,
      config: input.config,
      run: deps.run ?? execCommand,
      exists,
    });
    if (!prepared.ok) {
      await noVerdict(prepared.message);
      return;
    }
    for (const line of prepared.materialized) info(line);
    for (const c of prepared.checkouts) {
      info(`  ${c.repository} #${c.number} at ${c.headSha} — ${c.path}`);
    }
    // An own agent's image wires its own code graph; the hosted preparer would register
    // OpenCode's server in the person's home (MOTIR-7024).
    if (!ownAgent) {
      (deps.prepareCheckouts ?? hostedCheckoutPreparer)([
        ...new Set(prepared.checkouts.map((c) => c.path)),
      ]);
    }
    reporter.event({
      kind: 'checkout_ready',
      workItemKey: key,
      disposition: 'running',
      // A review has no branch: every checkout is detached at its reviewed head.
      data: { checkouts: prepared.checkouts, branch: null },
    });

    // ── 5. The agent, on the served prompt plus the verdict-file contract. ──
    verdictDir = (deps.tempDir ?? (() => mkdtempSync(join(tmpdir(), 'motir-review-'))))();
    const verdictFile = join(verdictDir, 'verdict.json');
    // The agent's allow-listed environment (a fresh object per launch), plus the one
    // name it writes its verdict to.
    const command = ownAgent
      ? ownReviewAgent(env, verdictFile)
      : hostedOpenCodeAgent(env, { addendum: () => '' });
    if (!ownAgent && command.env) command.env[REVIEW_VERDICT_FILE_ENV] = verdictFile;
    const prompt =
      served.prompt +
      reviewRunSection({
        served,
        checkouts: prepared.checkouts,
        verdictFile,
        standards: checkoutStandards(prepared.checkouts, exists),
      });
    reporter.event({ kind: 'agent_started', workItemKey: key, data: { step: 'review' } });
    const result = await (deps.runAgentFn ?? defaultRunAgent)({
      command,
      prompt,
      cwd: prepared.checkouts[0]!.path,
    });
    reporter.event({
      kind: 'agent_exited',
      workItemKey: key,
      exitCode: result.exitCode,
      // The agent's self-report or null, never a guess (MOTIR-2419) — top-level
      // is what the server writes onto the leg (MOTIR-7504).
      model: result.model ?? null,
      data: {
        step: 'review',
        exitCode: result.exitCode,
        model: result.model ?? null,
        signal: result.signal ?? null,
      },
    });
    if (result.exitCode !== 0) {
      // ⚠️ FAIL CLOSED: an agent that failed may have left a verdict it never finished.
      await noVerdict(
        `the review agent failed (${result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`})`,
      );
      return;
    }

    // ── 6. ONE verdict, or none. ──
    const read = readReviewVerdict(verdictFile, served.subjectVersion);
    if (!read.ok) {
      await noVerdict(read.reason);
      return;
    }
    if (ownAgent) {
      await submitOwn({
        client,
        key,
        verdict: read.verdict,
        harness: ownHarness(env),
        model: result.model ?? view.model ?? 'unknown',
        settle,
      });
      await close('completed');
      return;
    }
    try {
      const decided = await client.submitAgentReview(key, read.verdict);
      info(
        `${key}: verdict submitted — ${decided.verdict === 'pass' ? 'pass' : 'changes requested'} ` +
          `at ${decided.subjectVersion}.`,
      );
      for (const bug of decided.bugs) {
        info(
          `  ${bug.outcome === 'filed' ? 'bug logged' : 'bug already filed'}: ${bug.key} — ${bug.title}`,
        );
      }
      settle('implemented', {
        verdict: decided.verdict,
        state: decided.state,
        ...(decided.bugs.length > 0 ? { bugs: decided.bugs.map((b) => b.key) } : {}),
      });
    } catch (err) {
      if (!(err instanceof ReviewStaleError)) throw err;
      // The server RECORDED it on the run and decided nothing: the code moved.
      info(`${key}: the code moved while it was reviewed — ${err.message}`);
      settle('implemented', { verdict: read.verdict.verdict, stale: true });
    }
    await close('completed');
  } catch (err) {
    await close('halted');
    throw err;
  } finally {
    if (verdictDir) rmSync(verdictDir, { recursive: true, force: true });
    detach();
  }
}

/** The refusals of the review-verdict door that record a verdict and decide nothing. */
const UNDECIDING_VERDICT_CODES = new Set(['REVIEW_VERDICT_LATE', 'REVIEW_VERDICT_SECOND']);

/**
 * The person's own agent, launched for a review: its profile's unattended command without
 * the hosted prompt addendum (a review edits nothing, so the delivery steps do not apply),
 * in its inherited environment plus the verdict file's name.
 */
function ownReviewAgent(env: NodeJS.ProcessEnv, verdictFile: string): ParsedAgentCommand {
  const { promptAddendum: _addendum, ...parsed } = agentModeAgent(env);
  return { ...parsed, env: { ...(parsed.env ?? env), [REVIEW_VERDICT_FILE_ENV]: verdictFile } };
}

/** The harness an own-agent verdict names: the agent profile's label (`Claude Code`). */
function ownHarness(env: NodeJS.ProcessEnv): string {
  const id = env[SANDBOX_AGENT_ENV_VAR]?.trim() ?? '';
  /* v8 ignore next -- `agentModeAgent` refused an unknown profile before the agent ran */
  return agentProfileById(id)?.label ?? id;
}

/**
 * The verdict file's findings, with the bugs it logged written in: the review-verdict door
 * files no bugs, so they travel in the findings instead of being dropped. Cut to the door's
 * limit, so a long bug list never costs the verdict.
 */
export function ownReviewFindings(verdict: AgentReviewVerdict): string | null {
  if (verdict.bugs.length === 0) return verdict.findingsMd;
  const bugs = verdict.bugs.map((b) => `### ${b.title}\n\n${b.descriptionMd}`).join('\n\n');
  const body = [verdict.findingsMd?.trim(), `## Bugs the review logged\n\n${bugs}`]
    .filter(Boolean)
    .join('\n\n');
  const cut = '\n\n…(cut to the verdict’s length limit)';
  return body.length <= REVIEW_FINDINGS_MAX_LENGTH
    ? body
    : body.slice(0, REVIEW_FINDINGS_MAX_LENGTH - cut.length) + cut;
}

/** An own-agent review's ONE verdict, through the review-verdict door. */
async function submitOwn(input: {
  client: MotirClient;
  key: string;
  verdict: AgentReviewVerdict;
  harness: string;
  model: string;
  settle: (disposition: 'implemented' | 'failed', data?: unknown) => void;
}): Promise<void> {
  const { client, key, verdict, settle } = input;
  const body: ReviewVerdictSubmission = {
    subjectVersion: verdict.subjectVersion,
    verdict: verdict.verdict === 'pass' ? 'approved' : 'changes_requested',
    summaryMd: verdict.summaryMd,
    findingsMd: ownReviewFindings(verdict),
    harness: input.harness,
    model: input.model,
  };
  try {
    const decided = await client.submitReviewVerdict(key, body);
    info(
      `${key}: verdict submitted — ${decided.verdict === 'approved' ? 'approved' : 'changes requested'} ` +
        `at ${decided.subjectVersion}.`,
    );
    for (const bug of verdict.bugs) info(`  bug noted in the findings (not filed): ${bug.title}`);
    settle('implemented', {
      verdict: decided.verdict,
      outcome: decided.outcome,
      ...(verdict.bugs.length > 0 ? { bugsInFindings: verdict.bugs.length } : {}),
    });
  } catch (err) {
    if (!(err instanceof ApiRefusalError) || !UNDECIDING_VERDICT_CODES.has(err.code ?? '')) {
      throw err;
    }
    // Recorded on the item and decided nothing: the code moved, or it was already reviewed.
    info(`${key}: the verdict was recorded and decided nothing — ${err.message}`);
    settle('implemented', { verdict: body.verdict, stale: true });
  }
}
