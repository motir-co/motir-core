import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type { CommandRunner } from '../src/git.js';
import type {
  DispatchItem,
  DispatchPrompt,
  ScopeClaim,
  WorkItemContinueClaim,
  WorkItemDetail,
} from '../src/client.js';

// `motir continue <PARENT>` (Story MOTIR-6526 · MOTIR-6535) — a dead SCOPED run
// resumes through `motir run <parent>`'s own drain, on the dead run's session
// branch, through its existing draft pull request, and never re-runs a landed
// child. Driven through the real `continueCommand` against a scripted client and
// a recording git/gh, the same shape as `scopeCommand.test.ts`.

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

const { continueCommand } = await import('../src/commands/continue.js');
const { mergeBaseIntoRemoteBranch } = await import('../src/git.js');

const SERVER = 'https://app.motir.co';
const OWNER = 'user_me';

/** A child row: a bare key is `todo`, or `KEY@status` pins one. */
function childRow(spec: string): WorkItemDetail['children'][number] {
  const [key = spec, status = 'todo'] = spec.split('@');
  return {
    identifier: key,
    kind: 'subtask',
    title: `Item ${key}`,
    status,
    dependencies: { blockedBy: [], blocks: [] },
  };
}

function detail(
  over: Partial<WorkItemDetail['item']> = {},
  children: string[] = [],
): WorkItemDetail {
  return {
    item: {
      identifier: 'PROD-1',
      kind: 'story',
      title: 'The story',
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      type: null,
      executor: null,
      storyPoints: null,
      estimateMinutes: null,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
      ...over,
    },
    ancestors: [],
    children: children.map(childRow),
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  };
}

function readyRow(key: string): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    assigneeId: null,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
  };
}

function scopeClaim(over: Partial<ScopeClaim> = {}): ScopeClaim {
  return {
    scope: { kind: 'work_item', key: 'PROD-1', sprintId: null, name: 'The story' },
    outcome: 'claimed',
    claimed: true,
    members: [
      {
        key: 'PROD-1',
        title: 'The story',
        status: { key: 'in_progress', category: 'in_progress' },
      },
      {
        key: 'PROD-2',
        title: 'Item PROD-2',
        status: { key: 'in_progress', category: 'in_progress' },
      },
    ],
    offender: null,
    shape: null,
    blockers: [],
    ...over,
  };
}

const BRANCH = 'motir/auto-20260927-0900';
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

function parentClaim(over: Partial<WorkItemContinueClaim> = {}): WorkItemContinueClaim {
  return {
    key: 'PROD-1',
    title: 'The story',
    outcome: 'claimed',
    reason: null,
    parentKey: null,
    runId: 'run_continue_parent',
    holder: { id: OWNER, name: 'Me' },
    startedAt: '2026-09-27T10:00:00.000Z',
    deadRun: {
      id: 'run_dead_scope',
      command: 'run_scope',
      origin: 'local',
      status: 'timed_out',
      stopReason: 'abandoned',
      lastHeardAt: '2026-09-27T09:50:00.000Z',
      dispatcher: { id: 'user_mara', name: 'Mara S.' },
    },
    branch: BRANCH,
    pullRequest: null,
    previousAssignee: { id: 'user_mara', name: 'Mara S.' },
    mode: 'parent',
    landedKeys: ['PROD-2'],
    resumedKeys: [],
    ...over,
  };
}

interface H {
  calls: { tool: string; args: unknown }[];
  commands: string[];
  stderr: string;
  root: string;
}
let h: H;

/** git/gh that RECORDS: the dead run's branch is ON ORIGIN and behind main, and
 *  it already has an OPEN pull request (the draft) — so the resume must merge
 *  main in, and must not `gh pr create` a second one. */
function recordingGit(): CommandRunner {
  return (bin, args) => {
    h.commands.push([bin, ...args].join(' '));
    if (bin === 'git' && args[0] === 'rev-parse' && args[3] === `refs/remotes/origin/${BRANCH}`)
      return ok('abc');
    if (bin === 'git' && args[0] === 'merge-base') return { exitCode: 1, stdout: '', stderr: '' };
    if (bin === 'git' && args[0] === 'rev-list' && args[1] === '--count') return ok('1');
    if (bin === 'git' && (args[0] === 'ls-remote' || args[0] === 'log'))
      return ok(`abc\trefs/heads/${BRANCH}`);
    if (bin === 'gh' && args[1] === 'list' && !args.includes('isDraft')) {
      return ok('https://github.com/moooon/motir-core/pull/77');
    }
    return ok();
  };
}

