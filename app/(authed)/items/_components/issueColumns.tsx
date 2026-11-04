import { SurfaceTitle } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { EpicNotPublicPill } from '@/components/issues/EpicNotPublicPill';
import type { ReactNode } from 'react';
import type { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { CiStateBadge } from '@/components/github/CiStateBadge';
import { DecisionWaitingMarker } from '@/components/approvals/DecisionWaitingMarker';
import { ToFixTag } from '@/components/workItems/ToFixTag';
import { ObsolescenceBadge } from '@/components/issues/ObsolescenceBadge';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { ParentRollupBadge } from '@/components/issues/ParentRollupBadge';
import type { IssueSortColumn } from '@/lib/issues/issueListView';
import { Avatar } from './issueCellPrimitives';
import {
  InlineStatusCell,
  InlineAssigneeCell,
  InlinePriorityCell,
  InlineEstimateCell,
} from './IssueInlineEdit';
import type { IssueRowData } from './issueRows';

// A next-intl global translator (from `useTranslations()` with no namespace), so
// the column builder can reach both the `issues.columns.*` headers and the
// `labels.priority.*` enum labels with full-path keys.
type Translator = ReturnType<typeof useTranslations>;

// The single source of truth for the /items row cells + column metadata
// (Subtask 2.5.8). BOTH views compose these: the nested Tree table (2.5.3,
// `IssueTreeTable`) maps them onto the generic `TreeTable` primitive, and the
// flat sortable List table (`IssueListTable`) renders them un-nested with
// sortable headers — so a cell renders IDENTICALLY in either view
// (design/work-items/tree.png + list.mock.html). Extracted here so neither
// table re-declares the cells; the columns are Title · Type · Priority ·
// Assignee · Reporter · Est. · Points · Status (Due is intentionally not a
// list/tree column — see the note where it used to sit).
//
// Status is the LAST column. MOTIR-4258 removed the trailing 76px row-actions
// cell that used to follow it: the row's own click already opens the quick-view
// peek (`usePeekRowClick`, MOTIR-1306) and the peek carries the item's doors, so
// the ⋯ menu was a second, narrower entrance to what the row already offers.

// The STATUS_TONE map, the row `Avatar`, and the status/assignee cell VALUE
// renderers now live in the leaf `issueCellPrimitives` module, so the inline-edit
// cells (IssueInlineEdit) can share them without an import cycle. The STATUS and
// ASSIGNEE columns below render those inline-edit cells (read-only outside an
// `IssueInlineEditProvider`, editable within one — Subtask 2.5.5).

/**
 * One issue-list column. `cell` renders the row body (shared by both views);
 * `width`/`align` shape the grid; `sortColumn` is the {@link IssueSortColumn}
 * the List header sorts by when clicked (the Tree ignores it). The flexible
 * Title column has no `width` (it takes the remaining space) and sorts by the
 * issue `key` — the mono identifier leading the cell, the canonical order. A
 * column with NO `sortColumn` is non-sortable: both tables render its header as
 * a screen-reader-only label, not a sort button. NO column declares one today —
 * the trailing row-actions cell was the only member and MOTIR-4258 removed it —
 * so that branch is kept for a future non-sortable column, not for a live one.
 */
export interface IssueColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'start' | 'end';
  sortColumn?: IssueSortColumn;
  cell: (row: IssueRowData) => ReactNode;
}

