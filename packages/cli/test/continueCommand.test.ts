import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/git.js';
import { answerPrView } from './fakePullRequest.js';
import type { DispatchPrompt, WorkItemContinueClaim, WorkItemDetail } from '../src/client.js';

// `motir continue <key>` (Story MOTIR-6526 · MOTIR-6533). The session, the agent
// and git are injected; what is under test is the PIPELINE — claim, then the dead
// run's branch checked out (reused as found, never reset), then the CONTINUE
// prompt, then `motir run`'s own delivery to Implemented — and that a refusal
// touches neither git nor the agent.

const { runAgentMock, sessionRef, adoptedRef } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
  adoptedRef: { current: null as unknown },
}));

vi.mock('../src/agentRun.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
  withHostedProjectSession: async (
    _runId: string,
    fn: (s: unknown, run: unknown) => Promise<unknown>,
  ) => fn(sessionRef.current, adoptedRef.current),
}));

const { continueCommand, prepareContinueCheckout, renderContinueRefusal, renderTakeover } =
  await import('../src/commands/continue.js');

const SERVER = 'https://app.motir.co';
const BRANCH = 'subtask/PROD-7-add-the-thing';
const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

function claim(over: Partial<WorkItemContinueClaim> = {}): WorkItemContinueClaim {
  return {
    key: 'PROD-7',
    title: 'Add the thing',
    outcome: 'claimed',
    reason: null,
    parentKey: null,
    runId: 'run_continue_1',
    holder: { id: 'user_me', name: 'Me' },
    startedAt: '2026-09-27T10:00:00.000Z',
    deadRun: {
      id: 'run_dead',
      command: 'run',
      origin: 'local',
      status: 'timed_out',
      stopReason: 'abandoned',
      lastHeardAt: '2026-09-27T09:50:00.000Z',
      dispatcher: { id: 'user_mara', name: 'Mara S.' },
    },
    branch: BRANCH,
    pullRequest: null,
    previousAssignee: { id: 'user_mara', name: 'Mara S.' },
    mode: 'card',
    landedKeys: [],
    resumedKeys: [],
    ...over,
  };
}

interface Harness {
  root: string;
  calls: { tool: string; args: unknown }[];
  git: { args: string[]; cwd: string }[];
  stderr: string;
}
let h: Harness;

/** A git whose remote carries the branch; once a worktree is added it answers
 *  `rev-parse --abbrev-ref HEAD` with its branch. `onPath` pre-seeds a worktree. */
function fakeGit(onPath: Record<string, string> = {}): CommandRunner {
  const worktrees = new Map(Object.entries(onPath));
  return (bin, args, cwd) => {
    // The pull request the agent opened on the dead run's branch, which the run links
    // (MOTIR-10877). Not recorded in `h.git`: it is `gh`, not git.
    const pr = answerPrView(bin, args);
    if (pr) return pr;
    h.git.push({ args, cwd });
    if (args[0] === 'rev-parse' && args[1] === '--verify')
      return { exitCode: 1, stdout: '', stderr: '' };
    if (args[0] === 'clone') {
      mkdirSync(args[2]!, { recursive: true });
      return ok();
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const path = args[2] === '--track' ? args[5]! : args[2] === '-b' ? args[4]! : args[2]!;
      const branch = args[2] === '--track' ? args[4]! : args[3]!;
      worktrees.set(path, branch);
      return ok();
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
      return ok(worktrees.get(cwd) ?? 'HEAD');
    // The push check (MOTIR-3004): the work is on the remote.
    if (args[0] === 'ls-remote') return ok(`abc123\trefs/heads/${BRANCH}`);
    if (args[0] === 'log') return ok('abc123');
    return ok();
  };
}

function setup(claims: WorkItemContinueClaim, promptOver: Partial<DispatchPrompt> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'motir-continue-'));
  mkdirSync(join(root, 'motir-core'));
  const calls: Harness['calls'] = [];
  const prompt: DispatchPrompt = {
    key: 'PROD-7',
    prompt: 'CONTINUE — you are carrying on a run that DIED\nGIT WORKFLOW\n',
    parentKey: null,
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    ...promptOver,
  };
  const client = {
    claimWorkItemContinue: async (key: string) => {
      calls.push({ tool: 'claim_continue', args: key });
      return claims;
    },
    dispatchPrompt: async (key: string, opts: unknown) => {
      calls.push({ tool: 'dispatch_prompt', args: { key, opts } });
      return prompt;
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      return {
        item: { identifier: key, status: 'in_progress', title: 'Add the thing' },
        deliveries: [],
      } as unknown as WorkItemDetail;
    },
    listWorkItemDesigns: async () => ({ designs: [] }),
    linkPullRequest: async (args: unknown) => {
      calls.push({ tool: 'link_pull_request', args });
    },
    transitionStatus: async (args: unknown) => {
      calls.push({ tool: 'transition_status', args });
    },
    openDispatchRun: async (args: unknown) => {
      calls.push({ tool: 'open_run', args });
      return { runId: 'should-not-open', created: true };
    },
    appendDispatchRunEvents: async (args: { events: unknown[] }) => {
      calls.push({ tool: 'append', args });
      return { runId: 'x', appended: args.events.length, seq: 1 };
    },
    closeDispatchRun: async (args: unknown) => {
      calls.push({ tool: 'close_run', args });
    },
    heartbeatDispatchRun: async () => 'ok' as const,
  };
  sessionRef.current = {
    client,
    serverUrl: SERVER,
    projectKey: 'PROD',
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: SERVER, workspace: 'moooon', project: 'PROD' },
    },
  };
  h = { root, calls, git: [], stderr: '' };
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    h.stderr += String(chunk);
    return true;
  });
}

