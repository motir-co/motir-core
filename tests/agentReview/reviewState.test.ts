import { describe, expect, it } from 'vitest';
import type { ApprovalGate } from '@/generated/prisma/client';
import {
  agentPasses,
  deriveReviewState,
  HOSTED_REVIEW_HARNESS,
  reviewCommand,
  type ReviewStateFacts,
  type ReviewStateGate,
  type ReviewStateRecord,
} from '@/lib/agentReview/reviewState';
import { deriveReviewState as reExported } from '@/lib/services/reviewStateService';

// THE PURE DERIVATION of the review state (Story MOTIR-10327 · MOTIR-10340) — pinned with no
// database. The read model's real-Postgres suite is `tests/approvalGates/reviewState.test.ts`.

const V1 = 'acme/app#1@aaa';
const V2 = 'acme/app#1@bbb';
const T0 = new Date('2026-11-05T10:00:00Z');
const T1 = new Date('2026-11-05T11:00:00Z');

function facts(overrides: Partial<ReviewStateFacts> = {}): ReviewStateFacts {
  return {
    identifier: 'ACME-7',
    finished: false,
    reviewAgentEnabled: true,
    reviewAgentSource: 'hosted',
    currentVersion: V1,
    members: [
      { repo: 'acme/app', number: 1, headSha: 'aaa', authorGithubUserId: '42', reviews: [] },
    ],
    agentGates: [],
    latestDecidedGate: null,
    records: [],
    dismissals: [],
    reviewRunInFlight: false,
    routedTo: { id: 'u1', name: 'Ada' },
    routedGithubUserId: '42',
    viewerUserId: 'u1',
    ...overrides,
  };
}

function gate(overrides: Partial<ReviewStateGate> = {}): ReviewStateGate {
  return {
    id: 'g1',
    kind: 'agent_review',
    state: 'awaiting',
    subjectVersion: V1,
    noteMd: null,
    decidedById: null,
    decidedByLabel: null,
    decidedUnderAuthority: null,
    decidedAt: null,
    reviewUnavailableReason: null,
    createdAt: T0,
    decidedByName: null,
    ...overrides,
  };
}

function record(overrides: Partial<ReviewStateRecord> = {}): ReviewStateRecord {
  return {
    id: 'r1',
    gateId: null,
    subjectVersion: V1,
    verdict: 'pass',
    outcome: 'recorded',
    findingsMd: null,
    submittedById: 'u2',
    harness: 'Claude Code',
    model: 'some-model',
    createdAt: T1,
    submittedByName: 'Bo',
    ...overrides,
  };
}

describe('deriveReviewState — the marker', () => {
  it('reads Agent reviewing only while a hosted run is in flight', () => {
    expect(
      deriveReviewState(facts({ agentGates: [gate()], reviewRunInFlight: true })).marker,
    ).toEqual({ kind: 'agent_reviewing' });
    expect(deriveReviewState(facts({ agentGates: [gate()] })).marker).toBeNull();
  });

  it('reads Review could not run with the reason, aimed at the routed person', () => {
    const state = deriveReviewState(
      facts({ agentGates: [gate({ reviewUnavailableReason: 'no_credits' })], viewerUserId: 'u9' }),
    );
    expect(state.marker).toEqual({
      kind: 'could_not_run',
      reason: 'no_credits',
      routedTo: { id: 'u1', name: 'Ada' },
      forViewer: false,
    });
  });

  it('reads Waiting for your review agent with the command for the source own', () => {
    const state = deriveReviewState(
      facts({ reviewAgentSource: 'own', agentGates: [gate({ reviewUnavailableReason: 'x' })] }),
    );
    expect(state.marker).toEqual({
      kind: 'waiting_for_own_agent',
      routedTo: { id: 'u1', name: 'Ada' },
      forViewer: true,
      command: 'motir review ACME-7',
    });
    expect(state.reviewToRun).toEqual({ gateId: 'g1', command: 'motir review ACME-7' });
  });

  it('reads no marker with the review agent off, no awaiting gate, or a gate at another version', () => {
    expect(
      deriveReviewState(
        facts({ reviewAgentEnabled: false, agentGates: [gate()], reviewRunInFlight: true }),
      ).marker,
    ).toBeNull();
    expect(deriveReviewState(facts()).marker).toBeNull();
    expect(
      deriveReviewState(
        facts({ agentGates: [gate({ subjectVersion: V2 })], reviewRunInFlight: true }),
      ).marker,
    ).toBeNull();
    expect(
      deriveReviewState(facts({ currentVersion: null, agentGates: [gate()] })).marker,
    ).toBeNull();
  });
});

