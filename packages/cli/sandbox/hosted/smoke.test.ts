import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliArgs, readLaunch, REQUIRED_INPUTS, RUN_MODES, SETUP_FAILED } from './entrypoint.js';

// The hosted-agent image's smoke test (Story MOTIR-683 · MOTIR-687, rewritten
// for the CLI-running image by MOTIR-6560).
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1: the image runs the
// Motir CLI's own `motir run` on the run the server opened. So this drives the
// REAL chain — `node entrypoint.ts` → the real CLI (from source, through tsx) →
// a fake OpenCode — for the three run shapes the decision names, and checks
// each ends in one pull request per repository with the event sequence a local
// run records:
//
//   1. a one-repository LEAF;
//   2. a LEAF that spans two repositories;
//   3. a PARENT with two children in two repositories (a scope run: one session
//      branch per repository, a DRAFT pull request per repository opened at the
//      first child that lands, marked READY at the close-out).
//
// The same three shapes CONTINUED (MOTIR-6795), and a REVIEW (MOTIR-6824,
// `hosted-agent-run.md` §8) of a one-repository and a two-repository card: every
// pull request checked out at its reviewed head, ONE verdict POST carrying the
// version, and nothing pushed or posted to GitHub — the harness logs every `git`
// the CLI and the agent run, and the fake `gh`'s log stays empty.
//
// And a REPAIR (MOTIR-6929, `hosted-agent-run.md` §8.6) of a one-repository and a
// two-repository card a review sent back: the run the server's repair claim opened is
// adopted (never claimed), every pull request is checked out on its OWN branch, the
// agent's fix is pushed to exactly those branches, and no branch, pull request or
// `gh` call is made — an agent that tries another ref or `gh` is refused.
//
// What stands in for what:
//   - a stub MOTIR answering every route the hosted CLI calls, with bodies the
//     CLI's own response validators accept, and recording every request;
//   - LOCAL BARE REMOTES for GitHub. The CLI's hosted git setup keys everything
//     on `https://github.com/<owner>/<name>` — the credential helper and each
//     repository's App-bot identity (`includeIf hasconfig:remote.*.url:…`) —
//     so the clone URLs the stub hands out ARE those URLs, and git's own
//     `url.<bare>.insteadOf https://github.com/<owner>/<name>` redirects the
//     transport to the bare remote. The CLI reads the redirect from
//     `GIT_CONFIG_SYSTEM`; the agent's environment is allow-listed without it,
//     so the fake agent passes the same file with `-c include.path=…` on its
//     push. The remote URL recorded in every checkout stays the GitHub one, so
//     the identity `includeIf` is exercised for real. (A file transport asks
//     no credential; the helper itself is proved by `test/hostedGit.test.ts`.)
//   - a fake `gh` behind the CLI's REAL `gh` shim, which keeps the pull
//     requests in a JSON file and records the token each call was given;
//   - a fake `opencode` that makes one model call exactly as OpenCode would
//     from the egress document it was handed, then commits and pushes in every
//     checkout its prompt names and — on a leaf — opens the pull request;
//   - a fake `codegraph` that makes the index directory the real one makes.
//
// Two layers:
//   1. PROCESS — everything above as processes on the host. Runs everywhere.
//   2. IMAGE — the built image's own contents (the CLI, `gh`, git ≥ 2.36, the
//      pinned OpenCode, codegraph, a non-root user), and the launcher refusing
//      a boot with no inputs. Runs when `MOTIR_HOSTED_AGENT_IMAGE` names a built
//      image (`hosted-agent-image.yml` sets it); skipped otherwise.

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'entrypoint.ts');
const CLI_ROOT = join(HERE, '..', '..');
const CLI_SRC_INDEX = join(CLI_ROOT, 'src', 'index.ts');
const TSX = join(CLI_ROOT, '..', '..', 'node_modules', '.bin', 'tsx');
const IMAGE = process.env.MOTIR_HOSTED_AGENT_IMAGE?.trim() || null;

const RUN_TOKEN = 'mrt_smoke_run_credential';
const RUN_KEY = 'sk-smoke-run-key';
const OWNER = 'usr_dispatcher';
const DISPATCHER = 'Dana Dispatcher';
const MODEL = 'anthropic/claude-smoke-1';

const BOTS: Record<string, { name: string; email: string }> = {
  'acme/app-a': {
    name: 'motir-studio[bot]',
    email: '101+motir-studio[bot]@users.noreply.github.com',
  },
  'acme/app-b': {
    name: 'motir-integration[bot]',
    email: '202+motir-integration[bot]@users.noreply.github.com',
  },
};

// ── The fakes ──────────────────────────────────────────────────────────────

/**
 * The one large block a `FAKE:big-output` agent prints in a single write (MOTIR-10705) —
 * a `prettier --write` listing in multi-byte text and one 20 KB line with no break, 60 KB
 * in all, far over the server's 16 KiB event-body limit. One function, embedded in the
 * fake agent by its source, so the test asserts against the very text the agent wrote.
 */
function bigAgentOutput(): string {
  let out = '';
  for (let i = 0; i < 600; i += 1) out += `€ prettier wrote src/feature-${i}/file.ts 😀\n`;
  return out + 'x'.repeat(20_000) + '\n';
}

/**
 * The fake OpenCode. Its instructions come from the PROMPT (the one channel the
 * CLI forwards unchanged): `FAKE:closeout` is the close-out's How-to-test agent,
 * which does nothing; otherwise `FAKE:key=`, `FAKE:mode=pr|session|continue`
 * and `FAKE:repos=` say what to change and how to deliver it. A `continue` works
 * in the checkout the CLI resumed at the dead branch (`<repo>-<key>`, the
 * prompt's continue worktree) and opens a pull request only where none is open.
 */
