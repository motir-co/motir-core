'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Popover } from './Popover';
import { cn } from '../../utils/cn';
import type { DatePickerFormatter, DatePickerLocale } from './datePickerFormat';
import { useDatePickerFormat } from './DatePickerFormatContext';

/**
 * DatePicker — the design-system replacement for the native `<input type="date">`
 * calendar popup (Subtask 2.4.12, design `design/work-items/datepicker.mock.html`).
 * An `Input`-styled trigger field (selected date or placeholder + a Clear control)
 * opens an anchored `Popover` holding a month grid.
 *
 * Moved into `@motir/design-system` from motir-core's `components/ui/` (Story
 * MOTIR-10551) so any app on the package can use it. It needs no i18n library:
 * the trigger formats the selected date with an INJECTED locale + formatter —
 * the `locale` / `formatDate` props, else the nearest `DatePickerFormatProvider`,
 * else the default (locale `en`, a UTC formatter: `2026-06-03` → `Jun 3, 2026`),
 * resolved per input. The calendar's own strings (month and weekday names,
 * `Select a date`, `Clear date`, `Today`, `Clear`) stay English.
 *
 * Pure presentation: no queries, no Server Actions. The value crosses as an ISO
 * `YYYY-MM-DD` string (or null) — exactly what the issue forms already hold — so
 * the swap is drop-in: `value` + `onChange(next)` + `disabled`. All date math is
 * UTC-based (via `Date.UTC` / `getUTC*`), so there is no off-by-one from
 * local-timezone parsing — the same guard the ISO-string shape already gives the
 * forms.
 *
 * A11y: the WAI-ARIA dialog + grid date-picker pattern, hand-rolled like
 * `Combobox` / `TreeTable`. The trigger is a labelled button (Radix Popover gives
 * it `aria-haspopup="dialog"`); the panel is a labelled `dialog` holding a
 * `role="grid"` of day buttons with roving tabindex + the 2.4.11 keyboard model
 * (arrows / PageUp-Down / Home-End / Enter / Esc). Today carries
 * `aria-current="date"`, the selected day `aria-selected` — per the WAI-ARIA APG
 * (the durable a11y standard; the 2.4.12 card's "aria-current on selected" is the
 * looser reading, deferred to the APG split). Themed through `--el-*` only.
 *
 * @example
 * <DatePicker value={dueDate} onChange={setDueDate} aria-label="Due date" />
 */
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface YMD {
  y: number;
  m: number; // 0-indexed month
  d: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toKey = ({ y, m, d }: YMD) => `${y}-${pad(m + 1)}-${pad(d)}`;
const sameDay = (a: YMD, b: YMD) => a.y === b.y && a.m === b.m && a.d === b.d;

function parseKey(value: string | null): YMD | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

/** Today as a UTC calendar date — matches the UTC formatting the trigger uses. */
function todayUTC(): YMD {
  const now = new Date();
  return { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
}

/** Shift a date by ±days, normalising month/year rollover via Date.UTC. */
function addDays({ y, m, d }: YMD, days: number): YMD {
  const dt = new Date(Date.UTC(y, m, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}

/** Same day-of-month in the month `delta` away, clamped to that month's length. */
function addMonths({ y, m, d }: YMD, delta: number): YMD {
  const base = new Date(Date.UTC(y, m + delta, 1));
  const ny = base.getUTCFullYear();
  const nm = base.getUTCMonth();
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return { y: ny, m: nm, d: Math.min(d, lastDay) };
}

/** The 42 cells (6 weeks) of the month grid, starting on the Sunday on/before the 1st. */
function monthGrid(y: number, m: number): YMD[] {
  const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const start = new Date(Date.UTC(y, m, 1 - firstDow));
  return Array.from({ length: 42 }, (_, i) => {
    const dt = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + i),
    );
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
  });
}

export interface DatePickerProps {
  /** Selected date as an ISO `YYYY-MM-DD` string, or null when unset. */
  value: string | null;
  /** Called with the next `YYYY-MM-DD` string, or null when cleared. */
  onChange: (next: string | null) => void;
  disabled?: boolean;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Accessible name for the trigger + calendar dialog. */
  'aria-label'?: string;
  /** id for the trigger button (e.g. to pair with an external label). */
  id?: string;
  /** Open the calendar as soon as the field mounts (the rail's inline-edit entry). */
  autoOpen?: boolean;
  /** Fired when the calendar closes via Radix (outside-click / Escape / trigger
   *  toggle) — the inline-edit cell uses it to leave edit mode (Subtask 2.5.5).
   *  A day-pick commits through `onChange` and closes directly, so this fires
   *  only for a dismiss-without-pick. */
  onClose?: () => void;
  className?: string;
  /** Locale the trigger formats the date in. Beats a `DatePickerFormatProvider`'s. */
  locale?: DatePickerLocale;
  /** Formatter for the trigger date, `(isoDate, locale) => string`. Beats the provider's. */
  formatDate?: DatePickerFormatter;
}

export function DatePicker({
  value,
  onChange,
  disabled = false,
  placeholder = 'Select a date',
  'aria-label': ariaLabel = 'Date',
  id,
  autoOpen = false,
  onClose,
  className,
  locale,
  formatDate,
}: DatePickerProps) {
  const selected = parseKey(value);
  // Disabled never opens, `autoOpen` included (MOTIR-6173 — the MOTIR-4822 path).
  const [open, setOpen] = useState(autoOpen && !disabled);
  // The month on screen + the day holding roving focus. Seeded on each open.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const seed = selected ?? todayUTC();
    return { y: seed.y, m: seed.m };
  });
  const [focusKey, setFocusKey] = useState<string>(() => toKey(selected ?? todayUTC()));

  const gridRef = useRef<HTMLDivElement>(null);
  // Prop → provider → default, per input (the precedence lives in the resolver).
  const format = useDatePickerFormat({ locale, formatDate });
  const baseId = useId();
  const captionId = `${baseId}-caption`;
  const today = todayUTC();

  // Move DOM focus to the roving day whenever it (or the open month) changes —
  // a pure DOM side-effect, never setState (the seeding lives in handleOpenChange
  // so this effect can't cascade). The initial autoOpen anchor comes from the
  // useState initializers above.
  useEffect(() => {
    if (!open) return;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`button[data-key="${focusKey}"]`);
    el?.focus();
  }, [open, focusKey, view.y, view.m]);

  // Re-seed the view + roving focus to the selected day (or today) every time the
  // calendar opens — in the open handler, not an effect, so re-opening after an
  // external value change re-anchors without a setState-in-effect cascade.
  function handleOpenChange(next: boolean) {
    if (disabled) return;
    if (next) {
      const anchor = parseKey(value) ?? todayUTC();
      setView({ y: anchor.y, m: anchor.m });
      setFocusKey(toKey(anchor));
    } else {
      onClose?.();
    }
    setOpen(next);
  }

  function moveFocus(next: YMD) {
    setView({ y: next.y, m: next.m });
    setFocusKey(toKey(next));
  }

  function select(day: YMD) {
    if (disabled) return;
    onChange(toKey(day));
    setOpen(false);
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    const cur = parseKey(focusKey);
    if (!cur) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        moveFocus(addDays(cur, -1));
        break;
      case 'ArrowRight':
        e.preventDefault();
        moveFocus(addDays(cur, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveFocus(addDays(cur, -7));
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveFocus(addDays(cur, 7));
        break;
      case 'PageUp':
        e.preventDefault();
        moveFocus(addMonths(cur, -1));
        break;
      case 'PageDown':
        e.preventDefault();
        moveFocus(addMonths(cur, 1));
        break;
      case 'Home': {
        e.preventDefault();
        const dow = new Date(Date.UTC(cur.y, cur.m, cur.d)).getUTCDay();
        moveFocus(addDays(cur, -dow));
        break;
      }
      case 'End': {
        e.preventDefault();
        const dow = new Date(Date.UTC(cur.y, cur.m, cur.d)).getUTCDay();
        moveFocus(addDays(cur, 6 - dow));
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        select(cur);
        break;
      // Escape is handled by Radix Popover (closes + returns focus to the trigger).
    }
  }

  const cells = monthGrid(view.y, view.m);
  const triggerLabel = selected && value ? format.formatDate(value) : placeholder;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Popover.Anchor asChild>
        <div
          className={cn(
            'flex h-(--height-input) w-full items-center gap-2 rounded-(--radius-input) border bg-(--el-page-bg)',
            'border-(--el-border-strong) px-(--spacing-input-x)',
            'focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:ring-offset-2 focus-within:ring-offset-background',
            disabled && 'cursor-not-allowed opacity-50',
            className,
          )}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              id={id}
              disabled={disabled}
              aria-label={ariaLabel}
              className="flex flex-1 items-center gap-2 truncate bg-transparent text-left text-sm outline-none disabled:cursor-not-allowed"
            >
              <Calendar className="h-4 w-4 shrink-0 text-(--el-icon-field)" aria-hidden />
              <span
                className={cn(
                  'flex-1 truncate',
                  selected ? 'text-(--el-text)' : 'text-(--el-text-muted)',
                )}
              >
                {triggerLabel}
              </span>
            </button>
          </Popover.Trigger>
          {selected && !disabled ? (
            <button
              type="button"
              aria-label="Clear date"
              onClick={() => onChange(null)}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger)"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </Popover.Anchor>

      <Popover.Content
        width={296}
        align="start"
        role="dialog"
        aria-label={ariaLabel}
        className="p-3"
        onOpenAutoFocus={(e) => {
          // Focus the roving day, not Radix's default (the first tabbable node).
          e.preventDefault();
          gridRef.current
            ?.querySelector<HTMLButtonElement>(`button[data-key="${focusKey}"]`)
            ?.focus();
        }}
      >
        <div className="mb-2.5 flex items-center justify-between px-1">
          <span
            id={captionId}
            className="text-sm font-semibold text-(--el-text)"
            aria-live="polite"
          >
            {MONTHS[view.m]} {view.y}
          </span>
          <div className="flex gap-0.5">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() =>
                setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))
              }
              className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text)"
            >
              <ChevronLeft className="h-[18px] w-[18px]" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next month"
              onClick={() =>
                setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))
              }
              className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text)"
            >
              <ChevronRight className="h-[18px] w-[18px]" aria-hidden />
            </button>
          </div>
        </div>

        <div ref={gridRef} role="grid" aria-labelledby={captionId} onKeyDown={onGridKeyDown}>
          <div role="row" className="grid grid-cols-7">
            {WEEKDAYS.map((wd, i) => (
              <span
                key={wd}
                role="columnheader"
                aria-label={WEEKDAY_LABELS[i]}
                className="flex h-7 items-center justify-center text-[11px] font-semibold uppercase text-(--el-text-secondary)"
              >
                {wd}
              </span>
            ))}
          </div>
          {Array.from({ length: 6 }, (_, week) => (
            <div role="row" key={week} className="grid grid-cols-7">
              {cells.slice(week * 7, week * 7 + 7).map((day) => {
                const key = toKey(day);
                const isOutside = day.m !== view.m;
                const isSelected = selected ? sameDay(day, selected) : false;
                const isToday = sameDay(day, today);
                return (
                  <div
                    role="gridcell"
                    aria-selected={isSelected}
                    key={key}
                    className="flex justify-center"
                  >
                    <button
                      type="button"
                      data-key={key}
                      tabIndex={key === focusKey ? 0 : -1}
                      aria-label={`${MONTHS[day.m]} ${day.d}, ${day.y}`}
                      aria-current={isToday ? 'date' : undefined}
                      onClick={() => select(day)}
                      className={cn(
                        'relative flex h-(--height-control) w-9 items-center justify-center rounded-(--radius-control) border border-transparent text-sm',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
                        isOutside && 'text-(--el-text-secondary)',
                        !isOutside && 'text-(--el-text)',
                        !isSelected && 'hover:bg-(--el-surface)',
                        isToday && !isSelected && 'border-(--el-border-strong) font-bold',
                        isSelected &&
                          'border-transparent bg-(--el-accent) font-bold text-(--el-accent-text) hover:bg-(--el-accent-pressed)',
                      )}
                    >
                      {day.d}
                      {isToday && !isSelected ? (
                        <span
                          aria-hidden
                          className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-(--el-accent)"
                        />
                      ) : null}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-2.5 flex items-center justify-between border-t border-(--el-border-soft) pt-2.5">
          <button
            type="button"
            onClick={() => moveFocus(todayUTC())}
            className="rounded-(--radius-control) px-(--spacing-control-x-6) py-(--spacing-control-y-4) text-sm font-medium text-(--el-link) hover:bg-(--el-surface)"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="rounded-(--radius-control) px-(--spacing-control-x-6) py-(--spacing-control-y-4) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface)"
          >
            Clear
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
