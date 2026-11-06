import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentReviewVerdict, ReviewPrompt } from '../src/client.js';
import type { RunAgentOptions } from '../src/agentRun.js';
import { ReviewStaleError } from '../src/errors.js';

// `motir review <KEY>` (Story MOTIR-1626 · MOTIR-6824; `hosted-agent-run.md` §8). The
// session, the agent and git are injected; what is under test is that the container
// ADOPTS the review run (never claims), checks every pull request out detached at its
// reviewed head in every repository, reads the agent's ONE verdict from its file and
// posts it once — and that nothing but the verdict ever leaves: no push, no `gh`, and
// no POST at all for a missing or malformed verdict.

const { sessionRef, adoptedRef } = vi.hoisted(() => ({
  sessionRef: { current: null as unknown },
  adoptedRef: { current: null as unknown },
}));

vi.mock('../src/session.js', () => ({
  withHostedProjectSession: async (
    _runId: string,
    fn: (s: unknown, run: unknown) => Promise<unknown>,
  ) => fn(sessionRef.current, adoptedRef.current),
}));

const { reviewCommand } = await import('../src/commands/review.js');
const { parseReviewVerdict, readReviewVerdict, prepareReviewCheckouts, reviewRunSection } =
  await import('../src/hostedReview.js');
const { lockHostedRunReadOnly, REVIEW_GH_REFUSAL } = await import('../src/hostedGit.js');

const RUN = 'run_review_1';
const KEY = 'PROD-7';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const VERSION = `acme/app-a#3@${SHA_A}`;
const VERSION_2 = `acme/app-a#3@${SHA_A},acme/app-b#4@${SHA_B}`;
const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const failed = (stderr = 'nope'): CommandResult => ({ exitCode: 1, stdout: '', stderr });

const HOSTED_ENV = {
  MOTIR_DISPATCH_RUN_ID: RUN,
  MOTIR_MODEL: 'anthropic/claude-test-1',
  MOTIR_GATEWAY_URL: 'https://gateway.example',
  MOTIR_RUN_KEY: 'sk-run',
  PATH: process.env.PATH ?? '',
};

function served(twoRepos = false): ReviewPrompt {
  return {
    key: KEY,
    gateId: 'gate_1',
    subjectVersion: twoRepos ? VERSION_2 : VERSION,
    pullRequests: [
      {
        repository: 'acme/app-a',
        number: 3,
        headSha: SHA_A,
        baseBranch: 'main',
        headBranch: 'feat/a',
        url: 'https://github.com/acme/app-a/pull/3',
      },
      ...(twoRepos
        ? [
            {
              repository: 'acme/app-b',
              number: 4,
              headSha: SHA_B,
              baseBranch: 'main',
              headBranch: 'feat/b',
              url: 'https://github.com/acme/app-b/pull/4',
            },
          ]
        : []),
    ],
    prompt: 'You are REVIEWING the delivered code of PROD-7.\n',
  };
}

interface Harness {
  root: string;
  calls: { tool: string; args: unknown }[];
  git: { args: string[]; cwd: string }[];
  events: { kind: string; disposition?: string; data?: unknown }[];
  closed: string[];
  agentRuns: RunAgentOptions[];
  locked: number;
}
let h: Harness;

/**
 * A git whose clone makes the directory and holds every head; `rev-parse HEAD` answers
 * the last sha checked out in that directory. `missing` heads are absent until fetched.
 */
function fakeGit(opts: { missing?: string[]; fetchBySha?: boolean; wrongHead?: boolean } = {}) {
  const heads = new Map<string, string>();
  const missing = new Set(opts.missing ?? []);
  const runner: CommandRunner = (_bin, args, cwd) => {
    h.git.push({ args, cwd });
    if (args[0] === 'clone') {
      mkdirSync(args[args.length - 1]!, { recursive: true });
      return ok();
    }
    if (args[0] === 'cat-file') {
      const sha = args[2]!.replace('^{commit}', '');
      return missing.has(sha) ? failed() : ok();
    }
    if (args[0] === 'fetch') {
      const target = args[3]!;
      if (target.startsWith('+refs/pull/')) {
        for (const m of missing) missing.delete(m);
        return ok();
      }
      if (missing.has(target)) {
        if (opts.fetchBySha === false) return failed('not our ref');
        missing.delete(target);
      }
      return ok();
    }
    if (args[0] === 'checkout') {
      heads.set(cwd, args[args.length - 1]!);
      return ok();
    }
    if (args[0] === 'worktree') {
      heads.set(args[3]!, args[4]!);
      return ok();
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return ok(opts.wrongHead ? 'c'.repeat(40) : `${heads.get(cwd) ?? ''}\n`);
    }
    return ok();
  };
  return runner;
}

