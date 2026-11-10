import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planSnapshot,
  runBatch,
  type BatchInput,
  type BatchOptions,
} from '../src/commands/batch.js';
import {
  batchExitCode,
  classifySnapshotItem,
  renderBatchSummary,
  renderSnapshotPlan,
  type BatchRecord,
  type BatchSummary,
} from '../src/batchPlan.js';
import { parseMax } from '../src/commands/auto.js';
import { addExclude, readExcludes } from '../src/sessionExcludes.js';
import type { CommandRunner } from '../src/git.js';
import { answerPrView } from './fakePullRequest.js';
import { CliError, ContainerHasOpenChildrenError } from '../src/errors.js';
import type { AgentRunResult } from '../src/agentRun.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import type { DispatchItem, DispatchPrompt, MotirClient } from '../src/client.js';
import type { ProjectSession } from '../src/session.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import {
  createDispatchRunReporter,
  type DispatchRunReporter,
  type OpenDispatchRunInput,
} from '../src/dispatchRunReporter.js';
import type { DispatchRunEventInput } from '../src/client.js';

// `motir batch` — the FROZEN snapshot (Subtask 7.9.10 · MOTIR-888).
//
// Driven end-to-end against a scripted server + agent, because the properties
// that define the command are invisible in any single function: that the list is
// frozen BEFORE the first agent starts, that an item which becomes ready during
// the run is counted but never dispatched (the exact inverse of 7.9.4's
// re-query proof), that no session branch is ever created and `mark_integrated`
// is never called, and that every item lands its own per-item pull request.
//
// The fake server models the REAL readiness rules rather than replaying a fixed
// sequence: a dependency counts as satisfied once it is integrated OR in review,
// and an item inherits the single session branch its integrated dependencies
// live on — which is what makes "ready only via an integrated dep" a real state
// the snapshot filter has to recognise rather than a flag the test sets.

// ── the fake server ─────────────────────────────────────────────────────────

interface FakeItem {
  id: string;
  key: string;
  kind: string;
  title: string;
  type: string | null;
  executor: string | null;
  targetRepo: string | null;
  deps: string[];
  status: string;
  /** This item's OWN recorded integration branch (set by `mark_integrated` in
   *  the real system; pre-set here to build an integrated-dependency fixture). */
  sessionBranch: string | null;
  /** Who holds it — null is unclaimed (MOTIR-2427). */
  assigneeId: string | null;
}

function leaf(id: string, key: string, over: Partial<FakeItem> = {}): FakeItem {
  return {
    id,
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    type: 'code',
    executor: 'coding_agent',
    targetRepo: 'motir-core',
    deps: [],
    status: 'todo',
    sessionBranch: null,
    assigneeId: null,
    ...over,
  };
}

class FakeServer {
  readonly transitions: { key: string; status: string }[] = [];
  /** Every `reportImplementation` call, verbatim (MOTIR-2421). */
  readonly provenance: Record<string, unknown>[] = [];
  /** Every claim the run wrote, in order (MOTIR-2427). */
  readonly claims: { key: string; ownerId: string }[] = [];
  /** What each claim attempt resolved to (MOTIR-3048). */
  readonly claimOutcomes: { key: string; outcome: string }[] = [];
  /** WHO this run's token belongs to. */
  caller = 'user_me';
  /** The `ownerId` each enumeration was narrowed by. */
  readonly ownerIdsAsked: (string | undefined)[] = [];
  readonly promptCalls: { key: string; seeded: boolean }[] = [];
  readonly nextReadyCalls: { kinds?: string[]; excluded: number }[] = [];
  /** Set to make every write fail the way a read-only PAT does. */
  readOnly = false;
  /** Model a server that IGNORES `excludeIds` — it keeps answering with the
   *  same item. The enumeration must still terminate. */
  /** Keys the server reports as `session_lineage` WITHOUT naming the branch.
   *  `sessionBranch` is nullable on the dispatch payload, so the refusal has to
   *  read without a name rather than printing `null`. */
  readonly unnamedLineage = new Set<string>();
  /** Keys whose end-of-run READ-BACK throws (MOTIR-3197) — one card's read
   *  failing must not cost the run its exit code, nor drop it from the block. */
  readonly readBackFails = new Set<string>();
  /** Set to make the reconcile fail as a WHOLE. */
  readBackDown = false;
  /** Make `transition_status` REFUSE for a key, the way the container-completeness
   *  gate does (MOTIR-3229's 422) — Bug MOTIR-3268. */
  refuseTransitionFor: ((args: { key: string; status: string }) => Error | null) | null = null;
  /** Every key the reconcile read back, in order. */
  readonly readBackCalls: string[] = [];
  /** The pull requests the run linked (MOTIR-10877). */
  readonly links: { key: string; url?: string }[] = [];

  constructor(private readonly items: FakeItem[]) {}

  byKey(key: string): FakeItem {
    const item = this.items.find((i) => i.key === key);
    if (!item) throw new Error(`no such item ${key}`);
    return item;
  }

  /** A dependency is satisfied when it is done OR integrated/awaiting review —
   *  the 7.8.11 integrated-dep readiness rule. This is what makes finishing one
   *  item genuinely unlock the next, so "batch does not pick it up" is a real
   *  restraint rather than an absent fixture. */
  private satisfied(depId: string): boolean {
    const dep = this.items.find((i) => i.id === depId);
    return !!dep && (dep.status === 'done' || dep.status === 'implemented');
  }

  /** The single lineage an item INHERITS from its integrated dependencies —
   *  the server's `readiness.inheritedSessionBranch`, which is the field the
   *  snapshot's strict-main-readiness filter reads. */
  private inherited(item: FakeItem): string | null {
    for (const depId of item.deps) {
      const dep = this.items.find((i) => i.id === depId);
      if (dep?.sessionBranch) return dep.sessionBranch;
    }
    return null;
  }

