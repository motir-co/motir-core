import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  EXIT_BLIND,
  EXIT_FAILED_TWICE,
  EXIT_OK,
  SIGNAL_LABEL,
  decideRetry,
  issueBody,
  issueTitle,
  judgeRetry,
} from '../../scripts/mainCiRetry.mjs';

// MOTIR-4607, re-purposed by MOTIR-11060 — the push-to-`main` CI run releases
// nothing any more (`aws-deploy.yml` ships the services); it is the tripwire a
// merge that bypassed the queue meets, and its red is nobody's. So a red or
// cancelled push run is re-attempted once, and only a second red is raised.
//
// Three properties matter, and each is DEMONSTRATED here rather than asserted:
//
//   1. It cannot loop. The runner is driven against a fake GitHub API: a red run
//      is re-run exactly once, and the attempt-2 `workflow_run` event that a
//      re-run delivers is fed straight back in and produces ZERO writes.
//   2. It never re-runs a run whose commit is no longer `main`'s head — that
//      would re-check a tree `main` no longer is, and the newer push run
//      already checks these commits.
//   3. A run that fails twice raises a signal that is not a red check: an issue,
//      assigned to whoever merged, deduplicated per commit.

const ROOT = process.cwd();
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const RUN_ID = 4242;

const base = {
  workflowName: 'CI',
  event: 'push',
  headBranch: 'main',
  conclusion: 'failure',
  runAttempt: 1,
  headSha: HEAD,
  mainHeadSha: HEAD,
};

describe('decideRetry — whether a finished CI run is re-attempted', () => {
  it('re-runs the FAILED jobs of a red first attempt at the head of main', () => {
    expect(decideRetry(base)).toMatchObject({ action: 'rerun', mode: 'failed' });
    expect(decideRetry({ ...base, conclusion: 'timed_out' })).toMatchObject({ mode: 'failed' });
  });

  it('re-runs the WHOLE run when it was cancelled — there is no failed job to target', () => {
    expect(decideRetry({ ...base, conclusion: 'cancelled' })).toMatchObject({
      action: 'rerun',
      mode: 'all',
    });
    expect(decideRetry({ ...base, conclusion: 'startup_failure' })).toMatchObject({ mode: 'all' });
  });

  it('NEVER re-runs an attempt after the first, whatever its conclusion — the loop bound', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'startup_failure']) {
      for (const runAttempt of [2, 3, 50]) {
        const decision = decideRetry({ ...base, conclusion, runAttempt });
        expect(decision.action).toBe('skip');
        expect(decision.reason).toContain('already re-attempted');
      }
    }
  });

  it('checks the attempt bound BEFORE the head, so no other branch can reach a second re-run', () => {
    // A superseded attempt-2 run must report the BOUND, not the supersession —
    // proof the bound is not an afterthought that a later check could bypass.
    const decision = decideRetry({ ...base, runAttempt: 2, mainHeadSha: OLDER });
    expect(decision.reason).toContain('already re-attempted');
  });

  it('skips a run whose commit is no longer the head of main — the newer push run checks it', () => {
    const decision = decideRetry({ ...base, headSha: OLDER });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('superseded');
    expect(decision.reason).toContain('the newer push run checks these commits');
  });

  it('leaves pull-request and merge-queue runs alone — only the push run is the unowned tripwire', () => {
    expect(decideRetry({ ...base, event: 'pull_request' }).action).toBe('skip');
    expect(decideRetry({ ...base, event: 'merge_group' }).action).toBe('skip');
    expect(decideRetry({ ...base, headBranch: 'feature' }).action).toBe('skip');
  });

  it('ignores a green run and a run of any other workflow', () => {
    for (const conclusion of ['success', 'skipped', 'neutral', null]) {
      expect(decideRetry({ ...base, conclusion }).action).toBe('skip');
    }
    expect(decideRetry({ ...base, workflowName: 'CI on main — retry once' }).action).toBe('skip');
  });

  it('refuses an unreadable run_attempt rather than treating it as a first attempt', () => {
    expect(decideRetry({ ...base, runAttempt: Number.NaN }).action).toBe('skip');
    expect(decideRetry({ ...base, runAttempt: 0 }).action).toBe('skip');
  });
});

