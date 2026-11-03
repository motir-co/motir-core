import { describe, expect, it } from 'vitest';
import { parseSharpenTurn, SHARPEN_CAPS } from '@/lib/ai/sharpenTurn';

// Task MOTIR-1101 · Subtask MOTIR-8181 — the core-side read of a `sharpen_turn`
// result. Untrusted model output: anything that is not a well-formed turn is
// `null`, never a guessed kind.

const reading = (id: string, recommended: boolean) => ({
  id,
  label: `Reading ${id}`,
  detail: '',
  recommended,
});
const question = {
  id: 'q1',
  text: 'Who exports invoices?',
  topic: 'workflow',
  because: null,
  quote: null,
  readings: [reading('a', true), reading('b', false)],
};
const base = { settled: [], assumptions: [], writeBack: null };

describe('parseSharpenTurn', () => {
  it('reads a question turn', () => {
    expect(parseSharpenTurn({ kind: 'question', question, ...base })).toEqual({
      kind: 'question',
      question,
      ...base,
    });
  });

  it.each(['nothing_to_ask', 'finished', 'stopped', 'unavailable'])('reads a %s turn', (kind) => {
    const parsed = parseSharpenTurn({
      kind,
      question: null,
      settled: [
        {
          questionId: 'q1',
          question: 'Q',
          answer: 'A',
          topic: 'non_happy',
          readingId: null,
          source: 'person',
        },
      ],
      assumptions: [
        { questionId: 'q2', question: 'Q2', recommendation: 'R', why: 'W', source: 'planner' },
      ],
      writeBack: { ok: false, error: 'refused' },
    });
    expect(parsed?.kind).toBe(kind);
    expect(parsed?.question).toBeNull();
    expect(parsed?.settled).toHaveLength(1);
    expect(parsed?.writeBack).toEqual({ ok: false, error: 'refused' });
  });

  it.each([
    ['not an object', 'nope'],
    ['an unknown kind', { kind: 'guess', ...base }],
    ['a question turn with no question', { kind: 'question', question: null, ...base }],
    [
      'one reading',
      { kind: 'question', question: { ...question, readings: [reading('a', true)] }, ...base },
    ],
    [
      'five readings',
      {
        kind: 'question',
        question: {
          ...question,
          readings: ['a', 'b', 'c', 'd', 'e'].map((id, i) => reading(id, i === 0)),
        },
        ...base,
      },
    ],
    [
      'no recommended reading',
      {
        kind: 'question',
        question: { ...question, readings: [reading('a', false), reading('b', false)] },
        ...base,
      },
    ],
    [
      'duplicate reading ids',
      {
        kind: 'question',
        question: { ...question, readings: [reading('a', true), reading('a', false)] },
        ...base,
      },
    ],
    ['an unknown topic', { kind: 'question', question: { ...question, topic: 'stack' }, ...base }],
    [
      'a branch near product_fit that is not in the closed set',
      { kind: 'question', question: { ...question, topic: 'naming' }, ...base },
    ],
    ['a malformed settled entry', { kind: 'finished', ...base, settled: [{ answer: 1 }] }],
    ['a malformed writeBack', { kind: 'finished', ...base, writeBack: { ok: 'yes' } }],
  ])('refuses %s', (_label, raw) => {
    expect(parseSharpenTurn(raw)).toBeNull();
  });

  // MOTIR-10254: naming, placement and connections are their own branch, so a
  // question on it and an answer settled on it both cross the boundary.
  it('reads a product_fit question and a product_fit settled answer', () => {
    const fit = { ...question, text: 'Where does the export appear?', topic: 'product_fit' };
    const settledFit = {
      questionId: 'q0',
      question: 'What is it called?',
      answer: 'Saved view',
      topic: 'product_fit',
      readingId: 'a',
      source: 'person',
    };
    const parsed = parseSharpenTurn({
      kind: 'question',
      question: fit,
      ...base,
      settled: [settledFit],
    });
    expect(parsed?.question?.topic).toBe('product_fit');
    expect(parsed?.settled).toEqual([settledFit]);
  });

  it('caps long strings', () => {
    const long = 'x'.repeat(SHARPEN_CAPS.text + 50);
    const parsed = parseSharpenTurn({
      kind: 'question',
      question: { ...question, text: long },
      ...base,
    });
    expect(parsed?.question?.text).toHaveLength(SHARPEN_CAPS.text);
  });
});

describe('parseSharpenTurn — the requirement a grilling wrote (MOTIR-10255)', () => {
  const written = {
    outcome: 'Finance shares presets.',
    behaviour: 'Save a preset.',
    scopeEdge: '',
    constraints: '',
    acceptance: 'A shared preset applies.',
    assumptions: [{ id: 'q2', text: 'Which formats? — CSV only' }, 'an older line'],
  };
  const ended = (requirement: unknown) =>
    parseSharpenTurn({ kind: 'finished', question: null, ...base, requirement });

  it('reads it with its offer turn, every part present', () => {
    expect(ended({ offerTurnId: 't1', requirement: written })?.requirement).toEqual({
      offerTurnId: 't1',
      requirement: written,
    });
  });

  it('fills an absent optional part as blank', () => {
    const { scopeEdge: _s, constraints: _c, ...rest } = written;
    expect(ended({ offerTurnId: 't1', requirement: rest })?.requirement?.requirement).toEqual(
      written,
    );
  });

  it('leaves the key off a turn with none, or with null', () => {
    expect(ended(undefined)).not.toHaveProperty('requirement');
    expect(ended(null)).not.toHaveProperty('requirement');
  });

  it('caps every part', () => {
    const long = 'x'.repeat(SHARPEN_CAPS.requirementPart + 10);
    const parsed = ended({
      offerTurnId: 't1',
      requirement: { ...written, outcome: long, assumptions: [long, { id: 'a', text: long }] },
    });
    expect(parsed?.requirement?.requirement.outcome).toHaveLength(SHARPEN_CAPS.requirementPart);
    expect(parsed?.requirement?.requirement.assumptions).toEqual([
      'x'.repeat(SHARPEN_CAPS.requirementPart),
      { id: 'a', text: 'x'.repeat(SHARPEN_CAPS.requirementPart) },
    ]);
  });

  it.each([
    ['a blank outcome', { offerTurnId: 't1', requirement: { ...written, outcome: ' ' } }],
    ['no acceptance', { offerTurnId: 't1', requirement: { ...written, acceptance: undefined } }],
    [
      'assumptions as one string',
      { offerTurnId: 't1', requirement: { ...written, assumptions: 'x' } },
    ],
    ['no assumptions', { offerTurnId: 't1', requirement: { ...written, assumptions: undefined } }],
    ['no offer turn', { requirement: written }],
    ['no requirement', { offerTurnId: 't1' }],
    ['not an object', 'requirement'],
  ])('refuses the whole turn on %s', (_label, requirement) => {
    expect(ended(requirement)).toBeNull();
  });
});
