import { describe, expect, it } from 'vitest';
import {
  decisionApprovalStandsForMerge,
  resolveGateSet,
  type ExistingGate,
  type GateSetInput,
} from '@/lib/approvalGates/gateSet';
import type { DecisionIdentity } from '@/lib/approvalGates/decisionSubject';

// THE GATE SET ASKS THE DECISION QUESTION (Story MOTIR-4907 · Subtask MOTIR-5677;
// `approval-gates.md` §8's FIFTH AMENDMENT, clauses 3–5). Pure — no fixtures. The rule
// under test is that a decision card holds the design card's arrangement: the decision
// PRIMARY, the merge beneath it, one carry, and an answer that outlives a push that did
// not touch the document.

const CARD = 'card-1';
const GREEN = [{ memberVersion: 'acme/web#1@head-1', isMergeCandidate: true }];
const ONE: DecisionIdentity = {
  resolvable: true,
  repo: 'acme/web',
  number: 1,
  path: 'docs/decisions/pages.md',
  blobSha: 'blob-1',
  headSha: 'head-1',
};
const V1 = 'acme/web:docs/decisions/pages.md@blob-1';
const gate = (state: ExistingGate['state'], subjectVersion: string | null = V1): ExistingGate => ({
  state,
  subjectId: CARD,
  subjectVersion,
});

function input(over: Partial<GateSetInput> = {}): GateSetInput {
  return {
    currentDesignEvidence: null,
    latestDesignGate: null,
    latestMergeGate: null,
    members: GREEN,
    prMergeMode: 'manual',
    cardIsTerminal: false,
    cardInReview: true,
    // RENAMED BY MOTIR-5789: the boolean covers the design's standing approval AND a
    // story's acceptance, because both are evidence-carried primaries the loader reads.
    // The DECISION's own carry is still derived inside the predicate from `decision`.
    primaryApprovalStandsForMerge: false,
    currentReceipt: null,
    latestAcceptanceGate: null,
    workItemId: CARD,
    decision: { identity: ONE, latestGate: null },
    ...over,
  };
}

describe('resolveGateSet — the decision question', () => {
  it('a green decision card in `manual` holds TWO gates, the decision PRIMARY', () => {
    expect(resolveGateSet(input())).toEqual({
      awaited: [
        { kind: 'decision_approval', subjectId: CARD, subjectVersion: V1 },
        { kind: 'pull_request_approval', subjectId: CARD, subjectVersion: 'acme/web#1@head-1' },
      ],
      primary: 'decision_approval',
      primariesHeldByReview: false,
    });
  });

  it('the decision is asked before CI has spoken — it does not wait for green', () => {
    const set = resolveGateSet(
      input({ members: [{ memberVersion: 'acme/web#1@head-1', isMergeCandidate: false }] }),
    );
    expect(set.awaited.map((g) => g.kind)).toEqual(['decision_approval']);
    expect(set.primary).toBe('decision_approval');
  });

  it('an UNRESOLVABLE document is still asked — a gate that cannot be approved', () => {
    const unresolvable: DecisionIdentity = {
      resolvable: false,
      reason: 'several',
      repo: 'acme/web',
      number: 1,
      headSha: 'head-1',
      paths: [],
    };
    expect(
      resolveGateSet(input({ decision: { identity: unresolvable, latestGate: null } })).awaited[0],
    ).toEqual({
      kind: 'decision_approval',
      subjectId: CARD,
      subjectVersion: 'acme/web:unresolvable:several@head-1',
    });
  });

  it('nothing captured yet asks nothing about the decision', () => {
    const set = resolveGateSet(input({ decision: { identity: null, latestGate: null } }));
    expect(set.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('a card WITHOUT the decision input answers exactly as it did before the kind existed', () => {
    const { decision: _dropped, ...rest } = input();
    expect(resolveGateSet(rest)).toEqual({
      awaited: [
        { kind: 'pull_request_approval', subjectId: CARD, subjectVersion: 'acme/web#1@head-1' },
      ],
      primary: 'pull_request_approval',
      primariesHeldByReview: false,
    });
  });

  it('a decision APPROVED over the current document is an answer, and carries the merge ONCE', () => {
    const carried = resolveGateSet(
      input({ decision: { identity: ONE, latestGate: gate('approved') } }),
    );
    expect(carried).toEqual({ awaited: [], primary: null, primariesHeldByReview: false });

    // …only while the card has had no merge gate at all (MOTIR-5666's clause).
    const later = resolveGateSet(
      input({
        decision: { identity: ONE, latestGate: gate('approved') },
        latestMergeGate: gate('approved', 'acme/web#1@head-0'),
      }),
    );
    expect(later.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('a decision sent back over the SAME document is not asked again until a push changes it', () => {
    const set = resolveGateSet(
      input({ decision: { identity: ONE, latestGate: gate('changes_requested') } }),
    );
    expect(set.awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('an approval of an OLD document neither answers the new one nor carries the merge', () => {
    const set = resolveGateSet(
      input({
        decision: {
          identity: { ...ONE, blobSha: 'blob-2' },
          latestGate: gate('approved'),
        },
      }),
    );
    expect(set.awaited).toEqual([
      {
        kind: 'decision_approval',
        subjectId: CARD,
        subjectVersion: 'acme/web:docs/decisions/pages.md@blob-2',
      },
      { kind: 'pull_request_approval', subjectId: CARD, subjectVersion: 'acme/web#1@head-1' },
    ]);
  });

  it('a push that left the document alone keeps the answer — the version is the BLOB', () => {
    const set = resolveGateSet(
      input({
        decision: { identity: { ...ONE, headSha: 'head-2' }, latestGate: gate('approved') },
        members: [{ memberVersion: 'acme/web#1@head-2', isMergeCandidate: true }],
      }),
    );
    expect(set.awaited).toEqual([]);
  });

  it('a terminal card asks nothing, decision included', () => {
    expect(resolveGateSet(input({ cardIsTerminal: true }))).toEqual({
      awaited: [],
      primary: null,
      primariesHeldByReview: false,
    });
  });
});

describe('decisionApprovalStandsForMerge', () => {
  it('only an APPROVAL over the CURRENT resolvable document stands', () => {
    expect(decisionApprovalStandsForMerge(ONE, gate('approved'))).toBe(true);
    expect(decisionApprovalStandsForMerge(ONE, gate('awaiting'))).toBe(false);
    expect(decisionApprovalStandsForMerge(ONE, gate('changes_requested'))).toBe(false);
    expect(decisionApprovalStandsForMerge(ONE, gate('approved', 'something-else'))).toBe(false);
    expect(decisionApprovalStandsForMerge(ONE, null)).toBe(false);
    expect(decisionApprovalStandsForMerge(null, gate('approved'))).toBe(false);
    expect(
      decisionApprovalStandsForMerge(
        {
          resolvable: false,
          reason: 'none',
          repo: 'acme/web',
          number: 1,
          headSha: null,
          paths: [],
        },
        gate('approved', 'acme/web:unresolvable:none@unknown'),
      ),
    ).toBe(false);
  });
});