describe('judgeRetry — what the re-attempt means', () => {
  const after = { conclusion: 'failure', runAttempt: 2, headSha: HEAD, mainHeadSha: HEAD };

  it('names a second-attempt green as such, distinguishable from a first-attempt green', () => {
    const verdict = judgeRetry({ ...after, conclusion: 'success' });
    expect(verdict.outcome).toBe('recovered');
    expect(verdict.reason).toContain('SECOND-attempt green');
  });

  it('is FAILED TWICE when attempt 2 is red at the head of main', () => {
    expect(judgeRetry(after).outcome).toBe('failed-twice');
    expect(judgeRetry({ ...after, conclusion: 'cancelled' }).outcome).toBe('failed-twice');
  });

  it('is SUPERSEDED, not failed twice, when main moved on while attempt 2 ran', () => {
    expect(judgeRetry({ ...after, mainHeadSha: OLDER }).outcome).toBe('superseded');
  });
});

// MOTIR-11060 — ci.yml's push run deploys nothing since MOTIR-10935, so no text
// the lane writes may tell a person that a red run left commits undeployed.
describe('the signal says what a red push run means now — main is red, not undeployed', () => {
  const body = issueBody({
    runUrl: 'https://github.com/acme/app/actions/runs/1',
    headSha: HEAD,
    firstConclusion: 'failure',
    secondConclusion: 'failure',
    actor: 'merger',
  });

  it('titles the issue by commit and names the tripwire in its body', () => {
    expect(issueTitle(HEAD)).toBe(`CI on main failed twice at ${HEAD.slice(0, 8)}`);
    expect(body).toContain('`main` is red at this commit');
    expect(body).toContain('tripwire');
    expect(body).toContain('- merged by: @merger');
  });

  it('claims no deploy anywhere — not in the title, the body or a verdict reason', () => {
    const reasons = [
      decideRetry({ ...base, headSha: OLDER }).reason,
      judgeRetry({ conclusion: 'failure', runAttempt: 2, headSha: HEAD, mainHeadSha: HEAD }).reason,
    ];
    for (const text of [issueTitle(HEAD), body, ...reasons]) {
      expect(text).not.toMatch(/deploy/i);
    }
  });
});

// ── The runner, against a fake GitHub API ─────────────────────────────────────

type Call = { method: string; path: string; body: unknown };

