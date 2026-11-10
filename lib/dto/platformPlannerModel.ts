// The operator console's AI PLANNING page — Story MOTIR-7220 · MOTIR-7227.
//
// Which model Motir plans with, one row per AUDIENCE. Staff-facing only: no
// tenant DTO carries any of this, and the console is the one reader.

import type {
  PlannerAudience,
  PlannerDefaultFunction,
  PlannerModelListReason,
} from '@/lib/ai/types';

/** One audience's row, as the page renders it. */
export interface PlatformPlannerModelRowDTO {
  audience: PlannerAudience;
  model: string;
  /** False once the stored model is no longer offered — planning falls back to Claude Opus 5.5. */
  offered: boolean;
  /** The last probe's verdict; null when the model was never probed. */
  reachable: boolean | null;
  lastProbeAt: string | null;
  lastProbeError: string | null;
  updatedAt: string;
  /** The changer's display name, or null for the seeded default (and an account since removed). */
  updatedBy: string | null;
  /** True while no operator has ever changed the row — the seeded default. */
  seeded: boolean;
}

/** A model the picker may offer. */
export interface PlatformPlannerOfferedModelDTO {
  id: string;
  provider: string;
}

/**
 * The dry-run REVIEW model's row (MOTIR-10632) — platform-wide, beside the
 * audience rows. `model` null is "same as the planning model", the default.
 */
export interface PlatformPlannerReviewModelRowDTO {
  model: string | null;
  /** False once a stored model is no longer offered — reviews then run on each
   *  job's planning model. Null while unset. */
  offered: boolean | null;
  /** When it was last changed; null while nobody has set it. */
  updatedAt: string | null;
  /** The changer's display name, or null (never set, or an account since removed). */
  updatedBy: string | null;
  /** True while no operator has ever changed it. */
  seeded: boolean;
}

/**
 * A planning-side FUNCTION's platform default (MOTIR-10844) — Guide, Debug or
 * Ask. `model` null is "inherits the audience's Planning model", the default.
 */
export interface PlatformPlannerFunctionRowDTO {
  function: PlannerDefaultFunction;
  model: string | null;
  /** False once a stored model is no longer offered; null while unset. */
  offered: boolean | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** True while no operator has ever set it. */
  seeded: boolean;
}

/** What a function-default save reports back; null is "inherits". */
export interface PlatformPlannerFunctionModelWriteDTO {
  function: PlannerDefaultFunction;
  fromModel: string | null;
  toModel: string | null;
  updatedAt: string;
}

/** The whole page: three rows in `customer`, `meta`, `internal` order. */
export interface PlatformPlannerModelSettingsDTO {
  rows: PlatformPlannerModelRowDTO[];
  /** The review row, or null when motir-ai did not answer one (an older release). */
  review: PlatformPlannerReviewModelRowDTO | null;
  /** Guide, Debug and Ask in that order — those motir-ai answered; empty from an
   *  older release that serves none. */
  functions: PlatformPlannerFunctionRowDTO[];
  offered: PlatformPlannerOfferedModelDTO[];
  /** True only for a `superadmin`; every other staff role reads. */
  canEdit: boolean;
}

/** What a review-model save reports back; null is "same as the planning model". */
export interface PlatformPlannerReviewModelWriteDTO {
  fromModel: string | null;
  toModel: string | null;
  updatedAt: string;
}

/** What a save reports back. */
export interface PlatformPlannerModelWriteDTO {
  audience: PlannerAudience;
  fromModel: string;
  toModel: string;
  updatedAt: string;
}

// The PLANNING-MODEL LIST — Story MOTIR-7521 · MOTIR-7524. Which models an
// audience may be set to; the list is motir-ai's, read and edited here only for
// the console.

/** One listed model, as the page renders it. */
export interface PlatformPlannerModelListEntryDTO {
  model: string;
  /** Null when motir-ai's catalog has no row for it. */
  provider: string | null;
  /** Whether motir-ai offers it for planning right now. */
  offered: boolean;
  /** Why it is not offered; null when it is. */
  reason: PlannerModelListReason | null;
  /** The audiences set to it, in `customer`, `meta`, `internal` order — what blocks a remove. */
  inUseBy: PlannerAudience[];
  /** True for the planner's fallback, which motir-ai keeps listed. */
  fallback: boolean;
  createdAt: string;
  /** The adder's display name; null for a seeded row (and an account since removed). */
  addedBy: string | null;
  /** True for a row motir-ai's migration seeded rather than an operator added. */
  seeded: boolean;
}

/** The planning-list card: every listed model, and whether this principal may edit. */
export interface PlatformPlannerModelListDTO {
  entries: PlatformPlannerModelListEntryDTO[];
  /** What the Add dialog may offer (MOTIR-7614): motir-ai's plannable, not-yet-listed
   *  models, in its order (provider, then id). Empty when every plannable model is listed. */
  candidates: PlatformPlannerOfferedModelDTO[];
  /** True only for a `superadmin`; every other staff role reads. */
  canEdit: boolean;
}
