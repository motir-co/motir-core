import type { WorkflowStatusDto } from '@/lib/dto/workflows';

// The swap-layer colour for a workflow status dot/glyph (MOTIR-1273 · 1266.2).
//
// Single source of truth for the status-dot hue, replacing the four duplicated
// inline `STATUS_CATEGORY_EL` maps (StatusPicker, IssueFilterBar,
// AdvancedFilterValueEditor, AutomationParts) that mapped only by lifecycle
// CATEGORY — so `in_review` was indistinguishable from `in_progress`, and
// `blocked` / `cancelled` inherited the wrong category hue.
//
// Resolution order:
//   1. a per-status hex `color` override (custom workflow status) wins verbatim;
//   2. else the default-workflow status KEY → its dedicated `--el-status-*` token
//      (un-collapses in_review / blocked / cancelled);
//   3. else the lifecycle CATEGORY → the matching `--el-status-*` token (a custom
//      status with a non-default key still gets its category's hue);
//   4. else `--el-status-todo` (the neutral fallback).
//
// Returns a CSS value ready for `style={{ backgroundColor }}`/`color`: either the
// raw hex override or a `var(--el-status-*)` reference (full strength — the dot
// uses the hue at full strength per design/design-system/design-notes.md §A).

const STATUS_KEY_EL: Record<string, string> = {
  todo: '--el-status-todo',
  blocked: '--el-status-blocked',
  in_progress: '--el-status-in-progress',
  // A card being RE-PLANNED (MOTIR-2425). It sits in the in-progress category,
  // so without its own key entry it would fall through to that category's hue
  // and render identically to `in_progress` — the exact collapse MOTIR-1273
  // un-did for `in_review`, reintroduced by adding a status.
  planning: '--el-status-planning',
  // BUILT, waiting on checks (MOTIR-3003). Same reasoning as `planning` directly
  // above: it sits in the in-progress category, so without its own key entry it
  // would fall through to that category's hue and render identically to
  // `in_progress` — the exact collapse MOTIR-1273 un-did for `in_review`.
  implemented: '--el-status-implemented',
  in_review: '--el-status-in-review',
  // A person's YES (MOTIR-5139). Same reasoning as `planning` and `implemented`
  // above, a third time: it sits in the in-progress category, so without its own
  // key entry the option dot would be `--el-status-in-progress` and Approved
  // would be indistinguishable from In Progress and In Review **in the one
  // control a person uses to SET the status**. Drawn, and visible, in
  // design/boards/approved-column.mock.html panel 4.
  approved: '--el-status-approved',
  // STOPPED FOR RE-PLANNING — the fourth in-progress-category status with its
  // own key entry, for the reason the three above give: without it To plan's
  // option dot in the status picker would wear In Progress's hue. Drawn in
  // design/boards/board--to-plan-status.mock.html panel 3.
  to_plan: '--el-status-to-plan',
  done: '--el-status-done',
  cancelled: '--el-status-cancelled',
};

const STATUS_CATEGORY_EL: Record<string, string> = {
  todo: '--el-status-todo',
  in_progress: '--el-status-in-progress',
  done: '--el-status-done',
};

/** The `--el-status-*` CSS variable NAME for a status (no `var()` wrapper). */
export function statusElVar(status: Pick<WorkflowStatusDto, 'key' | 'category'>): string {
  return STATUS_KEY_EL[status.key] ?? STATUS_CATEGORY_EL[status.category] ?? '--el-status-todo';
}

/** The resolved dot/glyph colour for a status — a hex override or a `var(--el-status-*)`. */
export function statusDotColor(
  status: Pick<WorkflowStatusDto, 'key' | 'category' | 'color'>,
): string {
  return status.color ?? `var(${statusElVar(status)})`;
}
