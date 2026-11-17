import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { PlannerFindingRecordFindingDTO } from '@/lib/dto/plannerFindings';
import { AttributionChip } from './FindingChips';
import { FindingKeyCell } from './FindingKeyCell';
import { findingLabel } from './findingLabels';

/**
 * The record's FINDINGS table — designs MOTIR-11470 (Record findings table) and
 * MOTIR-11591 (the Planning bug column). One row per finding, in stored order.
 *
 * ⚠️ THE ROW LINK GIVES WAY TO THE ROW'S FORM: the site cell's chip is the link
 * to the finding's own page — the only link in the row — with no stretched row
 * link and no chevron, so clicks aimed at the key input reach it.
 *
 * ⚠️ TWO INDEPENDENT GATES.
 *  - `attributed` (the record's verdict state) decides whether the verdict's
 *    outputs render at all: the attribution chip, the why and both planner
 *    cells appear on every row of an attributed record and on NO row of an open
 *    one — an open record may hold findings that already carry them, and none is
 *    drawn until the verdict lands. Their cells stay, as the quiet em dash.
 *  - `canWrite` (operator or above, decided by the page, and only on an
 *    attributed record) decides whether each Planning bug cell draws its input,
 *    Link and Remove. Every key is drawn either way.
 *
 * A record with no findings draws one line where the table would be.
 */
export async function RecordFindingsTable({
  findings,
  attributed,
  canWrite,
}: {
  findings: PlannerFindingRecordFindingDTO[];
  attributed: boolean;
  canWrite: boolean;
}) {
  const t = await getTranslations('platformAdmin.plannerFindings');
  const title = t('record.findings.title');
  const none = (
    <>
      <span aria-hidden className="text-(--el-text-secondary)">
        —
      </span>
      <span className="sr-only">{t('record.field.none')}</span>
    </>
  );
  const mono = (value: string | null) =>
    value && value.trim() ? (
      <span className="font-mono text-xs break-all text-(--el-text-identifier)">{value}</span>
    ) : (
      none
    );
  const prediction = (value: string) =>
    t.has(`prediction.${value}` as 'prediction.STOPS')
      ? t(`prediction.${value}` as 'prediction.STOPS')
      : value;

  return (
    <Card
      data-testid="record-findings"
      header={<h2 className="font-sans text-sm font-semibold text-(--el-text)">{title}</h2>}
    >
      {findings.length === 0 ? (
        <p
          data-testid="record-findings-empty"
          className="font-sans text-sm text-(--el-text-secondary)"
        >
          {t('record.findings.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {attributed ? null : (
            <p
              data-testid="record-findings-open-line"
              className="flex items-center gap-1.5 border-b border-(--el-border) pb-(--spacing-control-y) font-sans text-xs text-(--el-text-secondary)"
            >
              <Lock aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {t('recordPage.findingKey.openRecord')}
            </p>
          )}
          <div className="md:overflow-x-auto">
            <table className="w-full border-collapse font-sans text-sm md:min-w-[64rem]">
              <caption className="sr-only">{title}</caption>
              <thead className="max-md:hidden">
                <tr className="border-b border-(--el-border) text-left">
                  <Th>{t('record.findings.col.site')}</Th>
                  <Th>{t('detail.prediction')}</Th>
                  <Th>{t('record.findings.col.attribution')}</Th>
                  <Th>{t('record.findings.col.why')}</Th>
                  <Th>{t('record.findings.col.hosted')}</Th>
                  <Th>{t('record.findings.col.planpy')}</Th>
                  <Th>{t('recordPage.findingKey.column')}</Th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr
                    key={finding.id}
                    data-testid={`record-finding-row-${finding.id}`}
                    className="border-b border-(--el-border-soft) last:border-b-0 max-md:flex max-md:flex-col max-md:gap-1.5 max-md:py-3"
                  >
                    <Td>
                      <Link
                        href={`/admin/planner-findings/${encodeURIComponent(finding.id)}`}
                        className="text-(--el-link)"
                      >
                        <code className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs break-all text-(--el-text-identifier) underline underline-offset-2">
                          {finding.site}
                        </code>
                      </Link>
                    </Td>
                    <Td className="max-w-[18ch] text-(--el-text)">
                      {prediction(finding.prediction)}
                    </Td>
                    <Td>
                      {attributed && finding.attribution ? (
                        <AttributionChip
                          value={finding.attribution}
                          label={findingLabel(
                            t as unknown as Parameters<typeof findingLabel>[0],
                            'attribution',
                            finding.attribution,
                          )}
                        />
                      ) : (
                        none
                      )}
                    </Td>
                    <Td className="max-w-[38ch] text-(--el-text)">
                      {attributed && finding.why?.trim() ? finding.why : none}
                    </Td>
                    <Td>{attributed ? mono(finding.hostedCell) : none}</Td>
                    <Td>{attributed ? mono(finding.planpyCell) : none}</Td>
                    <Td className="md:min-w-[14rem]">
                      <FindingKeyCell
                        findingId={finding.id}
                        site={finding.site}
                        bugKey={finding.bugKey}
                        canWrite={canWrite}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)"
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`align-top md:py-3 md:pr-4 ${className}`}>{children}</td>;
}
