import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeOutRepos,
  parseMax,
  runAutoLoop,
  type AutoOptions,
  type LoopInput,
} from '../src/commands/auto.js';
import {
  autoExitCode,
  classifyReadyItem,
  formatDuration,
  landedWork,
  manualWaitingOn,
  planReviewUrl,
  renderAutoSummary,
  renderSessionPrBody,
  sessionPrTitle,
  type AutoSummary,
  type DispatchRecord,
} from '../src/autoLoop.js';
import { runIdFromDate, sessionBranchName, type CommandResult } from '../src/git.js';
import { CliError, ContainerHasOpenChildrenError } from '../src/errors.js';
import type { AgentRunResult } from '../src/agentRun.js';
import {
  AGENT_PROFILES,
  parseAgentCommand,
  type ParsedAgentCommand,
} from '../src/agentProfiles.js';
import { agentModeAgent, resumeFixAgent } from '../src/commands/dispatch.js';
import { CLI_VERSION } from '../src/version.js';
import type { DispatchPrompt, MotirClient } from '../src/client.js';
import type { ProjectSession } from '../src/session.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import { nullDispatchRunReporter } from '../src/dispatchRunReporter.js';

// `motir auto` — the sequential WHILE loop (Subtask 7.9.4 · MOTIR-882).
//
// The loop is driven end-to-end here against a SCRIPTED server + agent + git,
// because its load-bearing properties are not visible in any single function:
// that it re-queries the server every iteration (rather than draining a list),
// that an integrated item unlocks its dependents mid-run, that main is never
// advanced, and that the end-of-run pull request opens even when the run ended
// badly. The fake server therefore models the real readiness rule (a dependency
// counts as satisfied once it is integrated on a session branch) rather than
// replaying a fixed sequence.

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
  sessionBranch: string | null;
  /** Who holds it — null is unclaimed (MOTIR-2427). */
  assigneeId: string | null;
  /** When set, this item only ENTERS the plan once `appearsAfter` is integrated
   *  — it is absent from every listing before that, which is what makes "the
   *  ready set changes underneath the loop" real rather than rearranged. */
  appearsAfter?: string;
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

function story(id: string, key: string): FakeItem {
  return { ...leaf(id, key), kind: 'story', type: null, executor: null };
}

class FakeServer {
  readonly transitions: { key: string; status: string }[] = [];
  readonly integrated: { key: string; sessionBranch: string }[] = [];
  /** The implementation provenance each integration carried (MOTIR-2419). */
  readonly provenance: { key: string; harness: string | null; model: string | null }[] = [];
  /** Every claim the run ATTEMPTED, in order (MOTIR-2427/MOTIR-3048). */
  readonly claims: { key: string; ownerId: string }[] = [];
  /** What each of those attempts resolved to — the discrimination this loop
   *  now has to act on rather than collapse. */
  readonly claimOutcomes: { key: string; outcome: string }[] = [];
  /** WHO this run's token belongs to. A test flips it to make a row that is
   *  in progress under somebody else's name genuinely somebody else's. */
  caller = 'user_me';
  /** Fired just before a claim resolves, so a test can make a SIBLING win the
   *  race in the exact gap the lock closes — between the pick and the claim.
   *  There is no other way to reach the refusal from here: the pick already
   *  narrows to rows this run may take. */
  beforeClaim: ((key: string) => void) | null = null;
  /** The `ownerId` each pick was narrowed by — undefined means UNNARROWED. */
  readonly ownerIdsAsked: (string | undefined)[] = [];
  readonly promptCalls: { key: string; sessionBranch: string | null }[] = [];
  readonly nextReadyCalls: number[] = [];
  readonly expandCalls: string[] = [];
  /** Return a message to make `expand_item` reject for that key. */
  expandFailure: ((key: string) => string | null) | null = null;
  /** Make `transition_status` REFUSE for a key, the way the container gate does
   *  (MOTIR-3229's 422). The refusal is the one a run reports and continues from
   *  rather than dies on — Bug MOTIR-3268. */
  refuseTransitionFor: ((args: { key: string; status: string }) => Error | null) | null = null;
  /** Every `link_pull_request` the run declared (MOTIR-4969) — the CONTAINER
   *  links, since the per-card ones are the dispatched agent's and never reach
   *  this client. */
  readonly links: { key: string; url?: string; headRef: string; baseRef: string }[] = [];

  constructor(private readonly items: FakeItem[]) {}

  byKey(key: string): FakeItem {
    const item = this.items.find((i) => i.key === key);
    if (!item) throw new Error(`no such item ${key}`);
    return item;
  }

  private present(item: FakeItem): boolean {
    if (!item.appearsAfter) return true;
    return this.integrated.some((r) => r.key === item.appearsAfter);
  }

  /** A dependency is satisfied when it is done OR integrated on a session branch
   *  awaiting review — the 7.8.11 integrated-dep readiness rule. */
  private satisfied(depId: string): boolean {
    const dep = this.items.find((i) => i.id === depId);
    return !!dep && (dep.status === 'done' || dep.status === 'in_review');
  }

  /** The single lineage an item inherits from its integrated dependencies. */
  private inherited(item: FakeItem): string | null {
    for (const depId of item.deps) {
      const dep = this.items.find((i) => i.id === depId);
      if (dep?.sessionBranch) return dep.sessionBranch;
    }
    return null;
  }

  asClient(): MotirClient {
    // Arrow properties, so the fake's methods close over the fixture instance
    // without aliasing `this`.
    const fake = {
      listReady: (): never => {
        throw new Error(
          '`motir auto` must never materialize the ready list — it asks for ONE item per iteration.',
        );
      },
      getPlanStatus: (): never => {
        throw new Error(
          '`motir auto` must never POLL a planning job: its output is a plan awaiting a human ' +
            'approval, so waiting on it in an unattended run is an unbounded wait on nobody.',
        );
      },
      expandItem: async (key: string) => {
        this.expandCalls.push(key);
        const failure = this.expandFailure?.(key);
        if (failure) throw new CliError(failure);
        const n = this.expandCalls.length;
        // A submit returns the ids and nothing else — no children, because none
        // exist: the job writes PROPOSALS into the plan, and approval is what
        // materializes them.
        return { jobId: `job-${n}`, planId: `plan-${n}` };
      },
      // The pick is client-side over the ranked ready set now (MOTIR-2398), and
      // the hold-out is by KEY. The fake honours `excludeKeys` for the same
      // reason the real client does: without it the loop would be handed the
      // same row forever.
      nextReady: async (args: { excludeKeys?: readonly string[]; ownerId?: string }) => {
        this.nextReadyCalls.push(args.excludeKeys?.length ?? 0);
        this.ownerIdsAsked.push(args.ownerId);
        const excluded = new Set((args.excludeKeys ?? []).map((k) => k.toUpperCase()));
        const item = this.items.find(
          (i) =>
            this.present(i) &&
            i.status === 'todo' &&
            !excluded.has(i.key.toUpperCase()) &&
            // The pickable rule, as the real client applies it inside its page
            // walk: unassigned, or already mine (MOTIR-2427).
            (args.ownerId === undefined ||
              i.assigneeId === null ||
              i.assigneeId === args.ownerId) &&
            i.deps.every((d) => this.satisfied(d)),
        );
        if (!item) return { item: null };
        return {
          item: {
            key: item.key,
            kind: item.kind,
            title: item.title,
            priority: 'medium',
            status: { key: item.status, category: 'todo' },
            type: item.type,
            executor: item.executor,
            difficulty: null,
            assigneeId: item.assigneeId,
            inheritedSessionBranch: this.inherited(item) ?? item.sessionBranch,
          },
        };
      },
      dispatchPrompt: async (
        key: string,
        opts: { sessionBranch?: string | null } = {},
      ): Promise<DispatchPrompt> => {
        const item = this.byKey(key);
        // The server rule: real lineage wins, the caller's seed is a fallback.
        const branch = this.inherited(item) ?? item.sessionBranch ?? opts.sessionBranch ?? null;
        this.promptCalls.push({ key, sessionBranch: branch });
        return {
          key,
          prompt: `PROMPT ${key}`,
          parentKey: 'PROD-1',
          targetRepo: item.targetRepo,
          workflowMode: branch ? 'session_lineage' : 'per_item_pr',
          sessionBranch: branch,
        };
      },
      // The pre-write read `transitionToImplemented` makes (MOTIR-5630), so it
      // never writes a card CI already moved past Implemented backwards.
      getWorkItem: async (key: string) => {
        const item = this.byKey(key);
        return { item: { identifier: item.key, status: item.status } };
      },
      transitionStatus: async (args: { key: string; status: string }) => {
        const refusal = this.refuseTransitionFor?.(args);
        if (refusal) {
          // Recorded as ATTEMPTED, then thrown: the run made the call and the
          // server said no, which is exactly the state the test asserts about.
          this.transitions.push(args);
          throw refusal;
        }
        this.transitions.push(args);
        this.byKey(args.key).status = args.status;
        return {};
      },
      // The ATOMIC claim (MOTIR-3048): one call that assigns AND flips, and
      // that can refuse. The fake answers by the server's own rule so a
      // `taken` / `not_claimable` row is reachable from a test without
      // hand-building a result.
      claimWorkItem: async (args: { key: string }) => {
        this.beforeClaim?.(args.key);
        const item = this.byKey(args.key);
        const { claim, apply } = resolveFakeClaim(item, {
          id: this.caller,
          name: 'Me',
        });
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
      markIntegrated: async (args: {
        key: string;
        sessionBranch: string;
        implementationHarness?: string;
        implementationModel?: string | null;
      }) => {
        this.integrated.push({ key: args.key, sessionBranch: args.sessionBranch });
        // Recorded SEPARATELY from `integrated` so the provenance assertions
        // read the triple as the server would receive it — including a field
        // the CLI omitted (MOTIR-2419).
        this.provenance.push({
          key: args.key,
          harness: args.implementationHarness ?? null,
          model: args.implementationModel ?? null,
        });
        const item = this.byKey(args.key);
        item.status = 'in_review';
        item.sessionBranch = args.sessionBranch;
        return {};
      },
      linkPullRequest: async (args: {
        key: string;
        url?: string;
        headRef: string;
        baseRef: string;
      }) => {
        this.links.push(args);
        return undefined;
      },
    };
    return fake as unknown as MotirClient;
  }
}

// ── the fake git / gh ───────────────────────────────────────────────────────

class FakeGit {
  readonly log: string[] = [];
  private readonly remoteBranches = new Set<string>();
  prCreated = 0;
  ghAvailable = true;
  commitsOnBranch = 3;

