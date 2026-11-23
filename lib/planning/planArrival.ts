import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import {
  folderIdFromNodeId,
  folderNodeId,
  workItemCrumbLabel,
} from '@/lib/planning/projectCanvasModel';
import { fullestContainer, proposalLevelKey } from '@/lib/planning/planShape';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// WHERE A PLAN LANDS — moved here from `components/planning/PlanReviewCanvas.tsx`
// by MOTIR-6161, UNCHANGED.
//
// ── Why it moved, and why it was not copied ────────────────────────────────
// The planning SURFACE now follows a target that becomes known after it opened
// (Story MOTIR-6154), and one of the two moments a target becomes known is "the
// plan's proposals first show where it lands" — which is exactly this question.
// The surface is not the plan page, so it cannot import a component to ask it;
// and the story's own words are that the plan page's rule is "reused, not
// re-cut". Two implementations of "where does this plan land" would let the two
// surfaces disagree about it, which is the single thing this move prevents.
//
// Nothing in here is React, so the move is a relocation rather than a rewrite:
// `PlanReviewCanvas` re-exports `arrivalLevel` from here and its behaviour is
// byte-identical, which its own `plan-review-canvas*` tests hold unmodified.

/**
 * Where to OPEN the canvas: the container the plan most FILLS, plus the ANCESTOR
 * PATH down to it (bug MOTIR-3152; MOTIR-3260).
 *
 * A plan whose proposals sit under several parents has no single level — that is
 * the drill-down model working, not a gap — so the arrival level is the one
 * carrying the most proposals, and the rail remains the whole-plan list. A plan
 * that proposes only roots (or whose parents were archived, which resolves to no
 * parent at all) opens at the top level, exactly as a genuine root should.
 *
 * ⚠️ A PROPOSED CONTAINER COUNTS, and it did not (MOTIR-3260). This function used
 * to skip any item without a `parentIdentifier` — and `getPlanReview` sets that
 * field to null for an intra-plan (`planItem:`) parent, deliberately, because
 * such a parent is drawn ON the canvas rather than in the breadcrumb. So the
 * count discarded exactly the items the null describes: a plan proposing one
 * story under a committed epic PLUS five subtasks under that story scored one
 * edge and opened on the EPIC, with the five cards it is actually about one
 * undiscoverable drill away. `parentNodeId` IS populated for those items, and the
 * counting now lives in `planShape.ts`, which `MOTIR-3262`'s derived default
 * reads too — one implementation of "how is this plan spread", not two.
 *
 * ⚠️ The trail is the WHOLE CHAIN, not one crumb. The design asks for *"the
 * committed ancestor path down to the focused level, exactly as the roadmap draws
 * it"* (`design/ai-planning/design-notes.md` Part V §2 panel E), and a chain has
 * to be CARRIED — `parentTrail` on the review model — rather than synthesised
 * from the immediate parent. An EMPTY trail beside a non-null parent means the
 * chain could not be resolved (an archived ancestor); that degrades to the single
 * crumb the parent fields still name, so the canvas never arrives with no
 * breadcrumb at all. When the arrival parent is itself a PROPOSAL there is no
 * committed chain on that item — the trail is its own `parentTrail` plus one
 * crumb for the proposal, walked up as far as the proposal chain goes.
 *
 * ⚠️ A FOLDER IS A LEVEL (Bug MOTIR-5782; design Part XVIII §18.2). A filed
 * proposal is counted on its folder's level, so a plan that files everything into
 * one folder ARRIVES on that folder; the depth tie-break counts folder crumbs; an
 * exact tie goes to the level holding the plan's first proposal. The trail leads
 * with the folder crumbs (`folderTrail`), which navigate like `/roadmap`'s.
 */
export function arrivalLevel(
  items: PlanReviewItemDto[],
  /**
   * The word a PROPOSED crumb puts where a key would go — `planReview.proposedCrumb`,
   * *"New"* in English (Part IX §1.3).
   *
   * Passed in rather than looked up, because this function is PURE and is unit-
   * tested directly. An un-materialized `add` has `identifier: null` **by
   * construction**, and a placeholder key (`MOTIR-?`, `#new-3`) would assert a
   * work item that does not exist — on the one surface whose whole promise is
   * that nothing is real until approve. So the crumb keeps the committed
   * `KEY · Title` grammar and substitutes the SLOT, which makes the distinction
   * TEXT rather than colour.
   */
  proposedWord: string,
): { id: string; trail: CanvasCrumb[] } | null {
  const id = arrivalLevelId(items);
  if (id === null) return null;
  return { id, trail: trailTo(items, id, proposedWord) };
}

/**
 * WHICH LEVEL the canvas opens on — {@link arrivalLevel}'s `id` without the
 * breadcrumb: a work item's or proposal's node id, a folder's level
 * (`folder:<id>`), or `null` for the top level (and for a plan with no items).
 *
 * The ONE answer to "which level", read by the canvas (through `arrivalLevel`) and
 * by `getPlanReview`, which sizes this level for the derived list/canvas default
 * (Bug MOTIR-12144). The size used to pick its own level with the folder-blind
 * count, so a plan filed into a folder was measured on the project root while the
 * canvas opened on the folder.
 */
export function arrivalLevelId(items: readonly PlanReviewItemDto[]): string | null {
  return fullestContainer([...items], { folders: true })?.parentNodeId ?? null;
}

