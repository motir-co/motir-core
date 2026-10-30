// MOTIR-4408 — the DOCS-GUARD lane's MEMBERSHIP, and the predicate that derives
// it, in one module with no filesystem access of its own.
//
// It lives here rather than in `vitest.docs.config.ts` because it has TWO
// readers that must never disagree: that config's `include`, and
// `tests/ci-docs-guards-lane.test.ts`, which re-derives the population from the
// tree and fails if this list has drifted from it. (Exporting it from the config
// itself would also make that config mix named and default exports, which Rollup
// warns about on every run — the reason `structuralGuardLane.ts` is split out
// the same way.)
//
// ⚠️ IT DELIBERATELY TOUCHES NO FILESYSTEM. The derivation below is pure
// functions over a file list and a reader, supplied by the caller. Two things
// depend on that: the synthetic tree in the guard can drive the IDENTICAL code
// the real run uses (a control that re-implements the predicate proves the
// control works, not the predicate), and this module stays outside
// `structuralGuardLane.ts`'s candidate derivation, which keys on a spec
// importing a module that reaches the whole tree.
//
// ── The defect this lane closes ─────────────────────────────────────────────
// `ci.yml`'s `What changed` classifier reads a pull request whose only changed
// files are under `docs/**` as `app=false`, and the sharded Vitest job is gated
// on that boolean. THE CLASSIFICATION IS CORRECT and this lane does not touch
// it: prose about the application has no app code to exercise, and making the
// most common cheap diff in the repository pay for twelve Vitest legs, their
// Postgres and a coverage merge would be a real cost for nothing.
//
// The defect is on the other side. A guard whose SUBJECT is a `docs/**` file
// lives in the lane that a `docs/**` diff switches off — so it runs on every
// pull request except the ones that can break it. Delete a row from a
// classification table and `CI complete` passes having run none of it.
//
// ── Why a lane and not a longer `include` somewhere ─────────────────────────
// This is the THIRD instance of one mechanism. MOTIR-2441 / MOTIR-2442 gave the
// design-asset guards an unconditional lane after `main` went red from a
// `design/*` pull request that had merged green. MOTIR-3806 added a
// `content/*) app=true ;;` arm after a legal-document revision passed through
// two mechanisms in silence. Each fix was correct and each was local, so the
// mechanism underneath survived to produce the next one.
//
// Neither prior remedy transfers. The classifier is RIGHT about `docs/`, so
// MOTIR-3806's fix does not apply; and these specs are not design assets, so
// MOTIR-2442's lane does not hold them. What transfers is the SHAPE of
// MOTIR-2442's remedy — an unconditional lane for the specs a given diff class
// switches off — which is what this file is.
//
// ⚠️ AND THE MEMBERSHIP IS DERIVED, NOT LISTED, because a list of this class is
// wrong twice over — and MOTIR-4408's own enumeration of three specs is the
// worked example of both halves.
//
//   • DRIFT. `tests/theme/immersiveShellChrome.test.ts` merged at 10:10 and
//     `tests/mcp/mcp-doc-guards.test.ts` at 13:11 on the day the card was filed
//     at 02:23, each written by a run that had never read it. Thirteen hours
//     added two members to a list of three.
//   • AND THE COUNT WAS ALREADY WRONG WHEN IT WAS TAKEN, which is the half a
//     re-measurement on a fresher ref cannot find. The card enumerated with
//     `grep -rlE "['\"]docs/" tests/`, which finds a QUOTED `docs/` substring —
//     and the segmented form `join(ROOT, 'docs', 'decisions', …)` carries no
//     such substring anywhere. Three specs predating the card by four weeks were
//     invisible to it: `tests/permissions/catalog.test.ts` and
//     `tests/permissions/inventoryCoverage.test.ts` (both 2026-08-06), each
//     opening `docs/decisions/permission-inventory.md`, and
//     `tests/reader-facing-noun.test.ts` (2026-08-10), which walks `docs/*.md`
//     wholesale. The command was scoped by how the defect was NOTICED rather
//     than by what the claim was ABOUT, and its answer was right for the
//     question it asked. `tests/permissions/noUngovernedOperation.test.ts` uses
//     the same segmented form and was caught only because one of its assertion
//     messages happens to quote the path.
//
// Derived on this tree the population is EIGHT — the seven listed above plus
// `tests/reader-facing-noun.test.ts`, which another unconditional lane already
// holds (see CARRIED_BY_ANOTHER_LANE below). A check that enumerates instances
// is the same shape as the class it guards.

