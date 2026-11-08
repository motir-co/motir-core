// ── A proposed card EXECUTOR's bar, at EVERY proposal write door (MOTIR-10678) ──
//
// An `add` proposal can carry a card-level `executor`, and approve writes it
// straight onto the work item — `materialize` builds the Prisma create data
// itself (`executor: pf.executor ?? null`), so it never passes through the Zod
// enum the `create_work_item` door validates behind. The public MCP plan doors
// (`add_plan_items`, `update_plan_proposal`) enum the field in their own tool
// schemas, but the INTERNAL AI routes motir-ai's planner writes through are thin
// transports that forward any string. So a model-written `"agent"` was stored,
// passed `validate_plan`, and failed only at approve with
// `PLAN_ITEM_FIELD_REJECTED` — MOTIR-10656's hole on `priority`, one column over.
//
// This module is the plan path's own bar and the ONE implementation of it: the
// append (`validateProposal`), the deepen (`applyAddProposalEdit`) and the
// correction (`correctProposal`) call {@link validateProposedExecutor} on the
// value they are about to store, and the approve-time gate
// (`validateProposals.ts`, `unknown_executor`) asks {@link isWorkItemExecutor}
// of the value already stored. Every door answers with the same legal list.
//
// Only an `add` carries one: a `modify` patch never sets `executor` (it is the
// target's — `validatePatchKeys` refuses the key), and a STEP's executor has its
// own bar in `validateProposedTodos`.
//
// PURE: no DB, no Prisma client. A refusal is an `InvalidProposalError` (422,
// `INVALID_PROPOSAL`, on every door) — the family every other proposal-content
// refusal uses (`validateProposedPriority`, `validateProposedDifficulty`).

import type { ExecutorDto } from '@/lib/dto/workItems';
import { InvalidProposalError } from '@/lib/plans/errors';
import { WORK_ITEM_EXECUTORS, isWorkItemExecutor } from '@/lib/issues/executorDefaults';

/**
 * Validate a proposed card-level executor.
 *
 * `undefined` / `null` pass: an absent executor leaves the proposal alone, and
 * `materialize` writes an unset one as `null` (unassigned). Anything else must
 * be a member of {@link WORK_ITEM_EXECUTORS}.
 *
 * @param executor   the value as it arrived (or as the sparse merge left it)
 * @param label      how the proposal is named in a refusal (`proposalLabel(...)`)
 * @param planItemId the persisted proposal's id, at a door that edits one (the
 *                   deepen, the correction) — carried on the error so the route's
 *                   422 names the proposal by id as well as by title. `null` at
 *                   the append, where the proposal has no id yet.
 */
export function validateProposedExecutor(
  executor: unknown,
  label: string,
  planItemId: string | null = null,
): asserts executor is ExecutorDto | null | undefined {
  if (executor === undefined || executor === null) return;
  if (isWorkItemExecutor(executor)) return;
  throw new InvalidProposalError(
    `${label}: \`executor\` "${String(executor)}" is not an executor. Legal values: ${WORK_ITEM_EXECUTORS.join(', ')}, or null to leave it unassigned.`,
    planItemId,
  );
}
