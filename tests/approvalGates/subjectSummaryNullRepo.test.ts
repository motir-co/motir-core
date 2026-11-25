import { describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { summarizeGateSubjects } from '@/lib/approvalGates/subjectSummary';

// MOTIR-8213 — a delivery whose `repo` include reads back null (the repository is hidden
// from the reader's RLS context) used to throw `Cannot read properties of null (reading
// 'owner')` and fail the whole workbench approvals tab.

function pr(number: number) {
  return {
    number,
    state: 'open',
    merged: false,
    mergeOutcomeRef: null,
    headSha: 'abc',
    checkRuns: [],
  };
}

function delivery(
  workItemId: string,
  number: number,
  repo: { owner: string; name: string } | null,
) {
  return { workItemId, repo, pullRequest: pr(number), createdAt: new Date(0) };
}

function fakeTx(rows: unknown[]): Prisma.TransactionClient {
  return {
    workItemDelivery: { findMany: async () => rows },
  } as unknown as Prisma.TransactionClient;
}

describe('summarizeGateSubjects — pull_request_approval with an unreadable repository', () => {
  it('does not throw and drops the unreadable member', async () => {
    const tx = fakeTx([
      delivery('wi-1', 1, null),
      delivery('wi-1', 2, { owner: 'acme', name: 'web' }),
    ]);
    const out = await summarizeGateSubjects(
      [{ id: 'g1', kind: 'pull_request_approval', subjectId: 'wi-1' }],
      tx,
    );
    const summary = out.get('g1');
    expect(summary).toMatchObject({ kind: 'pull_request_approval' });
    const members = (summary as { members: { repo: string; number: number }[] }).members;
    expect(members.map((m) => `${m.repo}#${m.number}`)).toEqual(['acme/web#2']);
  });

  it('resolves to null when every member is unreadable', async () => {
    const tx = fakeTx([delivery('wi-1', 1, null)]);
    const out = await summarizeGateSubjects(
      [{ id: 'g1', kind: 'pull_request_approval', subjectId: 'wi-1' }],
      tx,
    );
    expect(out.get('g1')).toBeNull();
  });
});
