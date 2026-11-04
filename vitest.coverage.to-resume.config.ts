import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE TO RESUME STORY'S COVERAGE FLOOR (Story MOTIR-7701 · MOTIR-7714) — every
// motir-core app file the story's children ADDED (MOTIR-7703 … MOTIR-7713), named
// below, each held to the per-file floor of 90% statements, functions, branches and
// lines. Measured over the story gate (`tests/integration/toResumeStoryGate.test.ts`:
// a gated close → To resume → an approval through each deciding door → one hosted
// continue on the fake fleet) plus the per-card suites. Mirrors
// `vitest.coverage.agent-instance-run.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// ⚠️ THE GLOBS NEVER SPELL A ROUTE GROUP OR A DYNAMIC SEGMENT. `(authed)` is an
// extglob group to the coverage matcher and `[key]` a character class (MOTIR-2449),
// so a single path segment is `*` here instead.

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/** Every file below is held to {@link FLOOR}, whole-file. */
export const MEASURED = [
  // MOTIR-7703 — the gated close names its gates.
  'lib/dispatchRuns/heldGates.ts',
  'lib/repositories/dispatchRunHeldGateRepository.ts',
  // MOTIR-7707 — the stored column, its derivation and its backfill.
  'lib/services/resumeStateService.ts',
  'lib/services/workItemResumeStateBackfillService.ts',
  // MOTIR-10308 — moving again, measured against the gated run's snapshot.
  'lib/workItems/resumeCi.ts',
  // MOTIR-7710 — the hosted auto-resume: the ask, the job and its record.
  'lib/services/gateResumeRequest.ts',
  'lib/services/gateResumeService.ts',
  'lib/repositories/gateResumeRepository.ts',
  'lib/jobs/definitions/gateResume.ts',
  // MOTIR-7712 — the To resume tab's entry.
  'lib/services/resumeRunDetailService.ts',
  'lib/services/resumeScopeService.ts',
  'app/*/workbench/_components/WorkbenchResumeLine.tsx',
  // MOTIR-7713 — the run section's marker.
  'app/*/items/*/_components/GatedRunMarker.tsx',
];

/**
 * SHARED files the story also changed, NAMED and deliberately NOT floored here: large,
 * older files where the story's change is a few lines (a `gated` arm, a fifth tab, a
 * prop threaded through), whose uncovered remainder is other stories' code measured by
 * their own suites in the main `test` job. A whole-file floor here would measure those
 * stories, not this one. The story's own lines in them are reached by the suites below
 * (the PR body carries the changed-line read when the lane landed).
 */
export const SHARED_NOT_FLOORED = [
  'app/*/items/*/_components/LateSections.tsx',
  'app/*/items/*/_components/RunSection.tsx',
  'app/*/items/*/_components/lateReads.ts',
  'app/*/workbench/_components/WorkbenchFixLine.tsx',
  'app/*/workbench/_components/WorkbenchList.tsx',
  'app/*/workbench/_components/WorkbenchTabs.tsx',
  'app/*/workbench/_components/workbenchRows.ts',
  'app/*/workbench/page.tsx',
  'components/hosted/ContinueHostedControl.tsx',
  'components/hosted/hostedModels.ts',
  'lib/services/approvalGatesService.ts',
  'lib/services/designEvidenceService.ts',
  'lib/services/dispatchPromptService.ts',
  'lib/services/dispatchRunService.ts',
  'lib/services/homeService.ts',
  'lib/services/workItemContinueService.ts',
  'lib/services/workItemsService.ts',
  'lib/services/workbenchWatermarkService.ts',
  'lib/repositories/approvalGateRepository.ts',
  'lib/repositories/dispatchRunRepository.ts',
  'lib/repositories/workItemRepository.ts',
  'lib/mappers/homeMappers.ts',
  'lib/mcp/tools/workItemContinue.ts',
  'lib/mcp/tools/workItemRun.ts',
  'lib/workbench/landing.ts',
  'lib/workbench/tab.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/integration/toResumeStoryGate.test.ts',
      'tests/dispatchRuns/gateResume.test.ts',
      'tests/dispatchRuns/heldGates.test.ts',
      'tests/workbench/resumeState.test.ts',
      'tests/workItems/resumeCi.test.ts',
      'tests/ready/claimContinueResume.test.ts',
      'tests/components/workbench-to-resume.test.tsx',
      'tests/components/workbench-to-resume-reshaped.test.tsx',
      'tests/integration/home/toResumeReshaped.test.ts',
      'tests/workbench/resumeReshapePlans.test.ts',
      'tests/components/run-section-gated.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json'],
      reportsDirectory: 'coverage/to-resume',
      all: true,
      include: MEASURED,
      thresholds: {
        perFile: true,
        ...FLOOR,
      },
    },
  },
});
