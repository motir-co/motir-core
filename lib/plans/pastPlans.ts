import {
  PLAN_STATUS_DTO_VALUES,
  type PlanDecisionReasonDto,
  type PlanDto,
  type PlanStatusDto,
  type PlanWithItemsDto,
} from '@/lib/dto/plans';

// The PAST-PLANS read (MOTIR-10241) — a planning session asking how similar work
// was shaped before, and why a plan was declined. Its input rules and its row
// shape live here, in one place, so the job-token route
// (`app/api/internal/ai/past-plans`) and the `search_past_plans` MCP tool refuse
// the same requests with the same words and answer the same rows.
//
// The REASON a decline carries is what core stores: the `decisionReason` KIND
// (`reviewed`, `discarded`, `abandoned`; null on an old row) beside the plan's
// `summary` and its decision time. Core stores no free-text decline note, so none
// is invented here.

/** Page size bounds — the internal route refuses anything outside them (400). */
export const PAST_PLANS_MIN_LIMIT = 1;
export const PAST_PLANS_MAX_LIMIT = 50;
export const PAST_PLANS_DEFAULT_LIMIT = 20;
/** Longest `q` a search takes; a longer one is refused rather than cut. */
export const PAST_PLANS_QUERY_MAX = 200;
/** Characters of `summary` a search row carries; the read-one returns it whole. */
export const PAST_PLAN_SUMMARY_EXCERPT_MAX = 500;

export interface PastPlanSearchFilters {
  q: string | null;
  statuses: PlanStatusDto[] | null;
  cursor: string | null;
  limit: number;
}

export type PastPlanQueryParse =
  | { ok: true; filters: PastPlanSearchFilters }
  | { ok: false; error: string };

/** One search row: the plan's metadata and a bounded summary excerpt — never its proposals. */
export interface PastPlanRow {
  id: string;
  title: string | null;
  status: PlanStatusDto;
  decisionReason: PlanDecisionReasonDto | null;
  summaryExcerpt: string | null;
  summaryTruncated: boolean;
  itemCount: number;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
}

export interface PastPlanSearchResult {
  outcome: 'ok' | 'nothing-matched';
  plans: PastPlanRow[];
  nextCursor: string | null;
}

export interface PastPlanReadResult {
  plan: PlanWithItemsDto;
}

const KNOWN_STATUSES = new Set<string>(PLAN_STATUS_DTO_VALUES);

function optionalString(v: unknown): string | null | false {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return false;
  const t = v.trim();
  return t === '' ? null : t;
}

/**
 * Parse a search request into filters, or the reason it is refused. `status` is a
 * list (the route splits its comma form first); `limit` a whole number in
 * 1–{@link PAST_PLANS_MAX_LIMIT}, defaulting to {@link PAST_PLANS_DEFAULT_LIMIT}.
 */
export function parsePastPlanQuery(input: {
  q?: unknown;
  status?: unknown;
  cursor?: unknown;
  limit?: unknown;
}): PastPlanQueryParse {
  const q = optionalString(input.q);
  if (q === false) return { ok: false, error: '`q` must be a string.' };
  if (q !== null && q.length > PAST_PLANS_QUERY_MAX) {
    return { ok: false, error: `\`q\` must be at most ${PAST_PLANS_QUERY_MAX} characters.` };
  }
  const cursor = optionalString(input.cursor);
  if (cursor === false) return { ok: false, error: '`cursor` must be a string.' };

  let statuses: PlanStatusDto[] | null = null;
  if (input.status !== undefined && input.status !== null) {
    if (!Array.isArray(input.status) || input.status.some((s) => typeof s !== 'string')) {
      return { ok: false, error: '`status` must be a list of plan statuses.' };
    }
    const named = (input.status as string[]).map((s) => s.trim()).filter((s) => s !== '');
    const unknown = named.filter((s) => !KNOWN_STATUSES.has(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Unknown plan status ${unknown.map((s) => `"${s}"`).join(', ')}; expected ${PLAN_STATUS_DTO_VALUES.join(', ')}.`,
      };
    }
    statuses = named.length === 0 ? null : [...new Set(named)].map((s) => s as PlanStatusDto);
  }

  let limit = PAST_PLANS_DEFAULT_LIMIT;
  if (input.limit !== undefined && input.limit !== null) {
    const n = typeof input.limit === 'string' ? Number(input.limit.trim()) : input.limit;
    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < PAST_PLANS_MIN_LIMIT ||
      n > PAST_PLANS_MAX_LIMIT
    ) {
      return {
        ok: false,
        error: `\`limit\` must be a whole number from ${PAST_PLANS_MIN_LIMIT} to ${PAST_PLANS_MAX_LIMIT}.`,
      };
    }
    limit = n;
  }

  return { ok: true, filters: { q, statuses, cursor, limit } };
}

/** A list-row plan DTO as a search row: metadata and a bounded summary excerpt. */
export function toPastPlanRow(plan: PlanDto): PastPlanRow {
  const summary = plan.summary;
  const truncated = summary !== null && summary.length > PAST_PLAN_SUMMARY_EXCERPT_MAX;
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    decisionReason: plan.decisionReason,
    summaryExcerpt: truncated ? summary.slice(0, PAST_PLAN_SUMMARY_EXCERPT_MAX) : summary,
    summaryTruncated: truncated,
    itemCount: plan.itemCount,
    createdAt: plan.createdAt,
    plannedAt: plan.plannedAt,
    decidedAt: plan.decidedAt,
  };
}
