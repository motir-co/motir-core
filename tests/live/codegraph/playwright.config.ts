import { defineConfig } from '@playwright/test';

// The live code-graph lane's config (MOTIR-12260). Run it through
// `pnpm test:live:codegraph` (`lane.mjs`), which brings the stack up and hands this
// config its addresses; on its own it has nothing to talk to.
//
// ⚠️ IT NEVER SKIPS. Every input the suite reads is checked HERE, when the config
// loads, before any case runs, and a missing or blank one fails the run and names
// itself. The default Playwright lane cannot pick this suite up (its `testDir` is
// `tests/e2e`) and the default Vitest run cannot either (it matches `*.test.*`).

export const LIVE_INPUTS = [
  'LIVE_CORE_URL',
  'LIVE_CORE_DATABASE_URL',
  'LIVE_AI_DATABASE_URL',
  'LIVE_CODEGRAPH_URL',
  'LIVE_CODEGRAPH_DATABASE_URL',
  'LIVE_CODEGRAPH_READ_TOKEN',
  'LIVE_CODEGRAPH_WORKER_LOG',
  'LIVE_SCENARIO',
  'LIVE_GITHUB_LOG',
  'LIVE_ARCHIVE_ORIGIN',
  'LIVE_DEFAULT_BRANCH_WINDOW_MS',
  'LIVE_REF_WINDOW_MS',
  'LIVE_SWEEP_INTERVAL_MS',
  'LIVE_AI_COMMIT',
  'LIVE_CODEGRAPH_COMMIT',
  // The app's own modules the suite seeds through read these two.
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
] as const;

const missing = LIVE_INPUTS.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(
    `The live code-graph lane is missing ${missing.join(', ')}. Run it with ` +
      '`pnpm test:live:codegraph`, which starts the stack and sets them (tests/live/codegraph/README.md).',
  );
}

export default defineConfig({
  testDir: '.',
  // `server-only` resolves to the runner's empty stub, as the default lane's config
  // does (MOTIR-921): the suite seeds through services that import it.
  tsconfig: '../../../tsconfig.node.json',
  testMatch: '*.live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Two real-time windows (two and ten minutes) are walked in one serial suite.
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  // Artifacts go to the lane's work dir, never into the checkout.
  outputDir: process.env['LIVE_OUTPUT_DIR'] ?? 'test-results',
  use: { baseURL: process.env['LIVE_CORE_URL'] },
});
