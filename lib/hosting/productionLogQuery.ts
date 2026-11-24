import { InvalidLogLimitError, InvalidLogRangeError } from './errors';

// THE PRODUCTION LOGS QUERY (Story MOTIR-9799 · MOTIR-12105): the route's query
// string parsed into what the logs service asks the deploy port for. Pure, no
// I/O. A malformed `since` / `until` / `limit` is a typed error the route maps
// to a stable 400; a `limit` past the ceiling is clamped, not refused.

/** Lines a page holds when the request names no limit, and the most it may. */
export const LOG_LIMIT_DEFAULT = 200;
export const LOG_LIMIT_MAX = 1000;

export interface ProductionLogQuery {
  readonly since?: Date;
  readonly until?: Date;
  /** Kept only when the masked message still contains it, case-insensitively. */
  readonly filter?: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** The query as the route receives it: each parameter's raw value, or null. */
export interface RawProductionLogQuery {
  readonly since?: string | null;
  readonly until?: string | null;
  readonly q?: string | null;
  readonly limit?: string | null;
  readonly cursor?: string | null;
}

/** An ISO 8601 instant with an explicit date — `Date.parse` alone takes forms
 *  like `1` or `March 7` that no client means. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function instant(raw: string | null | undefined, field: 'since' | 'until'): Date | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (!ISO_INSTANT.test(raw)) throw new InvalidLogRangeError(field);
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new InvalidLogRangeError(field);
  return at;
}

/** The line limit: the default when absent, at most the ceiling. */
export function logLimit(limit: number | null | undefined): number {
  if (limit === null || limit === undefined) return LOG_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) throw new InvalidLogLimitError();
  return Math.min(limit, LOG_LIMIT_MAX);
}

/** The route's query string as a logs query, or a typed 400. */
export function parseProductionLogQuery(raw: RawProductionLogQuery): ProductionLogQuery {
  const since = instant(raw.since, 'since');
  const until = instant(raw.until, 'until');
  if (since && until && until.getTime() < since.getTime()) {
    throw new InvalidLogRangeError('until');
  }
  let limit: number | null = null;
  if (raw.limit !== null && raw.limit !== undefined) {
    if (!/^\d+$/.test(raw.limit)) throw new InvalidLogLimitError();
    limit = Number(raw.limit);
  }
  const filter = raw.q ? raw.q : undefined;
  return {
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(filter ? { filter } : {}),
    limit: logLimit(limit),
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
}
