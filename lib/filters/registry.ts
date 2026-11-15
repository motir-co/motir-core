// The per-field-type operator registry (Story 6.1 · Subtask 6.1.1) — the
// single source of truth for what the filter builder can say: every built-in
// field maps to an explicit operator set, a per-(field, operator) value
// arity/validation, and a value-editor kind (the UI contract 6.1.3 / 6.1.4
// consume). TOTAL over an open input space (mistake #29): an unknown field or
// operator id, or a malformed value, is a typed rejection
// (lib/filters/errors.ts → 422 at the HTTP layer) — never a silent
// pass-through toward SQL. The SQL emission itself lives in the repository
// layer (`workItemRepository.compileFilterConditionsSql`, the 4-layer rule —
// this module stays Prisma-free so the client builder can import it), keyed
// off the SAME field defs, with a totality test enumerating every
// (field × operator) triple across validate × compile × editor.
//
// Operator semantics (the story's verified Jira basic/JQL split — the builder
// ships exactly the blacklist basic can't say, as structured rows):
//   enum-ish  → is any of / is none of (+ is empty / is not empty when the
//               column is nullable; the assignee/sprint value lists also
//               accept their empty-bucket sentinel — Jira's "Unassigned")
//   text      → contains / does not contain
//   numbers   → = ≠ < ≤ > ≥ (+ empty/not-empty — both number columns are
//               nullable)
//   dates     → on or before / on or after / between / in the last N days /
//               in the next N days (+ empty/not-empty for the nullable due
//               date; created/updated are NOT NULL so the empty pair would be
//               dead weight in their menus)
//   `ne` mirrors JQL `!=`: it does NOT match empty fields (the documented
//   Jira rule); `is_none_of` on a nullable column DOES include the empty
//   bucket unless the sentinel is in the list (an unassigned issue is
//   assigned to "none of" any member list).

import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import { CI_STATES } from '@/lib/github/prCiState';
import { FIX_REASON_PRIORITY } from '@/lib/workItems/fixReason';
import { ISSUE_TYPES } from '@/lib/issues/parentRules';
import {
  FILTER_BACKLOG_TOKEN,
  FILTER_ROW_CAP,
  FILTER_UNASSIGNED_TOKEN,
  customFieldFilterFieldId,
  customFieldIdOfFilterField,
  type FilterAst,
  type FilterCombinator,
  type FilterCondition,
  type FilterConditionValue,
  type FilterFieldId,
  type FilterOperatorId,
} from './ast';
import {
  FilterTooLargeError,
  InvalidFilterValueError,
  MalformedFilterError,
  UnknownFilterFieldError,
  UnknownFilterOperatorError,
} from './errors';

export type FilterFieldType = 'enum' | 'text' | 'number' | 'date';

/** What the builder renders for a condition's value slot (6.1.3/6.1.4; the
 * Epic-5 kinds — label/component/CF-option pickers — are 6.1.5's rows). */
export type FilterValueEditorKind =
  | 'kind-select'
  | 'status-select'
  | 'ci-state-select'
  | 'fix-reason-select'
  | 'priority-select'
  | 'type-select'
  | 'difficulty-select'
  | 'obsolescence-select'
  | 'member-select'
  | 'sprint-select'
  | 'label-select'
  | 'component-select'
  | 'folder-select'
  | 'cf-option-select'
  | 'text'
  | 'number'
  | 'date'
  | 'date-range'
  | 'days'
  | 'none';

/** The five custom-field types (mirrors the Prisma `CustomFieldType` enum —
 * restated here so this module stays Prisma-free and client-importable). */
export type CustomFieldFilterType = 'text' | 'number' | 'date' | 'select' | 'user';

