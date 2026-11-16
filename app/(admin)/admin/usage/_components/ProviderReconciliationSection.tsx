import { getFormatter, getTranslations } from 'next-intl/server';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ChevronDown,
  Info,
  ReceiptText,
  TriangleAlert,
  Unplug,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type {
  EstateReconciliationResult,
  ProviderReconciliationDayDTO,
  ProviderReconciliationDTO,
  ProviderReconciliationProviderDTO,
} from '@/lib/dto/platform';
import { providerDisplayName } from '@/lib/models/displayNames';
import { formatMicroUsd } from '../../_components/spendFormat';
import { ReconciliationDayRow } from './ReconciliationDayRow';
import { ReconciliationUnavailable } from './ReconciliationUnavailable';

/**
 * Usage & cost's PROVIDER BILLS section (MOTIR-11376) — design
 * `platform-admin/console--estate-usage-drilldown--provider-bills.mock.html`
 * (MOTIR-11375; `design-notes.md` § AMENDMENT 2026-11-15 — Usage & cost ·
 * Provider bills).
 *
 * Read-only. Every per-day figure, status, source and verdict is motir-ai's, as
 * `toProviderReconciliationDTO` carried it; the only arithmetic here is the
 * presentation the design draws over them — a provider's period sums and a
 * per-model line's billed − recorded — never a tolerance or a status.
 *
 * The element names (`data-testid`) are the design's, for the story E2E and the
 * integration gate.
 */

const TH = 'px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-medium';
const TD = 'px-(--spacing-control-x-12) py-(--spacing-control-y-8)';
const DASH = '—';

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.usage.reconciliation'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

interface View {
  t: T;
  money: (micro: number) => string;
  signed: (micro: number) => string;
  num: (n: number) => string;
  dayLabel: (day: string) => string;
  timeLabel: (iso: string) => string;
  monthLabel: (ym: string) => string;
  pct: (r: number) => string;
}

