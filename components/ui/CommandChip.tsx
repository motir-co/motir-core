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
}

export function CommandChip({
  command,
  copyLabel,
  toastTitle,
  toastBody,
  copiedLabel,
  tooltip,
  testId,
}: CommandChipProps) {
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
      className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) transition-colors hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {copied ? (
        <Check className="h-4 w-4" aria-hidden />
      ) : (
        <Copy className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
  return (
    <span className="flex shrink-0 items-center gap-1">
      <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono whitespace-nowrap text-(--el-code-text)">
        {command}
      </code>
      {tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button}
      {copiedLabel ? (
        <span role="status" aria-live="polite" className="text-xs text-(--el-text-secondary)">
          {copied ? copiedLabel : ''}
        </span>
      ) : null}
    </span>
  );
}
