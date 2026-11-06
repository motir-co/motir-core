'use client';

import type { CardNextActionsOption } from '@/components/planning/WorkItemNode';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { useWorkItemQuickView } from '@/components/planning/useWorkItemQuickView';
import {
  buildWorkItemLevel,
  folderIdFromNodeId,
  isNotInEpicRow,
  LEVEL_MORE_ID,
  NOT_IN_EPIC_ID,
  ORIGIN_ID,
} from '@/components/planning/workItemLevel';
import { buildPreplanStationLevel } from '@/components/planning/preplanStationLevel';
import { useTierLabel } from '@/components/onboarding/useTierLabel';
import { FolderEmptyLevel } from '@/components/planning/WorkItemNode';
import { TierDocModal } from '@/components/planning/TierDocModal';
import { isDirectionDocKind, type DirectionDocKind } from '@/lib/onboarding/directionDoc';
import { fetchPreplanState, producedTierKinds } from '@/lib/onboarding/preplanClient';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';
import {
  fetchRoadmapLevel,
  type RoadmapLevelData,
  type RoadmapScope,
} from '@/lib/planning/roadmapClient';
import type { CanvasCrumb } from '@/lib/planning/projectCanvasModel';

// The WORK-ITEM consumer of the reusable `ProjectRoadmapCanvas` (Subtask 7.20.2 /
// MOTIR-1194) — the adapter the persistent roadmap (MOTIR-1011) + the planning
// workspace (MOTIR-1193) mount. It reads the project roadmap ONE LEVEL AT A TIME
// from the per-level endpoint (MOTIR-1010) and renders each node as a
// `WorkItemNode`: the roots, then a node's children on drill, with the level's
// `blocked_by` edges drawn. The onboarding canvas is the OTHER consumer of the same
// foundation (stations + roots at the top level).
//
// THE FIRST LEVEL IS NOT ALWAYS THE PROJECT'S ROOTS (MOTIR-2287). `subtreeRootId`
// roots the canvas at ONE work item: the canvas's own root level becomes that item's
// children, so an embedded mount (the work-item detail page's Children panel) cannot
// walk the reader out of the item they are reading — Back at the first level stays
// inside the subtree. The remap lives here rather than in the shared canvas, which
// five surfaces mount. See the prop's doc comment for the two ROOT-level behaviours
// rooting turns off, and why this is not the `initialTrail` seed.
//
// It also OWNS the work-item quick-view peek (Subtask 7.20.11 / MOTIR-1352): the
// canvas surfaces a "View" button on the selected card, and this consumer opens the
// shipped peek (`WorkItemQuickView`) for that node — driven by LOCAL state, so the
// reusable canvas stays route-agnostic (no `?peek=` URL coupling).
//
// THE PLANNING PHASE CARD IS A DOOR (MOTIR-2205 / design
// `design/roadmap/planning-origin-drill.*`). The pinned planning-origin cluster is
// `drillable`, and this adapter serves what is behind it: `loadLevel` intercepts
// `ORIGIN_ID` and returns a SYNTHETIC level of pre-plan station cards built from the
// project's pre-plan read (`buildPreplanStationLevel`) — no `fetchRoadmapLevel` call,
// because no work item backs those nodes. A produced station is `viewable`, so the
// canvas's own View button surfaces on it, and `onView` routes a tier id to
// `TierDocModal` (`origin="roadmap"`) exactly as `OnboardingCanvas` already does.
// Neither hop is a new interaction: drill is the canvas's, View-opens-the-doc is
// onboarding's, on the same `StationCard`.
//
// ⚠️ THE PRE-PLAN READ NEVER BLOCKS THE FIRST PAINT (the MOTIR-2069 lesson). The
// STATION level's read happens on DRILL, inside the canvas's own per-level load,
// which already has a spinner. The only thing level 0 wants it for is the phase
// card's honest badge — so it is fired from an effect AFTER mount and folded into
// `reloadKey` when it lands: the card paints chip-less immediately and UPGRADES.
// A failed read leaves `produced` null (no chip) and the drilled level renders its
// four `upcoming` stations — never an error on `/roadmap`.