  asClient(): MotirClient {
    const fake = {
      listReady: (): never => {
        throw new Error(
          'batch snapshots via next_ready dispatch payloads — list_ready cannot carry the lineage/type/executor facts it filters on.',
        );
      },
      markIntegrated: (): never => {
        throw new Error('`motir batch` must NEVER integrate onto a session branch.');
      },
      completeSession: (): never => {
        throw new Error('`motir batch` has no session to complete.');
      },
      // The whole ready set in one call (MOTIR-2398) — the shape the v1
      // collection has. `motir batch` enumerates once and freezes it.
      listReadyForDispatch: async (args: { kinds?: string[]; ownerId?: string }) => {
        this.nextReadyCalls.push({ ...(args.kinds ? { kinds: args.kinds } : {}), excluded: 0 });
        this.ownerIdsAsked.push(args.ownerId);
        return this.items
          .filter(
            (i) =>
              i.status === 'todo' &&
              (!args.kinds || args.kinds.includes(i.kind)) &&
              // The pickable rule, applied at ENUMERATION as the real client
              // does — the snapshot is the boundary a human reads (MOTIR-2427).
              (args.ownerId === undefined ||
                i.assigneeId === null ||
                i.assigneeId === args.ownerId) &&
              i.deps.every((d) => this.satisfied(d)),
          )
          .map(
            (i): DispatchItem => ({
              key: i.key,
              kind: i.kind,
              title: i.title,
              assigneeId: i.assigneeId,
              priority: 'medium',
              status: { key: i.status, category: 'todo' },
              type: i.type,
              executor: i.executor,
              inheritedSessionBranch: this.inherited(i),
            }),
          );
      },
      dispatchPrompt: async (
        key: string,
        opts: { sessionBranch?: string | null } = {},
      ): Promise<DispatchPrompt> => {
        const item = this.byKey(key);
        this.promptCalls.push({ key, seeded: opts.sessionBranch !== undefined });
        if (this.unnamedLineage.has(key)) {
          return {
            key,
            prompt: `PROMPT ${key}`,
            parentKey: 'PROD-1',
            targetRepo: item.targetRepo,
            workflowMode: 'session_lineage',
            sessionBranch: null,
          };
        }
        // The server rule: the item's real lineage decides the workflow mode.
        const branch = this.inherited(item) ?? item.sessionBranch ?? opts.sessionBranch ?? null;
        return {
          key,
          prompt: `PROMPT ${key}`,
          parentKey: 'PROD-1',
          targetRepo: item.targetRepo,
          workflowMode: branch ? 'session_lineage' : 'per_item_pr',
          sessionBranch: branch,
        };
      },
      // The ATOMIC claim (MOTIR-3048) — one call that assigns AND flips, and
      // that can refuse. Answered by the server's own rule, so a snapshot item
      // a sibling takes mid-drain is reachable from a test.
      claimWorkItem: async (args: { key: string }) => {
        // The claim is a WRITE, and it is now the FIRST one every dispatch
        // makes — so a read-only token fails here rather than on a transition.
        if (this.readOnly) {
          throw new CliError('FORBIDDEN: this token cannot write to the project.');
        }
        const item = this.byKey(args.key);
        const { claim, apply } = resolveFakeClaim(item, { id: this.caller, name: 'Me' });
        this.claims.push({ key: args.key, ownerId: this.caller });
        this.claimOutcomes.push({ key: args.key, outcome: claim.outcome });
        if (apply) {
          // The row moves, but NOT through `transitionStatus` — the whole point
          // of MOTIR-3048 is that the dispatch flip happens inside this one
          // locked call, so `transitions` (which records wire transitions) must
          // stay empty for it or the tests could no longer tell the two apart.
          item.status = apply.status;
          item.assigneeId = apply.assigneeId;
        }
        return claim;
      },
      // The end-of-run READ-BACK (MOTIR-3197). Answers from the SERVER's own
      // row rather than from what the run observed, which is the whole point:
      // a test can move a card to `in_review` behind the run's back and the
      // summary has to report where it actually is.
      getWorkItem: async (key: string) => {
        if (this.readBackDown) throw new CliError('the server is unreachable');
        this.readBackCalls.push(key);
        if (this.readBackFails.has(key)) throw new CliError(`cannot read ${key}`);
        const item = this.byKey(key);
        return { item: { identifier: item.key, status: item.status } };
      },
      // The run links the pull request the agent opened (MOTIR-10877).
      linkPullRequest: async (args: { key: string; url?: string }) => {
        this.links.push(args);
      },
      transitionStatus: async (args: { key: string; status: string }) => {
        if (this.readOnly) {
          throw new CliError('FORBIDDEN: this token cannot write to the project.');
        }
        const refusal = this.refuseTransitionFor?.(args);
        if (refusal) {
          // Recorded as ATTEMPTED, then thrown — the run made the call and the
          // server said no, which is the state the test asserts about.
          this.transitions.push(args);
          throw refusal;
        }
        this.transitions.push(args);
        this.byKey(args.key).status = args.status;
        return {};
      },
      // The provenance report (MOTIR-2421) — recorded on its own, with no
      // branch. The fake keeps the whole argument object so a test can assert
      // what it did NOT contain.
      reportImplementation: async (args: Record<string, unknown>) => {
        this.provenance.push(args);
        return {};
      },
    };
    return fake as unknown as MotirClient;
  }
}

// ── harness ─────────────────────────────────────────────────────────────────

let root: string;
let configHome: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-batch-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), 'motir-batch-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = configHome;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(root, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function session(server: FakeServer): ProjectSession {
  return {
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    client: server.asClient(),
  };
}

/** The token owner every run below claims for (MOTIR-2427). */
const OWNER = 'user_me';

interface DriveOptions {
  opts?: BatchOptions;
  kinds?: string[];
  /** `model` defaults to null — an agent that self-reported nothing. */
  agentResults?: (
    key: string,
    index: number,
  ) => Omit<AgentRunResult, 'model'> & { model?: string | null };
  onDispatch?: (key: string, index: number) => void;
  /** The agent command the run launched — what the harness is derived FROM. */
  agentCommand?: string;
  /** The token owner this run claims for (MOTIR-2427). */
  ownerId?: string;
  /** The git runner the MOTIR-3004 push check asks; the default answers "the
   *  agent pushed". */
  git?: CommandRunner;
  /** The BETWEEN-ITERATION gate (MOTIR-3695) — MOTIR-3685 hangs the CI watch
   *  here. Absent in production, so absent by default. */
  afterCard?: (record: BatchRecord) => Promise<'continue' | 'stop'>;
  /** The run REPORTER (Story MOTIR-1789 · MOTIR-1794), when a test watches it. */
  reporter?: DispatchRunReporter;
}

