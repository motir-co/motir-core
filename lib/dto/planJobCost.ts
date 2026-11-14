// What one hosted plan job cost (MOTIR-10815, task MOTIR-10789) — the block a
// plan read carries when the plan came from a motir-ai job.
//
// ⚠️ AN UNKNOWN FIGURE IS `null`, NEVER `0`. Each figure is motir-ai's own
// answer (`GET /v1/jobs/:id/cost`, motir-ai `docs/contract.md` §2.4), copied
// through when it is a finite number and `null` otherwise. Core never sums,
// defaults or recomputes one: a kind reads `0` only because motir-ai answered
// `0`, which it does only when its ledger is complete. A read that did not
// answer — not found, an outage, motir-ai not configured — is the all-null
// block, so it can never pass for a job that cost nothing.

/** The session kinds motir-ai prices a planning job's sessions by. `amend`,
 *  `check` and `repair` (MOTIR-11256) are a level's amend, the plan's final check
 *  and the fix after it, which were priced under `lay` and `tool` before. A job
 *  priced before that reads `0` for them only when motir-ai answers `0`. */
export const PLAN_JOB_SESSION_KINDS = [
  'conversation',
  'lay',
  'author',
  'entry_author',
  'tool',
  'amend',
  'check',
  'repair',
] as const;

export type PlanJobSessionKind = (typeof PLAN_JOB_SESSION_KINDS)[number];

export interface PlanJobCostDto {
  /** motir-ai's verdict that every session is in the figures; `null` when it did not answer. */
  ledgerComplete: boolean | null;
  /** The job's session cost in micro-USD, as motir-ai summed it. */
  totalCostMicroUsd: number | null;
  /** The credits the job was charged. */
  credits: number | null;
  bySessionKind: Record<PlanJobSessionKind, number | null>;
}

/** The block for a cost read that did not answer: every figure unknown. */
export const UNKNOWN_PLAN_JOB_COST: Readonly<PlanJobCostDto> = Object.freeze({
  ledgerComplete: null,
  totalCostMicroUsd: null,
  credits: null,
  bySessionKind: Object.freeze({
    conversation: null,
    lay: null,
    author: null,
    entry_author: null,
    tool: null,
    amend: null,
    check: null,
    repair: null,
  }),
});
