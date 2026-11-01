import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoCommand } from '../src/commands/auto.js';
import { batchCommand } from '../src/commands/batch.js';
import { nextCommand, runCommand } from '../src/commands/dispatch.js';
import { buildProgram } from '../src/program.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
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

// THE POLICY FLAGS (MOTIR-3022) — `--disable-log-bug` / `--disable-replan` on
// all four dispatch commands, `--auto-approve-replan` on `auto` alone.
//
// ⚠️ THE ASSERTION THAT MATTERS IS ON THE REQUEST, not on the source. These two
// flags are not CLI-side behaviour: they exist to reach `dispatch_prompt` and
// come back as different PROMPT TEXT, because a sandboxed agent only ever obeys
// the prompt. A flag parsed correctly and threaded nowhere passes every unit
// test on both sides of the seam and changes nothing about what the agent does —
// so every case below is driven against a REAL server and reads the query it
// actually received.

let server: TestServer;
let root: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_findings_token';

beforeAll(async () => {
  server = await startTestServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-findings-'));
  root = join(base, 'workspace');
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  server.v1Calls.length = 0;
  server.resetV1();
  script();
  exitCode = process.exitCode;
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** One ready item that dispatches and finishes, over the real protocol. */
function script(): void {
  const statuses = new Map<string, string>([['PROD-7', 'todo']]);
  const v1: V1Script = {
    'GET /api/v1/projects/{projectKey}/ready/leaves': () => ({
      body: v1Page(
        (statuses.get('PROD-7') ?? 'todo') === 'todo'
          ? [v1ReadyRow('PROD-7', { title: 'Add the thing' })]
          : [],
      ),
    }),
    'GET /api/v1/work-items/{key}': (req) => {
      const key = String(req.params['key']);
      return { body: v1Detail(key, { status: statuses.get(key) ?? 'todo' }) };
    },
    'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => ({
      body: v1DispatchPrompt(String(req.params['key']), {
        prompt: 'PROMPT',
        targetRepo: 'motir-core',
        workflowMode: 'per_item_pr',
        sessionBranch: null,
      }),
    }),
    'POST /api/v1/work-items/{key}/transitions': (req) => {
      const key = String(req.params['key']);
      const status = String((req.body as { status: string }).status);
      statuses.set(key, status);
      return { body: v1Detail(key, { status }) };
    },
    // `batch` records WHAT BUILT the card as its own fact after the transition
    // (MOTIR-2421). Scripted so the drain reaches its summary — which is where
    // the policy line this file asserts on is printed.
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

/** An agent that exits 0 having done nothing. */
const AGENT = { agent: `${process.execPath} -e ""` };

/** A git runner that answers like a repo whose work reached the remote. */
const PUSHED: CommandRunner = (bin, args) => {
  const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
  if (bin === 'git' && args[0] === 'ls-remote') return ok('abc\trefs/heads/subtask/PROD-7');
  if (bin === 'git' && args[0] === 'log') return ok('abc');
  if (bin === 'git' && args[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' };
  if (bin === 'gh' && args[1] === 'create') return ok('https://github.test/pull/1');
  return ok('');
};

/** The `findingsPolicy` values every dispatch-prompt request carried, in order.
 *  `null` for a request that sent no such parameter at all. */
function policiesSent(): (string | null)[] {
  return server.v1Calls
    .filter((c) => c.method === 'GET' && c.path.endsWith('/dispatch-prompt'))
    .map((c) => c.query.get('findingsPolicy'));
}

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

describe.each(COMMANDS)('motir $name — the findings policy on the wire', ({ run }) => {
  it('sends NO policy parameter when neither flag is passed', async () => {
    await run({});
    // Absent, not empty: an omitted parameter is how the server is told to
    // render the COMPLETE protocol, and it is the request this command made
    // before the flag existed.
    expect(policiesSent()).toEqual([null]);
  });

  it('sends `log-bug` for --disable-log-bug', async () => {
    await run({ disableLogBug: true });
    expect(policiesSent()).toEqual(['log-bug']);
  });

  it('sends `replan` for --disable-replan', async () => {
    await run({ disableReplan: true });
    expect(policiesSent()).toEqual(['replan']);
  });

  it('sends both, in the vocabulary’s order, for both flags', async () => {
    await run({ disableLogBug: true, disableReplan: true });
    expect(policiesSent()).toEqual(['log-bug,replan']);
  });

  it('the --no-* ALIASES produce byte-identical requests to their --disable-* forms', async () => {
    // Commander's negated boolean sets `logBug: false`, a DIFFERENT attribute
    // from `disableLogBug` — so this is the assertion that the two are
    // normalised into one answer rather than one of them being read and the
    // other silently ignored.
    await run({ logBug: false, replan: false });
    const viaAlias = policiesSent();
    server.v1Calls.length = 0;
    server.resetV1();
    script();
    await run({ disableLogBug: true, disableReplan: true });
    expect(viaAlias).toEqual(policiesSent());
  });
});

describe('--auto-approve-replan is accepted by `auto` alone', () => {
  it.each([
    ['run', () => runCommand('PROD-7', { ...AGENT, autoApproveReplan: true })],
    ['next', () => nextCommand({ ...AGENT, autoApproveReplan: true })],
    ['batch', () => batchCommand({ ...AGENT, autoApproveReplan: true })],
  ] as const)(
    '`motir %s` refuses it with the guard’s own message, naming auto',
    async (_n, run) => {
      await expect(run()).rejects.toMatchObject({
        message: expect.stringContaining('`motir auto` flag'),
        hint: expect.stringContaining('motir auto --auto-approve-replan'),
      });
      // Refused BEFORE anything was claimed or dispatched.
      expect(server.v1Calls).toHaveLength(0);
    },
  );

  it('`motir auto` accepts it and dispatches normally', async () => {
    await autoCommand({ ...AGENT, max: '1', autoApproveReplan: true }, { run: PUSHED });
    expect(policiesSent()).toEqual([null]);
  });

  it.each([
    ['--disable-replan', { disableReplan: true }],
    ['--no-replan', { replan: false }],
  ])('`motir auto` refuses it together with %s, at parse time', async (_flag, opts) => {
    await expect(
      autoCommand({ ...AGENT, max: '1', autoApproveReplan: true, ...opts }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('contradict each other'),
    });
    // The message names the spelling the user actually typed, not a canonical
    // one they would then have to translate back.
    await expect(
      autoCommand({ ...AGENT, max: '1', autoApproveReplan: true, ...opts }),
    ).rejects.toMatchObject({ message: expect.stringContaining(_flag) });
    expect(server.v1Calls).toHaveLength(0);
  });
});

describe('the flags reach the real program, and the aliases stay unpublished', () => {
  /** The real commander tree, with `process.exit` disabled so a parse failure
   *  fails the assertion rather than the runner. */
  function program(): Command {
    const built = buildProgram();
    const noExit = (command: Command): void => {
      command.exitOverride();
      command.commands.forEach(noExit);
    };
    noExit(built);
    return built;
  }

  const DISPATCH = ['next', 'run', 'auto', 'batch'] as const;

  it.each(DISPATCH)('`motir %s` REGISTERS every flag, so no guard is unreachable', (name) => {
    // MOTIR-1828 / MOTIR-1830: a flag a module guards but the command never
    // declares is rejected by commander first with a bare `unknown option`, and
    // the guidance is dead code from the command line.
    const command = program().commands.find((c) => c.name() === name)!;
    const flags = command.options.map((o) => o.flags);
    expect(flags).toEqual(
      expect.arrayContaining([
        '--disable-log-bug',
        '--disable-replan',
        '--no-log-bug',
        '--no-replan',
        '--auto-approve-replan',
      ]),
    );
  });

  it.each(DISPATCH)('`motir %s --help` lists the --disable-* forms and NOT the aliases', (name) => {
    // Asserted on the OUTPUT, not on `hidden`: the point of hiding is what a
    // reader sees, and a flag marked hidden by a mechanism that stopped working
    // would still read as hidden in the source.
    const help = program()
      .commands.find((c) => c.name() === name)!
      .helpInformation();
    expect(help).toContain('--disable-log-bug');
    expect(help).toContain('--disable-replan');
    expect(help).not.toContain('--no-log-bug');
    expect(help).not.toContain('--no-replan');
  });

  it.each(DISPATCH)('`motir %s` parses the hidden aliases rather than rejecting them', (name) => {
    // The whole reason they exist: someone types the repo's own `--no-*`
    // convention on instinct and gets what they meant.
    const built = program();
    const command = built.commands.find((c) => c.name() === name)!;
    command.action(() => {});
    const argv = ['node', 'motir', name, '--no-log-bug', '--no-replan'];
    if (name === 'run') argv.splice(3, 0, 'PROD-7');
    expect(() => built.parse(argv)).not.toThrow();
    expect(command.opts()).toMatchObject({ logBug: false, replan: false });
  });

  it('`--auto-approve-replan` describes itself differently where it is refused', () => {
    const built = program();
    const descriptionOf = (name: string): string =>
      built.commands
        .find((c) => c.name() === name)!
        .options.find((o) => o.flags === '--auto-approve-replan')!.description;
    expect(descriptionOf('auto')).toContain('keep looping');
    for (const name of ['run', 'next', 'batch']) {
      expect(descriptionOf(name)).toContain('Not supported');
      expect(descriptionOf(name)).toContain('motir auto');
    }
  });
});

describe('every run states the policy it ran under', () => {
  // A run whose agent FILED nothing must be distinguishable from one that was
  // not allowed to; without this line the two summaries are identical.
  let stderr: string;

  beforeEach(() => {
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  it.each(COMMANDS)('$name says so when both are permitted', async ({ run }) => {
    await run({});
    expect(stderr).toContain('bug filing and re-planning both permitted');
  });

  it.each(COMMANDS)('$name names what was disabled', async ({ run }) => {
    await run({ disableLogBug: true });
    expect(stderr).toContain('bug filing DISABLED');
    expect(stderr).toContain('comments instead');
  });

  it('a --print preview states it too, on stderr, leaving the prompt payload alone', async () => {
    // The class of lie this story removes: a human previewing
    // `motir run --print --disable-log-bug` must not read a contract the agent
    // will not receive. The prompt itself is the server's, unchanged by the
    // preview path — there is no preview-only assembly.
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    await runCommand('PROD-7', { print: true, disableLogBug: true });
    expect(stderr).toContain('bug filing DISABLED');
    expect(stdout).not.toContain('Findings policy');
    expect(policiesSent()).toEqual(['log-bug']);
  });
});

describe('no flag changes a default', () => {
  it('an invocation with none of them makes the request it made before they existed', async () => {
    await runCommand('PROD-7', AGENT, { run: PUSHED });
    const queries = server.v1Calls
      .filter((c) => c.path.endsWith('/dispatch-prompt'))
      .map((c) => [...c.query.keys()]);
    // `agentReport` and `agentReportDecisions` are not flags: every prompt read
    // declares that this CLI posts the agent's self-report (MOTIR-8810) and the
    // decisions in it (MOTIR-10000), so they are the keys always present.
    expect(queries).toEqual([['agentReport', 'agentReportDecisions']]);
  });

  it('rejects an unknown findings flag rather than ignoring it', () => {
    const built = buildProgram();
    built.exitOverride();
    built.commands.forEach((c) => c.exitOverride());
    expect(() => built.parse(['node', 'motir', 'next', '--disable-everything'])).toThrow(
      expect.objectContaining({ message: expect.stringContaining('unknown option') }),
    );
  });
});

// A `CliError` is what every refusal above is, so the type is exercised rather
// than assumed from a shape match.
describe('the refusals are CliErrors, so the binary renders them as guidance', () => {
  it('the auto-only refusal', async () => {
    await expect(nextCommand({ ...AGENT, autoApproveReplan: true })).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('the contradiction refusal', async () => {
    await expect(
      autoCommand({ ...AGENT, autoApproveReplan: true, disableReplan: true }),
    ).rejects.toBeInstanceOf(CliError);
  });
});

// ── the guards the STORY owes, not any one card (MOTIR-3024) ────────────────

describe('the guards coverage cannot see', () => {
  /** Every approval call the run made — none is the assertion in most of these. */
  function approvalsRequested(): number {
    return server.v1Calls.filter((c) => c.path.endsWith('/plan-approval')).length;
  }

  it.each([
    ['run', () => runCommand('PROD-7', { ...AGENT, autoApproveReplan: true })],
    ['next', () => nextCommand({ ...AGENT, autoApproveReplan: true })],
    ['batch', () => batchCommand({ ...AGENT, autoApproveReplan: true })],
  ] as const)('`motir %s` refuses --auto-approve-replan and approves NOTHING', async (_n, run) => {
    // The refusal is asserted elsewhere; what this adds is the absence a
    // refusal alone does not prove — a command that refused the flag and then
    // approved anyway would pass every message assertion.
    await expect(run()).rejects.toThrow();
    expect(approvalsRequested()).toBe(0);
  });

  it('`motir batch`s snapshot stays FROZEN — nothing this story added re-reads the ready set', async () => {
    // `batch`'s defining contract, re-asserted after the story: it takes the
    // ready set ONCE. A findings flag that caused a second read would let a card
    // that became ready mid-run be dispatched, which is the one guarantee this
    // command exists to make.
    let readyReads = 0;
    const statuses = new Map<string, string>([
      ['PROD-7', 'todo'],
      ['PROD-8', 'todo'],
    ]);
    server.resetV1();
    server.scriptV1({
      'GET /api/v1/projects/{projectKey}/ready/leaves': () => {
        readyReads += 1;
        // ⚠️ PROD-8 BECOMES READY DURING THE RUN, which is the only fixture that
        // can test this: it is invisible at snapshot time and appears the moment
        // PROD-7 leaves `todo`. A run that re-read the ready set to pick work
        // would find and dispatch it.
        const ready = ['PROD-7'].filter((k) => statuses.get(k) === 'todo');
        if (statuses.get('PROD-7') !== 'todo') ready.push('PROD-8');
        return { body: v1Page(ready.map((k) => v1ReadyRow(k, { title: `Item ${k}` }))) };
      },
      'GET /api/v1/work-items/{key}': (req) => ({
        body: v1Detail(String(req.params['key']), {
          status: statuses.get(String(req.params['key'])) ?? 'todo',
        }),
      }),
      'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => ({
        body: v1DispatchPrompt(String(req.params['key']), {
          prompt: 'PROMPT',
          targetRepo: 'motir-core',
          workflowMode: 'per_item_pr',
          sessionBranch: null,
        }),
      }),
      'POST /api/v1/work-items/{key}/transitions': (req) => {
        const key = String(req.params['key']);
        const status = String((req.body as { status: string }).status);
        statuses.set(key, status);
        return { body: v1Detail(key, { status }) };
      },
      'POST /api/v1/work-items/{key}/implementation': (req) => ({
        body: v1Integration(String(req.params['key']), {
          status: 'implemented',
          sessionBranch: null,
          implementationSource: 'byok',
        }),
      }),
    });

    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      stderr += String(c);
      return true;
    });
    // NO `--max`: the drain stops because its frozen list is exhausted, not
    // because a cap hid the second card from it.
    await batchCommand({ ...AGENT, disableLogBug: true }, { run: PUSHED });

    // ⚠️ TWO reads, and that is CORRECT — the assertion is about what feeds the
    // DRAIN, not about arithmetic. The first is the snapshot; the second is
    // `countNewlyReady`, which runs AFTER the drain and is reporting only. An
    // earlier version of this test asserted `1` and was simply wrong about the
    // command it was guarding.
    expect(readyReads).toBe(2);
    // The property that matters: PROD-8 was ready the whole time and was NEVER
    // dispatched — and the run SAYS so rather than silently dropping it.
    expect(statuses.get('PROD-8')).toBe('todo');
    expect(stderr).toContain('became ready during the run');
    expect(stderr).toContain('PROD-8');
  });
});