/**
 * The breadcrumb down to ANY level a proposal sits on — the planning surface's
 * arrivals count drills by it (MOTIR-6300; design Part XXIII §23.7). `[]` for the
 * top level. The same walk `arrivalLevel` takes, so the count and the arrival can
 * never name a level two different ways; the one addition is the LAST crumb's
 * `crumbKey` (the level's `MOTIR-<n>`, when it has one), which the pill names the
 * level by — `label` stays the display string, exactly as the follow offer reads
 * `crumbKey ?? label`.
 */
export function levelTrail(
  items: readonly PlanReviewItemDto[],
  levelId: string | null,
  proposedWord: string,
): CanvasCrumb[] {
  if (levelId === null) return [];
  const trail = trailTo([...items], levelId, proposedWord);
  const last = trail[trail.length - 1];
  if (!last || last.id !== levelId) return trail;
  const key =
    items.find((i) => i.nodeId === levelId)?.identifier ??
    items.find((i) => i.parentNodeId === levelId)?.parentIdentifier ??
    null;
  return key ? [...trail.slice(0, -1), { ...last, crumbKey: key }] : trail;
}

/**
 * The breadcrumb down to a container, committed or proposed.
 *
 * Walks UP from the container: each PROPOSED ancestor contributes one crumb
 * labelled `<proposedWord> · <title>`; the first COMMITTED one contributes the
 * `parentTrail` any item naming it carries, which is the whole committed chain.
 *
 * ⚠️ "PROPOSED" IS `identifier === null`, NOT "in this plan" (bug MOTIR-4266).
 * Being in `byNodeId` says the plan has something to SAY about the node, not
 * that the node is new: a `modify` / `remove` keys by the WORK ITEM it targets
 * (MOTIR-3160's one keying rule) and a materialized `add` re-keys to the card it
 * became (MOTIR-3161), so all three carry a real `MOTIR-<n>`. Labelling those
 * `New` inverts the substitution it belongs to — Part IX §1.3 puts the word in
 * the key's SLOT precisely because an un-materialized `add` has no key *"by
 * construction"*, and saying it about a card that HAS one asserts, on the one
 * surface whose promise is that nothing is real until approve, that something
 * real is not. The design says the same thing from the other side: Part XIII
 * names a row `<identifier> · <title>` for a `modify` / `remove` and
 * `New · <title>` for an `add`.
 *
 * Same rule as the View door and `heldNodeByPlanItemId` below, in the same
 * expression: an item carrying an identifier is a committed card.
 */
function trailTo(
  items: PlanReviewItemDto[],
  parentNodeId: string,
  proposedWord: string,
): CanvasCrumb[] {
  const byNodeId = new Map(items.map((item) => [item.nodeId, item]));
  // A FOLDER's level: its trail IS its folder chain, which any proposal filed
  // there carries.
  if (folderIdFromNodeId(parentNodeId) !== null) {
    return folderCrumbs(items.find((item) => proposalLevelKey(item) === parentNodeId));
  }
  const proposed: CanvasCrumb[] = [];
  const seen = new Set<string>();
  let top: PlanReviewItemDto | undefined;

  let cursor: string | null = parentNodeId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const proposal: PlanReviewItemDto | undefined = byNodeId.get(cursor);
    if (!proposal) {
      // COMMITTED. Any item under it carries the committed chain down to it; an
      // EMPTY one is the archived-ancestor degrade, and the single crumb the
      // parent fields still name is what keeps the breadcrumb from vanishing.
      const namer = items.find((item) => item.parentNodeId === cursor);
      const carried =
        namer?.parentTrail.map((c) => ({
          id: c.id,
          label: workItemCrumbLabel(c.identifier, c.title),
        })) ?? [];
      const committed =
        carried.length > 0
          ? carried
          : namer?.parentIdentifier
            ? [
                {
                  id: cursor,
                  label: workItemCrumbLabel(namer.parentIdentifier, namer.parentTitle ?? ''),
                },
              ]
            : [];
      // The committed chain's ROOT-MOST card may be filed; its folders lead.
      return [...folderCrumbs(namer), ...committed, ...proposed];
    }
    top = proposal;
    proposed.unshift({
      id: proposal.nodeId,
      label: workItemCrumbLabel(proposal.identifier ?? proposedWord, proposal.title),
    });
    cursor = proposal.parentNodeId;
  }
  // The chain ran out inside the plan — every ancestor is a proposal. Whatever
  // committed trail the TOPMOST one carries goes in front of them. Not the
  // container's: its trail already ends at the walked ancestors, so a root the
  // plan modifies would be named twice (bug MOTIR-6078).
  const carried =
    top?.parentTrail.map((c) => ({
      id: c.id,
      label: workItemCrumbLabel(c.identifier, c.title),
    })) ?? [];
  // …and the topmost proposal's folder, when it is filed into one.
  return [...folderCrumbs(top), ...carried, ...proposed];
}

/** A proposal's folder chain as navigable crumbs (`folder:<id>`, named). A stale
 *  folder has no level to navigate to, so it contributes none (decision 6). */
function folderCrumbs(item: PlanReviewItemDto | undefined): CanvasCrumb[] {
  if (!item || item.folderMissing) return [];
  return (item.folderTrail ?? []).map((f) => ({ id: folderNodeId(f.id), label: f.name }));
}
