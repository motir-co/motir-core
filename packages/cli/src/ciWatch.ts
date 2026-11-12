import { runAgent as defaultRunAgent, type AgentRunResult } from './agentRun.js';
import type { ParsedAgentCommand } from './agentProfiles.js';
import type { MotirClient, WorkItemDelivery } from './client.js';

// WATCH CI, AND FIX RED (Story MOTIR-3655 · MOTIR-3685) — the phase every lane
// runs after its pull requests are open.
//
// ── The shape, in one table ────────────────────────────────────────────────
//
//   green   (every delivery `passing`)   → done
//   pending (any `running` / unrecorded) → keep waiting; DOES NOT COUNT
//   red     (any `failing`, or any
//            standing `queueExit`)       → count it, dispatch a fixing iteration
//
// ⚠️ A STANDING MERGE-QUEUE FAILURE IS RED (MOTIR-5720). The queue failed on the
// pull request's MERGE GROUP, so its own `ci` is usually `passing` — and this
// loop used to call an ejected pull request green on the first poll and never run
// the agent. The server publishes the standing exit on the delivery; the loop
// only has to read it.
//
// A red check does NOT change a card's status. `implemented` is exactly right
// for code that is committed and whose build has not spoken; moving it back
// would say the work was not done, which is false.
//
// ── The verdict is the SERVER'S, not the CLI's ────────────────────────────
// Every state read here comes from `deliveries[].ci`, which is
// `derivePrCiState` at the latest recorded sha (MOTIR-3697 published it for
// exactly this consumer). Shelling to `gh pr checks` would be a SECOND verdict —
// different inputs, different rules — and it would drift from the pill a person
// reads on the same card. There is no `gh` in this file and there must not be.
//
// ── Why pending never counts ──────────────────────────────────────────────
// The budget is for FIXES, and a fix is a response to a verdict. While CI is
// running the loop has received no verdict; spending an attempt on it would let
// a slow build exhaust the budget without a single failure ever being seen.

/**
 * THE CAP — five fixing attempts. The sixth red gives up.
 *
 * ⚠️ It is hardcoded here and it is NOT buried: it becomes a per-project SETTING
 * under the hosted-agent epic (MOTIR-673), and it will live beside the other
 * dispatch settings on the project's own settings surface — the same place
 * `findingsPolicy` and the repository set are configured — because it is a
 * property of how a PROJECT wants its agents to behave, not of one run.
 *
 * Five is also the whole flake policy. Every fixing iteration pushes and
 * re-triggers CI, so a genuine flake gets five fresh rolls; red six times
 * running is not a flake. No separate flake handling is built, and building one
 * would be a second mechanism guessing at the same question.
 */
export const CI_FIX_ATTEMPTS = 5;

/**
 * The MCP tool that writes How to test (`lib/dispatch/promptTemplate.ts`'s
 * `HOW_TO_TEST_TOOL_NAME`). Re-stated rather than imported because the CLI is a
 * standalone package that cannot reach into the Next app.
 */
export const HOW_TO_TEST_TOOL_NAME = 'publish_test_instructions';
/** The MCP tool a review-fix agent records a fix that went past the card's text with
 *  (MOTIR-11094) — the same build-through record a run makes. */
export const DISCREPANCY_TOOL_NAME = 'record_run_discrepancy';

/**
 * `1 attempt` / `2 attempts`, in the one place both report lines read it from.
 *
 * Exported so it can be asserted directly: the SINGULAR arm is unreachable while
 * {@link CI_FIX_ATTEMPTS} is 5 and becomes reachable the moment it is a setting
 * (MOTIR-673) somebody sets to 1 — a branch that is dead today and alive after a
 * config change is exactly the kind a test has to pin now rather than later.
 */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export type CiVerdict =
  /** Every delivery `passing`. */
  | 'green'
  /** At least one `failing`. Any red makes the SET red. */
  | 'red'
  /** No failure, and at least one delivery without a terminal verdict. */
  | 'pending'
  /**
   * There is nothing to watch — no deliveries recorded, or a server too old to
   * publish them at all.
   *
   * ⚠️ NOT `green`. A card whose pull requests are unknown to this build has not
   * been shown to pass; calling it green would announce a result nobody
   * measured. The lanes treat it as "skip the watch", which is what they did
   * before this phase existed.
   */
  | 'nothing';

/**
 * The verdict over a whole delivery set.
 *
 * ⚠️ RED WINS OVER PENDING. One green and one running is *running*; one green
 * and one failing is *failing*. A set with both a failure and a pending member
 * is RED, because the failure is a verdict that has already arrived and waiting
 * for the other one changes nothing about it.
 */
export function ciVerdict(deliveries: readonly WorkItemDelivery[] | undefined): CiVerdict {
  if (deliveries === undefined || deliveries.length === 0) return 'nothing';
  if (deliveries.some(isRed)) return 'red';
  if (deliveries.every((d) => d.ci === 'passing' && !hasQueueExit(d))) return 'green';
  return 'pending';
}

/** A delivery the merge queue threw out, whose failure still stands at its head. */
function hasQueueExit(d: WorkItemDelivery): boolean {
  return d.queueExit !== undefined && d.queueExit !== null;
}

/** Red on its own checks, or red in the queue (MOTIR-5720). */
function isRed(d: WorkItemDelivery): boolean {
  return d.ci === 'failing' || hasQueueExit(d);
}

/** The deliveries a red verdict is about — what the fixing iteration is pointed
 *  at and what a give-up names. A queue-failing one is among them. */
export function failingDeliveries(
  deliveries: readonly WorkItemDelivery[] | undefined,
): WorkItemDelivery[] {
  return (deliveries ?? []).filter(isRed);
}

/** What an ended-early repair tells the person: the fixing attempt pushed
 *  nothing (MOTIR-5720). *Queue again* is not offered after a queue FAILURE
 *  (`approval-gates.md` §4 FIFTH AMENDMENT; MOTIR-6594), so the way on is a new
 *  head: a push whose checks go green asks for approval again. */