const tools = () => h.calls.map((c) => c.tool);

beforeEach(() => {
  process.env['MOTIR_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  delete process.env['MOTIR_AGENT'];
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (h?.root) rmSync(h.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir continue — the pipeline', () => {
  it('claims, checks the dead run’s branch out, runs the agent on the CONTINUE prompt, and delivers to Implemented', async () => {
    setup(claim());
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    expect(tools().slice(0, 2)).toEqual(['claim_continue', 'dispatch_prompt']);
    // The prompt was asked for AS A CONTINUE of the dead run.
    expect(h.calls[1]!.args).toMatchObject({ key: 'PROD-7', opts: { continueFrom: 'run_dead' } });
    // The branch was checked out beside the repository, exactly where the prompt says.
    const add = h.git.find((g) => g.args[0] === 'worktree' && g.args[1] === 'add');
    expect(add?.args).toContain(join(h.root, 'motir-core-prod-7'));
    expect(add?.args).toContain(`origin/${BRANCH}`);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]![0].prompt).toContain('CONTINUE — you are carrying on');
    // The same delivery `motir run` uses: the card moves to Implemented.
    expect(h.calls).toContainEqual({
      tool: 'transition_status',
      args: { key: 'PROD-7', status: 'implemented' },
    });
    // The run the SERVER opened is adopted, never a second one opened.
    expect(tools()).not.toContain('open_run');
    expect(h.stderr).toContain('Took PROD-7 over from Mara S.');
    expect(h.stderr).toContain(`Continuing on ${BRANCH}.`);
  });

  it.each([['m'], [null]] as const)(
    'reports the agent’s self-reported model (%s) top-level on `agent_exited` — through the shared leg (MOTIR-7504)',
    async (model) => {
      setup(claim());
      runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model }));
      await continueCommand(
        'PROD-7',
        { agent: 'fake-agent' },
        { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
      );

      const events = h.calls
        .filter((c) => c.tool === 'append')
        .flatMap((c) => (c.args as { events: Array<Record<string, unknown>> }).events);
      const exited = events.filter((e) => e['kind'] === 'agent_exited');
      expect(exited).toHaveLength(1);
      expect(exited[0]).toHaveProperty('model', model);
    },
  );

  it('every refusal prints its sentence, exits non-zero, and touches neither git nor the agent', async () => {
    for (const reason of [
      'run_alive',
      'use_fix',
      'not_in_progress',
      'continue_the_parent',
      'no_dead_run',
      'no_branch',
    ] as const) {
      setup(
        claim({
          outcome: 'not_continuable',
          reason,
          parentKey: 'PROD-2',
          runId: null,
          deadRun: null,
          branch: null,
        }),
      );
      await continueCommand('PROD-7', { agent: 'fake-agent' }, { run: fakeGit() });
      expect(process.exitCode, reason).toBe(1);
      expect(h.git, reason).toEqual([]);
      expect(tools(), reason).toEqual(['claim_continue']);
      expect(h.stderr, reason).toContain('PROD-7: nothing to continue — ');
      process.exitCode = undefined;
      vi.restoreAllMocks();
    }
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  // MOTIR-6537 — the pipeline's other exits.
  it('an empty key is refused before anything is asked', async () => {
    setup(claim());
    await expect(continueCommand('   ', { agent: 'fake-agent' })).rejects.toThrow(
      'A work item key is required',
    );
    expect(tools()).toEqual([]);
  });

  it('a checkout that fails settles the leg failed, closes the run halted, and runs no agent', async () => {
    setup(claim());
    const failingFetch: CommandRunner = (_bin, args, cwd) => {
      h.git.push({ args, cwd });
      return args[0] === 'fetch' ? { exitCode: 128, stdout: '', stderr: 'no such ref' } : ok();
    };
    await continueCommand('PROD-7', { agent: 'fake-agent' }, { run: failingFetch });

    expect(process.exitCode).toBe(1);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(h.stderr).toContain('could not fetch its branch');
    const appended = h.calls
      .filter((c) => c.tool === 'append')
      .flatMap((c) => (c.args as { events: { kind: string; disposition?: string }[] }).events);
    expect(appended).toContainEqual(
      expect.objectContaining({ kind: 'card_settled', disposition: 'failed' }),
    );
    expect(h.calls).toContainEqual(
      expect.objectContaining({
        tool: 'close_run',
        args: expect.objectContaining({ stopReason: 'halted' }),
      }),
    );
  });

  it('a continue of its OWN run (`mine`, no dead run) asks for a plain prompt', async () => {
    setup(claim({ outcome: 'mine', deadRun: null, previousAssignee: null }));
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );
    expect(h.calls[1]).toEqual({ tool: 'dispatch_prompt', args: { key: 'PROD-7', opts: {} } });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});

describe('motir continue — an interrupt closes the continue run `interrupted`', () => {
  it('Ctrl-C while the agent works closes the adopted run `interrupted` and exits 130', async () => {
    setup(claim());
    let handler: ((signal: 'SIGINT' | 'SIGTERM') => void) | null = null;
    const exits: number[] = [];
    let closed: Promise<void> = Promise.resolve();
    runAgentMock.mockImplementation(async () => {
      handler!('SIGINT');
      await closed;
      return { exitCode: 130, signal: 'SIGINT', model: null };
    });
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      {
        run: fakeGit(),
        onInterrupt: (fn) => {
          handler = fn;
          return () => undefined;
        },
        exit: (code) => {
          exits.push(code);
        },
      },
    );
    closed = Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const closes = h.calls.filter((c) => c.tool === 'close_run');
    expect(closes[0]?.args).toEqual({ runId: 'run_continue_1', stopReason: 'interrupted' });
    expect(exits).toEqual([130]);
  });
});

