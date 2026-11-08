'use client';

import { CheckCircle2, CirclePlay, Flag, ListPlus } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { isManualReadyItem } from '@/lib/dto/ready';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { canvasStatusLabel, canvasStatusMeta } from '@/lib/workflows/canvasStatusMeta';
import { statusSlotOf, type StatusSlotItem } from '@/lib/workItems/statusSlot';

// THE WORK ITEM'S STATE TAGS — the canvas card's tag row, shared (MOTIR-10534).
//
// The roadmap canvas card (`WorkItemNode`, design MOTIR-10508) draws an item's
// state as a STATUS SLOT — the status chip, or the Done / To plan / Ready pill
// that replaces it — followed by the Manual chip, with the blocked flag on the
// right. Those drawings used to live inside `WorkItemNode.tsx`, so the /boards
// card, the quick view and the item page each drew status their own way (or not
// at all). They live here now, and every surface renders through them, so one
// item reads the same on all four.
//
// The precedence rule is `lib/workItems/statusSlot.ts`'s, in a module with no
// directive so server code shares it; this file is only the drawing.
//
// What stays on the canvas alone: You are here (the card's own tab, never the
// slot — MOTIR-10630), not in sprint, the drill chevron, the run disposition and
// the card washes.

/**
 * One pill in the tag row's STATUS SLOT (MOTIR-10508): the tag row's one chip size
 * (11px text, a 12px glyph, `chip-x-6`), `min-w-0` so a long label is the last
 * thing to give way (it truncates, its glyph stays), and its name on `title`. With
 * `glyphOnly` (the give-way rule) the label goes and the name rides `aria-label`
 * on a `role="img"`, so it is still read out and shown on hover.
 */
