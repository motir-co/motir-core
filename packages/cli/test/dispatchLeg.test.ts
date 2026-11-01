import { describe, expect, it } from 'vitest';
import { runDispatchLeg, type DispatchLegInput } from '../src/dispatchLeg.js';
import type { DispatchTarget } from '../src/dispatch.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { DispatchPrompt } from '../src/client.js';

// THE DISPATCH LEG (Story MOTIR-3655 · MOTIR-3695) — the ONE implementation of
// materialize, spawn, and decide what happened, now shared by `motir run` and
// `motir batch`.
//
// Driven directly, with an injected agent and an injected git runner, because
// the four rules it carries are ORDERING rules and ordering is exactly what a
// test through either command cannot see:
//
//   * materialize BEFORE the spawn (MOTIR-3588) — a clone that cannot happen
//     must not first cost a session's tokens;
//   * echo the prompt BEFORE the spawn (MOTIR-3052);
//   * the replan read BEFORE the push check (MOTIR-3018 before MOTIR-3004) —
//     a refusing agent reverts and pushes nothing BY DESIGN, so the other order
//     reports a correctly-refused card as work that went missing.
//
// The last one is the reason this file exists: it is a rule about which of two
// true statements to report, it was written twice, and each copy explained it in
// its own words.

const ROOT = '/home/yue/work';

function target(over: Partial<DispatchTarget> = {}): DispatchTarget {
  return {
    cwd: `${ROOT}/motir-core`,
    reason: 'repo_checkout',
    targetRepo: 'motir-core',
    repoPath: `${ROOT}/motir-core`,
    verifyCheckoutAfterRun: false,
    cloneUrl: null,
    ...over,
  } as DispatchTarget;
}

const PROMPT = { prompt: 'DO THE WORK', workflowMode: 'per_item_pr' } as unknown as DispatchPrompt;

/** A git runner whose `ls-remote` says the agent pushed, unless told otherwise. */
function git(pushed: boolean): CommandRunner {
  return (_bin: string, args: string[]): CommandResult =>
    args[0] === 'ls-remote'
      ? {
          exitCode: 0,
          stdout: pushed ? 'abc123\trefs/heads/subtask/PROD-1' : '',
          stderr: '',
        }
      : { exitCode: 0, stdout: '', stderr: '' };
}

interface LegHarness {
  order: string[];
  verdict: Awaited<ReturnType<typeof runDispatchLeg>>;
}

async function leg(
  over: {
    status?: string;
    agent?: Partial<AgentRunResult>;
    pushed?: boolean;
    targets?: DispatchTarget[];
    primary?: DispatchTarget;
    run?: CommandRunner;
  } = {},
): Promise<LegHarness> {
  const order: string[] = [];
  const primary = over.primary ?? target();
  const input: DispatchLegInput = {
    client: {
      getWorkItem: async () => {
        order.push('replan-read');
        return { item: { status: over.status ?? 'in_progress' } } as never;
      },
      // MOTIR-5562: the leg reads the card's approved designs before the
      // spawn. No design in these fixtures, so the materializer is a no-op.
      listWorkItemDesigns: async () => ({ designs: [] }),
    },
    rootDir: ROOT,
    key: 'PROD-1',
    dispatch: PROMPT,
    agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
    targets: over.targets ?? [primary],
    primary,
    sessionBranch: null,
    onMaterialization: () => order.push('materialize'),
    beforeSpawn: () => order.push('echo'),
    runAgentFn: async () => {
      order.push('spawn');
      return { exitCode: 0, signal: null, model: null, ...over.agent };
    },
    run:
      over.run ??
      (((bin: string, args: string[], cwd: string) => {
        if (args[0] === 'ls-remote') order.push('push-check');
        return git(over.pushed ?? true)(bin, args, cwd);
      }) satisfies CommandRunner),
  };
  return { order, verdict: await runDispatchLeg(input) };
}