const ENUM_LIST_OPERATORS = ['is_any_of', 'is_none_of'] as const;
const EMPTY_OPERATORS = ['is_empty', 'is_not_empty'] as const;
const TEXT_OPERATORS = ['contains', 'not_contains'] as const;
const NUMBER_COMPARE_OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
const DATE_VALUE_OPERATORS = ['on_or_before', 'on_or_after', 'between'] as const;
const DATE_WINDOW_OPERATORS = ['in_last_days', 'in_next_days'] as const;

/** Bounds — sanity guards, not business rules. */
const MAX_LIST_VALUES = 50;
const MAX_TEXT_LENGTH = 200;
const MAX_NUMBER_MAGNITUDE = 1_000_000_000;
const MAX_WINDOW_DAYS = 365;

export interface FilterFieldDef {
  id: FilterFieldId;
  fieldType: FilterFieldType;
  /** Nullable column → the field offers the empty/not-empty pair. */
  nullable: boolean;
  /** The empty-bucket token its value lists may carry (assignee/sprint). */
  emptySentinel?: string;
  /** Closed value vocabulary (kind, priority); open ids stay unchecked here —
   * an unknown status key / member id simply matches nothing, which is safe
   * (the 2.5.4 rule) and is the stale-referent behaviour the story pins. */
  valueWhitelist?: readonly string[];
  /** The list-op value editor (enum fields only). */
  listEditor?: FilterValueEditorKind;
  operators: readonly FilterOperatorId[];
  /** Set on the dynamic `cf:<fieldId>` entries (Subtask 6.1.2) — the
   * definition the entry was built from; the compiler keys its
   * `custom_field_value` join off this. */
  customField?: { id: string; fieldType: CustomFieldFilterType };
}

function enumField(
  id: FilterFieldId,
  listEditor: FilterValueEditorKind,
  opts: { nullable?: boolean; emptySentinel?: string; valueWhitelist?: readonly string[] } = {},
): FilterFieldDef {
  return {
    id,
    fieldType: 'enum',
    nullable: opts.nullable ?? false,
    emptySentinel: opts.emptySentinel,
    valueWhitelist: opts.valueWhitelist,
    listEditor,
    operators: opts.nullable ? [...ENUM_LIST_OPERATORS, ...EMPTY_OPERATORS] : ENUM_LIST_OPERATORS,
  };
}

function numberField(id: FilterFieldId): FilterFieldDef {
  // Both number columns (storyPoints, estimateMinutes) are nullable.
  return {
    id,
    fieldType: 'number',
    nullable: true,
    operators: [...NUMBER_COMPARE_OPERATORS, ...EMPTY_OPERATORS],
  };
}

function dateField(id: FilterFieldId, nullable: boolean): FilterFieldDef {
  return {
    id,
    fieldType: 'date',
    nullable,
    operators: nullable
      ? [...DATE_VALUE_OPERATORS, ...DATE_WINDOW_OPERATORS, ...EMPTY_OPERATORS]
      : [...DATE_VALUE_OPERATORS, ...DATE_WINDOW_OPERATORS],
  };
}

const PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'] as const;