const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
const fileAt = args.indexOf('--file');
const prompt = fileAt >= 0 ? fs.readFileSync(args[fileAt + 1], 'utf8') : args[args.length - 1];
const configText = process.env.OPENCODE_CONFIG_CONTENT || '';
fs.appendFileSync(path.join(process.env.HOME, 'agent-records.jsonl'), JSON.stringify({
  cwd: process.cwd(),
  model,
  envKeys: Object.keys(process.env).sort(),
  leaksRunToken: Object.values(process.env).some((v) => String(v).includes(${JSON.stringify(RUN_TOKEN)})),
  closeout: prompt.includes('FAKE:closeout'),
}) + '\\n');
if (prompt.includes('FAKE:closeout')) process.exit(0);
const marker = (name) => (new RegExp('FAKE:' + name + '=([^\\\\s]+)').exec(prompt) || [])[1];
const key = marker('key');
const mode = marker('mode');
const repos = (marker('repos') || '').split(',').filter(Boolean);
const redirect = ['-c', 'include.path=' + path.join(process.env.HOME, 'smoke-redirect.gitconfig')];
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sub = (s) => s.replace(/\\{env:([A-Z_]+)\\}/g, (_, n) => process.env[n] || '');
const options = JSON.parse(configText).provider.anthropic.options;
(async () => {
  const res = await fetch(sub(options.baseURL) + '/messages', {
    method: 'POST',
    headers: { 'x-api-key': sub(options.apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.split('/')[1], max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  console.log('model call answered ' + res.status);
  if (prompt.includes('FAKE:big-output')) process.stdout.write((${bigAgentOutput.toString()})());
  if (prompt.includes('FAKE:fail')) { console.error('boom: the fake agent failed on purpose'); process.exit(3); }
  const root = path.dirname(process.cwd());
  // A REPAIR (MOTIR-6929): commit in every checkout the review-fix prompt names, ON the
  // branch it is on, and push that branch. \`FAKE:try-sneaky\` also tries another ref
  // and \`gh pr create\` — both must be refused. \`FAKE:no-change\` changes nothing.
  if (prompt.includes('FAKE:fix')) {
    const attempt = (fn) => { try { fn(); return { status: 0, stderr: '' }; } catch (e) { return { status: e.status || 1, stderr: String(e.stderr || '') }; } };
    const checkouts = [...prompt.matchAll(/branch \`([^\`]+)\` at \`([^\`]+)\`/g)].map((m) => ({ branch: m[1], dir: m[2] }));
    const record = { checkouts, heads: {}, tried: null, prompt };
    for (const { branch, dir } of checkouts) {
      record.heads[dir] = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      if (prompt.includes('FAKE:no-change')) continue;
      fs.writeFileSync(path.join(dir, key + '-fix.txt'), 'the fix for ' + key + ' on ' + branch + '\\n');
      git(dir, 'add', key + '-fix.txt');
      git(dir, 'commit', '-m', key + ': answer the review on ' + branch);
      git(dir, ...redirect, 'push', 'origin', 'HEAD');
    }
    if (prompt.includes('FAKE:try-sneaky')) {
      const dir = checkouts[0].dir;
      record.tried = {
        push: attempt(() => git(dir, ...redirect, 'push', 'origin', 'HEAD:refs/heads/sneaky')),
        gh: attempt(() => execFileSync('gh', ['pr', 'create', '--title', 'x', '--body', 'y'], { cwd: dir, stdio: 'pipe' })),
      };
    }
    fs.appendFileSync(path.join(process.env.HOME, 'fix-records.jsonl'), JSON.stringify(record) + '\\n');
    process.exit(0);
  }
  // A REVIEW (MOTIR-6824): read each checkout's HEAD, and write the ONE verdict to
  // the file the CLI's prompt names. \`FAKE:try-push\` is an agent that ignores its
  // rules: it tries to push and to comment, and writes no verdict.
  if (prompt.includes('FAKE:review')) {
    const heads = {};
    for (const repo of repos) heads[repo] = git(path.join(root, repo), 'rev-parse', 'HEAD').trim();
    const attempt = (fn) => { try { fn(); return 0; } catch (e) { return e.status || 1; } };
    const tried = prompt.includes('FAKE:try-push') ? {
      push: attempt(() => git(process.cwd(), ...redirect, 'push', 'origin', 'HEAD:refs/heads/sneaky')),
      gh: attempt(() => execFileSync('gh', ['pr', 'comment', '1', '--body', 'lgtm'], { stdio: 'pipe' })),
    } : null;
    fs.appendFileSync(path.join(process.env.HOME, 'review-records.jsonl'), JSON.stringify({ heads, tried, verdictFile: process.env.MOTIR_REVIEW_VERDICT_FILE || null }) + '\\n');
    if (tried) process.exit(0);
    const version = (/EXACTLY "([^"]+)"/.exec(prompt) || [])[1];
    const verdict = marker('verdict') || 'pass';
    fs.writeFileSync(process.env.MOTIR_REVIEW_VERDICT_FILE, JSON.stringify(verdict === 'pass'
      ? { subjectVersion: version, verdict, summaryMd: 'Meets the card.' }
      : { subjectVersion: version, verdict, summaryMd: 'One gap.', findingsMd: '- ' + repos[repos.length - 1] + '/README.md:1 — the criterion is not met.' }));
    process.exit(0);
  }
  for (const repo of repos) {
    const dir = mode === 'continue'
      ? path.join(root, repo + '-' + key.toLowerCase())
      : path.join(root, repo);
    fs.writeFileSync(path.join(dir, key + '.txt'), 'work for ' + key + ' in ' + repo + '\\n');
    if (mode === 'pr') git(dir, 'switch', '-c', 'hosted/' + key);
    // A session run integrates on the run's session branch, as its prompt says.
    if (mode === 'session') {
      const branch = marker('branch');
      git(dir, ...redirect, 'fetch', 'origin', '+refs/heads/' + branch + ':refs/remotes/origin/' + branch);
      git(dir, 'switch', '-C', branch, 'origin/' + branch);
    }
    git(dir, 'add', key + '.txt');
    git(dir, 'commit', '-m', key + ': the change in ' + repo);
    git(dir, ...redirect, 'push', '-u', 'origin', 'HEAD');
    if (mode === 'session') git(dir, ...redirect, 'fetch', 'origin');
    const head = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    const open = mode === 'continue'
      ? execFileSync('gh', ['pr', 'list', '--head', head], { cwd: dir, encoding: 'utf8' }).trim()
      : '';
    if (mode === 'pr' || (mode === 'continue' && !open)) {
      execFileSync('gh', ['pr', 'create', '--base', 'main', '--title', key + ' in ' + repo, '--body', 'Delivers ' + key + '.'], { cwd: dir, stdio: 'inherit' });
    }
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(4); });
`;

/** The fake `gh`: pull requests kept in $HOME/fake-gh.json, per repository and head. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const store = path.join(process.env.HOME, 'fake-gh.json');
const state = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : { prs: [], calls: [] };
// The RAW remote URL — \`git remote get-url\` would apply the test's insteadOf rewrite.
const origin = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
const repo = origin.replace(/^https:\\/\\/github\\.com\\//, '').replace(/\\.git$/, '');
const branch = () => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
state.calls.push({ args, repo, token: process.env.GH_TOKEN || null });
const find = (head) => state.prs.find((p) => p.repo === repo && p.head === head && p.state === 'open');
let out = '';
if (args[0] === 'pr' && args[1] === 'list') {
  const pr = find(flag('--head'));
  if (pr) out = flag('--json') === 'isDraft' ? String(pr.draft) : pr.url;
} else if (args[0] === 'pr' && args[1] === 'create') {
  const head = flag('--head') || branch();
  const number = state.prs.length + 1;
  const pr = { repo, head, number, url: 'https://github.com/' + repo + '/pull/' + number, draft: args.includes('--draft'), title: flag('--title'), body: flag('--body'), state: 'open' };
  state.prs.push(pr);
  out = pr.url;
} else if (args[0] === 'pr' && args[1] === 'view') {
  // The run reads the pull request it links (MOTIR-10877), by branch or by URL.
  const ref = args[2];
  const pr = state.prs.find((p) => p.repo === repo && (p.url === ref || p.head === ref) && p.state === 'open');
  if (!pr) { fs.writeFileSync(store, JSON.stringify(state)); console.error('no pull requests found for ' + ref); process.exit(1); }
  out = JSON.stringify({ url: pr.url, state: 'OPEN', headRefName: pr.head, headRefOid: '', baseRefName: 'main' });
} else if (args[0] === 'pr' && args[1] === 'edit') {
  const pr = find(args[2]);
  if (pr) { pr.title = flag('--title') || pr.title; pr.body = flag('--body') || pr.body; }
} else if (args[0] === 'pr' && args[1] === 'ready') {
  const pr = find(args[2]);
  if (pr) pr.draft = false;
}
fs.writeFileSync(store, JSON.stringify(state));
if (out) console.log(out);
`;

const FAKE_CODEGRAPH = `#!/bin/sh
case "$1" in
  init) mkdir -p "$2/.codegraph" && echo db > "$2/.codegraph/codegraph.db" ;;
  --version) echo fake ;;
esac
exit 0
`;

// ── Scenarios ──────────────────────────────────────────────────────────────

type Card = {
  key: string;
  kind: 'story' | 'subtask';
  repos: string[];
  parentKey: string | null;
  children: string[];
  status: string;
};

type Scenario = {
  name: string;
  runId: string;
  /** The card the launcher is booted with — the leaf, or the parent. */
  key: string;
  command: 'run' | 'run_scope' | 'continue' | 'review' | 'fix';
  /** The run's legs, in the run's own order. */
  legs: string[];
  cards: Record<string, Card>;
  /** Extra markers the served prompt carries for the fake agent (`FAKE:big-output`). */
  agentMarkers?: string;
  /** A `continue` run: what its claim decided, as `GET /dispatch-runs/{id}` answers it. */
  continues?: {
    fromRunId: string;
    branch: string;
    branches: { repository: string; branch: string; cloneUrl: string }[];
    mode: 'card' | 'parent';
    landedKeys: string[];
    resumedKeys: string[];
  };
  /** A `review` run (MOTIR-6824): the version under review and its pull requests. */
  review?: {
    subjectVersion: string;
    verdict: 'pass' | 'changes_requested';
    /** The served prompt's extra markers for the fake agent. */
    markers?: string;
    /** Each pull request; `headSha` is filled when the remotes are seeded. */
    prs: { repo: string; number: number; headSha?: string }[];
  };
  /** A `fix` run (MOTIR-6929): each pull request's own branch, and the findings' markers. */
  fix?: {
    markers: string;
    prs: { repo: string; number: number; branch: string; headSha?: string }[];
  };
};

const leafCard = (key: string, repos: string[], parentKey: string | null = null): Card => ({
  key,
  kind: 'subtask',
  repos,
  parentKey,
  children: [],
  status: 'in_progress',
});

const SCENARIOS: Scenario[] = [
  {
    name: 'a one-repository leaf',
    runId: 'run_smoke_leaf1',
    key: 'ACME-7',
    command: 'run',
    legs: ['ACME-7'],
    cards: { 'ACME-7': leafCard('ACME-7', ['app-a']) },
  },
  {
    name: 'a leaf that spans two repositories',
    runId: 'run_smoke_leaf2',
    key: 'ACME-8',
    command: 'run',
    legs: ['ACME-8'],
    cards: { 'ACME-8': leafCard('ACME-8', ['app-a', 'app-b']) },
  },
  {
    name: 'a parent with two children in two repositories',
    runId: 'run_smoke_parent',
    key: 'ACME-10',
    command: 'run_scope',
    legs: ['ACME-11', 'ACME-12'],
    cards: parentCards(),
  },
];

/**
 * A one-repository leaf whose agent prints {@link bigAgentOutput} in one write
 * (MOTIR-10705): the hosted run that used to go silent after one refused batch and be
 * ended as a stall fifteen minutes later.
 */
const BIG_OUTPUT_SCENARIO: Scenario = {
  name: 'a one-repository leaf whose agent writes a 60 KB block',
  runId: 'run_smoke_bigout',
  key: 'ACME-9',
  command: 'run',
  legs: ['ACME-9'],
  cards: { 'ACME-9': leafCard('ACME-9', ['app-a']) },
  agentMarkers: 'FAKE:big-output',
};

function parentCards(): Record<string, Card> {
  return {
    'ACME-10': {
      key: 'ACME-10',
      kind: 'story',
      repos: ['app-a', 'app-b'],
      parentKey: null,
      children: ['ACME-11', 'ACME-12'],
      status: 'in_progress',
    },
    'ACME-11': leafCard('ACME-11', ['app-a'], 'ACME-10'),
    'ACME-12': leafCard('ACME-12', ['app-b'], 'ACME-10'),
  };
}

// The same three shapes CONTINUED (MOTIR-6795): each run died after pushing to
// its branch in every repository, and the server's continue claim opened the run
// this container adopts.
const DEAD_LEAF = 'hosted/ACME-7-dead';
const DEAD_LEAF2 = 'hosted/ACME-8-dead';
const DEAD_SESSION = 'motir/auto-20260927-0900';
const CONTINUE_SCENARIOS: Scenario[] = [
  {
    name: 'a one-repository leaf, continued',
    runId: 'run_smoke_cont_leaf1',
    key: 'ACME-7',
    command: 'continue',
    legs: ['ACME-7'],
    cards: { 'ACME-7': leafCard('ACME-7', ['app-a']) },
    continues: {
      fromRunId: 'run_smoke_dead_leaf1',
      branch: DEAD_LEAF,
      branches: [
        { repository: 'app-a', branch: DEAD_LEAF, cloneUrl: 'https://github.com/acme/app-a.git' },
      ],
      mode: 'card',
      landedKeys: [],
      resumedKeys: [],
    },
  },
  {
    name: 'a leaf that spans two repositories, continued',
    runId: 'run_smoke_cont_leaf2',
    key: 'ACME-8',
    command: 'continue',
    legs: ['ACME-8'],
    cards: { 'ACME-8': leafCard('ACME-8', ['app-a', 'app-b']) },
    continues: {
      fromRunId: 'run_smoke_dead_leaf2',
      branch: DEAD_LEAF2,
      branches: [
        { repository: 'app-a', branch: DEAD_LEAF2, cloneUrl: 'https://github.com/acme/app-a.git' },
        {
          repository: 'app-b',
          branch: `${DEAD_LEAF2}-b`,
          cloneUrl: 'https://github.com/acme/app-b.git',
        },
      ],
      mode: 'card',
      landedKeys: [],
      resumedKeys: [],
    },
  },
  {
    name: 'a parent, continued after its first child landed',
    runId: 'run_smoke_cont_parent',
    key: 'ACME-10',
    command: 'continue',
    legs: ['ACME-11', 'ACME-12'],
    cards: parentCards(),
    continues: {
      fromRunId: 'run_smoke_dead_parent',
      branch: DEAD_SESSION,
      branches: [
        {
          repository: 'app-a',
          branch: DEAD_SESSION,
          cloneUrl: 'https://github.com/acme/app-a.git',
        },
        {
          repository: 'app-b',
          branch: DEAD_SESSION,
          cloneUrl: 'https://github.com/acme/app-b.git',
        },
      ],
      mode: 'parent',
      landedKeys: ['ACME-11'],
      resumedKeys: [],
    },
  },
];

// The REVIEW (MOTIR-6824): the server opened a `review` run on the card's green
// delivery set; the container checks each pull request out at its reviewed head.
const REVIEW_SCENARIOS: Scenario[] = [
  {
    name: 'a review of a one-repository card',
    runId: 'run_smoke_review1',
    key: 'ACME-20',
    command: 'review',
    legs: ['ACME-20'],
    cards: { 'ACME-20': { ...leafCard('ACME-20', ['app-a']), status: 'implemented' } },
    review: {
      subjectVersion: 'acme/app-a#1@head',
      verdict: 'pass',
      prs: [{ repo: 'app-a', number: 1 }],
    },
  },
  {
    name: 'a review of a two-repository card',
    runId: 'run_smoke_review2',
    key: 'ACME-21',
    command: 'review',
    legs: ['ACME-21'],
    cards: { 'ACME-21': { ...leafCard('ACME-21', ['app-a', 'app-b']), status: 'implemented' } },
    review: {
      subjectVersion: 'acme/app-a#2@head,acme/app-b#3@head',
      verdict: 'changes_requested',
      prs: [
        { repo: 'app-a', number: 2 },
        { repo: 'app-b', number: 3 },
      ],
    },
  },
  {
    name: 'a review whose agent tries to push and comment, and writes no verdict',
    runId: 'run_smoke_review3',
    key: 'ACME-22',
    command: 'review',
    legs: ['ACME-22'],
    cards: { 'ACME-22': { ...leafCard('ACME-22', ['app-a']), status: 'implemented' } },
    review: {
      subjectVersion: 'acme/app-a#4@head',
      verdict: 'pass',
      markers: 'FAKE:try-push',
      prs: [{ repo: 'app-a', number: 4 }],
    },
  },
];

// The REPAIR (MOTIR-6929): a card a review sent back, the server's repair claim having
// opened the `fix` run; each pull request lives on its own branch in its remote.
const FIX_SCENARIOS: Scenario[] = [
  {
    name: 'a repair of a one-repository card sent back by a review',
    runId: 'run_smoke_fix1',
    key: 'ACME-30',
    command: 'fix',
    legs: ['ACME-30'],
    cards: { 'ACME-30': { ...leafCard('ACME-30', ['app-a']), status: 'implemented' } },
    fix: {
      markers: 'FAKE:fix FAKE:key=ACME-30',
      prs: [{ repo: 'app-a', number: 5, branch: 'hosted/ACME-30' }],
    },
  },
  {
    name: 'a repair of a two-repository card sent back by a review',
    runId: 'run_smoke_fix2',
    key: 'ACME-31',
    command: 'fix',
    legs: ['ACME-31'],
    cards: { 'ACME-31': { ...leafCard('ACME-31', ['app-a', 'app-b']), status: 'implemented' } },
    fix: {
      markers: 'FAKE:fix FAKE:key=ACME-31 FAKE:try-sneaky',
      prs: [
        { repo: 'app-a', number: 6, branch: 'hosted/ACME-31' },
        { repo: 'app-b', number: 7, branch: 'hosted/ACME-31-b' },
      ],
    },
  },
];

/** What the server's repair claim recorded on the run, as `GET /dispatch-runs/{id}` answers it. */
function repairOf(s: Scenario) {
  if (!s.fix) return null;
  return {
    repairClass: 'review',
    title: `Card ${s.key}`,
    pullRequests: s.fix.prs.map((pr) => ({
      repo: `acme/${pr.repo}`,
      number: pr.number,
      url: `https://github.com/acme/${pr.repo}/pull/${pr.number}`,
      branch: pr.branch,
      baseRef: 'main',
      headSha: pr.headSha ?? null,
    })),
    findings: {
      gate: 'agent_review',
      gateId: `gate_${s.key}`,
      subjectVersion: s.fix.prs.map((pr) => `acme/${pr.repo}#${pr.number}@${pr.headSha}`).join(','),
      findingsMd: `- README.md:1 — the criterion is not met in ${s.key}.\n${s.fix.markers}`,
      reviewerName: 'Review agent',
      decidedByLabel: 'Review agent',
      decidedUnderAuthority: 'review_agent',
      decidedAt: NOW,
    },
  };
}

// ── The stub Motir (and gateway) ───────────────────────────────────────────

const NOW = '2026-09-27T00:00:00Z';
const cloneUrl = (repo: string) => `https://github.com/acme/${repo}.git`;

type Recorded = { method: string; path: string; auth: string | undefined; body: unknown };

type Stub = {
  server: Server;
  url: string;
  requests: Recorded[];
  events: { kind: string; workItemKey?: string; body?: string }[];
  /** Every event batch the stub refused as the server does — 413, the whole batch. */
  refusedBatches: number;
  closed: unknown[];
  scenario: Scenario | null;
  modelCalls: { apiKey: string | undefined }[];
  /** Every request the stub could not answer — a route the CLI called that it lacks. */
  misses: string[];
  /** Every verdict POSTed to `…/agent-review` (MOTIR-6824). */
  verdicts: unknown[];
};

function workItemDetail(s: Scenario, key: string) {
  const card = s.cards[key]!;
  return {
    key,
    kind: card.kind,
    type: card.kind === 'story' ? null : 'code',
    title: `Card ${key}`,
    status: card.status,
    priority: 'high',
    assigneeId: OWNER,
    reporterId: OWNER,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    createdAt: NOW,
    updatedAt: NOW,
    descriptionMd: null,
    // Each text field's recorded language (MOTIR-8098) — required-and-nullable.
    languages: { title: null, description: null, explanation: null },
    parentKey: card.parentKey,
    folderId: null,
    folderPath: null,
    ancestorKeys: card.parentKey ? [card.parentKey] : [],
    children: card.children.map((child) => ({
      key: child,
      kind: 'subtask',
      title: `Card ${child}`,
      status: s.cards[child]!.status,
      priority: 'high',
      assigneeId: OWNER,
      estimateMinutes: null,
      storyPoints: null,
      parentKey: key,
      archived: false,
      // ACME-12 waits on ACME-11, so the drain's order is the run's order.
      dependencies: {
        blockedBy:
          child === 'ACME-12'
            ? [{ key: 'ACME-11', title: 'Card ACME-11', status: s.cards['ACME-11']!.status }]
            : [],
        blocks: [],
      },
    })),
    links: {
      blockedBy: [],
      blocks: [],
      relatesTo: [],
      duplicates: [],
      clones: [],
      supersedes: [],
      supersededBy: [],
    },
    readiness: {
      ready: true,
      openBlockers: [],
      blockedByAncestorKey: null,
      blockedByAncestorTitle: null,
    },
    labels: [],
    components: [],
    commentCount: 0,
    sprintId: null,
    targetRepo: card.repos[0] ?? null,
    targetRepos: card.repos,
    targetRepositories: [],
    executor: card.kind === 'story' ? null : 'coding_agent',
    difficulty: null,
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    archivedAt: null,
    deliveries: [],
  };
}

function dispatchRun(s: Scenario, status: 'running' | 'succeeded') {
  return {
    id: s.runId,
    projectId: 'prj_acme',
    command: s.command,
    origin: 'hosted',
    scopeWorkItemId: s.key === 'ACME-10' ? 'wi_acme_10' : null,
    scopeLabel: s.key === 'ACME-10' ? s.key : null,
    status,
    stopReason: null,
    lastHeartbeatAt: null,
    agent: 'opencode',
    model: MODEL.split('/')[1],
    startedAt: NOW,
    endedAt: status === 'running' ? null : NOW,
    createdById: OWNER,
    agentInstance: null,
    cards: s.legs.map((leg, position) => ({
      id: `card_${leg}`,
      key: leg,
      workItemId: `wi_${leg}`,
      position,
      disposition: 'queued',
      skipReason: null,
      sessionBranch: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      model: null,
    })),
    seq: 0,
    continues: s.continues ?? null,
    repair: repairOf(s),
  };
}

function prompt(
  s: Scenario,
  key: string,
  sessionBranch: string | null,
  continueFrom: string | null = null,
) {
  const card = s.cards[key]!;
  const mode = sessionBranch ? 'session' : continueFrom ? 'continue' : 'pr';
  return {
    key,
    prompt:
      `Build ${key}. FAKE:key=${key} FAKE:mode=${mode} FAKE:repos=${card.repos.join(',')}` +
      (sessionBranch ? ` FAKE:branch=${sessionBranch}` : '') +
      (s.agentMarkers ? ` ${s.agentMarkers}` : ''),
    parentKey: card.parentKey,
    targetRepo: card.repos[0] ?? null,
    targetRepoCloneUrl: card.repos[0] ? cloneUrl(card.repos[0]) : null,
    targetRepoDefaultBranch: 'main',
    targetRepos: card.repos.map((repo) => ({
      name: repo,
      cloneUrl: cloneUrl(repo),
      defaultBranch: 'main',
      delivery: 'awaiting',
    })),
    workflowMode: sessionBranch ? 'session_lineage' : 'per_item_pr',
    sessionBranch,
    advisories: [],
  };
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    url: '',
    requests: [],
    events: [],
    refusedBatches: 0,
    closed: [],
    scenario: null,
    modelCalls: [],
    misses: [],
    verdicts: [],
  };
  stub.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://stub');
      const path = url.pathname;
      const method = req.method ?? '';
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      stub.requests.push({ method, path, auth: req.headers.authorization, body });
      // `connection: close` — one request per socket (MOTIR-7311). With keep-alive
      // the CLI's fetch reuses an idle socket, and Node's server closes an idle
      // socket after 5 s. Under CPU load the two land together: the request dies
      // with `UND_ERR_SOCKET: other side closed`, the run reporter goes offline
      // as it is built to, and every later report, the close included, is skipped.
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(payload));
      };
      // The gateway: the fake agent's one model call, keyed on the run key.
      if (method === 'POST' && path === '/v1/messages') {
        stub.modelCalls.push({ apiKey: req.headers['x-api-key'] as string | undefined });
        return json(200, { id: 'msg_smoke', type: 'message', content: [] });
      }
      const s = stub.scenario;
      if (!s) return json(500, { message: 'no scenario' });
      if (req.headers.authorization !== `Bearer ${RUN_TOKEN}`)
        return json(401, { code: 'unauthenticated' });
      const m = (re: RegExp) => re.exec(path);
      let hit: RegExpExecArray | null;
      if (method === 'GET' && path === '/api/v1/me') {
        return json(200, {
          user: { id: OWNER, name: DISPATCHER, email: 'dana@example.com' },
          workspaceId: 'ws_acme',
          permissions: [],
        });
      }
      if (method === 'GET' && path === `/api/v1/dispatch-runs/${s.runId}`) {
        return json(200, dispatchRun(s, 'running'));
      }
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/events`) {
        const events =
          (body as { events?: { kind: string; workItemKey?: string; body?: string }[] })?.events ??
          [];
        // The server's own rule (`appendEventsWithin`, MOTIR-10705's root cause): a body over
        // 16 KiB refuses the WHOLE batch with 413, and nothing in it lands.
        if (events.some((e) => e.body !== undefined && Buffer.byteLength(e.body) > 16 * 1024)) {
          stub.refusedBatches += 1;
          return json(413, {
            code: 'DISPATCH_RUN_BODY_TOO_LARGE',
            error: 'An event body exceeds the 16384-byte limit.',
          });
        }
        stub.events.push(...events);
        return json(200, {
          runId: s.runId,
          appended: events.length,
          seq: stub.events.length,
          cards: [],
        });
      }
      // The heartbeat (MOTIR-6530): the reporter beats the moment it adopts the
      // run (MOTIR-7328), so every shape reaches this route at least once.
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/heartbeat`) {
        res.writeHead(204, { connection: 'close' });
        return res.end();
      }
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/close`) {
        stub.closed.push(body);
        return json(200, dispatchRun(s, 'succeeded'));
      }
      if (method === 'GET' && path === `/api/v1/dispatch-runs/${s.runId}/close-out-prompt`) {
        return json(200, {
          runId: s.runId,
          targetKey: s.key,
          prompt: 'Write How to test. FAKE:closeout',
          landedKeys: s.legs,
        });
      }
      if (method === 'POST' && path === `/api/v1/dispatch-runs/${s.runId}/git-credential`) {
        const repos = [...new Set(Object.values(s.cards).flatMap((c) => c.repos))];
        return json(200, {
          credentials: repos.map((repo) => ({
            repository: `acme/${repo}`,
            token: `ghs_token_for_${repo}`,
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            authorName: BOTS[`acme/${repo}`]!.name,
            authorEmail: BOTS[`acme/${repo}`]!.email,
          })),
          dispatchedBy: DISPATCHER,
        });
      }
      if (method === 'POST' && path === '/api/v1/sessions/complete') {
        const b = body as { sessionBranch: string; keys?: string[] };
        return json(200, {
          sessionBranch: b.sessionBranch,
          results: (b.keys ?? []).map((key) => ({ key, outcome: 'completed' })),
        });
      }
      if ((hit = m(/^\/api\/v1\/work-items\/([A-Z0-9-]+)(\/[a-z-]+)?$/))) {
        const key = hit[1]!;
        const sub = hit[2] ?? '';
        const card = s.cards[key];
        if (!card) return json(404, { code: 'not_found' });
        if (method === 'GET' && sub === '') return json(200, workItemDetail(s, key));
        if (method === 'GET' && sub === '/designs') return json(200, { designs: [] });
        if (method === 'GET' && sub === '/how-to-test') return json(200, { key, record: null });
        if (method === 'GET' && sub === '/review-prompt' && s.review) {
          const r = s.review;
          return json(200, {
            key,
            gateId: `gate_${key}`,
            subjectVersion: r.subjectVersion,
            pullRequests: r.prs.map((pr) => ({
              repository: `acme/${pr.repo}`,
              number: pr.number,
              headSha: pr.headSha,
              baseBranch: 'main',
              headBranch: `feat/${key}`,
              url: `https://github.com/acme/${pr.repo}/pull/${pr.number}`,
            })),
            prompt:
              `You are REVIEWING ${key}. FAKE:review FAKE:key=${key} ` +
              `FAKE:repos=${r.prs.map((pr) => pr.repo).join(',')} FAKE:verdict=${r.verdict}` +
              `${r.markers ? ` ${r.markers}` : ''}\n`,
          });
        }
        if (method === 'POST' && sub === '/agent-review' && s.review) {
          stub.verdicts.push(body);
          const b = body as { verdict: 'pass' | 'changes_requested'; subjectVersion: string };
          return json(200, {
            key,
            gateId: `gate_${key}`,
            verdict: b.verdict,
            state: b.verdict === 'pass' ? 'approved' : 'changes_requested',
            subjectVersion: b.subjectVersion,
            decidedAt: NOW,
            // The bugs the verdict logged (MOTIR-10513): the stub's verdicts carry none.
            bugs: [],
          });
        }
        if (method === 'GET' && sub === '/dispatch-prompt') {
          return json(
            200,
            prompt(
              s,
              key,
              url.searchParams.get('sessionBranch'),
              url.searchParams.get('continueFrom'),
            ),
          );
        }
        if (method === 'POST' && sub === '/claim') {
          card.status = 'in_progress';
          return json(200, {
            key,
            title: `Card ${key}`,
            outcome: 'mine',
            claimed: true,
            status: { key: 'in_progress', category: 'in_progress' },
            assignee: { id: OWNER, name: DISPATCHER },
            transitionedBy: null,
            transitionedAt: null,
          });
        }
        if (method === 'POST' && sub === '/transitions') {
          card.status = (body as { status?: string })?.status ?? card.status;
          return json(200, workItemDetail(s, key));
        }
        if (method === 'POST' && sub === '/integration') {
          card.status = 'implemented';
          return json(200, {
            key,
            status: 'implemented',
            sessionBranch: (body as { sessionBranch?: string })?.sessionBranch ?? null,
            updatedAt: NOW,
            implementationSource: null,
            implementationHarness: 'opencode',
            implementationModel: null,
          });
        }
        if (method === 'POST' && sub === '/pull-requests') {
          const b = body as { url?: string; repo?: string; number?: number; title?: string };
          return json(200, {
            key,
            created: true,
            pullRequest: {
              repo: b.repo ?? 'acme/app-a',
              number: b.number ?? 1,
              title: b.title ?? key,
              url: b.url ?? 'https://github.com/acme/app-a/pull/1',
              state: 'open',
              ci: null,
            },
          });
        }
      }
      if (method === 'GET' && path === '/api/v1/projects/ACME/work-items') {
        return json(200, { items: [], nextCursor: null });
      }
      stub.misses.push(`${method} ${path}`);
      return json(404, { code: 'not_found', message: `the stub has no ${method} ${path}` });
    });
  });
  await new Promise<void>((r) => stub.server.listen(0, '127.0.0.1', () => r()));
  stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
  return stub;
}

