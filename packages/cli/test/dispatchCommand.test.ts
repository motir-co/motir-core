import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors.js';
import { readExcludes } from '../src/sessionExcludes.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type {
  CompleteSessionResult,
  DispatchItem,
  DispatchPrompt,
  WorkItemDetail,
} from '../src/client.js';

// `motir next` / `motir run` / `motir done` orchestration. The MCP session and
// the agent SPAWN are stubbed (both are covered for real elsewhere:
// mcpClient.test.ts and agentRun.test.ts); what is under test here is the
// PIPELINE — which tool calls happen, in what order, what reaches stdout vs
// stderr, and what the failure path records.

const { agentResult, runAgentMock, sessionRef } = vi.hoisted(() => ({
  agentResult: { exitCode: 0, model: null } as { exitCode: number; model: string | null },
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../src/agentRun.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { doneCommand, nextCommand, runCommand } = await import('../src/commands/dispatch.js');

import type { CommandResult, CommandRunner } from '../src/git.js';
import { answerPrView } from './fakePullRequest.js';

// The git runners the push check (MOTIR-3004) is scripted with. `implemented`
// claims the code is on the remote, so every recording path asks git first —
// these are how a test says "the agent pushed" / "the agent pushed nothing"
// without a real remote.
const okResult = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
/** A remote that carries this card's branch, and a session branch carrying its commit. */
const PUSHED: CommandRunner = (bin, args) => {
  // The pull request the agent opened, which the run links (MOTIR-10877).
  const pr = answerPrView(bin, args);
  if (pr) return pr;
  if (args[0] === 'ls-remote') return okResult('abc123\trefs/heads/subtask/PROD-7-add-the-thing');
  if (args[0] === 'log') return okResult('abc123');
  return okResult('');
};
/** A remote with nothing on it — the agent exited 0 having pushed nothing. */
const NOTHING_PUSHED: CommandRunner = (_bin, args) => {
  if (args[0] === 'ls-remote' || args[0] === 'log') return okResult('');
  return okResult('');
};

const SERVER = 'https://app.motir.co';
/** The token owner every dispatch below claims for (MOTIR-2427). */
const OWNER = 'user_me';
const PROMPT_TEXT = 'CONTEXT\nWHAT TO DO\nACCEPTANCE CRITERIA\nGIT WORKFLOW\n';

function dispatchPrompt(over: Partial<DispatchPrompt> = {}): DispatchPrompt {
  return {
    key: 'PROD-7',
    prompt: PROMPT_TEXT,
    parentKey: 'PROD-2',
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
    ...over,
  };
}

function readyItem(over: Partial<DispatchItem> = {}): DispatchItem {
  return {
    key: 'PROD-7',
    kind: 'subtask',
    title: 'Add the thing',
    priority: 'high',
    status: { key: 'todo', category: 'todo' },
    assigneeId: null,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
    ...over,
  };
}

function workItem(over: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    item: {
      identifier: 'PROD-7',
      kind: 'subtask',
      title: 'Add the thing',
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 3,
      estimateMinutes: 40,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
    },
    ancestors: [],
    children: [],
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
    ...over,
  };
}

interface Harness {
  calls: { tool: string; args: unknown }[];
  stdout: string;
  stderr: string;
  root: string;
}

let harness: Harness;
let home: string;

/** Build the fake session + capture the two streams. */
function setup(
  opts: {
    item?: DispatchItem | null;
    detail?: WorkItemDetail;
    prompt?: DispatchPrompt;
    transitionError?: (status: string) => Error | null;
    /** Force the claim's answer by describing the row the server sees
     *  (MOTIR-3048) — a card somebody else holds, or one that is finished. */
    claimRow?: { key: string; title?: string | null; status: string; assigneeId: string | null };
    sessionResult?: CompleteSessionResult;
    repos?: string[];
  } = {},
) {
  const calls: Harness['calls'] = [];
  const root = mkdtempSync(join(tmpdir(), 'motir-root-'));
  for (const repo of opts.repos ?? ['motir-core']) mkdirSync(join(root, repo));

  const client = {
    whoami: async () => {
      calls.push({ tool: 'whoami', args: undefined });
      return { user: { id: OWNER, name: 'Me', email: 'me@motir.test' }, workspace: null };
    },
    // The ATOMIC claim (MOTIR-3048). One call assigns AND flips, and it can
    // refuse — so the stub answers by the server's own rule off whatever status
    // the fixture put on the row, and a test forces a refusal by naming a
    // status rather than by hand-building a result.
    claimWorkItem: async (args: { key: string }) => {
      calls.push({ tool: 'claim', args });
      const row = opts.claimRow ?? {
        key: args.key,
        title: 'Add the thing',
        status: opts.detail?.item.status ?? opts.item?.status?.key ?? 'todo',
        assigneeId: opts.detail?.item.assigneeId ?? opts.item?.assigneeId ?? null,
      };
      const { claim } = resolveFakeClaim(row, { id: OWNER, name: 'Me' }, () => 'Ada');
      return claim;
    },
    nextReady: async (args: unknown) => {
      calls.push({ tool: 'next_ready', args });
      return { item: opts.item === undefined ? readyItem() : opts.item };
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      return opts.detail ?? workItem();
    },
    linkPullRequest: async (args: unknown) => {
      calls.push({ tool: 'link_pull_request', args });
    },
    transitionStatus: async (args: { key: string; status: string }) => {
      calls.push({ tool: 'transition_status', args });
      const err = opts.transitionError?.(args.status);
      if (err) throw err;
      return {};
    },
    dispatchPrompt: async (key: string) => {
      calls.push({ tool: 'dispatch_prompt', args: key });
      return opts.prompt ?? dispatchPrompt();
    },
    markIntegrated: async (args: unknown) => {
      calls.push({ tool: 'mark_integrated', args });
      return {};
    },
    completeSession: async (args: unknown) => {
      calls.push({ tool: 'complete_session', args });
      return (
        opts.sessionResult ?? {
          sessionBranch: 'story/PROD-9',
          results: [{ key: 'PROD-7', outcome: 'completed' as const }],
        }
      );
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

  harness = { calls, stdout: '', stderr: '', root };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    harness.stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    harness.stderr += String(chunk);
    return true;
  });
  return harness;
}

const toolNames = () => harness.calls.map((c) => c.tool);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  delete process.env['MOTIR_AGENT'];
  agentResult.exitCode = 0;
  agentResult.model = null;
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({
    exitCode: agentResult.exitCode,
    signal: null,
    model: agentResult.model,
  }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  if (harness?.root) rmSync(harness.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir next --print', () => {
  it('claims the item to in_progress and prints the SERVER prompt byte-identical', async () => {
    setup();
    await nextCommand({ print: true });

    // ONE call on the claim path (MOTIR-3048). The `updateWorkItem { assigneeId }`
    // + `transitionStatus` pair is gone: the claim assigns AND flips, inside one
    // locked server transaction, so a second `transition_status` here would be a
    // write the CLI no longer has any reason to make.
    expect(toolNames()).toEqual(['whoami', 'next_ready', 'claim', 'dispatch_prompt']);
    expect(harness.calls[2]?.args).toEqual({ key: 'PROD-7' });
    expect(toolNames()).not.toContain('transition_status');
    // The prompt is the ONLY thing on stdout, verbatim — nothing prepended,
    // nothing appended but the single terminating newline.
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('puts the repo + RESOLVED path on stderr, so the pipe stays clean', async () => {
    setup();
    await nextCommand({ print: true });
    expect(harness.stderr).toContain('motir-core');
    expect(harness.stderr).toContain(join(harness.root, 'motir-core'));
    expect(harness.stdout).not.toContain('motir-core');
  });

  it('reports an empty ready set without touching any status', async () => {
    setup({ item: null });
    await nextCommand({ print: true });
    expect(toolNames()).toEqual(['whoami', 'next_ready']);
    expect(harness.stderr).toContain('No ready work items in the leaf lane.');
  });

  it('passes --kinds through to next_ready', async () => {
    setup();
    await nextCommand({ print: true, kinds: 'subtask,bug' });
    expect(harness.calls[1]?.args).toMatchObject({ kinds: ['subtask', 'bug'] });
  });

  it('does NOT re-flip an item that is already In Progress', async () => {
    setup({
      item: readyItem({ status: { key: 'in_progress', category: 'in_progress' } }),
      claimRow: { key: 'PROD-7', status: 'in_progress', assigneeId: OWNER },
    });
    await nextCommand({ print: true });
    expect(toolNames()).toEqual(['whoami', 'next_ready', 'claim', 'dispatch_prompt']);
    // `mine` — the server's word for the recovery this line has always
    // described, and it still proceeds to dispatch (MOTIR-3048).
    expect(harness.stderr).toContain('already In Progress');
  });
});

describe('motir next --agent', () => {
  it('runs the agent in the target repo checkout and lands the item Implemented', async () => {
    setup();
    await nextCommand({ agent: 'claude --yolo' }, { run: PUSHED });

    expect(runAgentMock).toHaveBeenCalledOnce();
    const call = runAgentMock.mock.calls[0]?.[0];
    expect(call.prompt).toBe(PROMPT_TEXT);
    expect(call.cwd).toBe(join(harness.root, 'motir-core'));
    expect(call.command).toMatchObject({ binary: 'claude', args: ['--yolo'] });
    // TWO `get_work_item`s, and they answer different questions — stated here
    // rather than hidden, because this list is where a reviewer counts requests.
    //
    //  * BEFORE the transition — the re-plan read-back (MOTIR-3018): a finished
    //    card and a REFUSED one both exit 0, so the run asks the card which it
    //    was.
    //  * AFTER it — the CI WATCH (MOTIR-3685): the run reads its own card's
    //    delivery set to learn whether the build passed. `v1Detail` carries
    //    `deliveries: []` here, so the watch finds nothing to watch and returns
    //    after exactly ONE read. A project with a CI mirror pays more, and pays
    //    it deliberately.
    //
    // And between them the run's own DELIVERY (MOTIR-10877): it finds the pull request the
    // agent opened and LINKS it — before the transition, so the card it moves to Implemented
    // is one its merge will close.
    expect(toolNames()).toEqual([
      'whoami',
      'next_ready',
      'claim',
      'dispatch_prompt',
      'get_work_item',
      'link_pull_request',
      'transition_status',
      'get_work_item',
    ]);
    // The ONLY transition left on this path is the one the agent EARNED.
    //
    // ⚠️ Found BY NAME, not by index. Both sides of this line were positional
    // and both were wrong after MOTIR-3048's atomic claim and MOTIR-3018's
    // read-back landed together: one expected `[4]`, the other `[6]`, and the
    // merged sequence puts it at 5. The sequence itself is already asserted
    // above, in full and in order, so a position here bought nothing and cost a
    // conflict.
    const transitions = harness.calls.filter((c) => c.tool === 'transition_status');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.args).toEqual({ key: 'PROD-7', status: 'implemented' });
    expect(harness.stderr).toContain('motir done PROD-7');
  });

  it('does NOT record Implemented when the agent pushed NOTHING (MOTIR-3004)', async () => {
    // `implemented` claims the code is on the remote. An agent that exits 0
    // having pushed nothing would otherwise produce a card asserting built work
    // that exists only in a worktree this run is about to delete — so the record
    // is refused, the card stays In Progress, and the item is excluded from the
    // next pick exactly as a failed agent's is.
    setup();
    await nextCommand({ agent: 'claude' }, { run: NOTHING_PUSHED });

    expect(runAgentMock).toHaveBeenCalledOnce();
    // No transition AT ALL now: the dispatch flip happened inside the claim, and
    // the `implemented` one is refused. The card is left where the claim put it.
    expect(harness.calls.filter((c) => c.tool === 'transition_status')).toEqual([]);
    expect(harness.calls.some((c) => c.tool === 'mark_integrated')).toBe(false);
    expect(harness.stderr).toContain('no branch naming PROD-7 is on the remote');
    expect(harness.stderr).toContain('stays In Progress');
    expect(readExcludes(SERVER, 'PROD')).toContainEqual(expect.objectContaining({ key: 'PROD-7' }));
  });

  it('a SESSION-LINEAGE agent that pushed no commit for its card is refused too', async () => {
    // Same rule, asked in the shape session work takes: the card's commit lands
    // ON the session branch, so the question is whether a commit naming the key
    // is on origin/<branch>.
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: 'claude' }, { run: NOTHING_PUSHED });

    expect(harness.calls.some((c) => c.tool === 'mark_integrated')).toBe(false);
    expect(harness.stderr).toContain('no commit naming PROD-7 is on origin/story/PROD-9');
  });

  it('a SESSION-LINEAGE item is mark_integrated on its inherited branch, not PR-flipped', async () => {
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: 'claude' }, { run: PUSHED });

    expect(toolNames()).toContain('mark_integrated');
    expect(harness.calls.find((c) => c.tool === 'mark_integrated')?.args).toMatchObject({
      key: 'PROD-7',
      sessionBranch: 'story/PROD-9',
    });
    // it must NOT also hand-flip the status — mark_integrated does that move,
    // and the dispatch flip was the claim's (MOTIR-3048), so there is no
    // `transition_status` on this path at all.
    expect(harness.calls.filter((c) => c.tool === 'transition_status')).toHaveLength(0);
    expect(harness.stderr).toContain('motir done --session story/PROD-9');
  });

  it('stamps the AGENT and its self-reported model as implementation provenance', async () => {
    // `motir run` is the other seam that launches an agent and records what
    // built the item — it must answer the same way `motir auto` does
    // (MOTIR-2419), or the provenance depends on which command you used.
    agentResult.model = 'claude-opus-5';
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: '/usr/local/bin/cursor-agent --force' }, { run: PUSHED });

    expect(harness.calls.find((c) => c.tool === 'mark_integrated')?.args).toMatchObject({
      implementationHarness: 'cursor',
      implementationModel: 'claude-opus-5',
    });
  });

  it('omits the model — and still names the agent — when the agent reported none', async () => {
    setup({
      prompt: dispatchPrompt({ workflowMode: 'session_lineage', sessionBranch: 'story/PROD-9' }),
    });
    await nextCommand({ agent: 'claude' }, { run: PUSHED });

    // Null, never defaulted: the harness is derivable and stays truthful, the
    // model is not and stays empty.
    expect(harness.calls.find((c) => c.tool === 'mark_integrated')?.args).toMatchObject({
      implementationHarness: 'claude',
      implementationModel: null,
    });
  });

  it('on a NON-ZERO exit: item stays In Progress, is excluded, and the exit code propagates', async () => {
    agentResult.exitCode = 2;
    setup();
    await nextCommand({ agent: 'claude' }, { run: PUSHED });

    // the claim made the dispatch flip; nothing moved the item afterwards
    expect(harness.calls.filter((c) => c.tool === 'transition_status')).toHaveLength(0);
    expect(harness.stderr).toContain('stays In Progress');
    expect(process.exitCode).toBe(2);
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }]);
  });

  // MOTIR-2338: the persisted list holds KEYS, and `next_ready` still narrows by
  // row id — so the skip is now a TRANSLATION. The first ask carries no
  // exclusions; the excluded item is skipped by key inside the client's walk.
  it('the NEXT next skips the excluded item by KEY, in one ask, and --reset un-skips it', async () => {
    agentResult.exitCode = 1;
    setup();
    await nextCommand({ agent: 'claude' }, { run: PUSHED });

    agentResult.exitCode = 0;
    setup();
    await nextCommand({ print: true });
    const asks = harness.calls.filter((c) => c.tool === 'next_ready');
    // ONE ask (MOTIR-2398). The hold-out is applied inside the client's walk
    // over the ranked page, so the ask-learn-the-id-ask-again round trip is
    // gone and the KEY goes straight through from the persisted list.
    expect(asks).toHaveLength(1);
    expect(asks[0]?.args).toMatchObject({ excludeKeys: ['PROD-7'] });
    expect(harness.stderr).toContain('Skipping 1 previously-failed item(s): PROD-7');

    setup();
    await nextCommand({ print: true, reset: true });
    expect(harness.calls[1]?.args).not.toHaveProperty('excludeKeys');
  });

  it('a SUCCESSFUL run clears a prior exclusion for that item', async () => {
    agentResult.exitCode = 1;
    setup();
    await nextCommand({ agent: 'claude' }, { run: PUSHED });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);

    // Retried by KEY — the explicit path, which does not consult the exclude
    // list. `motir next` would keep holding PROD-7 out until `--reset`, which
    // is what the test above asserts.
    agentResult.exitCode = 0;
    setup();
    await runCommand('PROD-7', { agent: 'claude' }, { run: PUSHED });
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('BOOTSTRAP: an item whose checkout is missing runs at the ROOT and is reported suspect', async () => {
    setup({ prompt: dispatchPrompt({ targetRepo: 'brand-new' }), repos: [] });
    await nextCommand({ agent: 'claude' }, { run: PUSHED });

    expect(runAgentMock.mock.calls[0]?.[0].cwd).toBe(harness.root);
    expect(harness.stderr).toContain('Suspect dispatch');
    expect(harness.stderr).toContain('motir link add brand-new');
  });

  it('BOOTSTRAP is silent when the agent actually created the checkout', async () => {
    setup({ prompt: dispatchPrompt({ targetRepo: 'brand-new' }), repos: [] });
    runAgentMock.mockImplementation(async () => {
      mkdirSync(join(harness.root, 'brand-new'));
      return { exitCode: 0, signal: null };
    });
    await nextCommand({ agent: 'claude' }, { run: PUSHED });
    expect(harness.stderr).not.toContain('Suspect dispatch');
  });
});

