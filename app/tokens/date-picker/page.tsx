'use client';

import { useState } from 'react';
import { DatePicker } from '@motir/design-system';
import { SectionLabel } from '@/components/ui/SectionLabel';

/**
 * /tokens/date-picker — specimen route for the DatePicker primitive (Subtask
 * 2.4.12), built to design/work-items/datepicker.mock.html. Renders the trigger
 * states (placeholder / filled) and an open calendar so the WAI-ARIA dialog +
 * day grid is reviewable and swept by the STRICT axe sweep in
 * tests/e2e/shell-a11y.spec.ts (zero exclusions, color-contrast enabled) — the
 * grid semantics (roving day buttons, aria-current/aria-selected) are proven on
 * the real markup before the issue date fields rely on them.
 *
 * Kept off the big /tokens index (like /tokens/tree-table) so the client-only,
 * portal-rendering calendar doesn't bloat the design-system index.
 */
export default function DatePickerSpecimenPage() {
  const [empty, setEmpty] = useState<string | null>(null);
  const [filled, setFilled] = useState<string | null>('2026-06-04');
  const [open, setOpen] = useState<string | null>('2026-06-04');

  return (
    <main className="mx-auto max-w-[64rem] bg-background px-6 py-10 text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">Date picker</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        The design-system replacement for the native{' '}
        <code>&lt;input type=&quot;date&quot;&gt;</code> calendar (Subtask 2.4.12) — an{' '}
        <code>Input</code>-styled trigger opening a <code>Popover</code> month grid. ISO{' '}
        <code>YYYY-MM-DD</code> value, UTC-safe, full keyboard support (arrows / PageUp-Down /
        Home-End / Enter / Esc), <code>--el-*</code> themed.
      </p>

      <section className="mt-8 flex max-w-[20rem] flex-col gap-2">
        <SectionLabel>Trigger — empty (placeholder)</SectionLabel>
        <DatePicker aria-label="Empty date" value={empty} onChange={setEmpty} />
      </section>

      <section className="mt-8 flex max-w-[20rem] flex-col gap-2">
        <SectionLabel>Trigger — filled (with Clear)</SectionLabel>
        <DatePicker aria-label="Filled date" value={filled} onChange={setFilled} />
      </section>

      <section className="mt-8 flex max-w-[20rem] flex-col gap-2">
        <SectionLabel>Disabled</SectionLabel>
        <DatePicker aria-label="Disabled date" value="2026-06-04" onChange={() => {}} disabled />
      </section>

      <section className="mt-8 flex max-w-[20rem] flex-col gap-2 pb-80">
        <SectionLabel>Open calendar (selected · today · roving focus)</SectionLabel>
        <DatePicker aria-label="Open date" value={open} onChange={setOpen} autoOpen />
      </section>
    </main>
  );
}
