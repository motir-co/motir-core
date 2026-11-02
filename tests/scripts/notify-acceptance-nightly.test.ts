import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import {
  EXIT_BLIND,
  EXIT_OK,
  EXIT_RED,
  EXIT_USAGE,
  ISSUE_TITLE,
  SIGNAL_LABEL,
  WATCHED_WORKFLOW,
  decideNotify,
  lastGreenNightly,
  nightBody,
} from '../../scripts/acceptanceNightlyNotify.mjs';

// MOTIR-10277 — the full acceptance and regression lanes moved from every push
// to `main` to a nightly run, and a nightly's red attaches to a commit nobody
// is looking at (MOTIR-3850: a scheduled lane red for 17 days, nobody told). So
// a night that does not go green opens, or comments on, ONE labelled issue
// assigned to a named person.
//
// Three things are DEMONSTRATED here rather than asserted:
//
//   1. Who is told: only a SCHEDULED run that did not go green notifies. A
//      dispatched, pull-request or merge-queue run never does, whatever it ended.
//   2. How: against a fake GitHub API, the runner opens one issue, comments on it
//      while it is open, falls back to a mention when the assignment is refused,
//      and goes non-zero, naming what it could not read, when it is blind.
//   3. The wiring: the workflow triggers on nothing a pull request can see.

const ROOT = process.cwd();
const HEAD = 'a'.repeat(40);
const GREEN_SHA = 'b'.repeat(40);
const RUN_ID = 5150;
const WORKFLOW_ID = 77;
const LOGIN = 'night-owner';

const scheduled = {
  workflowName: WATCHED_WORKFLOW,
  event: 'schedule',
  headBranch: 'main',
  status: 'completed',
  conclusion: 'failure' as string | null,
  defaultBranch: 'main',
};

describe('decideNotify — which finished runs reach a person', () => {
  it.each(['failure', 'cancelled', 'timed_out', 'startup_failure'])(
    'notifies for a scheduled run that ended %s',
    (conclusion) => {
      const decision = decideNotify({ ...scheduled, conclusion });
      expect(decision.action).toBe('notify');
      expect(decision.reason).toContain(conclusion);
    },
  );

  it('treats any other non-green conclusion as red too — a night with no verdict is a gap', () => {
    for (const conclusion of ['skipped', 'neutral', 'action_required', 'stale']) {
      expect(decideNotify({ ...scheduled, conclusion }).action).toBe('notify');
    }
  });

  it('tells nobody about a scheduled run that went green', () => {
    expect(decideNotify({ ...scheduled, conclusion: 'success' })).toEqual({
      action: 'skip',
      reason: 'the night went green',
    });
  });

  it.each(['workflow_dispatch', 'pull_request', 'merge_group', 'push'])(
    'never notifies for a %s run, whatever its conclusion',
    (event) => {
      for (const conclusion of [
        'failure',
        'cancelled',
        'timed_out',
        'startup_failure',
        'success',
      ]) {
        const decision = decideNotify({ ...scheduled, event, conclusion });
        expect(decision.action).toBe('skip');
        expect(decision.reason).toContain(event);
      }
    },
  );

  it('ignores a run that has not finished, a run off the default branch, and another workflow', () => {
    expect(decideNotify({ ...scheduled, status: 'in_progress', conclusion: null }).action).toBe(
      'skip',
    );
    expect(decideNotify({ ...scheduled, conclusion: null }).reason).toContain('not finished');
    expect(decideNotify({ ...scheduled, headBranch: 'bisect/acceptance-x' }).reason).toContain(
      'not a run on main',
    );
    expect(decideNotify({ ...scheduled, workflowName: 'CI' }).action).toBe('skip');
  });
});