// ── The world a scenario runs in ───────────────────────────────────────────

const temps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

type World = {
  env: NodeJS.ProcessEnv;
  home: string;
  workspace: string;
  remotes: Record<string, string>;
};

/** Bare remotes seeded with one commit on `main`, the fakes on PATH, and the redirect. */
function makeWorld(stub: Stub): World {
  const root = tempDir('hosted-smoke-');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  for (const dir of [home, workspace, bin]) mkdirSync(dir, { recursive: true });
  const remotes: Record<string, string> = {};
  const redirect: string[] = [];
  for (const repo of ['app-a', 'app-b']) {
    const seed = join(root, `seed-${repo}`);
    mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    writeFileSync(join(seed, 'README.md'), `# ${repo}\n`);
    git(seed, 'add', 'README.md');
    git(
      seed,
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@example.com',
      'commit',
      '-q',
      '-m',
      'seed',
    );
    const bare = join(root, `${repo}.git`);
    git(root, 'clone', '-q', '--bare', seed, bare);
    remotes[repo] = bare;
    redirect.push(`[url "${bare}"]`, `\tinsteadOf = https://github.com/acme/${repo}.git`);
    redirect.push(`[url "${bare}"]`, `\tinsteadOf = https://github.com/acme/${repo}`);
  }
  const redirectFile = join(home, 'smoke-redirect.gitconfig');
  writeFileSync(redirectFile, `${redirect.join('\n')}\n`);
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  write('opencode', FAKE_OPENCODE);
  write('gh', FAKE_GH);
  write('codegraph', FAKE_CODEGRAPH);
  // Every `git` the CLI and the agent run, logged, then the real one (MOTIR-6824's
  // "zero pushes" is read from this log, not inferred).
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  write('git', `#!/bin/sh\necho "$*" >> "$HOME/git-commands.log"\nexec "${realGit}" "$@"\n`);
  // The launcher execs `MOTIR_CLI_BIN`: the CLI from source, as the image runs it built.
  write('motir', `#!/bin/sh\nexec "${TSX}" "${CLI_SRC_INDEX}" "$@"\n`);

  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('MOTIR_') || k === 'GH_TOKEN' || k === 'GITHUB_TOKEN')
      continue;
    env[k] = v;
  }
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    MOTIR_CONFIG_HOME: join(home, '.motir'),
    MOTIR_CLI_BIN: join(bin, 'motir'),
    MOTIR_WORKSPACE: workspace,
    MOTIR_API_URL: stub.url,
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_GATEWAY_URL: stub.url,
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_MODEL: MODEL,
    GIT_CONFIG_SYSTEM: redirectFile,
    GIT_TERMINAL_PROMPT: '0',
  });
  return { env, home, workspace, remotes };
}

