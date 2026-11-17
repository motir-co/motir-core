'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Funnel, TriangleAlert } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import type {
  SavedFilterSummaryDto,
  Viewer,
} from '@/app/(authed)/filters/_components/savedFiltersClient';
import { clearFacets } from '@/lib/issues/issueListAdvancedFilter';
import { currentFilterParam } from '@/lib/issues/savedFilterApplied';
import { staleHeaderConditions, type StaleConditionKind } from '@/lib/boards/boardHeaderFilter';
import {
  DirtyMarker,
  IssueAppliedFilterBar,
  SaveAsButton,
} from '../../items/_components/IssueAppliedFilterBar';
import { AdvancedFilterSummary } from '../../items/_components/AdvancedFilterSummary';
import { useAdvancedFilterPopover } from '../../items/_components/AdvancedFilterContext';
import { useSavedFilterSession } from '../../items/_components/SavedFilterContext';
import { SaveFilterDialog } from '../../items/_components/SaveFilterDialog';
import { useAdvancedConditionText } from '../../items/_components/useAdvancedConditionText';
import { useBoardHeaderFilter } from './useBoardHeaderFilter';
import { BoardFilterSaveConfirm, type BoardFilterSaveKind } from './BoardFilterSaveConfirm';

// The board's applied-filter row (Story 6.15 · Subtask 6.15.3; MOTIR-11565), per
// design/boards/board--header-board-filter.mock.html. On a board with NO stored
// filter it is the shipped /items `IssueAppliedFilterBar` (the saved-filter name
// chip + dirty state + Save/Save-as/Discard) over the condition chips, exactly as
// before, re-pointed at the board via the injected board-scoped `buildHref`.
//
// On a board WITH a stored filter the header filter starts as the board's filter,
// and the row draws one of four states (`resolveBoardHeaderFilter`):
// - Board filter — the Board filter chip and the stored conditions; no actions;
// - Edited — the chip, Edited, the conditions, then Save to board filter (board
//   admin) · Save as (not a Visitor) · Reset to board filter;
// - Cleared — the chip, Edited, the no-condition note, then Save to board filter
//   (admin: removes it) · Reset; no Save as, there is nothing to save;
// - Saved filter — the shipped saved-filter bar, then a divider and Set as board
//   filter (admin) · Reset.
// Save to / Set as open a confirm first (`BoardFilterSaveConfirm`); on success
// the header returns to the board filter: no filter params, and the applied saved
// filter (if any) is let go. The stored-filter indicator this row used to open
// (MOTIR-11335) is retired: the Board filter chip and its conditions say the same
// thing, and are where the filter is edited.
//
// `canConfigure` is the reader's `board:configure` as the page resolved it (never
// true for a Visitor); `savedFilters` is false for a Visitor, who has none.

export interface BoardAppliedFilterBarProps {
  selectedBoardId?: string;
  projectKey: string;
  viewer: Viewer;
  filter: IssueFilter;
  ast: FilterAst | null;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  referencedLabels: LabelDto[];
  /** `?boardFilter=off` — the reader removed every condition (MOTIR-11564). */
  boardFilterOff?: boolean;
  /** Whether the reader may write the board's filter (`board:configure`). */
  canConfigure?: boolean;
  /** Whether the reader has saved filters at all — false for a Visitor. */
  savedFilters?: boolean;
}

const STALE_TOOLTIP_KEY = {
  label: 'staleTooltipLabel',
  component: 'staleTooltipComponent',
  folder: 'staleTooltipFolder',
  field: 'staleTooltipField',
  option: 'staleTooltipOption',
  invalid: 'staleTooltipInvalid',
} as const satisfies Record<StaleConditionKind, string>;

const PRIMARY_BUTTON =
  'inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x-sm) text-[13px] font-medium text-(--el-accent-text) hover:bg-(--el-accent-pressed) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60';
