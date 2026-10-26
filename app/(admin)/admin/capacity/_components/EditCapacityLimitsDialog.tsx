'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import type { CapacityLimitsActionResult } from '@/app/(admin)/admin/capacity/actions';
import type { CapacityLimitUnit } from '@/lib/capacity/alertKeys';
import type {
  PlatformCapacityEditInput,
  PlatformCapacityEntryDTO,
} from '@/lib/dto/platformCapacity';
import { UNIT_EDIT_KEY } from './capacityDisplay';
import { NotEnforcedFold } from './NotEnforcedFold';

/**
 * The EDIT DIALOG (MOTIR-9614, design `platform-admin` AMENDMENT 2026-10-25,
 * Panels 12–14): one model's limits, planning share and tier note.
 *
 * ⚠️ ONLY WHAT CHANGED IS SENT. The doors pass on exactly the keys they are
 * given, so an untouched field must be absent from the edit — a tier note sent
 * unchanged would still be a write. Save is disabled until something changed,
 * which is why `capacity_empty_edit` has no string (design § Copy). A ticked
 * Unknown sends `null`, which the gateway stores as "not known", never 0.
 *
 * A refusal keeps every typed value. One the server names a `field` for lands
 * under that field; any other, or a field this form does not draw, is one
 * dialog-level line.
 */

const TIER_NOTE_MAX = 1000;

type Field = CapacityLimitUnit | 'planning_share_percent' | 'tier_note';
type Refusal = Extract<CapacityLimitsActionResult, { ok: false }>;
type DialogKey =
  | 'invalidBody'
  | 'unknownModel'
  | 'unknownProvider'
  | 'storeError'
  | 'auth'
  | 'unreachable'
  | 'notPermitted'
  | 'failed';

const DIALOG_KEY: Record<Refusal['code'], DialogKey> = {
  INVALID_VALUE: 'invalidBody',
  INVALID_BODY: 'invalidBody',
  EMPTY_EDIT: 'invalidBody',
  UNKNOWN_PROVIDER: 'unknownProvider',
  UNKNOWN_MODEL: 'unknownModel',
  STORE_ERROR: 'storeError',
  CREDENTIAL: 'auth',
  UNAVAILABLE: 'unreachable',
  NOT_PERMITTED: 'notPermitted',
  FAILED: 'failed',
};

interface LimitDraft {
  text: string;
  unknown: boolean;
}

type Problem = { field: Field } | { dialog: DialogKey };

const WHOLE = /^\d+$/;

function initialLimits(
  entry: PlatformCapacityEntryDTO,
): Partial<Record<CapacityLimitUnit, LimitDraft>> {
  const drafts: Partial<Record<CapacityLimitUnit, LimitDraft>> = {};
  for (const row of entry.limits) {
    if (row.limit.status === 'set')
      drafts[row.unit] = { text: String(row.limit.value), unknown: false };
    if (row.limit.status === 'unknown') drafts[row.unit] = { text: '', unknown: true };
  }
  return drafts;
}

/** The changed keys, or the first field this form already knows is wrong. */
function buildEdit(
  entry: PlatformCapacityEntryDTO,
  limits: Partial<Record<CapacityLimitUnit, LimitDraft>>,
  share: string,
  tierNote: string,
): { edit: PlatformCapacityEditInput } | { field: Field } {
  const edit: PlatformCapacityEditInput = {};
  for (const row of entry.limits) {
    const draft = limits[row.unit];
    if (!draft) continue;
    const before = row.limit.status === 'set' ? String(row.limit.value) : null;
    if (draft.unknown) {
      if (before !== null) edit[UNIT_EDIT_KEY[row.unit]] = null;
      continue;
    }
    if (draft.text.trim() === before) continue;
    const value = Number(draft.text.trim());
    if (!WHOLE.test(draft.text.trim()) || !Number.isSafeInteger(value)) return { field: row.unit };
    edit[UNIT_EDIT_KEY[row.unit]] = value;
  }
  if (share.trim() !== String(entry.planningSharePercent)) {
    const value = Number(share.trim());
    if (!WHOLE.test(share.trim()) || value > 100) return { field: 'planning_share_percent' };
    edit.planningSharePercent = value;
  }
  if (tierNote !== entry.tierNote) {
    if (tierNote.length > TIER_NOTE_MAX) return { field: 'tier_note' };
    edit.tierNote = tierNote;
  }
  return { edit };
}

function problemOf(result: Refusal, fields: readonly Field[]): Problem {
  if ((result.code === 'INVALID_VALUE' || result.code === 'INVALID_BODY') && 'field' in result) {
    const field = result.field as Field | undefined;
    if (field && fields.includes(field)) return { field };
  }
  return { dialog: DIALOG_KEY[result.code] };
}

