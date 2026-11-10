import type {
  OrgPlannerModelOverridesRead,
  OrgPlannerModelOverrideWriteResult,
} from '@/lib/ai/types';
import {
  ORG_PLANNER_FUNCTIONS,
  type OrgPlannerModelsDTO,
  type OrgPlannerModelWriteDTO,
} from '@/lib/dto/orgAiModels';

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