const GHOST_BUTTON =
  'inline-flex h-(--height-btn-sm) items-center rounded-(--radius-btn) px-(--spacing-btn-x-sm) text-[13px] font-medium text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function BoardAppliedFilterBar({
  selectedBoardId,
  projectKey,
  viewer,
  filter,
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  referencedLabels,
  boardFilterOff = false,
  canConfigure = false,
  savedFilters = true,
}: BoardAppliedFilterBarProps) {
  const t = useTranslations('boards.headerFilter');
  const tSaved = useTranslations('savedFilters');
  const format = useFormatter();
  const router = useRouter();
  const session = useSavedFilterSession();
  const applied = session?.applied ?? null;
  const openAdvanced = useAdvancedFilterPopover()?.setOpen;
  const header = useBoardHeaderFilter({
    selectedBoardId,
    filter,
    ast,
    boardFilterOff,
    referencedLabels,
  });
  const lookups = {
    statuses,
    members,
    sprints,
    customFields,
    components,
    referencedLabels: header.labels,
  };
  const text = useAdvancedConditionText(lookups);
  const [confirm, setConfirm] = useState<BoardFilterSaveKind | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);

  const stored = header.read.storedFilter ?? null;
  const stale = useMemo(
    () => staleHeaderConditions(header.storedAst, stored?.staleConditions ?? [], header.ast),
    [header.storedAst, stored, header.ast],
  );
  const boardStale = header.unreadable || (stored?.staleConditions.length ?? 0) > 0;

  // No stored filter (or not known yet): the shipped bar, unchanged.
  if (!header.hasStoredFilter) {
    return (
      <IssueAppliedFilterBar
        projectKey={projectKey}
        viewer={viewer}
        view="tree"
        sort={DEFAULT_SORT}
        filter={filter}
        ast={ast}
        buildHref={header.buildHref}
        saveAs={savedFilters}
      >
        {ast !== null ? <AdvancedFilterSummary ast={ast} {...lookups} /> : null}
      </IssueAppliedFilterBar>
    );
  }

  const storedSentences = (header.storedAst?.conditions ?? []).map((c) => text.sentence(c));
  const storedSummary = header.unreadable
    ? t('unreadable')
    : format.list(storedSentences, {
        type: header.storedAst?.combinator === 'or' ? 'disjunction' : 'conjunction',
      });
  const resetButton = (
    <Tooltip content={t('resetTooltip', { summary: storedSummary })}>
      <button
        type="button"
        onClick={header.reset}
        data-testid="board-filter-reset"
        className={GHOST_BUTTON}
      >
        {t('reset')}
      </button>
    </Tooltip>
  );
  const boardId = header.read.boardId;
  const savedParam = currentFilterParam(header.current);

  function onSaved() {
    session?.setApplied(null);
    header.read.reloadBoard();
    router.push(header.resetHref);
  }

  function onSavedAs(created: SavedFilterSummaryDto) {
    setSaveAsOpen(false);
    session?.setApplied({
      id: created.id,
      name: created.name,
      ownerName: created.owner.name,
      visibility: created.visibility,
      canOverwrite: true,
      builtin: false,
      envelopeParam: savedParam,
    });
    // The saved filter's envelope is the merged header filter: carry it as the
    // one advanced channel, so the applied chip reads clean.
    router.push(header.buildHref({ ...clearFacets(filter), advanced: savedParam }));
  }

  const confirmDialog =
    confirm !== null && boardId !== null ? (
      <BoardFilterSaveConfirm
        kind={confirm}
        boardId={boardId}
        boardType={header.read.boardType}
        ast={header.current}
        name={applied?.name}
        lookups={lookups}
        onClose={() => setConfirm(null)}
        onSaved={onSaved}
      />
    ) : null;

  // A saved filter applied from Saved: the shipped saved-filter bar, then the
  // board's own actions while it differs from the board filter.
  if (applied !== null) {
    return (
      <>
        <IssueAppliedFilterBar
          projectKey={projectKey}
          viewer={viewer}
          view="tree"
          sort={DEFAULT_SORT}
          filter={header.filter}
          ast={header.ast}
          buildHref={header.buildHref}
          saveAs={savedFilters}
          trailing={
            header.differs ? (
              <span
                className="ml-1.5 inline-flex max-w-full flex-wrap items-center gap-1.5"
                data-testid="board-filter-actions"
              >
                <span className="h-4 w-px bg-(--el-border)" aria-hidden />
                {canConfigure ? (
                  <SaveAsButton label={t('setAsBoard')} onClick={() => setConfirm('set')} />
                ) : null}
                {resetButton}
              </span>
            ) : null
          }
        >
          {header.ast !== null ? <AdvancedFilterSummary ast={header.ast} {...lookups} /> : null}
        </IssueAppliedFilterBar>
        {confirmDialog}
      </>
    );
  }

  const cleared = header.mode === 'cleared';
  const scrum = header.read.boardType === 'scrum';

  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label={tSaved('applied.barAria')}
      data-testid="board-header-filter"
      data-mode={header.mode}
    >
      <button
        type="button"
        onClick={() => openAdvanced?.(true)}
        aria-haspopup="dialog"
        aria-label={t('chipAria')}
        data-board-filter-chip=""
        className="inline-flex max-w-full items-center gap-1.5 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Funnel className="h-3.5 w-3.5 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
        <span className="min-w-0 truncate">{t('chip')}</span>
        {boardStale ? (
          <TriangleAlert
            role="img"
            aria-label={t('stale')}
            data-testid="board-filter-chip-stale"
            className="size-3.5 shrink-0 text-(--el-warning)"
          />
        ) : null}
      </button>
      {header.differs ? <DirtyMarker label={tSaved('applied.edited')} /> : null}

      {cleared ? (
        <span className="text-xs text-(--el-text-secondary)">
          {scrum ? t('clearedNoteScrum') : t('clearedNote')}
        </span>
      ) : header.ast !== null ? (
        <AdvancedFilterSummary
          ast={header.ast}
          {...lookups}
          staleLabel={t('stale')}
          staleTooltip={(i) => {
            const kind = stale.get(i);
            if (!kind) return null;
            const sentence = t(STALE_TOOLTIP_KEY[kind]);
            return canConfigure ? `${sentence} ${t('staleTooltipAdminHint')}` : sentence;
          }}
        />
      ) : header.unreadable ? (
        <span className="text-xs text-(--el-text-secondary)">{t('unreadable')}</span>
      ) : null}

      {header.differs ? (
        <span
          className="ml-1.5 inline-flex max-w-full flex-wrap items-center gap-1.5"
          data-testid="board-filter-actions"
        >
          {canConfigure ? (
            <button
              type="button"
              onClick={() => setConfirm(cleared ? 'clear' : 'save')}
              className={PRIMARY_BUTTON}
            >
              {t('saveToBoard')}
            </button>
          ) : null}
          {!cleared && savedFilters && savedParam !== null ? (
            canConfigure ? (
              <SaveAsButton label={tSaved('applied.saveAs')} onClick={() => setSaveAsOpen(true)} />
            ) : (
              <Tooltip content={t('nonAdminSaveAsTooltip')}>
                <SaveAsButton
                  label={tSaved('applied.saveAs')}
                  onClick={() => setSaveAsOpen(true)}
                />
              </Tooltip>
            )
          ) : null}
          {resetButton}
        </span>
      ) : null}

      {saveAsOpen && savedParam !== null ? (
        <SaveFilterDialog
          projectKey={projectKey}
          viewer={viewer}
          filterParam={savedParam}
          onClose={() => setSaveAsOpen(false)}
          onSaved={onSavedAs}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}