// Built per-render with a translator (rather than a module-level const) so the
// headers + the inline priority/"Unassigned" labels resolve in the active
// locale. Both table views (IssueListTable, IssueTreeTable) call this once with
// `useTranslations()` and consume the result.
export function buildIssueColumns(t: Translator): IssueColumn[] {
  return [
    {
      key: 'title',
      header: t('issues.columns.title'),
      sortColumn: 'key',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <IssueTypeIcon type={r.kind} className="h-4 w-4 shrink-0" />
          <span className="shrink-0 font-mono text-xs text-(--el-text-identifier)">
            {r.identifier}
          </span>
          <SurfaceTitle
            id={r.id}
            title={r.title}
            className={`${r.childrenHidden ? 'min-w-20' : 'min-w-0'} flex-1 truncate text-(--el-text) group-hover:underline`}
          />
          {/* A Visitor's PRIVATE epic (MOTIR-6648; design MOTIR-6641) — the row
              stays, marked, with its children withheld and no drill. The title
              keeps a floor and the pill gives way to its lock on a narrow
              (indented tree) row, so the pill never pushes the title out. */}
          {r.childrenHidden ? <EpicNotPublicPill shrinkable /> : null}
          {/* THE CI BADGE (MOTIR-5474), in the TITLE cell and in its GLYPH form —
              both forced by the row's width budget, measured in
              `design/work-items/design-notes.md` § *The CI badge (MOTIR-5471)*.
              The title track is this row's ONLY flexible column, so a badge here
              adds no fixed width and leaves the row's 1204px minimum untouched; a
              dedicated *Checks* column would take it to 1340px and clip at both
              1280 and 1200. The glyph carries `shrink-0`, so the TITLE truncates
              and the badge stays whole. List and Tree share this builder, so both
              views render it identically. */}
          <CiStateBadge ciState={r.ciState} statusCategory={r.statusCategory} form="glyph" />
        </span>
      ),
    },
    {
      // The work-TYPE chip (Story 2.7 type · Subtask 8.8.9) — surfaces each
      // leaf's `type` (code/design/…) via the shipped WorkItemTypeChip, in a
      // dedicated column right after Title so it stays vertically aligned across
      // the tree's per-depth indent (an inline chip would drift with the indent).
      // `null` on containers (epic/story) → the muted em-dash empty-cell
      // convention (no chip). Sortable like Jira's navigator Type column, which
      // also makes the header visible (a non-sortable header renders sr-only).
      // design/work-items/work-type-indicator.mock.html.
      key: 'type',
      header: t('issues.columns.type'),
      width: 116,
      sortColumn: 'type',
      cell: (r) =>
        r.type ? (
          <WorkItemTypeChip type={r.type} />
        ) : (
          <span className="text-(--el-text-secondary)">—</span>
        ),
    },
    {
      key: 'priority',
      header: t('issues.columns.priority'),
      width: 120,
      sortColumn: 'priority',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only chip
      // otherwise. The cell owns its own PRIORITY_META chip rendering.
      cell: (r) => <InlinePriorityCell row={r} />,
    },
    {
      key: 'assignee',
      header: t('issues.columns.assignee'),
      // 176px (was 150): the Dutch header is ONE word the glossary fixes
      // ("VERANTWOORDELIJKE", 155px in the header's uppercase), which cannot wrap,
      // plus the sort caret beside it. Two-word translations wrap instead
      // (MOTIR-7759).
      width: 176,
      sortColumn: 'assignee',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only value
      // otherwise. The cell owns its own avatar/name vs. "Unassigned" rendering.
      cell: (r) => <InlineAssigneeCell row={r} />,
    },
    {
      key: 'reporter',
      header: t('issues.columns.reporter'),
      width: 150,
      sortColumn: 'reporter',
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar name={r.reporterName} />
          <span className="truncate text-(--el-text-secondary)">{r.reporterName}</span>
        </span>
      ),
    },
    // No Due column — due dates aren't a meaningful list/tree axis for Motir's
    // work (Yue): the column is removed from all three views (List · lazy Tree ·
    // static Tree). Due is still editable on the detail page's core-fields rail
    // and remains a filter field + the `due` sort axis in the contract — only the
    // table column is dropped. Removing it also frees ~136px, helping narrow
    // viewports (bug MOTIR-1307).
    {
      key: 'estimate',
      header: t('issues.columns.estimate'),
      // 72px (was 90) — the right-aligned mono duration ("10h 30m" ≈ 69px) fits,
      // and the tighter footprint pushes back the width at which the row starts
      // to clip (bug MOTIR-1307).
      width: 72,
      align: 'end',
      sortColumn: 'estimate',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only value
      // otherwise.
      cell: (r) => <InlineEstimateCell row={r} />,
    },
    {
      // Story points (Subtask 4.3.4) — the agile estimate, a SEPARATE column
      // from the TIME Est. (both coexist, like the detail rail). A LEAF row
      // shows its own inline `EstimateBadge` (own picker + write;
      // `forceStoryPoints` keeps it a points column regardless of the project's
      // display statistic). A PARENT row (4.3.5) shows the rolled-up SUBTREE
      // total instead — the labelled `ParentRollupBadge`, lazily fetched per
      // parent (a roll-up of descendants, distinct from the parent's own
      // estimate, the way Jira rolls child points into an epic).
      key: 'points',
      header: t('issues.columns.points'),
      width: 80,
      align: 'end',
      sortColumn: 'points',
      cell: (r) =>
        r.hasChildren ? (
          <ParentRollupBadge itemId={r.id} variant="compact" className="w-full justify-end" />
        ) : (
          <EstimateBadge
            itemId={r.id}
            storyPoints={r.storyPoints}
            estimateMinutes={r.estimateMinutes}
            forceStoryPoints
            className="w-full justify-end"
          />
        ),
    },
    {
      key: 'status',
      header: t('issues.columns.status'),
      // 168px (was 144; MOTIR-6610, design MOTIR-6608 § *The List / Tree status
      // cell — measured, and the track widens 144 → 168px*). The track holds the
      // status pill, then up to TWO 18px glyphs after 6px gaps: the
      // decision-waiting glyph (MOTIR-5881) and the To fix tag. The widest case,
      // *Implemented* (113.6px) + both glyphs, is 161.6px — 17.6px over the old
      // track — and a to-fix card CAN carry an awaiting decision (a design or
      // decision card with its own red pull request), so a precedence would drop
      // the tag. Measured on the rows: the minimum moves 1148 → 1172px (the old
      // comment's 1240 predated MOTIR-4258's removal of the 76px actions track),
      // the row still fits at 1200, and every view shares this builder. The
      // obsolescence glyph (MOTIR-6677) never meets the tag: a mark exists only on a
      // done card, and the tag never draws on one.
      width: 168,
      sortColumn: 'status',
      // Inline-editable inside an IssueInlineEditProvider (2.5.5); read-only Pill
      // otherwise. The cell owns its own category→tone rendering. The marker sits
      // AFTER it and OUTSIDE its edit trigger, so it is never part of that button;
      // the row link still owns the click (the marker is static).
      // ⚠️ `w-full` IS LOAD-BEARING (found by MOTIR-5880's recording): the edit
      // trigger is `-mx-1 max-w-full`, so inside a shrink-to-fit wrapper its
      // percentage cap resolved against the wrapper's own width — 8px narrower
      // than the pill, because of the negative margins — and *In Progress* / *To
      // Do* broke onto two lines on every row WITHOUT a marker. Filling the cell
      // gives the cap the Status track to resolve against, as it had before.
      cell: (r) => (
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <InlineStatusCell row={r} />
          {/* The mark's glyph (MOTIR-6677, `list--obsolescence.mock.html`): after
              the status pill, before the decision glyph, outside the edit
              trigger. A finished card's widest pairing fits the 144px track. */}
          {r.obsolescence ? <ObsolescenceBadge mark={r.obsolescence} form="glyph" /> : null}
          {r.pendingDecision ? (
            <DecisionWaitingMarker
              form="glyph"
              state={r.pendingDecision.state}
              kind={r.pendingDecision.kind}
              routedToName={r.pendingRoutedToName}
            />
          ) : null}
          {/* THE TO FIX TAG (MOTIR-6610) — the glyph form, after the decision
              glyph when both hold, outside the edit trigger like it. In the STATUS
              cell rather than beside the CI glyph in the title cell, so a red CI
              glyph and the tag sit in different columns (design MOTIR-6608). */}
          <ToFixTag
            fixReason={r.fixReason}
            statusCategory={r.statusCategory}
            form="glyph"
            headKey={r.fixHeadKey}
            fixing={r.fixing === true}
          />
        </span>
      ),
    },
  ];
}
