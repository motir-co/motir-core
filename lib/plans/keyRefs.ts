import type { CorrectProposalInput, PlanItemPatch, ProposalInput } from '@/lib/dto/plans';
import { normalizeCorrectionEdges, normalizeProposalEdges } from '@/lib/plans/edgeReasons';
import { resolveWorkItemIdsByKeys } from '@/lib/mcp/tools/workItemRef';
import { PlanRefGraphError } from '@/lib/plans/errors';
import { isFolderRef, isTempRef, SUPERSEDES_PATCH_SITES } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// A plan ref written as a `<PREFIX>-<n>` KEY resolves to the work item's id, or
// is refused — never silently accepted (MOTIR-3576).
//
// ⚠️ IT LIVES HERE, NOT IN ONE DOOR, BECAUSE EVERY AUTHORING DOOR OWES IT
// (MOTIR-7983). It was written inside the MCP adapter (`lib/mcp/tools/
// authorPlan.ts`), and the doors Motir's own hosted planner writes through —
// `POST /api/internal/ai/plan-proposals` and the `mode: 'correct'` PATCH on
// `plan-proposals/[itemId]`, via `aiGenerationService` — stored the key
// verbatim. A `parentRef: "MOTIR-1101"` then sat in the plan with no resolvable
// parent, and the CLOSE refused the whole plan `dangling` after a 21-minute,
// 237-turn run had done all of its work. One module, called by both callers,
// is what keeps "resolve the key" a property of the REF rather than of the
// door somebody happened to reach for.

/**
 * `<PREFIX>-<n>` — the identifier EVERY OTHER MCP tool takes (`get_work_item`,
 * `transition_status`, `link_work_items`, `move_to_parent`,
 * `validate_work_item`). MOTIR-3576.
 *
 * ⚠️ IT CANNOT COLLIDE WITH THE TWO FORMS A REF ALREADY CARRIES, and that is
 * what makes accepting it safe rather than ambiguous. A work-item id is a cuid
 * (`cmta2n4os003li3phlyounsxm`) — no dash at all — and an intra-plan temp-ref is
 * `planItem:<cuid>`, which is excluded outright below. So a ref matching this
 * pattern is a key and nothing else.
 */
const WORK_ITEM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export function isWorkItemKey(ref: string): boolean {
  // A `folder:<id>` placement (MOTIR-5414) is passed through untouched: it names a
  // folder, never a work item, and the service judges it.
  return !isTempRef(ref) && !isFolderRef(ref) && WORK_ITEM_KEY_PATTERN.test(ref.trim());
}

/**
 * The TEN sites a ref can travel on — shared by BOTH authoring doors, because
 * they write the same columns (MOTIR-3934).
 *
 * ⚠️ IT IS A SHAPE, NOT A UNION OF THE TWO INPUT TYPES, and that is the point.
 * `ProposalInput` (the append) and `CorrectProposalInput` (the correction)
 * declare these four members identically; naming the shape once is what makes
 * "resolve the key" a property of the FIELD rather than of the door somebody
 * happened to reach for. The defect this closes was exactly that asymmetry: one
 * door honoured all three documented ref forms and the other honoured two.
 */
interface RefCarrierInput {
  parentRef?: string | null;
  blockedByRefs?: string[];
  /** `add` only — the older cards the created card supersedes (MOTIR-6631). */
  supersedesRefs?: string[];
  patch?: PlanItemPatch | null;
}

