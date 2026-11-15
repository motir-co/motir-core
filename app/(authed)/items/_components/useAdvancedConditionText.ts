'use client';

import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  customFieldFilterFieldId,
  customFieldIdOfFilterField,
  type FilterCondition,
} from '@/lib/filters/ast';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import { isWorkItemDifficulty } from '@/lib/issues/difficulty';
import { isWorkItemObsolescence } from '@/lib/issues/obsolescence';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import {
  advancedFieldLabel,
  advancedOperatorLabel,
  FIX_REASON_VALUE_KEYS,
  isFixReason,
  type DynamicFieldLabels,
} from './advancedFilterLabels';

// The condition → text resolution of the advanced filter (Subtasks 6.1.4 +
// 6.1.5), shared by every READ-ONLY readout of a FilterAst: the toolbar's
// applied-condition chips (`AdvancedFilterSummary`) and the board's stored-filter
// indicator (Story MOTIR-10560 · Subtask MOTIR-11335). One vocabulary, so a
// condition reads the same wherever it is summarised.
//
// Value text resolves through the same vocabularies the editors use (status
// labels, member/sprint names, type/priority translations, AND the Epic-5
// referents — custom-field options, labels, components, folders); an id that no
// longer resolves renders the "unknown value" text (it matches nothing
// server-side, the stale grammar).

export interface AdvancedConditionTextLookups {
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders — a Folder value names each by its path (MOTIR-5378).
   * Absent on a host that loads none, where an id renders as itself. */
  folders?: ProjectFoldersDto;
  referencedLabels: LabelDto[];
}

export interface AdvancedConditionText {
  /** The condition's field name ("Kind", a custom field's label, …). */
  field: (condition: FilterCondition) => string;
  /** The condition's operator ("is any of", …), with the per-field empty pair. */
  operator: (condition: FilterCondition) => string;
  /** The condition's values as text, or `null` for a value-less operator. */
  values: (condition: FilterCondition) => string | null;
  /** "**Field** operator values" as one plain line. */
  sentence: (condition: FilterCondition) => string;
}

export function useAdvancedConditionText({
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
}: AdvancedConditionTextLookups): AdvancedConditionText {
  const t = useTranslations('issueViews');
  const tType = useTranslations('labels.issueType');
  const tStatus = useTranslations('labels.defaultStatus');
  const tPriority = useTranslations('labels.priority');
  const tWorkType = useTranslations('labels.workItemType');
  const tDifficulty = useTranslations('labels.difficulty');
  const tFixReason = useTranslations('workbench.toFix.reason');
  const tObsolescence = useTranslations('labels.obsolescence');
  const format = useFormatter();

  const cfById = useMemo(() => new Map(customFields.map((f) => [f.id, f])), [customFields]);
  const componentsById = useMemo(
    () => new Map(components.map((c) => [c.id, c.name])),
    [components],
  );
  const folderPathsById = useMemo(
    () => (folders ? new Map(folders.folders.map((f) => [f.id, f.path.join(' ▸ ')])) : null),
    [folders],
  );
  const labelsById = useMemo(
    () => new Map(referencedLabels.map((l) => [l.id, l.name])),
    [referencedLabels],
  );
  const dynamicLabels = useMemo<DynamicFieldLabels>(
    () => new Map(customFields.map((f) => [customFieldFilterFieldId(f.id), f.label])),
    [customFields],
  );

  /** A select custom-field option's display label (archived marked), or null
   * when the id no longer resolves (stale). */
  function cfOptionLabel(cf: CustomFieldDefinitionDTO, id: string): string | null {
    const option = cf.options.find((o) => o.id === id);
    if (!option) return null;
    return option.archived ? t('advancedArchivedOption', { label: option.label }) : option.label;
  }

  function valueId(condition: FilterCondition, id: string): string {
    const cfId = customFieldIdOfFilterField(condition.field);
    if (cfId !== null) {
      const cf = cfById.get(cfId);
      if (!cf) return t('advancedStaleValue');
      if (cf.fieldType === 'select') return cfOptionLabel(cf, id) ?? t('advancedStaleValue');
      if (cf.fieldType === 'user') return members.find((m) => m.userId === id)?.name ?? id;
      return id;
    }
    switch (condition.field) {
      case 'kind':
        return tType(id);
      case 'status': {
        const status = statuses.find((s) => s.key === id);
        if (!status) return id;
        return DEFAULT_STATUS_KEYS.has(status.key) ? tStatus(status.key) : status.label;
      }
      case 'priority':
        return tPriority(id);
      case 'type':
        return tWorkType(id);
      case 'difficulty':
        // Only a member of the closed scale has a label; anything else is shown
        // raw rather than asking next-intl for a key that does not exist.
        return isWorkItemDifficulty(id) ? tDifficulty(id) : id;
      case 'fixReason':
        // The Workbench's own reason words (MOTIR-6609); a value outside the enum
        // (a stale URL) is shown raw, as `difficulty` does.
        return isFixReason(id) ? tFixReason(FIX_REASON_VALUE_KEYS[id]) : id;
      case 'obsolescence':
        // The same rule for the mark (MOTIR-6678).
        return isWorkItemObsolescence(id) ? tObsolescence(id) : id;
      case 'assignee':
      case 'reporter': {
        if (id === 'unassigned') return t('unassigned');
        return members.find((m) => m.userId === id)?.name ?? id;
      }
      case 'sprint': {
        if (id === 'backlog') return t('advancedBacklog');
        return sprints.find((s) => s.id === id)?.name ?? id;
      }
      case 'lbl':
        return labelsById.get(id) ?? t('advancedStaleValue');
      case 'cmp':
        return componentsById.get(id) ?? t('advancedStaleValue');
      case 'folder': {
        const path = folderPathsById?.get(id);
        if (path !== undefined) return path;
        // Only a COMPLETE folder list can say a folder is gone.
        return folderPathsById !== null && !folders?.truncated ? t('advancedStaleValue') : id;
      }
      default:
        return id;
    }
  }

  function date(iso: string): string {
    return format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  }

  /** A scalar date condition — the built-in date columns, or a date custom
   * field — whose ISO value renders formatted (not raw). */
  function isDateField(condition: FilterCondition): boolean {
    if (
      condition.field === 'created' ||
      condition.field === 'updated' ||
      condition.field === 'due'
    ) {
      return true;
    }
    const cfId = customFieldIdOfFilterField(condition.field);
    return cfId !== null && cfById.get(cfId)?.fieldType === 'date';
  }

  function values(condition: FilterCondition): string | null {
    const { operator, value } = condition;
    if (value === null) return null;
    if (Array.isArray(value)) {
      if (operator === 'between' && value.length === 2) {
        const [from, to] = value as [string, string];
        return t('advancedBetweenValues', { from: date(from), to: date(to) });
      }
      return (value as string[]).map((id) => valueId(condition, id)).join(', ');
    }
    if (typeof value === 'number') {
      return operator === 'in_last_days' || operator === 'in_next_days'
        ? t('advancedDaysValue', { count: value })
        : String(value);
    }
    return isDateField(condition) ? date(value) : value;
  }

  const field = (condition: FilterCondition) =>
    advancedFieldLabel(t, condition.field, dynamicLabels);
  const operator = (condition: FilterCondition) =>
    advancedOperatorLabel(t, condition.operator, condition.field);

  return {
    field,
    operator,
    values,
    sentence: (condition) => {
      const v = values(condition);
      return `${field(condition)} ${operator(condition)}${v !== null ? ` ${v}` : ''}`;
    },
  };
}
