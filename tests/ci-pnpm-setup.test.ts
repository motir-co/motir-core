import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Guard for MOTIR-4449 — `npm` stays OFF every CI job's critical path.
//
// ── What went wrong, so the assertions below read as consequences ───────────
// `pnpm/action-setup` bootstraps ITSELF with `npm ci`. On 2026-09-04 run
// 33864238803 spent 3646 s of runner time on that one step across 21 jobs —
// mean 173 s, min 5 s, max 437 s. An 80x spread on the same action in the same
// run is registry contention, not a slow action, so the cost lands on whichever
// job draws a slow install. `design-guards` is the shortest job with a real
// ceiling and therefore absorbs the least: it was CANCELLED at 10m00s twice on
// one pull request. `CI complete` needs that job and is the ONLY required
// status check on `main` (ruleset 17227448), so ANY pull request could be
// barred from merging at random by an npm install that had nothing to do with
// it. Four merge-queue runs finished 15–33 seconds inside the same cancel.
//
// ⚠️ NO INPUT OF THAT ACTION FIXES IT, and this is the half that has to be
// asserted rather than remembered, because the action's own documentation reads
// like it does. `standalone` selects which bootstrap LOCKFILE `npm ci`
// installs, never whether npm runs — `src/install-pnpm/run.ts` at
// `0977fd99725f1db4007ccb2928dbb4e90d06cc86` calls `runCommand('npm', ['ci'])`
// unconditionally — and on `linux/x64` that lockfile resolves FIVE packages
// totalling 51,377,700 bytes against the default path's 8,776,044 in one. It is
// a 5.85x payload INCREASE through the exact mechanism that stalls. The card
// was re-scoped twice on this point; the third reader should meet a red test
// rather than the documentation.
//
// ── Read as TEXT, not by running it ─────────────────────────────────────────
// Workflow YAML is neither type-checked nor linted by any suite, and the repo
// has no YAML parser — the same premise `tests/ci-merge-queue.test.ts` and
// `tests/ci-complete-gate.test.ts` share.
// This file is in their mould and stays in the sharded lane with them: it reads
// a BOUNDED directory (`.github/`) with no whole-tree scanner import, so it is
// not a candidate for the structural-guard lane
// (`tests/ci-structural-guards-lane.test.ts`'s predicate).

const ROOT = resolve(__dirname, '..');
const GITHUB_DIR = join(ROOT, '.github');
const SETUP_ACTION = join(GITHUB_DIR, 'actions', 'pnpm', 'action.yml');

