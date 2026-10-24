import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// THE "SAME AGENT STAYS ON ITS PULL REQUEST" STORY'S COVERAGE FLOOR (Story MOTIR-8981 ·
// MOTIR-9057) — every motir-core app file the story changed under `lib/`, `app/` and
// `components/`, NAMED below in exactly one of two lists, and every file in the first
// held to the per-file floor of 90% statements, functions, branches and lines. Measured
// over the story gate (`tests/integration/fixInMyAgentStoryGate.test.ts`: the repair
// claim, the run command from the POST body to the control request, and the recorded
// session read back) plus the per-card suites. Mirrors
// `vitest.coverage.agent-instance-run.config.ts`.
//
// ⚠️ PER-FILE, NEVER GLOBAL — a file's own untested branch cannot hide behind a
// neighbour's surplus.
//
// ⚠️ THE GLOBS NEVER SPELL A ROUTE GROUP OR A DYNAMIC SEGMENT. `(authed)` is an
// extglob group to the coverage matcher, which matches `authed` WITHOUT the
// parentheses — so `app/(authed)/…` silently measures nothing — and `[key]` / `[id]` are
// character classes (MOTIR-2449). A single path segment is `*` here instead.
// `tests/integration/fixInMyAgentStoryGate.test.ts` §4 holds this file to that.
//
// Held elsewhere, deliberately:
//   * the CLI half of the story (`packages/cli/src/**` — the resume choice, `motir fix`,
//     the CI watch, the terminal server's command) is held by
//     `packages/cli/vitest.config.ts`'s own per-file thresholds, run by the `cli` job's
//     `test:coverage`; NO CLI path is listed below;
//   * `design/**`, `docs/**`, `messages/*.json`, `prisma/**` carry no code to measure.

const FLOOR = { statements: 90, functions: 90, branches: 90, lines: 90 } as const;

/** Every file below is held to {@link FLOOR}, whole-file. */
const MEASURED = [
  // MOTIR-9045 — the run command a start can be asked for.
  'lib/agentInstances/runCommand.ts',
  'lib/agentInstances/terminal.ts',
  'lib/agentInstances/errors.ts',
  'lib/agentInstances/errorResponse.ts',
  'lib/agentInstances/profiles.ts',
  'lib/dto/agentInstanceRuns.ts',
  'lib/dto/dispatchRuns.ts',
  'lib/api/v1/contractVersion.ts',
  'lib/services/agentInstanceRunService.ts',
  'app/api/work-items/*/agent-runs/route.ts',
  // MOTIR-9053 — the door: its read and its control.
  'lib/services/fixInMyAgentService.ts',
  'components/agentRuns/FixInMyAgentControl.tsx',
  'app/*/items/*/_components/FixInMyAgentDoor.tsx',
  // MOTIR-9052 / MOTIR-9059 — the run's result in the Runs surfaces.
  'app/*/runs/_components/AgentRunParts.tsx',
  // MOTIR-9054 / MOTIR-9060 — the automatic fix and the project's switch.
  'lib/services/ciRedAutoFixService.ts',
  'lib/services/projectAgentAutoFixSettingsService.ts',
  'lib/dto/projectAgentAutoFixSettings.ts',
];

/**
 * SHARED files the story also changed, NAMED and deliberately NOT floored here. Each
 * entry names the suite that reaches the story's own lines in it.
 *
 * Large, older files — the story's change is a handful of lines and the uncovered
 * remainder is OTHER stories' code, measured by their own suites in the main `test` job:
 */
