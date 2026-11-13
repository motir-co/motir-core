import { describe, expect, it } from 'vitest';
import {
  PLAN_STALLED_AFTER_MS,
  buildPlanProgressSnapshot,
  readPlanAtWork,
  readPlanProgress,
  stepLastActivity,
  type PlanProgressAddRow,
  type PlanProgressSnapshot,
  type PlanProgressStep,
  type PlanProgressWriteRow,
} from '@/lib/plans/planProgress';
import { inFlightCues } from '@/lib/planning/livePane';
import { drivenStepId, nextDrivenStep } from '@/lib/planning/plannerDrive';
import type { PlanStepDto } from '@/lib/dto/plans';
import { planReviewItem } from '../helpers/planReview';

// Bug MOTIR-11184 — the quiet drop measured a step from its START, so a hosted
// lay session that spent 17 m 41 s on a large story before its first child was
// dropped from `liveSteps` at 15 min, before it could resolve, and *Follow the
// planner* never drilled into the story. A step is now measured from its LAST
// SIGN OF LIFE: the later of its start and the newest write under its target.

const MIN = 60_000;
const STORY = 'cmwcld01f014k01ad619kpsgt'; // MOTIR-11004's id, as the step names it
const EPIC = 'wi_epic';

// The production timings from the card: the lay step started at 10:43:05, its
// first child landed at 11:00:46 and the next eight followed at 11:01–11:05.
const STEP_START = '2026-11-13T10:43:05.000Z';
const FIRST_CHILD = '2026-11-13T11:00:46.000Z';
const ms = (isoAt: string) => Date.parse(isoAt);

function step(over: Partial<PlanStepDto> & { sessionKey: string }): PlanStepDto {
  return { kind: 'lay', targetRef: STORY, startedAt: STEP_START, providerWait: null, ...over };
}

function write(over: Partial<PlanProgressWriteRow> & { id: string }): PlanProgressWriteRow {
  return { op: 'add', workItemId: null, parentRef: STORY, writtenAt: FIRST_CHILD, ...over };
}

function addRow(id: string, parentRef: string | null = STORY): PlanProgressAddRow {
  return { id, workItemId: null, parentRef, kind: 'task', title: id, authorFinished: false };
}

function build(args: {
  steps: PlanStepDto[];
  writes?: PlanProgressWriteRow[];
  addRows?: PlanProgressAddRow[];
  lastActivityAt?: string;
  titles?: [string, string][];
}): PlanProgressSnapshot {
  return buildPlanProgressSnapshot({
    plan: {
      createdAt: '2026-11-13T10:30:00.000Z',
      lastActivityAt: args.lastActivityAt ?? FIRST_CHILD,
    },
    steps: args.steps,
    addRows: args.addRows ?? [],
    committedTitles: new Map(args.titles ?? [[STORY, 'Indexing runs from a queue']]),
    observedAt: FIRST_CHILD,
    writes: args.writes,
  });
}

// The canvas's items: the story's children, each placed under the committed
// story whose committed chain is epic → story.
function child(id: string) {
  return planReviewItem({
    planItemId: id,
    nodeId: id,
    parentNodeId: STORY,
    parentIdentifier: 'MOTIR-11004',
    parentTitle: 'Indexing runs from a queue',
    parentTrail: [
      { id: EPIC, identifier: 'MOTIR-11000', title: 'Epic' },
      { id: STORY, identifier: 'MOTIR-11004', title: 'Indexing runs from a queue' },
    ],
  });
}

