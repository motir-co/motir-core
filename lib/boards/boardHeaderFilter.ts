// The board's HEADER filter, resolved against the board's own stored filter
// (MOTIR-11565, design `design/boards/board--header-board-filter.mock.html`).
// Pure, so the toolbar controls, the applied bar and the board's empty state all
// read one answer, and so the rules are unit-testable without the DOM.
//
// Since MOTIR-11564 the board read takes the header filter INSTEAD of the stored
// one, and no header filter means the stored filter. So on a board with a stored
// filter the header filter STARTS as the board filter: with no filter in the URL
// the stored conditions are loaded into the header, in the advanced channel, as
// ordinary editable conditions. The URL stays clean — no params means the board
// filter — and `?boardFilter=off` is the reader having removed every condition
// (the Cleared state, which must survive a reload).
//
// The four states the design draws:
// - `board`   — the header IS the board filter (opened clean, Reset, a save, or
//               an edit that landed back on exactly the stored conditions);
// - `edited`  — the header differs from the board filter;
// - `cleared` — every condition removed (`boardFilter=off`): the whole scope;
// - `none`    — the board has no stored filter (or it is not known yet): the
//               header filter behaves exactly as it did before.
// A saved filter applied from Saved is the `edited` state as far as the URL
// goes; which saved filter it is lives in the saved-filter session, not here.

import {
  customFieldIdOfFilterField,
  decodeFilterEnvelope,
  encodeFilterParam,
  type FilterAst,
  type FilterCondition,
} from '@/lib/filters/ast';
import { EMPTY_FILTER, isFilterActive, type IssueFilter } from '@/lib/issues/issueListFilter';
import { setAdvancedParam, upgradeFacetsIntoAst } from '@/lib/issues/issueListAdvancedFilter';
import { currentFilterParam, differsFromBoardFilter } from '@/lib/issues/savedFilterApplied';
import { buildBoardFilterHref } from '@/lib/boards/boardFilterHref';
import type { StoredBoardFilterDto, StoredFilterStaleConditionDto } from '@/lib/dto/boards';

export type BoardHeaderFilterMode = 'none' | 'board' | 'edited' | 'cleared';

export interface BoardHeaderFilterState {
  mode: BoardHeaderFilterMode;
  /** Whether the board has a stored filter at all. */
  hasStoredFilter: boolean;
  /** The stored filter's conditions; `null` when there is none, or when its
   * envelope cannot be read (`unreadable`). */
  storedAst: FilterAst | null;
  /** The stored envelope cannot be read, so the board filter matches nothing. */
  unreadable: boolean;
  /** The filter the header controls render (the URL's, or the stored filter
   * seeded into the advanced channel). */
  filter: IssueFilter;
  /** The advanced AST the header controls render (`null` = no conditions). */
  ast: FilterAst | null;
  /** The effective header filter, facets merged — what the board shows. */
  current: FilterAst;
  /** Whether the header filter differs from the board filter. Always false on a
   * board with no stored filter. */
  differs: boolean;
}

const EMPTY_AST: FilterAst = { combinator: 'and', conditions: [] };

/** The stored envelope's conditions, or `null` when it cannot be read. */
export function storedFilterAst(storedFilter: StoredBoardFilterDto | null): FilterAst | null {
  if (!storedFilter?.envelope) return null;
  const decoded = decodeFilterEnvelope(storedFilter.envelope);
  return decoded.ok ? decoded.ast : null;
}

/** Whether the URL carries any header filter at all (a facet or the AST). */
function urlCarriesFilter(filter: IssueFilter, ast: FilterAst | null): boolean {
  return isFilterActive(filter) || (ast !== null && ast.conditions.length > 0);
}

/**
 * Resolve the header filter against the board's stored filter. `storedFilter`
 * is `undefined` while the board read has not answered yet and `null` when the
 * board has none; both resolve to `none`, which is today's behaviour.
 */
export function resolveBoardHeaderFilter(input: {
  filter: IssueFilter;
  ast: FilterAst | null;
  boardFilterOff: boolean;
  storedFilter: StoredBoardFilterDto | null | undefined;
}): BoardHeaderFilterState {
  const { filter, ast, boardFilterOff, storedFilter } = input;
  if (!storedFilter) {
    return {
      mode: 'none',
      hasStoredFilter: false,
      storedAst: null,
      unreadable: false,
      filter,
      ast,
      current: upgradeFacetsIntoAst(filter, ast),
      differs: false,
    };
  }
  const storedAst = storedFilterAst(storedFilter);
  const unreadable = storedAst === null;
  const base = { hasStoredFilter: true, storedAst, unreadable };

  if (!urlCarriesFilter(filter, ast)) {
    if (boardFilterOff) {
      return { ...base, mode: 'cleared', filter, ast: null, current: EMPTY_AST, differs: true };
    }
    // Opened clean: the header IS the board filter, seeded into the advanced
    // channel so the builder holds its rows and the quick popover follows its
    // shipped superseded rule.
    const seeded = storedAst && storedAst.conditions.length > 0 ? storedAst : null;
    return {
      ...base,
      mode: 'board',
      filter: setAdvancedParam(filter, seeded),
      ast: seeded,
      current: seeded ?? EMPTY_AST,
      differs: false,
    };
  }

  const current = upgradeFacetsIntoAst(filter, ast);
  // An unreadable board filter matches nothing, so any header filter differs.
  const differs = unreadable || differsFromBoardFilter(current, storedAst);
  return { ...base, mode: differs ? 'edited' : 'board', filter, ast, current, differs };
}

