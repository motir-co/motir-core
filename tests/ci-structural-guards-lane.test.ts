import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
  BOUNDED_SCAN_MODULES,
  DATABASE_BOUND_GUARDS,
  entryPointsIn,
  FILESYSTEM_ENTRY_POINTS,
  STRUCTURAL_GUARD_SPECS,
} from './helpers/structuralGuardLane';

// MOTIR-3144 — the guard ON the structural-guard lane.
//
// ── What this file exists to prevent ────────────────────────────────────────
// The lane is an explicit `include` list, which is the right shape (a glob over
// `tests/rls/**` would sweep up the two guards that legitimately need a
// database) and the wrong shape for staying complete. A whole-tree guard written
// next month lands in `tests/**`, runs inside the sharded database job by
// default, and nothing says otherwise until it times out on somebody else's pull
// request — which is precisely the bug this card fixed, one level up.
//
// So membership is DERIVED here and compared against the list. A new guard fails
// this test, with the file named, until it is either added to the lane or
// declared in `DATABASE_BOUND_GUARDS` with a reason.
//
// ── The predicate, and the line it deliberately draws ───────────────────────
// A file is a CANDIDATE when it imports a module under `tests/` that reaches
// the filesystem for a WHOLE-TREE answer.
//
// ⚠️ WIDENED BY MOTIR-3497, from the IMPORT to the PROPERTY. This test used to
// ask whether a module parsed the tree *with the TypeScript compiler API*, and
// that is a question about the implementation a guard happens to use rather
// than about the thing that makes one flake — doing whole-tree filesystem work
// under a budget sized for a database query, on a contended shard.
//
// `tests/coverage-gate-globs.test.ts` is what the gap cost. It resolves the
// whole `coverage.include` set with `tinyglobby` — 483 files, ~0.8 s quiet —
// and parses nothing, so the compiler-API predicate answered false and it
// stayed in the sharded run, where it timed out three times in four days at the
// 15 s `testTimeout` with zero assertion failures. A membership check that
// enumerates the scanner family it knows about is the same shape as the class
// it guards: a check that enumerates instances.
//
// So membership now derives from `FILESYSTEM_ENTRY_POINTS` — `readdirSync`, the
// awaited and streaming forms, `node:fs`'s `globSync`, `tinyglobby` /
// `fast-glob` / `globby`, `git ls-files`, and the compiler API — each carrying
// the reason it is a carrier, in `tests/helpers/structuralGuardLane.ts`.
//
// ── The second axis, and why it is DECLARED rather than derived ─────────────
// The entry-point set answers *does this touch the filesystem*. The lane is for
// *does this touch the WHOLE TREE*, and no regex reads that off a call site:
// `join(repoRoot, 'app')` and `join(repoRoot, 'app', 'api', 'v1')` are one path
// segment apart and three orders of magnitude apart in cost. So a module whose
// answer is bounded DECLARES itself in `BOUNDED_SCAN_MODULES` with the bound
// named, and this file checks that the declaration is about a real file that
// really does hold an entry point. Silence is not a declaration: a new module
// with an entry point and no entry there makes its importers candidates, and a
// candidate in neither the lane nor `DATABASE_BOUND_GUARDS` fails this test by
// name.
//
// ⚠️ Deliberately still NOT "everything under tests/rls/". That directory holds
// database-backed policy suites as well as scanners, and three of the four
// `DATABASE_BOUND_GUARDS` exceptions are in it. Naming a directory would have
// been easier and would have been wrong.
//
// ⚠️ AND still NOT "any test file that calls readdirSync". Measured on this
// tree, that predicate matches EIGHTY-TWO files — story gates, database-backed
// integration suites, component tests that read one fixture directory. Most
// walk a handful of directories and have never been implicated in a timeout.
// The lane's SELF-walking members (the rate-limit, ink-contrast, viewport and
// import-graph guards, which do their own walk instead of importing a scanner)
// are therefore listed explicitly and asserted present below, rather than
// derived. That half is recorded on MOTIR-3144 and unchanged here.

