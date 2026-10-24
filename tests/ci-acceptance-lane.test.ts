import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guard for MOTIR-1949: a PR that changes no `tests/e2e/acceptance*.spec.ts`
// must see NO acceptance check at all. Before it, the lane was an `e2e` matrix
// leg with no relevance gate, so every ordinary PR paid ~11 minutes (the run's
// long pole) and a ~419 MB video/trace artifact to record eight clips that
// MOTIR-1937 then correctly refused to publish.
//
// The mechanism is load-bearing and non-obvious, which is why it is asserted
// here: a job-level `if:` is NOT enough — a job whose `if:` is false is still
// reported, as a greyed `Skipped` check (measured on PR #1751). A matrix leg
// cannot be dropped by an expression either. Only a workflow that is never
// TRIGGERED leaves nothing behind, so the lane lives in its own file with a
// `paths:` filter.
//
// These assertions exist because nothing else would catch a regression: the
// workflow files are not type-checked, linted, or executed by any suite. Same
// mould as `tests/ci-postgres-container.test.ts`, and the same no-YAML-dependency
// constraint — the repo has no YAML parser, so the file is split by indentation.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const ACCEPTANCE_WORKFLOW_PATH = join(process.cwd(), '.github/workflows/acceptance-tests.yml');
const SETUP_ACTION_PATH = join(process.cwd(), '.github/actions/e2e-setup/action.yml');
const SETUP_ACTION_REF = 'uses: ./.github/actions/e2e-setup';
const ACCEPTANCE_CONFIG = 'playwright.acceptance.config.ts';
const ACCEPTANCE_SPEC_GLOB = "'tests/e2e/acceptance*.spec.ts'";

const ci = readFileSync(CI_PATH, 'utf8');
const acceptanceWorkflow = readFileSync(ACCEPTANCE_WORKFLOW_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (Copied from ci-postgres-container.test.ts — the repo has no YAML
 * dependency, and two small parsers beat one shared test-helper import that
 * couples the two guards.)
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
 * The same text with whole-line comments dropped. Needed wherever an assertion
 * asks what a workflow DOES: these files describe each other in prose, and the
 * parser above attributes a job's leading comment block to the job before it.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const acceptanceJob = jobsOf(acceptanceWorkflow).get('acceptance');
const e2eBody = ciJobs.get('e2e');

/**
 * The workflow ABOVE `jobs:`, comments stripped — the triggers and the
 * workflow-level `concurrency` block. Same idiom as `ciHeader` in
 * `tests/ci-fly-deploy.test.ts`.
 */
const acceptanceHeader = codeOf(acceptanceWorkflow.split(/^jobs:\s*$/m)[0] ?? '');

// ── MOTIR-4095: RESOLVING the concurrency group, not matching its text ───────
//
// `cancel-in-progress: false` protects the run that is EXECUTING. GitHub
// separately holds only ONE PENDING run per group and evicts the queued one, so
// a per-ref group on `push: main` silently dropped 23 of 100 baselines — every
// one `cancelled` with zero jobs, at the instant the next merge's run was
// created. The remedy is a group that varies per COMMIT on a push.
//
// That property is ARITHMETIC over a context, not a structure, so a regex is
// the wrong instrument: any pattern loose enough to survive a rewrite is loose
// enough to agree with a group that is constant across shas again. Same
// reasoning, and the same remedy, as the MOTIR-2908 block below — extract what
// the runner actually evaluates and evaluate it.
//
// The evaluator covers exactly the grammar these expressions use and THROWS on
// anything else, deliberately: a partial evaluator that quietly returned
// `undefined` would make every assertion below pass vacuously the first time
// somebody reaches for a function call.

type ExpressionValue = string | boolean;

/** GitHub's falsiness: `false`, `0`, the empty string, `null`. */
const isTruthy = (v: ExpressionValue): boolean => v !== false && v !== '';

function tokenize(source: string): string[] {
  const token = /\s*(github(?:\.[A-Za-z_][A-Za-z0-9_]*)+|'[^']*'|true|false|==|!=|&&|\|\||\(|\))/y;
  const tokens: string[] = [];
  let at = 0;
  const trimmed = source.trim();
  while (at < trimmed.length) {
    token.lastIndex = at;
    const match = token.exec(trimmed);
    if (!match) {
      throw new Error(`unsupported workflow expression near: ${trimmed.slice(at)}`);
    }
    tokens.push(match[1]!);
    at = token.lastIndex;
  }
  return tokens;
}

/**
 * Evaluate ONE `${{ … }}` body against a fabricated `github` context.
 *
 * `&&` and `||` return an OPERAND, not a boolean — that is what makes
 * `a && b || c` GitHub's ternary, and it is the whole mechanism under test.
 */
function evaluateExpression(body: string, github: Record<string, string>): ExpressionValue {
  const tokens = tokenize(body);
  let cursor = 0;
  const peek = (): string | undefined => tokens[cursor];
  const take = (): string => {
    const t = tokens[cursor];
    if (t === undefined) throw new Error(`workflow expression ended early: ${body}`);
    cursor += 1;
    return t;
  };

  const primary = (): ExpressionValue => {
    const t = take();
    if (t === '(') {
      const inner = or();
      if (take() !== ')') throw new Error(`unbalanced parentheses: ${body}`);
      return inner;
    }
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t.startsWith('github.')) {
      const value = github[t];
      if (value === undefined) throw new Error(`the fabricated context has no ${t}`);
      return value;
    }
    throw new Error(`unsupported workflow operand \`${t}\`: ${body}`);
  };

  const comparison = (): ExpressionValue => {
    const left = primary();
    const op = peek();
    if (op !== '==' && op !== '!=') return left;
    take();
    const right = primary();
    return op === '==' ? left === right : left !== right;
  };

  const and = (): ExpressionValue => {
    let left = comparison();
    while (peek() === '&&') {
      take();
      const right = comparison();
      left = isTruthy(left) ? right : left;
    }
    return left;
  };

  function or(): ExpressionValue {
    let left = and();
    while (peek() === '||') {
      take();
      const right = and();
      left = isTruthy(left) ? left : right;
    }
    return left;
  }

  const result = or();
  if (cursor !== tokens.length) throw new Error(`trailing tokens in workflow expression: ${body}`);
  return result;
}

/** Substitute every `${{ … }}` in a workflow value, as the runner does. */
function resolveTemplate(template: string, github: Record<string, string>): string {
  let sawExpression = false;
  const resolved = template.replace(/\$\{\{([^}]*(?:\}[^}][^}]*)*)\}\}/g, (_m, body: string) => {
    sawExpression = true;
    return String(evaluateExpression(body, github));
  });
  if (!sawExpression) throw new Error(`no \`\${{ }}\` to resolve in: ${template}`);
  return resolved;
}

/** The workflow-level `concurrency:` block's two settings, verbatim. */
function concurrencySetting(name: 'group' | 'cancel-in-progress'): string {
  const block = /^concurrency:\s*\n((?: {2}.*\n|\s*\n)*)/m.exec(acceptanceHeader);
  if (!block) throw new Error('no workflow-level `concurrency:` block');
  const setting = new RegExp(`^ {2}${name}:\\s*(.+)$`, 'm').exec(block[1]!);
  if (!setting) throw new Error(`the concurrency block declares no \`${name}\``);
  return setting[1]!.trim();
}

/** A fabricated `github` context for one event. */
const contextFor = (eventName: 'push' | 'pull_request', ref: string, sha: string) => ({
  'github.workflow': 'Acceptance tests',
  'github.event_name': eventName,
  'github.ref': ref,
  'github.sha': sha,
});

const resolvedGroup = (eventName: 'push' | 'pull_request', ref: string, sha: string): string =>
  resolveTemplate(concurrencySetting('group'), contextFor(eventName, ref, sha));

const resolvedCancel = (eventName: 'push' | 'pull_request', ref: string, sha: string): string =>
  resolveTemplate(concurrencySetting('cancel-in-progress'), contextFor(eventName, ref, sha));

