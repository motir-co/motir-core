import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE FLEET USE STORY'S COVERAGE FLOOR (Story MOTIR-9368 · MOTIR-9664) — every
// motir-core file the story's code cards ADDED (MOTIR-9659 … MOTIR-9663), each held
// to the per-file floor of 90% statements, functions, branches and lines that every
// story lane uses. Measured over the story gate
// (`tests/integration/fleetUse/fleetUseStoryGate.test.ts`: real admission, the real
// routes, against Postgres) plus each card's own suite. Mirrors
// `vitest.coverage.live-push.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// ⚠️ THE GLOBS NEVER SPELL A ROUTE GROUP OR A DYNAMIC SEGMENT (MOTIR-2449).

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/** Every file below is held to {@link FLOOR}, whole-file. Type-only DTO files
 *  (`lib/dto/fleetUse.ts`, `lib/dto/orgPlanFigures.ts`) emit no code and are left out. */
export const MEASURED = [
  // MOTIR-9659 — the one plan-figures read.
  'lib/services/orgPlanFiguresService.ts',
  // MOTIR-9660 — the per-org use counts.
  'lib/services/fleetUseCountsService.ts',
  // MOTIR-9661 — the Fleet use read, its pure helpers, its mapper and its route.
  'lib/services/fleetUseService.ts',
  'lib/billing/fleetUse.ts',
  'lib/mappers/fleetUseMappers.ts',
  'app/api/organizations/**/billing/fleet-use/route.ts',
  // MOTIR-9662 — the Request more capacity route and its error map.
  'lib/ciFleet/capacityRequestErrorResponse.ts',
  'app/api/organizations/**/billing/fleet-use/capacity-requests/route.ts',
  // MOTIR-9663 — the section, its dialog and its words.
  'app/**/billing/_components/FleetUse*.tsx',
  'app/**/billing/_components/fleetUseFormat.ts',
];

/**
 * SHARED files the story changed by one method or one call, NAMED and
 * deliberately NOT floored here: their remainder is other stories' code, measured
 * by their own suites, so a whole-file floor here would measure those stories.
 */
export const SHARED_NOT_FLOORED = [
  // Gained `toOrgFleetCapacityRequestDTO`; floored at 100% by
  // `vitest.coverage.host-own-accounts.config.ts` (MOTIR-9365).
  'lib/mappers/fleetCapacityRequestMappers.ts',
  // Gained the view gate the read calls (`assertCanViewBilling`).
  'lib/services/billingService.ts',
  // Its private plan read moved out to `orgPlanFiguresService` (MOTIR-9659).
  'lib/services/platformFleetMonitorService.ts',
  // Record the waiting reason on each deferral (MOTIR-9666).
  'lib/services/ciRunnerAdmissionService.ts',
  'lib/services/hostedRunService.ts',
  // One grouped count each, read by the use counts (MOTIR-9660).
  'lib/repositories/ciRunnerProvisioningIntentRepository.ts',
  'lib/repositories/dispatchRunRepository.ts',
  'lib/repositories/agentInstanceRepository.ts',
  // `requestForOrganization`, the tenant door (MOTIR-9662).
  'lib/services/fleetCapacityRequestService.ts',
  // Mounts the section and exports `Meter` (MOTIR-9663).
  'app/(authed)/settings/organization/billing/_components/BillingClient.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/integration/fleetUse/fleetUseStoryGate.test.ts',
      'tests/billing/orgPlanFiguresService.test.ts',
      'tests/fleetUse/fleetUseCounts.test.ts',
      'tests/billing/fleetUseService.test.ts',
      'tests/billing/fleetUseHelpers.test.ts',
      'tests/api/fleetUseRoute.test.ts',
      'tests/api/fleetCapacityRequestRoute.test.ts',
      'tests/ciFleet/capacityRequestErrorResponse.test.ts',
      'tests/components/FleetUseSection.test.tsx',
      'tests/billing/fleetUseFormat.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json'],
      reportsDirectory: 'coverage/fleet-use',
      all: true,
      include: MEASURED,
      thresholds: {
        perFile: true,
        ...FLOOR,
      },
    },
  },
});
