import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type {
  RepairPullRequest,
  WorkItemDelivery,
  WorkItemDetail,
  WorkItemRepairClaim,
  WorkItemRepairRefusal,
} from '../src/client.js';
import { NOTHING_TO_CHANGE_DETAIL } from '../src/ciWatch.js';

// `motir fix <key>` (Story MOTIR-5460 · MOTIR-5465). The session, the agent, git
// and the wait are all injected; what is under test is the PIPELINE — claim, then
// checkout ON the pull request's own branch, then the shipped fix loop, then the
// run closed on every exit path — and that a refusal touches neither git nor the
// agent.

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as unknown } }));

vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { fixCommand, prepareCheckouts, renderRepairRefusal, renderRepairGaveUp } =
  await import('../src/commands/fix.js');

const ROOT = '/work';

function pr(over: Partial<RepairPullRequest> = {}): RepairPullRequest {
  return {
    repo: 'acme/motir-core',
    number: 131,
    url: 'https://github.com/acme/motir-core/pull/131',
    headRef: 'subtask/PROD-7-thing',
    baseRef: 'main',
    ci: 'failing',
    failingChecks: ['Vitest'],
    queueExit: null,
    ...over,
  };
}

function claim(over: Partial<WorkItemRepairClaim> = {}): WorkItemRepairClaim {
  return {
    key: 'PROD-7',
    title: 'Add the thing',
    outcome: 'claimed',
    reason: null,
    runTargetKey: null,
    runId: 'run_fix_1',
    holder: { id: 'user_me', name: 'Me' },
    startedAt: '2026-09-16T10:00:00.000Z',
    repairClass: 'ci',
    acceptanceRefusal: null,
    reviewRefusal: null,
    pullRequests: [pr()],
    ...over,
  };
}

function delivery(
  ci: WorkItemDelivery['ci'],
  over: Partial<WorkItemDelivery> = {},
): WorkItemDelivery {
  return {
    repo: 'acme/motir-core',
    number: 131,
    title: 'Add the thing',
    url: 'https://github.com/acme/motir-core/pull/131',
    state: 'open',
    ci,
    baseRef: 'main',
    defaultBranch: 'main',
    ...over,
  };
}

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

interface Harness {
  calls: { tool: string; args: unknown }[];
  git: { args: string[]; cwd: string }[];
  agents: { prompt: string; cwd: string }[];
  stdout: string;
  stderr: string;
  interrupt: (() => void) | null;
  exits: number[];
}

let h: Harness;

/**
 * A git that knows one remote branch per headRef, no local branches, and — once
 * a worktree is added — answers `rev-parse --abbrev-ref HEAD` with its branch.
 */
function fakeGit(opts: { localBranch?: boolean; fetchFails?: boolean } = {}): CommandRunner {
  const worktrees = new Map<string, string>();
  return (_bin, args, cwd) => {
    h.git.push({ args, cwd });
    if (args[0] === 'fetch') {
      return opts.fetchFails ? { exitCode: 128, stdout: '', stderr: 'no such ref' } : ok();
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return opts.localBranch ? ok('abc') : { exitCode: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const path = args[2] === '--track' ? args[5]! : args[2]!;
      const branch = args[2] === '--track' ? args[4]! : args[3]!;
      worktrees.set(path, branch);
      return ok();
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return ok(worktrees.get(cwd) ?? 'HEAD');
    }
    return ok();
  };
}

function setup(opts: {
  claims: WorkItemRepairClaim[];
  verdicts?: WorkItemDelivery[][];
  git?: CommandRunner;
  exists?: (p: string) => boolean;
  agentExit?: number;
  /** The agent's self-reported model (MOTIR-7504); null by default. */
  agentModel?: string | null;
  /** What the agent wrote into `$MOTIR_AGENT_REPORT` beyond its model (MOTIR-11094). */
  agentReport?: { discrepancy?: unknown; decisions?: unknown };
}) {
  const calls: Harness['calls'] = [];
  const claims = [...opts.claims];
  const verdicts = [...(opts.verdicts ?? [])];
  const client = {
    claimWorkItemRepair: async (key: string) => {
      calls.push({ tool: 'claim_repair', args: key });
      return claims.length > 1 ? claims.shift()! : claims[0]!;
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      const deliveries = verdicts.length > 1 ? verdicts.shift()! : (verdicts[0] ?? []);
      return { deliveries } as unknown as WorkItemDetail;
    },
    openDispatchRun: async (args: unknown) => {
      calls.push({ tool: 'open_run', args });
      return { runId: 'should-not-open', created: true };
    },
    appendDispatchRunEvents: async (args: unknown) => {
      calls.push({ tool: 'append_events', args });
      return {};
    },
    closeDispatchRun: async (args: unknown) => {
      calls.push({ tool: 'close_run', args });
    },
    linkPullRequest: async (args: unknown) => {
      calls.push({ tool: 'link_pull_request', args });
    },
    transitionStatus: async (args: unknown) => {
      calls.push({ tool: 'transition_status', args });
    },
    recordDispatchRunDiscrepancy: async (args: unknown) => {
      calls.push({ tool: 'record_discrepancy', args });
    },
  };
  sessionRef.current = {
    client,
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    link: {
      dir: ROOT,
      path: join(ROOT, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
  };
  h = { calls, git: [], agents: [], stdout: '', stderr: '', interrupt: null, exits: [] };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    h.stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    h.stderr += String(chunk);
    return true;
  });
  const deps = {
    run: opts.git ?? fakeGit(),
    // Every repository checkout exists; no fix worktree does yet.
    exists: opts.exists ?? ((p: string) => !p.includes('-fix-')),
    runAgentFn: async (input: { prompt: string; cwd: string }) => {
      h.agents.push({ prompt: input.prompt, cwd: input.cwd });
      return {
        exitCode: opts.agentExit ?? 0,
        signal: null,
        model: opts.agentModel ?? null,
        ...opts.agentReport,
      } as never;
    },
    wait: async () => {},
    onInterrupt: (handler: () => void) => {
      h.interrupt = handler;
      return () => {
        h.interrupt = null;
      };
    },
    exit: (code: number) => {
      h.exits.push(code);
    },
  };
  return deps;
}

const tools = () => h.calls.map((c) => c.tool);
const closes = () => h.calls.filter((c) => c.tool === 'close_run').map((c) => c.args);
const events = () =>
  h.calls
    .filter((c) => c.tool === 'append_events')
    .flatMap(
      (c) =>
        (c.args as { events: { kind: string; disposition?: string; data?: unknown }[] }).events,
    );

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  process.env['MOTIR_AGENT'] = 'claude -p';
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_AGENT'];
  process.exitCode = undefined;
});

