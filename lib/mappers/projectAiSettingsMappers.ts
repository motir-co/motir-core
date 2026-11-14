import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';
import { resolveFinalCheck, resolveRecordPlanningMistakes } from '@/lib/projectAiSettings/limits';

// Prisma → DTO converter for the project AI-planning settings (Story 7.13 ·
// Subtask MOTIR-915). The service calls this just before returning so no Prisma
// row shape leaks across the API boundary. Mirrors
// `lib/mappers/estimationMappers.ts`'s `toEstimationConfigDto`.

/**
 * Map a project's AI-settings columns to a `ProjectAiSettingsDto`. Accepts the
 * full `Project` row OR the narrow `projectRepository.findAiSettings` projection
 * — both carry exactly these seven fields — so the read path can stay a
 * projection while the write path maps the updated row it already has.
 *
 * `aiRecordPlanningMistakes` and `aiFinalCheck` are the two fields that are
 * TRANSFORMED rather than copied: each column is nullable (NULL = never written,
 * including every row that predates it) and resolves to ON here, so the DTO is
 * always a real boolean and the "on when unset" rule is applied at exactly one
 * place (MOTIR-3349, MOTIR-11264).
 */
export function toProjectAiSettingsDto(row: {
  aiAutoPlanEnabled: boolean;
  aiAutoPlanThreshold: number;
  aiSprintPlanningEnabled: boolean;
  aiSprintLengthDays: number;
  aiGenerateExplanations: boolean;
  aiRecordPlanningMistakes: boolean | null;
  aiFinalCheck: boolean | null;
}): ProjectAiSettingsDto {
  return {
    aiAutoPlanEnabled: row.aiAutoPlanEnabled,
    aiAutoPlanThreshold: row.aiAutoPlanThreshold,
    aiSprintPlanningEnabled: row.aiSprintPlanningEnabled,
    aiSprintLengthDays: row.aiSprintLengthDays,
    aiGenerateExplanations: row.aiGenerateExplanations,
    aiRecordPlanningMistakes: resolveRecordPlanningMistakes(row.aiRecordPlanningMistakes),
    aiFinalCheck: resolveFinalCheck(row.aiFinalCheck),
  };
}
