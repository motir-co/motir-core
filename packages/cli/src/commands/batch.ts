import { CliError } from '../errors.js';
import { info } from '../output.js';
import { parseKinds } from './read.js';
import {
  claimAllowsDispatch,
  ensureInProgress,
  resolveAgent,
  echoPromptIfAsked,
  resolveOwnerId,
  type DeliveryOptions,
} from './dispatch.js';
import { parseMax, transitionToImplemented } from './auto.js';
import { resumeFixAgent } from './dispatch.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { runAgent } from '../agentRun.js';
import { deriveAgentHarness, type ParsedAgentCommand } from '../agentProfiles.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import {
  autoOnlyFlagError,
  cwdReasonLabel,
  findingsPolicyOf,
  renderClaimRefusal,
  renderFindingsPolicy,
  pushedButUnlinked,
  renderNoLinkedPullRequest,
  renderNothingPushed,
  renderReplanSubmitted,
  renderRepositoriesBlock,
  resolveDispatchTarget,
  resolveDispatchTargets,
} from '../dispatch.js';
import { execCommand, runIdFromDate, type CommandRunner } from '../git.js';
import { runDispatchLeg } from '../dispatchLeg.js';
import { createDispatchRunReporter, type DispatchRunReporter } from '../dispatchRunReporter.js';
import { runCiWatchPhase } from '../ciWatch.js';
import {
  batchExitCode,
  classifySnapshotItem,
  renderBatchSummary,
  renderSnapshotPlan,
  type BatchReconcile,
  type BatchRecord,
  type BatchStopReason,
  type BatchSummary,
  type ReconciledCard,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotSkip,
} from '../batchPlan.js';
import type { DispatchItem, MotirClient } from '../client.js';
import { manualWaitingOn } from '../autoLoop.js';
import { bindInterruptSignals, closeRunAndExit, type InterruptSignal } from '../interrupt.js';

// `motir batch` — THE FROZEN SNAPSHOT (Story 7.9 · Subtask 7.9.10 · MOTIR-888).
// Take the ready set ONCE, print it, then implement exactly those items one at a
// time. See `batchPlan.ts` for why the snapshot needs no session branch; this
// module is the drain over it.
//
// ── the two rules that shape this file ──────────────────────────────────────
//  1. **The list is frozen before the first agent starts.** Every item is read
//     up front (`listReadyForDispatch` → `planSnapshot`) and nothing re-reads the
//     ready set to pick work afterwards. The only later read is the newly-ready
//     COUNT, which is reporting — it can never add an item to the run.
//  2. **No lineage of its own.** This module creates no branch and integrates
//     nothing: each item's server-generated prompt carries the per-item-PR GIT
//     WORKFLOW, so the AGENT branches off origin/main in its own repo and opens
//     its own pull request, and `mark_integrated` is never called — two items in
//     the same repo simply open two independent pull requests. An item that
//     turns out to carry a session lineage is REFUSED rather than run.
//
//     ⚠️ This rule used to read *"No git… this module deliberately imports
//     nothing from `git.ts`"*, and that half had stopped being true well before
//     MOTIR-3695 (`workReachedRemote` is a git read, and the exit-0-is-not-a-push
//     check cannot be made without one). A stale rule in a header is worse than
//     no rule, because the next reader takes it as a constraint and works around
//     it. What was actually meant — no branch, no integration — is what it says
//     now.
//
//  3. **The per-card sequence is `runDispatchLeg`'s, not this file's**
//     (MOTIR-3695). Materialize-before-spawn, echo-before-spawn,
//     exit-0-is-not-an-outcome and exit-0-is-not-a-push are four rules that must
//     hold in `motir run` too, and two copies is two chances for them to hold in
//     one. This module supplies the chrome and folds the leg's verdict into a
//     drain record; it does not re-derive the verdict.

