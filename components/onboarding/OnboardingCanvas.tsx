'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { useWorkItemQuickView } from '@/components/planning/useWorkItemQuickView';
import { TierDocModal } from '@/components/planning/TierDocModal';
import { PlanPreview } from '@/components/planning/PlanPreview';
import type { ProjectCanvasDep, ProjectCanvasNode } from '@/lib/planning/projectCanvasModel';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { Spinner } from '@/components/ui/Spinner';
import { IdeaCard, StationCard } from './StationNode';
import { useTierLabel } from './useTierLabel';
import { useCanvasLayout } from '@/lib/hooks/useCanvasLayout';
import { type DiscoveryState, shouldShowDesignStep } from '@/lib/onboarding/discoveryLoop';
import { type StationKind, type StationView, buildStations } from '@/lib/onboarding/canvasModel';
import { isDirectionDocKind, type DirectionDocKind } from '@/lib/onboarding/directionDoc';
import {
  CANVAS_NODE_KEYS,
  ROW_DESIGN_Y,
  STATION_EDGES,
  positionFor,
  type CanvasNodeKey,
} from '@/lib/onboarding/stationLayout';

// The onboarding canvas (Subtask 7.3.11 / MOTIR-840) — the LEFT pane of the hub,
// the pre-plan view of the project roadmap. It composes the reusable
// `ProjectRoadmapCanvas` FOUNDATION (7.20.2 / MOTIR-1194): the stations (idea →
// the four tiers → design / plan) are the TOP level beside the produced work-item
// roots; drilling a work item fetches its children ONE LEVEL AT A TIME from the
// per-level roadmap read (7.20.4 / MOTIR-1010). The 4 tier docs are part of the
// ONE project roadmap; build it once, every planning surface composes it.
//
// `loadLevel` is the consumer-owned per-level fetcher the foundation calls: the
// root level returns the stations (from the live discovery state) + the produced
// epics; a deeper level returns one parent's children. Work-item levels are cached
// per project so the stations refreshing (each chat turn) never re-hits the API.
//
// The canvas "View" affordance opens a DETAIL surface per node kind (MOTIR-1351):
// a PRODUCED tier station opens its doc in the tier-doc viewer (TierDocModal,
// MOTIR-1355); a drilled work-item node opens the shared quick-view peek
// (MOTIR-1352). Selecting a station only HIGHLIGHTS it — View opens the doc.
//
// NO NEXT-ACTION BUTTON (MOTIR-12233), deliberately. Every member-facing canvas of
// committed work items turns the card's hover button on (`canvasNextActionsFor`);
// this one does not, for two reasons. The hub IS a planning conversation — its
// right pane is the planner — so a Plan button on a drilled card would open a
// second planning workspace over the one the reader is in. And the hub renders
// in the `(onboarding)` route group, outside the authed shell that mounts the
// planning overlay a Plan click writes its address for, so the click would land
// nowhere. The copy rows (`motir run` / …) belong to a project being worked,
// which an onboarding project is not yet.

const ROOT_KEY = '__root__';
// The synthetic top-level node that stands in for the whole produced plan — a
// compact "Your plan" PREVIEW (MOTIR-1333) instead of every epic fanned out. It
// hangs off the `plan` station and drills into the real epic roots on activate.
const PLAN_NODE_ID = '__plan__';
// The preview sits in the DESIGN row (ROW_DESIGN_Y), to the RIGHT of the wrapped
// design → plan stations (which occupy x:40 and x:380), so it lands in the SAME
// fit-to-view as the stations (no scroll) and the bottom row reads design → plan →
// your plan. It shares the stations' row constant so it tracks the spacing fix
// (MOTIR-1364) — never a duplicated literal.
const ROOT_X0 = 760;
const ROOT_Y0 = ROW_DESIGN_Y;

