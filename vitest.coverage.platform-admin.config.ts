import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for the OPERATOR CONSOLE — motir-core's half of Story MOTIR-727 (10.1),
// its integration gate MOTIR-7296: the audited platform reads, the spend
// vocabulary, the console's client-side tables and the fleet meter reporter.
//
// ⚠️ MEASURED: the files the story's code cards ADDED, plus the two shared
// repositories they extended most. NOT measured: the server PAGES (rendered by the
// E2E walk, MOTIR-735, not by a unit suite) and the shared files changed by a few
// lines each (`motirAiClient.ts`, `billingService.ts`, `ciFleetCostMeterService.ts`,
// the job registry), which already sit under their own lanes and suites.
//
// ⚠️ AND STORY MOTIR-6905's ADDED FILES (its integration gate, MOTIR-7321): the
// fleet monitor read, the debit-mismatch alert job and the admin fleet stop,
// with the Fleet section and the tenant page's Stop containers. The same
// exclusions hold: the server pages and the shared files the story extended by a
// few lines (the CI repositories, the lifecycle and allowance services, the
// tenant `actions.ts` that predates the stop) are not measured here — their
// story lines were measured at the gate, every one ≥ 90 %.
//
// The floors are the MEASURED reading over the lane's suites, rounded DOWN, PER FILE,
// and they are a RATCHET. CI: the `story-727-coverage` job, which needs Postgres.

