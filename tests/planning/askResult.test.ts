import { describe, expect, it } from 'vitest';
import {
  ASK_ANSWER_MAX_CHARS,
  ASK_MAX_CITATIONS,
  ASK_REQUIREMENT_MAX_ASSUMPTIONS,
  readAskOutcome,
  type AskPlanOffer,
} from '@/lib/planning/askResult';

// The consuming half of MOTIR-1817's boundary contract (MOTIR-1819) — reading an
// `ask_project` result. A boundary parser, so what it is worth testing is every
// way the far side can be wrong: an older engine that carries no `ask` unit, a
// malformed one, an unbounded body, a fabricated citation shape.

describe('readAskOutcome — what it refuses to read', () => {
  it('yields null when there is no `ask` unit at all', () => {
    // An older engine, a different job kind, or a job that failed before it
    // produced one. Distinct from a job that RAN and had nothing to say.
    for (const raw of [null, undefined, 42, 'text', [], {}, { ask: null }, { ask: 'nope' }]) {
      expect(readAskOutcome(raw)).toBeNull();
    }
  });

  it('reads an ANSWER with its citations', () => {
    expect(
      readAskOutcome({
        ask: { intent: 'ask', answer: '  ABC-1 is blocked.  ', citations: ['ABC-1'] },
      }),
    ).toEqual({ intent: 'ask', answer: 'ABC-1 is blocked.', citations: ['ABC-1'] });
  });

  it('reads the REDIRECT as carrying nothing, whatever else the field held', () => {
    // A producer that sent an answer beside a plan_change verdict is confused;
    // the safe read is the one that does not put stray prose on the thread.
    expect(
      readAskOutcome({ ask: { intent: 'plan_change', answer: 'ignore me', citations: ['ABC-1'] } }),
    ).toEqual({ intent: 'plan_change', answer: null, citations: [] });
  });

  // MOTIR-7047 — the ADR's AMENDMENT 1: a third verdict, `debug`, redirected the
  // same way, echoing the turn's anchor so core can forward it to `debug_bug`.
  it('reads the DEBUG redirect as carrying nothing but a key-shaped anchor', () => {
    expect(
      readAskOutcome({
        ask: { intent: 'debug', answer: 'stray', citations: ['ABC-1'], anchorKey: 'ABC-7' },
      }),
    ).toEqual({ intent: 'debug', answer: null, citations: [], anchorKey: 'ABC-7' });
    // No anchor on the turn → null, never absent-and-guessed.
    expect(readAskOutcome({ ask: { intent: 'debug', answer: null, citations: [] } })).toEqual({
      intent: 'debug',
      answer: null,
      citations: [],
      anchorKey: null,
    });
  });

  it('drops an echoed anchor that is not EXACTLY a key — it never trims one into shape', () => {
    for (const anchorKey of [' ABC-7', 'ABC-7 and more', 'abc-7', 'ABC', 7, {}, ['ABC-7'], '']) {
      expect(readAskOutcome({ ask: { intent: 'debug', anchorKey } })).toEqual({
        intent: 'debug',
        answer: null,
        citations: [],
        anchorKey: null,
      });
    }
  });

  it('never reads an anchor off an `ask` or `plan_change` verdict', () => {
    expect(readAskOutcome({ ask: { intent: 'ask', answer: 'hi', anchorKey: 'ABC-7' } })).toEqual({
      intent: 'ask',
      answer: 'hi',
      citations: [],
    });
    expect(readAskOutcome({ ask: { intent: 'plan_change', anchorKey: 'ABC-7' } })).toEqual({
      intent: 'plan_change',
      answer: null,
      citations: [],
    });
  });

  it('DEFAULTS an unrecognised intent to `ask` — never to a plan change', () => {
    // The expensive half of the asymmetry: an unparseable envelope must not turn
    // into a plan-edit job the person never asked for.
    expect(readAskOutcome({ ask: { intent: 'wat', answer: 'hi' } })).toEqual({
      intent: 'ask',
      answer: 'hi',
      citations: [],
    });
    expect(readAskOutcome({ ask: {} })).toEqual({ intent: 'ask', answer: null, citations: [] });
  });

  it('treats an empty or non-string answer as nothing said', () => {
    expect(readAskOutcome({ ask: { intent: 'ask', answer: '   ' } })?.answer).toBeNull();
    expect(readAskOutcome({ ask: { intent: 'ask', answer: 7 } })?.answer).toBeNull();
  });

  it('BOUNDS the answer — a runaway generation cannot write an unbounded row', () => {
    const long = 'x'.repeat(ASK_ANSWER_MAX_CHARS + 500);
    const answer = readAskOutcome({ ask: { intent: 'ask', answer: long } })!.answer!;
    expect(answer.length).toBe(ASK_ANSWER_MAX_CHARS);
    expect(answer.endsWith('…')).toBe(true);
  });
});

