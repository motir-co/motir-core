'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { CreditCard, RotateCcw, Zap } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Spinner } from '@/components/ui/Spinner';
import type { ProductionUsageDto } from '@/lib/dto/productionUsage';
import { usageUnitWords } from '@/lib/hosting/productionUsageWords';

// USAGE — "Usage this period" (Story MOTIR-9799 · MOTIR-12110;
// `design/hosting/design-notes.md` § Usage and panels 13, 19–21): this period's
// usage per unit in its human measure, the credits for each, the credits charged,
// and — when the organisation's balance is below zero — the credits-exhausted
// box. Quantities and credits only: Motir's own cost never reaches the page.

/** The organisation's billing page, where credits are topped up. */
export const TOP_UP_HREF = '/settings/organization/billing';

export type UsageView =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; usage: ProductionUsageDto };

const DAY_MS = 86_400_000;

export function ProductionUsage({
  view,
  isAdministrator,
  onRetry,
}: {
  view: UsageView;
  isAdministrator: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('settings.production.usage');
  const format = useFormatter();
  const usage = view.kind === 'ready' ? view.usage : null;

  // The period runs to the last charged day: yesterday in UTC, never before the
  // period's first day.
  const periodLabel = (() => {
    if (!usage) return null;
    const start = new Date(usage.period.start);
    const today = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    const lastEnd = Math.min(new Date(usage.period.end).getTime(), today) - DAY_MS;
    const last = new Date(Math.max(start.getTime(), lastEnd));
    return format.dateTimeRange(start, last, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  })();

  const number = (value: number) => format.number(value, { maximumFractionDigits: 2 });
  const exhausted = usage?.state === 'credits_exhausted' ? usage.exhausted : null;

  return (
    <Card data-testid="production-usage">
      <section className="flex flex-col gap-3" aria-labelledby="production-usage-heading">
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="production-usage-heading"
            className="font-serif text-lg font-semibold text-(--el-text)"
          >
            {t('heading')}
          </h2>
          {periodLabel ? (
            <span
              className="font-sans text-xs text-(--el-text-secondary)"
              data-testid="production-usage-period"
            >
              {periodLabel}
            </span>
          ) : null}
        </div>

        {view.kind === 'loading' ? (
          <span
            aria-busy="true"
            className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
          >
            <Spinner size="sm" aria-hidden />
            {t('loading')}
          </span>
        ) : null}

        {view.kind === 'failed' ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="font-sans text-sm text-(--el-text)">{t('loadError')}</p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
              onClick={onRetry}
            >
              {t('retry')}
            </Button>
          </div>
        ) : null}

        {exhausted ? (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-peach) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12)"
            data-testid="production-credits-exhausted"
          >
            <p className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text-strong)">
              <CreditCard className="size-4 shrink-0" aria-hidden />
              {exhausted.balance === null
                ? t('exhausted.titleNoBalance')
                : t('exhausted.title', { balance: format.number(exhausted.balance) })}
            </p>
            <p className="font-sans text-sm text-(--el-text-strong)">
              {exhausted.graceStopsAt
                ? t('exhausted.bodyGrace', {
                    date: format.dateTime(new Date(exhausted.graceStopsAt), {
                      dateStyle: 'medium',
                    }),
                  })
                : !exhausted.canSuspend
                  ? t('exhausted.bodyCannotSuspend')
                  : exhausted.suspendsAt
                    ? t('exhausted.body', {
                        date: format.dateTime(new Date(exhausted.suspendsAt), {
                          day: 'numeric',
                          month: 'short',
                          timeZone: 'UTC',
                        }),
                      })
                    : t('exhausted.bodySuspended')}
            </p>
            {isAdministrator ? (
              <div>
                <Link
                  href={TOP_UP_HREF}
                  className={`${buttonVariants({ variant: 'primary', size: 'sm' })} gap-1.5`}
                  data-testid="production-top-up"
                >
                  <Zap className="size-3.5" aria-hidden />
                  {t('exhausted.topUp')}
                </Link>
              </div>
            ) : (
              <p className="font-sans text-xs text-(--el-text-strong)">{t('exhausted.member')}</p>
            )}
          </div>
        ) : null}

        {usage && usage.usage.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('noRelease')}</p>
        ) : null}

        {usage && usage.usage.length > 0 ? (
          <>
            <table className="w-full border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border)">
                  <th className="py-(--spacing-control-y-4) text-left text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                    {t('col.what')}
                  </th>
                  <th className="py-(--spacing-control-y-4) text-right text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                    {t('col.amount')}
                  </th>
                  <th className="py-(--spacing-control-y-4) text-right text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                    {t('col.credits')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.usage.map((line) => {
                  const words = usageUnitWords(line.unit, line.quantity);
                  return (
                    <tr
                      key={line.unit}
                      className="border-b border-(--el-border-soft)"
                      data-testid="production-usage-row"
                      data-unit={line.unit}
                    >
                      <td className="py-(--spacing-control-y-8) text-(--el-text)">
                        {t(words.labelKey, {
                          size: words.sizeKey ? t(words.sizeKey) : '',
                          provider: words.provider ?? '',
                        })}
                      </td>
                      <td className="py-(--spacing-control-y-8) text-right font-mono text-xs text-(--el-text)">
                        {t(words.amountKey, { value: number(words.amount) })}
                      </td>
                      <td className="py-(--spacing-control-y-8) text-right font-mono text-xs text-(--el-text)">
                        {number(line.credits)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td
                    className="py-(--spacing-control-y-8) font-semibold text-(--el-text)"
                    colSpan={2}
                  >
                    {t('total')}
                  </td>
                  <td
                    className="py-(--spacing-control-y-8) text-right font-mono text-sm font-semibold text-(--el-text)"
                    data-testid="production-usage-total"
                  >
                    {format.number(usage.credits)}
                  </td>
                </tr>
              </tfoot>
            </table>
            <p className="font-sans text-xs text-(--el-text-secondary)">{t('footnote')}</p>
          </>
        ) : null}
      </section>
    </Card>
  );
}