function launch(env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRYPOINT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

type Pr = { repo: string; head: string; draft: boolean; body: string; state: string };
const readPrs = (
  home: string,
): { prs: Pr[]; calls: { args: string[]; repo: string; token: string | null }[] } =>
  existsSync(join(home, 'fake-gh.json'))
    ? JSON.parse(readFileSync(join(home, 'fake-gh.json'), 'utf8'))
    : { prs: [], calls: [] };

const readAgents = (
  home: string,
): { envKeys: string[]; leaksRunToken: boolean; closeout: boolean; model: string }[] =>
  readFileSync(join(home, 'agent-records.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

// ── Layer 0: the launcher's own decisions ──────────────────────────────────

describe('the hosted launcher (MOTIR-6560)', () => {
  const full = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    MOTIR_DISPATCH_RUN_ID: 'run_1',
    MOTIR_WORK_ITEM_KEY: 'ACME-7',
    MOTIR_API_URL: 'https://motir.example',
    MOTIR_RUN_TOKEN: RUN_TOKEN,
    MOTIR_GATEWAY_URL: 'https://gateway.example',
    MOTIR_RUN_KEY: RUN_KEY,
    MOTIR_MODEL: MODEL,
    ...over,
  });

  it('runs `motir run <KEY>` by default, and `motir continue|review|fix <KEY>` in their modes', () => {
    expect(cliArgs(readLaunch(full()))).toEqual(['run', 'ACME-7']);
    expect(cliArgs(readLaunch(full({ MOTIR_RUN_MODE: 'continue' })))).toEqual([
      'continue',
      'ACME-7',
    ]);
    // MOTIR-6824 (`hosted-agent-run.md` §8.1): the launcher's third mode.
    expect(cliArgs(readLaunch(full({ MOTIR_RUN_MODE: 'review' })))).toEqual(['review', 'ACME-7']);
    // MOTIR-6929 (`hosted-agent-run.md` §8.6): the fourth mode, a hosted repair.
    expect(cliArgs(readLaunch(full({ MOTIR_RUN_MODE: 'fix' })))).toEqual(['fix', 'ACME-7']);
    expect(RUN_MODES).toEqual(['run', 'continue', 'review', 'fix']);
  });

  it('names EVERY missing input at once, and refuses a bad key or mode', () => {
    expect(() => readLaunch({})).toThrow(
      `missing required input(s): ${REQUIRED_INPUTS.join(', ')}`,
    );
    expect(() => readLaunch(full({ MOTIR_WORK_ITEM_KEY: 'not a key' }))).toThrow(/work item key/);
    expect(() => readLaunch(full({ MOTIR_RUN_MODE: 'retry' }))).toThrow(
      /"run", "continue", "review" or "fix", got "retry"/,
    );
  });

  it('reads no repository, base ref, git token or git author', () => {
    const source = readFileSync(ENTRYPOINT, 'utf8');
    for (const retired of [
      'MOTIR_REPOSITORY',
      'MOTIR_BASE_REF',
      'MOTIR_GIT_TOKEN',
      'MOTIR_GIT_AUTHOR_NAME',
      'MOTIR_GIT_AUTHOR_EMAIL',
    ]) {
      expect(source.includes(`env.${retired}`) || source.includes(`'${retired}'`)).toBe(false);
    }
  });

  it('exits 20 and starts nothing when an input is missing', async () => {
    const res = await launch({ PATH: process.env.PATH ?? '', MOTIR_CLI_BIN: '/nonexistent/motir' });
    expect(res.code).toBe(SETUP_FAILED);
    expect(res.stderr).toContain('missing required input(s): MOTIR_DISPATCH_RUN_ID');
  });
});

// ── Layer 1: the three run shapes, as processes ────────────────────────────

describe('the hosted image, as processes: the launcher runs the real CLI (MOTIR-6560)', () => {
  let stub: Stub;

  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
  });
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function arm(s: Scenario): World {
    // Fresh card statuses per scenario — the stub mutates them as the run goes.
    for (const card of Object.values(s.cards)) card.status = 'in_progress';
    stub.scenario = s;
    stub.requests.length = 0;
    stub.events.length = 0;
    stub.refusedBatches = 0;
    stub.closed.length = 0;
    stub.modelCalls.length = 0;
    stub.misses.length = 0;
    stub.verdicts.length = 0;
    const world = makeWorld(stub);
    world.env.MOTIR_DISPATCH_RUN_ID = s.runId;
    world.env.MOTIR_WORK_ITEM_KEY = s.key;
    return world;
  }

  /** What every shape shares: adopted, never opened; closed once; nothing off-route. */
  function expectAdoptedAndClosed(s: Scenario) {
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain(`GET /api/v1/dispatch-runs/${s.runId}`);
    expect(paths).not.toContain('POST /api/v1/dispatch-runs');
    // The adopted run beat at once, so it is never read as a legacy run (MOTIR-7328).
    expect(paths).toContain(`POST /api/v1/dispatch-runs/${s.runId}/heartbeat`);
    expect(stub.requests.filter((r) => r.path === '/api/v1/workspaces')).toEqual([]);
    // Every Motir call carried the run credential (the gateway call carries the run key).
    const motir = stub.requests.filter((r) => r.path.startsWith('/api/'));
    expect(motir.filter((r) => r.auth !== `Bearer ${RUN_TOKEN}`)).toEqual([]);
    expect(paths.filter((p) => p === `POST /api/v1/dispatch-runs/${s.runId}/close`)).toHaveLength(
      1,
    );
    // The stub answered everything the CLI asked — no route fell through.
    expect(stub.misses).toEqual([]);
  }

  /** Every agent the CLI spawned: OpenCode on the run model, never holding the run credential. */
  function expectAgentsConfined(home: string) {
    const agents = readAgents(home);
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent.model).toBe(MODEL);
      expect(agent.leaksRunToken).toBe(false);
      expect(agent.envKeys).not.toContain('MOTIR_RUN_TOKEN');
      expect(agent.envKeys).not.toContain('GH_TOKEN');
    }
    // The model call went through the gateway on the run key, as the egress document says.
    expect(stub.modelCalls.length).toBeGreaterThan(0);
    expect(stub.modelCalls.every((c) => c.apiKey === RUN_KEY)).toBe(true);
  }

  /** The commit on a remote branch: its author is the repository's App bot. */
  function authorOn(bare: string, ref: string): string {
    return git(bare, 'log', '-1', '--format=%an <%ae>', ref).trim();
  }

  it('a one-repository leaf: one pull request, committed as the App, the shared event sequence', async () => {
    const s = SCENARIOS[0]!;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`)).toEqual(['acme/app-a hosted/ACME-7']);
    // `gh` got THAT repository's token, for that one call, through the CLI's shim.
    expect(calls.filter((c) => c.args[1] === 'create').map((c) => c.token)).toEqual([
      'ghs_token_for_app-a',
    ]);
    expect(authorOn(world.remotes['app-a']!, 'hosted/ACME-7')).toBe(
      `${BOTS['acme/app-a']!.name} <${BOTS['acme/app-a']!.email}>`,
    );
    // The checkout was indexed, and the index never reached the commit.
    expect(existsSync(join(world.workspace, 'app-a', '.codegraph'))).toBe(true);
    expect(
      git(world.remotes['app-a']!, 'ls-tree', '-r', '--name-only', 'hosted/ACME-7'),
    ).not.toContain('.codegraph');

    const kinds = stub.events.map((e) => e.kind);
    for (const kind of ['checkout_ready', 'agent_started', 'agent_exited'])
      expect(kinds).toContain(kind);
    expect(kinds.indexOf('checkout_ready')).toBeLessThan(kinds.indexOf('agent_started'));
    expect(kinds.indexOf('agent_started')).toBeLessThan(kinds.indexOf('agent_exited'));
    expect(kinds).not.toContain('run_opened');
    expect(s.cards['ACME-7']!.status).toBe('implemented');
  }, 120_000);

  it('an agent that writes a block over 16 KiB keeps the run reporting to the end (MOTIR-10705)', async () => {
    const s = BIG_OUTPUT_SCENARIO;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);

    // Nothing was refused: no body the CLI sent was over the server's limit, and none
    // was over the tee's own 4 KiB ceiling, counted in UTF-8 bytes.
    expect(stub.refusedBatches).toBe(0);
    const logs = stub.events.filter((e) => e.kind === 'log');
    expect(logs.length).toBeGreaterThan(1);
    for (const e of logs) expect(Buffer.byteLength(e.body ?? '')).toBeLessThanOrEqual(4096);
    // The block arrived WHOLE, in order, cut only on character boundaries.
    expect(logs.map((e) => e.body).join('')).toContain(bigAgentOutput());
    // …and reporting went on after it: the leg's exit and its settle still reached Motir,
    // which is what keeps a hosted run from being read as stalled.
    const kinds = stub.events.map((e) => e.kind);
    expect(kinds.lastIndexOf('log')).toBeLessThan(kinds.indexOf('agent_exited'));
    expect(kinds).toContain('card_settled');
    expect(s.cards['ACME-9']!.status).toBe('implemented');
  }, 120_000);

  it('a leaf across two repositories: both cloned as siblings, one pull request in each, each as its own App', async () => {
    const s = SCENARIOS[1]!;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    expect(existsSync(join(world.workspace, 'app-a', '.git'))).toBe(true);
    expect(existsSync(join(world.workspace, 'app-b', '.git'))).toBe(true);
    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => p.repo).sort()).toEqual(['acme/app-a', 'acme/app-b']);
    expect(
      calls
        .filter((c) => c.args[1] === 'create')
        .map((c) => `${c.repo} ${c.token}`)
        .sort(),
    ).toEqual(['acme/app-a ghs_token_for_app-a', 'acme/app-b ghs_token_for_app-b']);
    for (const repo of ['app-a', 'app-b']) {
      const bot = BOTS[`acme/${repo}`]!;
      expect(authorOn(world.remotes[repo]!, 'hosted/ACME-8')).toBe(`${bot.name} <${bot.email}>`);
    }
    expect(s.cards['ACME-8']!.status).toBe('implemented');
  }, 120_000);

  it('a parent: its children in order on one session branch per repository, a draft per repository made ready at close-out', async () => {
    const s = SCENARIOS[2]!;
    const world = arm(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    // No scope claim and no ready-set read: the legs are the run's.
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.some((p) => p.includes('scope-claims'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/ready'))).toBe(false);
    // Each child integrated, in the run's order.
    const integrated = stub.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/integration'))
      .map((r) => r.path.split('/')[4]);
    expect(integrated).toEqual(['ACME-11', 'ACME-12']);
    const branches = new Set(
      stub.requests
        .filter((r) => r.path.endsWith('/integration'))
        .map((r) => (r.body as { sessionBranch: string }).sessionBranch),
    );
    expect(branches.size).toBe(1);
    const [session] = [...branches] as [string];

    // One pull request per repository, opened as a DRAFT and READY at the end.
    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`).sort()).toEqual([
      `acme/app-a ${session}`,
      `acme/app-b ${session}`,
    ]);
    expect(
      calls.filter((c) => c.args[1] === 'create').every((c) => c.args.includes('--draft')),
    ).toBe(true);
    // The CLI's own `gh` calls went through its shim, each with its repository's token.
    expect(
      calls
        .filter((c) => c.args[1] === 'create')
        .map((c) => `${c.repo} ${c.token}`)
        .sort(),
    ).toEqual(['acme/app-a ghs_token_for_app-a', 'acme/app-b ghs_token_for_app-b']);
    expect(prs.every((p) => p.draft === false)).toBe(true);
    // Every pull request names the dispatcher (the CLI's hosted attribution).
    expect(prs.every((p) => p.body.includes(DISPATCHER))).toBe(true);
    for (const repo of ['app-a', 'app-b']) {
      const bot = BOTS[`acme/${repo}`]!;
      expect(authorOn(world.remotes[repo]!, session)).toBe(`${bot.name} <${bot.email}>`);
    }
    // The close-out's How-to-test agent ran, once, after the children.
    const agents = readAgents(world.home);
    expect(agents.filter((a) => a.closeout)).toHaveLength(1);
    expect(agents.at(-1)!.closeout).toBe(true);
    expect(s.cards['ACME-11']!.status).toBe('implemented');
    expect(s.cards['ACME-12']!.status).toBe('implemented');
  }, 180_000);

  /** The dead run's work: one commit on `branch` in `repo`'s remote, as it pushed it. */
  function seedDead(world: World, repo: string, branch: string, key: string) {
    const dir = tempDir('hosted-smoke-dead-');
    git(dir, 'clone', '-q', world.remotes[repo]!, 'w');
    const w = join(dir, 'w');
    git(w, 'switch', '-q', '-c', branch);
    writeFileSync(join(w, `${key}-dead.txt`), `what the dead run pushed for ${key}\n`);
    git(w, 'add', '.');
    git(
      w,
      '-c',
      'user.name=Dead',
      '-c',
      'user.email=dead@example.com',
      'commit',
      '-q',
      '-m',
      `${key}: before the run died`,
    );
    git(w, 'push', '-q', 'origin', branch);
  }

  /** The commit subjects on a remote branch, newest first, less the seed. */
  const subjects = (bare: string, ref: string) =>
    git(bare, 'log', '--format=%s', ref)
      .trim()
      .split('\n')
      .filter((l) => l !== 'seed');

  function armContinue(s: Scenario): World {
    const world = arm(s);
    world.env.MOTIR_RUN_MODE = 'continue';
    return world;
  }

  it('a one-repository leaf, continued: on the dead branch, both commits, one pull request', async () => {
    const s = CONTINUE_SCENARIOS[0]!;
    const world = armContinue(s);
    seedDead(world, 'app-a', DEAD_LEAF, 'ACME-7');
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    // Adopted, never claimed again: the server's continue claim opened this run.
    expect(paths.some((p) => p.endsWith('/continue'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/claim'))).toBe(false);
    const prompts = stub.requests.filter((r) => r.path.endsWith('/dispatch-prompt'));
    expect(prompts).toHaveLength(1);
    const { prs } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`)).toEqual([`acme/app-a ${DEAD_LEAF}`]);
    expect(subjects(world.remotes['app-a']!, DEAD_LEAF)).toEqual([
      'ACME-7: the change in app-a',
      'ACME-7: before the run died',
    ]);
    expect(authorOn(world.remotes['app-a']!, DEAD_LEAF)).toBe(
      `${BOTS['acme/app-a']!.name} <${BOTS['acme/app-a']!.email}>`,
    );
    expect(s.cards['ACME-7']!.status).toBe('implemented');
  }, 120_000);

  it('a leaf across two repositories, continued: each repository on its OWN dead branch, a pull request in each', async () => {
    const s = CONTINUE_SCENARIOS[1]!;
    const world = armContinue(s);
    seedDead(world, 'app-a', DEAD_LEAF2, 'ACME-8');
    seedDead(world, 'app-b', `${DEAD_LEAF2}-b`, 'ACME-8');
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    const { prs } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`).sort()).toEqual([
      `acme/app-a ${DEAD_LEAF2}`,
      `acme/app-b ${DEAD_LEAF2}-b`,
    ]);
    for (const [repo, branch] of [
      ['app-a', DEAD_LEAF2],
      ['app-b', `${DEAD_LEAF2}-b`],
    ] as const) {
      expect(subjects(world.remotes[repo]!, branch)).toEqual([
        `ACME-8: the change in ${repo}`,
        'ACME-8: before the run died',
      ]);
      const bot = BOTS[`acme/${repo}`]!;
      expect(authorOn(world.remotes[repo]!, branch)).toBe(`${bot.name} <${bot.email}>`);
    }
    expect(s.cards['ACME-8']!.status).toBe('implemented');
  }, 120_000);

  it('a parent, continued: the landed child is not run again, the rest resume on the session branch in every repository, through the draft it already has', async () => {
    const s = CONTINUE_SCENARIOS[2]!;
    const world = armContinue(s);
    s.cards['ACME-11']!.status = 'implemented';
    seedDead(world, 'app-a', DEAD_SESSION, 'ACME-11');
    seedDead(world, 'app-b', DEAD_SESSION, 'ACME-12');
    // The dead run opened its draft in app-a when ACME-11 landed.
    writeFileSync(
      join(world.home, 'fake-gh.json'),
      JSON.stringify({
        prs: [
          {
            repo: 'acme/app-a',
            head: DEAD_SESSION,
            number: 1,
            url: 'https://github.com/acme/app-a/pull/1',
            draft: true,
            title: 'the dead run',
            body: `Dispatched by ${DISPATCHER}.`,
            state: 'open',
          },
        ],
        calls: [],
      }),
    );
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);

    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.some((p) => p.includes('scope-claims'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/continue'))).toBe(false);
    // Only the child that had not landed ran, on the dead run's session branch.
    const integrated = stub.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/integration'))
      .map((r) => `${r.path.split('/')[4]} ${(r.body as { sessionBranch: string }).sessionBranch}`);
    expect(integrated).toEqual([`ACME-12 ${DEAD_SESSION}`]);
    const prompted = stub.requests
      .filter((r) => r.path.endsWith('/dispatch-prompt'))
      .map((r) => r.path.split('/')[4]);
    expect(prompted).toEqual(['ACME-12']);

    // app-a's draft was reused, app-b's opened now; one pull request per
    // repository, all on the session branch, all ready at the close-out.
    const { prs, calls } = readPrs(world.home);
    expect(prs.map((p) => `${p.repo} ${p.head}`).sort()).toEqual([
      `acme/app-a ${DEAD_SESSION}`,
      `acme/app-b ${DEAD_SESSION}`,
    ]);
    expect(calls.filter((c) => c.args[1] === 'create').map((c) => c.repo)).toEqual(['acme/app-b']);
    expect(prs.every((p) => p.draft === false)).toBe(true);
    expect(subjects(world.remotes['app-b']!, DEAD_SESSION).slice(-2)).toEqual([
      'ACME-12: the change in app-b',
      'ACME-12: before the run died',
    ]);
    expect(subjects(world.remotes['app-a']!, DEAD_SESSION)).toContain(
      'ACME-11: before the run died',
    );
    expect(s.cards['ACME-12']!.status).toBe('implemented');
  }, 180_000);

  // ── The REVIEW (MOTIR-6824) ──────────────────────────────────────────────

  /**
   * Seed each pull request's reviewed head as `refs/pull/<n>/head` in its remote — on
   * no branch, as GitHub keeps a pull request's head — and boot in review mode.
   */
  function armReview(s: Scenario): World {
    const world = arm(s);
    for (const pr of s.review!.prs) {
      const dir = tempDir('hosted-smoke-pr-');
      git(dir, 'clone', '-q', world.remotes[pr.repo]!, 'w');
      const w = join(dir, 'w');
      writeFileSync(join(w, `${s.key}.txt`), `the change under review in ${pr.repo}\n`);
      git(w, 'add', '.');
      git(
        w,
        '-c',
        'user.name=Dev',
        '-c',
        'user.email=dev@example.com',
        'commit',
        '-q',
        '-m',
        `${s.key} in ${pr.repo}`,
      );
      git(w, 'push', '-q', 'origin', `HEAD:refs/pull/${pr.number}/head`);
      pr.headSha = git(w, 'rev-parse', 'HEAD').trim();
    }
    world.env.MOTIR_RUN_MODE = 'review';
    world.env.MOTIR_REVIEW_GATE_ID = `gate_${s.key}`;
    world.env.MOTIR_REVIEW_VERSION = s.review!.subjectVersion;
    return world;
  }

  /** Every ref of every remote — what a push would change. */
  const refsOf = (world: World) =>
    Object.fromEntries(
      Object.entries(world.remotes).map(([repo, bare]) => [repo, git(bare, 'show-ref')]),
    );

  const gitCommands = (home: string): string[] =>
    existsSync(join(home, 'git-commands.log'))
      ? readFileSync(join(home, 'git-commands.log'), 'utf8').trim().split('\n')
      : [];

  const readReviews = (
    home: string,
  ): {
    heads: Record<string, string>;
    tried: { push: number; gh: number } | null;
    verdictFile: string | null;
  }[] =>
    readFileSync(join(home, 'review-records.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  /** What every review shares: adopted, never claimed; nothing pushed; `gh` never reached. */
  function expectReadOnly(s: Scenario, world: World, before: Record<string, string>) {
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths.some((p) => p.endsWith('/claim') || p.endsWith('/continue'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/transitions') || p.endsWith('/pull-requests'))).toBe(
      false,
    );
    // Nothing reached a remote, and the fake `gh` was never invoked at all.
    expect(refsOf(world)).toEqual(before);
    expect(readPrs(world.home).calls).toEqual([]);
  }

  it('a review of a one-repository card: checked out at its reviewed head, ONE verdict with the version, nothing pushed', async () => {
    const s = REVIEW_SCENARIOS[0]!;
    const world = armReview(s);
    const before = refsOf(world);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectReadOnly(s, world, before);
    expect(gitCommands(world.home).filter((c) => /(^|\s)push(\s|$)/.test(c))).toEqual([]);

    const [review] = readReviews(world.home);
    expect(review!.heads).toEqual({ 'app-a': s.review!.prs[0]!.headSha });
    expect(stub.verdicts).toEqual([
      {
        subjectVersion: s.review!.subjectVersion,
        verdict: 'pass',
        summaryMd: 'Meets the card.',
        findingsMd: null,
      },
    ]);
    // The verdict file lived outside every checkout, and is gone.
    expect(review!.verdictFile!.startsWith(world.workspace)).toBe(false);
    expect(existsSync(review!.verdictFile!)).toBe(false);
    expect(stub.closed).toEqual([{ stopReason: 'completed' }]);
  }, 120_000);

  it('a review of a two-repository card: both at their reviewed heads, ONE verdict over both, zero pushes and zero gh', async () => {
    const s = REVIEW_SCENARIOS[1]!;
    const world = armReview(s);
    const before = refsOf(world);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expectReadOnly(s, world, before);
    expect(gitCommands(world.home).filter((c) => /(^|\s)push(\s|$)/.test(c))).toEqual([]);

    expect(existsSync(join(world.workspace, 'app-a', '.git'))).toBe(true);
    expect(existsSync(join(world.workspace, 'app-b', '.git'))).toBe(true);
    const [review] = readReviews(world.home);
    expect(review!.heads).toEqual({
      'app-a': s.review!.prs[0]!.headSha,
      'app-b': s.review!.prs[1]!.headSha,
    });
    expect(stub.verdicts).toHaveLength(1);
    expect(stub.verdicts[0]).toMatchObject({
      subjectVersion: s.review!.subjectVersion,
      verdict: 'changes_requested',
      findingsMd: expect.stringContaining('app-b/README.md:1'),
    });
  }, 120_000);

  it('a review whose agent tries to push and comment: both refused, nothing reaches a remote, no verdict posted, exit non-zero', async () => {
    const s = REVIEW_SCENARIOS[2]!;
    const world = armReview(s);
    const before = refsOf(world);
    const res = await launch(world.env);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/no verdict was submitted — the agent wrote no verdict file/);
    expectReadOnly(s, world, before);

    const [review] = readReviews(world.home);
    expect(review!.tried!.push).not.toBe(0);
    expect(review!.tried!.gh).not.toBe(0);
    expect(stub.verdicts).toEqual([]);
    expect(stub.closed).toEqual([{ stopReason: 'halted' }]);
  }, 120_000);

  // ── The REPAIR (MOTIR-6929) ──────────────────────────────────────────────

  /** Seed each pull request's OWN branch in its remote — the work a review sent back. */
  function armFix(s: Scenario): World {
    const world = arm(s);
    for (const pr of s.fix!.prs) {
      seedDead(world, pr.repo, pr.branch, s.key);
      pr.headSha = git(world.remotes[pr.repo]!, 'rev-parse', `refs/heads/${pr.branch}`).trim();
    }
    world.env.MOTIR_RUN_MODE = 'fix';
    return world;
  }

  const readFixes = (
    home: string,
  ): {
    checkouts: { branch: string; dir: string }[];
    heads: Record<string, string>;
    tried: {
      push: { status: number; stderr: string };
      gh: { status: number; stderr: string };
    } | null;
    prompt: string;
  }[] =>
    readFileSync(join(home, 'fix-records.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

  /** Every branch a remote has, less `main`. */
  const branchesOf = (bare: string) =>
    git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
      .trim()
      .split('\n')
      .filter((ref) => ref && ref !== 'refs/heads/main');

  /** What every repair shares: adopted, never claimed; own branches only; zero `gh pr`; no status. */
  function expectRepaired(s: Scenario, world: World) {
    expectAdoptedAndClosed(s);
    expectAgentsConfined(world.home);
    const paths = stub.requests.map((r) => `${r.method} ${r.path}`);
    // Adopted, never claimed: the server's repair claim opened this run.
    expect(paths.some((p) => /\/(repair|claim|continue)$/.test(p))).toBe(false);
    // No status write, no link, no dispatch prompt — a repair moves nothing.
    expect(
      paths.some(
        (p) =>
          p.endsWith('/transitions') ||
          p.endsWith('/pull-requests') ||
          p.endsWith('/integration') ||
          p.endsWith('/dispatch-prompt'),
      ),
    ).toBe(false);
    expect(stub.events.map((e) => e.kind)).not.toContain('run_opened');
    expect(stub.closed).toEqual([{ stopReason: 'completed' }]);

    // Each pull request's OWN branch carries the fix on top of what it had, as the App.
    for (const pr of s.fix!.prs) {
      const bare = world.remotes[pr.repo]!;
      expect(subjects(bare, pr.branch)).toEqual([
        `${s.key}: answer the review on ${pr.branch}`,
        `${s.key}: before the run died`,
      ]);
      const bot = BOTS[`acme/${pr.repo}`]!;
      expect(authorOn(bare, pr.branch)).toBe(`${bot.name} <${bot.email}>`);
    }
    // ZERO new branches in any remote, zero `git switch -c`, zero `gh pr`.
    for (const [repo, bare] of Object.entries(world.remotes)) {
      expect(branchesOf(bare).sort()).toEqual(
        s
          .fix!.prs.filter((pr) => pr.repo === repo)
          .map((pr) => `refs/heads/${pr.branch}`)
          .sort(),
      );
    }
    const commands = gitCommands(world.home);
    expect(commands.filter((c) => /(^|\s)switch\s+(-c|-C|--create)/.test(c))).toEqual([]);
    expect(commands.filter((c) => /(^|\s)checkout\s+-b/.test(c))).toEqual([]);
    expect(readPrs(world.home).calls.filter((c) => c.args[0] === 'pr')).toEqual([]);
    expect(readPrs(world.home).prs).toEqual([]);

    // The agent was handed the recorded findings, verbatim, on each own-branch checkout.
    const [fix] = readFixes(world.home);
    expect(fix!.prompt).toContain(`- README.md:1 — the criterion is not met in ${s.key}.`);
    expect(Object.values(fix!.heads).sort()).toEqual(s.fix!.prs.map((pr) => pr.branch).sort());
    return fix!;
  }

  it('a repair of a one-repository card sent back by a review: its own branch, the fix pushed there, nothing else', async () => {
    const s = FIX_SCENARIOS[0]!;
    const world = armFix(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    const fix = expectRepaired(s, world);
    expect(fix.checkouts).toHaveLength(1);
    expect(fix.tried).toBeNull();
  }, 120_000);

  it('a repair of a two-repository card: both on their own branches, each fix pushed to it; another ref and gh are refused', async () => {
    const s = FIX_SCENARIOS[1]!;
    const world = armFix(s);
    const res = await launch(world.env);
    expect(res.code, res.stderr + res.stdout).toBe(0);
    expect(existsSync(join(world.workspace, 'app-a', '.git'))).toBe(true);
    expect(existsSync(join(world.workspace, 'app-b', '.git'))).toBe(true);
    const fix = expectRepaired(s, world);
    expect(fix.checkouts.map((c) => c.branch).sort()).toEqual([
      'hosted/ACME-31',
      'hosted/ACME-31-b',
    ]);
    // The agent that tried another ref and `gh pr create` was refused both.
    expect(fix.tried!.push.status).not.toBe(0);
    expect(fix.tried!.push.stderr).toMatch(/pushes only to its pull requests' own branches/);
    expect(fix.tried!.gh.status).not.toBe(0);
    expect(fix.tried!.gh.stderr).toMatch(/`gh` is disabled in a hosted REPAIR run/);
  }, 120_000);
});

// ── Layer 2: the image ─────────────────────────────────────────────────────

describe.skipIf(!IMAGE)('the hosted-agent IMAGE (MOTIR-6560)', () => {
  const image = IMAGE ?? '';
  const inImage = (cmd: string) =>
    spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', cmd], {
      encoding: 'utf8',
    });

  it('carries the Motir CLI, gh, git ≥ 2.36, OpenCode 1.18.32 and codegraph — and no other agent CLI', () => {
    const res = inImage(
      'motir --version && gh --version && git --version && opencode --version && codegraph --version; ' +
        'for a in claude codex aider goose cursor-agent kimi; do command -v "$a" && echo "UNEXPECTED $a"; done; true',
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/gh version/);
    expect(res.stdout).toMatch(/^1\.18\.32$/m);
    const gitVersion = /git version (\d+)\.(\d+)/.exec(res.stdout);
    expect(gitVersion).not.toBeNull();
    const [major, minor] = [Number(gitVersion![1]), Number(gitVersion![2])];
    expect(major > 2 || (major === 2 && minor >= 36)).toBe(true);
    expect(res.stdout).not.toContain('UNEXPECTED');
  });

  it('runs as a non-root user with /workspace as its workspace', () => {
    const res = inImage('id -u && echo "$MOTIR_WORKSPACE" && test -w /workspace && echo writable');
    expect(res.status, res.stderr).toBe(0);
    const [uid, workspace, writable] = res.stdout.trim().split('\n');
    expect(uid).not.toBe('0');
    expect(workspace).toBe('/workspace');
    expect(writable).toBe('writable');
  });

  it('its launcher refuses a boot with no inputs, naming them, with exit 20', () => {
    const res = spawnSync('docker', ['run', '--rm', image], { encoding: 'utf8' });
    expect(res.status).toBe(SETUP_FAILED);
    expect(res.stderr).toContain('missing required input(s): MOTIR_DISPATCH_RUN_ID');
  });

  it('its launcher knows every mode — `fix` included (MOTIR-6929) — and refuses an unknown one', () => {
    const res = spawnSync('docker', ['run', '--rm', '-e', 'MOTIR_RUN_MODE=retry', image], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(SETUP_FAILED);
    expect(res.stderr).toContain('"run", "continue", "review" or "fix", got "retry"');
  });
});
