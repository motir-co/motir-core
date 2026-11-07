'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Filter, TriangleAlert, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { DatePicker } from '@motir/design-system';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { astFromRows } from '@/lib/issues/issueListAdvancedFilter';
import {
  AUTOMATION_ACTIONS_PER_RULE_CAP,
  AUTOMATION_RULE_NAME_MAX_LENGTH,
} from '@/lib/automation/constants';
import {
  AUTOMATION_FIELD_CHANGED_FIELDS,
  AUTOMATION_SET_FIELDS,
  type AutomationFieldChangedFieldId,
  type AutomationSetFieldId,
} from '@/lib/automation/fields';
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_TRIGGER_TYPES,
  automationActionDef,
  automationTriggerDef,
  type AutomationActionEditorKind,
  type AutomationActionType,
  type AutomationTriggerType,
} from '@/lib/automation/registry';

/**
 * Action types whose config editor this surface renders today. The 6.6.3
 * registry added four Epic-5 actions (add_watcher / add_comment / add_label /
 * set_custom_field) whose dedicated config editors are a 6.6.5 follow-up; until
 * those land we don't OFFER them in the picker (the backend + registries fully
 * support them — only the authoring UI is pending), so an author never lands on
 * an action with no editor. A `set-field` editor kind also covers `transition`.
 */
export const EDITOR_READY_ACTION_TYPES: ReadonlyArray<AutomationActionType> = [
  'transition',
  'set_field',
];
import {
  actionDraftProblem,
  canAddAction,
  emptyActionDraft,
  emptyRuleDraft,
  ruleDraftCompleteness,
  ruleDraftFromDto,
  ruleWritePayload,
  triggerDraftProblem,
  type ActionDraft,
  type TriggerDraft,
} from '@/lib/automation/automationRuleForm';
import type { AutomationRuleDto } from '@/lib/dto/automationRules';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';
import {
  FilterConditionBuilder,
  useFilterConditionModel,
  workingFromAst,
  type WorkingState,
} from '@/app/(authed)/items/_components/FilterConditionBuilder';
import { isAutoDisabled } from './AutomationRuleList';
import {
  AutoDisabledBanner,
  BlockWedge,
  memberOptions,
  priorityOptions,
  statusOptions,
} from './AutomationParts';

// The when/if/then rule editor (Story 6.6 · Subtask 6.6.5), per
// design/projects/automation.mock.html panels 1–4. THREE registry-driven
// blocks: When (the trigger picker + its per-kind config), If (the shared
// `FilterConditionBuilder` — the ONE predicate UI, reused not forked), Then (the
// ordered action list). The trigger/action pickers enumerate the 6.6.1
// registries and the per-kind config editor is chosen by each entry's
// `editorKind`, so a new registry entry surfaces with no editor change (only its
// i18n label). Save serialises through `automationRuleForm` → the 6.6.1 routes;
// caps disable the Add affordances and a validation gap pins a typed note on the
// offending row (never a detached toast).

const ANY = ''; // the "Any status" / "Unassigned" sentinel for nullable pickers

export interface AutomationRuleEditorProps {
  /** The rule being edited, or null for the Create flow. */
  rule: AutomationRuleDto | null;
  /** The display name for the rule actor line (current user on create). */
  ownerName: string;
  projectKey: string;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders — the condition block's Folder field (MOTIR-5378). */
  folders?: ProjectFoldersDto;
  referencedLabels: LabelDto[];
  onCancel: () => void;
  onSaved: (rule: AutomationRuleDto) => void;
  /** Re-enable the rule (auto-disabled banner action) — wired to the same
   * enable toggle the list uses (resets the failure counter). Undefined on the
   * create flow / a non-auto-disabled rule. */
  onReEnable?: () => void;
}

