import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for THE LARGER POOLS ABOVE HOST — Story MOTIR-9366, its integration
// gate MOTIR-9656. The files the story changed in motir-core, measured over the
// feature cards' own suites plus the gate's two halves: the catalog agreement
// (`tests/billing/largerPoolHostAnchorStoryGate.test.ts`) and the seams for a 600k
// and a 2,400k org (`tests/ciFleet/rungOwnAccountsIntegration.test.ts`, on the real
// Postgres and the add-shard's fake AWS).
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET. The two pure modules the story grew hold the
// card's 90% floor at least. CI: the `story-9366-coverage` job, which needs Postgres.

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/billing/planCatalog.test.ts',
      'tests/billing/largerPoolAgreement.test.ts',
      'tests/billing/ownAccountPlans.test.ts',
      'tests/billing/planCaps.test.ts',
      'tests/billing/hostOwnAccountCaps.test.ts',
      'tests/billing/hostPlanStoryGate.test.ts',
      'tests/billingService.test.ts',
      'tests/services/planCapsService.test.ts',
      'tests/ciFleet/hostAccountReconcile.test.ts',
      'tests/ciFleet/hostAccountState.test.ts',
      'tests/ciFleet/fleetShardAdmission.test.ts',
      'tests/ciFleet/fleetShardAdmissionHostOwn.test.ts',
      'tests/ciFleet/fleetShardAdmissionHostMerged.test.ts',
      'tests/ciFleet/fleetShardProvisioning.test.ts',
      'tests/ciFleet/fleetShardProvisioningAws.test.ts',
      'tests/ciFleet/rungOwnAccounts.test.ts',
      // The spare path the provisioning service also carries — its growth and
      // `fleet-admin add-spare` callers (MOTIR-10065) — so the per-file floor
      // below measures that service's code rather than only the org-owned walk.
      'tests/ciFleet/addSpareShard.test.ts',
      // The story's integration gate (MOTIR-9656).
      'tests/billing/largerPoolHostAnchorStoryGate.test.ts',
      'tests/ciFleet/rungOwnAccountsIntegration.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [
        'lib/billing/catalog.ts',
        'lib/billing/hostOwnAccountCaps.ts',
        'lib/billing/ownAccountPlans.ts',
        'lib/billing/planCaps.ts',
        'lib/ciFleet/hostAccounts.ts',
        'lib/services/billingService.ts',
        'lib/services/fleetShardAdmissionService.ts',
        'lib/services/fleetShardProvisioningService.ts',
        'lib/services/hostAccountReconcileService.ts',
        'lib/services/planCapsService.ts',
      ],
      // PER FILE, MEASURED 2026-10-26 at MOTIR-9656 over this lane's suites, rounded DOWN.
      // The pure modules (`ownAccountPlans.ts`, `planCaps.ts`) are whole, above the
      // card's 90% floor; catalog.ts misses only the sort's unreachable `?? 0`. The
      // services are measured whole, their remaining arms being earlier stories'
      // (Checkout's portal and seat paths, the add-shard's GitHub and network steps).
      thresholds: {
        'lib/billing/catalog.ts': {
          statements: 100,
          branches: 93,
          functions: 100,
          lines: 100,
        },
        'lib/billing/hostOwnAccountCaps.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/billing/ownAccountPlans.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/billing/planCaps.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/ciFleet/hostAccounts.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/billingService.ts': {
          statements: 76,
          branches: 65,
          functions: 81,
          lines: 77,
        },
        'lib/services/fleetShardAdmissionService.ts': {
          statements: 95,
          branches: 93,
          functions: 100,
          lines: 97,
        },
        'lib/services/fleetShardProvisioningService.ts': {
          statements: 83,
          branches: 73,
          functions: 81,
          lines: 85,
        },
        'lib/services/hostAccountReconcileService.ts': {
          statements: 92,
          branches: 86,
          functions: 90,
          lines: 96,
        },
        'lib/services/planCapsService.ts': {
          statements: 92,
          branches: 80,
          functions: 100,
          lines: 93,
        },
      },
    },
  },
});
