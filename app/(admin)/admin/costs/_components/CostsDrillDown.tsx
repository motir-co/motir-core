import type { ReactNode } from 'react';
import type { createFormatter } from 'next-intl';
import type { CostsAwsLineDTO, CostsRowDTO } from '@/lib/dto/platformCosts';
import { providerDisplayName } from '@/lib/models/displayNames';
import { formatMicroUsd } from '../../_components/spendFormat';

/**
 * A Costs row's DRILL-DOWN (MOTIR-11712; design MOTIR-11711, § Drill-down and
 * § Breakdown line): AWS by service beside Models by provider, side by side from
 * `lg` and stacked below. A source that is unavailable, or that holds no figure
 * for the row, draws no breakdown.
 *
 * AWS lines keep AWS's own service names, largest first, then Tax, Credits and
 * Refund in medium weight; model lines take `providerDisplayName`. Share is the
 * line ÷ the row's figure; a negative line draws no bar, and its amount and share
 * carry a U+2212 minus.
 */

type NumberFormatter = Pick<ReturnType<typeof createFormatter>, 'number'>;

export const EM_DASH = '—';

/** A negative amount or share reads with U+2212, never a hyphen. */
export function minus(text: string): string {
  return text.replace(/-/g, '−');
}

export interface CostsDrillDownLabels {
  aws: string;
  models: string;
  service: string;
  provider: string;
  amount: string;
  share: string;
  tax: string;
  credits: string;
  refund: string;
}

const LINE_CELL = 'py-(--spacing-control-y-4)';

interface BreakdownLine {
  key: string;
  kind: string;
  name: ReactNode;
  amountMicroUsd: number;
  share: number | null;
}

function awsLineName(labels: CostsDrillDownLabels, line: CostsAwsLineDTO): ReactNode {
  if (line.kind === 'service') return line.service;
  const label =
    line.kind === 'tax' ? labels.tax : line.kind === 'credit' ? labels.credits : labels.refund;
  return <span className="font-medium">{label}</span>;
}

export function CostsDrillDown({
  format,
  row,
  awsAvailable,
  modelsAvailable,
  labels,
}: {
  format: NumberFormatter;
  row: CostsRowDTO;
  awsAvailable: boolean;
  modelsAvailable: boolean;
  labels: CostsDrillDownLabels;
}) {
  const money = (micro: number) => minus(formatMicroUsd(format, micro));
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      {awsAvailable && row.awsMicroUsd !== null ? (
        <Breakdown
          testId="costs-breakdown-aws"
          title={labels.aws}
          figure={money(row.awsMicroUsd)}
          nameHeader={labels.service}
          labels={labels}
          format={format}
          lines={row.awsLines.map((line) => ({
            key: `${line.kind}:${line.service}`,
            kind: line.kind,
            name: awsLineName(labels, line),
            amountMicroUsd: line.amountMicroUsd,
            share: line.share,
          }))}
        />
      ) : null}
      {modelsAvailable && row.modelsMicroUsd !== null ? (
        <Breakdown
          testId="costs-breakdown-models"
          title={labels.models}
          figure={money(row.modelsMicroUsd)}
          nameHeader={labels.provider}
          labels={labels}
          format={format}
          lines={row.modelLines.map((line) => ({
            key: line.provider,
            kind: 'provider',
            name: providerDisplayName(line.provider),
            amountMicroUsd: line.amountMicroUsd,
            share: line.share,
          }))}
        />
      ) : null}
    </div>
  );
}

function Breakdown({
  testId,
  title,
  figure,
  nameHeader,
  lines,
  labels,
  format,
}: {
  testId: string;
  title: string;
  figure: string;
  nameHeader: string;
  lines: BreakdownLine[];
  labels: CostsDrillDownLabels;
  format: NumberFormatter;
}) {
  return (
    <table className="w-full font-sans text-xs" data-testid={testId}>
      <caption className={`${LINE_CELL} text-left`}>
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-sans text-xs font-semibold text-(--el-text)">{title}</span>
          <span className="tabular-nums text-(--el-text)">{figure}</span>
        </span>
      </caption>
      <thead>
        <tr className="text-left text-(--el-text-secondary)">
          <th scope="col" className={`${LINE_CELL} font-medium`}>
            {nameHeader}
          </th>
          <th scope="col" className={`${LINE_CELL} text-right font-medium`}>
            {labels.amount}
          </th>
          <th
            scope="col"
            className={`${LINE_CELL} pl-(--spacing-control-x-12) text-right font-medium`}
          >
            {labels.share}
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr
            key={line.key}
            className="border-t border-(--el-border-soft)"
            data-line-kind={line.kind}
          >
            <td className={`${LINE_CELL} pr-(--spacing-control-x-8) text-(--el-text)`}>
              {line.name}
            </td>
            <td className={`${LINE_CELL} text-right tabular-nums text-(--el-text)`}>
              {minus(formatMicroUsd(format, line.amountMicroUsd))}
            </td>
            <td className={`${LINE_CELL} pl-(--spacing-control-x-12) text-right`}>
              <span className="inline-flex items-center justify-end gap-2">
                {line.share !== null && line.share > 0 ? (
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-(--el-muted)"
                  >
                    <span
                      className="block h-full rounded-full bg-(--el-info)"
                      style={{ width: `${Math.min(100, Math.round(line.share * 100))}%` }}
                    />
                  </span>
                ) : null}
                <span className="w-12 tabular-nums text-(--el-text-secondary)">
                  {line.share === null
                    ? EM_DASH
                    : minus(
                        format.number(line.share, { style: 'percent', maximumFractionDigits: 1 }),
                      )}
                </span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
