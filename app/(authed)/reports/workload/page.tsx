import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import type { ReportScopeDto } from '@/lib/dto/reports';
import { coerceDaysBack, coerceMeasure } from '@/lib/reports/reportPageView';
import { ReportPageChrome } from '../_components/ReportPageChrome';
import { WorkloadReport, type WorkloadResult } from '../_components/WorkloadReport';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// The Workload report page (Story 8.8 · Subtask 8.8.13) — per
// design/reports/more-reports.mock.html panel 4. Server Component: it resolves
// the active project, coerces the URL measure and days back (forgiving — a
// hand-edited/shared URL degrades to the defaults, never a 422), calls the
// WINDOWED read (work open at any point in the last Days back, an unassigned item
// counted on its reporter — Story MOTIR-8919; the bare path is 30 days), and
// hands the envelope to the client body that renders the horizontal ranked bar
// chart + the URL-driven Measure toggle. The config round-trips through the URL,
// so a configured report is shareable and reloads/restores. A `?period=` is
// IGNORED (MOTIR-10346): Workload has no time buckets, so an old shared link
// that still carries one renders the same bars as the link without it.

export default async function WorkloadPage({
  searchParams,
}: {
  searchParams: Promise<{
    savedFilterId?: string;
    measure?: string;
    daysBack?: string;
  }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('reports');
  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  const sp = await searchParams;
  const savedFilterId = sp.savedFilterId ?? null;
  const measure = coerceMeasure(sp.measure ?? null);
  const daysBack = coerceDaysBack(null, sp.daysBack ?? null);

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const scope: ReportScopeDto = savedFilterId ? { savedFilterId } : { projectId: ctx.projectId };

  const [result, filtersPage] = await Promise.all([
    reportsService.getWorkload(scope, { measure, window: { daysBack } }, accessCtx),
    savedFiltersService.list(ctx.project.identifier, { view: 'all' }, accessCtx),
  ]);

  const clientResult: WorkloadResult =
    result.state === 'ok'
      ? { state: 'ok', data: result.data }
      : result.state === 'no_access'
        ? { state: 'no_access' }
        : { state: 'stale', reason: result.reason };

  const subLine =
    result.state === 'ok'
      ? [
          ctx.project.name,
          t('workload.subWindow', { days: daysBack }),
          measure === 'issue_count'
            ? t('workload.subCount', { count: result.data.totalCount })
            : t('workload.subPoints', {
                points: result.data.totalPoints,
                count: result.data.totalCount,
              }),
        ].join(' · ')
      : ctx.project.name;

  return (
    <ReportPageChrome
      backLabel={t('backToReports')}
      crumb={t('hub.title')}
      title={t('workload.title')}
      subLine={subLine}
      help="workload"
    >
      <WorkloadReport
        result={clientResult}
        measure={measure}
        daysBack={daysBack}
        savedFilterId={savedFilterId}
        projectName={ctx.project.name}
        savedFilters={filtersPage.items.map((f) => ({ id: f.id, name: f.name }))}
      />
    </ReportPageChrome>
  );
}
