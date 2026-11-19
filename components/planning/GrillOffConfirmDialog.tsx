'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

/**
 * THE GRILL ME SWITCH-OFF CONFIRMATION (Story MOTIR-11799 · Subtask MOTIR-11802), drawn to
 * `design/ai-chat/design-notes.md` § "⭐ Grill me — the switch-off confirmation" and
 * panels 2–7 of `grill-me--switch-confirm-and-reopen.mock.html`.
 *
 * One dialog for the switch and for Stop grilling: both end a grilling that is open or
 * about to open, and only Confirm ends it. Keep grilling, Escape, × and the scrim change
 * nothing — the switch reads on until Confirm.
 *
 * ⚠️ PRIMARY, NOT DANGER. Nothing a person made is lost: the answers given are kept and
 * written into the requirement (the call `SkipFinalCheckDialog` makes for the same
 * reason). Presentational: the rail holds the request.
 */
export interface GrillOffConfirmDialogProps {
  open: boolean;
  /** How many answers the grilling has settled; 0 picks the nothing-settled body. */
  settledCount: number;
  onKeep: () => void;
  onConfirm: () => void;
}

export function GrillOffConfirmDialog({
  open,
  settledCount,
  onKeep,
  onConfirm,
}: GrillOffConfirmDialogProps) {
  const t = useTranslations('planningWorkspace.grill.offConfirm');
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
      role="alertdialog"
      size="md"
      title={t('title')}
      description={settledCount > 0 ? t('bodySettled', { count: settledCount }) : t('bodyNone')}
    >
      <Modal.Footer className="flex-wrap">
        {/* First focusable, so the dialog opens on the safe answer. */}
        <Button variant="ghost" size="sm" onClick={onKeep} data-testid="grill-off-keep">
          {t('keep')}
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} data-testid="grill-off-confirm">
          {t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
