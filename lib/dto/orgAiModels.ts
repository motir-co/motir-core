// DTOs for an organisation's AI models room (story MOTIR-10838 · MOTIR-10845). What
// crosses the HTTP boundary for an org's own model choices — never motir-ai's wire
// shape. The run-side sibling route (MOTIR-10846's room, MOTIR-10850's routes)
// reuses the three states and their `canEdit` rule.

/** The planning-side functions an org may choose a model for, in the room's order. */
export const ORG_PLANNER_FUNCTIONS = ['planning', 'guide', 'debug', 'ask'] as const;
export type OrgPlannerFunctionDTO = (typeof ORG_PLANNER_FUNCTIONS)[number];

export function isOrgPlannerFunction(value: unknown): value is OrgPlannerFunctionDTO {
  return typeof value === 'string' && (ORG_PLANNER_FUNCTIONS as readonly string[]).includes(value);
}

/** Where a function's effective model came from. */
export type OrgModelSourceDTO = 'org' | 'function_default' | 'audience' | 'fallback';

export interface OrgOfferedModelDTO {
  id: string;
  provider: string;
}

/** One function's row while the org qualifies. */
export interface OrgPlannerModelRowDTO {
  function: OrgPlannerFunctionDTO;
  /** The org's stored choice, or null when it follows the platform. */
  model: string | null;
  /** True only for a stored choice that is no longer offered for planning. */
  withdrawn: boolean;
  /** True while the stored choice is the one jobs actually run on. */
  applies: boolean;
  /** The model this function runs on now; null if motir-ai answered none. */
  effectiveModel: string | null;
  effectiveSource: OrgModelSourceDTO | null;
  updatedAt: string | null;
}

/**
 * The room's read. Three states, each built on its own:
 * - `ready` — the org qualifies: every row, and the models it may pick from.
 * - `locked` — it does not: whether it has kept choices from a qualifying time,
 *   and NO model id anywhere (not stored, not effective, not offered).
 * - `unreadable` — motir-ai could not be reached or is not configured.
 * `canEdit` is true only for an owner or admin of a `ready` org.
 */
export type OrgPlannerModelsDTO =
  | {
      state: 'ready';
      canEdit: boolean;
      rows: OrgPlannerModelRowDTO[];
      offered: OrgOfferedModelDTO[];
    }
  | { state: 'locked'; canEdit: false; keptChoices: boolean }
  | { state: 'unreadable'; canEdit: false };

/** A saved change, previous → new. */
export interface OrgPlannerModelWriteDTO {
  function: OrgPlannerFunctionDTO;
  previousModel: string | null;
  model: string | null;
  updatedAt: string;
}

// ── The run-side half (MOTIR-10850) ─────────────────────────────────────────────
// The org's own hosted-run models: a default per difficulty, the review agent and
// the design run. motir-core stores them (six `organization` columns); the room
// reads and writes them through `/ai-models/runs`.

/** The run-side rows, in the room's order. */
export const ORG_RUN_MODEL_KEYS = ['trivial', 'low', 'medium', 'high', 'review', 'design'] as const;
export type OrgRunModelKeyDTO = (typeof ORG_RUN_MODEL_KEYS)[number];

export function isOrgRunModelKey(value: unknown): value is OrgRunModelKeyDTO {
  return typeof value === 'string' && (ORG_RUN_MODEL_KEYS as readonly string[]).includes(value);
}

/**
 * Where a run-side row's effective model comes from. `difficulty_mapping` is the
 * design row with neither an org nor a platform design-run model: such a run takes
 * the card's difficulty, which a room row does not have.
 */
export type OrgRunModelSourceDTO =
  | 'org_level'
  | 'org_review'
  | 'org_design'
  | 'platform_level'
  | 'platform_review'
  | 'platform_design'
  | 'platform_default'
  | 'first_offered'
  | 'difficulty_mapping';

/** One run-side row while the org qualifies. */
export interface OrgRunModelRowDTO {
  key: OrgRunModelKeyDTO;
  /** The org's stored choice, or null when it inherits. */
  model: string | null;
  /** True only for a stored choice no longer on the run-model offer. */
  withdrawn: boolean;
  /** What a run uses with no person's pick and no project override; null when none. */
  effectiveModel: string | null;
  effectiveSource: OrgRunModelSourceDTO | null;
}

/** The run-side read: the same three states and `canEdit` rule as the planning side. */
export type OrgRunModelsDTO =
  | {
      state: 'ready';
      canEdit: boolean;
      rows: OrgRunModelRowDTO[];
      offered: OrgOfferedModelDTO[];
    }
  | { state: 'locked'; canEdit: false; keptChoices: boolean }
  | { state: 'unreadable'; canEdit: false };

/** A saved run-side change, previous → new, with the row recomputed from the write. */
export interface OrgRunModelWriteDTO {
  key: OrgRunModelKeyDTO;
  previousModel: string | null;
  model: string | null;
  row: OrgRunModelRowDTO;
}
