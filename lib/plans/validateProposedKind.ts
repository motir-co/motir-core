// ── A proposed KIND CHANGE's bar, at the proposal write doors ─────────────────
// (bug MOTIR-8192; `docs/decisions/agent-authored-plans.md` AMENDMENT 25.)
//
// Two re-kinds reach a plan: a `modify` re-kinding a COMMITTED work item
// (`patch.kind`), and a correction re-kinding a proposed `add`
// (`proposedFields.kind`). Approve writes either straight onto the row —
// `materialize` and `applyModify` build the Prisma data themselves — so neither
// passes through `workItemsService.updateWorkItem`, whose kind path refuses an
// illegal parent, an illegal child and a container keeping a leaf field. This
// module holds the PURE half of the plan path's own bar: the membership of a
// `modify`'s new kind, and the leaf fields a container may not keep. The TREE
// half (parent and children) needs reads, and lives in `validateProposals.ts`
// and the service's append-time callers.
//
// PURE: no DB, no Prisma client, no `tx`. Every refusal is an
// `InvalidProposalError` (a 422 with code `INVALID_PROPOSAL` on every door) —
// the family every other proposal-content refusal uses.

import { MODIFY_KIND_TARGETS, type ModifyKindTarget } from '@/lib/dto/plans';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { InvalidProposalError } from '@/lib/plans/errors';
import { TYPEABLE_KINDS } from '@/lib/issues/executorDefaults';

/** Is `kind` one a `modify` may re-kind its target to? */
export function isModifyKindTarget(kind: unknown): kind is ModifyKindTarget {
  return (MODIFY_KIND_TARGETS as readonly unknown[]).includes(kind);
}

/** A CONTAINER kind — one that may carry no `type`, `executor` or `difficulty`. */
export function isContainerKind(kind: string): boolean {
  return !TYPEABLE_KINDS.has(kind as WorkItemKindDto);
}

/**
 * Validate a `modify`'s `patch.kind` for MEMBERSHIP. `undefined` (the patch
 * leaves the kind alone) passes; anything else must be a
 * {@link MODIFY_KIND_TARGETS} member — `null` included, since a work item always
 * has a kind and there is nothing to clear it to.
 */
export function validateProposedKindChange(
  kind: unknown,
  label: string,
): asserts kind is ModifyKindTarget | undefined {
  if (kind === undefined) return;
  if (isModifyKindTarget(kind)) return;
  throw new InvalidProposalError(
    kind === 'epic'
      ? `${label}: \`patch.kind\` cannot be \`epic\`. An epic is structural scaffolding a plan lays with an \`add\`; an existing work item is re-kinded only to ${MODIFY_KIND_TARGETS.join(', ')} (the set \`change_kind\` offers).`
      : `${label}: \`patch.kind\` "${String(kind)}" is not a kind a work item can be re-kinded to. Legal values: ${MODIFY_KIND_TARGETS.join(', ')}.`,
  );
}

/**
 * The LEAF fields a proposal would leave on a CONTAINER kind: the names of
 * `type` and `executor` when they are non-null and `kind` is a container. Empty
 * for a leaf kind, or when both are null.
 *
 * `difficulty` is not here: it has its own validator and its own refusal on
 * every door (`validateProposedDifficulty`).
 */
export function leafFieldsOnContainer(
  kind: string,
  fields: { type?: unknown; executor?: unknown },
): string[] {
  if (!isContainerKind(kind)) return [];
  const kept: string[] = [];
  if (fields.type != null) kept.push('type');
  if (fields.executor != null) kept.push('executor');
  return kept;
}

/**
 * The `type` and `executor` an `add` of `kind` is CREATED with (bug MOTIR-11838):
 * the proposed values on a leaf kind, and `null` for both on a container.
 *
 * `materialize` writes the created row directly — it never goes through
 * `workItemsService`, whose `assertTypeKindConsistent` is the leaf-only rule —
 * so before this it copied a proposed `executor` (or `type`) onto a fresh
 * `story` / `epic` add. Nothing on the way refused it: the re-kind refusal above
 * runs only when an edit SUPPLIES a kind, and the approve gate checks the
 * executor's membership, not where it sits. The stored value then made every
 * later edit of the card fail TYPE_NOT_ALLOWED_ON_KIND, because `updateWorkItem`
 * checks the post-patch state with the stored executor carried over.
 *
 * DROPPED, not refused, deliberately: a container's executor carries no meaning
 * (who executes a story is decided on its leaves), the planners that author
 * plans send one routinely, and refusing it would fail a whole approve over a
 * field nobody reads. The plan-review rail reads the same function, so the card
 * a reviewer approves is the card approve creates.
 */
export function leafFieldsForCreatedKind<T, E>(
  kind: string,
  fields: { type: T | null; executor: E | null },
): { type: T | null; executor: E | null } {
  if (isContainerKind(kind)) return { type: null, executor: null };
  return { type: fields.type, executor: fields.executor };
}

/**
 * Refuse a RE-KINDED `add` that would keep a leaf field on a container kind —
 * the correction / deepen half of AMENDMENT 25 §3. Called only when the edit
 * SUPPLIES a kind, so a proposal written before this rule is not refused for an
 * edit that does not touch its kind.
 */
export function assertReKindedAddKeepsNoLeafFields(
  kind: string,
  fields: { type?: unknown; executor?: unknown },
  label: string,
): void {
  const kept = leafFieldsOnContainer(kind, fields);
  if (kept.length === 0) return;
  const named = kept.map((k) => `\`${k}\``).join(' and ');
  throw new InvalidProposalError(
    `${label}: a \`${kind}\` is a container and cannot carry ${named}. Re-kinding a leaf into a container clears its leaf fields — send ${kept.map((k) => `\`${k}: null\``).join(' and ')} with the new kind.`,
  );
}
