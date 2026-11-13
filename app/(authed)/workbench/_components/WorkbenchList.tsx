'use client';

import {
  SurfaceTitle,
  useSurfaceTitleName,
  useSurfaceTitleResolver,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import { isValidElement, memo, useId, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { CiStateBadge } from '@/components/github/CiStateBadge';
import { Pill } from '@/components/ui/Pill';
import { Avatar, StatusValue } from '../../items/_components/issueCellPrimitives';
import { usePeekRowClick } from '../../items/_components/IssueQuickView';
import { IssueListPager } from '../../items/_components/IssueListPager';
import { workbenchTabHref, type WorkbenchTab } from '@/lib/workbench/tab';
import { HostedModelsProvider } from '@/components/hosted/HostedModelsProvider';
import { INDENT_PX } from '@/components/ui/TreeTable';
import { useLiveRows } from './useLiveRows';
import { useHoldReaderPlace } from './useHoldReaderPlace';
import { ContextMarker, GroupChevron, GroupCount, GroupSlot } from './WorkbenchGroupRow';
import { WorkbenchFixLine } from './WorkbenchFixLine';
import { WorkbenchResumeLine } from './WorkbenchResumeLine';
import { PlanningSessionResumeEntry } from './PlanningSessionResumeEntry';
import {
  initiallyExpandedGroups,
  workbenchGroupDisplayRows,
  type WorkbenchRowView,
} from './workbenchRows';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';
import type { ReactNode } from 'react';

// The Workbench list (Story MOTIR-2649 · MOTIR-2653, renamed and widened by
// Story MOTIR-4777 · MOTIR-4782, per `design/workbench/design-notes.md`
// §Layout) — all five tabs render the SAME list. Two of them add something:
// Recently finished adds a FINISHED column, and Watching adds GROUP BANDS.
// Everything else about a row is identical across the five, which is the point:
// a reader switching tabs should be reading the same object.
//
// ⚠️ It composes the shipped `/items` CELLS rather than the shipped `/items`
// ROW, and the design measured why. The `/items` grid is nine columns with a
// minimum width of 1204px; the shell gives a page 896px at a 1200 viewport and
// 976 at 1280, so that row does not fit at any common laptop width (which is
// the known MOTIR-1307 clipping — Home must not inherit it). Home's set is
// `Title · Your role · Assignee · Status`, minimum 622px, and it uses
// `IssueTypeIcon`, the row `Avatar` and `StatusValue` unchanged, so a cell
// renders identically here and on /items.
//
// ⚠️ THE PROJECT CHIP IS GONE (MOTIR-2761). It was here because Home spanned
// every project the reader could browse and a row had to say which one it came
// from. Home now reads the ACTIVE project, so every row would carry the same
// value as the switcher two rows above it — a column that repeats the page's own
// header is not information. ONE cell exists only here now: YOUR ROLE (the
// merged assigned-OR-reported read is the story's central decision, and this is
// the only place a reader can see the dedupe hold — a `Both` row appears
// exactly once).
//
// Below `md` the row COLLAPSES to two lines rather than clipping: the meta
// wrapper is a wrapping flex row at narrow widths and `display: contents` at
// `md`, so its three cells become grid children of the row itself. One DOM tree,
// two arrangements — no duplicated markup to drift.

/** The Workbench column set. See design-notes §Measurements for the numbers. */
const GRID_TEMPLATE = 'minmax(10rem,1fr) 96px 140px 108px';

/**
 * Recently finished adds `Finished (96)` — minimum 734px, still inside the
 * 894px content box at a 1200 viewport (design-notes §Recently finished).
 *
 * A separate NAMED template rather than a conditional sixth column spliced onto
 * the shared string: the template is read by BOTH the header and every row, and
 * the two must agree or the columns shear. One name per column set is what makes
 * disagreeing impossible.
 */
const GRID_TEMPLATE_FINISHED = 'minmax(10rem,1fr) 96px 140px 108px 96px';

/** The whole-row navigation + peek link, stretched behind the cells. */
function RowLink({ row, label }: { row: WorkbenchRowView; label: string }) {
  const onPeekClick = usePeekRowClick();
  return (
    <Link
      href={`/items/${row.identifier}`}
      aria-label={label}
      onClick={(e) => onPeekClick(e, row.identifier)}
      className="absolute inset-0 z-0 focus:outline-none"
    />
  );
}

/** The assignee cell — the shipped row `Avatar`, badged when an agent is on it. */
function AssigneeCell({ row }: { row: WorkbenchRowView }) {
  const t = useTranslations('workbench');
  if (!row.assigneeName) {
    // Same pair as the identifier above: this sits in a row whose hover fill is
    // `--el-surface`, where muted fails AA. The guard cannot see this one (it
    // resolves surfaces per file and this is a sibling function), which is a
    // reason to fix it rather than to leave it.
    return <span className="text-(--el-text-secondary)">{t('row.unassigned')}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      {row.agent ? (
        // The agent badge — the same avatar-with-glyph-badge composition the
        // shipped NotificationRow uses, so the vocabulary is borrowed rather
        // than invented. The glyph is `Bot`, which is what the shipped
        // ExecutorIndicator already shows for `executor: coding_agent`, so the
        // row and the detail rail agree. Decorative: the sr-only span carries
        // the meaning.
        <span className="relative shrink-0">
          <Avatar name={row.assigneeName} />
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--el-executor-agent) text-(--el-accent-text) ring-2 ring-(--el-page-bg)"
          >
            <Bot className="h-2.5 w-2.5" />
          </span>
        </span>
      ) : (
        <Avatar name={row.assigneeName} />
      )}
      <span className="truncate text-(--el-text-secondary)">{row.assigneeName}</span>
      {row.agent ? <span className="sr-only">{t('row.agentExecuting')}</span> : null}
    </span>
  );
}

/**
 * The relative finish time — "yesterday", "2 days ago".
 *
 * `Intl.RelativeTimeFormat` in the ACTIVE locale rather than a hand-rolled
 * string table, so `zh` gets its own phrasing for free and neither catalogue
 * carries a plural form per day. The window is seven days, so `day` is the only
 * unit that can occur, and `numeric: 'auto'` is what turns −1 into "yesterday"
 * rather than "1 day ago". Clamped at 0: a clock skew must not render "in 1 day"
 * on a list of finished work.
 */
function useFinishedLabel(): (iso: string) => string {
  const locale = useLocale();
  return (iso: string) => {
    const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      -Math.max(days, 0),
      'day',
    );
  };
}