const ROOT_KEY = '__root__';

export interface WorkItemRoadmapProps {
  /** The project's `PROD`/`MOTIR` key — the per-level roadmap read source. */
  projectKey: string;
  /** Whole project (default) or the active-sprint slice (MOTIR-1382). Threaded
   *  into every per-level fetch as `&scope=sprint`. */
  scope?: RoadmapScope;
  /**
   * Pin the collapsed planning-origin cluster (MOTIR-1013) at the ROOT level —
   * gated by the caller on the project's immutable onboarding-ran marker
   * (Subtask 7.4 / MOTIR-1264). Only a project that actually onboarded shows it;
   * a never-onboarded project (existing tree, no materialized plan) omits it.
   * Defaults to false so a consumer that hasn't resolved the marker never asserts
   * a planning journey that didn't happen. Ignored in SPRINT scope — see the
   * `includeOrigin` note in `loadLevel`.
   */
  showPlanningOrigin?: boolean;
  /** The card's hover next-action button (MOTIR-10509; design MOTIR-10508): copy
   *  `motir run` / `review` / `fix`, or open planning on a To plan story. Absent or
   *  `null` draws no button — a Visitor's canvas, and every surface that is not the
   *  roadmap page. */
  nextActions?: CardNextActionsOption | null;
  positions?: Record<string, { x: number; y: number }>;
  onNodeMove?: (id: string, x: number, y: number) => void;
  onResetPositions?: (nodeIds: string[]) => void;
  /** A LEAF work item (no children) was activated. */
  onSelect?: (id: string) => void;
  ariaLabel?: string;
  /** A monotonic counter (MOTIR-1542): each increment is a MANUAL REFRESH — the
   *  consumer drops the level cache and bumps the canvas `reloadKey`, so the CURRENT
   *  level refetches IN PLACE (drill / breadcrumb / zoom / pan preserved), never a
   *  remount. Defaults to 0 (no refresh). */
  refreshSignal?: number;
  /** Called when a refresh-triggered refetch has SETTLED, so the caller can clear
   *  its loading affordance on the real fetch-completion signal (not a timer). */
  onRefreshSettled?: () => void;
  /**
   * ROOT THE CANVAS AT ONE WORK ITEM (MOTIR-2287) — the work-item id whose
   * CHILDREN become the canvas's own first level, instead of the project's roots.
   * Absent (the default) is the shipped behaviour: level 0 is `parentId: null`.
   *
   * The remap lives HERE, in the adapter, and not in `ProjectRoadmapCanvas` —
   * that foundation has five consumers and what its root level MEANS is not this
   * surface's to change. And it is a root, not the shipped `initialTrail` seed
   * (MOTIR-2070): a seeded trail opens ON a level but leaves the canvas's Back /
   * root-crumb pointing at the project root, which would walk the reader out of
   * the item they are reading. Rooting makes the item's children the canvas's own
   * root, so Back at the first level stays inside the subtree.
   *
   * Rooting also turns two ROOT-level behaviours OFF, because both are statements
   * about the PROJECT's road rather than this subtree's: the planning-origin
   * cluster (and its pre-plan read) is never pinned, whatever `showPlanningOrigin`
   * says, and the single-drillable-parent auto-descend (MOTIR-1807) is off — a
   * panel that says "this item's children" must show them even when there is
   * exactly one. Both verdicts are the design's (MOTIR-2285).
   */
  subtreeRootId?: string | null;
  /** The breadcrumb ROOT crumb's label. Defaults to the shipped project-scope
   *  copy; a rooted mount passes the item's own identifier, so Back reads as
   *  "back to MOTIR-1234" (MOTIR-2285's recorded verdict). */
  rootLabel?: string;
  /**
   * The canvas's three chrome opt-ins, surfaced so an EMBEDDED mount can make its
   * own call (MOTIR-2288). **All three default to `true`** — what the full-page
   * `/roadmap` mount has always passed — so every existing consumer is unchanged.
   * The Children panel turns `searchable` and `locatable` off (a `/` overlay
   * inside a page section is a page-level key grab, and a canvas already rooted at
   * the item the reader is on has nothing off-screen to locate) and keeps
   * `fullScreenable`, which is the bounded panel's only escape.
   */
  searchable?: boolean;
  /**
   * What the search box SEARCHES (MOTIR-4021, design Part XIII §5). Defaults to
   * the roadmap's own sentence, `roadmap.canvas.search` — which is correct here
   * and here only, because this consumer IS the roadmap. The foundation now
   * REQUIRES the label whenever search is on, so the default lives at the mount
   * that owns the word rather than inside the shared canvas.
   */
  searchLabel?: string;
  locatable?: boolean;
  fullScreenable?: boolean;
  /** Replace the ROOT level's empty state. Passed straight through to the canvas
   *  — an embedded mount whose section only renders when children EXIST has a
   *  different thing to say about an empty first level than "nothing here yet"
   *  (the read did not come back). Absent → the canvas's own copy. */
  emptyRoot?: ReactNode;
  /**
   * THE LEVEL SEAM (MOTIR-3835), threaded straight through to the canvas and
   * consumed by ONE mount: the full-page `/roadmap`, whose level is its URL
   * (MOTIR-3836). All three are absent by default, so the item page's rooted
   * Children-panel mount (MOTIR-2287) is untouched — a canvas rooted inside the
   * item you are already reading has no level worth addressing, and its host page
   * owns its own URL.
   */
  initialTrail?: readonly CanvasCrumb[];
  controlledTrail?: readonly CanvasCrumb[];
  onLevelChange?: (trail: readonly CanvasCrumb[]) => void;
}