export interface BatchOptions extends DeliveryOptions {
  kinds?: string;
  /** `--max <n>` — cap the dispatches this invocation makes. */
  max?: string;
  /** `--keep-going` — continue past a failed agent instead of halting. */
  keepGoing?: boolean;
  /** `--reset` — clear this project's persisted exclude list first. */
  reset?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface BatchDeps {
  clock?: () => number;
  /** The agent launcher. Injected by the tests so the drain can be driven with
   *  a scripted agent — the fixture the acceptance criteria are written against. */
  runAgentFn?: typeof runAgent;
  /** The git runner the push check (MOTIR-3004) asks — the same seam
   *  `motir auto` takes, and deliberately NOT on `BatchOptions`, which is the
   *  FLAG surface (`optionRegistrationAudit` holds every field there to a
   *  registered option). */
  run?: CommandRunner;
  /** The CI watch's inter-poll wait (MOTIR-3685) — injected so a test does not
   *  spend real seconds proving a pending verdict costs no attempt. */
  wait?: () => Promise<void>;
  /** The CI watch's POLL bound (MOTIR-3685), distinct from the five-fix cap. */
  maxCiPolls?: number;
  /**
   * THE BETWEEN-ITERATION SEAM (Story MOTIR-3655 · MOTIR-3695, for MOTIR-3685).
   *
   * Called after each card the drain finishes and BEFORE the next one is
   * dispatched, with what that card produced. Returning `'stop'` ends the drain
   * exactly as `--max` does — the remaining cards land in `notReached`, the
   * summary is computed over what actually ran, and nothing is excluded.
   *
   * ── Why it is here before anything uses it ────────────────────────────────
   * MOTIR-3685 puts a CI gate in this position: `motir batch` must watch the
   * pull requests the finished card opened and NOT start the next card while
   * they are red, which is what makes batch different from `motir auto` (whose
   * pull requests are for every card at once). A drain that cannot be
   * interrupted between cards makes that card impossible to build without
   * re-opening this one, so the shape is settled here where the loop is being
   * rewritten anyway.
   *
   * It is a DEPENDENCY rather than a flag: like `run` and `runAgentFn` it is a
   * seam, and `BatchOptions` is the flag surface that `optionRegistrationAudit`
   * holds to registered options.
   *
   * Absent in production today — the drain runs exactly as it did.
   */
  afterCard?: (record: BatchRecord, context: { cwd: string }) => Promise<'continue' | 'stop'>;
}

type ResolvedAgent = NonNullable<ReturnType<typeof resolveAgent>>;

/**
 * `motir batch` REQUIRES an agent, for the same reason `motir auto` does:
 * `--print` is the copy-paste-into-your-agent mode, and there is nobody to paste
 * a snapshot of prompts. An error with guidance beats a silently degraded run.
 */
function requireAgent(opts: BatchOptions): ResolvedAgent {
  if (opts.print) {
    throw new CliError('`motir batch` cannot run in --print mode.', {
      hint: 'A batch has nobody to paste a prompt. Use `motir next --print` for one item, or pass --agent <cmd>.',
    });
  }
  const agent = resolveAgent(opts);
  if (!agent) {
    throw new CliError('`motir batch` needs an agent to run.', {
      hint: 'Pass --agent "<cmd>", set MOTIR_AGENT, or configure agentCommand. `motir doctor` checks it.',
    });
  }
  return agent;
}

// ── the snapshot ────────────────────────────────────────────────────────────

/**
 * The whole ready set, in the server's rank — the snapshot's raw material.
 *
 * ONE page walk (MOTIR-2398). It used to ask `next_ready` once per item with a
 * growing exclusion list — N requests to enumerate N items, plus a
 * stop-on-repeat guard against a server that ignored the exclusions. The
 * collection returns the same ranked set in pages, so neither is needed.
 */
/**
 * Split an enumerated ready set into what this run may take and what a previous
 * run's failure holds out, matching on KEY (MOTIR-2338).
 *
 * Both halves are returned because the held-out items are still part of the
 * snapshot BOUNDARY: they were ready when the run started, so an item that is
 * ready at the end and was held out did not "arrive during the run".
 */
function partitionByExclusion(
  items: readonly DispatchItem[],
  excludedKeys: ReadonlySet<string>,
): [DispatchItem[], DispatchItem[]] {
  const eligible: DispatchItem[] = [];
  const heldOut: DispatchItem[] = [];
  for (const item of items) {
    (excludedKeys.has(item.key.toUpperCase()) ? heldOut : eligible).push(item);
  }
  return [eligible, heldOut];
}

/** Freeze the ready set into the run's plan: what will be implemented, and
 *  what is left out with the reason. */
export function planSnapshot(items: DispatchItem[], ownerId?: string): Snapshot {
  const taken: SnapshotEntry[] = [];
  const skipped: SnapshotSkip[] = [];
  for (const item of items) {
    const disposition = classifySnapshotItem(item);
    if (disposition === 'take') {
      taken.push({
        key: item.key,
        title: item.title,
        kind: item.kind,
        statusKey: item.status?.key,
      });
    } else {
      // Who a manual card now waits on (MOTIR-7477, ADR §8) — absent is the starter.
      const waitingOn = disposition === 'needs_human' ? manualWaitingOn(item, ownerId) : undefined;
      skipped.push({
        key: item.key,
        title: item.title,
        reason: disposition,
        ...(waitingOn ? { waitingOn } : {}),
      });
    }
  }
  return { taken, skipped };
}

/**
 * The default between-card gate: watch the card just built, and decide whether the drain
 * goes on. Extracted from `batchCommand` (MOTIR-9059) so a test can reach it — it closed
 * over `batchCommand`'s locals, and `runBatch` only ever sees an injected `afterCard`.
 */
export function watchCardCi(input: {
  session: Pick<ProjectSession, 'client'>;
  agent: { parsed: ParsedAgentCommand };
  deps: Pick<BatchDeps, 'runAgentFn' | 'wait' | 'maxCiPolls'>;
  keepGoing: boolean | undefined;
}): NonNullable<BatchDeps['afterCard']> {
  const { session, agent, deps } = input;
  return async (record, context) => {
    // Nothing to watch on a card that did not get built.
    if (record.outcome !== 'implemented') return 'continue';
    // This card's OWN conversation, never the previous card's (MOTIR-9059).
    const resumeAgent = resumeFixAgent(agent.parsed, record.sessionId);
    const watch = await runCiWatchPhase({
      client: session.client,
      key: record.key,
      title: record.title ?? null,
      agent: agent.parsed,
      ...(resumeAgent ? { resumeAgent } : {}),
      cwd: context.cwd,
      report: (line) => info(line),
      ...(deps.runAgentFn ? { runAgentFn: deps.runAgentFn } : {}),
      ...(deps.wait ? { wait: deps.wait } : {}),
      ...(deps.maxCiPolls === undefined ? {} : { maxPolls: deps.maxCiPolls }),
    });
    if (watch.kind === 'green' || watch.kind === 'nothing') return 'continue';

    // ── `--keep-going` decides what happens AFTER the sixth red ───────
    //
    // The five-fix loop always runs; the flag only chooses what follows.
    // That keeps its shipped meaning intact — *one bad card should not end
    // the whole drain* — rather than inventing a second halt condition it
    // cannot reach. A CI give-up is the same shape as a failed agent: this
    // one card did not work out.
    //
    // ⚠️ NO EXCLUDE ENTRY IS WRITTEN, and the asymmetry with a failed
    // agent is deliberate rather than an oversight. A failed agent is
    // excluded because its card is left in a PICKABLE state and a later
    // `motir batch` would re-attempt it. A CI give-up leaves the card at
    // `implemented`, which is not in the ready set at all — `planSnapshot`
    // is built from `listReadyForDispatch` — so an exclude entry could
    // never match anything and would be a local opinion about a card the
    // server already holds back.
    return input.keepGoing ? 'continue' : 'stop';
  };
}

// ── the command ─────────────────────────────────────────────────────────────

export async function batchCommand(opts: BatchOptions, deps: BatchDeps = {}): Promise<void> {
  // `--auto-approve-replan` is registered here in order to be REFUSED
  // (MOTIR-3022), and the reason is `batch`'s defining contract: the snapshot is
  // frozen before the first agent starts and nothing re-reads the ready set, so
  // cards a newly-approved plan creates would be approved and then never
  // dispatched. Approving a change to a plan and declining to act on it is worse
  // than not offering the flag.
  if (opts.autoApproveReplan) {
    const { message, hint } = autoOnlyFlagError('batch');
    throw new CliError(message, { hint });
  }
  const kinds = parseKinds(opts.kinds);
  const max = parseMax(opts.max);
  const agent = requireAgent(opts);

  await withProjectSession(async (session) => {
    // ONE `whoami` for the whole run — see the note on `motir auto`'s.
    const ownerId = await resolveOwnerId(session.client);
    const summary = await runBatch({
      session,
      opts,
      kinds,
      max,
      agent,
      clock: deps.clock ?? Date.now,
      runAgentFn: deps.runAgentFn ?? runAgent,
      run: deps.run ?? execCommand,
      // ── THE CI GATE BETWEEN CARDS (Story MOTIR-3655 · MOTIR-3685) ────────
      //
      // This is what makes `motir batch` different from `motir auto`: batch's
      // pull requests are for ONE card, so the next card must not be started
      // while the one just finished is red. `auto`'s are for every card at once
      // and it watches only when there is nothing left to pick up.
      //
      // An injected gate WINS — a test drives the seam directly rather than
      // through a real CI verdict.
      afterCard: deps.afterCard ?? watchCardCi({ session, agent, deps, keepGoing: opts.keepGoing }),
      ownerId,
    });
    info('');
    info(renderBatchSummary(summary));
    info(renderFindingsPolicy(opts));
    process.exitCode = batchExitCode(summary);
  });
}

export interface BatchInput {
  session: ProjectSession;
  opts: BatchOptions;
  kinds: string[] | undefined;
  max: number | null;
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The token owner — every card this run takes is CLAIMED for them, and rows
   *  claimed by anyone else never enter the snapshot (MOTIR-2427). */
  ownerId: string;
  /** The git runner the MOTIR-3004 push check asks; defaults to the real one. */
  run?: CommandRunner;
  /** The between-iteration gate — see {@link BatchDeps.afterCard}. */
  afterCard?: (record: BatchRecord, context: { cwd: string }) => Promise<'continue' | 'stop'>;
  /**
   * The run REPORTER (Story MOTIR-1789 · MOTIR-1794).
   *
   * Opened INSIDE this function rather than by the command, because the SET it
   * carries is the FROZEN SNAPSHOT — `taken` in dispatch order plus every
   * `skipped` entry with its reason — and the snapshot does not exist until this
   * function computes it. That set is the whole reason `motir batch` is worth
   * reporting: the four cards it deliberately left out exist nowhere else.
   */
  reporter?: DispatchRunReporter;
  /**
   * Now, for the run id.
   *
   * ⚠️ `motir batch` is the ONE path with no run id of its own — it opens a pull
   * request per card and has no session branch to derive one for. It mints one
   * here through the SAME `runIdFromDate` every other path uses, so the
   * idempotency key a retried batch presents has the same shape and the same
   * meaning as `auto`'s and the scoped run's. Injectable for the same reason
   * `clock` is: a driven drain must produce a deterministic id.
   */
  now?: () => Date;
}

/** Snapshot, print, drain. Exported so the whole command can be driven against
 *  a scripted client + agent, which is the only way the "never picks up an item
 *  that became ready mid-run" property can actually be asserted. */
export async function runBatch(input: BatchInput): Promise<BatchSummary> {
  const { session, opts, kinds, max, agent, clock, runAgentFn, ownerId, afterCard } = input;
  const gitRun = input.run ?? execCommand;
  const { client, serverUrl, projectKey } = session;

  if (opts.reset) {
    const cleared = clearExcludes(serverUrl, projectKey);
    info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
  }
  // Items a previous run's agent failed on are held out of the snapshot, exactly
  // as `motir next` / `motir auto` hold them out of a pick.
  // The PERSISTED list is keyed by KEY (MOTIR-2338). The page walk enumerates the
  // WHOLE ready set, so no id translation is needed here — the excluded items
  // are simply filtered out of what it returns, which is the same set as before.
  const persistedExcludes = new Set(
    readExcludes(serverUrl, projectKey).map((e) => e.key.toUpperCase()),
  );
  if (persistedExcludes.size > 0) {
    info(
      `Skipping ${persistedExcludes.size} previously-failed item(s) — \`--reset\` retries them.`,
    );
  }

  // The snapshot only ever contains rows this run may take (MOTIR-2427):
  // unassigned, or its own interrupted work, and in the to-do category. Applied
  // at ENUMERATION rather than at dispatch, because the snapshot is the frozen
  // boundary a human reads before the first agent starts — a teammate's card
  // listed there and skipped later would have been printed as work about to
  // happen.
  const enumerated = await client.listReadyForDispatch({
    projectKey,
    ownerId,
    ...(kinds ? { kinds } : {}),
  });
  const [eligible, heldOut] = partitionByExclusion(enumerated, persistedExcludes);
  const snapshot = planSnapshot(eligible, ownerId);
  // Everything the snapshot saw — the frozen boundary. An item outside this set
  // at the end of the run became ready DURING it. The held-out items were seen,
  // so they belong to the boundary too.
  const snapshotKeys = new Set([
    ...snapshot.taken.map((e) => e.key.toUpperCase()),
    ...heldOut.map((item) => item.key.toUpperCase()),
  ]);
  const skippedKeys = new Set<string>();

  info(renderSnapshotPlan(snapshot));

  // ── THE RUN RECORD (Story MOTIR-1789 · MOTIR-1794) ──────────────────────
  //
  // ⚠️ OPENED WITH THE FROZEN SNAPSHOT — BOTH HALVES. `taken` in dispatch order,
  // and every `skipped` entry WITH its reason. The skips are the useful half:
  // they are the only record anywhere of what this run deliberately did not do,
  // and nothing that happens later could reconstruct them, because nothing
  // happens to a card that was never dispatched.
  const reporter =
    input.reporter ??
    createDispatchRunReporter({ client, reportLogBodies: opts.reportLog === true });
  await reporter.open({
    projectKey,
    command: 'batch',
    runId: runIdFromDate((input.now ?? (() => new Date()))()),
    cards: [
      ...snapshot.taken.map((entry) => ({ key: entry.key, disposition: 'queued' as const })),
      ...snapshot.skipped.map((skip) => ({
        key: skip.key,
        disposition: 'skipped' as const,
        skipReason: skip.reason,
      })),
    ],
    agent: agent.parsed.binary,
  });
  reporter.event({
    kind: 'snapshot_frozen',
    data: { taken: snapshot.taken.length, skipped: snapshot.skipped.length },
  });

  const records: BatchRecord[] = [];
  const skipped: SnapshotSkip[] = [...snapshot.skipped];
  let stopIndex = snapshot.taken.length;
  let stopReason: BatchStopReason = 'completed';

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
    info('Interrupt received — finishing the item in flight, then stopping.');
    info('Press Ctrl-C again to exit immediately.');
  };
  const detachInterrupt = bindInterruptSignals(onSignal);

