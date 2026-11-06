import type { PlannerFindingListFilters } from '@/lib/dto/plannerFindings';
import { oneParam } from './filterKeys';

type Params = Record<string, string | string[] | undefined>;

/**
 * The URL → the read service's list filters. Source, planner, outcome and
 * attribution pass through as given (the service drops a value outside its
 * closed set). The triage-state filter has three settings: `dismissed`, `all`,
 * and the default, which sends NO status — the service owns the default that
 * hides dismissed findings, and the page must not repeat it. Absent keys are
 * omitted, never sent as empty strings.
 */
export function toListFilters(params: Params): PlannerFindingListFilters {
  const state = oneParam(params['state']);
  const pass = (key: 'source' | 'planner' | 'outcome' | 'attribution') => {
    const value = oneParam(params[key]);
    return value ? { [key]: value } : {};
  };
  const cursor = oneParam(params['cursor']);
  return {
    ...pass('source'),
    ...pass('planner'),
    ...pass('outcome'),
    ...pass('attribution'),
    ...(state === 'dismissed' || state === 'all' ? { status: state } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
