'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { Check, CircleDashed, FunnelPlus, Search, SlidersHorizontal, UserX, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypeIcon } from '@/components/issues/WorkItemTypeIcon';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import {
  countActiveFilters,
  isFilterActive,
  setFilterText,
  toggleAssignee,
  toggleKind,
  toggleStatus,
  toggleType,
  toggleUnassigned,
  toggleUntyped,
  type IssueFilter,
} from '@/lib/issues/issueListFilter';
import {
  astExceedsFacets,
  clearFacets,
  setAdvancedParam,
  upgradeFacetsIntoAst,
} from '@/lib/issues/issueListAdvancedFilter';
import type { FilterAst } from '@/lib/filters/ast';
import { useAdvancedFilterPopover } from './AdvancedFilterContext';
import { statusDotColor } from '@/lib/workflows/statusColor';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { cn } from '@/lib/utils/cn';
import { Avatar } from './issueCellPrimitives';

// The /items FILTER bar (Subtask 2.5.4) — the [Filter] toolbar control wired
// into a working, URL-driven, multi-select filter over the issue tree (and the
// flat List). Matches design/work-items/filter.mock.html: an enabled
// ToolbarButton (active ring + count badge when ≥1 value is set) opening a
// Popover dialog of four facets — text · kind · status · assignee — each a
// multi-select listbox reusing the Combobox option-row vocabulary (leading glyph
// · label · trailing Check). No new picker primitive.
//
// Filters apply LIVE and serialize to the URL (?kind=&status=&assignee=&q=, the
// assignee=unassigned token = the Unassigned bucket) — there is NO Apply button.
// Every edit recomputes the whole filter and router.push()es the canonical href
// (buildIssueListHref, preserving the active view + sort), so the Server
// Component re-reads the pruned, context-preserving tree (getProjectTree). The
// popover stays open across selections (multi-select); "Clear filters" resets to
// the full tree. The status dot mirrors StatusPicker via shared `statusDotColor`.

// The status dot colour routes through the shared `statusDotColor` helper: a
// per-status hex override, else the per-status `--el-status-*` token (keyed by
// status KEY so in_review / blocked / cancelled differentiate; category
// fallback), so the dot re-skins with a palette change (MOTIR-1273 · 1266.2).
function StatusDot({ status }: { status: WorkflowStatusDto }) {
  const color = statusDotColor(status);
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 rounded-full border border-(--el-border)"
      style={{ backgroundColor: color }}
    />
  );
}

/** A multi-select option row (the Combobox option vocabulary, made selectable). */
function OptionRow({
  selected,
  onToggle,
  glyph,
  label,
  secondary,
  disabled,
}: {
  selected: boolean;
  onToggle: () => void;
  glyph: React.ReactNode;
  label: string;
  secondary?: string;
  /** Read-only mode — the superseded facet popover (Subtask 6.1.4). */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) focus-visible:bg-(--el-surface) focus-visible:outline-none',
        disabled ? 'cursor-default opacity-60' : 'hover:bg-(--el-surface)',
        selected && 'bg-(--el-surface)',
      )}
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center">{glyph}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {secondary ? (
        <span className="max-w-[130px] shrink-0 truncate text-xs text-(--el-text-secondary)">
          {secondary}
        </span>
      ) : null}
      <Check
        aria-hidden
        className={cn(
          'h-4 w-4 shrink-0 text-(--el-accent-on-surface)',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />
    </button>
  );
}

function FacetLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 font-mono text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
      {label}
      {count > 0 ? <span className="text-(--el-text-muted)">· {count}</span> : null}
    </div>
  );
}

