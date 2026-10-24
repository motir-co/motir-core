// MOTIR-3144 — the structural-guard lane's MEMBERSHIP, in one module.
//
// It lives here rather than in `vitest.guards.config.ts` because it has THREE
// readers that must never disagree: that config's `include`, the root
// `vitest.config.ts`'s `exclude`, and `tests/ci-structural-guards-lane.test.ts`,
// which re-derives the candidates from the tree and fails if this list has
// drifted from them. (Exporting it from the config itself also made that config
// mix named and default exports, which Rollup warns about on every run.)

/**
 * The lane's membership, exported because it has TWO readers that must never
 * disagree: this config's `include`, and `vitest.config.ts`'s `exclude` — the
 * root run has to drop exactly what this one picks up. A guard listed in one
 * and not the other either runs twice (in the contended job this card exists to
 * leave) or not at all, and both failures are silent.
 *
 * ⚠️ This differs from `vitest.design.config.ts` in the one way that matters.
 * That lane ADDS a run: its specs stay in the root config too, because its
 * purpose is to reach branch prefixes the root job skips. This lane MOVES the
 * run — the whole point is that these files stop executing inside the sharded
 * database job — so the root config excludes every entry below.
 */
export const STRUCTURAL_GUARD_SPECS = [
  // ── tests/rls/ — the binding, transaction and singleton guards ─────────────
  'tests/rls/call-site-guard.test.ts',
  // ── tests/visitor/ — the Visitor write-door guard (MOTIR-6650) ────────────
  // Parses every mutating route handler under `app/api/` and every
  // `'use server'` file under `app/` + `lib/` + `components/` through the
  // compiler API and asserts none reaches a Visitor entrance. Its own
  // `readdirSync`, no database, nothing imported from `lib/` or `app/`.
  'tests/visitor/visitorWriteDoorGuard.test.ts',
  'tests/visitor/visitorReaderRoutesGuard.test.ts',
  'tests/rls/bare-transaction-guard.test.ts',
  'tests/rls/ratchet-staleness-guard.test.ts',
  'tests/rls/singleton-read-guard.test.ts',
  'tests/rls/test-call-site-guard.test.ts',
  'tests/rls/test-singleton-statement-guard.test.ts',
  // ── tests/rateLimit/ — the one-counter and store-deadline guards ───────────
  // ⚠️ `storeDeadline` had to be UNPICKED before it could come here, and the
  // detail is worth keeping because a grep says the opposite twice over. Its
  // file body is full of `@/lib/rateLimit/store` strings that are FIXTURES in
  // template literals — source it feeds to its own scanner — so a grep for
  // imports finds matches that are not imports. But its one REAL import,
  // `TEST_RATE_LIMIT_STORE_TIMEOUT_MS` from `tests/helpers/rateLimitStore.ts`,
  // reached `@/lib/db` transitively and threw `DATABASE_URL is not set` at
  // import time — a filesystem scanner that could not run without Postgres,
  // purely to read `10_000`. The constant now lives alone in
  // `tests/helpers/rateLimitStoreDeadline.ts`, which imports nothing.
  'tests/rateLimit/one-counter-guard.test.ts',
  'tests/rateLimit/storeDeadline.test.ts',
  // ── tests/theme/ — the ink-contrast lint, found by the predicate ───────────
  // NOT on the card's list of ten, and that is the point of deriving membership
  // mechanically instead of copying an enumeration: `inkContrastLint` walks
  // `app/` + `components/` + `lib/` through the same shared scanner shape and
  // has exactly the same cost profile. `inkContrastScan` comes with it — it
  // exercises that scanner against a fixture tree, so it is the test that would
  // catch a memoisation cache keyed on nothing handing the fixture the real
  // repository's answer (the vacuous-pass trap MOTIR-2815 hit).
  'tests/theme/inkContrastLint.test.ts',
  'tests/theme/inkContrastScan.test.ts',
  // ── tests/theme/ — the ink arm's ABSTENTION, enumerated (MOTIR-4251) ──────
  // The population guard behind the render-time ink sweep. It runs the muted
  // arm's own predicates over the same `git ls-files` set the lint scans and
  // records the sites the arm walks PAST, so a coverage claim about "the
  // composed surfaces" has a number behind it. Identical cost profile to the two
  // entries above — one whole-tree parse, no database, no `--coverage` — and it
  // shares their memoisation-free shape, so it belongs in the same lane rather
  // than in the sharded job where it would be sized against a database budget.
  'tests/theme/composedSurfaceInkCoverage.test.ts',
  // ── tests/theme/ — the `Modal.Body`-bypass guard (MOTIR-2491) ─────────────
  // Parses every `.tsx` under `app/`, `components/` and the design system's
  // `src/` through the compiler API and classifies each `<Modal>` call site by
  // SHAPE: a bare one may hold only what a short confirm holds. Same cost
  // profile as the ink guards — one whole-tree parse, no database, nothing
  // rendered — and it imports nothing from `lib/` or `app/`.
  'tests/theme/modalScrollContainer.test.ts',
  // ── tests/guards/ — the follow-and-typewriter mount pins (MOTIR-8596) ─────
  // Its own `readdirSync` over `app/` and `components/`, text-matching the JSX
  // sites that may pass `followMode` / `typeIn` / render `TypeInText`. No
  // database, nothing imported from `lib/` or `app/`.
  'tests/guards/follow-and-typewriter-mounts.test.ts',
  // ── tests/ — the coverage gate's own guard (MOTIR-3497) ───────────────────
  // The instance the IMPORT-shaped membership predicate could not see. It pays
  // one memoised `tinyglobby` resolution of the whole `coverage.include` set —
  // 483 files, ~0.8 s on a quiet box — and it globs rather than parsing, so a
  // predicate keyed on the TypeScript compiler API found nothing to match. It
  // then timed out on `Vitest (1/3)` three times in four days (2026-08-23
  // #2259, 2026-08-25 #2282, 2026-08-26 #2297), each time at the 15 s
  // `testTimeout` with zero assertion failures, on diffs that touched no path
  // `coverage.include` reaches. Its cost profile is the lane's: no database, no
  // `--coverage`, one whole-tree filesystem answer.
  'tests/coverage-gate-globs.test.ts',
  // ── tests/ — the lane's OWN membership guard (MOTIR-3497's sweep) ─────────
  // The fourth instance, and the one that reads worst in hindsight: the guard
  // written to keep whole-tree guards out of the sharded run was itself a
  // whole-tree guard in the sharded run. It walks all 1 572 files under `tests/`
  // and reads every one of them — 20.3 MB, ~0.4 s on a quiet box. It has not
  // flaked yet; at the contention multiplier its own header quotes it does not
  // need to have.
  'tests/ci-structural-guards-lane.test.ts',
  // ── tests/work-items/ — the status-write guard (MOTIR-4780) ───────────────
  // `work_item.completedAt` is stamped in ONE place, so the guard's question is
  // a POPULATION one: which sites in `lib/` + `app/` write `work_item.status`,
  // and has a human ruled on each? It walks the same two roots as
  // `bareTransactionScan` through the same compiler API, opens no database and
  // imports nothing from `lib/` or `app/` — the lane's shape exactly.
  'tests/work-items/status-write-guard.test.ts',
  // MOTIR-5420 — every folder error mapped on both agent-facing doors, and no
  // folder field on a list row: read from four named source files as data.
  'tests/folders/folder-surface-guard.test.ts',
  // ── tests/workbench/ — the status-KEY-literal guard (MOTIR-4784) ──────────
  // The write guard's twin, on the READ side. The Workbench partitions on
  // `workflow_status.CATEGORY`, and a predicate written against a status KEY is
  // correct on our own project — whose statuses happen to carry the default
  // names — and silently wrong for the first customer who renames a column.
  // `statusLiteralScan.ts` walks a NAMED surface rather than two whole roots,
  // which is the one way it differs from its siblings here; everything else is
  // the lane's shape — the compiler API, no database, nothing imported from
  // `lib/` or `app/`.
  'tests/workbench/status-literal-guard.test.ts',
  // ── tests/hosting/ — the abandoned-platform guard (MOTIR-3497's sweep) ─────
  // Found by the WIDENED predicate, and it had been sitting one character away
  // from being derived the whole time: `abandonedPathGuard.ts` exports
  // `SCANNED_ROOTS`, not `SCAN_ROOTS`, so the old regex missed it. It walks
  // `app/` + `lib/` and comment-strips every file — the same shape and the same
  // roots as `bareTransactionScan`, which has been in the lane since MOTIR-3144.
  'tests/hosting/abandonedPath.test.ts',
  // ── tests/helpers/ — the import-graph reader's own guard (same sweep) ──────
  // A SELF-walking member: it does its own `readdirSync` over `['app', 'lib',
  // 'components']` rather than importing a scanner, so nothing derives it (the
  // same half `SELF_WALKING_MEMBERS` in the membership test covers). Listed here
  // and asserted there.
  'tests/helpers/importGraph.test.ts',
  // ── tests/theme/ — the shell viewport-unit guard (MOTIR-3208) ─────────────
  // Same shape again: a text walk of `app/` + `components/` + the design
  // system's `src/`, plus two stylesheets, asserting that every viewport-sized
  // length on the shell path is written in `dvh`. It opens no database, renders
  // nothing, and imports nothing from `lib/` or `app/`, so it carries no
  // coverage out of the merged report.
  'tests/theme/shellViewportUnits.test.ts',
  // ── tests/theme/ — the named `max-w-*` guard (MOTIR-4084) ─────────────────
  // The same shape as `shellViewportUnits` two entries up, and for a defect of
  // the same family: a Tailwind utility whose name says one thing and whose
  // emitted value says another, because a `@theme` namespace shadows the scale
  // the class is named after. It walks `app/` + `components/` + the design
  // system's `src/` and reads every file with comments stripped. It opens no
  // database, renders nothing, and imports only `tests/helpers/importGraph`, so
  // it carries no coverage into the merged report.
  'tests/theme/namedMaxWidthUtilities.test.ts',
  // ── tests/theme/ — the shell-canvas guard (MOTIR-4230) ───────────────────
  // The third of this shape in a row, and it walks the same three roots as its
  // two neighbours for the same reason: the shell roots are DERIVED from the
  // tree (a class literal stating `h-dvh` + `overflow-hidden`) rather than
  // listed, so a third shell joins the guard without anyone remembering to.
  // It opens no database, renders nothing, and imports only `node:fs` /
  // `node:path`, so it carries no coverage into the merged report.
  'tests/theme/immersiveShellAtmosphere.test.ts',
  // ── tests/prisma/ — the Prisma TYPE BOUNDARY (MOTIR-4296) ────────────────
  // The same shape as the three `tests/theme/` entries above, one layer over: a
  // comment-stripped text walk of `lib/` + `app/` + `components/` asserting that
  // the generated client's payload and input generics are named only under
  // `lib/repositories/**`. It opens no database, renders nothing, and imports
  // only `node:fs` / `node:path`, so it carries no coverage into the merged
  // report — and its cost is a function of the tree rather than of what else
  // happens to be running, which is what this lane is for.
  'tests/prisma/typeBoundary.test.ts',
  // ── tests/jobs/ — the memoized-step RESULT SHAPE guard (MOTIR-5022) ────────
  // The lane's shape with one difference worth naming: it builds a TYPE-CHECKED
  // program rather than parsing, because the thing it pins is a step result's
  // resolved type and `checker.typeToString` on an alias prints the alias. It
  // reads the same `lib/` + `app/` roots through the same compiler API, opens no
  // database, renders nothing and imports nothing from `lib/` or `app/`, so it
  // carries no coverage into the merged report.
  //
  // ⚠️ AND IT NEEDS NO `prisma generate`, which is what makes it belong HERE
  // rather than in the sharded job. Verified rather than assumed on MOTIR-5022:
  // all 65 pinned shapes are byte-identical with `generated/prisma` present and
  // with it moved aside, because a step result is a DTO or a service summary and
  // none of them names a Prisma type. The guard's own `any`/`unknown` assertion
  // is the standing check on that — a shape that degraded because a module
  // stopped resolving would otherwise pin a fingerprint that can never move.
  'tests/jobs/step-result-shape-guard.test.ts',
  // ── tests/packages/ — the package IMPORT-DIRECTION guard (MOTIR-4299) ─────
  // The same shape once more, over one more root: it walks every
  // `packages/<name>/src` tree it discovers plus `lib/` + `app/` +
  // `components/`, comment-stripped, asserting that no package imports the app
  // and nothing reaches past a package barrel. No database, no render, and it
  // imports only `node:fs` / `node:path`.
  'tests/packages/importDirection.test.ts',
  // MOTIR-8887 — a whole-tree import scan (`readdirSync` over six roots) that timed out at
  // 60 s inside the sharded, coverage-instrumented job with zero assertion failures.
  'tests/passkeyBoundaryContract.test.ts',
  // ── tests/ciFleet/ — the fleet PORT BOUNDARY (MOTIR-4299) ─────────────────
  // ⚠️ IT WAS ALREADY A WHOLE-TREE SCANNER AND WAS ALREADY IN THE SHARDED JOB,
  // and the reason it moves NOW is that MOTIR-4299 made it bigger: the fly
  // adapter left `lib/` for `packages/orchestrator/src`, so the guard gained a
  // fourth scanned root and reads more of the tree than it did. It walks `lib`,
  // `app`, `components` and the package's `src`, comment-strips every file and
  // tests seven patterns against every line — the same cost profile as the three
  // `tests/theme/` entries above, with no database and no coverage to carry.
  // Found by the census in `tests/typecheck-program/guards-bite.test.ts`, which
  // asked the question nobody had: is each of this story's guards in a lane where
  // its cost is a function of the tree rather than of what else is running?
  'tests/ciFleet/orchestratorPortBoundary.test.ts',
  // ── tests/ciFleet/ — the ORG-IDENTITY guard (MOTIR-8716) ──────────────────
  // The same shape as the port boundary above: it lists `lib/` + `app/` with
  // `git ls-files`, comment-strips every code file and tests a handful of
  // patterns against every line. No database, no render, no coverage to carry.
  'tests/ciFleet/fleetNoOrgIdentityBranch.test.ts',
  // ── tests/ciFleet/ — the AWS SDK boundary (MOTIR-9280) ────────────────────
  // The same shape again: its own walk over the package's `src`, `lib` and
  // `app`, comment-stripped, two patterns per file. No database.
  'tests/ciFleet/awsSdkBoundary.test.ts',
  // ── tests/typecheck-program/ — the story's guard CENSUS (MOTIR-4300) ──────
  // ⚠️ IT IS HERE BY DERIVATION, NOT BY COST, and that is worth saying because
  // the file itself reads five named files and takes ~10 ms. It imports THIS
  // MODULE — the lane's membership list — and the candidate predicate keys on a
  // spec importing a module whose TEXT carries a filesystem entry point. This
  // file's prose is full of the word `readdirSync`, so anything importing it is
  // a candidate by construction. `tests/ci-structural-guards-lane.test.ts` has
  // the same property and has always been in the lane, which is why nobody had
  // met it. Listing it is cheaper than teaching a text predicate to read
  // comments, and it costs the lane nothing.
  'tests/typecheck-program/guards-bite.test.ts',
  // ── tests/legal/ — the EGRESS-MANIFEST guard (MOTIR-3631 · MOTIR-4008) ────
  // Same shape once more: a text walk of `lib/` + `app/` for outbound hosts,
  // read against `package.json` and `lib/legal/egressManifest.ts`.
  //
  // ⚠️ ITS SUBJECT CHANGED AND ITS PROFILE DID NOT. It used to read the two
  // published pages; those left for `motir-marketing` with the documents
  // (MOTIR-3909), and the EVIDENCE could not follow them — measured there it
  // would pass forever. So the guard holds this tree against the committed
  // manifest this application serves, and `motir-marketing` holds its page
  // against that manifest (`docs/decisions/public-surface-hosts.md`
  // AMENDMENT 2 §E). It still reads ~1 650 files, which is precisely the
  // profile this lane exists to keep out of the sharded database job — and it
  // still opens no database, renders nothing, and imports only a data module
  // from `lib/`, so it carries no meaningful coverage into the merged report.
  'tests/legal/egress-manifest-guard.test.ts',
  // ── tests/monitors/ — the monitor-INGESTION guards (MOTIR-4929 · MOTIR-5583) ─
  // Text walks of `lib/` + `app/` + `scripts/` (one production caller of
  // `listIssuesSince`) and of the ingestion service (placement from one place).
  // No database, no render, only `node:fs` / `node:path`.
  'tests/monitors/monitorIngestionGuards.test.ts',
  // ── the bug-ENRICHMENT guards (MOTIR-4930 · MOTIR-5852) ─────────────────────
  // Text scans of the enrichment service, its job and the answer parser (no
  // transition / re-parent / link, write only via updateWorkItem, post-commit),
  // plus a hash pin on `monitorBugBody`. Only `node:fs` / `node:path` / `node:crypto`.
  'tests/monitors/monitorEnrichmentGuards.test.ts',
  // ── tests/legal/ — the content/legal ABSENCE guard (MOTIR-4104) ──────────
  // The same shape as its neighbour above and as `abandonedPath` further up: it
  // walks `app/` + `lib/` + `components/` through `contentLegalReaderGuard.ts`,
  // comment-stripping every file, and asks whether anything still reaches the
  // document source MOTIR-4103 deleted. It also asks git for `content/`'s
  // population, which is a second whole-tree entry point in the same file.
  //
  // It opens no database, renders nothing, and imports only
  // `tests/helpers/importGraph`, so it carries no coverage into the merged
  // report. Its scanner module is not listed here for the same reason
  // `abandonedPathGuard.ts` is not: the lane runs SPECS, and the scanner reaches
  // the tree only through this one.
  'tests/legal/contentLegalReader.test.ts',
  // ── tests/legal/ — the `legal.*` CATALOGUE SPLIT guard (MOTIR-4104) ──────
  // Same profile as the entry above, through `legalCatalogueGuard.ts`: it walks
  // `app/` + `components/` (reusing that guard's tree walker), comment-strips
  // every file and extracts the message keys each namespace binding reads, then
  // sets that population against `messages/en.json`. It opens no database,
  // renders nothing, and imports only `tests/helpers/importGraph` and its
  // sibling scanner, so it carries no coverage into the merged report.
  'tests/legal/legalCatalogueSplit.test.ts',
  // ── the 2FA-enforcement guards (Story MOTIR-1215 · MOTIR-3649) ────────────
  // Four at once, and they were DERIVED rather than remembered — which is the
  // whole argument for a mechanical membership predicate. Each walks the tree
  // (`app/`, `app/api/`, `lib/`) through the shared sweeps in
  // `tests/helpers/twoFactorGuardSweeps.ts`, so extracting those sweeps is what
  // made them visible to this list at all: before MOTIR-3649 each guard walked
  // `process.cwd()` inline, and nothing derived it.
  //
  // Their cost profile is the lane's exactly — no database, no render, one
  // whole-tree filesystem answer — and `two-factor-api-gate` is the heaviest of
  // the four, reading every file under `app/api/**` (199 authenticating ones)
  // with comments stripped. `proxy-matcher` also drives `proxy()` itself, which
  // needs `next/server` and nothing else.
  //
  // ⚠️ `twoFactorHasSecondFactor` carries the predicate's EQUIVALENCE tests
  // beside its one-implementation walk. Those are pure input-space maths over
  // `hasSecondFactor` × `toTwoFactorStatusDTO`, so they move happily with it —
  // but note that means this lane, not the sharded run, is where the story's
  // central predicate is asserted.
  'tests/api/two-factor-api-gate.test.ts',
  'tests/navigation/two-factor-gate-coverage.test.ts',
  'tests/navigation/proxy-matcher.test.ts',
  //
  // ⚠️ `twoFactorPredicateOneImplementation` was SPLIT OUT of
  // `tests/twoFactorHasSecondFactor.test.ts` to get here. That file also holds
  // the predicate's EQUIVALENCE tests, which import the real `hasSecondFactor`
  // and the real mapper — and the lane's purity rule refuses a member reaching
  // `@/lib`, because a member must carry no coverage into the merged report. One
  // file could satisfy the whole-tree rule or the purity rule, never both, so
  // the walk moved and the equivalence tests stayed in the sharded run.
  'tests/twoFactorPredicateOneImplementation.test.ts',
  // ── tests/jobs/ — the vendor-retirement guard (MOTIR-3418) ────────────────
  // Same profile as `abandonedPath` one entry up: it asks a WHOLE-TREE question
  // (does any tracked file still import the retired job runtime, does any shipped
  // path still read one of its environment variables) and answers it with
  // `git ls-files` / `git grep`, which is a REF-based read rather than a walk of
  // a working tree somebody is mid-edit in. It opens no database and imports
  // nothing from `lib/` or `app/`, so it carries no coverage into the merged
  // report.
  'tests/jobs/inngest-retired.test.ts',
  // ── tests/seo/ — the robots signed-in coverage guard (MOTIR-3726/3946) ────
  // It walks `app/(authed)`, `app/(onboarding)` and `app/(planning)` through
  // `topLevelSegments`, recursing into every nested route group and asking each
  // directory whether it serves a page — the same sweep the four 2FA guards use,
  // and the same cost profile. It was found by THIS FILE'S OWN membership test
  // on the pull request that added it, which is the mechanism working: the guard
  // shipped in the sharded run and was named here before it could time out on
  // somebody else's branch.
  //
  // ⚠️ It reads `lib/robotsPolicy.ts` as SOURCE rather than importing it, for
  // the lane's purity rule below — which is also why it is a file of its own:
  // the rest of `tests/seo/robots.test.ts` tests the policy by calling it, and
  // belongs where its coverage is counted.
  'tests/seo/robots-signed-in-coverage.test.ts',
  // ── the Vitest leg plan's guard (MOTIR-3912) ──────────────────────────────
  // Here for a reason none of the entries above share, and the strongest reason
  // on the list: it guards the SPLIT of the sharded suite. Left in that suite it
  // would be a guard the plan under test gets to place — on whichever leg the
  // bin-packer picks, or, in the failure it exists to catch, on no leg at all. A
  // check that its own subject can switch off is not a check. It also fits the
  // lane on the ordinary grounds: it asks a whole-tree question (glob every test
  // file, compare against the plan's assignment), opens no database, and imports
  // nothing from `lib/` or `app/`, so it carries no coverage into the merged
  // report.
  'tests/vitest-shard-plan.test.ts',
  // ── tests/ — the per-round database-reset budget guard (MOTIR-4089) ───────
  // Same profile as its neighbours: it walks all of `tests/` and reads every
  // file in it, asking which tests reset the database inside a loop while riding
  // `vitest.config.ts`'s 15 s default. It opens no database and imports only
  // `tests/helpers/timeoutBudget`, which imports nothing at all, so it carries
  // no coverage into the merged report.
  //
  // ⚠️ It is here for the second reason `vitest-shard-plan` is, and the stronger
  // one: it guards a property OF THE SHARDED RUN. Left inside that run it would
  // be a check its own subject can starve — the shape it exists to catch is a
  // shard going 2.4–2.9x over its siblings, which is exactly the condition under
  // which a whole-tree read in a 15 s budget stops finishing. A guard that goes
  // red for the reason it was written to report is not a guard.
  'tests/timeout-budget-lane.test.ts',
  // ── tests/ — the DOCS-guard lane's own membership guard (MOTIR-4408) ──────
  // Named by THIS FILE'S derivation on the pull request that added it, which is
  // the mechanism working: it imports this module, whose text carries the
  // filesystem entry points, so it is a candidate by construction — and it is
  // one on the merits too, walking all of `tests/` and comment-stripping every
  // file to derive which specs read a `docs/**` document. Exactly the shape of
  // `ci-structural-guards-lane.test.ts` two entries up, and the fourth guard in
  // the tree that adjudicates a lane while being a member of the class it
  // adjudicates.
  //
  // ⚠️ Its own lane (`vitest.docs.config.ts`) is NOT where it goes, and that is
  // not an oversight: a `docs/**` diff cannot change its verdict, because every
  // file it opens is under `tests/`, `.github/` or the repository root. What it
  // needs is an UNCONDITIONAL lane, and this one is that — which is why
  // `docsGuardLane.ts` records it under CARRIED_BY_ANOTHER_LANE and the docs
  // guard checks that claim against this list rather than taking it on trust.
  //
  // It opens no database, renders nothing, and imports only `node:fs` /
  // `node:path` and two dependency-free helpers under `tests/`, so it carries
  // no coverage into the merged report.
  'tests/ci-docs-guards-lane.test.ts',
  // ── tests/ — the acceptance-lane IMPORT-DIRECTION guard (MOTIR-4751) ──────
  // Same shape as the entry above: it reads `playwright.acceptance.config.ts`
  // for the lane's own `testMatch`, walks every `*.spec.ts` under that config's
  // `testDir` and asks which of the two interchangeable fixture modules each
  // one imports. It opens no database, renders nothing, and imports only
  // `node:fs` / `node:path` and `tests/helpers/importGraph`, so it carries no
  // coverage into the merged report.
  //
  // It does its OWN walk rather than importing a scanner, so nothing derives it
  // — hence the `SELF_WALKING_MEMBERS` entry beside this one in
  // `tests/ci-structural-guards-lane.test.ts`.
  'tests/e2e-acceptance-lane-imports.test.ts',
  // ── tests/ — the PAGE-ROOTED LOCATOR ratchet (MOTIR-5037) ─────────────────
  // A whole-tree read of `tests/e2e/**` — 277 files — asking which locators are
  // page-rooted and strict. It reaches the tree through a SUBPROCESS
  // (`scripts/enumerate-page-locators.mjs --worktree`, the one predicate it
  // shares with `tests/helpers/pageLocatorInventory.json`) rather than through
  // `readdirSync` or `git ls-files` in its own source, so `entryPointsIn` cannot
  // see it and the derivation cannot either — hence the `SELF_WALKING_MEMBERS`
  // entry beside this one in `tests/ci-structural-guards-lane.test.ts`.
  //
  // It opens no database and renders nothing; it imports `node:child_process`,
  // `node:fs` and `node:path` only, so it carries no coverage into the merged
  // report. ~0.15 s per scan, three scans.
  'tests/e2e-page-rooted-locators.test.ts',
  // ── tests/navigation/ — the single-`main`-landmark guard (MOTIR-5432) ─────
  // Derived rather than remembered: it imports `mainLandmarkScan.ts`, which
  // walks `app/(authed)/` with `readdirSync` and parses every `.tsx` through the
  // compiler API, asking whether any page nests a second `main` landmark inside
  // `AppLayout`'s. The lane's shape exactly — one whole-subtree parse, no
  // database, nothing rendered, and it imports only `node:fs`, `node:path` and
  // `typescript`, so it carries no coverage into the merged report.
  'tests/navigation/shell-single-main-landmark.test.ts',
  // ── tests/theme/ — the clamp-overridden-by-display guard (MOTIR-5459) ─────
  // Its own `readdirSync` over `app/`, `components/` and the design system's
  // `src/`, reading every `.ts`/`.tsx` for class lists that pair a
  // `line-clamp-*` with a display utility emitted after it — hence the
  // `SELF_WALKING_MEMBERS` entry in `tests/ci-structural-guards-lane.test.ts`.
  // It compiles `app/globals.css` once through `tailwindcss` to decide which
  // neighbours override the clamp; it opens no database, renders nothing, and
  // imports only `node:*`, `importGraph`'s `stripComments` and
  // `tailwindCascade`, so it carries no coverage into the merged report.
  'tests/theme/lineClampDisplayOverride.test.ts',
  // ── tests/theme/ — the one-Switch guard (MOTIR-5735) ─────────────────────
  // Its own `readdirSync` over `app/`, `components/` and `packages/`, reading
  // every `.tsx` comment-stripped for a `role="switch"` outside the design
  // system's `Switch.tsx` — hence its `SELF_WALKING_MEMBERS` entry. It opens no
  // database, renders nothing, and imports only `node:*` and `importGraph`'s
  // `stripComments`, so it carries no coverage into the merged report.
  'tests/theme/switchPrimitiveOnly.test.ts',
  // ── tests/permissions/ — the write-control guard (MOTIR-6176) ─────────────
  // Lists `app/` and `components/` with `git ls-files` and reads every file,
  // checking that a client control calling a gated server action reads a
  // capability first. It opens no database and renders nothing; its pairing
  // table (`writeControlPairing.ts`) is data only.
  'tests/permissions/writeControlGuard.test.ts',
  // ── tests/mcp/ — the tracked-handler guard (MOTIR-6408) ────────────────────
  // Walks `tests/` and parses every file that names the `/api/mcp` route,
  // asserting each in-process handler call is registered with
  // `trackServerWork`. It opens no database; its scanner imports only
  // `typescript` and `node:*`.
  'tests/mcp/mcp-route-tracked-guard.test.ts',
  // ── tests/architecture/ — no route refresh on a live path (MOTIR-8578) ─────
  // Walks the static import graph from the Workbench, approval and planning
  // live-update roots (~540 files) and parses each through the compiler API. It
  // opens no database; its scanner imports only `typescript` and `node:*`.
  'tests/architecture/no-refresh-on-live-paths.test.ts',
  // MOTIR-8418 — Story MOTIR-8413's at-work sweeps: static reads of its enumerated
  // surface (`tests/helpers/atWorkStorySurface.ts`), no render and no database.
  'tests/planning/atWorkSurfaceGuards.test.ts',
] as const;

