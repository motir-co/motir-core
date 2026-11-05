'use client';

import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';

// THE AUTHOR NOTE (Story MOTIR-10327 · MOTIR-10342; `design/github/design-notes.md` § 32.8,
// `approve-and-merge--review-path.mock.html` G4) — in the Development frame, below the review
// line and above the pull-request rows, ONLY when the reader is the routed person and the
// GitHub author of every pull request in the set. A note, never a warning: nothing is wrong.
// The host decides whether it draws (the read model's `authorOfEveryPr` and `viewerIsRouted`).

export function AuthorNote() {
  const t = useTranslations('approvalGate.reviewPath.authorNote');
  return (
    <div
      role="note"
      data-testid="author-note"
      className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-(--el-text)"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      <span className="flex flex-col gap-0.5 text-[12.5px]">
        <span className="font-medium">{t('title')}</span>
        <span className="text-(--el-text-secondary)">{t('body')}</span>
      </span>
    </div>
  );
}
