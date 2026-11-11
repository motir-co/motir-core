import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainScope,
  readGateReleased,
  readHeldGates,
  readScopeEdges,
  type ScopeDrainInput,
} from '../src/commands/scopeDrain.js';
import { closeOutContainer, closeOutRepos } from '../src/commands/auto.js';
import { orderClaimedSet, unsatisfiedBlockers, type ScopeEdges } from '../src/scopedRun.js';
import { autoExitCode, renderAutoSummary, type AutoSummary } from '../src/autoLoop.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type {
  DispatchItem,
  DispatchPrompt,
  DispatchRunEventInput,
  MotirClient,
} from '../src/client.js';
import type { ProjectSession } from '../src/session.js';
import { nullDispatchRunReporter } from '../src/dispatchRunReporter.js';

// The DRAIN of a claimed scope (Story MOTIR-3001 · MOTIR-3199), driven
// end-to-end against a scripted client + agent — the fixture shape
// `autoCommand.test.ts` already uses, and the only way the defining property of
// this loop can actually be asserted.
//
// ⚠️ THAT PROPERTY IS AN ABSENCE: the run must NEVER query a ready set after the
// claim. It orders a set it already owns from dependency edges, so a mid-drain
// ready read would silently reintroduce exactly the interleaving the up-front
// claim exists to prevent. The fake below THROWS from every ready read, so a
// regression fails by exception rather than by a forgotten assertion.

// ── the pure half, against plain objects ───────────────────────────────────

