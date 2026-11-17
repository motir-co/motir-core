'use client';

import { useTranslations } from 'next-intl';
import type { ComboboxOption } from '@/components/ui/Combobox';
import {
  PLANNER_FINDING_ATTRIBUTION_VALUES,
  PLANNER_FINDING_OUTCOME_VALUES,
  PLANNER_FINDING_PLANNER_VALUES,
  PLANNER_FINDING_SOURCE_VALUES,
} from '@/lib/dto/plannerFindings';
import { ANY, FilterBar, type FilterSpec } from './FilterBar';
import { FINDING_FILTER_KEYS, type FindingFilterKey } from './filterKeys';
import { findingLabel, type FindingLabelGroup } from './findingLabels';

/**
 * The findings FILTER BAR — design MOTIR-10362 § Elements, the `LessonFilters`
 * shape: source, planner, outcome, attribution and triage state, drawn by the
 * shared `FilterBar` (each filter URL-held, a removable chip per set filter, the
 * Filters sheet below md, Panel 17).
 */

export function FindingFilters() {
  const t = useTranslations('platformAdmin.plannerFindings');
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], group, value);

  const options = (
    group: FindingLabelGroup,
    anyLabel: string,
    values: readonly string[],
  ): ComboboxOption<string>[] => [
    { value: ANY, label: anyLabel },
    ...values.map((value) => ({ value, label: label(group, value) })),
  ];

  const filters: FilterSpec<FindingFilterKey>[] = [
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

  return (
    <FilterBar
      keys={FINDING_FILTER_KEYS}
      filters={filters}
      searchLabel={t('filter.label')}
      sheetTitle={t('filter.sheetTitle')}
    />
  );
}
