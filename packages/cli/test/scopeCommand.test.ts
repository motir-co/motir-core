import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type { CommandRunner } from '../src/git.js';
import type { DispatchItem, DispatchPrompt, ScopeClaim, WorkItemDetail } from '../src/client.js';

// `motir run <scope>` — the FRONT HALF, driven through the real `runCommand`
// against a scripted client (Story MOTIR-3001 · MOTIR-3198).
//
// What these tests are for, and what they deliberately are NOT for:
//
//   • They assert the PIPELINE — which requests happen, in what order, and what
//     the run does with each typed answer. The rendering of those answers is
//     asserted against plain objects in `scopedRun.test.ts`, and the atomicity
//     of the claim itself is `tests/ready/claimScope.test.ts`'s, over real
//     Postgres. Nothing here re-tests either.
//   • The one thing they DO have to prove about the shape of the requests is
//     that the container's own key never reaches `dispatchPrompt`, and that the
//     claim is ONE call for the whole set rather than one per card. Both are
//     properties of the run, invisible in any single function.

const { runAgentMock, sessionRef } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../src/agentRun.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { runCommand } = await import('../src/commands/dispatch.js');

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

interface Harness {
  calls: { tool: string; args: unknown }[];
  stderr: string;
  root: string;
  /** Every page of ready rows, served in order; the walk is inside the client. */
  ready: DispatchItem[];
}

let harness: Harness;
let home: string;