const MEASURED = [
  'lib/services/platformReadService.ts',
  'lib/services/platformUsageService.ts',
  'lib/services/platformOrgPageService.ts',
  'lib/services/platformOrgBillingService.ts',
  'lib/services/platformMeterReportService.ts',
  'lib/services/platformMeterReportEnqueue.ts',
  'lib/platform/spend.ts',
  'lib/platform/orgBill.ts',
  'lib/repositories/platformEstateRepository.ts',
  'lib/jobs/definitions/platformMeterReport.ts',
  'app/*/admin/_components/spendFormat.ts',
  'app/*/admin/tenants/[[]orgId]/_components/orgNav.ts',
  'app/*/admin/tenants/[[]orgId]/_components/CategoryModelSheet.tsx',
  'app/*/admin/tenants/[[]orgId]/_components/SpendChildrenTable.tsx',
  'app/*/admin/tenants/[[]orgId]/_components/PaymentInvoicesCard.tsx',
  // Story MOTIR-6905 (MOTIR-7321).
  'lib/services/platformFleetMonitorService.ts',
  'lib/services/platformFleetStopService.ts',
  'lib/services/fleetDebitMonitorService.ts',
  'lib/jobs/definitions/fleetDebitMonitor.ts',
  'lib/monitoring/fleetDebitMismatchAlert.ts',
  'lib/ciFleet/debitMismatchErrors.ts',
  'lib/mappers/platformFleetStopMappers.ts',
  'lib/dto/platformFleetMonitor.ts',
  'app/*/admin/monitoring/_components/FleetSection.tsx',
  'app/*/admin/monitoring/_components/FleetVerdictChip.tsx',
  'app/*/admin/tenants/[[]orgId]/_components/OrgFleetCard.tsx',
  'app/*/admin/tenants/[[]orgId]/_components/StopContainersDialog.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/platform/platformReadService.test.ts',
      'tests/platform/platformOverview.test.ts',
      'tests/platform/platformEstateUsage.test.ts',
      'tests/platform/spend.test.ts',
      'tests/platform/platformTenantList.test.ts',
      'tests/platform/platformOrgOverview.test.ts',
      'tests/platform/orgNav.test.ts',
      'tests/platform/categoryModelSheet.test.tsx',
      'tests/platform/spendChildrenTable.test.tsx',
      'tests/platform/orgBill.test.ts',
      'tests/platform/platformOrgBilling.test.ts',
      'tests/platform/paymentInvoicesCard.test.tsx',
      'tests/platform/consoleGate.test.ts',
      'tests/platform/motirAiSeams.test.ts',
      'tests/ciFleet/platformMeterReport.test.ts',
      // Story 10.3 extended two measured files: `platformEstateRepository` gained
      // MOTIR-749's `listWorkspaceMembershipsForUser` (exercised by the View-as
      // suite) and MOTIR-752's `countOrganizationWorkspaces`, and
      // `platformOrgPageService` gained `getOperations` (the Operations tab read).
      'tests/platform/impersonation.test.ts',
      'tests/platform/platformOrgOperations.test.ts',
      // Story MOTIR-6905 — its units and its integration gate (MOTIR-7321).
      'tests/platform/platformFleetMonitorService.test.ts',
      'tests/platform/platformFleetStopService.test.ts',
      'tests/ciFleet/fleetDebitMonitor.test.ts',
      'tests/platform/fleetSection.test.tsx',
      'tests/platform/monitoringPageFleet.test.tsx',
      'tests/platform/fleetStopAction.test.ts',
      'tests/components/org-fleet-card.test.tsx',
      'tests/components/stop-containers-dialog.test.tsx',
      'tests/ciFleet/fleetMonitorStoryGate.test.ts',
      'tests/ciFleet/fleetAdminStopStoryGate.test.ts',
      'tests/platform/fleetConsoleGate.test.ts',
      // The Costs page's audited read (MOTIR-11712) extended platformReadService.
      'tests/platform/platformCosts.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // PER FILE, MEASURED 2026-10-02 at MOTIR-7296 over this lane's suites, rounded DOWN.
      thresholds: {
        'app/*/admin/_components/spendFormat.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/CategoryModelSheet.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/PaymentInvoicesCard.tsx': {
          statements: 100,
          branches: 80,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/SpendChildrenTable.tsx': {
          statements: 100,
          branches: 77,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/orgNav.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/jobs/definitions/platformMeterReport.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/platform/orgBill.ts': { statements: 96, branches: 80, functions: 100, lines: 96 },
        'lib/platform/spend.ts': { statements: 97, branches: 100, functions: 85, lines: 96 },
        'lib/repositories/platformEstateRepository.ts': {
          statements: 100,
          branches: 87,
          functions: 100,
          lines: 100,
        },
        // The enqueue doors left for platformMeterReportEnqueue.ts (the fleet-cost
        // read graph must not reach the job registry): the same one uncovered line
        // over fewer lines is 97.95%, so the line floor is 97.
        'lib/services/platformMeterReportService.ts': {
          statements: 98,
          branches: 93,
          functions: 100,
          lines: 97,
        },
        'lib/services/platformMeterReportEnqueue.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformOrgBillingService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformOrgPageService.ts': {
          statements: 97,
          branches: 91,
          functions: 97,
          lines: 98,
        },
        'lib/services/platformReadService.ts': {
          statements: 100,
          branches: 96,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformUsageService.ts': {
          statements: 100,
          branches: 88,
          functions: 100,
          lines: 100,
        },
        // Story MOTIR-6905, MEASURED 2026-10-02 at MOTIR-7321 over this lane's suites.
        'app/*/admin/monitoring/_components/FleetSection.tsx': {
          statements: 97,
          branches: 92,
          functions: 100,
          lines: 98,
        },
        'app/*/admin/monitoring/_components/FleetVerdictChip.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/OrgFleetCard.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'app/*/admin/tenants/[[]orgId]/_components/StopContainersDialog.tsx': {
          statements: 97,
          branches: 95,
          functions: 100,
          lines: 100,
        },
        'lib/ciFleet/debitMismatchErrors.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/dto/platformFleetMonitor.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/jobs/definitions/fleetDebitMonitor.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/mappers/platformFleetStopMappers.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/monitoring/fleetDebitMismatchAlert.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/fleetDebitMonitorService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformFleetMonitorService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/platformFleetStopService.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