describe('orderClaimedSet', () => {
  it('orders by dependency, breaking ties by INPUT order (the server’s rank)', () => {
    const edges: ScopeEdges = { C: ['A'], D: ['C'], B: [] };
    expect(orderClaimedSet(['D', 'C', 'B', 'A'], edges)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('ignores an edge pointing OUTSIDE the scope', () => {
    // Out-of-scope blockers were settled by the claim: `not_finishable` is
    // precisely the verdict that outside work gates inside work, and a scope
    // that got past it has none. Treating one as unsatisfiable here would
    // deadlock a set the server already cleared.
    const edges: ScopeEdges = { A: ['SOMEWHERE-ELSE'] };
    expect(orderClaimedSet(['A'], edges)).toEqual(['A']);
  });

  it('is TOTAL: a cycle keeps every card, in input order', () => {
    // ⚠️ A run that silently DROPPED a card it had claimed would leave it In
    // Progress forever with nobody working it — strictly worse than working it
    // in a debatable order. The caller still refuses to dispatch a card whose
    // blockers are unsatisfied, so the cycle is reported rather than built.
    const edges: ScopeEdges = { A: ['B'], B: ['A'] };
    expect(orderClaimedSet(['A', 'B'], edges)).toEqual(['A', 'B']);
  });
});

describe('unsatisfiedBlockers', () => {
  it('names only the IN-SCOPE blockers that have not landed', () => {
    const edges: ScopeEdges = { C: ['A', 'B', 'OUTSIDE-1'] };
    const inScope = new Set(['A', 'B', 'C']);
    expect(unsatisfiedBlockers('C', edges, new Set(['A']), inScope)).toEqual(['B']);
    expect(unsatisfiedBlockers('C', edges, new Set(['A', 'B']), inScope)).toEqual([]);
  });
});

// ── the driven loop ────────────────────────────────────────────────────────

const OWNER = 'user_me';
const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const GIT: CommandRunner = (_bin, args) => {
  if (args[0] === 'ls-remote') return ok('abc123\trefs/heads/motir/auto-x');
  if (args[0] === 'log' || args[0] === 'rev-list') return ok('abc123');
  return ok('');
};

function member(key: string, over: Partial<DispatchItem> = {}): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    priority: 'medium',
    status: { key: 'in_progress', category: 'in_progress' },
    assigneeId: OWNER,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
    ...over,
  };
}

interface Fake {
  calls: string[];
  dispatched: string[];
  /** Whether each prompt read carried a session-branch seed, in order. */
  promptSeeds: boolean[];
  /** Every CONTAINER link the drain declared, `<KEY>@<url>` (MOTIR-4969). */
  links: string[];
  /** Every status move the drain asked for, `<KEY>:<status>` (MOTIR-4969). */
  transitions: string[];
  /**
   * Every read that can be a GATE read, in order — `get:<KEY>` and
   * `designs:<dependent KEY>` — with a `dispatch:<KEY>` marker at each prompt read,
   * so a test can tell the pipeline's own reads from the drain's (MOTIR-6117).
   */
  reads: string[];
  stderr: string;
  root: string;
}

/** Keys whose card reads back as `planning` — the agent refused it (MOTIR-3018). */
let replanned: Set<string>;
/** A status a test pins for one key; every other key reads as `in_review`. */
let statusOf: Map<string, string>;
/** Keys whose per-card claim re-assert is REFUSED (defensive; see the test). */
let claimRefuses: Set<string>;
/** A `type` a test pins for one key's `get_work_item` read; every other key reads `code`. */
let typeOf: Map<string, string>;
/** The design VERDICT per design-card key; every other design reads `not_approved` (MOTIR-6117). */
let verdictOf: Map<string, string>;
/**
 * A person approving a gate WHILE the drain runs (MOTIR-6117): dispatching the
 * key approves the gate it maps to — a decision's status turns `approved`, a
 * design's verdict turns `approved`.
 */
let approveOnDispatch: Map<string, string>;
/** Per-key repository SET, for the multi-repository card (MOTIR-3135). */
let repoSets: Record<string, NonNullable<DispatchPrompt['targetRepos']>>;
/** Per-key primary repository, so a card can be routed at a missing checkout. */
let repoOf: Record<string, string>;

let fake: Fake;
let home: string;

function client(): MotirClient {
  const c = {
    // ⚠️ EVERY ready read throws. See the header: the absence is the property.
    nextReady: (): never => {
      throw new Error('a scoped drain must never query a ready set after the claim');
    },
    listReadyForDispatch: (): never => {
      throw new Error('a scoped drain must never query a ready set after the claim');
    },
    claimWorkItem: async (args: { key: string }) => {
      fake.calls.push(`claim:${args.key}`);
      const { claim } = resolveFakeClaim(
        {
          key: args.key,
          title: `Item ${args.key}`,
          status: claimRefuses.has(args.key) ? 'in_review' : 'in_progress',
          assigneeId: claimRefuses.has(args.key) ? null : OWNER,
        },
        { id: OWNER, name: 'Me' },
      );
      return claim;
    },
    dispatchPrompt: async (
      key: string,
      opts: { sessionBranch?: string | null } = {},
    ): Promise<DispatchPrompt> => {
      fake.dispatched.push(key);
      fake.reads.push(`dispatch:${key}`);
      const approves = approveOnDispatch.get(key);
      if (approves) {
        statusOf.set(approves, 'approved');
        verdictOf.set(approves, 'approved');
      }
      fake.promptSeeds.push(opts.sessionBranch !== undefined);
      const set = repoSets[key];
      return {
        key,
        prompt: `PROMPT ${key}`,
        parentKey: 'PROD-1',
        targetRepo: repoOf[key] ?? 'motir-core',
        ...(set ? { targetRepos: set } : {}),
        workflowMode: opts.sessionBranch ? 'session_lineage' : 'per_item_pr',
        sessionBranch: opts.sessionBranch ?? null,
      };
    },
    markIntegrated: async (args: { key: string }) => {
      fake.calls.push(`integrated:${args.key}`);
      return {};
    },
    reportImplementation: async () => ({}),
    // MOTIR-4969 — the CONTAINER link the drain now declares when its carried
    // set shares a parent. Recorded rather than counted in `calls`, so the
    // drain's existing call-order assertions are untouched.
    linkPullRequest: async (args: { key: string; url?: string }) => {
      fake.links.push(`${args.key}@${args.url ?? '?'}`);
      return undefined;
    },
    transitionStatus: async (args: { key: string; status: string }) => {
      fake.transitions.push(`${args.key}:${args.status}`);
      return {};
    },
    getWorkItem: async (key: string) => {
      fake.reads.push(`get:${key}`);
      return {
        item: {
          identifier: key,
          status: replanned.has(key) ? 'planning' : (statusOf.get(key) ?? 'in_review'),
          type: typeOf.get(key) ?? 'code',
          executor: 'coding_agent',
        },
      };
    },
    // One verdict per design this fake knows of — the server answers for every
    // blocker of the dependent named, and the drain picks its gate out by key.
    listWorkItemDesigns: async (dependent: string) => {
      fake.reads.push(`designs:${dependent}`);
      return {
        designs: [...verdictOf].map(([designCardKey, verdict]) => ({ designCardKey, verdict })),
      };
    },
  };
  return c as unknown as MotirClient;
}

function session(): ProjectSession {
  return {
    link: {
      dir: fake.root,
      path: join(fake.root, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    client: client(),
  };
}

async function drive(
  members: DispatchItem[],
  edges: ScopeEdges,
  over: {
    opts?: ScopeDrainInput['opts'];
    max?: number | null;
    agentResults?: (key: string) => Omit<AgentRunResult, 'model'> & { model?: string | null };
    run?: CommandRunner;
    /** Wrap the scripted client, to fail one read on purpose. */
    client?: (c: MotirClient) => MotirClient;
    /** Collects the run's events, for the assertions on what the record says. */
    events?: DispatchRunEventInput[];
    /** The work item the scope was launched against (MOTIR-10985). */
    container?: ScopeDrainInput['container'];
  } = {},
): Promise<AutoSummary> {
  const s = session();
  return drainScope({
    session: over.client ? { ...s, client: over.client(s.client) } : s,
    opts: over.opts ?? {},
    members,
    edges,
    max: over.max ?? null,
    agent: { parsed: parseAgentCommand('fake-agent')!, source: 'flag' },
    runId: 'x',
    ...(over.events
      ? {
          reporter: {
            ...nullDispatchRunReporter,
            event: (e: DispatchRunEventInput) => void over.events!.push(e),
          },
        }
      : {}),
    branch: 'motir/auto-x',
    run: over.run ?? GIT,
    ...(over.container ? { container: over.container } : {}),
    clock: () => 0,
    runAgentFn: async ({ prompt }) => {
      const key = prompt.replace('PROMPT ', '');
      const result = over.agentResults?.(key) ?? { exitCode: 0, signal: null };
      return { model: null, ...result };
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-drain-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  const root = mkdtempSync(join(tmpdir(), 'motir-drain-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  fake = {
    calls: [],
    dispatched: [],
    promptSeeds: [],
    links: [],
    transitions: [],
    reads: [],
    stderr: '',
    root,
  };
  replanned = new Set();
  statusOf = new Map();
  claimRefuses = new Set();
  typeOf = new Map();
  verdictOf = new Map();
  approveOnDispatch = new Map();
  repoSets = {};
  repoOf = {};
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    fake.stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  rmSync(fake.root, { recursive: true, force: true });
});

describe('drainScope', () => {
  it('works the set in blocked_by order and NEVER re-queries a ready set', async () => {
    // The members arrive in the server's rank, which is the WRONG build order —
    // so a loop that simply iterated the input would dispatch PROD-4 first and
    // the fake's ready reads would never be needed to prove anything. The
    // reorder is what this asserts; the absence of a ready read is what the
    // throwing fake asserts.
    const summary = await drive([member('PROD-4'), member('PROD-3'), member('PROD-2')], {
      'PROD-3': ['PROD-2'],
      'PROD-4': ['PROD-3'],
    });

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-3', 'PROD-4']);
    expect(summary.stopReason).toBe('drained');
    expect(summary.records.map((r) => r.outcome)).toEqual([
      'integrated',
      'integrated',
      'integrated',
    ]);
  });

  it('SKIPS and NAMES a card whose in-scope blocker did not land — never forces it', async () => {
    // The run OWNS PROD-3. That is not the same as being allowed to build it out
    // of order, and the difference is the whole reason this is a skip rather
    // than a dispatch.
    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      {
        opts: { keepGoing: true },
        agentResults: (k) => ({ exitCode: k === 'PROD-2' ? 1 : 0, signal: null }),
      },
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'blocked_in_scope', blockedBy: ['PROD-2'] },
    ]);
    expect(renderAutoSummary(summary)).toContain('its blockers inside this scope did not land');
  });

  it('SKIPS a container that somehow reached the set, with the planning vocabulary', async () => {
    // ⚠️ It should not be reachable — `wrong_shape` refuses a scope whose child
    // is a container before anything is claimed — and the classifier answers for
    // it anyway, so a scoped run can never disagree with `auto` and `batch`
    // about what a coding agent may be handed.
    const summary = await drive(
      [member('PROD-2'), member('PROD-3', { kind: 'story', type: null, executor: null })],
      {},
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'needs_planning' },
    ]);
  });

  it('SKIPS and NAMES a manual / human card, using the shared vocabulary', async () => {
    // The same `classifyReadyItem` `auto` and `batch` use, so a scoped run
    // cannot disagree with them about what a coding agent may be handed. The
    // story stays open, correctly.
    const summary = await drive(
      [member('PROD-2'), member('PROD-3', { type: 'manual', executor: 'human' })],
      {},
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'needs_human' },
    ]);
    expect(autoExitCode(summary)).toBe(0);
  });

  it('halts on the first failed agent, and --keep-going continues past one', async () => {
    const halting = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        agentResults: (k) => ({ exitCode: k === 'PROD-2' ? 1 : 0, signal: null }),
      },
    );
    expect(halting.stopReason).toBe('halted');
    expect(fake.dispatched).toEqual(['PROD-2']);
    // A failed card leaves nothing reverted and nothing transitioned past where
    // it got to — matching what `motir auto` already does.
    expect(halting.records[0]?.sessionBranch).toBeNull();
    expect(autoExitCode(halting)).not.toBe(0);

    fake.dispatched = [];
    const keepGoing = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        opts: { keepGoing: true },
        agentResults: (k) => ({ exitCode: k === 'PROD-2' ? 1 : 0, signal: null }),
      },
    );
    expect(keepGoing.stopReason).toBe('drained');
    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-3']);
  });

  it('Ctrl-C finishes the card in flight and stops, reporting `interrupted`', async () => {
    // ⚠️ THE INTERRUPT IS COOPERATIVE, and that is the design: the handler sets
    // a flag, the card already running finishes, and the loop stops at the top
    // of the next iteration — so the work in flight is not abandoned half-done
    // and the session pull request still gets opened. (A SECOND Ctrl-C exits
    // immediately; that arm calls `process.exit` and is the one line here no
    // test can drive without taking the runner with it.)
    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        agentResults: (key) => {
          if (key === 'PROD-2') process.emit('SIGINT');
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(summary.stopReason).toBe('interrupted');
    // The first card RAN and was recorded; the second was never started.
    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-2']);
  });

  it('--max stops after n cards and the rest are simply not reached', async () => {
    const summary = await drive([member('PROD-2'), member('PROD-3')], {}, { max: 1 });

    expect(summary.stopReason).toBe('max');
    expect(fake.dispatched).toEqual(['PROD-2']);
  });

  it('opens ONE session branch per repo, lazily, and records the repos it touched', async () => {
    const summary = await drive([member('PROD-2'), member('PROD-3')], {});

    expect(summary.repos).toHaveLength(1);
    expect(summary.repos[0]?.branch).toBe('motir/auto-x');
    // Both cards ride the ONE branch — that is what makes one pull request the
    // review surface for the whole scope.
    expect(summary.repos[0]?.keys).toEqual(['PROD-2', 'PROD-3']);
  });

  it('every completed card is at implemented/integrated when the drain returns', async () => {
    const summary = await drive([member('PROD-2')], {});

    expect(summary.records[0]?.outcome).toBe('integrated');
    expect(fake.calls).toContain('integrated:PROD-2');
    // ⚠️ NOT In Review. The checks decide that, server-side, minutes later —
    // this loop does not wait for CI, poll it, or retry on it.
    expect(renderAutoSummary(summary)).not.toContain('CI is green');
  });
});

