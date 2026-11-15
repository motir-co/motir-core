'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * One day of a provider's Day grid (MOTIR-11376; design MOTIR-11375, § Provider
 * bills, the Per-model breakdown). The cells are rendered on the server; this
 * component only owns whether the day's per-model breakdown is open. A day with
 * no breakdown (`breakdown` null) draws no expander at all, never an empty one.
 */
export function ReconciliationDayRow({
  day,
  dayLabel,
  expandLabel,
  pastTolerance,
  cells,
  breakdown,
  cellClassName,
}: {
  day: string;
  dayLabel: string;
  expandLabel: string;
  pastTolerance: boolean;
  /** The row's cells after the day cell. */
  cells: ReactNode;
  /** The per-model table, or null when the provider gave no breakdown. */
  breakdown: ReactNode | null;
  cellClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        className="border-t border-(--el-border)"
        data-day={day}
        data-past-tolerance={pastTolerance || undefined}
      >
        <td className={`${cellClassName} whitespace-nowrap`}>
          {breakdown ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={expandLabel}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-(--radius-control) text-(--el-text) focus-visible:outline-2 focus-visible:outline-(--focus-ring-color)"
            >
              <Chevron aria-hidden className="h-3.5 w-3.5 text-(--el-text-secondary)" />
              <span className="tabular-nums">{dayLabel}</span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 text-(--el-text)">
              <span aria-hidden className="inline-block h-3.5 w-3.5" />
              <span className="tabular-nums">{dayLabel}</span>
            </span>
          )}
        </td>
        {cells}
      </tr>
      {breakdown && open ? (
        <tr className="bg-(--el-surface-soft)" data-testid="per-model">
          <td className={cellClassName} />
          <td colSpan={5} className={cellClassName}>
            {breakdown}
          </td>
        </tr>
      ) : null}
    </>
  );
}
