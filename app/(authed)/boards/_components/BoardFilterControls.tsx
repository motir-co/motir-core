'use client';

import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import type { FilterAst } from '@/lib/filters/ast';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { IssueFilterBar } from '../../items/_components/IssueFilterBar';
import { IssueAdvancedFilter } from '../../items/_components/IssueAdvancedFilter';
import { SavedFilterDropdown } from '../../items/_components/SavedFilterDropdown';
import { useBoardHeaderFilter } from './useBoardHeaderFilter';
import { BoardFilterResetLink } from './BoardFilterResetLink';

// The board toolbar's filter affordances (Story 6.15 · Subtask 6.15.3), per
// design/boards/board-filter.mock.html panels 0–2: the enabled `[Filter]` quick
// popover + `[Advanced]` builder + `[Saved]` picker, mounted on the BOARD
// toolbar beside the 3.3 group-by Segmented. These are the SAME shipped /items
// components, verbatim — NO hand-rolled board-specific filter UI — re-pointed at
// the board via the injected `buildHref` (board-scoped URL: `?board=` preserved,
// the filter params appended, no view/sort/page) so the state is shareable,
// reload-safe, and per board. The reused `IssueFilterBar` already carries the
// 6.15.5 Work type facet, so the board exposes it automatically.
//
// `view`/`sort` are inert here (the board has neither): with `buildHref`
// injected, the components never reach their `buildIssueListHref` fallback that
// would consume them — they're passed as the canonical defaults purely to
// satisfy the shared prop contract.
//
// On a board with a stored filter (MOTIR-11565) the header filter STARTS as the
// board's filter: with no filter in the URL the stored conditions are loaded
// into the controls as ordinary editable rows (`useBoardHeaderFilter`), and
// while the header differs from them both popovers carry a Reset to board
// filter link before Clear. A Visitor has no saved filters: no `[Saved]`.
//
// The quick `[Filter]` popover keeps its own internal open state (the over-cap
// banner whose "Refine filter" CTA opened it from outside went with the board
// cap, MOTIR-10535); the `[Advanced]` + `[Saved]` popovers keep theirs
// (AdvancedFilterProvider / the saved-filter session), exactly as on /items.

export interface BoardFilterControlsProps {
  /** The selected board id (`?board=`) — preserved by every filter navigation
   * so the filter is per board and switching boards does not leak it. */
  selectedBoardId?: string;
  filter: IssueFilter;
  ast: FilterAst | null;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders by path (MOTIR-11667) — the Advanced builder's
   * Folder field. Required, so a board host cannot silently hide the field. */
  folders: ProjectFoldersDto;
  referencedLabels: LabelDto[];
  projectKey: string;
  viewer: Viewer;
  /** `?boardFilter=off` — the reader removed every condition (MOTIR-11564). */
  boardFilterOff?: boolean;
  /** Whether the reader has saved filters at all — false for a Visitor. */
  savedFilters?: boolean;
}

export function BoardFilterControls({
  selectedBoardId,
  filter,
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
  projectKey,
  viewer,
  boardFilterOff = false,
  savedFilters = true,
}: BoardFilterControlsProps) {
  const header = useBoardHeaderFilter({
    selectedBoardId,
    filter,
    ast,
    boardFilterOff,
    referencedLabels,
  });
  const { buildHref } = header;

  return (
    <>
      <IssueFilterBar
        filter={header.filter}
        statuses={statuses}
        members={members}
        view="tree"
        sort={DEFAULT_SORT}
        ast={header.ast}
        buildHref={buildHref}
        headerAction={
          header.differs ? <BoardFilterResetLink short onReset={header.reset} /> : undefined
        }
      />
      <IssueAdvancedFilter
        filter={header.filter}
        ast={header.ast}
        view="tree"
        sort={DEFAULT_SORT}
        statuses={statuses}
        members={members}
        sprints={sprints}
        customFields={customFields}
        components={components}
        folders={folders}
        referencedLabels={header.labels}
        projectKey={projectKey}
        buildHref={buildHref}
        headerAction={header.differs ? <BoardFilterResetLink onReset={header.reset} /> : undefined}
      />
      {savedFilters ? (
        <SavedFilterDropdown
          projectKey={projectKey}
          viewer={viewer}
          view="tree"
          sort={DEFAULT_SORT}
          filter={header.filter}
          ast={header.ast}
          buildHref={buildHref}
        />
      ) : null}
    </>
  );
}
