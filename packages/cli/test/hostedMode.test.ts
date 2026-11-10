import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import { answerPrView } from './fakePullRequest.js';
import type { DispatchPrompt, DispatchRunView, WorkItemDetail } from '../src/client.js';
import {
  assertAdoptsLeaf,
  DEFAULT_HOSTED_WORKSPACE,
  hostedLink,
  hostedRunId,
  hostedWorkspace,
  legAsDispatchItem,
  projectKeyOf,
  readAdoptedRun,
  type AdoptedRun,
} from '../src/hostedMode.js';

// THE HOSTED MODE (Story MOTIR-683 · MOTIR-6558) — `motir run` on a run the
// SERVER opened, in a container with no `.motir.json`.
//
// What is under test is the one promise the decision makes about the CLI
// (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §3): the server opens
// the run with its legs and the CLI ADOPTS it. So every pipeline test below
// asserts the same three absences and one presence — no `openDispatchRun`, no
// scope claim, no ready read, and every event and the close on the ADOPTED run.
// The rest of a run is the local pipeline, unchanged, and its own suites cover it.

const { runAgentMock, sessionRef, adoptedRef, hostedCalls } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
  adoptedRef: { current: null as unknown },
  hostedCalls: [] as string[],
}));

vi.mock('../src/agentRun.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
  withHostedProjectSession: async (
    runId: string,
    fn: (s: unknown, run: unknown) => Promise<unknown>,
  ) => {
    hostedCalls.push(runId);
    return fn(sessionRef.current, adoptedRef.current);
  },
}));

const { runCommand } = await import('../src/commands/dispatch.js');

const SERVER = 'https://app.motir.co';
const OWNER = 'user_me';

// ── THE RUN CREDENTIAL'S ROUTE TABLE (MOTIR-6557) ────────────────────────────
// A hosted run's own credential reaches exactly the routes in
// `lib/hostedRuns/runTokenRoutes.ts`; anything else is refused. So every client
// METHOD the hosted pipelines below call is mapped to the `/api/v1` operations
// it requests — read from `client.ts` the way `tests/hostedRuns/
// runTokenRouteTable.test.ts` reads it — and each must be in the table. Read as
// TEXT: the CLI package does not import the app's `lib/`.
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function runTokenOperations(): Set<string> {
  const src = readFileSync(join(REPO, 'lib', 'hostedRuns', 'runTokenRoutes.ts'), 'utf8');
  const table = src.slice(
    src.indexOf('export const RUN_TOKEN_ROUTES'),
    src.indexOf('export const RUN_TOKEN_DENIED_CLI_OPERATIONS'),
  );
  return new Set([...table.matchAll(/operationId: '(\w+)'/g)].map((m) => m[1]!));
}

