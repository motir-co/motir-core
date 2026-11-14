'use client';

import { useId, type ReactNode } from 'react';
import { Switch } from '@/components/ui/Switch';

// A switch with its visible label + hint (Story 7.13 · MOTIR-919, extracted here
// by Story MOTIR-1615 · MOTIR-1622 for its second consumer).
//
// The accessible name comes by REFERENCE (`aria-labelledby` → the visible
// label), so it can never drift from the text on screen. A DISABLED row keeps
// its layout and drops only its text tokens to `--el-text-faint` — it is
// `disabled`, never `aria-hidden`, so a reader sees the same unavailable option
// a sighted user does.

export function SwitchRow({
  checked,
  onCheckedChange,
  disabled,
  label,
  hint,
  children,
  testId,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
  label: string;
  hint: ReactNode;
  /** Extra content under the hint (e.g. a read-out), sharing the label column. */
  children?: ReactNode;
  testId?: string;
}) {
  const labelId = useId();
  return (
    <div className="flex items-start gap-3.5">
      <span className="mt-0.5">
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-labelledby={labelId}
          {...(testId ? { id: testId } : {})}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span
          id={labelId}
          {...(disabled ? { 'aria-disabled': true } : {})}
          className={
            disabled
              ? 'block text-sm font-medium text-(--el-text-faint)'
              : 'block text-sm font-medium text-(--el-text)'
          }
        >
          {label}
        </span>
        <p
          {...(disabled ? { 'aria-disabled': true } : {})}
          className={
            disabled
              ? 'text-(--el-text-faint) mt-0.5 max-w-[54ch] text-xs leading-relaxed'
              : 'text-(--el-text-helper) mt-0.5 max-w-[54ch] text-xs leading-relaxed'
          }
        >
          {hint}
        </p>
        {children}
      </span>
    </div>
  );
}
