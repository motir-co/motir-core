'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlarmClock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { DatePicker } from '@motir/design-system';

// The Snooze picker (Subtask 6.11.6, design panel 1d) — a Popover offering
// Tomorrow / Next week (each showing the resolved date) / Pick a date…
// (DatePicker). The ISO instant is computed client-side (end-of-day local) and
// the parent POSTs it as `{ snoozedUntil }`. A muted note states the auto-return
// on new activity.

function endOfDay(d: Date): Date {
  const next = new Date(d);
  next.setHours(23, 59, 59, 0);
  return next;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export interface SnoozePopoverProps {
  busy: boolean;
  onSnooze: (snoozedUntilIso: string) => void;
}

export function SnoozePopover({ busy, onSnooze }: SnoozePopoverProps) {
  const t = useTranslations('triage');
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  const tomorrow = endOfDay(addDays(new Date(), 1));
  const nextWeek = endOfDay(addDays(new Date(), 7));

  function optionRow(label: string, when: Date, onClick: () => void) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="flex w-full items-center justify-between gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left transition-colors hover:bg-(--el-surface) disabled:opacity-50"
      >
        <span className="text-sm font-medium text-(--el-text)">{label}</span>
        <span className="text-xs text-(--el-text-secondary)">
          {format.dateTime(when, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      </button>
    );
  }

  function commitPicked(dateKey: string | null) {
    setPicked(dateKey);
    if (!dateKey) return;
    // DatePicker yields a YYYY-MM-DD key; snooze to the end of that local day.
    const [y, m, d] = dateKey.split('-').map(Number);
    const instant = endOfDay(new Date(y!, m! - 1, d!));
    onSnooze(instant.toISOString());
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" leftIcon={<AlarmClock className="h-4 w-4" />}>
          {t('actions.snooze')}
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" width={300} className="flex flex-col gap-1 p-2">
        <p className="px-(--spacing-control-x) pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-(--el-text-secondary)">
          {t('snoozePopover.heading')}
        </p>
        {optionRow(t('snoozePopover.tomorrow'), tomorrow, () => onSnooze(tomorrow.toISOString()))}
        {optionRow(t('snoozePopover.nextWeek'), nextWeek, () => onSnooze(nextWeek.toISOString()))}
        <div className="px-(--spacing-control-x) py-1">
          <DatePicker
            value={picked}
            onChange={commitPicked}
            placeholder={t('snoozePopover.pickDate')}
            aria-label={t('snoozePopover.pickDateAria')}
          />
        </div>
        <div className="my-1 border-t border-(--el-border)" />
        <p className="flex items-center gap-1.5 px-(--spacing-control-x) pb-1 text-xs text-(--el-text-muted)">
          <AlarmClock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('snoozePopover.note')}
        </p>
      </Popover.Content>
    </Popover>
  );
}
