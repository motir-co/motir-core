import { describe, expect, it } from 'vitest';
import {
  AWAITING_PERSON_WHERE,
  CLEARED_AWAITING_COLUMNS,
  CLEARED_FAILURE_COLUMNS,
  FAILED_WAITING_WHERE,
  FAILURE_DETAIL_MAX,
  FAILURE_NOT_PLANNED_YET_LINE_MAX,
  FAILURE_NOT_PLANNED_YET_MAX_LINES,
  FAILURE_STOP_REF_MAX,
  FAILURE_STOP_TITLE_MAX,
  NOT_WAITING_WHERE,
  PLAN_SESSION_FAILURE_REASONS,
  isAwaitingPerson,
  isFailedWaiting,
  parsePlanSessionAwaiting,
  parsePlanSessionFailureRecord,
  sessionWaitingState,
  type SessionWaitingRow,
} from '@/lib/planChange/sessionWaitingState';

// A planning session's WAITING STATE — the definitions every reader shares (Story
// MOTIR-7905 · MOTIR-7908). Pure: no database, so each rule is one case, and the
// predicates are held against the Prisma `where` fragments they mirror.

const NOW = new Date('2026-10-09T12:00:00.000Z');
const row = (over: Partial<SessionWaitingRow> = {}): SessionWaitingRow => ({
  endedAt: null,
  failedAt: null,
  awaitingPersonSince: null,
  ...over,
});

describe('sessionWaitingState', () => {
  it.each([
    ['an open session with nothing on record', row(), 'open'],
    ['an open session with a failure on record', row({ failedAt: NOW }), 'failed'],
    ['an open session awaiting its person', row({ awaitingPersonSince: NOW }), 'awaiting_person'],
    ['an ended session', row({ endedAt: NOW }), 'ended'],
  ])('%s is %s', (_why, input, expected) => {
    expect(sessionWaitingState(input)).toBe(expected);
  });

  it('⚠️ an ENDED session is ended whatever its waiting columns hold', () => {
    // The CHECK forbids the row, but a reader handed one must not report a closed
    // conversation as waiting.
    expect(sessionWaitingState(row({ endedAt: NOW, failedAt: NOW }))).toBe('ended');
    expect(sessionWaitingState(row({ endedAt: NOW, awaitingPersonSince: NOW }))).toBe('ended');
  });

  it('a failure outranks an awaiting record, though the CHECK keeps both from ever being set', () => {
    expect(sessionWaitingState(row({ failedAt: NOW, awaitingPersonSince: NOW }))).toBe('failed');
  });
});

describe('the predicates mirror their where fragments', () => {
  it('failed-waiting ⟺ open AND a failure on record', () => {
    expect(isFailedWaiting(row({ failedAt: NOW }))).toBe(true);
    expect(isFailedWaiting(row({ failedAt: NOW, endedAt: NOW }))).toBe(false);
    expect(isFailedWaiting(row())).toBe(false);
    expect(FAILED_WAITING_WHERE).toEqual({ endedAt: null, failedAt: { not: null } });
  });

  it('awaiting-person ⟺ open AND a wait on record', () => {
    expect(isAwaitingPerson(row({ awaitingPersonSince: NOW }))).toBe(true);
    expect(isAwaitingPerson(row({ awaitingPersonSince: NOW, endedAt: NOW }))).toBe(false);
    expect(isAwaitingPerson(row())).toBe(false);
    expect(AWAITING_PERSON_WHERE).toEqual({ endedAt: null, awaitingPersonSince: { not: null } });
  });

  it('not waiting is neither column set — and says nothing about the end', () => {
    expect(NOT_WAITING_WHERE).toEqual({ failedAt: null, awaitingPersonSince: null });
  });
});

describe('the cleared-column lists name every column, once', () => {
  it('the nine failure columns are cleared and the two awaiting columns are all null', () => {
    expect(Object.keys(CLEARED_FAILURE_COLUMNS).sort()).toEqual([
      'failedAt',
      'failedJobId',
      'failureDetail',
      'failureNotPlannedYet',
      'failureReason',
      'failureResumable',
      'failureStopPhase',
      'failureStopRef',
      'failureStopTitle',
    ]);
    // A list column cannot be NULL: the not-planned-yet lines clear to the empty list
    // (MOTIR-10209); every other failure column clears to null.
    const { failureNotPlannedYet, ...scalars } = CLEARED_FAILURE_COLUMNS;
    expect(failureNotPlannedYet).toEqual([]);
    expect(Object.values(scalars).every((v) => v === null)).toBe(true);
    expect(Object.keys(CLEARED_AWAITING_COLUMNS).sort()).toEqual([
      'awaitingPersonCause',
      'awaitingPersonSince',
    ]);
    expect(Object.values(CLEARED_AWAITING_COLUMNS).every((v) => v === null)).toBe(true);
  });
});

