import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-7858's `motir-core` COVERAGE FLOOR (MOTIR-7865) — the three MCP
// code-read tools an agent planning over the MCP reads code through: `read_file`
// (MOTIR-7861) and `code_explore` / `code_search` (MOTIR-7862), and `code_grep`
// (MOTIR-10066).
//
// Same shape and reasoning as `vitest.coverage.in-flight-code.config.ts`:
// PER-FILE, measured on this branch before being pinned, scoped to the specs that
// reach these files, and the base config spread rather than replaced.
//
// ⚠️ WHAT IS GATED AND WHAT IS ONLY REPORTED.
//   • GATED at the project floor — the three files this story WROTE:
//     `lib/mcp/tools/readFile.ts`, `lib/mcp/tools/codeGraphRead.ts` and
//     `lib/services/codeGraphReadService.ts` — and the drift a read carries
//     (MOTIR-10094), `lib/services/codeGraphReadDriftService.ts`.
//   • REPORTED, NOT GATED — the two whole modules it WIDENED by one function
//     each: `lib/services/repoFileReadService.ts` (`readProjectFile`) and
//     `lib/ai/motirAiClient.ts` (`readCodeGraph`). A per-file number over either
//     measures its other readers, which this lane does not run. The story's own
//     two functions were read PER FUNCTION off this lane's json report:
//
//       readProjectFile   (repoFileReadService.ts)  fn 100 · every line hit
//       readCodeGraph     (motirAiClient.ts)        fn 100 · every line hit
//
// It needs Postgres: the project, its repository set, the code-context facts and
// every permission decision run against a real database, per the repository's own
// convention.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/mcp/code-read-door.test.ts',
      'tests/mcp/code-read-tool-tables.test.ts',
      'tests/mcp/read-file.test.ts',
      'tests/mcp/list-changed-files.test.ts',
      'tests/mcp/code-graph-read.test.ts',
      'tests/services/codeGraphReadDriftService.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      all: false,
      include: [
        'lib/mcp/tools/readFile.ts',
        'lib/mcp/tools/listChangedFiles.ts',
        'lib/mcp/tools/codeGraphRead.ts',
        'lib/services/codeGraphReadService.ts',
        'lib/services/codeGraphReadDriftService.ts',
        'lib/services/repoFileReadService.ts',
        'lib/ai/motirAiClient.ts',
      ],
      // Read off THIS lane's own command on 2026-10-08 (stmts / branch / fn / lines):
      //
      //   readFile.ts                97.82 / 92.30 / 100 / 97.77
      //   codeGraphRead.ts           97.22 /   100 / 100 / 97.14
      //   codeGraphReadService.ts      100 /   100 / 100 /   100
      //
      // ⚠️ THE NAMED RESIDUALS. Each tool's `registerTool` handler wraps its run in
      // a second `try` whose catch is reached only when `resolveContext` itself
      // throws — the MCP route authenticates before a tool is called, so no
      // in-process client can reach it. Pinned at the floor, not at the reading,
      // for the reason the approved-status lane gives.
      thresholds: {
        perFile: true,
        'lib/mcp/tools/readFile.ts': { statements: 90, functions: 90, branches: 90, lines: 90 },
        // MOTIR-10069 — the MCP's `list_changed_files`, beside `read_file`.
        'lib/mcp/tools/listChangedFiles.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/mcp/tools/codeGraphRead.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/codeGraphReadService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/codeGraphReadDriftService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
      },
    },
  },
});
