import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, ScanSearch } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MotirAiError } from '@/lib/ai/errors';
import type { PlannerFindingGroupRowDTO, PlannerFindingListDTO } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { plannerFindingsService } from '@/lib/services/plannerFindingsService';
import { FindingsPager, pagerPosition } from '../../_components/FindingsPager';
import { FindingsSkeleton } from '../../_components/FindingsSkeleton';
import { FindingsTable } from '../../_components/FindingsTable';
import { FindingsUnavailable } from '../../_components/FindingsUnavailable';
import { groupBackHref, groupHref } from '../../_components/groupLinks';
import { toListFilters } from '../../_components/listFilters';

/**
 * A REPEATED DEFECT's page — Story MOTIR-10353, card MOTIR-10523, design
 * MOTIR-10362 Panel 10 (the full-page form the design draws below md).
 *
 * It reads the group's counts and its findings with the fingerprint from the
 * route and EXACTLY the filters the grouped list was opened under, so the
 * findings it opens are the ones its count was computed over.
 *
 * ⚠️ A FINGERPRINT THAT MATCHES NOTHING IS `group.empty` WITH A 200, never a 404:
 * motir-ai cannot tell an unknown fingerprint from a group the filters hide.
 * ⚠️ AN UNREADABLE motir-ai IS THE UNAVAILABLE STATE, never an empty group.
 */

export const metadata: Metadata = { title: 'Planner findings' };

/** Never cached — a finding triaged a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PlannerFindingGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ fingerprint: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.plannerFindings');
  const { fingerprint: raw } = await params;
  const fingerprint = decoded(raw);
  const query = await searchParams;

  return (
    <div
      data-testid="planner-findings-group-page"
      className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6"
    >
      <Link
        href={groupBackHref(query)}
        className="inline-flex min-h-11 w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline md:min-h-0"
      >
        <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
        {t('group.back')}
      </Link>
      <h1 className="font-serif text-2xl text-(--el-text)">{t('group.title')}</h1>

      {/* After the gate, so the frame can never fix a status; no loading.tsx. */}
      <Suspense
        key={JSON.stringify(query)}
        fallback={
          <FindingsSkeleton title={t('group.findingsHeading')} label={t('loading.label')} />
        }
      >
        <GroupSection principal={principal} fingerprint={fingerprint} params={query} />
      </Suspense>
    </div>
  );
}

/** The route segment as motir-ai stored it; a malformed escape is taken as written. */
function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function GroupSection({
  principal,
  fingerprint,
  params,
}: {
  principal: PlatformPrincipal;
  fingerprint: string;
  params: SearchParams;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const filters = toListFilters(params);

  let group: PlannerFindingGroupRowDTO | null;
  let list: PlannerFindingListDTO;
  try {
    [group, list] = await Promise.all([
      plannerFindingsService.getGroup(principal, fingerprint, filters),
      plannerFindingsService.listGroupFindings(principal, fingerprint, filters),
    ]);
  } catch (err) {
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] planner finding group could not be read', err);
    return <FindingsUnavailable />;
  }

  const { cursor, trail, pageNumber } = pagerPosition(params);
  const showPager = pageNumber > 1 || list.nextCursor !== null;
  const basePath = groupHref(fingerprint, {});

  return (
    <div className="flex flex-col gap-4">
      {group ? (
        <p
          data-testid="planner-findings-group-summary"
          className="flex flex-wrap items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
        >
          <code className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs break-all text-(--el-text-identifier)">
            {group.latest.site}
          </code>
          <span>
            {t('group.summary', { findings: group.findingCount, plans: group.planCount })}
          </span>
        </p>
      ) : null}
      <Card
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">
            {t('group.findingsHeading')}
          </h2>
        }
      >
        <div className="flex flex-col gap-4">
          {list.findings.length > 0 ? (
            <FindingsTable rows={list.findings} caption={t('group.findingsHeading')} />
          ) : (
            <EmptyState
              data-testid="planner-findings-group-empty"
              icon={<ScanSearch />}
              title={t('group.empty')}
            />
          )}
          {showPager ? (
            <FindingsPager
              basePath={basePath}
              params={params}
              pageNumber={pageNumber}
              trail={trail}
              cursor={cursor}
              nextCursor={list.nextCursor}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
