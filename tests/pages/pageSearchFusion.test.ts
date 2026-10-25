import { describe, expect, it } from 'vitest';
import {
  fuseRankings,
  PAGE_SEARCH_FUSION_POOL,
  PAGE_SEARCH_RRF_K,
} from '@/lib/pages/pageSearchFusion';

// Reciprocal-rank fusion for page search (Story MOTIR-9490 · MOTIR-9572).

const rrf = (...ranks: number[]) => ranks.reduce((sum, r) => sum + 1 / (60 + r), 0);

describe('fuseRankings', () => {
  it('declares the pool and k the search uses', () => {
    expect(PAGE_SEARCH_FUSION_POOL).toBe(100);
    expect(PAGE_SEARCH_RRF_K).toBe(60);
  });

  it('scores each id as the sum of 1/(60+rank) over the lists it is in', () => {
    const fused = fuseRankings({ fullText: ['a', 'b'], semantic: ['b', 'c'] });
    const byId = Object.fromEntries(fused.map((h) => [h.id, h.score]));
    expect(byId['a']).toBeCloseTo(rrf(1), 12);
    expect(byId['b']).toBeCloseTo(rrf(2, 1), 12);
    expect(byId['c']).toBeCloseTo(rrf(2), 12);
  });

  it('ranks an id in both lists above any id in one, and returns it once', () => {
    const fused = fuseRankings({ fullText: ['x', 'both'], semantic: ['y', 'both'] });
    expect(fused[0]!.id).toBe('both');
    expect(fused.filter((h) => h.id === 'both')).toHaveLength(1);
    expect(fused).toHaveLength(3);
  });

  it('breaks a score tie by id descending, so the order is total', () => {
    const fused = fuseRankings({ fullText: ['m'], semantic: ['z'] });
    expect(fused.map((h) => h.id)).toEqual(['z', 'm']);
    expect(fused[0]!.score).toBe(fused[1]!.score);
  });

  it('is deterministic whichever list a tie came from', () => {
    const a = fuseRankings({ fullText: ['p', 'q'], semantic: ['q', 'p'] });
    const b = fuseRankings({ fullText: ['q', 'p'], semantic: ['p', 'q'] });
    expect(a).toEqual(b);
    expect(a.map((h) => h.id)).toEqual(['q', 'p']);
  });

  it("yields the other list's order when one list is empty", () => {
    expect(fuseRankings({ fullText: ['c', 'a', 'b'], semantic: [] }).map((h) => h.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(fuseRankings({ fullText: [], semantic: ['b', 'c'] }).map((h) => h.id)).toEqual([
      'b',
      'c',
    ]);
    expect(fuseRankings({ fullText: [], semantic: [] })).toEqual([]);
  });

  it('counts a repeated id at its best rank only', () => {
    const [hit] = fuseRankings({ fullText: ['a', 'a'], semantic: [] });
    expect(hit!.score).toBeCloseTo(rrf(1), 12);
  });

  it('honours a custom k', () => {
    const [hit] = fuseRankings({ fullText: ['a'], semantic: [] }, 0);
    expect(hit!.score).toBe(1);
  });
});
