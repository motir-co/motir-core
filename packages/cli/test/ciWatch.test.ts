import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CI_FIX_ATTEMPTS,
  HOW_TO_TEST_TOOL_NAME,
  NOTHING_TO_CHANGE_DETAIL,
  ciVerdict,
  failingDeliveries,
  pluralize,
  queueReasonInWords,
  renderFixPrompt,
  runCiWatchPhase,
  CI_WAITING_EVENT_INTERVAL_MS,
  watchAndFixCi,
  type CiWatchEvent,
} from '../src/ciWatch.js';
import type { WorkItemDelivery } from '../src/client.js';

// WATCH CI, AND FIX RED (Story MOTIR-3655 · MOTIR-3685).
//
// The loop is driven directly with a scripted verdict sequence, because what
// this card decides is a COUNTING rule and counting is invisible from the
// outside: five fixes and no more, `running` costs nothing, and the sixth red
// is the give-up. A test through a lane would measure the lane.

function delivery(over: Partial<WorkItemDelivery> = {}): WorkItemDelivery {
  return {
    repo: 'moooon/motir-core',
    number: 1,
    title: 'a change',
    url: 'https://github.com/moooon/motir-core/pull/1',
    state: 'open',
    ci: null,
    baseRef: 'main',
    defaultBranch: 'main',
    ...over,
  };
}

/** A client that answers `getWorkItem` from a scripted list of delivery sets,
 *  repeating the LAST one for ever — so a loop that keeps polling gets a stable
 *  answer instead of running off the end. */
function scripted(sets: (WorkItemDelivery[] | undefined)[]) {
  let call = 0;
  return {
    reads: () => call,
    client: {
      getWorkItem: async () => {
        const set = sets[Math.min(call, sets.length - 1)];
        call += 1;
        return { deliveries: set } as never;
      },
    },
  };
}

interface DriveResult {
  outcome: Awaited<ReturnType<typeof watchAndFixCi>>;
  fixes: number;
  lines: string[];
}

async function drive(
  sets: (WorkItemDelivery[] | undefined)[],
  over: { fixOk?: boolean; maxPolls?: number } = {},
): Promise<DriveResult> {
  const { client } = scripted(sets);
  const lines: string[] = [];
  let fixes = 0;
  const outcome = await watchAndFixCi({
    client,
    key: 'PROD-1',
    report: (line) => lines.push(line),
    wait: async () => {},
    ...(over.maxPolls === undefined ? {} : { maxPolls: over.maxPolls }),
    fix: async () => {
      fixes += 1;
      return over.fixOk === false ? { ok: false, detail: 'exit 3' } : { ok: true };
    },
  });
  return { outcome, fixes, lines };
}

const green = [delivery({ ci: 'passing' })];
const red = [delivery({ ci: 'failing' })];
const pending = [delivery({ ci: 'running' })];

describe('the verdict over a delivery SET', () => {
  it('is green only when EVERY member passes', () => {
    expect(ciVerdict([delivery({ ci: 'passing' }), delivery({ ci: 'passing', number: 2 })])).toBe(
      'green',
    );
    expect(ciVerdict([delivery({ ci: 'passing' }), delivery({ ci: 'running', number: 2 })])).toBe(
      'pending',
    );
  });

  it('RED wins over pending — a failure that has arrived does not wait', () => {
    expect(ciVerdict([delivery({ ci: 'running' }), delivery({ ci: 'failing', number: 2 })])).toBe(
      'red',
    );
  });

  it('an EMPTY set is `nothing`, never green — a card nobody measured has not passed', () => {
    expect(ciVerdict([])).toBe('nothing');
    // And a server too old to publish the field at all says the same thing.
    expect(ciVerdict(undefined)).toBe('nothing');
  });

  it('a delivery with no CI recorded is pending, not a pass', () => {
    // Absence of CI is not a state (`derivePrCiState` returns null for it) and
    // reading it as green would promote on no evidence.
    expect(ciVerdict([delivery({ ci: null })])).toBe('pending');
  });

  it('names the failing members, and only those', () => {
    const set = [delivery({ ci: 'failing' }), delivery({ ci: 'passing', number: 2 })];
    expect(failingDeliveries(set).map((d) => d.number)).toEqual([1]);
  });
});

