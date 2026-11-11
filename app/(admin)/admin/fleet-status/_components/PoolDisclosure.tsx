'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * One add-shard pool's row and the account row it discloses (MOTIR-10887;
 * design MOTIR-10885 Panel 8). The pool name is a `<button aria-expanded
 * aria-controls>`; the account row it controls carries the id.
 *
 * ⚠️ THIS ISLAND OWNS ONE BOOLEAN AND NOTHING ELSE. Every cell and the whole
 * account table are server-rendered and arrive as children, so what the row says
 * is decided where the data is; the island only shows or hides the second row.
 */
export function PoolDisclosure({
  kind,
  label,
  controlsId,
  rail,
  cells,
  accounts,
  colSpan,
}: {
  kind: string;
  label: string;
  controlsId: string;
  /** The 3px warning rail: the pool is at or past 70% of its size. */
  rail: boolean;
  cells: ReactNode;
  accounts: ReactNode;
  colSpan: number;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        data-shard-pool={kind}
        data-expanded={open ? 'true' : 'false'}
        className="border-b border-(--el-border-soft)"
      >
        <td
          data-rail={rail ? 'warning' : undefined}
          className={`py-2 pr-3 align-top ${rail ? 'border-l-[3px] border-l-(--el-warning) pl-3' : ''}`}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-controls={controlsId}
            onClick={() => setOpen((was) => !was)}
            className="inline-flex items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) font-sans text-sm font-medium text-(--el-text) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <Chevron aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
            {label}
          </button>
        </td>
        {cells}
      </tr>
      {/* Always in the document, so `aria-controls` names a real element. */}
      <tr id={controlsId} hidden={!open} className="border-b border-(--el-border-soft)">
        <td colSpan={colSpan} className="bg-(--el-surface-soft) p-(--spacing-card-padding-12)">
          {accounts}
        </td>
      </tr>
    </>
  );
}
