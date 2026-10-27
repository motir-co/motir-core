import { describe, expect, it } from 'vitest';
import type { PlanItemDto } from '@/lib/dto/plans';
import { deriveAuthoringStates, proposalComplete } from '@/lib/plans/authoringState';

// MOTIR-9821 — the derivation behind `get_plan_authoring_state`. Pure, so every
// state is asserted here without a database; the read through the real transport
// and the real step rows is `tests/mcp/get-plan-authoring-state.test.ts`.

const COMPLETE_LEAF = {
  title: 'A complete leaf',
  kind: 'subtask',
  descriptionMd: 'body',
  explanationMd: 'why',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 30,
  difficulty: 'low',
};

function add(id: string, fields: Record<string, unknown>, parentRef: string | null = null) {
  return {
    id,
    op: 'add',
    workItemId: null,
    proposedFields: fields,
    patch: null,
    parentRef,
    blockedByRefs: [],
    supersedesRefs: [],
    baseRevision: null,
    reason: null,
    createdAt: '2026-10-27T00:00:00.000Z',
  } as unknown as PlanItemDto;
}

const modify = (id: string, workItemId: string) =>
  ({ ...add(id, {}), op: 'modify', workItemId, proposedFields: null, patch: {} }) as PlanItemDto;
const remove = (id: string, workItemId: string) =>
  ({ ...modify(id, workItemId), op: 'remove' }) as PlanItemDto;

const stateOf = (rows: ReturnType<typeof deriveAuthoringStates>, ref: string) =>
  rows.find((r) => r.ref === ref)?.state;

describe('the three states', () => {
  const items = [add('a', { title: 'Title only', kind: 'subtask' }), add('b', COMPLETE_LEAF)];

  it('a LIVE author step makes the card `authoring`, whatever its body', () => {
    const rows = deriveAuthoringStates(
      items,
      [{ kind: 'author', targetRef: 'planItem:a' }],
      [{ kind: 'author', targetRef: 'planItem:a' }],
      [],
    );
    expect(stateOf(rows, 'planItem:a')).toBe('authoring');
  });

  it('an ENDED author session makes the card `authored`, even when its body is still partial', () => {
    const rows = deriveAuthoringStates(
      items,
      [],
      [{ kind: 'author', targetRef: 'planItem:a' }],
      [],
    );
    expect(stateOf(rows, 'planItem:a')).toBe('authored');
  });

  it('a card added COMPLETE with no session is `authored`, never `not_started`', () => {
    const rows = deriveAuthoringStates(items, [], [], []);
    expect(stateOf(rows, 'planItem:b')).toBe('authored');
  });

  it('an incomplete card with no session, live or ended, is `not_started`', () => {
    const rows = deriveAuthoringStates(items, [], [], []);
    expect(stateOf(rows, 'planItem:a')).toBe('not_started');
  });

  it('a `lay` step or a session on ANOTHER card does not start this one', () => {
    const rows = deriveAuthoringStates(
      items,
      [{ kind: 'lay', targetRef: 'planItem:a' }],
      [
        { kind: 'lay', targetRef: 'planItem:a' },
        { kind: 'author', targetRef: 'planItem:b' },
      ],
      [],
    );
    expect(stateOf(rows, 'planItem:a')).toBe('not_started');
  });
});

describe('what counts as COMPLETE', () => {
  it('a section finding on the card makes it incomplete, so it reads `not_started`', () => {
    const items = [add('b', COMPLETE_LEAF)];
    const rows = deriveAuthoringStates(items, [], [], [{ item: 'planItem:b' }]);
    expect(stateOf(rows, 'planItem:b')).toBe('not_started');
  });

  it('a body with no explanation is incomplete', () => {
    const items = [add('b', { ...COMPLETE_LEAF, explanationMd: '  ' })];
    expect(proposalComplete(items[0]!, items, new Set())).toBe(false);
  });

  it('a childless leaf missing its difficulty is incomplete', () => {
    const items = [add('b', { ...COMPLETE_LEAF, difficulty: null })];
    expect(proposalComplete(items[0]!, items, new Set())).toBe(false);
  });

  it('a story or a parent owes both bodies and no leaf field', () => {
    const story = add('s', {
      title: 'A story',
      kind: 'story',
      descriptionMd: 'b',
      explanationMd: 'w',
    });
    const parentTask = add('t', {
      title: 'A task',
      kind: 'task',
      descriptionMd: 'b',
      explanationMd: 'w',
    });
    const child = add('c', { ...COMPLETE_LEAF }, 'planItem:t');
    const items = [story, parentTask, child];
    expect(proposalComplete(story, items, new Set())).toBe(true);
    expect(proposalComplete(parentTask, items, new Set())).toBe(true);
  });

  it('a `modify` is complete and keyed by its work item id; a `remove` is not listed', () => {
    const rows = deriveAuthoringStates([modify('m', 'wi_1'), remove('r', 'wi_2')], [], [], []);
    expect(rows).toEqual([{ ref: 'wi_1', op: 'modify', title: null, state: 'authored' }]);
  });
});
