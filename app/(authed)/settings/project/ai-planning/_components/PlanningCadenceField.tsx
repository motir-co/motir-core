'use client';

import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { PlanningCadence } from '@/lib/ai/planningCadence';

// PlanningCadenceField — the Planner card's "Planning cadence" choice on
// Settings › AI planning (design/ai-settings/design-notes.md § Planning
// cadence, mock ai-planning-settings--planning-cadence.mock.html).
//
// The page's first setting that is a CHOICE between two named options rather
// than an on/off switch or a number, so it is a radio group — a switch would
// misstate it (neither option is "off") and a combobox would hide each option's
// help line. There is no `RadioGroup` primitive: the shipped precedent is the
// radio CARD (Settings › Members' access modes, where the card IS the radio)
// with the roving-tabindex, arrow-key interaction of the design system's
// `AxisRadioGroup`. This composes those two, and nothing new.
//
// It is a CONTROLLED field: the editor owns the working value and the page's
// one shared Save/Cancel footer, so a pick here only makes the page dirty.
//
// Read-only (no `ai:configure`, or no Motir AI connection): both options stay
// in the tree and in the accessibility tree, `aria-disabled`, the current one
// still marked selected — a reader can tell which cadence the project uses.
// Disabled text drops to `--el-text-faint` exactly as `SwitchRow` does.

export const PLANNING_CADENCE_OPTIONS: readonly PlanningCadence[] = ['story', 'subtask'];

export function PlanningCadenceField({
  value,
  onChange,
  disabled,
}: {
  value: PlanningCadence;
  onChange: (next: PlanningCadence) => void;
  disabled: boolean;
}) {
  const t = useTranslations('settings');
  const labelId = useId();
  const hintId = useId();
  const noteId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(delta: number, from: number) {
    const next = (from + delta + PLANNING_CADENCE_OPTIONS.length) % PLANNING_CADENCE_OPTIONS.length;
    onChange(PLANNING_CADENCE_OPTIONS[next]!);
    refs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (disabled) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(1, index);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1, index);
    }
  }

  // Faint is disabled text, so each faint element says so itself, inline — the
  // same `aria-disabled` spread and ink ternary the editor's dependent fields
  // carry, which is the shape the ink-contrast lint reads.

  return (
    <div data-testid="ai-planning-cadence">
      <span
        {...(disabled ? { 'aria-disabled': true } : {})}
        id={labelId}
        className={`block text-sm font-medium ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
      >
        {t('aiPlanning.planner.cadenceLabel')}
      </span>
      <p
        {...(disabled ? { 'aria-disabled': true } : {})}
        id={hintId}
        className={`mt-0.5 max-w-[54ch] text-xs leading-relaxed ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-helper)'}`}
      >
        {t('aiPlanning.planner.cadenceHint')}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={`${hintId} ${noteId}`}
        aria-disabled={disabled || undefined}
        className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {PLANNING_CADENCE_OPTIONS.map((option, index) => {
          const selected = option === value;
          return (
            <button
              key={option}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={disabled || undefined}
              tabIndex={selected && !disabled ? 0 : -1}
              onClick={disabled ? undefined : () => onChange(option)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={`ai-planning-cadence-${option}`}
              className={`flex items-start gap-3 rounded-(--radius-card) border p-(--spacing-card-padding-12) text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) ${
                disabled
                  ? 'cursor-default border-(--el-border)'
                  : selected
                    ? 'border-(--el-accent)'
                    : 'border-(--el-border) hover:border-(--el-border-strong)'
              }`}
            >
              <span
                className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  selected && !disabled ? 'border-(--el-accent)' : 'border-(--el-border-strong)'
                }`}
                aria-hidden
              >
                {selected ? (
                  <span
                    className={`size-2 rounded-full ${disabled ? 'bg-(--el-text-secondary)' : 'bg-(--el-accent)'}`}
                  />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  {...(disabled ? { 'aria-disabled': true } : {})}
                  className={`flex items-center gap-2 text-sm font-medium ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
                >
                  {t(`aiPlanning.planner.cadence.${option}.label`)}
                  {option === 'story' ? (
                    <Pill tone="neutral">{t('aiPlanning.planner.cadenceDefault')}</Pill>
                  ) : null}
                </span>
                <span
                  {...(disabled ? { 'aria-disabled': true } : {})}
                  className={`mt-0.5 block text-xs leading-relaxed ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-helper)'}`}
                >
                  {t(`aiPlanning.planner.cadence.${option}.help`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p
        id={noteId}
        className="text-(--el-text-secondary) mt-2 flex items-start gap-1.5 text-xs leading-relaxed"
      >
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {t('aiPlanning.planner.cadenceScopeNote')}
      </p>
    </div>
  );
}
