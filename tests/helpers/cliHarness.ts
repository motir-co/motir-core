import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The harness the CLI story suite drives the BUILT `motir` binary with (Story
// 7.9 · Subtask 7.9.5 · MOTIR-883).
//
// Everything here exists so the suite tests the SHIPPED artifact rather than a
// re-import of its source: the binary is the tsup bundle `package.json#bin`
// points at, it runs as a real child process, and it reaches the server over a
// socket (tests/helpers/mcpHttpServer.ts). The only things faked are the two
// programs Motir SHELLS OUT TO and deliberately does not own — the user's coding
// agent (BYOK: the agent is the user's, Motir only launches it) and `gh`. Both
// are recorded so the suite can assert what the CLI actually asked them to do.

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo root — `tests/helpers/` is two levels down. */
const REPO_ROOT = resolve(HERE, '..', '..');
const CLI_DIR = join(REPO_ROOT, 'packages', 'cli');
const CLI_ENTRY = join(CLI_DIR, 'dist', 'index.js');

let built = false;

/**
 * The lock + stamp that make the build safe across vitest WORKERS (below). They
 * live under the package's `node_modules/.cache` — already git-ignored, already
 * per-checkout, and (unlike anything in `dist/`) not wiped by tsup's `clean`.
 */
const BUILD_CACHE = join(CLI_DIR, 'node_modules', '.cache', 'motir-cli-build');
const BUILD_LOCK = join(BUILD_CACHE, 'lock');
const BUILD_STAMP = join(BUILD_CACHE, 'stamp');
/** A lock older than this belonged to a worker that died holding it. */
const LOCK_STALE_MS = 180_000;
/** How long a worker waits for the peer that is building before giving up. */
const LOCK_WAIT_MS = 240_000;

/** Newest mtime across everything the bundle is built FROM — the build's input
 *  fingerprint. Equal fingerprint ⇒ the `dist/` on disk is already this source. */
function sourceFingerprint(): string {
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  walk(join(CLI_DIR, 'src'));
  for (const file of ['tsup.config.ts', 'package.json']) {
    newest = Math.max(newest, statSync(join(CLI_DIR, file)).mtimeMs);
  }
  return String(newest);
}

/**
 * Take an exclusive, cross-PROCESS build lock. `mkdir` is atomic on every
 * filesystem we run on (POSIX + the CI runners), which is the whole reason it is
 * the lock primitive here rather than a file whose existence check races.
 */
function acquireBuildLock(): void {
  mkdirSync(BUILD_CACHE, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(BUILD_LOCK);
      return;
    } catch {
      // Held. Break it only if its holder is long gone — a crashed worker must
      // not wedge every later run, and a live one must not be trampled.
      try {
        if (Date.now() - statSync(BUILD_LOCK).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(BUILD_LOCK);
          continue;
        }
      } catch {
        // The holder released it between our mkdir and our stat — just retry.
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the @motir/cli build lock (${BUILD_LOCK}).`);
      }
      // A short synchronous wait: this runs in a `beforeAll`, and the peer we
      // are waiting on is running tsup, not our event loop.
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { stdio: 'ignore' });
    }
  }
}

/**
 * Build `packages/cli` and return the path to the built entrypoint.
 *
 * Built from THIS commit's source (never a stale `dist/` a previous run left
 * behind) — the same reason the design-system CI job rebuilds before running its
 * barrel guard. Memoized per process, and SERIALIZED + deduplicated across
 * processes by a lock + an input fingerprint.
 *
 * ⚠️ WHY THE LOCK EXISTS (MOTIR-1870). The root lane runs with
 * `fileParallelism: true`, so two SEPARATE files that spawn the binary land in
 * two workers that can call this at the same moment — and `tsup` runs with
 * `clean: true`, so the second build would delete `dist/` out from under a child
 * process the first worker had already spawned. That used to be avoided by
 * convention ("keep every binary-spawning test in ONE file"), which stopped
 * being tenable when this Story added its own binary-driven suite
 * (`cli-connect-story.test.ts`) beside `cli-story.test.ts`. The lock makes the
 * invariant structural: exactly one build runs at a time, and the loser skips it
 * entirely because the fingerprint already matches.
 */
export function ensureCliBuilt(): string {
  if (built) return CLI_ENTRY;
  acquireBuildLock();
  try {
    const fingerprint = sourceFingerprint();
    const alreadyBuilt =
      existsSync(CLI_ENTRY) &&
      existsSync(BUILD_STAMP) &&
      readFileSync(BUILD_STAMP, 'utf8') === fingerprint;
    if (!alreadyBuilt) {
      // tsup is a devDependency OF the package, so pnpm links it under the
      // package's own `node_modules/.bin` (not the root's).
      const tsup = join(CLI_DIR, 'node_modules', '.bin', 'tsup');
      const result = spawnSync(tsup, [], { cwd: CLI_DIR, encoding: 'utf8', shell: false });
      if (result.status !== 0) {
        throw new Error(
          `Building @motir/cli failed (exit ${result.status}):\n${result.stderr ?? ''}\n${result.stdout ?? ''}`,
        );
      }
      if (!existsSync(CLI_ENTRY)) {
        throw new Error(`tsup reported success but ${CLI_ENTRY} is missing.`);
      }
      // Stamped AFTER the build (tsup's `clean: true` wipes `dist/` first), so a
      // crash mid-build leaves no stamp and the next worker rebuilds.
      writeFileSync(BUILD_STAMP, fingerprint);
    }
  } finally {
    rmdirSync(BUILD_LOCK);
  }
  built = true;
  return CLI_ENTRY;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for assertions that don't care which stream a line took. */
  output: string;
}

export interface CliRunOptions {
  /** Working directory the command runs in (defaults to the workspace root). */
  cwd?: string;
  /** Extra environment for this invocation (e.g. MOTIR_AGENT). */
  env?: Record<string, string>;
}

/**
 * One CLI workspace: a temp workspace root (where `.motir.json` lands), a temp
 * config home (the credential store + the session exclude list), and a temp
 * `bin` on PATH holding the fake `gh`.
 *
 * `MOTIR_CONFIG_HOME` alone is still enough to keep BOTH off a real home: the
 * exclude list moved to the state home (MOTIR-1836), but `stateDir()` resolves
 * `MOTIR_CONFIG_HOME` ahead of `XDG_STATE_HOME` precisely so one relocation
 * keeps moving all CLI state — this harness is the reason that rung exists.
 */
export interface CliWorkspace {
  /** The workspace root — the folder `motir link` binds. */
  root: string;
  /** `MOTIR_CONFIG_HOME` for every command (never a real home). */
  configHome: string;
  /** Directory prepended to PATH; holds the fake `gh`. */
  binDir: string;
  /** Run the built binary with the workspace's env. ASYNC on purpose — see
   *  {@link makeCliWorkspace}. */
  run(args: string[], opts?: CliRunOptions): Promise<CliResult>;
  /** Absolute path inside the workspace root. */
  path(...segments: string[]): string;
}

/** How long one CLI command may run before the harness kills it. */
const CLI_KILL_AFTER_MS = 60_000;

export function makeCliWorkspace(): CliWorkspace {
  const base = mkdtempSync(join(tmpdir(), 'motir-cli-'));
  const root = join(base, 'workspace');
  const configHome = join(base, 'config-home');
  const binDir = join(base, 'bin');
  const home = join(base, 'home');
  for (const dir of [root, configHome, binDir, home]) mkdirSync(dir, { recursive: true });

  const entry = ensureCliBuilt();

  const run = async (args: string[], opts: CliRunOptions = {}): Promise<CliResult> => {
    // ASYNC, never `spawnSync`: the MCP endpoint the CLI connects to is served by
    // an HTTP listener on THIS process's event loop (tests/helpers/mcpHttpServer),
    // and a synchronous spawn blocks that loop — the child's request would never
    // be answered and every command would hang to its timeout.
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: opts.cwd ?? root,
      shell: false,
      // A CLEAN environment: PATH (+ the fake bin), a temp HOME and config home,
      // and nothing else. Inheriting the runner's env would let a real
      // MOTIR_TOKEN / MOTIR_AGENT on the machine change what the CLI does.
      env: {
        // `NODE_ENV` is the one inherited value: the repo's ProcessEnv type
        // requires it, and the CLI never reads it.
        NODE_ENV: process.env.NODE_ENV,
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
        HOME: home,
        MOTIR_CONFIG_HOME: configHome,
        // git needs an identity for the commits the session-branch tests make.
        GIT_AUTHOR_NAME: 'Motir Test',
        GIT_AUTHOR_EMAIL: 'test@motir.invalid',
        GIT_COMMITTER_NAME: 'Motir Test',
        GIT_COMMITTER_EMAIL: 'test@motir.invalid',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });

    let killed = false;
    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      // A hung command must fail its own test, not stall the whole file.
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, CLI_KILL_AFTER_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectExit(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolveExit(signal ? 1 : (code ?? 1));
      });
    });

    // ⚠️ SAY SO when the harness killed the command (MOTIR-10799). A kill used to
    // read as a bare exit code 1 with no stderr line, indistinguishable from the
    // CLI failing on its own — which is how a case that only ran too long was
    // filed as a wrong result. The line names the bound, so the failure points
    // at the wait that hit it rather than at the assertion.
    if (killed) {
      stderr += `\n[cliHarness] killed with SIGKILL after ${CLI_KILL_AFTER_MS} ms: \`motir ${args.join(' ')}\` did not exit in time.\n`;
    }

    return { exitCode, stdout, stderr, output: stdout + stderr };
  };

  return { root, configHome, binDir, run, path: (...segments) => join(root, ...segments) };
}

// ── the fake coding agent ───────────────────────────────────────────────────

/** One recorded agent invocation — everything the BYOK contract promises the
 *  agent receives (agentRun.ts: the prompt on BOTH stdin and $MOTIR_PROMPT_FILE,
 *  launched in the resolved checkout). */
export interface AgentInvocation {
  /** The directory the agent was launched in — the repo-routing assertion. */
  cwd: string;
  /** The prompt as delivered on STDIN. */
  stdin: string;
  /** The value of `$MOTIR_PROMPT_FILE`. */
  promptFile: string | null;
  /** The prompt as read back from `$MOTIR_PROMPT_FILE`. */
  promptFromFile: string | null;
  /**
   * The value of `$MOTIR_DESIGN_DIR` (Story MOTIR-5553 · Subtask MOTIR-5567) —
   * where the run put the approved design, or `null` when it put none there.
   *
   * ⚠️ `null` IS THE INFORMATIVE VALUE. An unset variable is precisely what
   * tells a real agent to fetch the design itself, so a test that could only
   * see the happy path could not tell "the design landed" from "the design was
   * skipped and nobody said so".
   */
  designDir: string | null;
  /** Every file under `$MOTIR_DESIGN_DIR`, relative to it, sorted. `[]` when
   *  the variable is unset or the directory does not exist. */
  designFiles: string[];
  argv: string[];
}

/** What a scripted agent does on its Nth invocation. */
export interface AgentStep {
  /** Exit code (default 0). */
  exit?: number;
  /** Directory to create, relative to the agent's cwd — the bootstrap agent
   *  "cloning" the repo it was sent to create. */
  create?: string;
  /**
   * Do what a session-lineage prompt tells a real agent to do: branch from the
   * session branch on origin, commit `file`, push it back — IN the directory the
   * agent was launched in.
   *
   * The branch is not configured here; the agent READS it out of the prompt it
   * was handed (the GIT WORKFLOW section names it), which is both what a real
   * agent does and the only way a test can know a run-id-stamped branch name.
   */
  integrate?: { file: string };
  /**
   * Do what a MULTI-REPOSITORY per-item-PR prompt tells a real agent to do
   * (Story MOTIR-2731 · MOTIR-3141): for EVERY repository block the prompt
   * renders, enter that repository, branch, commit `file`, push, and open a pull
   * request whose title carries the item key.
   *
   * Like `integrate`, everything is READ OUT OF THE PROMPT — the repository
   * directories, the shared branch name, each repository's base branch and the
   * key — never supplied by the test. That is what makes the resulting
   * assertions about `gh pr create` evidence about the prompt rather than about
   * the fixture: an agent that could only find one block opens one pull request,
   * which is precisely the failure the story is about.
   */
  perRepoPr?: { file: string };
  /**
   * Do what the prompt's THE-CARD-IS-WRONG branch tells a real agent to do
   * (MOTIR-3025, re-pointed by MOTIR-4083): read the key and the transition
   * instruction OUT OF THE PROMPT, move the card to `planning`, put the finding
   * on the planning thread and submit it — with the six-field WHAT composed from
   * the field names the prompt teaches — through the TOOLS the prompt names, and
   * exit 0.
   *
   * ⚠️ EVERYTHING COMES FROM THE PROMPT — the key, the status, the two tool
   * names, the project key, the anchor and the six field names — so an
   * assertion about what the card ends up at, or what reached the wire, is
   * evidence about the PROMPT, not about this fixture. An agent handed a prompt
   * with no re-plan branch (the `--disable-replan` case) finds no tool step and
   * correctly appends and submits nothing, which is exactly what that case has
   * to prove. The `finding` is put VERBATIM into every REQUIRED field and `""`
   * into every other, so a test can assert the wire carried it untruncated
   * without this fixture knowing a single field's name.
   */
  refuseCard?: { finding: string };
  /**
   * Do what the prompt's FOUND A DEFECT branch tells a real agent to do
   * (MOTIR-3025): file a `bug` under the parent the prompt NAMES, carrying a
   * reproduction and evidence, then carry on and finish its own card.
   *
   * Reads the parent key out of the prompt's `parentKey:` line, so a prompt that
   * named the wrong parent — or a run whose policy removed the branch entirely —
   * shows up as a bug in the wrong place, or no bug at all, rather than as this
   * fixture's own opinion.
   */
  fileBug?: { title: string; file?: string };
  /**
   * Answer the prompt's self-report line the way a real agent does (MOTIR-2419):
   * write `{"model": …}` at the path in `$MOTIR_AGENT_REPORT`. Omitted, the agent
   * writes nothing — the honest "I cannot tell", which must leave a null model.
   * `unbuildable` is the prompt's STOP step 4 (MOTIR-8698): the agent's reason
   * for stopping, which the CLI reports with the run's credential.
   */
  report?: { model?: string; unbuildable?: string };
}

export interface FakeAgent {
  /** The command line to pass as `--agent`. */
  command: string;
  /** Every invocation so far, in order. */
  invocations(): AgentInvocation[];
  /** Re-script the agent (the steps are consumed in order; the last one repeats). */
  script(steps: AgentStep[]): void;
}

/**
 * Write a scripted fake agent into `dir` and return its command line.
 *
 * It records what it was given and exits per the script — never an LLM, never a
 * network call (the acceptance criterion: "the fake agent never needs a real
 * LLM"). The `integrate` step is what makes a session-branch run REAL: the agent
 * commits on the session branch exactly as the prompt's GIT WORKFLOW section
 * tells a real one to, so the end-of-run push + pull request act on true commits.
 */
export function writeFakeAgent(dir: string): FakeAgent {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'fake-agent.mjs');
  const logPath = join(dir, 'agent-log.jsonl');
  const planPath = join(dir, 'agent-plan.json');

  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LOG = ${JSON.stringify(logPath)};
const PLAN = ${JSON.stringify(planPath)};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    // No stdin at all (or an immediate close) is a legitimate case — the prompt
    // is also on disk at $MOTIR_PROMPT_FILE.
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

const stdin = await readStdin();
const promptFile = process.env.MOTIR_PROMPT_FILE ?? null;
// The APPROVED DESIGN the run put on disk (MOTIR-5567). Recorded by LISTING it
// rather than by trusting the variable: a set variable pointing at an empty or
// missing directory is the exact failure the all-or-nothing rule forbids, and
// it is invisible to anything that only reads the environment.
const designDir = process.env.MOTIR_DESIGN_DIR ?? null;
function listDesign(root, prefix) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listDesign(join(root, entry.name), rel));
    else out.push(rel);
  }
  return out;
}
appendFileSync(
  LOG,
  JSON.stringify({
    cwd: process.cwd(),
    stdin,
    promptFile,
    promptFromFile: promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : null,
    designDir,
    designFiles: designDir ? listDesign(designDir, '').sort() : [],
    argv: process.argv.slice(2),
  }) + '\\n',
);

