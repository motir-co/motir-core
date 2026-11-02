import { Command, Option } from 'commander';
import { CLI_VERSION } from './version.js';
import { COMMAND_CATALOG, type CommandCatalogEntry } from './commandCatalog.js';
import { authLogin, authLogout, authRefresh, authStatus } from './commands/auth.js';
import { loginCommand } from './commands/login.js';
import { linkAddCommand, linkCommand, linkRemoveCommand } from './commands/link.js';
import {
  openCommand,
  readyCommand,
  showCommand,
  sprintCommand,
  sprintsCommand,
  statusCommand,
} from './commands/read.js';
import { doctorCommand } from './commands/doctor.js';
import { doneCommand, nextCommand, runCommand } from './commands/dispatch.js';
import { continueCommand } from './commands/continue.js';
import { fixCommand } from './commands/fix.js';
import { reviewCommand } from './commands/review.js';
import { autoCommand } from './commands/auto.js';
import { batchCommand } from './commands/batch.js';
import { planCommand } from './commands/plan.js';
import {
  agentTerminalRunCommand,
  agentTerminalServeCommand,
  agentTerminalSignInCommand,
  agentTerminalStatusCommand,
  agentTerminalStopCommand,
  type AgentTerminalRunIdOptions,
  type AgentTerminalRunOptions,
} from './commands/agentTerminal.js';
import { applyHelpConfiguration, registerHelpSurface } from './help.js';

// The command tree. 7.9.1 ships the scaffold + auth + link; the read commands
// (`ready` / `status` / `open`) are 7.9.2, single dispatch (`next` / `run` /
// `done`) is 7.9.3, and the loop (`auto` / `batch`) is 7.9.4+ — they register
// onto this same program as they land.
//
// Each command carries a `.helpGroup(...)` so it renders under a heading in the
// curated overview (help.ts). REGISTRATION ORDER IS THE RENDER ORDER — commander
// builds the group map in the order groups first appear in `program.commands` —
// so a new command joins its group by being registered next to its peers, or
// falls into ADDITIONAL COMMANDS if it declares none.
//
// ── Where a command's NAME, ARGUMENTS, DESCRIPTION and GROUP come from ───────
// Not from this file. They are declared once in `commandCatalog.ts` — a module
// that imports NOTHING — and `register()` below builds each command FROM that
// record, because `/docs/cli` publishes the same four facts to people with no
// checkout and a documentation page must not be a second place to state them
// (ADR `docs/decisions/public-api-conventions.md` Amendment 12 Q2; Subtask
// MOTIR-2324).
//
// What STAYS here: the options, the `.addHelpText(...)` bodies, and the
// actions. Options are PINNED rather than built-from — generating `.option(...)`
// calls from data would rewrite flag order, the negated-boolean spellings and
// the per-flag descriptions that `test/help.test.ts` pins as OUTPUT, for a
// failure `test/commandCatalog.test.ts` already catches at the moment it is
// introduced (it walks this tree and compares it to the record in both
// directions, options included).
const CATALOG_BY_PATH = new Map<string, CommandCatalogEntry>(
  COMMAND_CATALOG.map((entry) => [entry.path, entry]),
);

/**
 * Register `path`'s command on `parent`, taking its name, argument syntax,
 * description and help group from the catalog. The caller chains its options,
 * help text and action as before.
 *
 * A path with no entry THROWS rather than registering a nameless command: the
 * record is the source, so a command that is not in it is a bug in this file,
 * not a command the catalog is missing.
 */
/**
 * A `--no-*` spelling that is ACCEPTED and never listed (MOTIR-3022).
 *
 * ⚠️ ITS DESCRIPTION IS STILL REQUIRED, and it still lives in the catalog.
 * `test/commandCatalog.test.ts` compares the registered tree against
 * `commandCatalog.ts` exactly — flags, descriptions and order — so an alias that
 * existed only here would fail that audit, and loosening the audit to a subset
 * match to fit one flag would spend the property that makes the record worth
 * having. The catalog row carries `hidden: true`, which is what keeps it out of
 * the published `/docs/cli` table; `hideHelp()` is what keeps it out of
 * `motir help`. Two renderers, one decision, stated once on the row.
 */