describe('readScopeEdges — two scope kinds, two sources', () => {
  // ⚠️ The edges cannot come from the ready set. A claim takes every member in
  // the to-do CATEGORY (`blocked` included), while a ready row's `blockedBy` is
  // empty BY CONSTRUCTION — it is empty *because* the row is ready. So the order
  // is read from somewhere that knows the graph, once, before the first agent.

  it('a CONTAINER scope reads them off the child rows of ONE get_work_item', () => {
    // The same call the shape check already made. Note the asymmetry this
    // function has to survive: the child ROW is keyed `identifier`, the EDGE
    // rows on it are keyed `key`.
    const calls: string[] = [];
    const client = {
      getWorkItem: async (key: string) => {
        calls.push(key);
        return {
          children: [
            { identifier: 'PROD-2', dependencies: { blockedBy: [], blocks: [] } },
            {
              identifier: 'PROD-3',
              dependencies: {
                blockedBy: [{ key: 'PROD-2', title: 'x', status: 'todo' }],
                blocks: [],
              },
            },
            { identifier: 'PROD-4' }, // an older server: no edge block at all
          ],
        };
      },
    } as unknown as MotirClient;

    return readScopeEdges(client, { kind: 'work_item', key: 'PROD-1' }, 'PROD').then((edges) => {
      expect(calls).toEqual(['PROD-1']);
      expect(edges).toEqual({ 'PROD-2': [], 'PROD-3': ['PROD-2'], 'PROD-4': [] });
    });
  });

  it('a SPRINT scope reads them off the collection, filtered to the sprint, PAGED', () => {
    // A sprint spans several parents at mixed depths, so there is no one
    // container to read — and a walk that stopped at the first page would order
    // the run from half a graph.
    const filters: unknown[] = [];
    let page = 0;
    const client = {
      searchWorkItems: async (args: { filter?: unknown; cursor?: string }) => {
        filters.push(args.filter);
        page += 1;
        return page === 1
          ? {
              items: [{ identifier: 'PROD-2', dependencies: { blockedBy: [], blocks: [] } }],
              nextCursor: 'c1',
            }
          : {
              items: [
                {
                  identifier: 'PROD-3',
                  dependencies: {
                    blockedBy: [{ key: 'PROD-2', title: 'x', status: 'todo' }],
                    blocks: [],
                  },
                },
              ],
              nextCursor: null,
            };
      },
    } as unknown as MotirClient;

    return readScopeEdges(client, { kind: 'sprint', sprintId: 's1' }, 'PROD').then((edges) => {
      expect(page).toBe(2);
      expect(edges).toEqual({ 'PROD-2': [], 'PROD-3': ['PROD-2'] });
      expect(filters[0]).toEqual({
        version: 'v1',
        combinator: 'and',
        conditions: [{ field: 'sprint', operator: 'is_any_of', value: ['s1'] }],
      });
    });
  });
});