const plan = existsSync(PLAN) ? JSON.parse(readFileSync(PLAN, 'utf8')) : { steps: [] };
const index = readFileSync(LOG, 'utf8').trim().split('\\n').length - 1;
const steps = plan.steps ?? [];
const step = steps[index] ?? steps[steps.length - 1] ?? {};

if (step.create) mkdirSync(join(process.cwd(), step.create), { recursive: true });

if (step.report && process.env.MOTIR_AGENT_REPORT) {
  writeFileSync(process.env.MOTIR_AGENT_REPORT, JSON.stringify(step.report));
}

if (step.integrate) {
  const repo = process.cwd();
  // The branch comes from the PROMPT, exactly as a real agent reads it out of
  // the GIT WORKFLOW section — never from the test's own knowledge.
  const branch = (stdin.match(/motir\\/auto-[0-9]{8}-[0-9]{6}/) ?? [])[0];
  if (!branch) {
    process.stderr.write('fake-agent: no session branch in the prompt\\n');
    process.exit(9);
  }
  const git = (...args) => {
    const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (res.status !== 0) {
      process.stderr.write('fake-agent git ' + args.join(' ') + ': ' + (res.stderr || '') + '\\n');
    }
    return res;
  };
  git('fetch', 'origin');
  git('checkout', '-B', branch, 'origin/' + branch);
  writeFileSync(join(repo, step.integrate.file), 'work by the fake agent\\n');
  git('add', step.integrate.file);
  git('commit', '-m', 'feat: ' + step.integrate.file);
  git('push', 'origin', branch);
}