export const NOTHING_TO_CHANGE_DETAIL =
  'nothing was pushed — push a commit to re-run CI; a queue failure is not queued again';

const deliveryId = (d: WorkItemDelivery) => `${d.repo}#${d.number}`;

/**
 * Is this red ONLY the queue's, at the SAME heads the last fixing attempt saw?
 * Then the attempt pushed nothing: every failing delivery is red because of a
 * standing `queueExit` alone (its own checks are not failing), and each exit
 * still names the head it named before the attempt.
 */
function queueRedUnchanged(
  failing: readonly WorkItemDelivery[],
  headsAtAttempt: ReadonlyMap<string, string> | null,
): boolean {
  if (headsAtAttempt === null || failing.length === 0) return false;
  return failing.every(
    (d) =>
      d.ci !== 'failing' &&
      d.queueExit != null &&
      headsAtAttempt.get(deliveryId(d)) === d.queueExit.headSha,
  );
}

/**
 * How many consecutive polls must show {@link queueRedUnchanged} before the watch
 * ends. Two, not one: the server reads a pull request's head from its latest
 * check rows, so for the few seconds between a push and its first pending check
 * the exit still names the old head. One extra poll lets that check land.
 */
const UNCHANGED_POLLS_TO_STOP = 2;

export type CiWatchOutcome =
  /** Every delivery went green — with or without fixes along the way. */
  | { kind: 'green'; attempts: number }
  /** Nothing to watch. The lane continues exactly as it did before this phase. */
  | { kind: 'nothing' }
  /**
   * The SIXTH red. The cards stay at `implemented`, the lane reports, and the
   * command exits non-zero — it must be obvious it gave up rather than
   * succeeded.
   */
  | { kind: 'gave_up'; attempts: number; failing: WorkItemDelivery[] }
  /** A fixing agent itself failed to run. Distinct from a give-up: the build was
   *  never re-tested, so reporting "five fixes did not work" would be false. */
  | { kind: 'fix_failed'; attempts: number; detail: string };

/**
 * A sign of life the watch writes to the RUN while it works (MOTIR-8979).
 *
 * ⚠️ WHY THE WATCH REPORTS AT ALL. The server decides a run in an agent (or a
 * hosted one) has STALLED from the latest run EVENT — the CLI's 60 s heartbeat is
 * not an event. Before this, a watch waiting on a slow build wrote nothing, so a
 * run whose pull request took more than 15 minutes of CI was ended `timed_out`
 * and its session killed — taking the fix loop that would have repaired a red
 * pull request with it. These events are what the stall clock reads in the CI
 * phase; in the agent phase it keeps reading the agent's own output, so an agent
 * that goes silent while it works still stalls.
 */
export type CiWatchEvent =
  /** CI is running, or is still running — `data.ci` says which. */
  | { kind: 'log'; data: { ci: 'pending' | 'waiting'; pending: number } }
  /** A fixing attempt is about to start. */
  | { kind: 'ci_fix_attempt'; data: { attempt: number; of: number; failing: string[] } };

/** How often a watch that is still waiting says so. A quarter of the 15-minute
 *  stall window would be wasteful; a third of it leaves two missed beats of room. */
export const CI_WAITING_EVENT_INTERVAL_MS = 5 * 60_000;

export interface CiWatchInput {
  client: Pick<MotirClient, 'getWorkItem'>;
  /** Where {@link CiWatchEvent}s go — the run's reporter, in a lane that has one. */
  onEvent?: (event: CiWatchEvent) => void;
  /** The clock the waiting cadence reads. Injected so a test does not wait. */
  now?: () => number;
  /** The card whose delivery set is watched. For `motir auto`, the run watches
   *  each card it carried in turn — the set is a property of the CARD. */
  key: string;
  /**
   * Run one fixing iteration against the failing deliveries. Returns whether the
   * agent ran successfully; the loop re-reads the verdict either way.
   *
   * Supplied by the LANE, because what a fixing iteration is differs by lane —
   * `run` and `batch` dispatch into the card's own checkout, `auto` into the
   * session's — and because a lane that cannot fix (a `--print` run) passes none.
   */
  fix: (failing: WorkItemDelivery[], attempt: number) => Promise<{ ok: boolean; detail?: string }>;
  /** Wait between polls while CI is still running. Injected so a test does not
   *  spend real seconds proving that pending does not consume the budget. */
  wait: () => Promise<void>;
  /** Progress, one line at a time. */
  report: (line: string) => void;
  /**
   * A bound on POLLS, not on fixes — the loop must not spin for ever against a
   * build that never reports. Distinct from {@link CI_FIX_ATTEMPTS} on purpose:
   * exhausting it is a give-up with ZERO fixes attempted, which is a different
   * thing to say than "five fixes did not work".
   */
  maxPolls?: number;
}

/** The default poll bound — generous, because a slow build is not a failure. */
const DEFAULT_MAX_POLLS = 240;

/**
 * WATCH the card's deliveries, FIXING each red verdict, until green or the cap.
 *
 * The counter increments on a RED verdict only, and it is per RUN — for `batch`,
 * per CARD, since each iteration is its own run. **Five reds across three
 * repositories exhausts it exactly as five in one repository does**; the
 * alternative reading would triple the budget on a multi-repository card, and
 * saying so is cheaper than discovering it.
 */
