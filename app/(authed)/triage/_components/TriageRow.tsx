'use client';

import { SurfaceTitle } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { useFormatter, useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { cn } from '@/lib/utils/cn';
import type { TriageQueueItemDto } from '@/lib/dto/triage';
import { TriageAvatar } from './TriageAvatar';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// One queue row in the triage inbox (Subtask 6.11.6) — a NEW arrangement of
// shipped primitives, not a new primitive. Kind glyph (hued via IssueTypeIcon —
// never grey, finding #54), title, one clamped snippet line, submitter (tinted
// avatar + name; a public submitter adds the peach "Public" chip), relative
// age. A snoozed row carries a lavender "Snoozed · {day}" chip and is dimmed; the
// active row carries an inset accent rail. The whole row is one button.

export interface TriageRowProps {
  item: TriageQueueItemDto;
  active: boolean;
  onSelect: (id: string) => void;
}

export function TriageRow({ item, active, onSelect }: TriageRowProps) {
  const t = useTranslations('triage');
  const format = useFormatter();
  const relativeTime = useRelativeTime();

  const submitterName = item.submitter.name ?? t('unknownSubmitter');
  const isPublic = item.submitter.kind === 'public';
  const snoozed = item.snoozedUntil !== null;
  const snoozeDay = snoozed
    ? format.dateTime(new Date(item.snoozedUntil!), { weekday: 'short' })
    : '';

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left',
        'transition-colors hover:bg-(--el-surface)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
        active && 'bg-(--el-surface)',
        snoozed && 'opacity-60',
      )}
      style={active ? { boxShadow: 'inset 3px 0 0 var(--el-accent)' } : undefined}
    >
      <div className="flex items-start gap-2">
        <IssueTypeIcon type={item.kind} className="mt-0.5 h-4 w-4 shrink-0" />
        <SurfaceTitle
          id={item.id}
          title={item.title}
          layout="clamp"
          className="line-clamp-2 flex-1 text-sm font-medium text-(--el-text)"
        />
        <span className="shrink-0 text-xs text-(--el-text-secondary)">
          {relativeTime(new Date(item.triagedAt))}
        </span>
      </div>

      {item.descriptionSnippet ? (
        <p className="line-clamp-1 pl-6 text-xs text-(--el-text-secondary)">
          {item.descriptionSnippet}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pl-6">
        <TriageAvatar name={submitterName} />
        <span className="text-xs text-(--el-text-secondary)">{submitterName}</span>
        {isPublic ? (
          <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-peach) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-semibold text-(--el-text-strong)">
            {t('publicChip')}
          </span>
        ) : null}
        {snoozed ? (
          <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-semibold text-(--el-text-strong)">
            {t('snoozedChip', { day: snoozeDay })}
          </span>
        ) : null}
      </div>
    </button>
  );
}