async function drive(
  server: FakeServer,
  drives: DriveOptions = {},
): Promise<{ summary: BatchSummary; dispatched: string[] }> {
  const dispatched: string[] = [];
  let tick = 0;
  const input: BatchInput = {
    session: session(server),
    opts: drives.opts ?? {},
    kinds: drives.kinds,
    max: drives.opts?.max ? parseMax(drives.opts.max) : null,
    agent: {
      parsed: parseAgentCommand(drives.agentCommand ?? 'fake-agent')!,
      source: 'flag',
    },
    clock: () => (tick += 1000),
    runAgentFn: async ({ prompt }) => {
      const key = prompt.replace('PROMPT ', '');
      const index = dispatched.length;
      dispatched.push(key);
      drives.onDispatch?.(key, index);
      const result = drives.agentResults?.(key, index) ?? { exitCode: 0, signal: null };
      return { model: null, ...result };
    },
    ownerId: drives.ownerId ?? OWNER,
    // The MOTIR-3004 push check, scripted: `ls-remote --heads origin *<KEY>*`
    // answers with a ref unless a test says the agent pushed nothing.
    run:
      drives.git ??
      ((bin: string, args: string[]) =>
        // …and the pull request the agent opened, which the run links (MOTIR-10877).
        answerPrView(bin, args) ??
        (args[0] === 'ls-remote'
          ? { exitCode: 0, stdout: 'abc123\trefs/heads/subtask/pushed', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' })),
    ...(drives.afterCard ? { afterCard: drives.afterCard } : {}),
    ...(drives.reporter ? { reporter: drives.reporter } : {}),
  };
  const summary = await runBatch(input);
  return { summary, dispatched };
}

/** Everything the run wrote to stderr — the sink `info()` prints to. */
function printed(): string {
  const chunks: string[] = [];
  for (const call of stderrSpy.mock.calls) chunks.push(String(call[0]));
  return chunks.join('');
}

// ── the snapshot filter ─────────────────────────────────────────────────────

describe('classifySnapshotItem', () => {
  it('takes an ordinary coding leaf whose dependencies are all done on main', () => {
    expect(
      classifySnapshotItem({
        kind: 'subtask',
        type: 'code',
        executor: 'coding_agent',
        inheritedSessionBranch: null,
      }),
    ).toBe('take');
    expect(classifySnapshotItem({ kind: 'bug', type: null, executor: null })).toBe('take');
  });

  it('EXCLUDES an item that is ready only via an integrated dependency', () => {
    // The dependency's code is not on main, so a pull request of its own against
    // main could not build. That lineage belongs to `motir auto`.
    expect(
      classifySnapshotItem({
        kind: 'subtask',
        type: 'code',
        executor: 'coding_agent',
        inheritedSessionBranch: 'motir/auto-20260729-010203',
      }),
    ).toBe('integrated_dep');
  });

  it('defers the planning / human split to the shared 7.9.4 rule', () => {
    expect(classifySnapshotItem({ kind: 'story' })).toBe('needs_planning');
    expect(classifySnapshotItem({ kind: 'Epic' })).toBe('needs_planning');
    expect(classifySnapshotItem({ kind: 'subtask', type: 'manual' })).toBe('needs_human');
    expect(classifySnapshotItem({ kind: 'subtask', executor: 'human' })).toBe('needs_human');
    // A container reports as needing PLANNING even when it also inherits a
    // lineage — the more actionable answer of the two.
    expect(classifySnapshotItem({ kind: 'story', inheritedSessionBranch: 'motir/auto-x' })).toBe(
      'needs_planning',
    );
  });
});

describe('planSnapshot', () => {
  it('splits a ready page into the frozen list and the named exclusions', () => {
    const snapshot = planSnapshot([
      {
        key: 'PROD-1',
        kind: 'subtask',
        title: 'A',
        priority: 'medium',
        status: { key: 'todo', category: 'todo' },
        type: 'code',
        executor: 'coding_agent',
        assigneeId: null,
        inheritedSessionBranch: null,
      },
      {
        key: 'PROD-2',
        kind: 'subtask',
        title: 'B',
        priority: 'medium',
        status: { key: 'todo', category: 'todo' },
        type: 'code',
        executor: 'coding_agent',
        assigneeId: null,
        inheritedSessionBranch: 'motir/auto-x',
      },
    ]);
    expect(snapshot.taken.map((e) => e.key)).toEqual(['PROD-1']);
    expect(snapshot.taken[0]?.statusKey).toBe('todo');
    expect(snapshot.skipped).toEqual([{ key: 'PROD-2', title: 'B', reason: 'integrated_dep' }]);
  });
});

// ── the defining property: the list is FROZEN ───────────────────────────────

describe('motir batch — the frozen snapshot', () => {
  it('never dispatches an item that became ready DURING the run, and counts it', async () => {
    // PROD-2 depends on PROD-1. Finishing PROD-1 genuinely makes PROD-2 ready
    // (the fake models the real rule) — `motir auto` would follow it. `batch`
    // must not: PROD-2 was not in the snapshot.
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2', { deps: ['idA'] }),
    ]);
    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('completed');
    expect(summary.newlyReady).toEqual([{ key: 'PROD-2', title: 'Item PROD-2' }]);
    expect(server.byKey('PROD-2').status).toBe('todo');

    const text = renderBatchSummary(summary);
    expect(text).toContain('1 became ready during the run — NOT dispatched');
    expect(text).toContain('PROD-2');
    expect(text).toContain('or use `motir auto`');
  });

  it('prints the whole snapshot UP FRONT, before any agent starts', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const printedBeforeFirstAgent: string[] = [];
    await drive(server, {
      onDispatch: (_key, index) => {
        if (index !== 0) return;
        for (const call of stderrSpy.mock.calls) printedBeforeFirstAgent.push(String(call[0]));
      },
    });

    const upFront = printedBeforeFirstAgent.join('');
    expect(upFront).toContain('Snapshot: 2 work items');
    // BOTH items are named before the first one is touched — that is what lets a
    // human Ctrl-C out of a plan they did not want.
    expect(upFront).toContain('PROD-1');
    expect(upFront).toContain('PROD-2');
    expect(upFront).toContain('Items that become ready during the run are NOT picked up');
  });

  it('freezes the list with ONE enumeration, then never re-reads it to pick work', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server);
    // ONE read builds the snapshot (MOTIR-2398). It used to take N+1 — an ask
    // per item, each excluding the last answer — because the tool handed back
    // one row at a time. The collection returns the ranked set, so the
    // enumeration is a single call and the only other read is the
    // after-the-fact newly-ready count, which is reporting rather than picking.
    expect(server.nextReadyCalls).toHaveLength(2);
    expect(server.nextReadyCalls.every((c) => c.excluded === 0)).toBe(true);
  });

  it('passes --kinds through to the enumeration', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idS', 'PROD-5', { kind: 'bug' })]);
    const { dispatched } = await drive(server, { kinds: ['bug'] });
    expect(dispatched).toEqual(['PROD-5']);
    expect(server.nextReadyCalls.every((c) => c.kinds?.includes('bug'))).toBe(true);
  });
});

// ── per-item pull requests, and NO session branch ───────────────────────────

describe('motir batch — per-item pull requests', () => {
  it('gives every item its OWN pull request and never touches a session branch', async () => {
    // Two items in the SAME repo: two independent pull requests off origin/main,
    // not one shared branch.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.records.map((r) => r.outcome)).toEqual(['implemented', 'implemented']);
    // The prompt is requested with NO session-branch seed, so the server can only
    // answer with the per-item-PR workflow. (`markIntegrated` on the fake throws,
    // so calling it at all would fail this test.)
    expect(server.promptCalls).toEqual([
      { key: 'PROD-1', seeded: false },
      { key: 'PROD-2', seeded: false },
    ]);
    // Each item walks its own todo → in_progress → implemented lifecycle — the
    // first hop written by the CLAIM (MOTIR-3048), the second by this command.
    expect(server.claims.map((c) => c.key)).toEqual(['PROD-1', 'PROD-2']);
    expect(server.transitions).toEqual([
      { key: 'PROD-1', status: 'implemented' },
      { key: 'PROD-2', status: 'implemented' },
    ]);
    expect(batchExitCode(summary)).toBe(0);

    const text = renderBatchSummary(summary);
    expect(text).toContain('Implemented — each has its OWN pull request');
    expect(text).toContain('reviewable (2)');
    expect(text).toContain('motir done PROD-1');
    expect(text).toContain('motir done PROD-2');
  });

  it('refuses an item whose lineage APPEARED after the snapshot was frozen', async () => {
    // Both items are strictly main-ready, so both enter the snapshot. While
    // PROD-1 is running, a CONCURRENT `motir auto` claims and integrates PROD-2
    // onto a session branch. Running it now would integrate onto that branch —
    // exactly what batch guarantees it never does — so it is refused UNTOUCHED.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { dispatched, summary } = await drive(server, {
      onDispatch: (key) => {
        if (key !== 'PROD-1') return;
        const stolen = server.byKey('PROD-2');
        stolen.status = 'implemented';
        stolen.sessionBranch = 'motir/auto-20260729-010203';
      },
    });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.skipped).toContainEqual({
      key: 'PROD-2',
      title: 'Item PROD-2',
      reason: 'integrated_dep',
    });
    // Refused UNTOUCHED: batch made no transition of its own on PROD-2, so the
    // other session's state stands exactly as that session left it.
    expect(server.transitions.filter((t) => t.key === 'PROD-2')).toEqual([]);
    expect(renderBatchSummary(summary)).toContain('Run these with `motir auto`');
  });
});

