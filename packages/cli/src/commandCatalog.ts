// The CLI's command tree, its help-group headings and its default server, as a
// PURE RECORD (Story MOTIR-2308 · Subtask MOTIR-2324 · ADR
// `docs/decisions/public-api-conventions.md` Amendment 12 Q2).
//
// ── Why this module exists ──────────────────────────────────────────────────
// `/docs/cli` publishes the CLI's command table to people who installed
// `@motir/cli` from npm and have no checkout. That table must be DERIVED from
// what the CLI actually registers — a table typed by hand is right the day it
// ships and wrong three months later, which has already happened twice to this
// project's published documentation (MOTIR-2010, MOTIR-2131).
//
// The module that knows the tree, `program.ts`, cannot be the source: it
// imports `commander` and every module under `src/commands/`, so a Next build
// reaching it would acquire the CLI's whole dependency graph. Neither can
// `help.ts` (imports `commander`) or `serverResolve.ts` (imports the config
// modules). So the facts move HERE, into a module that imports NOTHING AT ALL,
// and `program.ts` builds from it — the same shape `agentProfiles.ts` has, which
// is the one crossing Amendment 9 Q3 already permits.
//
// ── The three invariants this module has to keep ────────────────────────────
// Amendment 12 Q4 permits exactly two modules under `app/` or `lib/` to import
// from `packages/cli/**` — `lib/apiDocs/cli.ts` and `lib/apiDocs/sandbox.ts` —
// each only into a module with no dependency graph, each exporting plain
// serializable data. So:
//
//   1. THIS FILE IMPORTS NOTHING. Not a package, not a relative module, not
//      even a `node:` builtin. `agentProfiles.ts` needs `node:path`; this
//      needs nothing, and adding an import is what would put `commander` on a
//      documentation page's critical path two refactors from now.
//   2. Everything it exports is plain serializable data — no functions, no
//      `Command` instances, no computed lookups. A `Map` keyed by path belongs
//      in the consumer, not here; `program.ts` builds one.
//   3. Nothing here is a SECOND home for a value that lives elsewhere.
//      `DEFAULT_SERVER_URL` and `HELP_GROUP` MOVED here and are re-exported
//      from `serverResolve.ts` and `help.ts`, so every existing importer is
//      unchanged and neither value can drift against a copy.
//
// ── BUILT FROM vs PINNED ────────────────────────────────────────────────────
// Amendment 12 Q2 draws one line through this record, and it is the only
// interesting thing about it.
//
//   BUILT FROM — `program.ts` registers each command FROM this record: its
//   name, its argument `signature`, its `description` and its `helpGroup`.
//   Drift is structurally impossible, because there is no second place to say
//   them.
//
//   PINNED — `options` are declared here and registered separately in
//   `program.ts`. Building `.option(...)` calls from data would rewrite flag
//   order, the negated-boolean spellings (`--no-browser`) and the per-flag
//   descriptions that `test/help.test.ts` pins as OUTPUT, for a failure
//   `test/commandCatalog.test.ts` already catches at the moment it is
//   introduced: that test walks the real `buildProgram()` tree and asserts
//   agreement in BOTH directions, options included.
//
// ── What is NOT here ────────────────────────────────────────────────────────
// The HELP TOPICS pseudo-commands (`motir environment`, `motir files`, …) are
// generated from `HELP_TOPICS` in `help.ts`, one per topic, and their bodies
// read `AGENT_PROFILES` and the resolution ladder. They are topics wearing a
// command's clothes, they already derive from their own record, and the
// published table lists commands. `test/commandCatalog.test.ts` excludes
// exactly `HELP_TOPICS.map((topic) => topic.name)` — computed from that same
// record, never a literal list — so a new topic cannot slip through the gap.

/**
 * The command-group headings, in the order they render. Group ORDER is decided
 * by first appearance in `program.commands` (commander's `groupItems` builds
 * the map in registration order), so the registration order in `program.ts`
 * is what puts SETUP above READ.
 *
 * `additional` is the DEFAULT bucket: `applyHelpConfiguration` installs it via
 * `program.commandsGroup()`, so a command registered with no explicit
 * `.helpGroup()` still lands under a heading instead of silently falling into
 * commander's generic `Commands:`.
 *
 * Declared HERE rather than in `help.ts` because this record carries each
 * command's group, and `help.ts` imports `commander`: a record that reached for
 * it would lose invariant 1 above. `help.ts` re-exports this, so every caller
 * is unchanged.
 */
