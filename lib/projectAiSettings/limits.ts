// Bounds for the project AI-planning settings (Story 7.13 · Subtask MOTIR-915).
// Kept in their OWN dependency-free module — exactly like
// `lib/publicProjects/limits.ts` — so BOTH the server write path
// (`projectAiSettingsService`, which validates against them and throws a typed
// error) AND the AI-settings panel (MOTIR-919, which bounds its number inputs in
// the browser) import the SAME numbers without the client bundle pulling in the
// service layer (and `db`).
//
// These are APP-LEVEL bounds, not schema mirrors: the columns are plain
// `INTEGER`/`TEXT` with defaults, and an out-of-range value is REJECTED with a
// typed 422 rather than silently clamped at the DB — the same posture every other
// project-settings column here takes (`estimationService`'s scale validation,
// `projectsService`'s public-field caps).

// The auto-expand ready-set low-water mark must be at least 1. A threshold of 0
// could never fire (a ready-set size is never negative), so it is a
// misconfiguration rather than a way to switch the feature off —
// `aiAutoPlanEnabled` is. The upper bound is generous: a large project may well
// want to keep a deep ready set, and an over-large threshold merely means
// "expand often", which the cadence engine's own run-gating (MOTIR-916) absorbs.
export const AI_AUTO_PLAN_THRESHOLD_MIN = 1;
export const AI_AUTO_PLAN_THRESHOLD_MAX = 1_000;

// The AI-packed sprint length, in days. The DEFAULT is 2 — the deliberate,
// recorded deviation from the mirror's 1–4 WEEK sprint, because Motir's executor
// is a coding agent that lands a subtask in tens of minutes, so a two-week sprint
// would hold months of throughput and make the cadence meaningless. The RANGE
// still reaches 14 so a human-paced team can stretch it to a fortnight without
// the column degenerating into a free-form integer.
export const AI_SPRINT_LENGTH_DAYS_MIN = 1;
export const AI_SPRINT_LENGTH_DAYS_MAX = 14;

// ── The "Record planning mistakes" default (Story MOTIR-3331 · MOTIR-3349) ────
//
// Unlike everything above, this is not a BOUND — it is the resolution of an
// UNSET column, and it lives here because this is the one dependency-free module
// both the server write path and the browser panel already import, and because a
// second copy of this rule is exactly the failure it exists to prevent.
//
// `Project.aiRecordPlanningMistakes` is nullable with no database default: NULL
// means "never written". EVERY reader — the mapper (MOTIR-3349), the job-envelope
// producer (MOTIR-3350) — resolves it through `resolveRecordPlanningMistakes`, so
// the "on when unset" rule is stated ONCE. That single point is the whole reason
// a nullable column is safe here: a reader that forgot the `?? true` would switch
// a project's capture off invisibly, which is the failure mode this setting can
// least afford, so there is no `?? true` to forget at a call site.
export const AI_RECORD_PLANNING_MISTAKES_DEFAULT = true;

/**
 * Resolve the stored `aiRecordPlanningMistakes` column to the effective setting.
 *
 * `null` (never written — including every row that predates the column) resolves
 * to {@link AI_RECORD_PLANNING_MISTAKES_DEFAULT}, i.e. ON. Only an explicit
 * `false` disables capture, which is what lets a consumer distinguish a project
 * that switched the setting off from one that has never touched it at all.
 */
export function resolveRecordPlanningMistakes(value: boolean | null | undefined): boolean {
  return value ?? AI_RECORD_PLANNING_MISTAKES_DEFAULT;
}

// ── The "Run the final check" default (Story MOTIR-11262 · MOTIR-11264) ───────
//
// The same resolution as the planning-mistakes default above, for the same
// reason: `Project.aiFinalCheck` is nullable with no database default, NULL
// means "never written", and EVERY reader — the mapper, the job-envelope
// producer — resolves it here, so the "on when unset" rule is stated ONCE and a
// project's final check can never be switched off by a reader that forgot it.
export const AI_FINAL_CHECK_DEFAULT = true;

/**
 * Resolve the stored `aiFinalCheck` column to the effective setting.
 *
 * `null` (never written — including every row that predates the column) resolves
 * to {@link AI_FINAL_CHECK_DEFAULT}, i.e. ON. Only an explicit `false` turns the
 * final check off for the project's plans.
 */
export function resolveFinalCheck(value: boolean | null | undefined): boolean {
  return value ?? AI_FINAL_CHECK_DEFAULT;
}