export function AutomationRuleEditor({
  rule,
  ownerName,
  projectKey,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
  onCancel,
  onSaved,
  onReEnable,
}: AutomationRuleEditorProps) {
  const t = useTranslations('settings.automation.editor');
  const tToast = useTranslations('settings.automation.toast');
  const tPriority = useTranslations('labels.priority');

  const initial = useMemo(() => (rule ? ruleDraftFromDto(rule) : emptyRuleDraft()), [rule]);

  const [name, setName] = useState(initial.name);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [trigger, setTrigger] = useState<TriggerDraft>(initial.trigger);
  const [condition, setCondition] = useState<WorkingState>(() =>
    workingFromAst(initial.conditionAst),
  );
  const [actions, setActions] = useState<ActionDraft[]>(initial.actions);
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // The auto-disabled banner shows when editing a rule the engine switched off
  // after the failure threshold; Re-enable clears it (and resets the counter
  // via the parent's enable toggle), so it hides immediately on click.
  const [reEnabled, setReEnabled] = useState(false);
  const showAutoDisabledBanner = rule != null && isAutoDisabled(rule) && !reEnabled;

  function handleReEnable() {
    setReEnabled(true);
    setEnabled(true);
    onReEnable?.();
  }

  const model = useFilterConditionModel({
    ast: initial.conditionAst,
    customFields,
    components,
    folders,
    referencedLabels,
  });

  const conditionAst = astFromRows(condition.combinator, condition.rows, model.resolveDef);
  const draft = { name, enabled, trigger, conditionAst, actions };
  const completeness = ruleDraftCompleteness(draft);

  const triggerOptions: ComboboxOption<string>[] = AUTOMATION_TRIGGER_TYPES.map((type) => ({
    value: type,
    label: t(`triggerType.${type}`),
  }));
  const actionTypeOptions: ComboboxOption<string>[] = AUTOMATION_ACTION_TYPES.filter((type) =>
    EDITOR_READY_ACTION_TYPES.includes(type),
  ).map((type) => ({
    value: type,
    label: t(`actionType.${type}`),
  }));
  const statusOpts = useMemo(() => statusOptions(statuses), [statuses]);
  const memberOpts = useMemo(() => memberOptions(members), [members]);
  const priorityOpts = useMemo(
    () => priorityOptions((p: WorkItemPriorityDto) => tPriority(p)),
    [tPriority],
  );

  function setActionAt(key: number, patch: (a: ActionDraft) => ActionDraft) {
    setActions((cur) => cur.map((a) => (a.key === key ? patch(a) : a)));
  }
  function moveAction(index: number, dir: -1 | 1) {
    setActions((cur) => {
      const next = [...cur];
      const target = index + dir;
      if (target < 0 || target >= next.length) return cur;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function handleSave() {
    setAttempted(true);
    setServerError(null);
    if (!completeness.ok) return;
    setSaving(true);
    try {
      const payload = ruleWritePayload(draft);
      const base = `/api/projects/${encodeURIComponent(projectKey)}/automation-rules`;
      const res = await fetch(rule ? `${base}/${encodeURIComponent(rule.id)}` : base, {
        method: rule ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        setServerError(
          data.code === 'AUTOMATION_RULE_LIMIT'
            ? tToast('capError', { max: 100 })
            : tToast('saveError'),
        );
        return;
      }
      const data = (await res.json()) as { rule: AutomationRuleDto };
      onSaved(data.rule);
    } catch {
      setServerError(tToast('saveError'));
    } finally {
      setSaving(false);
    }
  }

  const triggerEditorKind = safeTriggerEditorKind(trigger.type);
  const triggerProblem = attempted ? triggerDraftProblem(trigger) : null;
  const atActionCap = !canAddAction(draft);

  return (
    <Card>
      <div className="flex flex-col gap-5">
        {showAutoDisabledBanner ? (
          <AutoDisabledBanner
            name={rule.name}
            count={rule.consecutiveFailureCount}
            onReEnable={handleReEnable}
          />
        ) : null}

        {/* Header — name + enable toggle */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <Input
              aria-label={t('nameLabel')}
              placeholder={t('namePlaceholder')}
              value={name}
              maxLength={AUTOMATION_RULE_NAME_MAX_LENGTH + 1}
              error={
                attempted && !completeness.nameOk
                  ? t('nameRequired')
                  : attempted && completeness.nameTooLong
                    ? t('nameTooLong', { max: AUTOMATION_RULE_NAME_MAX_LENGTH })
                    : undefined
              }
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t('enabledAria')} />
        </div>

        {/* WHEN */}
        <Block
          tint="--el-tint-sky"
          glyph={<Zap className="size-3.5" aria-hidden />}
          label={t('when')}
          sub={t('whenSub')}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Combobox
              options={triggerOptions}
              value={trigger.type}
              onChange={(value) =>
                setTrigger((cur) => ({ ...cur, type: value as AutomationTriggerType }))
              }
              label={t('triggerAria')}
              className="w-[200px]"
            />
            {triggerEditorKind === 'none' ? (
              <span className="font-sans text-sm text-(--el-text-muted)">{t('noConfig')}</span>
            ) : null}
            {triggerEditorKind === 'transition' ? (
              <>
                <span className="font-sans text-sm text-(--el-text-secondary)">{t('from')}</span>
                <Combobox
                  options={[{ value: ANY, label: t('anyStatus') }, ...statusOpts]}
                  value={trigger.fromStatusId ?? ANY}
                  onChange={(value) =>
                    setTrigger((cur) => ({ ...cur, fromStatusId: value === ANY ? null : value }))
                  }
                  label={t('fromAria')}
                  className="w-[150px]"
                />
                <span className="font-sans text-sm text-(--el-text-secondary)">{t('to')}</span>
                <Combobox
                  options={[{ value: ANY, label: t('anyStatus') }, ...statusOpts]}
                  value={trigger.toStatusId ?? ANY}
                  onChange={(value) =>
                    setTrigger((cur) => ({ ...cur, toStatusId: value === ANY ? null : value }))
                  }
                  label={t('toAria')}
                  className="w-[150px]"
                />
              </>
            ) : null}
            {triggerEditorKind === 'field-changed' ? (
              <>
                <span className="font-sans text-sm text-(--el-text-secondary)">{t('field')}</span>
                <Combobox
                  options={AUTOMATION_FIELD_CHANGED_FIELDS.map((f) => ({
                    value: f,
                    label: t(`setField.${f}`),
                  }))}
                  value={trigger.field}
                  onChange={(value) =>
                    setTrigger((cur) => ({
                      ...cur,
                      field: value as AutomationFieldChangedFieldId,
                    }))
                  }
                  label={t('fieldAria')}
                  placeholder={t('setField.assignee')}
                  className="w-[170px]"
                />
              </>
            ) : null}
          </div>
          {triggerProblem ? <RowError>{t('problem.triggerNoField')}</RowError> : null}
        </Block>

        {/* IF */}
        <Block
          tint="--el-tint-lavender"
          glyph={<Filter className="size-3.5" aria-hidden />}
          label={t('if')}
          sub={t('ifSub')}
        >
          <FilterConditionBuilder
            working={condition}
            onChange={(next) => setCondition(next)}
            model={model}
            statuses={statuses}
            members={members}
            sprints={sprints}
            customFields={customFields}
            components={components}
            folders={folders}
            referencedLabels={referencedLabels}
            projectKey={projectKey}
          />
        </Block>

        {/* THEN */}
        <Block
          tint="--el-tint-mint"
          glyph={<Zap className="size-3.5" aria-hidden />}
          label={t('then')}
          sub={t('thenSub')}
        >
          <div className="flex flex-col gap-2">
            {actions.map((action, index) => (
              <ActionRow
                key={action.key}
                action={action}
                index={index}
                total={actions.length}
                statusOpts={statusOpts}
                memberOpts={memberOpts}
                priorityOpts={priorityOpts}
                actionTypeOptions={actionTypeOptions}
                problem={attempted ? actionDraftProblem(action) : null}
                onChange={(patch) => setActionAt(action.key, patch)}
                onRemove={() => setActions((cur) => cur.filter((a) => a.key !== action.key))}
                onMove={(dir) => moveAction(index, dir)}
              />
            ))}
            {attempted && !completeness.hasActions ? <RowError>{t('needAction')}</RowError> : null}
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <button
                type="button"
                disabled={atActionCap}
                onClick={() => setActions((cur) => [...cur, emptyActionDraft('transition')])}
                className={`inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
                  atActionCap
                    ? 'cursor-default text-(--el-text-faint)'
                    : 'text-(--el-link) hover:underline'
                }`}
              >
                <span aria-hidden>+</span>
                {t('addAction')}
              </button>
              {atActionCap ? (
                <span className="text-xs text-(--el-text-muted)">
                  {t('actionCapReached', { max: AUTOMATION_ACTIONS_PER_RULE_CAP })}
                </span>
              ) : null}
            </div>
          </div>
        </Block>

        {serverError ? <RowError>{serverError}</RowError> : null}

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-(--el-border) pt-4">
          <span className="font-sans text-xs text-(--el-text-muted)">
            {t('runsAs', {
              owner: ownerName,
              count: actions.length,
              max: AUTOMATION_ACTIONS_PER_RULE_CAP,
            })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button size="sm" loading={saving} onClick={() => void handleSave()}>
              {t('save')}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Resolve a trigger's editor kind defensively — a test-only / unknown registry
 * id renders as a no-config trigger (the "new entry, zero editor change" rule). */
function safeTriggerEditorKind(type: string): 'none' | 'transition' | 'field-changed' {
  try {
    return automationTriggerDef(type).editorKind;
  } catch {
    return 'none';
  }
}

function safeActionEditorKind(type: string): AutomationActionEditorKind | null {
  try {
    return automationActionDef(type).editorKind;
  } catch {
    return null;
  }
}

function Block({
  tint,
  glyph,
  label,
  sub,
  children,
}: {
  tint: string;
  glyph: React.ReactNode;
  label: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <BlockWedge tint={tint}>{glyph}</BlockWedge>
        <span className="font-sans text-sm font-semibold text-(--el-text)">{label}</span>
        <span className="font-sans text-xs text-(--el-text-muted)">{sub}</span>
      </div>
      <div className="pl-8">{children}</div>
    </div>
  );
}

function RowError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-1 flex items-center gap-1.5 font-sans text-xs text-(--el-danger-on-surface)"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-(--el-danger)" aria-hidden />
      {children}
    </p>
  );
}

function ActionRow({
  action,
  index,
  total,
  statusOpts,
  memberOpts,
  priorityOpts,
  actionTypeOptions,
  problem,
  onChange,
  onRemove,
  onMove,
}: {
  action: ActionDraft;
  index: number;
  total: number;
  statusOpts: ComboboxOption<string>[];
  memberOpts: ComboboxOption<string>[];
  priorityOpts: ComboboxOption<string>[];
  actionTypeOptions: ComboboxOption<string>[];
  problem: ReturnType<typeof actionDraftProblem>;
  onChange: (patch: (a: ActionDraft) => ActionDraft) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const t = useTranslations('settings.automation.editor');
  const editorKind = safeActionEditorKind(action.type);

  return (
    <div
      role="group"
      aria-label={t('actionAria', { n: index + 1 })}
      className="flex flex-col gap-1"
    >
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 flex-col">
          <button
            type="button"
            aria-label={t('moveUp')}
            disabled={index === 0}
            onClick={() => onMove(-1)}
            className="inline-flex size-4 items-center justify-center text-(--el-text-faint) hover:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-40"
          >
            <ChevronUp className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t('moveDown')}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
            className="inline-flex size-4 items-center justify-center text-(--el-text-faint) hover:text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
        </div>
        <Combobox
          options={actionTypeOptions}
          value={action.type}
          onChange={(value) =>
            onChange(() => ({
              ...emptyActionDraftPreservingKey(action, value as AutomationActionType),
            }))
          }
          label={t('actionTypeAria')}
          className="w-[160px]"
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {editorKind === 'transition' ? (
            <>
              <span className="font-sans text-sm text-(--el-text-secondary)">{t('to')}</span>
              <Combobox
                options={statusOpts}
                value={action.toStatusId}
                onChange={(value) => onChange((a) => ({ ...a, toStatusId: value }))}
                label={t('statusTargetAria')}
                className="w-[170px]"
              />
            </>
          ) : null}
          {editorKind === 'set-field' ? (
            <SetFieldConfig
              action={action}
              statusOpts={statusOpts}
              memberOpts={memberOpts}
              priorityOpts={priorityOpts}
              onChange={onChange}
            />
          ) : null}
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('removeAction', { n: index + 1 })}
          className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {problem ? <RowError>{t(`problem.${problemKey(problem)}`)}</RowError> : null}
    </div>
  );
}

function SetFieldConfig({
  action,
  statusOpts,
  memberOpts,
  priorityOpts,
  onChange,
}: {
  action: ActionDraft;
  statusOpts: ComboboxOption<string>[];
  memberOpts: ComboboxOption<string>[];
  priorityOpts: ComboboxOption<string>[];
  onChange: (patch: (a: ActionDraft) => ActionDraft) => void;
}) {
  const t = useTranslations('settings.automation.editor');
  void statusOpts;
  return (
    <>
      <Combobox
        options={AUTOMATION_SET_FIELDS.map((f) => ({ value: f, label: t(`setField.${f}`) }))}
        value={action.setField}
        onChange={(value) => onChange((a) => ({ ...a, setField: value as AutomationSetFieldId }))}
        label={t('setFieldAria')}
        className="w-[150px]"
      />
      <span className="font-sans text-sm text-(--el-text-secondary)">{t('to')}</span>
      {action.setField === 'assignee' ? (
        <Combobox
          options={[{ value: ANY, label: t('unassigned') }, ...memberOpts]}
          value={action.assignee ?? ANY}
          onChange={(value) => onChange((a) => ({ ...a, assignee: value === ANY ? null : value }))}
          label={t('assigneeAria')}
          className="w-[170px]"
        />
      ) : null}
      {action.setField === 'priority' ? (
        <Combobox
          options={priorityOpts}
          value={action.priority}
          onChange={(value) =>
            onChange((a) => ({ ...a, priority: value as ActionDraft['priority'] }))
          }
          label={t('priorityAria')}
          className="w-[150px]"
        />
      ) : null}
      {action.setField === 'dueDate' ? (
        <DatePicker
          aria-label={t('dueDateAria')}
          value={action.dueDate}
          onChange={(value) => onChange((a) => ({ ...a, dueDate: value }))}
        />
      ) : null}
      {action.setField === 'estimate' ? (
        <Input
          type="number"
          min={0}
          aria-label={t('estimateAria')}
          placeholder={t('estimatePlaceholder')}
          value={action.estimate ?? ''}
          onChange={(e) =>
            onChange((a) => ({
              ...a,
              estimate: e.target.value === '' ? null : Number(e.target.value),
            }))
          }
          className="w-[110px]"
        />
      ) : null}
    </>
  );
}

/** Map an action's type change to a fresh draft of that type, keeping its key. */
function emptyActionDraftPreservingKey(prev: ActionDraft, type: AutomationActionType): ActionDraft {
  const fresh = emptyActionDraft(type);
  return { ...fresh, key: prev.key };
}

function problemKey(problem: NonNullable<ReturnType<typeof actionDraftProblem>>): string {
  switch (problem) {
    case 'no-target-status':
      return 'noTargetStatus';
    case 'no-field':
      return 'noField';
    case 'no-value':
      return 'noValue';
  }
}
