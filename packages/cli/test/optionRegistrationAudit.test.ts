import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { HELP_TOPICS } from '../src/help.js';
import { buildProgram } from '../src/program.js';

// THE SWEEP (MOTIR-1830) — a command that READS an option must REGISTER it.
//
// Twice now the same defect shipped: a command module guarded a flag
// (`opts.print`) that `program.ts` never registered, so commander rejected the
// flag FIRST with a bare `unknown option '--print'` and the guard — the one
// carrying the sentence that tells the user what to do instead — was dead code
// from the command line. MOTIR-1828 fixed it on `auto`; `batch` shipped with the
// identical hole because the fix was applied by hand, one command at a time, and
// nothing checked the rest.
//
// So the audit stops being a thing someone remembers to do. Each command's
// options INTERFACE is its declared read surface — every field on it is a flag
// the handler may read — and this test asserts that `program.ts` registers all
// of them, for every command in the tree. A third instance of this class fails
// here, at the moment the interface field is added.
//
// Why parse the source: interfaces are erased at runtime, so the declared read
// surface is only legible in the `.ts` text. The parse is guarded below (an
// interface that cannot be found, or that yields no fields, FAILS) so a rename
// can never quietly turn this into a test that asserts nothing.

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * The options interface each command's handler receives — its declared read
 * surface. `null` means the command takes no options at all (a pure group like
 * `auth`, or a positional-only leaf like `link add`).
 *
 * Every command in the program must appear here: the coverage assertion below
 * fails on a new command that was never mapped, so this cannot silently drift
 * out of date the way the hand-audit did.
 */
const OPTIONS_INTERFACE: Record<string, string | null> = {
  // `LoginOptions.browser` is commander's NEGATED boolean: `--no-browser`
  // registers under the attribute name `browser`, which is what the handler
  // reads and what this audit compares against.
  login: 'LoginOptions',
  logout: 'AuthScopeOptions',
  auth: null,
  'auth login': 'AuthLoginOptions',
  'auth status': 'AuthScopeOptions',
  'auth logout': 'AuthScopeOptions',
  // `AuthRefreshOptions.browser` is `--no-browser`, as on `login`.
  'auth refresh': 'AuthRefreshOptions',
  link: 'LinkOptions',
  'link add': null,
  'link remove': null,
  ready: 'ReadyOptions',
  status: 'StatusOptions',
  sprints: 'SprintsOptions',
  sprint: 'SprintOptions',
  show: 'ShowOptions',
  doctor: 'DoctorCommandOptions',
  open: 'OpenOptions',
  next: 'NextOptions',
  run: 'RunOptions',
  fix: 'FixOptions',
  continue: 'ContinueOptions',
  // `motir review <key>` (MOTIR-6824) reads only its key — no options.
  review: null,
  auto: 'AutoOptions',
  batch: 'BatchOptions',
  plan: 'PlanOptions',
  done: 'DoneOptions',
  'agent-terminal': null,
  'agent-terminal serve': 'AgentTerminalServeOptions',
  'agent-terminal run': 'AgentTerminalRunIdOptions',
  'agent-terminal stop': 'AgentTerminalRunIdOptions',
  'agent-terminal status': 'AgentTerminalRunIdOptions',
  // `--json` is accepted for scripts and ignored: JSON is the only output.
  'agent-terminal signin': null,
};

/** The help surface registers pseudo-commands that carry no options. */
const HELP_SURFACE = new Set(['help', ...HELP_TOPICS.map((topic) => topic.name)]);

interface ParsedInterface {
  /** Field names, in declaration order. */
  fields: string[];
  /**
   * EVERY interface it extends — TypeScript allows a comma-separated list, and
   * `RunOptions extends DeliveryOptions, ScopeRunOptions` (MOTIR-3198) is the
   * first one here to use it.
   *
   * ⚠️ This was `parent: string | null` and the block regex captured only the
   * first name, so a multi-parent interface did not match the pattern AT ALL and
   * `declaredOptions` threw *"not found under src/"*. The throw was the guard
   * working — a miss must never be silent — but the diagnosis it offered was
   * wrong: the interface was there, and ordinary TypeScript was not. Widening
   * makes the audit cover strictly MORE than it did, which is the only direction
   * a guard may be relaxed in.
   */
  parents: string[];
}

