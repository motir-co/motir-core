import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Guard for MOTIR-2442: the design-asset guards must run on a `design/*`
// branch, and the branch prefix must still save what it exists to save.
//
// ── The hole ────────────────────────────────────────────────────────────────
// `ci.yml` skips the Vitest, E2E, sandbox and runner-image jobs on
// `seed/` / `design/` / `docs/` branches, because a diff that edits nothing but
// `design/**` has no app code for them to exercise. Two specs in `tests/**`
// read the design ASSETS rather than the app, so for those the skip landed
// exactly backwards: the only pull requests that can break them were the only
// ones that never ran them. MOTIR-2259 merged green on
// `design/MOTIR-2259-roles-permissions`, `main` went red, and it surfaced hours
// later on an unrelated `subtask/*` PR that had touched no design asset
// (MOTIR-2441).
//
// ── The three things that must hold, and why each is here ───────────────────
//   1. The `design-guards` job runs UNCONDITIONALLY. A branch-prefix `if:` on
//      it would restore the hole in one line, and nothing else in the repo
//      would notice — workflow files are not typechecked, linted or executed by
//      any suite.
//   2. The expensive lanes still SKIP on `design/*`. Un-skipping the Playwright
//      matrix or the image builds would "fix" this card by paying the twenty
//      minutes the prefix was created to avoid, and would look like a pass.
//   3. Every spec that reads `design/**` is IN the lane. This is the part a
//      workflow file cannot state: the lane is an explicit `include` list, so
//      the next design-asset guard someone writes is un-run by default. The
//      assertion re-derives the list by scanning `tests/**` rather than
//      restating it, so a new reader fails here instead of shipping unwatched.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-complete-gate.test.ts`, which this file's job-splitting
// helper is taken from.

const ROOT = process.cwd();
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const DESIGN_CONFIG_PATH = join(ROOT, 'vitest.design.config.ts');
const GUARD_JOB = 'design-guards';
const GATE_JOB = 'ci-complete';