// ── what the snapshot leaves out ────────────────────────────────────────────

/** A reporter that records what it was told, for the run-record assertions. */
function recordingReporter(over: Partial<DispatchRunReporter> = {}): DispatchRunReporter & {
  opens: OpenDispatchRunInput[];
  events: DispatchRunEventInput[];
  closed: string[];
} {
  const opens: OpenDispatchRunInput[] = [];
  const events: DispatchRunEventInput[] = [];
  const closed: string[] = [];
  return {
    opens,
    events,
    closed,
    async open(input) {
      opens.push(input);
    },
    adopt() {},
    async addCard() {},
    event(e) {
      events.push(e);
    },
    async flush() {},
    async close(reason) {
      closed.push(reason);
    },
    offline: false,
    wantsLogBodies: false,
    runId: 'run_1',
    ...over,
  };
}

describe('the RUN RECORD (Story MOTIR-1789 · MOTIR-1794)', () => {
  it('opens with the FROZEN SNAPSHOT — taken in dispatch order AND every skip with its reason', async () => {
    const server = new FakeServer([
      { ...leaf('idS', 'PROD-5'), kind: 'story', type: null, executor: null },
      leaf('idH', 'PROD-6', { type: 'manual' }),
      leaf('idA', 'PROD-9'),
      leaf('idB', 'PROD-10'),
    ]);
    const reporter = recordingReporter();

    const { summary } = await drive(server, { reporter });

    expect(reporter.opens).toHaveLength(1);
    const open = reporter.opens[0]!;
    expect(open.command).toBe('batch');
    // ⚠️ BOTH HALVES, and the SKIPS are the half that matters. Nothing that
    // happens later could reconstruct them, because nothing happens to a card
    // that was never dispatched — so if they do not ride the open they are gone.
    expect(open.cards).toEqual([
      { key: 'PROD-9', disposition: 'queued' },
      { key: 'PROD-10', disposition: 'queued' },
      { key: 'PROD-5', disposition: 'skipped', skipReason: 'needs_planning' },
      { key: 'PROD-6', disposition: 'skipped', skipReason: 'needs_human' },
    ]);
    // The set the reporter was given IS the snapshot the summary renders — not a
    // second enumeration that could disagree with it.
    expect(open.cards.filter((c) => c.disposition === 'skipped').map((c) => c.key)).toEqual(
      summary.skipped.map((sk) => sk.key),
    );
    expect(reporter.events.find((e) => e.kind === 'snapshot_frozen')?.data).toEqual({
      taken: 2,
      skipped: 2,
    });
    expect(reporter.closed).toEqual(['completed']);
  });

  it('carries a run id of the SAME shape every other path uses', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-9')]);
    const reporter = recordingReporter();
    await drive(server, { reporter });

    // `runIdFromDate`'s shape — `YYYYMMDD-HHMMSS`. `batch` is the one path with
    // no session branch to derive an id from, so it mints one through the SAME
    // function rather than inventing a second identity scheme.
    expect(reporter.opens[0]?.runId).toMatch(/^\d{8}-\d{6}$/);
  });

  it('reports the STOP REASON the drain actually ended with', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-9'), leaf('idB', 'PROD-10')]);
    const reporter = recordingReporter();

    await drive(server, {
      reporter,
      opts: { max: '1' },
    });

    expect(reporter.closed).toEqual(['max']);
  });

  it('completes the whole drain with the reporting API returning 500', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-9'), leaf('idB', 'PROD-10')]);
    const failing = (): never => {
      throw new Error('500 Internal Server Error');
    };
    const warnings: string[] = [];

    // ⚠️ THE REAL REPORTER, over a FAILING API — which is the failure the
    // acceptance criterion names, and the one an operator actually meets. The
    // guarantee lives in ONE place by construction (`createDispatchRunReporter`
    // swallows every failure), and this asserts it END TO END: the agent still
    // ran, the cards still moved, the summary is unchanged, and the process
    // learned about it in one line.
    const { summary, dispatched } = await drive(server, {
      reporter: createDispatchRunReporter({
        client: {
          openDispatchRun: failing,
          appendDispatchRunEvents: failing,
          closeDispatchRun: failing,
        },
        warn: (m) => warnings.push(m),
      }),
    });

    expect(dispatched).toEqual(['PROD-9', 'PROD-10']);
    expect(summary.records.map((r) => r.outcome)).toEqual(['implemented', 'implemented']);
    expect(summary.stopReason).toBe('completed');
    expect(server.transitions.map((t) => t.status)).toContain('implemented');
    // One line, once — not one per event across a two-card drain.
    expect(warnings).toHaveLength(1);
  });

  it('completes the whole drain with the server UNREACHABLE', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-9')]);
    const unreachable = (): never => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:3000');
      (err as { code?: string }).code = 'ECONNREFUSED';
      throw err;
    };

    const { summary, dispatched } = await drive(server, {
      reporter: createDispatchRunReporter({
        client: {
          openDispatchRun: unreachable,
          appendDispatchRunEvents: unreachable,
          closeDispatchRun: unreachable,
        },
        warn: () => {},
      }),
    });

    // An OFFLINE machine is a first-class state, not an error: the run is the
    // user's actual work and the record is an observation of it.
    expect(dispatched).toEqual(['PROD-9']);
    expect(summary.records.map((r) => r.outcome)).toEqual(['implemented']);
  });
});

describe('motir batch — exclusions', () => {
  it('excludes an integrated-dep item and an unexpanded story, and names both', async () => {
    const server = new FakeServer([
      { ...leaf('idS', 'PROD-5'), kind: 'story', type: null, executor: null },
      leaf('idH', 'PROD-6', { type: 'manual' }),
      // PROD-8's dependency is integrated on a session branch but NOT on main.
      leaf('idDep', 'PROD-7', {
        status: 'implemented',
        sessionBranch: 'motir/auto-20260729-010203',
      }),
      leaf('idL', 'PROD-8', { deps: ['idDep'] }),
      leaf('idA', 'PROD-9'),
    ]);
    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-9']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-5', title: 'Item PROD-5', reason: 'needs_planning' },
      { key: 'PROD-6', title: 'Item PROD-6', reason: 'needs_human' },
      { key: 'PROD-8', title: 'Item PROD-8', reason: 'integrated_dep' },
    ]);
    // Excluded means UNTOUCHED — not claimed, no status flip, no prompt fetched.
    expect(server.claims.map((c) => c.key)).toEqual(['PROD-9']);
    expect(server.transitions.map((t) => t.key)).toEqual(['PROD-9']);
    expect(server.promptCalls.map((c) => c.key)).toEqual(['PROD-9']);

    const text = renderBatchSummary(summary);
    expect(text).toContain('Not in the snapshot — needs planning (1)');
    expect(text).toContain("Not in the snapshot — waiting on you in Motir's Waiting on you (1)");
    expect(text).not.toContain('needs a human');
    expect(text).toContain(
      'Not in the snapshot — ready only via an integrated dependency (not on main) (1)',
    );
  });

  it("the CONTAINER gate's 422 is a named outcome, and the batch keeps going (MOTIR-3268)", async () => {
    // ⚠️ `motir batch` takes an explicit LIST of keys, so a container — a `task`
    // or `bug` with children of its own — genuinely reaches the per-item
    // transition. An unhandled throw there ends the whole batch on one card's
    // status, abandoning the close-out of everything already built. It is a
    // record, not a crash, and the SECOND card still runs.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    server.refuseTransitionFor = ({ key, status }) =>
      key === 'PROD-1' && status === 'implemented'
        ? new ContainerHasOpenChildrenError(
            'This item cannot reach "implemented" while 1 of its children has not been ' +
              'implemented: PROD-77.',
          )
        : null;

    const { summary, dispatched } = await drive(server, { opts: { keepGoing: true } });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    const first = summary.records.find((r) => r.key === 'PROD-1');
    expect(first?.outcome).toBe('failed');
    expect(first?.detail).toBe('container has open children');
    // The card honestly stays where the server left it — nothing was reverted.
    expect(server.byKey('PROD-1').status).toBe('in_progress');
    // The server's own sentence reaches the operator, naming the open child.
    expect(printed()).toContain('PROD-77');
    // And the refusal did not cost the second card its run.
    expect(summary.records.find((r) => r.key === 'PROD-2')?.outcome).toBe('implemented');
  });

  it('a read-only PAT cannot dispatch: the write fails and no agent is launched', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    server.readOnly = true;
    const dispatched: string[] = [];

    await expect(
      runBatch({
        session: session(server),
        opts: {},
        kinds: undefined,
        max: null,
        agent: {
          parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] },
          source: 'flag',
        },
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          dispatched.push(prompt);
          return { exitCode: 0, signal: null, model: null };
        },
        ownerId: OWNER,
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    // The snapshot READ succeeded (a read-only token can read), the first WRITE
    // did not, and the agent never ran — nothing was mutated.
    expect(dispatched).toEqual([]);
    expect(server.transitions).toEqual([]);
    expect(server.byKey('PROD-1').status).toBe('todo');
  });
});

