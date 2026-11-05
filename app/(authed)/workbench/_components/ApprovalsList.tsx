'use client';

import { memo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ApprovalRow, APPROVALS_GRID_TEMPLATE } from '@/components/approvals/ApprovalRow';
import { keepIfEqual, mergeRowsByIdentity, structurallyEqual } from '@/lib/workbench/mergeRows';
import type { WorkbenchApprovalsWindowDto } from '@/lib/dto/workbench';
import { useLiveRows } from './useLiveRows';
import { useTabWindowContent } from './useTabWindowContent';
import type { ApprovalQueueRowDto } from '@/lib/dto/approvalGate';
import type { ReviewToRunRowDTO } from '@/lib/dto/reviewState';
import { ReviewToRunRow } from '@/components/approvals/ReviewToRunRow';

// THE APPROVALS TAB'S LIST (Story MOTIR-4879 · Subtask MOTIR-4794), built to
// `design/workbench/approvals-row.mock.html` and its § 20 in
// `design/workbench/design-notes.md` — AS AMENDED by § 22 (Story MOTIR-5214).
//
// ⚠️ THE ROW IS `components/approvals/ApprovalRow.tsx` (extracted by MOTIR-5302), the
// ONE approvals row the Workbench and the Approval records room both render. Its
// header carries the row's contract: it OPENS the approval overlay, it holds no
// frame and no decide path, and a row decided in the overlay SETTLES in place
// rather than vanishing. This list is the tab's table and its header.
//
// ⚠️ NO PAGER (Story MOTIR-5996 · MOTIR-5998; `design/workbench/design-notes.md`
// § 28, DECISION 5). The tab lists every approval routed to its reader: one
// person's queue is short, and a pager on a short list only hides its oldest
// questions behind a click nobody makes. The read is bounded by the service's
// ceiling, and when that bites, ONE line under the last row says so and points at
// the Approvals room, which lists every one with its own pager.

//
// ⚠️ LIVE IN PLACE (Story MOTIR-8539 · Subtask MOTIR-8581). The server's read is
// the first paint; after it, the rows come from the window the Workbench's one
// read answered (`useTabWindowContent`) — the same response that set the strip's
// To approve count — merged by `gateId`, so an unchanged answer re-renders nothing
// and a changed one re-renders only the rows it changed.

const GRID_TEMPLATE = APPROVALS_GRID_TEMPLATE;
const EMPTY_REVIEWS_TO_RUN: ReviewToRunRowDTO[] = [];

type Ceiling = { shown: number; total: number } | null;

interface ApprovalsContent {
  rows: ApprovalQueueRowDto[];
  ceiling: Ceiling;
  /** The reviews to run routed to the reader (MOTIR-10342; § 32.5) — their own rows. */
  reviewsToRun: ReviewToRunRowDTO[];
}

/** The tab's content out of a window answer — the same shape `<ApprovalsTab>` hands in. */
function contentOf(window: WorkbenchApprovalsWindowDto): ApprovalsContent {
  const { queue } = window;
  return {
    rows: queue.items,
    ceiling: queue.truncated ? { shown: queue.items.length, total: queue.total } : null,
    reviewsToRun: queue.reviewsToRun ?? [],
  };
}

function mergeContent(prev: ApprovalsContent, next: ApprovalsContent): ApprovalsContent {
  const rows = mergeRowsByIdentity(prev.rows, next.rows, (row) => row.gateId);
  const ceiling = keepIfEqual(prev.ceiling, next.ceiling);
  const reviewsToRun = keepIfEqual(prev.reviewsToRun, next.reviewsToRun);
  return rows === prev.rows && ceiling === prev.ceiling && reviewsToRun === prev.reviewsToRun
    ? prev
    : { rows, ceiling, reviewsToRun };
}

/** One row, re-rendered only when its gate, its held state or its `New` mark moved. */
const LiveApprovalRow = memo(function LiveApprovalRow({
  row,
  held,
  arrived,
}: {
  row: ApprovalQueueRowDto;
  held: boolean;
  arrived: boolean;
}) {
  return (
    <ApprovalRow
      // ⚠️ A HELD ROW IS STILL RENDERED — § 26's rule, and the one thing
      // a naive live list gets wrong: the read returns only `awaiting`
      // gates, so a row somebody else decided is simply absent from the
      // next one, and removing it is § 20's settled rule being overturned
      // by a mechanism rather than by a decision.
      record={{ section: held ? 'held' : 'awaiting', row }}
      arrived={arrived}
      // The tab lists only the questions routed to its reader (`listAwaitingMe`),
      // which is what the manual-work row's *is waiting on you* says (§ 33.2).
      routedToReader
    />
  );
});