const ci = readFileSync(CI_PATH, 'utf8');
const designConfig = readFileSync(DESIGN_CONFIG_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (Copied from `ci-complete-gate.test.ts` — the repo has no YAML
 * parser, and duplicating ten lines beats adding a dependency to read one
 * file.)
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
 * The same text with whole-line comments dropped. Load-bearing here for the
 * same reason it is in the gate test: the job parser attributes a job's leading
 * comment block to the job before it, and these comments quote the very
 * expressions the assertions look for (this file's own header names
 * `startsWith(github.head_ref, 'design/')` in prose).
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const guardCode = codeOf(ciJobs.get(GUARD_JOB) ?? '');

/** Every `*.ts` / `*.tsx` file under `tests/`, as a repo-relative POSIX path. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

/**
 * Does this source build a path INTO the `design/` asset tree?
 *
 * Matching on the path BUILDER rather than the bare string is what makes this
 * total without being noisy. Every read of an asset has to compose the path,
 * and in this repo that is always `join(…)` / `resolve(…)` — while the two
 * things that would otherwise flood the result set do not compose a path at
 * all: `type: 'design'` (a work-item type, in dozens of specs) is a plain
 * value, and `packages/design-system/theme.css` (the token suites) is a quoted
 * string that starts with `packages/`, not `design`.
 *
 * ⚠️ `Promise.resolve(…)` IS EXCLUDED, and it is the one collision the "path
 * builder" idea does not survive on its own (MOTIR-3227). A spec that stubs a
 * GitHub file list — `Promise.resolve([{ filename: 'design/a.png' }])` — builds
 * no path and reads no asset, but it spells `resolve(` followed by a quoted
 * `design/…` and matched. That is a false positive, not a spec to file under
 * DELIBERATELY_OUT: excluding it there would record a decision nobody made, and
 * the next such stub would need its own row. Measured over all 1 406 files in
 * `tests/**` when this was added, the negative lookbehind removes exactly that
 * one file and keeps all seven genuine readers.
 */
const READS_DESIGN_TREE = /(?<!Promise\.)(?:join|resolve)\(\s*[^)]*?['"]design(?:\/[^'"]*)?['"]/;

/**
 * Specs that match the predicate above but deliberately do NOT belong in the
 * lane, each with the reason. Empty today, and that is the point: it exists so
 * that excluding one is a written decision rather than a silent omission.
 *
 * `tests/runtime-image.test.ts` is NOT here because it does not match —
 * it names `design` as a directory the Dockerfile asserts is ABSENT from the
 * standalone output (it used to PRUNE it; MOTIR-3219 removed the sweep that
 * made a prune necessary), in a regex over the Dockerfile's own text, and never
 * builds a path into the tree.
 */
const DELIBERATELY_OUT: { file: string; why: string }[] = [];

describe('the design-asset guard lane (MOTIR-2442)', () => {
  it('finds the job and the config it is meant to guard', () => {
    // A parser regression or a rename would otherwise make every assertion
    // below pass vacuously.
    expect(ciJobs.has(GUARD_JOB)).toBe(true);
    expect(guardCode).toMatch(/^\s*name:\s*Design asset guards\s*$/m);
    expect(designConfig).toContain('include:');
  });

  it('runs the design config, and nothing that needs a database', () => {
    expect(guardCode).toContain('pnpm vitest run --config vitest.design.config.ts');
    // The two things that would put this lane back in the cost class the
    // `design/*` prefix exists to avoid — and the second of which the root
    // config would otherwise force via its per-worker-database globalSetup.
    expect(guardCode).not.toContain('prisma');
    expect(guardCode).not.toContain('actions/postgres');
  });

  it('carries NO branch-prefix condition — the hole is one `if:` wide', () => {
    // The load-bearing assertion. Everything else in this file is scaffolding
    // around it: a `design/*` PR that does not run this job is the exact state
    // MOTIR-2441 was filed for.
    expect(guardCode).not.toContain('startsWith(github.head_ref');
    // (The draft skip is the one condition every job carries; it reads no branch.)
    expect(
      [...guardCode.matchAll(/^ {4}if:(.*)$/gm)]
        .map((m) => m[1]!.trim())
        .filter(
          (c) =>
            c !==
            "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}",
        ),
    ).toEqual([]);
  });

  it('is gated through `CI complete` like every other job', () => {
    // Not a second required context: `protect-main` requires exactly one, and
    // adding another is what MOTIR-2008 established must not happen. The
    // gate's own test asserts the needs list is TOTAL, so this is the same
    // claim read from this card's side — a job un-needed there is un-gated.
    const gateCode = codeOf(ciJobs.get(GATE_JOB) ?? '');
    expect(gateCode).toMatch(new RegExp(`\\b${GUARD_JOB}\\b`));
  });

  it('leaves the expensive lanes skipped on a design-only diff', () => {
    // The saving the design lane exists for. "Fixing" this card by deleting the
    // skips would make the guards run and cost twenty minutes a design PR —
    // and would look identical to a pass from the guard job's side.
    //
    // The MECHANISM moved in MOTIR-3148 and the CLAIM did not: the lanes used
    // to test the branch PREFIX (`!startsWith(github.head_ref, 'design/')`),
    // which skipped them for a branch NAMED `design/*` whatever it contained.
    // They now read the `changes` job, which computes the same exclusion from
    // the DIFF. So this asserts BOTH halves — that each lane is gated on that
    // job, and that the job's exclusion set still contains design assets.
    // Asserting only the first would pass a `changes` job that had quietly
    // stopped excluding `design/`.
    for (const job of ['test', 'coverage', 'e2e', 'e2e-at-scale']) {
      expect(codeOf(ciJobs.get(job) ?? ''), job).toContain("needs.changes.outputs.app == 'true'");
    }
    for (const job of ['sandbox', 'runner-image']) {
      expect(codeOf(ciJobs.get(job) ?? ''), job).toContain(
        "needs.changes.outputs.images == 'true'",
      );
    }
    const changes = codeOf(ciJobs.get('changes') ?? '');
    expect(changes, 'the changes job exists').not.toBe('');
    expect(changes).toMatch(/docs\/\*\|design\/\*\|scripts\/plan-seed\/\*\|\*\.md/);
  });

  it('lets NO job in ci.yml decide what to run from the branch NAME (MOTIR-3148)', () => {
    // AC 3 of MOTIR-3148, as a self-recounting predicate rather than a count:
    // a job added later that reintroduces a branch-prefix gate fails this too.
    // Scoped to CODE — the comments in this workflow quote the retired
    // expression on purpose, and prose gates nothing.
    const gated = [...ciJobs.entries()]
      .filter(([, body]) => codeOf(body).includes('startsWith(github.head_ref'))
      .map(([id]) => id);
    expect(gated).toEqual([]);
  });

  it('runs EVERY spec that reads the design asset tree', () => {
    // The drift guard, and the reason this test is worth its length. The lane
    // is an explicit `include` list, so a design-asset guard written later is
    // un-run by DEFAULT — the same shape of hole as the one this card closes,
    // one level up. Re-derived from the tree rather than restated, so it
    // cannot agree with a stale list.
    const readers = testFiles(join(ROOT, 'tests')).filter((file) =>
      READS_DESIGN_TREE.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    // If this trips, the PREDICATE broke (a refactor moved the path building),
    // not the lane — and a predicate that matches nothing would make the
    // assertion below vacuous.
    expect(readers.length).toBeGreaterThan(0);

    const excluded = new Set(DELIBERATELY_OUT.map((row) => row.file));
    const missing = readers.filter(
      (file) => !excluded.has(file) && !designConfig.includes(`'${file}'`),
    );
    expect(
      missing,
      'add these to vitest.design.config.ts, or to DELIBERATELY_OUT with a reason',
    ).toEqual([]);
  });

  // ── The design-result publish is RETIRED (MOTIR-3797) ────────────────────
  //
  // This block used to assert four properties of a `Publish the design result`
  // STEP in this job: that it existed here rather than in a workflow of its
  // own, that the job requested `id-token: write` for its keyless OIDC
  // identity, that it ran on `pull_request` only, and that it carried no
  // `continue-on-error`. All four were correct while a CI script did the
  // publishing. None of them describes anything now: the AGENT publishes,
  // through the `publish_design_result` MCP tool
  // (`docs/decisions/design-result.md` AMENDMENT 2).
  //
  // ⚠️ THE ASSERTIONS ARE INVERTED, NOT DELETED, and the reason is the one the
  // retirement itself is about. A publisher that has to BE PRESENT in a
  // repository is GREEN when it is stale, absent or forked — nothing imports
  // it, nothing type-checks it, no check compares it to anything. The mirror
  // hazard is a publisher that comes BACK: a copied job, a restored step, a
  // second workflow added by somebody who remembers this repo used to publish
  // from CI. That would be just as invisible, because a workflow file is not
  // typechecked, linted or executed by any suite — which is the same sentence
  // this file's header opens with, pointed the other way.

  it('runs NO design publisher — not in this job, not in any workflow', () => {
    // The entry point is gone from the tree, so nothing can invoke it …
    expect(existsSync(join(ROOT, 'scripts/upload-design-assets.mjs'))).toBe(false);
    // … and no workflow names it, or any successor script, by any route.
    const workflowDir = join(ROOT, '.github/workflows');
    for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
      const yaml = readFileSync(join(workflowDir, file), 'utf8');
      expect(yaml, file).not.toContain('upload-design-assets');
      expect(yaml, file).not.toContain('design-evidence');
    }
    // A design-publish workflow of its own is the other way it comes back —
    // and would add a check to every design pull request while it was at it.
    const workflows = readdirSync(workflowDir);
    expect(workflows).not.toContain('design-result.yml');
    expect(workflows).not.toContain('design-assets.yml');
  });

  it('requests NO `id-token: write` — this job authenticates to nothing', () => {
    // The permission existed solely for the keyless OIDC identity the publish
    // step used (MOTIR-2668). With the step gone it grants a capability with no
    // consumer, which is how a retired mechanism leaves a live credential
    // behind. `authenticateGithubOidc` is untouched — the acceptance-receipt
    // publisher uses it again since MOTIR-7253 (restored after MOTIR-4096
    // retired it), from its OWN workflow's shard job and its own
    // `id-token: write`, which is why this assertion is scoped to THIS job and
    // not to the file.
    expect(guardCode).not.toMatch(/id-token:\s*write/);
  });

  it('still carries the guard step it exists for — the JOB stays, the publish went', () => {
    // The failure this pair is written against is a sweep that reads "retire
    // the design-result lane" and takes the guards with it. The job's whole
    // reason to exist (running `vitest.design.config.ts` unconditionally) is
    // asserted above; this restates the boundary at the point somebody would
    // be deleting.
    expect(guardCode).toContain('pnpm vitest run --config vitest.design.config.ts');
    expect(guardCode).not.toContain('Publish the design result');
  });

  it('keeps the exclusion list honest in both directions', () => {
    // The same tightness `design-asset-addresses.test.ts` holds its own KNOWN
    // table to: a row that no longer describes a real reader is a mute button
    // nobody would notice, so it fails rather than lingers.
    for (const row of DELIBERATELY_OUT) {
      expect(row.why.length, row.file).toBeGreaterThan(20);
      expect(READS_DESIGN_TREE.test(readFileSync(join(ROOT, row.file), 'utf8')), row.file).toBe(
        true,
      );
    }
  });

  it('gives the lane a timeout sized for whole-tree scans', () => {
    // Vitest's 5 s default measured 3.1 to 5.2 s against one sweep on CI, so main
    // went red on a loaded runner with no defect in it. Dropping this line would
    // restore that, and only a slow runner would show it.
    const budget = /\btestTimeout:\s*([\d_]+)/.exec(readFileSync(DESIGN_CONFIG_PATH, 'utf8'));
    expect(Number(budget?.[1]?.replaceAll('_', ''))).toBeGreaterThanOrEqual(30_000);
  });
});
