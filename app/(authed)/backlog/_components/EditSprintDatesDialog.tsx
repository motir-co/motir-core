'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { DatePicker } from '@motir/design-system';
import { useToast } from '@/components/ui/Toast';
import type { SprintDto } from '@/lib/dto/sprints';

// Edit-sprint-dates flow (Story 4.2 · Subtask 4.2.5 — the sprint `⋯` menu; bug
// MOTIR-1494). The backend has always supported adjusting a sprint's window
// (`sprintsService.updateSprint` + `PATCH /api/sprints/[id]` accept
// `startDate`/`endDate`, validated by `assertWindow`), but the dates were only
// settable while STARTING the sprint (`StartSprintDialog`) — a planned/active
// sprint had no standalone date edit. This dialog closes that UI gap: it opens
// from the `⋯` menu's "Edit dates" item and REUSES the shipped `DatePicker` +
// the window-invalid vocabulary the start flow already established.
//
// One PATCH `{ startDate, endDate }`; the service validates end-≥-start
// server-side (422 → `SPRINT_WINDOW_INVALID`) and freezes a `complete` sprint
// (409 → `CANNOT_MODIFY_COMPLETED_SPRINT`). The same end-≥-start check gates the
// client Save so the user sees it inline first (text + glyph + `--el-danger`,
// never colour alone — finding #35). A `complete` sprint's dates are frozen, so
// the menu doesn't offer this item there and the dialog only opens for a
// planned/active sprint (the 409 path stays as a backstop toast).

/** A full ISO timestamp → the UTC `YYYY-MM-DD` key the `DatePicker` holds.
 *  Sprint dates persist as UTC-midnight (set from a `YYYY-MM-DD` key), so slicing
 *  the UTC ISO is exact and matches the picker's UTC date math. */
function isoToKey(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

export interface EditSprintDatesDialogProps {
  sprint: SprintDto;
  onClose: () => void;
  /** Run after a successful edit — the backlog refetches its sprint metadata so
   *  the header's date range re-reads (a client island; `refetchSprints` bumps
   *  the `/api/sprints` read). */
  onUpdated: () => void | Promise<void>;
}

export function EditSprintDatesDialog({ sprint, onClose, onUpdated }: EditSprintDatesDialogProps) {
  const t = useTranslations('backlog');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [startDate, setStartDate] = useState<string | null>(isoToKey(sprint.startDate));
  const [endDate, setEndDate] = useState<string | null>(isoToKey(sprint.endDate));
  const [saving, setSaving] = useState(false);

  // Mirror the start flow's client gate: both endpoints present and end ≥ start.
  // `assertWindow` enforces the same server-side, so this only front-runs it.
  const windowInvalid = Boolean(startDate && endDate && endDate < startDate);
  const datesPresent = Boolean(startDate && endDate);
  const canSave = datesPresent && !windowInvalid && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/sprints/${sprint.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ startDate, endDate }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        const description =
          data.code === 'SPRINT_WINDOW_INVALID'
            ? t('editSprintDatesFlow.windowInvalid')
            : data.code === 'NOT_SPRINT_ADMIN'
              ? t('editSprintDatesFlow.errorNotAdmin')
              : data.code === 'CANNOT_MODIFY_COMPLETED_SPRINT'
                ? t('editSprintDatesFlow.errorCompleted')
                : t('editSprintDatesFlow.errorDescription');
        toast({ variant: 'error', title: t('editSprintDatesFlow.errorTitle'), description });
        setSaving(false);
        return;
      }
      toast({
        variant: 'success',
        title: t('editSprintDatesFlow.savedToast', { name: sprint.name }),
      });
      await onUpdated();
      onClose();
    } catch {
      toast({
        variant: 'error',
        title: t('editSprintDatesFlow.errorTitle'),
        description: t('editSprintDatesFlow.errorDescription'),
      });
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={t('editSprintDatesFlow.title')}
      description={t('editSprintDatesFlow.subtitle', { name: sprint.name })}
      size="md"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-(--spacing-md)">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`edit-start-date-${sprint.id}`}
              className="font-sans text-sm font-medium text-(--el-text)"
            >
              {t('editSprintDatesFlow.startDateLabel')}
            </label>
            <DatePicker
              id={`edit-start-date-${sprint.id}`}
              value={startDate}
              onChange={setStartDate}
              aria-label={t('editSprintDatesFlow.startDateLabel')}
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`edit-end-date-${sprint.id}`}
              className="font-sans text-sm font-medium text-(--el-text)"
            >
              {t('editSprintDatesFlow.endDateLabel')}
            </label>
            <DatePicker
              id={`edit-end-date-${sprint.id}`}
              value={endDate}
              onChange={setEndDate}
              aria-label={t('editSprintDatesFlow.endDateLabel')}
              disabled={saving}
            />
            {windowInvalid ? (
              <span
                role="alert"
                className="flex items-center gap-1 font-sans text-xs text-(--el-danger)"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('editSprintDatesFlow.windowInvalid')}
              </span>
            ) : null}
          </div>
        </div>

        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {tc('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
            {t('editSprintDatesFlow.confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
