import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import { answerPrView, FAKE_PULL_REQUEST_URL } from './fakePullRequest.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { DispatchPrompt, WorkItemDetail } from '../src/client.js';
import type { RunAgentOptions } from '../src/agentRun.js';
import type { InterruptSignal } from '../src/interrupt.js';

// AGENT MODE (Story MOTIR-6864 · MOTIR-7024; `docs/decisions/agent-instance-run.md`
// §2–§3) — `motir run <KEY> --run-id <id>` started by an agent's terminal server
// with `MOTIR_AGENT_RUN=1` and `MOTIR_HOSTED_STATE=/tmp/motir-run-<id>`.
//
// The session is REAL (`withHostedProjectSession`'s agent arm, the run-private
// state and workspace, `prepareHostedRun`, the adopt), and so are the clones
// (bare remotes on disk). Only three things are stood in for: the Motir server
// (a `MotirClient` that records who constructed it and every call), the agent
// (`runAgent`, whose options ARE the spawn's command and environment), and the
// leg's git probes (`deps.run`). What is asserted is the card's promise: the
// run is ADOPTED on the run token read from `run.json`, the agent is the image's
// own on its own sign-in with no Motir credential in its environment, and the
// developer's home is byte-identical afterwards on every way the run ends.

const { h, runAgentMock } = vi.hoisted(() => ({
  h: {
    constructed: [] as { serverUrl: string; token: string }[],
    calls: [] as { tool: string; args: unknown }[],
    details: {} as Record<string, unknown>,
    prompt: (_key: string): unknown => null,
    legs: [] as string[],
  },
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agentRun.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agentRun.js')>()),
  runAgent: runAgentMock,
}));

vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>();
  const record = (tool: string, args?: unknown) => h.calls.push({ tool, args });
  class FakeMotirClient {
    constructor(opts: { serverUrl: string; token: string }) {
      h.constructed.push({ serverUrl: opts.serverUrl, token: opts.token });
    }
    async getDispatchRun(id: string) {
      record('get_run', id);
      return {
        runId: id,
        status: 'running',
        command: 'run',
        origin: 'instance',
        model: null,
        endedAt: null,
        cards: h.legs.map((key, position) => ({ key, position, disposition: 'queued' })),
      };
    }
    async issueRunGitCredentials(id: string) {
      record('git_credential', id);
      return {
        dispatchedBy: 'Zhu Yue',
        credentials: [
          {
            repository: 'acme/motir-core',
            token: 'ghs_app_token',
            expiresAt: '2099-01-01T00:00:00.000Z',
            authorName: 'motir-studio[bot]',
            authorEmail: '1+motir-studio[bot]@users.noreply.github.com',
          },
        ],
      };
    }
    async me() {
      record('me');
      return { id: 'user_me', name: 'Me', email: 'me@motir.test' };
    }
    async whoami() {
      record('whoami');
      return { user: { id: 'user_me', name: 'Me', email: 'me@motir.test' }, workspace: null };
    }
    async getWorkItem(key: string) {
      record('get_work_item', key);
      const found = h.details[key];
      if (!found) throw new Error(`no fixture for ${key}`);
      return found;
    }
    async claimScope() {
      throw new Error('an agent-mode run never claims a scope');
    }
    async claimWorkItem(args: { key: string }) {
      record('claim', args);
      return resolveFakeClaim(
        { key: args.key, status: 'in_progress', assigneeId: 'user_me' },
        { id: 'user_me', name: 'Me' },
        () => 'Ada',
      ).claim;
    }
    async dispatchPrompt(key: string) {
      record('dispatch_prompt', key);
      return h.prompt(key);
    }
    async listWorkItemDesigns() {
      return { designs: [] };
    }
    async transitionStatus(args: unknown) {
      record('transition_status', args);
      return {};
    }
    async markIntegrated(args: unknown) {
      record('mark_integrated', args);
      return {};
    }
    async linkWorkItemPullRequest(args: unknown) {
      record('link_pull_request', args);
      return {};
    }
    // The run's own delivery (MOTIR-10877): the link, and the How to test on the run's door.
    async linkPullRequest(args: unknown) {
      record('link_pull_request', args);
    }
    async publishDispatchRunHowToTest(args: unknown) {
      record('publish_how_to_test', args);
      return { testInstructionsId: 'ti_1', created: true };
    }
    async workItemHowToTest() {
      return { record: null };
    }
    async dispatchRunCloseOutPrompt() {
      throw new Error('no close-out prompt in this fixture');
    }
    async openDispatchRun(args: unknown) {
      record('open_dispatch_run', args);
      return { runId: 'never', created: true, status: 'running', seq: 0, cards: [] };
    }
    async appendDispatchRunEvents(args: { runId: string; events: unknown[] }) {
      record('append_events', args);
      return { runId: args.runId, appended: args.events.length, seq: args.events.length };
    }
    async closeDispatchRun(args: unknown) {
      record('close_dispatch_run', args);
    }
  }
  return { ...actual, MotirClient: FakeMotirClient };
});

