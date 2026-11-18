'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircleQuestionMark, Pause } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Bubble } from '@/components/planning/PlanChangeRail';
import { ForwardedMarks, QueuedLabel } from '@/components/planning/MidRunTurn';
import {
  QuestionOptionList,
  QuestionOptionReplies,
  pickerOptionsOf,
} from '@/components/planning/QuestionOptionPicker';
import type { PlanChangeRunPauseDto } from '@/lib/dto/planChange';
import type { QueuedTurn } from '@/lib/hooks/usePlanChangeConversation';

// THE PLANNER'S MID-RUN PAUSE, drawn (Story MOTIR-7990 · MOTIR-8010; design
// `plan-change-run-live--answer-or-forward.mock.html`, states 6–9 and the
// distinctness strip). Two kinds, one speaker treatment: the shipped ASKING
// bubble — the planner asking the person — which the answering session never
// uses. The planner's `reason` and `question` are MODEL output and are drawn as
// plain text, never as Markdown. An `unclear` question's options (MOTIR-11700) are
// drawn with `QuestionOptionPicker`, the same list and replies Grill me draws.

const NS = 'planningWorkspace.conversation';
export type PauseChoice = 'start_over' | 'apply';

/** Picking one of an `unclear` question's options, or turning to the composer (MOTIR-11700). */
export interface QuestionPick {
  onPick: (option: { id: string; label: string }) => void;
  onOwnWords: () => void;
}

// A `code_unsearchable` pause (MOTIR-9170) is drawn by `CodeUnsearchableBanner`, not by this
// file's turns: its one control is the banner's own *Check again and continue*.

/** The asking bubble, with its label slot filled by the glyph and the word. */
function PlannerBubble({ testId, children }: { testId: string; children: ReactNode }) {
  const tc = useTranslations(NS);
  return (
    <Bubble
      role="assistant"
      tone="asking"
      testId={testId}
      label={
        <>
          <MessageCircleQuestionMark className="size-3" aria-hidden="true" />
          {tc('asking')}
        </>
      }
    >
      {children}
    </Bubble>
  );
}

/**
 * State 6 — the planner offers START OVER after a change it ruled a re-plan: its
 * reason, one sentence on what each choice does, and exactly two controls. Once
 * the pause is answered the controls are gone and only the bubble stays (the
 * record under it is {@link PauseRecord}).
 */
export function ReplanOfferTurn({
  pause,
  pending,
  onAnswer,
}: {
  pause: PlanChangeRunPauseDto;
  pending: boolean;
  onAnswer: (choice: PauseChoice) => void;
}) {
  const tp = useTranslations(`${NS}.midRun.pause`);
  return (
    <PlannerBubble testId="planner-start-over-turn">
      {pause.reason ? <span className="block">{pause.reason}</span> : null}
      <span className="mt-1.5 block">{tp('offerHow')}</span>
      {pause.answer === null ? (
        <span
          role="group"
          aria-label={tp('groupLabel')}
          className="mt-2 flex flex-wrap gap-2"
          data-testid="planner-start-over-offer"
        >
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() => onAnswer('start_over')}
            data-testid="planner-start-over-yes"
          >
            {tp('startOver')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => onAnswer('apply')}
            data-testid="planner-start-over-keep"
          >
            {tp('keepGoing')}
          </Button>
        </span>
      ) : null}
    </PlannerBubble>
  );
}

/**
 * State 9 — the planner steps back to ask what a change meant. The same asking
 * treatment as the offer, NO controls (the answer is typed). Once answered it is
 * a RECORD, never a pending prompt: its line says the reply is queued, then that
 * planning resumed once the run has read it.
 */
export function PlannerQuestionTurn({
  pause,
  resumed,
  pending = false,
  questionPick,
}: {
  pause: PlanChangeRunPauseDto;
  resumed: boolean;
  /** An answer is in flight. */
  pending?: boolean;
  /** The question's options as replies while it is open (MOTIR-11700). */
  questionPick?: QuestionPick;
}) {
  const tc = useTranslations(NS);
  const tp = useTranslations(`${NS}.midRun.pause`);
  const options = pause.options ? pickerOptionsOf(pause.options) : null;
  return (
    <>
      <PlannerBubble testId="plan-change-question">
        <span className="block">{pause.question}</span>
        {options ? (
          <QuestionOptionList options={options} testId="plan-change-question-options" />
        ) : null}
        <span className="mt-1.5 block">{tp('unclearNote')}</span>
      </PlannerBubble>
      {options && questionPick && pause.answer === null ? (
        <QuestionOptionReplies
          testId="plan-change-question-replies"
          options={options}
          disabled={pending}
          onPick={(option) => questionPick.onPick({ id: option.id, label: option.label })}
          optionTestId={(id) => `plan-change-question-option-${id}`}
          groupLabel={tc('questionOptions.group')}
          ownWordsLabel={tc('questionOptions.ownWords')}
          ownWordsTestId="plan-change-question-own-words"
          onOwnWords={questionPick.onOwnWords}
        />
      ) : null}
      {pause.answer !== null ? (
        <p
          className="text-center text-xs text-(--el-text-secondary)"
          data-testid="planner-question-record"
        >
          {resumed ? tc('answeredMarker') : tp('answeredQueued')}
        </p>
      ) : null}
    </>
  );
}

