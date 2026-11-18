'use client';

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Component as ComponentIcon,
  Folder,
  Info,
  Plus,
  Tag,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Segmented } from '@/components/ui/Segmented';
import { CUSTOM_FIELD_TYPE_META } from '@/lib/customFields/typeMeta';
import {
  advancedBuilderFields,
  carryValueAcrossOperator,
  defaultOperator,
  FILTER_ROW_CAP,
  isRowComplete,
  rowsFromAst,
  type AdvancedBuilderRow,
} from '@/lib/issues/issueListAdvancedFilter';
import {
  advancedFieldGroup,
  buildAdvancedFilterFieldDefs,
  computeAdvancedFilterStale,
  type AdvancedFieldGroup,
} from '@/lib/issues/advancedFilterFields';
import {
  customFieldFilterFieldId,
  type FilterAst,
  type FilterCombinator,
  type FilterFieldId,
  type FilterOperatorId,
} from '@/lib/filters/ast';
import { filterFieldDef, filterValueEditorKind, type FilterFieldDef } from '@/lib/filters/registry';
import { UnknownFilterFieldError } from '@/lib/filters/errors';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import { cn } from '@/lib/utils/cn';
import { AdvancedFilterValueEditor } from './AdvancedFilterValueEditor';
import {
  advancedFieldLabel,
  advancedOperatorLabel,
  type DynamicFieldLabels,
} from './advancedFilterLabels';

// The CONTROLLED condition-group builder (Story 6.1 · Subtask 6.1.4), extracted
// from `IssueAdvancedFilter` so the SAME predicate UI is mounted in two
// surfaces — the /items advanced-filter popover (URL-backed) and the Story 6.6
// automation rule editor's "If" block (form-state-backed). There is exactly ONE
// predicate UI in the product; 6.6.5 reuses this, it does not fork it
// (design/projects/automation.mock.html panel 1, the 6.1.3 `.cond` grammar
// verbatim). The HOST owns what a committed change MEANS (push the `?filter=`
// param, or set a form field); this component owns the combinator + rows + the
// add-condition affordance + the 20-row cap, all rendered FROM the registry.

const FIELD_TRIGGER_WIDTH = 'w-[158px] shrink-0';
const OPERATOR_TRIGGER_WIDTH = 'w-[168px] shrink-0';
const PENDING_CONTROL = 'border-dashed text-(--el-text-muted)';

/** The builder's working copy — the combinator + the rows (incl. PENDING rows,
 * which live only here, never in the committed AST). */
export interface WorkingState {
  combinator: FilterCombinator;
  rows: AdvancedBuilderRow[];
}

/** Seed a working copy from a committed AST (null = empty group). */
export function workingFromAst(ast: FilterAst | null): WorkingState {
  return { combinator: ast?.combinator ?? 'and', rows: rowsFromAst(ast) };
}

const GROUP_LABEL_KEYS: Record<AdvancedFieldGroup, string> = {
  fields: 'advancedGroupFields',
  customFields: 'advancedGroupCustomFields',
  other: 'advancedGroupOther',
};

/** Resolve a row's def — the menu set first (built-ins + dynamic `cf:<id>`
 * entries), then the static registry; null for a field id nothing knows (a
 * STALE custom field), rendered as the degraded unknown-field row. */
function rowDef(menuFields: FilterFieldDef[], field: FilterFieldId): FilterFieldDef | null {
  const fromMenu = menuFields.find((f) => f.id === field);
  if (fromMenu) return fromMenu;
  try {
    return filterFieldDef(field);
  } catch (err) {
    if (err instanceof UnknownFilterFieldError) return null;
    throw err;
  }
}

/** The leading glyph for a field def in the menu + trigger (Subtask 6.1.5). */
function fieldIcon(def: FilterFieldDef): ReactNode | undefined {
  if (def.customField) {
    const Glyph = CUSTOM_FIELD_TYPE_META[def.customField.fieldType].icon;
    return <Glyph className="h-4 w-4 text-(--el-text-muted)" aria-hidden />;
  }
  if (def.id === 'lbl') return <Tag className="h-4 w-4 text-(--el-text-muted)" aria-hidden />;
  if (def.id === 'cmp') {
    return <ComponentIcon className="h-4 w-4 text-(--el-text-muted)" aria-hidden />;
  }
  if (def.id === 'folder') {
    return <Folder className="h-4 w-4 text-(--el-text-muted)" aria-hidden />;
  }
  return undefined;
}