  /** A pull request already open on the session branch — the ORDINARY state at
   *  close-out since MOTIR-3681 opens one at the first implemented card. */
  existingPr: string | null = null;
  /** What `gh pr list --json isDraft` answers (MOTIR-4967). */
  prIsDraft = 'true';
  /** Whether `gh pr ready` succeeds. */
  prReadyOk = true;
  prReadyCalls = 0;

  /** Whether the agent's work reached the remote (MOTIR-3004's push check). */
  agentPushed = true;

  runner = (bin: string, args: string[], cwd: string): CommandResult => {
    this.log.push(`${bin} ${args.join(' ')} @${cwd}`);
    const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
    const fail = (stderr = 'boom'): CommandResult => ({ exitCode: 1, stdout: '', stderr });

    if (bin === 'git') {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'rev-parse') {
        const ref = args[args.length - 1] ?? '';
        if (ref.startsWith('refs/remotes/origin/')) {
          return this.remoteBranches.has(ref.slice('refs/remotes/origin/'.length)) ? ok() : fail();
        }
        return fail(); // no local branch — the agent worked in a worktree
      }
      if (args[0] === 'push') {
        const spec = args[2] ?? '';
        const created = spec.split(':refs/heads/')[1];
        if (created) this.remoteBranches.add(created);
        return ok();
      }
      if (args[0] === 'rev-list') return ok(String(this.commitsOnBranch));
      // The MOTIR-3004 push check: `ls-remote --heads origin *<KEY>*` for an
      // own-pull-request item, `log --grep=<KEY>` for a session-branch one. Both
      // answer "the agent pushed" unless a test says otherwise.
      if (args[0] === 'ls-remote') {
        return this.agentPushed ? ok('abc123\trefs/heads/subtask/pushed') : ok('');
      }
      if (args[0] === 'log') return this.agentPushed ? ok('abc123') : ok('');
    }
    if (bin === 'gh') {
      if (!this.ghAvailable) return { exitCode: 127, stdout: '', stderr: 'gh: not found' };
      if (args[1] === 'list') {
        // TWO different `pr list` calls now: `openSessionPr`'s (is there one?)
        // and `markSessionPrReady`'s (is it a draft?). They are told apart by
        // the field, exactly as `gh` tells them apart.
        return args.includes('isDraft') ? ok(this.prIsDraft) : ok(this.existingPr ?? '');
      }
      if (args[1] === 'create') {
        this.prCreated += 1;
        return ok('https://github.com/moooon/motir-core/pull/9001');
      }
      if (args[1] === 'ready') {
        this.prReadyCalls += 1;
        return this.prReadyOk ? ok('') : fail('draft PRs are disabled for this repository');
      }
    }
    return ok();
  };
}

// ── harness ─────────────────────────────────────────────────────────────────

let root: string;
let configHome: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

const BRANCH = sessionBranchName('20260729-010203');

/** The token owner every run below claims for (MOTIR-2427). */
const OWNER = 'user_me';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-auto-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), 'motir-auto-cfg-'));
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

interface DriveOptions {
  opts?: AutoOptions;
  /** `model` defaults to null — an agent that self-reported nothing. */
  agentResults?: (
    key: string,
    index: number,
  ) => Omit<AgentRunResult, 'model'> & { model?: string | null };
  onDispatch?: (key: string, index: number) => void;
  /** The agent command the loop launched — what the harness is derived FROM. */
  agentCommand?: string;
  /** The token owner this run claims for (MOTIR-2427). */
  ownerId?: string;
  /** Receives every event the loop reports (MOTIR-7504). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** The agent the run resolved, overriding `agentCommand` (MOTIR-10983). */
  agent?: ParsedAgentCommand;
  /** Receives every command a card spawned (MOTIR-10983). */
  onSpawn?: (key: string, command: ParsedAgentCommand) => void;
}

async function drive(
  server: FakeServer,
  git: FakeGit,
  drives: DriveOptions = {},
): Promise<{ summary: AutoSummary; dispatched: string[] }> {
  const dispatched: string[] = [];
  let tick = 0;
  const input: LoopInput = {
    session: session(server),
    opts: drives.opts ?? {},
    kinds: undefined,
    max: drives.opts?.max ? parseMax(drives.opts.max) : null,
    agent: drives.agent
      ? { parsed: drives.agent, source: 'agent' }
      : { parsed: parseAgentCommand(drives.agentCommand ?? 'fake-agent')!, source: 'flag' },
    runId: '20260729-010203',
    branch: BRANCH,
    run: git.runner,
    clock: () => (tick += 1000),
    runAgentFn: async ({ prompt, command }) => {
      const key = prompt.replace('PROMPT ', '');
      const index = dispatched.length;
      dispatched.push(key);
      drives.onDispatch?.(key, index);
      drives.onSpawn?.(key, command);
      const result = drives.agentResults?.(key, index) ?? { exitCode: 0, signal: null };
      // `runAgent` records the id the command was stamped with (`sessionIdOf`).
      return { model: null, sessionId: command.stream?.sessionId ?? null, ...result };
    },
    ownerId: drives.ownerId ?? OWNER,
    ...(drives.onEvent
      ? {
          reporter: {
            ...nullDispatchRunReporter,
            event: (e: Record<string, unknown>) => drives.onEvent!(e),
          } as never,
        }
      : {}),
  };
  const summary = await runAutoLoop(input);
  closeOutRepos(summary, git.runner);
  return { summary, dispatched };
}

// ── the pure decisions ──────────────────────────────────────────────────────

describe('classifyReadyItem', () => {
  it('dispatches an ordinary coding leaf', () => {
    expect(classifyReadyItem({ kind: 'subtask', type: 'code', executor: 'coding_agent' })).toBe(
      'dispatch',
    );
    // The 7.0.10 exclusion asserted as a CONTROL: a container that reached the
    // ready set is childless by construction, so kind alone decides. A leaf of
    // any kind is never mistaken for a planning item.
    expect(classifyReadyItem({ kind: 'task', type: 'test', executor: 'coding_agent' })).toBe(
      'dispatch',
    );
    expect(classifyReadyItem({ kind: 'bug', type: null, executor: null })).toBe('dispatch');
  });
  it('classifies an unexpanded epic/story as a planning item', () => {
    expect(classifyReadyItem({ kind: 'story' })).toBe('needs_planning');
    expect(classifyReadyItem({ kind: 'Epic' })).toBe('needs_planning');
  });
  it('classifies human work as needing a human', () => {
    expect(classifyReadyItem({ kind: 'subtask', type: 'manual', executor: 'coding_agent' })).toBe(
      'needs_human',
    );
    expect(classifyReadyItem({ kind: 'subtask', type: 'code', executor: 'human' })).toBe(
      'needs_human',
    );
  });
});

describe('manualWaitingOn (MOTIR-7477, manual-work-gate.md §8)', () => {
  it("is the run's starter — absent — for an unassigned card or the starter's own", () => {
    expect(manualWaitingOn({ assigneeId: null, assigneeName: null }, 'u1')).toBeUndefined();
    expect(manualWaitingOn({ assigneeId: 'u1', assigneeName: 'Yue' }, 'u1')).toBeUndefined();
  });

  it("names the assignee when the card is somebody else's", () => {
    expect(manualWaitingOn({ assigneeId: 'u2', assigneeName: 'Mara S.' }, 'u1')).toBe('Mara S.');
    expect(manualWaitingOn({ assigneeId: 'u2' }, 'u1')).toBe('its assignee');
  });
});

describe('parseMax', () => {
  it('accepts a positive whole number and defaults to no cap', () => {
    expect(parseMax(undefined)).toBeNull();
    expect(parseMax('3')).toBe(3);
  });
  it('refuses a value that would silently mean "no cap"', () => {
    for (const bad of ['0', '-1', 'lots', '2.5', '']) {
      expect(() => parseMax(bad)).toThrow(CliError);
    }
  });
});

describe('run id + session branch', () => {
  it('names a branch with no MOTIR key in it', () => {
    const branch = sessionBranchName(runIdFromDate(new Date(2026, 6, 29, 1, 2, 3)));
    expect(branch).toBe('motir/auto-20260729-010203');
    // Load-bearing: the status webhook parses a PR's branch AND title, so a key
    // here would link the whole multi-item run to one card.
    expect(branch).not.toMatch(/[A-Z]+-\d+/);
  });
});