describe('motir fix — the happy path', () => {
  it('claims, checks out the PR branch (not detached), runs the fix loop there, and closes completed on green', async () => {
    const deps = setup({
      claims: [claim()],
      verdicts: [[delivery('failing')], [delivery('passing')]],
      agentModel: 'claude-opus-5-5',
    });

    await fixCommand('PROD-7', {}, deps);

    expect(tools()[0]).toBe('claim_repair');
    const path = '/work/motir-core-fix-prod-7-131';
    // The worktree is ON the branch: `--track -b <headRef>` from the fetched ref.
    const add = h.git.find((g) => g.args[0] === 'worktree')!;
    expect(add.args).toEqual([
      'worktree',
      'add',
      '--track',
      '-b',
      'subtask/PROD-7-thing',
      path,
      'origin/subtask/PROD-7-thing',
    ]);
    expect(add.cwd).toBe('/work/motir-core');
    // And the checkout is asserted to sit on that branch, not a detached HEAD.
    expect(
      h.git.some((g) => g.cwd === path && g.args.join(' ') === 'rev-parse --abbrev-ref HEAD'),
    ).toBe(true);

    expect(h.agents).toHaveLength(1);
    expect(h.agents[0]!.cwd).toBe(path);
    expect(h.agents[0]!.prompt).toContain('# Make the build pass — PROD-7 (Add the thing)');
    expect(h.agents[0]!.prompt).toContain(`branch \`subtask/PROD-7-thing\` at \`${path}\``);

    // The SERVER opened the run; the CLI reports into it and closes it.
    expect(tools()).not.toContain('open_run');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'completed' }]);
    expect(events().map((e) => e.kind)).toEqual([
      'run_opened',
      'checkout_ready',
      // The watch reports each fixing attempt to the run (MOTIR-8979), then
      // each attempt is a started / exited pair, so a `ci` repair's leg
      // learns the model that answered (MOTIR-7506).
      'ci_fix_attempt',
      'agent_started',
      'agent_exited',
      'ci_verdict',
      'card_settled',
    ]);
    expect(events().find((e) => e.kind === 'agent_exited')).toMatchObject({
      exitCode: 0,
      model: 'claude-opus-5-5',
      data: { step: 'ci_fix', model: 'claude-opus-5-5' },
    });
    expect(events().at(-1)?.disposition).toBe('implemented');
    expect(process.exitCode).toBeUndefined();
  });

  it('opens no pull request, links nothing and writes no status', async () => {
    const deps = setup({ claims: [claim()], verdicts: [[delivery('passing')]] });

    await fixCommand('PROD-7', {}, deps);

    expect(tools()).not.toContain('link_pull_request');
    expect(tools()).not.toContain('transition_status');
    expect(h.git.some((g) => g.args[0] === 'push')).toBe(false);
  });

  it('a resumed repair (`mine`) reuses its worktree when it is already on the branch', async () => {
    const git = fakeGit();
    const wrapped: CommandRunner = (bin, args, cwd) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        h.git.push({ args, cwd });
        return ok('subtask/PROD-7-thing');
      }
      return git(bin, args, cwd);
    };
    const deps = setup({
      claims: [claim({ outcome: 'mine' })],
      verdicts: [[delivery('passing')]],
      git: wrapped,
      exists: () => true,
    });

    await fixCommand('PROD-7', {}, deps);

    expect(h.git.some((g) => g.args[0] === 'worktree')).toBe(false);
    expect(h.stderr).toContain('PROD-7: resuming the repair of acme/motir-core#131.');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'completed' }]);
  });

  it('an existing LOCAL branch is checked out as-is, then fast-forwarded to the PR head', async () => {
    const deps = setup({
      claims: [claim()],
      verdicts: [[delivery('passing')]],
      git: fakeGit({ localBranch: true }),
    });

    await fixCommand('PROD-7', {}, deps);

    const lines = h.git.map((g) => g.args.join(' '));
    expect(lines).toContain('worktree add /work/motir-core-fix-prod-7-131 subtask/PROD-7-thing');
    expect(lines).toContain('merge --ff-only origin/subtask/PROD-7-thing');
  });
});

