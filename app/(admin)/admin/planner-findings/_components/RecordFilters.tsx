'use client';

import { useTranslations } from 'next-intl';
import {
  PLANNER_FINDING_PLANNER_VALUES,
  PLANNER_FINDING_SOURCE_VALUES,
  PLANNER_FINDING_VERDICT_STATE_VALUES,
} from '@/lib/dto/plannerFindings';
import { ANY, FilterBar, type FilterSpec } from './FilterBar';
import { RECORD_FILTER_KEYS, type RecordFilterKey } from './filterKeys';
import { findingLabel } from './findingLabels';

/**
 * The Records view's FILTERS — design MOTIR-11470 § Elements, Records filters:
 * verdict state (default All, which sets no parameter), planner and source, in
 * the shipped filter-bar grammar. It reads and writes only the three record keys,
 * so a finding-only key the view switch carried over is dropped by the first
 * change and never shown as a chip.
 */
export function RecordFilters() {
  const t = useTranslations('platformAdmin.plannerFindings');
  const label = (group: 'planner' | 'source', value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], group, value);

  const filters: FilterSpec<RecordFilterKey>[] = [
    {
      key: 'verdict',
      label: t('records.filter.verdict'),
      options: [
        { value: ANY, label: t('records.filter.verdictAll') },
        ...PLANNER_FINDING_VERDICT_STATE_VALUES.map((value) => ({
          value,
          label: t(`records.verdict.${value}`),
        })),
      ],
    },
    {
      key: 'planner',
      label: t('records.filter.planner'),
      options: [
        { value: ANY, label: t('records.filter.plannerAny') },
        ...PLANNER_FINDING_PLANNER_VALUES.map((value) => ({
          value,
          label: label('planner', value),
        })),
      ],
    },
    {
      key: 'source',
      label: t('records.filter.source'),
      options: [
        { value: ANY, label: t('records.filter.sourceAny') },
        ...PLANNER_FINDING_SOURCE_VALUES.map((value) => ({ value, label: label('source', value) })),
      ],
    },
  ];

  return (
    <FilterBar
      keys={RECORD_FILTER_KEYS}
      filters={filters}
      searchLabel={t('records.filter.label')}
      sheetTitle={t('records.filter.sheetTitle')}
    />
  );
}