describe('drainScope — the paths a happy run does not take', () => {
  it('a REPLANNED card stops the run, and --keep-going does NOT override it', async () => {
    // That flag says one agent failing is not a reason to abandon the rest.
    // This is not a failure: it is the agent reporting that the PLAN is wrong,
    // and every card left in this scope is one the submitted plan may change.
    replanned.add('PROD-2');
    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        opts: { keepGoing: true },
      },
    );

    expect(summary.stopReason).toBe('replanned');
    expect(summary.records.map((r) => r.outcome)).toEqual(['replanned']);
    expect(fake.dispatched).toEqual(['PROD-2']);
    // Never integrated, so it is not among the cards the branch carries.
    expect(summary.records[0]?.sessionBranch).toBeNull();
  });

  it('a git failure creating a session branch HALTS, before any agent is spawned', async () => {
    // ⚠️ The PROMPT read still happened, and that is the shipped seed-first
    // order (MOTIR-2398): the prompt is a pure read that neither claims the card
    // nor moves its status, so paying for it before knowing whether a checkout
    // exists costs nothing. What must NOT have happened is a SPAWN — and the
    // card is left untouched, with no record.
    const spawned: string[] = [];
    const summary = await drive(
      [member('PROD-2')],
      {},
      {
        run: () => ({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repository' }),
        agentResults: (key) => {
          spawned.push(key);
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(summary.stopReason).toBe('halted');
    expect(spawned).toEqual([]);
    expect(summary.records).toEqual([]);
  });
});

describe('drainScope — the shapes an older or richer server produces', () => {
  it('reads a MULTI-REPOSITORY card’s whole set, and records every repo on it', async () => {
    // A card can name a repository SET (MOTIR-3135), primary first. The record
    // has to carry all of them, because a FAILED card belongs in the pull-request
    // body of every repository it half-touched — not only the primary's.
    mkdirSync(join(fake.root, 'motir-ai'), { recursive: true });
    // ⚠️ THE WHOLE ROW, not just the name. `targetRepos` carries the clone URL,
    // the default branch and the delivery state alongside it, and a fixture that
    // supplied a name-only object would be typing a shape the server never
    // sends — which is exactly what `packages/cli`'s own typecheck catches.
    repoSets['PROD-2'] = [
      { name: 'motir-core', cloneUrl: null, defaultBranch: null, delivery: null },
      { name: 'motir-ai', cloneUrl: null, defaultBranch: null, delivery: null },
    ];

    const summary = await drive([member('PROD-2')], {});

    expect(summary.records[0]?.repos).toEqual(['motir-core', 'motir-ai']);
    expect(summary.repos.map((r) => r.repoName)).toEqual(['motir-core', 'motir-ai']);
  });

  it('re-reads the prompt WITHOUT the seed when no checkout can carry the lineage', async () => {
    // The seeded prompt names a branch that does not exist here, so the agent
    // would be told to integrate into nothing. The extra request buys
    // correctness on a path that was already the exception.
    repoOf['PROD-2'] = 'motir-nowhere';
    // The card routes at a checkout that does not exist, so the target falls
    // back to the workspace ROOT — and git refuses there, which is the
    // tolerated failure `RepoSessions` turns into "no lineage here".
    const gitFailsAtRoot: CommandRunner = (bin, args, cwd) =>
      cwd === fake.root
        ? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
        : GIT(bin, args, cwd);

    const summary = await drive([member('PROD-2')], {}, { run: gitFailsAtRoot });

    const seeds = fake.promptSeeds;
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toBe(true); // seeded first, per MOTIR-2398
    expect(seeds[1]).toBe(false); // then re-read plain
    expect(summary.repos).toEqual([]); // and no stray branch anywhere
  });

  it('records a claim REFUSED mid-drain as a skip rather than swallowing it', async () => {
    // ⚠️ Unreachable on a healthy scoped run — this run already holds every
    // member — so it is recorded rather than ignored: if it ever fires, the
    // up-front claim did not hold, and the summary is where that has to show.
    claimRefuses.add('PROD-2');

    const summary = await drive([member('PROD-2'), member('PROD-3')], {});

    expect(summary.skipped).toEqual([
      { key: 'PROD-2', title: 'Item PROD-2', reason: 'claim_refused' },
    ]);
    // And the run carries on: one card refusing is not the set failing.
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-3']);
  });

  it('treats an OLDER server’s missing edge block as no edges, not as a crash', async () => {
    const client = {
      searchWorkItems: async () => ({
        items: [{ identifier: 'PROD-2' }, { identifier: 'PROD-3' }],
        nextCursor: null,
      }),
    } as unknown as MotirClient;

    await expect(
      readScopeEdges(client, { kind: 'sprint', sprintId: 's1' }, 'PROD'),
    ).resolves.toEqual({ 'PROD-2': [], 'PROD-3': [] });
  });
});

// ── the draft/ready seam, from THIS entry point (MOTIR-4967) ───────────────
//
// ⚠️ THE POINT IS THE ENTRY POINT, not the behaviour. `openSessionPr` and the
// close-out are ONE seam shared by `motir auto` (`commands/auto.ts`) and the
// scoped run (`commands/scopeDrain.ts` → `commands/dispatch.ts`), and the draft
// lifecycle is one edit inside it rather than four. `test/auto.test.ts` proves
// the seam from the other caller; this proves a summary built by the DRAIN
// reaches the same close-out and gets the same draft.

/**
 * A runner that records every call and answers `gh` like a live repository —
 * PER CHECKOUT and STATEFUL: a `pr create` registers the pull request, so the
 * next `pr list` in that same checkout answers with it, exactly as GitHub would.
 *
 * ⚠️ THE STATE IS LOAD-BEARING SINCE MOTIR-4999, and it was not before. With the
 * drain opening the pull request mid-run, a fake answering `pr list` from a fixed
 * seed would let the close-out open a SECOND pull request off the same branch —
 * a sequence no live repository can produce, and precisely the one the
 * list-before-create no-op exists to prevent. `--json isDraft` is answered from
 * `over.isDraft` throughout: draft state is what `markSessionPrReady` reads, and
 * no call in these tests changes it.
 */
function recordingGit(over: { existingPr?: string; isDraft?: string } = {}): {
  run: CommandRunner;
  log: string[];
} {
  const log: string[] = [];
  /** `checkout → its open pull request`, grown by every `pr create`. */
  const open = new Map<string, string>();
  let nextPr = 9001;
  const run: CommandRunner = (bin, args, cwd) => {
    log.push(`${bin} ${args.join(' ')} @${cwd}`);
    if (bin === 'gh') {
      if (args[1] === 'list') {
        if (args.includes('isDraft')) return ok(over.isDraft ?? 'true');
        return ok(open.get(cwd) ?? over.existingPr ?? '');
      }
      if (args[1] === 'create') {
        const url = `https://github.test/pull/${nextPr}`;
        nextPr += 1;
        open.set(cwd, url);
        return ok(url);
      }
    }
    // The close-out counts the branch's commits with `rev-list --count`; the
    // shared GIT stub answers every git read with a sha, which parses to NaN
    // and would report the branch EMPTY before any `gh` ran.
    if (bin === 'git' && args[0] === 'rev-list') return ok('3');
    return GIT(bin, args, '/');
  };
  return { run, log };
}

/** Every `gh pr create` the log recorded, as its raw argv line. */
const created = (log: readonly string[]): string[] =>
  log.filter((line) => line.startsWith('gh pr create'));

describe('the scoped drain’s summary goes through the same draft close-out', () => {
  it('opens a DRAFT and marks it ready — after the title rewrite', async () => {
    const { run, log } = recordingGit({ existingPr: 'https://github.test/pull/9001' });
    const summary = await drive([member('PROD-2')], { 'PROD-2': [] }, { run });

    closeOutRepos(summary, run);

    const edited = log.findIndex((line) => line.includes('gh pr edit'));
    const readied = log.findIndex((line) => line.includes('gh pr ready'));
    expect(edited).toBeGreaterThanOrEqual(0);
    expect(readied).toBeGreaterThan(edited);
    expect(summary.prs[0]?.draft).toBeUndefined();
  });

  it('leaves the pull request a DRAFT when the container still has children', async () => {
    // The scoped run is the lane this matters in: its close-out re-reads the
    // container (`readOpenChildren`) precisely because a bug filed mid-drain
    // parents itself under it.
    const { run, log } = recordingGit();
    const summary = await drive([member('PROD-2')], { 'PROD-2': [] }, { run });

    closeOutRepos(summary, run, { containerKey: 'PROD-1', openChildren: ['PROD-9'] });

    expect(log.some((line) => line.includes('pr create') && line.includes('--draft'))).toBe(true);
    expect(log.some((line) => line.includes('gh pr ready'))).toBe(false);
    // ⚠️ `existing`, NOT `opened` (MOTIR-4999). The drain opened it at the first
    // card that landed, so the close-out finds it — which is what `closeOutRepo`
    // means by *"`existing` is now the ORDINARY outcome rather than a resumed-run
    // edge"*. What this test is about is unchanged and is asserted above: the
    // pull request is a DRAFT and is NOT readied while a child is outstanding.
    expect(summary.prs[0]).toMatchObject({ outcome: 'existing', draft: true });
    expect(renderAutoSummary(summary)).toContain('PROD-1 is NOT finished');
  });
});

// ── the STORY BINDING (MOTIR-4969) ─────────────────────────────────────────
//
// ⚠️ ASSERTED FROM THE DRAIN'S OWN LOOP, for the reason the block above this one
// states: the eager open was written for THIS lane and shipped only on the other
// one, because the test that proved it drove `runAutoLoop`. The link rides the
// same helper on the same trigger, so it inherits that lesson rather than
// re-learning it. The per-ARM assertions are in `test/sessionPrContainer.test.ts`.

describe('the scoped drain declares what its session pull request delivers', () => {
  it('links the claimed container once its carried set shares a parent', async () => {
    const { run } = recordingGit();

    await drive([member('PROD-2'), member('PROD-3')], { 'PROD-3': ['PROD-2'] }, { run });

    // ONE link, not one per card: the container is the deliverable, and the
    // merge cascades DOWN to the children from it.
    expect(fake.links).toEqual(['PROD-1@https://github.test/pull/9001']);
  });

  it('links NOTHING while the drain has landed only one card', async () => {
    // A set of one is indistinguishable from a leaf run, and naming the story
    // there would close it on a single child.
    const { run } = recordingGit();

    await drive([member('PROD-2')], { 'PROD-2': [] }, { run });

    expect(fake.links).toEqual([]);
  });

  it('the DRAIN itself flips no container — that is the close-out’s, in order', async () => {
    // ⚠️ THE ORDER IS THE RULE. The container is told it is built only after
    // every repository's pull request has its final title and body and has been
    // marked ready, which is `closeOutRepos` followed by `closeOutContainer`. A
    // drain that moved the status itself would claim the run finished while the
    // pull request still said "0 work items".
    const { run } = recordingGit();

    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      {
        run,
      },
    );

    expect(fake.transitions).toEqual([]);

    closeOutRepos(summary, run);
    // The container is still In Progress when its close-out runs; one CI already
    // moved on is left where it is (sessionPrContainer.test.ts).
    statusOf.set('PROD-1', 'in_progress');
    await closeOutContainer(session().client, summary);

    expect(fake.transitions).toEqual(['PROD-1:implemented']);
  });
});

// ── a STORY scope's draft is the story's from its first card (MOTIR-10985) ──
//
// A story run's first card used to land in a set of ONE — `one-card`, which
// titles the pull request for that card and links no story — so the story was
// linked only from the second card. A scope knows its work item before the
// first card starts, and hands it to the drain as `container`.

describe('a story scope opens the story’s DRAFT at its first landed card (MOTIR-10985)', () => {
  const STORY = { key: 'PROD-1', title: 'Agents read and add a page’s discussion' };
  const PR = 'https://github.test/pull/9001';

  it('ONE landed card: a DRAFT, titled for the story, linked to the story', async () => {
    const { run, log } = recordingGit();

    await drive([member('PROD-2')], { 'PROD-2': [] }, { run, container: STORY });

    expect(created(log)).toHaveLength(1);
    const argv = created(log)[0]!;
    expect(argv).toContain('--draft');
    expect(argv).toContain(`--title ${STORY.key} ${STORY.title}`);
    expect(argv).not.toContain('--title PROD-2');
    expect(fake.links).toEqual([`PROD-1@${PR}`]);
  });

  it('later cards find the SAME pull request, and the close-out readies it once every child landed', async () => {
    const { run, log } = recordingGit();

    const summary = await drive(
      [member('PROD-2'), member('PROD-3'), member('PROD-4')],
      { 'PROD-3': ['PROD-2'], 'PROD-4': ['PROD-3'] },
      { run, container: STORY },
    );

    expect(created(log)).toHaveLength(1);
    // Re-declared on every landed card — an idempotent upsert — and only ever the story.
    expect(new Set(fake.links)).toEqual(new Set([`PROD-1@${PR}`]));
    expect(summary.container).toEqual(STORY);

    closeOutRepos(summary, run);

    const edit = log.findIndex((line) => line.startsWith('gh pr edit'));
    const ready = log.findIndex((line) => line.startsWith('gh pr ready'));
    expect(log[edit]).toContain(`--title ${STORY.key} ${STORY.title}`);
    expect(ready).toBeGreaterThan(edit);
    expect(summary.prs[0]).toMatchObject({ url: PR, outcome: 'existing' });
    expect(summary.prs[0]?.draft).toBeUndefined();
    expect(created(log)).toHaveLength(1);

    statusOf.set('PROD-1', 'in_progress');
    await closeOutContainer(session().client, summary);
    expect(fake.transitions).toEqual(['PROD-1:implemented']);
  });

  it('a story with ONE child is told it is built by the close-out, as a bigger one is', async () => {
    const { run } = recordingGit();
    const summary = await drive([member('PROD-2')], { 'PROD-2': [] }, { run, container: STORY });

    closeOutRepos(summary, run);
    statusOf.set('PROD-1', 'in_progress');
    await closeOutContainer(session().client, summary);

    expect(fake.transitions).toEqual(['PROD-1:implemented']);
  });

  it('a FAILED child leaves it a DRAFT, and the story is not told it is built', async () => {
    const { run, log } = recordingGit();

    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        run,
        container: STORY,
        opts: { keepGoing: true },
        agentResults: (key) => ({ exitCode: key === 'PROD-3' ? 1 : 0, signal: null }),
      },
    );
    expect(summary.records.map((r) => r.outcome)).toEqual(['integrated', 'failed']);
    expect(fake.links).toEqual([`PROD-1@${PR}`]);

    // The close-out's re-read names the child that did not land.
    closeOutRepos(summary, run, { containerKey: 'PROD-1', openChildren: ['PROD-3'] });

    expect(log.some((line) => line.startsWith('gh pr ready'))).toBe(false);
    expect(summary.prs[0]).toMatchObject({ draft: true });
    await closeOutContainer(session().client, summary);
    expect(fake.transitions).toEqual([]);
  });

  it('a SKIPPED child (waiting on a gate) leaves it a DRAFT too', async () => {
    const { run, log } = recordingGit();
    typeOf.set('PROD-2', 'design');

    const summary = await drive(
      [member('PROD-2', { type: 'design' }), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      { run, container: STORY },
    );
    expect(summary.skipped.map((s) => s.key)).toEqual(['PROD-3']);

    closeOutRepos(summary, run, { containerKey: 'PROD-1', openChildren: ['PROD-3'] });

    expect(created(log)[0]).toContain(`--title ${STORY.key} ${STORY.title}`);
    expect(log.some((line) => line.startsWith('gh pr ready'))).toBe(false);
    expect(summary.prs[0]).toMatchObject({ draft: true });
  });

  it('a scope with NO work item (a sprint) keeps today’s titles and links nothing for one card', async () => {
    const { run, log } = recordingGit();

    const summary = await drive([member('PROD-2')], { 'PROD-2': [] }, { run });

    // The eager open's title is the run's, and the close-out's names the one card.
    expect(created(log)[0]).toContain('--title Motir auto run x — 0 work items');
    closeOutRepos(summary, run);
    expect(log.find((line) => line.startsWith('gh pr edit'))).toContain(
      '--title PROD-2 Item PROD-2',
    );
    expect(fake.links).toEqual([]);
    expect(summary.container).toBeUndefined();
  });
});

// ── the pull request opens MID-DRAIN, not at the close-out (MOTIR-4999) ────
//
// ⚠️ ASSERTED FROM THE DRAIN'S OWN LOOP, and that is the entire point of putting
// these here rather than widening `test/auto.test.ts`. The eager open lived
// behind `LoopInput.openPrEagerly`, a flag `motir auto` passed and this loop
// never saw — because this loop does not run `runAutoLoop` at all. A test driving
// `runAutoLoop` therefore proved the timing for the lane that already had it and
// said nothing whatsoever about the lane the decision was written for, which is
// how the gap survived a careful reading of the file that contains it.
//
// ⚠️ AND NONE OF THESE CALL `closeOutRepos`. The close-out opens a pull request
// too, so a test that ran it could not tell an eager open from a late one — the
// absence of that call is what makes each assertion below about the DRAIN.

describe('the drain opens each repository’s session pull request as its work lands', () => {
  it('opens it at the FIRST card that lands, as a DRAFT, before the drain reaches the next card', async () => {
    const { run, log } = recordingGit();
    /** How many cards had been dispatched when each `gh pr create` fired. */
    const createdAfter: number[] = [];
    const watching: CommandRunner = (bin, args, cwd) => {
      if (bin === 'gh' && args[1] === 'create') createdAfter.push(fake.dispatched.length);
      return run(bin, args, cwd);
    };

    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      { run: watching },
    );

    // The timing claim, stated as a measurement rather than as an ordering of
    // log lines: the pull request existed while ONE card had been dispatched and
    // the second had not been reached.
    expect(createdAfter).toEqual([1]);
    expect(summary.records.map((r) => r.outcome)).toEqual(['integrated', 'integrated']);

    const argv = created(log)[0]!;
    expect(argv).toContain('--draft');
    expect(argv).toContain('--base main');
    expect(argv).toContain('--head motir/auto-x');
    expect(argv).toContain(`@${join(fake.root, 'motir-core')}`);
  });

  it('opens NO second pull request when a later card lands in the same repository', async () => {
    // `openSessionPr` lists before it creates, so every card after the first
    // finds the same pull request. The drain holds no "have I opened it?" state
    // of its own — which is what makes a resumed drain safe — so this is the
    // assertion that the no-op is real rather than merely intended.
    const { run, log } = recordingGit();

    const summary = await drive(
      [member('PROD-2'), member('PROD-3'), member('PROD-4')],
      { 'PROD-3': ['PROD-2'], 'PROD-4': ['PROD-3'] },
      { run },
    );

    expect(summary.records.map((r) => r.outcome)).toEqual([
      'integrated',
      'integrated',
      'integrated',
    ]);
    expect(created(log)).toHaveLength(1);
  });

  it('opens NOTHING for a card that does not LAND — failed or replanned', async () => {
    // `landedWork` is the trigger, exactly as it is in `runAutoLoop`: an agent
    // that failed before integrating leaves nothing to review, and a card the
    // agent REFUSED is not delivered work either. In both cases the repository
    // session exists — the branch was created before the agent ran — so a
    // trigger keyed on "did we touch a repo?" would have opened one here.
    const failing = recordingGit();
    const failed = await drive(
      [member('PROD-2')],
      {},
      {
        run: failing.run,
        agentResults: () => ({ exitCode: 1, signal: null }),
      },
    );
    expect(failed.records[0]?.outcome).toBe('failed');
    expect(failed.repos).toHaveLength(1);
    expect(created(failing.log)).toEqual([]);

    replanned.add('PROD-2');
    const refusing = recordingGit();
    const refused = await drive([member('PROD-2')], {}, { run: refusing.run });
    expect(refused.records[0]?.outcome).toBe('replanned');
    expect(created(refusing.log)).toEqual([]);
  });

  it('opens ONE per repository it landed work in, and none for a repository it did not touch', async () => {
    mkdirSync(join(fake.root, 'motir-ai'), { recursive: true });
    // A checkout the drain never routes a card into. It exists so the assertion
    // below is about what the drain TOUCHED rather than about what happens to be
    // on disk — the two are the same set only by accident.
    mkdirSync(join(fake.root, 'motir-gateway'), { recursive: true });
    repoSets['PROD-2'] = [
      { name: 'motir-core', cloneUrl: null, defaultBranch: null, delivery: null },
      { name: 'motir-ai', cloneUrl: null, defaultBranch: null, delivery: null },
    ];
    const { run, log } = recordingGit();

    const summary = await drive([member('PROD-2')], {}, { run });

    expect(summary.repos.map((r) => r.repoName)).toEqual(['motir-core', 'motir-ai']);
    expect(created(log)).toHaveLength(2);
    for (const repo of ['motir-core', 'motir-ai']) {
      expect(created(log).some((line) => line.endsWith(`@${join(fake.root, repo)}`))).toBe(true);
    }
    expect(log.some((line) => line.includes(join(fake.root, 'motir-gateway')))).toBe(false);
  });
});

