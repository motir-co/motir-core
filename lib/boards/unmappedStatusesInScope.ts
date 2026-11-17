// The unmapped statuses a board still has to WARN about (MOTIR-11658). Pure, so
// the rule is unit-testable on its own and the board read can apply it to the
// filter it already resolved.
//
// The unmapped-statuses tray exists so a work item is never SILENTLY dropped by
// a missing column mapping. An item the board's filter would have excluded
// anyway is not dropped by the mapping, so its status needs no warning — the
// "Bugs to fix" board filters to the open statuses and leaves Done and
// Cancelled off its columns on purpose, and warned about both.
//
// The rule narrows ONLY on proof. A status leaves the list only when the
// effective filter (MOTIR-11564: the header filter, else the board's stored
// filter, unless `boardFilter=off`) is an AND of conditions and one of those
// conditions is on `status` and excludes it — `is_any_of` a list without it, or
// `is_none_of` a list with it. Every other shape keeps every status: no filter,
// an OR combinator (one row matching is enough, so a status row proves
// nothing), a status row with any other operator, a filter that no longer reads
// (the caller passes no AST), or no status row at all. When in doubt, warn.

import type { FilterAst, FilterCondition } from '@/lib/filters/ast';

/** Whether ONE condition proves a status (by key) cannot match. */
function conditionExcludesStatus(condition: FilterCondition, statusKey: string): boolean {
  if (condition.field !== 'status' || !Array.isArray(condition.value)) return false;
  const listed = (condition.value as string[]).includes(statusKey);
  if (condition.operator === 'is_any_of') return !listed;
  if (condition.operator === 'is_none_of') return listed;
  return false;
}

/**
 * The subset of `unmapped` the board's effective filter could still match — the
 * statuses the board's tray names. `ast` is the effective filter's AST, or
 * `undefined` when no filter applies or the applied one cannot be read (a
 * stored filter that narrows the board to nothing), and then every unmapped
 * status is kept. Order is preserved.
 */
export function unmappedStatusesInScope<S extends { key: string }>(
  unmapped: readonly S[],
  ast: FilterAst | undefined,
): S[] {
  if (!ast || ast.combinator !== 'and') return [...unmapped];
  const statusConditions = ast.conditions.filter((c) => c.field === 'status');
  if (statusConditions.length === 0) return [...unmapped];
  return unmapped.filter(
    (status) => !statusConditions.some((c) => conditionExcludesStatus(c, status.key)),
  );
}
