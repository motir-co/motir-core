'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { Bookmark, Lock, Users } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import { clearFacets } from '@/lib/issues/issueListAdvancedFilter';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import {
  currentFilterParam,
  isAppliedFilterDirty,
  type AppliedSavedFilter,
} from '@/lib/issues/savedFilterApplied';
import {
  ApiError,
  overwriteFilterCriteria,
  type SavedFilterSummaryDto,
  type Viewer,
} from '@/app/(authed)/filters/_components/savedFiltersClient';
import { useSavedFilterSession } from './SavedFilterContext';
import { SaveFilterDialog } from './SaveFilterDialog';

// The applied-saved-filter bar (Story 6.2 · Subtask 6.2.3), per
// design/work-items/saved-filters.mock.html panel 0: the NAME CHIP prepends the
// 6.1.3 condition-chip summary row (bookmark glyph + name + the visibility hint —
// users = project-shared, lock = private). Clicking it opens the [Saved]
// dropdown. When the URL AST diverges from the saved envelope (6.1.1 equality)
// the dirty marker shows — the amber dot + the word "Edited" (never colour-only)
// — and the action set by ownership: owner → [Save] [Save as] [Discard changes];
// non-owner → [Save as] only (with the ink tooltip explaining why). Save
// (overwrite) writes the current AST into the row in place — no dialog.
//
// It also hosts the fresh-filter [Save as] (the verification recipe's "build a
// filter → Save as"): when nothing is applied but the builder holds an active
// AST, the designed Save-as affordance appears in the same action slot — the same
// element the mock places here, shown without the ownership-gated Save/Discard.
//
// The 6.1.3 condition chips themselves (AdvancedFilterSummary) are passed as
// `children` from the Server Component page and rendered between the chip and the
// actions, so this one client component owns the whole summary row.

export interface IssueAppliedFilterBarProps {
  projectKey: string;
  viewer: Viewer;
  view: IssueListView;
  sort: IssueSort;
  filter: IssueFilter;
  ast: FilterAst | null;
  /** The 6.1.3 condition-chip readout (AdvancedFilterSummary), or null. */
  children?: ReactNode;
  /** Navigation override (Subtask 6.15.3): the board injects
   * `buildBoardFilterHref` (board-scoped URL, no view/sort) so Discard returns
   * to the board, not /items. Defaults to the /items `buildIssueListHref`. */
  buildHref?: (filter: IssueFilter) => string;
  /** Host actions appended after the bar's own (MOTIR-11565: the board's divider,
   * Set as board filter and Reset to board filter). Absent on /items. */
  trailing?: ReactNode;
  /** Whether Save as is offered (MOTIR-11565: false for a board Visitor, who has
   * no saved filters). Defaults to true. */
  saveAs?: boolean;
}

