import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALIGNED_WINDOW_MS,
  BOUNDARY_OVERSHOOT_MS,
  SUBPROCESS_HEADROOM_MS,
  SUBPROCESS_WINDOW_MS,
  headroomIsSatisfied,
  sleep,
  waitForWindowHeadroom,
} from '../../helpers/rateLimitWindow';

// The anti-recurrence guard for MOTIR-2101 / MOTIR-2224.
//
// Both cards were the SAME defect — an assertion on a fixed-window rate
// limiter's accumulated count, with no alignment to the epoch-aligned grid the
// limiter buckets on. MOTIR-2101 root-caused it, fixed `rate-limit.test.ts`,
// and stopped there; the class survived untouched in `story-gate.test.ts` and
// was re-diagnosed from scratch a week later. What made that possible is that
// the fix was a LOCAL const in one test file, invisible to the next author.
//
// So the boundary arithmetic now lives in exactly one module, and this guard
// keeps it that way: a third copy pasted into a new suite fails here, at the
// moment it is written, instead of red-lighting unrelated PRs weeks later.

const REPO_ROOT = process.cwd();
const TESTS_DIR = join(REPO_ROOT, 'tests');

/** The one module allowed to compute a window's phase. */
const HELPER = 'tests/helpers/rateLimitWindow.ts';

/**
 * A hand-rolled grid phase, in EITHER of its two forms — built from escapes so
 * this file's own source is not itself a match; the guard must not be the second
 * copy it exists to forbid.
 *
 *   1. A MODULO of the wall clock — the shape `waitForWindowBoundary` uses.
 *   2. A floor-DIVIDE by a window multiplied back by the same window — the shape
 *      `currentWindowStart` uses, i.e. the `windowStart` a counter row is keyed
 *      on, and the shape `lib/rateLimit/limiter.ts` itself computes.
 *
 * ⚠️ Form 2 was missing until MOTIR-3016, and it was not hypothetical: BOTH
 * `tests/rateLimit/guard.test.ts` and `tests/api/v1/shared-store.test.ts` kept a
 * private copy of it while this file asserted the arithmetic lived in exactly one
 * module. Two expressions of one grid look nothing alike to a regular expression,
 * so "the copy is forbidden" was true of one of them and silently false of the
 * other. The back-reference is what keeps `Math.floor(Date.now() / 1000)` — an
 * ordinary conversion to seconds, all over the tree — out of it: a phase
 * multiplies the divisor back, a unit conversion does not.
 */
const GRID_PHASE = new RegExp(
  String.raw`Date\.now\(\)\s*%` +
    String.raw`|Math\.floor\(\s*Date\.now\(\)\s*\/\s*([A-Za-z_$][\w$]*|\d[\d_]*)\s*\)\s*\*\s*\1\b`,
);

/** Every `.ts` / `.tsx` under `tests/`, repo-relative with POSIX separators. */
function testSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) found.push(relative(REPO_ROOT, full).split(sep).join('/'));
    }
  };
  walk(TESTS_DIR);
  return found.sort();
}