export async function watchAndFixCi(input: CiWatchInput): Promise<CiWatchOutcome> {
  const maxPolls = input.maxPolls ?? DEFAULT_MAX_POLLS;
  let reds = 0;
  let polls = 0;
  let lastReadError: string | null = null;
  // The queue heads the LAST fixing attempt was handed (MOTIR-5720), and how many
  // polls in a row since have shown them unchanged.
  let headsAtAttempt: Map<string, string> | null = null;
  let unchangedPolls = 0;
  // The last time the RUN heard from this watch (MOTIR-8979), and whether the
  // state it was told was `pending` — so a change is announced at once and a
  // steady wait is repeated on a cadence.
  const clock = input.now ?? Date.now;
  let lastEventAt = clock();
  let announcedPending = false;
  const emit = (event: CiWatchEvent): void => {
    lastEventAt = clock();
    try {
      input.onEvent?.(event);
    } catch {
      /* reporting observes the watch and may never change it */
    }
  };

  for (;;) {
    if (polls >= maxPolls) {
      const detail =
        lastReadError === null
          ? `CI never reported after ${polls} checks`
          : `could not read the work item after ${polls} attempts — ${lastReadError}`;
      input.report(`${input.key}: ${detail}.`);
      return { kind: 'fix_failed', attempts: reds, detail };
    }
    polls += 1;

    // ⚠️ A READ FAILURE IS RETRIED, NEVER THROWN. By the time this runs the work
    // is committed, pushed and reviewable; a network blip must not turn a
    // successful run into a crash. It counts against `maxPolls` like any other
    // poll, so a server that stays unreachable ends the watch rather than
    // spinning — and ends it as `fix_failed`, which exits non-zero, because "I
    // could not check the build" is a different claim from "the build is fine"
    // and the operator has to be able to tell them apart.
    let deliveries;
    try {
      deliveries = (await input.client.getWorkItem(input.key)).deliveries;
    } catch (err) {
      lastReadError = err instanceof Error ? err.message : String(err);
      await input.wait();
      continue;
    }
    const verdict = ciVerdict(deliveries);

    if (verdict === 'nothing') return { kind: 'nothing' };
    if (verdict === 'green') {
      input.report(
        reds === 0
          ? `${input.key}: CI is green.`
          : `${input.key}: CI is green after ${pluralize(reds, 'fix', 'fixes')}.`,
      );
      return { kind: 'green', attempts: reds };
    }
    if (verdict === 'pending') {
      const waiting = (deliveries ?? []).filter((d) => d.ci !== 'passing').length;
      if (!announcedPending) {
        announcedPending = true;
        emit({ kind: 'log', data: { ci: 'pending', pending: waiting } });
      } else if (clock() - lastEventAt >= CI_WAITING_EVENT_INTERVAL_MS) {
        emit({ kind: 'log', data: { ci: 'waiting', pending: waiting } });
      }
      await input.wait();
      continue;
    }
    announcedPending = false;

    // RED.
    const failing = failingDeliveries(deliveries);

    // ⚠️ DO NOT BURN FIVE ATTEMPTS ON NOTHING (MOTIR-5720). A queue failure whose
    // exit still names the head the last attempt saw means the agent pushed
    // nothing — there was nothing to change, which is the flaky-queue case. Four
    // more identical attempts would spend time and credits to learn the same
    // thing. The person's move is a new head — *Queue again* is not offered after a
    // queue failure (MOTIR-6594) — and the watch says so.
    if (queueRedUnchanged(failing, headsAtAttempt)) {
      unchangedPolls += 1;
      if (unchangedPolls >= UNCHANGED_POLLS_TO_STOP) {
        input.report(`${input.key}: ${NOTHING_TO_CHANGE_DETAIL}.`);
        return { kind: 'fix_failed', attempts: reds, detail: NOTHING_TO_CHANGE_DETAIL };
      }
      await input.wait();
      continue;
    }
    unchangedPolls = 0;

    if (reds >= CI_FIX_ATTEMPTS) {
      // THE SIXTH RED. The budget was spent on the five before it.
      input.report(
        `${input.key}: giving up after ${pluralize(reds, 'fixing attempt')} — ` +
          `still failing: ${failing.map((d) => `${d.repo}#${d.number}`).join(', ')}.`,
      );
      return { kind: 'gave_up', attempts: reds, failing };
    }

    reds += 1;
    input.report(
      `${input.key}: CI is red in ${failing.map((d) => `${d.repo}#${d.number}`).join(', ')} — ` +
        `fixing attempt ${reds} of ${CI_FIX_ATTEMPTS}.`,
    );
    emit({
      kind: 'ci_fix_attempt',
      data: { attempt: reds, of: CI_FIX_ATTEMPTS, failing: failing.map(deliveryId) },
    });
    headsAtAttempt = new Map(
      failing.flatMap((d) => (d.queueExit ? [[deliveryId(d), d.queueExit.headSha] as const] : [])),
    );
    const result = await input.fix(failing, reds);
    if (!result.ok) {
      // The fixing AGENT failed, which is not the same as the build failing five
      // times: the build was never re-tested, so reporting a give-up would be a
      // false statement about CI.
      input.report(`${input.key}: the fixing agent failed — ${result.detail ?? 'no detail'}.`);
      return { kind: 'fix_failed', attempts: reds, detail: result.detail ?? 'the agent failed' };
    }
    // The fix pushed, so CI restarts. Wait before re-reading, or the next poll
    // reads the verdict the fix was answering and burns an attempt on it.
    await input.wait();
  }
}

