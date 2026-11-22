'use client';

import { useTranslations } from 'next-intl';
import type { PlanningSeedGuideDTO } from '@/lib/dto/planningSeed';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

/**
 * THE *FROM A GUIDE* CARD (design MOTIR-8686 sheet 9; Story MOTIR-8684 · MOTIR-8693) —
 * what the conversation is ABOUT, pinned under the opener: the guided card's key and
 * title, a `Planning` status pill, and who confirmed it and when.
 *
 * Composed from {@link FollowUpCard}'s framing in `PlanChangeRail`. Only the offer's
 * owner can read the seed this comes from, and only they can confirm it, so the card
 * says *you*. `--el-text-secondary` on `--el-surface-soft` clears AA; the status sits in
 * a lavender tint chip with `--el-text-strong` ink.
 */
export function GuideOriginCard({ guide }: { guide: PlanningSeedGuideDTO }) {
  const t = useTranslations('planningWorkspace.guideSeed');
  const relativeTime = useRelativeTime();
  // A first open shows the card at the moment of the send, before the offer's
  // confirmation is read back: it reads as just now.
  const when = guide.confirmedAt ? relativeTime(new Date(guide.confirmedAt)) : t('justNow');
  return (
    <div
      data-testid="guide-origin-card"
      className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <p className="text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
        {t('card')}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] font-medium text-(--el-text)">
        <span>
          <span className="font-mono">{guide.guidedKey}</span> · {guide.guidedTitle}
        </span>
        <span className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong)">
          {t('status')}
        </span>
      </p>
      <p className="mt-1.5 text-xs text-(--el-text-secondary)">
        {t('cardBy', { who: t('you'), when })}
      </p>
    </div>
  );
}
