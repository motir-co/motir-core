import type {
  PlannerFindingListFilters,
  PlannerFindingRecordListFilters,
} from '@/lib/dto/plannerFindings';
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

/**
 * The URL → the Records view's filters (MOTIR-11463). Only the three record keys
 * and the cursor are read — a finding filter the view switch carried over is
 * dropped here — and passed as given: the console service drops a value outside
 * its closed set rather than sending it. Absent keys are omitted.
 */
export function toRecordListFilters(params: Params): PlannerFindingRecordListFilters {
  const out: PlannerFindingRecordListFilters = {};
  for (const key of ['verdict', 'planner', 'source', 'cursor'] as const) {
    const value = oneParam(params[key]);
    if (value) out[key] = value;
  }
  return out;
}