describe('renderContinueRefusal — each reason names what to do instead', () => {
  it.each([
    ['use_fix', 'motir fix PROD-7'],
    ['not_in_progress', 'motir run PROD-7'],
    ['continue_the_parent', 'motir continue PROD-2'],
    ['no_branch', 'set it to To Do'],
    ['run_alive', 'still alive'],
    ['no_dead_run', 'no run of it has died'],
    ['gate_awaiting', 'still waiting for approval'],
    ['gate_sent_back', 'was sent back, not approved'],
  ] as const)('%s', (reason, words) => {
    expect(
      renderContinueRefusal(claim({ outcome: 'not_continuable', reason, parentKey: 'PROD-2' })),
    ).toContain(words);
  });

  it('taken names the holder', () => {
    expect(
      renderContinueRefusal(claim({ outcome: 'taken', holder: { id: 'u', name: 'Jo P.' } })),
    ).toContain('already being continued by Jo P.');
  });

  // MOTIR-6537 — the words when the server left something out.
  it('taken with no holder and no start still reads as a sentence', () => {
    const line = renderContinueRefusal(claim({ outcome: 'taken', holder: null, startedAt: null }));
    expect(line).toContain('already being continued by somebody else —');
    expect(line).not.toContain('since');
  });

  it('run_alive names the holder when there is one; continue_the_parent without a parent key', () => {
    expect(
      renderContinueRefusal(
        claim({
          outcome: 'not_continuable',
          reason: 'run_alive',
          holder: { id: 'u', name: 'Mara S.' },
        }),
      ),
    ).toContain("(Mara S.'s)");
    expect(
      renderContinueRefusal(
        claim({ outcome: 'not_continuable', reason: 'run_alive', holder: null }),
      ),
    ).not.toContain("'s)");
    expect(
      renderContinueRefusal(
        claim({ outcome: 'not_continuable', reason: 'continue_the_parent', parentKey: null }),
      ),
    ).toContain('motir continue <the parent>');
  });

  it('a refusal with no reason is the generic sentence', () => {
    expect(renderContinueRefusal(claim({ outcome: 'not_continuable', reason: null }))).toContain(
      'the server refused the continue',
    );
  });
});

