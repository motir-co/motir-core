import { describe, expect, it } from 'vitest';
import {
  dispositionMarkerFor,
  latestTurnDeclined,
  latestTurnUnsearchable,
  pendingQuestion,
} from '@/lib/planning/planChangeThread';
import { readPlanningTurn } from '@/lib/planning/plannerTurn';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';

// The thread's DERIVED state (MOTIR-2226) and the boundary READER that feeds it.
// Both are pure, and both are load-bearing:
//
//   * `pendingQuestion` IS the awaiting state machine. Because it is derived from
//     the persisted thread rather than set when a question streams in, the same
//     session reopened hours later comes back to the identical answer bar — which
//     is what the design's panel C draws and what the reload criterion asserts.
//   * `readPlanningTurn` is the only thing standing between a separately-deployed
//     service's JSON and a database row, so every branch is exercised against
//     inputs a real producer could send and inputs it should never send.

let seq = 0;
function turn(role: PlanChangeTurnDto['role'], extra: Partial<PlanChangeTurnDto> = {}) {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    body: `body ${seq}`,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: null,
    createdAt: '2026-08-05T10:00:00.000Z',
    ...extra,
  } satisfies PlanChangeTurnDto;
}

const asked = (extra: Partial<PlanChangeTurnDto> = {}) =>
  turn('assistant', { question: 'in, or out?', ...extra });
const reported = () => turn('assistant');

describe('pendingQuestion', () => {
  it('is null on an empty thread and on one that only reported', () => {
    expect(pendingQuestion([])).toBeNull();
    expect(pendingQuestion([turn('user'), turn('system'), reported()])).toBeNull();
  });

  it('is the last planner turn when that turn ASKED', () => {
    const q = asked();
    expect(pendingQuestion([turn('user'), turn('system'), q])).toBe(q);
  });

  it('CLEARS the instant any user turn follows — answered or not', () => {
    const q = asked();
    // State C: the reply.
    expect(pendingQuestion([q, turn('user', { isAnswer: true })])).toBeNull();
    // State E: the change of subject. The pending state clears either way — a
    // question is superseded, never blocking.
    expect(pendingQuestion([q, turn('user')])).toBeNull();
  });

  it('a submission MARKER neither opens nor closes it — it is provenance', () => {
    const q = asked();
    // Submitting the answer writes a `system` marker between the question and
    // whatever comes next; that must not read as "the question was dealt with".
    expect(pendingQuestion([q, turn('system')])).toBe(q);
  });

  it('the NEWEST planner turn wins — an older question is already history', () => {
    const first = asked();
    const second = reported();
    expect(pendingQuestion([first, turn('user'), second])).toBeNull();
  });

  it('a second question REPLACES the first as the pending one', () => {
    const first = asked();
    const second = asked();
    expect(pendingQuestion([first, turn('user'), second])).toBe(second);
  });
});

describe('latestTurnDeclined', () => {
  it('is true when the latest planner turn declined for an unreadable code graph', () => {
    expect(
      latestTurnDeclined([turn('user'), turn('assistant', { codeUnreadable: 'declined' })]),
    ).toBe(true);
  });

  it('is false for an answered, a plain and an absent outage face', () => {
    expect(
      latestTurnDeclined([turn('user'), turn('assistant', { codeUnreadable: 'answered' })]),
    ).toBe(false);
    expect(latestTurnDeclined([turn('user'), reported()])).toBe(false);
    expect(latestTurnDeclined([])).toBe(false);
  });

  it('ignores a declined turn that predates the latest user message', () => {
    expect(
      latestTurnDeclined([
        turn('assistant', { codeUnreadable: 'declined' }),
        turn('user'),
        turn('system'),
      ]),
    ).toBe(false);
  });
});