function view(t: T, format: Format): View {
  const money = (micro: number) => formatMicroUsd(format, micro);
  return {
    t,
    money,
    signed: (micro) =>
      micro > 0 ? `+${money(micro)}` : micro < 0 ? `−${money(-micro)}` : money(0),
    num: (n) => format.number(n),
    dayLabel: (day) =>
      format.dateTime(new Date(`${day}T00:00:00Z`), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
    timeLabel: (iso) =>
      format.dateTime(new Date(iso), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'UTC',
      }),
    monthLabel: (ym) =>
      format.dateTime(new Date(`${ym}-01T00:00:00Z`), {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    pct: (r) => format.number(r, { style: 'percent', maximumFractionDigits: 1 }),
  };
}

export async function ProviderReconciliationSection({
  reconciliation,
  period,
}: {
  reconciliation: EstateReconciliationResult;
  /** The page's period: `YYYY-MM` or `all`. */
  period: string;
}) {
  const t = await getTranslations('platformAdmin.usage.reconciliation');
  const v = view(t, await getFormatter());

  let body;
  if (reconciliation === 'month_required') {
    body = (
      <p
        className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
        data-testid="usage-reconciliation-pick-month"
      >
        <Info aria-hidden className="h-4 w-4 text-(--el-info)" />
        {t('allTime')}
      </p>
    );
  } else if (reconciliation === null) {
    body = (
      <ReconciliationUnavailable title={t('error.title')} description={t('error.description')} />
    );
  } else if (reconciliation.providers.every((p) => p.days.every(isUnrecorded))) {
    body = <EmptyMonth v={v} month={reconciliation.period || period} />;
  } else {
    body = <Populated v={v} r={reconciliation} />;
  }

  return (
    <section
      aria-labelledby="usage-provider-bills"
      className="flex flex-col gap-2"
      data-testid="usage-provider-bills"
    >
      <h2 id="usage-provider-bills" className="font-sans text-sm font-semibold text-(--el-text)">
        {t('title')}
      </h2>
      <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('intro')}</p>
      {body}
    </section>
  );
}

/**
 * A closed day the daily job holds NO record for — the route lists it as a failed
 * read with nothing filled in. A month where every day is one has not been
 * reconciled yet, which the design draws as its own empty state.
 */
const isUnrecorded = (d: ProviderReconciliationDayDTO) =>
  d.status === 'failed' &&
  d.source === 'none' &&
  d.recordedMicroUsd === null &&
  d.billedMicroUsd === null &&
  d.readAt === null;

function EmptyMonth({ v, month }: { v: View; month: string }) {
  return (
    <Card data-testid="usage-reconciliation-empty">
      <div className="flex items-start gap-3">
        <ReceiptText aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" />
        <div className="flex flex-col gap-1">
          <p className="font-sans text-sm font-semibold text-(--el-text)">
            {v.t('empty.title', { month: v.monthLabel(month) })}
          </p>
          <p className="font-sans text-sm text-(--el-text-secondary)">{v.t('empty.body')}</p>
        </div>
      </div>
    </Card>
  );
}

/** Open by default: a provider with a day past tolerance or a failed read. */
const needsEyes = (p: ProviderReconciliationProviderDTO) =>
  p.days.some((d) => d.pastTolerance || d.status === 'failed');

function Populated({ v, r }: { v: View; r: ProviderReconciliationDTO }) {
  return (
    <>
      <FindingsList v={v} r={r} />
      <UnreconciledList v={v} providers={r.unreconciledProviders} />
      <div className="flex flex-col gap-3">
        {r.providers.map((p) => (
          <ProviderCard key={p.provider} v={v} p={p} open={needsEyes(p)} />
        ))}
      </div>
    </>
  );
}

function Fig({ v, value }: { v: View; value: number | null }) {
  return value === null ? (
    <span className="text-(--el-text-secondary)" aria-label={v.t('none')}>
      {DASH}
    </span>
  ) : (
    <span className="tabular-nums text-(--el-text)">{v.money(value)}</span>
  );
}

function SourceTag({ v, source }: { v: View; source: ProviderReconciliationDayDTO['source'] }) {
  return (
    <Pill tone="neutral" data-testid="source-tag" data-source={source}>
      {v.t(`source.${source}`)}
    </Pill>
  );
}

function StatusMark({ v, d }: { v: View; d: ProviderReconciliationDayDTO }) {
  if (d.status === 'reconciled') {
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-(--el-text-secondary)"
        data-testid="status-mark"
        data-status="reconciled"
      >
        <CircleCheck aria-hidden className="h-3.5 w-3.5 text-(--el-success)" />
        {v.t('status.reconciled')}
      </span>
    );
  }
  if (d.status === 'failed') {
    return (
      <span
        className="flex flex-col items-start gap-0.5"
        data-testid="status-mark"
        data-status="failed"
      >
        <Pill severity="warning">
          <CircleAlert aria-hidden className="h-3 w-3" />
          {d.recordedMicroUsd === null ? v.t('status.notRecorded') : v.t('status.failed')}
        </Pill>
        {d.readAt ? (
          <span className="whitespace-nowrap text-xs text-(--el-text-secondary)">
            {v.t('status.failedAt', { time: v.timeLabel(d.readAt) })}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-(--el-text-secondary)"
      data-testid="status-mark"
      data-status="unreconciled"
    >
      <CircleDashed aria-hidden className="h-3.5 w-3.5 text-(--el-text-secondary)" />
      {v.t('status.unreconciled')}
    </span>
  );
}

function PastFlag({ v }: { v: View }) {
  return (
    <Pill severity="danger" data-testid="past-tolerance">
      <TriangleAlert aria-hidden className="h-3 w-3" />
      {v.t('pastTolerance')}
    </Pill>
  );
}

function GapCell({ v, d }: { v: View; d: ProviderReconciliationDayDTO }) {
  if (d.gapMicroUsd === null) return <span className="text-(--el-text-secondary)">{DASH}</span>;
  return (
    <span className="flex flex-col items-end gap-1">
      <span
        className={`tabular-nums ${d.pastTolerance ? 'font-semibold' : ''} text-(--el-text)`}
        data-testid="gap"
      >
        {v.signed(d.gapMicroUsd)}
      </span>
      {d.pastTolerance ? <PastFlag v={v} /> : null}
      {d.estimatedRowCount !== null ? (
        <span
          className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-(--el-text-secondary)"
          data-testid="estimated-rows"
        >
          <Info aria-hidden className="h-3 w-3 text-(--el-info)" />
          {v.t('estimated', { count: d.estimatedRowCount })}
        </span>
      ) : null}
    </span>
  );
}

function PerModelTable({ v, d }: { v: View; d: ProviderReconciliationDayDTO }) {
  return (
    <table className="w-full font-sans text-xs">
      <thead>
        <tr className="text-left text-(--el-text-secondary)">
          <th scope="col" className="py-(--spacing-control-y-4) font-medium">
            {v.t('perModel.model')}
          </th>
          <th scope="col" className="py-(--spacing-control-y-4) text-right font-medium">
            {v.t('col.recorded')}
          </th>
          <th scope="col" className="py-(--spacing-control-y-4) text-right font-medium">
            {v.t('col.billed')}
          </th>
          <th scope="col" className="py-(--spacing-control-y-4) text-right font-medium">
            {v.t('col.gap')}
          </th>
        </tr>
      </thead>
      <tbody>
        {d.perModel.map((pm) => (
          <tr key={pm.model} className="border-t border-(--el-border-soft)">
            <td className="py-(--spacing-control-y-4) font-mono text-(--el-text)">{pm.model}</td>
            <td className="py-(--spacing-control-y-4) text-right tabular-nums text-(--el-text)">
              {v.money(pm.recordedMicroUsd)}
            </td>
            <td className="py-(--spacing-control-y-4) text-right tabular-nums text-(--el-text)">
              {v.money(pm.billedMicroUsd)}
            </td>
            <td className="py-(--spacing-control-y-4) text-right tabular-nums text-(--el-text)">
              {v.signed(pm.gapMicroUsd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A provider's period, summed over the days the route answered. */
function totals(p: ProviderReconciliationProviderDTO) {
  const read = p.days.filter((d) => d.billedMicroUsd !== null);
  return {
    recorded: p.days.reduce((s, d) => s + (d.recordedMicroUsd ?? 0), 0),
    recordedOnRead: read.reduce((s, d) => s + (d.recordedMicroUsd ?? 0), 0),
    billed: read.reduce((s, d) => s + (d.billedMicroUsd ?? 0), 0),
    gap: read.reduce((s, d) => s + (d.gapMicroUsd ?? 0), 0),
    past: p.days.filter((d) => d.pastTolerance).length,
    read: read.length,
  };
}

function ProviderCard({
  v,
  p,
  open,
}: {
  v: View;
  p: ProviderReconciliationProviderDTO;
  open: boolean;
}) {
  const { t } = v;
  const sum = totals(p);
  const name = providerDisplayName(p.provider);
  const tolerance =
    p.relativeTolerance === null || p.absoluteToleranceMicroUsd === null
      ? t('summary.noTolerance')
      : t('summary.tolerance', {
          relative: v.pct(p.relativeTolerance),
          absolute: v.money(p.absoluteToleranceMicroUsd),
        });
  return (
    <Card className="overflow-x-auto p-0" data-provider={p.provider}>
      <details open={open} className="group">
        <summary
          className="flex cursor-pointer list-none flex-wrap items-start gap-x-6 gap-y-2 px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
          data-testid="provider-summary"
        >
          <span className="flex min-w-[12rem] flex-1 items-start gap-2">
            <ChevronDown
              aria-hidden
              className="mt-0.5 h-4 w-4 shrink-0 -rotate-90 text-(--el-text-secondary) group-open:rotate-0"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-sans text-sm font-semibold text-(--el-text)">{name}</span>
              {name !== p.provider ? (
                <span className="font-mono text-xs text-(--el-text-secondary)">{p.provider}</span>
              ) : null}
              <span className="max-w-[18rem] font-sans text-xs text-(--el-text-secondary)">
                {tolerance}
              </span>
            </span>
          </span>
          <span className="flex flex-col items-end gap-0.5 font-sans">
            <span className="text-xs text-(--el-text-secondary)">{t('summary.recorded')}</span>
            <span className="text-sm tabular-nums text-(--el-text)">{v.money(sum.recorded)}</span>
            {sum.read > 0 && sum.recordedOnRead !== sum.recorded ? (
              <span className="text-xs tabular-nums text-(--el-text-secondary)">
                {t('summary.onRead', { amount: v.money(sum.recordedOnRead) })}
              </span>
            ) : null}
          </span>
          <span className="flex flex-col items-end gap-0.5 font-sans">
            <span className="text-xs text-(--el-text-secondary)">{t('summary.billed')}</span>
            {sum.read === 0 ? (
              <span className="text-sm text-(--el-text-secondary)">{DASH}</span>
            ) : (
              <span className="text-sm tabular-nums text-(--el-text)">{v.money(sum.billed)}</span>
            )}
            <span className="text-xs text-(--el-text-secondary)">
              {sum.read === 0
                ? t('summary.noneRead')
                : t('summary.over', { read: sum.read, days: p.days.length })}
            </span>
          </span>
          <span className="flex flex-col items-end gap-0.5 font-sans">
            <span className="text-xs text-(--el-text-secondary)">{t('summary.gap')}</span>
            {sum.read === 0 ? (
              <span className="text-sm text-(--el-text-secondary)">{DASH}</span>
            ) : (
              <span className="text-sm tabular-nums text-(--el-text)">{v.signed(sum.gap)}</span>
            )}
          </span>
          <span className="flex min-w-[10rem] flex-col items-end gap-1 self-center">
            {sum.past > 0 ? (
              <Pill severity="danger" data-testid="days-past-tolerance">
                <TriangleAlert aria-hidden className="h-3 w-3" />
                {t('summary.daysPast', { count: sum.past })}
              </Pill>
            ) : null}
            {sum.read === 0 ? (
              <span className="inline-flex items-center gap-1 text-xs text-(--el-text-secondary)">
                <CircleDashed aria-hidden className="h-3.5 w-3.5" />
                {t('status.unreconciled')}
              </span>
            ) : null}
          </span>
        </summary>
        <table
          className="w-full border-t border-(--el-border) font-sans text-sm"
          data-testid={`provider-days-${p.provider}`}
        >
          <caption className="sr-only">{t('summary.days', { provider: name })}</caption>
          <thead>
            <tr className="text-left text-xs text-(--el-text-secondary)">
              <th scope="col" className={TH}>
                {t('col.day')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('col.recorded')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('col.billed')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('col.gap')}
              </th>
              <th scope="col" className={TH}>
                {t('col.source')}
              </th>
              <th scope="col" className={TH}>
                {t('col.status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {p.days.map((d) => (
              <ReconciliationDayRow
                key={d.day}
                day={d.day}
                dayLabel={v.dayLabel(d.day)}
                expandLabel={t('perModel.aria', { day: v.dayLabel(d.day) })}
                pastTolerance={d.pastTolerance}
                cellClassName={TD}
                breakdown={d.perModel.length > 0 ? <PerModelTable v={v} d={d} /> : null}
                cells={
                  <>
                    <td className={`${TD} text-right`}>
                      <Fig v={v} value={d.recordedMicroUsd} />
                    </td>
                    <td className={`${TD} text-right`}>
                      <Fig v={v} value={d.billedMicroUsd} />
                    </td>
                    <td className={`${TD} text-right`}>
                      <GapCell v={v} d={d} />
                    </td>
                    <td className={TD}>
                      <SourceTag v={v} source={d.source} />
                    </td>
                    <td className={TD}>
                      <StatusMark v={v} d={d} />
                    </td>
                  </>
                }
              />
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );
}

function FindingsList({ v, r }: { v: View; r: ProviderReconciliationDTO }) {
  const { t } = v;
  if (r.findings.length === 0) {
    return (
      <p
        className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
        data-testid="findings-none"
      >
        <CircleCheck aria-hidden className="h-4 w-4 text-(--el-success)" />
        {t('findings.none', { month: v.monthLabel(r.period) })}
      </p>
    );
  }
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full font-sans text-sm" data-testid="usage-reconciliation-findings">
        <caption className="px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-left">
          <span className="inline-flex items-center gap-2 font-semibold text-(--el-text)">
            <TriangleAlert aria-hidden className="h-4 w-4 text-(--el-danger-on-surface)" />
            {t('findings.title')}
            <Pill tone="neutral">{v.num(r.findings.length)}</Pill>
          </span>
        </caption>
        <thead>
          <tr className="border-t border-(--el-border) text-left text-xs text-(--el-text-secondary)">
            <th scope="col" className={TH}>
              {t('col.day')}
            </th>
            <th scope="col" className={TH}>
              {t('col.provider')}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {t('col.recorded')}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {t('col.billed')}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {t('col.gap')}
            </th>
            <th scope="col" className={TH}>
              {t('col.models')}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              {t('col.estimated')}
            </th>
            <th scope="col" className={TH}>
              {t('col.side')}
            </th>
          </tr>
        </thead>
        <tbody>
          {r.findings.map((f) => (
            <tr
              key={`${f.provider}:${f.day}`}
              className="border-t border-(--el-border)"
              data-finding={`${f.provider}:${f.day}`}
            >
              <td className={`${TD} whitespace-nowrap tabular-nums text-(--el-text)`}>
                {v.dayLabel(f.day)}
              </td>
              <td className={`${TD} text-(--el-text)`}>{providerDisplayName(f.provider)}</td>
              <td className={`${TD} text-right tabular-nums text-(--el-text)`}>
                {v.money(f.recordedMicroUsd)}
              </td>
              <td className={`${TD} text-right tabular-nums text-(--el-text)`}>
                {v.money(f.billedMicroUsd)}
              </td>
              <td className={`${TD} text-right font-semibold tabular-nums text-(--el-text)`}>
                {v.signed(f.gapMicroUsd)}
              </td>
              <td className={TD}>
                {f.models.length === 0 ? (
                  <span className="text-xs text-(--el-text-secondary)">
                    {t('findings.noModels')}
                  </span>
                ) : (
                  <span className="flex flex-col gap-0.5">
                    {f.models.map((m) => (
                      <span key={m.model} className="whitespace-nowrap text-xs">
                        <span className="font-mono text-(--el-text)">{m.model}</span>{' '}
                        <span className="tabular-nums text-(--el-text-secondary)">
                          {v.signed(m.gapMicroUsd)}
                        </span>
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {f.estimatedRowCount === null ? (
                  <span className="text-(--el-text-secondary)">{DASH}</span>
                ) : (
                  <span className="text-(--el-text)">{v.num(f.estimatedRowCount)}</span>
                )}
              </td>
              <td className={TD} data-testid="differing-side">
                {f.differingSide === null ? (
                  <span className="text-xs text-(--el-text-secondary)">{t('side.unnamed')}</span>
                ) : (
                  <Pill severity="info" data-side={f.differingSide}>
                    {t(`side.${f.differingSide}`)}
                  </Pill>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function UnreconciledList({ v, providers }: { v: View; providers: string[] }) {
  if (providers.length === 0) return null;
  return (
    <Card data-testid="usage-unreconciled-providers">
      <div className="flex items-start gap-3">
        <Unplug aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" />
        <div className="flex flex-col gap-2">
          <h3 className="font-sans text-sm font-semibold text-(--el-text)">
            {v.t('unreconciled.title')}
          </h3>
          <p className="font-sans text-sm text-(--el-text-secondary)">{v.t('unreconciled.body')}</p>
          <ul className="flex flex-wrap gap-2">
            {providers.map((p) => (
              <li
                key={p}
                className="inline-flex items-center gap-1 font-sans text-sm text-(--el-text)"
                data-provider={p}
              >
                <CircleDashed aria-hidden className="h-3.5 w-3.5 text-(--el-text-secondary)" />
                {providerDisplayName(p)}
                {providerDisplayName(p) !== p ? (
                  <span className="font-mono text-xs text-(--el-text-secondary)">({p})</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
