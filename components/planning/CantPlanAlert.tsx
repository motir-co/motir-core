'use client';

import Link from 'next/link';
import { useId, useRef, type RefObject } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { SurfaceTitle } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import type { PlanBlockReasonDto, PlanBlockerDto } from '@/lib/dto/plannability';

// THE CAN'T-PLAN ALERT (MOTIR-10544; design MOTIR-10543 panels 4, 5, 7 and 8,
// `design/roadmap/roadmap--plan-check-alert.mock.html`).
//
// The shipped `Modal`, `size="md"`, `role="alertdialog"`, `hideClose` (the
// footer's Close is the one dismiss). Title names the card that was clicked; the
// lead line says how many stories it waits on; then one reason line per blocker,
// in key order; then Close.
//
// No plan-anyway action, on purpose: a planning run on this card would stop at
// its blocker, so the way forward is on each reason line instead — a per-line
// Plan, drawn only when that blocker is itself To plan.
//
// The accessibility contract (design § "Accessibility contract"): labelled by
// the title, described by the lead line AND the reason list (`describedBy`),
// focus lands on Close when it opens and returns to the card's Plan button when
// it closes — by Close, Escape or a click on the scrim — and Radix traps focus
// in between.

export interface CantPlanAlertProps {
  /** The card whose Plan was pressed; `null` closes the alert. */
  itemKey: string | null;
  reasons: PlanBlockReasonDto[];
  onClose: () => void;
  /** A line's Plan: plan that blocker, through the same checked click path. */
  onPlanBlocker: (blockerKey: string) => void;
  /** The control focus returns to on close — the card's Plan button. */
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function CantPlanAlert({
  itemKey,
  reasons,
  onClose,
  onPlanBlocker,
  returnFocusRef,
}: CantPlanAlertProps) {
  const t = useTranslations('roadmap.canvas.node.action');
  const tEntrance = useTranslations('aiPlanning.entrance');
  const tCommon = useTranslations('common');
  const listId = useId();
  const key = itemKey ?? '';
  const closeRef = useRef<HTMLButtonElement>(null);
  // The one reason kind today; its blockers are the lead line's count.
  const blockers = reasons.flatMap((r) => r.blockers);

  return (
    <Modal
      open={itemKey !== null}
      // Radix only ever CLOSES this dialog (there is no `Modal.Trigger`): Close,
      // Escape and a click on the scrim all arrive here as `false`.
      onOpenChange={onClose}
      size="md"
      role="alertdialog"
      hideClose
      title={t('cantPlanTitle', { key })}
      description={t('cantPlanLead', { count: blockers.length })}
      describedBy={listId}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        closeRef.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        // A dialog opened with no `Modal.Trigger` has nothing for Radix to
        // return focus to. A line's Plan lands here too: focus comes back to the
        // card first, and the planning overlay takes it when the blocker's own
        // check opens it.
        event.preventDefault();
        returnFocusRef.current?.focus();
      }}
    >
      <Modal.Body>
        <ul id={listId} className="m-0 flex list-none flex-col gap-2 p-0">
          {reasons.flatMap((reason) =>
            reason.blockers.map((blocker) => (
              <ReasonLine
                key={`${reason.kind}:${blocker.identifier}`}
                kind={reason.kind}
                blocker={blocker}
                planLabel={tEntrance('plan')}
                planAria={tEntrance('planAria', { item: blocker.identifier })}
                reasonText={t('cantPlanNoSubtasks', { key })}
                onPlan={() => onPlanBlocker(blocker.identifier)}
              />
            )),
          )}
        </ul>
      </Modal.Body>
      <Modal.Footer>
        <Button ref={closeRef} variant="secondary" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Reason line: blocker has no subtasks — the blocker's link, why, and its Plan. */
function ReasonLine({
  kind,
  blocker,
  planLabel,
  planAria,
  reasonText,
  onPlan,
}: {
  kind: PlanBlockReasonDto['kind'];
  blocker: PlanBlockerDto;
  planLabel: string;
  planAria: string;
  reasonText: string;
  onPlan: () => void;
}) {
  return (
    <li
      data-reason={kind}
      className="flex items-start gap-3 rounded-(--radius-control) border border-(--el-border) px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
    >
      <IssueTypeIcon type="story" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <Link
          href={`/items/${blocker.identifier}`}
          className="text-sm leading-snug font-medium text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <span className="font-mono text-xs font-semibold">{blocker.identifier}</span>{' '}
          {/* The blocker's title in the reader's language when the roadmap's
              title-translation host is on (the alert renders under it). */}
          <SurfaceTitle id={blocker.id} title={blocker.title} layout="clamp" />
        </Link>
        <p className="mt-0.5 text-xs leading-snug text-(--el-text-secondary)">{reasonText}</p>
      </div>
      {blocker.toPlan ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={planAria}
          className="shrink-0 gap-1.5 text-(--el-accent-on-surface)"
          leftIcon={<Sparkles className="size-3.5 shrink-0" />}
          onClick={onPlan}
        >
          {planLabel}
        </Button>
      ) : null}
    </li>
  );
}
