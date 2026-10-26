'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleCheck, Gauge, Pencil, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import type { CapacityAlertShareActionResult } from '@/app/(admin)/admin/capacity/actions';
import type { PlatformCapacityAlertShareDTO } from '@/lib/dto/platformCapacity';

/**
 * The ALERT-SHARE CARD (MOTIR-9614, design `platform-admin` AMENDMENT
 * 2026-10-25, Panel 15): the one share every limit of every model is judged
 * against. An editor gets an inline edit (15b–15f); a `support` viewer gets the
 * value only, with no edit control in the DOM (Panel 16).
 *
 * The card shows the share the server answered, never the typed one, once a
 * save lands; a refusal keeps the typed value in the box.
 */

type Refusal = Extract<CapacityAlertShareActionResult, { ok: false }>['code'];

const REFUSAL_KEY: Record<Refusal, 'range' | 'unchanged' | 'notPermitted' | 'failed'> = {
  INVALID_VALUE: 'range',
  UNCHANGED: 'unchanged',
  NOT_PERMITTED: 'notPermitted',
  FAILED: 'failed',
};

type Phase =
  | { kind: 'idle'; saved: number | null }
  | { kind: 'editing'; draft: string; refusal: Refusal | null; saving: boolean };

export function AlertShareCard({
  alertShare,
  canEdit,
  setAlertShare,
  onSaved,
}: {
  alertShare: PlatformCapacityAlertShareDTO;
  canEdit: boolean;
  setAlertShare: (percent: number) => Promise<CapacityAlertShareActionResult>;
  /** The screen's re-read: the client island does not see `revalidatePath`. */
  onSaved: () => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', saved: null });
  const [shown, setShown] = useState(alertShare);
  // A poll that lands after a save carries the stored share: follow it.
  const [seen, setSeen] = useState(alertShare);
  if (seen !== alertShare) {
    setSeen(alertShare);
    setShown(alertShare);
  }

  async function save(draft: string) {
    const percent = Number(draft.trim());
    if (!/^\d+$/.test(draft.trim()) || percent < 1 || percent > 100) {
      setPhase({ kind: 'editing', draft, refusal: 'INVALID_VALUE', saving: false });
      return;
    }
    setPhase({ kind: 'editing', draft, refusal: null, saving: true });
    const result = await setAlertShare(percent);
    if (result.ok) {
      setShown(result.alertShare);
      setPhase({ kind: 'idle', saved: result.alertShare.percent });
      onSaved();
    } else {
      setPhase({ kind: 'editing', draft, refusal: result.code, saving: false });
    }
  }

  return (
    <Card header={<AlertShareHeader />} data-testid="capacity-alert-share">
      {phase.kind === 'editing' ? (
        <AlertShareEditor
          phase={phase}
          onDraft={(draft) => setPhase({ ...phase, draft })}
          onSave={() => void save(phase.draft)}
          onCancel={() => setPhase({ kind: 'idle', saved: null })}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2.5 text-sm text-(--el-text)">
          <span>{t('alertShare.label')}</span>
          <span className="font-semibold tabular-nums" data-testid="capacity-alert-share-value">
            {t('percent', { value: shown.percent })}
          </span>
          {shown.isDefault && (
            <span className="text-xs text-(--el-text-secondary)">{t('alertShare.isDefault')}</span>
          )}
          {canEdit && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setPhase({
                  kind: 'editing',
                  draft: String(shown.percent),
                  refusal: null,
                  saving: false,
                })
              }
            >
              <Pencil aria-hidden className="h-3.5 w-3.5" />
              {t('alertShare.edit')}
            </Button>
          )}
        </div>
      )}
      {phase.kind === 'idle' && phase.saved !== null && (
        <p role="status" className="mt-2 flex items-start gap-1.5 text-xs text-(--el-text)">
          <CircleCheck aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-success)" />
          <span>{t('alertShare.saved', { share: phase.saved })}</span>
        </p>
      )}
      <p className="mt-2.5 text-xs text-(--el-text-secondary)">{t('alertShare.note')}</p>
    </Card>
  );
}

function AlertShareHeader() {
  const t = useTranslations('platformAdmin.capacity');
  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex h-7.5 w-7.5 items-center justify-center rounded-(--radius-control) bg-(--el-tint-yellow) text-(--el-warning)">
        <Gauge aria-hidden className="h-4 w-4" />
      </span>
      <div>
        <h3 className="font-sans text-sm font-semibold text-(--el-text)">
          {t('alertShare.title')}
        </h3>
        <p className="text-xs text-(--el-text-secondary)">{t('alertShare.hsub')}</p>
      </div>
    </div>
  );
}

function AlertShareEditor({
  phase,
  onDraft,
  onSave,
  onCancel,
}: {
  phase: Extract<Phase, { kind: 'editing' }>;
  onDraft: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const errorId = useId();
  const refusal = phase.refusal;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 text-sm text-(--el-text)">
        <span>{t('alertShare.label')}</span>
        <div
          className={`w-24 ${refusal === 'INVALID_VALUE' ? '[&_[data-surface=input]]:border-(--el-danger)' : ''}`}
        >
          <Input
            inputMode="numeric"
            aria-label={t('alertShare.label')}
            aria-invalid={refusal === 'INVALID_VALUE' || undefined}
            aria-describedby={refusal ? errorId : undefined}
            value={phase.draft}
            disabled={phase.saving}
            onChange={(e) => onDraft(e.target.value)}
            addonEnd="%"
          />
        </div>
        <Button size="sm" loading={phase.saving} onClick={onSave}>
          {phase.saving ? t('edit.saving') : t('edit.save')}
        </Button>
        <Button variant="secondary" size="sm" disabled={phase.saving} onClick={onCancel}>
          {t('edit.cancel')}
        </Button>
      </div>
      {refusal && (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 text-xs text-(--el-danger-on-surface)"
        >
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{t(`alertShare.${REFUSAL_KEY[refusal]}`)}</span>
        </p>
      )}
    </>
  );
}
