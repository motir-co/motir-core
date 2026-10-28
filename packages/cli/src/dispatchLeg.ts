import { runAgent as defaultRunAgent, type AgentRunResult } from './agentRun.js';
import {
  agentSubmittedReplan,
  checkBootstrapCheckout,
  materializeDispatchCheckouts,
  renderMaterialization,
  type DispatchTarget,
  type SuspectDispatch,
} from './dispatch.js';
import { execCommand, workReachedRemote, type CommandRunner } from './git.js';
import type { DispatchPrompt, MotirClient } from './client.js';
import type { ParsedAgentCommand } from './agentProfiles.js';
import { createLegLogTee } from './agentLogTee.js';
import { fetchPresignedAsset, materializeDesignsFor } from './designFiles.js';
import { nullDispatchRunReporter, type DispatchRunReporter } from './dispatchRunReporter.js';
import { legBranches, startCheckpoints, type LegBranch } from './checkpoint.js';

// THE DISPATCH LEG (Story MOTIR-3655 · MOTIR-3695) — the one implementation of
// "materialize, spawn the agent, and decide what actually happened."
//
// ── Why it exists ──────────────────────────────────────────────────────────
// `motir run` / `motir next` (`commands/dispatch.ts`'s `deliver`) and
// `motir batch` (`commands/batch.ts`'s `dispatchOne`) each carried their own
// copy of this sequence. Not similar code — the SAME code, in the same order,
// guarding the same four post-conditions, each with its own paragraph explaining
// the same lesson:
//
//   * MOTIR-3588 — materialize BEFORE the spawn, so a clone that cannot happen
//     does not first cost a session's tokens.
//   * MOTIR-3052 — echo the prompt BEFORE the spawn, so the transcript survives
//     an agent that is killed.
//   * MOTIR-3018 — exit 0 is not an OUTCOME. A finished card and a REFUSED one
//     both exit 0, so ask the card which it was.
//   * MOTIR-3004 — exit 0 is not a PUSH. `implemented` claims the code is on the
//     remote, and only a check can make that claim true.
//
// Four rules that must hold in two commands is four chances for them to hold in
// one. The order is load-bearing in a way that is easy to get wrong on a second
// write: the replan read comes BEFORE the push check, because a refusing agent
// reverts and pushes nothing by design, so the push check would otherwise report
// a correctly-refused card as work that went missing.
//
// ── What it deliberately does NOT do ───────────────────────────────────────
// It never renders, never writes a status, and never touches the exclude list.
// It returns a VERDICT and the callers act on it, because that is exactly where
// the two commands legitimately differ:
//
//   * `motir run` prints a full dispatch summary and sets `process.exitCode`;
//     `motir batch` prints a compact per-card block and folds the verdict into a
//     drain record.
//   * A missing bootstrap checkout is a WARNING to `run` (the card still records
//     implemented) and a FAILURE to `batch`. That difference is REAL and
//     predates this module, so the leg reports the suspects and declines to
//     decide — collapsing it here would silently change one of the two commands
//     while claiming to be a refactor.
//   * `run` records `mark_integrated` on a session lineage; `batch` refuses a
//     session lineage outright and records `transitionStatus` + a separate
//     implementation report.
//
// The line is drawn at what is TRUE about the run rather than at what a command
// wants to say about it.

/** What the leg concluded. Exactly one is returned, in the order the checks run. */
export type DispatchLegVerdict =
  /** A checkout that was missing and clonable could not be cloned. No agent ran,
   *  and none should: the prompt opens with `git worktree add`. */
  | { kind: 'checkout_unavailable' }
  /** The agent exited non-zero, or was killed. The card is left In Progress on
   *  purpose — work was started. */
  | { kind: 'agent_failed'; exitCode: number; signal: string | null }
  /** The agent REFUSED the card and submitted a re-plan instead (MOTIR-3018).
   *  Not a failure: nothing was built, and nothing was broken. */
  | { kind: 'replan_submitted' }
  /** Exit 0, and nothing reached the remote (MOTIR-3004). */
  | { kind: 'nothing_pushed' }
  /** Exit 0, work on the remote, the card genuinely built. `suspects` is
   *  non-empty when a bootstrap dispatch did not produce its checkout — which
   *  the CALLER decides the severity of. */
  | {
      kind: 'succeeded';
      model: string | null;
      /** The agent's own session id (MOTIR-9048) — what the CI watch resumes; null when it reported none. */
      sessionId: string | null;
      suspects: SuspectDispatch[];
    };

