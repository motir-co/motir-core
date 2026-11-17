import { describe, expect, it } from 'vitest';
import { encodeFilterEnvelope, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { EMPTY_FILTER } from '@/lib/issues/issueListFilter';
import { differsFromBoardFilter } from '@/lib/issues/savedFilterApplied';
import {
  boardEmptyVariant,
  boardFilterResetHref,
  buildBoardHeaderFilterHref,
  resolveBoardHeaderFilter,
  staleConditionKind,
  staleHeaderConditions,
  storedFilterAst,
} from '@/lib/boards/boardHeaderFilter';
import type { StoredBoardFilterDto } from '@/lib/dto/boards';

// The board's header filter resolved against its stored filter (MOTIR-11565):
// the four states the design draws, the "differs" test that drives Edited /
// Save to board filter / Reset, the hrefs a header change navigates to, the
// stale-condition mapping, and the empty-state variant. Pure — no DOM, no DB.

const KIND_BUG: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};
const KIND_BUG_HIGH: FilterAst = {
  combinator: 'and',
  conditions: [
    { field: 'kind', operator: 'is_any_of', value: ['bug'] },
    { field: 'priority', operator: 'is_any_of', value: ['high'] },
  ],
};
const LABEL_MOBILE: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl_mobile'] }],
};

function stored(ast: FilterAst, extra: Partial<StoredBoardFilterDto> = {}): StoredBoardFilterDto {
  return { envelope: encodeFilterEnvelope(ast), staleConditions: [], labels: [], ...extra };
}

describe('differsFromBoardFilter — the shipped canonical equality, stored envelope as reference', () => {
  it('two empty filters are equal, and an absent one equals an empty one', () => {
    expect(differsFromBoardFilter(null, null)).toBe(false);
    expect(differsFromBoardFilter({ combinator: 'and', conditions: [] }, null)).toBe(false);
  });

  it('the same conditions are equal; an added condition differs', () => {
    expect(differsFromBoardFilter(KIND_BUG, KIND_BUG)).toBe(false);
    expect(differsFromBoardFilter(KIND_BUG_HIGH, KIND_BUG)).toBe(true);
    expect(differsFromBoardFilter(null, KIND_BUG)).toBe(true);
  });
});

describe('resolveBoardHeaderFilter — the four states', () => {
  it('no stored filter (or not read yet) is today: none, never differs', () => {
    for (const storedFilter of [null, undefined]) {
      const state = resolveBoardHeaderFilter({
        filter: { ...EMPTY_FILTER, kinds: ['bug'] },
        ast: null,
        boardFilterOff: false,
        storedFilter,
      });
      expect(state.mode).toBe('none');
      expect(state.hasStoredFilter).toBe(false);
      expect(state.differs).toBe(false);
      expect(state.current.conditions).toHaveLength(1);
    }
  });

  it('opened clean: the stored conditions are seeded into the advanced channel', () => {
    const state = resolveBoardHeaderFilter({
      filter: EMPTY_FILTER,
      ast: null,
      boardFilterOff: false,
      storedFilter: stored(KIND_BUG),
    });
    expect(state.mode).toBe('board');
    expect(state.differs).toBe(false);
    expect(state.ast).toEqual(KIND_BUG);
    expect(state.filter.advanced).toBe(encodeFilterParam(KIND_BUG));
    expect(state.current).toEqual(KIND_BUG);
  });

  it('an added condition is Edited', () => {
    const state = resolveBoardHeaderFilter({
      filter: { ...EMPTY_FILTER, advanced: encodeFilterParam(KIND_BUG_HIGH) },
      ast: KIND_BUG_HIGH,
      boardFilterOff: false,
      storedFilter: stored(KIND_BUG),
    });
    expect(state.mode).toBe('edited');
    expect(state.differs).toBe(true);
  });

  it('an edit back to exactly the stored conditions is the Board filter state again', () => {
    const state = resolveBoardHeaderFilter({
      filter: { ...EMPTY_FILTER, kinds: ['bug'] },
      ast: null,
      boardFilterOff: false,
      storedFilter: stored(KIND_BUG),
    });
    expect(state.mode).toBe('board');
    expect(state.differs).toBe(false);
  });

  it('boardFilter=off with no conditions is Cleared, and differs', () => {
    const state = resolveBoardHeaderFilter({
      filter: EMPTY_FILTER,
      ast: null,
      boardFilterOff: true,
      storedFilter: stored(KIND_BUG),
    });
    expect(state.mode).toBe('cleared');
    expect(state.differs).toBe(true);
    expect(state.ast).toBeNull();
    expect(state.current.conditions).toEqual([]);
  });

  it('an unreadable stored envelope: opened clean is the board state with nothing seeded', () => {
    const unreadable: StoredBoardFilterDto = {
      envelope: null,
      staleConditions: [{ index: null, field: null, reason: 'invalid' }],
      labels: [],
    };
    const clean = resolveBoardHeaderFilter({
      filter: EMPTY_FILTER,
      ast: null,
      boardFilterOff: false,
      storedFilter: unreadable,
    });
    expect(clean.mode).toBe('board');
    expect(clean.unreadable).toBe(true);
    expect(clean.ast).toBeNull();
    // Any header filter differs from a board filter that matches nothing.
    const edited = resolveBoardHeaderFilter({
      filter: { ...EMPTY_FILTER, kinds: ['bug'] },
      ast: null,
      boardFilterOff: false,
      storedFilter: unreadable,
    });
    expect(edited.mode).toBe('edited');
    expect(edited.differs).toBe(true);
  });

  it('a stored envelope with no conditions seeds nothing', () => {
    const state = resolveBoardHeaderFilter({
      filter: EMPTY_FILTER,
      ast: null,
      boardFilterOff: false,
      storedFilter: stored({ combinator: 'and', conditions: [] }),
    });
    expect(state.mode).toBe('board');
    expect(state.ast).toBeNull();
    expect(state.filter.advanced).toBeNull();
  });
});

