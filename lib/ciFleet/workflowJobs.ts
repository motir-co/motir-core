import { parse } from 'yaml';

// WHAT DOES EACH CI JOB OF A REPOSITORY ASK OF ITS RUNNER? (MOTIR-10290)
//
// The image-coverage condition of the fleet readiness verdict used to read a
// HAND-KEPT snapshot of every private repository's jobs
// (`lib/ciFleet/fleetJobInventory.json`), and every real workflow change held it
// at Not met until somebody re-measured the snapshot and a motir-core release
// shipped it (MOTIR-8870, MOTIR-9126, MOTIR-10211). This module removes the
// snapshot: it reads the workflow files themselves — fetched at the
// repository's head by `lib/services/workflowCoverageService.ts` — into one
// record per JOB: its runner, the reusable workflow it calls, whether it runs in
// a container or with services, and its steps in order. `jobCoverage.ts` then
// judges each job against the tool list the pinned runner image records.
//
// The shell half (`commandWords`, `scriptCommands`) is the executable reader
// MOTIR-8870 and MOTIR-9126 built for the old fingerprint, kept and sharpened:
// it was allowed to OVER-report there (a spurious word only moved a digest),
// and here a spurious word is a tool the job is said to lack, so the words a
// shell never runs as commands — a `for` variable, a `case` pattern, a `[[ ]]`
// operand, an array literal, a function the script defines — are skipped.

export interface WorkflowSourceFile {
  /** Repository-relative, e.g. `.github/workflows/ci.yml`. */
  path: string;
  text: string;
}

/** The workflow files and local actions a repository's jobs are read from. */
export function isWorkflowSourcePath(path: string): boolean {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return true;
  return /^\.github\/actions\/.+\/action\.ya?ml$/.test(path);
}

const SHELL_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'function',
  'select',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

/** Words that run the NEXT word as a command (`sudo apt-get`, `env X=1 make`). */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'nice', 'timeout', 'xargs']);

type Frame = 'code' | 'subst' | 'paren' | 'backtick' | 'single' | 'double' | 'array';

/**
 * The index of the `))` closing the arithmetic that opens with the `((` at
 * `open`, or -1 when this is not plain arithmetic: no `((` there, `$((a); (b))`
 * whose inner parenthesis closes on its own, or arithmetic holding a `$( )` or a
 * backtick, which runs a command. All of those stay with the command reading.
 */
function arithmeticEnd(src: string, open: number): number {
  if (src[open] !== '(' || src[open + 1] !== '(') return -1;
  let depth = 2;
  for (let i = open + 2; i < src.length; i++) {
    const c = src[i]!;
    if (c === '`' || c === '\n' || (c === '$' && src[i + 1] === '(')) return -1;
    if (c === '(') depth++;
    if (c === ')' && --depth === 1) return src[i + 1] === ')' ? i + 1 : -1;
  }
  return -1;
}

/**
 * Cut a script into simple commands. A separator (`&&`, `||`, `;`, `|`, a
 * newline) ends a command only OUTSIDE quotes (MOTIR-9126: a quoted jq filter is
 * one argument, not a pipeline). `$( )`, backticks and a `( )` subshell open a
 * nested command — inside double quotes too, since the shell runs them there —
 * and the text after one closes resumes the command it interrupted. Here-document
 * bodies and comments are dropped; a quote may span lines. An array literal
 * (`args+=(a b)`) is one word, the text before a stray `)` — a `case` pattern —
 * is not a command at all, and neither is arithmetic (`$((n * 10))`, `((n++))`).
 */
