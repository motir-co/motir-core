'use client';

import { useTranslations } from 'next-intl';

// A HALTED PLANNING JOB'S "NOT PLANNED YET" LINES (MOTIR-10209; design
// `design/ai-chat/design-notes.md` § _A halted planning job's not-planned-yet list_, mock
// `planning-workspace--not-planned-yet.mock.html`). A hosted job that halts writes no briefing,
// so the lines naming the cards it left unplanned travel on its stop (`walkStop.notPlannedYet`)
// and are drawn here, under the stop line, on each surface that shows that failure.
//
// ⚠️ THE LINES ARE THE PLANNER'S WORDS, ALREADY WRITTEN FOR THE PERSON, in the plan's language.
// They are rendered VERBATIM and IN THE ORDER RECEIVED — never reworded, merged, numbered,
// re-sorted or cut mid-line. Only the list's name and the count line are Motir's copy.
//
// No lines (absent, empty, or a malformed wire value the parser ignored) draws NOTHING, so a
// failure without them renders exactly as it always did.

/** The most lines a ROW (To resume, Plans) shows in full; past it, two lines and a count. */
export const ROW_LINES_MAX = 3;
/** The lines a row keeps when it holds the rest back: the count line takes the third place. */
const ROW_LINES_HELD = 2;

/**
 * The long-list rule. The overlay (`all`) is the destination and shows every line. A row shows one
 * to three lines in full; with four or more it shows the FIRST two and counts the rest — so a row
 * never hides exactly one line behind a count.
 */
export function notPlannedYetShown(
  lines: readonly string[],
  surface: 'all' | 'row',
): { shown: readonly string[]; hidden: number } {
  if (surface === 'all' || lines.length <= ROW_LINES_MAX) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, ROW_LINES_HELD), hidden: lines.length - ROW_LINES_HELD };
}

/**
 * The list under a halted job's stop line. `surface="all"` in the overlay; `surface="row"` on the
 * To resume entry and the Plans row, which hold a long list back behind a count line. The count
 * line is plain text, NOT a control: the row's own door opens the session, where all are shown.
 */
export function NotPlannedYetList({
  lines,
  surface,
}: {
  lines: readonly string[] | null | undefined;
  surface: 'all' | 'row';
}) {
  const t = useTranslations('workbench.planningSession.notPlannedYet');
  if (!lines || lines.length === 0) return null;
  const { shown, hidden } = notPlannedYetShown(lines, surface);
  return (
    <div data-testid="not-planned-yet" className="flex flex-col gap-0.5">
      <ul
        aria-label={t('label')}
        className="flex list-disc flex-col gap-0.5 pl-4 text-xs leading-relaxed text-(--el-text-secondary) marker:text-(--el-text-secondary)"
      >
        {shown.map((line, index) => (
          // The lines may repeat and carry no id; their ORDER is their identity, and it never
          // changes for one record.
          <li key={index} className="break-words">
            {line}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p data-testid="not-planned-yet-more" className="pl-4 text-xs text-(--el-text-secondary)">
          {t('more', { count: hidden })}
        </p>
      ) : null}
    </div>
  );
}
