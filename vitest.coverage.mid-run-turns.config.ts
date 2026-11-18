import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// Coverage for TALK TO THE PLANNER WHILE IT PLANS — Story MOTIR-7990's
// `motir-core` integration gate, MOTIR-8003 (`docs/decisions/conversation-turn-intent.md`
// AMENDMENT 4; the mailbox ADR's mid-run amendment): the run snapshot, the late
// revision, the planner's mid-run pause (its table, service and two doors) and the
// two rail components that draw them.
//
// ⚠️ MEASURED: the files the story ADDED in core, held at the story's GATE — at
// least 90 on statements, branches, functions and lines, PER FILE. The shared files
// the story extended by a branch each are NOT measured, because a per-file number
// over them would measure their pre-existing code, which this lane does not run:
//   lib/services/aiAskService.ts            (`submitMidRunTurn`, `settleMidRun`)
//   lib/planning/askResult.ts               (the widened `readAskOutcome`)
//   app/api/ai/ask/route.ts                 (the `runJobId` + `planId` branch)
//   lib/services/planChangeMailboxService.ts (`declinesPause` / `answersQuestion`)
//   lib/planChange/errors.ts                (the five pause errors)
//   app/api/ai/plan-change/_errors.ts       (their status mapping)
//   lib/hooks/usePlanChangeConversation.ts  (the mid-run send, `lateRevision`,
//                                            `runPause`, `answerRunPause`)
//   components/planning/PlanChangeRail.tsx  (the mount points)
//   lib/planning/planChangeClient.ts        (the client calls)
// The story's lines in them are exercised by the suites in `include` below — the
// ask-path suites (`midRunAsk`, `askResult`, `askRoutes`, `askGate`), the late-change
// and pause suites, and the component suites around the hook and the rail — which
// is the `plan-something-new` precedent.
//
// The floors are the MEASURED reading over this lane's suites, rounded DOWN, PER
// FILE, and they are a RATCHET: never below the 90 gate, and moved up — never down —
// when a file’s reading rises. CI: the `story-7990-coverage` job, which needs
// Postgres.

const MEASURED = [
  'lib/services/planRunContextService.ts',
  'lib/services/planChangeLateChangeService.ts',
  'lib/services/planChangeRunPauseService.ts',
  'lib/repositories/planChangeRunPauseRepository.ts',
  'app/api/ai/plan-change/session/late-changes/route.ts',
  'app/api/internal/ai/plan-change-run-pause/route.ts',
  'app/api/ai/plan-change/session/run-pause/route.ts',
  'components/planning/MidRunTurn.tsx',
  'components/planning/RunPause.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The gate: the core half of the story through its HTTP doors.
      'tests/integration/planning/midRunTurnsStoryGate.test.ts',
      // The predecessors' own suites.
      'tests/integration/planning/midRunAsk.test.ts',
      'tests/planning/askResult.test.ts',
      'tests/components/plan-change-mid-run-turn.test.tsx',
      'tests/integration/planning/lateChangeRevision.test.ts',
      'tests/components/plan-change-late-change.test.tsx',
      'tests/integration/planning/runPause.test.ts',
      'tests/ai/runPauseRoutes.test.ts',
      'tests/components/plan-change-mid-run-rail.test.tsx',
      'tests/components/plan-change-run-pause.test.tsx',
      'tests/components/code-unsearchable-banner.test.tsx',
      // The pieces on their own, in every state their props can take.
      'tests/components/plan-change-mid-run-pieces.test.tsx',
      // A question's options, drawn and picked on the pause (MOTIR-11700).
      'tests/components/question-options.test.tsx',
      // The waiting-plan snapshot (Bug MOTIR-11488): `buildWaitingPlanContext`.
      'tests/planning/waitingPlanContext.test.ts',
      'tests/integration/planning/waitingPlanAsk.test.ts',
      // The no-run submit path, listed so it is proven UNCHANGED beside the new one.
      'tests/ai/askRoutes.test.ts',
      'tests/ai/askGate.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary'],
      all: true,
      include: MEASURED,
      // MEASURED 2026-10-10 at MOTIR-8003 over this lane's suites, rounded DOWN, and
      // never below the gate. Uncovered on purpose, each a guard that no request or
      // state can reach through a door (the door or the row lock decides first):
      //   * `…/late-changes/route.ts`, `…/run-pause/route.ts`: the closing
      //     `throw err` for an error the plan-change mapper does not know;
      //   * `…/plan-change-run-pause/route.ts`: the same, and the job-auth
      //     `throw err` for a failure that is neither a bad credential nor a 429;
      //   * `planChangeLateChangeService.ts`, `planChangeRunPauseService.ts`: "the
      //     session row vanished under its own lock", "a lost claim cannot happen
      //     under the lock", the `kind` and `idempotencyKey` re-checks the doors have
      //     already made, and the `EmptyPlanChangeTurnError` the reply's own blank
      //     check precedes.
      thresholds: {
        'app/api/ai/plan-change/session/late-changes/route.ts': {
          statements: 96,
          branches: 94,
          functions: 100,
          lines: 95,
        },
        'app/api/ai/plan-change/session/run-pause/route.ts': {
          statements: 95,
          branches: 91,
          functions: 100,
          lines: 94,
        },
        'app/api/internal/ai/plan-change-run-pause/route.ts': {
          statements: 93,
          branches: 92,
          functions: 100,
          lines: 92,
        },
        'lib/repositories/planChangeRunPauseRepository.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'lib/services/planChangeLateChangeService.ts': {
          statements: 97,
          branches: 96,
          functions: 100,
          lines: 100,
        },
        'lib/services/planChangeRunPauseService.ts': {
          statements: 95,
          branches: 90,
          functions: 100,
          lines: 98,
        },
        'lib/services/planRunContextService.ts': {
          statements: 100,
          branches: 90,
          functions: 100,
          lines: 100,
        },
        // The rail components: the rail suites draw them inside the rail, and
        // `plan-change-mid-run-pieces` draws each piece alone in every state its props
        // can take (a late revision with no plan to link, a reply the hook has not
        // matched to an entry, a refusal code the catalogue has no line for).
        'components/planning/MidRunTurn.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'components/planning/RunPause.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
