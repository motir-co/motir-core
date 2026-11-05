import { isMotirFleetJob, MOTIR_RUNNER_VARIABLE } from './config';
import {
  scriptCommands,
  type ActionMetadata,
  type WorkflowJob,
  type WorkflowSet,
  type WorkflowStep,
} from './workflowJobs';

// CAN THE PINNED RUNNER IMAGE RUN THIS JOB? (MOTIR-10290)
//
// A job is judged from its own steps, in order, against the tool list the
// pinned runner image records about itself (`runnerImageTools.ts`):
//
//   * a `run:` body needs its shell's interpreter and every executable it names
//     at the head of a command (`workflowJobs.ts` `scriptCommands`);
//   * a JavaScript action needs nothing of the image — the runner brings its own
//     Node for actions; a Docker action, a `docker://` step, a `container:` job
//     and `services:` need `docker`;
//   * a composite action is judged by ITS steps, read from its `action.yml`
//     (the repository's own under `.github/actions/`, or the remote one at its
//     ref), recursively;
//   * a tool an EARLIER step put on PATH is not needed of the image: a known
//     setup action (`SETUP_ACTION_TOOLS`) or an install command
//     (`pipx install ruff`) provides it to every step after it.
//
// ⚠️ FAILS CLOSED. What cannot be judged is never runnable: a command whose name
// is computed (`$PYTHON`), a `uses:` whose reference is an expression, an action
// with no `action.yml`, an action kind the judge does not know, a remote
// reusable workflow, composite actions nested deeper than `MAX_ACTION_DEPTH`, a
// workflow file that is not valid YAML. Each is `unverified`, and the condition
// it feeds is unmet, naming the job and what could not be judged.
//
// A tool a job installs some way this file does not recognise reads as MISSING —
// the same direction: the page names the job and the tool, and either the image
// gains the tool or the step is made recognisable.

/**
 * What a well-known SETUP action puts on PATH for the steps after it. A table of
 * PUBLIC actions' behaviour — not a snapshot of any repository — and the only
 * hand-kept list on this path: an action missing from it costs a named tool
 * reading as missing, never a job wrongly called runnable.
 */
export const SETUP_ACTION_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'actions/setup-node': ['node', 'npm', 'npx', 'corepack'],
  'pnpm/action-setup': ['pnpm', 'pnpx'],
  'actions/setup-python': ['python', 'python3', 'pip', 'pip3'],
  'actions/setup-go': ['go', 'gofmt'],
  'actions/setup-java': ['java', 'javac', 'jar', 'keytool'],
  'actions/setup-dotnet': ['dotnet'],
  'superfly/flyctl-actions/setup-flyctl': ['flyctl', 'fly'],
  'astral-sh/setup-uv': ['uv', 'uvx'],
  'hashicorp/setup-terraform': ['terraform'],
  'oven-sh/setup-bun': ['bun', 'bunx'],
  'denoland/setup-deno': ['deno'],
  'dtolnay/rust-toolchain': ['cargo', 'rustc', 'rustup', 'rustfmt'],
  'azure/setup-helm': ['helm'],
  'azure/setup-kubectl': ['kubectl'],
};

/** How deep composite actions are followed before the job is `unverified`. */
export const MAX_ACTION_DEPTH = 4;

/** Does this `runs-on` request the Motir fleet? A job that follows the switch
 *  (`${{ vars.MOTIR_RUNNER || … }}`) or names the fleet label (MOTIR-8813). */
export function requestsFleetRunner(runsOn: unknown): boolean {
  if (typeof runsOn === 'string') {
    return runsOn.includes(`vars.${MOTIR_RUNNER_VARIABLE}`) || isMotirFleetJob([runsOn]);
  }
  if (Array.isArray(runsOn)) return runsOn.some(requestsFleetRunner);
  if (runsOn !== null && typeof runsOn === 'object' && 'labels' in runsOn) {
    return requestsFleetRunner((runsOn as { labels: unknown }).labels);
  }
  return false;
}

/** A `uses:` reference, classified. */
export type ActionRef =
  | { kind: 'local'; path: string }
  | { kind: 'docker'; image: string }
  | { kind: 'remote'; owner: string; repo: string; path: string; ref: string; name: string }
  | { kind: 'dynamic'; uses: string };

export function parseActionRef(uses: string): ActionRef {
  const trimmed = uses.trim();
  if (trimmed.includes('${{')) return { kind: 'dynamic', uses: trimmed };
  if (trimmed.startsWith('docker://')) return { kind: 'docker', image: trimmed.slice(9) };
  if (trimmed.startsWith('./')) {
    return { kind: 'local', path: trimmed.slice(2).replace(/\/+$/, '') };
  }
  const at = trimmed.lastIndexOf('@');
  const name = at > 0 ? trimmed.slice(0, at) : trimmed;
  const ref = at > 0 ? trimmed.slice(at + 1) : '';
  const [owner, repo, ...rest] = name.split('/');
  if (!owner || !repo || !ref) return { kind: 'dynamic', uses: trimmed };
  return { kind: 'remote', owner, repo, path: rest.join('/'), ref, name: name.toLowerCase() };
}

