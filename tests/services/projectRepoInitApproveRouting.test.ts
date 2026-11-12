import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approvedPlanCreatedInitCard,
  committedBlockerIds,
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

// Bug MOTIR-11093 — the gate's second arm: the committed cards a plan made something
// wait on, by either carrier. Whether one IS an init card is the read's, not this.
describe('committedBlockerIds', () => {
  it("collects an add's real blocker ids and a modify's blockedByAdd, deduped and sorted", () => {
    expect(
      committedBlockerIds([
        { op: 'add', proposedFields: {}, blockedByRefs: ['w3', 'w1'] },
        { op: 'modify', proposedFields: null, patch: { blockedByAdd: ['w2', 'w1'] } },
      ]),
    ).toEqual(['w1', 'w2', 'w3']);
  });

  it('skips a temp-ref: it names an add in the same plan, which the first arm answers', () => {
    expect(
      committedBlockerIds([
        { op: 'add', proposedFields: {}, blockedByRefs: ['planItem:abc', 'w1'] },
        { op: 'modify', proposedFields: null, patch: { blockedByAdd: ['planItem:def'] } },
      ]),
    ).toEqual(['w1']);
  });

  it('reads no blocker from a remove, a modify without blockedByAdd, or a malformed patch', () => {
    expect(
      committedBlockerIds([
        { op: 'remove', proposedFields: null, blockedByRefs: ['w1'] },
        { op: 'modify', proposedFields: null, patch: { blockedByRemove: ['w2'] } },
        { op: 'modify', proposedFields: null, patch: { blockedByAdd: 'w3' } },
        { op: 'modify', proposedFields: null, patch: { blockedByAdd: [42, null] } },
        { op: 'modify', proposedFields: null, patch: null },
        { op: 'modify', proposedFields: null },
        { op: 'add', proposedFields: {} },
      ]),
    ).toEqual([]);
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