function setup(
  over: {
    ready?: DispatchItem[];
    claim?: Partial<WorkItemContinueClaim>;
    targetRepos?: DispatchPrompt['targetRepos'];
  } = {},
) {
  const calls: H['calls'] = [];
  const root = mkdtempSync(join(tmpdir(), 'motir-continue-parent-'));
  mkdirSync(join(root, 'motir-core'));
  // Only the NOT-landed child is ready: PROD-2 is Implemented, PROD-3 is in flight.
  const ready: DispatchItem[] = over.ready ?? [readyRow('PROD-3')];
  const client = {
    whoami: async () => ({
      user: { id: OWNER, name: 'Me', email: 'me@motir.test' },
      workspace: null,
    }),
    claimWorkItemContinue: async (key: string) => {
      calls.push({ tool: 'claim_continue', args: key });
      return parentClaim(over.claim);
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      // A leaf read — the resumed in-flight leg's row (MOTIR-6537).
      if (key !== 'PROD-1') {
        return detail({
          identifier: key,
          kind: 'subtask',
          title: `Item ${key}`,
          status: 'in_progress',
          assigneeId: OWNER,
        });
      }
      return detail({ status: 'in_progress' }, ['PROD-2@implemented', 'PROD-3@in_progress']);
    },
    listReadyForDispatch: async (args: unknown) => {
      calls.push({ tool: 'list_ready', args });
      return ready;
    },
    claimScope: async (args: unknown) => {
      calls.push({ tool: 'claim_scope', args });
      return scopeClaim({
        outcome: 'mine',
        members: [
          {
            key: 'PROD-1',
            title: 'The story',
            status: { key: 'in_progress', category: 'in_progress' },
          },
          {
            key: 'PROD-3',
            title: 'Item PROD-3',
            status: { key: 'in_progress', category: 'in_progress' },
          },
        ],
      } as Partial<ScopeClaim>);
    },
    claimWorkItem: async (args: { key: string }) => {
      calls.push({ tool: 'claim', args });
      return resolveFakeClaim(
        { key: args.key, title: `Item ${args.key}`, status: 'in_progress', assigneeId: OWNER },
        { id: OWNER, name: 'Me' },
      ).claim;
    },
    searchWorkItems: async () => ({
      items: ready.map((r) => ({
        identifier: r.key,
        kind: r.kind,
        title: r.title,
        status: 'in_progress',
        dependencies: { blockedBy: [], blocks: [] },
      })),
      nextCursor: null,
    }),
    dispatchPrompt: async (
      key: string,
      opts: { sessionBranch?: string },
    ): Promise<DispatchPrompt> => {
      calls.push({ tool: 'dispatch_prompt', args: { key, sessionBranch: opts?.sessionBranch } });
      return {
        key,
        prompt: `PROMPT ${key}`,
        parentKey: 'PROD-1',
        targetRepo: 'motir-core',
        workflowMode: 'session_lineage',
        sessionBranch: opts?.sessionBranch ?? null,
        ...(over.targetRepos ? { targetRepos: over.targetRepos } : {}),
      };
    },
    markIntegrated: async (args: unknown) => {
      calls.push({ tool: 'mark_integrated', args });
      return {};
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
    dispatchRunCloseOutPrompt: async () => ({
      targetKey: 'PROD-1',
      prompt: 'CLOSE OUT',
      landedKeys: [],
    }),
    workItemHowToTest: async () => null,
    transitionStatus: async (args: unknown) => {
      calls.push({ tool: 'transition_status', args });
    },
    linkPullRequest: async (args: unknown) => {
      calls.push({ tool: 'link_pr', args });
      return {};
    },
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
  h = { calls, commands: [], stderr: '', root };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    h.stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

beforeEach(() => {
  process.env['MOTIR_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (h?.root) rmSync(h.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir continue <PARENT>', () => {
  it('resumes on the dead run’s session branch, merges main first, reuses the draft, and never re-runs a landed child', async () => {
    setup();
    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      {
        run: recordingGit(),
        clock: () => 0,
        now: () => new Date(0),
      },
    );

    // The dead run's BRANCH, not a freshly minted one: every child's prompt is
    // asked for with it as the session branch.
    const prompts = h.calls.filter((c) => c.tool === 'dispatch_prompt');
    expect(prompts.map((p) => p.args)).toEqual([{ key: 'PROD-3', sessionBranch: BRANCH }]);
    // The LANDED child is never dispatched, and is named.
    // ONE child agent (the other spawn is the close-out's How-to-test agent).
    expect(
      runAgentMock.mock.calls.filter((c) => String(c[0].prompt).startsWith('PROMPT ')),
    ).toHaveLength(1);
    expect(h.stderr).toContain('Already landed — not run again: PROD-2.');
    // origin/main is merged into the reused branch BEFORE any child runs.
    const mergeAt = h.commands.findIndex((c) => c.startsWith('git merge --no-edit origin/main'));
    expect(mergeAt).toBeGreaterThan(-1);
    expect(h.commands.some((c) => c.startsWith(`git push origin HEAD:refs/heads/${BRANCH}`))).toBe(
      true,
    );
    // NO SECOND PULL REQUEST: the draft is found by its head and reused.
    expect(h.commands.some((c) => c.startsWith('gh pr create'))).toBe(false);
    // The run is the server's, adopted — never a second one opened.
    expect(h.calls.map((c) => c.tool)).not.toContain('open_run');
    // MOTIR-10985 — the reused draft is the PARENT's: linked to it from the first
    // card this continue lands, whatever the carried set's partition reads.
    const linked = h.calls
      .filter((c) => c.tool === 'link_pr')
      .map((c) => (c.args as { key: string }).key);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked).toContain('PROD-1');
    expect(linked).toContain('PROD-3');
  });
});

describe('motir continue <PARENT> — the IN-FLIGHT legs (MOTIR-6537)', () => {
  it('runs a leg the claim resumed even though the ready set — To Do only — does not list it', async () => {
    // Found by the story gate against the REAL server: the dead run's in-flight
    // child is In Progress, so the ready set never lists it, and a resume that read
    // only the ready set dispatched nothing ("nothing is ready to start").
    setup({ ready: [], claim: { resumedKeys: ['PROD-3'] } });
    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      { run: recordingGit(), clock: () => 0, now: () => new Date(0) },
    );

    const prompts = h.calls.filter((c) => c.tool === 'dispatch_prompt');
    expect(prompts.map((p) => p.args)).toEqual([{ key: 'PROD-3', sessionBranch: BRANCH }]);
    expect(h.stderr).not.toContain('nothing is ready to start');
    // The scope claim of a RESUME leaves the landed children out (MOTIR-6537).
    expect(h.calls.find((c) => c.tool === 'claim_scope')?.args).toEqual({
      kind: 'work_item',
      key: 'PROD-1',
      exceptLanded: true,
    });
  });

  it('a session branch not minted by `motir auto` gets a fresh run id from the clock', async () => {
    setup({ claim: { branch: 'story/refunds-session' } });
    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      { run: recordingGit(), clock: () => 0 },
    );
    const prompts = h.calls.filter((c) => c.tool === 'dispatch_prompt');
    expect(prompts.map((p) => p.args)).toEqual([
      { key: 'PROD-3', sessionBranch: 'story/refunds-session' },
    ]);
  });

  it('with nothing ready and nothing resumed, it closes the adopted run `completed` and runs no agent', async () => {
    setup({ ready: [], claim: { landedKeys: [], resumedKeys: [] } });
    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      { run: recordingGit(), clock: () => 0, now: () => new Date(0) },
    );
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(h.stderr).not.toContain('Already landed');
    expect(h.calls).toContainEqual(
      expect.objectContaining({
        tool: 'close_run',
        args: expect.objectContaining({ stopReason: 'completed' }),
      }),
    );
  });
});

