import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE PROVIDER-LIMIT LANE (Story MOTIR-9540 · Subtask MOTIR-9624) — `pnpm coverage:provider-limit`.
//
// The story's motir-core half is a provider-retry wait stored on the plan step and read on the
// overlay's poll (MOTIR-9619), and the overlay's banner and stopped wording drawn from it and
// from a `rate_limited` failure (MOTIR-9622), measured by the story gate
// (`tests/integration/plans/providerLimitStoryGate.test.ts` + `.host.test.tsx`) against Postgres
// and by the two cards' own suites.
//
// GATED is what the story CREATED, held whole-file to {@link FLOOR}: the one new module is the
// precedence helper. REPORTED is what it WIDENED — older files whose whole-file number would
// measure code this story never touched; they are in the report, and the story's own arms in
// them are read per function off `coverage/provider-limit/coverage-final.json`. Globs never spell
// a route group (`tests/coverage-gate-globs.test.ts`).

/** Each file below is held to {@link FLOOR}, whole-file. */
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

export const GATED = ['lib/planChange/providerLimitView.ts'];

export const REPORTED = [
  'lib/services/plansService.ts',
  'lib/services/aiGenerationService.ts',
  'lib/repositories/planStepRepository.ts',
  'lib/plans/planProgress.ts',
  'app/api/internal/ai/plan-step/route.ts',
  'lib/mappers/planMappers.ts',
  'components/planning/PlanChangeRail.tsx',
  'components/planning/SessionWaitingParts.tsx',
  'components/planning/PlanningWorkspaceHost.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/integration/plans/providerLimitStoryGate.test.ts',
      'tests/integration/plans/providerLimitStoryGate.host.test.tsx',
      'tests/planChange/providerLimitView.test.ts',
      'tests/components/plan-change-rail-provider-limit.test.tsx',
      'tests/components/planning-workspace-host-provider-limit.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage/provider-limit',
      all: false,
      include: [...GATED, ...REPORTED],
      thresholds: {
        perFile: true,
        ...Object.fromEntries(GATED.map((file) => [file, FLOOR])),
      },
    },
  },
});
