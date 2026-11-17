import { describe, expect, it } from 'vitest';
import {
  UNKEYED_RUN,
  layoutRail,
  narrationRunKey,
  narrationRuns,
  type RailLayoutInput,
  type RailSlot,
} from '@/components/planning/planRailTimeline';
import type { NarrationGroup } from '@/components/planning/planNarration';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { PlanVersionDto } from '@/lib/dto/planReview';
import { planVersionsOf } from '@/lib/plans/timeline';

// THE RAIL'S ORDER as pure logic (Bug MOTIR-11487), restating design MOTIR-11486
// § "The ordering rule" (`design/ai-chat/design-notes.md`) rather than mirroring
// the code: a run is a job's narration, it sits under that job's last turn, a run
// with no turn and every version sit by time, and the current version's briefing is
// left to the review block when nothing follows it.

const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 21, minute, 0)).toISOString();

function turn(seq: number, jobId: string | null, minute: number): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role: jobId ? 'system' : 'user',
    body: '',
    jobId,
    question: null,
    isAnswer: false,
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: null,
    createdAt: at(minute),
  };
}

function group(sessionKey: string, minute: number | null, messageMinute?: number): NarrationGroup {
  return {
    sessionKey,
    session:
      minute === null
        ? null
        : {
            sessionKey,
            stepKind: 'lay',
            targetRef: null,
            targetTitle: null,
            firstReportedAt: at(minute),
            updatedAt: at(minute),
          },
    messages:
      messageMinute === undefined
        ? []
        : [{ id: `m-${sessionKey}`, sessionKey, seq: 1, body: 'x', createdAt: at(messageMinute) }],
    live: false,
  };
}

const version = (id: string, minute: number): PlanVersionDto => ({
  id,
  plannedAt: at(minute),
  itemCount: 1,
  summary: id,
});

/** A slot as a short label, so an order reads as one array. */
function label(slot: RailSlot): string {
  switch (slot.kind) {
    case 'turn':
      return `turn${slot.index}`;
    case 'run':
      return `run:${slot.run.key}`;
    case 'work':
      return `work:${slot.run?.key ?? '-'}`;
    case 'version':
      return `${slot.earlier ? 'earlier' : 'current'}:${slot.version.id}`;
  }
}

function lay(input: Partial<RailLayoutInput> & Pick<RailLayoutInput, 'turns' | 'runs'>) {
  const out = layoutRail({
    versions: [],
    workRunKey: null,
    workJobId: null,
    workShown: false,
    ...input,
  });
  return { order: out.slots.map(label), trailing: out.currentTrailing };
}

describe('narrationRunKey', () => {
  it('reads the hosted planner’s and plan.py’s keys down to their run', () => {
    expect(narrationRunKey('ai:job-1:3')).toBe('ai:job-1');
    expect(narrationRunKey('ai:job-1:entry:with:colons')).toBe('ai:job-1');
    expect(narrationRunKey('plan.py:run-9:12')).toBe('plan.py:run-9');
  });

  it('puts a key naming no run in the one shared run', () => {
    expect(narrationRunKey('s-lay')).toBe(UNKEYED_RUN);
    expect(narrationRunKey('ai:job-1')).toBe(UNKEYED_RUN);
    expect(narrationRunKey('ai::3')).toBe(UNKEYED_RUN);
  });
});

describe('narrationRuns', () => {
  it('gathers each job’s groups, in the order the runs started', () => {
    const runs = narrationRuns([
      group('ai:job-b:1', 20),
      group('ai:job-a:1', 2),
      group('ai:job-a:2', 3),
    ]);
    expect(runs.map((r) => [r.key, r.jobId, r.groups.length, r.startedAt])).toEqual([
      ['ai:job-a', 'job-a', 2, at(2)],
      ['ai:job-b', 'job-b', 1, at(20)],
    ]);
  });

  it('dates a headless group by its first sentence and sorts an undated run last', () => {
    const runs = narrationRuns([group('plan.py:r:1', null), group('ai:job-a:1', null, 5)]);
    expect(runs.map((r) => [r.key, r.jobId, r.startedAt])).toEqual([
      ['ai:job-a', 'job-a', at(5)],
      ['plan.py:r', null, null],
    ]);
  });

  it('keeps two undated runs in the order they were read', () => {
    const runs = narrationRuns([group('x:1:1', null), group('y:1:1', null)]);
    expect(runs.map((r) => r.key)).toEqual(['x:1', 'y:1']);
  });
});