// ── the persisted exclude list ──────────────────────────────────────────────

describe('motir batch — previously-failed items', () => {
  it('holds a persisted exclude OUT of the snapshot and says how many', async () => {
    // An item a previous run's agent failed on is excluded at ENUMERATION time,
    // so it is not merely skipped later — it never enters the frozen list, and
    // so can never be counted as "newly ready" either.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-1' });

    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-2']);
    expect(summary.newlyReady).toEqual([]);
    expect(printed()).toContain('Skipping 1 previously-failed item(s) — `--reset` retries them.');
  });

  it('--reset clears the list first, counting it in singular and plural', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-90' });
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-91' });

    await drive(server, { opts: { reset: true } });
    expect(printed()).toContain('Cleared 2 excluded items.');
    expect(readExcludes('https://app.motir.co', 'PROD')).toEqual([]);

    // …and again with exactly one held back, so the singular arm is real copy
    // rather than a plural with an `s` a reader has to forgive.
    stderrSpy.mockClear();
    server.byKey('PROD-1').status = 'todo';
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-92' });
    await drive(server, { opts: { reset: true } });
    expect(printed()).toContain('Cleared 1 excluded item.');
  });

  it('records a failure in the exclude list and drops it again on a later success', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    await drive(server, { agentResults: () => ({ exitCode: 4, signal: null }) });
    expect(readExcludes('https://app.motir.co', 'PROD').map((e) => e.key)).toEqual(['PROD-1']);

    // The re-run has to be told to retry it, which is what `--reset` is for.
    server.byKey('PROD-1').status = 'todo';
    await drive(server, { opts: { reset: true } });
    expect(readExcludes('https://app.motir.co', 'PROD')).toEqual([]);
  });

  it('PUSHED but linked to nothing is a failure naming the branch — never Implemented (MOTIR-10877)', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { summary } = await drive(server, {
      opts: { keepGoing: true },
      // The agent pushed; `gh` finds no pull request for any branch.
      git: (bin, args) =>
        bin === 'gh'
          ? { exitCode: 1, stdout: '', stderr: 'no pull requests found' }
          : args[0] === 'ls-remote'
            ? { exitCode: 0, stdout: 'abc123\trefs/heads/subtask/pushed', stderr: '' }
            : { exitCode: 0, stdout: '', stderr: '' },
    });

    expect(summary.records.map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(summary.records[0]?.detail).toBe('no pull request linked: subtask/pushed');
    expect(server.transitions.filter((t) => t.status === 'implemented')).toEqual([]);
    expect(server.links).toEqual([]);
    expect(printed()).toContain('PROD-1: the work is pushed, but no pull request could be linked');
  });
});

// ── the enumeration terminates, whatever the server does ────────────────────

describe('motir batch — the enumeration', () => {
  // ⚠️ The old guard here is GONE with the mechanism it guarded (MOTIR-2398).
  // `enumerateReady` used to advance by excluding each answer from the next
  // question, so a server that ignored the exclusions answered with the same
  // row forever and the command span until killed; stopping on a repeat was the
  // cheap defence. The collection returns the whole ranked set in one read, so
  // there is no loop to run away — termination is a property of the client's
  // page walk now, asserted in `clientCore.test.ts` where the paging lives.
  it('takes the whole ready set in one read, in the server’s rank', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);

    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('completed');
    expect(printed()).toContain('Snapshot: 2 work items');
  });
});

// ── shared loop mechanics (7.9.4) ───────────────────────────────────────────

describe('motir batch — failure policy and caps', () => {
  const three = (): FakeServer =>
    new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2'), leaf('idC', 'PROD-3')]);

  it('halts on the first agent failure by default, naming what it never reached', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, {
      agentResults: (key) =>
        key === 'PROD-2' ? { exitCode: 3, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('halted');
    // The failed item is left In Progress — nothing reverted.
    expect(server.byKey('PROD-2').status).toBe('in_progress');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-3']);
    expect(batchExitCode(summary)).toBe(1);

    const text = renderBatchSummary(summary);
    expect(text).toContain('motir run PROD-2');
    expect(text).toContain('Not reached — still in the snapshot, never started (1)');
  });

  it('--keep-going finishes the rest of the snapshot and never re-dispatches the failure', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, {
      opts: { keepGoing: true },
      agentResults: (key) =>
        key === 'PROD-1' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    expect(dispatched.filter((k) => k === 'PROD-1')).toHaveLength(1);
    expect(summary.stopReason).toBe('completed');
    expect(summary.records.filter((r) => r.outcome === 'failed').map((r) => r.key)).toEqual([
      'PROD-1',
    ]);
    expect(summary.notReached).toEqual([]);
    expect(batchExitCode(summary)).toBe(1);
  });

  it('honours --max and leaves the remainder of the snapshot named', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, { opts: { max: '1' } });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('max');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    expect(renderBatchSummary(summary)).toContain('Re-run `motir batch`');
  });

  it('a Ctrl-C between items exits cleanly with the summary so far', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, {
      onDispatch: (_key, index) => {
        if (index === 0) process.emit('SIGINT');
      },
    });

    // The in-flight item completes; the run stops before starting another.
    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('interrupted');
    expect(server.byKey('PROD-1').status).toBe('implemented');
    expect(server.byKey('PROD-2').status).toBe('todo');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    expect(batchExitCode(summary)).toBe(130);
  });

  it('reports an interrupt that arrives DURING a failing agent as interrupted, not halted', async () => {
    // Both stop conditions fire on the same item: the agent failed (which halts
    // without --keep-going) and a Ctrl-C landed while it ran. The interrupt is
    // the more truthful reason — the human stopped the run, and saying "halted
    // on the first agent failure (--keep-going continues past one)" would offer
    // a flag that would not have changed anything.
    const server = three();
    const { dispatched, summary } = await drive(server, {
      onDispatch: (key) => {
        if (key === 'PROD-1') process.emit('SIGINT');
      },
      agentResults: () => ({ exitCode: 2, signal: null }),
    });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('interrupted');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    // A failure outranks the interrupt in the EXIT CODE — something needs fixing.
    expect(batchExitCode(summary)).toBe(1);
    expect(renderBatchSummary(summary)).toContain('interrupted (Ctrl-C)');
  });

  it('a SECOND Ctrl-C exits immediately instead of finishing the item in flight', async () => {
    const server = three();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await drive(server, {
        onDispatch: (_key, index) => {
          if (index !== 0) return;
          process.emit('SIGINT');
          process.emit('SIGINT');
        },
      });
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      exitSpy.mockRestore();
    }
    // The first interrupt still printed the "press again" contract it offered.
    expect(printed()).toContain('Press Ctrl-C again to exit immediately.');
  });
});

