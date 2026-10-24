'use client';

import { useTranslations } from 'next-intl';
import { Bot, RefreshCw, SkipForward, Square } from 'lucide-react';

import { AiPaywall } from '@/components/ai/AiPaywall';
import { Button } from '@/components/ui/Button';
import { Bubble } from '@/components/planning/PlanChangeRail';
import { SharpenQuestionTurn } from '@/components/planning/SharpenQuestionTurn';
import { SharpenSummary } from '@/components/planning/SharpenSummary';
import type { SharpenAction, SharpenAssumption } from '@/lib/ai/types';
import type { SharpenSessionDto, SharpenTurnDto } from '@/lib/dto/sharpen';
import type { GrillError } from '@/components/planning/useGrillSession';

// THE GRILLING, IN THE RAIL'S CONVERSATION PHASE (Task MOTIR-1101 · Subtask
// MOTIR-8177; design G3–G5, panels 3–11).
//
// Everything the session has said and settled, in order, on the rail's own
// surfaces: the opening marker, each earlier question and the person's answer,
// the markers for a skip and a stop, the planner's assumption card for "You
// decide", the one pending question with its reply row, and — once the session
// ends — the end's own line and the settled-answers summary with the write-back's
// result. The hand-off that follows is the rail's own, unchanged.
//
// A CONVERSATION'S GRILLING (Story MOTIR-9221 · Subtask MOTIR-9316; design § Grill me
// before planning) is drawn the same way with four differences: no summary card (the
// settled list is drawn once, on the plan offer, and nothing is written before the
// person confirms), the conversation-scope nothing-to-ask and stopped-before-any-
// answer lines, the Grill-me-off marker, and Stop grilling kept under a failed turn
// or the out-of-credits state so the held offer can always be reached.

export interface SharpenThreadProps {
  session: SharpenSessionDto;
  pending: boolean;
  error: GrillError;
  /** The pending-question anchor, when the run itself is not waiting on a question. */
  anchorId?: string;
  onAct: (action: Exclude<SharpenAction, 'start' | 'stop'>, opts?: { readingId?: string }) => void;
  onStop: () => void;
  onSomethingElse: () => void;
  onRetry: () => void;
  /** A conversation's grilling that ended because Grill me was switched off. */
  endedBySwitch?: boolean;
}

function Marker({
  icon,
  children,
  testId,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <p
      className="flex items-center gap-1.5 pl-9 text-xs text-(--el-text-secondary)"
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {icon}
      {children}
    </p>
  );
}

function AssumptionCard({ assumption }: { assumption: SharpenAssumption }) {
  const t = useTranslations('sharpen');
  return (
    <div
      data-testid="sharpen-assumption"
      className="ml-9 rounded-(--radius-card) border border-dashed border-(--el-border-strong) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-sm"
    >
      <p className="flex items-center gap-1 text-xs font-semibold text-(--el-text-strong)">
        <Bot className="size-3.5" aria-hidden />
        {t('summary.plannersAssumption')}
      </p>
      <p className="text-(--el-text)">{assumption.recommendation}</p>
      {assumption.why ? (
        <p className="text-xs text-(--el-text-secondary)">{assumption.why}</p>
      ) : null}
    </div>
  );
}

/** Stop grilling where no question is pending to carry it — a conversation's
 *  failed turn or out-of-credits state (design panel 8). */
function StopGrilling({ onStop }: { onStop: () => void }) {
  const t = useTranslations('sharpen.question');
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="sharpen-stop"
      leftIcon={<Square className="size-4" aria-hidden />}
      onClick={onStop}
    >
      {t('stop')}
    </Button>
  );
}

/** Is this planner turn the session's ending line rather than a question? */
function isEndTurn(session: SharpenSessionDto, turn: SharpenTurnDto, index: number): boolean {
  if (session.status !== 'ended') return false;
  const lastPlanner = session.turns.findLastIndex((t) => t.role === 'planner' && !t.failed);
  return index === lastPlanner;
}

