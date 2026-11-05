import { describe, expect, it } from 'vitest';
import type { ApprovalGate } from '@/generated/prisma/client';
import { standingReviewRefusalFrom } from '@/lib/approvalGates/reviewRefusal';

// THE TWO SOURCES OF A STANDING REVIEW REFUSAL (Story MOTIR-10327 · MOTIR-10333, MOTIR-10334;
// `approval-gates.md` §12.14–§12.15), over rows already read: a DECIDED gate at the current
// version, and a GATE-OFF agent send-back record at it. When both stand the later one is the
// card's latest word, and a dismissal at the version removes the AGENT's refusal from both
// sources but never a person's own Request changes.

const V = 'acme/web#1@aaaa';

function gate(over: Partial<ApprovalGate>): ApprovalGate {
  return {
    id: 'g1',
    kind: 'pull_request_approval',
    state: 'changes_requested',
    subjectVersion: V,
    noteMd: 'Fix the header',
    decidedById: 'u-person',
    decidedByLabel: 'Pat <pat@example.com>',
    decidedUnderAuthority: 'assignee',
    decidedAt: new Date('2026-11-05T10:00:00Z'),
    ...over,
  } as ApprovalGate;
}

const record = (createdAt: string) => ({
  id: 'r1',
  subjectVersion: V,
  findingsMd: 'The totals row is wrong',
  submittedById: 'u-owner',
  createdAt: new Date(createdAt),
});

describe('standingReviewRefusalFrom', () => {
  it('a gate-off send-back newer than the decided gate is the latest word', () => {
    const out = standingReviewRefusalFrom({
      latest: gate({}),
      record: record('2026-11-05T11:00:00Z'),
      dismissed: false,
      currentVersion: V,
    });
    expect(out).toMatchObject({ id: null, recordId: 'r1', kind: 'agent_review' });
  });

  it('a decided gate newer than the gate-off send-back is the latest word', () => {
    const out = standingReviewRefusalFrom({
      latest: gate({ decidedAt: new Date('2026-11-05T12:00:00Z') }),
      record: record('2026-11-05T11:00:00Z'),
      dismissed: false,
      currentVersion: V,
    });
    expect(out).toMatchObject({ id: 'g1', recordId: null, kind: 'pull_request_approval' });
  });

  it('a dismissal removes the agent’s refusal from both sources, never a person’s', () => {
    expect(
      standingReviewRefusalFrom({
        latest: gate({ kind: 'agent_review' }),
        record: record('2026-11-05T11:00:00Z'),
        dismissed: true,
        currentVersion: V,
      }),
    ).toBeNull();
    expect(
      standingReviewRefusalFrom({
        latest: gate({}),
        record: record('2026-11-05T11:00:00Z'),
        dismissed: true,
        currentVersion: V,
      }),
    ).toMatchObject({ id: 'g1', kind: 'pull_request_approval' });
  });

  it('nothing stands on an unknown version or with no rows', () => {
    expect(
      standingReviewRefusalFrom({
        latest: gate({}),
        record: null,
        dismissed: false,
        currentVersion: null,
      }),
    ).toBeNull();
    expect(
      standingReviewRefusalFrom({
        latest: null,
        record: null,
        dismissed: false,
        currentVersion: V,
      }),
    ).toBeNull();
  });
});