describe('a gated run — resumed or refused by its gates (MOTIR-7708)', () => {
  const gates = [{ key: 'PROD-9', kind: 'design_result', state: 'awaiting' }];

  it('a refusal names the gates that still hold the run', () => {
    expect(
      renderContinueRefusal(claim({ outcome: 'not_continuable', reason: 'gate_awaiting', gates })),
    ).toContain('(PROD-9: design_result)');
  });

  it('a resume says it resumes after an approval, never that a run died', () => {
    const line = renderTakeover(
      claim({ resumesGated: true, gates: [{ ...gates[0]!, state: 'approved' }] }),
    );
    expect(line).toBe(
      'Took PROD-7 over from Mara S. — resuming its run after an approval ' +
        `(PROD-9: design_result).\nResuming on ${BRANCH}.`,
    );
    expect(line).not.toContain('last heard from');
  });
});

describe('renderTakeover — whose work, and where (MOTIR-6537)', () => {
  it('names the previous assignee, the dead run’s dispatcher and the branch', () => {
    expect(renderTakeover(claim())).toBe(
      "Took PROD-7 over from Mara S. — its last run (Mara S.'s) was last heard from " +
        `2026-09-27T09:50:00.000Z.\nContinuing on ${BRANCH}.`,
    );
  });

  it('reads plainly when the server knew none of them', () => {
    expect(renderTakeover(claim({ previousAssignee: null, deadRun: null, branch: null }))).toBe(
      'Took PROD-7 over.\nContinuing on its branch.',
    );
    const noDispatcher = claim();
    noDispatcher.deadRun = { ...noDispatcher.deadRun!, dispatcher: null };
    expect(renderTakeover(noDispatcher)).toContain("its last run (somebody's)");
  });
});

