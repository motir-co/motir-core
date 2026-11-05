'use client';

import { useTranslations } from 'next-intl';
import { nameOfDeciderLabel } from '@/lib/agentReview/verdictActivity';
import { cn } from '@/lib/utils/cn';
import type { ApprovedReviewDTO } from '@/lib/dto/reviewState';

// THE APPROVAL-RECORD LINE (Story MOTIR-10327 · MOTIR-10338; `design/github/design-notes.md`
// § 32.9, `design/workbench/approvals-row--review-path.mock.html` panel A3). One `text-xs`
// `--el-text-secondary` line that says which agent review an approval stood on — read at the
// APPROVED version by the server, so a later push never changes it. A skipped or dismissed
// review carries the person's reason as the line's title (and, for a screen reader, its text).
//
// Secondary ink, never muted: the decided row's hover fill is `--el-surface`, where
// `--el-text-muted` is 4.17:1 (CLAUDE.md, MOTIR-2455).

export function ApprovalReviewLine({
  review,
  deciderLabel,
  className,
}: {
  review: ApprovedReviewDTO;
  /** Who approved, as the record stores it (`Name <email>`); null when nobody is named. */
  deciderLabel: string | null;
  className?: string;
}) {
  const t = useTranslations('approvalGate.reviewPath.record');
  const name = deciderLabel ? nameOfDeciderLabel(deciderLabel) : t('someone');
  const text =
    review.kind === 'reviewed'
      ? t('reviewed', { name, commits: review.commits })
      : review.kind === 'skipped'
        ? t('skipped', { name, who: review.by ?? t('someone') })
        : review.kind === 'dismissed'
          ? t('dismissed', { name, who: review.by ?? t('someone') })
          : t('none', { name });
  const reason = review.kind === 'skipped' || review.kind === 'dismissed' ? review.reason : null;
  return (
    <span
      data-testid="approval-review-line"
      data-review={review.kind}
      className={cn('text-xs text-(--el-text-secondary)', className)}
      title={reason ?? undefined}
    >
      {text}
      {/* The title is a pointer's; a screen reader is read the reason itself. */}
      {reason ? <span className="sr-only">{t('reason', { reason })}</span> : null}
    </span>
  );
}