if (step.perRepoPr) {
  const text = (promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : stdin);
  // The prompt renders, per repository:
  //     <name>  (your working directory | a sibling checkout)
  //       1. cd <dir> && git fetch origin
  //       2. git worktree add <wt> -b <branch> origin/<base>
  // so a block is (dir, worktree, branch, base) and there is one per repository.
  const blocks = [];
  const lines = text.split('\\n');
  for (let i = 0; i < lines.length; i++) {
    const cd = lines[i].match(/^\\s*1\\. cd (\\S+) && git fetch origin$/);
    if (!cd) continue;
    const add = (lines[i + 1] ?? '').match(
      /^\\s*2\\. git worktree add (\\S+) -b (\\S+) origin\\/(\\S+)$/,
    );
    if (add) blocks.push({ dir: cd[1], wt: add[1], branch: add[2], base: add[3] });
  }
  if (blocks.length === 0) {
    // The SINGLE-repository grammar, which fuses the fetch and the worktree onto
    // one step and names no directory — the agent is already standing in it. The
    // same agent has to understand both shapes, or a test using it as the
    // one-repository CONTROL would be measuring the fixture rather than the
    // prompt.
    for (const line of lines) {
      const one = line.match(
        /^\\s*1\\. git fetch origin && git worktree add (\\S+) -b (\\S+) origin\\/(\\S+)$/,
      );
      if (one) blocks.push({ dir: '.', wt: one[1], branch: one[2], base: one[3] });
    }
  }
  const key = (text.match(/carries ([A-Z][A-Z0-9]*-\\d+)/) ?? [])[1] ?? 'UNKNOWN';
  if (blocks.length === 0) {
    process.stderr.write('fake-agent: no repository block in the prompt\\n');
    process.exit(9);
  }
  const run = (bin, args, cwd) => {
    const res = spawnSync(bin, args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) {
      process.stderr.write('fake-agent ' + bin + ' ' + args.join(' ') + ': ' + (res.stderr || '') + '\\n');
    }
    return res;
  };
  for (const b of blocks) {
    const repoDir = join(process.cwd(), b.dir);
    run('git', ['fetch', 'origin'], repoDir);
    run('git', ['worktree', 'add', b.wt, '-b', b.branch, 'origin/' + b.base], repoDir);
    const wtDir = join(repoDir, b.wt);
    if (!existsSync(wtDir)) {
      // The repository has no checkout to enter, so this half cannot happen here.
      // A real agent SAYS so and finishes the halves it can — it does not abort
      // the whole card — and the CLI's own suspect-dispatch report is what names
      // the repository afterwards. Crashing instead would make the fixture, not
      // the tool, decide what a half-delivered run looks like.
      process.stderr.write('fake-agent: skipped ' + b.dir + ' — no checkout to work in\\n');
      continue;
    }
    writeFileSync(join(wtDir, step.perRepoPr.file), 'work by the fake agent\\n');
    run('git', ['add', step.perRepoPr.file], wtDir);
    run('git', ['commit', '-m', 'feat: ' + step.perRepoPr.file + ' (' + key + ')'], wtDir);
    run('git', ['push', 'origin', b.branch], wtDir);
    run(
      'gh',
      [
        'pr', 'create',
        '--head', b.branch,
        '--base', b.base,
        '--title', 'feat: the work (' + key + ')',
        '--body', 'Opened by the fake agent for ' + key + '.',
      ],
      wtDir,
    );
  }
}

