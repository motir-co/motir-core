import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for A HOST ORGANISATION'S OWN ACCOUNTS — Story MOTIR-9365, its
// integration gate MOTIR-9591. The files the story added, and the services it
// grew a Host branch in, measured over the feature cards' own suites plus the
// gate (`tests/ciFleet/hostOwnAccountsIntegration.test.ts`: reconcile → quota
// tracker → state pass → admission → caps → attribution → `fleet-admin`, on the
// real Postgres and the add-shard's fake AWS).
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET. CI: the `story-9365-coverage` job, which needs
// Postgres.

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/billing/hostOwnAccountCaps.test.ts',
      'tests/services/planCapsService.test.ts',
      'tests/ciFleet/fleetShardOrgOwned.test.ts',
      'tests/ciFleet/hostAccountReconcile.test.ts',
      'tests/ciFleet/fleetCapacityRequest.test.ts',
      'tests/ciFleet/fleetAttributionOrgOwned.test.ts',
      'tests/ciFleet/hostAccountState.test.ts',
      'tests/ciFleet/fleetShardAdmission.test.ts',
      'tests/ciFleet/fleetShardAdmissionHostOwn.test.ts',
      'tests/ciFleet/hostPlanCapsOwnAccount.test.ts',
      'tests/ciFleet/fleetAdminPoolCommands.test.ts',
      'tests/ciFleet/fleetAdminOrgAccounts.test.ts',
      'tests/ciFleet/hostMergedAccountSplit.test.ts',
      'tests/ciFleet/fleetShardAdmissionHostMerged.test.ts',
      'tests/ciFleet/hostLeaveOwnAccounts.test.ts',
      // The story's integration gate (MOTIR-9591).
      'tests/ciFleet/hostOwnAccountsIntegration.test.ts',
      // The tenant's door onto the capacity-request record and its DTO
      // (MOTIR-9662, `requestForOrganization` / `listForOrganization` /
      // `toOrgFleetCapacityRequestDTO`), which Story MOTIR-9368 added to two
      // files this lane floors.
      'tests/api/fleetCapacityRequestRoute.test.ts',
      'tests/billing/fleetUseService.test.ts',
      'tests/mappers/fleetCapacityRequestMappers.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: [
        'lib/billing/hostOwnAccountCaps.ts',
        'lib/ciFleet/hostAccounts.ts',
        'lib/ciFleet/hostAccountState.ts',
        'lib/ciFleet/hostMergedAccountSplit.ts',
        'lib/mappers/fleetCapacityRequestMappers.ts',
        'lib/repositories/fleetCapacityRequestRepository.ts',
        'lib/repositories/hostAccountAttemptRepository.ts',
        'lib/services/hostAccountReconcileService.ts',
        'lib/services/hostAccountStateService.ts',
        'lib/services/fleetCapacityRequestService.ts',
        'lib/services/fleetShardAdmissionService.ts',
        'lib/services/fleetPoolStatusService.ts',
        'lib/services/planCapsService.ts',
        'scripts/fleet/fleetAdminCapacityRequestCommands.ts',
        'scripts/fleet/fleetAdminPoolCommands.ts',
      ],
      // PER FILE, MEASURED 2026-10-26 at MOTIR-9591 over this lane's suites, rounded DOWN.
      // The new files are whole; the services that grew a Host branch are measured
      // whole too, their remaining arms being earlier stories' (the shared pool's
      // growth reads, the capacity request's unique-index race).
      thresholds: {
        'lib/billing/hostOwnAccountCaps.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/ciFleet/hostAccountState.ts': {
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
        'lib/ciFleet/hostMergedAccountSplit.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/mappers/fleetCapacityRequestMappers.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/repositories/fleetCapacityRequestRepository.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/repositories/hostAccountAttemptRepository.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/fleetCapacityRequestService.ts': {
          statements: 92,
          branches: 88,
          functions: 90,
          lines: 93,
        },
        'lib/services/fleetPoolStatusService.ts': {
          statements: 97,
          branches: 83,
          functions: 94,
          lines: 100,
        },
        'lib/services/fleetShardAdmissionService.ts': {
          statements: 96,
          branches: 96,
          functions: 100,
          lines: 98,
        },
        'lib/services/hostAccountReconcileService.ts': {
          statements: 92,
          branches: 85,
          functions: 90,
          lines: 96,
        },
        'lib/services/hostAccountStateService.ts': {
          statements: 93,
          branches: 83,
          functions: 94,
          lines: 96,
        },
        'lib/services/planCapsService.ts': {
          statements: 97,
          branches: 88,
          functions: 100,
          lines: 100,
        },
        'scripts/fleet/fleetAdminCapacityRequestCommands.ts': {
          statements: 93,
          branches: 78,
          functions: 88,
          lines: 96,
        },
        'scripts/fleet/fleetAdminPoolCommands.ts': {
          statements: 92,
          branches: 84,
          functions: 92,
          lines: 98,
        },
      },
    },
  },
});
