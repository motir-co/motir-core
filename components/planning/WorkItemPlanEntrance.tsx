'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useOpenPlanningWorkspace } from '@/lib/hooks/useOpenPlanningWorkspace';
import { planEntranceFace } from '@/lib/planning/planEntranceVisibility';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// The PER-ITEM Plan / Re-plan entrance (Subtask MOTIR-910; design
// `design/work-items/plan-replan-entrance.mock.html` panels 1–4). The contextual
// door that sits ON a work item — the detail page header's right cluster and the
// quick-view / peek modal's header bar — opening the SHIPPED universal planning
// workspace scoped to that item.
//
// It is deliberately NOT a second `PlanWithAILauncher`: the launcher is the
// GLOBAL hero pill in `TopNav` ("plan something"), while this is a quiet,
// per-item affordance sitting among the item's own controls. Both resolve their
// href through the same `useOpenPlanningWorkspace`, so there is exactly one
// entry path into the workspace and one place that decides the mode.
//
// ⚠️ IT OPENS AN OVERLAY IN PLACE NOW (MOTIR-4730), which changes what the peek
// does. See `onActivate` below: the quick view used to close as this pill was
// clicked, because the workspace was a ROUTE and the peek was about to be
// unmounted anyway. The design settled the dialog-over-dialog case the other
// way — the workspace opens ABOVE the peek and `?peek=` stays in the address, so
// closing the workspace returns the reader to the open quick view they launched
// from, which is the literal reading of "back to exactly where you were".
//
// TWO FACES (design "Modes"), and WHICH one it wears is decided by the shared
// Plan / Re-plan rule (`planEntranceFace`, MOTIR-2097) — for a CONTAINER by
// whether it has children, for a LEAF by whether it has a description:
//   * Plan    — nothing to re-plan yet. Accent-outlined pill; the workspace
//               opens and the AI starts from the item's own description. No
//               opening reason.
//   * Re-plan — there IS an existing plan (a container's children, a leaf's
//               description). Subdued pill (it is an EDIT of existing work); the
//               workspace opens with the composer asking what's wrong, and the
//               user's first chat turn IS the reason (MOTIR-908 classifies the
//               intent from it — there is no reason param).
//
// Colour flows through `--el-*` and shape through the element-semantic tokens, so
// the pill re-skins with `data-palette` and re-shapes with `data-style`. It is a
// real `<Link>`: keyboard-reachable, middle/⌘-clickable, and (from the peek)
// `onActivate` hands off by closing the modal first.
//
// BOTH decisions — whether it renders and which face it wears — are made HERE
// from the item state its host hands it, by the shared rule (`planEntranceFace`,
// MOTIR-2084 + MOTIR-2097). The component applies the rule itself, so it travels
// with the component instead of being re-derived — and re-missed — at each call
// site. The state props are REQUIRED for exactly that reason: a new host cannot
// mount the door without stating the item's plannability.

// ── THE PER-SURFACE DOORS THIS ONE REPLACED, and why (the breadcrumb) ──────
// This note lived in `PlanEditsLauncher.tsx` until MOTIR-4258 deleted that file;
// it moved HERE because this is the surviving door, and so the place a person
// asking "why is there only one?" actually arrives.
//
//   * The one-shot `AugmentPromptButton` — a toolbar `Button` → `Modal` with a
//     single `Input` → `POST /api/ai/augment` — was RETIRED by MOTIR-1731.
//     Changing a plan is a CONVERSATION, so the entrance is the universal
//     Plan-with-AI workspace (the global `TopNav` pill / ⌘K / the floating orb),
//     never a per-surface button with no way to refine. See
//     `design/ai-chat/design-notes.md` ("the retired 'Augment from prompt'
//     door", MOTIR-1727) panel 5.
//   * The `/items` row ⋯ menu's `Expand` / `Re-plan` rows — which opened the
//     IN-PLACE plan-edits dock rather than the workspace — went the same way in
//     MOTIR-4258, when the row's ⋯ was removed. They were the last per-surface
//     plan control, and the fact that they read THIS file's rule while opening a
//     different flow is what MOTIR-2097 had already been filed about.
//
// The JOB PATHS were left for a separate decision, and MOTIR-4261 made it.
// `/api/ai/augment` is driven by the conversation and `POST /api/ai/expand` by
// `/ready`'s expansion nudge (which polls its plan rather than streaming). The
// in-place dock's own chain — its job hook, the review dock, the replan route and
// its stream, and the expand stream only the dock read — had no caller left, and
// was RETIRED rather than re-homed: re-homing it would
// have put a second plan door beside this one, which is the drift MOTIR-2097
// was filed to stop. Re-planning an item is THIS door → the workspace.