describe('motir fix — an acceptance sent back with Re-run (MOTIR-6502)', () => {
  const REASON = 'The empty board should say how to add the first card.';
  const rerunClaim = (over: Partial<WorkItemRepairClaim> = {}) =>
    claim({
      key: 'PROD-60',
      title: 'Exports list',
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: {
        reasonMd: REASON,
        decidedByLabel: 'Yue Zhu',
        decidedAt: '2026-09-26T10:00:00.000Z',
      },
      pullRequests: [pr({ headRef: 'parent/PROD-60-exports', ci: 'passing', failingChecks: [] })],
      ...over,
    });

  it('runs the agent ONCE with the reason before the CI watch, then re-records the video on green', async () => {
    const deps = setup({
      claims: [rerunClaim()],
      // The fix's push goes pending, then green.
      verdicts: [[delivery('running')], [delivery('passing')]],
    });

    await fixCommand('PROD-60', {}, deps);

    // Checked out ON the open delivery's own branch — the same pull request.
    const add = h.git.find((g) => g.args[0] === 'worktree')!;
    expect(add.args).toContain('parent/PROD-60-exports');

    expect(h.agents).toHaveLength(2);
    const [rerun, record] = h.agents;
    expect(rerun!.prompt).toContain('# Answer the acceptance review — PROD-60 (Exports list)');
    expect(rerun!.prompt).toContain(`> ${REASON}`);
    expect(rerun!.prompt).toContain('Yue Zhu sent it back');
    expect(rerun!.prompt).toContain('Anything structural is a Re-plan, not a Re-run');
    expect(rerun!.prompt).toContain('Do not record or publish the acceptance video');
    expect(record!.prompt).toContain('# Re-record the acceptance video — PROD-60');
    expect(record!.prompt).toContain('publish_acceptance_result');

    // The re-run turn is reported BEFORE the CI verdict, the record turn after it.
    const kinds = events().map((e) => e.kind);
    expect(kinds).toEqual([
      'run_opened',
      'checkout_ready',
      'agent_started',
      'agent_exited',
      'log',
      'ci_verdict',
      'agent_started',
      'agent_exited',
      'card_settled',
    ]);
    expect(events().at(-1)?.disposition).toBe('implemented');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'completed' }]);
    expect(process.exitCode).toBeUndefined();
  });

  it('opens no pull request, links nothing and writes no status', async () => {
    const deps = setup({ claims: [rerunClaim()], verdicts: [[delivery('passing')]] });

    await fixCommand('PROD-60', {}, deps);

    expect(tools()).not.toContain('link_pull_request');
    expect(tools()).not.toContain('transition_status');
    expect(tools()).not.toContain('open_run');
  });

  it.each([['m'], [null]] as const)(
    'both turns report the agent’s model (%s) and exit code TOP-LEVEL on `agent_exited` (MOTIR-7504)',
    async (model) => {
      const deps = setup({
        claims: [rerunClaim()],
        verdicts: [[delivery('running')], [delivery('passing')]],
        agentModel: model,
      });

      await fixCommand('PROD-60', {}, deps);

      const exited = events().filter((e) => e.kind === 'agent_exited');
      expect(exited).toHaveLength(2);
      for (const e of exited) {
        expect(e).toMatchObject({ exitCode: 0, model });
        expect(e.data).toMatchObject({ exitCode: 0, model });
      }
    },
  );

  it('a failed re-run agent stops before the CI watch, closes halted and exits non-zero', async () => {
    const deps = setup({
      claims: [rerunClaim()],
      verdicts: [[delivery('passing')]],
      agentExit: 2,
    });

    await fixCommand('PROD-60', {}, deps);

    expect(h.agents).toHaveLength(1);
    expect(tools()).not.toContain('get_work_item');
    expect(h.stderr).toContain('PROD-60: the re-run agent failed — exit 2');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(events().at(-1)?.disposition).toBe('failed');
    expect(process.exitCode).toBe(1);
  });

  it('a red build is fixed by the shipped loop between the two turns', async () => {
    const deps = setup({
      claims: [rerunClaim()],
      verdicts: [[delivery('failing')], [delivery('passing')]],
    });

    await fixCommand('PROD-60', {}, deps);

    expect(h.agents.map((a) => a.prompt.split('\n')[0])).toEqual([
      '# Answer the acceptance review — PROD-60 (Exports list)',
      '# Make the build pass — PROD-60 (Exports list)',
      '# Re-record the acceptance video — PROD-60 (Exports list)',
    ]);
  });

  it('no re-record when the build gives up — the video would show red work', async () => {
    const deps = setup({
      claims: [rerunClaim(), rerunClaim({ outcome: 'mine' })],
      verdicts: [[delivery('failing')]],
    });

    await fixCommand('PROD-60', {}, deps);

    expect(h.agents.some((a) => a.prompt.startsWith('# Re-record'))).toBe(false);
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
  });

  it('a failed re-record leaves CI green but exits non-zero and says what is left to do', async () => {
    let n = 0;
    const deps = setup({ claims: [rerunClaim()], verdicts: [[delivery('passing')]] });
    const base = deps.runAgentFn;
    deps.runAgentFn = async (input: { prompt: string; cwd: string }) => {
      n += 1;
      const result = (await base(input)) as { exitCode: number; signal: null; model: null };
      return (n === 2 ? { ...result, exitCode: 1 } : result) as never;
    };

    await fixCommand('PROD-60', {}, deps);

    expect(h.stderr).toContain('CI is green, but re-recording the acceptance video failed');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(process.exitCode).toBe(1);
  });

  it('a reason with no text still reads as a refusal, never a blank quote', async () => {
    const deps = setup({
      claims: [
        rerunClaim({
          acceptanceRefusal: { reasonMd: null, decidedByLabel: null, decidedAt: '2026-09-26' },
        }),
      ],
      verdicts: [[delivery('passing')]],
    });

    await fixCommand('PROD-60', {}, deps);

    expect(h.agents[0]!.prompt).toContain('The reviewer sent it back on 2026-09-26');
    expect(h.agents[0]!.prompt).toContain('> (no reason was recorded)');
  });
});