describe('formatDuration', () => {
  it('renders seconds and minutes', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(64_000)).toBe('1m 04s');
  });
});

// ── the loop ────────────────────────────────────────────────────────────────

describe('motir auto — the WHILE loop', () => {
  it('re-queries every iteration, so an item created MID-RUN is picked up next', async () => {
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      // PROD-9 is absent from every listing until PROD-1 is integrated — it
      // could not have been in a pre-computed plan of the run.
      leaf('idNew', 'PROD-9', { appearsAfter: 'PROD-1' }),
    ]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git);

    expect(dispatched).toEqual(['PROD-1', 'PROD-9']);
    expect(summary.stopReason).toBe('drained');
    // One `next_ready` per iteration plus the final empty one — never a list.
    expect(server.nextReadyCalls.length).toBe(3);
  });

  it('cascades a dependency CHAIN: each item unlocks on its dep being integrated', async () => {
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2', { deps: ['idA'] }),
      leaf('idC', 'PROD-3', { deps: ['idB'] }),
    ]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git);

    // Strictly one at a time, in dependency order.
    expect(dispatched).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    // Every one integrated on the SAME session branch, none of them done.
    expect(server.integrated).toEqual([
      { key: 'PROD-1', sessionBranch: BRANCH },
      { key: 'PROD-2', sessionBranch: BRANCH },
      { key: 'PROD-3', sessionBranch: BRANCH },
    ]);
    expect(server.transitions.every((t) => t.status !== 'done')).toBe(true);
    // The FIRST item needed the loop's seed; the later ones INHERITED the branch
    // from the dependency the run had already integrated.
    expect(server.promptCalls.map((c) => c.sessionBranch)).toEqual([BRANCH, BRANCH, BRANCH]);
    expect(summary.records.map((r) => r.outcome)).toEqual([
      'integrated',
      'integrated',
      'integrated',
    ]);
    expect(autoExitCode(summary)).toBe(0);

    // ONE pull request for the one touched repo, and main is UNTOUCHED: nothing
    // in the whole run merged, checked out, or pushed to main.
    expect(git.prCreated).toBe(1);
    expect(summary.prs).toHaveLength(1);
    expect(summary.prs[0]?.outcome).toBe('opened');
    expect(git.log.some((c) => /\bmerge\b|\bcheckout\b|\bswitch\b|\breset\b/.test(c))).toBe(false);
    expect(git.log.some((c) => /push .*:refs\/heads\/main\b|push origin main\b/.test(c))).toBe(
      false,
    );
  });

  it('skips an unexpanded story and a human item without dispatching or transitioning them', async () => {
    const server = new FakeServer([
      { ...leaf('idS', 'PROD-5'), kind: 'story', type: null, executor: null },
      leaf('idH', 'PROD-6', { type: 'manual' }),
      leaf('idA', 'PROD-7'),
    ]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git);

    expect(dispatched).toEqual(['PROD-7']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-5', title: 'Item PROD-5', reason: 'needs_planning' },
      { key: 'PROD-6', title: 'Item PROD-6', reason: 'needs_human' },
    ]);
    // Skipped means UNTOUCHED — not claimed, no status flip, no prompt fetched.
    // The dispatch flip is the CLAIM's now (MOTIR-3048), so the claim list is
    // what carries the "only PROD-7 was started" half of this property.
    expect(server.claims.map((c) => c.key)).toEqual(['PROD-7']);
    expect(server.integrated.map((r) => r.key)).toEqual(['PROD-7']);
    expect(server.transitions).toEqual([]);
    expect(server.promptCalls.map((c) => c.key)).toEqual(['PROD-7']);

    const text = renderAutoSummary(summary);
    expect(text).toContain('Skipped — needs planning (1)');
    // ADR `manual-work-gate.md` §8 (MOTIR-7477): the card waits on its person in
    // Motir's Waiting on you — the run's starter, here — never "needs a human".
    expect(text).toContain("Skipped — waiting on you in Motir's Waiting on you (1)");
    expect(text).not.toContain('needs a human');
  });

  it('honours --max and stops with the cap named', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, { opts: { max: '1' } });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('max');
    // The cap ends the run, but the completed work still gets its pull request.
    expect(git.prCreated).toBe(1);
  });
});

// ── --include-planning (MOTIR-886) ──────────────────────────────────────────

describe('motir auto --include-planning', () => {
  /** The acceptance fixture: one ready unexpanded story, two ready leaves. */
  const fixture = (): FakeServer =>
    new FakeServer([story('idS', 'PROD-5'), leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);

  it('triggers the story ONCE, dispatches both leaves, and drains without ever polling', async () => {
    const server = fixture();
    const { dispatched, summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true },
    });

    expect(server.expandCalls).toEqual(['PROD-5']);
    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('drained');
    // The story is a PLANNING item, never an agent's work: no prompt was
    // fetched for it and its status was never touched.
    expect(dispatched).not.toContain('PROD-5');
    expect(server.promptCalls.map((c) => c.key)).toEqual(['PROD-1', 'PROD-2']);
    expect(server.transitions.some((t) => t.key === 'PROD-5')).toBe(false);
    expect(server.byKey('PROD-5').status).toBe('todo');
    // Triggered, not expanded — the record carries the plan to review and no
    // claim about children.
    expect(summary.planning).toEqual([
      {
        key: 'PROD-5',
        title: 'Item PROD-5',
        outcome: 'triggered',
        planId: 'plan-1',
        reviewUrl: 'https://app.motir.co/plans/plan-1',
      },
    ]);
    // It is no longer reported as skipped — the flag is the whole difference.
    expect(summary.skipped).toEqual([]);
  });

  it('never re-fires for an item already triggered, even though it stays childless', async () => {
    // The story is the ONLY item and remains unexpanded, so without the exclude
    // list `next_ready` would hand it back forever and this test would hang.
    const server = new FakeServer([story('idS', 'PROD-5')]);
    const { dispatched, summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true },
    });

    expect(server.expandCalls).toEqual(['PROD-5']);
    expect(dispatched).toEqual([]);
    // Trigger, then ONE more ask that comes back empty. No backoff, no wait.
    expect(server.nextReadyCalls.length).toBe(2);
    expect(summary.stopReason).toBe('drained');
    // A pending expansion does not redden a run whose dispatches all succeeded.
    expect(autoExitCode(summary)).toBe(0);

    const text = renderAutoSummary(summary);
    expect(text).toContain('Planning triggered — awaiting your approval (1)');
    expect(text).toContain('plan plan-1 — https://app.motir.co/plans/plan-1');
    expect(text).toContain('These are PROPOSALS.');
  });

  it('a failed expansion is NON-halting: named, skipped over, and irrelevant to the exit code', async () => {
    const server = fixture();
    server.expandFailure = (key) => (key === 'PROD-5' ? 'FORBIDDEN: out of AI credits' : null);
    const { dispatched, summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true },
    });

    // The loop kept going — unlike an agent failure, which halts by default.
    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('drained');
    expect(summary.planning).toEqual([
      {
        key: 'PROD-5',
        title: 'Item PROD-5',
        outcome: 'failed',
        planId: null,
        reviewUrl: null,
        detail: 'FORBIDDEN: out of AI credits',
      },
    ]);
    expect(autoExitCode(summary)).toBe(0);
    expect(renderAutoSummary(summary)).toContain('Planning failed — still unexpanded (1)');
  });

  it('leaves the exit code a function of DISPATCH outcomes alone', async () => {
    const server = fixture();
    server.expandFailure = () => 'BAD_REQUEST: nope';
    const { summary } = await drive(server, new FakeGit(), {
      opts: { includePlanning: true, keepGoing: true },
      agentResults: (key) =>
        key === 'PROD-2' ? { exitCode: 4, signal: null } : { exitCode: 0, signal: null },
    });

    // Non-zero because a DISPATCH failed, not because the expansion did.
    expect(summary.records.filter((r) => r.outcome === 'failed').map((r) => r.key)).toEqual([
      'PROD-2',
    ]);
    expect(autoExitCode(summary)).toBe(1);
  });

  it('WITHOUT the flag reproduces the MOTIR-882 skip behaviour verbatim (the control)', async () => {
    const server = fixture();
    const { dispatched, summary } = await drive(server, new FakeGit());

    // No expansion is submitted at all — the flag is opt-in, and an expansion
    // spends the token owner's AI credits.
    expect(server.expandCalls).toEqual([]);
    expect(summary.planning).toEqual([]);
    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-5', title: 'Item PROD-5', reason: 'needs_planning' },
    ]);
    expect(renderAutoSummary(summary)).toContain('Skipped — needs planning (1)');
  });

  it('renders all three planning outcomes, and links a plan only when it has one', () => {
    expect(planReviewUrl('https://app.motir.co', 'plan-7')).toBe(
      'https://app.motir.co/plans/plan-7',
    );
    expect(planReviewUrl('not a url', 'plan-7')).toBeNull();

    const text = renderAutoSummary({
      runId: '20260729-010203',
      records: [],
      skipped: [{ key: 'PROD-8', title: 'Skipped one', reason: 'needs_planning' }],
      planning: [
        {
          key: 'PROD-5',
          title: 'Triggered one',
          outcome: 'triggered',
          planId: 'plan-1',
          reviewUrl: 'https://app.motir.co/plans/plan-1',
        },
        {
          key: 'PROD-6',
          title: 'Failed one',
          outcome: 'failed',
          planId: null,
          reviewUrl: null,
          detail: 'RATE_LIMITED',
        },
      ],
      repos: [],
      prs: [],
      approvals: [],
      lanes: [],
      stopReason: 'drained',
    });

    expect(text).toContain('Planning triggered — awaiting your approval (1)');
    expect(text).toContain('PROD-5 — Triggered one');
    expect(text).toContain('Planning failed — still unexpanded (1)');
    expect(text).toContain('PROD-6 — RATE_LIMITED');
    expect(text).toContain('Skipped — needs planning (1)');
  });
});