describe('the acceptance lane is story-scoped (MOTIR-1949)', () => {
  it('finds the jobs it is meant to guard', () => {
    // A parser regression (or a workflow restructure) would otherwise make every
    // assertion below pass vacuously.
    expect(e2eBody).toBeDefined();
    expect(acceptanceJob).toBeDefined();
  });

  it('runs the acceptance lane from its OWN workflow, never from ci.yml', () => {
    // ci.yml runs on every PR and every push to main. Anything acceptance-shaped
    // in it is a check on PRs that do not want one — which is the whole bug.
    expect(codeOf(ci)).not.toContain(ACCEPTANCE_CONFIG);
    expect(codeOf(acceptanceWorkflow)).toContain(ACCEPTANCE_CONFIG);
  });

  it('gates on the changed paths in the GATE JOB, not an `on: paths:` filter', () => {
    // ⚠️ MOTIR-1949'S MECHANISM WAS REVERSED BY MOTIR-4257, DELIBERATELY, and
    // this test records the new one rather than being deleted.
    //
    // The old mechanism was an `on: paths:` filter: a workflow that does not
    // match is never triggered, so no check appears — the greyed `Skipped` this
    // card removed. That property is INCOMPATIBLE with gating the merge queue on
    // this lane. GitHub admits a PR to the queue only once the branch's required
    // checks have passed ON THE PULL REQUEST, and a workflow that never runs
    // never reports `Acceptance complete`; a required context that never reports
    // is not a gate that passes, it is a PR that can never merge.
    //
    // So the filter MOVED into the `membership` gate, which already owned this
    // decision for `push`. The trade: a PR with no spec shows a skipped build and
    // a skipped shard again, and `main` cannot go red through a merge nobody
    // checked. A tidy checks list is worth less than a green trunk.
    const prBlock = /^ {2}pull_request:\n(?:(?! {2}\S)[^\n]*\n)*/m.exec(acceptanceWorkflow);
    expect(prBlock).not.toBeNull();
    expect(prBlock![0]).not.toMatch(/^ {4}paths:/m);
    // The decision still EXISTS — dropping it outright would run a Next build and
    // the whole fan-out on every PR in the repo.
    expect(codeOf(jobsOf(acceptanceWorkflow).get('membership') ?? '')).toMatch(
      /pulls\/\$\{PR_NUMBER\}\/files/,
    );
    // …and the lane's OWN definition is a trigger too (MOTIR-2600), or a PR that
    // restructures the lane changes no spec and never runs it. An ordinary
    // feature PR still matches nothing here, so MOTIR-1949's requirement holds.
    // …and the lane's OWN definition is still one of the paths (MOTIR-2600), or a
    // PR that restructures the lane changes no spec and never runs it. They live
    // in the gate's regex now rather than in a YAML list, so they are asserted as
    // the stems that carry the meaning — the regex escapes its own dots.
    const gate = codeOf(jobsOf(acceptanceWorkflow).get('membership') ?? '');
    for (const stem of [
      'tests/e2e/acceptance',
      'acceptance-tests',
      'playwright',
      'acceptance-(video|diagnostics)',
    ]) {
      expect(gate).toContain(stem);
    }
    // A JOB-level key sits at exactly four spaces (`jobs:` → id → keys); the
    // step-level `if: success()` / `if: always()` below are at eight and fine.
    //
    // ⚠️ STILL TRUE AFTER MOTIR-2760, and deliberately so. That card added a
    // `push: main` baseline gated by a job-level `if:`, but put it on `build` —
    // which `acceptance` already `needs:` — precisely so this assertion could
    // stay literal. It is what stops a future edit from gating the SHARD job on
    // something that would show a PR a greyed check.
    expect(acceptanceJob).not.toMatch(/^ {4}if:/m);
  });

  it('the e2e matrix carries no acceptance leg', () => {
    // A matrix leg is always a present check — it cannot be pruned by an
    // expression, which is why the lane had to leave the matrix.
    expect(codeOf(e2eBody!)).not.toMatch(/id:\s*acceptance/);
  });

  it('uploads its report under a name the e2e legs cannot collide with', () => {
    // upload-artifact@v4+ errors on a duplicate name; the e2e legs upload
    // `playwright-report-${{ matrix.id }}`.
    expect(acceptanceJob).toContain('name: playwright-report-acceptance');
    expect(e2eBody).not.toContain('name: playwright-report-acceptance');
  });
});

// ── MOTIR-7253 (reversing MOTIR-4096's publisher retirement) ──────────────────
//
// From 2026-09-01 (MOTIR-4096) the lane RECORDED and the AGENT published the
// receipt over MCP. On 2026-10-01 (Yue) CI became the publisher again for the
// repositories Motir writes, because a receipt that exists only if an agent
// remembered two calls and could reach MCP is the least reliable link in the
// acceptance gate. These guards pin the shape of that reversal, and they keep
// the two properties the retirement was protecting:
//
//   · NO MOTIR TOKEN in any job. The lane authenticates by keyless GitHub OIDC
//     (`id-token: write` on the shard job alone); the action's PAT input exists
//     for repositories with no App connection and no workflow here passes it.
//   · PUBLISHING ONLY FROM A GREEN PR RUN. Publishing SUPERSEDES a story's
//     receipt (MOTIR-1937), so a push, a merge-queue run or a red run must not.
//
// Workflow files are not type-checked or linted, so these predicates are what
// keeps a copy-paste or a "while we are in here" edit from loosening either.
//
// ⚠️ The `MOTIR_GUARD_*` half of the credential assertion is NOT this lane's: it
// is MOTIR-5874's, and it stays exactly as it was.
describe('the lane publishes on a green PR run, over OIDC only (MOTIR-7253)', () => {
  const workflowsDir = join(process.cwd(), '.github/workflows');
  const actionsDir = join(process.cwd(), '.github/actions');

  /** Every `.yml` under `.github/`, as { path → text }. */
  const ciYaml = (): Array<readonly [string, string]> => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith('.yml') || e.name.endsWith('.yaml')
            ? [join(dir, e.name)]
            : [],
      );
    return [...walk(workflowsDir), ...walk(actionsDir)].map(
      (f) => [f, readFileSync(f, 'utf8')] as const,
    );
  };

  /** The shard job's steps, each as its own text. */
  const steps = (): string[] => acceptanceJob!.split(/^ {6}- /m).slice(1);
  const publishStep = (): string | undefined =>
    steps().find((s) => /name:\s*Publish the acceptance receipt/.test(s));

  it('the uploader and its composite action are back in the repository', () => {
    expect(existsSync(join(process.cwd(), 'scripts/upload-acceptance-video.mjs'))).toBe(true);
    expect(existsSync(join(actionsDir, 'upload-acceptance-video/action.yml'))).toBe(true);
  });

  it('the shard job publishes through the action, gated on success() AND pull_request', () => {
    const step = publishStep();
    expect(step).toBeDefined();
    const code = codeOf(step!);
    expect(code).toMatch(/uses:\s*\.\/\.github\/actions\/upload-acceptance-video\s*$/m);
    // Both halves of the gate: a red run records nothing worth a receipt, and a
    // push / merge_group run must never supersede a story's evidence.
    expect(code).toMatch(/^\s*if:\s*success\(\) && github\.event_name == 'pull_request'\s*$/m);
    // It is the ONLY publisher in the workflow.
    const publishers = steps().filter((s) => /upload-acceptance-video/.test(codeOf(s)));
    expect(publishers).toHaveLength(1);
  });

  it('feeds the uploader the specs THIS PR owns, and nothing on a push', () => {
    // The ownership filter (MOTIR-1937) is restored with the publisher. On a
    // `push` or `merge_group` run there is no PR base, the list is EMPTY, and the
    // uploader fails closed on an empty list — the second of the two mechanisms.
    const code = codeOf(acceptanceJob!);
    expect(code).toContain('id: owned-specs');
    expect(code).toContain(`git diff --name-only "\${BASE_SHA}" HEAD -- ${ACCEPTANCE_SPEC_GLOB}`);
    expect(code).toMatch(/BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
    expect(code).toMatch(
      /if \[ -z "\$\{BASE_SHA\}" \]; then[\s\S]*?echo "specs=" >> "\$GITHUB_OUTPUT"[\s\S]*?exit 0/,
    );
    expect(codeOf(publishStep()!)).toMatch(
      /changed-specs:\s*\$\{\{\s*steps\.owned-specs\.outputs\.specs\s*\}\}/,
    );
  });

  it('no workflow passes a token to the action, and no job is handed a Motir credential', () => {
    // OIDC only. The action's `token` input is the PAT path for a repository
    // with NO Motir GitHub App connection; motir-core is App-connected.
    expect(codeOf(publishStep()!)).not.toMatch(/^\s*token:/m);
    const offenders = ciYaml()
      .filter(([, text]) => /MOTIR_UPLOAD_TOKEN|MOTIR_GUARD_[A-Z_]+/.test(codeOf(text)))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
    const workflowsPassingToken = ciYaml()
      .filter(([f]) => f.startsWith(workflowsDir))
      .filter(([, text]) => /upload-acceptance-video[\s\S]*?^\s*token:/m.test(codeOf(text)))
      .map(([f]) => f);
    expect(workflowsPassingToken).toEqual([]);
  });

  it('grants `id-token: write` on the shard job and on no other job in this workflow', () => {
    const jobs = jobsOf(acceptanceWorkflow);
    const granted = [...jobs.entries()]
      .filter(([, body]) => /^\s*id-token:\s*write/m.test(codeOf(body)))
      .map(([id]) => id);
    expect(granted).toEqual(['acceptance']);
    // Never at workflow level, where every job would inherit it.
    expect(acceptanceHeader).not.toMatch(/id-token/);
    // And not in the e2e lane next door, which publishes nothing.
    expect(e2eBody).not.toMatch(/^\s*id-token:\s*write/m);
  });

  it('keeps the lane name and the shard job display name', () => {
    // The required context and every branch-protection entry hang off these.
    expect(acceptanceWorkflow).toMatch(/^name: Acceptance tests$/m);
    expect(acceptanceJob).toMatch(
      /^ {4}name: Playwright E2E \(acceptance\) \$\{\{ matrix\.shard \}\}\/\$\{\{ needs\.membership\.outputs\.legs \}\}$/m,
    );
  });

  it('still RECORDS, and still keeps the report a reviewer reads it from', () => {
    expect(readFileSync(join(process.cwd(), ACCEPTANCE_CONFIG), 'utf8')).toMatch(/video:\s*'on'/);
    expect(acceptanceJob).toContain('path: out/playwright-report-acceptance');
    expect(acceptanceJob).toMatch(/if:\s*always\(\)/);
  });
});

