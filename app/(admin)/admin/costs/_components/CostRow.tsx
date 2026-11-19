'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * One row of the Costs table (MOTIR-11712; design MOTIR-11711, § Row disclosure)
 * — `ReconciliationDayRow`'s pattern. The cells and the drill-down are rendered
 * on the server; this component only owns whether the drill-down is open. Every
 * row has a disclosure, and several may be open at once.
 */
export function CostRow({
  period,
  periodLabel,
  openLabel,
  partial,
  mark,
  cells,
  drillDown,
  cellClassName,
}: {
  period: string;
  periodLabel: string;
  openLabel: string;
  partial: boolean;
  /** The Partial pill beside the period, or null. */
  mark: ReactNode;
  /** The row's cells after the period cell. */
  cells: ReactNode;
  drillDown: ReactNode;
  cellClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        className="border-t border-(--el-border)"
        data-period={period}
        data-partial={partial || undefined}
      >
        <td className={`${cellClassName} whitespace-nowrap`}>
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              aria-expanded={open}
              aria-label={openLabel}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-(--radius-control) text-(--el-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring-color)"
            >
              <Chevron aria-hidden className="h-3.5 w-3.5 text-(--el-text-secondary)" />
              <span className="tabular-nums">{periodLabel}</span>
            </button>
            {mark}
          </span>
        </td>
        {cells}
      </tr>
      {open ? (
        <tr className="bg-(--el-surface-soft)" data-testid="costs-drilldown">
          <td className={cellClassName} />
          <td colSpan={3} className={cellClassName}>
            {drillDown}
          </td>
        </tr>
      ) : null}
    </>
  );
}
