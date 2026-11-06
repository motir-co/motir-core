import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import type { PlannerFindingRowDTO } from '@/lib/dto/plannerFindings';
import { PLANNER_FINDING_NO_PLAN_ID } from '@/lib/services/plannerFindingsService';
import { AttributionChip, OutcomeChip, TriageChip } from './FindingChips';
import { findingLabel, type FindingLabelGroup } from './findingLabels';

/**
 * The ALL-FINDINGS table — design MOTIR-10362 Panel 3. A real `<table>` with a
 * hidden caption; each row opens the finding through a link stretched over the
 * row, so the row is one tab stop named after its site.
 *
 * Nothing here is looked up in motir-core: the plan cell is the plan id and
 * title motir-ai stored, so a finding whose plan was deleted is still listed.
 */
export async function FindingsTable({
  rows,
  caption,
}: {
  rows: PlannerFindingRowDTO[];
  caption?: string;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const format = await getFormatter();
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], group, value);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[60rem] border-collapse font-sans text-sm">
        <caption className="sr-only">{caption ?? t('a11y.captionAll')}</caption>
        <thead>
          <tr className="border-b border-(--el-border) text-left">
            <Th>{t('col.site')}</Th>
            <Th>{t('col.source')}</Th>
            <Th>{t('col.planner')}</Th>
            <Th>{t('col.outcome')}</Th>
            <Th>{t('col.plan')}</Th>
            <Th>{t('col.attribution')}</Th>
            <Th>{t('col.state')}</Th>
            <Th>{t('col.date')}</Th>
            <th aria-hidden className="w-6" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const noPlan = !row.planId || row.planId === PLANNER_FINDING_NO_PLAN_ID;
            const status =
              row.status === 'filed_as_bug' && row.bugKey
                ? t('status.bugWithKey', { key: row.bugKey })
                : label('status', row.status);
            return (
              <tr
                key={row.id}
                data-testid={`planner-finding-row-${row.id}`}
                className={`relative border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft) ${
                  row.status === 'dismissed' ? 'opacity-60' : ''
                }`}
              >
                <Td className="max-w-[20rem]">
                  <Link
                    href={`/admin/planner-findings/${row.id}`}
                    aria-label={t('row.open', { site: row.site })}
                    className="after:absolute after:inset-0 after:content-['']"
                  >
                    <code className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs break-all text-(--el-text-identifier)">
                      {row.site}
                    </code>
                  </Link>
                </Td>
                <Td>{label('source', row.source)}</Td>
                <Td>{label('planner', row.planner)}</Td>
                <Td>
                  <OutcomeChip outcome={row.outcome} label={label('outcome', row.outcome)} />
                </Td>
                <Td className="max-w-[16rem]">
                  {noPlan ? (
                    <span className="text-(--el-text-secondary)">{t('row.noPlan')}</span>
                  ) : (
                    <span className="text-(--el-text)">
                      {row.planTitle ?? t('row.untitledPlan')}
                    </span>
                  )}
                </Td>
                <Td>
                  <AttributionChip
                    value={row.attribution}
                    label={label('attribution', row.attribution)}
                  />
                </Td>
                <Td>
                  <TriageChip status={row.status} label={status} />
                </Td>
                <Td className="whitespace-nowrap text-(--el-text-secondary)">
                  {format.dateTime(new Date(row.createdAt), { dateStyle: 'medium' })}
                </Td>
                <Td>
                  <ChevronRight aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)"
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