export function SharpenThread({
  session,
  pending,
  error,
  anchorId,
  onAct,
  onStop,
  onSomethingElse,
  onRetry,
  endedBySwitch = false,
}: SharpenThreadProps) {
  const t = useTranslations('sharpen');
  const conversationScope = session.scope.kind === 'conversation';
  const tc = useTranslations('planningWorkspace.conversation');
  const pendingQuestion = session.status === 'open' ? session.pendingQuestion : null;

  // The planner turn that IS the pending question is drawn with its reply row
  // below, not in the history.
  const pendingIndex = pendingQuestion
    ? session.turns.findLastIndex((t) => t.role === 'planner' && !t.failed)
    : -1;

  const rows: React.ReactNode[] = [];
  let questionNumber = 0;
  let lastQuestion: string | null = null;
  session.turns.forEach((turn, index) => {
    if (turn.role === 'planner') {
      if (turn.failed || index === pendingIndex || isEndTurn(session, turn, index)) return;
      questionNumber += 1;
      lastQuestion = turn.body;
      rows.push(
        <Bubble
          key={turn.id}
          role="assistant"
          tone="asking"
          label={t('question.label', { n: questionNumber })}
        >
          <p className="text-(--el-text)">{turn.body}</p>
        </Bubble>,
      );
      return;
    }
    switch (turn.action) {
      case 'answer':
      case 'own_words':
        rows.push(
          <Bubble key={turn.id} role="user">
            {turn.body}
          </Bubble>,
        );
        return;
      case 'skip':
        rows.push(
          <Marker key={turn.id} icon={<SkipForward className="size-3.5" aria-hidden />}>
            {t('markers.skipped')}
          </Marker>,
        );
        return;
      case 'you_decide': {
        rows.push(
          <Bubble key={turn.id} role="user">
            {t('question.youDecide')}
          </Bubble>,
        );
        const assumed = session.assumptions.find((a) => a.question === lastQuestion);
        if (assumed) rows.push(<AssumptionCard key={`${turn.id}-a`} assumption={assumed} />);
        return;
      }
      default:
        // `start` is the opening, drawn as the marker; `stop` ends the session,
        // drawn with the end below.
        return;
    }
  });

  const nothingSettled = session.settled.length === 0 && session.assumptions.length === 0;

  return (
    <div className="flex flex-col gap-3" data-testid="sharpen-thread">
      <Marker testId="sharpen-opening">{t('markers.opening')}</Marker>
      {rows}

      {pendingQuestion ? (
        <SharpenQuestionTurn
          question={pendingQuestion}
          number={questionNumber + 1}
          pending={pending}
          {...(anchorId ? { anchorId } : {})}
          onAct={onAct}
          onStop={onStop}
          onSomethingElse={onSomethingElse}
        />
      ) : null}

      {pending && !error ? (
        <p
          aria-live="polite"
          className="pl-9 text-xs text-(--el-text-secondary)"
          data-testid="sharpen-reading"
        >
          {tc('progress.reading')}
        </p>
      ) : null}

      {error === 'outOfCredits' && conversationScope ? (
        <div className="flex flex-col items-start gap-2 pl-9" data-testid="sharpen-out-of-credits">
          <AiPaywall triggeredOutOfCredits />
          {session.status === 'open' ? <StopGrilling onStop={onStop} /> : null}
        </div>
      ) : error ? (
        <div className="flex flex-col items-start gap-2 pl-9" data-testid="sharpen-error">
          <p
            role="alert"
            className="rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-sm text-(--el-text-strong)"
          >
            {t('error')}
          </p>
          {session.status === 'open' ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw className="size-4" aria-hidden />}
              onClick={onRetry}
              disabled={pending}
            >
              {t('retry')}
            </Button>
          ) : null}
          {conversationScope && session.status === 'open' && !pendingQuestion ? (
            <StopGrilling onStop={onStop} />
          ) : null}
        </div>
      ) : null}

      {session.status === 'ended' ? (
        <>
          {session.endReason === 'nothing_to_ask' ? (
            <Bubble role="assistant" testId="sharpen-nothing-to-ask">
              {conversationScope ? t('conversation.nothingToAsk') : t('markers.nothingToAsk')}
            </Bubble>
          ) : session.endReason === 'stopped' ? (
            <Marker testId="sharpen-stopped" icon={<Square className="size-3.5" aria-hidden />}>
              {conversationScope && endedBySwitch
                ? t('conversation.switchedOff')
                : !nothingSettled
                  ? t('markers.stopped')
                  : conversationScope
                    ? t('conversation.stoppedNoAnswer')
                    : t('markers.stoppedNoAnswer')}
            </Marker>
          ) : (
            <Marker testId="sharpen-completed">{t('markers.completed')}</Marker>
          )}
          {session.endReason !== 'nothing_to_ask' && !conversationScope ? (
            <SharpenSummary session={session} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