export const HELP_GROUP = {
  setup: 'SETUP COMMANDS:',
  read: 'READ COMMANDS:',
  workLoop: 'WORK LOOP COMMANDS:',
  topics: 'HELP TOPICS:',
  additional: 'ADDITIONAL COMMANDS:',
} as const;

export type HelpGroup = (typeof HELP_GROUP)[keyof typeof HELP_GROUP];

/**
 * The hosted Motir instance — the LAST rung of `resolveServerUrl`'s ladder, and
 * the value `motir auth login` offers when it prompts for a server.
 *
 * Motir is open-core and self-hostable, so the host stays overridable at every
 * rung above this one; but the common case is the hosted product, and a CLI
 * whose default is a dev server (`http://localhost:3000`, what `auth login`
 * used to suggest) makes `motir login` a command you cannot type without also
 * knowing a URL. `gh` defaults to `github.com` and takes `--hostname` for
 * Enterprise; this is the same shape.
 *
 * Declared HERE rather than in `serverResolve.ts` because the published page
 * states it and `serverResolve.ts` imports the config modules. That file
 * re-exports it, so the ladder and its callers are unchanged.
 */
export const DEFAULT_SERVER_URL = 'https://app.motir.co';

/** One registered flag, exactly as `program.ts` spells it. */
export interface CommandOption {
  /** The commander flags string, e.g. `--server <url>` or `--no-browser`. */
  readonly flags: string;
  /** The one-line flag description shown in help. */
  readonly description: string;
  /**
   * ACCEPTED but not PUBLISHED (MOTIR-3022) — omitted from `motir help` (via
   * commander's `Option.hideHelp()`) and from the `/docs/cli` table.
   *
   * ⚠️ WHY THE CATALOG CARRIES IT AT ALL. `test/commandCatalog.test.ts` compares
   * this record against the REGISTERED tree exactly, in both directions and in
   * order — so an alias declared only in `program.ts` fails that audit, and
   * weakening the audit to a subset match to accommodate one flag would cost the
   * property that makes the record trustworthy. One record, with the publishing
   * decision stated ON the row, beats two records that can disagree.
   *
   * The one member so far is the pair of `--no-*` aliases for the findings
   * flags: someone typing the repo's own house convention on instinct gets the
   * behaviour they meant instead of `unknown option`. The point is NOT to offer
   * two documented spellings, which is exactly why they are not documented.
   */
  readonly hidden?: boolean;
}

/** One command in the tree — what a reader types, and what it does. */
export interface CommandCatalogEntry {
  /**
   * What the user types after `motir`, with a space between a subcommand and
   * its parent: `login`, `auth status`, `link add`.
   */
  readonly path: string;
  /**
   * The positional-argument syntax as registered — `<key>`, `[ref]`,
   * `[args...]`, `<repo> <path>` — or `''` for a command that takes none.
   * `program.ts` builds its `.command(...)` string from `path` + this.
   */
  readonly signature: string;
  /** The one-line description, rendered in help and in the published table. */
  readonly description: string;
  /**
   * The heading this command renders under in the curated overview, or `null`
   * for a SUBCOMMAND — a subcommand renders inside its parent's own help,
   * where commander groups nothing.
   */
  readonly helpGroup: HelpGroup | null;
  /** Every flag `program.ts` registers on this command, in registration order. */
  readonly options: readonly CommandOption[];
}

/**
 * The command tree, in REGISTRATION ORDER — which is render order, so this
 * array's order is what the curated overview and the published table both show.
 */