export interface DispatchLegInput {
  client: Pick<MotirClient, 'getWorkItem' | 'listWorkItemDesigns'>;
  /** The link root, for `materializeDispatchCheckouts`. */
  rootDir: string;
  key: string;
  dispatch: DispatchPrompt;
  agent: ParsedAgentCommand;
  /** Every repository the card ships in, in the payload's order. Element 0 is
   *  the agent's cwd. Empty falls back to `primary` alone. */
  targets: DispatchTarget[];
  primary: DispatchTarget;
  /**
   * The branch `workReachedRemote` looks for work on, or null for "any branch
   * this card could be on".
   *
   * ⚠️ A PARAMETER rather than `dispatch.sessionBranch`, because the two callers
   * genuinely pass different things: `run` passes the payload's session branch,
   * and `batch` passes null on purpose — it has no session branch to offer and
   * must not start believing in one the server happened to mention.
   */
  sessionBranch: string | null;
  /** Called with `renderMaterialization`'s lines, so each command can print them
   *  in its own indentation without this module knowing what a transcript looks
   *  like. */
  onMaterialization: (lines: string[]) => void;
  /** Called immediately before the spawn — where `echoPromptIfAsked` goes. Its
   *  position is the MOTIR-3052 rule, so it is a hook rather than a caller's
   *  responsibility to remember. */
  beforeSpawn: () => void;
  runAgentFn?: (input: {
    command: ParsedAgentCommand;
    prompt: string;
    cwd: string;
    materializeDesigns?: (designRoot: string) => Promise<boolean>;
  }) => Promise<AgentRunResult>;
  run?: CommandRunner;
  /**
   * The run REPORTER (Story MOTIR-1789 · MOTIR-1794), or absent.
   *
   * ⚠️ THE EVENTS BELONG HERE RATHER THAN IN EACH COMMAND, for the same reason
   * the four checks above do: `next`, `run <KEY>` and `batch` all come through
   * this function, and a per-command copy would be three places for the event
   * sequence to drift. A card dispatched through any of them therefore produces
   * the SAME events.
   *
   * Defaults to the null reporter, so wiring this in changed no behaviour and
   * every existing caller keeps working without learning about run reporting.
   * Reporting is best-effort by construction: none of these calls can throw.
   */
  reporter?: DispatchRunReporter;
  /**
   * Prepare the materialized checkouts before the spawn — a HOSTED run's code
   * graph (MOTIR-6560), which its container can only build once the CLI has
   * cloned them. Absent for a local run, whose checkouts are the operator's.
   */
  prepareCheckouts?: (cwds: string[]) => void;
  /**
   * Every repository's branch, when the caller already knows them (MOTIR-6793) —
   * `motir continue` resumes each repository on the branch its dead run left,
   * which is not the card's fresh `workBranch`. Recorded on `checkout_ready` and
   * checkpointed per repository, so a continue that dies again is continuable
   * again on the same branches. Absent: derived from the payload, as before.
   */
  branches?: LegBranch[];
  /** The checkpoint interval (MOTIR-6539) — the tests' seam; one minute otherwise. */
  checkpointIntervalMs?: number;
}