export interface OnboardingCanvasProps {
  state: DiscoveryState;
  /** The seed idea (the idea node; omitted when absent — e.g. a resume). */
  idea: string | null;
  /** Open the web-only design step (MOTIR-1040) — the `design` station's action. */
  onOpenDesign: () => void;
  /** Advance the CURRENT "you are here" step (MOTIR-1372) — the Continue action on
   *  the active station card and in its quick-view modal. Wired to `continueTier`. */
  onContinueStep?: () => void;
  /** Open a tier's in-page review GATE (MOTIR-1372 / 1355) — "open full screen" for
   *  the CURRENT step lands here (the in-page gate with Back + Continue), not the
   *  new-tab read-only page. Wired to `openTier`. */
  onReviewStep?: (kind: DirectionDocKind) => void;
  /** The active project's key — the work-item tree is read per level from
   *  `/api/projects/[key]/roadmap?parentId=`. Omit (a pre-project state) and the
   *  canvas shows only the pre-plan stations. */
  projectKey?: string;
  /** The tier the conductor sent the user BACK to re-review (G3, MOTIR-1179). */
  revisitingKind?: DirectionDocKind | null;
  /** Downstream tiers re-deriving in the active cascade — "Will refresh". */
  willRefresh?: DirectionDocKind[];
}

