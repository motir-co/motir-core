import { defaultExclude, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { TEST_DB_WORKERS } from './tests/helpers/parallelDb';
// MOTIR-3144 — the structural-guard lane's membership. Imported rather than
// restated so this config's `exclude` and that config's `include` cannot drift.
// ⚠️ Spelling `defaultExclude` back in is required: supplying `exclude` REPLACES
// Vitest's default, so omitting it would put `node_modules` and `dist` back into
// the run.
import { STRUCTURAL_GUARD_SPECS } from './tests/helpers/structuralGuardLane';

// Load .env into process.env before Vitest evaluates the test files. Next.js
// does this automatically at runtime; Vitest does not. Without this load,
// lib/db.ts throws "DATABASE_URL is not set" at module-import time and the
// suite fails before any test runs.
loadEnv();

// Test-only defaults for the env vars `lib/auth/index.ts` reads at module
// load. We do NOT overwrite anything a developer set in .env (override:false
// is dotenv's default). These placeholders only kick in when a CI/dev shell
// has nothing set — they let the auth module import without throwing, which
// is required for any test that touches Better-Auth's surface. They never
// reach a real OAuth server.
process.env['GOOGLE_CLIENT_ID'] ??= 'test-google-client-id';
process.env['GOOGLE_CLIENT_SECRET'] ??= 'test-google-client-secret';
process.env['BETTER_AUTH_SECRET'] ??= 'test-better-auth-secret-32-bytes-long-please';
// GitHub integration (Story 7.10 · MOTIR-1498). The encryption key is a fixed
// 64-hex test value (decodes to 32 bytes) so tokenCrypto round-trips in tests;
// the OAuth client id/secret let the identity service resolve config without a
// real GitHub app (the fetch calls are stubbed per-test). Never reach GitHub.
process.env['GITHUB_APP_CLIENT_ID'] ??= 'test-github-client-id';
process.env['GITHUB_APP_CLIENT_SECRET'] ??= 'test-github-client-secret';
process.env['GITHUB_TOKEN_ENCRYPTION_KEY'] ??=
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
// Linear import "Connect" OAuth app (Story 7.16 · MOTIR-1655). Client id/secret
// let linearImportOAuthService resolve config without a real Linear app (the
// token exchange is stubbed per-test); import-token encryption falls back to
// GITHUB_TOKEN_ENCRYPTION_KEY above. Never reach Linear.
process.env['LINEAR_OAUTH_CLIENT_ID'] ??= 'test-linear-client-id';
process.env['LINEAR_OAUTH_CLIENT_SECRET'] ??= 'test-linear-client-secret';
// Plane import "Connect" OAuth app (Story 7.16 · MOTIR-1656). Client id/secret
// let planeImportOAuthService resolve Cloud config without a real Plane app (the
// token exchange is stubbed per-test); import-token encryption falls back to
// GITHUB_TOKEN_ENCRYPTION_KEY above. Never reach Plane.
process.env['PLANE_OAUTH_CLIENT_ID'] ??= 'test-plane-client-id';
process.env['PLANE_OAUTH_CLIENT_SECRET'] ??= 'test-plane-client-secret';

// Vitest defaults to the Node environment for integration tests against a
// real Postgres. The first browser-style component test arrived in Story 1.4
// (the Markdown render smoke test): it opts into happy-dom per-file via a
// `// @vitest-environment happy-dom` directive at the top of the file, so the
// global default stays `node` and the DB-backed suites are unaffected. If
// component tests proliferate, split this into `vitest.workspace.ts` rather
// than dual-moding here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // MOTIR-3144 — the whole-tree structural guards run in their OWN job
    // (`vitest.guards.config.ts`, `structural-guards` in `ci.yml`), not here.
    //
    // They parse `lib/` + `app/` through the TypeScript compiler API and touch
    // no database. Inside this run they were competing for CPU with the suites
    // that make it slow, under v8 coverage instrumentation, on a 15 s
    // `testTimeout` sized for a query — and they timed out for reasons that had
    // nothing to do with what they check. `bare-transaction-guard` cost 8.1 s
    // alone and blew a 120 s hook budget on CI twice in a row.
    //
    // ⚠️ This is an EXCLUDE, not a duplicate. Unlike the design-asset lane —
    // whose specs stay in this list because that lane exists to run them on
    // MORE branches — the point here is that these stop executing in the
    // sharded job. The one list lives in `vitest.guards.config.ts` so the two
    // cannot drift, and `tests/ci-structural-guards-lane.test.ts` fails if a
    // whole-tree guard is missing from it.
    //
    // Locally: `pnpm test:guards`. They contribute no coverage to any gated
    // file (not one imports from `lib/` or `app/`), so the merged report is
    // unchanged by their absence.
    exclude: [...defaultExclude, ...STRUCTURAL_GUARD_SPECS],
    // Per-worker database isolation (Story 10.4.1). `globalDb` clones the
    // migrated base DB into one `…_test_wN` database PER worker before any
    // worker forks; `perWorkerDb` (FIRST setupFile — must run before
    // `inngestSetup`, which imports `@/lib/db`) rebinds DATABASE_URL to this
    // worker's clone before the `db` singleton reads it. That isolation is what
    // makes `fileParallelism: true` safe — each worker truncates only its OWN
    // database. See tests/helpers/parallelDb.ts for the shared wiring.
    globalSetup: ['./tests/setup/globalDb.ts'],
    // Setup order matters: perWorkerDb MUST precede inngestSetup. inngestSetup
    // stubs inngest.send to a no-op so the unconditional `work-item/created` +
    // `work-item/field.changed` emits (Subtask 6.6.2) don't throw on the
    // keyless test client. Event-asserting tests re-spy.
    // `actEnvironment` turns React's act environment ON for the happy-dom files
    // (it self-scopes on `window`, so the Node files are untouched). That makes
    // React flush passive effects synchronously inside RTL's act scopes, which
    // REMOVES the effect-ordering race class MOTIR-1736/1737 hit — see that file
    // for the mechanism and the contract it imposes on component tests.
    // `inFlightProbe` registers one `afterEach` that FAILS a DB-backed test
    // which left a backend `active` or `idle in transaction` on its worker's
    // database, naming the query (MOTIR-6278; MOTIR-3077 built it as an
    // opt-in sweep). A file that never opened a Prisma client skips it, and its
    // import is dynamic, so a pure component file pays nothing.
    // `rateLimitStoreDefault` gives the shared rate-limit store the TEST-TIME
    // deadline in those same files, so a request waits for its own counter
    // write instead of failing open and abandoning it mid-transaction —
    // which the in-flight check would otherwise catch as a leak (MOTIR-6278).
    setupFiles: [
      './tests/helpers/perWorkerDb.ts',
      './tests/helpers/actEnvironment.ts',
      './tests/helpers/rateLimitStoreDefault.ts',
      './tests/helpers/inFlightProbe.ts',
    ],
    // Cross-FILE parallelism is now safe (each worker has its own DB, above).
    // `sequence.concurrent` stays false so test()s WITHIN a file still run
    // sequentially against that worker's single connection. `maxWorkers` is
    // pinned to the worker-DB count (Vitest 4 top-level option) so
    // VITEST_POOL_ID never exceeds a provisioned database.
    fileParallelism: true,
    maxWorkers: TEST_DB_WORKERS,
    sequence: {
      concurrent: false,
    },
    testTimeout: 15_000,
    // MOTIR-1265 — give lifecycle hooks their own, larger budget. Vitest
    // defaults `hookTimeout` to 10s, which was BELOW the 15s `testTimeout` and
    // applied to the `beforeEach` `truncateAll()` every DB-backed suite runs.
    // The multi-table `TRUNCATE … CASCADE` is legitimately variable under the
    // concurrent-worker CI load (see tests/setup/globalDb.ts, where
    // `synchronous_commit = off` now removes the fsync stall that was the root
    // cause); this headroom keeps a rare IO spike from red-lighting the whole
    // job (which, via merge-with-main CI, taxes every open PR). Belt-and-braces
    // with the globalDb fix — not a substitute for it.
    hookTimeout: 30_000,
    // Coverage (Subtask 1.4.7, extended by 2.6.4). The Epic-2 load-bearing
    // modules must stay at ≥90% branches/functions/lines. 1.4.7 gated the
    // work-item data model — the service + its three repositories. 2.6.4 adds
    // the Story-2.2 workflow layer (`workflowsService` + `workflowsRepository`)
    // to the gate, closing coverage-gap #4: that layer shipped ungated, and
    // `workItemsService` grew across Stories 2.3–2.5 (detail / tree / list /
    // pagination) after the 1.4.7 numbers were measured. 4.1.4 adds
    // `backlogService` (issue↔sprint association + backlog rank + the bounded
    // reads). 4.6.7 adds the Story-4.6 reports layer — `reportsService` (the
    // burndown + velocity aggregates) + `reportsMappers` + `sprintRepository`
    // (grown by 4.6.4's bounded completed-sprints read) + the 4.6.2 chart
    // primitives. We scope `include` to exactly these files so the report (and
    // the per-file thresholds below) stays focused on the surface this Epic is
    // responsible for, rather than diluting the signal across the whole tree.
    // Other modules carry their own coverage stories in their own Subtasks. v8
    // is the provider (matches @vitest/coverage-v8).
    //
    // ⚠️ A FILE UNDER A NEXT.JS ROUTE GROUP IS ENTERED AS `app/**/…`, NEVER AS
    // ITS LITERAL PATH (MOTIR-2449). `(authed)` is a real directory on disk, but
    // `(` is GROUPING SYNTAX to picomatch/tinyglobby — the matchers the coverage
    // provider uses — so `app/(authed)/settings/…` resolves to no file at all.
    // The file then never enters the report, and a `thresholds` key naming it
    // gates nothing: an unmatched key is not an error in Vitest, it is an empty
    // coverage map that passes every percentage. Twenty entries sat in exactly
    // that state, silently, until `tests/coverage-gate-globs.test.ts` was
    // written — that test now fails the build on any pattern or key that reaches
    // no file, in EITHER half, so this comment is a courtesy and not the guard.
    coverage: {
      provider: 'v8',
      include: [
        // Story MOTIR-6170 · MOTIR-6650 — the VISITOR story's new modules (the
        // Visitor read context, its resolution helpers, the visitor record's
        // repository / service / mapper, the name-only person label, the page
        // context the eight read pages share, and the Not public pill). Pinned at
        // the project floor in `thresholds` below after being MEASURED on this
        // branch against the story's own specs — every one ≥ 90 on all four
        // metrics. `lib/visitor/pageGate.ts` (branches 85) and the story's
        // `app/**` files are not pinned: the MOTIR-6650 PR body carries their
        // numbers and why.
        'lib/visitor/consentPath.ts',
        'lib/visitor/context.ts',
        'lib/visitor/cookie.ts',
        'lib/visitor/errors.ts',
        'lib/visitor/readActor.ts',
        'lib/visitor/readScope.ts',
        'lib/visitor/routes.ts',
        'lib/services/visitorRecordsService.ts',
        'lib/repositories/projectVisitorRepository.ts',
        'lib/mappers/visitorMappers.ts',
        'lib/people/personLabel.ts',
        'lib/pages/projectPageContext.ts',
        'components/issues/EpicNotPublicPill.tsx',
        // Story MOTIR-6171 · MOTIR-6748 — the Visitor's pending-requests read (the
        // service it grew, its "Load more" door) and the Requested features list.
        // MEASURED on this branch against the story's specs, then pinned at the
        // floor: the service 100 / 93.1 / 100 / 100, the door 95.83 / 93.75 /
        // 100 / 100, the list 96.96 / 94.44 / 100 / 100. Dynamic segments escaped,
        // route group spanned by `app/**` — the rules the block below records.
        'lib/services/publicRequestsService.ts',
        'app/api/p/\\[identifier\\]/requests/route.ts',
        'app/**/p/\\[identifier\\]/requested-features/_components/RequestedFeaturesList.tsx',
        // Story MOTIR-6739 · MOTIR-6726 — the to-do tools' MCP adapter. Pinned at
        // the project floor in `thresholds` below after being MEASURED on this
        // branch against the story's own specs (`workItemTodosTool.test.ts` +
        // `workItemTodos-transport.test.ts`): 100 / 100 / 100 / 100.
        'lib/mcp/tools/workItemTodos.ts',
        // Story MOTIR-7261 · MOTIR-7264 — the continue tools' MCP adapter. Pinned at
        // the project floor in `thresholds` below after being MEASURED on this
        // branch against the story's own specs (`workItemContinueTool.test.ts` +
        // `workItemContinue-transport.test.ts`): 100 / 90.62 / 100 / 100. Its
        // service, `workItemContinueService.ts`, is already gated.
        'lib/mcp/tools/workItemContinue.ts',
        // Story MOTIR-9491 · MOTIR-9639 — page search on `/pages`: the session route, the
        // client function and hook, and the search box with its result list. Pinned at the
        // project floor in `thresholds` below after being MEASURED on this branch against
        // the story's own specs (`tests/integration/pages/pageSearchStoryGate.test.ts`,
        // `tests/api/pagesSearchRoute.test.ts`, `tests/components/use-page-search.test.tsx`,
        // `tests/components/pages-search.test.tsx`): all seven files 100 / 100 / 100 / 100
        // on lines / statements / functions / branches. The route group is spanned by
        // `app/**`. The two branches the route card added to the shared
        // `lib/pages/routeErrors.ts` are measured in the PR body; it is not newly pinned.
        'app/api/pages/search/route.ts',
        'components/pages/search/pageSearchClient.ts',
        'components/pages/search/usePageSearch.ts',
        'app/**/pages/_components/PagesSearch.tsx',
        'app/**/pages/_components/PageSearchResults.tsx',
        'app/**/pages/_components/PageSearchHitRow.tsx',
        'app/**/pages/_components/snippetEmphasis.ts',
        // Story MOTIR-9487 · MOTIR-9559 — the three page tools an agent moves, archives and
        // links pages with. Pinned at the project floor in `thresholds` below after being
        // MEASURED on this branch against the story's own specs
        // (`tests/integration/pages/pageMcpToolsStoryGate.test.ts` +
        // `tests/mcp/{move,archive,link}PageTool.test.ts`), lines / statements / functions /
        // branches: movePage 100 / 100 / 100 / 100, archivePage 100 / 100 / 100 / 92.85,
        // linkPage 100 / 100 / 100 / 100. The link-error arm the story added to the shared
        // `lib/mcp/toolResult.ts` is covered by the same specs (PAGE_LINK_NOT_FOUND); that
        // file is not in the report and its changed lines are measured in the PR body.
        'lib/mcp/tools/movePage.ts',
        'lib/mcp/tools/archivePage.ts',
        'lib/mcp/tools/linkPage.ts',
        // Story MOTIR-7460 · MOTIR-7479 — the manual-work gate's two NEW modules (the
        // kind's handler, and its raise / withdrawals). Pinned at the project floor in
        // `thresholds` below after being MEASURED on this branch against the story's own
        // specs (`tests/integration/approvals/manualWorkGateStoryGate`,
        // `tests/approvalGates/manualWorkGate`, `tests/dispatchRunService`,
        // `tests/ai/guideLandingService`): handler 100 / 90.9 / 100 / 100, service
        // 100 / 97.9 / 100 / 100. The shared files the story changed keep their existing
        // pins (`dispatchRunService.ts`, `dispatchRunMappers.ts`, …) or were never in the
        // report; their CHANGED lines are measured in the MOTIR-7479 PR body.
        'lib/approvalGates/manualWorkHandler.ts',
        // Story MOTIR-7662 · MOTIR-7677 — the idea store: its services, repositories,
        // gate, route transport and the public and staff routes. MEASURED on this
        // branch against the story's own specs (`tests/ideas/**`,
        // `tests/api/platformIdeasRoutes`, `tests/api/publicIdeasRoutes`,
        // `tests/platform/ideasGate`, `tests/platform/platformTokenBoundary`): every
        // file ≥ 94.5% branches and ≥ 99.6% lines, 100% functions; the admin service
        // is the low one at 99.6 / 94.5 / 100 / 99.6. Pinned at the floor below.
        // `lib/platform/context.ts` grew `withPlatformWrite` here; it measured
        // 100 / 95.8 / 100 / 100 and stays in the report it was already in or not.
        // Story MOTIR-7664 · MOTIR-7682 — the console's Ideas page (MOTIR-7680 / 7681):
        // the list and detail loaders, the three Server Actions, the edit form, the
        // two dialogs, the filter bar and the rail row. MEASURED on this branch
        // against the story's specs (`tests/integration/ideasConsoleStoryGate`,
        // `tests/platform/ideas*`, `tests/components/idea-*`,
        // `tests/components/admin-shell-ideas`): every file 100% lines and
        // functions, ≥ 90.9% branches — `IdeasTable` (90.9) and `DeleteIdeaDialog`
        // / `IdeaFilters` are the thin ones. Pinned at the floor in `thresholds`.
        // `AdminShell` was ungated before this story added its row; it measures
        // 100 / 100 / 100 / 100 on the shell spec alone. `app/(admin)/layout.tsx`
        // gained one label and is the gate's, covered by the gate suites.
        'app/**/admin/ideas/actions.ts',
        'app/**/admin/ideas/page.tsx',
        'app/**/admin/ideas/\\[slug\\]/page.tsx',
        'app/**/admin/ideas/\\[slug\\]/_components/DeleteIdeaDialog.tsx',
        'app/**/admin/ideas/\\[slug\\]/_components/IdeaEditForm.tsx',
        'app/**/admin/ideas/\\[slug\\]/_components/IdeaWorkbench.tsx',
        'app/**/admin/ideas/\\[slug\\]/_components/RetireIdeaDialog.tsx',
        'app/**/admin/ideas/\\[slug\\]/_components/ideaDraft.ts',
        'app/**/admin/ideas/_components/IdeaBits.tsx',
        'app/**/admin/ideas/_components/IdeaDetailView.tsx',
        'app/**/admin/ideas/_components/IdeaFilters.tsx',
        'app/**/admin/ideas/_components/IdeasSkeleton.tsx',
        'app/**/admin/ideas/_components/IdeasTable.tsx',
        'app/**/admin/ideas/_components/IdeasUnavailable.tsx',
        'app/**/admin/ideas/_components/ideaListQuery.ts',
        'app/**/_components/AdminShell.tsx',
        // Story MOTIR-8699 · MOTIR-8716 — the console's Fleet settings page (see the
        // fleet block in this list for the whole set). Pinned at 90 in `thresholds`.
        'app/**/admin/fleet-settings/actions.ts',
        'app/**/admin/fleet-settings/page.tsx',
        'app/**/admin/fleet-settings/_components/FleetOrgCiSetting.tsx',
        'app/**/admin/fleet-settings/_components/FleetSettingsUnavailable.tsx',
        'app/**/admin/fleet-settings/_components/fleetReadinessCopy.ts',
        'lib/ideas/consoleActor.ts',
        'lib/services/ideasAdminService.ts',
        'lib/services/ideasPublicService.ts',
        'lib/repositories/ideaRepository.ts',
        'lib/repositories/ideaPublicRepository.ts',
        'lib/repositories/ideaTagRepository.ts',
        'lib/repositories/ideaResearchRunRepository.ts',
        'lib/mappers/ideaMappers.ts',
        'lib/ideas/categories.ts',
        'lib/ideas/errors.ts',
        'lib/ideas/limits.ts',
        'lib/ideas/publicCache.ts',
        'lib/ideas/routeErrors.ts',
        'lib/ideas/schemas.ts',
        // Story MOTIR-7772 · MOTIR-7773 — the per-locale field list.
        'lib/ideas/translatableFields.ts',
        // Story MOTIR-7772 · MOTIR-7774 — the staff translation view and the tag route.
        'lib/ideas/staffTranslations.ts',
        // Story MOTIR-7772 · MOTIR-7775 — the public locale resolver and merge.
        'lib/ideas/publicLocale.ts',
        'app/api/platform/ideas/tags/\\[slug\\]/route.ts',
        'lib/platform/ideasGate.ts',
        'app/api/platform/ideas/route.ts',
        'app/api/platform/ideas/\\[slug\\]/route.ts',
        'app/api/platform/ideas/\\[slug\\]/retire/route.ts',
        'app/api/platform/ideas/tags/route.ts',
        'app/api/platform/ideas/runs/route.ts',
        'app/api/public/ideas/route.ts',
        'app/api/public/ideas/\\[slug\\]/route.ts',
        'app/api/public/ideas/tags/route.ts',
        'lib/services/manualWorkGateService.ts',
        // Story MOTIR-7220 · MOTIR-7234 — the planner-model story's motir-core
        // gate: the console seam (service + mapper), the one plan-read redaction
        // helper, and the console's Server Action. MEASURED on this branch against
        // the story's specs (`plannerModelStoryGate.test.ts`, the service, action
        // and redaction suites): mapper 100 / 100 / 100 / 100, redaction
        // 100 / 100 / 100 / 100, service 93.93 / 91.66 / 100 / 93.1, action
        // 91.66 / 92.85 / 100 / 90. `lib/ai/motirAiClient.ts` is NOT pinned: the
        // story adds two functions to a 2,300-line client whose other paths are
        // other stories' and measure ~10 % here.
        'lib/services/platformPlannerModelService.ts',
        'lib/mappers/platformPlannerModelMappers.ts',
        'lib/plans/redactNativeModel.ts',
        'app/**/admin/ai-planning/actions.ts',
        // Story MOTIR-7521 · MOTIR-7529 — the model-lists story's motir-core gate:
        // the run-model list (service, repository, mapper), the narrowed hosted-run
        // offer, both lists' console cards and the run list's Server Action.
        // MEASURED on this branch against the story's specs
        // (`modelListsStoryGate.test.ts` plus each unit's suite), lines / branches /
        // functions / statements: run service 100 / 95 / 100 / 98.43, repository
        // 100 / 100 / 100 / 100, mapper 100 / 100 / 100 / 100, offer service
        // 100 / 90.9 / 100 / 93.33, run action 100 / 100 / 100 / 100, run card
        // 98.88 / 90.41 / 97.05 / 96.96, planning card 100 / 94.28 / 100 / 97.87,
        // both unavailable cards 100. The two `page.tsx` Server Components are
        // not pinned: they are the acceptance spec's (MOTIR-7530) to walk.
        'lib/services/platformRunModelService.ts',
        'lib/repositories/platformRunModelRepository.ts',
        'lib/mappers/platformRunModelMappers.ts',
        'lib/services/hostedRunModelService.ts',
        // Story MOTIR-9541 (MOTIR-9631): the agent-run capacity verdict — its reasons,
        // its pure rule and the service the picker read and the launch check share.
        'lib/hostedRuns/capacityReasons.ts',
        'lib/hostedRuns/agentCapacityVerdict.ts',
        'lib/services/agentRunCapacityService.ts',
        'app/**/admin/run-models/actions.ts',
        'app/**/admin/run-models/_components/RunModelList.tsx',
        'app/**/admin/run-models/_components/RunModelListUnavailable.tsx',
        'app/**/admin/ai-planning/_components/PlannerModelList.tsx',
        'app/**/admin/ai-planning/_components/PlannerModelListUnavailable.tsx',
        // Story MOTIR-6574 · MOTIR-6584 — the OBSOLESCENCE story's two NEW modules
        // (the scale's one list, and the MCP write fields + text-block lines) and
        // the relationship model it widened with the `supersedes` pair, which had
        // no coverage entry at all. Pinned at the project floor in `thresholds`
        // below after being MEASURED on this branch against the story's own specs:
        // 100 / 100 / 100 / 100 on all three. The already-gated files the story
        // touched are measured by the PR's coverage job, suite-wide.
        'lib/issues/obsolescence.ts',
        'lib/mcp/obsolescence.ts',
        'lib/workItems/linkRelationships.ts',
        // Story MOTIR-6577 · MOTIR-6633 — the seven NEW modules the "a plan MARKS a
        // card" story added: the mark-only predicate the terminal-card carve-out
        // and approve's write share, the plan path's mark bar (membership + the
        // finished-card rule), the note's one-line form, and the review's four
        // mark primitives. Pinned in `thresholds` below after being MEASURED on
        // this branch, one spec at a time (stmts / branch / fn / lines):
        //
        //   markOnlyPatch.ts                 100 / 100   / 100 / 100  (tests/plans/planMarkPrimitives)
        //   validateProposedObsolescence.ts  100 / 100   / 100 / 100  (same)
        //   obsolescenceNote.ts              100 / 100   / 100 / 100  (same)
        //   ObsolescencePill.tsx             100 / 100   / 100 / 100  (tests/components/plan-mark-primitives)
        //   SupersedesChip.tsx               100 / 97.67 / 100 / 100  (same)
        //   ProposalMarkRailRows.tsx         100 / 97.36 / 100 / 100  (same)
        //   changeCellText.ts                100 / 100   / 100 / 100  (same)
        //
        // ⚠️ The story's CHANGED shared files are deliberately NOT added, by the
        // rule the MOTIR-5548 block below states: `plansService`,
        // `planReviewService`, `lib/dto/plans`, `lib/dto/planReview`, the three
        // plan-proposal routes, `PlanItemNode` and `PlanningTargetChip` each carry
        // other stories' methods, so a per-file floor would make this story cover
        // code it did not write. Their story paths are held by
        // `tests/integration/plans/planMarkStoryGate.test.ts` (every door →
        // review → approve, and every refusal at every door) and the feature
        // cards' own suites. `validateProposals`, `authorPlan`, `getPlan`,
        // `ProposalPeek` and `PlanProposalList` were already gated and stay so.
        'lib/plans/markOnlyPatch.ts',
        'lib/plans/validateProposedObsolescence.ts',
        'lib/workItems/obsolescenceNote.ts',
        'components/issues/ObsolescencePill.tsx',
        'components/planning/SupersedesChip.tsx',
        'components/planning/ProposalMarkRailRows.tsx',
        'components/planning/changeCellText.ts',
        // Story MOTIR-9023 · MOTIR-9036 — the fourteen NEW modules the typed-sections
        // story added: the registry, parser, renderer and validity check, the two
        // door rules (plan / work item), the section-sets read in its REST, MCP and
        // service forms, and the opt-in parsed view. Pinned in `thresholds` below
        // after being MEASURED on this branch against the story's own specs
        // (stmts / branch / fn / lines):
        //
        //   parse.ts                 97.32 / 90.44 / 100   / 99.45
        //   registry.ts              97.33 / 96.55 / 94.11 / 96.96
        //   render.ts                98.7  / 90    / 100   / 100
        //   validity.ts              100   / 100   / 100   / 100
        //   sectionsInput.ts         100   / 95.55 / 100   / 100
        //   applySectionsInput.ts    100   / 95.55 / 100   / 100
        //   getSectionSets.ts        100   / 62.5  / 100   / 100   (the `|| 'none'` / `?? 'no type'`
        //                                                          fallbacks no registry cell reaches)
        //   the other seven          100 on all four
        'lib/workItems/sections/errors.ts',
        'lib/workItems/sections/parse.ts',
        'lib/workItems/sections/registry.ts',
        'lib/workItems/sections/render.ts',
        'lib/workItems/sections/validity.ts',
        'lib/mcp/parsedSections.ts',
        'lib/mcp/payloads/parsedSectionsSchema.ts',
        'lib/mcp/payloads/sectionSets.ts',
        'lib/mcp/sectionsInput.ts',
        'lib/mcp/tools/getSectionSets.ts',
        'lib/api/v1/sectionSets/operations.ts',
        'lib/api/v1/sectionSets/schema.ts',
        // Story MOTIR-9486 · MOTIR-9496 — the `/api/v1` PAGE resource: its helpers
        // and its three route files, pinned at the project floor in `thresholds`
        // below after being measured against the `tests/api/v1/pages-*` suites.
        'lib/api/v1/pages/errors.ts',
        'lib/api/v1/pages/resolve.ts',
        'lib/api/v1/pages/schema.ts',
        'lib/api/v1/pages/operations.ts',
        'app/api/v1/projects/\\[projectKey\\]/pages/route.ts',
        'app/api/v1/pages/\\[pageId\\]/route.ts',
        'app/api/v1/pages/\\[pageId\\]/placement/route.ts',
        // Story MOTIR-9488 · MOTIR-9568 — its archive, restore, link and unlink
        // route files, held to the same floor.
        'app/api/v1/pages/\\[pageId\\]/archive/route.ts',
        'app/api/v1/pages/\\[pageId\\]/restore/route.ts',
        'app/api/v1/pages/\\[pageId\\]/work-items/route.ts',
        'app/api/v1/pages/\\[pageId\\]/work-items/\\[workItemId\\]/route.ts',
        'lib/plans/applySectionsInput.ts',
        'lib/services/sectionSchemaService.ts',
        // Story MOTIR-6016 · MOTIR-6102 — the three modules the DIFFICULTY story
        // added, pinned at the project floor in `thresholds` below after being
        // measured on this branch against the story's own specs.
        'lib/issues/difficulty.ts',
        'lib/hooks/useActivityRevision.ts',
        'components/issues/DifficultyPicker.tsx',
        // Story MOTIR-3440 · Subtask MOTIR-3449 — the two ARRIVAL PRIMITIVES this
        // story added. `PageSkeleton` is the wrapper/header/reveal every in-page
        // frame composes (MOTIR-3531); `SettingsPaneFrame` is the settings
        // family's pane frame, which all eleven settings panes mount (MOTIR-3558).
        // Both are pinned in `thresholds` below and both were MEASURED first, per
        // the note above: 100 statements / 100 branches / 100 functions / 100
        // lines apiece, on this branch.
        //
        // ⚠️ THE STORY'S SEVENTEEN CHANGED `page.tsx` FILES ARE NOT HERE, and
        // that is a stated gap rather than an oversight. They are async Server
        // Components: covering one in vitest means rendering it, and rendering it
        // means AWAITING it — which is the opposite of the pending state this
        // story is about. Their behaviour is asserted structurally instead
        // (`tests/navigation/*-arrival.test.ts`, 59 tests) and end to end.
        //
        // ⚠️ CORRECTED (MOTIR-3568) — THE REASON GIVEN HERE WAS "this repo has
        // no RSC render harness, so no `app/**/page.tsx` has ever been in this
        // report", AND BOTH HALVES WERE FALSE WHEN IT WAS WRITTEN. Six route
        // components were already in this list — `app/**/docs/page.tsx`,
        // `docs/api/page.tsx`, `docs/api/getting-started/page.tsx`,
        // `docs/api/stability/page.tsx`, `docs/sandbox/page.tsx` (all five also
        // GATED at 90/90/90 in `thresholds`) and `docs/layout.tsx` — and Story
        // 11.4 covered them by RENDERING them, with a `renderPageToHtml` helper
        // over `react-dom/server.edge` declared in three `tests/api-docs/*`
        // suites. Four `tests/planning/*` suites `await` a page and walk the
        // returned tree. The technique existed in seven files; what did not
        // exist was one place to find it and the request-scoped shims an AUTHED
        // page needs.
        //
        // The true statement is narrower and is now the one this file makes: no
        // page under `app/(authed)` had ever been in the report. Five of them
        // are, REPORT-ONLY, in the MOTIR-3568 block below, and the harness they
        // are covered by is `tests/helpers/serverPageHarness.tsx`. The seventeen
        // stay out until somebody measures them, which is this list's own rule
        // rather than a verdict about what is renderable.
        'components/ui/PageSkeleton.tsx',
        'components/settings/SettingsPaneFrame.tsx',
        // Story 8.9 (Follow the build) · Subtask 8.9.8 — the files this story
        // adds that carry LOGIC. MEASURED on this branch before being pinned,
        // per the note above.
        //
        // ⚠️ The story's `app/**` surfaces are NOT here, for the reason the
        // block above gives: the changelog page, the feed route, the two follow
        // landings and the two API routes are async Server Components and route
        // handlers, and this repo has no RSC render harness. They are asserted
        // through their services (`tests/publicProjects`), through the island's
        // own component test, and end to end by 8.9.9.
        'lib/publicProjects/followTokens.ts',
        'lib/publicProjects/changelogCursor.ts',
        'lib/publicProjects/atomFeed.ts',

        // Story 8.4 · Subtask MOTIR-1135 — capturing what a person agreed to and
        // asking again when a document MATERIALLY changes. MEASURED first, per
        // the note above: **100 statements / 100 branches / 100 functions / 100
        // lines on every one of these five files**, over `tests/legal/` on this
        // branch, so the floors below are a ratchet under a real number rather
        // than an aspiration.
        //
        // The surface earns a gate because what it enforces is a CLAUSE, not a
        // feature: `motir.co/legal/terms` §14 promises that non-material
        // changes take effect when published with no prompt, and `consent.ts`'s
        // MAJOR/MINOR-vs-PATCH rule is the whole of how that promise is kept. A
        // regression there is a broken published promise that no other test in
        // the tree would catch.
        //
        // ⚠️ `app/(auth)/re-consent/**` IS NOT HERE. Its two islands are covered
        // by `tests/components/reconsent-card.test.tsx` and its behaviour end to
        // end by MOTIR-1137, and nobody has measured the page itself.
        // (This note used to give the reason as "this repo has no RSC render
        // harness". That was false when written and is corrected in the
        // MOTIR-3449 block above; a harness now exists at
        // `tests/helpers/serverPageHarness.tsx`, so the page is a MEASURE-then-pin
        // candidate like any other file rather than an impossibility.)
        'lib/legal/consent.ts',
        'lib/legal/documents.ts',
        // MOTIR-4010 — where the three legal surfaces point once the documents are
        // configuration. Pinned with its siblings: a wrong answer here is a link
        // to a document nobody published, or a rail door that vanishes.
        'lib/legal/links.ts',
        'lib/legal/reconsentGate.ts',
        'lib/repositories/legalAcceptanceRepository.ts',
        // Story MOTIR-4669 · MOTIR-4684 — the repository-tenancy surface. Each
        // MEASURED on this branch before being pinned below, per the note above:
        // statements 96.61 / branches 85.56 / functions 100 / lines 98.35 across
        // the five together, with every remaining arm dispositioned on the card.
        'lib/services/organizationRepoService.ts',
        'lib/services/organizationAccessService.ts',
        'lib/settings/organizationSettingsNav.ts',
        // Story MOTIR-6167 · MOTIR-6315 — the org roles. The capability table and
        // the three org routes the story added are GATED below, each MEASURED on
        // this branch first against the story's own specs: capabilities 100 /
        // 100 / 100 / 100; ownership-transfer 95 / 83.33 / 100 / 94.44;
        // workspaces 94.44 / 90 / 100 / 93.75; workspaces/[workspaceId] 92.85 /
        // 83.33 / 100 / 91.66 (statements / branches / functions / lines). Each
        // route's residue is its unmapped-error rethrow.
        'lib/organizations/capabilities.ts',
        'app/api/organizations/**/ownership-transfer/route.ts',
        'app/api/organizations/**/workspaces/route.ts',
        'app/api/organizations/**/workspaces/*/route.ts',
        // ⚠️ REPORT-ONLY, deliberately: the three services the story changed most
        // are added to `include` but NOT to `thresholds`. Measured against the
        // story's specs alone they read organizationsService 80.88 / 77.08 / 90 /
        // 84.15, workspacesService 82.77 / 74.46 / 91.11 / 84.37 and billingService
        // 87.5 / 85.93 / 82.35 / 88.52 — every uncovered line in the STORY's own
        // diff is a defensive arm (a unique-violation mapping the service's own
        // guard pre-empts, the best-effort notification's failure paths). The
        // suite-wide number is CI's to publish; the pin belongs to whoever measures it.
        'lib/services/organizationsService.ts',
        'lib/services/workspacesService.ts',
        'lib/services/billingService.ts',
        'lib/mappers/organizationRepoMappers.ts',
        'lib/projectRepos/roomSections.ts',
        'lib/services/legalAcceptanceService.ts',
        // Story 8.4 · Subtask MOTIR-3698 — the data-subject-request SUBSTRATE
        // (account erasure + personal-data export). All three MEASURED at
        // 100/100/100/100 on this branch before being pinned, per the note at
        // the top of this block. The two windows and both repositories are what
        // 8.4.18-8.4.23 all read or write, so a regression here is a regression
        // in every slice above them.
        'lib/users/dataSubjectRequests.ts',
        'lib/repositories/accountDeletionRequestRepository.ts',
        'lib/repositories/dataExportRequestRepository.ts',
        // Story 8.4 · Subtask MOTIR-3700 — the schedule/cancel WRITE that sits on
        // that substrate, and the sign-in seam that cancels. Both MEASURED at
        // 100/100/100/100 on this branch before being pinned. They are gated for
        // the reason the substrate is: an account deletion is the most
        // destructive thing a reader can ask for, and the two arms a regression
        // would silently take out — the `P2002` translation and the best-effort
        // catch around the post-commit sign-out — are exactly the ones no
        // happy-path test exercises. (`lib/auth/accountDeletionCancellation.ts`
        // stood beside it until MOTIR-3742 removed the sign-in cancel.)
        'lib/services/accountDeletionService.ts',
        // Story 8.4 · Subtask MOTIR-3702 — the ERASURE SWEEP that acts on those
        // rows: the vocabulary, the service that performs the three DECISION 3
        // groups, and the cron definition that runs it. All three MEASURED at
        // 100/100/100/100 on this branch before being pinned, per the note at
        // the top of this block. Gated for a reason stronger than the two above
        // it: this is the only code in the product that makes
        // `motir.co/legal/privacy` §6's *"we erase or anonymise within 30
        // days"* true, and the arms a regression would take out silently — the
        // status re-read under the lock that makes a day-29 cancel stick, the
        // per-account catch that stops one failure holding the queue, the
        // organization block re-checked at erasure time — are exactly the ones
        // no happy-path test exercises. The job DEFINITION is included as well
        // (unlike `attachmentGc`, and like `codeGraphOffboardSweep`): a
        // retention sweep whose handler never runs is a window the product
        // states and never enforces.
        'lib/users/accountErasure.ts',
        'lib/services/accountErasureSweepService.ts',
        'lib/jobs/definitions/accountErasureSweep.ts',
        // Story MOTIR-6306 · MOTIR-6404 — the ORGANIZATION-DELETION lifecycle, the
        // org-tier twin of the account erasure above and gated for the same
        // reason: it is the only code that makes the DPA §10 thirty-day promise
        // and the seven-year billing retention true. MEASURED on this branch
        // against the story's own specs (tests/organizations/organization*,
        // tests/permissions/closingOrganization.test.ts and
        // tests/integration/organizations/organizationDeletionLifecycle.test.ts)
        // before being pinned below; two branch floors sit under 90 with their
        // reasons stated at the pin.
        'lib/organizations/deletion.ts',
        'lib/organizations/closingGuard.ts',
        'lib/repositories/organizationDeletionRequestRepository.ts',
        'lib/mappers/organizationDeletionMappers.ts',
        'lib/services/organizationDeletionService.ts',
        'lib/services/organizationDeletionNotifier.ts',
        'lib/services/organizationGitOffboardingService.ts',
        'lib/services/organizationErasureSweepService.ts',
        'lib/services/organizationRetentionPurgeService.ts',
        'lib/jobs/definitions/organizationDeletionReminders.ts',
        'lib/jobs/definitions/organizationErasureSweep.ts',
        'lib/jobs/definitions/organizationRetentionPurge.ts',
        'app/api/organizations/**/deletion/route.ts',
        'lib/repositories/publicFollowRepository.ts',
        'lib/services/publicFollowService.ts',
        'lib/services/publicFollowDigestService.ts',
        // Story MOTIR-2256 · Subtask MOTIR-2302 — the permission MODEL and its
        // enforcement seam. Every administrative gate in the product now routes
        // through these four files, and until this story they were not in the
        // coverage report at all, so the ≥90% per-file gate never applied to the
        // code that decides who may do what.
        //
        // ⚠️ REPORT-ONLY, deliberately: they are added to `include` but NOT to
        // `thresholds` below, so CI publishes the number without gating on one
        // nobody has measured. The honest sequence is measure first, then pin —
        // pinning a threshold blind is how a gate gets loosened later to make a
        // build pass, which is worse than not having it. The follow-up is to read
        // the number off the first CI run and add the four `thresholds` entries.
        // Story MOTIR-3414 · Subtask MOTIR-3426 — the Postgres job engine and the
        // three repositories it added. The story gate MEASURED every file before
        // pinning it below: 98.8 statements / 95.7 branches / 99.0 functions /
        // 99.7 lines over the set, with every FILE clearing 90 on all four axes.
        // Pinned at the project's 90 rather than at the measurement, so ordinary
        // churn does not fail the build while a real regression does.
        // Story MOTIR-1789 (Agent runs) — the DISPATCH RUN seam's own files, and
        // the point of naming them here is that until now NONE of the story's
        // surface was in the report at all, so the ≥90% per-file gate has never
        // applied to a line of it.
        //
        // ⚠️ NO LONGER REPORT-ONLY — MOTIR-1798 MEASURED THEM AND PINNED THEM,
        // which is the sequence the blocks above state. The numbers it read, over
        // the eleven suites that import these files (nothing else does, so that
        // is a COMPLETE measurement for them):
        //
        //   dispatchRunMappers          100 / 100 / 100 / 100
        //   dispatchRunRepository       100 / 100 / 100 / 100
        //   dispatchRunCardRepository   100 / 100 / 100 / 100
        //   dispatchRunEventRepository  100 / 100 / 100 / 100
        //   dispatchRunService          96.61 S / 90.71 B / 100 F / 96.15 L
        //
        // Two of them only reached those numbers because the measurement named
        // the gaps and tests were written for them: the repositories' CURSOR
        // arms had never once been taken (`skip: 1` is what stops a page
        // repeating its anchor row), and the service was at 87% branches until
        // its edges — a scope that resolves to nothing, a leg moving OFF
        // `skipped`, the event cap, a run with no events — were covered.
        // The floor was never lowered and nothing was excluded.
        'lib/services/dispatchRunService.ts',
        'lib/repositories/dispatchRun*.ts',
        'lib/mappers/dispatchRunMappers.ts',
        'lib/jobs/engine/**',
        'lib/repositories/jobQueueRepository.ts',
        'lib/repositories/jobStepRepository.ts',
        'lib/repositories/jobEventRepository.ts',
        // Story MOTIR-3758 · Subtask MOTIR-3766 — the story gate adopts the
        // platform-health service, which this story extended with the queue
        // backlog reading (`readQueueHealth`) that `/api/health/queue` serves.
        // It was NOT gated before, and a file an external monitor depends on is
        // exactly the wrong place for coverage to be nobody's business. MEASURED
        // on this branch over `tests/platform`: 100 statements / 95.45 branches /
        // 100 functions / 100 lines. Pinned at the project's 90, not at the
        // measurement, so ordinary churn does not fail the build.
        'lib/services/platformHealthService.ts',
        // Story MOTIR-736 (10.2) · gate MOTIR-744 — the three new provider readers
        // behind the system-health board. MEASURED on the parent branch over
        // `tests/deployment`, `tests/gateway`, `tests/monitoring` and `tests/platform`:
        // every file 100 lines / 100 functions, branches 91.4–100. Pinned at the
        // project's 90, as `platformHealthService.ts` above is.
        'lib/deployment/adapters/fly/flyMachinesStatus.ts',
        'lib/deployment/providers.ts',
        'lib/gateway/statusClient.ts',
        'lib/gateway/statusProvider.ts',
        'lib/monitoring/sentryErrorCount.ts',
        'lib/monitoring/errorCountProvider.ts',
        // Story MOTIR-3416 · Subtask MOTIR-3472 — the SCHEDULED cutover's own new
        // surface. `lib/jobs/engine/scheduler.ts` needs no entry: the glob above
        // is a glob precisely so a new engine file joins the gate without anyone
        // remembering, and the story gate measured it at 100/100/100.
        //
        // `catchUp.ts` is GATED (it measured 100 and is a const vocabulary, so
        // there is nothing for churn to erode). `defineJob.ts` is REPORT-ONLY —
        // added to `include`, deliberately NOT to `thresholds` — by the same rule
        // the two blocks below state: it measures 90.9 statements / 80 branches
        // over `tests/jobs/`, and the branches BELOW 90 are pre-existing arms of
        // the Inngest wrapper this story did not touch (this story's own change
        // RAISED it from 78). Pinning it at 90 now would mean covering someone
        // else's surface to land a scheduler; publishing the number is the honest
        // step, and the pin belongs to whoever owns that gap.
        'lib/jobs/catchUp.ts',
        'lib/jobs/defineJob.ts',
        'lib/permissions/**',
        'lib/services/projectAccessService.ts',
        // Story MOTIR-2765 · Subtask MOTIR-2771 — the acceptance-receipt freeze.
        // Same finding as the block above, on a different surface: the evidence
        // service, its repository and its typed errors were NOT in the coverage
        // report at all, so the ≥90% per-file gate never applied to the code that
        // decides whether a human's approval can be overwritten. MOTIR-2764 put a
        // refusal there; this makes the number visible.
        //
        // ⚠️ REPORT-ONLY for the same reason and by the same rule: added to
        // `include`, deliberately NOT to `thresholds`, so CI publishes a number
        // nobody has measured yet rather than pinning one blind. Read it off the
        // first CI run and pin then — `tests/coverage-gate-globs.test.ts` fails
        // the build on a key that reaches no file, so the pin cannot be vacuous.
        'lib/acceptanceEvidence/**',
        'lib/services/acceptanceEvidenceService.ts',
        'lib/repositories/acceptanceEvidenceRepository.ts',

        // Story MOTIR-2554 · Subtask MOTIR-2558 — the shell's CONTEXT PATH.
        // `ShellTierNav` decides which tiers a person sees at which width (the
        // ladder in `design/shell/design-notes.md` § *The context row*) and
        // `ProjectTier` decides which of three states the last tier is in. Both
        // are new decision code on the one row every authed screen renders, and
        // neither was in the report before this story. `TopNav` joins them
        // because it is the host whose props the two now depend on.
        //
        // The glob form is the `app/**/…` one for the reason the block comment
        // above gives: a literal `app/(authed)/…` key matches no reported file
        // and would gate nothing.
        'app/**/_components/ShellTierNav.tsx',
        'app/**/_components/ProjectTier.tsx',
        'app/**/_components/TopNav.tsx',

        // Story MOTIR-2258 · Subtask MOTIR-2476 — the permission-gated shell.
        // The two registries are the load-bearing new code (one decides which
        // settings rooms exist for an actor, the other which nav destinations
        // do), and the guard that refuses a hidden destination is the file that
        // keeps hiding from becoming the whole story. GATED, not report-only:
        // all three are new in this story, so there is no pre-existing number to
        // pin blind.
        //
        // ⚠️ WRITTEN WITH `app/**/`, NOT `app/(authed)/` — a route group's
        // parentheses are extglob syntax to the matcher v8 globs with, so a
        // literal path matches nothing and the file silently never enters the
        // report (MOTIR-2449; `tests/coverage-gate-globs.test.ts` fails the build
        // on any pattern that reaches nothing).
        'lib/settings/projectSettingsNav.ts',
        'lib/settings/projectNavAccess.ts',
        'app/**/_components/ProjectAccessProvider.tsx',

        // Story MOTIR-3878 · Subtask MOTIR-4223 — customer-owned addresses, the
        // whole surface the story's ten motir-core cards added. MEASURED first
        // and pinned below, the sequence this block follows everywhere.
        //
        // ⚠️ `app/**/`, NOT `app/(authed)/`, for the reason the block above
        // records: a route group's parentheses are extglob syntax to the
        // matcher, so a literal path matches nothing and the file silently never
        // enters the report.
        'lib/publicAddresses/**',
        'lib/repositories/publicAddressRepository.ts',
        'lib/services/publicSubdomainService.ts',
        'lib/services/customDomainService.ts',
        'lib/services/publicAddressesService.ts',
        'lib/services/publicAddressCertificatesService.ts',
        'lib/jobs/definitions/publicAddressCertificateRefresh.ts',
        'app/api/public/hosts/**/route.ts',
        'app/api/workspaces/**/public-subdomain/route.ts',
        'app/api/projects/**/public-addresses/**/route.ts',
        'app/**/settings/project/public-address/_components/*.tsx',

        // Story MOTIR-1215 · Subtask MOTIR-3646 — the require-2FA control and
        // its Server Action. MEASURED at 100/100/100/100 each before being
        // pinned below, the sequence this block follows everywhere.
        //
        // ⚠️ THE PAGE ITSELF IS NOT HERE, and that is the family's stated gap
        // rather than an omission: no `app/**/page.tsx` has ever entered this
        // report (an async Server Component would have to be awaited to be
        // covered, and this repo has no RSC render harness). Its behaviour is
        // asserted structurally in `tests/navigation/settings-workspace-org-arrival.test.ts`
        // and by the route SMOKE in `tests/components/org-security-pane.test.tsx`.
        //
        // The COMPONENT is the piece worth gating: MOTIR-3647 mounts this same
        // file at the workspace tier, so a regression here breaks two surfaces.
        // Story MOTIR-3808 · Subtask MOTIR-3816 — the to-do list's whole
        // surface, measured before being pinned below.
        //
        // ⚠️ THE TWO `app/` ENTRIES ARE `app/**`, NOT THEIR LITERAL PATHS. They
        // live under `app/(authed)/items/[key]/`, and `(` is GROUPING SYNTAX to
        // picomatch — the literal path matches no file, the entry gates nothing,
        // and the threshold beside it passes vacuously (MOTIR-2449, the note at
        // the head of this block). Measured through the `app/**` form:
        // TodoListSection 99.35 / 90.58 / 100 / 100, and the service+repository+
        // mapper+DTO group 98.58 / 94.59 / 100 / 98.40.
        'lib/repositories/workItemTodoRepository.ts',
        'lib/services/workItemTodosService.ts',
        'lib/dto/workItemTodos.ts',
        'lib/mappers/workItemTodoMappers.ts',
        'lib/workItemTodos/limits.ts',
        'lib/workItemTodos/errors.ts',
        'app/**/items/[key]/todoActions.ts',
        'app/**/items/[key]/_components/TodoListSection.tsx',
        // Story MOTIR-5542 · Subtask MOTIR-5548 — the PLAN HISTORY section, the route
        // behind its Show more, and the mapper that shapes its rows. Measured first
        // against the story's own specs (`planHistoryRead`, `planHistoryStoryGate`,
        // `plan-history-section`, `plan-history-catalog`): PlanHistorySection
        // 92.66 / 90.82 / 100 / 93.68 (its three uncovered `never` arms are
        // unreachable by construction), the route 100 / 100 / 100 / 100, the mapper
        // 100 / 100 / 100 / 100 (stmts/branches/funcs/lines).
        //
        // ⚠️ `plansService`, `planItemRepository`, `planRepository`, `lib/plans/errors`
        // and `approveRefusals` are ALSO story-changed and deliberately NOT here: each
        // is a shared file whose other methods belong to other stories (measured
        // 38–48% from these specs), so a per-file threshold would make this story
        // cover code it did not write. The story's methods in them are held by
        // `planHistoryRead` and `planHistoryStoryGate` instead. The page wiring is an
        // async Server Component, asserted structurally by `item-detail-reads`.
        'app/**/items/[key]/_components/PlanHistorySection.tsx',
        'app/api/work-items/**/plans/route.ts',
        'lib/mappers/planMappers.ts',
        'app/**/_components/RequireTwoFactorCard.tsx',
        'app/**/organization/security/actions.ts',
        // Story MOTIR-1215 · Subtask MOTIR-3647 — the workspace tier's action and
        // the fold-in that gained the control's SECOND home. Measured at
        // 100/100/100/100 apiece before pinning.
        'app/**/workspace/security/actions.ts',
        'app/**/_components/WorkspaceFoldInSection.tsx',
        // Story MOTIR-4843 · Subtask MOTIR-4848 — the workspace-settings AREA,
        // and the FOURTH fold-in beside the one above. Measured on this branch
        // before pinning, `--coverage.include` through the `app/**` form:
        //
        //   workspaceSettingsNav.ts     93.33 / 91.66 / 100 / 100
        //   WorkspaceSidebarHeader.tsx  100   / 100   / 100 / 100
        //   WorkspaceSwitcher.tsx        40   /  61.11/  26.66 / 40.42
        //
        // The registry's one uncovered line is its `if (!entry.href)` guard, an
        // arm no entry reaches. The HEADER measured 90 / **60** / 100 / 90 first
        // — under the branch floor because its COLLAPSED arm and its `'?'`
        // initial fallback were undriven — and MOTIR-4848 wrote the four missing
        // cases rather than pinning three axes and leaving the fourth off, which
        // is the remedy this list's own rule prescribes (MOTIR-4368's precedent
        // on `SidebarNav`). Both are GATED in `thresholds` below.
        //
        // ⚠️ `WorkspaceSwitcher.tsx` IS REPORT-ONLY, deliberately — it is in this
        // list and NOT in `thresholds`. This story added one row to it and the
        // spec that drives that row; the 60% it does not reach is the
        // create-workspace modal, the switch handler and their toast paths —
        // pre-existing behaviour no card here touched. Pinning it at the
        // measured number would put a 40 in a list whose floor is 90, and
        // pinning it AT 90 would fail the build for work this story did not
        // undertake. It publishes a number until a card owns the gap.
        'lib/settings/workspaceSettingsNav.ts',
        'app/**/_components/WorkspaceSidebarHeader.tsx',
        'app/**/_components/WorkspaceSwitcher.tsx',
        // ⚠️ `app/**/settings/workspace/layout.tsx` is NOT here. It is an async
        // Server Component whose whole body is a session check and a redirect,
        // and this repo has no RSC render harness — the same reason the settings
        // PAGE files above it stay out. Its behaviour is asserted structurally,
        // by the area rail's specs and by the route's own 404 arm.
        // Story MOTIR-1215 · Subtask MOTIR-3648 — the enforcement gate and the
        // screen it holds people at. Measured at 100/100/100/100 apiece.
        'lib/auth/twoFactorGate.ts',
        // Story MOTIR-1215 · Subtask MOTIR-3653 — the API half of the same gate,
        // and the module ~190 route files now authenticate through. Measured at
        // 100/100/100/100 before pinning.
        'lib/auth/requireCompliantSession.ts',
        'app/**/two-factor-required/page.tsx',
        'app/**/two-factor-required/_components/SignOutLink.tsx',
        // …and the island that tells the server gate to look again once a
        // second factor lands. Without it the satisfied panel above is
        // unreachable and a person who enrols stays held. Measured at
        // 100/100/100/100.
        'app/**/two-factor-required/_components/HeldEnrolment.tsx',
        // ⚠️ `_guard.tsx` is REPORT-ONLY (below `thresholds`), and the reason is
        // worth stating rather than quietly omitting: MOTIR-2476 measured it at
        // 50% lines, and the uncovered half is `guardSettingsPage`'s body — one
        // service round trip and two translation lookups, reachable only with a
        // database. Its DECISION (`resolveSettingsRefusal`) and its RENDER
        // (`SettingsRefusalState`) were split out for exactly this reason and are
        // both fully covered. Pinning 90 here would either gate on a number the
        // unit suite cannot reach, or invite mocking the access service in a
        // component test — and the repo's rule is one mock, `getSession`. The
        // honest sequence is the one this file already follows twice above:
        // measure first, publish the number, pin it when the DB-backed arm lands.

        // Story MOTIR-2282 · Subtask MOTIR-2264 — the Roles & permissions
        // screens and the read behind them. The two files above were already
        // report-only; these are the surface THIS story added or widened, and
        // the four that are new code are GATED in `thresholds` below.
        //
        // ⚠️ `lib/repositories/projectMembershipRepository.ts` is REPORT-ONLY on
        // purpose, exactly like `projectAccessService.ts`: this story added one
        // method to a file most of which predates it, and pinning the whole file
        // at 90% would gate code no card here wrote or tested. Measuring it is
        // the honest first step; the pin belongs to whoever owns that surface.
        'lib/mappers/permissionMappers.ts',
        'lib/settings/projectSettingsNav.ts',
        'lib/repositories/projectMembershipRepository.ts',
        // ⚠️ WRITTEN WITH `app/**/`, NOT `app/(authed)/`, AND THAT IS LOAD-BEARING.
        // A route-group segment's parentheses are extglob syntax to the matcher
        // v8 coverage globs with, so a LITERAL `app/(authed)/…` path matches
        // nothing and the file silently never enters the report. Measured on this
        // branch: the same four files enter it under `app/**/…` and are absent
        // under `app/(authed)/…`. See MOTIR-2449 — four component thresholds
        // already in this file are keyed the literal way and are therefore inert.
        'app/**/settings/workspace/roles/_components/*.tsx',

        // Story MOTIR-2257 · Subtask MOTIR-2486 (the story gate) — the custom-role
        // WRITE surface. `lib/permissions/**` above already reported the policy
        // modules; these are the service, the repository and the two route
        // handlers this story added, and all four are GATED below.
        //
        // ⚠️ WRITTEN WITH `**`, NOT A LITERAL `[key]`, FOR THE SAME REASON THE
        // ROUTE-GROUP NOTE ABOVE GIVES — and it is a DIFFERENT syntax biting: in
        // a glob, `[key]` is a CHARACTER CLASS matching one of `k`/`e`/`y`, so a
        // literal `app/api/projects/[key]/roles/route.ts` names a directory
        // called `k`. `tests/coverage-gate-globs.test.ts` fails the build on
        // either mistake rather than passing vacuously.
        // (The project-role-definition service and repository were retired by
        // Story MOTIR-6168 · MOTIR-6466 — the grantable-key rule they carried
        // now lives in `lib/permissions/grantable.ts`, gated by the glob above.)
        'app/api/projects/**/roles/route.ts',
        'app/api/projects/**/roles/**/route.ts',

        // Story MOTIR-6168 · Subtask MOTIR-6467 (the story gate) — the files the
        // workspace-roles story ADDED: the workspace custom-role service, its
        // repository and mapper, the migration report's service and repository,
        // the role error mapping, the three workspace role routes, the Members
        // page's migration notice and the org fold-in's Roles door. (The moved
        // Roles screens are the `settings/workspace/roles/_components` glob
        // above; the grantable-key rule and the room keys are under
        // `lib/permissions/**`.) All `app/**` and `**` for the two reasons the
        // notes above give. Pinned below.
        'lib/services/workspaceRoleDefinitionService.ts',
        'lib/services/roleMigrationReportService.ts',
        'lib/repositories/workspaceRoleDefinitionRepository.ts',
        'lib/repositories/roleMigrationReportRepository.ts',
        'lib/mappers/workspaceRoleMappers.ts',
        'lib/workspaces/roleErrorResponse.ts',
        'app/api/workspaces/**/roles/route.ts',
        'app/api/workspaces/**/roles/**/route.ts',
        'app/api/workspaces/**/members/**/route.ts',
        'app/**/settings/workspace/_components/RoleMigrationNotice.tsx',
        'app/**/settings/organization/_components/RolesDoorCard.tsx',

        // Story 5.7 (in-app notifications) · Subtask 5.7.6 — the per-user
        // notification-preference layer (the channel gate) lands gated.
        'lib/services/notificationPreferencesService.ts',
        'lib/repositories/notificationPreferenceRepository.ts',
        'lib/mappers/notificationPreferenceMappers.ts',
        'lib/notifications/preferences.ts',
        // Story 5.7 · Subtask 5.7.7 — the in-app model + fan-in + read/mark API
        // service/repo/job logic (5.7.2–5.7.4) joins the gate, completing the
        // story's coverage contract (the 5.7.6 preference layer is gated above).
        'lib/repositories/notificationRepository.ts',
        'lib/services/notificationsService.ts',
        'lib/services/notificationFanInService.ts',
        'lib/jobs/definitions/notificationFanIn.ts',
        'lib/notifications/errors.ts',
        'lib/services/workItemsService.ts',

        // Bug MOTIR-3050 — the blocker-readiness classifier, LIFTED OUT of
        // `workItemsService` (gated just above) so `plansService.materialize`
        // can reach the same rule when it chooses a materialized add's birth
        // status. Moving gated code into an ungated file would have quietly
        // dropped it out of the report, so it is re-entered here and pinned at
        // the same 90 the file it came from carries. Measured on this branch
        // before pinning: 100 lines / 100 functions / 100 branches.
        'lib/workItems/blockerReadiness.ts',
        // ⚠️ ADDED BY THE STORY GATE (MOTIR-3001 · MOTIR-3200). The ready
        // FILTER shape has never been in the report at all — not gated at a low
        // number, absent — which is the state this config's own header calls
        // out: "the file then never enters the report, and a `thresholds` key
        // naming it is a key nobody checks." MOTIR-3196 put two new axes, a
        // reserved literal and a typed refusal in it, so it is entered and
        // pinned here. Measured on this branch before pinning, over
        // `tests/ready/` + the two ready route/vocabulary files:
        // 95.83 lines / 100 functions / 93.33 branches.
        'lib/workItems/readyFilter.ts',
        'lib/services/backlogService.ts',
        'lib/repositories/workItemRepository.ts',
        'lib/repositories/workItemLinkRepository.ts',
        'lib/repositories/workItemRevisionRepository.ts',
        'lib/services/workflowsService.ts',
        'lib/repositories/workflowsRepository.ts',
        'lib/services/reportsService.ts',
        'lib/mappers/reportsMappers.ts',
        'lib/repositories/sprintRepository.ts',
        'components/ui/charts/scale.ts',
        'components/ui/charts/LineChart.tsx',
        'components/ui/charts/BarChart.tsx',
        'components/ui/charts/ChartFrame.tsx',
        'components/ui/charts/ChartLegend.tsx',
        'components/ui/charts/ChartDataTable.tsx',
        // Story MOTIR-8919 · MOTIR-8930 — the refined reports' new modules (the help
        // text and its hide preference, the Workload and Velocity range controls, the
        // Sprint report picker, the page-mode chart frame and its label fitting).
        // MEASURED on this branch against the story's own specs plus
        // `reportsRefinedBranches.test.tsx`, then pinned at the project floor in
        // `thresholds` below. Route-group and dynamic-segment files are spelled the
        // MOTIR-2449 way (`app/**/…`, brackets escaped).
        'app/**/reports/_components/ReportHelp.tsx',
        'app/**/reports/_components/ReportWindowControls.tsx',
        'app/**/reports/_components/VelocityRangeControls.tsx',
        'app/**/sprints/\\[id\\]/report/_components/SprintReportSprintPicker.tsx',
        'components/ui/charts/ChartFrameSvg.tsx',
        'components/ui/charts/PageChartFrame.tsx',
        'components/ui/charts/HBarChartPage.tsx',
        'components/ui/charts/HBarChartView.tsx',
        'components/ui/charts/fitXTicks.ts',
        'components/ui/charts/useChartWidth.ts',
        'lib/hooks/useReportHelpHidden.ts',
        'lib/reports/sprintPicker.ts',
        // Story MOTIR-2542 · Subtask MOTIR-2550 — the AI entitlement predicates.
        // Two one-line pure functions, and the reason they are gated is that the
        // defect they fix was a surface reading a raw DTO field instead of
        // asking them. Gated in `thresholds` below.
        'lib/billing/aiEntitlement.ts',
        'lib/repositories/commentRepository.ts',
        'lib/repositories/commentMentionRepository.ts',
        'lib/services/commentsService.ts',
        'lib/mappers/commentMappers.ts',
        'lib/mentions/parse.ts',
        // Story 5.4 labels/components/watchers (5.4.1) — the five data-access
        // leaves ship gated from day one; the services join in 5.4.2–5.4.4.
        'lib/repositories/labelRepository.ts',
        'lib/repositories/workItemLabelRepository.ts',
        // 5.4.2 — the folksonomy service layer.
        'lib/services/labelsService.ts',
        'lib/mappers/labelMappers.ts',
        'lib/repositories/componentRepository.ts',
        'lib/repositories/workItemComponentRepository.ts',
        'lib/repositories/watcherRepository.ts',
        'lib/services/activityService.ts',
        'lib/activity/renderers.ts',
        'lib/mappers/activityMappers.ts',
        // Story 5.3 custom fields — the three data-access leaves (5.3.1) +
        // the definitions half of the service and its mappers (5.3.2); the
        // values half (5.3.3) extends the same service file under this gate.
        'lib/repositories/customFieldDefinitionRepository.ts',
        'lib/repositories/customFieldOptionRepository.ts',
        'lib/repositories/customFieldValueRepository.ts',
        'lib/services/customFieldsService.ts',
        'lib/mappers/customFieldMappers.ts',
        // Story 5.2 (attachments): the service joins the gate with 5.2.7's
        // orphan-GC sweep (the 2.3.7 upload half already carries its tests);
        // the repo leaf + the panel mapper join with 5.2.2's management
        // surface.
        'lib/services/attachmentsService.ts',
        'lib/repositories/attachmentRepository.ts',
        'lib/mappers/attachmentMappers.ts',
        // Story 6.2 (saved filters): the persistence + permission layer
        // (Subtask 6.2.1) gates from day one — the matrix, the envelope
        // round-trip, and the degraded-state branches are the contract.
        'lib/services/savedFiltersService.ts',
        'lib/repositories/savedFilterRepository.ts',
        'lib/repositories/savedFilterStarRepository.ts',
        'lib/mappers/savedFilterMappers.ts',
        'lib/savedFilters/access.ts',
        'lib/savedFilters/builtins.ts',
        // Story 6.3 (dashboards): the grid substrate (Subtask 6.3.1) gates
        // from day one — the TOTAL widget registry, the permission rule,
        // the cap, and the move ordering are the contract.
        'lib/services/dashboardsService.ts',
        'lib/repositories/dashboardRepository.ts',
        'lib/repositories/dashboardWidgetRepository.ts',
        'lib/mappers/dashboardMappers.ts',
        'lib/dashboards/widgetRegistry.ts',
        // Story 6.3 (dashboards & reports): the 6.3.2 widget/report data
        // reads — the statistic-type registry, the window/bucket math, and
        // the route param parsers gate from day one (the service / repo /
        // mapper halves extend already-gated files above).
        'lib/reports/statisticTypes.ts',
        'lib/reports/buckets.ts',
        'lib/reports/params.ts',
        // Story 6.6 (automation rules): the 6.6.1 schema/registry/service
        // backend gates from day one — the TOTAL trigger/action registries,
        // the admin-gated CRUD + caps, the stored-envelope round-trip, and the
        // condition degraded-state branch are the contract (no engine yet —
        // 6.6.2).
        'lib/automation/registry.ts',
        'lib/automation/fields.ts',
        'lib/automation/constants.ts',
        'lib/services/automationRulesService.ts',
        'lib/repositories/automationRuleRepository.ts',
        'lib/mappers/automationRuleMappers.ts',
        // 6.6.2 — the execution engine + its audit-row leaf join the gate.
        'lib/services/automationEngineService.ts',
        'lib/repositories/automationRuleExecutionRepository.ts',
        // Story 7.8 (MCP server) · Subtask 7.8.1 — the PAT auth substrate
        // every other 7.8 subtask rides gates from day one: the create/verify/
        // revoke lifecycle, the secret-never-persisted fence, and the
        // last-used throttle are the contract. (7.8.9 extends the gate to the
        // MCP registry + tool modules.)
        'lib/services/apiTokensService.ts',
        'lib/repositories/apiTokenRepository.ts',
        'lib/mappers/apiTokenMappers.ts',
        'lib/apiTokens/token.ts',
        'lib/apiTokens/errors.ts',

        // Story MOTIR-2572 · Subtask MOTIR-2585 (the story gate) — what a token
        // GRANTS, and the surfaces that offer and render it. This story replaced
        // the six 7.7-era scope strings with the MOTIR-2254 permission catalog,
        // and none of the code that does it was in the coverage report before.
        //
        // GATED, not report-only: every file here is new in this story (or, for
        // `scopes.ts`, reduced to the legacy-expansion table this story wrote),
        // so there is no pre-existing number that a 90 would retroactively
        // gate — the honest-sequence caveat the blocks above give does not
        // apply. All eight were MEASURED at or above the floor before being
        // pinned; the lowest is `CreateTokenModal.tsx` at 90.9% branches.
        //
        // ⚠️ `app/**/`, NOT `app/(authed)/` — the route-group parentheses are
        // extglob syntax to the matcher, so a literal path silently matches
        // nothing (MOTIR-2449).
        'lib/tokens/grant.ts',
        'lib/mcp/toolPermissions.ts',
        'lib/mcp/permissionGate.ts',
        'lib/mcp/scopes.ts',
        // Bug MOTIR-3342 — the UNKNOWN-ARGUMENT gate at the same registration
        // seam as `permissionGate.ts` above, and gated on the same terms. It
        // decides whether an argument a caller mis-spelled is refused or
        // silently deleted, which is exactly the kind of decision that must not
        // ship un-measured: the defect it fixes lost three cards' whole bodies
        // under a success line. MEASURED on this branch before pinning.
        'lib/mcp/strictInput.ts',
        // Story MOTIR-6974 · Subtask MOTIR-7003 — the tool HINTS: the table and
        // its registration seam (a wrong `readOnlyHint: true` lets Claude run a
        // write without asking), and the two files that carry each tool's title
        // and hints into the published catalogue (`lib/apiDocs/mcp.ts` and the
        // generator that writes its leaf). MEASURED on this branch before
        // pinning: 100 / 100 / 100 for the table and the content module, and
        // 100 lines / 100 branches / 92.3 functions for the generator.
        'lib/mcp/toolAnnotations.ts',
        'lib/apiDocs/mcp.ts',
        'scripts/generateMcpToolSchemas.ts',
        'app/**/settings/account/_components/permissionMeta.tsx',
        'app/**/settings/account/_components/CreateTokenModal.tsx',
        'app/**/settings/account/_components/apiTokensClient.ts',
        // Story 7.2 (AI infrastructure) · Subtask 7.2.11 — the org cost
        // dashboard read service: the 6.10.4 access gate + the server-side
        // scope narrowing (an admin's validated drill, a member locked to
        // their own project slice) are the no-leak contract. Locked by 7.2.12.
        'lib/services/aiUsageService.ts',
        // Story 7.7 (Motir MCP server) · Subtask 7.7.12 — the story-closing
        // suite extends the gate to the MCP tool surface: the registry and every
        // tool module. (The shared field-schema / summary / normalize helpers
        // under `tools/` — workItemRef / sprintRef / readyFilters — are NOT tool
        // modules and stay ungated.) `tests/mcp/story-roundtrip` drives them over
        // the real `/api/mcp` transport; `tests/mcp/tool-coverage` walks the
        // per-tool summary / edge branches.
        // Story 11.6 · Subtask 11.6.2 (MOTIR-2228) — the payload SEAM: the brand
        // that makes `toolOk` refuse an underived payload, the exemption +
        // migration registries, the derived shared-resource set, and the
        // work-item payload shapes. Gated from the start: an ungated new module
        // is exactly the invisible member the seam exists to make impossible.
        'lib/mcp/payloads/brand.ts',
        'lib/mcp/payloads/define.ts',
        'lib/mcp/payloads/exemptions.ts',
        'lib/mcp/payloads/sharedResources.ts',
        'lib/mcp/payloads/workItems.ts',
        // Subtask 11.6.4 (MOTIR-2230) — the project / sprint / identity family.
        'lib/mcp/payloads/planning.ts',
        // Subtask 11.6.5 (MOTIR-2231) — the work-loop family + the seal.
        'lib/mcp/payloads/workLoop.ts',
        // Subtask 11.6.6 (MOTIR-2232) — the drift guard + the tool→payload map.
        'lib/mcp/payloads/driftGuard.ts',
        'lib/mcp/payloads/registry.ts',
        // Story MOTIR-2284 · Subtask MOTIR-2289 — the Children panel's List ↔
        // Graph switcher. (`WorkItemRoadmap`, the adapter it mounts, is already
        // gated above.)
        // Story MOTIR-2560 — the editable quick-view rail. Every file the story
        // ADDED or made a write surface, entered as `app/**/…` because a literal
        // `app/(authed)/…` reaches no file (MOTIR-2449) and would gate nothing.
        'app/**/items/_components/QuickViewRailEdit.tsx',
        'app/**/items/_components/fieldChipEditing.ts',
        'app/**/items/_components/customFieldEditing.tsx',
        'app/**/items/_components/IssueQuickViewPanel.tsx',
        // Story MOTIR-4181 — the proposal peek's own two files. Added to
        // `include` and deliberately NOT to `thresholds`, by this config's own
        // rule: the number comes off the first CI run, and pinning a floor
        // before measuring one is how a gate ends up asserting a guess.
        'components/planning/ProposalPeek.tsx',
        'components/workItems/ProposalPeekMarks.tsx',
        'app/**/items/_components/IssueQuickViewController.tsx',
        // The SHARED pager (Story MOTIR-4850 · MOTIR-4853). It is mounted by
        // three surfaces now — `/items`, `/items/archived` and the Workbench —
        // and MOTIR-4853 translated it IN PLACE, so a regression in it reaches
        // all three. It was not gated before that card; measured on this branch
        // with `tests/components/issue-list-pager.test.ts` and its two
        // consumers' suites: 100 statements / 100 branches / 100 functions /
        // 100 lines.
        'app/**/items/_components/IssueListPager.tsx',
        // …and the SEAM the payload widening landed in. `workItemsService.ts`
        // (the other half) is already included + gated above.
        'lib/mappers/quickViewMappers.ts',
        // Story MOTIR-5308 · MOTIR-5317 — the folder surface this story ADDED.
        // Measured on the story branch with the folder suites before pinning (the
        // before/after figures are in the story PR body), then gated below.
        'lib/repositories/folderRepository.ts',
        'lib/services/foldersService.ts',
        'lib/mappers/folderMappers.ts',
        'lib/folders/errors.ts',
        'components/folders/FolderCommands.tsx',
        'components/folders/FolderDeleteDialog.tsx',
        'components/folders/FolderNameField.tsx',
        'components/folders/FolderPicker.tsx',
        'components/folders/FolderRowMenu.tsx',
        'app/**/items/_components/QuickViewFolderField.tsx',
        // Story MOTIR-5309 · MOTIR-5379 — the item page's placement channel and its
        // breadcrumb: two new files and the one they rewrote. Measured with the
        // placement suites before pinning (the figures are in the story PR body).
        'app/**/items/[key]/_components/PlacementProvider.tsx',
        'app/**/items/[key]/_components/PlacementBreadcrumb.tsx',
        'app/**/items/[key]/_components/ParentBreadcrumb.tsx',
        'app/**/items/[key]/_components/ChildPanel.tsx',
        'app/**/items/[key]/_components/ChildList.tsx',
        'lib/mcp/registry.ts',
        'lib/mcp/tools/getWorkItem.ts',
        'lib/mcp/tools/listReady.ts',
        'lib/mcp/tools/nextReady.ts',
        'lib/mcp/tools/createWorkItem.ts',
        'lib/mcp/tools/transitionStatus.ts',
        'lib/mcp/tools/addComment.ts',
        'lib/mcp/tools/searchWorkItems.ts',
        'lib/mcp/tools/whoami.ts',
        'lib/mcp/tools/listProjects.ts',
        'lib/mcp/tools/listSprints.ts',
        'lib/mcp/tools/validateSprint.ts',
        // Work-item finishability — the tool, plus the shared loose/tight
        // predicate both validators use (Subtask 7.8.23).
        'lib/mcp/tools/validateWorkItem.ts',
        'lib/workItems/validity.ts',
        // Story MOTIR-3093 · Subtask MOTIR-3095 — the PROJECTED validity mode.
        // The new plan-level tool and the shared `planId` / temp-ref plumbing
        // both validators and (MOTIR-3096) the projected reads address a plan
        // through. Both MEASURED before being pinned, on this branch, with
        // `tests/mcp/validate-plan.test.ts`: 100 / 100 / 100 each.
        'lib/mcp/tools/validatePlan.ts',
        'lib/mcp/tools/planRef.ts',
        // Subtask MOTIR-3096 — the PROJECTION itself, lifted out of
        // `planValidityService` when the projected READS became its second
        // consumer. Gated on its own because it is now the ONE place a plan is
        // merged into a live tree: a regression here changes what BOTH the
        // validity verdicts and the reads answer, and blended into the validity
        // service's number it would be invisible.
        'lib/services/planProjectionService.ts',
        // Story MOTIR-6352 · MOTIR-6373 — the off-level edge DISPOSITION, the one
        // place the validators' verdict becomes a drawing decision for BOTH
        // canvases (the roadmap read and the plan review). A branch here that no
        // test reaches is a canvas flag nobody checked against the validator.
        'lib/workItems/edgeDisposition.ts',
        // Bug MOTIR-3123 — the FINISHABILITY engine itself. It was in neither
        // half of this config until now, so the ≥90%-per-file gate had never
        // applied to the file that answers "can this plan be finished?" — the
        // check `generate_tree` runs as its pre-commit post-condition, the one
        // the three §4 `validate-plan*` routes expose, and (MOTIR-3095) the one
        // a PAT can reach. A gate never pointed at a file is indistinguishable
        // from one that passes: nothing goes red and no number looks wrong.
        // MEASURED FIRST and GATED in `thresholds` below — see the numbers and
        // the suite set there.
        'lib/services/planValidityService.ts',
        // The PROSE-vs-GRAPH advisory beside those rules (MOTIR-1969) — the pure
        // reference/severity extractor and the service that resolves + gates it.
        'lib/workItems/proseVsGraph.ts',
        'lib/services/proseGraphAdvisoryService.ts',
        // Its PATH arm (MOTIR-5424) — the pure path extraction + resolution
        // verdict, and the service that finds the second namer, the ordering and
        // asks the host. Measured first: 98.5 / 97.9 and 97.8 / 93.8 (stmts /
        // branches) on this branch.
        'lib/workItems/pathReference.ts',
        'lib/services/pathReferenceAdvisoryService.ts',
        // The repository SET's per-repo DELIVERY classifier and its one shared
        // field component (Story MOTIR-2725 · MOTIR-2417). Gated on their own
        // because they are the seam the completion gate and BOTH surfaces read:
        // a regression here makes the panel disagree with the gate, and blended
        // into workItemsService's number it would be invisible.
        'lib/workItems/repoDelivery.ts',
        'components/workItems/RepositorySetField.tsx',
        // The repository REFERENCE's data-access leaf (Story MOTIR-2732 ·
        // MOTIR-3039). Gated on its own for the same reason `repoDelivery.ts`
        // above is: it is the ONE place a card's repositories are read and
        // written, so a regression here moves where an agent is dispatched, and
        // blended into `workItemsService`'s number it would be invisible.
        'lib/repositories/workItemRepoRepository.ts',
        // The PROJECT repository set on the planning-job envelope (MOTIR-3044).
        // Gated on its own because it is a CROSS-REPO contract: the consumer is in
        // motir-ai, so a regression here is invisible from this side until a plan
        // comes back unpinned.
        'lib/ai/projectRepoContext.ts',
        'lib/mcp/tools/createSprint.ts',
        'lib/mcp/tools/updateSprint.ts',
        'lib/mcp/tools/deleteSprint.ts',
        'lib/mcp/tools/moveToSprint.ts',
        'lib/mcp/tools/moveToBacklog.ts',
        'lib/mcp/tools/startSprint.ts',
        'lib/mcp/tools/completeSprint.ts',
        'lib/mcp/tools/markIntegrated.ts',
        'lib/mcp/tools/completeSession.ts',
        'lib/mcp/tools/linkWorkItems.ts',
        // Story MOTIR-3525 · Subtask MOTIR-3526 — the pull-request LINK door. In
        // the gate from the start: an ungated new tool module is exactly the
        // invisible member the 7.7.12 sweep put every other one here to prevent.
        // `tests/mcp/linkPullRequest` walks the adapter's arms (both address
        // forms, the disagreement refusal, the two write paths, the tenancy
        // refusals) and `tests/mcp/linkPullRequestTransport` drives it over the
        // real `/api/mcp` transport, which is what covers `registerLinkPullRequest`.
        'lib/mcp/tools/linkPullRequest.ts',
        'lib/mcp/tools/updateWorkItem.ts',
        'lib/mcp/tools/archiveWorkItem.ts',
        'lib/mcp/tools/deleteWorkItem.ts',
        // Story 7.9 · MOTIR-1825 — the AI plan-expansion tool + its outcome read
        // join the same gate (`tests/mcp/expand-item` drives both).
        'lib/mcp/tools/expandItem.ts',
        // Story 7.9 · MOTIR-1837 — the plan CONTENT read (the proposals behind
        // that outcome's count); `tests/mcp/get-plan` drives it.
        'lib/mcp/tools/getPlan.ts',
        // Story MOTIR-3098 · Subtask MOTIR-3102 — the two DISCOVERY reads, the
        // surface an agent uses to answer *does this already exist?* Both are
        // new in this story, so there is no pre-existing number to pin blind:
        // GATED, not report-only. Their shared payload code is already gated
        // through `lib/mcp/payloads/workItems.ts` above.
        'lib/mcp/tools/skeleton.ts',
        'lib/mcp/tools/searchWorkItemsSemantic.ts',
        // Story 7.9 · MOTIR-1842 — the dependency-EDGE projection both LIST
        // reads attach; `tests/mcp/dependency-edges` drives it.
        'lib/mcp/dependencyEdges.ts',
        // Story 7.10 · Subtask 7.10.8 (MOTIR-896) — the GitHub integration's
        // webhook state machine + installation grant mirror + code-graph feed
        // dispatch + the planning-envelope repo-set producer join the gate.
        'lib/services/githubWebhookService.ts',
        'lib/services/githubInstallationService.ts',
        'lib/services/codeGraphIndexService.ts',
        'lib/github/indexEnqueue.ts',
        'lib/github/webhookSignature.ts',
        'lib/ai/codeContext.ts',
        // Story 7.30 (changing a plan is a CONVERSATION) · Subtask MOTIR-1732 —
        // the story-level gate. The conversation's persistence layer
        // (MOTIR-1728), the launcher↔host contract + its route gate
        // (MOTIR-1729), and the rail's diff index + client state machine
        // (MOTIR-1730) join together, once the story's code has merged and the
        // numbers are real. The client TRANSPORT is gated too: it is the only
        // path the rail reaches the server by, and it shipped untested.
        // Story MOTIR-1343 · MOTIR-1819 — the ASK seam. Every file here is new
        // code this card wrote, MEASURED on this branch before being pinned (the
        // sequence this block prescribes throughout):
        //   `aiAskService.ts`  96.2 stmts / 93.9 branches / 100 funcs / 100 lines
        //   `askResult.ts`     100 / 100 / 100 / 100
        // Both are GATED in `thresholds` below.
        //
        // ⚠️ THE THREE ROUTE FILES WERE REPORT-ONLY, AND ARE NOW GATED
        // (MOTIR-1822). The exemption said: what is uncovered is the `throw err`
        // rethrow of an error the shared mapper did not recognise, reachable only
        // by an exception type no service on the path raises — so publish the
        // number, and "the pin belongs to whoever makes that arm reachable."
        //
        // The story gate made it reachable, and honestly rather than by walking a
        // line: an unmapped throw IS a real outcome, and the assertion that
        // matters is that it surfaces as a FAULT instead of being flattened into
        // a plausible 4xx that hides which side failed. The stream route's own
        // arms came with it — a failure after the headers are sent can no longer
        // choose a status, so the only way the rail learns why it stopped is a
        // terminal `error` frame, and a stream that just ends reads as "the job
        // finished" and files nothing.
        //
        // MEASURED on this branch before pinning, with `askRoutes` + `askGate` +
        // `askStreamRoute` + `planChangeTurnIntent`:
        //   `ask/route.ts`               92.9 branches / 100 funcs /  96.0 lines
        //   `ask/settle/route.ts`         100 / 100 / 100
        //   `ask/[jobId]/stream/route.ts` 94.4 / 100 / 100
        //
        // ⚠️ WRITTEN WITH `**`, NOT A LITERAL `[jobId]`, for the reason this file
        // records twice already: in a glob `[jobId]` is a CHARACTER CLASS, so the
        // literal path names a directory that does not exist and the entry would
        // quietly cover — and gate — nothing.
        'lib/services/aiAskService.ts',
        'lib/planning/askResult.ts',
        'app/api/ai/ask/**/route.ts',
        'lib/services/planChangeSessionsService.ts',
        'lib/repositories/planChangeSessionRepository.ts',
        'lib/repositories/planChangeTurnRepository.ts',
        'lib/mappers/planChangeMappers.ts',
        'lib/planChange/errors.ts',
        'lib/planning/launcher.ts',
        'lib/planning/workspaceHost.ts',
        'lib/planning/planChangeDiff.ts',
        'lib/planning/planChangeClient.ts',
        'lib/hooks/usePlanChangeConversation.ts',
        // Story 7.12 · Subtask 7.12.3 (MOTIR-909) — CONTEXTUAL planning. The
        // conversation's scoping is now a permission boundary: which anchors a
        // turn plans against, and whether each one was view-gated, is decided in
        // these two files. They join the same gate as the rest of the
        // conversation stack they extend.
        'lib/planChange/scope.ts',
        'lib/services/contextualPlanningService.ts',
        // Story MOTIR-2786 · MOTIR-2787 — the planning-target LOCK. It decides
        // whether a second session may take an item another is expanding, and its
        // release path decides whether an item ever becomes plannable again; a
        // missed branch there is an epic nobody can plan, with no user-facing
        // remedy. Measured before pinning, per the note at the head of this
        // block: service 100/93.1/100, repository + lease module + sweep job all
        // 100 across the board.
        'lib/services/planTargetLockService.ts',
        'lib/repositories/planTargetLockRepository.ts',
        'lib/planChange/targetLock.ts',
        'lib/jobs/definitions/planTargetLockSweep.ts',
        // MOTIR-3064 — the abandoned-plan reconciler. Its decision table is the
        // whole card: which job states mean "the producer is not coming back",
        // and which of them mean "we do not know yet". A missed branch there is
        // either a project whose auto-planning stays paused for good or a live
        // generation cut off mid-run, and neither surfaces as an error.
        'lib/services/abandonedPlanService.ts',
        'lib/jobs/definitions/abandonedPlanSweep.ts',
        // Story 7.12 · Subtask 7.12.5 (MOTIR-911) — the CONFIRMATION GATE at the
        // persist boundary. This module decides whether an approved proposal set
        // may become rows at all (the kind-parent grammar, the intra-plan ref
        // graph, done-work immutability); it is the load-bearing SAFETY contract
        // of the planning pipeline, so every branch of the verdict is gated.
        'lib/plans/validateProposals.ts',
        // Story MOTIR-6095 · MOTIR-6141 — the plan path's ONE difficulty bar
        // (every proposal write door and the approve-time grammar ask it). New in
        // the story, measured BEFORE pinning from its own specs
        // (`tests/plans/validateProposedDifficulty`, `proposedDifficulty`,
        // `planDifficultyStoryGate`): 100 stmts · 100 branch · 100 fn · 100 lines.
        'lib/plans/validateProposedDifficulty.ts',
        // Story MOTIR-5544 · MOTIR-6283 — the run-found planning bug's COMPOSER,
        // the one place a customer's text could cross into Motir's own project.
        // Pure; gated from its own spec (`tests/plans/runFoundPlanningBug`).
        'lib/plans/runFoundPlanningBug.ts',
        // Story MOTIR-5544 · MOTIR-6285 — the run-found report SERVICE: a
        // read-derived write under a lock, a cross-workspace create as the system
        // principal, and an acknowledgement that must leak nothing. Gated from
        // its own spec (`tests/runFoundReportService`).
        'lib/services/runFoundReportService.ts',
        // Story MOTIR-5544 · MOTIR-6232 — the STORY GATE adds the rest of the
        // story's NEW files: the change predicate (MOTIR-6225), the verdict tool
        // (MOTIR-6227), the report's filing-row repository (MOTIR-6282) and the
        // report tool (MOTIR-6286). Measured first on this branch against the
        // story's specs (`approvedShapeChange`, `approvedShapeVerdict`,
        // `approvedShapeForReport`, `get-approved-shape-verdict`,
        // `report-unbuildable-target`, `runFoundReportRepository`,
        // `runFoundReportService`, `runFoundStoryGate`, `runFoundStoryGuards`),
        // stmts / branch / fn / lines:
        //   approvedShapeChange        92.59 /  93.75 / 100 / 100
        //   getApprovedShapeVerdict   100    /  96.15 / 100 / 100
        //   runFoundReportRepository  100    / 100    / 100 / 100
        //   reportUnbuildableTarget   100    / 100    / 100 / 100
        // ⚠️ The story's SHARED files are deliberately NOT here, by the rule the
        // MOTIR-5548 entry below states: `plansService` (the verdict's service
        // methods — measured 42.58 / 34.07 / 49.42 / 45.07 file-wide, but 97.8 /
        // 91.8 / 100 / 97.7 over the story's own functions), `promptTemplate`
        // (92.04 / 85.20 / 86.20 / 92.39 from its own spec), `planItemRepository`,
        // `lib/plans/errors`, `lib/dispatchRuns/errors` and `lib/runs/timeline`.
        // Already-gated files the story touched keep their existing entries
        // (`dispatchRunService`, `workItemRevisionRepository`, the MCP
        // registry / scopes / permissions / exemptions).
        'lib/plans/approvedShapeChange.ts',
        'lib/mcp/tools/getApprovedShapeVerdict.ts',
        'lib/repositories/runFoundReportRepository.ts',
        'lib/mcp/tools/reportUnbuildableTarget.ts',
        // Story 7.12 · Subtask 7.12.6 (MOTIR-912) — the REVIEW-AND-CONFIRM seam
        // the story's rail runs on (MOTIR-1746/1747). `planReview.ts` answers the
        // three questions every AI-planning entrance asks of a run (is a proposal
        // pending? what did the approve land? what does a failed decision mean?)
        // and `planReviewClient.ts` is the ONE HTTP client all four of them
        // confirm through. They were the story's newest, least-gated code and they
        // sit directly on the confirm-before-write path, so they join the floor.
        'lib/planning/planReview.ts',
        'lib/planning/planReviewClient.ts',
        // Story 7.13 · Subtask 7.13.3 (MOTIR-916) — the auto-plan CADENCE
        // trigger. This module decides, with no human in the loop, whether to
        // spend a planning job on a tenant: the pending-proposal gate, the drain
        // threshold, the stub nomination, the actor it submits as, and the
        // per-project failure isolation. An untested branch here is an
        // unattended one, so every branch of the decision is gated.
        'lib/services/autoPlanCadenceService.ts',
        // Story 7.13 · Subtask 7.13.7 (MOTIR-920) — the REST of the story's
        // merged surface joins the gate its cadence half already sits under.
        // Measuring coverage over 7.13 as a whole (rather than per subtask, as
        // each landed) found the residue: the cron DEFINITION that wraps the
        // sweep shipped at 0% (the schedule, the retry budget and the registry
        // wiring were all unproven), and so did the planner-model PICKER whose
        // two mapping functions decide whether a tenant's pinned model survives
        // a save. Both are now gated, together with the sprint-persist +
        // settings services this story's other subtasks shipped, so the whole
        // 7.13 surface is held to the same floor rather than only the piece
        // MOTIR-916 happened to enrol.
        'lib/services/aiSprintPlanningService.ts',
        'lib/services/projectAiSettingsService.ts',
        'lib/ai/sprintAssignment.ts',
        'lib/mappers/projectAiSettingsMappers.ts',
        'lib/projectAiSettings/limits.ts',
        'lib/jobs/definitions/autoPlanCadenceTick.ts',
        // Story MOTIR-1803 (roadmap auto-drill) · Subtask MOTIR-1808 — the
        // story's changed surface joins the gate once its code card (MOTIR-1807)
        // merged and the numbers are real. Both files are CLIENT components with
        // no service behind them: the descend predicate, the per-level suppression
        // ref and the adapter's cache/refresh generations are decided here and
        // reach the browser with nothing else in the way, so an untested branch
        // is an unproven one. `tests/components/roadmapAutoDrillGate.test.tsx`
        // carries the top-up + the DTO→adapter→canvas seam.
        // Story MOTIR-3833 · MOTIR-3840 — the roadmap-refinement surface, MEASURED
        // before being gated (this list's own rule). `canvasGeometry` gained the
        // arrival view, `RoadmapView` the URL↔level wiring and the fold budget, and
        // the legend-collapse hook is new. Three files this story changed are
        // deliberately NOT here, each with its number: `projectCanvasModel.ts`
        // (L100 B83.33 F100 — the shortfall is twelve pre-existing `?? fallback`
        // arms on maps seeded by construction, none of them this story's),
        // `PlanningCanvas.tsx` (L75.16 B64.88 F75 — a pre-existing pan/zoom/drag
        // component this story added one optional prop to), and
        // `app/(authed)/roadmap/page.tsx` (an async Server Component; the rule at
        // the top of this list is that a page joins only once somebody measures it).
        'lib/planning/canvasGeometry.ts',
        'components/planning/RoadmapView.tsx',
        'lib/hooks/useDependencyLegendCollapsed.ts',
        'components/planning/ProjectRoadmapCanvas.tsx',
        'components/planning/WorkItemRoadmap.tsx',
        // Story MOTIR-1755 · Subtask MOTIR-2205 — the planning phase card's DOOR
        // joins the same gate, and for the same reason: these three are CLIENT
        // modules with no service behind them, so the decisions they make — which
        // level the drill is served from, which stations are openable, and what the
        // card is allowed to ASSERT about a journey — reach the browser with nothing
        // in between. The badge in particular is a claim about provenance, and every
        // untested branch of it is a claim nobody checked.
        'components/planning/preplanStationLevel.tsx',
        'components/planning/PlanningOriginCluster.tsx',
        'components/planning/workItemLevel.tsx',
        // Story MOTIR-1863 (connect the CLI) · Subtask MOTIR-1870 — the whole
        // `motir login` surface joins the gate now that every code card has
        // merged and the numbers are real. This is a CREDENTIAL path: the
        // service is the one seam where a browser session becomes a bearer
        // token, the routes are the CLI's wire contract (RFC 8628 error codes a
        // published binary branches on), and `DeviceApproval` is the approval
        // screen whose four-fact inventory IS the device grant's phishing
        // mitigation — the ADR says in as many words that losing it invalidates
        // the decision's risk assessment. An untested branch in any of them is
        // an unproven one on the path that hands out credentials.
        'lib/services/cliDeviceService.ts',
        'lib/repositories/deviceCodeRepository.ts',
        'lib/mappers/cliDeviceMappers.ts',
        'lib/cliDevice/constants.ts',
        'lib/cliDevice/errors.ts',
        'lib/cliDevice/userCode.ts',
        'app/api/cli/device/start/route.ts',
        'app/api/cli/device/token/route.ts',
        'app/api/cli/device/approve/route.ts',
        'app/api/cli/device/grant/route.ts',
        'app/**/device/_components/DeviceApproval.tsx',
        'app/**/settings/account/_components/ConnectCliPanel.tsx',
        // Story MOTIR-1775 · MOTIR-1896 — the CI-minutes METER (the measurement
        // half of `docs/decisions/ci-minutes-allowance.md`). Gated from day one:
        // every figure here becomes a charge on a user's credit balance via
        // MOTIR-1901, so a silent regression in the arithmetic, the period key
        // or the idempotency guard is a billing bug, not a test-coverage nit.
        'lib/ciMetering/runnerRates.ts',
        'lib/ciMetering/normalize.ts',
        'lib/ciMetering/period.ts',
        'lib/ciMetering/config.ts',
        'lib/services/ciMinutesMeterService.ts',
        'lib/services/ciMinutesReconciliationService.ts',
        'lib/repositories/ciWorkflowRunUsageRepository.ts',
        'lib/repositories/ciPeriodUsageRepository.ts',
        'lib/jobs/definitions/ciMinutesReconcile.ts',
        // Story MOTIR-1916 · MOTIR-1924 — the FLEET COST meter, joining the
        // metering block above for the same reason and one level down: these
        // figures are what Motir's own margin is read from, and §M's ×1.00
        // product decision is defended by them. A silent regression in the
        // attribution, the period key or the per-runner idempotency guard would
        // not misbill a customer — it would quietly misinform the decision about
        // whether to re-price the allowance, which is worse for being invisible.
        // (The wider FLEET floor — the provisioning path, the port, the
        // adapters — is MOTIR-1927's deliverable, not this card's.)
        'lib/services/ciFleetCostMeterService.ts',
        'lib/repositories/ciContainerUsageRepository.ts',
        'lib/repositories/ciContainerPeriodCostRepository.ts',
        // Story MOTIR-1775 · MOTIR-1901 — the CI-minutes ENTITLEMENT (the
        // charging half of the same decision). Gated for the reason the meter's
        // comment above anticipates: these modules DECIDE what to bill and when
        // to refuse a dispatch, so an untested branch here is a wrong charge or a
        // wrongly-blocked customer.
        'lib/ciMetering/allowance.ts',
        'lib/services/ciAllowanceService.ts',
        'lib/repositories/ciPeriodChargeRepository.ts',
        // Story MOTIR-1775 · MOTIR-1781 — the repo-CREATION primitive. Gated
        // because its failure modes are IRREVERSIBLE in a way a normal service's
        // are not: an untested branch here creates a second repository, adopts one
        // that belongs to another tenant, or loses the record of a repository that
        // now exists in Motir's org with nothing pointing at it. There is no
        // rollback for any of those (ADR §4.2), so the branch coverage IS the
        // safety net.
        'lib/github/repoProvisioning.ts',
        'lib/services/projectRepoProvisioningService.ts',
        // Story MOTIR-1916 · MOTIR-1972 — the PER-PROJECT RUNNER GROUP. Gated
        // for the same reason the primitive above is, one layer over: an
        // untested branch here leaves a project sharing a runner group with
        // another tenant, or with none at all. `docs/decisions/ci-runner-fleet.md`
        // §7.3 makes the group's access list the thing that stops a runner Motir
        // booted for project X from serving project Y's queued job — including a
        // job MOTIR-1922's gate DECLINED — so every branch that decides which
        // repositories the list holds is a tenancy branch, and its failure is
        // silent when it happens.
        'lib/github/runnerGroups.ts',
        'lib/services/projectRunnerGroupService.ts',
        // Story MOTIR-1916 · MOTIR-1927 — THE REST OF THE FLEET. MOTIR-1924's
        // entry above gates the cost meter and defers the wider floor here ("the
        // provisioning path, the port, the adapters — MOTIR-1927's deliverable");
        // this is that deferral collected.
        //
        // Gated as one surface because the fleet's failures are all SILENT and
        // all expensive: a container nobody tore down bills forever, a runner in
        // the wrong group serves a job the gate declined, a cap read outside its
        // lock is not a cap. None of those surfaces as an error — they surface as
        // an invoice or as another tenant's CI — so the branch that decides each
        // one is the only place the guarantee is checkable at all.
        //
        // ⚠️ THE PORT ITSELF LEFT THIS GATE, AND ITS FLOOR WENT WITH IT
        // (MOTIR-4299). Ten of the eleven files that used to be listed here are
        // now `packages/orchestrator/src/**` and are gated by that package's own
        // `vitest.config.ts` at the SAME ≥90 per-file floor, run by `ci.yml`'s
        // `orchestrator` job. The reason they were listed is unchanged — §4 calls
        // the swappable interface "the single most load-bearing output: it is
        // what makes this decision reversible", and an adapter half of which is
        // unexercised is an interface with one caller rather than a port — so the
        // gate MOVED rather than being dropped. What stays here is the one file
        // that did not move: the app's COMPOSITION ROOT.
        'lib/orchestrator/index.ts',
        // Story MOTIR-1916 · MOTIR-2006 — THE BOOT PREFLIGHT, joining the same
        // surface for the same reason, stated at its sharpest by the fault it
        // exists to catch: MOTIR-1980's fleet shipped code-complete and unable to
        // pull a single image, and every predicate in the tree answered
        // "configured". The preflight is the one thing that would have said
        // otherwise, so an unexercised branch in it is the guarantee going
        // missing exactly where it went missing before.
        'lib/services/fleetPreflightService.ts',
        // Story MOTIR-1981 · MOTIR-1992 — THE INDEX FLEET, joining the gate for
        // the reason §6 states: this path's whole output is a `job_run` row that
        // is a PERMANENT claim that a repo has a code graph. Everything
        // downstream — the enqueue gate, the operator sweep, the onboarding
        // wizard's Next button — trusts that claim without re-checking it, so an
        // unexercised branch here is a repo that is silently never indexed (or
        // silently claimed and never built) with nothing anywhere to say so.
        // `indexImage.ts` sits with them because the image reference IS the
        // deliverable a container boots on: MOTIR-1980 shipped a fleet whose
        // every predicate answered "configured" and which could not pull a
        // single image.
        'lib/services/codeGraphIndexDispatchService.ts',
        'lib/services/codeGraphIndexAdmissionService.ts',
        // Story MOTIR-4335 · MOTIR-4544 — the internal index allowance's vocabulary
        // (MOTIR-4593) and the catch-up sweep (MOTIR-5290). MEASURED first: 100
        // statements / 100 branches / 100 functions / 100 lines apiece, over
        // `tests/jobs/code-graph-index-{allowance,catch-up}.test.ts`,
        // `tests/ai/indexAllowanceClient.test.ts` and `tests/ciFleet/`. Pinned at the
        // fleet's 90 floor below.
        'lib/ciFleet/indexAllowance.ts',
        'lib/services/codeGraphIndexCatchUpService.ts',
        'lib/jobs/definitions/codeGraphIndexCatchUp.ts',
        'lib/jobs/indexFleetSteps.ts',
        'lib/jobs/definitions/codeGraphIndex.ts',
        'lib/ciFleet/config.ts',
        'lib/ciFleet/limits.ts',
        'lib/ciFleet/shardTargets.ts',
        'lib/ciFleet/workloads.ts',
        'lib/ciFleet/bootDispatch.ts',
        'lib/github/runnerJitConfig.ts',
        'lib/services/ciRunnerProvisioningService.ts',
        'lib/services/ciRunnerBootService.ts',
        'lib/services/ciRunnerAdmissionService.ts',
        'lib/services/fleetCeilingService.ts',
        // Story MOTIR-6906 · MOTIR-6908 — the org stop.
        'lib/services/fleetStopService.ts',
        'lib/github/actionsRuns.ts',
        // Story MOTIR-6906 · MOTIR-6909 — the paid-AI-plan gate.
        'lib/services/aiPlanGateService.ts',
        // Story MOTIR-6906 · MOTIR-6910 — CI debited while it runs.
        'lib/services/ciLiveChargeService.ts',
        'lib/repositories/ciLiveAccrualRepository.ts',
        'lib/jobs/definitions/ciLiveCharge.ts',
        // Story MOTIR-6906 · MOTIR-6925 — the fleet-attribution reconciler.
        'lib/services/fleetAttributionService.ts',
        'lib/repositories/fleetMachineKillRepository.ts',
        'lib/ciFleet/attributionErrors.ts',
        'lib/monitoring/fleetAttributionAlert.ts',
        'lib/jobs/definitions/fleetAttribution.ts',
        'lib/repositories/ciRunnerProvisioningIntentRepository.ts',
        'lib/repositories/ciFleetAdmissionLockRepository.ts',
        'lib/repositories/fleetInFlightSlotRepository.ts',
        'lib/jobs/definitions/ciRunnerFleet.ts',
        // Story MOTIR-9359 · MOTIR-9427 — the agent-runner pool: its switch, the
        // per-account admission and the hosted-agent container's boot, poll and
        // settle on the account. Their chain is `agentRunnerPoolStoryGate.test.ts`;
        // pinned at the fleet's 90 floor below.
        'lib/ciFleet/fleetKindSwitches.ts',
        'lib/services/fleetShardAdmissionService.ts',
        'lib/services/hostedAgentContainerService.ts',
        // Story MOTIR-8699 · MOTIR-8716 — Motir CI on the fleet for a CONNECTED org:
        // the org-target auth, the readiness verdict's GitHub reads, the org
        // Actions-variable client, the runner-target resolver, the readiness and
        // setting services with their repository and mapper, and the console's
        // Fleet settings page. Every file the story touched that carries runtime
        // code and was not already gated (runnerGroups, runnerJitConfig,
        // repoProvisioning, the boot / provisioning / stop / runner-group services
        // and the platform errors and audit actions already are). Left out on
        // purpose: the type-only files (`lib/dto/fleetOrgCiSetting.ts`,
        // `lib/ciFleet/fleetJobInventoryTypes.ts`, `fleetJobInventory.d.json.ts`)
        // and the measured JSON manifest, which have no statements to gate; and the
        // three shared repositories (`githubRepoRepository`, `projectRepoRepository`,
        // `projectRepository`) and `app/(admin)/layout.tsx`, which gained one method
        // or one label each and are measured by the whole suite rather than by this
        // story. Pinned at the fleet's 90 floor below.
        'lib/github/orgTarget.ts',
        'lib/github/orgInstallation.ts',
        'lib/github/actionsVariables.ts',
        'lib/github/repoVisibility.ts',
        'lib/ciFleet/runnerTarget.ts',
        'lib/repositories/projectRunnerGroupRepository.ts',
        'lib/services/fleetReadinessService.ts',
        'lib/services/fleetOrgCiSettingService.ts',
        'lib/repositories/platformFleetOrgCiRepository.ts',
        'lib/mappers/fleetOrgCiSettingMappers.ts',
        // Story MOTIR-9362 · MOTIR-9464 — the pool-growth story's new modules (the
        // growth policy, the spare's add-shard plan, the quota and growth records,
        // the live read, the raise service, the growth and its scheduled pass, the
        // pool status and `fleet-admin`'s pool commands). MEASURED on this branch
        // against the story's own specs: every file >= 90 on all four metrics (the
        // lowest, `fleetQuotaRaiseService`, 96.58 / 92.2 / 94.11 / 97.14). The arms
        // left uncovered are named, with why, in `tests/ciFleet/fleetGrowthIntegration.test.ts`.
        // Pinned at the fleet's 90 floor below.
        'lib/ciFleet/poolGrowthPolicy.ts',
        'lib/fleetShards/awsMemberAccountPlan.ts',
        'lib/fleetShards/fleetAutomationPrincipal.ts',
        'lib/fleetShards/scrubSecrets.ts',
        // Story MOTIR-9708 · MOTIR-9850 — the pool-account definition as add-shard
        // reads it, and the `aws` provider that applies it. MEASURED on this branch
        // against `tests/ciFleet/awsPoolStackSeam.test.ts`, `awsPoolDefinition`,
        // `fleetShardProvisioningAws` and `fleetShardProvisioningAwsIndexer` alone:
        // awsPoolDefinition 100 / 95 / 100 / 100, awsProvisioningProvider
        // 96.94 / 90 / 100 / 98.34 (statements / branches / functions / lines).
        // Pinned at the fleet's 90 floor below.
        'lib/fleetShards/awsPoolDefinition.ts',
        'lib/fleetShards/awsProvisioningProvider.ts',
        'lib/jobs/definitions/fleetPoolGrowth.ts',
        'lib/mappers/fleetPoolMappers.ts',
        'lib/repositories/fleetGrowthEventRepository.ts',
        'lib/repositories/fleetGrowthLockRepository.ts',
        'lib/repositories/fleetGrowthPassLeaseRepository.ts',
        'lib/repositories/fleetQuotaRequestRepository.ts',
        'lib/services/fleetGrowthEventService.ts',
        'lib/services/fleetPoolGrowthPassService.ts',
        'lib/services/fleetPoolGrowthService.ts',
        'lib/services/fleetPoolStatusService.ts',
        'lib/services/fleetQuotaRaiseService.ts',
        'lib/services/fleetQuotaRequestService.ts',
        'lib/services/fleetShardQuotaService.ts',
        'scripts/fleet/fleetAdminPoolCommands.ts',
        // Story MOTIR-9709 · MOTIR-9933 — the AWS deploy script and the read-only
        // `fleet-admin check-quota`. MEASURED on the story branch against
        // `tests/awsDeploy/**`, `tests/hosting/credentialModes.test.ts` and
        // `tests/ciFleet/fleetAdminCheckQuota.test.ts`: awsDeploy 98.87 / 98.07 /
        // 100 / 100, rollingDeploy 100 / 96.42 / 100 / 100, migrateRun, ports and
        // taskDefinitions 100 on all four, fleetAdminCheckQuota 100 / 100 / 100 /
        // 100 (statements / branches / functions / lines). The branches left are the
        // entry guard and a container missing from its own clone. Pinned at the
        // fleet's 90 floor below. (`lib/blob/s3.ts` is gated further down.)
        'scripts/aws-deploy/awsDeploy.ts',
        'scripts/aws-deploy/migrateRun.ts',
        'scripts/aws-deploy/ports.ts',
        'scripts/aws-deploy/rollingDeploy.ts',
        'scripts/aws-deploy/taskDefinitions.ts',
        'scripts/fleet/fleetAdminCheckQuota.ts',
        // Story MOTIR-9367 · MOTIR-9564 — the platform Pools read and its section on
        // /admin/monitoring. MEASURED on this branch against `poolsStoryIntegration`,
        // `poolsSection` and `platformFleetPoolsService`: the service 100 on all four,
        // the section 97.17 / 95.16 / 100 / 97+ (the arms left are defensive: a null
        // use, an unknown account state). Pinned at the fleet's 90 floor below.
        'lib/services/platformFleetPoolsService.ts',
        'app/**/admin/monitoring/_components/PoolsSection.tsx',
        // Story MOTIR-1775 · MOTIR-1782 — the establish STEP at plan approval.
        // Gated for a different reason than the primitive above: the whole card
        // is a claim about what must NOT be on screen (no repository name, count,
        // role or GitHub error on the default path — the `notes.html` #151 rule),
        // and a claim like that only holds while the branches that could leak it
        // are exercised. The routes are the wire contract behind it, including the
        // one state a client may never write.
        'lib/services/projectRepoEstablishService.ts',
        'lib/projectRepos/errorResponse.ts',
        'lib/planning/repositorySetClient.ts',
        'components/planning/repositories/RepositorySetStep.tsx',
        'app/api/projects/[key]/repositories/route.ts',
        'app/api/projects/[key]/repositories/[rowId]/route.ts',
        'app/api/projects/[key]/repositories/[rowId]/state/route.ts',
        'app/api/projects/[key]/repositories/[rowId]/move/route.ts',
        'app/api/projects/[key]/repositories/establish/route.ts',
        // Story MOTIR-1775 · MOTIR-1945 — the TEAM code-access surface. Gated on
        // the same reasoning: the card's load-bearing claims are about who may
        // ACT (a connect prompt on your own row and nobody else's, no control at
        // all where the action was never yours, a refusal that never fails the
        // repository), and a claim like that holds only while the branches that
        // could break it are exercised. The view model carries the roll-up those
        // claims are made of.
        'lib/projectRepos/teamAccessView.ts',
        'app/**/settings/project/code-access/_components/CodeAccessSettings.tsx',
        // Story MOTIR-1775 · MOTIR-1939 — the TAKE-IT-OVER surface. Gated because
        // the card is a set of claims about STATE that only hold while the
        // branches expressing them are exercised: that a waiting state is a
        // durable place and never a spinner, that the already-yours row offers
        // nothing, that one row moving leaves its siblings working, and that the
        // picker still works when the org lookup fails. Every one of those is a
        // branch, and an untested branch here silently wedges a repository the
        // user was promised was theirs.
        'lib/github/userOrgs.ts',
        'lib/services/projectRepoRoomService.ts',
        'app/api/github/organizations/route.ts',
        'app/**/settings/project/repositories/_components/TakeoverRow.tsx',
        'app/**/settings/project/repositories/_components/TakeoverModal.tsx',
        'app/**/settings/project/repositories/_components/RepositoriesRoom.tsx',
        // MOTIR-3126 — the room's SECOND registry. Same argument as the block
        // above, one registry over: the surface's claims are that an
        // organisation repository is NAMED, SOURCED and carries an action only
        // where there is a LINK to remove, and that the empty state belongs to a
        // project with neither registry. Every one of those is a branch, and the
        // defect being fixed here is precisely a branch nobody could take. The
        // reader and the section split are gated for the same reason — they are
        // now the ONE definition the resolver and every surface share, so an
        // unexercised branch in them is a disagreement waiting to happen.
        // ⚠️ `ConnectedRepositories.tsx` stood here until MOTIR-4820, which folded
        // that section into the organisation one and deleted the component. Its
        // claims did not go with it — they are asserted of `domain` entries in
        // `OrganizationRepositories`, which this list already covers by glob.
        'app/**/settings/project/repositories/_components/OrganizationRepositories.tsx',
        'lib/projectRepos/effectiveDomain.ts',
        'lib/projectRepos/roomSections.ts',
        // Story MOTIR-1755 · MOTIR-1758 → gated by MOTIR-1760. The provenance
        // BACKFILL's decision table. It shipped ungated, and it is the one file
        // in that subtask whose branches ARE the safety argument: each branch is
        // a claim about what may be stamped truthfully on ~1 700 already-shipped
        // items, and the two most important ones ABSTAIN (a done coding-agent
        // card with no PR, a cancelled card). An untested abstention is
        // indistinguishable from a missing rule, and the damage it does —
        // inventing attribution on real history — is silent and hard to undo.
        // The service + repository halves are already gated above.
        'lib/workItems/provenanceBackfill.ts',
        // MOTIR-1965 — the historical-PR mirror backfill, gated for the same
        // reason its provenance sibling above is: this is operator tooling whose
        // writes land on real, already-shipped history, and the branches ARE the
        // safety argument. The merged-only filter, the manual-link stickiness,
        // and the already-current comparison each prevent a specific wrong claim
        // (a `byok` stamp from an abandoned PR, a hand-made link overwritten, a
        // whole mirror's `updated_at` churned by a re-run), and an untested one
        // is indistinguishable from a missing one.
        'lib/github/historicalPullRequests.ts',
        'lib/services/historicalPullRequestBackfillService.ts',
        // MOTIR-3034 — the `base_ref` repair and the event-free re-evaluation of
        // the repository-set completion gate, gated for the SAME reason its
        // MOTIR-1965 neighbours above are, one turn sharper: this tooling does not
        // merely write to shipped history, it can move a card to DONE with no
        // human and no merge behind it. Every guard that keeps it honest is a
        // branch — the empty repository set that must ABSTAIN, the open change
        // request that must HOLD, the provider answer that must be left NULL
        // rather than guessed, the already-filled row that must not be rewritten —
        // and each one prevents a specific false claim. An untested guard here is
        // indistinguishable from a missing one, and what it would silently do is
        // complete work items nobody shipped.
        'lib/github/restRetry.ts',
        'lib/github/pullRequestBase.ts',
        'lib/services/pullRequestBaseRefBackfillService.ts',
        'lib/services/repoSetCompletionService.ts',
        // Story 7.24 · MOTIR-1812 → gated by MOTIR-1813. The "M" universal AI
        // callout: its action REGISTRY plus the two components that consume it.
        // The registry is the extension point MOTIR-1343 / MOTIR-1344 each land a
        // single entry in, so what the gate protects is not today's one row — it
        // is that the next row arrives with its branches exercised, in a surface
        // that is the front door to every AI capability Motir offers. The
        // launcher it derives its href from is already gated above.
        'lib/planning/aiCallout.ts',
        'components/planning/AiCalloutMenu.tsx',
        // MOTIR-3208, corrected by MOTIR-3214 — the orb's drag + throw.
        // `orbPhysics.ts` is pure and is GATED below (measured at 100 statements /
        // branches / functions / lines on this branch, against a 90 floor).
        // `useDraggableOrb.ts` is REPORT-ONLY, and the reason is the one this block
        // prescribes rather than a shortfall being hidden: it is at 100% LINES and
        // 82% branches, and what remains are DOM-capability guards
        // (`el.setPointerCapture?.()`, `pos.current ?? …`, the null arm of a
        // callback ref) that a single test environment cannot drive both ways —
        // happy-dom either has the method or does not. Pinning 90 would invite
        // mocking the DOM into having and not having a capability, which tests the
        // mock.
        'lib/planning/orbPhysics.ts',
        'lib/hooks/useDraggableOrb.ts',
        'components/planning/PlanWithAIFab.tsx',
        // MOTIR-1970 — the schedule-health detection seam. Gated because this is
        // the code that has to work on the day everything else has already
        // failed: production ran for a month with five jobs silently consuming
        // nothing, and no signal existed anywhere. Each branch here IS a way the
        // alarm can fail to sound — a cron term the evaluator does not
        // understand, a "never ran" that reads as healthy, a job judged against
        // the wrong tick. An untested branch in a detector is indistinguishable
        // from no detector, and its failure mode is the same silence it was
        // built to break.
        'lib/jobs/cron.ts',
        'lib/jobs/schedules.ts',
        'lib/services/jobScheduleHealthService.ts',
        'lib/jobs/definitions/dailyHealthCheck.ts',
        // Story 11.1 (the public `/api/v1` foundation) · Subtask 11.1.5 — the
        // whole v1 envelope gates from day one. Every branch here is a way the
        // PUBLIC contract can be wrong for a third party: an auth gate that
        // admits, a cursor that skips a row, a limiter that leaks, an error
        // path that leaks a stack. Stories 11.2 / 11.3 add endpoints ON TOP of
        // these files, so the gate must already be load-bearing when they land.
        'lib/api/v1/route.ts',
        'lib/api/v1/contractVersion.ts',
        'lib/api/v1/errors.ts',
        'lib/api/v1/bearer.ts',
        'lib/api/v1/pagination.ts',
        'lib/api/v1/rateLimit.ts',
        // MOTIR-4974 — the client-version verdict, NAMED on the way in for the
        // reason the v1 comment above already gives: this file decides what a
        // third party is told about its own client, and its failure mode is
        // silence. A floor that never fires reads exactly like a fleet that is
        // up to date, so the arms that must stay covered are the ones that
        // return `null`.
        'lib/api/v1/clientVersion.ts',
        // Story 8.5 · Subtask 8.5.9 (MOTIR-1165) — the SHARED rate limiter and
        // its Postgres store. This is a security control on the pre-auth surfaces
        // (sign-in, sign-up, password reset, public writes) and a cost control on
        // the AI ones, so it belongs under the gate rather than beside it. Every
        // file is MEASURED at 100% before being pinned below — the honest sequence
        // the permission-model note above asks for.
        'lib/rateLimit/**',
        'lib/services/rateLimitService.ts',
        'lib/repositories/rateLimitCounterRepository.ts',
        'lib/ai/jobAuthResponse.ts',
        'app/api/v1/me/route.ts',
        'app/api/v1/workspaces/route.ts',
        // Story 11.3 (the planning resources) · Subtask 11.3.10 — MOTIR-2067.
        // The story's own gate measures its merged surface; these are the files
        // it added, each gated independently so a regression in one fails the
        // run rather than being averaged away by the others.
        'lib/api/v1/projects/schema.ts',
        // Story MOTIR-3584 · Subtask MOTIR-3590 — the project's repository SET on
        // `/api/v1`, the read `motir link` materializes from. MEASURED FIRST, then
        // pinned below, per this block's own rule.
        'lib/api/v1/projects/repositories.ts',
        'app/api/v1/projects/[projectKey]/repositories/route.ts',
        'lib/api/v1/sprints/schema.ts',
        'lib/api/v1/sprints/membership.ts',
        'lib/api/v1/ready/schema.ts',
        'lib/api/v1/rankedCollections.ts',
        // Story 11.4 · Subtask 11.4.3 — the SHARED wire-schema layer.
        'lib/api/v1/openapi/statuses.ts',
        'lib/api/v1/openapi/errorResponse.ts',
        'lib/api/v1/openapi/envelopes.ts',
        'lib/api/v1/openapi/headers.ts',
        'lib/api/v1/openapi/security.ts',
        // Story 11.4 · Subtask 11.4.4 — the registry, the emitter and the route.
        'lib/api/v1/openapi/operation.ts',
        'lib/api/v1/openapi/registry.ts',
        'lib/api/v1/openapi/emit.ts',
        'lib/api/v1/workItems/operations.ts',
        'app/api/openapi/v1.json/route.ts',
        // Story MOTIR-3876 · Subtasks MOTIR-3945 + MOTIR-3946 — the PUBLIC read
        // contract: its own version, its own registry, its own document, served
        // beside v1's. A SECOND contract, not a second copy — see
        // `docs/decisions/public-surface-hosts.md` AMENDMENT 1 for the three
        // grounds. MEASURED FIRST at 100/100/100 each, then pinned at the 90
        // floor below, per this block's own rule.
        // Story MOTIR-3876 · Subtask MOTIR-3885 — the ORIGIN SEAM this story
        // widened: `publicSiteOrigin()` and the description the public metadata
        // and the JSON-LD are both built from. `urls.ts` shipped at 45%
        // statements / 25% branches with `derivePublicDescription` untested at
        // all; MEASURED at 100/100/100 after 3885's cases, then pinned at the
        // floor below.
        // (`app/sitemap.ts` was pinned here too, for the sitemap 3885 re-based
        // on the application origin. It is DELETED — MOTIR-4583: an empty
        // `<urlset>` is schema-invalid, so this host serves no sitemap at all.
        // A path listed here that does not exist is a threshold nothing meets.)
        'lib/publicProjects/urls.ts',
        // Story MOTIR-3876 · Subtask MOTIR-3726 — `/robots.txt` and the policy
        // behind it. MEASURED at 100/100/100 on `tests/seo/robots.test.ts`;
        // the DERIVED half of that guard walks the signed-in route groups and
        // therefore runs in the structural-guard lane, which carries no
        // coverage — so the numbers here come from the policy tests alone,
        // which is where the calls are.
        'lib/robotsPolicy.ts',
        'app/robots.ts',
        'lib/api/public/contractVersion.ts',
        'lib/api/public/openapi/operation.ts',
        'lib/api/public/openapi/schemas.ts',
        'lib/api/public/openapi/operations.ts',
        'lib/api/public/openapi/emit.ts',
        'app/api/openapi/public.json/route.ts',
        'app/api/public/p/[identifier]/route.ts',
        // Story MOTIR-3932 · Subtask MOTIR-4194 — the PUBLISHED MCP tool
        // catalogue, the anonymous document `motir.co/docs/mcp/tools` renders
        // (`public-surface-hosts.md` AMENDMENT 5). `lib/apiDocs/mcp.ts` regained
        // a runtime reader with it; the route is a one-line serialization and
        // the shape lives in the module. MEASURED FIRST at 100/100/100 on
        // `tests/api/docs/mcp-tools-route.test.ts`, then pinned at the floor.
        'app/api/docs/mcp-tools.json/route.ts',
        // Story MOTIR-3877 · Subtask MOTIR-4120 — the reads and the act path
        // this story added, joining the subject route above under the same rule.
        //
        // ⚠️ THEY WERE OUTSIDE THIS REPORT UNTIL THIS CARD MEASURED IT, and that
        // is the finding rather than the fix: the entry above is a LITERAL path,
        // so `…/p/[identifier]/route.ts` gates one file and its five new
        // siblings inherited nothing. Every one of them shipped with route tests
        // and none of them was under the 90 floor, which is exactly the state
        // `tests/coverage-gate-globs.test.ts` exists to make visible — a gate
        // that passes because it is measuring nothing.
        //
        // MEASURED FIRST, per this block's own rule, then pinned at the floor
        // below.
        'app/api/public/p/[identifier]/board/route.ts',
        'app/api/public/p/[identifier]/roadmap/route.ts',
        'app/api/public/p/[identifier]/items/[key]/route.ts',
        'app/api/public/p/[identifier]/requests/[requestKey]/route.ts',
        'app/api/public/p/[identifier]/changelog.xml/route.ts',
        'app/api/public/projects/route.ts',
        'app/api/projects/[key]/public-overview/route.ts',
        'app/act/route.ts',
        // The two modules the act path added. `returnTarget.ts` is the one that
        // turns a value from another origin into a redirect, so it is the file
        // on this list where a missed branch is a security branch.
        'lib/publicProjects/returnTarget.ts',
        'lib/publicProjects/cors.ts',
        // Story MOTIR-3908 · Subtask MOTIR-4037 — the PUBLIC-PROJECTS CAPABILITY
        // GATE. `isCloud()` is the cloud-vs-self-host predicate (MOTIR-4033) and
        // `publicSurfaceUnavailable()` is the one refusal every gated route
        // answers with (MOTIR-4034); together they decide whether a build serves
        // a reading surface to strangers at all, which makes them about as
        // load-bearing as two small functions get. MEASURED at 100/100/100 on
        // `tests/api/public/cloud-gate.test.ts` + `tests/hosting/cloudBuildFlag.test.ts`
        // + `tests/integration/publicSurfaceCloudGate.test.ts`, then pinned at
        // the 90 floor below, per this block's own rule.
        //
        // ⚠️ `availability.ts` joins with it deliberately. The two predicates
        // read one variable and answer different questions, and the failure this
        // story is guarding against is exactly a branch of one of them going
        // unexercised — a `MOTIR_CLOUD=1` typo that silently reads as cloud, say.
        // Both arms of both functions are asserted; the gate keeps them that way.
        'lib/billing/availability.ts',
        'lib/publicProjects/cloudGate.ts',
        // Story 11.4 · Subtask 11.4.5 — the remaining operation declarations.
        'lib/api/v1/identity/schema.ts',
        'lib/api/v1/planning/operations.ts',
        // Story 11.7 (the work-loop operations) · Subtask 11.7.8 — MOTIR-2242.
        'lib/api/v1/workLoop/schema.ts',
        'lib/api/v1/workLoop/operations.ts',
        'lib/api/v1/workLoop/planScope.ts',
        'lib/api/v1/workItems/childEdges.ts',
        'lib/api/v1/workItems/schema.ts',
        'lib/api/v1/workItems/resolveKey.ts',
        // Story MOTIR-3000: the general attachment door — the v1 route and the
        // MCP tool in front of it. Both are thin adapters over one service
        // path, which is exactly why they are gated: a gate re-implemented in
        // either would show up here as an uncovered branch.
        'app/api/v1/work-items/[key]/attachments/route.ts',
        'lib/mcp/tools/attachFile.ts',
        'app/api/v1/work-items/[key]/dispatch-prompt/route.ts',
        // MOTIR-2961 — the KEYED CLAIM. Gated for the same reason the
        // attachment door above is: it is a thin adapter over one service
        // method that owns a LOCK, and a gate or a decision re-implemented in
        // the route would appear here as an uncovered branch.
        'app/api/v1/work-items/[key]/claim/route.ts',
        // Story MOTIR-3017: the bounded public entrance to plan approval. Gated
        // for the same reason — it is a thin adapter over one service path, so a
        // bound re-implemented in the route rather than enforced in the service
        // would show up here as an uncovered branch.
        'app/api/v1/work-items/[key]/plan-approval/route.ts',
        // MOTIR-3049 — the SCOPE CLAIM, for exactly the same reason one line up.
        // Its two arms differ only in which identifier they resolve; the claim
        // itself is one service method.
        'app/api/v1/scope-claims/route.ts',
        'app/api/v1/work-items/[key]/integration/route.ts',
        'app/api/v1/work-items/[key]/expansions/route.ts',
        'app/api/v1/work-items/[key]/activity/route.ts',
        'app/api/v1/sessions/complete/route.ts',
        'app/api/v1/plans/[planId]/route.ts',
        'app/api/v1/plans/[planId]/status/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/turns/route.ts',
        'app/api/v1/projects/[projectKey]/plan-session/submissions/route.ts',
        // The API-doc rendering modules moved to motir-marketing in MOTIR-3951.
        // The in-app door remains here and keeps its own coverage gate below.
        'app/**/settings/account/_components/ApiDocsLinkPanel.tsx',
        'app/api/v1/projects/route.ts',
        'app/api/v1/projects/[projectKey]/route.ts',
        'app/api/v1/projects/[projectKey]/sprints/route.ts',
        'app/api/v1/projects/[projectKey]/backlog/route.ts',
        'app/api/v1/projects/[projectKey]/backlog/work-items/route.ts',
        'app/api/v1/sprints/[sprintId]/route.ts',
        'app/api/v1/sprints/[sprintId]/start/route.ts',
        'app/api/v1/sprints/[sprintId]/complete/route.ts',
        'app/api/v1/sprints/[sprintId]/work-items/route.ts',
        // Story MOTIR-2192 · Subtask MOTIR-2166 — the code-graph OFFBOARDING
        // QUEUE (`docs/decisions/code-graph-index-fleet.md` §14). Gated because
        // the value it protects is a promise the product states in its own copy:
        // a 30-day retention window on customer-derived data. An untested branch
        // here is a graph retained past a window the dialogs claim, or one
        // removed inside a grace period the user thought they had.
        // Subtask MOTIR-2207 — the /code-health audit tab going MULTI-REPO. Both
        // files are new with the card, so they join the gate at birth rather
        // than waiting for a later coverage story. The row model is what decides
        // WHICH repo's report a reader sees (worst-first order also picks the
        // repo the re-audit poll watches), and the list is the only affordance
        // saying the other repos exist at all — an untested branch in either is
        // a project silently showing one repo's grade as if it were its own.
        'lib/codeHealth/repoAuditRows.ts',
        'app/**/code/_components/AuditRepoList.tsx',
        // Story MOTIR-2244 · Subtask MOTIR-2247 — the repo-SCOPED audit trigger.
        // The scope decides how many derivations a click PAYS for, so an
        // untested branch here is either a fan-out that spends N times what was
        // asked for, or a body parse that silently downgrades a client bug into
        // a whole-set run. The typed rejections gate the same money.
        'lib/codeHealth/errors.ts',
        'app/api/ai/coding-convention/_shared.ts',
        'app/api/ai/coding-convention/refresh/route.ts',
        // Subtask MOTIR-2248 — the audit-COVERAGE read. Its whole contract is
        // what it does when a repo's read FAILS: an untested branch is a nudge
        // that counts an unreadable repo as un-audited and cries wolf.
        'lib/services/auditCoverageService.ts',
        'app/api/ai/coding-convention/audit-coverage/route.ts',
        // Subtask MOTIR-2266 — the AUTO-FIRE trigger on a first successful index
        // (`docs/decisions/audit-on-first-index.md`). Every branch of it either
        // SPENDS two LLM calls or declines to: the idempotency gate, the per-repo
        // scope, and the swallow that keeps a derivation blip from failing — and
        // Inngest from retrying — an index that already succeeded.
        'lib/services/firstAuditTriggerService.ts',
        // Subtask MOTIR-2249 — the scoped run's record merge (pure).
        'lib/codeHealth/reauditRun.ts',
        // Subtask MOTIR-2250 — the audit-coverage banner.
        'components/planning/AuditCoverageBanner.tsx',
        'lib/codeGraph/offboarding.ts',
        'lib/repositories/codeGraphOffboardingRepository.ts',
        'lib/services/codeGraphOffboardingService.ts',
        // Subtask MOTIR-2168 — the SWEEP that drains the queue through motir-ai.
        // The smallest of the three cards and the one that decides whether §14 is
        // real: an endpoint nobody calls and a queue nobody reads are both green.
        'lib/services/codeGraphOffboardSweepService.ts',
        'lib/jobs/definitions/codeGraphOffboardSweep.ts',
        // Subtask MOTIR-2197 — the LIVE-PROJECT read seam the offboarding backstop
        // subtracts from. Gated because a wrong answer here is not a bug report,
        // it is a deleted customer code index: the consumer removes what this
        // says is absent. (The route itself stays out, like every other
        // `app/api/internal/*` transport — the logic is what is gated.)
        'lib/codeGraph/liveProjects.ts',
        'lib/services/liveProjectsService.ts',
        'lib/internalApi/serviceAuth.ts',
        // Subtask MOTIR-2388 — the app-URL contract. Nine lines that decide what
        // origin every emailed link, OAuth callback and canonical URL carries,
        // and whose failure mode is a link to nowhere rather than an exception.
        // It had no coverage entry while the same policy was written out at five
        // call sites; now that they all route through it, it is worth gating.
        'lib/baseUrl.ts',

        // Subtask MOTIR-1163 — the product-analytics seam. Two accessors and a
        // three-line component, and the whole point of both is a decision that
        // is invisible when it goes wrong: unset environment must render NO tag
        // (the self-hoster's guarantee), and a blank secret must not render
        // `<script src="">`. Neither failure throws. Gated below.
        'lib/analytics.ts',
        'components/analytics/AnalyticsScript.tsx',

        // Story MOTIR-2384 · Subtask MOTIR-2394 (the story gate) — the OBJECT
        // STORE half of the hosting move. `lib/baseUrl.ts` above was the app-URL
        // half and joined the gate with its own card; these three are the seam
        // MOTIR-2389 rewrote and MOTIR-2404 widened, and until this card none of
        // them was in the report at all — so the ≥90% per-file gate did not apply
        // to the file every attachment, avatar and acceptance artifact in the
        // product is stored through. All three are GATED below, MEASURED first.
        //
        // ⚠️ `lib/blob/errors.ts` and `lib/blob/uploadClient.ts` are their
        // neighbours and are deliberately NOT listed — `lib/blob/**` would have
        // been one character shorter and wrong. Neither is code this Story wrote:
        // the first sits at 50% branches and the second at 0% (a browser-side
        // module no Node suite loads), and pinning either would gate work no card
        // here did. That is the same line `lib/services/projectAccessService.ts`
        // and `lib/repositories/projectMembershipRepository.ts` are held on above.
        'lib/blob/uploader.ts',
        'lib/blob/s3.ts',
        'lib/blob/referencedUrls.ts',

        // Story MOTIR-2588 · Subtask MOTIR-2681 — the project's MARK, end to end.
        // Four files the story wrote, none of which entered the report when their
        // own cards shipped, so the >=90% floor did not apply to any of them:
        // the policy pair the route and the field both read, the upload route,
        // the settings row, and the renderer. All four are GATED below, MEASURED
        // first (this card's whole first job).
        //
        // The two `app/**/...` forms are the route-group workaround the block
        // comment at the top of `coverage` explains — a literal `app/(authed)/...`
        // key matches no reported file and would gate nothing.
        'lib/projects/imageUpload.ts',
        'app/api/upload/project-image/route.ts',
        'app/**/_components/ProjectLogoField.tsx',
        'app/**/_components/ProjectMark.tsx',

        // MOTIR-2527 — the membership READER every access gate now routes
        // through. Small, and gated precisely because it is small: its whole job
        // is choosing a BINDING, and a branch of it going untested is a gate
        // silently reading with the wrong GUCs, which is the failure this file
        // was written to remove. MEASURED first — 8/8 statements, 4/4 functions,
        // 4/4 branches on this branch, from `tests/permissions/membershipGate.test.ts`.
        //
        // ⚠️ `lib/workspaces/**` would have been shorter and wrong, the same line
        // `lib/blob/**` is held on above: `middleware.ts` sits at ~5% and
        // `errors.ts` at ~21%, neither of them this card's code.
        'lib/workspaces/membershipGate.ts',

        // Bug MOTIR-2643 — the acceptance lane's VERDICT. It is a pure module
        // under `tests/`, which enters the report perfectly well (vitest 4's
        // default `coverage.exclude` is empty), and it had never been in it: the
        // instrument that decides which of four causes a red acceptance run had
        // was the one shipped surface with no floor under it. That is exactly
        // backwards for a module whose whole job is to be believed. GATED below,
        // MEASURED first — 100 / 90.9 / 100 / 100 (stmts / branches / funcs /
        // lines) on this branch; the two uncovered branches are the pre-existing
        // `?? ''` fallbacks behind a length check.
        //
        // MOTIR-2646 added the CONTENTION half to the same module — the shaping
        // helpers behind `contention.json`, which the lane now writes on every
        // run rather than only on a red one. Re-measured with the same suite:
        // 100 / 92.1 / 100 / 100. The one further uncovered branch is the
        // clamped index's `?? 0` in `percentileMs`, which
        // `noUncheckedIndexedAccess` requires and the clamp makes unreachable.
        'tests/e2e/_helpers/acceptance-diagnostics.ts',

        // Story MOTIR-2664 · Subtask MOTIR-2671 — the design-result surface. The
        // four feature cards each shipped their own unit tests, but NONE of them
        // touched this file, so not one of the story's new modules had ever
        // entered the coverage report and the ≥90% per-file gate had never
        // applied to any of it. That is this card's first job: put the surface
        // under the floor, MEASURE it, then pin the numbers in `thresholds`.
        //
        // ⚠️ The two app paths are written `app/**/…` deliberately. The files
        // live under the `(authed)` route group, and a literal `(authed)` in a
        // glob is parsed as an extglob alternation, so the pattern silently
        // matches NOTHING — an include that quietly covers zero files, plus a
        // threshold that quietly gates zero files.
        //
        // `lib/dto/designEvidence.ts` is deliberately ABSENT: it declares types
        // only (no runtime export), so it emits no statements to cover and a
        // floor on it would be a floor on nothing.
        'lib/services/designEvidenceService.ts',
        'lib/repositories/designEvidenceRepository.ts',
        'lib/mappers/designEvidenceMappers.ts',
        // Story MOTIR-5553 · Subtask MOTIR-5566 — the APPROVED-DESIGN READ and
        // the doors over it. `lib/dto/designAccess.ts` is deliberately ABSENT
        // for the same reason `dto/designEvidence.ts` is: it declares types
        // only, so a floor on it would be a floor on nothing.
        'lib/services/designAccessService.ts',
        'lib/mappers/designAccessMappers.ts',
        'lib/api/v1/workItems/designPresenter.ts',
        'lib/mcp/tools/getDesign.ts',
        'lib/mcp/tools/listDesigns.ts',
        'lib/mcp/payloads/designs.ts',
        'app/api/v1/work-items/**/designs/route.ts',
        'app/api/v1/work-items/**/design/route.ts',
        'app/api/v1/projects/**/designs/route.ts',
        'lib/designEvidence/errors.ts',
        'lib/designEvidence/publishAuth.ts',
        'lib/publishAuth/ciPublishAuth.ts',
        'lib/acceptanceEvidence/publishAuth.ts',
        'lib/blob/allowlist.ts',
        'app/api/work-items/**/design-evidence/route.ts',
        'app/api/work-items/**/design-evidence/upload-token/route.ts',
        'app/**/_components/DesignResultPanel.tsx',
        // Story MOTIR-5215 · Subtask MOTIR-5230 — the item page's Design result
        // SECTION (the call-to-action band, the kept states, and no local gate
        // state) and the island that carries an overlay decision to the status
        // rail. Neither was in any coverage list before this story. Written
        // `app/**/…` for the route-group reason recorded above (MOTIR-2449).
        'app/**/_components/DesignResultSection.tsx',
        'app/**/_components/DecidedGateStatusBridge.tsx',
        // Story MOTIR-2649 · Subtask MOTIR-2655 — every executable file the Home
        // story adds, named so the ≥90% per-file gate applies to code that is
        // brand new rather than only to code that was already reported.
        // `lib/dto/home.ts` is types only and emits no statements, so it is
        // deliberately absent: a threshold on a file with nothing to cover
        // passes vacuously, which is the failure MOTIR-2655 exists to prevent.
        'lib/workbench/**',
        'lib/services/homeService.ts',
        'lib/mappers/homeMappers.ts',
        // MOTIR-2653's page, renamed with the route by MOTIR-4782.
        // `app/**/workbench/**`, not `app/(authed)/workbench/**` — a literal
        // route-group path matches no reported file (the note above), so the
        // threshold would pass vacuously.
        'app/**/workbench/_components/**',
        // Story MOTIR-5238 — the two live modules that do NOT fall under the two
        // globs above: the watermark service lives with the other services, and
        // the stream route under `app/api/`. Both are new executable code this
        // story wrote and tested, so both are GATED in `thresholds` below rather
        // than report-only. MEASURED on this branch before being pinned, per this
        // file's own rule.
        'lib/services/workbenchWatermarkService.ts',
        'app/**/workbench/stream/route.ts',
        // Story MOTIR-2694 · Subtask MOTIR-2696 — the plan-tree embedding write
        // path. Every one of these is new code this card wrote and tested, so
        // all four are GATED in `thresholds` below rather than report-only;
        // measured at 100 lines / 100 functions / 100 branches on this branch
        // before being pinned, per the note above.
        'lib/workItems/embeddingDocument.ts',
        'lib/repositories/workItemEmbeddingRepository.ts',
        'lib/services/workItemEmbeddingsService.ts',
        'lib/services/workItemEmbeddingSweepService.ts',
        'lib/jobs/definitions/workItemEmbedding.ts',

        // Story MOTIR-2694 · Subtask MOTIR-2697 — the semantic candidate-finder
        // ROUTE. The whole file is new code this card wrote, so it is GATED
        // rather than report-only. It is worth gating for a reason beyond the
        // floor: nearly all of it is REFUSAL — the wrong-length vector, the
        // caller-supplied project, the clamp — and an unexercised refusal branch
        // is exactly the kind of code that quietly stops refusing.
        'app/api/internal/ai/similar-work-items/route.ts',

        // Story MOTIR-4053 · Subtask MOTIR-4076 — the PLANNER's `log_bug` sink:
        // the job-token create route and the service that enforces the bound
        // (`planner-files-tenant-bug.md` §3) under the plan's row lock. GATED,
        // for the reason `similar-work-items` is: nearly all of it is REFUSAL —
        // the token's project and only the token's, the volume cap, the parent
        // outside the project — and the tenant-isolation case is part of the
        // gated number rather than a test beside it. The service file also
        // holds the system-principal `fileBug` (MOTIR-1450), covered by
        // `tests/ai/work-items-route.test.ts`; both suites feed one number.
        'app/api/internal/ai/log-bug/route.ts',
        'lib/services/aiWorkItemsService.ts',

        // Story MOTIR-2694 · Subtask MOTIR-2698 — the two files the story CHANGED
        // rather than wrote, which its other subtasks therefore left out of the
        // report entirely. They are added on DIFFERENT terms, and the difference
        // is the point:
        //
        // `aiBoundaryMappers.ts` is GATED (thresholds below). It holds
        // `toSimilarWorkItemRows`, which the ADR
        // (`docs/decisions/plan-tree-embeddings.md` §2) names as the ENFORCEMENT
        // POINT of the keys-not-prose invariant — it constructs its three fields
        // by name so a column added to the ranking query cannot follow the row
        // onto the wire. A guard that load-bearing belongs behind the gate, and
        // MOTIR-2698 covered the module's remaining fallback arms
        // (`tests/ai/aiBoundaryMappers.test.ts`) to put it there rather than pin
        // a number the file could not meet. Measured 100 lines / 100 functions /
        // 92 branches on a SUBSET of the suite before pinning.
        'lib/mappers/aiBoundaryMappers.ts',
        // `aiBoundaryService.ts` is REPORT-ONLY, deliberately — the honest
        // sequence this block already prescribes elsewhere: measure first, pin
        // second. This story added ONE method to it (`findSimilarWorkItems`,
        // fully exercised), while the two arms that hold the file under the floor
        // are Story 7.5's defensive `ProjectNotFoundError` throws in
        // `readPlanTree` / `getSubtree`, which this card does not own. Gating the
        // whole file here would gate THIS story on ANOTHER story's debt, and the
        // way that ends is with someone loosening a threshold to make a build
        // pass. Read the number off CI and pin it when the 7.5 arms are covered.
        'lib/services/aiBoundaryService.ts',
        // Story MOTIR-2982 · Subtask MOTIR-2992 — the agent-authored plan surface.
        // Every file this story added or changed that carries decision logic; the
        // pure type/DTO modules it also touched carry none and are left out.
        //
        // ⚠️ The row's builder and component are written `app/**/plans/…`, NOT
        // `app/(authed)/plans/…`, for the reason the block comment at the top of
        // this section gives — a literal route-group path matches no reported
        // file and gates nothing.
        'lib/mcp/tools/authorPlan.ts',

        // Story MOTIR-3232 · Subtask MOTIR-3242 — the Plans surface, refined. Every
        // file the story ADDED that carries decision logic. (The two it changed
        // that were already gated, `planRowView.ts` and `PlanRow.tsx`, were
        // retired by MOTIR-6025 — see its entry below.)
        //
        // ⚠️ Written `app/**/plans/…` for the reason this section's header gives:
        // a literal `app/(authed)/plans/…` matches no reported file and would
        // gate nothing.
        //
        // What is deliberately NOT here: `PlanDetail.tsx`, `PlanReviewRail.tsx`,
        // `PlanReviewCanvas.tsx` and `ProjectRoadmapCanvas.tsx`. This story
        // CHANGED all four, and each carries far more logic than the story owns —
        // gating them here would gate THIS story on OTHER stories' coverage, which
        // is the trade the block above already refuses once.
        'lib/planning/planShape.ts',
        // Story MOTIR-6154 · Subtask MOTIR-6162 — the surface ARRIVAL. Where the
        // planning canvas opens, and the one move it makes when a target settles
        // later. MEASURED over this story's own specs (the two units, the canvas
        // suite, the overlay and host suites and the integration gate):
        //
        //   surfaceArrival.ts   100 / 100 / 100 / 100   → GATED below
        //   surfaceFollow.ts    100 / 100 / 100 / 100   → GATED below
        //   planArrival.ts      93.7 / 80.8 / 88.9 / 100 → REPORT-ONLY
        //
        // `planArrival.ts` is REPORT-ONLY by the rule the two blocks above state.
        // It is code this story MOVED rather than wrote (out of
        // `components/planning/PlanReviewCanvas.tsx`, byte for byte), its residual
        // branches are that function's pre-existing defensive arms, and the
        // measurement above is over THIS story's specs alone — the plan page's own
        // `plan-review-canvas*` suites exercise it too and will lift the number.
        // Pinning it blind is what that rule exists to prevent; publishing it is
        // the honest step, and the pin belongs to whoever reads the first CI run.
        'lib/planning/surfaceArrival.ts',
        'lib/planning/surfaceFollow.ts',
        'lib/planning/planArrival.ts',
        'lib/planning/planView.ts',
        'components/planning/PlanProposalList.tsx',
        'app/**/plans/_components/PlanStatusTabs.tsx',
        // Story MOTIR-6011 · Subtask MOTIR-6025 — `/plans` lists planning
        // SESSIONS. The plan-row files it retired (`planRowView.ts`,
        // `PlanRow.tsx`, `PlansList.tsx`, `lib/planning/planStatusFilter.ts`) left
        // this list with them; these are their successors.
        'lib/planning/planSessionFilter.ts',
        'lib/services/planSessionsService.ts',
        'lib/mappers/planSessionMappers.ts',
        'app/**/plans/sessionRowView.ts',
        'app/**/plans/_components/SessionRow.tsx',
        'app/**/plans/_components/SessionsList.tsx',

        // Story MOTIR-6043 · Subtask MOTIR-6045 — WHERE a plans row opens. The
        // rule is the reason to gate it: ONE function answers for the Plans row
        // above and the To-approve row in `components/approvals/`, so a branch
        // of it that nothing exercises is a branch on which the two surfaces can
        // silently disagree — which is the whole defect the story removes. Both
        // files are new here and both are GATED in `thresholds` below, measured
        // first, as this block prescribes throughout. `ApprovalRow.tsx` keeps its
        // existing report-only place (see the approvals block below); it is a
        // CALLER of the rule, not the rule.
        'lib/planning/planDestination.ts',
        'components/planning/PlanDestinationTag.tsx',

        // Story MOTIR-8590 · Subtask MOTIR-8596 — FOLLOW THE PLANNER. The driven-step
        // derivation, the follow control, the typewriter's pure half, the field
        // that types and the live reduced-motion read: each new with the story,
        // each GATED in `thresholds` below, measured first.
        'lib/planning/plannerDrive.ts',
        'components/planning/FollowPlannerControl.tsx',
        'lib/planning/typeIn.ts',
        'components/planning/TypeInText.tsx',
        'lib/hooks/usePrefersReducedMotion.ts',

        // Story MOTIR-2999 · Subtask MOTIR-3008 — the `implemented` lifecycle.
        // The story's decision code, in one place: what a pull request delivers
        // (`changeRequestWorkItems`), what a green build promotes (`ciPromotion`),
        // the workflow the whole thing is expressed in (`defaultWorkflow`, and the
        // token map that paints it), and the one chip that tells Implemented apart
        // from the three statuses it shares a category with (`StatusPill`).
        // All five are new or newly-decisive in this story and all five are GATED
        // in `thresholds` below, measured first (the sequence this block
        // prescribes throughout).
        //
        // ⚠️ The story ALSO changed `changeRequestStatusSync`, `changeRequestCiFeedback`
        // and `githubWebhookService`, which are NOT listed here. Those are large
        // pre-existing files this story widened, and `workItemsService.ts` — the
        // one it changed that IS gated — is already in `include` above. Adding the
        // other three would gate this story on code no card here wrote, which is
        // the trap the `aiBoundaryService.ts` note names: it ends with someone
        // loosening a threshold to make a build pass.
        'lib/services/ciPromotion.ts',
        'lib/services/changeRequestWorkItems.ts',
        'lib/workflows/defaultWorkflow.ts',
        'lib/workflows/statusColor.ts',
        'components/issues/StatusPill.tsx',
        // Bug MOTIR-3209 — the ONE place that decides which of a commit's
        // workflow runs still gets a vote. It is the whole of that card's
        // decision and it is read by BOTH derivations, so an untested branch
        // here is a wrong CI verdict on a card, silently.
        //
        // ⚠️ `changeRequestCiFeedback.ts`, `prCiState.ts` and the two providers
        // the card also touched are deliberately NOT added: they are pre-existing
        // files this fix widened, and gating them here would gate the fix on code
        // no card wrote — the trap the `aiBoundaryService.ts` note above names.
        'lib/github/checkSuites.ts',
        // Story 8.12 · Subtask MOTIR-3612 — the passkeys card, its state owner,
        // and the one rule about `'passkey'` in a status DTO. MEASURED before
        // being pinned, per the note at the top of this list.
        //
        // ⚠️ `TwoFactorManager.tsx` is deliberately NOT here. This card widened
        // it (a controlled status, a slot, a read-only method row) but did not
        // write it, and gating 800 lines of pre-existing enrolment flow on a
        // change to three of them is the trap the `changeRequestCiFeedback.ts`
        // note above names. `security/page.tsx` is out because nobody has
        // measured it — not because a route component cannot be measured. (The
        // "standing reason" this note used to cite, *no `app/**/page.tsx` is in
        // this report*, was false when written: see the correction in the
        // MOTIR-3449 block at the top of this list.)
        'app/**/settings/account/_components/PasskeyManager.tsx',
        'app/**/settings/account/_components/AccountSecurityPanes.tsx',
        'app/**/settings/account/_components/twoFactorMethods.ts',
        // Story 8.12 · Subtask MOTIR-3613 — the sign-in card's passwordless
        // route. `SignInCard.tsx` itself is NOT added: this card put one control
        // in it and did not write the 400-line two-step state machine around it.
        'app/**/_components/PasskeySignInButton.tsx',
        // Story 8.12 · Subtask MOTIR-3614 — the story's server-side ADDITIONS.
        //
        // ⚠️ THE FILES THIS STORY WIDENED ARE NOT HERE, and that is the same
        // call the `changeRequestCiFeedback.ts` note above makes:
        // `lib/auth/index.ts`, `lib/auth/client.ts`, `lib/dto/twoFactor.ts`,
        // `lib/mappers/twoFactorMappers.ts` and `lib/services/twoFactorService.ts`
        // are pre-existing files this story added to, and gating them here would
        // gate the addition on code no card in this story wrote.
        // `lib/dto/passkey.ts` is types only — it emits nothing to instrument.
        'lib/auth/passkeyConfig.ts',
        'lib/repositories/passkeyRepository.ts',
        'lib/mappers/passkeyMappers.ts',
        'lib/services/passkeyService.ts',

        // ── Task MOTIR-3568 — THE FIRST AUTHED ROUTE COMPONENTS IN THIS REPORT ──
        //
        // One page from each of MOTIR-3440's five families, rendered by
        // `tests/helpers/serverPageHarness.tsx` in `tests/navigation/render/`.
        // The decision that put them here — and why the alternative, declaring
        // route components permanently out of scope, was weighed and rejected —
        // is `docs/decisions/rsc-render-harness.md`.
        //
        // ⚠️ REPORT-ONLY, and deliberately: NOT ONE of these has a `thresholds`
        // entry. That is this list's own sequence — measure, then pin — and it is
        // the sequence the notes above keep citing while the number stays
        // unmeasured. CI publishes a per-file figure for these five on the first
        // run that carries this diff; pinning happens in a follow-up card, off
        // that figure, and NEVER at a value chosen to make a build pass. A number
        // below the floor is a finding to state, not a bar to lower — and TWO of
        // these five are below it on the diff-scoped measurement recorded in the
        // ADR (`code-health` at 81.66/63.33/72.72/81.48, `automation` at
        // 94.44/70/75/93.75), which is exactly why none of them is pinned here.
        //
        // ⚠️ A DYNAMIC SEGMENT IS ESCAPED — `\\[id\\]`, not `[id]`. Unescaped,
        // `[id]` is a character CLASS to picomatch (one char, `i` or `d`), and
        // that it happens to match the literal directory today is a coincidence
        // to rely on exactly as much as the `app/(authed)/…` form the note at the
        // top of this block warns about. `tests/coverage-gate-globs.test.ts`
        // fails the build on either mistake.
        'app/**/settings/project/automation/page.tsx',
        'app/**/plans/\\[id\\]/page.tsx',
        'app/**/items/\\[key\\]/edit/page.tsx',
        // ⚠️ `code/page.tsx`, NOT `code-health/page.tsx` (MOTIR-1768). The audit
        // became one section of the Code room and `/code-health` is now a
        // three-line permanent redirect — a file these numbers would gate
        // trivially while the surface they were measured against went
        // unmeasured.
        'app/**/code/page.tsx',
        'app/**/invite/accept/page.tsx',
        // Story MOTIR-4237 · Subtask MOTIR-4240 — THE HELP MENU, and the context
        // the story widened to give it a door. Both were built by MOTIR-4239 and
        // neither was in this report, so the per-file floor did not reach the
        // one surface this story actually adds.
        //
        // MEASURED FIRST, on this branch, before either was pinned — this list's
        // own sequence. `pnpm vitest run --coverage` over the fifteen component
        // specs that reach them:
        //
        //   HelpMenu.tsx               100 stmts · 100 branch · 100 fn · 100 lines
        //   CommandPaletteProvider.tsx 100 stmts · 100 branch · 100 fn · 100 lines
        //
        // Both GATED in `thresholds` below, at the 90 floor rather than at the
        // measured 100, so a later refactor has room without anyone loosening a
        // gate to make a build pass.
        'app/**/_components/HelpMenu.tsx',
        'app/**/_components/CommandPaletteProvider.tsx',
        // `SidebarNav.tsx` — GATED on all four axes since MOTIR-4368. It was
        // three-plus-a-finding for the length of one card, and the two halves of
        // that story are kept together below because the DISTINCTION is the
        // point: MOTIR-4324 deleted a branch no fixture could honestly reach,
        // MOTIR-4368 wrote the specs for three arms a person can reach in the
        // running app. Two coverage shortfalls on one file, identical in a
        // report and opposite in kind.
        //
        // ⚠️ WHAT THIS COMMENT SAID UNTIL MOTIR-4324, kept because the number it
        // quotes is the before half of this card's evidence: the file was
        // report-only at 97.22 stmts · 84 branch · 88.88 fn · 97.22 lines (292
        // component specs, 3 405 tests), and the ONE uncovered function was
        // `SoonChip` — a badge that rendered only for a settings-nav entry
        // carrying a reserved-slot flag no registry set any more. Covering it
        // meant fabricating a registry entry no shipped surface has, so the
        // number stood as a finding rather than a bar to lower.
        //
        // MOTIR-4324 retired that branch instead of covering it: `SoonChip`, the
        // reserved-slot flag on both nav registries, the filters it fed and its
        // two `Soon` catalog strings are gone. MEASURED AFTER, over the fourteen
        // specs that reach this file — a LOWER BOUND on the full-suite number,
        // since coverage over more specs can only rise:
        //
        //   vitest run --coverage \
        //     --coverage.include='app/**/_components/SidebarNav.tsx' \
        //     <the 14 specs naming SidebarNav / the authed layout>
        //   SidebarNav.tsx  100 stmts · 86.95 branch · 100 fn · 100 lines
        //
        // Statements, functions and lines were at 100 and GATED at the 90 floor.
        // BRANCHES was not, and the remaining cause was a different one from the
        // one MOTIR-4324 closed: the three uncovered arms were the DRAWER
        // variant of the account-settings and project-settings rails
        // (`collapsed={isDrawer ? false : undefined}` at both settings returns)
        // plus the five-clause `active:` predicate on the workspace-settings
        // row. Reachable, real, and untested — a coverage gap, not dead code —
        // so neither that card's to write nor a bar to lower. Filed as
        // MOTIR-4368, which is what closed it.
        //
        // MOTIR-4368 — the same fourteen specs, RE-MEASURED first (the before
        // half above reproduced exactly on `origin/main` @ `da4c4078b`, at
        // 40/46 branches, uncovered 236,261,463) and then again after the specs
        // it added:
        //
        //   SidebarNav.tsx  100 stmts · 100 branch · 100 fn · 100 lines
        //   Branches: 100% ( 46/46 ) — was 86.95% ( 40/46 )
        //
        // The six arms: the drawer arm of each settings return
        // (`sidebar-nav-rail-head.test.tsx`, which asserts BOTH directions — the
        // drawer ignores a collapsed store, the rail follows it) and the four
        // negations of the workspace-settings predicate, each driven at its own
        // sub-route (`SidebarNav-settings-door.test.tsx`). `branches` is pinned
        // at the 90 floor in `thresholds` below, beside its three siblings.
        'app/**/_components/SidebarNav.tsx',
        // MOTIR-4518 — the preflight that asks whether the address an index
        // container is GIVEN can work where the container runs. It is gated on
        // its own rather than blended into a service's number because it is a
        // GUARD: the fault it exists to catch produced no failing signal
        // anywhere for two weeks, so a regression in it would restore exactly
        // that silence. MEASURED FIRST, over the one spec that reaches it — a
        // LOWER BOUND on the full-suite number, since coverage over more specs
        // can only rise:
        //
        //   vitest run --coverage \
        //     --coverage.include='lib/ai/containerAiAddress.ts' \
        //     tests/ciFleet/containerAiAddress.test.ts
        //   Statements 100% (34/34) · Branches 100% (24/24)
        //   Functions  100% (5/5)   · Lines    100% (31/31)
        //
        // GATED at the 90 floor rather than at the measured 100, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/ai/containerAiAddress.ts',
        // ── Story MOTIR-4337 (an INTERNAL org bills like a customer) · the
        //    story's Vitest gate, MOTIR-4573. Every file below was MEASURED on
        //    this branch before being pinned, with:
        //
        //      pnpm vitest run --coverage tests/internalBillingStoryGate.test.tsx \
        //        tests/platform/ tests/ai/tenantOrg.test.ts \
        //        tests/components/classification-bar.test.tsx \
        //        tests/components/searchFigures.test.ts \
        //        tests/components/org-usage-search-spend.test.tsx \
        //        tests/components/org-usage-internal-billing.test.tsx
        //
        //    Statements 99.31 · Branches 96.10 · Functions 100 · Lines 100
        //    across the ten, with every file at 100 on all four axes except
        //    `ClassificationBar.tsx` (95.83 / 85.71 / 100 / 100) and
        //    `searchUsage.ts` (100 / 93.75 / 100 / 100).
        //
        // ⚠️ THE STORY'S TWO `page.tsx` FILES ARE NOT HERE, and that is the same
        //    stated gap the MOTIR-3449 note above records rather than a new one:
        //    `admin/tenants/page.tsx` and `admin/tenants/[orgId]/page.tsx` are
        //    async Server Components, and covering one means awaiting it through
        //    `serverPageHarness`. They are asserted structurally by the gate's
        //    own guards and end to end by `tests/e2e/admin-org-lookup.spec.ts`.
        //    They stay out until somebody measures them, which is this list's
        //    own rule.
        'lib/repositories/platformOrganizationRepository.ts',
        'lib/services/platformBillingClassificationService.ts',
        'lib/mappers/platformMappers.ts',
        'lib/platform/auditActions.ts',
        'lib/platform/errors.ts',
        'lib/ai/tenantOrg.ts',
        'app/**/admin/tenants/[orgId]/actions.ts',
        'app/**/admin/tenants/[orgId]/_components/ClassificationBar.tsx',
        'app/**/organization/usage/_components/searchUsage.ts',
        'app/**/organization/billing/_components/searchFigures.ts',

        // ── Story MOTIR-4725 · the planning workspace as an OVERLAY ──────────
        // Its story gate (MOTIR-4733). Every file here was MEASURED on this
        // branch before being pinned below, over `tests/planning/`,
        // `tests/integration/planning/`, `tests/api/planning-anchor-route.test.ts`
        // and the four component suites the story ships.
        //
        // ⚠️ `lib/planning/launcher.ts` is NOT repeated — it has been gated since
        // MOTIR-1299 and its entry is above.
        'lib/planning/planPending.ts',
        'lib/planning/planningAnchorClient.ts',
        'lib/hooks/useOpenPlanningWorkspace.ts',
        'components/planning/PlanningWorkspaceOverlay.tsx',
        'components/planning/PlanCloseGuard.tsx',
        'components/planning/PlanningWorkspaceHost.tsx',
        // MOTIR-5251 — what Approve says while it runs (design Part XXV).
        'components/planning/PlanApproveProgress.tsx',
        // Story MOTIR-6155 · Subtask MOTIR-6186 — the plan page's List | Canvas
        // pane, lifted into ONE component that the plan page AND the planning
        // surface both mount. It is this story's own file and carries only the
        // switch and the choice of body, so gating it gates nothing but this
        // story's work — which is exactly the trade this section's header asks
        // for, and the reason `PlanDetail.tsx` is still deliberately absent
        // (see the note above): that island carries far more logic than this
        // story owns. Measured at 100 / 100 / 100 by MOTIR-6187's gate.
        'components/planning/PlanProposalViews.tsx',
        'app/api/work-items/planning-anchor/route.ts',
        // The `/planning` FORWARD. A route-group path is entered as `app/**/…`
        // (the note above) — `app/(authed)/planning/page.tsx` resolves to nothing.
        'app/**/planning/page.tsx',
        // ── Story MOTIR-4778 · APPROVAL GATES — the assembled surface ────────
        // Subtask MOTIR-4796, the story's own vitest gate. This surface shipped
        // across seven cards and was in NO coverage `include` at all, so it was
        // absent from the report and ungated — the state the per-file gate
        // exists to make impossible for exactly this kind of multi-card surface.
        //
        // MEASURED on this branch before being pinned, per this list's own rule.
        // The set went 92.06 / 83.62 / 95.08 / 93.44 (stmts / branches / funcs /
        // lines) to 99.19 / 95.49 / 100 / 100, with every arm that remains
        // uncovered carrying a written verdict — a `v8 ignore` citing the test
        // that pins its invariant, or a pinned threshold naming why the obvious
        // test is one the RLS call-site guard forbids.
        'lib/services/approvalGatesService.ts',
        'lib/repositories/approvalGateRepository.ts',
        'lib/approvalGates/registry.ts',
        'lib/approvalGates/designResultHandler.ts',
        'lib/approvalGates/errors.ts',
        'lib/approvalGates/refusals.ts',
        // Story MOTIR-4887 · MOTIR-5530 — the manual-flip guard's new surface: the
        // ONE held-move rule the guard and the status control share, the pure
        // intent resolver, and the held notice / refusal pieces the item page,
        // quick view, edit page, board and list render. Measured before pinning.
        'lib/approvalGates/heldMoves.ts',
        'lib/workflows/statusIntent.ts',
        'components/issues/StatusHeldNotice.tsx',
        'components/issues/heldRefusal.ts',
        'components/issues/useStatusHeld.ts',
        'app/**/boards/_components/BoardHeldRefusal.tsx',
        // Story MOTIR-6017 · MOTIR-6269 — THE PLAN HOLD's one statement of the rule
        // (AMENDMENT 21 §1), shared by the funnel's refusal and the up-front read.
        // The three components above carry its surface; measured before pinning.
        'lib/plans/planHold.ts',
        // Bug MOTIR-5191 — ADR §2's routing rule and the *waiting on* display
        // name, shared by the item page's read and the Approvals queue. Two pure
        // functions with one job each, so they are measured and pinned here per
        // this list's own rule: MEASURED at 100 / 100 / 100 / 100 on this branch.
        'lib/approvalGates/routing.ts',
        'lib/mappers/approvalGateMappers.ts',
        // Story MOTIR-4882 · MOTIR-5519 — the MERGE story's files that carry logic:
        // its settings door, the provenance
        // resolver, the run-target resolver, gate raise/withdraw, the merge entry
        // point, and auto mode with its job. MEASURED on this branch before being
        // pinned, per the note above — 100 / 100 / 100 / 100 on every one of the eight —
        // over `tests/git`, `tests/github/{mergeGates,pullRequestMergeEntry,
        // pullRequestAutoMerge,pullRequestMergeRecord,appRoleForRepo,ciGreenPromotion,
        // mergeStoryEdges}`, `tests/integration/mergeStoryJourney`,
        // `tests/approval-gate-{settings-door-read,coverage-floor}`,
        // `tests/components/approval-gate-control` and `tests/howToTest/howToTestService`.
        //
        // `lib/git/providers/github.ts` is NOT pinned here: it is the whole GitHub
        // provider, and this story added only its merge and enqueue paths. Those paths
        // are fully covered (`tests/git/mergeChangeRequest{,Edges}.test.ts`); the file's
        // remaining arms belong to the provider's pre-existing readers and parsers,
        // whose own stories own their numbers.
        // ⚠️ `pullRequestMergeHandler.ts` WAS PINNED HERE and was deleted with its kind
        // (Bug MOTIR-5603 · MOTIR-5616). Its logic did not move: the handler contract went
        // with the retirement, and the one function that outlived it,
        // `pullRequestSubjectVersion`, now sits in `deliverySetVersion.ts` beside the set
        // version — already covered by the suites listed above.
        'lib/approvalGates/settingsDoor.ts',
        'lib/github/appRoleForRepo.ts',
        'lib/services/runTarget.ts',
        'lib/services/mergeGates.ts',
        'lib/services/pullRequestMergeService.ts',
        'lib/services/pullRequestAutoMergeService.ts',
        'lib/jobs/definitions/pullRequestAutoMerge.ts',
        'components/approvals/ApprovalGateControl.tsx',
        'components/approvals/portRenderStatus.tsx',
        // ── Story MOTIR-4909 · MOTIR-5486 — APPROVE AND MERGE, the story's own vitest gate.
        // The `pull_request_approval` handler and its set version, the raise/withdraw
        // service, the member-version parser the frame reads, and the Development frame and
        // its outcome slot. `pullRequestMergeService.ts`, `mergeGates.ts`,
        // `ApprovalGateControl.tsx` and `ApprovalsList.tsx` — which this story also widened —
        // are already pinned above. MEASURED on the parent branch before being pinned, over
        // `tests/github/{pullRequestApprovalGates,approveAndMerge}`,
        // `tests/integration/approveAndMergeStoryJourney`, `tests/approvalGates/memberVersion`,
        // `tests/approval-gate-pull-request-approval-kind` and
        // `tests/components/{development-gate-verbs,development-block,approval-gate-flush-layout}`:
        // 100 / 100 / 100 / 100 on every file except `DevelopmentGateFrame.tsx`, whose two
        // `!actions` guards and one empty-name fallback are unreachable from any caller
        // (a frame handed no actions renders no verb and no Retry to press).
        //
        // `lib/approvalGates/subjectSummary.ts` is deliberately NOT added: it is the Approvals
        // queue's pre-existing loader file, and this story added only its `pull_request_approval`
        // loader, whose arms `approval-gate-pull-request-approval-kind` covers.
        'lib/approvalGates/pullRequestApprovalHandler.ts',
        'lib/approvalGates/deliverySetVersion.ts',
        'lib/approvalGates/memberVersion.ts',
        'lib/services/pullRequestApprovalGates.ts',
        // ── Story MOTIR-4907 · MOTIR-5680 — THE DECISION GATE, the story's own vitest gate.
        // The capture, the subject and its resolver, the handler, the document read and its
        // mapper, and the port's slot. MEASURED on the parent branch before being pinned,
        // over `tests/approvalGates`, `tests/github/decision*`,
        // `tests/components/{decision-port,approval-row-decision}` and
        // `tests/api/approval-gate-route`: 100 / 100 / 100 / 100 for the subject, the
        // document rules, the resolver and the read; the handler 95.7 / 92.9 / 90.9 / 94.7,
        // the capture 100 / 90.9 / 100 / 100, the mapper 100 / 90 / 100 / 100 and the slot
        // 100 / 94.7 / 100 / 100. The shared files the story widened (`gateSet.ts`,
        // `mergeGates.ts`, `pullRequestMergeService.ts`, `ciPromotion.ts`,
        // `DevelopmentGateFrame.tsx`, `ApprovalRow.tsx`) keep their existing pins or their
        // report-only place, and are not re-pinned here; `subjectSummary.ts` stays out for
        // the reason recorded above.
        'lib/approvalGates/decisionApprovalHandler.ts',
        'lib/approvalGates/decisionDocumentResolver.ts',
        'lib/approvalGates/decisionSubject.ts',
        'lib/approvalGates/decisionDocument.ts',
        'lib/services/decisionDocumentCaptureService.ts',
        'lib/services/decisionDocumentService.ts',
        'lib/mappers/decisionDocumentMappers.ts',
        'components/github/DecisionDocumentSlot.tsx',
        // ── Bug MOTIR-5652 · MOTIR-5660 / MOTIR-5662 — THE GATE-SET PREDICATE and its
        // one loader. Added to `include`, deliberately NOT to `thresholds`, by this
        // config's own rule: MEASURED on this branch over `tests/approvalGates`,
        // `tests/github/{pullRequestApprovalGates,approveAndMerge,mergeGates}` and
        // `tests/approval-gate-pull-request-approval-kind` at 100 / 100 / 100 / 100 for
        // `gateSet.ts` and 100 / 87.5 / 100 / 100 for `gateSetFor.ts`, whose one
        // uncovered branch is the `mode?.prMergeMode ?? null` fallback for a project row
        // that cannot be missing here. Publishing the number without pinning a floor
        // under it is the honest reading of that measurement.
        'lib/approvalGates/gateSet.ts',
        'lib/services/gateSetFor.ts',
        // ── Story MOTIR-5232 · MOTIR-5234 / MOTIR-5236 — THE STAMP, the one definition of
        // what a decision is about. Pure; covered by `tests/approvalGates/stamp.test.ts`,
        // `tests/approval-gate-stale-subject.test.ts` and
        // `tests/integration/approvals/stale-stamp-seam.test.ts`. Pinned below at the floor.
        'lib/approvalGates/stamp.ts',
        'components/github/DevelopmentGateFrame.tsx',
        'components/github/MergeOutcomeSlot.tsx',
        // THE ACCEPTANCE GATE (Story MOTIR-4949 · Subtasks MOTIR-4950 / MOTIR-5790 /
        // MOTIR-5791). MEASURED on this branch over `tests/attachments/acceptance-gate`,
        // `tests/approvalGates/{acceptanceStoryGate,acceptanceOnePress}` and
        // `tests/components/{development-acceptance-primary,acceptance-panel,acceptance-receipt-and-band}`:
        // 96.87 / 95 / 100 / 96.55 for the handler (its `no_status_in_target_category` arm
        // needs a project whose done category is empty, which no fixture builds), 100 / 90 /
        // 100 / 100 for the receipt player, and 100 across the slot and the band.
        'lib/approvalGates/acceptanceResultHandler.ts',
        'components/acceptance/AcceptanceReceiptPlayer.tsx',
        'components/acceptance/AcceptanceDevelopmentSlot.tsx',
        'components/approvals/GateCallToActionBand.tsx',
        // ── Story MOTIR-5460 · HAND A RED PULL REQUEST TO AN AGENT ────────────
        // Subtask MOTIR-5467, the story's vitest gate. The repair claim's service
        // and route, and the Development block's fix part — MEASURED first, at
        // 100 / 100 / 100 / 100 each, by `tests/ready/claimWorkItemRepair`,
        // `tests/ciMetering/ciDispatchGate`, `tests/api/v1/work-item-repair-route`
        // and `tests/components/repair-fix-part`. The shared files the story also
        // touched keep their existing pins (`dispatchRunService.ts`) or were
        // never in the report (the repositories, the v1 schema), and are not
        // widened here.
        'lib/services/workItemRepairService.ts',
        'app/api/v1/work-items/[key]/repair/route.ts',
        'components/github/RepairFixPart.tsx',
        // ── Story MOTIR-6526 · A RUN THAT DIES KEEPS ITS WORK ─────────────────
        // Subtask MOTIR-6537, the story's vitest gate. The files the story CREATED
        // on the server — the one liveness rule, the continue claim's service and
        // route, the heartbeat route, the lapse sweep's job and the marker's
        // Development part. MEASURED on the parent branch first, over `tests/runs`,
        // `tests/runLivenessSweep`, `tests/api/v1/dispatch-run-heartbeat`,
        // `tests/ready/claimWorkItemContinue`, `tests/ready/continueViewReasons`,
        // `tests/api/v1/work-item-continue-route`, `tests/integration/runDied*`,
        // `tests/components/continue-part` and `tests/dispatch/dispatchPromptContinue`:
        // the service 100 / 91.2 br, the part 100 / 94.1 br, the rest 100. The
        // shared files it changed keep their existing pins (`dispatchRunService.ts`)
        // or were never in the report, and are not widened here.
        'lib/runs/runLiveness.ts',
        'lib/services/workItemContinueService.ts',
        'app/api/v1/work-items/[key]/continue/route.ts',
        'app/api/v1/dispatch-runs/[id]/heartbeat/route.ts',
        'lib/jobs/definitions/runLivenessSweep.ts',
        'components/github/ContinuePart.tsx',
        // ── Story MOTIR-5461 · A PULL REQUEST THE MERGE QUEUE EJECTS ───────────
        // Subtask MOTIR-5636, the story's vitest gate. The files the story CREATED —
        // the ejection and failing-check services, the reason table and its error, the
        // exit line and the auto part. MEASURED on the parent branch before being
        // pinned, over `tests/github`, `tests/integration/mergeQueueEjectionStoryGate`,
        // `tests/components/development-ejection` and `tests/integration/approvals`:
        // exit service 97.7 / 91.1 br, check service 97.9 / 95.5 br, the two
        // components 98.2 / 96.2 and 100 / 92.9 br, the rest 100. The shared files it
        // changed keep their existing pins (`pullRequestMergeService.ts`,
        // `DevelopmentGateFrame.tsx`, `MergeOutcomeSlot.tsx`). Not pinned:
        // `githubMergeQueueAttemptRepository.ts`, whose one uncovered arm is the
        // empty-input guard its only caller never reaches (50% of two branches).
        'lib/services/mergeQueueExitService.ts',
        'lib/services/mergeQueueCheckService.ts',
        'lib/mergeQueue/queueExit.ts',
        'lib/mergeQueue/errors.ts',
        'components/github/QueueExitLine.tsx',
        'components/github/QueueExitAutoPart.tsx',
        // ── Story MOTIR-5214 · DECIDE IT FULL SCREEN — the approval overlay ───
        // Subtask MOTIR-5226, the story's own vitest gate. The overlay, its
        // address and client read, the row's settle signal and the route were in
        // NO `include`, so they were absent from the report and gated nothing.
        // `ApprovalsList.tsx` is already reported through
        // `app/**/workbench/_components/**` above, and is PINNED below because
        // this story rewrote its central interaction. MEASURED on the parent
        // branch before being pinned; the numbers are beside each threshold.
        'components/approvals/ApprovalOverlay.tsx',
        'lib/approvals/overlayAddress.ts',
        'lib/approvals/approvalOverlayClient.ts',
        'lib/approvals/decidedGates.ts',
        'app/api/work-items/approval-gate/route.ts',
        // ── Story MOTIR-5299 · THE APPROVAL RECORDS ROOM ─────────────────────
        // Subtask MOTIR-5303, the story's own vitest gate. The room's page, its
        // list and the ONE approvals row MOTIR-5302 extracted were in no
        // `include`. The service, repository and mapper the read extended are
        // already reported and pinned above (Story MOTIR-4778), so they are not
        // re-added here.
        //
        // ⚠️ `app/*/…`, NOT `app/**/…`, for the page. `app/**/approvals/page.tsx`
        // ALSO matches `app/(authed)/settings/project/approvals/page.tsx` — the
        // settings room of the same name — so the key would gate a file this story
        // never touched. One `*` is exactly one segment, the `(authed)` group.
        'app/*/approvals/page.tsx',
        'app/*/approvals/_components/ApprovalRecordsList.tsx',
        'components/approvals/ApprovalRow.tsx',
        // Bug MOTIR-5150 — the PR-REFERENCE parser the link picker's query
        // grammar gained. A pure function with one job, so it is measured and
        // pinned here, per the note at the top of this list.
        //
        // ⚠️ `lib/repositories/githubPullRequestRepository.ts` is deliberately
        // NOT added. This card widened one method of it by an arm; gating the
        // whole repository on that is the trap the `changeRequestCiFeedback.ts`
        // note above names. The arm's own branches are covered by
        // `tests/github/explicitPrLink.test.ts`.
        'lib/github/prReferenceQuery.ts',
        // Story MOTIR-4928 · Subtask MOTIR-5263 — the monitor-connection surface
        // (the store, the provider seam, connect/disconnect, the credential
        // lifecycle). MEASURED on the parent branch before being pinned: every file
        // at 100 on all four axes except `providers/sentry.ts` branches (98.5 — the
        // implicit else of an arm `v8 ignore`d with its invariant test named).
        //
        // `lib/monitors/types.ts` is deliberately NOT here: it declares types only,
        // so it compiles to nothing and a threshold on it would gate an empty map.
        'lib/monitors/connectResult.ts',
        'lib/monitors/connectState.ts',
        'lib/monitors/errorResponse.ts',
        'lib/monitors/errors.ts',
        'lib/monitors/index.ts',
        'lib/monitors/provider.ts',
        'lib/monitors/registry.ts',
        'lib/monitors/returnBanner.ts',
        'lib/monitors/returnSurface.ts',
        'lib/monitors/tokenCrypto.ts',
        'lib/monitors/providers/fake.ts',
        'lib/monitors/providers/sentry.ts',
        'lib/services/monitorConnectionService.ts',
        'lib/services/monitorCredentialService.ts',
        'lib/repositories/monitorConnectionRepository.ts',
        'lib/repositories/monitorInstallationRepository.ts',
        'lib/mappers/monitorMappers.ts',
        // Story MOTIR-4929 · Subtask MOTIR-5583 — the monitor-INGESTION surface
        // (the store, the reconciler, the poll, the scheduled job, the room's
        // poll line). MEASURED on the parent branch before being pinned, over the
        // story's own suites: every file at 100 on all four axes except
        // `pollLine.ts` branches (94.7) and `MonitoringRoom.tsx` (96.5 lines /
        // 97.9 branches / 96.3 functions — the picker's `onBound`, whose bind is
        // the picker's own suite's). The ingestion routes are not added: a route
        // glob here also gates the connect story's sibling route files.
        'lib/monitors/levels.ts',
        'lib/monitors/pollLine.ts',
        'lib/repositories/monitorIssueRepository.ts',
        'lib/services/monitorIngestionService.ts',
        'lib/jobs/definitions/monitorIssueReconcile.ts',
        'app/**/settings/project/monitoring/_components/MonitoringRoom.tsx',
        // Story MOTIR-4931 · Subtask MOTIR-5708 — the monitor-SYNC surface (the
        // resolve-back service and its job, the sync vocabulary). MEASURED on the
        // parent branch before being pinned, over the story's own suites: all three
        // at 100 on all four axes. The files this story CHANGED that were already
        // listed above stay pinned where they are (`monitorIngestionService.ts` now
        // measures 100/100/100/100, `monitorIssueRepository.ts` and
        // `monitorConnectionRepository.ts` 100, `MonitoringRoom.tsx` 97.5 lines /
        // 95.9 branches / 97.4 functions).
        'lib/services/monitorSyncService.ts',
        'lib/jobs/definitions/monitorIssueResolve.ts',
        'lib/monitors/syncStates.ts',
        // Story MOTIR-4932 · Subtask MOTIR-5733 — the error-link surface (the read,
        // the hand-made link, and the work-item page's Errors section). MEASURED on
        // the parent branch before being pinned, over the story's own suites: every
        // file below at 100 on all four axes. The files this story CHANGED that were
        // already listed above stay pinned where they are (`monitorIssueRepository.ts`
        // and `monitorIngestionService.ts` measure 100/100/100/100 again; the two
        // provider files keep their pre-existing arms, fake 97.8 / sentry 99.2
        // branches). `lib/dto/monitorIssueLink.ts` declares types only and is not here;
        // nor is `actions.ts`, a shared module this story widened by three actions —
        // gating the whole file on them is the `changeRequestCiFeedback.ts` trap —
        // whose arms `monitorIssueLinkActions.test.ts` covers.
        'lib/services/monitorIssueService.ts',
        'lib/services/monitorIssueLinkService.ts',
        'lib/mappers/monitorIssueLinkMappers.ts',
        'app/**/items/[key]/_components/MonitorErrorsSection.tsx',
        'app/**/items/[key]/_components/MonitorErrorsLinkControl.tsx',
        'app/**/items/[key]/_components/MonitorErrorsCard.tsx',
        // Story MOTIR-4930 · Subtask MOTIR-5852 — the bug-ENRICHMENT surface: the
        // trigger's job, the dispatch + apply service, and the answer parser.
        // MEASURED on the parent branch before being pinned, over the story's own
        // suites (the figures are on MOTIR-5852). The files this story only WIDENED
        // and that are already listed above stay pinned where they are:
        // `providers/sentry.ts` / `providers/fake.ts` (the frames),
        // `monitorIssueRepository.ts` (two leaves), `monitorIngestionService.ts`
        // (one provenance field), `workItemRevisionRepository.ts` (one read).
        'lib/jobs/definitions/monitorBugEnrich.ts',
        'lib/services/monitorBugEnrichmentService.ts',
        'lib/ai/authoredBug.ts',
        // Story MOTIR-5975 · Subtask MOTIR-5984 — the EVIDENCE surface: the seam's
        // filters, the three-outcome read, the as-filed predicate, the backfill
        // job and the Errors row's evidence block. MEASURED on the parent branch
        // before being pinned, over the story's own suites plus its gate
        // (`monitorEvidenceStoryGate.test.ts`): evidence.ts, asFiled.ts and the
        // backfill job 100 on all four; monitorContextRead.ts 100 / 94.7 branches;
        // MonitorErrorEvidence.tsx 97.7 / 96.6 / 97.2 / 100. The files this story
        // only WIDENED keep their existing pins (the provider pair, the repository,
        // the two monitor services, the reconcile job, MonitorErrorsSection.tsx —
        // all re-measured ≥ 95 on every axis) or stay ungated (`promptTemplate.ts`,
        // `dispatchPromptService.ts`: the one-new-arm trap named above).
        'lib/monitors/evidence.ts',
        'lib/monitors/asFiled.ts',
        'lib/services/monitorContextRead.ts',
        'lib/jobs/definitions/monitorBugEnrichBackfill.ts',
        'app/**/items/[key]/_components/MonitorErrorEvidence.tsx',
        // ── Story MOTIR-4906 · HOW TO TEST per RUN ─────────────────────────────
        // Its story gate (MOTIR-5337). Every file the story ADDED that compiles to
        // something, MEASURED on the parent branch before being pinned below, over
        // the story's own suites plus the gate (`tests/howToTest/storyGate*.test.*`).
        //
        // ⚠️ `lib/dto/howToTest.ts` and `lib/dto/testInstructions.ts` are NOT here:
        // they declare types only, so a threshold on them would gate an empty map.
        // The files the story only WIDENED (`promptTemplate.ts`, the two webhook
        // services, `dispatchRunService.ts`, `DevelopmentSection.tsx`, …) are not
        // added either — gating a whole pre-existing module on one new arm is the
        // trap the `changeRequestCiFeedback.ts` note above names. The CLI's
        // `closeOutHowToTest.ts` is gated in `packages/cli/vitest.config.ts`.
        'lib/testInstructions/caps.ts',
        'lib/testInstructions/errors.ts',
        'lib/repositories/testInstructionsRepository.ts',
        'lib/repositories/testInstructionsRepoRepository.ts',
        'lib/repositories/repoDeploymentRepository.ts',
        // Motir's own pull-request previews (Story MOTIR-5766 · MOTIR-5772).
        'lib/preview/errors.ts',
        'lib/preview/config.ts',
        'lib/preview/hostName.ts',
        'lib/preview/states.ts',
        'lib/preview/previewDatabase.ts',
        'lib/repositories/previewDeploymentRepository.ts',
        // Switching previews on and off (MOTIR-5775).
        'lib/preview/enablement.ts',
        'lib/github/repositoryActionsConfig.ts',
        'lib/services/previewEnablementService.ts',
        // The preview lifecycle (MOTIR-5776).
        'lib/preview/lifecycleEvents.ts',
        'lib/github/previewDeployments.ts',
        'lib/services/previewLifecycleService.ts',
        'lib/jobs/definitions/previewLifecycle.ts',
        // Preview usage metered into the CI pool (MOTIR-5777).
        'lib/ciMetering/previewRates.ts',
        'lib/repositories/previewUsageRepository.ts',
        'lib/services/ciPreviewUsageMeterService.ts',
        'lib/jobs/definitions/previewUsageAccrual.ts',
        // The hourly enablement sweep (MOTIR-5775), run as a job by the story
        // gate (MOTIR-5780), and the preview gate itself (MOTIR-5779). The two
        // preview pages sit under route groups whose `(` is glob syntax to the
        // coverage matcher (see above), so they are measured through the frame
        // they render and opened by `tests/components/preview-gate-pages.test.tsx`.
        'lib/jobs/definitions/previewEnablementSweep.ts',
        'lib/preview/gate.ts',
        'lib/preview/gateProxy.ts',
        'lib/preview/failureReason.ts',
        'lib/services/previewGateService.ts',
        'lib/repositories/previewGateAdmissionRepository.ts',
        'components/preview/PreviewGateFrame.tsx',
        'lib/mappers/testInstructionsMappers.ts',
        'lib/services/testInstructionsService.ts',
        'lib/services/repoDeploymentService.ts',
        'lib/services/howToTestService.ts',
        'lib/mcp/tools/publishTestInstructions.ts',
        'lib/dispatch/runCloseOutPrompt.ts',
        'app/api/v1/dispatch-runs/[id]/close-out-prompt/route.ts',
        'app/api/v1/work-items/[key]/how-to-test/route.ts',
        'components/howToTest/HowToTestBlock.tsx',
        'components/markdown/CopyableCodeBlock.tsx',
        // ── Story MOTIR-5469 · SEE WHICH CARDS ARE RED ─────────────────────────
        // Its story gate (MOTIR-5477). The files the story ADDED, MEASURED on the
        // parent branch before being pinned below.
        //
        // ⚠️ THE STORY'S OWN CARD NAMES MORE FILES THAN THIS, and the difference is
        // the rule this list has applied throughout rather than an omission.
        // MOTIR-5477 §1 asks for coverage over "the recompute and its callers …,
        // the filter registry, SQL column map and value editor … the board, list,
        // tree and Workbench mappers". All of those were MEASURED (the numbers are
        // in the `thresholds` note below); only the ones this story WROTE are
        // gated. `changeRequestCiFeedback.ts`, `githubPullRequestService.ts`,
        // `workItemRepository.ts`, `boardsService.ts`, `lib/filters/registry.ts`,
        // `AdvancedFilterValueEditor.tsx`, `workItemMappers.ts`, `boardMappers.ts`,
        // `deliverySet.ts` and `prCiState.ts` are large pre-existing files this
        // story widened by a function or a case each, and gating them here would
        // gate this story on code no card in it wrote — the trap the
        // `changeRequestCiFeedback.ts` note above names by name, for this exact
        // file. `lib/mappers/homeMappers.ts` and `app/**/workbench/…/workbenchRows.ts`
        // are already in this list from MOTIR-4782 and stay as they are.
        'lib/services/deliveryVerdict.ts',
        'lib/services/workItemCiStateBackfillService.ts',
        'components/github/ciStateMeta.ts',
        'components/github/CiStateBadge.tsx',
        // ── Story MOTIR-6588 · TO FIX ON THE WORKBENCH (gate MOTIR-6606) ──
        // The modules this story WROTE, measured before being pinned (the numbers
        // are in the `thresholds` note). The pre-existing files it widened by a call
        // or a slice each — `workItemRepository`, `workItemsService`, the writer
        // services, `homeService` — are not gated here, for the reason MOTIR-5469's
        // note above gives.
        'lib/services/fixReasonService.ts',
        'lib/services/repairPredicate.ts',
        'lib/workItems/fixReason.ts',
        'lib/mappers/fixReasonMappers.ts',
        'lib/services/workItemFixReasonBackfillService.ts',
        'app/**/workbench/_components/WorkbenchFixLine.tsx',
        // Story MOTIR-7589 · ONE ENTRY PER RUN — the entry resolver it added.
        'lib/services/fixGroupService.ts',
        // ── Story MOTIR-6156 · THE MULTI-LINE COMPOSER (Subtask MOTIR-6239) ──
        // MEASURED on this branch before being pinned, per this list's own rule:
        // 97.11 statements / 90.43 branches / 100 functions / 100 lines, over the
        // eleven planning component suites. Gated at the project floor below.
        //
        // ⚠️ TWO FILES THE CARD NAMES ARE NOT HERE, and both are dispositions
        // rather than omissions.
        //
        // `packages/design-system/src/components/ui/Textarea.tsx` is NOT
        // MEASURABLE from this lane. motir-core imports the BUILT package
        // (`@motir/design-system` → `dist/`), so no test here loads that source
        // file; an entry for it would report 0% and gate the whole suite red for
        // ever. The package's own vitest config declares no coverage at all, so
        // there is no lane to move it to either. Its behaviour is covered by
        // MOTIR-6237's 24 cases over the shipped artifact
        // (`tests/components/textarea-autogrow.test.tsx`) plus the default-is-a-
        // contract and caller-pinning cases in
        // `tests/integration/planning/multilineComposerStoryGate.test.tsx`.
        //
        // `components/planning/PlanChangeRail.tsx` is deliberately NOT gated.
        // MOTIR-6239 asks for coverage on its CHANGED LINES — three classes on
        // the user bubble — and those are asserted directly
        // (`tests/components/plan-change-rail.test.tsx`, the MOTIR-6238 suite).
        // The file itself measured 78.19 / 71.86 / 80.64 / 78.33: it is a
        // 1,300-line rail this story widened by one className, and gating it
        // here would gate this story on code no card in it wrote — the trap the
        // `changeRequestCiFeedback.ts` note above names.
        'components/planning/PlanChangeComposer.tsx',
        // ── Story MOTIR-6179 · THE ROOMS' VIEW-ANY KEYS (Subtask MOTIR-6336) ──
        // The four modules this story CREATED for the Mine / Project rooms,
        // measured on this branch with their own suites before being pinned: all
        // four at 100 / 100 / 100 / 100 (`RoomViewSwitch`'s `next === value` guard
        // is reached only through a stubbed `Segmented`, which
        // `room-view-switch-guard.test.tsx` supplies). The services the story
        // widened (`approvalGatesService`, `planSessionsService`,
        // `dispatchRunService`, `apiTokensService`, `lib/tokens/grant.ts`,
        // `lib/settings/projectNavAccess.ts`, `lib/permissions/**`) keep the floors
        // already pinned for them below; their new branches are walked, per actor,
        // by `tests/integration/rooms/roomsStoryGate.test.ts`.
        'lib/rooms/roomView.ts',
        'lib/approvalGates/actPermissions.ts',
        'lib/runs/runsAddress.ts',
        'components/rooms/RoomViewSwitch.tsx',
        // ── Story MOTIR-6166 · PERMISSION-GATED SURFACES (Subtask MOTIR-6177) ──
        // The five surfaces this story CREATED or reshaped around a permission
        // branch, measured on this branch with the story's specs before being
        // pinned: every one at 100 / 100 / 100 / 100 except `CreateIssueRow`,
        // 100 / 94.73 / 100 / 100 (its residue is the in-flight double-submit
        // guard's second arm).
        //
        // ⚠️ THE LARGE CONTAINERS THE STORY EDITED ARE NOT HERE, and that is a
        // disposition: `CoreFieldsPanel` (865 lines), `BoardContainer`,
        // `BacklogContainer`, `AppCommandPalette`, `OrgControl` and `SprintHeader`
        // each took a few lines of gating; gating their whole files would gate
        // this story on code no card in it wrote (the `PlanChangeComposer` note
        // above). Their NEW lines are asserted, Viewer and Member, by
        // `tests/integration/permissions/gatedSurfacesStoryGate.test.tsx` and the
        // per-surface suites, and the ones already listed (`TodoListSection`,
        // `QuickViewRailEdit`, `SidebarNav`, `ShellTierNav`, the two nav
        // registries) keep their existing floors.
        'app/**/_components/FieldCard.tsx',
        'app/**/boards/_components/ColumnActionsMenu.tsx',
        'app/**/boards/_components/UnmappedStatusesTray.tsx',
        'app/**/backlog/_components/SelectionBar.tsx',
        'app/**/backlog/_components/CreateIssueRow.tsx',
        // ── Story MOTIR-6068 · A REFUSED DECISION OPENS THE PLANNER (Subtask MOTIR-6212) ──
        // The six files this story CREATED, measured on this branch with the story's
        // specs (`refusalSeed`, `approval-gate-planning-seed-route`,
        // `planningSeedClient`, `refusal-replan`, and the seam
        // `tests/integration/planning/refusalReplanSeam.test.ts`) before being pinned:
        // every one at 100 / 100 / 100 / 100. The two re-throws of a real fault are
        // driven, not ignored (`approval-gate-planning-seed-route.test.ts`, the
        // defensive-arms describe).
        //
        // ⚠️ THE EXISTING FILES THE STORY EDITED ARE NOT ADDED HERE. The ones already
        // gated (`planChangeSessionsService`, its repository, `contextualPlanningService`,
        // `planSessionMappers`, the launcher, the overlay, the host, the conversation
        // hook, `ApprovalGateControl`, `ApprovalOverlay`, `DevelopmentGateFrame`) keep
        // their floors, and each still clears 90 with this story's lines in it. The
        // ungated ones (`ChoiceGate` 100 · `DecisionConfirmGate` 94.6 branches ·
        // `SessionRow` 93.7 branches, and `PlanChangeRail` — deliberately ungated, see
        // the MOTIR-6239 note above) have every line this story wrote covered.
        //
        // The route is written with `**`, not `[id]`, for the character-class reason
        // recorded above.
        'lib/planning/refusalSeed.ts',
        'lib/services/planningSeedService.ts',
        'app/api/approval-gates/**/planning-seed/route.ts',
        'lib/planning/planningSeedClient.ts',
        'components/approvals/RefusalReplan.tsx',
        'components/approvals/useOpenRefusalReplan.ts',
        // ── Story MOTIR-6169 · ACCESS LIVES ON THE PROJECT (Subtask MOTIR-6552) ──
        // The files this story CREATED, measured on this branch with the story's
        // specs before being pinned: every one at 100 lines / functions /
        // statements, and 100 branches except `AccessScopeCell` (92.9) and
        // `InviteAccessFields` (94.1). The access-scope route is already gated by
        // the members-route glob above.
        //
        // ⚠️ THE EXISTING FILES THE STORY EDITED ARE NOT ADDED HERE, as MOTIR-6212's
        // note sets out: the gated ones (`projectAccessService`, `notificationsService`,
        // `lib/permissions/**`, `roleErrorResponse`, …) keep their floors; for the
        // ungated ones the story's own LINES were measured (diff coverage over the
        // story's specs), and the recorded gaps are defensive arms named in the
        // MOTIR-6552 PR notes. The ~45 pages whose one changed line routes a null
        // active project to `/no-project` are held by a structural guard instead
        // (`tests/permissions/projectAccessArchitecture.test.ts`) and by the e2e walk.
        'lib/projects/accessMode.ts',
        'app/**/no-project/page.tsx',
        'app/**/_components/NoProjectShell.tsx',
        'app/**/_components/NoProjectCreateButton.tsx',
        'app/**/members/_components/MemberChips.tsx',
        'app/**/members/_components/MembersOnlyConfirmDialog.tsx',
        'app/**/workspace/_components/AccessScopeCell.tsx',
        'app/**/workspace/_components/InviteAccessFields.tsx',
        'app/api/projects/**/access/preview/route.ts',
        // ── Story MOTIR-6973 · CONNECT MOTIR TO CLAUDE WITH OAUTH (gate MOTIR-6987) ──
        // The OAuth door for MCP: discovery documents, the register/authorize policy,
        // the consent screen and route, Connected apps, and the connection service.
        // MEASURED on the parent branch over the story's own suites (10 files / 218
        // tests, including the SDK-driven journey in tests/integration/oauth): every
        // file at or above 90 on all four axes; the closest are the branches of
        // ConsentScreen 91.2, oauthConnectionMappers 91.3 and mcpOAuthPolicy 91.7.
        // GATED at the project floor in `thresholds`.
        'app/**/oauth/_components/ConsentRefused.tsx',
        'app/**/oauth/_components/ConsentScreen.tsx',
        'app/**/oauth/_components/consentParts.tsx',
        'app/**/oauth/consent/page.tsx',
        'app/**/oauth/error/page.tsx',
        'app/**/settings/account/_components/ConnectedAppsSection.tsx',
        'app/**/settings/account/_components/PermissionPicker.tsx',
        'app/**/settings/account/_components/connectedAppsClient.ts',
        'app/.well-known/oauth-authorization-server/\\[\\[...path\\]\\]/route.ts',
        'app/.well-known/oauth-protected-resource/\\[\\[...path\\]\\]/route.ts',
        'app/api/account/oauth-connections/\\[id\\]/route.ts',
        'app/api/account/oauth-connections/route.ts',
        'app/api/oauth/consent/route.ts',
        'lib/auth/mcpOAuthPolicy.ts',
        'lib/jobs/definitions/oauthSweep.ts',
        'lib/mappers/oauthConnectionMappers.ts',
        'lib/oauth/authorizeReturn.ts',
        'lib/oauth/config.ts',
        'lib/oauth/consentContext.ts',
        'lib/oauth/cors.ts',
        'lib/oauth/errors.ts',
        'lib/oauth/metadata.ts',
        'lib/oauth/redirectPolicy.ts',
        'lib/oauth/wellKnownPaths.ts',
        'lib/repositories/oauthAccessTokenRepository.ts',
        'lib/repositories/oauthClientRepository.ts',
        'lib/repositories/oauthRefreshTokenRepository.ts',
        'lib/services/oauthConnectionsService.ts',
        'lib/services/oauthSweepService.ts',
        // ── Story MOTIR-7170 · CLAUDE SHOWS AS VERIFIED (gate MOTIR-7175) ──
        // The files the story ADDED: the lazy resource seed of the better-auth 1.7
        // upgrade, and the Client ID Metadata Document transport + verification.
        // The OAuth files it widened (the policy hook, config, errors, redirect
        // policy, the connection mapper and services) are already gated in the
        // block above. `lib/auth/index.ts`, `lib/auth/authMail.ts`,
        // `lib/export/personalDataSections.ts` and `lib/repositories/userRepository.ts`
        // are pre-existing files it touched, not gated here (the passkey story's
        // call, below). MEASURED on the parent branch over the story's suites
        // (tests/oauth, tests/integration/oauth, tests/integration/auth,
        // tests/auth, tests/jobs/oauthSweep): all three at 100 on every axis;
        // the closest of the widened files is mcpOAuthPolicy's branches at 98.0.
        // GATED at the project floor in `thresholds`.
        'lib/auth/lazyResourceSeed.ts',
        'lib/oauth/clientMetadataDocument.ts',
        'lib/oauth/discoveredClient.ts',
        // ── Story MOTIR-7471 · FILES ON A GUIDE TURN (Subtask MOTIR-7487) ─────
        // The three modules this story CREATED, measured on the parent branch
        // over the story's suites (tests/ai/guideFiles, guideTurnFilesIntegration,
        // tests/components/guide-turn-files): guideFiles 100 on every axis;
        // useGuideTurnFiles 98.07 / 91.3 / 100 / 100; GuideTurnFiles 94 / 95 /
        // 93.75 / 95.55 (stmts / branches / funcs / lines). GATED at the project
        // floor in `thresholds`.
        //
        // The guide files the story WIDENED are not gated here, the
        // `PlanChangeComposer` note's reasoning: their new lines are walked by
        // the same suites, and gating them whole would gate this story on the
        // earlier guide story's defensive branches. Measured over every guide
        // suite: aiGuideService 97.27 / 84.33 / 100 / 97.89, guideLandingService
        // 93.53 / 81 / 100 / 96.7, app/api/ai/guide/route 90.24 / 86.66 / 100 /
        // 97.22. `PlanChangeComposer` (widened with the attach slot) keeps its
        // own floor above and measured 97.67 / 93.93 / 95.45 / 98.66.
        'lib/ai/guideFiles.ts',
        'lib/hooks/useGuideTurnFiles.ts',
        'components/planning/GuideTurnFiles.tsx',
        // ── Story MOTIR-7730 · THE APP IN ELEVEN LANGUAGES (gate MOTIR-7760) ──
        // The changed LANGUAGE SURFACE, enumerated from
        // `git diff --name-only origin/main...HEAD` on the story branch, not from
        // a list: the request's resolution (`i18n/request.ts`), every changed
        // `lib/i18n/` module (the matcher and the four-step order live in
        // `acceptLanguage.ts` / `resolveLocale.ts`, the sign-up seed's request
        // reading in `seedLocale.ts`), the sign-in alignment (`localeSync.ts`),
        // the translation script and its shape gate (`scripts/i18n/`), the
        // signed-out language control and the date formatter. MEASURED FIRST on
        // the story branch over the story's suites — tests/integration/i18n,
        // tests/i18n, tests/auth/locale-*, tests/auth/user-locale-field,
        // tests/i18n-catalog, tests/i18n-message-shape, tests/i18n-source-record,
        // tests/components/auth-language-control, tests/services/users-*-locale
        // (stmts / branches / funcs / lines):
        //
        //   i18n/request.ts                    100   / 100   / 100   / 100
        //   lib/i18n/acceptLanguage.ts          96.87 /  90.47 / 100   / 100
        //   lib/i18n/actions.ts                100   / 100   / 100   / 100
        //   lib/i18n/englishFallback.ts        100   / 100   / 100   / 100
        //   lib/i18n/localeCookie.ts           100   / 100   / 100   / 100
        //   lib/i18n/locales.ts                100   / 100   / 100   / 100
        //   lib/i18n/messages.ts               100   / 100   / 100   / 100
        //   lib/i18n/resolveLocale.ts          100   / 100   / 100   / 100
        //   lib/i18n/seedLocale.ts              93.75 / 100   / 100   /  91.66
        //   lib/auth/localeSync.ts              93.75 /  91.66 / 100   /  91.66
        //   lib/utils/datetime.ts              100   / 100   / 100   / 100
        //   scripts/i18n/catalogue.ts           99.44 /  98.31 / 100   /  99.39
        //   scripts/i18n/glossary.ts           100   /  97.56 / 100   / 100
        //   scripts/i18n/messageShape.ts       100   /  98.68 / 100   / 100
        //   scripts/i18n/sourceRecord.ts       100   /  98.07 / 100   / 100
        //   AuthLanguageControl.tsx             96.96 /  94.44 / 100   / 100
        //
        // Eight of those sat under the floor after the integration test alone and
        // were brought up by cases in their sibling test files (before → after):
        // actions 90.9/87.5/100/100 → 100; englishFallback 87.5/90.9/100/100 →
        // 100; messages 100/83.33/100/100 → 100; seedLocale 87.5/87.5/100/91.66
        // → 93.75/100/100/91.66; datetime 66.66/50/50/66.66 → 100; catalogue
        // 93.85/79.83/96.29/95.73 → 99.44/98.31/100/99.39; glossary
        // 94.28/82.92/100/95.23 → 100/97.56/100/100; messageShape
        // 95.68/88.15/100/96.26 → 100/98.68/100/100; sourceRecord
        // 90.76/78.84/86.66/96 → 100/98.07/100/100; AuthLanguageControl
        // 96.96/83.33/100/100 → 96.96/94.44/100/100. GATED at the project floor
        // in `thresholds`.
        //
        // ⚠️ `lib/auth/index.ts` is REPORT-ONLY, by the MOTIR-7170 block's rule
        // above for the same file: it is the whole Better-Auth wiring, and the
        // story changed three things in it (the `locale` additional field, the
        // `user.create.before` seed and the `localeSync()` plugin entry). Over the
        // story's suites the FILE measures 50.98 / 38.46 / 53.33 / 52.38, which
        // describes the other stories' hooks, not this one; the seed hook the
        // story added is reached 27 times with all three arms of its
        // `ctx?.headers ?? ctx?.request?.headers ?? null` taken. Gating the file
        // whole would gate this story on code it did not write.
        'i18n/request.ts',
        'lib/i18n/acceptLanguage.ts',
        'lib/i18n/actions.ts',
        'lib/i18n/englishFallback.ts',
        'lib/i18n/localeCookie.ts',
        'lib/i18n/locales.ts',
        'lib/i18n/messages.ts',
        'lib/i18n/resolveLocale.ts',
        'lib/i18n/seedLocale.ts',
        'lib/auth/localeSync.ts',
        'lib/auth/index.ts',
        'lib/utils/datetime.ts',
        'scripts/i18n/catalogue.ts',
        'scripts/i18n/glossary.ts',
        'scripts/i18n/messageShape.ts',
        'scripts/i18n/sourceRecord.ts',
        'components/i18n/AuthLanguageControl.tsx',
        // ── Story MOTIR-5266 · /ready's Expand opens the planning overlay (MOTIR-7877) ──
        // The nudge became a LAUNCHER (MOTIR-7876): it reads the nudge, hides on ✕,
        // and shallowPushes the overlay's start-turn address. Measured on this branch
        // over `tests/components/expansion-nudge-banner.test.tsx` and
        // `tests/ready/expandNudgeGuards.test.tsx`: 100 / 95 / 100 / 100 (statements /
        // branches / functions / lines). The one arm not taken is `handleDismiss`'s
        // empty-`dismissKey` guard: ✕ renders only once a nudge with a key is
        // held, so the key is never empty when it is pressed.
        //
        // Written `app/**/…`, never the literal `app/(authed)/…` (MOTIR-2449).
        //
        // The story's other changed files keep the floors already pinned for them
        // (`lib/planning/launcher.ts`, the overlay, the host, the conversation hook);
        // `PlanChangeRail.tsx` stays deliberately ungated (the MOTIR-6239 note), its
        // start-turn lines asserted by `tests/components/planning-start-turn.test.tsx`
        // and `tests/integration/planning/readyExpandStartTurnGate.test.tsx`.
        'app/**/ready/_components/ExpansionNudgeBanner.tsx',
        // Story MOTIR-8238 · MOTIR-8256 — the restyled onboarding surface: the
        // shared layout primitives, the hero's waves, the entrance, the top bar,
        // and the two `(onboarding)` pages the story changed (written `app/**/…`,
        // per the route-group note above). Each is pinned at ≥ 90 on every metric
        // in `thresholds` below, MEASURED on this branch against the onboarding
        // component specs. `MigrateWizard.tsx` / `ImportWizard.tsx` are not gated
        // here: the story restyled their frames without changing their behaviour.
        'components/onboarding/layout/OnboardingBrandBar.tsx',
        'components/onboarding/layout/OnboardingHero.tsx',
        'components/onboarding/layout/OnboardingLinkOut.tsx',
        'components/onboarding/layout/OnboardingSection.tsx',
        'components/onboarding/layout/OnboardingWizardBar.tsx',
        'components/onboarding/layout/OnboardingWorkBand.tsx',
        'components/onboarding/layout/SectionArt.tsx',
        'components/onboarding/layout/WarmButton.tsx',
        'components/onboarding/layout/index.ts',
        'components/brand/HeroWaves.tsx',
        'components/onboarding/OnboardingEntrance.tsx',
        'components/onboarding/OnboardingTopBar.tsx',
        'app/**/onboarding/how-it-works/page.tsx',
        'app/**/onboarding/direction/\\[tier\\]/page.tsx',
        // ── Story MOTIR-8537 · the observability path (MOTIR-8556) ──
        // Every module the story's five code cards added, plus the two monitoring
        // modules they changed that had no entry. Pinned in `thresholds` below at
        // the level the existing `lib/monitoring/*` entries carry (branches /
        // functions / lines 90, read at e855430). `scripts/pg-top-statements.ts`
        // is the CLI entry and stays out, as `generate-mcp-tool-schemas.ts` does
        // beside its gated `generateMcpToolSchemas.ts`.
        'lib/monitoring/config.ts',
        'lib/monitoring/serverInit.ts',
        'lib/monitoring/transactionSpan.ts',
        'lib/monitoring/requestLabel.ts',
        'lib/monitoring/requestDbTiming.ts',
        'lib/monitoring/metricsServer.ts',
        // ── Story MOTIR-9710 · the CloudWatch publishers (MOTIR-9889) ──
        // The three modules the story added and the two it edited. MEASURED on this
        // branch over `tests/monitoring/{cloudwatchMetrics,watchdogMetrics,breachTask,
        // processPressure,loopBlockWatchdog,monitoringUnsetGuarantee,transactionStall*}`
        // (stmts / branch / fn / lines): cloudwatchMetrics 98.0 / 94.7 / 100 / 100,
        // breachTask 100 / 100 / 100 / 100, processPressure 94.1 / 88.1 / 100 / 100,
        // watchdogMetrics 98.2 / 86.2 / 100 / 97.9, loopBlockWatchdog 89.4 / 62.7 /
        // 97.1 / 98.7. Pinned in `thresholds` below. The three under the floor are
        // pinned at what they measure, and the gap is v8's, not the tests': every
        // guard of the form `if (x) return …;` reports its fall-through as an unhit
        // branch even where the statements after it ran (watchdogMetrics' four
        // start/stop guards; most of loopBlockWatchdog's 23 classifier guards, each
        // exercised both ways by `loopBlockWatchdog.test.ts`'s pure cases). The one
        // real miss in watchdogMetrics is `readFileSync('/proc/stat')` throwing,
        // which only happens off Linux.
        'lib/monitoring/cloudwatchMetrics.ts',
        'lib/monitoring/watchdogMetrics.ts',
        'lib/monitoring/breachTask.ts',
        'lib/monitoring/processPressure.ts',
        'lib/monitoring/loopBlockWatchdog.ts',
        'lib/mcp/toolTracing.ts',
        'scripts/pgTopStatements.ts',
        // Story MOTIR-8651 · BUILD THROUGH (Subtask MOTIR-8662) — the two NEW modules the
        // discrepancy record added: the service that validates the points and writes the
        // comment and the `discrepancy_recorded` finding in one transaction, and the MCP
        // tool over it. Pinned in `thresholds` below at the project floor (90 on every
        // metric). ⚠️ NOT MEASURED LOCALLY — this sandbox has no database, and both are
        // exercised only through DB-backed specs (`tests/runDiscrepancyService.test.ts`,
        // `tests/mcp/record-run-discrepancy.test.ts`, and this story's gate
        // `tests/integration/runs/buildThroughStoryGate.test.ts`), so the coverage job on
        // the pull request is the first measurement. Raise to the measured number, or
        // fix the spec, if it reads lower. The shared files the story changed
        // (`dispatchRunService.ts`, `commentsService.ts`, `promptTemplate.ts`,
        // `RunFindings.tsx`, `dispatchRunEventRepository.ts`) carry other stories' code and
        // are not newly pinned (the MOTIR-6633 rule).
        'lib/services/runDiscrepancyService.ts',
        'lib/mcp/tools/recordRunDiscrepancy.ts',
        'scripts/pgTopStatementsQuery.ts',
        // Story MOTIR-8538 · MOTIR-8681 — THE LOAD-TEST INSTRUMENT below the k6
        // runtime: every `loadtest/` module that loads under node (seed, manifest,
        // the pure scenario helpers, profile, run command, capture, report).
        // MEASURED on this branch with the story's specs (`tests/loadtest/**`),
        // then pinned at the project floor; the PR body carries each file's four
        // numbers. EXCLUDED BY NAME, because they import `k6/*` and cannot load
        // under vitest — the end-to-end lane (MOTIR-8682) runs them with a real k6:
        // `loadtest/k6/main.js`, `loadtest/k6/scenarios/*.js`,
        // `loadtest/k6/lib/mcpClient.js`, `loadtest/k6/lib/manifest.js`.
        'loadtest/staging/sideEffectSwitches.ts',
        'loadtest/preflight/sideEffects.ts',
        'loadtest/lib/endpointHost.ts',
        'loadtest/seed/shape.ts',
        'loadtest/seed/seed.ts',
        'loadtest/seed/reset.ts',
        'loadtest/seed/manifest.ts',
        'loadtest/seed/guard.ts',
        'loadtest/seed/tenants.ts',
        'loadtest/k6/lib/agents.js',
        'loadtest/k6/lib/classify.js',
        'loadtest/k6/lib/holdStream.js',
        'loadtest/k6/lib/iterations.js',
        'loadtest/k6/lib/outcome.js',
        'loadtest/k6/lib/readerOutcome.js',
        'loadtest/k6/lib/readerProfile.js',
        'loadtest/k6/lib/readerUsers.js',
        'loadtest/k6/lib/record.js',
        'loadtest/k6/lib/streamTally.js',
        'loadtest/k6/lib/windowReadGate.js',
        'loadtest/k6/runs/classify.js',
        'loadtest/k6/runs/metrics.js',
        'loadtest/k6/runs/sequence.js',
        'loadtest/profiles/schema.ts',
        'loadtest/profiles/resolve.ts',
        'loadtest/run/fly.ts',
        'loadtest/run/generator.ts',
        'loadtest/run/neon.ts',
        'loadtest/run/pinned.ts',
        'loadtest/run/runRecord.ts',
        'loadtest/run/run.ts',
        'loadtest/capture/appLogs.ts',
        'loadtest/capture/dbSampler.ts',
        'loadtest/capture/index.ts',
        'loadtest/capture/neon.ts',
        'loadtest/capture/pgss.ts',
        'loadtest/capture/redact.ts',
        'loadtest/report/bottleneck.ts',
        'loadtest/report/inputs.ts',
        'loadtest/report/k6Points.ts',
        'loadtest/report/mix.ts',
        'loadtest/report/p2028.ts',
        'loadtest/report/prometheus.ts',
        'loadtest/report/proxyShed.ts',
        'loadtest/report/render.ts',
        'loadtest/report/report.ts',
        'loadtest/report/scaleOut.ts',
        'loadtest/report/thresholds.ts',
        // Story MOTIR-8982 · MOTIR-9075 — the run overlay's split, exit button, List
        // pane and leg label (the files the story CREATED). REPORTED here; each is
        // gated PER FILE in `vitest.coverage.runs-overlay-parity.config.ts` at the
        // reading MEASURED 2026-10-19 over that lane's suites: every file 100 on all
        // four metrics except `ResizableSplit.tsx` (91.86 / 80.89 / 93.33 / 98.09)
        // and `usePersistedPaneWidth.ts` (92.45 / 77.27 / 93.33 / 95.23), whose
        // uncovered branches are environment guards. Wildcard-safe: no literal
        // `(authed)`.
        'components/split/ResizableSplit.tsx',
        'components/split/SplitDivider.tsx',
        'lib/hooks/usePersistedPaneWidth.ts',
        'components/ui/OverlayExitButton.tsx',
        'app/**/runs/_components/runFrameRows.ts',
        'lib/runs/legLabel.ts',
        'app/**/runs/_components/RunSetListPane.tsx',
        'app/**/runs/_components/useRunSetLevel.ts',
        // Story MOTIR-9219 · MOTIR-9295 — the plan offer's NEW core modules (the offer
        // lifecycle rule, the mid-planning route rule, the offer and start services,
        // the rail row and its decisions, and the two answer doors). MEASURED
        // 2026-10-22 on the story branch against the story's own specs
        // (`tests/integration/planning/planOffer{Seam,Refusals}`,
        // `planChangeAnswerOfferStore`, `tests/planning/planOffer*`,
        // `tests/components/plan-offer-rail`, `use-plan-offer-answer`,
        // `tests/ai/planChangeAnswerOffer`), lines / branches / functions / statements:
        // planOffer.ts, offerRestart.ts, planOfferRow.ts and both routes 100 on all
        // four; PlanOffer.tsx 100 / 94.11 / 100 / 100; planOfferService.ts 96.34 /
        // 90.54 / 100 / 94.89; planOfferStartService.ts 96.77 / 88.35 / 100 / 94.41.
        // Pinned at the floor below, except the start service's BRANCHES, pinned at
        // 88: its 17 uncovered branches are lock-race arms (a claim lost between the
        // read and the write, a release finding its turn gone) and project-guard
        // catches the keyed read cannot raise, which no single-process test reaches
        // without mocking the repository the gate exists to exercise. The shared files
        // the story only changed (`aiAskService.ts`, `planChangeSessionsService.ts`,
        // `PlanChangeRail.tsx`, …) keep the pins they had.
        'lib/planChange/planOffer.ts',
        'lib/planChange/offerRestart.ts',
        'lib/planning/planOfferRow.ts',
        'lib/services/planOfferService.ts',
        'lib/services/planOfferStartService.ts',
        'components/planning/PlanOffer.tsx',
        'app/api/ai/plan-change/session/offer/confirm/route.ts',
        'app/api/ai/plan-change/session/offer/decline/route.ts',
        // Story MOTIR-9430 · MOTIR-9440 — the composed requirement's NEW core modules (the
        // page writer, the pure markdown renderer, the left pane's derivation). MEASURED
        // on the story branch against `tests/integration/planning/composedRequirementSeam`,
        // `planOfferRequirementPage`, `tests/services/requirementPageService.integration`,
        // `tests/ai/requirementMarkdown`, `tests/planning/requirementPane` and
        // `tests/components/requirement-pane`, statements / branches / functions / lines:
        // requirementPageService.ts 93.93 / 85.71 / 100 / 96.42 on one run and 81.81 /
        // 71.42 / 100 / 85.71 on another (the folder-race arm is hit only when two writes
        // actually collide), pinned at the lower run; requirementMarkdown.ts 100 / 87.5 /
        // 100 / 100; requirementPane.ts 100 / 96.15 / 100 / 100. Pinned at the floor below.
        'lib/services/requirementPageService.ts',
        'lib/ai/requirementMarkdown.ts',
        'lib/planning/requirementPane.ts',
        // Story MOTIR-9539 · MOTIR-9615 — the provider-capacity story's new modules (the
        // gateway capacity client, its fake and provider, the threshold function, the
        // raised-alert store, the alert evaluation and its minutely job, the staff
        // service, the poll route, the screen's page, actions and components). MEASURED
        // on this branch against the story's own specs (`tests/capacity/**`,
        // `tests/gateway/capacity*`, `tests/platform/{platformCapacityService,
        // capacityActions}`, `tests/api/platformCapacityRoute`, `tests/jobs/
        // capacityAlertEvaluation`, `tests/components/admin/{capacity*,
        // editCapacityLimitsDialog,alertShareCard,adminShellCapacityNav}` and the story
        // gate `tests/integration/capacity/capacityScreenStoryGate`). 25 files reach 90 on
        // all four metrics and are pinned at 90 in `thresholds`. These ten do not, and are
        // REPORT-ONLY (in `include`, not in `thresholds`) rather than pinned below the
        // floor (statements / branches / functions / lines):
        // NotEnforcedFold.tsx 83.33 / 50 / 100 / 100;
        // RaisedAlertsBanner.tsx 100 / 75 / 100 / 100;
        // actions.ts 87.5 / 85.18 / 100 / 84.84;
        // route.ts 85.71 / 50 / 100 / 85.71;
        // errors.ts 100 / 71.42 / 100 / 100;
        // capacityClient.ts 92.56 / 88.63 / 100 / 95.32;
        // capacityFakeState.ts 86.48 / 63.15 / 100 / 90.9;
        // capacityAlertMappers.ts 77.77 / 75 / 100 / 85.71;
        // capacityLimitAlert.ts 100 / 50 / 100 / 100;
        // platformCapacityService.ts 96.15 / 75 / 100 / 96.15;
        // the same ten are named in the story's pull request.
        'app/**/admin/capacity/_components/AlertShareCard.tsx',
        'app/**/admin/capacity/_components/CapacityEntryCard.tsx',
        'app/**/admin/capacity/_components/CapacityErrorPanel.tsx',
        'app/**/admin/capacity/_components/CapacityLimitRow.tsx',
        'app/**/admin/capacity/_components/CapacityScreen.tsx',
        'app/**/admin/capacity/_components/CapacitySkeleton.tsx',
        'app/**/admin/capacity/_components/EditCapacityLimitsDialog.tsx',
        'app/**/admin/capacity/_components/NotEnforcedFold.tsx',
        'app/**/admin/capacity/_components/RaisedAlertsBanner.tsx',
        'app/**/admin/capacity/_components/capacityDisplay.ts',
        'app/**/admin/capacity/actions.ts',
        'app/**/admin/capacity/page.tsx',
        'app/api/platform/capacity/route.ts',
        'lib/capacity/alertKeys.ts',
        'lib/capacity/errors.ts',
        'lib/capacity/limitEditValidation.ts',
        'lib/capacity/screenRefresh.ts',
        'lib/capacity/threshold.ts',
        'lib/dto/capacityAlerts.ts',
        'lib/dto/platformCapacity.ts',
        'lib/gateway/capacityClient.ts',
        'lib/gateway/capacityErrors.ts',
        'lib/gateway/capacityFakeState.ts',
        'lib/gateway/capacityProvider.ts',
        'lib/jobs/definitions/capacityAlertEvaluation.ts',
        'lib/mappers/capacityAlertMappers.ts',
        'lib/mappers/platformCapacityMappers.ts',
        'lib/monitoring/capacityAlertJobAlert.ts',
        'lib/monitoring/capacityLimitAlert.ts',
        'lib/repositories/capacityAlertSettingRepository.ts',
        'lib/repositories/capacityRaisedAlertRepository.ts',
        'lib/services/capacityAlertEvaluationService.ts',
        'lib/services/capacityAlertJobService.ts',
        'lib/services/capacityAlertStateService.ts',
        'lib/services/platformCapacityService.ts',
      ],
      reporter: ['text', 'text-summary'],
      // Per-file thresholds keyed by glob: each of the six modules gates
      // independently, so a regression in any one fails the run (rather than a
      // blended average hiding a weak module).
      //
      // ⚠️ A key here gates ONLY a file `include` above also resolves to, and it
      // fails SILENTLY when it matches nothing — see the route-group note on
      // `include`. Write a route-group path as `app/**/…`.
      thresholds: {
        // Story MOTIR-9539 · MOTIR-9615 — the provider-capacity modules, measured above.
        'app/**/admin/capacity/_components/AlertShareCard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/CapacityEntryCard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/CapacityErrorPanel.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/CapacityLimitRow.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/CapacityScreen.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/CapacitySkeleton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/EditCapacityLimitsDialog.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/_components/capacityDisplay.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/capacity/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/capacity/alertKeys.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/capacity/limitEditValidation.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/capacity/screenRefresh.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/capacity/threshold.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/dto/capacityAlerts.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/dto/platformCapacity.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/gateway/capacityErrors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/gateway/capacityProvider.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/capacityAlertEvaluation.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/platformCapacityMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/monitoring/capacityAlertJobAlert.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/capacityAlertSettingRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/capacityRaisedAlertRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/capacityAlertEvaluationService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/capacityAlertJobService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/capacityAlertStateService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9362 · MOTIR-9464 — the pool-growth modules, measured above.
        'lib/ciFleet/poolGrowthPolicy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/fleetShards/awsMemberAccountPlan.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/fleetShards/fleetAutomationPrincipal.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/fleetShards/scrubSecrets.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9708 · MOTIR-9850 — the pool-account definition and the `aws`
        // provider, measured above.
        'lib/fleetShards/awsPoolDefinition.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/fleetShards/awsProvisioningProvider.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/fleetPoolGrowth.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/fleetPoolMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/fleetGrowthEventRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/fleetGrowthLockRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/fleetGrowthPassLeaseRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/fleetQuotaRequestRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetGrowthEventService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetPoolGrowthPassService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetPoolGrowthService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetPoolStatusService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9367 · MOTIR-9564 — the platform Pools read and section, measured above.
        'lib/services/platformFleetPoolsService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/monitoring/_components/PoolsSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetQuotaRaiseService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetQuotaRequestService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/fleetShardQuotaService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'scripts/fleet/fleetAdminPoolCommands.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9709 · MOTIR-9933 — measured above, pinned at the floor.
        'scripts/aws-deploy/awsDeploy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'scripts/aws-deploy/migrateRun.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'scripts/aws-deploy/ports.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'scripts/aws-deploy/rollingDeploy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'scripts/aws-deploy/taskDefinitions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'scripts/fleet/fleetAdminCheckQuota.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9219 · MOTIR-9295 — measured above, pinned at the floor (the start
        // service's branches at 88, for the reason the `include` block gives).
        'lib/planChange/planOffer.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/planChange/offerRestart.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/planning/planOfferRow.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/planOfferService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/planOfferStartService.ts': {
          lines: 90,
          functions: 90,
          branches: 88,
          statements: 90,
        },
        'components/planning/PlanOffer.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/ai/plan-change/session/offer/confirm/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/ai/plan-change/session/offer/decline/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9430 · MOTIR-9440 — measured above, pinned at the floor.
        'lib/services/requirementPageService.ts': {
          lines: 85,
          functions: 100,
          branches: 71,
          statements: 81,
        },
        'lib/ai/requirementMarkdown.ts': {
          lines: 100,
          functions: 100,
          branches: 87,
          statements: 100,
        },
        'lib/planning/requirementPane.ts': {
          lines: 100,
          functions: 100,
          branches: 96,
          statements: 100,
        },
        // ── Story MOTIR-8538 · THE LOAD TEST (Subtask MOTIR-8681) — see `include`. ──
        'loadtest/staging/sideEffectSwitches.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/preflight/sideEffects.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/lib/endpointHost.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/seed/shape.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/seed/seed.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/seed/reset.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/seed/manifest.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/seed/guard.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/seed/tenants.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/agents.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/classify.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/holdStream.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/iterations.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/outcome.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/readerOutcome.js': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/k6/lib/readerProfile.js': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/k6/lib/readerUsers.js': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/k6/lib/record.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/lib/streamTally.js': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/k6/lib/windowReadGate.js': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'loadtest/k6/runs/classify.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/runs/metrics.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/k6/runs/sequence.js': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/profiles/schema.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/profiles/resolve.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/run/fly.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/run/generator.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/run/neon.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/run/pinned.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/run/runRecord.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/run/run.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/capture/appLogs.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/capture/dbSampler.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/capture/index.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/capture/neon.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/capture/pgss.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/capture/redact.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/bottleneck.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/inputs.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/k6Points.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/mix.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/p2028.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/prometheus.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/proxyShed.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/render.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/report.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/scaleOut.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'loadtest/report/thresholds.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // ── Story MOTIR-6170 · THE VISITOR (Subtask MOTIR-6650) — see `include`. ──
        // ── Story MOTIR-8651 · BUILD THROUGH (Subtask MOTIR-8662) — see `include`. ──
        'lib/services/runDiscrepancyService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/tools/recordRunDiscrepancy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/visitor/consentPath.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/visitor/context.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/visitor/cookie.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/visitor/errors.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/visitor/readActor.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/visitor/readScope.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/visitor/routes.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/services/publicRequestsService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/p/\\[identifier\\]/requests/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/p/\\[identifier\\]/requested-features/_components/RequestedFeaturesList.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/visitorRecordsService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/projectVisitorRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/visitorMappers.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/people/personLabel.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/pages/projectPageContext.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/issues/EpicNotPublicPill.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/rateLimit/publicReadGuard.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6169 · ACCESS LIVES ON THE PROJECT (Subtask MOTIR-6552) ──
        // Pinned at the project's 90, not at the measurement (see `include`).
        'lib/projects/accessMode.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'app/**/no-project/page.tsx': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'app/**/_components/NoProjectShell.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/NoProjectCreateButton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/members/_components/MemberChips.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/members/_components/MembersOnlyConfirmDialog.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/workspace/_components/AccessScopeCell.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/workspace/_components/InviteAccessFields.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/projects/**/access/preview/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6179 · THE ROOMS' VIEW-ANY KEYS (Subtask MOTIR-6336) ──
        'lib/rooms/roomView.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/approvalGates/actPermissions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/runs/runsAddress.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'components/rooms/RoomViewSwitch.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6166 · PERMISSION-GATED SURFACES (Subtask MOTIR-6177) ──
        'app/**/_components/FieldCard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/boards/_components/ColumnActionsMenu.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/boards/_components/UnmappedStatusesTray.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/backlog/_components/SelectionBar.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/backlog/_components/CreateIssueRow.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6156 · THE MULTI-LINE COMPOSER (Subtask MOTIR-6239) ──
        // Measured at 97.11 / 90.43 / 100 / 100 on this branch. The branch axis
        // has the thinnest margin in this list — its residue is three `if (!el)
        // return` ref guards that cannot be reached without breaking the ref, so
        // the honest ceiling is close to the floor.
        'components/planning/PlanChangeComposer.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6739 · TO-DO TOOLS (Subtask MOTIR-6726) ──────────────
        // Pinned at the floor, not at what was measured, so the gate stays about
        // regressions rather than ratcheting on the next unrelated line.
        'lib/mcp/tools/workItemTodos.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/tools/workItemContinue.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9491 · MOTIR-9639 — page search on `/pages`; measured above, pinned at the floor.
        'app/api/pages/search/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/pages/search/pageSearchClient.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/pages/search/usePageSearch.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/pages/_components/PagesSearch.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/pages/_components/PageSearchResults.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/pages/_components/PageSearchHitRow.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/pages/_components/snippetEmphasis.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9487 · MOTIR-9559 — the three page tools; measured above, pinned at the floor.
        'lib/mcp/tools/movePage.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/tools/archivePage.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/tools/linkPage.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7664 · MOTIR-7682 — the console's Ideas page; measured above, pinned at the floor.
        'app/**/admin/ideas/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/\\[slug\\]/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/\\[slug\\]/_components/DeleteIdeaDialog.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/\\[slug\\]/_components/IdeaEditForm.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/\\[slug\\]/_components/IdeaWorkbench.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/\\[slug\\]/_components/RetireIdeaDialog.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/\\[slug\\]/_components/ideaDraft.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/IdeaBits.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/IdeaDetailView.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/IdeaFilters.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/IdeasSkeleton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/IdeasTable.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/IdeasUnavailable.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ideas/_components/ideaListQuery.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/AdminShell.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/consoleActor.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7662 · MOTIR-7677 — the idea store; measured above, pinned at the floor.
        'lib/services/ideasAdminService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/ideasPublicService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/ideaRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/ideaPublicRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/ideaTagRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/ideaResearchRunRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/ideaMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/categories.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/limits.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/publicCache.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/routeErrors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/schemas.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/translatableFields.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/staffTranslations.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ideas/publicLocale.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/platform/ideas/tags/\\[slug\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/platform/ideasGate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/platform/ideas/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/platform/ideas/\\[slug\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/platform/ideas/\\[slug\\]/retire/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/platform/ideas/tags/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/platform/ideas/runs/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/public/ideas/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/public/ideas/\\[slug\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/public/ideas/tags/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7460 · MOTIR-7479 — measured above, pinned at the floor.
        'lib/approvalGates/manualWorkHandler.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/manualWorkGateService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7220 · MOTIR-7234 — measured above, pinned at the floor.
        'lib/services/platformPlannerModelService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/platformPlannerModelMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/plans/redactNativeModel.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ai-planning/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7521 · MOTIR-7529 — measured above, pinned at the floor.
        'lib/services/platformRunModelService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/platformRunModelRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/platformRunModelMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/hostedRunModelService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/hostedRuns/capacityReasons.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/hostedRuns/agentCapacityVerdict.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/agentRunCapacityService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/run-models/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/run-models/_components/RunModelList.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/run-models/_components/RunModelListUnavailable.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ai-planning/_components/PlannerModelList.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/ai-planning/_components/PlannerModelListUnavailable.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6574 · OBSOLESCENCE (Subtask MOTIR-6584) ─────────────
        // Pinned at the floor, not at the 100 measured, so the gate stays about
        // regressions rather than ratcheting on the next unrelated line.
        'lib/issues/obsolescence.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/mcp/obsolescence.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/workItems/linkRelationships.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-9023 · TYPED SECTIONS (Subtask MOTIR-9036) ───────────
        // Pinned at the floor, not at the ≥97 measured (the include block above
        // carries the numbers). `getSectionSets.ts` branches sit at 60: its
        // fallback arms answer a cell the registry never returns.
        'lib/workItems/sections/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItems/sections/parse.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItems/sections/registry.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItems/sections/render.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItems/sections/validity.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/parsedSections.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/mcp/payloads/parsedSectionsSchema.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/payloads/sectionSets.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/sectionsInput.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/mcp/tools/getSectionSets.ts': {
          lines: 90,
          functions: 90,
          branches: 60,
          statements: 90,
        },
        'lib/api/v1/sectionSets/operations.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/api/v1/sectionSets/schema.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-9486 · MOTIR-9496 — the `/api/v1` PAGE resource.
        'lib/api/v1/pages/errors.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/api/v1/pages/resolve.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/api/v1/pages/schema.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/api/v1/pages/operations.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/projects/\\[projectKey\\]/pages/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/pages/\\[pageId\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/pages/\\[pageId\\]/placement/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/pages/\\[pageId\\]/archive/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/pages/\\[pageId\\]/restore/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/pages/\\[pageId\\]/work-items/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/pages/\\[pageId\\]/work-items/\\[workItemId\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/plans/applySectionsInput.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/sectionSchemaService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6577 · A PLAN MARKS A CARD (Subtask MOTIR-6633) ──────
        // Pinned at the floor, not at the ≥97 measured (the include block above
        // carries the numbers), for the same reason as the obsolescence entries.
        'lib/plans/markOnlyPatch.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/plans/validateProposedObsolescence.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItems/obsolescenceNote.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/issues/ObsolescencePill.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/SupersedesChip.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/ProposalMarkRailRows.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/changeCellText.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6016 · DIFFICULTY (Subtask MOTIR-6102) ───────────────
        'lib/issues/difficulty.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/hooks/useActivityRevision.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/issues/DifficultyPicker.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4778 · APPROVAL GATES (Subtask MOTIR-4796) ───────────
        // Pinned at the project floor after measuring each on this branch. Seven
        // of the nine came out at 100 on all four axes; the two that did not are
        // noted below with what remains and why.
        'lib/approvalGates/registry.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/approvalGates/designResultHandler.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/errors.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/approvalGates/refusals.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // Story MOTIR-4887 · MOTIR-5530 — measured against the story's own specs:
        // heldMoves, statusIntent and BoardHeldRefusal at 100 on all four axes;
        // StatusHeldNotice 100/95.45/100/100, heldRefusal 100/92.85/100/100 and
        // useStatusHeld 100/90/100/100 (stmts/branches/funcs/lines).
        'lib/approvalGates/heldMoves.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workflows/statusIntent.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'components/issues/StatusHeldNotice.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/issues/heldRefusal.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/issues/useStatusHeld.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-6017 · MOTIR-6269 — measured against the story's own specs.
        'lib/plans/planHold.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'app/**/boards/_components/BoardHeldRefusal.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-4882 · MOTIR-5519 — measured at 100 on all four axes (see the
        // `include` note); pinned at the project's 90 floor so a refactor has room.
        // (`pullRequestMergeHandler.ts`'s threshold retired with the file — MOTIR-5616.)
        'lib/approvalGates/settingsDoor.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/github/appRoleForRepo.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/services/runTarget.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/services/mergeGates.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/services/pullRequestMergeService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/pullRequestAutoMergeService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/pullRequestAutoMerge.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/pullRequestApprovalHandler.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/deliverySetVersion.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/memberVersion.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // MOTIR-5236: measured 100 / 100 / 100 / 100, pinned at the repo floor, not the number.
        'lib/approvalGates/stamp.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/pullRequestApprovalGates.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/decisionApprovalHandler.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/decisionDocumentResolver.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/decisionSubject.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/decisionDocument.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/decisionDocumentCaptureService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/decisionDocumentService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/decisionDocumentMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/DecisionDocumentSlot.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/DevelopmentGateFrame.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/MergeOutcomeSlot.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // MOTIR-5467 — measured at 100 on each; pinned at the story floor.
        'lib/services/workItemRepairService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/work-items/[key]/repair/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/RepairFixPart.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // MOTIR-6537 — the run-death story's new files, measured above; pinned at the floor.
        'lib/runs/runLiveness.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/workItemContinueService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/work-items/[key]/continue/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/dispatch-runs/[id]/heartbeat/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/runLivenessSweep.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/ContinuePart.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // MOTIR-5636 — the merge-queue ejection story's new files, measured above.
        'lib/services/mergeQueueExitService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/mergeQueueCheckService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mergeQueue/queueExit.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mergeQueue/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/QueueExitLine.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/QueueExitAutoPart.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/routing.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/mappers/approvalGateMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/approvals/portRenderStatus.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // 100 / 98.07 / 100 / 100. The two residual branches are the confirm
        // band's optional copy slots, which a kind may leave unset.
        'components/approvals/ApprovalGateControl.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-5214 · DECIDE IT FULL SCREEN (Subtask MOTIR-5226) ────
        // MEASURED on the parent branch over `tests/components/approval-overlay`,
        // `workbench-approvals-list`, `approval-gate-fill-layout`,
        // `tests/approvals/`, `tests/api/approval-gate-route.test.ts` and
        // `tests/integration/approvals/`, then pinned at the project floor.
        // 100 / 100 / 100 / 100 unless noted.
        'lib/approvals/overlayAddress.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvals/approvalOverlayClient.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvals/decidedGates.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'app/api/work-items/approval-gate/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // 100 / 97.43 / 100 / 100. The two residual branches are v8's IMPLICIT
        // else arms of the read effect's two `aborted` early returns, reported
        // with no source location; both arms of each are driven by
        // `approval-overlay.test.tsx` ("a read superseded by a new address…",
        // "a FAILED read superseded…").
        'components/approvals/ApprovalOverlay.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Report-only until this story rewrote its central interaction (the row
        // now OPENS the overlay; MOTIR-5225). 100 / 100 / 100 / 100 with
        // StatePill's unreachable `default` ignored, citing its invariant test.
        // Story MOTIR-5299 (Subtask MOTIR-5303). MEASURED on the parent branch before
        // being pinned, at 100 / 100 / 100 / 100 (stmts / branches / funcs / lines) on
        // all three, over `tests/components/{approval-records-list,approval-records-page,
        // workbench-approvals-list}` and `tests/approval-records-story-gate`.
        'app/*/approvals/page.tsx': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'app/*/approvals/_components/ApprovalRecordsList.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/approvalGates/acceptanceResultHandler.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/acceptance/AcceptanceReceiptPlayer.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/acceptance/AcceptanceDevelopmentSlot.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/approvals/GateCallToActionBand.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/approvals/ApprovalRow.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/workbench/_components/ApprovalsList.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ⚠️ BRANCHES PINNED AT 84, WITH A REASON; the other three are 100.
        // The residual branches are the four reads' `tx ?? dbRead` fallbacks.
        // Every shipped caller passes a `tx`, so the `dbRead` side of each is
        // unexercised.
        //
        // ⚠️ IT WAS 85 UNTIL MOTIR-5687, AND THE FILE DID NOT GET LESS COVERED.
        // There were FIVE residual branches: these four, plus a driver-shape
        // `originalCode` fallback inside this file's own SQLSTATE extractor. That
        // extractor moved to `lib/prisma/sqlstate.ts` — three repositories each
        // had a copy, and a Prisma upgrade relocated the SQLSTATE and retired the
        // arm in all three at once — taking its FULLY COVERED branches with it.
        // Numerator and denominator left together, so the ratio fell to 84.37%
        // without one line of behaviour changing here. 84 is that measurement,
        // not a concession.
        //
        // The moved code is pinned by `tests/prisma/sqlstate.test.ts` (every
        // shape, as data, against a pure function) rather than by a threshold of
        // its own; the honest way to raise THIS number back is to make `tx`
        // required on these four reads, which deletes the branch instead of
        // testing it.
        //
        // It is pinned rather than covered BECAUSE THE OBVIOUS TEST IS ONE THE
        // REPOSITORY FORBIDS. A test calling these reads unbound and asserting
        // they return nothing was written, and
        // `tests/rls/test-call-site-guard.test.ts` refused it by name: under
        // `motir_app` an unbound read returns empty because nothing is bound,
        // so such an assertion "will PASS while checking nothing, which is
        // worse". The policy property it was reaching for is already asserted
        // at the right altitude by `tests/approval-gate-rls.test.ts`.
        //
        // So the arm gets a VERDICT rather than a fixture — this card's own
        // rule — and the number stays honest about what is measured.
        'lib/repositories/approvalGateRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 84,
          statements: 90,
        },
        // 95.83 / 93.02 / 100 / 100. The residual statements are the door's
        // post-lock tenant re-check — defence in depth the pre-read makes
        // unreachable, marked at the arm with the test that pins its invariant.
        'lib/services/approvalGatesService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4725 · the planning workspace as an OVERLAY ──────────
        // Pinned at the project floor after measuring each on this branch
        // (MOTIR-4733). Statements/lines/functions came out at 100 across the
        // set; branches at 92.85–100 except the one file noted below.
        'lib/planning/planPending.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/planning/planningAnchorClient.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/hooks/useOpenPlanningWorkspace.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanningWorkspaceOverlay.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanCloseGuard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanningWorkspaceHost.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanApproveProgress.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/PlanProposalViews.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/planning/page.tsx': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // ⚠️ BRANCHES PINNED AT 83, WITH A REASON, AND THE OTHER THREE AT 100.
        // The anchor route's two remaining branches are the SAME unreachable
        // case counted twice: `ProjectNotFoundError` cannot arrive here (the
        // service rejects a foreign tenant with `WorkItemNotFoundError` before
        // the access read that raises it), and the re-throw behind it is
        // therefore unreachable too. Both carry a `v8 ignore` naming the test
        // that asserts the ordering they rest on — but v8 counts an implicit
        // `else` on the LINE OF THE `if`, which no comment on the branch below
        // can suppress. Reaching either would mean mocking `workItemsService`,
        // which is exactly what stops proving this route's 404 contract. So the
        // number is pinned at what is real, with the reason, rather than the
        // guard being weakened for the file as a whole: statements, lines and
        // functions all gate at 100 here.
        // MEASURED: 100 statements / 83.33 branches / 100 functions / 100 lines.
        'app/api/work-items/planning-anchor/route.ts': {
          lines: 100,
          functions: 100,
          branches: 83,
          statements: 100,
        },
        // Story MOTIR-3440 · Subtask MOTIR-3449 — the two arrival primitives,
        // MEASURED at 100/100/100/100 each before being pinned (see `include`).
        'components/ui/PageSkeleton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4669 · MOTIR-4684 — the repository-tenancy surface ────
        // Pinned at the project floor after MEASURING each on this branch. The
        // branch axis is 75 on the two services rather than 90, and that is a
        // DISPOSITION rather than a discount — every arm below the line is
        // DEFENSIVE, and each was read off its PRODUCER:
        //
        //   organizationRepoService 125/129 — `translateLinkViolation`'s
        //     non-array `meta.target` and its non-P2002 rethrow. The producer is
        //     Prisma: `target` is an array for a composite index (which both of
        //     this file's unique indexes are), and the rethrow is reached only by
        //     an error class the `catch` does not claim. Its P2002 arms ARE
        //     covered, by two real concurrency races in
        //     `tests/projectRepos/organizationRepoService.test.ts`.
        //   organizationRepoService 563 — the same helper's second call site, on
        //     the CONNECT path. Reaching it needs a name collision created
        //     between that path's pre-check and its insert, by a caller that has
        //     just performed a provider install. A fixture for it would be a
        //     fixture nobody can build.
        //   organizationAccessService 88 — the `?? null` on a membership row that
        //     is `undefined` rather than absent. The producer is
        //     `findByOrgAndUserInTx`, which returns `null`, so the branch is
        //     unreachable through it and exists to keep the coalesce total.
        //   organizationSettingsNav 234 — `if (!entry.href) return false`. Every
        //     entry in the registry has an href BY CONSTRUCTION, and the
        //     route↔registry totality test is what holds that: an entry without
        //     one would fail there before it could reach this line.
        //
        // ⚠️ NONE of these is rule-bearing, and none is silenced with an ignore
        // directive: a defensive arm that is genuinely unreachable is better left
        // measurable than annotated, so a future change that MAKES it reachable
        // shows up as a coverage move rather than passing under a comment.
        'lib/services/organizationRepoService.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        'lib/services/organizationAccessService.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        // Story MOTIR-6167 · MOTIR-6315 — measured before pinning (see `include`).
        'lib/organizations/capabilities.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/organizations/**/ownership-transfer/route.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        'app/api/organizations/**/workspaces/route.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        'app/api/organizations/**/workspaces/*/route.ts': {
          lines: 90,
          functions: 90,
          branches: 75,
          statements: 90,
        },
        'lib/settings/organizationSettingsNav.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/organizationRepoMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-1215 · Subtask MOTIR-3646 — both measured at 100 on all
        // four axes on this branch before pinning.
        // Story MOTIR-3808 · MOTIR-3816 — pinned at the project floor after
        // measuring each on this branch (see the `include` note above).
        'lib/repositories/workItemTodoRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/workItemTodosService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/dto/workItemTodos.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/workItemTodoMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItemTodos/limits.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItemTodos/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/todoActions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/_components/TodoListSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-5542 · MOTIR-5548 — measured above, pinned at the floor.
        'app/**/items/[key]/_components/PlanHistorySection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/work-items/**/plans/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/planMappers.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'app/**/_components/RequireTwoFactorCard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/organization/security/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/workspace/security/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/WorkspaceFoldInSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-4843 · Subtask MOTIR-4848. The three files that MEASURED
        // above the floor on all four axes; the numbers and the one deliberate
        // omission are recorded beside their `include` entries.
        'lib/settings/workspaceSettingsNav.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/WorkspaceSidebarHeader.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/auth/twoFactorGate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/auth/requireCompliantSession.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/two-factor-required/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/two-factor-required/_components/SignOutLink.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/two-factor-required/_components/HeldEnrolment.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/settings/SettingsPaneFrame.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.9 · Subtask 8.9.8 — the six logic files this story adds, each
        // MEASURED on this branch before being pinned (see the `include` note).
        // The floor is the repo's usual 90; the measured values sit above it.
        'lib/publicProjects/followTokens.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/publicProjects/changelogCursor.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/publicProjects/atomFeed.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/publicFollowRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/publicFollowService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-1135 — all five measured at 100 on every
        // axis (see the `include` block's note). 90 is the standard floor, so
        // there are ten points of headroom before the gate bites; it is a
        // ratchet against a regression, not a target to hit.
        'lib/legal/consent.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/legal/documents.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/legal/links.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/legal/reconsentGate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/legalAcceptanceRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/legalAcceptanceService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-3698 — all three measured at 100 on every
        // axis (see the `include` block's note). 90 is the standard floor, so
        // there is headroom before the gate bites; it is a ratchet against a
        // regression, not a target to hit.
        'lib/users/dataSubjectRequests.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/accountDeletionRequestRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/dataExportRequestRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-3700 — both measured at 100 on every axis
        // (see the `include` block's note). 90 is the standard floor.
        'lib/services/accountDeletionService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.4 · Subtask MOTIR-3702 — all three measured at 100 on every
        // axis (see the `include` block's note). 90 is the standard floor.
        'lib/users/accountErasure.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/accountErasureSweepService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/accountErasureSweep.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-6306 · MOTIR-6404 — measured on this branch against the
        // story's specs (see the `include` note): every file at 100 on every axis
        // except organizationDeletionService (branches 91.1) and the two below.
        'lib/organizations/deletion.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/organizations/closingGuard.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/organizationDeletionRequestRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/organizationDeletionMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/organizationDeletionService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/organizationGitOffboardingService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/organizationRetentionPurgeService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/organizationDeletionReminders.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/organizationErasureSweep.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/organizationRetentionPurge.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/organizations/**/deletion/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ⚠️ BRANCH floor 88, not 90 — measured 88.64. The five uncovered arms are
        // the claim's two `skip` returns for a row that vanished or is no longer
        // the org's open request between `listDue` and the lock, the tombstone's
        // `organization ?? ERASED_ORGANIZATION_NAME` for an org row that cannot
        // vanish (its request's FK is `Restrict`), and `todo('tombstone')` /
        // `if (notice)` false — states no persisted row can reach, since the
        // tombstone step and `erased` commit together.
        'lib/services/organizationErasureSweepService.ts': {
          lines: 90,
          functions: 90,
          branches: 88,
          statements: 90,
        },
        // ⚠️ BRANCH floor 81, not 90 — measured 81.4. The uncovered arms are all
        // unreachable by construction: `orgSnapshot` / `loadContext` returning
        // null for an org that cannot vanish under its request (FK `Restrict`),
        // the reminder's `threshold === undefined` (the read's horizon IS the
        // largest threshold), and `record`'s non-P2002 rethrow.
        'lib/services/organizationDeletionNotifier.ts': {
          lines: 90,
          functions: 90,
          branches: 81,
          statements: 90,
        },
        // ⚠️ This one's BRANCH floor is 78, not 90, and the reason is stated
        // rather than rounded away. Its two uncovered arms are in
        // `resolveRecipient`: the `!follow.userId` return and the `user?.email`
        // null arm. Both are UNREACHABLE — the `public_follow_identity_exactly_one`
        // CHECK guarantees one identity is set, the `user_id` FK guarantees the
        // row exists, and `user.email` is non-null. Reaching them in a test would
        // mean writing a row the database refuses.
        //
        // The alternative was deleting the defensive arms to buy the number,
        // which trades real safety for a metric. 78 is a RATCHET pinned just
        // under the measured 78.78: it still fails on a regression, and it does
        // not lower the bar for the three axes that do hold at 100.
        'lib/services/publicFollowDigestService.ts': {
          lines: 90,
          functions: 90,
          branches: 78,
          statements: 90,
        },
        // Story MOTIR-2282 · Subtask MOTIR-2264 — every file this story added,
        // named explicitly and MEASURED before being pinned (all six are at 100%
        // lines / branches / functions on this branch). The glob form matters for
        // the same reason as in `include` above: a literal `app/(authed)/…` key
        // matches no reported file, so the threshold would pass vacuously.
        // MOTIR-2527 — the membership reader, measured at 100/100/100 on this
        // branch before being pinned (see the `include` note above).
        // Story MOTIR-3414 · Subtask MOTIR-3426 — the Postgres job engine.
        // MEASURED on this branch before being pinned (see the `include` note):
        // cutover / dispatcher / registry / runner 100 across the board; ledger
        // 100/95/100/100; notify 97.9/94.1/100/100; step 98.5/92.5/100/100;
        // worker 98.3/95.9/96.2/99.0; all three repositories 100.
        //
        // ⚠️ A GLOB, not a per-file list, deliberately: the next story in this
        // epic ADDS files here (the scheduler, the supervisor collapse), and a
        // hand-maintained list is one a new file forgets to join — which is the
        // same failure this gate's own guard exists to catch, one level up.
        'lib/jobs/engine/**': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3472 — measured at 100/100/100 before pinning; see the `include`
        // note for why its sibling `defineJob.ts` is report-only instead.
        'lib/jobs/catchUp.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/jobQueueRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/jobStepRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/jobEventRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3766 — measured at 100 / 95.45 / 100 / 100; see the `include` note.
        'lib/services/platformHealthService.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-744 — the story 10.2 readers; see the `include` note.
        'lib/deployment/adapters/fly/flyMachinesStatus.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/deployment/providers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/gateway/statusClient.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/gateway/statusProvider.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/sentryErrorCount.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/errorCountProvider.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workspaces/membershipGate.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-2643 — MEASURED before being pinned, on this branch, with
        // `tests/acceptance-video-diagnostics.test.ts`: 90.9 branches / 100
        // functions / 100 lines. See the `include` note above for why this file
        // is worth a floor at all.
        'tests/e2e/_helpers/acceptance-diagnostics.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/permissionMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/settings/projectSettingsNav.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3878 · Subtask MOTIR-4223 — MEASURED on this branch over
        // tests/publicAddresses + tests/settings + tests/api/public + tests/rls
        // + tests/jobs, then pinned. These EIGHT clear the floor on all three
        // metrics:
        //
        //   publicAddressCertificateRefresh  100 / 100 / 100
        //   allowedOrigins                   100 /  95 / 100
        //   certificateProvider              100 / 100 / 100
        //   dnsResolver                      100 / 100 / 100
        //   errorResponse                    100 / 100 / 100
        //   reservedNames                    100 / 100 / 100
        //   tenantDomain                     100 / 100 / 100
        //   publicSubdomainService          98.1 / 90.9 / 100
        //
        // ⚠️ THE REST OF THE STORY'S SURFACE IS IN `include` AND DELIBERATELY
        // NOT HERE, which is this file's own established pattern ("so CI
        // publishes a number without gating on one") — and MOTIR-4223 records
        // the shortfall rather than hiding it. What is missing is BRANCH
        // coverage, on files whose LINES are already 85–100: the four lifecycle
        // routes sit at 66.7% branches because each has three arms and the
        // rethrow is exercised on one route rather than four, and the
        // repository at 33.3% has an `InTx`/non-`InTx` pair per method. Both are
        // real gaps and neither is a hole in the SHIPPED behaviour — every route
        // now has a test where none had one before this card.
        'lib/jobs/definitions/publicAddressCertificateRefresh.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/publicAddresses/allowedOrigins.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/certificateProvider.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/dnsResolver.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/errorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/reservedNames.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicAddresses/tenantDomain.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/publicSubdomainService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2258 · Subtask MOTIR-2476 — both MEASURED before being
        // pinned, on this branch, with the story's own suites: the nav map at
        // 100/100/100 and the provider at 100/100/100.
        'lib/settings/projectNavAccess.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2554 · Subtask MOTIR-2558 — MEASURED before being pinned,
        // on this branch, with the story's own suites: all three at 100/100/100
        // (branches / functions / lines). Pinned at 90 rather than 100 so a
        // future branch of the ladder can land with its test in the same PR
        // without the gate turning into a ratchet nobody can move.
        'app/**/_components/ShellTierNav.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectTier.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/TopNav.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectAccessProvider.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/workspace/roles/_components/*.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-6168 · Subtask MOTIR-6467 — the story gate PINS what the
        // workspace-roles story added. MEASURED FIRST over the story's own specs
        // (the roles routes, the member-role route, the Roles screens, the
        // migration notice, the story gate): the services 97–100 / 92–100 / 100,
        // the routes ≥ 95 / ≥ 89 / 100 before the edge cases in
        // `tests/workspaces/workspaceRoleSurfaceEdges.test.ts` (401, the two-
        // factor hold, the rethrow, a partial PATCH) took each past 90.
        //
        // ⚠️ NOT pinned here: the ~40 pre-existing files the story TOUCHED (the
        // caller sweep's one-line `findStandInManagerByWorkspace` renames across
        // the job and PR services, `workspacesService`, `projectAccessService`,
        // `organizationsService`, …). Measured over this story's specs alone they
        // read low because those specs do not exercise the rest of each file;
        // their honest number is the whole suite's, and the pin belongs to each
        // surface's owner — the same stance the `lib/mappers/permissionMappers.ts`
        // note above takes.
        'lib/services/workspaceRoleDefinitionService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/roleMigrationReportService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workspaceRoleDefinitionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/roleMigrationReportRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/workspaceRoleMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workspaces/roleErrorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/workspaces/**/roles/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/workspaces/**/roles/**/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/workspaces/**/members/**/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/workspace/_components/RoleMigrationNotice.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/organization/_components/RolesDoorCard.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2257 · Subtask MOTIR-2486 — the story gate PINS what the
        // story added, because an unnamed new file is an ungated one and this is
        // the card that owns "every file this story changed meets the gate".
        //
        // MEASURED FIRST, then pinned — the order this file's header argues for,
        // and the follow-up the `lib/permissions/**` note above asked for by
        // name. On this branch, over `tests/permissions` + `tests/settings` +
        // the members suites: every `lib/permissions/*` file is at 100% on all
        // three metrics; the service is 100 / 97.95 / 100; the repository and
        // both route handlers are at 100%.
        //
        // ⚠️ `lib/permissions/**` IS PINNED AS A GLOB, WHICH AGGREGATES the six
        // files into one summary rather than gating each. That is the honest
        // shape here: `catalog.ts` and `builtinRoles.ts` predate this story and
        // pinning them individually would gate code no card here wrote. The four
        // files the epic added or rewrote carry the aggregate on their own.
        'lib/permissions/**': { branches: 90, functions: 90, lines: 90 },
        'app/api/projects/**/roles/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/projects/**/roles/**/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.1 · Subtask 11.1.5 — the public `/api/v1` envelope.
        'lib/api/v1/route.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-2275 — the ONE definition of the contract version, read by both
        // the emitted document and the header the wrapper stamps.
        'lib/api/v1/contractVersion.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-2388 — the ONE definition of the app's own origin.
        'lib/baseUrl.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1163 — the ONE definition of whether analytics is on, and the
        // only surface that renders it. MEASURED on this branch over
        // `tests/analytics.test.tsx`: both files 100 / 100 / 100. Pinned at the
        // project's 90 rather than at the measurement.
        'lib/analytics.ts': { branches: 90, functions: 90, lines: 90 },
        'components/analytics/AnalyticsScript.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2384 · Subtask MOTIR-2394 — the object-store seam.
        //
        // MEASURED FIRST, then pinned, on this branch over `tests/attachments`,
        // `tests/hosting`, `tests/baseUrl` and `tests/mappers/avatar-projection`:
        // `uploader.ts` and `s3.ts` at 100 / 100 / 100, `referencedUrls.ts` at
        // 94.11 statements / 91.66 branches / 100 functions / 96.42 lines. The
        // uploader reached that number in this card — it entered at 76.19%
        // branches, with `withRandomSuffix`'s extension-less arm, two of
        // `toBuffer`'s three input shapes and both of `headPrivateBlob`'s
        // metadata defaults unexercised. Those are exactly the behaviours
        // MOTIR-2389 had to REIMPLEMENT because the old provider did them
        // server-side, which is what made them the wrong branches to leave
        // unmeasured.
        'lib/blob/uploader.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/blob/s3.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/blob/referencedUrls.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2588 · Subtask MOTIR-2681 — the project's MARK.
        //
        // MEASURED FIRST, then pinned, on this branch over
        // `tests/integration/projectImageUploadRoute`, `tests/components/
        // project-{logo-field,mark}`, `tests/project-details-service` and
        // `tests/attachments/referenced-urls`:
        //   imageUpload.ts             100 / 100 / 100
        //   ProjectMark.tsx            100 / 100 / 100
        //   ProjectLogoField.tsx       100 lines / 95.83 branches / 100 functions
        //   project-image/route.ts      90 lines /  91.66 branches / 100 functions
        //
        // Two of them ENTERED this card below the floor and were brought to it by
        // real tests, which is what the measurement was for: `ProjectLogoField`
        // sat at 86.53 / 79.16 / 75 with every FAILURE arm unexercised (a refused
        // upload, a thrown request, a failed remove, the in-flight dismissal
        // guard) and `ProjectMark` had no test at all, because the file it
        // replaced took its test with it.
        'lib/projects/imageUpload.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectLogoField.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/ProjectMark.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/api/upload/project-image/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3584 · Subtask MOTIR-3590 — the project's repository SET on
        // `/api/v1`. MEASURED FIRST, then pinned, on this branch over
        // `tests/api/v1/project-repositories-route` and
        // `tests/integration/linkClonesCheckoutsStoryGate`:
        //   lib/api/v1/projects/repositories.ts     100 / 100 / 100 / 100
        //   app/api/v1/…/repositories/route.ts      100 / 100 / 100 / 100
        //
        // The route ENTERED this card at 50% branches: the `position` tie-break
        // was unexercised, because no service API produces two rows sharing a
        // fractional key on demand. It is a RULE-BEARING arm, not a defensive one
        // — `moveRow` computes `position` from a read that guards a write, so two
        // concurrent moves really can land the same value, and a cursor cannot
        // page soundly over an order that shuffles. The test forces the tie
        // through the admin client rather than ignoring the arm.
        'lib/api/v1/projects/repositories.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/repositories/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/api/v1/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/bearer.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/pagination.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/rateLimit.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 8.5 · Subtask 8.5.9 — MOTIR-1165. Named file by file rather than
        // by glob: an unnamed new file is an ungated one.
        'lib/rateLimit/store.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/postgresStore.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/limiter.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/guard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/keys.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/budgets.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/authGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/publicWriteGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/aiGuard.ts': { branches: 90, functions: 90, lines: 90 },
        // The MCP transport's guard (MOTIR-2610). Listed for the same reason as
        // its nine siblings above: `include` is the `lib/rateLimit/**` glob, so a
        // new file lands in the REPORT automatically but is gated by nothing
        // until it has a key here — and a limiter nobody measures is exactly the
        // shape of the gap this card exists to close.
        'lib/rateLimit/mcpGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/fixedWindow.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-8547 — Better-Auth's adapter onto the shared counter (MOTIR-8613)
        // and the boot guard on the `memory` store (MOTIR-8614). Measured at
        // 100 / 100 / 100 / 100 against their own specs plus the story gate
        // (`tests/rateLimit/storyGate.test.ts`, MOTIR-8619).
        'lib/rateLimit/betterAuthStorage.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/rateLimit/storeGuard.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-8548 · MOTIR-8607 — the per-workspace agent ceiling, the one NEW
        // module of the story's motir-core children. MEASURED on this branch against the
        // story's own specs (`tests/integration/rateLimit/agentRateLimitStoryGate.test.ts`
        // plus the children's suites): 100 / 100 / 100 / 100 (lines / functions /
        // branches / statements), then pinned at the project floor.
        'lib/rateLimit/workspaceCeiling.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'lib/services/rateLimitService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/rateLimitCounterRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/ai/jobAuthResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/me/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/workspaces/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.7 · Subtask 11.7.8 — MOTIR-2242. Every file the story added
        // or widened, named explicitly: an unnamed new file is an ungated one.
        'lib/api/v1/workLoop/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workLoop/operations.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workLoop/planScope.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/childEdges.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/resolveKey.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/work-items/[key]/attachments/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/dispatch-prompt/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/claim/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/plan-approval/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/scope-claims/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/integration/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/expansions/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/work-items/[key]/activity/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/sessions/complete/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/plans/[planId]/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/plans/[planId]/status/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/plan-session/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/plan-session/turns/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/plan-session/submissions/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2192 · Subtask MOTIR-2166 — the code-graph offboarding queue.
        // Story MOTIR-1755 · Subtask MOTIR-2207 — the multi-repo audit tab.
        'lib/codeHealth/repoAuditRows.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/code/_components/AuditRepoList.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2244 · Subtask MOTIR-2247 — the repo-scoped audit trigger.
        'lib/codeHealth/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/coding-convention/_shared.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/coding-convention/refresh/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Subtask MOTIR-2248 — the audit-coverage read.
        'lib/services/auditCoverageService.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2266 — the first-audit trigger.
        'lib/services/firstAuditTriggerService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/codeHealth/reauditRun.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/AuditCoverageBanner.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/coding-convention/audit-coverage/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/codeGraph/offboarding.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/codeGraphOffboardingRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/codeGraphOffboardingService.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2168 — the sweep.
        'lib/services/codeGraphOffboardSweepService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/jobs/definitions/codeGraphOffboardSweep.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Subtask MOTIR-2197 — the live-project read seam.
        'lib/codeGraph/liveProjects.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/liveProjectsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/internalApi/serviceAuth.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.3 · Subtask 11.3.10 — the planning resources.
        'lib/api/v1/projects/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/sprints/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/sprints/membership.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/ready/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/rankedCollections.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.3 — the SHARED wire-schema layer.
        'lib/api/v1/openapi/statuses.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/errorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/envelopes.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/headers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/security.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.4 — the registry, the emitter and the route.
        'lib/api/v1/openapi/operation.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/openapi/emit.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/operations.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/openapi/v1.json/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3876 · Subtasks MOTIR-3945 + MOTIR-3946 — the public read
        // contract (see the `include` note above; each measured at 100/100/100).
        // Story MOTIR-3876 · Subtask MOTIR-3885 — the origin seam (measured
        // 100/100/100 each; see the `include` note above).
        // (`app/sitemap.ts` sat here and is DELETED — MOTIR-4583.)
        'lib/publicProjects/urls.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3876 · Subtask MOTIR-3726 — robots (measured 100/100/100).
        'lib/robotsPolicy.ts': { branches: 90, functions: 90, lines: 90 },
        'app/robots.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/contractVersion.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/operation.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/schemas.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/operations.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/public/openapi/emit.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/openapi/public.json/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/public/p/[identifier]/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3932 · Subtask MOTIR-4194 — the published tool catalogue.
        'app/api/docs/mcp-tools.json/route.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3877 · Subtask MOTIR-4120 — the reads and the act path
        // (the include block above carries the finding: they were outside this
        // report entirely, because the sibling entry is a LITERAL path).
        // MEASURED on this branch at 100/100/100 each, except `/act` (92.3
        // branches) and the overview write (92.85), whose remaining arms are the
        // capability gate's `false` side — driven in `cloud-gate.test.ts`, which
        // is in a different run. Pinned at the floor, not at the measurement.
        'app/api/public/p/[identifier]/board/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/roadmap/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/items/[key]/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/requests/[requestKey]/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/p/[identifier]/changelog.xml/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/public/projects/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/projects/[key]/public-overview/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/act/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicProjects/returnTarget.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicProjects/cors.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3908 · Subtask MOTIR-4037 — the capability gate (above).
        'lib/billing/availability.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/publicProjects/cloudGate.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.4 · Subtask 11.4.5 — the remaining operation declarations.
        'lib/api/v1/identity/schema.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/planning/operations.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 8.12 · Subtask MOTIR-3612 — MEASURED on this branch, in these
        // numbers, before being pinned:
        //   PasskeyManager.tsx        97.56 / 92.10 / 100 / 100
        //   AccountSecurityPanes.tsx    100 /    100 / 100 / 100
        //   twoFactorMethods.ts         100 /    100 / 100 / 100
        // (statements / branches / functions / lines).
        'app/**/settings/account/_components/PasskeyManager.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/AccountSecurityPanes.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/twoFactorMethods.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story 8.12 · Subtask MOTIR-3613 — MEASURED at
        // 95.83 / 90.47 / 100 / 100 (statements / branches / functions / lines).
        // Story 8.12 · Subtask MOTIR-3614 — MEASURED at 100 / 100 / 100 / 100
        // (statements / branches / functions / lines) for all four.
        'lib/auth/passkeyConfig.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/passkeyRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/passkeyMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/passkeyService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/PasskeySignInButton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/ApiDocsLinkPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/[projectKey]/sprints/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/backlog/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/projects/[projectKey]/backlog/work-items/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/sprints/[sprintId]/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/sprints/[sprintId]/start/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/sprints/[sprintId]/complete/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/v1/sprints/[sprintId]/work-items/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1775 · MOTIR-1896 — the CI-minutes meter.
        'lib/ciMetering/runnerRates.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciMetering/normalize.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciMetering/period.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciMetering/config.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciMinutesMeterService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciMinutesReconciliationService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciWorkflowRunUsageRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciPeriodUsageRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/ciMinutesReconcile.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1916 · MOTIR-1924 — the fleet COST meter.
        'lib/services/ciFleetCostMeterService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciContainerUsageRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciContainerPeriodCostRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1916 · MOTIR-1927 — the rest of the fleet (see the
        // include list for why the port ships gated alongside the services).
        'lib/orchestrator/index.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1981 · MOTIR-1992 — the index fleet (see the include list).
        'lib/services/codeGraphIndexDispatchService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/codeGraphIndexAdmissionService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/jobs/indexFleetSteps.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-4335 · MOTIR-4544 (see the include list).
        'lib/ciFleet/indexAllowance.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/codeGraphIndexCatchUpService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/codeGraphIndexCatchUp.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/codeGraphIndex.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/config.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/limits.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/shardTargets.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/workloads.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/bootDispatch.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/runnerJitConfig.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciRunnerProvisioningService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/ciRunnerBootService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciRunnerAdmissionService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/fleetCeilingService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/fleetStopService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/actionsRuns.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/aiPlanGateService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciLiveChargeService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciLiveAccrualRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/ciLiveCharge.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/fleetAttributionService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-8699 · MOTIR-8716 (see the include list).
        'lib/github/orgTarget.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/orgInstallation.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/actionsVariables.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/repoVisibility.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ciFleet/runnerTarget.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/projectRunnerGroupRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/fleetReadinessService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/fleetOrgCiSettingService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/platformFleetOrgCiRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/fleetOrgCiSettingMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/admin/fleet-settings/actions.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/admin/fleet-settings/page.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/admin/fleet-settings/_components/FleetOrgCiSetting.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/admin/fleet-settings/_components/FleetSettingsUnavailable.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/admin/fleet-settings/_components/fleetReadinessCopy.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/fleetMachineKillRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/ciFleet/attributionErrors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/fleetAttributionAlert.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/fleetAttribution.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciRunnerProvisioningIntentRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/ciFleetAdmissionLockRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/fleetInFlightSlotRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/jobs/definitions/ciRunnerFleet.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-9359 · MOTIR-9427 (see the include list).
        'lib/ciFleet/fleetKindSwitches.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/fleetShardAdmissionService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/hostedAgentContainerService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1775 · MOTIR-1901 — the CI-minutes entitlement.
        'lib/ciMetering/allowance.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/ciAllowanceService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/ciPeriodChargeRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.7 · Subtask 5.7.6 — notification-preference channel gate.
        'lib/services/notificationPreferencesService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/notificationPreferenceRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/notificationPreferenceMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/notifications/preferences.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.7 · Subtask 5.7.7 — the in-app model + fan-in + read/mark API gate.
        'lib/repositories/notificationRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/notificationsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/notificationFanInService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/notificationFanIn.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/notifications/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/workItemsService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1789 (Agent runs) · MOTIR-1798 — the dispatch-run seam,
        // measured before it was pinned (see the `include` note above). Pinned at
        // the project's 90, NOT at the measured number: a threshold set to
        // today's figure turns every honest refactor into a red build, and the
        // floor is what the project actually asks of a file.
        'lib/services/dispatchRunService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dispatchRunRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dispatchRunCardRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/dispatchRunEventRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/dispatchRunMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3050 (see the `include` note above).
        'lib/workItems/blockerReadiness.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workItems/readyFilter.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2694 · Subtask MOTIR-2696 (see the `include` note above).
        'lib/workItems/embeddingDocument.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemEmbeddingRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/workItemEmbeddingsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/workItemEmbeddingSweepService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/workItemEmbedding.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2694 · Subtask MOTIR-2697 (see the `include` note above).
        'app/api/internal/ai/similar-work-items/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-4053 · Subtask MOTIR-4076 (see the `include` note above).
        'app/api/internal/ai/log-bug/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/aiWorkItemsService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2694 · Subtask MOTIR-2698 — the keys-not-prose enforcement
        // point (see the `include` note above; `aiBoundaryService.ts` is
        // deliberately NOT here, and that note says why).
        'lib/mappers/aiBoundaryMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // The prose-vs-graph advisory (MOTIR-1969) — an ADDITION beside the
        // finishability rules, gated on its own so a regression in it can't hide
        // inside workItemsService's blended number.
        'lib/workItems/proseVsGraph.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/proseGraphAdvisoryService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workItems/pathReference.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/pathReferenceAdvisoryService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workItems/repoDelivery.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRepoRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ai/projectRepoContext.ts': { branches: 90, functions: 90, lines: 90 },
        'components/workItems/RepositorySetField.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/services/backlogService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemLinkRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemRevisionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/workflowsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workflowsRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/reportsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/reportsMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/sprintRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/scale.ts': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/LineChart.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/BarChart.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/ChartFrame.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/ChartLegend.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/ChartDataTable.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/reports/_components/ReportHelp.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/reports/_components/ReportWindowControls.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/reports/_components/VelocityRangeControls.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/sprints/\\[id\\]/report/_components/SprintReportSprintPicker.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/ui/charts/ChartFrameSvg.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/PageChartFrame.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/HBarChartPage.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/HBarChartView.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/fitXTicks.ts': { branches: 90, functions: 90, lines: 90 },
        'components/ui/charts/useChartWidth.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/hooks/useReportHelpHidden.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/reports/sprintPicker.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/billing/aiEntitlement.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.1 (comments): the repo leaves land gated from day one
        // (Subtask 5.1.1); commentsService joins the list with 5.1.2.
        'lib/repositories/commentRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/commentMentionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/commentsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/commentMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mentions/parse.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.4 (labels/components/watchers): the repo leaves land gated
        // from day one (Subtask 5.4.1); the 5.4.2–5.4.4 services join next.
        'lib/repositories/labelRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemLabelRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // 5.4.2 — the folksonomy service layer gates with its tests.
        'lib/services/labelsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/labelMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/componentRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/workItemComponentRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/watcherRepository.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.5 (activity feed): the read service + the TOTAL renderer
        // registry (Subtask 5.5.1) gate from day one — the registry's
        // fallback/suppression branches are the mistake-#29 guarantee.
        'lib/services/activityService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/activity/renderers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/activityMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 5.3 (custom fields): the repo leaves land gated from day one
        // (Subtask 5.3.1); customFieldsService + mappers joined with 5.3.2
        // (the 5.3.3 values half extends the same files under this gate).
        'lib/repositories/customFieldDefinitionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/services/customFieldsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/customFieldMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/customFieldOptionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/customFieldValueRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story 5.2 (attachments): upload (2.3.7) + the 5.2.7 orphan-GC sweep
        // + the 5.2.2 management surface (repo leaf + panel mapper).
        'lib/services/attachmentsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/attachmentRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/attachmentMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.2 (saved filters): the 6.2.1 persistence + permission layer.
        'lib/services/savedFiltersService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/savedFilterRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/savedFilterStarRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/savedFilterMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/savedFilters/access.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/savedFilters/builtins.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.3 (dashboards) — the 6.3.1 substrate.
        'lib/services/dashboardsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dashboardRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/dashboardWidgetRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/dashboardMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/dashboards/widgetRegistry.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.3 (dashboards & reports): the 6.3.2 read substrate.
        'lib/reports/statisticTypes.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/reports/buckets.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/reports/params.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 6.6 (automation rules): the 6.6.1 backend.
        'lib/automation/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/automation/fields.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/automation/constants.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/automationRulesService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/automationRuleRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/automationRuleMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // 6.6.2 — the execution engine + audit-row leaf.
        'lib/services/automationEngineService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/automationRuleExecutionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story 7.2 · Subtask 7.2.11 (locked by 7.2.12) — org cost read service.
        'lib/services/aiUsageService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 7.8 · Subtask 7.8.1 — the PAT auth substrate.
        'lib/services/apiTokensService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/apiTokenRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/apiTokenMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/apiTokens/token.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/apiTokens/errors.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2572 · Subtask MOTIR-2585 — the permission GRANT and the
        // surfaces that offer it. Measured on this branch before pinning.
        'lib/tokens/grant.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/toolPermissions.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/permissionGate.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/scopes.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3342 — the unknown-argument gate (see the `include` note).
        'lib/mcp/strictInput.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/toolAnnotations.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/apiDocs/mcp.ts': { branches: 90, functions: 90, lines: 90 },
        'scripts/generateMcpToolSchemas.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/account/_components/permissionMeta.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/account/_components/CreateTokenModal.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/account/_components/apiTokensClient.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story 7.7 · Subtask 7.7.12 — the MCP registry + every tool module.
        'lib/mcp/registry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/getWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listReady.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/createWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/addComment.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/attachFile.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/searchWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listSprints.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1879 — the project-enumeration read (tests/mcp/list-projects.test.ts
        // walks both the populated and empty-list arms plus the thrown-error path).
        'lib/mcp/tools/listProjects.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/validateSprint.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3095 — measured at 100/100/100 before being pinned (see the
        // `include` note above); at 90 rather than 100 so a later branch can
        // land with its test in the same PR without the gate becoming a ratchet.
        'lib/mcp/tools/validatePlan.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/planRef.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-3097 — the story gate PINS what the story added, because
        // an unnamed new file is an ungated one. MEASURED FIRST, on this branch,
        // over `tests/mcp/plan-projection-gate` + `projected-reads` +
        // `validate-plan` + `tests/integration/plans/planValidityService` +
        // `tests/integration/ai/validatePlanRoutes`: 100 lines / 90.9 branches /
        // 100 functions. Pinned at 90, the floor it clears, rather than at the
        // measured number — a threshold nobody can land a new branch under is a
        // ratchet, and this file is the one both halves of the story read.
        'lib/services/planProjectionService.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-6352 · MOTIR-6373 — the edge disposition, at the same floor.
        'lib/workItems/edgeDisposition.ts': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3123 — the finishability engine, MEASURED FIRST on this
        // branch over its FULL consumer set (`tests/integration/plans/
        // planValidityService` + `tests/integration/ai/validatePlanRoutes` +
        // `tests/mcp/validate-plan` + `tests/mcp/plan-projection-gate` +
        // `tests/mcp/projected-reads` + `tests/rls/shared-read-seams` +
        // `tests/app-role-bound-context-reads`): 75.96 branches / 94.73
        // functions / 93.93 lines BEFORE this bug's cases, 92.85 / 100 / 100
        // after. A local subset can only UNDER-report against CI's full run, so
        // the floor below is cleared with room. Pinned at 90 rather than at the
        // measured number for the same reason as the line above — a threshold
        // nobody can land a new branch under is a ratchet.
        'lib/services/planValidityService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/createSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/updateSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/deleteSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/moveToSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/moveToBacklog.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/startSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/completeSprint.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/markIntegrated.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/linkWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3526 — MEASURED before being pinned (100 statements / 100
        // branches / 100 functions / 100 lines over the two new suites), then
        // pinned at the project's 90 rather than at the measurement, so ordinary
        // churn does not fail the build while a real regression does.
        'lib/mcp/tools/linkPullRequest.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/updateWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/archiveWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/deleteWorkItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/expandItem.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/dependencyEdges.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3098's two discovery reads (MOTIR-3102).
        'lib/mcp/tools/skeleton.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/searchWorkItemsSemantic.ts': { branches: 90, functions: 90, lines: 90 },
        // These four gate on functions + lines only: each carries DEFENSIVE
        // branches unreachable under shipped invariants, so a 90% BRANCH bar
        // would fail on un-coverable code.
        //   • whoami: the `user.name || user.email` fallback — `User.name` is
        //     non-nullable, so the email arm never runs.
        //   • transition_status: the illegal-transition enricher's open-policy
        //     arm (no IllegalTransitionError is thrown under `open`), its
        //     status-not-in-workflow guard (the item's status is always a real
        //     workflow status), and its terminal-status arm (no status in the
        //     default restricted workflow has zero outgoing transitions).
        //   • next_ready: the `contextRefs.length > 0` summary arm —
        //     `contextRefs` is not yet a persisted field, so it is always empty.
        //   • complete_session: the `reason ?? 'failed'` fallback — a `failed`
        //     outcome always carries the typed error's message.
        'lib/mcp/tools/whoami.ts': { functions: 90, lines: 90 },
        'lib/mcp/tools/transitionStatus.ts': { functions: 90, lines: 90 },
        'lib/mcp/tools/nextReady.ts': { functions: 90, lines: 90 },
        'lib/mcp/tools/completeSession.ts': { functions: 90, lines: 90 },
        // Story 7.10 · Subtask 7.10.8 (MOTIR-896) — the GitHub integration gate:
        // no untested branch in the webhook state machine or the feed dispatch.
        'lib/services/githubWebhookService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/githubInstallationService.ts': { branches: 90, functions: 90, lines: 90 },
        // codeGraphIndexService gates on functions + lines only: its
        // `workspace_missing` arm is DEFENSIVE and unreachable under shipped
        // invariants (GithubInstallation.workspace cascades on delete, so an
        // installation row can never outlive its workspace).
        'lib/services/codeGraphIndexService.ts': { functions: 90, lines: 90 },
        'lib/github/indexEnqueue.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/webhookSignature.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1775 · MOTIR-1781 — the repo-creation primitive (see the
        // `include` note): every branch of it either makes a repository exist or
        // decides whose an existing one is, and neither is undoable.
        'lib/github/repoProvisioning.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRepoProvisioningService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1916 · MOTIR-1972 — the per-project runner group (see the
        // `include` note): every branch decides which tenant's repositories a
        // fleet runner may serve.
        'lib/github/runnerGroups.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRunnerGroupService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1775 · MOTIR-1782 — the establish step + its wire contract.
        'lib/services/projectRepoEstablishService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/projectRepos/errorResponse.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-1775 · MOTIR-1945 — the team code-access surface.
        'lib/projectRepos/teamAccessView.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/project/code-access/_components/CodeAccessSettings.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-1775 · MOTIR-1939 — the take-it-over room (see the
        // `include` note).
        'lib/github/userOrgs.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectRepoRoomService.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/github/organizations/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/project/repositories/_components/TakeoverRow.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/project/repositories/_components/TakeoverModal.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/settings/project/repositories/_components/RepositoriesRoom.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // ⚠️ MOTIR-4820 MOVED THIS KEY, IT DID NOT DROP IT. It named
        // `ConnectedRepositories.tsx`, which that card deleted by folding the
        // section into the organisation one — and a key naming no file gates
        // NOTHING while looking exactly like a gate (`tests/coverage-gate-globs.test.ts`
        // is what turns that into a red build). The claims the key was bought for
        // are now branches of `OrganizationRepositories`, so the gate follows them
        // rather than being retired with the filename.
        'app/**/settings/project/repositories/_components/OrganizationRepositories.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/projectRepos/effectiveDomain.ts': { branches: 90, functions: 90, lines: 90 },
        // ⚠️ `statements` added by MOTIR-4681, which gave this module
        // `splitSetRowsByOrigin` (MOTIR-4820 replaced it with
        // `splitRoomSections`). The module was ALREADY pinned here, so the
        // story strengthens the existing row rather than adding a second one —
        // two entries for one path is a duplicate key, and the later wins
        // silently.
        'lib/projectRepos/roomSections.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'lib/planning/repositorySetClient.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/repositories/RepositorySetStep.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/[rowId]/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/[rowId]/state/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/[rowId]/move/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/projects/[key]/repositories/establish/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/ai/codeContext.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 7.30 · Subtask MOTIR-1732 — the plan-change conversation, the
        // planning-workspace host contract, and the rail's client state machine.
        // Story MOTIR-1343 · MOTIR-1819 — measured on this branch before pinning
        // (see the `include` note above for the numbers and for why the three
        // route files are report-only).
        'lib/services/aiAskService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/askResult.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1822 — the three ask ROUTES, pinned once the story gate made
        // their rethrow arms reachable (see the `include` note above for the
        // measured numbers). ⚠️ The stream route's key must use `**`, never a
        // literal `[jobId]`: in a glob that is a CHARACTER CLASS, so the literal
        // path names a directory that does not exist and the entry would gate
        // nothing while looking like it gated something.
        'app/api/ai/ask/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/ask/settle/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/ai/ask/**/stream/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/planChangeSessionsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/planChangeSessionRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/repositories/planChangeTurnRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/planChangeMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planChange/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/launcher.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/workspaceHost.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planChangeDiff.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planChangeClient.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/hooks/usePlanChangeConversation.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.12.3 (MOTIR-909) — the contextual-planning scope + orchestration.
        'lib/planChange/scope.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/contextualPlanningService.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-2787 — the planning-target lock, its lease module, its data leaf
        // and its recovery sweep.
        'lib/services/planTargetLockService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/planTargetLockRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/planChange/targetLock.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/planTargetLockSweep.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3064 — the abandoned-plan reconciler and its sweep job.
        'lib/services/abandonedPlanService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/abandonedPlanSweep.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.12.5 (MOTIR-911) — the persist-time confirmation gate.
        'lib/plans/validateProposals.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-6095 · MOTIR-6141 — the plan path's difficulty bar.
        'lib/plans/validateProposedDifficulty.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Story MOTIR-5544 · MOTIR-6283 — the run-found planning bug's composer.
        'lib/plans/runFoundPlanningBug.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Story MOTIR-5544 · MOTIR-6285 — the run-found report service.
        'lib/services/runFoundReportService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Story MOTIR-5544 · MOTIR-6232 — the story gate's four (measured above).
        'lib/plans/approvedShapeChange.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'lib/mcp/tools/getApprovedShapeVerdict.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'lib/repositories/runFoundReportRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'lib/mcp/tools/reportUnbuildableTarget.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Subtask 7.12.6 (MOTIR-912) — the shared review/confirm seam.
        'lib/planning/planReview.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planReviewClient.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.13.3 (MOTIR-916) — the unattended auto-plan cadence trigger.
        'lib/services/autoPlanCadenceService.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask 7.13.7 (MOTIR-920) — the rest of the Story 7.13 surface at the
        // same floor. `limits.ts` is the dependency-free module the settings
        // PANEL imports directly, so a regression in it reaches the browser with
        // no service test in the way.
        'lib/services/aiSprintPlanningService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/projectAiSettingsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/ai/sprintAssignment.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/projectAiSettingsMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/projectAiSettings/limits.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/autoPlanCadenceTick.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-1808 — the roadmap auto-drill surface at the same floor.
        // Story MOTIR-3833 · MOTIR-3840. Measured on the story's branch:
        // canvasGeometry L100 B92.42 F100 · RoadmapView L100 B97.29 F100 ·
        // useDependencyLegendCollapsed 100/100/100.
        'lib/planning/canvasGeometry.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/RoadmapView.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/hooks/useDependencyLegendCollapsed.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/ProjectRoadmapCanvas.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/WorkItemRoadmap.tsx': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2205 — the planning phase card's drill surface, same floor.
        'components/planning/preplanStationLevel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/PlanningOriginCluster.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/planning/workItemLevel.tsx': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-1870 — the `motir login` surface at the same floor.
        'lib/repositories/deviceCodeRepository.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/cliDeviceMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/cliDevice/constants.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/cliDevice/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/cliDevice/userCode.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/cli/device/approve/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/cli/device/grant/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/settings/account/_components/ConnectCliPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // These four gate on FUNCTIONS + LINES only — the same carve-out this
        // config already makes for `whoami` and friends, and the CLI lane makes
        // for `mcpClient` / `help`. Each is at 100% functions and ≥95% lines; what
        // the 90% BRANCH bar would fail on is un-coverable code, named here so a
        // future reader can tell a carve-out from a gap:
        //   • cliDeviceService — three `throw err` rethrows that re-raise anything
        //     the shipped invariants say cannot arrive: a non-`NotAMemberError`
        //     failure out of the mint, and the two `translate*Error` fall-throughs
        //     for a plugin error that is not an `APIError`. Reaching them means
        //     stubbing Better-Auth, which would test the stub.
        //     ⚠️ The LINE figure here is deliberately pinned by deterministic tests
        //     (Bug MOTIR-1955). Until then `translateApproveError` was executed only
        //     when the two-simultaneous-approvals race happened to make the loser
        //     fail at the plugin instead of at the pre-checks — an outcome the test
        //     asserts either way. When a CI run landed on the other side the file
        //     read 87.8% instead of 96.34% and this threshold failed a PR whose diff
        //     was one unrelated test file. The fix was to cover those branches
        //     deterministically, NOT to lower the number: a threshold that a race
        //     can cross is the defect, and lowering it would only widen the window.
        //   • start/route + token/route — a `body ?? {}` arm that cannot be null
        //     (the parse always assigns) and the poll's final rethrow for an error
        //     that is not a `DeviceGrantError`.
        //   • DeviceApproval — JSX presence conditionals (avatar, single- vs
        //     multi-workspace, the token-label chip) whose absent arms are already
        //     asserted through the rendered output rather than through a distinct
        //     branch, plus `readErrorCode`'s unparseable-body catch.
        'lib/services/cliDeviceService.ts': { functions: 90, lines: 90 },
        'app/api/cli/device/start/route.ts': { functions: 90, lines: 90 },
        'app/api/cli/device/token/route.ts': { functions: 90, lines: 90 },
        'app/**/device/_components/DeviceApproval.tsx': { functions: 90, lines: 90 },
        // Story MOTIR-1755 · MOTIR-1758 → gated by MOTIR-1760. The provenance
        // backfill's decision table (see the `include` note). It measures at
        // 100/100/100 today, so this pins what MOTIR-1758 already earned rather
        // than asking for new tests: the point of the gate is that the next edit
        // to a rule cannot quietly ship an unexercised branch.
        'lib/workItems/provenanceBackfill.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1965 — the historical-PR mirror backfill (see the `include`
        // note). Measured at 98/97/95/100 over its own two suites, so this pins
        // what the subtask earned rather than asking for catch-up tests; what
        // stays uncovered is the truncation flag (500 pages to reach) and one
        // non-Error fallback.
        'lib/github/historicalPullRequests.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/historicalPullRequestBackfillService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // MOTIR-3034 (see the `include` note). MEASURED over `tests/github/` +
        // `tests/integration/github/`, then pinned — not guessed:
        //   restRetry.ts                      100 / 100  / 100
        //   pullRequestBase.ts                100 /  96  / 100
        //   pullRequestBaseRefBackfillService 100 /  95  / 100
        //   repoSetCompletionService.ts        93 /  86  / 100   (lines/branches/functions)
        'lib/github/restRetry.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/github/pullRequestBase.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/pullRequestBaseRefBackfillService.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // ⚠️ `branches: 85` on this ONE file, and the reason is named rather than
        // left as a softer number somebody later reads as slippage. What stands
        // uncovered is a single arm: `updateStatus` throwing
        // `ProjectAccessDeniedError` / `ProjectNotFoundError`. The move is
        // attributed to the WORKSPACE OWNER (there is no change-request author on
        // this path), and a workspace owner passes `canEdit` on every
        // access mode — Members only included, where `lib/projects/access.ts`
        // admits them explicitly — so NO VALID FIXTURE produces that error. The
        // arm is still correct to keep: `reevaluateItems` loops, and an uncaught
        // throw there would abort a whole sweep's remaining repairs. Lines and
        // functions are pinned at 90 like every sibling; only the arm that cannot
        // be reached from a legitimate tenant is priced in.
        'lib/services/repoSetCompletionService.ts': {
          branches: 85,
          functions: 90,
          lines: 90,
        },
        // Story 7.24 · MOTIR-1812 → gated by MOTIR-1813 (see the `include` note).
        // Measured over the merged surface, all three files sit at 100/100/100
        // from the shell's own units, so this pins what MOTIR-1812 already earned
        // rather than asking for catch-up tests — the point of the gate is that
        // the NEXT action entry cannot quietly ship an unexercised row.
        'lib/planning/aiCallout.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/AiCalloutMenu.tsx': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-3208 — measured at 100/100/100/100 on this branch before pinning.
        'lib/planning/orbPhysics.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/PlanWithAIFab.tsx': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-1970 — the schedule-health detection seam (see the `include` note).
        'lib/jobs/cron.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/schedules.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/jobScheduleHealthService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/jobs/definitions/dailyHealthCheck.ts': { branches: 90, functions: 90, lines: 90 },
        // Story 11.6 · Subtask 11.6.2 (MOTIR-2228) — the payload seam. Explicit
        // per-file entries because an unnamed new file is an UNGATED one, and a
        // seam whose whole job is that nothing opts out silently must not.
        'lib/mcp/payloads/brand.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/define.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/exemptions.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/sharedResources.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/workItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/planning.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/workLoop.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/driftGuard.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/payloads/registry.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2284 · Subtask MOTIR-2289.
        'app/**/items/[key]/_components/ChildPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/[key]/_components/ChildList.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2560 · Subtask MOTIR-2567 — the editable quick-view rail's
        // story gate. MEASURED FIRST, then pinned (the order this file's header
        // argues for), over the story's own suites plus the three detail-rail
        // suites that drive the shared hooks:
        //
        //   IssueQuickViewPanel.tsx        100.0 L   96.8 B  100.0 F
        //   QuickViewRailEdit.tsx          100.0 L  100.0 B   94.1 F
        //   customFieldEditing.tsx         100.0 L   92.5 B  100.0 F
        //   fieldChipEditing.ts            100.0 L  100.0 B  100.0 F
        //   IssueQuickViewController.tsx    93.3 L   90.9 B  100.0 F
        //
        // Keyed `app/**/…`, never the literal `app/(authed)/…`: picomatch reads
        // the parentheses as a group, so the literal form matches NO file and
        // the threshold would pass vacuously (MOTIR-2449).
        'app/**/items/_components/IssueListPager.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/QuickViewRailEdit.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/fieldChipEditing.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/customFieldEditing.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/IssueQuickViewPanel.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-5308 · MOTIR-5317 — the folder surface, pinned at the floor.
        'lib/repositories/folderRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/foldersService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/folderMappers.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/folders/errors.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'components/folders/FolderCommands.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/folders/FolderDeleteDialog.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'components/folders/FolderNameField.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/folders/FolderPicker.tsx': { branches: 90, functions: 90, lines: 90 },
        'components/folders/FolderRowMenu.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/items/_components/QuickViewFolderField.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-5309 · MOTIR-5379 — the placement channel, pinned at the floor.
        'app/**/items/[key]/_components/PlacementProvider.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/[key]/_components/PlacementBreadcrumb.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/[key]/_components/ParentBreadcrumb.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/items/_components/IssueQuickViewController.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },

        // Story MOTIR-2664 · Subtask MOTIR-2671 — the design-result surface,
        // MEASURED on this branch before being pinned (263 tests across the 22
        // suites that touch these modules). Every file clears 90 on every axis;
        // the two tightest are `designEvidenceService.ts` and
        // `DesignResultPanel.tsx`, both at 90.9% branches, so the floor is real
        // rather than decorative — a couple of uncovered branches would breach
        // it. See the matching block in `include` above for why the two `app/**`
        // keys must not be written with a literal `(authed)`.
        'lib/services/designEvidenceService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/repositories/designEvidenceRepository.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'lib/mappers/designEvidenceMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-5553 · Subtask MOTIR-5566 — the approved-design read and
        // its doors, GATED rather than merely reported. They decide which design
        // an agent is handed, so an uncovered branch here is a run built against
        // a version nobody approved.
        'lib/services/designAccessService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/designAccessMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/api/v1/workItems/designPresenter.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/getDesign.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mcp/tools/listDesigns.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/work-items/**/designs/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/work-items/**/design/route.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/v1/projects/**/designs/route.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/designEvidence/errors.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/designEvidence/publishAuth.ts': { branches: 90, functions: 90, lines: 90 },
        // The shared CI-publisher gate MOTIR-2667 extracted, plus the acceptance
        // caller it was extracted FROM. Pinning both is the point: the extraction
        // is only safe for as long as the older caller keeps exercising it.
        'lib/publishAuth/ciPublishAuth.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/acceptanceEvidence/publishAuth.ts': { branches: 90, functions: 90, lines: 90 },
        // The allowlist is the file the one-directional `text/html` policy lives
        // in; a floor here is what keeps a future edit from widening the generic
        // list without a test noticing.
        'lib/blob/allowlist.ts': { branches: 90, functions: 90, lines: 90 },
        'app/api/work-items/**/design-evidence/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/api/work-items/**/design-evidence/upload-token/route.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/_components/DesignResultPanel.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-5215 · Subtask MOTIR-5230 — MEASURED before being pinned, on
        // the parent branch, over the story's own suites (the band, the story
        // gate, the section layout, the re-homed rail and files-kept guards, the
        // bridge): `DecidedGateStatusBridge.tsx` 100 on every axis;
        // `DesignResultSection.tsx` 100 statements / 100 functions / 100 lines,
        // and its branches at 100 once the story gate asserts the no-version
        // meta line in both the band and a kept state. Its one unreachable arm —
        // the frame's `onDecide` on a page with an empty verb set — carries a
        // `v8 ignore` that cites `design-result-section-story-gate.test.tsx`,
        // which asserts no verb exists for any state. Pinned at the repo's 90
        // floor, not at the measured number.
        'app/**/_components/DesignResultSection.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/_components/DecidedGateStatusBridge.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2649 · Subtask MOTIR-2655 — MEASURED before being pinned,
        // on this branch, with `tests/integration/workbench/`: 100 branches /
        // 100 functions / 100 lines on the service and the mapper, and 100 /
        // 100 / 92.3 on the cursor. Pinned at the repo's 90 floor rather than at
        // the measured number, so a later refactor has room without the gate
        // being loosened to make a build pass. (MOTIR-4782 renamed
        // `lib/home/` → `lib/workbench/`; the floors are unchanged.)
        'lib/workbench/tab.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-5213 · Subtask MOTIR-5221 — the landing cascade. MEASURED
        // before being pinned: 100 / 100 / 100 with `tests/workbench/landing.test.ts`
        // (the whole truth table), pinned at the repo's 90 floor.
        'lib/workbench/landing.ts': { branches: 90, functions: 90, lines: 90 },
        // ── Story MOTIR-5238 — THE WORKBENCH IS LIVE (MOTIR-5244's gate) ──────
        // MEASURED on this branch before being pinned, per this file's own rule,
        // with `tests/workbench/watermark-cursor.test.ts`,
        // `tests/integration/workbench/watermark-read.test.ts`,
        // `tests/api/workbench-stream-route.test.ts`,
        // `tests/components/workbench-live.test.tsx` and
        // `tests/components/approval-overlay-subject-moved.test.tsx`.
        //
        // The rule and the two pure functions over it: 100 / 100 / 100.
        'lib/workbench/liveRows.ts': { branches: 90, functions: 90, lines: 90 },
        // 100 lines / 100 functions, branches measured 93.33.
        'lib/workbench/watermarkCursor.ts': { branches: 90, functions: 90, lines: 90 },
        // The read itself: 100 / 100 / 100.
        'lib/services/workbenchWatermarkService.ts': { branches: 90, functions: 90, lines: 90 },
        // The host and the row rule: 100 / 100 / 100 apiece.
        'app/**/workbench/_components/WorkbenchLive.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/workbench/_components/useLiveRows.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // ⚠️ RAISED 85 → 90 BY MOTIR-5245, and the reason the 85 existed is worth
        // keeping because it was RIGHT and stopped being true. It was written for
        // the four `cancelled` / `aborted` guards inside the pump — *the reader
        // has already gone* — which are reachable only by resolving a `fetch`
        // after an unmount and winning a race with the abort. Those arms are
        // still there and still unreached; what changed is that the connection
        // gained arms a test CAN drive (the heartbeat watchdog, `offline`,
        // `online`, the per-connection abort), so the residual is a smaller
        // share of a bigger file: MEASURED 97.56 lines / 91.66 branches / 100
        // functions on this branch. The floor moves up to meet it rather than
        // sitting under a number nothing is defending.
        'app/**/workbench/_components/useWorkbenchLive.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // ⚠️ BRANCHES PINNED AT 85, WITH A REASON; lines 97.61 and functions 100.
        // Two arms remain and neither is reachable from a test worth writing.
        // The HEARTBEAT fires after fifteen seconds of silence — the suite's own
        // per-test timeout is fifteen seconds, so asserting it would mean either
        // a timeout or a second copy of the interval injected for the test's
        // benefit. And `if (!cancelled) controller.close()` is structurally
        // unreachable HERE: this stream has no terminal state, so the loop only
        // ever exits by cancellation. It is kept because it is the shipped
        // route's own shape, and a later terminal condition would need it.
        'app/**/workbench/stream/route.ts': { branches: 85, functions: 90, lines: 90 },
        'lib/services/homeService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/homeMappers.ts': { branches: 90, functions: 90, lines: 90 },
        // Subtask MOTIR-2653 — the page's own modules, MEASURED before being
        // pinned with `tests/components/workbench-list.test.tsx`.
        'app/**/workbench/_components/WorkbenchList.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/workbench/_components/WorkbenchTabs.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'app/**/workbench/_components/workbenchRows.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-8012 · Subtask MOTIR-8017 — the grouped work tabs, MEASURED on
        // this branch before being pinned, with `tests/components/workbench-grouped.test.tsx`,
        // `tests/components/workbench-list.test.tsx`, `tests/workbench/` and
        // `tests/integration/workbench/`:
        //
        //   WorkbenchGroupRow.tsx   100 stmts · 100 branch · 100 fn · 100 lines
        //   WorkbenchList.tsx       98.41 stmts · 98.5 branch · 100 fn · 100 lines
        //   workbenchRows.ts        97.77 stmts · 98 branch · 100 fn · 100 lines
        //   homeService.ts          99.47 stmts · 90.29 branch · 100 fn · 100 lines
        //
        // homeService's branch figure sits on the floor because of arms that predate
        // the grouping (the To fix / To resume reads) plus the grouping's defensive
        // race arms; the floor holds, so it is not loosened.
        'app/**/workbench/_components/WorkbenchGroupRow.tsx': {
          branches: 90,
          functions: 90,
          lines: 90,
        },
        // Story MOTIR-2982 · Subtask MOTIR-2992 — the agent-authored plan
        // surface, MEASURED on this branch before being pinned (the sequence
        // this block prescribes throughout), with `tests/mcp/author-plan.test.ts`,
        // `tests/components/PlanRow.test.tsx` and `tests/integration/plans/`:
        //
        //   lib/mcp/tools/authorPlan.ts        100 stmts · 97.05 branch · 100 fn · 100 lines
        //   app/**/plans/planRowView.ts        100 stmts · 95.65 branch · 100 fn · 100 lines
        //   app/**/plans/_components/PlanRow.tsx  100 stmts · 97.91 branch · 100 fn · 100 lines
        //
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/mcp/tools/authorPlan.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-3232 · Subtask MOTIR-3242 — the Plans surface, refined.
        // MEASURED on this branch before pinning (the sequence this block
        // prescribes throughout), with `tests/planning/planShape`,
        // `tests/planning/planView`, `tests/components/PlanProposalList`,
        // `tests/components/PlanStatusTabs` and
        // `tests/components/PlansList-streaming`:
        //
        //   lib/planning/planShape.ts                    100 stmts · 95.2 branch · 100 fn · 100 lines
        //   lib/planning/planView.ts                     100 stmts ·  100 branch · 100 fn · 100 lines
        //   components/planning/PlanProposalList.tsx    97.4 stmts · 97.9 branch · 100 fn · 100 lines
        //   app/**/plans/_components/PlanStatusTabs.tsx  100 stmts ·  100 branch · 100 fn · 100 lines
        //   app/**/plans/_components/PlansList.tsx       100 stmts ·  100 branch · 100 fn · 100 lines
        //
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/planning/planShape.ts': { branches: 90, functions: 90, lines: 90 },
        // MOTIR-6162 — both measured 100 on every axis. Pinned at the project's
        // 90 rather than at the measurement, so ordinary churn does not fail a
        // build for a rounding error. `planArrival.ts` is deliberately absent:
        // see the note beside its `include` entry.
        'lib/planning/surfaceArrival.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/surfaceFollow.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/planView.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/PlanProposalList.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/_components/PlanStatusTabs.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-6011 · Subtask MOTIR-6025 — the session list that replaced
        // the plan list, pinned at the 90 floor (measured figures in the PR).
        'lib/planning/planSessionFilter.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/planSessionsService.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/mappers/planSessionMappers.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/sessionRowView.ts': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/_components/SessionRow.tsx': { branches: 90, functions: 90, lines: 90 },
        'app/**/plans/_components/SessionsList.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-6043 · Subtask MOTIR-6045 — the destination rule and its
        // affordance, pinned at the 90 floor after being MEASURED on this branch
        // (both 100 / 100 / 100 / 100 over `tests/planning/planDestination`,
        // `tests/components/plan-row-destination-agreement` and
        // `tests/integration/planning/planRowDestinationGate`; `SessionRow.tsx`
        // re-measured at 93.44 branches / 100 functions / 94.87 lines, still
        // clear of the pin it already carried).
        'lib/planning/planDestination.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/PlanDestinationTag.tsx': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-8590 · Subtask MOTIR-8596 — follow the planner (see `include`).
        // Measured with the story's unit floors and its integration gate:
        //   plannerDrive.ts             100 branch · 100 fn · 100 lines
        //   FollowPlannerControl.tsx    100 branch · 100 fn · 100 lines
        //   typeIn.ts                  97.9 branch · 100 fn · 100 lines
        //   TypeInText.tsx             91.9 branch · 100 fn · 100 lines
        //   usePrefersReducedMotion.ts  100 branch · 100 fn · 100 lines
        'lib/planning/plannerDrive.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/FollowPlannerControl.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/planning/typeIn.ts': { branches: 90, functions: 90, lines: 90 },
        'components/planning/TypeInText.tsx': { branches: 90, functions: 90, lines: 90 },
        'lib/hooks/usePrefersReducedMotion.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-2999 · Subtask MOTIR-3008 — the `implemented` lifecycle
        // (see the `include` note above for why these five and not the three
        // pre-existing files the story also widened). MEASURED on this branch
        // first, with `tests/workflows/`, `tests/github/ciGreenPromotion`,
        // `tests/github/ciExpectedCheckSet`,
        // `tests/github/changeRequestSessionCloseOut`,
        // `tests/components/status-pill` and
        // `tests/integration/implemented-lifecycle`:
        //
        //   lib/services/ciPromotion.ts            97.5 stmts · 94.44 branch · 100 fn · 100 lines
        //   lib/services/changeRequestWorkItems.ts  100 · 100 · 100 · 100
        //   lib/workflows/defaultWorkflow.ts        100 · 100 · 100 · 100
        //   lib/workflows/statusColor.ts            100 · 100 · 100 · 100
        //   components/issues/StatusPill.tsx        100 · 100 · 100 · 100
        //
        // ⚠️ RE-MEASURED (MOTIR-4199): `ciPromotion.ts` is now
        // **97.7 stmts · 93.1 branch · 100 fn · 100 lines**, with
        // `tests/github/ciExpectedCheckSet` added to the list above. The
        // sentence that stood here said it had **one** uncovered branch; it has
        // two, and the count is stated rather than left to be re-derived:
        //
        //   * the rethrow of an error that is NOT one of the refusals a per-card
        //     skip tolerates — the original, unchanged, reachable only by
        //     injecting a fault into the shipped service, which would assert the
        //     mock rather than the code;
        //   * `if (!subject) continue` in the check-set reconcile — a pull
        //     request row that vanishes between being listed and being read,
        //     inside ONE transaction. Kept because the read is nullable and the
        //     compiler says so; not reachable from a test that does not fabricate
        //     the race.
        //
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass
        // — which is what that headroom just paid for.
        'lib/services/ciPromotion.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/services/changeRequestWorkItems.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workflows/defaultWorkflow.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/workflows/statusColor.ts': { branches: 90, functions: 90, lines: 90 },
        'components/issues/StatusPill.tsx': { branches: 90, functions: 90, lines: 90 },
        // Bug MOTIR-3209 — supersede by RUN, not by name. MEASURED on this
        // branch first, with `tests/github/prCiState` and
        // `tests/github/cancelledSuiteSupersession`:
        //
        //   lib/github/checkSuites.ts   97.56 stmts · 92.85 branch · 100 fn · 100 lines
        //
        // The two uncovered branches are the non-numeric suite-id tier — a
        // deterministic fallback for an id shape neither host mints today, kept
        // so the ordering stays total rather than because anything reaches it.
        // Pinned at the 90 floor rather than at the measured number, so a later
        // refactor has room without anyone loosening a gate to make a build pass.
        'lib/github/checkSuites.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-4237 · Subtask MOTIR-4240 — the Help menu and the context
        // widened to give it a door, both MEASURED at 100 on all four axes
        // before being pinned (see the `include` block). Pinned at the 90 floor
        // rather than at the measured 100, so a later refactor has room without
        // anyone loosening a gate to make a build pass.
        //
        // ⚠️ `SidebarNav.tsx` is on ALL FOUR axes since MOTIR-4368. It arrived
        // here with THREE (MOTIR-4324, statements / functions / lines at 100
        // after the dead "Soon" badge was retired) and `branches` deliberately
        // absent: at 86.95 it was under the floor, and an axis is left OFF
        // rather than pinned below 90, which would be lowering a bar to make a
        // build pass. MOTIR-4368 closed the gap by writing the missing specs —
        // the drawer arm of both settings rails and the workspace-settings row's
        // five-clause `active:` predicate — and the axis is pinned at the same
        // 90 floor as its three siblings, on a measured 100. Its `include` entry
        // carries the before/after numbers.
        'app/**/_components/SidebarNav.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/HelpMenu.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/_components/CommandPaletteProvider.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // MOTIR-4518 — the index container's motir-ai address preflight, on all
        // four axes, MEASURED at 100 on each before being pinned (the numbers
        // and the command are in its `include` entry above). Pinned at the 90
        // floor rather than at the measured 100, so a later refactor has room
        // without anyone loosening a gate to make a build pass.
        'lib/ai/containerAiAddress.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4337 · MOTIR-4573. Measured first (see `include`), then
        //    pinned at the 90 floor rather than at the measured number, so a
        //    later refactor has room without anyone loosening a gate.
        'lib/repositories/platformOrganizationRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/platformBillingClassificationService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/platformMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/platform/auditActions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/platform/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ai/tenantOrg.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/admin/tenants/[orgId]/actions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ⚠️ THIS ONE'S BRANCH FLOOR IS 85, NOT 90, and the reason is stated
        // rather than rounded away — the same shape as
        // `publicFollowDigestService` above. Its two uncovered arms are
        // DEFENSIVE and unreachable through the component's own surface:
        //
        //   · `submit()`'s `if (!trimmed) return` — the primary is `disabled`
        //     until a non-blank reason is typed, so a blank one cannot reach the
        //     handler. It is the belt to that button's braces, and the file's
        //     own header says why a client-side check is never the enforcement.
        //   · `onOpenChange`'s `next === true` arm — `open` is driven by this
        //     component's own Button, not by a `Dialog.Trigger`, so Radix never
        //     asks it to OPEN.
        //
        // The alternative was deleting the arms to buy the number, which trades
        // real safety for a metric. 85 is a RATCHET just under the measured
        // 85.71: it still fails on a regression, and it lowers nothing on the
        // three axes that hold at 95.83 / 100 / 100.
        'app/**/admin/tenants/[orgId]/_components/ClassificationBar.tsx': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'app/**/organization/usage/_components/searchUsage.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/organization/billing/_components/searchFigures.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Bug MOTIR-5150 — MEASURED on this branch at 100 statements / 100
        // branches / 100 functions / 100 lines by
        // `tests/github/prReferenceQuery.test.ts`, then pinned at the list's
        // ordinary floor rather than at the measurement.
        'lib/github/prReferenceQuery.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-4928 · Subtask MOTIR-5263 — pinned at the list's ordinary
        // floor after measuring (see the `include` note above).
        'lib/monitors/connectResult.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/connectState.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/errorResponse.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/errors.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/index.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/provider.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/registry.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/returnBanner.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/returnSurface.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/tokenCrypto.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/providers/fake.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/monitors/providers/sentry.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/monitorConnectionService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/monitorCredentialService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/monitorConnectionRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/monitorInstallationRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/monitorMappers.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // Story MOTIR-4929 · Subtask MOTIR-5583 — the ingestion surface, at the
        // list's ordinary floor (measured values in the include note above).
        'lib/monitors/levels.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/pollLine.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/repositories/monitorIssueRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/monitorIngestionService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/monitorIssueReconcile.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-4931 · Subtask MOTIR-5708 — measured at 100 on all four.
        'lib/services/monitorSyncService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/monitorIssueResolve.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/monitors/syncStates.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // Story MOTIR-4932 · Subtask MOTIR-5733 — measured at 100 on all four.
        'lib/services/monitorIssueService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/monitorIssueLinkService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/monitorIssueLinkMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/_components/MonitorErrorsSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/_components/MonitorErrorsLinkControl.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/_components/MonitorErrorsCard.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-4930 · Subtask MOTIR-5852 — the enrichment surface, at the
        // list's ordinary floor (measured values on MOTIR-5852).
        'lib/jobs/definitions/monitorBugEnrich.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/monitorBugEnrichmentService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ai/authoredBug.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // Story MOTIR-5975 · Subtask MOTIR-5984 — measured values in the include note.
        'lib/monitors/evidence.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitors/asFiled.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/services/monitorContextRead.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/monitorBugEnrichBackfill.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/items/[key]/_components/MonitorErrorEvidence.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/project/monitoring/_components/MonitoringRoom.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-4906 · HOW TO TEST per RUN (Subtask MOTIR-5337) ────────
        // MEASURED on the parent branch before pinning (stmts / branches / funcs /
        // lines). Fourteen files at 100 on all four axes; `howToTestService.ts`
        // 100 / 91.66 / 100 / 100, `testInstructionsService.ts` 99 / 93.93 / 100 /
        // 100 and `publishTestInstructions.ts` 100 / 90 / 100 / 100 — each remaining
        // arm a race or a schema-enforced absence (a lock that finds no row after the
        // read that found it; a repository section index the record always has).
        'lib/testInstructions/caps.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/testInstructions/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/testInstructionsRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/testInstructionsRepoRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/repoDeploymentRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/config.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/hostName.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/states.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/previewDatabase.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/previewDeploymentRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/enablement.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/github/repositoryActionsConfig.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/previewEnablementService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/lifecycleEvents.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/github/previewDeployments.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/previewLifecycleService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/previewLifecycle.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/ciMetering/previewRates.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/previewUsageRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/ciPreviewUsageMeterService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/previewUsageAccrual.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/previewEnablementSweep.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/gate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/gateProxy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/preview/failureReason.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/previewGateService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/previewGateAdmissionRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/preview/PreviewGateFrame.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/testInstructionsMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/testInstructionsService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/repoDeploymentService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/howToTestService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mcp/tools/publishTestInstructions.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/dispatch/runCloseOutPrompt.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/dispatch-runs/[id]/close-out-prompt/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/v1/work-items/[key]/how-to-test/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/howToTest/HowToTestBlock.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/markdown/CopyableCodeBlock.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-5469 · SEE WHICH CARDS ARE RED (gate MOTIR-5477) ───────
        //
        // MEASURED on the parent branch before being pinned, per the note at the
        // top of `include`, over the story's own specs — `tests/github/cardCiState`,
        // `ciStateBackfill`, `ciStateStoryGate`, `developmentSurface`,
        // `tests/workItems/ciBadgeState`, `tests/components/{items-ci-badge,
        // ci-badge-done-rule,board-card,workbench-list}` (9 files / 111 tests):
        //
        //   lib/services/deliveryVerdict.ts                 100 / 100 / 100 / 100
        //   components/github/ciStateMeta.ts                100 / 100 / 100 / 100
        //   components/github/CiStateBadge.tsx              100 / 100 / 100 / 100
        //   lib/services/workItemCiStateBackfillService.ts  96.15 / 100 / 100 / 95.65
        //   (stmts / branches / funcs / lines)
        //
        // ⚠️ THREE ARMS ARE IGNORED RATHER THAN COVERED, each with its reason ON
        // the directive and the test that pins its surroundings NAMED there, per
        // MOTIR-5477 §1. They are NOT dead code, and the directives say so:
        //
        //   * `deliveryVerdict.ts`'s `if (!item)` below the row lock — genuinely
        //     unreachable, because `lockById` and `findById` resolve the SAME
        //     unfiltered id in ONE transaction. `ciStateStoryGate` §6 asserts that
        //     invariant, so a `findById` that starts filtering fails there.
        //   * the backfill's `gone` arm, both halves — a RACE arm: the sweep can
        //     run for minutes after `collectCandidates`, so a card really can be
        //     deleted underneath it. Driving it needs a delete timed inside a sweep
        //     a test cannot pause.
        //   * the backfill's non-`Error` throw — reaching it means injecting a
        //     fault into the shipped recompute, which asserts the mock. What the
        //     arm buys is asserted instead: `ciStateStoryGate` §3 pins
        //     `report.failed` EMPTY across three card shapes.
        //
        // The backfill's remaining uncovered LINES (211-212) are the body of that
        // same `failed.push`. Pinned at the project's 90 floor, not at the reading,
        // so a later refactor has room without anyone loosening a gate.
        'lib/services/deliveryVerdict.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/workItemCiStateBackfillService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/ciStateMeta.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/github/CiStateBadge.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6588 · TO FIX (gate MOTIR-6606) ─────────────────────────
        // MEASURED on the parent branch over the story's own specs (21 files / 386
        // tests), lines / branches / functions:
        //   fixReasonService 100 / 95.45 / 100 · repairPredicate 100 / 97.5 / 100 ·
        //   workItems/fixReason 100 / 97.14 / 100 · fixReasonMappers 100 / 94.73 / 100 ·
        //   workItemFixReasonBackfillService 100 / 95.65 / 100 · WorkbenchFixLine 100 / 100 / 100.
        // Pinned at the project's 90 floor, not at the reading.
        'lib/services/fixReasonService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/repairPredicate.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/workItems/fixReason.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/fixReasonMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/workItemFixReasonBackfillService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7589 · ONE ENTRY PER RUN: the entry resolver, at the project floor.
        'lib/services/fixGroupService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/workbench/_components/WorkbenchFixLine.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-6068 · the refusal seed (Subtask MOTIR-6212) — see `include`. ──
        'lib/planning/refusalSeed.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/planningSeedService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/approval-gates/**/planning-seed/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/planning/planningSeedClient.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/approvals/RefusalReplan.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/approvals/useOpenRefusalReplan.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // ── Story MOTIR-7170 · Claude shows as verified (gate MOTIR-7175) — see `include`. ──
        'lib/auth/lazyResourceSeed.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/oauth/clientMetadataDocument.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/discoveredClient.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        // ── Story MOTIR-6973 · the OAuth door (gate MOTIR-6987) — see `include`. ──
        'app/**/oauth/_components/ConsentRefused.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/oauth/_components/ConsentScreen.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/oauth/_components/consentParts.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/oauth/consent/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/oauth/error/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/ConnectedAppsSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/PermissionPicker.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/settings/account/_components/connectedAppsClient.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/.well-known/oauth-authorization-server/\\[\\[...path\\]\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/.well-known/oauth-protected-resource/\\[\\[...path\\]\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/account/oauth-connections/\\[id\\]/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/account/oauth-connections/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/api/oauth/consent/route.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/auth/mcpOAuthPolicy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/jobs/definitions/oauthSweep.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/mappers/oauthConnectionMappers.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/authorizeReturn.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/config.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/consentContext.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/cors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/errors.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/metadata.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/redirectPolicy.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/oauth/wellKnownPaths.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/oauthAccessTokenRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/oauthClientRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/repositories/oauthRefreshTokenRepository.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/oauthConnectionsService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/services/oauthSweepService.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7471 · MOTIR-7487 — measured above, pinned at the floor.
        'lib/ai/guideFiles.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/hooks/useGuideTurnFiles.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/planning/GuideTurnFiles.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-7730 · MOTIR-7760 — measured above (`include`), pinned at the floor.
        'i18n/request.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/acceptLanguage.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/actions.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/englishFallback.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/localeCookie.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/locales.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/messages.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/resolveLocale.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/i18n/seedLocale.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/auth/localeSync.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/utils/datetime.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'scripts/i18n/catalogue.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'scripts/i18n/glossary.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'scripts/i18n/messageShape.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'scripts/i18n/sourceRecord.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'components/i18n/AuthLanguageControl.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-5266 · MOTIR-7877 — measured above (`include`), pinned at the floor.
        'app/**/ready/_components/ExpansionNudgeBanner.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        // Story MOTIR-8537 · MOTIR-8556 — see `include` above.
        'lib/monitoring/config.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/serverInit.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/transactionSpan.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/requestLabel.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/requestDbTiming.ts': { branches: 90, functions: 90, lines: 90 },
        'lib/monitoring/metricsServer.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-9710 · MOTIR-9889 — measured above (`include`); the three under
        // the floor are pinned at their measurement, for the reason given there.
        'lib/monitoring/cloudwatchMetrics.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'lib/monitoring/breachTask.ts': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'lib/monitoring/processPressure.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'lib/monitoring/watchdogMetrics.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
          statements: 90,
        },
        'lib/monitoring/loopBlockWatchdog.ts': {
          lines: 90,
          functions: 90,
          branches: 60,
          statements: 85,
        },
        'lib/mcp/toolTracing.ts': { branches: 90, functions: 90, lines: 90 },
        'scripts/pgTopStatements.ts': { branches: 90, functions: 90, lines: 90 },
        'scripts/pgTopStatementsQuery.ts': { branches: 90, functions: 90, lines: 90 },
        // Story MOTIR-8238 · MOTIR-8256 — measured above (`include`), pinned at the floor.
        'components/onboarding/layout/OnboardingBrandBar.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/OnboardingHero.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/OnboardingLinkOut.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/OnboardingSection.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/OnboardingWizardBar.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/OnboardingWorkBand.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/SectionArt.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/WarmButton.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/layout/index.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/brand/HeroWaves.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/OnboardingEntrance.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'components/onboarding/OnboardingTopBar.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/onboarding/how-it-works/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        'app/**/onboarding/direction/\\[tier\\]/page.tsx': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(fileURLToPath(new URL('.', import.meta.url))),
      // `import 'server-only'` is a Next build-time marker with no plain-node
      // resolution; alias it to an empty stub so server-only modules (e.g.
      // lib/ai/motirAiClient) import cleanly under Vitest. The Next build still
      // enforces the real boundary.
      'server-only': resolve(
        fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
      ),
    },
  },
});