// ── how one item can end ────────────────────────────────────────────────────

describe('motir batch — a single item’s outcomes', () => {
  it('reports an agent killed by a SIGNAL with the signal, not a bare exit code', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const { summary } = await drive(server, {
      agentResults: () => ({ exitCode: 1, signal: 'SIGKILL' }),
    });

    expect(summary.records).toEqual([
      expect.objectContaining({ key: 'PROD-1', outcome: 'failed', detail: 'killed by SIGKILL' }),
    ]);
    expect(renderBatchSummary(summary)).toContain('FAILED (killed by SIGKILL)');
    // Killed is still failed: In Progress, nothing reverted.
    expect(server.byKey('PROD-1').status).toBe('in_progress');
  });

  it('counts a bootstrap dispatch that never produced its checkout as FAILED', async () => {
    // `motir-ai` has no checkout under the root, so the item routes to the
    // workspace root for the prompt to CREATE it. The agent exits 0 without
    // creating anything — the dispatch did not do its job, so a clean exit code
    // must not be read as success, and the item must not go to In Review.
    const server = new FakeServer([leaf('idA', 'PROD-1', { targetRepo: 'motir-ai' })]);
    const { summary } = await drive(server);

    expect(summary.records).toEqual([
      expect.objectContaining({
        key: 'PROD-1',
        outcome: 'failed',
        detail: 'bootstrap checkout missing',
        repo: 'motir-ai',
      }),
    ]);
    // Claimed — that is what left it In Progress — and nothing moved it after:
    // a failed dispatch earns no `implemented`.
    expect(server.claims.map((c) => c.key)).toEqual(['PROD-1']);
    expect(server.transitions).toEqual([]);
    expect(printed()).toContain('still has no checkout');
    expect(printed()).toContain('motir link add motir-ai');
  });

  // ── implementation provenance (MOTIR-2421) ────────────────────────────────
  // Every card `motir batch` ever ran carried a null triple, because the only
  // write that recorded one also asserted a session branch — and batch has
  // none. Recording it is now its own call.

  it('records WHAT BUILT each item — with no branch anywhere in the call', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server, {
      agentCommand: 'claude --dangerously-skip-permissions',
      agentResults: () => ({ exitCode: 0, signal: null, model: 'claude-opus-5' }),
    });

    expect(server.provenance).toEqual([
      {
        key: 'PROD-1',
        implementationSource: 'byok',
        implementationHarness: 'claude',
        implementationModel: 'claude-opus-5',
      },
      {
        key: 'PROD-2',
        implementationSource: 'byok',
        implementationHarness: 'claude',
        implementationModel: 'claude-opus-5',
      },
    ]);
    // ⚠️ The assertion that catches the dangerous fix. `toEqual` above already
    // fails on an extra key; naming it keeps the reason attached — a branch sent
    // from here would make the item stop blocking its dependents with nothing
    // merged. `markIntegrated` on this fake throws for the same reason.
    for (const call of server.provenance) expect(call).not.toHaveProperty('sessionBranch');
  });

  it('leaves the model NULL when the agent reported none, and still names the agent', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    await drive(server, { agentCommand: 'codex exec' });

    expect(server.provenance).toEqual([
      {
        key: 'PROD-1',
        implementationSource: 'byok',
        implementationHarness: 'codex',
        // Null, never defaulted: the harness is derivable and stays truthful,
        // the model is not and stays empty. The client omits it from the wire.
        implementationModel: null,
      },
    ]);
  });

  it('records provenance only for an item that actually reached In Review', async () => {
    // A failed agent leaves the item In Progress and nothing reverted — there is
    // no work to attribute, and claiming an agent built it would be a lie about
    // a card nobody finished.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server, {
      opts: { keepGoing: true },
      agentCommand: 'claude',
      agentResults: (key) =>
        key === 'PROD-1' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
    });

    expect(server.provenance.map((c) => c['key'])).toEqual(['PROD-2']);
  });

  // ── the CLAIM and the pickable snapshot (MOTIR-2427) ──────────────────────

  it('CLAIMS every card it takes, for the token owner', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server);

    expect(server.claims).toEqual([
      { key: 'PROD-1', ownerId: OWNER },
      { key: 'PROD-2', ownerId: OWNER },
    ]);
  });

  it('a teammate’s card never ENTERS the snapshot — not skipped later', async () => {
    // The snapshot is the frozen boundary a human reads before the first agent
    // starts, so a card listed there and skipped afterwards would have been
    // announced as work about to happen. Narrowing at enumeration is the
    // difference between "not shown" and "shown, then not done".
    const server = new FakeServer([
      leaf('idA', 'PROD-1', { assigneeId: 'user_them' }),
      leaf('idB', 'PROD-2'),
    ]);
    const { summary, dispatched } = await drive(server);

    expect(dispatched).toEqual(['PROD-2']);
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-2']);
    // Not in the SKIPPED list either — it was never this run's to consider, so
    // it is absent from the plan a human reads rather than listed-and-excused.
    expect(summary.skipped.map((sk) => sk.key)).not.toContain('PROD-1');
    expect(summary.notReached.map((e) => e.key)).not.toContain('PROD-1');
    expect(printed()).not.toContain('PROD-1');
  });

  it('narrows the enumeration by the owner, and asks whoami’s answer once', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    await drive(server);
    expect(server.ownerIdsAsked[0]).toBe(OWNER);
  });

  it('takes a card ALREADY assigned to me', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1', { assigneeId: OWNER })]);
    const { dispatched } = await drive(server);
    expect(dispatched).toEqual(['PROD-1']);
  });

  // MOTIR-3048 — the snapshot narrows at ENUMERATION, and that is a MEASUREMENT
  // with a timestamp rather than a property that holds for the whole drain. A
  // card can be taken by a sibling in the minutes between the freeze and its
  // turn, and the atomic claim is the only thing that can find that out.
  it('a card a SIBLING took mid-drain is a SKIP, not an agent failure', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { summary, dispatched } = await drive(server, {
      // While PROD-1's agent works, somebody else starts PROD-2.
      onDispatch: (key) => {
        if (key !== 'PROD-1') return;
        const stolen = server.byKey('PROD-2');
        stolen.status = 'in_progress';
        stolen.assigneeId = 'user_them';
      },
    });

    expect(dispatched).toEqual(['PROD-1']);
    expect(server.claimOutcomes).toEqual([
      { key: 'PROD-1', outcome: 'claimed' },
      { key: 'PROD-2', outcome: 'taken' },
    ]);
    expect(summary.skipped).toContainEqual({
      key: 'PROD-2',
      title: 'Item PROD-2',
      reason: 'claim_refused',
    });
    // NOT a record, therefore not a failure — and the drain carried on rather
    // than halting, because nothing went wrong.
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-1']);
    expect(batchExitCode(summary)).toBe(0);
    expect(printed()).toContain('PROD-2: already claimed by user_them');
  });

  it('a refused claim leaves the card UNTOUCHED and does not halt the drain', async () => {
    // Three items, the middle one taken. The refusal is not a failure, so
    // `--keep-going` is not needed for the run to reach the third.
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2'),
      leaf('idC', 'PROD-3'),
    ]);
    const { summary, dispatched } = await drive(server, {
      onDispatch: (key) => {
        if (key !== 'PROD-1') return;
        server.byKey('PROD-2').status = 'done';
      },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-3']);
    expect(summary.stopReason).toBe('completed');
    expect(summary.skipped).toContainEqual({
      key: 'PROD-2',
      title: 'Item PROD-2',
      reason: 'claim_refused',
    });
    // Nothing was written for it: no transition, and the row is where the
    // sibling left it.
    expect(server.transitions.map((t) => t.key)).not.toContain('PROD-2');
    expect(server.byKey('PROD-2').status).toBe('done');
    expect(batchExitCode(summary)).toBe(0);
    expect(printed()).toContain('PROD-2: not claimable');
  });

  it('names the refusal readably when the server reports lineage without a branch name', async () => {
    // `sessionBranch` is nullable on the dispatch payload, so the refusal cannot
    // assume a name to print. It must still say what happened rather than
    // interpolating `null` into the sentence.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    server.unnamedLineage.add('PROD-1');

    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toContainEqual({
      key: 'PROD-1',
      title: 'Item PROD-1',
      reason: 'integrated_dep',
    });
    expect(printed()).toContain(
      'PROD-1: skipped — a dependency was integrated on a session branch after the snapshot was taken.',
    );
    // Refused UNTOUCHED — the refusal precedes the CLAIM, so the card was never
    // taken and never moved (MOTIR-3048).
    expect(server.claims.map((c) => c.key)).toEqual(['PROD-2']);
    expect(server.transitions.map((t) => t.key)).toEqual(['PROD-2']);
  });
});

