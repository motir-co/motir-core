import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/ErrorState';
import type { RawPlatformModelFigures } from '@/lib/ai/motirAiClient';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { buildSpendSheet, parseSpendPeriod, recentMonths } from '@/lib/platform/spend';
import { platformReadService } from '@/lib/services/platformReadService';
import { SpendPeriodSwitch } from '../_components/SpendPeriodSwitch';
import { formatMicroUsd, formatUsage } from '../_components/spendFormat';
import { ProviderReconciliationSection } from './_components/ProviderReconciliationSection';

/**
 * Usage & cost — design `platform-admin/console--estate-usage-drilldown.mock.html`
 * **D3** (a month) and **D4** (All time), MOTIR-732.
 *
 * The estate AS A WHOLE for one period: four figures, the eight categories with
 * usage, credits and Motir cost (indexing *not charged*), and planning and
 * agent-run tokens by model. The per-organization list is Tenants (D10). Every
 * number is motir-ai's platform rollup, read through one audited `estate.read`.
 *
 * Below the sheets, the month's PROVIDER BILLS (MOTIR-11376, design MOTIR-11375's
 * delta mock `…--provider-bills.mock.html`): what each provider billed beside what
 * Motir recorded, per UTC day. Read by the same `getEstateUsage` call, so the view
 * stays one audited read; it renders even when the sheets' read failed.
 */

export const metadata: Metadata = {
  // No description — the console's standing rule (see the landing page).
  title: 'Usage & cost',
};

/** Never cached: this month's figures move with every charge. */
export const dynamic = 'force-dynamic';

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.usage');
  const format = await getFormatter();
  const period = parseSpendPeriod((await searchParams).period);
  const { usage, reconciliation } = await platformReadService.getEstateUsage(principal, period);

  const monthLabel = (ym: string) =>
    format.dateTime(new Date(`${ym}-01T00:00:00Z`), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const periodLabel = period === 'all' ? t('period.allTime') : monthLabel(period);
  const units = {
    tokens: t('units.tokens'),
    minutes: t('units.minutes'),
    gbDays: t('units.gbDays'),
    searches: t('units.searches'),
  };
  const money = (micro: number) => formatMicroUsd(format, micro);

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-sans text-sm text-(--el-text-secondary)" aria-live="polite">
          {t('showing', { period: periodLabel })}
        </p>
        <SpendPeriodSwitch
          period={period}
          months={recentMonths().map((value) => ({ value, label: monthLabel(value) }))}
          labels={{
            month: t('period.month'),
            allTime: t('period.allTime'),
            group: t('period.label'),
          }}
        />
      </div>

      {!usage ? (
        <ErrorState title={t('unavailable.title')} description={t('unavailable.description')} />
      ) : (
        <UsageSheets
          usage={usage}
          t={t}
          money={money}
          usageText={(unit, v) => formatUsage(format, unit, v, units)}
          num={(n) => format.number(n)}
        />
      )}

      <ProviderReconciliationSection reconciliation={reconciliation} period={period} />
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.usage'>>>;

function UsageSheets({
  usage,
  t,
  money,
  usageText,
  num,
}: {
  usage: NonNullable<Awaited<ReturnType<typeof platformReadService.getEstateUsage>>['usage']>;
  t: T;
  money: (micro: number) => string;
  usageText: (unit: Parameters<typeof formatUsage>[1], value: number) => string;
  num: (n: number) => string;
}) {
  const sheet = buildSpendSheet(usage.categories);
  const figures = [
    { key: 'charged', value: `${num(sheet.chargedCredits)} ${t('units.credits')}` },
    { key: 'cost', value: money(sheet.costMicroUsdInclIndexing) },
    {
      key: 'machine',
      value: `${num(Math.round(usage.spend.machineSeconds / 60))} ${t('units.minutes')}`,
    },
    { key: 'orgs', value: num(usage.orgsWithSpend ?? 0) },
  ] as const;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {figures.map((f) => (
          <Card key={f.key} data-testid={`usage-figure-${f.key}`}>
            <div className="flex flex-col gap-1">
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {t(`figures.${f.key}`)}
              </span>
              <span className="font-sans text-xl font-semibold tabular-nums text-(--el-text)">
                {f.value}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <section aria-labelledby="usage-by-category" className="flex flex-col gap-2">
        <h2 id="usage-by-category" className="font-sans text-sm font-semibold text-(--el-text)">
          {t('categories.title')}
        </h2>
        <Card className="overflow-x-auto p-0">
          <table className="w-full font-sans text-sm" data-testid="usage-categories">
            <thead>
              <tr className="text-left text-xs text-(--el-text-secondary)">
                <th className="px-3 py-2 font-medium">{t('categories.category')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('categories.usage')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('categories.credits')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('categories.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <tr
                  key={row.category}
                  data-category={row.category}
                  className="border-t border-(--el-border)"
                >
                  <td className="px-3 py-2 text-(--el-text)">{t(`category.${row.category}`)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-(--el-text-secondary)">
                    {usageText(row.unit, row.usage)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-(--el-text)">
                    {row.credits === null ? (
                      <span className="text-(--el-text-secondary)">
                        {t('categories.notCharged')}
                      </span>
                    ) : (
                      num(row.credits)
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-(--el-text)">
                    {money(row.costMicroUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr
                className="border-t-2 border-(--el-border) font-semibold"
                data-testid="usage-total-charged"
              >
                <td className="px-3 py-2 text-(--el-text)">{t('categories.chargedTotal')}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right tabular-nums text-(--el-text)">
                  {num(sheet.chargedCredits)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-(--el-text)">
                  {money(sheet.chargedCostMicroUsd)}
                </td>
              </tr>
              <tr className="border-t border-(--el-border)" data-testid="usage-total-incl-indexing">
                <td className="px-3 py-2 text-(--el-text)">{t('categories.totalInclIndexing')}</td>
                <td className="px-3 py-2" />
                <td className="px-3 py-2" />
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-(--el-text)">
                  {money(sheet.costMicroUsdInclIndexing)}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>
      </section>

      {(['planning_tokens', 'agent_tokens'] as const).map((category) => (
        <ModelTable
          key={category}
          category={category}
          models={usage.models[category]}
          t={t}
          money={money}
          num={num}
        />
      ))}
    </>
  );
}

function ModelTable({
  category,
  models,
  t,
  money,
  num,
}: {
  category: 'planning_tokens' | 'agent_tokens';
  models: RawPlatformModelFigures[];
  t: T;
  money: (micro: number) => string;
  num: (n: number) => string;
}) {
  const id = `usage-models-${category}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="font-sans text-sm font-semibold text-(--el-text)">
        {t(`models.title.${category}`)}
      </h2>
      {models.length === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('models.empty')}</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full font-sans text-sm" data-testid={id}>
            <thead>
              <tr className="text-left text-xs text-(--el-text-secondary)">
                <th className="px-3 py-2 font-medium">{t('models.model')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.input')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.output')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.cacheRead')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.cacheWrite')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.orgs')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.credits')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('models.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model} className="border-t border-(--el-border)">
                  <td className="px-3 py-2 font-mono text-xs text-(--el-text)">{m.model}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.inputTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.outputTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.cacheReadTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.cacheWriteTokens)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {m.orgs === null ? '—' : num(m.orgs)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.credits)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(m.costMicroUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