describe('motir fix — a card a REVIEW sent back (MOTIR-6822)', () => {
  const FINDINGS = [
    '1. `exportCsv` drops the header row when the list is empty.',
    '2. The new route has no tenant check — read `projectAccessService.assertCanBrowse`.',
    '',
    'Both must be fixed before this can merge.',
  ].join('\n');
  const reviewClaim = (over: Partial<WorkItemRepairClaim> = {}) =>
    claim({
      key: 'PROD-70',
      title: 'Export the list',
      repairClass: 'review',
      reviewRefusal: {
        gate: 'agent_review',
        findingsMd: FINDINGS,
        reviewerName: 'Review agent',
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
      pullRequests: [pr({ headRef: 'subtask/PROD-70-export', ci: 'passing', failingChecks: [] })],
      ...over,
    });

  it.each([['m'], [null]] as const)(
    'the review-fix turn reports the agent’s model (%s) and exit code TOP-LEVEL (MOTIR-7504)',
    async (model) => {
      const deps = setup({
        claims: [reviewClaim()],
        verdicts: [[delivery('running')], [delivery('passing')]],
        agentModel: model,
      });

      await fixCommand('PROD-70', {}, deps);

      const exited = events().filter((e) => e.kind === 'agent_exited');
      expect(exited).toHaveLength(1);
      expect(exited[0]).toMatchObject({ exitCode: 0, model });
      expect(exited[0]!.data).toMatchObject({ step: 'review_fix', model });
    },
  );

  it('claims a GREEN card, runs the agent ONCE on the full findings before the CI watch, and ends there', async () => {
    const deps = setup({
      claims: [reviewClaim()],
      verdicts: [[delivery('running')], [delivery('passing')]],
    });

    await fixCommand('PROD-70', {}, deps);

    // The pull request's OWN branch, never a new one.
    const add = h.git.find((g) => g.args[0] === 'worktree')!;
    expect(add.args).toContain('subtask/PROD-70-export');

    expect(h.agents).toHaveLength(1);
    const prompt = h.agents[0]!.prompt;
    expect(prompt.split('\n')[0]).toBe('# Answer the code review — PROD-70 (Export the list)');
    expect(prompt).toContain('by the REVIEW AGENT');
    expect(prompt).toContain('Review agent sent it back on 2026-09-29T10:00:00.000Z:');
    // EVERY line of the findings, verbatim — never a one-line preview.
    for (const line of FINDINGS.split('\n')) expect(prompt).toContain(`> ${line}`);
    expect(prompt).toContain('Address EVERY finding');
    expect(prompt).toContain('branch `subtask/PROD-70-export`');
    // A fix past the card's text is BUILT and recorded, never refused as out of scope
    // (MOTIR-11094).
    expect(prompt).toContain('is yours to fix even when the fix goes beyond the card’s text');
    expect(prompt).toContain('a discrepancy: ONE `record_run_discrepancy` call on PROD-70');
    expect(prompt).toContain('as `"discrepancy"` beside');
    expect(prompt).toContain('never a reason to call it out of scope.');
    // Nothing self-reported, so nothing is recorded by the run.
    expect(tools()).not.toContain('record_discrepancy');

    expect(events().map((e) => e.kind)).toEqual([
      'run_opened',
      'checkout_ready',
      'agent_started',
      'agent_exited',
      'log',
      'ci_verdict',
      'card_settled',
    ]);
    expect(events().find((e) => e.kind === 'agent_started')?.data).toEqual({ step: 'review_fix' });
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'completed' }]);
    expect(tools()).not.toContain('link_pull_request');
    expect(tools()).not.toContain('transition_status');
    expect(tools()).not.toContain('open_run');
    expect(process.exitCode).toBeUndefined();
  });

  it('records the build-through points and decisions the review-fix agent self-reported (MOTIR-11094)', async () => {
    const points = [
      {
        planAsked: 'The card named only the populated export.',
        built: 'The empty export keeps its header row.',
        why: 'The review found the header missing on an empty list.',
      },
    ];
    const decisions = [
      { planSaid: 'nothing', chose: 'An empty CSV with headers.', why: 'RFC 4180 practice.' },
    ];
    const deps = setup({
      claims: [reviewClaim()],
      verdicts: [[delivery('passing')]],
      agentReport: { discrepancy: points, decisions },
    });

    await fixCommand('PROD-70', {}, deps);

    const recorded = h.calls.filter((c) => c.tool === 'record_discrepancy');
    expect(recorded).toEqual([
      {
        tool: 'record_discrepancy',
        args: { runId: 'run_fix_1', key: 'PROD-70', points, decisions },
      },
    ]);
    // Recorded before the run closes.
    expect(tools().indexOf('record_discrepancy')).toBeLessThan(tools().indexOf('close_run'));
  });

  it('records a self-report even when the review-fix agent then fails', async () => {
    const points = [{ planAsked: 'a', built: 'b', why: 'c' }];
    const deps = setup({
      claims: [reviewClaim()],
      agentExit: 3,
      agentReport: { discrepancy: points },
    });

    await fixCommand('PROD-70', {}, deps);

    expect(h.calls.filter((c) => c.tool === 'record_discrepancy').map((c) => c.args)).toEqual([
      { runId: 'run_fix_1', key: 'PROD-70', points },
    ]);
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
  });

  it('names a PERSON who sent it back on the approve-and-merge gate', async () => {
    const deps = setup({
      claims: [
        reviewClaim({
          reviewRefusal: {
            gate: 'pull_request_approval',
            findingsMd: 'Rename the export button.',
            reviewerName: 'Yue Zhu',
            decidedAt: '2026-09-29T11:00:00.000Z',
          },
        }),
      ],
      verdicts: [[delivery('passing')]],
    });

    await fixCommand('PROD-70', {}, deps);

    const prompt = h.agents[0]!.prompt;
    expect(prompt).toContain('by a PERSON, on the approve-and-merge gate');
    expect(prompt).toContain('Yue Zhu sent it back on 2026-09-29T11:00:00.000Z:');
    expect(prompt).toContain('> Rename the export button.');
    expect(h.stderr).toContain('PROD-70: answering the review sent back by Yue Zhu.');
  });

  it('a red member is fixed by the shipped loop after the review turn', async () => {
    const deps = setup({
      claims: [reviewClaim()],
      verdicts: [[delivery('failing')], [delivery('passing')]],
    });

    await fixCommand('PROD-70', {}, deps);

    expect(h.agents.map((a) => a.prompt.split('\n')[0])).toEqual([
      '# Answer the code review — PROD-70 (Export the list)',
      '# Make the build pass — PROD-70 (Export the list)',
    ]);
  });

  it('a failed review-fix agent stops before the CI watch, closes halted and exits non-zero', async () => {
    const deps = setup({
      claims: [reviewClaim()],
      verdicts: [[delivery('passing')]],
      agentExit: 3,
    });

    await fixCommand('PROD-70', {}, deps);

    expect(h.agents).toHaveLength(1);
    expect(tools()).not.toContain('get_work_item');
    expect(h.stderr).toContain('PROD-70: the review-fix agent failed — exit 3');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(process.exitCode).toBe(1);
  });

  it('findings with no text still read as a refusal, never a blank quote', async () => {
    const deps = setup({
      claims: [
        reviewClaim({
          reviewRefusal: {
            gate: 'agent_review',
            findingsMd: '  ',
            reviewerName: null,
            decidedAt: '2026-09-29',
          },
        }),
      ],
      verdicts: [[delivery('passing')]],
    });

    await fixCommand('PROD-70', {}, deps);

    expect(h.agents[0]!.prompt).toContain('The review agent sent it back on 2026-09-29:');
    expect(h.agents[0]!.prompt).toContain('> (no findings were recorded)');
  });
});