describe('the loop', () => {
  it('returns green with no fixes when CI is already green', async () => {
    const { outcome, fixes } = await drive([green]);

    expect(outcome).toEqual({ kind: 'green', attempts: 0 });
    expect(fixes).toBe(0);
  });

  it('skips entirely when there is nothing to watch', async () => {
    const { outcome, fixes } = await drive([undefined]);

    expect(outcome).toEqual({ kind: 'nothing' });
    expect(fixes).toBe(0);
  });

  it('WAITS through pending without spending an attempt, then reports green', async () => {
    // The property the whole `running` rule exists for: a slow build must not be
    // able to exhaust the fix budget without a single failure being seen.
    const { outcome, fixes } = await drive([pending, pending, pending, green]);

    expect(outcome).toEqual({ kind: 'green', attempts: 0 });
    expect(fixes).toBe(0);
  });

  it("a pushed fix whose new head has not reported reads PENDING, not the old commit's red (MOTIR-11932)", async () => {
    // The server reads `ci` at the pull request's stored head (`prCiStateAtHead`), so
    // right after the fixing push it answers `ci: null` — the previous commit's red is
    // not this head's. That must WAIT, not count a second attempt the fix was never
    // judged on. (Before the fix the server sent `failing` here, and the loop spent one.)
    const unreported = [delivery({ ci: null })];
    expect(ciVerdict(unreported)).toBe('pending');

    const { outcome, fixes } = await drive([red, unreported, unreported, green]);

    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
    expect(fixes).toBe(1);
  });

  it('fixes a red and reports green after it', async () => {
    const { outcome, fixes, lines } = await drive([red, green]);

    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
    expect(fixes).toBe(1);
    expect(lines.join('\n')).toContain('fixing attempt 1 of 5');
    expect(lines.join('\n')).toContain('green after 1 fix');
  });

  it('gives up on the SIXTH red, having made exactly FIVE fixes', async () => {
    const { outcome, fixes, lines } = await drive([red]);

    expect(fixes).toBe(CI_FIX_ATTEMPTS);
    expect(outcome.kind).toBe('gave_up');
    expect(outcome.kind === 'gave_up' && outcome.attempts).toBe(5);
    // Named, so an operator can see WHICH check in WHICH repository, and how
    // many attempts were made — asserted on the output, not just the outcome.
    expect(lines.join('\n')).toContain('giving up after 5 fixing attempts');
    expect(lines.join('\n')).toContain('moooon/motir-core#1');
  });

  it('PENDING verdicts interleaved with reds do not consume the budget', async () => {
    // Five reds still costs five fixes even with waiting in between, which is
    // what proves the counter keys on the verdict rather than on the poll.
    const { outcome, fixes } = await drive([
      red,
      pending,
      red,
      pending,
      red,
      pending,
      red,
      pending,
      red,
      pending,
      red,
    ]);

    expect(fixes).toBe(CI_FIX_ATTEMPTS);
    expect(outcome.kind).toBe('gave_up');
  });

  it('counts reds ACROSS repositories against ONE budget, not one budget each', async () => {
    // The alternative reading would triple the budget on a three-repository
    // card. Five reds exhausts it however they are distributed.
    const twoRepos = [
      delivery({ ci: 'failing', repo: 'moooon/motir-core', number: 1 }),
      delivery({ ci: 'failing', repo: 'moooon/motir-ai', number: 2 }),
    ];
    const { outcome, fixes, lines } = await drive([twoRepos]);

    expect(fixes).toBe(CI_FIX_ATTEMPTS);
    expect(outcome.kind).toBe('gave_up');
    // And the fixing iteration is pointed at BOTH failing repositories.
    expect(lines.join('\n')).toContain('moooon/motir-core#1, moooon/motir-ai#2');
  });

  it('a THREE-repository set with ONE red is failing, and the fix names only the red one', async () => {
    // The set's verdict is red because ANY member is; the fixing iteration is
    // pointed at the repository that is actually failing, not at all three. An
    // agent sent to a green checkout has nothing to do there and will find
    // something anyway.
    const threeRepos = [
      delivery({ ci: 'passing', repo: 'moooon/motir-core', number: 1 }),
      delivery({ ci: 'failing', repo: 'moooon/motir-ai', number: 2 }),
      delivery({ ci: 'passing', repo: 'moooon/motir-gateway', number: 3 }),
    ];
    expect(ciVerdict(threeRepos)).toBe('red');

    const { lines, outcome } = await drive([threeRepos]);

    expect(outcome.kind).toBe('gave_up');
    expect(outcome.kind === 'gave_up' && outcome.failing.map((d) => d.repo)).toEqual([
      'moooon/motir-ai',
    ]);
    const text = lines.join('\n');
    expect(text).toContain('CI is red in moooon/motir-ai#2');
    expect(text).not.toContain('motir-core#1');
    expect(text).not.toContain('motir-gateway#3');
  });

  it('a FIXING AGENT that fails is not a give-up — the build was never re-tested', async () => {
    const { outcome, fixes } = await drive([red], { fixOk: false });

    expect(fixes).toBe(1);
    expect(outcome.kind).toBe('fix_failed');
    expect(outcome.kind === 'fix_failed' && outcome.detail).toBe('exit 3');
  });

  it('stops polling a build that never reports, with ZERO fixes attempted', async () => {
    // A different thing to say than "five fixes did not work", so it is a
    // different outcome and the attempt count is honest about it.
    const { outcome, fixes } = await drive([pending], { maxPolls: 3 });

    expect(fixes).toBe(0);
    expect(outcome.kind).toBe('fix_failed');
    expect(outcome.kind === 'fix_failed' && outcome.attempts).toBe(0);
  });
});