describe('motir auto — failure policy', () => {
  const chain = (): FakeServer =>
    new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2'), leaf('idC', 'PROD-3')]);

  it('halts on the first agent failure by default, and still opens the PR', async () => {
    const server = chain();
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, {
      agentResults: (key) =>
        key === 'PROD-2' ? { exitCode: 3, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('halted');
    // The failed item is left In Progress — nothing reverted, never integrated.
    expect(server.byKey('PROD-2').status).toBe('in_progress');
    expect(server.integrated.map((r) => r.key)).toEqual(['PROD-1']);
    expect(autoExitCode(summary)).toBe(1);
    // The completed item is NOT abandoned by the failure.
    expect(git.prCreated).toBe(1);
    expect(renderAutoSummary(summary)).toContain('motir run PROD-2');
  });

  // ── implementation provenance (MOTIR-2419) ────────────────────────────────
  // Split by WHO KNOWS: the loop derives the harness from the command it
  // launched, the agent self-reports the model. The bug being fixed is a field
  // that read `motir-cli/<version>` on every card ever integrated — true of all
  // of them, and therefore an answer to nothing.

  it('records the AGENT as the harness, and the model the agent reported', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const git = new FakeGit();
    await drive(server, git, {
      agentCommand: 'claude --dangerously-skip-permissions',
      agentResults: () => ({ exitCode: 0, signal: null, model: 'claude-opus-5' }),
    });

    expect(server.provenance).toEqual([
      { key: 'PROD-1', harness: 'claude', model: 'claude-opus-5' },
      { key: 'PROD-2', harness: 'claude', model: 'claude-opus-5' },
    ]);
  });

  it.each([['m'], [null]] as const)(
    'reports the agent’s model (%s) TOP-LEVEL on `agent_exited`, the field the leg records (MOTIR-7504)',
    async (model) => {
      const server = new FakeServer([leaf('idA', 'PROD-1')]);
      const events: Record<string, unknown>[] = [];
      await drive(server, new FakeGit(), {
        agentResults: () => ({ exitCode: 0, signal: null, model }),
        onEvent: (e) => events.push(e),
      });

      const exited = events.filter((e) => e['kind'] === 'agent_exited');
      expect(exited).toHaveLength(1);
      expect(exited[0]).toMatchObject({ workItemKey: 'PROD-1', exitCode: 0, model });
      expect(exited[0]!['data']).toMatchObject({ model });
    },
  );

  it('leaves the model NULL when the agent reports none — and still names the agent', async () => {
    // The version of this bug that would survive the fix: a defaulted model is
    // a wrong answer wearing the shape of a right one. The harness does not
    // degrade with it — it never needed the agent's cooperation.
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const git = new FakeGit();
    await drive(server, git, { agentCommand: 'codex exec' });

    expect(server.provenance).toEqual([{ key: 'PROD-1', harness: 'codex', model: null }]);
  });

  it('never records the LAUNCHER, whatever the agent is', async () => {
    for (const [command, harness] of [
      ['claude', 'claude'],
      ['/usr/local/bin/cursor-agent --force', 'cursor'],
      ['my-own-agent --go', 'my-own-agent'],
    ] as const) {
      const server = new FakeServer([leaf('idA', 'PROD-1')]);
      await drive(server, new FakeGit(), { agentCommand: command });
      expect(server.provenance).toEqual([{ key: 'PROD-1', harness, model: null }]);
      expect(server.provenance[0]!.harness).not.toBe(`motir-cli/${CLI_VERSION}`);
    }
  });

  // ── the CLAIM and the pickable set (MOTIR-2427) ───────────────────────────
  // Motir is used by TEAMS. The loop used to take the top of a shared ranked
  // queue and record nothing, so two people's runs competed for one queue and
  // neither could tell.

  it('CLAIMS every card it takes, for the token owner', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server, new FakeGit());

    expect(server.claims).toEqual([
      { key: 'PROD-1', ownerId: OWNER },
      { key: 'PROD-2', ownerId: OWNER },
    ]);
  });

  it('narrows every pick by the owner — not just the first', async () => {
    // A run that narrowed only its opening ask would take a teammate's card the
    // moment one appeared mid-run, which is exactly when the ready set changes.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server, new FakeGit());

    expect(server.ownerIdsAsked.length).toBeGreaterThan(1);
    expect(new Set(server.ownerIdsAsked)).toEqual(new Set([OWNER]));
  });

  it('never takes a card claimed by someone ELSE', async () => {
    const server = new FakeServer([
      leaf('idA', 'PROD-1', { assigneeId: 'user_them' }),
      leaf('idB', 'PROD-2'),
    ]);
    const { dispatched } = await drive(server, new FakeGit());

    expect(dispatched).toEqual(['PROD-2']);
    expect(server.claims.map((c) => c.key)).toEqual(['PROD-2']);
    // Their card was not touched in any way — not claimed, not transitioned.
    expect(server.byKey('PROD-1').status).toBe('todo');
    expect(server.byKey('PROD-1').assigneeId).toBe('user_them');
  });

  it('takes a card ALREADY assigned to me — the claim is idempotent', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1', { assigneeId: OWNER })]);
    const { dispatched } = await drive(server, new FakeGit());

    expect(dispatched).toEqual(['PROD-1']);
    expect(server.claims).toEqual([{ key: 'PROD-1', ownerId: OWNER }]);
  });

  // MOTIR-3048 — the pick narrows to rows this run may take, but the pick and
  // the claim are not one act. The card can be taken in between, and until the
  // claim could REFUSE, the loop had no way to find out.
  it('a card a SIBLING took between the pick and the claim is a SKIP, not a failure', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    server.beforeClaim = (key) => {
      if (key !== 'PROD-2') return;
      const stolen = server.byKey('PROD-2');
      stolen.status = 'in_progress';
      stolen.assigneeId = 'user_them';
    };

    const { summary, dispatched } = await drive(server, new FakeGit());

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
    // Not a RECORD, so not a failure — the loop drained cleanly and the exit
    // code never saw it.
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('drained');
    expect(autoExitCode(summary)).toBe(0);
    // …and it is held out, so the very next `next_ready` cannot offer it back.
    expect(server.byKey('PROD-2').assigneeId).toBe('user_them');
  });

  it('a refused claim does not HALT the loop, even without --keep-going', async () => {
    // The failure policy stops on the first FAILED agent. A refusal is not one:
    // no agent ran, so there is nothing half-done to protect.
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2'),
      leaf('idC', 'PROD-3'),
    ]);
    server.beforeClaim = (key) => {
      if (key === 'PROD-2') server.byKey('PROD-2').status = 'done';
    };

    const { summary, dispatched } = await drive(server, new FakeGit());

    expect(dispatched).toEqual(['PROD-1', 'PROD-3']);
    expect(summary.skipped).toContainEqual({
      key: 'PROD-2',
      title: 'Item PROD-2',
      reason: 'claim_refused',
    });
    expect(server.transitions.map((t) => t.key)).not.toContain('PROD-2');
    expect(autoExitCode(summary)).toBe(0);
  });

  it('claims BEFORE the status moves — a claim written at the end is history', async () => {
    // The ordering is the point: a teammate reads the board WHILE the work is
    // happening, and a claim recorded afterwards tells them nothing in time.
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    await drive(server, new FakeGit(), {
      onDispatch: () => {
        // By the time the agent runs, both writes have landed in order.
        expect(server.claims).toEqual([{ key: 'PROD-1', ownerId: OWNER }]);
      },
    });

    // There is no separate status write to be BEFORE any more — the claim IS
    // the flip (MOTIR-3048). What the property becomes: the claim landed, and
    // it landed before anything the agent did.
    expect(server.claimOutcomes).toEqual([{ key: 'PROD-1', outcome: 'claimed' }]);
    expect(server.transitions.map((t) => t.status)).not.toContain('in_progress');
  });

  it('--keep-going finishes the remainder and never re-dispatches the failure', async () => {
    const server = chain();
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, {
      opts: { keepGoing: true },
      agentResults: (key) =>
        key === 'PROD-1' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    expect(dispatched.filter((k) => k === 'PROD-1')).toHaveLength(1);
    expect(summary.stopReason).toBe('drained');
    expect(summary.records.filter((r) => r.outcome === 'failed').map((r) => r.key)).toEqual([
      'PROD-1',
    ]);
    expect(autoExitCode(summary)).toBe(1);
  });

  it('a Ctrl-C between items exits cleanly and still lands the pull request', async () => {
    const server = chain();
    const git = new FakeGit();
    const { dispatched, summary } = await drive(server, git, {
      onDispatch: (_key, index) => {
        if (index === 0) process.emit('SIGINT');
      },
    });

    // The in-flight item completes; the loop stops before starting another.
    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('interrupted');
    // Server state is consistent: the item that ran is fully recorded, and no
    // half-applied transition is left behind.
    expect(server.integrated).toEqual([{ key: 'PROD-1', sessionBranch: BRANCH }]);
    expect(server.byKey('PROD-2').status).toBe('todo');
    expect(git.prCreated).toBe(1);
    expect(autoExitCode(summary)).toBe(130);
  });
});

