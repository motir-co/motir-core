import { describe, expect, it } from 'vitest';
import type { PlanItemDto } from '@/lib/dto/plans';
import { proposalComplete } from '@/lib/plans/authoringState';
import {
  CARRY_OVER_VERDICTS,
  carryOverVerdict,
  type CarryOverInput,
} from '@/lib/plans/authorFinishedCarryOver';

// MOTIR-10491 — the carry-over's ONE predicate, every verdict in its order. Pure,
// so each verdict is asserted here without a database; the sweep over real rows is
// `tests/plans/authorFinishedBackfill.test.ts`.

const BOUNDARY = '## Scope BOUNDARY\n\nStarts at the door and ends at the store.';
const BODY = `Why the card exists.\n\n## Deliverables\n\n- the file\n\n${BOUNDARY}\n\n## Acceptance criteria\n\n- It stores the key.`;

const FINISHED = {
  title: 'A finished leaf',
  kind: 'task',
  descriptionMd: BODY,
  explanationMd: 'why',
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 2,
  estimateMinutes: 30,
  difficulty: 'low',
};

function add(id: string, fields: Record<string, unknown> | null): PlanItemDto {
  return {
    id,
    op: 'add',
    workItemId: null,
    proposedFields: fields,
    patch: null,
    parentRef: null,
    blockedByRefs: [],
    supersedesRefs: [],
    baseRevision: null,
    reason: null,
    createdAt: '2026-11-06T00:00:00.000Z',
  } as unknown as PlanItemDto;
}

function judge(item: PlanItemDto, over: Partial<CarryOverInput> = {}) {
  return carryOverVerdict({
    item,
    items: [item],
    findingRefs: new Set(),
    requireExplanation: true,
    liveAuthorTargets: new Set(),
    ...over,
  });
}

describe('carryOverVerdict', () => {
  it('names its six verdicts in order', () => {
    expect(CARRY_OVER_VERDICTS).toEqual([
      'skipped',
      'already_has_state',
      'in_flight',
      'not_complete',
      'boundary_only',
      'stamp',
    ]);
  });

  it('stamps a finished add with no recorded state', () => {
    expect(judge(add('a', FINISHED))).toBe('stamp');
  });

  it('skips a modify and a remove, whatever they carry', () => {
    const modify = { ...add('m', null), op: 'modify', workItemId: 'w1' } as PlanItemDto;
    const remove = { ...modify, op: 'remove' } as PlanItemDto;
    expect(judge(modify)).toBe('skipped');
    expect(judge(remove)).toBe('skipped');
  });

  it('leaves a card that already states the key alone — true and null alike', () => {
    expect(judge(add('a', { ...FINISHED, authorFinished: true }))).toBe('already_has_state');
    expect(judge(add('a', { ...FINISHED, authorFinished: null }))).toBe('already_has_state');
  });

  it('a stated key wins over a live step (the order is the contract)', () => {
    const item = add('a', { ...FINISHED, authorFinished: null });
    expect(judge(item, { liveAuthorTargets: new Set(['planItem:a']) })).toBe('already_has_state');
  });

  it('a live author step on the card makes it in_flight, however finished it looks', () => {
    expect(judge(add('a', FINISHED), { liveAuthorTargets: new Set(['planItem:a']) })).toBe(
      'in_flight',
    );
    expect(judge(add('a', FINISHED), { liveAuthorTargets: new Set(['planItem:b']) })).toBe('stamp');
  });

  it('an incomplete card is not_complete — a title-only add and null fields alike', () => {
    expect(judge(add('a', { title: 'Title only', kind: 'task' }))).toBe('not_complete');
    expect(judge(add('a', null))).toBe('not_complete');
  });

  it('a section finding on the card makes it not_complete', () => {
    expect(judge(add('a', FINISHED), { findingRefs: new Set(['planItem:a']) })).toBe(
      'not_complete',
    );
  });

  it('follows the plan’s explanation rule', () => {
    const noWhy = add('a', { ...FINISHED, explanationMd: '' });
    expect(judge(noWhy, { requireExplanation: true })).toBe('not_complete');
    expect(judge(noWhy, { requireExplanation: false })).toBe('stamp');
  });

  it('a body holding only its Scope BOUNDARY is boundary_only', () => {
    const container = add('a', {
      title: 'A container',
      kind: 'story',
      descriptionMd: BOUNDARY,
      explanationMd: 'why',
    });
    const child = {
      ...add('c', FINISHED),
      parentRef: 'planItem:a',
    } as PlanItemDto;
    expect(judge(container, { items: [container, child] })).toBe('boundary_only');
  });

  it('reads a non-string kind, type and body as absent', () => {
    const odd = add('a', { ...FINISHED, kind: 7, type: 7 });
    expect(judge(odd)).not.toBe('skipped');
  });
});

describe('proposalComplete — requireExplanation', () => {
  const noWhy = add('a', { ...FINISHED, explanationMd: '   ' });

  it('defaults to requiring an explanation (the shipped behaviour)', () => {
    expect(proposalComplete(noWhy, [noWhy], new Set())).toBe(false);
    expect(proposalComplete(noWhy, [noWhy], new Set(), {})).toBe(false);
  });

  it('`requireExplanation: false` passes a card with no explanation', () => {
    expect(proposalComplete(noWhy, [noWhy], new Set(), { requireExplanation: false })).toBe(true);
  });

  it('never passes a card with no body, explanation rule or not', () => {
    const noBody = add('a', { ...FINISHED, descriptionMd: '' });
    expect(proposalComplete(noBody, [noBody], new Set(), { requireExplanation: false })).toBe(
      false,
    );
  });
});
