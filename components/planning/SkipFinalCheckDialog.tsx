'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CircleStop, Info, SkipForward } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

/**
 * THE CONFIRM FOR SKIPPING THE FINAL CHECK (Story MOTIR-11262 · MOTIR-11266), drawn
 * to `design/ai-chat/design-notes.md` § "⭐ The final check" §3 and panels 5, 6, 8
 * and 8b of `planning-workspace--skip-final-check.mock.html`.
 *
 * Composed from the shipped `Modal` as the planning confirms are (`PlanCloseGuard`'s
 * footer, `FolderDeleteDialog`'s tinted line, `DeleteWorkItemDialog`'s Try again).
 * Presentational: the owner holds the phase and the request.
 *
 * ⚠️ PRIMARY, NOT DANGER. Skipping deletes nothing a person made: the plan is still
 * proposed and everything written stays. The loss is a check that did not finish,
 * which the peach line names in words (the MOTIR-11260 call).
 */
export type SkipFinalCheckPhase = 'open' | 'skipping' | 'failed' | 'finished';

export interface SkipFinalCheckDialogProps {
  open: boolean;
  phase: SkipFinalCheckPhase;
  /** Keep checking, Escape, × or the scrim — and Close once it had finished. */
  onKeep: () => void;
  /** Skip the final check, and Try again after a failure. */
  onConfirm: () => void;
  /** Where focus goes on close; see `Modal`'s `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void;
}

export function SkipFinalCheckDialog({
  open,
  phase,
  onKeep,
  onConfirm,
  onCloseAutoFocus,
}: SkipFinalCheckDialogProps) {
  const t = useTranslations('planningWorkspace.skipFinalCheck');
  const tCommon = useTranslations('common');
  const lineId = useId();
  const skipping = phase === 'skipping';
  const finished = phase === 'finished';

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        // Escape and the scrim are ignored while the request is out.
        if (!next && !skipping) onKeep();
      }}
      role="alertdialog"
      size="md"
      title={t('title')}
      description={t('body')}
      describedBy={lineId}
      {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
    >
      <Modal.Body>
        <div
          data-testid="planning-skip-check-dialog"
          data-phase={phase}
          aria-busy={skipping || undefined}
          className="flex flex-col gap-3"
        >
          {finished ? (
            <p
              id={lineId}
              role="status"
              data-testid="planning-skip-check-dialog-finished"
              className="flex gap-2 rounded-(--radius-control) bg-(--el-tint-mint) px-(--spacing-control-x-12) py-(--spacing-control-y) text-[13px] text-(--el-text-strong)"
            >
              <Info className="mt-px size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
              <span>{t('finished')}</span>
            </p>
          ) : (
            <p
              id={lineId}
              data-testid="planning-skip-check-dialog-consequence"
              className="flex gap-2 rounded-(--radius-control) bg-(--el-tint-peach) px-(--spacing-control-x-12) py-(--spacing-control-y) text-[13px] text-(--el-text-strong)"
            >
              <CircleStop
                className="mt-px size-4 shrink-0 text-(--el-warning)"
                aria-hidden="true"
              />
              <span>{t('consequence')}</span>
            </p>
          )}
          {phase === 'failed' ? (
            <p
              role="alert"
              data-testid="planning-skip-check-dialog-error"
              className="flex gap-2 text-[13px] text-(--el-text)"
            >
              <AlertCircle
                className="mt-0.5 size-3.5 shrink-0 text-(--el-danger)"
                aria-hidden="true"
              />
              <span>{t('error')}</span>
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer className="flex-wrap">
        {finished ? (
          <Button
            variant="primary"
            size="sm"
            onClick={onKeep}
            autoFocus
            data-testid="planning-skip-check-close"
          >
            {tCommon('close')}
          </Button>
        ) : (
          <>
            {/* First focusable, so the dialog opens on the safe answer. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={onKeep}
              disabled={skipping}
              data-testid="planning-skip-check-keep"
            >
              {t('keep')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onConfirm}
              loading={skipping}
              leftIcon={<SkipForward className="size-3.5" aria-hidden="true" />}
              data-testid="planning-skip-check-confirm"
            >
              {phase === 'failed' ? t('retry') : t('confirm')}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}
