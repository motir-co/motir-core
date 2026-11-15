import { getLocale, getTranslations } from 'next-intl/server';
import { ExternalLink, Route, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { ModelServingEntryDTO } from '@/lib/dto/platformModelServing';
import { CardHead, InsetState, Mono, Sub, Td, Th } from '../../monitoring/_components/FleetSection';
import { ModelServingChange } from './ModelServingChange';
import { priceDiff, servingOf, shortDate, usd, type PriceDiff } from './servingFormat';

/**
 * THE MODEL SERVING LIST (MOTIR-11280; design `platform-admin/design-notes.md`
 * § Model serving, `model-serving.mock.html` Panels 1, 2, 4 and 6).
 *
 * One row per model two or more providers sell: the original provider and the
 * price everyone is charged, who serves it now and what that costs Motir. The
 * rows are server-rendered; the Change dialog is the one client island, and its
 * action `revalidatePath`s the page so a save re-reads the whole list.
 *
 * ⚠️ The missing Action column is presentation: the action and the service both
 * re-check `superadmin`.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.modelServing'>>>;

export function diffText(
  t: (key: string, values?: Record<string, number>) => string,
  d: PriceDiff,
): string | null {
  if (d.kind === 'unknown') return null;
  if (d.kind === 'same') return t('diff.same');
  return t(`diff.${d.kind}`, { input: d.input, output: d.output });
}

export async function ModelServingTable({
  entries,
  canChange,
}: {
  entries: ModelServingEntryDTO[];
  canChange: boolean;
}) {
  const t = await getTranslations('platformAdmin.modelServing');
  const locale = await getLocale();
  const head = (
    <CardHead
      icon={<Route className="h-4 w-4" />}
      title={t('card.title')}
      subtitle={t('card.subtitle', { count: entries.length })}
      pills={null}
    />
  );

  if (entries.length === 0) {
    return (
      <Card data-testid="model-serving-list" data-state="empty" header={head}>
        <InsetState icon={<Route className="h-5 w-5" />} title={t('empty.title')}>
          {t('empty.body')}
        </InsetState>
      </Card>
    );
  }

  return (
    <Card data-testid="model-serving-list" header={head}>
      <div className="flex flex-col gap-3">
        {canChange ? null : (
          <p
            data-testid="model-serving-read-only"
            className="font-sans text-xs text-(--el-text-secondary)"
          >
            {t('readOnly')}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left font-sans text-sm">
            <thead>
              <tr>
                <Th scope="col">{t('col.model')}</Th>
                <Th scope="col">{t('col.original')}</Th>
                <Th scope="col">{t('col.charged')}</Th>
                <Th scope="col">{t('col.servedBy')}</Th>
                <Th scope="col">{t('col.cost')}</Th>
                {canChange ? <Th scope="col">{t('col.action')}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <Row key={entry.model} entry={entry} canChange={canChange} t={t} locale={locale} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function Row({
  entry,
  canChange,
  t,
  locale,
}: {
  entry: ModelServingEntryDTO;
  canChange: boolean;
  t: T;
  locale: string;
}) {
  const { wanted, wantedChannel, serving, fallingBack } = servingOf(entry);
  const wantedName = wantedChannel?.providerName ?? wanted;
  const perMTok = (p: { input: number; output: number | null }) =>
    t('perMTok', { input: usd(p.input, locale), output: usd(p.output, locale) });
  const cost = serving?.cost ?? null;
  const diff = diffText(t as never, priceDiff(cost, entry.charged));

  return (
    <tr
      data-testid={`model-serving-row-${entry.model}`}
      className="border-t border-(--el-border-soft)"
    >
      <Td rail={fallingBack ? 'warning' : undefined}>
        <span className="font-medium text-(--el-text)">{entry.modelName}</span>
        <Sub>
          <Mono>{entry.model}</Mono>
        </Sub>
      </Td>
      <Td>
        <span className="text-(--el-text)">{entry.originName}</span>
      </Td>
      <Td>
        <span className="whitespace-nowrap tabular-nums text-(--el-text)">
          {perMTok(entry.charged)}
        </span>
        <Sub>{t('plusMargin')}</Sub>
        <span className="mt-0.5 block">
          <a
            href={entry.priceSource.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-(--el-link) underline underline-offset-2"
          >
            {entry.priceSource.host}
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
          <Sub>{t('source.read', { date: shortDate(entry.priceSource.readDate, locale) })}</Sub>
        </span>
      </Td>
      <Td>
        <span className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              wantedChannel?.enabled ? 'bg-(--el-success)' : 'bg-(--el-border-strong)'
            }`}
          />
          <span className="text-(--el-text)">{wantedName}</span>
          {entry.selected === null ? <Pill tone="neutral">{t('default')}</Pill> : null}
        </span>
        {wantedChannel ? (
          <Sub>
            {t(wantedChannel.enabled ? 'channelEnabled' : 'channelDisabled', {
              name: wantedChannel.channelName,
            })}
          </Sub>
        ) : null}
        {entry.selected !== null && entry.selectedBy && entry.selectedAt ? (
          <span className="mt-0.5 block max-w-[12rem] text-xs text-(--el-text-secondary)">
            {t('chosen', { who: entry.selectedBy, date: shortDate(entry.selectedAt, locale) })}
          </span>
        ) : null}
        {fallingBack && serving ? (
          <span className="mt-1 flex">
            <Pill severity="warning" data-testid={`model-serving-fallback-${entry.model}`}>
              <TriangleAlert aria-hidden className="h-3 w-3" />
              {t('fallingBack', { provider: serving.providerName })}
            </Pill>
          </span>
        ) : null}
      </Td>
      <Td>
        <span className="whitespace-nowrap tabular-nums text-(--el-text)">
          {cost ? perMTok(cost) : '—'}
        </span>
        {diff ? (
          <span className="mt-0.5 block max-w-[14rem] text-xs text-(--el-text-secondary)">
            {diff}
          </span>
        ) : null}
        {fallingBack && serving ? (
          <span className="mt-0.5 block max-w-[14rem] text-xs text-(--el-text-secondary)">
            {t('fallingBackBody', { selected: wantedName, provider: serving.providerName })}
          </span>
        ) : null}
      </Td>
      {canChange ? (
        <Td>
          <ModelServingChange entry={entry} />
        </Td>
      ) : null}
    </tr>
  );
}
