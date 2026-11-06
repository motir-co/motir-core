// The planner-findings DTO (Story MOTIR-10354 · Subtask MOTIR-10386).
//
// What `plannerFindingsService.recordFinding` answers: the stored finding's
// identity and the three fields the store computed or fixed, mapped off
// motir-ai's raw row so the row itself never leaks to the MCP tool.

/** One finding as it was stored in motir-ai's findings store. */
export interface RecordedPlannerFindingDTO {
  /** The stored finding's id in motir-ai. */
  id: string;
  /** Always `check_plan` for a finding recorded through motir-core. */
  source: string;
  /** Computed upstream from the site and attribution; groups repeats of one defect. */
  fingerprint: string;
  /** The triage status; a new finding is `new`. */
  status: string;
}

// ── The planner-findings console (Story MOTIR-10353 · Subtask MOTIR-10517) ──
//
// What crosses from the findings read and triage services to
// `/admin/planner-findings` (design MOTIR-10362, `platform-admin/design-notes.md`
// § AMENDMENT 2026-11-04 — Planner findings). No `server-only` import: a filter
// select or a triage control imports the value arrays below at runtime.
//
// The rows keep the wire's own strings — `source`, `planner`, `prediction`,
// `outcome`, `status` and `attribution` are `string`, as the lesson row's
// `mistakeType` is — so a value a newer motir-ai adds shows as it came rather
// than being coerced to a plausible member. The pages label the members they
// know. The arrays serve filters and controls only, and
// `tests/platform/plannerFindingMappers.test.ts` holds each one equal to the
// client's set in `lib/ai/motirAiClient.ts`, member for member.

export const PLANNER_FINDING_SOURCE_VALUES = ['in_loop', 'check_plan'] as const;
export const PLANNER_FINDING_PLANNER_VALUES = ['hosted', 'plan_py'] as const;
export const PLANNER_FINDING_PREDICTION_VALUES = ['STOPS', 'SETTLES', 'THRU'] as const;
export const PLANNER_FINDING_OUTCOME_VALUES = ['fixed', 'reported', 'fix_failed'] as const;
export const PLANNER_FINDING_ATTRIBUTION_VALUES = [
  'code',
  'corpus',
  'model',
  'unattributed',
] as const;
export const PLANNER_FINDING_STATUS_VALUES = [
  'new',
  'promoted_to_lesson',
  'filed_as_bug',
  'dismissed',
] as const;

export type PlannerFindingAttributionValue = (typeof PLANNER_FINDING_ATTRIBUTION_VALUES)[number];

/** One finding as a list row. */
export interface PlannerFindingRowDTO {
  id: string;
  source: string;
  planner: string;
  /** A NULL attribution upstream reads `unattributed`, as motir-ai's own filter and fingerprint read it. */
  attribution: string;
  outcome: string;
  prediction: string;
  site: string;
  planId: string;
  planTitle: string | null;
  status: string;
  fingerprint: string;
  lessonId: string | null;
  bugKey: string | null;
  /** ISO string. */
  createdAt: string;
}

/** One defect — every finding sharing a fingerprint. */
export interface PlannerFindingGroupRowDTO {
  fingerprint: string;
  findingCount: number;
  /** Distinct plans the defect was found in. */
  planCount: number;
  latest: PlannerFindingRowDTO;
}

/** One stage's spend on the finding's plan dry run. */
export interface PlannerFindingCostLineDTO {
  stage: 'review' | 'repair';
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  /** Null means unpriced — never zero. */
  costMicroUsd: number | null;
}

/** The plan's dry-run cost, as the read service decided it. */
export interface PlannerFindingCostDTO {
  findingsMade: number | null;
  findingsFixed: number | null;
  lines: PlannerFindingCostLineDTO[];
}

/** One finding in full. */
export interface PlannerFindingDetailDTO extends PlannerFindingRowDTO {
  whatHappened: string;
  evidence: string;
  correction: string | null;
  rule: string | null;
  why: string | null;
  hostedCell: string | null;
  planpyCell: string | null;
  fixDirection: string | null;
  cardRef: string | null;
  coreProjectId: string;
  authorModel: string | null;
  baselineBranch: string | null;
  baselineCommit: string | null;
  triageNote: string | null;
  triagedBy: string | null;
  /** ISO string. */
  triagedAt: string | null;
  /** Null when the plan has no metered dry run — the service decides; the mapper never invents a zero. */
  cost: PlannerFindingCostDTO | null;
}

/** The admin read's retention window. */
export interface PlannerFindingRetentionDTO {
  days: number;
  /** ISO string; null when the read named its own dates. */
  cutoff: string | null;
}

export interface PlannerFindingListDTO {
  findings: PlannerFindingRowDTO[];
  nextCursor: string | null;
  retention: PlannerFindingRetentionDTO;
}

export interface PlannerFindingGroupListDTO {
  groups: PlannerFindingGroupRowDTO[];
  nextCursor: string | null;
  retention: PlannerFindingRetentionDTO;
}

/**
 * The console's filters. An absent `status` is the default view (dismissed
 * findings hidden); the literal `'all'` is every status; any other value is
 * that one status.
 */
export interface PlannerFindingListFilters {
  source?: string;
  planner?: string;
  attribution?: string;
  outcome?: string;
  status?: string;
  fingerprint?: string;
  cursor?: string;
}

/** One triage act, as the console's actions pass it to the triage service. */
export type PlannerFindingTriageInput =
  | {
      kind: 'attribution';
      attribution: PlannerFindingAttributionValue;
      why?: string;
      hostedCell?: string;
      planpyCell?: string;
      fixDirection?: string;
    }
  | { kind: 'promote'; lessonId: string }
  | { kind: 'bug'; bugKey: string }
  | { kind: 'dismiss'; note?: string }
  | { kind: 'restore' };

/** The audit row's `metadata` for `planner_finding.triage`: the changed fields only. */
export interface PlannerFindingAuditMetadata {
  findingId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}
