import { describe, expect, it } from 'vitest';
import {
  dispatchAdvisorySchema,
  dispatchPromptSchema,
  presentDispatchPrompt,
} from '@/lib/api/v1/workLoop/schema';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import { isRunnerStopAdvisory, type WorkItemProseAdvisoryDto } from '@/lib/dto/workItems';
import type { DispatchPromptDto } from '@/lib/dto/dispatch';

// The RUNNER-STOP members of the published v1 advisory union (MOTIR-10380): the
// contract parses a payload carrying one, keeps its `runnerStop` field, and the
// presenter maps one field by field.

const noDescription = {
  kind: 'shape',
  item: 'ACME-7',
  severity: 'leaf-no-description',
  runnerStop: true,
} as const;
const noCriteria = {
  kind: 'shape',
  item: 'ACME-8',
  severity: 'leaf-no-criteria',
  runnerStop: true,
  criteria: 'no-heading',
} as const;

const multiRepo = {
  kind: 'shape',
  item: 'ACME-10',
  severity: 'leaf-multi-repo',
  runnerStop: true,
  path: 'motir-ai/src/b.ts',
  repo: 'motir-ai',
  criterionIndex: 2,
} as const;

describe('dispatchAdvisorySchema — the runner-stop member', () => {
  it('parses the multi-repo member whole, ahead of the criterion-shaped member (MOTIR-10381)', () => {
    expect(dispatchAdvisorySchema.parse(multiRepo)).toEqual(multiRepo);
  });

  it('still parses a `likely-repo-straddle` payload unchanged, with no `runnerStop`', () => {
    const straddle = {
      kind: 'shape',
      item: 'ACME-11',
      severity: 'likely-repo-straddle',
      criterionIndex: 2,
      path: 'motir-ai/src/b.ts',
      repo: 'motir-ai',
      reason: 'contradiction',
    };
    expect(dispatchAdvisorySchema.parse(straddle)).toEqual(straddle);
  });

  it('parses each body member and keeps `runnerStop` (the member is tried first)', () => {
    expect(dispatchAdvisorySchema.parse(noDescription)).toEqual(noDescription);
    expect(dispatchAdvisorySchema.parse(noCriteria)).toEqual(noCriteria);
  });

  it('still parses an `under-authored` payload unchanged, with no `runnerStop`', () => {
    const under = {
      kind: 'shape',
      item: 'ACME-9',
      severity: 'under-authored',
      criteria: 'no-heading',
    };
    expect(dispatchAdvisorySchema.parse(under)).toEqual(under);
  });

  it('the contract version moved past 1.78.0', () => {
    const [major, minor] = V1_CONTRACT_VERSION.split('.').map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(79);
  });
});

describe('presentDispatchPrompt — maps a runner stop field by field', () => {
  it('passes both members through, and the result validates', () => {
    const advisories = [
      noDescription,
      noCriteria,
      multiRepo,
    ] as unknown as WorkItemProseAdvisoryDto[];
    expect(advisories.every(isRunnerStopAdvisory)).toBe(true);
    const dto = {
      key: 'ACME-7',
      prompt: 'p',
      parentKey: null,
      targetRepo: null,
      targetRepoCloneUrl: null,
      targetRepoDefaultBranch: null,
      targetRepos: [],
      workflowMode: 'per_item_pr',
      sessionBranch: null,
      workBranch: null,
      branch: null,
      advisories,
    } as unknown as DispatchPromptDto;
    const wire = presentDispatchPrompt(dto);
    expect(wire.advisories).toEqual([noDescription, noCriteria, multiRepo]);
    expect(dispatchPromptSchema.parse(wire).advisories).toEqual([
      noDescription,
      noCriteria,
      multiRepo,
    ]);
  });
});
