import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// MOTIR-2442 — the DESIGN-ASSET GUARD lane.
//
// ── The hole this closes ────────────────────────────────────────────────────
// `ci.yml`'s Vitest, E2E, sandbox and runner-image jobs skip on a
// `design/*` branch, and rightly so: a diff that edits nothing but
// `design/**` has no app code for a browser suite or a Docker matrix to
// exercise. But two specs in `tests/**` read the design ASSETS rather than the
// app, so for them the skip landed exactly backwards — the only pull requests
// that can break them were the only ones that never ran them. MOTIR-2259
// merged green on `design/MOTIR-2259-roles-permissions`, `main` went red, and
// it surfaced hours later on an unrelated `subtask/*` PR that had not touched
// a design asset (MOTIR-2441).
//
// This config is the lane that fixes it: the design-asset guards, and only
// those, run on EVERY branch prefix from the `design-guards` job in `ci.yml`.
// The expensive things the prefix exists to save — the Playwright matrix, the
// DB-backed integration suites, the sandbox/runner image builds — stay skipped.
//
// ── Why a separate config rather than the root one ──────────────────────────
// `vitest.config.ts` carries a `globalSetup` that provisions one Postgres
// database per worker and a `setupFiles` chain that rebinds DATABASE_URL into
// it. Running ANY file under that config — even a spec that touches no
// database — therefore needs a migrated Postgres, which would make this lane
// as slow as the job it is meant to run beside. Nothing in `include` below
// touches a database, so this config drops both and the lane is an install
// plus a few seconds of Node.
//
// ── The `include` list is the enumeration, and it is guarded ────────────────
// `tests/ci-design-guards-lane.test.ts` re-derives the list by scanning
// `tests/**` for a path built into the `design/` tree and fails if a spec is
// missing from it. So a future design-asset guard cannot be written and
// silently left out of this lane — which is the same failure, one level up,
// as the one the lane exists to remove.
export default defineConfig({
  test: {
    // These specs read the whole design tree (385 HTML assets, several near 2 MB),
    // not a database. Vitest's 5 s default never described them: one sweep measured
    // 1.9 s on a quiet box and 3.1 to 5.2 s on CI, which turned main red with no
    // defect in it. Same budget as `vitest.guards.config.ts`, for the same reason:
    // it covers a loaded shared runner without hiding a real hang.
    testTimeout: 60_000,
    environment: 'node',
    // Every spec that reads the `design/**` asset tree. Nothing else: this lane
    // runs on branches where the rest of the suite is deliberately skipped, so
    // an entry that needs a database or a browser would wedge it.
    // `reader-facing-noun` (MOTIR-2540) reads `design/**` for the opposite
    // reason to its neighbour: the design tree is EXCLUDED from its scan, and it
    // opens `design/settings/design-notes.md` to prove that exclusion is
    // load-bearing rather than vacuous. That still makes it a spec a design-only
    // PR can break, which is exactly what this lane exists to catch.
    include: [
      'tests/design-asset-addresses.test.ts',
      'tests/reader-facing-noun.test.ts',
      'tests/brand/waveBand.test.ts',
      // `design-ink-contrast` (MOTIR-3014) is the ink-contrast guard pointed at
      // `design/**`. It is the spec this lane most obviously exists for: the
      // asset it rules on is only ever edited by a `design/*` PR, and the code
      // guard it extends (`tests/theme/inkContrastLint.test.ts`) is in the root
      // config, which such a PR skips.
      'tests/design-ink-contrast.test.ts',
      // `design-three-file-set` (MOTIR-3069) walks the tree for the rule
      // `CLAUDE.md` states and nothing measured: every `*.mock.html` has a
      // same-basename `.png`, and every area shipping an asset has a
      // `design-notes.md`. Seven mocks had shipped without an export, the
      // oldest for ten weeks — a design PR is both the only thing that can
      // break this and the only thing that can fix it, so it belongs here.
      'tests/design-three-file-set.test.ts',
      // `design-notes-part-numbers` (MOTIR-6190) rules that a `# Part <N>`
      // number in a `design-notes.md` addresses ONE section and that the file's
      // index table names exactly the Parts it holds. Two designs once shared
      // `Part XX` and the index lost a row, and every citation by number then
      // resolved wrong. It reads `design/**` and nothing else, and a design PR is
      // the only thing that appends a Part.
      'tests/design-notes-part-numbers.test.ts',
      // `theme/orb-glyph-contrast` (MOTIR-3207, widened by MOTIR-3217) measures
      // the floating orb's white mark against its own gradient in all twenty
      // palette x theme contexts, and it also rules on the TWO design assets
      // that draw the same orb — `ai-callout-menu.mock.html` panel 9 and
      // `planning-workspace.mock.html` sheet 4 — asserting each reproduces the
      // shipped recipe by REFERENCE (the same `--orb-lit-mix` token, no copied
      // number) and paints no raw hue in its fill, rim, glow or mark. A design
      // PR editing either is therefore the thing most likely to break it, and
      // would otherwise skip the root config that runs it.
      'tests/theme/orb-glyph-contrast.test.ts',
      // `design-dark-parity` (MOTIR-3592) is the only spec in the tree that asks a
      // CSS engine what a nested `[data-theme="dark"]` element in a mock actually
      // COMPUTED, rather than what its stylesheet says. It reads every
      // `*.mock.html` and nothing else, so a design PR is both the only thing
      // that can break it and the only thing that can fix it. It runs on
      // happy-dom, already a devDependency — no browser, so the lane stays in the
      // cost class this config's header promises.
      'tests/design-dark-parity.test.ts',
      // `design-state-ink-contrast` (MOTIR-4255) is the STATE arm of the ink
      // guard: `inkContrastMockScan`'s `stylePaint` abstains on every selector
      // carrying a pseudo-class, so `design-ink-contrast` enforces the muted arm
      // at zero over the RESTING tree only — every `:hover` tint was unmeasured
      // by construction. This spec renders each mock in happy-dom and resolves
      // the state surface from the tree instead of from the selector text. Same
      // engine and the same cost class as its neighbour above; it reads
      // `design/**` and nothing else, so a design PR is both the only thing that
      // can break it and the only thing that can fix it.
      'tests/design-state-ink-contrast.test.ts',
      // `design-token-layer` (MOTIR-4353) is the CLASS guard for MOTIR-4318: it
      // rules that every `*.mock.html` DECLARES the `--el-*` layer, and that
      // none of them declares a privately-named colour alias — the pattern
      // eleven assets carried, which both ink arms above are structurally
      // unable to see because they classify ink by reading an `--el-*` name off
      // the declaration at the paint site. It reads `design/**` and
      // `packages/design-system/theme.css` and nothing else — no database, no
      // browser, plain string work — so a design PR is both the only thing that
      // can break it and the only thing that can fix it, which is this lane's
      // whole predicate.
      'tests/design-token-layer.test.ts',
      // `scripts/render-design-mock-search` (MOTIR-4374) guards the viewport
      // SEARCH inside `scripts/render-design-mock.mjs` — the tool every design
      // PR uses to re-export a `.png`, and the one whose silent failure mode is
      // an asset three times too tall. It reads no asset (it drives the search
      // with a fake renderer), so it is not in this lane by the drift guard's
      // predicate; it is here because a `design/*` branch is where the script it
      // guards is RUN, and because the spec needs neither a database nor a
      // browser, so it costs this lane milliseconds.
      'tests/scripts/render-design-mock-search.test.ts',
      // `design-mock-utility-correspondence` (MOTIR-4687) is the CORRESPONDENCE
      // guard: a mock's hand-written utility-shim block and its markup are two
      // hand-maintained lists that are supposed to agree, and nothing checked
      // that they did in either direction. It reports a class an element
      // carries that no rule declares (115 occurrences across 8 assets when it
      // was written — a heading asking for `text-[19px]` and getting the UA's
      // `1.5em`), and a rule declared that no element in the tree carries
      // (MOTIR-4150's `.max-w-md`, read by a card as "the value the asset
      // draws"). Every ink guard above asks what a rule SAYS; this is the only
      // one that asks whether any rule APPLIES — and the direction of the risk
      // is inverted, because an un-styled element inherits `--el-text` and
      // PASSES contrast, so the defect makes its neighbours greener. It reads
      // `design/**` and nothing else, no database and no browser, which is this
      // lane's whole predicate.
      'tests/design-mock-utility-correspondence.test.ts',
      // `design-dark-board-parity` (MOTIR-4868) is the guard for the FOURTH
      // file. Five assets ship a `<name>.dark.png` — the same board with
      // `data-theme="dark"` on the root — and nothing anywhere read one: the
      // three-file rule `design-three-file-set` measures is written for ONE
      // PNG, and the re-export script exported the light board only, so a mock
      // edit left the dark PNG drawing the old design under an `EXACT` verdict
      // for the half the tool did do. It reads `design/**` and nothing else, no
      // database and no browser, which is this lane's whole predicate — and a
      // design PR is both the only thing that can break it and the only thing
      // that can fix it.
      'tests/design-dark-board-parity.test.ts',
      // `scripts/render-design-mock-boards` (MOTIR-4868) guards the BOARD loop
      // in `scripts/render-design-mock.mjs` — which files one mock exports, and
      // that a `REFLOW` on one board still writes the other. It reads no asset
      // (it drives the loop with a fake renderer and a fake writer), so it is
      // here for the same reason its search sibling above is: a `design/*`
      // branch is where the script it guards is RUN, and the spec needs neither
      // a database nor a browser.
      'tests/scripts/render-design-mock-boards.test.ts',
      // `scripts/render-design-mock-git` (MOTIR-4895) guards the HEAD BASELINE
      // READ in `scripts/render-design-mock.mjs` — the `git show HEAD:<path>`
      // whose non-zero exit used to throw, making every render after the first
      // fatal for an asset with no committed baseline. It is here for the same
      // reason its two siblings above are: a `design/*` branch is where the
      // script it guards is RUN, and a new asset is exactly the case a design PR
      // creates. It `git init`s a temp repository (the read is about what git
      // does with an uncommitted path, so a stub would assert the stub) and
      // fakes the renderer — no database and no browser.
      'tests/scripts/render-design-mock-git.test.ts',
      // `design-lesson-phase-chips` (MOTIR-5107) reads the lesson library's
      // board and `messages/en.json` together, and asserts every phase chip is
      // a string the CATALOGUE holds rather than a literal this spec carries.
      // The asset had gone on drawing `phase skeleton` for as long as nothing
      // measured it, so it is here by this lane's own predicate: a design PR is
      // both the only thing that can break it and the only thing that can fix
      // it, and it costs a file read and a regex.
      'tests/design-lesson-phase-chips.test.ts',
      // `design-github-development-copy` (MOTIR-5152) reads `design/github/design-notes.md`
      // §5c and `messages/{en,zh}.json` together, and asserts the PR-link picker's
      // typed-error banner says what the asset specifies — the same shape as its
      // neighbour above. The two disagreed about the tenant for six days (the asset
      // said *organisation*, the catalogue said *workspace*) because the shipped gate
      // really did check a workspace; widening that gate is what made the design's
      // sentence true, so the agreement is worth a standing guard. It is here rather
      // than beside the service tests that widened the gate because those need a
      // database and this lane must not: a `design/*` PR editing §5c skips every app
      // lane, and is exactly the pull request that must not skip this.
      'tests/design-github-development-copy.test.ts',
      // `design-surface-views-chrome-copy` (MOTIR-6184) reads
      // `design/ai-planning/plan-review--surface-views.mock.html` and
      // `messages/en.json` together — the same shape as its two neighbours above.
      // That asset composes the planning surface's own chrome, and its first
      // version copied the class strings out of `PlanningWorkspaceHost.tsx` while
      // TYPING the text: the resting footer read "Ask for a change" where the
      // catalogue says "Roadmap — as saved". Every other guard in this lane was
      // green over it, because none of them reads a string. It is here rather
      // than beside the component tests because a `design/*` PR editing the mock
      // skips every app lane and is exactly the pull request that must not skip
      // this.
      'tests/design-surface-views-chrome-copy.test.ts',
      // `design-css-reader` (MOTIR-7179) pins `tests/theme/flattenMockCss.ts`, the
      // reader both rendering guards above (`design-dark-parity`,
      // `design-state-ink-contrast`) put every mock through: happy-dom drops
      // `@layer` blocks and nested rules, which is all compiled Tailwind emits.
      // It reads no committed asset — it renders one with `renderMock` from the
      // package SOURCE (this job skips `postinstall`, so `dist` may be absent) —
      // and it is here because the reader is what this lane's verdicts stand on:
      // a regression in it silently blinds two of its specs.
      'tests/design-css-reader.test.ts',
    ],
  },
  resolve: {
    // The root config gets `@/…` from `vite-tsconfig-paths` via the Next plugin
    // chain it inherits; this standalone config resolves the alias itself.
    // `waveBand.test.ts` imports `@/components/brand/waveBand`.
    alias: [
      { find: '@', replacement: resolve(fileURLToPath(new URL('.', import.meta.url))) },
      // Same stub the root config uses: `import 'server-only'` is a Next
      // build-time marker with no plain-node resolution.
      {
        find: 'server-only',
        replacement: resolve(
          fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
        ),
      },
      // MOTIR-7179 — `@motir/design-system` RUN from source. Its `exports` point
      // at `dist`, which `postinstall` builds and the `design-guards` job never
      // runs (it restores `node_modules` from cache), so on a cache hit the
      // built package is absent. Exact matches only: a prefix alias would also
      // capture `@motir/design-system/theme.css`.
      {
        find: /^@motir\/design-system\/mock$/,
        replacement: resolve(
          fileURLToPath(new URL('./packages/design-system/src/mock/index.ts', import.meta.url)),
        ),
      },
      {
        find: /^@motir\/design-system$/,
        replacement: resolve(
          fileURLToPath(new URL('./packages/design-system/src/index.ts', import.meta.url)),
        ),
      },
    ],
  },
});