describe('latestTurnUnsearchable', () => {
  const blocked = [{ repoRef: 'motir-co/motir-core', state: 'never_indexed' as const }];

  it('is true when the latest planner turn stopped on unsearchable code', () => {
    expect(
      latestTurnUnsearchable([turn('user'), turn('assistant', { codeUnsearchable: blocked })]),
    ).toBe(true);
  });

  it('is false for a plain turn, an empty list and an empty thread', () => {
    expect(latestTurnUnsearchable([turn('user'), reported()])).toBe(false);
    expect(
      latestTurnUnsearchable([turn('user'), turn('assistant', { codeUnsearchable: [] })]),
    ).toBe(false);
    expect(latestTurnUnsearchable([])).toBe(false);
  });

  it('ignores a stopped turn that predates the latest user message', () => {
    expect(
      latestTurnUnsearchable([
        turn('assistant', { codeUnsearchable: blocked }),
        turn('user'),
        turn('system'),
      ]),
    ).toBe(false);
  });
});

describe('dispositionMarkerFor', () => {
  it('marks the reply as ANSWERED (design state C)', () => {
    const thread = [asked(), turn('user', { isAnswer: true })];
    expect(dispositionMarkerFor(thread, 1)).toBe('answered');
  });

  it('marks a change of subject as SUPERSEDED (design state E)', () => {
    const thread = [asked(), turn('user')];
    expect(dispositionMarkerFor(thread, 1)).toBe('superseded');
  });

  it('owes NO marker on a turn that closed nothing', () => {
    const thread = [turn('user'), reported(), turn('user')];
    expect(dispositionMarkerFor(thread, 0)).toBeNull();
    expect(dispositionMarkerFor(thread, 1)).toBeNull();
    expect(dispositionMarkerFor(thread, 2)).toBeNull();
  });

  it('owes no marker on the question itself — the marker sits under the REPLY', () => {
    const thread = [asked(), turn('user', { isAnswer: true })];
    expect(dispositionMarkerFor(thread, 0)).toBeNull();
  });

  it('only the FIRST user turn after a question carries the marker', () => {
    const thread = [asked(), turn('user', { isAnswer: true }), turn('user')];
    expect(dispositionMarkerFor(thread, 1)).toBe('answered');
    expect(dispositionMarkerFor(thread, 2)).toBeNull();
  });

  it('is total over an out-of-range index', () => {
    expect(dispositionMarkerFor([], 0)).toBeNull();
    expect(dispositionMarkerFor([asked()], 5)).toBeNull();
  });
});

describe('readPlanningTurn', () => {
  it('reads a report', () => {
    expect(
      readPlanningTurn({ turn: { action: 'draft', message: 'I searched.', question: null } }),
    ).toEqual({ message: 'I searched.', question: null, options: null });
  });

  it('reads a question', () => {
    expect(
      readPlanningTurn({ turn: { action: 'ask', message: 'Which?', question: 'in or out?' } }),
    ).toEqual({ message: 'Which?', question: 'in or out?', options: null });
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['no turn', {}],
    ['a null turn', { turn: null }],
    ['a non-object turn', { turn: 42 }],
    ['no message', { turn: { action: 'draft' } }],
    ['a non-string message', { turn: { message: 12 } }],
    ['a blank message', { turn: { message: '   ' } }],
  ])('answers null for %s rather than throwing', (_label, input) => {
    expect(readPlanningTurn(input)).toBeNull();
  });

  it('reads an unusable QUESTION as "did not ask" rather than failing the turn', () => {
    // The safe direction: the report still lands, and the rail simply does not
    // enter a waiting state the user would see no reason for.
    expect(readPlanningTurn({ turn: { message: 'ok', question: 7 } })?.question).toBeNull();
    expect(readPlanningTurn({ turn: { message: 'ok', question: '  ' } })?.question).toBeNull();
    expect(readPlanningTurn({ turn: { message: 'ok' } })?.question).toBeNull();
  });

  it('TRIMS, and BOUNDS both bodies — a bound the consumer does not enforce is no bound', () => {
    expect(readPlanningTurn({ turn: { message: '  padded  ' } })?.message).toBe('padded');

    const long = readPlanningTurn({
      turn: { message: 'm'.repeat(9000), question: 'q'.repeat(2000) },
    })!;
    expect(long.message).toHaveLength(4000);
    expect(long.message.endsWith('…')).toBe(true);
    expect(long.question).toHaveLength(600);
    expect(long.question!.endsWith('…')).toBe(true);
  });
});
