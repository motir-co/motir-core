import { createHash } from 'node:crypto';
import { parse } from 'yaml';

// WHAT ABOUT A REPOSITORY'S WORKFLOWS DECIDES THE FLEET INVENTORY'S VERDICTS?
// (MOTIR-8870)
//
// `fleetJobInventory.json` records, per job, whether the runner image can run it.
// Those verdicts depend on a job's runner, the reusable workflow it calls, the
// actions it uses and the executables its `run:` bodies invoke. They do NOT depend
// on a new step that uses tools the repository already used, on a changed
// argument, or on a shifted line. The readiness check used to call the inventory
// stale on ANY newer workflow commit, so every harmless edit blocked the switch
// until somebody re-measured by hand (motir-ai#768, motir-ai#776).
//
// This module is the "what matters" half of that check: a digest of exactly those
// inputs. The inventory records it at measure time and readiness recomputes it at
// the repository's head; equal digests mean no verdict can have moved.
//
// ⚠️ The sets are REPOSITORY-WIDE, not per job. A tool a job gains that another
// job already used cannot be seen here. That is the deliberate trade: the check
// must be cheap to keep honest, and a missed case costs a job that fails on the
// fleet and is switched off by the rule the ON window already has. A NEW tool,
// action or runner anywhere in the repository always moves the digest.
//
// ⚠️ AND SO IS THE SET OF RUNNERS (MOTIR-10211). The digest used to key every job
// by `<path>#<jobId>`, so a job ADDED on a runner the repository already used,
// running only tools it already used, still moved it: motir-infra#7's `verify`
// job held the switch off for five days with nothing new to measure. The digest
// now reads the distinct runners and reusable workflows, like the other sets.
// What a flat set cannot see — an EXISTING job moving between two runners the
// repository both already used, e.g. onto the seam — is the second half of the
// check, `recordedJobsMoved` in `lib/ciFleet/inventoryStaleness.ts`, which reads
// each job's recorded `runsOn` against its runner at the head. `jobs` stays in
// the structure for that check; it is no longer an input to the digest.

export interface WorkflowSourceFile {
  /** Repository-relative, e.g. `.github/workflows/ci.yml`. */
  path: string;
  text: string;
}

