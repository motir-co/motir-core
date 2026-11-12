import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legBranches, startCheckpoints } from '../src/checkpoint.js';
import { toDispatchPrompt } from '../src/adapters/reads.js';
import { runDispatchLeg } from '../src/dispatchLeg.js';
import { dispatchOne, type DispatchOneInput } from '../src/commands/auto.js';
import type { DispatchTarget } from '../src/dispatch.js';
import type { DispatchItem, DispatchPrompt, DispatchRunEventInput } from '../src/client.js';
import type { CommandRunner } from '../src/git.js';

// A RUN CHECKPOINTS ITS WORK (Story MOTIR-683 · MOTIR-6539).
//
// Real git against local BARE remotes, because the property under test is a
// property of git: that commits an agent made — and never pushed — are on origin
// before the agent exits, and survive an agent that is killed. A faked runner
// would only prove the CLI issued a command.
//
// The "agent" in these tests is what the dispatch prompt tells a real one to do:
// `git worktree add ../<repo>-<KEY> -b <workBranch> origin/<base>`, then commit
// in that worktree. It never pushes — which is exactly the agent a checkpoint
// exists for.

const KEY = 'PROD-7';
const WORK = `subtask/${KEY}-checkpoint-it`;

let root: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** A bare remote with one commit on `main`, and a checkout of it. */
function repo(name: string): { checkout: string; remote: string } {
  const remote = join(root, `${name}.git`);
  git(['init', '--quiet', '--bare', '--initial-branch=main', remote], root);
  const seed = join(root, `${name}-seed`);
  git(['clone', '--quiet', remote, seed], root);
  git(['config', 'user.email', 'seed@example.test'], seed);
  git(['config', 'user.name', 'Seed'], seed);
  writeFileSync(join(seed, 'README.md'), `${name}\n`);
  git(['add', 'README.md'], seed);
  git(['commit', '--quiet', '-m', 'seed'], seed);
  git(['push', '--quiet', 'origin', 'HEAD:main'], seed);
  const checkout = join(root, name);
  git(['clone', '--quiet', remote, checkout], root);
  git(['config', 'user.email', 'agent@example.test'], checkout);
  git(['config', 'user.name', 'Agent'], checkout);
  return { checkout, remote };
}

/** What the prompt tells the agent to do first: a worktree on the work branch. */
function agentWorktree(checkout: string, base = 'main'): string {
  const wt = `${checkout}-${KEY}`;
  git(['fetch', '--quiet', 'origin'], checkout);
  git(['worktree', 'add', '--quiet', wt, '-b', WORK, `origin/${base}`], checkout);
  return wt;
}

function commit(wt: string, file: string): string {
  writeFileSync(join(wt, file), `${file}\n`);
  git(['add', file], wt);
  git(['commit', '--quiet', '-m', `feat: ${KEY} ${file}`], wt);
  return git(['rev-parse', 'HEAD'], wt);
}

/** The branch's tip on the remote, or '' when the remote has no such branch. */
function remoteTip(remote: string, branch: string): string {
  try {
    return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], remote);
  } catch {
    return '';
  }
}

function target(checkout: string, name: string): DispatchTarget {
  return {
    targetRepo: name,
    cwd: checkout,
    reason: 'repo_checkout',
    repoPath: checkout,
    repoSource: 'convention',
    cloneUrl: null,
    verifyCheckoutAfterRun: false,
  };
}