export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
  {
    path: 'login',
    signature: '',
    description: 'Connect this terminal: shows a code, opens Motir, waits for your approval.',
    helpGroup: HELP_GROUP.setup,
    options: [
      {
        flags: '--server <url>',
        description: 'Server base URL, e.g. https://app.motir.co',
      },
      {
        flags: '--no-browser',
        description: 'Do not launch a browser — just print the code and the URL to open anywhere.',
      },
    ],
  },
  {
    path: 'logout',
    signature: '',
    description: 'Disconnect this terminal: remove the stored token for a server.',
    helpGroup: HELP_GROUP.setup,
    options: [
      {
        flags: '--server <url>',
        description: 'Server to log out of (defaults to the linked / single server).',
      },
    ],
  },
  {
    path: 'auth',
    signature: '',
    description: 'Authenticate to a Motir server with a PAT.',
    helpGroup: HELP_GROUP.setup,
    options: [],
  },
  {
    path: 'auth login',
    signature: '',
    description: 'Validate and store a personal access token for a server.',
    helpGroup: null,
    options: [
      {
        flags: '--server <url>',
        description: 'Server base URL, e.g. https://app.motir.co',
      },
      {
        flags: '--token <pat>',
        description: 'Personal access token (or set MOTIR_TOKEN; prompted if omitted).',
      },
    ],
  },
  {
    path: 'auth status',
    signature: '',
    description: 'Show the resolved server, token prefix, and owning user.',
    helpGroup: null,
    options: [
      {
        flags: '--server <url>',
        description: 'Server to report (defaults to the linked / single server).',
      },
    ],
  },
  {
    path: 'auth logout',
    signature: '',
    description: 'Remove the stored token for a server.',
    helpGroup: null,
    options: [
      {
        flags: '--server <url>',
        description: 'Server to log out of (defaults to the linked / single server).',
      },
    ],
  },
  {
    path: 'auth refresh',
    signature: '',
    description:
      'Give the token `motir login` stored the permissions this CLI uses now, keeping the token.',
    helpGroup: null,
    options: [
      {
        flags: '--server <url>',
        description: 'Server to refresh (defaults to the linked / single server).',
      },
      {
        flags: '--no-browser',
        description: 'Do not launch a browser — just print the code and the URL.',
      },
    ],
  },
  {
    path: 'link',
    signature: '',
    description:
      'Bind this workspace-root folder to a project, and clone the repositories it is missing.',
    helpGroup: HELP_GROUP.setup,
    options: [
      {
        flags: '--server <url>',
        description: 'Server base URL (defaults to the existing link / single server).',
      },
      {
        flags: '--workspace <slug>',
        description: 'Workspace slug (defaults to the token’s active workspace).',
      },
      {
        flags: '--project <key>',
        description: 'Project key, e.g. ACME. Omit it and the workspace’s only project is used.',
      },
      {
        flags: '--repo <name>',
        description: 'Mark THIS directory as a single repo’s checkout (writes a "." override).',
      },
      {
        flags: '--no-clone',
        description: 'Bind only — do not clone the project’s missing checkouts.',
      },
    ],
  },
  {
    path: 'link add',
    signature: '<repo> <path>',
    description: 'Add a repo checkout-path override (relative to the link root, or absolute).',
    helpGroup: null,
    options: [],
  },
  {
    path: 'link remove',
    signature: '<repo>',
    description: 'Remove a repo checkout-path override.',
    helpGroup: null,
    options: [],
  },
  {
    path: 'ready',
    signature: '',
    description:
      'List the linked project’s ready leaves, grouped under their runnable containers — or, with --parent / --bug, the other two ready lanes.',
    helpGroup: HELP_GROUP.read,
    options: [
      {
        flags: '--kinds <list>',
        description: 'Comma-separated kinds: epic,story,task,bug,subtask.',
      },
      {
        flags: '--parent',
        description: 'List the runnable containers — what `motir next --parent` runs.',
      },
      {
        flags: '--bug',
        description: 'List the ready bugs instead of the leaves.',
      },
      {
        flags: '--assignee <id>',
        description: 'Filter by assignee: a user id, "me", or "unassigned".',
      },
      {
        flags: '--json',
        description: 'Emit the ready items as JSON.',
      },
    ],
  },
  {
    path: 'status',
    signature: '',
    description: 'Show the project pulse: ready / in-flight counts + the active sprint.',
    helpGroup: HELP_GROUP.read,
    options: [
      {
        flags: '--json',
        description: 'Emit the pulse as JSON.',
      },
    ],
  },
  {
    path: 'sprints',
    signature: '',
    description: 'List the project’s sprints: state, item count, points, window.',
    helpGroup: HELP_GROUP.read,
    options: [
      {
        flags: '--state <state>',
        description: 'Only sprints in this state: planned, active, or complete.',
      },
      {
        flags: '--json',
        description: 'Emit the sprint rows as JSON.',
      },
    ],
  },
  {
    path: 'sprint',
    signature: '[ref]',
    description: 'List ONE sprint’s work items (defaults to the active sprint).',
    helpGroup: HELP_GROUP.read,
    options: [
      {
        flags: '--kinds <list>',
        description: 'Comma-separated kinds: epic,story,task,bug,subtask.',
      },
      {
        flags: '--json',
        description: 'Emit the sprint and its items as JSON.',
      },
    ],
  },
  {
    path: 'show',
    signature: '<key>',
    description: 'Read one work item (e.g. ACME-7): fields, readiness, children, edges, body.',
    helpGroup: HELP_GROUP.read,
    options: [
      {
        flags: '--json',
        description: 'Emit the get_work_item payload as JSON.',
      },
      {
        flags: '--activity',
        description: 'Also print the activity stream: comments and history, one page.',
      },
      {
        flags: '--comments',
        description: 'Also print the comment threads only, one page.',
      },
    ],
  },
  {
    path: 'doctor',
    signature: '',
    description:
      'Preflight your BYOK setup: auth, project link, agent binary, credential presence.',
    helpGroup: HELP_GROUP.setup,
    options: [
      {
        flags: '--agent <cmd>',
        description: 'Check THIS agent command instead of the configured one.',
      },
      {
        flags: '--json',
        description: 'Emit the check results as JSON.',
      },
    ],
  },
  {
    path: 'open',
    signature: '<key>',
    description: 'Open a work item (e.g. ACME-7) in the browser; prints the URL.',
    helpGroup: HELP_GROUP.read,
    options: [
      {
        flags: '--print',
        description: 'Print the URL only; do not launch a browser.',
      },
    ],
  },
  {
    path: 'next',
    signature: '',
    description:
      'Dispatch the next ready leaf (never a bug): claim it and deliver its prompt. --parent runs the next runnable container; --bug takes the next bug.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--kinds <list>',
        description: 'Comma-separated kinds: epic,story,task,bug,subtask.',
      },
      {
        flags: '--parent',
        description:
          'Run the next runnable container (a story, task or bug whose children are all leaves) as a parent run — as `motir run <KEY>` would.',
      },
      {
        flags: '--bug',
        description: 'Take the next ready bug instead of the next leaf.',
      },
      {
        flags: '--print',
        description:
          'Print the prompt to stdout INSTEAD of launching an agent (default). Not --print-prompt.',
      },
      {
        flags: '--print-prompt',
        description:
          'ALSO echo the assembled prompt to stderr as it is sent, and still run the agent.',
      },
      {
        flags: '--agent <cmd>',
        description: 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).',
      },
      {
        flags: '--reset',
        description: 'Clear this project’s session exclude list before picking.',
      },
      {
        flags: '--disable-log-bug',
        description:
          'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
      },
      {
        flags: '--disable-replan',
        description:
          'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
      },
      {
        flags: '--no-log-bug',
        description: 'Hidden alias for --disable-log-bug.',
        hidden: true,
      },
      {
        flags: '--no-replan',
        description: 'Hidden alias for --disable-replan.',
        hidden: true,
      },
      {
        flags: '--auto-approve-replan',
        description:
          'Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.',
      },
      // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ─────
      // Spelled and described IDENTICALLY on all four commands: the boundary it
      // moves is the same boundary whichever command a person happens to type,
      // and a table that described one promise four ways would be four promises.
      {
        flags: '--report-log',
        description:
          'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
      },
    ],
  },
  {
    path: 'run',
    // A SCOPE, not a key (`docs/decisions/scoped-run-command-surface.md`): a
    // work-item key, or the reserved word `sprint`. Which run it performs is
    // decided by the target's SHAPE — a leaf dispatches exactly as it always
    // did, a container with children runs its leaves.
    signature: '<scope>',
    description: 'Run a scope: one work item, a whole story, or `sprint` for the active one.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--print',
        description:
          'Print the prompt to stdout INSTEAD of launching an agent (default). One item; not --print-prompt.',
      },
      {
        flags: '--print-prompt',
        description:
          'Echo each assembled prompt to stderr as it is sent, alongside the run (2> prompts.log).',
      },
      {
        flags: '--agent <cmd>',
        description: 'Run THIS agent command on the prompt (overrides MOTIR_AGENT).',
      },
      {
        flags: '--force',
        description:
          'Dispatch even though the item is not ready (dependencies unmet). One work item only.',
      },
      {
        flags: '--allow-soft-block',
        description:
          "Run an item held only by an ancestor's block (a SOFT block). Still refuses one with its own open blocker (a HARD block — only --force passes that).",
      },
      {
        flags: '--disable-log-bug',
        description:
          'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
      },
      {
        flags: '--disable-replan',
        description:
          'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
      },
      {
        flags: '--no-log-bug',
        description: 'Hidden alias for --disable-log-bug.',
        hidden: true,
      },
      {
        flags: '--no-replan',
        description: 'Hidden alias for --disable-replan.',
        hidden: true,
      },
      {
        flags: '--auto-approve-replan',
        description:
          'Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.',
      },
      // ── The SCOPE flags (MOTIR-3198) ──────────────────────────────────────
      // Spelled and described to match `auto`'s entries word for word wherever
      // the meaning is identical, so the published table never describes one
      // behaviour two ways.
      {
        flags: '--max <n>',
        description: 'Stop after dispatching n work items from the scope.',
      },
      {
        flags: '--keep-going',
        description: 'Continue past a failed agent instead of halting on the first one.',
      },
      {
        flags: '--include-planning',
        description:
          'Trigger an AI expansion for an unexpanded story instead of refusing it. Never waits: the plan needs your approval.',
      },
      // Registered in order to be REFUSED, like `--auto-approve-replan` above:
      // the claim is all-or-nothing over the whole scope, so a filtered run
      // would hold cards it never worked.
      {
        flags: '--kinds <list>',
        description:
          'Not supported — a scoped run drains the whole claimed set, not a filtered subset.',
      },
      // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ─────
      // Spelled and described IDENTICALLY on all four commands: the boundary it
      // moves is the same boundary whichever command a person happens to type,
      // and a table that described one promise four ways would be four promises.
      {
        flags: '--report-log',
        description:
          'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
      },
      // ── The HOSTED mode (Story MOTIR-683 · MOTIR-6558) ───────────────────
      // The hosted image boots with `MOTIR_DISPATCH_RUN_ID`; the flag is its
      // spelling for a person reproducing a hosted run by hand.
      {
        flags: '--run-id <id>',
        description:
          'Adopt a run Motir already opened (a hosted run) instead of opening one. Env: MOTIR_DISPATCH_RUN_ID.',
      },
    ],
  },
  {
    path: 'fix',
    // Story MOTIR-5460 · MOTIR-5465 — the command the item page's Development
    // block offers on a card whose pull requests went red after its run ended, or
    // whose merge did not land for a reason THE CODE could answer (MOTIR-5803; since
    // MOTIR-6594 a conflict AND a queue failure both wait at Implemented; a setting or
    // a hand removal is refused). It sits beside `run` — the same work loop's repair.
    // MOTIR-6502 adds a story whose acceptance video was sent back with Re-run.
    signature: '<key>',
    description:
      'Hand a work item whose pull requests are failing, whose merge could not land because of its code, or whose acceptance video was sent back to re-run, to your agent, on their own branches.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--agent <cmd>',
        description: 'Run THIS agent command on the fix (overrides MOTIR_AGENT).',
      },
      // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ─────
      // Same words as on the other work-loop commands.
      {
        flags: '--report-log',
        description:
          'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
      },
    ],
  },
  {
    path: 'continue',
    // Story MOTIR-6526 · MOTIR-6533 — the command the item page offers on a work
    // item whose last run DIED (`run-death-keeps-work.md` §4): carry the work on,
    // on the dead run's branch, from any machine. Beside `fix` — the work loop's
    // other takeover of a card somebody else's run left.
    signature: '<key>',
    description:
      'Carry on a work item whose last run died, on the branch it left — from any machine, without starting it over.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--agent <cmd>',
        description: 'Run THIS agent command on the continue (overrides MOTIR_AGENT).',
      },
      { flags: '--max <n>', description: 'A parent: stop after dispatching n more work items.' },
      {
        flags: '--keep-going',
        description: 'A parent: continue past a failed agent instead of halting.',
      },
      {
        flags: '--report-log',
        description:
          'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
      },
    ],
  },
  {
    path: 'review',
    // Story MOTIR-1626 · MOTIR-6824 (`hosted-agent-run.md` §8) — the REVIEW AGENT. Run by
    // Motir's hosted container on the review run it opened when a card's pull requests
    // went green with the review agent on; typed anywhere else it refuses, saying why.
    signature: '<key>',
    description:
      'Hosted only: review a work item’s pull requests at the version under review and submit ONE verdict — never pushes, never posts to GitHub.',
    helpGroup: HELP_GROUP.workLoop,
    options: [],
  },
  {
    path: 'auto',
    signature: '',
    description: 'Drain the ready set unattended: one item at a time onto a session branch.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--agent <cmd>',
        description: 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).',
      },
      {
        flags: '--kinds <list>',
        description: 'Comma-separated kinds: epic,story,task,bug,subtask.',
      },
      {
        flags: '--max <n>',
        description: 'Stop after dispatching n work items.',
      },
      {
        flags: '--keep-going',
        description: 'Continue past a failed agent instead of halting on the first one.',
      },
      {
        flags: '--reset',
        description: 'Clear this project’s session exclude list before starting.',
      },
      {
        flags: '--include-planning',
        description:
          'Trigger an AI expansion for each unexpanded epic/story instead of skipping it. Never waits: the plan needs your approval.',
      },
      {
        flags: '--print',
        description:
          'Not supported — an unattended loop has nobody to paste a prompt. --print-prompt IS.',
      },
      {
        flags: '--print-prompt',
        description:
          'Echo each assembled prompt to stderr as it is sent, alongside the run (2> prompts.log).',
      },
      {
        flags: '--disable-log-bug',
        description:
          'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
      },
      {
        flags: '--disable-replan',
        description:
          'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
      },
      {
        flags: '--no-log-bug',
        description: 'Hidden alias for --disable-log-bug.',
        hidden: true,
      },
      {
        flags: '--no-replan',
        description: 'Hidden alias for --disable-replan.',
        hidden: true,
      },
      {
        flags: '--auto-approve-replan',
        description:
          'Approve a re-plan the agent submitted and keep looping, instead of stopping for you.',
      },
      // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ─────
      // Spelled and described IDENTICALLY on all four commands: the boundary it
      // moves is the same boundary whichever command a person happens to type,
      // and a table that described one promise four ways would be four promises.
      {
        flags: '--report-log',
        description:
          'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
      },
    ],
  },
  {
    path: 'batch',
    signature: '',
    description: 'Implement a FROZEN snapshot of the ready set: one pull request per item.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--agent <cmd>',
        description: 'Run THIS agent command on every prompt (overrides MOTIR_AGENT).',
      },
      {
        flags: '--kinds <list>',
        description: 'Comma-separated kinds: epic,story,task,bug,subtask.',
      },
      {
        flags: '--max <n>',
        description: 'Stop after dispatching n work items.',
      },
      {
        flags: '--keep-going',
        description: 'Continue past a failed agent instead of halting on the first one.',
      },
      {
        flags: '--reset',
        description: 'Clear this project’s session exclude list before snapshotting.',
      },
      {
        flags: '--print',
        description:
          'Not supported — a frozen snapshot has nobody to paste a prompt. --print-prompt IS.',
      },
      {
        flags: '--print-prompt',
        description:
          'Echo each assembled prompt to stderr as it is sent, alongside the run (2> prompts.log).',
      },
      {
        flags: '--disable-log-bug',
        description:
          'Do not let the agent file a bug for a defect it finds elsewhere; it comments instead.',
      },
      {
        flags: '--disable-replan',
        description:
          'Do not let the agent submit a re-plan for a wrong work item; it comments and stops.',
      },
      {
        flags: '--no-log-bug',
        description: 'Hidden alias for --disable-log-bug.',
        hidden: true,
      },
      {
        flags: '--no-replan',
        description: 'Hidden alias for --disable-replan.',
        hidden: true,
      },
      {
        flags: '--auto-approve-replan',
        description:
          'Not supported — approving a submitted re-plan and continuing is a `motir auto` flag.',
      },
      // ── The RUN RECORD's one control (Story MOTIR-1789 · MOTIR-1794) ─────
      // Spelled and described IDENTICALLY on all four commands: the boundary it
      // moves is the same boundary whichever command a person happens to type,
      // and a table that described one promise four ways would be four promises.
      {
        flags: '--report-log',
        description:
          'ALSO send your agent’s output to Motir, so a failed run shows its tail on the run page. OFF by default — only the lifecycle is sent, never file contents, paths or diffs.',
      },
    ],
  },
  {
    path: 'plan',
    signature: '[args...]',
    description: 'Plan by talking: resume the project’s planning conversation, add turns, submit.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--detach',
        description: 'Submit and return with the job/plan ids; do not wait for the planner.',
      },
    ],
  },
  {
    path: 'done',
    signature: '[key]',
    description: 'Close out a merged item — or a whole merged session branch.',
    helpGroup: HELP_GROUP.workLoop,
    options: [
      {
        flags: '--session <branch>',
        description: 'Bulk close-out: flip every item on this session branch.',
      },
      {
        flags: '--via <status>',
        description: 'Move through this status first (e.g. in_review).',
      },
    ],
  },
  // The in-agent terminal server (MOTIR-6938 · `docs/decisions/agent-terminal.md`
  // Q4). Not a command a person types: an agent's machine runs it as its main
  // process. It is still published, in the default ADDITIONAL group, because
  // the machine's init guards on `motir agent-terminal --help` and a reader
  // who finds it in `ps` should find it documented.
  {
    path: 'agent-terminal',
    signature: '',
    description: 'The terminal server inside a Motir agent image.',
    helpGroup: HELP_GROUP.additional,
    options: [],
  },
  {
    path: 'agent-terminal serve',
    signature: '',
    description: 'Serve this agent’s shell to Motir’s relay over WebSocket.',
    helpGroup: null,
    options: [
      {
        flags: '--port <port>',
        description: 'Port to listen on, on every interface (default 7681).',
      },
    ],
  },
  // The run launcher and its probes (MOTIR-7025 · `docs/decisions/agent-instance-run.md`
  // §1, §4). Not typed by a person: Motir runs them in the agent through a short
  // `exec`, and `agent-terminal run --help` exiting 0 is the image-capability probe.
  {
    path: 'agent-terminal run',
    signature: '<key>',
    description:
      'Open a run session for a card in this agent’s terminal server, and return its id at once.',
    helpGroup: null,
    options: [
      {
        flags: '--run-id <id>',
        description: 'The run to open a session for (its credentials are read on stdin).',
      },
      {
        flags: '--command <command>',
        description: 'What the session is for: run (the default), fix or continue.',
      },
    ],
  },
  {
    path: 'agent-terminal stop',
    signature: '',
    description: 'Stop a run’s session: SIGTERM, then SIGKILL after 10 seconds.',
    helpGroup: null,
    options: [{ flags: '--run-id <id>', description: 'The run whose session to stop.' }],
  },
  {
    path: 'agent-terminal status',
    signature: '',
    description: 'Report whether a run’s session is running, or how it exited.',
    helpGroup: null,
    options: [{ flags: '--run-id <id>', description: 'The run whose session to report.' }],
  },
  {
    path: 'agent-terminal signin',
    signature: '',
    description: 'Print whether this agent’s coding agent is signed in, as JSON.',
    helpGroup: null,
    options: [
      {
        flags: '--json',
        description: 'Print JSON (the only format; accepted for scripts that ask for it).',
      },
    ],
  },
  {
    path: 'help',
    signature: '[command...]',
    description: 'Show help for a command, or read a help topic.',
    helpGroup: HELP_GROUP.topics,
    options: [],
  },
];
