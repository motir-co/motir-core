import { projectRepository } from '@/lib/repositories/projectRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { resolveFinalCheck } from '@/lib/projectAiSettings/limits';

// The PRODUCER half of the final-check crossing (Story MOTIR-11262 · MOTIR-11264
// producer ↔ MOTIR-11265 consumer) — resolve `Project.aiFinalCheck` at submit
// time and put it on the plan job envelope's `context`, so motir-ai can leave
// the final check out for a project that turned it off without ever reading
// motir-core's database.
//
// The shape of `lib/ai/lessonCapture.ts`, its neighbour on the same submits, and
// for the same reason: this is a CROSS-REPO CONTRACT that fails closed and
// silently. There is no shared type across the two repositories, so the field
// name is a string agreement between two codebases; it is spelled ONCE, here,
// and every call site uses it as a computed key.

/**
 * The `context` key the setting rides on, as motir-ai's plan job reads it.
 *
 * Declared `as const` so a computed-key literal (`{ [FIELD]: value }`) still
 * type-checks against `JobContextBag`'s `finalCheck`.
 */
export const FINAL_CHECK_CONTEXT_FIELD = 'finalCheck' as const;

/**
 * Resolve whether this project's plans run the final check.
 *
 * ALWAYS returns a boolean — never `undefined` — because the two states must stay
 * distinguishable ON THE WIRE. A present `false` means *this project turned the
 * final check off*; an ABSENT field means *the producer predates this contract*
 * and the consumer must run the check. So the caller sends the field
 * unconditionally.
 *
 * A project that cannot be read resolves to the default (ON) rather than
 * throwing: this is a setting on a submit that is already happening, and running
 * a check the project did not want costs time, while failing the plan costs the
 * plan.
 */
export async function resolveFinalCheckForJob(
  projectId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<boolean> {
  const settings = await withWorkspaceContext(ctx, (tx) =>
    projectRepository.findAiSettings(projectId, tx),
  );
  return resolveFinalCheck(settings?.aiFinalCheck ?? null);
}
