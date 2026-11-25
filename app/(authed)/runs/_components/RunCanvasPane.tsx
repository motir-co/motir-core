'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  ProjectRoadmapCanvas,
  type RoadmapLevel,
} from '@/components/planning/ProjectRoadmapCanvas';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import type { RunLegBadge } from '@/components/planning/WorkItemNode';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import { fetchRoadmapLevel, type RoadmapLevelData } from '@/lib/planning/roadmapClient';
import { runLegLabel } from '@/lib/runs/legLabel';

// THE RUN'S SET, ON THE SHARED CANVAS (MOTIR-3895 · `design/runs/design-notes.md`
// § The run MODAL).
//
// ⚠️ THE ADAPTER IS THE REUSE, NOT THE COMPONENT — bug MOTIR-3152, written into
// `PlanReviewCanvas.tsx`'s own header and repeated here because this is the second
// surface to be tempted. Building the level by CASTING a `DispatchRunCardDto` into
// a `ProjectCanvasNode` type-checks (the cast is from `unknown`), renders, and
// produces nothing: the two shapes share no field name, so every node arrives with
// an undefined `content` that `renderNode` paints into a 0x0 box. *The card was not
// blank, it was INVISIBLE.* So the level goes through `fetchRoadmapLevel` +
// `buildWorkItemLevel` like every other consumer, and the run's own facts ride on
// the builder's `runLegs` option.
//
// NO NEXT-ACTION BUTTON (MOTIR-12233), deliberately — the card asks this canvas to
// say why. It is a read-only picture of ONE RUN's set inside the run modal: a
// click selects a work item so the log pane beside it follows. A hover button
// that copies `motir run` for a card the run is already working, or opens the
// planning overlay over the run modal, would act on the run from its own
// record. The member-facing canvases (`canvasNextActionsFor`) carry the button.

/** The synthetic parent every member of the run's level is given. */
const RUN_LEVEL_PARENT = '__run-level__';

export interface RunCanvasPaneProps {
  run: DispatchRunDto;
  projectKey: string;
  /** A node was selected — the right-hand region follows it (the log pane's input). */
  onSelectWorkItem: (workItemId: string | null) => void;
  /** Bumped by the modal when the run's dispositions have moved. */
  reloadKey: number;
  /**
   * The run's ONE shared member read (`useRunSetLevel`), so the List view and this
   * canvas do not each fetch the same set. Absent, the canvas reads for itself.
   */
  readSet?: () => Promise<RoadmapLevelData>;
}

