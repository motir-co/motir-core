'use client';

import { useCallback } from 'react';
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
import { buildBacklogFilterHref } from '@/lib/backlog/backlogFilterHref';
import { IssueAppliedFilterBar } from '../../items/_components/IssueAppliedFilterBar';
import { AdvancedFilterSummary } from '../../items/_components/AdvancedFilterSummary';

// The backlog's applied-filter SUMMARY row (Story 8.8 · Subtask 8.8.18), per
// design/backlog/backlog-filter.mock.html panel 3: the SAME shipped /items
// `IssueAppliedFilterBar` (the saved-filter name chip + dirty state +
// Save/Save-as/Discard) prepended to the 6.1.3 condition-chip readout
// (AdvancedFilterSummary), mounted ABOVE the backlog + sprint regions. Re-pointed
// at the backlog via the injected backlog-scoped `buildHref` so Discard returns to
// `/backlog` (not /items). Renders nothing when no filter is applied (the bar's
// own guard), so an unfiltered backlog shows no summary row. The board's 6.15.3
// pattern, board → backlog.
//
// `view`/`sort` are inert (the backlog has neither); with `buildHref` injected the
// bar never reaches its `buildIssueListHref` fallback. Passed as the canonical
// defaults to satisfy the shared prop contract.

export interface BacklogAppliedFilterBarProps {
  projectKey: string;
  viewer: Viewer;
  filter: IssueFilter;
  ast: FilterAst | null;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders by path (MOTIR-11668) — a Folder chip names each
   * folder by its path, never its id. Required, so a backlog host cannot
   * silently drop it. */
  folders: ProjectFoldersDto;
  referencedLabels: LabelDto[];
}

export function BacklogAppliedFilterBar({
  projectKey,
  viewer,
  filter,
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
}: BacklogAppliedFilterBarProps) {
  const buildHref = useCallback(
    (next: IssueFilter) => buildBacklogFilterHref({ filter: next }),
    [],
  );

  return (
    <IssueAppliedFilterBar
      projectKey={projectKey}
      viewer={viewer}
      view="tree"
      sort={DEFAULT_SORT}
      filter={filter}
      ast={ast}
      buildHref={buildHref}
    >
      {ast !== null ? (
        <AdvancedFilterSummary
          ast={ast}
          statuses={statuses}
          members={members}
          sprints={sprints}
          customFields={customFields}
          components={components}
          folders={folders}
          referencedLabels={referencedLabels}
        />
      ) : null}
    </IssueAppliedFilterBar>
  );
}