/**
 * Whole-tree guards that must STAY in the sharded run, with the reason each one
 * cannot move. Named rather than omitted: the lane's membership test derives its
 * candidates mechanically, so a guard that is absent for a real reason has to
 * say so, and a guard that is absent by accident fails the test.
 */
export const DATABASE_BOUND_GUARDS: Readonly<Record<string, string>> = {
  'tests/rls/system-context-arm-guard.test.ts':
    'imports ../helpers/adminDb — it pairs the static scan with live assertions ' +
    'about the system context, so it needs a migrated database.',
  'tests/rls/org-context-arm-guard.test.ts':
    'imports ../helpers/adminDb — same shape as its system-context sibling one ' +
    'axis over (MOTIR-2959). The arm inventory it adjudicates against is a ' +
    'pg_policies read, not a source scan, so the lane cannot host it.',
  'tests/rls/other-context-arm-guard.test.ts':
    'imports ../helpers/adminDb — the workspace / user / org-user descriptors, ' +
    'adjudicated against the same live pg_policies inventory (MOTIR-2959).',
  'tests/permissions/projectRolesRetired.test.ts':
    'imports @/lib/db and ../helpers/adminDb — it pairs the no-project-role-writer ' +
    'scan (MOTIR-6464, which retired roleAssignment.test.ts) with the retired ' +
    'routes driven against real rows.',
  // ── The two planning-envelope gates (MOTIR-4343, MOTIR-4736) ──────────────
  //
  // Both are HYBRIDS, and the reasons below say so rather than claiming they are
  // purely database-bound. Each pairs a live half — drive the real planning
  // entrances against real Postgres and read what crossed the wire — with a
  // static half that walks `lib/**/*.ts` for `submitJob(` call sites. The lane
  // cannot host either: it forbids importing `@/lib/*` (asserted below), and
  // these drive services, `plansService` transactions and fixtures.
  //
  // ⚠️ THEY BECAME CANDIDATES ONLY WHEN THE WALKER WAS EXTRACTED, and the
  // exposure is the finding, not the change. `candidateGuardsIn` derives from
  // "imports a scanner module", so while each spec did its walk INLINE the
  // predicate could not see it — the consent gate had been doing whole-tree
  // filesystem work inside a sharded, coverage-instrumented spec since
  // MOTIR-4343, unregistered. Sharing one walker (`./submitJobSites`) is what
  // made it visible. That is exactly the class this register exists to track,
  // so it is DECLARED here rather than hidden by un-sharing the walker.
  'tests/integration/ai/planningSubmitCarriesConsentFlag.test.ts':
    'imports @/lib/db, ../../helpers/adminDb and ../../fixtures — the half that ' +
    'matters drives startGeneration and submitRevise against real Postgres with ' +
    'the project setting switched off, and asserts the value that reached the ' +
    'wire. Its call-site walk over lib/ is DB-free and rides along; splitting it ' +
    'out would separate a presence check from the value check the file says in ' +
    'its own header cannot substitute for it.',
  'tests/inProcessState/guards.test.ts':
    'imports @/lib/db and ../helpers/adminDb — the story gate of MOTIR-8547 ' +
    '(MOTIR-8619) pairs its inventory and file-walk guards with case 9, which ' +
    'writes a moved row through the app client and reads it through a second ' +
    'client of the same database. The walk and the write are one gate over one ' +
    'list of moved rows, so they stay in one file.',
  'tests/integration/ai/planningSubmitCarriesOnboardingFlag.test.ts':
    'imports @/lib/db, ../../helpers/adminDb and ../../fixtures — it drives the ' +
    'migrate wizard through migrateOnboardingService against real Postgres (a ' +
    'run row, a completed import, a seeded repo) to prove the onboarding marker ' +
    'and the de-duplicate prompt ride the SAME submit. Same hybrid shape as its ' +
    'consent sibling above, and inseparable for the same reason.',
};

