// A board's STORED filter on the READ path (Story MOTIR-10560 · Subtask
// MOTIR-11332). Shared by the board read (`boardsService.loadBoardFrame`) and
// the public project page's board preview (`publicProjectsService.getBoard`),
// so both apply the stored filter with identical semantics. The WRITE path
// (validate and normalise on save) lives in `boardsService`.

import { decodeFilterEnvelope, encodeFilterEnvelope, type FilterAst } from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';
import {
  resolveFilterAst,
  validateFilterAst,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import type { StoredFilterPredicate } from '@/lib/repositories/workItemRepository';
import { loadFilterReferents } from '@/lib/services/workItemsService';
import type { StoredBoardFilterDto } from '@/lib/dto/boards';

/**
 * A board's stored filter, resolved for the read (MOTIR-10560): the predicate
 * every card read ANDs beside the toolbar's, and what the projection reports.
 * `predicate` is `undefined` for a stored filter with zero conditions (it
 * narrows nothing).
 */
export type ResolvedStoredBoardFilter = {
  predicate: StoredFilterPredicate | undefined;
  dto: StoredBoardFilterDto;
};

/**
 * Resolve `board.filter` for a board read (MOTIR-10560). NEVER throws on the
 * filter's content — a board's filter must not take the board down:
 *
 *   - The envelope is decoded with `decodeFilterEnvelope` and its referents
 *     load through `loadFilterReferents`, then `resolveFilterAst` names each
 *     STALE condition (a deleted label / component / folder / custom field or
 *     option). A stale condition compiles to `FALSE` (the compiler's shipped
 *     rule): the board loads and that condition matches nothing.
 *   - An envelope that no longer decodes, or a condition that no longer
 *     validates, is NOT degraded to "no filter" — that would widen the board to
 *     everything. The whole filter narrows to match-nothing and is reported as
 *     one `invalid` entry (with the failing condition's index and field when
 *     the envelope itself still reads).
 *
 * This is the `savedFiltersService` stored-envelope pattern (decode, then
 * validate, degrade rather than throw), NOT `resolveBoardFilter`, whose typed
 * 422 is right for a request's inline filter and wrong for a stored one.
 * A deleted USER is not stale-checked by the resolver (an id that matches no
 * one simply matches nothing, the 2.5.4 rule), and so is not reported.
 */
export async function resolveStoredBoardFilter(
  projectId: string,
  workspaceId: string,
  raw: unknown,
): Promise<ResolvedStoredBoardFilter | undefined> {
  if (raw === null || raw === undefined) return undefined;
  const decoded = decodeFilterEnvelope(raw);
  if (!decoded.ok) {
    return {
      predicate: { matchNothing: true },
      dto: { envelope: null, staleConditions: [{ index: null, field: null, reason: 'invalid' }] },
    };
  }
  const ast = decoded.ast;
  const envelope = encodeFilterEnvelope(ast);
  if (ast.conditions.length === 0) {
    return { predicate: undefined, dto: { envelope, staleConditions: [] } };
  }
  const referents = await loadFilterReferents(projectId, workspaceId, ast);
  try {
    const resolved = resolveFilterAst(ast, referents);
    return {
      predicate: { ast, referents },
      dto: {
        envelope,
        staleConditions: resolved.conditions.flatMap((rc, index) =>
          rc.stale ? [{ index, field: rc.condition.field, reason: rc.stale }] : [],
        ),
      },
    };
  } catch (err) {
    /* v8 ignore next -- defensive: resolveFilterAst throws only FilterValidationError */
    if (!(err instanceof FilterValidationError)) throw err;
    const located = locateInvalidCondition(ast, referents);
    return {
      predicate: { matchNothing: true },
      dto: {
        envelope,
        staleConditions: [{ ...located, reason: 'invalid' }],
      },
    };
  }
}

/** The first condition of `ast` that fails validation on its own, by index and
 * field — or both `null` when none fails alone (the failure is the whole
 * filter's). Shared by the read (the stale entry) and the write (the 422's
 * `conditionIndex`, `boardsService`). */
export function locateInvalidCondition(
  ast: FilterAst,
  referents: ProjectFilterReferents | undefined,
): { index: number | null; field: string | null } {
  const index = ast.conditions.findIndex((condition) => {
    try {
      validateFilterAst({ combinator: ast.combinator, conditions: [condition] }, referents);
      return false;
    } catch {
      return true;
    }
  });
  // The decode already held the combinator and the cap, so the failure is one
  // condition's; both `null` is the defensive answer if that stops being true.
  /* v8 ignore next */
  if (index < 0) return { index: null, field: null };
  return { index, field: ast.conditions[index]!.field };
}
