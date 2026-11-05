import { describe, expect, it } from 'vitest';
import {
  agentReviewStanding,
  resolveGateSet,
  type ExistingGate,
  type GateSetInput,
} from '@/lib/approvalGates/gateSet';

// THE REVIEW AGENT IN THE GATE-SET PREDICATE (Story MOTIR-1626 · MOTIR-6819;
// `approval-gates.md` §12.2, §12.2a, §12.5) — card STATES, asked of the pure rule, so the
// answer holds whichever raiser asks it (the promotion, a status move, the reconcile tick,
// a queue exit, a withdrawal's re-raise). The database-backed seams are
// `agentReviewGate.test.ts`'s.

const WORK_ITEM = 'wi_1';
const V1 = 'moooon/motir-core#10@aaa1';
const V2 = 'moooon/motir-core#10@bbb2';

const input = (over: Partial<GateSetInput> = {}): GateSetInput => ({
  currentDesignEvidence: null,
  latestDesignGate: null,
  currentReceipt: null,
  latestAcceptanceGate: null,
  latestMergeGate: null,
  members: [{ memberVersion: V1, isMergeCandidate: true }],
  prMergeMode: 'manual',
  cardIsTerminal: false,
  cardInReview: true,
  primaryApprovalStandsForMerge: false,
  workItemId: WORK_ITEM,
  reviewAgentEnabled: true,
  latestAgentReviewGate: null,
  ...over,
});

const gate = (
  state: ExistingGate['state'],
  subjectVersion: string | null,
  subjectId = WORK_ITEM,
): ExistingGate => ({ state, subjectId, subjectVersion });

const kinds = (over: Partial<GateSetInput> = {}) =>
  resolveGateSet(input(over)).awaited.map((owed) => [owed.kind, owed.subjectVersion]);

describe('resolveGateSet — the review stands in front of the merge question', () => {
  it('a green set with the switch on asks the REVIEW at the set version, and not the merge', () => {
    expect(kinds()).toEqual([['agent_review', V1]]);
  });

  it('with the switch OFF the answer is exactly what it was — the merge question', () => {
    expect(kinds({ reviewAgentEnabled: false })).toEqual([['pull_request_approval', V1]]);
    // Absent reads as off, so a caller that does not load it is unchanged.
    const { reviewAgentEnabled: _omitted, ...without } = input();
    void _omitted;
    expect(resolveGateSet(without).awaited.map((g) => g.kind)).toEqual(['pull_request_approval']);
  });

  it('a legacy row with the switch on in an AUTO project reads as off — nothing is asked', () => {
    expect(kinds({ prMergeMode: 'auto' })).toEqual([]);
  });

  it('a red or unnamed set asks no review', () => {
    expect(kinds({ members: [{ memberVersion: V1, isMergeCandidate: false }] })).toEqual([]);
    expect(kinds({ members: [{ memberVersion: null, isMergeCandidate: true }] })).toEqual([]);
  });

  it('a PASS at this version asks the merge question for the SAME version', () => {
    expect(kinds({ latestAgentReviewGate: gate('approved', V1) })).toEqual([
      ['pull_request_approval', V1],
    ]);
  });

  it('a REFUSAL at this version asks nothing more — one review per version', () => {
    expect(kinds({ latestAgentReviewGate: gate('changes_requested', V1) })).toEqual([]);
  });

  it('a review WITHDRAWN at this version is asked again', () => {
    expect(kinds({ latestAgentReviewGate: gate('superseded', V1) })).toEqual([
      ['agent_review', V1],
    ]);
  });

  it('a decision about an OLDER version asks a fresh review of the new one', () => {
    expect(kinds({ latestAgentReviewGate: gate('approved', V2) })).toEqual([['agent_review', V1]]);
    expect(kinds({ latestAgentReviewGate: gate('changes_requested', V2) })).toEqual([
      ['agent_review', V1],
    ]);
  });

  it('switching ON asks nothing of an AWAITING merge question — it stays asked (§12.5)', () => {
    expect(kinds({ latestMergeGate: gate('awaiting', V1) })).toEqual([
      ['pull_request_approval', V1],
    ]);
  });

  it('a merge decided at this version is not reviewed after the fact', () => {
    expect(kinds({ latestMergeGate: gate('approved', V1) })).toEqual([]);
  });

  it('a merge gate WITHDRAWN at this version does not exempt it — the next green is reviewed', () => {
    expect(kinds({ latestMergeGate: gate('superseded', V1) })).toEqual([['agent_review', V1]]);
  });

  it('a primary question is not delayed — the design is still asked beside the review', () => {
    const set = resolveGateSet(
      input({ currentDesignEvidence: { id: 'ev_1', commitSha: 'c0ffee' } }),
    );
    expect(set.awaited.map((g) => g.kind)).toEqual(['design_result', 'agent_review']);
    expect(set.primary).toBe('design_result');
  });

  it('a primary’s carried merge asks the REVIEW while it has not passed, and nothing once it has', () => {
    expect(kinds({ primaryApprovalStandsForMerge: true })).toEqual([['agent_review', V1]]);
    expect(
      kinds({ primaryApprovalStandsForMerge: true, latestAgentReviewGate: gate('approved', V1) }),
    ).toEqual([]);
  });
});

