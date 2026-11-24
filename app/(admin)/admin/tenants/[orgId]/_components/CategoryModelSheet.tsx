'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { RawPlatformModelFigures } from '@/lib/ai/motirAiClient';
import { buildSpendSheet, type CategoryFigures, type SpendCategory } from '@/lib/platform/spend';
import { formatMicroUsd, formatUsage } from '../../../_components/spendFormat';

/** The categories that are organization-level by nature: never split below the org. */
export const ORG_LEVEL_CATEGORIES: ReadonlySet<SpendCategory> = new Set([
  'agent_instance',
  'agent_storage',
  'search',
  'hosting_production',
]);

/**
 * BY CATEGORY AND MODEL (MOTIR-7288, design D8/D11): the nine categories with usage
 * in their own unit, credits and Motir cost; the two token categories EXPAND to one
 * row per model; Charged total and Total incl. indexing. Below the org, the
 * org-level categories say so rather than showing a zero.
 */
export function CategoryModelSheet({
  categories,
  models,
  belowOrg,
}: {
  categories: CategoryFigures[];
  models: { planning_tokens: RawPlatformModelFigures[]; agent_tokens: RawPlatformModelFigures[] };
  /** The scope is a workspace or a project. */
  belowOrg: 'workspace' | 'project' | null;
}) {
  const t = useTranslations('platformAdmin.orgUsage');
  const tc = useTranslations('platformAdmin.usage.category');
  const tu = useTranslations('platformAdmin.usage.units');
  const format = useFormatter();
  const [open, setOpen] = useState<ReadonlySet<SpendCategory>>(new Set());
  const sheet = buildSpendSheet(categories);
  const units = {
    tokens: tu('tokens'),
    minutes: tu('minutes'),
    gbDays: tu('gbDays'),
    searches: tu('searches'),
  };
  const money = (micro: number) => formatMicroUsd(format, micro);
  const toggle = (c: SpendCategory) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <table className="w-full font-sans text-sm" data-testid="org-usage-categories">
      <thead>
        <tr className="text-left text-xs text-(--el-text-secondary)">
          <th className="px-3 py-2 font-medium">{t('sheet.category')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('sheet.usage')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('sheet.credits')}</th>
          <th className="px-3 py-2 text-right font-medium">{t('sheet.cost')}</th>
        </tr>
      </thead>
      <tbody>
        {sheet.rows.map((row) => {
          const tokenCategory =
            row.category === 'planning_tokens' || row.category === 'agent_tokens';
          const list = tokenCategory
            ? models[row.category as 'planning_tokens' | 'agent_tokens']
            : [];
          const expanded = open.has(row.category);
          if (belowOrg && ORG_LEVEL_CATEGORIES.has(row.category)) {
            return (
              <tr
                key={row.category}
                data-category={row.category}
                className="border-t border-(--el-border)"
              >
                <td className="px-3 py-2 text-(--el-text)">{tc(row.category)}</td>
                <td
                  colSpan={3}
                  className="px-3 py-2 text-right text-(--el-text-secondary)"
                  data-testid="org-level-line"
                >
                  {t(`sheet.orgLevel.${belowOrg}`)}
                </td>
              </tr>
            );
          }
          return (
            <Fragment key={row.category}>
              <tr data-category={row.category} className="border-t border-(--el-border)">
                <td className="px-3 py-2 text-(--el-text)">
                  {tokenCategory && list.length > 0 ? (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggle(row.category)}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      {expanded ? (
                        <ChevronDown aria-hidden className="h-4 w-4" />
                      ) : (
                        <ChevronRight aria-hidden className="h-4 w-4" />
                      )}
                      {tc(row.category)}
                      <span className="text-xs text-(--el-text-secondary)">
                        {t('sheet.models', { count: list.length })}
                      </span>
                    </button>
                  ) : (
                    tc(row.category)
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-(--el-text-secondary)">
                  {formatUsage(format, row.unit, row.usage, units)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.credits === null ? (
                    <span className="text-(--el-text-secondary)">{t('sheet.notCharged')}</span>
                  ) : (
                    format.number(row.credits)
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(row.costMicroUsd)}</td>
              </tr>
              {expanded
                ? list.map((m) => (
                    <tr
                      key={`${row.category}:${m.model}`}
                      data-model-of={row.category}
                      className="bg-(--el-surface)"
                    >
                      <td className="py-1 pl-10 pr-3 font-mono text-xs text-(--el-text)">
                        {m.model}
                      </td>
                      <td className="px-3 py-1 text-right text-xs tabular-nums text-(--el-text-secondary)">
                        {formatUsage(format, 'tokens', m.inputTokens + m.outputTokens, units)}
                      </td>
                      <td className="px-3 py-1 text-right text-xs tabular-nums">
                        {format.number(m.credits)}
                      </td>
                      <td className="px-3 py-1 text-right text-xs tabular-nums">
                        {money(m.costMicroUsd)}
                      </td>
                    </tr>
                  ))
                : null}
            </Fragment>
          );
        })}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-(--el-border) font-semibold">
          <td className="px-3 py-2">{t('sheet.chargedTotal')}</td>
          <td className="px-3 py-2" />
          <td className="px-3 py-2 text-right tabular-nums">
            {format.number(sheet.chargedCredits)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums">{money(sheet.chargedCostMicroUsd)}</td>
        </tr>
        <tr className="border-t border-(--el-border)">
          <td className="px-3 py-2">{t('sheet.totalInclIndexing')}</td>
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2 text-right font-semibold tabular-nums">
            {money(sheet.costMicroUsdInclIndexing)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