/**
 * State 9b — the person's reply, directly under the question it answers, going
 * forwarded → queued → read with state 4's marks and NO acknowledgement. The
 * entry is the one held for the pause's mailbox entry id; with none held yet it
 * reads queued from the pause's own `delivery`.
 */
export function PauseReply({
  pause,
  entry,
}: {
  pause: PlanChangeRunPauseDto;
  entry: QueuedTurn | null;
}) {
  const shown =
    entry ??
    (pause.delivery === 'delivered'
      ? {
          id: pause.mailboxEntryId ?? '',
          text: pause.replyText ?? '',
          read: pause.entryRead === true,
        }
      : null);
  return (
    <div className="flex flex-col gap-1" data-testid="planner-pause-reply">
      <Bubble role="user" {...(shown ? { label: <QueuedLabel read={shown.read} /> } : {})}>
        {pause.replyText}
      </Bubble>
      <ForwardedMarks entry={shown} acknowledge={false} />
    </div>
  );
}

/**
 * State 8 — what an answered pause leaves behind. For a re-plan: the choice, and
 * after *keep going* the planner's own line. For a refused answer (the run ended
 * first) a quiet reason line, under a re-plan record and a replied question alike:
 * never an alert, never rose.
 */
export function PauseRecord({
  pause,
  refusalCode,
}: {
  pause: PlanChangeRunPauseDto;
  refusalCode: string | null;
}) {
  const tp = useTranslations(`${NS}.midRun.pause`);
  const line = 'text-center text-xs text-(--el-text-secondary)';
  return (
    <>
      {pause.kind === 'replan' && pause.answer === 'start_over' ? (
        <p className={line} data-testid="planner-start-over-record">
          {tp('chosenStartOver')}
        </p>
      ) : null}
      {pause.kind === 'replan' && pause.answer === 'apply' ? (
        <>
          <p className={line} data-testid="planner-start-over-record">
            {tp('chosenKeepGoing')}
          </p>
          <p className={line} data-testid="planner-start-over-applying">
            {tp('applying')}
          </p>
        </>
      ) : null}
      {refusalCode !== null ? (
        <p className={line} data-testid="planner-pause-refusal" data-code={refusalCode}>
          {tp(
            refusalCode === 'PLAN_CHANGE_JOB_NOT_RUNNING'
              ? `refusal.${refusalCode}`
              : 'refusal.generic',
          )}
        </p>
      ) : null}
    </>
  );
}

/**
 * States 7 and 9a's bar — the running bar paused: a static `pause` glyph in place
 * of the spinner, a dashed frame and the word *paused*. Three non-colour channels
 * and no warning or danger tint: a pause is waiting, not failing. `finishing` is
 * 7a (work items still being written), otherwise 7b. Its wording names the offer
 * for a re-plan and the person's answer for a question; `stop` is the pinned bar's
 * own Stop, passed in so it stays reachable and is built once.
 */
export function PausedRunIndicator({
  kind,
  finishing,
  stop,
}: {
  kind: PlanChangeRunPauseDto['kind'];
  finishing: boolean;
  stop: ReactNode;
}) {
  const tc = useTranslations(NS);
  const tp = useTranslations(`${NS}.midRun.pause`);
  const replan = kind === 'replan';
  const line = replan
    ? finishing
      ? tp('finishingChoice')
      : tp('waitingChoice')
    : kind === 'code_unsearchable'
      ? tp('waitingResume')
      : finishing
        ? tp('finishingAnswer')
        : tc('awaitingAnswer');
  return (
    <div
      data-testid="plan-change-running-bar"
      data-paused="true"
      className="mb-2 flex items-center gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <Pause className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span
          className="block font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase"
          data-testid="plan-change-paused-word"
        >
          {tp('pausedWord')}
        </span>
        <span
          className="block text-xs text-(--el-text-secondary)"
          data-testid="plan-change-paused-line"
        >
          {line}
        </span>
      </div>
      {stop}
    </div>
  );
}

/** The pause's whole block in the thread (a `replan` or `unclear` pause — the rail draws a
 *  `code_unsearchable` one with `CodeUnsearchableBanner` and never passes it here): the planner's turn for its kind, then
 *  its record, the reply and the reason line a refused answer leaves. */
export function PauseThread({
  pause,
  pending,
  onAnswer,
  replyEntry,
  refusalCode,
  questionPick,
}: {
  pause: PlanChangeRunPauseDto;
  pending: boolean;
  onAnswer: (choice: PauseChoice) => void;
  replyEntry: QueuedTurn | null;
  refusalCode: string | null;
  /** An `unclear` question's options as replies (MOTIR-11700). */
  questionPick?: QuestionPick;
}) {
  if (pause.kind === 'replan') {
    return (
      <>
        <ReplanOfferTurn pause={pause} pending={pending} onAnswer={onAnswer} />
        <PauseRecord pause={pause} refusalCode={refusalCode} />
      </>
    );
  }
  return (
    <>
      <PlannerQuestionTurn
        pause={pause}
        resumed={Boolean(replyEntry?.read) || pause.entryRead === true}
        pending={pending}
        {...(questionPick ? { questionPick } : {})}
      />
      {pause.answer === 'replied' ? <PauseReply pause={pause} entry={replyEntry} /> : null}
      <PauseRecord pause={pause} refusalCode={refusalCode} />
    </>
  );
}
