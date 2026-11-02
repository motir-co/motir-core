/**
 * The LOGIC half of `scripts/notify-acceptance-nightly.mjs` (MOTIR-10277).
 *
 * WHAT IT ANSWERS: an `Acceptance tests` run has just finished — is it a night
 * a person has to be told about, and what does the issue that tells them say?
 *
 * ⚠️ WHY A NIGHTLY OWES A PERSON, NOT A RED CHECK. The full acceptance and
 * regression lanes stopped running on every push to `main` and run once a day
 * instead (MOTIR-9412 decided it). A scheduled run's red attaches to a commit
 * nobody is looking at: MOTIR-3850's `sandbox-staleness` lane failed every
 * scheduled run for 17 days and nobody was told. Moving the trigger without a
 * notification would have been worse than the per-merge run it replaced, so the
 * two ship together.
 *
 * WHAT COUNTS AS RED. Every completed SCHEDULED run whose conclusion is not
 * `success` — failed, cancelled, timed out, failed to start, and any other
 * conclusion GitHub adds. A night with no verdict is the same silent gap as a
 * red nobody read, which is also what lets the verification card (MOTIR-10278)
 * force the signal by cancelling a nightly rather than by shipping a kill switch.
 *
 * WHAT DOES NOT. A green night tells nobody. A DISPATCHED run tells nobody,
 * whatever its conclusion: whoever started it is watching it, and bisecting a
 * red range is a string of dispatches, several of which are red by design. A
 * pull-request or merge-queue run is its author's to read.
 *
 * ONE ISSUE FOR A RED STREAK. Every red night lands on the single OPEN issue
 * labelled `acceptance-nightly-red` — the first opens it, each later one
 * comments on it — so a lane that stays red is one thread that keeps notifying.
 * A green night does not close it: closing is the person's decision that the
 * break is understood.
 *
 * Same arrangement as `scripts/mainCiRetry.mjs`: the runner reads the GitHub API
 * and `process.exit`s, none of which a test can call. Everything in THIS module
 * is pure, so every branch below has a case in
 * `tests/scripts/notify-acceptance-nightly.test.ts`.
 */

export const EXIT_OK = 0;
/** The night was not green and a person has been told. */
export const EXIT_RED = 1;
export const EXIT_USAGE = 2;
/** The instrument could not see or could not write: nobody was told. */
export const EXIT_BLIND = 3;

/** The workflow this notifier watches — `acceptance-tests.yml`'s `name:`. */
export const WATCHED_WORKFLOW = 'Acceptance tests';

/** The label every red-night issue carries, so a streak lands on one issue. */
export const SIGNAL_LABEL = 'acceptance-nightly-red';

/** The issue a red streak lives on. One title, because one issue is open at a time. */
export const ISSUE_TITLE = 'The acceptance nightly on main is not green';

/**
 * Decide whether a finished run is a night a person must hear about. Takes the
 * run as the API reports it now, never the event payload alone.
 *
 * @param {{
 *   workflowName: string,
 *   event: string,
 *   headBranch: string,
 *   status: string,
 *   conclusion: string | null,
 *   defaultBranch: string,
 * }} run
 * @returns {{ action: 'skip' | 'notify', reason: string }}
 */
export function decideNotify(run) {
  if (run.workflowName !== WATCHED_WORKFLOW) {
    return { action: 'skip', reason: `not the ${WATCHED_WORKFLOW} workflow (${run.workflowName})` };
  }
  if (run.event !== 'schedule') {
    // A dispatch is watched by whoever started it; a PR or queue run by its author.
    return { action: 'skip', reason: `not a scheduled run (${run.event})` };
  }
  if (run.headBranch !== run.defaultBranch) {
    return {
      action: 'skip',
      reason: `not a run on ${run.defaultBranch} (${run.headBranch})`,
    };
  }
  if (run.status !== 'completed' || run.conclusion === null || run.conclusion === undefined) {
    return { action: 'skip', reason: `not finished (status ${run.status})` };
  }
  if (run.conclusion === 'success') {
    return { action: 'skip', reason: 'the night went green' };
  }
  return { action: 'notify', reason: `the night finished ${run.conclusion}` };
}

