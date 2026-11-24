import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { RawMonthFigures, RawPlatformUsageMonths } from '@/lib/ai/motirAiClient';
import { SPEND_CATEGORIES } from '@/lib/platform/spend';
import { formatMicroUsd } from '../../../_components/spendFormat';

/**
 * MONTH BY MONTH (MOTIR-7293, design D8/D11): every month newest first × every
 * category's credits (indexing as minutes), the charged total and Motir cost, then
 * the ALL-TIME row. A month row sets the tab's period to that month (URL).
 */
export async function MonthTable({
  months,
  hrefFor,
  olderHref,
  newestHref,
  currentPeriod,
}: {
  months: RawPlatformUsageMonths;
  /** The tab's URL with `period` set to the given month. */
  hrefFor: (period: string) => string;
  olderHref: string | null;
  newestHref: string | null;
  currentPeriod: string;
}) {
  const t = await getTranslations('platformAdmin.orgUsage.months');
  const tc = await getTranslations('platformAdmin.usage.category');
  const format = await getFormatter();
  const label = (ym: string) =>
    format.dateTime(new Date(`${ym}-01T00:00:00Z`), {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const cells = (m: RawMonthFigures) => (
    <>
      {SPEND_CATEGORIES.map((c) => (
        <td key={c} className="px-2 py-1 text-right tabular-nums">
          {c === 'indexing'
            ? format.number(m.categories[c].usageQuantity / 60, { maximumFractionDigits: 0 })
            : format.number(m.categories[c].credits)}
        </td>
      ))}
      <td className="px-2 py-1 text-right font-semibold tabular-nums">
        {format.number(m.spend.chargedCredits)}
      </td>
      <td className="px-2 py-1 text-right font-semibold tabular-nums">
        {formatMicroUsd(format, m.spend.costMicroUsdInclIndexing)}
      </td>
    </>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-sans text-sm" data-testid="org-usage-months">
        <thead>
          <tr className="text-left text-xs text-(--el-text-secondary)">
            <th className="px-2 py-2 font-medium">{t('month')}</th>
            {SPEND_CATEGORIES.map((c) => (
              <th key={c} className="px-2 py-2 text-right font-medium">
                {c === 'indexing' ? t('indexingMinutes') : tc(c)}
              </th>
            ))}
            <th className="px-2 py-2 text-right font-medium">{t('charged')}</th>
            <th className="px-2 py-2 text-right font-medium">{t('cost')}</th>
          </tr>
        </thead>
        <tbody>
          {months.items.length === 0 ? (
            <tr>
              <td
                colSpan={SPEND_CATEGORIES.length + 3}
                className="px-2 py-2 text-(--el-text-secondary)"
              >
                {t('empty')}
              </td>
            </tr>
          ) : null}
          {months.items.map((m) => (
            <tr
              key={m.period}
              className={`border-t border-(--el-border) ${m.period === currentPeriod ? 'bg-(--el-surface)' : ''}`}
              data-month={m.period}
            >
              <td className="px-2 py-1">
                <Link
                  href={hrefFor(m.period)}
                  aria-current={m.period === currentPeriod ? 'true' : undefined}
                  className="text-(--el-text) hover:underline"
                >
                  {label(m.period)}
                </Link>
              </td>
              {cells(m)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr
            className="border-t-2 border-(--el-border) font-semibold"
            data-testid="org-usage-months-all-time"
          >
            <td className="px-2 py-1">
              <Link href={hrefFor('all')} className="hover:underline">
                {t('allTime')}
              </Link>
            </td>
            {cells(months.allTime)}
          </tr>
        </tfoot>
      </table>
      {olderHref || newestHref ? (
        <div className="flex gap-3 px-2 py-1 font-sans text-xs">
          {newestHref ? (
            <Link href={newestHref} className="text-(--el-accent-on-surface) hover:underline">
              {t('newest')}
            </Link>
          ) : null}
          {olderHref ? (
            <Link href={olderHref} className="text-(--el-accent-on-surface) hover:underline">
              {t('older')}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
