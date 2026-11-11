import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Guard for MOTIR-3148. The expensive lanes in `ci.yml` used to decide whether
// to run from the BRANCH NAME — a `startsWith` test against the `seed/` /
// `design/` / `docs/` prefixes. That is a claim about the diff inferred from a
// naming convention, and it was wrong in both directions: a `subtask/…` PR
// touching only `docs/**` paid for the full E2E matrix, and a `docs/…` branch
// that touched app code SKIPPED the whole test suite and merged unverified.
//
// The `changes` job replaces it with a predicate over the actual diff. That
// makes `changes` load-bearing for the MERGE GATE, not merely for cost, and
// this file is what holds it to that. Three properties, none of which anything
// else in the repo would notice breaking (workflow files are not type-checked,
// linted, or executed by any suite):
//
//   1. It FAILS OPEN. Every path that cannot determine the diff — a
//      non-pull_request event, an unavailable base, a failed `git diff`, an
//      empty file set — must run EVERYTHING. A predicate that fails closed
//      merges untested code, which is the defect the job was written to remove.
//   2. Its IMAGE inputs match what the images are actually built from. The
//      sandbox image builds with `context: .` and `COPY . .`, so a predicate
//      scoped to `packages/cli/sandbox/**` would skip the lane on exactly the
//      changes most able to break it. Re-derived from the image workflows here
//      rather than restated, so a new image lane fails this instead of shipping
//      un-gated.
//   3. Every lane it gates actually READS it. A lane whose `if:` stopped
//      referencing the job would run unconditionally (merely wasteful) or, if
//      its `needs` were dropped, read an empty output and skip forever
//      (silently un-tested).
//   4. Each PACKAGE lane runs on its own package's paths and on every input it
//      installs from (MOTIR-5323). Those inputs are re-derived from the lane's
//      job body, the composite action it uses and the package's own manifest,
//      so a lane that gains an input the classifier lacks fails here.
//
// Same mould, and the same no-YAML-parser constraint, as
// `tests/ci-complete-gate.test.ts` and `tests/ci-design-guards-lane.test.ts`.

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const ci = read('.github/workflows/ci.yml');
const IMAGE_WORKFLOWS = [
  '.github/workflows/sandbox-images.yml',
  '.github/workflows/runner-image.yml',
];

/** The Vitest force-full globs (MOTIR-5325) — kept for the measuring script (MOTIR-5948). */
const FORCE_FULL_FILE = '.github/ci/full-suite-paths.txt';
const forceFullGlobs = read(FORCE_FULL_FILE)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

/** Split a workflow's `jobs:` mapping into { jobId → body }. */
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
 * The same text with whole-line comments dropped. Load-bearing: this job's own
 * header quotes the retired branch-prefix expression and names the very paths
 * the assertions look for, and prose gates nothing.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const changesCode = codeOf(ciJobs.get('changes') ?? '');

