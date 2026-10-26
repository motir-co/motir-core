import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-7820's `motir-core` COVERAGE FLOOR (MOTIR-7832) — live plan
// progress: the step store, the two signal doors, the one progress derivation,
// the reader's plans-being-written read, the progress line and the Planning tab.
//
// Same shape and same reasoning as `vitest.coverage.in-flight-code.config.ts`:
// PER-FILE, measured on this branch before being pinned, scoped to the specs that
// actually reach these files, and the base config spread rather than replaced.
//
// ⚠️ THE GLOBS NEVER SPELL A ROUTE GROUP. `(authed)` is an extglob group to the
// coverage matcher (MOTIR-2449), so the Planning tab's components are written
// `app/*/workbench/_components/…` — `tests/coverage-gate-globs.test.ts`' rule.
//
// ⚠️ WHAT IS GATED AND WHAT IS ONLY REPORTED.
//   • GATED at the project floor (90 / 90 / 90 / 90) — the eleven files this
//     story WROTE: `planStepRepository.ts`, `planProgress.ts`,
//     `planProgressService.ts`, `workbenchPlanningService.ts`, the `plan-step` and
//     `workbench/planning` routes, `usePlanProgressReading.ts`,
//     `PlanProgressLine.tsx`, `PlanningList.tsx`, `PlanningRow.tsx` and
//     `planSentence.ts` — and three more the story wrote that the card's list
//     predates: `workbenchPlanningMappers.ts`, `planningOutcome.ts` and
//     `PlanningEmptyAction.tsx`.
//   • REPORTED, NOT GATED — the files it WIDENED: `plansService.ts`,
//     `planReviewService.ts`, `homeService.ts`, `lib/mcp/tools/authorPlan.ts`,
//     `aiGenerationService.ts`, `PlanningCanvas.tsx`, `PlanReviewCanvas.tsx`,
//     `PlanProposalViews.tsx`, `ProjectRoadmapCanvas.tsx` and `livePane.ts`
//     (`inFlightCues`, also missing from the card's list). A per-file number
//     over any of them measures its pre-existing code, which this lane does not
//     run. The story's OWN arms in them (`recordPlanStep` / `endPlanStep` /
//     `reportPlanStep` and the activity stamps; `runReportPlanStep`;
//     `recordPlanStepForJob`; the `planning` count; the `nodeCues` layer;
//     `inFlightCues`) are read PER FUNCTION off this lane's json report and named
//     in the MOTIR-7832 PR.
//   • `PlanningTab.tsx` is REPORTED too, and for a different reason: it is an
//     async SERVER component (it awaits the service and the translator), which no
//     spec in this lane renders — the tab's behaviour is reached through
//     `PlanningList` / `PlanningRow`, which it hands its page to. Gating it would
//     mean gating it at a lowered number, which this lane never does.
//
// It needs Postgres: the doors, the reads and the story gate all run against a
// real database, per the repository's own convention.

/** Each file below is held to {@link FLOOR}, whole-file. */
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

export const GATED = [
  'lib/repositories/planStepRepository.ts',
  'lib/plans/planProgress.ts',
  'lib/services/planProgressService.ts',
  'lib/services/workbenchPlanningService.ts',
  'app/api/internal/ai/plan-step/route.ts',
  'app/api/workbench/planning/route.ts',
  'lib/hooks/usePlanProgressReading.ts',
  'components/planning/PlanProgressLine.tsx',
  'app/*/workbench/_components/PlanningList.tsx',
  'app/*/workbench/_components/PlanningRow.tsx',
  'lib/planning/planSentence.ts',
  // WROTE too, and not on the card's list — found on the branch (MOTIR-7828 /
  // MOTIR-7831 added them after the card was written). Gated, not reported: a
  // file this story created has no older code for a per-file number to measure.
  'lib/mappers/workbenchPlanningMappers.ts',
  'app/*/workbench/_components/planningOutcome.ts',
  'app/*/workbench/_components/PlanningEmptyAction.tsx',
];

