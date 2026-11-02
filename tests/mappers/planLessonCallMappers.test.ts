import { describe, expect, it } from 'vitest';
import type { PlanLessonCall } from '@/generated/prisma/client';
import { toPlanLessonCallDto } from '@/lib/mappers/planMappers';

// MOTIR-10191 — the lesson-call mapper reads two JSON columns. The store only ever writes
// an object and an id list, but the mapper must not trust a JSON column's shape: a row
// edited by hand, or written by a future column default, still maps to the DTO's types.

const at = new Date('2026-11-01T12:00:00.000Z');
const row = (over: Partial<PlanLessonCall> = {}): PlanLessonCall => ({
  id: 'r1',
  planId: 'p1',
  sessionKey: 's1',
  seq: 3,
  kind: 'search',
  query: 'q',
  filters: { kinds: ['story'], limit: 5 },
  lessonIds: ['les_b', 'les_a'],
  lessonId: null,
  occurrenceRef: null,
  outcome: 'matched',
  counted: null,
  detail: null,
  createdAt: at,
  ...over,
});

describe('toPlanLessonCallDto', () => {
  it('maps a stored call, keeping the ids in rank order and the time as ISO', () => {
    expect(toPlanLessonCallDto(row())).toEqual({
      seq: 3,
      sessionKey: 's1',
      kind: 'search',
      query: 'q',
      filters: { kinds: ['story'], limit: 5 },
      lessonIds: ['les_b', 'les_a'],
      lessonId: null,
      occurrenceRef: null,
      outcome: 'matched',
      counted: null,
      detail: null,
      createdAt: '2026-11-01T12:00:00.000Z',
    });
  });

  it('reads a filters column that is not an object as no filters', () => {
    for (const filters of [null, ['story'], 'story', 7]) {
      expect(toPlanLessonCallDto(row({ filters: filters as never })).filters).toEqual({});
    }
  });

  it('reads a lessonIds column that is not a list as none, and drops a non-string member', () => {
    expect(toPlanLessonCallDto(row({ lessonIds: null as never })).lessonIds).toEqual([]);
    expect(toPlanLessonCallDto(row({ lessonIds: { a: 1 } as never })).lessonIds).toEqual([]);
    expect(toPlanLessonCallDto(row({ lessonIds: ['les_a', 3, null] as never })).lessonIds).toEqual([
      'les_a',
    ]);
  });

  it('carries a reinforce’s lesson, ref and counted', () => {
    expect(
      toPlanLessonCallDto(
        row({
          kind: 'reinforce',
          query: null,
          filters: {},
          lessonIds: [],
          lessonId: 'les_a',
          occurrenceRef: 'MOTIR-7',
          outcome: 'already-recorded',
          counted: false,
        }),
      ),
    ).toMatchObject({
      kind: 'reinforce',
      lessonId: 'les_a',
      occurrenceRef: 'MOTIR-7',
      counted: false,
    });
  });
});
