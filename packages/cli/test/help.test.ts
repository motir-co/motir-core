import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/program.js';
import { HELP_GROUP, HELP_TOPICS, findHelpTopic } from '../src/help.js';
import { CliError } from '../src/errors.js';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// The curated help surface (7.9.12). These tests pin the OUTPUT, not the
// implementation: the overview's section order, that every registered command
// lands under exactly one group heading, the default ADDITIONAL COMMANDS bucket
// a later command subtask relies on, both topics, and the unknown-topic failure
// path.

/** Swallowed stand-in for commander's `process.exit` on the `--help` path. */
class ExitSignal extends Error {}

/**
 * Render what the user actually sees. `helpInformation()` alone is NOT enough —
 * the EXAMPLES / LEARN MORE / FLAGS footer is written by `outputHelp()`'s
 * afterHelp event, so the whole overview only exists at output time. Width and
 * colour are pinned so the rendering is identical on a TTY and in CI.
 */
function render(program: Command, argv: string[] = []): string {
  let text = '';
  const capture = (str: string): boolean => {
    text += str;
    return true;
  };
  const output = {
    writeOut: capture,
    writeErr: capture,
    getOutHelpWidth: () => 80,
    getErrHelpWidth: () => 80,
    getOutHasColors: () => false,
    getErrHasColors: () => false,
  };
  // `configureOutput` swaps the config object on ONE command; every subcommand
  // still holds the reference it inherited at creation, so `motir help auth`
  // would write past the capture. Apply it across the whole tree — and override
  // the exit so `--help` cannot take the test runner down with it.
  const apply = (command: Command): void => {
    command.configureOutput(output);
    command.exitOverride(() => {
      throw new ExitSignal();
    });
    command.commands.forEach(apply);
  };
  apply(program);

  if (argv.length === 0) {
    program.outputHelp();
    return text;
  }
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return text;
}

/** The headings that list COMMANDS (not the EXAMPLES / LEARN MORE prose). */
const COMMAND_HEADINGS = new Set<string>(Object.values(HELP_GROUP));

