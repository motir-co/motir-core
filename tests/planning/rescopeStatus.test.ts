import { describe, expect, it } from 'vitest';
import {
  RESCOPE_OUTCOME_KEYS,
  claimsBuiltWork,
  modifyTargetStatusFor,
  priorStatusOf,
} from '@/lib/plans/rescopeStatus';

// THE RE-SCOPE MOVE's pure half (bug MOTIR-10102) — the one decision the approve
// and the review diff both read, pinned without a database.

const base = {
  priorStatus: 'implemented',
  priorCategory: 'in_progress' as const,
  rescopes: true,
  markOnly: false,
  gainsChildren: false,
  hasOpenBlocker: false,
  hasLiveRun: false,
};

describe('priorStatusOf', () => {
  it('reads a held park off its lock, and anything else off the card', () => {
    expect(priorStatusOf('planning', { priorStatus: 'implemented', statusHeld: true })).toBe(
      'implemented',
    );
    // Parked by hand: no observed prior, so `planning` is the honest answer.
    expect(priorStatusOf('planning', { priorStatus: 'planning', statusHeld: false })).toBe(
      'planning',
    );
    expect(priorStatusOf('planning', null)).toBe('planning');
    // A lock that did not move the card (no edge into `planning`) says nothing
    // the card does not.
    expect(priorStatusOf('in_review', { priorStatus: 'in_review', statusHeld: false })).toBe(
      'in_review',
    );
    expect(priorStatusOf('implemented', undefined)).toBe('implemented');
  });
});

describe('claimsBuiltWork', () => {
  it.each([
    ['implemented', 'in_progress', true],
    ['in_review', 'in_progress', true],
    ['approved', 'in_progress', true],
    ['qa', 'in_progress', true],
    ['in_progress', 'in_progress', false],
    ['planning', 'in_progress', false],
    ['todo', 'todo', false],
    ['blocked', 'todo', false],
    ['done', 'done', false],
    ['implemented', null, false],
  ] as const)('%s (%s) → %s', (status, category, expected) => {
    expect(claimsBuiltWork(status, category)).toBe(expected);
  });
});

describe('modifyTargetStatusFor', () => {
  it('a re-scope goes to Blocked over In Progress over To Do', () => {
    expect(modifyTargetStatusFor({ ...base, hasOpenBlocker: true, hasLiveRun: true })).toEqual({
      kind: 'rescope',
      toKey: 'blocked',
    });
    expect(modifyTargetStatusFor({ ...base, hasLiveRun: true })).toEqual({
      kind: 'rescope',
      toKey: 'in_progress',
    });
    expect(modifyTargetStatusFor(base)).toEqual({ kind: 'rescope', toKey: 'todo' });
  });

  it('a re-scope of a container that gains children still moves', () => {
    expect(modifyTargetStatusFor({ ...base, gainsChildren: true })).toEqual({
      kind: 'rescope',
      toKey: 'todo',
    });
  });

  it('a patch that does not re-scope keeps the prior status — unless the card gains children', () => {
    expect(modifyTargetStatusFor({ ...base, rescopes: false, hasOpenBlocker: true })).toEqual({
      kind: 'keep',
      toKey: 'implemented',
    });
    expect(modifyTargetStatusFor({ ...base, rescopes: false, gainsChildren: true })).toEqual({
      kind: 'not_ours',
    });
  });

  it('is not the business of a mark-only patch or a card that claims no built work', () => {
    expect(modifyTargetStatusFor({ ...base, markOnly: true })).toEqual({ kind: 'not_ours' });
    expect(
      modifyTargetStatusFor({ ...base, priorStatus: 'in_progress', hasLiveRun: true }),
    ).toEqual({ kind: 'not_ours' });
    expect(modifyTargetStatusFor({ ...base, priorStatus: 'todo', priorCategory: 'todo' })).toEqual({
      kind: 'not_ours',
    });
    expect(modifyTargetStatusFor({ ...base, priorStatus: 'planning' })).toEqual({
      kind: 'not_ours',
    });
    expect(modifyTargetStatusFor({ ...base, priorStatus: 'done', priorCategory: 'done' })).toEqual({
      kind: 'not_ours',
    });
  });

  it('names its three outcomes in reading order', () => {
    expect(RESCOPE_OUTCOME_KEYS).toEqual(['todo', 'blocked', 'in_progress']);
  });
});