describe('motir fix — giving up', () => {
  it('after six red verdicts closes the run as halted, exits non-zero and names the check, the repository and 5 attempts', async () => {
    const deps = setup({
      // The give-up re-claim is `mine`, and it names the checks failing NOW.
      claims: [
        claim(),
        claim({ outcome: 'mine', pullRequests: [pr({ failingChecks: ['Lint', 'Vitest'] })] }),
      ],
      verdicts: [[delivery('failing')]],
    });

    await fixCommand('PROD-7', {}, deps);

    expect(h.agents).toHaveLength(5);
    expect(h.agents.map((a) => a.prompt.match(/attempt (\d) of 5/)?.[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(process.exitCode).toBe(1);
    expect(h.stderr).toContain('PROD-7: the repair gave up after 5 attempts.');
    expect(h.stderr).toContain('acme/motir-core#131 — failing: Lint, Vitest');
    const gaveUp = events().find((e) => e.kind === 'ci_gave_up');
    expect(gaveUp?.data).toMatchObject({ kind: 'gave_up', attempts: 5 });
    expect(events().at(-1)).toMatchObject({ kind: 'card_settled', disposition: 'failed' });
  });

  it('a give-up whose re-claim fails still names the repository and the checks it started with', async () => {
    const deps = setup({ claims: [claim()], verdicts: [[delivery('failing')]] });
    const session = sessionRef.current as { client: Record<string, unknown> };
    let first = true;
    session.client['claimWorkItemRepair'] = async () => {
      if (first) {
        first = false;
        return claim();
      }
      throw new Error('ECONNRESET');
    };

    await fixCommand('PROD-7', {}, deps);

    expect(h.stderr).toContain('acme/motir-core#131 — failing: Vitest');
    expect(process.exitCode).toBe(1);
  });

  it('a failing fixing agent closes the run as halted with its detail', async () => {
    const deps = setup({ claims: [claim()], verdicts: [[delivery('failing')]], agentExit: 3 });

    await fixCommand('PROD-7', {}, deps);

    expect(h.stderr).toContain('PROD-7: the repair stopped after 1 attempt — exit 3.');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(process.exitCode).toBe(1);
  });
});

describe('motir fix — refusals touch neither git nor the agent', () => {
  const REASONS: [WorkItemRepairRefusal, string][] = [
    ['not_implemented', 'it is not waiting on a repair'],
    [
      'repair_on_run_target',
      'its pull requests belong to the run on PROD-2 — run `motir fix PROD-2` instead',
    ],
    ['no_pull_requests', 'it has no pull requests'],
    ['ci_running', 'its checks are still running'],
    ['not_failing', 'nothing is failing'],
    // MOTIR-5803: the merge failed for a reason no agent can act on, and the words say
    // what would help instead.
    ['repair_not_code', 'its merge did not land for a reason no code change fixes'],
  ];

  it.each(REASONS)(
    'not_repairable / %s is said in words and exits non-zero',
    async (reason, words) => {
      const deps = setup({
        claims: [
          claim({
            outcome: 'not_repairable',
            reason,
            runTargetKey: reason === 'repair_on_run_target' ? 'PROD-2' : null,
            runId: null,
            holder: null,
            startedAt: null,
            pullRequests: [],
          }),
        ],
      });

      await fixCommand('PROD-7', {}, deps);

      expect(h.stderr).toContain(`PROD-7: not repairable — ${words}`);
      expect(h.stderr).toContain('Nothing was changed.');
      expect(process.exitCode).toBe(1);
      expect(h.git).toHaveLength(0);
      expect(h.agents).toHaveLength(0);
      expect(tools()).toEqual(['claim_repair']);
    },
  );

  it('taken names the holder and the start, and exits non-zero', async () => {
    const deps = setup({
      claims: [
        claim({
          outcome: 'taken',
          holder: { id: 'user_ada', name: 'Ada' },
          startedAt: '2026-09-16T09:00:00.000Z',
          pullRequests: [],
        }),
      ],
    });

    await fixCommand('PROD-7', {}, deps);

    expect(h.stderr).toContain(
      'PROD-7: already being fixed by Ada since 2026-09-16T09:00:00.000Z — not starting a second repair.',
    );
    expect(process.exitCode).toBe(1);
    expect(h.git).toHaveLength(0);
    expect(h.agents).toHaveLength(0);
    // Somebody else's run is never closed by us.
    expect(closes()).toEqual([]);
  });

  it('with no agent configured, refuses BEFORE claiming, so no run is opened', async () => {
    delete process.env['MOTIR_AGENT'];
    const deps = setup({ claims: [claim()] });

    await expect(fixCommand('PROD-7', {}, deps)).rejects.toThrow(
      '`motir fix` needs an agent to run.',
    );
    expect(tools()).toEqual([]);
  });

  it('an empty key is refused before anything', async () => {
    await expect(fixCommand('  ', {})).rejects.toThrow('A work item key is required');
  });
});

describe('motir fix — the run is closed on every exit path', () => {
  it('a missing repository checkout closes the run as halted and runs no agent', async () => {
    const deps = setup({ claims: [claim()], exists: () => false });

    await fixCommand('PROD-7', {}, deps);

    expect(h.stderr).toContain('acme/motir-core#131: no local checkout of motir-core');
    expect(h.agents).toHaveLength(0);
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(process.exitCode).toBe(1);
  });

  it('a branch that cannot be fetched closes the run as halted', async () => {
    const deps = setup({ claims: [claim()], git: fakeGit({ fetchFails: true }) });

    await fixCommand('PROD-7', {}, deps);

    expect(h.stderr).toContain('could not fetch its branch `subtask/PROD-7-thing` — no such ref');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
  });

  it('an interrupt closes the run as interrupted and exits 130', async () => {
    const deps = setup({ claims: [claim()], verdicts: [[delivery('running')]] });
    // Interrupt from inside the wait, as Ctrl-C would during a long build.
    let waits = 0;
    const wait = async () => {
      waits += 1;
      if (waits === 1) h.interrupt?.();
      if (waits > 2) throw new Error('stop the loop');
    };

    await expect(fixCommand('PROD-7', {}, { ...deps, wait })).rejects.toThrow('stop the loop');
    await vi.waitFor(() => expect(h.exits).toEqual([130]));

    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'interrupted' }]);
    // The handler is removed when the command ends.
    expect(h.interrupt).toBeNull();
  });

  it('a server that cannot be read ends the watch as stopped, and the run is closed', async () => {
    const deps = setup({ claims: [claim()] });
    const session = sessionRef.current as { client: Record<string, unknown> };
    session.client['getWorkItem'] = async () => {
      throw new Error('boom');
    };

    await fixCommand('PROD-7', {}, { ...deps, maxCiPolls: 1 });

    expect(h.stderr).toContain('the repair stopped after 0 attempts');
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(process.exitCode).toBe(1);
  });

  it('an unexpected error closes the run as halted, then propagates', async () => {
    const deps = setup({ claims: [claim()], verdicts: [[delivery('failing')]] });

    await expect(
      fixCommand(
        'PROD-7',
        {},
        {
          ...deps,
          runAgentFn: async () => {
            throw new Error('spawn failed');
          },
        },
      ),
    ).rejects.toThrow('spawn failed');

    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'halted' }]);
    expect(h.interrupt).toBeNull();
  });
});

