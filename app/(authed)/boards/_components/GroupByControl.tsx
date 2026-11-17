'use client';

import { useId, useState, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Flag, LayoutGrid, User, Zap } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Spinner } from '@/components/ui/Spinner';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils/cn';
import type { BoardSwimlaneGroupByDto } from '@/lib/dto/boards';

// GroupByControl (MOTIR-11451) — the board header's group-by trigger and menu,
// built to design MOTIR-11443 panels 1–2 (design-notes § *The group-by trigger and
// menu*): the shipped menu idiom — `Popover` + `Popover.Trigger` + `Popover.Content`
// with selectable rows, as `ColumnActionsMenu` and `IssueViewSwitcher` compose it.
//
//   - The trigger: the board toolbar's button grammar (the Filter trigger's), the
//     current dimension's glyph, "Group by" + the dimension, a chevron. Its
//     accessible name is that visible text; below `sm` the words are visually
//     dropped (glyph + chevron) but stay in the accessibility tree.
//   - The menu: `role=menu` of four `menuitemradio` rows, the current one
//     `aria-checked` with the trailing `Check`. Tab / Enter / Space and Escape are
//     the native button's and Radix's own (Escape returns focus to the trigger).
//   - Writing (`disabled` — the container is re-laying): the glyph becomes the
//     shipped `Spinner`, the trigger is disabled and `aria-busy`.
//   - Read-only (no `board:configure`): the trigger is disabled and opens no menu;
//     the reason is the shipped `Tooltip` for a pointer AND, because a disabled
//     button takes no focus, the group itself is a focus stop described by it.
//
// The value is CONTROLLED: what renders is always `value`, never local state, so a
// refused write leaves the previous dimension shown and the control agrees with
// the board. Choosing the active dimension calls nothing.

interface Dimension {
  value: BoardSwimlaneGroupByDto;
  labelKey: 'groupByNone' | 'groupByAssignee' | 'groupByEpic' | 'groupByPriority';
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

/** The four dimensions, in the design's order — the whole vocabulary. */
export const GROUP_BY_DIMENSIONS: readonly Dimension[] = [
  { value: 'none', labelKey: 'groupByNone', icon: LayoutGrid },
  { value: 'assignee', labelKey: 'groupByAssignee', icon: User },
  { value: 'epic', labelKey: 'groupByEpic', icon: Zap },
  { value: 'priority', labelKey: 'groupByPriority', icon: Flag },
];

const TRIGGER_CLASS =
  'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border border-(--el-border) px-(--spacing-control-x-12) font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none data-[state=open]:bg-(--el-surface)';

const ROW_CLASS =
  'flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export interface GroupByControlProps {
  value: BoardSwimlaneGroupByDto;
  onChange: (next: BoardSwimlaneGroupByDto) => void;
  /** The board is re-laying after a change: inert at the previous dimension. */
  disabled: boolean;
  /** MOTIR-6174 — the grouping is stored on the BOARD (`board:configure`). An
   *  actor without the key sees it read-only, with this reason. */
  readOnlyReason?: string;
}

export function GroupByControl({ value, onChange, disabled, readOnlyReason }: GroupByControlProps) {
  const t = useTranslations('boards');
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const readOnly = readOnlyReason !== undefined;
  const inert = disabled || readOnly;
  const active = GROUP_BY_DIMENSIONS.find((d) => d.value === value) ?? GROUP_BY_DIMENSIONS[0]!;
  const ActiveIcon = active.icon;

  function choose(next: BoardSwimlaneGroupByDto) {
    setOpen(false);
    if (next !== value) onChange(next);
  }

  const trigger = (
    <button
      type="button"
      disabled={inert}
      aria-busy={disabled || undefined}
      aria-haspopup="menu"
      className={cn(TRIGGER_CLASS, disabled && 'opacity-70', readOnly && 'opacity-60')}
      data-testid="board-group-by-trigger"
    >
      {disabled ? (
        <Spinner size="sm" aria-hidden />
      ) : (
        <ActiveIcon className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
      )}
      <span className="whitespace-nowrap max-sm:sr-only">
        <span className="text-(--el-text-secondary)">{t('groupByLabel')}</span> {t(active.labelKey)}
      </span>
      <ChevronDown className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
    </button>
  );

  const group = (
    <div
      role="group"
      aria-label={t('groupByAria')}
      // A disabled button takes no focus, so the read-only group is the focus
      // stop that carries the reason to a keyboard / screen-reader reader.
      tabIndex={readOnly ? 0 : undefined}
      aria-describedby={readOnly ? reasonId : undefined}
      data-read-only={readOnly ? '' : undefined}
      className="inline-flex rounded-(--radius-btn) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {readOnly ? (
        <>
          {trigger}
          <span id={reasonId} className="sr-only">
            {readOnlyReason}
          </span>
        </>
      ) : (
        <Popover open={open && !inert} onOpenChange={setOpen}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Content
            role="menu"
            aria-label={t('groupByLabel')}
            width={220}
            align="end"
            className="p-0"
          >
            <div className="p-1">
              {GROUP_BY_DIMENSIONS.map((d) => {
                const Icon = d.icon;
                const selected = d.value === value;
                return (
                  <button
                    key={d.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => choose(d.value)}
                    className={ROW_CLASS}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                    <span className="min-w-0 flex-1">{t(d.labelKey)}</span>
                    <Check
                      aria-hidden
                      className={cn(
                        'h-4 w-4 shrink-0 text-(--el-accent-on-surface)',
                        selected ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover>
      )}
    </div>
  );

  // A disabled button swallows the pointer, so the tooltip hangs off the group.
  return readOnly ? <Tooltip content={readOnlyReason}>{group}</Tooltip> : group;
}
