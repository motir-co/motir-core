// The board loading skeleton (Subtask 3.2.2), per design/boards/board.mock.html
// (panel 6 "Loading"): a column scaffold of pulsing placeholder cards shown
// while the GET /api/board projection streams. Purely presentational + static,
// so it mirrors the real board's column chrome (fixed-width columns in a
// horizontal scroll row, --el-surface fill, --radius-card) — no layout shift on
// settle. The shimmer bars are decorative (aria-hidden); the wrapper carries the
// status role + label so assistive tech announces the load.

import { useTranslations } from 'next-intl';

const COLUMNS = [0, 1, 2, 3, 4];
// Per-column placeholder card counts — a little variety echoes a real board.
const CARDS_PER_COLUMN = [3, 2, 4, 2, 1];

function Bar({ w, className }: { w?: number; className?: string }) {
  return (
    <span
      className={`block h-3 rounded-(--radius-control) bg-(--el-muted) ${className ?? ''}`}
      style={w ? { width: w } : undefined}
      aria-hidden
    />
  );
}

/** One board card's loading placeholder — the board skeleton's, and a grouped board's
 * not-yet-loaded cell (MOTIR-11450, design MOTIR-11443 panel 4). */
export function SkeletonCard() {
  return (
    <div
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) shadow-(--shadow-subtle)"
      aria-hidden
    >
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 shrink-0 rounded-(--radius-control) bg-(--el-muted)" aria-hidden />
        <Bar w={48} />
      </div>
      <Bar className="w-full" />
      <Bar w={120} />
      <div className="flex items-center justify-between pt-1">
        <span className="block h-5 w-16 rounded-full bg-(--el-muted)" aria-hidden />
        <span className="h-[22px] w-[22px] shrink-0 rounded-full bg-(--el-muted)" aria-hidden />
      </div>
    </div>
  );
}

export function BoardSkeleton() {
  const t = useTranslations('boards');
  return (
    <div
      className="flex gap-4 overflow-x-hidden"
      role="status"
      aria-label={t('loadingLabel')}
      data-testid="board-skeleton"
    >
      <div className="flex animate-pulse gap-4">
        {COLUMNS.map((col) => (
          <div
            key={col}
            className="flex w-72 shrink-0 flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding-12)"
          >
            <div className="flex items-center gap-2">
              <Bar w={84} />
              <span className="block h-5 w-6 rounded-full bg-(--el-muted)" aria-hidden />
            </div>
            <div className="flex flex-col gap-2">
              {Array.from({ length: CARDS_PER_COLUMN[col] ?? 3 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
