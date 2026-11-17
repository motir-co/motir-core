/**
 * The findings list's URL filter keys. A plain module, not the client
 * `FindingFilters`: the server page reads them too, and a value exported from a
 * `'use client'` file reaches a Server Component only as a client reference,
 * never as the array (the `planning-lessons/_components/filterKeys.ts` rule).
 *
 * `view` is NOT a filter key: the pager, the filter pushes and the chips keep it.
 *
 * `verdict` is the Records view's own key (MOTIR-11463): it is in this ONE list so
 * the pager keeps it and a set verdict makes an empty Records page a no-match
 * rather than an empty store. `state` already means a finding's triage state, so
 * the record view never reuses it.
 */
export const FINDING_FILTER_KEYS = [
  'source',
  'planner',
  'outcome',
  'attribution',
  'state',
  'verdict',
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

/**
 * True when any FINDING filter key is set: the empty page is then "no match", not
 * "empty". `verdict` is the Records view's and the findings read ignores it, so a
 * verdict the switch carried over never turns an empty store into a no-match.
 */
export function hasFindingFilter(params: Params): boolean {
  return FINDING_FILTER_KEYS.some(
    (key) => key !== 'verdict' && oneParam(params[key]) !== undefined,
  );
}

/**
 * The Records view's filter keys (MOTIR-11463): the subset of the list above the
 * record read takes. The record filters, their chips and the record query read
 * only these, so a finding-only key the view switch carried over is dropped.
 */
export const RECORD_FILTER_KEYS = ['verdict', 'planner', 'source'] as const;
export type RecordFilterKey = (typeof RECORD_FILTER_KEYS)[number];

/** True when any RECORD filter key is set: a stale finding key never makes a no-match. */
export function hasRecordFilter(params: Params): boolean {
  return RECORD_FILTER_KEYS.some((key) => oneParam(params[key]) !== undefined);
}

export type FindingsView = 'grouped' | 'all' | 'records';

/** The view the URL asks for: absent (or anything else) is grouped. */
export function findingsView(params: Params): FindingsView {
  const view = oneParam(params['view']);
  return view === 'all' || view === 'records' ? view : 'grouped';
}
