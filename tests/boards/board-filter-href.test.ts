import { describe, expect, it } from 'vitest';
import { appendBoardReadFilter, buildBoardFilterHref } from '@/lib/boards/boardFilterHref';
import { isBoardFilterOff } from '@/lib/boards/boardFilterOff';
import { readBoardFilterInput } from '@/lib/boards/boardPageHttp';
import { encodeFilterParam } from '@/lib/filters/ast';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';

// The board-scoped filter URL contract (Story 6.15 · Subtask 6.15.3). The board
// reuses the /items filter components but must serialize their state WITHOUT
// dropping the `?board=` selection (which `buildIssueListHref` would). These
// assert the board href: `?board=` preserved + lead, the facets + advanced param
// appended in canonical order, `?peek=` never carried, empty → clean `/boards`.

describe('buildBoardFilterHref', () => {
  it('returns clean /boards when no board + no filter', () => {
    expect(buildBoardFilterHref({ filter: EMPTY_FILTER })).toBe('/boards');
  });

  it('preserves the ?board= selection when no filter is set', () => {
    expect(buildBoardFilterHref({ boardId: 'brd_1', filter: EMPTY_FILTER })).toBe(
      '/boards?board=brd_1',
    );
  });

  it('appends a facet, leading with ?board= (per board)', () => {
    const filter: IssueFilter = { ...EMPTY_FILTER, kinds: ['bug'] };
    expect(buildBoardFilterHref({ boardId: 'brd_1', filter })).toBe('/boards?board=brd_1&kind=bug');
  });

  it('serializes every facet axis + the advanced param in canonical order', () => {
    const filter: IssueFilter = {
      kinds: ['bug'],
      types: ['code'],
      includeUntyped: true,
      statuses: ['in_progress'],
      assigneeIds: ['u1'],
      includeUnassigned: true,
      text: 'login',
      advanced: 'v1:abc',
    };
    const href = buildBoardFilterHref({ boardId: 'brd_1', filter });
    expect(href).toBe(
      '/boards?board=brd_1&kind=bug&type=code&type=untyped&status=in_progress&assignee=u1&assignee=unassigned&q=login&filter=v1%3Aabc',
    );
  });

  it('omits ?board= when no board is selected (project default), still appending the filter', () => {
    const filter: IssueFilter = { ...EMPTY_FILTER, statuses: ['done'] };
    expect(buildBoardFilterHref({ filter })).toBe('/boards?status=done');
  });

  it('never carries a peek param (the filter components do not pass one)', () => {
    // buildBoardFilterHref only knows board + filter — there is no peek input, so
    // a filter navigation can never re-emit `?peek=`. (Documents the design
    // decision: a filter edit happens from the toolbar, not over a peek modal.)
    const href = buildBoardFilterHref({ boardId: 'brd_1', filter: { ...EMPTY_FILTER, text: 'x' } });
    expect(href).not.toContain('peek');
  });
});

// The stored-filter-off signal (MOTIR-11564): `?boardFilter=off` on the page URL
// and on every board read, so a reader who removed every condition sees the
// board's whole scope rather than its stored filter.
describe('the boardFilter=off signal', () => {
  const tasks = encodeFilterParam({
    combinator: 'and',
    conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
  });

  it('buildBoardFilterHref emits it last, after the selection and the filter params', () => {
    expect(buildBoardFilterHref({ filter: EMPTY_FILTER, boardFilterOff: true })).toBe(
      '/boards?boardFilter=off',
    );
    expect(
      buildBoardFilterHref({
        boardId: 'brd_1',
        filter: { ...EMPTY_FILTER, kinds: ['bug'] },
        boardFilterOff: true,
      }),
    ).toBe('/boards?board=brd_1&kind=bug&boardFilter=off');
    expect(
      buildBoardFilterHref({ boardId: 'brd_1', filter: EMPTY_FILTER, boardFilterOff: false }),
    ).toBe('/boards?board=brd_1');
  });

  it('appendBoardReadFilter puts the filter and the off signal on a read query', () => {
    const none = new URLSearchParams({ boardId: 'b' });
    appendBoardReadFilter(none, {});
    expect(none.toString()).toBe('boardId=b');

    const both = new URLSearchParams({ boardId: 'b' });
    appendBoardReadFilter(both, { filterParam: tasks, boardFilterOff: true });
    expect(both.get('filter')).toBe(tasks);
    expect(both.get('boardFilter')).toBe('off');
  });

  it('isBoardFilterOff is true for exactly `off`, first value of a list', () => {
    expect(isBoardFilterOff('off')).toBe(true);
    expect(isBoardFilterOff(['off', 'on'])).toBe(true);
    for (const raw of [undefined, null, '', 'on', 'OFF', ['on', 'off']]) {
      expect(isBoardFilterOff(raw)).toBe(false);
    }
  });

  it('readBoardFilterInput parses the header filter and the off signal, each on its own', () => {
    const read = (qs: string) => readBoardFilterInput(new URLSearchParams(qs));
    expect(read('')).toBeUndefined();
    expect(read('boardFilter=on')).toBeUndefined();
    expect(read('filter=not-a-valid-param')).toBeUndefined();
    expect(read('boardFilter=off')).toEqual({ storedFilterOff: true });
    expect(read(`filter=${encodeURIComponent(tasks)}`)).toEqual({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
      },
    });
    expect(read(`filter=${encodeURIComponent(tasks)}&boardFilter=off`)).toMatchObject({
      storedFilterOff: true,
      ast: { combinator: 'and' },
    });
  });
});
