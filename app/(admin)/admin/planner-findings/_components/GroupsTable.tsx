import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import type { PlannerFindingGroupRowDTO } from '@/lib/dto/plannerFindings';
import { AttributionChip, OutcomeChip } from './FindingChips';
import { Td, Th } from './FindingsTable';
import { findingLabel, type FindingLabelGroup } from './findingLabels';
import { groupHref } from './groupLinks';

/**
 * The GROUPED table — design MOTIR-10362 Panel 2. One row per fingerprint: the
 * latest finding's site, the group's attribution (the fingerprint hashes it, so
 * every finding under it shares one), the latest outcome, how many findings and
 * how many distinct plans, and when it was last seen. The site is a link
 * stretched over the row, opening the group with the current filters.
 *
 * No per-outcome bar: the grouped read answers no per-outcome counts.
 */
export async function GroupsTable({
  groups,
  params,
}: {
  groups: PlannerFindingGroupRowDTO[];
  params: Record<string, string | string[] | undefined>;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const format = await getFormatter();
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], group, value);

  return (
    <div className="overflow-x-auto">
      <table
        data-testid="planner-findings-groups-table"
        className="w-full min-w-[52rem] border-collapse font-sans text-sm"
      >
        <caption className="sr-only">{t('a11y.captionGroups')}</caption>
        <thead>
          <tr className="border-b border-(--el-border) text-left">
            <Th>{t('col.defect')}</Th>
            <Th>{t('col.attribution')}</Th>
            <Th>{t('col.outcome')}</Th>
            <Th>{t('col.findings')}</Th>
            <Th>{t('col.plans')}</Th>
            <Th>{t('col.lastSeen')}</Th>
            <th aria-hidden className="w-6" />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr
              key={group.fingerprint}
              data-testid={`planner-findings-group-row-${group.fingerprint}`}
              className="relative border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft)"
            >
              <Td className="max-w-[22rem]">
                <Link
                  href={groupHref(group.fingerprint, params)}
                  aria-label={t('row.open', { site: group.latest.site })}
                  className="after:absolute after:inset-0 after:content-['']"
                >
                  <code className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs break-all text-(--el-text-identifier)">
                    {group.latest.site}
                  </code>
                </Link>
              </Td>
              <Td>
                <AttributionChip
                  value={group.latest.attribution}
                  label={label('attribution', group.latest.attribution)}
                />
              </Td>
              <Td>
                <OutcomeChip
                  outcome={group.latest.outcome}
                  label={label('outcome', group.latest.outcome)}
                />
              </Td>
              <Td className="whitespace-nowrap text-(--el-text)">
                {t('row.findings', { n: group.findingCount })}
              </Td>
              <Td className="whitespace-nowrap text-(--el-text)">
                {t('row.plans', { n: group.planCount })}
              </Td>
              <Td className="whitespace-nowrap text-(--el-text-secondary)">
                {format.dateTime(new Date(group.latest.createdAt), { dateStyle: 'medium' })}
              </Td>
              <Td>
                <ChevronRight aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