/** The registry — every built-in field, in the builder's menu order. */
export const FILTER_FIELDS: ReadonlyArray<FilterFieldDef> = [
  enumField('kind', 'kind-select', { valueWhitelist: ISSUE_TYPES }),
  enumField('status', 'status-select'),
  // The card's CI verdict (MOTIR-5470) — the *Checks* field, placed after Status
  // because that is the field a reader pairs it with (design
  // `design/work-items/design-notes.md` § *The CI badge (MOTIR-5471)*).
  //
  // NULLABLE, and the empty pair is the point rather than a formality: `null`
  // means NO PULL REQUEST HAS REPORTED AND NONE IS EXPECTED TO, which a reader
  // can name — the builder renders it as *has no checks* / *has checks* rather
  // than the generic "is empty".
  //
  // ⚠️ THE WHITELIST IS `CI_STATES`, THE SAME TUPLE THE FOLD WRITES FROM
  // (`lib/github/prCiState.ts`, MOTIR-5470) — never three strings typed out
  // again. A filter offering a value the fold never writes returns nothing, and
  // one missing a value the fold does write hides those cards; reading the tuple
  // makes both unrepresentable.
  //
  // ⚠️ AND THE FILTER IS RAW. `Checks is any of Failing` matches every card whose
  // column reads `failing` in ANY status, done included, and a person combines it
  // with Status. The badge's done-category rule is a DRAWING rule and deliberately
  // not shared here: making a saved view silently drop done cards is a worse
  // failure than showing one.
  enumField('ciState', 'ci-state-select', { nullable: true, valueWhitelist: CI_STATES }),
  // Why a card is stuck until something is repaired (`WorkItem.fixReason`,
  // MOTIR-6600) — the *To fix* field (Story MOTIR-6589 · MOTIR-6609), placed
  // right after *Checks*, the field a reader pairs it with (design
  // `design/work-items/design-notes.md` § *The TO FIX tag and banner*).
  //
  // ⚠️ THE WHITELIST IS `FIX_REASON_PRIORITY`, the one tuple the recompute ranks
  // by and a test holds equal to the Prisma enum — never four strings typed out
  // again, so a new reason (the dead-run story's) is offered here the moment it
  // exists.
  //
  // ⚠️ AND THE FILTER IS RAW, exactly as `ciState` above: it matches the column
  // in any status. The tag's done-category rule is a DRAWING rule.
  enumField('fixReason', 'fix-reason-select', {
    nullable: true,
    valueWhitelist: FIX_REASON_PRIORITY,
  }),
  enumField('priority', 'priority-select', { valueWhitelist: PRIORITIES }),
  // The work-item TYPE (Story 2.7) — a closed-set enum facet over the ten
  // `WorkItemType` members (the fixed enum keeps it equality/`in`, never
  // free-text). NULLABLE: epics/stories + every legacy row are `type = null`,
  // so the empty pair (`is_empty`/`is_not_empty`) compiles to `IS NULL` /
  // `IS NOT NULL` — the "type is null" / "untyped" bucket. `WORK_ITEM_TYPES`
  // (lib/issues/executorDefaults — the 2.7.3 single source) is the whitelist
  // the AST validation rejects unknown values against.
  enumField('type', 'type-select', { nullable: true, valueWhitelist: WORK_ITEM_TYPES }),
  // A leaf's DIFFICULTY (Story MOTIR-6016 · MOTIR-6100) — the same shape as
  // `type`: a closed nullable enum, so the empty pair addresses the unset rows
  // and `is_none_of` INCLUDES them (the registry's nullable-enum semantics).
  enumField('difficulty', 'difficulty-select', {
    nullable: true,
    valueWhitelist: WORK_ITEM_DIFFICULTIES,
  }),
  // A card's OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6583) — the same shape
  // as `difficulty`: a closed nullable enum over `WORK_ITEM_OBSOLESCENCES`, so
  // the empty pair addresses the UNMARKED cards and `is_none_of ['outdated']`
  // INCLUDES them. The filter only narrows when a condition asks for it — no
  // read excludes or re-sorts a marked card by default.
  enumField('obsolescence', 'obsolescence-select', {
    nullable: true,
    valueWhitelist: WORK_ITEM_OBSOLESCENCES,
  }),
  enumField('assignee', 'member-select', {
    nullable: true,
    emptySentinel: FILTER_UNASSIGNED_TOKEN,
  }),
  enumField('reporter', 'member-select'),
  enumField('sprint', 'sprint-select', { nullable: true, emptySentinel: FILTER_BACKLOG_TOKEN }),
  { id: 'text', fieldType: 'text', nullable: false, operators: [...TEXT_OPERATORS] },
  dateField('created', false),
  dateField('updated', false),
  dateField('due', true),
  numberField('storyPoints'),
  numberField('estimate'),
  // The Epic-5 join-backed fields (Subtask 6.1.2). Multi-valued joins, so
  // "nullable" here means "an issue may carry none" — the empty pair compiles
  // to NOT-EXISTS/EXISTS over the join rows (the 5.4.1 contract). Value ids
  // are open (label/component cuids) — existence is the stale-referent
  // resolution's job (`resolveFilterAst`), not a whitelist.
  enumField('lbl', 'label-select', { nullable: true }),
  enumField('cmp', 'component-select', { nullable: true }),
  // The FOLDER field (Story MOTIR-5309 · MOTIR-5376) — a work item's EFFECTIVE
  // folder: its own, else its root ancestor's (only a root can be filed). `is
  // any of` / `is none of` include every folder INSIDE a chosen one. Nullable:
  // an unfiled item has no effective folder, so `is none of` includes it (the
  // enum none-of rule). Value ids are open folder cuids, stale-checked against
  // the project's folders exactly like labels and components.
  enumField('folder', 'folder-select', { nullable: true }),
];