/** The resolved field vocabulary + stale-referent set + def resolver a builder
 * needs — shared by both hosts so the menu + stale detection never drift. */
export interface FilterConditionModel {
  menuFields: FilterFieldDef[];
  dynamicLabels: DynamicFieldLabels;
  stale: { staleValueIds: ReadonlySet<string> };
  resolveDef: (field: FilterFieldId) => FilterFieldDef | null;
}

/** Build the field menu (built-ins + one `cf:<id>` per definition), the dynamic
 * label map, the stale set (from the committed AST), and a def resolver — the
 * registry-driven model both the popover and the rule editor consume. `fields`
 * overrides the menu for tests (the registry-driven AC). */
export function useFilterConditionModel(args: {
  ast: FilterAst | null;
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders (Story MOTIR-5309 · MOTIR-5378). Every project host
   * loads them server-side and passes them — `/items`, automation rules, the
   * board's toolbar, create-board and applied bars (MOTIR-11667). Leaving it out
   * offers no Folder field, rather than one with nothing to pick, so a host
   * without a project's folder list cannot offer a field it cannot fill. */
  folders?: ProjectFoldersDto;
  referencedLabels: LabelDto[];
  fields?: FilterFieldDef[];
}): FilterConditionModel {
  const { ast, customFields, components, folders, referencedLabels, fields } = args;

  const offersFolders = folders !== undefined;
  const menuFields = useMemo(
    () =>
      advancedBuilderFields(
        fields ??
          buildAdvancedFilterFieldDefs(
            customFields.map((f) => ({ id: f.id, fieldType: f.fieldType })),
          ),
      ).filter((def) => offersFolders || def.id !== 'folder'),
    [fields, customFields, offersFolders],
  );

  const dynamicLabels = useMemo<DynamicFieldLabels>(
    () => new Map(customFields.map((f) => [customFieldFilterFieldId(f.id), f.label] as const)),
    [customFields],
  );

  const stale = useMemo(
    () =>
      computeAdvancedFilterStale(ast ?? { combinator: 'and', conditions: [] }, {
        customFields: new Map(
          customFields.map((f) => [
            f.id,
            { fieldType: f.fieldType, optionIds: new Set(f.options.map((o) => o.id)) },
          ]),
        ),
        labelIds: new Set(referencedLabels.map((l) => l.id)),
        componentIds: new Set(components.map((c) => c.id)),
        // Only a COMPLETE folder list can say a folder is gone — a truncated
        // window would flag a real folder past the cap.
        folderIds:
          folders && !folders.truncated ? new Set(folders.folders.map((f) => f.id)) : undefined,
      }),
    [ast, customFields, referencedLabels, components, folders],
  );

  const resolveDef = useMemo(
    () => (field: FilterFieldId) => rowDef(menuFields, field),
    [menuFields],
  );

  return { menuFields, dynamicLabels, stale, resolveDef };
}

export interface FilterConditionBuilderProps {
  /** The working copy (combinator + rows). The host owns this state. */
  working: WorkingState;
  /** Commit an edited working copy. `debounce` marks free-typing edits (the
   * host decides whether to honour it — the URL host debounces its push). */
  onChange: (next: WorkingState, opts?: { debounce?: boolean }) => void;
  /** The registry-driven model (see {@link useFilterConditionModel}). */
  model: FilterConditionModel;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders — the Folder row's value editor (MOTIR-5378). */
  folders?: ProjectFoldersDto;
  referencedLabels: LabelDto[];
  projectKey: string;
  /** Hide the combinator sentence when a single-or-empty group makes it noise
   * (the host may always show it; defaults to shown). */
  showCombinator?: boolean;
  /** Where the builder's edits take effect. `'live'` (default) — the `/items`
   * and board-toolbar popovers, where every edit applies at once; `'form'` — a
   * host that applies nothing until its own Create / Save (the create-board
   * dialog, MOTIR-11333), whose foot line must not say "applied live". */
  host?: 'live' | 'form';
}

/**
 * The controlled condition group. Owns its synchronous working twin
 * (`workingRef`, the finding-#58 burst-stacking pattern) so two edits fired
 * before a re-render stack rather than clobber; every edit composes onto the
 * ref and calls {@link FilterConditionBuilderProps.onChange}. Stateless
 * otherwise — the host holds the durable `working` state.
 */
