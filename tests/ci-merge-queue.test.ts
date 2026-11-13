import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-4050 — the merge queue, and the half of it that lives in this
// repository.
//
// The control has two halves and only one of them is a file. GitHub's side is
// the `merge_queue` rule on ruleset 17227448, which nothing here can read; this
// side is `ci.yml`, and the two are useless apart. The failure modes that
// follow from getting THIS half wrong are all silent, which is why they are
// asserted rather than reviewed:
//
//   1. NO `merge_group:` TRIGGER. `protect-main` requires `CI complete`, and a
//      queue entry waits for that context to report against the
//      `gh-readonly-queue/main/pr-<n>-<sha>` branch. A workflow that does not
//      run on `merge_group` never reports it, the entry times out on
//      `check_response_timeout_minutes`, and the pull request is ejected with no
//      failing check to explain why. Nothing goes red — merges just stop.
//   2. THE MATRIX LEFT THE PUSH LANE AND DID NOT ARRIVE IN THE QUEUE. The whole
//      trade is that `main` stops re-running what the queue ran. If a job is
//      gated off `push` and is not reachable on `merge_group` either, it has
//      quietly stopped being a gate anywhere, and every check still reports
//      green.
//   3. THE PUSH LANE STOPS BEING A TRIPWIRE. Ruleset 17227448 has a bypass
//      actor, so a merge can reach `main` without passing any queue, and the
//      push run's `lint` / `typecheck` / `build` are all that verify it. This
//      used to be phrased through the Fly `deploy` job that needed them; that
//      job is gone (MOTIR-10935) and the release ships through `aws-deploy.yml`,
//      so the property is now asserted on the tripwire jobs themselves — and on
//      this workflow releasing nothing.
//
// Read as text, not by running it: workflow YAML is neither type-checked nor
// linted by any suite (the premise `tests/ci-complete-gate.test.ts` shares,
// and the same no-YAML-dependency constraint — the repo has no YAML parser).
//
// ⚠️ The `if:` expressions are RESOLVED against a fabricated `github` context
// rather than matched as strings, for the reason MOTIR-4095 recorded in the
// acceptance lane: reachability is arithmetic, not structure, and a regex that
// agrees with `!= 'push'` agrees just as happily with an expression that means
// the opposite. The evaluator below throws on any construct it does not
// implement, so it cannot go green by returning `undefined`.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const ci = readFileSync(CI_PATH, 'utf8');

/** Split the `jobs:` mapping into { jobId → body }. Job ids sit at two spaces. */
function jobsOf(yaml: string): Map<string, string> {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string>();
  if (jobsAt === -1) return jobs;
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.set(current, body.join('\n'));
      current = header[1]!;
      body = [];
      continue;
    }
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    body.push(line);
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/** The same text with whole-line comments dropped — a job's prose describes its
 *  neighbours, and every assertion here is about what a job DOES. */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
// ── THE ACCEPTANCE LANE IS IN THE QUEUE TOO (MOTIR-4257) ────────────────────
//
// It is a SECOND workflow with the same two-part contract, and it had neither
// half: no `merge_group:` trigger and no required context. So a change that
// touched none of its `pull_request` paths — `e055b6b23` (#2530) making the
// rail's Docs row conditional — ran no acceptance check, passed the queue, and
// turned the `push: main` baseline red. A merge queue exists so that cannot
// happen; a lane outside it is a lane that can break the trunk by construction.
const ACCEPTANCE_PATH = join(process.cwd(), '.github/workflows/acceptance-tests.yml');
const acceptance = readFileSync(ACCEPTANCE_PATH, 'utf8');
const acceptanceJobs = jobsOf(acceptance);
const acceptanceHeader = codeOf(acceptance.split(/^jobs:\s*$/m)[0] ?? '');
const jobCode = (id: string): string => codeOf(ciJobs.get(id) ?? '');
const header = codeOf(ci.split(/^jobs:\s*$/m)[0] ?? '');

/**
 * The same two reads, against ANY of the repo's workflows (MOTIR-4257) — the
 * acceptance lane is a second file with the same contract, so the parser is
 * pointed at it rather than copied for it.
 */
function jobIfIn(source: string, id: string): string | null {
  const m = /^ {4}if:(.*)$/m.exec(codeOf(jobsOf(source).get(id) ?? ''));
  return m ? m[1]!.trim() : null;
}