// MOTIR-6794 — a parent across repositories resumes EVERY repository's line of work.
describe('motir continue <PARENT> — across repositories', () => {
  const AI_BRANCH = 'motir/auto-20260927-0900-ai';
  const twoRepos = [
    { name: 'motir-core', cloneUrl: 'https://github.com/acme/motir-core.git' },
    { name: 'motir-ai', cloneUrl: 'https://github.com/acme/motir-ai.git' },
  ] as DispatchPrompt['targetRepos'];

  /** A git/gh that knows WHICH checkout it runs in: origin has `onOrigin[cwd]`'s
   *  branches, and each has an open draft — so nothing may `gh pr create`. */
  function perRepoGit(onOrigin: Record<string, string[]>): {
    run: CommandRunner;
    seen: { line: string; cwd: string }[];
  } {
    const seen: { line: string; cwd: string }[] = [];
    const run: CommandRunner = (bin, args, cwd) => {
      const line = [bin, ...args].join(' ');
      seen.push({ line, cwd });
      h.commands.push(line);
      if (bin === 'git' && args[0] === 'clone') {
        mkdirSync(args[2]!, { recursive: true });
        return ok();
      }
      if (bin === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        const ref = args[3] ?? '';
        const branches = onOrigin[cwd] ?? [];
        return branches.some((b) => ref === `refs/remotes/origin/${b}`)
          ? ok('abc')
          : { exitCode: 1, stdout: '', stderr: '' };
      }
      if (bin === 'git' && args[0] === 'merge-base') return { exitCode: 1, stdout: '', stderr: '' };
      if (bin === 'git' && args[0] === 'rev-list' && args[1] === '--count') return ok('1');
      if (bin === 'git' && (args[0] === 'ls-remote' || args[0] === 'log'))
        return ok(`abc\trefs/heads/${BRANCH}`);
      if (bin === 'gh' && args[1] === 'list' && !args.includes('isDraft')) {
        return ok('https://github.com/acme/repo/pull/77');
      }
      return ok();
    };
    return { run, seen };
  }

  it('resumes BOTH repositories on their own session branches and opens no new draft in either', async () => {
    setup({
      targetRepos: twoRepos,
      claim: {
        branches: [
          { repository: 'motir-core', branch: BRANCH, pullRequest: null },
          { repository: 'motir-ai', branch: AI_BRANCH, pullRequest: null },
        ],
      },
    });
    mkdirSync(join(h.root, 'motir-ai'));
    const core = join(h.root, 'motir-core');
    const ai = join(h.root, 'motir-ai');
    const git = perRepoGit({ [core]: [BRANCH], [ai]: [AI_BRANCH] });
    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      { run: git.run, clock: () => 0, now: () => new Date(0) },
    );

    // Each repository reuses ITS branch — neither is created on origin.
    expect(h.stderr).toContain(`Session branch ${BRANCH} already on origin in ${core}`);
    expect(h.stderr).toContain(`Session branch ${AI_BRANCH} already on origin in ${ai}`);
    expect(git.seen.some((c) => c.line.includes('refs/remotes/origin/main:refs/heads/'))).toBe(
      false,
    );
    // And main is merged into each before any child builds on it.
    expect(
      git.seen.filter((c) => c.line.startsWith('git merge --no-edit origin/main')),
    ).not.toEqual([]);
    expect(git.seen.some((c) => c.line.startsWith('gh pr create'))).toBe(false);
    // The landed child is still never dispatched.
    expect(h.stderr).toContain('Already landed — not run again: PROD-2.');
    expect(h.calls.filter((c) => c.tool === 'dispatch_prompt').map((c) => c.args)).toEqual([
      { key: 'PROD-3', sessionBranch: BRANCH },
    ]);
  });

  it('a repository with no checkout is cloned first; one with no session branch yet gets one cut', async () => {
    setup({
      targetRepos: twoRepos,
      claim: { branches: [{ repository: 'motir-core', branch: BRANCH, pullRequest: null }] },
    });
    const core = join(h.root, 'motir-core');
    const ai = join(h.root, 'motir-ai');
    const git = perRepoGit({ [core]: [BRANCH] });
    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      { run: git.run, clock: () => 0, now: () => new Date(0) },
    );

    expect(git.seen.map((c) => c.line)).toContain(
      `git clone https://github.com/acme/motir-ai.git ${ai}`,
    );
    // Cut exactly the way `motir run <parent>` cuts one: the run's branch name,
    // pushed from origin/main — in the repository that had none.
    expect(git.seen).toContainEqual({
      line: `git push origin refs/remotes/origin/main:refs/heads/${BRANCH}`,
      cwd: ai,
    });
    expect(h.stderr).toContain(`Session branch ${BRANCH} already on origin in ${core}`);
  });
});

