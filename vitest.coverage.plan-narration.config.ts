import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-8060's `motir-core` COVERAGE FLOOR (MOTIR-8066) — the planner's
// narration: the store, the two widened doors, the chat-panel read and its paged
// route, and the panel that draws it.
//
// Same shape and same reasoning as `vitest.coverage.plan-progress.config.ts`:
// PER-FILE, measured on this branch before being pinned, scoped to the specs that
// actually reach these files, and the base config spread rather than replaced.
//
// ⚠️ THE GLOBS NEVER SPELL A DYNAMIC SEGMENT. `[id]` is a character class to the
// coverage matcher (MOTIR-2449), so the paged route is written
// `app/api/plans/*/narration/route.ts` — `tests/coverage-gate-globs.test.ts`' rule.
//
// ⚠️ WHAT IS GATED AND WHAT IS ONLY REPORTED.
//   • GATED at the project floor (90 / 90 / 90 / 90) — the five files this story
//     WROTE (`planNarration.ts`, `planNarrationRepository.ts`, the paged route,
//     `components/planning/planNarration.ts`, `PlanNarration.tsx`), and the
//     hosted `plan-step` route it WIDENED, which the plan-progress lane already
//     holds to 90 whole-file.
//   • REPORTED, NOT GATED — the files it WIDENED, whose per-file number measures
//     pre-existing code this lane does not run. The story's OWN arms in them are
//     read PER FUNCTION off this lane's json report and named in the MOTIR-8066
//     commit: `recordPlanNarration`, `recordPlanStep`'s step-words upsert and
//     title resolution, `reportPlanStep`'s one-of branch, `runReportPlanStep`'s
//     narration path, `recordPlanStepForJob`'s narration path,
//     `toPlanNarrationDto`, `toPlanNarrationSessionDto`, `getPlanReview`'s
//     narration read, `listPlanNarration` and `fetchPlanNarrationPage`.
//     `usePlanChangeConversation.ts` is not on the card's list and is here for the
//     same reason as the others: MOTIR-8064 widened it with the narration state.
//
// It needs Postgres: the doors, the reads and the story gate all run against a
// real database, per the repository's own convention.

/** Each file below is held to {@link FLOOR}, whole-file. */
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

export const GATED = [
  'lib/plans/planNarration.ts',
  'lib/repositories/planNarrationRepository.ts',
  'app/api/plans/*/narration/route.ts',
  'components/planning/planNarration.ts',
  'components/planning/PlanNarration.tsx',
  'app/api/internal/ai/plan-step/route.ts',
];

