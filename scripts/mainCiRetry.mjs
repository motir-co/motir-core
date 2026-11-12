/**
 * The LOGIC half of `scripts/retry-main-ci.mjs` (MOTIR-4607).
 *
 * WHAT IT ANSWERS: a `CI` run on `main` has just finished without going green —
 * should it be re-attempted, and once it has been, is the result something a
 * person has to be told about?
 *
 * ⚠️ WHY IT EXISTS AT ALL. Since MOTIR-10935 the push-to-`main` run of `ci.yml`
 * releases nothing (`aws-deploy.yml` ships the services on its own trigger). It
 * is the TRIPWIRE a merge that bypassed the queue meets — `lint`, `typecheck`,
 * `build` over the commit that is now `main` — and its red is nobody's: no pull
 * request carries it, and nothing notifies the person who merged. A red there is
 * either a broken tree or a flake, and they look the same. So the run is
 * re-attempted ONCE, and only a second red at `main`'s head is raised to a person
 * (MOTIR-11060 re-purposed the lane; MOTIR-4607 built it to reach the retired Fly
 * deploy, whose red push runs sat until somebody else happened to merge).
 *
 * ⚠️ THE BOUND IS `run_attempt`, AND IT IS STRUCTURAL, NOT A COUNTER. GitHub's
 * `workflow_run` documentation says of its activity types that "The `requested`
 * activity type does not occur when a workflow is re-run" — which singles out
 * `requested` and leaves `completed` firing on a re-run. So a lane that re-runs
 * on `completed` is re-triggered by its own re-run, and a lane with no bound is a
 * loop whose symptom is a rising CI bill rather than an error. The bound is
 * therefore read off the RUN, which GitHub increments on every re-run and nobody
 * else writes: attempt 1 may be re-run, attempt 2 or later never is. There is no
 * state anywhere to lose or to race.
 *
 * ⚠️ AND IT NEVER RE-RUNS A RUN WHOSE COMMIT IS NO LONGER THE HEAD OF `main`.
 * GitHub's re-run documentation: "The workflow will also use the same
 * `GITHUB_SHA` (commit SHA) and `GITHUB_REF` (git ref) of the original event".
 * A re-run of an old run re-checks a tree `main` no longer is: the newer push
 * run's tripwire already covers these commits, and this lane runs for it if it
 * goes red. So "superseded" is the correct no-op, and it never opens an issue
 * against code `main` has moved past.
 *
 * Same arrangement as `scripts/deployFreshness.mjs`: the runner reads the GitHub
 * API, POSTs, polls and `process.exit`s, none of which a test can call.
 * Everything in THIS module is pure, so every branch below has a deliberate
 * negative in `tests/scripts/retry-main-ci.test.ts`.
 */

export const EXIT_OK = 0;
/** The run failed twice at the head of `main` — the signal has been raised. */
export const EXIT_FAILED_TWICE = 1;
export const EXIT_USAGE = 2;
/** The instrument could not see: an API read failed, or the re-run never finished. */
export const EXIT_BLIND = 3;

/** Conclusions that mean the run produced a verdict nobody needs to act on. */
const GREEN = new Set(['success', 'neutral', 'skipped']);

/**
 * Conclusions with NO failed job to target, so `rerun-failed-jobs` is the wrong
 * endpoint and the whole run is re-run instead. A cancelled push run on `main` is
 * almost always a pending run superseded by a newer merge (the concurrency
 * group holds one pending run and cancels the previous one), and that case is
 * already caught by the head check before this set is consulted.
 */
const WHOLE_RUN = new Set(['cancelled', 'startup_failure']);

/** The label every failed-twice issue carries, so repeats land on one issue. */
export const SIGNAL_LABEL = 'main-ci-failed-twice';

/**
 * Decide what to do with a finished `CI` run. Takes what was READ — the run as
 * the API reports it now, and `main`'s head as the API reports it now — never the
 * event payload alone, which describes the run as it stood when the event fired.
 *
 * @param {{
 *   workflowName: string,
 *   event: string,
 *   headBranch: string,
 *   conclusion: string | null,
 *   runAttempt: number,
 *   headSha: string,
 *   mainHeadSha: string,
 * }} run
 * @returns {{ action: 'skip' | 'rerun', reason: string, mode?: 'failed' | 'all' }}
 */
