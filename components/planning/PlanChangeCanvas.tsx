'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type CanvasTargetAction,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { useWorkItemQuickView } from '@/components/planning/useWorkItemQuickView';
import {
  buildWorkItemLevel,
  folderIdFromNodeId,
  isNotInEpicRow,
  LEVEL_MORE_ID,
  NOT_IN_EPIC_ID,
} from '@/components/planning/workItemLevel';
import { FolderEmptyLevel } from '@/components/planning/WorkItemNode';
import { decorateTargetLevel } from '@/components/planning/PlanningTargetNode';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';
import { MAX_PLANNING_TARGETS, type PlanningTarget } from '@/lib/planning/planningTargets';

// The CANVAS pane of the plan-change conversation (Subtask MOTIR-1730; design
// panel 4 — "the review surface is the CANVAS, not a corner dock"). A sibling
// consumer of the reusable `ProjectRoadmapCanvas`, exactly like `WorkItemRoadmap`
// (the plain roadmap) and `PlanReviewCanvas` (the 7.21 plan detail): it reads the
// project ONE LEVEL AT A TIME from the shipped per-level endpoint (MOTIR-1010 —
// never a whole-forest load, `notes.html` #91) and builds the level with the
// SHIPPED `buildWorkItemLevel`, with the planning TARGET ringed on it.
//
// ⚠️ IT DRAWS NO PROPOSAL (MOTIR-6299). It is the pane for the "no plan" state:
// the host mounts `PlanProposalViews` — and so `PlanReviewCanvas` and its ONE
// level builder, `mergePlanLevel` — whenever there is a plan to show. This canvas
// used to carry a second builder of its own (`planChangeLevel.tsx`, with its own
// diff frame and a `proposed:` drill), which the host had already stopped
// reaching; it was deleted rather than re-pointed, so there is one place the card
// and edge rules live. `tests/planning/oneLevelBuilder.test.ts` keeps it that way.
//
// `diffKey` is the CLIENT-ISLAND refetch trigger (`motir-core/CLAUDE.md`): the
// canvas seeds its level once per `reloadKey`, so the host bumps this key when
// the committed tree changes (an approve commits it) and the current level
// re-reads in place — drill / zoom / pan preserved.

const ROOT_KEY = '__root__';

export interface PlanChangeCanvasProps {
  projectKey: string;
  /** Bumped by the host whenever the committed tree may have changed — the level
   *  cache is dropped and the current level re-read. */
  diffKey: string | number;
  /** The chat's planning TARGETS, by work-item id (MOTIR-1491) — the ones on the
   *  CURRENT level take the target ring, so the user sees what the planner is
   *  pointed at. */
  targetIds?: readonly string[];
  /** Turn on the selected card's **Set as target** / **Remove target**
   *  (MOTIR-6898). The planning surface passes it; nothing else does. Called with
   *  the card's work item and whether it is a target already. */
  onToggleTarget?: (target: PlanningTarget, isTarget: boolean) => void;
  /** False at the target cap: Set is disabled, Remove still works. */
  canAddTarget?: boolean;
  /** The level the canvas OPENS on, as a breadcrumb trail (MOTIR-2070) — the host
   *  passes the `?item=` anchor's ancestor chain, so a workspace summoned FROM a
   *  work item arrives on that item's own level instead of the project root, where
   *  its target ring would be drawn on a level nobody is looking at. Empty /
   *  omitted → the root, unchanged. */
  initialTrail?: readonly CanvasCrumb[];
  /** The card the canvas OPENS centred on, at a readable zoom (MOTIR-11472) — the
   *  host passes the `?item=` target, so a busy level does not shrink the card it
   *  was opened for. A mount-time seed for the arrival level only; a target the
   *  canvas opened INSIDE is the crumb, not a card, and changes nothing. */
  initialCentreId?: string | null;
  /** FOLLOW a target that became known after the surface opened (MOTIR-6161) — a
   *  keyed, one-shot request the canvas may DECLINE if the reader has already
   *  navigated. Forwarded verbatim; this canvas adds nothing to the contract. */
  followTo?: { key: string; trail: readonly CanvasCrumb[] } | null;
  /** The canvas declined the request above, so the host can offer its own way
   *  there rather than leaving the reader beside a plan they cannot see. */
  onFollowDeclined?: (key: string) => void;
  /** The reader moved the canvas THEMSELVES — a drill, a crumb, Back or a search
   *  jump. Reported so a host that later SWAPS this canvas away can carry the fact
   *  to its replacement (MOTIR-6155); it fires only for the reader's own moves,
   *  never for a granted `followTo`, which is what makes it usable as that signal. */
  onLevelChange?: (trail: readonly CanvasCrumb[]) => void;
  ariaLabel?: string;
  /** What fills the canvas while the first level is still being read
   *  (MOTIR-2069) — the workspace passes its level-shaped skeleton. */
  loadingFallback?: ReactNode;
  /** The workspace's own "nothing to draw yet" statement for an established but
   *  EMPTY project (MOTIR-2069). The canvas decides when to show it, off the
   *  level it reads itself — the page no longer reads the roots to pre-decide. */
  emptyRoot?: ReactNode;
}

