import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for PLAN SOMETHING NEW — Story MOTIR-7631's integration gate, MOTIR-7652
// (`docs/decisions/conversation-turn-intent.md` AMENDMENT 3): the restart's own
// constants and the door the story added. (Its second door, the control's
// `restart/confirm`, was retired by MOTIR-11261: the control asks in a dialog,
// `PlanRestartDialog`, which this lane measures with the files it added.)
//
// ⚠️ MEASURED: the files the story ADDED. NOT measured: the large shared files it
// extended by a branch each (`planChangeSessionsService`, `aiAskService`, the
// conversation hook, the rail), which sit under their own suites — the story's
// lines in them are exercised by the suites below.
//
// The floors are the MEASURED reading over the lane's suites, rounded DOWN, PER FILE,
// and they are a RATCHET. CI: the `story-7631-coverage` job, which needs Postgres.

const MEASURED = [
  'lib/planChange/restart.ts',
  'app/api/ai/plan-change/session/restart/route.ts',
  'components/planning/PlanRestartDialog.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/planning/planSessionRestart.test.ts',
      'tests/integration/planning/planSomethingNewGate.test.ts',
      'tests/components/use-plan-change-restart.test.tsx',
      'tests/components/plan-change-rail-restart.test.tsx',
      'tests/components/plan-restart-dialog.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // MEASURED 2026-10-06 at MOTIR-7652 over this lane's suites, rounded DOWN. The
      // story's floor is 90% over its files together; the per-file rows ratchet each.
      // Uncovered on purpose: each door's final `throw err` for an error the
      // plan-change mapper does not know, which no real request reaches.
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 100,
        lines: 94,
        'lib/planChange/restart.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // MEASURED 2026-11-14 at MOTIR-11261.
        'components/planning/PlanRestartDialog.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/api/ai/plan-change/session/restart/route.ts': {
          statements: 95,
          branches: 91,
          functions: 100,
          lines: 94,
        },
      },
    },
  },
});
