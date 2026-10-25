import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for HOST — Story MOTIR-9364 (Host, a regular plan of 300,000 credits a
// month), its integration gate MOTIR-9406. The story added no motir-core production
// file; it grew two: the catalog (`lib/billing/catalog.ts` — Host's entry, its band
// and its admission to both allow-lists, MOTIR-9398) and the plan row
// (`BillingClient.tsx` — Host drawn and sold after Max ×2, MOTIR-9403). Those two are
// measured here, over the catalog's and the plan row's own suites plus the gate's
// pair (`tests/billing/hostPlanStoryGate.test.ts` on the real Postgres, and
// `tests/billing/hostPlanStoryGate.ui.test.tsx` — the Calculator and the plans view
// in every locale).
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET. CI: the `story-9364-coverage` job, which needs
// Postgres.

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/billing/planCatalog.test.ts',
      'tests/billing/largerPoolAgreement.test.ts',
      'tests/billing/planLadderStoryGate.test.tsx',
      'tests/components/BillingHostPlanCard.test.tsx',
      'tests/components/BillingPlanChange.test.tsx',
      'tests/components/CalculatorView.test.tsx',
      'tests/calculatorContract.test.ts',
      // The story's integration gate (MOTIR-9406).
      'tests/billing/hostPlanStoryGate.test.ts',
      'tests/billing/hostPlanStoryGate.ui.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [
        'lib/billing/catalog.ts',
        'app/*/settings/organization/billing/_components/BillingClient.tsx',
      ],
      // PER FILE, MEASURED 2026-10-23 at MOTIR-9406 over this lane's suites, rounded DOWN:
      // catalog.ts 100 / 93.54 / 100 / 100 (the arm left is `largerPoolPlans()`'s sort
      // fallback for an entry with no allotment, which the filter above it excludes), BillingClient.tsx 72.97 / 64.61 / 68 / 75.45 (the
      // whole billing panel, of which this lane drives the plan row and its dialogs).
      thresholds: {
        'lib/billing/catalog.ts': { statements: 100, branches: 93, functions: 100, lines: 100 },
        'app/*/settings/organization/billing/_components/BillingClient.tsx': {
          statements: 72,
          branches: 64,
          functions: 68,
          lines: 75,
        },
      },
    },
  },
});
