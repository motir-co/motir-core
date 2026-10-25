// Page search's fusion of two rankings (Story MOTIR-9490 · MOTIR-9572) — the
// full-text list and the by-meaning list become ONE ordered list by
// reciprocal-rank fusion. Pure: no I/O, no clock.
//
// A page's score is the sum, over the lists it appears in, of `1 / (k + rank)`
// with `rank` 1-based. A page in both lists is one row carrying both terms, so it
// outranks a page found by only one. There is no similarity threshold: ranking,
// not filtering, is the answer, and the pool bounds how deep either list goes.

/** How many ids each ranking contributes to the fusion — the search's depth. */
export const PAGE_SEARCH_FUSION_POOL = 100;

/** The reciprocal-rank fusion constant (the conventional 60). */
export const PAGE_SEARCH_RRF_K = 60;

export interface FusedHit {
  id: string;
  score: number;
}

/**
 * Fuse ranked id lists, best first. Ties on score break by id DESCENDING, so the
 * order is total and the keyset cursor over it is deterministic. An id repeated
 * inside one list counts at its first (best) rank only.
 */
export function fuseRankings(
  lists: { fullText: readonly string[]; semantic: readonly string[] },
  k: number = PAGE_SEARCH_RRF_K,
): FusedHit[] {
  const scores = new Map<string, number>();
  for (const list of [lists.fullText, lists.semantic]) {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
}
