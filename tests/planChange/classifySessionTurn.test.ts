import { describe, expect, it } from 'vitest';
import { classifySessionTurn } from '@/lib/planChange/classifySessionTurn';

// MOTIR-7945 — what a turn on a conversation does, by the plan it waits on.

const open = { origin: 'conversation', endedAt: null };

describe('classifySessionTurn', () => {
  it.each([
    ['no undecided plan', null, undefined, { kind: 'submit' }],
    [
      'a generating plan',
      { id: 'p', status: 'generating' as const },
      undefined,
      { kind: 'submit' },
    ],
    [
      'a planned plan',
      { id: 'p', status: 'planned' as const },
      undefined,
      { kind: 'revise', planId: 'p' },
    ],
    [
      // Bug MOTIR-11701: a walk that returned with a question closes `stopped`; the answer revises it.
      'a stopped plan',
      { id: 'p', status: 'stopped' as const },
      undefined,
      { kind: 'revise', planId: 'p' },
    ],
    [
      'a stale plan',
      { id: 'p', status: 'stale' as const },
      undefined,
      { kind: 'stale', planId: 'p' },
    ],
    [
      'plan again of the stale plan',
      { id: 'x', status: 'stale' as const },
      'x',
      { kind: 'plan_again', stalePlanId: 'x' },
    ],
    [
      'plan again of a restored plan',
      { id: 'x', status: 'planned' as const },
      'x',
      { kind: 'revise', planId: 'x' },
    ],
    [
      'plan again past a newer plan',
      { id: 'y', status: 'generating' as const },
      'x',
      { kind: 'plan_again_refused', reason: 'superseded' },
    ],
    ['plan again of a decided plan', null, 'x', { kind: 'plan_again_refused', reason: 'decided' }],
  ])('open conversation, %s', (_label, latestUndecided, planAgainOf, expected) => {
    expect(classifySessionTurn({ ...open, latestUndecided, planAgainOf })).toEqual(expected);
  });

  it('a guide session submits (refused upstream)', () => {
    expect(
      classifySessionTurn({
        origin: 'guide',
        endedAt: null,
        latestUndecided: { id: 'p', status: 'stale' },
        planAgainOf: 'p',
      }),
    ).toEqual({ kind: 'submit' });
  });

  it('an ended session submits (refused upstream)', () => {
    expect(
      classifySessionTurn({
        origin: 'conversation',
        endedAt: new Date(),
        latestUndecided: { id: 'p', status: 'planned' },
      }),
    ).toEqual({ kind: 'submit' });
  });
});
