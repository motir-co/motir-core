'use client';

import { useLayoutEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Navigation } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';

// THE "FOLLOW THE WRITING" TOGGLE in the proposal quick view of a card being
// written (MOTIR-11248; design `design/ai-planning/design-notes.md` Part XXX §30.3,
// §30.6, §30.7; `peek-proposal-mode--follow-the-writing.mock.html`).
//
// The overlay's follow vocabulary: `FollowPlannerControl`'s resting recipe and its
// lucide `navigation` glyph, as a TOGGLE (`aria-pressed`) because here the pressed
// state is the only way to stop following without scrolling. The name is the label
// in both states — a toggle whose name changes with its state reads "Following,
// pressed" / "Follow the writing, not pressed" (WAI-ARIA's toggle-button rule).
//
// It decides nothing: following is the panel's (`useFollowWriting`).

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The next focus stop in the header after `from` — Close, or the open-target link. */
export function nextFocusStop(from: HTMLElement): HTMLElement | null {
  const header = from.closest('header');
  if (!header) return null;
  for (const el of header.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el === from || el.closest('[inert]')) continue;
    if (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return el;
  }
  return null;
}

export function FollowWritingControl({
  following,
  onToggle,
}: {
  following: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('planReview.peekLive');
  const ref = useRef<HTMLButtonElement>(null);

  // Writing ended with focus on the control (§30.6): hand focus to the next stop in
  // the header rather than dropping it to <body>. A layout cleanup runs before
  // React removes the button, so it is still in the document and still focused.
  useLayoutEffect(() => {
    const button = ref.current;
    return () => {
      if (!button || !button.isConnected) return;
      if (button.ownerDocument.activeElement !== button) return;
      nextFocusStop(button)?.focus();
    };
  }, []);

  return (
    <Tooltip content={t('followHint')}>
      <button
        ref={ref}
        type="button"
        data-testid="quick-view-live-follow"
        aria-pressed={following}
        onClick={onToggle}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-card) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none aria-pressed:border-(--el-accent) aria-pressed:bg-(--el-tint-lavender) aria-pressed:text-(--el-accent-on-surface) aria-pressed:hover:text-(--el-accent-on-surface)"
      >
        <Navigation
          aria-hidden="true"
          className="size-3.5 shrink-0 text-(--el-accent-on-surface)"
        />
        <span>{t('follow')}</span>
      </button>
    </Tooltip>
  );
}