function setup(over: {
  command?: string;
  legs?: string[];
  prompt?: ReviewPrompt;
  submit?: (key: string, v: AgentReviewVerdict) => Promise<unknown>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'motir-review-'));
  h = { root, calls: [], git: [], events: [], closed: [], agentRuns: [], locked: 0 };
  const client = {
    getDispatchRun: async (id: string) => {
      h.calls.push({ tool: 'get_run', args: id });
      return {
        runId: id,
        status: 'running',
        command: over.command ?? 'review',
        origin: 'hosted',
        model: null,
        endedAt: null,
        cards: [{ key: KEY, position: 0, disposition: 'queued' }],
      };
    },
    reviewPrompt: async (key: string) => {
      h.calls.push({ tool: 'review_prompt', args: key });
      return over.prompt ?? served();
    },
    submitAgentReview: async (key: string, verdict: AgentReviewVerdict) => {
      h.calls.push({ tool: 'agent_review', args: { key, verdict } });
      if (over.submit) return over.submit(key, verdict);
      return {
        key,
        gateId: 'gate_1',
        verdict: verdict.verdict,
        state: verdict.verdict === 'pass' ? 'approved' : 'changes_requested',
        subjectVersion: verdict.subjectVersion,
        decidedAt: '2026-09-29T10:00:00.000Z',
        bugs: verdict.bugs.map((b, i) => ({
          key: `PROD-${90 + i}`,
          title: b.title,
          outcome: 'filed' as const,
        })),
      };
    },
    appendDispatchRunEvents: async (args: { events: Harness['events'] }) => {
      h.events.push(...args.events);
      return { runId: RUN, appended: args.events.length, seq: h.events.length };
    },
    closeDispatchRun: async (args: { stopReason: string }) => {
      h.closed.push(args.stopReason);
    },
    heartbeatDispatchRun: async () => 'ok' as const,
    openDispatchRun: async () => {
      h.calls.push({ tool: 'open_run', args: null });
      return { runId: 'never', created: true };
    },
    claimWorkItem: async () => {
      h.calls.push({ tool: 'claim', args: null });
    },
  };
  sessionRef.current = {
    client,
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: 'x', workspace: '', project: 'PROD' },
    },
    projectKey: 'PROD',
    serverUrl: 'x',
  };
  adoptedRef.current = { runId: RUN, projectKey: 'PROD', legs: over.legs ?? [KEY] };
}

/** An agent that writes `verdict` (a string, verbatim) to the file its env names. */
function agentWriting(verdict: string | null, exitCode = 0, model: string | null = null) {
  return async (opts: RunAgentOptions) => {
    h.agentRuns.push(opts);
    const file = opts.command.env?.MOTIR_REVIEW_VERDICT_FILE;
    if (verdict !== null && file) writeFileSync(file, verdict);
    return { exitCode, signal: null, model };
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    env: { ...HOSTED_ENV },
    run: fakeGit(),
    lockReadOnly: () => {
      h.locked += 1;
    },
    prepareCheckouts: () => {},
    onInterrupt: () => () => {},
    ...over,
  };
}

const verdictPosts = () => h.calls.filter((c) => c.tool === 'agent_review');

