import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { batchCommand } from '../src/commands/batch.js';
import { nextCommand, runCommand } from '../src/commands/dispatch.js';
import { renderPromptEchoHeader } from '../src/dispatch.js';
import { buildProgram } from '../src/program.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import { answerPrView } from './fakePullRequest.js';
import {
  startTestServer,
  v1Detail,
  v1DispatchPrompt,
  v1Integration,
  v1Page,
  v1ReadyRow,
  type TestServer,
  type V1Script,
} from './helpers/testServer.js';

// `--print-prompt` (MOTIR-3052) — echo each assembled prompt to STDERR at the
// moment it is dispatched, on all four dispatch commands.
//
// ⚠️ THE ASSERTION THAT MATTERS IS ON THE BYTES, and on WHICH STREAM they land
// on. The flag exists so a finished run can be audited — the prompt is assembled
// server-side, written to a temp file, and deleted when the dispatch ends — and a
// transcript is only worth having if it is what was SENT. So every case below is
// driven against a REAL server and compares the captured stream against the
// prompt the fixture served, never against a re-render.
//
// The second hazard the file guards is the NAME. `--print` is one word away and
// means the opposite kind of thing (instead-of, not in-addition-to), and on
// `auto` / `batch` it is registered only to be refused. That refusal must not
// catch this flag, and both are asserted.

let server: TestServer;
let root: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_print_prompt_token';

/** What the fixture server hands over — the string an echo must reproduce. */
const PROMPT = 'THE ASSEMBLED PROMPT\nline two\n  indented three\n';

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

let stderr: string;
let stdout: string;
/** Every stderr WRITE, unconcatenated — the only way to assert that the echo is
 *  one write of exactly `prompt` plus at most one terminating newline, rather
 *  than a substring of a stream the run keeps narrating into. */
let stderrChunks: string[];

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-print-prompt-'));
  root = join(base, 'workspace');
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  stderr = '';
  stdout = '';
  stderrChunks = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    stderrChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  server.v1Calls.length = 0;
  server.resetV1();
  script(['PROD-7']);
  exitCode = process.exitCode;
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * N ready items that dispatch and finish, over the real protocol.
 *
 * Each item's prompt carries its own KEY, so a multi-item run's transcript can
 * be checked for one block per item AND for their ORDER — a wall of identical
 * prompts would pass a count assertion and prove nothing about sequencing.
 */
function script(keys: string[], over: Record<string, unknown> = {}): void {
  const statuses = new Map<string, string>(keys.map((key) => [key, 'todo']));
  const v1: V1Script = {
    'GET /api/v1/projects/{projectKey}/ready/leaves': () => ({
      body: v1Page(
        keys
          .filter((key) => (statuses.get(key) ?? 'todo') === 'todo')
          .map((key) => v1ReadyRow(key, { title: `Work ${key}` })),
      ),
    }),
    'GET /api/v1/work-items/{key}': (req) => {
      const key = String(req.params['key']);
      return { body: v1Detail(key, { status: statuses.get(key) ?? 'todo' }) };
    },
    'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => {
      const key = String(req.params['key']);
      return {
        body: v1DispatchPrompt(key, {
          prompt: `${key}\n${PROMPT}`,
          targetRepo: 'motir-core',
          workflowMode: 'per_item_pr',
          sessionBranch: null,
          ...over,
        }),
      };
    },
    'POST /api/v1/work-items/{key}/transitions': (req) => {
      const key = String(req.params['key']);
      const status = String((req.body as { status: string }).status);
      statuses.set(key, status);
      return { body: v1Detail(key, { status }) };
    },
    'POST /api/v1/work-items/{key}/implementation': (req) => ({
      body: v1Integration(String(req.params['key']), {
        status: statuses.get(String(req.params['key'])) ?? 'implemented',
        sessionBranch: null,
        implementationSource: 'byok',
      }),
    }),
  };
  server.scriptV1(v1);
}

/** The prompt the fixture serves for one key — what an echo must reproduce. */
function promptFor(key: string): string {
  return `${key}\n${PROMPT}`;
}

/** An agent that exits 0 having done nothing. */
const AGENT = { agent: `${process.execPath} -e ""` };
/** An agent that FAILS — the run whose transcript matters most. */
const FAILING_AGENT = { agent: `${process.execPath} -e "process.exit(3)"` };