describe('motir auto — the close-out', () => {
  it('opens no pull request for a branch that carries no commits', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const git = new FakeGit();
    git.commitsOnBranch = 0;
    const { summary } = await drive(server, git);

    expect(git.prCreated).toBe(0);
    expect(summary.prs[0]?.outcome).toBe('empty');
  });

  it('reports a gh failure with the manual fallback instead of losing the work', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const git = new FakeGit();
    git.ghAvailable = false;
    const { summary } = await drive(server, git);

    // The work is integrated and recorded regardless of the tooling gap.
    expect(server.integrated).toEqual([{ key: 'PROD-1', sessionBranch: BRANCH }]);
    expect(summary.prs[0]?.outcome).toBe('failed');
    const text = renderAutoSummary(summary);
    expect(text).toContain('NOT opened');
    expect(text).toContain(`motir done --session ${BRANCH}`);
  });

  it('names every implemented item with its recorded branch', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { summary } = await drive(server, new FakeGit());
    const text = renderAutoSummary(summary);
    expect(text).toContain('Implemented — CI decides when these become reviewable (2)');
    expect(text).toContain(`PROD-1 on ${BRANCH}`);
    expect(text).toContain(`PROD-2 on ${BRANCH}`);
  });
});

describe('the session pull request', () => {
  it('titles without a key and bodies with every key plus the close-out', () => {
    // Three cards under THREE different parents — the mixed case, which falls
    // back to the run form (MOTIR-2422).
    const title = sessionPrTitle('20260729-010203', [
      { key: 'PROD-1', title: 'A', parentKey: 'PROD-90' },
      { key: 'PROD-2', title: 'B', parentKey: 'PROD-91' },
      { key: 'PROD-3', title: 'C', parentKey: null },
    ]);
    expect(title).toBe('Motir auto run 20260729-010203 — 3 work items');
    expect(title).not.toMatch(/[A-Z]+-\d+/);

    const body = renderSessionPrBody('20260729-010203', BRANCH, [
      {
        key: 'PROD-1',
        title: 'A',
        outcome: 'integrated',
        durationMs: 1,
        sessionBranch: BRANCH,
        repo: 'motir-core',
        parentKey: null,
      },
      {
        key: 'PROD-2',
        title: 'B',
        outcome: 'failed',
        durationMs: 1,
        sessionBranch: null,
        repo: 'motir-core',
        parentKey: null,
      },
    ]);
    expect(body).toContain('## Work items carried (1)');
    expect(body).toContain('- PROD-1 — A');
    expect(body).toContain('Attempted and failed (1)');
    expect(body).toContain(`motir done --session ${BRANCH}`);
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────

describe('the summary reports every pull-request outcome distinctly', () => {
  const summaryWith = (prs: AutoSummary['prs']): string =>
    renderAutoSummary({
      runId: '20260729-010203',
      records: [],
      skipped: [],
      repos: [],
      // MOTIR-886 added the planning lane to the summary shape; an empty one is
      // the `motir auto` default (`--include-planning` is what fills it).
      planning: [],
      prs,
      // MOTIR-3023's approvals lane, empty for the same reason
      // (`--auto-approve-replan` is what fills it).
      approvals: [],
      lanes: [],
      stopReason: 'drained',
    });

  it('names an ALREADY-OPEN pull request as updated by this run', () => {
    expect(
      summaryWith([
        {
          repoName: 'motir-core',
          branch: BRANCH,
          url: 'https://github.test/pull/1',
          outcome: 'existing',
        },
      ]),
    ).toContain('already open — updated by this run');
  });

  it('explains an EMPTY branch rather than implying a pull request exists', () => {
    expect(
      summaryWith([{ repoName: 'motir-core', branch: BRANCH, url: null, outcome: 'empty' }]),
    ).toContain('carries no commits beyond main');
  });

  it('gives the MANUAL fallback when the pull request could not be opened', () => {
    const rendered = summaryWith([
      {
        repoName: null,
        branch: BRANCH,
        url: null,
        outcome: 'failed',
        message: 'gh: not found',
      },
    ]);
    expect(rendered).toContain('the checkout: NOT opened. gh: not found');
    expect(rendered).toContain('The work IS pushed to');
    expect(rendered).toContain(`motir done --session ${BRANCH}`);
  });

  it('says plainly when a run dispatched nothing at all', () => {
    expect(summaryWith([])).toContain('No work items were dispatched.');
  });
});

describe('an item with no lineage ships as its own pull request', () => {
  it('moves to Implemented via transition_status, not mark_integrated', async () => {
    // The root is not a git repository, so an UNPINNED item has nowhere to open a
    // session branch: the server hands it the per-item-PR prompt and Implemented
    // is the truthful status. The MOTIR-3004 push check is INCONCLUSIVE here (no
    // repository to ask), and an inconclusive check must not contradict the
    // agent — only a repository that answers with nothing refuses the record.
    const server = new FakeServer([leaf('row-1', 'PROD-1', { targetRepo: null })]);
    const git = new FakeGit();
    const rootIsNotARepo: typeof git.runner = (bin, args, cwd) =>
      bin === 'git' && cwd === root
        ? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
        : git.runner(bin, args, cwd);

    const summary = await runAutoLoop({
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260729-010203',
      branch: BRANCH,
      run: rootIsNotARepo,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });

    expect(summary.records[0]?.outcome).toBe('implemented');
    expect(summary.records[0]?.detail).toBe('own pull request');
    expect(server.integrated).toHaveLength(0);
    expect(server.transitions).toContainEqual({ key: 'PROD-1', status: 'implemented' });
    // No repo carried a session branch, so there is nothing to close out.
    expect(summary.repos).toHaveLength(0);
  });
});

describe("the CONTAINER gate's refusal is an outcome, not a crash (MOTIR-3268)", () => {
  it('names it, keeps the card In Progress, and still closes the run out', async () => {
    // ⚠️ THE 422 CAN STILL ARRIVE. The scoped run's close-out re-read narrows the
    // window — a child filed between that read and this transition still lands
    // here — and the per-card transition is reachable for a `task` or `bug` that
    // acquired children of its own. An unhandled throw escapes the loop BEFORE
    // `closeOutRepos`, abandoning finished work that has nothing to do with this
    // card; that is the shape this test pins shut.
    let printed = '';
    stderrSpy.mockImplementation((chunk: unknown) => {
      printed += String(chunk);
      return true;
    });
    const server = new FakeServer([leaf('row-1', 'PROD-1', { targetRepo: null })]);
    const git = new FakeGit();
    server.refuseTransitionFor = ({ status }) =>
      status === 'implemented'
        ? new ContainerHasOpenChildrenError(
            'This item cannot reach "implemented" while 1 of its children has not been ' +
              'implemented: PROD-9.',
          )
        : null;
    const rootIsNotARepo: typeof git.runner = (bin, args, cwd) =>
      bin === 'git' && cwd === root
        ? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
        : git.runner(bin, args, cwd);

    const summary = await runAutoLoop({
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260820-010203',
      branch: BRANCH,
      run: rootIsNotARepo,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });

    // Not a throw: the loop returned a summary.
    expect(summary.records[0]?.outcome).toBe('failed');
    expect(summary.records[0]?.detail).toBe('container has open children');
    // The card honestly stays where the server left it — nothing was reverted.
    expect(server.byKey('PROD-1').status).toBe('in_progress');
    // The server's own sentence reaches the operator, naming the open child.
    expect(printed).toContain('PROD-9');
  });

  it('re-throws every OTHER transition failure — a blanket catch would hide them', async () => {
    // ⚠️ Narrowing to the one code is the point. A blanket catch here would turn
    // an auth failure, a rate limit or a 500 into a card-shaped outcome, which is
    // how a run reports "the container has open children" for a server that was
    // simply unreachable.
    const server = new FakeServer([leaf('row-1', 'PROD-1', { targetRepo: null })]);
    const git = new FakeGit();
    server.refuseTransitionFor = () => new CliError('the server is on fire');
    const rootIsNotARepo: typeof git.runner = (bin, args, cwd) =>
      bin === 'git' && cwd === root
        ? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
        : git.runner(bin, args, cwd);

    await expect(
      runAutoLoop({
        session: session(server),
        opts: {},
        kinds: undefined,
        max: null,
        agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
        runId: '20260820-010203',
        branch: BRANCH,
        run: rootIsNotARepo,
        clock: () => 0,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
        ownerId: OWNER,
      }),
    ).rejects.toThrow('the server is on fire');
  });
});

describe('the close-out survives a git failure', () => {
  it('reports the repo as failed instead of throwing away a finished run', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    // A local branch exists and is ahead, but the push is rejected — the throw
    // comes from inside the close-out, after the work is already integrated.
    const pushRejected: typeof git.runner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'rev-parse' && (args[3] ?? '').startsWith('refs/heads/')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (bin === 'git' && args[0] === 'push' && args[1] === 'origin' && args[2] === BRANCH) {
        return { exitCode: 1, stdout: '', stderr: 'protected branch' };
      }
      return git.runner(bin, args, cwd);
    };

    const summary = await runAutoLoop({
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260729-010203',
      branch: BRANCH,
      run: pushRejected,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });
    closeOutRepos(summary, pushRejected);

    expect(summary.prs[0]).toMatchObject({ outcome: 'failed' });
    expect(summary.prs[0]?.message).toContain('protected branch');
    // The item is still recorded as integrated — the failure is downstream of it.
    expect(server.integrated.map((r) => r.key)).toEqual(['PROD-1']);
  });
});

describe('the session pull request is a DRAFT until the close-out marks it ready (MOTIR-4967)', () => {
  /** `runAutoLoop` with one leaf, opening its pull request eagerly like `motir auto`. */
  async function runOneCard(git: FakeGit, server: FakeServer): Promise<AutoSummary> {
    return runAutoLoop({
      openPrEagerly: true,
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260820-010203',
      branch: BRANCH,
      run: git.runner,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });
  }

  it('a run that never reaches its close-out leaves a DRAFT — the case this card exists for', async () => {
    // ⚠️ THE FAILURE PATH, not the happy one. A halted, interrupted or crashed
    // run has integrated and pushed real work, and the mid-run open is what puts
    // CI on it — but it has NOT finished the set it set out to finish, and a
    // pull request marked ready claims it has. So the loop opens the draft and
    // nothing in it ever ends the draft.
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    await runOneCard(git, server);

    expect(git.prCreated).toBe(1);
    expect(git.log.some((line) => line.includes('pr create') && line.includes('--draft'))).toBe(
      true,
    );
    expect(git.prReadyCalls).toBe(0);
  });

  it('the CLOSE-OUT marks it ready — and only AFTER `updateSessionPr` has rewritten the title', async () => {
    // ⚠️ THE ORDER IS THE RULE. The pull request opened at the first implemented
    // card is titled from an EMPTY carried set, so it names 0 work items; the
    // rewrite is what makes it describe the run. Marking it ready first notifies
    // every reviewer about that title, which is precisely what the draft is for.
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    git.existingPr = 'https://github.com/moooon/motir-core/pull/9001';
    const summary = await runOneCard(git, server);
    git.log.length = 0;

    closeOutRepos(summary, git.runner);

    const edited = git.log.findIndex((line) => line.includes('gh pr edit'));
    const readied = git.log.findIndex((line) => line.includes('gh pr ready'));
    expect(edited).toBeGreaterThanOrEqual(0);
    expect(readied).toBeGreaterThan(edited);
    expect(summary.prs[0]).toMatchObject({ outcome: 'existing' });
    expect(summary.prs[0]?.draft).toBeUndefined();
    expect(renderAutoSummary(summary)).not.toContain('still a DRAFT');
  });

  it('leaves a pull request that is ALREADY ready alone — a resumed run must not fail', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    git.existingPr = 'https://github.com/moooon/motir-core/pull/9001';
    git.prIsDraft = 'false';
    const summary = await runOneCard(git, server);

    closeOutRepos(summary, git.runner);

    expect(git.prReadyCalls).toBe(0);
    expect(summary.prs[0]?.draft).toBeUndefined();
  });

  it('REPORTS a failing `gh pr ready` and still completes the run', async () => {
    // Same discipline as every other `gh` call in the close-out: the work is
    // integrated, pushed and CI-checked, and a summary that aborts over `gh`
    // hides it. What the operator gets instead is the draft, named, with the
    // command that finishes it.
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    git.prReadyOk = false;
    const summary = await runOneCard(git, server);

    expect(() => closeOutRepos(summary, git.runner)).not.toThrow();

    expect(summary.prs[0]).toMatchObject({ outcome: 'opened', draft: true });
    expect(summary.prs[0]?.message).toContain('still a DRAFT');
    expect(renderAutoSummary(summary)).toContain('still a DRAFT');
    // The card is still recorded as integrated — the draft is downstream of it.
    expect(server.integrated.map((r) => r.key)).toEqual(['PROD-1']);
  });

  it('an `auto` run carrying ONE STORY’S CHILDREN takes arm 2 and links the STORY (MOTIR-4969)', async () => {
    // ⚠️ THE MODE THE FIRST WORDING EXCLUDED BY NAME. `motir auto` is the
    // UNSCOPED lane and was going to keep per-card linking for ever — but it
    // routinely drains a story's children one after another, and then its
    // session pull request delivers that story exactly as a scoped run's does.
    // The arm is read off the set, so this needs no lane branch to reach.
    const server = new FakeServer([leaf('row-1', 'PROD-2'), leaf('row-2', 'PROD-3')]);
    const git = new FakeGit();
    const summary = await runAutoLoop({
      openPrEagerly: true,
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260910-010203',
      branch: BRANCH,
      run: git.runner,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });

    // Both cards landed under the fake's shared parent, so the run declared the
    // PARENT — once, at the moment the second card made the arm knowable.
    expect(summary.records.map((r) => r.parentKey)).toEqual(['PROD-1', 'PROD-1']);
    expect(server.links.map((l) => l.key)).toEqual(['PROD-1']);
    expect(server.links[0]).toMatchObject({ headRef: BRANCH, baseRef: 'main' });
  });

  it('an `auto` run carrying ONE card links nothing — the agent already did (MOTIR-4969)', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    await runOneCard(git, server);

    expect(server.links).toEqual([]);
  });
});