/** The workflow files and composite actions the digest reads. */
export function isFingerprintedPath(path: string): boolean {
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

type Frame = 'code' | 'subst' | 'paren' | 'backtick' | 'single' | 'double';

/**
 * Cut a script into simple commands. A separator (`&&`, `||`, `;`, `|`, a
 * newline) ends a command only OUTSIDE quotes (MOTIR-9126: a quoted jq filter is
 * one argument, not a pipeline). `$( )`, backticks and a `( )` subshell open a
 * nested command — inside double quotes too, since the shell runs them there —
 * and the text after one closes resumes the command it interrupted. Here-document
 * bodies and comments are dropped; a quote may span lines.
 */
function commandSegments(script: string): string[] {
  const segments: string[] = [];
  const stack: Frame[] = ['code'];
  const bufs: string[] = [''];
  let heredocEnd: string | null = null;
  let line = '';
  const top = () => stack[stack.length - 1]!;
  const append = (s: string) => {
    bufs[bufs.length - 1] += s;
  };
  const flush = () => {
    segments.push(bufs[bufs.length - 1]!);
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
    } else if (c === '#' && /(^|[\s;&|(])$/.test(bufs[bufs.length - 1]!)) {
      // A comment runs to the end of the line; the newline itself is kept.
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (c === "'") {
      stack.push('single');
      append(c);
    } else if (c === '"') {
      stack.push('double');
      append(c);
    } else if (c === '$' && src[i + 1] === '(') {
      open('subst');
      i++;
    } else if (c === '(') {
      open('paren');
    } else if (c === ')') {
      if (frame === 'subst' || frame === 'paren') close();
      else flush();
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
 *  `TITLE="a b"` stays one word. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
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

/**
 * The executables a `run:` body invokes: the first word of each simple command,
 * after leading `NAME=value` assignments. Comments, here-document bodies, quoted
 * text and shell keywords are skipped. Deliberately coarse — it over-reports (an
 * `echo` counts) and never under-reports a real executable at the head of a
 * command.
 */
export function commandWords(script: string): string[] {
  const words = new Set<string>();
  for (const part of commandSegments(script)) {
    const tokens = shellWords(part);
    let i = 0;
    // A keyword that introduces a command (`if gh …`, `then make`) is not the
    // command: look past it, and past assignments, to the executable.
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || SHELL_WORDS.has(tokens[i]!))
    ) {
      i++;
    }
    const word = tokens[i];
    if (!word || SHELL_WORDS.has(word) || word.startsWith('#') || word.startsWith('-')) continue;
    if (word.startsWith('>') || word.startsWith('<') || /^\d?[<>]/.test(word)) continue;
    const bare = word.replace(/^['"]+|['"]+$/g, '');
    if (bare !== '') words.add(bare);
  }
  return [...words];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function actionName(ref: string): string {
  // `owner/repo@v4` and `owner/repo/path@v4` are the same action at any version;
  // a local `./.github/actions/x` has no `@`.
  const at = ref.lastIndexOf('@');
  return at > 0 ? ref.slice(0, at) : ref;
}

function stepsOf(container: unknown): Array<Record<string, unknown>> {
  const steps = asRecord(container)?.['steps'];
  if (!Array.isArray(steps)) return [];
  return steps.map(asRecord).filter((s): s is Record<string, unknown> => s !== null);
}

/** Canonical JSON: object keys sorted, so the digest never depends on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const rec = asRecord(value);
  if (rec) {
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface WorkflowStructure {
  /** `path#jobId` → the job's `runs-on` and the reusable workflow it calls. Read
   *  per job by `recordedJobsMoved`; NOT an input to the digest (MOTIR-10211). */
  jobs: Record<string, { runsOn: unknown; calls: string | null }>;
  /** Every distinct `runs-on`, canonical JSON, across the repository. */
  runners: string[];
  /** Every reusable workflow a job calls, without its version, across the repository. */
  calls: string[];
  /** Every action reference without its version, across the repository. */
  actions: string[];
  /** Every executable a `run:` body invokes, across the repository. */
  commands: string[];
  /** Every non-default `shell:` named. */
  shells: string[];
}

/** Parse the files and extract what the verdicts depend on. A file that is not
 *  valid YAML throws: the caller treats that as "cannot tell", never "unchanged". */
export function workflowStructure(files: WorkflowSourceFile[]): WorkflowStructure {
  const jobs: WorkflowStructure['jobs'] = {};
  const actions = new Set<string>();
  const commands = new Set<string>();
  const shells = new Set<string>();

  const readSteps = (container: unknown) => {
    for (const step of stepsOf(container)) {
      if (typeof step['uses'] === 'string') actions.add(actionName(step['uses']));
      const shell = typeof step['shell'] === 'string' ? step['shell'] : null;
      // A `python3 {0}` body is not shell: its interpreter is recorded in
      // `shells`, and reading its lines as commands only adds noise (MOTIR-9126).
      if (typeof step['run'] === 'string' && (shell === null || /^(ba)?sh\b/.test(shell)))
        for (const w of commandWords(step['run'])) commands.add(w);
      if (shell !== null) shells.add(shell);
    }
  };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const doc = asRecord(parse(file.text));
    if (!doc) continue;
    if (file.path.startsWith('.github/actions/')) {
      readSteps(asRecord(doc['runs']));
      continue;
    }
    const defaults = asRecord(asRecord(doc['defaults'])?.['run']);
    if (typeof defaults?.['shell'] === 'string') shells.add(defaults['shell']);
    for (const [jobId, raw] of Object.entries(asRecord(doc['jobs']) ?? {})) {
      const job = asRecord(raw);
      if (!job) continue;
      const jobDefaults = asRecord(asRecord(job['defaults'])?.['run']);
      if (typeof jobDefaults?.['shell'] === 'string') shells.add(jobDefaults['shell']);
      jobs[`${file.path}#${jobId}`] = {
        runsOn: job['runs-on'] ?? null,
        calls: typeof job['uses'] === 'string' ? actionName(job['uses']) : null,
      };
      readSteps(job);
    }
  }

  const runners = new Set<string>();
  const calls = new Set<string>();
  for (const job of Object.values(jobs)) {
    // A caller job has no `runs-on` of its own; its runners are its callee's jobs.
    if (job.calls !== null) calls.add(job.calls);
    else runners.add(canonical(job.runsOn));
  }

  return {
    jobs,
    runners: [...runners].sort(),
    calls: [...calls].sort(),
    actions: [...actions].sort(),
    commands: [...commands].sort(),
    shells: [...shells].sort(),
  };
}

/** Canonical JSON of a `runs-on` value — how `runners` spells a runner, and how
 *  a recorded job's runner is compared with its runner at the head. */
export function canonicalRunsOn(runsOn: unknown): string {
  return canonical(runsOn ?? null);
}

/** The digest of a structure's REPOSITORY-WIDE inputs — never the per-job map,
 *  so adding a job on a known runner with known tools leaves it put (MOTIR-10211). */
export function structureDigest(structure: WorkflowStructure): string {
  const { runners, calls, actions, commands, shells } = structure;
  return createHash('sha256')
    .update(canonical({ runners, calls, actions, commands, shells }))
    .digest('hex');
}

/** The fingerprinted files' structure — every other path is ignored. */
export function fingerprintedStructure(files: WorkflowSourceFile[]): WorkflowStructure {
  return workflowStructure(files.filter((f) => isFingerprintedPath(f.path)));
}

/** The digest the inventory records and readiness recomputes. */
export function workflowFingerprint(files: WorkflowSourceFile[]): string {
  return structureDigest(fingerprintedStructure(files));
}