/**
 * The FIXING ITERATION's prompt.
 *
 * ⚠️ WHAT IT IS TOLD MATTERS AS MUCH AS WHAT IT IS GIVEN. This repository's
 * standing rule is *a failed test is DEBUGGED before it is re-run*, and an agent
 * handed a red check will confidently invent a fix for an environmental failure —
 * a connection reset, a webServer death, a cold-compile timeout. So the prompt
 * asks for the actual failure FIRST and explicitly permits changing nothing.
 *
 * ⚠️ An iteration that correctly changes NOTHING still counts toward the five,
 * and does not end the loop early. That is deliberate and it is what makes the
 * cap do the flake work: a genuine flake gets five fresh CI rolls, and an agent
 * that correctly declines to patch around one has still used a roll. Ending the
 * loop on a no-op would turn the single most common right answer into a give-up.
 *
 * ⚠️ IT SAYS WHAT TO DO FIRST, AND IT IS NOT READING THE LOG. A pull request's
 * checks run the branch MERGED with the branch it targets, so the failure being
 * described happened in a tree that exists nowhere in the checkout the fixing
 * agent stands in. Diagnosing before merging means diagnosing the wrong tree:
 * the named file can be a sibling's that landed on the base after this branch
 * started, the failure can be inherited and already repaired on the base, and
 * the at-most-one-file measurement the prompt does permit measures a
 * combination CI never judged. So step 1 is `git merge` the base — a merge,
 * never a rebase, the repository squash-merges anyway — and that merge is
 * pushed like any other iteration, which either turns the build green for free
 * or hands the next iteration an honest tree.
 *
 * ⚠️ AND IT SAYS WHAT NOT TO RUN, because the pull toward re-running is
 * strongest exactly here and it does not feel like waste — it feels like
 * checking your work. An agent handed a red suite naturally reaches for that
 * suite to confirm the fix, and in THIS loop that reach is not merely redundant
 * but structurally so: every fixing iteration pushes, every push re-triggers
 * CI, so the loop's next poll is already guaranteed to produce the verdict the
 * local run is trying to anticipate. The cost is paid three times over — an
 * attempt out of five is blocked while it runs, the machine is shared so a wide
 * run manufactures failures belonging to other sessions, and the copy it
 * produces is not merged with the default branch, so it is the weaker evidence.
 * Observed: a run whose CI named ONE file fixed that file, then ran 294 files to
 * check the blast radius, harvested five unrelated database-contention failures,
 * and began triaging them.
 *
 * The first-pass rule lives in `promptTemplate.ts` (`WHAT_TO_DO.code` step 4)
 * and is unchanged; this is the SECOND pass, which nothing covered.
 *
 * It is repair work on pull requests that already exist — NOT a new card. It
 * links nothing, claims nothing, and transitions nothing.
 *
 * ⚠️ BUT IT KEEPS HOW TO TEST TRUE (MOTIR-6065). How to test is written for the
 * WORK ITEM, not for a commit, and the item page no longer flags a record whose
 * commit the pull request has moved past. A fix that changes a step the record
 * describes — a migration, a seed, a flag, a click-path — is the one commit after
 * the handover that can make it wrong, and this agent is the only party that
 * knows, so it re-publishes. The pull request body's `## How to test` section is
 * where it reads the current text: it has no other read of the record.
 */