// ── the FINDINGS branches (MOTIR-3025) ──────────────────────────────────────
// Both read the PROMPT and do what it says. The API base and the token come
// from the environment the CLI itself was configured with, because that is what
// a real dispatched agent has.
const promptText = (promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : stdin);

async function api(path, init) {
  const base = process.env.MOTIR_FAKE_AGENT_SERVER;
  const token = process.env.MOTIR_FAKE_AGENT_TOKEN;
  if (!base || !token) {
    process.stderr.write('fake-agent: no server/token in the environment' + '\\n');
    process.exit(9);
  }
  const res = await fetch(base + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
  });
  // A real agent would read the refusal and say so; a fixture that swallowed it
  // would make a missing write look like a policy that was switched off, which
  // is the one thing these tests must be able to tell apart.
  if (!res.ok) {
    const body = await res.text();
    process.stderr.write('fake-agent: ' + path + ' -> ' + res.status + ' ' + body + '\\n');
  }
  return res;
}

if (step.refuseCard) {
  // The key, as the prompt's own header states it.
  const key = (promptText.match(/executing \\w+ ([A-Z][A-Z0-9]*-\\d+)/) ?? promptText.match(/([A-Z][A-Z0-9]*-\\d+)/) ?? [])[1];
  if (!key) {
    process.stderr.write('fake-agent: no work item key in the prompt\\\n');
    process.exit(9);
  }
  // Step 3 of the branch, always present: comment the finding.
  await api('/api/v1/work-items/' + key + '/comments', {
    method: 'POST',
    body: JSON.stringify({ bodyMd: step.refuseCard.finding }),
  });
  // ⚠️ ONLY IF THE PROMPT SAYS SO. A run launched with --disable-replan renders
  // no 'status planning' step and no submit line; an agent reading that prompt
  // leaves the card In Progress, which is what the disabled case must show.
  if (/status planning/.test(promptText)) {
    await api('/api/v1/work-items/' + key + '/transitions', {
      method: 'POST',
      body: JSON.stringify({ status: 'planning' }),
    });
  }
  // Steps 5 and 6 (MOTIR-4083): the two plan-session TOOLS, exactly as the
  // prompt spells them — the tool names, the project key, the anchor and the
  // six field names are all read OUT of the text. A prompt whose policy removed
  // the branch names no tool, so nothing is appended and nothing is submitted.
  const appendStep = promptText.match(
    /with the (append_plan_turn) tool:\\n\\n\\s+projectKey:\\s+(\\S+)\\n\\s+targetKeys:\\s+\\[([A-Z][A-Z0-9]*-\\d+)\\]/,
  );
  const submitStep = promptText.match(
    /with the (submit_plan_session) tool:\\n\\n\\s+projectKey:\\s+(\\S+)\\n\\s+targetKeys:\\s+\\[([A-Z][A-Z0-9]*-\\d+)\\]/,
  );
  if (appendStep && submitStep) {
    // The requirement's fields, in the order the prompt lists them under
    // requirement: — a name at the block's indent, REQUIRED or not. The
    // continuation lines sit deeper and the list ends at the first blank line.
    const fields = [];
    const from = promptText.indexOf('requirement: six named fields');
    for (const line of promptText.slice(from).split('\\n').slice(1)) {
      if (line.trim() === '') break;
      const m = line.match(/^ {11}([A-Za-z]+) {2,}(REQUIRED)?/);
      if (m) fields.push({ name: m[1], required: !!m[2] });
    }
    const requirement = {};
    for (const f of fields) requirement[f.name] = f.required ? step.refuseCard.finding : '';
    // One JSON-RPC call per tool, the way an MCP client makes it — and a
    // refusal is fatal here, for the same reason as on the v1 calls above.
    async function tool(name, args) {
      const res = await api('/api/mcp', {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await res.text();
      const data = text.split('\\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() ?? text;
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = { error: { message: text.slice(0, 500) } }; }
      if (parsed.error || (parsed.result && parsed.result.isError)) {
        process.stderr.write('fake-agent: ' + name + ' refused: ' + JSON.stringify(parsed).slice(0, 800) + '\\n');
        process.exit(9);
      }
      return parsed.result;
    }
    await tool(appendStep[1], {
      projectKey: appendStep[2],
      targetKeys: [appendStep[3]],
      body: step.refuseCard.finding,
    });
    await tool(submitStep[1], {
      projectKey: submitStep[2],
      targetKeys: [submitStep[3]],
      requirement,
    });
  }
}

if (step.fileBug) {
  // ⚠️ THE PARENT COMES FROM THE PROMPT, which names it outright. A prompt with
  // no FOUND A DEFECT branch has no 'parentKey:' line, so this files nothing —
  // the absence the --disable-log-bug case has to prove.
  const parent = (promptText.match(/parentKey: ([A-Z][A-Z0-9]*-\\d+)/) ?? [])[1];
  const key = (promptText.match(/executing \\w+ ([A-Z][A-Z0-9]*-\\d+)/) ?? [])[1];
  if (parent) {
    await api('/api/v1/projects/' + parent.split('-')[0] + '/work-items', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'bug',
        title: step.fileBug.title,
        parentKey: parent,
        descriptionMd: [
          '## Reproduction',
          'Open the surface named above and repeat the action.',
          '## Evidence',
          'The command pnpm vitest run tests/x.test.ts printed 1 failed.',
          '## Seen on',
          (key ?? 'the card in flight') + ', on the branch this run worked in.',
        ].join('\\n'),
      }),
    });
  }
  if (step.fileBug.file) {
    writeFileSync(join(process.cwd(), step.fileBug.file), 'work by the fake agent\\\n');
  }
}

