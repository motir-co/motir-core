'use client';

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import {
  Component as ComponentIcon,
  Folder as FolderIcon,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  TriangleAlert,
  UserX,
} from 'lucide-react';
import { DatePicker } from '@motir/design-system';
import { MultiSelectPicker, type MultiSelectOption } from '@/components/ui/MultiSelectPicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import { OBSOLESCENCE_GLYPH } from '@/components/issues/ObsolescenceBadge';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { CI_STATE_META } from '@/components/github/ciStateMeta';
import { CI_STATES } from '@/lib/github/prCiState';
import { FIX_REASON_PRIORITY } from '@/lib/workItems/fixReason';
import { FIX_REASON_VALUE_KEYS } from './advancedFilterLabels';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import { statusDotColor } from '@/lib/workflows/statusColor';
import { labelTint } from '@/lib/labels/labelTint';
import { customFieldIdOfFilterField, type FilterConditionValue } from '@/lib/filters/ast';
import type { FilterFieldDef, FilterValueEditorKind } from '@/lib/filters/registry';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import { cn } from '@/lib/utils/cn';

// The per-operator VALUE editor of an advanced-filter condition row (Subtasks
// 6.1.4 + 6.1.5), per design/work-items/filter-builder.mock.html panels 1 + 4
// — one editor per `FilterValueEditorKind` the registry resolves for the row's
// (field, operator) pair, each the SHIPPED primitive (no new size variants):
//
//   kind/status/priority/member/sprint-select → MultiSelectPicker (5.4.8),
//     options drawn with the same glyph vocabulary as the 2.5.4 facet rows
//     (IssueTypeIcon hue, status dot, PRIORITY_META direction icon, member
//     avatar); the assignee list puts the Unassigned sentinel FIRST and the
//     sprint list Backlog first (the registry's empty-bucket sentinels);
//   label-select → MultiSelectPicker fed by the BOUNDED label autocomplete
//     (debounced /api/projects/[key]/labels, finding #57), name-hash tinted
//     chips (the 5.4 less-enterprise deviation);
//   component-select → MultiSelectPicker over the project's components
//     (preloaded — bounded), neutral chips + the component glyph;
//   folder-select → MultiSelectPicker over the project's folders, labelled by
//     PATH (two teams can both keep a "2025"), the design's empty state and the
//     truncated-list note (Story MOTIR-5309 · MOTIR-5378);
//   cf-option-select → the custom field's managed options, archived ones kept
//     for historical matching with the 5.3.5 "(archived)" mark;
//   text / number / days → the input grammar (`--height-input`), days with
//     the "days" unit suffix; number/days hold a local raw string so partial
//     keystrokes don't fight the parsed value;
//   date → the shipped DatePicker trigger; date-range → two, joined by "and";
//   none (is empty / is not empty) → the value slot COLLAPSES (renders null).
//
// STALE referents (Subtask 6.1.5): a selected id the builder flagged stale
// (`staleValueIds` — a deleted option/label/component in a shared/saved URL)
// renders the designed "Unknown value" chip (peach tint + warning glyph); the
// condition matches nothing server-side and the row shows the per-row notice.

const PRIORITIES: readonly WorkItemPriorityDto[] = ['highest', 'high', 'medium', 'low', 'lowest'];

const KIND_GLYPHS = Object.fromEntries(
  ISSUE_TYPES.map((type) => [
    type,
    function KindGlyph({ className }: { className?: string }) {
      return <IssueTypeIcon type={type} className={className} />;
    },
  ]),
) as Record<IssueType, ComponentType<{ className?: string }>>;

// Mirrors the 2.5.4 facet bar's status dot via shared `statusDotColor` (per-status
// hex override, else the per-status `--el-status-*` token) at glyph size.
function statusGlyph(status: WorkflowStatusDto): ComponentType<{ className?: string }> {
  const color = statusDotColor(status);
  return function StatusGlyph({ className }: { className?: string }) {
    return (
      <span
        aria-hidden
        className={cn('shrink-0 rounded-full border border-(--el-border)', className)}
        style={{ backgroundColor: color }}
      />
    );
  };
}

function memberGlyph(name: string): ComponentType<{ className?: string }> {
  const initial = name.charAt(0).toUpperCase();
  return function MemberGlyph({ className }: { className?: string }) {
    return (
      <span
        aria-hidden
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[8px] font-semibold text-(--el-text-inverted)',
          className,
        )}
      >
        {initial}
      </span>
    );
  };
}

function UnassignedGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-(--el-border) text-(--el-text-muted)',
        className,
      )}
    >
      <UserX className="h-[70%] w-[70%]" aria-hidden />
    </span>
  );
}

function ComponentGlyph({ className }: { className?: string }) {
  return <ComponentIcon className={className} aria-hidden />;
}

function FolderGlyph({ className }: { className?: string }) {
  return <FolderIcon className={className} aria-hidden />;
}

function StaleGlyph({ className }: { className?: string }) {
  return <TriangleAlert className={className} aria-hidden />;
}

function filterByQuery(options: MultiSelectOption[], query: string): MultiSelectOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return options;
  return options.filter((o) => o.label.toLowerCase().includes(q));
}

const INPUT_CLASS =
  'h-(--height-input) rounded-(--radius-input) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-input-x) font-sans text-sm text-(--el-text) placeholder:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-(--el-surface-soft)';

/** A numeric input holding the raw keystrokes locally (so "5." doesn't snap
 * back to "5") while pushing the parsed value — or null while unparseable
 * (the pending state) — to the row. */
function NumberValueInput({
  value,
  onChange,
  integer,
  label,
  disabled,
  className,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  /** Day windows are integers; number comparisons accept decimals. */
  integer?: boolean;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  // Reconcile when the row's value changes EXTERNALLY (operator carry-over,
  // URL resync) — the guarded adjust-during-render pattern; a user-driven
  // change already matches and is a no-op.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const parsed = integer ? Number.parseInt(raw, 10) : Number(raw);
    if (value === null || raw.trim() === '' || parsed !== value) {
      setRaw(value === null ? '' : String(value));
    }
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={raw}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        const trimmed = next.trim();
        if (trimmed === '') {
          onChange(null);
          return;
        }
        const parsed = integer ? Number.parseInt(trimmed, 10) : Number(trimmed);
        onChange(Number.isFinite(parsed) && String(parsed) === trimmed ? parsed : null);
      }}
      className={cn(INPUT_CLASS, 'w-[110px] tabular-nums', className)}
    />
  );
}

/** Map a row's selected ids to chips against a known-options index, replacing
 * any id the builder flagged stale with the designed "Unknown value" chip and
 * falling back to the raw id for an unknown-but-open id (the 2.5.4 rule — a
 * deleted member/sprint just renders its id and matches nothing). */
function resolveChipValues(
  ids: string[],
  optionsById: Map<string, MultiSelectOption>,
  staleValueIds: ReadonlySet<string>,
  staleLabel: string,
): MultiSelectOption[] {
  return ids.map((id) => {
    if (staleValueIds.has(id)) return { id, label: staleLabel, tint: 'peach', glyph: StaleGlyph };
    return optionsById.get(id) ?? { id, label: id };
  });
}

export interface AdvancedFilterValueEditorProps {
  def: FilterFieldDef;
  editorKind: FilterValueEditorKind;
  value: FilterConditionValue | null;
  /** `debounce: true` marks free-typing edits (text/number/days) so the
   * parent delays the live-apply URL push; discrete edits apply at once. */
  onChange: (value: FilterConditionValue | null, opts?: { debounce?: boolean }) => void;
  /** The field's display name — names the editor for SR users. */
  fieldLabel: string;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  /** The project's custom-field definitions (their managed options feed the
   * `cf-option-select` editor) — Subtask 6.1.5. */
  customFields: CustomFieldDefinitionDTO[];
  /** The project's components (the `component-select` editor's bounded set). */
  components: ComponentDto[];
  /** The project's folders (the `folder-select` editor's bounded set) — absent on
   * a host that offers no Folder field. */
  folders?: ProjectFoldersDto;
  /** The active filter's referenced labels, resolved to names server-side —
   * seeds the `label-select` chips on first paint (the autocomplete window
   * fills in the rest as the user types). */
  referencedLabels: LabelDto[];
  /** Project identifier — the label editor's debounced autocomplete read. */
  projectKey: string;
  /** Ids in this row's value the builder determined are STALE (deleted
   * referents) — rendered as the "Unknown value" chip. */
  staleValueIds: ReadonlySet<string>;
  disabled?: boolean;
  /** Extra classes for the editor's BORDERED control — the row passes the
   * dashed pending treatment through here (mock panel 3). */
  className?: string;
}

const LABEL_SEARCH_DEBOUNCE_MS = 200;