  try {
    for (const [index, entry] of snapshot.taken.entries()) {
      if (interrupted) {
        stopReason = 'interrupted';
        stopIndex = index;
        break;
      }
      if (max !== null && records.length >= max) {
        stopReason = 'max';
        stopIndex = index;
        break;
      }

      const outcome = await dispatchOne({
        session,
        entry,
        opts,
        agent,
        clock,
        runAgentFn,
        run: gitRun,
        reporter,
      });
      if (outcome.kind === 'skipped') {
        skipped.push(outcome.skip);
        skippedKeys.add(entry.key.toUpperCase());
        reporter.event({
          kind: 'card_skipped',
          workItemKey: entry.key,
          disposition: 'skipped',
          skipReason: outcome.skip.reason,
        });
        continue;
      }

      records.push(outcome.record);
      if (outcome.record.outcome === 'failed') {
        addExclude(serverUrl, projectKey, { key: entry.key });
        if (!opts.keepGoing) {
          stopReason = interrupted ? 'interrupted' : 'halted';
          stopIndex = index + 1;
          break;
        }
      } else {
        removeExclude(serverUrl, projectKey, entry.key);
      }

      // THE BETWEEN-ITERATION SEAM (MOTIR-3695) — see `BatchDeps.afterCard`. It
      // runs AFTER the exclude bookkeeping, so a gate that stops the drain
      // leaves the card's own record exactly as it would have been, and BEFORE
      // the next dispatch, which is the whole point.
      if (afterCard && (await afterCard(outcome.record, { cwd: outcome.cwd })) === 'stop') {
        stopReason = 'gated';
        stopIndex = index + 1;
        break;
      }
    }
  } finally {
    detachInterrupt();
  }

