import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// STORY MOTIR-683's `motir-core` COVERAGE FLOOR (MOTIR-692).
//
// ⚠️ WHAT A FLOOR IS FOR HERE, AND WHAT IT IS NOT. It does not decide whether the
// hosted-agent run is correct — `tests/hostedRuns/hostedRunStoryGate.test.ts`
// holds the properties a percentage cannot see (the round trip, the no-leak
// guard, the isolation and start-refusal cases), and each card of the story
// shipped its own units. What a floor catches is what units cannot: a LATER
// change that deletes a branch's only test and leaves the branch — on a surface
// that mints and revokes live credentials against real git and a real gateway,
// where a dead branch means a secret outlives the run that held it.
//
// ⚠️ PER-FILE, NEVER GLOBAL, and read off the MERGED result. These are the
// motir-core server files the story changed: the run's two credentials, its
// git identity, the model/limits/id constants, the CLI's route allow-list, and
// the start/cancel/git-credential HTTP edges. Each floor is set at, or just
// under, what this lane's own command measures — never a round number.
//
// ⚠️ IT RUNS THE SUITES THAT REACH THE SURFACE, NOT THE WHOLE TREE — the story
// gate plus the per-card suites already in the tree for these files.
//
// ⚠️ DYNAMIC ROUTE SEGMENTS ARE MATCHED WITH `**`, NEVER THE LITERAL `[id]` /
// `[key]` (MOTIR-2449's character-class hazard: `[id]` is a glob class, not a
// path segment, to the matcher the coverage provider uses).
//
// ⚠️ IT DOES NOT OVERRIDE `resolve` — see the onboarding-routing lane's own
// comment for why: spread the base config and change only what this lane is
// about.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      'tests/hostedRuns/**/*.test.ts',
      'tests/api/v1/dispatch-run-git-credential-route.test.ts',
      'tests/api/v1/run-credential-legs.test.ts',
      'tests/api/v1/run-credential-routes.test.ts',
      'tests/ciFleet/hostedRunCharge.test.ts',
      'tests/github/runGitCredential.test.ts',
      'tests/projectRepos/hostedRunRepoAccessService.test.ts',
      'tests/runCredentialService.test.ts',
      // Story MOTIR-6527 (Continue hosted) · MOTIR-6797 — the continue claim's own
      // suites and the item page's door.
      'tests/ready/claimWorkItemContinue.test.ts',
      'tests/ready/continueViewReasons.test.ts',
      'tests/ready/claimContinueResume.test.ts',
      'tests/components/ContinueHostedDoor.test.tsx',
      'tests/components/continue-part.test.tsx',
      'tests/components/RunHostedDoor.test.tsx',
      // Story MOTIR-7261 · MOTIR-7262 / MOTIR-7264 — the continue claim's MCP door
      // grew this service (the agent claim's beat, touch, close and the own-run
      // read); its own suites measure what it added.
      'tests/mcp/workItemContinueTool.test.ts',
      'tests/mcp/workItemContinue-transport.test.ts',
      // Story MOTIR-6590 · MOTIR-6879 — Continue hosted lifted into a control any
      // surface can place; the door's floor follows the code it moved.
      'tests/components/continue-hosted-control.test.tsx',
      // Story MOTIR-6989 · MOTIR-6996 — Run hosted preselects the difficulty's
      // model; the picker's read (`hostedRunPickerService`) is measured by
      // `tests/hostedRuns/hostedRunPickerModels.test.ts`, above.
      'tests/components/run-hosted-from-difficulty.test.tsx',
      // Story MOTIR-9541 · MOTIR-9630 / MOTIR-9631 — a model with no agent-run capacity
      // is held in the picker and at the door; the story's integration gate.
      'tests/components/hosted-model-capacity.test.tsx',
      'tests/integration/hostedRuns/**/*.test.ts',
      // Story MOTIR-6989 · MOTIR-6997 — the story's integration gate (settings
      // save → models read → a real start, across a withdrawn override), plus
      // the resolver's and the settings service's own suites.
      'tests/integration/hosted/**/*.test.ts',
      'tests/hosted/resolveHostedModel.test.ts',
      'tests/hosted/projectHostedAgentSettingsMappers.test.ts',
      // Story MOTIR-1626 · MOTIR-6820 — the hosted REVIEW start, its end and its cancel:
      // `hostedRunService.startReview`, the review arms of the end path, the liveness read,
      // the read-level git check and `hostedRunModelService.defaultOffered`.
      'tests/agentReview/agentReviewStart.test.ts',
      // Story MOTIR-1626 · MOTIR-6930 — *Fix on the hosted agent*: `FixHostedControl`, its
      // refusal mapping in `hostedModels.ts`, and the runs-changed signal the To fix
      // banner announces and `HostedRunProvider` listens for — all under this lane's
      // `components/hosted/**` and provider floors.
      'tests/components/fix-hosted-door.test.tsx',
      // Story MOTIR-6864 · MOTIR-7027 — the cancel route (measured below) also takes a
      // run in an agent; its instance arm is driven by the agent run's lifecycle suite.
      'tests/agentInstances/agentInstanceRunLifecycle.test.ts',
      // Story MOTIR-6864 · MOTIR-7028 — Send to my agent on the item page's start bar,
      // and a run in an agent on the Run section and the run modal.
      'tests/components/SendToAgentDoor.test.tsx',
      'tests/components/AgentRunSurfaces.test.tsx',
      'tests/components/HostedRunSurfaces.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      all: false,
      include: [
        'lib/hostedRuns/**',
        'lib/services/hostedRun*.ts',
        'lib/github/runGitCredential.ts',
        'lib/services/runTokenScopeService.ts',
        'lib/services/runCredentialService.ts',
        'app/api/v1/dispatch-runs/**/git-credential/route.ts',
        'app/api/work-items/**/hosted-runs/route.ts',
        'app/api/dispatch-runs/**/cancel/route.ts',
        // Story MOTIR-6527 · MOTIR-6797. The story also changed three SHARED files
        // (`lib/dispatch/promptTemplate.ts`, `lib/mappers/dispatchRunMappers.ts`,
        // `lib/repositories/dispatchRunEventRepository.ts`); their uncovered lines
        // on this lane are code the story did not touch (the runs index, the event
        // pager), so a whole-file floor here would measure other stories.
        'lib/services/workItemContinueService.ts',
        'components/github/ContinuePart.tsx',
        'app/**/_components/ContinueHostedDoor.tsx',
        'app/**/_components/HostedRunProvider.tsx',
        'components/hosted/**',
        // Story MOTIR-6989 · MOTIR-6997. `hostedRunPickerService.ts` is already
        // matched by `lib/services/hostedRun*.ts` above.
        'lib/hosted/resolveHostedModel.ts',
        'lib/services/projectHostedAgentSettingsService.ts',
        'lib/mappers/projectHostedAgentSettingsMappers.ts',
        // Story MOTIR-6864 · MOTIR-7028 — the start bar, Send to my agent and its
        // picker, the send's press, the header's Cancel, and a run in an agent's parts.
        'app/**/_components/StartBar.tsx',
        'app/**/_components/SendToAgentDoor.tsx',
        'app/**/_components/useAgentSend.ts',
        'app/**/_components/RunHostedButton.tsx',
        'app/**/_components/AgentRunParts.tsx',
      ],
      thresholds: {
        perFile: true,
        'lib/services/workItemContinueService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'components/github/ContinuePart.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/ContinueHostedDoor.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/HostedRunProvider.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'components/hosted/**': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/StartBar.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/SendToAgentDoor.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/useAgentSend.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/RunHostedButton.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/**/_components/AgentRunParts.tsx': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/hostedRuns/errors.ts': { statements: 90, functions: 90, branches: 90, lines: 90 },
        'lib/hostedRuns/ids.ts': { statements: 90, functions: 90, branches: 90, lines: 90 },
        'lib/hostedRuns/limits.ts': { statements: 90, functions: 90, branches: 90, lines: 90 },
        'lib/hostedRuns/machineRate.ts': { statements: 90, functions: 90, branches: 90, lines: 90 },
        'lib/hostedRuns/runTokenRoutes.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunChargeService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunGitCredentialService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunKeyService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunPickerService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunModelService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunRepoAccessService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/hostedRunService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/github/runGitCredential.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/runTokenScopeService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/runCredentialService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/api/v1/dispatch-runs/**/git-credential/route.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/api/work-items/**/hosted-runs/route.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'app/api/dispatch-runs/**/cancel/route.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        // Story MOTIR-6989 · MOTIR-6997 — the model-by-difficulty surface.
        'lib/hosted/resolveHostedModel.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/services/projectHostedAgentSettingsService.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
        'lib/mappers/projectHostedAgentSettingsMappers.ts': {
          statements: 90,
          functions: 90,
          branches: 90,
          lines: 90,
        },
      },
    },
  },
});