describe('motir run <key>', () => {
  it('REFUSES a not-ready item without --force, naming the blockers', async () => {
    setup({
      detail: workItem({
        readiness: {
          ready: false,
          openBlockers: [
            { identifier: 'PROD-3', kind: 'subtask', title: 'Schema', status: 'todo' },
          ],
          blockedByAncestor: null,
        },
      }),
    });
    await expect(runCommand('PROD-7', {})).rejects.toThrow(/not ready.*PROD-3/s);
    // nothing was claimed
    expect(toolNames()).toEqual(['get_work_item']);
  });

  it('dispatches a not-ready item WITH --force, and says it did', async () => {
    setup({
      detail: workItem({
        readiness: { ready: false, openBlockers: [], blockedByAncestor: null },
      }),
    });
    await runCommand('PROD-7', { force: true, print: true });
    expect(toolNames()).toEqual(['get_work_item', 'whoami', 'claim', 'dispatch_prompt']);
    expect(harness.stderr).toContain('--force');
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });

  it('dispatches a ready item straight through', async () => {
    setup();
    await runCommand('PROD-7', { print: true });
    expect(toolNames()).toEqual(['get_work_item', 'whoami', 'claim', 'dispatch_prompt']);
  });

  it('rejects an empty key before any network call', async () => {
    setup();
    await expect(runCommand('   ', {})).rejects.toThrow(CliError);
    expect(toolNames()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HARD vs SOFT blocks — `--allow-soft-block` (MOTIR-6355)
// ─────────────────────────────────────────────────────────────────────────────
//
// The verdict the command already read tells the two apart: open blockers of
// its own are HARD; `ready: false` with none and a `blockedByAncestor` is SOFT.
describe('motir run <key> --allow-soft-block (MOTIR-6355)', () => {
  const SOFT = workItem({
    readiness: {
      ready: false,
      openBlockers: [],
      blockedByAncestor: { identifier: 'PROD-2', title: 'The story' },
    },
  });
  const HARD = workItem({
    readiness: {
      ready: false,
      openBlockers: [{ identifier: 'PROD-3', kind: 'subtask', title: 'Schema', status: 'todo' }],
      blockedByAncestor: { identifier: 'PROD-2', title: 'The story' },
    },
  });

  it('claims and dispatches a SOFT-blocked item, naming the overridden ancestor', async () => {
    setup({ detail: SOFT });
    await runCommand('PROD-7', { allowSoftBlock: true, print: true });
    expect(toolNames()).toEqual(['get_work_item', 'whoami', 'claim', 'dispatch_prompt']);
    expect(harness.stderr).toContain(
      "PROD-7 is held only by its ancestor PROD-2's block — dispatching (--allow-soft-block).",
    );
    expect(harness.stderr).not.toContain('(--force)');
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });

  it('still REFUSES a HARD-blocked item, naming its blockers, and claims nothing', async () => {
    setup({ detail: HARD });
    const err = await runCommand('PROD-7', { allowSoftBlock: true, print: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/PROD-7 is not ready.*PROD-3 \(Schema\)/s);
    expect((err as CliError).hint).toContain('overrides only an ancestor');
    expect((err as CliError).hint).toContain('--force');
    expect(toolNames()).toEqual(['get_work_item']);
  });

  it('dispatches a READY item with the flag silently — there is nothing to override', async () => {
    setup();
    await runCommand('PROD-7', { allowSoftBlock: true, print: true });
    expect(toolNames()).toEqual(['get_work_item', 'whoami', 'claim', 'dispatch_prompt']);
    expect(harness.stderr).not.toContain('--allow-soft-block');
  });

  it('WITHOUT the flag, a SOFT block is refused and the hint names --allow-soft-block', async () => {
    setup({ detail: SOFT });
    const err = await runCommand('PROD-7', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toContain('--allow-soft-block');
    expect((err as CliError).hint).not.toContain('--force');
    expect(toolNames()).toEqual(['get_work_item']);
  });

  it('WITHOUT the flag, a HARD block is refused and the hint names --force', async () => {
    setup({ detail: HARD });
    const err = await runCommand('PROD-7', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).hint).toBe('Pass --force to dispatch it anyway.');
  });

  it('--force still passes a SOFT block, and says --force', async () => {
    setup({ detail: SOFT });
    await runCommand('PROD-7', { force: true, print: true });
    expect(toolNames()).toContain('dispatch_prompt');
    expect(harness.stderr).toContain('dispatching anyway (--force)');
  });

  it('refuses --allow-soft-block with --force as redundant, before any read', async () => {
    setup({ detail: SOFT });
    const err = await runCommand('PROD-7', { allowSoftBlock: true, force: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('redundant with `--force`');
    expect((err as CliError).hint).toContain('`--force` already overrides both');
    expect(toolNames()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CLAIM DISCRIMINATES (MOTIR-3048)
// ─────────────────────────────────────────────────────────────────────────────
//
// `ensureInProgress` used to be unable to fail meaningfully: it assigned
// unconditionally, transitioned, and whatever it found it proceeded. It now
// makes ONE locked call that answers with one of four outcomes, and the value
// of the whole change is in keeping them apart rather than collapsing them back
// into "did it throw". So each of the four is asserted on its own, through the
// command, on both the picked and the named path.
describe('the CLAIM DISCRIMINATES — four outcomes, four next moves (MOTIR-3048)', () => {
  /** Every refusal shares this: no prompt was fetched, no agent launched, and
   *  the command ended at 0 — a card somebody else holds is not a run failure. */
  function assertRefusedCleanly() {
    expect(toolNames()).not.toContain('dispatch_prompt');
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(harness.stdout).toBe('');
    expect(process.exitCode).toBeUndefined();
  }

  it('ONE server call takes the card — the assign-then-transition pair is gone', async () => {
    setup();
    await runCommand('PROD-7', { print: true });

    // The pair this card replaced was `updateWorkItem { assigneeId }` followed
    // by `transitionStatus`. Exactly one claim, and no status write at all.
    expect(harness.calls.filter((c) => c.tool === 'claim')).toHaveLength(1);
    expect(toolNames()).not.toContain('transition_status');
  });

  it('CLAIMED — proceeds to dispatch, saying nothing', async () => {
    setup();
    await runCommand('PROD-7', { print: true });

    expect(toolNames()).toContain('dispatch_prompt');
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(harness.stderr).not.toContain('already In Progress');
    expect(harness.stderr).not.toContain('not dispatching');
  });

  it('MINE — proceeds, and still prints the already-In-Progress line', async () => {
    // The documented recovery for a card this owner's failed agent left behind.
    // It is the one outcome that both refuses to write anything AND carries on.
    setup({
      detail: workItem({ item: { ...workItem().item, status: 'in_progress', assigneeId: OWNER } }),
    });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('PROD-7: already In Progress — leaving the status as it is.');
    expect(toolNames()).toContain('dispatch_prompt');
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });

  it('TAKEN — does not dispatch, and NAMES the holder', async () => {
    // A loser that cannot name the winner is barely better than one that never
    // knew there was a race. `Ada` comes from the stub's holder lookup.
    setup({
      detail: workItem({
        item: { ...workItem().item, status: 'in_progress', assigneeId: 'user_them' },
      }),
    });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('already claimed by Ada');
    expect(harness.stderr).toContain('It is at in_progress.');
    assertRefusedCleanly();
  });

  it('TAKEN with NOBODY assigned — the MOTIR-2958 shape still refuses, readably', async () => {
    // A sibling that moved the status without ever assigning: `assignee` is
    // null, so the sentence has no name to use and must not print one. This is
    // the shape that motivated carrying `transitionedBy` at all — and when even
    // that is absent, the refusal says so rather than interpolating a blank.
    setup({
      detail: workItem({ item: { ...workItem().item, status: 'in_progress' } }),
      claimRow: { key: 'PROD-7', status: 'in_progress', assigneeId: null },
    });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('PROD-7: already claimed by somebody else');
    expect(harness.stderr).not.toContain('claimed by null');
    assertRefusedCleanly();
  });

  it('NOT CLAIMABLE — does not dispatch, and names the STATUS', async () => {
    setup({ detail: workItem({ item: { ...workItem().item, status: 'in_review' } }) });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('PROD-7: not claimable');
    expect(harness.stderr).toContain('It is at in_review.');
    assertRefusedCleanly();
  });

  it('a `planning` card is refused by the SERVER, not warned about by the CLI', async () => {
    // `pickWarning` used to warn here and dispatch anyway. The warning is gone
    // because the outcome it described can no longer happen.
    setup({ detail: workItem({ item: { ...workItem().item, status: 'planning' } }) });
    await runCommand('PROD-7', { print: true });

    // `pickWarning`'s old sentence, gone in full — not merely reworded.
    expect(harness.stderr).not.toContain('a human has not acted on the plan yet');
    expect(harness.stderr).toContain('It is at planning.');
    assertRefusedCleanly();
  });

  it('⚠️ a DONE card is REFUSED — the silent-reopen path is closed', async () => {
    // The case with no warning at all before this card: `done → in_progress` is
    // a legal workflow edge, so `motir run` on a card that shipped last week
    // quietly reopened it and started an agent on finished work.
    setup({ detail: workItem({ item: { ...workItem().item, status: 'done' } }) });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('PROD-7: not claimable');
    expect(harness.stderr).toContain('It is at done.');
    assertRefusedCleanly();
  });

  it('--force on a BLOCKED card still claims and dispatches', async () => {
    // `--force` bypasses the READINESS gate, and a not-ready card sits at
    // `blocked`, which is inside the to-do CATEGORY — so the server's category
    // re-assert has nothing to object to. The two gates are independent, and
    // this is the test that keeps them so.
    setup({
      detail: workItem({
        item: { ...workItem().item, status: 'blocked' },
        readiness: {
          ready: false,
          openBlockers: [
            { identifier: 'PROD-3', kind: 'subtask', title: 'Schema', status: 'todo' },
          ],
          blockedByAncestor: null,
        },
      }),
    });
    await runCommand('PROD-7', { force: true, print: true });

    expect(harness.stderr).toContain('--force');
    expect(toolNames()).toEqual(['get_work_item', 'whoami', 'claim', 'dispatch_prompt']);
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });

  it('`motir next` refuses the same way — the ONE funnel serves both commands', async () => {
    // The picked path can lose the card between the pick and the claim, which is
    // exactly the window `claim_next_ready` closes for the bare loop and this
    // closes for everything else.
    setup({
      item: readyItem({ status: { key: 'in_progress', category: 'in_progress' } }),
      claimRow: { key: 'PROD-7', status: 'in_progress', assigneeId: 'user_them' },
    });
    await nextCommand({ print: true });

    expect(harness.stderr).toContain('already claimed by Ada');
    expect(toolNames()).toEqual(['whoami', 'next_ready', 'claim']);
    assertRefusedCleanly();
  });
});

// The PROSE-vs-GRAPH warning (MOTIR-2079). The load-bearing property is what it
// does NOT change: `likely-missing-edge` is a severity, never a gate. A card
// carrying one dispatches exactly like a card carrying none — same tool calls,
// same stdout, status 0, no `--force` — and the only difference is a line of
// diagnostics on stderr. If a future change makes any of these fail, it has
// turned the advisory into a blocker, which would falsely stop the three shapes
// MOTIR-1969 enumerates (a boundary-contract card naming both halves of a
// two-PR split, an acceptance criterion naming a card for contrast, and a
// sibling that will be done first).
describe('the prose-vs-graph advisory WARNING (MOTIR-2079)', () => {
  const WITH_ADVISORY = dispatchPrompt({
    advisories: [
      {
        item: 'PROD-7',
        referenced: 'PROD-5',
        referencedStatus: 'in_review',
        severity: 'likely-missing-edge',
      },
    ],
  });

  it('motir run WARNS and still dispatches — exit code 0, no --force required', async () => {
    setup({ prompt: WITH_ADVISORY });
    await runCommand('PROD-7', { print: true });

    expect(harness.stderr).toContain('PROD-5 (in_review)');
    expect(harness.stderr).toContain('NOT a blocker');
    // Byte-identical to the no-advisory run: same calls, same payload, same code.
    expect(toolNames()).toEqual(['get_work_item', 'whoami', 'claim', 'dispatch_prompt']);
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(process.exitCode).toBeUndefined();
  });

  it('motir next WARNS too — the same one site serves both commands', async () => {
    setup({ prompt: WITH_ADVISORY });
    await nextCommand({ print: true });

    expect(harness.stderr).toContain('PROD-5 (in_review)');
    expect(toolNames()).toEqual(['whoami', 'next_ready', 'claim', 'dispatch_prompt']);
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(process.exitCode).toBeUndefined();
  });

  it('the warning is DIAGNOSTICS — stdout stays the prompt alone, so the pipe is clean', async () => {
    setup({ prompt: WITH_ADVISORY });
    await nextCommand({ print: true });
    expect(harness.stdout).toBe(PROMPT_TEXT);
    expect(harness.stdout).not.toContain('PROD-5');
  });

  it('warns in --agent mode too, before the agent is launched', async () => {
    setup({ prompt: WITH_ADVISORY });
    await nextCommand({ agent: 'claude' }, { run: PUSHED });
    expect(harness.stderr).toContain('PROD-5 (in_review)');
    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('says nothing at all when the card carries none', async () => {
    setup({ prompt: dispatchPrompt({ advisories: [] }) });
    await runCommand('PROD-7', { print: true });
    expect(harness.stderr).not.toContain('NOT a blocker');
  });

  it('says nothing when the SERVER omits the field — an older self-hosted Motir', async () => {
    setup({ prompt: dispatchPrompt() });
    await runCommand('PROD-7', { print: true });
    expect(harness.stderr).not.toContain('NOT a blocker');
    expect(harness.stdout).toBe(PROMPT_TEXT);
  });
});

describe('motir done', () => {
  it('flips a single item to done and clears its exclusion', async () => {
    setup();
    await doneCommand('PROD-7', {});
    expect(harness.calls).toEqual([
      { tool: 'transition_status', args: { key: 'PROD-7', status: 'done' } },
    ]);
    expect(harness.stderr).toContain('PROD-7: done.');
  });

  it('surfaces the service’s ALLOWED-TARGETS error verbatim, plus a one-hop hint', async () => {
    const illegal = new CliError(
      'ILLEGAL_TRANSITION: In Progress → Done is not allowed. Allowed: To Do, Blocked, In Review, Cancelled.',
    );
    setup({ transitionError: (status) => (status === 'done' ? illegal : null) });

    await expect(doneCommand('PROD-7', {})).rejects.toMatchObject({
      message: illegal.message,
      hint: expect.stringContaining('--via in_review'),
    });
  });

  it('--via walks through the named status first', async () => {
    setup();
    await doneCommand('PROD-7', { via: 'in_review' });
    expect(harness.calls.map((c) => c.args)).toEqual([
      { key: 'PROD-7', status: 'in_review' },
      { key: 'PROD-7', status: 'done' },
    ]);
  });

  it('--session bulk-closes a merged session branch and prints per-item outcomes', async () => {
    setup({
      sessionResult: {
        sessionBranch: 'story/PROD-9',
        results: [
          { key: 'PROD-7', outcome: 'completed' },
          { key: 'PROD-8', outcome: 'failed', reason: 'no legal path' },
        ],
      },
    });
    await doneCommand(undefined, { session: 'story/PROD-9' });
    expect(toolNames()).toEqual(['complete_session']);
    expect(harness.stderr).toContain('PROD-7: completed');
    expect(harness.stderr).toContain('PROD-8: failed — no legal path');
  });

  it('reports the SOURCE and nothing else — it knows no agent and no model', async () => {
    // MOTIR-2447. The close-out ran after a human merged, days after the agents
    // exited. Sending `motir-cli/<version>` as the harness here overwrote the
    // agent name and model `mark_integrated` recorded during the run.
    setup();
    await doneCommand(undefined, { session: 'story/PROD-9' });

    const args = harness.calls.find((c) => c.tool === 'complete_session')?.args as Record<
      string,
      unknown
    >;
    expect(args).toEqual({ sessionBranch: 'story/PROD-9', implementationSource: 'byok' });
    // Named explicitly, because it is the whole defect: `toEqual` above already
    // fails on it, and saying so keeps the reason attached to the assertion.
    expect(args).not.toHaveProperty('implementationHarness');
    expect(JSON.stringify(args)).not.toContain('motir-cli');
  });

  describe('the CLAIM — every dispatch says who took the card (MOTIR-2427)', () => {
    it('`motir next` claims BEFORE the status moves and before any agent launches', async () => {
      setup();
      await nextCommand({ print: true });

      const names = toolNames();
      // There is no status write to be BEFORE any more — the claim IS the flip
      // (MOTIR-3048). What survives of the original property is that the claim
      // lands before the prompt is fetched and long before an agent launches.
      expect(names).not.toContain('transition_status');
      expect(names.indexOf('claim')).toBeLessThan(names.indexOf('dispatch_prompt'));
      expect(harness.calls.find((c) => c.tool === 'claim')?.args).toEqual({ key: 'PROD-7' });
    });

    it('`motir run <key>` claims a NAMED card too', async () => {
      // Being told which card to take is not being told it is unclaimed.
      setup();
      await runCommand('PROD-7', { print: true });

      expect(harness.calls.find((c) => c.tool === 'claim')?.args).toEqual({ key: 'PROD-7' });
    });

    it('asks WHOAMI once per invocation, not once per item', async () => {
      setup();
      await nextCommand({ print: true });
      expect(harness.calls.filter((c) => c.tool === 'whoami')).toHaveLength(1);
    });

    it('`motir run <key>` WARNS on a card claimed by someone else — and dispatches it', async () => {
      // `run` is GIVEN a key by a person with a reason, so the rule warns rather
      // than refuses. Refusing would break the documented recovery for a card an
      // agent left in progress; saying nothing is what made the collision
      // invisible in the first place.
      setup({
        detail: workItem({
          item: { ...workItem().item, assigneeId: 'user_them' },
        }),
      });
      await runCommand('PROD-7', { print: true });

      expect(harness.stderr).toContain('assigned to someone else');
      expect(harness.stderr).toContain('two agents on one work item');
      // …and it still went ahead: the human asked for it.
      expect(toolNames()).toContain('dispatch_prompt');
    });

    it('`motir run <key>` says nothing about a card that was pickable anyway', async () => {
      setup();
      await runCommand('PROD-7', { print: true });
      expect(harness.stderr).not.toContain('assigned to someone else');
    });
  });

  it('refuses a key AND --session together', async () => {
    setup();
    await expect(doneCommand('PROD-7', { session: 'story/PROD-9' })).rejects.toThrow(/not both/);
  });

  it('requires a key when no --session is given', async () => {
    setup();
    await expect(doneCommand(undefined, {})).rejects.toThrow(CliError);
  });
});

describe('a MULTI-REPOSITORY card — one agent, every repository named (MOTIR-3133)', () => {
  /** A two-repository payload, primary first. */
  const twoRepos = (over: Partial<DispatchPrompt> = {}) =>
    dispatchPrompt({
      targetRepo: 'motir-core',
      targetRepos: [
        { name: 'motir-core', cloneUrl: null, defaultBranch: 'main', delivery: 'awaiting' },
        { name: 'motir-ai', cloneUrl: null, defaultBranch: 'trunk', delivery: 'awaiting' },
      ],
      ...over,
    });

  it('launches ONE agent, in the PRIMARY’s checkout — identical to a card pinning only it', async () => {
    // The decision this asserts is the whole design (ADR §B2): N dispatches
    // would hand each agent the same card and force each to guess which half is
    // its own, which is the straddle the repo-straddle advisory exists to warn
    // about, reproduced by the tool meant to fix it.
    setup({ prompt: twoRepos(), repos: ['motir-core', 'motir-ai'] });
    await nextCommand({ agent: 'claude' });

    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(runAgentMock.mock.calls[0]?.[0].cwd).toBe(join(harness.root, 'motir-core'));
  });

  it('names both repositories, their resolved paths and which one is the cwd, before the agent starts', async () => {
    setup({ prompt: twoRepos(), repos: ['motir-core', 'motir-ai'] });
    await nextCommand({ agent: 'claude' });

    expect(harness.stderr).toContain('2 — this item ships in every one of them');
    expect(harness.stderr).toContain('motir-core  (the working directory)');
    expect(harness.stderr).toContain('motir-ai  (a sibling checkout)');
    expect(harness.stderr).toContain(join(harness.root, 'motir-ai'));
  });

  it('WARNS about the missing checkout, runs anyway, and reports it after a clean exit', async () => {
    // Warning, not refusal — and the post-condition still fires for the element
    // that had nowhere to happen, which is the failure that otherwise exits 0.
    setup({ prompt: twoRepos(), repos: ['motir-core'] });
    await nextCommand({ agent: 'claude' });

    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(harness.stderr).toContain('no checkout here yet');
    expect(harness.stderr).toContain('motir link add motir-ai <path>');
    expect(harness.stderr).toContain('Suspect dispatch');
    expect(harness.stderr).toContain('"motir-ai" still has no checkout');
  });

  it('behaves exactly as today against a server that sends no targetRepos', async () => {
    // The version-skew rule: the CLI ships separately and is routinely pointed
    // at an older self-hosted Motir. Absent must read as "one repository".
    setup({ prompt: dispatchPrompt(), repos: ['motir-core', 'motir-ai'] });
    await nextCommand({ agent: 'claude' });

    expect(runAgentMock.mock.calls[0]?.[0].cwd).toBe(join(harness.root, 'motir-core'));
    expect(harness.stderr).not.toContain('ships in every one of them');
    expect(harness.stderr).not.toContain('motir-ai');
  });
});

describe('a PARTIALLY DELIVERED card — the run says so (MOTIR-3136)', () => {
  const halfShipped = () =>
    dispatchPrompt({
      targetRepo: 'motir-core',
      targetRepos: [
        { name: 'motir-core', cloneUrl: null, defaultBranch: 'main', delivery: 'delivered' },
        { name: 'motir-ai', cloneUrl: null, defaultBranch: 'trunk', delivery: 'awaiting' },
      ],
    });

  it('names the resume, what is done and what remains, BEFORE the agent starts', async () => {
    setup({ prompt: halfShipped(), repos: ['motir-core', 'motir-ai'] });
    await nextCommand({ agent: 'claude' });

    expect(harness.stderr).toContain('PARTIALLY DELIVERED');
    expect(harness.stderr).toContain('already delivered: motir-core');
    expect(harness.stderr).toContain('still outstanding: motir-ai');
  });

  it('does not tell the operator the card is finished when the agent exits 0', async () => {
    setup({ prompt: halfShipped(), repos: ['motir-core', 'motir-ai'] });
    await nextCommand({ agent: 'claude' });

    expect(harness.stderr).toContain('a pull request is expected in EACH of its 2 repositories');
    expect(harness.stderr).not.toContain('its pull request should be open');
    expect(harness.stderr).not.toContain('motir done PROD-7');
  });

  it('prints no resume line for a card whose repositories are all awaiting', async () => {
    setup({
      prompt: dispatchPrompt({
        targetRepos: [
          { name: 'motir-core', cloneUrl: null, defaultBranch: 'main', delivery: 'awaiting' },
          { name: 'motir-ai', cloneUrl: null, defaultBranch: 'trunk', delivery: 'awaiting' },
        ],
      }),
      repos: ['motir-core', 'motir-ai'],
    });
    await nextCommand({ agent: 'claude' });

    expect(harness.stderr).not.toContain('PARTIALLY DELIVERED');
  });

  it('makes NO additional request for any of it — every fact is already on the payload', async () => {
    // The boundary: this card reports, it does not ask. A second read would be a
    // second source of truth about what has shipped, which is the defect
    // `lib/workItems/repoDelivery.ts` exists to prevent one level down.
    //
    // ⚠️ NEITHER `get_work_item` IS THAT READ, and both happen AFTER the agent,
    // so nothing about the delivery report can have come from either: the first
    // is the re-plan read-back (MOTIR-3018) and the second is the CI watch
    // (MOTIR-3685). Asserted by POSITION rather than by absence — the request
    // budget for the REPOSITORY FACTS is still zero, and this test is still the
    // thing that says so, which is why the count is allowed to grow while the
    // property does not.
    setup({ prompt: halfShipped(), repos: ['motir-core', 'motir-ai'] });
    await nextCommand({ agent: 'claude' });

    const names = toolNames();
    // The second `get_work_item` is the delivery read (MOTIR-10877): this checkout has no
    // remote to find a pull request on, so the run asks whether the agent linked one itself.
    // Nothing is linked, and the push check, having no evidence, does not hold the card.
    expect(names).toEqual([
      'whoami',
      'next_ready',
      'claim',
      'dispatch_prompt',
      'get_work_item',
      'get_work_item',
      'transition_status',
      'get_work_item',
    ]);
    // Everything the resume notice reported was rendered before this index —
    // the FIRST card read, which is the earliest either of them occurs.
    expect(names.indexOf('get_work_item')).toBeGreaterThan(names.indexOf('dispatch_prompt'));
  });
});