function clientOperationsByMethod(): Map<string, Set<string>> {
  const src = readFileSync(join(REPO, 'packages', 'cli', 'src', 'client.ts'), 'utf8');
  const heads = [...src.matchAll(/\n {2}(?:private )?(?:async )?\*?(\w+)(?:<[^>]*>)?\(/g)];
  const direct = new Map<string, { ops: Set<string>; calls: Set<string> }>();
  heads.forEach((h, i) => {
    const body = src.slice(h.index!, heads[i + 1]?.index ?? src.length);
    direct.set(h[1]!, {
      ops: new Set([...body.matchAll(/request\(\s*'(\w+)'/g)].map((m) => m[1]!)),
      calls: new Set([...body.matchAll(/this\.(\w+)\(/g)].map((m) => m[1]!)),
    });
  });
  const resolve = (name: string, seen: Set<string>): Set<string> => {
    const entry = direct.get(name);
    if (!entry || seen.has(name)) return new Set();
    seen.add(name);
    const ops = new Set(entry.ops);
    for (const c of entry.calls) for (const op of resolve(c, seen)) ops.add(op);
    return ops;
  };
  const out = new Map<string, Set<string>>();
  for (const name of direct.keys()) out.set(name, resolve(name, new Set()));
  return out;
}

/** Every operation the recorded client methods reach, and any that are off the table. */
function offTable(methods: readonly string[]): { unknown: string[]; denied: string[] } {
  const byMethod = clientOperationsByMethod();
  const allowed = runTokenOperations();
  const unknown = [...new Set(methods)].filter((m) => !byMethod.has(m));
  const denied = [...new Set(methods)]
    .flatMap((m) => [...(byMethod.get(m) ?? [])])
    .filter((op) => !allowed.has(op));
  return { unknown, denied: [...new Set(denied)].sort() };
}
const RUN = 'cmrun_hosted_1';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
/** The agent pushed: the remote carries the branch, the session branch a commit. */
const PUSHED: CommandRunner = (bin, args) => {
  // The pull request the agent opened, which the run links (MOTIR-10877).
  const pr = answerPrView(bin, args);
  if (pr) return pr;
  if (args[0] === 'ls-remote') return ok('abc123\trefs/heads/motir/auto-x');
  if (args[0] === 'log' || args[0] === 'rev-list') return ok(args[1] === '--count' ? '1' : 'abc');
  if (bin === 'gh' && args[1] === 'create')
    return ok('https://github.com/moooon/motir-core/pull/1');
  return ok('');
};

function detail(key: string, over: Partial<WorkItemDetail['item']> = {}, children: string[] = []) {
  return {
    item: {
      identifier: key,
      kind: children.length > 0 ? 'story' : 'subtask',
      title: `Item ${key}`,
      status: 'in_progress',
      priority: 'high',
      assigneeId: OWNER,
      type: children.length > 0 ? null : 'code',
      executor: children.length > 0 ? null : 'coding_agent',
      storyPoints: null,
      estimateMinutes: null,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
      ...over,
    },
    ancestors: [],
    children: children.map((c) => ({
      identifier: c,
      kind: 'subtask',
      title: `Item ${c}`,
      status: 'in_progress',
      dependencies: { blockedBy: [], blocks: [] },
    })),
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  } satisfies WorkItemDetail;
}

interface Harness {
  calls: { tool: string; args: unknown }[];
  /** Every client METHOD invoked, by its real name — what the route table is checked on. */
  methods: string[];
  stderr: string;
  root: string;
}

let harness: Harness;
let home: string;
const tmp: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(dir);
  return dir;
}

/**
 * The scripted server. `holder` names who the server says holds each card — the
 * dispatcher by default, because the server claimed every leg for them.
 */
function setup(opts: {
  details: Record<string, WorkItemDetail>;
  prompt: (key: string) => DispatchPrompt;
  adopted: AdoptedRun | null;
  holder?: Record<string, string>;
  root?: string;
  repos?: string[];
}) {
  const calls: Harness['calls'] = [];
  const root = opts.root ?? tempDir('motir-hosted-root-');
  for (const repo of opts.repos ?? ['motir-core']) mkdirSync(join(root, repo), { recursive: true });
  const record = (tool: string, args?: unknown) => calls.push({ tool, args });

  const client = {
    whoami: async () => {
      record('whoami');
      return { user: { id: OWNER, name: 'Me', email: 'me@motir.test' }, workspace: null };
    },
    me: async () => {
      record('me');
      return { id: OWNER, name: 'Me', email: 'me@motir.test' };
    },
    getWorkItem: async (key: string) => {
      record('get_work_item', key);
      const found = opts.details[key];
      if (!found) throw new Error(`no fixture for ${key}`);
      return found;
    },
    listReadyForDispatch: async (args: unknown) => {
      record('list_ready', args);
      return [];
    },
    claimScope: async (args: unknown) => {
      record('claim_scope', args);
      throw new Error('a hosted run never claims a scope');
    },
    claimWorkItem: async (args: { key: string }) => {
      record('claim', args);
      const holder = opts.holder?.[args.key] ?? OWNER;
      return resolveFakeClaim(
        { key: args.key, status: 'in_progress', assigneeId: holder },
        { id: OWNER, name: 'Me' },
        () => 'Ada',
      ).claim;
    },
    dispatchPrompt: async (key: string) => {
      record('dispatch_prompt', key);
      return opts.prompt(key);
    },
    listWorkItemDesigns: async () => ({ designs: [] }),
    transitionStatus: async (args: unknown) => {
      record('transition_status', args);
      return {};
    },
    markIntegrated: async (args: unknown) => {
      record('mark_integrated', args);
      return {};
    },
    linkWorkItemPullRequest: async (args: unknown) => {
      record('link_pull_request', args);
      return {};
    },
    // The run's own delivery (MOTIR-10877).
    linkPullRequest: async (args: unknown) => {
      record('link_pull_request', args);
    },
    workItemHowToTest: async () => ({ record: null }),
    dispatchRunCloseOutPrompt: async () => {
      throw new Error('no close-out prompt in this fixture');
    },
    openDispatchRun: async (args: unknown) => {
      record('open_dispatch_run', args);
      return { runId: 'cmrun_local', created: true, status: 'running', seq: 0, cards: [] };
    },
    appendDispatchRunEvents: async (args: { runId: string; events: unknown[] }) => {
      record('append_events', args);
      return { runId: args.runId, appended: args.events.length, seq: args.events.length };
    },
    closeDispatchRun: async (args: unknown) => {
      record('close_dispatch_run', args);
    },
  };

  const methods: string[] = [];
  const recording = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        methods.push(prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  sessionRef.current = {
    client: recording,
    serverUrl: SERVER,
    projectKey: 'PROD',
    link: hostedLink(root, SERVER, 'PROD', () => null),
  };
  adoptedRef.current = opts.adopted;

  harness = { calls, methods, stderr: '', root };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    harness.stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return harness;
}

const tools = () => harness.calls.map((c) => c.tool);
const callsTo = (tool: string) => harness.calls.filter((c) => c.tool === tool);

function leafPrompt(key: string, over: Partial<DispatchPrompt> = {}): DispatchPrompt {
  return {
    key,
    prompt: `PROMPT ${key}`,
    parentKey: null,
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    ...over,
  };
}

beforeEach(() => {
  home = tempDir('motir-hosted-cfg-');
  process.env['MOTIR_CONFIG_HOME'] = home;
  delete process.env['MOTIR_AGENT'];
  delete process.env['MOTIR_DISPATCH_RUN_ID'];
  hostedCalls.length = 0;
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  delete process.env['MOTIR_DISPATCH_RUN_ID'];
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

// ── the pure pieces ─────────────────────────────────────────────────────────

describe('hostedRunId / hostedWorkspace / projectKeyOf', () => {
  it('takes the flag over the env var, and treats an empty value as absent', () => {
    expect(hostedRunId({ runId: 'a' }, { MOTIR_DISPATCH_RUN_ID: 'b' })).toBe('a');
    expect(hostedRunId({}, { MOTIR_DISPATCH_RUN_ID: ' b ' })).toBe('b');
    expect(hostedRunId({ runId: '  ' }, { MOTIR_DISPATCH_RUN_ID: '' })).toBeNull();
    expect(hostedRunId({}, {})).toBeNull();
  });

  it('defaults the workspace to /workspace', () => {
    expect(hostedWorkspace({})).toBe(DEFAULT_HOSTED_WORKSPACE);
    expect(hostedWorkspace({ MOTIR_WORKSPACE: '' })).toBe(DEFAULT_HOSTED_WORKSPACE);
    expect(hostedWorkspace({ MOTIR_WORKSPACE: '/srv/ws' })).toBe('/srv/ws');
  });

  it('reads the project from a card key, splitting on the LAST dash', () => {
    expect(projectKeyOf('MOTIR-683')).toBe('MOTIR');
    expect(projectKeyOf('MY-PROJ-12')).toBe('MY-PROJ');
    expect(() => projectKeyOf('nodash')).toThrow(/not a work item key/);
  });
});

describe('readAdoptedRun', () => {
  const view = (over: Partial<DispatchRunView> = {}): DispatchRunView => ({
    runId: RUN,
    status: 'running',
    command: 'run',
    origin: 'hosted',
    model: 'claude-opus-5',
    endedAt: null,
    cards: [
      { key: 'PROD-2', position: 0, disposition: 'queued' },
      { key: 'PROD-3', position: 1, disposition: 'running' },
      { key: 'PROD-4', position: 2, disposition: 'skipped' },
      { key: null, position: 3, disposition: 'queued' },
    ],
    ...over,
  });

  it('keeps the dispatchable legs in the run’s own order and takes the project from them', async () => {
    const run = await readAdoptedRun({ getDispatchRun: async () => view() }, RUN);
    expect(run).toEqual({ runId: RUN, projectKey: 'PROD', legs: ['PROD-2', 'PROD-3'] });
  });

  it('refuses a run that has already ended — a second boot must not re-run finished work', async () => {
    await expect(
      readAdoptedRun(
        { getDispatchRun: async () => view({ status: 'failed', endedAt: '2026-09-26T00:00:00Z' }) },
        RUN,
      ),
    ).rejects.toThrow(/already ended \(failed\)/);
  });

  it('refuses a run with nothing left to dispatch', async () => {
    await expect(
      readAdoptedRun(
        {
          getDispatchRun: async () =>
            view({ cards: [{ key: 'PROD-2', position: 0, disposition: 'implemented' }] }),
        },
        RUN,
      ),
    ).rejects.toThrow(/no card left to dispatch/);
  });

  it('adopts a leaf only when the card is one of the run’s legs', () => {
    const run: AdoptedRun = { runId: RUN, projectKey: 'PROD', legs: ['PROD-2'] };
    expect(() => assertAdoptsLeaf(run, 'PROD-2')).not.toThrow();
    expect(() => assertAdoptsLeaf(run, 'PROD-9')).toThrow(/PROD-9 is not a card of run/);
  });
});

describe('hostedLink / legAsDispatchItem', () => {
  it('synthesises the link at the workspace when there is no .motir.json, and keeps a real one', () => {
    const synth = hostedLink('/workspace', SERVER, 'PROD', () => null);
    expect(synth).toEqual({
      dir: '/workspace',
      path: '/workspace/.motir.json',
      config: { serverUrl: SERVER, workspace: '', project: 'PROD' },
    });
    const real = { dir: '/w', path: '/w/.motir.json', config: synth.config };
    expect(hostedLink('/workspace', SERVER, 'PROD', () => real)).toBe(real);
  });

  it('builds a scope member from its card, carrying what the drain reads', () => {
    expect(legAsDispatchItem(detail('PROD-2', { type: 'decision', executor: 'human' }))).toEqual({
      key: 'PROD-2',
      kind: 'subtask',
      title: 'Item PROD-2',
      priority: 'high',
      status: { key: 'in_progress', category: 'in_progress' },
      type: 'decision',
      executor: 'human',
      assigneeId: OWNER,
      inheritedSessionBranch: null,
    });
  });
});

// ── the pipeline ────────────────────────────────────────────────────────────

describe('motir run <leaf> in hosted mode', () => {
  it('ADOPTS the run — every event and the close go to it, and nothing opens a second', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });

    await runCommand('PROD-7', { agent: 'fake-agent', runId: RUN }, { run: PUSHED });

    expect(hostedCalls).toEqual([RUN]);
    expect(tools()).not.toContain('open_dispatch_run');
    // The card the server claimed for this dispatcher is re-asserted, not refused.
    expect(callsTo('claim')).toEqual([{ tool: 'claim', args: { key: 'PROD-7' } }]);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const appends = callsTo('append_events').map((c) => (c.args as { runId: string }).runId);
    expect(appends.length).toBeGreaterThan(0);
    expect(new Set(appends)).toEqual(new Set([RUN]));
    // `run_opened` is the START PATH's event, written with the run it opened.
    const kinds = callsTo('append_events').flatMap((c) =>
      (c.args as { events: { kind: string }[] }).events.map((e) => e.kind),
    );
    expect(kinds).not.toContain('run_opened');
    expect(kinds).toContain('card_settled');
    expect(callsTo('close_dispatch_run')).toEqual([
      { tool: 'close_dispatch_run', args: { runId: RUN, stopReason: 'completed' } },
    ]);
  });

  it('calls ONLY routes the run credential reaches (the MOTIR-6557 table) — the dispatcher from getMe alone', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });

    await runCommand('PROD-7', { agent: 'fake-agent', runId: RUN }, { run: PUSHED });

    expect(harness.methods).toContain('me');
    expect(harness.methods).not.toContain('whoami');
    expect(offTable(harness.methods)).toEqual({ unknown: [], denied: [] });
  });

  it('refuses --include-planning before reading anything — expansion is not a run’s to make', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });

    await expect(
      runCommand('PROD-7', { agent: 'fake-agent', runId: RUN, includePlanning: true }),
    ).rejects.toThrow(/--include-planning. is not available on a hosted run/);
    expect(hostedCalls).toEqual([]);
    expect(harness.methods).toEqual([]);
  });

  it('refuses a card that is not one of the run’s legs, before claiming anything', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-9'] },
    });

    await expect(
      runCommand('PROD-7', { agent: 'fake-agent', runId: RUN }, { run: PUSHED }),
    ).rejects.toThrow(/PROD-7 is not a card of run/);
    expect(tools()).not.toContain('claim');
  });

  it('refuses to fall back to PRINT mode — nobody is there to paste a prompt', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });

    await expect(
      runCommand('PROD-7', { runId: RUN, print: true }, { run: PUSHED }),
    ).rejects.toThrow(/hosted run needs an agent/);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('with no --agent, launches its OWN OpenCode on the run model — never MOTIR_AGENT (MOTIR-6559)', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });
    const saved = { ...process.env };
    Object.assign(process.env, {
      MOTIR_AGENT: 'claude --dangerously-skip-permissions',
      MOTIR_MODEL: 'anthropic/claude-sonnet-5',
      MOTIR_GATEWAY_URL: 'https://gateway.test',
      MOTIR_RUN_KEY: 'rk_live_secret',
      MOTIR_RUN_TOKEN: 'mrt_run_secret',
    });
    try {
      await runCommand('PROD-7', { runId: RUN }, { run: PUSHED });
    } finally {
      for (const k of ['MOTIR_MODEL', 'MOTIR_GATEWAY_URL', 'MOTIR_RUN_KEY', 'MOTIR_RUN_TOKEN']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const command = runAgentMock.mock.calls[0]![0].command as {
      binary: string;
      args: string[];
      env: NodeJS.ProcessEnv;
    };
    expect(command.binary).toBe('opencode');
    expect(command.args).toEqual(['run', '--model', 'anthropic/claude-sonnet-5', '--auto']);
    expect(command.env['MOTIR_RUN_TOKEN']).toBeUndefined();
    expect(command.env['MOTIR_AGENT']).toBeUndefined();
  });

  it('without the run model env, the hosted launcher refuses before anything is spawned', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });

    await expect(runCommand('PROD-7', { runId: RUN }, { run: PUSHED })).rejects.toThrow(
      /hosted run is missing MOTIR_MODEL, MOTIR_GATEWAY_URL, MOTIR_RUN_KEY/,
    );
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('enters hosted mode from MOTIR_DISPATCH_RUN_ID alone', async () => {
    process.env['MOTIR_DISPATCH_RUN_ID'] = RUN;
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) => leafPrompt(k),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
    });

    await runCommand('PROD-7', { agent: 'fake-agent' }, { run: PUSHED });

    expect(hostedCalls).toEqual([RUN]);
    expect(tools()).not.toContain('open_dispatch_run');
  });

  it('clones a two-repository card as siblings under an EMPTY workspace with no .motir.json', async () => {
    // Real bare remotes, so the clone is a real `git clone` into the workspace.
    const remotes = tempDir('motir-hosted-remotes-');
    const url = (name: string) => {
      const path = join(remotes, `${name}.git`);
      execFileSync('git', ['init', '--quiet', '--bare', path]);
      return path;
    };
    const workspace = tempDir('motir-hosted-ws-');
    setup({
      details: { 'PROD-7': detail('PROD-7') },
      prompt: (k) =>
        leafPrompt(k, {
          targetRepos: [
            { name: 'motir-core', cloneUrl: url('motir-core') },
            { name: 'motir-ai', cloneUrl: url('motir-ai') },
          ],
        } as Partial<DispatchPrompt>),
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-7'] },
      root: workspace,
      repos: [],
    });

    await runCommand('PROD-7', { agent: 'fake-agent', runId: RUN }, { run: PUSHED });

    expect(existsSync(join(workspace, '.motir.json'))).toBe(false);
    expect(existsSync(join(workspace, 'motir-core', '.git'))).toBe(true);
    expect(existsSync(join(workspace, 'motir-ai', '.git'))).toBe(true);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });
});