/** A git runner that answers like a repo whose work reached the remote. */
const PUSHED: CommandRunner = (bin, args) => {
  const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
  const pr = answerPrView(bin, args);
  if (pr) return pr;
  if (bin === 'git' && args[0] === 'ls-remote') return ok('abc\trefs/heads/subtask/PROD-7');
  if (bin === 'git' && args[0] === 'log') return ok('abc');
  if (bin === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
  if (bin === 'gh' && args[1] === 'create') return ok('https://github.test/pull/1');
  return ok('');
};

/** Every dispatch command, driven the way the binary drives it. */
const COMMANDS: {
  name: string;
  run: (opts: Record<string, unknown>) => Promise<void>;
}[] = [
  { name: 'run', run: (opts) => runCommand('PROD-7', { ...AGENT, ...opts }, { run: PUSHED }) },
  { name: 'next', run: (opts) => nextCommand({ ...AGENT, ...opts }, { run: PUSHED }) },
  {
    name: 'batch',
    run: (opts) => batchCommand({ ...AGENT, max: '1', ...opts }, { run: PUSHED }),
  },
  { name: 'auto', run: (opts) => autoCommand({ ...AGENT, max: '1', ...opts }, { run: PUSHED }) },
];

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

describe.each(COMMANDS)('motir $name — the prompt echo', ({ run }) => {
  it('writes the assembled prompt VERBATIM to stderr', async () => {
    await run({ printPrompt: true });
    // Byte-identity, not a substring of a re-render: this is the exact string
    // the fixture served and therefore the exact string the agent received.
    expect(stderr).toContain(promptFor('PROD-7'));
  });

  it('writes NOTHING to stdout', async () => {
    await run({ printPrompt: true });
    // stdout during a run may carry the run's own structured output; a 200-line
    // prompt dumped into it would corrupt anything piping or parsing it.
    expect(stdout).not.toContain('THE ASSEMBLED PROMPT');
  });

  it('leaves stderr unchanged WITHOUT the flag', async () => {
    await run({});
    expect(stderr).not.toContain('THE ASSEMBLED PROMPT');
    expect(stderr).not.toContain('PROMPT SENT');
  });

  it('headers the block with the work item key', async () => {
    await run({ printPrompt: true });
    expect(stderr).toContain('──── PROMPT SENT · PROD-7 ────');
  });

  it('prints the prompt even when the agent then FAILS', async () => {
    // The run you most want the transcript for is the one that went wrong, so
    // the echo happens BEFORE the spawn rather than beside a success report.
    await run({ ...FAILING_AGENT, printPrompt: true });
    expect(stderr).toContain(promptFor('PROD-7'));
  });
});

describe('the echo terminates the prompt with EXACTLY one newline', () => {
  // `errVerbatim`'s whole reason to exist beside `info` (which appends
  // unconditionally): a transcript that differs from what was sent by one byte
  // can disagree with the run it claims to describe. Both arms are asserted,
  // because a prompt that happens to end in a newline exercises only one of them.
  it('adds one when the prompt does NOT end in a newline', async () => {
    script(['PROD-7'], { prompt: 'no trailing newline' });
    await runCommand('PROD-7', { ...AGENT, printPrompt: true }, { run: PUSHED });
    expect(stderrChunks).toContain('no trailing newline\n');
  });

  it('adds none when it already does', async () => {
    script(['PROD-7'], { prompt: 'trailing newline\n' });
    await runCommand('PROD-7', { ...AGENT, printPrompt: true }, { run: PUSHED });
    expect(stderrChunks).toContain('trailing newline\n');
    expect(stderrChunks).not.toContain('trailing newline\n\n');
  });
});

describe('the header names the SESSION BRANCH on a lineage dispatch', () => {
  it('carries the branch when the dispatch is in session_lineage mode', async () => {
    script(['PROD-7'], { workflowMode: 'session_lineage', sessionBranch: 'motir/auto-run-1' });
    await autoCommand({ ...AGENT, max: '1', printPrompt: true }, { run: PUSHED });
    expect(stderr).toContain('PROMPT SENT · PROD-7 · motir/auto-run-1');
  });

  it('the renderer omits the branch when there is no lineage', () => {
    const header = renderPromptEchoHeader('PROD-7', {
      key: 'PROD-7',
      prompt: 'x',
      parentKey: null,
      targetRepo: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: 'a-branch-the-mode-does-not-use',
      advisories: [],
    });
    // The branch is named because the prompt's git instructions depend on it —
    // and on `per_item_pr` they do not, whatever the payload happens to carry.
    expect(header).toBe('──── PROMPT SENT · PROD-7 ────');
  });
});

describe('a multi-item run prints ONE block per dispatched item, in dispatch order', () => {
  // The case the flag exists for: `motir auto --print-prompt 2> prompts.log`.
  // A single-item assertion cannot see ordering or duplication.
  it.each([
    {
      name: 'auto',
      run: () => autoCommand({ ...AGENT, max: '3', printPrompt: true }, { run: PUSHED }),
    },
    {
      name: 'batch',
      run: () => batchCommand({ ...AGENT, max: '3', printPrompt: true }, { run: PUSHED }),
    },
  ])('$name', async ({ run }) => {
    script(['PROD-7', 'PROD-8', 'PROD-9']);
    await run();
    for (const key of ['PROD-7', 'PROD-8', 'PROD-9']) {
      expect(occurrences(stderr, promptFor(key))).toBe(1);
    }
    const order = ['PROD-7', 'PROD-8', 'PROD-9'].map((key) =>
      stderr.indexOf(`PROMPT SENT · ${key}`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('`--print` and `--print-prompt` are different flags', () => {
  it('`auto --print` still refuses, with its message unchanged', async () => {
    await expect(autoCommand({ print: true })).rejects.toThrow(
      '`motir auto` cannot run in --print mode.',
    );
  });

  it('`batch --print` still refuses, with its message unchanged', async () => {
    await expect(batchCommand({ print: true })).rejects.toThrow(
      '`motir batch` cannot run in --print mode.',
    );
  });

  it.each([
    {
      name: 'auto',
      run: () => autoCommand({ ...AGENT, max: '1', printPrompt: true }, { run: PUSHED }),
    },
    {
      name: 'batch',
      run: () => batchCommand({ ...AGENT, max: '1', printPrompt: true }, { run: PUSHED }),
    },
  ])('the refusal does NOT catch --print-prompt on $name', async ({ run }) => {
    // An unattended loop is exactly where a transcript is worth having, so the
    // "nobody to paste a prompt" argument — which is about a prompt offered
    // INSTEAD of a run — must not reach a prompt printed ALONGSIDE one.
    await expect(run()).resolves.toBeUndefined();
    expect(stderr).toContain(promptFor('PROD-7'));
  });

  it('on `run`, the two COMPOSE — once on stdout, once on stderr', async () => {
    await runCommand('PROD-7', { print: true, printPrompt: true });
    expect(occurrences(stdout, promptFor('PROD-7'))).toBe(1);
    expect(occurrences(stderr, promptFor('PROD-7'))).toBe(1);
  });

  it('on `next`, the two COMPOSE — once on stdout, once on stderr', async () => {
    await nextCommand({ print: true, printPrompt: true });
    expect(occurrences(stdout, promptFor('PROD-7'))).toBe(1);
    expect(occurrences(stderr, promptFor('PROD-7'))).toBe(1);
  });

  it('`--print-prompt` does NOT suppress the agent — it prints AND runs', async () => {
    // The half of "compose" that is about this flag rather than about `--print`:
    // `--print` replaces the run, this one accompanies it. A scripted agent that
    // writes a file is the only honest way to assert it actually ran.
    const marker = join(root, 'agent-ran');
    const script = join(root, 'agent.cjs');
    writeFileSync(script, `require('fs').writeFileSync(process.argv[2], 'y')`);
    await runCommand(
      'PROD-7',
      { agent: `${process.execPath} ${script} ${marker}`, printPrompt: true },
      { run: PUSHED },
    );
    expect(stderr).toContain(promptFor('PROD-7'));
    expect(stdout).not.toContain('THE ASSEMBLED PROMPT');
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(true);
  });
});

describe('the flag reaches the real program on all four commands', () => {
  function find(program: Command, name: string): Command {
    const command = program.commands.find((c) => c.name() === name);
    if (!command) throw new CliError(`no such command: ${name}`);
    return command;
  }

  function descriptionOf(name: string, flag: string): string {
    const option = find(buildProgram(), name).options.find((o) => o.flags === flag);
    if (!option) throw new CliError(`\`motir ${name}\` does not register ${flag}`);
    return option.description;
  }

  it.each(['run', 'next', 'batch', 'auto'])('`motir %s` registers --print-prompt', (name) => {
    expect(descriptionOf(name, '--print-prompt')).toBeTruthy();
  });

  it.each(['run', 'next', 'batch', 'auto'])(
    '`motir %s` help distinguishes it from --print, on BOTH flags',
    (name) => {
      // Describing the NEW flag well and leaving the old wording alone is what
      // makes a one-word gap a trap; the card asks for both, so both are read.
      const print = descriptionOf(name, '--print');
      const printPrompt = descriptionOf(name, '--print-prompt');
      expect(print).toMatch(/INSTEAD of launching an agent|Not supported/);
      expect(print).toContain('--print-prompt');
      expect(printPrompt.toLowerCase()).toContain('as it is sent');
      expect(printPrompt).toContain('stderr');
      expect(print).not.toBe(printPrompt);
    },
  );
});