/** Every ref one proposal (or one correction) carries, across all ten sites. */
function refsOfCarrier(p: RefCarrierInput): string[] {
  return [
    ...(p.parentRef ? [p.parentRef] : []),
    ...(p.blockedByRefs ?? []),
    // The RE-PARENT ref (MOTIR-3859) takes a key exactly like the other four
    // sites — an agent that has just called `get_work_item { key: 'MOTIR-656' }`
    // has no reason to believe the argument changed meaning three lines later,
    // which is this function's whole argument.
    ...(p.patch?.parentRef ? [p.patch.parentRef] : []),
    ...(p.patch?.blockedByAdd ?? []),
    ...(p.patch?.blockedByRemove ?? []),
    // The FIVE `supersedes` carriers (Story MOTIR-6577 · MOTIR-6631). The service
    // accepts only ids and `planItem:` refs on them, so a key left here would reach
    // the validator as a string that is no id and be refused `dangling` — the
    // MOTIR-3576 defect on a new column. `SUPERSEDES_PATCH_SITES` is the list the
    // service's own ref passes walk, so a sixth list cannot be missed here alone.
    ...(p.supersedesRefs ?? []),
    ...SUPERSEDES_PATCH_SITES.flatMap((site) => p.patch?.[site] ?? []),
  ];
}

/**
 * ONE batched resolution for a whole call: every KEY-form ref across every
 * carrier, de-duplicated, through the same permission-scoped service every
 * key-addressed tool uses — so the 404-not-403 cross-tenant contract holds
 * unchanged. Returns the swap to apply per ref; a non-key ref (a cuid, a
 * `planItem:` temp-ref) maps to itself.
 */
async function keyRefSwapper(
  carriers: RefCarrierInput[],
  ctx: ServiceContext,
): Promise<(ref: string) => string> {
  const keys = [...new Set(carriers.flatMap(refsOfCarrier).filter(isWorkItemKey))];
  if (keys.length === 0) return (ref) => ref;

  let ids: string[];
  try {
    ids = await resolveWorkItemIdsByKeys(keys, ctx);
  } catch {
    // A key that resolves to nothing is the SAME failure as a dangling id, and
    // it is reported as one: one failure mode for "this ref names no work
    // item", not two that a caller has to tell apart. The offending key is
    // named; which of a batch's keys failed is recoverable from the message.
    throw new PlanRefGraphError(
      'dangling',
      'incoming',
      `A proposal's ref names no work item in this workspace. One of ${keys
        .map((k) => `"${k}"`)
        .join(', ')} could not be resolved — check the key, or pass the work item's id.`,
    );
  }

  const byKey = new Map(keys.map((k, i) => [k, ids[i]!]));
  return (ref) => byKey.get(ref) ?? ref;
}

/**
 * Swap the KEY-form refs inside a `modify`'s patch, PRESERVING absence.
 *
 * A `null` patch (the correction door's "clear it") and an absent one are both
 * returned untouched — the sparse contract is the caller's, not this
 * function's.
 */
function swapPatchRefs(
  patch: PlanItemPatch | null | undefined,
  swap: (ref: string) => string,
): PlanItemPatch | null | undefined {
  if (!patch) return patch;
  return {
    ...patch,
    ...(patch.parentRef ? { parentRef: swap(patch.parentRef) } : {}),
    ...(patch.blockedByAdd ? { blockedByAdd: patch.blockedByAdd.map(swap) } : {}),
    ...(patch.blockedByRemove ? { blockedByRemove: patch.blockedByRemove.map(swap) } : {}),
    // The four `supersedes` lists (MOTIR-6631), each swapped only when PRESENT so
    // an absent list stays absent — the patch is sparse.
    ...Object.fromEntries(
      SUPERSEDES_PATCH_SITES.filter((site) => patch[site]).map((site) => [
        site,
        patch[site]!.map(swap),
      ]),
    ),
  };
}

/**
 * Rewrite every `MOTIR-<n>`-form ref to the work-item ID the plan substrate
 * stores (MOTIR-3576).
 *
 * ⚠️ WHY THIS EXISTS AT ALL. `parentRef` / `blockedByRefs` are documented as
 * "a REAL work-item id", and the KEY form was neither resolved nor refused — it
 * was ACCEPTED, stored, passed `validate_plan`, closed to `planned`, and then
 * failed at the approve button with `dangling`, where the plan is immutable and
 * the only repair is to author a new one. An agent that has just called
 * `get_work_item { key: 'MOTIR-3440' }` has no reason to believe the argument
 * changed meaning three lines later, so the plan tools now agree with the rest
 * of the surface instead of asking the caller to remember an exception.
 *
 * ⚠️ AND IT RESOLVES ON THE WAY IN, never on the way out. A ref is not just an
 * argument: it is a value stored on the row and re-read at approve, by the
 * projection, and by `planStalenessService.isRealRef`. Translating here leaves
 * every one of those readers untouched and the column meaning exactly what it
 * meant; translating at read time would give it two possible contents for ever.
 *
 * ONE batched resolution per call, keys de-duplicated first, through the same
 * permission-scoped services every other key-addressed tool uses — so the
 * 404-not-403 cross-tenant contract holds unchanged.
 */