const FIELDS_BY_ID: ReadonlyMap<string, FilterFieldDef> = new Map(
  FILTER_FIELDS.map((f) => [f.id, f]),
);

/** TOTAL field lookup: a hit, or the typed 422 — never undefined. */
export function filterFieldDef(field: string): FilterFieldDef {
  const def = FIELDS_BY_ID.get(field);
  if (!def) throw new UnknownFilterFieldError(field);
  return def;
}

/** The value editor a (field, operator) pair needs — total by construction. */
export function filterValueEditorKind(
  def: FilterFieldDef,
  operator: FilterOperatorId,
): FilterValueEditorKind {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of':
      return def.listEditor ?? 'text';
    case 'is_empty':
    case 'is_not_empty':
      return 'none';
    case 'contains':
    case 'not_contains':
      return 'text';
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return 'number';
    case 'on_or_before':
    case 'on_or_after':
      return 'date';
    case 'between':
      return 'date-range';
    case 'in_last_days':
    case 'in_next_days':
      return 'days';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const parsed = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(s);
}

/** A validation failure reason, or null when the value fits the pair. */
function valueProblem(
  def: FilterFieldDef,
  operator: FilterOperatorId,
  value: FilterConditionValue,
): string | null {
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      if (!Array.isArray(value)) return 'expected a value list';
      if (value.length === 0) return 'expected at least one value';
      if (value.length > MAX_LIST_VALUES) return `over the ${MAX_LIST_VALUES}-value cap`;
      for (const v of value) {
        if (typeof v !== 'string' || v.length === 0) return 'expected non-empty string values';
        if (v.length > MAX_TEXT_LENGTH) return 'value too long';
        if (def.valueWhitelist && !def.valueWhitelist.includes(v)) return `unknown value: ${v}`;
      }
      return null;
    }
    case 'is_empty':
    case 'is_not_empty':
      return value === null ? null : 'expected no value';
    case 'contains':
    case 'not_contains': {
      if (typeof value !== 'string') return 'expected a string';
      if (value.trim().length === 0) return 'expected a non-empty string';
      if (value.length > MAX_TEXT_LENGTH) return 'value too long';
      return null;
    }
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'expected a number';
      if (Math.abs(value) > MAX_NUMBER_MAGNITUDE) return 'number out of range';
      return null;
    }
    case 'on_or_before':
    case 'on_or_after': {
      if (typeof value !== 'string' || !isValidIsoDate(value)) return 'expected a YYYY-MM-DD date';
      return null;
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) return 'expected a [from, to] date pair';
      const [from, to] = value;
      if (typeof from !== 'string' || !isValidIsoDate(from)) return 'expected a YYYY-MM-DD from';
      if (typeof to !== 'string' || !isValidIsoDate(to)) return 'expected a YYYY-MM-DD to';
      if (from > to) return 'from is after to';
      return null;
    }
    case 'in_last_days':
    case 'in_next_days': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return 'expected a day count';
      if (value < 1 || value > MAX_WINDOW_DAYS) return `expected 1–${MAX_WINDOW_DAYS} days`;
      return null;
    }
  }
}

