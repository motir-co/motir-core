import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// SET A REPOSITORY'S ENVIRONMENT — Story MOTIR-9795's coverage floor (MOTIR-9967).
// Every SERVER-side motir-core file the story added (MOTIR-9960 · 9961 · 9962 ·
// 9964 · 9966), NAMED below and held to the per-file floor of 90% statements,
// functions, branches and lines. Measured over the story gate
// (`tests/environmentConfig/storyIntegration.test.ts`: the HTTP doors in, the
// deploy's `resolveEnvironment` out, real Postgres) plus the per-card suites.
// Mirrors `vitest.coverage.deploy-port.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// NOT measured, on purpose:
//   * the CLIENT files — the room (`app/(authed)/settings/project/environment/**`)
//     and its browser client (`lib/environmentConfig/client.ts`): their suites are
//     component tests under happy-dom, run by the main suite, and the story's E2E
//     (MOTIR-9968) drives them end to end;
//   * `scripts/build-deploy-check.mjs` and the env-reporter fixture (MOTIR-9965):
//     a build script and a fixture app, run by `tests/hosting/envReporter.test.ts`
//     in child processes out of v8's reach;
//   * the SHARED files the story extended by a few lines (below), whose remainder
//     is other stories' code measured by their own suites.

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/**
 * The two repositories' one uncovered arm each is `tx ?? dbRead`: the read with NO
 * transaction. Every caller passes one, and the RLS call-site guard
 * (`tests/rls/test-call-site-guard.test.ts`) forbids a test from making the
 * unbound read, so the arm is unreachable from a test by design. Their branches
 * are held at the measured 50; their other three measures stay at {@link FLOOR}.
 */
const BRANCH_HELD = new Set([
  'lib/repositories/environmentConfigEntryRepository.ts',
  'lib/repositories/environmentConfigChangeRepository.ts',
]);

/** Every file below is held to {@link FLOOR}, whole-file, except {@link BRANCH_HELD}. */
const MEASURED = [
  // MOTIR-9960 — the vocabulary, the reserved names and the secret crypto.
  'lib/environmentConfig/vocabulary.ts',
  'lib/environmentConfig/reservedNames.ts',
  'lib/environmentConfig/crypto.ts',
  'lib/environmentConfig/errors.ts',
  'lib/repositories/environmentConfigEntryRepository.ts',
  'lib/repositories/environmentConfigChangeRepository.ts',
  // MOTIR-9961 — the service, its DTOs and mappers.
  'lib/services/environmentConfigService.ts',
  'lib/dto/environmentConfig.ts',
  'lib/mappers/environmentConfigMappers.ts',
  // MOTIR-9962 — the deploy's read and its flag seam.
  'lib/environmentConfig/resolveEnvironment.ts',
  'lib/environmentConfig/flagSource.ts',
  // MOTIR-9964 — the four HTTP doors, their body schema and status mapping.
  'app/api/projects/**/environments/**/route.ts',
  'lib/environmentConfig/requestSchema.ts',
  'lib/environmentConfig/httpErrors.ts',
  // MOTIR-9966 — which repositories the room offers.
  'lib/environmentConfig/motirRepositories.ts',
];

/**
 * SHARED files the story also changed, NAMED and deliberately NOT floored here:
 * the settings registry (one entry and one availability axis), the authed layout
 * (one computed prop), the job event map (one event), and the deploy check (its
 * stored-environment step, floored by `vitest.coverage.deploy-port.config.ts`).
 */
export const SHARED_NOT_FLOORED = [
  'lib/settings/projectSettingsNav.ts',
  'app/(authed)/layout.tsx',
  'lib/jobs/types.ts',
  'lib/hosting/deployCheck.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate.
      'tests/environmentConfig/storyIntegration.test.ts',
      // The per-card suites of MOTIR-9960 · 9961 · 9962 · 9964 · 9966.
      'tests/environmentConfig/reservedNamesAndCrypto.test.ts',
      'tests/environmentConfig/environmentConfigRepositories.test.ts',
      'tests/environmentConfig/environmentConfigService.test.ts',
      'tests/environmentConfig/resolveEnvironment.test.ts',
      'tests/api/environmentConfig/entries.test.ts',
      'tests/settings/environmentPage.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage/environment-config',
      all: true,
      include: MEASURED,
      // Per file, each MEASURED name its own key: a top-level floor would also
      // bind the two BRANCH_HELD files, which Vitest checks against both.
      thresholds: {
        perFile: true,
        ...Object.fromEntries(
          MEASURED.map((file) => [
            file,
            BRANCH_HELD.has(file) ? { ...FLOOR, branches: 50 } : FLOOR,
          ]),
        ),
      },
    },
  },
});
