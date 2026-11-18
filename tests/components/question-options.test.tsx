// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PauseThread, PlannerQuestionTurn } from '@/components/planning/RunPause';
import {
  QuestionOptionList,
  QuestionOptionReplies,
  pickerOptionsOf,
} from '@/components/planning/QuestionOptionPicker';
import type { PlanChangeRunPauseDto } from '@/lib/dto/planChange';

// A QUESTION'S OPTIONS, DRAWN (MOTIR-11700): the picker Grill me draws its readings
// with, now drawn for the planner's mid-run question too — the options in the bubble,
// one button per option under it, and the own-words button. A click is one act.

afterEach(() => cleanup());

const OPTIONS = [
  { id: 'o1', label: 'Profile settings', means: 'The change is to the profile page.' },
  { id: 'o2', label: 'Billing settings', means: 'The change is to the billing page.' },
];

function unclear(over: Partial<PlanChangeRunPauseDto> = {}): PlanChangeRunPauseDto {
  return {
    id: 'pause-1',
    jobId: 'run-1',
    kind: 'unclear',
    changeTurnIds: ['e1'],
    reason: null,
    question: 'Which settings page do you mean?',
    options: OPTIONS,
    createdAt: '2026-11-18T09:00:00.000Z',
    answer: null,
    answeredAt: null,
    replyText: null,
    delivery: 'pending',
    refusedCode: null,
    mailboxEntryId: null,
    ...over,
  };
}

describe('the shared picker', () => {
  it('lists each option with what it means, and badges the recommended one', () => {
    renderWithIntl(
      <QuestionOptionList
        testId="list"
        recommendedLabel="recommended"
        options={[
          { id: 'a', label: 'A', detail: 'means a', recommended: true },
          { id: 'b', label: 'B' },
        ]}
      />,
    );
    const list = screen.getByTestId('list');
    expect(list.textContent).toContain('A — means a');
    expect(list.textContent).toContain('recommended');
    expect(list.textContent).toContain('B');
  });

  it('one button per option, the own-words button, and more replies after it', () => {
    const onPick = vi.fn();
    const onOwnWords = vi.fn();
    renderWithIntl(
      <QuestionOptionReplies
        testId="replies"
        options={pickerOptionsOf(OPTIONS)}
        disabled={false}
        onPick={onPick}
        optionTestId={(id) => `opt-${id}`}
        groupLabel="Answer options"
        ownWordsLabel="In my own words"
        ownWordsTestId="own"
        onOwnWords={onOwnWords}
      >
        <span data-testid="extra" />
      </QuestionOptionReplies>,
    );
    expect(screen.getByRole('group', { name: 'Answer options' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('opt-o2'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o2', label: 'Billing settings' }),
    );
    fireEvent.click(screen.getByTestId('own'));
    expect(onOwnWords).toHaveBeenCalledOnce();
    expect(screen.getByTestId('extra')).toBeTruthy();
  });

  it('waits while an answer is in flight', () => {
    renderWithIntl(
      <QuestionOptionReplies
        options={pickerOptionsOf(OPTIONS)}
        disabled
        onPick={vi.fn()}
        optionTestId={(id) => `opt-${id}`}
        ownWordsLabel="own"
        ownWordsTestId="own"
        onOwnWords={vi.fn()}
      />,
    );
    expect((screen.getByTestId('opt-o1') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('own') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the planner’s mid-run question draws its options', () => {
  it('lists them in the bubble and offers them as replies while the question is open', () => {
    const onPick = vi.fn();
    const onOwnWords = vi.fn();
    renderWithIntl(
      <PlannerQuestionTurn
        pause={unclear()}
        resumed={false}
        questionPick={{ onPick, onOwnWords }}
      />,
    );
    const bubble = screen.getByTestId('plan-change-question');
    expect(within(bubble).getByTestId('plan-change-question-options').textContent).toContain(
      'Profile settings — The change is to the profile page.',
    );
    fireEvent.click(screen.getByTestId('plan-change-question-option-o1'));
    expect(onPick).toHaveBeenCalledWith({ id: 'o1', label: 'Profile settings' });
    fireEvent.click(screen.getByTestId('plan-change-question-own-words'));
    expect(onOwnWords).toHaveBeenCalledOnce();
  });

  it('keeps the list but offers no replies once answered, or with no host to take a pick', () => {
    const { rerender } = renderWithIntl(
      <PlannerQuestionTurn
        pause={unclear({ answer: 'replied', replyText: 'Profile settings' })}
        resumed
        questionPick={{ onPick: vi.fn(), onOwnWords: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('plan-change-question-options')).toBeTruthy();
    expect(screen.queryByTestId('plan-change-question-replies')).toBeNull();
    rerender(<PlannerQuestionTurn pause={unclear()} resumed={false} />);
    expect(screen.queryByTestId('plan-change-question-replies')).toBeNull();
  });

  it('a question from an engine that sent no options is drawn as before', () => {
    renderWithIntl(<PlannerQuestionTurn pause={unclear({ options: null })} resumed={false} />);
    expect(screen.queryByTestId('plan-change-question-options')).toBeNull();
  });

  it('PauseThread hands the pick through to the open question', () => {
    const onPick = vi.fn();
    renderWithIntl(
      <PauseThread
        pause={unclear()}
        pending={false}
        onAnswer={vi.fn()}
        replyEntry={null}
        refusalCode={null}
        questionPick={{ onPick, onOwnWords: vi.fn() }}
      />,
    );
    fireEvent.click(screen.getByTestId('plan-change-question-option-o2'));
    expect(onPick).toHaveBeenCalledWith({ id: 'o2', label: 'Billing settings' });
  });
});