/** Every `export interface …` under `src/`, keyed by name. */
function parseInterfaces(dir: string, into = new Map<string, ParsedInterface>()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      parseInterfaces(path, into);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const source = readFileSync(path, 'utf8');
    // Non-greedy to the first line that closes the block at column 0 — an
    // interface body never dedents that far until it ends.
    const block = /export interface (\w+)(?: extends ([\w\s,]+?))?\s*\{([\s\S]*?)\n\}/g;
    for (const match of source.matchAll(block)) {
      const [, name, extendsList, body] = match;
      if (name === undefined || body === undefined) continue;
      // Fields sit at exactly one indent level; anything deeper belongs to a
      // nested object type, and doc comments start with `*` or `/`.
      const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].flatMap(([, field]) =>
        field === undefined ? [] : [field],
      );
      const parents = (extendsList ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      into.set(name, { fields, parents });
    }
  }
  return into;
}

const INTERFACES = parseInterfaces(SRC_DIR);

/** The declared read surface of `name`, including everything it inherits. */
function declaredOptions(name: string): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  // A QUEUE rather than a cursor: an interface may extend several, and every
  // branch of the inheritance graph contributes fields the handler can read.
  const queue: string[] = [name];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const parsed: ParsedInterface | undefined = INTERFACES.get(current);
    // A miss means the interface was renamed or moved. Throw rather than skip:
    // a silent miss would make the whole audit vacuous, which is the failure
    // mode this test exists to prevent.
    if (!parsed) throw new Error(`option interface \`${current}\` not found under src/`);
    fields.push(...parsed.fields);
    queue.push(...parsed.parents);
  }
  return [...new Set(fields)];
}

/** Every command in the tree, keyed by its full path (`auth login`). */
function walk(command: Command, prefix: string[] = [], into = new Map<string, Command>()) {
  for (const child of command.commands) {
    const path = [...prefix, child.name()];
    into.set(path.join(' '), child);
    walk(child, path, into);
  }
  return into;
}

const COMMANDS = walk(buildProgram());

describe('every option a command READS is an option `program.ts` REGISTERS', () => {
  // The parse is the load-bearing part; assert it actually worked before
  // trusting anything it produced.
  it('parses the option interfaces out of src/ (a rename fails here, not silently)', () => {
    const mapped = Object.values(OPTIONS_INTERFACE).filter((name): name is string => name !== null);
    expect(mapped.length).toBeGreaterThan(0);
    for (const name of mapped) {
      expect(declaredOptions(name).length, `\`${name}\` parsed to zero fields`).toBeGreaterThan(0);
    }
    // The inheritance arm is exercised — `DeliveryOptions` contributes
    // `--agent` / `--print` to the dispatch commands — so a broken `extends`
    // parse cannot pass by finding only the child's own fields.
    expect(declaredOptions('BatchOptions')).toEqual(expect.arrayContaining(['agent', 'print']));
  });

  it('covers EVERY command in the program — a new one cannot escape the audit', () => {
    const unmapped = [...COMMANDS.keys()].filter(
      (path) => !(path in OPTIONS_INTERFACE) && !HELP_SURFACE.has(path),
    );
    expect(
      unmapped,
      'add these to OPTIONS_INTERFACE (use null if the command takes no options)',
    ).toEqual([]);
  });

  it.each(Object.entries(OPTIONS_INTERFACE))('`motir %s`', (path, interfaceName) => {
    const command = COMMANDS.get(path);
    expect(command, `\`${path}\` is mapped but not registered`).toBeDefined();

    const registered = new Set(command!.options.map((option) => option.attributeName()));
    const declared = interfaceName ? declaredOptions(interfaceName) : [];
    const unregistered = declared.filter((field) => !registered.has(field));

    // The failure this catches: the handler guards or reads `opts.<field>`, but
    // commander never learned the flag, so it rejects it as unknown before the
    // handler ever runs.
    expect(
      unregistered,
      `\`${interfaceName}\` declares ${unregistered.join(', ')}, which \`motir ${path}\` does not register — commander will reject the flag before the handler sees it`,
    ).toEqual([]);
  });
});