describe('readAskOutcome — the citations', () => {
  it('drops anything that is not key-shaped, and de-duplicates', () => {
    const out = readAskOutcome({
      ask: {
        intent: 'ask',
        citations: ['ABC-1', 'ABC-1', 'not a key', '', 42, null, 'see ABC-2 here', 'ABC-2'],
      },
    });
    // `see ABC-2 here` CONTAINS a key and is not one — the pattern is anchored.
    expect(out!.citations).toEqual(['ABC-1', 'ABC-2']);
  });

  it('is empty when the field is missing or not an array', () => {
    expect(readAskOutcome({ ask: { intent: 'ask', citations: 'ABC-1' } })!.citations).toEqual([]);
    expect(readAskOutcome({ ask: { intent: 'ask' } })!.citations).toEqual([]);
  });

  it('BOUNDS the count — an answer resting on forty items is not one a person can check', () => {
    const many = Array.from({ length: ASK_MAX_CITATIONS + 10 }, (_, i) => `ABC-${i + 1}`);
    expect(readAskOutcome({ ask: { intent: 'ask', citations: many } })!.citations).toHaveLength(
      ASK_MAX_CITATIONS,
    );
  });
});

// RUN MODE (MOTIR-7996) — the three fields `ask_project` adds when a turn's
// `context.run` is present: `forward`, `offerForward` and `run`.
describe('readAskOutcome — run mode', () => {
  it('reads a forward on a plan_change, bounded', () => {
    const out = readAskOutcome({
      ask: { intent: 'plan_change', forward: { text: '  move checkout  ' } },
    });
    expect(out).toMatchObject({ intent: 'plan_change', forward: { text: 'move checkout' } });

    const long = readAskOutcome({
      ask: { intent: 'plan_change', forward: { text: 'x'.repeat(ASK_ANSWER_MAX_CHARS + 50) } },
    });
    expect(long!.forward!.text.length).toBeLessThanOrEqual(ASK_ANSWER_MAX_CHARS);
  });

  it.each([
    ['a string', 'move checkout'],
    ['an array', ['move checkout']],
    ['a blank text', { text: '   ' }],
    ['a non-string text', { text: 7 }],
    ['null', null],
  ])('reads a malformed forward (%s) as null without changing the intent', (_name, forward) => {
    const out = readAskOutcome({ ask: { intent: 'plan_change', forward } });
    expect(out).toMatchObject({
      intent: 'plan_change',
      answer: null,
      citations: [],
      forward: null,
    });
  });

  it('keeps a legacy plan_change (no forward key) in its exact old shape', () => {
    expect(readAskOutcome({ ask: { intent: 'plan_change' } })).toEqual({
      intent: 'plan_change',
      answer: null,
      citations: [],
    });
  });

  it('reads an offerForward on an ask, bounded, and null when malformed', () => {
    expect(
      readAskOutcome({
        ask: { intent: 'ask', answer: 'Forward it?', offerForward: { text: 'x' } },
      }),
    ).toMatchObject({ intent: 'ask', offerForward: { text: 'x' } });
    expect(
      readAskOutcome({ ask: { intent: 'ask', answer: 'a', offerForward: 'x' } })!.offerForward,
    ).toBeNull();
    expect(
      readAskOutcome({
        ask: {
          intent: 'ask',
          answer: 'a',
          offerForward: { text: 'y'.repeat(ASK_ANSWER_MAX_CHARS * 2) },
        },
      })!.offerForward!.text.length,
    ).toBeLessThanOrEqual(ASK_ANSWER_MAX_CHARS);
  });

  it('reads the run echo, and null for a malformed one', () => {
    expect(
      readAskOutcome({
        ask: { intent: 'ask', answer: 'a', run: { readable: false, reason: 'PLAN_NOT_FOUND' } },
      })!.run,
    ).toEqual({ readable: false, reason: 'PLAN_NOT_FOUND' });
    expect(
      readAskOutcome({ ask: { intent: 'ask', answer: 'a', run: { readable: true } } })!.run,
    ).toEqual({ readable: true, reason: null });
    const malformed = readAskOutcome({
      ask: { intent: 'ask', answer: 'a', run: { readable: 'yes' } },
    });
    expect(malformed!.run ?? null).toBeNull();
    expect(malformed!.intent).toBe('ask');
  });

  it('never reads a malformed run-mode result as a plan change', () => {
    expect(
      readAskOutcome({ ask: { forward: { text: 'x' }, offerForward: { text: 'y' } } }),
    ).toMatchObject({
      intent: 'ask',
    });
  });
});