// ── MOTIR-2600 ───────────────────────────────────────────────────────────────
//
// The lane used to run every acceptance spec in ONE serial job and was
// lengthening with each story that added a spec (22.2 → 23.1 → 26.7 → 29.1 min
// across the runs on record). These assertions guard the shape that replaced it.
// They are here for the same reason the ones above are: workflow files are not
// type-checked, linted, or executed by any suite, so a regression in them is
// invisible until a lane behaves wrongly in production.
describe('the acceptance lane is SHARDED (MOTIR-2600)', () => {
  const acceptanceBuildJob = jobsOf(acceptanceWorkflow).get('build');

  it('builds `.next/` once, in its own job, and the test legs depend on it', () => {
    // One build for the whole fan-out. Without this every shard would pay a full
    // `next build`, which is most of what sharding was supposed to buy back.
    expect(acceptanceBuildJob).toBeDefined();
    expect(acceptanceBuildJob).toContain('pnpm build');
    expect(acceptanceBuildJob).toMatch(/name:\s*next-build/);
    // BOTH edges since MOTIR-2908: `build` for the artifact and the gate it
    // carries, `membership` because a job can only read the outputs of a job it
    // needs and that is where the leg count is derived. Asserted as the pair so
    // dropping either one is a failure rather than a silent behaviour change.
    expect(acceptanceJob).toMatch(/^\s*needs:\s*\[membership, build\]\s*$/m);
  });

  it('runs the suite as a shard matrix, passing the leg through to Playwright', () => {
    // The matrix and the CLI flag have to agree: a matrix that never reaches
    // `--shard` would run the WHOLE suite N times and publish each receipt N
    // times over. Since MOTIR-2908 they agree by reading the SAME output — the
    // matrix is `fromJSON(shards)` and the denominator is `legs`, both from the
    // one gate step, so they cannot drift apart.
    expect(acceptanceJob).toMatch(
      /shard:\s*\$\{\{\s*fromJSON\(needs\.membership\.outputs\.shards\)\s*\}\}/,
    );
    // `--pass-with-no-tests` (MOTIR-2769): the lane's membership is now exactly
    // the stories in review, so an EMPTY lane — and a shard leg that draws zero
    // specs from a small one — is a legitimate state, not a misconfiguration.
    // Without the flag Playwright exits non-zero on "no tests found" and every
    // PR touching this workflow goes red while no story is in flight.
    expect(acceptanceJob).toContain(
      'pnpm test:e2e --config playwright.acceptance.config.ts ' +
        '--pass-with-no-tests --shard=${{ matrix.shard }}/${{ needs.membership.outputs.legs }}',
    );
    // The fixed sizing MOTIR-2600 shipped is GONE, not merely shadowed. A
    // literal matrix left behind alongside the derived one would win silently.
    expect(acceptanceJob).not.toMatch(/shard:\s*\[1, 2, 3, 4\]/);
    expect(acceptanceJob).not.toMatch(/matrix\.total/);
  });

  it('lets every leg finish — a red shard does not cancel the others', () => {
    // `fail-fast: true` (the default) would cancel the sibling legs, and a
    // cancelled leg uploads no report: the run would lose the artifact a red
    // lane is read from, on exactly the runs that need it (MOTIR-1706).
    expect(acceptanceJob).toMatch(/fail-fast:\s*false/);
  });

  it('gives each leg its OWN report artifact name', () => {
    // upload-artifact v4+ REJECTS a second upload under an existing name, so a
    // single name would red-light three of the four legs at their last step.
    expect(acceptanceJob).toContain('name: playwright-report-acceptance-shard-${{ matrix.shard }}');
  });

  it('every leg emits a report, and no leg is gated on being a particular shard', () => {
    // Each leg publishes the recordings IT produced (MOTIR-7253 restored the
    // per-leg publish), so a leg gated on being a particular shard would
    // silently drop its share of the receipts — and its REPORT is the only other
    // place those recordings survive, so neither step may be shard-gated.
    const steps = acceptanceJob!.split(/^ {6}- /m).slice(1);
    const report = steps.find((s) => s.includes('name: playwright-report-acceptance-shard-'));
    expect(report).toBeDefined();
    expect(report).toMatch(/if:\s*always\(\)/);
    // Through `codeOf` (MOTIR-2908) because this asks what the step DOES: the
    // splitter attributes a step's leading comment block to the step BEFORE it,
    // and `matrix.shard` is EXPLAINED in that prose. A guard a correct
    // explanation can fail is a guard that pushes the next reader to delete it.
    expect(codeOf(report!)).not.toMatch(/if:.*matrix\.shard/);
    const publish = steps.find((s) => /upload-acceptance-video/.test(codeOf(s)));
    expect(publish).toBeDefined();
    expect(codeOf(publish!)).not.toMatch(/if:.*matrix\.shard/);
  });
});

