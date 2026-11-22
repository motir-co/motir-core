'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';

// THE COMMAND CHIP — a `<code>` chip with an always-visible copy button (extracted from
// the Workbench's fix line, MOTIR-6605, for the review path's `motir review <KEY>`,
// MOTIR-10341; `design/github/design-notes.md` § 32.2). One control for every copyable
// agent command, so the chip, the button and the confirmation read one way everywhere.
//
// The press copies, then confirms with the shipped success toast. With `copiedLabel`, it
// ALSO confirms in place: the glyph becomes `Check` and a polite `role="status"` says
// *Copied* for two seconds (§ 32.2) — a reader who never sees the toast still hears it.
//
// The button stops the event, so a chip inside a row's stretched link copies and does not
// open the row.

const COPIED_MS = 2000;

export interface CommandChipProps {
  command: string;
  /** The button's accessible name, e.g. *Copy motir review ACME-12*. */
  copyLabel: string;
  toastTitle: string;
  toastBody: string;
  /** In-place confirmation words; absent, the press confirms by toast alone. */
  copiedLabel?: string;
  /** A hover / focus tooltip on the button. */
  tooltip?: ReactNode;
  testId?: string;
  /**
   * `compact` is for a chip in a fixed, narrow track (To approve's DETAILS, 220px; the full
   * view's 200px): 11px code, the chip's tightest padding step, a 24px button (WCAG 2.5.8's
   * minimum target) and the *Copied* status read aloud only, out of the flow — so
   * `motir review MOTIR-NNNNN` fits whole (Bug MOTIR-11982). The `Check` glyph and the toast
   * still confirm the press on screen.
   */
  density?: 'default' | 'compact';
}

export function CommandChip({
  command,
  copyLabel,
  toastTitle,
  toastBody,
  copiedLabel,
  tooltip,
  testId,
  density = 'default',
}: CommandChipProps) {
  const compact = density === 'compact';
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await navigator.clipboard.writeText(command);
      toast({ variant: 'success', title: toastTitle, description: toastBody });
      if (copiedLabel) {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }
    },
    [command, copiedLabel, toast, toastBody, toastTitle],
  );
  const button = (
    <button
      type="button"
      onClick={copy}
      aria-label={copyLabel}
      data-testid={testId}
      className={`inline-flex shrink-0 items-center justify-center rounded-(--radius-control) ${compact ? 'h-6 w-6 p-0' : 'h-(--height-control) w-(--height-control) p-(--spacing-icon-btn)'} text-(--el-text-secondary) transition-colors hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`}
    >
      {copied ? (
        <Check className="h-4 w-4" aria-hidden />
      ) : (
        <Copy className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
  return (
    // ⚠️ IT FITS THE BOX IT IS GIVEN (Bug MOTIR-11982). The chip used to be `shrink-0` around
    // a `whitespace-nowrap` code, so a fixed track narrower than the command — To approve's
    // 220px DETAILS track — had the copy button painted over the next column. The code now
    // shrinks and truncates (the whole command on its `title`), and the button never does,
    // so the button always stays inside the chip's box. Copy still copies the full command.
    // The truncate is only the last guard: `density="compact"` is what makes a real key fit.
    <span className="flex max-w-full min-w-0 items-center gap-1">
      <code
        title={command}
        className={`min-w-0 truncate rounded-(--radius-control) bg-(--el-code-bg) ${compact ? 'px-(--spacing-chip-x-4) text-[11px]' : 'px-(--spacing-tooltip-x)'} py-(--spacing-tooltip-y) font-mono whitespace-nowrap text-(--el-code-text)`}
      >
        {command}
      </code>
      {tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button}
      {copiedLabel ? (
        <span
          role="status"
          aria-live="polite"
          className={compact ? 'sr-only' : 'shrink-0 text-xs text-(--el-text-secondary)'}
        >
          {copied ? copiedLabel : ''}
        </span>
      ) : null}
    </span>
  );
}
