// Story MOTIR-9359 · MOTIR-9427 — the coverage floor over the story's motir-core
// files. It globs the coverage include set (`tests/helpers/coverageGate.ts`),
// which is whole-tree filesystem work, and opens no database, so it lives in the
// structural-guard lane rather than beside the story gate's database cases in
// `agentRunnerPoolStoryGate.test.ts`.
import { describe, expect, it } from 'vitest';
import hostedAgentRunCoverage from '../../vitest.coverage.hosted-agent-run.config';
import { filesForIncludePattern, includePatterns, thresholdsFor } from '../helpers/coverageGate';

describe('the coverage floor over the story’s motir-core files', () => {
  const STORY_FILES = [
    'lib/ciFleet/fleetKindSwitches.ts',
    'lib/services/fleetShardAdmissionService.ts',
    'lib/services/fleetCeilingService.ts',
    'lib/repositories/fleetInFlightSlotRepository.ts',
    'lib/services/hostedAgentContainerService.ts',
    'lib/orchestrator/index.ts',
    'lib/services/fleetAttributionService.ts',
  ];

  it.each(STORY_FILES)(
    '%s is in coverage.include with its own threshold at the floor',
    async (file) => {
      const matched = (
        await Promise.all(
          includePatterns.map(async (p) => (await filesForIncludePattern(p)).includes(file)),
        )
      ).some(Boolean);
      expect(matched).toBe(true);
      const applied = await thresholdsFor(file);
      expect(Object.keys(applied)).toContain(file);
      expect(applied[file]).toMatchObject({ branches: 90, functions: 90, lines: 90 });
    },
    // The first call globs the whole include set.
    120_000,
  );

  it('hostedRunService keeps its floor in the hosted-agent-run lane, not here', () => {
    const coverage = hostedAgentRunCoverage.test?.coverage as {
      include?: string[];
      thresholds?: Record<string, unknown>;
    };
    expect(coverage.include).toContain('lib/services/hostedRun*.ts');
    expect(coverage.thresholds?.['lib/services/hostedRunService.ts']).toMatchObject({
      branches: 90,
      lines: 90,
    });
  });
});