/**
 * Validate a condition against an ALREADY-RESOLVED field def — the operator
 * (must be in the def's set) and the value arity. This is the half of
 * `validateFilterCondition` that runs once the def is in hand; the builder's
 * live-apply gate reuses it for the per-project DYNAMIC `cf:<id>` defs (which
 * `filterFieldDef` can't look up), so a custom-field row validates against its
 * own operator set exactly like a built-in one.
 */
export function validateResolvedCondition(def: FilterFieldDef, condition: FilterCondition): void {
  if (!def.operators.includes(condition.operator)) {
    throw new UnknownFilterOperatorError(condition.field, condition.operator);
  }
  const problem = valueProblem(def, condition.operator, condition.value);
  if (problem) throw new InvalidFilterValueError(condition.field, condition.operator, problem);
}

/**
 * Validate one condition against the registry — typed throws on an unknown
 * field, an operator outside the field's set, or a value that fails the
 * (field, operator) arity. Returns the field def so compile paths chain off
 * one lookup. (Built-in fields only — `cf:<id>` ids go through
 * {@link validateResolvedCondition} with the dynamic def.)
 */
export function validateFilterCondition(condition: FilterCondition): FilterFieldDef {
  const def = filterFieldDef(condition.field);
  validateResolvedCondition(def, condition);
  return def;
}

/**
 * Validate a whole AST: structure, the row cap, and every condition. The
 * service read path runs this before the repository compiles (defence in
 * depth: the compiler re-runs it, so no unvalidated AST can reach SQL even
 * through a future second caller). With Epic-5 conditions in play, pass the
 * project's referents — this is `resolveFilterAst` minus the per-condition
 * result (stale conditions are NOT errors; they compile to match-nothing).
 */
export function validateFilterAst(
  ast: FilterAst,
  referents: ProjectFilterReferents = EMPTY_PROJECT_FILTER_REFERENTS,
): void {
  resolveFilterAst(ast, referents);
}

// ---------------------------------------------------------------------------
// The Epic-5 dynamic entries + the stale-referent resolution (Subtask 6.1.2)
// ---------------------------------------------------------------------------

/** The dynamic registry entry a custom-field definition contributes — keyed
 * `cf:<fieldId>`, with the operator set of its type (the 6.1 story spec:
 * select/user get enum semantics; number/date/text their built-in type sets).
 * Every CF column is "nullable" in the filter sense: the typed-EAV substrate
 * stores NO row for an empty value (the 5.3.1 contract — `is empty` compiles
 * to NOT EXISTS), so every type offers the empty pair. */
export function customFieldFilterDef(id: string, fieldType: CustomFieldFilterType): FilterFieldDef {
  const customField = { id, fieldType };
  const fieldId = customFieldFilterFieldId(id);
  switch (fieldType) {
    case 'select':
      return {
        id: fieldId,
        fieldType: 'enum',
        nullable: true,
        listEditor: 'cf-option-select',
        operators: [...ENUM_LIST_OPERATORS, ...EMPTY_OPERATORS],
        customField,
      };
    case 'user':
      return {
        id: fieldId,
        fieldType: 'enum',
        nullable: true,
        listEditor: 'member-select',
        operators: [...ENUM_LIST_OPERATORS, ...EMPTY_OPERATORS],
        customField,
      };
    case 'number':
      return {
        id: fieldId,
        fieldType: 'number',
        nullable: true,
        operators: [...NUMBER_COMPARE_OPERATORS, ...EMPTY_OPERATORS],
        customField,
      };
    case 'date':
      return {
        id: fieldId,
        fieldType: 'date',
        nullable: true,
        operators: [...DATE_VALUE_OPERATORS, ...DATE_WINDOW_OPERATORS, ...EMPTY_OPERATORS],
        customField,
      };
    case 'text':
      return {
        id: fieldId,
        fieldType: 'text',
        nullable: true,
        operators: [...TEXT_OPERATORS, ...EMPTY_OPERATORS],
        customField,
      };
  }
}