export function ApprovalsList({
  rows,
  label,
  ceiling,
  empty,
  reviewsToRun = EMPTY_REVIEWS_TO_RUN,
}: {
  rows: ApprovalQueueRowDto[];
  /** The reviews to run on the first paint (MOTIR-10342); the window read's after it. */
  reviewsToRun?: ReviewToRunRowDTO[];
  label: string;
  /**
   * Set when the read's ceiling CUT the set: how many rows are shown and how many
   * are waiting. `null` — the ordinary case — draws nothing.
   */
  ceiling: Ceiling;
  /**
   * What an empty tab shows — rendered HERE rather than instead of this
   * component (Story MOTIR-5238 · MOTIR-5245's E2E finding).
   *
   * ⚠️ THE MOST VISIBLE ARRIVAL IS INTO AN EMPTY TAB, and it was the one
   * arrival that could never be marked. `useLiveRows` answers *what arrived*
   * from the set this component saw LAST — so a component that does not exist
   * until the first row lands has no last set, mounts fresh, and by its own
   * correct rule marks nothing (`arrivedRowIds`: "a reader who has just landed
   * has had nothing arrive under them"). A reader watching *Nothing is waiting
   * on your approval* is the reader most obviously LOOKING, and § 26 Panel 1
   * draws exactly that moment. So the branch moves inside: the component is
   * mounted the whole time and the empty state is one of the things it can
   * draw, which makes the row that replaces it an arrival like any other.
   */
  empty: ReactNode;
}) {
  const t = useTranslations('workbench.approvals');
  const seed = useSeed(rows, ceiling, reviewsToRun);
  const { content } = useTabWindowContent('approvals', seed, contentOf, mergeContent);
  // THE LIVE RULE, for the one tab § 20's settled-row decision is about
  // (Story MOTIR-5238 · MOTIR-5242). The reset key is the "next load" § 26
  // names: a re-read keeps the address and holds its rows. With no pager there is
  // one window, so the key is constant (MOTIR-5998).
  const live = useLiveRows(content.rows, 'approvals', (row) => row.gateId);

  // ⚠️ `live.rows`, NOT `rows` — a HELD row keeps the list non-empty, so a queue
  // the reader has just emptied does not flip to the empty state underneath the
  // receipt of the decision they have only just made (§ 20, § 26).
  if (live.rows.length === 0 && content.reviewsToRun.length === 0) return <>{empty}</>;

  return (
    <div
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div role="table" aria-label={label} className="w-full text-sm">
        {/* Hidden below `md`: it labels a grid that does not exist at that width,
            and a header reading "Work item" above something that is not a column
            is worse than no header (design-notes § 20). */}
        <div role="rowgroup" className="hidden md:block">
          <div
            role="row"
            // A MINIMUM height, and header labels that wrap at a word boundary
            // rather than truncate: "Czas oczekiwania" runs wider than its track
            // (MOTIR-7759).
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) py-1 pr-4 pl-4"
            style={{ gridTemplateColumns: GRID_TEMPLATE, minHeight: 40 }}
          >
            {[t('columns.subject'), t('columns.details'), t('columns.waited'), ''].map((c, i) => (
              <div key={c || `c${i}`} role="columnheader" className="flex min-w-0 items-center">
                <span className="min-w-0 text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase hyphens-auto">
                  {c}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {live.rows.map((row) => (
            <LiveApprovalRow
              key={row.gateId}
              row={row}
              held={live.heldIds.has(row.gateId)}
              arrived={live.arrivedIds.has(row.gateId)}
            />
          ))}
          {/* THE REVIEWS TO RUN (§ 32.5, A2) — after the approvals, never counted with them. */}
          {content.reviewsToRun.map((row) => (
            <ReviewToRunRow key={row.gateId} row={row} gridTemplate={GRID_TEMPLATE} />
          ))}
        </div>
      </div>
      {content.ceiling === null ? null : (
        /* THE CEILING LINE (§ 28, DECISION 5) — a note, never an alert: nothing is
           wrong, the list is merely long. The strip's count stays the true total,
           which is why this line has to say how many are shown. */
        <div
          role="note"
          className="flex flex-wrap items-center gap-x-1 border-t border-(--el-border) bg-(--el-surface-soft) px-4 py-2.5 text-xs text-(--el-text-secondary)"
        >
          {t.rich('ceiling', {
            shown: content.ceiling.shown,
            total: content.ceiling.total,
            link: (chunks) => (
              <Link
                href="/approvals"
                className="font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {chunks}
              </Link>
            ),
          })}
        </div>
      )}
    </div>
  );
}

/** The server's props as one seed object, kept while they are structurally the same. */
function useSeed(
  rows: ApprovalQueueRowDto[],
  ceiling: Ceiling,
  reviewsToRun: ReviewToRunRowDTO[],
): ApprovalsContent {
  const [seed, setSeed] = useState<ApprovalsContent>(() => ({ rows, ceiling, reviewsToRun }));
  if (
    seed.rows !== rows ||
    !structurallyEqual(seed.ceiling, ceiling) ||
    !structurallyEqual(seed.reviewsToRun, reviewsToRun)
  ) {
    const next = { rows, ceiling, reviewsToRun };
    setSeed(next);
    return next;
  }
  return seed;
}