/**
 * Pick the last GREEN nightly before this run from a list of runs, newest
 * first, as `GET …/workflows/{id}/runs?event=schedule&status=success` answers.
 * The filter is re-applied here rather than trusted, so a run that is not a
 * green scheduled run on the default branch never becomes the range's start.
 *
 * @param {Array<{ id: number, event: string, head_branch: string, conclusion: string | null,
 *   head_sha: string, html_url: string, created_at: string }>} runs
 * @param {{ id: number, created_at: string }} current
 * @param {string} defaultBranch
 * @returns {{ headSha: string, htmlUrl: string, createdAt: string } | null}
 */
export function lastGreenNightly(runs, current, defaultBranch) {
  const green = (runs ?? []).filter(
    (r) =>
      r.id !== current.id &&
      r.event === 'schedule' &&
      r.head_branch === defaultBranch &&
      r.conclusion === 'success' &&
      Date.parse(r.created_at) < Date.parse(current.created_at),
  );
  green.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const last = green[0];
  return last
    ? { headSha: last.head_sha, htmlUrl: last.html_url, createdAt: last.created_at }
    : null;
}

/**
 * The text of one red night — the body of the issue the first one opens, and
 * of the comment each later one adds.
 *
 * @param {{
 *   serverUrl: string,
 *   repository: string,
 *   runUrl: string,
 *   headSha: string,
 *   conclusion: string,
 *   createdAt: string,
 *   lastGreen: { headSha: string, htmlUrl: string, createdAt: string } | null,
 *   lastGreenError?: string,
 *   login: string,
 *   assigned: boolean | null,
 * }} night
 */
export function nightBody(night) {
  const range = rangeLines(night);
  // `true`: the issue is assigned, which notifies without a mention. `false`: the
  // assignment was refused, so the mention is the notification. `null`: a
  // comment on the open thread, which notifies everyone on it already.
  const person =
    night.assigned === null
      ? []
      : night.assigned
        ? [`- assigned to: \`${night.login}\``]
        : [`- @${night.login} — the assignment was refused, so this mention is the notification`];
  return [
    `The scheduled run of the full acceptance and regression lanes on \`main\` did not go green.`,
    '',
    `- run: ${night.runUrl}`,
    `- conclusion: \`${night.conclusion}\``,
    `- commit: \`${night.headSha}\` (night of ${night.createdAt})`,
    ...person,
    '',
    '**What changed since the last green night**',
    '',
    ...range,
    '',
    '**Narrowing it down.** GitHub dispatches a workflow on a branch or tag, not on a commit, ' +
      'so push a branch at the commit you want to try and run the lane on it:',
    '',
    '```sh',
    'git push origin <sha>:refs/heads/bisect/acceptance-<sha>',
    'gh workflow run acceptance-tests.yml --ref bisect/acceptance-<sha>',
    '```',
    '',
    'Dispatches at different commits run side by side, and a dispatched run notifies nobody. ' +
      'Delete the `bisect/*` branches when you are done.',
    '',
    'Every further red night comments here. A green night does not close this issue: close it ' +
      'when the break is understood.',
    '',
    '_Opened by `scripts/notify-acceptance-nightly.mjs` (MOTIR-10277)._',
  ].join('\n');
}

function rangeLines(night) {
  if (night.lastGreenError) {
    return [
      `The last green nightly could not be read (${night.lastGreenError}), so no range is given. ` +
        `Compare this run's commit against the last green run on the workflow's page.`,
    ];
  }
  if (!night.lastGreen) {
    return [
      'There is no green nightly on record yet, so there is no range to compare against: ' +
        'every commit up to this one is a candidate.',
    ];
  }
  const compare = `${night.serverUrl}/${night.repository}/compare/${night.lastGreen.headSha}...${night.headSha}`;
  return [
    `- last green nightly: ${night.lastGreen.htmlUrl} at \`${night.lastGreen.headSha}\` (${night.lastGreen.createdAt})`,
    `- the range: ${compare}`,
  ];
}