  const notReached = snapshot.taken
    .slice(stopIndex)
    .filter((e) => !skippedKeys.has(e.key.toUpperCase()) && !records.some((r) => r.key === e.key));

  reporter.event({ kind: 'run_closed', data: { stopReason } });
  await reporter.close(stopReason);

  return {
    records,
    skipped,
    notReached,
    // Reporting only — read AFTER the drain, and never fed back into it.
    newlyReady: await countNewlyReady(client, projectKey, kinds, snapshotKeys, snapshot.skipped),
    ...(records.length > 0 ? { reconcile: await reconcileDispatched(client, records) } : {}),
    stopReason,
  };
}

/**
 * Read every dispatched card BACK, once, at exit (MOTIR-3197).
 *
 * ── Why this is one read per key, and what was ruled out ────────────────────
 * The cheaper shape would be one collection call narrowed to the dispatched
 * keys, and every `/api/v1` operation whose 200 embeds a work-item summary was
 * enumerated from the generated `src/api/schema.d.ts` before settling for this:
 *
 *   • `listProjectWorkItems` — the fattest one, and it takes a `filter`, but
 *     the FilterAST has NO key field (`lib/filters/ast.ts`'s
 *     `BuiltInFilterFieldId` is kind / status / priority / type / assignee /
 *     reporter / sprint / text / created / updated / due / storyPoints /
 *     estimate, plus `lbl` / `cmp` / `cf:*`). It cannot express a key SET at
 *     all, so narrowing would mean paging the whole project and discarding
 *     most of it.
 *   • `listSprintWorkItems` / `listProjectBacklog` — narrowed by MEMBERSHIP,
 *     which is not the run's set: a batch snapshot spans whatever was ready.
 *   • the ready lanes (`getProjectReadyLeaves` / `getProjectReadyBugs`) —
 *     cannot contain a dispatched card by construction.
 *     Every one of them left the to-do category when it was claimed.
 *   • `getWorkItem` — per key, and the only operation that can name this set.
 *
 * So the fallback the card allows for is the only door, and the bound is the
 * number of cards this run dispatched — which `--max` and the frozen snapshot
 * already cap. Sequential rather than concurrent: it is the tail of a run that
 * has just spent minutes per card, so there is nothing to win, and a burst
 * against the rate limiter at exit would be a poor trade for it.
 *
 * ⚠️ IT NEVER FAILS THE RUN. Every error is caught and rendered; none reaches
 * `batchExitCode`, which reads only `records` and `stopReason` — so a run's
 * exit code is exactly what it would have been before this existed.
 *
 * ── ONE failure, or ALL of them ────────────────────────────────────────────
 * A single card that will not read is a NULL STATUS with its reason, kept in
 * the block: the other rows are still facts, and dropping the odd one out is
 * how a summary starts lying quietly.
 *
 * When NO card could be read the answer is different in kind, not in degree —
 * the server is unreachable, the token was revoked, the process is coming down
 * — and printing N identical "could not be read" rows would bury one fact
 * under a list. That collapses to `unavailable`, which says once that nobody
 * looked. The run's own table above still carries every key.
 */