export function renderFixPrompt(input: {
  key: string;
  title: string | null;
  failing: readonly WorkItemDelivery[];
  attempt: number;
  /**
   * WHERE each failing pull request's branch is checked out, when the caller
   * made those checkouts itself — `motir fix` (MOTIR-5465), whose run began after
   * the run that pushed the branches had ended. Absent, the prompt is exactly
   * what `run` / `batch` / `auto` have always sent: their agent stands in the
   * checkout its own dispatch prompt arranged.
   */
  checkouts?: readonly FixCheckout[];
}): string {
  // WHAT to merge is the branch each pull request TARGETS, not the default
  // branch: a stacked pull request is based on its parent's branch and CI
  // merges it with THAT. One name when the failing set agrees, and a pointer to
  // the list above when it does not, because a wrong branch name here is worse
  // than none.
  const bases = [...new Set(input.failing.map((d) => d.baseRef ?? d.defaultBranch))];
  const mergeTarget =
    bases.length === 1 ? `origin/${bases[0]}` : "origin/<that pull request's base>";
  const lines: string[] = [];
  lines.push(`# Make the build pass — ${input.key}${input.title ? ` (${input.title})` : ''}`);
  lines.push('');
  lines.push(
    `CI is RED on work that is already committed and pushed. This is attempt ${input.attempt} of ${CI_FIX_ATTEMPTS}.`,
  );
  lines.push('');
  lines.push('## The failing pull requests');
  lines.push('');
  for (const d of input.failing) {
    lines.push(`- **${d.repo}#${d.number}** (base \`${d.baseRef ?? d.defaultBranch}\`) — ${d.url}`);
  }
  lines.push('');
  if (input.checkouts && input.checkouts.length > 0) {
    lines.push('## Where each branch is checked out');
    lines.push('');
    for (const c of input.checkouts) {
      lines.push(`- **${c.repo}** — branch \`${c.branch}\` at \`${c.path}\``);
    }
    lines.push('');
    lines.push('Work in those checkouts, on those branches. Each push updates its');
    lines.push('existing pull request.');
    lines.push('');
  }
  const ejected = input.failing.filter((d) => d.queueExit);
  if (ejected.length > 0) {
    lines.push('## Why it left the merge queue');
    lines.push('');
    lines.push('The merge queue tested these pull requests together with the work queued');
    lines.push('ahead of them and threw them out. Their OWN checks may well be green — the');
    lines.push('failure happened in the queue\u2019s merge commit, not on this branch alone.');
    lines.push('');
    for (const d of ejected) {
      const exit = d.queueExit!;
      const base = `origin/${d.baseRef ?? d.defaultBranch}`;
      lines.push(`- **${d.repo}#${d.number}** — ${queueReasonInWords(exit.rawReason)}`);
      if (exit.failingCheckName) {
        lines.push(
          `  - The queue\u2019s failing check: **${exit.failingCheckName}**` +
            (exit.failingCheckUrl ? ` — ${exit.failingCheckUrl}` : ''),
        );
      }
      if (exit.rawReason === 'MERGE_CONFLICT') {
        lines.push(`  - **Merge \`${base}\` into the branch, resolve the conflicts, run the`);
        lines.push('    checks the conflict touched, and push.** Only new commits clear a');
        lines.push('    conflict; *Queue again* will fail the same way until it is resolved.');
      } else if (exit.rawReason === 'CI_FAILURE' || exit.rawReason === 'CI_TIMEOUT') {
        lines.push(`  - **Reproduce the named check against the branch merged with \`${base}\`,**`);
        lines.push('    fix what it shows, and push.');
      }
      lines.push('  - **If nothing needs changing** (the queue\u2019s failure was flaky, or is');
      lines.push('    already fixed on the base), STILL PUSH: the merge of the base from step 1,');
      lines.push('    or an empty commit if that merge brought nothing. *Queue again* is not');
      lines.push('    offered after a queue failure, so only a new head whose checks go green');
      lines.push('    asks for approval again. Say in your summary that nothing needed changing.');
    }
    lines.push('');
  }
  lines.push('## What to do');
  lines.push('');
  lines.push('1. **MERGE THE LATEST BASE BRANCH FIRST — before you read anything as a');
  lines.push(`   diagnosis.** \`git fetch origin && git merge ${mergeTarget}\` in the`);
  lines.push('   checkout holding the branch. A MERGE, never a rebase.');
  lines.push('   **CI judges your branch MERGED with the branch it targets**, so the');
  lines.push('   failure you are about to read happened in a tree this checkout does');
  lines.push('   not have: the file the log names may be one that landed on the base');
  lines.push('   after this branch started, and the failure may be inherited rather');
  lines.push('   than yours. Build the combination CI judged, then diagnose against');
  lines.push('   it.');
  lines.push('   - **Push the merge like any other iteration.** It re-triggers CI, so');
  lines.push('     if the red was inherited and is already repaired on the base, the');
  lines.push('     merge alone turns the build green and nothing else is owed —');
  lines.push('     change nothing and say so.');
  lines.push('   - **A merge CONFLICT is your own work, and no check can report it.**');
  lines.push('     Resolve it here, in this iteration.');
  lines.push('2. **Read the ACTUAL failure first** — on the MERGED tree: the assertion,');
  lines.push('   the locator, the stack, the job log. Not the summary line, and not a');
  lines.push('   guess from the test name.');
  lines.push('3. **Decide what kind of failure it is.**');
  lines.push('   - **Caused by this branch** → fix it. Commit to the SAME branch and');
  lines.push('     push; the existing pull request picks it up. Open no new pull');
  lines.push('     request and link nothing — this is repair work on a pull request');
  lines.push('     that already exists.');
  lines.push('     **THE PUSH IS THE VERIFICATION.** This loop re-triggers CI on');
  lines.push('     every push, so the next verdict IS your confirmation — you do');
  lines.push('     not have to produce one. You may run AT MOST the single file');
  lines.push('     the log named, and only because it is seconds. NEVER the suite,');
  lines.push('     never a coverage run, and never a wider sweep to check that');
  lines.push('     nothing else broke: that is the same measurement taken twice,');
  lines.push('     the second time slower, on a shared machine, and NOT merged with');
  lines.push('     the base as CI will merge it at verdict time — so it is the');
  lines.push('     less trustworthy copy.');
  lines.push('   - **INHERITED** — the base branch is red on its own, or the log names');
  lines.push('     a file your diff never touched. Say so and change NOTHING here:');
  lines.push('     step 1 was the whole fix if there was one, and repairing somebody');
  lines.push("     else's red belongs in its own pull request, never folded into this");
  lines.push('     one.');
  lines.push('   - **ENVIRONMENTAL** — a connection reset, a runner or webServer death,');
  lines.push('     a first-hit cold-compile timeout, a different test failing each run —');
  lines.push('     then **say so and change NOTHING**. Pushing a speculative patch to');
  lines.push('     chase a flake makes the diff worse and hides the real signal.');
  lines.push('4. **Keep How to test true.** How to test belongs to the work item, not');
  lines.push('   to a commit. If a commit you push changes anything it describes — a');
  lines.push('   precondition, a setup, migrate or seed command, a click-path step —');
  lines.push(`   publish the whole corrected text with the ${HOW_TO_TEST_TOOL_NAME}`);
  lines.push(`   tool, on ${input.key} or on the item the pull request body's`);
  lines.push('   "## How to test" section says it was written onto, and update that');
  lines.push('   section of the body to match. The body shows you the current text. A');
  lines.push('   fix that changes none of them — the usual case — publishes nothing.');
  lines.push('5. Do not move the work item: leave its status, and record no');
  lines.push('   transition. The build decides when it moves.');
  lines.push('');
  lines.push('Changing nothing is a legitimate outcome and is sometimes the right one.');
  return lines.join('\n');
}

/** What an acceptance Re-run hands its agent (MOTIR-6502) — the shape `motir fix`
 *  receives on an `acceptance_rerun` claim, restated so this module stays free of the
 *  client's types. */
export interface AcceptanceRerunInput {
  key: string;
  title: string | null;
  refusal: { reasonMd: string | null; decidedByLabel: string | null; decidedAt: string };
  /** The story's open delivery — `owner/name`, number and URL. */
  pullRequests: ReadonlyArray<{ repo: string; number: number; url: string }>;
  checkouts: readonly FixCheckout[];
}

function renderRefusalQuote(refusal: AcceptanceRerunInput['refusal']): string[] {
  const who = refusal.decidedByLabel ?? 'The reviewer';
  const reason = refusal.reasonMd?.trim();
  const lines = [`${who} sent it back on ${refusal.decidedAt}, choosing **Re-run**:`, ''];
  if (reason) {
    for (const line of reason.split('\n')) lines.push(`> ${line}`);
  } else {
    lines.push('> (no reason was recorded)');
  }
  return lines;
}

function renderCheckoutList(checkouts: readonly FixCheckout[]): string[] {
  const lines = ['## Where each branch is checked out', ''];
  for (const c of checkouts)
    lines.push(`- **${c.repo}** — branch \`${c.branch}\` at \`${c.path}\``);
  lines.push('');
  lines.push('Work in those checkouts, on those branches. Each push updates its');
  lines.push('existing pull request.');
  return lines;
}

