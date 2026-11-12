import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvedPlanCreatedInitCard,
  projectRepoInitApproveRoutingService,
} from '@/lib/services/projectRepoInitApproveRoutingService';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepoInitRoutingService } from '@/lib/services/projectRepoInitRoutingService';

// Story MOTIR-10162 · Subtask MOTIR-11058 — the approve step's GATE, over hand-built
// proposals and with no database: did the approved plan create an init card? A
// presence test, never a match.

const init = (initRepositoryName: unknown) => ({
  op: 'add',
  proposedFields: { title: 'Create it', subject: 'init', initRepositoryName },
});
const plain = { op: 'add', proposedFields: { title: 'Plain' } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approvedPlanCreatedInitCard', () => {
  it('answers true for an add carrying a declaration', () => {
    expect(approvedPlanCreatedInitCard([plain, init('acme-infra')])).toBe(true);
  });

  it('answers true whatever the name is: it compares the name to nothing', () => {
    expect(approvedPlanCreatedInitCard([init('Not-In-Any-Set')])).toBe(true);
    expect(approvedPlanCreatedInitCard([init('')])).toBe(true);
  });

  it('answers false for a null or an absent declaration', () => {
    expect(approvedPlanCreatedInitCard([init(null)])).toBe(false);
    expect(approvedPlanCreatedInitCard([plain])).toBe(false);
    expect(approvedPlanCreatedInitCard([{ op: 'add', proposedFields: null }])).toBe(false);
    expect(approvedPlanCreatedInitCard([{ op: 'add', proposedFields: 'odd' }])).toBe(false);
  });

  it('answers false when only a modify carries it', () => {
    expect(
      approvedPlanCreatedInitCard([
        { op: 'modify', proposedFields: { initRepositoryName: 'acme-infra' } },
      ]),
    ).toBe(false);
  });

  it('answers false for an empty plan', () => {
    expect(approvedPlanCreatedInitCard([])).toBe(false);
  });
});

describe('routeAfterApprove behind a closed gate', () => {
  it('reads nothing and routes nothing', async () => {
    const read = vi.spyOn(projectRepoRepository, 'listByProject');
    const route = vi.spyOn(projectRepoInitRoutingService, 'routeInitCardDependents');

    const result = await projectRepoInitApproveRoutingService.routeAfterApprove({
      projectId: 'p1',
      ctx: { userId: 'u1', workspaceId: 'w1' },
      approvedProposals: [plain],
    });

    expect(result).toEqual({ routedWorkItemIds: [], failedRepositoryIds: [] });
    expect(read).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });
});