export function IssueAppliedFilterBar({
  projectKey,
  viewer,
  view,
  sort,
  filter,
  ast,
  children,
  buildHref,
  trailing,
  saveAs = true,
}: IssueAppliedFilterBarProps) {
  const t = useTranslations('savedFilters');
  const router = useRouter();
  const pathname = usePathname();
  const hrefFor = (next: IssueFilter) =>
    buildHref ? buildHref(next) : buildIssueListHref(pathname, { view, sort, filter: next });
  const { toast } = useToast();
  const session = useSavedFilterSession();
  const applied = session?.applied ?? null;

  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [overwriting, setOverwriting] = useState(false);

  const currentParam = currentFilterParam(ast);
  const dirty = applied !== null && isAppliedFilterDirty(applied, ast);
  const hasActiveFilter = currentParam !== null;

  // Nothing applied and no active filter → nothing to show.
  if (applied === null && ast === null) return null;

  function openDropdown() {
    session?.setDropdownOpen(true);
  }

  async function overwrite() {
    if (applied === null || currentParam === null) return;
    setOverwriting(true);
    try {
      await overwriteFilterCriteria(projectKey, applied.id, currentParam);
      // The row now matches the URL — clean.
      session?.setApplied({ ...applied, envelopeParam: currentParam });
      toast({ variant: 'success', title: t('applied.savedToast') });
    } catch (err) {
      const dup = err instanceof ApiError && err.code === 'SAVED_FILTER_NAME_CONFLICT';
      toast({
        variant: 'error',
        title: t('applied.overwriteError'),
        description: dup ? undefined : t('save.errorGeneric'),
      });
    } finally {
      setOverwriting(false);
    }
  }

  function discard() {
    if (applied === null) return;
    // Reload the saved envelope into builder + URL (preserving view/sort,
    // clearing the basic facets — the advanced param is the single channel).
    router.push(hrefFor({ ...clearFacets(filter), advanced: applied.envelopeParam }));
  }

  function onSavedAs(created: SavedFilterSummaryDto) {
    setSaveAsOpen(false);
    // The freshly-saved row IS the current URL AST — applied + clean.
    session?.setApplied({
      id: created.id,
      name: created.name,
      ownerName: created.owner.name,
      visibility: created.visibility,
      canOverwrite: true,
      builtin: false,
      envelopeParam: currentParam,
    });
  }

  const showSaveAs =
    saveAs && ((applied !== null && dirty) || (applied === null && hasActiveFilter));

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('applied.barAria')}>
      {applied !== null ? <NameChip applied={applied} onClick={openDropdown} /> : null}
      {dirty ? <DirtyMarker label={t('applied.edited')} /> : null}

      {children}

      {(showSaveAs || (dirty && applied !== null)) && (
        <span className="ml-1.5 inline-flex shrink-0 items-center gap-1.5">
          {applied !== null && dirty && applied.canOverwrite ? (
            <button
              type="button"
              onClick={() => void overwrite()}
              disabled={overwriting || currentParam === null}
              className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x-sm) text-[13px] font-medium text-(--el-accent-text) hover:bg-(--el-accent-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60"
            >
              {t('applied.save')}
            </button>
          ) : null}

          {showSaveAs ? (
            applied !== null && dirty && !applied.canOverwrite ? (
              <Tooltip content={t('applied.nonOwnerTooltip', { owner: applied.ownerName ?? '' })}>
                <SaveAsButton label={t('applied.saveAs')} onClick={() => setSaveAsOpen(true)} />
              </Tooltip>
            ) : (
              <SaveAsButton label={t('applied.saveAs')} onClick={() => setSaveAsOpen(true)} />
            )
          ) : null}

          {applied !== null && dirty ? (
            <button
              type="button"
              onClick={discard}
              className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) px-(--spacing-btn-x-sm) text-[13px] font-medium text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {t('applied.discard')}
            </button>
          ) : null}
        </span>
      )}

      {trailing}

      {saveAsOpen && currentParam !== null ? (
        <SaveFilterDialog
          projectKey={projectKey}
          viewer={viewer}
          filterParam={currentParam}
          initialName={applied?.name ?? ''}
          onClose={() => setSaveAsOpen(false)}
          onSaved={onSavedAs}
        />
      ) : null}
    </div>
  );
}

export function NameChip({
  applied,
  onClick,
}: {
  applied: AppliedSavedFilter;
  onClick: () => void;
}) {
  const t = useTranslations('savedFilters');
  const VisGlyph =
    applied.visibility === 'project' ? Users : applied.visibility === 'private' ? Lock : null;
  const aria =
    applied.visibility === 'project'
      ? t('applied.chipAriaShared', { name: applied.name })
      : applied.visibility === 'private'
        ? t('applied.chipAriaPrivate', { name: applied.name })
        : t('applied.chipAriaBuiltin', { name: applied.name });
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="listbox"
      aria-label={aria}
      className="inline-flex max-w-full items-center gap-1.5 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <Bookmark className="h-3.5 w-3.5 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
      <span className="min-w-0 truncate">{applied.name}</span>
      {VisGlyph ? (
        <VisGlyph className="h-3 w-3 shrink-0 text-(--el-text-secondary)" aria-hidden />
      ) : null}
    </button>
  );
}

export function DirtyMarker({ label }: { label: string }) {
  return (
    <span
      role="status"
      className="inline-flex shrink-0 items-center gap-1.5 text-xs text-(--el-text-secondary) italic"
    >
      <span className="h-2 w-2 rounded-full bg-(--el-warning)" aria-hidden />
      {label}
    </span>
  );
}

export function SaveAsButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) border border-(--el-border) px-(--spacing-btn-x-sm) text-[13px] font-medium text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {label}
    </button>
  );
}
