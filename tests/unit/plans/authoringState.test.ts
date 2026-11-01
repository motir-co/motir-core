import { describe, expect, it } from 'vitest';
import type { PlanItemDto } from '@/lib/dto/plans';
import {
  deriveAuthoringStates,
  deriveCommittedStates,
  proposalComplete,
} from '@/lib/plans/authoringState';

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

const modify = (id: string, workItemId: string, patch: Record<string, unknown> = {}) =>
  ({ ...add(id, {}), op: 'modify', workItemId, proposedFields: null, patch }) as PlanItemDto;
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

  it('`proposals` holds the `add`s alone: a `modify` is a committed card, a `remove` is never authored', () => {
    const rows = deriveAuthoringStates(
      [add('a', { title: 'T', kind: 'subtask' }), modify('m', 'wi_1'), remove('r', 'wi_2')],
      [],
      [],
      [],
    );
    expect(rows.map((r) => r.ref)).toEqual(['planItem:a']);
  });
});

// MOTIR-10001 — the committed half: a card the walk re-authors reads the three states,
// every other committed card reads `not_in_walk`.
describe('committed cards', () => {
  const card = (id: string) => ({ id, key: `PROD-${id}`, title: `Card ${id}` });
  const stateIn = (rows: ReturnType<typeof deriveCommittedStates>, id: string) =>
    rows.find((r) => r.ref === id)?.state;

  it('a lay-listed card (a title-changing `modify`) with no session reads `not_started`', () => {
    const rows = deriveCommittedStates(
      [modify('m', 'wi_1', { title: 'Renamed' })],
      [],
      [],
      [],
      [card('wi_1')],
    );
    expect(rows).toEqual([
      { ref: 'wi_1', key: 'PROD-wi_1', title: 'Card wi_1', inWalk: true, state: 'not_started' },
    ]);
  });

  it('a card the driver recorded in `walkListed` reads `not_started`, then `authoring`, then `authored`', () => {
    const cards = [card('wi_2')];
    expect(stateIn(deriveCommittedStates([], [], [], ['wi_2'], cards), 'wi_2')).toBe('not_started');
    const live = [{ kind: 'author', targetRef: 'wi_2' }];
    expect(stateIn(deriveCommittedStates([], live, live, ['wi_2'], cards), 'wi_2')).toBe(
      'authoring',
    );
    expect(stateIn(deriveCommittedStates([], [], live, ['wi_2'], cards), 'wi_2')).toBe('authored');
  });

  it('an author session on a committed card puts it in the walk even when nothing listed it', () => {
    const ended = [{ kind: 'author', targetRef: 'wi_3' }];
    expect(stateIn(deriveCommittedStates([], [], ended, [], [card('wi_3')]), 'wi_3')).toBe(
      'authored',
    );
  });

  it('a `modify` carrying a new body is `authored` with no session', () => {
    const rows = deriveCommittedStates(
      [modify('m', 'wi_4', { descriptionMd: 'rewritten' })],
      [],
      [],
      [],
      [card('wi_4')],
    );
    expect(stateIn(rows, 'wi_4')).toBe('authored');
  });

  it('a card the walk does not re-author — a surgical edge `modify`, or one only asked about — is `not_in_walk`', () => {
    const rows = deriveCommittedStates(
      [modify('m', 'wi_5', { blockedByAdd: ['planItem:a'] })],
      [],
      [{ kind: 'lay', targetRef: 'wi_6' }],
      [],
      [card('wi_5'), card('wi_6'), card('wi_5')],
    );
    expect(rows.map((r) => [r.ref, r.inWalk, r.state])).toEqual([
      ['wi_5', false, 'not_in_walk'],
      ['wi_6', false, 'not_in_walk'],
    ]);
  });
});