/** A referenced custom field's resolution data: its type + which of the
 * filter's referenced option ids actually exist ON THIS FIELD (archived
 * included — historical matching, the verified Jira rule). */
export interface ProjectFilterCustomField {
  fieldType: CustomFieldFilterType;
  optionIds: ReadonlySet<string>;
}

/**
 * The per-project referent set the Epic-5 conditions resolve against — built
 * by the SERVICE from bounded reads over the ids the filter actually
 * references (never load-all, finding #57), then carried into the repository
 * compiler. An id absent here is a STALE REFERENT (a deleted
 * field/option/label/component outliving a shared or saved URL): its
 * condition degrades to the typed unknown-value state — matches nothing,
 * surfaces a per-row notice, never errors the query (the durable behaviour
 * Story 6.2 saved filters depend on).
 */
export interface ProjectFilterReferents {
  customFields: ReadonlyMap<string, ProjectFilterCustomField>;
  labelIds: ReadonlySet<string>;
  /** The names of the labels in `labelIds`, by id — for a read-only readout of
   * the filter (the board's stored-filter indicator, MOTIR-11335). Optional: a
   * referent set built without names (a test, the empty set) leaves it out. */
  labelNames?: ReadonlyMap<string, string>;
  componentIds: ReadonlySet<string>;
  /** The project's folders the filter names that still exist (MOTIR-5376). */
  folderIds: ReadonlySet<string>;
}

export const EMPTY_PROJECT_FILTER_REFERENTS: ProjectFilterReferents = {
  customFields: new Map(),
  labelIds: new Set(),
  componentIds: new Set(),
  folderIds: new Set(),
};

/** Why a condition went stale (the per-row notice 6.1.5 renders). */
export type FilterStaleReason = 'unknown-field' | 'unknown-value';

export interface ResolvedFilterCondition {
  condition: FilterCondition;
  /** The registry entry the condition resolved to — null when stale. */
  def: FilterFieldDef | null;
  stale: FilterStaleReason | null;
}

export interface ResolvedFilterAst {
  combinator: FilterCombinator;
  conditions: ResolvedFilterCondition[];
}

/** True when the AST carries any referent-backed condition (label / component
 * / folder / custom field) — the service's "do I need to load referents?" probe. */
export function astHasEpic5Conditions(ast: FilterAst): boolean {
  return ast.conditions.some(
    (c) =>
      c.field === 'lbl' ||
      c.field === 'cmp' ||
      c.field === 'folder' ||
      customFieldIdOfFilterField(c.field) !== null,
  );
}

/** The ids an AST references, for the service's bounded referent reads:
 * custom-field definition ids, the string-list values of CF rows (candidate
 * option ids — which are options is only knowable after the definitions
 * load; non-option ids simply resolve to nothing), label ids, component
 * ids, folder ids. */
export interface FilterReferentIds {
  customFieldIds: string[];
  customFieldValueIds: string[];
  labelIds: string[];
  componentIds: string[];
  folderIds: string[];
}

export function collectFilterReferentIds(ast: FilterAst): FilterReferentIds {
  const customFieldIds = new Set<string>();
  const customFieldValueIds = new Set<string>();
  const labelIds = new Set<string>();
  const componentIds = new Set<string>();
  const folderIds = new Set<string>();
  for (const { field, value } of ast.conditions) {
    const values = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    const cfId = customFieldIdOfFilterField(field);
    if (cfId !== null) {
      customFieldIds.add(cfId);
      for (const v of values) customFieldValueIds.add(v);
    } else if (field === 'lbl') {
      for (const v of values) labelIds.add(v);
    } else if (field === 'cmp') {
      for (const v of values) componentIds.add(v);
    } else if (field === 'folder') {
      for (const v of values) folderIds.add(v);
    }
  }
  return {
    customFieldIds: [...customFieldIds],
    customFieldValueIds: [...customFieldValueIds],
    labelIds: [...labelIds],
    componentIds: [...componentIds],
    folderIds: [...folderIds],
  };
}