export function EditCapacityLimitsDialog({
  entry,
  onClose,
  editLimits,
  onSaved,
}: {
  entry: PlatformCapacityEntryDTO;
  onClose: () => void;
  editLimits: (
    provider: string,
    model: string,
    edit: PlatformCapacityEditInput,
  ) => Promise<CapacityLimitsActionResult>;
  onSaved: (model: string) => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const [limits, setLimits] = useState(() => initialLimits(entry));
  const [share, setShare] = useState(String(entry.planningSharePercent));
  const [tierNote, setTierNote] = useState(entry.tierNote);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const enforced = entry.limits.filter((row) => row.limit.status !== 'not_applicable');
  const notEnforced = entry.limits
    .filter((row) => row.limit.status === 'not_applicable')
    .map((row) => row.unit);
  const fields: Field[] = [
    ...enforced.map((row) => row.unit),
    'planning_share_percent',
    'tier_note',
  ];
  const built = buildEdit(entry, limits, share, tierNote);
  const unchanged = 'edit' in built && Object.keys(built.edit).length === 0;

  // Focus returns to the refused field (design § A11y).
  useEffect(() => {
    if (problem && 'field' in problem) {
      form.current?.querySelector<HTMLElement>(`[data-field="${problem.field}"]`)?.focus();
    }
  }, [problem]);

  async function submit() {
    if ('field' in built) {
      setProblem({ field: built.field });
      return;
    }
    setSaving(true);
    setProblem(null);
    const result = await editLimits(entry.provider, entry.model, built.edit);
    setSaving(false);
    if (result.ok) {
      onSaved(entry.model);
      onClose();
    } else {
      setProblem(problemOf(result, fields));
    }
  }

  const fieldError = (field: Field): string | undefined => {
    if (!problem || !('field' in problem) || problem.field !== field) return undefined;
    if (field === 'planning_share_percent') return t('editError.planningShare');
    if (field === 'tier_note') return t('editError.tierNote');
    const text = limits[field]?.text.trim() ?? '';
    const tooLarge = WHOLE.test(text) && !Number.isSafeInteger(Number(text));
    return t(tooLarge ? 'editError.tooLarge' : 'editError.wholeNumber', {
      limit: t(`unit.${field}`),
    });
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      title={t('edit.title', { model: entry.model })}
      description={t('edit.intro')}
    >
      <form
        ref={form}
        noValidate
        className="mt-4 flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Body className="gap-3">
          <div className="grid grid-cols-1 gap-x-3.5 gap-y-3 sm:grid-cols-2">
            {enforced.map((row) => (
              <LimitField
                key={row.unit}
                unit={row.unit}
                draft={limits[row.unit]!}
                error={fieldError(row.unit)}
                disabled={saving}
                onChange={(draft) => setLimits({ ...limits, [row.unit]: draft })}
              />
            ))}
          </div>
          <NotEnforcedFold units={notEnforced} />
          <Input
            label={t('edit.planningShare')}
            inputMode="numeric"
            data-field="planning_share_percent"
            value={share}
            error={fieldError('planning_share_percent')}
            disabled={saving}
            onChange={(e) => setShare(e.target.value)}
          />
          <Textarea
            label={t('edit.tierNote')}
            data-field="tier_note"
            rows={3}
            value={tierNote}
            error={fieldError('tier_note')}
            helperText={t('edit.count', { count: tierNote.length })}
            disabled={saving}
            onChange={(e) => setTierNote(e.target.value)}
          />
          {problem && 'dialog' in problem && (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-xs text-(--el-danger-on-surface)"
              data-testid="capacity-edit-error"
            >
              <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{t(`editError.${problem.dialog}`)}</span>
            </p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="secondary" disabled={saving} onClick={onClose}>
            {t('edit.cancel')}
          </Button>
          <Button type="submit" loading={saving} disabled={unchanged}>
            {saving ? t('edit.saving') : t('edit.save')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function LimitField({
  unit,
  draft,
  error,
  disabled,
  onChange,
}: {
  unit: CapacityLimitUnit;
  draft: LimitDraft;
  error: string | undefined;
  disabled: boolean;
  onChange: (draft: LimitDraft) => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  return (
    <div data-testid={`capacity-edit-${unit}`}>
      <Input
        label={t(`unit.${unit}`)}
        inputMode="numeric"
        data-field={unit}
        value={draft.unknown ? '' : draft.text}
        placeholder={draft.unknown ? t('edit.unknown') : undefined}
        error={error}
        disabled={disabled || draft.unknown}
        onChange={(e) => onChange({ ...draft, text: e.target.value })}
      />
      {/* Outside the Input: its affix slot is aria-hidden decoration. */}
      <label className="mt-1.5 inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-(--el-text-secondary)">
        <input
          type="checkbox"
          className="accent-(--el-accent)"
          checked={draft.unknown}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, unknown: e.target.checked })}
        />
        {t('edit.unknown')}
      </label>
    </div>
  );
}