describe('deriveReviewState — Reviewed and the review line', () => {
  it('reads Reviewed for an own-agent pass at the current version, with the commits', () => {
    const state = deriveReviewState(facts({ records: [record()] }));
    expect(state.reviewed).toEqual({
      reviewer: {
        kind: 'own',
        person: { id: 'u2', name: 'Bo' },
        harness: 'Claude Code',
        model: 'some-model',
      },
      at: T1,
      commits: [{ repo: 'acme/app', number: 1, headSha: 'aaa' }],
    });
    expect(state.recordRef).toEqual({ kind: 'record', id: 'r1' });
    expect(state.reviewLine?.value).toBe('reviewed_by_agent');
  });

  it('names the hosted agent for a hosted record, and for a gate decided with no record', () => {
    const hosted = deriveReviewState(
      facts({
        records: [record({ harness: HOSTED_REVIEW_HARNESS, model: 'unknown', outcome: 'decided' })],
      }),
    );
    expect(hosted.reviewed?.reviewer).toEqual({ kind: 'hosted', model: null });
    const legacy = deriveReviewState(
      facts({
        agentGates: [
          gate({ state: 'approved', decidedUnderAuthority: 'review_agent', decidedAt: T1 }),
        ],
      }),
    );
    expect(legacy.reviewed?.reviewer).toEqual({ kind: 'hosted', model: null });
    expect(legacy.recordRef).toEqual({ kind: 'gate', id: 'g1' });
    // A gate covered by a record is the record's pass, not a second one.
    expect(
      agentPasses({
        records: [record({ gateId: 'g1', outcome: 'decided' })],
        agentGates: [gate({ state: 'approved', decidedUnderAuthority: 'review_agent' })],
      }),
    ).toHaveLength(1);
  });

  it('drops Reviewed after a head move and on a Done card, and never counts a late or second verdict', () => {
    const moved = deriveReviewState(facts({ currentVersion: V2, records: [record()] }));
    expect(moved.reviewed).toBeNull();
    expect(moved.reviewLine).toMatchObject({
      value: 'not_reviewed',
      lastReviewedVersion: V1,
      command: 'motir review ACME-7',
    });
    expect(deriveReviewState(facts({ finished: true, records: [record()] })).reviewed).toBeNull();
    expect(
      deriveReviewState(
        facts({ records: [record({ outcome: 'late' }), record({ id: 'r2', outcome: 'second' })] }),
      ).reviewed,
    ).toBeNull();
  });

  it('reads Review dismissed with the person and reason, only at the dismissed version', () => {
    const dismissal = {
      id: 'd1',
      subjectVersion: V1,
      reasonMd: 'flaky finding',
      dismissedById: 'u1',
      createdAt: T1,
      dismissedByName: 'Ada',
    };
    const sendBack = record({ verdict: 'changes_requested' });
    const at = deriveReviewState(facts({ records: [sendBack], dismissals: [dismissal] }));
    expect(at.reviewLine).toMatchObject({
      value: 'review_dismissed',
      actor: { id: 'u1', name: 'Ada' },
      reason: 'flaky finding',
    });
    expect(at.sentBack).toBe(false);
    const later = deriveReviewState(
      facts({ currentVersion: V2, records: [sendBack], dismissals: [dismissal] }),
    );
    expect(later.reviewLine?.value).toBe('not_reviewed');
    expect(deriveReviewState(facts({ records: [sendBack] })).sentBack).toBe(true);
  });

  it('reads Review skipped for a person continuing without the review', () => {
    const skipped = gate({
      state: 'approved',
      decidedUnderAuthority: 'assignee',
      decidedById: 'u1',
      decidedByLabel: 'Ada <ada@example.com>',
      noteMd: 'urgent fix',
      decidedAt: T1,
    });
    expect(deriveReviewState(facts({ agentGates: [skipped] })).reviewLine).toMatchObject({
      value: 'review_skipped',
      actor: { id: 'u1', name: 'Ada' },
      reason: 'urgent fix',
    });
    // The live name wins over the audit label.
    expect(
      deriveReviewState(facts({ agentGates: [{ ...skipped, decidedByName: 'Ada L.' }] })).reviewLine
        ?.actor,
    ).toEqual({ id: 'u1', name: 'Ada L.' });
    expect(
      deriveReviewState(facts({ agentGates: [{ ...skipped, decidedById: null }] })).reviewLine
        ?.actor,
    ).toBeNull();
  });

  it('reads a decided gate-on send-back as standing through the shared predicate', () => {
    const decided = gate({
      state: 'changes_requested',
      decidedUnderAuthority: 'review_agent',
      decidedAt: T1,
    });
    const state = deriveReviewState(
      facts({ agentGates: [decided], latestDecidedGate: decided as unknown as ApprovalGate }),
    );
    expect(state.sentBack).toBe(true);
    expect(state.reviewLine?.value).toBe('not_reviewed');
    expect(state.reviewLine?.lastReviewedVersion).toBeNull();
  });

  it('lists the countable GitHub approvals at each head', () => {
    const review = (over: Record<string, unknown>) => ({
      githubReviewId: 'x',
      reviewerGithubUserId: '7',
      reviewerLogin: 'cy',
      state: 'approved' as const,
      commitSha: 'aaa',
      reviewerPermission: 'write' as const,
      submittedAt: T0,
      ...over,
    });
    const state = deriveReviewState(
      facts({
        members: [
          {
            repo: 'acme/app',
            number: 1,
            headSha: 'aaa',
            authorGithubUserId: '42',
            reviews: [
              review({}),
              review({
                githubReviewId: 'y',
                reviewerGithubUserId: '8',
                reviewerLogin: 'old',
                commitSha: 'zzz',
              }),
              review({
                githubReviewId: 'z',
                reviewerGithubUserId: '9',
                reviewerLogin: 'ro',
                reviewerPermission: 'read',
              }),
            ],
          },
        ],
      }),
    );
    expect(state.reviewLine?.githubApprovals).toEqual([
      { login: 'cy', repo: 'acme/app', number: 1 },
    ]);
  });

  it('has no review line without a current version', () => {
    expect(deriveReviewState(facts({ currentVersion: null })).reviewLine).toBeNull();
  });
});