const { runCommand } = await import('../src/commands/dispatch.js');
const { resetHostedRun } = await import('../src/hostedAttribution.js');
const { gitCredentialCommand } = await import('../src/hostedGit.js');
const { pinAgentRunStateHome } = await import('../src/hostedMode.js');

const RUN = 'cmrun_agent_1';
const SERVER = 'https://motir.test';
const RUN_TOKEN = 'mrt_run_secret';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const PUSHED: CommandRunner = (bin, args) => {
  // The pull request the agent opened, which the run links (MOTIR-10877).
  const pr = answerPrView(bin, args);
  if (pr) return pr;
  if (args[0] === 'ls-remote') return ok('abc123\trefs/heads/motir/auto-x');
  if (args[0] === 'log' || args[0] === 'rev-list') return ok(args[1] === '--count' ? '1' : 'abc');
  return ok('');
};

function detail(key: string, children: string[] = []): WorkItemDetail {
  return {
    item: {
      identifier: key,
      kind: children.length > 0 ? 'story' : 'subtask',
      title: `Item ${key}`,
      status: 'in_progress',
      priority: 'high',
      assigneeId: 'user_me',
      type: children.length > 0 ? null : 'code',
      executor: children.length > 0 ? null : 'coding_agent',
      storyPoints: null,
      estimateMinutes: null,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
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
  } as unknown as WorkItemDetail;
}

const ENV_NAMES = [
  'HOME',
  'MOTIR_AGENT_RUN',
  'MOTIR_HOSTED_STATE',
  'MOTIR_SANDBOX_AGENT',
  'MOTIR_WORKSPACE',
  'MOTIR_TOKEN',
  'MOTIR_RUN_TOKEN',
  'MOTIR_AGENT',
  'MOTIR_DISPATCH_RUN_ID',
  'MOTIR_CONFIG_HOME',
  'MOTIR_STATE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'GIT_CONFIG_GLOBAL',
  'GIT_TERMINAL_PROMPT',
  'GH_CONFIG_DIR',
  'GH_NO_UPDATE_NOTIFIER',
  'PATH',
  'CLAUDE_CONFIG_DIR',
] as const;
const saved: Record<string, string | undefined> = {};
const tmp: string[] = [];
let home: string;
let stateDir: string;
let remotes: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(dir);
  return dir;
}