export interface IssueFilterBarProps {
  filter: IssueFilter;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  view: IssueListView;
  sort: IssueSort;
  /** The decoded advanced AST (Subtask 6.1.4) — drives the SUPERSEDED state
   * (exactly when the AST exceeds facet expressiveness) and rides into the
   * one-way "Edit in Advanced" upgrade. */
  ast?: FilterAst | null;
  /** Navigation override (Subtask 6.15.3): the board mounts this same bar but
   * its URL state is board-scoped (`?board=` preserved, no view/sort), so it
   * injects `buildBoardFilterHref`. Defaults to the /items `buildIssueListHref`
   * (view + sort preserved). */
  buildHref?: (filter: IssueFilter) => string;
  /** Controlled open, for a host that must open this popover from outside the
   * toolbar (Subtask 6.15.3 added it for the board's over-cap banner, retired
   * by MOTIR-10535). Uncontrolled (internal state) when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function IssueFilterBar({
  filter,
  statuses,
  members,
  view,
  sort,
  ast = null,
  buildHref,
  open: controlledOpen,
  onOpenChange,
}: IssueFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const hrefFor = (next: IssueFilter) =>
    buildHref ? buildHref(next) : buildIssueListHref(pathname, { view, sort, filter: next });
  const t = useTranslations('issueViews');
  const tType = useTranslations('labels.issueType');
  const tWorkType = useTranslations('labels.workItemType');
  const tStatus = useTranslations('labels.defaultStatus');
  // Protected default statuses (To Do · Blocked · In Progress · In Review · Done
  // · Cancelled) cannot be renamed, so their canonical labels are translated by
  // key; a project's custom status renders its stored, user-authored `label`
  // verbatim (user content, not translatable) — the same rule the rest of the app
  // follows for statuses.
  const statusLabel = (s: WorkflowStatusDto) =>
    DEFAULT_STATUS_KEYS.has(s.key) ? tStatus(s.key) : s.label;
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const [memberQuery, setMemberQuery] = useState('');
  const advancedPopover = useAdvancedFilterPopover();

  // SUPERSEDED — the builder holds conditions the facets can't express
  // (OR / negation / empty / comparisons / non-facet fields): the trigger
  // mutes + badges, and the popover goes READ-ONLY with the same hand-off.
  // Never a silent down-conversion (the verified one-way mirror rule).
  const superseded = ast !== null && astExceedsFacets(ast);

  // The text quick-filter is locally controlled for responsiveness, then pushed
  // to the URL debounced (live-apply without a router.push per keystroke).
  const [text, setText] = useState(filter.text ?? '');

  // Re-sync the input when the URL's text changes elsewhere (Clear, browser
  // back/forward): the React-endorsed "adjust state during render on a prop
  // change" pattern (a guarded setState, no effect) — when the user drives the
  // value the guard is a no-op (local text already equals filter.text).
  const [urlText, setUrlText] = useState(filter.text);
  if (filter.text !== urlText) {
    setUrlText(filter.text);
    setText(filter.text ?? '');
  }

  // Selection is OPTIMISTIC. The active filter lives in the URL, so it only
  // reflects back as a new `filter` prop AFTER a push → Server re-read round-trip
  // — driving the check marks / counts straight off `filter` would leave them
  // blank from the click until the navigation (and the issue read) settle, so a
  // selected status simply "doesn't show" (finding #58). Instead we mirror the
  // filter into local state that updates the instant a facet is toggled, render
  // every check mark + count from THAT, and reconcile to the prop when it changes
  // identity (the navigation landed, or an external reset / back-forward) —
  // guarded like `urlText` above so unrelated client re-renders (open /
  // member-search state) can't stomp an in-flight optimistic value.
  //
  // `filterRef` is the synchronous twin of that state: a toggle composes onto
  // `filterRef.current`, not the render-time closure, so two edits fired
  // back-to-back (before any re-render) still stack instead of clobbering.
  const [optimistic, setOptimistic] = useState(filter);
  const [seenFilter, setSeenFilter] = useState(filter);
  if (filter !== seenFilter) {
    setSeenFilter(filter);
    setOptimistic(filter);
  }
  // `filterRef` is reconciled in an effect (not during render — refs mustn't be
  // written there); the `[filter]` dep runs it only when the prop identity
  // changes, so it never stomps an in-flight optimistic value mid-navigation.
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (textTimer.current) clearTimeout(textTimer.current);
    };
  }, []);

  function apply(next: IssueFilter) {
    filterRef.current = next; // sync source: the NEXT toggle composes onto this
    setOptimistic(next); // instant UI: check marks + counts update on click
    router.push(hrefFor(next));
  }

  function onTextChange(value: string) {
    setText(value);
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      apply(setFilterText(filterRef.current, value));
    }, 300);
  }

  // Trigger badge + every check mark / count render from the optimistic mirror.
  const active = isFilterActive(optimistic);
  const count = countActiveFilters(optimistic);
  const memberMatches = members.filter((m) => {
    if (memberQuery.trim() === '') return true;
    const q = memberQuery.trim().toLowerCase();
    return m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
  });

  // The one-way "Edit in Advanced" upgrade (the facet popover's footer):
  // every facet selection carries into the builder as rows — LOSSLESS — and
  // the URL swaps the facet params for the `?filter=v1:` AST in one push.
  function editInAdvanced() {
    const facets = filterRef.current;
    const merged = upgradeFacetsIntoAst(facets, ast);
    if (merged.conditions.length > 0) {
      const next = setAdvancedParam(clearFacets(facets), merged);
      filterRef.current = next;
      setOptimistic(next);
      setText('');
      router.push(hrefFor(next));
    }
    setOpen(false);
    advancedPopover?.setOpen(true);
  }

  const trigger = (
    <button
      type="button"
      aria-label={active ? t('filterActiveAria', { count }) : t('filter')}
      className={cn(
        'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border px-(--spacing-control-x-12) font-sans text-sm hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
        superseded ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
        active ? 'border-(--el-accent) bg-(--el-tint-lavender)' : 'border-(--el-border)',
      )}
    >
      <SlidersHorizontal
        className={cn(
          'h-4 w-4',
          active ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-muted)',
        )}
        aria-hidden
      />
      {t('filter')}
      {active ? (
        <span
          aria-hidden
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-(--radius-badge) bg-(--el-accent) px-(--spacing-chip-x-6) text-[11px] font-semibold text-(--el-accent-text) tabular-nums"
        >
          {count}
        </span>
      ) : null}
      {superseded ? (
        <span
          aria-label={t('filterSupersededAria')}
          className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-(--radius-badge) bg-(--el-tint-lavender) text-(--el-accent-on-surface)"
        >
          <FunnelPlus className="h-[11px] w-[11px]" aria-hidden />
        </span>
      ) : null}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {superseded ? (
        <Tooltip content={t('filterSupersededTooltip')}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        </Tooltip>
      ) : (
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      )}

      <Popover.Content
        role="dialog"
        aria-label={t('filterDialogLabel')}
        align="start"
        width={320}
        className="p-0"
      >
        {/* Header — title + Clear (disabled until something is selected) */}
        <div className="flex items-center justify-between gap-2 border-b border-(--el-border) px-3 py-2.5">
          <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-muted) uppercase">
            {t('filter')}
          </span>
          <button
            type="button"
            disabled={!active || superseded}
            onClick={() => {
              setMemberQuery('');
              setText('');
              apply(clearFacets(filterRef.current));
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-sm focus-visible:outline-none',
              active && !superseded
                ? 'text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)'
                : 'cursor-default text-(--el-text-faint)',
            )}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            {t('filterClearAll')}
          </button>
        </div>

        <div className="max-h-[440px] overflow-y-auto p-1.5">
          {/* TEXT quick-filter */}
          <div className="relative mx-1 mt-1.5 mb-2">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-[15px] w-[15px] -translate-y-1/2 text-(--el-text-muted)"
              aria-hidden
            />
            <input
              type="text"
              value={text}
              disabled={superseded}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder={t('filterFindPlaceholder')}
              aria-label={t('filterByText')}
              className="h-(--height-control) w-full rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) pr-(--spacing-control-x) pl-8 font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            />
          </div>

          {/* KIND */}
          <div className="border-t border-(--el-border) py-1.5 first:border-t-0">
            <FacetLabel label={t('filterKind')} count={optimistic.kinds.length} />
            <div role="listbox" aria-label={t('filterKind')} aria-multiselectable="true">
              {ISSUE_TYPES.map((type: IssueType) => (
                <OptionRow
                  key={type}
                  selected={optimistic.kinds.includes(type)}
                  onToggle={() => apply(toggleKind(filterRef.current, type))}
                  glyph={<IssueTypeIcon type={type} className="h-4 w-4" />}
                  label={tType(type)}
                  disabled={superseded}
                />
              ))}
            </div>
          </div>

          {/* WORK TYPE — the 6.15 net-new facet (the WorkItemType field, before
              this reachable only via [Advanced]): every WORK_ITEM_TYPES member
              + the nullable "Untyped" bucket. Glyph + hue via WorkItemTypeIcon
              (WORK_ITEM_TYPE_META); Untyped = a faint dashed circle. It ITERATES
              the canonical list rather than restating it, so MOTIR-2629's four
              admitted members appeared here with no edit — only this comment's
              count was stale (it said ten). */}
          <div className="border-t border-(--el-border) py-1.5">
            <FacetLabel
              label={t('filterWorkType')}
              count={optimistic.types.length + (optimistic.includeUntyped ? 1 : 0)}
            />
            <div role="listbox" aria-label={t('filterWorkType')} aria-multiselectable="true">
              {WORK_ITEM_TYPES.map((type: WorkItemTypeDto) => (
                <OptionRow
                  key={type}
                  selected={optimistic.types.includes(type)}
                  onToggle={() => apply(toggleType(filterRef.current, type))}
                  glyph={<WorkItemTypeIcon type={type} className="h-4 w-4" />}
                  label={tWorkType(type)}
                  disabled={superseded}
                />
              ))}
              <OptionRow
                selected={optimistic.includeUntyped}
                onToggle={() => apply(toggleUntyped(filterRef.current))}
                glyph={<CircleDashed className="h-4 w-4 text-(--el-text-faint)" aria-hidden />}
                label={t('filterUntyped')}
                disabled={superseded}
              />
            </div>
          </div>

          {/* STATUS */}
          <div className="border-t border-(--el-border) py-1.5">
            <FacetLabel label={t('status')} count={optimistic.statuses.length} />
            <div role="listbox" aria-label={t('status')} aria-multiselectable="true">
              {statuses.map((s) => (
                <OptionRow
                  key={s.id}
                  selected={optimistic.statuses.includes(s.key)}
                  onToggle={() => apply(toggleStatus(filterRef.current, s.key))}
                  glyph={<StatusDot status={s} />}
                  label={statusLabel(s)}
                  disabled={superseded}
                />
              ))}
            </div>
          </div>

          {/* ASSIGNEE */}
          <div className="border-t border-(--el-border) py-1.5">
            <FacetLabel
              label={t('assignee')}
              count={optimistic.assigneeIds.length + (optimistic.includeUnassigned ? 1 : 0)}
            />
            <div className="relative mx-1 mt-0.5 mb-1">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-(--el-text-muted)"
                aria-hidden
              />
              <input
                type="text"
                value={memberQuery}
                disabled={superseded}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder={t('filterSearchMembers')}
                aria-label={t('filterSearchMembersAria')}
                className="h-(--height-control-32) w-full rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) pr-(--spacing-control-x) pl-[30px] font-sans text-[13px] text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              />
            </div>
            <div role="listbox" aria-label={t('assignee')} aria-multiselectable="true">
              <OptionRow
                selected={optimistic.includeUnassigned}
                onToggle={() => apply(toggleUnassigned(filterRef.current))}
                glyph={
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-dashed border-(--el-border) text-(--el-text-muted)">
                    <UserX className="h-3.5 w-3.5" aria-hidden />
                  </span>
                }
                label={t('unassigned')}
                disabled={superseded}
              />
              {memberMatches.map((m) => (
                <OptionRow
                  key={m.userId}
                  selected={optimistic.assigneeIds.includes(m.userId)}
                  onToggle={() => apply(toggleAssignee(filterRef.current, m.userId))}
                  glyph={<Avatar name={m.name} />}
                  label={m.name}
                  secondary={m.email}
                  disabled={superseded}
                />
              ))}
              {memberMatches.length === 0 ? (
                <p className="px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-muted)">
                  {t('filterNoMembers')}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {/* The upgrade footer — the one-way basic→advanced hand-off (6.1.4).
            While superseded the popover above is read-only and this is the
            only action; otherwise it carries the current facets into rows. */}
        <div className="border-t border-(--el-border) px-3 py-2">
          <button
            type="button"
            onClick={editInAdvanced}
            className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-[13px] text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <FunnelPlus className="h-3.5 w-3.5" aria-hidden />
            {t('filterEditInAdvanced')}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
