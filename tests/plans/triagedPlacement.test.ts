import { describe, expect, it } from 'vitest';
import {
  assertNoTriagedPlacement,
  validatePlanProposals,
  type LiveWorkItemState,
  type ProposalNode,
} from '@/lib/plans/validateProposals';
import { PlanGrammarError, PLAN_GRAMMAR_VIOLATIONS } from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';

// Bug MOTIR-11339 — the plan gate's TRIAGE step, as pure logic. A card still in
// Triage is outside the planned tree, so a plan may neither `modify` it nor place
// an item under it. `tests/integration/triage/triagePlacementGuard.test.ts` proves
// the append, `validate_plan` and approve doors against real Postgres; this file
// pins the verdict itself.

const PROJECT = 'proj_plan';
const TRIAGED = 'wi_triaged';
const PLANNED = 'wi_planned';

function live(id: string, overrides: Partial<LiveWorkItemState> = {}): LiveWorkItemState {
  return {
    id,
    key: `MOTIR-${id}`,
    title: `The ${id} card`,
    kind: 'story',
    status: 'todo',
    projectId: PROJECT,
    ...overrides,
  };
}

const LIVE = new Map<string, LiveWorkItemState>([
  [TRIAGED, live(TRIAGED, { triaged: true })],
  [PLANNED, live(PLANNED, { triaged: false })],
]);

function node(id: string, overrides: Partial<ProposalNode>): ProposalNode {
  return {
    id,
    op: 'add',
    workItemId: null,
    parentRef: null,
    blockedByRefs: [],
    proposedFields: { kind: 'subtask', title: 'A child' },
    patch: null,
    ...overrides,
  };
}

function refusal(fn: () => void): PlanGrammarError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PlanGrammarError);
    return err as PlanGrammarError;
  }
  throw new Error('expected the gate to refuse');
}

describe('assertNoTriagedPlacement', () => {
  it('refuses a modify of a card still in triage, naming the card and the remedy', () => {
    const err = refusal(() =>
      assertNoTriagedPlacement(
        [node('pi_m', { op: 'modify', workItemId: TRIAGED, proposedFields: null, patch: {} })],
        LIVE,
      ),
    );
    expect(err.reason).toBe('target_in_triage');
    expect(err.planItemId).toBe('pi_m');
    expect(err.message).toContain(`MOTIR-${TRIAGED}`);
    expect(err.message).toContain('accept it in Triage first');
  });

  it('refuses an add whose parentRef is a card still in triage', () => {
    const err = refusal(() =>
      assertNoTriagedPlacement([node('pi_a', { parentRef: TRIAGED })], LIVE),
    );
    expect(err.reason).toBe('target_in_triage');
    expect(err.message).toContain('parentRef');
    expect(err.message).toContain(`accept MOTIR-${TRIAGED} in Triage first`);
  });

  it('refuses a modify that re-parents a planned card under a card still in triage', () => {
    const err = refusal(() =>
      assertNoTriagedPlacement(
        [
          node('pi_r', {
            op: 'modify',
            workItemId: PLANNED,
            proposedFields: null,
            patch: { parentRef: TRIAGED },
          }),
        ],
        LIVE,
      ),
    );
    expect(err.reason).toBe('target_in_triage');
    expect(err.message).toContain('patch.parentRef');
  });

  it('admits the same proposals once nothing they name is in triage', () => {
    expect(() =>
      assertNoTriagedPlacement(
        [
          node('pi_m', { op: 'modify', workItemId: PLANNED, proposedFields: null, patch: {} }),
          node('pi_a', { parentRef: PLANNED }),
        ],
        LIVE,
      ),
    ).not.toThrow();
  });

  it('admits a remove, a temp-ref or folder parent, a root add, and an unresolved ref', () => {
    expect(() =>
      assertNoTriagedPlacement(
        [
          // A remove places nothing.
          node('pi_x', { op: 'remove', workItemId: TRIAGED, proposedFields: null }),
          // Neither a proposal nor a folder is a triaged card.
          node('pi_t', {
            parentRef: `${TEMP_REF_PREFIX}pi_root`,
            proposedFields: { kind: 'task' },
          }),
          node('pi_f', { parentRef: 'folder:fold_1' }),
          node('pi_root', { proposedFields: { kind: 'story' } }),
          // A ref the live read did not return is the resolution step's to name.
          node('pi_d', { parentRef: 'wi_missing' }),
          // A modify that clears its parent re-parents under nothing.
          node('pi_c', {
            op: 'modify',
            workItemId: PLANNED,
            proposedFields: null,
            patch: { parentRef: null },
          }),
        ],
        LIVE,
      ),
    ).not.toThrow();
  });

  it('reads an absent marker as not in triage', () => {
    const unmarked = new Map([[TRIAGED, live(TRIAGED)]]);
    expect(() =>
      assertNoTriagedPlacement([node('pi_a', { parentRef: TRIAGED })], unmarked),
    ).not.toThrow();
  });
});

describe('validatePlanProposals runs the triage step', () => {
  it('refuses a plan adding a child under a triaged story, at the close and at approve', () => {
    const err = refusal(() =>
      validatePlanProposals({
        items: [node('pi_a', { parentRef: TRIAGED })],
        liveById: LIVE,
        terminalStatusKeys: new Set(['done', 'cancelled']),
        planProjectId: PROJECT,
        ancestorIdsById: new Map(),
        existingBlockedByEdges: [],
        existingSupersedesEdges: [],
        markTargetStatusCategoryById: new Map(),
      }),
    );
    expect(err.reason).toBe('target_in_triage');
  });

  it('lists target_in_triage among the enumerable grammar violations', () => {
    expect(PLAN_GRAMMAR_VIOLATIONS).toContain('target_in_triage');
  });
});