export function OnboardingCanvas({
  state,
  idea,
  onOpenDesign,
  onContinueStep,
  onReviewStep,
  projectKey,
  revisitingKind = null,
  willRefresh = [],
}: OnboardingCanvasProps) {
  const t = useTranslations('onboarding.chat.canvas');
  const tierLabel = useTierLabel();
  const { positions, savePosition, resetPositions, loaded } = useCanvasLayout();

  // Work-item levels cached (a mutable ref, keyed by project+parent — a new key
  // just misses); the stations are rebuilt from state on every call, so they
  // always reflect the live loop.
  const cacheRef = useRef(new Map<string, RoadmapLevelData>());
  // The shared work-item quick-view peek (MOTIR-1352) — the same one the roadmap
  // uses. On the onboarding canvas it lights up once the user drills into the
  // produced tree (the stations / "Your plan" preview aren't `viewable`).
  const { registerItems, onView: onViewWorkItem, quickView } = useWorkItemQuickView();
  // The tier whose doc is open in the on-canvas viewer (MOTIR-1355), or null.
  const [viewTier, setViewTier] = useState<DirectionDocKind | null>(null);

  // The CURRENT "you are here" step (MOTIR-1372) — the active/deciding tier. Its
  // card + quick-view modal carry a Continue, and "open full screen" for it lands on
  // the in-page gate (Back + Continue), not the read-only new-tab page.
  const currentStep = buildStations(state).find(
    (s) => (s.state === 'active' || s.state === 'deciding') && isDirectionDocKind(s.kind),
  );
  const currentStepKind: DirectionDocKind | null =
    currentStep && isDirectionDocKind(currentStep.kind) ? currentStep.kind : null;

  // The canvas's single View handler, routed by node kind: a tier station opens
  // the tier-doc viewer; any other `viewable` node (a drilled work item) opens the
  // shared quick-view peek. (Work-item ids are never a tier kind, so this is safe.)
  const onView = useCallback(
    (id: string) => {
      if (isDirectionDocKind(id)) setViewTier(id);
      else onViewWorkItem(id);
    },
    [onViewWorkItem],
  );

  // A signature of the station-relevant state; bumping it refetches the current
  // level so the stations refresh as tiers complete / the cascade moves.
  const reloadKey = useMemo(
    () =>
      JSON.stringify({
        produced: state.producedKinds,
        active: state.activeKind,
        deciding: state.pendingAsk !== null,
        working: state.working?.tier ?? null,
        status: state.session.status,
        platform: state.session.platform,
        idea: !!(idea && idea.trim()),
        revisitingKind,
        willRefresh,
        loaded,
      }),
    [state, idea, revisitingKind, willRefresh, loaded],
  );

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      const r: LoadInputs = {
        state,
        idea,
        revisitingKind,
        willRefresh,
        onOpenDesign,
        onContinueStep,
        tierLabel,
      };

      // The work-item READ for this level: the roots (the produced epics) back the
      // top-level PREVIEW and the synthetic plan level; else a parent's children.
      const readParent = parentId === null || parentId === PLAN_NODE_ID ? null : parentId;
      let wi: RoadmapLevelData = { items: [], edges: [], offLevelBlockers: [] };
      if (projectKey) {
        const key = `${projectKey}:${readParent ?? ROOT_KEY}`;
        const cached = cacheRef.current.get(key);
        if (cached) wi = cached;
        else {
          wi = await fetchRoadmapLevel(projectKey, readParent);
          cacheRef.current.set(key, wi);
        }
      }
      // Record this level's work items so the canvas "View" button can open the
      // quick-view peek for a drilled work-item node.
      registerItems(wi);

      if (parentId !== null) {
        // The plan level (the epics) or a deeper work-item level — auto-laid out.
        return buildWorkItemLevel(wi);
      }

      // The ROOT level: the stations + (when the project has a tree) a compact
      // "Your plan" PREVIEW node — NOT the epics fanned out. It sits below the plan
      // station but is NOT wired to it: the work items are the user's own tree, not
      // something the planner station produced, so no edge points at it (the
      // plan→epic fan is the deferred onboarded-flag work, MOTIR-1013). Clicking it
      // drills into the full per-level tree (1333 design).
      const stationNodes = buildStationNodes(r);
      const stationDeps = buildStationDeps(r);
      const extra: ProjectCanvasNode[] = [];
      if (wi.items.length > 0) {
        extra.push({
          id: PLAN_NODE_ID,
          parentId: null,
          drillable: true,
          searchText: 'your plan',
          crumbLabel: 'Your plan',
          content: <PlanPreview epics={wi.items} />,
          x: ROOT_X0,
          y: ROOT_Y0,
          // The preview is far WIDER (44rem) + taller than a station card; hint its
          // real size so the once-only fit-to-view frames it instead of clipping it.
          width: 704,
          height: 240,
        });
      }
      return { nodes: [...stationNodes, ...extra], deps: stationDeps };
    },
    [
      projectKey,
      state,
      idea,
      revisitingKind,
      willRefresh,
      onOpenDesign,
      onContinueStep,
      registerItems,
      tierLabel,
    ],
  );

  const onActivate = useCallback(
    (id: string) => {
      // The design station opens the web-only design step — only once active (tiers
      // complete). A tier station's bare select only HIGHLIGHTS now (per the
      // 7.20.10 design — select highlights, the View button opens the doc viewer,
      // MOTIR-1355); a work-item leaf has no onboarding action yet.
      if (id === 'design') {
        const station = buildStations(state).find((s) => s.kind === id);
        if (station?.state === 'active') onOpenDesign();
      }
    },
    [state, onOpenDesign],
  );

  // Hold a loading state until the saved positions resolve (MOTIR-1253).
  if (!loaded) {
    return (
      <div
        aria-busy="true"
        className="flex h-full w-full items-center justify-center bg-(--el-surface-soft)"
      >
        <Spinner aria-label={t('loading')} />
      </div>
    );
  }

  return (
    <>
      <ProjectRoadmapCanvas
        loadLevel={loadLevel}
        reloadKey={reloadKey}
        positions={positions}
        onNodeMove={savePosition}
        onResetPositions={resetPositions}
        onSelect={onActivate}
        onView={onView}
        // The pair travels together (MOTIR-4021, Part XIII §5): this mount's
        // search is gated on having a project to search, and the canvas now
        // requires the label exactly when search is on. This canvas draws the
        // project tree being built, so its word is the project's.
        {...(projectKey
          ? { searchable: true as const, searchLabel: t('searchLabel') }
          : { searchable: false as const })}
        rootLabel={t('title')}
        ariaLabel={t('title')}
      />
      {quickView}
      <TierDocModal
        tier={viewTier}
        origin="onboarding"
        // The current "you are here" step's modal is ACTIONABLE (MOTIR-1372): it
        // carries Continue and its "open full page" lands on the in-page gate.
        isCurrentStep={viewTier !== null && viewTier === currentStepKind}
        onContinue={
          onContinueStep
            ? () => {
                setViewTier(null);
                onContinueStep();
              }
            : undefined
        }
        onOpenInPage={
          onReviewStep
            ? () => {
                const kind = viewTier;
                setViewTier(null);
                if (kind) onReviewStep(kind);
              }
            : undefined
        }
        onClose={() => setViewTier(null)}
      />
    </>
  );
}