export function RunCanvasPane({
  run,
  projectKey,
  onSelectWorkItem,
  reloadKey,
  readSet,
}: RunCanvasPaneProps) {
  const t = useTranslations('runs');

  /**
   * THE RUN'S MEMBERS, resolved to tone + label ONCE.
   *
   * The tone comes from `lib/runs/timeline.ts`'s `DISPOSITION_TONE`, which is
   * total over `DispatchCardDisposition` — so this defines no second tone
   * vocabulary and cannot fall out of step with the run header or the index. The
   * skip REASON is `SKIP_REASON_KEY`'s, whose seven members are the enum's (not
   * the six `batchPlan.ts`'s `SKIP_LABEL` carries), and a skip shown without its
   * reason says nothing. A MANUAL leg names who it waits on (MOTIR-7477) —
   * `skipReasonMessage` resolves it from the leg's gate, the same call the item
   * page's Run section makes.
   */
  const runLegs = useMemo(() => {
    const map = new Map<string, RunLegBadge>();
    for (const leg of run.cards) {
      if (leg.workItemId === null) continue;
      const { tone, label } = runLegLabel(t, leg);
      map.set(leg.workItemId, { tone, label });
    }
    return map;
  }, [run.cards, t]);

  /** The member ids, in the run's OWN stored order — never re-derived from the graph. */
  const memberIds = useMemo(
    () => run.cards.map((c) => c.workItemId).filter((id): id is string => id !== null),
    [run.cards],
  );

  /** The work item the run is WORKING right now, if any — the running edge's source. */
  const runningIds = useMemo(
    () =>
      new Set(
        run.cards
          .filter((c) => c.disposition === 'running' && c.workItemId !== null)
          .map((c) => c.workItemId as string),
      ),
    [run.cards],
  );

  const loadLevel = useCallback(
    async (parentId: string | null): Promise<RoadmapLevel> => {
      // A DRILL. Once a reader goes into a member's children they have left the
      // run's set, so this is the ORDINARY roadmap level — same read, same
      // builder, no run facts, because a child of a member is not itself a member.
      if (parentId !== null && parentId !== RUN_LEVEL_PARENT) {
        const wi = await fetchRoadmapLevel(projectKey, parentId, 'project');
        return buildWorkItemLevel(wi);
      }

      // THE RUN'S OWN LEVEL — ONE synthetic level, whatever shape the run took.
      // A scoped run's members are one container's children; `motir batch` and
      // `motir auto` take whatever was ready, across parents. The same `?ids=`
      // read serves all three, which is what makes this one code path.
      const wi = await (readSet?.() ??
        fetchRoadmapLevel(projectKey, null, 'project', undefined, false, memberIds));
      const level = buildWorkItemLevel(wi, { runLegs });

      // ⚠️ ONE SHARED SYNTHETIC PARENT, and it is load-bearing twice over.
      //
      // (1) `computeLevel` classifies an edge as `cross` when its two ends sit
      //     under DIFFERENT parents. On a batch run the members genuinely do —
      //     and `cross` would then WIN over the running variant and paint the
      //     one edge this surface exists to show as a bad-plan flag. On the run's
      //     level "different parents" is not a finding: the set is the level.
      // (2) It keeps every member VISIBLE at the top focus. `childrenOf` shows a
      //     node whose parent is not itself in the set, and this parent never is.
      //
      // `drillable` is unaffected — the canvas reads it off the NODE (which
      // `buildWorkItemLevel` set from `hasChildren`), not from the parent set.
      const nodes = level.nodes.map((n) => ({ ...n, parentId: RUN_LEVEL_PARENT }));

      // THE RUNNING EDGE. Only an edge FROM a work item an agent is working right
      // now TO one it BLOCKS flows — so a finished run reads as a still graph,
      // which is the whole signal. The geometry is the canvas's; this chooses the
      // variant and nothing else (MOTIR-3972 built the variant).
      const deps = level.deps.map((d) =>
        runningIds.has(d.from) ? { ...d, variant: 'running' as const } : d,
      );

      return { nodes, deps };
    },
    [projectKey, memberIds, runLegs, runningIds, readSet],
  );

  const handleSelect = useCallback((id: string) => onSelectWorkItem(id), [onSelectWorkItem]);

  return (
    <ProjectRoadmapCanvas
      loadLevel={loadLevel}
      reloadKey={reloadKey}
      onSelect={handleSelect}
      // ── The opt-in props, each a decision (`design-notes.md` § The run MODAL) ──
      // `searchable` ON: a batch run can hold forty members, and finding one by key
      //   is the reader's first question. The canvas owns `/`; the dialog owns ESC.
      //   ⚠️ `searchLabel` travels WITH it — the props are a discriminated union
      //   (`{ searchable: true; searchLabel: string }`), so the two cannot come
      //   apart. The canvas requires the consumer to supply the copy rather than
      //   defaulting it, for the reason MOTIR-4021 records one file over: the
      //   shipped default names a READY FRONTIER, which is a roadmap fact and not
      //   a run one. This surface searches a RUN's members, so it says so.
      searchable
      searchLabel={t('searchLabel')}
      // `locatable` OFF: it centres on the `here` / `ready` frontier, which are
      //   ROADMAP facts about the tree. On a run the equivalent question is "what is
      //   the agent working", and that is the flowing edge's job — two controls
      //   answering it differently is how they drift.
      // `fullScreenable` OFF, deliberately: this canvas is already inside a
      //   full-screen dialog, and the Fullscreen API would stack a second overlay
      //   with a second ESC handler on top of the dialog's. Two ESC handlers on one
      //   surface is exactly the collision the design flags.
    />
  );
}
