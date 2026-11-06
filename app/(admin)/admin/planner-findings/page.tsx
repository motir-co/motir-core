import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FilterX, Info, ScanSearch } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MotirAiError } from '@/lib/ai/errors';
import type { PlannerFindingGroupListDTO, PlannerFindingListDTO } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { plannerFindingsService } from '@/lib/services/plannerFindingsService';
import { FindingFilters } from './_components/FindingFilters';
import { FindingsSkeleton } from './_components/FindingsSkeleton';
import { FindingsTable } from './_components/FindingsTable';
import { FindingsPager, pagerPosition } from './_components/FindingsPager';
import { FindingsUnavailable } from './_components/FindingsUnavailable';
import { FindingsViewSwitch } from './_components/FindingsViewSwitch';
import { findingsView, hasFindingFilter } from './_components/filterKeys';
import { GroupsTable } from './_components/GroupsTable';
import { toListFilters } from './_components/listFilters';

/**
 * The console's PLANNER FINDINGS page — design MOTIR-10362 (`platform-admin`
 * § AMENDMENT 2026-11-04), Story MOTIR-10353, card MOTIR-10522.
 *
 * Every finding the hosted planner's dry run and the check plan skill stored,
 * filtered and cursor-paged by motir-ai. The sibling of Planning lessons, built
 * the same way. Every staff role reads; a non-staff request gets the app's 404
 * from this page's gate as from the layout's (`pageGate.ts`, MOTIR-7613).
 *
 * ⚠️ AN UNREADABLE motir-ai IS THE UNAVAILABLE STATE, NEVER AN EMPTY LIST.
 * ⚠️ THERE IS NO TOTAL. Previous walks back through the cursors this URL has
 * carried (`trail`), so a deep link and Back agree.
 */

export const metadata: Metadata = { title: 'Planner findings' };

/** Never cached — a finding triaged a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

const BASE = '/admin/planner-findings';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AdminPlannerFindingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.plannerFindings');
  const params = await searchParams;

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>
            <strong className="font-semibold text-(--el-text-strong)">{t('infoLead')}</strong>{' '}
            {t('infoBody')}
          </span>
        </p>
      </div>

      {/* After the gate, so the frame can never fix a status (the boundary
          rule: no loading.tsx above a segment that can answer 404). */}
      <Suspense
        key={JSON.stringify(params)}
        fallback={<FindingsSkeleton title={t('card.title')} label={t('loading.label')} />}
      >
        <FindingsSection principal={principal} params={params} />
      </Suspense>
    </div>
  );
}

async function FindingsSection({
  principal,
  params,
}: {
  principal: PlatformPrincipal;
  params: SearchParams;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const view = findingsView(params);
  const filters = toListFilters(params);

  // Both views read with the SAME filters, so they cannot disagree about the
  // default that hides dismissed findings (the service owns it).
  let read:
    | { view: 'grouped'; data: PlannerFindingGroupListDTO }
    | { view: 'all'; data: PlannerFindingListDTO };
  try {
    read =
      view === 'grouped'
        ? { view, data: await plannerFindingsService.listGroups(principal, filters) }
        : { view, data: await plannerFindingsService.list(principal, filters) };
  } catch (err) {
    // Any motir-ai failure is the unavailable state; anything else is a bug.
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] planner findings could not be read', err);
    return <FindingsUnavailable />;
  }

  const rows = read.view === 'grouped' ? read.data.groups.length : read.data.findings.length;
  const nextCursor = read.data.nextCursor;
  const table =
    read.view === 'grouped' ? (
      <GroupsTable groups={read.data.groups} params={params} />
    ) : (
      <FindingsTable rows={read.data.findings} />
    );

  const { cursor, trail, pageNumber } = pagerPosition(params);

  let body: React.ReactNode;
  if (rows > 0) {
    body = table;
  } else if (hasFindingFilter(params) || cursor) {
    body = (
      <EmptyState
        data-testid="planner-findings-no-match"
        icon={<FilterX />}
        title={t('noMatch.title')}
        description={t('noMatch.body')}
        action={
          <Link
            href={BASE}
            className="font-sans text-sm text-(--el-link) underline-offset-2 hover:underline"
          >
            {t('noMatch.action')}
          </Link>
        }
      />
    );
  } else {
    body = (
      <EmptyState
        data-testid="planner-findings-empty"
        icon={<ScanSearch />}
        title={t('empty.title')}
        description={t('empty.body')}
      />
    );
  }

  const showPager = pageNumber > 1 || nextCursor !== null;

  return (
    <Card
      data-testid="planner-findings-card"
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
            >
              <ScanSearch className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('card.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {view === 'grouped' ? t('card.subtitleGrouped') : t('card.subtitleAll')}
              </p>
            </div>
          </div>
          <FindingsViewSwitch />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <FindingFilters />
        {body}
        {showPager ? (
          <FindingsPager
            basePath={BASE}
            params={params}
            keep={{ view }}
            pageNumber={pageNumber}
            trail={trail}
            cursor={cursor}
            nextCursor={nextCursor}
          />
        ) : null}
      </div>
    </Card>
  );
}
