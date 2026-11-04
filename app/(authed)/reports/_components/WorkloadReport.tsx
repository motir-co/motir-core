'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { HBarChart, chartColor, type ChartLegendItem } from '@/components/ui/charts';
import type { WorkloadDto, WorkloadMeasureDto, ReportStaleReasonDto } from '@/lib/dto/reports';
import { buildReportHref } from '@/lib/reports/reportPageView';
import { Segmented } from '@/components/ui/Segmented';
import { ReportScopeCombobox, type ReportScopeOption } from './ReportScopeCombobox';
import { ReportStateMessage } from './ReportStateMessage';
import { ReportWindowControls } from './ReportWindowControls';

// The Workload report page body (Story 8.8 · Subtask 8.8.13), per
// design/reports/more-reports.mock.html panel 4. Owns the URL-driven scope,
// Days back and MEASURE controls (story points vs work-item count) — no Period:
// a ranked bar chart has no time buckets (MOTIR-10346); each change navigates so
// the report is shareable. The chart is the 8.8.13 horizontal ranked HBarChart —
// open work per assignee, the unassigned bucket last (the justified deviation
// from Jira's pie: a magnitude ranking reads directly as bar length, no
// segment-overflow cliff). The Measure toggle is a client-driven re-rank of the
// same DTO (both points + count travel). Each bar is named + valued + in the
// data table, never colour alone (finding #35).

export type WorkloadResult =
  | { state: 'ok'; data: WorkloadDto }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

export function WorkloadReport({
  result,
  measure,
  daysBack,
  savedFilterId,
  projectName,
  savedFilters,
}: {
  result: WorkloadResult;
  measure: WorkloadMeasureDto;
  daysBack: number;
  savedFilterId: string | null;
  projectName: string;
  savedFilters: ReportScopeOption[];
}) {
  const t = useTranslations('reports');
  const router = useRouter();
  const pathname = usePathname();

  function go(next: {
    savedFilterId?: string | null;
    measure?: WorkloadMeasureDto;
    daysBack?: number;
  }) {
    // No `period`: Workload has no time buckets, so the URL never carries one.
    router.push(buildReportHref(pathname, { savedFilterId, measure, daysBack, ...next }));
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <Field label={t('scope.label')}>
          <ReportScopeCombobox
            projectName={projectName}
            savedFilters={savedFilters}
            savedFilterId={savedFilterId}
            onChange={(id) => go({ savedFilterId: id })}
          />
        </Field>
        <ReportWindowControls daysBack={daysBack} onChange={(next) => go(next)} />
        <Field label={t('controls.measureLabel')}>
          <Segmented
            label={t('controls.measureLabel')}
            value={measure}
            onChange={(m) => go({ measure: m })}
            options={[
              { value: 'story_points', label: t('controls.storyPoints') },
              { value: 'issue_count', label: t('controls.issueCount') },
            ]}
          />
        </Field>
      </div>

      <WorkloadBody
        result={result}
        measure={measure}
        onReset={() => go({ savedFilterId: null })}
        t={t}
      />
    </div>
  );
}

function WorkloadBody({
  result,
  measure,
  onReset,
  t,
}: {
  result: WorkloadResult;
  measure: WorkloadMeasureDto;
  onReset: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  if (result.state === 'no_access') return <ReportStateMessage state={{ kind: 'no_access' }} />;
  if (result.state === 'stale') {
    return (
      <ReportStateMessage state={{ kind: 'stale', reason: result.reason }} onReset={onReset} />
    );
  }

  const { assignees, totalPoints, totalCount } = result.data;
  if (assignees.length === 0) return <ReportStateMessage state={{ kind: 'empty' }} />;

  const isCount = measure === 'issue_count';
  const assignedOf = (a: (typeof assignees)[number]) =>
    isCount ? a.assignedCount : a.assignedPoints;
  const unassignedOf = (a: (typeof assignees)[number]) =>
    isCount ? a.unassignedCount : a.unassignedPoints;
  const totalOf = (a: (typeof assignees)[number]) => (isCount ? a.count : a.points);
  const assignedLabel = t('workload.legendAssigned');
  const unassignedLabel = t('workload.legendUnassigned');

  // Ranked as the read returns them (total descending, the person-less bar last).
  // A person bar is two segments; the person-less "Unassigned" bar is one neutral
  // segment — it has no reporter to attribute to.
  const bars = assignees.map((a) => {
    const total = totalOf(a);
    if (a.assigneeId === null) {
      return {
        label: t('workload.unassigned'),
        value: total,
        color: chartColor.categoricalNone,
        valueLabel: String(total),
      };
    }
    const assigned = assignedOf(a);
    const unassigned = unassignedOf(a);
    return {
      label: a.name ?? t('workload.unassigned'),
      value: total,
      color: chartColor.workloadAssigned,
      segments: [
        { value: assigned, color: chartColor.workloadAssigned, label: assignedLabel },
        { value: unassigned, color: chartColor.workloadUnassigned, label: unassignedLabel },
      ],
      // "34 = 21 + 13" — the split written at the bar's end (design panel 4).
      valueLabel: unassigned > 0 ? `${total} = ${assigned} + ${unassigned}` : String(total),
    };
  });

  const unit = isCount ? t('workload.legendUnitCount') : t('workload.legendUnitPoints');
  const legend: ChartLegendItem[] = [
    { label: assignedLabel, color: chartColor.workloadAssigned, kind: 'swatch', emphasis: true },
    {
      label: unassignedLabel,
      color: chartColor.workloadUnassigned,
      kind: 'swatch',
      emphasis: true,
    },
    {
      label: `${t('workload.legendLabel')} · ${unit}`,
      color: chartColor.categoricalNone,
      kind: 'swatch',
    },
  ];

  return (
    <HBarChart
      fit="page"
      bars={bars}
      xTitle={isCount ? t('workload.xCount') : t('workload.xPoints')}
      width={680}
      legend={legend}
      ariaLabel={t('workload.title')}
      description={t('workload.chartDesc', {
        measure: unit,
        breakdown: assignees
          .map((a) =>
            a.assigneeId === null
              ? `${t('workload.unassigned')} ${totalOf(a)}`
              : t('workload.chartDescPerson', {
                  name: a.name ?? t('workload.unassigned'),
                  total: totalOf(a),
                  assigned: assignedOf(a),
                  unassigned: unassignedOf(a),
                }),
          )
          .join(', '),
        total: isCount ? totalCount : totalPoints,
        count: totalCount,
      })}
      dataTable={{
        caption: t('workload.tableCaption'),
        columns: [
          t('workload.tableAssignee'),
          t('workload.tableAssigned'),
          t('workload.tableUnassigned'),
          t('workload.tableTotal'),
        ],
        rows: assignees.map((a) => ({
          header: a.name ?? t('workload.unassigned'),
          cells: [
            { value: assignedOf(a), numeric: true },
            { value: unassignedOf(a), numeric: true },
            { value: totalOf(a), numeric: true },
          ],
        })),
      }}
    />
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
