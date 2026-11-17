'use client';

import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';

// "Reset to board filter" in the Advanced builder's header, and "Reset" (named
// in full for assistive tech) in the quick Filter popover's header (MOTIR-11565,
// design `board--header-board-filter.mock.html` panel 4). The shipped header-link
// grammar of Clear, with `RotateCcw`, placed before Clear. The host shows it only
// while the header filter differs from the board filter — hidden, not disabled.

export function BoardFilterResetLink({
  onReset,
  short = false,
}: {
  onReset: () => void;
  /** The quick Filter popover's 320px header: "Reset", aria-label in full. */
  short?: boolean;
}) {
  const t = useTranslations('boards.headerFilter');
  return (
    <button
      type="button"
      onClick={onReset}
      aria-label={short ? t('reset') : undefined}
      data-testid="board-filter-reset-link"
      className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-sm text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <RotateCcw className="size-3.5" aria-hidden />
      {short ? t('resetShort') : t('reset')}
    </button>
  );
}