describe('fixed-window alignment lives in ONE place', () => {
  it('finds the test tree at all (a guard over zero files proves nothing)', () => {
    const files = testSources();

    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(HELPER);
    expect(files).toContain('tests/api/v1/rate-limit.test.ts');
    expect(files).toContain('tests/api/v1/story-gate.test.ts');
  });

  it('no file under tests/ computes a window phase except the shared helper', () => {
    const offenders = testSources().filter(
      (file) => file !== HELPER && GRID_PHASE.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );

    expect(
      offenders,
      `these files hand-roll the fixed-window phase instead of importing ` +
        `\`waitForWindowBoundary\` from ${HELPER} — see MOTIR-2224`,
    ).toEqual([]);
  });

  // The mirror of the assertion above: the helper must actually still be the
  // definition. Without this, deleting its body would make the sweep vacuous.
  it('the shared helper IS the definition', () => {
    expect(GRID_PHASE.test(readFileSync(join(REPO_ROOT, HELPER), 'utf8'))).toBe(true);
  });

  // ⚠️ The guard is proven by DELIBERATELY introducing the violation — a guard
  // that has never been shown to fail is indistinguishable from no guard.
  it('the guard actually fires on a hand-rolled copy', () => {
    // Interpolated rather than written out, so THIS file is not the second
    // copy — the assertion below is over the evaluated string, which is.
    const copied = `const wait = (w: number) => sleep(w - (Date.now() ${'%'} w) + 5);`;

    expect(GRID_PHASE.test(copied)).toBe(true);
  });

  it('does NOT fire on an ordinary wall-clock read', () => {
    const innocent = 'const startedAt = Date.now();\nconst elapsed = Date.now() - startedAt;';

    expect(GRID_PHASE.test(innocent)).toBe(false);
  });

  // Form 2 — the floor-divide grid, added by MOTIR-3016 after the sweep found
  // two live copies of it that this guard had been reading green over.
  it('fires on the floor-divide form of the same grid', () => {
    // Interpolated for the same reason as above: written out, this file would be
    // the copy it forbids.
    const windowStart = `const s = Math.floor(Date.now() ${'/'} WINDOW) * WINDOW;`;
    const local = `function cell(w: number) { return Math.floor(Date.now() ${'/'} w) * w; }`;

    expect(GRID_PHASE.test(windowStart)).toBe(true);
    expect(GRID_PHASE.test(local)).toBe(true);
  });

  it('does NOT fire on a conversion to seconds, which multiplies nothing back', () => {
    // `Math.floor(Date.now() / 1000)` appears throughout the tree — in
    // `retryAfterSeconds`, in every `resetAt` assertion. A guard that flagged it
    // would be turned off rather than obeyed.
    const seconds = 'expect(decision.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000));';
    const divided = 'const cells = Math.floor(Date.now() / windowMs);';

    expect(GRID_PHASE.test(seconds)).toBe(false);
    expect(GRID_PHASE.test(divided)).toBe(false);
  });

  // The other half of the contract: every suite that asserts on an ACCUMULATED
  // count must be getting the alignment from the helper, not merely
  // not-redefining it.
  //
  // ── THIS HALF USED TO BE A LIST, AND THAT WAS THE BUG (MOTIR-2648) ─────────
  // It was an `it.each([...])` naming six files by hand. A file joined it when
  // whoever fixed that file remembered to add it — and that step was missed on
  // every occurrence after the first: MOTIR-2101 → -2224 → -2598 → -2647 each
  // re-diagnosed the same defect from scratch, and when -2647 was finally fixed
  // the sweep it prompted found the class alive in TWO more suites
  // (`tests/rateLimit/surfaceGuards.test.ts`, with 37 unpinned budgets, and
  // `tests/api-coding-convention-route.test.ts`).
  //
  // So the guard's coverage was a memory of the fires already put out. A list
  // like that cannot see the next one, because nothing walks it except a person
  // — the first half of this file works precisely because it derives its
  // subjects from the tree instead.
  //
  // What replaces it, in three derivations, none hand-maintained:
  //
  //  1. The BUDGETS come from `lib/`. A fixed-window budget is exactly a
  //     `'<NAME>_RATE_LIMIT'` string literal that has a
  //     `'<NAME>_RATE_LIMIT_WINDOW_MS'` sibling literal — that pairing IS what
  //     makes it one. A budget added to `lib/rateLimit/budgets.ts` tomorrow is
  //     therefore in scope with no edit here, and `E2E_DISABLE_RATE_LIMIT`
  //     (a boolean switch, no window) falls out by construction rather than by
  //     an exemption someone had to think of.
  //  2. The SUBJECTS come from the test tree — every file that ASSIGNS one of
  //     those budget envs.
  //  3. The VERDICT is per file: it must pin the matching `*_WINDOW_MS`, or
  //     import the shared helper.
  //
  // ⚠️ Detection is by ASSIGNMENT, never by mention. `surfaceGuards.test.ts`
  // listed all six `*_WINDOW_MS` names in its cleanup array while setting none
  // of them — "cleans up a knob it never sets" is the signature of this defect,
  // so a guard that merely grepped for the window NAME would have called that
  // file compliant and found nothing at all.
  //
  // Assignment is resolved through a local const alias too
  // (`const LIMIT_ENV = '…'; process.env[LIMIT_ENV] = '1'`), because that is the
  // form `tests/mcp/rate-limit-gate.test.ts` uses — the most recent instance of
  // the class would have been invisible to a literal-only matcher.

  /** `lib/` sources, where the budget env names are defined. */
  function libSources(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) found.push(full);
      }
    };
    walk(join(REPO_ROOT, 'lib'));
    return found;
  }

  /**
   * The budget envs, derived from `lib/`: a `*_RATE_LIMIT` literal that also has
   * a `*_RATE_LIMIT_WINDOW_MS` sibling. The pair is what makes it a FIXED-WINDOW
   * budget, and so a member of this class.
   */
  function budgetEnvs(): string[] {
    const literals = new Set<string>();
    for (const file of libSources()) {
      for (const [, name] of readFileSync(file, 'utf8').matchAll(
        /'([A-Z0-9_]+_RATE_LIMIT(?:_WINDOW_MS)?)'/g,
      )) {
        if (name) literals.add(name);
      }
    }
    return [...literals]
      .filter((name) => !name.endsWith('_WINDOW_MS') && literals.has(`${name}_WINDOW_MS`))
      .sort();
  }

  /**
   * The env names a source ASSIGNS — `process.env.X =`, `process.env['X'] =`,
   * `vi.stubEnv('X', …)`, and `process.env[ALIAS] =` where `ALIAS` is a local
   * const bound to a string literal.
   *
   * Deliberately NOT "names the source mentions": a cleanup array that deletes a
   * window it never sets is the exact shape this guard exists to catch.
   */
  function assignedEnvs(source: string): Set<string> {
    const aliases = new Map<string, string>();
    for (const [, alias, value] of source.matchAll(
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*'([A-Z0-9_]+)'/g,
    )) {
      if (alias && value) aliases.set(alias, value);
    }

    const assigned = new Set<string>();
    for (const [, dotted, single, double] of source.matchAll(
      /process\.env(?:\.([A-Z0-9_]+)|\[\s*(?:'([A-Z0-9_]+)'|"([A-Z0-9_]+)")\s*\])\s*=[^=]/g,
    )) {
      const name = dotted ?? single ?? double;
      if (name) assigned.add(name);
    }
    // `process.env[ALIAS] = …` — resolve the alias to the literal it holds.
    for (const [, alias] of source.matchAll(/process\.env\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=[^=]/g)) {
      const resolved = alias === undefined ? undefined : aliases.get(alias);
      if (resolved) assigned.add(resolved);
    }
    for (const [, name] of source.matchAll(/vi\.stubEnv\(\s*'([A-Z0-9_]+)'/g)) {
      if (name) assigned.add(name);
    }
    return assigned;
  }

  /**
   * Suites that assign a budget and legitimately pin NEITHER a window nor the
   * helper. An exemption is a decision ON THE RECORD with the reason it is one —
   * the point of the derivation is that forgetting is no longer an option, not
   * that no file may ever be exempt.
   *
   * Empty is the honest state right now: every current assigner either pins its
   * window or imports the helper. A genuinely single-call suite added later
   * belongs here WITH its reason, not silently.
   */
  const EXEMPT: ReadonlyMap<string, string> = new Map();

  /**
   * A real IMPORT of the alignment helper — not a mention of it.
   *
   * ⚠️ This started as `source.includes('helpers/rateLimitWindow')`, and that is
   * the SAME defect this file already documents one section up under "detection
   * is by ASSIGNMENT, never by mention": every file that aligns also NAMES the
   * helper in a comment explaining why, so a substring check is satisfied by the
   * comment alone. Caught by mutation (MOTIR-3016) — deleting the import
   * statement from `tests/rateLimit/guard.test.ts` left its header paragraph
   * behind, and the guard stayed green over a file that no longer aligned at
   * all. A guard whose pass condition a COMMENT can satisfy is a guard the next
   * author disables by documenting their intention.
   *
   * ⚠️ And the FIRST tightening was too tight, which is the other half of the
   * lesson: keying on `from '…'` alone reported
   * `tests/api-coding-convention-route.test.ts` as an offender, a file that
   * aligns perfectly well through a top-level `await import('./helpers/…')`
   * because it needs the module before a `vi.mock` factory runs. A guard with a
   * false positive gets deleted rather than obeyed, so the pattern accepts every
   * form that actually BINDS the module — static `from`, dynamic `import(`,
   * `require(` — and rejects only a bare mention in prose. What all three share,
   * and a comment does not, is a QUOTED specifier in an import position.
   */
  const IMPORTS_HELPER =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*helpers\/rateLimitWindow['"]/;

  it('derives the budget envs from lib/ (a guard over zero budgets proves nothing)', () => {
    const budgets = budgetEnvs();

    expect(budgets.length).toBeGreaterThanOrEqual(6);
    expect(budgets).toContain('MOTIR_API_V1_RATE_LIMIT');
    expect(budgets).toContain('MOTIR_AI_GENERATE_RATE_LIMIT');
    // A switch with no window is not a fixed-window budget, and is excluded by
    // the pairing rather than by an exemption.
    expect(budgets).not.toContain('E2E_DISABLE_RATE_LIMIT');
  });

  it('every test file that sets a budget pins its window or imports the helper', () => {
    const budgets = budgetEnvs();
    const offenders: string[] = [];

    for (const file of testSources()) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      const assigned = assignedEnvs(source);
      const set = budgets.filter((name) => assigned.has(name));
      if (set.length === 0 || EXEMPT.has(file)) continue;

      if (IMPORTS_HELPER.test(source)) continue;
      const unpinned = set.filter((name) => !assigned.has(`${name}_WINDOW_MS`));
      if (unpinned.length > 0) offenders.push(`${file} → ${unpinned.join(', ')}`);
    }

    expect(
      offenders,
      `these test files set a rate-limit BUDGET and leave the matching WINDOW at ` +
        `the shipped 60 s default, so calls they expect to be counted together can ` +
        `straddle an epoch-aligned boundary and reset the counter mid-test. Pin ` +
        `\`<BUDGET>_WINDOW_MS\` to \`ALIGNED_WINDOW_MS\`, and if the case asserts a ` +
        `REFUSAL that depends on earlier calls also ` +
        `\`await waitForWindowBoundary(ALIGNED_WINDOW_MS)\` — both from ${HELPER}. ` +
        `See MOTIR-2648`,
    ).toEqual([]);
  });

  // ⚠️ Same discipline as the copy-detection half above: the derivation is
  // proven by DELIBERATELY introducing the violation. A guard nobody has watched
  // fail is indistinguishable from no guard — and this half REPLACED one that
  // silently passed through four occurrences of the defect.
  it('the derivation fires on a budget set with no window pinned', () => {
    const violating = `process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';`;
    const assigned = assignedEnvs(violating);

    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(true);
    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS')).toBe(false);
  });

  it('the derivation is NOT satisfied by merely NAMING the window', () => {
    // The `surfaceGuards.test.ts` shape exactly: the window sits in a cleanup
    // array, so the name is present while the knob is never set. A mention-based
    // check would have passed this file for as long as it existed.
    const naming = [
      `const ENVS = ['MOTIR_AI_GENERATE_RATE_LIMIT', 'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS'];`,
      `for (const key of ENVS) delete process.env[key];`,
      `process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] = '1';`,
    ].join('\n');
    const assigned = assignedEnvs(naming);

    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(true);
    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS')).toBe(false);
  });

  it('the derivation sees an assignment made through a const alias', () => {
    // `tests/mcp/rate-limit-gate.test.ts`'s form — the most recent occurrence of
    // the class, and invisible to a literal-only matcher.
    const aliased = [
      `const LIMIT_ENV = 'MOTIR_AI_GENERATE_RATE_LIMIT';`,
      `const WINDOW_ENV = 'MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS';`,
      `process.env[LIMIT_ENV] = '1';`,
      `process.env[WINDOW_ENV] = String(ALIGNED_WINDOW_MS);`,
    ].join('\n');
    const assigned = assignedEnvs(aliased);

    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(true);
    expect(assigned.has('MOTIR_AI_GENERATE_RATE_LIMIT_WINDOW_MS')).toBe(true);
  });

  it('the derivation does NOT fire on a mere READ of the env', () => {
    const reading = `const budget = Number(process.env['MOTIR_AI_GENERATE_RATE_LIMIT'] ?? '10');`;

    expect(assignedEnvs(reading).has('MOTIR_AI_GENERATE_RATE_LIMIT')).toBe(false);
  });

  // ── THE THIRD DERIVATION: AN ABSENT ALIGNMENT (MOTIR-3016) ────────────────
  // The two halves above catch a file that does the WRONG thing — copies the
  // phase, or pins a budget and leaves its window at the shipped default. Both
  // key on something being PRESENT. Neither can see a file that does NOTHING,
  // and that is the population that keeps producing this defect.
  //
  // `tests/rateLimit/guard.test.ts` built its budgets INLINE —
  // `{ limit: 1, windowMs: WINDOW }` handed straight to `enforceRateLimit` — so
  // it assigned no env for the derivation above to notice, recomputed no phase
  // for the sweep above to flag, and simply never aligned. It rolled dice on
  // every CI run from the day it was written, red-lighting unrelated pull
  // requests, with a correctly-aligned sibling sitting in the same directory.
  // The sweep that found it found a second one, `tests/rateLimit/sharedStore.test.ts`.
  //
  // ⚠️ The reusable part is the asymmetry, and it is why this half exists at
  // all: a guard keyed on A WRONG THING BEING PRESENT catches the careless; a
  // guard keyed on A RIGHT THING BEING ABSENT catches the unaware — and the
  // unaware are the larger population. The first kind is much easier to write,
  // which is why it is usually the one that exists.
  //
  // So the subject set is widened rather than the pattern: a file BUILDS a
  // rate-limit budget when it assigns a budget env (the derivation above) OR
  // constructs the budget object itself, and every such file must import the
  // helper. Opting out is possible and must be SAID — `NON_ACCUMULATING`, with a
  // reason per entry. Silence is not an opt-out, which is the whole difference
  // between this and the state the defect grew in.

  /**
   * `RateLimitBudget`'s field names, read from `lib/`. Derived rather than
   * written out for the same reason the budget envs are: a renamed field must
   * break this guard loudly, not disable it silently.
   */
  function budgetFields(): string[] {
    const source = readFileSync(join(REPO_ROOT, 'lib/api/v1/rateLimit.ts'), 'utf8');
    const body = /export interface RateLimitBudget\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
    return [...body.matchAll(/(\w+)\s*:/g)].map(([, name]) => name as string).sort();
  }

  /**
   * An object literal carrying EVERY field of `RateLimitBudget`, in either order
   * — i.e. a budget constructed in the test rather than read from the
   * environment.
   *
   * Requiring the whole shape is what keeps the false positives out, and there
   * are two real ones in the tree: a `RateLimitDecision` literal has `limit` and
   * no `windowMs` (`retryAfterPluralisation.test.ts` is full of them), and the
   * acceptance-video diagnostics carry a `windowMs` that is a sampling interval
   * with no `limit` anywhere near it. Neither is a budget, and neither matches.
   */
  function inlineBudget(): RegExp {
    const [first, second] = budgetFields();
    const pair = (a: string, b: string) => String.raw`\{[^{}]*\b${a}\s*:[^{}]*\b${b}\s*:[^{}]*\}`;
    return new RegExp(`${pair(first!, second!)}|${pair(second!, first!)}`);
  }

  /**
   * THE PREDICATE. A test file builds a fixed-window rate-limit budget when it
   * either assigns one through the environment or constructs one inline.
   */
  function buildsRateLimitBudget(source: string, budgets: string[]): boolean {
    const assigned = assignedEnvs(source);
    return budgets.some((name) => assigned.has(name)) || inlineBudget().test(source);
  }

  /**
   * Files that build a budget and legitimately never ACCUMULATE — a single
   * counted call, or a budget that is only ever read for its shape — so the
   * alignment buys them nothing.
   *
   * The named alternative to silence. An entry is a decision on the record with
   * the reason it is one; a file that merely forgot has no entry and fails.
   *
   * Empty is the honest state today: every file that builds a budget imports the
   * helper. A genuinely single-call suite added later belongs here WITH its
   * reason, not quietly outside the assertion.
   */
  const NON_ACCUMULATING: ReadonlyMap<string, string> = new Map([
    [
      'tests/api/v1/work-item-conformance.test.ts',
      'Assigns the budget envs ONLY to save and restore the ambient values around ' +
        'the suite; no case sets a budget of its own. Its one limiter case — "a full ' +
        'paged scan of a realistic collection never trips the limiter" — deletes both ' +
        'envs to run against the SHIPPED budget and asserts every request is ALLOWED. ' +
        'A straddle can only ever hand a case MORE budget, so it cannot turn an ' +
        'assertion that something was allowed red; only a REFUSAL is exposed to the ' +
        'race, and this file asserts none. (MOTIR-3016)',
    ],
    [
      'tests/two-instance/globalSetup.ts',
      'Not a test: the lane’s globalSetup only HANDS the budget to the two `next start` ' +
        'processes it spawns, through their env. Every case that spends that budget is ' +
        'in `tests/two-instance/limits.spec.ts`, which calls `waitForWindowHeadroom` ' +
        'before each accumulating sequence. (MOTIR-8616, MOTIR-8617)',
    ],
  ]);

  it('derives the budget SHAPE from lib/ (a guard over an empty shape proves nothing)', () => {
    const fields = budgetFields();

    expect(fields).toEqual(['limit', 'windowMs']);
    // ...and the regex built from it really does need BOTH — a decision literal
    // carries `limit` and is not a budget.
    expect(inlineBudget().test(`const b = { limit: 1, windowMs: 60_000 };`)).toBe(true);
    expect(
      inlineBudget().test(`const d = { allowed: false, limit: 5, remaining: 0, degraded: false };`),
    ).toBe(false);
  });

  it('the predicate finds the suites that actually build budgets', () => {
    const budgets = budgetEnvs();
    const subjects = testSources().filter((file) =>
      buildsRateLimitBudget(readFileSync(join(REPO_ROOT, file), 'utf8'), budgets),
    );

    // Both arms are represented: the two files MOTIR-3016 converted build their
    // budgets INLINE and assign no env at all, which is exactly why the
    // env-only derivation above could not see them.
    expect(subjects).toContain('tests/rateLimit/guard.test.ts');
    expect(subjects).toContain('tests/rateLimit/sharedStore.test.ts');
    expect(subjects).toContain('tests/rateLimit/surfaceGuards.test.ts');
    expect(subjects).toContain('tests/api/v1/rate-limit.test.ts');
    expect(subjects).toContain('tests/mcp/rate-limit-gate.test.ts');
    // A suite that builds no budget is not a subject — otherwise the assertion
    // below would be over the whole tree and would have to be turned off.
    expect(subjects).not.toContain('tests/rateLimit/retryAfterPluralisation.test.ts');
    expect(subjects).not.toContain('tests/acceptance-video-diagnostics.test.ts');
  });

  it('every test file that BUILDS a rate-limit budget imports the alignment helper', () => {
    const budgets = budgetEnvs();
    const offenders: string[] = [];

    for (const file of testSources()) {
      if (file === HELPER || NON_ACCUMULATING.has(file)) continue;
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (!buildsRateLimitBudget(source, budgets)) continue;
      if (!IMPORTS_HELPER.test(source)) offenders.push(file);
    }

    expect(
      offenders,
      `these test files build a fixed-window rate-limit budget and never align to ` +
        `the epoch grid the limiter buckets on, so any case of theirs that spends ` +
        `the budget more than once can have its counter reset mid-test and serve a ` +
        `call it expected to be refused. Import \`ALIGNED_WINDOW_MS\` from ${HELPER} ` +
        `and \`await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS)\` ` +
        `before every ACCUMULATING case — or, if the file genuinely never ` +
        `accumulates, add it to NON_ACCUMULATING with the reason. See MOTIR-3016`,
    ).toEqual([]);
  });

  // ⚠️ Same discipline as both halves above: proven by DELIBERATELY introducing
  // the violation. This is the arm that matters most, because the thing it
  // detects is an ABSENCE — and an assertion that nothing is missing passes
  // just as happily when it is looking at nothing at all.
  it('fires on a suite that builds a budget inline and never aligns', () => {
    const budgets = budgetEnvs();
    // `tests/rateLimit/guard.test.ts` as it stood before MOTIR-3016, in three
    // lines: a raw window, an inline budget, two counted calls, no helper.
    const violating = [
      `const WINDOW = 60_000;`,
      `const limb = { scope: 'public-write', key, budget: { limit: 1, windowMs: WINDOW } };`,
      `expect((await enforceRateLimit([limb])).response).not.toBeNull();`,
    ].join('\n');

    expect(buildsRateLimitBudget(violating, budgets)).toBe(true);
    expect(IMPORTS_HELPER.test(violating)).toBe(false);
  });

  it('a COMMENT naming the helper does not count as importing it', () => {
    // The mutation that found this: strip the import statement and the file's
    // own explanatory paragraph still says `tests/helpers/rateLimitWindow.ts`.
    const mentions = [
      `// See tests/helpers/rateLimitWindow.ts for why this matters.`,
      `const budget = { limit: 1, windowMs: 60_000 };`,
    ].join('\n');
    const imports = `import { ALIGNED_WINDOW_MS } from '@/tests/helpers/rateLimitWindow';`;
    const relative = `import { sleep } from '../../helpers/rateLimitWindow';`;
    // `tests/api-coding-convention-route.test.ts`'s form — it needs the module
    // before a `vi.mock` factory runs, so the import is dynamic and top-level.
    const dynamic = `const { ALIGNED_WINDOW_MS } = await import('./helpers/rateLimitWindow');`;

    expect(IMPORTS_HELPER.test(mentions)).toBe(false);
    expect(IMPORTS_HELPER.test(imports)).toBe(true);
    expect(IMPORTS_HELPER.test(relative)).toBe(true);
    expect(IMPORTS_HELPER.test(dynamic)).toBe(true);
  });

  it('does NOT fire on a suite that builds a decision rather than a budget', () => {
    const budgets = budgetEnvs();
    // `retryAfterPluralisation.test.ts`'s shape — it asserts on the 429's prose
    // and never touches a counter, a window or a clock beyond one offset.
    const decision = [
      `function refusal(secondsOut: number): RateLimitDecision {`,
      `  return { allowed: false, limit: 60, remaining: 0, resetAt: 1, degraded: false };`,
      `}`,
    ].join('\n');

    expect(buildsRateLimitBudget(decision, budgets)).toBe(false);
  });

  it('does NOT fire on a windowMs that is not a budget at all', () => {
    const budgets = budgetEnvs();
    // The acceptance-video diagnostics sample interval — same field name, no
    // limiter within a mile of it.
    const sampling = `samples.push({ label: 'nav', windowMs: Math.round(end - start) });`;

    expect(buildsRateLimitBudget(sampling, budgets)).toBe(false);
  });

  // ── THE FOURTH DERIVATION: A COUNT READ BACK WITH NO BUDGET BUILT (MOTIR-6418) ──
  // The third derivation's subjects are files that BUILD a budget. A file can
  // assert a limiter's accumulated count without building anything: it runs the
  // real route under the SHIPPED budget and reads the `rate_limit_counter` rows
  // back. `tests/mcp/sdkSseGetSettled.test.ts` did exactly that — three
  // `mcp:call`s held 1.5 s each, then `[3]` asserted over every row for the key —
  // and it matched none of the three predicates above, so it straddled the 60 s
  // grid about one run in fourteen with this guard green over it. The fourth
  // defect of the class, and the second to arrive through a gap in the SUBJECTS
  // rather than in the pattern.
  //
  // So the subject set widens once more: a file that READS the counter — a query
  // against its table, a Prisma read of its model, or a read method of its
  // repository — must CALL `waitForWindowHeadroom` / `waitForWindowBoundary`. A
  // call, not an import: a file can import `currentWindowStart` to know which row
  // to read and still never make sure its calls land in that row. Opting out is
  // `COUNTER_READ_EXEMPT`, with the reason.
  //
  // ⚠️ Matched over the WHOLE file with comments stripped, never line by line: a
  // formatter wraps a long SQL string across lines, and the headers of these very
  // suites name the table and the helper in prose.

  /** `rateLimitCounterRepository`'s READ methods, derived from `lib/`. */
  function counterReadMethods(): string[] {
    const source = readFileSync(
      join(REPO_ROOT, 'lib/repositories/rateLimitCounterRepository.ts'),
      'utf8',
    );
    return [...source.matchAll(/^\s*async\s+((?:find|count)\w*)\s*\(/gm)]
      .map(([, name]) => name as string)
      .sort();
  }

  /** Source code only — block comments and whole-line `//` comments removed. */
  function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  /**
   * THE PREDICATE. A test file reads the counter when its CODE selects from the
   * table (inside one string — a quote ends the match, so an unrelated SELECT
   * cannot reach a table name further down), reads the Prisma model, or calls
   * one of the repository's read methods.
   */
  function readsRateLimitCounter(source: string, readMethods: string[]): boolean {
    const code = withoutComments(source);
    const sql = /\bSELECT\b[^;`']*?\bFROM\s+"?rate_limit_counter\b/i;
    const model = /\.rateLimitCounter\.(?:find\w*|count|aggregate|groupBy)\s*\(/;
    const repo = new RegExp(
      String.raw`\brateLimitCounterRepository\.(?:${readMethods.join('|')})\s*\(`,
    );
    return sql.test(code) || model.test(code) || repo.test(code);
  }

  /**
   * A CALL that secures the window, in code: an alignment wait, or freezing the
   * clock the limiter reads (`tests/helpers/frozenWindowClock.ts`, MOTIR-10807),
   * which secures it outright — every counted call then reads the same instant.
   */
  const CALLS_ALIGNMENT =
    /\b(?:waitForWindowHeadroom|waitForWindowBoundary|freezeWindowClock)\s*\(/;

  /**
   * Files that read the counter and legitimately never depend on which cell
   * their calls landed in. Each entry is a reader whose counted calls run on an injected clock.
   */
  const COUNTER_READ_EXEMPT: ReadonlyMap<string, string> = new Map([
    [
      'tests/inProcessState/guards.test.ts',
      'Every call it counts runs on an INJECTED clock (`now: () => T`, a fixed instant ' +
        '15 minutes into an hour window), never the wall clock, so all of them land in ' +
        'the one window that instant names and no boundary can fall between them. ' +
        '(MOTIR-8619)',
    ],
    [
      'tests/rateLimit/betterAuthStorage.test.ts',
      'Every call it counts runs on an INJECTED clock (`machine(() => t)` with `t` a ' +
        'fixed instant the case chooses inside its window), never the wall clock; the one ' +
        'case that crosses a boundary does so on purpose by advancing `t`. The row it ' +
        'reads back is addressed by that same instant. (MOTIR-8613)',
    ],
  ]);

  it('derives the counter read methods from lib/ (a guard over no readers proves nothing)', () => {
    expect(counterReadMethods()).toEqual(['countAllUnsafe', 'findCountUnsafe']);
  });

  it('the predicate finds the suites that read the counter back', () => {
    const methods = counterReadMethods();
    const subjects = testSources().filter((file) =>
      readsRateLimitCounter(readFileSync(join(REPO_ROOT, file), 'utf8'), methods),
    );

    // Each arm is represented: SQL, and the repository read.
    expect(subjects).toContain('tests/mcp/sdkSseGetSettled.test.ts');
    expect(subjects).toContain('tests/attachments/attachments-service.test.ts');
    expect(subjects).toContain('tests/api/v1/shared-store.test.ts');
    expect(subjects).toContain('tests/rateLimit/guard.test.ts');
    // A TRUNCATE is not a read, and the RLS scanners name the methods in strings
    // and comments without calling them.
    expect(subjects).not.toContain('tests/helpers/db.ts');
    expect(subjects).not.toContain('tests/rls/testCallSiteScan.ts');
    expect(subjects).not.toContain('tests/rls/singleton-read-guard.test.ts');
  });

  it('every test file that READS the rate-limit counter calls an alignment wait', () => {
    const methods = counterReadMethods();
    const offenders: string[] = [];

    for (const file of testSources()) {
      if (file === HELPER || COUNTER_READ_EXEMPT.has(file)) continue;
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (!readsRateLimitCounter(source, methods)) continue;
      if (!CALLS_ALIGNMENT.test(withoutComments(source))) offenders.push(file);
    }

    expect(
      offenders,
      `these test files read \`rate_limit_counter\` back and never secure the window ` +
        `their counted calls land in, so the calls can straddle an epoch-aligned ` +
        `boundary and split across two rows. Before the first counted call, ` +
        `\`await waitForWindowHeadroom(<the budget's windowMs>, <headroom sized from ` +
        `the counted span>)\` from ${HELPER}, or freeze the clock with ` +
        `\`freezeWindowClock()\` from tests/helpers/frozenWindowClock.ts — or, if the ` +
        `file's assertion cannot ` +
        `straddle, add it to COUNTER_READ_EXEMPT with the reason. See MOTIR-6418`,
    ).toEqual([]);
  });

  // Proven by DELIBERATELY introducing the violation: the pre-fix shape of
  // `sdkSseGetSettled.test.ts`, planted. Interpolated so this file is not itself
  // a reader of the counter.
  it('fires on a suite that reads the counter back and never aligns', () => {
    const methods = counterReadMethods();
    const table = 'rate_limit' + '_counter';
    const planted = [
      `await connectWith(observing);`,
      `const rows = await adminDb.$queryRawUnsafe(`,
      `  \`SELECT count::int AS count`,
      `   FROM "${table}" WHERE key = $1\`,`,
      `  key,`,
      `);`,
      `expect(rows.map((r) => r.count)).toEqual([3]);`,
    ].join('\n');

    expect(readsRateLimitCounter(planted, methods)).toBe(true);
    expect(CALLS_ALIGNMENT.test(withoutComments(planted))).toBe(false);
    // The fix makes it compliant.
    const fixed = `await waitForWindowHeadroom(mcpBudget().windowMs, 9_000);\n${planted}`;
    expect(CALLS_ALIGNMENT.test(withoutComments(fixed))).toBe(true); // …and so does freezing the clock the limiter reads (MOTIR-10807).
    const frozen = `freezeWindowClock();\n${planted}`;
    expect(CALLS_ALIGNMENT.test(withoutComments(frozen))).toBe(true);
  });

  it('sees a repository read, and does NOT count a comment as a read or as a call', () => {
    const methods = counterReadMethods();
    const repo = 'rateLimitCounter' + 'Repository';
    const read = `expect(await ${repo}.findCountUnsafe(key, BigInt(start))).toBe(2);`;
    const commented = [
      `// ${repo}.countAllUnsafe()  — pre-auth, leave`,
      `/* SELECT key FROM "rate_limit${'_'}counter" */`,
      `// await waitForWindowHeadroom(w, h);`,
    ].join('\n');

    expect(readsRateLimitCounter(read, methods)).toBe(true);
    expect(readsRateLimitCounter(commented, methods)).toBe(false);
    expect(CALLS_ALIGNMENT.test(withoutComments(commented))).toBe(false);
  });

  it('does NOT fire on a write or a truncate of the counter', () => {
    const methods = counterReadMethods();
    const table = 'rate_limit' + '_counter';
    const writes = [
      `await db.$executeRawUnsafe('TRUNCATE TABLE "${table}"');`,
      `await rateLimitCounter${'Repository'}.increment(key, start, expiresAt, tx);`,
    ].join('\n');

    expect(readsRateLimitCounter(writes, methods)).toBe(false);
  });

  it('every COUNTER_READ_EXEMPT entry names a real file and says why', () => {
    for (const [file, reason] of COUNTER_READ_EXEMPT) {
      expect(testSources(), `${file} opts out but does not exist`).toContain(file);
      expect(reason.length, `${file}'s opt-out needs a reason`).toBeGreaterThan(20);
    }
  });

  it('every NON_ACCUMULATING entry names a real file and says why', () => {
    for (const [file, reason] of NON_ACCUMULATING) {
      expect(testSources(), `${file} opts out but does not exist`).toContain(file);
      expect(reason.length, `${file}'s opt-out needs a reason`).toBeGreaterThan(20);
    }
  });

  it('every exemption carries a reason', () => {
    for (const [file, reason] of EXEMPT) {
      expect(testSources(), `${file} is exempted but does not exist`).toContain(file);
      expect(reason.length, `${file}'s exemption needs a reason`).toBeGreaterThan(20);
    }
  });
});

