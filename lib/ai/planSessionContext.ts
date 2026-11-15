import { randomUUID } from 'node:crypto';

// The PRODUCER half of the plan-session crossing (Bug MOTIR-11294 · consumer
// motir-ai `readPlanSessionId`) — every `plan` submit names the planning
// CONVERSATION it belongs to, as `context.planSessionId`.
//
// motir-ai keys a conversation's code-graph pointers by the job's concurrency key,
// `session:<aiProjectId>:<scopeKey>`, which every later session with the same anchor
// set SHARES. MOTIR-11292 made a turn that names its conversation drop the pointers
// another conversation left under that key, but only an offer's start named one
// (`requirementConfirmed.conversationId`). An expand, a one-shot augment, a
// generation and a cadence run are each a NEW session here, and named none, so each
// inherited the session before it and opened on a false "your code graph was
// refreshed since the last turn" note.
//
// The same shape as `lib/ai/finalCheck.ts`: a CROSS-REPO CONTRACT with no shared
// type, so the wire key is spelled ONCE, here, and every call site uses it as a
// computed key.

/**
 * The `context` key the session id rides on, as motir-ai's plan job reads it.
 *
 * Declared `as const` so a computed-key literal (`{ [FIELD]: value }`) still
 * type-checks against `JobContextBag`'s `planSessionId`.
 */
export const PLAN_SESSION_ID_CONTEXT_FIELD = 'planSessionId' as const;

/**
 * The id of a session a submit is about to OPEN.
 *
 * The opening submits (an expand, a one-shot augment, a generation, a cadence run)
 * submit their job FIRST and open the plan and its session after, so a failed submit
 * leaves no orphan row behind (`aiPlanEditsService.submitPlanEditJob`). The session's
 * id therefore has to exist before its row does, or it could not ride the envelope:
 * the submit allocates it here and `plansService.createPlan` creates the session with
 * exactly this id. A UUID, not a cuid, because nothing in this repository generates a
 * cuid outside Prisma's column default; the column is a plain string and every
 * reader treats the id as opaque.
 */
export function allocatePlanSessionId(): string {
  return randomUUID();
}