export const REPORTED = [
  'lib/services/plansService.ts',
  'lib/services/planReviewService.ts',
  'lib/services/homeService.ts',
  'lib/mcp/tools/authorPlan.ts',
  'lib/services/aiGenerationService.ts',
  'components/planning/PlanningCanvas.tsx',
  'components/planning/PlanReviewCanvas.tsx',
  'components/planning/PlanProposalViews.tsx',
  'components/planning/ProjectRoadmapCanvas.tsx',
  // WIDENED and not on the card's list — MOTIR-7830 added `inFlightCues` to it.
  'lib/planning/livePane.ts',
  'app/*/workbench/_components/PlanningTab.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate — both doors driven in-process, both reads compared.
      'tests/integration/plans/planProgressStoryGate.test.ts',
      // MOTIR-7822 — the step store.
      'tests/integration/plans/planSteps.test.ts',
      // MOTIR-7824 — the two doors.
      'tests/mcp/report-plan-step.test.ts',
      'tests/integration/ai/planStepRoute.test.ts',
      // MOTIR-7825 — the derivation and its server half.
      'tests/plans/planProgress.test.ts',
      'tests/integration/plans/planProgressService.test.ts',
      // MOTIR-7828 — the reader's read and the landing cascade it must not move.
      'tests/integration/workbench/planning-read.test.ts',
      'tests/workbench/landing.test.ts',
      // MOTIR-7829 — the progress line.
      'tests/components/plan-progress-line.test.tsx',
      'tests/components/plan-proposal-views.test.tsx',
      // MOTIR-7830 — the canvas cues.
      'tests/components/planning-canvas-cues.test.tsx',
      'tests/components/planning-canvas-motion.test.tsx',
      'tests/components/plan-review-canvas-cues.test.tsx',
      // MOTIR-7831 — the Planning tab.
      'tests/components/workbench-planning-tab.test.tsx',
      // MOTIR-7905 — the To resume entry mapper added to the same file.
      'tests/workbench/toResumePlanningSessionMapper.test.ts',
      // MOTIR-7832 — the island's poll arms the tab's own suite leaves unreached.
      'tests/components/workbench-planning-list-poll.test.tsx',
      // MOTIR-8066 — the narration story gate, so the floor on the widened
      // `plan-step` route keeps measuring its narration branch.
      'tests/integration/plans/planNarrationStoryGate.test.ts',
      // MOTIR-7988 — a plan a revision holds is listed under Planning, its row read
      // as one being written.
      'tests/integration/workbench/revision-hold-listing.test.ts',
      // MOTIR-8309 — the resuming state an automatic resume adds to the derivation, both
      // doors and the line.
      'tests/integration/plans/planProgressResuming.test.ts',
      'tests/components/planProgressLine.resuming.test.tsx',
      // MOTIR-8581 — the tab's rows read from the Workbench's one window read.
      'tests/components/workbench-planning-live.test.tsx',
      // The provider-limit story gate (MOTIR-9624): the plan-step route's `providerRetry` arm.
      'tests/integration/plans/providerLimitStoryGate.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage/plan-progress',
      all: false,
      include: [...GATED, ...REPORTED],
      // Read off THIS lane's own command on 2026-10-08 (stmts / branch / fn / lines):
      //
      //   GATED
      //   planStepRepository.ts          100 /   100 / 100 /   100
      //   planProgress.ts                100 / 91.17 / 100 /   100
      //   planProgressService.ts         100 /    96 / 100 /   100
      //   workbenchPlanningService.ts    100 /   100 / 100 /   100
      //   internal/ai/plan-step/route  94.73 / 94.44 / 100 / 94.44
      //   workbench/planning/route       100 /   100 / 100 /   100
      //   usePlanProgressReading.ts      100 / 96.66 / 100 /   100
      //   PlanProgressLine.tsx         98.33 / 98.48 / 100 / 98.07
      //   PlanningList.tsx             98.95 / 94.11 / 100 /   100
      //   PlanningRow.tsx                100 / 96.36 / 100 /   100
      //   planSentence.ts                100 /   100 / 100 /   100
      //   workbenchPlanningMappers.ts    100 /   100 / 100 /   100
      //   planningOutcome.ts             100 /   100 / 100 /   100
      //   PlanningEmptyAction.tsx        100 /   100 / 100 /   100
      //
      //   REPORTED (whole-file; the story's own arms are read per function)
      //   plansService.ts              45.49 / 38.46 / 52.39 / 48.85
      //   planReviewService.ts         50.49 / 46.33 / 52.00 / 53.93
      //   homeService.ts               19.44 / 16.66 / 20.83 / 21.60
      //   mcp/tools/authorPlan.ts      62.62 / 58.50 / 63.26 / 63.93
      //   aiGenerationService.ts       12.94 / 12.90 / 10.00 / 12.32
      //   PlanningCanvas.tsx           69.92 / 67.52 / 75.28 / 71.88
      //   PlanReviewCanvas.tsx         64.28 / 49.05 / 56.41 / 70.43
      //   PlanProposalViews.tsx        80.00 / 83.33 / 100   / 80.00
      //   ProjectRoadmapCanvas.tsx     56.41 / 49.32 / 55.26 / 58.52
      //   livePane.ts                  45.16 / 48.21 / 53.84 / 45.71
      //   PlanningTab.tsx                  0 /   100 /   0   /     0
      //
      // The arms the siblings' suites left unreached on gated files were reached by
      // tests THIS card added, not named away: the tab route's `NO_ACTIVE_PROJECT`
      // 400 and its page-less address, a legacy plan with no session, the empty
      // batched step read, and the hosted door's JSON `null` body and lost-project
      // refusal (`planProgressStoryGate.test.ts` § F); the island's 500 read,
      // still-generating outcome, re-held row, stale failure, hidden
      // `visibilitychange`, in-flight abort and title door, and
      // `planningOutcomeOf`'s `approved` arm (`workbench-planning-list-poll.test.tsx`).
      // `workbenchPlanningService`'s missing-snapshot drop is reached through ONE
      // collaborator spy, explained at that case: no interleaving reaches it today.
      //
      // ⚠️ THE NAMED RESIDUALS — every arm still unreached on a gated file, with the
      // invariant that makes it dead. All are pinned at the floor, never at the
      // reading, for the reason the approved-status lane gives.
      //   · plan-step route: the rethrow of a NON-job error out of
      //     `authenticateAndLimitJobRequest` (needs the rate-limit store itself to
      //     fail — the in-flight-code lane names the same arm), and the final
      //     `throw err` (an error no layer below types: a database outage).
      //   · planProgress.ts: `proposedFields ?? {}` and the non-string `kind` /
      //     `title` arms of `progressRowOfAdd` (an `add` is refused at the door
      //     without a string title and kind), and the comparator's EQUAL
      //     `sessionKey` arm (`(planId, sessionKey)` is the table's unique key, and
      //     a snapshot holds one plan's steps).
      //   · planProgressService.ts: `explanationsByProject.get(…) ?? false` (the
      //     projects are read by the same plans' own project ids, in one bound tx).
      //   · PlanningList.tsx: a failed outcome read finding an outcome ALREADY
      //     recorded (`requested` asks about a row once, ever). (MOTIR-8581 moved the
      //     read itself to the Workbench's one window read, so the poll's own
      //     `stopped` entry check went with it.)
      //   · PlanningRow.tsx: a whitespace-only frame part of the row sentence (no
      //     `approvalGate.planApproval.row` message, en or zh, has one).
      //
      // And three arms that ARE reachable and simply unmeasured — each file sits
      // above the floor without them, so no test was added for the number's sake:
      //   · usePlanProgressReading.ts: `opts.failing ?? false` with `failing`
      //     undefined (both callers pass `{ failing }`, and every suite sets it);
      //   · PlanProgressLine.tsx: `formatPlanDuration`'s hours form (no suite
      //     renders a plan more than an hour old);
      //   · PlanningRow.tsx: `targets[0]?.key ?? null` (a legacy plan, no targets).
      thresholds: {
        perFile: true,
        ...Object.fromEntries(GATED.map((file) => [file, FLOOR])),
      },
    },
  },
});
