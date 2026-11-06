import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-1626's `motir-core` COVERAGE FLOOR (9.8 · the review agent; MOTIR-6826).
//
// ⚠️ WHAT A FLOOR IS FOR HERE, AND WHAT IT IS NOT. It does not decide whether the review
// agent is correct — `tests/integration/agentReviewStoryGate.test.ts` holds what a
// percentage cannot see (the loop from green through the review run and its verdict to the
// approve-and-merge gate or To fix, the exclusion with `auto`, the head move, the review
// that could not run, the switch, tenant isolation, the optional conventions and the hosted
// repair), and each card of the story shipped its own suite. What a floor catches is what
// those cannot: a LATER change that deletes a branch's only test and leaves the branch — on
// a surface that decides a gate as a MACHINE (`review_agent`) and boots paid containers.
//
// ⚠️ PER-FILE, NEVER GLOBAL, and over the files this story CREATED. The story also changed
// ~60 shared files (the gate service, the hosted start, the repair claim, the webhook
// withdrawals …); a whole-file floor on those would measure other stories' lines, which is
// the hosted-agent-run lane's reason for the same choice. Those shared files are gated —
// where they are gated at all — by the lanes that own them.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE — the story gate plus
// the per-card server suites already in the tree for these files. Measured with:
//   pnpm vitest run --config vitest.coverage.review-agent.config.ts --coverage
//
// ⚠️ DYNAMIC ROUTE SEGMENTS ARE MATCHED WITH `**`, NEVER THE LITERAL `[id]` / `[key]`
// (MOTIR-2449's character-class hazard: `[id]` is a glob class, not a path segment, to the
// matcher the coverage provider uses).
//
// ⚠️ IT DOES NOT OVERRIDE `resolve` — spread the base config and change only what this lane
// is about (the onboarding-routing lane's comment says why).
const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

// ⚠️ THE AXES PINNED UNDER THE PROJECT'S 90, each MEASURED on this branch by this lane's own
// command (2026-09-29) and pinned at the integer below the measurement — never a wish. What
// stays uncovered is DEFENSIVE on the assembled path (a row gone mid-transaction, a fallback
// the schema makes unreachable); among it:
//   · agentReviewHandler — `resolveSubject` of a gate whose card delivers nothing, and the
//     card row vanishing under its own lock (62.5% branches).
//   · reviewPromptTemplate — a convention over the cap with NO line break, a pull request
//     with no title or no branch Motir holds (86.66% branches).
//   · repairRunMappers — a run with two legs on one card, or a leg with no card (85.71%
//     statements, 75% branches).
//   · agentReviewRunService — the event-log ceiling, a project row gone mid-read, a member
//     the version names but no delivery row holds, and the decide door's not-found after the
//     gate was read (82.14% branches).
//   · agentReviewStartService — the stand-in-manager attribution (a card's `reporterId` is
//     NOT NULL, so the fallback is unreachable today), a refusal with no `code`, a card or
//     project deleted between the gate read and the permission read (89.88% statements,
//     81.25% branches).
//   · agentReviewViewService — the `settingsDoor` absent for a viewer the gate read hands
//     none (80% branches).
// Raise a pin when a test reaches the branch; lowering one is a regression.
const BELOW_FLOOR: Record<string, Partial<Record<keyof typeof FLOOR, number>>> = {
  'lib/approvalGates/agentReviewHandler.ts': { branches: 62 },
  'lib/dispatch/reviewPromptTemplate.ts': { branches: 86 },
  'lib/mappers/repairRunMappers.ts': { statements: 85, branches: 75 },
  'lib/services/agentReviewRunService.ts': { branches: 82 },
  'lib/services/agentReviewStartService.ts': { statements: 89, branches: 81 },
  'lib/services/agentReviewViewService.ts': { branches: 80 },
};

const STORY_FILES = [
  'lib/agentReview/errors.ts',
  'lib/agentReview/reviewRunKey.ts',
  'lib/api/v1/workLoop/agentReview.ts',
  'lib/approvalGates/agentReviewHandler.ts',
  'lib/approvalGates/reviewRefusal.ts',
  'lib/dispatch/reviewPromptTemplate.ts',
  'lib/dto/agentReview.ts',
  'lib/jobs/definitions/agentReviewRequested.ts',
  'lib/mappers/repairRunMappers.ts',
  'lib/services/agentReviewRunService.ts',
  'lib/services/agentReviewStartService.ts',
  'lib/services/agentReviewViewService.ts',
  'lib/services/reviewBugFilingService.ts',
  'lib/services/reviewConventionsService.ts',
  'lib/workItems/reviewSentBack.ts',
  'lib/workspaces/afterCommit.ts',
  'app/api/approval-gates/**/review-again/route.ts',
  'app/api/v1/work-items/**/agent-review/route.ts',
  'app/api/v1/work-items/**/review-prompt/route.ts',
] as const;

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate — the assembly, on the real doors.
      'tests/integration/agentReviewStoryGate.test.ts',
      // The per-card server suites (MOTIR-6818 · 6819 · 6820 · 6821 · 6822 · 6904 · 6928).
      'tests/settings/review-agent-switch.test.ts',
      'tests/approvalGates/agentReviewGate.test.ts',
      'tests/approvalGates/agentReviewGateSet.test.ts',
      'tests/agentReview/*.test.ts',
      'tests/api/v1/agent-review-routes.test.ts',
      'tests/dispatch/reviewPromptTemplate.test.ts',
      'tests/services/reviewRepairClass.test.ts',
      'tests/hostedRuns/hostedRunStartFix.test.ts',
      // MOTIR-6930 — the Workbench's sent-back row, which reads `isReviewSentBack`.
      'tests/services/homeServiceToFix.test.ts',
      // MOTIR-10332 — the review SOURCE: `own` skips the hosted start and refuses Review again.
      'tests/approvalGates/reviewAgentSource.test.ts',
      // MOTIR-10333 · MOTIR-10334 — the own-agent verdict door and Dismiss, whose refusals
      // (`lib/agentReview/errors.ts`) and gate-off send-back source (`reviewRefusal.ts`)
      // are story files of this lane.
      'tests/approvalGates/reviewVerdictDoor.test.ts',
      'tests/approvalGates/reviewDismissal.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      all: false,
      include: [...STORY_FILES],
      thresholds: {
        perFile: true,
        ...Object.fromEntries(
          STORY_FILES.map((file) => [file, { ...FLOOR, ...(BELOW_FLOOR[file] ?? {}) }]),
        ),
      },
    },
  },
});