/**
 * The cards stuck WITH the head (MOTIR-7589; `design/workbench/design-notes.md` § 34.3):
 * one 32px line per member, on line 1's columns and indented to the title, each its own
 * link raised over the entry's stretched link. A member line carries no reason and no
 * repair — the entry's one repair is line 2's.
 *
 * Three show; the rest fold behind *Show N more work items* (`ObsolescenceField`'s
 * show-more recipe), local state only. A member that LEAVES while the reader looks (moved
 * to Done, archived) is held IN PLACE with the *Cleared* chip (§ 34.5) until the next
 * load; the clause counts only the ones still stuck.
 */
const MEMBERS_SHOWN = 3;

function useHeldMembers(members: WorkbenchRowView[]): {
  rows: WorkbenchRowView[];
  clearedIds: ReadonlySet<string>;
} {
  // The members seen since this entry mounted, in first-seen order — React's
  // "store information from previous renders" pattern: a render that sees a new member
  // adds it, and one that misses an old member keeps it, marked cleared.
  const [seen, setSeen] = useState(members);
  const fresh = members.filter((m) => !seen.some((s) => s.id === m.id));
  if (fresh.length > 0) setSeen([...seen, ...fresh]);
  const current = new Map(members.map((m) => [m.id, m]));
  const rows = [...seen, ...fresh].map((m) => current.get(m.id) ?? m);
  return {
    rows,
    clearedIds: new Set(rows.filter((m) => !current.has(m.id)).map((m) => m.id)),
  };
}

/**
 * A To resume member's change since the run stopped (Bug MOTIR-8458; § 39.2): *Added
 * since the run stopped* is the neutral chip, *Re-scoped* the lavender tint the entry uses
 * nowhere else. Text inside the member's row, never its own tab stop; the title truncates
 * first and the chip never does.
 */
function ResumeChangeChip({ change }: { change: 'added' | 'rescoped' }) {
  const t = useTranslations('workbench');
  return (
    <span
      data-resume-change={change}
      className={cn(
        'inline-flex shrink-0 items-center rounded-(--radius-badge) border px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] leading-[1.3] font-medium whitespace-nowrap',
        change === 'added'
          ? 'border-(--el-chip-border) bg-(--el-chip-bg) text-(--el-text-secondary)'
          : 'border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)',
      )}
    >
      {change === 'added' ? t('toResume.member.added') : t('toResume.member.rescoped')}
    </span>
  );
}