export function FilterConditionBuilder({
  working,
  onChange,
  model,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
  projectKey,
  showCombinator = true,
  host = 'live',
}: FilterConditionBuilderProps) {
  const t = useTranslations('issueViews');
  const { menuFields, dynamicLabels, stale } = model;

  // The synchronous twin of `working`: an edit composes onto it (not the
  // render-time closure), so a burst of edits before a re-render stacks.
  const workingRef = useRef(working);
  useEffect(() => {
    workingRef.current = working;
  }, [working]);

  function commit(next: WorkingState, opts?: { debounce?: boolean }) {
    workingRef.current = next;
    onChange(next, opts);
  }

  function addRow() {
    const current = workingRef.current;
    const def = menuFields[0];
    if (!def || current.rows.length >= FILTER_ROW_CAP) return;
    const key = current.rows.reduce((max, r) => Math.max(max, r.key), 0) + 1;
    commit({
      ...current,
      rows: [...current.rows, { key, field: def.id, operator: defaultOperator(def), value: null }],
    });
  }

  function updateRow(key: number, patch: (row: AdvancedBuilderRow) => AdvancedBuilderRow) {
    return (opts?: { debounce?: boolean }) => {
      const current = workingRef.current;
      commit({ ...current, rows: current.rows.map((r) => (r.key === key ? patch(r) : r)) }, opts);
    };
  }

  function removeRow(key: number) {
    const current = workingRef.current;
    commit({ ...current, rows: current.rows.filter((r) => r.key !== key) });
  }

  const atCap = working.rows.length >= FILTER_ROW_CAP;

  const fieldOptions: ComboboxOption<FilterFieldId>[] = menuFields.map((def) => ({
    value: def.id,
    label: advancedFieldLabel(t, def.id, dynamicLabels),
    icon: fieldIcon(def),
    group: t(GROUP_LABEL_KEYS[advancedFieldGroup(def)]),
    secondary: def.id === 'text' ? t('advancedFieldTextSecondary') : undefined,
  }));

  return (
    <div className="flex flex-col gap-2">
      {showCombinator ? (
        <div className="flex items-center gap-2 pb-0.5 text-[13px] text-(--el-text-secondary)">
          <span>{t('advancedMatchPrefix')}</span>
          <Segmented
            label={t('advancedCombinatorAria')}
            value={working.combinator}
            onChange={(combinator: FilterCombinator) =>
              commit({ ...workingRef.current, combinator })
            }
            options={[
              { value: 'and', label: t('advancedMatchAll') },
              { value: 'or', label: t('advancedMatchAny') },
            ]}
          />
          <span>{t('advancedMatchSuffix')}</span>
        </div>
      ) : null}

      {working.rows.map((row, index) => {
        const def = rowDef(menuFields, row.field);
        // A STALE custom FIELD (definition deleted) — the row degrades to the
        // unknown-field state: name shown, editors disabled, removable, kept in
        // the applied AST (match-nothing).
        if (def === null) {
          return (
            <StaleFieldRow
              key={row.key}
              index={index}
              fieldLabel={advancedFieldLabel(t, row.field, dynamicLabels)}
              onRemove={() => removeRow(row.key)}
            />
          );
        }
        const inMenu = menuFields.some((f) => f.id === def.id);
        const editorKind = filterValueEditorKind(def, row.operator);
        const pending = !isRowComplete(row, def);
        const rowValueIds = Array.isArray(row.value) ? row.value : [];
        const rowStale = rowValueIds.some((v) => stale.staleValueIds.has(v));
        const operatorOptions: ComboboxOption<FilterOperatorId>[] = def.operators.map((op) => ({
          value: op,
          label: advancedOperatorLabel(t, op, def.id),
        }));
        return (
          <div
            key={row.key}
            role="group"
            aria-label={t('advancedConditionLabel', { n: index + 1 })}
            className="grid grid-cols-[158px_168px_minmax(0,1fr)_26px] items-center gap-2"
          >
            <Combobox
              options={fieldOptions}
              value={inMenu ? def.id : null}
              onChange={(field) => {
                const nextDef = menuFields.find((f) => f.id === field);
                if (!nextDef || field === row.field) return;
                updateRow(row.key, (r) => ({
                  ...r,
                  field,
                  operator: defaultOperator(nextDef),
                  value: null,
                }))();
              }}
              label={t('advancedFieldAria')}
              placeholder={advancedFieldLabel(t, def.id, dynamicLabels)}
              searchable
              searchPlaceholder={t('advancedSearchFields')}
              emptyText={t('advancedNoMatches')}
              disabled={!inMenu}
              className={cn(FIELD_TRIGGER_WIDTH, pending && PENDING_CONTROL)}
            />
            <Combobox
              options={operatorOptions}
              value={row.operator}
              onChange={(operator) =>
                updateRow(row.key, (r) => ({
                  ...r,
                  operator,
                  value: carryValueAcrossOperator(def, r.operator, operator, r.value),
                }))()
              }
              label={t('advancedOperatorAria')}
              disabled={!inMenu}
              className={cn(OPERATOR_TRIGGER_WIDTH, pending && PENDING_CONTROL)}
            />
            <AdvancedFilterValueEditor
              def={def}
              editorKind={editorKind}
              value={row.value}
              onChange={(value, opts) => updateRow(row.key, (r) => ({ ...r, value }))(opts)}
              fieldLabel={advancedFieldLabel(t, def.id, dynamicLabels)}
              statuses={statuses}
              members={members}
              sprints={sprints}
              customFields={customFields}
              components={components}
              folders={folders}
              referencedLabels={referencedLabels}
              projectKey={projectKey}
              staleValueIds={stale.staleValueIds}
              disabled={!inMenu}
              className={pending ? PENDING_CONTROL : undefined}
            />
            <button
              type="button"
              onClick={() => removeRow(row.key)}
              aria-label={t('advancedRemoveCondition', { n: index + 1 })}
              className="inline-flex h-(--height-control-28) w-[26px] items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
            {rowStale ? (
              <p
                role="status"
                className="col-span-full -mt-1 flex items-center gap-1.5 text-xs text-(--el-text-secondary)"
              >
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-(--el-warning)" aria-hidden />
                {t('advancedStaleNote')}
              </p>
            ) : pending ? (
              <p className="col-span-full -mt-1 text-xs text-(--el-text-muted) italic">
                {t('advancedPendingNote')}
              </p>
            ) : null}
            {/* Under a Folder list-operator row only (placement.mock.html panel 5):
                the predicate matches the chosen folders AND every folder inside
                them, so the row says so before a sub-folder's work disappears. */}
            {def.id === 'folder' && editorKind !== 'none' ? (
              <p className="col-span-full -mt-1 flex items-center gap-1.5 text-xs text-(--el-text-secondary)">
                <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('advancedFolderIncludesInside')}
              </p>
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          disabled={atCap}
          onClick={addRow}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            atCap ? 'cursor-default text-(--el-text-faint)' : 'text-(--el-link) hover:underline',
          )}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('advancedAddCondition')}
        </button>
        <span className="text-xs text-(--el-text-muted) tabular-nums">
          {atCap
            ? t('advancedCapReached', { cap: FILTER_ROW_CAP })
            : t(host === 'form' ? 'advancedFootHintForm' : 'advancedFootHint', {
                count: working.rows.length,
                cap: FILTER_ROW_CAP,
              })}
        </span>
      </div>
    </div>
  );
}

/** The degraded unknown-field row (Subtask 6.1.5): a deleted custom field's
 * condition stays visible + removable, editors disabled, matching nothing. */
function StaleFieldRow({
  index,
  fieldLabel,
  onRemove,
}: {
  index: number;
  fieldLabel: string;
  onRemove: () => void;
}) {
  const t = useTranslations('issueViews');
  return (
    <div
      role="group"
      aria-label={t('advancedConditionLabel', { n: index + 1 })}
      className="grid grid-cols-[158px_minmax(0,1fr)_26px] items-center gap-2"
    >
      <span
        className={cn(
          'inline-flex h-(--height-control) items-center gap-2 truncate rounded-(--radius-input) border border-dashed border-(--el-border) px-(--spacing-control-x) text-sm text-(--el-text-muted)',
          FIELD_TRIGGER_WIDTH,
        )}
      >
        <TriangleAlert className="h-4 w-4 shrink-0 text-(--el-warning)" aria-hidden />
        <span className="truncate">{fieldLabel}</span>
      </span>
      <span className="flex items-center gap-1.5 text-xs text-(--el-text-secondary)">
        {t('advancedStaleFieldNote')}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('advancedRemoveCondition', { n: index + 1 })}
        className="inline-flex h-(--height-control-28) w-[26px] items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