const ROOT = resolve(__dirname, '..');
const TESTS = join(ROOT, 'tests');
const GUARDS_CONFIG = readFileSync(join(ROOT, 'vitest.guards.config.ts'), 'utf8');
const ROOT_CONFIG = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Every `.ts`/`.tsx` file under `tests/`, repo-relative with forward slashes. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const ALL_TEST_FILES = walk(TESTS);

const isSpec = (f: string) => /\.test\.tsx?$/.test(f);
const isDeclaration = (f: string) => /\.d\.tsx?$/.test(f);

/**
 * The derivation, as PURE functions over a file list and a reader — so the
 * synthetic case at the bottom of this file can drive the identical code over a
 * tree that does not exist on disk. A control that re-implements the predicate
 * proves the control works, not the predicate (the same reasoning
 * `tests/hosting/abandonedPathGuard.ts` is split out for).
 */
export function scannerModulesIn(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  return files.filter(
    (f) =>
      !isSpec(f) &&
      !isDeclaration(f) &&
      !(f in BOUNDED_SCAN_MODULES) &&
      entryPointsIn(read(f)).length > 0,
  );
}

/** `tests/rls/bareTransactionScan.ts` → `bareTransactionScan`. */
function basenameOf(file: string): string {
  return file
    .split('/')
    .pop()!
    .replace(/\.tsx?$/, '');
}

export function candidateGuardsIn(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  const names = scannerModulesIn(files, read).map(basenameOf);
  return files.filter((f) => {
    if (!isSpec(f)) return false;
    const src = read(f);
    return names.some((name) => new RegExp(`from\\s+['"][^'"]*${name}['"]`).test(src));
  });
}

const readSource = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** Every module under `tests/` that reaches the filesystem for a whole-tree answer. */
const SCANNER_MODULES = scannerModulesIn(ALL_TEST_FILES, readSource);

/** Every guard that reaches one — derived, not listed. */
const CANDIDATES = candidateGuardsIn(ALL_TEST_FILES, readSource);

/**
 * The lane members that do their OWN text walk rather than importing a scanner.
 * Listed because the mechanical predicate for "walks a tree" is far broader than
 * this class (see the header), so these are asserted present instead of derived.
 */
