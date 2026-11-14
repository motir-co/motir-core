'use client';

import { AlertCircle, ArrowUpRight, CircleStop } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

// THE PLAN SOMETHING NEW DIALOG (MOTIR-11261; design MOTIR-11260,
// `design/ai-chat/design-notes.md` § *Plan something new confirms in a modal
// dialog*, mock `planning-workspace--plan-something-new--modal.mock.html`).
//
// The rail head's control asks here instead of on the thread: a button press is a
// yes-or-no question about the session itself, which is what a confirm dialog is
// for, so nothing is written to the conversation whatever the answer.
//
// Composed from the shipped `Modal` the way `PlanCloseGuard` composes it, with
// `FolderDeleteDialog`'s tinted consequence line and refusal line and
// `DeleteWorkItemDialog`'s *Try again*. No new primitive.
//
// Presentational: the rail owns the open state and the hook owns the restart.

/** What the dialog says about the session's latest plan — panels 3 and 3b. */
export type PlanRestartDialogPlan = 'writing' | 'waiting' | null;

export interface PlanRestartDialogProps {
  open: boolean;
  /** The session's undecided plan, when it has one worth naming. */
  plan: PlanRestartDialogPlan;
  /** The restart is in flight (panel 4): both buttons disabled, nothing dismisses. */
  confirming: boolean;
  /** The last restart did not happen (panel 7): the error line, and *Try again*. */
  failed: boolean;
  /** Keep planning, Escape, the close control and a scrim click (panel 6). */
  onKeepPlanning: () => void;
  /** Start something new — and *Try again* after a failure. */
  onConfirm: () => void;
  /** Where focus goes when the dialog closes — Radix's `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void;
}

const PLAN_LINE_ID = 'planning-restart-dialog-plan';

export function PlanRestartDialog({
  open,
  plan,
  confirming,
  failed,
  onKeepPlanning,
  onConfirm,
  onCloseAutoFocus,
}: PlanRestartDialogProps) {
  const t = useTranslations('planningWorkspace.restart.dialog');

  return (
    <Modal
      open={open}
      // Escape, × and the scrim all arrive here and all mean Keep planning — except
      // while the restart is in flight, when the dialog stays until it lands
      // (as `PlanCloseGuard` ignores closing while `deciding`).
      onOpenChange={(next) => {
        if (!next && !confirming) onKeepPlanning();
      }}
      role="alertdialog"
      size="md"
      title={t('title')}
      description={t('body')}
      // The plan line is part of the description: a screen reader reads it with
      // the title. Named only while it is drawn.
      {...(plan ? { describedBy: PLAN_LINE_ID } : {})}
      {...(onCloseAutoFocus ? { onCloseAutoFocus } : {})}
    >
      <div data-testid="planning-restart-dialog" className="contents">
        <Modal.Body className="gap-3" aria-busy={confirming || undefined}>
          {confirming ? null : (
            <>
              {plan === 'writing' ? (
                <p
                  id={PLAN_LINE_ID}
                  data-testid="planning-restart-dialog-plan"
                  data-plan="writing"
                  className="flex items-start gap-2.5 rounded-(--radius-control) bg-(--el-tint-peach) p-(--spacing-control-x-12) text-[13px] leading-normal text-(--el-text-strong)"
                >
                  <CircleStop
                    className="mt-px h-4 w-4 shrink-0 text-(--el-warning)"
                    aria-hidden="true"
                  />
                  <span>{t('writing')}</span>
                </p>
              ) : plan === 'waiting' ? (
                <p
                  id={PLAN_LINE_ID}
                  data-testid="planning-restart-dialog-plan"
                  data-plan="waiting"
                  className="flex items-start gap-2.5 rounded-(--radius-control) bg-(--el-tint-mint) p-(--spacing-control-x-12) text-[13px] leading-normal text-(--el-text-strong)"
                >
                  <ArrowUpRight
                    className="mt-px h-4 w-4 shrink-0 text-(--el-success)"
                    aria-hidden="true"
                  />
                  <span>{t('waiting')}</span>
                </p>
              ) : null}
              {failed ? (
                <p
                  role="alert"
                  data-testid="planning-restart-dialog-error"
                  className="flex items-start gap-1.5 text-[13px] text-(--el-text)"
                >
                  <AlertCircle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-danger)"
                    aria-hidden="true"
                  />
                  <span>{t('error')}</span>
                </p>
              ) : null}
            </>
          )}
        </Modal.Body>
        <Modal.Footer className="flex-wrap">
          {/* Keep planning first: the safe answer is the first focusable element,
              so Radix lands focus on it when the dialog opens. */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onKeepPlanning}
            disabled={confirming}
            data-testid="planning-restart-keep"
          >
            {t('keep')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            loading={confirming}
            data-testid="planning-restart-confirm"
          >
            {failed && !confirming ? t('retry') : t('confirm')}
          </Button>
        </Modal.Footer>
      </div>
    </Modal>
  );
}