describe('a container with UNLANDED children keeps its DRAFT — `held` retires (MOTIR-3268 → MOTIR-4967)', () => {
  async function runOneCard(git: FakeGit, server: FakeServer): Promise<AutoSummary> {
    return runAutoLoop({
      openPrEagerly: true,
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260820-010203',
      branch: BRANCH,
      run: git.runner,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });
  }

  it('opens the pull request, does NOT mark it ready, and names the outstanding children', async () => {
    // ⚠️ THE INVARIANT IS UNCHANGED AND ITS CARRIER IS NOT. A pull request must
    // not claim a container is built while a child of its own is not — Bug
    // MOTIR-3268 carried that by opening NOTHING, which also denied the finished
    // work its CI. A draft carries it strictly better: it cannot be merged, so it
    // can neither complete the container nor cascade `done` onto the very
    // children that are missing.
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    const summary = await runOneCard(git, server);

    closeOutRepos(summary, git.runner, {
      containerKey: 'PROD-100',
      openChildren: ['PROD-9', 'PROD-10'],
    });

    expect(summary.prs[0]).toMatchObject({ outcome: 'opened', draft: true });
    expect(summary.prs[0]?.url).not.toBeNull();
    expect(git.prReadyCalls).toBe(0);
    // …and the commits are pushed, which the hold was already right about.
    expect(git.log.some((line) => line.startsWith('git push origin'))).toBe(true);

    const rendered = renderAutoSummary(summary);
    expect(rendered).toContain('PROD-100 is NOT finished');
    expect(rendered).toContain('PROD-9 — not implemented');
    expect(rendered).toContain('PROD-10 — not implemented');
    expect(rendered).toContain('stay DRAFTS');
    expect(rendered).toContain('motir run PROD-100');
    // ⚠️ NOTHING FOR THE OPERATOR TO UNDO. The predecessor offered three
    // dispositions because the run had withheld the pull request on their
    // behalf; nothing has been withheld here.
    expect(rendered).not.toContain('NO pull request was opened');
    expect(summary.prs.some((pr) => (pr.outcome as string) === 'held')).toBe(false);
  });

  it('an EMPTY branch still reports `empty` — the more specific of the two truths', async () => {
    // Unchanged from the hold: a branch that carries nothing has no pull request
    // to leave in draft, and saying otherwise would send the operator looking for
    // work that does not exist.
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    git.commitsOnBranch = 0;
    const summary = await runOneCard(git, server);

    closeOutRepos(summary, git.runner, {
      containerKey: 'PROD-100',
      openChildren: ['PROD-9'],
    });

    expect(summary.prs[0]).toMatchObject({ outcome: 'empty' });
  });

  it('a FAILED open reports why the OPEN failed — not a message about draft state', async () => {
    // ⚠️ THE OPEN'S REASON MUST SURVIVE. There is no pull request to mark ready,
    // so asking `gh` would fail a second time and overwrite the one message a
    // human can act on with one about draft state, which is not the problem.
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    const summary = await runOneCard(git, server);
    git.ghAvailable = false;

    closeOutRepos(summary, git.runner, {
      containerKey: 'PROD-100',
      openChildren: ['PROD-9'],
    });

    expect(summary.prs[0]).toMatchObject({ outcome: 'failed', url: null });
    expect(summary.prs[0]?.draft).toBeUndefined();
    expect(summary.prs[0]?.message).toContain('gh: not found');
    expect(summary.prs[0]?.message).not.toContain('unlanded');
  });

  it('an EMPTY open-children list is an ordinary close-out — the container landed everything', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    const summary = await runOneCard(git, server);

    closeOutRepos(summary, git.runner, { containerKey: 'PROD-100', openChildren: [] });

    expect(git.prReadyCalls).toBe(1);
    expect(summary.outstanding).toBeUndefined();
    expect(summary.prs[0]?.draft).toBeUndefined();
  });
});