async function reconcileDispatched(
  client: MotirClient,
  records: readonly BatchRecord[],
): Promise<BatchReconcile> {
  const cards: ReconciledCard[] = [];
  for (const record of records) {
    try {
      const detail = await client.getWorkItem(record.key);
      cards.push({ key: record.key, status: detail.item.status });
    } catch (err) {
      // ⚠️ NOT `status: 'implemented'`, and not a dropped row. The run cannot
      // see where this card is, and saying so is the only honest column.
      cards.push({ key: record.key, status: null, detail: errorText(err) });
    }
  }
  const firstFailure = cards[0];
  if (firstFailure && cards.every((c) => c.status === null)) {
    return { cards: [], unavailable: firstFailure.detail ?? 'the read-back failed' };
  }
  return { cards };
}

/** An error's message for the summary — never a stack, never `[object Object]`. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which items became ready DURING the run — the count that tells a human a
 * frozen snapshot cost them something.
 *
 * A fresh enumeration minus everything the snapshot saw. Items the run
 * dispatched are In Review / In Progress and so are no longer ready at all;
 * items the snapshot skipped are still ready and are excluded BY KEY, so a
 * needs-planning story is never miscounted as newly ready.
 */
async function countNewlyReady(
  client: MotirClient,
  projectKey: string,
  kinds: string[] | undefined,
  snapshotKeys: Set<string>,
  snapshotSkips: SnapshotSkip[],
): Promise<{ key: string; title: string | null }[]> {
  const skippedKeys = new Set(snapshotSkips.map((s) => s.key));
  const after = await client.listReadyForDispatch({ projectKey, ...(kinds ? { kinds } : {}) });
  return after
    .filter((item) => !snapshotKeys.has(item.key.toUpperCase()) && !skippedKeys.has(item.key))
    .map((item) => ({ key: item.key, title: item.title }));
}

