import { Command, Help, type Option } from 'commander';
import { AGENT_PROFILES } from './agentProfiles.js';
import { COMMAND_CATALOG, HELP_GROUP } from './commandCatalog.js';
import { CliError } from './errors.js';
import { out } from './output.js';
import { DEFAULT_SERVER_URL } from './serverResolve.js';

// The CURATED help surface. Commander gives `motir help [cmd]`, `motir <cmd>
// --help` and `-h` for free, but its default rendering is one undifferentiated
// `Commands:` list with no examples, topics, or footer. This module replaces
// that rendering with the shape every mature CLI converges on (observed from
// `gh --help`): usage → command groups → help topics → flags → examples →
// learn more.
//
// It is built on commander's NATIVE grouping (`.helpGroup()`,
// `.commandsGroup()`, `.configureHelp()`, `.addHelpText()`), never a
// hand-rolled renderer — term padding, wrapping and styling all stay
// commander's, so this surface cannot drift from the framework's own output.

/**
 * The command-group headings, in the order they render.
 *
 * They are DECLARED in `commandCatalog.ts` and re-exported here, because that
 * record carries each command's group and this module imports `commander` —
 * a record reaching back into it would lose the no-dependency-graph property
 * that lets a documentation page read it (ADR
 * `docs/decisions/public-api-conventions.md` Amendment 12 Q2). The re-export
 * keeps every existing `HELP_GROUP` importer unchanged, and keeps the headings
 * from acquiring a second hand-maintained home.
 */
export { HELP_GROUP };

const FLAGS_HEADING = 'FLAGS:';

// ── Help topics ─────────────────────────────────────────────────────────────
// The questions a command list cannot answer: "which env vars does this read?"
// and "where does my token live?". Both are documented from the shipped code,
// never from memory — see the citations on each entry.

export interface HelpTopic {
  /** The word the user types: `motir help <name>`. */
  name: string;
  /** One-line summary shown in the overview's HELP TOPICS group. */
  summary: string;
  /** The full topic body, printed to stdout. */
  body: () => string;
}

/**
 * The agent credential env vars `motir doctor` tests for PRESENCE, gathered
 * from the profile table so this topic can never drift from it. The doctor
 * never reads a value (agentProfiles.ts / doctor.ts) — and neither does this
 * topic, which prints only names.
 */
function agentCredentialEnvNames(): string[] {
  const names = AGENT_PROFILES.flatMap((profile) => profile.credentialEnv);
  return [...new Set(names)].sort();
}