describe('lastGreenNightly — where the range starts', () => {
  const current = { id: 9, created_at: '2026-11-05T03:17:00Z' };
  const run = (over: Record<string, unknown>) => ({
    id: 1,
    event: 'schedule',
    head_branch: 'main',
    conclusion: 'success',
    head_sha: GREEN_SHA,
    html_url: 'https://github.com/acme/app/actions/runs/1',
    created_at: '2026-11-04T03:17:00Z',
    ...over,
  });

  it('picks the newest green scheduled run on main before this one', () => {
    const older = run({ id: 2, head_sha: 'c'.repeat(40), created_at: '2026-11-03T03:17:00Z' });
    expect(lastGreenNightly([older, run({})], current, 'main')).toEqual({
      headSha: GREEN_SHA,
      htmlUrl: 'https://github.com/acme/app/actions/runs/1',
      createdAt: '2026-11-04T03:17:00Z',
    });
  });

  it('re-applies the filter rather than trusting the query', () => {
    const decoys = [
      run({ id: 9 }), // this run itself
      run({ id: 3, event: 'workflow_dispatch' }),
      run({ id: 4, head_branch: 'bisect/x' }),
      run({ id: 5, conclusion: 'failure' }),
      run({ id: 6, created_at: '2026-11-06T03:17:00Z' }), // after this run
    ];
    expect(lastGreenNightly(decoys, current, 'main')).toBeNull();
    expect(lastGreenNightly(undefined as never, current, 'main')).toBeNull();
  });
});

describe('nightBody — what the person reads', () => {
  const night = {
    serverUrl: 'https://github.com',
    repository: 'acme/app',
    runUrl: `https://github.com/acme/app/actions/runs/${RUN_ID}`,
    headSha: HEAD,
    conclusion: 'failure',
    createdAt: '2026-11-05T03:17:00Z',
    lastGreen: {
      headSha: GREEN_SHA,
      htmlUrl: 'https://github.com/acme/app/actions/runs/1',
      createdAt: '2026-11-04T03:17:00Z',
    },
    login: LOGIN,
    assigned: true as boolean | null,
  };

  it('carries the run, the compare range from the last green night, and how to bisect', () => {
    const body = nightBody(night);
    expect(body).toContain(night.runUrl);
    expect(body).toContain(`https://github.com/acme/app/compare/${GREEN_SHA}...${HEAD}`);
    expect(body).toContain('gh workflow run acceptance-tests.yml --ref bisect/acceptance-<sha>');
    expect(body).toContain('git push origin <sha>:refs/heads/bisect/acceptance-<sha>');
    expect(body).toContain(`assigned to: \`${LOGIN}\``);
    expect(body).not.toContain(`@${LOGIN}`);
  });

  it('says there is no green night yet rather than printing a broken link', () => {
    const body = nightBody({ ...night, lastGreen: null });
    expect(body).toContain('There is no green nightly on record yet');
    expect(body).not.toContain('/compare/');
    expect(body).not.toContain('undefined');
  });

  it('says the last green night was unreadable, and why, when it was', () => {
    const body = nightBody({ ...night, lastGreen: null, lastGreenError: 'GET … → 500' });
    expect(body).toContain('could not be read (GET … → 500)');
    expect(body).not.toContain('/compare/');
  });

  it('mentions the person when the assignment was refused, and names nobody on a comment', () => {
    expect(nightBody({ ...night, assigned: false })).toContain(
      `@${LOGIN} — the assignment was refused`,
    );
    const comment = nightBody({ ...night, assigned: null });
    expect(comment).not.toContain(LOGIN);
  });
});

// ── The runner, against a fake GitHub API ─────────────────────────────────────

type Call = { method: string; path: string; body: Record<string, unknown> | null };