/** The key a remote action's metadata is looked up by: `owner/repo[/path]@ref`. */
export function remoteActionKey(ref: Extract<ActionRef, { kind: 'remote' }>): string {
  return `${ref.name}@${ref.ref}`;
}

/** A remote action's metadata: parsed, `absent` (no `action.yml` at that ref),
 *  or undefined — not read yet. */
export type ActionLookup = (key: string) => ActionMetadata | 'absent' | undefined;

/** The verdict on one job. */
export interface JobJudgement {
  workflow: string;
  jobId: string;
  runsOn: unknown;
  /**
   * `github-hosted` — the job never requests the fleet, so it is not judged;
   * `runnable` — every step's needs are met by the image or an earlier step;
   * `needs-image` — it needs a tool the image lacks (`missing`);
   * `cannot-host` — it asks for another operating system;
   * `unverified` — something in it cannot be judged (`unjudged`).
   */
  verdict: 'github-hosted' | 'runnable' | 'needs-image' | 'cannot-host' | 'unverified';
  /** Tools the job needs that neither the image nor an earlier step provides. */
  missing: string[];
  /** What could not be judged, in a few words each. */
  unjudged: string[];
}

interface Walk {
  tools: ReadonlySet<string>;
  lookup: ActionLookup;
  localActions: WorkflowSet['localActions'];
  provided: Set<string>;
  missing: Set<string>;
  unjudged: Set<string>;
}

const need = (walk: Walk, tool: string) => {
  if (!walk.tools.has(tool) && !walk.provided.has(tool)) walk.missing.add(tool);
};

/**
 * Builtins every POSIX shell has, so a shell body needs nothing more of the image
 * for them. The image's tool list cannot hold them: `list-tools.sh` keeps only
 * names that start with a letter, a digit or `_`.
 */
const PUNCTUATION_BUILTINS = new Set(['[', ':', '.']);

/** The executable a `shell:` names: `bash`, `python3` for `python3 {0}`, … */
function shellInterpreter(shell: string | null): string {
  if (shell === null) return 'bash';
  const first = shell.trim().split(/\s+/)[0] ?? 'bash';
  return first.slice(first.lastIndexOf('/') + 1);
}

function judgeRun(walk: Walk, step: Extract<WorkflowStep, { kind: 'run' }>): void {
  const interpreter = shellInterpreter(step.shell);
  need(walk, interpreter);
  // Only a POSIX shell body is read as commands; a `python3 {0}` body is code
  // for its interpreter, which is all it needs.
  if (!/^(ba|da|z)?sh$/.test(interpreter)) return;
  const read = scriptCommands(step.script);
  // An install in this body serves the commands after it in the same body too.
  for (const tool of read.installs) walk.provided.add(tool);
  for (const tool of read.commands) {
    if (!PUNCTUATION_BUILTINS.has(tool)) need(walk, tool);
  }
  for (const word of read.dynamic) walk.unjudged.add(`the computed command ${word}`);
}

function judgeAction(walk: Walk, meta: ActionMetadata, label: string, depth: number): void {
  if (meta.using === 'node') return;
  if (meta.using === 'docker') return need(walk, 'docker');
  if (meta.using === 'composite') {
    if (depth >= MAX_ACTION_DEPTH) {
      walk.unjudged.add(`${label}, nested more than ${MAX_ACTION_DEPTH} composite actions deep`);
      return;
    }
    return judgeSteps(walk, meta.steps, depth + 1);
  }
  walk.unjudged.add(`${label}, whose action kind is not known`);
}

function judgeUses(walk: Walk, uses: string, depth: number): void {
  const ref = parseActionRef(uses);
  switch (ref.kind) {
    case 'dynamic':
      walk.unjudged.add(`the computed action ${ref.uses}`);
      return;
    case 'docker':
      return need(walk, 'docker');
    case 'local': {
      const meta = walk.localActions.get(ref.path);
      if (!meta) {
        walk.unjudged.add(`./${ref.path}, which has no action.yml`);
        return;
      }
      return judgeAction(walk, meta, `./${ref.path}`, depth);
    }
    case 'remote': {
      const key = remoteActionKey(ref);
      const meta = walk.lookup(key);
      if (meta === undefined) {
        walk.unjudged.add(`${key}, which was not read`);
        return;
      }
      if (meta === 'absent') {
        walk.unjudged.add(`${key}, which has no action.yml`);
        return;
      }
      judgeAction(walk, meta, key, depth);
      for (const tool of SETUP_ACTION_TOOLS[ref.name] ?? []) walk.provided.add(tool);
      return;
    }
  }
}

