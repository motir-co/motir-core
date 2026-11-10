'use client';

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';

/**
 * ONE PLATFORM MODEL-SETTING ROW of the operator console — the picker, chips,
 * last-changed line, Save and the confirm-with-reason — shared by the AI planning
 * table (audience, dry-run review and Guide / Debug / Ask rows) and the Hosted-run
 * models page's Run-side defaults card (MOTIR-10844). Lifted out of
 * `PlannerModelRows` unchanged so both pages draw the same states; the shared
 * copy stays in `platformAdmin.aiPlanning`, and a row passes its own wording for
 * what differs (the picker foot, the refusal, the never-changed line).
 *
 * ⚠️ THE ROW OWNS A DRAFT, NEVER A STORED MODEL. It holds the value the operator
 * picked and has not saved, and nothing else. The stored value, its chips and
 * its last-changed line are server-rendered props re-read after a save (the
 * action `revalidatePath`s), so the draft is `null` whenever nothing is picked
 * and the trigger falls back to the prop.
 *
 * ⚠️ THE MISSING PICKER IS PRESENTATION. A reader below `superadmin` gets plain
 * text; the action and the service both re-gate the write.
 */

/** Every console model write answers one of these (the actions' result shape). */
export type PlatformModelActionResult =
  | { ok: true }
  | { ok: false; code: 'NOT_OFFERED' }
  | { ok: false; code: 'UNREACHABLE'; reason: string }
  | {
      ok: false;
      code: 'UNCHANGED' | 'UNAVAILABLE' | 'REASON_REQUIRED' | 'NOT_PERMITTED' | 'FAILED';
    };

/** A model a picker may offer. */
export interface PlatformModelOption {
  id: string;
  provider: string;
}

/** Offered models, grouped by provider and ordered by id within a group. */
export function toOptions(offered: readonly PlatformModelOption[]): ComboboxOption<string>[] {
  return [...offered]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
    .map((m) => ({ value: m.id, label: m.id, secondary: m.provider, group: m.provider }));
}

type RowError =
  | { kind: 'refused'; model: string }
  | { kind: 'unreachable'; model: string; reason: string }
  | { kind: 'other'; message: string };

export function ModelText({ model, provider }: { model: string; provider: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-xs text-(--el-text)">{model}</span>
      {provider ? <span className="text-xs text-(--el-text-identifier)">{provider}</span> : null}
    </div>
  );
}

export interface ModelRowProps {
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
  /** The last-changed line for a row nobody has changed; the seeded default's by default. */
  neverChanged?: string;
  /** The picker's foot; the planning list's by default. */
  pickerFoot?: string;
  /** The refused-save line; "no longer offered for planning" by default. */
  refused?: (label: string) => string;
  confirmTitle: string;
  confirmBody: (from: string, to: string) => string;
  saved: (label: string) => { title: string; description: string };
  unchanged: (label: string) => string;
  save: (value: string, reason: string) => Promise<PlatformModelActionResult>;
}

export function ModelRow(props: ModelRowProps) {
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

  function report(result: PlatformModelActionResult, value: string) {
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
        // Keep the stored value and re-read the offered list.
        setDraft(null);
        setError({ kind: 'refused', model });
        router.refresh();
        return;
      case 'UNREACHABLE':
        // Nothing was written; the row keeps its stored model.
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
        ? (props.neverChanged ?? t('changed.seeded'))
        : changed.updatedBy
          ? t('changed.by', { when: formatWhen(format, changed.updatedAt), who: changed.updatedBy })
          : t('changed.byUnknown', { when: formatWhen(format, changed.updatedAt) });

  function errorText(e: RowError): string {
    if (e.kind === 'refused') return props.refused?.(e.model) ?? t('refused', { model: e.model });
    if (e.kind === 'unreachable') {
      return t('unreachable.save', { model: e.model, reason: localizeReason(t, e.reason) });
    }
    return e.message;
  }

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
              // still names it, because that is what is stored.
              value={selected}
              placeholder={labelOf(stored)}
              onChange={(value) => {
                setError(null);
                setDraft(value === stored ? null : value);
              }}
              footer={
                <p className="font-sans text-xs text-(--el-text-secondary)">
                  {props.pickerFoot ?? t('pickerFoot')}
                </p>
              }
            />
          ) : (
            props.readOnly
          )}
          {props.chips}
          {error ? (
            <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
              {errorText(error)}
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

/**
 * A full-width group caption inside a model table (MOTIR-10844's "Planning · by
 * audience" eyebrows): mono, `--el-text-eyebrow`.
 */
export function GroupCaptionRow({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr className="border-b border-(--el-border-soft)">
      <td
        colSpan={colSpan}
        className="pb-1 pt-4 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-(--el-text-eyebrow)"
      >
        {label}
      </td>
    </tr>
  );
}

type Translator = ReturnType<typeof useTranslations<'platformAdmin.aiPlanning'>>;

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

export function formatWhen(format: ReturnType<typeof useFormatter>, iso: string): string {
  return format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

export function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