function recorder() {
  const events: DispatchRunEventInput[] = [];
  return { events, event: (e: DispatchRunEventInput) => void events.push(e) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `check` holds, up to a bound — an authoritative read, not a guess. */
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-checkpoint-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('legBranches — every repository named with its branch before the agent exists', () => {
  it('per_item_pr: the pull request comes from the work branch', () => {
    expect(
      legBranches({ sessionBranch: null, workBranch: WORK }, [
        { targetRepo: 'motir-core' },
        { targetRepo: 'motir-ai' },
      ]),
    ).toEqual([
      { repository: 'motir-core', branch: WORK, workBranch: WORK },
      { repository: 'motir-ai', branch: WORK, workBranch: WORK },
    ]);
  });

  it('session_lineage: the pull request comes from the session branch', () => {
    expect(
      legBranches({ sessionBranch: 'motir/session-1', workBranch: WORK }, [
        { targetRepo: 'motir-core' },
      ]),
    ).toEqual([{ repository: 'motir-core', branch: 'motir/session-1', workBranch: WORK }]);
  });

  it('a server that names no work branch: nothing is invented', () => {
    expect(legBranches({ sessionBranch: null }, [{ targetRepo: 'motir-core' }])).toEqual([
      { repository: 'motir-core', branch: null, workBranch: null },
    ]);
  });
});

describe('the client carries the work branch off the wire', () => {
  const body = {
    key: KEY,
    prompt: 'p',
    parentKey: null,
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    advisories: [],
  };

  it('carries `workBranch` when the server names it — the field has a reader', () => {
    expect(toDispatchPrompt({ ...body, workBranch: WORK } as never).workBranch).toBe(WORK);
  });

  it('an older server that sends none leaves it ABSENT — nothing to checkpoint', () => {
    expect('workBranch' in toDispatchPrompt(body as never)).toBe(false);
  });
});

describe('startCheckpoints — the agent’s commits reach origin as it makes them', () => {
  it('pushes each repository’s work branch whenever it advances, before the agent exits', async () => {
    const core = repo('motir-core');
    const ai = repo('motir-ai');
    const wtCore = agentWorktree(core.checkout);
    const wtAi = agentWorktree(ai.checkout);
    const reporter = recorder();
    const cp = startCheckpoints({
      key: KEY,
      targets: [target(core.checkout, 'motir-core'), target(ai.checkout, 'motir-ai')],
      workBranch: WORK,
      reporter,
      intervalMs: 25,
    });
    try {
      const a1 = commit(wtCore, 'a1.txt');
      const b1 = commit(wtAi, 'b1.txt');
      expect(await until(() => remoteTip(core.remote, WORK) === a1)).toBe(true);
      expect(await until(() => remoteTip(ai.remote, WORK) === b1)).toBe(true);
      const a2 = commit(wtCore, 'a2.txt');
      const b2 = commit(wtAi, 'b2.txt');
      // Still before the agent "exits" — the timer, not the stop, carried them.
      expect(await until(() => remoteTip(core.remote, WORK) === a2)).toBe(true);
      expect(await until(() => remoteTip(ai.remote, WORK) === b2)).toBe(true);
    } finally {
      cp.stop();
    }
    expect(reporter.events).toEqual([]);
  });

  it('an agent killed after its first commit leaves that commit on the remote', async () => {
    const core = repo('motir-core');
    const wt = agentWorktree(core.checkout);
    // A timer that never fires on its own: only the stop's last push can save it.
    const cp = startCheckpoints({
      key: KEY,
      targets: [target(core.checkout, 'motir-core')],
      workBranch: WORK,
      reporter: recorder(),
      intervalMs: 60_000,
    });
    const first = commit(wt, 'first.txt');
    cp.stop(); // the agent was killed; the run is ending
    expect(remoteTip(core.remote, WORK)).toBe(first);
  });

  it('never pushes a work branch that holds nothing origin lacks', () => {
    const core = repo('motir-core');
    agentWorktree(core.checkout); // created, no commit yet
    const cp = startCheckpoints({
      key: KEY,
      targets: [target(core.checkout, 'motir-core')],
      workBranch: WORK,
      reporter: recorder(),
      intervalMs: 60_000,
    });
    cp.stop();
    // An empty branch named after the card would read as "pushed" to MOTIR-3004.
    expect(remoteTip(core.remote, WORK)).toBe('');
  });

  it('a failing push is ONE log event per commit, retried, and never fails the run', async () => {
    const core = repo('motir-core');
    const wt = agentWorktree(core.checkout);
    const real: CommandRunner = (bin, args, cwd) => {
      try {
        return {
          exitCode: 0,
          stdout: execFileSync(bin, args, { cwd, encoding: 'utf8' }),
          stderr: '',
        };
      } catch (err) {
        const e = err as { status?: number; stderr?: string };
        return { exitCode: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '') };
      }
    };
    let failPushes = true;
    let pushAttempts = 0;
    const run: CommandRunner = (bin, args, cwd) => {
      if (args[0] === 'push') {
        pushAttempts += 1;
        if (failPushes) return { exitCode: 1, stdout: '', stderr: 'remote: rejected (test)' };
      }
      return real(bin, args, cwd);
    };
    const reporter = recorder();
    const cp = startCheckpoints({
      key: KEY,
      targets: [target(core.checkout, 'motir-core')],
      workBranch: WORK,
      reporter,
      run,
      intervalMs: 20,
    });
    const sha = commit(wt, 'x.txt');
    expect(await until(() => pushAttempts >= 3)).toBe(true);
    const logs = reporter.events.filter((e) => e.kind === 'log');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.workItemKey).toBe(KEY);
    expect(logs[0]?.body).toContain('checkpoint push');
    expect(logs[0]?.body).toContain('rejected (test)');
    failPushes = false;
    expect(await until(() => remoteTip(core.remote, WORK) === sha)).toBe(true);
    cp.stop();
  });

  it('with no work branch (a manual item, an older server) nothing starts', () => {
    const core = repo('motir-core');
    const calls: string[] = [];
    const cp = startCheckpoints({
      key: KEY,
      targets: [target(core.checkout, 'motir-core')],
      workBranch: null,
      reporter: recorder(),
      run: (bin, args) => {
        calls.push(args.join(' '));
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    cp.stop();
    expect(calls).toEqual([]);
  });

  it('a parent’s second child checkpoints its work branch off the session branch — and never pushes the session branch itself', async () => {
    const core = repo('motir-core');
    const SESSION = 'motir/session-run1';
    // The first child is integrated on the session branch already.
    const seed = join(root, 'motir-core-seed');
    git(['checkout', '--quiet', '-b', SESSION], seed);
    writeFileSync(join(seed, 'child1.txt'), 'child1\n');
    git(['add', 'child1.txt'], seed);
    git(['commit', '--quiet', '-m', 'feat: PROD-6 child one'], seed);
    git(['push', '--quiet', 'origin', SESSION], seed);
    const sessionTip = remoteTip(core.remote, SESSION);

    const wt = agentWorktree(core.checkout, SESSION);
    const cp = startCheckpoints({
      key: KEY,
      targets: [target(core.checkout, 'motir-core')],
      workBranch: WORK,
      reporter: recorder(),
      intervalMs: 20,
    });
    const sha = commit(wt, 'child2.txt');
    expect(await until(() => remoteTip(core.remote, WORK) === sha)).toBe(true);
    cp.stop();
    // The work branch carries the lineage: child one is its ancestor.
    git(['fetch', '--quiet', 'origin'], core.checkout);
    expect(git(['merge-base', '--is-ancestor', sessionTip, `origin/${WORK}`], core.checkout)).toBe(
      '',
    );
    // …and the shared session branch is exactly where the first child left it.
    expect(remoteTip(core.remote, SESSION)).toBe(sessionTip);
  });
});

// Each case builds real bare remotes and worktrees and shells out to git dozens
// of times; under `--coverage` on a shared CI runner the dispatch leg ran 5.18s
// against Vitest's 5s default and failed with no assertion wrong (seen on
// MOTIR-11094's pull request). The budget fits their I/O, not a slower product.
describe('both run pipelines checkpoint and name their branches', { timeout: 30_000 }, () => {
  const PROMPT = {
    key: KEY,
    prompt: 'DO THE WORK',
    parentKey: null,
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    workBranch: WORK,
    advisories: [],
  } as unknown as DispatchPrompt;

  it('the dispatch leg (`run` / `next` / `batch`): two repositories pushed before the agent exits', async () => {
    const core = repo('motir-core');
    const ai = repo('motir-ai');
    const primary = target(core.checkout, 'motir-core');
    const second = target(ai.checkout, 'motir-ai');
    const reporter = recorder();
    let seenBeforeExit = { core: '', ai: '' };
    const verdict = await runDispatchLeg({
      client: {
        getWorkItem: async () => ({ item: { status: 'in_review' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      },
      rootDir: root,
      key: KEY,
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary, second],
      primary,
      sessionBranch: null,
      onMaterialization: () => {},
      beforeSpawn: () => {},
      checkpointIntervalMs: 20,
      reporter: reporter as never,
      runAgentFn: async () => {
        const wtCore = agentWorktree(core.checkout);
        const wtAi = agentWorktree(ai.checkout);
        commit(wtCore, 'a1.txt');
        commit(wtAi, 'b1.txt');
        await sleep(60);
        const a2 = commit(wtCore, 'a2.txt');
        const b2 = commit(wtAi, 'b2.txt');
        await until(() => remoteTip(core.remote, WORK) === a2 && remoteTip(ai.remote, WORK) === b2);
        seenBeforeExit = { core: remoteTip(core.remote, WORK), ai: remoteTip(ai.remote, WORK) };
        return { exitCode: 0, signal: null, model: null };
      },
    });
    expect(seenBeforeExit.core).toBe(git(['rev-parse', WORK], core.checkout));
    expect(seenBeforeExit.ai).toBe(git(['rev-parse', WORK], ai.checkout));
    expect(verdict.kind).toBe('succeeded');
    const ready = reporter.events.find((e) => e.kind === 'checkout_ready');
    expect((ready?.data as { branches: unknown }).branches).toEqual([
      { repository: 'motir-core', branch: WORK, workBranch: WORK },
      { repository: 'motir-ai', branch: WORK, workBranch: WORK },
    ]);
  });

  it('the scope drain’s dispatchOne (`auto` / a parent): checkout_ready names every branch, and a killed agent’s commit survives', async () => {
    const core = repo('motir-core');
    const primary = target(core.checkout, 'motir-core');
    const reporter = recorder();
    let first = '';
    const item = {
      key: KEY,
      kind: 'subtask',
      title: 'Checkpoint it',
      priority: 'medium',
      status: { key: 'in_progress', category: 'in_progress' },
      assigneeId: 'user_me',
      type: 'code',
      executor: 'coding_agent',
      inheritedSessionBranch: null,
    } as unknown as DispatchItem;
    const input = {
      client: {
        claimWorkItem: async () => ({ outcome: 'claimed', claimed: true }) as never,
        getWorkItem: async () => ({ item: { status: 'in_progress' } }) as never,
        transitionStatus: async () => {},
        markIntegrated: async () => ({}) as never,
      },
      item,
      dispatch: PROMPT,
      target: primary,
      repos: ['motir-core'],
      targets: [primary],
      agent: { parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] }, source: 'flag' },
      clock: () => 0,
      // The agent commits once and is killed — it never pushes.
      runAgentFn: async () => {
        first = commit(agentWorktree(core.checkout), 'first.txt');
        return { exitCode: 137, signal: 'SIGKILL', model: null };
      },
      opts: {},
      onIntegrated: () => {},
      run: (bin: string, args: string[], cwd: string) => {
        try {
          return {
            exitCode: 0,
            stdout: execFileSync(bin, args, { cwd, encoding: 'utf8' }),
            stderr: '',
          };
        } catch (err) {
          const e = err as { status?: number; stderr?: string };
          return { exitCode: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '') };
        }
      },
      reporter,
      checkpointIntervalMs: 60_000,
    } as unknown as DispatchOneInput;
    await dispatchOne(input);
    const ready = reporter.events.find((e) => e.kind === 'checkout_ready');
    expect(ready?.workItemKey).toBe(KEY);
    expect((ready?.data as { branches: unknown }).branches).toEqual([
      { repository: 'motir-core', branch: WORK, workBranch: WORK },
    ]);
    const kinds = reporter.events.map((e) => e.kind);
    expect(kinds.indexOf('checkout_ready')).toBeLessThan(kinds.indexOf('agent_started'));
    expect(remoteTip(core.remote, WORK)).toBe(first);
  });
});
