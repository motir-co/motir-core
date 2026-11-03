import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-2390: the deploy that replaced Vercel's. Its acceptance
// criterion is that the ordering is "asserted by reading the workflow file, not
// by watching a merge" — which is what this file does, because nothing else
// would: workflow YAML is neither type-checked, linted, nor executed by any
// suite (the same premise as `tests/ci-complete-gate.test.ts`,
// `tests/ci-postgres-container.test.ts` and `tests/ci-buildkit-registry.test.ts`,
// and the same no-YAML-dependency constraint — the repo has no YAML parser).
//
// Four things must hold, and each has a named failure behind it:
//
//   1. The gates run FIRST — and since MOTIR-4050 they run in the MERGE QUEUE,
//      not on the push. `needs:` the jobs that still execute on a push, and NO
//      `always()`, so a red tripwire means nothing ships (ADR §6 / Q5).
//      ⚠️ THIS POINT USED TO NAME `test` AND `e2e` DIRECTLY, and that assertion
//      was inverted by the change rather than weakened by it. The whole matrix
//      now runs against the composed tree BEFORE the merge — a stronger claim
//      than a push-time run could make — and is skipped on the push. A skipped
//      `needs` entry makes its dependents skip, so keeping them listed would
//      have stopped the deploy outright. What still has to hold is that the
//      matrix went somewhere and not nowhere, which is a property about the
//      QUEUE and therefore lives in `tests/ci-merge-queue.test.ts`.
//   2. Only the default branch deploys. A `push:`-triggered workflow that also
//      runs on pull requests would otherwise ship from any branch.
//   3. ⚠️ POINT 3 WAS THE FUNCTION-REGISTRATION SYNC, AND IT IS GONE
//      (MOTIR-3418). It read: "The Inngest sync is a STEP of the deploy and FAILS
//      the job. It used to ride `deployment_status` — an event Vercel raises and
//      Fly does not — so leaving that trigger would have stopped the sync
//      silently, reproducing the fault MOTIR-1970 fixed (five production jobs dead
//      for a month)." The vendor held its own registry of this app's functions and
//      it went stale invisibly; the deploy PUT the serve route and failed red if
//      the PUT did not. There is no second registry now — the worker reads
//      `lib/jobs/registry.ts` out of the image it is running — so a job is
//      registered by being deployed and cannot be registered any other way. The
//      step, the manual workflow and the composite action are all deleted, and the
//      `describe` that asserted all three went with them.
//   4. Verification reads its OBSERVATION from the PLATFORM. A config file is a
//      claim about the deployment, not a reading of it — MOTIR-2102 verbatim.
//      ⚠️ NARROWED by MOTIR-3570: `fly.toml` now supplies the EXPECTATION, which
//      is a different half and the whole point of that card. The assertion used
//      to be that the deploy job's text does not mention `fly.toml` at all, and
//      that blanket form would have forbidden the fix — see the describe below.
//   5. The WORKFLOW-level concurrency lets a run on `main` FINISH (MOTIR-3106).
//      The three above are all about the deploy job's own body, and every one
//      of them held while the deploy was in practice never reached. An
//      unconditional `cancel-in-progress: true` in the workflow header did not
//      lose any single release — a later run carries the earlier commits — it
//      STARVED the lane: the run inheriting the obligation to ship was itself
//      cancelled by the merge after it, indefinitely. A guard on the job cannot
//      see that; this one reads the header.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const DEPLOY_JOB = 'deploy';
/** The pool guard the deploy step invokes (MOTIR-3570). */
const POOL_GUARD = 'scripts/assert-machine-pool.mjs';
const POOL_GUARD_PATH = join(process.cwd(), POOL_GUARD);
/**
 * What the deploy must still wait for: the push lane's own tripwire. `build` is
 * in the list for the schema-drift and NFT assertions it carries, not for its
 * artifact — a release whose `release_command` is `prisma migrate deploy` must
 * not run against a datamodel its migrations disagree with.
 */
