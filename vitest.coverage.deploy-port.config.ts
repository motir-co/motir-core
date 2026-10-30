import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE DEPLOY-INTERFACE STORY'S COVERAGE FLOOR (Story MOTIR-9791 · MOTIR-9806) —
// every motir-core app file the story added (MOTIR-9803, MOTIR-9808, MOTIR-5773,
// MOTIR-9805), NAMED below in one of two lists, and every file in the first held
// to the per-file floor of 90% statements, functions, branches and lines.
// Measured over the story gate (`tests/hosting/manifestToDeploy.test.ts`, the
// parse-then-deploy seam) plus the per-card suites. Mirrors
// `vitest.coverage.agent-instance-run.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// Held elsewhere, deliberately:
//   * the port itself, its fake and its Fly adapter (`packages/orchestrator/src/
//     hosting/**`, `adapters/{fake,fly}/hosting.ts`) by `packages/orchestrator`'s
//     own per-file 90 floor, run by the `orchestrator` job — the contract suite
//     (`packages/orchestrator/test/deployPortContract.test.ts`) is in that
//     report, so they are not floored twice;
//   * `scripts/hosting-deploy-check.ts` is argv and console around
//     `runDeployCheck`, which IS floored here;
//   * `prisma/**` and the fixtures carry no code to measure.

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/** Every file below is held to {@link FLOOR}, whole-file. */
const MEASURED = [
  // MOTIR-9803 — the hosting manifest contract.
  'lib/hosting/manifest.ts',
  'lib/hosting/errors.ts',
  // MOTIR-9808 — the hosting vocabulary the repo row stores.
  'lib/hosting/vocabulary.ts',
  // MOTIR-5773 — the hosting port's composition root, and the selector it reads.
  'lib/orchestrator/hosting.ts',
  'lib/orchestrator/provider.ts',
  // MOTIR-9805 — the operator deploy check.
  'lib/hosting/deployCheck.ts',
  // MOTIR-9947 — the guard image's server. Its process entry (`main.ts`) runs
  // only in a child process the guard suite spawns, out of v8's reach here.
  'packages/hosting-guard/src/guard.ts',
  // Story MOTIR-9797 (production deploy of main) — MOTIR-10038's coverage floor:
  // every app file the story added that carries code. Measured by the story
  // suite (`tests/hosting/productionDeployStory.test.ts`) plus each card's own.
  'lib/github/repoActionsConfig.ts',
  'lib/github/repoDeployments.ts',
  'lib/hosting/applicationAddress.ts',
  'lib/hosting/deployEligibility.ts',
  'lib/hosting/productionArtifact.ts',
  'lib/hosting/productionDatabase.ts',
  'lib/hosting/productionEnablementNames.ts',
  'lib/hosting/productionPanelErrors.ts',
  'lib/hosting/releaseCursor.ts',
  'lib/hosting/releaseDeploymentStatus.ts',
  'lib/hosting/releaseEnvironment.ts',
  'lib/hosting/releaseUsage.ts',
  'lib/jobs/definitions/productionConfigRedeploy.ts',
  'lib/jobs/definitions/productionMergeRelease.ts',
  'lib/jobs/definitions/releaseDeploymentStatus.ts',
  'lib/mappers/hostedApplicationMappers.ts',
  'lib/repositories/hostedApplicationRepository.ts',
  'lib/repositories/hostedReleaseRepository.ts',
  'lib/services/hostedApplicationService.ts',
  'lib/services/hostedReleaseUsageService.ts',
  'lib/services/hostedRepositoryAccessService.ts',
  'lib/services/productionConfigRedeployService.ts',
  'lib/services/productionDatabaseService.ts',
  'lib/services/productionEnablementService.ts',
  'lib/services/productionMergeReleaseService.ts',
  'lib/services/productionPanelService.ts',
  'lib/services/productionReleaseService.ts',
  'lib/services/productionRollbackService.ts',
  'lib/services/releaseDeploymentStatusService.ts',
  'app/api/projects/\\[key\\]/repositories/\\[rowId\\]/production/route.ts',
  'app/api/projects/\\[key\\]/repositories/\\[rowId\\]/production/rollback/route.ts',
];

/**
 * SHARED files the story also changed, NAMED and deliberately NOT floored here.
 * Each is a large, older file where the story's change is a few lines (three
 * columns threaded through the repo row's DTO, mapper and repository, one service
 * method and two typed errors, and the orchestrator barrel's re-export), and whose
 * remainder is OTHER stories' code measured by their own suites in the main
 * `test` job. The story's own lines in them are reached by
 * `tests/projectRepos/projectRepoHosting.test.ts`, which this lane runs.
 */