export async function runDispatchLeg(input: DispatchLegInput): Promise<DispatchLegVerdict> {
  const { client, rootDir, key, dispatch, agent, targets, primary } = input;
  const over = targets.length > 0 ? targets : [primary];
  const reporter = input.reporter ?? nullDispatchRunReporter;

  /** Report the verdict and return it, so no arm can report a different one. */
  const settle = (verdict: DispatchLegVerdict): DispatchLegVerdict => {
    reporter.event({
      kind: 'leg_verdict',
      workItemKey: key,
      data: verdict,
      ...(verdict.kind === 'checkout_unavailable'
        ? { disposition: 'skipped' as const, skipReason: 'checkout_unavailable' as const }
        : {}),
      ...(verdict.kind === 'agent_failed' ? { disposition: 'failed' as const } : {}),
      ...(verdict.kind === 'replan_submitted' ? { disposition: 'replanned' as const } : {}),
    });
    return verdict;
  };

  // ⚠️ MATERIALIZE BEFORE THE SPAWN (MOTIR-3588).
  const materialized = materializeDispatchCheckouts(rootDir, over);
  input.onMaterialization(renderMaterialization(materialized));
  reporter.event({
    kind: 'checkout_ready',
    workItemKey: key,
    data: {
      repositories: over.map((t) => t.targetRepo),
      failures: materialized.failures.length,
      // WHERE THIS LEG'S WORK WILL BE (MOTIR-6530) — the session branch on a
      // lineage run, else the per-card branch the prompt names. The one place a
      // local run records its branch: if the process dies, `motir continue`
      // reads it here. `null` only from a server too old to name the branch.
      branch: input.sessionBranch ?? dispatch.branch ?? null,
      // Every repository's branch, named before the agent exists (MOTIR-6539) —
      // the CHECKPOINT push target, per repository (`checkpoint.ts`).
      branches: input.branches ?? legBranches(dispatch, over),
    },
  });
  if (materialized.failures.length > 0) return settle({ kind: 'checkout_unavailable' });
  input.prepareCheckouts?.(over.map((target) => target.cwd));

  // BEFORE the spawn (MOTIR-3052) — the run you most want the transcript for is
  // the one whose agent is about to be killed.
  input.beforeSpawn();
  reporter.event({ kind: 'prompt_issued', workItemKey: key });
  const runAgentFn = input.runAgentFn ?? defaultRunAgent;
  reporter.event({
    kind: 'agent_started',
    workItemKey: key,
    disposition: 'running',
    data: {
      agent: agent.binary,
      // The agent's session, when Motir chose it or is resuming it (MOTIR-8980) — known
      // before the agent runs, so a run that dies still names the conversation.
      ...(agent.stream?.sessionId ? { sessionId: agent.stream.sessionId } : {}),
    },
  });
  // The producer for the `log` event kind (MOTIR-3961). `null` unless the
  // operator passed `--report-log`, and then the spawn is unchanged.
  const logTee = createLegLogTee(reporter, key);
  // The agent's commits reach origin as it makes them, so a run that dies keeps
  // its work (MOTIR-6539). Stopped — with one last push — however the agent ends.
  const checkpoints = startCheckpoints({
    key,
    targets: over,
    workBranch: dispatch.workBranch ?? null,
    ...(input.branches ? { branches: input.branches } : {}),
    reporter,
    ...(input.run ? { run: input.run } : {}),
    ...(input.checkpointIntervalMs ? { intervalMs: input.checkpointIntervalMs } : {}),
  });
  const result = await runAgentFn({
    command: agent,
    prompt: dispatch.prompt,
    cwd: primary.cwd,
    // The card's APPROVED DESIGN, into the run's own directory (MOTIR-5562).
    // Built here because this is where the client and the key are both in hand;
    // it is `runAgent` that owns the directory and removes it with the run.
    materializeDesigns: materializeDesignsFor(key, {
      readDesigns: (k) => client.listWorkItemDesigns(k),
      fetchAsset: fetchPresignedAsset,
    }),
    ...(logTee ? { onOutput: logTee.write } : {}),
  }).finally(() => checkpoints.stop());
  // The tail, BEFORE the exit event, so the transcript a reader sees ends where
  // the agent stopped rather than after the verdict that describes it.
  logTee?.flush();
  reporter.event({
    kind: 'agent_exited',
    workItemKey: key,
    exitCode: result.exitCode,
    // The model only the AGENT can answer for (MOTIR-2419) — its self-report, or
    // null. Never a guess: an absent report is a null model, and the surface
    // renders that rather than inventing one. TOP-LEVEL is what the server writes
    // onto the leg (MOTIR-7504); `data` keeps its copy so the stream reads as before.
    model: result.model ?? null,
    data: {
      model: result.model ?? null,
      signal: result.signal ?? null,
      // The agent's own session id (MOTIR-8980) — what a later fix resumes. Null when the
      // agent ran in a form that has none, so the key's absence never reads as unknown.
      sessionId: result.sessionId ?? null,
    },
  });

  // THE RUN-FOUND REPORT (MOTIR-8698) — the agent stopped on an unbuildable card and
  // said why in its self-report. The CLI makes the report, with the run's own
  // credential, because the agent may hold none (a hosted run, a run inside an agent
  // instance) or have no Motir MCP to make it with. BEFORE any verdict settles the
  // leg: the server records it on the leg that is still open. Whatever the exit
  // code — an agent that reported and then failed still found what it found.
  if (result.unbuildableReason) {
    await reporter.reportUnbuildable?.(key, result.unbuildableReason);
  }

  // THE AGENT'S OTHER WRITES (MOTIR-8722) — its build-through record and its STOP, which
  // the prompt sends through `$MOTIR_AGENT_REPORT` when the agent has no Motir tools (a
  // hosted run, a run inside an agent instance). Made with the run's credential, BEFORE the
  // verdict below: the STOP's move to Planning is what `agentSubmittedReplan` then reads.
  // The DECISIONS (MOTIR-10000) ride the same one record, beside the points or alone.
  const points = result.discrepancy ?? [];
  const decisions = result.decisions ?? [];
  if (points.length > 0 || decisions.length > 0) {
    await reporter.reportDiscrepancy?.(key, points, decisions);
  }
  if (result.stop) await reporter.reportStop?.(key, result.stop);

  if (result.exitCode !== 0) {
    return settle({
      kind: 'agent_failed',
      exitCode: result.exitCode,
      signal: result.signal ?? null,
    });
  }

  // ⚠️ EXIT 0 IS NOT AN OUTCOME (MOTIR-3018), and this read comes BEFORE the push
  // check — see the header for why the order is not cosmetic.
  if (await agentSubmittedReplan(client, key)) return settle({ kind: 'replan_submitted' });

  // ⚠️ EXIT 0 IS NOT A PUSH (MOTIR-3004).
  if (
    workReachedRemote(primary.cwd, key, input.sessionBranch, input.run ?? execCommand) === 'nothing'
  ) {
    return settle({ kind: 'nothing_pushed' });
  }

  // EVERY repository of the set, not only the primary (MOTIR-3133): a card whose
  // second half had no checkout to happen in is exactly the run that otherwise
  // exits 0 with half the work missing.
  const suspects = over.map((t) => checkBootstrapCheckout(t)).filter((s) => s !== null);
  return settle({
    kind: 'succeeded',
    model: result.model ?? null,
    sessionId: result.sessionId ?? null,
    suspects,
  });
}
