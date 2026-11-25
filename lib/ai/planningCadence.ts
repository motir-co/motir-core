import { projectRepository } from '@/lib/repositories/projectRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  resolvePlanningCadence,
  type AiPlanningCadenceValue,
} from '@/lib/projectAiSettings/limits';

// The PRODUCER half of the planning-cadence crossing (Story MOTIR-12203 ·
// MOTIR-12204 producer ↔ the hosted planner's and plan.py's cadence walks) —
// resolve `Project.aiPlanningCadence` at submit time and put it on the plan job
// envelope's `context`, so motir-ai can walk a project one step at a time
// without ever reading motir-core's database.
//
// The shape of `lib/ai/finalCheck.ts`, its neighbour on the same submits, and
// for the same reason: this is a CROSS-REPO CONTRACT that fails closed and
// silently. There is no shared type across the two repositories, so the field
// name is a string agreement between two codebases; it is spelled ONCE, here,
// and every call site uses it as a computed key.
//
// The value is resolved on EVERY submit and never stored on the plan: a job
// carries the cadence the project held when it was submitted, which is what
// keeps a running plan's walk fixed when the setting is saved mid-plan.

/** A project's planning cadence: `story` (today's walk) or `subtask` (one step). */
export type PlanningCadence = AiPlanningCadenceValue;

/**
 * The `context` key the setting rides on, as motir-ai's plan job reads it.
 *
 * Declared `as const` so a computed-key literal (`{ [FIELD]: value }`) still
 * type-checks against `JobContextBag`'s `planningCadence`.
 */
export const PLANNING_CADENCE_CONTEXT_FIELD = 'planningCadence' as const;

/**
 * Resolve the cadence this project's next plan walks at.
 *
 * ALWAYS returns a resolved cadence — never `undefined` — and the caller sends it
 * unconditionally, `story` included: an ABSENT field means *the producer predates
 * this contract*, and the consumer reads it as `story` too, but only a present
 * value states what the project chose.
 *
 * A project that cannot be read — missing, or outside the caller's workspace,
 * which row-level security answers as no row — resolves to the default
 * (`story`) rather than throwing: this is a setting on a submit that is already
 * happening, and planning a whole story costs time, while failing the plan costs
 * the plan.
 */
export async function resolvePlanningCadenceForJob(
  projectId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<PlanningCadence> {
  const settings = await withWorkspaceContext(ctx, (tx) =>
    projectRepository.findAiSettings(projectId, tx),
  );
  return resolvePlanningCadence(settings?.aiPlanningCadence ?? null);
}