export interface WorkItemPlanEntranceProps {
  /** The item's human identifier (e.g. `MOTIR-42`) — the workspace's anchor. */
  itemKey: string;
  /** Does the item have children? The CONTAINER face (rule 3). */
  hasChildren: boolean;
  /**
   * The item's kind — decides whether the face comes from the children
   * (container) or the description (leaf). Required — see `planEntranceFace`.
   */
  kind: WorkItemKindDto;
  /** Does the item have a non-empty description? The LEAF face (rule 2). */
  hasDescription: boolean;
  /**
   * May this actor open the planning workspace on the item (the project's
   * `canEdit`)? Required — see `planEntranceFace`.
   */
  canPlan: boolean;
  /** Is the item archived (`archivedAt != null`)? Required — see `planEntranceFace`. */
  archived: boolean;
  /**
   * The item's status CATEGORY (not its status key) — a `done`-category item is
   * finished work the engine refuses to re-plan. Required — see
   * `planEntranceFace`.
   */
  statusCategory: StatusCategoryDto | null;
  /**
   * Fired just before the workspace opens.
   *
   * ⚠️ NO LONGER THE QUICK VIEW'S CLOSE (MOTIR-4730). It used to be exactly
   * that — *"clicking it closes the modal — a handoff to the planning surface"*
   * — and it was right while the workspace was a ROUTE that unmounted the peek
   * regardless. The workspace is an overlay now and the design decided the
   * dialog-over-dialog case: it opens ABOVE the peek and `?peek=` is KEPT, so
   * dismissing the peek here would be a second, silent close the reader did not
   * ask for, and it would make this one door behave unlike the other six.
   *
   * The prop stays for a host that genuinely has something to do at the moment
   * of opening (a menu that must collapse, a palette that must close so focus
   * return lands on its trigger). Nothing passes it today.
   */
  onActivate?: () => void;
  className?: string;
}

export function WorkItemPlanEntrance({
  itemKey,
  hasChildren,
  kind,
  hasDescription,
  canPlan,
  archived,
  statusCategory,
  onActivate,
  className,
}: WorkItemPlanEntranceProps) {
  const t = useTranslations('aiPlanning.entrance');
  // After the hook (rules of hooks), before anything else: a door onto work the
  // actor may not plan, or that the engine will not re-plan, is simply not drawn.
  const face = planEntranceFace({
    canPlan,
    archived,
    statusCategory,
    kind,
    hasChildren,
    hasDescription,
  });
  const isReplan = face === 'replan';
  // ⚠️ BEFORE the early return, because it is a HOOK. `planEntranceFace` is a
  // pure function, so it can run first and decide `hasPlan` — but the hook that
  // reads it may not sit behind a conditional return.
  const { href, open } = useOpenPlanningWorkspace({
    kind: 'work-item',
    itemKey,
    hasPlan: isReplan,
    // ASK BEFORE STARTING (MOTIR-10624; design MOTIR-10623): this button is also
    // how people open the planner to ASK about a card, so it opens on a question
    // with one Start button rather than sending, or waiting for typing.
    confirmStart: true,
  });
  if (face === null) return null;

  const label = isReplan ? t('replan') : t('plan');
  // The accessible name NAMES THE ITEM, so the door is unambiguous when several
  // planning affordances share a screen (the global "Plan with AI" pill is
  // always in the nav). The visible text is contained in it (WCAG 2.5.3).
  const ariaLabel = isReplan
    ? t('replanAria', { item: itemKey })
    : t('planAria', { item: itemKey });

  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      data-testid="work-item-plan-entrance"
      // A hero ACTION on the badge radius, not a status chip (MOTIR-3522) —
      // the radius is shared with 9 filter/tag chips that §4 keeps flat, so the
      // plane is declared rather than inferred.
      data-depth="key"
      data-mode={face}
      onClick={(event) => {
        onActivate?.();
        open(event);
      }}
      className={cn(
        'inline-flex h-(--height-btn-sm) shrink-0 items-center gap-1.5 rounded-(--radius-badge) border px-(--spacing-btn-x-sm)',
        'font-sans text-xs font-semibold whitespace-nowrap transition-colors',
        'focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        isReplan
          ? // Re-plan — subdued: it edits work that already exists.
            'border-(--el-border-strong) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
          : // Plan — accent-outlined on a transparent fill (accent AS text, so
            // `--el-accent-on-surface`, never the accent FILL token).
            'border-(--el-accent) text-(--el-accent-on-surface) hover:bg-(--el-tint-lavender)',
        className,
      )}
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      {label}
    </Link>
  );
}