process.exit(step.exit ?? 0);
`,
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);
  writeFileSync(planPath, JSON.stringify({ steps: [{ exit: 0 }] }));

  return {
    command: `${process.execPath} ${script}`,
    invocations: () =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as AgentInvocation)
        : [],
    script: (steps) => writeFileSync(planPath, JSON.stringify({ steps })),
  };
}

// ── the fake `gh` ───────────────────────────────────────────────────────────

export interface GhInvocation {
  args: string[];
  cwd: string;
}

export interface FakeGh {
  /** Every `gh` call the CLI made, in order. */
  invocations(): GhInvocation[];
  /** Just the `gh pr create` calls, parsed into their flags. */
  pullRequests(): { head: string; base: string; title: string; body: string; cwd: string }[];
}

/**
 * Install a fake `gh` on the workspace's PATH.
 *
 * `motir auto` opens the session pull request by shelling out to `gh` (git.ts).
 * A CI runner has no authenticated `gh`, and a test must never open a real pull
 * request — so this records the invocation and answers as GitHub would: no open
 * PR for a fresh branch (`pr list` prints nothing), a URL from `pr create`.
 * Recording is what lets the suite assert ONE pull request per touched repo, its
 * title and body, and — the no-auto-merge invariant — that `pr merge` was never
 * called at all.
 */
export function installFakeGh(binDir: string): FakeGh {
  mkdirSync(binDir, { recursive: true });
  const logPath = join(binDir, 'gh-log.jsonl');
  const script = join(binDir, 'gh');
  const statePath = join(binDir, 'gh-prs.json');
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
// ⚠️ THIS FAKE REMEMBERS (MOTIR-3681). \`motir auto\` now opens each repository's
// pull request at its FIRST implemented card and calls \`openSessionPr\` again on
// every card after it — which lists before creating, so the real \`gh\` answers
// with the pull request that already exists. A fake whose \`pr list\` always
// printed nothing made the CLI create one per card, and every assertion counting
// them was measuring the fake's amnesia.
//
// Keyed by CWD + head, never head alone: a multi-repository run uses ONE branch
// name in EVERY checkout, and the real \`gh\` answers per repository because it
// runs in one.
const stateFile = ${JSON.stringify(statePath)};
const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const keyOf = () => process.cwd() + '\\u0000' + (args[args.indexOf('--head') + 1] ?? '');
if (args[0] === 'pr' && args[1] === 'list') {
  const url = readState()[keyOf()]?.url;
  if (url) process.stdout.write(url + '\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const state = readState();
  const head = args[args.indexOf('--head') + 1] ?? 'branch';
  const url = 'https://github.test/motir/pull/1?head=' + head;
  state[keyOf()] = { url, branch: head };
  writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(url + '\\n');
  process.exit(0);
}
// \`gh pr edit <branch> --title … --body …\` — the close-out rewriting what the
// early open could not know. Recorded like every other call; \`pullRequests()\`
// folds it over the create so an assertion reads the FINAL text.
if (args[0] === 'pr' && args[1] === 'edit') process.exit(0);
process.stderr.write('fake gh: unsupported command ' + args.join(' ') + '\\n');
process.exit(1);
`,
    { mode: 0o755 },
  );
  chmodSync(script, 0o755);

  const invocations = (): GhInvocation[] =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as GhInvocation)
      : [];

  return {
    invocations,
    /**
     * One entry per pull request CREATED, carrying the LATEST title and body —
     * a later `gh pr edit` on the same branch is folded over the create
     * (MOTIR-3681).
     *
     * ⚠️ Folding is what keeps these assertions about what a REVIEWER sees. The
     * pull request is opened at the first implemented card, so its created title
     * and body describe one card; the close-out rewrites both from the whole
     * run. Reading only the create would assert the thin early text and call the
     * finished one a regression.
     */
    pullRequests: () => {
      const byBranch = new Map<
        string,
        { head: string; base: string; title: string; body: string; cwd: string }
      >();
      for (const call of invocations()) {
        if (call.args[0] !== 'pr') continue;
        if (call.args[1] === 'create') {
          byBranch.set(`${call.cwd}\u0000${valueOf(call.args, '--head')}`, {
            head: valueOf(call.args, '--head'),
            base: valueOf(call.args, '--base'),
            title: valueOf(call.args, '--title'),
            body: valueOf(call.args, '--body'),
            cwd: call.cwd,
          });
        } else if (call.args[1] === 'edit') {
          // `gh pr edit <branch> --title … --body …`
          const existing = byBranch.get(`${call.cwd}\u0000${call.args[2] ?? ''}`);
          if (existing) {
            existing.title = valueOf(call.args, '--title');
            existing.body = valueOf(call.args, '--body');
          }
        }
      }
      return [...byBranch.values()];
    },
  };
}