// ── MOTIR-2760 ───────────────────────────────────────────────────────────────
//
// The lane's `pull_request` filter is blind to the app the specs drive, so an
// app change could break every acceptance spec, merge green, and wait on `main`
// for an unrelated PR to inherit it (measured: MOTIR-2654 broke
// `acceptance-ai-callout.spec.ts` at c6b5d19d; MOTIR-2664's PR #2045 found it).
// The answer is a `push: main` baseline that TESTS and never PUBLISHES, gated on
// the lane actually holding a spec.
//
// These assertions pin the three things that make that affordable and safe, each
// of which is silently reversible by a one-line edit: the gate, the
// never-publish, and the PR-only cancellation.
describe('the MAIN BASELINE runs the lane on `main` (MOTIR-2760)', () => {
  const membershipJob = jobsOf(acceptanceWorkflow).get('membership');
  const buildJob = jobsOf(acceptanceWorkflow).get('build');

  it('triggers on a push to main, in ADDITION to the pull_request filter', () => {
    // Both triggers, and the PR one still first — the `paths:` assertion above
    // matches `on:` → `pull_request:` → `paths:` as adjacent lines.
    expect(codeOf(acceptanceWorkflow)).toMatch(/^\s*push:\s*$/m);
    expect(codeOf(acceptanceWorkflow)).toMatch(/^\s*branches:\s*\[main\]\s*$/m);
  });

  it('does NOT paths-filter the push trigger', () => {
    // While the lane holds a spec, ANY merge could be the one that breaks it,
    // and WHICH sources those specs read is exactly what a filter cannot know —
    // that is the MOTIR-2620 rejection. The membership gate is what bounds the
    // cost instead. A `paths:` under `push:` would silently reopen the gap.
    const push = /^\s*push:\s*\n((?:\s{4,}.*\n|\s*\n)*)/m.exec(codeOf(acceptanceWorkflow));
    expect(push).not.toBeNull();
    expect(push![1]).not.toMatch(/paths:/);
  });

  it('gates the fan-out on the lane actually holding a spec', () => {
    // THE cost control. Measured on run 31740853229 (an empty lane): 6m build +
    // 4x3m shards = 18 machine-minutes to run zero tests, and `main` takes ~20
    // merges/day. Ungated, the baseline would burn ~360 machine-min/day on an
    // empty lane — which, after the MOTIR-2769 triage, is the steady state.
    expect(membershipJob).toBeDefined();
    expect(membershipJob).toMatch(/^\s*run:\s*\$\{\{\s*steps\.gate\.outputs\.run\s*\}\}/m);
    // It must stay CHEAP, or it is just the fan-out with extra steps: a checkout
    // and a glob — no Postgres, no install, no build.
    expect(membershipJob).not.toContain('pnpm install');
    expect(membershipJob).not.toContain('actions/postgres');
    expect(membershipJob).not.toContain('pnpm build');
    // The gate hangs off `build`, and `acceptance` inherits the skip via `needs`.
    // MOTIR-2908 added a SECOND edge, `membership`, for the derived leg count —
    // it changes nothing here: `membership` always runs, so it never skips
    // `acceptance`, and the skip still arrives through `build`.
    expect(buildJob).toMatch(/^\s*needs:\s*membership\s*$/m);
    expect(buildJob).toMatch(/^\s*if:\s*needs\.membership\.outputs\.run == 'true'\s*$/m);
    expect(acceptanceJob).toMatch(/^\s*needs:\s*\[membership, build\]\s*$/m);
  });

  it('matches the lane the Playwright config would actually collect', () => {
    // `testMatch: '**/acceptance*.spec.ts'` matches on the BASENAME, so
    // `epic2-acceptance.spec.ts` is NOT a member (it rides the main lane). A gate
    // that counted `*acceptance*` would hold the baseline permanently ON against
    // an empty lane — the exact cost this job exists to avoid.
    expect(membershipJob).toContain("-name 'acceptance*.spec.ts'");
  });

  it('never lets a PR see a skipped check because of the gate', () => {
    // MOTIR-1949's requirement is about PULL REQUESTS. A `push` event attaches
    // its checks to the commit on `main`, so a skip there costs no PR anything —
    // but only because the gate is unconditionally true for a PR. If that ever
    // becomes conditional, every PR touching the four lane-definition paths
    // grows a greyed check and the requirement is gone.
    expect(membershipJob).toMatch(/EVENT_NAME[\s\S]*=[\s\S]*'pull_request'/);
    expect(membershipJob).toMatch(/RUN=true/);
  });

  it('TESTS on main and never publishes there', () => {
    // Publishing SUPERSEDES a story's evidence (MOTIR-1937), and a merge is not
    // a new moment to record. Since MOTIR-7253 the lane publishes again, so the
    // property is held by TWO mechanisms, and both are asserted: EVERY step that
    // runs the uploader is `if:`-gated to `pull_request`, and the owned-spec list
    // a `push` emits is EMPTY, which the uploader fails closed on. (Between
    // MOTIR-4096 and MOTIR-7253 it held structurally — there was no publisher.)
    const job = codeOf(acceptanceJob!);
    const publishers = job
      .split(/^ {6}- /m)
      .slice(1)
      .filter((s) => /upload-acceptance-video|upload-acceptance-video\.mjs/.test(s));
    expect(publishers.length).toBeGreaterThan(0);
    for (const step of publishers) {
      expect(step).toMatch(/^\s*if:.*github\.event_name == 'pull_request'/m);
    }
    expect(job).toMatch(
      /if \[ -z "\$\{BASE_SHA\}" \]; then[\s\S]*?echo "specs=" >> "\$GITHUB_OUTPUT"/,
    );
    // No other job in the workflow touches the publish routes.
    for (const [id, body] of jobsOf(acceptanceWorkflow)) {
      if (id === 'acceptance') continue;
      expect(codeOf(body)).not.toMatch(/upload-acceptance-video|acceptance-evidence/);
    }
    // The baseline still RUNS the specs — that is the whole point of MOTIR-2760,
    // and a workflow that published nothing because it did nothing would pass
    // every line above.
    expect(acceptanceJob).toContain('pnpm test:e2e --config playwright.acceptance.config.ts');
  });

  it('cancels superseded runs on a PR but NEVER on main', () => {
    // The baseline's product is knowing WHICH merge broke the lane. Blanket
    // `cancel-in-progress: true` would have back-to-back merges cancel each
    // other and hand back exactly the ambiguity this trigger removes. Same
    // expression, and the same assertion, as `tests/ci-fly-deploy.test.ts` —
    // deliberately one idiom, not two.
    expect(codeOf(acceptanceWorkflow)).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    );
  });
});

// ── MOTIR-4095 ───────────────────────────────────────────────────────────────
//
// The guard above is necessary and was never sufficient. `cancel-in-progress`
// governs the run that is EXECUTING; GitHub holds one PENDING run per group and
// EVICTS the queued one when a third event arrives. Every push to `main` shares
// `github.ref`, so a merge burst destroyed the middle baselines before they ran
// a job — 23 of the last 100 `push: main` runs, all `cancelled`, all with zero
// jobs, each at the instant the next merge's run was created.
//
// These assertions RESOLVE the shipped expression instead of describing it, for
// the reason the MOTIR-2908 block gives: the group is arithmetic over a context,
// and a regex that agrees with a per-commit group agrees just as happily with a
// per-ref one. What has to be true is a PROPERTY of the resolved values.
describe('a push is grouped per COMMIT, so no baseline is ever evicted (MOTIR-4095)', () => {
  const FIRST = 'a9936655b1c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4';
  const SECOND = 'deb99250c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';

  it('finds the workflow-level concurrency block it is meant to guard', () => {
    // The negative control: a restructure that moved the block under a job, or
    // dropped it, would otherwise make every assertion below pass vacuously.
    expect(acceptanceHeader).toMatch(/^concurrency:\s*$/m);
    expect(acceptanceHeader).not.toContain('jobs:');
    expect(concurrencySetting('group')).toContain('${{');
  });

  it('puts two merges to main in DIFFERENT groups', () => {
    // The defect, stated as a predicate. Two pushes at different shas sharing a
    // group is exactly the condition under which GitHub queues the second and
    // evicts it when a third arrives.
    const main = 'refs/heads/main';
    expect(resolvedGroup('push', main, FIRST)).not.toBe(resolvedGroup('push', main, SECOND));
  });

  it('varies a push group by the SHA and not by anything else', () => {
    // Stronger than "they differ": the group must actually CARRY the commit, so
    // a future rewrite cannot satisfy the test above with an unrelated varying
    // value (a run id, a timestamp) that leaves two events at one sha apart.
    const main = 'refs/heads/main';
    expect(resolvedGroup('push', main, FIRST)).toContain(FIRST);
    expect(resolvedGroup('push', main, FIRST)).toBe(resolvedGroup('push', main, FIRST));
  });

  it('leaves PR behaviour exactly as it was — one group per ref, newest wins', () => {
    // The saving MOTIR-2760 wanted is per-REF on a pull request: two pushes to
    // one PR branch share a group, and `cancel-in-progress` then supersedes the
    // older run. `github.ref` is `refs/pull/<n>/merge` there, so a PR cancels
    // only itself.
    const pr = 'refs/pull/2501/merge';
    expect(resolvedGroup('pull_request', pr, FIRST)).toBe(
      resolvedGroup('pull_request', pr, SECOND),
    );
    expect(resolvedGroup('pull_request', pr, FIRST)).toContain(pr);
    expect(resolvedCancel('pull_request', pr, FIRST)).toBe('true');
    expect(resolvedCancel('push', 'refs/heads/main', FIRST)).toBe('false');
  });

  it('never lets a push and a pull request collide in one group', () => {
    // The two arms are the same string on both events only if the expression
    // has stopped distinguishing them, which is the fault this card fixed.
    expect(resolvedGroup('push', 'refs/heads/main', FIRST)).not.toBe(
      resolvedGroup('pull_request', 'refs/heads/main', FIRST),
    );
  });

  it('refuses to evaluate an expression it does not understand', () => {
    // The evaluator is the instrument, so its own failure mode is asserted: a
    // silent `undefined` would make every group above compare equal-to-equal
    // and the suite would go green on a workflow nobody had checked.
    expect(() =>
      resolveTemplate('${{ fromJSON(github.ref) }}', contextFor('push', 'r', 's')),
    ).toThrow();
    expect(() => resolveTemplate('${{ github.actor }}', contextFor('push', 'r', 's'))).toThrow(
      /fabricated context/,
    );
    expect(() => resolveTemplate('no expression here', contextFor('push', 'r', 's'))).toThrow();
  });
});