function commandSegments(script: string): string[] {
  const segments: string[] = [];
  const stack: Frame[] = ['code'];
  const bufs: string[] = [''];
  let heredocEnd: string | null = null;
  let line = '';
  const top = () => stack[stack.length - 1]!;
  const buf = () => bufs[bufs.length - 1]!;
  const append = (s: string) => {
    bufs[bufs.length - 1] += s;
  };
  const flush = () => {
    segments.push(buf());
    bufs[bufs.length - 1] = '';
  };
  const open = (frame: Frame) => {
    stack.push(frame);
    bufs.push('');
  };
  const close = () => {
    flush();
    stack.pop();
    bufs.pop();
  };
  const src = script.replace(/\\\r?\n/g, ' ').replace(/\r\n/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (heredocEnd !== null) {
      // Skip whole lines until the terminator.
      const end = src.indexOf('\n', i);
      const bodyLine = src.slice(i, end === -1 ? src.length : end);
      if (bodyLine.trim() === heredocEnd) heredocEnd = null;
      i = end === -1 ? src.length : end;
      continue;
    }
    line += c;
    const frame = top();
    if (frame === 'single') {
      if (c === "'") stack.pop();
      append(c);
      continue;
    }
    if (frame === 'double') {
      if (c === '\\') {
        append(c + (src[i + 1] ?? ''));
        i++;
      } else if (c === '"') {
        stack.pop();
        append(c);
      } else if (c === '$' && arithmeticEnd(src, i + 1) !== -1) {
        append('0');
        i = arithmeticEnd(src, i + 1);
      } else if (c === '$' && src[i + 1] === '(') {
        open('subst');
        i++;
      } else if (c === '`') {
        open('backtick');
      } else {
        append(c);
      }
      continue;
    }
    if (frame === 'array') {
      if (c === ')') stack.pop();
      else if (c === "'") stack.push('single');
      else if (c === '"') stack.push('double');
      append(c === '\n' ? ' ' : c);
      continue;
    }
    // An unquoted context: the script itself, or a nested command.
    if (c === '\n') {
      if (stack.length === 1) {
        const here = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
        if (here) heredocEnd = here[2] ?? null;
      }
      line = '';
      flush();
    } else if (c === '\\') {
      append(c + (src[i + 1] ?? ''));
      i++;
    } else if (c === '#' && /(^|[\s;&|(])$/.test(buf())) {
      // A comment runs to the end of the line; the newline itself is kept.
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === "'") {
      stack.push('single');
      append(c);
    } else if (c === '"') {
      stack.push('double');
      append(c);
    } else if (c === '$' && arithmeticEnd(src, i + 1) !== -1) {
      append('0');
      i = arithmeticEnd(src, i + 1);
    } else if (c === '(' && buf().trim() === '' && arithmeticEnd(src, i) !== -1) {
      i = arithmeticEnd(src, i);
    } else if (c === '$' && src[i + 1] === '(') {
      open('subst');
      i++;
    } else if (c === '(' && /=$/.test(buf())) {
      stack.push('array');
      append(c);
    } else if (c === '(' && /\[\[(?![^]*\]\])[^]*$/.test(buf())) {
      // Inside a `[[ ]]` test a parenthesis groups, or is a regex's: text.
      append(c);
    } else if (c === '(') {
      open('paren');
    } else if (c === ')' && /\[\[(?![^]*\]\])[^]*$/.test(buf())) {
      append(c);
    } else if (c === ')') {
      if (frame === 'subst' || frame === 'paren') close();
      // A `)` that closes nothing ends a `case` pattern: what came before it on
      // this command is the pattern, never a command.
      else bufs[bufs.length - 1] = '';
    } else if (c === '`') {
      if (frame === 'backtick') close();
      else open('backtick');
    } else if ((c === '&' && src[i + 1] === '&') || (c === '|' && src[i + 1] === '|')) {
      flush();
      i++;
    } else if (c === ';' || c === '|') {
      flush();
    } else {
      append(c);
    }
  }
  while (bufs.length > 0) {
    segments.push(bufs.pop()!);
  }
  return segments;
}

/** Split one simple command on whitespace outside quotes, so an assignment like
 *  `TITLE="a b"` — or an array one, `args+=(a b)` — stays one word. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let array = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (array > 0 && !quote) {
      if (c === '(') array++;
      else if (c === ')') array--;
      else if (c === "'" || c === '"') quote = c;
      word += c;
      continue;
    }
    if (c === '(' && !quote && /=$/.test(word)) {
      array = 1;
      word += c;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      if (c === '\\' && quote === '"') word += c + (segment[++i] ?? '');
      else word += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (word !== '') words.push(word);
      word = '';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    word += c;
  }
  if (word !== '') words.push(word);
  return words;
}

/** A command under a directory the runner itself provides (`$RUNNER_TEMP/tool`,
 *  `${GITHUB_ACTION_PATH}/run.sh`): a file of the run or of the action, which, like
 *  `./scripts/x.sh`, is not a tool the image must hold. Any other computed name
 *  stays computed. */
const RUNNER_DIR_PATH = /^\$\{?(RUNNER_TEMP|GITHUB_ACTION_PATH|GITHUB_WORKSPACE)\}?\//;

/** An absolute path whose DIRECTORY alone is computed and whose file name is
 *  literal (`/usr/lib/postgresql/${PG_MAJOR}/bin/pg_dump`): a path, like
 *  `/usr/bin/x`, not a computed command. A path that starts at a variable
 *  (`$HOME/bin/y`) stays computed. */
const ABSOLUTE_COMPUTED_DIR_PATH = /^\/.*\/[^/$]+$/;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/**
 * Blank out every `case` pattern (`a|b)`, `*)`, `(x)`), which the shell matches
 * as text and never runs. A pattern follows the `in` of its `case` or the `;;` /
 * `;&` / `;;&` ending the branch before it; its `|` is an alternation, not a pipe.
 */
function stripCasePatterns(script: string): string {
  return script.replace(/\bcase\b[\s\S]*?\besac\b/g, (block) =>
    block.replace(/(\bin\b|;;&?|;&)(\s*)\(?[^()\n;]*\)/g, '$1$2;'),
  );
}
const unquote = (word: string) => word.replace(/^['"]+|['"]+$/g, '');

/** The functions a script defines (`name() {` or `function name`) — the shell
 *  runs them, not an executable on PATH. */
function definedFunctions(script: string): Set<string> {
  const names = new Set<string>();
  for (const m of script.matchAll(/(?:^|[\s;&|])(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\s*\)/g)) {
    names.add(m[1]!);
  }
  for (const m of script.matchAll(/(?:^|[\s;&|])function\s+([A-Za-z_][\w:.-]*)/g)) {
    names.add(m[1]!);
  }
  return names;
}

/** The package names an install command adds to PATH, as executable names. */
function installedBy(tokens: string[]): string[] {
  const [cmd, ...rest] = tokens;
  const args = rest.filter((t) => !t.startsWith('-')).map(unquote);
  const global = rest.some((t) => t === '-g' || t === '--global');
  const pkgName = (spec: string) => {
    // `@scope/name@1.2` → `name`, `name==1.2` / `name[extra]` → `name`,
    // `golang.org/x/tools/cmd/goimports@latest` → `goimports`.
    const bare = spec
      .replace(/^(@[^/]+\/)?([^@]+)@.*$/, '$1$2')
      .replace(/[[<>=!~].*$/, '')
      .replace(/\/v\d+$/, '');
    return bare.slice(bare.lastIndexOf('/') + 1);
  };
  const names = (from: string[]) => from.map(pkgName).filter((n) => n !== '');
  // An npm package's executable is usually its name, or its name without a
  // `-cli` / `-ai` suffix (`opencode-ai` installs `opencode`); a bin named
  // otherwise reads as missing, which names the job and the tool.
  const binNames = (from: string[]) =>
    names(from).flatMap((n) => {
      const short = n.replace(/-(cli|ai)$/, '');
      return short !== n && short !== '' ? [n, short] : [n];
    });
  switch (cmd) {
    case 'pipx':
    case 'cargo':
      return args[0] === 'install' ? names(args.slice(1)) : [];
    case 'go':
      return args[0] === 'install' ? names(args.slice(1)) : [];
    case 'npm':
      return global && (args[0] === 'install' || args[0] === 'i') ? binNames(args.slice(1)) : [];
    case 'pnpm':
      return global && (args[0] === 'add' || args[0] === 'install') ? binNames(args.slice(1)) : [];
    case 'yarn':
      return args[0] === 'global' && args[1] === 'add' ? binNames(args.slice(2)) : [];
    case 'apt-get':
    case 'apt':
      return args[0] === 'install' ? names(args.slice(1)) : [];
    case 'corepack':
      return args[0] === 'enable'
        ? args.length > 1
          ? args.slice(1).flatMap((m) => [m, m === 'pnpm' ? 'pnpx' : 'yarnpkg'])
          : ['pnpm', 'pnpx', 'yarn', 'yarnpkg']
        : [];
    default:
      return [];
  }
}

/** What one `run:` body asks of the machine it runs on. */
export interface ScriptCommands {
  /** Every executable named at the head of a simple command, wrapped ones
   *  included (`sudo apt-get` names both). Sorted, distinct. */
  commands: string[];
  /** Commands whose NAME is computed (`$PYTHON`, `${{ inputs.cli }}`): no static
   *  reading can say which executable runs. Sorted, distinct. */
  dynamic: string[];
  /** Executables an install command in this body puts on PATH for the steps
   *  after it (`pipx install ruff` → `ruff`). Sorted, distinct. */
  installs: string[];
}

/**
 * Read a shell body: the first word of each simple command, after leading
 * `NAME=value` assignments and shell keywords. Comments, here-document bodies,
 * quoted text, `for` / `select` / `case` heads, `[[ ]]` tests, array literals and
 * the functions the script defines are skipped. A path (`./scripts/x.sh`) is the
 * repository's own file, not a tool the image must hold, so it is not a command.
 */
export function scriptCommands(script: string): ScriptCommands {
  const commands = new Set<string>();
  const dynamic = new Set<string>();
  const installs = new Set<string>();
  const functions = definedFunctions(script);
  for (const part of commandSegments(stripCasePatterns(script))) {
    let tokens = shellWords(part);
    // A keyword that introduces a command (`if gh …`, `then make`) is not the
    // command: look past it, and past assignments, to the executable. A loop or
    // `case` head and a `[[ ]]` test hold no command at all.
    while (tokens.length > 0 && (ASSIGNMENT.test(tokens[0]!) || SHELL_WORDS.has(tokens[0]!))) {
      if (['for', 'select', 'case', '[['].includes(tokens[0]!)) {
        tokens = [];
        break;
      }
      // `function name {` — the name is a definition, not a command.
      tokens = tokens.slice(tokens[0] === 'function' ? 2 : 1);
    }
    while (tokens.length > 0) {
      const word = tokens[0]!;
      if (word.startsWith('#') || word.startsWith('-')) break;
      if (/^(\d|&)?[<>]/.test(word)) {
        // A redirection before the command (`>out echo hi`): past it, and past
        // its target when that is the next word.
        tokens = tokens.slice(/^(\d|&)?[<>]+&?$/.test(word) ? 2 : 1);
        continue;
      }
      const bare = unquote(word);
      if (bare === '' || SHELL_WORDS.has(bare)) break;
      if (RUNNER_DIR_PATH.test(bare) || ABSOLUTE_COMPUTED_DIR_PATH.test(bare)) break;
      if (bare.includes('$')) {
        dynamic.add(bare);
        break;
      }
      if (functions.has(bare) && tokens[1] === '{') {
        // `name() {` on one line: the body that follows is the command.
        tokens = tokens.slice(2);
        continue;
      }
      if (bare.includes('/') || functions.has(bare)) break;
      commands.add(bare);
      for (const name of installedBy(tokens.map(unquote))) installs.add(name);
      if (!WRAPPERS.has(bare)) break;
      // The wrapped command: past the wrapper's flags, assignments and — for
      // `timeout` — its duration.
      tokens = tokens.slice(1);
      while (
        tokens.length > 0 &&
        (tokens[0]!.startsWith('-') ||
          ASSIGNMENT.test(tokens[0]!) ||
          (bare === 'timeout' && /^\d+[smhd]?$/.test(tokens[0]!)))
      ) {
        tokens = tokens.slice(1);
      }
    }
  }
  return {
    commands: [...commands].sort(),
    dynamic: [...dynamic].sort(),
    installs: [...installs].sort(),
  };
}

/** The executables a `run:` body invokes — `scriptCommands(script).commands`. */
export function commandWords(script: string): string[] {
  return scriptCommands(script).commands;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** One step of a job or of a composite action, as the judge reads it. */
export type WorkflowStep =
  | {
      kind: 'uses';
      /** The `uses:` reference as written. */
      uses: string;
      /** The step's `with:` inputs — a setup action's version, mostly. */
      with: Record<string, unknown>;
    }
  | {
      kind: 'run';
      /** The shell the body runs under: the step's, else the job's or the
       *  workflow's default, else null — the runner's default (`bash`). */
      shell: string | null;
      script: string;
    };

export interface WorkflowJob {
  /** The workflow file, repository-relative. */
  workflow: string;
  jobId: string;
  runsOn: unknown;
  /** The reusable workflow the job calls, as written (`./.github/workflows/x.yml`
   *  or `owner/repo/.github/workflows/x.yml@ref`), or null. */
  calls: string | null;
  /** The job runs its steps inside a `container:` image. */
  container: boolean;
  /** The job starts `services:` containers. */
  services: boolean;
  steps: WorkflowStep[];
}

/** What a repository's `.github` holds, read per job. */
export interface WorkflowSet {
  jobs: WorkflowJob[];
  /** Local actions by directory (`.github/actions/x`), their metadata parsed. */
  localActions: Map<string, ActionMetadata>;
  /** Files that are not valid YAML. Nothing in them can be judged. */
  invalid: string[];
}

/** An action's `action.yml`, as the judge needs it. */
export interface ActionMetadata {
  /** `node` for a JavaScript action (`node20`, `node24`, …), else what
   *  `runs.using` says (`docker`, `composite`), or `unknown`. */
  using: 'node' | 'docker' | 'composite' | 'unknown';
  /** A composite action's steps; empty otherwise. */
  steps: WorkflowStep[];
}

function stepsOf(container: unknown, defaultShell: string | null): WorkflowStep[] {
  const raw = asRecord(container)?.['steps'];
  if (!Array.isArray(raw)) return [];
  const steps: WorkflowStep[] = [];
  for (const entry of raw) {
    const step = asRecord(entry);
    if (!step) continue;
    if (typeof step['uses'] === 'string') {
      steps.push({ kind: 'uses', uses: step['uses'], with: asRecord(step['with']) ?? {} });
    } else if (typeof step['run'] === 'string') {
      const shell = typeof step['shell'] === 'string' ? step['shell'] : defaultShell;
      steps.push({ kind: 'run', shell, script: step['run'] });
    }
  }
  return steps;
}

const defaultShellOf = (container: unknown): string | null => {
  const shell = asRecord(asRecord(asRecord(container)?.['defaults'])?.['run'])?.['shell'];
  return typeof shell === 'string' ? shell : null;
};

/** Parse an `action.yml`. Throws on text that is not valid YAML. */
export function parseActionMetadata(text: string): ActionMetadata {
  const runs = asRecord(asRecord(parse(text))?.['runs']);
  const using = typeof runs?.['using'] === 'string' ? runs['using'].toLowerCase() : '';
  if (/^node\d+$/.test(using)) return { using: 'node', steps: [] };
  if (using === 'docker') return { using: 'docker', steps: [] };
  if (using === 'composite') return { using: 'composite', steps: stepsOf(runs, null) };
  return { using: 'unknown', steps: [] };
}

/** Read every workflow file and local action into per-job records. A file that
 *  is not valid YAML is listed in `invalid`, never skipped silently. */
export function parseWorkflows(files: WorkflowSourceFile[]): WorkflowSet {
  const jobs: WorkflowJob[] = [];
  const localActions = new Map<string, ActionMetadata>();
  const invalid: string[] = [];
  const sorted = files
    .filter((f) => isWorkflowSourcePath(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    let doc: unknown;
    try {
      doc = parse(file.text);
    } catch {
      invalid.push(file.path);
      continue;
    }
    if (file.path.startsWith('.github/actions/')) {
      localActions.set(
        file.path.slice(0, file.path.lastIndexOf('/')),
        parseActionMetadata(file.text),
      );
      continue;
    }
    const workflowShell = defaultShellOf(doc);
    for (const [jobId, raw] of Object.entries(asRecord(asRecord(doc)?.['jobs']) ?? {})) {
      const job = asRecord(raw);
      if (!job) continue;
      jobs.push({
        workflow: file.path,
        jobId,
        runsOn: job['runs-on'] ?? null,
        calls: typeof job['uses'] === 'string' ? job['uses'] : null,
        container: job['container'] !== undefined && job['container'] !== null,
        services: asRecord(job['services']) !== null,
        steps: stepsOf(job, defaultShellOf(job) ?? workflowShell),
      });
    }
  }
  return { jobs, localActions, invalid };
}