// ── rendering ───────────────────────────────────────────────────────────────

describe('motir batch — the end-of-run reconcile (MOTIR-3197)', () => {
  // The run's own records say what THIS PROCESS observed when each agent
  // exited. Since MOTIR-2999 that is no longer where a card ends up: CI moves
  // it to In Review server-side, minutes later. So the summary has to READ
  // BACK, and every assertion here is about the gap between those two answers.

  it('reads every dispatched card back and reports the SERVER’s status, not the run’s outcome', async () => {
    const server = new FakeServer([leaf('i1', 'PROD-1'), leaf('i2', 'PROD-2')]);
    // CI went green for PROD-1 while the run was still going — behind the run's
    // back, exactly as the real webhook does. Both cards are `implemented` from
    // the run's point of view; only a real read can tell them apart.
    const { summary } = await drive(server, {
      onDispatch: (key) => {
        if (key === 'PROD-2') server.byKey('PROD-1').status = 'in_review';
      },
    });

    expect(summary.records.map((r) => r.outcome)).toEqual(['implemented', 'implemented']);
    // The LAST two reads are the reconcile's, in dispatch order. (The drain
    // itself reads a card before dispatching it, so the array is not
    // reconcile-only — asserting the tail is what makes this about the
    // read-back rather than about the drain.)
    expect(server.readBackCalls.slice(-2)).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.reconcile?.cards).toEqual([
      { key: 'PROD-1', status: 'in_review' },
      { key: 'PROD-2', status: 'implemented' },
    ]);

    const out = renderBatchSummary(summary as BatchSummary);
    expect(out).toContain('In Review — CI went green while the run was still going (1)');
    expect(out).toContain('Implemented — the pull request is open and CI has not spoken yet (1)');
    // ⚠️ The sentence is the deliverable, not the status word: `implemented`
    // beside a successful run reads as a failure without it.
    expect(out).toContain('each moves to In Review on its own when its checks pass');
  });

  it('names a card that is somewhere ELSE with the status actually read', async () => {
    // A failed agent leaves its card In Progress. This is the only group that
    // needs a person, and it is labelled with the server's own word.
    const server = new FakeServer([leaf('i1', 'PROD-1')]);
    const { summary } = await drive(server, {
      opts: { keepGoing: true },
      agentResults: () => ({ exitCode: 3, signal: null }),
    });

    expect(summary.records[0]?.outcome).toBe('failed');
    expect(summary.reconcile?.cards).toEqual([{ key: 'PROD-1', status: 'in_progress' }]);
    const out = renderBatchSummary(summary as BatchSummary);
    expect(out).toContain('Somewhere else — these need a person (1)');
    expect(out).toContain('PROD-1 — read back as `in_progress`');
  });

  it('shows a card whose read FAILED as unread with the reason — never dropped, never assumed', async () => {
    const server = new FakeServer([leaf('i1', 'PROD-1'), leaf('i2', 'PROD-2')]);
    server.readBackFails.add('PROD-2');

    const { summary } = await drive(server);

    expect(summary.reconcile?.cards).toEqual([
      { key: 'PROD-1', status: 'implemented' },
      { key: 'PROD-2', status: null, detail: 'cannot read PROD-2' },
    ]);
    const out = renderBatchSummary(summary as BatchSummary);
    expect(out).toContain('Could not be read back (1) — status unknown, NOT assumed:');
    expect(out).toContain('PROD-2 — cannot read PROD-2');
    // ⚠️ NOT quietly folded into Implemented, which is the failure mode that
    // makes the whole block untrustworthy: one guess indistinguishable from a
    // row of facts.
    expect(out).toContain('Implemented — the pull request is open and CI has not spoken yet (1)');
    expect(summary.reconcile?.cards.filter((c) => c.status === 'implemented')).toHaveLength(1);
  });

  it('a reconcile that fails ENTIRELY says so ONCE and leaves the exit code untouched', async () => {
    // Every card unreadable is a different fact from one card unreadable: the
    // server is gone. Printing it per card would bury one fact under a list.
    const server = new FakeServer([leaf('i1', 'PROD-1'), leaf('i2', 'PROD-2')]);
    const { summary } = await drive(server, {
      onDispatch: (key) => {
        if (key === 'PROD-2') server.readBackDown = true;
      },
    });

    expect(summary.reconcile).toEqual({ cards: [], unavailable: 'the server is unreachable' });
    const out = renderBatchSummary(summary as BatchSummary);
    expect(out).toContain('Where the dispatched items ended up: COULD NOT BE READ.');
    expect(out).toContain('the server is unreachable');
    // The run succeeded. A reporting read that could not run must not change
    // that — the read-back is an observation, never a gate.
    expect(batchExitCode(summary as BatchSummary)).toBe(0);
  });

  it('does not change the exit code: a card sitting at Implemented is a NORMAL outcome', async () => {
    const server = new FakeServer([leaf('i1', 'PROD-1')]);
    const { summary } = await drive(server);

    expect(summary.reconcile?.cards).toEqual([{ key: 'PROD-1', status: 'implemented' }]);
    expect(batchExitCode(summary as BatchSummary)).toBe(0);
  });

  it('renders NO reconcile block at all when the run dispatched nothing', async () => {
    // An empty block reads as a finding. There is nothing to reconcile, so
    // there is nothing to print — and `reconcile` is absent rather than `{
    // cards: [] }`, which would be indistinguishable from a total failure that
    // forgot its reason.
    const server = new FakeServer([
      leaf('i1', 'PROD-1', { kind: 'story', type: null, executor: null }),
    ]);
    const { summary, dispatched } = await drive(server);

    expect(dispatched).toEqual([]);
    expect(summary.reconcile).toBeUndefined();
    expect(server.readBackCalls).toEqual([]);
    expect(renderBatchSummary(summary as BatchSummary)).not.toContain('read back');
  });
});

