'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type ProjectRoadmapCanvasProps,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import {
  mergePlanLevel,
  proposalsAtLevel,
  withProjectedCoverage,
} from '@/components/planning/planLevel';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import {
  buildWorkItemLevel,
  isNotInEpicRow,
  LEVEL_MORE_ID,
  NOT_IN_EPIC_ID,
} from '@/components/planning/workItemLevel';
import { FolderEmptyLevel } from '@/components/planning/WorkItemNode';
import { fetchRoadmapLevel } from '@/lib/planning/roadmapClient';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import {
  folderIdFromNodeId,
  folderNodeId,
  workItemCrumbLabel,
} from '@/lib/planning/projectCanvasModel';
import { proposalLevelKey } from '@/lib/planning/planShape';
import { folderChangeCounts } from '@/lib/planning/planChangeDiff';
import { ProposalPeek } from '@/components/planning/ProposalPeek';
import type { LiveDrafts } from '@/lib/planning/liveDraft';
import { WorkItemQuickView } from '@/components/planning/WorkItemQuickView';
import type { PlanEdgeCoverageDto, PlanReviewItemDto } from '@/lib/dto/planReview';
// ⚠️ `arrivalLevel` LIVES IN `lib/` NOW (MOTIR-6161) — the planning surface asks
// the same question and cannot import a component to ask it. Re-exported here so
// every existing importer and every `plan-review-canvas*` test keeps working
// against this module, unchanged.
import { arrivalLevel } from '@/lib/planning/planArrival';
import { inFlightCues, liveArrivals, liveEdits, proposalChangeKey } from '@/lib/planning/livePane';
import type { NodeCue } from '@/components/planning/PlanningCanvas';
import type { PlanProgressStep } from '@/lib/plans/planProgress';
import { ListTree } from 'lucide-react';
import { levelChangeFor, planElsewhere } from '@/lib/planning/levelChange';
import { LevelChangeBand } from '@/components/planning/LevelChangeBand';

export { arrivalLevel };

/**
 * Every node that IS one of the plan's proposals carries its content signature
 * (MOTIR-6300 → MOTIR-6297's `changeKey`), so a snapshot that fills in a card's
 * body or sizing plays the DEEPEN cue and never re-enters it. A committed card the
 * plan does not touch carries none.
 */
function withChangeKeys(level: RoadmapLevel, items: PlanReviewItemDto[]): RoadmapLevel {
  const byNodeId = new Map(items.map((i) => [i.nodeId, i]));
  return {
    ...level,
    nodes: level.nodes.map((n) => {
      const item = byNodeId.get(n.id);
      return item ? { ...n, changeKey: proposalChangeKey(item) } : n;
    }),
  };
}

// The canvas pane of the plan detail (7.4.5 / MOTIR-847, redrawn by MOTIR-3083).
//
// It MOUNTS the reusable `ProjectRoadmapCanvas` (MOTIR-1194) — it does not redraw
// a canvas (#82) — and it now feeds that canvas the SAME thing the roadmap does:
// one committed LEVEL at a time, with this plan's proposals merged in.
//
// Before this it fed a forest built from the PlanItems alone, so the canvas
// showed the proposals and nothing else. A proposal parented under a committed
// item then drew at the top level, indistinguishable from a genuine root, and a
// reviewer could not see the siblings the new card would land beside.
//
// `loadLevel` is the roadmap's own per-level read composed through the SHIPPED
// ADAPTERS, with `mergePlanLevel` layered on it — which is exactly the build note
// in `design/roadmap/design-notes.md`: *"the consumer re-feeds the engine the
// children of the focused node + their same-level `blocked_by` edges, and tracks
// the breadcrumb path; the engine is unchanged."*
//
// ⚠️ THE ADAPTERS ARE THE REUSE, NOT THE ROUTE (bug MOTIR-3152). This function
// used to `fetch` the roadmap endpoint itself and CAST the wire DTO to the canvas
// view model. The two shapes share no field name: `RoadmapNodeDto` carries
// `identifier` / `status` / `isDone`, and `ProjectCanvasNode` needs `content` /
// `searchText` / `drillable` / `crumbLabel`. The cast was from `unknown`, so
// nothing type-checked it and nothing failed — every committed node arrived with
// an undefined `content`, which `renderNode` painted into a 0×0 box. The card was
// not blank, it was INVISIBLE; no `drillable` meant no Open pill and so no way
// down; no `searchText` made the search box throw; and the edges, still
// `{ blockedId, blockerId }`, were dropped by the layout's id filter. So the
// committed level goes through `fetchRoadmapLevel` + `buildWorkItemLevel` — the
// same pair `PlanChangeCanvas` composes — and nothing here builds a canvas node
// by hand.
//
// `version` bumps `reloadKey` so the "live while generating" poll re-renders the
// current level as new PlanItems arrive.