describe('a card read that FAILS', () => {
  // By the time the watch runs the work is committed, pushed and reviewable. A
  // network blip must not turn a successful run into a crash — but it must not
  // read as "the build is fine" either.
  function throwingClient(times: number, then: WorkItemDelivery[]) {
    let call = 0;
    return {
      getWorkItem: async () => {
        call += 1;
        if (call <= times) throw new Error('ECONNRESET');
        return { deliveries: then } as never;
      },
    };
  }

  it('RETRIES and carries on once the server answers again', async () => {
    const outcome = await watchAndFixCi({
      client: throwingClient(2, [delivery({ ci: 'passing' })]),
      key: 'PROD-1',
      report: () => {},
      wait: async () => {},
      fix: async () => ({ ok: true }),
    });

    expect(outcome).toEqual({ kind: 'green', attempts: 0 });
  });

  it('ends NON-SILENTLY when the server never answers, naming the error', async () => {
    // Exits the loop as `fix_failed`, which the lanes turn into a non-zero exit:
    // "I could not check the build" is a different claim from "the build is
    // fine", and the operator has to be able to tell them apart.
    const lines: string[] = [];
    const outcome = await watchAndFixCi({
      client: throwingClient(99, []),
      key: 'PROD-1',
      report: (line) => lines.push(line),
      wait: async () => {},
      maxPolls: 3,
      fix: async () => ({ ok: true }),
    });

    expect(outcome.kind).toBe('fix_failed');
    expect(outcome.kind === 'fix_failed' && outcome.detail).toContain('ECONNRESET');
    expect(lines.join('\n')).toContain('could not read the work item');
  });

  it('a fixing failure with NO detail still says something', async () => {
    const outcome = await watchAndFixCi({
      client: { getWorkItem: async () => ({ deliveries: [delivery({ ci: 'failing' })] }) as never },
      key: 'PROD-1',
      report: () => {},
      wait: async () => {},
      fix: async () => ({ ok: false }),
    });

    expect(outcome).toEqual({ kind: 'fix_failed', attempts: 1, detail: 'the agent failed' });
  });

  it('uses the REAL agent launcher when none is injected — reached only when it is not needed', async () => {
    // A green card never calls the fixer, so this exercises the default without
    // spawning anything. The alternative is leaving the default arm untested,
    // which is the arm production actually takes.
    const outcome = await runCiWatchPhase({
      client: { getWorkItem: async () => ({ deliveries: [delivery({ ci: 'passing' })] }) as never },
      key: 'PROD-1',
      title: null,
      agent: { command: 'fake', binary: 'fake', args: [] },
      cwd: '/tmp/checkout',
      report: () => {},
      wait: async () => {},
    });

    expect(outcome).toEqual({ kind: 'green', attempts: 0 });
  });

  it('a non-Error thrown value still reaches the report', async () => {
    let call = 0;
    const outcome = await watchAndFixCi({
      client: {
        getWorkItem: async () => {
          call += 1;
          throw 'a bare string';
        },
      },
      key: 'PROD-1',
      report: () => {},
      wait: async () => {},
      maxPolls: 2,
      fix: async () => ({ ok: true }),
    });

    expect(call).toBe(2);
    expect(outcome.kind === 'fix_failed' && outcome.detail).toContain('a bare string');
  });
});