describe('the route-table check is not vacuous', () => {
  it('flags a method whose operation the run credential is refused, and one the client lacks', () => {
    expect(offTable(['whoami'])).toEqual({ unknown: [], denied: ['listWorkspaces'] });
    expect(offTable(['openDispatchRun']).denied).toEqual(['openDispatchRun']);
    expect(offTable(['notAClientMethod']).unknown).toEqual(['notAClientMethod']);
  });
});

describe('motir run <leaf> locally — unchanged', () => {
  it('opens its own run exactly as before when no run id is given', async () => {
    setup({
      details: { 'PROD-7': detail('PROD-7', { status: 'todo', assigneeId: null }) },
      prompt: (k) => leafPrompt(k),
      adopted: null,
    });

    await runCommand('PROD-7', { agent: 'fake-agent' }, { run: PUSHED });

    expect(hostedCalls).toEqual([]);
    expect(callsTo('open_dispatch_run')).toHaveLength(1);
    expect(callsTo('close_dispatch_run')).toEqual([
      { tool: 'close_dispatch_run', args: { runId: 'cmrun_local', stopReason: 'completed' } },
    ]);
  });
});

describe('motir run <parent> in hosted mode', () => {
  const scopeFixture = (holder?: Record<string, string>) =>
    setup({
      details: {
        'PROD-1': detail('PROD-1', {}, ['PROD-2', 'PROD-3']),
        'PROD-2': detail('PROD-2'),
        'PROD-3': detail('PROD-3'),
      },
      prompt: (k) =>
        leafPrompt(k, { parentKey: 'PROD-1', workflowMode: 'session_lineage', sessionBranch: 'b' }),
      // The run's own order — the drain works it, never a re-derived one.
      adopted: { runId: RUN, projectKey: 'PROD', legs: ['PROD-3', 'PROD-2'] },
      ...(holder ? { holder } : {}),
    });

  it('works the run’s legs without claiming a scope, reading a ready set, or opening a run', async () => {
    scopeFixture();

    await runCommand('PROD-1', { agent: 'fake-agent', runId: RUN }, { run: PUSHED });

    expect(tools()).not.toContain('claim_scope');
    expect(tools()).not.toContain('list_ready');
    expect(tools()).not.toContain('open_dispatch_run');
    // Each leg re-claimed through the ordinary per-card claim, in the run's order.
    expect(callsTo('claim').map((c) => (c.args as { key: string }).key)).toEqual([
      'PROD-3',
      'PROD-2',
    ]);
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    const appends = new Set(
      callsTo('append_events').map((c) => (c.args as { runId: string }).runId),
    );
    expect(appends).toEqual(new Set([RUN]));
    const closes = callsTo('close_dispatch_run');
    expect(closes).toHaveLength(1);
    expect((closes[0]?.args as { runId: string }).runId).toBe(RUN);
    // …and every call it made is one the run credential reaches.
    expect(offTable(harness.methods)).toEqual({ unknown: [], denied: [] });
  });

  it('refuses a leg somebody else holds, as a local run does, and keeps going', async () => {
    scopeFixture({ 'PROD-3': 'user_other' });

    await runCommand('PROD-1', { agent: 'fake-agent', runId: RUN }, { run: PUSHED });

    // PROD-3 is refused (`taken`), and the unattended run carries on to PROD-2.
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(harness.stderr).toMatch(/PROD-3/);
    expect(callsTo('dispatch_prompt').map((c) => c.args)).toContain('PROD-2');
  });
});

