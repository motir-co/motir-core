'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import {
  formatWhen,
  GroupCaptionRow,
  ModelRow,
  ModelText,
  Th,
  toOptions,
} from '@/components/ai/PlatformModelRow';
import { PLANNER_MODEL_FALLBACK } from '@/lib/ai/types';
import type {
  PlatformPlannerFunctionRowDTO,
  PlatformPlannerModelRowDTO,
  PlatformPlannerModelSettingsDTO,
  PlatformPlannerOfferedModelDTO,
  PlatformPlannerReviewModelRowDTO,
} from '@/lib/dto/platformPlannerModel';
import {
  setPlannerFunctionModelAction,
  setPlannerModelAction,
  setPlannerReviewModelAction,
} from '../actions';

/**
 * The PLANNING-MODEL table — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10 (AI planning) Panels 1, 2 and 4–8, card MOTIR-7231.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THIS ISLAND OWNS A DRAFT, NEVER A STORED MODEL
 * ---------------------------------------------------------------------------
 * Each row holds the model the operator has PICKED and not yet saved, and
 * nothing else. The stored model, its last-changed line and both chips are the
 * server-rendered `row` prop; the action calls `revalidatePath`, so they re-read
 * after a save (`CLAUDE.md`'s page-state contract, its simplest branch). A row
 * seeded from props with `useState(row.model)` could not be reached by that
 * refresh and would keep showing the old model — which is why the draft is
 * `null` whenever nothing is picked, and the trigger falls back to the prop.
 *
 * ⚠️ AND THE MISSING PICKER IS PRESENTATION. A `support` / `operator` reader
 * gets plain text (Panel 2); the action and the service both re-gate the write
 * at `superadmin`.
 */

export interface PlannerModelRowsProps {
  settings: PlatformPlannerModelSettingsDTO;
}

