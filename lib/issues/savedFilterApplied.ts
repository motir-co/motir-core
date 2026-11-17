import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import type { ResolvedSavedFilterDto } from '@/lib/dto/savedFilters';

// The applied-saved-filter session model (Story 6.2 · Subtask 6.2.3) — the pure
// half of the /items "a saved filter is applied" state, kept here so the dirty
// check is unit-testable without the DOM.
//
// A saved filter, once applied, lives ENTIRELY in the `?filter=v1:` URL param
// (one codec, two carriers — the saved-filter row IS the URL once applied; no
// new state channel, per the 6.2 design). What the URL can NOT carry is WHICH
// saved filter the user is "on" — that identity is session state (this module's
// `AppliedSavedFilter`), set when an entry is applied from the [Saved] dropdown
// or just saved, and surfaced as the toolbar name chip. It survives client
// navigation (the provider stays mounted across same-route `router.push`es) and
// resets on a hard reload — at which point only the URL's filter remains, which
// is exactly right.
//
// The DIRTY check is the design's load-bearing piece: the chip compares the
// current URL AST to the saved envelope by 6.1.1 canonical equality
// (`encodeFilterParam` is deterministic over row order, which the builder
// preserves), so a builder edit, a URL navigation, or an apply all recompute it
// the same way.

/** The saved (or built-in) filter currently applied on /items. `builtin` and
 * non-owned filters carry `canOverwrite: false` (Save-as forks a fresh row).
 * `visibility` is null for a built-in (no row to carry one). */
export interface AppliedSavedFilter {
  id: string;
  name: string;
  /** The owner's display name (for the non-owner "only the owner can
   * overwrite" tooltip); null for a built-in. */
  ownerName: string | null;
  visibility: 'private' | 'project' | null;
  /** Whether the actor may overwrite-Save this filter's criteria in place
   * (owner, or admin on a project-shared filter — the 6.2.1 matrix). A
   * built-in or another user's filter is false → only Save-as. */
  canOverwrite: boolean;
  builtin: boolean;
  /** The canonical `?filter=v1:` param of the saved envelope (null when the
   * saved filter has no conditions, e.g. the "All issues" built-in). The dirty
   * check compares the live URL param against this. */
  envelopeParam: string | null;
}

/** The canonical `?filter=v1:` param for an AST — null for "no filter" (no
 * conditions), matching `setAdvancedParam`'s own emptiness rule so an empty
 * builder and an absent param compare equal. */
export function currentFilterParam(ast: FilterAst | null): string | null {
  return ast !== null && ast.conditions.length > 0 ? encodeFilterParam(ast) : null;
}

/** Whether the live URL AST diverges from the applied filter's saved envelope
 * (6.1.1 canonical equality) — the chip's "Edited" marker. */
export function isAppliedFilterDirty(applied: AppliedSavedFilter, ast: FilterAst | null): boolean {
  return currentFilterParam(ast) !== applied.envelopeParam;
}

/** Whether the board's header filter differs from the board's own stored filter
 * (MOTIR-11565) — the SAME 6.1.1 canonical equality the saved-filter dirty check
 * uses, with the stored envelope as the reference. `current` is the effective
 * header filter (facets merged into the advanced AST); `stored` is the decoded
 * stored envelope. Two empty filters compare equal. It drives the board's
 * Edited mark, Save to board filter and Reset to board filter. */
export function differsFromBoardFilter(
  current: FilterAst | null,
  stored: FilterAst | null,
): boolean {
  return currentFilterParam(current) !== currentFilterParam(stored);
}

/** Build the session `AppliedSavedFilter` from a resolve read. Returns null
 * when the stored envelope is degraded (`ast === null`) — a broken filter
 * can't be applied (the caller surfaces the designed error instead). */
export function appliedFromResolved(resolved: ResolvedSavedFilterDto): AppliedSavedFilter | null {
  if (resolved.ast === null) return null;
  const { filter } = resolved;
  return {
    id: filter.id,
    name: filter.name,
    ownerName: filter.builtin ? null : filter.owner.name,
    visibility: filter.builtin ? null : filter.visibility,
    // canManage = owner or admin-on-shared (the 6.2.1 matrix); built-ins are
    // always false, so they only ever offer Save-as (forking a real row).
    canOverwrite: resolved.capabilities.canManage,
    builtin: filter.builtin,
    envelopeParam: currentFilterParam(resolved.ast),
  };
}
