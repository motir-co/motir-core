import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../utils/cn';

/**
 * Pill — compact status or severity label. Pure span, no interaction.
 *
 * Variant axes (use exactly one):
 *  - `status`: planned | in-progress | implemented | done — Motir's Subtask
 *    lifecycle states. The first three are per-CATEGORY tones; `implemented` is
 *    the one PER-STATUS tone (MOTIR-3103), because it shares a category with
 *    In Progress / Planning / In Review and must not share their chip.
 *  - `severity`: info | success | warning | danger — semantic UI states.
 *  - `priority`: highest | high | medium | low | lowest — work-item priority, a
 *    5-step diverging ramp (`--el-priority-*` hue tinted over the surface, plus a
 *    redundant direction icon). The single source of truth is `PRIORITY_META`.
 *  - `memberRole`: admin | member | viewer | custom — a project membership role
 *    (Story 6.4), one hued tint per role. (Named `memberRole`, not `role`, so
 *    it can't collide with the DOM `role` ARIA attribute on the span.)
 *  - `orgRole`: owner | admin | member — an ORGANIZATION role (Story 6.10),
 *    sitting above the workspace `memberRole`. owner → lavender (the highest,
 *    brand-purple tier), admin → sky, member → mint — per the org-admin design.
 *  - `tone`: neutral — a non-semantic chip (counts, metadata). Dark text on a
 *    neutral surface. `private` — the epic-level-privacy "Not public" badge
 *    (Story 6.14 · design epic-privacy panels 1/2/6b): lavender tint + charcoal
 *    text, the same AA-safe recipe as `status="planned"` / `memberRole="admin"`.
 *
 * All tones use adaptive dark/light text (`--color-charcoal`) on a hued tint,
 * so every variant clears WCAG AA contrast in both light and dark modes
 * (the hue lives in the background, not the text — PRODECT_FINDINGS #35).
 *
 * Always uses `--radius-badge` for fully rounded ends regardless of display style.
 *
 * @example
 * <Pill status="in-progress">In progress</Pill>
 * <Pill severity="danger">Validation failed</Pill>
 * <Pill tone="neutral">3 members</Pill>
 */