/**
 * THE RE-RUN PROMPT (Story MOTIR-6071 · MOTIR-6502; `acceptance-refusal-verdict.md` §4).
 *
 * A person watched the story's acceptance video and sent it back with **Re-run**: the
 * work is built, and something about it is not what they wanted — a colour, a layout,
 * an overflow. This is the one agent turn that answers them, on the SAME pull requests.
 *
 * ⚠️ IT IS A FIX, NOT A RESTART, AND THE PROMPT SAYS WHERE THE LINE IS. The verdict
 * the reviewer did NOT pick is Re-plan — a change to the story's shape — and an agent
 * handed a sentence of feedback will happily rebuild a feature around it. So anything
 * structural is refused in words: stop, change nothing, and say so, because that is a
 * Re-plan and it is the planner's.
 *
 * ⚠️ IT DOES NOT RECORD THE VIDEO. The recording is re-made only once CI is green on the
 * fixed work (the decision's order: fix, push, watch CI, then re-record), so `motir fix`
 * sends that as a CLOSING turn after the watch ({@link renderAcceptanceRecordPrompt}). A
 * video recorded now would show code the CI loop may still change.
 */
export function renderAcceptanceRerunPrompt(input: AcceptanceRerunInput): string {
  const lines: string[] = [];
  lines.push(
    `# Answer the acceptance review — ${input.key}${input.title ? ` (${input.title})` : ''}`,
  );
  lines.push('');
  lines.push('This story was run as a whole and its pull requests are open. A person watched');
  lines.push('its acceptance video and asked for a FIX to what was built.');
  lines.push('');
  lines.push('## What they said');
  lines.push('');
  lines.push(...renderRefusalQuote(input.refusal));
  lines.push('');
  lines.push('## The pull requests');
  lines.push('');
  for (const pr of input.pullRequests) lines.push(`- **${pr.repo}#${pr.number}** — ${pr.url}`);
  lines.push('');
  lines.push(...renderCheckoutList(input.checkouts));
  lines.push('');
  lines.push('## The scope');
  lines.push('');
  lines.push('A fix to the delivered work on these branches: what the reviewer saw and named.');
  lines.push('**Anything structural is a Re-plan, not a Re-run** — a new screen, a different');
  lines.push('flow, work another card owns, a change to what the story is for. If the reason');
  lines.push('asks for that, make NO commit, stop, and say so in one paragraph: the reviewer');
  lines.push('re-plans the story in Motir instead.');
  lines.push('');
  lines.push('## What to do');
  lines.push('');
  lines.push('1. **Merge each pull request\u2019s base branch first** (a merge, never a rebase),');
  lines.push('   so you change the tree CI will judge.');
  lines.push('2. **Find where the reviewer\u2019s complaint lives** — render or run the surface');
  lines.push('   they watched rather than reasoning from the code, and change the smallest thing');
  lines.push('   that answers it.');
  lines.push('3. **Keep the tests true.** Update or add the tests that cover what you changed.');
  lines.push('   Run ONLY the test files you touched, plus lint and typecheck — never the full');
  lines.push('   suite: the push re-runs CI, and that is the verdict.');
  lines.push('4. **Commit and push to the same branches.** Open no pull request, link nothing,');
  lines.push('   and move no status — the board stays where it is.');
  lines.push('5. **Do not record or publish the acceptance video.** Once CI is green on this');
  lines.push('   push, you will be asked to re-record it in a separate step.');
  lines.push('6. If the pull request body\u2019s `## How to test` no longer matches what a person');
  lines.push(`   does, publish it again with \`${HOW_TO_TEST_TOOL_NAME}\` on ${input.key}.`);
  return lines.join('\n');
}

/**
 * The checkout read that decides WHO publishes an acceptance receipt (MOTIR-7254) —
 * byte-identical to motir-core's dispatch prompt (`ACCEPTANCE_LANE_PUBLISHES_CHECK` in
 * `lib/dispatch/promptTemplate.ts`). This package cannot import the server's module, so
 * the string is repeated here and pinned by `acceptanceRerunPrompt.test.ts`. A file
 * printed ⇒ the repository's acceptance lane carries the uploader and publishes from a
 * green pull-request run (motir-core, starter-generated projects); nothing ⇒ no lane
 * publishes, and the agent does.
 */
export const ACCEPTANCE_LANE_PUBLISHES_CHECK =
  "grep -rlE 'uses:\\s*\\./\\.github/actions/upload-acceptance-video' .github/workflows/";

/**
 * THE CLOSING TURN of an acceptance Re-run (MOTIR-6502) — sent once CI is green on the
 * fixed work: get a fresh receipt for the fixed work onto the story, so a fresh
 * acceptance question is asked, with the merge beside it
 * (`acceptance-refusal-verdict.md` §3's release).
 *
 * WHO PUBLISHES IS A READ OF THE CHECKOUT (MOTIR-7254). Since MOTIR-7253 a repository
 * whose acceptance lane carries the `upload-acceptance-video` action publishes the
 * receipt from the green pull-request run itself — the run that made this turn possible
 * — so the agent there makes NO MCP publish: it confirms the spec is green and reports
 * that the lane published. Anywhere else nothing but this turn publishes: an agent that
 * records and does not publish leaves the story with no new question and its merge held
 * for ever, and the confirmation is the receipt id.
 */