/**
 * The lane's membership — every spec that reads a `docs/**` file as its subject.
 *
 * ⚠️ THIS LANE **ADDS** A RUN; it does not MOVE one. That is the distinction
 * `tests/helpers/structuralGuardLane.ts`'s header draws between the two existing
 * lanes, and this one sits on the `vitest.design.config.ts` side of it: these
 * specs stay in the root `vitest.config.ts` too, because the purpose here is to
 * reach a DIFF CLASS the root job skips, not to take these files out of the
 * sharded run on cost grounds. So `vitest.config.ts` is untouched by this card —
 * excluding them there would delete coverage on every ordinary pull request in
 * order to add it on documentation-only ones.
 */
export const DOCS_GUARD_SPECS = [
  // ── tests/jobs/ — the catch-up disposition against ADR §11.4 ──────────────
  // SPLIT OUT of `tests/jobs/engine-units.test.ts` by MOTIR-4408. That file
  // imports `@/lib/db`, `../helpers/adminDb` and the truncation helpers, and its
  // file-scoped `beforeEach` / `afterEach` / `afterAll` open a database for
  // every test in it — so the file cannot come here and only the one assertion
  // whose subject is the record does. Its two siblings in that describe block
  // stay behind: one is a `@ts-expect-error` compile-level check and the other
  // walks the registry alone, so a `docs/**` diff can falsify neither.
  'tests/jobs/catch-up-disposition-adr.test.ts',
  // ── tests/mcp/ — the MCP documentation's own truth gate ───────────────────
  // Reads `docs/mcp.md` and holds its stated tool count, its endpoint path and
  // its transport facts against the registry. Added to the tree at 13:11 on the
  // day MOTIR-4408 was filed (MOTIR-4269, #2609) — eleven hours after the card
  // enumerated three specs, which is the drift half of the derivation's case.
  'tests/mcp/mcp-doc-guards.test.ts',
  // ── tests/mcp/ — the code-read tools' text homes (MOTIR-7865) ─────────────
  // Reads `docs/mcp.md` and `docs/decisions/member-facing-permissions.md` and
  // fails when either stops naming `read_file`, `code_explore`, `code_search`
  // or `code_grep`. Imports nothing from `lib/`.
  'tests/mcp/code-read-tool-docs.test.ts',
  // ── tests/permissions/ — the inventory, from THREE sides ──────────────────
  // All three open `docs/decisions/permission-inventory.md`, which maps every
  // user-initiated operation to the permission that governs it. `catalog`
  // checks the catalogue against the document, `inventoryCoverage` checks that
  // every `app/api/**/route.ts` appears in it, and `noUngovernedOperation`
  // refuses an operation the document does not decide.
  //
  // ⚠️ The first two are the ones MOTIR-4408's own command could not see. They
  // build the path in SEGMENTS — `join(ROOT, 'docs', 'decisions', …)` — which
  // carries no `docs/` substring, and both predate the card by four weeks. It
  // is why the predicate below matches a `'docs'` path segment as well as a
  // `'docs/…'` literal, and why the segment form is a listed carrier with its
  // own reason rather than a regex alternation nobody would notice going away.
  'tests/permissions/catalog.test.ts',
  'tests/permissions/inventoryCoverage.test.ts',
  'tests/permissions/noUngovernedOperation.test.ts',
  // ── tests/theme/ — the §4b surface ladder (MOTIR-4406) ────────────────────
  // The card this defect was found in. It reads `docs/styles/3d-immersive.md`
  // §4b as its CLASSIFICATION source and fails on any surface class the ladder
  // leaves unclassified — a guard whose entire subject is a document.
  'tests/theme/immersive-surface-ladder.test.ts',
  // ── tests/theme/ — the shell chrome against the same ladder ───────────────
  // Reads the same `docs/styles/3d-immersive.md`, for the §4 plane row rather
  // than §4b. Merged at 10:10 on the day the card was filed (MOTIR-4253,
  // #2606), so it was not in the tree the card measured.
  'tests/theme/immersiveShellChrome.test.ts',
] as const;