function valueOf(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

// ── git checkouts ───────────────────────────────────────────────────────────

/** Run git in `cwd`, throwing on failure (a broken fixture must not read as a
 *  CLI bug). */
export function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, env: gitEnv() });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${res.stderr || res.stdout}`);
  }
  return (res.stdout ?? '').trim();
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Motir Test',
    GIT_AUTHOR_EMAIL: 'test@motir.invalid',
    GIT_COMMITTER_NAME: 'Motir Test',
    GIT_COMMITTER_EMAIL: 'test@motir.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

export interface LocalRepo {
  /** The working checkout — where the CLI routes the agent. */
  path: string;
  /** The bare repo standing in for `origin`. */
  originPath: string;
  /** The commit `main` points at on origin, for the no-auto-merge assertion. */
  originMain(): string;
  /** Whether a branch exists on origin. */
  hasBranchOnOrigin(branch: string): boolean;
}

/**
 * Create `<root>/<name>` as a real git checkout of a real (bare, on-disk)
 * `origin`.
 *
 * Real git, not a stub: `motir auto` creates the session branch by pushing
 * `origin/main` to a new ref, the fake agent commits and pushes onto it, and the
 * close-out pushes anything left — assertions about that are only worth
 * anything against a genuine repository.
 */
export function makeLocalRepo(root: string, name: string): LocalRepo {
  const originPath = join(root, '.origins', `${name}.git`);
  const path = join(root, name);
  mkdirSync(dirname(originPath), { recursive: true });
  git(root, 'init', '--bare', '--initial-branch=main', originPath);
  git(root, 'clone', originPath, path);
  writeFileSync(join(path, 'README.md'), `# ${name}\n`);
  git(path, 'add', 'README.md');
  git(path, 'commit', '-m', 'chore: initial commit');
  git(path, 'push', 'origin', 'main');
  return {
    path,
    originPath,
    originMain: () => git(originPath, 'rev-parse', 'refs/heads/main'),
    hasBranchOnOrigin: (branch) => {
      const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: originPath,
        encoding: 'utf8',
        env: gitEnv(),
      });
      return res.status === 0;
    },
  };
}

/** Write a `.motir.json` by hand — for the cases that need a link the CLI's own
 *  `motir link` cannot make (a stale project, a repo override). */
export function writeLinkFile(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, '.motir.json'), JSON.stringify(config, null, 2) + '\n');
}

/** Read a workspace's `.motir.json` back. */
export function readLinkFile(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.motir.json'), 'utf8')) as Record<string, unknown>;
}
