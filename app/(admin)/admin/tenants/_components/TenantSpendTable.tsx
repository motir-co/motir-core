'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type { PlatformTenantSpendRowDTO } from '@/lib/dto/platform';
import { CHARGED_CATEGORIES } from '@/lib/platform/spend';
import { formatMicroUsd } from '../../_components/spendFormat';
import { loadMoreTenants } from '../listActions';

const CREDIT_COLUMNS = CHARGED_CATEGORIES;

/** Every sortable column, in the order the header draws them (design D10). */
const SORT_COLUMNS = [...CREDIT_COLUMNS, 'indexing', 'charged', 'cost'] as const;

/**
 * The Tenants list's table (MOTIR-7287, design D10): the estate total row first,
 * then one row per organization; every header sorts (a link — the sort lives in
 * the URL); Show more appends the next keyset page in place.
 */
export function TenantSpendTable({
  estate,
  initialRows,
  initialCursor,
  query,
  listHref,
  chips,
}: {
  estate: PlatformTenantSpendRowDTO;
  initialRows: PlatformTenantSpendRowDTO[];
  initialCursor: string | null;
  query: { period: string; sort: string; filter: string };
  /** The list's own URL, for the org page's ← Tenants. */
  listHref: string;
  /** The two flags' labels, resolved by the page from `platformAdmin.orgs.chip`. */
  chips: { isMeta: string; internalBilling: string };
}) {
  const t = useTranslations('platformAdmin.tenants');
  const tc = useTranslations('platformAdmin.usage.category');
  const format = useFormatter();
  const [rows, setRows] = useState(initialRows);
  const [cursor, setCursor] = useState(initialCursor);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  const num = (n: number) => format.number(n);
  const sortHref = (column: string) => {
    const p = new URLSearchParams({ period: query.period, sort: column });
    if (query.filter) p.set('q', query.filter);
    return `/admin/tenants?${p.toString()}`;
  };
  const header = (column: (typeof SORT_COLUMNS)[number]) =>
    column === 'charged'
      ? t('columns.charged')
      : column === 'cost'
        ? t('columns.cost')
        : tc(column);

  const more = () =>
    start(async () => {
      if (!cursor) return;
      const next = await loadMoreTenants({ ...query, cursor });
      if (next.unavailable) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setRows((current) => [...current, ...next.rows]);
      setCursor(next.nextCursor);
    });

  const cells = (row: PlatformTenantSpendRowDTO) => (
    <>
      {CREDIT_COLUMNS.map((c) => (
        <td key={c} className="px-3 py-2 text-right tabular-nums">
          {num(row.credits[c])}
        </td>
      ))}
      <td className="px-3 py-2 text-right tabular-nums text-(--el-text-secondary)">
        {format.number(row.indexingSeconds / 60, { maximumFractionDigits: 0 })}
      </td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums">{num(row.chargedCredits)}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums">
        {formatMicroUsd(format, row.costMicroUsd)}
      </td>
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full font-sans text-sm" data-testid="tenant-spend-table">
          <thead>
            <tr className="text-left text-xs text-(--el-text-secondary)">
              <th className="px-3 py-2 font-medium">{t('columns.organization')}</th>
              {SORT_COLUMNS.map((column) => (
                <th
                  key={column}
                  className="px-3 py-2 text-right font-medium"
                  aria-sort={query.sort === column ? 'descending' : undefined}
                >
                  <Link
                    href={sortHref(column)}
                    className={
                      query.sort === column
                        ? 'text-(--el-text) underline'
                        : 'hover:text-(--el-text)'
                    }
                  >
                    {header(column)}
                    {column === 'indexing' ? ` (${t('columns.minutes')})` : ''}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr
              className="border-t border-(--el-border) bg-(--el-surface) font-medium"
              data-testid="tenant-estate-row"
            >
              <td className="px-3 py-2 text-(--el-text)">{t('estateRow')}</td>
              {cells(estate)}
            </tr>
            {rows.map((row) => {
              const org = row.organization!;
              return (
                <tr key={org.id} className="border-t border-(--el-border)" data-testid="tenant-row">
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/tenants/${encodeURIComponent(org.id)}?from=${encodeURIComponent(listHref)}`}
                      className="flex flex-col hover:underline"
                    >
                      <span className="font-medium text-(--el-text)">{org.name}</span>
                      <span className="flex items-center gap-1 text-xs text-(--el-text-secondary)">
                        {org.slug ?? '—'}
                        {org.isMeta ? <Pill severity="info">{chips.isMeta}</Pill> : null}
                        {org.internalBilling ? (
                          <Pill severity="info">{chips.internalBilling}</Pill>
                        ) : null}
                      </span>
                    </Link>
                  </td>
                  {cells(row)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-2 font-sans text-sm text-(--el-text-secondary)">
          {query.filter ? t('noneFiltered', { filter: query.filter }) : t('none')}
        </p>
      ) : null}
      {failed ? (
        <p role="status" className="px-3 font-sans text-sm text-(--el-text-secondary)">
          {t('moreFailed')}
        </p>
      ) : null}
      {cursor ? (
        <button
          type="button"
          onClick={more}
          disabled={pending}
          className="self-start rounded-(--radius-input) px-(--spacing-control-x-12) py-(--spacing-control-y-4) font-sans text-sm text-(--el-accent-on-surface) hover:underline disabled:opacity-60"
        >
          {pending ? t('loading') : t('showMore')}
        </button>
      ) : null}
    </div>
  );
}