export function renderAcceptanceRecordPrompt(input: AcceptanceRerunInput): string {
  const lines: string[] = [];
  lines.push(
    `# Re-record the acceptance video — ${input.key}${input.title ? ` (${input.title})` : ''}`,
  );
  lines.push('');
  lines.push('CI is green on the fix you pushed for this review:');
  lines.push('');
  lines.push(...renderRefusalQuote(input.refusal));
  lines.push('');
  lines.push(...renderCheckoutList(input.checkouts));
  lines.push('');
  lines.push('## What to do');
  lines.push('');
  lines.push('1. **Find out who publishes the receipt.** In the checkout that holds the');
  lines.push('   acceptance spec, run:');
  lines.push('');
  lines.push(`       ${ACCEPTANCE_LANE_PUBLISHES_CHECK}`);
  lines.push('');
  lines.push('   **If it prints a file**, that repository\u2019s acceptance lane publishes the');
  lines.push('   receipt itself, from the green pull-request run on the commit you pushed. Make');
  lines.push(
    '   NO MCP publish. Run the story\u2019s acceptance spec only to confirm it is green,',
  );
  lines.push(
    '   then report: \u201cthe repository\u2019s acceptance lane published the receipt on',
  );
  lines.push('   CI\u2019s green run; no MCP publish made\u201d, naming that run (its');
  lines.push(
    '   `Publish the acceptance receipt` step logs the receipt id). Steps 2\u20134 do not',
  );
  lines.push('   apply.');
  lines.push('');
  lines.push('   **If it prints nothing**, no lane publishes there, and steps 2\u20134 are yours.');
  lines.push("2. **Run the story's acceptance spec** (`tests/e2e/acceptance*.spec.ts`, the one");
  lines.push(`   that declares \`acceptanceStory('${input.key}')\`) on the acceptance lane, with`);
  lines.push('   recording on, so the clip shows the fixed work.');
  lines.push('3. **Publish it — two calls.** `create_acceptance_upload` with the card key mints a');
  lines.push(
    '   presigned PUT; PUT the clip\u2019s bytes to it (`Content-Type: video/webm`); then',
  );
  lines.push('   `publish_acceptance_result` with the pathname it returned, the chapters, the');
  lines.push('   commit sha you pushed, and the card key.');
  lines.push(
    '4. **Report the receipt id the publish returned.** Without it nothing was published,',
  );
  lines.push('   and the reviewer has nothing new to watch.');
  lines.push('');
  lines.push('Change no code in this step and move no status. If the spec goes red, publish');
  lines.push('nothing and say what failed: a red run records nothing.');
  return lines.join('\n');
}

/** What a card SENT BACK by a review hands its agent (MOTIR-6822) — the shape `motir fix`
 *  receives on a `review` claim, restated so this module stays free of the client's
 *  types. */
export interface ReviewFixInput {
  key: string;
  title: string | null;
  refusal: {
    gate: 'agent_review' | 'pull_request_approval';
    findingsMd: string | null;
    reviewerName: string | null;
    decidedAt: string;
  };
  /** The card's open delivery — `owner/name`, number and URL. */
  pullRequests: ReadonlyArray<{ repo: string; number: number; url: string }>;
  checkouts: readonly FixCheckout[];
}

/**
 * THE REVIEW-FIX PROMPT (Story MOTIR-1626 · MOTIR-6822; `approval-gates.md` §12.4, §12.7).
 *
 * A review of the card's pull requests asked for changes — the review agent's findings,
 * or a person's *Request changes* on the approve-and-merge gate. The checks are usually
 * green: the fix is to what the reviewer READ. This is the one agent turn that answers
 * them, on the SAME pull requests; the CI loop then runs unchanged on the push.
 *
 * ⚠️ THE FINDINGS ARE QUOTED IN FULL, NEVER SUMMARISED. They are the brief (§10h's row:
 * *the findings are the brief, and the repair is a fix, not a re-plan*), and a preview
 * cut to one line would hand the agent a fraction of what it was asked to fix.
 *
 * ⚠️ THE PUSH IS WHAT ANSWERS THE REVIEW. It moves a head, which withdraws the refusal
 * (§12.5), and the next green version is reviewed again. Nothing here decides a gate.
 */
export function renderReviewFixPrompt(input: ReviewFixInput): string {
  const { refusal } = input;
  const byAgent = refusal.gate === 'agent_review';
  const who = refusal.reviewerName ?? (byAgent ? 'The review agent' : 'The reviewer');
  const lines: string[] = [];
  lines.push(`# Answer the code review — ${input.key}${input.title ? ` (${input.title})` : ''}`);
  lines.push('');
  lines.push("This card's pull requests are open and its run has ended. A review of them");
  lines.push(
    byAgent
      ? 'by the REVIEW AGENT, against the card, sent the card back with findings.'
      : 'by a PERSON, on the approve-and-merge gate, sent the card back — Request changes.',
  );
  lines.push('');
  lines.push('## The findings');
  lines.push('');
  lines.push(`${who} sent it back on ${refusal.decidedAt}:`);
  lines.push('');
  const findings = refusal.findingsMd?.trim();
  if (findings) {
    for (const line of findings.split('\n')) lines.push(`> ${line}`);
  } else {
    lines.push('> (no findings were recorded)');
  }
  lines.push('');
  lines.push('## The pull requests');
  lines.push('');
  for (const pr of input.pullRequests) lines.push(`- **${pr.repo}#${pr.number}** — ${pr.url}`);
  lines.push('');
  lines.push(...renderCheckoutList(input.checkouts));
  lines.push('');
  lines.push('## The scope');
  lines.push('');
  lines.push('A fix to the delivered work on these branches: what the review named, measured');
  lines.push('against the card. **A defect the review found in the code these pull requests');
  lines.push(
    'deliver is yours to fix even when the fix goes beyond the card\u2019s text** \u2014 a gap',
  );
  lines.push('in what the card specified, a case it never named. Build the fix, and record it as');
  lines.push(
    `a discrepancy: ONE \`${DISCREPANCY_TOOL_NAME}\` call on ${input.key}, after you build and`,
  );
  lines.push('before you push, with one point per such fix as `{ planAsked, built, why }`. If you');
  lines.push('have no Motir tools and the environment variable MOTIR_AGENT_REPORT is set, put the');
  lines.push('same points into the JSON file at that path instead, as `"discrepancy"` beside');
  lines.push(
    '`"model"`. \u201cThe card did not ask for it\u201d is never a reason to leave such a finding',
  );
  lines.push('unfixed, and never a reason to call it out of scope.');
  lines.push('');
  lines.push(
    '**A finding that asks for a change to what the card is FOR** \u2014 work another card',
  );
  lines.push(
    'owns, a new surface, a different design \u2014 is not yours to build: leave it, and say',
  );
  lines.push('so in one paragraph naming the finding.');
  lines.push('');
  lines.push('## What to do');
  lines.push('');
  lines.push('1. **Merge each pull request\u2019s base branch first** (a merge, never a rebase),');
  lines.push('   so you change the tree CI will judge.');
  lines.push('2. **Address EVERY finding**, one by one — read the code it names, confirm it, and');
  lines.push('   change the smallest thing that answers it. A finding you judge wrong is answered');
  lines.push('   in words, with the evidence, never by silently skipping it.');
  lines.push('3. **Keep the tests true.** Update or add the tests that cover what you changed.');
  lines.push('   Run ONLY the test files you touched, plus lint and typecheck — never the full');
  lines.push('   suite: the push re-runs CI, and that is the verdict.');
  lines.push('4. **Commit and push to the same branches.** Open no pull request, link nothing,');
  lines.push('   decide no approval and move no status — the push withdraws the review, and the');
  lines.push('   next green version is reviewed again.');
  lines.push('5. If the pull request body\u2019s `## How to test` no longer matches what a person');
  lines.push(`   does, publish it again with \`${HOW_TO_TEST_TOOL_NAME}\` on ${input.key}.`);
  return lines.join('\n');
}