/** The value ids a resolved enum condition must find among the referents —
 * stale-checked sets only (CF select options, labels, components, folders).
 * Open id spaces (members for user-CF / built-in pickers) stay unchecked: a
 * deleted user SetNulls values and simply matches nothing (the 2.5.4 rule). */
function staleCheckedIdSet(def: FilterFieldDef, referents: ProjectFilterReferents) {
  if (def.customField) {
    return def.customField.fieldType === 'select'
      ? referents.customFields.get(def.customField.id)?.optionIds
      : undefined;
  }
  if (def.id === 'lbl') return referents.labelIds;
  if (def.id === 'cmp') return referents.componentIds;
  if (def.id === 'folder') return referents.folderIds;
  return undefined;
}

/**
 * Resolve + validate an AST against the registry AND the project's referents
 * (Subtask 6.1.2) — the single front door for any AST that may carry Epic-5
 * conditions. Two distinct failure modes, deliberately split:
 *
 * - **Forgery is a typed throw** (→ 422): malformed structure, the row cap,
 *   an unknown STATIC field id, an operator outside a resolved field's set,
 *   a value failing its (field, operator) arity. Same contract as 6.1.1.
 * - **A stale referent is a RESULT, not an error**: a `cf:<id>` whose
 *   definition is gone resolves `stale: 'unknown-field'`; an enum condition
 *   referencing a deleted option/label/component id resolves
 *   `stale: 'unknown-value'`. The compiler turns stale conditions into
 *   match-nothing (`FALSE`); the UI renders the per-row notice.
 *
 * A stale-FIELD condition's operator/value can't be checked (no definition
 * to check against) — it is skipped, which is safe: stale conditions never
 * reach SQL at all.
 */
export function resolveFilterAst(
  ast: FilterAst,
  referents: ProjectFilterReferents = EMPTY_PROJECT_FILTER_REFERENTS,
): ResolvedFilterAst {
  if (ast.combinator !== 'and' && ast.combinator !== 'or') {
    throw new MalformedFilterError(`bad combinator: ${String(ast.combinator)}`);
  }
  if (!Array.isArray(ast.conditions)) throw new MalformedFilterError('conditions not an array');
  if (ast.conditions.length > FILTER_ROW_CAP) {
    throw new FilterTooLargeError(ast.conditions.length, FILTER_ROW_CAP);
  }
  const conditions = ast.conditions.map((condition): ResolvedFilterCondition => {
    const cfId = customFieldIdOfFilterField(condition.field);
    let def: FilterFieldDef;
    if (cfId !== null) {
      const cf = referents.customFields.get(cfId);
      if (!cf) return { condition, def: null, stale: 'unknown-field' };
      def = customFieldFilterDef(cfId, cf.fieldType);
    } else {
      def = filterFieldDef(condition.field);
    }
    if (!def.operators.includes(condition.operator)) {
      throw new UnknownFilterOperatorError(condition.field, condition.operator);
    }
    const problem = valueProblem(def, condition.operator, condition.value);
    if (problem) throw new InvalidFilterValueError(condition.field, condition.operator, problem);

    const checked = staleCheckedIdSet(def, referents);
    if (checked && Array.isArray(condition.value)) {
      const missing = condition.value.some((v) => !checked.has(v));
      if (missing) return { condition, def, stale: 'unknown-value' };
    }
    return { condition, def, stale: null };
  });
  return { combinator: ast.combinator, conditions };
}