describe('motir fix — two repositories', () => {
  it('checks out both branches and hands the agent both, running in the first', async () => {
    const core = pr();
    const ai = pr({
      repo: 'acme/motir-ai',
      number: 88,
      url: 'https://github.com/acme/motir-ai/pull/88',
      headRef: 'subtask/PROD-7-ai',
    });
    const deps = setup({
      claims: [claim({ pullRequests: [core, ai] })],
      verdicts: [
        [delivery('failing'), delivery('failing', { repo: 'acme/motir-ai', number: 88 })],
        [delivery('passing'), delivery('passing', { repo: 'acme/motir-ai', number: 88 })],
      ],
    });

    await fixCommand('PROD-7', {}, deps);

    const adds = h.git.filter((g) => g.args[0] === 'worktree');
    expect(adds.map((g) => g.cwd)).toEqual(['/work/motir-core', '/work/motir-ai']);
    expect(h.agents).toHaveLength(1);
    expect(h.agents[0]!.cwd).toBe('/work/motir-core-fix-prod-7-131');
    const prompt = h.agents[0]!.prompt;
    expect(prompt).toContain(
      '- **acme/motir-core** — branch `subtask/PROD-7-thing` at `/work/motir-core-fix-prod-7-131`',
    );
    expect(prompt).toContain(
      '- **acme/motir-ai** — branch `subtask/PROD-7-ai` at `/work/motir-ai-fix-prod-7-88`',
    );
    expect(closes()).toEqual([{ runId: 'run_fix_1', stopReason: 'completed' }]);
  });
});

