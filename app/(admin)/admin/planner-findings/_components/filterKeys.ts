/**
 * The findings list's URL filter keys. A plain module, not the client
 * `FindingFilters`: the server page reads them too, and a value exported from a
 * `'use client'` file reaches a Server Component only as a client reference,
 * never as the array (the `planning-lessons/_components/filterKeys.ts` rule).
 *
 * `view` is NOT a filter key: the pager, the filter pushes and the chips keep it.
 */
export const FINDING_FILTER_KEYS = [
  'source',
  'planner',
  'outcome',
  'attribution',
  'state',
] as const;
export type FindingFilterKey = (typeof FINDING_FILTER_KEYS)[number];

/** The list's page size, as the read service pages it (`PLANNER_FINDINGS_PAGE_SIZE`). */
export const FINDINGS_PAGE_SIZE = 50;

type Params = Record<string, string | string[] | undefined>;

/** One trimmed, non-empty URL value; an array value takes its first entry. */
export function oneParam(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** True when any filter key is set: the empty page is then "no match", not "empty". */
export function hasFindingFilter(params: Params): boolean {
  return FINDING_FILTER_KEYS.some((key) => oneParam(params[key]) !== undefined);
}

/** The view the URL asks for: absent (or anything else) is grouped. */
export function findingsView(params: Params): 'grouped' | 'all' {
  return oneParam(params['view']) === 'all' ? 'all' : 'grouped';
}