// The helper's own contract. `waitForWindowBoundary` is exercised by every suite
// that imports it; `waitForWindowHeadroom` (MOTIR-2648) is newer and its whole
// value is the branch — it must SKIP the sleep when the cell has room and take
// it when it does not, because a version that always slept would silently cost
// 30 s per subprocess case and one that never slept would be no guard at all.
describe('waitForWindowHeadroom', () => {
  it('returns immediately when the current cell has room to spare', async () => {
    const startedAt = Date.now();
    // A window far larger than the phase can be, so the remainder always clears
    // a 1 ms floor — the no-sleep arm, without depending on the wall clock.
    await waitForWindowHeadroom(Number.MAX_SAFE_INTEGER, 1);

    expect(Date.now() - startedAt).toBeLessThan(50);
  });

  // ⚠️ THE BRANCH IS ASSERTED AT SYNTHETIC INSTANTS, NOT BY TIMING A REAL CALL
  // (MOTIR-3127). This describe used to prove the sleeping arm by asserting
  // `elapsed > 0` on `waitForWindowHeadroom(w, w)`, over the claim that a
  // whole-window request "can never be satisfied by the remainder". It can, at
  // exactly one phase: on a boundary millisecond `remaining === w`, which
  // satisfies the request — so the call returned immediately, `elapsed` was 0,
  // and the case went red about one run in `w`. Timing a real call cannot fix
  // that, because whichever arm the test wants, the clock picks the other one
  // some of the time; forcing the phase first only moves the race (a millisecond
  // of drift between forcing it and reading it flips the arm back). Injecting
  // `now` removes the clock from the assertion instead.
  it('takes the sleeping arm for every phase EXCEPT a boundary millisecond', () => {
    const w = 200;

    // 1000 % 200 === 0 — the whole window IS available, so no sleep. This is the
    // case the old comment said could not happen, and the helper is right: a
    // caller standing exactly at a boundary has what it asked for, and sleeping
    // would buy a full window of dead time for nothing.
    expect(headroomIsSatisfied(w, w, 1000)).toBe(true);

    // One millisecond past it, and every phase after, the cell is short.
    expect(headroomIsSatisfied(w, w, 1001)).toBe(false);
    expect(headroomIsSatisfied(w, w, 1100)).toBe(false);
    expect(headroomIsSatisfied(w, w, 1199)).toBe(false);

    // …and the next boundary is satisfied again.
    expect(headroomIsSatisfied(w, w, 1200)).toBe(true);
  });

  it('puts the partial-headroom threshold exactly where the arithmetic does', () => {
    const w = 200;
    const headroom = 120;

    // Remaining is `w - (now % w)`, so the last satisfying instant is the one
    // with exactly `headroom` left — inclusive, because `>=`.
    expect(headroomIsSatisfied(w, headroom, 1000)).toBe(true); // 200 remaining
    expect(headroomIsSatisfied(w, headroom, 1080)).toBe(true); // 120 remaining
    expect(headroomIsSatisfied(w, headroom, 1081)).toBe(false); // 119 remaining
    expect(headroomIsSatisfied(w, headroom, 1199)).toBe(false); // 1 remaining
  });

  it('never costs more than one window, whichever arm the phase selects', async () => {
    const windowMs = 200;
    const startedAt = Date.now();
    // The COST bound, which is true of both arms — so unlike the assertion this
    // replaces, it cannot depend on which one the clock happened to select.
    await waitForWindowHeadroom(windowMs, windowMs);

    expect(Date.now() - startedAt).toBeLessThanOrEqual(windowMs + BOUNDARY_OVERSHOOT_MS + 100);
  });

  // The guarantee, asserted BEHAVIOURALLY rather than by recomputing the phase:
  // once the call has returned, the cell provably holds at least `headroom`, so
  // an immediate second call with the same arguments must not sleep. Written
  // this way on purpose — spelling the phase expression out here, even to assert
  // on it, would make this file the second copy the sweep above forbids. (It
  // does: the first draft of this comment quoted the expression and the sweep
  // duly failed on its own suite, which is the guard working.)
  it('guarantees the requested headroom, whatever the phase it started in', async () => {
    const windowMs = 200;
    const headroom = 120;

    for (let i = 0; i < 6; i += 1) {
      await waitForWindowHeadroom(windowMs, headroom);

      const startedAt = Date.now();
      await waitForWindowHeadroom(windowMs, headroom);
      expect(Date.now() - startedAt, 'the headroom was not actually secured').toBeLessThan(20);

      await sleep(43); // walk the phase so the next iteration starts elsewhere
    }
  });

  it('is the generalisation of waitForWindowBoundary, not a rival to it', () => {
    // `waitForWindowBoundary(w)` ≡ `waitForWindowHeadroom(w, w)` — the arithmetic
    // still lives in exactly one function, which is what the sweep above checks.
    expect(SUBPROCESS_HEADROOM_MS).toBeLessThan(SUBPROCESS_WINDOW_MS);
    expect(ALIGNED_WINDOW_MS).toBeLessThan(SUBPROCESS_WINDOW_MS);
  });
});