describe('records with missing pieces still render honestly', () => {
  it('names an untitled item, a record with no branch, and a PR with no URL', () => {
    const summary: AutoSummary = {
      runId: '20260729-010203',
      records: [
        {
          key: 'PROD-1',
          title: null,
          outcome: 'integrated',
          durationMs: 1000,
          sessionBranch: null,
          repo: null,
          parentKey: null,
        },
      ],
      skipped: [{ key: 'PROD-2', title: null, reason: 'needs_human' }],
      planning: [],
      repos: [],
      prs: [
        { repoName: 'motir-core', branch: BRANCH, url: null, outcome: 'opened' },
        { repoName: 'motir-ai', branch: BRANCH, url: null, outcome: 'existing' },
        { repoName: 'motir-gateway', branch: BRANCH, url: null, outcome: 'failed' },
      ],
      approvals: [],
      lanes: [],
      stopReason: 'drained',
    };

    const rendered = renderAutoSummary(summary);

    expect(rendered).toContain('(no branch recorded)');
    // With no URL the branch name is the next-best identifier, never "null".
    expect(rendered).toContain(`motir-core: ${BRANCH} (opened)`);
    expect(rendered).toContain(`motir-ai: ${BRANCH} (already open`);
    expect(rendered).toContain('motir-gateway: NOT opened.');
    expect(rendered).not.toContain('undefined');
    expect(rendered).not.toContain('null');

    const body = renderSessionPrBody('20260729-010203', BRANCH, [
      {
        key: 'PROD-1',
        title: null,
        outcome: 'integrated',
        durationMs: 0,
        sessionBranch: BRANCH,
        repo: null,
        parentKey: null,
      },
      {
        key: 'PROD-2',
        title: null,
        outcome: 'failed',
        durationMs: 0,
        sessionBranch: null,
        repo: null,
        parentKey: null,
      },
    ]);
    expect(body).toContain('- PROD-1 — (untitled)');
    expect(body).toContain('- PROD-2 — (untitled)');
  });
});

describe('more of the run’s edges', () => {
  it('records an agent KILLED by a signal, naming the signal', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    const { summary } = await drive(server, git, {
      agentResults: () => ({ exitCode: 1, signal: 'SIGKILL' }),
    });

    expect(summary.records[0]).toMatchObject({ outcome: 'failed', detail: 'killed by SIGKILL' });
  });

  it('reports an interrupt that arrives together with a failure as INTERRUPTED', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1'), leaf('row-2', 'PROD-2')]);
    const git = new FakeGit();
    const { summary, dispatched } = await drive(server, git, {
      onDispatch: () => process.emit('SIGINT'),
      agentResults: () => ({ exitCode: 1, signal: null }),
    });

    // Ctrl-C wins the label: the user asked to stop, and the failure is already
    // listed in its own section.
    expect(summary.stopReason).toBe('interrupted');
    expect(dispatched).toEqual(['PROD-1']);
  });

  it('REUSES a session branch that is already on origin instead of recreating it', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    const alreadyThere: typeof git.runner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'rev-parse' && (args[3] ?? '').includes('refs/remotes/')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return git.runner(bin, args, cwd);
    };

    await drive(server, { ...git, runner: alreadyThere } as unknown as FakeGit);

    // A resumed run must not rewind a branch that already carries commits.
    expect(git.log.some((cmd) => cmd.includes(':refs/heads/'))).toBe(false);
  });

  it('pushes a session branch the agent left behind locally, then opens the PR', async () => {
    const server = new FakeServer([leaf('row-1', 'PROD-1')]);
    const git = new FakeGit();
    const localBranchAhead: typeof git.runner = (bin, args, cwd) => {
      if (bin === 'git' && args[0] === 'rev-parse' && (args[3] ?? '').startsWith('refs/heads/')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return git.runner(bin, args, cwd);
    };

    const summary = await runAutoLoop({
      session: session(server),
      opts: {},
      kinds: undefined,
      max: null,
      agent: { parsed: { command: 'fake', binary: 'fake', args: [] }, source: 'flag' },
      runId: '20260729-010203',
      branch: BRANCH,
      run: localBranchAhead,
      clock: () => 0,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      ownerId: OWNER,
    });
    closeOutRepos(summary, localBranchAhead);

    expect(git.log).toContain(`git push origin ${BRANCH} @${join(root, 'motir-core')}`);
    expect(summary.prs[0]?.outcome).toBe('opened');
  });
});

// THE TITLE NAMES WHAT THE RUN DELIVERED (MOTIR-2422).
//
// A title is read in a LIST — the repo's open pull requests, a notification, a
// review queue — where it is the only thing shown and its job is to help someone
// decide whether to open it. `Motir auto run 20260807-141522 — 4 work items`
// says a machine did something, four times.
//
// The parent rides the dispatch prompt the loop already fetches (MOTIR-2445), so
// none of this costs a request.
describe('sessionPrTitle — the shared parent, when there is one', () => {
  const card = (key: string, parentKey: string | null, title = `Card ${key}`) => ({
    key,
    title,
    parentKey,
  });

  it('names the SHARED parent when every card has it', () => {
    const title = sessionPrTitle('20260807-141522', [
      card('PROD-10', 'PROD-2'),
      card('PROD-11', 'PROD-2'),
      card('PROD-12', 'PROD-2'),
    ]);
    expect(title).toBe('PROD-2 — 3 work items');
  });

  it('falls back when the cards span SEVERAL parents', () => {
    // The case a naive implementation gets wrong by naming the first card's
    // parent — and nothing about that result looks incorrect. It is a real
    // story, genuinely in the pull request. It is just not what the branch is.
    const title = sessionPrTitle('20260807-141522', [
      card('PROD-10', 'PROD-2'),
      card('PROD-11', 'PROD-3'),
    ]);
    expect(title).toBe('Motir auto run 20260807-141522 — 2 work items');
  });

  it('a NULL parent in the set is a distinct answer, not an absence', () => {
    // A set containing a top-level card does not share a parent. Ignoring the
    // null would name the story the OTHERS sit under and quietly overstate it.
    const title = sessionPrTitle('20260807-141522', [
      card('PROD-10', 'PROD-2'),
      card('PROD-11', null),
    ]);
    expect(title).toBe('Motir auto run 20260807-141522 — 2 work items');
  });

  it('a run of ONE names the CARD, not its parent', () => {
    // For one item the card IS the deliverable; its story describes something
    // much larger than what shipped.
    expect(sessionPrTitle('20260807-141522', [card('PROD-10', 'PROD-2', 'Wire the seam')])).toBe(
      'PROD-10 Wire the seam',
    );
  });

  it('a run of one TOP-LEVEL card still names the card', () => {
    expect(sessionPrTitle('20260807-141522', [card('PROD-10', null, 'Standalone')])).toBe(
      'PROD-10 Standalone',
    );
  });

  it('fits the list-render budget rather than discovering it in GitHub', () => {
    const long = sessionPrTitle('20260807-141522', [
      card('PROD-10', null, 'A card whose title runs on and on and on well past what a list shows'),
    ]);
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.endsWith('…')).toBe(true);
    // The key survives the trim — an elided title still says WHICH card.
    expect(long.startsWith('PROD-10 ')).toBe(true);
  });

  it('an EMPTY carried set falls back rather than naming nothing', () => {
    // Reachable: a run whose every item failed pushes a branch with no carried
    // cards, and the close-out still opens the pull request.
    expect(sessionPrTitle('20260807-141522', [])).toBe(
      'Motir auto run 20260807-141522 — 0 work items',
    );
  });
});

// THE BODY IS THE AGENTS' COMMITS, FRAMED BY THE LOOP (MOTIR-2411).
//
// A card title is what was PLANNED. The commit is what was DONE, including what
// only surfaced while doing it. The body used to be a manifest of the former.
describe('renderSessionPrBody — the commits, not the card titles', () => {
  const record = (key: string, title: string, outcome: 'integrated' | 'failed' = 'integrated') => ({
    key,
    title,
    outcome,
    durationMs: 1,
    sessionBranch: outcome === 'failed' ? null : BRANCH,
    repo: 'motir-core',
    parentKey: null,
  });

  const commit = (subject: string, body = '') => ({ subject, body });

  it('carries every commit — subject AND body — in branch order', () => {
    // Order is asserted by INDEX, not by presence: a set-shaped implementation
    // passes a contains-check and still scrambles the narrative.
    const out = renderSessionPrBody(
      '20260729-010203',
      BRANCH,
      [record('PROD-1', 'A'), record('PROD-2', 'B')],
      [
        commit('feat(a): the first thing', 'Because the old path was wrong.'),
        commit('fix(b): the second thing', 'And it turned out B depended on it.'),
      ],
    );

    expect(out).toContain('## What the commits say (2)');
    expect(out).toContain('### feat(a): the first thing');
    expect(out).toContain('Because the old path was wrong.');
    expect(out).toContain('### fix(b): the second thing');
    expect(out).toContain('And it turned out B depended on it.');
    expect(out.indexOf('feat(a)')).toBeLessThan(out.indexOf('fix(b)'));
  });

  it('a commit with an EMPTY body falls back to the card title, never a bare subject', () => {
    const out = renderSessionPrBody(
      '20260729-010203',
      BRANCH,
      [record('PROD-1', 'Wire the seam')],
      [commit('feat(seam): wire it')],
    );

    expect(out).toContain('### feat(seam): wire it');
    // Degrades to TODAY's output — the title — rather than to a heading with
    // nothing under it.
    expect(out).toContain('_Wire the seam_');
  });

  it('the FRAME is unchanged — run id, branch, carried, failed, close-out', () => {
    // This card trades nothing for what it adds: every string the manifest body
    // carried is still here, asserted verbatim.
    const out = renderSessionPrBody(
      '20260729-010203',
      BRANCH,
      [record('PROD-1', 'A'), record('PROD-9', 'Broke', 'failed')],
      [commit('feat(a): a', 'why')],
    );

    expect(out).toContain('Unattended `motir auto` run `20260729-010203`');
    expect(out).toContain(`integrated on \`${BRANCH}\``);
    expect(out).toContain('## Work items carried (1)');
    expect(out).toContain('- PROD-1 — A');
    expect(out).toContain('## Attempted and failed (1)');
    expect(out).toContain('- PROD-9 — Broke');
    expect(out).toContain(`motir done --session ${BRANCH}`);
    expect(out).toContain('Review this pull request as ONE unit.');
  });

  it('renders the manifest ALONE when no commits could be read', () => {
    // `sessionBranchCommits` yields `[]` on a failed git read rather than
    // throwing: by then the work is integrated and pushed, so a git hiccup must
    // degrade the body, never abandon the pull request.
    const out = renderSessionPrBody('20260729-010203', BRANCH, [record('PROD-1', 'A')], []);
    expect(out).not.toContain('## What the commits say');
    expect(out).toContain('- PROD-1 — A');
  });
});

