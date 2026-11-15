'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';

// THE QUICK VIEW'S KEY — a copy control, not a link (MOTIR-11351).
//
// The header key used to open the detail page in a new tab, which is what the
// footer's *Open full page* already does. A key in a peek is far more often
// wanted on the clipboard (to paste into a commit, a branch, a chat), so the
// press copies it. Navigation stays on *Open full page* and, for a plan
// proposal, *Open target as it stands*.
//
// It confirms the way the app's other copy controls do (`CommandChip`, the
// canvas node's copy action): the shipped success toast, plus the glyph turning
// into `Check` for two seconds in place. A refused clipboard — an insecure
// context, a denied permission, no Clipboard API at all — says so with an error
// toast and never shows the `Check`, because nothing was copied.
//
// A native `<button>`, so Enter and Space copy it from the keyboard too.

const COPIED_MS = 2000;

export function QuickViewKeyCopy({ identifier }: { identifier: string }) {
  const t = useTranslations('issueViews');
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(identifier);
    } catch {
      toast({ variant: 'error', title: t('quickViewKeyCopyFailed', { key: identifier }) });
      return;
    }
    toast({ variant: 'success', title: t('quickViewKeyCopied', { key: identifier }) });
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [identifier, t, toast]);
  const Glyph = copied ? Check : Copy;
  return (
    <Tooltip content={t('quickViewCopyKeyTooltip')}>
      <button
        type="button"
        onClick={copy}
        aria-label={t('quickViewCopyKeyAria', { key: identifier })}
        data-testid="quick-view-key-copy"
        data-copied={copied ? 'true' : undefined}
        className="group inline-flex shrink-0 cursor-copy items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x-4) font-mono text-[13px] font-medium text-(--el-text-identifier) transition-colors hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {identifier}
        <Glyph
          aria-hidden
          className={`size-3.5 shrink-0 text-(--el-text-secondary) transition-opacity ${
            copied
              ? 'opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          }`}
        />
      </button>
    </Tooltip>
  );
}