function judgeSteps(walk: Walk, steps: WorkflowStep[], depth: number): void {
  for (const step of steps) {
    if (step.kind === 'run') judgeRun(walk, step);
    else judgeUses(walk, step.uses, depth);
  }
}

/** A runner label for another operating system — the fleet runs Linux only. */
function otherOs(runsOn: unknown): string | null {
  const labels = JSON.stringify(runsOn ?? null).toLowerCase();
  const match = /\b(macos|windows)[\w.-]*/.exec(labels);
  return match ? match[0] : null;
}

/** Judge one job. Pure. */
export function judgeJob(
  job: WorkflowJob,
  tools: ReadonlySet<string>,
  lookup: ActionLookup,
  localActions: WorkflowSet['localActions'],
): JobJudgement {
  const base = { workflow: job.workflow, jobId: job.jobId, runsOn: job.runsOn };
  if (job.calls !== null) {
    // A LOCAL reusable workflow's jobs are this repository's own and are judged
    // where they are defined; a caller job runs nothing itself. A REMOTE one is
    // another repository's, which this check does not read.
    if (job.calls.startsWith('./')) {
      return { ...base, verdict: 'github-hosted', missing: [], unjudged: [] };
    }
    return {
      ...base,
      verdict: 'unverified',
      missing: [],
      unjudged: [`the reusable workflow ${job.calls}, in another repository`],
    };
  }
  if (!requestsFleetRunner(job.runsOn)) {
    return { ...base, verdict: 'github-hosted', missing: [], unjudged: [] };
  }
  const os = otherOs(job.runsOn);
  if (os) {
    return { ...base, verdict: 'cannot-host', missing: [], unjudged: [`it asks for ${os}`] };
  }
  const walk: Walk = {
    tools,
    lookup,
    localActions,
    provided: new Set(),
    missing: new Set(),
    unjudged: new Set(),
  };
  if (job.container || job.services) need(walk, 'docker');
  if (job.container) {
    // The steps run inside the job's own container image, which this check does
    // not read; the runner image needs only to start it. Its actions are still
    // read for what they need of Docker.
    for (const step of job.steps) {
      if (step.kind === 'uses' && parseActionRef(step.uses).kind === 'dynamic') {
        walk.unjudged.add(`the computed action ${step.uses}`);
      }
    }
  } else {
    judgeSteps(walk, job.steps, 0);
  }
  const missing = [...walk.missing].sort();
  const unjudged = [...walk.unjudged].sort();
  const verdict =
    unjudged.length > 0 ? 'unverified' : missing.length > 0 ? 'needs-image' : 'runnable';
  return { ...base, verdict, missing, unjudged };
}

/** Judge every job of a repository, plus one `unverified` row per workflow file
 *  that is not valid YAML. Pure. */
export function judgeWorkflows(
  set: WorkflowSet,
  tools: ReadonlySet<string>,
  lookup: ActionLookup,
): JobJudgement[] {
  const judged = set.jobs.map((job) => judgeJob(job, tools, lookup, set.localActions));
  for (const path of set.invalid) {
    if (path.startsWith('.github/actions/')) continue; // reported where it is used
    judged.push({
      workflow: path,
      jobId: '*',
      runsOn: null,
      verdict: 'unverified',
      missing: [],
      unjudged: ['the workflow file is not valid YAML'],
    });
  }
  return judged;
}

/**
 * The remote actions the fleet jobs of `set` use that `lookup` has not answered
 * yet — including those inside composite actions already read. The caller reads
 * them and asks again until this is empty (each round goes one level deeper).
 */
export function remoteActionsToRead(
  set: WorkflowSet,
  lookup: ActionLookup,
): Array<Extract<ActionRef, { kind: 'remote' }>> {
  const wanted = new Map<string, Extract<ActionRef, { kind: 'remote' }>>();
  const seen = new Set<string>();
  const visit = (steps: WorkflowStep[], depth: number) => {
    if (depth > MAX_ACTION_DEPTH) return;
    for (const step of steps) {
      if (step.kind !== 'uses') continue;
      const ref = parseActionRef(step.uses);
      if (ref.kind === 'local') {
        const meta = set.localActions.get(ref.path);
        if (meta && !seen.has(`./${ref.path}`)) {
          seen.add(`./${ref.path}`);
          visit(meta.steps, depth + 1);
        }
      } else if (ref.kind === 'remote') {
        const key = remoteActionKey(ref);
        const meta = lookup(key);
        if (meta === undefined) wanted.set(key, ref);
        else if (meta !== 'absent' && !seen.has(key)) {
          seen.add(key);
          visit(meta.steps, depth + 1);
        }
      }
    }
  };
  for (const job of set.jobs) {
    if (job.calls === null && !job.container && requestsFleetRunner(job.runsOn)) {
      visit(job.steps, 0);
    }
  }
  return [...wanted.values()];
}