export function decideRetry(run) {
  if (run.workflowName !== 'CI') {
    return { action: 'skip', reason: `not the CI workflow (${run.workflowName})` };
  }
  if (run.event !== 'push' || run.headBranch !== 'main') {
    // Only the push run is the tripwire nobody owns. A red pull-request or
    // merge-queue run is its author's to read, and re-running it here would hide
    // a real red.
    return {
      action: 'skip',
      reason: `not a push to main (${run.event} on ${run.headBranch})`,
    };
  }
  if (run.conclusion === null || GREEN.has(run.conclusion)) {
    return { action: 'skip', reason: `nothing to retry (conclusion ${run.conclusion})` };
  }
  if (!Number.isInteger(run.runAttempt) || run.runAttempt < 1) {
    return { action: 'skip', reason: `unreadable run_attempt (${run.runAttempt})` };
  }
  // ⚠️ THE LOOP BOUND. Checked BEFORE the head, so no other answer can reach a
  // re-run of a run that has already been re-run once.
  if (run.runAttempt > 1) {
    return {
      action: 'skip',
      reason: `already re-attempted (attempt ${run.runAttempt}) — never re-run twice`,
    };
  }
  if (run.headSha !== run.mainHeadSha) {
    return {
      action: 'skip',
      reason:
        `superseded — main is at ${short(run.mainHeadSha)}, this run built ${short(run.headSha)}; ` +
        'the newer push run checks these commits, and re-running this one would check a tree main no longer is',
    };
  }
  return {
    action: 'rerun',
    mode: WHOLE_RUN.has(run.conclusion) ? 'all' : 'failed',
    reason: `attempt 1 finished ${run.conclusion} at the head of main`,
  };
}

/**
 * Judge the re-attempt once it has completed.
 *
 * @param {{ conclusion: string | null, runAttempt: number, headSha: string, mainHeadSha: string }} run
 * @returns {{ outcome: 'recovered' | 'superseded' | 'failed-twice', reason: string }}
 */
export function judgeRetry(run) {
  if (run.conclusion !== null && GREEN.has(run.conclusion)) {
    return {
      outcome: 'recovered',
      reason: `attempt ${run.runAttempt} finished ${run.conclusion} — a SECOND-attempt green`,
    };
  }
  if (run.headSha !== run.mainHeadSha) {
    // A newer merge landed while the re-attempt ran. Its own push run carries
    // these commits, and if IT fails, this lane runs for it too.
    return {
      outcome: 'superseded',
      reason: `attempt ${run.runAttempt} finished ${run.conclusion}, but main has moved on to ${short(run.mainHeadSha)}`,
    };
  }
  return {
    outcome: 'failed-twice',
    reason: `attempt ${run.runAttempt} finished ${run.conclusion} at the head of main — main is red`,
  };
}

/** The issue title is keyed on the commit, so a repeat for the same head comments rather than duplicating. */
export function issueTitle(headSha) {
  return `CI on main failed twice at ${short(headSha)}`;
}

export function issueBody({ runUrl, headSha, firstConclusion, secondConclusion, actor }) {
  return [
    `The push-to-\`main\` CI run for \`${headSha}\` did not go green, was re-attempted once automatically, and failed again.`,
    '',
    `- run: ${runUrl}`,
    `- attempt 1: \`${firstConclusion}\``,
    `- attempt 2: \`${secondConclusion}\``,
    `- merged by: @${actor}`,
    '',
    '**`main` is red at this commit**: the push run is the lint, type-check and build tripwire, ' +
      'the only check a merge that bypassed the queue gets, and it failed twice. ' +
      'Nothing will retry it again: the retry lane (`.github/workflows/main-ci-retry.yml`) ' +
      're-attempts a run at most once. Read the failing job, fix `main` or re-run it by hand, ' +
      'then close this issue.',
    '',
    '_Opened by `scripts/retry-main-ci.mjs` (MOTIR-4607)._',
  ].join('\n');
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 8) : String(sha));