// MOTIR-6795 — a hosted parent continue ADOPTS the run the server's continue
// claim opened: no continue claim, no scope claim, and the landed legs stay landed.
describe('motir continue <PARENT> — hosted, on the run the server opened', () => {
  const RUN = 'run_hosted_parent';
  afterEach(() => {
    delete process.env['MOTIR_DISPATCH_RUN_ID'];
    adoptedRef.current = null;
  });

  it('drains the adopted legs less the landed ones on the dead session branch, claiming nothing', async () => {
    setup({ ready: [] });
    process.env['MOTIR_DISPATCH_RUN_ID'] = RUN;
    adoptedRef.current = { runId: RUN, projectKey: 'PROD', legs: ['PROD-2', 'PROD-3'] };
    const client = (sessionRef.current as { client: Record<string, unknown> }).client;
    client['getDispatchRun'] = async (id: string) => {
      h.calls.push({ tool: 'get_run', args: id });
      return {
        runId: RUN,
        status: 'running',
        command: 'continue',
        origin: 'hosted',
        model: 'claude-opus-5-5',
        endedAt: null,
        cards: [],
        continues: {
          fromRunId: 'run_dead_scope',
          branch: BRANCH,
          branches: [{ repository: 'motir-core', branch: BRANCH }],
          mode: 'parent',
          landedKeys: ['PROD-2'],
          resumedKeys: [],
        },
      };
    };
    client['me'] = async () => ({ id: OWNER, name: 'Me', email: 'me@motir.test' });

    await continueCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      { run: recordingGit(), clock: () => 0, now: () => new Date(0) },
    );

    const tools = h.calls.map((c) => c.tool);
    expect(tools).not.toContain('claim_continue');
    expect(tools).not.toContain('claim_scope');
    expect(tools).not.toContain('open_run');
    // Only the NOT-landed leg runs, on the dead run's branch.
    const prompts = h.calls.filter((c) => c.tool === 'dispatch_prompt');
    expect(prompts.map((p) => p.args)).toEqual([{ key: 'PROD-3', sessionBranch: BRANCH }]);
    expect(h.commands.some((c) => c.startsWith('git merge --no-edit origin/main'))).toBe(true);
    expect(h.commands.some((c) => c.startsWith('gh pr create'))).toBe(false);
    const appended = h.calls.filter((c) => c.tool === 'append');
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.every((c) => (c.args as { runId: string }).runId === RUN)).toBe(true);
  });
});