describe('the pure renderers', () => {
  it('prepareCheckouts refuses a worktree path that is in the way on another branch', () => {
    h = { calls: [], git: [], agents: [], stdout: '', stderr: '', interrupt: null, exits: [] };
    const result = prepareCheckouts({
      key: 'PROD-7',
      pullRequests: [pr()],
      rootDir: ROOT,
      config: { serverUrl: 'x', workspace: 'w', project: 'PROD' },
      run: (_b, args) => (args[1] === '--abbrev-ref' ? ok('some-other-branch') : ok()),
      exists: () => true,
    });
    expect(result).toEqual({
      ok: false,
      message:
        'acme/motir-core#131: /work/motir-core-fix-prod-7-131 already exists and is not a checkout of `subtask/PROD-7-thing` — move it aside and run this again.',
    });
  });

  it('prepareCheckouts refuses a local branch that has diverged from the pull request', () => {
    const result = prepareCheckouts({
      key: 'PROD-7',
      pullRequests: [pr()],
      rootDir: ROOT,
      config: { serverUrl: 'x', workspace: 'w', project: 'PROD' },
      run: (_b, args) => {
        if (args[0] === 'merge')
          return { exitCode: 1, stdout: '', stderr: 'Not possible to fast-forward' };
        if (args[1] === '--abbrev-ref') return ok('subtask/PROD-7-thing');
        return ok();
      },
      exists: () => true,
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain('has diverged from the pull request');
  });

  it('prepareCheckouts refuses a worktree add that git rejects, and a checkout that is not on the branch', () => {
    const base = {
      key: 'PROD-7',
      pullRequests: [pr()],
      rootDir: ROOT,
      config: { serverUrl: 'x', workspace: 'w', project: 'PROD' },
      exists: (p: string) => !p.includes('-fix-'),
    };
    const rejected = prepareCheckouts({
      ...base,
      run: (_b, args) =>
        args[0] === 'worktree'
          ? { exitCode: 128, stdout: '', stderr: 'already checked out' }
          : args[1] === '--verify'
            ? { exitCode: 1, stdout: '', stderr: '' }
            : ok(),
    });
    expect((rejected as { message: string }).message).toContain('already checked out');

    const detached = prepareCheckouts({
      ...base,
      run: (_b, args) => (args[1] === '--abbrev-ref' ? ok('HEAD') : ok()),
    });
    expect((detached as { message: string }).message).toContain('is not on `subtask/PROD-7-thing`');
  });

  it('a refusal from a server that sends no reason is still said', () => {
    expect(
      renderRepairRefusal(claim({ outcome: 'not_repairable', reason: null, pullRequests: [] })),
    ).toBe('PROD-7: not repairable — the server refused the repair.\nNothing was changed.');
    expect(
      renderRepairRefusal(claim({ outcome: 'taken', holder: null, startedAt: null })),
    ).toContain('already being fixed by somebody else — not starting');
    expect(
      renderRepairRefusal(
        claim({ outcome: 'not_repairable', reason: 'repair_on_run_target', runTargetKey: null }),
      ),
    ).toContain('the run on its parent — run `motir fix <that key>` instead.');
  });

  it('a give-up with no check names says so rather than printing nothing', () => {
    expect(
      renderRepairGaveUp({
        key: 'PROD-7',
        watch: { kind: 'gave_up', attempts: 1, failing: [] },
        pullRequests: [pr({ failingChecks: [] })],
      }),
    ).toContain('failing: unknown checks');
  });

  it('a queue-failing pull request names the QUEUE’s check, or its reason in words (MOTIR-5720)', () => {
    const exit = {
      rawReason: 'CI_FAILURE',
      exitedAt: '2026-09-18T10:00:00.000Z',
      headSha: 'sha-a',
      failingCheckName: 'Merge queue / e2e',
      failingCheckUrl: 'https://github.com/acme/motir-core/runs/77',
    };
    const out = renderRepairGaveUp({
      key: 'PROD-7',
      watch: {
        kind: 'fix_failed',
        attempts: 1,
        detail: NOTHING_TO_CHANGE_DETAIL,
      },
      pullRequests: [
        pr({ ci: 'passing', failingChecks: [], queueExit: exit }),
        pr({
          number: 132,
          ci: 'passing',
          failingChecks: [],
          queueExit: {
            ...exit,
            rawReason: 'MERGE_CONFLICT',
            failingCheckName: null,
            failingCheckUrl: null,
          },
        }),
      ],
    });
    expect(out).toContain('failing: in the merge queue — Merge queue / e2e');
    expect(out).toContain(
      'failing: in the merge queue — it conflicts with work queued ahead of it',
    );
    expect(out).toContain('push a commit to re-run CI');
  });
});