/**
 * The board href a header-filter change navigates to. On a board with a stored
 * filter, a change that leaves NO condition is the Cleared state, so it carries
 * `?boardFilter=off` — without it the URL would read as "the board filter" and
 * the stored conditions would come straight back.
 */
export function buildBoardHeaderFilterHref(opts: {
  boardId?: string;
  filter: IssueFilter;
  hasStoredFilter: boolean;
}): string {
  const empty = !isFilterActive(opts.filter) && opts.filter.advanced === null;
  return buildBoardFilterHref({
    boardId: opts.boardId,
    filter: opts.filter,
    boardFilterOff: opts.hasStoredFilter && empty,
  });
}

/** Reset to board filter: the board with no filter params, which IS the board's
 * own filter (MOTIR-11564). */
export function boardFilterResetHref(boardId?: string): string {
  return buildBoardFilterHref({ boardId, filter: EMPTY_FILTER });
}

/** Why a stale condition matches nothing, by what its referent was — one
 * tooltip sentence per kind the board read reports (the settings editor's row
 * keys, MOTIR-11334). */
export type StaleConditionKind = 'label' | 'component' | 'folder' | 'field' | 'option' | 'invalid';

export function staleConditionKind(stale: StoredFilterStaleConditionDto): StaleConditionKind {
  if (stale.reason === 'invalid' || stale.field === null) return 'invalid';
  if (customFieldIdOfFilterField(stale.field) !== null) {
    return stale.reason === 'unknown-field' ? 'field' : 'option';
  }
  if (stale.field === 'lbl') return 'label';
  if (stale.field === 'cmp') return 'component';
  if (stale.field === 'folder') return 'folder';
  return 'invalid';
}

/** One condition's canonical identity — the 6.1.1 encoding of it alone. */
function conditionKey(condition: FilterCondition): string {
  return encodeFilterParam({ combinator: 'and', conditions: [condition] });
}

/**
 * Which of the HEADER's conditions are stale, by their index in `headerAst`.
 * The board read names stale conditions by their position in the STORED
 * envelope; the header may hold them at other positions (an edit removed one
 * before them), so a header condition is stale when it is canonically the same
 * condition as a stale stored one.
 */
export function staleHeaderConditions(
  storedAst: FilterAst | null,
  staleConditions: StoredFilterStaleConditionDto[],
  headerAst: FilterAst | null,
): Map<number, StaleConditionKind> {
  const out = new Map<number, StaleConditionKind>();
  if (!storedAst || !headerAst) return out;
  const staleByKey = new Map<string, StaleConditionKind>();
  for (const stale of staleConditions) {
    const condition = stale.index === null ? undefined : storedAst.conditions[stale.index];
    if (condition) staleByKey.set(conditionKey(condition), staleConditionKind(stale));
  }
  if (staleByKey.size === 0) return out;
  headerAst.conditions.forEach((condition, i) => {
    const kind = staleByKey.get(conditionKey(condition));
    if (kind) out.set(i, kind);
  });
  return out;
}

/** The empty state an EMPTY board shows (MOTIR-11565, design panel 13):
 * - `none`   — nothing narrows the board: the brand-new-board empty state;
 * - `filter` — a header filter on a board with no stored filter (as shipped);
 * - `board`  — the board's own filter leaves nothing;
 * - `reset`  — a header filter that differs from the board filter leaves nothing.
 * `filterParam` is the effective header filter as the board read takes it. */
export type BoardEmptyVariant = 'none' | 'filter' | 'board' | 'reset';

export function boardEmptyVariant(input: {
  storedFilter: StoredBoardFilterDto | null;
  filterParam: string;
  boardFilterOff: boolean;
}): BoardEmptyVariant {
  const { storedFilter, filterParam, boardFilterOff } = input;
  if (!storedFilter) return filterParam ? 'filter' : 'none';
  if (!filterParam) return boardFilterOff ? 'none' : 'board';
  const storedAst = storedFilterAst(storedFilter);
  if (storedAst !== null && currentFilterParam(storedAst) === filterParam) return 'board';
  return 'reset';
}