function hiddenAlias(flags: string, primary: string): Option {
  return new Option(flags, `Hidden alias for ${primary}.`).hideHelp();
}

function register(parent: Command, path: string): Command {
  const entry = CATALOG_BY_PATH.get(path);
  if (!entry) {
    throw new Error(
      `commandCatalog.ts has no entry for "${path}". Add one there — it is what ` +
        `both this program and the published /docs/cli table are built from.`,
    );
  }
  const name = path.slice(path.lastIndexOf(' ') + 1);
  const command = parent
    .command(entry.signature ? `${name} ${entry.signature}` : name)
    .description(entry.description);
  if (entry.helpGroup) command.helpGroup(entry.helpGroup);
  return command;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('motir')
    .description(
      'Motir CLI — terminal dispatch of the work loop (an MCP client of the Motir server).',
    )
    .version(CLI_VERSION, '-v, --version', 'Print the CLI version.');

  // Before ANY command is registered: commander applies the default command
  // group at registration time.
  applyHelpConfiguration(program);

  // ── login / logout ────────────────────────────────────────────────────────
  // Registered FIRST in the SETUP group because this is the command a person
  // reaches for: `motir login` is the interactive default (a device grant), and
  // `auth login --token` below stays for the token you already hold. The `auth`
  // subtree is unchanged — CI keeps its `--token` path and 7.9.1 keeps working.
  register(program, 'login')
    .option('--server <url>', 'Server base URL, e.g. https://app.motir.co')
    .option(
      '--no-browser',
      'Do not launch a browser — just print the code and the URL to open anywhere.',
    )
    .addHelpText(
      'after',
      [
        '',
        'No browser on this machine? The code and URL are printed either way, so an',
        'SSH session or a container uses this same command — open the URL on any',
        'device, sign in, and enter the code. For an unattended agent set MOTIR_TOKEN',
        'instead (`motir help environment`).',
      ].join('\n'),
    )
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `loginCommand`'s injectable-deps parameter.
    .action((opts) => loginCommand(opts));
  register(program, 'logout')
    .option('--server <url>', 'Server to log out of (defaults to the linked / single server).')
    .addHelpText(
      'after',
      [
        '',
        'This removes the credential from THIS machine only. The server-side kill',
        'switch is revoking the token in Settings → Account → Tokens — a terminal',
        'connected by `motir login` appears there as `CLI · <hostname>`.',
      ].join('\n'),
    )
    .action(authLogout);

  // ── auth ──────────────────────────────────────────────────────────────────
  const auth = register(program, 'auth');
  register(auth, 'auth login')
    .option('--server <url>', 'Server base URL, e.g. https://app.motir.co')
    .option('--token <pat>', 'Personal access token (or set MOTIR_TOKEN; prompted if omitted).')
    .action(authLogin);
  register(auth, 'auth status')
    .option('--server <url>', 'Server to report (defaults to the linked / single server).')
    .action(authStatus);
  register(auth, 'auth logout')
    .option('--server <url>', 'Server to log out of (defaults to the linked / single server).')
    .action(authLogout);
  register(auth, 'auth refresh')
    .option('--server <url>', 'Server to refresh (defaults to the linked / single server).')
    .option('--no-browser', 'Do not launch a browser — just print the code and the URL.')
    .addHelpText(
      'after',
      [
        '',
        'Gives the token `motir login` stored the permissions this CLI uses now. You',
        'approve it in a browser, as with `motir login`; the token stays the same, so',
        'nothing is copied or re-pasted. A token from MOTIR_TOKEN is refused — change',
        'it in Settings → Account → Tokens instead.',
      ].join('\n'),
    )
    // Arity-1 wrapper, as for `login`: keep commander's Command out of the deps.
    .action((opts) => authRefresh(opts));

  // ── link ───────────────────────────────────────────────────────────────────
  const link = register(program, 'link')
    .option('--server <url>', 'Server base URL (defaults to the existing link / single server).')
    .option('--workspace <slug>', 'Workspace slug (defaults to the token’s active workspace).')
    .option(
      '--project <key>',
      'Project key, e.g. ACME. Omit it and the workspace’s only project is used.',
    )
    .option(
      '--repo <name>',
      'Mark THIS directory as a single repo’s checkout (writes a "." override).',
    )
    .option('--no-clone', 'Bind only — do not clone the project’s missing checkouts.')
    .action(linkCommand);
  register(link, 'link add').action(linkAddCommand);
  register(link, 'link remove').action(linkRemoveCommand);

  // ── read ───────────────────────────────────────────────────────────────────
  register(program, 'ready')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    // The ready LANES (MOTIR-6837): the leaves by default, grouped under their
    // runnable containers; these two list the other two lanes.
    .option('--parent', 'List the runnable containers — what `motir next --parent` runs.')
    .option('--bug', 'List the ready bugs instead of the leaves.')
    .option('--assignee <id>', 'Filter by assignee: a user id, "me", or "unassigned".')
    .option('--json', 'Emit the ready items as JSON.')
    .action(readyCommand);
  register(program, 'status').option('--json', 'Emit the pulse as JSON.').action(statusCommand);
  register(program, 'sprints')
    .option('--state <state>', 'Only sprints in this state: planned, active, or complete.')
    .option('--json', 'Emit the sprint rows as JSON.')
    .action(sprintsCommand);
  register(program, 'sprint')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--json', 'Emit the sprint and its items as JSON.')
    // Arity-2 wrapper: commander appends the Command object, which must not
    // land in `sprintCommand`'s options parameter when `[ref]` is omitted.
    .action((ref: string | undefined, opts) => sprintCommand(ref, opts));
  // The single-ITEM read, next to `open` (its browser twin) rather than among
  // the list reads above.
  register(program, 'show')
    .option('--json', 'Emit the get_work_item payload as JSON.')
    // The discussion is OPT-IN, on the detail view rather than in a command of
    // its own — the mirror product's shape (`gh issue view <n> --comments`), and
    // it keeps the default read to one tool call.
    .option('--activity', 'Also print the activity stream: comments and history, one page.')
    .option('--comments', 'Also print the comment threads only, one page.')
    .addHelpText(
      'after',
      [
        '',
        'ONE page of the stream is printed, never a drain loop: when more remains,',
        'the output says how much and points at `motir open <key>` for the rest.',
      ].join('\n'),
    )
    .action(showCommand);
  // ── doctor ────────────────────────────────────────────────────────────────
  register(program, 'doctor')
    .option('--agent <cmd>', 'Check THIS agent command instead of the configured one.')
    .option('--json', 'Emit the check results as JSON.')
    // Arity-1 wrapper: commander passes the Command as a second argument, which
    // must not land in `doctorCommand`'s injectable probe parameter.
    .action((opts) => doctorCommand(opts));

  register(program, 'open')
    .option('--print', 'Print the URL only; do not launch a browser.')
    // Arity-2 wrapper: commander passes the Command as a third argument, which
    // must not land in `openCommand`'s injectable browser-launcher parameter.
    .action((key: string, opts) => openCommand(key, opts));

  // ── dispatch (the work loop) ───────────────────────────────────────────────
  // The prompt each of these delivers is generated SERVER-SIDE (dispatch_prompt)
  // and printed verbatim — the CLI never assembles prompt text. These are the
  // first members of the reserved WORK LOOP group (`auto` / `batch` join them).
  register(program, 'next')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    // The ready LANES (MOTIR-6837): `motir next` takes the next LEAF and never a
    // bug; these two take the other lanes.
    .option(
      '--parent',
      'Run the next runnable container (a story, task or bug whose children are all leaves) as a parent run — as `motir run <KEY>` would.',
    )
    .option('--bug', 'Take the next ready bug instead of the next leaf.')
    .option(
      '--print',
      'Print the prompt to stdout INSTEAD of launching an agent (default). Not --print-prompt.',
    )
    // ── THE PROMPT ECHO (MOTIR-3052) ────────────────────────────────────────
    // ⚠️ ONE WORD FROM `--print`, AND THE OPPOSITE KIND OF THING. `--print`
    // prints the prompt INSTEAD of running an agent; this prints it IN ADDITION
    // to the run, on stderr, so the two compose on one command line instead of
    // putting two copies of a 200-line prompt on one stream. Commander gives
    // them distinct attributes (`print` vs `printPrompt`), which is what keeps
    // the `--print` refusals on `auto` / `batch` from catching this flag — and
    // they must not: an unattended loop is exactly where a transcript is worth
    // having.
    .option(
      '--print-prompt',
      'ALSO echo the assembled prompt to stderr as it is sent, and still run the agent.',
    )
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option('--reset', 'Clear this project’s session exclude list before picking.')
    // ── The per-run FINDINGS POLICY (MOTIR-3022) ─────────────────────────────
    // ⚠️ These are NOT CLI-side behaviour. They travel to `dispatch_prompt` and
    // come back as different PROMPT TEXT, because the prompt is the entire
    // contract with a sandboxed agent — a flag it never reads cannot change what
    // it does. `docs/decisions/run-findings-protocol.md` Q1.
    .option(
      '--disable-log-bug',
      'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
    )
    .option(
      '--disable-replan',
      'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
    )
    // The house `--no-*` convention, ACCEPTED and unpublished. Someone typing it
    // on instinct gets what they meant instead of `unknown option`; hiding it is
    // what keeps this from becoming a second documented spelling.
    .addOption(hiddenAlias('--no-log-bug', '--disable-log-bug'))
    .addOption(hiddenAlias('--no-replan', '--disable-replan'))
    // Registered PRECISELY so it can be refused properly — the MOTIR-1828 /
    // MOTIR-1830 rule, applied to a THIRD flag. The guard in the command module
    // carries the reason; without this line commander answers `unknown option`
    // and the reason is unreachable.
    .option(
      '--auto-approve-replan',
      'Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.',
    )
    // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ────────
    // Same words on all four commands: the boundary it moves is the same
    // boundary whichever one a person types.
    .option(
      '--report-log',
      'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
    )
    .action(nextCommand);
  register(program, 'run')
    .option(
      '--print',
      'Print the prompt to stdout INSTEAD of launching an agent (default). One item; not --print-prompt.',
    )
    // ── THE PROMPT ECHO (MOTIR-3052) ────────────────────────────────────────
    // ⚠️ ONE WORD FROM `--print`, AND THE OPPOSITE KIND OF THING. `--print`
    // prints the prompt INSTEAD of running an agent; this prints it IN ADDITION
    // to the run, on stderr, so the two compose on one command line instead of
    // putting two copies of a 200-line prompt on one stream. Commander gives
    // them distinct attributes (`print` vs `printPrompt`), which is what keeps
    // the `--print` refusals on `auto` / `batch` from catching this flag — and
    // they must not: an unattended loop is exactly where a transcript is worth
    // having.
    // ⚠️ AND IT IS NOT LEAF-ONLY, unlike `--print` right above it: a scoped run
    // prints one block per dispatched leaf, which is the case the flag exists
    // for. `refuseLeafOnlyFlag` reads `opts.print`, never this.
    .option(
      '--print-prompt',
      'Echo each assembled prompt to stderr as it is sent, alongside the run (2> prompts.log).',
    )
    .option('--agent <cmd>', 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).')
    .option(
      '--force',
      'Dispatch even though the item is not ready (dependencies unmet). One work item only.',
    )
    // ── HARD vs SOFT (MOTIR-6354 · MOTIR-6355) ──────────────────────────────
    // `run` ONLY: `next` / `auto` / `batch` pick from the ready set, and there
    // commander refuses the flag as unknown. Unlike `--force` it is not
    // leaf-only — on a story it widens the ready read the scope is built from.
    .option(
      '--allow-soft-block',
      "Run an item held only by an ancestor's block (a SOFT block). Still refuses one with its own open blocker (a HARD block — only --force passes that).",
    )
    // ── The per-run FINDINGS POLICY (MOTIR-3022) ─────────────────────────────
    // ⚠️ These are NOT CLI-side behaviour. They travel to `dispatch_prompt` and
    // come back as different PROMPT TEXT, because the prompt is the entire
    // contract with a sandboxed agent — a flag it never reads cannot change what
    // it does. `docs/decisions/run-findings-protocol.md` Q1.
    .option(
      '--disable-log-bug',
      'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
    )
    .option(
      '--disable-replan',
      'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
    )
    // The house `--no-*` convention, ACCEPTED and unpublished. Someone typing it
    // on instinct gets what they meant instead of `unknown option`; hiding it is
    // what keeps this from becoming a second documented spelling.
    .addOption(hiddenAlias('--no-log-bug', '--disable-log-bug'))
    .addOption(hiddenAlias('--no-replan', '--disable-replan'))
    // Registered PRECISELY so it can be refused properly — the MOTIR-1828 /
    // MOTIR-1830 rule, applied to a THIRD flag. The guard in the command module
    // carries the reason; without this line commander answers `unknown option`
    // and the reason is unreachable.
    .option(
      '--auto-approve-replan',
      'Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.',
    )
    // ── The SCOPE flags (MOTIR-3198) ────────────────────────────────────────
    // `motir run` takes a SCOPE now, so every work-loop flag had to be re-asked
    // rather than inherited. `--kinds` is registered PRECISELY so it can be
    // refused with its reason — the same MOTIR-1828 pattern the line above uses.
    .option('--max <n>', 'Stop after dispatching n work items from the scope.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option(
      '--include-planning',
      'Trigger an AI expansion for an unexpanded story instead of refusing it. Never waits: the plan needs your approval.',
    )
    .option(
      '--kinds <list>',
      'Not supported — a scoped run drains the whole claimed set, not a filtered subset.',
    )
    // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ────────
    // Same words on all four commands: the boundary it moves is the same
    // boundary whichever one a person types.
    .option(
      '--report-log',
      'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
    )
    // ── The HOSTED mode (Story MOTIR-683 · MOTIR-6558) ──────────────────────
    .option(
      '--run-id <id>',
      'Adopt a run Motir already opened (a hosted run) instead of opening one. Env: MOTIR_DISPATCH_RUN_ID.',
    )
    .action(runCommand);
  // `motir fix <key>` (MOTIR-5465) — the repair of a red card, or one the merge queue
  // threw out (MOTIR-5803).
  register(program, 'fix')
    .option('--agent <cmd>', 'Run THIS agent command on the fix (overrides MOTIR_AGENT).')
    .option(
      '--report-log',
      'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
    )
    .action(fixCommand);
  // `motir continue <key>` (MOTIR-6533) — carry on a card whose last run died.
  register(program, 'continue')
    .option('--agent <cmd>', 'Run THIS agent command on the continue (overrides MOTIR_AGENT).')
    .option('--max <n>', 'A parent: stop after dispatching n more work items.')
    .option('--keep-going', 'A parent: continue past a failed agent instead of halting.')
    .option(
      '--report-log',
      'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
    )
    .action(continueCommand);
  // `motir review <key>` (MOTIR-6824) — the hosted REVIEW agent; refuses outside a
  // hosted review run. Only the key reaches it: commander's trailing arguments are not
  // its seams.
  register(program, 'review').action((key: string) => reviewCommand(key));
  register(program, 'auto')
    .option('--agent <cmd>', 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--max <n>', 'Stop after dispatching n work items.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option('--reset', 'Clear this project’s session exclude list before starting.')
    .option(
      '--include-planning',
      'Trigger an AI expansion for each unexpanded epic/story instead of skipping it. Never waits: the plan needs your approval.',
    )
    // Registered PRECISELY so it can be refused properly (MOTIR-1828). `auto`
    // does not support `--print`, but leaving the flag unregistered made
    // commander reject it first with a generic `unknown option '--print'` —
    // which told the user nothing and made `autoCommand`'s own guard, the one
    // carrying the "use `motir next --print` instead" hint, unreachable from the
    // command line. A rejected flag with guidance beats an unknown flag.
    .option(
      '--print',
      'Not supported — an unattended loop has nobody to paste a prompt. --print-prompt IS.',
    )
    // ── THE PROMPT ECHO (MOTIR-3052) ────────────────────────────────────────
    // ⚠️ ONE WORD FROM `--print`, AND THE OPPOSITE KIND OF THING. `--print`
    // prints the prompt INSTEAD of running an agent; this prints it IN ADDITION
    // to the run, on stderr, so the two compose on one command line instead of
    // putting two copies of a 200-line prompt on one stream. Commander gives
    // them distinct attributes (`print` vs `printPrompt`), which is what keeps
    // the `--print` refusals on `auto` / `batch` from catching this flag — and
    // they must not: an unattended loop is exactly where a transcript is worth
    // having.
    .option(
      '--print-prompt',
      'Echo each assembled prompt to stderr as it is sent, alongside the run (2> prompts.log).',
    )
    // ── The per-run FINDINGS POLICY (MOTIR-3022) ─────────────────────────────
    // ⚠️ These are NOT CLI-side behaviour. They travel to `dispatch_prompt` and
    // come back as different PROMPT TEXT, because the prompt is the entire
    // contract with a sandboxed agent — a flag it never reads cannot change what
    // it does. `docs/decisions/run-findings-protocol.md` Q1.
    .option(
      '--disable-log-bug',
      'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
    )
    .option(
      '--disable-replan',
      'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
    )
    // The house `--no-*` convention, ACCEPTED and unpublished. Someone typing it
    // on instinct gets what they meant instead of `unknown option`; hiding it is
    // what keeps this from becoming a second documented spelling.
    .addOption(hiddenAlias('--no-log-bug', '--disable-log-bug'))
    .addOption(hiddenAlias('--no-replan', '--disable-replan'))
    // The one command with a loop to continue into (`auto` re-asks `next_ready`
    // each iteration). The other three REGISTER it in order to refuse it.
    .option(
      '--auto-approve-replan',
      'Approve a re-plan the agent submitted and keep looping, instead of stopping for you.',
    )
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `autoCommand`'s injectable-deps parameter.
    // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ────────
    // Same words on all four commands: the boundary it moves is the same
    // boundary whichever one a person types.
    .option(
      '--report-log',
      'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
    )
    .action((opts) => autoCommand(opts));
  register(program, 'batch')
    .option('--agent <cmd>', 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).')
    .option('--kinds <list>', 'Comma-separated kinds: epic,story,task,bug,subtask.')
    .option('--max <n>', 'Stop after dispatching n work items.')
    .option('--keep-going', 'Continue past a failed agent instead of halting on the first one.')
    .option('--reset', 'Clear this project’s session exclude list before snapshotting.')
    // Registered PRECISELY so it can be refused properly — the same reason as
    // `auto` above (MOTIR-1828, missed on this command until MOTIR-1830). The
    // rule the two share: a command whose module GUARDS a flag must REGISTER
    // that flag, or commander rejects it first and the guard is dead code from
    // the command line. `test/optionRegistrationAudit.test.ts` now enforces it
    // across every command, so this cannot go unswept a third time.
    .option(
      '--print',
      'Not supported — a frozen snapshot has nobody to paste a prompt. --print-prompt IS.',
    )
    // ── THE PROMPT ECHO (MOTIR-3052) ────────────────────────────────────────
    // ⚠️ ONE WORD FROM `--print`, AND THE OPPOSITE KIND OF THING. `--print`
    // prints the prompt INSTEAD of running an agent; this prints it IN ADDITION
    // to the run, on stderr, so the two compose on one command line instead of
    // putting two copies of a 200-line prompt on one stream. Commander gives
    // them distinct attributes (`print` vs `printPrompt`), which is what keeps
    // the `--print` refusals on `auto` / `batch` from catching this flag — and
    // they must not: an unattended loop is exactly where a transcript is worth
    // having.
    .option(
      '--print-prompt',
      'Echo each assembled prompt to stderr as it is sent, alongside the run (2> prompts.log).',
    )
    // ── The per-run FINDINGS POLICY (MOTIR-3022) ─────────────────────────────
    // ⚠️ These are NOT CLI-side behaviour. They travel to `dispatch_prompt` and
    // come back as different PROMPT TEXT, because the prompt is the entire
    // contract with a sandboxed agent — a flag it never reads cannot change what
    // it does. `docs/decisions/run-findings-protocol.md` Q1.
    .option(
      '--disable-log-bug',
      'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
    )
    .option(
      '--disable-replan',
      'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
    )
    // The house `--no-*` convention, ACCEPTED and unpublished. Someone typing it
    // on instinct gets what they meant instead of `unknown option`; hiding it is
    // what keeps this from becoming a second documented spelling.
    .addOption(hiddenAlias('--no-log-bug', '--disable-log-bug'))
    .addOption(hiddenAlias('--no-replan', '--disable-replan'))
    // Registered PRECISELY so it can be refused properly — the MOTIR-1828 /
    // MOTIR-1830 rule, applied to a THIRD flag. The guard in the command module
    // carries the reason; without this line commander answers `unknown option`
    // and the reason is unreachable.
    .option(
      '--auto-approve-replan',
      'Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.',
    )
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in `batchCommand`'s injectable-deps parameter.
    // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ────────
    // Same words on all four commands: the boundary it moves is the same
    // boundary whichever one a person types.
    .option(
      '--report-log',
      'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
    )
    .action((opts) => batchCommand(opts));
  // The planning front door. NOT a dispatch command: it changes the PLAN (a
  // conversation whose submit produces proposals awaiting approval in Motir),
  // which is why it sits at the end of the work-loop group rather than among
  // `next` / `run` / `auto`.
  register(program, 'plan')
    .option('--detach', 'Submit and return with the job/plan ids; do not wait for the planner.')
    .addHelpText(
      'after',
      [
        '',
        'Leading MOTIR-<n> arguments ANCHOR the conversation at those items; the rest is a turn.',
        '',
        '  $ motir plan                       # resume the project-wide conversation',
        '  $ motir plan MOTIR-42              # resume the conversation anchored at MOTIR-42',
        '  $ motir plan "split the billing epic"   # one turn, submitted, proposals printed',
        '  $ motir plan MOTIR-42 "size these" --detach',
        '',
        'In the conversation: /submit sends every turn as ONE change, /exit leaves it saved.',
        'A submit produces PROPOSALS — approving the plan in Motir is what creates work items.',
      ].join('\n'),
    )
    // Arity-2 wrapper: commander appends the Command object, which must not land
    // in `planCommand`'s injectable-deps parameter.
    .action((args: string[], opts) => planCommand(args, opts));
  register(program, 'done')
    .option('--session <branch>', 'Bulk close-out: flip every item on this session branch.')
    .option('--via <status>', 'Move through this status first (e.g. in_review).')
    // Arity-2 wrapper: commander appends the Command object, which must not
    // land in `doneCommand`'s options parameter when `[key]` is omitted.
    .action((key: string | undefined, opts) => doneCommand(key, opts));

  // ── agent-terminal (MOTIR-6938) ────────────────────────────────────────────
  // The server an agent's machine runs as its main process. `motir
  // agent-terminal --help` exiting 0 is the machine init's probe for an image
  // that carries it (`docs/decisions/agent-terminal.md` Q4, Q8).
  const agentTerminal = register(program, 'agent-terminal');
  register(agentTerminal, 'agent-terminal serve')
    .option('--port <port>', 'Port to listen on, on every interface (default 7681).')
    // Arity-1 wrapper: commander appends the Command object, which must not land
    // in the command's injectable-deps parameter. The server keeps the process
    // alive; nothing awaits it past listening.
    .action(async (opts) => {
      await agentTerminalServeCommand(opts);
    });
  // The run launcher and its probes (MOTIR-7025 · `docs/decisions/agent-instance-run.md`
  // §1, §4). Motir runs them through a short Fly `exec`; each prints one JSON
  // line. `motir agent-terminal run --help` exiting 0 is the image-capability
  // probe, so `run` must stay registered under this exact name.
  register(agentTerminal, 'agent-terminal run')
    .option('--run-id <id>', 'The run to open a session for (its credentials are read on stdin).')
    .option('--command <command>', 'What the session is for: run (the default), fix or continue.')
    .action(async (key: string, opts: AgentTerminalRunOptions) => {
      await agentTerminalRunCommand(key, opts);
    });
  register(agentTerminal, 'agent-terminal stop')
    .option('--run-id <id>', 'The run whose session to stop.')
    .action(async (opts: AgentTerminalRunIdOptions) => {
      await agentTerminalStopCommand(opts);
    });
  register(agentTerminal, 'agent-terminal status')
    .option('--run-id <id>', 'The run whose session to report.')
    .action(async (opts: AgentTerminalRunIdOptions) => {
      await agentTerminalStatusCommand(opts);
    });
  register(agentTerminal, 'agent-terminal signin')
    .option('--json', 'Print JSON (the only format; accepted for scripts that ask for it).')
    .action(async () => {
      await agentTerminalSignInCommand();
    });

  // After the real commands, so HELP TOPICS renders below them.
  registerHelpSurface(program);

  return program;
}