describe('parsePlanSessionFailureRecord', () => {
  const base = { failedAt: NOW, failedJobId: 'job_1', failureReason: 'rate_limited' as const };

  it('accepts the minimum — a time, a job and a reason — and nulls the rest', () => {
    expect(parsePlanSessionFailureRecord(base)).toEqual({
      ...base,
      failureDetail: null,
      failureStopPhase: null,
      failureStopRef: null,
      failureStopTitle: null,
      failureResumable: null,
      failureNotPlannedYet: [],
    });
  });

  it('keeps the not-planned-yet lines in order, trimmed, without blanks, and capped (MOTIR-10209)', () => {
    expect(
      parsePlanSessionFailureRecord({
        ...base,
        failureNotPlannedYet: ['  "D" is not planned yet.  ', '', '   ', 'Not written yet: "T".'],
      }).failureNotPlannedYet,
    ).toEqual(['"D" is not planned yet.', 'Not written yet: "T".']);
    const many = Array.from(
      { length: FAILURE_NOT_PLANNED_YET_MAX_LINES + 5 },
      (_, i) => `line ${i}`,
    );
    const parsed = parsePlanSessionFailureRecord({
      ...base,
      failureNotPlannedYet: ['x'.repeat(FAILURE_NOT_PLANNED_YET_LINE_MAX + 50), ...many],
    }).failureNotPlannedYet;
    expect(parsed).toHaveLength(FAILURE_NOT_PLANNED_YET_MAX_LINES);
    expect(parsed[0]).toHaveLength(FAILURE_NOT_PLANNED_YET_LINE_MAX);
    expect(parsed[1]).toBe('line 0');
  });

  it.each(PLAN_SESSION_FAILURE_REASONS)('accepts the reason %s', (failureReason) => {
    expect(parsePlanSessionFailureRecord({ ...base, failureReason }).failureReason).toBe(
      failureReason,
    );
  });

  it('refuses a reason outside the closed vocabulary', () => {
    expect(() =>
      parsePlanSessionFailureRecord({ ...base, failureReason: 'gateway_exploded' as never }),
    ).toThrow();
  });

  it('refuses an EMPTY job id', () => {
    expect(() => parsePlanSessionFailureRecord({ ...base, failedJobId: '' })).toThrow();
  });

  it('accepts NO job — a silent plan with no producer (MOTIR-8132)', () => {
    expect(parsePlanSessionFailureRecord({ ...base, failedJobId: null }).failedJobId).toBeNull();
  });

  it('⚠️ CAPS what motir-ai sends rather than refusing it — a failure must stay recordable', () => {
    const parsed = parsePlanSessionFailureRecord({
      ...base,
      failureDetail: 'd'.repeat(FAILURE_DETAIL_MAX + 400),
      failureStopRef: 'r'.repeat(FAILURE_STOP_REF_MAX + 50),
      failureStopTitle: 't'.repeat(FAILURE_STOP_TITLE_MAX + 50),
    });

    expect(parsed.failureDetail).toHaveLength(FAILURE_DETAIL_MAX);
    expect(parsed.failureStopRef).toHaveLength(FAILURE_STOP_REF_MAX);
    expect(parsed.failureStopTitle).toHaveLength(FAILURE_STOP_TITLE_MAX);
  });

  it('trims, and reads a blank as absent', () => {
    const parsed = parsePlanSessionFailureRecord({
      ...base,
      failureDetail: '   ',
      failureStopTitle: '  A card  ',
    });

    expect(parsed.failureDetail).toBeNull();
    expect(parsed.failureStopTitle).toBe('A card');
  });

  it('keeps the stop phase when it is one of the two', () => {
    expect(
      parsePlanSessionFailureRecord({ ...base, failureStopPhase: 'lay' }).failureStopPhase,
    ).toBe('lay');
    expect(() =>
      parsePlanSessionFailureRecord({ ...base, failureStopPhase: 'plan' as never }),
    ).toThrow();
  });
});

describe('parsePlanSessionAwaiting', () => {
  it.each(['question', 'reply'] as const)('accepts the cause %s', (cause) => {
    expect(parsePlanSessionAwaiting({ cause, since: NOW })).toEqual({ cause, since: NOW });
  });

  it('refuses any other cause', () => {
    expect(() => parsePlanSessionAwaiting({ cause: 'idle' as never, since: NOW })).toThrow();
  });
});
