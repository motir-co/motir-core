'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, CircleStop, ExternalLink, Info, Settings2, SkipForward } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { FINAL_CHECK_SETTING_HREF } from '@/app/(authed)/backlog/_components/aiSprintPlanShared';

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
 * which the peach line names in words (the MOTIR-11260 call), and says the Motir
 * agent can still build through what the check would have fixed (MOTIR-11359).
 *
 * `lg` (32rem), not `md`: the longer peach line made the 28rem panel tall and
 * cramped. Below 32rem the Modal is full-width minus its gutter, so phones are
 * unchanged.
 *
 * THE SETTINGS LINE (MOTIR-11548; design MOTIR-11547, § "⭐ The final check, §3
 * amended" and `planning-workspace--skip-final-check--settings-link.mock.html`):
 * under the consequence (or finished) line in every phase, a quieter pointer to the
 * project's Run the final check setting. A plain anchor opening a NEW TAB, not
 * `next/link`: this tab — the overlay, the plan, the running check and this dialog —
 * is left exactly as it was. It is still live while the skip is out; nothing here
 * depends on it.
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
  /**
   * May the viewer change project AI settings (`ai:configure`, the permission the
   * settings page reads as `isAdmin`)? Picks the settings line's copy: _switch off_
   * for them, _a project admin can turn … off_ for a member who only plans. The
   * link is the same either way. Absent → the read-only copy, the claim a viewer
   * can always act on.
   */
  canManageSettings?: boolean;
}

export function SkipFinalCheckDialog({
  open,
  phase,
  onKeep,
  onConfirm,
  onCloseAutoFocus,
  canManageSettings = false,
}: SkipFinalCheckDialogProps) {
  const t = useTranslations('planningWorkspace.skipFinalCheck');
  const tCommon = useTranslations('common');
  const lineId = useId();
  const skipping = phase === 'skipping';
  const finished = phase === 'finished';
  // There was no skip to scope once the check had finished, so that sentence goes.
  const settingKey = canManageSettings
    ? finished
      ? 'settingLineFinished'
      : 'settingLine'
    : finished
      ? 'settingLineReadOnlyFinished'
      : 'settingLineReadOnly';

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        // Escape and the scrim are ignored while the request is out.
        if (!next && !skipping) onKeep();
      }}
      role="alertdialog"
      size="lg"
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
          <p
            data-testid="planning-skip-check-dialog-setting"
            className="flex gap-2 px-(--spacing-control-x-12) text-[13px] leading-relaxed text-(--el-text-secondary)"
          >
            <Settings2
              className="mt-[3px] size-4 shrink-0 text-(--el-text-secondary)"
              aria-hidden="true"
            />
            <span>
              {t.rich(settingKey, {
                link: (chunks) => (
                  <a
                    href={FINAL_CHECK_SETTING_HREF}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="planning-skip-check-setting-link"
                    className="rounded-(--radius-control) font-medium text-(--el-link) underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:outline-none"
                  >
                    {chunks}
                    <ExternalLink
                      className="ml-1 inline size-3.5 align-[-2px]"
                      aria-hidden="true"
                    />
                    <span className="sr-only"> {t('settingNewTab')}</span>
                  </a>
                ),
              })}
            </span>
          </p>
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
