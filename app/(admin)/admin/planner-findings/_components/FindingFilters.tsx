'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';
import {
  PLANNER_FINDING_ATTRIBUTION_VALUES,
  PLANNER_FINDING_OUTCOME_VALUES,
  PLANNER_FINDING_PLANNER_VALUES,
  PLANNER_FINDING_SOURCE_VALUES,
} from '@/lib/dto/plannerFindings';
import { FINDING_FILTER_KEYS, type FindingFilterKey } from './filterKeys';
import { findingLabel, type FindingLabelGroup } from './findingLabels';

/**
 * The FILTER BAR — design MOTIR-10362 § Elements, the `LessonFilters` shape.
 * Every filter lives in the URL, because the server answers a filter change, so
 * each change is a `router.push` that keeps the other filters and the view and
 * drops the cursor walk. Each set filter is a removable chip. Below the md
 * breakpoint the row collapses into the Filters sheet (Panel 17).
 */

const ANY = '';

export function FindingFilters() {
  const t = useTranslations('platformAdmin.plannerFindings');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], group, value);

  function href(next: Partial<Record<FindingFilterKey, string>>, keepFilters = true): string {
    const url = new URLSearchParams();
    if (keepFilters) {
      for (const key of FINDING_FILTER_KEYS) {
        const value = key in next ? next[key] : params.get(key);
        if (value) url.set(key, value);
      }
    }
    // The view is not a filter: it survives every filter change. The cursor
    // walk starts over.
    const view = params.get('view');
    if (view) url.set('view', view);
    const qs = url.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const options = (
    group: FindingLabelGroup,
    anyLabel: string,
    values: readonly string[],
  ): ComboboxOption<string>[] => [
    { value: ANY, label: anyLabel },
    ...values.map((value) => ({ value, label: label(group, value) })),
  ];

  const filters: {
    key: FindingFilterKey;
    label: string;
    options: ComboboxOption<string>[];
  }[] = [
    {
      key: 'source',
      label: t('filter.source'),
      options: options('source', t('filter.sourceAny'), PLANNER_FINDING_SOURCE_VALUES),
    },
    {
      key: 'planner',
      label: t('filter.planner'),
      options: options('planner', t('filter.plannerAny'), PLANNER_FINDING_PLANNER_VALUES),
    },
    {
      key: 'outcome',
      label: t('filter.outcome'),
      options: options('outcome', t('filter.outcomeAny'), PLANNER_FINDING_OUTCOME_VALUES),
    },
    {
      key: 'attribution',
      label: t('filter.attribution'),
      options: options(
        'attribution',
        t('filter.attributionAny'),
        PLANNER_FINDING_ATTRIBUTION_VALUES,
      ),
    },
    {
      key: 'state',
      label: t('filter.state'),
      options: [
        { value: ANY, label: t('filter.stateDefault') },
        { value: 'dismissed', label: t('status.dismissed') },
        { value: 'all', label: t('filter.stateAll') },
      ],
    },
  ];

  const chips = filters.flatMap((filter) => {
    const value = params.get(filter.key);
    if (!value) return [];
    const shown = filter.options.find((o) => o.value === value)?.label ?? value;
    return [{ key: filter.key, label: filter.label, value: shown }];
  });

  const row = (layout: string) =>
    filters.map((filter) => (
      <div key={filter.key} className={`flex flex-col gap-1 ${layout}`}>
        <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
          {filter.label}
        </span>
        <Combobox
          label={filter.label}
          options={filter.options}
          value={params.get(filter.key) ?? ANY}
          onChange={(value) => router.push(href({ [filter.key]: value }))}
          searchable={false}
        />
      </div>
    ));

  return (
    <div className="flex flex-col gap-3">
      <div
        role="search"
        aria-label={t('filter.label')}
        className="hidden flex-wrap items-end gap-2 md:flex"
      >
        {row('w-44')}
      </div>
      <div className="md:hidden">
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11"
          leftIcon={<SlidersHorizontal aria-hidden className="h-4 w-4" />}
          onClick={() => setSheetOpen(true)}
        >
          {t('filter.sheetButton')}
          {chips.length > 0 ? ` · ${chips.length}` : ''}
        </Button>
        <Modal open={sheetOpen} onOpenChange={setSheetOpen} title={t('filter.sheetTitle')}>
          <div role="search" aria-label={t('filter.label')} className="flex flex-col gap-3">
            {row('w-full')}
            <Button className="min-h-11" onClick={() => setSheetOpen(false)}>
              {t('filter.sheetDone')}
            </Button>
          </div>
        </Modal>
      </div>
      {chips.length > 0 ? (
        <div
          data-testid="planner-findings-filter-chips"
          className="flex flex-wrap items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-text-secondary)"
        >
          <span>{t('filter.count', { n: chips.length })}</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text)"
            >
              {chip.label}: {chip.value}
              <button
                type="button"
                aria-label={t('filter.remove', { filter: chip.label })}
                className="rounded-(--radius-control) text-(--el-text-secondary) hover:text-(--el-text)"
                onClick={() => router.push(href({ [chip.key]: '' }))}
              >
                <X aria-hidden className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Button size="sm" variant="ghost" onClick={() => router.push(href({}, false))}>
            {t('filter.clearAll')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
