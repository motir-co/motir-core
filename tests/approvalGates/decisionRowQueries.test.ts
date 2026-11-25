import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { decisionPagePublicationRepository } from '@/lib/repositories/decisionPagePublicationRepository';

// THE PENDING-APPROVALS READ with a DECISION row present (Story MOTIR-4907 · Subtask
// MOTIR-5679). The row's subject is summarised from the capture on the card's pull
// requests — the delivery read the approve-and-merge row already makes — so a decision
// row joining the queue costs no extra query, however many decision rows there are, and
// never a host call. A published PAGE wins the subject (Story MOTIR-5761 · MOTIR-7436), and
// it is read the same way — once for every decision row on the page, never per row.

const tx = {} as Prisma.TransactionClient;

function delivery(workItemId: string, number: number): WorkItemDeliveryWithChecks {
  return {
    workItemId,
    repo: { owner: 'acme', name: 'web' },
    pullRequest: {
      number,
      state: 'open',
      merged: false,
      mergeOutcomeRef: null,
      checkRuns: [],
      decisionDocOutcome: 'one',
      decisionDocPath: `docs/decisions/d-${number}.md`,
      decisionDocBlobSha: `blob-${number}`,
      decisionDocHeadSha: `head-${number}`,
      decisionDocPaths: [`docs/decisions/d-${number}.md`],
    },
  } as unknown as WorkItemDeliveryWithChecks;
}

afterEach(() => vi.restoreAllMocks());

function spyPublications() {
  return vi
    .spyOn(decisionPagePublicationRepository, 'latestForWorkItems')
    .mockImplementation(async () => []);
}

function spyDeliveries() {
  return vi
    .spyOn(workItemDeliveryRepository, 'listByWorkItemsWithChecks')
    .mockImplementation(async (ids) => [...ids].map((id, i) => delivery(id, i + 1)));
}

const prGate = { id: 'g-pr', kind: 'pull_request_approval' as const, subjectId: 'wi-pr' };
const decisionGate = (n: number) => ({
  id: `g-dec-${n}`,
  kind: 'decision_approval' as const,
  subjectId: `wi-dec-${n}`,
});

describe('the pending-approvals read with a decision row', () => {
  it('issues the SAME number of queries with a decision row present as without', async () => {
    const without = spyDeliveries();
    await summarizeGateSubjects([prGate], tx);
    const queriesWithout = without.mock.calls.length;
    vi.restoreAllMocks();

    const withDecision = spyDeliveries();
    spyPublications();
    const out = await summarizeGateSubjects([prGate, decisionGate(1)], tx);
    expect(withDecision.mock.calls.length).toBe(queriesWithout);
    // …and both rows are answered by that one read.
    expect(out.get('g-pr')).toMatchObject({ kind: 'pull_request_approval' });
    expect(out.get('g-dec-1')).toMatchObject({
      kind: 'decision_approval',
      outcome: 'one',
      title: 'D 2',
      documentCount: 1,
    });
  });

  it('never reads per row — one decision gate or five cost the same', async () => {
    const one = spyDeliveries();
    const pagesForOne = spyPublications();
    await summarizeGateSubjects([decisionGate(1)], tx);
    const forOne = one.mock.calls.length;
    expect(pagesForOne).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();

    const five = spyDeliveries();
    const pagesForFive = spyPublications();
    await summarizeGateSubjects([1, 2, 3, 4, 5].map(decisionGate), tx);
    expect(five.mock.calls.length).toBe(forOne);
    expect(forOne).toBe(1);
    expect(pagesForFive).toHaveBeenCalledTimes(1);
  });
});