describe('storedFilterAst', () => {
  it('decodes a readable envelope and answers null otherwise', () => {
    expect(storedFilterAst(stored(KIND_BUG))).toEqual(KIND_BUG);
    expect(storedFilterAst(null)).toBeNull();
    expect(
      storedFilterAst({
        envelope: { v: 'v9', c: 'and', f: [] },
        staleConditions: [],
        labels: [],
      }),
    ).toBeNull();
  });
});

describe('the hrefs a header change navigates to', () => {
  it('a change that leaves no condition on a board with a stored filter carries boardFilter=off', () => {
    expect(
      buildBoardHeaderFilterHref({ boardId: 'b1', filter: EMPTY_FILTER, hasStoredFilter: true }),
    ).toBe('/boards?board=b1&boardFilter=off');
  });

  it('without a stored filter, or with a condition left, it is the shipped board href', () => {
    expect(
      buildBoardHeaderFilterHref({ boardId: 'b1', filter: EMPTY_FILTER, hasStoredFilter: false }),
    ).toBe('/boards?board=b1');
    const withKind = buildBoardHeaderFilterHref({
      filter: { ...EMPTY_FILTER, kinds: ['bug'] },
      hasStoredFilter: true,
    });
    expect(withKind).toBe('/boards?kind=bug');
  });

  it('Reset to board filter is the board with no filter params', () => {
    expect(boardFilterResetHref('b1')).toBe('/boards?board=b1');
    expect(boardFilterResetHref()).toBe('/boards');
  });
});

describe('stale conditions', () => {
  it('names each stale referent kind the board read reports', () => {
    expect(staleConditionKind({ index: 0, field: 'lbl', reason: 'unknown-value' })).toBe('label');
    expect(staleConditionKind({ index: 0, field: 'cmp', reason: 'unknown-value' })).toBe(
      'component',
    );
    expect(staleConditionKind({ index: 0, field: 'folder', reason: 'unknown-value' })).toBe(
      'folder',
    );
    expect(staleConditionKind({ index: 0, field: 'cf:x', reason: 'unknown-field' })).toBe('field');
    expect(staleConditionKind({ index: 0, field: 'cf:x', reason: 'unknown-value' })).toBe('option');
    expect(staleConditionKind({ index: 0, field: 'lbl', reason: 'invalid' })).toBe('invalid');
    expect(staleConditionKind({ index: null, field: null, reason: 'invalid' })).toBe('invalid');
    expect(staleConditionKind({ index: 0, field: 'kind', reason: 'unknown-value' })).toBe(
      'invalid',
    );
  });

  it('maps a stale stored condition to wherever the header holds it', () => {
    const storedAst: FilterAst = {
      combinator: 'and',
      conditions: [KIND_BUG.conditions[0]!, LABEL_MOBILE.conditions[0]!],
    };
    const stale = [{ index: 1, field: 'lbl', reason: 'unknown-value' as const }];
    // As stored: the label condition is at 1.
    expect([...staleHeaderConditions(storedAst, stale, storedAst)]).toEqual([[1, 'label']]);
    // The reader removed the kind condition: the label is now at 0.
    expect([...staleHeaderConditions(storedAst, stale, LABEL_MOBILE)]).toEqual([[0, 'label']]);
    // Removed altogether: nothing is marked.
    expect(staleHeaderConditions(storedAst, stale, KIND_BUG).size).toBe(0);
  });

  it('marks nothing without a stored AST, a header AST or a positional stale row', () => {
    const stale = [{ index: null, field: null, reason: 'invalid' as const }];
    expect(staleHeaderConditions(null, stale, KIND_BUG).size).toBe(0);
    expect(staleHeaderConditions(KIND_BUG, [], null).size).toBe(0);
    expect(staleHeaderConditions(KIND_BUG, stale, KIND_BUG).size).toBe(0);
  });
});

describe('boardEmptyVariant', () => {
  const kindBugParam = encodeFilterParam(KIND_BUG);

  it('no stored filter: the shipped filtered-empty with a header filter, else the new-board state', () => {
    expect(boardEmptyVariant({ storedFilter: null, filterParam: '', boardFilterOff: false })).toBe(
      'none',
    );
    expect(
      boardEmptyVariant({ storedFilter: null, filterParam: kindBugParam, boardFilterOff: false }),
    ).toBe('filter');
  });

  it('a stored filter: its own leaves nothing (board), a different one offers Reset, Cleared is the whole scope', () => {
    const s = stored(KIND_BUG);
    expect(boardEmptyVariant({ storedFilter: s, filterParam: '', boardFilterOff: false })).toBe(
      'board',
    );
    expect(
      boardEmptyVariant({ storedFilter: s, filterParam: kindBugParam, boardFilterOff: false }),
    ).toBe('board');
    expect(
      boardEmptyVariant({
        storedFilter: s,
        filterParam: encodeFilterParam(LABEL_MOBILE),
        boardFilterOff: false,
      }),
    ).toBe('reset');
    expect(boardEmptyVariant({ storedFilter: s, filterParam: '', boardFilterOff: true })).toBe(
      'none',
    );
  });
});