describe('prepareContinueCheckout — reuse as found, add otherwise, never reset', () => {
  const base = (root: string, exists: (p: string) => boolean, run: CommandRunner) => ({
    key: 'PROD-7',
    branch: BRANCH,
    targetRepo: 'motir-core',
    rootDir: root,
    config: { serverUrl: SERVER, workspace: 'moooon', project: 'PROD' },
    run,
    exists,
  });

  it('reuses an existing worktree that is on the branch — dirty or clean, untouched', () => {
    setup(claim());
    const wt = join(h.root, 'motir-core-prod-7');
    const result = prepareContinueCheckout(
      base(h.root, (p) => p === join(h.root, 'motir-core') || p === wt, fakeGit({ [wt]: BRANCH })),
    );
    expect(result).toEqual({ ok: true, path: wt });
    expect(h.git.some((g) => g.args[0] === 'worktree')).toBe(false);
    for (const destructive of ['reset', 'clean', 'stash', 'checkout']) {
      expect(h.git.some((g) => g.args[0] === destructive)).toBe(false);
    }
  });

  it('refuses a worktree at that path on ANOTHER branch, naming it, and resets nothing', () => {
    setup(claim());
    const wt = join(h.root, 'motir-core-prod-7');
    const result = prepareContinueCheckout(
      base(
        h.root,
        (p) => p === join(h.root, 'motir-core') || p === wt,
        fakeGit({ [wt]: 'other/branch' }),
      ),
    );
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('other/branch');
    expect(h.git.some((g) => ['reset', 'clean', 'stash'].includes(g.args[0]!))).toBe(false);
  });

  // MOTIR-6537 — every way the checkout can fail says so, and changes nothing.
  const scripted =
    (answers: { fetch?: number; add?: number; local?: number; head?: string; headCode?: number }) =>
    (_bin: string, args: string[], cwd: string): CommandResult => {
      h.git.push({ args, cwd });
      if (args[0] === 'fetch') return { exitCode: answers.fetch ?? 0, stdout: '', stderr: 'boom' };
      if (args[0] === 'rev-parse' && args[1] === '--verify')
        return { exitCode: answers.local ?? 1, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
        return { exitCode: answers.headCode ?? 0, stdout: answers.head ?? '', stderr: '' };
      if (args[0] === 'worktree') return { exitCode: answers.add ?? 0, stdout: '', stderr: 'nope' };
      return ok();
    };
  const repoThere = (p: string) => p === join(h.root, 'motir-core');

  it('a branch that cannot be fetched is refused, naming it', () => {
    setup(claim());
    const result = prepareContinueCheckout(base(h.root, repoThere, scripted({ fetch: 1 })));
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain(
      `could not fetch its branch \`${BRANCH}\` — boom`,
    );
  });

  it('a worktree that cannot be added is refused, naming the path', () => {
    setup(claim());
    const result = prepareContinueCheckout(base(h.root, repoThere, scripted({ add: 1 })));
    expect((result as { message: string }).message).toContain('could not check out');
  });

  it('a branch that already exists LOCALLY is checked out, not re-created', () => {
    setup(claim());
    const result = prepareContinueCheckout(base(h.root, repoThere, scripted({ local: 0 })));
    expect(result.ok).toBe(true);
    const add = h.git.find((g) => g.args[0] === 'worktree');
    expect(add?.args).toEqual(['worktree', 'add', join(h.root, 'motir-core-prod-7'), BRANCH]);
  });

  it('a worktree whose HEAD cannot be read is refused as “something else”', () => {
    setup(claim());
    const wt = join(h.root, 'motir-core-prod-7');
    const result = prepareContinueCheckout(
      base(h.root, (p) => repoThere(p) || p === wt, scripted({ headCode: 1 })),
    );
    expect((result as { message: string }).message).toContain('is on `something else`');
  });

  it('a pinned repository with no checkout is refused, naming where it was looked for', () => {
    setup(claim());
    const result = prepareContinueCheckout(base(h.root, () => false, scripted({})));
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain(
      `no local checkout of motir-core at ${join(h.root, 'motir-core')}`,
    );
    expect(h.git).toEqual([]);
  });

  it('a card pinned to NO repository continues in the link root, beside it — as `motir run` works there', () => {
    // Found by the story gate against the real server (MOTIR-6537): the one-repo
    // link has `.motir.json` inside the checkout and cards with no `targetRepo`,
    // and every one of them was refused as having no local checkout.
    setup(claim());
    const repo = join(h.root, 'motir-core');
    const result = prepareContinueCheckout({
      ...base(repo, () => false, fakeGit()),
      targetRepo: null,
    });
    expect(result).toEqual({ ok: true, path: join(h.root, 'motir-core-prod-7') });
    const add = h.git.find((g) => g.args[0] === 'worktree' && g.args[1] === 'add');
    expect(add?.cwd).toBe(repo);
  });
});

// MOTIR-6793 — a card across repositories resumes EVERY one of them.
describe('motir continue — a card across repositories', () => {
  const AI_BRANCH = 'subtask/PROD-7-add-the-thing-ai';
  const twoRepos: Partial<DispatchPrompt> = {
    targetRepos: [
      { name: 'motir-core', cloneUrl: 'https://github.com/acme/motir-core.git' },
      { name: 'motir-ai', cloneUrl: 'https://github.com/acme/motir-ai.git' },
    ] as DispatchPrompt['targetRepos'],
    workBranch: 'subtask/PROD-7-add-the-thing',
  };
  const branches = [
    { repository: 'motir-core', branch: BRANCH, pullRequest: null },
    { repository: 'motir-ai', branch: AI_BRANCH, pullRequest: null },
  ];
  const adds = () =>
    h.git.filter((g) => g.args[0] === 'worktree' && g.args[1] === 'add').map((g) => g.args);
  const checkoutEvents = () =>
    h.calls
      .filter((c) => c.tool === 'append')
      .flatMap(
        (c) => (c.args as { events: { kind: string; data?: Record<string, unknown> }[] }).events,
      )
      .filter((e) => e.kind === 'checkout_ready');

  it('checks both repositories out on their dead branches, starts the agent once, and delivers', async () => {
    setup(claim({ branches }), twoRepos);
    mkdirSync(join(h.root, 'motir-ai'));
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    expect(adds()).toEqual([
      [
        'worktree',
        'add',
        '--track',
        '-b',
        BRANCH,
        join(h.root, 'motir-core-prod-7'),
        `origin/${BRANCH}`,
      ],
      [
        'worktree',
        'add',
        '--track',
        '-b',
        AI_BRANCH,
        join(h.root, 'motir-ai-prod-7'),
        `origin/${AI_BRANCH}`,
      ],
    ]);
    expect(h.git.some((g) => g.args[0] === 'clone')).toBe(false);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    // Every checkout_ready — the continue's own and the leg's — names BOTH
    // repositories' dead branches, never the card's fresh one for the second.
    const events = checkoutEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(e.data?.['branches']).toEqual([
        expect.objectContaining({ repository: 'motir-core', branch: BRANCH }),
        expect.objectContaining({ repository: 'motir-ai', branch: AI_BRANCH }),
      ]);
    }
    expect(h.calls).toContainEqual({
      tool: 'transition_status',
      args: { key: 'PROD-7', status: 'implemented' },
    });
    expect(h.stderr).toContain(`motir-ai: ${AI_BRANCH} at ${join(h.root, 'motir-ai-prod-7')}`);
  });

  it('clones a repository with no local checkout beside the first, then checks its dead branch out', async () => {
    setup(claim({ branches }), twoRepos);
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    const clone = h.git.find((g) => g.args[0] === 'clone');
    expect(clone?.args).toEqual([
      'clone',
      'https://github.com/acme/motir-ai.git',
      join(h.root, 'motir-ai'),
    ]);
    const aiAdd = h.git.find((g) => g.args[0] === 'worktree' && g.args.includes(AI_BRANCH));
    expect(aiAdd?.cwd).toBe(join(h.root, 'motir-ai'));
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('a repository the dead run never pushed to is started on the card’s fresh branch', async () => {
    setup(claim({ branches: [branches[0]!] }), twoRepos);
    mkdirSync(join(h.root, 'motir-ai'));
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    const fresh = 'subtask/PROD-7-add-the-thing';
    expect(adds()[1]).toEqual([
      'worktree',
      'add',
      '-b',
      fresh,
      join(h.root, 'motir-ai-prod-7'),
      'origin/HEAD',
    ]);
    expect(checkoutEvents()[0]!.data?.['branches']).toEqual([
      expect.objectContaining({ repository: 'motir-core', branch: BRANCH }),
      expect.objectContaining({ repository: 'motir-ai', branch: fresh }),
    ]);
  });

  it('a clone that fails refuses before any agent, closing the run halted', async () => {
    setup(claim({ branches }), twoRepos);
    const git = fakeGit();
    const failingClone: CommandRunner = (bin, args, cwd) =>
      args[0] === 'clone'
        ? (h.git.push({ args, cwd }), { exitCode: 128, stdout: '', stderr: 'denied' })
        : git(bin, args, cwd);
    await continueCommand('PROD-7', { agent: 'fake-agent' }, { run: failingClone });

    expect(process.exitCode).toBe(1);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(h.stderr).toContain('a repository could not be cloned');
    expect(h.calls).toContainEqual(
      expect.objectContaining({
        tool: 'close_run',
        args: expect.objectContaining({ stopReason: 'halted' }),
      }),
    );
  });
});

// MOTIR-6795 — `motir continue` in a hosted container ADOPTS the run the server's
// continue claim opened: it claims nothing and opens nothing.
describe('motir continue — hosted, on the run the server opened', () => {
  const RUN = 'run_hosted_continue';
  function hosted(
    continues: Record<string, unknown> | null,
    over: { command?: string; legs?: string[] } = {},
    promptOver: Partial<DispatchPrompt> = {},
  ) {
    setup(claim(), promptOver);
    process.env['MOTIR_DISPATCH_RUN_ID'] = RUN;
    adoptedRef.current = { runId: RUN, projectKey: 'PROD', legs: over.legs ?? ['PROD-7'] };
    const client = (sessionRef.current as { client: Record<string, unknown> }).client;
    client['getDispatchRun'] = async (id: string) => {
      h.calls.push({ tool: 'get_run', args: id });
      return {
        runId: RUN,
        status: 'running',
        command: over.command ?? 'continue',
        origin: 'hosted',
        model: 'claude-opus-5-5',
        endedAt: null,
        cards: [],
        continues,
      };
    };
  }
  afterEach(() => {
    delete process.env['MOTIR_DISPATCH_RUN_ID'];
    adoptedRef.current = null;
  });

  it('continues the leaf on the dead branch — no claim, no second run — and closes the adopted run', async () => {
    hosted({
      fromRunId: 'run_dead',
      branch: BRANCH,
      branches: [{ repository: 'motir-core', branch: BRANCH }],
      mode: 'card',
      landedKeys: [],
      resumedKeys: [],
    });
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    expect(tools()).not.toContain('claim_continue');
    expect(tools()).not.toContain('open_run');
    expect(h.calls).toContainEqual({
      tool: 'dispatch_prompt',
      args: { key: 'PROD-7', opts: { continueFrom: 'run_dead' } },
    });
    const add = h.git.find((g) => g.args[0] === 'worktree' && g.args[1] === 'add');
    expect(add?.args).toContain(`origin/${BRANCH}`);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    // Every event went to the adopted run, which is closed once.
    const appended = h.calls.filter((c) => c.tool === 'append');
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.every((c) => (c.args as { runId: string }).runId === RUN)).toBe(true);
    expect(h.calls.filter((c) => c.tool === 'close_run')).toHaveLength(1);
    expect(h.calls).toContainEqual({
      tool: 'transition_status',
      args: { key: 'PROD-7', status: 'implemented' },
    });
  });

  it('clones every repository into the workspace and checks each out at its dead branch', async () => {
    hosted(
      {
        fromRunId: 'run_dead',
        branch: BRANCH,
        branches: [
          { repository: 'motir-core', branch: BRANCH },
          { repository: 'motir-ai', branch: 'subtask/PROD-7-ai' },
        ],
        mode: 'card',
        landedKeys: [],
        resumedKeys: [],
      },
      {},
      {
        targetRepos: [
          { name: 'motir-core', cloneUrl: 'https://github.com/acme/motir-core.git' },
          { name: 'motir-ai', cloneUrl: 'https://github.com/acme/motir-ai.git' },
        ] as DispatchPrompt['targetRepos'],
      },
    );
    rmSync(join(h.root, 'motir-core'), { recursive: true, force: true });
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    expect(h.git.filter((g) => g.args[0] === 'clone').map((g) => g.args[2])).toEqual([
      join(h.root, 'motir-core'),
      join(h.root, 'motir-ai'),
    ]);
    expect(h.git.filter((g) => g.args[0] === 'worktree').map((g) => g.args[4])).toEqual([
      BRANCH,
      'subtask/PROD-7-ai',
    ]);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('a run that is not a continue fails setup with exit code 20 and touches nothing', async () => {
    hosted(null, { command: 'run' });
    await expect(
      continueCommand('PROD-7', { agent: 'fake-agent' }, { run: fakeGit() }),
    ).rejects.toMatchObject({ exitCode: 20 });
    expect(h.git).toEqual([]);
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(tools()).not.toContain('claim_continue');
  });

  it('a leaf that is not a card of the adopted run is refused', async () => {
    hosted(
      {
        fromRunId: 'run_dead',
        branch: BRANCH,
        branches: [],
        mode: 'card',
        landedKeys: [],
        resumedKeys: [],
      },
      { legs: ['PROD-9'] },
    );
    await expect(
      continueCommand('PROD-7', { agent: 'fake-agent' }, { run: fakeGit() }),
    ).rejects.toThrow('PROD-7 is not a card of run');
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
