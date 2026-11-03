import type { DispatchRunStatus } from '@/generated/prisma/client';
import {
  RUN_RECORD_STATUSES,
  type RunRecordSearchFilters,
} from '@/lib/services/runRecordReadService';
import { DISPATCH_RUN_LIST_MAX_TAKE } from '@/lib/services/dispatchRunService';

// The run-record SEARCH's input rules (MOTIR-10240), in one place so the internal
// route and the MCP tool refuse the same requests with the same words: a string
// or absent for each key, a known status list, a page size the run list allows,
// and ONE of `workItemKey` / `scopeWorkItemKey` — they are two different
// questions (a leg for that card, or the scope of a container run).

export type RunRecordQueryParse =
  | { ok: true; filters: RunRecordSearchFilters }
  | { ok: false; error: string };

function optionalString(v: unknown): string | undefined | false {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return false;
  return v.trim() === '' ? undefined : v.trim();
}

/** Parse a search request body (or tool arguments) into filters, or the reason it is refused. */
export function parseRunRecordQuery(input: Record<string, unknown>): RunRecordQueryParse {
  const workItemKey = optionalString(input['workItemKey']);
  const scopeWorkItemKey = optionalString(input['scopeWorkItemKey']);
  const cursor = optionalString(input['cursor']);
  if (workItemKey === false) return { ok: false, error: '`workItemKey` must be a string.' };
  if (scopeWorkItemKey === false)
    return { ok: false, error: '`scopeWorkItemKey` must be a string.' };
  if (cursor === false) return { ok: false, error: '`cursor` must be a string.' };
  if (workItemKey && scopeWorkItemKey) {
    return {
      ok: false,
      error:
        'Give `workItemKey` (runs that carried a leg for that card) OR `scopeWorkItemKey` ' +
        '(runs scoped to that container), not both.',
    };
  }

  let statuses: DispatchRunStatus[] | undefined;
  const raw = input['statuses'];
  if (raw !== undefined && raw !== null) {
    const known = new Set<string>(RUN_RECORD_STATUSES);
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string' || !known.has(s))) {
      return {
        ok: false,
        error: `\`statuses\` must be a list of run statuses: ${RUN_RECORD_STATUSES.join(', ')}.`,
      };
    }
    statuses = raw as DispatchRunStatus[];
  }

  let limit: number | undefined;
  const rawLimit = input['limit'];
  if (rawLimit !== undefined && rawLimit !== null) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit < 1 ||
      rawLimit > DISPATCH_RUN_LIST_MAX_TAKE
    ) {
      return {
        ok: false,
        error: `\`limit\` must be an integer from 1 to ${DISPATCH_RUN_LIST_MAX_TAKE}.`,
      };
    }
    limit = rawLimit;
  }

  return {
    ok: true,
    filters: {
      ...(workItemKey ? { workItemKey } : {}),
      ...(scopeWorkItemKey ? { scopeWorkItemKey } : {}),
      ...(statuses ? { statuses } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  };
}