/** A job's `needs:`, from either the inline-array or the block form. */
function needsOfIn(source: string, id: string): Set<string> {
  const code = codeOf(jobsOf(source).get(id) ?? '');
  const inline = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(code);
  if (inline) {
    return new Set(
      inline[1]!
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    );
  }
  const block = /^ {4}needs:\s*\n((?: {6}- .*\n)+)/m.exec(code);
  return new Set(
    (block?.[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^ {6}- /, '').trim())
      .filter(Boolean),
  );
}

/** The JOB-level `if:` — four spaces exactly (`jobs:` → id → key). */
function jobIf(id: string): string | null {
  const m = /^ {4}if:(.*)$/m.exec(jobCode(id));
  return m ? m[1]!.trim() : null;
}

/** `needs:` entries in either YAML form. */
function declaredNeeds(id: string): string[] {
  const code = jobCode(id);
  const flow = /needs:\s*\[([^\]]*)\]/.exec(code);
  if (flow) {
    return flow[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const block = /needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/.exec(code);
  if (block) return [...block[1]!.matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  return [];
}

type Event = 'pull_request' | 'merge_group' | 'push';

/**
 * A fabricated context per event. Two values are chosen rather than obvious and
 * both are the CONSERVATIVE choice — they make a job MORE likely to look
 * reachable, so a job this evaluator calls unreachable really is:
 *
 *   • `needs.changes.outputs.*` is `'true'` for every event, because that is
 *     what the `changes` job actually emits: it fails open on anything that is
 *     not a pull request, and on a pull request the interesting case is the one
 *     where the diff DOES touch app code.
 *   • the at-scale LABEL is absent, because the property under test is what an
 *     ORDINARY pull request and an ordinary queue entry run. A label can only
 *     add lanes.
 */
const contextFor = (event: Event): Record<string, string> => ({
  'github.event_name': event,
  // A READY pull request: this file asks what an ordinary pull request and queue
  // entry reach, and a draft is the one state in which a pull request skips it.
  'github.event.pull_request.draft': 'false',
  'github.ref': event === 'push' ? 'refs/heads/main' : 'refs/pull/1/merge',
  'needs.changes.outputs.app': 'true',
  'needs.changes.outputs.images': 'true',
  // The package lanes' flags (MOTIR-5323), `'true'` for the same reason.
  'needs.changes.outputs.pkg_cli': 'true',
  'needs.changes.outputs.pkg_orchestrator': 'true',
  'needs.changes.outputs.pkg_design_system': 'true',
  'needs.changes.outputs.pkg_pages': 'true',
});

/**
 * Resolve one workflow expression to a boolean. Implements exactly the
 * constructs this file's job-level conditions use — `&&`, `||`, parentheses,
 * `==`/`!=` against a single-quoted literal, `contains(<labels>, '<literal>')`,
 * and a bare context lookup — and throws on anything else.
 */
function evaluate(expression: string, github: Record<string, string>): boolean {
  const body = expression
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
  const tokens = body.match(/\(|\)|,|&&|\|\||==|!=|'[^']*'|[A-Za-z0-9_.*[\]-]+/g);
  if (!tokens) throw new Error(`unreadable workflow expression: ${expression}`);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (expected?: string): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`expression ended early: ${expression}`);
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected \`${expected}\`, found \`${token}\` in: ${expression}`);
    }
    return token;
  };

  /** A literal, or a context path this evaluator knows. Unknown paths throw. */
  const value = (token: string): string => {
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === 'false' || token === 'true') return token;
    if (token in github) return github[token]!;
    // `github.event.pull_request.labels.*.name` is the only unfabricated path,
    // and it is handled by `contains` below — anything else reaching here is a
    // context this guard has never been told how to read.
    throw new Error(`unknown context \`${token}\` in: ${expression}`);
  };

  function primary(): boolean {
    if (peek() === '(') {
      take('(');
      const inner = or();
      take(')');
      return inner;
    }
    const first = take();
    if (first === 'always') {
      take('(');
      take(')');
      // For REACHABILITY, `always()` is unconditional. It says something else
      // about failed needs, which no assertion here reads.
      return true;
    }
    if (first === 'contains') {
      take('(');
      const haystack = take();
      take(',');
      const needle = take();
      take(')');
      if (haystack !== 'github.event.pull_request.labels.*.name') {
        throw new Error(`\`contains\` over an unmodelled collection: ${haystack}`);
      }
      // No labels in the fabricated context — see `contextFor`.
      void needle;
      return false;
    }
    const operator = peek();
    if (operator !== '==' && operator !== '!=') {
      throw new Error(`bare value \`${first}\` used as a condition in: ${expression}`);
    }
    take();
    const right = take();
    return operator === '==' ? value(first) === value(right) : value(first) !== value(right);
  }

  function and(): boolean {
    let left = primary();
    while (peek() === '&&') {
      take();
      const right = primary();
      left = left && right;
    }
    return left;
  }

  function or(): boolean {
    let left = and();
    while (peek() === '||') {
      take();
      const right = or();
      left = left || right;
    }
    return left;
  }

  const result = or();
  if (at !== tokens.length) throw new Error(`trailing tokens in: ${expression}`);
  return result;
}