export const SHARED_NOT_FLOORED = [
  // The repair claim — the story's `opening.resume`, `admit` and `onReplay` arms. Reached by
  // `tests/services/workItemRepairAgentOpening.test.ts` and the gate's §1.
  'lib/services/workItemRepairService.ts',
  // The CI feedback fold — the story's one call into `maybeAutoFixOnRed`. Reached by
  // `tests/integration/ci/ciRedAutoFixThroughFeedback.test.ts`.
  'lib/services/changeRequestCiFeedback.ts',
  // The run record's repositories and mapper — one query / one field each. Reached by
  // `tests/agentInstances/agentResumeTarget.test.ts` and the gate's §3.
  'lib/repositories/dispatchRunRepository.ts',
  'lib/repositories/dispatchRunEventRepository.ts',
  'lib/repositories/projectRepository.ts',
  'lib/mappers/dispatchRunMappers.ts',
  'lib/api/v1/workLoop/schema.ts',
  // The Development block and its fix part — the story mounts the door in the offer state.
  // Reached by `tests/components/repair-fix-part.test.tsx` (87.6% branches on the whole file).
  'components/github/DevelopmentSection.tsx',
  'components/github/RepairFixPart.tsx',
  // The run modal — it threads the ended run's door through. Reached by
  // `tests/components/RunModal.test.tsx`.
  'app/*/runs/_components/RunModal.tsx',
  // Server components — rendered by Next, reached by the E2E
  // (`tests/e2e/regression-fix-in-my-agent.spec.ts`), not by Vitest.
  'app/*/items/*/_components/LateSections.tsx',
  'app/*/settings/project/hosted-agent/page.tsx',
  /**
   * Thin transports whose whole job is one service call and a status map. Their happy
   * path and the 400 / 404 answers are driven by `tests/integration/fixInMyAgentStoryGate.test.ts`
   * §3; the arms that remain are the session gate's refusal and the unmapped rethrow, which
   * the framework seam owns.
   */
  'app/api/work-items/*/fix-in-my-agent/route.ts',
  'app/api/work-items/*/agent-runs/resume-target/route.ts',
  'app/api/projects/*/agent-auto-fix/route.ts',
  /**
   * FINDING, reported on MOTIR-9057 and not fixed here (no production source change in this
   * card): `AgentAutoFixRow.flip`'s guard `!canConfigure || inFlight.current` is unreachable
   * from the UI — the switch is `disabled` in both states — so two of its sixteen branches
   * (87.5% on the file) can only be covered by a `v8 ignore`, which this card forbids. Driven
   * by `tests/components/agent-auto-fix-row.test.tsx`.
   */
  'app/*/settings/project/hosted-agent/_components/AgentAutoFixRow.tsx',
];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      // The story gate, and the per-card suites.
      'tests/integration/fixInMyAgentStoryGate.test.ts',
      'tests/integration/ci/ciRedAutoFixThroughFeedback.test.ts',
      'tests/services/workItemRepairAgentOpening.test.ts',
      'tests/services/ciRedAutoFix.test.ts',
      'tests/services/fixInMyAgentService.test.ts',
      'tests/settings/project-agent-auto-fix-settings.test.ts',
      'tests/projects/agentAutoFixSwitchSchema.test.ts',
      'tests/agentInstances/agentInstanceRunStart.test.ts',
      'tests/agentInstances/agentInstanceRunRoutes.test.ts',
      'tests/agentInstances/agentInstanceUnits.test.ts',
      'tests/agentInstances/agentInstanceTerminal.test.ts',
      'tests/agentInstances/agentProfileResumeForms.test.ts',
      'tests/agentInstances/agentResumeTarget.test.ts',
      'tests/api/v1/contract-version-guard.test.ts',
      // The door, the Runs surfaces and the settings row.
      'tests/components/fix-in-my-agent-door.test.tsx',
      'tests/components/fix-in-my-agent-door-placement.test.tsx',
      'tests/components/agent-auto-fix-row.test.tsx',
      'tests/components/repair-fix-part.test.tsx',
      'tests/components/AgentRunSurfaces.test.tsx',
      'tests/components/RunModal.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      all: true,
      include: MEASURED,
      thresholds: {
        perFile: true,
        ...FLOOR,
      },
    },
  },
});
