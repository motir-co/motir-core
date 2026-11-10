import type {
  OrgPlannerModelOverridesRead,
  OrgPlannerModelOverrideWriteResult,
} from '@/lib/ai/types';
import {
  ORG_PLANNER_FUNCTIONS,
  ORG_RUN_MODEL_KEYS,
  type OrgOfferedModelDTO,
  type OrgPlannerModelsDTO,
  type OrgPlannerModelWriteDTO,
  type OrgRunModelKeyDTO,
  type OrgRunModelRowDTO,
  type OrgRunModelsDTO,
} from '@/lib/dto/orgAiModels';
import {
  resolveHostedModel,
  resolveReviewModel,
  type HostedModelOffer,
  type HostedModelsByDifficulty,
  type HostedModelSource,
  type ReviewModelSource,
} from '@/lib/hosted/resolveHostedModel';
import type { OrgHostedModelOverrideColumns } from '@/lib/repositories/organizationRepository';

// motir-ai's org override answer → the room's DTO (MOTIR-10845). The LOCKED answer is
// built as its own literal from two booleans, never by deleting fields from the
// ready shape: a field motir-ai adds later can then never carry a model id to an org
// that does not qualify.

export function toOrgPlannerModelsDTO(
  read: OrgPlannerModelOverridesRead,
  roleCanEdit: boolean,
): OrgPlannerModelsDTO {
  if (!read.qualifies) {
    return {
      state: 'locked',
      canEdit: false,
      keptChoices: read.overrides.some((o) => o.model !== null),
    };
  }
  return {
    state: 'ready',
    canEdit: roleCanEdit,
    rows: ORG_PLANNER_FUNCTIONS.map((fn) => {
      const stored = read.overrides.find((o) => o.function === fn);
      const effective = read.effective.find((e) => e.function === fn);
      const model = stored?.model ?? null;
      return {
        function: fn,
        model,
        withdrawn: model !== null && stored?.offered === false,
        applies: stored?.applies ?? false,
        effectiveModel: effective?.model ?? null,
        effectiveSource: effective?.source ?? null,
        updatedAt: stored?.updatedAt ?? null,
      };
    }),
    offered: read.offered.map((m) => ({ id: m.id, provider: m.provider })),
  };
}

export const UNREADABLE_ORG_PLANNER_MODELS: OrgPlannerModelsDTO = {
  state: 'unreadable',
  canEdit: false,
};

export function toOrgPlannerModelWriteDTO(
  result: OrgPlannerModelOverrideWriteResult,
): OrgPlannerModelWriteDTO {
  return {
    function: result.function,
    previousModel: result.previousModel,
    model: result.model,
    updatedAt: result.updatedAt,
  };
}

// ── The run-side half (MOTIR-10850) ─────────────────────────────────────────────

/** Which `organization` column backs each run-side row. */
export const ORG_RUN_MODEL_COLUMN: Record<OrgRunModelKeyDTO, keyof OrgHostedModelOverrideColumns> =
  {
    trivial: 'hostedModelTrivial',
    low: 'hostedModelLow',
    medium: 'hostedModelMedium',
    high: 'hostedModelHigh',
    review: 'hostedReviewModel',
    design: 'hostedDesignModel',
  };

const NO_PROJECT_OVERRIDE: HostedModelsByDifficulty = {
  trivial: null,
  low: null,
  medium: null,
  high: null,
};

/**
 * One run-side row: the stored value, whether it was withdrawn, and the model a run
 * would use with no person's pick and no project override. Every row that resolves
 * to a model goes through the shared rules (`resolveHostedModel`,
 * `resolveReviewModel`), so the room can never disagree with a run.
 */
export function toOrgRunModelRowDTO(
  key: OrgRunModelKeyDTO,
  columns: OrgHostedModelOverrideColumns,
  offer: HostedModelOffer,
): OrgRunModelRowDTO {
  const model = columns[ORG_RUN_MODEL_COLUMN[key]];
  const withdrawn = model !== null && !offer.models.includes(model);
  const org = {
    levels: {
      trivial: columns.hostedModelTrivial,
      low: columns.hostedModelLow,
      medium: columns.hostedModelMedium,
      high: columns.hostedModelHigh,
    },
    review: columns.hostedReviewModel,
    design: columns.hostedDesignModel,
  };
  if (key === 'review')
    return { key, model, withdrawn, ...fromRule(resolveReviewModel(offer, org)) };
  if (key === 'design') {
    const resolved = resolveHostedModel({
      difficulty: null,
      overrides: NO_PROJECT_OVERRIDE,
      offered: offer,
      org,
      design: true,
    });
    // A design run with neither design model takes the CARD's difficulty, which a
    // room row has none of: say so rather than answer the no-difficulty default.
    if (resolved?.source !== 'org_design' && resolved?.source !== 'platform_design') {
      return { key, model, withdrawn, effectiveModel: null, effectiveSource: 'difficulty_mapping' };
    }
    return { key, model, withdrawn, ...fromRule(resolved) };
  }
  const resolved = resolveHostedModel({
    difficulty: key,
    overrides: NO_PROJECT_OVERRIDE,
    offered: offer,
    org,
    design: false,
  });
  return { key, model, withdrawn, ...fromRule(resolved) };
}

/**
 * A shared rule's answer → the row's two effective fields. `override` cannot occur
 * (a room row has no project override), so it reads as no answer.
 */
function fromRule(
  r: { model: string; source: HostedModelSource | ReviewModelSource } | null,
): Pick<OrgRunModelRowDTO, 'effectiveModel' | 'effectiveSource'> {
  if (r === null || r.source === 'override') return { effectiveModel: null, effectiveSource: null };
  return { effectiveModel: r.model, effectiveSource: r.source };
}

/** The ready answer: six rows in the room's order, and the models it may pick from. */
export function toOrgRunModelsReadyDTO(
  columns: OrgHostedModelOverrideColumns,
  offer: HostedModelOffer,
  offered: readonly OrgOfferedModelDTO[],
  roleCanEdit: boolean,
): OrgRunModelsDTO {
  return {
    state: 'ready',
    canEdit: roleCanEdit,
    rows: ORG_RUN_MODEL_KEYS.map((key) => toOrgRunModelRowDTO(key, columns, offer)),
    offered: offered.map((m) => ({ id: m.id, provider: m.provider })),
  };
}

/**
 * The locked answer, built as its own literal from one boolean: no stored value, no
 * effective model and no offered id can reach an org that does not qualify.
 */
export function toOrgRunModelsLockedDTO(columns: OrgHostedModelOverrideColumns): OrgRunModelsDTO {
  return {
    state: 'locked',
    canEdit: false,
    keptChoices: Object.values(ORG_RUN_MODEL_COLUMN).some((c) => columns[c] !== null),
  };
}

export const UNREADABLE_ORG_RUN_MODELS: OrgRunModelsDTO = { state: 'unreadable', canEdit: false };