export function WorkItemRoadmap({
  projectKey,
  scope = 'project',
  showPlanningOrigin = false,
  nextActions = null,
  positions,
  onNodeMove,
  onResetPositions,
  onSelect,
  ariaLabel,
  refreshSignal = 0,
  onRefreshSettled,
  subtreeRootId = null,
  rootLabel,
  searchable = true,
  searchLabel,
  locatable = true,
  fullScreenable = true,
  emptyRoot,
  initialTrail,
  controlledTrail,
  onLevelChange,
}: WorkItemRoadmapProps) {
  const t = useTranslations('roadmap.canvas');
  const tierLabel = useTierLabel();
  // Levels cached so re-drilling a node doesn't re-hit the API. Keyed by
  // project+parent (a ref — mutable — so a new key just misses; no reset needed).
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  // The shared work-item quick-view peek (MOTIR-1352) — the same one the onboarding
  // canvas uses; opened by the canvas "View" button.
  const { registerItems, onView: onViewWorkItem, quickView } = useWorkItemQuickView();

  // A MANUAL REFRESH (MOTIR-1542): the caller bumps `refreshSignal`, which folds into
  // the canvas `reloadKey` (below) so the canvas re-runs its load for the CURRENT
  // level. The cache invalidation + the completion signal both live INSIDE `loadLevel`
  // (a callback the canvas invokes), NOT in an effect: the canvas is a CHILD, so a
  // parent effect here would run AFTER the canvas had already re-read the stale cache.
  // `cacheGenRef` tracks the refresh generation the cache belongs to; `settledRef`
  // tracks the last generation whose load we reported settled.
  const cacheGenRef = useRef(refreshSignal);
  const settledRef = useRef(refreshSignal);

  // THE LEVELS THE READER ASKED TO SEE WHOLE (MOTIR-3490). The truncation tile
  // tells them a level is capped; activating it adds that level's cache key here
  // and drops its cached copy, so the next load re-reads with `all`. A ref, not
  // state: the canvas re-runs `loadLevel` off `reloadKey`, and the tick below is
  // what moves — keeping the set in state as well would give the same fact two
  // homes.
  const showAllRef = useRef(new Set<string>());
  const [showAllTick, setShowAllTick] = useState(0);

  // THE CACHE KEY OF THE LEVEL ON SCREEN (bug MOTIR-4501). The tile is emitted for
  // EVERY real level — `levelTotal` is passed for all of them, and the roadmap
  // design (`design/roadmap/design-notes.md` DECISION 7) says so in as many words —
  // but its activation used to name `rootCacheKey()` unconditionally. On the root
  // the two strings are identical, which is why it worked there and only there; on
  // a drilled level they differ, so the `all` flag was marked for a level the
  // reader was not standing on, the drilled level's cached copy survived the
  // eviction, and the reload that followed HIT that cache and issued no request at
  // all. Nothing errored: every miss in this component is absorbed by a `??` or a
  // cache hit.
  //
  // So the level NAMES ITSELF: `loadLevel` writes the key it just composed here,
  // and `handleSelect` marks and evicts THAT key. `ProjectRoadmapCanvas` holds one
  // load effect and calls `loadLevelRef.current(focusId)` from it, so the ref is
  // always the level whose tile is being activated. `null` on the two SYNTHETIC
  // branches (`ORIGIN_ID`, `NOT_IN_EPIC_ID`): neither passes `levelTotal`, so
  // neither can draw a tile, and a stale key must not be uncappable from a level
  // that has none.
  const levelKeyRef = useRef<string | null>(null);

  // The phase card only renders in the WHOLE-PROJECT scope (the sprint slice's road
  // did not start at onboarding), so neither the badge read nor the station level is
  // owed anywhere else — and never on a SUBTREE-rooted mount (MOTIR-2287), whose
  // first level is one item's children, not the project's road.
  const rooted = subtreeRootId != null;
  const originEnabled = showPlanningOrigin && scope !== 'sprint' && !rooted;
  // FOLDERS (Bug MOTIR-5710 · MOTIR-5741, design decisions 1, 6 and 8). This mount
  // opts into the folder treatment of the level read — the root leaves filed rows
  // out and draws the root folders, and a folder is its own level — in the WHOLE-
  // PROJECT scope only (sprint scope ignores placement, decision 6) and never on a
  // SUBTREE-rooted mount, whose first level is one item's children, which a folder
  // never is. Every other consumer of the shared read keeps the shipped one.
  const foldersOn = scope !== 'sprint' && !rooted;

  // ONE pre-plan read, shared by the badge and the drilled station level, held as a
  // PROMISE so a drill that lands while the badge's read is still in flight joins it
  // instead of firing a second request. Keyed by the refresh generation so a manual
  // refresh (MOTIR-1542) re-reads it exactly like the level cache.
  const preplanRef = useRef<{ gen: number; read: Promise<PreplanStateDTO | null> } | null>(null);
  const readPreplan = useCallback((): Promise<PreplanStateDTO | null> => {
    if (!preplanRef.current || preplanRef.current.gen !== refreshSignal) {
      // `fetchPreplanState` already resolves null on any non-OK response; the catch
      // covers a hard network failure and the `docs` guard a response that parsed but
      // is not a pre-plan state. All three land on `null` — the honest "we do not
      // know" — so neither the badge nor the level load can ever reject.
      preplanRef.current = {
        gen: refreshSignal,
        read: fetchPreplanState()
          .then((state) => (state && Array.isArray(state.docs) ? state : null))
          .catch(() => null),
      };
    }
    return preplanRef.current.read;
  }, [refreshSignal]);

  // The produced tiers behind the phase card's badge — `null` until the read lands
  // (and if it fails), which is exactly the chip-less state the card renders.
  const [produced, setProduced] = useState<DirectionDocKind[] | null>(null);
  useEffect(() => {
    if (!originEnabled) return;
    let alive = true;
    void readPreplan().then((state) => {
      if (alive) setProduced(state ? producedTierKinds(state) : null);
    });
    return () => {
      alive = false;
    };
  }, [originEnabled, readPreplan]);

  // The tier whose doc is open in the on-canvas viewer, or null. Work-item ids are
  // cuids and never a tier kind, so routing on the id is unambiguous — the same
  // discrimination `OnboardingCanvas` makes.
  const [viewTier, setViewTier] = useState<DirectionDocKind | null>(null);
  const handleView = useCallback(
    (id: string) => {
      if (isDirectionDocKind(id)) setViewTier(id);
      else onViewWorkItem(id);
    },
    [onViewWorkItem],
  );

  // The cache key of THIS mount's ROOT level — the one the grouped node's drill
  // reads back from. Kept as one helper so the key can never be spelled two ways.
  const rootCacheKey = useCallback(
    () => `${projectKey}:${scope}:${subtreeRootId ?? ROOT_KEY}:${subtreeRootId ?? ROOT_KEY}`,
    [projectKey, scope, subtreeRootId],
  );

  // THE ROOT LEVEL, READ RATHER THAN REMEMBERED (bug MOTIR-4426). The grouped
  // node's level is SERVED FROM the root read, and a cached value is not a source.
  // The manual refresh (MOTIR-1542) clears every cached level at the top of
  // `loadLevel`, three statements before the grouped branch reads one back — so a
  // reader standing INSIDE the group got `undefined`, and every `?? []` below it
  // turned that miss into a well-formed EMPTY level: `emptyDrilled` ("This node
  // has no children to show") over rows that exist, on the level they were
  // standing on, until they pressed Back.
  //
  // A MISS therefore RE-READS — which is exactly what the sibling synthetic door
  // three lines below already does: `ORIGIN_ID` serves `readPreplan()`, whose
  // promise is keyed on the refresh generation, so a refresh makes it re-read
  // instead of come back empty. The grouped door had copied that door's SHAPE
  // (intercept the id, serve it locally) without the half that survives a cache
  // generation change.
  //
  // A HIT is untouched, and that is what keeps MOTIR-3490's own guarantee true:
  // an ordinary drill inside one refresh generation still issues no request.
  const readRootLevel = useCallback(async (): Promise<RoadmapLevelData> => {
    const key = rootCacheKey();
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    // The same read the ROOT level's own load makes, `all` included — the key is
    // `rootCacheKey()` in both places, so the two can never disagree about which
    // level this is.
    const wi = await fetchRoadmapLevel(
      projectKey,
      subtreeRootId,
      scope,
      undefined,
      showAllRef.current.has(key),
      undefined,
      foldersOn ? { folders: true } : {},
    );
    cacheRef.current.set(key, wi);
    return wi;
  }, [projectKey, scope, subtreeRootId, rootCacheKey, foldersOn]);

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // A new refresh generation invalidates every cached level so this load hits the
      // API (the in-place refetch); a normal drill within a generation stays cached.
      if (refreshSignal !== cacheGenRef.current) {
        cacheGenRef.current = refreshSignal;
        cacheRef.current.clear();
      }
      try {
        // THE PHASE CARD'S LEVEL (MOTIR-2205) — synthetic, so it short-circuits the
        // work-item read entirely: no work item backs a pre-plan station, and
        // `fetchRoadmapLevel(ORIGIN_ID)` would ask the API for the children of an id
        // it has never heard of. The pre-plan read is awaited HERE, on the drill, not
        // ahead of the canvas.
        if (parentId === ORIGIN_ID) {
          // Synthetic: no cache key, so no level for the tile to uncap (MOTIR-4501).
          levelKeyRef.current = null;
          return buildPreplanStationLevel(await readPreplan(), tierLabel);
        }
        // THE GROUPED NODE'S LEVEL (MOTIR-3490) — synthetic, and served from the
        // ROOT level this canvas has ALREADY fetched: those rows came back in the
        // root read and grouping only decided where to draw them. So there is no
        // second request, no endpoint and no wire field — the same shape the
        // origin card's drill uses, for the same reason (no work item backs the
        // node, so asking the API for its children asks for the children of an id
        // it has never heard of).
        if (parentId === NOT_IN_EPIC_ID) {
          // Synthetic: no cache key of its own — it is SERVED FROM the root read
          // and passes no `levelTotal`, so no tile is drawn on it (MOTIR-4501).
          levelKeyRef.current = null;
          // `readRootLevel` (above) serves the cached root read, and RE-READS it
          // when there is none — the refresh case (bug MOTIR-4426). Registering
          // the rows is owed here for the same reason: the peek's id → identifier
          // map was filled by the root load, and the clear that lost the level
          // did not lose the map, but a re-read level whose rows were never
          // registered would leave View inert on this level alone.
          const root = await readRootLevel();
          registerItems(root);
          const rows = root.items.filter(isNotInEpicRow);
          // ⚠️ THE EDGES ARE SCOPED TO THE ROWS (bug MOTIR-3557). The root's
          // edge list is the edges of the WHOLE root level — the 18 root epics
          // included, wired to each other by the epic roadmap's own dependency
          // chain. Handing it over whole made every one of those epics an
          // off-level blocker of a level it has nothing to do with, and each
          // drew as an anonymous red ghost anchor, because an epic is ON the
          // root level and so is never in `offLevelBlockers` to be named from.
          // A level's edges are the ones whose BLOCKED end is one of its rows —
          // the same predicate `findBlockedByEdges` applies when the server
          // reads a real level, applied here because this level is synthetic.
          // `buildWorkItemLevel` now enforces this too; scoping at the source
          // means the builder is not asked to discard most of what it is given.
          const rowIds = new Set(rows.map((r) => r.id));
          return buildWorkItemLevel(
            {
              items: rows,
              edges: root.edges.filter((e) => rowIds.has(e.blockedId)),
              offLevelBlockers: root.offLevelBlockers,
            },
            { markActive: true, scope, nextActions },
          );
        }
        // A FOLDER'S LEVEL (Bug MOTIR-5710 · MOTIR-5741) — a real read, addressed by
        // the folder rather than a parent: its child folders, then the work items
        // filed directly in it. No grouped node (decision 2 — inside a folder the
        // folder is already the drawer) and no origin cluster (a folder is not the
        // project's road). Cached under its own key, so the refresh generation and
        // the truncation tile's `all` treat it exactly like any other level.
        const folderId = folderIdFromNodeId(parentId);
        if (folderId !== null) {
          const key = `${projectKey}:${scope}:${ROOT_KEY}:${parentId}`;
          levelKeyRef.current = key;
          let wi = cacheRef.current.get(key);
          if (!wi) {
            wi = await fetchRoadmapLevel(
              projectKey,
              null,
              scope,
              undefined,
              showAllRef.current.has(key),
              undefined,
              { folders: true, folderId },
            );
            cacheRef.current.set(key, wi);
          }
          registerItems(wi);
          return buildWorkItemLevel(wi, {
            markActive: true,
            scope,
            levelTotal: wi.levelTotal,
            nextActions,
          });
        }
        // THE SUBTREE ROOT (MOTIR-2287) — the canvas's own root level (`parentId`
        // null) resolves to the ROOTED item's children instead of the project's
        // roots. Every deeper drill already carries a real id and is untouched.
        const readParentId = parentId === null && rooted ? subtreeRootId : parentId;
        // Scope is part of the cache key so a project-scope level is never reused
        // for sprint scope (MOTIR-1382); the ROOT is part of it for the same reason,
        // so a rooted and an unrooted mount in one session cannot serve each other's
        // root level. The page also remounts this component on a scope change (its
        // React `key`), so the canvas re-loads the ROOT in the new scope; the scoped
        // key is the belt-and-suspenders guard.
        const key = `${projectKey}:${scope}:${subtreeRootId ?? ROOT_KEY}:${readParentId ?? ROOT_KEY}`;
        // The level the reader is now on OWNS this key — the tile's activation reads
        // it back (bug MOTIR-4501). Written before the await, so an activation can
        // never name the level this load replaced.
        levelKeyRef.current = key;
        let wi = cacheRef.current.get(key);
        if (!wi) {
          // `all` only for a level the reader explicitly asked to see whole
          // (MOTIR-3490) — every other level keeps the capped read it has always had.
          wi = await fetchRoadmapLevel(
            projectKey,
            readParentId,
            scope,
            undefined,
            showAllRef.current.has(key),
            undefined,
            // The ROOT asks for folders (decision 1); a parent's children never
            // include one, so every other level keeps the shipped URL.
            readParentId === null && foldersOn ? { folders: true } : {},
          );
          cacheRef.current.set(key, wi);
        }
        registerItems(wi);
        // The persistent roadmap marks the in-progress frontier "you are here" at
        // every level, and pins the collapsed planning-origin cluster at the ROOT
        // (the road's start) — Subtask 7.20.6 / MOTIR-1013 — but ONLY for a project
        // that actually onboarded (Subtask 7.4 / MOTIR-1264; `showPlanningOrigin`)
        // AND only in the WHOLE-PROJECT scope. The cluster says where the PROJECT's
        // tree came from ("Idea → Discover · Shape · Validate → Plan"); the sprint
        // slice (MOTIR-1382) is a window onto the sprint's committed work, whose
        // road did not start at onboarding — so pinning the project's origin there
        // is noise beside the sprint's own cards.
        // `scope` flips the off-level dependency signal from cross-story (project) to
        // the sprint-validity "not in sprint" signal (MOTIR-1379).
        const atRoot = parentId === null;
        return buildWorkItemLevel(wi, {
          markActive: true,
          includeOrigin: atRoot && originEnabled,
          scope,
          originCrumbLabel: t('origin.crumb'),
          originProduced: produced,
          // Grouping is a statement about the PROJECT's roots, so it is the root
          // level's alone — a drilled level's rows are somebody's children and
          // belong exactly where they are. A SUBTREE-rooted mount (MOTIR-2287) is
          // excluded for the same reason its origin cluster is: its first level is
          // one item's children, not the project's roots.
          groupNonEpicRoots: atRoot && !rooted,
          groupCrumbLabel: t('group.title'),
          levelTotal: wi.levelTotal,
          nextActions,
        });
      } finally {
        // A refresh-triggered load has completed → let the caller clear its loading
        // state on the authoritative fetch signal (`fetchRoadmapLevel` is best-effort,
        // so this always runs, even if the read degraded to an empty level). Guarded
        // per generation so only the refresh's own load settles it — an initial load
        // (generation 0) or a normal drill never fires it.
        if (refreshSignal !== settledRef.current) {
          settledRef.current = refreshSignal;
          onRefreshSettled?.();
        }
      }
    },
    [
      projectKey,
      scope,
      registerItems,
      originEnabled,
      refreshSignal,
      onRefreshSettled,
      readPreplan,
      produced,
      rooted,
      subtreeRootId,
      readRootLevel,
      foldersOn,
      nextActions,
      t,
      tierLabel,
    ],
  );

  const isFolderCrumb = useCallback(
    (crumb: CanvasCrumb) => folderIdFromNodeId(crumb.id) !== null,
    [],
  );

  // AN EMPTY FOLDER'S LEVEL (Bug MOTIR-5710 · MOTIR-5741, sheet 6): the folder's own
  // statement instead of the generic "no children". The crumb's label IS the
  // folder's name — `buildWorkItemLevel` stamps it when it draws the card.
  const emptyDrilledFor = useCallback(
    (focus: { id: string; label: string }) =>
      folderIdFromNodeId(focus.id) !== null ? <FolderEmptyLevel name={focus.label} /> : null,
    [],
  );

  // THE TRUNCATION TILE'S ACTIVATION (MOTIR-3490). The canvas reports an activated
  // node through `onSelect`; the tile is not a work item, so it is intercepted here
  // rather than passed on. Drop the level's cached copy, mark it `all`, and bump
  // the tick — which folds into `reloadKey` and re-runs the load for the level the
  // reader is standing on. Every other id falls through to the caller unchanged.
  const handleSelect = useCallback(
    (id: string) => {
      if (id !== LEVEL_MORE_ID) {
        onSelect?.(id);
        return;
      }
      // THE LEVEL THE READER IS STANDING ON, not the root (bug MOTIR-4501).
      // `loadLevel` recorded it; a null means the level on screen is synthetic and
      // draws no tile, so there is nothing this activation could have come from.
      const key = levelKeyRef.current;
      if (!key) return;
      showAllRef.current.add(key);
      cacheRef.current.delete(key);
      setShowAllTick((n) => n + 1);
    },
    [onSelect],
  );

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        // Fold the manual-refresh counter into the reload key so a refresh re-runs
        // the canvas's per-level load effect for the CURRENT level (MOTIR-1542), and
        // the resolved produced set (MOTIR-2205) so the phase card's badge UPGRADES
        // in place when the late read lands. That rebuild is served from the level
        // cache — it re-renders the card, it does not re-hit the roadmap API.
        reloadKey={`${scope}:${subtreeRootId ?? '-'}:${refreshSignal}:${showAllTick}:${produced ? produced.join(',') : '-'}`}
        positions={positions}
        onNodeMove={onNodeMove}
        onResetPositions={onResetPositions}
        onSelect={handleSelect}
        onView={handleView}
        // The searchable pair travels TOGETHER or not at all: the canvas's props
        // make `searchLabel` required exactly when `searchable` is true, and this
        // mount's `searchable` is a runtime boolean, so the pair is spread rather
        // than passed as two independent props.
        {...(searchable
          ? { searchable: true as const, searchLabel: searchLabel ?? t('search') }
          : { searchable: false as const })}
        fullScreenable={fullScreenable}
        locatable={locatable}
        emptyRoot={emptyRoot}
        emptyDrilledFor={emptyDrilledFor}
        // FOLDER CRUMBS (MOTIR-5742): a folder's level is a `folder:<id>` crumb,
        // drawn with the folder glyph and collapsed from the middle past three.
        isFolderCrumb={isFolderCrumb}
        // AUTO-DRILL (MOTIR-1807): a level that resolves to exactly ONE drillable node
        // offers no choice, so the canvas descends into it and the roadmap opens on the
        // WORK rather than on one card. Opted in for BOTH scopes, not sprint-only — the
        // sprint read (MOTIR-1381) creates the degenerate root most often, but a
        // single-epic project has the same shape in project scope, and the rung-1
        // precedent (VS Code's compact folders) compacts every single-child chain rather
        // than one special case. This adapter is the only opt-in: the other four
        // consumers of the shared canvas keep the `false` default. A SUBTREE-rooted
        // mount (MOTIR-2287) opts back OUT: a surface that says "this item's
        // children" must show them even when there is exactly one, because the
        // descent would then be showing something else's children entirely.
        autoDescendSingleParent={!rooted}
        // ARRIVE AT A READABLE SCALE (MOTIR-3837), on BOTH mounts. Unlike the
        // root-level behaviours a subtree-rooted mount turns off (MOTIR-2287), an
        // arrival scale makes no claim about the PROJECT's road — it is only about
        // whether a card can be read, which is as true inside a Children panel as
        // on the full-page roadmap.
        arriveAtReadableScale
        initialTrail={initialTrail}
        controlledTrail={controlledTrail}
        onLevelChange={onLevelChange}
        rootLabel={rootLabel ?? t('breadcrumbRoot')}
        ariaLabel={ariaLabel ?? t('ariaWorkItem')}
        warningLegend={
          scope === 'sprint'
            ? {
                label: t('legend.blockerNotInSprint'),
                meaning: t('legend.blockerNotInSprintMeaning'),
              }
            : undefined
        }
      />
      {quickView}
      {/* The tier-doc viewer a produced station's View opens (MOTIR-1355, shipped and
          untouched). `origin="roadmap"` because the user is already inside the app
          shell, so its head's "Open full page" lands on `/direction/[tier]` in-shell
          rather than a new tab. Read-only here: a materialized roadmap has no
          "current step" to continue, so no `isCurrentStep` / `onContinue`. */}
      <TierDocModal tier={viewTier} origin="roadmap" onClose={() => setViewTier(null)} />
    </>
  );
}