// ── a DECISION child ships on its OWN pull request (MOTIR-6094) ─────────────
//
// Approving a decision also authorises the merge of the pull request linked to
// it (`approval-gates.md` §8's FIFTH AMENDMENT, clause 5). A decision child that
// joined the session would be linked to the SESSION pull request — the only one
// there is — and one press meant to accept a document would merge every other
// card of the story. So it never joins, and what waits on it waits for a PERSON.

describe('a decision child never joins the session, and its dependents are held', () => {
  const decision = (key: string): DispatchItem => member(key, { type: 'decision' });

  it('reads the decision’s prompt with NO session seed, and it lands on its own pull request', async () => {
    const { run, log } = recordingGit();
    const summary = await drive([decision('PROD-2'), member('PROD-3')], {}, { run });

    // The decision's prompt read carries no seed; the code card's does.
    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-3']);
    expect(fake.promptSeeds).toEqual([false, true]);
    // Implemented via its OWN pull request — never integrated on the session.
    expect(summary.records.find((r) => r.key === 'PROD-2')).toMatchObject({
      outcome: 'implemented',
      sessionBranch: null,
    });
    expect(fake.calls).not.toContain('integrated:PROD-2');
    // The session branch carries the code card alone.
    expect(summary.repos[0]?.keys).toEqual(['PROD-3']);
    // ONE session pull request, opened on the CODE card's account.
    expect(created(log)).toHaveLength(1);
  });

  it('never links the session pull request to the decision card', async () => {
    const { run } = recordingGit();
    await drive([decision('PROD-2'), member('PROD-3'), member('PROD-4')], {}, { run });

    // The only link the drain declares is the CONTAINER's (two landed code
    // cards share PROD-1; re-declared per landed card, an upsert). Nothing names
    // the decision, so approving its gate carries no merge of the pull request
    // the rest of the story is on.
    expect(fake.links.some((l) => l.startsWith('PROD-2@'))).toBe(false);
    expect([...new Set(fake.links)]).toEqual(['PROD-1@https://github.test/pull/9001']);
  });

  it('holds a dependent of the decision and NAMES it, like a skipped manual card', async () => {
    const summary = await drive([decision('PROD-2'), member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'blocked_in_scope', blockedBy: ['PROD-2'] },
    ]);
    expect(fake.stderr).toContain('PROD-3: held — waiting on decision PROD-2 to be approved.');
  });

  it('a decision that FAILED is a blocker that did not land, not one awaiting approval', async () => {
    const summary = await drive(
      [decision('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      {
        opts: { keepGoing: true },
        agentResults: (key) =>
          key === 'PROD-2' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
      },
    );

    expect(summary.skipped[0]).toMatchObject({ key: 'PROD-3', blockedBy: ['PROD-2'] });
    expect(fake.stderr).toContain('PROD-3: skipped — waiting on PROD-2, which did not land.');
  });

  it('on a RE-RUN, a decision an earlier run shipped still holds its dependents until approved', async () => {
    // PROD-2 was shipped by an earlier run and waits on its gate at In Review,
    // so it is not a member of this claim — and `unsatisfiedBlockers`, in-scope
    // only, cannot see it. The pre-drain read is what does.
    typeOf.set('PROD-2', 'decision');
    statusOf.set('PROD-2', 'in_review');

    const summary = await drive([member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual([]);
    expect(summary.skipped[0]).toMatchObject({ key: 'PROD-3', blockedBy: ['PROD-2'] });
  });

  it.each(['approved', 'done'])(
    'an earlier decision at %s releases its dependents',
    async (status) => {
      typeOf.set('PROD-2', 'decision');
      statusOf.set('PROD-2', status);

      await drive([member('PROD-3')], { 'PROD-3': ['PROD-2'] });

      expect(fake.dispatched).toEqual(['PROD-3']);
    },
  );

  it('a CANCELLED decision still holds — an overturned decision is a re-plan owed', async () => {
    typeOf.set('PROD-2', 'decision');
    statusOf.set('PROD-2', 'cancelled');

    await drive([member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual([]);
  });

  it('a non-member blocker that is NOT a decision holds nothing', async () => {
    statusOf.set('PROD-2', 'in_review');

    await drive([member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual(['PROD-3']);
  });
});

// ── MOTIR-6117 — a DESIGN child holds its dependents, and a gate approved while
// the drain runs releases them in the SAME run ────────────────────────────────
//
// A landed design used to count as a SATISFIED blocker: its dependents were
// dispatched into the run-time design gate, whose stop proposes a replacement
// design nobody asked for. And every hold, decision or design, was read once, so
// an approval that landed mid-drain released nothing until somebody re-ran.

describe('a design child holds its dependents until its gate is approved', () => {
  const design = (key: string): DispatchItem => member(key, { type: 'design' });

  it('never dispatches a dependent of a design that landed, and names the design', async () => {
    const summary = await drive([design('PROD-2'), member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'blocked_in_scope', blockedBy: ['PROD-2'] },
    ]);
    expect(fake.stderr).toContain('PROD-3: held — waiting on design PROD-2 to be approved.');
    // Its verdict was re-read through the dependent before the run gave up on it.
    expect(fake.reads).toContain('designs:PROD-3');
    expect(fake.stderr).toContain(
      'PROD-3: still held — design PROD-2 not approved when this run ended. ' +
        'Its approval, not this run, releases it; run the scope again after it.',
    );
  });

  it('a design that FAILED is a blocker that did not land, not one awaiting approval', async () => {
    await drive(
      [design('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      {
        opts: { keepGoing: true },
        agentResults: (key) =>
          key === 'PROD-2' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
      },
    );

    expect(fake.stderr).toContain('PROD-3: skipped — waiting on PROD-2, which did not land.');
    expect(fake.reads.filter((r) => r.startsWith('designs:'))).toEqual([]);
  });

  it('on a RE-RUN, a design an earlier run shipped holds by its VERDICT, not its status', async () => {
    // `done` with no approved result (withdrawn, never published) is not a design
    // to build against — the verdict says so, the status does not.
    typeOf.set('PROD-2', 'design');
    statusOf.set('PROD-2', 'done');
    verdictOf.set('PROD-2', 'not_approved');

    const summary = await drive([member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual([]);
    expect(summary.skipped[0]).toMatchObject({ key: 'PROD-3', blockedBy: ['PROD-2'] });
  });

  it('an earlier design whose verdict is approved releases its dependents', async () => {
    typeOf.set('PROD-2', 'design');
    statusOf.set('PROD-2', 'done');
    verdictOf.set('PROD-2', 'approved');

    await drive([member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(fake.dispatched).toEqual(['PROD-3']);
  });
});

describe('a gate approved DURING the drain releases what it held in the same run', () => {
  it('a DECISION the drain shipped, approved while it worked the rest, releases its dependent', async () => {
    // PROD-2 lands and holds PROD-3; the person approves PROD-2 while the drain
    // is on PROD-4, which is independent. The pass ends with PROD-3 held, the
    // re-read finds PROD-2 approved, and PROD-3 is built before the run ends.
    approveOnDispatch.set('PROD-4', 'PROD-2');

    const summary = await drive(
      [member('PROD-2', { type: 'decision' }), member('PROD-3'), member('PROD-4')],
      { 'PROD-3': ['PROD-2'] },
    );

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-4', 'PROD-3']);
    expect(summary.skipped).toEqual([]);
    expect(summary.stopReason).toBe('drained');
    expect(fake.stderr).toContain('decision PROD-2 approved during this run');
    expect(fake.stderr).not.toContain('run the scope again');
  });

  it('a DESIGN awaiting at start and approved at the final re-read releases its dependent', async () => {
    typeOf.set('PROD-2', 'design');
    verdictOf.set('PROD-2', 'not_approved');
    approveOnDispatch.set('PROD-4', 'PROD-2');

    const summary = await drive([member('PROD-3'), member('PROD-4')], { 'PROD-3': ['PROD-2'] });

    // Held at start (PROD-3 is first in rank and skipped), released at the end.
    expect(fake.dispatched).toEqual(['PROD-4', 'PROD-3']);
    expect(summary.skipped).toEqual([]);
    // One verdict read to seed the hold, one at the re-read — through the dependent.
    expect(fake.reads.filter((r) => r.startsWith('designs:'))).toEqual([
      'designs:PROD-3',
      'designs:PROD-3',
    ]);
  });

  it('a released gate frees the chain behind it too, in blocked_by order', async () => {
    // PROD-5 waits on PROD-3, which waits on the gate: PROD-5 was skipped as
    // "did not land", and the extra pass reaches it after PROD-3 lands.
    approveOnDispatch.set('PROD-4', 'PROD-2');

    await drive(
      [
        member('PROD-2', { type: 'decision' }),
        member('PROD-3'),
        member('PROD-5'),
        member('PROD-4'),
      ],
      { 'PROD-3': ['PROD-2'], 'PROD-5': ['PROD-3'] },
    );

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-4', 'PROD-3', 'PROD-5']);
  });

  it('TERMINATES: a gate that never approves costs exactly ONE extra verdict read per held gate', async () => {
    // Two held gates — an in-scope decision and an out-of-scope design — and an
    // independent card, so the pass has something else to do.
    typeOf.set('PROD-5', 'design');
    verdictOf.set('PROD-5', 'not_approved');

    const summary = await drive(
      [
        member('PROD-2', { type: 'decision' }),
        member('PROD-3'),
        member('PROD-6'),
        member('PROD-4'),
      ],
      { 'PROD-3': ['PROD-2'], 'PROD-6': ['PROD-5'] },
    );

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-4']);
    // PROD-6's only blocker is outside the scope, so it ranks ahead of PROD-3.
    expect(summary.skipped.map((s) => s.key)).toEqual(['PROD-6', 'PROD-3']);
    // The design's hold was SEEDED by one verdict read before any dispatch.
    expect(fake.reads.indexOf('designs:PROD-6')).toBeLessThan(
      fake.reads.indexOf('dispatch:PROD-2'),
    );
    // After the last card's own pipeline reads (PROD-4's), the drain made
    // exactly ONE read per held gate — then stopped, because nothing released.
    const lastCard = fake.reads.lastIndexOf('dispatch:PROD-4');
    const reReads = fake.reads.slice(lastCard + 1).filter((r) => r !== 'get:PROD-4');
    expect(reReads.sort()).toEqual(['designs:PROD-6', 'get:PROD-2']);
    // Each still-held card is named once more, with the re-run advice.
    expect(fake.stderr).toContain('PROD-3: still held — decision PROD-2 not approved');
    expect(fake.stderr).toContain('PROD-6: still held — design PROD-5 not approved');
  });

  it('re-passes only what changed: an unchanged hold stays silent, a narrowed one is re-named', async () => {
    // Two gates; only PROD-2 is approved mid-drain. PROD-3 (on PROD-2 alone) is
    // released; PROD-6 (on PROD-5 alone) is re-visited and says nothing new;
    // PROD-7 (on both) is re-visited and now waits on PROD-5 only.
    typeOf.set('PROD-5', 'decision');
    approveOnDispatch.set('PROD-4', 'PROD-2');

    const summary = await drive(
      [
        member('PROD-2', { type: 'decision' }),
        member('PROD-3'),
        member('PROD-6'),
        member('PROD-7'),
        member('PROD-4'),
      ],
      { 'PROD-3': ['PROD-2'], 'PROD-6': ['PROD-5'], 'PROD-7': ['PROD-2', 'PROD-5'] },
    );

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-4', 'PROD-3']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-6', title: 'Item PROD-6', reason: 'blocked_in_scope', blockedBy: ['PROD-5'] },
      { key: 'PROD-7', title: 'Item PROD-7', reason: 'blocked_in_scope', blockedBy: ['PROD-5'] },
    ]);
    expect(fake.stderr.match(/PROD-6: held/g)).toHaveLength(1);
    expect(fake.stderr).toContain(
      'PROD-7: held — waiting on decision PROD-2, decision PROD-5 to be approved.',
    );
    expect(fake.stderr).toContain('PROD-7: held — waiting on decision PROD-5 to be approved.');
  });

  it('a gate whose RE-read fails stays held, and the failure is named', async () => {
    typeOf.set('PROD-2', 'design');
    let reads = 0;

    const summary = await drive(
      [member('PROD-3'), member('PROD-4')],
      { 'PROD-3': ['PROD-2'] },
      {
        // The seed read answers; the re-read at the end of the pass does not.
        client: (c) =>
          ({
            ...c,
            listWorkItemDesigns: async (key: string) => {
              if (++reads > 1) throw new Error('verdict read down');
              return c.listWorkItemDesigns(key);
            },
          }) as MotirClient,
      },
    );

    expect(fake.dispatched).toEqual(['PROD-4']);
    expect(summary.skipped[0]).toMatchObject({ key: 'PROD-3', blockedBy: ['PROD-2'] });
    expect(fake.stderr).toContain("Could not re-read design PROD-2's gate; it stays held");
  });

  it('a stopped run re-reads nothing, but still names what it left held', async () => {
    // PROD-3 is held on an earlier run's decision; PROD-4 lands; --max stops the
    // run at PROD-5, before the pass completes — so there is no re-read.
    typeOf.set('PROD-2', 'decision');

    const summary = await drive(
      [member('PROD-3'), member('PROD-4'), member('PROD-5')],
      { 'PROD-3': ['PROD-2'] },
      { max: 1 },
    );

    expect(summary.stopReason).toBe('max');
    expect(fake.dispatched).toEqual(['PROD-4']);
    // The seed read, and nothing more.
    expect(fake.reads.filter((r) => r === 'get:PROD-2')).toHaveLength(1);
    expect(fake.stderr).toContain('PROD-3: still held — decision PROD-2 not approved');
  });
});

describe('readHeldGates', () => {
  it('reads each NON-member blocker once, and a failed read is named, not held', async () => {
    const reads: string[] = [];
    const client = {
      getWorkItem: async (key: string) => {
        reads.push(key);
        if (key === 'PROD-9') throw new Error('boom');
        return {
          item: {
            identifier: key,
            status: 'in_review',
            type: 'decision',
            executor: 'coding_agent',
          },
        };
      },
    } as unknown as MotirClient;

    const held = await readHeldGates(client, [member('PROD-3'), member('PROD-4')], {
      'PROD-3': ['PROD-2', 'PROD-4', 'PROD-9'],
      'PROD-4': ['PROD-2'],
    });

    // PROD-4 is a member — the loop itself tracks it — so it is never read.
    expect(reads).toEqual(['PROD-2', 'PROD-9']);
    expect([...held]).toEqual([['PROD-2', 'decision']]);
    expect(fake.stderr).toContain('Could not read PROD-9');
  });

  it('a HUMAN decision is not an agent’s — its gate is the confirmation, and it is a member when open', async () => {
    const client = {
      getWorkItem: async (key: string) => ({
        item: { identifier: key, status: 'in_progress', type: 'decision', executor: 'human' },
      }),
    } as unknown as MotirClient;

    const held = await readHeldGates(client, [member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect(held.size).toBe(0);
  });

  it('a design whose VERDICT cannot be read HOLDS — it is known to be a design, only its approval is not', async () => {
    const client = {
      getWorkItem: async (key: string) => ({
        item: { identifier: key, status: 'in_review', type: 'design', executor: 'human' },
      }),
      listWorkItemDesigns: async () => {
        // Not an Error: a thrown value of any shape is named, and still holds.
        throw 'boom';
      },
    } as unknown as MotirClient;

    const held = await readHeldGates(client, [member('PROD-3')], { 'PROD-3': ['PROD-2'] });

    expect([...held]).toEqual([['PROD-2', 'design']]);
    expect(fake.stderr).toContain("Could not read design PROD-2's verdict");
  });
});

describe('readGateReleased', () => {
  it('reads a design through its DEPENDENT, and only its own verdict counts', async () => {
    const asked: string[] = [];
    const client = {
      listWorkItemDesigns: async (key: string) => {
        asked.push(key);
        return {
          designs: [
            { designCardKey: 'PROD-7', verdict: 'approved' },
            { designCardKey: 'PROD-2', verdict: 'not_approved' },
          ],
        };
      },
    } as unknown as MotirClient;

    expect(await readGateReleased(client, 'PROD-2', 'design', 'PROD-3')).toBe(false);
    expect(await readGateReleased(client, 'PROD-7', 'design', 'PROD-3')).toBe(true);
    expect(asked).toEqual(['PROD-3', 'PROD-3']);
  });

  it.each([
    ['approved', true],
    ['done', true],
    ['in_review', false],
    ['cancelled', false],
  ])('a decision at %s is released: %s', async (status, released) => {
    const client = {
      getWorkItem: async (key: string) => ({
        item: { identifier: key, status, type: 'decision', executor: 'coding_agent' },
      }),
    } as unknown as MotirClient;

    expect(await readGateReleased(client, 'PROD-2', 'decision', 'PROD-3')).toBe(released);
  });
});

describe('a drain stopped only by gates closes `gated`, never `drained` (MOTIR-7704)', () => {
  const design = (key: string): DispatchItem => member(key, { type: 'design' });
  const skipsOf = (events: DispatchRunEventInput[]) =>
    events.filter((e) => e.kind === 'card_skipped');

  it('a design that lands and stays awaiting holds its dependent: `gated`, naming the design', async () => {
    verdictOf.set('PROD-2', 'not_approved');
    const events: DispatchRunEventInput[] = [];

    const summary = await drive(
      [design('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      {
        events,
      },
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.stopReason).toBe('gated');
    expect(summary.gatedOn).toEqual(['PROD-2']);
    expect(autoExitCode(summary)).toBe(0);
    expect(skipsOf(events)).toEqual([
      expect.objectContaining({
        workItemKey: 'PROD-3',
        data: { blockedBy: ['PROD-2'], heldBy: [{ key: 'PROD-2', kind: 'design' }] },
      }),
    ]);
    expect(renderAutoSummary(summary)).toContain('Run x — stopped at a gate — waiting on PROD-2.');
  });

  it('the same design approved at the final re-read builds the dependent and drains as today', async () => {
    verdictOf.set('PROD-2', 'not_approved');
    approveOnDispatch.set('PROD-4', 'PROD-2');

    const summary = await drive([design('PROD-2'), member('PROD-3'), member('PROD-4')], {
      'PROD-3': ['PROD-2'],
    });

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-4', 'PROD-3']);
    expect(summary.stopReason).toBe('drained');
    expect(summary.gatedOn).toBeUndefined();
  });

  it('a chain behind the gate is held too, and the stop is still `gated`', async () => {
    const summary = await drive([design('PROD-2'), member('PROD-3'), member('PROD-4')], {
      'PROD-3': ['PROD-2'],
      'PROD-4': ['PROD-3'],
    });

    expect(summary.stopReason).toBe('gated');
    expect(summary.gatedOn).toEqual(['PROD-2']);
  });

  it('one card held by a gate and another that failed to land is NOT `gated`', async () => {
    const events: DispatchRunEventInput[] = [];
    const summary = await drive(
      [design('PROD-2'), member('PROD-3'), member('PROD-4'), member('PROD-5')],
      { 'PROD-3': ['PROD-2'], 'PROD-5': ['PROD-4'] },
      {
        events,
        opts: { keepGoing: true },
        agentResults: (key) =>
          key === 'PROD-4' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
      },
    );

    expect(summary.stopReason).toBe('drained');
    // The ordinary blocked skip carries no `heldBy`; the gate-held one does.
    const byKey = new Map(skipsOf(events).map((e) => [e.workItemKey, e.data]));
    expect(byKey.get('PROD-5')).toEqual({ blockedBy: ['PROD-4'] });
    expect(byKey.get('PROD-3')).toEqual({
      blockedBy: ['PROD-2'],
      heldBy: [{ key: 'PROD-2', kind: 'design' }],
    });
  });

  it('a card left needing planning is NOT `gated`, even beside a held one', async () => {
    const summary = await drive(
      [design('PROD-2'), member('PROD-3'), member('PROD-4', { kind: 'story' })],
      { 'PROD-3': ['PROD-2'] },
    );

    expect(summary.skipped.map((s) => s.reason).sort()).toEqual([
      'blocked_in_scope',
      'needs_planning',
    ]);
    expect(summary.stopReason).toBe('drained');
  });

  it('a scope stopped only by a manual card closes `gated`, and its dependent is held by it', async () => {
    const events: DispatchRunEventInput[] = [];
    const summary = await drive(
      [member('PROD-2'), member('PROD-3', { type: 'manual', executor: 'human' }), member('PROD-4')],
      { 'PROD-4': ['PROD-3'] },
      { events },
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.stopReason).toBe('gated');
    expect(summary.gatedOn).toEqual(['PROD-3']);
    expect(skipsOf(events).find((e) => e.workItemKey === 'PROD-4')?.data).toEqual({
      blockedBy: ['PROD-3'],
      heldBy: [{ key: 'PROD-3', kind: 'manual' }],
    });
  });

  it('a drain that skipped nothing still closes `drained`', async () => {
    const summary = await drive([member('PROD-2'), member('PROD-3')], {});
    expect(summary.stopReason).toBe('drained');
  });
});