/** One failing pull request's branch, checked out where the fixing agent can
 *  reach it. */
export interface FixCheckout {
  /** `owner/name`. */
  repo: string;
  branch: string;
  path: string;
}

/**
 * THE LANE-FACING PHASE — watch, and dispatch a fixing agent on each red.
 *
 * One function for all three lanes, because the loop is the same everywhere and
 * only WHERE the fixing agent stands differs: `run` and `batch` put it in the
 * card's own checkout, `auto` in the session's. That is a `cwd`, not a lane.
 */
export interface CiWatchPhaseInput {
  client: Pick<MotirClient, 'getWorkItem'>;
  key: string;
  title: string | null;
  agent: ParsedAgentCommand;
  /**
   * The command that CONTINUES the watched run's conversation (MOTIR-9048). The lane
   * builds it (`resumeFixAgent`); the watch prefers it for every fixing attempt, so
   * the fix arrives in the session that built the branch. Absent ⇒ every attempt
   * starts `agent`, a fresh process, exactly as before.
   */
  resumeAgent?: ParsedAgentCommand;
  /** Where the fixing agent runs — the checkout holding the branch CI is red on. */
  cwd: string;
  /** Every branch's checkout, named in the prompt — `motir fix` only. */
  checkouts?: readonly FixCheckout[];
  report: (line: string) => void;
  /** Where the watch's run events go (MOTIR-8979). */
  onEvent?: (event: CiWatchEvent) => void;
  /** The fixing agent's output, teed into the run's log (MOTIR-8979). */
  onOutput?: (chunk: string) => void;
  runAgentFn?: (input: {
    command: ParsedAgentCommand;
    prompt: string;
    cwd: string;
    onOutput?: (chunk: string) => void;
  }) => Promise<AgentRunResult>;
  wait?: () => Promise<void>;
  maxPolls?: number;
}

/** How long to wait between polls. A build takes minutes; polling faster only
 *  spends API calls to learn the same thing. */
const POLL_INTERVAL_MS = 20_000;

const realWait = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, POLL_INTERVAL_MS);
  });

export async function runCiWatchPhase(input: CiWatchPhaseInput): Promise<CiWatchOutcome> {
  const runAgentFn = input.runAgentFn ?? defaultRunAgent;
  return watchAndFixCi({
    client: input.client,
    key: input.key,
    report: input.report,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    wait: input.wait ?? realWait,
    ...(input.maxPolls === undefined ? {} : { maxPolls: input.maxPolls }),
    fix: async (failing, attempt) => {
      // One line naming the form it is about to run — never a continuation it did not launch.
      input.report(
        input.resumeAgent
          ? `Fix attempt ${attempt}: continuing the run’s own agent session.`
          : `Fix attempt ${attempt}: starting a fresh agent (the run’s session is not resumable).`,
      );
      const result = await runAgentFn({
        command: input.resumeAgent ?? input.agent,
        prompt: renderFixPrompt({
          key: input.key,
          title: input.title,
          failing,
          attempt,
          ...(input.checkouts ? { checkouts: input.checkouts } : {}),
        }),
        cwd: input.cwd,
        ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      });
      return result.exitCode === 0
        ? { ok: true }
        : {
            ok: false,
            detail: result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`,
          };
    },
  });
}

/**
 * A merge-queue reason in words (MOTIR-5720) — the spellings
 * `lib/mergeQueue/queueExit.ts` recognises as failures, with the raw string as
 * the fallback. A small map HERE rather than an import: the CLI ships on its own
 * release train and cannot reach into the app's `lib/`, and a reason this build
 * has never heard of must still read as something.
 */
const QUEUE_REASON_WORDS: Readonly<Record<string, string>> = {
  CI_FAILURE: 'the queue\u2019s checks failed on the merge commit',
  CI_TIMEOUT: 'the queue\u2019s checks did not finish in time',
  MERGE_CONFLICT: 'it conflicts with work queued ahead of it',
  INVALID_MERGE_COMMIT: 'the queue could not build a merge commit for it',
  GIT_TREE_INVALID: 'the queue could not build a tree for it',
  BRANCH_PROTECTIONS: 'a branch protection rule the queue could not satisfy',
};

export function queueReasonInWords(rawReason: string): string {
  return QUEUE_REASON_WORDS[rawReason] ?? `the queue removed it (${rawReason})`;
}
