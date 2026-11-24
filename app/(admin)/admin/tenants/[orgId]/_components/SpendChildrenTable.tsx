'use client';

import { Fragment, useState, useTransition } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { RawSpendRow } from '@/lib/ai/motirAiClient';
import { CHARGED_CATEGORIES } from '@/lib/platform/spend';
import { formatMicroUsd } from '../../../_components/spendFormat';
import { loadWorkspaceProjects } from '../usageActions';

const CREDIT_COLUMNS = CHARGED_CATEGORIES;
/** Name + every charged category + indexing minutes + charged total + Motir cost. */
const COLUMN_COUNT = CREDIT_COLUMNS.length + 4;

type Named = RawSpendRow & { name: string };

/**
 * BY WORKSPACE AND PROJECT (MOTIR-7293, design D8): the scope's children × every
 * charged category, indexing minutes, charged total and Motir cost. At org scope a
 * workspace EXPANDS to its projects (read on demand, audited), and the two rows no
 * workspace holds — agent runs with no project, org-level — close the table.
 */
export function SpendChildrenTable({
  orgId,
  period,
  childLevel,
  rows,
  remainder,
  truncated,
}: {
  orgId: string;
  period: string;
  childLevel: 'workspace' | 'project';
  rows: Named[];
  remainder: { noProject: RawSpendRow; orgLevel: RawSpendRow } | null;
  truncated: boolean;
}) {
  const t = useTranslations('platformAdmin.orgUsage.children');
  const tc = useTranslations('platformAdmin.usage.category');
  const format = useFormatter();
  const [open, setOpen] = useState<Record<string, Named[] | 'loading' | 'failed'>>({});
  const [, start] = useTransition();

  const expand = (workspaceId: string) => {
    if (open[workspaceId]) {
      setOpen(({ [workspaceId]: _drop, ...rest }) => rest);
      return;
    }
    setOpen((cur) => ({ ...cur, [workspaceId]: 'loading' }));
    start(async () => {
      const result = await loadWorkspaceProjects({ orgId, workspaceId, period });
      setOpen((cur) => ({ ...cur, [workspaceId]: result ? result.rows : 'failed' }));
    });
  };

  const cells = (r: RawSpendRow) => (
    <>
      {CREDIT_COLUMNS.map((c) => (
        <td key={c} className="px-2 py-1 text-right tabular-nums">
          {format.number(r.credits[c])}
        </td>
      ))}
      <td className="px-2 py-1 text-right tabular-nums text-(--el-text-secondary)">
        {format.number(r.indexingSeconds / 60, { maximumFractionDigits: 0 })}
      </td>
      <td className="px-2 py-1 text-right font-semibold tabular-nums">
        {format.number(r.chargedCredits)}
      </td>
      <td className="px-2 py-1 text-right font-semibold tabular-nums">
        {formatMicroUsd(format, r.costMicroUsd)}
      </td>
    </>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full font-sans text-sm" data-testid="org-usage-children">
        <thead>
          <tr className="text-left text-xs text-(--el-text-secondary)">
            <th className="px-2 py-2 font-medium">{t(childLevel)}</th>
            {CREDIT_COLUMNS.map((c) => (
              <th key={c} className="px-2 py-2 text-right font-medium">
                {tc(c)}
              </th>
            ))}
            <th className="px-2 py-2 text-right font-medium">{t('indexingMinutes')}</th>
            <th className="px-2 py-2 text-right font-medium">{t('charged')}</th>
            <th className="px-2 py-2 text-right font-medium">{t('cost')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMN_COUNT} className="px-2 py-2 text-(--el-text-secondary)">
                {t('empty')}
              </td>
            </tr>
          ) : null}
          {rows.map((r) => {
            const state = open[r.entityId];
            return (
              <Fragment key={r.entityId}>
                <tr className="border-t border-(--el-border)" data-child={r.entityId}>
                  <td className="px-2 py-1 text-(--el-text)">
                    {childLevel === 'workspace' ? (
                      <button
                        type="button"
                        aria-expanded={Boolean(state)}
                        onClick={() => expand(r.entityId)}
                        className="inline-flex items-center gap-1 hover:underline"
                      >
                        {state ? (
                          <ChevronDown aria-hidden className="h-4 w-4" />
                        ) : (
                          <ChevronRight aria-hidden className="h-4 w-4" />
                        )}
                        {r.name}
                      </button>
                    ) : (
                      r.name
                    )}
                  </td>
                  {cells(r)}
                </tr>
                {state === 'loading' ? (
                  <tr>
                    <td
                      colSpan={COLUMN_COUNT}
                      className="py-1 pl-8 text-xs text-(--el-text-secondary)"
                    >
                      {t('loading')}
                    </td>
                  </tr>
                ) : state === 'failed' ? (
                  <tr>
                    <td
                      colSpan={COLUMN_COUNT}
                      className="py-1 pl-8 text-xs text-(--el-text-secondary)"
                      role="status"
                    >
                      {t('projectsUnavailable')}
                    </td>
                  </tr>
                ) : Array.isArray(state) ? (
                  state.length === 0 ? (
                    <tr>
                      <td
                        colSpan={COLUMN_COUNT}
                        className="py-1 pl-8 text-xs text-(--el-text-secondary)"
                      >
                        {t('noProjects')}
                      </td>
                    </tr>
                  ) : (
                    state.map((p) => (
                      <tr
                        key={p.entityId}
                        className="bg-(--el-surface) text-xs"
                        data-project-of={r.entityId}
                      >
                        <td className="py-1 pl-8 pr-2 text-(--el-text)">{p.name}</td>
                        {cells(p)}
                      </tr>
                    ))
                  )
                ) : null}
              </Fragment>
            );
          })}
          {remainder ? (
            <>
              <tr
                className="border-t border-(--el-border) italic"
                data-testid="children-no-project"
              >
                <td className="px-2 py-1 text-(--el-text-secondary)">{t('noProject')}</td>
                {cells(remainder.noProject)}
              </tr>
              <tr className="border-t border-(--el-border) italic" data-testid="children-org-level">
                <td className="px-2 py-1 text-(--el-text-secondary)">{t('orgLevel')}</td>
                {cells(remainder.orgLevel)}
              </tr>
            </>
          ) : null}
        </tbody>
      </table>
      {truncated ? (
        <p className="px-2 py-1 font-sans text-xs text-(--el-text-secondary)">{t('truncated')}</p>
      ) : null}
    </div>
  );
}
