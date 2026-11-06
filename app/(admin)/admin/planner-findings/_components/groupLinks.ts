import { FINDING_FILTER_KEYS, oneParam } from './filterKeys';

type Params = Record<string, string | string[] | undefined>;

const BASE = '/admin/planner-findings';

function filterQuery(params: Params, extra: Record<string, string> = {}): string {
  const url = new URLSearchParams();
  for (const key of FINDING_FILTER_KEYS) {
    const value = oneParam(params[key]);
    if (value) url.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) url.set(key, value);
  return url.toString();
}

/**
 * A group's page, opened from the grouped view. It carries the five filter keys
 * and nothing else — no view, cursor or trail — and the group page reads them
 * back through the same `toListFilters`, so the findings it opens are exactly
 * the ones its count was computed over.
 */
export function groupHref(fingerprint: string, params: Params): string {
  const path = `${BASE}/groups/${encodeURIComponent(fingerprint)}`;
  const qs = filterQuery(params);
  return qs ? `${path}?${qs}` : path;
}

/** A group page's way back: the grouped view, with the filters kept. */
export function groupBackHref(params: Params): string {
  return `${BASE}?${filterQuery(params, { view: 'grouped' })}`;
}
