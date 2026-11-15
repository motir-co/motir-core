'use client';

import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Funnel, Settings2, TriangleAlert } from 'lucide-react';
import { decodeFilterEnvelope } from '@/lib/filters/ast';
import type { StoredBoardFilterDto } from '@/lib/dto/boards';
import {
  useAdvancedConditionText,
  type AdvancedConditionTextLookups,
} from '../../items/_components/useAdvancedConditionText';

// The board's STORED FILTER indicator (Story MOTIR-10560 · Subtask MOTIR-11335),
// built to `design/boards/board--stored-filter.mock.html` panels 7–8 (§ "Boards
// keep their own stored filter" → "3. Stored filter indicator"). It opens the row
// between the toolbar and the columns, the row the toolbar's applied chips use,
// and is deliberately NOT a chip: a bordered surface-soft box with a control
// radius, a label, the conditions as plain text and no remove control. Clearing
// the toolbar filter never touches it — the stored filter is the board's own.
//
// It shows at most two conditions inline (" · " for match-all, "any of: … or …"
// for match-any) and "+N more"; the full list is on `title` and in the
// `aria-label`. A stale condition (a referent that was deleted) still renders,
// its value as the shared stale-value text, and the box carries a warning glyph
// labelled "matches nothing". The ONLY interactive element is the board admin's
// Edit link to board settings (the design's 7a–8c); a reader without
// `board:configure` — a Visitor included (8d) — gets none.

/** How many conditions the indicator spells out before "+N more". */
export const STORED_FILTER_INLINE_CONDITIONS = 2;

export interface BoardStoredFilterIndicatorProps {
  storedFilter: StoredBoardFilterDto;
  /** The board's facet vocabularies (labels come with the stored filter itself). */
  lookups: Omit<AdvancedConditionTextLookups, 'referencedLabels'>;
  /** Board settings for this board — present only for a board admin. */
  editHref?: string;
}

export function BoardStoredFilterIndicator({
  storedFilter,
  lookups,
  editHref,
}: BoardStoredFilterIndicatorProps) {
  const t = useTranslations('boards');
  const format = useFormatter();
  const text = useAdvancedConditionText({ ...lookups, referencedLabels: storedFilter.labels });

  const decoded = storedFilter.envelope ? decodeFilterEnvelope(storedFilter.envelope) : null;
  const ast = decoded?.ok ? decoded.ast : null;
  const sentences = (ast?.conditions ?? []).map((c) => text.sentence(c));
  const any = ast?.combinator === 'or';

  /** Match-any reads "any of: A or B"; match-all joins with `separator`. */
  const join = (items: string[], separator: string) =>
    any
      ? t('storedFilterIndicatorAny', { conditions: format.list(items, { type: 'disjunction' }) })
      : items.join(separator);
  const inline = sentences.slice(0, STORED_FILTER_INLINE_CONDITIONS);
  const more = sentences.length - inline.length;
  // An envelope that no longer reads has no conditions to name: it matches
  // nothing, which is what the stale mark says.
  const summary = ast ? join(sentences, ', ') : t('storedFilterIndicatorStale');
  const inlineText = ast ? join(inline, ' · ') : t('storedFilterIndicatorStale');
  const stale = storedFilter.staleConditions.length > 0;

  return (
    <div
      role="note"
      data-testid="board-stored-filter-indicator"
      aria-label={t('storedFilterIndicatorAria', { summary })}
      className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) py-(--spacing-control-y-2) pr-(--spacing-control-x-4) pl-(--spacing-control-x-8) text-xs"
    >
      <Funnel className="size-3.5 shrink-0 text-(--el-text-secondary)" aria-hidden />
      <span className="shrink-0 font-semibold text-(--el-text-strong)">
        {t('storedFilterIndicatorLabel')}
      </span>
      <span className="h-3.5 w-px shrink-0 bg-(--el-border)" aria-hidden />
      <span className="min-w-0 truncate text-(--el-text-secondary)" title={summary}>
        {inlineText}
      </span>
      {more > 0 ? (
        <span className="shrink-0 text-(--el-text-secondary)">
          {t('storedFilterIndicatorMore', { count: more })}
        </span>
      ) : null}
      {stale ? (
        <TriangleAlert
          role="img"
          aria-label={t('storedFilterIndicatorStale')}
          data-testid="board-stored-filter-indicator-stale"
          className="size-3.5 shrink-0 text-(--el-warning)"
        />
      ) : null}
      {editHref ? (
        <Link
          href={editHref}
          aria-label={t('storedFilterIndicatorEditAria')}
          data-testid="board-stored-filter-indicator-edit"
          className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Settings2 className="size-3.5" aria-hidden />
          {t('storedFilterIndicatorEdit')}
        </Link>
      ) : (
        <span className="w-1" aria-hidden />
      )}
    </div>
  );
}