const ENVIRONMENT_TOPIC: HelpTopic = {
  name: 'environment',
  summary: 'Environment variables Motir reads, and what each one overrides.',
  body: () =>
    [
      'ENVIRONMENT VARIABLES',
      '',
      '  Motir reads eleven environment variables. None is required — each one',
      '  overrides a default, and every value stays where you put it: the CLI',
      '  never echoes a variable back.',
      '',
      '  MOTIR_TOKEN',
      '    A personal access token, honoured by EVERY command. Set it and there',
      '    is no login step and no file: nothing is written to disk, which is',
      '    what makes it the tier for CI, a container, or any box whose config',
      '    dir is read-only. It outranks a stored credential — so a stale one',
      '    exported in a shell profile silently wins; `motir auth status` names',
      '    the source it used for exactly that reason. Empty counts as unset.',
      '    Precedence:  --token <pat>  >  MOTIR_TOKEN  >  config.json',
      '',
      '  MOTIR_SERVER',
      '    Which Motir server to talk to — the self-hosting counterpart of the',
      '    default, ' + DEFAULT_SERVER_URL + '. It outranks the .motir.json link',
      '    because a container has no link to walk up to. Empty counts as unset.',
      '    Precedence:  --server <url>  >  MOTIR_SERVER  >  .motir.json  >',
      '                 the single stored server  >  ' + DEFAULT_SERVER_URL,
      '',
      '  MOTIR_AGENT',
      '    The coding agent Motir preflights on your behalf — a full command',
      '    line, e.g. "claude --dangerously-skip-permissions". Motir is BYOK:',
      '    the agent authenticates with its OWN key, which Motir never reads.',
      '    Precedence:  --agent <cmd>  >  MOTIR_AGENT  >  agentCommand in config.json',
      '',
      '  MOTIR_CONFIG_HOME',
      '    The directory Motir keeps its `motir/config.json` under. Highest',
      '    precedence of the three config-home sources — and the second-choice',
      '    STATE home, so relocating it still moves the whole CLI state.',
      '',
      '  XDG_CONFIG_HOME',
      '    The standard XDG config home, used when MOTIR_CONFIG_HOME is unset.',
      '    Precedence:  MOTIR_CONFIG_HOME  >  XDG_CONFIG_HOME  >  ~/.config',
      '',
      '  MOTIR_STATE_HOME',
      '    Where Motir keeps `motir/session-excludes.json` — mutable state, not',
      '    a credential, which is why it does not live beside the token: the',
      '    sandbox image mounts the config dir read-only, leaving no writable',
      '    state directory there at all.',
      '    Precedence:  MOTIR_STATE_HOME  >  MOTIR_CONFIG_HOME  >',
      '                 XDG_STATE_HOME  >  ~/.local/state',
      '',
      '  XDG_DATA_HOME',
      '    The standard XDG data home. Motir keeps nothing here — `motir doctor`',
      '    reads it only to know where your AGENT keeps its credential (OpenCode',
      '    signs in to $XDG_DATA_HOME/opencode/auth.json).',
      '    Precedence:  XDG_DATA_HOME  >  ~/.local/share',
      '',
      '  A HOSTED run sets seven more — its container is configured by nothing',
      '  else. Each sits BELOW its general twin, so an explicit choice wins:',
      '',
      '  MOTIR_DISPATCH_RUN_ID',
      '    The run Motir already opened. `motir run` ADOPTS it instead of',
      '    opening one, needs no .motir.json, and never prompts.',
      '    Precedence:  --run-id <id>  >  MOTIR_DISPATCH_RUN_ID',
      '',
      '  MOTIR_RUN_TOKEN',
      '    The hosted run’s own credential. Never written to config.json; the',
      '    run keeps it in its own owner-only state for the git credential helper.',
      '    Precedence:  --token <pat>  >  MOTIR_TOKEN  >  MOTIR_RUN_TOKEN  >  config.json',
      '',
      '  MOTIR_API_URL',
      '    The server a hosted run reports to.',
      '    Precedence:  --server <url>  >  MOTIR_SERVER  >  MOTIR_API_URL  >  .motir.json',
      '',
      '  MOTIR_WORKSPACE',
      '    Where a hosted run clones its repositories, as <root>/<name>.',
      '    Default: /workspace',
      '',
      '  MOTIR_MODEL, MOTIR_GATEWAY_URL, MOTIR_RUN_KEY',
      '    The model a hosted run’s OpenCode runs on (anthropic/<id>), and the',
      '    gateway and key it reaches that model through. A hosted run launches',
      '    OpenCode itself, so MOTIR_AGENT and agentCommand are not read there;',
      '    only an explicit --agent replaces it.',
      '',
      '  Probed, never read: `motir doctor` asks whether your agent’s own key',
      '  variable is SET — one of ' + agentCredentialEnvNames().join(', ') + ' —',
      '  so it can report the agent as signed in without opening anything. That',
      '  check is a presence predicate; the value is never obtained.',
      '',
      '  See also: `motir help files`.',
    ].join('\n'),
};

