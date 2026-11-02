'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { PlanOverlayDoor } from '@/components/planning/PlanOverlayDoor';
import { NotPlannedYetList } from '@/components/planning/NotPlannedYetList';
import { useRelativeLabel } from '@/components/approvals/useRelativeLabel';
import { fetchPlanReview } from '@/lib/planning/planReviewClient';
import { AI_DECIDED_PLAN_STATUSES } from '@/lib/dto/ai';
import type { ToResumePlanningSessionDto } from '@/lib/dto/home';
import {
  leftLineKeyOf,
  nextStepKeyOf,
  resumeReasonKeyOf,
  stopPhraseKeyOf,
  waitingPlanStateKeyOf,
  type LeftLineKey,
} from './planningSessionWords';

// THE BODIES OF A TO RESUME PLANNING-SESSION ENTRY, one per form (Story MOTIR-7905 ·
// MOTIR-7940; design `design/workbench/design-notes.md` § 37.2 / § 38, mock
// `workbench--to-resume--situation-2.mock.html`). `PlanningSessionResumeEntry` owns the frame,
// the state pill, the door and Resume; these are only line 2 and line 3.
//
// ⚠️ THE FORM COMES FROM THE SERVER and is switched on exhaustively (`never` below), so a
// fourth form is a compile error rather than a silent fall-through into form A's Resume.

type Entry = ToResumePlanningSessionDto;
const SEP = (
  <span aria-hidden className="text-(--el-text-secondary)">
    ·
  </span>
);

/** Form A — a failed walk: where it stopped, why, how far; and a waiting plan beside it. */
function FailedWalkBody({ entry }: { entry: Entry }) {
  const t = useTranslations('workbench.planningSession');
  const failure = entry.failure;
  if (!failure) return null;
  const stop = stopPhraseKeyOf(failure);
  const progress = entry.progress;
  return (
    <>
      <div role="cell" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
        <span className="text-(--el-text-secondary)">{t('stoppedAt')}</span>
        <span className="font-medium text-(--el-text)">
          {t(`stop.${stop}`, { title: failure.stopTitle ?? '' })}
        </span>
        {SEP}
        <span className="text-(--el-text-secondary)">
          {t('because', { reason: t(`reason.${resumeReasonKeyOf(failure.reason)}`) })}
        </span>
        {progress ? (
          <>
            {SEP}
            <span className="text-(--el-text-secondary)">
              {t('written', { n: progress.authored, m: progress.proposed })}
            </span>
          </>
        ) : null}
      </div>
      {/* The cards the halt left unplanned (MOTIR-10209), under the stop line — a cell of the
          entry's row, as line 2 is; a long list is held back behind a count. */}
      {failure.notPlannedYet && failure.notPlannedYet.length > 0 ? (
        <div role="cell" className="min-w-0">
          <NotPlannedYetList lines={failure.notPlannedYet} surface="row" />
        </div>
      ) : null}
      {entry.waitingPlan ? (
        <p className="text-xs text-(--el-text-secondary)" data-testid="to-resume-also-waiting">
          {t('form.walk.alsoWaiting')}{' '}
          <PlanOverlayDoor
            planId={entry.waitingPlan.planId}
            known={{
              planStatus: entry.waitingPlan.status,
              sessionId: entry.sessionId,
              anchorKey: entry.targets[0]?.key ?? null,
            }}
            via="resume"
            className="relative z-10 font-medium text-(--el-link) hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {entry.waitingPlan.title ?? entry.projectName}
          </PlanOverlayDoor>
        </p>
      ) : null}
    </>
  );
}

/** Form B — a failure beside a waiting plan: the plan's state, the failed change, the next step. */
function BesideWaitingPlanBody({ entry }: { entry: Entry }) {
  const t = useTranslations('workbench.planningSession');
  const locale = useLocale();
  const relativeLabel = useRelativeLabel();
  const status = entry.waitingPlan?.status ?? 'planned';
  const failure = entry.failure;
  return (
    <>
      <div role="cell" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
        <span className="font-medium text-(--el-text)">
          {t(`form.b.${waitingPlanStateKeyOf(status)}`)}
        </span>
        {SEP}
        <span className="text-(--el-text-secondary)">{t('form.b.badChange')}</span>
        {failure ? (
          <>
            {SEP}
            <span className="text-(--el-text-secondary)">
              {t('because', { reason: t(`reason.${resumeReasonKeyOf(failure.reason)}`) })}
            </span>
            {SEP}
            <span
              className="text-(--el-text-secondary)"
              title={new Date(failure.failedAt).toLocaleString(locale)}
            >
              {t('failedAt', { when: relativeLabel(failure.failedAt) })}
            </span>
          </>
        ) : null}
      </div>
      <p className="text-xs text-(--el-text-secondary)">{t(`form.b.${nextStepKeyOf(status)}`)}</p>
    </>
  );
}

/** Form C — a session that ended `failed` before: the plan's state, that it ended, the gloss. */
function EndedWithWaitingPlanBody({ entry }: { entry: Entry }) {
  const t = useTranslations('workbench.planningSession');
  const locale = useLocale();
  const relativeLabel = useRelativeLabel();
  const status = entry.waitingPlan?.status ?? 'planned';
  return (
    <>
      <div role="cell" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs">
        <span className="font-medium text-(--el-text)">
          {t(`form.b.${waitingPlanStateKeyOf(status)}`)}
        </span>
        {entry.endedAt ? (
          <>
            {SEP}
            <span
              className="text-(--el-text-secondary)"
              title={new Date(entry.endedAt).toLocaleString(locale)}
            >
              {t('form.c.ended', { when: relativeLabel(entry.endedAt) })}
            </span>
          </>
        ) : null}
      </div>
      <p className="text-xs text-(--el-text-secondary)">{t('form.c.gloss')}</p>
    </>
  );
}

export function PlanningSessionFormBody({ entry }: { entry: Entry }) {
  switch (entry.form) {
    case 'failed_walk':
      return <FailedWalkBody entry={entry} />;
    case 'failed_beside_waiting_plan':
      return <BesideWaitingPlanBody entry={entry} />;
    case 'ended_with_waiting_plan':
      return <EndedWithWaitingPlanBody entry={entry} />;
    default: {
      const unreachable: never = entry.form;
      return unreachable;
    }
  }
}

/**
 * WHY A HELD B / C ENTRY LEFT (design § 38, Panel 6). The read drops the entry for four
 * reasons and says none of them, so the line is inferred from the form and the plan's state
 * before it left — a revision (B planned) or a carry (C) or a *Plan it again* (B stale) — and
 * read ONCE from the plan if it was DECIDED instead. A read that fails keeps the inference,
 * which is the likelier of the four.
 */
export function useLeftLine(entry: Entry, held: boolean): LeftLineKey | null {
  const inferred = leftLineKeyOf(entry.form, entry.waitingPlan?.status ?? null, false);
  const [decided, setDecided] = useState<{ planId: string } | null>(null);
  const planId = entry.waitingPlan?.planId ?? null;
  useEffect(() => {
    if (!held || inferred === null || planId === null) return;
    const ctrl = new AbortController();
    fetchPlanReview(planId, ctrl.signal).then(
      (review) => {
        if ((AI_DECIDED_PLAN_STATUSES as readonly string[]).includes(review.status))
          setDecided({ planId });
      },
      () => {},
    );
    return () => ctrl.abort();
  }, [held, inferred, planId]);
  if (!held || inferred === null) return null;
  return decided !== null && decided.planId === planId ? 'decided' : inferred;
}
