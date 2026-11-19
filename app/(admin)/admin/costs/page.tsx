import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Clock, Info, RefreshCw, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { CostsPageDTO, CostsRowDTO, CostsView } from '@/lib/dto/platformCosts';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { parseCostsView, utcDayOf } from '@/lib/platform/costs';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformReadService } from '@/lib/services/platformReadService';
import { formatMicroUsd } from '../_components/spendFormat';
import { CostRow } from './_components/CostRow';
import {
  CostsDrillDown,
  EM_DASH,
  minus,
  type CostsDrillDownLabels,
} from './_components/CostsDrillDown';
import { CostsPeriodControls } from './_components/CostsPeriodControls';
import { CostsUnavailable } from './_components/CostsUnavailable';

/**
 * Costs — design `platform-admin/console--costs.mock.html` (MOTIR-11711), built by
 * MOTIR-11712.
 *
 * What running Motir cost: the AWS bill (Cost Explorer, as the 6-hourly fetch job
 * stored it — the page never calls Cost Explorer) beside the model cost motir-ai
 * recorded, by day, month or year. One audited `estate.read` per view
 * (`platformReadService.getCosts`); each source fails on its own.
 *
 * The header renders at once; the figures and rows stream in behind an in-page
 * Suspense whose fallback is the design's Loading panel.
 */

export const metadata: Metadata = {
  // No description — the console's standing rule (see the landing page).
  title: 'Costs',
};

/** Never cached: today's figures move with every charge and every fetch. */
export const dynamic = 'force-dynamic';

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.costs'>>>;
type Formatter = Awaited<ReturnType<typeof getFormatter>>;

/** A table cell's own box (design: `px-(--spacing-control-x-12) py-(--spacing-control-y-8)`). */
const CELL = 'px-(--spacing-control-x-12) py-(--spacing-control-y-8)';
function viewKey(view: CostsView): string {
  return view.kind === 'day'
    ? `day-${view.month}`
    : view.kind === 'month'
      ? `month-${view.year}`
      : 'year';
}

export default async function AdminCostsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string; year?: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.costs');
  const format = await getFormatter();
  const now = new Date();
  const today = utcDayOf(now);
  const view = parseCostsView(await searchParams, today);

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      <Suspense
        key={viewKey(view)}
        fallback={
          <>
            <Toolbar
              t={t}
              format={format}
              view={view}
              today={today}
              options={[view.kind === 'day' ? view.month : view.kind === 'month' ? view.year : '']}
              fetchedAt={null}
            />
            <CostsLoading label={t('loading')} />
          </>
        }
      >
        <CostsContent principal={principal} view={view} now={now} />
      </Suspense>
    </div>
  );
}

async function CostsContent({
  principal,
  view,
  now,
}: {
  principal: PlatformPrincipal;
  view: CostsView;
  now: Date;
}) {
  const t = await getTranslations('platformAdmin.costs');
  const format = await getFormatter();
  const costs = await platformReadService.getCosts(principal, view, now);
  const range = rangeLabel(t, format, view);

  return (
    <>
      <Toolbar
        t={t}
        format={format}
        view={view}
        today={costs.today}
        options={costs.options}
        fetchedAt={costs.awsFetchedAt}
      />
      {!costs.awsAvailable && !costs.modelsAvailable ? (
        <CostsUnavailable
          testId="costs-unavailable-both"
          title={t('bothError.title')}
          description={t('bothError.description')}
          retryLabel={t('retry')}
        />
      ) : costs.empty ? (
        <Card data-testid="costs-empty">
          <div className="flex items-start gap-3">
            <Wallet aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" />
            <div className="flex flex-col gap-1">
              <p className="font-sans text-sm font-semibold text-(--el-text)">
                {t('empty.title', { range })}
              </p>
              <p className="font-sans text-sm text-(--el-text-secondary)">{t('empty.body')}</p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <RangeFigures t={t} format={format} costs={costs} range={range} />
          {!costs.awsAvailable ? (
            <CostsUnavailable
              testId="costs-unavailable-aws"
              title={t('awsError.title')}
              description={t('awsError.description')}
              retryLabel={t('retry')}
            />
          ) : null}
          {!costs.modelsAvailable ? (
            <CostsUnavailable
              testId="costs-unavailable-models"
              title={t('modelsError.title')}
              description={t('modelsError.description')}
              retryLabel={t('retry')}
            />
          ) : null}
          <CostRows t={t} format={format} costs={costs} />
        </>
      )}
    </>
  );
}

