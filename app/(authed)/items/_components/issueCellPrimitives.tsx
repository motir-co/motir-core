'use client';

import { useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import { StatusPill } from '@/components/issues/StatusPill';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// The presentational vocabulary the /items row cells share (Subtask 2.5.3,
// extracted in 2.5.5). A leaf module — no Server Actions, no context — so BOTH
// the static column cells (issueColumns) AND the inline-edit cells
// (IssueInlineEdit) render the SAME pill/avatar for a value, whether the cell is
// read-only or editable. Keeping these here (not in issueColumns) lets the
// inline-edit module import the display without an import cycle.

// The status→chip mapping MOVED to `components/issues/StatusPill` (MOTIR-3103).
// It used to live here as a per-CATEGORY record that six other surfaces imported
// and re-indexed themselves; `implemented` shares the `in_progress` category with
// three other statuses, so the tone had to become key-first — and a rule six
// files index is a rule six files can disagree about. One component now owns the
// tone AND the glyph that goes with it.

/** Initial-letter avatar — mirrors the detail rail / ChildList avatar. */
export function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[10px] font-semibold text-(--el-text-inverted)"
      aria-hidden
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** The STATUS cell value — the shared chip, so a row renders the same status the
 *  same way the detail page and the public project page do. `statusKey` is what
 *  lets a status carry its OWN tone rather than its category's (MOTIR-3103); a
 *  caller that genuinely has no key still gets the category chip. */
export function StatusValue({
  statusKey,
  category,
  label,
}: {
  statusKey?: string | null;
  category: StatusCategoryDto | null;
  label: string;
}) {
  return <StatusPill statusKey={statusKey} category={category} label={label} />;
}

/** The ASSIGNEE cell value — avatar + name, or the muted "Unassigned" empty. */
export function AssigneeValue({ name }: { name: string | null }) {
  const t = useTranslations('issues');
  return name ? (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={name} />
      <span className="truncate text-(--el-text-secondary)">{name}</span>
    </span>
  ) : (
    <span className="text-(--el-text-secondary)">{t('columns.unassigned')}</span>
  );
}

/** The PRIORITY cell value — the shared PRIORITY_META chip (tone + direction icon). */
export function PriorityValue({ priority }: { priority: WorkItemPriorityDto }) {
  const t = useTranslations('labels');
  const meta = PRIORITY_META[priority];
  return (
    <Pill {...meta.pill}>
      <meta.icon className="h-3 w-3" aria-hidden />
      {t(`priority.${priority}`)}
    </Pill>
  );
}

/** The ESTIMATE cell value — the pre-formatted duration, or a muted em dash. */
export function EstimateValue({ label }: { label: string | null }) {
  return label ? (
    <span className="truncate text-(--el-text-secondary)">{label}</span>
  ) : (
    <span className="text-(--el-text-secondary)">—</span>
  );
}
