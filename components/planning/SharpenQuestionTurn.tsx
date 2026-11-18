'use client';

import { useTranslations } from 'next-intl';
import { Code, GitBranch, Square } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Bubble } from '@/components/planning/PlanChangeRail';
import {
  QuestionOptionList,
  QuestionOptionReplies,
} from '@/components/planning/QuestionOptionPicker';
import type { SharpenAction, SharpenQuestion } from '@/lib/ai/types';

// THE GRILLING QUESTION ON THE RAIL'S OWN QUESTION SURFACE (Task MOTIR-1101 ·
// Subtasks MOTIR-8447 / MOTIR-8177; design G3, panels 3–6).
//
// One question, drawn as the conversation phase already draws a planner
// question — `Bubble tone="asking"`, carrying the rail's pending-question anchor —
// then the reply row: one button per reading (the recommended one `primary`, its
// accessible name ending "(recommended)"), and Something else… · Skip · You
// decide · Stop grilling. The list and the reply row are `QuestionOptionPicker`'s
// (MOTIR-11700), which every question Motir puts to a person draws its options with. Every act is ONE act; all of them are disabled while one
// is in flight, except Stop grilling, which is always reachable.

export interface SharpenQuestionTurnProps {
  question: SharpenQuestion;
  /** 1-based — "asking · question N". */
  number: number;
  /** A turn's job is in flight. */
  pending: boolean;
  anchorId?: string;
  onAct: (action: Exclude<SharpenAction, 'start' | 'stop'>, opts?: { readingId?: string }) => void;
  onStop: () => void;
  /** Something else… — focus the composer for an own-words answer. */
  onSomethingElse: () => void;
}

export function SharpenQuestionTurn({
  question,
  number,
  pending,
  anchorId,
  onAct,
  onStop,
  onSomethingElse,
}: SharpenQuestionTurnProps) {
  const t = useTranslations('sharpen.question');

  return (
    <div className="flex flex-col gap-2" data-testid="sharpen-question">
      <Bubble
        role="assistant"
        tone="asking"
        label={t('label', { n: number })}
        {...(anchorId ? { anchorId } : {})}
      >
        {question.because ? (
          <p className="mb-1 flex items-center gap-1 text-xs text-(--el-text-secondary)">
            <GitBranch className="size-3.5" aria-hidden />
            {t('because', { answer: question.because })}
          </p>
        ) : null}
        {question.topic === 'technical_thread' ? (
          <p className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-(--el-text-secondary)">
            <span className="inline-flex items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) font-semibold text-(--el-text-strong)">
              <Code className="size-3" aria-hidden />
              {t('yourThread')}
            </span>
            {question.quote ? <span>{t('youSaid', { words: question.quote })}</span> : null}
          </p>
        ) : null}
        <p className="text-(--el-text)">{question.text}</p>
        <QuestionOptionList options={question.readings} recommendedLabel={t('recommended')} />
      </Bubble>
      <QuestionOptionReplies
        testId="sharpen-replies"
        options={question.readings}
        disabled={pending}
        onPick={(reading) => onAct('answer', { readingId: reading.id })}
        optionTestId={(id) => `sharpen-reading-${id}`}
        accessibleName={(reading) =>
          reading.recommended ? t('recommendedName', { label: reading.label }) : reading.label
        }
        ownWordsLabel={t('somethingElse')}
        ownWordsTestId="sharpen-something-else"
        onOwnWords={onSomethingElse}
      >
        <Button
          variant="ghost"
          size="sm"
          data-testid="sharpen-skip"
          disabled={pending}
          onClick={() => onAct('skip')}
        >
          {t('skip')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="sharpen-you-decide"
          disabled={pending}
          onClick={() => onAct('you_decide')}
        >
          {t('youDecide')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="sharpen-stop"
          leftIcon={<Square className="size-4" aria-hidden />}
          onClick={onStop}
        >
          {t('stop')}
        </Button>
      </QuestionOptionReplies>
    </div>
  );
}