const GATE_JOBS = ['lint', 'typecheck', 'build'];
/** Moved to the merge queue by MOTIR-4050 — asserted there, forbidden here. */
const QUEUE_JOBS = ['test', 'coverage', 'e2e', 'e2e-at-scale'];

const ci = readFileSync(CI_PATH, 'utf8');
const poolGuard = [POOL_GUARD, 'scripts/machinePool.mjs']
  .map((rel) => readFileSync(join(process.cwd(), rel), 'utf8'))
  .join('\n');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further.
 */
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

/**
 * The same text with whole-line comments dropped. Every assertion about what a
 * job DOES runs through this: the parser above attributes a job's leading
 * comment block to the job before it, and these files describe each other in
 * prose — this job's own header names `deployment_status`, which a raw-text
 * assertion would happily match.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** The `needs:` entries of a job, in whatever YAML form they are written. */
function declaredNeeds(jobCode: string): string[] {
  const flow = /needs:\s*\[([^\]]*)\]/.exec(jobCode);
  if (flow) {
    return flow[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const block = /needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/.exec(jobCode);
  if (block) {
    return [...block[1]!.matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  }
  return [];
}

const ciJobs = jobsOf(ci);
const deployCode = codeOf(ciJobs.get(DEPLOY_JOB) ?? '');
const deployNeeds = declaredNeeds(deployCode);

/**
 * The workflow HEADER — everything above `jobs:`, comments stripped. `jobsOf`
 * deliberately reads only the mapping below it, and the defect MOTIR-3106 fixed
 * lived entirely up here.
 */
const ciHeader = codeOf(ci.split(/^jobs:\s*$/m)[0] ?? '');

describe('the Fly deploy runs after the existing gates (MOTIR-2390)', () => {
  it('finds the job it is meant to guard', () => {
    // A parser regression or a workflow restructure would otherwise make every
    // assertion below pass vacuously — the negative control.
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(ciJobs.has(DEPLOY_JOB)).toBe(true);
    expect(deployCode).toMatch(/^\s*name:\s*Deploy to Fly\s*$/m);
  });

  it('waits for the push lane\u2019s tripwire, and for jobs that exist', () => {
    // The whole point of the ordering: everything that can fail cheaply fails
    // before anything is shipped. A `needs` entry naming a job that no longer
    // exists is a workflow load error, so the second assertion is not pedantry.
    for (const gate of GATE_JOBS) expect(deployNeeds).toContain(gate);
    for (const need of deployNeeds) expect(ciJobs.has(need)).toBe(true);
    expect(deployNeeds).not.toContain(DEPLOY_JOB);
  });

  it('does NOT wait for a job that is skipped on a push', () => {
    // Not a style preference — a skipped `needs` entry makes its dependents
    // skip, so listing a queue-only job here stops the release entirely rather
    // than gating it. This is the assertion that would have caught the obvious
    // way to write MOTIR-4050 wrong: move the matrix and leave `needs` alone.
    for (const queued of QUEUE_JOBS) expect(deployNeeds).not.toContain(queued);
  });

  it('is skipped — not run — when a gate fails', () => {
    // `always()` (or `if: success() ||`) would remove the implicit all-needs-
    // succeeded condition and ship a build the suite just rejected. The gate
    // job two doors down needs `always()` for the opposite reason; this one
    // must never have it.
    expect(deployCode).not.toContain('always()');
  });

  it('deploys only from the default branch, and only on a real push', () => {
    // ci.yml triggers on `pull_request` too, so without this the deploy would
    // fire from every branch that opened one.
    const jobLevelIfs = [...deployCode.matchAll(/^ {4}if:(.*)$/gm)].map((m) => m[1]!.trim());
    expect(jobLevelIfs).toHaveLength(1);
    expect(jobLevelIfs[0]).toContain("github.ref == 'refs/heads/main'");
    expect(jobLevelIfs[0]).toContain("github.event_name == 'push'");
  });

  it('is never cancelled mid-release by a newer push', () => {
    // The workflow-level concurrency cancels in-progress runs, which is right
    // for a test run and wrong for a release — a half-applied deploy is worse
    // than a slow one.
    expect(deployCode).toMatch(/concurrency:\s*\n\s*group:\s*fly-deploy/);
    expect(deployCode).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe('the Fly off switch holds on the deploy job (Story MOTIR-9712 · MOTIR-10077)', () => {
  // The core cutover window turns Fly deploys off by setting the repository
  // variable `MOTIR_FLY_DEPLOY_ENABLED` to `false` (MOTIR-10074). Two things
  // must stay true for that to work: the clause sits on the job's ONE
  // job-level `if:`, so the job skips whole, and its polarity is `!= 'false'`,
  // so an UNSET variable — every day before the window — still deploys.
  const SWITCH = "vars.MOTIR_FLY_DEPLOY_ENABLED != 'false'";
  const jobLevelIf = (): string => {
    const ifs = [...deployCode.matchAll(/^ {4}if:(.*)$/gm)].map((m) => m[1]!.trim());
    expect(ifs).toHaveLength(1);
    return ifs[0]!;
  };

  it('joins the switch to the main-branch and push conditions on the one job-level `if:`', () => {
    const clauses = jobLevelIf()
      .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .split('&&')
      .map((c) => c.trim());
    expect(clauses).toEqual(
      expect.arrayContaining([
        "github.ref == 'refs/heads/main'",
        "github.event_name == 'push'",
        SWITCH,
      ]),
    );
    expect(jobLevelIf()).not.toMatch(/\|\|/);
  });

  it('deploys while the variable is unset: the opt-OUT polarity, never opt-in', () => {
    expect(jobLevelIf()).not.toContain("vars.MOTIR_FLY_DEPLOY_ENABLED == 'true'");
    expect(jobLevelIf()).not.toMatch(/vars\.MOTIR_FLY_DEPLOY_ENABLED\s*==/);
  });

  it('guards no single step, so the job can never run half-way', () => {
    const steps = deployCode.split(/^ {4}steps:\s*$/m)[1] ?? '';
    expect(steps.length).toBeGreaterThan(0);
    expect(steps).not.toContain('MOTIR_FLY_DEPLOY_ENABLED');
  });
});

describe('nothing registers functions with a third party any more (MOTIR-3418)', () => {
  it('the deploy job has no registration step, and the workflow/action are gone', () => {
    // The inverse of the `describe` that stood here, and the only shape this
    // property has left. It asserted five things about the sync — that it ran as a
    // step, AFTER the release, against the custom domain rather than a
    // per-deployment hostname, that a non-200 failed the job, and that the step and
    // the manual workflow shared one composite definition. Every one of them names a
    // control plane that no longer exists.
    expect(deployCode).not.toContain('inngest');
    expect(existsSync(join(process.cwd(), '.github/actions/inngest-sync/action.yml'))).toBe(false);
    expect(existsSync(join(process.cwd(), '.github/workflows/inngest-sync.yml'))).toBe(false);
  });
});

describe('post-deploy verification reads the platform (MOTIR-2390 / MOTIR-2102)', () => {
  it('asserts the release answers over its own Fly hostname', () => {
    // The custom domain still pointed at Vercel until the cutover, so a check
    // against it would have proved a DNS record rather than this release.
    expect(deployCode).toContain('.fly.dev');
  });

  it('reads the OBSERVED pool from Fly’s API', () => {
    // `auto_start_machines` NEVER creates a machine, so a fly.toml that
    // describes a pool of N is a claim, not a behaviour: motir-ai ran ONE
    // machine for weeks behind a config that said otherwise. The read moved
    // into a script (MOTIR-3570) so its derivation could be unit-tested, which
    // is why this asserts on the script the step invokes rather than on the
    // step's own shell — the property is that SOMETHING in this path calls the
    // Machines API, not that the YAML does it inline.
    expect(deployCode).toContain(POOL_GUARD);
    expect(poolGuard).toContain('https://api.machines.dev/v1/apps/');
  });

  it('DERIVES the expectation from fly.toml — no stored count anywhere', () => {
    // ⚠️ THIS ASSERTION IS THE INVERSE OF THE ONE IT REPLACES, deliberately.
    // The old spec read `expect(deployCode).not.toContain('fly.toml')`, meaning
    // to say "the observation is not taken from a config file" — and what it
    // actually said was that the deploy job may not mention the file at all. A
    // guard that derives its expectation from `[processes]` is exactly what that
    // wording forbids, so the test would have gone red on the fix and been the
    // last word on whether the fix was allowed.
    //
    // The defect it was standing over: `FLY_EXPECTED_MACHINE_COUNT` said 2 from
    // MOTIR-2408, MOTIR-3425 added the `worker` group, and every deploy after
    // that ended RED on a deploy that had SUCCEEDED. A stored total goes stale by
    // construction; the group set and the running floor cannot, because they are
    // the same lines the release itself acts on.
    expect(codeOf(ci)).not.toContain('FLY_EXPECTED_MACHINE_COUNT');
    expect(poolGuard).toContain('fly.toml');
  });

  it('fails the job when the pool does not match', () => {
    // A verification step that reads a number and does not compare it is a log
    // line, not a check. The comparison itself lives in
    // `tests/scripts/assert-machine-pool.test.ts`, which drives it with
    // deliberate negatives; what belongs HERE is that its exit code is allowed
    // to reach the job — a `continue-on-error` or a trailing `|| true` would
    // make every one of those specs decorative.
    expect(deployCode).not.toContain('continue-on-error');
    expect(deployCode).not.toMatch(new RegExp(`${POOL_GUARD}[^\n]*\\|\\|`));
    expect(existsSync(POOL_GUARD_PATH)).toBe(true);
  });
});

describe('a run on main is allowed to finish, so the deploy is reached (MOTIR-3106)', () => {
  it('finds the workflow-level concurrency block it is meant to guard', () => {
    // The negative control: a restructure that moved or dropped the header
    // block would otherwise make both assertions below pass vacuously.
    expect(ciHeader).toMatch(/^concurrency:\s*$/m);
    expect(ciHeader).toMatch(
      /^\s*group:\s*\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*$/m,
    );
    expect(ciHeader).not.toContain('jobs:');
  });

  it('cancels superseded runs on a PR but NEVER on a push to main', () => {
    // `cancel-in-progress: true` is the exact line that shipped the defect.
    // Every merge pushes the same ref, so one shared group meant the newest
    // always won; the release is the LAST thing in a run, so the merge that
    // inherited the obligation to ship never got there before the next one
    // cancelled it too. Asserting merely that SOME expression is present is not
    // enough; it must be one that distinguishes the two triggers, or the next
    // rewrite reintroduces the fault while staying green. Same expression, and
    // the same assertion, as `tests/ci-acceptance-lane.test.ts` — deliberately
    // one idiom, not two.
    const setting = /^\s*cancel-in-progress:\s*(.+)$/m.exec(ciHeader)?.[1]?.trim();
    expect(setting).toBeDefined();
    expect(setting).not.toBe('true');
    expect(ciHeader).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    );
  });

  it('still supersedes an older run on a pull-request branch', () => {
    // The saving is real and worth keeping — a force-push should not leave its
    // own predecessor running. `github.ref` is `refs/pull/<n>/merge` on that
    // event, so per-ref grouping is what makes the exception above safe to
    // scope this narrowly: a PR cancels only itself.
    expect(ciHeader).toMatch(/^\s*push:\s*$/m);
    expect(ciHeader).toMatch(/^\s*pull_request:\s*$/m);
    expect(ciHeader).toMatch(/branches:\s*\[main\]/);
  });
});