/** The label value editor (Subtask 6.1.5) — a MultiSelectPicker over the
 * BOUNDED label autocomplete (debounced fetch, finding #57), name-hash tinted
 * chips. Keeps a cache of every label it has seen (the server-resolved
 * referenced set + each autocomplete window) so a selected chip keeps its name
 * + tint even after the query that surfaced it changes. */
function LabelValueEditor({
  value,
  onChange,
  valuesAria,
  projectKey,
  referencedLabels,
  staleValueIds,
  disabled,
  className,
}: {
  value: FilterConditionValue | null;
  onChange: (value: FilterConditionValue | null) => void;
  valuesAria: string;
  projectKey: string;
  referencedLabels: LabelDto[];
  staleValueIds: ReadonlySet<string>;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('issueViews');
  const [query, setQuery] = useState('');
  const [windowLabels, setWindowLabels] = useState<LabelDto[]>([]);
  // The name cache — seeded from the server-resolved referenced labels, grown
  // by every autocomplete window so a picked chip keeps its name + tint even
  // after the query that surfaced it changes. State (not a ref) so reads stay
  // render-safe and a new window re-renders the chips.
  const [cache, setCache] = useState<Map<string, LabelDto>>(
    () => new Map(referencedLabels.map((l) => [l.id, l])),
  );
  // Drops a stale autocomplete response that resolves after a newer one.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectKey)}/labels?q=${encodeURIComponent(query.trim())}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { labels: LabelDto[] };
        if (seq !== fetchSeq.current) return;
        setWindowLabels(body.labels);
        setCache((prev) => {
          const next = new Map(prev);
          for (const l of body.labels) next.set(l.id, l);
          return next;
        });
      } catch {
        // A failed window just leaves the previous one; the next keystroke retries.
      }
    }, LABEL_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, projectKey]);

  const ids = Array.isArray(value) ? value : [];
  const toOption = (l: LabelDto): MultiSelectOption => ({
    id: l.id,
    label: l.name,
    tint: labelTint(l.name),
  });
  const optionsById = new Map<string, MultiSelectOption>(
    [...cache.values()].map((l) => [l.id, toOption(l)]),
  );
  const values = resolveChipValues(ids, optionsById, staleValueIds, t('advancedStaleValue'));
  const options = filterByQuery(windowLabels.map(toOption), query);

  const toggle = (option: MultiSelectOption) => {
    const next = ids.includes(option.id)
      ? ids.filter((id) => id !== option.id)
      : [...ids, option.id];
    onChange(next.length > 0 ? next : null);
  };
  return (
    <MultiSelectPicker
      values={values}
      options={options}
      onToggle={toggle}
      onRemove={toggle}
      query={query}
      onQueryChange={setQuery}
      label={valuesAria}
      placeholder={t('advancedAddValuePlaceholder')}
      removeLabel={(label) => t('advancedRemoveValue', { value: label })}
      emptyText={t('advancedNoMatches')}
      disabled={disabled}
      className={className}
    />
  );
}

/** The difficulty scale's glyph — lucide's signal bars, one per step. */
const DIFFICULTY_GLYPH: Record<WorkItemDifficultyDto, ComponentType<{ className?: string }>> = {
  trivial: SignalLow,
  low: SignalMedium,
  medium: SignalHigh,
  high: Signal,
};