describe('the scope drain clones only in hosted mode', () => {
  it('materializes a missing repository before the session branch — and a local scope does not', async () => {
    const { drainScope } = await import('../src/commands/scopeDrain.js');
    const cloned: string[][] = [];
    const run: CommandRunner = (bin, args) => {
      if (bin === 'git' && args[0] === 'clone') {
        cloned.push(args);
        mkdirSync(join(args[2] as string, '.git'), { recursive: true });
        return ok('');
      }
      return PUSHED(bin, args, '');
    };
    const drainOnce = async (materialize: boolean) => {
      const root = tempDir('motir-hosted-drain-');
      writeFileSync(join(root, 'marker'), '');
      setup({
        details: { 'PROD-2': detail('PROD-2') },
        prompt: (k) =>
          leafPrompt(k, {
            parentKey: 'PROD-1',
            targetRepos: [{ name: 'motir-ai', cloneUrl: 'https://example.test/motir-ai.git' }],
          } as Partial<DispatchPrompt>),
        adopted: null,
        root,
        repos: [],
      });
      const session = sessionRef.current as Parameters<typeof drainScope>[0]['session'];
      await drainScope({
        session,
        opts: { agent: 'fake-agent' },
        members: [legAsDispatchItem(detail('PROD-2'))],
        edges: { 'PROD-2': [] },
        max: null,
        agent: {
          parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] },
          source: 'flag',
        },
        runId: 'r',
        branch: 'motir/auto-r',
        run,
        clock: () => 0,
        runAgentFn: runAgentMock,
        materialize,
      });
      return root;
    };

    const hostedRoot = await drainOnce(true);
    expect(cloned).toEqual([
      ['clone', 'https://example.test/motir-ai.git', join(hostedRoot, 'motir-ai')],
    ]);

    cloned.length = 0;
    await drainOnce(false);
    expect(cloned).toEqual([]);
  });
});