export function PlanChangeCanvas({
  projectKey,
  diffKey,
  targetIds,
  onToggleTarget,
  canAddTarget = true,
  initialTrail,
  initialCentreId = null,
  followTo = null,
  onFollowDeclined,
  onLevelChange,
  ariaLabel,
  loadingFallback,
  emptyRoot,
}: PlanChangeCanvasProps) {
  const t = useTranslations('roadmap.canvas');
  const tWorkspace = useTranslations('planningWorkspace');
  const { registerItems: registerForView, onView, quickView } = useWorkItemQuickView();
  // Every work item a level has drawn, by id — the target action needs the
  // item's key, title and kind to add it, and the canvas node carries none of
  // them. Filled by the same call that feeds the quick-view peek, so a card is
  // eligible exactly when View can open it.
  const itemsRef = useRef(new Map<string, PlanningTarget>());
  const registerItems = useCallback(
    (level: RoadmapLevelData) => {
      for (const item of level.items) {
        itemsRef.current.set(item.id, {
          id: item.id,
          identifier: item.identifier,
          title: item.title,
          kind: item.kind,
        });
      }
      registerForView(level);
    },
    [registerForView],
  );

  // Levels cached so re-drilling doesn't re-hit the API; a mutable ref, so a new
  // key simply misses. Cleared whenever `diffKey` changes, since an approve has
  // committed items the cached level no longer describes.
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  const cacheKeyRef = useRef(diffKey);

  // ── THE CAP, on this surface (MOTIR-4771; Part XVI DECISION 4) ──────────────
  //
  // `TREE_LEVEL_MAX_TAKE` discards the NEWEST rows under a key-ASC sort, and until
  // now this canvas said nothing about it at all — two surfaces over one project
  // could disagree about whether the project has all its epics, and only
  // `/roadmap` admitted it. The overlay gets the TILE rather than the plan
  // detail's list-view arm (§6), because the overlay has no list view for that
  // arm to choose.
  //
  // The levels the reader has asked to see WHOLE, by cache key, and the key of
  // the level they are standing on — which is what the tile's activation uncaps
  // (bug MOTIR-4501: uncapping the ROOT's key leaves a drilled level capped and
  // makes the tile inert on every level but one).
  const showAllRef = useRef(new Set<string>());
  const [showAllTick, setShowAllTick] = useState(0);
  const levelKeyRef = useRef<string | null>(null);

  // The target set as a STABLE dependency: the prop is a fresh array on every
  // host render, so the joined key is what `loadLevel` (and the reload key
  // below) depend on — the level is rebuilt when the SET changes, not on every
  // keystroke in the composer.
  const targetKey = (targetIds ?? []).join(',');

  // The cache key of THIS mount's ROOT level — the one the grouped node's drill
  // reads back from. Kept as one helper so the key can never be spelled two ways
  // (the same discipline `WorkItemRoadmap.rootCacheKey` keeps, for the same door).
  const levelCacheKey = useCallback(
    (parentId: string | null) => `${projectKey}:${parentId ?? ROOT_KEY}`,
    [projectKey],
  );

  // THE ROOT LEVEL, READ RATHER THAN REMEMBERED (the MOTIR-4426 property, ported).
  // The grouped node's level is SERVED FROM the root read, and a cached value is
  // not a source: this canvas clears every cached level whenever `diffKey` moves
  // — an approve — which is exactly the beat a reader standing
  // INSIDE the group is most likely to be standing there for. A miss RE-READS, so
  // the door opens on the rows instead of on "No items at this level". A HIT is
  // untouched, so an ordinary drill still issues no request.
  const readRootLevel = useCallback(async (): Promise<RoadmapLevelData> => {
    const key = levelCacheKey(null);
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    // FOLDERS (Bug MOTIR-5782; design Part XVIII decision 1): the root reads the
    // folder treatment exactly as `/roadmap` does — filed rows leave the root and
    // the root folders come back as doors.
    const wi = await fetchRoadmapLevel(
      projectKey,
      null,
      'project',
      undefined,
      showAllRef.current.has(key),
      undefined,
      { folders: true },
    );
    cacheRef.current.set(key, wi);
    return wi;
  }, [projectKey, levelCacheKey]);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const targets = targetKey === '' ? [] : targetKey.split(',');

      if (cacheKeyRef.current !== diffKey) {
        cacheKeyRef.current = diffKey;
        cacheRef.current.clear();
      }

      // THE GROUPED NODE'S LEVEL (MOTIR-4771) — synthetic, and served from the
      // ROOT level this canvas has already fetched: those rows came back in the
      // root read and grouping only decided where to draw them. Same shape as the
      // roadmap's door, for the same reason — no work item backs the node, so
      // asking the API for its children asks for the children of an id it has
      // never heard of.
      if (parentId === NOT_IN_EPIC_ID) {
        // Synthetic: no cache key of its own, and it passes no `levelTotal`, so no
        // tile is drawn on it and an activation can never name it (MOTIR-4501).
        levelKeyRef.current = null;
        const root = await readRootLevel();
        // Owed here as well as on the root load: the peek's id → identifier map is
        // filled by whichever load ran, and a RE-READ level whose rows were never
        // registered would leave View inert on this level alone (MOTIR-4426).
        registerItems(root);
        const rows = root.items.filter(isNotInEpicRow);
        // ⚠️ THE EDGES ARE SCOPED TO THE ROWS (bug MOTIR-3557). The root's edge
        // list is the edges of the WHOLE root level, epics included; handing it
        // over whole makes every root epic an off-level blocker of a level it has
        // nothing to do with, and each draws as an anonymous red ghost anchor.
        const rowIds = new Set(rows.map((r) => r.id));
        const grouped: RoadmapLevelData = {
          items: rows,
          edges: root.edges.filter((e) => rowIds.has(e.blockedId)),
          offLevelBlockers: root.offLevelBlockers,
        };
        return decorateTargetLevel(buildWorkItemLevel(grouped, { markActive: true }), targets);
      }

      // A FOLDER'S LEVEL (Bug MOTIR-5782; design Part XVIII decisions 1–2) — a real
      // read, addressed by the folder: its child folders, then the work items
      // filed directly in it. No grouped node: inside a folder the folder is
      // already the drawer. Its cache key is the focus id itself, which no work
      // item id can collide with.
      const folderId = folderIdFromNodeId(parentId);
      if (folderId !== null) {
        const key = levelCacheKey(parentId);
        levelKeyRef.current = key;
        let folderLevel = cacheRef.current.get(key);
        if (!folderLevel) {
          folderLevel = await fetchRoadmapLevel(
            projectKey,
            null,
            'project',
            undefined,
            showAllRef.current.has(key),
            undefined,
            { folders: true, folderId },
          );
          cacheRef.current.set(key, folderLevel);
        }
        registerItems(folderLevel);
        return decorateTargetLevel(
          buildWorkItemLevel(folderLevel, {
            markActive: true,
            levelTotal: folderLevel.levelTotal,
          }),
          targets,
        );
      }

      const cacheKey = levelCacheKey(parentId);
      // The level the reader is now on OWNS this key — the tile's activation reads
      // it back (bug MOTIR-4501). Written before the await, so an activation can
      // never name the level this load replaced.
      levelKeyRef.current = cacheKey;
      let wi = cacheRef.current.get(cacheKey);
      if (!wi) {
        // `all` only for a level the reader explicitly asked to see whole.
        wi =
          parentId === null
            ? await readRootLevel()
            : await fetchRoadmapLevel(
                projectKey,
                parentId,
                'project',
                undefined,
                showAllRef.current.has(cacheKey),
              );
        cacheRef.current.set(cacheKey, wi);
      }
      registerItems(wi);

      const atRoot = parentId === null;
      return decorateTargetLevel(
        buildWorkItemLevel(wi, {
          markActive: true,
          // Grouping is a statement about the PROJECT's roots, so it is the root
          // level's alone — a drilled level's rows are somebody's children and
          // belong exactly where they are.
          groupNonEpicRoots: atRoot,
          groupCrumbLabel: t('group.title'),
          levelTotal: wi.levelTotal,
        }),
        targets,
      );
    },
    [projectKey, diffKey, registerItems, targetKey, levelCacheKey, readRootLevel, t],
  );

  // THE TRUNCATION TILE'S ACTIVATION (MOTIR-4771; Part XVI DECISION 4). The canvas
  // reports an activated node through `onSelect`; the tile is not a work item, so
  // it is intercepted here rather than passed on. Drop the level's cached copy,
  // mark it `all`, and bump the tick — which folds into `reloadKey` and re-runs
  // the load for the level the reader is STANDING ON, not the root (bug
  // MOTIR-4501). A null key means the level on screen is synthetic and draws no
  // tile, so there is nothing this activation could have come from.
  const handleSelect = useCallback((id: string) => {
    if (id !== LEVEL_MORE_ID) return;
    const key = levelKeyRef.current;
    if (!key) return;
    showAllRef.current.add(key);
    cacheRef.current.delete(key);
    setShowAllTick((n) => n + 1);
  }, []);

  // FOLDER CRUMBS navigate (Part XVIII decision 5 — MOTIR-5742's crumb, as
  // `/roadmap` draws it), and an EMPTY folder's level says so in the folder's own
  // words rather than the generic "no children" (decision 1, MOTIR-5713 sheet 6).
  const isFolderCrumb = useCallback(
    (crumb: CanvasCrumb) => folderIdFromNodeId(crumb.id) !== null,
    [],
  );
  // THE TARGET CRUMB (MOTIR-6160, Story MOTIR-6154). The surface opens INSIDE the
  // node being planned, so the target is no longer a node on the level wearing
  // `decorateTargetLevel`'s ring — it IS the level. This answers it from the same
  // `targetIds` that rings a node, which is what keeps the two marks one fact:
  // whichever of the crumb and the node the target currently is, exactly one of
  // them is marked, and neither needs to know about the other.
  //
  // It also means the FOLLOW-MOVE (MOTIR-6161) needs no wiring here at all — a
  // target added to the set later marks its crumb the moment the canvas stands
  // in it.
  const targetIdSet = useMemo(() => new Set(targetIds ?? []), [targetIds]);
  const isTargetCrumb = useCallback(
    (crumb: CanvasCrumb) => targetIdSet.has(crumb.id),
    [targetIdSet],
  );
  const tTargets = useTranslations('planningWorkspace.targets');
  const targetAction = useMemo<CanvasTargetAction | undefined>(() => {
    if (!onToggleTarget) return undefined;
    return {
      isEligible: (id) => itemsRef.current.has(id),
      isTarget: (id) => targetIdSet.has(id),
      // Asked only for an id `isEligible` passed, which is exactly a key in the map.
      keyFor: (id) => itemsRef.current.get(id)!.identifier,
      canAdd: canAddTarget,
      disabledReason: tTargets('limitReached', { max: MAX_PLANNING_TARGETS }),
      onToggle: (id) => {
        const item = itemsRef.current.get(id);
        if (item) onToggleTarget(item, targetIdSet.has(id));
      },
    };
  }, [onToggleTarget, canAddTarget, targetIdSet, tTargets]);
  const emptyDrilledFor = useCallback(
    (focus: { id: string; label: string }) =>
      folderIdFromNodeId(focus.id) !== null ? <FolderEmptyLevel name={focus.label} /> : null,
    [],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        onSelect={handleSelect}
        // Re-runs the CURRENT level's load when the committed tree — or the target
        // set — changes, so the target ring appears (and disappears) without a
        // remount, drill / zoom / pan preserved.
        reloadKey={`plan-change:${diffKey}:${targetKey}:${showAllTick}`}
        // The anchored arrival (MOTIR-2070). A seed, read once at mount — the
        // reloads above re-run the CURRENT level, wherever the user has since
        // navigated to, and never drag them back here.
        initialTrail={initialTrail}
        // …and the opening VIEW on that level (MOTIR-11472): the target card at
        // the readable zoom, not the whole level fitted. Also read once.
        initialCentreId={initialCentreId}
        onView={onView}
        targetAction={targetAction}
        searchable
        // This canvas draws the PROJECT, so a reader searching here is searching
        // the tree (MOTIR-4021, Part XIII
        // §5). The namespace is this feature's own, `planningWorkspace`.
        searchLabel={tWorkspace('searchLabel')}
        fullScreenable
        locatable
        rootLabel={t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? t('ariaWorkItem')}
        loadingFallback={loadingFallback}
        emptyRoot={emptyRoot}
        isFolderCrumb={isFolderCrumb}
        isTargetCrumb={isTargetCrumb}
        followTo={followTo}
        onFollowDeclined={onFollowDeclined}
        onLevelChange={onLevelChange}
        emptyDrilledFor={emptyDrilledFor}
      />
      {quickView}
    </>
  );
}