describe('landedWork — the partition that used to be `!== failed` (MOTIR-3018)', () => {
  const rec = (
    over: Partial<DispatchRecord> & Pick<DispatchRecord, 'key' | 'outcome'>,
  ): DispatchRecord => ({
    title: `Item ${over.key}`,
    durationMs: 1000,
    sessionBranch: 'motir/run-1',
    repo: 'motir-core',
    parentKey: null,
    ...over,
  });

  it.each([
    ['integrated', true],
    ['implemented', true],
    ['failed', false],
    // The member the old spelling got wrong: a refused card put no code
    // anywhere, so it is not carried by a branch and not named in a pull
    // request.
    ['replanned', false],
  ] as const)('%s → %s', (outcome, expected) => {
    expect(landedWork({ outcome })).toBe(expected);
  });

  it('keeps a re-planned card out of the pull-request body and title', () => {
    const records: DispatchRecord[] = [
      rec({ key: 'PROD-1', title: 'Built it', outcome: 'integrated' }),
      rec({ key: 'PROD-2', title: 'Refused it', outcome: 'replanned', sessionBranch: null }),
    ];
    const body = renderSessionPrBody('20260819-010203', 'motir/run-1', records);
    expect(body).toContain('Work items carried (1)');
    expect(body).toContain('PROD-1');
    expect(body).not.toContain('PROD-2');
    // One carried card, so the title names it — not "2 work items".
    expect(sessionPrTitle('20260819-010203', records.filter(landedWork))).toContain('PROD-1');
  });

  it('names the re-planned card in the summary, as an outcome rather than a failure', () => {
    const summary: AutoSummary = {
      runId: '20260819-010203',
      records: [
        rec({ key: 'PROD-2', title: 'Refused it', outcome: 'replanned', sessionBranch: null }),
      ],
      skipped: [],
      planning: [],
      repos: [],
      prs: [],
      approvals: [],
      lanes: [],
      stopReason: 'replanned',
    };
    const text = renderAutoSummary(summary);
    expect(text).toContain('an agent refused its work item and submitted a re-plan');
    expect(text).toContain('Re-planned');
    expect(text).toContain('PROD-2');
    // Not listed as delivered work, and not as a failure.
    expect(text).not.toContain('Implemented — CI decides');
    expect(text).not.toContain('Failed — still In Progress');
    // A correct outcome exits 0.
    expect(autoExitCode(summary)).toBe(0);
  });
});

describe('the summary says what the run APPROVED (MOTIR-3023)', () => {
  const rec = (
    over: Partial<DispatchRecord> & Pick<DispatchRecord, 'key' | 'outcome'>,
  ): DispatchRecord => ({
    title: `Item ${over.key}`,
    durationMs: 1000,
    sessionBranch: null,
    repo: 'motir-core',
    parentKey: null,
    ...over,
  });

  const summary = (approvals: AutoSummary['approvals']): AutoSummary => ({
    runId: '20260819-010203',
    records: [rec({ key: 'PROD-7', outcome: 'replanned' })],
    skipped: [],
    planning: [],
    repos: [],
    prs: [],
    approvals,
    lanes: [],
    stopReason: 'drained',
  });

  it('names every plan and the card it was approved FOR', () => {
    // ⚠️ This is the one feature where a machine changes a person's plan while
    // they are not looking. A COUNT would tell them their tree moved without
    // telling them where.
    const text = renderAutoSummary(
      summary([{ key: 'PROD-7', planId: 'plan_abc', proposalCount: 3 }]),
    );
    expect(text).toContain('Plans APPROVED by this run');
    expect(text).toContain('your tree changed while you were away');
    expect(text).toContain('plan_abc');
    expect(text).toContain('approved for PROD-7');
    expect(text).toContain('3 proposals materialized');
    // And it says the card is held out, which is why re-running is what picks
    // the new work up.
    expect(text).toContain('held out of THIS run');
  });

  it('says nothing at all when nothing was approved', () => {
    expect(renderAutoSummary(summary([]))).not.toContain('Plans APPROVED');
  });

  it('does not tell the operator to review a plan this run already approved', () => {
    // The two blocks would otherwise contradict each other: one saying the plan
    // was approved, the next saying to go and review it.
    const text = renderAutoSummary(
      summary([{ key: 'PROD-7', planId: 'plan_abc', proposalCount: 1 }]),
    );
    expect(text).toContain('its plan was approved by this run');
    expect(text).not.toContain('review the submitted plan in Motir');
  });

  it('DOES tell them to review one it did not approve', () => {
    const text = renderAutoSummary(summary([]));
    expect(text).toContain('review the submitted plan in Motir');
  });

  it('singularises one proposal', () => {
    const text = renderAutoSummary(
      summary([{ key: 'PROD-7', planId: 'plan_abc', proposalCount: 1 }]),
    );
    expect(text).toContain('1 proposal materialized');
  });
});

// ── MOTIR-10983 — every card's agent is its OWN conversation ───────────────
//
// `motir auto` resolves its agent ONCE (`commands/auto.ts`). A profile with a
// `sessionIdFlag` had the id baked into that one command, so the second card spawned
// `claude … --session-id <the first card's id>` and Claude Code refused it.

describe('motir auto — each card spawns its own agent session (MOTIR-10983)', () => {
  const sessionIdOf = (command: ParsedAgentCommand): string | undefined => {
    const at = command.args.indexOf('--session-id');
    return at === -1 ? undefined : command.args[at + 1];
  };

  async function spawned(agent: ParsedAgentCommand) {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const spawns: Array<{ key: string; command: ParsedAgentCommand }> = [];
    const events: Record<string, unknown>[] = [];
    const { summary } = await drive(server, new FakeGit(), {
      agent,
      onSpawn: (key, command) => spawns.push({ key, command }),
      onEvent: (e) => events.push(e),
    });
    return { summary, spawns, events };
  }

  it('spawns every card with its own --session-id, records it, and resumes it', async () => {
    const agent = agentModeAgent({ MOTIR_SANDBOX_AGENT: 'claude' });
    const { summary, spawns, events } = await spawned(agent);

    expect(spawns.map((s) => s.key)).toEqual(['PROD-1', 'PROD-2']);
    const ids = spawns.map((s) => sessionIdOf(s.command));
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(agent.stream?.sessionId);
    const profile = AGENT_PROFILES.find((p) => p.id === 'claude')!.agentStream!;
    for (const { command } of spawns) {
      expect(command.args).toEqual([...profile.args, '--session-id', sessionIdOf(command)]);
      expect(command.stream).toEqual({ profile: 'claude', sessionId: sessionIdOf(command) });
    }

    // The id each card records — `agent_started`, then its dispatch record — is its own.
    const started = events.filter((e) => e['kind'] === 'agent_started');
    expect(
      started.map((e) => [e['workItemKey'], (e['data'] as { sessionId?: string }).sessionId]),
    ).toEqual([
      ['PROD-1', ids[0]],
      ['PROD-2', ids[1]],
    ]);
    expect(summary.records.map((r) => [r.key, r.sessionId])).toEqual([
      ['PROD-1', ids[0]],
      ['PROD-2', ids[1]],
    ]);
    // The CI watch builds each card's resume from its record (`watchRunCi`).
    for (const record of summary.records) {
      expect(resumeFixAgent(agent, record.sessionId, {})?.args).toEqual(
        profile.resumeArgs(record.sessionId!),
      );
    }
  });

  it('spawns a typed agent command, and a profile that picks its own id, exactly as resolved', async () => {
    for (const agent of [
      parseAgentCommand('claude -p --session-id fixed')!,
      agentModeAgent({ MOTIR_SANDBOX_AGENT: 'codex' }),
    ]) {
      const { spawns, events } = await spawned(agent);
      expect(spawns.map((s) => s.command)).toEqual([agent, agent]);
      // No id is invented for a command that carries none Motir chose.
      for (const e of events.filter((x) => x['kind'] === 'agent_started')) {
        expect(e['data']).toEqual({ agent: agent.binary });
      }
    }
  });
});