describe('the lane-facing phase — resuming the run’s own session (MOTIR-9048)', () => {
  const plain = { command: 'fresh', binary: 'fresh', args: [] };
  const resumed = { command: 'resume', binary: 'resume', args: ['--resume', 's1'] };

  const watch = async (opts: { resumeAgent?: typeof resumed; reds: number }) => {
    const used: { command: string; prompt: string; cwd: string }[] = [];
    const lines: string[] = [];
    let call = 0;
    const outcome = await runCiWatchPhase({
      client: {
        getWorkItem: async () => {
          call += 1;
          return {
            deliveries: [delivery({ ci: call <= opts.reds ? 'failing' : 'passing' })],
          } as never;
        },
      },
      key: 'PROD-1',
      title: 'the card',
      agent: plain,
      ...(opts.resumeAgent ? { resumeAgent: opts.resumeAgent } : {}),
      cwd: '/tmp/checkout',
      report: (line) => lines.push(line),
      wait: async () => {},
      runAgentFn: async ({ command, prompt, cwd }) => {
        used.push({ command: command.command, prompt, cwd });
        return { exitCode: 0, signal: null, model: null };
      },
    });
    return { outcome, used, lines };
  };

  it('spawns the resume command with the unchanged prompt and cwd on every attempt', async () => {
    const { used, lines } = await watch({ resumeAgent: resumed, reds: 3 });
    expect(used.map((u) => u.command)).toEqual(['resume', 'resume', 'resume']);
    expect(used.every((u) => u.cwd === '/tmp/checkout')).toBe(true);
    expect(used[0]?.prompt).toContain('# Make the build pass — PROD-1 (the card)');
    expect(lines.filter((l) => l.includes('continuing the run’s own agent session'))).toHaveLength(
      3,
    );
    expect(lines.join('\n')).not.toContain('fresh agent');
  });

  it('spawns exactly the plain agent when no resume command is given', async () => {
    const { used, lines } = await watch({ reds: 2 });
    expect(used.map((u) => u.command)).toEqual(['fresh', 'fresh']);
    expect(lines.filter((l) => l.includes('starting a fresh agent'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('continuing');
  });

  it('keeps the budget under either form: five reds give up, a failing agent is fix_failed', async () => {
    const gaveUp = await watch({ resumeAgent: resumed, reds: 99 });
    expect(gaveUp.outcome).toMatchObject({ kind: 'gave_up', attempts: 5 });
    expect(gaveUp.used).toHaveLength(5);
    const failed = await runCiWatchPhase({
      client: { getWorkItem: async () => ({ deliveries: [delivery({ ci: 'failing' })] }) as never },
      key: 'PROD-1',
      title: null,
      agent: plain,
      resumeAgent: resumed,
      cwd: '/tmp/checkout',
      report: () => {},
      wait: async () => {},
      runAgentFn: async () => ({ exitCode: 3, signal: null, model: null }),
    });
    expect(failed).toEqual({ kind: 'fix_failed', attempts: 1, detail: 'exit 3' });
  });
});

describe('the lane-facing phase', () => {
  it('turns a non-zero fixing agent into a fix_failed, naming the exit code', async () => {
    let reads = 0;
    const outcome = await runCiWatchPhase({
      client: {
        getWorkItem: async () => {
          reads += 1;
          return { deliveries: [delivery({ ci: 'failing' })] } as never;
        },
      },
      key: 'PROD-1',
      title: 'the card',
      agent: { command: 'fake', binary: 'fake', args: [] },
      cwd: '/tmp/checkout',
      report: () => {},
      wait: async () => {},
      runAgentFn: async () => ({ exitCode: 7, signal: null, model: null }),
    });

    expect(reads).toBe(1);
    expect(outcome).toEqual({ kind: 'fix_failed', attempts: 1, detail: 'exit 7' });
  });

  it('names the SIGNAL when the fixing agent was killed', async () => {
    const outcome = await runCiWatchPhase({
      client: {
        getWorkItem: async () => ({ deliveries: [delivery({ ci: 'failing' })] }) as never,
      },
      key: 'PROD-1',
      title: null,
      agent: { command: 'fake', binary: 'fake', args: [] },
      cwd: '/tmp/checkout',
      report: () => {},
      wait: async () => {},
      runAgentFn: async () => ({ exitCode: 137, signal: 'SIGKILL', model: null }),
    });

    expect(outcome).toEqual({ kind: 'fix_failed', attempts: 1, detail: 'killed by SIGKILL' });
  });

  it('hands the fixing agent the PROMPT and the failing checkout', async () => {
    const seen: { prompt: string; cwd: string }[] = [];
    let call = 0;
    await runCiWatchPhase({
      client: {
        getWorkItem: async () => {
          call += 1;
          return {
            deliveries: [delivery({ ci: call === 1 ? 'failing' : 'passing' })],
          } as never;
        },
      },
      key: 'PROD-1',
      title: 'the card',
      agent: { command: 'fake', binary: 'fake', args: [] },
      cwd: '/tmp/motir-core',
      report: () => {},
      wait: async () => {},
      runAgentFn: async ({ prompt, cwd }) => {
        seen.push({ prompt, cwd });
        return { exitCode: 0, signal: null, model: null };
      },
    });

    expect(seen).toHaveLength(1);
    // The checkout CI is red on — a fix committed anywhere else reaches no
    // pull request.
    expect(seen[0]?.cwd).toBe('/tmp/motir-core');
    expect(seen[0]?.prompt).toContain('# Make the build pass — PROD-1 (the card)');
  });

  it('renders the heading without a title when the card has none', async () => {
    const prompts: string[] = [];
    let call = 0;
    await runCiWatchPhase({
      client: {
        getWorkItem: async () => {
          call += 1;
          return {
            deliveries: [delivery({ ci: call === 1 ? 'failing' : 'passing' })],
          } as never;
        },
      },
      key: 'PROD-1',
      title: null,
      agent: { command: 'fake', binary: 'fake', args: [] },
      cwd: '/tmp/motir-core',
      report: () => {},
      wait: async () => {},
      runAgentFn: async ({ prompt }) => {
        prompts.push(prompt);
        return { exitCode: 0, signal: null, model: null };
      },
    });

    expect(prompts[0]?.split('\n')[0]).toBe('# Make the build pass — PROD-1');
  });
});

describe('the report’s plural', () => {
  it('reads correctly at ONE, which the cap makes unreachable today', () => {
    // Dead while `CI_FIX_ATTEMPTS` is 5 and alive the moment it becomes a
    // setting somebody sets to 1 (MOTIR-673). Pinned now, not later.
    expect(pluralize(1, 'fixing attempt')).toBe('1 fixing attempt');
    expect(pluralize(2, 'fixing attempt')).toBe('2 fixing attempts');
    expect(pluralize(1, 'fix', 'fixes')).toBe('1 fix');
    expect(pluralize(3, 'fix', 'fixes')).toBe('3 fixes');
  });
});

describe('the real inter-poll wait', () => {
  it('waits, rather than returning immediately — the default every lane gets', async () => {
    // Driven on fake timers, because the POINT of this function is that it
    // takes twenty seconds and a test that spent them would be the slowest in
    // the suite for the least reason. What is asserted is that it does not
    // resolve on its own.
    vi.useFakeTimers();
    try {
      let resolved = false;
      const outcome = runCiWatchPhase({
        client: {
          getWorkItem: async () => ({ deliveries: [delivery({ ci: 'running' })] }) as never,
        },
        key: 'PROD-1',
        title: null,
        agent: { command: 'fake', binary: 'fake', args: [] },
        cwd: '/tmp/checkout',
        report: () => {},
        maxPolls: 1,
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      }).then((o) => {
        resolved = true;
        return o;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect((await outcome).kind).toBe('fix_failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the fixing prompt', () => {
  const prompt = renderFixPrompt({
    key: 'PROD-1',
    title: 'the card',
    failing: [delivery({ ci: 'failing' })],
    attempt: 2,
  });

  it('names the failing pull request and links it', () => {
    expect(prompt).toContain('moooon/motir-core#1');
    expect(prompt).toContain('https://github.com/moooon/motir-core/pull/1');
  });

  it('says which attempt this is, out of the cap', () => {
    expect(prompt).toContain(`attempt 2 of ${CI_FIX_ATTEMPTS}`);
  });

  it('tells the agent to READ the failure before fixing it', () => {
    // The repo's standing rule. An agent handed a red check will otherwise
    // confidently invent a fix for a failure it never looked at.
    expect(prompt).toContain('Read the ACTUAL failure first');
  });

  it('explicitly permits changing NOTHING on an environmental failure', () => {
    // The single most common right answer, and the one an agent under
    // instruction to "make the build pass" will not reach on its own.
    expect(prompt).toContain('ENVIRONMENTAL');
    expect(prompt).toContain('change NOTHING');
    expect(prompt).toContain('Changing nothing is a legitimate outcome');
  });

  it('forbids opening a new pull request or moving the card', () => {
    // It is repair work on pull requests that already exist — not a new card.
    expect(prompt).toContain('Open no new pull');
    expect(prompt).toContain('link nothing');
    expect(prompt).toContain('Do not move the work item: leave its status');
  });

  // MOTIR-6065: How to test is written for the WORK ITEM, not for a commit, and
  // the item page no longer flags a record whose commit the pull request moved
  // past. A fix is the one commit after the handover that can make the steps
  // wrong, and only this agent knows whether it did.
  it('keeps How to test true: a fix that changes a step it describes re-publishes it', () => {
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).toContain('Keep How to test true.');
    expect(flat).toContain('How to test belongs to the work item, not to a commit.');
    expect(flat).toContain(
      `publish the whole corrected text with the ${HOW_TO_TEST_TOOL_NAME} tool, on PROD-1`,
    );
    expect(flat).toContain('update that section of the body to match');
    expect(flat).toContain('A fix that changes none of them — the usual case — publishes nothing.');
  });

  it('names the How-to-test tool the server registers, byte for byte', () => {
    // Re-typed ON PURPOSE: the CLI cannot import `lib/dispatch/promptTemplate.ts`.
    expect(HOW_TO_TEST_TOOL_NAME).toBe('publish_test_instructions');
  });

  it('says the PUSH is the verification, and bans the wider local re-run', () => {
    // The pull toward re-running is strongest HERE and it does not feel like
    // waste — it feels like checking your work. In this loop it is redundant by
    // construction: every fixing iteration pushes, every push re-triggers CI, so
    // the next poll already produces the verdict the local run anticipates.
    // Observed: a run whose CI named ONE file fixed that file, then ran 294
    // files to check the blast radius and harvested five unrelated
    // database-contention failures belonging to other sessions.
    expect(prompt).toContain('THE PUSH IS THE VERIFICATION');
    expect(prompt).toContain('AT MOST the single file');
    expect(prompt).toContain('NEVER the suite');
  });

  it('does not merely discourage the wide run — it gives the REASON', () => {
    // A bare prohibition is the kind an agent reasons its way around ("this
    // case is different"). The reason is what closes that door: the local copy
    // is not merged with the default branch, so it is the WEAKER evidence, not
    // merely the slower one.
    expect(prompt).toContain('NOT merged');
    expect(prompt).toContain('less trustworthy');
  });

  it('makes MERGING THE BASE the first step — ahead of reading the log', () => {
    // CI checks out the branch MERGED with the branch it targets, so the log
    // describes a tree the fixing agent's checkout does not have: the file it
    // names can be a sibling's that landed after this branch started, and the
    // failure can be inherited and already repaired. Reading first means
    // diagnosing the wrong tree — so the ORDER is the rule, not the mention.
    expect(prompt).toContain('MERGE THE LATEST BASE BRANCH FIRST');
    expect(prompt.indexOf('MERGE THE LATEST BASE BRANCH FIRST')).toBeLessThan(
      prompt.indexOf('Read the ACTUAL failure first'),
    );
    expect(prompt).toContain('A MERGE, never a rebase');
  });

  it('names the branch to merge — the one the pull request TARGETS', () => {
    // A stacked pull request is based on its parent's branch and CI merges it
    // with THAT, so the instruction is keyed off `baseRef`, never a hardcoded
    // `main`.
    expect(prompt).toContain('git fetch origin && git merge origin/main');
    expect(
      renderFixPrompt({
        key: 'PROD-1',
        title: null,
        failing: [delivery({ ci: 'failing', baseRef: 'parent/PROD-2' })],
        attempt: 1,
      }),
    ).toContain('git merge origin/parent/PROD-2');
  });

  it('falls back to a POINTER when the failing pull requests disagree on a base', () => {
    // One name would be wrong for at least one of them, and a wrong branch name
    // is worse than none — so the set's bases are listed per pull request.
    const mixed = renderFixPrompt({
      key: 'PROD-1',
      title: null,
      failing: [
        delivery({ ci: 'failing' }),
        delivery({ ci: 'failing', number: 2, baseRef: 'parent/PROD-2' }),
      ],
      attempt: 1,
    });

    expect(mixed).toContain("git merge origin/<that pull request's base>");
    expect(mixed).toContain('(base `main`)');
    expect(mixed).toContain('(base `parent/PROD-2`)');
  });

  it('says the merge is PUSHED, and that a green merge ends it', () => {
    // Otherwise the step reads as a local manoeuvre, and the one case it exists
    // to catch — an inherited red already repaired on the base — needs a push to
    // be observed at all. It is also the cheapest possible outcome: no diff.
    expect(prompt).toContain('Push the merge like any other iteration');
    expect(prompt).toContain('merge alone turns the build green');
    expect(prompt).toContain('INHERITED');
  });
});

describe('there is exactly ONE CI verdict, and it is the server’s', () => {
  // The AC's `git grep`, as an assertion. `derivePrCiState` is server-side and
  // reaches the CLI as `deliveries[].ci` (MOTIR-3697); anything the CLI computed
  // itself would be a SECOND verdict, from different inputs by different rules,
  // and it would drift from the pill a person reads on the same card.
  //
  // Walked with `readdirSync` rather than listed: a guard that names files stops
  // guarding the moment somebody adds one.
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // `api/` is GENERATED from the server's own schema — it is the verdict
      // arriving, not a second one being computed.
      if (entry.isDirectory()) {
        if (entry.name !== 'api') out.push(...sources(join(dir, entry.name)));
      } else if (entry.name.endsWith('.ts')) {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  const SRC = join(import.meta.dirname, '..', 'src');

  it('no source file SHELLS OUT for a CI verdict', () => {
    const offenders = sources(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      // The ARGUMENT ARRAY a real shell-out would carry — `['pr', 'checks', …]`
      // — and nothing looser. Keyed on the phrase `gh pr checks` it also matched
      // the PROSE in this module and in `client.ts` explaining why the shell-out
      // is forbidden, so the guard failed about the comment warning against the
      // thing it guards. That is the same lesson `dispatchMaterialize.test.ts`
      // learned one card earlier: a source guard has to match CODE.
      return /['"`]pr['"`]\s*,\s*['"`]checks['"`]/.test(text);
    });

    expect(offenders).toEqual([]);
  });

  it('the watch module runs no commands at all', () => {
    // It reads the card and dispatches an agent. Anything else here would be a
    // door for a locally-derived verdict to come back through.
    const text = readFileSync(join(SRC, 'ciWatch.ts'), 'utf8');

    expect(text).not.toContain('execCommand');
    expect(text).not.toContain('spawnSync');
    expect(text).not.toContain("from './git.js'");
  });
});

// ── AN EJECTED PULL REQUEST IS RED (Story MOTIR-5628 · MOTIR-5720) ───────────────
//
// The merge queue failed on the pull request's MERGE GROUP, so its own `ci` is
// `passing` — and this loop used to call it green on the first poll, with 0
// attempts, and never run the agent. The server now publishes the standing exit on
// the delivery, and the loop reads it.

describe('a STANDING merge-queue failure (MOTIR-5720)', () => {
  const exit = (over: Partial<NonNullable<WorkItemDelivery['queueExit']>> = {}) => ({
    rawReason: 'CI_FAILURE',
    headSha: 'sha-a',
    failingCheckName: 'Merge queue / e2e',
    failingCheckUrl: 'https://github.com/moooon/motir-core/runs/77',
    ...over,
  });
  const ejected = (over: Partial<NonNullable<WorkItemDelivery['queueExit']>> = {}) =>
    delivery({ ci: 'passing', queueExit: exit(over) });

  it('the verdict: passing + queueExit is RED, passing + null is GREEN', () => {
    expect(ciVerdict([ejected()])).toBe('red');
    expect(ciVerdict([delivery({ ci: 'passing', queueExit: null })])).toBe('green');
    // An older Motir sends no field at all — read as no standing failure.
    expect(ciVerdict([delivery({ ci: 'passing' })])).toBe('green');
    expect(failingDeliveries([ejected(), delivery({ ci: 'passing' })])).toHaveLength(1);
  });

  it('the loop RUNS the agent on an ejected delivery instead of calling it green', async () => {
    const { outcome, fixes } = await drive([
      [ejected()],
      [delivery({ ci: 'running', queueExit: null })],
      [delivery({ ci: 'passing', queueExit: null })],
    ]);
    expect(fixes).toBe(1);
    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
  });

  // MOTIR-6594 (`approval-gates.md` §4 FIFTH AMENDMENT): Queue again is refused after a
  // queue FAILURE, so the early stop points at a new head instead.
  it('an attempt that pushes NOTHING ends after ONE attempt, pointing at a new push', async () => {
    const { outcome, fixes, lines } = await drive([[ejected()]]);
    expect(fixes).toBe(1);
    expect(outcome).toEqual({ kind: 'fix_failed', attempts: 1, detail: NOTHING_TO_CHANGE_DETAIL });
    expect(lines.at(-1)).toContain('push a commit to re-run CI');
    expect(lines.at(-1)).not.toContain('use Queue again');
  });

  it('a push whose first check lands a poll late still goes on — one unchanged poll is grace', async () => {
    const { outcome, fixes } = await drive([
      [ejected()],
      // The push happened, but its first pending check has not arrived yet, so
      // the server still reads the old head.
      [ejected()],
      [delivery({ ci: 'running', queueExit: null })],
      [delivery({ ci: 'passing', queueExit: null })],
    ]);
    expect(fixes).toBe(1);
    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
  });

  it('a queue failure BESIDE an own-checks failure is ordinary red, not an early stop', async () => {
    const { outcome, fixes } = await drive([[ejected(), delivery({ number: 2, ci: 'failing' })]]);
    expect(fixes).toBe(CI_FIX_ATTEMPTS);
    expect(outcome.kind).toBe('gave_up');
  });

  it('the prompt says why it left the queue, names the check, and for a CONFLICT says to merge the base', () => {
    const failing = [
      ejected(),
      delivery({
        number: 2,
        url: 'https://github.com/moooon/motir-core/pull/2',
        baseRef: 'parent/PROD-2',
        ci: 'passing',
        queueExit: exit({
          rawReason: 'MERGE_CONFLICT',
          failingCheckName: null,
          failingCheckUrl: null,
        }),
      }),
    ];
    const prompt = renderFixPrompt({ key: 'PROD-1', title: 'A card', failing, attempt: 1 });

    expect(prompt).toContain('## Why it left the merge queue');
    expect(prompt).toContain(queueReasonInWords('CI_FAILURE'));
    expect(prompt).toContain('https://github.com/moooon/motir-core/runs/77');
    expect(prompt).toContain('Merge queue / e2e');
    expect(prompt).toContain(queueReasonInWords('MERGE_CONFLICT'));
    expect(prompt).toContain('Merge `origin/parent/PROD-2` into the branch, resolve the conflicts');
    // A flaky failure still needs a NEW head (MOTIR-6594): Queue again is not offered.
    expect(prompt).toContain('STILL PUSH');
    expect(prompt).toContain('or an empty commit if that merge brought nothing');
    expect(prompt).not.toContain('make NO commit');
    expect(prompt).toContain('*Queue again* is not');
  });

  it('a pull request with no queue exit gets the prompt it always got', () => {
    const prompt = renderFixPrompt({
      key: 'PROD-1',
      title: null,
      failing: [delivery({ ci: 'failing', queueExit: null })],
      attempt: 1,
    });
    expect(prompt).not.toContain('Why it left the merge queue');
  });

  it('an unrecognised reason still reads as something', () => {
    expect(queueReasonInWords('SOMETHING_NEW')).toContain('SOMETHING_NEW');
  });
});

// THE WATCH IS A SIGN OF LIFE (MOTIR-8979).
//
// The server decides a run has stalled from its latest run EVENT, and a watch
// that writes none is killed after 15 minutes of CI — taking the fix loop with
// it. These pin what the watch tells the run, and that it says it on a cadence
// rather than every poll.
describe('what the watch tells the run while it waits', () => {
  async function driveEvents(sets: (WorkItemDelivery[] | undefined)[], stepMs: number) {
    const { client } = scripted(sets);
    const events: CiWatchEvent[] = [];
    let t = 0;
    const outcome = await watchAndFixCi({
      client,
      key: 'PROD-1',
      report: () => {},
      onEvent: (e) => events.push(e),
      now: () => t,
      wait: async () => {
        t += stepMs;
      },
      fix: async () => ({ ok: true }),
    });
    return { outcome, events };
  }

  it('says CI is pending ONCE when it starts waiting', async () => {
    const { events } = await driveEvents([pending, green], 20_000);

    expect(events).toEqual([{ kind: 'log', data: { ci: 'pending', pending: 1 } }]);
  });

  it('repeats "still waiting" every five minutes of a long wait, not every poll', async () => {
    // 20 s polls for 16 minutes: 48 polls, so a per-poll report would be 48 events.
    const polls = Array.from({ length: 48 }, () => pending);
    const { events } = await driveEvents([...polls, green], 20_000);

    const waiting = events.filter((e) => e.kind === 'log' && e.data.ci === 'waiting');
    expect(events[0]).toEqual({ kind: 'log', data: { ci: 'pending', pending: 1 } });
    expect(waiting).toHaveLength(3);
    // No two events further apart than the 15-minute stall window.
    expect(CI_WAITING_EVENT_INTERVAL_MS).toBeLessThan(15 * 60_000);
  });

  it('counts only the deliveries still waiting', async () => {
    const mixed = [delivery({ ci: 'passing' }), delivery({ number: 2, ci: 'running' })];
    const { events } = await driveEvents([mixed, green], 20_000);

    expect(events[0]).toEqual({ kind: 'log', data: { ci: 'pending', pending: 1 } });
  });

  it('reports each fixing attempt, and announces pending again once the fix has pushed', async () => {
    const { outcome, events } = await driveEvents([pending, red, pending, green], 20_000);

    expect(outcome).toEqual({ kind: 'green', attempts: 1 });
    expect(events.map((e) => (e.kind === 'log' ? e.data.ci : e.kind))).toEqual([
      'pending',
      'ci_fix_attempt',
      'pending',
    ]);
    expect(events[1]).toEqual({
      kind: 'ci_fix_attempt',
      data: { attempt: 1, of: CI_FIX_ATTEMPTS, failing: ['moooon/motir-core#1'] },
    });
  });

  it('writes nothing when the card has nothing to watch', async () => {
    const { events } = await driveEvents([undefined], 20_000);

    expect(events).toEqual([]);
  });

  it('a reporter that THROWS never changes the watch', async () => {
    const { client } = scripted([pending, green]);
    const outcome = await watchAndFixCi({
      client,
      key: 'PROD-1',
      report: () => {},
      onEvent: () => {
        throw new Error('the run is gone');
      },
      wait: async () => {},
      fix: async () => ({ ok: true }),
    });

    expect(outcome).toEqual({ kind: 'green', attempts: 0 });
  });

  it('tees the fixing agent’s output to the run', async () => {
    const chunks: string[] = [];
    const { client } = scripted([red, green]);
    await runCiWatchPhase({
      client,
      key: 'PROD-1',
      title: 'a card',
      agent: { binary: 'claude', args: [] } as never,
      cwd: '/tmp/x',
      report: () => {},
      wait: async () => {},
      onOutput: (c) => chunks.push(c),
      runAgentFn: async (input) => {
        input.onOutput?.('fixing…');
        return { exitCode: 0, signal: null } as never;
      },
    });

    expect(chunks).toEqual(['fixing…']);
  });
});