const pillVariants = cva(
  cn(
    'inline-flex items-center gap-1',
    'rounded-(--radius-badge)',
    'px-(--spacing-chip-x) py-(--spacing-chip-y)',
    'font-sans text-xs font-medium',
    'border',
  ),
  {
    variants: {
      // All colored tones carry the semantic hue in the TINT BACKGROUND and use
      // adaptive dark/light TEXT (`--color-charcoal`: #37352f light, #e5e5e5
      // dark) — the same pattern `planned` always used. The previous saturated
      // hue-on-tint TEXT failed WCAG AA (≈2.5–3.8:1 light, 3.2–4.0:1 dark);
      // charcoal-on-tint clears ~10:1 in both modes (PRODECT_FINDINGS #35).
      status: {
        planned: 'bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent',
        'in-progress': 'bg-(--el-tint-sky) text-(--el-text-strong) border-transparent',
        // BUILT, waiting on checks (MOTIR-3103). The first PER-STATUS tone on
        // this axis — the other three are per-CATEGORY, and `implemented` sits in
        // the same `in_progress` category as In Progress, Planning and In Review,
        // so without its own tone four statuses render one chip.
        //
        // It uses the recipe theme.css's own `--el-status-*` header prescribes —
        // "a status CHIP bg = color-mix(var(--el-status-X) 14%, var(--el-surface))
        // with --el-text-strong" — which is the same dilution the `priority`
        // variant below already renders. The hue is not spent by any other
        // status in any palette (measured at ΔE2000 >= 10 across all ten by
        // tests/theme/statusHueSeparation.test.ts), and the chip additionally
        // carries a GLYPH, because a 14% tint is a subtle mark by construction
        // and finding #35 forbids resting a state on colour alone.
        implemented:
          'bg-[color-mix(in_srgb,var(--el-status-implemented)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        // A person's YES, and not yet shipped (MOTIR-5141). The SECOND
        // per-status tone, on the same documented recipe `implemented` uses
        // rather than a second one — `--el-status-approved` is the `done` green
        // one ink step deeper, measured at ΔE2000 >= 10 against every other
        // status hue in all ten palettes. Like `implemented` it carries a GLYPH
        // (`CircleCheck`, in `StatusPill`), because a 14% tint is a subtle mark
        // and finding #35 forbids resting a state on colour alone — and here it
        // does more work than usual: at 14% the whole ramp compresses, and this
        // chip's nearest neighbour is `done`'s.
        approved:
          'bg-[color-mix(in_srgb,var(--el-status-approved)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        // STOPPED FOR RE-PLANNING. The THIRD per-status tone, on the same
        // recipe: `to_plan` sits in the `in_progress` category, so without its
        // own tone it would wear In Progress's sky chip and read as work being
        // done. At 14% the ramp compresses (its nearest chip, Blocked's, sits
        // closer than the shipped Implemented/Approved control pair), so the
        // `CirclePause` glyph `StatusPill` gives it is load-bearing, as
        // finding #35 asks. design/boards/design-notes.md § "To plan".
        'to-plan':
          'bg-[color-mix(in_srgb,var(--el-status-to-plan)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        done: 'bg-(--el-tint-mint) text-(--el-text-strong) border-transparent',
      },
      severity: {
        info: 'bg-(--el-tint-sky) text-(--el-text-strong) border-transparent',
        success: 'bg-(--el-tint-mint) text-(--el-text-strong) border-transparent',
        warning: 'bg-(--el-tint-peach) text-(--el-text-strong) border-transparent',
        danger: 'bg-(--el-tint-rose) text-(--el-text-strong) border-transparent',
      },
      // Priority chips (MOTIR-1273 · 1266.2) — a 5-step diverging ramp keyed off
      // the `--el-priority-*` hues, un-collapsing `medium` and `lowest` (both
      // were `tone="neutral"` grey). Each hue is diluted to a 14% tint over
      // `--el-surface` so charcoal `--el-text-strong` clears AA in both themes
      // (the hue lives in the background — finding #35); the redundant direction
      // icon (PRIORITY_META) is the non-colour cue. `medium` (slate) and
      // `lowest` (stone) resolve to two distinct greys in every palette.
      priority: {
        highest:
          'bg-[color-mix(in_srgb,var(--el-priority-highest)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        high: 'bg-[color-mix(in_srgb,var(--el-priority-high)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        medium:
          'bg-[color-mix(in_srgb,var(--el-priority-medium)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        low: 'bg-[color-mix(in_srgb,var(--el-priority-low)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
        lowest:
          'bg-[color-mix(in_srgb,var(--el-priority-lowest)_14%,var(--el-surface))] text-(--el-text-strong) border-transparent',
      },
      // Project membership roles (Story 6.4 · design/projects access-members):
      // admin → lavender, member → sky, viewer → mint — the hue in the tint,
      // charcoal text (AA-safe, finding #35), same recipe as `status`. Routed
      // through the DEDICATED `--el-role-*` tokens (MOTIR-1274 · 1266.3) so a
      // palette can tune roles apart from the other --el-tint-* meanings; each
      // defaults to its prior tint (zero visual change).
      // `custom` (MOTIR-2257 · MOTIR-2485) is a project's OWN role, which has no
      // enum value — it takes the next free tint slot (peach) because this
      // surface had already spent lavender / sky / mint on the built-ins, so a
      // custom chip in any of those would read as one of them. The KIND is
      // carried in WORDS by the chip's accessible name; nothing rests on the hue.
      memberRole: {
        admin: 'bg-(--el-role-admin) text-(--el-text-strong) border-transparent',
        member: 'bg-(--el-role-member) text-(--el-text-strong) border-transparent',
        viewer: 'bg-(--el-role-viewer) text-(--el-text-strong) border-transparent',
        custom: 'bg-(--el-role-custom) text-(--el-text-strong) border-transparent',
      },
      // Organization roles (Story 6.10 · design/org-admin): owner → lavender
      // (the highest, brand-purple tier), admin → sky, member → mint — the hue
      // in the tint, charcoal text (AA-safe, finding #35), same recipe as above.
      // Dedicated `--el-org-role-*` tokens (MOTIR-1274 · 1266.3); zero change.
      orgRole: {
        owner: 'bg-(--el-org-role-owner) text-(--el-text-strong) border-transparent',
        admin: 'bg-(--el-org-role-admin) text-(--el-text-strong) border-transparent',
        member: 'bg-(--el-org-role-member) text-(--el-text-strong) border-transparent',
      },
      tone: {
        neutral: 'bg-(--el-chip-bg) text-(--el-text-secondary) border-(--el-chip-border)',
        // Epic-level privacy "Not public" badge (Story 6.14 · design
        // epic-privacy panels 1/2/6b) — lavender tint, charcoal text, the same
        // AA-safe recipe as `status="planned"` / `memberRole="admin"` (≈9.7:1).
        // Dedicated `--el-privacy-private` token (MOTIR-1274 · 1266.3); the
        // matching `--el-privacy-public` is defined ahead of a "public" badge.
        private: 'bg-(--el-privacy-private) text-(--el-text-strong) border-transparent',
        // Inactive "Archived" badge (MOTIR-1276 · 1266.5) — a QUIET muted fill
        // with slate ink, not a hued tint: archived is an inactive state, not a
        // severity. Dedicated `--el-archived-pill-*` tokens so a palette can tune
        // the inactive badge apart from the neutral chip; AA-safe (slate on muted
        // clears AA both themes).
        archived: 'bg-(--el-archived-pill-bg) text-(--el-archived-pill-text) border-transparent',
        // A decision is WAITING on somebody (Story MOTIR-4778 · MOTIR-4792,
        // design `design/work-items/approval-control.mock.html` — the approval
        // frame's `pill-await`). Yellow, and the tint is chosen for DISTINCTNESS
        // rather than for mood: the frame renders four chips a reader must tell
        // apart at a glance — awaiting, recording (`severity="info"`, sky),
        // approved (`severity="success"`, mint) and changes-requested
        // (`severity="warning"`, peach) — and `--el-tint-yellow` was the only
        // slot none of the other three had spent. `tone` rather than `severity`
        // because waiting is not a severity; it sits beside `private` and
        // `archived`, which are states rather than judgements.
        awaiting: 'bg-(--el-tint-yellow) text-(--el-text-strong) border-transparent',
      },
    },
    defaultVariants: {},
  },
);

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof pillVariants> {}

export const Pill = forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { status, severity, priority, memberRole, orgRole, tone, className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        pillVariants({ status, severity, priority, memberRole, orgRole, tone }),
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
});