interface DispatchOneInput {
  session: ProjectSession;
  entry: SnapshotEntry;
  /** The run's flags — read for the per-run findings policy alone (MOTIR-3022),
   *  which has to reach the PROMPT rather than stay in this process. */
  opts: BatchOptions;
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The git runner the push check uses (MOTIR-3004) — the same injection seam
   *  `motir auto` takes its runner through. */
  run: CommandRunner;
  /** The run reporter, threaded into the shared leg. */
  reporter: DispatchRunReporter;
}

type DispatchOneResult =
  /** `cwd` rides the RESULT rather than the record: the between-iteration gate
   *  needs the checkout CI is red on, and `BatchRecord` is the reporting shape
   *  the summary renders — widening it would put a filesystem path in a
   *  transcript that has no use for one. */
  { kind: 'record'; record: BatchRecord; cwd: string } | { kind: 'skipped'; skip: SnapshotSkip };

/** Run ONE snapshot item through the single-dispatch pipeline. */
async function dispatchOne(input: DispatchOneInput): Promise<DispatchOneResult> {
  const { session, entry, agent, clock, runAgentFn, run } = input;
  const { client, link } = session;

  // The prompt is fetched BEFORE the status flip, which is the opposite order to
  // `motir auto`. `dispatch_prompt` is a pure read (it never claims an item), so
  // fetching first lets the lineage check below refuse an item without having
  // touched it — no flip to undo. NO `sessionBranch` seed is passed, ever: this
  // command has no session branch to offer, and the server can then only answer
  // with the lineage the item genuinely has.
  const dispatch = await client.dispatchPrompt(entry.key, {
    findingsPolicy: findingsPolicyOf(input.opts),
  });

  if (dispatch.workflowMode === 'session_lineage') {
    // The snapshot filter already excluded every item with an inherited
    // lineage, so reaching here means one APPEARED between the snapshot and now
    // (a concurrent `motir auto` integrated a dependency). Running it would
    // integrate onto a session branch, which is precisely what `batch`
    // guarantees it never does — so refuse, untouched, and name it.
    info(
      `${entry.key}: skipped — a dependency was integrated on ${
        dispatch.sessionBranch ?? 'a session branch'
      } after the snapshot was taken.`,
    );
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'integrated_dep' },
    };
  }

  // THE CLAIM, and it can say no (MOTIR-3048). It comes after the lineage check
  // for the same reason that check comes first: a refusal there must leave the
  // card untouched, and a claim already made would have to be undone. From here
  // on nothing else can refuse, so this is the last point at which the run can
  // walk away having changed nothing.
  const claim = await ensureInProgress(client, entry.key);
  if (!claimAllowsDispatch(claim)) {
    // A SKIP, not a failure: the snapshot froze a set this run could take, and
    // a sibling took one of them in between. No agent ran, nothing was
    // reverted, and `batchExitCode` reads only `records` — so the run's exit
    // code is unaffected, which is the honest report of "somebody else has it".
    info('');
    info(renderClaimRefusal(claim));
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'claim_refused' },
    };
  }
  // MOTIR-3133 — the same per-repository resolution `deliver()` makes, from the
  // same function, rendered by the same block. Batch prints its own lines rather
  // than going through `deliver()`, and a second rendering of these facts is
  // exactly how the two would drift.
  const targets = resolveDispatchTargets(
    link.dir,
    link.config,
    // The clone URL travels WITH the name (MOTIR-3588).
    (dispatch.targetRepos ?? []).map((repo) => ({ name: repo.name, cloneUrl: repo.cloneUrl })),
  );
  const target =
    targets[0] ??
    resolveDispatchTarget(link.dir, link.config, dispatch.targetRepo, {
      cloneUrl: dispatch.targetRepoCloneUrl ?? null,
    });

  info('');
  info(`── ${entry.key} — ${entry.title ?? ''}`);
  info(`   ${target.cwd}  (${cwdReasonLabel(target)})`);
  for (const line of renderRepositoriesBlock(targets)) info(`   ${line.trimStart()}`);
  info('   its own branch off origin/main, its own pull request');

  // ⚠️ THE SHARED LEG (MOTIR-3695). Materialize-before-spawn, echo-before-spawn,
  // exit-0-is-not-an-outcome and exit-0-is-not-a-push are `runDispatchLeg`'s,
  // which is the SAME code `motir run` runs — batch no longer carries a second
  // copy of four rules that have to agree.
  //
  // The verdicts below are where the two commands legitimately differ, and each
  // difference was here before the leg was: batch folds a verdict into a drain
  // RECORD (so the summary and the exit code can be computed over the run),
  // where `run` prints and sets `process.exitCode`.
  const started = clock();
  const verdict = await runDispatchLeg({
    client,
    rootDir: link.dir,
    key: entry.key,
    dispatch,
    reporter: input.reporter,
    agent: agent.parsed,
    targets,
    primary: target,
    // NULL, deliberately, exactly as before: batch has no session branch to
    // offer and must not start believing in one the server happened to mention.
    sessionBranch: null,
    onMaterialization: (lines) => {
      for (const line of lines) info(`   ${line.trimStart()}`);
    },
    // One block per dispatched item, in the drain's own order.
    beforeSpawn: () => echoPromptIfAsked(input.opts, entry.key, dispatch),
    runAgentFn,
    run,
  });
  const durationMs = clock() - started;
  const base = {
    key: entry.key,
    title: entry.title,
    durationMs,
    repo: dispatch.targetRepo,
    // The card's own conversation, for its CI watch to resume (MOTIR-9059).
    sessionId: verdict.kind === 'succeeded' ? verdict.sessionId : null,
  };

  if (verdict.kind === 'checkout_unavailable') {
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'checkout_unavailable' },
    };
  }

  if (verdict.kind === 'agent_failed') {
    info(`${entry.key}: agent exited ${verdict.exitCode} — left In Progress, nothing reverted.`);
    return {
      kind: 'record',
      cwd: target.cwd,
      record: {
        ...base,
        outcome: 'failed',
        detail: verdict.signal ? `killed by ${verdict.signal}` : `exit ${verdict.exitCode}`,
      },
    };
  }

  // A SKIP, not a record: the run implemented nothing, and `keepGoing` is not
  // consulted because there was no failure.
  if (verdict.kind === 'replan_submitted') {
    info(renderReplanSubmitted(entry.key));
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'replan_submitted' },
    };
  }

  // Refused rather than recorded as built — the item stays In Progress, which is
  // what an interrupted run looks like.
  if (verdict.kind === 'nothing_pushed') {
    info(renderNothingPushed(entry.key, dispatch));
    return {
      kind: 'record',
      cwd: target.cwd,
      record: { ...base, outcome: 'failed', detail: 'nothing reached the remote' },
    };
  }

  // ⚠️ A bootstrap dispatch that did not produce its checkout is a FAILED
  // dispatch to BATCH — not a success with a warning, as it is to `motir run`.
  // The prompt's whole job was to create it, and a drain that recorded it as
  // implemented would carry the lie into every later card's report. The leg
  // reports the suspects and declines to decide precisely so this stays a
  // per-command judgement rather than becoming a silent change to one of them.
  const suspect = verdict.suspects[0];
  if (suspect) {
    info(`${entry.key}: ${suspect.message}`);
    info(`Hint: ${suspect.hint}`);
    return {
      kind: 'record',
      cwd: target.cwd,
      record: { ...base, outcome: 'failed', detail: 'bootstrap checkout missing' },
    };
  }

  // ⚠️ PUSHED, BUT LINKED TO NOTHING (MOTIR-10877) — `motir run`'s rule, kept here too: a
  // card nothing would close on merge is not Implemented. The detail names each branch.
  if (pushedButUnlinked(verdict)) {
    const unlinked = verdict.delivery?.unlinked ?? [];
    info(renderNoLinkedPullRequest(entry.key, unlinked));
    return {
      kind: 'record',
      cwd: target.cwd,
      record: {
        ...base,
        outcome: 'failed',
        detail:
          'no pull request linked: ' +
          (unlinked.map((u) => u.branch ?? u.repository ?? '?').join(', ') || 'none found'),
      },
    };
  }

  // Exit 0 AND the work is on the remote: the agent completed the prompt's GIT
  // WORKFLOW, whose last step is opening the pull request — so Implemented is the
  // truthful status (built, pushed, waiting on CI), and the per-item close-out is
  // `motir done <key>` after the human merges it.
  // ⚠️ THE CONTAINER GATE'S REFUSAL IS AN OUTCOME, NOT A CRASH (Bug MOTIR-3268).
  // `motir batch` takes an explicit LIST of keys, so a container is genuinely
  // reachable here — and an unhandled throw would end the whole batch on one
  // card's status, abandoning the close-out of everything already built.
  const refusal = await transitionToImplemented(client, entry.key);
  if (refusal) {
    info(`${entry.key}: ${refusal}`);
    return {
      kind: 'record',
      cwd: target.cwd,
      record: { ...base, outcome: 'failed', detail: 'container has open children' },
    };
  }
  // What BUILT it, recorded as its own fact (MOTIR-2421). Two calls rather than
  // one because they assert different things: the transition says where the item
  // is, this says what ran. `motir auto` gets both from `mark_integrated`, which
  // can only speak while also claiming a session branch — and batch has none.
  // Same split by who-knows as the loop's (MOTIR-2419): the harness comes off
  // the command this run launched, the model off the agent's own report.
  await client.reportImplementation({
    key: entry.key,
    implementationSource: 'byok',
    implementationHarness: deriveAgentHarness(agent.parsed.binary),
    implementationModel: verdict.model,
  });
  info(`${entry.key}: Implemented via its own pull request — CI decides when it is reviewable.`);
  return { kind: 'record', record: { ...base, outcome: 'implemented' }, cwd: target.cwd };
}