function monthLabel(format: Formatter, month: string): string {
  return format.dateTime(new Date(`${month}-01T00:00:00Z`), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function rangeLabel(t: T, format: Formatter, view: CostsView): string {
  if (view.kind === 'day') return monthLabel(format, view.month);
  if (view.kind === 'month') return view.year;
  return t('figures.allYears');
}

function periodLabel(format: Formatter, view: CostsView, period: string): string {
  if (view.kind === 'day') {
    return format.dateTime(new Date(`${period}T00:00:00Z`), {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  if (view.kind === 'month') return monthLabel(format, period);
  return period;
}

function Toolbar({
  t,
  format,
  view,
  today,
  options,
  fetchedAt,
}: {
  t: T;
  format: Formatter;
  view: CostsView;
  today: string;
  options: string[];
  fetchedAt: string | null;
}) {
  const showing =
    view.kind === 'day'
      ? t('showing.day', { month: monthLabel(format, view.month) })
      : view.kind === 'month'
        ? t('showing.month', { year: view.year })
        : t('showing.year');
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-1">
        <p className="font-sans text-sm text-(--el-text-secondary)" aria-live="polite">
          {showing}
        </p>
        {fetchedAt ? (
          <p
            className="flex items-center gap-1 font-sans text-xs text-(--el-text-secondary)"
            data-testid="costs-aws-fetched"
          >
            <RefreshCw aria-hidden className="h-3 w-3 text-(--el-info)" />
            {t('fetched', {
              time: format.dateTime(new Date(fetchedAt), {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
                timeZone: 'UTC',
              }),
            })}
          </p>
        ) : null}
      </div>
      <CostsPeriodControls
        view={view}
        today={today}
        options={options.map((value) => ({
          value,
          label: view.kind === 'day' ? monthLabel(format, value) : value,
        }))}
        labels={{
          group: t('period.label'),
          day: t('period.day'),
          month: t('period.month'),
          year: t('period.year'),
          pickMonth: t('picker.month'),
          pickYear: t('picker.year'),
        }}
      />
    </div>
  );
}

/** A figure, or the em dash that says there is none. */
function Figure({
  t,
  format,
  micro,
  className,
}: {
  t: T;
  format: Formatter;
  micro: number | null;
  className: string;
}) {
  if (micro === null) {
    return (
      <span
        className={`${className} text-(--el-text-secondary)`}
        aria-label={t('figures.unavailable')}
      >
        {EM_DASH}
      </span>
    );
  }
  return (
    <span className={`${className} tabular-nums text-(--el-text)`}>
      {minus(formatMicroUsd(format, micro))}
    </span>
  );
}

function RangeFigures({
  t,
  format,
  costs,
  range,
}: {
  t: T;
  format: Formatter;
  costs: CostsPageDTO;
  range: string;
}) {
  const sub = costs.totals.partial ? t('figures.soFar', { range }) : range;
  const figures = [
    { key: 'aws', micro: costs.totals.awsMicroUsd, available: costs.awsAvailable },
    { key: 'models', micro: costs.totals.modelsMicroUsd, available: costs.modelsAvailable },
    {
      key: 'total',
      micro: costs.totals.totalMicroUsd,
      available: costs.awsAvailable && costs.modelsAvailable,
    },
  ] as const;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {figures.map((f) => (
        <Card key={f.key} data-testid={`costs-figure-${f.key}`}>
          <div className="flex flex-col gap-1">
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {t(`figures.${f.key}`)}
            </span>
            <Figure
              t={t}
              format={format}
              micro={f.micro}
              className="font-sans text-xl font-semibold"
            />
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {f.available ? sub : t('figures.unavailable')}
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}

function CostRows({ t, format, costs }: { t: T; format: Formatter; costs: CostsPageDTO }) {
  const { view } = costs;
  const drillLabels: CostsDrillDownLabels = {
    aws: t('breakdown.aws'),
    models: t('breakdown.models'),
    service: t('breakdown.service'),
    provider: t('breakdown.provider'),
    amount: t('breakdown.amount'),
    share: t('breakdown.share'),
    tax: t('breakdown.tax'),
    credits: t('breakdown.credits'),
    refund: t('breakdown.refund'),
  };
  return (
    <section aria-labelledby="costs-rows" className="flex flex-col gap-2">
      <h2 id="costs-rows" className="font-sans text-sm font-semibold text-(--el-text)">
        {t(`rows.${view.kind}`)}
      </h2>
      <Card className="overflow-x-auto p-0">
        <table className="w-full font-sans text-sm" data-testid="costs-rows">
          <thead>
            <tr className="text-left text-xs text-(--el-text-secondary)">
              <th scope="col" className={`${CELL} font-medium`}>
                {t(`col.${view.kind}`)}
              </th>
              <th scope="col" className={`${CELL} text-right font-medium`}>
                {t('col.aws')}
              </th>
              <th scope="col" className={`${CELL} text-right font-medium`}>
                {t('col.models')}
              </th>
              <th scope="col" className={`${CELL} text-right font-medium`}>
                {t('col.total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {costs.rows.map((row) => {
              const label = periodLabel(format, view, row.period);
              return (
                <CostRow
                  key={row.period}
                  period={row.period}
                  periodLabel={label}
                  openLabel={t('open', { period: label })}
                  partial={row.partial}
                  cellClassName={CELL}
                  mark={
                    row.partial ? (
                      <Pill tone="neutral" data-testid="costs-partial">
                        <Clock aria-hidden className="h-3 w-3" />
                        {t('partial')}
                      </Pill>
                    ) : null
                  }
                  cells={<RowCells t={t} format={format} row={row} />}
                  drillDown={
                    <CostsDrillDown
                      format={format}
                      row={row}
                      awsAvailable={costs.awsAvailable}
                      modelsAvailable={costs.modelsAvailable}
                      labels={drillLabels}
                    />
                  }
                />
              );
            })}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function RowCells({ t, format, row }: { t: T; format: Formatter; row: CostsRowDTO }) {
  return (
    <>
      <td className={`${CELL} text-right`}>
        <span className="flex flex-col items-end gap-1">
          <Figure t={t} format={format} micro={row.awsMicroUsd} className="" />
          {row.estimate ? (
            <Pill severity="info" data-testid="costs-estimate">
              <Info aria-hidden className="h-3 w-3" />
              {t('estimate')}
            </Pill>
          ) : null}
        </span>
      </td>
      <td className={`${CELL} text-right`}>
        <Figure t={t} format={format} micro={row.modelsMicroUsd} className="" />
      </td>
      <td className={`${CELL} text-right`}>
        <Figure t={t} format={format} micro={row.totalMicroUsd} className="font-semibold" />
      </td>
    </>
  );
}

/** The design's Loading panel: three figure bars and six row bars pulse. */
function CostsLoading({ label }: { label: string }) {
  const bar = 'rounded-(--radius-control) bg-(--el-muted)';
  return (
    <div
      aria-busy="true"
      className="flex flex-col gap-4 motion-safe:animate-pulse"
      data-testid="costs-loading"
    >
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <div className="flex flex-col gap-2">
              <div className={`${bar} h-3 w-16`} />
              <div className={`${bar} h-6 w-28`} />
            </div>
          </Card>
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-2">
        <div className={`${bar} h-4 w-20`} />
        <Card className="p-0">
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className={`flex items-center justify-between gap-6 border-t border-(--el-border) ${CELL} first:border-t-0`}
              >
                <div className={`${bar} h-4 w-24`} />
                <div className="flex gap-6">
                  <div className={`${bar} h-4 w-20`} />
                  <div className={`${bar} h-4 w-20`} />
                  <div className={`${bar} h-4 w-20`} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
