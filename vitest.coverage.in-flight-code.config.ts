import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-6617's `motir-core` COVERAGE FLOOR (MOTIR-6621) — the in-flight
// code a planner reads: where a card's unmerged code lives (`inFlightCode` on the
// item read, MOTIR-6618) and which paths a branch changed (`repo-changes`, both
// providers, MOTIR-6619).
//
// Same shape and same reasoning as `vitest.coverage.approved-status.config.ts`:
// PER-FILE, measured on this branch before being pinned, scoped to the specs that
// actually reach these files, and the base config spread rather than replaced.
//
// ⚠️ WHAT IS GATED AND WHAT IS ONLY REPORTED.
//   • GATED at the project floor — the three files this story WROTE:
//     `inFlightCode.ts`, `repoChangesService.ts` and the `repo-changes` route.
//   • REPORTED, NOT GATED — the four files it WIDENED:
//     `aiBoundaryService.ts` (already report-only in the root config, for Story
//     7.5's defensive arms this story does not own), `aiBoundaryMappers.ts`
//     (already gated at 90 in the root config — a second gate here would gate
//     this story on the rest of the module), and `lib/git/providers/{github,gitlab}.ts`
//     — whole providers of which this story added one method each. A per-file
//     number over a provider measures its pre-existing readers and parsers, which
//     this lane does not run. The story's OWN arms in those four files
//     (`readInFlightCode` + the `getItem` change; `toInFlightDeliveryFact`; each
//     `listChangedFiles` and its helpers) were measured PER FUNCTION off this
//     lane's json report and are named in the MOTIR-6621 PR.
//
// It needs Postgres: the item read, the delivery rows and the route all run
// against a real database, per the repository's own convention.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/services/inFlightCode.test.ts',
      'tests/integration/ai/readbackDepth.test.ts',
      'tests/integration/ai/readbackDepthRoutes.test.ts',
      'tests/git/listChangedFiles.test.ts',
      'tests/integration/ai/repoChangesRoute.test.ts',
      'tests/integration/ai/inFlightCodeStoryGate.test.ts',
      // MOTIR-10069 — the same answer on the MCP: `get_work_item`'s `inFlightCode`
      // and the project-keyed `list_changed_files` over `repoChangesService`.
      'tests/mcp/get-work-item-in-flight.test.ts',
      'tests/mcp/list-changed-files.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      all: false,
      include: [
        'lib/services/inFlightCode.ts',
        'lib/services/inFlightCodeService.ts',
        'lib/mcp/inFlightCode.ts',
        'lib/services/repoChangesService.ts',
        'app/api/internal/ai/repo-changes/route.ts',
        'lib/services/aiBoundaryService.ts',
        'lib/mappers/aiBoundaryMappers.ts',
        'lib/git/providers/github.ts',
        'lib/git/providers/gitlab.ts',
      ],
      // Read off THIS lane's own command on 2026-09-27 (stmts / branch / fn / lines):
      //
      //   inFlightCode.ts            100 / 93.33 / 100 / 100
      //   repoChangesService.ts      100 /   100 / 100 / 100
      //   repo-changes/route.ts    95.23 /    90 / 100 /  95
      //
      // ⚠️ THE TWO NAMED RESIDUALS. `inFlightCode.ts`'s comparator has an EQUAL arm
      // no input reaches (it sorts Map / Set keys, which are unique), and the
      // route's rethrow of a NON-job error out of `authenticateAndLimitJobRequest`
      // needs the rate-limit store itself to fail. Both are pinned at the floor, not
      // at the reading, for the reason the approved-status lane gives.
      thresholds: {
        perFile: true,
        'lib/services/inFlightCode.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        // MOTIR-10069 — the read shared by `get_item` and the MCP's `get_work_item`,
        // and the MCP's in-flight lines.
        'lib/services/inFlightCodeService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/mcp/inFlightCode.ts': { statements: 90, functions: 90, branches: 90, lines: 90 },
        'lib/services/repoChangesService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/api/internal/ai/repo-changes/route.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
      },
    },
  },
});