describe('deriveReviewState — the author fact', () => {
  const member = (author: string | null, n = 1) => ({
    repo: 'acme/app',
    number: n,
    headSha: 'aaa',
    authorGithubUserId: author,
    reviews: [],
  });

  it('is true only when the routed person authored every pull request', () => {
    expect(
      deriveReviewState(facts({ members: [member('42'), member('42', 2)] })).authorOfEveryPr,
    ).toBe(true);
    expect(
      deriveReviewState(facts({ members: [member('42'), member('43', 2)] })).authorOfEveryPr,
    ).toBe(false);
    expect(deriveReviewState(facts({ members: [member('43')] })).authorOfEveryPr).toBe(false);
    expect(deriveReviewState(facts({ members: [member(null)] })).authorOfEveryPr).toBe(false);
    expect(deriveReviewState(facts({ members: [] })).authorOfEveryPr).toBe(false);
    expect(deriveReviewState(facts({ routedGithubUserId: null })).authorOfEveryPr).toBe(false);
  });

  it('knows whether the reader is the routed person', () => {
    expect(deriveReviewState(facts()).viewerIsRouted).toBe(true);
    expect(deriveReviewState(facts({ viewerUserId: 'u9' })).viewerIsRouted).toBe(false);
    expect(deriveReviewState(facts({ routedTo: null })).viewerIsRouted).toBe(false);
  });
});

describe('the command', () => {
  it('spells the command, and the service re-exports the derivation', () => {
    expect(reviewCommand('ACME-1')).toBe('motir review ACME-1');
    expect(reExported).toBe(deriveReviewState);
  });
});