/** Parse the rendered overview back into `heading → command names`. */
function commandGroups(overview: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  let heading: string | undefined;
  for (const line of overview.split('\n')) {
    const title = /^([A-Z][A-Z ]*:)\s*$/.exec(line)?.[1];
    if (title !== undefined) {
      heading = title;
      if (COMMAND_HEADINGS.has(title)) groups.set(title, []);
      continue;
    }
    if (heading === undefined || !groups.has(heading)) continue;
    if (line.trim() === '') {
      heading = undefined;
      continue;
    }
    // An item line starts its term at column 2; a wrapped description
    // continuation is indented past the term column, so it never matches.
    const item = /^ {2}(\S+)/.exec(line);
    if (item?.[1]) groups.get(heading)?.push(item[1]);
  }
  return groups;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the curated overview', () => {
  it('renders usage → command groups → HELP TOPICS → FLAGS → EXAMPLES → LEARN MORE', () => {
    const overview = render(buildProgram());

    expect(overview).toMatchInlineSnapshot(`
      "Usage: motir [options] [command]

      Motir CLI — terminal dispatch of the work loop (an MCP client of the Motir
      server).

      SETUP COMMANDS:
        login [options]           Connect this terminal: shows a code, opens Motir,
                                  waits for your approval.
        logout [options]          Disconnect this terminal: remove the stored token
                                  for a server.
        auth                      Authenticate to a Motir server with a PAT.
        link [options]            Bind this workspace-root folder to a project, and
                                  clone the repositories it is missing.
        doctor [options]          Preflight your BYOK setup: auth, project link, agent
                                  binary, credential presence.

      READ COMMANDS:
        ready [options]           List the linked project’s ready leaves, grouped
                                  under their runnable containers — or, with --parent
                                  / --bug, the other two ready lanes.
        status [options]          Show the project pulse: ready / in-flight counts +
                                  the active sprint.
        sprints [options]         List the project’s sprints: state, item count,
                                  points, window.
        sprint [options] [ref]    List ONE sprint’s work items (defaults to the active
                                  sprint).
        show [options] <key>      Read one work item (e.g. ACME-7): fields, readiness,
                                  children, edges, body.
        open [options] <key>      Open a work item (e.g. ACME-7) in the browser;
                                  prints the URL.

      WORK LOOP COMMANDS:
        next [options]            Dispatch the next ready leaf (never a bug): claim it
                                  and deliver its prompt. --parent runs the next
                                  runnable container; --bug takes the next bug.
        run [options] <scope>     Run a scope: one work item, a whole story, or
                                  \`sprint\` for the active one.
        fix [options] <key>       Hand a work item whose pull requests are failing,
                                  whose merge could not land because of its code, or
                                  whose acceptance video was sent back to re-run, to
                                  your agent, on their own branches.
        continue [options] <key>  Carry on a work item whose last run died, on the
                                  branch it left — from any machine, without starting
                                  it over.
        review <key>              Hosted only: review a work item’s pull requests at
                                  the version under review and submit ONE verdict —
                                  never pushes, never posts to GitHub.
        auto [options]            Drain the ready set unattended: one item at a time
                                  onto a session branch.
        batch [options]           Implement a FROZEN snapshot of the ready set: one
                                  pull request per item.
        plan [options] [args...]  Plan by talking: resume the project’s planning
                                  conversation, add turns, submit.
        done [options] [key]      Close out a merged item — or a whole merged session
                                  branch.

      ADDITIONAL COMMANDS:
        agent-terminal            The terminal server inside a Motir agent image.

      HELP TOPICS:
        help [command...]         Show help for a command, or read a help topic.
        environment               Environment variables Motir reads, and what each one
                                  overrides.
        files                     The files Motir keeps: the credential store, the
                                  project link, the exclude list.
        runs                      What a dispatch run records, where to watch it, and
                                  what leaves your machine.

      FLAGS:
        -v, --version             Print the CLI version.
        -h, --help                display help for command

      EXAMPLES:
        $ motir login                                      # connect this terminal
        $ motir login --no-browser                         # …over SSH: print the code
        $ motir auth login --server https://app.motir.co   # paste a token you hold
        $ motir link --project MOTIR                       # bind this folder
        $ motir doctor                                     # preflight the setup
        $ motir ready --kinds subtask --assignee me        # what can I pick up?
        $ motir status --json                              # the project pulse
        $ motir sprint                                     # what’s in the active sprint
        $ motir show MOTIR-7                               # the item, its edges, its body
        $ motir show MOTIR-7 --activity                    # …plus comments + history
        $ motir show MOTIR-7 --comments                    # …just what people said
        $ motir open MOTIR-7 --print                       # the item’s URL
        $ motir auto --agent claude --max 5                # drain 5 items unattended
        $ motir batch --agent claude                       # snapshot now, one PR each
        $ motir plan "split the billing epic"              # plan by talking; prints proposals

      LEARN MORE:
        Use \`motir <command> --help\` for the flags of a single command.
        Use \`motir help <topic>\` for a topic: environment, files, runs.
        Read packages/cli/README.md in the Motir checkout for the full guide.
      "
    `);
  });

  it('is byte-identical for `motir`, `motir help`, and `motir --help`', () => {
    const bare = render(buildProgram());
    const helpCommand = render(buildProgram(), ['help']);
    const helpFlag = render(buildProgram(), ['--help']);

    expect(helpCommand).toBe(bare);
    expect(helpFlag).toBe(bare);
  });

  it('writes the overview to STDOUT and exits 0 for a bare `motir`', async () => {
    const program = buildProgram();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await program.parseAsync([], { from: 'user' });

    expect(stdout.mock.calls.join('')).toContain('SETUP COMMANDS:');
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('group membership', () => {
  it('lists every registered command exactly once, under a group heading', () => {
    const program = buildProgram();
    const listed = [...commandGroups(render(program)).values()].flat();

    // Multiset equality in registration order — a command can neither drop out
    // of help nor be listed twice.
    expect([...listed].sort()).toEqual(program.commands.map((cmd) => cmd.name()).sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('puts the shipped commands in their authored groups, in authored order', () => {
    const groups = commandGroups(render(buildProgram()));

    expect([...groups.keys()]).toEqual([
      HELP_GROUP.setup,
      HELP_GROUP.read,
      HELP_GROUP.workLoop,
      HELP_GROUP.additional,
      HELP_GROUP.topics,
    ]);
    // `login` / `logout` lead the group: the device grant is the command a
    // person reaches for, and `auth login --token` is the tier below it.
    expect(groups.get(HELP_GROUP.setup)).toEqual(['login', 'logout', 'auth', 'link', 'doctor']);
    expect(groups.get(HELP_GROUP.read)).toEqual([
      'ready',
      'status',
      'sprints',
      'sprint',
      'show',
      'open',
    ]);
    expect(groups.get(HELP_GROUP.workLoop)).toEqual([
      'next',
      'run',
      'fix',
      'continue',
      'review',
      'auto',
      'batch',
      'plan',
      'done',
    ]);
    // The agent machine's terminal server (MOTIR-6938): published, but not a
    // command a person types, so it takes the default bucket.
    expect(groups.get(HELP_GROUP.additional)).toEqual(['agent-terminal']);
    expect(groups.get(HELP_GROUP.topics)).toEqual(['help', 'environment', 'files', 'runs']);
  });

  it('drops a command registered WITHOUT a group into ADDITIONAL COMMANDS', () => {
    // The guarantee every later command subtask (7.9.3 / 7.9.4 / 7.9.8-10)
    // relies on: registering a command never requires editing help.ts.
    const program = buildProgram();
    program
      .command('throwaway')
      .description('An ungrouped command.')
      .action(() => {});

    const groups = commandGroups(render(program));

    expect(groups.get(HELP_GROUP.additional)).toEqual(['agent-terminal', 'throwaway']);
  });

  it('renders the WORK LOOP heading now that the dispatch commands have landed', () => {
    // 7.9.3 populated the group that 7.9.2 reserved — the guarantee it was
    // reserved FOR. It renders after READ and before HELP TOPICS, which is the
    // registration order in program.ts (`auto` / `batch` join it in 7.9.4+).
    const overview = render(buildProgram());
    expect(overview).toContain(HELP_GROUP.workLoop);
    expect(overview.indexOf(HELP_GROUP.read)).toBeLessThan(overview.indexOf(HELP_GROUP.workLoop));
    expect(overview.indexOf(HELP_GROUP.workLoop)).toBeLessThan(overview.indexOf(HELP_GROUP.topics));
  });
});

describe('per-command help stays commander’s own', () => {
  it.each([
    ['auth', ['auth']],
    ['link', ['link']],
    ['doctor', ['doctor']],
  ])('`motir help %s` matches the command’s own helpInformation', (name, path) => {
    const program = buildProgram();
    const command = program.commands.find((cmd) => cmd.name() === name);
    const rendered = render(program, ['help', ...path]);

    expect(command).toBeDefined();
    expect(rendered).toBe(command?.helpInformation());
  });

  it('walks into nested subcommands (`motir help auth login`, `motir help link add`)', () => {
    expect(render(buildProgram(), ['help', 'auth', 'login'])).toContain(
      'Usage: motir auth login [options]',
    );
    expect(render(buildProgram(), ['help', 'link', 'add'])).toContain(
      'Usage: motir link add [options] <repo> <path>',
    );
  });

  it('keeps a subcommand’s own Options section (the root-only FLAGS move does not leak)', () => {
    const rendered = render(buildProgram(), ['help', 'ready']);

    expect(rendered).toContain('Options:');
    expect(rendered).toContain('--kinds <list>');
    expect(rendered).not.toContain('FLAGS:');
    expect(rendered).not.toContain('EXAMPLES:');
  });
});

describe('help topics', () => {
  it('registers exactly the environment, files and runs topics', () => {
    expect(HELP_TOPICS.map((topic) => topic.name)).toEqual(['environment', 'files', 'runs']);
    expect(findHelpTopic('nope')).toBeUndefined();
  });

  it('`environment` documents the variables the CLI reads, with precedence', () => {
    const body = findHelpTopic('environment')?.body() ?? '';

    for (const name of [
      'MOTIR_TOKEN',
      'MOTIR_SERVER',
      'MOTIR_AGENT',
      'MOTIR_CONFIG_HOME',
      'XDG_CONFIG_HOME',
    ]) {
      expect(body).toContain(name);
    }
    // The credential precedence is the ladder EVERY command applies, not the
    // login-only shortcut it used to describe (MOTIR-1876) — the topic would
    // otherwise document behaviour the CLI no longer has.
    expect(body).toContain('--token <pat>  >  MOTIR_TOKEN  >  config.json');
    expect(body).not.toContain('MOTIR_TOKEN  >  interactive prompt');
    expect(body).toContain('honoured by EVERY command');
    // …and the server ladder, rung for rung, ending at the hosted default.
    expect(body).toContain('--server <url>  >  MOTIR_SERVER  >  .motir.json  >');
    expect(body).toContain('the single stored server  >  https://app.motir.co');
    expect(body).toContain('--agent <cmd>  >  MOTIR_AGENT  >  agentCommand in config.json');
    expect(body).toContain('MOTIR_CONFIG_HOME  >  XDG_CONFIG_HOME  >  ~/.config');
  });

  it('`environment` prints NAMES only — never a variable’s value', () => {
    vi.stubEnv('MOTIR_TOKEN', 'pat_do_not_print_me');
    vi.stubEnv('MOTIR_SERVER', 'https://do_not_print_me.motir.test');
    vi.stubEnv('MOTIR_AGENT', 'agent_do_not_print_me');
    vi.stubEnv('MOTIR_CONFIG_HOME', '/tmp/do_not_print_me');
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/do_not_print_me_either');

    const body = findHelpTopic('environment')?.body() ?? '';

    expect(body).not.toContain('do_not_print_me');
    vi.unstubAllEnvs();
  });

  it('`files` names both config files with their secret status and resolution', () => {
    const body = findHelpTopic('files')?.body() ?? '';

    expect(body).toContain('~/.config/motir/config.json');
    expect(body).toContain('chmod 600');
    expect(body).toContain('never commit');
    expect(body).toContain('.motir.json');
    expect(body).toContain('safe to commit');
    expect(body).toContain('UPWARD');
  });

  it('`runs` sends people to the run modal at /runs?run=<id>, never a /runs/<id> page', () => {
    // There is no `app/(authed)/runs/[id]` route: the run opens as a modal over
    // the Runs list, addressed by the `run` query parameter (`runUrlOf`,
    // lib/mappers/orgFleetMappers.ts). `/runs/<id>` is a 404 (MOTIR-10975).
    const body = findHelpTopic('runs')?.body() ?? '';
    const watch = body.slice(body.indexOf('WHERE TO WATCH IT'), body.indexOf('WHAT LEAVES'));

    expect(watch).toMatch(/^ {2}\/runs\?run=<id> +the run: its set/m);
    expect(body).not.toMatch(/\/runs\/</);
  });

  it('`motir help <topic>` prints the topic body, not the pseudo-command’s usage', async () => {
    const program = buildProgram();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await program.parseAsync(['help', 'files'], { from: 'user' });

    const printed = stdout.mock.calls.join('');
    expect(printed).toContain('FILES');
    expect(printed).not.toContain('Usage: motir files');
  });

  it('surfaces every topic in the overview so they are discoverable', () => {
    const overview = render(buildProgram());
    const listed = commandGroups(overview).get(HELP_GROUP.topics) ?? [];

    for (const topic of HELP_TOPICS) expect(listed).toContain(topic.name);
    // The summaries are wrapped to the help width, so match their opening words
    // rather than the whole line.
    expect(overview).toContain('Environment variables Motir reads');
    expect(overview).toContain('The files Motir keeps');
    expect(overview).toContain('What a dispatch run records');
    expect(overview).toContain('Use `motir help <topic>` for a topic: environment, files, runs.');
  });
});

describe('failure paths go through CliError (stderr + exit 1, no stack)', () => {
  it('rejects an unknown help topic with a message and a hint', async () => {
    const program = buildProgram();

    await expect(program.parseAsync(['help', 'bogus'], { from: 'user' })).rejects.toThrow(CliError);
    await expect(
      buildProgram().parseAsync(['help', 'bogus'], { from: 'user' }),
    ).rejects.toMatchObject({
      message: 'No help topic or command named "bogus".',
      hint: 'Run `motir help` to see the available commands and topics.',
      exitCode: 1,
    });
  });

  it('rejects an unknown COMMAND rather than printing help and exiting 0', async () => {
    await expect(buildProgram().parseAsync(['bogus'], { from: 'user' })).rejects.toMatchObject({
      message: 'Unknown command "bogus".',
      exitCode: 1,
    });
  });

  it('names the whole path when a nested help lookup misses', async () => {
    await expect(
      buildProgram().parseAsync(['help', 'auth', 'bogus'], { from: 'user' }),
    ).rejects.toMatchObject({ message: 'No help topic or command named "auth bogus".' });
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────

describe('the root footer never leaks into a subcommand', () => {
  it('renders EXAMPLES / LEARN MORE only for the root command', () => {
    // `addHelpText('after')` is registered on the program, and its handler runs
    // for a subcommand's help too — the guard is what keeps the root-only footer
    // (and the re-positioned FLAGS block) off `motir ready --help`.
    const sub = render(buildProgram(), ['ready', '--help']);
    expect(sub).toContain('Usage: motir ready');
    expect(sub).not.toContain('EXAMPLES:');
    expect(sub).not.toContain('LEARN MORE:');
    expect(sub).not.toContain('FLAGS:');
  });
});

// ── the help topics describe the SHIPPED layout (MOTIR-1836) ────────────────
//
// `docs/cli.md` states that its environment table is what `motir help
// environment` prints "from the shipped code", so the two have to agree. They
// are separate files with no build step between them, which is exactly how the
// exclude list's documented home stayed at the pre-move path in three places
// after the code had moved it. These assert the pairing rather than the prose.

describe('the help topics match where the CLI actually keeps things', () => {
  const bodyOf = (name: string): string => findHelpTopic(name)?.body() ?? '';

  it('documents every state-home rung, in precedence order', () => {
    const body = bodyOf('environment');
    for (const name of ['MOTIR_STATE_HOME', 'MOTIR_CONFIG_HOME', 'XDG_STATE_HOME']) {
      expect(body, `${name} in the environment topic`).toContain(name);
    }
    // The chain the CLI resolves — a reordering here is a behaviour change.
    expect(body).toMatch(
      /MOTIR_STATE_HOME\s*>\s*MOTIR_CONFIG_HOME\s*>\s*\n?\s*XDG_STATE_HOME\s*>\s*~\/\.local\/state/,
    );
  });

  it('puts the exclude list in the state home, NOT beside the credential', () => {
    const files = bodyOf('files');
    expect(files).toContain('~/.local/state/motir/session-excludes.json');
    // The bug this fixes: state described as living in the read-only config dir.
    expect(files).not.toContain('~/.config/motir/session-excludes.json');
    // and the credential is still where it was
    expect(files).toContain('~/.config/motir/config.json');
  });

  it('agrees with docs/cli.md about both paths', () => {
    const guide = readFileSync(join(CLI_DIR, '..', '..', 'docs', 'cli.md'), 'utf8');
    expect(guide).toContain('~/.local/state/motir/session-excludes.json');
    expect(guide).not.toContain('~/.config/motir/session-excludes.json');
    expect(guide).toContain('MOTIR_STATE_HOME');
  });
});
