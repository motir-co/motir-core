'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Segmented } from '@/components/ui/Segmented';
import type { CostsView } from '@/lib/dto/platformCosts';

type ViewKind = CostsView['kind'];

/**
 * The Costs page's PERIOD SWITCH and RANGE PICKER (MOTIR-11712; design
 * MOTIR-11711, § Elements). The view lives in the URL —
 * `?view=day&month=YYYY-MM`, `?view=month&year=YYYY`, `?view=year` — so it is
 * linkable and survives a reload. Switching keeps the reader near where they
 * were: Day → Month opens the shown month's year; Month → Day opens that year's
 * latest month up to now.
 */
export function CostsPeriodControls({
  view,
  today,
  options,
  labels,
}: {
  view: CostsView;
  /** The current UTC day, `YYYY-MM-DD`. */
  today: string;
  /** The picker's choices, newest first, with their display labels. */
  options: { value: string; label: string }[];
  labels: {
    group: string;
    day: string;
    month: string;
    year: string;
    pickMonth: string;
    pickYear: string;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();

  const go = (next: CostsView) => {
    const query = new URLSearchParams({ view: next.kind });
    if (next.kind === 'day') query.set('month', next.month);
    if (next.kind === 'month') query.set('year', next.year);
    router.push(`${pathname}?${query.toString()}`);
  };

  const switchTo = (kind: ViewKind) => {
    if (kind === view.kind) return;
    const currentMonth = today.slice(0, 7);
    const currentYear = today.slice(0, 4);
    if (kind === 'year') return go({ kind: 'year' });
    if (kind === 'month') {
      return go({
        kind: 'month',
        year: view.kind === 'day' ? view.month.slice(0, 4) : currentYear,
      });
    }
    const year = view.kind === 'month' ? view.year : currentYear;
    return go({ kind: 'day', month: year === currentYear ? currentMonth : `${year}-12` });
  };

  const picked = view.kind === 'day' ? view.month : view.kind === 'month' ? view.year : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented<ViewKind>
        label={labels.group}
        value={view.kind}
        onChange={switchTo}
        options={[
          { value: 'day', label: labels.day },
          { value: 'month', label: labels.month },
          { value: 'year', label: labels.year },
        ]}
      />
      {picked !== null ? (
        <>
          <label className="sr-only" htmlFor="costs-range">
            {view.kind === 'day' ? labels.pickMonth : labels.pickYear}
          </label>
          <select
            id="costs-range"
            value={picked}
            onChange={(e) =>
              go(
                view.kind === 'day'
                  ? { kind: 'day', month: e.target.value }
                  : { kind: 'month', year: e.target.value },
              )
            }
            className="h-(--height-input) rounded-(--radius-input) border border-(--el-accent-on-surface) bg-(--el-page-bg) px-(--spacing-control-x-8) font-sans text-sm text-(--el-text)"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </div>
  );
}
