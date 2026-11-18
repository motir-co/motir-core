import { describe, expect, it } from 'vitest';

import { readPlanningTurn } from '@/lib/planning/plannerTurn';
import {
  answerTextFor,
  askedTextFor,
  findQuestionOption,
  plannerReadTexts,
  questionOptionJson,
  readQuestionOption,
  readQuestionOptions,
  waitingQuestionOptions,
} from '@/lib/planning/questionOptions';

// A QUESTION PUT TO A PERSON CARRIES ITS OPTIONS AS DATA (MOTIR-11700) — the consuming
// half: read loosely off the AI boundary, resolved strictly when a click claims one, and
// read back to the planner as the option picked or as the person's own words.

const A = { id: 'o1', label: 'Direct blockers', means: 'Only items that block it directly.' };
const B = { id: 'o2', label: 'Every blocker', means: 'Blockers of blockers too.' };

describe('readQuestionOptions — loose, never throwing', () => {
  it('reads 2 to 4 well-formed options, trimmed', () => {
    expect(readQuestionOptions([{ ...A, label: '  Direct blockers ' }, B])).toEqual([A, B]);
  });

  it('reads anything else as none', () => {
    expect(readQuestionOptions(undefined)).toBeNull();
    expect(readQuestionOptions('o1')).toBeNull();
    expect(readQuestionOptions([A])).toBeNull();
    expect(readQuestionOptions([A, { id: 'o2', label: 'x' }])).toBeNull();
  });

  it('drops malformed entries and repeated ids, and keeps at most four', () => {
    const many = ['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => ({ id, label: id, means: 'm' }));
    expect(readQuestionOptions(many)?.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(readQuestionOptions([A, A, null, B])).toEqual([A, B]);
  });

  it('refuses an over-long field rather than truncating it', () => {
    expect(readQuestionOption({ ...A, label: 'x'.repeat(121) })).toBeNull();
    expect(readQuestionOption({ ...A, means: 'x'.repeat(401) })).toBeNull();
    expect(readQuestionOption({ ...A, id: 'x'.repeat(17) })).toBeNull();
    expect(readQuestionOption(['o1'])).toBeNull();
  });
});

describe('findQuestionOption and questionOptionJson', () => {
  it('finds the option an id names, and nothing else', () => {
    expect(findQuestionOption([A, B], 'o2')).toEqual(B);
    expect(findQuestionOption([A, B], 'o9')).toBeNull();
    expect(findQuestionOption(null, 'o1')).toBeNull();
    expect(findQuestionOption([A, B], null)).toBeNull();
  });

  it('copies exactly the three fields', () => {
    expect(questionOptionJson({ ...A, extra: 1 } as typeof A)).toEqual(A);
  });
});

describe('readPlanningTurn — the turn carries its options beside its question', () => {
  it('reads the options of a turn that asked', () => {
    const turn = readPlanningTurn({
      turn: { message: 'Findings.', question: 'Which blockers count?', options: [A, B] },
    });
    expect(turn).toEqual({
      message: 'Findings.',
      question: 'Which blockers count?',
      options: [A, B],
    });
  });

  it('reads options as none on a turn that did not ask, or from an older engine', () => {
    expect(
      readPlanningTurn({ turn: { message: 'm', question: null, options: [A, B] } })?.options,
    ).toBeNull();
    expect(readPlanningTurn({ turn: { message: 'm', question: 'q?' } })?.options).toBeNull();
  });
});

describe('the answer is read back as the option picked, or as own words', () => {
  const asked = {
    role: 'assistant',
    body: 'Which blockers count?',
    question: 'Which blockers count?',
    questionOptions: [A, B],
  };

  it('names the waiting question’s options, and nothing once a person spoke', () => {
    expect(waitingQuestionOptions([asked])).toEqual([A, B]);
    expect(waitingQuestionOptions([asked, { role: 'system', body: 'x' }])).toEqual([A, B]);
    expect(waitingQuestionOptions([asked, { role: 'user', body: 'x' }])).toBeNull();
    expect(waitingQuestionOptions([{ ...asked, question: null }])).toBeNull();
    expect(waitingQuestionOptions([])).toBeNull();
  });

  it('renders a pick with its meaning, own words as an instruction, anything else verbatim', () => {
    const texts = plannerReadTexts([
      { role: 'user', body: 'Plan the blocking view' },
      asked,
      { role: 'user', body: 'Every blocker', isAnswer: true, answerOption: B },
      asked,
      { role: 'user', body: 'only open ones', isAnswer: true, answerOption: null },
      {
        role: 'assistant',
        body: 'Asked without options',
        question: 'Which?',
        questionOptions: null,
      },
      { role: 'user', body: 'the first', isAnswer: true },
    ]);
    expect(texts[0]).toBe('Plan the blocking view');
    expect(texts[1]).toContain('The options I offered:');
    expect(texts[1]).toContain('Every blocker (o2) — Blockers of blockers too.');
    expect(texts[2]).toBe('I picked your option "Every blocker" (o2): Blockers of blockers too.');
    expect(texts[4]).toBe('In my own words, none of your options: only open ones');
    expect(texts[5]).toBe('Asked without options');
    expect(texts[6]).toBe('the first');
  });

  it('the two renderers on their own', () => {
    expect(answerTextFor({ body: 'x' })).toBe('x');
    expect(askedTextFor({ body: 'q', questionOptions: [] })).toBe('q');
  });
});
