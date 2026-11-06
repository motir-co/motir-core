'use client';

import { useTranslations } from 'next-intl';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import { WorkItemTypeIcon } from '@/components/issues/WorkItemTypeIcon';
import { workItemTypeChipBackground } from '@/lib/issues/workItemTypeMeta';
import { cn } from '@/lib/utils/cn';

// The work-item TYPE chip (Story 2.7 · Subtask 2.7.4) — the detail-rail read
// face of a typed leaf, per design/work-items/type-executor-picker.mock.html
// panel 3. The `Pill` tint-background recipe (hue in a `color-mix` BACKGROUND +
// `--el-text-strong` label, AA / finding #35) PLUS the saturated
// `IssueTypeIcon`-adjacent glyph — a NEW recipe because `Pill`'s tones are a
// fixed closed set that can't express a per-type custom hue. Shape via the
// element-semantic tokens (`--radius-badge`, `--spacing-chip-*`) like `Pill`,
// so it reshapes under `data-style`. The label is the i18n type gloss
// (the same `labels.workItemType.*` the picker uses).

export interface WorkItemTypeChipProps {
  type: WorkItemTypeDto;
  className?: string;
  /** The glyph alone (the roadmap card's give-way rule, MOTIR-10508): the type's
   *  name rides `title` and `aria-label` on a `role="img"`, so it is still read out
   *  and shown on hover. */
  glyphOnly?: boolean;
}

export function WorkItemTypeChip({ type, className, glyphOnly = false }: WorkItemTypeChipProps) {
  const tl = useTranslations('labels');
  const name = tl(`workItemType.${type}`);
  return (
    <span
      {...(glyphOnly ? { title: name, 'aria-label': name, role: 'img' } : {})}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-transparent px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong)',
        className,
      )}
      style={{ backgroundColor: workItemTypeChipBackground(type) }}
    >
      <WorkItemTypeIcon type={type} className="h-3.5 w-3.5" />
      {glyphOnly ? null : name}
    </span>
  );
}