/** Does this job run, for this event? A job with no `if:` always runs. */
function runsOn(id: string, event: Event): boolean {
  const condition = jobIf(id);
  if (condition === null) return true;
  return evaluate(condition, contextFor(event));
}

/**
 * The full gate — every job that verifies the change itself. This is the set
 * that used to run twice, on the pull request and again on the push, and now
 * runs on the pull request and in the QUEUE.
 */
const MATRIX = ['lint', 'typecheck', 'structural-guards', 'build', 'test', 'coverage', 'e2e'];
/** Gated off the pull-request lane by MOTIR-3148 — the queue is its only run. */
const QUEUE_ONLY = ['e2e-at-scale'];
/**
 * What a push still runs: the tripwire a BYPASSED merge would meet. All of it is
 * cheap and none of it is serial — the longest is `lint` at ~4 minutes and the
 * rest finish inside that — so the lane's length is set by one job, not seven.
 */
const PUSH_LANE = [
  'lint',
  'typecheck',
  'structural-guards',
  'design-system',
  'design-guards',
  'cli',
  // The third package lane (MOTIR-4299), here for the same reason its two
  // neighbours are: a package's own suite is not something a bypassed merge
  // should be able to skip. It measured 1m2s in CI, so the invariant above is
  // intact — the lane's length is still `lint`'s.
  //
  // ⚠️ All three package lanes carry an `if:` since MOTIR-5323 — each reads its
  // own `pkg_*` flag — and they are STILL here, because the `changes` job fails
  // open on a push (a push carries no base to diff) and emits every flag `true`.
  'orchestrator',
  // The fourth package lane (MOTIR-5758), on the same fail-open argument: a
  // push emits `pkg_pages=true`. Its install-typecheck-build-test shape is the
  // orchestrator lane's, so the lane's length is still `lint`'s.
  'pages',
  // The docs-guard lane (MOTIR-4408), here for the same reason the two guard
  // lanes above it are: it carries no `if:`, because a lane that exists to run
  // on the diff shape every other lane skips is not something a bypassed merge
  // should be able to skip either. Its cost is an install, a `prisma generate`
  // and ~2 s of vitest over seven specs, so the deploy-starvation window this
  // list also measures is not materially widened — `build` remains the pole.
  'docs-guards',
  'build',
];
/**
 * …and the subset that verifies a BYPASSED merge — the three jobs the retired
 * Fly `deploy` job waited for (MOTIR-10935 deleted it). The package and design
 * lanes are not part of this service's artifact. `build` is here for the
 * schema-drift and NFT assertions it makes, not for the bundle it produces.
 */
const TRIPWIRE = ['lint', 'typecheck', 'build'];

/** A matrix job's `fail-fast:`, from its `strategy:` block — six spaces exactly
 *  (`jobs:` → id → `strategy:` → the key). */
function failFast(id: string): string | null {
  const m = /^ {6}fail-fast:(.*)$/m.exec(jobCode(id));
  return m ? m[1]!.trim() : null;
}