interface FakeState {
  run: Record<string, unknown>;
  /** When set, the run read answers this status instead. */
  runStatus?: number;
  /** When set, the run read answers this status with a non-JSON body. */
  runHtmlStatus?: number;
  /** When set, the label POST answers this status instead of 422. */
  labelStatus?: number;
  greenRuns: Record<string, unknown>[];
  /** When set, the last-green read answers this status instead. */
  greenStatus?: number;
  openIssues: Record<string, unknown>[];
  /** When true, an issue POST that carries assignees is refused with 422. */
  refuseAssignee?: boolean;
  /** When set, every issue POST answers this status. */
  issueStatus?: number;
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
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      state.calls.push({ method, path, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (method === 'GET' && path === `/repos/acme/app/actions/runs/${RUN_ID}`) {
        if (state.runStatus) return send(state.runStatus, { message: 'Not Found' });
        if (state.runHtmlStatus) {
          res.writeHead(state.runHtmlStatus, { 'Content-Type': 'text/html' });
          return res.end('<html>Bad Gateway</html>');
        }
        return send(200, state.run);
      }
      if (
        method === 'GET' &&
        path.startsWith(`/repos/acme/app/actions/workflows/${WORKFLOW_ID}/runs?`)
      ) {
        if (state.greenStatus) return send(state.greenStatus, { message: 'Server Error' });
        return send(200, { total_count: state.greenRuns.length, workflow_runs: state.greenRuns });
      }
      if (method === 'POST' && path === '/repos/acme/app/labels') {
        if (state.labelStatus) return send(state.labelStatus, { message: 'Forbidden' });
        return send(422, { message: 'Validation Failed' });
      }
      if (method === 'GET' && path.startsWith('/repos/acme/app/issues?')) {
        return send(200, state.openIssues);
      }
      if (method === 'POST' && path === '/repos/acme/app/issues') {
        if (state.issueStatus) return send(state.issueStatus, { message: 'Forbidden' });
        if (state.refuseAssignee && Array.isArray(body?.assignees) && body.assignees.length > 0) {
          return send(422, { message: 'Validation Failed' });
        }
        return send(201, { number: 11, html_url: 'https://github.com/acme/app/issues/11' });
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
  const summary = join(mkdtempSync(join(tmpdir(), 'motir-acceptance-nightly-')), 'summary.md');
  return new Promise<{ code: number | null; out: string; summary: string }>((resolve) => {
    const child = spawn('node', ['scripts/notify-acceptance-nightly.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        GITHUB_API_URL: api,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'acme/app',
        GITHUB_TOKEN: 'fake',
        RUN_ID: String(RUN_ID),
        NOTIFY_LOGIN: LOGIN,
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

const theRun = (over: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  name: WATCHED_WORKFLOW,
  workflow_id: WORKFLOW_ID,
  event: 'schedule',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'failure',
  head_sha: HEAD,
  html_url: `https://github.com/acme/app/actions/runs/${RUN_ID}`,
  created_at: '2026-11-05T03:17:00Z',
  ...over,
});

const greenRun = {
  id: 1,
  event: 'schedule',
  head_branch: 'main',
  conclusion: 'success',
  head_sha: GREEN_SHA,
  html_url: 'https://github.com/acme/app/actions/runs/1',
  created_at: '2026-11-04T03:17:00Z',
};

const freshState = (overrides: Partial<FakeState> = {}): FakeState => ({
  run: theRun(),
  greenRuns: [greenRun],
  openIssues: [],
  calls: [],
  ...overrides,
});

const issuePosts = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'POST' && c.path === '/repos/acme/app/issues');
const comments = (state: FakeState) =>
  state.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments'));
const writes = (state: FakeState) => state.calls.filter((c) => c.method !== 'GET');

describe('the runner tells one person, on one thread', () => {
  it('opens a labelled issue assigned to the named login when none is open', async () => {
    const state = freshState();
    const result = await runScript(await fakeGitHub(state));

    expect(result.code).toBe(EXIT_RED);
    expect(issuePosts(state)).toHaveLength(1);
    const created = issuePosts(state)[0]!.body!;
    expect(created).toMatchObject({
      title: ISSUE_TITLE,
      labels: [SIGNAL_LABEL],
      assignees: [LOGIN],
    });
    expect(created.body).toContain(`/compare/${GREEN_SHA}...${HEAD}`);
    expect(created.body).toContain(`actions/runs/${RUN_ID}`);
    expect(comments(state)).toHaveLength(0);
    expect(result.summary).toContain('signal: opened https://github.com/acme/app/issues/11');
    // The last-green read asked for green scheduled runs on main, of THIS workflow.
    const read = state.calls.find((c) => c.path.includes('/actions/workflows/'))!;
    expect(read.path).toContain(`/workflows/${WORKFLOW_ID}/runs?`);
    expect(read.path).toContain('event=schedule');
    expect(read.path).toContain('status=success');
    expect(read.path).toContain('branch=main');
  });

  it('comments on the open labelled issue and opens nothing', async () => {
    const state = freshState({
      openIssues: [
        // A labelled pull request is not the thread.
        { number: 4, pull_request: {}, html_url: 'https://github.com/acme/app/pull/4' },
        { number: 3, title: ISSUE_TITLE, html_url: 'https://github.com/acme/app/issues/3' },
      ],
    });
    const result = await runScript(await fakeGitHub(state));

    expect(result.code).toBe(EXIT_RED);
    expect(issuePosts(state)).toHaveLength(0);
    expect(comments(state).map((c) => c.path)).toEqual(['/repos/acme/app/issues/3/comments']);
    expect(comments(state)[0]!.body!.body).toContain(`actions/runs/${RUN_ID}`);
    expect(result.summary).toContain('signal: commented https://github.com/acme/app/issues/3');
    // The issues read is scoped to the label.
    expect(state.calls.some((c) => c.path.includes(`labels=${SIGNAL_LABEL}`))).toBe(true);
  });

  it('still opens the issue, mentioning the login, when the assignment is refused', async () => {
    const state = freshState({ refuseAssignee: true });
    const result = await runScript(await fakeGitHub(state));

    expect(result.code).toBe(EXIT_RED);
    expect(issuePosts(state)).toHaveLength(2);
    const fallback = issuePosts(state)[1]!.body!;
    expect(fallback).not.toHaveProperty('assignees');
    expect(fallback.labels).toEqual([SIGNAL_LABEL]);
    expect(fallback.body).toContain(`@${LOGIN}`);
    expect(result.summary).toContain('signal: opened unassigned');
  });

  it('says there is no green night yet when none is on record', async () => {
    const state = freshState({ greenRuns: [] });
    await runScript(await fakeGitHub(state));
    const body = String(issuePosts(state)[0]!.body!.body);
    expect(body).toContain('There is no green nightly on record yet');
    expect(body).not.toContain('/compare/');
  });

  it('still tells the person when the last green night cannot be read', async () => {
    const state = freshState({ greenStatus: 500 });
    const result = await runScript(await fakeGitHub(state));
    expect(result.code).toBe(EXIT_RED);
    expect(String(issuePosts(state)[0]!.body!.body)).toContain('could not be read');
    expect(result.out).toContain('Could not read the last green nightly');
  });

  it('writes nothing for a green night or a dispatched red one', async () => {
    for (const run of [theRun({ conclusion: 'success' }), theRun({ event: 'workflow_dispatch' })]) {
      const state = freshState({ run });
      const result = await runScript(await fakeGitHub(state));
      expect(result.code).toBe(EXIT_OK);
      expect(writes(state)).toHaveLength(0);
      expect(result.summary).toContain('decision: skip');
      server?.close();
    }
  });
});

describe('the runner is never silently blind', () => {
  it('exits non-zero, naming the run it could not read', async () => {
    const state = freshState({ runStatus: 404 });
    const result = await runScript(await fakeGitHub(state));
    expect(result.code).toBe(EXIT_BLIND);
    expect(result.out).toContain(`Could not read the run ${RUN_ID}`);
    expect(result.out).toContain('404');
    expect(writes(state)).toHaveLength(0);
  });

  it('names the status and the body when the API answers with something that is not JSON', async () => {
    const state = freshState({ runHtmlStatus: 502 });
    const result = await runScript(await fakeGitHub(state));
    expect(result.code).toBe(EXIT_BLIND);
    expect(result.out).toContain('502 <html>Bad Gateway</html>');
  });

  it('exits non-zero when the label cannot be made, rather than opening nothing quietly', async () => {
    const state = freshState({ labelStatus: 403 });
    const result = await runScript(await fakeGitHub(state));
    expect(result.code).toBe(EXIT_BLIND);
    expect(result.out).toContain('/labels → 403 Forbidden');
    expect(issuePosts(state)).toHaveLength(0);
  });

  it('exits non-zero when the issue cannot be written', async () => {
    const state = freshState({ issueStatus: 403 });
    const result = await runScript(await fakeGitHub(state));
    expect(result.code).toBe(EXIT_BLIND);
    expect(result.out).toContain('the issue could not be written');
  });

  it('refuses to run without the login to tell', async () => {
    const state = freshState();
    const result = await runScript(await fakeGitHub(state), { NOTIFY_LOGIN: '  ' });
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out).toContain('NOTIFY_LOGIN');
    expect(state.calls).toHaveLength(0);
  });
});

describe('the lane is wired to the script and adds no check to a pull request', () => {
  const lane = readFileSync(join(ROOT, '.github/workflows/acceptance-nightly-notify.yml'), 'utf8');
  const watched = readFileSync(join(ROOT, '.github/workflows/acceptance-tests.yml'), 'utf8');
  const code = lane
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const header = code.split(/^jobs:\s*$/m)[0] ?? '';

  it('triggers only on Acceptance tests completing on the default branch', () => {
    expect(code).toMatch(
      /^on:\n {2}workflow_run:\n {4}workflows: \[Acceptance tests\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n\n/m,
    );
    // The name it watches is the watched workflow's own `name:`, and the module's.
    expect(watched).toMatch(/^name: Acceptance tests$/m);
    expect(WATCHED_WORKFLOW).toBe('Acceptance tests');
    // No other trigger: nothing here can attach a check to a pull request.
    const onBlock = /^on:\n((?: {2,}.*\n|\n)*)/m.exec(header)![1]!;
    const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(triggers).toEqual(['workflow_run']);
    for (const prTrigger of ['pull_request', 'pull_request_target', 'merge_group', 'push']) {
      expect(header).not.toMatch(new RegExp(`^ {2}${prTrigger}:`, 'm'));
    }
  });

  it('starts a runner only for a scheduled run that did not go green', () => {
    expect(code).toContain("github.event.workflow_run.event == 'schedule'");
    expect(code).toContain("github.event.workflow_run.conclusion != 'success'");
  });

  it('runs the script this file tests, passing the run id through the environment', () => {
    expect(code).toContain('run: node scripts/notify-acceptance-nightly.mjs');
    expect(code).toContain('RUN_ID: ${{ github.event.workflow_run.id }}');
    expect(code).not.toMatch(/run:.*\$\{\{/);
  });

  it('names the notified login in exactly one place, and never leaves it empty', () => {
    const logins = [...code.matchAll(/^\s*NOTIFY_LOGIN:\s*(.*)$/gm)].map((m) => m[1]!.trim());
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/);
    expect(logins[0]).not.toContain('${{');
  });

  it('holds exactly the permissions it uses, and never cancels a notification', () => {
    expect(code).toMatch(/^permissions: \{\}$/m);
    expect(code).toMatch(/permissions:\n\s+actions: read\n\s+contents: read\n\s+issues: write/);
    expect(code).toContain('group: acceptance-nightly-notify-${{ github.event.workflow_run.id }}');
    expect(code).toMatch(/cancel-in-progress: false/);
  });

  it('keeps its one job on the runner seam, using only checkout, setup-node and node', () => {
    expect(code).toContain("runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}");
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses).toEqual(['actions/checkout@v6', 'actions/setup-node@v6']);
    const runs = [...code.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]);
    expect(runs).toEqual(['node scripts/notify-acceptance-nightly.mjs']);
  });
});