describe('the leg runs its steps in the ONE order that is correct', () => {
  it('materializes and echoes BEFORE it spawns', async () => {
    const { order } = await leg();

    expect(order.indexOf('materialize')).toBeLessThan(order.indexOf('spawn'));
    expect(order.indexOf('echo')).toBeLessThan(order.indexOf('spawn'));
  });

  it('asks the CARD what happened before it asks GIT — the rule that was written twice', async () => {
    const { order } = await leg();

    // MOTIR-3018 before MOTIR-3004. A refusing agent reverts and pushes nothing
    // by design, so the other order would report it as work that went missing.
    expect(order.indexOf('replan-read')).toBeLessThan(order.indexOf('push-check'));
  });

  it('reports a REPLAN rather than a missing push, even though nothing was pushed', async () => {
    // Both statements are true about this run. The leg has to report the one
    // that describes what the agent DID.
    const { verdict, order } = await leg({ status: 'planning', pushed: false });

    expect(verdict.kind).toBe('replan_submitted');
    expect(order).not.toContain('push-check');
  });
});

describe('the verdicts', () => {
  it('succeeds with the agent’s self-reported model', async () => {
    const { verdict } = await leg({ agent: { model: 'claude-opus-5' } });

    expect(verdict).toEqual({
      kind: 'succeeded',
      model: 'claude-opus-5',
      sessionId: null,
      suspects: [],
    });
  });

  it('carries the session id the agent reported, and null when it reported none (MOTIR-9048)', async () => {
    const { verdict } = await leg({ agent: { sessionId: 'sess-1' } });
    expect(verdict.kind === 'succeeded' && verdict.sessionId).toBe('sess-1');
    const none = await leg({ agent: { sessionId: null } });
    expect(none.verdict.kind === 'succeeded' && none.verdict.sessionId).toBeNull();
  });

  it('carries a NULL model for an agent that reported nothing — never a guess', async () => {
    const { verdict } = await leg();

    expect(verdict.kind === 'succeeded' && verdict.model).toBeNull();
  });

  it('fails on a non-zero exit, naming the signal when it was killed', async () => {
    const { verdict, order } = await leg({ agent: { exitCode: 137, signal: 'SIGKILL' } });

    expect(verdict).toEqual({ kind: 'agent_failed', exitCode: 137, signal: 'SIGKILL' });
    // And it asked nothing else: a failed agent's card is not interrogated.
    expect(order).not.toContain('replan-read');
    expect(order).not.toContain('push-check');
  });

  it('reports nothing_pushed when exit 0 left the remote untouched', async () => {
    const { verdict } = await leg({ pushed: false });

    expect(verdict.kind).toBe('nothing_pushed');
  });

  it('checks EVERY repository for its bootstrap checkout, not just the primary', async () => {
    // MOTIR-3133 — a card whose second half had no checkout to happen in is
    // exactly the run that otherwise exits 0 with half the work missing.
    const primary = target();
    const second = target({
      cwd: `${ROOT}/motir-ai`,
      targetRepo: 'motir-ai',
      repoPath: `${ROOT}/definitely-not-here`,
      verifyCheckoutAfterRun: true,
    });

    const { verdict } = await leg({ targets: [primary, second], primary });

    expect(verdict.kind).toBe('succeeded');
    expect(verdict.kind === 'succeeded' && verdict.suspects.map((s) => s.repoName)).toEqual([
      'motir-ai',
    ]);
  });

  it('REPORTS the suspects and does not decide — the two commands disagree on purpose', async () => {
    // `motir run` treats a missing bootstrap checkout as a warning and still
    // records the card implemented; `motir batch` treats it as a failed
    // dispatch. That difference predates the leg, so the leg hands both of them
    // a `succeeded` verdict carrying the evidence rather than choosing.
    const primary = target({
      repoPath: `${ROOT}/definitely-not-here`,
      verifyCheckoutAfterRun: true,
    });

    const { verdict } = await leg({ targets: [], primary });

    expect(verdict.kind).toBe('succeeded');
    expect(verdict.kind === 'succeeded' && verdict.suspects).toHaveLength(1);
  });
});