/**
 * ── THE PROPERTY, NOT THE HELPER ────────────────────────────────────────────
 *
 * The filesystem ENTRY POINTS a guard can reach the tree through. MOTIR-3144's
 * membership test asked a narrower question — *does this module parse the tree
 * with the TypeScript compiler API?* — and that question is about the
 * IMPLEMENTATION a guard happens to use, not about the property that makes one
 * flake: doing whole-tree filesystem work under a budget sized for a database
 * query, on a contended, coverage-instrumented shard.
 *
 * `tests/coverage-gate-globs.test.ts` is what the difference cost. It globs with
 * `tinyglobby` (the matcher Vitest's own coverage provider uses) and parses
 * nothing, so the compiler-API predicate returned false and the guard stayed in
 * the sharded run — where it timed out three times in four days (MOTIR-3497).
 *
 * So the predicate enumerates the entry points, and each says WHY it is a
 * carrier. Adding one is the reviewed act; matching one is not a verdict, it is
 * a question the file has to answer — by joining the lane, by declaring itself
 * database-bound, or by declaring its scan BOUNDED below.
 */
export const FILESYSTEM_ENTRY_POINTS = [
  {
    id: 'fs.readdirSync',
    pattern: /\breaddirSync\s*\(/,
    why: "node:fs's synchronous directory read — the primitive every hand-rolled tree walk in this repository is built on, and what all seven `tests/rls/*Scan.ts` modules use.",
  },
  {
    id: 'fs.promises.readdir',
    pattern: /\breaddir\s*\(/,
    why: 'the same enumeration awaited rather than blocking. A guard that walks the tree asynchronously costs exactly as much wall-clock, and `tests/jobs/engine-story-gate.test.ts` already uses this form.',
  },
  {
    id: 'fs.opendirSync',
    pattern: /\bopendirSync\s*\(/,
    why: 'the streaming form of the same read. Named now rather than after the first guard that reaches for it — the point of an entry-point list is that it does not wait for an instance.',
  },
  {
    id: 'fs.globSync',
    pattern: /\bglobSync\s*\(/,
    why: "node:fs's own glob (Node 22+). A whole-tree glob with no dependency to grep for, which is the shape a package-name predicate is blindest to.",
  },
  {
    id: 'tinyglobby',
    pattern: /['"]tinyglobby['"]/,
    why: "the matcher Vitest's coverage provider globs with, and therefore the one `tests/helpers/coverageGate.ts` has to use to ask the provider's own question. THIS is the entry point MOTIR-3497 escaped through.",
  },
  {
    id: 'fast-glob',
    pattern: /['"]fast-glob['"]/,
    why: 'the most common glob library in a Node test suite. Not a dependency of this repository today — which is exactly why it is named here rather than after somebody adds it.',
  },
  {
    id: 'globby',
    pattern: /['"]globby['"]/,
    why: 'the other one. Same reasoning: an entry-point list that only names the libraries already in use is an enumeration of instances, which is the shape this widening exists to leave.',
  },
  {
    id: 'git ls-files',
    pattern: /['"]ls-files['"]/,
    why: 'git as the enumerator, via `execFileSync` / `spawnSync`. `tests/theme/inkContrastLint.test.ts` lists the tree this way and touches no `readdirSync` at all, so no node:fs predicate can see it — it had to be listed by hand until this entry existed.',
  },
  {
    id: 'ts.createSourceFile',
    pattern: /\bcreateSourceFile\s*\(/,
    why: 'the PARSE half rather than the enumeration — the compiler API is what makes a walk expensive once it has one. It is a carrier only in combination with an enumeration, which is why `tests/theme/inkContrastScan.ts` (parsing text handed to it, touching no filesystem) reaches the tree only through its callers.',
  },
] as const;

/** Which entry points `source` reaches the filesystem through. */
export function entryPointsIn(source: string): string[] {
  return FILESYSTEM_ENTRY_POINTS.filter((e) => e.pattern.test(source)).map((e) => e.id);
}

/**
 * Modules under `tests/` that hold an entry point but whose answer is NOT
 * whole-tree — a bounded subdirectory, a build stamp, a temp directory, `/proc`.
 *
 * ⚠️ This register exists because the entry-point predicate is deliberately
 * total and therefore deliberately over-inclusive: it asks *does this touch the
 * filesystem*, and the property the lane is for is *does this touch the WHOLE
 * TREE*. The second half cannot be read off a call site — `join(repoRoot, 'app')`
 * and `join(repoRoot, 'app', 'api', 'v1')` are one path segment apart and three
 * orders of magnitude apart in cost — so it is DECLARED, with the bound named,
 * and the declaration is checked below for being about a real file that really
 * does hold an entry point.
 *
 * A module here takes its importers out of the candidate set, so an entry is a
 * reviewed act with a blast radius: `v1RouteAudit` alone accounts for twelve
 * test files.
 */
export const BOUNDED_SCAN_MODULES: Readonly<Record<string, string>> = {
  'tests/helpers/v1RouteAudit.ts':
    'walks `app/api/v1` only — the route tree it audits, roughly a hundred files, ' +
    'not a source root. Its twelve importers are ordinary API suites, most of them ' +
    'database-backed, and moving them would be a different change entirely.',
  'tests/helpers/cliHarness.ts':
    'walks `packages/cli/src` to decide whether the CLI bundle needs rebuilding — a ' +
    'build STAMP over one package, not an answer about the repository. What makes ' +
    'its five importers slow is spawning the built CLI, which the lane cannot help.',
  'tests/helpers/acceptanceLaneGuard.ts':
    'reads `tests/e2e/` filtered to the `acceptance*.spec.ts` prefix — the LANE it ' +
    'adjudicates, two dozen files, not a source root. Its one importer is the ' +
    'membership guard itself (MOTIR-2770). It had two more — a Postgres-backed ' +
    'route suite and a workflow-credential guard — until MOTIR-5874 retired the ' +
    'product read both of them served.',
  'tests/e2e/_helpers/harness-watchdog.ts':
    'reads `/proc` for the Playwright harness’s own child processes. Not the source ' +
    'tree at all, and its one vitest importer asserts on the watchdog’s parsing ' +
    'rather than running it against a repository.',
};