function EntryMembers({
  head,
  members,
  held,
  gridTemplateColumns,
  label,
}: {
  head: WorkbenchRowView;
  members: WorkbenchRowView[];
  held: boolean;
  gridTemplateColumns: string;
  /** The list's accessible name — To fix's *stuck with*, To resume's *waiting with*. */
  label: string;
}) {
  const t = useTranslations('workbench');
  const resolveTitle = useSurfaceTitleResolver();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const { rows, clearedIds } = useHeldMembers(members);
  if (rows.length === 0) return null;
  const folded = rows.length - MEMBERS_SHOWN;
  const shown = open || folded <= 0 ? rows : rows.slice(0, MEMBERS_SHOWN);
  // § 39.2: what the fold hides that the run never touched, beside the button.
  const foldedAdded = rows.slice(MEMBERS_SHOWN).filter((m) => m.resumeChange === 'added').length;
  return (
    <>
      <ul
        id={listId}
        aria-label={label}
        data-testid={`workbench-fix-members-${head.identifier}`}
        className="m-0 list-none p-0 pb-1.5"
      >
        {shown.map((m) => {
          const cleared = clearedIds.has(m.id);
          return (
            <li
              key={m.id}
              data-testid={`workbench-fix-member-${m.identifier}`}
              data-cleared={cleared ? 'true' : undefined}
              className="group/member relative z-10 flex flex-col gap-1 py-1 pl-6 md:grid md:h-8 md:items-center md:gap-x-4 md:py-0 md:pl-6"
              style={{ gridTemplateColumns }}
            >
              <Link
                href={`/items/${m.identifier}`}
                aria-label={`${m.identifier} ${resolveTitle(m.id, m.title).name}`}
                className="absolute inset-0 rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              />
              <span className="flex min-w-0 items-center gap-2 max-md:flex-wrap max-md:gap-y-0.5">
                <IssueTypeIcon type={m.kind} className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
                  {m.identifier}
                </span>
                <SurfaceTitle
                  id={m.id}
                  title={m.title}
                  className={cn(
                    'min-w-0 truncate text-[12.5px] group-hover/member:underline',
                    held || cleared ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
                  )}
                />
                {m.resumeChange ? <ResumeChangeChip change={m.resumeChange} /> : null}
              </span>
              <span className="hidden min-w-0 items-center md:flex">
                <span className="truncate text-xs text-(--el-text-secondary)">
                  {t(`row.role.${m.role}`)}
                </span>
              </span>
              <span className="hidden min-w-0 items-center text-xs md:flex">
                <AssigneeCell row={m} />
              </span>
              <span className="hidden min-w-0 items-center md:flex">
                {cleared ? (
                  <Pill tone="neutral">{t('live.cleared')}</Pill>
                ) : (
                  <StatusValue
                    statusKey={m.status}
                    category={m.statusCategory}
                    label={m.statusLabel}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {folded > 0 ? (
        <div className="pb-2.5 pl-6">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
            data-testid={`workbench-fix-members-toggle-${head.identifier}`}
            className="relative z-10 text-xs font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {open ? t('toFix.entry.showFewer') : t('toFix.entry.showMore', { count: folded })}
          </button>
          {!open && foldedAdded > 0 ? (
            <span
              data-testid={`workbench-fix-members-added-${head.identifier}`}
              className="ml-2.5 text-xs text-(--el-text-secondary)"
            >
              {t('toResume.fold.added', { count: foldedAdded })}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function WorkbenchRowImpl({
  row,
  showFinished,
  arrived = false,
  withFixLine = false,
  withResumeLine = false,
  held = false,
  viewerId = null,
  onContinueStarted,
  group = null,
}: {
  row: WorkbenchRowView;
  showFinished: boolean;
  /** It arrived while the reader was looking — design-notes § 26, Panel 1. */
  arrived?: boolean;
  /** The To fix tab: a second line, the FIX LINE, under line 1 (§ 30 Panel 2). */
  withFixLine?: boolean;
  /** The To resume tab: line 2, the gate list and the next-step line (§ 35.4). */
  withResumeLine?: boolean;
  /** It left the tab's set while the reader looked, and is HELD (§ 30 Panel 3). */
  held?: boolean;
  /** The session's user, for a Continue hosted refusal that names them. */
  viewerId?: string | null;
  /** A Continue hosted press started, or found the row stale: re-read the window. */
  onContinueStarted?: () => void;
  /**
   * A GROUPED work tab's row (§ 36): what leads the title — the group's chevron or the
   * reserved slot — whether it is a member indented under its head, and, on a group row,
   * the count and whether the head is only context. `null` on every other tab.
   */
  group?: {
    lead: ReactNode;
    child: boolean;
    /** Set on a GROUP row: whether its head is on the tab or only context. */
    head?: 'member' | 'context';
    count?: ReactNode;
  } | null;
}) {
  const t = useTranslations('workbench');
  const shownTitleName = useSurfaceTitleName(row.id, row.title);
  const finishedLabel = useFinishedLabel();
  // A CONTEXT head (§ 36.2) is not on the tab: it keeps its Status pill, which says where
  // the container is, and drops what would read as the reader's — role, assignee, CI and a
  // finish it has not had. Its title goes secondary, still AA on the hover fill.
  const context = group?.head === 'context';
  const gridTemplateColumns = showFinished ? GRID_TEMPLATE_FINISHED : GRID_TEMPLATE;
  const cells = (
    <>
      <div role="cell" className="flex min-w-0 items-center">
        <RowLink row={row} label={`${row.identifier} ${shownTitleName}`} />
        <span
          className="flex min-w-0 items-center gap-2"
          // A member sits one tree level in: `TreeTable`'s indent, `/ready`'s `ml-[22px]`.
          style={group?.child ? { marginLeft: INDENT_PX } : undefined}
        >
          {group?.lead}
          <IssueTypeIcon type={row.kind} className="h-4 w-4 shrink-0" />
          {/* ⚠️ `--el-text-secondary`, NOT the `--el-text-muted` the /items row
              uses for the same identifier. Muted clears AA on the white page by
              0.04 and FAILS on `--el-surface` (4.17:1) — which is this row's
              hover fill, so the key would drop below AA exactly while the
              pointer is on it. `tests/theme/inkContrastLint.test.ts` catches it
              here and not on /items only because that row keeps its ink and its
              surface in two different files; the pair is the same. */}
          <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
            {row.identifier}
          </span>
          <SurfaceTitle
            id={row.id}
            title={row.title}
            className={cn(
              'min-w-0 flex-1 truncate group-hover:underline',
              // A HELD row's title goes secondary (§ 30 Panel 3) — still AA on the
              // `--el-surface` hover fill.
              held || context ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
            )}
          />
          {group?.count}
          {/* THE CI BADGE (MOTIR-5475), in the TITLE cell and in its GLYPH form —
              the same placement and the same shared rule as the `/items` row.
              The column set above is UNCHANGED: the title track is the only
              flexible one, so a ~20px glyph adds no fixed width and the row's
              622px minimum and its measured 440px title track at 1200 both hold.
              *Recently finished* needs no special case — it lists done-category
              items, and `ciBadgeState` draws nothing for those. */}
          {context ? null : (
            <CiStateBadge ciState={row.ciState} statusCategory={row.statusCategory} form="glyph" />
          )}
          {/* ARRIVED under the reader (§ 26, Panel 1) — a WORD in the shipped
              neutral `Pill`, kept until the next load. It rides at the end of
              the title cell, which at `< md` is the end of the row's first line. */}
          {arrived ? <Pill tone="neutral">{t('live.new')}</Pill> : null}
        </span>
      </div>

      {/* The meta line. `md:contents` promotes these three to grid children of
          the row at `md`; below it they wrap as one indented flex line. */}
      <div
        role="presentation"
        className="flex flex-wrap items-center gap-2 pl-6 md:contents"
        // Narrow keeps the member's indent on its second line too (§ 36.8).
        style={group?.child ? { paddingLeft: 24 + INDENT_PX } : undefined}
      >
        <div role="cell" className="flex min-w-0 items-center">
          {context ? (
            <ContextMarker />
          ) : (
            <span
              className={cn(
                'truncate text-xs',
                // `Both` takes weight as well as ink — the non-colour redundant
                // cue (finding #35), and the one value worth spotting.
                row.role === 'both'
                  ? 'font-medium text-(--el-text-strong)'
                  : 'text-(--el-text-secondary)',
              )}
            >
              {t(`row.role.${row.role}`)}
            </span>
          )}
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          {context ? null : <AssigneeCell row={row} />}
        </div>
        <div role="cell" className="flex min-w-0 items-center">
          <StatusValue
            statusKey={row.status}
            category={row.statusCategory}
            label={row.statusLabel}
          />
        </div>
        {/* Recently finished only. `--el-text-secondary` for the same reason the
            identifier above takes it: this cell sits in a row whose hover fill is
            `--el-surface`, where `--el-text-muted` is 4.17:1 and fails AA. */}
        {showFinished ? (
          <div role="cell" className="flex min-w-0 items-center">
            <span className="truncate text-xs text-(--el-text-secondary)">
              {row.completedAt && !context ? finishedLabel(row.completedAt) : ''}
            </span>
          </div>
        ) : null}
      </div>
    </>
  );

  const rowClass = cn(
    'group relative border-b border-(--el-border) last:border-b-0',
    'hover:bg-(--el-surface) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:outline-none focus-within:-outline-offset-2',
  );

  // THE TO FIX ROW (§ 30 Panel 2): line 1 is this row BYTE FOR BYTE, as a grid of its
  // own, and the fix line spans every column beneath it. The stretched link is
  // positioned against the OUTER row, so the whole two-line row still opens the card.
  if (withFixLine && row.fix) {
    return (
      <div
        role="row"
        data-testid={`workbench-row-${row.identifier}`}
        data-held={held ? 'true' : undefined}
        className={cn(
          rowClass,
          'flex flex-col gap-1 px-4 py-2.5 md:pt-0 md:pr-7 md:pb-2.5 md:pl-4',
        )}
      >
        <div
          role="presentation"
          className="flex flex-col gap-1 md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0"
          style={{ gridTemplateColumns }}
        >
          {cells}
        </div>
        <WorkbenchFixLine
          itemKey={row.identifier}
          title={row.title}
          reason={row.fix.reason}
          detail={row.fix.detail}
          carried={
            row.fixGroupKind === 'run' || row.fixGroupKind === 'prs'
              ? { kind: row.fixGroupKind, count: row.members.length }
              : null
          }
          held={held}
          canContinueHosted={row.canContinueHosted}
          canFixHosted={row.canFixHosted}
          repairRun={row.repairRun}
          viewerId={viewerId}
          onStarted={onContinueStarted}
          onStateMoved={onContinueStarted}
        />
        {row.members.length > 0 ? (
          <EntryMembers
            head={row}
            members={row.members}
            held={held}
            gridTemplateColumns={gridTemplateColumns}
            label={t('toFix.entry.membersLabel', { key: row.identifier })}
          />
        ) : null}
      </div>
    );
  }

  // THE TO RESUME ENTRY (§ 35.4): § 34's anatomy — line 1 unchanged, then the calm line 2,
  // the gate list, the next-step line, and the cards waiting with the head.
  if (withResumeLine && row.resume) {
    return (
      <div
        role="row"
        data-testid={`workbench-row-${row.identifier}`}
        data-held={held ? 'true' : undefined}
        className={cn(
          rowClass,
          'flex flex-col gap-1 px-4 py-2.5 md:pt-0 md:pr-7 md:pb-2.5 md:pl-4',
        )}
      >
        <div
          role="presentation"
          className="flex flex-col gap-1 md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0"
          style={{ gridTemplateColumns }}
        >
          {cells}
        </div>
        <WorkbenchResumeLine
          itemKey={row.identifier}
          resume={row.resume}
          carried={row.members.length}
          held={held}
          canContinueHosted={row.canContinueHosted}
          viewerId={viewerId}
          onStarted={onContinueStarted}
          onStateMoved={onContinueStarted}
        />
        {row.members.length > 0 ? (
          <EntryMembers
            head={row}
            members={row.members}
            held={held}
            gridTemplateColumns={gridTemplateColumns}
            label={t('toResume.entry.membersLabel', { key: row.identifier })}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="row"
      data-testid={
        group?.head ? `workbench-group-${row.identifier}` : `workbench-row-${row.identifier}`
      }
      data-group-head={group?.head}
      className={cn(
        rowClass,
        'flex flex-col gap-1 px-4 py-2.5',
        'md:grid md:h-11 md:items-center md:gap-x-4 md:gap-y-0 md:py-0 md:pr-7 md:pl-4',
      )}
      style={{ gridTemplateColumns }}
    >
      {cells}
    </div>
  );
}

type WorkbenchRowProps = Parameters<typeof WorkbenchRowImpl>[0];

/** Whether two elements draw the same thing: same type and key, props equal by value. */
function sameElement(a: ReactNode, b: ReactNode): boolean {
  if (a === b) return true;
  if (!isValidElement(a) || !isValidElement(b)) return false;
  if (a.type !== b.type || a.key !== b.key) return false;
  const left = a.props as Record<string, unknown>;
  const right = b.props as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      // A handler is re-created every render and calls the same state setter for
      // the same row (`toggleGroup(id)`), so it is not what makes two draws differ.
      (typeof left[key] === 'function' && typeof right[key] === 'function') ||
      Object.is(left[key], right[key]),
  );
}

/**
 * `React.memo`'s comparator for a row (Story MOTIR-8539 · MOTIR-8574): every prop
 * by identity, except `group`, which a parent builds fresh each render and is
 * compared by what it draws. With `mergeRowsByIdentity` keeping an unchanged
 * row's object, a re-read that moved nothing re-renders no row, and one that
 * changed a row re-renders that row only.
 */
function sameRowProps(prev: WorkbenchRowProps, next: WorkbenchRowProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<
    keyof WorkbenchRowProps
  >;
  for (const key of keys) {
    if (key === 'group') continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  const a = prev.group ?? null;
  const b = next.group ?? null;
  if (a === null || b === null) return a === b;
  return (
    a.child === b.child &&
    a.head === b.head &&
    sameElement(a.lead, b.lead) &&
    sameElement(a.count ?? null, b.count ?? null)
  );
}

const WorkbenchRow = memo(WorkbenchRowImpl, sameRowProps);

/**
 * A Watching GROUP band — what is moving, then what is waiting.
 *
 * The COLUMN-HEADER band's grammar with one label and a count, which is the
 * design's decision: the surface already has exactly one structural band, so
 * reusing it makes a reader read this as STRUCTURE rather than as a row. Two
 * things stop it reading as a SECOND set of column labels, which is the risk of
 * sitting directly under the first — it carries ONE left-aligned label rather
 * than four aligned to the columns, and it carries a COUNT, which a column
 * header never does. 30px against the header's 40px, so the hierarchy shows
 * without a second colour.
 */
function GroupBand({ label, count }: { label: string; count: number }) {
  return (
    <div
      role="row"
      className="flex items-center gap-2 border-b border-(--el-border) bg-(--el-surface-soft) px-4"
      style={{ height: 30 }}
    >
      <div role="rowheader" className="flex min-w-0 items-center">
        <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
          {label}
        </span>
      </div>
      <span className="inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-(--radius-badge) bg-(--el-count-bg) px-(--spacing-chip-x) text-[11px] font-semibold text-(--el-count-text)">
        {count}
      </span>
    </div>
  );
}

/**
 * Split a Watching page at its group boundary.
 *
 * The READ already ordered it — every `in_progress` row ahead of every other,
 * with `(updatedAt DESC, id DESC)` preserved inside each group — so this finds
 * the boundary rather than sorting anything. Doing otherwise would be a
 * client-side re-sort of a keyset-paged list, which is exactly the thing that
 * makes a page boundary stop being exact. A page can hold either group alone,
 * which is why each band is rendered only when its group is non-empty.
 */
function splitWatchingGroups(rows: WorkbenchRowView[]): {
  moving: WorkbenchRowView[];
  waiting: WorkbenchRowView[];
} {
  const boundary = rows.findIndex((row) => row.statusCategory !== 'in_progress');
  return boundary === -1
    ? { moving: rows, waiting: [] }
    : { moving: rows.slice(0, boundary), waiting: rows.slice(boundary) };
}

/** A stable empty default — `useLiveRows` compares its input by identity. */
const NO_SESSIONS: ToResumePlanningSessionDto[] = [];
/** A list mounted without a window (a test, a fixture) re-reads nothing. */
const NO_REREAD = (): void => {};

/** The three tabs that draw their items under a runnable container (§ 36). */
const GROUPED_TABS: ReadonlySet<WorkbenchTab> = new Set(['todo', 'in-progress', 'finished']);

/** A member, tagged with the head it was sent under so a HELD member keeps its group. */
interface MemberEntry {
  headId: string;
  row: WorkbenchRowView;
}

/**
 * The page's expand state (§ 36.5): client-local, keyed by container id, never in the
 * URL. It survives a live update and resets on the next LOAD — a pager move or a tab
 * switch, which is `resetKey`; a reload remounts. A page holding exactly one group opens
 * it on that load.
 */
function useExpandedGroups(
  rows: readonly WorkbenchRowView[],
  resetKey: string,
): [ReadonlySet<string>, (id: string) => void] {
  const [state, setState] = useState(() => ({
    resetKey,
    open: initiallyExpandedGroups(rows) as ReadonlySet<string>,
  }));
  let open = state.open;
  if (state.resetKey !== resetKey) {
    open = initiallyExpandedGroups(rows);
    setState({ resetKey, open });
  }
  const toggle = (id: string) =>
    setState((prev) => {
      const next = new Set(prev.open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, open: next };
    });
  return [open, toggle];
}

/**
 * One group (§ 36.3): the head as a group row and, when open, its members one level in.
 * Its own `rowgroup`, named for the container, which is the structure the eye gets too.
 */
function WorkbenchGroup({
  head,
  members,
  open,
  count,
  arrived,
  arrivedIds,
  showFinished,
  onToggle,
}: {
  head: WorkbenchRowView;
  /** The members to draw — the server's, plus any held in place (§ 36.7). */
  members: WorkbenchRowView[];
  open: boolean;
  /** The server's count; `null` once the group is held after its last member left. */
  count: number | null;
  /** The group row carries `New`: the group arrived, or a member did while it was shut. */
  arrived: boolean;
  arrivedIds: ReadonlySet<string>;
  showFinished: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('workbench.group');
  const id = useId();
  const kind = head.groupHead === 'context' ? 'context' : 'member';
  return (
    <div
      role="rowgroup"
      id={id}
      aria-label={t('members', { key: head.identifier })}
      data-testid={`workbench-group-members-${head.identifier}`}
    >
      <WorkbenchRow
        row={head}
        showFinished={showFinished}
        arrived={arrived}
        group={{
          lead: (
            <GroupChevron itemKey={head.identifier} open={open} controls={id} onToggle={onToggle} />
          ),
          child: false,
          head: kind,
          count: <GroupCount count={count} />,
        }}
      />
      {open
        ? members.map((member) => (
            <WorkbenchRow
              key={member.id}
              row={member}
              showFinished={showFinished}
              arrived={arrivedIds.has(member.id)}
              group={{ lead: <GroupSlot />, child: true }}
            />
          ))
        : null}
    </div>
  );
}

export function WorkbenchList({
  rows,
  label,
  tab,
  pagination,
  empty,
  viewerId = null,
  planningSessions = NO_SESSIONS,
  reread = NO_REREAD,
}: {
  rows: WorkbenchRowView[];
  label: string;
  tab: WorkbenchTab;
  /** The window this list is one page of — the pager's own contract. */
  pagination: { total: number; page: number; pageSize: number };
  /**
   * What an empty tab shows. Drawn HERE for the reason `ApprovalsList`'s own
   * `empty` records in full: a component that only exists once the first row
   * has landed cannot know that the row arrived, so the arrival into an empty
   * tab — the one a reader is most certainly watching — was the one this
   * surface could never mark.
   */
  empty: ReactNode;
  /** The session's user — a Continue hosted `taken` refusal naming them reads *you*. */
  viewerId?: string | null;
  /**
   * The reader's failed planning sessions on this page of TO RESUME (Story MOTIR-7905 ·
   * MOTIR-7917), in the read's order. They render BEFORE the gated runs, under the same
   * pager (`pagination.total` counts both) and the same single empty state.
   */
  planningSessions?: ToResumePlanningSessionDto[];
  /**
   * Re-read the window now — what a verb that moved a row calls (Continue, a fix,
   * a resumed session). `useWorkbenchWindow`'s, never a route refresh (MOTIR-8574).
   */
  reread?: () => void;
}) {
  const t = useTranslations('workbench');
  const router = useRouter();
  const showFinished = tab === 'finished';
  // TO FIX (§ 30) draws the fix line, and it is the one work tab that marks a HELD
  // row: it names something the READER must do, like To approve, so it takes To
  // approve's live rule — a row that left the set stays, marked *Cleared*, until the
  // next load, while the strip count has already dropped.
  const isToFix = tab === 'to-fix';
  // TO RESUME (§ 35) takes the same rule: a Resuming entry is HELD until the refetch
  // drops it (§ 35.5), the badge already one lower.
  const isToResume = tab === 'to-resume';
  const holds = isToFix || isToResume;
  const columns = [
    t('columns.title'),
    t('columns.role'),
    t('columns.assignee'),
    t('columns.status'),
    ...(showFinished ? [t('columns.finished')] : []),
  ];
  // THE ARRIVAL MARK, on the four work tabs (Story MOTIR-5238 · MOTIR-5242;
  // design-notes § 26, Panel 1 and planning flag 3). These tabs order
  // `updatedAt desc`, so an arrival lands at the TOP and shifts the rows below
  // it by one — the same rule and the same chip as the queue, where the order
  // puts it at the bottom instead. What the work tabs do NOT take is the HELD
  // row: § 26 scopes that to a row leaving the AWAITING set, because § 20's
  // settled-row rule is about a decision queue. A card that moves To do → In
  // progress leaving the To do list is the list being correct, and holding it
  // would show a card in a tab it is no longer in with nothing to explain why.
  const resetKey = `${tab}:${pagination.page}`;
  const live = useLiveRows(rows, resetKey, (row) => row.id);
  // The sessions take § 26's held-row rule for a session that LEFT on its own (ended
  // elsewhere): it stays until the next load. A session RESUMED here is the exception —
  // § 37: "the row clears when the attempt starts" (MOTIR-9122). Its Resume asks for a
  // re-read, and the read that no longer lists it drops it rather than holding it, which
  // is § 35.5's rule for a gated run, not for a session.
  const liveSessions = useLiveRows(
    planningSessions,
    `${resetKey}:sessions`,
    (entry) => entry.sessionId,
  );
  const [resumedSessionIds, setResumedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const sessionRows = useMemo(
    () =>
      liveSessions.rows.filter(
        (entry) =>
          !(liveSessions.heldIds.has(entry.sessionId) && resumedSessionIds.has(entry.sessionId)),
      ),
    [liveSessions.rows, liveSessions.heldIds, resumedSessionIds],
  );
  const onSessionResumed = (sessionId: string) => {
    setResumedSessionIds((ids) => new Set(ids).add(sessionId));
    reread();
  };
  // THE GROUPED TABS (§ 36.7, § 26 unchanged). The heads above take today's rule: an
  // arrival is marked, a row that leaves is kept in place unmarked until the next load —
  // so a group whose last member left is held WHOLE. The members take the same rule one
  // level down, tracked over the page's flattened member set so the mark lands on the
  // member that arrived, inside its group.
  const grouped = GROUPED_TABS.has(tab);
  const memberEntries = useMemo<MemberEntry[]>(
    () => rows.flatMap((head) => head.groupMembers.map((row) => ({ headId: head.id, row }))),
    [rows],
  );
  const liveMembers = useLiveRows(memberEntries, resetKey, (entry) => entry.row.id);
  const [expanded, toggleGroup] = useExpandedGroups(rows, resetKey);
  // THE READER'S PLACE ON A BURST (§ 39 rule 3): a catch-up that lands several
  // rows above the row in view leaves that row where it was on screen.
  const listRef = useRef<HTMLDivElement>(null);
  useHoldReaderPlace(
    listRef,
    [...sessionRows.map((e) => e.sessionId), ...live.rows.map((r) => r.id)]
      .concat(liveMembers.rows.map((e) => e.row.id))
      .join(','),
  );

  // These tabs hold nothing (see the note above), so `live.rows` empties exactly
  // when the server's does — the branch reads the live set anyway, so the two
  // lists answer *am I empty?* the same way.
  if (live.rows.length === 0 && sessionRows.length === 0) return <>{empty}</>;

  // CONTINUE HOSTED ON A DEAD-RUN ROW (§ 31, MOTIR-6882). The page makes ONE models
  // request however many rows place the control — and NONE when no row does, so a
  // tab of pull-request reasons never asks for a list it will not draw.
  // FIX ON THE HOSTED AGENT on a row a review sent back (§ 32, MOTIR-6930) reads the same
  // one list.
  const hosted =
    (isToFix &&
      live.rows.some(
        (row) =>
          (row.canContinueHosted && row.fix?.detail.repair === 'continue') ||
          (row.canFixHosted && row.repairRun === null),
      )) ||
    (isToResume && live.rows.some((row) => row.canContinueHosted && row.resume !== null));

  const groups = tab === 'watching' ? splitWatchingGroups(live.rows) : null;

  // The server's count for each head on the page; a held head has none to draw.
  const serverCount = new Map(rows.map((head) => [head.id, head.groupMembers.length]));
  const membersOf = (headId: string) =>
    liveMembers.rows.filter((entry) => entry.headId === headId).map((entry) => entry.row);
  // A page's lines, in the service's order, cut into rowgroups: each group its own, and
  // each run of standalone rows one between them.
  const segments: (
    | { type: 'group'; head: WorkbenchRowView }
    | { type: 'rows'; rows: WorkbenchRowView[] }
  )[] = [];
  if (grouped) {
    for (const line of workbenchGroupDisplayRows(live.rows, expanded)) {
      if (line.type === 'group') segments.push({ type: 'group', head: line.head });
      else if (line.child) continue;
      else {
        const last = segments[segments.length - 1];
        if (last?.type === 'rows') last.rows.push(line.row);
        else segments.push({ type: 'rows', rows: [line.row] });
      }
    }
  }
  const list = (
    <div
      ref={listRef}
      data-surface="card"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div role="table" aria-label={label} className="w-full text-sm">
        {/* The column header is hidden below `md`, where there are no columns
            to head — the stacked row labels itself. */}
        {sessionRows.length > 0 ? (
          <div role="rowgroup" data-testid="to-resume-sessions">
            {sessionRows.map((entry) => (
              <PlanningSessionResumeEntry
                key={entry.sessionId}
                entry={entry}
                arrived={liveSessions.arrivedIds.has(entry.sessionId)}
                held={liveSessions.heldIds.has(entry.sessionId)}
                onSettled={reread}
                onResumed={onSessionResumed}
              />
            ))}
          </div>
        ) : null}
        <div role="rowgroup" className={live.rows.length === 0 ? 'hidden' : 'hidden md:block'}>
          <div
            role="row"
            className="sticky top-0 z-20 grid items-center gap-x-4 border-b border-(--el-border) bg-(--el-surface-soft) pr-7 pl-4"
            style={{
              gridTemplateColumns: showFinished ? GRID_TEMPLATE_FINISHED : GRID_TEMPLATE,
              height: 40,
            }}
          >
            {columns.map((c) => (
              <div key={c} role="columnheader" className="flex min-w-0 items-center">
                <span className="truncate text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
                  {c}
                </span>
              </div>
            ))}
          </div>
        </div>
        {/* Watching is banded; the other four are one flat run. Two rowgroups
            rather than one, because that is what the band MEANS — a group is a
            row group, and a screen reader gets the same structure the eye does. */}
        {groups ? (
          <>
            {groups.moving.length > 0 ? (
              <div role="rowgroup">
                <GroupBand label={t('tabs.inProgress')} count={groups.moving.length} />
                {groups.moving.map((row) => (
                  <WorkbenchRow
                    key={row.id}
                    row={row}
                    showFinished={false}
                    arrived={live.arrivedIds.has(row.id)}
                  />
                ))}
              </div>
            ) : null}
            {groups.waiting.length > 0 ? (
              <div role="rowgroup">
                <GroupBand label={t('tabs.toDo')} count={groups.waiting.length} />
                {groups.waiting.map((row) => (
                  <WorkbenchRow
                    key={row.id}
                    row={row}
                    showFinished={false}
                    arrived={live.arrivedIds.has(row.id)}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : grouped ? (
          segments.map((segment) =>
            segment.type === 'group' ? (
              <WorkbenchGroup
                key={segment.head.id}
                head={segment.head}
                members={membersOf(segment.head.id)}
                open={expanded.has(segment.head.id)}
                count={serverCount.get(segment.head.id) ?? null}
                arrived={
                  live.arrivedIds.has(segment.head.id) ||
                  (!expanded.has(segment.head.id) &&
                    membersOf(segment.head.id).some((m) => liveMembers.arrivedIds.has(m.id)))
                }
                arrivedIds={liveMembers.arrivedIds}
                showFinished={showFinished}
                onToggle={() => toggleGroup(segment.head.id)}
              />
            ) : (
              <div role="rowgroup" key={`rows-${segment.rows[0]!.id}`}>
                {segment.rows.map((row) => (
                  <WorkbenchRow
                    key={row.id}
                    row={row}
                    showFinished={showFinished}
                    arrived={live.arrivedIds.has(row.id)}
                    group={{ lead: <GroupSlot />, child: false }}
                  />
                ))}
              </div>
            ),
          )
        ) : (
          <div role="rowgroup">
            {live.rows.map((row) => (
              <WorkbenchRow
                key={row.id}
                row={row}
                showFinished={showFinished}
                arrived={live.arrivedIds.has(row.id)}
                withFixLine={isToFix}
                withResumeLine={isToResume}
                held={holds && live.heldIds.has(row.id)}
                viewerId={viewerId}
                onContinueStarted={reread}
              />
            ))}
          </div>
        )}
      </div>
      {/* The pager — the LAST ROW INSIDE the bordered box, which is the change
          `design/workbench/` Panel 8 draws: it sat OUTSIDE, as two loose links
          under the list, which reads as page furniture rather than as part of
          the list. Inside, it reads as the list's own last row — the same
          relationship `/items` has, so a reader who has used one surface knows
          how the other works without being taught.

          COMPOSED, not forked: this is `/items`' own `IssueListPager`, mounted
          exactly the way `IssueListTable` mounts it — presentational, raising
          `onPage`, with the parent owning the navigation. The Workbench already
          imports across this boundary for `issueCellPrimitives` and
          `IssueQuickView`.

          ⚠️ `router.push`, NOT `shallowPush`. The page's body is data the
          browser does not have — a different window of rows the SERVER must
          read — which is the discriminator `CLAUDE.md` § URL state draws, and
          the same call `/items`' own pager makes. */}
      <IssueListPager
        total={pagination.total}
        page={pagination.page}
        pageSize={pagination.pageSize}
        onPage={(page) => router.push(workbenchTabHref(tab, page))}
      />
    </div>
  );
  return hosted ? <HostedModelsProvider>{list}</HostedModelsProvider> : list;
}
