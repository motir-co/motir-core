// ── A proposed PRIORITY's bar, at EVERY proposal write door (MOTIR-10656) ─────
//
// A plan proposal can carry a priority, and approve writes it straight onto the
// work item — `materialize` builds the Prisma create data itself and
// `applyModify` builds the update, so neither passes through the Zod schema the
// `create_work_item` door validates behind. The public MCP plan doors
// (`add_plan_items`, `update_plan_proposal`) enum the field in their own tool
// schemas, but the INTERNAL AI routes motir-ai's planner writes through are thin
// transports that forward any string. So a model-written `"p2"` was stored,
// passed `validate_plan`, and failed only at approve with
// `PLAN_ITEM_FIELD_REJECTED` — the hole MOTIR-3654 closed for `type`.
//
// This module is the plan path's own bar and the ONE implementation of it: the
// append (`validateProposal`), the deepen (`applyAddProposalEdit`) and the
// correction (`correctProposal`) call {@link validateProposedPriority} on the
// value they are about to store, and the approve-time gate
// (`validateProposals.ts`, `unknown_priority`) asks {@link isWorkItemPriority}
// of the value already stored. Every door answers with the same legal list.
//
// PURE: no DB, no Prisma client. A refusal is an `InvalidProposalError` (422,
// `INVALID_PROPOSAL`, on every door) — the family every other proposal-content
// refusal uses (`validateProposedDifficulty`, `validateProposedTodos`).

import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import { InvalidProposalError } from '@/lib/plans/errors';
import { WORK_ITEM_PRIORITIES, isWorkItemPriority } from '@/lib/issues/priority';

/**
 * Validate a proposed priority.
 *
 * `undefined` / `null` pass: an absent priority leaves the proposal (or the
 * target) alone, and `materialize` defaults an unset one to the column default.
 * Anything else must be a member of {@link WORK_ITEM_PRIORITIES}.
 *
 * @param priority the value as it arrived (or as the sparse merge left it)
 * @param label    how the proposal is named in a refusal (`proposalLabel(...)`)
 * @param planItemId the persisted proposal's id, at a door that edits one (the
 *                 deepen, the correction) — carried on the error so the route's
 *                 422 names the proposal by id as well as by title. `null` at
 *                 the append, where the proposal has no id yet.
 */
export function validateProposedPriority(
  priority: unknown,
  label: string,
  planItemId: string | null = null,
): asserts priority is WorkItemPriorityDto | null | undefined {
  if (priority === undefined || priority === null) return;
  if (isWorkItemPriority(priority)) return;
  throw new InvalidProposalError(
    `${label}: \`priority\` "${String(priority)}" is not a priority. Legal values: ${WORK_ITEM_PRIORITIES.join(', ')}, or null to leave it unset.`,
    planItemId,
  );
}
