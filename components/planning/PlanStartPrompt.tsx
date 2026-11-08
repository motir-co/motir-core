'use client';

import { CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { WorkItemRefChip } from '@/components/markdown/WorkItemRefChip';
import { Bubble } from '@/components/planning/PlanChangeRail';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { PlanningTarget } from '@/lib/planning/planningTargets';
import type { PlanStartFace, PlanStartPhase } from '@/lib/planning/planStartPrompt';

// THE START PROMPT (MOTIR-10624; design MOTIR-10623,
// `design/ai-chat/planning-workspace--start-from-card.mock.html` panels 2–6).
//
// The rail's first message when the overlay opens from a card's Plan / Re-plan
// button: the planner asks whether to start, names the card with the shipped
// work-item chip, and offers ONE primary Start. It is drawn by the client and is
// not a model call — nothing is sent, and no credit is spent, until the person
// presses Start or sends.
//
// Presentational only. The rail owns the phase (derived from the thread), the
// draft and the send; this component draws what it is told. The phase decides
// what sits under the bubble: Start + its help line (`live`), Start in its loading
// state (`starting`), or the *Planning started* chip (`spent`) — the plan offer's
// confirmed chip, so a started prompt reads like a confirmed offer.

/** The chip's summary, built from the resolved anchor. Only the key, title and
 *  kind crossed the anchor read, so no status dot is drawn rather than a guessed
 *  one — the same shape `PlanChangeRail`'s client-built summaries use. */
function targetSummary(target: PlanningTarget): WorkItemRefSummaryDto {
  return {
    accessible: true,
    id: target.id,
    identifier: target.identifier,
    title: target.title,
    kind: target.kind,
    archived: false,
    status: null,
    type: null,
    assignee: null,
  };
}

export function PlanStartPrompt({
  target,
  face,
  phase,
  typed,
  onStart,
}: {
  target: PlanningTarget;
  face: PlanStartFace;
  phase: PlanStartPhase;
  /** The composer holds text — the help line says Start sends it too. */
  typed: boolean;
  onStart: () => void;
}) {
  const t = useTranslations('planningWorkspace.startPrompt');
  const replan = face === 'replan';
  const key = target.identifier;
  const helpKey = typed
    ? replan
      ? 'helpTypedReplan'
      : 'helpTypedPlan'
    : replan
      ? 'helpEmptyReplan'
      : 'helpEmpty';

  return (
    <section
      aria-label={t(replan ? 'labelReplan' : 'label', { key })}
      data-testid="plan-start-prompt"
      data-face={face}
      data-state={phase}
      className="flex flex-col gap-2"
    >
      <Bubble role="assistant">
        <span className="flex flex-col items-start gap-1.5">
          <span className="font-medium">{t(replan ? 'askReplan' : 'askPlan')}</span>
          {/* `wi-chip-host` — the chip's own rules reach it outside MarkdownView (MOTIR-7068). */}
          <span className="wi-chip-host inline-flex max-w-full align-middle">
            <WorkItemRefChip summary={targetSummary(target)} fallbackLabel={key} />
          </span>
          <span>{t(replan ? 'bodyReplan' : 'bodyPlan')}</span>
        </span>
      </Bubble>
      {/* Indented to the bubble's text column — the starter chips' seam. */}
      <div className="flex flex-col items-start gap-1.5 pl-9">
        {phase === 'spent' ? (
          <span
            data-testid="plan-start-spent"
            className="inline-flex w-fit items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-mint) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)"
          >
            <CircleCheck className="size-3.5" aria-hidden />
            {t(replan ? 'startedReplan' : 'startedPlan')}
          </span>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              data-testid="plan-start-confirm"
              loading={phase === 'starting'}
              onClick={onStart}
            >
              {phase === 'starting' ? t('starting') : t(replan ? 'startReplan' : 'startPlan')}
            </Button>
            {/* Hidden while starting (design panel 5): it describes a press that
                has already happened. */}
            {phase === 'live' ? (
              <p className="text-xs leading-relaxed text-(--el-text-secondary)">{t(helpKey)}</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