describe('the merge queue reports the required check (MOTIR-4050)', () => {
  it('finds the workflow it is meant to guard', () => {
    // A parser regression would otherwise make every assertion below vacuous.
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(ciJobs.has('ci-complete')).toBe(true);
    expect(ciJobs.has('lint')).toBe(true);
  });

  it('triggers on `merge_group`, alongside the pull request and the push', () => {
    // Failure mode 1. Without this line every queue entry is ejected on a
    // timeout, and no check anywhere goes red.
    expect(header).toMatch(/^on:\s*$/m);
    expect(header).toMatch(/^ {2}merge_group:\s*$/m);
    expect(header).toMatch(/^ {2}pull_request:\s*$/m);
    expect(header).toMatch(/^ {2}push:\s*\n {4}branches: \[main\]$/m);
  });

  it('reports `CI complete` on a queue entry', () => {
    // The required context must exist on `merge_group` or the entry never
    // settles. `if: always()` is what makes that true regardless of what skips.
    expect(runsOn('ci-complete', 'merge_group')).toBe(true);
    expect(jobIf('ci-complete')).toBe('always()');
  });
});

describe('the queue runs the whole gate, and the push lane no longer does', () => {
  it.each(MATRIX)('%s runs on a queue entry', (job) => {
    // Failure mode 2 — the one that leaves a check green and gating nothing.
    expect(ciJobs.has(job), `${job} exists`).toBe(true);
    expect(runsOn(job, 'merge_group')).toBe(true);
  });

  it.each(QUEUE_ONLY)('%s runs on a queue entry and NOT on an ordinary PR', (job) => {
    // MOTIR-3148's property, restated where the legs now live: once per merge,
    // never on an unlabelled pull request.
    expect(runsOn(job, 'merge_group')).toBe(true);
    expect(runsOn(job, 'pull_request')).toBe(false);
    expect(runsOn(job, 'push')).toBe(false);
  });

  it('leaves only the tripwire on a push', () => {
    // The saving. Anything else still running here is the duplicate this card
    // set out to remove — and the deploy-starvation window MOTIR-3106 fixed is
    // this lane's length, so it growing back is a regression in two directions.
    const onPush = [...ciJobs.keys()].filter(
      (id) => id !== 'ci-complete' && id !== 'changes' && runsOn(id, 'push'),
    );
    expect(onPush.sort()).toEqual([...PUSH_LANE].sort());
  });

  it('runs every job somewhere', () => {
    // A job reachable on no event is dead code that still reports a green
    // skipped check — the shape of failure mode 2 for a job nobody listed above.
    for (const id of ciJobs.keys()) {
      const events: Event[] = ['pull_request', 'merge_group', 'push'];
      expect(
        events.some((event) => runsOn(id, event)),
        `${id} runs on some event`,
      ).toBe(true);
    }
  });
});

describe('a shard matrix fails fast in the QUEUE and fans out on a PR (MOTIR-4407)', () => {
  // The three matrices are ONE decision and they must not drift apart: whichever
  // lane a red shard lands in decides whether the other shards are evidence or
  // overhead, and that is a property of the lane, not of the suite.
  //
  //   • PULL REQUEST — the full fan-out. It is where an E2E or Vitest red is
  //     actually READ, and this repository's flake triage turns on ROTATION (a
  //     different test failing each run, the siblings behaving differently),
  //     which cancelling them deletes.
  //   • MERGE QUEUE — cancel. The entry is ejected either way; the remaining
  //     shards only hold the queue, and the `gh-readonly-queue/…` ref they would
  //     report against does not survive the ejection.
  //
  // ⚠️ The two halves are one change. Fail-fast in the queue is affordable ONLY
  // while the pull-request lane still runs these suites — 77 of 81 failing PR CI
  // runs over 2026-08-27 → 09-04 involved one of them, so a PR lane slimmed to
  // lint/typecheck would send 95% of real failures to a lane that now cancels
  // its own evidence. Asserted here so neither half can move alone.
  const SHARDED = ['test', 'e2e', 'e2e-at-scale'];

  it.each(SHARDED)('%s declares a fail-fast this evaluator can read', (job) => {
    // Without this the two assertions below would pass on a `null` they never
    // evaluated — the vacuity every guard in this file is written against.
    expect(ciJobs.has(job), `${job} exists`).toBe(true);
    expect(failFast(job), `${job} declares fail-fast`).not.toBeNull();
  });

  it.each(SHARDED)('%s cancels its siblings on a queue entry', (job) => {
    expect(evaluate(failFast(job)!, contextFor('merge_group'))).toBe(true);
  });

  it.each(SHARDED)('%s keeps the whole fan-out on a pull request', (job) => {
    // `e2e-at-scale` reaches a pull request only under its own label, and that
    // is exactly the case that wants every leg: somebody applied the label in
    // order to read them.
    expect(evaluate(failFast(job)!, contextFor('pull_request'))).toBe(false);
  });
});