export function AdvancedFilterValueEditor({
  def,
  editorKind,
  value,
  onChange,
  fieldLabel,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
  projectKey,
  staleValueIds,
  disabled,
  className,
}: AdvancedFilterValueEditorProps) {
  const t = useTranslations('issueViews');
  const tType = useTranslations('labels.issueType');
  const tStatus = useTranslations('labels.defaultStatus');
  const tPriority = useTranslations('labels.priority');
  // The badge's own strings, so the builder and the row cannot disagree.
  const tGithub = useTranslations('github');
  const tWorkType = useTranslations('labels.workItemType');
  const tDifficulty = useTranslations('labels.difficulty');
  const tFixReason = useTranslations('workbench.toFix.reason');
  const tObsolescence = useTranslations('labels.obsolescence');
  const tFolders = useTranslations('folders');
  const [query, setQuery] = useState('');

  // The custom field this row filters on (for cf-option-select) — resolved
  // from the dynamic def's marker; its managed options feed the editor.
  const customFieldId = customFieldIdOfFilterField(def.id);
  const customFieldDef = customFieldId
    ? customFields.find((f) => f.id === customFieldId)
    : undefined;

  const enumOptions = useMemo<MultiSelectOption[]>(() => {
    switch (editorKind) {
      case 'kind-select':
        return ISSUE_TYPES.map((type) => ({
          id: type,
          label: tType(type),
          glyph: KIND_GLYPHS[type],
        }));
      case 'status-select':
        return statuses.map((s) => ({
          id: s.key,
          label: DEFAULT_STATUS_KEYS.has(s.key) ? tStatus(s.key) : s.label,
          glyph: statusGlyph(s),
        }));
      // The three CI verdicts, WORST-FIRST — the order `CI_STATES` declares and
      // `foldCardCiState` applies, so the menu reads in the same order as the
      // fold's precedence. Each carries the SAME glyph the badge draws
      // (`CI_STATE_META`), so a value in the builder and a badge on a row are
      // recognisably the same thing.
      case 'ci-state-select':
        return CI_STATES.map((state) => ({
          id: state,
          label: tGithub(`development.ciState.${state}`),
          glyph: CI_STATE_META[state].icon,
        }));
      // The *To fix* reasons (MOTIR-6609) in PRIORITY order — the order the
      // recompute ranks them and the tab lists them — labelled with the Workbench
      // tab's own bare reason words. No glyph: all four reasons draw the SAME tag
      // (design § *The TO FIX tag and banner*), so a per-reason glyph here would
      // invent a distinction the rows never show.
      case 'fix-reason-select':
        return FIX_REASON_PRIORITY.map((reason) => ({
          id: reason,
          label: tFixReason(FIX_REASON_VALUE_KEYS[reason]),
        }));
      case 'priority-select':
        return PRIORITIES.map((p) => ({
          id: p,
          label: tPriority(p),
          glyph: PRIORITY_META[p].icon,
        }));
      case 'type-select':
        // The ten work-item TYPE members (Story 2.7). Label-only here — the
        // hued per-type chip (the `--el-type-*` treatment + the create/detail
        // picker) is owned by 2.7.4; the filter facet just needs the closed
        // set with its labels.
        return WORK_ITEM_TYPES.map((wt) => ({
          id: wt,
          label: tWorkType(wt),
        }));
      case 'difficulty-select':
        // A leaf's DIFFICULTY (Story MOTIR-6016), easiest first, each with the
        // quiet signal glyph the item page draws — never a hue, because Priority
        // owns the same words in a coloured pill (the approved design).
        return WORK_ITEM_DIFFICULTIES.map((d) => ({
          id: d,
          label: tDifficulty(d),
          glyph: DIFFICULTY_GLYPH[d],
        }));
      case 'obsolescence-select':
        // The OBSOLESCENCE mark (Story MOTIR-6575 · MOTIR-6678), mildest first,
        // each with the badge's own glyph, so a value here and a badge on a row
        // are recognisably the same thing.
        return WORK_ITEM_OBSOLESCENCES.map((o) => ({
          id: o,
          label: tObsolescence(o),
          glyph: OBSOLESCENCE_GLYPH[o],
        }));
      case 'member-select': {
        const options = members.map((m) => ({
          id: m.userId,
          label: m.name,
          glyph: memberGlyph(m.name),
        }));
        // The empty-bucket sentinel (assignee → Unassigned) leads the list.
        return def.emptySentinel
          ? [{ id: def.emptySentinel, label: t('unassigned'), glyph: UnassignedGlyph }, ...options]
          : options;
      }
      case 'sprint-select': {
        const options = sprints.map((s) => ({ id: s.id, label: s.name }));
        return def.emptySentinel
          ? [{ id: def.emptySentinel, label: t('advancedBacklog') }, ...options]
          : options;
      }
      case 'component-select':
        return components.map((c) => ({ id: c.id, label: c.name, glyph: ComponentGlyph }));
      case 'folder-select':
        return (folders?.folders ?? []).map((f) => ({
          id: f.id,
          label: f.path.join(' ▸ '),
          glyph: FolderGlyph,
        }));
      case 'cf-option-select':
        // Managed options, archived kept for historical matching (5.3.5 mark).
        return (customFieldDef?.options ?? []).map((o) => ({
          id: o.id,
          label: o.archived ? t('advancedArchivedOption', { label: o.label }) : o.label,
        }));
      default:
        return [];
    }
  }, [
    editorKind,
    def.emptySentinel,
    statuses,
    members,
    sprints,
    components,
    folders,
    customFieldDef,
    t,
    tType,
    tStatus,
    tPriority,
    tWorkType,
    tDifficulty,
    tObsolescence,
    tGithub,
    tFixReason,
  ]);

  const valuesAria = t('advancedValuesAria', { field: fieldLabel });

  switch (editorKind) {
    case 'none':
      // is empty / is not empty — the value slot collapses (mock panel 1).
      return <div />;

    case 'label-select':
      // The bounded autocomplete editor owns its own fetch/cache state.
      return (
        <LabelValueEditor
          value={value}
          onChange={onChange}
          valuesAria={valuesAria}
          projectKey={projectKey}
          referencedLabels={referencedLabels}
          staleValueIds={staleValueIds}
          disabled={disabled}
          className={className}
        />
      );

    case 'kind-select':
    case 'status-select':
    case 'ci-state-select':
    case 'fix-reason-select':
    case 'priority-select':
    case 'type-select':
    case 'difficulty-select':
    case 'obsolescence-select':
    case 'member-select':
    case 'sprint-select':
    case 'component-select':
    case 'folder-select':
    case 'cf-option-select': {
      const ids = Array.isArray(value) ? value : [];
      const optionsById = new Map(enumOptions.map((o) => [o.id, o]));
      const values = resolveChipValues(ids, optionsById, staleValueIds, t('advancedStaleValue'));
      const toggle = (option: MultiSelectOption) => {
        const next = ids.includes(option.id)
          ? ids.filter((id) => id !== option.id)
          : [...ids, option.id];
        onChange(next.length > 0 ? next : null);
      };
      return (
        <MultiSelectPicker
          values={values}
          options={filterByQuery(enumOptions, query)}
          onToggle={toggle}
          onRemove={toggle}
          query={query}
          onQueryChange={setQuery}
          label={valuesAria}
          placeholder={t('advancedAddValuePlaceholder')}
          removeLabel={(label) => t('advancedRemoveValue', { value: label })}
          emptyText={
            editorKind === 'folder-select' && enumOptions.length === 0
              ? t('advancedFolderNone')
              : t('advancedNoMatches')
          }
          hint={
            editorKind === 'folder-select' && folders?.truncated
              ? tFolders('pickerTruncated', { count: folders.folders.length })
              : undefined
          }
          disabled={disabled}
          className={className}
        />
      );
    }

    case 'text':
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-label={valuesAria}
          onChange={(e) => onChange(e.target.value, { debounce: true })}
          className={cn(INPUT_CLASS, 'w-full', className)}
        />
      );

    case 'number':
      return (
        <NumberValueInput
          value={typeof value === 'number' ? value : null}
          onChange={(next) => onChange(next, { debounce: true })}
          label={valuesAria}
          disabled={disabled}
          className={className}
        />
      );

    case 'days':
      return (
        <div className="flex min-w-0 items-center gap-2">
          <NumberValueInput
            value={typeof value === 'number' ? value : null}
            onChange={(next) => onChange(next, { debounce: true })}
            integer
            label={t('advancedDayCountAria')}
            disabled={disabled}
            className={cn('w-[84px]', className)}
          />
          <span className="shrink-0 text-[13px] text-(--el-text-muted)">{t('advancedDays')}</span>
        </div>
      );

    case 'date':
      return (
        <DatePicker
          value={typeof value === 'string' ? value : null}
          onChange={(next) => onChange(next)}
          aria-label={t('advancedPickDateAria', { field: fieldLabel })}
          placeholder={t('advancedPickDate')}
          disabled={disabled}
          className={className}
        />
      );

    case 'date-range': {
      const [from, to] = Array.isArray(value) && value.length === 2 ? value : ['', ''];
      const update = (nextFrom: string, nextTo: string) =>
        onChange(nextFrom === '' && nextTo === '' ? null : [nextFrom, nextTo]);
      return (
        <div className="flex min-w-0 items-center gap-2">
          <DatePicker
            value={typeof from === 'string' && from !== '' ? from : null}
            onChange={(next) => update(next ?? '', typeof to === 'string' ? to : '')}
            aria-label={t('advancedPickFromDateAria', { field: fieldLabel })}
            placeholder={t('advancedPickDate')}
            disabled={disabled}
            className={className}
          />
          <span className="shrink-0 text-[13px] text-(--el-text-muted)">{t('advancedAnd')}</span>
          <DatePicker
            value={typeof to === 'string' && to !== '' ? to : null}
            onChange={(next) => update(typeof from === 'string' ? from : '', next ?? '')}
            aria-label={t('advancedPickToDateAria', { field: fieldLabel })}
            placeholder={t('advancedPickDate')}
            disabled={disabled}
            className={className}
          />
        </div>
      );
    }
  }
}
