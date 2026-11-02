#!/usr/bin/env node
/**
 * Tell a named person when the acceptance nightly on `main` did not go green
 * (MOTIR-10277).
 *
 * Called by `.github/workflows/acceptance-nightly-notify.yml` on
 * `workflow_run: completed` for `Acceptance tests`:
 *
 *   RUN_ID=<id> NOTIFY_LOGIN=<login> GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/name \
 *     node scripts/notify-acceptance-nightly.mjs
 *
 * WHAT IT DECIDES, and why a dispatched run never notifies: see
 * `scripts/acceptanceNightlyNotify.mjs`, which holds every decision and the issue
 * text, and is the file with the tests. This runner does the I/O only — read the
 * run, read the last green nightly, open or comment on the one labelled issue,
 * print.
 *
 * ⚠️ IT READS THE RUN AGAIN rather than trusting the event payload, so the
 * decision is made on the run as GitHub reports it now — the same rule
 * `scripts/retry-main-ci.mjs` follows.
 *
 * ⚠️ A MISSING RANGE NEVER COSTS THE SIGNAL. If the last green nightly cannot be
 * read, the issue still opens and says so. If the named person cannot be
 * assigned, the issue still opens and mentions them in its body instead.
 *
 * ENV: `RUN_ID`, `NOTIFY_LOGIN`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY` (required);
 * `GITHUB_API_URL`, `GITHUB_SERVER_URL`, `DEFAULT_BRANCH` (`main`),
 * `GITHUB_STEP_SUMMARY` — optional.
 *
 * EXIT CODES: 0 nothing to tell · 1 a red night, and the person was told
 * · 2 usage · 3 blind (the run could not be read, or the issue could not be written).
 */
/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import { appendFileSync } from 'node:fs';
import {
  EXIT_BLIND,
  EXIT_OK,
  EXIT_RED,
  EXIT_USAGE,
  ISSUE_TITLE,
  SIGNAL_LABEL,
  decideNotify,
  lastGreenNightly,
  nightBody,
} from './acceptanceNightlyNotify.mjs';

const env = process.env;
const API = (env['GITHUB_API_URL'] || 'https://api.github.com').replace(/\/$/, '');
const SERVER = (env['GITHUB_SERVER_URL'] || 'https://github.com').replace(/\/$/, '');
const REPO = env['GITHUB_REPOSITORY'] ?? '';
const TOKEN = env['GITHUB_TOKEN'] ?? '';
const RUN_ID = env['RUN_ID'] ?? '';
const LOGIN = (env['NOTIFY_LOGIN'] ?? '').trim();
const DEFAULT_BRANCH = env['DEFAULT_BRANCH'] || 'main';

const summary = [];
const report = (line) => {
  console.log(line);
  summary.push(line);
};

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = new Error(
      `${method} ${path} → ${res.status} ${json?.message ?? text.slice(0, 200)}`,
    );
    error.status = res.status;
    throw error;
  }
  return json;
}

async function readLastGreen(run) {
  const query = new URLSearchParams({
    event: 'schedule',
    status: 'success',
    branch: DEFAULT_BRANCH,
    per_page: '30',
  });
  const page = await gh(
    'GET',
    `/repos/${REPO}/actions/workflows/${run.workflow_id}/runs?${query.toString()}`,
  );
  return lastGreenNightly(page?.workflow_runs ?? [], run, DEFAULT_BRANCH);
}

async function ensureLabel() {
  try {
    await gh('POST', `/repos/${REPO}/labels`, {
      name: SIGNAL_LABEL,
      color: 'd73a4a',
      description: 'The scheduled acceptance run on main did not go green (MOTIR-10277)',
    });
  } catch (error) {
    // 422 means the label already exists.
    if (error.status !== 422) throw error;
  }
}

async function raiseSignal(night) {
  await ensureLabel();
  const open = await gh(
    'GET',
    `/repos/${REPO}/issues?state=open&labels=${SIGNAL_LABEL}&per_page=100`,
  );
  // The issues endpoint lists pull requests too; a labelled PR is not the thread.
  const existing = (open ?? []).filter((i) => !i.pull_request)[0];
  if (existing) {
    // The person was assigned or mentioned when it was opened, so the comment
    // notifies them as a participant and names nobody again.
    await gh('POST', `/repos/${REPO}/issues/${existing.number}/comments`, {
      body: nightBody({ ...night, assigned: null }),
    });
    return { url: existing.html_url, how: 'commented' };
  }
  try {
    const created = await gh('POST', `/repos/${REPO}/issues`, {
      title: ISSUE_TITLE,
      body: nightBody({ ...night, assigned: true }),
      labels: [SIGNAL_LABEL],
      assignees: [LOGIN],
    });
    return { url: created.html_url, how: 'opened' };
  } catch (error) {
    if (error.status !== 422) throw error;
    // A login that cannot be assigned must not cost the signal itself: open it
    // unassigned, and let a mention in the body do the notifying.
    const created = await gh('POST', `/repos/${REPO}/issues`, {
      title: ISSUE_TITLE,
      body: nightBody({ ...night, assigned: false }),
      labels: [SIGNAL_LABEL],
    });
    return { url: created.html_url, how: 'opened unassigned' };
  }
}

async function main() {
  if (!RUN_ID || !REPO || !TOKEN || !LOGIN) {
    console.error('::error::RUN_ID, NOTIFY_LOGIN, GITHUB_REPOSITORY and GITHUB_TOKEN are required');
    return EXIT_USAGE;
  }

  let run;
  try {
    run = await gh('GET', `/repos/${REPO}/actions/runs/${RUN_ID}`);
  } catch (error) {
    console.error(`::error::Could not read the run ${RUN_ID}: ${error.message}`);
    return EXIT_BLIND;
  }

  report(`run: ${run.html_url} (${run.event}, ${run.status}, ${run.conclusion})`);
  const decision = decideNotify({
    workflowName: run.name,
    event: run.event,
    headBranch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    defaultBranch: DEFAULT_BRANCH,
  });
  report(`decision: ${decision.action} — ${decision.reason}`);
  if (decision.action === 'skip') return EXIT_OK;

  let lastGreen = null;
  let lastGreenError;
  try {
    lastGreen = await readLastGreen(run);
  } catch (error) {
    lastGreenError = error.message;
    console.log(`::warning::Could not read the last green nightly: ${error.message}`);
  }
  report(
    lastGreen
      ? `last green nightly: ${lastGreen.htmlUrl} at ${lastGreen.headSha}`
      : `last green nightly: ${lastGreenError ? 'unreadable' : 'none on record'}`,
  );

  const night = {
    serverUrl: SERVER,
    repository: REPO,
    runUrl: run.html_url,
    headSha: run.head_sha,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    lastGreen,
    lastGreenError,
    login: LOGIN,
  };
  try {
    const { url, how } = await raiseSignal(night);
    report(`signal: ${how} ${url}`);
    console.error(`::error::The acceptance nightly finished ${run.conclusion} — ${url}`);
    return EXIT_RED;
  } catch (error) {
    console.error(
      `::error::The acceptance nightly finished ${run.conclusion}, and the issue could not be written: ${error.message}`,
    );
    return EXIT_BLIND;
  }
}

const code = await main();
if (env['GITHUB_STEP_SUMMARY']) {
  appendFileSync(
    env['GITHUB_STEP_SUMMARY'],
    ['### Acceptance nightly — notification', '', '```', ...summary, '```', ''].join('\n'),
  );
}
process.exit(code);
