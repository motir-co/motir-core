import { describe, expect, it } from 'vitest';
import { InvalidProposalError } from '@/lib/plans/errors';
import { validateProposedPriority } from '@/lib/plans/validateProposedPriority';
import { WORK_ITEM_PRIORITIES, isWorkItemPriority } from '@/lib/issues/priority';

// MOTIR-10656 — the ONE priority bar every plan write door calls. The doors'
// own wiring is driven end to end in
// `tests/integration/plans/proposalPriorityEnum.test.ts`; this pins the
// validator's contract.

describe('isWorkItemPriority', () => {
  it('is true for exactly the five schema members', () => {
    expect([...WORK_ITEM_PRIORITIES]).toEqual(['lowest', 'low', 'medium', 'high', 'highest']);
    for (const p of WORK_ITEM_PRIORITIES) expect(isWorkItemPriority(p)).toBe(true);
  });

  it('is false for a non-member, a different case, and a non-string', () => {
    for (const v of ['p2', 'urgent', 'High', '', null, undefined, 2, {}]) {
      expect(isWorkItemPriority(v)).toBe(false);
    }
  });
});

describe('validateProposedPriority', () => {
  it('passes undefined, null and every member', () => {
    expect(() => validateProposedPriority(undefined, '“A card”')).not.toThrow();
    expect(() => validateProposedPriority(null, '“A card”')).not.toThrow();
    for (const p of WORK_ITEM_PRIORITIES) {
      expect(() => validateProposedPriority(p, '“A card”')).not.toThrow();
    }
  });

  it('refuses "p2" with an INVALID_PROPOSAL naming the proposal, the field and the legal set', () => {
    let caught: unknown;
    try {
      validateProposedPriority('p2', '“E2E acceptance journey”');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidProposalError);
    const err = caught as InvalidProposalError;
    expect(err.code).toBe('INVALID_PROPOSAL');
    expect(err.message).toContain('“E2E acceptance journey”');
    expect(err.message).toContain('`priority` "p2"');
    expect(err.message).toContain('lowest, low, medium, high, highest');
    // At the append there is no persisted proposal to name by id.
    expect(err.planItemId).toBeNull();
  });

  it('carries the persisted proposal id when the door edits one', () => {
    expect(() => validateProposedPriority(3, 'the `modify` of work item wi_1', 'item_1')).toThrow(
      expect.objectContaining({ planItemId: 'item_1' }),
    );
  });
});
