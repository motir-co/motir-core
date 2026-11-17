import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import type { PlannerFindingRecordRowDTO } from '@/lib/dto/plannerFindings';
import { PLANNER_FINDING_NO_PLAN_ID } from '@/lib/services/plannerFindingsService';
import { VerdictChip } from './FindingChips';
import { Td, Th } from './FindingsTable';
import { findingLabel, type FindingLabelGroup } from './findingLabels';

/**
 * The RECORDS table — design MOTIR-11470 Panels 1–3 and 8. A real `<table>` with a
 * hidden caption in the shipped header and row grammar: seven columns (created,
 * planner, source, plan with its id beneath in mono, verdict chip, findings,
 * attributed), each row opening its record through a link stretched over the row
 * and carrying the trailing chevron. Counts are plain numerals, no total.
 *
 * Below md the same rows are stacked blocks (Panel 8), each one tap target.
 *
 * Nothing is looked up in motir-core: the plan cell is the title and id the
 * record stored, so a record whose plan was deleted is still listed.
 */

export function recordHref(id: string): string {
  return `/admin/planner-findings/records/${encodeURIComponent(id)}`;
}

export async function RecordsTable({ rows }: { rows: PlannerFindingRecordRowDTO[] }) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const format = await getFormatter();
  const label = (group: FindingLabelGroup, value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], group, value);
  const verdict = (state: string) =>
    t.has(`records.verdict.${state}` as 'records.verdict.open')
      ? t(`records.verdict.${state}` as 'records.verdict.open')
      : state;
  const created = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });

  // A check with no plan id stores the sentinel; it reads as "No plan", the
  // findings table's own wording, never the sentinel itself.
  const plan = (row: PlannerFindingRecordRowDTO) =>
    !row.planId || row.planId === PLANNER_FINDING_NO_PLAN_ID ? (
      <span className="text-(--el-text-secondary)">{t('row.noPlan')}</span>
    ) : (
      <>
        <span
          className="block max-w-[26ch] truncate font-semibold text-(--el-text)"
          title={row.planTitle ?? undefined}
        >
          {row.planTitle ?? t('row.untitledPlan')}
        </span>
        <span className="mt-0.5 block font-mono text-xs break-all text-(--el-text-identifier)">
          {row.planId}
        </span>
      </>
    );

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[52rem] border-collapse font-sans text-sm">
          <caption className="sr-only">{t('records.caption')}</caption>
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th>{t('records.col.created')}</Th>
              <Th>{t('records.col.planner')}</Th>
              <Th>{t('records.col.source')}</Th>
              <Th>{t('records.col.plan')}</Th>
              <Th>{t('records.col.verdict')}</Th>
              <Th>{t('records.col.findings')}</Th>
              <Th>{t('records.col.attributed')}</Th>
              <th scope="col" className="w-6">
                <span className="sr-only">{t('records.col.open')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-testid={`planner-finding-record-row-${row.id}`}
                className="relative border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft)"
              >
                <Td className="whitespace-nowrap text-(--el-text-secondary)">
                  <Link
                    href={recordHref(row.id)}
                    aria-label={t('records.row.open', { id: row.id })}
                    className="after:absolute after:inset-0 after:content-['']"
                  >
                    {created(row.createdAt)}
                  </Link>
                </Td>
                <Td>{label('planner', row.planner)}</Td>
                <Td>{label('source', row.source)}</Td>
                <Td className="max-w-[18rem]">{plan(row)}</Td>
                <Td>
                  <VerdictChip state={row.verdictState} label={verdict(row.verdictState)} />
                </Td>
                <Td className="tabular-nums text-(--el-text)">{row.findingCount}</Td>
                <Td className="tabular-nums text-(--el-text)">{row.attributedCount}</Td>
                <Td>
                  <ChevronRight aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="flex flex-col md:hidden" data-testid="planner-finding-records-blocks">
        {rows.map((row) => (
          <li key={row.id} className="border-b border-(--el-border-soft) last:border-b-0">
            <Link
              href={recordHref(row.id)}
              aria-label={t('records.row.open', { id: row.id })}
              className="flex min-h-11 flex-col gap-2 py-3 font-sans text-sm"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">{plan(row)}</span>
                <VerdictChip state={row.verdictState} label={verdict(row.verdictState)} />
              </span>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-(--el-text-secondary)">{t('records.col.created')}</dt>
                <dd className="text-(--el-text)">{created(row.createdAt)}</dd>
                <dt className="text-(--el-text-secondary)">{t('records.col.planner')}</dt>
                <dd className="text-(--el-text)">{label('planner', row.planner)}</dd>
                <dt className="text-(--el-text-secondary)">{t('records.col.source')}</dt>
                <dd className="text-(--el-text)">{label('source', row.source)}</dd>
                <dt className="text-(--el-text-secondary)">{t('records.col.findings')}</dt>
                <dd className="tabular-nums text-(--el-text)">{row.findingCount}</dd>
                <dt className="text-(--el-text-secondary)">{t('records.col.attributed')}</dt>
                <dd className="tabular-nums text-(--el-text)">{row.attributedCount}</dd>
              </dl>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
