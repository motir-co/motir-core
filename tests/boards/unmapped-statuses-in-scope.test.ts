import { describe, expect, it } from 'vitest';
import { unmappedStatusesInScope } from '@/lib/boards/unmappedStatusesInScope';
import type { FilterAst, FilterCondition } from '@/lib/filters/ast';

// The narrowing rule behind the board's unmapped-statuses tray (MOTIR-11658),
// pure: a status leaves the tray only when the effective filter is an AND whose
// `status` row provably excludes it. Every other shape keeps every status.

const DONE = { key: 'done', label: 'Done' };
const CANCELLED = { key: 'cancelled', label: 'Cancelled' };
const UNMAPPED = [DONE, CANCELLED];

const OPEN = ['todo', 'in_progress', 'in_review', 'blocked', 'implemented', 'planning', 'approved'];
const BUGS: FilterCondition = { field: 'kind', operator: 'is_any_of', value: ['bug'] };
const status = (operator: FilterCondition['operator'], value: string[]): FilterCondition => ({
  field: 'status',
  operator,
  value,
});
const and = (...conditions: FilterCondition[]): FilterAst => ({ combinator: 'and', conditions });
const or = (...conditions: FilterCondition[]): FilterAst => ({ combinator: 'or', conditions });

describe('unmappedStatusesInScope (MOTIR-11658)', () => {
  it('drops every unmapped status an AND-ed `is any of` status row leaves out (criterion 1)', () => {
    expect(unmappedStatusesInScope(UNMAPPED, and(BUGS, status('is_any_of', OPEN)))).toEqual([]);
  });

  it('keeps an unmapped status the `is any of` list names (criterion 2)', () => {
    expect(
      unmappedStatusesInScope(UNMAPPED, and(status('is_any_of', [...OPEN, 'done']), BUGS)),
    ).toEqual([DONE]);
  });

  it('drops only the status an `is none of` row names (criterion 3)', () => {
    expect(unmappedStatusesInScope(UNMAPPED, and(status('is_none_of', ['cancelled'])))).toEqual([
      DONE,
    ]);
  });

  it('keeps every unmapped status with no filter (criterion 4)', () => {
    expect(unmappedStatusesInScope(UNMAPPED, undefined)).toEqual(UNMAPPED);
  });

  it('keeps every unmapped status when the filter has no status row (criterion 5)', () => {
    expect(unmappedStatusesInScope(UNMAPPED, and(BUGS))).toEqual(UNMAPPED);
  });

  it('does not narrow under an OR combinator, even with an excluding status row (criterion 6)', () => {
    expect(unmappedStatusesInScope(UNMAPPED, or(BUGS, status('is_any_of', OPEN)))).toEqual(
      UNMAPPED,
    );
    expect(unmappedStatusesInScope(UNMAPPED, or(status('is_none_of', ['done'])))).toEqual(UNMAPPED);
  });

  it('excludes a status when ANY of several AND-ed status rows excludes it', () => {
    expect(
      unmappedStatusesInScope(
        UNMAPPED,
        and(status('is_any_of', [...OPEN, 'done', 'cancelled']), status('is_none_of', ['done'])),
      ),
    ).toEqual([CANCELLED]);
  });

  it('keeps a status when the status row uses an operator that proves nothing', () => {
    expect(unmappedStatusesInScope(UNMAPPED, and(status('is_not_empty', [])))).toEqual(UNMAPPED);
    expect(
      unmappedStatusesInScope(
        UNMAPPED,
        and({ field: 'status', operator: 'is_empty', value: null }),
      ),
    ).toEqual(UNMAPPED);
  });

  it('keeps an empty unmapped list empty, preserves order and never mutates its input', () => {
    expect(unmappedStatusesInScope([], and(status('is_any_of', OPEN)))).toEqual([]);
    const input = [CANCELLED, DONE];
    const out = unmappedStatusesInScope(input, undefined);
    expect(out).toEqual([CANCELLED, DONE]);
    expect(out).not.toBe(input);
  });
});