export const SHARED_NOT_FLOORED = [
  'lib/orchestrator/index.ts',
  'lib/dto/projectRepos.ts',
  'lib/mappers/projectRepoMappers.ts',
  'lib/projectRepos/errors.ts',
  'lib/repositories/projectRepoRepository.ts',
  'lib/services/projectRepoSetService.ts',
  // Story MOTIR-9797 — the shared files it changed by a few lines each (the
  // webhook's two new handlers, the job registry and event map, the repo row's
  // deploy facts, the workspace slug read, the deployment store's environment),
  // reached by the story suite and measured with their own stories' suites.
  'lib/git/provider.ts',
  'lib/git/providers/github.ts',
  'lib/git/types.ts',
  'lib/jobs/registry.ts',
  'lib/jobs/services.ts',
  'lib/jobs/types.ts',
  'lib/publicAddresses/reservedNames.ts',
  'lib/repositories/repoDeploymentRepository.ts',
  'lib/repositories/workspaceRepository.ts',
  'lib/services/githubWebhookService.ts',
  'lib/services/projectRepoProvisioningService.ts',
  'lib/services/repoDeploymentService.ts',
  // Types only — nothing executes, so nothing to floor.
  'lib/dto/hostedApplications.ts',
  'lib/dto/productionPanel.ts',
  // Argv and console around `productionEnablementService`, which IS floored.
  'scripts/backfill-production-enablement.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate and the per-card suites of MOTIR-9803 · 9808 · 5773 · 9805.
      'tests/hosting/manifestToDeploy.test.ts',
      'tests/hosting/manifest.test.ts',
      'tests/hosting/hostingDeployPort.test.ts',
      'tests/hosting/deployCheck.test.ts',
      'tests/hosting/serverlessDeployCheck.test.ts',
      // MOTIR-10011 — the deploy check on the AWS target.
      'tests/hosting/deployCheckAws.test.ts',
      'tests/hosting/hostingGuard.test.ts',
      'tests/hosting/deployPortCoverageLane.test.ts',
      'tests/projectRepos/projectRepoHosting.test.ts',
      // MOTIR-10026 — the release vocabulary and the hosting errors it adds to
      // the two floored files above are reached by these suites.
      'tests/hosting/hostedVocabulary.test.ts',
      'tests/hosting/hostedApplicationService.test.ts',
      // MOTIR-10027 — production enablement's error, beside them in errors.ts.
      'tests/hosting/productionEnablement.test.ts',
      // MOTIR-10028 — the production database's three errors.
      'tests/hosting/productionDatabaseService.test.ts',
      // MOTIR-10030 — the release service's four errors and the extracted
      // repository access it reads the manifest through.
      'tests/hosting/productionReleaseService.test.ts',
      'tests/hosting/hostedRepositoryAccessService.test.ts',
      // MOTIR-10033 — the release status post's error.
      'tests/hosting/releaseDeploymentStatus.test.ts',
      // MOTIR-10035 — rollback's three errors.
      'tests/hosting/productionRollbackService.test.ts',
      // Story MOTIR-9797 — the story suite (MOTIR-10038) and every card suite
      // that measures one of its floored files.
      'tests/hosting/productionDeployStory.test.ts',
      'tests/hosting/productionMergeRelease.test.ts',
      'tests/hosting/productionConfigRedeploy.test.ts',
      'tests/hosting/hostedReleaseUsageService.test.ts',
      'tests/hosting/releaseDeploymentStatusVocabulary.test.ts',
      'tests/hosting/releaseEnvironment.test.ts',
      'tests/hosting/productionDatabaseBoundary.test.ts',
      'tests/hosting/productionRollbackBoundary.test.ts',
      'tests/hosting/productionPanelService.test.ts',
      'tests/api/productionPanelRoutes.test.ts',
      'tests/git/parseProductionImageRunEvent.test.ts',
      'tests/publicAddresses/reservedNames.test.ts',
      'tests/rls/hostedApplicationRls.test.ts',
      'tests/github/repoActionsConfig.test.ts',
      'tests/github/repoDeployments.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage/deploy-port',
      all: true,
      include: MEASURED,
      thresholds: {
        perFile: true,
        ...FLOOR,
      },
    },
  },
});
