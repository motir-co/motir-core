'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Target } from 'lucide-react';
import { NODE_H, NODE_W } from '@/lib/planning/projectCanvasModel';
import type { RoadmapLevel } from '@/components/planning/ProjectRoadmapCanvas';

// The TARGET chrome a canvas node takes while the planning chat is anchored at it
// (Subtask MOTIR-1491; design `target-picker.mock.html` panels 3 + 5 — the
// `.node.active` accent ring + glow and the "Target" pill). It answers the
// question the chat alone can't: WHICH part of the plan is the planner acting on.
//
// ⚠️ It WRAPS the shipped node — the compose-don't-redraw seam (`notes.html`
// #82 / #95). The work item keeps rendering as the real `WorkItemNode` (kind
// tile, status pill, progress meter); this adds a ring, a glow and a word on top.
// It is drawn by `PlanReviewCanvas` in its "no plan" state (`prePlan`, bug
// MOTIR-11513); once a plan is shown the target's own status pill says it is
// being planned, and the ring leaves (MOTIR-6186 · MOTIR-6299).
//
// NOT COLOUR ALONE: the ring is paired with a "Target" pill whose label is real
// text, so the state is legible and reaches a screen reader.

// Palette-DERIVED glow (never a raw hue — CLAUDE.md): the accent's own soft halo
// plus the brand highlight's outer bloom, both mixed from tokens, so a palette
// swap re-tints the glow instead of stranding it.
const TARGET_GLOW =
  '0 0 14px color-mix(in srgb, var(--el-accent) 24%, transparent), 0 0 28px -4px color-mix(in srgb, var(--el-highlight) 30%, transparent)';

export function PlanningTargetFrame({ children }: { children: ReactNode }) {
  const t = useTranslations('planningWorkspace.targets');

  return (
    <div
      // The canvas positions a fixed NODE_W×NODE_H box; the frame must not change
      // that footprint or the deterministic row spacing breaks.
      style={{ width: NODE_W, height: NODE_H }}
      className="relative"
      data-testid="planning-target-node"
    >
      {children}

      <span
        aria-hidden="true"
        style={{ boxShadow: TARGET_GLOW }}
        className="pointer-events-none absolute -inset-0.5 rounded-(--radius-card) border-2 border-(--el-accent)"
      />

      <span className="absolute -top-2 right-0 inline-flex items-center gap-1 rounded-(--radius-badge) bg-(--el-accent) px-(--spacing-chip-x) py-px font-mono text-[10px] font-bold tracking-wide text-(--el-accent-text) uppercase">
        <Target className="size-3" aria-hidden="true" />
        {t('nodePill')}
      </span>
    </div>
  );
}

/**
 * Mark the planning TARGETS on one already-built canvas level.
 *
 * Pure, and applied LAST — after the plan-change diff decoration — so the target
 * ring sits outside the diff frame rather than replacing it.
 *
 * Only targets that are ON this level are marked: the canvas is a dependency
 * graph, and the design is explicit that it stays scoped to the primary target's
 * neighbourhood rather than dragging unrelated items from other parents onto one
 * viewport (the full set is always readable as chips in the chat). A target the
 * user has not drilled to is therefore simply not drawn — not silently relocated.
 */
export function decorateTargetLevel(
  base: RoadmapLevel,
  targetIds: readonly string[],
): RoadmapLevel {
  if (targetIds.length === 0) return base;
  const targets = new Set(targetIds);

  return {
    deps: base.deps,
    nodes: base.nodes.map((node) =>
      targets.has(node.id)
        ? {
            ...node,
            // Joins the search text so the canvas's own search-to-locate finds
            // the target by the word, not only by eye.
            searchText: `${node.searchText} target`,
            content: <PlanningTargetFrame>{node.content}</PlanningTargetFrame>,
          }
        : node,
    ),
  };
}