describe('layoutRail', () => {
  const turns = [turn(0, null, 0), turn(1, 'job-a', 1), turn(2, null, 20), turn(3, 'job-b', 21)];
  const runs = narrationRuns([group('ai:job-a:1', 2), group('ai:job-b:1', 22)]);

  it('a revision writing: the first run and its version above the follow-up, the work row under it', () => {
    expect(
      lay({
        turns,
        runs,
        versions: [version('v1', 10)],
        workRunKey: 'ai:job-b',
        workJobId: 'job-b',
        workShown: true,
      }),
    ).toEqual({
      order: ['turn0', 'turn1', 'run:ai:job-a', 'current:v1', 'turn2', 'turn3', 'work:ai:job-b'],
      trailing: false,
    });
  });

  it('the revision landed: the new version trails, so the review block draws it', () => {
    expect(
      lay({
        turns,
        runs,
        versions: [version('v1', 10), version('v2', 30)],
        workRunKey: 'ai:job-b',
        workShown: true,
      }),
    ).toEqual({
      order: ['turn0', 'turn1', 'run:ai:job-a', 'earlier:v1', 'turn2', 'turn3', 'work:ai:job-b'],
      trailing: true,
    });
  });

  it('the work row sits under its job’s turn before the run’s first note lands', () => {
    const { order } = lay({
      turns,
      runs: runs.slice(0, 1),
      workRunKey: null,
      workJobId: 'job-b',
      workShown: true,
    });
    expect(order).toEqual(['turn0', 'turn1', 'run:ai:job-a', 'turn2', 'turn3', 'work:-']);
  });

  it('a run with no turn to sit under is placed by time, never under another run’s turn', () => {
    const planPy = narrationRuns([group('plan.py:r:1', 10)]);
    const { order } = lay({ turns, runs: planPy, workRunKey: null, workShown: false });
    expect(order).toEqual(['turn0', 'turn1', 'run:plan.py:r', 'turn2', 'turn3', 'work:-']);
  });

  it('an undated, unanchored work row goes last, after the current version', () => {
    const { order, trailing } = lay({
      turns: [],
      runs: [],
      versions: [version('v1', 10)],
      workShown: true,
    });
    expect(order).toEqual(['current:v1', 'work:-']);
    expect(trailing).toBe(false);
  });

  it('an empty work row after the current version still leaves it trailing', () => {
    const { order, trailing } = lay({
      turns: [],
      runs: [],
      versions: [version('v1', 10)],
      workShown: false,
    });
    expect(order).toEqual(['work:-']);
    expect(trailing).toBe(true);
  });

  it('no versions: the current briefing is the review block’s, as it always was', () => {
    expect(lay({ turns, runs, workRunKey: 'ai:job-b', workShown: true }).trailing).toBe(true);
  });
});

describe('layoutRail — with each job’s settle-time reply (written after its close)', () => {
  const reply = (seq: number, jobId: string, minute: number) => ({
    ...turn(seq, jobId, minute),
    role: 'assistant' as const,
  });
  const first = [turn(0, null, 0), turn(1, 'job-a', 1), reply(2, 'job-a', 11)];
  const revision = [...first, turn(3, null, 20), turn(4, 'job-b', 21)];
  const runA = narrationRuns([group('ai:job-a:1', 2)]);
  const runsAB = narrationRuns([group('ai:job-a:1', 2), group('ai:job-b:1', 22)]);

  it('a first proposal alone: the briefing follows the run, so the review block draws it', () => {
    expect(
      lay({
        turns: first,
        runs: runA,
        versions: [version('v1', 10)],
        workRunKey: 'ai:job-a',
        workShown: true,
      }),
    ).toEqual({ order: ['turn0', 'turn1', 'turn2', 'work:ai:job-a'], trailing: true });
  });

  it('writing: the first briefing under the first run’s notes, above the follow-up', () => {
    expect(
      lay({
        turns: revision,
        runs: runsAB,
        versions: [version('v1', 10)],
        workRunKey: 'ai:job-b',
        workJobId: 'job-b',
        workShown: true,
      }),
    ).toEqual({
      order: [
        'turn0',
        'turn1',
        'turn2',
        'run:ai:job-a',
        'current:v1',
        'turn3',
        'turn4',
        'work:ai:job-b',
      ],
      trailing: false,
    });
  });

  it('finished (and reopened, from the same rows): the new briefing follows the revision’s notes', () => {
    expect(
      lay({
        turns: [...revision, reply(5, 'job-b', 31)],
        runs: runsAB,
        versions: [version('v1', 10), version('v2', 30)],
        workRunKey: 'ai:job-b',
        workShown: true,
      }),
    ).toEqual({
      order: [
        'turn0',
        'turn1',
        'turn2',
        'run:ai:job-a',
        'earlier:v1',
        'turn3',
        'turn4',
        'turn5',
        'work:ai:job-b',
      ],
      trailing: true,
    });
  });

  it('a version whose run left no notes is placed by time, not under an earlier run', () => {
    expect(
      lay({
        turns: revision,
        runs: runA,
        versions: [version('v1', 10), version('v2', 30)],
        workShown: false,
      }),
    ).toEqual({
      order: ['turn0', 'turn1', 'turn2', 'run:ai:job-a', 'earlier:v1', 'turn3', 'turn4', 'work:-'],
      trailing: true,
    });
  });
});

describe('planVersionsOf', () => {
  const row = (id: string, changeKind: string, minute: number, diff: unknown) => ({
    id,
    changeKind,
    changedAt: new Date(at(minute)),
    diff,
  });

  it('one version per planned close, oldest first, with its count and briefing', () => {
    expect(
      planVersionsOf([
        row('r3', 'planned', 30, { itemCount: 4, summary: 'Second.' }),
        row('r1', 'appended', 5, { proposalCount: 3 }),
        row('r2', 'planned', 10, { itemCount: 3 }),
      ]),
    ).toEqual([
      { id: 'r2', plannedAt: at(10), itemCount: 3, summary: null },
      { id: 'r3', plannedAt: at(30), itemCount: 4, summary: 'Second.' },
    ]);
  });

  it('reads a close it cannot parse as a version with no count and no briefing', () => {
    expect(
      planVersionsOf([
        row('r1', 'planned', 1, null),
        row('r2', 'planned', 2, { itemCount: 'x', summary: '  ' }),
      ]),
    ).toEqual([
      { id: 'r1', plannedAt: at(1), itemCount: 0, summary: null },
      { id: 'r2', plannedAt: at(2), itemCount: 0, summary: null },
    ]);
  });
});
