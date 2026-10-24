import { describe, expect, it } from 'vitest';

// Bug MOTIR-9160 — the requirement's `assumptions` is a LIST of recommendations
// with ids, so the planner can answer each one. A string stored before the list
// existed still reads, as ONE recommendation; nothing here splits prose.

import { isRecommendationList, narrowSharpenedRequirement } from '@/lib/sharpening/requirement';

describe('isRecommendationList', () => {
  it('accepts strings and { text, id? } entries, and the empty list', () => {
    expect(isRecommendationList([])).toBe(true);
    expect(isRecommendationList(['a', { text: 'b' }, { id: 'x', text: 'c' }])).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isRecommendationList('a; b')).toBe(false);
    expect(isRecommendationList([{ id: 'x' }])).toBe(false);
    expect(isRecommendationList([{ id: 3, text: 'a' }])).toBe(false);
    expect(isRecommendationList([1])).toBe(false);
    expect(isRecommendationList(null)).toBe(false);
  });
});

describe('narrowSharpenedRequirement', () => {
  it('carries a list of recommendations through unchanged', () => {
    const assumptions = [{ id: 'q1', text: 'Which formats? — CSV only' }, 'Nobody is notified'];
    expect(narrowSharpenedRequirement({ outcome: 'o', assumptions })).toEqual({
      outcome: 'o',
      assumptions,
    });
  });

  it('still carries a string stored before the list existed, unsplit', () => {
    expect(narrowSharpenedRequirement({ assumptions: '- a\n- b' })).toEqual({
      assumptions: '- a\n- b',
    });
  });

  it('drops an assumptions value that is neither', () => {
    expect(narrowSharpenedRequirement({ outcome: 'o', assumptions: [{ id: 'x' }] })).toEqual({
      outcome: 'o',
    });
  });
});
