import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type {
  HostedAgentOfferedModelDto,
  ProjectHostedAgentSettingsDto,
} from '@/lib/dto/projectHostedAgentSettings';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import {
  resolveHostedModel,
  type HostedModelOffer,
  type HostedModelsByDifficulty,
  type OrgHostedModelLayer,
} from '@/lib/hosted/resolveHostedModel';
import type { ProjectHostedModelOverridesRow } from '@/lib/repositories/projectRepository';

// Project row + motir-ai's offer → the hosted-agent settings DTO (MOTIR-6993).
// Every `effective` / `source` here comes from `resolveHostedModel`, the same
// function the start path and the picker call, so the room can never show a
// model a run would not use.

/** The four override columns, keyed by difficulty. */
export function toHostedModelOverrides(
  row: ProjectHostedModelOverridesRow,
): HostedModelsByDifficulty {
  return {
    trivial: row.hostedModelTrivial,
    low: row.hostedModelLow,
    medium: row.hostedModelMedium,
    high: row.hostedModelHigh,
  };
}

/** A difficulty-keyed patch → the column names it writes. */
export function toHostedModelOverrideColumns(
  patch: Partial<Record<WorkItemDifficultyDto, string | null>>,
): Partial<ProjectHostedModelOverridesRow> {
  const out: Partial<ProjectHostedModelOverridesRow> = {};
  if (patch.trivial !== undefined) out.hostedModelTrivial = patch.trivial;
  if (patch.low !== undefined) out.hostedModelLow = patch.low;
  if (patch.medium !== undefined) out.hostedModelMedium = patch.medium;
  if (patch.high !== undefined) out.hostedModelHigh = patch.high;
  return out;
}

export function toProjectHostedAgentSettingsDto(
  row: ProjectHostedModelOverridesRow,
  offered: HostedModelOffer,
  /** The offered models with their providers; defaults to the bare ids with an
   *  empty provider, for a caller that holds only the offer. */
  models: readonly HostedAgentOfferedModelDto[] = offered.models.map((id) => ({
    id,
    provider: '',
  })),
  /** The organisation's run-side layer while it qualifies (MOTIR-10843), else null. */
  org: OrgHostedModelLayer | null = null,
): ProjectHostedAgentSettingsDto {
  const overrides = toHostedModelOverrides(row);
  const resolve = (difficulty: WorkItemDifficultyDto | null) =>
    resolveHostedModel({ difficulty, overrides, offered, org, design: false });
  const noDifficulty = resolve(null);
  return {
    levels: WORK_ITEM_DIFFICULTIES.map((level) => {
      const override = overrides[level];
      const resolved = resolve(level);
      // What the level INHERITS with no project override: the organisation's own
      // choice while it qualifies and it is offered, else the platform level.
      const orgChoice = org?.levels[level] ?? null;
      const fromOrg = orgChoice !== null && offered.models.includes(orgChoice);
      return {
        level,
        override,
        overrideOffered: override === null || offered.models.includes(override),
        platformDefault: fromOrg ? orgChoice : offered.defaultsByDifficulty[level],
        inheritedFrom: fromOrg ? ('organization' as const) : ('platform' as const),
        effective: resolved?.model ?? null,
        source: resolved?.source ?? null,
      };
    }),
    offeredModels: [...offered.models],
    offered: models.map((m) => ({ id: m.id, provider: m.provider })),
    noDifficulty: { effective: noDifficulty?.model ?? null, source: noDifficulty?.source ?? null },
  };
}
