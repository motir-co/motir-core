// DTOs for the project AI-planning settings (Story 7.13 · Subtask MOTIR-915).
// The shape that crosses the API / Server-Action boundary for the AI-settings
// panel (MOTIR-919) — no Prisma row leak. Kept OFF the hot `ProjectDTO` (which
// every switcher / active-project read carries) because these are a settings
// surface's fields, read only when that surface is open; the one exception is
// `aiGenerateExplanations`, which already rides `ProjectDTO` for the generate-job
// envelope (Story 7.4) and is MIRRORED here so the panel that edits the AI
// settings group reads + writes all of them through ONE contract.

/**
 * A project's AI-planning configuration as the API returns it.
 *
 * - `aiAutoPlanEnabled` / `aiAutoPlanThreshold` — the auto-expand cadence: when
 *   enabled, the cadence engine (MOTIR-916) fires a 7.4 expand run once the ready
 *   set drains below the threshold.
 * - `aiSprintPlanningEnabled` / `aiSprintLengthDays` — the AI sprint packing
 *   (MOTIR-917/918) and the length of the sprints it creates.
 * - `aiGenerateExplanations` — the Story-7.4 AI-drafted-explanations opt-in,
 *   surfaced in the same panel (MOTIR-919).
 * - `aiRecordPlanningMistakes` — whether this project's planner records what it
 *   got wrong (Story MOTIR-3331 · MOTIR-3349). ALWAYS a resolved boolean here,
 *   never null: the column is nullable ("never written") and the mapper resolves
 *   an unset value to `true` through `resolveRecordPlanningMistakes`, so no
 *   consumer of this DTO has to know the default or repeat it.
 * - `aiFinalCheck` — whether this project's plans run the planner's final check
 *   before they are proposed (Story MOTIR-11262 · MOTIR-11264). Resolved the
 *   same way: the nullable column reads as `true` until a project turns it off.
 */
export interface ProjectAiSettingsDto {
  aiAutoPlanEnabled: boolean;
  aiAutoPlanThreshold: number;
  aiSprintPlanningEnabled: boolean;
  aiSprintLengthDays: number;
  aiGenerateExplanations: boolean;
  aiRecordPlanningMistakes: boolean;
  aiFinalCheck: boolean;
}

/**
 * Patch input to `projectAiSettingsService.updateAiSettings`. Every field is
 * optional — an ABSENT field is left unchanged, so the panel can save one toggle
 * in place without clobbering the rest (the `updateDetails` / `setPublicOverview`
 * idiom).
 *
 * There is no planner-model field: the model that plans is a platform setting,
 * never a project one (MOTIR-7228).
 */
export interface UpdateProjectAiSettingsInput {
  aiAutoPlanEnabled?: boolean;
  aiAutoPlanThreshold?: number;
  aiSprintPlanningEnabled?: boolean;
  aiSprintLengthDays?: number;
  aiGenerateExplanations?: boolean;
  aiRecordPlanningMistakes?: boolean;
  aiFinalCheck?: boolean;
}