describe('agentReviewStanding — the one statement the gate set and the carry share', () => {
  const standing = (over: Partial<Parameters<typeof agentReviewStanding>[0]> = {}) =>
    agentReviewStanding({
      reviewAgentEnabled: true,
      prMergeMode: 'manual',
      workItemId: WORK_ITEM,
      version: V1,
      latestAgentReviewGate: null,
      latestMergeGate: null,
      ...over,
    });

  it('names each standing', () => {
    expect(standing()).toBe('owed');
    expect(standing({ latestAgentReviewGate: gate('awaiting', V1) })).toBe('owed');
    expect(standing({ latestAgentReviewGate: gate('approved', V1) })).toBe('passed');
    expect(standing({ latestAgentReviewGate: gate('changes_requested', V1) })).toBe('refused');
    expect(standing({ reviewAgentEnabled: false })).toBe('not_required');
    expect(standing({ prMergeMode: 'auto' })).toBe('not_required');
    expect(standing({ version: null })).toBe('not_required');
    expect(standing({ latestMergeGate: gate('changes_requested', V1) })).toBe('not_required');
  });

  it('a review of ANOTHER card never counts', () => {
    expect(standing({ latestAgentReviewGate: gate('approved', V1, 'wi_other') })).toBe('owed');
  });
});

describe('resolveGateSet — MOTIR-6971: the review is asked only at `in_review`, like the merge it stands in front of', () => {
  it('asks NEITHER the review nor the merge of a green set on a card that is not in review', () => {
    expect(resolveGateSet(input({ cardInReview: false }))).toEqual({ awaited: [], primary: null });
  });
});

describe('resolveGateSet — an agent SEND-BACK and its DISMISSAL (MOTIR-10333 · MOTIR-10334; §12.14–§12.15)', () => {
  it('a gate-off send-back at the current version asks nothing — neither review nor merge', () => {
    expect(kinds({ reviewAgentEnabled: false, agentSendBackVersion: V1 })).toEqual([]);
    expect(kinds({ agentSendBackVersion: V1 })).toEqual([]);
  });

  it('a send-back about an OLDER version stands no more — a push ended it', () => {
    expect(kinds({ reviewAgentEnabled: false, agentSendBackVersion: V2 })).toEqual([
      ['pull_request_approval', V1],
    ]);
  });

  it('a dismissal at the current version asks the merge again at the SAME version', () => {
    expect(
      kinds({
        reviewAgentEnabled: false,
        agentSendBackVersion: V1,
        dismissedSendBackVersion: V1,
      }),
    ).toEqual([['pull_request_approval', V1]]);
    // Gate on: the refused review reads as answered, and no second review is asked.
    expect(
      kinds({ latestAgentReviewGate: gate('changes_requested', V1), dismissedSendBackVersion: V1 }),
    ).toEqual([['pull_request_approval', V1]]);
  });

  it('a dismissal at ANOTHER version never suppresses a send-back', () => {
    expect(
      kinds({
        reviewAgentEnabled: false,
        agentSendBackVersion: V1,
        dismissedSendBackVersion: V2,
      }),
    ).toEqual([]);
    expect(
      kinds({ latestAgentReviewGate: gate('changes_requested', V1), dismissedSendBackVersion: V2 }),
    ).toEqual([]);
  });

  it('agentReviewStanding reads a dismissed refusal as passed, and only at its version', () => {
    const at = (dismissedVersion: string | null) =>
      agentReviewStanding({
        reviewAgentEnabled: true,
        prMergeMode: 'manual',
        workItemId: WORK_ITEM,
        version: V1,
        latestAgentReviewGate: gate('changes_requested', V1),
        latestMergeGate: null,
        dismissedVersion,
      });
    expect(at(V1)).toBe('passed');
    expect(at(V2)).toBe('refused');
    expect(at(null)).toBe('refused');
  });
});
