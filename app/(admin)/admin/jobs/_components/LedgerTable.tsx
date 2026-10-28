import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * The ledger's table anatomy — design `platform-admin` AMENDMENT 2026-10-28
 * § Jobs, which reuses the workspace ledger's ROW ANATOMY without importing
 * `JobsDashboard.tsx` (the staff ledger does not fork the tenant dashboard).
 *
 * The header ink is `--el-text-secondary`, not `--el-text-muted`: the header row
 * is painted `--el-surface`, where muted measures 4.17:1 (MOTIR-3523).
 */

export function Th({
  children,
  className,
  srOnly,
}: {
  children: ReactNode;
  className?: string;
  srOnly?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left font-sans text-xs font-semibold whitespace-nowrap text-(--el-text-secondary)',
        className,
      )}
    >
      {srOnly ? <span className="sr-only">{children}</span> : children}
    </th>
  );
}

export function Td({
  children,
  className,
  title,
}: {
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn('px-3 py-2 align-middle font-sans text-sm text-(--el-text)', className)}
    >
      {children}
    </td>
  );
}

export function TableShell({
  caption,
  head,
  children,
  busyLabel,
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  /** Set while the rows are skeletons: the table is `aria-busy` and named by it. */
  busyLabel?: string;
}) {
  return (
    <div
      className="overflow-x-auto rounded-(--radius-card) border border-(--el-border)"
      {...(busyLabel ? { 'aria-busy': true, 'aria-label': busyLabel, role: 'region' } : {})}
    >
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-(--el-border) bg-(--el-surface)">
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** One table row of the ledger, with the drawn hover. */
export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr
      className={cn(
        'border-b border-(--el-border) last:border-b-0 hover:bg-(--el-surface)',
        className,
      )}
    >
      {children}
    </tr>
  );
}

/**
 * Loading: the table header over four `--el-muted` skeleton rows, so the table
 * keeps its geometry while the server reads.
 */
export function TableSkeleton({
  caption,
  label,
  columns,
}: {
  caption: string;
  label: string;
  columns: string[];
}) {
  return (
    <TableShell
      caption={caption}
      busyLabel={label}
      head={columns.map((column) => (
        <Th key={column}>{column}</Th>
      ))}
    >
      {[0, 1, 2, 3].map((row) => (
        <tr key={row} className="border-b border-(--el-border) last:border-b-0">
          {columns.map((column) => (
            <td key={column} className="px-3 py-3">
              <span
                aria-hidden="true"
                className="block h-3 w-full max-w-[8rem] rounded-(--radius-control) bg-(--el-muted)"
              />
            </td>
          ))}
        </tr>
      ))}
    </TableShell>
  );
}