describe('stepLastActivity — which writes keep a step alive', () => {
  it('a lay step: the newest `add` whose parent is its target, never an older write', () => {
    const writes = [
      write({ id: 'a', writtenAt: '2026-11-13T11:00:46.000Z' }),
      write({ id: 'b', writtenAt: new Date('2026-11-13T11:05:10.000Z') }),
      write({ id: 'c', writtenAt: '2026-11-13T11:02:00.000Z' }),
      // Not the step's: another parent, a `modify` under the target, a write
      // before the step started.
      write({ id: 'd', parentRef: 'elsewhere', writtenAt: '2026-11-13T11:30:00.000Z' }),
      write({ id: 'e', op: 'modify', writtenAt: '2026-11-13T11:31:00.000Z' }),
    ];
    expect(stepLastActivity(step({ sessionKey: 's' }), writes)).toBe('2026-11-13T11:05:10.000Z');
    expect(
      stepLastActivity(step({ sessionKey: 's' }), [
        write({ id: 'old', writtenAt: '2026-11-13T10:00:00.000Z' }),
      ]),
    ).toBe(STEP_START);
  });

  it('an untargeted lay step: the top-level `add`s', () => {
    const writes = [
      write({ id: 'root', parentRef: null, writtenAt: '2026-11-13T11:10:00.000Z' }),
      write({ id: 'kid', writtenAt: '2026-11-13T11:20:00.000Z' }),
    ];
    expect(stepLastActivity(step({ sessionKey: 's', targetRef: null }), writes)).toBe(
      '2026-11-13T11:10:00.000Z',
    );
  });

  it('an author step on a proposal: that proposal’s own last write', () => {
    const writes = [
      write({ id: 'mine', parentRef: 'p', writtenAt: '2026-11-13T11:12:00.000Z' }),
      write({ id: 'other', parentRef: 'p', writtenAt: '2026-11-13T11:40:00.000Z' }),
    ];
    const s = step({ sessionKey: 's', kind: 'author', targetRef: 'planItem:mine' });
    expect(stepLastActivity(s, writes)).toBe('2026-11-13T11:12:00.000Z');
  });

  it('an author step on a committed card: the proposals ON that card', () => {
    const writes = [
      write({
        id: 'm',
        op: 'modify',
        workItemId: 'wi_1',
        parentRef: null,
        writtenAt: '2026-11-13T11:20:00.000Z',
      }),
      write({
        id: 'x',
        op: 'modify',
        workItemId: 'wi_2',
        parentRef: null,
        writtenAt: '2026-11-13T11:50:00.000Z',
      }),
    ];
    const s = step({ sessionKey: 's', kind: 'author', targetRef: 'wi_1' });
    expect(stepLastActivity(s, writes)).toBe('2026-11-13T11:20:00.000Z');
  });

  it('settle and the untargeted author are measured from their start', () => {
    const writes = [write({ id: 'any', parentRef: null, writtenAt: '2026-11-13T11:50:00.000Z' })];
    for (const s of [
      step({ sessionKey: 's', kind: 'settle', targetRef: null }),
      step({ sessionKey: 's', kind: 'author', targetRef: null }),
    ]) {
      expect(stepLastActivity(s, writes)).toBe(STEP_START);
    }
  });

  it('the snapshot carries it on every step; with no writes it is the start', () => {
    const plain = build({ steps: [step({ sessionKey: 's' })] });
    expect(plain.steps[0]).toMatchObject({ startedAt: STEP_START, lastActivityAt: STEP_START });
    const written = build({ steps: [step({ sessionKey: 's' })], writes: [write({ id: 'a' })] });
    expect(written.steps[0]).toMatchObject({ startedAt: STEP_START, lastActivityAt: FIRST_CHILD });
  });
});

describe('readPlanProgress — the quiet drop measures the last sign of life', () => {
  it('a lay step started over 15 min ago stays live while an `add` under its target is fresh', () => {
    const s = build({ steps: [step({ sessionKey: 's' })], writes: [write({ id: 'a' })] });
    // 17 m 41 s after the start, at the first child: the old rule dropped it here.
    expect(readPlanProgress(s, ms(FIRST_CHILD)).liveSteps.map((x) => x.sessionKey)).toEqual(['s']);
    // 15 min after the child exactly: still live (equal is not quiet).
    expect(readPlanProgress(s, ms(FIRST_CHILD) + PLAN_STALLED_AFTER_MS).liveSteps).toHaveLength(1);
  });

  it('it drops once both its start and its last child are older than 15 min', () => {
    const s = build({
      steps: [step({ sessionKey: 's' })],
      writes: [write({ id: 'a' })],
      lastActivityAt: '2026-11-13T11:20:00.000Z', // a sibling keeps the plan alive
    });
    const r = readPlanProgress(s, ms(FIRST_CHILD) + PLAN_STALLED_AFTER_MS + 1);
    expect(r.state).not.toBe('stalled');
    expect(r.liveSteps).toEqual([]);
  });

  it('an author step stays live while its target was written within 15 min', () => {
    const s = build({
      steps: [step({ sessionKey: 'a', kind: 'author', targetRef: 'planItem:p1' })],
      addRows: [addRow('p1')],
      writes: [write({ id: 'p1', writtenAt: '2026-11-13T11:05:00.000Z' })],
      lastActivityAt: '2026-11-13T11:05:00.000Z',
    });
    const at = ms('2026-11-13T11:05:00.000Z');
    expect(readPlanProgress(s, at + 10 * MIN).liveSteps).toHaveLength(1);
    expect(readPlanProgress(s, at + PLAN_STALLED_AFTER_MS + 1).liveSteps).toEqual([]);
  });

  it('a step whose session died is dropped exactly as before, and the plan threshold is unchanged', () => {
    // No write after the start: dropped at start + 15 min + 1 ms, as the old rule did.
    const dead = build({
      steps: [step({ sessionKey: 'dead' })],
      writes: [write({ id: 'old', writtenAt: '2026-11-13T10:00:00.000Z' })],
      lastActivityAt: '2026-11-13T10:55:00.000Z',
    });
    expect(readPlanProgress(dead, ms(STEP_START) + PLAN_STALLED_AFTER_MS).liveSteps).toHaveLength(
      1,
    );
    expect(readPlanProgress(dead, ms(STEP_START) + PLAN_STALLED_AFTER_MS + 1).liveSteps).toEqual(
      [],
    );
    // The plan's own `stalled` is still `Plan.lastActivityAt` past 15 min, however
    // fresh a step's write reads — and a stalled plan has no live steps.
    const quiet = build({
      steps: [step({ sessionKey: 's' })],
      writes: [write({ id: 'a' })],
      lastActivityAt: STEP_START,
    });
    const stalled = readPlanProgress(quiet, ms(STEP_START) + PLAN_STALLED_AFTER_MS + 1);
    expect(stalled).toMatchObject({ state: 'stalled', liveSteps: [] });
  });

  it('a snapshot built without the field (mid-deploy) falls back to the start', () => {
    const s = build({ steps: [step({ sessionKey: 's' })] });
    const legacy: PlanProgressSnapshot = {
      ...s,
      steps: s.steps.map(({ lastActivityAt: _drop, ...rest }) => rest as PlanProgressStep),
    };
    expect(readPlanProgress(legacy, ms(STEP_START) + PLAN_STALLED_AFTER_MS).liveSteps).toHaveLength(
      1,
    );
    expect(readPlanProgress(legacy, ms(STEP_START) + PLAN_STALLED_AFTER_MS + 1).liveSteps).toEqual(
      [],
    );
  });
});