const SELF_WALKING_MEMBERS = [
  'tests/permissions/writeControlGuard.test.ts',
  'tests/rateLimit/one-counter-guard.test.ts',
  'tests/rateLimit/storeDeadline.test.ts',
  'tests/theme/inkContrastLint.test.ts',
  'tests/theme/inkContrastScan.test.ts',
  'tests/theme/shellViewportUnits.test.ts',
  'tests/guards/follow-and-typewriter-mounts.test.ts',
  // MOTIR-3497's sweep. `importGraph.test.ts` walks `['app', 'lib',
  // 'components']` with its own `readdirSync` and imports no scanner, so the
  // derivation cannot see it — the same half this list has always covered.
  // THIS FILE is here for the same reason and is worth saying out loud: the
  // guard on the lane walks all of `tests/` and reads every file in it, so it
  // is a member of the class it adjudicates. It cannot derive itself (the
  // derivation only looks at what a spec IMPORTS), which is exactly why the
  // self-walking half of this list exists.
  'tests/helpers/importGraph.test.ts',
  'tests/ci-structural-guards-lane.test.ts',
  'tests/legal/egress-manifest-guard.test.ts',
  // MOTIR-4089. It does its own `readdirSync` over `tests/` and imports only a
  // dependency-free helper, so — like the entries above — nothing derives it.
  'tests/timeout-budget-lane.test.ts',
  // MOTIR-4084. It walks `app/`, `components/` and the design system's `src/`
  // with its own `readdirSync`; the only thing it imports is `importGraph`'s
  // `stripComments`, which parses text handed to it and reaches no filesystem
  // of its own — so, like the entries above, nothing derives it.
  'tests/theme/namedMaxWidthUtilities.test.ts',
  // MOTIR-4230. Same shape as the entry above and the same reason nothing
  // derives it: its own `readdirSync` over `app/`, `components/` and the design
  // system's `src/`, importing no scanner at all.
  'tests/theme/immersiveShellAtmosphere.test.ts',
  // MOTIR-4296. Same shape and the same reason nothing derives it: its own
  // `readdirSync` over `lib/`, `app/` and `components/`, importing no scanner.
  'tests/prisma/typeBoundary.test.ts',
  // MOTIR-6650. Its own `readdirSync` over `app/api/` and the three source
  // roots; it imports no scanner, so nothing derives it.
  'tests/visitor/visitorWriteDoorGuard.test.ts',
  // MOTIR-4299. Its own `readdirSync` over the `packages/*` trees it discovers
  // and over `lib`/`app`/`components`; it imports no scanner, so nothing
  // derives it.
  'tests/packages/importDirection.test.ts',
  // MOTIR-4299 / MOTIR-4300. Its own `readdirSync` over four roots; it imports no
  // scanner, so nothing derives it.
  'tests/ciFleet/orchestratorPortBoundary.test.ts',
  // MOTIR-9280. Its own `readdirSync` over the package's `src`, `lib` and `app`;
  // it imports only `importGraph`'s `stripComments` — so nothing derives it.
  'tests/ciFleet/awsSdkBoundary.test.ts',
  // MOTIR-4751. Its own `readdirSync` over the acceptance config's `testDir`;
  // the only thing it imports is `importGraph`'s `specifiersOf`, which parses
  // text handed to it and reaches no filesystem of its own — so, like the
  // entries above, nothing derives it.
  'tests/e2e-acceptance-lane-imports.test.ts',
  // MOTIR-5037. It reaches the tree through a SUBPROCESS — the shared predicate
  // in `scripts/enumerate-page-locators.mjs` — rather than through an entry
  // point in its own source, so it is invisible to `entryPointsIn` for a reason
  // none of the entries above has: not "it walks by hand", but "it walks
  // somewhere this file cannot read". Worth keeping distinct, because the
  // obvious repair (teach `entryPointsIn` about `execFileSync`) would match
  // every test that shells out to anything, which is a much larger set than the
  // one the lane is for.
  'tests/e2e-page-rooted-locators.test.ts',
  // MOTIR-5459. Its own `readdirSync` over `app/`, `components/` and the design
  // system's `src/`; it imports `importGraph`'s `stripComments` and
  // `tailwindCascade`, neither of which walks a tree — so nothing derives it.
  'tests/theme/lineClampDisplayOverride.test.ts',
  // MOTIR-5735. Its own `readdirSync` over `app/`, `components/` and
  // `packages/`; it imports only `importGraph`'s `stripComments` — so nothing
  // derives it.
  'tests/theme/switchPrimitiveOnly.test.ts',
] as const;