describe('this workflow releases nothing, and its push run is still the tripwire (MOTIR-10935)', () => {
  it('carries no deploy job and no release of any kind', () => {
    // The retired deploy job, its concurrency group and its two cutover
    // switches were deleted with the old host's app manifests. Motir's own
    // services ship through ONE lane, `aws-deploy.yml`, which needs nothing in
    // this file; a deploy job reappearing here would be a second release path.
    // So the guard names no host: it refuses a deploy JOB, a deploy GROUP, a
    // deploy SWITCH and any `<tool> deploy` command, whichever host it targets.
    expect(ciJobs.has('deploy')).toBe(false);
    const code = codeOf(ci);
    expect(code).not.toMatch(/group:\s*\S*deploy/);
    expect(code).not.toMatch(/MOTIR_\w*DEPLOY_ENABLED|MOTIR_RELAY_ENABLED/);
    // `prisma migrate deploy` applies migrations to the job's own ephemeral
    // Postgres; it is the one `deploy` verb a CI job may run.
    const deployCommands = [...code.matchAll(/\b([\w-]+)\s+deploy\b/g)]
      .map((m) => m[1])
      .filter((tool) => tool !== 'migrate');
    expect(deployCommands).toEqual([]);
  });

  it('runs the tripwire on a push, so a BYPASSED merge still meets a gate', () => {
    // Ruleset 17227448 has a bypass actor, so a merge can reach `main` without
    // passing through any queue. These three are the only thing that verifies it.
    for (const gate of TRIPWIRE) {
      expect(ciJobs.has(gate), `${gate} exists`).toBe(true);
      expect(runsOn(gate, 'push'), `${gate} runs on a push`).toBe(true);
    }
  });

  it('lets `CI complete` wait only on jobs that exist', () => {
    // Dropping a job and leaving its name in the aggregation would make the
    // workflow invalid; the job-key totality itself is `ci-complete-gate`'s.
    const needs = declaredNeeds('ci-complete');
    expect(needs.length).toBeGreaterThan(10);
    expect(needs).not.toContain('deploy');
    for (const need of needs) {
      expect(ciJobs.has(need), `ci-complete needs ${need}, which must exist`).toBe(true);
    }
  });
});

describe('a run on main is allowed to finish (MOTIR-3106, carried over by MOTIR-10935)', () => {
  // These lived in the deleted `tests/ci-fly-deploy.test.ts`, phrased through the
  // release they protected. The release has left this workflow; the push run it
  // protects is now the bypassed merge's only verification, which a newer merge
  // must not cancel either.
  it('finds the workflow-level concurrency block it is meant to guard', () => {
    // The negative control: a restructure that moved or dropped the header
    // block would otherwise make both assertions below pass vacuously.
    expect(header).toMatch(/^concurrency:\s*$/m);
    expect(header).toMatch(
      /^\s*group:\s*\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*$/m,
    );
    expect(header).not.toContain('jobs:');
  });

  it('cancels superseded runs on a PR but NEVER on a push to main', () => {
    // `cancel-in-progress: true` is the exact line that shipped MOTIR-3106's
    // defect. Asserting merely that SOME expression is present is not enough; it
    // must be one that distinguishes the triggers. Same expression, and the same
    // assertion, as `tests/ci-acceptance-lane.test.ts` — one idiom, not two.
    const setting = /^\s*cancel-in-progress:\s*(.+)$/m.exec(header)?.[1]?.trim();
    expect(setting).toBeDefined();
    expect(setting).not.toBe('true');
    expect(header).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    );
  });
});

