'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { PLANNER_MODEL_FALLBACK } from '@/lib/ai/types';
import type {
  PlatformPlannerModelRowDTO,
  PlatformPlannerModelSettingsDTO,
  PlatformPlannerOfferedModelDTO,
  PlatformPlannerReviewModelRowDTO,
} from '@/lib/dto/platformPlannerModel';
import {
  setPlannerModelAction,
  setPlannerReviewModelAction,
  type PlannerModelActionResult,
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
              {settings.rows.map((row) => (
                <PlannerModelRow
                  key={row.audience}
                  row={row}
                  offered={settings.offered}
                  options={options}
                  canEdit={settings.canEdit}
                />
              ))}
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

/** Offered models, grouped by provider and ordered by id within a group. */
function toOptions(offered: PlatformPlannerOfferedModelDTO[]): ComboboxOption<string>[] {
  return [...offered]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
    .map((m) => ({ value: m.id, label: m.id, secondary: m.provider, group: m.provider }));
}

type RowError =
  | { kind: 'refused'; model: string }
  | { kind: 'unreachable'; model: string; reason: string }
  | { kind: 'other'; message: string };

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

function ModelText({ model, provider }: { model: string; provider: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-xs text-(--el-text)">{model}</span>
      {provider ? <span className="text-xs text-(--el-text-identifier)">{provider}</span> : null}
    </div>
  );
}

interface ModelRowProps {
  testId: string;
  name: string;
  desc: string;
  /** The stored value, as a picker option value. */
  stored: string;
  /** A picker value as the confirm, toast and errors name it. */
  labelOf: (value: string) => string;
  /** What a reader without the picker sees in the Model cell. */
  readOnly: React.ReactNode;
  pickerAria: string;
  options: ComboboxOption<string>[];
  canEdit: boolean;
  chips: React.ReactNode;
  changed: { seeded: boolean; updatedAt: string | null; updatedBy: string | null };
  confirmTitle: string;
  confirmBody: (from: string, to: string) => string;
  saved: (label: string) => { title: string; description: string };
  unchanged: (label: string) => string;
  save: (value: string, reason: string) => Promise<PlannerModelActionResult>;
}

/**
 * One row of the table — the picker, chips, last-changed line, Save and the
 * confirm-with-reason — shared by the audience rows and the review row.
 */
function ModelRow(props: ModelRowProps) {
  const { stored, labelOf, canEdit } = props;
  const t = useTranslations('platformAdmin.aiPlanning');
  const format = useFormatter();
  const router = useRouter();
  const { toast } = useToast();
  const reasonFieldId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<RowError | null>(null);
  // The value this tab last saved on this row. "Changed just now by you" holds
  // only while the server still reports that same value.
  const [savedHere, setSavedHere] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selected = draft ?? stored;
  const dirty = selected !== stored;

  function closeConfirm() {
    setConfirming(false);
    setReason('');
  }

  function report(result: PlannerModelActionResult, value: string) {
    closeConfirm();
    const model = labelOf(value);
    if (result.ok) {
      setDraft(null);
      setError(null);
      setSavedHere(value);
      toast({ variant: 'success', ...props.saved(model) });
      return;
    }
    switch (result.code) {
      case 'NOT_OFFERED':
        // Panel 6: keep the stored value and re-read the offered list.
        setDraft(null);
        setError({ kind: 'refused', model });
        router.refresh();
        return;
      case 'UNREACHABLE':
        // Panel 8 (left): nothing was written; the row keeps its stored model.
        setDraft(null);
        setError({ kind: 'unreachable', model, reason: result.reason });
        return;
      case 'UNCHANGED':
        setDraft(null);
        setError({ kind: 'other', message: props.unchanged(model) });
        return;
      case 'NOT_PERMITTED':
        setError({ kind: 'other', message: t('error.notPermitted') });
        return;
      case 'REASON_REQUIRED':
        setError({ kind: 'other', message: t('error.reasonRequired') });
        return;
      case 'UNAVAILABLE':
      case 'FAILED':
        setError({ kind: 'other', message: t('error.failed') });
        return;
    }
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed || !dirty) return;
    const value = selected;
    startTransition(async () => {
      report(await props.save(value, trimmed), value);
    });
  }

  const { changed } = props;
  const changedLine =
    savedHere === stored
      ? t('changed.justNowByYou')
      : changed.seeded || !changed.updatedAt
        ? t('changed.seeded')
        : changed.updatedBy
          ? t('changed.by', { when: formatWhen(format, changed.updatedAt), who: changed.updatedBy })
          : t('changed.byUnknown', { when: formatWhen(format, changed.updatedAt) });

  return (
    <tr data-testid={props.testId} className="border-b border-(--el-border-soft) last:border-b-0">
      <Td>
        <div className="flex flex-col gap-0.5">
          <span className="text-(--el-text)">{props.name}</span>
          <span className="text-xs text-(--el-text-secondary)">{props.desc}</span>
        </div>
      </Td>
      <Td className="w-[22rem]">
        <div className="flex flex-col gap-1.5">
          {canEdit ? (
            <Combobox
              label={props.pickerAria}
              options={props.options}
              // A withdrawn stored model is not among the options; the trigger
              // still names it, because that is what is stored (Panel 7).
              value={selected}
              placeholder={labelOf(stored)}
              onChange={(value) => {
                setError(null);
                setDraft(value === stored ? null : value);
              }}
              footer={
                <p className="font-sans text-xs text-(--el-text-secondary)">{t('pickerFoot')}</p>
              }
            />
          ) : (
            props.readOnly
          )}
          {props.chips}
          {error ? (
            <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
              {errorText(t, error)}
            </p>
          ) : null}
        </div>
      </Td>
      <Td className="text-xs text-(--el-text-secondary)">{changedLine}</Td>
      {canEdit ? (
        <Td>
          <Button
            size="sm"
            variant={dirty ? 'primary' : 'secondary'}
            disabled={!dirty || isPending}
            onClick={() => setConfirming(true)}
          >
            {t('save')}
          </Button>
          <Modal
            open={confirming}
            onOpenChange={(next) => (next ? undefined : closeConfirm())}
            role="alertdialog"
            title={props.confirmTitle}
            description={props.confirmBody(labelOf(stored), labelOf(selected))}
            size="md"
          >
            <Modal.Body className="gap-4">
              <Input
                id={reasonFieldId}
                label={t('confirm.reasonLabel')}
                placeholder={t('confirm.reasonPlaceholder')}
                helperText={t('confirm.reasonHint')}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                autoFocus
                maxLength={280}
              />
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" onClick={closeConfirm} disabled={isPending}>
                {t('confirm.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={submit}
                loading={isPending}
                // A courtesy: the audit vocabulary's reason policy is the rule,
                // asserted in the service.
                disabled={reason.trim().length === 0}
              >
                {t('confirm.confirm')}
              </Button>
            </Modal.Footer>
          </Modal>
        </Td>
      ) : null}
    </tr>
  );
}

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

type Translator = ReturnType<typeof useTranslations<'platformAdmin.aiPlanning'>>;

function errorText(t: Translator, error: RowError): string {
  if (error.kind === 'refused') return t('refused', { model: error.model });
  if (error.kind === 'unreachable') {
    return t('unreachable.save', { model: error.model, reason: localizeReason(t, error.reason) });
  }
  return error.message;
}

/**
 * motir-ai's probe reasons are English sentences built in one place
 * (`plannerModelProbe`); the three it can produce are localized, and anything
 * else is shown as it came rather than dropped.
 */
function localizeReason(t: Translator, reason: string): string {
  if (reason.startsWith('the provider key was refused')) return t('unreachable.reason.keyRefused');
  if (reason.startsWith('no enabled channel serves')) return t('unreachable.reason.noChannel');
  if (reason.startsWith('the gateway did not answer')) return t('unreachable.reason.timeout');
  return reason;
}

function formatWhen(format: ReturnType<typeof useFormatter>, iso: string): string {
  return format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