describe('readAskOutcome — the plan offer’s composed requirement (MOTIR-9432)', () => {
  const COMPOSED = {
    outcome: '  A person plans a small feature from the overlay.  ',
    behaviour: 'Offer shows the requirement before Confirm.',
    scopeEdge: '',
    constraints: '',
    acceptance: 'The pane shows six headings.',
    assumptions: [{ id: 'r1', text: ' The pane replaces the canvas. ' }, 'A bare string stays.'],
  };
  const offerOf = (requirement: unknown) =>
    readAskOutcome({
      ask: {
        intent: 'ask',
        answer: 'Shall I plan it?',
        offer: { kind: 'plan', requestText: 'Plan the pane.', targetKey: null, requirement },
      },
    })!.offer as AskPlanOffer;

  it('reads the six parts, trimmed, keeping an empty scopeEdge and constraints empty', () => {
    expect(offerOf(COMPOSED).requirement).toEqual({
      outcome: 'A person plans a small feature from the overlay.',
      behaviour: 'Offer shows the requirement before Confirm.',
      scopeEdge: '',
      constraints: '',
      acceptance: 'The pane shows six headings.',
      assumptions: [{ id: 'r1', text: 'The pane replaces the canvas.' }, 'A bare string stays.'],
    });
  });

  it('BOUNDS every string part, every assumption text and the assumption count', () => {
    const long = 'y'.repeat(ASK_ANSWER_MAX_CHARS * 2);
    const read = offerOf({
      ...COMPOSED,
      outcome: long,
      assumptions: [
        ...Array.from({ length: ASK_REQUIREMENT_MAX_ASSUMPTIONS + 5 }, (_, i) => ({
          id: `r${i}`,
          text: i === 0 ? long : 'short',
        })),
      ],
    }).requirement!;
    expect(read.outcome!.length).toBeLessThanOrEqual(ASK_ANSWER_MAX_CHARS);
    expect(read.outcome!.endsWith('…')).toBe(true);
    const assumptions = read.assumptions as { id?: string; text: string }[];
    expect(assumptions).toHaveLength(ASK_REQUIREMENT_MAX_ASSUMPTIONS);
    expect(assumptions[0]!.text.length).toBeLessThanOrEqual(ASK_ANSWER_MAX_CHARS);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'outcome'],
    ['an array', [COMPOSED]],
    ['an object with none of the six parts', { note: 'x' }],
  ])('reads the offer WITHOUT a requirement key when it is %s', (_label, value) => {
    const offer = offerOf(value);
    expect(offer).toMatchObject({ kind: 'plan', requestMd: 'Plan the pane.', targetKey: null });
    expect('requirement' in offer).toBe(false);
  });
});