export function SlotPill({
  label,
  icon,
  glyphOnly,
  className,
  ...rest
}: {
  label: string;
  icon: ReactNode;
  glyphOnly: boolean;
  className: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'title' | 'children'>) {
  return (
    <span
      {...rest}
      {...(glyphOnly ? { role: 'img', 'aria-label': label } : {})}
      title={label}
      className={`inline-flex min-w-0 items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] font-medium ${className}`}
    >
      {icon}
      {glyphOnly ? null : <span className="truncate">{label}</span>}
    </span>
  );
}

/**
 * ONE workflow status as a canvas chip. The KEY is whatever the project's
 * workflow defines; `label` / `category` are the status's own identity as the
 * read carried them (bug MOTIR-3170). A key with no per-key treatment takes its
 * category's tone, and one with neither takes the neutral chip — it never
 * impersonates To Do.
 */
export function WorkItemStatusPill({
  status,
  label = null,
  category = null,
  slot = false,
  glyphOnly = false,
}: {
  status: string;
  label?: string | null;
  category?: StatusCategoryDto | null;
  /** The TAG-ROW status slot (MOTIR-10508): `min-w-0`, the name on `title`, the
   *  label truncating last. Absent, the shipped `shrink-0` chip (a proposal's top
   *  row and the item page's core-fields rail keep it). */
  slot?: boolean;
  /** The give-way rule's glyph-only chip: the name rides `aria-label` (`role="img"`)
   *  and `title`. Only with `slot`. */
  glyphOnly?: boolean;
}) {
  const meta = canvasStatusMeta(status, category);
  const Icon = meta.icon;
  const tStatus = useTranslations('labels.defaultStatus');
  const name = canvasStatusLabel(status, label, tStatus);
  if (slot) {
    return (
      <SlotPill
        data-status={status}
        label={name}
        glyphOnly={glyphOnly}
        className={`${meta.tint} ${meta.text}`}
        icon={<Icon className="size-3 shrink-0" aria-hidden="true" />}
      />
    );
  }
  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] font-medium ${meta.tint} ${meta.text}`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {name}
    </span>
  );
}

/** The "Ready" pill (MOTIR-1417) — a white chip on the mint card wash
 *  (MOTIR-1422): the success icon carries the "go" hue; the chip surface lifts off
 *  the tint for contrast. Replaces the dim "To do" pill. */
export function ReadyPill({ glyphOnly }: { glyphOnly: boolean }) {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <SlotPill
      data-testid="ready-pill"
      label={t('ready')}
      glyphOnly={glyphOnly}
      className="border border-(--el-border) bg-(--el-page-bg) text-(--el-text-strong)"
      icon={<CirclePlay className="size-3 shrink-0 text-(--el-success)" aria-hidden="true" />}
    />
  );
}

/** The "To plan" pill (MOTIR-10508) — the Ready pill's white chip with a
 *  `ListPlus` glyph, on the yellow To plan wash. */
export function ToPlanPill({ glyphOnly }: { glyphOnly: boolean }) {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <SlotPill
      data-testid="to-plan-pill"
      label={t('toPlan')}
      glyphOnly={glyphOnly}
      className="border border-(--el-border) bg-(--el-page-bg) text-(--el-text-strong)"
      icon={<ListPlus className="size-3 shrink-0 text-(--el-text-secondary)" aria-hidden="true" />}
    />
  );
}

/** The "Done" stamp (MOTIR-1422) — a SOLID DARK chip. Deliberately NOT
 *  success-green (so it can't be confused with the ready highlight) AND far heavier
 *  than the light "To do" chip (so done can't be confused with todo — the redo). On
 *  the canvas the card itself takes a distinct `--el-tint-sky` fill + a struck
 *  title, so done reads as the opposite of ready's mint-forward wash. */
export function DonePill({ glyphOnly }: { glyphOnly: boolean }) {
  const tStatus = useTranslations('labels.defaultStatus');
  return (
    <SlotPill
      data-testid="done-pill"
      label={tStatus('done')}
      glyphOnly={glyphOnly}
      className="bg-(--el-text-secondary) text-(--el-text-inverted)"
      icon={
        <CheckCircle2 className="size-3 shrink-0 text-(--el-text-inverted)" aria-hidden="true" />
      }
    />
  );
}

/** The item a slot is drawn for — the slot's facts plus the status's own identity. */
export interface WorkItemStateItem extends StatusSlotItem {
  /** The status's display label from the project's workflow, when the read has it. */
  statusLabel?: string | null;
  /** The work TYPE — with `executor`, decides the Manual chip. */
  type?: WorkItemTypeDto | null;
  /** WHO executes the work — `human` (or `type: 'manual'`) is Manual. */
  executor?: ExecutorDto | null;
}

/**
 * THE STATUS SLOT (MOTIR-10508): the one pill `statusSlotOf` picks — Done ›
 * To plan › Ready › the status chip. Every surface draws it by this one rule,
 * the canvas's "here" card included (its You are here is a tab, MOTIR-10630).
 */
export function WorkItemStatusSlot({
  item,
  ready,
  blocked,
  glyphOnly = false,
}: {
  item: WorkItemStateItem;
  /** Startable and fully unblocked (`isReadyToStart`). */
  ready: boolean;
  /** Blocked — a blocked item never wears the Done stamp (its flag is louder). */
  blocked: boolean;
  glyphOnly?: boolean;
}) {
  const slot = statusSlotOf(item, { ready, blocked });
  if (slot === 'done') return <DonePill glyphOnly={glyphOnly} />;
  if (slot === 'to-plan') return <ToPlanPill glyphOnly={glyphOnly} />;
  if (slot === 'ready') return <ReadyPill glyphOnly={glyphOnly} />;
  return (
    <WorkItemStatusPill
      status={item.status}
      label={item.statusLabel ?? null}
      category={item.statusCategory ?? null}
      slot
      glyphOnly={glyphOnly}
    />
  );
}

/**
 * The MANUAL chip (MOTIR-1642 / 8.8.36): a human-gated item — the shipped
 * `isManualReadyItem` predicate — so a person scanning spots what needs THEM.
 * Composed from the shipped `WorkItemTypeChip`, a hairline `--el-border` lifting it
 * off any fill. Draws nothing for any other item.
 */
export function WorkItemManualChip({
  item,
  glyphOnly = false,
}: {
  item: Pick<WorkItemStateItem, 'type' | 'executor'>;
  glyphOnly?: boolean;
}) {
  if (!isManualReadyItem({ type: item.type ?? null, executor: item.executor ?? null })) return null;
  return (
    <WorkItemTypeChip
      type="manual"
      glyphOnly={glyphOnly}
      className="shrink-0 gap-1 border-(--el-border) px-(--spacing-chip-x-4) py-0 text-[10.5px]"
    />
  );
}

/**
 * The tag row's LEFT group, shared by every surface that shows an item: the
 * status slot, then the Manual chip. A fragment, so the caller's row lays both out
 * as its own children — the canvas card's DOM is unchanged by the extraction.
 */
export function WorkItemStateTags({
  item,
  ready,
  blocked,
  glyphOnly = false,
}: {
  item: WorkItemStateItem;
  ready: boolean;
  blocked: boolean;
  glyphOnly?: boolean;
}) {
  return (
    <>
      <WorkItemStatusSlot item={item} ready={ready} blocked={blocked} glyphOnly={glyphOnly} />
      <WorkItemManualChip item={item} glyphOnly={glyphOnly} />
    </>
  );
}

/**
 * The BLOCKED flag in the tag row's short form (MOTIR-10508): the visible label is
 * `blocked`, and the full sentence rides `title` and `aria-label`. The canvas
 * passes its own sentence (*blocked elsewhere* / *blocker not in sprint*); the
 * board, the quick view and the item page pass the readiness sentence.
 */
export function BlockedTag({ sentence }: { sentence: string }) {
  const t = useTranslations('roadmap.canvas.node');
  return (
    <span
      data-testid="cross-blocked-flag"
      role="img"
      title={sentence}
      aria-label={sentence}
      className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-danger-surface) px-(--spacing-chip-x-6) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-danger-on-surface)"
    >
      <Flag className="size-3" aria-hidden="true" />
      <span aria-hidden="true">{t('blockedShort')}</span>
    </span>
  );
}

/** The blocked flag off the canvas: readiness says the item is blocked. */
export function WorkItemBlockedTag() {
  const t = useTranslations('ui.readiness');
  return <BlockedTag sentence={t('blocked')} />;
}