export interface PlanReviewCanvasProps {
  items: PlanReviewItemDto[];
  /**
   * The COMMITTED edges this plan re-judges (MOTIR-6362): an edge whose parents'
   * edge a `modify` adds or removes was judged by the roadmap read against a parent
   * edge the plan is changing, so its `coverage` is replaced with the projected
   * one before the level is built. Absent ⇒ every committed edge draws as the
   * roadmap read judged it.
   */
  edgeCoverage?: readonly PlanEdgeCoverageDto[];
  /** The project the plan belongs to — the per-level roadmap read is keyed by it. */
  projectKey: string;
  /** Bumped by the parent on each poll update so the canvas refetches its level. */
  version: number;
  /** The plan's DECISION, once it has one (MOTIR-3161) — drawn on the plan's own
   *  nodes, never on the committed neighbours it decided nothing about. */
  outcome?: PlanItemOutcome | null;
  ariaLabel?: string;
  /**
   * WHERE THE READER ALREADY WAS, when a host swapped this canvas in underneath
   * them (MOTIR-6155). The plan page passes nothing and keeps ARRIVING at the
   * level the plan fills, which is right for a page opened on a plan.
   *
   * The planning surface is the case this exists for: it replaces
   * `PlanChangeCanvas` with this component the moment a plan is proposed, and a
   * reader who had drilled somewhere must not be moved off it (MOTIR-6161's rule).
   * Given a held trail, this canvas opens THERE instead of at `arrivalLevel`, and
   * the `followTo` below is what then offers the trip they did not take.
   */
  heldTrail?: readonly CanvasCrumb[] | null;
  /** Forwarded verbatim to the foundation — see its own contract. Together with
   *  `readerHasNavigated` this is how a swapped-in canvas declines a follow rather
   *  than yanking the reader, and how the bar comes to offer it. */
  followTo?: ProjectRoadmapCanvasProps['followTo'];
  onFollowDeclined?: (key: string) => void;
  readerHasNavigated?: boolean;
  /** MOTIR-8593 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `followMode`. */
  followMode?: ProjectRoadmapCanvasProps['followMode'];
  /** MOTIR-8593 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `onReaderNavigated`. */
  onReaderNavigated?: ProjectRoadmapCanvasProps['onReaderNavigated'];
  /** MOTIR-8594 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `followControl`. */
  followControl?: ProjectRoadmapCanvasProps['followControl'];
  /** MOTIR-8594 — forwarded verbatim; see `ProjectRoadmapCanvas`'s `followLevelId`. */
  followLevelId?: ProjectRoadmapCanvasProps['followLevelId'];
  onLevelChange?: (trail: readonly CanvasCrumb[]) => void;
  /**
   * The plan is being WRITTEN and this canvas is drawing it live (MOTIR-6300;
   * design Part XXIII). On: the level PLAYS each snapshot's change (`motion`,
   * MOTIR-6297), each proposal carries a `changeKey` from its content so a deepen
   * cues rather than re-enters, and arrivals on other levels are counted in the
   * breadcrumb row. OFF by default — the plan page never passes it, and is
   * unchanged by its existence.
   */
  live?: boolean;
  /**
   * The cards being WRITTEN (MOTIR-11201, Part XXIX) — handed to the open
   * proposal's quick view. Read only while `live`.
   */
  liveDrafts?: LiveDrafts | null;
  /**
   * OFFER THE TRIP when the plan is BESIDE the reader (bug MOTIR-6223, second
   * half): the pending plan places nothing on the level in view and something on
   * another, so the bar arms MOTIR-6161's *"Plan is in {identifier} · Go there"*.
   * The planning surface opts in; the plan page, which ARRIVES where the plan is
   * and has no follow to decline, passes nothing and is unchanged. Never while
   * `live` — the arrivals count owns that slot while the plan is written.
   */
  offerPlanElsewhere?: boolean;
  /**
   * The steps the planner is on RIGHT NOW (Story MOTIR-7820 · MOTIR-7830; design
   * Part XXVI §26.6–26.7) — `usePlanProgressReading`'s `liveSteps`, the ONE clock's
   * verdict (withdrawn targets, quiet sessions and every step of a stalled plan
   * already gone). Mapped, never filtered: an `author` step → the DRAFTING cue on
   * its node, a `lay` step → the LAYING cue on its parent (or, when the reader
   * stands inside that parent, the bar's marker); cues the reader cannot see are
   * counted in the arrivals slot. Read on `progress`, NOT on `live`, so the plan
   * page draws them too. Absent / `null` → no cue, and the canvas is unchanged.
   */
  liveSteps?: readonly PlanProgressStep[] | null;
  /**
   * The steps that may MOVE a card (Story MOTIR-8413 · MOTIR-8416) —
   * `readPlanAtWork(...).steps`, empty whenever Motir is not at work (a dropped
   * read, a stall, a resume, a settled plan). A DRAFTING cue whose node one of
   * them names is marked `moving`; a laying cue never moves. Presence stays
   * `liveSteps`'s: this only says which drawn cues move.
   */
  movingSteps?: readonly PlanProgressStep[] | null;
}