/**
 * How a spec names a path into `docs/`. Both forms are LIVE in this tree and
 * neither subsumes the other, which is the whole reason this is a list.
 */
export const DOCS_PATH_FORMS = [
  {
    id: 'docs/ path literal',
    pattern: /['"]docs\/[^'"\s]*\.[A-Za-z0-9]+['"]/,
    why: "a whole relative path in one quoted string — `readFileSync('docs/decisions/job-queue-foundation.md')`, or a `const X_PATH = 'docs/styles/3d-immersive.md'` the spec then joins onto a repository root. A FILE EXTENSION and no whitespace are required, because `docs/` also opens prose: `tests/design-asset-addresses.test.ts` carries \"docs/text (`msword`, docx, …)\" inside an explanatory field and opens no document at all.",
  },
  {
    id: 'docs path segment',
    pattern: /(?:join|resolve)\(\s*[A-Za-z_$][\w$.]*\s*,\s*['"]docs['"]/,
    why: "the path composed a segment at a time off a root VARIABLE — `join(ROOT, 'docs', 'decisions', 'permission-inventory.md')`. It carries no `docs/` substring anywhere, which is exactly what MOTIR-4408's own enumerating command could not see. The root must be an identifier rather than a quoted segment, because `join('app', 'api', 'docs', …)` builds a path into the APPLICATION's route tree and reads no document.",
  },
] as const;

/**
 * How a spec READS a file off disk. The second half of the conjunction, and the
 * half that keeps the predicate from sweeping in every spec that merely MENTIONS
 * a document — `tests/jobs/fast-lane-latency-budget.test.ts` cites
 * `docs/decisions/job-lane-occupancy.md` §6 in three assertion messages and
 * opens nothing; `tests/workItems/proseVsGraph.test.ts` feeds `docs/…` paths to
 * a path classifier as fixture strings. Both name the tree and read none of it,
 * and a `docs/**` diff cannot break either.
 *
 * Matched as bare identifiers rather than as call sites, so an aliased import
 * (`import { readFile as read } from 'node:fs/promises'`) still counts — that
 * alias is live in `immersiveShellChrome.test.ts`.
 */
export const FILE_READ_FORMS = [
  {
    id: 'fs.readFileSync',
    pattern: /\breadFileSync\b/,
    why: "node:fs's synchronous single-file read — what every guard in this lane opens its document with today, and the primitive a new one will reach for first.",
  },
  {
    id: 'fs.readFile',
    pattern: /\breadFile\b/,
    why: 'the same read awaited or called back rather than blocking, from `node:fs/promises` or `node:fs`. Live: `immersiveShellChrome.test.ts` imports it aliased, which is why these patterns match the identifier and not a call.',
  },
  {
    id: 'fs.createReadStream',
    pattern: /\bcreateReadStream\b/,
    why: 'the streaming form of the same read. Named now rather than after the first guard that reaches for it — the point of a form list is that it does not wait for an instance. Not live in this tree.',
  },
  {
    id: 'fs.openSync',
    pattern: /\bopenSync\b/,
    why: 'the descriptor form, the one a spec reaches for to read a fixed slice of a large file rather than the whole of it. Also not live in this tree, and named for the same reason.',
  },
] as const;

/** Forms that are named ahead of any instance, so the liveness check exempts them. */
export const FORWARD_LOOKING_FORMS: readonly string[] = ['fs.createReadStream', 'fs.openSync'];

/** Which `docs/` path forms `source` uses. */
export function docsPathFormsIn(source: string): string[] {
  return DOCS_PATH_FORMS.filter((f) => f.pattern.test(source)).map((f) => f.id);
}

/** Which file-read forms `source` uses. */
export function fileReadFormsIn(source: string): string[] {
  return FILE_READ_FORMS.filter((f) => f.pattern.test(source)).map((f) => f.id);
}

const isSpec = (file: string) => /\.test\.tsx?$/.test(file);

/**
 * The derivation: every SPEC in `files` that reads a `docs/**` file as its
 * subject — it names a path into `docs/` AND it reads a file off disk.
 *
 * `read` must return the source with COMMENTS STRIPPED. Comments are where a
 * guard explains which document it is about, so an un-stripped source makes the
 * predicate match the prose of specs that open nothing —
 * `tests/jobs/engine-units.test.ts` still carries the ADR's name in the header
 * of the describe block this card split, and must not be a candidate for it.
 */
export function docsReadingSpecsIn(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  return files.filter((file) => {
    if (!isSpec(file)) return false;
    const source = read(file);
    return docsPathFormsIn(source).length > 0 && fileReadFormsIn(source).length > 0;
  });
}

/**
 * Specs the derivation matches that deliberately do NOT belong in the lane, each
 * with its reason. It exists so that excluding one is a written decision rather
 * than a silent omission, and the guard holds every row to being a real file
 * that really does match.
 */
export const DELIBERATELY_OUT: Readonly<Record<string, string>> = {
  'tests/api/approval-gate-route.test.ts':
    'a FIXTURE path, not a read (MOTIR-4907). Its `docs/decisions/page-body.md` is the ' +
    "decision document named by a stubbed read's DTO, so the overlay route's decision " +
    'arm can be asserted without a host; the spec opens no file at all.',
  'tests/github/decisionPortBoundary.test.ts':
    'FIXTURE paths, not reads (MOTIR-4907). Its `docs/decisions/page-body.md` is the ' +
    'decision document a mapper test names in a DTO; the files it opens are the ' +
    "port's own source modules under `components/` and `lib/`, read to assert they " +
    'import no service. No documentation edit can change its verdict.',
  'tests/github/decisionStoryGate.test.ts':
    'the same shape (MOTIR-4907). `docs/decisions/page-model.md` is a stubbed pull ' +
    "request's file LIST entry, never opened; the only files it reads are the " +
    "story's `prisma/migrations/**/migration.sql`, to assert they create no table.",
  'tests/ci-acceptance-lane.test.ts':
    'a FIXTURE path, not a read. Its `docs/acceptance-tests.yml` sits in a ' +
    "table row labelled `why: 'a docs lookalike'`, fed to the acceptance " +
    "lane's own path classifier to prove that a file merely NAMED like the " +
    'workflow does not select the lane. Every file it opens is under ' +
    '`.github/workflows/` or a temp directory it writes itself.',
  'tests/ci-changed-paths-gate.test.ts':
    'the same shape one job over. `docs/decisions/x.md` is the stand-in path ' +
    'it feeds to the `changes` classifier to assert that a documentation-only ' +
    'diff sets `app=false` — the very classification MOTIR-4408 leaves in ' +
    'place. It reads `.github/workflows/ci.yml` and nothing under `docs/`, so ' +
    'no documentation edit can change its verdict.',
};

/**
 * Specs that read a `docs/**` file and are ALREADY carried by another
 * unconditional lane, so this one would only buy a second run of them.
 *
 * ⚠️ THIS IS NOT AN EXEMPTION AND MUST NOT BE READ AS ONE. The rule the guard
 * enforces is *a spec that reads a `docs/**` file as its subject runs in an
 * UNCONDITIONAL lane* — not *…runs in THIS lane*. A row here is a claim that
 * some other unconditional lane already holds the file, and the guard CHECKS
 * that claim against that lane's own membership rather than taking it on trust:
 * a row naming a file no lane holds fails exactly as a missing entry does.
 */
export const CARRIED_BY_ANOTHER_LANE: Readonly<Record<string, string>> = {
  'tests/ci-docs-guards-lane.test.ts':
    'the lane guard itself, held by the STRUCTURAL-GUARD lane ' +
    '(`vitest.guards.config.ts`, MOTIR-3144), whose derivation named it on the ' +
    'pull request that added it. It matches the predicate here because its ' +
    'synthetic fixtures are `docs/…` path strings handed to the predicate by ' +
    'hand — but every file it opens is under `tests/`, `.github/` or the ' +
    'repository root, so no documentation edit can change its verdict. What it ' +
    'needs is an unconditional lane, and it has one.',
  'tests/reader-facing-noun.test.ts':
    'held by the DESIGN lane (`vitest.design.config.ts`, MOTIR-2442 / ' +
    'MOTIR-2540). It walks `docs/*.md` wholesale as one of its scan roots, so ' +
    'it is a genuine docs reader — and it is there because it also opens ' +
    '`design/settings/design-notes.md` to prove its own exclusion of the ' +
    'design tree is load-bearing. Both lanes run on every diff shape, so the ' +
    'guard it needs is already the guard it has.',
};