/** The shell `case` patterns that set a given output to true. */
function patternsSetting(flag: string): string[] {
  return [...changesCode.matchAll(new RegExp(`^\\s*([^\\s].*?)\\)\\s*${flag}=true\\s*;;`, 'gm'))]
    .flatMap((m) => m[1]!.split('|'))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The `case` patterns of every arm whose action sets `flag` to true — including
 * an arm that sets several flags at once, which `patternsSetting` (flag alone,
 * last before `;;`) does not read. The package flags' shared install inputs are
 * written that way. One line per arm: `[ \t]` rather than `\s`, or the first
 * arm of a block would be read together with the `case` line above it.
 */
function armsSetting(flag: string): string[] {
  return [...changesCode.matchAll(/^[ \t]*([^\s#][^)\n]*?)\)[ \t]*([^;\n]*?)[ \t]*;;[ \t]*$/gm)]
    .filter((m) => new RegExp(`\\b${flag}=true\\b`).test(m[2]!))
    .flatMap((m) => m[1]!.split('|'))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does any `case` pattern match this path? (`*` is the only glob in use.) */
const covers = (patterns: string[], path: string): boolean =>
  patterns.some((p) => matches(p, path));

/** One `case` pattern against one path. In `case`, `*` spans `/` too. */
const matches = (pattern: string, path: string): boolean =>
  new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(path);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `app` classifier's arms IN ORDER.
 *
 * ⚠️ `patternsSetting` above cannot answer anything about `app`, and the reason
 * is the defect MOTIR-3806 fixed. `case` is FIRST-MATCH-WINS, so an arm's
 * POSITION decides the answer — and `app`'s last arm is the catch-all `*)`,
 * which covers every path there is. "Is there a pattern covering X" is therefore
 * `true` for every X, including the ones the job deliberately excludes. A
 * membership test would have passed just as happily before the fix as after it.
 * So this models the shell instead: arms in source order, each with whether it
 * sets `app`.
 */
const appArms: { patterns: string[]; setsApp: boolean }[] = (() => {
  const blocks = [...changesCode.matchAll(/case "\$f" in\n([\s\S]*?)\n\s*esac/g)].map((m) => m[1]!);
  const block = blocks.find((b) => /\bapp=true\b/.test(b)) ?? '';
  return block.split('\n').flatMap((line) => {
    const arm = /^\s*([^\s].*?)\)\s*(.*?)\s*;;\s*$/.exec(line);
    if (!arm) return [];
    return [
      {
        patterns: arm[1]!
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean),
        setsApp: /\bapp=true\b/.test(arm[2]!),
      },
    ];
  });
})();

/** What the job decides for one path — first matching arm wins, as `case` does. */
const classifiesAsApp = (path: string): boolean =>
  appArms.find((arm) => arm.patterns.some((p) => matches(p, path)))?.setsApp ?? false;

describe('the changed-paths gate (MOTIR-3148)', () => {
  it('finds the job it is meant to guard', () => {
    // A parser regression would otherwise make every assertion below vacuous.
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(changesCode).not.toBe('');
    expect(changesCode).toMatch(/^\s*name:\s*What changed\s*$/m);
  });

  it('is gated through `CI complete` like every other job', () => {
    // Not a second required context — `protect-main` requires exactly one
    // (MOTIR-2008). The gate's own test asserts its needs list is TOTAL; this
    // is the same claim read from this job's side.
    expect(codeOf(ciJobs.get('ci-complete') ?? '')).toMatch(/\bchanges\b/);
  });

  describe('fails OPEN — the direction is the whole safety argument', () => {
    it('runs everything for an event that carries no base/head pair', () => {
      // ⚠️ THE PREDICATE IS NARROWER THAN IT WAS, AND DELIBERATELY (MOTIR-5124).
      // This used to read `if [ "$EVENT" != 'pull_request' ]`, which swept up
      // `merge_group` — an event that carries its own base and head — along with
      // the events that genuinely have none. The fail-open DIRECTION is
      // unchanged and is asserted twice over: the `case` ends in a catch-all
      // that empties the pair, and the emptiness test below is what runs every
      // lane. Both halves are needed; either alone would let a recognised event
      // with an absent payload field fall through to a `git diff ...` that
      // compares the tree with itself and answers "nothing changed".
      expect(changesCode).toMatch(/^\s*\*\)$/m);
      expect(changesCode).toMatch(/if \[ -z "\$base" \] \|\| \[ -z "\$head" \]/);
    });

    it('runs everything when the diff cannot be computed', () => {
      // Captured, THEN tested: a `git diff | …` pipeline would report the wrong
      // command's status under `pipefail` (`notes.html`, the CI-assertion traps).
      expect(changesCode).toMatch(/if ! files=\$\(git diff --name-only/);
    });

    it('runs everything when the changed-file set is empty', () => {
      expect(changesCode).toMatch(/if \[ -z "\$files" \]/);
    });

    it('emits every flag `true` on every one of those paths, and nowhere assumes false', () => {
      // Still THREE early exits, each emitting both flags true — MOTIR-5124
      // MERGED two cases into one arm rather than adding a fourth: the empty
      // base/head test now covers both the unclassifiable event the old
      // non-pull_request early return handled AND a recognised event whose
      // payload carried no shas, which nothing covered before. If a fourth early
      // exit is added that emits anything else, this count moves and the author
      // lands here. Every one of the three is EXECUTED in `the merge-queue arm`
      // below; this count is what catches an arm added with no case written for
      // it.
      // Six flags — `app`, `images` and the four package lanes' (MOTIR-5323,
      // `pkg_pages` since MOTIR-5758) — so an early exit that forgets a newer one
      // is not counted. (`vitest_full` was a flag from MOTIR-5325 until
      // MOTIR-5948 removed it.)
      expect([...changesCode.matchAll(/^\s*emit true true true true true true$/gm)]).toHaveLength(
        3,
      );
    });

    it('stops on the first failure', () => {
      expect(changesCode).toMatch(/set -euo pipefail/);
    });
  });

  describe('reads the diff safely', () => {
    it('fetches deep enough for the merge base', () => {
      // `git diff BASE...HEAD` needs the merge base, which a shallow clone
      // lacks — and a failure there would silently take the fail-open path on
      // every PR, quietly restoring the full fan-out.
      expect(changesCode).toMatch(/fetch-depth: 0/);
    });

    it('routes every context value through `env:`, never spliced into the script', () => {
      // `${{ }}` inside a `run:` body is textual substitution, and a branch name
      // is attacker-controlled. Same rule `ci-complete` follows for `needs`.
      expect(changesCode).toMatch(
        /^\s*BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m,
      );
      expect(changesCode).toMatch(
        /^\s*MERGE_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}$/m,
      );
      expect(changesCode).toMatch(
        /^\s*MERGE_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}$/m,
      );
      const runBodies = changesCode
        .split(/^\s*run: \|$/m)
        .slice(1)
        .join('\n');
      expect(runBodies).not.toMatch(/\$\{\{/);
    });
  });

  // ── The classifier EXECUTED, not read (MOTIR-5124) ────────────────────────
  //
  // Every other assertion in this file is a reading of the workflow's TEXT, and
  // for the `case` arms that is the right instrument — `classifiesAsApp` models
  // first-match-wins precisely and costs nothing. It cannot answer this card's
  // question, which is about the step's CONTROL FLOW: which arm a given event
  // reaches, and what `git diff` it runs once it gets there. A text assertion
  // that `merge_group` appears somewhere in the script is satisfied by a comment
  // ABOUT merge_group, which is the failure mode this block exists to remove.
  //
  // So it runs the shipped bytes. The script is lifted out of `ci.yml` — the
  // same extraction `tests/ci-acceptance-lane.test.ts` does for the acceptance
  // lane's gate — and executed under `bash` in a throwaway git repository, with
  // the five `env:` values the job declares and a `GITHUB_OUTPUT` file to read
  // the answer back from. There is no second copy of the classifier: what is
  // tested here is the text that ships.
  //
  // ⚠️ THE FIXTURE IS SYNTHETIC AND ITS SHAPE IS NOT. `design-and-docs-only`
  // below is the file set of `moooon-B-V/motir-core#2789`, the pull request the
  // queue ejected twice: four files under `design/work-items/` and one under
  // `docs/decisions/`. Measured on the real refs at the time
  // (`git diff b2e93721...fdf871ce`, the base and head the queue branch
  // `gh-readonly-queue/main/pr-2789-b2e937215…` names), which is where the list
  // comes from. A test cannot fetch those commits, so the SHAPE is reproduced
  // locally and the provenance recorded here.
  describe('the merge-queue arm, executed (MOTIR-5124)', () => {
    /** The `classify` step's shell body, de-dented, exactly as it ships. */
    const classifyScript = ((): string => {
      const lines = ci.split('\n');
      const jobAt = lines.findIndex((l) => /^ {2}changes:\s*$/.test(l));
      expect(jobAt, 'no `changes` job in ci.yml').toBeGreaterThan(-1);
      const stepAt = lines.findIndex((l, i) => i > jobAt && /^\s*- id: classify\s*$/.test(l));
      expect(stepAt, 'no `classify` step in the `changes` job').toBeGreaterThan(jobAt);
      const runAt = lines.findIndex((l, i) => i > stepAt && /^\s*run: \|\s*$/.test(l));
      expect(runAt, 'the `classify` step has no block `run:`').toBeGreaterThan(stepAt);
      const indent = /^ */.exec(lines[runAt + 1]!)![0].length;
      const body: string[] = [];
      for (const line of lines.slice(runAt + 1)) {
        if (line.trim() !== '' && /^ */.exec(line)![0].length < indent) break;
        body.push(line.slice(indent));
      }
      return body.join('\n');
    })();

    /** A package manifest as `pnpm`/Changesets write it: two-space JSON, trailing newline. */
    const manifest = (
      name: string,
      version: string,
      fields: Record<string, unknown> = {},
    ): string =>
      `${JSON.stringify(
        { name, version, type: 'module', dependencies: { clsx: '^2.1.1' }, ...fields },
        null,
        2,
      )}\n`;
    /** `@motir/brand`'s manifest, with its peer range on the design system. */
    const brand = (version: string, designSystemRange: string): string =>
      manifest('@motir/brand', version, {
        peerDependencies: { '@motir/design-system': designSystemRange, react: '^19' },
      });

    /**
     * The file sets each fixture head adds on top of the base commit.
     *
     * `design-and-docs-only` is the ejected pull request's own shape (above).
     * The other three are the criterion's two image inputs and one app-only
     * control — the control is what stops `images` widening to "always true",
     * which would make every assertion here pass for the wrong reason. The last
     * three are MOTIR-5323's package-lane cases: one package, no package, and an
     * install input every package lane shares. The `release-*` and `manifest-*`
     * heads are the release-only-manifest cases (PR #3130): a path given with
     * contents overrides the default one-line body.
     */
    const HEADS: Record<string, readonly (string | readonly [string, string])[]> = {
      'design-and-docs-only': [
        'design/work-items/design-notes.md',
        'design/work-items/provenance.mock.html',
        'design/work-items/provenance.png',
        'design/work-items/provenance.dark.png',
        'docs/decisions/work-item-provenance.md',
      ],
      'ci-runner-image-input': ['infra/ci-runner/Dockerfile'],
      'runner-image-workflow': ['.github/workflows/runner-image.yml'],
      'app-only': ['app/page.tsx'],
      'cli-package-only': ['packages/cli/src/index.ts'],
      'pages-package-only': ['packages/pages/src/index.ts', 'packages/pages/test/tree.test.ts'],
      'lib-only': ['lib/db.ts'],
      'lockfile-only': ['pnpm-lock.yaml'],
      // The Changesets release PR's own shape: CHANGELOGs, two version bumps,
      // and the dependent's peer range on the sibling it now requires.
      'release-version-bumps': [
        'packages/brand/CHANGELOG.md',
        ['packages/brand/package.json', brand('0.2.2', '^0.5.0')],
        'packages/design-system/CHANGELOG.md',
        ['packages/design-system/package.json', manifest('@motir/design-system', '0.5.0')],
      ],
      // A sibling range moved ONTO the `workspace:` protocol: changes the install.
      'manifest-sibling-range-to-workspace': [
        ['packages/brand/package.json', brand('0.2.1', 'workspace:*')],
      ],
      // A range on a package that is NOT a sibling.
      'manifest-foreign-peer-range': [
        [
          'packages/brand/package.json',
          manifest('@motir/brand', '0.2.2', {
            peerDependencies: { '@motir/design-system': '^0.4.3', react: '^20' },
          }),
        ],
      ],
      // A bump that ALSO changes something else in the manifest.
      'manifest-version-and-dependency': [
        [
          'packages/design-system/package.json',
          manifest('@motir/design-system', '0.4.4', {
            dependencies: { clsx: '^2.1.1', 'left-pad': '^1.3.0' },
          }),
        ],
      ],
      // No `version` change at all, but the manifest did change.
      'manifest-dependency-only': [
        [
          'packages/design-system/package.json',
          manifest('@motir/design-system', '0.4.3', { dependencies: { clsx: '^2.1.2' } }),
        ],
      ],
      // A manifest the merge base does not have — nothing to compare against.
      'manifest-added': [['packages/newpkg/package.json', manifest('@motir/newpkg', '0.1.0')]],
      // Nested below a package: not a workspace manifest, so not exempt.
      'nested-manifest-version-only': [
        ['packages/cli/sandbox/package.json', manifest('sandbox-fixture', '1.0.1')],
      ],
      // Not JSON on the head side: the comparison cannot run, so it counts.
      'manifest-unparseable': [['packages/design-system/package.json', '{ "version": "0.4.4",\n']],
    };

    let repo: string;
    let base: string;
    const head: Record<string, string> = {};

    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'changed-paths-gate-'));
      // `-b main` and the explicit identity: a runner with no global git config
      // cannot commit at all, and the default branch name is a user setting.
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'ci@example.invalid');
      git('config', 'user.name', 'CI fixture');
      git('config', 'commit.gpgsign', 'false');
      const write = (path: string, contents = `${path}\n`): void => {
        const full = join(repo, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
      };
      write('README.md');
      write('packages/brand/package.json', brand('0.2.1', '^0.4.3'));
      write('packages/design-system/package.json', manifest('@motir/design-system', '0.4.3'));
      write('packages/cli/sandbox/package.json', manifest('sandbox-fixture', '1.0.0'));
      git('add', '-A');
      git('commit', '-qm', 'base');
      base = git('rev-parse', 'HEAD');
      for (const [name, paths] of Object.entries(HEADS)) {
        // Detached at `base` so every head is a SIBLING of the others: the
        // queue's own shape, where each entry is built on the same tip.
        git('checkout', '-q', base);
        for (const entry of paths) {
          if (typeof entry === 'string') write(entry);
          else write(entry[0], entry[1]);
        }
        git('add', '-A');
        git('commit', '-qm', name);
        head[name] = git('rev-parse', 'HEAD');
      }
      git('checkout', '-q', base);
    });

    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    /** Every output the `changes` job declares, plus what it printed. */
    type Outputs = {
      app: string;
      images: string;
      pkg_cli: string;
      pkg_orchestrator: string;
      pkg_design_system: string;
      pkg_pages: string;
      stdout: string;
    };

    /** Run the shipped classifier with these `env:` values, and read its outputs. */
    function classify(env: {
      EVENT: string;
      BASE_SHA?: string;
      HEAD_SHA?: string;
      MERGE_BASE_SHA?: string;
      MERGE_HEAD_SHA?: string;
    }): Outputs {
      const outPath = join(repo, 'github-output');
      writeFileSync(outPath, '');
      let stdout: string;
      try {
        stdout = execFileSync('bash', ['-c', classifyScript], {
          cwd: repo,
          env: {
            ...process.env,
            // All five are DECLARED in the job's `env:`, so under `set -u` the
            // script may read any of them whatever the event is. GitHub renders
            // an absent context field as the empty string; this mirrors that.
            BASE_SHA: '',
            HEAD_SHA: '',
            MERGE_BASE_SHA: '',
            MERGE_HEAD_SHA: '',
            ...env,
            GITHUB_OUTPUT: outPath,
          },
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (error) {
        const { stderr, stdout: out } = error as { stderr?: string; stdout?: string };
        throw new Error(
          `the classifier exited non-zero\n--- stderr ---\n${stderr ?? ''}\n--- stdout ---\n${out ?? ''}`,
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
      return {
        app: outputs.app!,
        images: outputs.images!,
        pkg_cli: outputs.pkg_cli!,
        pkg_orchestrator: outputs.pkg_orchestrator!,
        pkg_design_system: outputs.pkg_design_system!,
        pkg_pages: outputs.pkg_pages!,
        stdout,
      };
    }

    const asMergeGroup = (name: string) =>
      classify({ EVENT: 'merge_group', MERGE_BASE_SHA: base, MERGE_HEAD_SHA: head[name]! });
    const asPullRequest = (name: string) =>
      classify({ EVENT: 'pull_request', BASE_SHA: base, HEAD_SHA: head[name]! });

    it('lifted a script that actually runs', () => {
      // Without this the whole block can pass vacuously: an extraction that
      // returned '' would run bash on nothing, write no outputs, and every
      // assertion below would compare `undefined` against `undefined`.
      expect(classifyScript).toMatch(/^set -euo pipefail$/m);
      expect(classifyScript).not.toMatch(/\$\{\{/);
      expect(asMergeGroup('app-only').app).toBe('true');
    });

    it('emits `images=false` for a queue batch that touches no image input', () => {
      // THE DEFECT. Before this card the same call answered `images=true` — the
      // early return ran before any diff — and PR #2789 was ejected twice by a
      // twenty-minute image build its five files provably cannot affect.
      const { app, images } = asMergeGroup('design-and-docs-only');
      expect(images).toBe('false');
      // And the app lanes skip too: this is the design/docs exclusion reaching
      // the queue for the first time, which the `app` half of the job always
      // claimed to do and only ever did on a pull request.
      expect(app).toBe('false');
    });

    it.each([['ci-runner-image-input'], ['runner-image-workflow']])(
      'emits `images=true` for a queue batch touching %s',
      (name) => {
        // The direction that must NOT be lost. A batch that can change the image
        // still pays for the build — which is the one case where waiting for a
        // cold build is the point.
        expect(asMergeGroup(name).images).toBe('true');
      },
    );

    it('answers the same for a queue entry as for the pull request it holds', () => {
      // The whole claim of the fix, stated as one property: `merge_group` is now
      // classified by the SAME predicate over the SAME pair, so the queue can no
      // longer disagree with the pull request that was just reviewed. A future
      // edit that gives the queue its own arm — a different exclusion set, a
      // different default — fails here rather than in the queue.
      //
      // ⚠️ WITHOUT EXCEPTION AGAIN (MOTIR-5948). From MOTIR-5325 the Vitest
      // width flag was the one output allowed to differ — the queue ran the
      // whole suite and a pull request only what its diff reached. That flag is
      // gone, so every output, and the line the classifier prints, is compared.
      for (const name of Object.keys(HEADS)) {
        expect({ name, ...asMergeGroup(name) }).toEqual({ name, ...asPullRequest(name) });
      }
    });

    describe('the package flags, executed (MOTIR-5323)', () => {
      const packageFlags = ({
        pkg_cli,
        pkg_orchestrator,
        pkg_design_system,
        pkg_pages,
      }: Outputs) => ({
        pkg_cli,
        pkg_orchestrator,
        pkg_design_system,
        pkg_pages,
      });

      it('runs only the CLI lane for a change inside packages/cli', () => {
        const outputs = asPullRequest('cli-package-only');
        expect(packageFlags(outputs)).toEqual({
          pkg_cli: 'true',
          pkg_orchestrator: 'false',
          pkg_design_system: 'false',
          pkg_pages: 'false',
        });
        // ⚠️ AND THE APP LANES STILL RUN. The app consumes the package and root
        // tests such as `tests/api/public/contract-drift.test.ts` read its files,
        // so these flags narrow the package lanes and nothing else.
        expect(outputs.app).toBe('true');
      });

      it.each([['lib-only'], ['app-only']])('runs no package lane for %s', (name) => {
        // The saving. If this flips, every pull request builds and tests all
        // three packages again whatever it touched.
        expect(packageFlags(asPullRequest(name))).toEqual({
          pkg_cli: 'false',
          pkg_orchestrator: 'false',
          pkg_design_system: 'false',
          pkg_pages: 'false',
        });
      });

      it('runs the pages lane AND the app lanes for a change inside packages/pages', () => {
        // MOTIR-5758 let a pages-only change skip `app` while no app file
        // imported `@motir/pages`; MOTIR-7276's composition root
        // (`lib/pages/index.ts`) is that import, so the package is consumed like
        // the others and its changes run the app's Vitest and E2E lanes again.
        const outputs = asPullRequest('pages-package-only');
        expect(packageFlags(outputs)).toEqual({
          pkg_cli: 'false',
          pkg_orchestrator: 'false',
          pkg_design_system: 'false',
          pkg_pages: 'true',
        });
        expect(outputs.app).toBe('true');
        expect(outputs.images).toBe('true');
      });

      it('runs every package lane when the lockfile changes', () => {
        // An install input all three lanes consume, so none of them may skip.
        expect(packageFlags(asPullRequest('lockfile-only'))).toEqual({
          pkg_cli: 'true',
          pkg_orchestrator: 'true',
          pkg_design_system: 'true',
          pkg_pages: 'true',
        });
      });
    });

    describe("a manifest whose only changes are a release's (PR #3130)", () => {
      it('runs no app or image lane for the Changesets release PR', () => {
        // THE SAVING. The release PR is CHANGELOGs and version bumps; before
        // this the two manifests put it on the whole Vitest matrix, the build
        // and the image lanes, for fields none of them reads.
        const outputs = asPullRequest('release-version-bumps');
        expect(outputs.app).toBe('false');
        expect(outputs.images).toBe('false');
        expect(outputs.stdout).toContain(
          'packages/brand/package.json: release-only manifest change',
        );
      });

      it('still runs the lane of the package that was bumped, and only that one', () => {
        // The CLI's own suite asserts its version, so a package lane is never
        // exempted — only `app` and `images` are.
        expect(asPullRequest('release-version-bumps')).toMatchObject({
          pkg_cli: 'false',
          pkg_orchestrator: 'false',
          pkg_design_system: 'true',
          pkg_pages: 'false',
        });
      });

      it.each([
        ['manifest-version-and-dependency'],
        ['manifest-dependency-only'],
        ['manifest-added'],
        ['nested-manifest-version-only'],
        ['manifest-unparseable'],
        ['manifest-sibling-range-to-workspace'],
        ['manifest-foreign-peer-range'],
        ['cli-package-only'],
      ])('still runs the app and image lanes for %s — the fail-open direction', (name) => {
        // Each is a way the exemption could widen past "only `version`
        // changed": another field, a file with no before-side, a manifest that
        // is not a workspace package's, one the comparison cannot parse, a
        // sibling range moved onto `workspace:`, a non-sibling's range —
        // and the control: package SOURCE, which the CHANGELOG arm must not reach.
        expect(asPullRequest(name)).toMatchObject({ app: 'true', images: 'true' });
      });
    });

    /** What a fail-open arm must emit: every lane runs. */
    const EVERY_FLAG_TRUE = {
      app: 'true',
      images: 'true',
      pkg_cli: 'true',
      pkg_orchestrator: 'true',
      pkg_design_system: 'true',
      pkg_pages: 'true',
    };

    describe('and every fail-open arm still fires — executed, not asserted in prose', () => {
      it.each([['push'], ['workflow_dispatch'], ['schedule']])(
        'runs everything on a `%s` event, which carries no base/head',
        (event) => {
          expect(classify({ EVENT: event })).toMatchObject(EVERY_FLAG_TRUE);
        },
      );

      it('runs everything when a RECOGNISED event arrives with no shas', () => {
        // The arm the old shape could not have: a `merge_group` payload whose
        // fields are absent renders as two empty strings, and `git diff ...`
        // on those compares the tree with itself and reports NOTHING CHANGED —
        // fail-closed, on the merge gate. Both recognised events are checked,
        // because the emptiness test is shared and a future edit could route
        // one of them around it.
        expect(classify({ EVENT: 'merge_group' })).toMatchObject(EVERY_FLAG_TRUE);
        expect(classify({ EVENT: 'pull_request' })).toMatchObject(EVERY_FLAG_TRUE);
      });

      it('runs everything when the diff FAILS', () => {
        // An unavailable base commit — the shallow-clone case `fetch-depth: 0`
        // exists to prevent, and a real possibility in the queue, where the base
        // is a commit on another branch.
        const absent = '0'.repeat(40);
        expect(
          classify({ EVENT: 'merge_group', MERGE_BASE_SHA: absent, MERGE_HEAD_SHA: base }),
        ).toMatchObject(EVERY_FLAG_TRUE);
      });

      it('runs everything when the changed-file set is empty', () => {
        expect(
          classify({ EVENT: 'merge_group', MERGE_BASE_SHA: base, MERGE_HEAD_SHA: base }),
        ).toMatchObject(EVERY_FLAG_TRUE);
      });
    });
  });

  describe('legal CONTENT counts as app code (MOTIR-3806)', () => {
    it('finds the classifier arms it models', () => {
      // Without this the whole block below passes vacuously: an unmatched
      // regex yields no arms, and `classifiesAsApp` then answers `false` for
      // every path — including the ones asserted `false` here.
      expect(appArms.length).toBeGreaterThan(1);
      expect(appArms.some((arm) => arm.setsApp)).toBe(true);
      expect(appArms.some((arm) => !arm.setsApp)).toBe(true);
    });

    it('runs the app lanes for a `content/**/*.md`-only change', () => {
      // The defect. Markdown under `content/` is not documentation — it is data
      // the app parses, and the blanket `*.md` exclusion swallowed it: PR #2427
      // — a revision of a published legal document, back when `content/legal/`
      // held those documents — skipped the entire Vitest lane, including the
      // seven `tests/legal/` suites written to guard exactly that file class.
      //
      // ⚠️ `content/` IS EMPTY TODAY (MOTIR-4103 — the legal documents moved to
      // `motir-marketing`), which is WHY these paths are written as a shape
      // rather than as the two filenames the defect was observed on. The arm is
      // a SUPPRESSOR: it protects whatever lands under `content/` next, and a
      // sample that names a deleted file reads as a stale assertion somebody
      // should delete. Neither path below needs to exist — `classifiesAsApp` is
      // a pure reading of the `case` in `ci.yml`, and that is the point: the
      // guard survives the directory being empty.
      for (const path of ['content/anything.md', 'content/nested/whatever.md']) {
        expect(classifiesAsApp(path), path).toBe(true);
      }
    });

    it('places the content arm BEFORE the `*.md` exclusion — the order IS the fix', () => {
      // `content/anything.md` matches BOTH arms, so the answer is decided
      // entirely by which one the shell reaches first. Move the content arm
      // below the exclusion and the assertion above goes red; this one says why
      // in one line, at the place a reader tidying the `case` would land — and
      // that reader now arrives at an EMPTY `content/`, which is exactly when
      // an arm like this looks like residue and is not.
      const contentArm = appArms.findIndex((arm) => arm.patterns.includes('content/*'));
      const excludeArm = appArms.findIndex((arm) => arm.patterns.includes('*.md'));
      expect(contentArm, 'a content/* arm exists').toBeGreaterThanOrEqual(0);
      expect(excludeArm, 'the *.md exclusion still exists').toBeGreaterThanOrEqual(0);
      expect(contentArm).toBeLessThan(excludeArm);
    });

    it('still skips the app lanes for genuine documentation', () => {
      // The saving, and the direction this fix must not cost. If these flip,
      // `content/*` was written too wide and every docs-only PR is back on the
      // full matrix.
      for (const path of [
        'docs/decisions/x.md',
        'README.md',
        'design/auth/design-notes.md',
        'scripts/plan-seed/x.ts',
      ]) {
        expect(classifiesAsApp(path), path).toBe(false);
      }
    });

    it('still counts an unanticipated path as code — the fail-open direction', () => {
      for (const path of ['app/page.tsx', 'lib/legal/documents.ts', 'content/anything-else.json']) {
        expect(classifiesAsApp(path), path).toBe(true);
      }
    });
  });

  describe('its IMAGE inputs match what the images are built from', () => {
    const imagePatterns = patternsSetting('images');

    it('covers every Dockerfile the image workflows build', () => {
      // Re-derived from the workflows rather than restated: a new image lane,
      // or one whose Dockerfile moves, fails here instead of shipping un-gated.
      const dockerfiles = [
        ...new Set(
          IMAGE_WORKFLOWS.flatMap((w) =>
            [...read(w).matchAll(/^\s*file: (\S+)$/gm)].map((m) => m[1]!),
          ),
        ),
      ];
      expect(dockerfiles.length).toBeGreaterThan(0);
      for (const f of dockerfiles) expect(covers(imagePatterns, f), `Dockerfile ${f}`).toBe(true);
    });

    it('covers the whole-repo build context the sandbox image actually uses', () => {
      // `context: .` + `COPY . .` + `pnpm install --frozen-lockfile` means the
      // packed CLI, the lockfile and every workspace manifest are inputs. The
      // narrow reading of this job — "the sandbox folder" — is the bug this
      // asserts against.
      const sandbox = read('.github/workflows/sandbox-images.yml');
      expect(sandbox, 'sandbox still builds from the repo root').toMatch(/^\s*context: \.$/m);
      for (const path of [
        'packages/cli/src/index.ts',
        'packages/cli/sandbox/Dockerfile',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
        '.npmrc',
      ]) {
        expect(covers(imagePatterns, path), path).toBe(true);
      }
    });

    it('does NOT count prisma/ as an image input — and re-proves why on every run', () => {
      // MOTIR-6498. `prisma/` is in the `COPY . .` context but no build step
      // reads it, so a schema-only pull request must not build ten images. That
      // holds only while BOTH preconditions below hold; if either breaks, this
      // fails and `prisma/*` has to come back into the `images` arm.
      for (const path of [
        'prisma/schema.prisma',
        'prisma/migrations/20260926000000_x/migration.sql',
      ]) {
        expect(covers(imagePatterns, path), path).toBe(false);
      }

      // 1. The builder's install skips the root postinstall — the only place
      //    `prisma generate` runs.
      const dockerfile = codeOf(read('packages/cli/sandbox/Dockerfile'));
      const installs = [...dockerfile.matchAll(/^.*\bpnpm (?:install|i)\b.*$/gm)].map((m) => m[0]);
      expect(installs.length, 'the sandbox builder runs a pnpm install').toBeGreaterThan(0);
      for (const line of installs) {
        expect(line, 'restore prisma/* to the images arm').toContain('--ignore-scripts');
      }
      expect(dockerfile, 'restore prisma/* to the images arm').not.toMatch(/prisma/);

      // 2. The CLI it packs depends on nothing prisma.
      const cli = JSON.parse(read('packages/cli/package.json')) as Record<string, unknown>;
      const deps = [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ].flatMap((field) => Object.keys((cli[field] as Record<string, string> | undefined) ?? {}));
      expect(
        deps.filter((d) => /prisma/i.test(d)),
        'restore prisma/* to the images arm',
      ).toEqual([]);
    });

    it('re-proves the images when the workflows that build them change', () => {
      for (const w of [...IMAGE_WORKFLOWS, '.github/workflows/ci.yml']) {
        expect(covers(imagePatterns, w), w).toBe(true);
      }
    });

    it('does NOT run the image lanes for app-only or docs-only changes', () => {
      // The saving. If this starts passing vacuously the job has widened to
      // "always true" and the ten image jobs are back on every PR.
      for (const path of ['app/page.tsx', 'components/ui/Button.tsx', 'docs/decisions/x.md']) {
        expect(covers(imagePatterns, path), path).toBe(false);
      }
    });

    // ── The SAME set, written a second time in a second language (MOTIR-5126)
    //
    // `image-cache-main.yml` runs these lanes on a push to `main` for one
    // reason: a GitHub Actions cache is readable from the ref that WROTE it or
    // from the DEFAULT branch, so until something ran on `refs/heads/main` no
    // ref could read another's buildx scope and every new ref built cold.
    //
    // It gates itself with an `on.push.paths:` filter rather than by reading
    // this job, because a workflow cannot read another workflow's outputs. That
    // is a second copy of the list, and a second copy is only safe if divergence
    // is LOUD — which it is not on its own: the symptom of drift here is not a
    // red check, it is a scope that silently stops being refreshed, and the cost
    // lands weeks later on whoever waits out a cold build. So the two are pinned
    // to each other here, in the file that already owns the list.
    describe("and the main-branch cache writer's filter is the same list", () => {
      const CACHE_WORKFLOW = '.github/workflows/image-cache-main.yml';
      // ⚠️ COMMENTS STRIPPED, for the same reason this file strips them
      // everywhere else — and here it is load-bearing twice over. That
      // workflow's header EXPLAINS its own permissions in prose ("the absence
      // of `packages: write`"), so a raw-text search for that string finds the
      // sentence denying it; and its `paths:` list carries a comment BETWEEN
      // two entries, which stops a run-of-entries match at the comment and
      // silently yields a short list. Both were live failures of an earlier
      // draft of this block.
      const cacheWorkflow = codeOf(read(CACHE_WORKFLOW));

      /** The `paths:` entries, in glob form, from the `on.push` block. */
      const pushPaths = (() => {
        const block = /^\s*paths:\n((?:\s*- '[^']*'\n)+)/m.exec(cacheWorkflow);
        return [...(block?.[1] ?? '').matchAll(/- '([^']*)'/g)].map((m) => m[1]!);
      })();

      /**
       * A shell `case` pattern as the equivalent `paths:` glob. `case` uses one
       * `*` that spans `/`; `paths:` needs `**` for that, and an exact filename
       * is the same in both. This is the ONLY translation in play, and keeping
       * it explicit is what lets the comparison below be an equality rather than
       * a coverage check that a too-wide list would pass.
       */
      const asGlob = (pattern: string): string =>
        pattern.endsWith('/*') ? `${pattern.slice(0, -2)}/**` : pattern;

      it('lifted both lists', () => {
        // Neither side may be empty, or the equality below holds vacuously —
        // which is how a drift guard goes green while guarding nothing.
        expect(imagePatterns.length).toBeGreaterThan(5);
        expect(pushPaths.length).toBeGreaterThan(5);
      });

      it('names every path the `images` classifier names, and no others', () => {
        // The workflow additionally lists ITSELF, which the classifier has no
        // reason to carry: `ci.yml` does not gate on this file, and this file
        // must rebuild when what it builds changes. That one asymmetry is
        // subtracted by name rather than by a loose comparison, so any OTHER
        // divergence still fails.
        const declared = new Set(pushPaths);
        expect(declared.has(CACHE_WORKFLOW), 'the writer re-runs on its own edit').toBe(true);
        declared.delete(CACHE_WORKFLOW);
        expect([...declared].sort()).toEqual([...new Set(imagePatterns.map(asGlob))].sort());
      });

      it('writes the cache and publishes nothing', () => {
        // It calls the same reusable workflows `ci.yml` calls — a bespoke build
        // would warm layers no pull request asks for — and it calls them with
        // `publish: false`, because the release lanes are the tag-triggered
        // workflows and this one holds no `packages: write`.
        for (const w of IMAGE_WORKFLOWS) expect(cacheWorkflow).toContain(`uses: ./${w}`);
        expect(cacheWorkflow).not.toContain('publish: true');
        expect(cacheWorkflow).not.toContain('packages: write');
      });

      it('runs only on the DEFAULT branch — the whole point is the scope it writes', () => {
        // A cache written anywhere else is one no other ref may read, which is
        // the defect. `main` is not a preference here, it is the mechanism.
        expect(cacheWorkflow).toMatch(/^\s*branches: \[main\]$/m);
      });

      it('has its OWN concurrency group, so it cannot queue behind a release', () => {
        // ⚠️ THE REASON THIS IS A SEPARATE WORKFLOW AT ALL. `ci.yml` groups on
        // `${{ github.workflow }}-${{ github.ref }}` and does NOT cancel on a
        // push (MOTIR-3106 — cancelling there starved the deploy), so runs
        // QUEUE: anything added to its push lane joins the critical path of the
        // NEXT merge's release. Putting the sandbox matrix there would have
        // recreated that defect in its slow form, which no check reports.
        expect(cacheWorkflow).toMatch(/^concurrency:\n\s*group: image-cache-main$/m);
      });

      it('does NOT cancel in progress — a killed build writes no cache at all', () => {
        // ⚠️ THIS ASSERTION WAS `true` AND IS NOW `false`. The reasoning that
        // set it is in the workflow beside the directive; the short form is that
        // its premise — a cancelled write is one "the newer `main` is about to
        // redo better" — assumes the newer run COMPLETES, and for the
        // `ci-runner` image it does not: a cold build is killed at the 20-minute
        // ceiling roughly half the time, and a killed build never reaches its
        // cache export. Both of this workflow's first two runs died that way
        // (20m16s each) and wrote no `ci-runner` scope.
        //
        // Pinned in the NEGATIVE direction on purpose: flipping it back is a
        // decision with an argument on the other side, so it should cost a
        // deliberate edit to this line rather than pass unnoticed.
        expect(cacheWorkflow).toMatch(/^\s*cancel-in-progress: false$/m);
      });

      it('has a clock that does not depend on merge traffic', () => {
        // Two jobs need one, and the workflow states both: BOOTSTRAP (the
        // `ci-runner` scope has to survive one build to exist at all, and each
        // attempt is a coin flip) and EVICTION (an Actions cache is reclaimed
        // after 7 days without a hit, and the sandbox blobs keep this repo near
        // the 10 GB budget). A `push` + `paths:` gate supplies attempts only
        // when somebody merges something image-touching, which is not a clock.
        expect(cacheWorkflow).toMatch(/^\s*schedule:\n\s*- cron: '[^']+'$/m);

        // Inside the 7-day eviction window with a wide margin — the assertion is
        // on the PROPERTY, not on the literal cadence, so tuning the cron for
        // cost does not fail this while dropping it to weekly does.
        const cron = /^\s*- cron: '([^']+)'$/m.exec(cacheWorkflow)?.[1] ?? '';
        const [, hour = '', dayOfMonth = '', , dayOfWeek = ''] = cron.split(' ');
        expect(cron, 'a cron was declared').not.toBe('');
        expect(
          hour.includes('/') || dayOfMonth === '*',
          `cron '${cron}' must fire at least daily — the scope evicts after 7 days`,
        ).toBe(true);
        expect(dayOfWeek, `cron '${cron}' must not be weekly`).toBe('*');
      });

      it('can be re-warmed on demand', () => {
        // After an eviction, or to retry a lost bootstrap without waiting for
        // the cron or inventing a commit.
        expect(cacheWorkflow).toMatch(/^\s*workflow_dispatch:$/m);
      });

      it('is not a dependency of the release — a cold cache must never stop one', () => {
        // It verifies nothing (the queue entry already gated the merge), so
        // depending on it would convert a slow build into a blocked release.
        // The release left `ci.yml` with the Fly deploy job (MOTIR-10935) and is
        // `aws-deploy.yml` now, so that is the lane read.
        const awsDeploy = read('.github/workflows/aws-deploy.yml');
        expect(codeOf(awsDeploy)).not.toMatch(/image-cache/);
      });
    });
  });

  describe('every lane it gates actually reads it', () => {
    it.each([
      ['test', 'app'],
      ['coverage', 'app'],
      ['e2e', 'app'],
      ['e2e-at-scale', 'app'],
      ['sandbox', 'images'],
      ['runner-image', 'images'],
      ['design-system', 'pkg_design_system'],
      ['cli', 'pkg_cli'],
      ['orchestrator', 'pkg_orchestrator'],
      ['pages', 'pkg_pages'],
    ])('%s is gated on needs.changes.outputs.%s', (job, flag) => {
      const code = codeOf(ciJobs.get(job) ?? '');
      expect(code, `${job} exists`).not.toBe('');
      expect(code).toContain(`needs.changes.outputs.${flag} == 'true'`);
      // A lane that reads the output without needing the job gets an EMPTY
      // string and skips forever — silently un-tested, the worst outcome here.
      expect(code, `${job} needs the changes job`).toMatch(/^\s*needs:.*\bchanges\b/m);
    });

    it('declares every output it is read for', () => {
      for (const flag of [
        'app',
        'images',
        'pkg_cli',
        'pkg_orchestrator',
        'pkg_design_system',
        'pkg_pages',
      ]) {
        expect(changesCode, flag).toMatch(
          new RegExp(`^\\s*${flag}: \\$\\{\\{ steps\\.classify\\.outputs\\.${flag} \\}\\}$`, 'm'),
        );
      }
    });
  });

  // ── A PULL REQUEST runs the WHOLE Vitest suite again (MOTIR-5948) ──────────
  //
  // MOTIR-5325 narrowed a pull request's Vitest legs to the files its diff could
  // reach, on a measured promise that the typical one would run about a fifth of
  // the suite. `docs/decisions/ci-affected-tests.md` Amendment 1 re-measured it
  // at a median of 66.5%, past that record's own 50% no-go line, and reverted the
  // lane. This block pins the reverted shape, so the selection cannot come back
  // piecemeal — a select step with no coverage gate behind it, or a width flag
  // nothing reads — without somebody re-opening the decision it contradicts.
  describe('a PULL REQUEST runs the whole Vitest suite (MOTIR-5948 reverts MOTIR-5325)', () => {
    const ADR = 'docs/decisions/ci-affected-tests.md';
    const SCRIPT = 'scripts/ci/measure-affected-tests.mjs';

    /** The `test` job's steps, one text each, comments dropped. */
    const testCode = codeOf(ciJobs.get('test') ?? '');
    const testSteps = testCode.split(/^ {6}- /m).slice(1);
    const stepNamed = (name: string): string =>
      testSteps.find((s) => new RegExp(`^name: ${escapeRe(name)}$`, 'm').test(s)) ?? '';
    const fullStep = testSteps.find((s) => s.includes('--reporter=blob')) ?? '';
    const uploadStep = stepNamed('Upload coverage blob');
    const coverageCode = codeOf(ciJobs.get('coverage') ?? '');

    it('finds the steps it guards', () => {
      // Without this every assertion below could pass against an empty string.
      for (const [label, text] of Object.entries({
        testCode,
        fullStep,
        uploadStep,
        coverageCode,
      })) {
        expect(text, label).not.toBe('');
      }
    });

    it('has no selection step and no subset step', () => {
      expect(stepNamed('Select the affected test files')).toBe('');
      expect(stepNamed('Vitest — the affected files')).toBe('');
      // Whatever the steps are called: nothing in the job runs the selection,
      // reads a selected list, or branches on a selection's outcome.
      expect(testCode).not.toContain(SCRIPT);
      expect(testCode).not.toContain('vitest-affected');
      expect(testCode).not.toContain('steps.select');
      expect(testCode).not.toContain('--passWithNoTests');
    });

    it('runs every leg in full, with coverage, on every event — no `if:` on the step', () => {
      expect(fullStep).toContain(
        'run: pnpm vitest run --config vitest.collect.config.ts --shard=${{ matrix.leg }}/20 --reporter=default --reporter=blob --coverage',
      );
      expect(fullStep).not.toMatch(/^\s*if:/m);
      expect(uploadStep).not.toMatch(/^\s*if:/m);
    });

    it('runs the coverage merge on every pull request with an app change', () => {
      expect(coverageCode).toMatch(
        /^\s*if: \$\{\{ needs\.changes\.outputs\.app == 'true' && github\.event_name != 'push' \}\}$/m,
      );
    });

    it('carries no Vitest width flag and no `vitest-full` label', () => {
      // The flag's only readers were the two steps and the coverage `if:` above.
      // A flag nothing reads is a knob that looks live, so the classifier does
      // not compute it, declare it, or read the label and the list it came from.
      expect(ci).not.toMatch(/vitest_full/);
      expect(ci).not.toMatch(/vitest-full/);
      expect(changesCode).not.toContain(FORCE_FULL_FILE);
    });

    // ⚠️ THE FORCE-FULL LIST AND THE MEASURING SCRIPT ARE KEPT (Amendment 1,
    // A1.5 point 3): re-running the measurement is what re-opens the decision.
    // So what the list still owes is to agree with the ADR table that justifies
    // each entry, and to be READ by the script rather than restated in it.
    it('keeps the force-full globs in ONE file, equal to the ADR §2.1 table', () => {
      const adr = read(ADR);
      const section = adr.slice(adr.indexOf('### §2.1'), adr.indexOf('### §2.2'));
      const tableGlobs = section
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .flatMap((line) => [...line.split('|')[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
      expect(tableGlobs.length, 'the ADR table has rows').toBeGreaterThan(10);
      expect([...new Set(tableGlobs)].sort()).toEqual([...new Set(forceFullGlobs)].sort());
    });

    it('is READ by the measuring script, never restated', () => {
      const source = read(SCRIPT);
      expect(source).toContain(FORCE_FULL_FILE);
      // No second copy: none of the list's wildcard globs is a string literal there.
      for (const glob of forceFullGlobs.filter((g) => g.includes('*'))) {
        expect(source, glob).not.toContain(`'${glob}'`);
      }
    });

    it('keeps only the MEASURE mode of the script', () => {
      // SELECT mode left with the lane; its last version is at `aa26372e6`.
      const source = codeOf(read(SCRIPT).replace(/^\s*\/\/.*$/gm, '#'));
      expect(source).not.toContain("'--select'");
      expect(source).not.toContain("'--out'");
      expect(source).not.toContain('selectionDiff');
    });
  });

  // ── The E2E lane keeps reading `app` (MOTIR-6222) ──────────────────────────
  //
  // MOTIR-6222 proposed a second flag — `app_e2e`, an ALLOW-list over the
  // surfaces a browser can reach — so the twelve Playwright legs would skip a
  // `packages/cli/**`-only diff. It required its own saving to be re-measured
  // first, over at least the last 100 merged pull requests, and declared itself a
  // NO-GO if the share came out materially below the 25% it had read off a
  // 40-pull-request sample. It came out at 8.4% over 300, every window but that
  // one sitting at 0–7%; `docs/decisions/ci-e2e-path-gate.md` is the verdict.
  //
  // This block pins it, exactly as the MOTIR-5948 block above pins that revert:
  // the flag cannot come back piecemeal — a computed output nothing reads, or an
  // `e2e` job quietly re-gated — without somebody re-opening the decision. The
  // one thing that SHOULD bring it back is a fresh measurement, which is why the
  // instrument is kept and asserted here rather than deleted with the proposal.
  describe('the E2E lane keeps reading `app`, and no `app_e2e` flag exists (MOTIR-6222)', () => {
    const ADR = 'docs/decisions/ci-e2e-path-gate.md';
    const SCRIPT = 'scripts/ci/measure-e2e-reachability.mjs';

    it('computes, declares and reads no `app_e2e` anywhere in the workflow', () => {
      // All three, because each alone is a live-looking knob: a classifier that
      // sets it, an `outputs:` that publishes it, or a job that gates on it.
      expect(ci).not.toMatch(/app_e2e/);
    });

    it('still gates `e2e` on `app` — the same flag `test` and `coverage` read', () => {
      // `every lane it gates actually reads it` above asserts the pairing for all
      // nine lanes. This is the same fact stated where the DECISION is, so a
      // future edit that re-points `e2e` lands on this card's record.
      const e2eCode = codeOf(ciJobs.get('e2e') ?? '');
      expect(e2eCode, 'the e2e job exists').not.toBe('');
      expect(e2eCode).toContain("needs.changes.outputs.app == 'true'");
    });

    it('keeps the instrument that re-opens the decision', () => {
      // `ci-affected-tests.md` A1.5 point 3's precedent: the measuring script
      // outlives the proposal it declined, because re-running it is the only
      // thing that re-opens the question.
      const source = read(SCRIPT);
      expect(source).toMatch(/E2E_REACHABLE/);
      expect(read(ADR)).toContain(SCRIPT);
    });

    it('lifts the shipped classifier rather than carrying a second copy of it', () => {
      // The whole worth of the measurement. A script that re-implemented the
      // `app` arms would be scoring a copy whose first-match-wins order nobody
      // keeps true — the exact reason `appArms` above models the shell instead of
      // testing membership.
      const source = read(SCRIPT);
      expect(source).toContain('.github/workflows/ci.yml');
      expect(source).toMatch(/- id: classify/);
      // No second copy of the classifier's own exclusion arm.
      expect(source).not.toContain('scripts/plan-seed/*');
    });

    it('records a reachable set that is the script’s, and names every surface §2.3 calls reachable', () => {
      // §2.3 is the load-bearing half of the NO-GO: the card's proposed
      // allow-list omitted these, and each omission is a pull request the flag
      // would have skipped while the browser could see the change. If the script
      // stops covering one, the record's argument is no longer true of the
      // instrument that produced it.
      const source = read(SCRIPT);
      const block = source.slice(
        source.indexOf('const E2E_REACHABLE'),
        source.indexOf('];', source.indexOf('const E2E_REACHABLE')),
      );
      const globs = [...block.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1]!);
      expect(globs.length, 'the reachable list parsed').toBeGreaterThan(10);
      for (const surface of [
        'hooks/**',
        'instrumentation.ts',
        'packages/brand/**',
        'packages/orchestrator/**',
        'scripts/**',
        'tests/helpers/**',
        'tests/fixtures/**',
        'package.json',
        'pnpm-lock.yaml',
      ]) {
        expect(globs, surface).toContain(surface);
      }
      // And the one package nothing in the bundle or the specs reads — the whole
      // population a narrower flag could ever have skipped — is NOT in it.
      expect(globs).not.toContain('packages/cli/**');
    });
  });

  describe('each PACKAGE lane runs on what it consumes (MOTIR-5323)', () => {
    const LANES = [
      { job: 'cli', flag: 'pkg_cli', dir: 'packages/cli' },
      { job: 'orchestrator', flag: 'pkg_orchestrator', dir: 'packages/orchestrator' },
      { job: 'design-system', flag: 'pkg_design_system', dir: 'packages/design-system' },
      { job: 'pages', flag: 'pkg_pages', dir: 'packages/pages' },
    ] as const;

    type Manifest = {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const manifest = (dir: string): Manifest => JSON.parse(read(`${dir}/package.json`)) as Manifest;

    it.each(LANES)('$job runs on its own package directory', ({ flag, dir }) => {
      const patterns = armsSetting(flag);
      expect(patterns.length, `some arm sets ${flag}`).toBeGreaterThan(0);
      for (const path of [
        `${dir}/src/index.ts`,
        `${dir}/package.json`,
        `${dir}/test/any.test.ts`,
      ]) {
        expect(covers(patterns, path), path).toBe(true);
      }
    });

    it.each(LANES)('$job skips the app, the docs and the other packages', ({ flag, dir }) => {
      const others = LANES.filter((lane) => lane.dir !== dir).map(
        (lane) => `${lane.dir}/src/index.ts`,
      );
      for (const path of [
        'app/page.tsx',
        'lib/db.ts',
        'docs/decisions/x.md',
        'prisma/schema.prisma',
        ...others,
      ]) {
        expect(covers(armsSetting(flag), path), path).toBe(false);
      }
    });

    it.each(LANES)('$job runs on every input its own job body reads', ({ job, flag }) => {
      // Re-derived, not restated: the composite actions the lane `uses:`, every
      // file the lane or those actions hash or `require`, and this workflow.
      const body = codeOf(ciJobs.get(job) ?? '');
      expect(body, `${job} exists`).not.toBe('');
      const actions = [...body.matchAll(/uses: \.\/(\.github\/actions\/[A-Za-z0-9_-]+)/g)].map(
        (m) => `${m[1]!}/action.yml`,
      );
      expect(actions.length, `${job} uses a composite action`).toBeGreaterThan(0);
      const hashed = (text: string): string[] =>
        [...text.matchAll(/hashFiles\('([^']+)'\)/g)].map((m) => m[1]!);
      const required = (text: string): string[] =>
        [...text.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]!);
      const inputs = new Set([
        '.github/workflows/ci.yml',
        ...actions,
        ...hashed(body),
        ...actions.flatMap((action) => {
          const code = codeOf(read(action));
          return [...hashed(code), ...required(code)];
        }),
      ]);
      const patterns = armsSetting(flag);
      for (const input of inputs)
        expect(covers(patterns, input), `${job} reads ${input}`).toBe(true);
    });

    it.each(LANES)('$job runs when a workspace package it depends on changes', ({ flag, dir }) => {
      const own = manifest(dir);
      expect(own.name, `${dir}/package.json names its package`).toMatch(/^@motir\//);
      const workspace = new Map<string, string>(
        readdirSync(join(ROOT, 'packages')).flatMap((entry): [string, string][] => {
          try {
            const name = manifest(`packages/${entry}`).name;
            return name ? [[name, `packages/${entry}`]] : [];
          } catch {
            return [];
          }
        }),
      );
      expect(workspace.get(own.name!)).toBe(dir);
      // None of the three depends on another workspace package today. This is
      // what turns a future `@motir/*` dependency into a red suite rather than a
      // lane that skips on the change most able to break it.
      const deps = Object.keys({
        ...own.dependencies,
        ...own.devDependencies,
        ...own.peerDependencies,
      }).filter((name) => workspace.has(name));
      for (const dep of deps) {
        expect(
          covers(armsSetting(flag), `${workspace.get(dep)!}/src/index.ts`),
          `${dir} depends on ${dep}`,
        ).toBe(true);
      }
    });
  });

  describe('the at-scale split (AC 2)', () => {
    const atScale = codeOf(ciJobs.get('e2e-at-scale') ?? '');

    it('runs on a merge-queue entry and on an opted-in PR, and otherwise not at all', () => {
      // ⚠️ `push` UNTIL MOTIR-4050. The legs did not leave the gate, they moved
      // one step earlier: from after the merge to the composed tree that is
      // about to become `main`. MOTIR-3148's property is untouched — still once
      // per merge, still never on an ordinary pull request.
      expect(atScale).toContain("github.event_name == 'merge_group'");
      expect(atScale).not.toContain("github.event_name == 'push'");
      expect(atScale).toContain(
        "contains(github.event.pull_request.labels.*.name, 'e2e-at-scale')",
      );
    });

    it('still gates the MERGE, so nothing reaches `main` without it', () => {
      // The legs left the PR lane, then left the push lane; they did not leave
      // the gate. The property is read where it lives: the required `CI
      // complete` context, which a merge-queue entry must satisfy. (The retired
      // Fly `deploy` job was never the place — a skipped `needs` entry would
      // have stopped that release rather than gate it — and MOTIR-10935
      // deleted it.)
      expect(codeOf(ciJobs.get('ci-complete') ?? '')).toMatch(/\be2e-at-scale\b/);
    });

    it('holds the volume legs and none of the bulk ones', () => {
      const ids = [...atScale.matchAll(/^\s*- id: (\S+)$/gm)].map((m) => m[1]!);
      expect(ids).toEqual(
        expect.arrayContaining([
          'board-at-scale',
          'collab-at-scale',
          'reporting-at-scale',
          'billing-cloud',
        ]),
      );
      expect(ids.filter((id) => id.startsWith('bulk-') || id.startsWith('a11y-'))).toEqual([]);
    });
  });
});