/** Every file and directory under `root`, with each file's bytes — the home as it stands. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) {
        out[`${key}/`] = '';
        walk(path, key);
      } else {
        out[key] = readFileSync(path, 'utf8');
      }
    }
  };
  walk(root, '');
  return out;
}

function bareRemote(name: string): string {
  const path = join(remotes, `${name}.git`);
  if (!existsSync(path)) execFileSync('git', ['init', '--quiet', '--bare', path]);
  return path;
}

function prompt(key: string, repos: string[], over: Partial<DispatchPrompt> = {}): DispatchPrompt {
  return {
    key,
    prompt: `PROMPT ${key}`,
    parentKey: null,
    targetRepo: repos[0]!,
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    targetRepos: repos.map((name) => ({ name, cloneUrl: bareRemote(name) })),
    ...over,
  } as DispatchPrompt;
}

beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  for (const name of ENV_NAMES) if (name !== 'PATH') delete process.env[name];
  home = tempDir('motir-agent-home-');
  remotes = tempDir('motir-agent-remotes-');
  stateDir = join(tempDir('motir-agent-tmp-'), `motir-run-${RUN}`);
  // The DEVELOPER'S home as they keep it: their own git identity, their own
  // `gh` login, and a checkout of their own with its own `.git/config`.
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Dev\n\temail = dev@example.test\n');
  mkdirSync(join(home, '.config', 'gh'), { recursive: true });
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n  user: dev\n');
  const own = join(home, 'workspace', 'motir-core');
  mkdirSync(own, { recursive: true });
  execFileSync('git', ['init', '--quiet', own]);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"signedIn":true}');

  // What the terminal server's launcher hands the run session (MOTIR-7025).
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, 'run.json'),
    JSON.stringify({ apiUrl: SERVER, runId: RUN, token: RUN_TOKEN }),
    { mode: 0o600 },
  );
  Object.assign(process.env, {
    HOME: home,
    MOTIR_AGENT_RUN: '1',
    MOTIR_HOSTED_STATE: stateDir,
    MOTIR_SANDBOX_AGENT: 'claude',
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    // The developer's OWN credential in the session's environment — which the
    // run must neither use nor hand its agent.
    MOTIR_TOKEN: 'mtk_developer_pat',
    MOTIR_AGENT: 'codex --yolo',
  });
  pinAgentRunStateHome();

  h.constructed.length = 0;
  h.calls.length = 0;
  h.details = {};
  h.legs = [];
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  resetHostedRun();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const tools = () => h.calls.map((c) => c.tool);
const callsTo = (tool: string) => h.calls.filter((c) => c.tool === tool);
const eventKinds = () =>
  callsTo('append_events').flatMap((c) =>
    (c.args as { events: { kind: string }[] }).events.map((e) => e.kind),
  );

function assertAdoptedAndClean(before: Record<string, string>, stopReason: string) {
  // ADOPTED on the run token from `run.json` — never the developer's PAT.
  expect(h.constructed.map((c) => c.token)).not.toContain('mtk_developer_pat');
  expect(new Set(h.constructed.map((c) => c.token))).toEqual(new Set([RUN_TOKEN]));
  expect(new Set(h.constructed.map((c) => c.serverUrl))).toEqual(new Set([SERVER]));
  expect(tools()).not.toContain('open_dispatch_run');
  expect(callsTo('get_run')).toEqual([{ tool: 'get_run', args: RUN }]);
  expect(callsTo('git_credential')).toEqual([{ tool: 'git_credential', args: RUN }]);
  const runs = new Set(callsTo('append_events').map((c) => (c.args as { runId: string }).runId));
  expect(runs).toEqual(new Set([RUN]));
  expect(eventKinds()).toContain('agent_started');
  expect(callsTo('close_dispatch_run')).toEqual([
    { tool: 'close_dispatch_run', args: { runId: RUN, stopReason } },
  ]);
  // …and nothing of the run outlives it.
  expect(existsSync(stateDir)).toBe(false);
  expect(existsSync(join(home, '.motir'))).toBe(false);
  expect(snapshot(home)).toEqual(before);
}

function agentOptions(call = 0): RunAgentOptions {
  return runAgentMock.mock.calls[call]![0] as RunAgentOptions;
}

describe('motir run in agent mode — adopt, the image’s own agent, and a clean home', () => {
  it('a single-repository leaf: adopted on the run token, run by claude, and the home unchanged', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core']);
    const before = snapshot(home);
    const seen: { workspace?: boolean; credential?: string } = {};
    runAgentMock.mockImplementation(async (opts: RunAgentOptions) => {
      // While the agent runs, its checkout is the run's — not the developer's.
      seen.workspace = opts.cwd.startsWith(join(home, '.motir', 'runs', RUN));
      // git reaches GitHub through the helper, which reads the RUN's state.
      let out = '';
      await gitCredentialCommand(['--state', opts.command.env!['MOTIR_HOSTED_STATE']!, 'get'], {
        stdin: 'protocol=https\nhost=github.com\npath=acme/motir-core.git\n',
        write: (s) => (out += s),
      });
      seen.credential = out;
      return { exitCode: 0, signal: null, model: null };
    });

    await runCommand('PROD-7', { runId: RUN }, { run: PUSHED });

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const { command } = agentOptions();
    expect(command.binary).toBe('claude');
    // The STREAMING form (MOTIR-8980): its output reaches Motir while the agent works.
    expect(command.args.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]);
    expect(command.stream).toEqual({ profile: 'claude', sessionId: expect.any(String) });
    // The session's environment, extended: the agent's sign-in stays reachable…
    expect(command.env!['CLAUDE_CONFIG_DIR']).toBe(join(home, '.claude'));
    // …the run's git setup is in it, and no Motir or git credential is.
    expect(command.env!['GIT_CONFIG_GLOBAL']).toBe(join(stateDir, 'gitconfig'));
    expect(command.env!['GH_CONFIG_DIR']).toBe(join(stateDir, 'gh'));
    for (const name of ['MOTIR_TOKEN', 'MOTIR_RUN_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      expect(command.env![name]).toBeUndefined();
    }
    const flat = JSON.stringify(command.env);
    expect(flat).not.toContain(RUN_TOKEN);
    expect(flat).not.toContain('ghs_app_token');
    expect(flat).not.toContain('mtk_developer_pat');
    // The run's own git instructions ride on the prompt.
    expect(command.promptAddendum?.()).toMatch(/HOSTED RUN — git and pull requests/);
    expect(seen.workspace).toBe(true);
    expect(seen.credential).toBe('username=x-access-token\npassword=ghs_app_token\n');
    expect(callsTo('transition_status')).toEqual([
      { tool: 'transition_status', args: { key: 'PROD-7', status: 'implemented' } },
    ]);
    assertAdoptedAndClean(before, 'completed');
  });

  it('a two-repository leaf clones both into the run’s workspace, and removes both', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core', 'motir-ai']);
    const before = snapshot(home);
    const cloned: boolean[] = [];
    runAgentMock.mockImplementation(async () => {
      const root = join(home, '.motir', 'runs', RUN);
      cloned.push(existsSync(join(root, 'motir-core', '.git')));
      cloned.push(existsSync(join(root, 'motir-ai', '.git')));
      return { exitCode: 0, signal: null, model: null };
    });

    await runCommand('PROD-7', { runId: RUN }, { run: PUSHED });

    expect(cloned).toEqual([true, true]);
    assertAdoptedAndClean(before, 'completed');
  });

  it('a parent card works the run’s legs in its order, then leaves nothing behind', async () => {
    h.legs = ['PROD-3', 'PROD-2'];
    h.details = {
      'PROD-1': detail('PROD-1', ['PROD-2', 'PROD-3']),
      'PROD-2': detail('PROD-2'),
      'PROD-3': detail('PROD-3'),
    };
    h.prompt = (k) =>
      prompt(k, ['motir-core'], {
        parentKey: 'PROD-1',
        workflowMode: 'session_lineage',
        sessionBranch: 'b',
      });
    const before = snapshot(home);

    await runCommand('PROD-1', { runId: RUN }, { run: PUSHED });

    expect(callsTo('claim').map((c) => (c.args as { key: string }).key)).toEqual([
      'PROD-3',
      'PROD-2',
    ]);
    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(agentOptions(1).command.binary).toBe('claude');
    const closes = callsTo('close_dispatch_run');
    expect(closes).toHaveLength(1);
    expect((closes[0]!.args as { runId: string }).runId).toBe(RUN);
    expect(existsSync(stateDir)).toBe(false);
    expect(snapshot(home)).toEqual(before);
  });

  it('a FAILED agent: the run closes halted, and the home is still unchanged', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core']);
    const before = snapshot(home);
    runAgentMock.mockImplementation(async () => ({ exitCode: 3, signal: null, model: null }));

    await runCommand('PROD-7', { runId: RUN }, { run: PUSHED });

    expect(process.exitCode).toBe(3);
    assertAdoptedAndClean(before, 'halted');
  });

  it('SIGTERM: the interrupt closes the run and the exit path removes everything', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core']);
    const before = snapshot(home);
    // The process's `exit` listeners, captured instead of registered — the
    // interrupt ends the process with `exit`, which is what fires them.
    const exitListeners: (() => void)[] = [];
    const realOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, fn: () => void) => {
      if (event === 'exit') {
        exitListeners.push(fn);
        return process;
      }
      return realOn(event, fn);
    }) as typeof process.on);
    let handler: ((signal: InterruptSignal) => void) | null = null;
    const exits: number[] = [];
    const afterExit: { state?: boolean; workspace?: boolean } = {};
    runAgentMock.mockImplementation(async () => {
      handler!('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 20));
      afterExit.state = existsSync(stateDir);
      afterExit.workspace = existsSync(join(home, '.motir'));
      return { exitCode: 143, signal: 'SIGTERM', model: null };
    });

    await runCommand(
      'PROD-7',
      { runId: RUN },
      {
        run: PUSHED,
        onInterrupt: (fn) => {
          handler = fn;
          return () => undefined;
        },
        exit: (code) => {
          exits.push(code);
          for (const listener of exitListeners.splice(0)) listener();
        },
      },
    );

    expect(exits).toEqual([143]);
    expect(afterExit).toEqual({ state: false, workspace: false });
    expect(callsTo('close_dispatch_run')[0]).toEqual({
      tool: 'close_dispatch_run',
      args: { runId: RUN, stopReason: 'interrupted' },
    });
    expect(existsSync(stateDir)).toBe(false);
    expect(snapshot(home)).toEqual(before);
  });

  it('refuses a profile with no unattended command before anything is claimed, and still cleans up', async () => {
    process.env['MOTIR_SANDBOX_AGENT'] = 'cursor';
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core']);
    const before = snapshot(home);

    await expect(runCommand('PROD-7', { runId: RUN }, { run: PUSHED })).rejects.toMatchObject({
      code: 'agent_profile_cannot_run',
      profile: 'cursor',
    });
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(existsSync(stateDir)).toBe(false);
    expect(snapshot(home)).toEqual(before);
  });

  it('refuses a run.json written for another run, without reading the run', async () => {
    writeFileSync(
      join(stateDir, 'run.json'),
      JSON.stringify({ apiUrl: SERVER, runId: 'cmrun_other', token: RUN_TOKEN }),
    );

    await expect(runCommand('PROD-7', { runId: RUN }, { run: PUSHED })).rejects.toThrow(
      /is for run cmrun_other, not cmrun_agent_1/,
    );
    expect(h.calls).toEqual([]);
  });
});

describe('an agent with NO Motir tools — the run delivers for it (MOTIR-10877)', () => {
  it('links the pull request the agent opened, publishes its How to test, and only then moves the card', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core'], { workBranch: 'subtask/PROD-7-add-the-thing' });
    // The agent could call none of `link_pull_request`, `publish_test_instructions` or
    // `transition_status`: it wrote the pull request and its How to test into its self-report.
    runAgentMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      model: 'claude-opus-5-5',
      pullRequests: [FAKE_PULL_REQUEST_URL],
      howToTest: { bodyMd: '## Locally\n\n```sh\npnpm test\n```', previewPath: null },
    }));

    await runCommand('PROD-7', { runId: RUN }, { run: PUSHED });

    // The link, with the head and base `gh` read off the pull request itself.
    expect(callsTo('link_pull_request')).toEqual([
      {
        tool: 'link_pull_request',
        args: {
          key: 'PROD-7',
          url: FAKE_PULL_REQUEST_URL,
          headRef: 'subtask/PROD-7-add-the-thing',
          baseRef: 'main',
        },
      },
    ]);
    // The How to test, on the RUN's door, with the repository's pushed head.
    expect(callsTo('publish_how_to_test')).toEqual([
      {
        tool: 'publish_how_to_test',
        args: {
          runId: RUN,
          key: 'PROD-7',
          bodyMd: '## Locally\n\n```sh\npnpm test\n```',
          repos: [
            { repo: 'acme/motir-core', commitSha: 'abc1234def5678abc1234def5678abc1234def56' },
          ],
        },
      },
    ]);
    // …and the ORDER is the point: linked, then How to test, then Implemented.
    const link = tools().indexOf('link_pull_request');
    const howToTest = tools().indexOf('publish_how_to_test');
    const transition = tools().indexOf('transition_status');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(howToTest);
    expect(howToTest).toBeLessThan(transition);
    expect(callsTo('transition_status')).toEqual([
      { tool: 'transition_status', args: { key: 'PROD-7', status: 'implemented' } },
    ]);
    // One `delivery_linked` per repository, on the run, before the card settles.
    const kinds = eventKinds();
    expect(kinds.filter((k) => k === 'delivery_linked')).toHaveLength(1);
    expect(kinds.indexOf('delivery_linked')).toBeLessThan(kinds.indexOf('card_settled'));
    expect(process.exitCode).toBeUndefined();
  });

  it('pushed work with NO pull request to link stays In Progress, and the leg names the branch', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core'], { workBranch: 'subtask/PROD-7-add-the-thing' });
    // The branch is on the remote, and `gh` finds no pull request on it.
    const noPullRequest: CommandRunner = (bin, args, cwd) =>
      bin === 'gh'
        ? { exitCode: 1, stdout: '', stderr: 'no pull requests found' }
        : PUSHED(bin, args, cwd);

    await runCommand('PROD-7', { runId: RUN }, { run: noPullRequest });

    expect(callsTo('link_pull_request')).toEqual([]);
    expect(callsTo('transition_status')).toEqual([]);
    const settled = callsTo('append_events')
      .flatMap(
        (c) =>
          (c.args as { events: { kind: string; disposition?: string; data?: unknown }[] }).events,
      )
      .filter((e) => e.kind === 'card_settled');
    expect(settled).toEqual([
      expect.objectContaining({
        disposition: 'failed',
        data: {
          reason: 'no_linked_pull_request',
          branches: [
            {
              repository: 'motir-core',
              branch: 'subtask/PROD-7-add-the-thing',
              detail: 'no open pull request was found for subtask/PROD-7-add-the-thing',
            },
          ],
        },
      }),
    ]);
    expect(callsTo('close_dispatch_run')).toEqual([
      { tool: 'close_dispatch_run', args: { runId: RUN, stopReason: 'halted' } },
    ]);
    expect(process.exitCode).toBe(1);
  });
  // MOTIR-10888 — a card spanning two repositories, where only ONE pull request links. Motir
  // completes a card on its LINKED pull requests alone, so a clean Implemented here would let
  // the first merge close the card over the second repository's open work.
  const BRANCH = 'subtask/PROD-7-add-the-thing';
  const settledEvents = () =>
    callsTo('append_events')
      .flatMap(
        (c) =>
          (c.args as { events: { kind: string; disposition?: string; data?: unknown }[] }).events,
      )
      .filter((e) => e.kind === 'card_settled');
  /** `gh` finds nothing in the motir-ai checkout; `ls-remote` there answers as `aiPushed` says. */
  const secondRepository =
    (aiPushed: boolean): CommandRunner =>
    (bin, args, cwd) => {
      const inAi = cwd.endsWith('motir-ai');
      if (inAi && bin === 'gh')
        return { exitCode: 1, stdout: '', stderr: 'no pull requests found' };
      if (inAi && args[0] === 'ls-remote')
        return aiPushed
          ? ok(`abc1234def5678abc1234def5678abc1234def56\trefs/heads/${BRANCH}`)
          : { exitCode: 2, stdout: '', stderr: '' };
      return PUSHED(bin, args, cwd);
    };

  it('one repository linked and another PUSHED but unlinked stays In Progress, naming both (MOTIR-10888)', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core', 'motir-ai'], { workBranch: BRANCH });
    runAgentMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      model: null,
      pullRequests: [FAKE_PULL_REQUEST_URL],
    }));

    await runCommand('PROD-7', { runId: RUN }, { run: secondRepository(true) });

    // The pull request that exists is linked — and the card is NOT moved.
    expect(callsTo('link_pull_request')).toHaveLength(1);
    expect(callsTo('transition_status')).toEqual([]);
    expect(settledEvents()).toEqual([
      expect.objectContaining({
        disposition: 'failed',
        data: {
          reason: 'unlinked_pull_request',
          branches: [
            {
              repository: 'motir-ai',
              branch: BRANCH,
              detail: `no open pull request was found for ${BRANCH}`,
            },
          ],
          linked: [{ repository: 'acme/motir-core', url: FAKE_PULL_REQUEST_URL }],
        },
      }),
    ]);
    expect(callsTo('close_dispatch_run')).toEqual([
      { tool: 'close_dispatch_run', args: { runId: RUN, stopReason: 'halted' } },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('a listed repository the run pushed NOTHING to does not hold the card, and is recorded (MOTIR-10888)', async () => {
    h.legs = ['PROD-7'];
    h.details = { 'PROD-7': detail('PROD-7') };
    h.prompt = (k) => prompt(k, ['motir-core', 'motir-ai'], { workBranch: BRANCH });
    runAgentMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      model: null,
      pullRequests: [FAKE_PULL_REQUEST_URL],
    }));

    await runCommand('PROD-7', { runId: RUN }, { run: secondRepository(false) });

    expect(callsTo('transition_status')).toEqual([
      { tool: 'transition_status', args: { key: 'PROD-7', status: 'implemented' } },
    ]);
    expect(settledEvents()).toEqual([
      expect.objectContaining({
        disposition: 'implemented',
        data: {
          unlinked: [
            {
              repository: 'motir-ai',
              branch: BRANCH,
              detail: `no open pull request was found for ${BRANCH}`,
              pushed: false,
            },
          ],
        },
      }),
    ]);
    expect(process.exitCode).toBeUndefined();
  });
});