const FILES_TOPIC: HelpTopic = {
  name: 'files',
  summary: 'The files Motir keeps: the credential store, the project link, the exclude list.',
  body: () =>
    [
      'FILES',
      '',
      '  Motir keeps three files. Only one holds a secret, and it is not the one',
      '  that lives in your repo.',
      '',
      '  ~/.config/motir/config.json          (secret — never commit)',
      '    The credential store — the only FILE a personal access token is ever',
      '    written to, chmod 600 inside a 0700 directory. Keyed by server URL, so',
      '    one machine can hold tokens for several Motir servers. Also holds',
      '    `agentCommand`, the coding agent you configured. (MOTIR_TOKEN is the',
      '    other way to supply a token, and it is never written anywhere.)',
      '    Relocate it with MOTIR_CONFIG_HOME or XDG_CONFIG_HOME',
      '    (`motir help environment`).',
      '',
      '  .motir.json                          (no secret — safe to commit)',
      '    The project link at your workspace root: the server, workspace and',
      '    project this folder is bound to, plus an optional `repos` override',
      '    map. It carries no credential, so it belongs in version control.',
      '    Every command resolves it by walking UPWARD from the current',
      '    directory, so any command works from inside any checkout under the',
      '    root. Repo checkouts otherwise resolve by convention, as',
      '    <root>/<repoName>; the `repos` map carries overrides only.',
      '',
      '  ~/.local/state/motir/session-excludes.json   (no secret)',
      '    The session exclude list: the ids and keys of items whose dispatch',
      '    FAILED, so the next run moves past them instead of re-picking the',
      '    same failure. State, not a credential — which is why it does not sit',
      '    beside the token: the sandbox mounts the config dir read-only, and a',
      '    run must never die because it could not write this file. If it is',
      '    unwritable Motir warns once and continues; a failed item is already',
      '    held out of the ready set by its In Progress status.',
      '    Relocate it with MOTIR_STATE_HOME (`motir help environment`).',
      '',
      '  The first two are inspected by `motir doctor`, which reports whether',
      '  they exist and resolve — never what is in them.',
      '',
      '  See also: `motir help environment`.',
    ].join('\n'),
};

const RUNS_TOPIC: HelpTopic = {
  name: 'runs',
  summary: 'What a dispatch run records, where to watch it, and what leaves your machine.',
  body: () =>
    [
      'DISPATCH RUNS',
      '',
      '  Every dispatch command opens a RUN — `motir next`, `motir run <KEY>`,',
      '  `motir run <scope>`, `motir batch` and `motir auto` alike. A run is a',
      '  record of what this invocation DID: which cards it owned, in what order,',
      '  what happened to each, and why it stopped.',
      '',
      '  A run covers a SET, not a card. Three shapes:',
      '',
      '    one card         `motir next` / `motir run <KEY>` — a set of one.',
      '    a claimed scope  `motir run <story>` / `motir run sprint` — every',
      '                     member the claim locked, in the dependency order the',
      '                     run then works them in.',
      '    a frozen batch   `motir batch` — the snapshot it took, INCLUDING every',
      '                     card it decided to skip and the reason for each.',
      '',
      '  `motir auto` is the exception, by design: it holds no plan and asks the',
      '  server for one card at a time, so its run starts empty and grows a leg',
      '  per card as it goes.',
      '',
      'WHERE TO WATCH IT',
      '',
      '  /runs?run=<id>        the run: its set, each card’s state, the skips',
      '                        and their reasons, and the stop reason.',
      '  the work item         a run section on the card, live, saying which of',
      '                        N it is in this run, plus that card’s run history.',
      '  /ready                a strip on the row a run is working.',
      '',
      'WHAT LEAVES YOUR MACHINE',
      '',
      '  Motir records what your run DID — the command, the cards it worked,',
      '  what happened to each, and why it stopped. That is all it sends by',
      '  default.',
      '',
      '  Your agent’s output stays on your machine. Log lines, file contents,',
      '  diffs and prompts are only sent if you pass `--report-log` (or set',
      '  `reportLogBodies` in your config), and they are deleted after 30 days.',
      '',
      '  There is deliberately no server-side setting for this: the machine that',
      '  holds the content is the machine that decides whether it leaves.',
      '',
      'IF REPORTING FAILS',
      '',
      '  Reporting is BEST-EFFORT and can never break a run. If Motir is',
      '  unreachable — or answers 500, or your token has expired — the CLI prints',
      '  ONE line saying so and carries on: the agent still runs, cards still',
      '  move, and the exit code is unchanged. The run page shows that run as',
      '  REPORTING-OFFLINE. That is a run whose record is incomplete, not a run',
      '  that failed.',
      '',
      '  See also: `motir help environment`, and docs/cli.md § Dispatch runs.',
    ].join('\n'),
};

export const HELP_TOPICS: readonly HelpTopic[] = [ENVIRONMENT_TOPIC, FILES_TOPIC, RUNS_TOPIC];