interface FakeState {
  run: { run_attempt: number; status: string; conclusion: string | null; head_sha: string };
  mainHead: string;
  /** Conclusion attempt 2 finishes with once a re-run is POSTed. */
  secondConclusion: string;
  /** When set, attempt 2 starts and never completes. */
  stall?: boolean;
  openIssues: { number: number; title: string; html_url: string }[];
  calls: Call[];
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function fakeGitHub(state: FakeState): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      const method = req.method ?? 'GET';
      state.calls.push({ method, path, body: raw ? JSON.parse(raw) : null });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const runPath = `/repos/acme/app/actions/runs/${RUN_ID}`;
      if (method === 'GET' && path === runPath) {
        return send(200, {
          id: RUN_ID,
          name: 'CI',
          event: 'push',
          head_branch: 'main',
          html_url: `https://github.com/acme/app/actions/runs/${RUN_ID}`,
          actor: { login: 'merger' },
          ...state.run,
        });
      }
      if (method === 'GET' && path === '/repos/acme/app/branches/main') {
        return send(200, { commit: { sha: state.mainHead } });
      }
      if (
        method === 'POST' &&
        (path === `${runPath}/rerun` || path === `${runPath}/rerun-failed-jobs`)
      ) {
        // Attempt 2 is visible on the very next read, already finished.
        state.run = {
          ...state.run,
          run_attempt: state.run.run_attempt + 1,
          status: state.stall ? 'in_progress' : 'completed',
          conclusion: state.stall ? null : state.secondConclusion,
        };
        return send(201, {});
      }
      if (method === 'POST' && path === '/repos/acme/app/labels') {
        return send(422, { message: 'already_exists' });
      }
      if (method === 'GET' && path.startsWith('/repos/acme/app/issues?')) {
        return send(200, state.openIssues);
      }
      if (method === 'POST' && path === '/repos/acme/app/issues') {
        return send(201, { number: 7, html_url: 'https://github.com/acme/app/issues/7' });
      }
      if (method === 'POST' && /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(path)) {
        return send(201, {});
      }
      return send(404, { message: `unexpected ${method} ${path}` });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function runScript(api: string, extra: Record<string, string> = {}) {
  const summary = join(mkdtempSync(join(tmpdir(), 'motir-main-ci-retry-')), 'summary.md');
  return new Promise<{ code: number | null; out: string; summary: string }>((resolve) => {
    const child = spawn('node', ['scripts/retry-main-ci.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        GITHUB_API_URL: api,
        GITHUB_REPOSITORY: 'acme/app',
        GITHUB_TOKEN: 'fake',
        RUN_ID: String(RUN_ID),
        POLL_SECONDS: '0.01',
        DEADLINE_MINUTES: '0.05',
        GITHUB_STEP_SUMMARY: summary,
        ...extra,
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => {
      let text = '';
      try {
        text = readFileSync(summary, 'utf8');
      } catch {
        // no summary written
      }
      resolve({ code, out, summary: text });
    });
  });
}

const writes = (state: FakeState) => state.calls.filter((c) => c.method !== 'GET');
const reruns = (state: FakeState) => state.calls.filter((c) => /\/rerun/.test(c.path));

const freshState = (overrides: Partial<FakeState> = {}): FakeState => ({
  run: { run_attempt: 1, status: 'completed', conclusion: 'failure', head_sha: HEAD },
  mainHead: HEAD,
  secondConclusion: 'failure',
  openIssues: [],
  calls: [],
  ...overrides,
});

describe('the runner re-attempts once and cannot re-trigger itself', () => {
  it('re-runs once, follows attempt 2, and a re-delivered attempt-2 event writes NOTHING', async () => {
    const state = freshState();
    const api = await fakeGitHub(state);

    const first = await runScript(api);
    expect(first.code).toBe(EXIT_FAILED_TWICE);
    expect(reruns(state)).toHaveLength(1);
    expect(reruns(state)[0]!.path).toMatch(/\/rerun-failed-jobs$/);

    // The event GitHub delivers when attempt 2 completes, fed straight back in —
    // the loop, if there were one, starts here.
    const before = writes(state).length;
    const second = await runScript(api);
    expect(second.code).toBe(EXIT_OK);
    expect(second.out).toContain('already re-attempted (attempt 2)');
    expect(writes(state)).toHaveLength(before);
    expect(reruns(state)).toHaveLength(1);
  });

  it('opens an issue assigned to the merger, keyed on the commit, when attempt 2 fails', async () => {
    const state = freshState();
    const api = await fakeGitHub(state);

    const result = await runScript(api);
    const created = state.calls.find(
      (c) => c.method === 'POST' && c.path === '/repos/acme/app/issues',
    );
    expect(created?.body).toMatchObject({
      title: issueTitle(HEAD),
      labels: [SIGNAL_LABEL],
      assignees: ['merger'],
    });
    expect(result.summary).toContain('outcome: failed-twice');
    expect(result.summary).toContain('signal: https://github.com/acme/app/issues/7');
  });

  it('comments on the open issue for the same commit instead of opening a second one', async () => {
    const state = freshState({
      openIssues: [
        { number: 3, title: issueTitle(HEAD), html_url: 'https://github.com/acme/app/issues/3' },
      ],
    });
    const api = await fakeGitHub(state);

    await runScript(api);
    expect(
      state.calls.some((c) => c.method === 'POST' && c.path === '/repos/acme/app/issues'),
    ).toBe(false);
    expect(state.calls.some((c) => c.path === '/repos/acme/app/issues/3/comments')).toBe(true);
  });

  it('raises no signal when attempt 2 goes green, and says it was a second-attempt green', async () => {
    const state = freshState({ secondConclusion: 'success' });
    const api = await fakeGitHub(state);

    const result = await runScript(api);
    expect(result.code).toBe(EXIT_OK);
    expect(result.summary).toContain('SECOND-attempt green');
    expect(state.calls.some((c) => c.path.includes('/issues'))).toBe(false);
  });

  it('re-runs the whole run for a cancelled first attempt', async () => {
    const state = freshState({
      run: { run_attempt: 1, status: 'completed', conclusion: 'cancelled', head_sha: HEAD },
      secondConclusion: 'success',
    });
    const api = await fakeGitHub(state);

    await runScript(api);
    expect(reruns(state).map((c) => c.path)).toEqual([
      `/repos/acme/app/actions/runs/${RUN_ID}/rerun`,
    ]);
  });

  it('writes nothing at all for a run superseded by a newer merge', async () => {
    const state = freshState({ mainHead: OLDER });
    const api = await fakeGitHub(state);

    const result = await runScript(api);
    expect(result.code).toBe(EXIT_OK);
    expect(result.summary).toContain('superseded');
    expect(writes(state)).toHaveLength(0);
  });

  it('is BLIND, not green, when attempt 2 never finishes before the deadline', async () => {
    const state = freshState({ stall: true });
    const api = await fakeGitHub(state);

    const result = await runScript(api, { DEADLINE_MINUTES: '0.002' });
    expect(reruns(state)).toHaveLength(1);
    expect(result.code).toBe(EXIT_BLIND);
    expect(result.out).toContain('did not finish within');
    expect(state.calls.some((c) => c.path.includes('/issues'))).toBe(false);
  });
});

describe('the lane is wired to the script, and bounded', () => {
  const lane = readFileSync(join(ROOT, '.github/workflows/main-ci-retry.yml'), 'utf8');
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

  it('states its purpose as the tripwire, not as reaching a deploy in ci.yml (MOTIR-11060)', () => {
    expect(lane).toContain('TRIPWIRE');
    expect(lane).toContain('it gates no');
    expect(lane).not.toMatch(/`deploy` lives only in the push-to-`main` run/);
    expect(lane).not.toMatch(/would deploy/i);
  });

  it('triggers on CI completing on main — and on nothing else, so it can never trigger itself', () => {
    expect(lane).toMatch(
      /on:\n  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n    branches: \[main\]\n\n/,
    );
    expect(lane).not.toMatch(/^name: CI$/m);
    expect(ci).toMatch(/^name: CI$/m);
  });

  it('starts no runner for anything but a first attempt of a non-green push run', () => {
    expect(lane).toContain("github.event.workflow_run.event == 'push'");
    expect(lane).toContain('github.event.workflow_run.run_attempt == 1');
    expect(lane).toContain("github.event.workflow_run.conclusion != 'success'");
  });

  it('runs the script this file tests, passing the run id through the environment', () => {
    expect(lane).toContain('run: node scripts/retry-main-ci.mjs');
    expect(lane).toContain('RUN_ID: ${{ github.event.workflow_run.id }}');
    expect(lane).not.toMatch(/run:.*\$\{\{/);
  });

  it('holds exactly the permissions it uses', () => {
    expect(lane).toMatch(/^permissions: \{\}$/m);
    expect(lane).toMatch(
      /permissions:\n(?:\s+#.*\n)*\s+actions: write\n\s+contents: read\n(?:\s+#.*\n)*\s+issues: write/,
    );
  });

  it('never cancels a retry in flight, and bounds its runtime above the poll deadline', () => {
    expect(lane).toContain('group: main-ci-retry-${{ github.event.workflow_run.id }}');
    expect(lane).toMatch(/cancel-in-progress: false/);
    expect(lane).toMatch(/timeout-minutes: 90/);
  });
});