describe('the snapshot plan block', () => {
  it('says plainly when there is nothing to implement', () => {
    expect(renderSnapshotPlan({ taken: [], skipped: [] })).toContain(
      'Snapshot: no work items to implement.',
    );
  });

  it('tables the taken items and groups the exclusions by reason', () => {
    const text = renderSnapshotPlan({
      taken: [
        {
          key: 'PROD-1',
          title: 'Add the thing',
          kind: 'subtask',
        },
      ],
      skipped: [{ key: 'PROD-2', title: 'A story', reason: 'needs_planning' }],
    });
    expect(text).toContain('Snapshot: 1 work item');
    expect(text).toContain('PROD-1');
    // ⚠️ No repo column (MOTIR-2398). The snapshot freezes WHICH items; where
    // each ships is assembled per iteration from the dispatch prompt, and
    // `dispatchOne` prints the resolved checkout on its own line there.
    expect(text).not.toContain('REPO');
    expect(text).toContain('Not in the snapshot — needs planning (1)');
  });

  it('renders an absent title as a placeholder, never "null"', () => {
    // `title` is nullable on a work item, and this table is the first thing a
    // human reads before deciding to let the run proceed.
    const text = renderSnapshotPlan({
      taken: [{ key: 'PROD-1', title: null, kind: 'subtask' }],
      skipped: [{ key: 'PROD-2', title: null, reason: 'needs_human' }],
    });
    expect(text).toContain('—');
    expect(text).toContain("Not in the snapshot — waiting on you in Motir's Waiting on you (1)");
    expect(text).not.toContain('null');
  });

  it("names the person a manual card waits on when it is not the run's starter (MOTIR-7477)", () => {
    const text = renderSnapshotPlan({
      taken: [],
      skipped: [
        { key: 'PROD-2', title: 'Order badges', reason: 'needs_human' },
        { key: 'PROD-3', title: 'Add DNS', reason: 'needs_human', waitingOn: 'Mara S.' },
      ],
    });
    expect(text).toContain("Not in the snapshot — waiting on you in Motir's Waiting on you (1)");
    expect(text).toContain('Not in the snapshot — waiting on someone else in Motir (1)');
    expect(text).toContain('PROD-3 — Add DNS (waiting on Mara S.)');
    expect(text).not.toContain('needs a human');
  });
});

describe('the end-of-run summary block', () => {
  const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
    records: [],
    skipped: [],
    notReached: [],
    newlyReady: [],
    stopReason: 'completed',
    ...over,
  });

  it('says plainly when nothing was dispatched', () => {
    const text = renderBatchSummary(summary());
    expect(text).toContain('Batch finished — stopped: the whole snapshot was attempted.');
    expect(text).toContain('No work items were dispatched.');
    // Nothing is In Review, so the merge-these block is absent rather than empty.
    expect(text).not.toContain('OWN pull request to merge');
  });

  it('tables a run where everything FAILED, with no In Review block', () => {
    const text = renderBatchSummary(
      summary({
        records: [{ key: 'PROD-1', title: null, outcome: 'failed', durationMs: 1000, repo: null }],
        stopReason: 'halted',
      }),
    );
    expect(text).toContain('halted on the first agent failure');
    expect(text).toContain('Failed — still In Progress, nothing reverted (1)');
    expect(text).toContain('motir run PROD-1');
    expect(text).not.toContain('OWN pull request to merge');
    expect(text).not.toContain('null');
  });

  it('names a not-reached and a newly-ready item that carry no title', () => {
    const text = renderBatchSummary(
      summary({
        notReached: [{ key: 'PROD-2', title: null, kind: 'subtask' }],
        newlyReady: [{ key: 'PROD-3', title: null }],
        stopReason: 'max',
      }),
    );
    expect(text).toContain('--max reached');
    expect(text).toContain('Not reached — still in the snapshot, never started (1)');
    expect(text).toContain('PROD-2');
    expect(text).toContain('1 became ready during the run — NOT dispatched');
    expect(text).toContain('PROD-3');
    expect(text).not.toContain('null');
  });
});

// ── THE BETWEEN-ITERATION SEAM (Story MOTIR-3655 · MOTIR-3695) ───────────────
//
// It exists so MOTIR-3685 can put a CI gate between cards: `motir batch` must
// not start the next card while the one it just finished is red, which is what
// makes batch different from `motir auto` (whose pull requests are for every
// card at once). Asserted here, empty, because a seam that is only proven when
// its first consumer arrives is a seam whose shape was never checked.

describe('the between-iteration seam', () => {
  it('runs after EVERY card the drain finishes, in order, with that card’s record', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const seen: string[] = [];

    const { summary } = await drive(server, {
      afterCard: async (record) => {
        seen.push(`${record.key}:${record.outcome}`);
        return 'continue';
      },
    });

    expect(seen).toEqual(['PROD-1:implemented', 'PROD-2:implemented']);
    expect(summary.records).toHaveLength(2);
    expect(summary.stopReason).toBe('completed');
  });

  it('STOPS the drain when it says so, and the untouched cards land in notReached', async () => {
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2'),
      leaf('idC', 'PROD-3'),
    ]);

    const { summary, dispatched } = await drive(server, {
      afterCard: async (record) => (record.key === 'PROD-1' ? 'stop' : 'continue'),
    });

    // The card that ran is recorded in full; the next one was never dispatched.
    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-1']);
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    // Its OWN reason, not `halted`: nothing failed, and the remaining cards are
    // untouched and still ready. An operator reading `halted` would go looking
    // for a broken agent.
    expect(summary.stopReason).toBe('gated');
  });

  it('runs AFTER the exclude bookkeeping, so a stop leaves the card exactly as it would have been', async () => {
    // The gate must be able to stop a run without changing what the finished
    // card recorded — otherwise MOTIR-3685's red-CI stop would also corrupt the
    // report of the card whose CI is red.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);

    const { summary } = await drive(server, {
      agentResults: (key) =>
        key === 'PROD-1' ? { exitCode: 3, signal: null } : { exitCode: 0, signal: null },
      opts: { keepGoing: true },
      afterCard: async () => 'stop',
    });

    const first = summary.records[0];
    expect(first?.outcome).toBe('failed');
    // The failing card was excluded exactly as it is without a gate — the stop
    // did not roll that back, and did not skip it either.
    expect(readExcludes('https://app.motir.co', 'PROD').map((e) => e.key)).toContain('PROD-1');
    expect(summary.stopReason).toBe('gated');
  });

  it('is ABSENT by default — the drain runs exactly as it did', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);

    const { summary, dispatched } = await drive(server);

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('completed');
  });
});