export function findHelpTopic(name: string): HelpTopic | undefined {
  return HELP_TOPICS.find((topic) => topic.name === name);
}

// ── Footer blocks ───────────────────────────────────────────────────────────

const EXAMPLES = [
  'EXAMPLES:',
  '  $ motir login                                      # connect this terminal',
  '  $ motir login --no-browser                         # …over SSH: print the code',
  '  $ motir auth login --server https://app.motir.co   # paste a token you hold',
  '  $ motir link --project MOTIR                       # bind this folder',
  '  $ motir doctor                                     # preflight the setup',
  '  $ motir ready --kinds subtask --assignee me        # what can I pick up?',
  '  $ motir status --json                              # the project pulse',
  '  $ motir sprint                                     # what’s in the active sprint',
  '  $ motir show MOTIR-7                               # the item, its edges, its body',
  '  $ motir show MOTIR-7 --activity                    # …plus comments + history',
  '  $ motir show MOTIR-7 --comments                    # …just what people said',
  '  $ motir open MOTIR-7 --print                       # the item’s URL',
  '  $ motir auto --agent claude --max 5                # drain 5 items unattended',
  '  $ motir batch --agent claude                       # snapshot now, one PR each',
  '  $ motir plan "split the billing epic"              # plan by talking; prints proposals',
].join('\n');

const LEARN_MORE = [
  'LEARN MORE:',
  '  Use `motir <command> --help` for the flags of a single command.',
  `  Use \`motir help <topic>\` for a topic: ${HELP_TOPICS.map((t) => t.name).join(', ')}.`,
  '  Read packages/cli/README.md in the Motir checkout for the full guide.',
].join('\n');

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * Render the root's FLAGS section.
 *
 * Commander's `formatHelp` has a FIXED section order — options always precede
 * commands — but the overview this card pins puts flags AFTER the command
 * groups. So `applyHelpConfiguration` suppresses the native options section for
 * the ROOT command only, and this re-emits it here (via `addHelpText('after')`)
 * using commander's own `visibleOptions` / `optionTerm` / `formatItem` /
 * `formatItemList`. Nothing about padding, wrapping or styling is
 * re-implemented — only the position of an otherwise-native section moves.
 */
function renderFlagsSection(program: Command, error: boolean): string {
  const helper = program.createHelp();
  const output = program.configureOutput();
  const helpWidth = error ? output.getErrHelpWidth?.() : output.getOutHelpWidth?.();
  helper.prepareContext({ error, ...(helpWidth === undefined ? {} : { helpWidth }) });

  // The ORIGINAL implementation — the configured override returns [] for the
  // root, which is exactly what we are compensating for here.
  const options: Option[] = Help.prototype.visibleOptions.call(helper, program);
  if (options.length === 0) return '';

  const terms = options.map((option) => helper.styleOptionTerm(helper.optionTerm(option)));
  // Share the command groups' column so FLAGS lines up with them, widening
  // only if a flag term is longer than every command term.
  const termWidth = Math.max(
    helper.padWidth(program, helper),
    ...terms.map((term) => helper.displayWidth(term)),
  );
  const items = options.map((option, index) =>
    helper.formatItem(
      terms[index] ?? '',
      termWidth,
      helper.styleOptionDescription(helper.optionDescription(option)),
      helper,
    ),
  );
  // formatItemList styles the heading itself and appends a trailing '' section
  // separator; the footer supplies its own spacing, so drop that.
  return helper.formatItemList(FLAGS_HEADING, items, helper).join('\n').trimEnd();
}

// ── Installation ────────────────────────────────────────────────────────────

/**
 * Install the help CONFIGURATION. Must run BEFORE any command is registered:
 * commander applies the default command group at registration time
 * (`_registerCommand`), so a command added before this call would never reach
 * the ADDITIONAL COMMANDS bucket.
 */
export function applyHelpConfiguration(program: Command): void {
  program.commandsGroup(HELP_GROUP.additional);
  program.configureHelp({
    // Group and command order is AUTHORED (registration order), not alphabetical.
    sortSubcommands: false,
    sortOptions: false,
    visibleOptions(this: Help, cmd: Command): Option[] {
      // Root only — see renderFlagsSection. Every subcommand keeps commander's
      // default help rendering, unchanged.
      if (cmd === program) return [];
      return Help.prototype.visibleOptions.call(this, cmd);
    },
  });
}

