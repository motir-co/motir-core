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
  /**
   * The record — the one plan check — the finding belongs to (MOTIR-11463). The
   * store makes the relation required and backfilled every finding onto one;
   * `''` only when a motir-ai deployed before records answers none.
   */
  recordId: string;
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

// ── The console's RECORDS (Story MOTIR-11455 · Subtask MOTIR-11463) ─────────
//
// What crosses from `plannerFindingRecordsConsoleService` to the Records view and
// the record page (design MOTIR-11470 · MOTIR-11509 · MOTIR-11591). As above, the
// wire strings pass through as they came. The check's answer, its stop cards and
// each finding's `bugKey` are rendered as stored: nothing here defaults, derives
// or resolves one. A record carries no key set of its own — a key lives on its
// finding — so no DTO below declares one.

export const PLANNER_FINDING_VERDICT_STATE_VALUES = ['open', 'attributed'] as const;

/** One record: the plan check's context, its verdict and the check's run-through answer. */
export interface PlannerFindingRecordDTO {
  id: string;
  source: string;
  planner: string;
  planId: string;
  planTitle: string | null;
  planSessionId: string | null;
  jobId: string | null;
  authorModel: string | null;
  baselineBranch: string | null;
  baselineCommit: string | null;
  verdictState: string;
  /** The core user id of whoever gave the verdict. */
  verdictBy: string | null;
  /** ISO string. */
  verdictAt: string | null;
  /** `THRU`, `STOPS`, or null when no check sent an answer — never defaulted. */
  runThroughAnswer: string | null;
  /** The stop cards in stored order; `[]` when there are none. */
  runThroughStopCards: string[];
  /** ISO string. */
  createdAt: string;
}

/** One record as a Records-view row: the record plus its two counts. */
export interface PlannerFindingRecordRowDTO extends PlannerFindingRecordDTO {
  findingCount: number;
  attributedCount: number;
}

/** One finding of a record, as the record page's findings table draws it. */
export interface PlannerFindingRecordFindingDTO {
  id: string;
  site: string;
  prediction: string;
  outcome: string;
  /** Null when the finding carries none — the record page decides whether it is drawn at all. */
  attribution: string | null;
  why: string | null;
  hostedCell: string | null;
  planpyCell: string | null;
  /** The finding's own planning-bug key as stored text, never resolved. */
  bugKey: string | null;
}

/** One record in full, with its findings in stored order. */
export interface PlannerFindingRecordDetailDTO {
  record: PlannerFindingRecordDTO;
  findings: PlannerFindingRecordFindingDTO[];
}

export interface PlannerFindingRecordListDTO {
  records: PlannerFindingRecordRowDTO[];
  nextCursor: string | null;
}

/**
 * The Records view's filters, as the page reads them from the URL. The console
 * service drops a value outside its closed set rather than sending it.
 */
export interface PlannerFindingRecordListFilters {
  verdict?: string;
  planner?: string;
  source?: string;
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