type LoadInputs = {
  state: DiscoveryState;
  idea: string | null;
  revisitingKind: DirectionDocKind | null;
  willRefresh: DirectionDocKind[];
  onOpenDesign: () => void;
  onContinueStep?: () => void;
  /** The tier title in the reader's language (`useTierLabel`) — the crumb. */
  tierLabel: (kind: DirectionDocKind) => string;
};

/** The pre-plan station nodes (idea → tiers → design / plan), from the live state. */
function buildStationNodes(r: LoadInputs): ProjectCanvasNode[] {
  const stations = buildStations(r.state);
  const stationByKind = new Map<StationKind, StationView>(stations.map((s) => [s.kind, s]));
  const showIdea = !!(r.idea && r.idea.trim());
  const showDesign = shouldShowDesignStep(r.state.session.platform);
  const keys = CANVAS_NODE_KEYS.filter((k) =>
    k === 'idea' ? showIdea : k === 'design' ? showDesign : true,
  );
  const willRefreshSet = new Set<string>(r.willRefresh);

  return keys.map((key) => {
    let content: ProjectCanvasNode['content'] = null;
    const station = key === 'idea' ? undefined : stationByKind.get(key as StationKind);
    if (key === 'idea') {
      content = <IdeaCard idea={r.idea!.trim()} />;
    } else if (station) {
      content = (
        <StationCard
          station={station}
          doc={r.state.docs[key]}
          session={r.state.session}
          onOpenDesign={
            station.kind === 'design' && station.state === 'active' ? r.onOpenDesign : undefined
          }
          // The active "you are here" tier card carries a Continue (MOTIR-1372).
          onContinue={
            isDirectionDocKind(key) && station.state === 'active' ? r.onContinueStep : undefined
          }
          revisiting={r.revisitingKind === key}
          refreshing={willRefreshSet.has(key)}
        />
      );
    }
    // A PRODUCED direction-tier station gets a "View" affordance on the selected
    // card → opens its doc in the on-canvas tier-doc viewer (MOTIR-1355). Only the
    // four tier kinds are viewable; idea / design / plan stations are not.
    const viewable = isDirectionDocKind(key) && !!station?.openable;
    return {
      id: key,
      parentId: null,
      searchText: key,
      crumbLabel: isDirectionDocKind(key) ? r.tierLabel(key) : undefined,
      drillable: false,
      viewable,
      content,
      // The station's DEFAULT spot — a saved drag is applied by the canvas via its
      // `positions` prop, so the "Reset layout" button can revert a station to here.
      ...positionFor(key, {}),
    };
  });
}

/** The pre-plan dependency chain among the present stations. */
function buildStationDeps(r: LoadInputs): ProjectCanvasDep[] {
  const stations = buildStations(r.state);
  const stationByKind = new Map<StationKind, StationView>(stations.map((s) => [s.kind, s]));
  const showIdea = !!(r.idea && r.idea.trim());
  const showDesign = shouldShowDesignStep(r.state.session.platform);
  const present = new Set<CanvasNodeKey>(
    CANVAS_NODE_KEYS.filter((k) => (k === 'idea' ? showIdea : k === 'design' ? showDesign : true)),
  );

  const reached = (key: CanvasNodeKey) =>
    key === 'idea' || stationByKind.get(key as StationKind)?.state !== 'upcoming';
  const variantOf = (from: CanvasNodeKey, to: CanvasNodeKey): ProjectCanvasDep['variant'] =>
    reached(from) && reached(to) ? 'firm' : 'pending';

  // `flow` edges: the station serpentine is a journey sequence, NOT a blocked-by
  // dependency, so it must not raise the dependency legend.
  const deps: ProjectCanvasDep[] = STATION_EDGES.filter(
    ([from, to]) => present.has(from) && present.has(to),
  ).map(([from, to]) => ({ from, to, variant: variantOf(from, to), kind: 'flow' }));
  if (!showDesign && present.has('validation') && present.has('plan')) {
    deps.push({
      from: 'validation',
      to: 'plan',
      variant: variantOf('validation', 'plan'),
      kind: 'flow',
    });
  }
  return deps;
}
