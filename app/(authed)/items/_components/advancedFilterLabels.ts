// Label resolution for the advanced filter builder (Subtask 6.1.4) — the
// field / operator display names and the per-condition value text shared by
// the builder rows and the applied summary chips. Pure functions over a
// next-intl `t` so both client components reuse one vocabulary.
//
// Field labels resolve through a KNOWN-KEYS map with the registry id itself
// as the fallback — that's what keeps the UI registry-driven (the 6.1.4 AC):
// a brand-new registry entry renders immediately (its raw id as the label
// until copy lands), with zero changes here.

import { customFieldIdOfFilterField } from '@/lib/filters/ast';
import type { FilterFieldId, FilterOperatorId } from '@/lib/filters/ast';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';

type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/** Display labels for the project's DYNAMIC `cf:<id>` fields (Subtask 6.1.5),
 * keyed by the full filter field id (`cf:<defId>`) → the definition's label.
 * Built by the builder/summary from the loaded custom-field definitions. */
export type DynamicFieldLabels = ReadonlyMap<FilterFieldId, string>;

/** issueViews.* keys for the built-in registry field ids (+ the Epic-5
 * static fields, which a shared URL can carry ahead of 6.1.5's editors). */
const FIELD_LABEL_KEYS: Partial<Record<FilterFieldId, string>> = {
  kind: 'filterKind',
  status: 'status',
  ciState: 'advancedFieldChecks',
  fixReason: 'advancedFieldToFix',
  priority: 'advancedFieldPriority',
  type: 'advancedFieldType',
  difficulty: 'advancedFieldDifficulty',
  obsolescence: 'advancedFieldObsolescence',
  assignee: 'assignee',
  reporter: 'advancedFieldReporter',
  sprint: 'advancedFieldSprint',
  text: 'advancedFieldText',
  created: 'advancedFieldCreated',
  updated: 'advancedFieldUpdated',
  due: 'advancedFieldDue',
  storyPoints: 'advancedFieldStoryPoints',
  estimate: 'advancedFieldEstimate',
  // Singular field names in the builder/summary — "Label is none of …" reads
  // as a sentence (the design's field-menu grammar), distinct from the plural
  // rail-card titles (labelsField / componentsField).
  lbl: 'advancedFieldLabel',
  cmp: 'advancedFieldComponent',
  folder: 'advancedFieldFolder',
};

/**
 * The field's display name. Built-in ids resolve through the known-keys map;
 * a dynamic `cf:<id>` field resolves through `dynamicLabels` (the project's
 * definitions). A `cf:<id>` with no entry is a STALE FIELD (the definition was
 * deleted out from under a shared/saved URL) → the "Unknown field" label
 * (Subtask 6.1.5). The raw id remains the last-ditch fallback so a brand-new
 * built-in registry entry still renders (the registry-driven rule).
 */
export function advancedFieldLabel(
  t: Translate,
  field: FilterFieldId,
  dynamicLabels?: DynamicFieldLabels,
): string {
  const key = FIELD_LABEL_KEYS[field];
  if (key) return t(key);
  const dynamic = dynamicLabels?.get(field);
  if (dynamic !== undefined) return dynamic;
  if (customFieldIdOfFilterField(field) !== null) return t('advancedFieldUnknownField');
  return field;
}

const OPERATOR_LABEL_KEYS: Record<FilterOperatorId, string> = {
  is_any_of: 'advancedOpIsAnyOf',
  is_none_of: 'advancedOpIsNoneOf',
  is_empty: 'advancedOpIsEmpty',
  is_not_empty: 'advancedOpIsNotEmpty',
  contains: 'advancedOpContains',
  not_contains: 'advancedOpNotContains',
  eq: 'advancedOpEq',
  ne: 'advancedOpNe',
  lt: 'advancedOpLt',
  lte: 'advancedOpLte',
  gt: 'advancedOpGt',
  gte: 'advancedOpGte',
  on_or_before: 'advancedOpOnOrBefore',
  on_or_after: 'advancedOpOnOrAfter',
  between: 'advancedOpBetween',
  in_last_days: 'advancedOpInLastDays',
  in_next_days: 'advancedOpInNextDays',
};

/**
 * PER-FIELD overrides of the empty pair (MOTIR-5473).
 *
 * `is_empty` / `is_not_empty` read as "is empty" / "is not empty" everywhere, and
 * for most fields that is right: an absent assignee or sprint is an absence with
 * no better name. For a field whose `null` MEANS something a reader can name, the
 * generic wording throws that meaning away — `ciState`'s `null` is *no pull
 * request has reported and none is expected to*, which is a real answer rather
 * than a blank.
 *
 * Keyed on the field, so a field with no entry keeps the generic pair and nothing
 * else moves. Exported for the test that asserts every key resolves.
 */
export const FIELD_EMPTY_OPERATOR_KEYS: Partial<
  Record<FilterFieldId, Partial<Record<FilterOperatorId, string>>>
> = {
  ciState: {
    is_empty: 'advancedOpChecksIsEmpty',
    is_not_empty: 'advancedOpChecksIsNotEmpty',
  },
  // *To fix is any* / *is none* (MOTIR-6609) — the words the story's own
  // verification recipe uses. `null` means nothing is waiting on a repair.
  fixReason: {
    is_empty: 'advancedOpToFixIsEmpty',
    is_not_empty: 'advancedOpToFixIsNotEmpty',
  },
};

/**
 * The *To fix* field's value labels (MOTIR-6609): the Workbench To fix tab's own
 * bare reason strings (`workbench.toFix.reason.*`), reused because the meaning is
 * identical (design § *The TO FIX tag and banner*). Total over the reason enum, so
 * a new reason fails the type check here until it has a label.
 */
export const FIX_REASON_VALUE_KEYS: Record<WorkItemFixReasonDto, string> = {
  run_died: 'runDiedBare',
  queue_failed: 'queueFailedBare',
  conflicted: 'conflictedNoBase',
  out_of_date: 'outOfDateNoBase',
  ci_failed: 'ciFailedBare',
  changes_requested: 'changesRequestedAnon',
};

/** Whether a raw filter value is one of the reasons (a stale URL can carry anything). */
export function isFixReason(value: string): value is WorkItemFixReasonDto {
  return Object.prototype.hasOwnProperty.call(FIX_REASON_VALUE_KEYS, value);
}

export function advancedOperatorLabel(
  t: Translate,
  operator: FilterOperatorId,
  field?: FilterFieldId,
): string {
  const override = field ? FIELD_EMPTY_OPERATOR_KEYS[field]?.[operator] : undefined;
  return t(override ?? OPERATOR_LABEL_KEYS[operator]);
}