describe('the ACCEPTANCE lane is gated by the queue, not discovered after it (MOTIR-4257)', () => {
  it('finds the workflow it is meant to guard', () => {
    // A parser regression would make every assertion below vacuous.
    expect(acceptanceJobs.size).toBeGreaterThan(2);
    expect(acceptanceJobs.has('acceptance')).toBe(true);
    expect(acceptanceJobs.has('acceptance-complete')).toBe(true);
  });

  it('triggers on `merge_group` — the half without which the trunk can go red', () => {
    // The `pull_request:` filter selects on the files a change TOUCHES, and
    // this lane's specs read the whole app. Only the queue closes that.
    expect(acceptanceHeader).toMatch(/^ {2}merge_group:\s*$/m);
    expect(acceptanceHeader).toMatch(/^ {2}pull_request:\s*$/m);
  });

  it('reports ONE aggregate context on a queue entry, and it is `always()`', () => {
    // The ruleset cannot require a matrix leg: the shard names carry `1/N` and
    // N is derived (MOTIR-2908). It requires this aggregate instead — and the
    // pair of `always()` plus an explicit result assertion is what stops a
    // skipped need reading as a satisfied gate. `ci-complete` carries the same.
    expect(acceptanceJobs.has('acceptance-complete')).toBe(true);
    expect(jobIfIn(acceptance, 'acceptance-complete')).toBe('always()');
  });

  it('the aggregate NEEDS every job in the lane — an unlisted job gates nothing', () => {
    // The failure this catches is silent: a job added later and left out of
    // `needs` runs, fails, and the required context still goes green. Derived
    // from the workflow's own job list rather than a written-down copy of it.
    const needs = needsOfIn(acceptance, 'acceptance-complete');
    const others = [...acceptanceJobs.keys()].filter((j) => j !== 'acceptance-complete');
    expect([...needs].sort()).toEqual(others.sort());
  });
});

describe('the required context REPORTS on every PR, or it is not a gate (MOTIR-4257)', () => {
  it('does not paths-filter `pull_request` — a filtered lane never reports', () => {
    // ⚠️ THE ONE THAT BRICKS THE REPO IF IT REGRESSES. GitHub admits a PR to the
    // merge queue only once the branch's required checks have passed ON THE PR
    // itself. A `paths:`-filtered workflow does not run on a PR that matches
    // nothing, so `Acceptance complete` never reports, and a required context
    // that never reports is not a passing gate — it is a PR that can never
    // merge. Restoring `paths:` under `pull_request:` here, while the ruleset
    // requires this context, blocks every PR that touches no acceptance file.
    // A NUMBERED group, not a named one: this repo's `target` predates ES2018,
    // and `(?<name>…)` is a compile error under it (TS1503) — green locally in
    // vitest, red in `pnpm typecheck`.
    const prBlock = /^ {2}pull_request:\n((?: {4}.*\n|\n)*)/m.exec(acceptanceHeader);
    expect(acceptanceHeader).toMatch(/^ {2}pull_request:\s*$/m);
    expect(prBlock?.[1] ?? '').not.toMatch(/^ {4}paths:/m);
  });

  it('keeps the paths decision, moved into the gate job the heavy jobs need', () => {
    // The filter did not vanish — dropping it outright would run a Next build
    // and the Playwright fan-out on EVERY pull request. It moved into
    // `membership`, whose `run` output still gates the expensive jobs, so the
    // cost profile is unchanged and only the cheap gate + aggregate run on a PR
    // that owns no spec.
    const gate = codeOf(acceptanceJobs.get('membership') ?? '');
    expect(gate).toMatch(/pulls\/\$\{PR_NUMBER\}\/files/);
    // `--paginate`, because the endpoint pages at 30 and a spec on page two
    // would read as "touches nothing" — a silent false negative.
    expect(gate).toMatch(/--paginate/);
    // Compared as plain substrings: the gate holds a grep PATTERN, so its dots
    // arrive backslash-escaped and a regex written against the bare path cannot
    // match them. The stems are what carries the meaning.
    for (const stem of [
      'tests/e2e/acceptance',
      'acceptance-tests',
      'playwright',
      'acceptance-(video|diagnostics)',
    ]) {
      expect(gate).toContain(stem);
    }
    // Both heavy jobs stay downstream of the gate — `build` reads its output
    // directly, `acceptance` inherits the skip through `build` — so a PR that
    // matches no path pays the gate and the aggregate, and nothing else.
    // Read off the job text rather than `needsOfIn`, which parses the inline
    // and block forms — `build` writes the third, a bare scalar `needs:
    // membership`.
    for (const heavy of ['build', 'acceptance']) {
      expect(codeOf(acceptanceJobs.get(heavy) ?? '')).toMatch(
        /^ {4}needs:\s*(membership$|\[[^\]]*\bmembership\b)/m,
      );
    }
    expect(jobIfIn(acceptance, 'build')).toMatch(/needs\.membership\.outputs\.run/);
  });

  it('reads the changed list with a token that is granted, not assumed', () => {
    const gate = codeOf(acceptanceJobs.get('membership') ?? '');
    expect(gate).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    expect(gate).toMatch(/pull-requests:\s*read/);
  });
});
