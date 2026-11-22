'use client';

import { useTranslations } from 'next-intl';
import { Bot, CheckCircle2, CircleAlert, MinusCircle, Plus, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { Switch } from '@/components/ui/Switch';
import { AUTOMATION_RULES_PER_PROJECT_CAP } from '@/lib/automation/constants';
import type { AutomationRuleDto, AutomationRuleSummaryDto } from '@/lib/dto/automationRules';
import { AutoDisabledBanner, MemberAvatar } from './AutomationParts';
import { AutomationRuleActionsMenu } from './AutomationRuleActionsMenu';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The rule list (Story 6.6 · Subtask 6.6.5), per
// design/projects/automation.mock.html panels 0 + 6: one row per rule (Switch ·
// name · owner avatar · last-run · trigger Pill · overflow), the empty state,
// the 100-rule cap (disabled Create + foot note), and the auto-disabled banner
// (derived from the 6.6.1 DTO: a rule the engine switched off after the failure
// threshold). The POPULATED last-run glyph + the audit log are the 6.6.6 surface
// (this subtask doesn't depend on the 6.6.2 execution data), so a live rule
// reads "Never run" here until 6.6.6 wires the run history.

/** A rule the engine auto-disabled: off AND at/over the consecutive-failure
 * threshold (the 6.6.1 DTO exposes both, so the list derives it without the
 * execution log). A manually-disabled rule (off, count below threshold) is just
 * off — no banner. */
export function isAutoDisabled(rule: AutomationRuleDto): boolean {
  return !rule.enabled && rule.consecutiveFailureCount >= rule.autoDisableThreshold;
}

export function AutomationRuleList({
  rules,
  onCreate,
  onEdit,
  onViewLog,
  onToggleEnabled,
  onDelete,
}: {
  rules: AutomationRuleSummaryDto[];
  onCreate: () => void;
  onEdit: (rule: AutomationRuleSummaryDto) => void;
  onViewLog: (rule: AutomationRuleSummaryDto) => void;
  onToggleEnabled: (rule: AutomationRuleSummaryDto) => void;
  onDelete: (rule: AutomationRuleSummaryDto) => void;
}) {
  const t = useTranslations('settings.automation');
  const atCap = rules.length >= AUTOMATION_RULES_PER_PROJECT_CAP;
  const autoDisabled = rules.filter(isAutoDisabled);

  if (rules.length === 0) {
    return (
      <EmptyState
        title={t('empty.title')}
        description={t('empty.description')}
        icon={<Bot className="h-12 w-12" aria-hidden />}
        action={
          <Button leftIcon={<Plus className="size-4" aria-hidden />} onClick={onCreate}>
            {t('createRule')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {autoDisabled.map((rule) => (
        <AutoDisabledBanner
          key={`banner-${rule.id}`}
          name={rule.name}
          count={rule.consecutiveFailureCount}
        />
      ))}

      <Card
        header={
          <div className="flex items-center justify-between gap-4">
            <Pill
              tone="neutral"
              aria-label={t('ruleCount', { count: rules.length, total: rules.length })}
            >
              {t('ruleCount', { count: rules.length, total: rules.length })}
            </Pill>
            {atCap ? (
              <Button size="sm" disabled leftIcon={<Plus className="size-4" aria-hidden />}>
                {t('createRule')}
              </Button>
            ) : (
              <Button
                size="sm"
                leftIcon={<Plus className="size-4" aria-hidden />}
                onClick={onCreate}
              >
                {t('createRule')}
              </Button>
            )}
          </div>
        }
        footer={
          <div className="flex items-center justify-between gap-2 text-xs text-(--el-text-muted)">
            <span>{t('ruleCount', { count: rules.length, total: rules.length })}</span>
            <span>{t('perProjectCap', { max: AUTOMATION_RULES_PER_PROJECT_CAP })}</span>
          </div>
        }
      >
        {atCap ? (
          <div className="mb-3 flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface) px-(--spacing-control-x) py-(--spacing-control-y)">
            <CircleAlert className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('capReached', { max: AUTOMATION_RULES_PER_PROJECT_CAP })}
            </p>
          </div>
        ) : null}

        <ul role="list" className="flex flex-col">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onEdit={() => onEdit(rule)}
              onViewLog={() => onViewLog(rule)}
              onToggleEnabled={() => onToggleEnabled(rule)}
              onDelete={() => onDelete(rule)}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function RuleRow({
  rule,
  onEdit,
  onViewLog,
  onToggleEnabled,
  onDelete,
}: {
  rule: AutomationRuleSummaryDto;
  onEdit: () => void;
  onViewLog: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('settings.automation');
  const auto = isAutoDisabled(rule);

  return (
    <li
      data-testid={`rule-row-${rule.id}`}
      className={`flex items-center gap-3 border-b border-(--el-border-soft) py-3 last:border-b-0 ${
        rule.enabled ? '' : 'opacity-70'
      }`}
    >
      <Switch
        checked={rule.enabled}
        onCheckedChange={onToggleEnabled}
        aria-label={t('row.enabledAria', { name: rule.name })}
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-sans text-sm font-medium text-(--el-text)">
          {rule.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 font-sans text-xs text-(--el-text-muted)">
          <MemberAvatar name={rule.owner.name} className="size-4 text-[8px]" />
          <span className="truncate">{rule.owner.name}</span>
          <span aria-hidden>·</span>
          <LastRun rule={rule} auto={auto} />
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Pill tone="neutral">{t(`triggerSummary.${rule.trigger.type}`)}</Pill>
        {auto ? (
          <Button variant="ghost" size="sm" onClick={onToggleEnabled}>
            {t('row.reEnable')}
          </Button>
        ) : null}
        <AutomationRuleActionsMenu
          ruleName={rule.name}
          enabled={rule.enabled}
          onEdit={onEdit}
          onViewLog={onViewLog}
          onToggleEnabled={onToggleEnabled}
          onDelete={onDelete}
        />
      </div>
    </li>
  );
}

/** The last-run glyph + copy (Subtask 6.6.6), fed by `rule.lastRun`. An
 * auto-disabled rule overrides everything (the engine switched it off after the
 * failure threshold). Otherwise: Success → mint check + "Ran {time} ago",
 * Failure → rose alert + "Failed · {time} ago", No actions → faint minus +
 * "No actions · {time} ago", Held by a plan → the same faint minus + "Held by a
 * plan · {time}", Paused (org closing) → the same minus + "Paused · {time}"
 * (MOTIR-6396), never-fired → faint "Never run". */
function LastRun({ rule, auto }: { rule: AutomationRuleSummaryDto; auto: boolean }) {
  const t = useTranslations('settings.automation');
  const relativeTime = useRelativeTime();

  if (auto) {
    return (
      <span className="flex items-center gap-1 text-(--el-danger)">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {t('row.autoDisabled', { count: rule.consecutiveFailureCount })}
      </span>
    );
  }

  const lastRun = rule.lastRun;
  if (!lastRun) {
    return <span className="text-(--el-text-muted)">{t('row.neverRun')}</span>;
  }

  const time = relativeTime(new Date(lastRun.at));
  if (lastRun.status === 'success') {
    return (
      <span className="flex items-center gap-1 text-(--el-text-muted)">
        <CheckCircle2 className="size-3.5 shrink-0 text-(--el-success)" aria-hidden />
        {t('row.ranAgo', { time })}
      </span>
    );
  }
  if (lastRun.status === 'failure') {
    return (
      <span className="flex items-center gap-1 text-(--el-danger)">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {t('row.failedAgo', { time })}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-(--el-text-muted)">
      <MinusCircle className="size-3.5 shrink-0" aria-hidden />
      {lastRun.status === 'plan_held'
        ? t('row.planHeldAgo', { time })
        : lastRun.status === 'org_closing'
          ? t('row.orgClosingAgo', { time })
          : lastRun.status === 'held_by_mark'
            ? t('row.heldByMarkAgo', { time })
            : t('row.noActionsAgo', { time })}
    </span>
  );
}