/** Every file under `.github/`, repo-relative with forward slashes. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const GITHUB_FILES = walk(GITHUB_DIR);
const WORKFLOWS = GITHUB_FILES.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f));
const COMPOSITES = GITHUB_FILES.filter((f) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(f));

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/** File + 1-based line for every line matching `re`, so a failure names the site. */
function sites(files: string[], re: RegExp): string[] {
  const found: string[] = [];
  for (const f of files) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        if (re.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

describe('the pnpm setup action is the only way CI gets pnpm', () => {
  // The headline assertion. `.github/**` is walked RECURSIVELY rather than
  // checked against a list of the eight files that carried the 17 call sites,
  // because a list would be blind to exactly the thing this guards — a NEW
  // workflow written later, by someone who copied a call site from a sibling
  // repository or from the action's README.
  //
  // ⚠️ It matches a `uses:` — a CALL SITE — and not the bare name. The
  // replacement action's own `description:` explains at length what
  // `pnpm/action-setup` did and why it went, and that prose is the thing most
  // likely to stop the next reader reinstating it. A guard that forbade the
  // STRING would forbid its own explanation. (It did, on the second run of this
  // spec: four hits, all of them documentation.)
  it('calls `pnpm/action-setup` nowhere under .github/**', () => {
    const offenders = sites(GITHUB_FILES, /uses:\s*['"]?pnpm\/action-setup/);
    expect(
      offenders,
      [
        'The npm self-installer is back on the critical path.',
        '`pnpm/action-setup` runs `npm ci` on EVERY input combination — `standalone: true`',
        'does not disable it, it only swaps an 8.78 MB lockfile for a 51.38 MB one.',
        'Use `- uses: ./.github/actions/pnpm` instead. See MOTIR-4449.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  // The other direction: a job can only be pnpm-free by accident if nobody
  // notices it never got pnpm. Every workflow that RUNS pnpm must reach the
  // setup action — directly, or through a composite that uses it.
  it('gives every pnpm-running workflow a path to the setup action', () => {
    const providers = [/\.\/\.github\/actions\/pnpm/, /\.\/\.github\/actions\/e2e-setup/];
    const missing: string[] = [];
    for (const f of WORKFLOWS) {
      const src = read(f);
      const runsPnpm =
        /^\s*(-\s*(name:.*\n\s*)?run:\s*)?pnpm\s/m.test(src) || /\brun:\s*pnpm\s/.test(src);
      if (!runsPnpm) continue;
      if (!providers.some((p) => p.test(src))) missing.push(f);
    }
    expect(
      missing,
      `These workflows run \`pnpm\` but never set it up:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('routes the e2e composite through the same action rather than its own setup', () => {
    const e2e = read('.github/actions/e2e-setup/action.yml');
    expect(e2e).toContain('- uses: ./.github/actions/pnpm');
  });

  // A composite that sets up pnpm by hand is the same regression wearing a
  // different hat, so the wrapper is the ONLY place `actions/setup-node` may
  // appear with a pnpm cache.
  it('keeps `cache: pnpm` out of every call site', () => {
    const offenders = sites(
      [...WORKFLOWS, ...COMPOSITES].filter((f) => f !== '.github/actions/pnpm/action.yml'),
      /^\s*cache:\s*pnpm\s*$/,
    );
    expect(
      offenders,
      [
        '`cache: pnpm` makes `actions/setup-node` shell out to pnpm, which is why pnpm',
        'had to be installed BEFORE it — the ordering that put `pnpm/action-setup` first',
        'at all 17 call sites. The store cache lives in ./.github/actions/pnpm now.',
        '',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });
});

describe('the setup action keeps npm off the critical path', () => {
  const action = readFileSync(SETUP_ACTION, 'utf8');
  const lines = action.split('\n');

  // ⚠️ The EXECUTABLE half only. The action's `description:` block explains at
  // length why `npm ci` is the defect and quotes `pnpm@11.2.2` — so a check run
  // over the whole file fails on the documentation that exists to prevent the
  // very thing it is checking for. (It did, on the first run of this spec.)
  const runsAt = lines.findIndex((l) => /^runs:/.test(l));
  const steps = lines.slice(runsAt);
  const stepsSrc = steps.join('\n');

  it('activates pnpm through corepack, reading the pin from packageManager', () => {
    expect(stepsSrc).toMatch(/corepack enable pnpm/);
    expect(stepsSrc).toMatch(/corepack prepare .*--activate/);
    // The pin has one home. A hardcoded version here would drift from
    // package.json silently, and the cache key is derived from it.
    expect(stepsSrc).toMatch(/require\('\.\/package\.json'\)\.packageManager/);
    expect(stepsSrc).not.toMatch(/pnpm@\d+\.\d+\.\d+/);
  });

  // ⚠️ THE ORDER IS THE DESIGN, and getting it wrong breaks every job at once.
  // `corepack enable` writes its shims into the bin directory of the Node that
  // is on PATH when it runs. Before `setup-node`, that is the runner's
  // preinstalled Node — `setup-node` then switches PATH to the toolcache copy
  // and the shims are gone.
  it('runs actions/setup-node BEFORE corepack', () => {
    const node = runsAt + steps.findIndex((l) => /uses: actions\/setup-node/.test(l));
    const corepack = runsAt + steps.findIndex((l) => /corepack enable pnpm/.test(l));
    expect(node).toBeGreaterThan(-1);
    expect(corepack).toBeGreaterThan(-1);
    expect(
      node,
      'corepack must run AFTER actions/setup-node, or its shims land in a Node that setup-node then replaces.',
    ).toBeLessThan(corepack);
  });

  it('asserts the activated version instead of trusting the step', () => {
    expect(stepsSrc).toMatch(/pnpm --version/);
    expect(stepsSrc).toMatch(/::error::pnpm .* is on PATH, expected/);
  });

  it('runs no npm process of its own', () => {
    const offenders = steps
      .map((l, i) => [l, runsAt + i + 1] as const)
      .filter(([l]) => /^\s*[^#]*\bnpm (ci|install|exec|i)\b/.test(l))
      .map(([l, i]) => `.github/actions/pnpm/action.yml:${i}: ${l.trim()}`);
    expect(
      offenders,
      `The action exists to keep npm off the critical path:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('caches the corepack download and the pnpm store', () => {
    expect(stepsSrc).toMatch(/path: ~\/\.cache\/node\/corepack/);
    expect(stepsSrc).toMatch(/\$\{\{ runner\.os \}\}-corepack-/);
    expect(stepsSrc).toMatch(/pnpm store path/);
    expect(stepsSrc).toMatch(/hashFiles\('pnpm-lock\.yaml'\)/);
  });
});