describe('checkout_ready names the BRANCH the leg’s work will be on (MOTIR-6530)', () => {
  async function checkoutEvent(sessionBranch: string | null, branch: string | undefined) {
    const events: Array<{ kind: string; data?: unknown }> = [];
    const primary = target();
    await runDispatchLeg({
      client: {
        getWorkItem: async () => ({ item: { status: 'in_progress' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: { ...PROMPT, ...(branch === undefined ? {} : { branch }) } as DispatchPrompt,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch,
      onMaterialization: () => undefined,
      beforeSpawn: () => undefined,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      run: git(true),
      reporter: {
        event: (e: { kind: string; data?: unknown }) => events.push(e),
      } as never,
    });
    return events.find((e) => e.kind === 'checkout_ready')!.data as { branch: string | null };
  }

  it('carries the per-card branch the payload names', async () => {
    expect((await checkoutEvent(null, 'subtask/PROD-1-the-card')).branch).toBe(
      'subtask/PROD-1-the-card',
    );
  });

  it('carries the session branch on a lineage run', async () => {
    expect((await checkoutEvent('motir/auto-7', 'motir/auto-7')).branch).toBe('motir/auto-7');
  });

  it('is null — never invented — when an older server names no branch', async () => {
    expect((await checkoutEvent(null, undefined)).branch).toBeNull();
  });
});

describe('the agent’s session id is recorded on the run (MOTIR-8980)', () => {
  async function events(
    agent: { stream?: { profile: string; sessionId: string | null } },
    sessionId: string | null | undefined,
  ) {
    const out: Array<{ kind: string; data?: unknown }> = [];
    const primary = target();
    await runDispatchLeg({
      client: {
        getWorkItem: async () => ({ item: { status: 'in_progress' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [], ...agent },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => undefined,
      beforeSpawn: () => undefined,
      runAgentFn: async () => ({
        exitCode: 0,
        signal: null,
        model: null,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
      run: git(true),
      reporter: { event: (e: (typeof out)[number]) => out.push(e) } as never,
    });
    return out;
  }

  it('names a session Motir chose on agent_started, before the agent has done anything', async () => {
    const out = await events({ stream: { profile: 'claude', sessionId: 'chosen' } }, 'chosen');
    expect(out.find((e) => e.kind === 'agent_started')!.data).toEqual({
      agent: 'fake-agent',
      sessionId: 'chosen',
    });
  });

  it('puts the id the run came back with on agent_exited — also for an agent that chose its own', async () => {
    const out = await events({ stream: { profile: 'codex', sessionId: null } }, 'thread-7');
    expect(out.find((e) => e.kind === 'agent_started')!.data).toEqual({ agent: 'fake-agent' });
    expect(out.find((e) => e.kind === 'agent_exited')!.data).toMatchObject({
      sessionId: 'thread-7',
    });
  });

  it('is an explicit null when there is none', async () => {
    const out = await events({}, undefined);
    expect(out.find((e) => e.kind === 'agent_exited')!.data).toMatchObject({ sessionId: null });
  });
});

describe('agent_exited carries the agent’s self-reported model TOP-LEVEL (MOTIR-7504)', () => {
  async function exitedEvent(model: string | null) {
    const events: Array<{ kind: string; model?: unknown; data?: unknown; exitCode?: number }> = [];
    const primary = target();
    await runDispatchLeg({
      client: {
        getWorkItem: async () => ({ item: { status: 'in_progress' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => undefined,
      beforeSpawn: () => undefined,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model }),
      run: git(true),
      reporter: { event: (e: (typeof events)[number]) => events.push(e) } as never,
    });
    return events.find((e) => e.kind === 'agent_exited')!;
  }

  it('sends the model runAgent returned, and keeps the `data` copy readers already see', async () => {
    const exited = await exitedEvent('m');
    expect(exited.model).toBe('m');
    expect(exited.exitCode).toBe(0);
    expect(exited.data).toEqual({ model: 'm', signal: null, sessionId: null });
  });

  it('sends null — never a guess — when the agent reported none', async () => {
    const exited = await exitedEvent(null);
    expect(exited).toHaveProperty('model', null);
  });
});

describe('the run-found report rides the leg, before any verdict settles it (MOTIR-8698)', () => {
  async function legWith(unbuildableReason: string | null, exitCode = 0) {
    const order: string[] = [];
    const reports: Array<[string, string]> = [];
    const primary = target();
    await runDispatchLeg({
      client: {
        getWorkItem: async () => ({ item: { status: 'planning' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => undefined,
      beforeSpawn: () => undefined,
      runAgentFn: async () => ({ exitCode, signal: null, model: 'm', unbuildableReason }),
      run: git(false),
      reporter: {
        event: (e: { kind: string }) => order.push(e.kind),
        reportUnbuildable: async (key: string, reason: string) => {
          order.push('report');
          reports.push([key, reason]);
        },
      } as never,
    });
    return { order, reports };
  }

  it('reports the agent’s reason on the leg’s card, after agent_exited and before leg_verdict', async () => {
    const { order, reports } = await legWith('no such table');
    expect(reports).toEqual([['PROD-1', 'no such table']]);
    expect(order.indexOf('agent_exited')).toBeLessThan(order.indexOf('report'));
    expect(order.indexOf('report')).toBeLessThan(order.indexOf('leg_verdict'));
  });

  it('reports even when the agent then exited non-zero', async () => {
    const { reports } = await legWith('no such table', 3);
    expect(reports).toHaveLength(1);
  });

  it('reports nothing when the agent gave no reason', async () => {
    const { reports } = await legWith(null);
    expect(reports).toHaveLength(0);
  });
});

describe('the agent’s build-through and STOP ride the leg, before the verdict (MOTIR-8722)', () => {
  const POINTS = [{ planAsked: 'a', built: 'b', why: 'c' }];
  const STOP = { comment: 'no such table', toPlanning: true, requirement: null };
  const DECISIONS = [{ planSaid: 'nothing', chose: 'x', why: 'y' }];

  async function legWith(report: {
    discrepancy?: typeof POINTS | null;
    decisions?: typeof DECISIONS | null;
    stop?: typeof STOP | null;
  }) {
    const order: string[] = [];
    const calls: unknown[] = [];
    const primary = target();
    const verdict = await runDispatchLeg({
      client: {
        // The STOP's move to Planning is what the verdict then reads.
        getWorkItem: async () =>
          ({ item: { status: order.includes('stop') ? 'planning' : 'in_progress' } }) as never,
        listWorkItemDesigns: async () => ({ designs: [] }),
      },
      rootDir: ROOT,
      key: 'PROD-1',
      dispatch: PROMPT,
      agent: { command: 'fake-agent', binary: 'fake-agent', args: [] },
      targets: [primary],
      primary,
      sessionBranch: null,
      onMaterialization: () => undefined,
      beforeSpawn: () => undefined,
      runAgentFn: async () => ({ exitCode: 0, signal: null, model: 'm', ...report }),
      run: git(true),
      reporter: {
        event: (e: { kind: string }) => order.push(e.kind),
        reportDiscrepancy: async (key: string, points: unknown, decisions?: unknown[]) => {
          order.push('discrepancy');
          calls.push(
            decisions && decisions.length > 0
              ? ['discrepancy', key, points, decisions]
              : ['discrepancy', key, points],
          );
        },
        reportStop: async (key: string, stop: unknown) => {
          order.push('stop');
          calls.push(['stop', key, stop]);
        },
      } as never,
    });
    return { order, calls, verdict };
  }

  it('records the points on the leg’s card after agent_exited and before leg_verdict', async () => {
    const { order, calls } = await legWith({ discrepancy: POINTS });
    expect(calls).toEqual([['discrepancy', 'PROD-1', POINTS]]);
    expect(order.indexOf('agent_exited')).toBeLessThan(order.indexOf('discrepancy'));
    expect(order.indexOf('discrepancy')).toBeLessThan(order.indexOf('leg_verdict'));
  });

  it('makes the STOP before the verdict, so a card it moved to Planning settles as a re-plan', async () => {
    const { calls, verdict } = await legWith({ stop: STOP });
    expect(calls).toEqual([['stop', 'PROD-1', STOP]]);
    expect(verdict.kind).toBe('replan_submitted');
  });

  it('makes neither when the agent wrote neither', async () => {
    const { calls } = await legWith({});
    expect(calls).toHaveLength(0);
  });

  it('records the DECISIONS in the same one record, beside the points or alone (MOTIR-10000)', async () => {
    expect((await legWith({ decisions: DECISIONS })).calls).toEqual([
      ['discrepancy', 'PROD-1', [], DECISIONS],
    ]);
    expect((await legWith({ discrepancy: POINTS, decisions: DECISIONS })).calls).toEqual([
      ['discrepancy', 'PROD-1', POINTS, DECISIONS],
    ]);
  });
});