describe('the structural-guard lane (MOTIR-3144)', () => {
  it('finds scanners and candidates at all — the predicate is not vacuous', () => {
    // Without this, every assertion below passes on an empty set, which is the
    // way a totality test dies quietly.
    expect(SCANNER_MODULES.length).toBeGreaterThanOrEqual(7);
    expect(CANDIDATES.length).toBeGreaterThanOrEqual(6);
  });

  it('every entry point states WHY it is a carrier, and none is a dead letter', () => {
    // The list is the widening (MOTIR-3497). An entry with no reason beside it
    // is an enumeration again, one layer up — and an entry that matches nothing
    // ANYWHERE in the repository is a claim nobody has checked, so the second
    // assertion names the ones that are forward-looking rather than letting the
    // whole list rot silently.
    for (const entry of FILESYSTEM_ENTRY_POINTS) {
      expect(entry.why.length, `${entry.id} carries no reason`).toBeGreaterThan(60);
    }

    const matched = new Set(ALL_TEST_FILES.flatMap((f) => entryPointsIn(readSource(f))));
    // `fast-glob` and `globby` are deliberately named before this repository
    // uses either — that is the point of an entry-point list. Everything else
    // must be live, or it has stopped describing the tree.
    const expectedLive = FILESYSTEM_ENTRY_POINTS.map((e) => e.id).filter(
      (id) => id !== 'fast-glob' && id !== 'globby',
    );
    for (const id of expectedLive) {
      expect(matched, `${id} matches nothing under tests/ — has the shape moved?`).toContain(id);
    }
  });

  it('every BOUNDED_SCAN_MODULES entry is real — the file exists and does hold an entry point', () => {
    // Otherwise the register becomes a place to park anything inconvenient,
    // which is how an exception list stops meaning anything (the same bar
    // DATABASE_BOUND_GUARDS is held to below). A module here removes its
    // importers from the candidate set, so the blast radius is real:
    // `v1RouteAudit` alone accounts for twelve test files.
    for (const [file, reason] of Object.entries(BOUNDED_SCAN_MODULES)) {
      expect(ALL_TEST_FILES, `${file} is declared bounded but does not exist`).toContain(file);
      expect(
        entryPointsIn(readSource(file)),
        `${file} is declared bounded but reaches the filesystem through nothing — delete the entry`,
      ).not.toEqual([]);
      expect(reason.length, `${file}'s reason does not name its bound`).toBeGreaterThan(40);
      expect(file.endsWith('.test.ts') || file.endsWith('.test.tsx')).toBe(false);
    }
  });

  it('runs EVERY whole-tree guard, or says why one stays behind', () => {
    const inLane = new Set<string>(STRUCTURAL_GUARD_SPECS);
    const declared = new Set(Object.keys(DATABASE_BOUND_GUARDS));
    const unaccounted = CANDIDATES.filter((f) => !inLane.has(f) && !declared.has(f));

    // The message is the point: a new guard names itself here rather than
    // timing out on an unrelated pull request weeks later.
    expect(
      unaccounted,
      `These files scan the source tree but are in neither the structural-guard lane nor ` +
        `DATABASE_BOUND_GUARDS. Add each to STRUCTURAL_GUARD_SPECS in ` +
        `tests/helpers/structuralGuardLane.ts, or — if it genuinely needs a database — to ` +
        `DATABASE_BOUND_GUARDS with the reason.`,
    ).toEqual([]);
  });

  it('carries the self-walking guards too — the half the predicate cannot derive', () => {
    // These do their own `readdirSync` rather than importing a scanner, so
    // nothing derives them. If one is dropped from the lane it lands back in the
    // sharded job silently, which is the failure this whole card is about.
    for (const spec of SELF_WALKING_MEMBERS) {
      expect(STRUCTURAL_GUARD_SPECS as readonly string[], `${spec} left the lane`).toContain(spec);
    }
  });

  it('every file in the lane EXISTS and is a test', () => {
    // A rename that misses this list would silently shrink the lane to nothing,
    // and Vitest exits 0 on an `include` that matches no files.
    for (const spec of STRUCTURAL_GUARD_SPECS) {
      expect(ALL_TEST_FILES, `${spec} is listed in the lane but not present`).toContain(spec);
    }
  });

  it('the two exceptions are REAL — each named file actually binds a database', () => {
    // Otherwise `DATABASE_BOUND_GUARDS` becomes a place to park anything
    // inconvenient, which is how an exception list stops meaning anything.
    for (const [file, reason] of Object.entries(DATABASE_BOUND_GUARDS)) {
      expect(ALL_TEST_FILES, `${file} is declared an exception but does not exist`).toContain(file);
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(
        /helpers\/adminDb|@\/lib\/db|\.\.\/fixtures/.test(src),
        `${file} is declared database-bound but imports no database`,
      ).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('NOTHING in the lane reaches lib/, app/ or components/', () => {
    // Two properties at once: the lane needs no Prisma client to start, and it
    // can carry no coverage out of the merged report when it leaves the
    // `--coverage` shards. `storeDeadline` violated both through a single
    // constant until MOTIR-3144 moved it to a dependency-free module.
    for (const spec of STRUCTURAL_GUARD_SPECS) {
      const src = readFileSync(join(ROOT, spec), 'utf8');
      const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)';/gm)].flatMap((m) =>
        m[1] === undefined ? [] : [m[1]],
      );
      const reaching = imports.filter((i) => /^@\/(lib|app|components)\//.test(i));
      expect(reaching, `${spec} imports app code: ${reaching.join(', ')}`).toEqual([]);
    }
  });

  it('the root config EXCLUDES exactly what this lane includes', () => {
    // The two must be the same list, which is why it is one import in both.
    expect(ROOT_CONFIG).toContain("from './tests/helpers/structuralGuardLane'");
    expect(ROOT_CONFIG).toContain('...STRUCTURAL_GUARD_SPECS');
    // `exclude` REPLACES Vitest's default, so dropping `defaultExclude` would
    // put node_modules back into the run.
    expect(ROOT_CONFIG).toContain('...defaultExclude');
    expect(GUARDS_CONFIG).toContain('...STRUCTURAL_GUARD_SPECS');
  });

  it('has a CI job of its own, with no database and no coverage', () => {
    expect(CI).toMatch(/^ {2}structural-guards:$/m);
    expect(CI).toMatch(/^ {4}name: Structural guards$/m);

    const job = CI.slice(CI.indexOf('\n  structural-guards:'), CI.indexOf('\n  typecheck:'));
    expect(job).toContain('pnpm test:guards');
    // The whole point of the lane is that it costs an install and ~20 seconds.
    // Either of these would put it back in the class it was moved out of.
    expect(job).not.toContain('prisma');
    expect(job).not.toContain('actions/postgres');
    expect(job).not.toContain('--coverage');
    // No branch-prefix condition: a structural guard is exactly as relevant on a
    // `docs/` or `design/` branch, and cheap enough to always run.
    // (The draft skip is the one condition every job carries; it reads no diff.)
    expect(
      [...job.matchAll(/^ {4}if:(.*)$/gm)]
        .map((m) => m[1]!.trim())
        .filter(
          (c) =>
            c !==
            "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}",
        ),
    ).toEqual([]);
  });

  it('is gated through `CI complete`, like every other job', () => {
    // A job absent from `needs` is a job whose failure merges.
    const gate = CI.slice(CI.indexOf('\n  ci-complete:'));
    expect(gate).toMatch(/\bstructural-guards\b/);
  });

  it('`pnpm test:guards` runs the guards config', () => {
    expect(PACKAGE_JSON.scripts['test:guards']).toBe('vitest run --config vitest.guards.config.ts');
  });
});

// ── The widening, DEMONSTRATED (MOTIR-3497) ───────────────────────────────────
//
// The assertions above rule on THIS tree, and a predicate that has quietly
// stopped matching passes every one of them. So the derivation runs here against
// a synthetic tree that does not exist on disk — the SAME `scannerModulesIn` /
// `candidateGuardsIn` the real run uses, over a file list and a reader supplied
// by hand. That is the bar `tests/navigation/loading-boundary-guard.test.ts`
// meets with its own `FIRES on …  — demonstrated, not assumed` cases.
//
// One synthetic guard per entry point, each shaped like the real thing it stands
// for: the module walks, the spec imports it and asserts. Before this card, only
// the compiler-API row was caught.
describe('the membership predicate FIRES on every entry point — demonstrated, not assumed', () => {
  // ⚠️ Written as joined line arrays rather than template literals, for the
  // reason `loading-boundary-guard.test.ts` records: an indented fixture stops
  // being the shape it stands for, and a fixture that has drifted from the real
  // thing proves nothing about the real thing.
  const SYNTHETIC_SCANNERS: Readonly<Record<string, string>> = {
    'fs.readdirSync': [
      "import { readdirSync } from 'node:fs';",
      "export const files = readdirSync('lib');",
    ].join('\n'),
    'fs.promises.readdir': [
      "import { readdir } from 'node:fs/promises';",
      "export const files = await readdir('lib');",
    ].join('\n'),
    'fs.opendirSync': [
      "import { opendirSync } from 'node:fs';",
      "export const dir = opendirSync('lib');",
    ].join('\n'),
    'fs.globSync': [
      "import { globSync } from 'node:fs';",
      "export const files = globSync('lib/**/*.ts');",
    ].join('\n'),
    tinyglobby: [
      "import { glob } from 'tinyglobby';",
      "export const files = await glob(['lib/**']);",
    ].join('\n'),
    'fast-glob': ["import fg from 'fast-glob';", "export const files = await fg(['lib/**']);"].join(
      '\n',
    ),
    globby: [
      "import { globby } from 'globby';",
      "export const files = await globby(['lib/**']);",
    ].join('\n'),
    'git ls-files': [
      "import { execFileSync } from 'node:child_process';",
      "export const files = execFileSync('git', ['ls-files', 'lib']);",
    ].join('\n'),
    'ts.createSourceFile': [
      "import ts from 'typescript';",
      "export const ast = ts.createSourceFile('a.ts', '', 99);",
    ].join('\n'),
  };

  it('covers every entry point the list declares — the fixture set cannot go stale', () => {
    // If an entry point is added without a fixture, this fails rather than the
    // widening silently shrinking back to the rows somebody remembered.
    expect(Object.keys(SYNTHETIC_SCANNERS).sort()).toEqual(
      FILESYSTEM_ENTRY_POINTS.map((e) => e.id).sort(),
    );
  });

  it.each(FILESYSTEM_ENTRY_POINTS.map((e) => [e.id] as const))(
    'a guard reaching the tree through %s is a CANDIDATE',
    (id) => {
      const moduleFile = 'tests/synthetic/scan.ts';
      const specFile = 'tests/synthetic/guard.test.ts';
      const files = [moduleFile, specFile];
      const read = (f: string) =>
        f === moduleFile
          ? SYNTHETIC_SCANNERS[id]!
          : ["import { files } from './scan';", 'export const n = files.length;'].join('\n');

      expect(entryPointsIn(SYNTHETIC_SCANNERS[id]!)).toContain(id);
      expect(scannerModulesIn(files, read)).toEqual([moduleFile]);
      expect(candidateGuardsIn(files, read)).toEqual([specFile]);
    },
  );

  it('and does NOT fire on a helper that touches no filesystem — the control', () => {
    // Without this the case above passes on a predicate that matches everything,
    // which would put all 82 readdir-touching files in the lane.
    const moduleFile = 'tests/synthetic/pure.ts';
    const specFile = 'tests/synthetic/pure.test.ts';
    const files = [moduleFile, specFile];
    const read = (f: string) =>
      f === moduleFile
        ? "export function classify(text: string) {\n  return text.includes('x');\n}"
        : "import { classify } from './pure';\nexport const ok = classify('x');";

    expect(scannerModulesIn(files, read)).toEqual([]);
    expect(candidateGuardsIn(files, read)).toEqual([]);
  });

  it('a BOUNDED module takes its importers out of the candidate set', () => {
    // The register is what keeps the entry-point predicate from sweeping in
    // twelve API suites behind `v1RouteAudit`. Demonstrated on a real entry:
    // the module holds an entry point AND is excluded, so its importer is not a
    // candidate — which is the whole mechanism, not a side effect.
    const bounded = Object.keys(BOUNDED_SCAN_MODULES)[0]!;
    expect(entryPointsIn(readSource(bounded))).not.toEqual([]);
    expect(SCANNER_MODULES).not.toContain(bounded);

    const specFile = 'tests/synthetic/importer.test.ts';
    const files = [bounded, specFile];
    const read = (f: string) =>
      f === bounded
        ? readSource(bounded)
        : `import { audit } from './${basenameOf(bounded)}';\nexport const n = audit;`;
    expect(candidateGuardsIn(files, read)).toEqual([]);
  });

  it('the real widening is LOAD-BEARING — this tree has a candidate the old predicate missed', () => {
    // The old predicate was `/createSourceFile|SCAN_ROOTS/ && /readdirSync/` over
    // the same modules. Re-derive with it here: the files it does NOT reach are
    // exactly what this card moved, so a future narrowing fails rather than
    // quietly restoring the gap.
    const oldScanners = ALL_TEST_FILES.filter((f) => {
      if (isSpec(f) || isDeclaration(f)) return false;
      const src = readSource(f);
      return /createSourceFile|SCAN_ROOTS/.test(src) && /readdirSync/.test(src);
    });
    const oldNames = oldScanners.map(basenameOf);
    const reachedBefore = new Set(
      ALL_TEST_FILES.filter((f) => {
        if (!isSpec(f)) return false;
        const src = readSource(f);
        return oldNames.some((name) => new RegExp(`from\\s+['"][^'"]*${name}['"]`).test(src));
      }),
    );

    for (const spec of [
      'tests/coverage-gate-globs.test.ts',
      'tests/hosting/abandonedPath.test.ts',
    ]) {
      expect(CANDIDATES, `${spec} is not derived by the widened predicate`).toContain(spec);
      expect(reachedBefore.has(spec), `${spec} was already reachable — the widening is moot`).toBe(
        false,
      );
    }
  });
});