// ── MOTIR-2908 ───────────────────────────────────────────────────────────────
//
// The leg count is DERIVED from the lane's membership instead of fixed at four.
// `4` was right for the 26-spec lane MOTIR-2600 measured and stopped being right
// six days later, when MOTIR-2765 gave an acceptance spec a lifecycle and
// MOTIR-2769 triaged every member out: a leg is ~3 machine-minutes of pure setup,
// so four legs over a lane holding nothing is three copies of a checkout, a
// Postgres, a Playwright install and an artifact download, drawing no tests.
//
// ⚠️ THESE ASSERTIONS RUN THE SHIPPED SHELL — they do not describe it. Every
// other guard in this file is a text match, which is the right tool for a
// STRUCTURE (a `needs:` edge, an artifact name) and the wrong one for
// ARITHMETIC: a regex that agrees with `LEGS="${COUNT}"` agrees just as happily
// with an off-by-one, and the floor and the cap are exactly where an off-by-one
// would sit. So the gate step's `run:` block is extracted from the workflow and
// executed by `bash` against a fabricated lane, and the outputs it writes to
// `$GITHUB_OUTPUT` are read back — the same mechanism the runner uses.
describe('the shard count is DERIVED from the lane (MOTIR-2908)', () => {
  const membershipJob = jobsOf(acceptanceWorkflow).get('membership');

  /**
   * The `gate` step's `run: |` block, dedented — the literal script the runner
   * executes. Anchored on `id: gate` so a second `run:` block in the job cannot
   * be picked up by accident.
   */
  const gateScript = ((): string => {
    const lines = acceptanceWorkflow.split('\n');
    const gateAt = lines.findIndex((l) => /^\s*- id: gate\s*$/.test(l));
    expect(gateAt).toBeGreaterThan(-1);
    const runAt = lines.findIndex((l, i) => i > gateAt && /^\s*run: \|\s*$/.test(l));
    expect(runAt).toBeGreaterThan(gateAt);
    const indent = /^ */.exec(lines[runAt + 1]!)![0].length;
    const body: string[] = [];
    for (const line of lines.slice(runAt + 1)) {
      if (line.trim() !== '' && /^ */.exec(line)![0].length < indent) break;
      body.push(line.slice(indent));
    }
    return body.join('\n');
  })();

  /**
   * The KEY SET `GET /repos/{owner}/{repo}/pulls/{n}/files` actually returns,
   * measured rather than remembered (moooon-B-V/motir-core#2578, 2026-09-04):
   *
   *   $ gh api "repos/moooon-B-V/motir-core/pulls/2578/files" --jq '.[0] | keys'
   *   ["additions","blob_url","changes","contents_url","deletions","filename",
   *    "patch","raw_url","sha","status"]
   *
   * ⚠️ `path` IS NOT IN IT, and the absence is the fixture's entire content. The
   * assertion below pins the set so that the obvious way to make a red case
   * green — teaching the fixture a `path` key — fails here instead, naming what
   * it is doing. `gh pr view --json files` is where the other name comes from:
   * that is gh's own normalised projection over the same pull request, and it
   * does call the field `path`.
   */
  const PR_FILE_KEYS = [
    'additions',
    'blob_url',
    'changes',
    'contents_url',
    'deletions',
    'filename',
    'patch',
    'raw_url',
    'sha',
    'status',
  ] as const;

  /** One entry of that payload. Only `filename` carries information here. */
  const prFile = (filename: string): Record<string, unknown> => ({
    additions: 1,
    blob_url: `https://github.com/moooon-B-V/motir-core/blob/deadbeef/${filename}`,
    changes: 1,
    contents_url: `https://api.github.com/repos/moooon-B-V/motir-core/contents/${filename}`,
    deletions: 0,
    filename,
    patch: '@@ -0,0 +1 @@\n+x',
    raw_url: `https://github.com/moooon-B-V/motir-core/raw/deadbeef/${filename}`,
    sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    status: 'modified',
  });

  const PR_FILES_FIXTURE = 'pr-files.json';

  /**
   * The `gh` stub: `gh api <endpoint> [--paginate] -q <expr>`.
   *
   * Three behaviours, each of them load-bearing:
   *
   *  1. IT APPLIES THE SELECTOR to the fixture above, so the field the gate asks
   *     for is the field it gets. A key the payload does not carry yields an
   *     EMPTY LINE — which is what `gh`'s jq does, measured, and not what plain
   *     `jq -r` does (that prints the four letters `null`). The distinction is
   *     the defect: empty lines are what let `grep -c .` report 0 while the
   *     command looked like it had answered.
   *  2. IT PAGES. `pulls/N/files` returns 30 entries a page and only yields the
   *     rest when asked to follow them, so the pagination case below is a test
   *     of `--paginate` rather than of the stub's generosity.
   *  3. IT FAILS CLOSED. Anything outside `.[].<field>` — a pipe, a `select`, a
   *     second endpoint — exits non-zero with a message telling the reader to
   *     teach the stub. A stub that shrugged and printed something plausible
   *     would be this card's own defect, one layer out.
   *
   * Written for plain node (no extension, no deps) because it has to run from a
   * `PATH` entry inside a temp directory, where neither this repo's toolchain
   * nor `jq` can be assumed.
   */
  const GH_STUB = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { readFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    'const args = process.argv.slice(2);',
    'const die = (m) => { process.stderr.write(`gh stub: ${m}\\n`); process.exit(1); };',
    "if (args[0] !== 'api') die(`only \\`gh api\\` is stubbed; got: ${args.join(' ')}`);",
    'if (!/\\/pulls\\/\\d+\\/files$/.test(args[1] || ""))',
    '  die(`only the pull-request files endpoint is stubbed; got: ${args[1]}`);',
    "const qAt = args.findIndex((a) => a === '-q' || a === '--jq');",
    'if (qAt === -1 || !args[qAt + 1]) die("the gate must select a field with -q/--jq");',
    'const expr = args[qAt + 1];',
    'const field = /^\\.\\[\\]\\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr);',
    'if (!field) die(`this stub understands only \\`.[].<field>\\`, and the gate asked for ` +',
    '  `\\`${expr}\\` — teach the stub rather than loosening it`);',
    `const all = JSON.parse(readFileSync(join(__dirname, '${PR_FILES_FIXTURE}'), 'utf8'));`,
    "const page = args.includes('--paginate') ? all : all.slice(0, 30);",
    'const key = field[1];',
    "process.stdout.write(page.map((f) => (f[key] == null ? '' : String(f[key]))).join('\\n'));",
    "if (page.length) process.stdout.write('\\n');",
    '',
  ].join('\n');

  /**
   * A `seq` that behaves like macOS's BSD one (MOTIR-5364): `-s SEP` puts the
   * separator after the LAST number too, so `seq -s, 1 3` prints `1,2,3,`.
   * GNU `seq` — what CI's Linux runners have — prints `1,2,3`. Planted on PATH
   * by the case that proves the gate's shard list does not depend on which one
   * the machine carries; every other case runs the host's own `seq`.
   */
  const BSD_SEQ_STUB = [
    '#!/usr/bin/env bash',
    "sep=$'\\n'",
    'if [ "$1" = "-s" ]; then sep="$2"; shift 2',
    'elif [[ "$1" == -s* ]]; then sep="${1#-s}"; shift; fi',
    'if [ "$#" -eq 1 ]; then first=1; last="$1"; else first="$1"; last="$2"; fi',
    'for ((i = first; i <= last; i++)); do printf "%s%s" "$i" "$sep"; done',
    "if [ \"$sep\" != $'\\n' ]; then printf '\\n'; fi",
    '',
  ].join('\n');

  /**
   * Run the shipped gate over a lane holding `specCount` members.
   *
   * Since MOTIR-4257 the `pull_request` arm also reads the PR's CHANGED FILES,
   * so the harness stubs `gh` on PATH with a script that SERVES THE ENDPOINT'S
   * REAL PAYLOAD and applies the gate's own `--jq` selector to it. Without a
   * stub the gate exits non-zero under `set -e` and every case below fails for
   * the wrong reason.
   *
   * ⚠️ THE STUB APPLIES THE SELECTOR, AND THAT IS THE WHOLE POINT OF IT
   * (MOTIR-4327). Until this card it printed `changedFiles` verbatim, one path
   * per line, whatever `-q` expression the gate passed — so every case in this
   * describe answered the same way for `.[].path`, `.[].filename` and
   * `.[].nonsense`, and the field name the gate reads was the one thing these
   * assertions could not see. The gate shipped asking for `.[].path`, which the
   * endpoint does not return; `gh`'s jq prints an empty line rather than an
   * error for a missing key, so the grep matched nothing and RUN was `false` on
   * EVERY pull request while these tests stayed green. A stub that answers
   * whatever it is asked turns the suite around it into a tautology, so this one
   * holds the API's real object shape and FAILS CLOSED on any selector it does
   * not understand rather than guessing.
   *
   * `changedFiles` defaults to a lane member, so the existing sizing cases keep
   * asking what they always asked — how many legs — rather than accidentally
   * testing the new filter.
   */
  function runGate(
    specCount: number,
    eventName: 'pull_request' | 'push' | 'merge_group',
    changedFiles: readonly string[] = ['tests/e2e/acceptance-story-1.spec.ts'],
    {
      bsdSeq = false,
      mergeDiff,
      regressionSpecs = 0,
    }: { bsdSeq?: boolean; mergeDiff?: readonly string[]; regressionSpecs?: number } = {},
  ): Record<string, string> & { stdout: string; summary: string } {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-gate-'));
    try {
      const binDir = join(dir, 'stub-bin');
      mkdirSync(binDir, { recursive: true });
      if (bsdSeq) {
        writeFileSync(join(binDir, 'seq'), BSD_SEQ_STUB);
        chmodSync(join(binDir, 'seq'), 0o755);
      }
      // The payload the endpoint would return for this PR, in its real shape.
      writeFileSync(
        join(binDir, PR_FILES_FIXTURE),
        JSON.stringify(changedFiles.map(prFile), null, 2),
      );
      writeFileSync(join(binDir, 'gh'), GH_STUB);
      chmodSync(join(binDir, 'gh'), 0o755);
      mkdirSync(join(dir, 'tests/e2e'), { recursive: true });
      for (let i = 1; i <= specCount; i++) {
        writeFileSync(join(dir, `tests/e2e/acceptance-story-${i}.spec.ts`), '');
      }
      // The regression lane's members (MOTIR-9411), counted by the same step.
      for (let i = 1; i <= regressionSpecs; i++) {
        writeFileSync(join(dir, `tests/e2e/regression-story-${i}.spec.ts`), '');
      }
      // A member of the MAIN lane, not this one: `testMatch` is on the BASENAME,
      // so `acceptance` must be a PREFIX. Counting it would hold the baseline
      // permanently on — and, now, would also over-size the fan-out.
      writeFileSync(join(dir, 'tests/e2e/epic2-acceptance.spec.ts'), '');
      const outPath = join(dir, 'github-output');
      const summaryPath = join(dir, 'github-step-summary');
      writeFileSync(outPath, '');
      writeFileSync(summaryPath, '');
      // A real two-commit repository for a queue entry: the base, then a head
      // that changes exactly `mergeDiff`, so the gate's `git diff` is the real one.
      const mergeEnv: Record<string, string> = {};
      if (mergeDiff) {
        const git = (...args: string[]) =>
          execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
            cwd: dir,
            stdio: 'pipe',
            encoding: 'utf8',
          }).trim();
        git('init', '-q');
        git('add', 'tests');
        git('commit', '-q', '-m', 'base');
        mergeEnv.MERGE_BASE_SHA = git('rev-parse', 'HEAD');
        for (const f of mergeDiff) {
          mkdirSync(join(dir, f, '..'), { recursive: true });
          writeFileSync(join(dir, f), `changed ${f}`);
        }
        git('add', '-A', '--', ...mergeDiff);
        git('commit', '-q', '-m', 'head');
        mergeEnv.MERGE_HEAD_SHA = git('rev-parse', 'HEAD');
      }
      let stdout: string;
      try {
        stdout = execFileSync('bash', ['-c', gateScript], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            GITHUB_REPOSITORY: 'moooon-B-V/motir-core',
            PR_NUMBER: '1',
            MERGE_BASE_SHA: '',
            MERGE_HEAD_SHA: '',
            ...mergeEnv,
            EVENT_NAME: eventName,
            GITHUB_OUTPUT: outPath,
            GITHUB_STEP_SUMMARY: summaryPath,
          },
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (error) {
        // `execFileSync`'s own message is the command line and an exit code, and
        // the stub's refusal (an unrecognised selector, a second endpoint) is the
        // thing a reader needs. Surface it or the failure reads as "bash died".
        const { stderr, stdout: out } = error as { stderr?: string; stdout?: string };
        throw new Error(
          `the gate exited non-zero\n--- stderr ---\n${stderr ?? ''}\n--- stdout ---\n${out ?? ''}`,
        );
      }
      const outputs = Object.fromEntries(
        readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)] as const;
          }),
      ) as Record<string, string>;
      // `stdout` carries the two lines the job LOG shows a human — the spec count
      // and `changed files: N` — which is the surface the defect was first read
      // off, so it is returned rather than discarded.
      return { ...outputs, stdout, summary: readFileSync(summaryPath, 'utf8') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('publishes the derived fan-out as job outputs', () => {
    // A `steps.*` output is only readable by another job if the JOB re-exports
    // it. Without these two lines the matrix expression below resolves to the
    // empty string and the shard job produces no legs at all.
    expect(membershipJob).toMatch(/^\s*shards:\s*\$\{\{\s*steps\.gate\.outputs\.shards\s*\}\}/m);
    expect(membershipJob).toMatch(/^\s*legs:\s*\$\{\{\s*steps\.gate\.outputs\.legs\s*\}\}/m);
  });

  it('interpolates nothing into the gate script', () => {
    // The script reads its one variable input through `env:` (`EVENT_NAME`). A
    // `${{ }}` inside the `run:` body would be substituted by the runner before
    // bash ever sees it — which would make the executed-script assertions below
    // test something the runner does not run, and is the shape script injection
    // takes in a workflow.
    expect(gateScript).not.toContain('${{');
    expect(membershipJob).toContain('EVENT_NAME: ${{ github.event_name }}');
  });

  it.each([
    { specs: 0, legs: 1 },
    { specs: 1, legs: 1 },
    { specs: 2, legs: 2 },
    { specs: 3, legs: 3 },
    { specs: 4, legs: 4 },
    { specs: 6, legs: 6 },
    { specs: 9, legs: 9 },
    { specs: 10, legs: 10 },
    { specs: 11, legs: 11 },
    { specs: 14, legs: 14 },
    { specs: 15, legs: 14 },
    { specs: 26, legs: 14 },
    { specs: 87, legs: 14 },
    { specs: 157, legs: 14 },
  ])('sizes a $specs-spec lane to $legs leg(s)', ({ specs, legs }) => {
    const out = runGate(specs, 'pull_request');
    expect(out.count).toBe(String(specs));
    expect(out.legs).toBe(String(legs));
    // The matrix reads `shards` through `fromJSON`, so it must be a JSON array —
    // and it must enumerate exactly the legs the denominator promises, or
    // Playwright is handed a shard index outside its own partition.
    expect(JSON.parse(out.shards!)).toEqual(Array.from({ length: legs }, (_, i) => i + 1));
  });

  it('gives a grown lane the full fourteen legs at the cap (MOTIR-7054 · MOTIR-9352 · MOTIR-9220)', () => {
    // THE regression this cap exists to prevent: a lane that fills up must get
    // its full parallelism back, not a serial run. MOTIR-2600 sized four legs
    // for 26 specs. At 87 specs those four ran into the shard job's then 40-minute
    // timeout, and a green leg was cancelled out of the merge queue, so the cap
    // became six. At 156 specs the sixth of six legs ran 51 min of tests and was
    // cancelled at the 55-minute timeout, so the cap became ten. At 157 specs
    // leg 9/10 ran 42 min of tests and was cancelled the same way, so it is 14.
    expect(runGate(157, 'pull_request').shards).toBe('[1,2,3,4,5,6,7,8,9,10,11,12,13,14]');
    expect(runGate(14, 'push').shards).toBe('[1,2,3,4,5,6,7,8,9,10,11,12,13,14]');
    expect(runGate(10, 'push').shards).toBe('[1,2,3,4,5,6,7,8,9,10]');
    expect(runGate(6, 'push').shards).toBe('[1,2,3,4,5,6]');
    expect(runGate(4, 'push').shards).toBe('[1,2,3,4]');
  });

  it.each([1, 2, 4, 6, 10, 14])(
    'emits a valid %i-leg shard list under BSD `seq` too — no trailing separator (MOTIR-5364)',
    (legs) => {
      // The gate used `seq -s,`, which on macOS prints `1,` — so the list was
      // `[1,]`, not JSON, and nine cases here were red on every Mac while CI's
      // GNU `seq` kept them green. The workflow runs on Linux only, but this
      // file runs the workflow's own snippet on whatever machine runs the
      // tests, so the snippet has to be portable, not the test tolerant.
      const out = runGate(legs, 'pull_request', undefined, { bsdSeq: true });
      expect(out.legs).toBe(String(legs));
      expect(JSON.parse(out.shards!)).toEqual(Array.from({ length: legs }, (_, i) => i + 1));
    },
  );

  it('floors an empty lane at ONE leg, and only on a PR', () => {
    // A `push` against an empty lane never reaches the fan-out at all — the
    // MOTIR-2760 gate stops at the ~10s membership job — so the floor is about
    // the PR case: a lane-definition PR runs no tests either way, and the one
    // leg is what still proves the harness BOOTS. Zero legs would prove nothing
    // on precisely the PRs whose subject is this lane.
    const push = runGate(0, 'push');
    expect(push.run).toBe('false');
    expect(push.legs).toBe('1');

    const pr = runGate(0, 'pull_request');
    expect(pr.run).toBe('true');
    expect(pr.legs).toBe('1');
    expect(pr.shards).toBe('[1]');
  });

  it('counts the lane the Playwright config would collect, not the word', () => {
    // Every case above plants an `epic2-acceptance.spec.ts` decoy; this is the
    // one that reads it. A `*acceptance*` match would count it and size a
    // one-spec lane to two legs — and hold the `push` baseline permanently on.
    expect(runGate(0, 'push').count).toBe('0');
    expect(runGate(1, 'pull_request').count).toBe('1');
  });

  // ── The SELECTOR, executed (MOTIR-4327) ────────────────────────────────────
  //
  // The paths decision below is only worth anything if the gate can SEE the
  // changed files, and for half a day it could not: it asked the API for a key
  // the API does not return, got one blank line per file, and answered `false`
  // on every pull request while printing a summary saying it had looked at the
  // diff. These three cases are about the reading, not about the matching.
  it('reads a field the pull-request-files API actually returns', () => {
    // The card's own symptom, at the surface it was read off: the job log's
    // `changed files:` line. With `.[].path` it says 0 for every PR ever opened.
    const files = ['components/x.tsx', 'lib/dto/y.ts', 'tests/e2e/acceptance-story-1.spec.ts'];
    const out = runGate(1, 'pull_request', files);
    expect(out.stdout).toContain(`changed files: ${files.length}`);
    expect(out.stdout).toContain('event=pull_request run=true');
    expect(out.run).toBe('true');
  });

  it('never tells a pull request it was considered when it was not', () => {
    // The expensive half of the defect was not the missing lane run — it was the
    // job summary asserting, on a PR that touches a spec, that the gate had
    // looked at the diff and found nothing. A guard whose input is empty by
    // construction has not reached `false`, it has only ever had one answer.
    const skipped = runGate(1, 'pull_request', ['components/x.tsx']);
    expect(skipped.run).toBe('false');
    expect(skipped.summary).toContain('This PR touches no acceptance spec');

    const owned = runGate(1, 'pull_request', ['tests/e2e/acceptance-story-1.spec.ts']);
    expect(owned.run).toBe('true');
    expect(owned.summary).not.toContain('This PR touches no acceptance spec');
  });

  it('holds the fixture to the API’s real key set — `filename`, and no `path`', () => {
    // Non-vacuity for everything above, and the reason it is an assertion rather
    // than a comment: the cheapest way to turn a red case here green is to teach
    // the fixture the key the gate happens to ask for, and that would restore a
    // suite agreeing with a workflow that reads nothing. Measured with
    // `gh api "repos/moooon-B-V/motir-core/pulls/2578/files" --jq '.[0] | keys'`.
    const sample = prFile('tests/e2e/acceptance-story-1.spec.ts');
    expect(Object.keys(sample).sort()).toEqual([...PR_FILE_KEYS].sort());
    expect(sample.filename).toBe('tests/e2e/acceptance-story-1.spec.ts');
    expect(sample).not.toHaveProperty('path');
  });

  it('the stub DISCRIMINATES between selectors, and refuses the ones it cannot run', () => {
    // The other half of non-vacuity, and the half the previous stub failed: a
    // harness that answers the same way for every selector cannot report on the
    // selector, so its agreement with the workflow means nothing. Drive the stub
    // directly, over the two expressions that separate a working gate from the
    // shipped one, plus a third it must refuse rather than guess at.
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-gh-stub-'));
    try {
      const stub = join(dir, 'gh');
      writeFileSync(join(dir, PR_FILES_FIXTURE), JSON.stringify(['a.ts', 'b.ts'].map(prFile)));
      writeFileSync(stub, GH_STUB);
      chmodSync(stub, 0o755);
      const ask = (expr: string): string =>
        execFileSync(
          process.execPath,
          [stub, 'api', 'repos/moooon-B-V/motir-core/pulls/1/files', '--paginate', '-q', expr],
          { encoding: 'utf8', stdio: 'pipe' },
        );

      expect(ask('.[].filename')).toBe('a.ts\nb.ts\n');
      // ⚠️ EMPTY LINES, not the literal `null` that plain `jq -r` prints. This is
      // the shape the defect hid in: `grep -c .` counts 0 and the command looks
      // as though it answered. Measured against real `gh` on #2578 — five
      // changed files, five blank lines, `grep -c .` → 0.
      expect(ask('.[].path')).toBe('\n\n');
      expect(() => ask('.[] | select(.status == "added") | .filename')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── The PATHS decision, executed (MOTIR-4257) ──────────────────────────────
  //
  // These run the shipped gate over a fabricated changed-file list. The arm that
  // says `false` is the one no PR touching this workflow can ever exercise on
  // itself — a PR that edits `acceptance-tests.yml` matches by definition — so
  // it is only ever checked here.
  it.each([
    { why: 'an ordinary feature PR', files: ['components/x.tsx', 'lib/dto/y.ts'], run: 'false' },
    { why: 'a main-lane spec', files: ['tests/e2e/epic2-acceptance.spec.ts'], run: 'false' },
    { why: 'a nested lookalike', files: ['tests/e2e/sub/acceptance-x.spec.ts'], run: 'false' },
    { why: 'a docs lookalike', files: ['docs/acceptance-tests.yml'], run: 'false' },
    {
      why: 'a PR that owns a spec',
      files: ['components/x.tsx', 'tests/e2e/acceptance-story-1.spec.ts'],
      run: 'true',
    },
    { why: 'a lane restructure', files: ['.github/workflows/acceptance-tests.yml'], run: 'true' },
    { why: 'the Playwright config', files: ['playwright.acceptance.config.ts'], run: 'true' },
    {
      why: 'a helper the specs import',
      files: ['tests/e2e/_helpers/acceptance-video.ts'],
      run: 'true',
    },
    {
      why: 'a helper the specs import',
      files: ['tests/e2e/_helpers/acceptance-diagnostics.ts'],
      run: 'true',
    },
  ])('$why → run=$run', ({ files, run }) => {
    expect(runGate(1, 'pull_request', files).run).toBe(run);
  });

  it('sees a spec that sorts past the API\u2019s first page', () => {
    // ⚠️ WHY `--paginate` IS LOAD-BEARING. `pulls/N/files` returns 30 entries a
    // page. A PR whose only acceptance spec sorts onto page two would read as
    // touching nothing, skip the lane, and merge unchecked — the exact silent
    // false negative MOTIR-4257 exists to remove, reappearing through the fix.
    const buried = [
      ...Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`),
      'tests/e2e/acceptance-story-1.spec.ts',
    ];
    expect(runGate(1, 'pull_request', buried).run).toBe('true');
  });

  it('runs the queue entry only when ITS diff touches the lane; the baseline always', () => {
    // The queue used to run the whole lane on every entry (~60 min against a
    // 60-min check timeout). It now reads the entry's own base...head diff, like
    // a pull request does; `push` still runs whenever the lane holds a spec, so
    // the composed tree is checked after the merge by the main baseline.
    const untouched = ['components/planning/ProposalPeek.tsx'];
    expect(runGate(1, 'merge_group', undefined, { mergeDiff: untouched }).run).toBe('false');
    expect(
      runGate(1, 'merge_group', undefined, {
        mergeDiff: [...untouched, 'tests/e2e/acceptance-story-1.spec.ts'],
      }).run,
    ).toBe('true');
    expect(
      runGate(1, 'merge_group', undefined, { mergeDiff: ['playwright.acceptance.config.ts'] }).run,
    ).toBe('true');
    expect(runGate(1, 'push', untouched).run).toBe('true');
    // …and an EMPTY lane still stops early on both, which is MOTIR-2760 intact.
    expect(runGate(0, 'merge_group', undefined, { mergeDiff: untouched }).run).toBe('false');
    expect(runGate(0, 'push', untouched).run).toBe('false');
  });

  it('FAILS OPEN for a queue entry whose diff cannot be read', () => {
    // No shas in the payload (or no git history): an unclassifiable entry runs
    // the lane rather than being skipped.
    expect(runGate(1, 'merge_group', ['components/x.tsx']).run).toBe('true');
  });

  // ── The REGRESSION lane's gate (MOTIR-9411) ─────────────────────────────
  // The done stories' specs keep the acceptance lane's triggers. These cases
  // run the same executed step, so a regression gate that drifted from those
  // triggers — onto every PR, or off `main` — goes red here.
  describe("the regression lane keeps the acceptance lane's triggers (MOTIR-9411)", () => {
    const appOnly = ['components/x.tsx', 'lib/dto/y.ts'];

    it('runs on a push to main, sized at one leg per spec up to ten', () => {
      const small = runGate(0, 'push', appOnly, { regressionSpecs: 3 });
      expect(small.regression_run).toBe('true');
      expect(small.regression_count).toBe('3');
      expect(small.regression_legs).toBe('3');
      expect(JSON.parse(small.regression_shards!)).toEqual([1, 2, 3]);
      const big = runGate(0, 'push', appOnly, { regressionSpecs: 154 });
      expect(big.regression_legs).toBe('10');
      expect(JSON.parse(big.regression_shards!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('stays off an ordinary pull request, and runs on one that touches the lane', () => {
      expect(runGate(0, 'pull_request', appOnly, { regressionSpecs: 5 }).regression_run).toBe(
        'false',
      );
      for (const touched of [
        'tests/e2e/regression-story-1.spec.ts',
        'playwright.regression.config.ts',
        'playwright.acceptance.config.ts',
        'tests/e2e/_helpers/promoted-regression.ts',
        '.github/actions/e2e-setup/action.yml',
      ]) {
        expect(
          runGate(0, 'pull_request', [...appOnly, touched], { regressionSpecs: 5 }).regression_run,
          touched,
        ).toBe('true');
      }
    });

    it('gates a queue entry on its own diff, and fails open without one', () => {
      expect(
        runGate(0, 'merge_group', undefined, { regressionSpecs: 5, mergeDiff: appOnly })
          .regression_run,
      ).toBe('false');
      expect(
        runGate(0, 'merge_group', undefined, {
          regressionSpecs: 5,
          mergeDiff: [...appOnly, 'tests/e2e/regression-story-2.spec.ts'],
        }).regression_run,
      ).toBe('true');
      expect(runGate(0, 'merge_group', appOnly, { regressionSpecs: 5 }).regression_run).toBe(
        'true',
      );
    });

    it('runs nothing when the lane is empty, and leaves the acceptance gate as it was', () => {
      const empty = runGate(0, 'push', appOnly);
      expect(empty.regression_run).toBe('false');
      expect(empty.regression_legs).toBe('1');
      const both = runGate(2, 'push', appOnly, { regressionSpecs: 4 });
      expect(both.run).toBe('true');
      expect(both.count).toBe('2');
      expect(both.regression_count).toBe('4');
    });
  });
});

describe("the regression lane's jobs (MOTIR-9411)", () => {
  const jobs = jobsOf(acceptanceWorkflow);
  const regressionBuild = jobs.get('regression-build');
  const regression = jobs.get('regression');
  const complete = jobs.get('acceptance-complete');

  it('builds once for its own shards, under its own artifact name', () => {
    expect(regressionBuild).toBeDefined();
    expect(regressionBuild).toMatch(
      /^\s*if:\s*needs\.membership\.outputs\.regression_run == 'true'\s*$/m,
    );
    expect(regressionBuild).toMatch(/name:\s*next-build-regression\s*$/m);
    expect(regression).toMatch(/needs:\s*\[membership, regression-build\]/);
    expect(regression).toMatch(/next-build-artifact:\s*next-build-regression\s*$/m);
  });

  it('runs the regression config on its own shard count, and publishes nothing', () => {
    expect(regression).toContain('--config playwright.regression.config.ts');
    expect(regression).toContain('needs.membership.outputs.regression_shards');
    expect(regression).toContain(
      '--shard=${{ matrix.shard }}/${{ needs.membership.outputs.regression_legs }}',
    );
    expect(codeOf(regression!)).not.toContain('upload-acceptance-video');
    expect(codeOf(regression!)).not.toContain('id-token');
  });

  it('is part of the required aggregate', () => {
    expect(complete).toMatch(
      /needs:\s*\[membership, build, acceptance, regression-build, regression\]/,
    );
  });
});

describe('the shared E2E setup composite (MOTIR-1949)', () => {
  const action = readFileSync(SETUP_ACTION_PATH, 'utf8');

  it('is used by BOTH Playwright lanes', () => {
    // The two lanes must not drift: every past setup fix in here was hard-won
    // (MOTIR-1679's apt-source removal, MOTIR-1706's build-artifact download).
    expect(e2eBody).toContain(SETUP_ACTION_REF);
    expect(acceptanceJob).toContain(SETUP_ACTION_REF);
  });

  it('offers both `.next/` sources, and each lane takes the one it can reach', () => {
    // A separate workflow cannot read ANOTHER workflow's artifacts — which is
    // why the `build` input exists at all. It can read its OWN run's, so since
    // MOTIR-2600 the acceptance lane builds once in its own `build` job and its
    // four shards download that, rather than each compiling `.next/` itself.
    expect(action).toMatch(/^\s*next-build:/m);
    expect(action).toContain("if: inputs.next-build == 'download'");
    expect(action).toContain("if: inputs.next-build == 'build'");
    expect(acceptanceJob).toMatch(/next-build:\s*download/);
    expect(acceptanceJob).not.toMatch(/next-build:\s*build/);
    expect(codeOf(e2eBody!)).not.toMatch(/next-build:/); // the default: download
  });

  it('is a composite action whose run steps declare a shell', () => {
    expect(action).toMatch(/using:\s*composite/);
    // A composite `run:` without `shell:` is a load-time error for every caller.
    const steps = action.split(/^\s{4}- /m).slice(1);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      if (/(^|\n)\s*run:/.test(step)) expect(step).toMatch(/shell:\s*bash/);
    }
  });

  it('carries the setup the lanes depend on', () => {
    // The pre-built .next/ (MOTIR-1706), under the name its `build` job uploads.
    // The name is an input since MOTIR-9411, because this workflow builds once
    // per lane and two artifacts cannot share a name.
    expect(action).toContain('name: ${{ inputs.next-build-artifact }}');
    expect(action).toMatch(/next-build-artifact:[\s\S]*?default: next-build\n/);
    expect(action).toContain('pnpm prisma migrate deploy');
    expect(action).toContain('packages.microsoft.com'); // MOTIR-1679
    // ⚠️ `--with-deps` is GONE, deliberately (MOTIR-3128). It bolted an apt
    // round-trip onto a CDN download, so the browser install took both failure
    // domains at once; the OS deps are now installed only when the probe below
    // finds them missing. The browser download itself is what this lane needs
    // from the step, and that is what is asserted.
    expect(action).toContain('playwright install chromium');
    expect(action).not.toContain('playwright install --with-deps');
    expect(action).toContain('needs-deps');
  });

  it('leaves checkout and Postgres to the caller', () => {
    // A local action cannot run before the repo is checked out, and the DB
    // container's lifetime belongs where its DATABASE_URL is set. (Both are
    // named in the action's prose, so match the `uses:` that would run them.)
    expect(action).not.toMatch(/^\s*-?\s*uses:\s*actions\/checkout/m);
    expect(action).not.toMatch(/^\s*-?\s*uses:\s*\.\/\.github\/actions\/postgres/m);
    for (const body of [e2eBody, acceptanceJob]) {
      expect(body).toMatch(/^\s*-?\s*uses:\s*actions\/checkout/m);
      expect(body).toMatch(/^\s*-?\s*uses:\s*\.\/\.github\/actions\/postgres/m);
    }
  });
});
