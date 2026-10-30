import { describe, expect, it } from 'vitest';
import {
  BADLY_STALE_COMMITS_BEHIND,
  codeBlindPauseReason,
  isBadlyStale,
} from '@/lib/ai/codeFreshness';
import type { CodeContextDTO } from '@/lib/dto/codeContext';

// THE ONE THRESHOLD (Story MOTIR-1754 · MOTIR-4603) — "badly behind", defined
// once and read by every consumer that decides whether Motir may still act on
// its own view of the code. One number, three consumers; a second definition is
// how the cadence and the surface come to disagree about the same project.

function ctx(over: Partial<CodeContextDTO> = {}): CodeContextDTO {
  return {
    hasCodeContext: true,
    repos: [],
    hasImplementedWork: false,
    ...over,
  };
}

// ⚠️ THE SHAPE MOVED WITH MOTIR-1767's SECOND REVISION: the DTO no longer carries
// a `verdict` of its own, nor the two shas and the engine version it compared —
// `lib/codeGraph/indexState.ts` owns the four states and this context reports
// them. `commitsBehind` is the field these cases are actually about, and it is
// the one that survived.
function repo(commitsBehind: number | null) {
  return {
    repoRef: 'acme/web',
    provider: 'github',
    indexState: 'stale' as const,
    indexedAt: null,
    commitsBehind,
    // MOTIR-2105's field. These cases are about the THRESHOLD and never about a
    // dead refresh, so it is false throughout — the two are independent facts,
    // and a repository can be badly behind with a perfectly healthy pipeline.
    refreshFailing: false,
    // MOTIR-7132's field — no size refusal; the threshold is independent of it.
    graphTooLarge: null,
    // MOTIR-10094's pair — the threshold reads the count, never the shas.
    indexedSha: null,
    defaultHead: null,
  };
}

describe('isBadlyStale — a THRESHOLD, never "any drift"', () => {
  it('fires AT the threshold and above', () => {
    expect(isBadlyStale({ commitsBehind: BADLY_STALE_COMMITS_BEHIND })).toBe(true);
    expect(isBadlyStale({ commitsBehind: BADLY_STALE_COMMITS_BEHIND + 1 })).toBe(true);
    expect(isBadlyStale({ commitsBehind: 5000 })).toBe(true);
  });

  it('does NOT fire below it — an active repo is always a few commits behind', () => {
    // With push-driven refresh healthy (2-min debounce, 15-min cap) an active
    // repository sits a handful of commits behind between pushes. Pausing on any
    // drift would pause the cadence PERMANENTLY for exactly the projects doing
    // the most work — the inverse of what it is for.
    expect(isBadlyStale({ commitsBehind: 0 })).toBe(false);
    expect(isBadlyStale({ commitsBehind: 1 })).toBe(false);
    expect(isBadlyStale({ commitsBehind: BADLY_STALE_COMMITS_BEHIND - 1 })).toBe(false);
  });

  it('UNKNOWN drift is never "badly behind" — a pause on missing evidence is a false accusation', () => {
    // The same rule that makes a NULL head resolve to `current` rather than
    // `stale`. It is also the production state today: `commitsBehind` is always
    // null until its producer ships, so this arm is what actually runs.
    expect(isBadlyStale({ commitsBehind: null })).toBe(false);
  });
});

describe('codeBlindPauseReason — what makes Motir stop DECIDING', () => {
  it('no connected repo pauses', () => {
    expect(codeBlindPauseReason(ctx({ hasCodeContext: false }))).toBe('no_connected_repo');
  });

  it('a badly-stale repo pauses, and one below the threshold does not', () => {
    expect(codeBlindPauseReason(ctx({ repos: [repo(BADLY_STALE_COMMITS_BEHIND)] }))).toBe(
      'badly_stale_graph',
    );
    expect(codeBlindPauseReason(ctx({ repos: [repo(BADLY_STALE_COMMITS_BEHIND - 1)] }))).toBeNull();
  });

  it('ONE badly-stale repo in a set is enough — the planner reads them all', () => {
    expect(codeBlindPauseReason(ctx({ repos: [repo(1), repo(BADLY_STALE_COMMITS_BEHIND)] }))).toBe(
      'badly_stale_graph',
    );
  });

  it('an OLD graph on an unchanged repo does NOT pause — drift, never age', () => {
    // `commitsBehind: 0` with an ancient `indexedAt` is a graph that is exactly
    // right. An age-led threshold would pause this and let a two-hour-old graph
    // on a busy repo through — both backwards.
    const ancient = {
      ...repo(0),
      verdict: 'current' as const,
      // A DATE, which is what the DTO carries — the string form typechecked
      // only because `tsc --noEmit` does not cover `tests/`.
      indexedAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    expect(codeBlindPauseReason(ctx({ repos: [ancient] }))).toBeNull();
  });

  // ⚠️ AMENDED (MOTIR-1767, second revision) — this case asserted that a
  // freshness read which DID NOT ANSWER does not pause, via a
  // `freshnessUnavailable` flag on the context. That flag is gone, and it is
  // gone because the CONDITION is gone: freshness came from motir-ai across the
  // 7.1 boundary, and MOTIR-4724 moved every fact the index state is derived
  // from into motir-core's own columns. There is no longer a read that can fail
  // to answer.
  //
  // The case is REWRITTEN rather than deleted because its reasoning still binds
  // the successor: a pause must rest on evidence of drift, never on the absence
  // of evidence. What carries that now is `commitsBehind: null`, which is the
  // ONLY not-known-yet value left on this path — and the assertion below is the
  // same guarantee stated over the field that survived.
  it('MISSING EVIDENCE never pauses — an uncountable drift is not a badly-stale graph', () => {
    expect(codeBlindPauseReason(ctx({ repos: [repo(null)] }))).toBeNull();
  });

  it('a connected, up-to-date project does not pause', () => {
    expect(
      codeBlindPauseReason(ctx({ repos: [{ ...repo(0), indexState: 'indexed' as const }] })),
    ).toBeNull();
  });
});