export const REPORTED = [
  'lib/services/plansService.ts',
  'lib/mcp/tools/authorPlan.ts',
  'lib/mappers/planMappers.ts',
  'lib/services/planReviewService.ts',
  'lib/services/aiGenerationService.ts',
  'lib/planning/planReviewClient.ts',
  'components/planning/PlanActRecord.tsx',
  'components/planning/planCallLines.ts',
  'lib/hooks/usePlanChangeConversation.ts',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate — both doors driven in-process, every read compared.
      'tests/integration/plans/planNarrationStoryGate.test.ts',
      // MOTIR-11199 — the route's `itemDraft` form (Story MOTIR-11190): its 400 /
      // 404 / 409 / 422 refusals and the applied / stale answers.
      'tests/integration/ai/planStepDraft.test.ts',
      // MOTIR-8062 — the store and the two doors.
      'tests/plans/planNarration.test.ts',
      'tests/integration/plans/planNarration.test.ts',
      'tests/integration/ai/planStepRoute.test.ts',
      'tests/mcp/report-plan-step.test.ts',
      // MOTIR-8063 — the review read and the paged route.
      'tests/integration/plans/planNarrationRead.test.ts',
      'tests/api/plans/planNarrationRoute.test.ts',
      // MOTIR-8064 — the panel.
      'tests/components/plan-narration.test.tsx',
      'tests/components/plan-narration-hook.test.tsx',
      // MOTIR-11266 — the skip-the-final-check control and its live head, which
      // MOTIR-11262 added to `PlanNarration.tsx`.
      'tests/components/plan-narration-skip-check.test.tsx',
      'tests/planning/planNarrationGroups.test.ts',
      // MOTIR-11184 — `findLatestBySessionForPlans`, the quiet drop's author
      // signal, is called directly (and with no plans) by the progress service's
      // own suite.
      'tests/integration/plans/planProgressService.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      reportsDirectory: 'coverage/plan-narration',
      all: false,
      include: [...GATED, ...REPORTED],
      // Read off THIS lane's own command on 2026-10-09 (stmts / branch / fn / lines):
      //
      //   GATED
      //   lib/plans/planNarration.ts         100 /   100 /   100 /   100
      //   planNarrationRepository.ts         100 /   100 /   100 /   100
      //   plans/[id]/narration/route       96.55 / 91.67 /   100 / 96.30
      //   planning/planNarration.ts          100 /   100 /   100 /   100
      //   PlanNarration.tsx                95.00 / 96.72 / 96.15 / 98.08
      //   internal/ai/plan-step/route      93.62 / 92.31 /   100 / 95.45
      //
      //   REPORTED (whole-file; the story's own arms are read per function)
      //   plansService.ts                  35.94 / 29.42 / 41.56 / 38.50
      //   mcp/tools/authorPlan.ts          57.31 / 51.20 / 50.00 / 57.83
      //   planMappers.ts                   90.91 / 61.11 / 87.50 / 90.00
      //   planReviewService.ts             43.19 / 32.22 / 50.00 / 46.42
      //   aiGenerationService.ts           14.61 / 22.86 / 10.00 / 13.16
      //   planReviewClient.ts              34.09 / 19.35 / 27.27 / 34.21
      //   PlanActRecord.tsx                73.68 / 66.67 / 92.31 / 76.92
      //   planCallLines.ts                 78.57 / 70.00 / 80.00 / 84.21
      //   usePlanChangeConversation.ts     18.31 /  8.96 / 15.51 / 21.46
      //
      //   The story's own functions on the REPORTED files, per function:
      //   recordPlanNarration 19/19 stmts, 11/11 branches · recordPlanStep 7/7, 2/2 ·
      //   reportPlanStep 16/16, 10/10 · resolveStepTargetTitle 10/10, 6/8 (below) ·
      //   runReportPlanStep 17/17, 27/28 (a pre-existing `?? args.sessionKey` on a
      //   stored step) · recordPlanStepForJob 11/11, 16/16 · listPlanNarration 6/6,
      //   2/2 · toPlanNarrationDto / toPlanNarrationSessionDto 1/1 ·
      //   fetchPlanNarrationPage fully reached (the story gate's C5b) ·
      //   getPlanReview's narration block fully reached.
      //
      // Arms reached by tests THIS card added rather than named away: the paged
      // route's access-denied 404 (story gate § I) and the panel client's own
      // request, through the real route (§ C5b). `planNarrationRepository` read
      // 61.9% before them because three methods (`listByPlan`, `listByPlanIds`,
      // `listSessionsByPlanIds`) and `createMany`'s empty-batch guard had no
      // caller — MOTIR-8062 wrote them unmerged on this same branch, so this card
      // removed them rather than test dead code.
      //
      // ⚠️ THE NAMED RESIDUALS — every arm still unreached, with its invariant.
      //   · narration route: a non-`browse` `ProjectAccessDeniedError` (403) and the
      //     final rethrow — a read refuses only as `browse`, and no layer below
      //     throws anything else untyped short of a database outage.
      //   · plan-step route: the residuals the plan-progress lane already names
      //     (the non-job error out of the rate-limit store, the final rethrow).
      //   · `resolveStepTargetTitle`'s unresolvable-target → `null` arms (a
      //     `planItem:` naming no row, a work-item id naming none):
      //     `assertStepTarget` refuses both in the same transaction first, so a
      //     stored head is never titled from a target that does not exist.
      //   · PlanNarration.tsx: `readRemembered`'s storage-throws catch on READ (the
      //     component suite throws on write) and the per-group toggle's unfold of
      //     an already-toggled key — above the floor without them.
      thresholds: {
        perFile: true,
        ...Object.fromEntries(GATED.map((file) => [file, FLOOR])),
      },
    },
  },
});