export function PlanReviewCanvas({
  items,
  edgeCoverage,
  projectKey,
  version,
  outcome = null,
  ariaLabel,
  heldTrail = null,
  followTo = null,
  onFollowDeclined,
  readerHasNavigated = false,
  followMode,
  onReaderNavigated,
  followControl,
  followLevelId,
  onLevelChange,
  live = false,
  liveDrafts = null,
  offerPlanElsewhere = false,
  liveSteps = null,
  movingSteps = null,
}: PlanReviewCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const tPlan = useTranslations('planReview');
  // A DECIDED plan keeps the control, in the PAST tense (Part IX §L7): *"what did
  // this plan change?"* is a better question after approve than before — the
  // cards are real now and sit among neighbours that were always there. A
  // DECLINED plan reads the same, because the record is of what the plan WOULD
  // have changed and the reader is asking the same thing.
  const decided = outcome !== null;
  const arrival = useMemo(() => arrivalLevel(items, tPlan('proposedCrumb')), [items, tPlan]);
  // FOLDER CRUMBS NAVIGATE (Bug MOTIR-5782; design Part XVIII decision 5). The
  // folder is a level on this canvas now, so its crumbs are `/roadmap`'s
  // (MOTIR-5742) and MOTIR-5418's text-only folder segment is retired: a filed
  // proposal is reached THROUGH its folder, whose crumb already names it.
  const isFolderCrumb = useCallback(
    (crumb: CanvasCrumb) => folderIdFromNodeId(crumb.id) !== null,
    [],
  );
  // An EMPTY folder's level says so in the folder's own words (MOTIR-5713 sheet 6).
  const emptyDrilledFor = useCallback(
    (focus: { id: string; label: string }) =>
      folderIdFromNodeId(focus.id) !== null ? <FolderEmptyLevel name={focus.label} /> : null,
    [],
  );
  // How many proposals sit behind each folder, DEEP (decision 3) — the badge on a
  // closed folder card, and the folders Show changes rings.
  const folderChanges = useMemo(() => folderChangeCounts(items), [items]);
  // A HELD trail wins over the arrival, and only a host that swapped this canvas
  // in has one (MOTIR-6155). `arrivalLevel` still decides for every other mount —
  // the plan page's, and the surface's when the reader had not moved.
  const initialTrail = useMemo<readonly CanvasCrumb[] | undefined>(
    () => (heldTrail && heldTrail.length > 0 ? heldTrail : (arrival?.trail ?? undefined)),
    [heldTrail, arrival],
  );

  // The DOOR (MOTIR-1351/1352): select a node → View → a peek. On every op.
  // An `add` peeks its PROPOSAL — there is no work item yet; anything else is an
  // ordinary committed node (a sibling, or a modify/remove's live target) and
  // gets the SHIPPED work-item peek, unchanged.
  //
  // ⚠️ A COMMITTED sibling now needs the id → identifier mapping every other
  // canvas consumer keeps (bug MOTIR-3152; `useWorkItemQuickView.registerItems`
  // is the shipped form of it). Before the fix a committed node carried no
  // `viewable` flag, so its View button never rendered and this handler only ever
  // saw a proposal. It renders now — and the peek is keyed by `MOTIR-<n>` while a
  // canvas node is keyed by its cuid, so without the mapping the newly reachable
  // affordance would ask for an id no work item has.
  const [peeked, setPeeked] = useState<{ proposal: PlanReviewItemDto | null; key: string | null }>({
    proposal: null,
    key: null,
  });
  // WHILE THE PLAN IS WRITTEN the open peek follows the live item by its
  // `planItemId` (MOTIR-8595), so a field that arrives mid-view reaches it. A
  // proposal withdrawn mid-view keeps its last copy: closing is the reader's act.
  // Off `live` it is the copy taken at open, as shipped.
  const peekedProposal =
    live && peeked.proposal
      ? (items.find((i) => i.planItemId === peeked.proposal?.planItemId) ?? peeked.proposal)
      : peeked.proposal;
  const byNodeId = useMemo(() => new Map(items.map((i) => [i.nodeId, i])), [items]);
  // node id → its identifier, accumulated as levels load. A ref, not state: it is
  // a lookup the View handler reads, never something a render depends on.
  const identifierByIdRef = useRef(new Map<string, string>());
  const onView = useCallback(
    (nodeId: string) => {
      const proposal = byNodeId.get(nodeId);
      // An `add` peeks its PROPOSAL only while it still IS one. Once the plan is
      // approved that proposal HAS become a work item and carries its real
      // identifier (MOTIR-3160's keying), so peeking it as a proposal would open
      // the pre-approval view of a card that now exists — a label that lies about
      // what clicking it does. An `add` with an identifier is a committed card;
      // peek it as one (MOTIR-3161).
      // EVERY PROPOSAL opens the shipped peek in PROPOSAL MODE (MOTIR-4185,
      // Part XIV §9). This used to branch on `op === 'add'`, which sent a
      // `modify` / `remove` to the committed peek — the shipped surface, showing
      // the target's CURRENT values with no sign a plan was about to change
      // them. That was half the defect this story closes; the other half was the
      // list door opening a different component altogether.
      //
      // ⚠️ The ONE `op === 'add'` test that SURVIVES is the materialized one
      // (MOTIR-3161), and it is below rather than here: an `add` that HAS an
      // identifier has become a work item, so peeking it as a proposal would
      // open the pre-approval view of a card that now exists.
      const materializedAdd = proposal?.op === 'add' && proposal.identifier != null;
      if (proposal && !materializedAdd) setPeeked({ proposal, key: null });
      // A COMMITTED sibling node — and a materialized `add`, which has become
      // one — opens the ordinary work-item peek, unchanged. A node that is
      // neither opens nothing rather than a peek for a key no work item has.
      else
        setPeeked({
          proposal: null,
          key: proposal?.identifier ?? identifierByIdRef.current.get(nodeId) ?? null,
        });
    },
    [byNodeId],
  );
  const closePeek = useCallback(() => setPeeked({ proposal: null, key: null }), []);
  // A proposed supersedes chip on the peek's rail opens THAT proposal's peek
  // (MOTIR-6632, Part XXIV §24.7).
  const openProposalById = useCallback(
    (planItemId: string) => {
      const next = items.find((i) => i.planItemId === planItemId);
      if (next) setPeeked({ proposal: next, key: null });
    },
    [items],
  );

  // ── The plan's node ids CHANGE at approve, and the canvas is holding them ────
  //
  // `materialize` re-keys every `add` to the work item it became — the review
  // model's one keying rule, `nodeId: item.workItemId ?? item.id` (MOTIR-3160) —
  // and resolves each intra-plan `planItem:` ref through the same map, so a
  // proposed container's children re-parent onto its new cuid too. Nothing about
  // that is wrong; what was missing is that a MOUNTED canvas is holding the old
  // id as its drilled focus and in its breadcrumb, and `PlanDetail`'s approve is
  // a re-render (a refetch + a version bump), not a remount. The reviewer
  // standing on a proposed container therefore watched their level go empty —
  // "No items at this level" — at the exact moment the rail said the plan was
  // approved (bug MOTIR-3439).
  //
  // The OLD id of a materialized `add` is precisely its `planItemId`, which is
  // the one field that never moves. So the map needs no memory of the previous
  // render: `planItemId → what that node is now` answers the canvas's question
  // from the CURRENT items alone.
  //
  // Only an `add` appears. A pending one is skipped because its `nodeId` IS its
  // `planItemId` (mapping it would be a no-op, and the resolver has to be
  // idempotent); a `modify` / `remove` is skipped because its `planItemId` is
  // never a canvas node id — its node is the committed card it targets, which
  // the canvas has held under that id all along.
  const heldNodeByPlanItemId = useMemo(() => {
    const byPlanItemId = new Map<string, CanvasCrumb>();
    for (const item of items) {
      if (item.op !== 'add' || item.nodeId === item.planItemId) continue;
      byPlanItemId.set(item.planItemId, {
        id: item.nodeId,
        // The crumb keeps the committed `KEY · Title` grammar. `New` stands in
        // the key's slot only while there is no key to put there — a
        // placeholder would assert a work item that does not exist
        // (`design/ai-planning/design-notes.md` Part IX §1.3) — and once the
        // card is real, saying `New` is the lie the substitution existed to
        // avoid. Same rule the View door already follows: an `add` carrying an
        // identifier is a committed card (MOTIR-3161).
        label: workItemCrumbLabel(item.identifier ?? tPlan('proposedCrumb'), item.title),
      });
    }
    return byPlanItemId;
  }, [items, tPlan]);
  const resolveHeldNode = useCallback(
    (id: string) => heldNodeByPlanItemId.get(id) ?? null,
    [heldNodeByPlanItemId],
  );

  // ── Is the level in view made ENTIRELY of this plan's cards? (bug MOTIR-3453) ─
  //
  // Part IX §1.4: drilling into a proposed container asks the roadmap for the
  // children of an id no work item has, `fetchRoadmapLevel` resolves an empty
  // committed level, and the proposals render alone. That is correct — and it
  // looks like nothing else on this surface, so the caption says why, or an
  // empty-looking canvas is read as a failed load.
  //
  // Recorded from `loadLevel`, because that is the only place both halves of the
  // answer are known at once: the COMMITTED read and the merged result. Written
  // in the async continuation, never synchronously in an effect (the CI lint
  // rule), and it feeds a PROP rather than the level, so it cannot loop — the
  // canvas holds `loadLevel` in a ref and refetches on focus / `reloadKey` only.
  //
  // It falls to false on approve WITHOUT a second rule: the cards are committed
  // by then, so the roadmap read returns them and the sentence stops being true
  // at the same moment it stops being sayable.
  const [levelIsAllProposed, setLevelIsAllProposed] = useState(false);

  // ── THE "Not in an epic" GROUP, and the CAP (MOTIR-4771) ───────────────────
  //
  // Part XVI DECISION 5: this canvas takes the SAME ruling as the overlay, and
  // its failure mode under the rejected dispositions is worse. `mergePlanLevel`
  // pushes any proposal it could not merge onto a committed node as a standalone
  // node, and its own comment says what that means — *"a `modify` / `remove`
  // whose target is not at this level (a DRIFTED plan)"*. So grouping a
  // proposal's target here does not merely hide a frame: it makes the plan READ
  // AS DRIFTED, which is a false statement about the plan, on the surface the
  // plan is approved from.
  //
  // THE THIRD CONJUNCT is therefore the SAME rule against this canvas's own merge
  // key: every node id the plan names stays on the road. It is the set the
  // "Show changes" emphasis below already walks, which is the point — the rows
  // the plan is about are the rows the reviewer must be able to see. A pending
  // `add`'s node id is its `planItemId` and can never be a committed row's id, so
  // it is inert here; a `modify` / `remove` keys by its TARGET, and a
  // materialized `add` re-keys to the card it became (MOTIR-3160 / MOTIR-3161),
  // which are exactly the three the design names.
  // …plus a pending `add`'s TARGET, which none of those three reaches: an add
  // proposed UNDER a committed row names it only through `parentNodeId`, and
  // grouping that row away files the proposal behind a door the reviewer cannot
  // open (it is drawn one level down, under the row that just left the level).
  // `op === 'add'` is the whole widening — a `modify` / `remove` already keys by
  // its own target, so pulling ITS parent onto the road would be over-wide.
  const touchedNodeIds = useMemo(() => {
    const ids = new Set(items.map((i) => i.nodeId));
    for (const i of items) {
      if (i.op === 'add' && i.parentNodeId !== null) ids.add(i.parentNodeId);
    }
    return ids;
  }, [items]);

  // DECISION 4's second half: *"the DETAIL keeps §6 and gains the tile too."* The
  // list-view arm (Part XIII §6) chooses the ARRIVAL VIEW for the arrival level;
  // the tile says a LEVEL is truncated once the reader is standing on the canvas
  // — after switching views, or after drilling. They answer different questions.
  // Keyed by the level the reader is STANDING ON, never the root (MOTIR-4501).
  const showAllRef = useRef(new Set<string>());
  const [showAllTick, setShowAllTick] = useState(0);
  const levelKeyRef = useRef<string | null>(null);
  const handleSelect = useCallback((id: string) => {
    if (id !== LEVEL_MORE_ID) return;
    const key = levelKeyRef.current;
    if (!key) return;
    showAllRef.current.add(key);
    setShowAllTick((n) => n + 1);
  }, []);

  // The projected dispositions for committed edges, keyed `blocked blocker`.
  const coverageOverride = useMemo(
    () => new Map((edgeCoverage ?? []).map((e) => [`${e.blockedId} ${e.blockerId}`, e.coverage])),
    [edgeCoverage],
  );
  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // An off-level blocker's ANCHOR is viewable (bug MOTIR-5387), and the peek
      // is keyed by `MOTIR-<n>` while the canvas hands `onView` a cuid. No level
      // read carries a blocker a PROPOSAL names, so its key is learned from the
      // review model's stub — or View asks for a key no work item has.
      for (const item of items) {
        for (const stub of item.blockerStubs) {
          if (stub.identifier) identifierByIdRef.current.set(stub.nodeId, stub.identifier);
        }
      }
      // THE GROUPED NODE'S LEVEL — synthetic, so it never asks the API for the
      // children of an id no work item has. This canvas keeps no level cache, so
      // the door RE-READS the root rather than reading one back: the MOTIR-4426
      // property holds here by construction, not by a cache-miss branch.
      if (parentId === NOT_IN_EPIC_ID) {
        levelKeyRef.current = null; // synthetic: no `levelTotal`, so no tile on it
        let grouped: RoadmapLevel = { nodes: [], deps: [] };
        if (projectKey) {
          // The root WITH folders (Bug MOTIR-5782), so a filed row is behind its
          // folder and never in the group.
          const root = await fetchRoadmapLevel(
            projectKey,
            null,
            'project',
            undefined,
            false,
            undefined,
            { folders: true },
          );
          for (const it of root.items) identifierByIdRef.current.set(it.id, it.identifier);
          const rows = root.items.filter((i) => isNotInEpicRow(i) && !touchedNodeIds.has(i.id));
          // ⚠️ EDGES SCOPED TO THE ROWS (bug MOTIR-3557) — the root's edge list is
          // the whole root level's, epics included, and handing it over whole
          // redraws every root epic as an anonymous "blocked elsewhere" ghost.
          const rowIds = new Set(rows.map((r) => r.id));
          // No `arrivingBlockers` here (bug MOTIR-4952): this level's id is
          // synthetic, so no proposal is parented on it — `proposalsAtLevel` is
          // empty for it by construction, and the map would be inert.
          grouped = buildWorkItemLevel(
            withProjectedCoverage(
              {
                items: rows,
                edges: root.edges.filter((e) => rowIds.has(e.blockedId)),
                offLevelBlockers: root.offLevelBlockers,
              },
              coverageOverride,
            ),
          );
        }
        // Nothing the plan touches is in here (the conjunct above), so no
        // proposal can merge onto this level and none is parented on the
        // synthetic id — but the merge still makes a row the plan puts work
        // UNDER drillable, which is how that proposal stays reachable.
        const merged = mergePlanLevel(grouped, items, parentId, outcome);
        // NOT the all-proposed caption: these are committed rows, and the caption
        // says the opposite (Part IX §1.4).
        setLevelIsAllProposed(false);
        return merged;
      }

      // The COMMITTED level. A failure here must not blank the review — the plan
      // is the page's subject and the surrounding tree is context — so it degrades
      // to "just this plan's proposals at that level", which is what the surface
      // showed before this change. `fetchRoadmapLevel` is already best-effort and
      // resolves an empty level rather than throwing, so the degrade is its.
      let committed: RoadmapLevel = { nodes: [], deps: [] };
      const levelKey = `${projectKey}:${parentId ?? '__root__'}`;
      // Written before the await, so an activation can never name the level this
      // load replaced.
      levelKeyRef.current = levelKey;
      // No project to read a level from — a pre-project discovery run
      // (`GenerationFlow`) proposes a tree before one exists, so there is no
      // committed neighbourhood and the proposals legitimately stand alone.
      if (projectKey) {
        // A FOLDER's level is read by the folder — its child folders, then the
        // work filed directly in it — and the root opts into the folder read, so
        // a filed row is drawn behind its folder rather than loose (Bug
        // MOTIR-5782; the `/roadmap` wiring, MOTIR-5710/5741).
        const folderId = folderIdFromNodeId(parentId);
        const wi = await fetchRoadmapLevel(
          projectKey,
          folderId !== null ? null : parentId,
          'project',
          undefined,
          showAllRef.current.has(levelKey),
          undefined,
          folderId !== null
            ? { folders: true, folderId }
            : parentId === null
              ? { folders: true }
              : undefined,
        );
        for (const it of wi.items) identifierByIdRef.current.set(it.id, it.identifier);
        for (const b of wi.offLevelBlockers) identifierByIdRef.current.set(b.id, b.identifier);
        const atRoot = parentId === null;
        const excluded = atRoot
          ? new Set(wi.items.filter((i) => touchedNodeIds.has(i.id)).map((i) => i.id))
          : undefined;
        // THE BLOCKERS THIS PLAN IS MOVING ONTO THE LEVEL (bug MOTIR-4952). The
        // roadmap read answers "is this blocker on the level?" from the level's
        // CURRENT children, and a relocating card is precisely the one that is not
        // among them yet — so a committed edge into a committed child drew the
        // whole cross-story treatment about a card this plan puts right beside it.
        // The consumer owns the question because the builder knows nothing about
        // plans, exactly as it owns `groupExcludeIds`.
        //
        // The value is `status === 'done'` — the SAME predicate `buildWorkItemLevel`
        // applies to every within-level committed edge, and the same one the
        // `committedBlockedBy` carrier uses (MOTIR-4951), so the arrow the reviewer
        // sees before approve is the arrow the tree draws after it.
        const arrivingBlockers = new Map(
          proposalsAtLevel(items, parentId).map((i) => [i.nodeId, i.status === 'done']),
        );
        // THE ROWS THIS PLAN MOVES OFF THE LEVEL (bug MOTIR-5006) — the mirror of
        // the map above, answered by the same reader for the same reason. A
        // proposal whose TARGET is one of this level's committed rows but whose
        // `parentNodeId` is some other level is re-parenting that card AWAY, and
        // the level's membership is the fourth thing the committed read cannot
        // answer about a card the plan is moving.
        //
        // ⚠️ IT KEYS ON THE PARENT DIFFERING, never on the card being NAMED by
        // the plan: a `modify` that re-skins in place sits at this level, so it
        // is excluded by the comparison rather than by a special case — which is
        // what keeps every ordinary `modify` drawing exactly where it does now.
        const levelRowIds = new Set(wi.items.map((i) => i.id));
        const departingIds = new Set(
          items
            .filter((i) => proposalLevelKey(i) !== parentId && levelRowIds.has(i.nodeId))
            .map((i) => i.nodeId),
        );
        committed = buildWorkItemLevel(withProjectedCoverage(wi, coverageOverride), {
          // Grouping is a statement about the PROJECT's roots, so it is the root
          // level's alone — a drilled level's rows are somebody's children.
          groupNonEpicRoots: atRoot,
          arrivingBlockers,
          departingIds,
          ...(excluded ? { groupExcludeIds: excluded } : {}),
          groupCrumbLabel: t('group.title'),
          levelTotal: wi.levelTotal,
          // A closed folder holding proposals says so (Part XVIII decision 3).
          folderChanges,
        });
      }
      const merged = mergePlanLevel(committed, items, parentId, outcome);
      setLevelIsAllProposed(committed.nodes.length === 0 && merged.nodes.length > 0);
      return live ? withChangeKeys(merged, items) : merged;
    },
    [items, projectKey, outcome, touchedNodeIds, folderChanges, t, live, coverageOverride],
  );

  // The plan's cards for the ARRIVALS count (§23.7) — only while it is written.
  const proposedWord = tPlan('proposedCrumb');
  const arrivals = useMemo(
    () => (live ? liveArrivals(items, proposedWord) : null),
    [live, items, proposedWord],
  );
  // …and their EDIT times, for the changed highlight (MOTIR-11185) — likewise only
  // while it is written, so a decided plan lights nothing.
  const changes = useMemo(
    () => (live ? liveEdits(items, proposedWord) : null),
    [live, items, proposedWord],
  );

  // ── THE CUES (MOTIR-7830; Part XXVI §26.6–26.7) ───────────────────────────
  // The live steps → a cue per node, and where each one is for the arrivals slot.
  // `liveSteps` is the derivation's: nothing here decides which steps are live.
  const tCue = useTranslations('planReview.cue');
  const cueState = useMemo(
    () => (liveSteps ? inFlightCues(items, liveSteps, proposedWord) : null),
    [items, liveSteps, proposedWord],
  );
  const moving = useMemo(
    () =>
      movingSteps && movingSteps.length > 0
        ? inFlightCues(items, movingSteps, proposedWord).cues
        : null,
    [items, movingSteps, proposedWord],
  );
  const nodeCues = useMemo<ReadonlyMap<string, NodeCue> | null>(() => {
    if (!cueState) return null;
    const out = new Map<string, NodeCue>();
    for (const [nodeId, kind] of cueState.cues) {
      out.set(
        nodeId,
        kind === 'drafting'
          ? {
              kind,
              label: tCue('draftingName'),
              text: tCue('drafting'),
              ...(moving?.get(nodeId) === 'drafting' ? { moving: true } : {}),
            }
          : { kind, label: tCue('layingName'), text: tCue('laying') },
      );
    }
    return out;
  }, [cueState, moving, tCue]);

  // ── A CHANGE TO THE LEVEL ITSELF (bug MOTIR-6223; design MOTIR-6241) ───────
  // `mergePlanLevel` frames the nodes ON a level, and the level the reader stands
  // in is not one of them — so the plan's change to it is drawn in the bar
  // instead, asked of whichever level is in view (arrived, drilled or followed).
  //
  // …and so is the LAYING cue on the level the reader stands INSIDE (§26.7 row 2):
  // its parent is not a card on this level, so the bar carries *Laying this level*.
  // Beside the change band when both apply; `null` when neither does, so the bar
  // stays the one that shipped.
  const levelBand = useCallback(
    (focus: { id: string }) => {
      const change = levelChangeFor(items, focus.id, outcome);
      const laying = cueState?.cues.get(focus.id) === 'laying';
      const marker = laying ? (
        <div
          data-testid="canvas-crumb-cue"
          className="mt-[5px] flex min-w-0 items-center border-t border-(--el-border-soft) pt-[5px]"
        >
          <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-(--el-status-in-progress) bg-(--el-card) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] leading-none font-semibold text-(--el-text-secondary)">
            <ListTree aria-hidden="true" className="size-3 text-(--el-status-in-progress)" />
            {tCue('layingHere')}
          </span>
        </div>
      ) : null;
      if (change && marker) {
        return (
          <>
            <LevelChangeBand change={change} outcome={outcome} />
            {marker}
          </>
        );
      }
      return change ? <LevelChangeBand change={change} outcome={outcome} /> : marker;
    },
    [items, outcome, cueState, tCue],
  );
  // …and the plan BESIDE the reader, on the surface that opts in.
  const elsewhereOffer = useCallback(
    (trail: readonly CanvasCrumb[]) => {
      const where = planElsewhere(items, trail, proposedWord);
      return where ? { key: `elsewhere:${where.levelId ?? 'root'}`, trail: where.trail } : null;
    },
    [items, proposedWord],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        onView={onView}
        loadLevel={loadLevel}
        onSelect={handleSelect}
        reloadKey={`${version}:${proposalsAtLevel(items, null).length}:${showAllTick}`}
        initialTrail={initialTrail}
        followTo={followTo}
        onFollowDeclined={onFollowDeclined}
        readerHasNavigated={readerHasNavigated}
        followMode={followMode}
        onReaderNavigated={onReaderNavigated}
        followControl={followControl}
        followLevelId={followLevelId}
        onLevelChange={onLevelChange}
        // The level the reviewer is standing on FOLLOWS its container through
        // approve, rather than being left addressed by an id that has stopped
        // naming anything (bug MOTIR-3439).
        resolveHeldNode={resolveHeldNode}
        isFolderCrumb={isFolderCrumb}
        emptyDrilledFor={emptyDrilledFor}
        // Part IX §1.4's caption, on the one level that needs it. The foundation
        // owns the slot and knows only that it has nodes; which KIND of nodes
        // they are is this consumer's to say.
        levelCaption={levelIsAllProposed ? tPlan('allProposedLevel') : undefined}
        searchable
        // The page is a PLAN, so the search box says so (MOTIR-4021, Part XIII
        // §5). It read `roadmap.canvas.search` — "Search the roadmap" — on a
        // surface that is not the roadmap, because the foundation used to own
        // the string. The consumer owns it now, exactly as it owns `emphasis`'s.
        searchLabel={tPlan('searchLabel')}
        // SHOW CHANGES (MOTIR-3261) — the set is EVERY proposal's node id,
        // whatever its `op`, which is what the request's *added / updated /
        // archived* names. A `modify` / `remove` shares its node id with the
        // committed card it targets, so the ring lands ON that card rather than
        // beside it — already how `mergePlanLevel` re-skins them, which is why
        // the emphasis needs no per-op special case.
        //
        // The op languages stay exactly as panel B draws them: they say WHICH
        // change this is, the emphasis says THAT there is one. Orthogonal, and
        // neither an alternative to the other.
        //
        // The COPY comes from here rather than the foundation, which has no idea
        // it is showing a plan and cannot name what "the plan's changes" are.
        // ARMED ON ARRIVAL (MOTIR-4020, Part XIII §3): the foundation derives the
        // armed state per level now, so this consumer supplies only the words. A
        // DECIDED plan arrives armed too, in the past tense — *"what did this plan
        // change?"* is a better question after approve than before it, and the
        // decided pane exists to be a RECORD (Part VI).
        emphasis={{
          // …and every FOLDER holding one, so a closed folder with work changing
          // behind it is ringed like a card (Part XVIII decision 3).
          ids: [...items.map((i) => i.nodeId), ...[...folderChanges.keys()].map(folderNodeId)],
          total: items.length,
          label: decided ? tPlan('showChangesPast') : t('showChanges'),
          emptyLabel: t('showChangesNone'),
          // The other degenerate level — every card on it is this plan's — where
          // ringing everything says nothing (§3d, reversing Part IX §L6).
          allLabel: tPlan('showChangesAll'),
          // The LOCATE control walks this same set (§4). Its shipped labels name
          // a READY frontier, which a proposal never is.
          locateLabel: tPlan('locateChange'),
        }}
        // ⚠️ MOUNTED HERE FOR THE FIRST TIME (MOTIR-4020). The control was doubly
        // out of reach on this surface: this consumer passed no `locatable`, and
        // the ladder behind it targeted `here` / `ready` nodes. It now walks the
        // emphasised set, so it has something to find.
        locatable
        // The root crumb goes where the ROADMAP's does — `parentId = null`, the
        // project's top level — so it is labelled the way the roadmap labels it
        // (bug MOTIR-3152). It used to read "Plan" while navigating to the project
        // roadmap root, which named a destination it did not have; and the design
        // asks for the breadcrumb *"exactly as the roadmap draws it"*, which is
        // this label, on this consumer, for the same reason `PlanChangeCanvas`
        // uses it.
        rootLabel={t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? 'Proposed plan'}
        // LIVE (MOTIR-6300): the level plays each snapshot's change, and arrivals
        // elsewhere are counted rather than jumped to. Off on the plan page.
        motion={live}
        arrivals={arrivals}
        changes={changes}
        levelBand={levelBand}
        elsewhereOffer={offerPlanElsewhere && !live ? elsewhereOffer : undefined}
        // THE CUES (MOTIR-7830) — on the live steps, motion or not.
        nodeCues={nodeCues}
        inFlight={cueState?.inFlight ?? null}
      />
      {/* Every PROPOSAL — `add`, `modify` and `remove` — opens the shipped peek in
          proposal mode (MOTIR-4185). A COMMITTED sibling node still opens the
          ordinary work-item peek below, unchanged. */}
      <ProposalPeek
        item={peekedProposal}
        live={live}
        liveDrafts={liveDrafts}
        outcome={outcome}
        onClose={closePeek}
        onOpenProposal={openProposalById}
      />
      <WorkItemQuickView peekKey={peeked.key} onClose={closePeek} />
    </>
  );
}