beforeEach(() => {
  process.exitCode = undefined;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  rmSync(h?.root ?? join(tmpdir(), 'none'), { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

// ── The verdict file ───────────────────────────────────────────────────────

describe('the verdict contract — parseReviewVerdict', () => {
  const v = (body: unknown) => parseReviewVerdict(JSON.stringify(body), VERSION);

  it('accepts a pass, with or without findings, and fills the version it checked out', () => {
    expect(v({ verdict: 'pass', summaryMd: ' Meets the card. ' })).toEqual({
      ok: true,
      verdict: {
        subjectVersion: VERSION,
        verdict: 'pass',
        summaryMd: 'Meets the card.',
        findingsMd: null,
        bugs: [],
      },
    });
    expect(v({ subjectVersion: VERSION, verdict: 'pass', findingsMd: 'a nit' })).toMatchObject({
      ok: true,
      verdict: { findingsMd: 'a nit', summaryMd: null },
    });
  });

  it('accepts changes_requested WITH findings, and refuses it without', () => {
    expect(
      v({ verdict: 'changes_requested', findingsMd: '- src/a.ts:3 breaks AC1' }),
    ).toMatchObject({
      ok: true,
      verdict: { verdict: 'changes_requested', findingsMd: '- src/a.ts:3 breaks AC1' },
    });
    expect(v({ verdict: 'changes_requested', findingsMd: '   ' })).toEqual({
      ok: false,
      reason: expect.stringMatching(/findingsMd.*required/),
    });
    expect(v({ verdict: 'changes_requested' }).ok).toBe(false);
  });

  it('refuses every malformed shape, naming why', () => {
    const reason = (raw: string) => {
      const r = parseReviewVerdict(raw, VERSION);
      return r.ok ? null : r.reason;
    };
    expect(reason('not json')).toMatch(/not valid JSON/);
    expect(reason('[1]')).toMatch(/one JSON object/);
    expect(reason('null')).toMatch(/one JSON object/);
    expect(reason(JSON.stringify({ verdict: 'approve' }))).toMatch(/"pass" or "changes_requested"/);
    expect(reason(JSON.stringify({ verdict: 'pass', extra: 1 }))).toMatch(/unknown key.*extra/);
    expect(reason(JSON.stringify({ verdict: 'pass', subjectVersion: 'other' }))).toMatch(
      /not the version/,
    );
    expect(reason(JSON.stringify({ verdict: 'pass', summaryMd: 3 }))).toMatch(/must be a string/);
    expect(reason(JSON.stringify({ verdict: 'pass', summaryMd: 'x'.repeat(501) }))).toMatch(
      /longer than 500/,
    );
    expect(
      reason(JSON.stringify({ verdict: 'changes_requested', findingsMd: 'x'.repeat(65_537) })),
    ).toMatch(/longer than 65536/);
  });

  it('carries the optional `bugs` list (MOTIR-10513), trimmed, and refuses a malformed one', () => {
    const bug = {
      title: ' The footer clock drifts ',
      descriptionMd: ' app/footer.tsx:40 drifts. ',
    };
    expect(v({ verdict: 'pass', bugs: [bug] })).toMatchObject({
      ok: true,
      verdict: {
        bugs: [{ title: 'The footer clock drifts', descriptionMd: 'app/footer.tsx:40 drifts.' }],
      },
    });
    expect(v({ verdict: 'pass', bugs: null })).toMatchObject({ ok: true, verdict: { bugs: [] } });
    expect(v({ verdict: 'pass', bugs: [] })).toMatchObject({ ok: true, verdict: { bugs: [] } });
    const reason = (bugs: unknown) => {
      const r = v({ verdict: 'pass', bugs });
      return r.ok ? null : r.reason;
    };
    expect(reason('one')).toMatch(/`bugs` must be a list/);
    expect(reason(Array.from({ length: 6 }, () => bug))).toMatch(/more than 5/);
    expect(reason(['x'])).toMatch(/`bugs\[0\]` is not one JSON object/);
    expect(reason([[]])).toMatch(/is not one JSON object/);
    expect(reason([{ ...bug, kind: 'bug' }])).toMatch(/`bugs\[0\]` has unknown key.*kind/);
    expect(reason([bug, { ...bug, title: '  ' }])).toMatch(/`bugs\[1\]`\.title is required/);
    expect(reason([{ title: 'x' }])).toMatch(/descriptionMd is required/);
    expect(reason([{ ...bug, title: 'x'.repeat(201) }])).toMatch(/title is longer than 200/);
    expect(reason([{ ...bug, descriptionMd: 'x'.repeat(20_001) }])).toMatch(
      /descriptionMd is longer than 20000/,
    );
  });

  it('a missing or empty file is no verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'motir-verdict-'));
    try {
      expect(readReviewVerdict(join(dir, 'nope.json'), VERSION)).toEqual({
        ok: false,
        reason: 'the agent wrote no verdict file',
      });
      writeFileSync(join(dir, 'v.json'), '\n');
      expect(readReviewVerdict(join(dir, 'v.json'), VERSION)).toEqual({
        ok: false,
        reason: 'the verdict file is empty',
      });
      writeFileSync(join(dir, 'v.json'), JSON.stringify({ verdict: 'pass' }));
      expect(readReviewVerdict(join(dir, 'v.json'), VERSION).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the section the agent is told names the file, the exact version and every checkout', () => {
    const text = reviewRunSection({
      served: { subjectVersion: VERSION_2 },
      checkouts: [
        { repository: 'acme/app-a', number: 3, headSha: SHA_A, path: '/w/app-a' },
        { repository: 'acme/app-b', number: 4, headSha: SHA_B, path: '/w/app-b' },
      ],
      verdictFile: '/tmp/x/verdict.json',
      standards: ['/w/app-b/AGENTS.md'],
    });
    expect(text).toContain('/tmp/x/verdict.json');
    expect(text).toContain(`EXACTLY "${VERSION_2}"`);
    expect(text).toContain(`acme/app-b #4 at ${SHA_B}`);
    expect(text).toContain('/w/app-b/AGENTS.md');
    expect(text).toMatch(/do NOT call it/);
    // The one way a hosted reviewer logs a bug (MOTIR-10513): the same file.
    expect(text).toContain('"bugs"            OPTIONAL — at most 5');
    expect(text).toContain('you cannot');
    // No standards → no standards paragraph (§8.5: never required).
    expect(
      reviewRunSection({
        served: { subjectVersion: VERSION },
        checkouts: [],
        verdictFile: '/v',
        standards: [],
      }),
    ).not.toMatch(/written standard/);
  });
});

// ── The checkouts ──────────────────────────────────────────────────────────

describe('prepareReviewCheckouts — every pull request, detached at its reviewed head', () => {
  const config = { serverUrl: 'x', workspace: '', project: 'PROD' };
  beforeEach(() => setup({}));

  it('one repository: cloned, checked out detached at the head, never pushed', () => {
    const prepared = prepareReviewCheckouts({
      key: KEY,
      pullRequests: served().pullRequests,
      rootDir: h.root,
      config,
      run: fakeGit(),
      exists: existsSync,
    });
    expect(prepared).toEqual({
      ok: true,
      checkouts: [
        { repository: 'acme/app-a', number: 3, headSha: SHA_A, path: join(h.root, 'app-a') },
      ],
      materialized: ['Cloned:     app-a'],
    });
    const clone = h.git.find((g) => g.args[0] === 'clone')!;
    expect(clone.args).toContain('https://github.com/acme/app-a.git');
    expect(h.git.some((g) => g.args[0] === 'checkout' && g.args.includes('--detach'))).toBe(true);
    expect(h.git.filter((g) => ['push', 'commit', 'switch'].includes(g.args[0]!))).toEqual([]);
  });

  it('two repositories: each cloned as a sibling and each at ITS reviewed head', () => {
    const prepared = prepareReviewCheckouts({
      key: KEY,
      pullRequests: served(true).pullRequests,
      rootDir: h.root,
      config,
      run: fakeGit(),
      exists: existsSync,
    });
    expect(prepared.ok && prepared.checkouts.map((c) => `${c.path} ${c.headSha}`)).toEqual([
      `${join(h.root, 'app-a')} ${SHA_A}`,
      `${join(h.root, 'app-b')} ${SHA_B}`,
    ]);
    expect(h.git.filter((g) => g.args[0] === 'push')).toEqual([]);
  });

  it('a head the clone lacks is fetched by sha, else by refs/pull/<n>/head', () => {
    const bySha = prepareReviewCheckouts({
      key: KEY,
      pullRequests: served().pullRequests,
      rootDir: h.root,
      config,
      run: fakeGit({ missing: [SHA_A] }),
      exists: existsSync,
    });
    expect(bySha.ok).toBe(true);
    expect(h.git.some((g) => g.args[0] === 'fetch' && g.args[3] === SHA_A)).toBe(true);

    setup({});
    const byPull = prepareReviewCheckouts({
      key: KEY,
      pullRequests: served().pullRequests,
      rootDir: h.root,
      config,
      run: fakeGit({ missing: [SHA_A], fetchBySha: false }),
      exists: existsSync,
    });
    expect(byPull.ok).toBe(true);
    expect(
      h.git.some((g) => g.args[0] === 'fetch' && g.args[3]!.startsWith('+refs/pull/3/head:')),
    ).toBe(true);
  });

  it('two pull requests in ONE repository: the second gets its own detached worktree', () => {
    const prs = [
      served().pullRequests[0]!,
      { ...served().pullRequests[0]!, number: 5, headSha: SHA_B },
    ];
    const prepared = prepareReviewCheckouts({
      key: KEY,
      pullRequests: prs,
      rootDir: h.root,
      config,
      run: fakeGit(),
      exists: existsSync,
    });
    expect(prepared.ok && prepared.checkouts.map((c) => c.path)).toEqual([
      join(h.root, 'app-a'),
      join(h.root, 'app-a-pr-5'),
    ]);
    expect(h.git.filter((g) => g.args[0] === 'clone')).toHaveLength(1);
    expect(h.git.some((g) => g.args[0] === 'worktree' && g.args.includes('--detach'))).toBe(true);
  });

  it('refuses — naming why — an empty set, a failed clone, an unreachable head, a checkout off the head', () => {
    const run = (runner: CommandRunner, prs = served().pullRequests) =>
      prepareReviewCheckouts({
        key: KEY,
        pullRequests: prs,
        rootDir: h.root,
        config,
        run: runner,
        exists: existsSync,
      });
    expect(run(fakeGit(), [])).toEqual({
      ok: false,
      message: expect.stringMatching(/names no pull request/),
    });
    setup({});
    expect(run((_b, args) => (args[0] === 'clone' ? failed('denied') : ok()))).toEqual({
      ok: false,
      message: expect.stringMatching(/could not be cloned/),
    });
    setup({});
    expect(
      run((_b, args, cwd) =>
        args[0] === 'clone'
          ? (mkdirSync(args[args.length - 1]!, { recursive: true }), ok())
          : args[0] === 'cat-file' || args[0] === 'fetch'
            ? failed()
            : ok(cwd),
      ),
    ).toEqual({ ok: false, message: expect.stringMatching(/could not be fetched/) });
    setup({});
    expect(run(fakeGit({ wrongHead: true }))).toEqual({
      ok: false,
      message: expect.stringMatching(/is at c+, not a+/),
    });
    setup({});
    expect(
      run((_b, args) =>
        args[0] === 'clone'
          ? (mkdirSync(args[args.length - 1]!, { recursive: true }), ok())
          : args[0] === 'checkout'
            ? failed('dirty')
            : ok(),
      ),
    ).toEqual({ ok: false, message: expect.stringMatching(/could not check out.*dirty/) });
  });
});

// ── The command ────────────────────────────────────────────────────────────

describe('motir review — adopts the review run and submits ONE verdict', () => {
  it('refuses outside a hosted run, naming why', async () => {
    setup({});
    await expect(reviewCommand(KEY, deps({ env: { PATH: '' } }))).rejects.toThrow(
      /runs only inside a hosted review run — MOTIR_DISPATCH_RUN_ID is not set/,
    );
    await expect(reviewCommand('  ', deps())).rejects.toThrow(/work item key is required/);
    expect(h.calls).toEqual([]);
  });

  it('refuses a run that is not a review — adopting, locking and closing nothing', async () => {
    setup({ command: 'run' });
    await expect(reviewCommand(KEY, deps())).rejects.toMatchObject({
      message: expect.stringMatching(/is a `run` run, not a review/),
      exitCode: 20,
    });
    expect(h.locked).toBe(0);
    expect(h.closed).toEqual([]);
    expect(h.calls.map((c) => c.tool)).toEqual(['get_run']);
  });

  it('refuses a card that is not the run’s leg', async () => {
    setup({ legs: ['PROD-9'] });
    await expect(reviewCommand(KEY, deps())).rejects.toThrow(/PROD-7 is not a card of run/);
    expect(h.closed).toEqual([]);
  });

  it('one repository: adopts (never claims or opens), locks, checks out, posts ONE verdict with the version', async () => {
    setup({});
    const order: string[] = [];
    const run = fakeGit();
    await reviewCommand(
      KEY,
      deps({
        run: (b: string, a: string[], c: string) => {
          if (a[0] === 'clone') order.push('checkout');
          return run(b, a, c);
        },
        lockReadOnly: () => {
          h.locked += 1;
          order.push('lock');
        },
        runAgentFn: agentWriting(
          JSON.stringify({ subjectVersion: VERSION, verdict: 'pass', summaryMd: 'Meets it.' }),
        ),
      }),
    );
    expect(process.exitCode).toBeUndefined();
    expect(order).toEqual(['lock', 'checkout']);
    expect(h.calls.map((c) => c.tool)).toEqual(['get_run', 'review_prompt', 'agent_review']);
    expect(verdictPosts()).toEqual([
      {
        tool: 'agent_review',
        args: {
          key: KEY,
          verdict: {
            subjectVersion: VERSION,
            verdict: 'pass',
            summaryMd: 'Meets it.',
            findingsMd: null,
            bugs: [],
          },
        },
      },
    ]);
    // The agent: OpenCode on the served prompt + the file contract, in the checkout.
    const [agent] = h.agentRuns;
    expect(agent!.command.binary).toBe('opencode');
    expect(agent!.cwd).toBe(join(h.root, 'app-a'));
    expect(agent!.prompt.startsWith(served().prompt)).toBe(true);
    expect(agent!.prompt).toContain(agent!.command.env!.MOTIR_REVIEW_VERDICT_FILE!);
    expect(agent!.command.env!.MOTIR_RUN_TOKEN).toBeUndefined();
    // No build-run addendum (pull requests, attribution) reaches a reviewer.
    expect(agent!.command.promptArgs!(agent!.prompt, '/p').join('')).not.toMatch(
      /pull request you open/,
    );
    // The verdict file's directory is gone.
    expect(existsSync(agent!.command.env!.MOTIR_REVIEW_VERDICT_FILE!)).toBe(false);
    expect(h.git.filter((g) => g.args[0] === 'push')).toEqual([]);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toEqual(['checkout_ready', 'agent_started', 'agent_exited', 'card_settled']);
    expect(h.events.at(-1)).toMatchObject({
      disposition: 'implemented',
      data: { verdict: 'pass' },
    });
    expect(h.closed).toEqual(['completed']);
  });

  it('posts the bugs the verdict carries (MOTIR-10513), and names each one it logged', async () => {
    setup({});
    const lines: string[] = [];
    vi.mocked(process.stderr.write).mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const bug = { title: 'The footer clock drifts', descriptionMd: 'app/footer.tsx:40 drifts.' };
    await reviewCommand(
      KEY,
      deps({
        runAgentFn: agentWriting(
          JSON.stringify({ verdict: 'pass', summaryMd: 'Logged 1 bug.', bugs: [bug] }),
        ),
      }),
    );
    expect(process.exitCode).toBeUndefined();
    expect(verdictPosts()).toHaveLength(1);
    expect((verdictPosts()[0]!.args as { verdict: AgentReviewVerdict }).verdict.bugs).toEqual([
      bug,
    ]);
    expect(lines.join('')).toContain('bug logged: PROD-90 — The footer clock drifts');
    expect(h.events.at(-1)).toMatchObject({
      disposition: 'implemented',
      data: { verdict: 'pass', bugs: ['PROD-90'] },
    });
  });

  it('two repositories: both checked out at their heads, one POST over both', async () => {
    setup({ prompt: served(true) });
    await reviewCommand(
      KEY,
      deps({
        runAgentFn: agentWriting(
          JSON.stringify({ verdict: 'changes_requested', findingsMd: '- app-b/x.ts:1 misses AC2' }),
        ),
      }),
    );
    expect(process.exitCode).toBeUndefined();
    const checkouts = h.git.filter((g) => g.args[0] === 'checkout');
    expect(checkouts.map((g) => `${g.cwd} ${g.args.at(-1)}`)).toEqual([
      `${join(h.root, 'app-a')} ${SHA_A}`,
      `${join(h.root, 'app-b')} ${SHA_B}`,
    ]);
    expect(verdictPosts()).toHaveLength(1);
    expect(verdictPosts()[0]!.args).toMatchObject({
      verdict: { subjectVersion: VERSION_2, verdict: 'changes_requested' },
    });
    expect(h.agentRuns[0]!.prompt).toContain(join(h.root, 'app-b'));
  });

  it.each([
    ['a missing verdict file', null, 0, /wrote no verdict file/],
    ['a malformed verdict file', '{"verdict": "lgtm"}', 0, /"pass" or "changes_requested"/],
    [
      'an agent that failed',
      JSON.stringify({ verdict: 'pass' }),
      2,
      /review agent failed \(exit 2\)/,
    ],
  ])(
    '%s: exits non-zero, posts NOTHING, closes the run failed',
    async (_name, verdict, code, reason) => {
      setup({});
      const lines: string[] = [];
      vi.mocked(process.stderr.write).mockImplementation((s) => (lines.push(String(s)), true));
      await reviewCommand(KEY, deps({ runAgentFn: agentWriting(verdict, code) }));
      expect(process.exitCode).toBe(1);
      expect(verdictPosts()).toEqual([]);
      expect(h.closed).toEqual(['halted']);
      expect(h.events.at(-1)).toMatchObject({ kind: 'card_settled', disposition: 'failed' });
      expect(lines.join('')).toMatch(reason);
    },
  );

  it('a checkout that cannot land: no agent, nothing posted, the run failed', async () => {
    setup({});
    const agent = vi.fn();
    await reviewCommand(KEY, deps({ run: fakeGit({ wrongHead: true }), runAgentFn: agent }));
    expect(agent).not.toHaveBeenCalled();
    expect(verdictPosts()).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(h.closed).toEqual(['halted']);
  });

  it('REVIEW_STALE: the code moved — exits ZERO, logging it, the run closed completed', async () => {
    setup({
      submit: async () => {
        throw new ReviewStaleError('The review was withdrawn before this verdict arrived.');
      },
    });
    const lines: string[] = [];
    vi.mocked(process.stderr.write).mockImplementation((s) => (lines.push(String(s)), true));
    await reviewCommand(
      KEY,
      deps({ runAgentFn: agentWriting(JSON.stringify({ verdict: 'pass' })) }),
    );
    expect(process.exitCode).toBeUndefined();
    expect(verdictPosts()).toHaveLength(1);
    expect(lines.join('')).toMatch(/the code moved while it was reviewed/);
    expect(h.closed).toEqual(['completed']);
  });

  it('any other refusal of the verdict closes the run failed and surfaces', async () => {
    setup({
      submit: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      reviewCommand(KEY, deps({ runAgentFn: agentWriting(JSON.stringify({ verdict: 'pass' })) })),
    ).rejects.toThrow('boom');
    expect(h.closed).toEqual(['halted']);
  });

  it('booted for a version the server no longer serves: no checkout, no agent, exits zero', async () => {
    setup({});
    const agent = vi.fn();
    await reviewCommand(
      KEY,
      deps({ env: { ...HOSTED_ENV, MOTIR_REVIEW_VERSION: 'older-version' }, runAgentFn: agent }),
    );
    expect(agent).not.toHaveBeenCalled();
    expect(h.git).toEqual([]);
    expect(verdictPosts()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(h.closed).toEqual(['completed']);

    setup({});
    await reviewCommand(
      KEY,
      deps({ env: { ...HOSTED_ENV, MOTIR_REVIEW_GATE_ID: 'gate_old' }, runAgentFn: agent }),
    );
    expect(agent).not.toHaveBeenCalled();

    // The version it WAS booted for runs normally.
    setup({});
    await reviewCommand(
      KEY,
      deps({
        env: { ...HOSTED_ENV, MOTIR_REVIEW_VERSION: VERSION, MOTIR_REVIEW_GATE_ID: 'gate_1' },
        runAgentFn: agentWriting(JSON.stringify({ verdict: 'pass' })),
      }),
    );
    expect(verdictPosts()).toHaveLength(1);
  });

  it('with no prepared hosted git to lock, it refuses rather than review unlocked', async () => {
    setup({});
    const d = deps({ runAgentFn: agentWriting(JSON.stringify({ verdict: 'pass' })) });
    delete (d as { lockReadOnly?: unknown }).lockReadOnly;
    await expect(reviewCommand(KEY, d)).rejects.toThrow(/no git setup to lock read-only/);
    expect(verdictPosts()).toEqual([]);
    expect(h.closed).toEqual(['halted']);
  });
});

// ── The read-only lock, against real git ──────────────────────────────────

describe('lockHostedRunReadOnly — nothing a review run does can push or reach gh', () => {
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'motir-review-lock-'));
    writeFileSync(join(state, 'gitconfig'), '[user]\n\tuseConfigOnly = true\n');
    mkdirSync(join(state, 'bin'));
    writeFileSync(join(state, 'bin', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  it('every push to GitHub fails before it connects, and gh refuses every call', () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };
    lockHostedRunReadOnly(state, env);
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(state, 'gitconfig'));
    expect(env.PATH!.split(':')[0]).toBe(join(state, 'bin'));
    expect(readFileSync(join(state, 'gitconfig'), 'utf8')).toMatch(/useConfigOnly = true/);

    const repo = join(state, 'repo');
    const gitEnv = { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf8' });
    mkdirSync(repo);
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', 'https://github.com/acme/app-a.git');
    git('-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'x');
    for (const target of [
      ['origin', 'HEAD:refs/heads/x'],
      ['https://github.com/acme/app-a.git', 'HEAD:refs/heads/x'],
      ['git@github.com:acme/app-a.git', 'HEAD:refs/heads/x'],
    ]) {
      const pushed = git('push', ...target);
      expect(pushed.status).not.toBe(0);
      expect(pushed.stderr).toMatch(/motir-review-refuses-push/);
    }
    const gh = spawnSync(join(state, 'bin', 'gh'), ['pr', 'comment', '3'], { encoding: 'utf8' });
    expect(gh.status).toBe(1);
    expect(gh.stderr.trim()).toBe(REVIEW_GH_REFUSAL);
  });
});

// ── The two routes, over real HTTP ─────────────────────────────────────────

describe('the client — the review prompt, and the verdict (a late one typed)', () => {
  it('reads the served prompt and posts the ONE verdict; REVIEW_STALE becomes ReviewStaleError', async () => {
    const { startTestServer } = await import('./helpers/testServer.js');
    const { MotirClient } = await import('../src/client.js');
    const prompt = served(true);
    const server = await startTestServer({
      token: 'run-token',
      v1: {
        'GET /api/v1/work-items/{key}/review-prompt': { body: prompt },
        'POST /api/v1/work-items/{key}/agent-review': (req) => ({
          body: {
            key: req.params.key,
            gateId: 'gate_1',
            verdict: 'pass',
            state: 'approved',
            subjectVersion: VERSION_2,
            decidedAt: '2026-09-29T10:00:00.000Z',
            bugs:
              (req.body as { bugs?: Array<{ title: string }> }).bugs?.map((b) => ({
                key: 'PROD-90',
                title: b.title,
                outcome: 'filed',
              })) ?? [],
          },
        }),
      },
    });
    try {
      const client = new MotirClient({ serverUrl: server.url, token: 'run-token' });
      expect(await client.reviewPrompt(KEY)).toEqual(prompt);
      const verdict: AgentReviewVerdict = {
        subjectVersion: VERSION_2,
        verdict: 'pass',
        summaryMd: 'ok',
        findingsMd: null,
        bugs: [],
      };
      expect(await client.submitAgentReview(KEY, verdict)).toMatchObject({
        state: 'approved',
        subjectVersion: VERSION_2,
        bugs: [],
      });
      // A verdict that logs nothing sends the 1.81.0 body: no `bugs` key at all.
      expect(server.v1Calls.at(-1)).toMatchObject({
        method: 'POST',
        path: `/api/v1/work-items/${KEY}/agent-review`,
        body: { subjectVersion: VERSION_2, verdict: 'pass', summaryMd: 'ok', findingsMd: null },
      });
      expect(server.v1Calls.at(-1)!.body).not.toHaveProperty('bugs');

      const withBug = { ...verdict, bugs: [{ title: 'A bug', descriptionMd: 'Why.' }] };
      expect((await client.submitAgentReview(KEY, withBug)).bugs).toEqual([
        { key: 'PROD-90', title: 'A bug', outcome: 'filed' },
      ]);
      expect(server.v1Calls.at(-1)!.body).toMatchObject({
        bugs: [{ title: 'A bug', descriptionMd: 'Why.' }],
      });

      server.scriptV1({
        'POST /api/v1/work-items/{key}/agent-review': {
          status: 409,
          body: {
            code: 'REVIEW_STALE',
            error: 'The review was withdrawn before this verdict arrived.',
          },
        },
      });
      const late = await client.submitAgentReview(KEY, verdict).catch((err: unknown) => err);
      expect(late).toBeInstanceOf(ReviewStaleError);
      expect((late as ReviewStaleError).exitCode).toBe(0);
      expect((late as Error).message).toMatch(/withdrawn/);
    } finally {
      await server.close();
    }
  });
});

describe('agent_exited carries the reviewer’s self-reported model TOP-LEVEL (MOTIR-7504)', () => {
  it.each([['m'], [null]] as const)('model %s', async (model) => {
    setup({});
    await reviewCommand(
      KEY,
      deps({
        runAgentFn: agentWriting(
          JSON.stringify({ subjectVersion: VERSION, verdict: 'pass', summaryMd: 'Meets it.' }),
          0,
          model,
        ),
      }),
    );

    const exited = h.events.filter((e) => e.kind === 'agent_exited');
    expect(exited).toHaveLength(1);
    expect(exited[0]).toMatchObject({ exitCode: 0, model });
    expect(exited[0]!.data).toMatchObject({ step: 'review', model });
  });
});