describe('mergeBaseIntoRemoteBranch', () => {
  const run = (answers: Record<string, number>): { run: CommandRunner; seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      run: (_bin, args) => {
        const line = args.join(' ');
        seen.push(line);
        const code = Object.entries(answers).find(([k]) => line.startsWith(k))?.[1] ?? 0;
        return { exitCode: code, stdout: '', stderr: '' };
      },
    };
  };

  it('up_to_date when the branch already contains the base — touches nothing', () => {
    const r = run({ 'merge-base': 0 });
    expect(mergeBaseIntoRemoteBranch('/r', BRANCH, r.run)).toBe('up_to_date');
    expect(r.seen.some((l) => l.startsWith('worktree'))).toBe(false);
  });

  it('merges in a throwaway worktree and pushes', () => {
    const r = run({ 'merge-base': 1 });
    expect(mergeBaseIntoRemoteBranch('/r', BRANCH, r.run)).toBe('merged');
    expect(r.seen).toContain(`push origin HEAD:refs/heads/${BRANCH}`);
    expect(r.seen.some((l) => l.startsWith('worktree remove --force'))).toBe(true);
  });

  it('a conflict is ABORTED and reported — nothing pushed', () => {
    const r = run({ 'merge-base': 1, 'merge --no-edit': 1 });
    expect(mergeBaseIntoRemoteBranch('/r', BRANCH, r.run)).toBe('conflict');
    expect(r.seen).toContain('merge --abort');
    expect(r.seen.some((l) => l.startsWith('push'))).toBe(false);
    expect(r.seen.some((l) => l.startsWith('worktree remove --force'))).toBe(true);
  });
});