export function PlannerModelRows({ settings }: PlannerModelRowsProps) {
  const t = useTranslations('platformAdmin.aiPlanning');
  const options = toOptions(settings.offered);
  const cols = settings.canEdit ? 4 : 3;

  return (
    <>
      <Card
        data-testid="ai-planning-card"
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden
                className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
              >
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                  {t('card.title')}
                </h2>
                <p className="font-sans text-xs text-(--el-text-secondary)">{t('card.subtitle')}</p>
              </div>
            </div>
            <Pill tone="neutral">{t('card.count')}</Pill>
          </div>
        }
      >
        {/* The wide table scrolls INSIDE its own box; the page body never
            scrolls sideways. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse font-sans text-sm">
            <thead>
              <tr className="border-b border-(--el-border) text-left">
                <Th>{t('col.audience')}</Th>
                <Th>{t('col.model')}</Th>
                <Th>{t('col.lastChanged')}</Th>
                {settings.canEdit ? <Th>{t('col.action')}</Th> : null}
              </tr>
            </thead>
            <tbody>
              <GroupCaptionRow label={t('group.audiences')} colSpan={cols} />
              {settings.rows.map((row) => (
                <PlannerModelRow
                  key={row.audience}
                  row={row}
                  offered={settings.offered}
                  options={options}
                  canEdit={settings.canEdit}
                />
              ))}
              {settings.functions.length > 0 ? (
                <GroupCaptionRow label={t('group.functions')} colSpan={cols} />
              ) : null}
              {settings.functions.map((row) => (
                <PlannerFunctionModelRow
                  key={row.function}
                  row={row}
                  offered={settings.offered}
                  options={options}
                  canEdit={settings.canEdit}
                />
              ))}
              {settings.review ? (
                <GroupCaptionRow label={t('group.review')} colSpan={cols} />
              ) : null}
              {settings.review ? (
                <PlannerReviewModelRow
                  review={settings.review}
                  offered={settings.offered}
                  options={options}
                  canEdit={settings.canEdit}
                />
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
      {settings.canEdit ? null : (
        <p
          data-testid="ai-planning-read-only"
          className="font-sans text-xs text-(--el-text-secondary)"
        >
          {t('readOnly')}
        </p>
      )}
    </>
  );
}

interface PlannerModelRowProps {
  row: PlatformPlannerModelRowDTO;
  offered: PlatformPlannerOfferedModelDTO[];
  options: ComboboxOption<string>[];
  canEdit: boolean;
}

/** One AUDIENCE's row: its stored planning model, chips and per-row save. */
function PlannerModelRow({ row, offered, options, canEdit }: PlannerModelRowProps) {
  const t = useTranslations('platformAdmin.aiPlanning');
  const audienceName = t(`audience.${row.audience}.name`);
  const provider = offered.find((m) => m.id === row.model)?.provider ?? null;
  return (
    <ModelRow
      testId={`ai-planning-row-${row.audience}`}
      name={audienceName}
      desc={t(`audience.${row.audience}.desc`)}
      stored={row.model}
      labelOf={(value) => value}
      readOnly={<ModelText model={row.model} provider={provider} />}
      pickerAria={t('pickerAria', { audience: audienceName })}
      options={options}
      canEdit={canEdit}
      chips={<RowChips row={row} canEdit={canEdit} />}
      changed={row}
      confirmTitle={t('confirm.title', { audience: audienceName })}
      confirmBody={(from, to) => t('confirm.body', { from, to })}
      saved={(model) => ({
        title: t('saved.title'),
        description: t('saved.body', { audience: audienceName, model }),
      })}
      unchanged={(model) => t('error.unchanged', { model })}
      save={(model, reason) => setPlannerModelAction(row.audience, model, reason)}
    />
  );
}

/**
 * A planning-side FUNCTION's platform default (MOTIR-10844) — Guide, Debug or
 * Ask, drawn in the audience rows' grammar. Its picker leads with "Inherits — the
 * audience's planning model" (stored as null, the default) above the same
 * planning-list models; an unset row's last-changed line reads "Never set".
 */
function PlannerFunctionModelRow({
  row,
  offered,
  options,
  canEdit,
}: {
  row: PlatformPlannerFunctionRowDTO;
  offered: PlatformPlannerOfferedModelDTO[];
  options: ComboboxOption<string>[];
  canEdit: boolean;
}) {
  const t = useTranslations('platformAdmin.aiPlanning');
  const name = t(`functions.${row.function}.name`);
  const inherits = t('functions.inherits');
  const fnOptions: ComboboxOption<string>[] = [
    {
      value: INHERITS,
      label: inherits,
      description: t('functions.inheritsDesc'),
      group: t('review.defaultGroup'),
    },
    ...options,
  ];
  const labelOf = (value: string) => (value === INHERITS ? inherits : value);
  const provider = row.model ? (offered.find((m) => m.id === row.model)?.provider ?? null) : null;
  return (
    <ModelRow
      testId={`function-default-row-${row.function}`}
      name={name}
      desc={t(`functions.${row.function}.desc`)}
      stored={row.model ?? INHERITS}
      labelOf={labelOf}
      readOnly={
        row.model ? (
          <ModelText model={row.model} provider={provider} />
        ) : (
          <span className="text-xs text-(--el-text)">{inherits}</span>
        )
      }
      pickerAria={t('functions.pickerAria', { name })}
      options={fnOptions}
      canEdit={canEdit}
      chips={
        row.offered === false ? (
          <div className="flex flex-col items-start gap-1" data-testid="ai-planning-withdrawn">
            <Pill severity="warning">{t('withdrawn.chip')}</Pill>
            <p role="note" className="font-sans text-xs text-(--el-text-secondary)">
              {t(canEdit ? 'functions.withdrawnBody' : 'functions.withdrawnBodyReadOnly', {
                name,
              })}
            </p>
          </div>
        ) : null
      }
      changed={row}
      neverChanged={t('changed.neverSet')}
      confirmTitle={t('functions.confirmTitle', { name })}
      confirmBody={(from, to) => t(`functions.${row.function}.confirmBody`, { from, to })}
      saved={(label) => ({
        title: t('functions.savedTitle', { name }),
        description: t(`functions.${row.function}.savedBody`, { model: label }),
      })}
      unchanged={(label) => t('functions.unchanged', { name, model: label })}
      save={(value, reason) =>
        setPlannerFunctionModelAction(row.function, value === INHERITS ? null : value, reason)
      }
    />
  );
}

/** The picker value that stands for a function default stored as null. */
const INHERITS = '__inherits__';

/**
 * The dry-run REVIEW model's row (MOTIR-10632) — one platform-wide value beside
 * the audiences, drawn in their grammar. Its picker leads with "Same as the
 * planning model" (stored as null, the default) above the same offered models.
 */
function PlannerReviewModelRow({
  review,
  offered,
  options,
  canEdit,
}: {
  review: PlatformPlannerReviewModelRowDTO;
  offered: PlatformPlannerOfferedModelDTO[];
  options: ComboboxOption<string>[];
  canEdit: boolean;
}) {
  const t = useTranslations('platformAdmin.aiPlanning');
  const same = t('review.same');
  const reviewOptions: ComboboxOption<string>[] = [
    {
      value: SAME_AS_PLANNING,
      label: same,
      description: t('review.sameDesc'),
      group: t('review.defaultGroup'),
    },
    ...options,
  ];
  const labelOf = (value: string) => (value === SAME_AS_PLANNING ? same : value);
  const provider = review.model
    ? (offered.find((m) => m.id === review.model)?.provider ?? null)
    : null;
  return (
    <ModelRow
      testId="ai-planning-row-review"
      name={t('review.name')}
      desc={t('review.desc')}
      stored={review.model ?? SAME_AS_PLANNING}
      labelOf={labelOf}
      readOnly={
        review.model ? (
          <ModelText model={review.model} provider={provider} />
        ) : (
          <span className="text-xs text-(--el-text)">{same}</span>
        )
      }
      pickerAria={t('review.pickerAria')}
      options={reviewOptions}
      canEdit={canEdit}
      chips={
        review.offered === false ? (
          <div className="flex flex-col items-start gap-1" data-testid="ai-planning-withdrawn">
            <Pill severity="warning">{t('withdrawn.chip')}</Pill>
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t(canEdit ? 'review.withdrawnBody' : 'review.withdrawnBodyReadOnly')}
            </p>
          </div>
        ) : null
      }
      changed={review}
      confirmTitle={t('review.confirmTitle')}
      confirmBody={(from, to) => t('review.confirmBody', { from, to })}
      saved={(label) => ({
        title: t('review.savedTitle'),
        description: t('review.savedBody', { model: label }),
      })}
      unchanged={(label) => t('review.unchanged', { model: label })}
      save={(value, reason) =>
        setPlannerReviewModelAction(value === SAME_AS_PLANNING ? null : value, reason)
      }
    />
  );
}

/** The picker value that stands for a review model stored as null. */
const SAME_AS_PLANNING = '__same_as_planning__';

/** Panel 7 (withdrawn, warning) and Panel 8 right (failing, danger). */
function RowChips({ row, canEdit }: { row: PlatformPlannerModelRowDTO; canEdit: boolean }) {
  const t = useTranslations('platformAdmin.aiPlanning');
  const format = useFormatter();
  return (
    <>
      {row.offered ? null : (
        <div className="flex flex-col items-start gap-1" data-testid="ai-planning-withdrawn">
          <Pill severity="warning">{t('withdrawn.chip')}</Pill>
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t(canEdit ? 'withdrawn.body' : 'withdrawn.bodyReadOnly', {
              fallback: PLANNER_MODEL_FALLBACK,
            })}
          </p>
        </div>
      )}
      {row.reachable === false ? (
        <div className="flex flex-col items-start gap-1" data-testid="ai-planning-failing">
          <Pill severity="danger">{t('failing.chip')}</Pill>
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {row.lastProbeAt
              ? t('failing.body', { when: formatWhen(format, row.lastProbeAt) })
              : t('failing.bodyNoTime')}
            {row.lastProbeError ? ` ${row.lastProbeError}` : null}
          </p>
        </div>
      ) : null}
    </>
  );
}