/**
 * Install the help SURFACE: the `help` command, the topic pseudo-commands, the
 * EXAMPLES / LEARN MORE footer, and the bare-`motir` overview. Must run AFTER
 * the real commands are registered, so HELP TOPICS renders below them.
 */
export function registerHelpSurface(program: Command): void {
  // Replace commander's built-in help command with our own, so an unknown topic
  // fails through the CliError path (one line + hint on stderr, exit 1) rather
  // than commander's usage-error output — and so `help` is a real member of
  // `program.commands` that carries a group like every other command.
  program.helpCommand(false);

  // `help` is a REAL command, so it is built from the catalog like every other
  // one (`program.ts`'s `register`, spelled out here because this file registers
  // it). The topic pseudo-commands below are not — they are generated one per
  // `HELP_TOPICS` entry, which is already their own record.
  const help = COMMAND_CATALOG.find((entry) => entry.path === 'help');
  if (!help) throw new Error('commandCatalog.ts has no entry for "help".');
  program
    .command(`help ${help.signature}`)
    .description(help.description)
    .helpGroup(help.helpGroup ?? HELP_GROUP.topics)
    .action((path: string[] = []) => {
      helpAction(program, path);
    });

  // Topics are registered as pseudo-commands so they surface in the overview
  // under HELP TOPICS without polluting the real command groups. `motir help
  // environment` resolves them first (see helpAction); `motir environment`
  // works too, which is strictly more forgiving.
  for (const topic of HELP_TOPICS) {
    program
      .command(topic.name)
      .description(topic.summary)
      .helpGroup(HELP_GROUP.topics)
      .action(() => {
        out(topic.body());
      });
  }

  program.addHelpText('after', (context) => {
    // 'after' fires only for the command the help was requested on, so this is
    // the root overview; the guard states that invariant rather than trusting it.
    if (context.command !== program) return '';
    const blocks = [renderFlagsSection(program, context.error), EXAMPLES, LEARN_MORE].filter(
      (block) => block !== '',
    );
    // The built-in help ends on a newline with no trailing blank line, so the
    // leading '\n' is what separates FLAGS from the last command group.
    return blocks.length === 0 ? '' : `\n${blocks.join('\n\n')}`;
  });

  // Bare `motir` prints the same overview on STDOUT and exits 0. Without an
  // action handler commander treats "no subcommand" as a usage error (help on
  // stderr, exit 1) — wrong for a user who just typed the tool's name.
  // Registering a handler also means an unknown command reaches here as an
  // operand, so it is mapped to the CliError path explicitly.
  program.allowExcessArguments();
  program.action((_options: unknown, command: Command) => {
    const unknown = command.args[0];
    if (unknown !== undefined) throw unknownCommandError(unknown);
    program.outputHelp();
  });
}

function unknownCommandError(name: string): CliError {
  return new CliError(`Unknown command "${name}".`, {
    hint: 'Run `motir help` to see the available commands and topics.',
  });
}

/**
 * `motir help` → the overview; `motir help <topic>` → the topic body;
 * `motir help <command> [subcommand…]` → that command's own help, unchanged.
 * Anything else is a CliError, not a stack trace.
 */
function helpAction(program: Command, path: readonly string[]): void {
  if (path.length === 0) {
    program.outputHelp();
    return;
  }

  // Topics win over their own pseudo-command, so `motir help files` prints the
  // topic rather than the (empty) commander help for a `files` command.
  if (path.length === 1) {
    const topic = findHelpTopic(path[0] as string);
    if (topic) {
      out(topic.body());
      return;
    }
  }

  let command: Command = program;
  for (const name of path) {
    const child = command.commands.find(
      (candidate) => candidate.name() === name || candidate.aliases().includes(name),
    );
    if (!child) {
      throw new CliError(`No help topic or command named "${path.join(' ')}".`, {
        hint: 'Run `motir help` to see the available commands and topics.',
      });
    }
    command = child;
  }
  command.outputHelp();
}
