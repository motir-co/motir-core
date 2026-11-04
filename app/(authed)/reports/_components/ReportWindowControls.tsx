'use client';

import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { daysBackLadder, stepDaysBack } from '@/lib/reports/reportPageView';

// The Days-back stepper of the Workload report (Story MOTIR-8919), with the same
// markup and i18n keys as Average age's, so the window moves exactly like the
// bucketed reports' does. Workload is a ranked bar chart with no time buckets,
// so it has NO Period control (MOTIR-10346): its ladder is the bucket-free one
// (`null`), which reaches 365 days — a daily bucket cap does not apply to it.

export function ReportWindowControls({
  daysBack,
  onChange,
}: {
  daysBack: number;
  onChange: (next: { daysBack: number }) => void;
}) {
  const t = useTranslations('reports');
  const ladder = daysBackLadder(null);
  const atMin = daysBack <= ladder[0]!;
  const atMax = daysBack >= ladder[ladder.length - 1]!;

  return (
    <Field label={t('controls.daysBackLabel')}>
      <div className="inline-flex items-center gap-1 rounded-(--radius-btn) border border-(--el-border) bg-(--el-surface) p-0.5">
        <button
          type="button"
          aria-label={t('controls.daysBackFewer')}
          disabled={atMin}
          onClick={() => onChange({ daysBack: stepDaysBack(null, daysBack, -1) })}
          className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Minus className="h-4 w-4" aria-hidden />
        </button>
        <span
          className="min-w-12 text-center text-[13px] font-medium text-(--el-text)"
          aria-live="polite"
        >
          {t('cvr.daysBackValue', { days: daysBack })}
        </span>
        <button
          type="button"
          aria-label={t('controls.daysBackMore')}
          disabled={atMax}
          onClick={() => onChange({ daysBack: stepDaysBack(null, daysBack, 1) })}
          className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text) disabled:opacity-40 disabled:hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-(--el-text-muted)">{label}</span>
      {children}
    </div>
  );
}
