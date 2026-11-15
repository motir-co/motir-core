'use client';

import { useTranslations } from 'next-intl';
import type { FilterAst } from '@/lib/filters/ast';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import { useAdvancedFilterPopover } from './AdvancedFilterContext';
import { useAdvancedConditionText } from './useAdvancedConditionText';

// The applied advanced-filter readout (Subtasks 6.1.4 + 6.1.5), per
// design/work-items/filter-builder.mock.html panel 5: a compact, READ-ONLY
// row of condition chips under the toolbar — a lavender "Match any" chip
// (only on OR) followed by one neutral chip per condition (**Field** operator
// values). Clicking any chip opens the builder (editing happens in ONE
// surface — the design's recorded rule); there is no inline chip editing.
//
// Field, operator and value text come from `useAdvancedConditionText`, the
// resolution this readout shares with the board's stored-filter indicator
// (MOTIR-11335); an id that no longer resolves renders the "unknown value" text
// (it matches nothing server-side, the stale grammar).

export interface AdvancedFilterSummaryProps {
  ast: FilterAst;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders — a Folder chip names each by its path (MOTIR-5378).
   * Absent on a host that loads none, where an id renders as itself. */
  folders?: ProjectFoldersDto;
  referencedLabels: LabelDto[];
}

export function AdvancedFilterSummary({
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
}: AdvancedFilterSummaryProps) {
  const t = useTranslations('issueViews');
  const setOpen = useAdvancedFilterPopover()?.setOpen ?? (() => {});
  const text = useAdvancedConditionText({
    statuses,
    members,
    sprints,
    customFields,
    components,
    folders,
    referencedLabels,
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('advancedSummaryAria')}>
      {ast.combinator === 'or' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {t('advancedMatchAnyChip')}
        </button>
      ) : null}
      {ast.conditions.map((condition, i) => {
        const values = text.values(condition);
        return (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex max-w-full items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <strong className="font-semibold text-(--el-text-strong)">
              {text.field(condition)}
            </strong>
            <span className="min-w-0 truncate">
              {text.operator(condition)}
              {values !== null ? ` ${values}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
