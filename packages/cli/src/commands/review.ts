import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent as defaultRunAgent } from '../agentRun.js';
import type { DispatchStopReason, MotirClient } from '../client.js';
import { createDispatchRunReporter } from '../dispatchRunReporter.js';
import { CliError, ReviewStaleError } from '../errors.js';
import { execCommand, type CommandRunner } from '../git.js';
import { hostedOpenCodeAgent } from '../hostedAgent.js';
import { activeHostedRun } from '../hostedAttribution.js';
import { lockHostedRunReadOnly } from '../hostedGit.js';
import { assertAdoptsLeaf, hostedRunId, RUN_ID_ENV_VAR, type AdoptedRun } from '../hostedMode.js';
import {
  checkoutStandards,
  prepareReviewCheckouts,
  readReviewVerdict,
  REVIEW_GATE_ENV,
  REVIEW_VERDICT_FILE_ENV,
  REVIEW_VERSION_ENV,
  reviewRunSection,
} from '../hostedReview.js';
import { bindInterruptSignals, INTERRUPT_EXIT_CODE, type InterruptSignal } from '../interrupt.js';
import { info } from '../output.js';
import { withHostedProjectSession } from '../session.js';
import { hostedCheckoutPreparer } from './dispatch.js';

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
          'agent on (Settings → Approvals). To look at a card’s code, check it out yourself.',
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

  let verdictDir: string | null = null;
  try {
    // ── 2. READ-ONLY, before any checkout and before the agent. ──
    (deps.lockReadOnly ?? lockActiveRun)(env);

    // ── 3. The served prompt, and whether it is still the version we were booted for. ──
    const served = await client.reviewPrompt(key);
    const bootedVersion = env[REVIEW_VERSION_ENV]?.trim();
    const bootedGate = env[REVIEW_GATE_ENV]?.trim();
    if (
      (bootedVersion && bootedVersion !== served.subjectVersion) ||
      (bootedGate && bootedGate !== served.gateId)
    ) {
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
    (deps.prepareCheckouts ?? hostedCheckoutPreparer)([
      ...new Set(prepared.checkouts.map((c) => c.path)),
    ]);
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
    const command = hostedOpenCodeAgent(env, { addendum: () => '' });
    if (command.env) command.env[REVIEW_VERDICT_FILE_ENV] = verdictFile;
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