describe('the reproduction — Follow the planner drills into the story (10:43:05 / 11:00:46)', () => {
  const children = ['c1', 'c2'].map(child);

  it('before the first child: live, but names no level yet (unchanged)', () => {
    const s = build({ steps: [step({ sessionKey: 'ai:session:2' })], lastActivityAt: STEP_START });
    const r = readPlanProgress(s, ms(STEP_START) + 10 * MIN);
    expect(r.liveSteps).toHaveLength(1);
    expect(nextDrivenStep(null, r.liveSteps, [], 'New')).toBeNull();
  });

  it('after the first child, 17 m 41 s in: the canvas is driven into the story', () => {
    const s = build({
      steps: [step({ sessionKey: 'ai:session:2' })],
      addRows: [addRow('c1'), addRow('c2')],
      writes: [write({ id: 'c1' }), write({ id: 'c2', writtenAt: '2026-11-13T11:01:30.000Z' })],
      lastActivityAt: '2026-11-13T11:01:30.000Z',
    });
    // 16 min after the start and later — the old rule's `liveSteps` was empty here.
    for (const now of [
      ms(STEP_START) + 16 * MIN,
      ms(FIRST_CHILD),
      ms('2026-11-13T11:05:00.000Z'),
    ]) {
      const r = readPlanProgress(s, now);
      const driven = nextDrivenStep(null, r.liveSteps, children, 'New');
      expect(driven?.levelId).toBe(STORY);
      expect(driven?.trail.map((c) => c.id)).toEqual([EPIC, STORY]);
      expect(driven?.id).toBe(drivenStepId(s.steps[0]!));
    }
  });

  it('the laying cue and its Go there entry stay while the children keep arriving', () => {
    const s = build({
      steps: [step({ sessionKey: 'ai:session:2' })],
      addRows: [addRow('c1')],
      writes: [write({ id: 'c1' })],
    });
    const r = readPlanProgress(s, ms(FIRST_CHILD) + 5 * MIN);
    const steps = readPlanAtWork(r).steps;
    const { cues, inFlight } = inFlightCues(children, steps, 'New');
    expect(cues.get(STORY)).toBe('laying');
    expect(inFlight).toEqual([expect.objectContaining({ nodeId: STORY, kind: 'laying' })]);
  });
});

describe('identity and order still read `startedAt`', () => {
  it('an older step that keeps writing keeps its id and its place, and does not take over', () => {
    const older = step({ sessionKey: 'old' });
    const newer = step({
      sessionKey: 'new',
      kind: 'author',
      targetRef: 'planItem:c1',
      startedAt: '2026-11-13T11:02:00.000Z',
    });
    const before = build({ steps: [newer, older], addRows: [addRow('c1')] });
    const after = build({
      steps: [newer, older],
      addRows: [addRow('c1')],
      writes: [write({ id: 'c1' }), write({ id: 'c9', writtenAt: '2026-11-13T11:09:00.000Z' })],
    });
    // The snapshot's order is `startedAt`, not activity.
    expect(after.steps.map((s) => s.sessionKey)).toEqual(['old', 'new']);
    expect(after.steps[0]!.lastActivityAt).toBe('2026-11-13T11:09:00.000Z');
    // The writes do not re-key the older step.
    expect(drivenStepId(after.steps[0]!)).toBe(drivenStepId(before.steps[0]!));
    // Held on the newer step, the canvas stays on it while the older one writes.
    const items = [child('c1')];
    const r = readPlanProgress(after, ms('2026-11-13T11:10:00.000Z'));
    expect(r.liveSteps.map((s) => s.sessionKey)).toEqual(['old', 'new']);
    const held = { id: drivenStepId(after.steps[1]!), levelId: STORY, trail: [] };
    expect(nextDrivenStep(held, r.liveSteps, items, 'New')?.id).toBe(held.id);
  });
});
