'use client';

import type { ReactNode } from 'react';
import { PenLine } from 'lucide-react';

import { Button } from '@/components/ui/Button';

// A QUESTION'S OPTIONS, DRAWN (MOTIR-11700) — the Grill me question's reading list and
// reply row, extracted so every question Motir puts to a person draws its options the
// same way: the conversation's question, a planning phase's question, the mid-run
// pause and the sharpen interview itself.
//
// Two halves, because the question's bubble holds one and the reply row under it the
// other: `QuestionOptionList` (inside the asking bubble — each option's label and what
// picking it means) and `QuestionOptionReplies` (under it — one button per option and
// the own-words button that puts the cursor in the composer). A click is ONE act, and
// the person can always answer in their own words instead.

/** One option as it is drawn. `detail` is what picking it means. */
export interface PickerOption {
  id: string;
  label: string;
  detail?: string | null;
  /** Grill me's one recommended reading — drawn `primary`, with a badge. */
  recommended?: boolean;
}

export function QuestionOptionList({
  options,
  recommendedLabel,
  testId,
}: {
  options: readonly PickerOption[];
  /** The badge on a recommended option; only needed when one is. */
  recommendedLabel?: string;
  testId?: string;
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1" {...(testId ? { 'data-testid': testId } : {})}>
      {options.map((option) => (
        <li key={option.id} className="text-sm text-(--el-text)">
          <span className="font-semibold">{option.label}</span>
          {option.detail ? (
            <span className="text-(--el-text-secondary)"> — {option.detail}</span>
          ) : null}
          {option.recommended && recommendedLabel ? (
            <span className="ml-1.5 inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-text-strong)">
              {recommendedLabel}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function QuestionOptionReplies({
  options,
  disabled,
  onPick,
  ownWordsLabel,
  onOwnWords,
  optionTestId,
  ownWordsTestId,
  groupLabel,
  accessibleName,
  testId,
  children,
}: {
  options: readonly PickerOption[];
  /** An answer is in flight: every button waits. */
  disabled: boolean;
  onPick: (option: PickerOption) => void;
  ownWordsLabel: string;
  /** Focus the composer for an answer in the person's own words. */
  onOwnWords: () => void;
  /** `data-testid` of an option's button, from its id. */
  optionTestId: (id: string) => string;
  ownWordsTestId: string;
  /** The option row's accessible group name, when it has one. */
  groupLabel?: string;
  /** An option button's accessible name, when it differs from its label. */
  accessibleName?: (option: PickerOption) => string;
  testId?: string;
  /** More replies after the own-words button (Grill me's Skip · You decide · Stop). */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 pl-9" {...(testId ? { 'data-testid': testId } : {})}>
      <div
        className="flex flex-wrap gap-1.5"
        {...(groupLabel ? { role: 'group', 'aria-label': groupLabel } : {})}
      >
        {options.map((option) => (
          <Button
            key={option.id}
            variant={option.recommended ? 'primary' : 'secondary'}
            size="sm"
            data-testid={optionTestId(option.id)}
            {...(accessibleName ? { 'aria-label': accessibleName(option) } : {})}
            disabled={disabled}
            onClick={() => onPick(option)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          data-testid={ownWordsTestId}
          leftIcon={<PenLine className="size-4" aria-hidden />}
          disabled={disabled}
          onClick={onOwnWords}
        >
          {ownWordsLabel}
        </Button>
        {children}
      </div>
    </div>
  );
}

/** A planner question's stored options as the picker draws them: `means` is the detail. */
export function pickerOptionsOf(
  options: readonly { id: string; label: string; means: string }[],
): PickerOption[] {
  return options.map((o) => ({ id: o.id, label: o.label, detail: o.means }));
}
