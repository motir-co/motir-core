import { describe, expect, it } from 'vitest';
import { InvalidProposalError } from '@/lib/plans/errors';
import { validateProposedExecutor } from '@/lib/plans/validateProposedExecutor';
import { WORK_ITEM_EXECUTORS, isWorkItemExecutor } from '@/lib/issues/executorDefaults';

// MOTIR-10678 — the ONE card-executor bar every plan write door calls. The
// doors' own wiring is driven end to end in
// `tests/integration/plans/proposalExecutorEnum.test.ts`; this pins the
// validator's contract.

describe('isWorkItemExecutor', () => {
  it('is true for exactly the two schema members', () => {
    expect([...WORK_ITEM_EXECUTORS]).toEqual(['coding_agent', 'human']);
    for (const e of WORK_ITEM_EXECUTORS) expect(isWorkItemExecutor(e)).toBe(true);
  });

  it('is false for a non-member, a different case, and a non-string', () => {
    for (const v of ['agent', 'robot', 'Human', 'coding-agent', '', null, undefined, 1, {}]) {
      expect(isWorkItemExecutor(v)).toBe(false);
    }
  });
});

describe('validateProposedExecutor', () => {
  it('passes undefined, null and every member', () => {
    expect(() => validateProposedExecutor(undefined, '“A card”')).not.toThrow();
    expect(() => validateProposedExecutor(null, '“A card”')).not.toThrow();
    for (const e of WORK_ITEM_EXECUTORS) {
      expect(() => validateProposedExecutor(e, '“A card”')).not.toThrow();
    }
  });

  it('refuses "agent" with an INVALID_PROPOSAL naming the proposal, the field and the legal set', () => {
    let caught: unknown;
    try {
      validateProposedExecutor('agent', '“Wire the queue”');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidProposalError);
    const err = caught as InvalidProposalError;
    expect(err.code).toBe('INVALID_PROPOSAL');
    expect(err.message).toContain('“Wire the queue”');
    expect(err.message).toContain('`executor` "agent"');
    expect(err.message).toContain('coding_agent, human');
    // At the append there is no persisted proposal to name by id.
    expect(err.planItemId).toBeNull();
  });

  it('carries the persisted proposal id when the door edits one', () => {
    expect(() => validateProposedExecutor(7, '“A card”', 'item_1')).toThrow(
      expect.objectContaining({ planItemId: 'item_1' }),
    );
  });
});
