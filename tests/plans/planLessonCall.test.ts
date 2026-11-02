import { describe, expect, it } from 'vitest';
import {
  PLAN_LESSON_CALL_BATCH_MAX,
  PLAN_LESSON_CALL_IDS_MAX,
  PlanLessonCallRefusal,
  parsePlanLessonCall,
  parsePlanLessonCalls,
} from '@/lib/plans/planLessonCall';

// MOTIR-10191 — the one parser every stored lesson call goes through: ids only,
// a shape per kind, every string capped. Pure, so it is proven here without a DB.

const ID = 'cstr77ecwfcozfr3frq8l7pxl';

describe('parsePlanLessonCall — one call per kind', () => {
  it('reads a search with its filters and its ranked ids', () => {
    expect(
      parsePlanLessonCall({
        kind: 'search',
        query: '  wiring an edge\nthe wrong way ',
        filters: { kinds: ['story'], types: ['code'], phases: ['lay'], subject: ' mcp ', limit: 8 },
        lessonIds: [ID, 'clx.shared:1'],
        outcome: 'matched',
      }),
    ).toEqual({
      kind: 'search',
      query: 'wiring an edge the wrong way',
      filters: { kinds: ['story'], types: ['code'], phases: ['lay'], subject: 'mcp', limit: 8 },
      lessonIds: [ID, 'clx.shared:1'],
      lessonId: null,
      occurrenceRef: null,
      outcome: 'matched',
      counted: null,
      detail: null,
    });
  });

  it('leaves an absent or empty axis out of the filters', () => {
    const call = parsePlanLessonCall({
      kind: 'search',
      query: 'q',
      filters: { kinds: [], phases: null, subject: '  ' },
      outcome: 'nothing-matched',
    });
    expect(call.filters).toEqual({});
    expect(call.lessonIds).toEqual([]);
  });

  it('reads a reinforce and an add with their lesson, ref and count', () => {
    expect(
      parsePlanLessonCall({
        kind: 'reinforce',
        lessonId: ID,
        occurrenceRef: 'plan:p#lay-1',
        outcome: 'already_counted',
        counted: false,
      }),
    ).toMatchObject({ kind: 'reinforce', lessonId: ID, counted: false, lessonIds: [] });
    expect(
      parsePlanLessonCall({ kind: 'add', outcome: 'error', detail: 'near-duplicate of ' + ID }),
    ).toMatchObject({
      kind: 'add',
      lessonId: null,
      counted: null,
      detail: `near-duplicate of ${ID}`,
    });
  });

  it('reads an injection as its ordered ids', () => {
    expect(
      parsePlanLessonCall({ kind: 'injected', lessonIds: [ID], outcome: 'injected' }),
    ).toMatchObject({ kind: 'injected', lessonIds: [ID] });
  });

  it.each([
    ['not an object', 'search'],
    ['an array', []],
    ['an unknown kind', { kind: 'browse', outcome: 'ok' }],
    ['no outcome', { kind: 'search' }],
    ['an outcome that is a sentence', { kind: 'search', outcome: 'It matched.' }],
    ['a lesson title', { kind: 'search', outcome: 'matched', title: 'Audit edges' }],
    ['a lesson body', { kind: 'add', outcome: 'added', body: 'x' }],
    ['a howToApply', { kind: 'reinforce', outcome: 'counted', howToApply: 'x' }],
    ['a query that is not a string', { kind: 'search', query: 3, outcome: 'matched' }],
    ['lessonIds that is not an array', { kind: 'search', lessonIds: ID, outcome: 'matched' }],
    [
      'too many lessonIds',
      {
        kind: 'search',
        lessonIds: Array(PLAN_LESSON_CALL_IDS_MAX + 1).fill(ID),
        outcome: 'matched',
      },
    ],
    ['a lesson id with spaces', { kind: 'search', lessonIds: ['a b'], outcome: 'matched' }],
    ['a lessonId that is not a string', { kind: 'reinforce', lessonId: 7, outcome: 'counted' }],
    [
      'counted that is not a boolean',
      { kind: 'reinforce', lessonId: ID, counted: 'yes', outcome: 'counted' },
    ],
    ['filters that are not an object', { kind: 'search', filters: ['story'], outcome: 'matched' }],
    [
      'an axis that is not an array',
      { kind: 'search', filters: { kinds: 'story' }, outcome: 'matched' },
    ],
    [
      'an axis value that is not a word',
      { kind: 'search', filters: { kinds: ['A B'] }, outcome: 'matched' },
    ],
    [
      'too many axis values',
      { kind: 'search', filters: { kinds: Array(21).fill('story') }, outcome: 'matched' },
    ],
    ['a zero limit', { kind: 'search', filters: { limit: 0 }, outcome: 'matched' }],
    ['a search naming a lessonId', { kind: 'search', lessonId: ID, outcome: 'matched' }],
    ['an injection with a count', { kind: 'injected', counted: true, outcome: 'injected' }],
    ['a reinforce with lessonIds', { kind: 'reinforce', lessonIds: [ID], outcome: 'counted' }],
    ['an add with filters', { kind: 'add', filters: { kinds: ['story'] }, outcome: 'added' }],
  ])('refuses %s', (_label, raw) => {
    expect(() => parsePlanLessonCall(raw)).toThrow(PlanLessonCallRefusal);
  });

  it('names the field it refused', () => {
    expect(() =>
      parsePlanLessonCalls([
        { kind: 'search', outcome: 'matched' },
        { kind: 'add', outcome: '' },
      ]),
    ).toThrow(/lessonCalls\[1\]\.outcome/);
  });

  it('caps every string', () => {
    const call = parsePlanLessonCall({
      kind: 'reinforce',
      lessonId: ID,
      occurrenceRef: 'r'.repeat(400),
      outcome: 'counted',
      detail: 'd'.repeat(400),
    });
    expect(Array.from(call.occurrenceRef!)).toHaveLength(300);
    expect(Array.from(call.detail!)).toHaveLength(200);
  });
});

describe('parsePlanLessonCalls — the batch', () => {
  it('accepts an EMPTY batch: the session was recorded with no call', () => {
    expect(parsePlanLessonCalls([])).toEqual([]);
  });

  it('refuses a batch that is not an array, or one over the cap', () => {
    expect(() => parsePlanLessonCalls(undefined)).toThrow(PlanLessonCallRefusal);
    const one = { kind: 'injected', lessonIds: [ID], outcome: 'injected' };
    expect(parsePlanLessonCalls(Array(PLAN_LESSON_CALL_BATCH_MAX).fill(one))).toHaveLength(
      PLAN_LESSON_CALL_BATCH_MAX,
    );
    expect(() => parsePlanLessonCalls(Array(PLAN_LESSON_CALL_BATCH_MAX + 1).fill(one))).toThrow(
      /0 to 50 calls/,
    );
  });
});