export async function resolveKeyRefs(
  proposals: ProposalInput[],
  ctx: ServiceContext,
): Promise<ProposalInput[]> {
  // An edge entry may arrive as `{ ref, reason }` (MOTIR-9827): split it into
  // the bare ref and an `edgeReasons` entry FIRST, so the swap below resolves the
  // ref and re-keys its reason with it.
  proposals = proposals.map(normalizeProposalEdges);
  const swap = await keyRefSwapper(proposals, ctx);
  return proposals.map((p) => ({
    ...p,
    parentRef: p.parentRef ? swap(p.parentRef) : p.parentRef,
    blockedByRefs: (p.blockedByRefs ?? []).map(swap),
    ...(p.supersedesRefs !== undefined ? { supersedesRefs: p.supersedesRefs.map(swap) } : {}),
    patch: swapPatchRefs(p.patch, swap),
    ...(p.edgeReasons !== undefined ? { edgeReasons: swapReasonKeys(p.edgeReasons, swap) } : {}),
  }));
}

/**
 * Re-key an edge-reason map (MOTIR-9827) by the same swap its refs took, so a
 * reason given against `MOTIR-<n>` still names the edge once the ref is an id.
 */
function swapReasonKeys(
  reasons: Record<string, string>,
  swap: (ref: string) => string,
): Record<string, string> {
  return Object.fromEntries(Object.entries(reasons).map(([ref, reason]) => [swap(ref), reason]));
}

/**
 * The SAME resolution, on the CORRECTION door (MOTIR-3934).
 *
 * ⚠️ WHY IT IS A SECOND FUNCTION AND NOT A SECOND CALLER OF THE ONE ABOVE. The
 * two inputs differ in exactly one way that matters here, and it is the way that
 * loses data: an append's `blockedByRefs` DEFAULTS to `[]`, so `?? []` is free,
 * while a correction's `blockedByRefs` is SPARSE — `undefined` leaves the set
 * alone and `[]` CLEARS it. Materialising the default would turn every
 * correction of some other field into a silent edge wipe. So the swap is written
 * against this input's own contract: absent stays absent, `null` stays `null`.
 *
 * Everything else is shared with the append — the same five sites, the same
 * batched lookup, the same `dangling` refusal — which is the whole fix. The
 * defect was one door resolving and the other storing the key verbatim, so a
 * `MOTIR-<n>` written through the correction door reached approve as a string
 * nothing could match.
 */
export async function resolveCorrectionKeyRefs(
  input: CorrectProposalInput,
  ctx: ServiceContext,
): Promise<CorrectProposalInput> {
  input = normalizeCorrectionEdges(input);
  const swap = await keyRefSwapper([input], ctx);
  const resolved: CorrectProposalInput = { ...input };
  if (input.parentRef) resolved.parentRef = swap(input.parentRef);
  if (input.blockedByRefs !== undefined) resolved.blockedByRefs = input.blockedByRefs.map(swap);
  // SPARSE like `blockedByRefs`: absent leaves the set alone, `[]` clears it.
  if (input.supersedesRefs !== undefined) {
    resolved.supersedesRefs = input.supersedesRefs.map(swap);
  }
  if (input.patch) resolved.patch = swapPatchRefs(input.patch, swap) as PlanItemPatch;
  if (input.edgeReasons !== undefined) {
    resolved.edgeReasons = swapReasonKeys(input.edgeReasons, swap);
  }
  return resolved;
}