function setup(
  opts: {
    /** One detail for every read, or a function of the read's 0-based INDEX and
     *  the KEY it asked for — which is how a test makes the container's child
     *  set GROW mid-run. */
    detail?: WorkItemDetail | ((readIndex: number, key: string) => WorkItemDetail);
    ready?: DispatchItem[];
    claim?: ScopeClaim;
    planError?: Error;
    expandError?: Error;
  } = {},
) {
  const calls: Harness['calls'] = [];
  const root = mkdtempSync(join(tmpdir(), 'motir-scope-'));
  mkdirSync(join(root, 'motir-core'));
  const ready = opts.ready ?? [readyRow('PROD-2')];

  const client = {
    whoami: async () => {
      calls.push({ tool: 'whoami', args: undefined });
      return { user: { id: OWNER, name: 'Me', email: 'me@motir.test' }, workspace: null };
    },
    getWorkItem: async (key: string) => {
      const readIndex = calls.filter((c) => c.tool === 'get_work_item').length;
      calls.push({ tool: 'get_work_item', args: key });
      const scripted = opts.detail ?? detail({}, ['PROD-2']);
      return typeof scripted === 'function' ? scripted(readIndex, key) : scripted;
    },
    listReadyForDispatch: async (args: unknown) => {
      calls.push({ tool: 'list_ready', args });
      return ready;
    },
    claimScope: async (args: unknown) => {
      calls.push({ tool: 'claim_scope', args });
      return opts.claim ?? scopeClaim();
    },
    // ⚠️ THE PER-CARD CALL IS A RE-ASSERT, NOT AN ACQUISITION. The scoped drain
    // runs each card through the SAME `dispatchOne` pipeline `motir auto` uses,
    // and that pipeline claims before it spawns. On a scoped run the card is
    // already this run's, so the server answers `mine` — which is what makes
    // reuse correct rather than a second claim. The property that matters is
    // that ACQUISITION happened once, over the whole set, before any of this:
    // `claim_scope` is asserted at exactly one call.
    claimWorkItem: async (args: { key: string }) => {
      calls.push({ tool: 'claim', args });
      const { claim } = resolveFakeClaim(
        { key: args.key, title: `Item ${args.key}`, status: 'in_progress', assigneeId: OWNER },
        { id: OWNER, name: 'Me' },
      );
      return claim;
    },
    searchWorkItems: async (args: unknown) => {
      calls.push({ tool: 'search_work_items', args });
      return {
        items: ready.map((r) => ({
          identifier: r.key,
          kind: r.kind,
          title: r.title,
          status: 'todo',
          dependencies: { blockedBy: [], blocks: [] },
        })),
        nextCursor: null,
      };
    },
    dispatchPrompt: async (key: string): Promise<DispatchPrompt> => {
      calls.push({ tool: 'dispatch_prompt', args: key });
      // ⚠️ The CONTAINER's key reaching here is the failure a whole test below
      // is about, so it throws rather than answering — a regression fails by
      // exception, which is louder than an assertion.
      if (key === 'PROD-1') throw new Error('a story is a scope, not work');
      return {
        key,
        prompt: `PROMPT ${key}`,
        parentKey: 'PROD-1',
        targetRepo: 'motir-core',
        workflowMode: 'session_lineage',
        sessionBranch: 'motir/auto-x',
      };
    },
    markIntegrated: async (args: unknown) => {
      calls.push({ tool: 'mark_integrated', args });
      return {};
    },
    // MOTIR-10985 — the story's link, from the first landed card.
    linkPullRequest: async (args: unknown) => {
      calls.push({ tool: 'link_pull_request', args });
      return {};
    },
    submitPlanSession: async (args: unknown) => {
      calls.push({ tool: 'submit_plan', args });
      if (opts.planError) throw opts.planError;
      return { jobId: 'job_1', planId: 'plan_1' };
    },
    expandItem: async (key: string) => {
      calls.push({ tool: 'expand_item', args: key });
      if (opts.expandError) throw opts.expandError;
      return { jobId: 'job_2', planId: 'plan_2' };
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

  harness = { calls, stderr: '', root, ready };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    harness.stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return harness;
}

const toolNames = () => harness.calls.map((c) => c.tool);
const callsTo = (tool: string) => harness.calls.filter((c) => c.tool === tool);

/**
 * The options + deps a SCOPED run needs to get past the agent gate.
 *
 * A scope has no single prompt to paste, so `--print` is refused and an agent is
 * REQUIRED — unlike the leaf path, whose default is to print. Every scoped test
 * below therefore names one, and the spawn and git are scripted so nothing here
 * touches a real remote.
 */
const SCOPE_OPTS = { agent: 'fake-agent' } as const;
const okResult = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
/** git answers "the branch is on origin and carries a commit". */
const GIT: CommandRunner = (_bin, args) => {
  if (args[0] === 'ls-remote') return okResult('abc123\trefs/heads/motir/auto-x');
  if (args[0] === 'log' || args[0] === 'rev-list') return okResult('abc123');
  return okResult('');
};
const SCOPE_DEPS = {
  run: GIT,
  clock: () => 0,
  now: () => new Date(0),
};

/**
 * A git/gh runner that RECORDS what it was asked to do — the only way to assert
 * an ABSENCE of `gh pr create`, which is what Bug MOTIR-3268 is about.
 *
 * ⚠️ It answers `rev-list --count` with a NUMBER, which the shared `GIT` above
 * does not. `sessionBranchHasCommits` parses that count, so a runner that
 * answers a sha reports every branch as EMPTY and the close-out returns before
 * `gh` is ever reached — a fixture in which the assertion "no pull request was
 * opened" would pass for the wrong reason.
 */
/**
 * ⚠️ STATEFUL ABOUT `gh pr create` (MOTIR-4999). The drain now opens each
 * repository's pull request at its first landed card, so `pr list` is asked
 * TWICE per run — once by the eager open and once by the close-out. A fake that
 * answered the second the way it answered the first would let the close-out
 * create a SECOND pull request off the same branch, which no live repository can
 * do: `gh pr list --head <branch> --state open` returns the one that exists.
 * Registering the create is what lets `openSessionPr`'s list-before-create
 * no-op be observed here rather than mistaken for a duplicate-PR defect.
 */
function recordingGit(): { run: CommandRunner; commands: string[] } {
  const commands: string[] = [];
  /** `checkout → its open pull request`, grown by every `pr create`. */
  const open = new Map<string, string>();
  const run: CommandRunner = (bin, args, cwd) => {
    commands.push([bin, ...args.slice(0, 2)].join(' '));
    if (bin === 'git' && args[0] === 'rev-list' && args[1] === '--count') return okResult('1');
    if (bin === 'gh' && args[1] === 'create') {
      const url = 'https://github.com/moooon/motir-core/pull/1';
      open.set(cwd, url);
      return okResult(url);
    }
    // Draft state is a separate question and nothing here changes it: the
    // close-out's `gh pr ready` is what these tests are watching for.
    if (bin === 'gh' && args[1] === 'list' && !args.includes('isDraft')) {
      return okResult(open.get(cwd) ?? '');
    }
    return GIT(bin, args, '');
  };
  return { run, commands };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-scope-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  if (harness?.root) rmSync(harness.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir run <container> — the happy path', () => {
  it('resolves through the ANCESTOR facet, claims the whole set in ONE call, and prints it', async () => {
    setup();

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(toolNames().slice(0, 5)).toEqual([
      'get_work_item', // the shape read `runCommand` already made
      'whoami',
      'list_ready',
      'claim_scope',
      'get_work_item', // the EDGES, read once, before the first agent
    ]);
    // ⚠️ AND NO READY READ AFTER THE CLAIM. The order comes from edges the run
    // already holds; a mid-drain ready query would silently reintroduce the
    // interleaving the up-front claim exists to prevent.
    const afterClaim = toolNames().slice(toolNames().indexOf('claim_scope'));
    expect(afterClaim).not.toContain('list_ready');
    // The scope is resolved through the facet its sibling published — not by
    // reading the children and filtering client-side, which would re-derive the
    // parent-ready cascade in the wrong place.
    expect(callsTo('list_ready')[0]?.args).toMatchObject({
      projectKey: 'PROD',
      ownerId: OWNER,
      ancestor: ['PROD-1'],
    });
    // ⚠️ ONE claim for the whole set. A card-by-card claim is what the up-front
    // claim exists to prevent, and `claimWorkItem` throws in this harness so a
    // regression to it fails loudly rather than passing quietly.
    expect(callsTo('claim_scope')).toHaveLength(1);
    expect(callsTo('claim_scope')[0]?.args).toEqual({ kind: 'work_item', key: 'PROD-1' });
    expect(harness.stderr).toContain('Claimed PROD-1 "The story"');
    expect(harness.stderr).toContain('Every work item above now reads In Progress');
  });

  it('NEVER sends the container’s own key to dispatchPrompt', async () => {
    // A story is a scope, not work. The harness throws from `dispatchPrompt`,
    // so any path that reached it would fail this test by exception rather than
    // by assertion — which is the stronger form.
    setup();

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    const dispatched = callsTo('dispatch_prompt').map((c) => c.args);
    expect(dispatched).not.toContain('PROD-1');
    expect(dispatched).toContain('PROD-2');
  });

  it('`sprint` claims the ACTIVE sprint, with no work-item read at all', async () => {
    setup({ ready: [readyRow('PROD-2'), readyRow('PROD-3')] });

    await runCommand('sprint', SCOPE_OPTS, SCOPE_DEPS);

    // No `get_work_item`: the reserved word is not a key, so there is nothing
    // to resolve before asking for the sprint's ready set. And the EDGES come
    // from the work-item collection filtered to the sprint, because a sprint
    // spans several parents at mixed depths and has no one container to read.
    expect(toolNames().slice(0, 4)).toEqual([
      'whoami',
      'list_ready',
      'claim_scope',
      'search_work_items',
    ]);
    expect(callsTo('list_ready')[0]?.args).toMatchObject({ sprintId: 'active' });
    expect(callsTo('claim_scope')[0]?.args).toEqual({ kind: 'sprint', projectKey: 'PROD' });
  });

  it('a `mine` claim RESUMES rather than refusing', async () => {
    setup({ claim: scopeClaim({ outcome: 'mine', claimed: false }) });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('Claimed PROD-1');
    expect(harness.stderr).not.toContain('NOT claimed');
  });
});

describe('motir run <container> — the refusals', () => {
  it('a scope held by a SECOND run is refused BY NAME, and nothing was locked', async () => {
    setup({
      claim: scopeClaim({
        outcome: 'taken',
        claimed: false,
        members: [],
        offender: {
          key: 'PROD-2',
          title: 'Item PROD-2',
          status: { key: 'in_progress', category: 'in_progress' },
          assignee: { id: 'u2', name: 'Rival Runner' },
          transitionedBy: null,
          transitionedAt: null,
        },
      }),
    });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('already held by Rival Runner');
    expect(harness.stderr).toContain('PROD-2');
    expect(toolNames()).not.toContain('submit_plan');
    // A refusal is an ordinary state, not a failure.
    expect(process.exitCode).toBeUndefined();
  });

  it('`not_finishable` stops and does NOT submit a re-plan', async () => {
    // Out-of-scope work gating in-scope work is a fact about the rest of the
    // tree; re-planning the container would be re-planning the wrong thing.
    setup({
      claim: scopeClaim({
        outcome: 'not_finishable',
        claimed: false,
        members: [],
        blockers: [
          { item: 'PROD-2', blockedBy: 'PROD-99', blockerStatus: 'todo', blockerSprintId: null },
        ],
      }),
    });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('PROD-2 is blocked by PROD-99');
    expect(toolNames()).not.toContain('submit_plan');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('motir run <container> — a WRONG SHAPE submits a re-plan, once', () => {
  const wrongShape = () =>
    scopeClaim({
      outcome: 'wrong_shape',
      claimed: false,
      members: [],
      shape: { child: 'PROD-5', childTitle: 'A task of its own', depth: 2 },
    });

  it('prints the offending child and submits a DETACHED re-plan of the story', async () => {
    setup({ claim: wrongShape() });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('PROD-5 — A task of its own is itself a container');
    expect(callsTo('submit_plan')).toHaveLength(1);
    expect(callsTo('submit_plan')[0]?.args).toEqual({ projectKey: 'PROD', targetKeys: ['PROD-1'] });
    // The review URL, so the plan is one click away rather than an id to paste.
    expect(harness.stderr).toContain(`${SERVER}/plans/plan_1`);
    expect(process.exitCode).toBeUndefined();
  });

  it('--disable-replan suppresses the WRITE, not the diagnosis', async () => {
    // The operator asked not to have a plan submitted on their behalf, not to
    // be kept in the dark — the same meaning MOTIR-3017 gave the flag on the
    // per-card path.
    setup({ claim: wrongShape() });

    await runCommand('PROD-1', { ...SCOPE_OPTS, disableReplan: true }, SCOPE_DEPS);

    expect(harness.stderr).toContain('PROD-5 — A task of its own is itself a container');
    expect(toolNames()).not.toContain('submit_plan');
    expect(harness.stderr).toContain('No re-plan was submitted (--disable-replan)');
  });

  it('a failed submit reports and does not become the run’s problem', async () => {
    setup({ claim: wrongShape(), planError: new CliError('the planner is unavailable') });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('the planner is unavailable');
    // The shape finding is the valuable thing here, and it still stands.
    expect(harness.stderr).toContain('is itself a container');
    expect(process.exitCode).toBeUndefined();
  });

  it('a NON-Error throw is still reported, never as `[object Object]`', async () => {
    // A transport can reject with anything. The reader needs a sentence either
    // way, and the shape finding still stands.
    setup({ claim: wrongShape(), planError: 'the socket closed' as unknown as Error });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('the socket closed');
    expect(harness.stderr).not.toContain('[object Object]');
  });
});

describe('motir run <container> — the shapes that are not scopes', () => {
  it('an EPIC is refused by kind, before anything is read or claimed', async () => {
    setup({ detail: detail({ kind: 'epic', identifier: 'PROD-9' }, ['PROD-2']) });

    await expect(runCommand('PROD-9', SCOPE_OPTS, SCOPE_DEPS)).rejects.toThrow(
      /never a run target/,
    );
    expect(toolNames()).toEqual(['get_work_item']);
  });

  it('a CHILDLESS story is refused as a planning item', async () => {
    setup({ detail: detail({ kind: 'story', identifier: 'PROD-3' }, []) });

    await expect(runCommand('PROD-3', SCOPE_OPTS, SCOPE_DEPS)).rejects.toThrow(
      /planning item, not work/,
    );
    expect(toolNames()).not.toContain('claim_scope');
  });

  it('--include-planning turns that refusal into ONE expansion, and never waits', async () => {
    setup({ detail: detail({ kind: 'story', identifier: 'PROD-3' }, []) });

    await runCommand('PROD-3', { ...SCOPE_OPTS, includePlanning: true }, SCOPE_DEPS);

    expect(callsTo('expand_item')).toHaveLength(1);
    expect(callsTo('expand_item')[0]?.args).toBe('PROD-3');
    expect(harness.stderr).toContain('an expansion was triggered');
    expect(harness.stderr).toContain('the plan needs your approval');
    expect(toolNames()).not.toContain('claim_scope');
  });

  it('an expansion that could not be submitted is reported, and the run still stops', async () => {
    setup({
      detail: detail({ kind: 'story', identifier: 'PROD-3' }, []),
      expandError: 'the planner is unavailable' as unknown as Error,
    });

    await runCommand('PROD-3', { ...SCOPE_OPTS, includePlanning: true }, SCOPE_DEPS);

    expect(harness.stderr).toContain('the expansion could not be submitted');
    expect(harness.stderr).toContain('the planner is unavailable');
    expect(toolNames()).not.toContain('claim_scope');
  });

  it('an EMPTY scope reports a plan state, claims nothing, and exits 0', async () => {
    setup({ ready: [] });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(harness.stderr).toContain('nothing is ready to start');
    expect(harness.stderr).toContain('Nothing was claimed and nothing was changed.');
    // ⚠️ Distinguishable from a refusal, and nothing was locked: the claim is
    // never even attempted.
    expect(toolNames()).not.toContain('claim_scope');
    expect(harness.stderr).not.toContain('NOT claimed');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('motir run <scope> — the leaf-only flags', () => {
  it.each([
    ['--print', { print: true }, /`--print` needs one prompt/],
    ['--force', { force: true }, /`--force` applies to a single work item/],
    ['--kinds', { kinds: 'subtask' }, /`--kinds` filters a ready-set PICK/],
  ])('refuses %s with a REASON rather than `unknown option`', async (_flag, opts, expected) => {
    setup();

    await expect(runCommand('PROD-1', { ...SCOPE_OPTS, ...opts }, SCOPE_DEPS)).rejects.toThrow(
      expected,
    );
  });

  it('leaves the LEAF path untouched — those flags still work on one card', async () => {
    // The ADR's central promise: for a leaf key, which is what every dispatched
    // card is, nothing about this command changed.
    setup({ detail: detail({ kind: 'subtask', identifier: 'PROD-2' }, []) });

    // `--print` on a LEAF is the default behaviour, not a refusal: it reaches
    // the single-card path, claims that one card and prints its prompt.
    await runCommand('PROD-2', { print: true });

    expect(toolNames()).toContain('claim');
    expect(toolNames()).not.toContain('claim_scope');
    expect(callsTo('dispatch_prompt').map((c) => c.args)).toEqual(['PROD-2']);
  });
});

describe('motir run <container> --allow-soft-block (MOTIR-6355)', () => {
  /** The story is held only by its EPIC's block — a SOFT block. */
  const softStory = (): WorkItemDetail => ({
    ...detail({}, ['PROD-2']),
    readiness: {
      ready: false,
      openBlockers: [],
      blockedByAncestor: { identifier: 'PROD-0', title: 'The epic' },
    },
  });
  /** The story has its OWN open blocker — a HARD block. */
  const hardStory = (): WorkItemDetail => ({
    ...detail({}, ['PROD-2']),
    readiness: {
      ready: false,
      openBlockers: [{ identifier: 'PROD-8', kind: 'story', title: 'Other story', status: 'todo' }],
      blockedByAncestor: null,
    },
  });

  it('widens the ready read with allowSoftBlock when only the epic is blocked', async () => {
    setup({ detail: softStory() });

    await runCommand('PROD-1', { ...SCOPE_OPTS, allowSoftBlock: true }, SCOPE_DEPS);

    // The target verdict is the one `resolveScopeTarget` already read — no
    // second read of the story before the ready walk.
    expect(toolNames().slice(0, 4)).toEqual([
      'get_work_item',
      'whoami',
      'list_ready',
      'claim_scope',
    ]);
    expect(callsTo('list_ready')[0]?.args).toEqual({
      projectKey: 'PROD',
      ownerId: OWNER,
      ancestor: ['PROD-1'],
      allowSoftBlock: true,
    });
    expect(callsTo('claim_scope')).toHaveLength(1);
  });

  it('refuses a story with its OWN open blocker before anything is read or claimed', async () => {
    setup({ detail: hardStory() });

    const err = await runCommand(
      'PROD-1',
      { ...SCOPE_OPTS, allowSoftBlock: true },
      SCOPE_DEPS,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('PROD-1 has its own open blocker');
    expect((err as CliError).message).toContain('PROD-8 (Other story)');
    expect(toolNames()).not.toContain('list_ready');
    expect(toolNames()).not.toContain('claim_scope');
  });

  it('without the flag the ready read is unchanged — no allowSoftBlock is sent', async () => {
    setup({ detail: hardStory() });

    await runCommand('PROD-1', SCOPE_OPTS, SCOPE_DEPS);

    expect(callsTo('list_ready')[0]?.args).toEqual({
      projectKey: 'PROD',
      ownerId: OWNER,
      ancestor: ['PROD-1'],
    });
  });

  it('a SPRINT scope has no target verdict to check, and widens its read', async () => {
    setup();

    await runCommand('sprint', { ...SCOPE_OPTS, allowSoftBlock: true }, SCOPE_DEPS);

    expect(callsTo('list_ready')[0]?.args).toEqual({
      projectKey: 'PROD',
      ownerId: OWNER,
      sprintId: 'active',
      allowSoftBlock: true,
    });
  });

  it('refuses it combined with --force as redundant', async () => {
    setup({ detail: softStory() });

    await expect(
      runCommand('PROD-1', { ...SCOPE_OPTS, allowSoftBlock: true, force: true }, SCOPE_DEPS),
    ).rejects.toThrow(/redundant with `--force`/);
    expect(toolNames()).toEqual([]);
  });
});

describe('motir run <container> — the close-out RE-READS the child set (MOTIR-3268 → MOTIR-4967)', () => {
  // ⚠️ THE CLAIM IS TAKEN AT t=0 AND THE CHILD SET MOVES UNDER IT.
  // `motir run` may file a bug mid-drain (MOTIR-3017) and it parents that bug
  // under the in-flight card's parent — the very container this run is about to
  // open a pull request for. These tests pin the read that catches it.
  //
  // ⚠️ WHAT THE READ DECIDES CHANGED, AND THE READ DID NOT (MOTIR-4967). It used
  // to gate whether a pull request was opened AT ALL, because one opened over an
  // unfinished container claims the container is built. The pull request is now
  // a DRAFT either way, and a draft cannot be merged — so it can neither complete
  // the container nor cascade `done` onto the children that are missing, while
  // the finished work still gets CI, which the hold denied it. The read now
  // decides whether the close-out marks that draft READY.

  /**
   * A container that acquires two children WHILE the drain is running.
   *
   * Counted per CONTAINER read rather than per read, because the drain also
   * reads each dispatched CARD (its replan check) and pinning an absolute index
   * would make this fixture break on any unrelated read the loop grows. The
   * container is read three times before the close-out: the shape read, the
   * dependency edges, and then the re-read this card adds.
   */
  function growsMidDrain(): (readIndex: number, key: string) => WorkItemDetail {
    let containerReads = 0;
    return (_readIndex, key) => {
      if (key !== 'PROD-1') return detail({ identifier: key, kind: 'subtask' }, []);
      containerReads += 1;
      return containerReads >= 3
        ? detail({}, ['PROD-2@implemented', 'PROD-9', 'PROD-10'])
        : detail({}, ['PROD-2']);
    };
  }

  const containerReads = () => callsTo('get_work_item').filter((c) => c.args === 'PROD-1');

  it('a child filed DURING the drain leaves the pull request a DRAFT — it is opened, never readied', async () => {
    setup({ detail: growsMidDrain() });
    const git = recordingGit();

    await runCommand('PROD-1', SCOPE_OPTS, { ...SCOPE_DEPS, run: git.run });

    // The shape read, the edges, and the CLOSE-OUT re-read this card adds.
    expect(containerReads()).toHaveLength(3);
    // ⚠️ THE PULL REQUEST IS OPENED, which is the inversion MOTIR-4967 makes:
    // the hold's assertion here was an ABSENCE. What carries the invariant now
    // is `--draft` plus the missing `gh pr ready` — a draft cannot be merged, so
    // it cannot claim the container is built.
    expect(git.commands).toContain('gh pr create');
    expect(git.commands).not.toContain('gh pr ready');
    // The work is not stranded — the branch was pushed, as it was under the hold.
    expect(git.commands).toContain('git push origin');
  });

  it('names the outstanding children, and prescribes NOTHING', async () => {
    setup({ detail: growsMidDrain() });
    const git = recordingGit();

    await runCommand('PROD-1', SCOPE_OPTS, { ...SCOPE_DEPS, run: git.run });

    expect(harness.stderr).toContain('PROD-1 is NOT finished');
    expect(harness.stderr).toContain('PROD-9 — not implemented');
    expect(harness.stderr).toContain('PROD-10 — not implemented');
    // The implemented child is NOT named: the report is about what is open.
    expect(harness.stderr).not.toContain('PROD-2 — not implemented');
    // ⚠️ NO DISPOSITIONS. The hold offered three because the run had withheld
    // the pull request on the operator's behalf and they had to undo it to
    // proceed. Nothing has been withheld: the work is pushed, the pull request
    // exists, CI is running on it, and re-running the container finishes it.
    expect(harness.stderr).not.toContain('LAND them');
    expect(harness.stderr).not.toContain('move PROD-1 to Done');
    expect(harness.stderr).toContain('motir run PROD-1');
    // And it is not reported as a failure or as a hold, either of which would
    // send the reader looking for something that went wrong.
    expect(harness.stderr).not.toContain('HELD');
    expect(harness.stderr).not.toContain('NOT opened.');
    expect(harness.stderr).toContain('still a DRAFT');
  });

  it('the RUN ID and the CLOCK have real defaults — the arms no injected dep ever reaches', async () => {
    // ⚠️ THE PRODUCTION ARM OF AN INJECTED SEAM. Every test above hands
    // `runCommand` a `now` and a `clock`, so `deps.now ?? (() => new Date())`
    // and `deps.clock ?? Date.now` — the values a real `motir run <scope>`
    // actually uses — are the two arms nothing exercises. A seam whose default
    // is never run is a default that can be wrong for a whole release.
    //
    // `run` is still injected: the point is the DEFAULTS of the two pure
    // dependencies, not shelling out to real `git` from a unit test.
    setup({ detail: (_i, key) => detail({}, key === 'PROD-1' ? ['PROD-2@implemented'] : []) });
    const git = recordingGit();

    await runCommand('PROD-1', SCOPE_OPTS, { run: git.run });

    // The session branch is derived from the run id, which is derived from the
    // default clock — so a real timestamp is the observable consequence.
    const created = git.commands.filter((c) => c === 'gh pr create');
    expect(created).toHaveLength(1);
    expect(harness.stderr).toMatch(/motir\/auto-\d{8}-\d{6}/);
    expect(process.exitCode).toBe(0);
  });

  it('opens the story’s DRAFT titled for the story and links the STORY from its first card (MOTIR-10985)', async () => {
    setup({ detail: (_i, key) => detail({}, key === 'PROD-1' ? ['PROD-2@implemented'] : []) });
    const git = recordingGit();
    const creates: string[][] = [];
    const run: CommandRunner = (bin, args, cwd) => {
      if (bin === 'gh' && args[1] === 'create') creates.push(args);
      return git.run(bin, args, cwd);
    };

    await runCommand('PROD-1', SCOPE_OPTS, { ...SCOPE_DEPS, run });

    // ONE create, a draft, titled for the story the scope was launched against —
    // although only one card landed, which the carried set alone reads as `one-card`.
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain('--draft');
    expect(creates[0]![creates[0]!.indexOf('--title') + 1]).toBe('PROD-1 The story');
    const links = callsTo('link_pull_request').map((c) => (c.args as { key: string }).key);
    expect(links.length).toBeGreaterThan(0);
    // The story, and the one landed card its agent could not link (no PR existed yet).
    expect(new Set(links)).toEqual(new Set(['PROD-1', 'PROD-2']));
  });

  it('the CONTROL still holds: every child implemented opens ONE pull request and MARKS IT READY', async () => {
    setup({ detail: (_i, key) => detail({}, key === 'PROD-1' ? ['PROD-2@implemented'] : []) });
    const git = recordingGit();

    await runCommand('PROD-1', SCOPE_OPTS, { ...SCOPE_DEPS, run: git.run });

    expect(git.commands.filter((c) => c === 'gh pr create')).toHaveLength(1);
    expect(git.commands).toContain('gh pr ready');
    expect(harness.stderr).not.toContain('HELD');
    expect(harness.stderr).not.toContain('still a DRAFT');
    expect(process.exitCode).toBe(0);
  });

  it('`done` / `cancelled` / `in_review` children all clear the bar', async () => {
    // The bar is `implemented`-or-better, restated by KEY on this side because
    // the child rows v1 publishes carry no category (`CHILD_CLAIM_BAR_KEYS`).
    setup({
      detail: (_i, key) =>
        detail({}, key === 'PROD-1' ? ['PROD-2@done', 'PROD-3@cancelled', 'PROD-4@in_review'] : []),
    });
    const git = recordingGit();

    await runCommand('PROD-1', SCOPE_OPTS, { ...SCOPE_DEPS, run: git.run });

    expect(git.commands).toContain('gh pr create');
  });

  it('a SPRINT scope has no container to re-read, and opens its pull request', async () => {
    // A sprint spans several parents at mixed depths; its pull request claims
    // nothing about any one of them, so there is nothing for this gate to read.
    setup({ ready: [readyRow('PROD-2')] });
    const git = recordingGit();

    await runCommand('sprint', SCOPE_OPTS, { ...SCOPE_DEPS, run: git.run });

    // The ONE read is the drain's own replan check on the dispatched card — the
    // close-out added none.
    expect(callsTo('get_work_item').map((c) => c.args)).toEqual(['PROD-2']);
    expect(git.commands).toContain('gh pr create');
  });
});
